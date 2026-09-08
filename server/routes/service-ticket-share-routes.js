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
//     PATCH  /api/service-ticket-share/:token                     field report
//     POST   /api/service-ticket-share/:token/photo
//     POST   /api/service-ticket-share/:token/revision            propose
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
const { pool } = require('../db');
const { requireAuth, requireCapability, requireOrgId } = require('../auth');
const { callerOrgId } = require('../org-access');
const { sendEmail, isEnabled: emailIsEnabled } = require('../email');
const multer = require('multer');
const sharp = require('sharp');
const { sniffMimeFromBytes, sanitizeSvg, mimeFamilyMatches } = require('../util/attachment-mime');
const { storage } = require('../storage');
const { stShareIpLimiter, stShareViewLimiter, stShareWriteLimiter, stSharePropose } = require('../rate-limit');

// Memory storage: the buffer is sniffed and resized before anything is stored,
// so it must never touch disk under its claimed name first.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
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

// ── A11: the revisions inbox ────────────────────────────────────────────
router.get('/service-tickets/:id/revisions', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });
    if (!capOk(req, res, readCapFor(ticket))) return;

    const params = [ticket.id, orgId];
    let where = 'ticket_id = $1 AND organization_id = $2';
    if (req.query.status) { params.push(String(req.query.status)); where += ' AND status = $3'; }

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
         LEFT JOIN service_ticket_shares s ON s.id = r.share_id
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
    if (!capOk(req, res, writeCapFor(ticket))) return;

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
    if (!capOk(req, res, writeCapFor(ticket))) return;

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
    if (!capOk(req, res, readCapFor(ticket))) return;
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
    if (!capOk(req, res, writeCapFor(ticket))) return;

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
    if (!capOk(req, res, writeCapFor(ticket))) return;
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
router.patch('/service-ticket-share/:token',
  stShareIpLimiter, stShareWriteLimiter, loadTicketShare, async (req, res) => {
    try {
      const share = req.share;
      const ticket = req.ticket;

      // Re-derived from the stored row. A page that hid its controls is not a
      // permission, and neither is anything in the body.
      if (!svc.scopeAllows(share.scope, 'respond')) {
        return res.status(403).json({ error: 'This link is view-only.' });
      }
      if (svc.isTerminal(ticket.status)) {
        return res.status(409).json({ error: 'This work order is ' + ticket.status + ' and can no longer be updated.' });
      }

      const body = req.body || {};
      const sets = [];
      const params = [];
      const changed = [];

      // 1. name → the SHARE's recipient_name, NOT the ticket. Write-once,
      //    because it labels every note already left; letting it change would
      //    retroactively re-attribute them. Set BEFORE the note stamp is
      //    composed so a guest's first action already carries their name.
      const newName = svc.guestNameUpdate(share.recipient_name, body.name);
      if (newName) {
        await pool.query(
          'UPDATE service_ticket_shares SET recipient_name = $1 WHERE id = $2 AND recipient_name IS NULL',
          [newName, share.id]
        );
        share.recipient_name = newName;
      }

      // 2. checklist → only `done` flips land. normalizeGuestChecklist diffs
      //    against what is STORED; additions, deletions, reorders and text
      //    edits are dropped silently. The office owns what the list says, the
      //    guest owns whether each line is finished.
      if (Array.isArray(body.checklist)) {
        const merged = svc.normalizeGuestChecklist(ticket.checklist, body.checklist);
        params.push(JSON.stringify(merged));
        sets.push('checklist = $' + params.length + '::jsonb');
        changed.push('checklist');
      }

      // 3. note → APPENDED in SQL, never read-modify-write, so two guests
      //    writing at once cannot lose one another's note. Targets guest_log,
      //    NOT internal_notes — a guest must not be able to grow a field the
      //    office writes into.
      const stamp = svc.guestNoteStamp(body.note, share);
      if (stamp) {
        params.push(stamp);
        sets.push("guest_log = COALESCE(guest_log, '') || $" + params.length);
        changed.push('note');
      }

      // 4. status → the share lattice. A refusal is a 403 WITH THE REASON,
      //    not a silent no-op: a crew member who cannot mark work complete
      //    needs to know why.
      let nextStatus = null;
      if (body.status != null && String(body.status) !== '') {
        const verdict = svc.ticketMayTransition(ticket.status, body.status, 'share');
        if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
        nextStatus = String(body.status);
        if (nextStatus !== ticket.status) {
          params.push(nextStatus);
          sets.push('status = $' + params.length);
          changed.push('status');
          // completed_at is only ever SET by a guest, only ever CLEARED by a
          // PM. task-share never clears its equivalent, which leaves a
          // reopened item still claiming a completion date.
          if (nextStatus === 'work_complete') {
            sets.push('completed_at = COALESCE(completed_at, NOW())');
          }
        }
      }

      if (!sets.length) return res.json({ ok: true, ticket: svc.publicTicket(ticket, share) });

      params.push(ticket.id);
      const { rows } = await pool.query(
        'UPDATE service_tickets SET ' + sets.join(', ') + ', updated_at = NOW() ' +
        'WHERE id = $' + params.length + ' RETURNING *',
        params
      );
      if (!rows[0]) return res.status(404).json({ error: 'This work order is no longer available.' });

      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW()' +
        (nextStatus === 'work_complete' ? ', completed_at = NOW()' : '') +
        ' WHERE id = $1', [share.id]).catch(function () {});

      // Every guest write appends an attributed event. A bearer token cannot
      // identify a person, so the honest record is "this arrived through the
      // link sent to <recipient>" — actor_label is a CLAIM and the UI says so.
      const label = share.recipient_name || share.recipient_email || null;
      if (changed.indexOf('status') >= 0) {
        await logEvent(ticket, 'status_changed', {
          actorKind: 'share', shareId: share.id, actorLabel: label,
          detail: { from: ticket.status, to: nextStatus },
        });
      }
      const other = changed.filter(function (c) { return c !== 'status'; });
      if (other.length) {
        await logEvent(ticket, other.indexOf('note') >= 0 ? 'note_added' : 'field_changed', {
          actorKind: 'share', shareId: share.id, actorLabel: label,
          detail: { fields: other },
        });
      }

      res.json({
        ok: true,
        ticket: svc.publicTicket(rows[0], share),
        share: svc.publicShare(Object.assign({}, share)),
      });
    } catch (e) {
      console.error('[service-ticket-share] guest patch failed', e);
      res.status(500).json({ error: 'Something went wrong saving that.' });
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

      const newName = svc.guestNameUpdate(share.recipient_name, body.name);
      if (newName) {
        await pool.query(
          'UPDATE service_ticket_shares SET recipient_name = $1 WHERE id = $2 AND recipient_name IS NULL',
          [newName, share.id]
        );
        share.recipient_name = newName;
      }

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

      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1', [share.id])
        .catch(function () {});
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

// ── T3: a site photo ────────────────────────────────────────────────────
// Copied from task-share-routes wholesale, including the magic-byte sniff
// BEFORE anything is stored, because the failure it prevents (a file whose
// contents disagree with its claimed type) is the same here.
router.post('/service-ticket-share/:token/photo',
  stShareIpLimiter, stShareWriteLimiter, loadTicketShare, upload.single('file'),
  async (req, res) => {
    try {
      const share = req.share;
      const ticket = req.ticket;
      if (!svc.scopeAllows(share.scope, 'respond')) {
        return res.status(403).json({ error: 'This link is view-only.' });
      }
      if (svc.isTerminal(ticket.status)) {
        return res.status(409).json({ error: 'This work order is ' + ticket.status + ' and can no longer be updated.' });
      }
      if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file' });

      let buf = req.file.buffer;
      const claimed = req.file.mimetype || 'application/octet-stream';
      const sniffed = sniffMimeFromBytes(buf);
      // The bytes must agree with the claim BEFORE anything is stored.
      if (!mimeFamilyMatches(claimed, sniffed)) {
        return res.status(400).json({ error: 'File contents do not match its type' });
      }
      const mime = sniffed || claimed;
      // Images only — no PDFs or documents from an outside link.
      if (typeof mime !== 'string' || mime.indexOf('image/') !== 0) {
        return res.status(400).json({ error: 'Only photos can be uploaded here' });
      }
      if (mime === 'image/svg+xml') buf = sanitizeSvg(buf);
      const isRaster = mime !== 'image/svg+xml';

      const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const ext = (String(req.file.originalname || '').match(/\.([a-z0-9]+)$/i) || [, 'jpg'])[1].toLowerCase();
      const baseKey = 'service_ticket/' + ticket.id + '/' + id;
      let thumbUrl = null, webUrl = null, originalUrl, thumbKey = null, webKey = null, originalKey, width = null, height = null;
      if (isRaster) {
        const meta = await sharp(buf, { limitInputPixels: 50000000 }).rotate().metadata();
        width = meta.width || null; height = meta.height || null;
        const thumbBuf = await sharp(buf, { limitInputPixels: 50000000 }).rotate().resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
        const webBuf = await sharp(buf, { limitInputPixels: 50000000 }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        thumbKey = baseKey + '_thumb.jpg'; webKey = baseKey + '_web.jpg'; originalKey = baseKey + '_orig.' + ext;
        thumbUrl = await storage.put(thumbKey, thumbBuf, 'image/jpeg');
        webUrl = await storage.put(webKey, webBuf, 'image/jpeg');
        originalUrl = await storage.put(originalKey, buf, mime);
      } else {
        originalKey = baseKey + '_orig.' + ext;
        originalUrl = await storage.put(originalKey, buf, mime);
      }

      const posR = await pool.query(
        "SELECT COALESCE(MAX(position), -1) AS max_pos FROM attachments WHERE entity_type = 'service_ticket' AND entity_id = $1",
        [ticket.id]
      );
      const position = (posR.rows[0] && posR.rows[0].max_pos != null) ? Number(posR.rows[0].max_pos) + 1 : 0;

      const ins = await pool.query(
        // uploaded_by is NULL by design — this door is a logged-out crew
        // member, so there is no user to attribute. organization_id is stamped
        // from the PARENT TICKET row already in hand (loadTicketShare
        // SELECTed it), never from the request. That is the same evidence the
        // read path uses to resolve the tenant.
        `INSERT INTO attachments (id, entity_type, entity_id, folder, filename, mime_type, size_bytes, width, height, thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, uploaded_by, organization_id)
         VALUES ($1,'service_ticket',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id, filename, thumb_url, web_url, original_url`,
        [id, ticket.id, 'general', req.file.originalname, mime, buf.length, width, height,
         thumbUrl, webUrl, originalUrl, thumbKey, webKey, originalKey, position, null,
         ticket.organization_id]
      );

      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1', [share.id])
        .catch(function () {});
      await logEvent(ticket, 'photo_added', {
        actorKind: 'share', shareId: share.id,
        actorLabel: share.recipient_name || share.recipient_email || null,
        detail: { mime: mime },
      });

      res.json({ ok: true, attachment: ins.rows[0] });
    } catch (e) {
      console.error('[service-ticket-share] guest photo failed', e);
      res.status(500).json({ error: 'Something went wrong uploading that.' });
    }
  });

module.exports = router;
