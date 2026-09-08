// Service tickets — the authenticated doors.
//
// A ticket is a WORK ORDER raised on a job or a lead. It has no capability of
// its own: it INHERITS its parent's, so whoever may edit the job may edit its
// tickets and whoever may only view it may only read them. That is deliberate
// — a second capability namespace would need a role-config step nobody does,
// and it would let the two drift apart.
//
// The public/token side lives in service-ticket-share-routes.js (slice S4), so
// this file has no unauthenticated door at all.
//
// TENANCY. These are new NOT NULL tables with no legacy un-stamped rows, so
// every statement carries a bare `organization_id = $n` predicate and NO
// legacy tolerance arm. That arm exists on jobs/leads only because their org
// column was added late; copying it into a table that never had un-stamped
// rows would permanently widen a boundary for nothing.
//
// (Deliberately not spelling the arm out literally here: the graduation
// ledger in test/tenancy-graduation.test.js counts occurrences of that exact
// string across server/, and a comment explaining its ABSENCE would inflate
// the number it uses to track how much of the codebase still needs it.)
//
// A foreign or missing id is always 404, never 403. A 403 is an existence
// oracle: it answers "does this id exist in some other tenant?" without any
// read of that tenant.
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability, requireOrgId } = require('../auth');
const { assertEntityInOrg, callerOrgId } = require('../org-access');
const svc = require('../services/service-tickets');

const router = express.Router();

// The ticket inherits its parent's capability. The space-separated list means
// ANY of them grants access — requireCapability splits on whitespace. (That
// split was added because passing the whole string to an exact caps.has() made
// every route written in the documented style 403 to everyone, including a
// capability-complete system admin.)
function writeCapFor(ticket) {
  return ticket && ticket.job_id ? 'JOBS_EDIT_ANY JOBS_EDIT_OWN' : 'LEADS_EDIT';
}
function readCapFor(ticket) {
  return ticket && ticket.job_id ? 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED' : 'LEADS_VIEW';
}

// A4's allow-list. Anything outside is silently dropped — the same shape
// tasks-routes.js uses, which is what makes the dynamic SET safe: a key that
// is not in this set can never reach the SQL.
//
// Deliberately absent: `status` (it has its own door, A5, so the transition
// lattice is checked in exactly one place), `job_id`, `lead_id`,
// `organization_id`, `ticket_number`, `created_by`, and every *_at.
const EDITABLE_FIELDS = new Set([
  'title', 'scope_proposed', 'scope_approved', 'internal_notes', 'priority',
  'requested_by', 'site_contact_name', 'site_contact_phone',
  'street_address', 'city', 'state', 'zip', 'lat', 'lng', 'access_notes',
  'scheduled_for', 'due_date', 'assignee_user_id',
]);

// Columns a client is allowed to see. SELECT * would hand a future column to
// the browser by default; this names them.
const TICKET_COLS = [
  'id', 'organization_id', 'ticket_number', 'title', 'job_id', 'lead_id',
  'status', 'priority', 'scope_proposed', 'scope_approved', 'internal_notes',
  'checklist', 'guest_log', 'requested_by', 'site_contact_name',
  'site_contact_phone', 'street_address', 'city', 'state', 'zip', 'lat', 'lng',
  'access_notes', 'scheduled_for', 'due_date', 'assignee_user_id',
  'completed_at', 'closed_at', 'archived_at', 'created_by', 'created_at',
  'updated_at',
].join(', ');

function newId(prefix) { return svc.genId(prefix); }

// Append an event. Never throws into the caller: the timeline is evidence, and
// losing a row is worse than a 500 but far better than failing the write that
// the row describes. Callers that need atomicity pass a transaction client.
async function logEvent(client, ticket, kind, opts) {
  const o = opts || {};
  try {
    await (client || pool).query(
      `INSERT INTO service_ticket_events
         (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, actor_label, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId('ste'), ticket.organization_id, ticket.id, kind,
       o.actorKind || 'user', o.actorUserId || null, o.shareId || null,
       o.actorLabel || null, JSON.stringify(o.detail || {})]
    );
  } catch (e) {
    console.error('[service-tickets] event log failed', kind, e.message);
  }
}

// Load a ticket and PROVE it is the caller's. Returns null for both "does not
// exist" and "belongs to another org" — the caller turns either into a 404.
async function loadOwnedTicket(id, orgId) {
  if (!orgId) return null;
  const { rows } = await pool.query(
    `SELECT ${TICKET_COLS} FROM service_tickets WHERE id = $1 AND organization_id = $2`,
    [String(id), orgId]
  );
  return rows[0] || null;
}

// The capability check must run AFTER the row is loaded, because WHICH
// capability applies depends on whether the ticket hangs off a job or a lead.
// So it is a call inside the handler rather than route middleware.
//
// requireCapability is fully synchronous — it either calls next() or has
// already written the 403 — so this can be a plain boolean. `if (!capOk(...))
// return;` is the whole contract: a false return means the response is
// already sent.
function capOk(req, res, capList) {
  let ok = false;
  requireCapability(capList)(req, res, () => { ok = true; });
  return ok;
}

// ── A1: list ────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(409).json({ error: 'Caller has no organization' });

    const where = ['t.organization_id = $1'];
    const params = [orgId];
    // split/join, NOT String.replace: replace() with a string pattern swaps
    // only the FIRST occurrence, so the two-placeholder search clause below
    // would have shipped a literal `$$` into the SQL.
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.split('$$').join('$' + params.length));
    };

    if (req.query.job_id) add('t.job_id = $$', String(req.query.job_id));
    if (req.query.lead_id) add('t.lead_id = $$', String(req.query.lead_id));
    if (req.query.status) add('t.status = $$', svc.normalizeStatus(req.query.status));
    if (req.query.assignee) add('t.assignee_user_id = $$', Number(req.query.assignee) || -1);
    // One param, used twice — hence the split/join above.
    if (req.query.q) add('(t.title ILIKE $$ OR t.ticket_number ILIKE $$)', '%' + String(req.query.q) + '%');
    if (!req.query.include_archived) where.push('t.archived_at IS NULL');

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

    // Task progress is computed in SQL rather than by fetching every task:
    // the list renders a "3/8" bar per row and N+1 queries for that would be a
    // page load. The subquery carries its OWN org predicate — a child must
    // never be reached on parent-id membership alone.
    const { rows } = await pool.query(
      `SELECT ${TICKET_COLS.split(', ').map((c) => 't.' + c).join(', ')},
              (SELECT COUNT(*)::int FROM tasks k
                WHERE k.service_ticket_id = t.id AND k.organization_id = t.organization_id
                  AND k.archived_at IS NULL) AS task_total,
              (SELECT COUNT(*)::int FROM tasks k
                WHERE k.service_ticket_id = t.id AND k.organization_id = t.organization_id
                  AND k.archived_at IS NULL AND k.status = 'done') AS task_done
         FROM service_tickets t
        WHERE ${where.join(' AND ')}
        ORDER BY t.created_at DESC
        LIMIT ${limit}`,
      params
    );
    res.json({ tickets: rows });
  } catch (e) {
    console.error('[service-tickets] list failed', e);
    res.status(500).json({ error: 'Failed to load service tickets' });
  }
});

// ── A2: create ──────────────────────────────────────────────────────────
router.post('/', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const body = req.body || {};
    const title = String(body.title == null ? '' : body.title).trim().slice(0, 300);
    if (!title) return res.status(400).json({ error: 'A ticket needs a title' });

    const jobId = body.job_id ? String(body.job_id) : null;
    const leadId = body.lead_id ? String(body.lead_id) : null;
    if (!jobId && !leadId) {
      return res.status(400).json({ error: 'A ticket must be raised on a job or a lead' });
    }

    // PROVE the parent is this org's before inserting. assertEntityInOrg is
    // fail-closed and answers the same for "absent" and "another tenant's", so
    // this cannot be used to probe ids.
    if (jobId && !(await assertEntityInOrg('job', jobId, orgId))) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (leadId && !(await assertEntityInOrg('lead', leadId, orgId))) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // The capability depends on the parent, which is why it is checked here
    // rather than as route middleware.
    const capList = jobId ? 'JOBS_EDIT_ANY JOBS_EDIT_OWN' : 'LEADS_EDIT';
    if (!capOk(req, res, capList)) return;

    const id = newId('st');
    const cols = ['id', 'organization_id', 'job_id', 'lead_id', 'title', 'created_by'];
    const vals = [id, orgId, jobId, leadId, title, (req.user && req.user.id) || null];

    // Optional fields go through the same allow-list the PATCH door uses, so
    // create and edit cannot accept different sets.
    for (const k of Object.keys(body)) {
      if (!EDITABLE_FIELDS.has(k) || k === 'title') continue;
      if (body[k] === undefined) continue;
      cols.push(k);
      vals.push(body[k] === '' ? null : body[k]);
    }
    if (body.priority !== undefined) {
      vals[cols.indexOf('priority')] = svc.normalizePriority(body.priority);
    }
    if (Array.isArray(body.checklist)) {
      cols.push('checklist');
      vals.push(JSON.stringify(svc.normalizeChecklist(body.checklist)));
    }

    const ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
    const { rows } = await pool.query(
      `INSERT INTO service_tickets (${cols.join(', ')}) VALUES (${ph}) RETURNING ${TICKET_COLS}`,
      vals
    );
    const ticket = rows[0];
    await logEvent(null, ticket, 'created', {
      actorUserId: (req.user && req.user.id) || null,
      detail: { parent: jobId ? 'job' : 'lead' },
    });
    res.json({ ok: true, ticket });
  } catch (e) {
    console.error('[service-tickets] create failed', e);
    res.status(500).json({ error: 'Failed to create service ticket' });
  }
});

// ── A3: read one ────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });

    if (!capOk(req, res, readCapFor(ticket))) return;

    // Each child read carries its own org predicate. Reaching a child on the
    // ticket id alone would trust that the ticket lookup above was the only
    // door — true today, and exactly the assumption that rots.
    const [tasks, events] = await Promise.all([
      pool.query(
        `SELECT id, title, status, due_date, assignee_user_id, completed_at, archived_at
           FROM tasks
          WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL
          ORDER BY created_at ASC`,
        [ticket.id, orgId]
      ),
      pool.query(
        `SELECT id, kind, actor_kind, actor_user_id, actor_label, detail, created_at
           FROM service_ticket_events
          WHERE ticket_id = $1 AND organization_id = $2
          ORDER BY created_at DESC LIMIT 50`,
        [ticket.id, orgId]
      ),
    ]);

    // Shares, revisions and participants have their own routes for the
    // list/act flows; they ride along here so opening a ticket is ONE request
    // rather than four. Each carries its own org predicate — a child is never
    // reached on ticket-id membership alone.
    const [shares, revisions, participants] = await Promise.all([
      pool.query(
        `SELECT id, scope, recipient_name, recipient_email, expires_at, opened_at,
                revoked_at, view_count, created_at
           FROM service_ticket_shares
          WHERE ticket_id = $1 AND organization_id = $2
          ORDER BY created_at DESC`,
        [ticket.id, orgId]
      ),
      pool.query(
        `SELECT id, author_label, fields, note, status, resolved_at, created_at
           FROM service_ticket_revisions
          WHERE ticket_id = $1 AND organization_id = $2
          ORDER BY created_at DESC LIMIT 50`,
        [ticket.id, orgId]
      ),
      pool.query(
        `SELECT p.id, p.user_id, p.access_level, p.created_at, u.name AS user_name
           FROM service_ticket_participants p
           LEFT JOIN users u ON u.id = p.user_id AND u.organization_id = p.organization_id
          WHERE p.ticket_id = $1 AND p.organization_id = $2
          ORDER BY p.created_at ASC`,
        [ticket.id, orgId]
      ),
    ]);

    res.json({
      ticket,
      tasks: tasks.rows,
      events: events.rows,
      progress: svc.ticketProgress(ticket, tasks.rows),
      shares: shares.rows.map(function (r) {
        return Object.assign({}, r, { state: svc.shareLifecycle(r) });
      }),
      revisions: revisions.rows,
      participants: participants.rows,
    });
  } catch (e) {
    console.error('[service-tickets] read failed', e);
    res.status(500).json({ error: 'Failed to load service ticket' });
  }
});

// ── A4: edit ────────────────────────────────────────────────────────────
router.patch('/:id', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });

    if (!capOk(req, res, writeCapFor(ticket))) return;

    if (svc.isTerminal(ticket.status)) {
      return res.status(409).json({
        error: 'This ticket is ' + ticket.status + '. Reopen it before editing.',
      });
    }

    const body = req.body || {};
    const sets = [];
    const params = [];
    const changed = [];
    for (const k of Object.keys(body)) {
      if (!EDITABLE_FIELDS.has(k)) continue;
      let v = body[k];
      if (k === 'priority') v = svc.normalizePriority(v);
      if (v === '') v = null;
      params.push(v);
      sets.push(k + ' = $' + params.length);
      changed.push(k);
    }
    if (Array.isArray(body.checklist)) {
      params.push(JSON.stringify(svc.normalizeChecklist(body.checklist)));
      sets.push('checklist = $' + params.length);
      changed.push('checklist');
    }
    if (!sets.length) return res.json({ ok: true, ticket });

    params.push(ticket.id, orgId);
    const { rows } = await pool.query(
      `UPDATE service_tickets SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length - 1} AND organization_id = $${params.length}
      RETURNING ${TICKET_COLS}`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Service ticket not found' });

    // detail is SHAPE, not contents — field NAMES only. Never the values: a
    // scope or a site contact is not something the event log should carry.
    await logEvent(null, rows[0], 'field_changed', {
      actorUserId: (req.user && req.user.id) || null,
      detail: { fields: changed },
    });
    res.json({ ok: true, ticket: rows[0] });
  } catch (e) {
    console.error('[service-tickets] patch failed', e);
    res.status(500).json({ error: 'Failed to update service ticket' });
  }
});

// ── A5: status ──────────────────────────────────────────────────────────
// Its own door so the transition lattice is enforced in exactly one place.
router.post('/:id/status', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });

    if (!capOk(req, res, writeCapFor(ticket))) return;

    const next = String((req.body || {}).status || '');
    const verdict = svc.ticketMayTransition(ticket.status, next, 'user');
    if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
    if (next === ticket.status) return res.json({ ok: true, ticket });

    // completed_at is set when the work is reported done and CLEARED when the
    // ticket moves back off it — the task-share precedent never clears its
    // equivalent, which leaves a reopened item claiming a completion date.
    const stamps = [];
    if (next === 'work_complete') stamps.push('completed_at = COALESCE(completed_at, NOW())');
    if (next === 'in_progress' || next === 'scheduled' || next === 'open') stamps.push('completed_at = NULL');
    if (next === 'closed') stamps.push('closed_at = NOW()');
    if (next === 'open') stamps.push('closed_at = NULL');

    const { rows } = await pool.query(
      `UPDATE service_tickets
          SET status = $1${stamps.length ? ', ' + stamps.join(', ') : ''}, updated_at = NOW()
        WHERE id = $2 AND organization_id = $3
      RETURNING ${TICKET_COLS}`,
      [next, ticket.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Service ticket not found' });

    await logEvent(null, rows[0], 'status_changed', {
      actorUserId: (req.user && req.user.id) || null,
      detail: { from: ticket.status, to: next },
    });
    res.json({ ok: true, ticket: rows[0] });
  } catch (e) {
    console.error('[service-tickets] status failed', e);
    res.status(500).json({ error: 'Failed to change status' });
  }
});

// ── A6: archive (soft) ──────────────────────────────────────────────────
// Never a hard delete: a work order is a record of dispatched work, and its
// child tasks carry ON DELETE SET NULL precisely so field work survives.
router.delete('/:id', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });

    if (!capOk(req, res, writeCapFor(ticket))) return;

    // A second archive is a 404, not a re-stamp, so the record keeps the
    // moment it was actually archived.
    const { rows } = await pool.query(
      `UPDATE service_tickets SET archived_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL
      RETURNING id`,
      [ticket.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Service ticket not found' });
    await logEvent(null, ticket, 'field_changed', {
      actorUserId: (req.user && req.user.id) || null,
      detail: { fields: ['archived_at'] },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[service-tickets] archive failed', e);
    res.status(500).json({ error: 'Failed to archive service ticket' });
  }
});

// ── A7: events ──────────────────────────────────────────────────────────
router.get('/:id/events', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });

    if (!capOk(req, res, readCapFor(ticket))) return;

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const { rows } = await pool.query(
      `SELECT id, kind, actor_kind, actor_user_id, actor_label, detail, created_at
         FROM service_ticket_events
        WHERE ticket_id = $1 AND organization_id = $2
        ORDER BY created_at DESC LIMIT ${limit}`,
      [ticket.id, orgId]
    );
    res.json({ events: rows });
  } catch (e) {
    console.error('[service-tickets] events failed', e);
    res.status(500).json({ error: 'Failed to load the timeline' });
  }
});

module.exports = router;
