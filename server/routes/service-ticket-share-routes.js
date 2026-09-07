// Service-ticket share links — both doors in one file, the way
// task-share-routes.js and report-share-routes.js keep them, so the owner side
// and the public side of one credential can be read together.
//
//   PM-side (requireAuth + the ticket's inherited capability):
//     POST /api/service-tickets/:id/share              mint
//     GET  /api/service-tickets/:id/shares             list
//     POST /api/service-tickets/:id/shares/:sid/revoke
//
//   PUBLIC (no auth — the token IS the credential):
//     GET  /api/service-ticket-share/:token
//
// SLICE S4 SHIPS READ-ONLY ON PURPOSE. There is no PATCH, no photo upload and
// no revision door here yet. The first public door is the highest-risk thing
// in this feature, and shipping it with no write path means there is no write
// path to get wrong while the read side is proven.
//
// UNLIKE report_shares THERE IS NO SNAPSHOT. A report is a finished artifact
// and freezing it is honest; a work order is LIVE — the crew must see the scope
// as it stands today and the PM must be able to revise after sending the link.
// So the guest read JOINS the ticket, which costs report_shares' "one indexed
// row, no id-joins" property. That is paid for by publicTicket(), a whitelist
// in services/service-tickets.js, so a column added to service_tickets later
// cannot leak here by default.
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability, requireOrgId } = require('../auth');
const { callerOrgId } = require('../org-access');
const { sendEmail, isEnabled: emailIsEnabled } = require('../email');
const { stShareIpLimiter, stShareViewLimiter } = require('../rate-limit');
const { resolveEntityLabels } = require('../services/entity-labels');
const svc = require('../services/service-tickets');

const router = express.Router();

function writeCapFor(ticket) {
  return ticket && ticket.job_id ? 'JOBS_EDIT_ANY JOBS_EDIT_OWN' : 'LEADS_EDIT';
}
function readCapFor(ticket) {
  return ticket && ticket.job_id ? 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED' : 'LEADS_VIEW';
}
function capOk(req, res, capList) {
  let ok = false;
  requireCapability(capList)(req, res, () => { ok = true; });
  return ok;
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return proto + '://' + host;
}

// Load a ticket and PROVE it is the caller's. 404 for both "absent" and
// "another tenant's" — a 403 would be an existence oracle.
async function loadOwnedTicket(id, orgId) {
  if (!orgId) return null;
  const { rows } = await pool.query(
    'SELECT * FROM service_tickets WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL',
    [String(id), orgId]
  );
  return rows[0] || null;
}

async function orgNameFor(orgId) {
  try {
    const { rows } = await pool.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
    return (rows[0] && rows[0].name) || '';
  } catch (e) { return ''; }
}

// The forward-facing name of the ticket's parent. A guest surface shows a lead
// title or a job number + title, NEVER a raw id.
async function parentLabelFor(ticket) {
  const type = ticket.job_id ? 'job' : 'lead';
  const id = ticket.job_id || ticket.lead_id;
  if (!id) return '';
  try {
    const map = await resolveEntityLabels(ticket.organization_id, [{ entity_type: type, entity_id: id }]);
    return map.get(type + ':' + String(id)) || '';
  } catch (e) { return ''; }
}

async function logEvent(ticket, kind, opts) {
  const o = opts || {};
  try {
    await pool.query(
      `INSERT INTO service_ticket_events
         (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, actor_label, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [svc.genId('ste'), ticket.organization_id, ticket.id, kind,
       o.actorKind || 'user', o.actorUserId || null, o.shareId || null,
       o.actorLabel || null, JSON.stringify(o.detail || {})]
    );
  } catch (e) {
    console.error('[service-ticket-share] event log failed', kind, e.message);
  }
}

// Columns the OWNER's list may see. token_hash is absent by construction —
// never selected, so it cannot be spread into a response by accident.
const SHARE_COLS =
  'id, ticket_id, scope, hide_financials, recipient_email, recipient_name, ' +
  'sub_id, expires_at, opened_at, completed_at, revoked_at, last_used_at, ' +
  'view_count, created_by, created_at';

// ── A8: mint ────────────────────────────────────────────────────────────
router.post('/service-tickets/:id/share', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });
    if (!capOk(req, res, writeCapFor(ticket))) return;

    // A link is a promise; a draft is not one. A terminal ticket is finished.
    const shareable = svc.ticketMayBeShared(ticket);
    if (!shareable.ok) return res.status(409).json({ error: shareable.reason });

    const body = req.body || {};
    // S4 ships read-only: whatever the caller asks for, the stored scope is
    // 'view'. The write scopes arrive with their doors in S5/S6, so a link
    // minted today cannot outrun the routes that would honour it.
    const scope = 'view';
    const hideFinancials = body.hide_financials !== false;
    const days = svc.clampTtlDays(body.days);
    const expires = svc.expiryFrom(days);
    const email = String(body.email || '').trim().slice(0, 200);
    const name = String(body.name || '').trim().slice(0, 120);
    const subId = body.sub_id ? String(body.sub_id).slice(0, 80) : null;

    const token = svc.genToken();
    const id = svc.genId('stshare');
    await pool.query(
      `INSERT INTO service_ticket_shares
         (id, organization_id, ticket_id, token_hash, scope, hide_financials,
          recipient_email, recipient_name, sub_id, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, orgId, ticket.id, svc.hashToken(token), scope, hideFinancials,
       email || null, name || null, subId, expires, (req.user && req.user.id) || null]
    );

    // The RAW token exists exactly here and never again — the row holds only
    // its hash, so a link not copied from this response cannot be recovered,
    // only replaced. The client shows it whether or not the email sends.
    const link = baseUrl(req) + '/st/' + token;

    let emailSent = false;
    let emailError = null;
    if (email && emailIsEnabled && emailIsEnabled()) {
      const label = await parentLabelFor(ticket);
      try {
        await sendEmail({
          to: email,
          subject: 'Work order: ' + (ticket.title || 'Service ticket'),
          html:
            '<p>' + escHtml(name || 'Hello') + ',</p>' +
            '<p>A work order has been shared with you' +
            (label ? ' for <strong>' + escHtml(label) + '</strong>' : '') + '.</p>' +
            '<p><a href="' + escHtml(link) + '">Open the work order</a></p>' +
            '<p style="color:#666;font-size:12px;">This link expires ' +
            escHtml(new Date(expires).toDateString()) + '. Anyone with the link can open it.</p>',
        });
        emailSent = true;
      } catch (e) {
        // The link is the deliverable; a failed send must not fail the mint.
        emailError = e && e.message ? e.message : 'Email failed';
      }
    }

    await logEvent(ticket, 'shared', {
      actorUserId: (req.user && req.user.id) || null,
      shareId: id,
      detail: { scope: scope, days: days, emailed: !!emailSent },
    });

    const { rows } = await pool.query(
      'SELECT ' + SHARE_COLS + ' FROM service_ticket_shares WHERE id = $1', [id]);
    res.json({ ok: true, share: rows[0], link: link, email_sent: emailSent, email_error: emailError });
  } catch (e) {
    console.error('[service-ticket-share] mint failed', e);
    res.status(500).json({ error: 'Failed to create the link' });
  }
});

// ── A9: list ────────────────────────────────────────────────────────────
router.get('/service-tickets/:id/shares', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });
    if (!capOk(req, res, readCapFor(ticket))) return;

    const { rows } = await pool.query(
      'SELECT ' + SHARE_COLS + ' FROM service_ticket_shares ' +
      'WHERE ticket_id = $1 AND organization_id = $2 ORDER BY created_at DESC',
      [ticket.id, orgId]
    );
    // The derived state is computed here rather than stored, so "expired" is
    // always true of NOW and never of whenever a column was last written.
    res.json({
      shares: rows.map(function (r) {
        return Object.assign({}, r, { state: svc.shareLifecycle(r) });
      }),
    });
  } catch (e) {
    console.error('[service-ticket-share] list failed', e);
    res.status(500).json({ error: 'Failed to load the links' });
  }
});

// ── A10: revoke ─────────────────────────────────────────────────────────
router.post('/service-tickets/:id/shares/:sid/revoke', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });
    if (!capOk(req, res, writeCapFor(ticket))) return;

    // The org predicate is in the WHERE, never in an `if` above it. A second
    // revoke is a 404 rather than a re-stamp, so the audit keeps the moment it
    // was actually turned off.
    const { rows } = await pool.query(
      `UPDATE service_ticket_shares SET revoked_at = NOW()
        WHERE id = $1 AND ticket_id = $2 AND organization_id = $3 AND revoked_at IS NULL
      RETURNING id`,
      [req.params.sid, ticket.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Link not found' });
    await logEvent(ticket, 'share_revoked', {
      actorUserId: (req.user && req.user.id) || null,
      shareId: req.params.sid,
    });
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('[service-ticket-share] revoke failed', e);
    res.status(500).json({ error: 'Failed to turn off the link' });
  }
});

// ── The public door ─────────────────────────────────────────────────────
// No auth: the token IS the credential.
async function loadTicketShare(req, res, next) {
  try {
    const token = String(req.params.token || '');
    // Shape-gated BEFORE the database is touched, so a scanner never costs a
    // query. The failure strings below are the guest UI — they say what
    // happened without revealing whether a token ever existed.
    if (!svc.isWellFormedToken(token)) return res.status(404).json({ error: 'This link is not valid.' });

    const { rows } = await pool.query(
      'SELECT * FROM service_ticket_shares WHERE token_hash = $1', [svc.hashToken(token)]);
    if (!rows.length) return res.status(404).json({ error: 'This link is not valid.' });
    const share = rows[0];

    if (share.revoked_at) return res.status(410).json({ error: 'This link has been turned off.' });
    if (new Date(share.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'This link has expired.' });
    }

    // NO org predicate here, deliberately. The share row's ticket_id was
    // written by an authed, org-proved mint and the token is globally unique,
    // so it carries its own tenancy. Adding `organization_id = $2` would mean
    // reading a tenant off a request value, which is the thing to avoid.
    const t = await pool.query(
      'SELECT * FROM service_tickets WHERE id = $1 AND archived_at IS NULL', [share.ticket_id]);
    if (!t.rows.length) return res.status(404).json({ error: 'This work order is no longer available.' });

    req.share = share;
    req.ticket = t.rows[0];
    next();
  } catch (e) {
    console.error('[service-ticket-share] token load failed', e);
    res.status(500).json({ error: 'Something went wrong opening this link.' });
  }
}

// T1 — read the work order.
router.get('/service-ticket-share/:token',
  stShareIpLimiter, stShareViewLimiter, loadTicketShare, async (req, res) => {
    try {
      const share = req.share;
      const ticket = req.ticket;

      // First open is recorded once; every open bumps the counter. Both are
      // best-effort — a failed stat must never fail the read.
      pool.query(
        `UPDATE service_ticket_shares
            SET opened_at = COALESCE(opened_at, NOW()), last_used_at = NOW(),
                view_count = view_count + 1
          WHERE id = $1`, [share.id]
      ).catch(function () { /* a stat is not worth failing a read over */ });
      if (!share.opened_at) {
        logEvent(ticket, 'share_opened', {
          actorKind: 'share', shareId: share.id,
          actorLabel: share.recipient_name || share.recipient_email || null,
        });
      }

      // Child reads carry the ticket's OWN organization_id — taken from the
      // row already in hand, never from the request.
      const tasks = await pool.query(
        `SELECT title, status, due_date FROM tasks
          WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL
          ORDER BY created_at ASC`,
        [ticket.id, ticket.organization_id]
      );

      const [orgName, parentLabel] = await Promise.all([
        orgNameFor(ticket.organization_id),
        parentLabelFor(ticket),
      ]);

      res.json({
        ticket: svc.publicTicket(ticket, share),
        share: svc.publicShare(share),
        // A whitelist here too: a task row carries an assignee, a creator and
        // an org id, none of which is a guest's business.
        tasks: tasks.rows.map(function (t) {
          return { title: t.title, done: t.status === 'done', due_date: t.due_date };
        }),
        org_name: orgName,
        parent_label: parentLabel,
      });
    } catch (e) {
      console.error('[service-ticket-share] read failed', e);
      res.status(500).json({ error: 'Something went wrong opening this link.' });
    }
  });

module.exports = router;
