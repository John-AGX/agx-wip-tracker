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
const { requireAuth, requireOrgId } = require('../auth');
const { assertEntityInOrg, callerOrgId } = require('../org-access');
const svc = require('../services/service-tickets');
const access = require('../services/service-ticket-access');
const workOrder = require('../services/service-ticket-workorder');

const router = express.Router();

const TICKET_NOT_FOUND = 'Service ticket not found';

// WHO MAY READ OR EDIT A TICKET is decided in services/service-ticket-access.js
// and nowhere else. This file used to carry its own writeCapFor/readCapFor,
// which accepted JOBS_VIEW_ASSIGNED / JOBS_EDIT_OWN and then never asked whether
// the job was actually the caller's — so a crew lead granted one job could read
// and edit the tickets on every job in the company. The AI doors copy whatever
// rule the REST doors use, so the rule has to be the real one here first.
//
// What stays local is only the HTTP translation of a refusal:
//   not_assigned  -> 404 with the SAME body a missing ticket gets. An in-org
//                    user must not be able to learn which tickets exist on jobs
//                    they are not on; a 403 would answer exactly that.
//   no_capability -> 403 naming the capabilities, as requireCapability did.
//   anything else -> 403. bad_mode / no_user / no_parent / auth_unavailable are
//                    all "this request cannot be authorized", never a pass.
//
// It is a call inside each handler rather than route middleware because the
// answer depends on the PARENT, which is only known once the row is loaded.
// Returns true when the caller may proceed. A false return means the response
// has already been written: `if (!(await ticketAccessOk(...))) return;`.
async function ticketAccessOk(req, res, parent, mode, orgId, notFoundBody) {
  const verdict = await access.mayAccessTicketParent({
    // An arrow rather than pool.query itself: node-pg's query is a method and
    // loses its `this` when handed around bare.
    query: (sql, params) => pool.query(sql, params),
    user: req.user,
    parent,
    mode,
    orgId,
  });
  if (verdict && verdict.ok === true) return true;
  const reason = verdict && verdict.reason;
  if (reason === 'not_assigned') {
    res.status(404).json({ error: notFoundBody || TICKET_NOT_FOUND });
    return false;
  }
  if (reason === 'no_capability') {
    const caps = access.capsForParentKind(access.parentOf(parent).kind, mode);
    res.status(403).json({ error: 'Missing capability: ' + caps.join(' ') });
    return false;
  }
  res.status(403).json({ error: 'You do not have access to this service ticket' });
  return false;
}

// The caller's numeric id, for the private-to-do boundary (`owner_user_id =
// $n`). A missing or non-numeric id becomes NULL, and `owner_user_id = NULL` is
// never true in SQL — so a caller with no usable identity sees org tasks only.
// It fails closed by construction rather than by a check someone must keep.
function callerUserId(req) {
  const raw = req && req.user ? req.user.id : null;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// PROVE a body-supplied assignee belongs to this organization before it is
// written. The foreign key only proves the user EXISTS, not whose they are, so
// without this a ticket could be assigned to another tenant's user — a
// cross-tenant write that also puts this org's work order on their My Day. Same
// rule tasks-routes.js applies to a task's assignee and the participant door
// applies to a participant.
//
// Returns { ok: true, value } with the value to store (null clears it, as an
// empty string always has), or { ok: false } for anything that is not an
// in-org user id. A non-integer is refused HERE rather than handed to Postgres,
// where `id = 'abc'` is a 22P02 and would surface as a 500.
const ASSIGNEE_REFUSAL = 'Assignee is not a user in this organization';
async function proveAssignee(raw, orgId) {
  if (raw === null || raw === '') return { ok: true, value: null };
  let n = NaN;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0 || orgId == null) return { ok: false };
  const { rows } = await pool.query(
    'SELECT 1 FROM users WHERE id = $1 AND organization_id = $2',
    [n, orgId]
  );
  return rows.length ? { ok: true, value: n } : { ok: false };
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
  'updated_at', 'materials',
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

    // WHICH TICKETS THIS CALLER MAY SEE AT ALL. This list used to check the org
    // and nothing else, so any signed-in user — a role with no job or lead
    // capability whatsoever — could list every ticket with its scope and
    // internal notes. The list cannot ask mayAccessTicketParent one row at a
    // time, so listVisibility says what the same rule allows and it is written
    // here as SQL, in the WHERE, where a row that should not come back never
    // leaves the database:
    //   jobs 'all'      -> every job-parented ticket
    //   jobs 'assigned' -> only tickets whose job the caller owns or holds a
    //                      job_access grant on (ANY level — a view grant sees)
    //   leads           -> lead-only tickets; a converted lead's ticket that
    //                      also carries a job is governed by the job, exactly
    //                      as parentOf decides it
    // Nothing visible is an EMPTY LIST, not an error: the tickets tab of a
    // role that cannot see any is an empty tab, and a 403 there would only
    // teach the client to treat the list as broken.
    //
    // The owner / grant subqueries carry no org predicate of their own, and
    // that is deliberate rather than an omission. They return nothing — they
    // only NARROW a ticket row already pinned by `t.organization_id = $1` —
    // and they match on the caller's own user id.
    //
    // What makes that sound is NOT that job_id is frozen after create. It is
    // not: a lead's tickets are stamped with the job the lead becomes. It is
    // that EVERY door that writes service_tickets.job_id first proves the job
    // is the ticket's org's:
    //   * REST create (A2 below) — assertEntityInOrg('job', id, req.orgId),
    //     then the INSERT stamps that same org on the ticket.
    //   * the Scribe's create (payload-dispatcher.js dispatchServiceTicket) —
    //     proveTicketParentInOrg on the apply transaction, then the INSERT
    //     stamps that same org.
    //   * job-routes.js POST /convert — the job is INSERTed under req.orgId and
    //     the carry-forward UPDATE is pinned to that org, in one transaction.
    //   * job-routes.js POST /:id/link-estimate — the job is loaded FOR UPDATE
    //     under the caller's org and the carry-forward UPDATE is pinned to that
    //     org, in the same transaction.
    // No edit door can move job_id at all: PATCH's EDITABLE_FIELDS, the
    // dispatcher's update loop, a revision accept (PROPOSABLE_FIELDS) and the
    // guest field report each leave it out by allow-list. A NEW writer of
    // job_id must carry the same proof. Without it, a ticket could name another
    // tenant's job, and a grant on THAT job would list this org's ticket here
    // while the detail door — which loads the job under the caller's org —
    // answers 404 for the same row.
    //
    // Every one of those proofs, like mayAccessTicketParent, still admits a
    // legacy job whose org was never stamped. Adding `j.organization_id =
    // t.organization_id` here would make this list DISAGREE with the detail
    // door for exactly that job.
    const vis = access.listVisibility(req.user);
    const visible = [];
    if (vis.jobs === 'all') {
      visible.push('t.job_id IS NOT NULL');
    } else if (vis.jobs === 'assigned' && vis.userId != null) {
      params.push(vis.userId);
      const me = '$' + params.length;
      visible.push(
        `(t.job_id IS NOT NULL AND (
            EXISTS (SELECT 1 FROM jobs j WHERE j.id = t.job_id AND j.owner_id = ${me})
            OR EXISTS (SELECT 1 FROM job_access a WHERE a.job_id = t.job_id AND a.user_id = ${me})))`
      );
    }
    if (vis.leads) visible.push('(t.job_id IS NULL AND t.lead_id IS NOT NULL)');
    if (!visible.length) return res.json({ tickets: [] });
    where.push('(' + visible.join(' OR ') + ')');

    // The caller's id, for the private-to-do boundary on the progress counts.
    params.push(callerUserId(req));
    const caller = '$' + params.length;

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

    // Task progress is computed in SQL rather than by fetching every task:
    // the list renders a "3/8" bar per row and N+1 queries for that would be a
    // page load. The subquery carries its OWN org predicate — a child must
    // never be reached on parent-id membership alone.
    //
    // And its own PRIVACY predicate. A personal to-do can carry a
    // service_ticket_id, and it belongs to its owner alone — read_tasks and
    // GET /api/tasks both withhold another user's. Counting it here would put
    // the existence of someone's private to-dos on every viewer's progress bar,
    // and the bar would disagree with the detail door, which lists the same
    // rows under the same predicate.
    const { rows } = await pool.query(
      `SELECT ${TICKET_COLS.split(', ').map((c) => 't.' + c).join(', ')},
              (SELECT COUNT(*)::int FROM tasks k
                WHERE k.service_ticket_id = t.id AND k.organization_id = t.organization_id
                  AND k.archived_at IS NULL
                  AND (k.scope = 'org' OR (k.scope = 'personal' AND k.owner_user_id = ${caller}))) AS task_total,
              (SELECT COUNT(*)::int FROM tasks k
                WHERE k.service_ticket_id = t.id AND k.organization_id = t.organization_id
                  AND k.archived_at IS NULL AND k.status = 'done'
                  AND (k.scope = 'org' OR (k.scope = 'personal' AND k.owner_user_id = ${caller}))) AS task_done
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

    // THE DECIDING PARENT IS SETTLED COMPLETELY BEFORE THE OTHER ONE IS LOOKED
    // AT. The job decides when both are named, the same way parentOf decides it
    // for a stored ticket.
    //
    // First PROVE it is this org's. assertEntityInOrg is fail-closed and answers
    // the same for "absent" and "another tenant's", so this cannot be used to
    // probe ids.
    const parent = { job_id: jobId, lead_id: leadId };
    const parentMissing = jobId ? 'Job not found' : 'Lead not found';
    if (!(await assertEntityInOrg(jobId ? 'job' : 'lead', jobId || leadId, orgId))) {
      return res.status(404).json({ error: parentMissing });
    }

    // Then WRITE access on it, AFTER the in-org proof — so a foreign or absent
    // parent is always the 404 above and never reaches a capability answer that
    // could tell the two apart. A narrow-tier user raising a ticket on a job they
    // do not own and hold no edit grant on gets the same "Job not found" an
    // absent job gets.
    if (!(await ticketAccessOk(req, res, parent, 'write', orgId, parentMissing))) return;

    // Only NOW the secondary lead. Proving it before the access answer above
    // was an existence oracle on the job: {job not yours, bogus lead} answered
    // "Lead not found" while {absent job, bogus lead} answered "Job not found",
    // so a narrow-tier user could tell which job ids exist. The Scribe's create
    // (payload-dispatcher.js dispatchServiceTicket) settles the parents in this
    // same order.
    if (jobId && leadId && !(await assertEntityInOrg('lead', leadId, orgId))) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const id = newId('st');
    const cols = ['id', 'organization_id', 'job_id', 'lead_id', 'title', 'created_by'];
    const vals = [id, orgId, jobId, leadId, title, (req.user && req.user.id) || null];

    // Optional fields go through the same allow-list the PATCH door uses, so
    // create and edit cannot accept different sets.
    for (const k of Object.keys(body)) {
      if (!EDITABLE_FIELDS.has(k) || k === 'title') continue;
      if (body[k] === undefined) continue;
      let v = body[k] === '' ? null : body[k];
      if (k === 'assignee_user_id') {
        const proved = await proveAssignee(body[k], orgId);
        if (!proved.ok) return res.status(400).json({ error: ASSIGNEE_REFUSAL });
        v = proved.value;
      }
      cols.push(k);
      vals.push(v);
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
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });

    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;

    const callerId = callerUserId(req);

    // Each child read carries its own org predicate. Reaching a child on the
    // ticket id alone would trust that the ticket lookup above was the only
    // door — true today, and exactly the assumption that rots.
    //
    // The TASK read also carries read_tasks' privacy boundary. A personal
    // to-do may hang off a ticket (tasks-routes accepts service_ticket_id on a
    // personal row), and without this predicate opening the ticket handed its
    // title to every viewer — and to 86, whose ticket read copies this query.
    // progress below is computed from these SAME rows, so the "3/8" can never
    // count a row the list did not show.
    const [tasks, events] = await Promise.all([
      pool.query(
        `SELECT id, title, status, due_date, assignee_user_id, completed_at, archived_at
           FROM tasks
          WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL
            AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $3))
          ORDER BY created_at ASC`,
        [ticket.id, orgId, callerId]
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
      // LEFT JOINed for the same reason the dedicated inbox route is: a
      // suggestion that arrived through a link the office has since revoked
      // still lists, flagged, rather than disappearing. Same shape as
      // GET /service-tickets/:id/revisions so the UI has one row to render.
      pool.query(
        `SELECT r.id, r.author_label, r.fields, r.note, r.status, r.resolved_at,
                r.created_at,
                (s.id IS NOT NULL AND s.revoked_at IS NOT NULL) AS via_revoked_link
           FROM service_ticket_revisions r
           LEFT JOIN service_ticket_shares s ON s.id = r.share_id
          WHERE r.ticket_id = $1 AND r.organization_id = $2
          ORDER BY r.created_at DESC LIMIT 50`,
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

    // The work-order view: where the work is, and each subtask's completion
    // photos. Read AFTER the task list so photos are fetched only for the tasks
    // this caller was shown (a private to-do's photos never ride along).
    const [site, photosByTask, activity] = await Promise.all([
      workOrder.workOrderSite(pool, ticket),
      workOrder.taskPhotosByTask(pool, orgId, tasks.rows.map((t) => t.id)),
      workOrder.subtaskActivity(pool, orgId, ticket.id),
    ]);

    res.json({
      ticket,
      site,
      tasks: tasks.rows.map(function (t) {
        const act = activity.get(String(t.id)) || { notes: [], completed_by: null };
        return Object.assign({}, t, {
          photos: photosByTask.get(String(t.id)) || [],
          notes: act.notes,
          completed_by: t.status === 'done' ? act.completed_by : null,
        });
      }),
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
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });

    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

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
      if (k === 'assignee_user_id' && v !== undefined) {
        // Proved before ANY statement runs, so a refused assignee leaves the
        // other fields in the same body unwritten too — a half-applied edit
        // answering 400 would be worse than either outcome.
        const proved = await proveAssignee(v, orgId);
        if (!proved.ok) return res.status(400).json({ error: ASSIGNEE_REFUSAL });
        v = proved.value;
      }
      params.push(v);
      sets.push(k + ' = $' + params.length);
      changed.push(k);
    }
    if (Array.isArray(body.checklist)) {
      params.push(JSON.stringify(svc.normalizeChecklist(body.checklist)));
      sets.push('checklist = $' + params.length);
      changed.push('checklist');
    }
    // The optional material list — description and quantity only. An empty
    // list clears it (NULL), so the crew link shows no Materials card.
    if (Array.isArray(body.materials) || body.materials === null) {
      const list = svc.normalizeMaterials(body.materials);
      params.push(list.length ? JSON.stringify(list) : null);
      sets.push('materials = $' + params.length + '::jsonb');
      changed.push('materials');
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

// ── Work-order subtasks (John, 2026-09-13) ─────────────────────────────
// Completing a subtask needs a completion photo, and the ticket follows its
// subtasks — both decided in services/service-ticket-workorder.js
// setSubtaskDone, which the crew link calls too, so the office checkbox and the
// crew's Mark complete cannot follow different rules. Photos themselves go
// through the ordinary attachment door (POST /api/attachments/task/:id, tagged
// "before" for a before photo).
router.post('/:id/subtasks/:taskId/done', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
    if (svc.isTerminal(ticket.status)) {
      return res.status(409).json({ error: 'This ticket is ' + ticket.status + '. Reopen it before changing subtasks.' });
    }
    const result = await workOrder.setSubtaskDone(pool, {
      ticket,
      taskId: req.params.taskId,
      done: !!(req.body && req.body.done),
      actor: { kind: 'user', userId: (req.user && req.user.id) || null, label: (req.user && req.user.name) || null },
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, task: result.task, ticket_status: result.ticketStatus });
  } catch (e) {
    console.error('[service-tickets] subtask done failed', e);
    res.status(500).json({ error: 'Failed to update the subtask' });
  }
});

router.post('/:id/subtasks/:taskId/note', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
    const result = await workOrder.addSubtaskNote(pool, {
      ticket,
      taskId: req.params.taskId,
      note: req.body && req.body.note,
      actor: { kind: 'user', userId: (req.user && req.user.id) || null, label: (req.user && req.user.name) || null },
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    console.error('[service-tickets] subtask note failed', e);
    res.status(500).json({ error: 'Failed to add the note' });
  }
});

// ── A5: status ──────────────────────────────────────────────────────────
// Its own door so the transition lattice is enforced in exactly one place.
router.post('/:id/status', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });

    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

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

    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

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

    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;

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
