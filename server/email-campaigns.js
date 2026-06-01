// Email campaigns module (Wave 9 — marketing-style bulk sends).
//
// Three responsibilities:
//   1. resolveRecipients(orgId, query) — translate the saved JSONB
//      filter (subs / leads / clients / manual) into a flat list of
//      { email, name, params } rows. Re-resolved at send time so a
//      "send to all active subs" campaign picks up a sub added after
//      the campaign was drafted.
//   2. sendCampaign(campaignId) — drain the queued recipient rows for
//      a campaign: interpolate the template body with each row's
//      params, send via sendEmail, mark sent/failed, bump counters.
//      Honors a small per-tick throttle so a 200-recipient batch
//      doesn't hammer Resend.
//   3. start() — 60s tick. Finds campaigns with status='scheduled'
//      and scheduled_at <= NOW, transitions them to 'sending', and
//      drains them. One in-flight campaign per tick (per app
//      instance) keeps the worker simple.

'use strict';

const { pool } = require('./db');
const { sendEmail } = require('./email');
const emailTemplates = require('./email-templates');

const TICK_MS = 60 * 1000;
const MAX_PER_TICK = 50;   // recipients drained per tick per campaign

function genCampaignId() {
  return 'camp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function esc(s) {
  return String(s == null ? '' : s);
}

// ── Recipient resolvers ──────────────────────────────────────────
// Each returns [{ email, name, params }]. params is the per-row
// interpolation context the campaign body will be rendered against
// (so {{name}} / {{company}} resolve to the recipient's identity).

async function resolveSubsRecipients(orgId, filters) {
  filters = filters || {};
  const where = ['organization_id = $1', "COALESCE(status,'active') = 'active'",
                 "email IS NOT NULL AND email <> ''"];
  const params = [orgId];
  if (filters.trade) {
    params.push(String(filters.trade));
    where.push('trade = $' + params.length);
  }
  const r = await pool.query(
    "SELECT email, name, primary_contact_first, primary_contact_last, trade " +
    "  FROM subs WHERE " + where.join(' AND '),
    params
  );
  return r.rows.map(function(row) {
    const fullName = [row.primary_contact_first, row.primary_contact_last]
      .filter(Boolean).join(' ') || row.name;
    return {
      email: row.email,
      name: fullName,
      params: {
        name: fullName,
        first_name: row.primary_contact_first || '',
        company: row.name,
        email: row.email,
        trade: row.trade || ''
      }
    };
  });
}

async function resolveLeadsRecipients(orgId, filters) {
  filters = filters || {};
  // Leads emails live on the joined client row (client.email) — the
  // lead itself doesn't carry one. Join in for the address.
  const where = ['l.organization_id = $1', "c.email IS NOT NULL AND c.email <> ''"];
  const params = [orgId];
  if (filters.status) {
    params.push(String(filters.status));
    where.push('l.status = $' + params.length);
  }
  const r = await pool.query(
    "SELECT c.email, c.name AS client_name, c.first_name, c.last_name, " +
    "       l.title AS lead_title, l.status " +
    "  FROM leads l JOIN clients c ON c.id = l.client_id " +
    " WHERE " + where.join(' AND '),
    params
  );
  return r.rows.map(function(row) {
    const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.client_name;
    return {
      email: row.email,
      name: fullName,
      params: {
        name: fullName,
        first_name: row.first_name || '',
        company: row.client_name || '',
        email: row.email,
        lead_title: row.lead_title || '',
        status: row.status || ''
      }
    };
  });
}

async function resolveClientsRecipients(orgId, filters) {
  filters = filters || {};
  const where = ['organization_id = $1', "email IS NOT NULL AND email <> ''",
                 "COALESCE(activation_status,'active') = 'active'"];
  const params = [orgId];
  if (filters.client_type) {
    params.push(String(filters.client_type));
    where.push('client_type = $' + params.length);
  }
  const r = await pool.query(
    "SELECT email, name, first_name, last_name, client_type " +
    "  FROM clients WHERE " + where.join(' AND '),
    params
  );
  return r.rows.map(function(row) {
    const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.name;
    return {
      email: row.email,
      name: fullName,
      params: {
        name: fullName,
        first_name: row.first_name || '',
        company: row.name || '',
        email: row.email,
        client_type: row.client_type || ''
      }
    };
  });
}

function resolveManualRecipients(rows) {
  // rows is an array of { email, name? } or strings (just an email).
  if (!Array.isArray(rows)) return [];
  const seen = {};
  const out = [];
  rows.forEach(function(r) {
    let email; let name = '';
    if (typeof r === 'string') email = r.trim();
    else if (r && typeof r === 'object') {
      email = String(r.email || '').trim();
      name = String(r.name || '').trim();
    } else return;
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return;
    if (seen[email.toLowerCase()]) return;
    seen[email.toLowerCase()] = true;
    out.push({ email: email, name: name, params: { name: name, email: email } });
  });
  return out;
}

// Public: take a saved recipient_query and return a flat list. The
// query has shape { type: 'subs'|'leads'|'clients'|'manual', filters?, manual? }.
async function resolveRecipients(orgId, query) {
  query = query || {};
  switch (query.type) {
    case 'subs':    return resolveSubsRecipients(orgId, query.filters || {});
    case 'leads':   return resolveLeadsRecipients(orgId, query.filters || {});
    case 'clients': return resolveClientsRecipients(orgId, query.filters || {});
    case 'manual':  return resolveManualRecipients(query.manual || []);
    default: return [];
  }
}

// ── Send pipeline ────────────────────────────────────────────────

// Interpolate {{var}} placeholders in source using params. Mirrors
// the email-templates interpolate signature so the campaign body
// behaves identically to a normal template.
function interpolate(source, params) {
  return emailTemplates.interpolate(source, params);
}

// Render the campaign body for one recipient. If the body is JSON
// (blocks), parse and render; otherwise treat as raw HTML with
// {{var}} placeholders.
function renderBody(rawBody, params) {
  const parsed = emailTemplates.tryParseBlocks(rawBody);
  if (parsed && Array.isArray(parsed.blocks)) {
    return emailTemplates.renderBlocks(parsed.blocks, params);
  }
  return interpolate(rawBody, params);
}

// Drain up to MAX_PER_TICK queued recipients for one campaign. Marks
// the campaign 'completed' when no queued rows remain. Returns
// { drained, remaining }.
async function drainCampaign(campaign) {
  const recR = await pool.query(
    "SELECT id, email, name, params FROM email_campaign_recipients " +
    " WHERE campaign_id = $1 AND status = 'queued' " +
    " ORDER BY id ASC LIMIT $2",
    [campaign.id, MAX_PER_TICK]
  );
  let drained = 0;
  for (const rec of recR.rows) {
    const params = Object.assign(
      { __orgId: campaign.organization_id, appUrl: process.env.APP_URL || '' },
      rec.params || {}
    );
    const subject = interpolate(campaign.subject, params);
    let html;
    try {
      html = renderBody(campaign.body, params);
    } catch (e) {
      await pool.query(
        "UPDATE email_campaign_recipients SET status='failed', error=$1 WHERE id=$2",
        ['render: ' + (e.message || 'unknown'), rec.id]
      );
      await pool.query(
        "UPDATE email_campaigns SET failed_count = failed_count + 1 WHERE id = $1",
        [campaign.id]
      );
      continue;
    }
    const result = await sendEmail({
      to: rec.email,
      subject: subject,
      html: html,
      tag: 'campaign:' + campaign.id
    });
    if (result.ok) {
      await pool.query(
        "UPDATE email_campaign_recipients SET status='sent', sent_at=NOW(), log_id=$1 WHERE id=$2",
        [result.id || null, rec.id]
      );
      await pool.query(
        "UPDATE email_campaigns SET sent_count = sent_count + 1 WHERE id = $1",
        [campaign.id]
      );
    } else {
      await pool.query(
        "UPDATE email_campaign_recipients SET status='failed', error=$1 WHERE id=$2",
        [(result.error || 'unknown').slice(0, 500), rec.id]
      );
      await pool.query(
        "UPDATE email_campaigns SET failed_count = failed_count + 1 WHERE id = $1",
        [campaign.id]
      );
    }
    drained++;
  }
  // Check for remaining queue
  const leftR = await pool.query(
    "SELECT COUNT(*)::int AS c FROM email_campaign_recipients WHERE campaign_id = $1 AND status = 'queued'",
    [campaign.id]
  );
  const remaining = (leftR.rows[0] && leftR.rows[0].c) || 0;
  if (remaining === 0) {
    await pool.query(
      "UPDATE email_campaigns SET status='completed', sent_at = COALESCE(sent_at, NOW()) WHERE id = $1",
      [campaign.id]
    );
  }
  return { drained: drained, remaining: remaining };
}

// Public: materialize the recipient list and flip the campaign to
// sending. Called by POST /api/email/campaigns/:id/send when the
// admin clicks "Send now" with no scheduled_at, and by the cron when
// a scheduled campaign comes due.
async function startCampaign(campaignId) {
  const r = await pool.query('SELECT * FROM email_campaigns WHERE id = $1', [campaignId]);
  if (!r.rows.length) throw new Error('campaign not found');
  const campaign = r.rows[0];
  if (campaign.status === 'sending' || campaign.status === 'completed') {
    return { ok: true, alreadyStarted: true };
  }
  // Resolve recipients fresh.
  const recipients = await resolveRecipients(campaign.organization_id, campaign.recipient_query);
  if (!recipients.length) {
    await pool.query(
      "UPDATE email_campaigns SET status='completed', sent_at=NOW(), total_count=0 WHERE id=$1",
      [campaignId]
    );
    return { ok: true, total: 0, note: 'no recipients matched' };
  }
  // Insert recipient rows in a single statement.
  const values = [];
  const placeholders = [];
  recipients.forEach(function(r, i) {
    const base = i * 4;
    placeholders.push('($' + (base + 1) + ', $' + (base + 2) + ', $' + (base + 3) + ', $' + (base + 4) + '::jsonb)');
    values.push(campaignId, r.email, r.name || null, JSON.stringify(r.params || {}));
  });
  await pool.query(
    "INSERT INTO email_campaign_recipients (campaign_id, email, name, params) VALUES " +
    placeholders.join(','),
    values
  );
  await pool.query(
    "UPDATE email_campaigns SET status='sending', total_count=$1 WHERE id=$2",
    [recipients.length, campaignId]
  );
  // Kick off first drain (best-effort, not awaited so the API
  // request returns fast).
  drainCampaign(Object.assign({}, campaign, { total_count: recipients.length, status: 'sending' }))
    .catch(function(e) { console.warn('[campaigns] drain error:', e.message); });
  return { ok: true, total: recipients.length };
}

// ── Cron tick ────────────────────────────────────────────────────

async function tick() {
  try {
    // 1. Pick up scheduled campaigns whose time has come.
    const dueR = await pool.query(
      "SELECT id FROM email_campaigns " +
      " WHERE status = 'scheduled' AND scheduled_at <= NOW() " +
      "   AND archived_at IS NULL " +
      " ORDER BY scheduled_at ASC LIMIT 5"
    );
    for (const row of dueR.rows) {
      try { await startCampaign(row.id); }
      catch (e) { console.warn('[campaigns] start error id=' + row.id, e.message); }
    }
    // 2. Drain in-flight campaigns. One drain per tick per campaign;
    // long batches get smoothed across many ticks.
    const sendingR = await pool.query(
      "SELECT * FROM email_campaigns " +
      " WHERE status = 'sending' AND archived_at IS NULL " +
      " ORDER BY sent_at ASC NULLS FIRST LIMIT 3"
    );
    for (const c of sendingR.rows) {
      try { await drainCampaign(c); }
      catch (e) { console.warn('[campaigns] drain error id=' + c.id, e.message); }
    }
  } catch (e) {
    console.warn('[campaigns] tick error:', e.message);
  }
}

let _started = false;
function start() {
  if (_started) return;
  _started = true;
  setTimeout(function runTick() {
    tick().catch(function(e) { console.warn('[campaigns] tick threw:', e.message); });
    setTimeout(runTick, TICK_MS);
  }, 15 * 1000);  // first tick 15s after boot
  console.log('[campaigns] worker armed; tick every ' + (TICK_MS / 1000) + 's');
}

module.exports = {
  genCampaignId: genCampaignId,
  resolveRecipients: resolveRecipients,
  startCampaign: startCampaign,
  drainCampaign: drainCampaign,
  tick: tick,
  start: start
};
