'use strict';

// WORK-ORDER NOTICES other than "ready for approval" (which stays in
// services/service-ticket-notify.js):
//
//   notifyAssigned         the office (or 86) assigned a work order to someone
//   notifySentBack         the office sent the work back: the crew link's email
//                          address hears why (CREW-FACING)
//   notifyProblemFlagged   a crew flagged a problem: the people on the work
//                          order hear right away
//   sendCrewActivityBatch  what crews did on the link, batched by the notice
//                          cron at most once per work order every 30 minutes
//
// WHO is decided by services/work-order-recipients.js, WHAT they read by
// services/work-order-notify-text.js. This file is the plumbing between them:
// preferences, senders, Reply-To and the timeline line.
//
// PREFERENCES (server/notify-events.js): email is off when
// users.notification_prefs[key] === false, push is off when
// notification_prefs.push[key] === false. A missing key is on.
//
// BEST-EFFORT: every function catches and returns; none throws. The write that
// justified a notice has already applied or committed before it is called, and
// callers hand the promise to services/inflight.js track() so a deploy lets it
// finish.
//
// NO MONEY: the messages read the ticket's title, dates and priority, the
// site's number, name and address, counts, and the crew's or office's text.
// The send-back email goes to people outside the company and carries no link
// (the token is stored hashed and cannot be rebuilt).
//
// Tenancy: every statement carries `organization_id = $n` taken from the
// ticket row the caller already proved.
//
// Senders and helpers are required lazily, so a module that only needs the
// exports loads without a database or an email configuration.

const KEYS = Object.freeze({
  assignment: 'ticket_assignment',
  problem: 'ticket_problem',
  crewActivity: 'ticket_crew_activity',
});

// Crew events the activity batch counts. Only actor_kind 'share'.
const CREW_BATCH_KINDS = Object.freeze([
  'share_opened', 'status_changed', 'subtask_completed', 'subtask_reopened', 'photo_added',
  'subtask_note', 'note_added', 'field_changed', 'revision_proposed',
]);

const SEND_BACK_CAP = 10;

function text() { return require('./work-order-notify-text'); }
function recipientsModule() { return require('./work-order-recipients'); }
function senderHelpers() { return require('../email-sender'); }

function positiveInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function resolveDeps(deps) {
  const d = deps || {};
  let isEnabled = d.isEnabled;
  if (typeof isEnabled !== 'function') {
    isEnabled = d.sendEmail
      ? function () { return true; }
      : function () { return require('../email').isEnabled(); };
  }
  return {
    sendEmail: d.sendEmail || function (m) { return require('../email').sendEmail(m); },
    sendPush: d.sendPush || function (userId, key, payload, prefs) {
      return require('../notify-events').sendPushForEvent(userId, key, payload, prefs);
    },
    hasCapability: d.hasCapability,
    isEnabled: isEnabled,
  };
}

function prefsOf(u) {
  let p = u && u.notification_prefs;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = {}; } }
  return (p && typeof p === 'object') ? p : {};
}

function emailOn(u, key) {
  return !!(u && u.email) && prefsOf(u)[key] !== false;
}

function pushOn(u, key) {
  const prefs = prefsOf(u);
  return !(prefs.push && typeof prefs.push === 'object' && prefs.push[key] === false);
}

function reachable(u, key) {
  return emailOn(u, key) || pushOn(u, key);
}

function displayName(u) {
  return String((u && (u.name || u.email)) || ('User ' + (u && u.id))).slice(0, 80);
}

async function logSystemEvent(db, ticket, kind, detail) {
  try {
    const svc = require('./service-tickets');
    await db.query(
      `INSERT INTO service_ticket_events
         (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, actor_label, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [svc.genId('ste'), ticket.organization_id, ticket.id, kind, 'system', null, null, null,
       JSON.stringify(detail || {})]
    );
  } catch (e) {
    console.warn('[work-order-notices] event log failed (' + kind + '):', e && e.message);
  }
}

async function senderOrgFor(db, orgId) {
  const name = await senderHelpers().orgNameFor(db, orgId);
  return name ? { id: orgId, name: name } : { id: orgId };
}

async function siteFor(db, ticket) {
  try {
    return await require('./service-ticket-workorder').workOrderSite(db, ticket);
  } catch (e) {
    return { job_number: null, name: null, address: null };
  }
}

// One person, one message: email when their email pref is on, push when their
// push pref is on. True when either channel reached them.
async function deliver(d, u, key, message, opts) {
  const o = opts || {};
  let reached = false;
  if (emailOn(u, key)) {
    try {
      const helpers = senderHelpers();
      const r = await d.sendEmail({
        to: u.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
        tag: key,
        organizationId: o.orgId,
        senderOrg: o.senderOrg,
        replyTo: helpers.cleanReplyTo(o.replyTo, [u.email]) || false,
      });
      if (r && r.ok) reached = true;
    } catch (e) {
      console.warn('[work-order-notices] email failed (' + key + '):', e && e.message);
    }
  }
  if (message.push && pushOn(u, key)) {
    try {
      const p = await d.sendPush(Number(u.id), key, message.push, prefsOf(u));
      if (p && p.sent) reached = true;
    } catch (e) {
      console.warn('[work-order-notices] push failed (' + key + '):', e && e.message);
    }
  }
  return reached;
}

async function subtaskTally(db, ticket) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'done')::int AS done
       FROM tasks
      WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL AND scope = 'org'`,
    [ticket.id, ticket.organization_id]
  );
  const row = r.rows[0] || {};
  return { total: Number(row.total) || 0, done: Number(row.done) || 0 };
}

/**
 * notifyAssigned(db, {ticket, assigneeUserId, previousAssigneeUserId, actor}, deps?)
 *   -> {sent} | {sent:0, skipped: 'unchanged'|'self'|'no_user'|'no_access'|'muted'|'error'}
 * The new assignee only, and only when they can open the work order.
 */
async function notifyAssigned(db, opts, deps) {
  try {
    const o = opts || {};
    const ticket = o.ticket;
    if (!ticket || ticket.id == null || ticket.organization_id == null) return { sent: 0, skipped: 'error' };
    const assignee = positiveInt(o.assigneeUserId);
    if (!assignee) return { sent: 0, skipped: 'no_user' };
    if (assignee === positiveInt(o.previousAssigneeUserId)) return { sent: 0, skipped: 'unchanged' };
    const actor = o.actor || {};
    if (assignee === positiveInt(actor.userId)) return { sent: 0, skipped: 'self' };
    const d = resolveDeps(deps);
    const orgId = ticket.organization_id;

    const r = await db.query(
      'SELECT id, name, email, role, notification_prefs FROM users WHERE id = $1 AND organization_id = $2 AND active = TRUE',
      [assignee, orgId]
    );
    const u = r.rows[0];
    if (!u) return { sent: 0, skipped: 'no_user' };
    const memo = recipientsModule().accessMemo(d.hasCapability);
    if (!(await memo.check(db, u, ticket, 'read', orgId))) return { sent: 0, skipped: 'no_access' };
    if (!reachable(u, KEYS.assignment)) return { sent: 0, skipped: 'muted' };

    let assigner = text().oneLine(actor.label, 80);
    if (!assigner && positiveInt(actor.userId)) {
      const n = await db.query('SELECT name FROM users WHERE id = $1 AND organization_id = $2', [positiveInt(actor.userId), orgId]);
      assigner = text().oneLine(n.rows[0] && n.rows[0].name, 80);
    }
    const [site, tally, senderOrg, replyTo] = await Promise.all([
      siteFor(db, ticket),
      subtaskTally(db, ticket),
      senderOrgFor(db, orgId),
      positiveInt(actor.userId) ? senderHelpers().replyToForUser(db, positiveInt(actor.userId), orgId) : null,
    ]);
    const message = text().assignmentMessage({ ticket: ticket, site: site, assigner: assigner, recipient: u, tally: tally });
    const reached = await deliver(d, u, KEYS.assignment, message, {
      orgId: orgId, senderOrg: senderOrg, replyTo: replyTo,
    });
    if (reached) await logSystemEvent(db, ticket, 'assignee_notified', { names: [displayName(u)] });
    return { sent: reached ? 1 : 0 };
  } catch (e) {
    console.warn('[work-order-notices] assignment notice failed:', e && e.message);
    return { sent: 0, skipped: 'error' };
  }
}

function dedupeRecipients(rows) {
  const seen = new Set();
  const out = [];
  (rows || []).forEach(function (row) {
    const email = String((row && (row.email != null ? row.email : row.recipient_email)) || '').trim();
    if (!email) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      share_id: row.share_id != null ? row.share_id : row.id,
      email: email,
      name: row.name != null ? row.name : (row.recipient_name != null ? row.recipient_name : null),
    });
  });
  return out.slice(0, SEND_BACK_CAP);
}

/**
 * sendBackRecipients(db, ticket) -> [{share_id, email, name}]
 * Live links that can act (respond or propose) with an address, newest first,
 * one per address, at most 10. View-only links cannot redo work.
 */
async function sendBackRecipients(db, ticket) {
  try {
    if (!ticket || ticket.id == null || ticket.organization_id == null) return [];
    const r = await db.query(
      `SELECT id, recipient_email, recipient_name FROM service_ticket_shares
        WHERE ticket_id = $1 AND organization_id = $2 AND revoked_at IS NULL AND expires_at > NOW()
          AND scope IN ('respond','propose') AND recipient_email IS NOT NULL AND recipient_email <> ''
        ORDER BY created_at DESC`,
      [ticket.id, ticket.organization_id]
    );
    return dedupeRecipients(r.rows);
  } catch (e) {
    console.warn('[work-order-notices] send-back recipients failed:', e && e.message);
    return [];
  }
}

/**
 * notifySentBack(db, {ticket, actor, sendBack:{note, buildings}, recipients?}, deps?)
 *   -> {sent, failed} | {sent:0, failed:0, skipped: 'no_link_email'|'no_reason'|'error'}
 * Call only after the send-back applied. One timeline line with counts only.
 */
async function notifySentBack(db, opts, deps) {
  try {
    const o = opts || {};
    const ticket = o.ticket;
    if (!ticket || ticket.id == null || ticket.organization_id == null) return { sent: 0, failed: 0, skipped: 'error' };
    const sendBack = o.sendBack || {};
    const note = String(sendBack.note == null ? '' : sendBack.note).trim();
    if (!note) return { sent: 0, failed: 0, skipped: 'no_reason' };
    const list = Array.isArray(o.recipients) ? dedupeRecipients(o.recipients) : await sendBackRecipients(db, ticket);
    if (!list.length) return { sent: 0, failed: 0, skipped: 'no_link_email' };
    const d = resolveDeps(deps);
    const orgId = ticket.organization_id;
    const actor = o.actor || {};
    const helpers = senderHelpers();

    let sent = 0;
    let failed = 0;
    if (!d.isEnabled()) {
      failed = list.length;
    } else {
      const [site, orgName, replyTo] = await Promise.all([
        siteFor(db, ticket),
        helpers.orgNameFor(db, orgId),
        positiveInt(actor.userId) ? helpers.replyToForUser(db, positiveInt(actor.userId), orgId) : null,
      ]);
      const senderOrg = orgName ? { id: orgId, name: orgName } : { id: orgId };
      for (const rcpt of list) {
        const message = text().sentBackCrewEmail({
          orgName: orgName, title: ticket.title, site: site, sendBack: { note: note, buildings: sendBack.buildings },
          recipientName: rcpt.name,
        });
        try {
          const r = await d.sendEmail({
            to: rcpt.email,
            subject: message.subject,
            html: message.html,
            text: message.text,
            tag: 'service_ticket_sent_back',
            organizationId: orgId,
            senderOrg: senderOrg,
            replyTo: helpers.cleanReplyTo(replyTo, [rcpt.email]) || false,
          });
          if (r && r.ok) sent++; else failed++;
        } catch (e) {
          failed++;
          console.warn('[work-order-notices] send-back email failed:', e && e.message);
        }
      }
    }
    await logSystemEvent(db, ticket, 'crew_emailed', { about: 'send_back', sent: sent, failed: failed });
    return { sent: sent, failed: failed };
  } catch (e) {
    console.warn('[work-order-notices] send-back notice failed:', e && e.message);
    return { sent: 0, failed: 0, skipped: 'error' };
  }
}

/**
 * notifyProblemFlagged(db, {ticket, share, flag:{id, category, note, task_id,
 *   task_title, photo_count, author_label?}}, deps?)
 *   -> {sent, recipients} | {sent:0, recipients?, skipped: 'already_notified'|'no_recipients'|'error'}
 * Once per flag id. Everyone on the work order who can open it, every link's
 * sender included; the org's admins when nobody on it can.
 */
async function notifyProblemFlagged(db, opts, deps) {
  try {
    const o = opts || {};
    const ticket = o.ticket;
    const flag = o.flag || {};
    const share = o.share || {};
    if (!ticket || ticket.id == null || ticket.organization_id == null || flag.id == null) {
      return { sent: 0, skipped: 'error' };
    }
    const orgId = ticket.organization_id;
    const already = await db.query(
      `SELECT 1 FROM service_ticket_events
        WHERE ticket_id = $1 AND organization_id = $2 AND kind = 'flag_notified' AND detail->>'flag_id' = $3
        LIMIT 1`,
      [ticket.id, orgId, String(flag.id)]
    );
    if (already.rows.length) return { sent: 0, skipped: 'already_notified' };

    const d = resolveDeps(deps);
    const found = await recipientsModule().ticketRecipients(db, ticket, {
      mode: 'read', allSenders: true, sharedBy: share.created_by, fallbackToAdmins: true, hasCapability: d.hasCapability,
    });
    const people = found.users.filter(function (u) { return reachable(u, KEYS.problem); });
    if (!people.length) return { sent: 0, recipients: 0, skipped: 'no_recipients' };

    let taskTitle = flag.task_title;
    if (!taskTitle && flag.task_id != null && flag.task_id !== '') {
      const t = await db.query(
        'SELECT title FROM tasks WHERE id = $1 AND service_ticket_id = $2 AND organization_id = $3',
        [String(flag.task_id), ticket.id, orgId]
      );
      taskTitle = t.rows[0] && t.rows[0].title;
    }
    let replyTo = null;
    if (share.id != null) {
      try {
        const s = await db.query(
          'SELECT recipient_email FROM service_ticket_shares WHERE id = $1 AND organization_id = $2',
          [share.id, orgId]
        );
        replyTo = (s.rows[0] && senderHelpers().cleanReplyTo(s.rows[0].recipient_email, [])) || null;
      } catch (_) { replyTo = null; }
    }
    const [site, senderOrg] = await Promise.all([siteFor(db, ticket), senderOrgFor(db, orgId)]);
    const crewLabel = flag.author_label || share.recipient_name || null;

    let sent = 0;
    const names = [];
    for (const u of people) {
      const message = text().flagMessage({
        ticket: ticket, site: site, crewLabel: crewLabel, recipient: u, fallback: found.fallback,
        flag: { id: flag.id, category: flag.category, note: flag.note, task_title: taskTitle, photo_count: flag.photo_count },
      });
      const reached = await deliver(d, u, KEYS.problem, message, {
        orgId: orgId, senderOrg: senderOrg, replyTo: replyTo,
      });
      if (reached) { sent++; names.push(displayName(u)); }
    }
    if (names.length) await logSystemEvent(db, ticket, 'flag_notified', { names: names, flag_id: String(flag.id) });
    return { sent: sent, recipients: people.length };
  } catch (e) {
    console.warn('[work-order-notices] problem notice failed:', e && e.message);
    return { sent: 0, skipped: 'error' };
  }
}

function parsedDetail(e) {
  let d = e && e.detail;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = {}; } }
  return (d && typeof d === 'object') ? d : {};
}

// Which of a batch's events the office hears about. Crew events only; a flag's
// photo belongs to the flag alert; once the work order is at Work complete the
// approval notice already counts finished buildings and completion photos, and
// a trip back to In progress that has since been finished again is old news.
function crewBatchEvents(events, ticketStatus) {
  const nowComplete = ticketStatus === 'work_complete';
  return (Array.isArray(events) ? events : []).filter(function (e) {
    if (!e || e.actor_kind !== 'share' || CREW_BATCH_KINDS.indexOf(e.kind) < 0) return false;
    const d = parsedDetail(e);
    if (e.kind === 'status_changed' && d.to !== 'in_progress') return false;
    if (nowComplete && e.kind === 'status_changed' && d.from === 'work_complete') return false;
    if (e.kind === 'photo_added' && d.flag_id != null) return false;
    if (nowComplete && e.kind === 'subtask_completed') return false;
    if (nowComplete && e.kind === 'photo_added' && d.task_id != null && d.kind !== 'before') return false;
    return true;
  });
}

/**
 * sendCrewActivityBatch(db, {ticket, events}, deps?) -> {sent, lines}
 * events are the service_ticket_events rows the notice cron claimed for this
 * batch. Nothing left after filtering sends nothing. No timeline entry: the
 * batch summarises entries already there.
 */
async function sendCrewActivityBatch(db, opts, deps) {
  try {
    const o = opts || {};
    const ticket = o.ticket;
    if (!ticket || ticket.id == null || ticket.organization_id == null) return { sent: 0, lines: [] };
    const orgId = ticket.organization_id;
    const events = crewBatchEvents(o.events, ticket.status);
    if (!events.length) return { sent: 0, lines: [] };

    const taskIds = [];
    events.forEach(function (e) {
      const d = parsedDetail(e);
      if (d.task_id != null && d.task_id !== '' && taskIds.indexOf(String(d.task_id)) < 0) taskIds.push(String(d.task_id));
    });
    const taskTitles = new Map();
    if (taskIds.length) {
      const t = await db.query(
        'SELECT id, title FROM tasks WHERE id = ANY($1::text[]) AND service_ticket_id = $2 AND organization_id = $3',
        [taskIds, ticket.id, orgId]
      );
      t.rows.forEach(function (row) { taskTitles.set(String(row.id), row.title); });
    }
    let pending = 0;
    if (events.some(function (e) { return e.kind === 'revision_proposed'; })) {
      const p = await db.query(
        `SELECT COUNT(*)::int AS n FROM service_ticket_revisions
          WHERE ticket_id = $1 AND organization_id = $2 AND status = 'pending'`,
        [ticket.id, orgId]
      );
      pending = Number(p.rows[0] && p.rows[0].n) || 0;
    }
    const summary = text().crewActivitySummary(events, { taskTitles: taskTitles, pendingSuggestions: pending });
    if (!summary.lines.length) return { sent: 0, lines: [] };

    const shareIds = [];
    events.forEach(function (e) {
      if (e.share_id != null && shareIds.indexOf(String(e.share_id)) < 0) shareIds.push(String(e.share_id));
    });
    let sharedBy = [];
    let replyTo = null;
    if (shareIds.length) {
      const s = await db.query(
        'SELECT id, created_by, recipient_email FROM service_ticket_shares WHERE id = ANY($1::text[]) AND organization_id = $2',
        [shareIds, orgId]
      );
      sharedBy = s.rows.map(function (row) { return row.created_by; });
      if (shareIds.length === 1 && s.rows[0]) replyTo = senderHelpers().cleanReplyTo(s.rows[0].recipient_email, []) || null;
    }

    const d = resolveDeps(deps);
    const found = await recipientsModule().ticketRecipients(db, ticket, {
      mode: 'read', sharedBy: sharedBy, hasCapability: d.hasCapability,
    });
    const people = found.users.filter(function (u) { return reachable(u, KEYS.crewActivity); });
    if (!people.length) return { sent: 0, lines: summary.lines };
    const [site, senderOrg] = await Promise.all([siteFor(db, ticket), senderOrgFor(db, orgId)]);

    let sent = 0;
    for (const u of people) {
      const message = text().crewActivityMessage({ ticket: ticket, site: site, summary: summary, recipient: u });
      const reached = await deliver(d, u, KEYS.crewActivity, message, {
        orgId: orgId, senderOrg: senderOrg, replyTo: replyTo,
      });
      if (reached) sent++;
    }
    return { sent: sent, lines: summary.lines };
  } catch (e) {
    console.warn('[work-order-notices] crew activity notice failed:', e && e.message);
    return { sent: 0, lines: [] };
  }
}

module.exports = {
  KEYS,
  CREW_BATCH_KINDS,
  notifyAssigned,
  sendBackRecipients,
  notifySentBack,
  notifyProblemFlagged,
  crewBatchEvents,
  sendCrewActivityBatch,
};
