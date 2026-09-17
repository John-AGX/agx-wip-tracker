// NOTIFY AGAIN — the office's button on a work order whose "ready for
// approval" notice did not reach anyone.
//
//   POST /api/service-tickets/:id/notify-approvers
//
// The office banner (js/work-order-notices.js) shows "Nobody has been told this
// is ready for approval." once the notice cron has given up, or "…Trying again
// automatically." while it retries. This door sends the notice now, through
// the SAME function every other arrival uses
// (services/service-ticket-notify.js notifyAwaitingApproval, reason
// 'notify_again'), so the 15-minute claim keeps a click, a cron retry and a
// crew arrival from announcing the same ticket twice. It never falls back to
// the company admins: the person clicking already knows.
//
// WHY ITS OWN ROUTER. service-ticket-routes.js is edited by several units at
// once; one small file mounted at the same prefix right after it
// (server/index.js) keeps this door out of that traffic. The access rule is not
// copied: it is services/service-ticket-access.js, translated to HTTP exactly
// the way service-ticket-routes.js ticketAccessOk does.
//
// TENANCY. The ticket is loaded with `id = $1 AND organization_id = $2`, the
// org taken from the caller (requireOrgId), never from the body; a missing or
// foreign id and a job the caller is not on answer the same 404, never a 403
// that would confirm the ticket exists. Every statement the notice runs is
// predicated on the loaded row's organization_id.
//
// The body is ignored. The send is awaited (tracked by services/inflight.js so
// a deploy lets it finish) because the button shows what happened.
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireOrgId } = require('../auth');
const access = require('../services/service-ticket-access');
const inflight = require('../services/inflight');
const ticketNotify = require('../services/service-ticket-notify');
const { NOTICE_TICKET_COLS } = require('../services/work-order-recipients');

const router = express.Router();

const TICKET_NOT_FOUND = 'Service ticket not found';
const NOT_WAITING = "This work order isn't waiting for approval.";

const MESSAGES = Object.freeze({
  already_notified: 'Already sent in the last 15 minutes.',
  no_recipients: 'No one else who can approve this work order has these notices turned on.',
  failed: "The notice didn't go through. It will be tried again automatically.",
});

function messageFor(result) {
  const r = result || {};
  const sent = Number(r.sent) || 0;
  if (sent > 0) return sent === 1 ? 'Told 1 person.' : 'Told ' + sent + ' people.';
  if (r.skipped === 'already_notified') return MESSAGES.already_notified;
  if (r.skipped === 'no_recipients') return MESSAGES.no_recipients;
  return MESSAGES.failed;
}

router.post('/:id/notify-approvers', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const { rows } = await pool.query(
      `SELECT ${NOTICE_TICKET_COLS} FROM service_tickets WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
      [String(req.params.id), orgId]
    );
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });

    const verdict = await access.mayAccessTicketParent({
      query: (sql, params) => pool.query(sql, params),
      user: req.user,
      parent: ticket,
      mode: 'write',
      orgId,
    });
    if (!verdict || verdict.ok !== true) {
      const reason = verdict && verdict.reason;
      if (reason === 'not_assigned') return res.status(404).json({ error: TICKET_NOT_FOUND });
      if (reason === 'no_capability') {
        const caps = access.capsForParentKind(access.parentOf(ticket).kind, 'write');
        return res.status(403).json({ error: 'Missing capability: ' + caps.join(' ') });
      }
      return res.status(403).json({ error: 'You do not have access to this service ticket' });
    }

    if (ticket.status !== 'work_complete') return res.status(409).json({ error: NOT_WAITING });

    const result = await inflight.track(ticketNotify.notifyAwaitingApproval(pool, {
      ticket,
      actor: { kind: 'user', userId: (req.user && req.user.id) || null, label: (req.user && req.user.name) || null },
      reason: 'notify_again',
      fallbackToAdmins: false,
    }), 'ticket_approval_notify_again');
    const r = result || { sent: 0, recipients: 0, skipped: 'error' };
    res.json({
      ok: true,
      sent: Number(r.sent) || 0,
      recipients: Number(r.recipients) || 0,
      skipped: r.skipped || null,
      message: messageFor(r),
    });
  } catch (e) {
    console.error('[work-order-notice] notify-approvers failed', e && e.message);
    res.status(500).json({ error: 'Failed to send the notice' });
  }
});

module.exports = router;
