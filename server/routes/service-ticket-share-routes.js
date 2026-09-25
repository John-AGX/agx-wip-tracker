// Service-ticket share links — both doors in one file, the way
// task-share-routes.js and report-share-routes.js keep them, so the owner side
// and the public side of one credential can be read together.
//
//   PM-side (requireAuth + the ticket's inherited capability):
//     POST   /api/service-tickets/:id/share                       mint
//     GET    /api/service-tickets/:id/shares                      list
//     POST   /api/service-tickets/:id/shares/:sid/revoke
//     GET    /api/service-tickets/:id/revisions                   the inbox
//     POST   /api/service-tickets/:id/revisions/:rid/accept
//     POST   /api/service-tickets/:id/revisions/:rid/reject
//     GET    /api/service-tickets/:id/participants                internal users
//     POST   /api/service-tickets/:id/participants
//     DELETE /api/service-tickets/:id/participants/:userId
//
//   PUBLIC (no auth — the token IS the credential):
//     GET    /api/service-ticket-share/:token
//     GET    /api/service-ticket-share/:token/takeoff             the takeoff file
//     PATCH  /api/service-ticket-share/:token                     field report
//     POST   /api/service-ticket-share/:token/photo
//     POST   /api/service-ticket-share/:token/revision            propose
//
//   FLAG A PROBLEM (1.29) — declared in service-ticket-flag-routes.js and
//   registered onto THIS router at the bottom of the file, so they share its
//   mount and its token loader:
//     POST   /api/service-ticket-share/:token/flag                 raise (public)
//     POST   /api/service-ticket-share/:token/flags/:flagId/photo  one photo (public)
//     POST   /api/service-tickets/:id/flags/:flagId/resolve        the office resolves
//
// THE THREE SCOPES, and why there is no fourth. 'view' reads. 'respond' files a
// FIELD REPORT — a note, a photo, a checklist tick, a forward-only status move
// — every one of which is something the holder OWNS: their work, their
// observation, their photograph. 'propose' submits a REVISION, which lands in
// a quarantine table and never touches the ticket.
//
// There is deliberately NO 'edit'. A bearer token has no identity — nothing
// distinguishes the person you sent the link to from whoever they forwarded it
// to — so a direct edit could not be attributed, audited or undone against a
// subject. "Editing potential from the share screen" is delivered by 'propose'
// instead: the guest really does type into the scope and press Save, and what
// they get is a proposal with their name on it. That is also what "revise"
// means.
//
// INTERNAL USERS ARE NOT SHARES. The participant routes above mint no token,
// ever. A token would bypass an employee's own role, survive their
// deactivation, and be forwardable outside the company.
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
const { pipeline, finished } = require('stream/promises');
const { pool } = require('../db');
const { requireAuth, requireOrgId } = require('../auth');
const { callerOrgId } = require('../org-access');
const { sendEmail, isEnabled: emailIsEnabled } = require('../email');
const multer = require('multer');
const sharp = require('sharp');
const { sniffMimeFromBytes, sanitizeSvg, mimeFamilyMatches, HEIC_REFUSAL, isHeicUpload } = require('../util/attachment-mime');
const { storage } = require('../storage');
const { stShareIpLimiter, stShareViewLimiter, stShareWriteLimiter, stSharePropose } = require('../rate-limit');

// Memory storage: the buffer is sniffed and resized before anything is stored,
// so it must never touch disk under its claimed name first.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const { resolveEntityLabels } = require('../services/entity-labels');
const { attachmentInOrg } = require('../services/attachment-org-scope');
const svc = require('../services/service-tickets');
const access = require('../services/service-ticket-access');
const workOrder = require('../services/service-ticket-workorder');
const ticketNotify = require('../services/service-ticket-notify');
const review = require('../services/work-order-review');
const uploadDedupe = require('../services/upload-dedupe');
const inflight = require('../services/inflight');
const subtaskDoor = require('../services/service-ticket-subtask-door');
// Phase 3: a work order billed after the work is not finished without time,
// and its crew link shows the time and materials that link sent.
const fieldCaptureSvc = require('../services/service-ticket-field-capture');
const flagSvc = require('../services/service-ticket-flags');
const { formatInTz } = require('../timezone');

// What a crew phone is told when a photo upload fails before the handler sees
// it. A bad signal cuts uploads off part way, and the page retries those; a
// photo over the size cap will never go, so it says what to do instead.
const PHOTO_TOO_LARGE = "That photo is over 50 MB and can't be sent. Take it again, or pick a smaller photo.";
const PHOTO_CUT_OFF = 'The upload was cut off before it finished. Try again.';
const PHOTO_UNREADABLE = "That photo couldn't be read. Take it again, or pick a different photo.";

// The one-photo body parser for the crew photo doors. The library's own errors
// would reach express's error handler as a 500 with no words a crew member can
// act on; here the size cap is a 413 and any other parse failure (a body cut
// off by a dropped connection) is a 408 the page retries.
const singlePhoto = upload.single('file');
function multerOnePhoto(req, res, next) {
  singlePhoto(req, res, function (err) {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: PHOTO_TOO_LARGE });
    return res.status(408).json({ error: PHOTO_CUT_OFF });
  });
}

const router = express.Router();

// WHO MAY ACT ON A TICKET is decided by services/service-ticket-access.js —
// the same call service-ticket-routes.js makes. This file used to hold its own
// copy of the capability strings, and the copy had the same hole the original
// did: JOBS_VIEW_ASSIGNED / JOBS_EDIT_OWN were accepted without ever asking
// whether the job was the caller's, so a crew lead granted one job could mint a
// share link, accept a guest's revision or add participants on every job's
// tickets. A rule held in two files is a rule that drifts; now neither holds it.
//
// Only the HTTP translation of a refusal lives here:
//   not_assigned  -> 404 'Service ticket not found', the body a missing ticket
//                    gets, so an in-org user cannot learn which tickets exist
//                    on jobs they are not on.
//   no_capability -> 403 naming the capabilities.
//   anything else -> 403 — a request that cannot be authorized is refused.
// A false return means the response is already written.
async function ticketAccessOk(req, res, ticket, mode, orgId) {
  const verdict = await access.mayAccessTicketParent({
    // An arrow, not pool.query bare: node-pg's query needs its `this`.
    query: (sql, params) => pool.query(sql, params),
    user: req.user,
    parent: ticket,
    mode,
    orgId,
  });
  if (verdict && verdict.ok === true) return true;
  const reason = verdict && verdict.reason;
  if (reason === 'not_assigned') {
    res.status(404).json({ error: 'Service ticket not found' });
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
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

    // A link is a promise; a draft is not one. A terminal ticket is finished.
    const shareable = svc.ticketMayBeShared(ticket);
    if (!shareable.ok) return res.status(409).json({ error: shareable.reason });

    const body = req.body || {};
    // All three scopes now have doors, so the caller's choice is honoured —
    // through normalizeScope, so an unrecognised value NARROWS to 'view'
    // rather than being taken at its word. The S5 clamp that held 'propose'
    // down to 'respond' is lifted here because its door (T4) now exists; the
    // clamp was what stopped a link outrunning the routes that would honour it.
    const scope = svc.normalizeScope(body.scope);
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
        // Sent as the company ("AG Exteriors via Project 86"), and a reply from
        // the crew reaches the office user who sent the link — their FRESH users
        // row in this org, never the JWT's email and never anything typed on the
        // form. Required here, not at the top: the link is the deliverable, and a
        // sender helper that fails to load must not fail the mint.
        const emailSender = require('../email-sender');
        const replyTo = await emailSender.replyToForUser(pool, (req.user && req.user.id) || null, orgId);
        const expiresLabel = new Date(expires).toDateString();
        const result = await sendEmail({
          to: email,
          subject: 'Work order: ' + (ticket.title || 'Service ticket'),
          html:
            '<p>' + escHtml(name || 'Hello') + ',</p>' +
            '<p>A work order has been shared with you' +
            (label ? ' for <strong>' + escHtml(label) + '</strong>' : '') + '.</p>' +
            '<p><a href="' + escHtml(link) + '">Open the work order</a></p>' +
            '<p style="color:#666;font-size:12px;">This link expires ' +
            escHtml(expiresLabel) + '. Anyone with the link can open it.</p>',
          text:
            (name || 'Hello') + ',\n\n' +
            'A work order has been shared with you' + (label ? ' for ' + label : '') + '.\n\n' +
            'Open the work order: ' + link + '\n\n' +
            'This link expires ' + expiresLabel + '. Anyone with the link can open it.',
          tag: 'service_ticket_share',
          senderOrg: { id: orgId },
          organizationId: orgId,
          replyTo: replyTo || false,
        });
        // sendEmail reports a failed send in its result rather than throwing,
        // so "sent" is read from the answer — the office was told a link went
        // out when the provider had refused it.
        emailSent = !!(result && result.ok);
        if (!emailSent) emailError = (result && result.error) || 'Email failed';
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
      'SELECT ' + SHARE_COLS + ' FROM service_ticket_shares WHERE id = $1 AND organization_id = $2', [id, orgId]);
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
    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;

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
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

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

// ── A11: the revisions inbox ────────────────────────────────────────────
router.get('/service-tickets/:id/revisions', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });
    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;

    // EVERY column here is qualified with its table alias. The query below
    // LEFT JOINs service_ticket_shares, and BOTH tables have `ticket_id` and
    // `organization_id` — unqualified, Postgres refuses the whole statement as
    // an ambiguous column reference and this route answers 500 for every
    // caller. It did, in production: the predicate was written for a
    // single-table query and did not get re-qualified when the join was added.
    // Source-level tests asserted the join and the flag were present, which
    // they were; nothing there can notice that the SQL will not parse.
    const params = [ticket.id, orgId];
    let where = 'r.ticket_id = $1 AND r.organization_id = $2';
    if (req.query.status) { params.push(String(req.query.status)); where += ' AND r.status = $3'; }

    // The share is LEFT JOINed so a revision that arrived through a link the
    // office has since revoked still lists — with its link marked off. Losing
    // the proposal because the link was turned off would be the wrong
    // behaviour: the suggestion is still a suggestion.
    const { rows } = await pool.query(
      `SELECT r.id, r.share_id, r.proposed_by_user_id, r.author_label, r.fields,
              r.note, r.status, r.resolved_by, r.resolved_at, r.resolution_note,
              r.created_at,
              (s.id IS NOT NULL AND s.revoked_at IS NOT NULL) AS via_revoked_link
         FROM service_ticket_revisions r
         LEFT JOIN service_ticket_shares s ON s.id = r.share_id AND s.organization_id = r.organization_id
        WHERE ${where}
        ORDER BY r.created_at DESC LIMIT 100`,
      params
    );
    res.json({ revisions: rows });
  } catch (e) {
    console.error('[service-ticket-share] revisions list failed', e);
    res.status(500).json({ error: 'Failed to load the suggestions' });
  }
});

// ── A12: accept (all or a subset) ───────────────────────────────────────
router.post('/service-tickets/:id/revisions/:rid/accept', requireAuth, requireOrgId, async (req, res) => {
  const client = await pool.connect();
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

    await client.query('BEGIN');
    // Re-read under the transaction, pinned to pending. A second accept is a
    // 404, not a re-apply — idempotent by the predicate rather than by a flag
    // someone has to remember to check.
    const rr = await client.query(
      `SELECT * FROM service_ticket_revisions
        WHERE id = $1 AND ticket_id = $2 AND organization_id = $3 AND status = 'pending'
        FOR UPDATE`,
      [req.params.rid, ticket.id, orgId]
    );
    if (!rr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Suggestion not found' }); }
    const rev = rr.rows[0];

    // RE-FILTERED AT APPLY TIME, never trusting what was stored. Emit-time and
    // apply-time validation must not drift — a row written by an older or
    // compromised path cannot widen what it may set.
    const stored = (rev.fields && typeof rev.fields === 'object') ? rev.fields : {};
    // body.fields narrows FURTHER, so "take the new scope, ignore the date
    // they suggested" is one click.
    const accepted = svc.filterProposedFields(stored, Array.isArray(req.body && req.body.fields) ? req.body.fields : null);
    if (!Object.keys(accepted).length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nothing was selected to accept.' });
    }

    const sets = [];
    const params = [];
    for (const k of Object.keys(accepted)) {
      params.push(accepted[k] === '' ? null : accepted[k]);
      sets.push(k + ' = $' + params.length);
    }
    params.push(ticket.id, orgId);
    const up = await client.query(
      `UPDATE service_tickets SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length - 1} AND organization_id = $${params.length}
      RETURNING *`,
      params
    );
    if (!up.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Service ticket not found' }); }

    await client.query(
      `UPDATE service_ticket_revisions
          SET status = 'accepted', resolved_by = $1, resolved_at = NOW(), resolution_note = $2
        WHERE id = $3 AND organization_id = $4`,
      [(req.user && req.user.id) || null, String((req.body || {}).note || '').slice(0, 1000) || null,
       rev.id, orgId]
    );

    // Other PENDING proposals touching the same fields are marked superseded
    // rather than left to conflict — otherwise accepting one silently makes
    // the others wrong and nobody is told.
    const keys = Object.keys(accepted);
    await client.query(
      `UPDATE service_ticket_revisions
          SET status = 'superseded', resolved_at = NOW()
        WHERE ticket_id = $1 AND organization_id = $2 AND status = 'pending' AND id <> $3
          AND EXISTS (SELECT 1 FROM jsonb_object_keys(fields) k WHERE k = ANY($4::text[]))`,
      [ticket.id, orgId, rev.id, keys]
    );
    await client.query('COMMIT');

    await logEvent(up.rows[0], 'revision_accepted', {
      actorUserId: (req.user && req.user.id) || null,
      detail: { fields: keys, from_revision: rev.id },
    });
    res.json({ ok: true, ticket: up.rows[0], accepted_fields: keys });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[service-ticket-share] accept failed', e);
    res.status(500).json({ error: 'Failed to accept the suggestion' });
  } finally {
    client.release();
  }
});

// ── A13: reject ─────────────────────────────────────────────────────────
router.post('/service-tickets/:id/revisions/:rid/reject', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

    const { rows } = await pool.query(
      `UPDATE service_ticket_revisions
          SET status = 'rejected', resolved_by = $1, resolved_at = NOW(), resolution_note = $2
        WHERE id = $3 AND ticket_id = $4 AND organization_id = $5 AND status = 'pending'
      RETURNING id`,
      [(req.user && req.user.id) || null, String((req.body || {}).note || '').slice(0, 1000) || null,
       req.params.rid, ticket.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Suggestion not found' });
    await logEvent(ticket, 'revision_rejected', {
      actorUserId: (req.user && req.user.id) || null,
      detail: { revision: req.params.rid },
    });
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('[service-ticket-share] reject failed', e);
    res.status(500).json({ error: 'Failed to reject the suggestion' });
  }
});

// ── A14-A16: internal participants ──────────────────────────────────────
// NOT A SHARE. No token is minted here, ever — see the table comment in db.js.
router.get('/service-tickets/:id/participants', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });
    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;
    const { rows } = await pool.query(
      `SELECT p.id, p.user_id, p.access_level, p.added_by, p.created_at,
              u.name AS user_name, u.email AS user_email
         FROM service_ticket_participants p
         LEFT JOIN users u ON u.id = p.user_id AND u.organization_id = p.organization_id
        WHERE p.ticket_id = $1 AND p.organization_id = $2
        ORDER BY p.created_at ASC`,
      [ticket.id, orgId]
    );
    res.json({ participants: rows });
  } catch (e) {
    console.error('[service-ticket-share] participants list failed', e);
    res.status(500).json({ error: 'Failed to load the people on this ticket' });
  }
});

router.post('/service-tickets/:id/participants', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

    const userId = Number((req.body || {}).user_id);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'A user is required' });
    // PROVED in-org: a body-supplied user id only proves the user exists, not
    // whose they are. Same rule as assigneeOk on tasks.
    const u = await pool.query('SELECT 1 FROM users WHERE id = $1 AND organization_id = $2', [userId, orgId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });

    const level = String((req.body || {}).access_level || 'view') === 'edit' ? 'edit' : 'view';
    const id = svc.genId('stpart');
    const { rows } = await pool.query(
      `INSERT INTO service_ticket_participants (id, organization_id, ticket_id, user_id, access_level, added_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (ticket_id, user_id) DO UPDATE SET access_level = EXCLUDED.access_level
       RETURNING id, user_id, access_level, created_at`,
      [id, orgId, ticket.id, userId, level, (req.user && req.user.id) || null]
    );
    res.json({ ok: true, participant: rows[0] });
  } catch (e) {
    console.error('[service-ticket-share] add participant failed', e);
    res.status(500).json({ error: 'Failed to add them' });
  }
});

router.delete('/service-tickets/:id/participants/:userId', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
    const { rows } = await pool.query(
      `DELETE FROM service_ticket_participants
        WHERE ticket_id = $1 AND user_id = $2 AND organization_id = $3 RETURNING id`,
      [ticket.id, Number(req.params.userId), orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not on this ticket' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[service-ticket-share] remove participant failed', e);
    res.status(500).json({ error: 'Failed to remove them' });
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

// ── The takeoff file on the crew link (John, 2026-09-13) ────────────────
// The office picks ONE file on the ticket's job, lead or estimate
// (PUT /api/service-tickets/:id/crew-takeoff) and the link offers it. This
// helper is the whole decision of whether it still may, and T1 and the file
// door both ask it, so the card on the page and the bytes behind it cannot
// disagree.
//
// THE PRICE-FREE COPY (John, 2026-09-14). A spreadsheet is never served as
// the original file on a link that hides financials (the default). No check
// of a sheet's columns can promise a priced sheet is caught, so there is no
// check: such a link gets a GENERATED xlsx holding only material, quantity and
// unit, built from the lines the office's PUT read out of the file with the
// extractor that fills the Materials list (crew_takeoff.copy.lines). The
// original goes only to a link sent with financial details. A PDF or photo is
// served as itself on every link, as before — the office confirms it.
//
// A NAME IS ONLY A CLAIM (review, 2026-09-14). A priced workbook that reached
// the job as "Smith bid.pdf" is a "pdf" to takeoffKind, and this helper reads
// no byte of the file. Three things keep its bytes off a link that hides
// financials:
//   * the office's PUT proves a PDF or photo from its bytes when it is picked,
//     and stores a workbook found behind the name as the spreadsheet it is
//     (service-ticket-routes.js, kindFromBytes) — so it gets the copy here;
//   * a row stored before copies whose own byte check found prices
//     (has_prices true) is a spreadsheet here whatever kind it names — that
//     check sniffed the bytes, so its "pdf" is not a PDF;
//   * the takeoff door reads the first bytes before it sends anything, and on
//     such a link refuses an original they do not prove (bytesProveOriginal).
// The CARD is not held to that third check, deliberately: proving the bytes
// here would open the file in storage on every read of the work order, for
// every PDF takeoff, to catch only a row picked before the PUT proved bytes.
// Such a row can show a card whose door answers the no-takeoff 404 — never the
// file. The door is the gate; no original leaves on a default link unproved.
//
// Returns { att, takeoff, copyLines } or null. copyLines is null when the
// ORIGINAL is served, else the lines the copy is built from; takeoff is the
// card's whitelist, with filename left null on the copy path (the builder
// names the copy — see crewTakeoffCard). null when:
//   * nothing was chosen — the default;
//   * this link hides financials and the file is a SPREADSHEET by the kind
//     stored OR the kind the file has now (anything but exactly 'pdf' or
//     'image' on both counts is a spreadsheet here, so a hand-written row or
//     a PDF renamed to .xlsx narrows) and there are no copy lines: a copy the
//     PUT could not make (copy null) or a row stored before copies existed
//     (has_prices and no copy). Fail closed until the office picks it again.
//     Decided on the stored row BEFORE any lookup, and again on the file;
//   * the ORIGINAL would be served and the file is over the crew link's size
//     cap, or has no size to check — the door would refuse it, so the card is
//     never offered for it (the copy is not the file, and has no such cap);
//   * the file can no longer be proved to hang on THIS ticket's job, its lead
//     or its estimate. Deleted, re-parented to another job, or its parent in
//     another tenant — it stops showing without anyone touching crew_takeoff.
//     The COPY path proves this too, though it reads no byte of the file: a
//     copy of a file taken off the job is not the job's any more.
//
// NO CAPABILITY FILTER here, deliberately. The office already chose the file
// under its own capabilities through loadTicketFile; a token has no role to
// ask. What is re-proved on every read is only what can CHANGE after that
// choice: where the file hangs, and which tenant it is in. Every read carries
// the ticket's OWN organization_id, taken from the row loadTicketShare
// selected, never from the request.
const TAKEOFF_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// The only kinds a link that hides financials may be handed as the original
// file. An allowlist: every other kind — xlsx, xls, csv, a missing kind, a
// value no build ever wrote — gets the copy or nothing.
const ORIGINAL_ON_EVERY_LINK = new Set(['pdf', 'image']);

// The stored copy's lines, re-shaped through normalizeMaterials (three
// strings a line, at most 100) so a row written by hand or by a later build
// narrows to what the builder expects. [] when there is no usable copy.
function copyLinesOf(chosen) {
  const copy = chosen && chosen.copy;
  if (!copy || typeof copy !== 'object' || !Array.isArray(copy.lines)) return [];
  return svc.normalizeMaterials(copy.lines);
}

async function crewTakeoffFor(ticket, share) {
  let chosen = ticket ? ticket.crew_takeoff : null;
  if (typeof chosen === 'string') {
    try { chosen = JSON.parse(chosen); } catch (e) { return null; }
  }
  if (!chosen || typeof chosen !== 'object') return null;
  // A ROW STORED BEFORE COPIES whose byte check found prices. That check read
  // the bytes, not the name, so a workbook saved as "bid.pdf" was caught by it
  // and stored as {kind:'pdf', has_prices:true}. Its kind is not trusted: it is
  // dropped, which is a spreadsheet with no copy to a link that hides
  // financials (no card, no file) and changes nothing on a financial link.
  if (chosen.has_prices === true) chosen = Object.assign({}, chosen, { kind: null });
  const attachmentId = typeof chosen.attachment_id === 'string' ? chosen.attachment_id : '';
  if (!TAKEOFF_ID_RE.test(attachmentId)) return null;
  const hides = svc.hidesFinancials(share);
  // Only a link that hides financials ever gets the copy; a financial link
  // gets the original, so its lines are never looked at.
  const copyLines = hides ? copyLinesOf(chosen) : [];
  // The original may reach this link when the link shows financials, or the
  // file is a PDF or photo — by the kind STORED here, and by the kind the file
  // has now below, so a PDF renamed to .xlsx after it was chosen narrows too.
  const originalMayShow = (kind) => !hides || ORIGINAL_ON_EVERY_LINK.has(kind);
  // A spreadsheet with no copy on a default link: decided before any lookup.
  if (!originalMayShow(chosen.kind) && !copyLines.length) return null;

  const orgId = ticket.organization_id;
  if (orgId == null) return null;
  const clean = (v) => (v == null || v === '' ? null : String(v));
  const jobId = clean(ticket.job_id);
  let leadId = clean(ticket.lead_id);
  let estimateId = null;
  if (jobId) {
    const j = await pool.query(
      'SELECT lead_id, estimate_id FROM jobs WHERE id = $1 AND organization_id = $2',
      [jobId, orgId]
    );
    if (j.rows[0]) {
      if (!leadId) leadId = clean(j.rows[0].lead_id);
      estimateId = clean(j.rows[0].estimate_id);
    }
  }
  if (leadId) {
    const l = await pool.query('SELECT 1 FROM leads WHERE id = $1 AND organization_id = $2', [leadId, orgId]);
    if (!l.rows.length) leadId = null;
  }
  if (estimateId) {
    const s = await pool.query('SELECT 1 FROM estimates WHERE id = $1 AND organization_id = $2', [estimateId, orgId]);
    if (!s.rows.length) estimateId = null;
  }

  // THE PARENTS ARE IN THE WHERE — the same shape loadTicketFile uses on the
  // office side. A slot with no proved parent binds NULL and matches nothing.
  const { rows } = await pool.query(
    `SELECT id, entity_type, entity_id, organization_id, uploaded_by, filename,
            mime_type, size_bytes, original_key
       FROM attachments
      WHERE id = $1
        AND ((entity_type = 'job' AND entity_id = $2)
          OR (entity_type = 'lead' AND entity_id = $3)
          OR (entity_type = 'estimate' AND entity_id = $4))`,
    [attachmentId, jobId, leadId, estimateId]
  );
  const att = rows[0] || null;
  if (!att || !(await attachmentInOrg(pool, att, orgId))) return null;

  // The kind is read off the file as it is NOW, not as it was when chosen: a
  // file renamed to something that is not a takeoff stops being offered.
  const { takeoffKind, MAX_FILE_BYTES } = require('../services/materials-extract');
  const kind = takeoffKind(att.filename, att.mime_type);
  if (!kind) return null;

  if (!(originalMayShow(chosen.kind) && originalMayShow(kind))) {
    // THE COPY. Nothing about the original's bytes or size is needed: the
    // xlsx is built from the stored lines on the request that sends it.
    if (!copyLines.length) return null;
    return {
      att: att,
      copyLines: copyLines,
      // A whitelist, like publicTicket. The copy is always an xlsx; it has no
      // stored size (it is built per request), and `lines` is how many
      // material lines it holds. filename is the builder's — crewTakeoffCard.
      takeoff: { filename: null, kind: 'xlsx', size_bytes: null, copy: true, lines: copyLines.length },
    };
  }

  // THE ORIGINAL. THE SIZE CAP IS THE EXTRACTOR'S. MAX_FILE_BYTES is the one
  // number the office's PUT refuses a file over and this door will send, so
  // the office is never told a file is on the link that the crew can never
  // open. The stored size is NOT NULL on attachments; a row without a usable
  // one is not offered.
  const size = att.size_bytes == null ? NaN : Number(att.size_bytes);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) return null;
  return {
    att: att,
    copyLines: null,
    // A whitelist, like publicTicket: a name, a kind and a size. Never the
    // attachment id, a storage key or a URL — the bytes come through the token.
    takeoff: {
      filename: att.filename == null ? '' : String(att.filename),
      kind: kind,
      size_bytes: size,
      copy: false,
      lines: null,
    },
  };
}

// Build the price-free copy for a crewTakeoffFor answer on the copy path:
// { buffer, filename }. Required on call — exceljs is heavy, and the extractor
// module failing to load must cost one request, not this router. The source
// name is the file's name as it is NOW, the same name the original path shows.
// A builder that hands back no bytes is a failure, never an empty download.
async function buildCrewCopy(found) {
  const { buildMaterialsCopy } = require('../services/materials-extract');
  const built = await buildMaterialsCopy({
    lines: found.copyLines,
    sourceName: found.att.filename == null ? '' : String(found.att.filename),
  });
  const raw = built ? built.buffer : null;
  const buffer = Buffer.isBuffer(raw) ? raw
    : (raw instanceof Uint8Array || raw instanceof ArrayBuffer ? Buffer.from(raw) : null);
  if (!buffer || !buffer.length) throw new Error('the materials copy came back empty');
  const filename = built && typeof built.filename === 'string' && built.filename.trim()
    ? built.filename : 'Materials.xlsx';
  return { buffer, filename };
}

// The card T1 shows for a crewTakeoffFor answer. On the copy path the name is
// the one the door's download will carry, so it comes from the same builder.
async function crewTakeoffCard(found) {
  if (!found) return null;
  if (!found.copyLines) return found.takeoff;
  const built = await buildCrewCopy(found);
  return Object.assign({}, found.takeoff, { filename: built.filename });
}

// What the takeoff door sends for each kind. An allowlist: nothing the
// uploader claimed reaches Content-Type. A photo's type comes from its bytes,
// and a PDF must start like one, so a file named takeoff.pdf holding HTML is
// served as an opaque download rather than rendered.
const TAKEOFF_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv; charset=utf-8',
};
const OPAQUE = 'application/octet-stream';

function takeoffContentType(kind, buf) {
  if (kind === 'pdf') {
    return buf.length >= 5 && buf.subarray(0, 1024).indexOf('%PDF-') !== -1 ? 'application/pdf' : OPAQUE;
  }
  if (kind === 'image') {
    const b = buf;
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
    if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
    if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    return OPAQUE;
  }
  return TAKEOFF_TYPES[kind] || OPAQUE;
}

// THE BYTES PROVE THE NAME — asked by the takeoff door, on a link that hides
// financials, before any header or byte of an ORIGINAL is sent. crewTakeoffFor
// has let the original through only because the stored kind and the file's
// name both say PDF or photo; this is the first time anything looks at what
// the file IS. `head` is the first TAKEOFF_SNIFF_BYTES of it (all of it, when
// smaller). True only when:
//   * materials-extract's sniffKind — magic bytes first, the rule the office's
//     PUT proved the file by — says the same kind the name does. A zip or OLE
//     container is recognised before any PDF or photo test, so a workbook can
//     never pass as either, whatever text sits in its first bytes;
//   * and the door would send it as a real PDF or photo type, not the opaque
//     fallback. The one exception is a HEIC/HEIF photo: sniffKind proves it
//     from its ftyp brand, but browsers have no type for it here, so it goes
//     out as an opaque download. Its bytes are still a photo's.
// Anything else — a workbook, a CSV or an HTML page under a PDF's or photo's
// name, a photo under a PDF's name — is refused as if nothing were chosen.
function bytesProveOriginal(kind, head, att) {
  if (kind !== 'pdf' && kind !== 'image') return false;
  const { sniffKind } = require('../services/materials-extract');
  if (sniffKind(head, att.filename, att.mime_type) !== kind) return false;
  if (takeoffContentType(kind, head) !== OPAQUE) return true;
  return kind === 'image';
}

// Content-Disposition with a filename a header cannot be broken by: the plain
// `filename` is printable ASCII with quotes, backslashes and every control
// character (a CR/LF would end the header) replaced, and `filename*` carries
// the real name RFC 5987-encoded for browsers that read it.
function takeoffDisposition(type, filename) {
  const name = String(filename == null ? '' : filename).replace(/[\u0000-\u001F\u007F]/g, ' ').trim() || 'takeoff';
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').replace(/\s+/g, ' ').slice(0, 150).trim() || 'takeoff';
  const encoded = encodeURIComponent(name.slice(0, 150))
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return type + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded;
}

// A read the crew page can live without: its failure is logged and answered
// with the fallback, so it never fails the work order.
async function bestEffort(label, work, fallback) {
  try {
    return await work();
  } catch (e) {
    console.error('[service-ticket-share] ' + label + ' lookup failed', e && e.message);
    return fallback;
  }
}

// finish: { can_undo } for T1. True only while the ticket is at Work complete
// and the newest status event is THIS link's own "Finish whole work order" —
// the same rule the PATCH undo path enforces under the lock, so the button the
// page shows and the door behind it cannot disagree (except for a race, which
// the door answers with finish_not_yours).
async function crewFinishState(ticket, share) {
  if (svc.normalizeStatus(ticket.status) !== 'work_complete') return { can_undo: false };
  if (!svc.scopeAllows(share.scope, 'respond')) return { can_undo: false };
  return bestEffort('finish state', async () => {
    const last = await workOrder.lastStatusEvent(pool, ticket);
    return { can_undo: svc.crewMayUndoFinish(ticket.status, last, share.id).ok === true };
  }, { can_undo: false });
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
          WHERE id = $1 AND organization_id = $2`, [share.id, ticket.organization_id]
      ).catch(function () { /* a stat is not worth failing a read over */ });
      if (!share.opened_at) {
        logEvent(ticket, 'share_opened', {
          actorKind: 'share', shareId: share.id,
          actorLabel: share.recipient_name || share.recipient_email || null,
        });
      }

      // Child reads carry the ticket's OWN organization_id — taken from the
      // row already in hand, never from the request.
      //
      // ORG TASKS ONLY. A personal to-do can hang off a ticket, and it is its
      // owner's alone — the authed detail door shows one only to that owner.
      // A bearer token has no owner to match, so the only honest arm left is
      // `scope = 'org'`; without it, sharing a work order sent the titles of
      // a PM's private to-dos to whoever holds the link.
      const tasks = await pool.query(
        `SELECT id, title, status, due_date, completed_at, kind FROM tasks
          WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL
            AND scope = 'org'
          ORDER BY created_at ASC`,
        [ticket.id, ticket.organization_id]
      );

      // The work-order view (John, 2026-09-13): where the work is, who to call
      // (the person who SENT this link, else whoever raised the ticket), and
      // each subtask's photos, notes and who finished it. Money-free by
      // construction — see services/service-ticket-workorder.js.
      const [orgName, parentLabel, site, contact, photosByTask, activity] = await Promise.all([
        orgNameFor(ticket.organization_id),
        parentLabelFor(ticket),
        workOrder.workOrderSite(pool, ticket),
        workOrder.workOrderContact(pool, ticket.organization_id, [share.created_by, ticket.created_by]),
        workOrder.taskPhotosByTask(pool, ticket.organization_id, tasks.rows.map((t) => t.id)),
        workOrder.subtaskActivity(pool, ticket.organization_id, ticket.id),
      ]);

      // 1.29 additions, each BEST-EFFORT like the takeoff card below: a failed
      // lookup costs the crew that one piece, never the work order.
      //
      //   finish      whether THIS link may still take back its own "Finish
      //               whole work order" (services/service-tickets.js
      //               crewMayUndoFinish over the newest status event).
      //   site_photos the work order's field-report photos, as a crew
      //               whitelist: no filename, no original_url, no uploader id,
      //               and `by` never names someone in the office.
      //   send_back   the office's reason for sending the work back, shown on
      //               every link until the next arrival at Work complete. No
      //               user id, no name, no cancel reason (a cancel is never a
      //               send-back), and nothing added to publicTicket.
      const [finish, sitePhotos, sendBack] = await Promise.all([
        crewFinishState(ticket, share),
        bestEffort('site photos', async () => {
          const photos = await workOrder.ticketSitePhotos(pool, ticket.organization_id, ticket.id, { withNames: false });
          return photos.map(function (p) {
            return { id: p.id, thumb_url: p.thumb_url, web_url: p.web_url, uploaded_at: p.uploaded_at, by: p.by };
          });
        }, []),
        bestEffort('send-back banner', () => review.activeSendBack(pool, ticket, tasks.rows), null),
      ]);

      // The takeoff card, when the office chose a file this link may show.
      // Best-effort like the stats above: a failed lookup, or a copy that
      // would not build, costs the crew the card, never the work order.
      let takeoff = null;
      try {
        takeoff = await crewTakeoffCard(await crewTakeoffFor(ticket, share));
      } catch (e) {
        console.error('[service-ticket-share] takeoff lookup failed', e && e.message);
      }

      // Problems flagged on this work order (1.29): open ones, and ones the
      // office resolved in the last 14 days, as the crew whitelist
      // (flagSvc.publicFlag — no link id, no resolver, no client ref). Every
      // link on the ticket sees them, a view link included. Best-effort: a
      // failed read costs the crew the list, never the work order.
      let flags = [];
      try {
        flags = await flagSvc.listCrewFlags(pool, ticket, tasks.rows.map((t) => t.id));
      } catch (e) {
        console.warn('[service-ticket-share] flags lookup failed', e && e.message);
      }

      // Time and materials (Phase 3) — ONLY on a work order billed after the
      // work, and only the lines THIS link sent: a tech sees the hours they
      // typed, never the crew's total, never the office's corrections or
      // notes. null on every other ticket, so the page shows no card at all.
      // Best-effort: a failed read costs the crew the list, not the card.
      let fieldCapture = null;
      if (fieldCaptureSvc.fieldCaptureOn(ticket)) {
        fieldCapture = { on: true, labor: [], materials: [] };
        try {
          const mine = await fieldCaptureSvc.listCrewLines(pool, ticket, share.id, tasks.rows.map((t) => t.id));
          fieldCapture.labor = mine.labor;
          fieldCapture.materials = mine.materials;
        } catch (e) {
          console.warn('[service-ticket-share] field capture lookup failed', e && e.message);
        }
      }

      res.json({
        ticket: svc.publicTicket(ticket, share),
        share: svc.publicShare(share),
        site: site,
        contact: contact,
        // A whitelist here too: a task row carries an assignee, a creator and
        // an org id, none of which is a guest's business. The id is here so a
        // photo or a completion can say WHICH subtask it is for; it is only
        // ever honoured for a task of THIS ticket (workOrder.loadSubtask).
        tasks: tasks.rows.map(function (t) {
          const act = activity.get(String(t.id)) || { notes: [], completed_by: null };
          return {
            id: t.id,
            title: t.title,
            done: t.status === 'done',
            // A reply-only line is finished without a completion photo. The flag,
            // not the kind: the crew has no use for the office's task kinds.
            reply_only: !svc.subtaskNeedsPhoto(t),
            due_date: t.due_date,
            completed_at: t.status === 'done' ? t.completed_at : null,
            completed_by: t.status === 'done' ? act.completed_by : null,
            photos: (photosByTask.get(String(t.id)) || []).map(function (p) {
              return { id: p.id, kind: p.kind, thumb_url: p.thumb_url, web_url: p.web_url };
            }),
            notes: act.notes,
          };
        }),
        org_name: orgName,
        parent_label: parentLabel,
        // { filename, kind, size_bytes, copy, lines } or null — see
        // crewTakeoffFor. copy true: the price-free xlsx, size_bytes null.
        takeoff: takeoff,
        finish: finish,
        site_photos: sitePhotos,
        send_back: sendBack,
        flags: flags,
        field_capture: fieldCapture,
      });
    } catch (e) {
      console.error('[service-ticket-share] read failed', e);
      res.status(500).json({ error: 'Something went wrong opening this link.' });
    }
  });

// T1b — open the takeoff file, through the token.
//
// The bytes come from storage HERE rather than the page linking the file's
// public URL: a storage URL outlives the link, cannot be revoked, and would
// bypass every gate above. Through this door a revoked or expired link stops
// (loadTicketShare), a spreadsheet reaches a link that hides financials only
// as its price-free copy, and a file taken off the job stops — each decided by
// crewTakeoffFor before a byte is read, so a refused request never costs a
// storage fetch. One refusal comes later, because it needs the bytes: on a
// link that hides financials an original whose first bytes do not prove it is
// the PDF or photo its name says (bytesProveOriginal) is the same no-takeoff
// 404, answered before any header or byte of it is sent.
//
// Read-only, and records nothing in the event log: the crew opening the
// takeoff is not a change to the work order.
//
// THE COPY is built here from the stored lines (at most 100, a few KB of
// xlsx) and sent whole: it never touches storage, so none of the streaming
// below applies to it. It still takes the download slot, which bounds how many
// builds one link or one address can run at once, and it is always an
// attachment under the sandbox CSP.
//
// STREAMED, NEVER HELD. This door needs no login and is built to be
// forwarded, and a file here can be 25 MB. Reading it whole (getBuffer) held
// one copy per request — twice that on R2, which collects and concatenates —
// so sixty downloads started at once from one address, inside the IP limiter,
// held well over a gigabyte on the one replica. The file is piped from
// storage.getStream instead: what is held per download is a stream buffer,
// not the file.
//
// ONE DOWNLOAD PER LINK AND PER ADDRESS. Streaming bounds the memory; the
// slots bound the storage connections a stranger can hold open. A second
// download on the same link, or from the same address, while one is in flight
// is a 429 before storage is touched. In-process like the office's
// takeFileReadSlot (one replica), keyed on the share ROW's id — never the
// token, a live credential — and given back in a `finally` whether the
// download finished, failed, or the reader went away. A reader that stops
// reading holds its slot only until the socket has been idle for
// TAKEOFF_IDLE_MS.
//
// THE STORED SIZE IS WHAT IS SENT. Content-Length comes from the attachment
// row, which crewTakeoffFor has already held to the cap. Storage must agree
// with it before a header goes out (an object over the cap is the too-large
// 413, any other mismatch a 500), and the bytes are counted on the way through: a
// stream that runs past the stored size, or ends short of it, drops the
// connection rather than sending a file that is not the one the length names.
const TAKEOFF_BUSY = 'This file is already downloading — try again in a moment.';
const TAKEOFF_TOO_LARGE = 'That file is too large to open here — ask the office for it.';
const TAKEOFF_FAILED = 'Something went wrong opening that file.';
// takeoffContentType looks no further than the first 1024 bytes, and neither
// does the PDF or photo test in bytesProveOriginal (sniffKind's).
const TAKEOFF_SNIFF_BYTES = 1024;
const TAKEOFF_IDLE_MS = 60 * 1000;
const takeoffDownloads = new Set();

// A release function, or null when this link or this address already has a
// download in flight. Both slots are taken together or neither is.
function takeTakeoffSlot(req) {
  const keys = ['share:' + String(req.share.id), 'ip:' + String(req.ip || 'unknown')];
  if (keys.some((k) => takeoffDownloads.has(k))) return null;
  keys.forEach((k) => takeoffDownloads.add(k));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    keys.forEach((k) => takeoffDownloads.delete(k));
  };
}

// Headers on every file this door sends, copy or original: never sniffed,
// never cached, never a referrer, never indexed.
function takeoffGuardHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

router.get('/service-ticket-share/:token/takeoff',
  stShareIpLimiter, stShareViewLimiter, loadTicketShare, async (req, res) => {
    let release = null;
    let source = null;
    try {
      const found = await crewTakeoffFor(req.ticket, req.share);
      if (!found) return res.status(404).json({ error: 'There is no takeoff file on this work order.' });

      if (found.copyLines) {
        // THE PRICE-FREE COPY. The original is never opened on this path —
        // no storage read of any kind.
        release = takeTakeoffSlot(req);
        if (!release) return res.status(429).json({ error: TAKEOFF_BUSY });
        const built = await buildCrewCopy(found);
        res.status(200);
        res.setHeader('Content-Type', TAKEOFF_TYPES.xlsx);
        res.setHeader('Content-Length', String(built.buffer.length));
        res.setHeader('Content-Disposition', takeoffDisposition('attachment', built.filename));
        takeoffGuardHeaders(res);
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        // The slot is held until the copy has left, like a streamed download's,
        // and a reader that stops reading is cut off on the same idle timer —
        // `finished` then rejects as a premature close and the slot comes back.
        if (typeof res.setTimeout === 'function') res.setTimeout(TAKEOFF_IDLE_MS, () => res.destroy());
        const sent = finished(res);
        res.end(built.buffer);
        await sent;
        return;
      }

      const att = found.att;
      if (!att.original_key) return res.status(404).json({ error: 'There is no takeoff file on this work order.' });
      // A safe integer within the cap — crewTakeoffFor offers nothing else.
      const size = found.takeoff.size_bytes;

      release = takeTakeoffSlot(req);
      if (!release) return res.status(429).json({ error: TAKEOFF_BUSY });
      // A reader that stops reading stalls the writes, and an idle socket is
      // closed, which ends the pipeline below and gives the slots back.
      if (typeof res.setTimeout === 'function') res.setTimeout(TAKEOFF_IDLE_MS, () => res.destroy());

      const opened = await storage.getStream(att.original_key);
      source = opened && opened.stream;
      if (!source) throw new Error('storage returned no stream');
      const actual = opened.size == null ? null : Number(opened.size);
      if (actual !== null && actual !== size) {
        if (!(actual <= require('../services/materials-extract').MAX_FILE_BYTES)) {
          return res.status(413).json({ error: TAKEOFF_TOO_LARGE });
        }
        console.error('[service-ticket-share] takeoff size does not match storage');
        return res.status(500).json({ error: TAKEOFF_FAILED });
      }

      const sendHeaders = (head) => {
        const type = takeoffContentType(found.takeoff.kind, head);
        // Only a PDF or a photo whose bytes proved it opens in the browser.
        // Everything else — a spreadsheet, a CSV, a file that did not match its
        // name — downloads.
        const inline = type === 'application/pdf' || /^image\//.test(type);
        res.status(200);
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Length', String(size));
        res.setHeader('Content-Disposition', takeoffDisposition(inline ? 'inline' : 'attachment', found.takeoff.filename));
        takeoffGuardHeaders(res);
        // A document opened from a stranger's link runs nothing: no script, no
        // fetch, no form. Set on downloads too, for the browser that renders one
        // anyway.
        //
        // Except a PDF. Chrome's built-in viewer refuses to load under a CSP
        // `sandbox` (or `default-src 'none'`, which denies the plugin), so the
        // crew would open a blank page. A PDF here is served only when its BYTES
        // are a PDF (above), with nosniff, exactly as the office's own
        // GET /api/attachments/raw/:id already serves PDFs inline.
        if (type !== 'application/pdf') {
          res.setHeader('Content-Security-Policy', inline
            ? "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
            : "default-src 'none'; sandbox");
        }
      };

      // The pipeline notices a reader who went away only at its next write, and
      // a storage stream that has stalled never makes one — the download, and
      // its slots, would hang. So a response closed before it finished lets
      // the storage stream go at once, which ends the pipeline.
      const stream = source;
      res.on('close', () => { if (!res.writableFinished && !stream.destroyed) stream.destroy(); });

      // THE FIRST BYTES, READ BEFORE ANYTHING IS SENT. The first
      // TAKEOFF_SNIFF_BYTES (all of the file, when it is smaller) are pulled off
      // the storage stream here, OUTSIDE the pipeline, and held until the type
      // is decided from them. On a link that hides financials they must also
      // prove the file is the PDF or photo its name says (bytesProveOriginal)
      // — and a refusal has to be the plain no-takeoff 404, which only works
      // while no header of the file's is set and no byte of it has left. Inside
      // the pipeline a refusal could only destroy the response.
      const chunks = source[Symbol.asyncIterator]();
      const asBuffer = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(c));
      const head = [];
      let seen = 0;
      let ended = false;
      while (seen < TAKEOFF_SNIFF_BYTES) {
        const step = await chunks.next();
        if (step.done) { ended = true; break; }
        const b = asBuffer(step.value);
        seen += b.length;
        if (seen > size) throw new Error('storage sent more than the stored size');
        head.push(b);
      }
      if (ended && seen !== size) throw new Error('storage sent less than the stored size');
      const first = Buffer.concat(head);
      if (svc.hidesFinancials(req.share) && !bytesProveOriginal(found.takeoff.kind, first, att)) {
        // Never the filename in the log: a name can carry a price too.
        console.warn('[service-ticket-share] takeoff refused: its bytes are not the ' + found.takeoff.kind + ' its name says');
        return res.status(404).json({ error: 'There is no takeoff file on this work order.' });
      }

      // Decided. The held bytes go first, and after them each chunk goes
      // straight on, at the pace the reader takes it, counted against the
      // stored size.
      sendHeaders(first);
      await pipeline(async function* countAndSend() {
        if (first.length) yield first;
        if (ended) return;
        for (;;) {
          const step = await chunks.next();
          if (step.done) break;
          const b = asBuffer(step.value);
          seen += b.length;
          if (seen > size) throw new Error('storage sent more than the stored size');
          yield b;
        }
        if (seen !== size) throw new Error('storage sent less than the stored size');
      }, res);
    } catch (e) {
      // The reader closing the tab mid-download is not a server fault.
      if (!(e && e.code === 'ERR_STREAM_PREMATURE_CLOSE')) {
        console.error('[service-ticket-share] takeoff open failed', e && e.message);
      }
      if (res.headersSent || res.destroyed) return;
      res.status(500).json({ error: TAKEOFF_FAILED });
    } finally {
      if (source && !source.destroyed && typeof source.destroy === 'function') source.destroy();
      if (release) release();
    }
  });

// ── T2: the guest field report ──────────────────────────────────────────
// THE FIRST TOKEN WRITE IN THIS FEATURE. Everything about it is deliberately
// narrow.
//
// It reads a CLOSED SET of four body keys and NAMES each one — there is no
// loop over req.body, so a field added to service_tickets later cannot become
// writable by a stranger just because it exists. See GUEST_WRITABLE_FIELDS.
//
// Three gates run before any of them, in this order:
//   scope     — 'respond' or better, re-derived from the STORED row through
//               normalizeScope, never from the request and never from the page
//               having hidden a control.
//   terminal  — a closed or cancelled ticket refuses every token write, the
//               same "expires on completion" burn task-share implements.
//   transition— checked through the SHARE lattice, which is forward-only
//               inside the crew band.
//
// UNDER ONE LOCK (1.29). The checklist, the note and the status land in one
// transaction under SELECT ... FOR UPDATE on the ticket, and every gate that
// matters is re-checked on that LOCKED row, never on the row loadTicketShare
// read a moment earlier:
//   * Finish whole work order is refused while any building on the punch list
//     is open (409 buildings_open), and then NOTHING is written — not even a
//     note typed alongside it. The office is told automatically when the last
//     building is done, so there is no reason to finish around the punch list.
//   * "Undo — not finished yet" (in_progress from work_complete, a move the
//     share lattice otherwise refuses) is allowed only while the newest status
//     event is this link's own finish (409 finish_not_yours otherwise).
//   * The UPDATE is guarded on organization_id AND the locked status, so an
//     office move that lands between the read and the write answers
//     409 status_changed instead of being overwritten.
//   * Events are strict, and the approval notice goes out only after COMMIT,
//     only for a finish that really applied.
const BUILDINGS_OPEN_ENDING = " finished. Finish each building on the punch list first — the office is told automatically when the last one is done.";
const WORK_ORDER_GONE = 'This work order is no longer available.';

// The field-log stamp's date, time and zone, in the org's timezone. Read
// best-effort OUTSIDE the transaction: a failed statement inside one aborts it
// on Postgres, and a missing timezone must not cost the crew its note.
async function crewStampWhen(orgId) {
  let tz = null;
  try {
    const r = await pool.query('SELECT timezone FROM organizations WHERE id = $1', [orgId]);
    tz = (r.rows[0] && r.rows[0].timezone) || null;
  } catch (e) { tz = null; }
  return formatInTz(new Date(), tz, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// How many field-report photos this link added since its last note: its
// photo_added events with no task_id (a building photo) and no flag_id (a
// flagged problem's photo), newest first, until its newest note_added.
async function crewReportPhotoCount(db, ticket, share) {
  const r = await db.query(
    `SELECT kind, created_at, detail FROM service_ticket_events
      WHERE ticket_id = $1 AND organization_id = $2 AND share_id = $3
        AND kind IN ('photo_added', 'note_added')
      ORDER BY created_at DESC LIMIT 200`,
    [ticket.id, ticket.organization_id, share.id]
  );
  let n = 0;
  for (const e of r.rows) {
    if (e.kind === 'note_added') break;
    if (e.kind !== 'photo_added') continue;
    let d = e.detail;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    const tagged = d && typeof d === 'object' && ((d.task_id != null && d.task_id !== '') || (d.flag_id != null && d.flag_id !== ''));
    if (!tagged) n += 1;
  }
  return n;
}

function storedChecklist(v) {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return []; }
  }
  return v;
}

router.patch('/service-ticket-share/:token',
  stShareIpLimiter, stShareWriteLimiter, loadTicketShare, async (req, res) => {
    let client = null;
    let open = false;
    try {
      const share = req.share;
      const ticket = req.ticket;

      // Re-derived from the stored row. A page that hid its controls is not a
      // permission, and neither is anything in the body.
      if (!svc.scopeAllows(share.scope, 'respond')) {
        return res.status(403).json({ error: 'This link is view-only.' });
      }
      // The CREW rule, not merely "not terminal": approved and draft belong to
      // the office, exactly as they do on the building and flag doors. An
      // approved work order's photos and field log are the record of what was
      // approved (work-order-photo-guard refuses to remove a photo from one),
      // so a link that is still live must not be able to add to them.
      const gate = svc.crewSubtasksWritable(ticket.status);
      if (!gate.ok) {
        return res.status(409).json({ error: gate.reason });
      }

      const body = req.body || {};

      // 1. name → the SHARE's recipient_name, NOT the ticket. Write-once,
      //    because it labels every note already left; letting it change would
      //    retroactively re-attribute them. Set BEFORE the note stamp is
      //    composed so a guest's first action already carries their name.
      await applyCrewName(share, body);

      const wantsChecklist = Array.isArray(body.checklist);
      const wantsNote = svc.guestNoteStamp(body.note, share) !== null;
      const wantsStatus = body.status != null && String(body.status) !== '';
      // IDEMPOTENT (1.30), the key the photo and flag doors already carry. The
      // page mints one client_ref per UNSENT note and sends the same one again
      // when it retries, so a save that landed and lost its answer does not
      // append the crew's note to the field log twice. A body without one (an
      // old cached page) always writes, exactly as the flag door treats a
      // missing key. Shape only — an opaque token, never contents.
      const noteRef = typeof body.client_ref === 'string' && flagSvc.CLIENT_REF_RE.test(body.client_ref)
        ? body.client_ref : null;
      if (!wantsChecklist && !wantsNote && !wantsStatus) {
        return res.json({ ok: true, ticket: svc.publicTicket(ticket, share) });
      }
      const when = wantsNote ? await crewStampWhen(ticket.organization_id) : null;

      client = await pool.connect();
      await client.query('BEGIN');
      open = true;
      const refuse = async (status, payload) => {
        open = false;
        await client.query('ROLLBACK');
        return res.status(status).json(payload);
      };

      const lr = await client.query(
        'SELECT * FROM service_tickets WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL FOR UPDATE',
        [ticket.id, ticket.organization_id]
      );
      const locked = lr.rows[0];
      if (!locked) return refuse(404, { error: WORK_ORDER_GONE });
      // The same crew rule again, on the LOCKED row, so an approval the office
      // commits between the load and the FOR UPDATE refuses and writes nothing.
      const lockedGate = svc.crewSubtasksWritable(locked.status);
      if (!lockedGate.ok) {
        return refuse(409, { error: lockedGate.reason });
      }
      const from = svc.normalizeStatus(locked.status);

      // 4 (decided first, so a refusal writes nothing). status → the share
      //    lattice, on the LOCKED row. A refusal is a 403 WITH THE REASON, not
      //    a silent no-op: a crew member who cannot mark work complete needs
      //    to know why.
      let nextStatus = null;
      let reason = null;
      if (wantsStatus) {
        const asked = String(body.status).trim().toLowerCase();
        if (asked === 'in_progress' && from === 'work_complete') {
          // "Undo — not finished yet": this link's own finish, and nothing
          // since. Undo keeps approval_notified_at and never notifies.
          const last = await workOrder.lastStatusEvent(client, locked);
          const undo = svc.crewMayUndoFinish(locked.status, last, share.id);
          if (!undo.ok) return refuse(409, { error: undo.reason, code: 'finish_not_yours' });
          nextStatus = 'in_progress';
          reason = 'crew_undid_finish';
        } else {
          const verdict = svc.ticketMayTransition(locked.status, asked, 'share');
          if (!verdict.ok) return refuse(403, { error: verdict.reason });
          if (asked !== from) {
            if (asked === 'work_complete') {
              // Only live org subtasks count — the punch list the crew sees.
              const counts = await workOrder.subtaskCounts(client, locked);
              if (counts.total > 0 && counts.done < counts.total) {
                const openCount = counts.total - counts.done;
                return refuse(409, {
                  error: svc.openSubtasksLine(openCount, counts.total, 'building') + BUILDINGS_OPEN_ENDING,
                  code: 'buildings_open',
                  open: openCount,
                  total: counts.total,
                });
              }
              // Phase 3: a work order billed after the work is billed FROM the
              // time and the work performed, so it cannot be finished before
              // anybody has sent any. Keyed on bill_as alone — every ticket
              // that predates the two kinds is 'none' and finishes as before.
              // Asked of the LOCKED row, inside this transaction.
              if (fieldCaptureSvc.fieldCaptureOn(locked) && !(await fieldCaptureSvc.hasUsableTime(client, locked))) {
                return refuse(409, { error: fieldCaptureSvc.MSG.timeMissing, code: 'time_missing' });
              }
              reason = 'marked_complete';
            }
            nextStatus = asked;
          }
        }
      }

      // Did THIS link already append THIS note to THIS work order? One lookup,
      // under the same FOR UPDATE that holds the ticket row, so two retries
      // racing are serialized and no second unique index is needed. A hit drops
      // the note and lets the rest of the PATCH (a checklist tick, a finish)
      // proceed — a retried Save report answers ok, it does not refuse.
      let noteAlreadyStored = false;
      if (wantsNote && noteRef) {
        const seen = await client.query(
          `SELECT 1 FROM service_ticket_events
            WHERE ticket_id = $1 AND organization_id = $2 AND share_id = $3
              AND kind = 'note_added' AND detail->>'client_ref' = $4
            LIMIT 1`,
          [locked.id, locked.organization_id, share.id, noteRef]
        );
        noteAlreadyStored = seen.rows.length > 0;
      }

      const sets = [];
      const params = [];
      const changed = [];

      // 2. checklist → only `done` flips land. normalizeGuestChecklist diffs
      //    against what is STORED (the locked row); additions, deletions,
      //    reorders and text edits are dropped silently. The office owns what
      //    the list says, the guest owns whether each line is finished.
      if (wantsChecklist) {
        const merged = svc.normalizeGuestChecklist(storedChecklist(locked.checklist), body.checklist);
        params.push(JSON.stringify(merged));
        sets.push('checklist = $' + params.length + '::jsonb');
        changed.push('checklist');
      }

      // 3. note → APPENDED in SQL, never read-modify-write, so two guests
      //    writing at once cannot lose one another's note. Targets guest_log,
      //    NOT internal_notes — a guest must not be able to grow a field the
      //    office writes into. The stamp carries the date, time and zone, and
      //    how many field-report photos this link sent with the note.
      let photoCount = 0;
      if (wantsNote && !noteAlreadyStored) {
        photoCount = await crewReportPhotoCount(client, locked, share);
        const stamp = svc.guestNoteStamp(body.note, share, { when: when, photoCount: photoCount });
        params.push(stamp);
        sets.push("guest_log = COALESCE(guest_log, '') || $" + params.length);
        changed.push('note');
      }

      if (nextStatus) {
        params.push(nextStatus);
        sets.push('status = $' + params.length);
        changed.push('status');
        // completed_at is SET by a finish (COALESCEd, so a second report
        // cannot move it) and cleared only by the crew taking its own finish
        // back, or by the office.
        if (nextStatus === 'work_complete') {
          sets.push('completed_at = COALESCE(completed_at, NOW())');
        } else if (reason === 'crew_undid_finish') {
          sets.push('completed_at = NULL');
        }
      }

      if (!sets.length) {
        open = false;
        await client.query('ROLLBACK');
        return res.json({ ok: true, ticket: svc.publicTicket(locked, share) });
      }

      params.push(locked.id, locked.organization_id, locked.status);
      const up = await client.query(
        'UPDATE service_tickets SET ' + sets.join(', ') + ', updated_at = NOW() ' +
        'WHERE id = $' + (params.length - 2) + ' AND organization_id = $' + (params.length - 1) +
        ' AND status = $' + params.length + ' RETURNING *',
        params
      );
      const row = up.rows[0];
      if (!row) return refuse(409, { error: review.STALE_ERROR, code: 'status_changed' });

      // Every guest write appends an attributed event. A bearer token cannot
      // identify a person, so the honest record is "this arrived through the
      // link sent to <recipient>" — actor_label is a CLAIM and the UI says so.
      // Strict: inside the transaction a swallowed failure would turn COMMIT
      // into a silent ROLLBACK.
      const label = share.recipient_name || share.recipient_email || null;
      const actor = { kind: 'share', shareId: share.id, label: label };
      if (nextStatus) {
        const detail = { from: locked.status, to: nextStatus };
        if (reason) detail.reason = reason;
        await workOrder.insertEvent(client, locked, 'status_changed', actor, detail, { strict: true });
      }
      const other = changed.filter(function (c) { return c !== 'status'; });
      if (other.length) {
        const detail = { fields: other };
        if (photoCount > 0) detail.photo_count = photoCount;
        // The key the next retry looks for. Written on the note_added event
        // only, which is what the lookup above reads.
        if (noteRef && other.indexOf('note') >= 0) detail.client_ref = noteRef;
        await workOrder.insertEvent(client, locked, other.indexOf('note') >= 0 ? 'note_added' : 'field_changed',
          actor, detail, { strict: true });
      }

      await client.query('COMMIT');
      open = false;

      // After COMMIT, best-effort: the link's own bookkeeping.
      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW()' +
        (nextStatus === 'work_complete' ? ', completed_at = NOW()' : '') +
        (reason === 'crew_undid_finish' ? ', completed_at = NULL' : '') +
        ' WHERE id = $1 AND organization_id = $2', [share.id, locked.organization_id]).catch(function () {});

      // Finish whole work order: the crew is telling the office the job is
      // done, so the office hears it (the job's PM, the ticket's creator, the
      // link's sender). Only for a finish that applied; an undo never notifies.
      // Not awaited — the crew's save never waits on an email — but tracked, so
      // a deploy lets the send finish.
      if (nextStatus === 'work_complete') {
        inflight.track(ticketNotify.notifyAwaitingApproval(pool, {
          ticket: row,
          actor: actor,
          reason: 'marked_complete',
          sharedBy: share.created_by,
        }), 'ticket_approval');
      }

      res.json({
        ok: true,
        ticket: svc.publicTicket(row, share),
        share: svc.publicShare(Object.assign({}, share)),
      });
    } catch (e) {
      if (client && open) {
        try { await client.query('ROLLBACK'); } catch (_) { /* the connection is already gone */ }
      }
      console.error('[service-ticket-share] guest patch failed', e);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong saving that.' });
    } finally {
      if (client) client.release();
    }
  });

// ── T4: propose a revision ──────────────────────────────────────────────
// THE ANSWER TO "editing potential from the share screen". The guest really
// does type into the scope and press Save. What lands is a PROPOSAL with their
// name on it, in a quarantine table, pending a PM's acceptance — which is also
// what the word "revise" means.
//
// It NEVER touches service_tickets. The blast radius of a hostile or mistaken
// proposal is a row in an inbox, not a corrupted work order.
router.post('/service-ticket-share/:token/revision',
  stShareIpLimiter, stSharePropose, loadTicketShare, async (req, res) => {
    try {
      const share = req.share;
      const ticket = req.ticket;

      if (!svc.scopeAllows(share.scope, 'propose')) {
        return res.status(403).json({ error: 'This link cannot suggest changes.' });
      }
      if (svc.isTerminal(ticket.status)) {
        return res.status(409).json({ error: 'This work order is ' + ticket.status + ' and can no longer be changed.' });
      }

      const body = req.body || {};
      // Filtered at EMIT time. status, assignee_user_id, scope_approved,
      // internal_notes, ticket_number, both parent ids and organization_id are
      // absent from PROPOSABLE_FIELDS by design: a guest proposes what the WORK
      // is, never who does it, where it is filed, or whether it is approved.
      const fields = svc.filterProposedFields(body.fields);
      if (!Object.keys(fields).length) {
        // A 400, not a silent ok. An empty proposal that answers "ok" leaves
        // the sender believing they were heard.
        return res.status(400).json({ error: 'There is nothing here we can pass on.' });
      }

      await applyCrewName(share, body);

      const label = share.recipient_name || share.recipient_email || null;
      const id = svc.genId('strev');
      const { rows } = await pool.query(
        `INSERT INTO service_ticket_revisions
           (id, organization_id, ticket_id, share_id, author_label, fields, note)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
         RETURNING id, status, created_at`,
        [id, ticket.organization_id, ticket.id, share.id, label,
         JSON.stringify(fields), String(body.note == null ? '' : body.note).slice(0, 2000) || null]
      );

      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1 AND organization_id = $2',
        [share.id, ticket.organization_id]).catch(function () {});
      await logEvent(ticket, 'revision_proposed', {
        actorKind: 'share', shareId: share.id, actorLabel: label,
        // SHAPE, not contents — the field NAMES only. The proposed text itself
        // is in the quarantine row, not in the audit log.
        detail: { fields: Object.keys(fields) },
      });

      res.json({ ok: true, revision: { id: rows[0].id, status: rows[0].status, created_at: rows[0].created_at } });
    } catch (e) {
      console.error('[service-ticket-share] revision failed', e);
      res.status(500).json({ error: 'Something went wrong sending that.' });
    }
  });

// The image pipeline every link photo goes through — the ticket-level site
// photo (T3) and a subtask's before/completion photo alike. The magic-byte
// sniff runs BEFORE anything is stored: a file whose contents disagree with its
// claimed type never reaches storage. Images only; SVG is sanitized.
// Returns the stored keys/urls, or { error, status } for the caller to answer.
async function storeShareImage(file, baseKey) {
  if (!file || !file.buffer) return { error: 'No file', status: 400 };
  let buf = file.buffer;
  const claimed = file.mimetype || 'application/octet-stream';
  const sniffed = sniffMimeFromBytes(buf);
  // The bytes must agree with the claim BEFORE anything is stored.
  if (!mimeFamilyMatches(claimed, sniffed)) {
    return { error: 'File contents do not match its type', status: 400 };
  }
  const mime = sniffed || claimed;
  // HEIC (1.29), before the image-only check so a HEIC sent with no browser
  // type still gets the sentence that says what to do. The installed image
  // library cannot decode one, so it is refused here with that sentence rather
  // than failing below as a server error. Bytes that prove some OTHER format
  // (a JPEG merely named .heic) are not refused by the name.
  if (isHeicUpload(mime, file.originalname) && (!sniffed || sniffed === 'image/heic')) {
    return { error: HEIC_REFUSAL, status: 415 };
  }
  // Images only — no PDFs or documents from an outside link.
  if (typeof mime !== 'string' || mime.indexOf('image/') !== 0) {
    return { error: 'Only photos can be uploaded here', status: 400 };
  }
  if (mime === 'image/svg+xml') buf = sanitizeSvg(buf);
  const isRaster = mime !== 'image/svg+xml';
  const ext = (String(file.originalname || '').match(/\.([a-z0-9]+)$/i) || [, 'jpg'])[1].toLowerCase();
  let thumbUrl = null, webUrl = null, originalUrl, thumbKey = null, webKey = null, originalKey, width = null, height = null;
  if (isRaster) {
    // Every decode happens BEFORE anything is stored, so a photo the library
    // cannot read (garbage bytes under an image type, a truncated file) is a
    // 422 the crew can act on, with nothing left behind in storage.
    let thumbBuf, webBuf;
    try {
      const meta = await sharp(buf, { limitInputPixels: 50000000 }).rotate().metadata();
      width = meta.width || null; height = meta.height || null;
      thumbBuf = await sharp(buf, { limitInputPixels: 50000000 }).rotate().resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
      webBuf = await sharp(buf, { limitInputPixels: 50000000 }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    } catch (e) {
      return { error: PHOTO_UNREADABLE, status: 422 };
    }
    thumbKey = baseKey + '_thumb.jpg'; webKey = baseKey + '_web.jpg'; originalKey = baseKey + '_orig.' + ext;
    thumbUrl = await storage.put(thumbKey, thumbBuf, 'image/jpeg');
    webUrl = await storage.put(webKey, webBuf, 'image/jpeg');
    originalUrl = await storage.put(originalKey, buf, mime);
  } else {
    originalKey = baseKey + '_orig.' + ext;
    originalUrl = await storage.put(originalKey, buf, mime);
  }
  return { buf, mime, width, height, thumbUrl, webUrl, originalUrl, thumbKey, webKey, originalKey };
}

// ── T3: a site photo ────────────────────────────────────────────────────
// Copied from task-share-routes wholesale, including the magic-byte sniff
// BEFORE anything is stored, because the failure it prevents (a file whose
// contents disagree with its claimed type) is the same here.
//
// IDEMPOTENT (1.29). On a bad signal the photo can land and its answer never
// reach the phone, so the page sends it again with the same upload_id. The
// second arrival finds the row the first one wrote (per org, per ticket) and
// answers duplicate:true, storing nothing and logging nothing. Two arrivals
// racing past that lookup meet the unique index: the loser throws its stored
// bytes away and answers with the winner's row.

// The answer for a site photo row, fresh or found again. A whitelist: the
// page needs where to show it and when it was taken, nothing else.
function sitePhotoAnswer(row, duplicate) {
  const out = {
    ok: true,
    attachment: {
      id: row.id, filename: row.filename, thumb_url: row.thumb_url,
      web_url: row.web_url, original_url: row.original_url,
    },
    photo: {
      id: row.id, kind: 'site', thumb_url: row.thumb_url, web_url: row.web_url,
      uploaded_at: row.uploaded_at == null ? null : row.uploaded_at,
    },
  };
  if (duplicate) out.duplicate = true;
  return out;
}

router.post('/service-ticket-share/:token/photo',
  stShareIpLimiter, stShareWriteLimiter, loadTicketShare, multerOnePhoto,
  async (req, res) => {
    try {
      const share = req.share;
      const ticket = req.ticket;
      if (!svc.scopeAllows(share.scope, 'respond')) {
        return res.status(403).json({ error: 'This link is view-only.' });
      }
      // The crew rule, BEFORE storeShareImage: a refused photo is never decoded
      // or stored. Approved is the office's — a site photo added after the
      // approval could not be taken off again (work-order-photo-guard).
      const gate = svc.crewSubtasksWritable(ticket.status);
      if (!gate.ok) {
        return res.status(409).json({ error: gate.reason });
      }
      await applyCrewName(share, req.body);

      // Scoped by the ticket row's organization_id, never the request.
      const uploadId = uploadDedupe.uploadIdFrom(req.body);
      const findAgain = () => uploadDedupe.findUpload(pool, {
        orgId: ticket.organization_id, entityType: 'service_ticket', entityId: ticket.id, uploadId: uploadId,
      });
      if (uploadId) {
        const prior = await findAgain();
        if (prior) return res.json(sitePhotoAnswer(prior, true));
      }

      const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const img = await storeShareImage(req.file, 'service_ticket/' + ticket.id + '/' + id);
      if (img.error) return res.status(img.status).json({ error: img.error });
      const { buf, mime, width, height, thumbUrl, webUrl, originalUrl, thumbKey, webKey, originalKey } = img;

      const posR = await pool.query(
        "SELECT COALESCE(MAX(position), -1) AS max_pos FROM attachments WHERE entity_type = 'service_ticket' AND entity_id = $1 AND organization_id = $2",
        [ticket.id, ticket.organization_id]
      );
      const position = (posR.rows[0] && posR.rows[0].max_pos != null) ? Number(posR.rows[0].max_pos) + 1 : 0;

      let ins;
      try {
        ins = await pool.query(
          // uploaded_by is NULL by design — this door is a logged-out crew
          // member, so there is no user to attribute. organization_id is stamped
          // from the PARENT TICKET row already in hand (loadTicketShare
          // SELECTed it), never from the request. That is the same evidence the
          // read path uses to resolve the tenant. client_upload_id stays the
          // LAST parameter.
          `INSERT INTO attachments (id, entity_type, entity_id, folder, filename, mime_type, size_bytes, width, height, thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, uploaded_by, organization_id, uploaded_at, client_upload_id)
           VALUES ($1,'service_ticket',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18)
           RETURNING id, filename, thumb_url, web_url, original_url, uploaded_at`,
          [id, ticket.id, 'general', req.file.originalname, mime, buf.length, width, height,
           thumbUrl, webUrl, originalUrl, thumbKey, webKey, originalKey, position, null,
           ticket.organization_id, uploadId]
        );
      } catch (e) {
        if (!uploadId || !uploadDedupe.isUploadIdConflict(e)) throw e;
        await uploadDedupe.discardKeys(storage, [thumbKey, webKey, originalKey]);
        const winner = await findAgain();
        if (!winner) throw e;
        return res.json(sitePhotoAnswer(winner, true));
      }

      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1 AND organization_id = $2',
        [share.id, ticket.organization_id]).catch(function () {});
      await logEvent(ticket, 'photo_added', {
        actorKind: 'share', shareId: share.id,
        actorLabel: share.recipient_name || share.recipient_email || null,
        // attachment_id is how Site photos names who added each photo.
        detail: { mime: mime, attachment_id: ins.rows[0].id },
      });

      res.json(sitePhotoAnswer(ins.rows[0], false));
    } catch (e) {
      console.error('[service-ticket-share] guest photo failed', e);
      res.status(500).json({ error: 'Something went wrong uploading that.' });
    }
  });

// ── T5: work-order subtasks from the crew link (John, 2026-09-13) ─────────
// Each building on a punch list is a subtask; the crew adds before and
// completion photos to it, leaves notes on it, and marks it complete.
//
// The same three gates as every token write, in order:
//   scope    — 'respond' or better, from the STORED share row.
//   ticket   — crewSubtasksWritable: not a draft, not closed or cancelled, and
//              NOT approved — John: the crew may undo their own work "until the
//              office approves"; after that only the office can.
//   subtask  — the task must be a live org task OF THIS TICKET
//              (workOrder.loadSubtask). A task id from another ticket, another
//              org, a private to-do or an archived row answers the same 404.
// Completing needs a completion photo, and the ticket follows its subtasks —
// both inside workOrder.setSubtaskDone, the door the office checkbox uses too.
//
// crewGate below reads the ticket loadTicketShare loaded, before any lock: it
// answers a view link or a closed work order without opening a transaction.
// It is not the decision. The done door hands setSubtaskDone the same crew rule
// as its gate (subtaskDoor.crewGate), which asks it again of the LOCKED row, so
// an approval the office saves between the load and the lock refuses the tick
// (409 work_order_locked) instead of finishing a building on an approved work
// order.
function crewGate(req, res) {
  if (!svc.scopeAllows(req.share.scope, 'respond')) {
    res.status(403).json({ error: 'This link is view-only.' });
    return false;
  }
  const verdict = svc.crewSubtasksWritable(req.ticket.status);
  if (!verdict.ok) {
    res.status(409).json({ error: verdict.reason });
    return false;
  }
  return true;
}

function crewActor(share) {
  return { kind: 'share', shareId: share.id, label: share.recipient_name || share.recipient_email || null };
}

// The crew's name → the SHARE's recipient_name, write-once (recipient_name IS
// NULL), because it labels every note already left. The one copy of that write:
// the field report, the site photo, the building doors and the flag doors all
// call it. The organization is the share row's own, as loaded by its token,
// never anything in the request.
async function applyCrewName(share, body) {
  const newName = svc.guestNameUpdate(share.recipient_name, body && body.name);
  if (newName) {
    await pool.query(
      'UPDATE service_ticket_shares SET recipient_name = $1 WHERE id = $2 AND organization_id = $3 AND recipient_name IS NULL',
      [newName, share.id, share.organization_id]
    );
    share.recipient_name = newName;
  }
}

router.post('/service-ticket-share/:token/subtasks/:taskId/done',
  stShareIpLimiter, stShareWriteLimiter, loadTicketShare, async (req, res) => {
    try {
      if (!crewGate(req, res)) return;
      const share = req.share;
      await applyCrewName(share, req.body);
      const result = await workOrder.setSubtaskDone(pool, {
        ticket: req.ticket,
        taskId: req.params.taskId,
        done: !!(req.body && req.body.done),
        actor: crewActor(share),
        // The crew rule again, on the row setSubtaskDone holds locked.
        gate: subtaskDoor.crewGate,
      });
      if (!result.ok) {
        const refusal = { error: result.error };
        if (result.code) refusal.code = result.code;
        return res.status(result.status).json(refusal);
      }
      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1 AND organization_id = $2',
        [share.id, req.ticket.organization_id]).catch(function () {});
      if (result.movedTo === 'work_complete') {
        // Not awaited, but tracked, so a deploy lets the send finish. The
        // notice describes the LOCKED row as the door left it (its status after
        // the recount), never the copy loadTicketShare read before the lock.
        inflight.track(ticketNotify.notifyAwaitingApproval(pool, {
          ticket: result.ticket,
          actor: crewActor(share),
          reason: 'all_subtasks_done',
          sharedBy: share.created_by,
        }), 'ticket_approval');
      }
      res.json({ ok: true, done: result.task.status === 'done', ticket_status: result.ticketStatus });
    } catch (e) {
      console.error('[service-ticket-share] subtask done failed', e);
      res.status(500).json({ error: 'Something went wrong saving that.' });
    }
  });

router.post('/service-ticket-share/:token/subtasks/:taskId/note',
  stShareIpLimiter, stShareWriteLimiter, loadTicketShare, async (req, res) => {
    try {
      if (!crewGate(req, res)) return;
      const share = req.share;
      await applyCrewName(share, req.body);
      const result = await workOrder.addSubtaskNote(pool, {
        ticket: req.ticket,
        taskId: req.params.taskId,
        note: req.body && req.body.note,
        actor: crewActor(share),
        clientRef: req.body && req.body.client_ref,
      });
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1 AND organization_id = $2',
        [share.id, req.ticket.organization_id]).catch(function () {});
      res.json({ ok: true });
    } catch (e) {
      console.error('[service-ticket-share] subtask note failed', e);
      res.status(500).json({ error: 'Something went wrong saving that.' });
    }
  });

router.post('/service-ticket-share/:token/subtasks/:taskId/photo',
  stShareIpLimiter, stShareWriteLimiter, loadTicketShare, multerOnePhoto,
  async (req, res) => {
    try {
      if (!crewGate(req, res)) return;
      const share = req.share;
      const ticket = req.ticket;
      // The subtask is proved BEFORE a byte is stored.
      const task = await workOrder.loadSubtask(pool, ticket, req.params.taskId);
      if (!task) return res.status(404).json({ error: 'That subtask is not on this work order.' });
      await applyCrewName(share, req.body);

      // Idempotent like the site photo door (T3), deduped per org and per
      // subtask — only once the subtask is proved to be this ticket's.
      const uploadId = uploadDedupe.uploadIdFrom(req.body);
      const findAgain = () => uploadDedupe.findUpload(pool, {
        orgId: ticket.organization_id, entityType: 'task', entityId: task.id, uploadId: uploadId,
      });
      const duplicateAnswer = (row) => ({
        ok: true,
        duplicate: true,
        photo: { id: row.id, kind: svc.photoKindOf(row.tags), thumb_url: row.thumb_url, web_url: row.web_url },
      });
      if (uploadId) {
        const prior = await findAgain();
        if (prior) return res.json(duplicateAnswer(prior));
      }

      const kind = req.body && String(req.body.kind) === 'before' ? 'before' : 'completion';
      const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const img = await storeShareImage(req.file, 'task/' + task.id + '/' + id);
      if (img.error) return res.status(img.status).json({ error: img.error });

      const posR = await pool.query(
        "SELECT COALESCE(MAX(position), -1) AS max_pos FROM attachments WHERE entity_type = 'task' AND entity_id = $1 AND organization_id = $2",
        [task.id, ticket.organization_id]
      );
      const position = (posR.rows[0] && posR.rows[0].max_pos != null) ? Number(posR.rows[0].max_pos) + 1 : 0;

      let ins;
      try {
        ins = await pool.query(
          // An ordinary TASK attachment — the same row the task modal shows — so
          // the photo lives on the subtask it proves. uploaded_by NULL (a
          // logged-out crew member); organization_id from the TICKET row in hand,
          // never the request. The tag says before or completion.
          // client_upload_id is appended LAST ($19), so every earlier parameter
          // keeps its place.
          `INSERT INTO attachments (id, entity_type, entity_id, folder, filename, mime_type, size_bytes, width, height, thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, uploaded_by, organization_id, tags, client_upload_id)
           VALUES ($1,'task',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
           RETURNING id, thumb_url, web_url`,
          [id, task.id, 'general', req.file.originalname, img.mime, img.buf.length, img.width, img.height,
           img.thumbUrl, img.webUrl, img.originalUrl, img.thumbKey, img.webKey, img.originalKey, position, null,
           ticket.organization_id, JSON.stringify([kind]), uploadId]
        );
      } catch (e) {
        if (!uploadId || !uploadDedupe.isUploadIdConflict(e)) throw e;
        await uploadDedupe.discardKeys(storage, [img.thumbKey, img.webKey, img.originalKey]);
        const winner = await findAgain();
        if (!winner) throw e;
        return res.json(duplicateAnswer(winner));
      }

      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1 AND organization_id = $2',
        [share.id, ticket.organization_id]).catch(function () {});
      await logEvent(ticket, 'photo_added', {
        actorKind: 'share', shareId: share.id,
        actorLabel: share.recipient_name || share.recipient_email || null,
        detail: { task_id: task.id, kind: kind, attachment_id: ins.rows[0].id },
      });

      res.json({ ok: true, photo: { id: ins.rows[0].id, kind: kind, thumb_url: ins.rows[0].thumb_url, web_url: ins.rows[0].web_url } });
    } catch (e) {
      console.error('[service-ticket-share] subtask photo failed', e);
      res.status(500).json({ error: 'Something went wrong uploading that.' });
    }
  });

// ── Flag a problem (1.29) ───────────────────────────────────────────────
// The three flag doors land on this router, with this file's own token
// loader, crew gate, crew actor, name write and image pipeline, so a flag is
// held to exactly the rules a building tick or a photo is. The photo door's
// body parser is multerOnePhoto (413 / 408 in words a crew can act on), and
// the flag module puts its own gate ahead of it, so a refused photo is never
// buffered. Registration throws if any dependency is missing.
require('./service-ticket-flag-routes').registerFlagRoutes(router, {
  loadTicketShare,
  crewGate,
  crewActor,
  applyCrewName,
  storeShareImage,
  upload: { single: () => multerOnePhoto },
  ticketAccessOk,
  loadOwnedTicket,
});

// Field capture (Phase 3): the crew's time, work performed and materials
// used, and the office's accept / correct / reject — on this router for the
// same reason the flag doors are, held to the same token loader, crew gate,
// crew actor and name write. Registration throws if any is missing.
require('./service-ticket-field-routes').registerFieldCaptureRoutes(router, {
  loadTicketShare,
  crewGate,
  crewActor,
  applyCrewName,
  ticketAccessOk,
  loadOwnedTicket,
  // The receipt door takes the same image pipeline and the same one-photo
  // parser the flag door does, with its own gate ahead of multer.
  storeShareImage,
  upload: { single: function () { return multerOnePhoto; } },
});

module.exports = router;
