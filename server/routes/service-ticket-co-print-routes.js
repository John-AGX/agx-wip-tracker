// CHANGE ORDERS AND PRINTABLES FROM A WORK ORDER (1.29, B8 and B9). Office only.
//
//   POST /api/service-tickets/:id/change-orders                          start a draft change order
//   GET  /api/service-tickets/:id/print/work-order                       the paper work order
//   GET  /api/service-tickets/:id/completion-report?include_notes=0|1    the completion report
//   POST /api/service-tickets/:id/completion-report/send                 link (and email) it to the property manager
//   POST /api/service-tickets/:id/completion-report/shares/:sid/revoke   turn a link off
//
// WHY ITS OWN ROUTER. service-ticket-routes.js is edited by several units at
// once; this file is mounted at the same prefix right after it (server/index.js)
// and none of its paths overlaps a '/:id' shape there. The access rule is not
// copied: it is services/service-ticket-access.js, translated to HTTP exactly
// the way service-ticket-routes.js ticketAccessOk does it.
//
// WHAT IT NEVER LOADS. loadTicket names its columns, and internal_notes,
// guest_log, crew_takeoff and scope_approved are not among them — a printable
// cannot leak a field this file never read. Nothing here is reachable from, or
// adds anything to, the crew link.
//
// TENANCY. The ticket is loaded with `id = $1 AND organization_id = $2`, the org
// taken from the caller, never from the body; a missing or foreign id and a job
// the caller is not on answer the same 404. Every later statement is predicated
// on the loaded row's organization_id. Completion report links are
// report_shares rows stamped with the ticket's organization_id, parent
// service_ticket_id, entity_type 'service_ticket' / entity_id the ticket, and
// scope 'view' only (a comment share would need a job report row), so the
// public /r/ page serves them unchanged and refuses comments.
//
// Heavy modules (email, the sender helpers, the report share rules) are
// required inside the handlers, so a load error fails one request rather than
// the router.
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireOrgId, hasCapability } = require('../auth');
const { callerOrgId } = require('../org-access');
const access = require('../services/service-ticket-access');
const svc = require('../services/service-tickets');
const workOrder = require('../services/service-ticket-workorder');
const inflight = require('../services/inflight');
const ticketCo = require('../services/service-ticket-change-order');
const printSvc = require('../services/service-ticket-print');
const notifyText = require('../services/work-order-notify-text');

const router = express.Router();

const TICKET_NOT_FOUND = 'Service ticket not found';
const CO_CAPABILITY = 'ESTIMATES_EDIT';

const MSG = Object.freeze({
  archived: 'This ticket is archived.',
  cancelled: 'This ticket was cancelled. Reopen it before starting a change order.',
  lead: 'Change orders belong to a job. Convert this lead to a job first.',
  jobGone: 'Job not found',
  coFailed: 'Could not start the change order',
  workOrderFailed: 'Could not build the work order',
  reportFailed: 'Could not build the completion report',
  notApproved: 'Approve the work order before sending the completion report.',
  noBuildings: 'This work order has no buildings to report on yet.',
  badEmail: 'Enter a valid email address, or leave it blank to get a link only.',
  sendFailed: 'Could not send the completion report',
  justSent: 'A completion report link for this recipient was made a moment ago. Wait a minute before trying again.',
  linkGone: 'That link is not on this work order, or it is already off.',
  revokeFailed: 'Could not turn the link off',
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHARE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// A second send of the same report to the same recipient by the same person
// inside this window is a double click, not a new send — unless the earlier
// send's email is known to have failed, when pressing Send again is a retry.
const RESEND_WINDOW = "INTERVAL '60 seconds'";

// True when every recent share for this recipient finished with its email
// failing: completion_report_sent is written after the email with emailed
// false. A share with no event yet is still in flight, and a link-only send
// (no email asked for) has nothing to retry, so neither lets a repeat through.
async function onlyFailedEmails(db, ticket, email, shareIds) {
  if (!email || !shareIds.length) return false;
  const { rows } = await db.query(
    `SELECT detail FROM service_ticket_events
      WHERE ticket_id = $1 AND organization_id = $2 AND kind = 'completion_report_sent'
      ORDER BY created_at DESC
      LIMIT 50`,
    [ticket.id, ticket.organization_id]
  );
  const emailedByShare = new Map();
  for (const r of rows) {
    let d = r.detail;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d || d.report_share_id == null) continue;
    const key = String(d.report_share_id);
    if (!emailedByShare.has(key)) emailedByShare.set(key, d.emailed === true);
  }
  return shareIds.every(function (id) {
    return emailedByShare.has(String(id)) && emailedByShare.get(String(id)) === false;
  });
}

// The columns the printables and the change order start need. Named, so a
// column added to service_tickets later is not read here by default.
const LOAD_COLS = [
  'id', 'organization_id', 'ticket_number', 'title', 'job_id', 'lead_id',
  'status', 'priority', 'scope_proposed', 'checklist', 'materials',
  'site_contact_name', 'site_contact_phone', 'street_address', 'city', 'state', 'zip',
  'lat', 'lng', 'access_notes', 'scheduled_for', 'due_date', 'assignee_user_id',
  'completed_at', 'closed_at', 'archived_at', 'created_by', 'created_at', 'updated_at',
  'approved_at', 'approved_by',
].join(', ');

async function loadTicket(id, orgId) {
  if (orgId == null) return null;
  const { rows } = await pool.query(
    `SELECT ${LOAD_COLS} FROM service_tickets WHERE id = $1 AND organization_id = $2`,
    [String(id), orgId]
  );
  return rows[0] || null;
}

function verdictFor(req, ticket, mode, orgId) {
  return access.mayAccessTicketParent({
    query: (sql, params) => pool.query(sql, params),
    user: req.user,
    parent: ticket,
    mode,
    orgId,
  });
}

// The same HTTP translation service-ticket-routes.js uses. Returns true when
// the caller may proceed; false means the response has been written.
async function ticketAccessOk(req, res, ticket, mode, orgId) {
  const verdict = await verdictFor(req, ticket, mode, orgId);
  if (verdict && verdict.ok === true) return true;
  const reason = verdict && verdict.reason;
  if (reason === 'not_assigned') {
    res.status(404).json({ error: TICKET_NOT_FOUND });
    return false;
  }
  if (reason === 'no_capability') {
    const caps = access.capsForParentKind(access.parentOf(ticket).kind, mode);
    res.status(403).json({ error: 'Missing capability: ' + caps.join(' ') });
    return false;
  }
  res.status(403).json({ error: 'You do not have access to this service ticket' });
  return false;
}

function actorOf(req) {
  return { kind: 'user', userId: (req.user && req.user.id) || null, label: (req.user && req.user.name) || null };
}

function baseUrl(req) {
  const headers = req.headers || {};
  const proto = String(headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(headers['x-forwarded-host'] || (typeof req.get === 'function' ? req.get('host') : '') || '').split(',')[0].trim();
  return proto + '://' + host;
}

function falseish(v) {
  return v === false || v === 0 || v === '0' || v === 'false' || v === 'no';
}

// ── B8: start a change order ─────────────────────────────────────────────
router.post('/:id/change-orders', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
    if (!hasCapability(req.user, CO_CAPABILITY)) {
      return res.status(403).json({ error: 'Missing capability: ' + CO_CAPABILITY });
    }
    if (ticket.archived_at) return res.status(409).json({ error: MSG.archived });
    if (ticket.status === 'cancelled') return res.status(409).json({ error: MSG.cancelled });
    if (!ticket.job_id) return res.status(409).json({ error: MSG.lead });
    const job = await pool.query('SELECT id FROM jobs WHERE id = $1 AND organization_id = $2', [String(ticket.job_id), orgId]);
    if (!job.rows[0]) return res.status(404).json({ error: MSG.jobGone });

    const result = await ticketCo.startChangeOrder(pool, { ticket, user: req.user, body: req.body });
    if (!result.ok) {
      const body = { error: result.error };
      if (result.existing) body.existing = result.existing;
      return res.status(result.status || 400).json(body);
    }
    res.json({ ok: true, change_order: result.change_order, change_orders: result.change_orders });
  } catch (e) {
    console.error('[service-ticket-co] start change order failed', e && e.message);
    res.status(500).json({ error: MSG.coFailed });
  }
});

// ── B9: the paper work order ─────────────────────────────────────────────
router.get('/:id/print/work-order', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const ticket = await loadTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;
    const input = await printSvc.loadWorkOrderInputs(pool, ticket);
    res.json({ document: printSvc.buildWorkOrderPrint(Object.assign(input, { now: new Date() })) });
  } catch (e) {
    console.error('[service-ticket-print] work order failed', e && e.message);
    res.status(500).json({ error: MSG.workOrderFailed });
  }
});

// The completion report links on a ticket, for callers who may edit it: they
// carry the recipients' email addresses.
async function listShares(ticket, orgTz) {
  const shares = require('../services/report-shares');
  const { rows } = await pool.query(
    `SELECT id, recipient_email, recipient_name, expires_at, opened_at, revoked_at,
            COALESCE(view_count, 0) AS view_count, created_at
       FROM report_shares
      WHERE service_ticket_id = $1 AND organization_id = $2
      ORDER BY created_at DESC
      LIMIT 50`,
    [ticket.id, ticket.organization_id]
  );
  const now = Date.now();
  return rows.map(function (r) {
    return Object.assign({}, r, {
      view_count: Number(r.view_count) || 0,
      expires_label: printSvc.instantDateLabel(r.expires_at, orgTz),
      state: shares.shareLifecycle(r, now),
    });
  });
}

async function buildReport(req, ticket, includeNotes) {
  const input = await printSvc.loadCompletionInputs(pool, ticket);
  const built = printSvc.buildCompletionReport(Object.assign(input, {
    includeNotes: includeNotes,
    preparedBy: (req.user && req.user.name) || null,
    now: new Date(),
  }));
  return { input, built };
}

// ── B9: the completion report ────────────────────────────────────────────
router.get('/:id/completion-report', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const ticket = await loadTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;
    const q = req.query || {};
    const includeNotes = !falseish(q.include_notes);
    const { input, built } = await buildReport(req, ticket, includeNotes);

    // Recipient emails are for people who may edit the work order. Asked
    // silently: a read-only caller gets the report with shares null.
    let shares = null;
    const write = await verdictFor(req, ticket, 'write', orgId);
    if (write && write.ok === true) shares = await listShares(ticket, input.tz);

    res.json({ document: built.document, summary: built.summary, shares });
  } catch (e) {
    console.error('[service-ticket-print] completion report failed', e && e.message);
    res.status(500).json({ error: MSG.reportFailed });
  }
});

// One send per ticket, recipient and sender at a time in this process; the
// database check under the ticket lock covers the rest.
const sendsInFlight = new Set();

router.post('/:id/completion-report/send', requireAuth, requireOrgId, async (req, res) => {
  let slot = null;
  try {
    const orgId = req.orgId;
    const ticket = await loadTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
    if (ticket.archived_at) return res.status(409).json({ error: MSG.archived });
    if (printSvc.APPROVED_STATUSES.indexOf(ticket.status) < 0) return res.status(409).json({ error: MSG.notApproved });

    const body = req.body || {};
    const email = String(body.email == null ? '' : body.email).trim();
    if (email && (email.length > 200 || !EMAIL_RE.test(email))) return res.status(400).json({ error: MSG.badEmail });
    const name = notifyText.oneLine(body.name, 120);
    const includeNotes = !falseish(body.include_notes);
    const shares = require('../services/report-shares');
    const days = shares.clampTtlDays(body.days);

    slot = [orgId, ticket.id, (req.user && req.user.id) || '', email.toLowerCase()].join('|');
    if (sendsInFlight.has(slot)) {
      slot = null;
      return res.status(409).json({ error: MSG.justSent, code: 'just_sent' });
    }
    sendsInFlight.add(slot);

    const { input, built } = await buildReport(req, ticket, includeNotes);
    if (!input.tasks.length) return res.status(422).json({ error: MSG.noBuildings });

    const id = svc.genId('rshare');
    const token = shares.genToken();
    const expires = shares.expiryFrom(days).toISOString();
    const userId = (req.user && req.user.id) || null;

    const client = await pool.connect();
    let refusal = null;
    try {
      await client.query('BEGIN');
      try {
        const locked = await client.query(
          'SELECT status, archived_at FROM service_tickets WHERE id = $1 AND organization_id = $2 FOR UPDATE',
          [ticket.id, orgId]
        );
        const row = locked.rows[0];
        if (!row) refusal = [404, { error: TICKET_NOT_FOUND }];
        else if (row.archived_at) refusal = [409, { error: MSG.archived }];
        else if (printSvc.APPROVED_STATUSES.indexOf(row.status) < 0) refusal = [409, { error: MSG.notApproved }];
        if (!refusal) {
          const recent = await client.query(
            `SELECT id FROM report_shares
              WHERE service_ticket_id = $1 AND organization_id = $2 AND created_by = $3
                AND LOWER(COALESCE(recipient_email, '')) = $4 AND revoked_at IS NULL
                AND created_at >= NOW() - ${RESEND_WINDOW}`,
            [ticket.id, orgId, userId, email.toLowerCase()]
          );
          const recentIds = recent.rows.map(function (r) { return r.id; });
          const retry = await onlyFailedEmails(client, ticket, email, recentIds);
          if (recentIds.length && !retry) refusal = [409, { error: MSG.justSent, code: 'just_sent' }];
        }
        if (refusal) {
          await client.query('ROLLBACK');
        } else {
          await client.query(
            `INSERT INTO report_shares
               (id, organization_id, report_id, service_ticket_id, entity_type, entity_id, token_hash,
                scope, hide_financials, document, recipient_email, recipient_name,
                expires_at, view_count, created_by, created_at)
             VALUES ($1, $2, NULL, $3, 'service_ticket', $4, $5, 'view', TRUE, $6, $7, $8, $9, 0, $10, NOW())`,
            [id, ticket.organization_id, ticket.id, String(ticket.id), shares.hashToken(token),
             JSON.stringify(built.document), email || null, name || null, expires, userId]
          );
          await client.query('COMMIT');
        }
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* the throw below is the news */ }
        throw e;
      }
    } finally {
      client.release();
    }
    if (refusal) return res.status(refusal[0]).json(refusal[1]);

    const link = baseUrl(req) + '/r/' + encodeURIComponent(token);

    // After COMMIT: the email. It goes to a person outside the company, so
    // notification preferences do not apply (the same choice report shares
    // make), and it is tracked so a deploy lets it finish.
    let sent = { ok: false, skipped: 'no-recipient' };
    if (email) {
      const mail = require('../email');
      if (mail.isEnabled()) {
        sent = await inflight.track(sendReportEmail(req, {
          ticket, site: input.site, orgName: input.orgName, email, name, link, days,
        }), 'ticket_completion_report_email');
        sent = sent || { ok: false, error: 'error' };
      } else {
        sent = { ok: false, skipped: 'email-disabled' };
      }
    }

    const s = built.summary;
    await workOrder.insertEvent(pool, ticket, 'completion_report_sent', actorOf(req), {
      report_share_id: id,
      emailed: !!sent.ok,
      buildings: s.buildings_total,
      photos: s.before_photos + s.completion_photos,
      notes_included: !!s.notes_included,
    });

    res.json({
      ok: true,
      share: { id, recipient_email: email || null, recipient_name: name || null, expires_at: expires, state: 'sent' },
      link,
      email_sent: !!sent.ok,
      email_error: sent.ok ? null : (sent.error || sent.skipped || null),
    });
  } catch (e) {
    console.error('[service-ticket-print] completion report send failed', e && e.message);
    if (!res.headersSent) res.status(500).json({ error: MSG.sendFailed });
  } finally {
    if (slot) sendsInFlight.delete(slot);
  }
});

// The property manager's email. Never throws: a failed send answers
// {ok:false, error} and the link is still returned to the office.
async function sendReportEmail(req, o) {
  try {
    const { sendEmail } = require('../email');
    const emailSender = require('../email-sender');
    const orgId = o.ticket.organization_id;
    const realOrgName = o.orgName || null;
    const orgName = realOrgName || 'Project 86';
    const title = notifyText.oneLine(o.ticket.title, 200) || 'Work order';
    const address = o.site && o.site.address ? notifyText.oneLine(o.site.address, 300) : '';
    const greet = o.name || 'there';
    const esc = notifyText.escHtml;
    const html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#222;max-width:540px;">' +
        '<p>Hi ' + esc(greet) + ',</p>' +
        '<p>' + esc(orgName) + ' has finished the work order <strong>' + esc(title) + '</strong>' +
          (address ? ' at ' + esc(address) : '') +
          ' and the work has been approved. The completion report has the before and completion photos for each building.</p>' +
        '<p style="margin:24px 0;"><a href="' + esc(o.link) + '" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;">View the completion report</a></p>' +
        '<p style="font-size:12px;color:#666;">No login needed. You can print it or save it as a PDF from the page. This link expires in ' + o.days + ' days.</p>' +
      '</div>';
    const textBody = 'Hi ' + greet + ',\n\n' +
      orgName + ' has finished the work order ' + title + (address ? ' at ' + address : '') +
      ' and the work has been approved. The completion report has the before and completion photos for each building.\n\n' +
      'View the completion report (no login needed):\n' + o.link + '\n\n' +
      'You can print it or save it as a PDF from the page. This link expires in ' + o.days + ' days.';
    const replyTo = await emailSender.replyToForUser(pool, req.user && req.user.id, orgId);
    const result = await sendEmail({
      to: o.email,
      subject: notifyText.oneLine(orgName + ': completion report for ' + title, 250),
      html,
      text: textBody,
      tag: 'service_ticket_completion_report',
      organizationId: orgId,
      senderOrg: realOrgName ? { id: orgId, name: realOrgName } : { id: orgId },
      replyTo: replyTo || false,
    });
    return result || { ok: false, error: 'error' };
  } catch (e) {
    console.warn('[service-ticket-print] completion report email failed', e && e.message);
    return { ok: false, error: (e && e.message) || 'error' };
  }
}

// ── B9: turn a completion report link off ────────────────────────────────
router.post('/:id/completion-report/shares/:sid/revoke', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
    const sid = String(req.params.sid || '');
    if (!SHARE_ID_RE.test(sid)) return res.status(404).json({ error: MSG.linkGone });
    const { rows } = await pool.query(
      `UPDATE report_shares SET revoked_at = NOW()
        WHERE id = $1 AND service_ticket_id = $2 AND organization_id = $3 AND revoked_at IS NULL
        RETURNING id`,
      [sid, ticket.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: MSG.linkGone });
    await workOrder.insertEvent(pool, ticket, 'completion_report_link_off', actorOf(req), { report_share_id: rows[0].id });
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('[service-ticket-print] revoke failed', e && e.message);
    res.status(500).json({ error: MSG.revokeFailed });
  }
});

module.exports = router;
