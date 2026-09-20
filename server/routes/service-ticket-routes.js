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
const { requireAuth, requireOrgId, hasCapability } = require('../auth');
const { attachmentInOrg } = require('../services/attachment-org-scope');
const { assertEntityInOrg, callerOrgId } = require('../org-access');
const svc = require('../services/service-tickets');
const access = require('../services/service-ticket-access');
const workOrder = require('../services/service-ticket-workorder');
const ticketNotify = require('../services/service-ticket-notify');
const board = require('../services/service-ticket-board');
const review = require('../services/work-order-review');
const fields = require('../services/service-ticket-fields');
const assignees = require('../services/service-ticket-assignees');
const inflight = require('../services/inflight');
const notices = require('../services/work-order-notices');
// 1.33: the one place that says in SQL what a work-order building is
// (notAWorkOrderBuildingSql). 1.35: and what "a work order that is MINE and
// still has an open building" is (myOpenBuildingSql) — responsibility sits on
// the record, never on a building. GET /my-buildings below is the second's
// only caller here.
const subtaskDoor = require('../services/service-ticket-subtask-door');
// 1.29: what the crew flagged and what the office has seen (B4), and the change
// orders started from a work order (B8). Office reads only.
const flagSvc = require('../services/service-ticket-flags');
const ticketCo = require('../services/service-ticket-change-order');

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

// PROVE a body-supplied assignee before it is written. The foreign key only
// proves the user EXISTS, not whose they are, so without a proof a ticket could
// be assigned to another tenant's user — a cross-tenant write that also puts
// this org's work order on their My Day.
//
// The proof lives in services/service-ticket-assignees.js
// proveAssigneeForParent, and it asks more than "in this org": the person must
// be switched on and able to OPEN the ticket's job or lead (the rule every
// ticket door asks), so an assignment never points at a work order its assignee
// gets a 404 on. The shape of the id, and the sentence for "not a user here"
// (ASSIGNEE_REFUSAL), come from services/service-ticket-fields.js — one copy.
// A refusal answers 400 { error, field: 'assignee_user_id' }.
const ASSIGNEE_FIELD = 'assignee_user_id';

// The ticket's own address. A change to any of these with no new coordinates
// clears lat/lng, so Navigate never pairs a new address with an old pin.
const ADDRESS_FIELDS = Object.freeze(['street_address', 'city', 'state', 'zip']);
const COORD_FIELDS = Object.freeze(['lat', 'lng']);

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function actorOf(req) {
  return {
    kind: 'user',
    userId: (req.user && req.user.id) || null,
    label: (req.user && req.user.name) || null,
  };
}

// A fire-and-forget notice, handed to services/inflight.js so a deploy lets it
// finish. The function is looked up on its module object at call time (tests
// and the notice cron replace it there), and a synchronous throw is caught the
// same as a rejection: a notice never fails the write that justified it.
function trackNotice(label, start) {
  try {
    return inflight.track(start(), label);
  } catch (e) {
    console.warn('[service-tickets] ' + label + ' failed to start:', e && e.message);
    return null;
  }
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
  'updated_at', 'materials', 'crew_takeoff',
  // 1.29: the approval notice's bookkeeping (the office banner reads it) and
  // who approved or cancelled the work order, and when. Office only — none of
  // these is in svc.PUBLIC_TICKET_KEYS.
  'approval_notified_at', 'approval_notice_attempts', 'approval_notice_gave_up_at',
  'approved_at', 'approved_by', 'cancelled_at', 'cancelled_by',
].join(', ');

// What a work order may carry to someone whose only claim on it is that it is
// ASSIGNED TO THEM. Projection by INCLUSION, like svc.PUBLIC_TICKET_KEYS: a
// column added to service_tickets later must not appear here by default.
// NO MONEY, NO OFFICE TEXT: no internal_notes, no scope_proposed, no
// scope_approved, no materials, no crew_takeoff, no guest_log, no
// requested_by, no assignee_user_id, no created_by.
//
// It DELIBERATELY widens what an assignee learns beyond what they could read
// anywhere else: the job's number and title, the site address and the work
// order's own title, for a job they may not be able to open at all. That is
// the point — a crew lead handed a work order has to know where to go. Nothing
// past that, and test/work-order-my-buildings-door.test.js asserts the key set
// EXACTLY rather than as a subset, so a new column cannot be added silently.
//
// THE THREE my_* KEYS KEEP THEIR NAMES AND CHANGE THEIR MEANING (1.35). They
// counted "buildings on this work order assigned to me" — a count of a field
// nothing sets, so every one of them was zero on a normal job. They now count
// the work order's OWN buildings, because everyone assigned the record is
// equally responsible for all of them:
//   my_buildings_open   open live org buildings on this work order
//   my_buildings_total  live org buildings on it, open and done
//   my_next_due         the earliest due date among the open ones
// The names stay so the strip, the board view and the digest keep working.
const MY_BUILDING_ROW_KEYS = Object.freeze([
  'id', 'ticket_number', 'title', 'status', 'priority',
  'scheduled_for', 'due_date', 'street_address', 'city',
  'job_id', 'lead_id', 'job_number', 'job_title', 'lead_title',
  'my_buildings_open', 'my_buildings_total', 'my_next_due', 'is_overdue',
  'buildings',
]);

// Each building object carries exactly these and nothing else. No assignee:
// a building has none, and printing one would be the per-building owner the
// owner's rule refuses.
const MY_BUILDING_TASK_KEYS = Object.freeze(['id', 'title', 'status', 'due_date', 'completed_at']);

// At most this many buildings per ticket travel inline. The strip and the
// "My work" view open each one with window.p86Tasks.openDetail(id); a punch
// list longer than this is a scrolling problem, not a paging one.
//
// WHICH 25 IS NOT ARBITRARY: the statement that fills them ranks each work
// order's punch list with the OPEN buildings first, so the cap only ever drops
// finished ones. A person sent 25 buildings they have already done has been
// sent nothing at all — see GET /my-buildings below.
const MY_BUILDINGS_PER_TICKET = 25;

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

    // board=1 is the company-wide Service Tickets page (services/service-ticket-board.js).
    // A bad view, sort or filter is refused before any statement runs.
    const bq = board.parseBoardQuery(req.query);
    if (bq.error) return res.status(400).json({ error: bq.error });

    if (req.query.job_id) add('t.job_id = $$', String(req.query.job_id));
    if (req.query.lead_id) add('t.lead_id = $$', String(req.query.lead_id));
    if (req.query.status) add('t.status = $$', svc.normalizeStatus(req.query.status));
    // 'me' is the caller and 'none' is unassigned; both used to become -1 and
    // match nothing.
    const assigneeWanted = req.query.assignee == null ? '' : String(req.query.assignee);
    if (assigneeWanted === 'none') where.push('t.assignee_user_id IS NULL');
    else if (assigneeWanted === 'me') add('t.assignee_user_id = $$', callerUserId(req) ?? -1);
    else if (req.query.assignee) add('t.assignee_user_id = $$', Number(req.query.assignee) || -1);
    // One param, used several times — hence the split/join above. The board
    // also searches the address, the job's number and title and the lead's.
    if (req.query.q) add(bq.active ? board.SEARCH_SQL : '(t.title ILIKE $$ OR t.ticket_number ILIKE $$)', '%' + String(req.query.q) + '%');
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

    // Everything `where` references, and nothing more: the board's counts
    // statement binds these alone (Postgres refuses an unreferenced parameter).
    const baseParams = params.slice();

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
    //
    // The list names each ticket's parent and assignee as LABELS (the board
    // rows of the Service Tickets page carry the same three): the job's number
    // and title, a lead-only ticket's lead title (a converted lead's ticket is
    // the job's, exactly as the visibility above decides it) and the assignee's
    // name. Each join matches the ticket's OWN org and nothing else, so a label
    // can never be read off another tenant's row — a parent that is not in this
    // org comes back as a null label, never as someone else's name. The joins
    // only decorate: they cannot add or drop a row (every join is LEFT and
    // on a primary key), and the WHERE above qualifies every column with t.
    const taskCountCols = `(SELECT COUNT(*)::int FROM tasks k
                WHERE k.service_ticket_id = t.id AND k.organization_id = t.organization_id
                  AND k.archived_at IS NULL
                  AND (k.scope = 'org' OR (k.scope = 'personal' AND k.owner_user_id = ${caller}))) AS task_total,
              (SELECT COUNT(*)::int FROM tasks k
                WHERE k.service_ticket_id = t.id AND k.organization_id = t.organization_id
                  AND k.archived_at IS NULL AND k.status = 'done'
                  AND (k.scope = 'org' OR (k.scope = 'personal' AND k.owner_user_id = ${caller}))) AS task_done`;

    // The Service Tickets page: the same where, the same visibility, a slim row.
    if (bq.active) {
      const out = await board.runBoard(pool, {
        orgId, user: req.user, userId: callerUserId(req), query: bq, where, baseParams, params, taskCountCols,
      });
      return res.status(out.status).json(out.body);
    }

    // 1.29 attention (services/service-ticket-flags.js ATTENTION_COLUMNS): open
    // problems, suggestions waiting, the last crew activity (a link merely
    // being opened is not activity) and when someone who can edit last opened
    // the ticket. Each correlated subquery carries its own org predicate.
    const { rows } = await pool.query(
      `SELECT ${TICKET_COLS.split(', ').map((c) => 't.' + c).join(', ')},
              pj.data->>'jobNumber' AS job_number,
              COALESCE(NULLIF(pj.data->>'title',''), pj.data->>'name') AS job_title,
              CASE WHEN t.job_id IS NULL THEN pl.title END AS lead_title,
              au.name AS assignee_name,
              ${taskCountCols},
              ${flagSvc.ATTENTION_COLUMNS}
         FROM service_tickets t
         LEFT JOIN jobs pj ON pj.id = t.job_id AND pj.organization_id = t.organization_id
         LEFT JOIN leads pl ON pl.id = t.lead_id AND pl.organization_id = t.organization_id
         LEFT JOIN users au ON au.id = t.assignee_user_id AND au.organization_id = t.organization_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.created_at DESC
        LIMIT ${limit}`,
      params
    );
    // Counts as numbers and new_from_crew, then the draft change orders started
    // from each ticket: a separate org-predicated read merged here, never a
    // subquery, so a database without the change order table still lists
    // (coDraftCounts answers {} on any error).
    const listed = rows.map(flagSvc.withAttention);
    const drafts = await ticketCo.coDraftCounts(pool, orgId, listed);
    for (const t of listed) t.co_draft_count = Number((drafts && drafts[String(t.id)]) || 0);
    res.json({ tickets: listed });
  } catch (e) {
    console.error('[service-tickets] list failed', e);
    res.status(500).json({ error: 'Failed to load service tickets' });
  }
});

// ── 1.29: who a ticket on this job or lead may be assigned to ─────────────
// The Assigned to picker's list. Only people who can OPEN the parent
// (services/service-ticket-assignees.js), id and name only. Asked for WRITE
// access on the parent, because only someone who can raise or edit a ticket
// there needs the list: a narrow-tier caller not on the job, an absent job and
// another tenant's job all get the same 404.
router.get('/assignees/:kind/:parentId', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const pickedKind = String(req.params.kind || '');
    if (pickedKind !== 'job' && pickedKind !== 'lead') return res.status(404).json({ error: 'Not found' });
    const pickedId = String(req.params.parentId || '');
    const pickedParent = pickedKind === 'job'
      ? { job_id: pickedId, lead_id: null }
      : { job_id: null, lead_id: pickedId };
    const pickedMissing = pickedKind === 'job' ? 'Job not found' : 'Lead not found';
    const inOrg = pickedId !== '' && (await assertEntityInOrg(pickedKind, pickedId, orgId));
    if (!inOrg) return res.status(404).json({ error: pickedMissing });
    const allowed = await ticketAccessOk(req, res, pickedParent, 'write', orgId, pickedMissing);
    if (!allowed) return;
    const users = await assignees.eligibleAssignees(pool, { orgId, parent: pickedParent });
    res.json({ users });
  } catch (e) {
    console.error('[service-tickets] assignees failed', e);
    res.status(500).json({ error: 'Failed to load the people this can be assigned to' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1.33: THE BUILDINGS I AM RESPONSIBLE FOR, AND HOW MANY ARE OPEN ON A PARENT
 *
 * A building on a work order's punch list is an ordinary org task carrying a
 * service_ticket_id. From 1.33 those rows are subtracted from every task list
 * — My Tasks, Team Tasks, the job and lead Tasks panels, My Day, the calendar,
 * the admin count, the daily email and 86's task list — because a building is
 * not a to-do. These two reads are what makes that removal safe.
 *
 * 1.35: "I am responsible for it" means THE WORK ORDER IS ASSIGNED TO ME, not
 * that some building on it carries my user id. A building is never assigned to
 * anybody; everyone on the record is equally responsible for all of it.
 *
 * ROUTE ORDER IS LOAD-BEARING. Express matches in declaration order and
 * `router.get('/:id')` is declared below, so '/my-buildings' and
 * '/building-counts' MUST stay above it or they are fed to loadOwnedTicket and
 * answered 404 as missing tickets. test/work-order-my-buildings-door.test.js
 * drives both and asserts they are not swallowed.
 * ═══════════════════════════════════════════════════════════════════════════ */

function intOf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

// One of a ticket's buildings, exactly five keys each. Not "the caller's":
// they are the WORK ORDER's, and the caller is responsible for every one.
function shapeMyBuilding(row) {
  const r = row || {};
  const out = {};
  MY_BUILDING_TASK_KEYS.forEach(function (k) { out[k] = r[k] === undefined ? null : r[k]; });
  return out;
}

// Shaped key by key through MY_BUILDING_ROW_KEYS, the way
// services/service-ticket-board.js shapeRow does it: a fresh object, null for
// anything the statement did not select. A column added to the SELECT that is
// not on the whitelist never reaches the browser.
function shapeMyBuildingRow(row, buildings) {
  const r = row || {};
  const out = {};
  MY_BUILDING_ROW_KEYS.forEach(function (k) { out[k] = r[k] === undefined ? null : r[k]; });
  out.my_buildings_open = intOf(r.my_buildings_open);
  out.my_buildings_total = intOf(r.my_buildings_total);
  out.my_next_due = r.my_next_due == null || r.my_next_due === '' ? null : String(r.my_next_due).slice(0, 10);
  out.is_overdue = truthy(r.is_overdue);
  out.buildings = buildings || [];
  const shaped = {};
  MY_BUILDING_ROW_KEYS.forEach(function (k) { shaped[k] = out[k]; });
  return shaped;
}

// The active statuses as a literal IN list, built from the board's own
// constant rather than retyped: a status added to board.STATUS_GROUPS.active
// must reach this door in the same edit.
function activeStatusIn(alias) {
  return alias + '.status IN (' +
    board.STATUS_GROUPS.active.map(function (s) { return "'" + s + "'"; }).join(', ') + ')';
}

// ── GET /my-buildings — MY work orders, and the buildings still open on them ─
//
// 1.33 shipped this as "the work orders where a BUILDING is mine" and 1.34
// keyed four more surfaces on the same idea. The field it asked,
// tasks.assignee_user_id on a building row, is one a building only has because
// a building is a task row: no screen has ever offered to set it, so on a
// normal job this door answered nothing at all while the Assigned to the
// office really fills in fed none of it. 1.35 moves the key to the record —
// THE WORK ORDER IS ASSIGNED TO ME and still has an open building — and the
// counts below follow: they are the work order's buildings, not "mine", since
// everyone on the record is equally responsible for every one of them.
//
// THIS IS THE ONE ARM THAT DELIBERATELY DOES NOT ASK
// services/service-ticket-access.js listVisibility, and it must stay that way.
// listVisibility resolves to "every job-parented ticket" (JOBS_VIEW_ALL), "the
// jobs I own or hold a job_access grant on" (JOBS_VIEW_ASSIGNED) or nothing —
// the rule GET / and the whole Service Tickets board run through. But
// services/service-ticket-subtask-door.js doneVerdict deliberately lets the
// WORK ORDER's assignee finish a building on a job they cannot otherwise open,
// so a crew lead on JOBS_VIEW_ASSIGNED with no grant on the job is a real,
// intended case. Gating this read on listVisibility would answer that person
// zero rows and strand them with no way to reach work that was handed to them
// by name — the exact regression removing buildings from the task lists exists
// to prevent. So the key here is the record's assignment and nothing else.
//
// What that costs is written down rather than waved at: the answer tells an
// assignee the job's number and title, the site address and the work order's
// own title for a job they may not be able to open. MY_BUILDING_ROW_KEYS above
// is the whole of what leaks, it is a whitelist, and the test asserts it
// exactly. No prices, no internal notes, no scope text.
router.get('/my-buildings', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const me = callerUserId(req);
    // The caller's own day, from their zone (else the org's) — never the
    // server's and never the browser's. board.boardDates is the one place.
    const dates = await board.boardDates(pool, orgId, me);
    const today = dates.today;

    const countOnly = String(req.query.count_only || '') === '1';
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offsetRaw = Number(req.query.offset);
    const offset = Number.isFinite(offsetRaw) ? Math.min(5000, Math.max(0, Math.trunc(offsetRaw))) : 0;

    // No usable identity is an EMPTY answer, never everything: `assignee_user_id
    // = NULL` is never true in SQL, but failing closed here says so out loud.
    if (me == null) {
      return res.json(countOnly
        ? { total: 0, buildings_open: 0 }
        : { tickets: [], today, total: 0, buildings_open: 0, has_more: false, next_offset: null });
    }

    // $1 org, $2 the caller. Both counts and the rows run the SAME predicate.
    const baseWhere =
      't.organization_id = $1 AND t.archived_at IS NULL AND ' + activeStatusIn('t') +
      ' AND ' + subtaskDoor.myOpenBuildingSql('t', '$2');

    // Two counts, never derived from the page: `total` is how many work orders
    // match, `buildings_open` is how many buildings are still open across all
    // of them (the number the My Day strip and the tab badge show). Each
    // carries its own organization predicate, and the buildings count re-states
    // the ticket predicate through a join rather than trusting the ticket id
    // alone.
    //
    // 1.35: the JOIN now keys on `s.assignee_user_id = $2` — the work order is
    // mine — where it used to key on `k.assignee_user_id = $2`, a building of
    // mine. Both counts must mean the same thing as the rows below, or the
    // badge says a number the list cannot show.
    const [totalRes, openRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total FROM service_tickets t WHERE ' + baseWhere, [orgId, me]),
      pool.query(
        `SELECT COUNT(*)::int AS buildings_open
           FROM tasks k
           JOIN service_tickets s ON s.id = k.service_ticket_id AND s.organization_id = k.organization_id
          WHERE k.organization_id = $1 AND k.archived_at IS NULL AND k.scope = 'org'
            AND k.status <> 'done' AND s.assignee_user_id = $2
            AND s.archived_at IS NULL AND ${activeStatusIn('s')}`,
        [orgId, me]
      ),
    ]);
    const total = intOf(totalRes.rows[0] && totalRes.rows[0].total);
    const buildingsOpen = intOf(openRes.rows[0] && openRes.rows[0].buildings_open);

    // The badge asks for the numbers alone; neither statement below runs.
    if (countOnly) return res.json({ total, buildings_open: buildingsOpen });

    // Every per-row count is a correlated subquery carrying its OWN org
    // predicate — a child is never reached on parent-id membership alone. The
    // two label joins are pinned to the ticket's own org for the same reason
    // the list route pins its: a parent in another tenant comes back as a null
    // label, never as someone else's name.
    //
    // 1.35: none of the three asks `assignee_user_id = $2` any more. WHOSE work
    // order it is was already decided by baseWhere, once, on the record; these
    // count the record's own punch list, which is what the person assigned it
    // is responsible for. $2 is still the caller — it is baseWhere's.
    const rowsSql =
      `SELECT t.id, t.ticket_number, t.title, t.status, t.priority,
              t.scheduled_for, t.due_date, t.street_address, t.city,
              t.job_id, t.lead_id,
              jl.data->>'jobNumber' AS job_number,
              COALESCE(NULLIF(jl.data->>'title',''), jl.data->>'name') AS job_title,
              CASE WHEN t.job_id IS NULL THEN ll.title END AS lead_title,
              (SELECT COUNT(*)::int FROM tasks bo
                WHERE bo.service_ticket_id = t.id AND bo.organization_id = t.organization_id
                  AND bo.archived_at IS NULL AND bo.scope = 'org'
                  AND bo.status <> 'done') AS my_buildings_open,
              (SELECT COUNT(*)::int FROM tasks bt
                WHERE bt.service_ticket_id = t.id AND bt.organization_id = t.organization_id
                  AND bt.archived_at IS NULL AND bt.scope = 'org') AS my_buildings_total,
              (SELECT MIN(bd.due_date)::text FROM tasks bd
                WHERE bd.service_ticket_id = t.id AND bd.organization_id = t.organization_id
                  AND bd.archived_at IS NULL AND bd.scope = 'org'
                  AND bd.status <> 'done') AS my_next_due,
              (t.due_date IS NOT NULL AND t.due_date < $3) AS is_overdue
         FROM service_tickets t
         LEFT JOIN jobs jl ON jl.id = t.job_id AND jl.organization_id = t.organization_id
         LEFT JOIN leads ll ON ll.id = t.lead_id AND ll.organization_id = t.organization_id
        WHERE ${baseWhere}
        ORDER BY (t.due_date IS NULL), t.due_date ASC, (t.scheduled_for IS NULL), t.scheduled_for ASC,
                 t.created_at DESC, t.id ASC
        LIMIT ${limit + 1} OFFSET ${offset}`;
    const { rows } = await pool.query(rowsSql, [orgId, me, today]);

    // One row over the limit is how has_more is decided, exactly as
    // services/service-ticket-board.js rowsStatement does it.
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    // ONE statement for the whole page's buildings, never one per ticket. The
    // crew lead cannot open POST /:id/subtasks/:taskId/done (it asks for write
    // access on the parent, which they fail), so these rows are what the client
    // hands to window.p86Tasks.openDetail(id) — without them the removal
    // strands the person this door exists to serve.
    //
    // 1.35: the WHOLE punch list of each work order on the page, not a slice of
    // it filtered by assignee. The tickets were already chosen by baseWhere as
    // the caller's, and on a record they are assigned there is no building that
    // is somebody else's.
    //
    // THE CAP TAKES THE OPEN ONES FIRST, AND TAKES THEM IN SQL. Dropping the
    // per-caller filter turned this into the record's whole punch list, and an
    // apartment community's is long. Capping it in CREATION order handed a
    // 30-building record its 25 oldest rows — which on a list worked front to
    // back are the FINISHED ones — so a person could be sent every building
    // they had already done and none of the ones still open. js/my-day.js drops
    // done rows before it renders, so the strip printed "4 buildings open" over
    // nothing to tap, and these rows are the only way in for someone who cannot
    // open the job at all.
    //
    // ROW_NUMBER() ranks each work order's OWN rows (PARTITION BY the ticket)
    // with the open ones first: `(status = 'done')` is false before true, and
    // false sorts first in both engines. created_at breaks the tie exactly as
    // this list was always ordered, and `rn <= $3` drops the rest before they
    // travel rather than after. So `buildings` carries min(my_buildings_open,
    // 25) OPEN rows — never zero while the count above says otherwise — and a
    // done row only ever fills a slot no open one wanted. `status <> 'done'` is
    // the same open/done line the three counts above and
    // services/service-ticket-subtask-door.js draw.
    const byTicket = new Map();
    if (page.length) {
      const ids = page.map(function (r) { return String(r.id); });
      const kids = await pool.query(
        `SELECT id, service_ticket_id, title, status, due_date, completed_at
           FROM (
             SELECT id, service_ticket_id, title, status, due_date, completed_at,
                    ROW_NUMBER() OVER (PARTITION BY service_ticket_id
                                       ORDER BY (status = 'done'), created_at ASC, id ASC) AS rn
               FROM tasks
              WHERE organization_id = $1 AND service_ticket_id = ANY($2::text[])
                AND archived_at IS NULL AND scope = 'org'
           ) ranked
          WHERE rn <= $3
          ORDER BY service_ticket_id ASC, rn ASC`,
        [orgId, ids, MY_BUILDINGS_PER_TICKET]
      );
      // The statement has already capped every list; the guard below is the
      // second lock on how much travels, never the thing that chooses WHICH.
      for (const k of kids.rows) {
        const key = String(k.service_ticket_id);
        const list = byTicket.get(key) || [];
        if (list.length < MY_BUILDINGS_PER_TICKET) list.push(shapeMyBuilding(k));
        byTicket.set(key, list);
      }
    }

    res.json({
      tickets: page.map(function (r) { return shapeMyBuildingRow(r, byTicket.get(String(r.id)) || []); }),
      today,
      total,
      buildings_open: buildingsOpen,
      has_more: hasMore,
      next_offset: hasMore ? offset + limit : null,
    });
  } catch (e) {
    console.error('[service-tickets] my-buildings failed', e);
    res.status(500).json({ error: 'Failed to load your buildings' });
  }
});

// ── 1.33: GET /building-counts — the line on a job's or lead's Tasks panel ─
//
// "4 buildings open across 2 work orders", above a Tasks panel that no longer
// lists them. Unlike /my-buildings this is an OFFICE surface on a page the
// caller already had to open, so it asks the file's normal per-parent rule
// (ticketAccessOk on the parent, read tier) and a caller who cannot open the
// job gets the same 404 a missing job gets. Both counts zero is a perfectly
// good answer; a parent with no buildings is never a 404.
router.get('/building-counts', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const kind = String(req.query.entity_type || '');
    if (kind !== 'job' && kind !== 'lead') return res.status(404).json({ error: 'Not found' });
    const id = String(req.query.entity_id || '');
    const missingMsg = kind === 'job' ? 'Job not found' : 'Lead not found';
    const inOrg = id !== '' && (await assertEntityInOrg(kind, id, orgId));
    if (!inOrg) return res.status(404).json({ error: missingMsg });
    const parent = kind === 'job' ? { job_id: id, lead_id: null } : { job_id: null, lead_id: id };
    if (!(await ticketAccessOk(req, res, parent, 'read', orgId, missingMsg))) return;

    // A converted lead's ticket carries the job and belongs to it, exactly as
    // services/service-ticket-access.js parentOf decides it — so it is counted
    // on the JOB's panel and the lead arm excludes it.
    const parentSql = kind === 'job' ? 's.job_id = $2' : '(s.job_id IS NULL AND s.lead_id = $2)';
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS buildings_open,
              COUNT(DISTINCT k.service_ticket_id)::int AS work_orders
         FROM tasks k
         JOIN service_tickets s ON s.id = k.service_ticket_id AND s.organization_id = k.organization_id
        WHERE k.organization_id = $1 AND k.archived_at IS NULL AND k.scope = 'org'
          AND k.status <> 'done'
          AND s.archived_at IS NULL AND ${activeStatusIn('s')}
          AND ${parentSql}`,
      [orgId, id]
    );
    const row = rows[0] || {};
    res.json({ buildings_open: intOf(row.buildings_open), work_orders: intOf(row.work_orders) });
  } catch (e) {
    console.error('[service-tickets] building-counts failed', e);
    res.status(500).json({ error: 'Failed to count the buildings on this' });
  }
});

// ── A2: create ──────────────────────────────────────────────────────────
router.post('/', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const body = req.body || {};
    // The field check runs FIRST. It does not depend on the parent, so it is no
    // existence oracle, and a bad date or an over-long scope is a 400 naming
    // the field rather than a Postgres error surfacing as a 500.
    const checked = fields.validateTicketFields(body, { mode: 'create' });
    if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field });
    const title = checked.values.title;

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
    // create and edit cannot accept different sets — and they are the CHECKED
    // values (trimmed, real dates, allowed priorities), never the raw body.
    for (const k of Object.keys(checked.values)) {
      if (!EDITABLE_FIELDS.has(k) || k === 'title' || k === ASSIGNEE_FIELD) continue;
      cols.push(k);
      vals.push(checked.values[k]);
    }

    // The assignee, only now that the parent is settled: they must be able to
    // open it.
    if (hasOwn(checked.values, ASSIGNEE_FIELD)) {
      const newAssignee = await assignees.proveAssigneeForParent(pool, {
        raw: checked.values[ASSIGNEE_FIELD], orgId, parent,
      });
      if (!newAssignee.ok) return res.status(400).json({ error: newAssignee.error, field: ASSIGNEE_FIELD });
      cols.push(ASSIGNEE_FIELD);
      vals.push(newAssignee.value);
    }

    const addressProblem = fields.ticketAddressProblem(checked.values);
    if (addressProblem) return res.status(400).json({ error: addressProblem.error, field: addressProblem.field });

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
    // Tell the new assignee, unless they raised it themselves. After the
    // INSERT, never awaited.
    const creator = actorOf(req);
    if (ticket.assignee_user_id != null && String(ticket.assignee_user_id) !== String(creator.userId)) {
      trackNotice('ticket_assignment', () => notices.notifyAssigned(pool, {
        ticket,
        assigneeUserId: ticket.assignee_user_id,
        previousAssigneeUserId: null,
        actor: creator,
      }));
    }
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
      // withIds: each building note carries its event id, so the office can
      // start a change order from it. The crew link's read leaves it out.
      workOrder.subtaskActivity(pool, orgId, ticket.id, { withIds: true }),
    ]);

    // 1.29 extras, each BEST-EFFORT: a failure reading one of them leaves it
    // empty and the ticket still opens.
    //   site_photos — the work order's own photos (not a building's), with who
    //                 added each one.
    //   review      — who approved or cancelled it, and the send-back the crew
    //                 is still working from (null once the work arrives at
    //                 Work complete again).
    //   flags       — the problems the crew flagged, open first.
    //   change_orders — the change orders started from this work order: ids,
    //                 numbers, states and titles, never lines or money.
    //   office_seen — true when this read stamped office_seen_at, which only a
    //                 caller who can EDIT the ticket does (a view grant opening
    //                 it must not clear "New from crew"). Never throws.
    const [sitePhotos, reviewRead, flags, changeOrders, officeSeen] = await Promise.all([
      (async () => workOrder.ticketSitePhotos(pool, orgId, ticket.id, { withNames: true }))().catch((e) => {
        console.warn('[service-tickets] site photos read failed', e && e.message);
        return [];
      }),
      (async () => {
        const [names, sendBack] = await Promise.all([
          review.peopleNames(pool, orgId, [ticket.approved_by, ticket.cancelled_by]),
          review.activeSendBack(pool, ticket, tasks.rows),
        ]);
        const nameOf = (id) => (id == null ? null : (names[String(id)] || null));
        return {
          approved_by_name: nameOf(ticket.approved_by),
          cancelled_by_name: nameOf(ticket.cancelled_by),
          send_back: sendBack || null,
        };
      })().catch((e) => {
        console.warn('[service-tickets] review read failed', e && e.message);
        return { approved_by_name: null, cancelled_by_name: null, send_back: null };
      }),
      (async () => flagSvc.listOfficeFlags(pool, ticket))().catch((e) => {
        console.warn('[service-tickets] flags read failed', e && e.message);
        return [];
      }),
      (async () => ticketCo.linkedChangeOrders(pool, ticket))().catch((e) => {
        console.warn('[service-tickets] change orders read failed', e && e.message);
        return [];
      }),
      (async () => flagSvc.markOfficeSeen(pool, req.user, ticket, orgId))().catch(() => false),
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
      site_photos: Array.isArray(sitePhotos) ? sitePhotos : [],
      review: reviewRead,
      flags: Array.isArray(flags) ? flags : [],
      change_orders: Array.isArray(changeOrders) ? changeOrders : [],
      office_seen: officeSeen === true,
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
    // One field check for every office write (services/service-ticket-fields.js):
    // a bad value is a 400 naming the field, and nothing is written.
    const checked = fields.validateTicketFields(body, { mode: 'update' });
    if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field });
    const values = {};
    for (const k of Object.keys(checked.values)) {
      if (EDITABLE_FIELDS.has(k)) values[k] = checked.values[k];
    }
    const checklist = Array.isArray(body.checklist) ? svc.normalizeChecklist(body.checklist) : null;
    // The optional material list — description and quantity only. An empty
    // list clears it (NULL), so the crew link shows no Materials card.
    const materials = Array.isArray(body.materials) || body.materials === null
      ? svc.normalizeMaterials(body.materials)
      : null;

    // A CHANGED assignee is proved before any statement runs, so a refusal
    // leaves the other fields in the same body unwritten too. An UNCHANGED one
    // is never re-proved: a ticket whose assignee has since lost access to the
    // job can still have its title saved.
    const proved = new Set();
    const proveNewAssignee = async (raw) => {
      const verdict = await assignees.proveAssigneeForParent(pool, { raw, orgId, parent: ticket });
      if (verdict.ok) proved.add(fields.ticketFieldComparable(ASSIGNEE_FIELD, verdict.value));
      return verdict;
    };
    if (hasOwn(values, ASSIGNEE_FIELD)
        && !fields.sameTicketFieldValue(ASSIGNEE_FIELD, ticket.assignee_user_id, values[ASSIGNEE_FIELD])) {
      const verdict = await proveNewAssignee(values[ASSIGNEE_FIELD]);
      if (!verdict.ok) return res.status(400).json({ error: verdict.error, field: ASSIGNEE_FIELD });
      values[ASSIGNEE_FIELD] = verdict.value;
    }

    // Changed-only, inside a lock on the row: what "changed" means, and whether
    // someone else got there first, is decided against the row as it is NOW.
    const client = await pool.connect();
    let inTx = false;
    let row = null;
    let locked = null;
    let changed = [];
    try {
      await client.query('BEGIN');
      inTx = true;
      const refuse = async (status, payload) => {
        inTx = false;
        await client.query('ROLLBACK');
        res.status(status).json(payload);
        return null;
      };

      const lockedRes = await client.query(
        `SELECT ${TICKET_COLS} FROM service_tickets WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [ticket.id, orgId]
      );
      locked = lockedRes.rows[0] || null;
      if (!locked) return await refuse(404, { error: TICKET_NOT_FOUND });
      if (svc.isTerminal(locked.status)) {
        return await refuse(409, { error: 'This ticket is ' + locked.status + '. Reopen it before editing.' });
      }

      // THE CONFLICT CHECK. `expected` carries, per field, the value the page
      // loaded. A field someone else changed since is refused as a whole save,
      // naming the fields, so nobody's edit is silently overwritten.
      const expected = body.expected && typeof body.expected === 'object' && !Array.isArray(body.expected)
        ? body.expected
        : null;
      const conflicts = [];
      if (expected) {
        for (const k of Object.keys(values)) {
          if (!hasOwn(expected, k) || COORD_FIELDS.indexOf(k) >= 0) continue;
          if (!fields.sameTicketFieldValue(k, locked[k], expected[k])) conflicts.push(k);
        }
      }
      if (conflicts.length) {
        return await refuse(409, {
          error: 'Someone else changed ' + fields.labelList(conflicts) + ' while you were editing. Nothing was saved.',
          code: 'edit_conflict',
          fields: conflicts,
          ticket: locked,
        });
      }

      const sets = [];
      const params = [];
      for (const k of Object.keys(values)) {
        if (fields.sameTicketFieldValue(k, locked[k], values[k])) continue;
        params.push(values[k]);
        sets.push(k + ' = $' + params.length);
        changed.push(k);
      }

      // The assignee moved under us to someone other than the value this save
      // sends: that value was never proved against the row, so prove it now.
      if (changed.indexOf(ASSIGNEE_FIELD) >= 0
          && !proved.has(fields.ticketFieldComparable(ASSIGNEE_FIELD, values[ASSIGNEE_FIELD]))) {
        const verdict = await proveNewAssignee(values[ASSIGNEE_FIELD]);
        if (!verdict.ok) return await refuse(400, { error: verdict.error, field: ASSIGNEE_FIELD });
      }

      const addressChanged = changed.some((k) => ADDRESS_FIELDS.indexOf(k) >= 0);
      if (addressChanged) {
        const problem = fields.ticketAddressProblem(Object.assign({}, locked, values));
        if (problem) return await refuse(400, { error: problem.error, field: problem.field });
        if (!hasOwn(body, 'lat') && !hasOwn(body, 'lng')) sets.push('lat = NULL', 'lng = NULL');
      }

      if (checklist) {
        params.push(JSON.stringify(checklist));
        sets.push('checklist = $' + params.length);
        changed.push('checklist');
      }
      if (materials) {
        params.push(materials.length ? JSON.stringify(materials) : null);
        sets.push('materials = $' + params.length + '::jsonb');
        changed.push('materials');
      }

      if (!changed.length) {
        inTx = false;
        await client.query('COMMIT');
        return res.json({ ok: true, ticket: locked, changed: [] });
      }

      params.push(ticket.id, orgId);
      const { rows } = await client.query(
        `UPDATE service_tickets SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${params.length - 1} AND organization_id = $${params.length}
        RETURNING ${TICKET_COLS}`,
        params
      );
      row = rows[0] || null;
      if (!row) return await refuse(404, { error: TICKET_NOT_FOUND });
      inTx = false;
      await client.query('COMMIT');
    } catch (e) {
      if (inTx) {
        try { await client.query('ROLLBACK'); } catch (_) { /* the original error matters */ }
      }
      throw e;
    } finally {
      client.release();
    }

    // After COMMIT, so a failed log can never turn the commit into a rollback.
    // detail is SHAPE, not contents — field NAMES only. Never the values: a
    // scope or a site contact is not something the event log should carry.
    await logEvent(null, row, 'field_changed', {
      actorUserId: (req.user && req.user.id) || null,
      detail: { fields: changed },
    });
    const editor = actorOf(req);
    if (changed.indexOf(ASSIGNEE_FIELD) >= 0 && row.assignee_user_id != null
        && String(row.assignee_user_id) !== String(editor.userId)) {
      trackNotice('ticket_assignment', () => notices.notifyAssigned(pool, {
        ticket: row,
        assigneeUserId: row.assignee_user_id,
        previousAssigneeUserId: locked.assignee_user_id,
        actor: editor,
      }));
    }
    res.json({ ok: true, ticket: row, changed });
  } catch (e) {
    console.error('[service-tickets] patch failed', e);
    if (res.headersSent) return;
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
//
// THE OFFICE GATE (1.29), asked by setSubtaskDone on the ticket row it holds
// LOCKED — never on the copy this request loaded a moment earlier, which a
// close or a cancel in between would make a lie. It is the ticket-writer arm of
// services/service-ticket-subtask-door.js doneVerdict, the rule My Tasks and
// the job's Tasks panel ask of the same person: whoever can edit the job may
// finish or reopen a building on any work order that is not closed or
// cancelled. Write access itself was already proved by ticketAccessOk. A
// refusal is 409 { error, code: 'work_order_locked' }.
function officeSubtaskGate(lockedRow) {
  const status = svc.normalizeStatus(lockedRow && lockedRow.status);
  if (!svc.isTerminal(status)) return { ok: true };
  return {
    ok: false,
    status: 409,
    error: 'This work order is ' + status + '. Reopen it before changing its punch list.',
    code: 'work_order_locked',
  };
}

router.post('/:id/subtasks/:taskId/done', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
    const finisher = actorOf(req);
    const result = await workOrder.setSubtaskDone(pool, {
      ticket,
      taskId: req.params.taskId,
      done: !!(req.body && req.body.done),
      actor: finisher,
      gate: officeSubtaskGate,
    });
    if (!result.ok) {
      // The refusal keeps its code (work_order_locked,
      // completion_photo_required), so the office can tell "locked" from "add
      // a photo" without reading the sentence.
      const refusal = { error: result.error };
      if (result.code) refusal.code = result.code;
      return res.status(result.status || 409).json(refusal);
    }
    // The last subtask just moved the ticket to Awaiting approval: tell the
    // approvers. Not awaited — the notice never holds up the answer — but
    // tracked, so a deploy lets it finish. It describes result.ticket, the row
    // as it was under the lock with its new status, not the pre-lock copy.
    if (result.movedTo === 'work_complete') {
      trackNotice('ticket_approval', () => ticketNotify.notifyAwaitingApproval(pool, {
        ticket: result.ticket,
        actor: finisher,
        reason: 'all_subtasks_done',
      }));
    }
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
      // The retry key, when the caller carries one (1.30). Passed straight
      // through — addSubtaskNote is the one place that decides what a key may
      // look like, so the office and crew doors cannot drift apart on it.
      clientRef: req.body && req.body.client_ref,
      actor: { kind: 'user', userId: (req.user && req.user.id) || null, label: (req.user && req.user.name) || null },
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    console.error('[service-tickets] subtask note failed', e);
    res.status(500).json({ error: 'Failed to add the note' });
  }
});

// ── Work-order materials: fill from a job file (John, 2026-09-13) ──────────
// The PM already has the takeoff — an AGX Lead Report xlsx, a Buildertrend
// export, a Home Depot CSV, a takeoff print, a photo of a pull sheet — sitting
// in the job's Files. These two doors let the Materials editor READ one of
// those files into rows for review. Neither writes anything: the rows land in
// the editor unsaved, and PATCH /:id {materials} (normalizeMaterials) stays the
// ONLY write, so a file can never put a line on the crew link that a person did
// not look at and save. Neither door puts the file itself on the crew link —
// that is its own deliberate choice, PUT /:id/crew-takeoff below.
//
// WHICH FILES. Only files hanging on the ticket's OWN job, its lead and its
// estimate — never a file id from anywhere else in the org. And each extra
// parent is gated on what the caller could already open by the front door:
//   job      — the ticket's job. The ticket's own write proof covers it, and
//              every door that writes service_tickets.job_id proves the job
//              in-org first (the list in A1 above).
//   lead     — the ticket's lead, else the lead the job came from. Needs
//              LEADS_VIEW, unless the ticket IS a lead ticket (its write proof
//              was LEADS_EDIT on that very lead). A crew lead with an edit
//              grant on one job must not read the sales lead's files through
//              the work order.
//   estimate — the estimate the job was sold from. Needs ESTIMATES_VIEW, for
//              the same reason: an estimate file is priced, and the narrow
//              tier holds no estimate capability at all.
// Each id is proved in this org before its files are listed. The jobs read is
// pinned to the org too, so a legacy un-stamped job contributes no lead or
// estimate — failing closed costs a PM a picker row, never a boundary.
async function ticketFileParents(ticket, user, orgId) {
  const parents = [];
  if (!ticket || orgId == null) return parents;
  const clean = (v) => (v == null || v === '' ? null : String(v));
  const leadOnly = access.parentOf(ticket).kind === 'lead';
  const jobId = clean(ticket.job_id);
  let leadId = clean(ticket.lead_id);
  let estimateId = null;

  if (jobId) {
    parents.push({ where: 'job', entity_type: 'job', entity_id: jobId });
    const { rows } = await pool.query(
      'SELECT lead_id, estimate_id FROM jobs WHERE id = $1 AND organization_id = $2',
      [jobId, orgId]
    );
    if (rows[0]) {
      if (!leadId) leadId = clean(rows[0].lead_id);
      estimateId = clean(rows[0].estimate_id);
    }
  }

  if (leadId && (leadOnly || hasCapability(user, 'LEADS_VIEW'))) {
    const { rows } = await pool.query(
      'SELECT 1 FROM leads WHERE id = $1 AND organization_id = $2',
      [leadId, orgId]
    );
    if (rows.length) parents.push({ where: 'lead', entity_type: 'lead', entity_id: leadId });
  }

  if (estimateId && hasCapability(user, 'ESTIMATES_VIEW')) {
    const { rows } = await pool.query(
      'SELECT 1 FROM estimates WHERE id = $1 AND organization_id = $2',
      [estimateId, orgId]
    );
    if (rows.length) parents.push({ where: 'estimate', entity_type: 'estimate', entity_id: estimateId });
  }
  return parents;
}

// What the picker may offer — 'xlsx' | 'xls' | 'csv' | 'pdf' | 'image' | null.
// The rule itself lives in services/materials-extract.js, because the crew
// link's takeoff door asks the same question and the two must agree on what a
// file IS. Required on call rather than at the top for the reason the extract
// door gives below: a throw while loading that module must fail one request,
// not the whole router.
function takeoffKind(filename, mime) {
  return require('../services/materials-extract').takeoffKind(filename, mime);
}

const FILE_NOT_FOUND = 'File not found';
// An attachment id is `att_<ms>_<rand>` today. The shape check keeps anything
// else — a path, a list, an object — from reaching the SQL at all.
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ONE FILE READ PER USER AT A TIME. Reading a takeoff (the extract door) and
// making a spreadsheet's price-free copy (the crew-takeoff door) both pull up
// to 25 MB out of storage and parse it on this process's one thread. The parse
// is bounded, but a caller who fires twenty reads in parallel would still hold
// twenty copies of the file and queue twenty parses in front of every other
// tenant — and the spreadsheet tier deliberately spends no AI rate-limit budget. So each user
// gets one read in flight, across both doors, taken BEFORE the storage fetch
// and given back in a `finally`. In-process on purpose: there is one replica
// (rate-limit.js), and a slot that outlived a crash would lock a PM out.
const FILE_READ_BUSY = 'Still reading your last file — try again in a moment.';
const fileReadsInFlight = new Set();

// A release function, or null when this user already has a read in flight.
function takeFileReadSlot(req, orgId) {
  const uid = req.user && req.user.id != null ? String(req.user.id) : null;
  const key = uid ? 'user:' + uid : 'org:' + String(orgId);
  if (fileReadsInFlight.has(key)) return null;
  fileReadsInFlight.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fileReadsInFlight.delete(key);
  };
}

// ONE file hanging on this ticket's own job, lead or estimate, or null. Every
// door that takes a file id from the office goes through here — the extract
// door and the crew-takeoff door — so "which files may a work order name" is
// answered in one place.
//
// THE PARENT IS IN THE WHERE. The file must hang on one of this ticket's
// proved parents (ticketFileParents, which already applied the LEADS_VIEW /
// ESTIMATES_VIEW gates for this caller); an in-org file on some other job is
// refused by the predicate, not by an `if` somebody has to keep. Absent slots
// bind NULL, and `entity_type = NULL` is never true. Then the row-keyed tenancy
// ladder, the same one every attachment id door runs. Every miss — a bad id,
// absent, another tenant's, another job's, a lead or estimate this caller may
// not open — is the same null, so no caller can answer it differently.
async function loadTicketFile(ticket, user, orgId, attachmentId) {
  if (typeof attachmentId !== 'string' || !ATTACHMENT_ID_RE.test(attachmentId)) return null;
  const parents = await ticketFileParents(ticket, user, orgId);
  const slot = (i) => (parents[i] ? [parents[i].entity_type, parents[i].entity_id] : [null, null]);
  const { rows } = await pool.query(
    `SELECT id, entity_type, entity_id, organization_id, uploaded_by, filename,
              mime_type, size_bytes, original_key, web_key
         FROM attachments
        WHERE id = $1
          AND ((entity_type = $2 AND entity_id = $3)
            OR (entity_type = $4 AND entity_id = $5)
            OR (entity_type = $6 AND entity_id = $7))`,
    [attachmentId].concat(slot(0), slot(1), slot(2))
  );
  const att = rows[0] || null;
  if (!att || !(await attachmentInOrg(pool, att, orgId))) return null;
  return att;
}

// GET the files a takeoff can be read from. Named columns only: never
// extracted_text (it can carry the file's prices), never a storage key or URL
// (the picker needs a name, not the bytes).
router.get('/:id/materials/sources', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
    // WRITE, not read, on a GET: the list only exists to fill the Materials
    // editor, which a viewer cannot save — and a view grant should not be a
    // way to browse the lead's and the estimate's files.
    if (svc.isTerminal(ticket.status)) {
      return res.status(409).json({ error: 'This ticket is ' + ticket.status + '. Reopen it before changing its materials.' });
    }
    const parents = await ticketFileParents(ticket, req.user, orgId);
    // Keyed on (entity_type, entity_id) pairs proved above, one statement per
    // parent — the same key the job's own Files tab lists by.
    const lists = await Promise.all(parents.map((p) => pool.query(
      `SELECT id, filename, mime_type, size_bytes, folder, uploaded_at
         FROM attachments
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY uploaded_at DESC LIMIT 200`,
      [p.entity_type, p.entity_id]
    )));
    const files = [];
    parents.forEach((p, i) => {
      for (const r of lists[i].rows) {
        const kind = takeoffKind(r.filename, r.mime_type);
        if (!kind) continue;
        files.push({
          id: r.id,
          filename: r.filename,
          kind,
          size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
          uploaded_at: r.uploaded_at,
          folder: r.folder || null,
          where: p.where,
        });
      }
    });
    res.json({ files });
  } catch (e) {
    console.error('[service-tickets] material sources failed', e);
    res.status(500).json({ error: 'Failed to load the job files' });
  }
});

// THE LAZY AI GATE, shared by the two doors that run the extractor (the
// extract door and the crew-takeoff door). The AI rate limiters are not route
// middleware on either, because a spreadsheet is usually read without any
// model call — a PM filling ten tickets from one xlsx should not spend the
// chat budget. The extractor calls the returned beforeAi() once, immediately
// before it would reach a model, and only then do the limiters run; when one
// answers 429 it has already written the response, which is why each door
// checks headersSent after the call. Required on call, like the extractor, so
// a throw loading rate-limit.js fails one request and not the router.
function lazyAiGate(req, res) {
  const { aiChatLimiter, aiChatHourlyLimiter } = require('../rate-limit');
  const passLimiter = async (limiter) => {
    let passed = false;
    await limiter(req, res, (err) => { passed = !err; });
    return passed;
  };
  return async () => (await passLimiter(aiChatLimiter)) && (await passLimiter(aiChatHourlyLimiter));
}

// POST read material lines out of one of those files. Returns the lines for
// the editor to show; stores NOTHING. The AI limiters run only when the
// extractor asks (lazyAiGate above).
router.post('/:id/materials/extract', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
    if (svc.isTerminal(ticket.status)) {
      return res.status(409).json({ error: 'This ticket is ' + ticket.status + '. Reopen it before changing its materials.' });
    }
    const rawId = req.body ? req.body.attachment_id : undefined;
    const attachmentId = typeof rawId === 'string' ? rawId : '';
    if (!ATTACHMENT_ID_RE.test(attachmentId)) {
      return res.status(400).json({ error: 'Pick a file to read materials from' });
    }

    // The file must hang on this ticket's own job, lead or estimate
    // (loadTicketFile). Every miss is the SAME 404, so the door cannot be used
    // to probe file ids.
    const att = await loadTicketFile(ticket, req.user, orgId, attachmentId);
    if (!att) return res.status(404).json({ error: FILE_NOT_FOUND });

    // One read per user at a time (takeFileReadSlot), before a byte is fetched.
    const release = takeFileReadSlot(req, orgId);
    if (!release) return res.status(429).json({ error: FILE_READ_BUSY });
    try {
      // Required HERE rather than at the top: the storage backend and the
      // extractor (exceljs, pdf-parse, the Anthropic SDK) are heavy, and a throw
      // while loading either must fail this one request, not the whole router —
      // the route census requires every router in the server.
      const { storage } = require('../storage');
      const { extractMaterials } = require('../services/materials-extract');
      const beforeAi = lazyAiGate(req, res);

      const result = await extractMaterials({
        att,
        getBuffer: (key) => storage.getBuffer(key),
        orgId,
        beforeAi,
      });
      // A limiter answered 429 inside beforeAi. Writing again would throw.
      if (res.headersSent) return;
      if (result && result.ok === true) return res.json(result);
      const code = (result && result.code) || 'unreadable';
      const error = (result && result.error) || 'Could not read materials from that file';
      // rate_limited with nothing written means a limiter failed rather than
      // refused (a store error passed to next). Still a "try later", not a 422.
      if (code === 'rate_limited') return res.status(429).json({ error, code });
      return res.status(422).json({ error, code });
    } finally {
      release();
    }
  } catch (e) {
    console.error('[service-tickets] material extract failed', e);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Could not read materials from that file' });
  }
});

// ── Work-order takeoff on the crew link (John, 2026-09-13) ─────────────────
// "Let the crew link show the takeoff file too." The PM picks ONE file on the
// ticket's job, lead or estimate, and the crew link offers it through the
// token (service-ticket-share-routes.js, GET /service-ticket-share/:token/
// takeoff) — never through the file's public storage URL.
//
// NOTHING IS SHOWN UNTIL SOMEONE CHOOSES. crew_takeoff is NULL by default and
// only this door sets it; attachment_id null clears it.
//
// PRICES — THE PRICE-FREE COPY (John, 2026-09-14). John's standing rule is no
// financial information on a work order, and no check of a spreadsheet's
// columns can promise a priced sheet is caught. So a spreadsheet (xlsx, csv,
// xls) is never handed to a link that hides financials — which is every link
// unless the PM minted it otherwise. Such a link gets a GENERATED copy holding
// only material, quantity and unit, and the original goes only to a link sent
// with financial details.
//
// The copy's lines are read HERE, when the file is picked, by the same
// extractor that fills the Materials list (extractMaterials, under the same
// one-read-per-user slot and the same lazy AI gate as the extract door), put
// through normalizeMaterials, and stored as crew_takeoff.copy. A link read then
// builds the xlsx from those stored lines and never pulls the original out of
// storage to do it. A spreadsheet that yields no lines — unreadable, not a
// takeoff, an old .xls — is still stored, with copy null and copy_problem
// saying why in a plain sentence: a link that hides financials shows nothing
// for it, a financial link still gets the original.
//
// A PDF or photo is not read for lines (copy null, copy_problem null). It is
// shown on every link exactly as before — the office confirms it holds no
// prices before choosing it. But its BYTES are read, to prove the name: see
// kindFromBytes below. A file over the crew door's size cap is refused for
// every kind.
const XLS_COPY_PROBLEM = 'Old .xls files can\'t be read — save it as .xlsx for a price-free copy.';
const COPY_NO_LINES = 'No material lines could be read from that file, so links that hide financial details will not show it.';
// A file named as a PDF or photo whose bytes are neither what its name says
// nor a spreadsheet (kindFromBytes answered 'unknown'). Nothing can be copied
// from it and nothing vouches for its bytes, so only a financial link shows it.
const COPY_NOT_READABLE = 'This file isn\'t a readable PDF, photo or spreadsheet, so it only shows on links sent with financial details.';
// A plain sentence, not a document: the extractor's refusals are one line.
const COPY_PROBLEM_MAX = 500;

// WHAT A "PDF" OR "PHOTO" REALLY IS (review, 2026-09-14). takeoffKind reads the
// NAME first, and a name is only a claim. A priced workbook can reach a job as
// "Smith bid.pdf" or "Smith bid.jpg": an inbound email attachment keeps the
// sender's filename and runs no claimed-versus-sniffed check, and an upload
// that claims application/octet-stream passes the family check. Trusted by
// name, that file was stored as a PDF, never opened, and handed to every link
// as the original, Unit Price column and all. The price check that used to
// catch it sniffed the bytes; this puts the bytes back in charge.
//
// So for a PDF or photo by name the PUT reads the file (under the same
// one-read-per-user slot as a spreadsheet) and asks materials-extract's
// sniffKind — the magic-byte rule the extractor itself reads by — what it is:
//   * the kind its name says (a PDF that is a PDF, a photo that is a photo):
//     the name stands and nothing is copied, as before;
//   * a spreadsheet (xlsx, xls, csv): stored as THAT kind, so every
//     spreadsheet rule applies — the price-free copy for xlsx and csv, the one
//     fix for an old .xls — and the share side never sees a "pdf";
//   * anything else (an HTML page, a zip, a CSV under a photo's name, or a
//     photo under a PDF's name, which the crew door could not vouch for
//     either): 'unknown', which no link that hides financials shows.
// Returns 'pdf' | 'image' | 'xlsx' | 'xls' | 'csv' | 'unknown'.
function kindFromBytes(nameKind, byteKind) {
  if (byteKind === nameKind) return nameKind;
  if (byteKind === 'xlsx' || byteKind === 'xls' || byteKind === 'csv') return byteKind;
  return 'unknown';
}

// What extractMaterials answered, as crew_takeoff's { copy, problem }. The
// lines go through normalizeMaterials — the shape the Materials PATCH stores,
// at most 100 of them — so the copy holds exactly three strings per line and
// nothing else the extractor might carry. A read that succeeded with no line
// left after that is a problem, not an empty copy: an empty copy would give
// the crew a spreadsheet with a header and nothing under it.
function copyFromExtraction(result) {
  if (result && result.ok === true) {
    const lines = svc.normalizeMaterials(result.materials);
    if (lines.length) {
      const source = result.source && typeof result.source === 'object' ? result.source : {};
      return {
        copy: {
          lines: lines,
          sheet: typeof source.sheet === 'string' && source.sheet ? source.sheet : null,
          method: typeof result.method === 'string' ? result.method : '',
          made_at: new Date().toISOString(),
        },
        problem: null,
      };
    }
    return { copy: null, problem: COPY_NO_LINES };
  }
  const error = result && typeof result.error === 'string' ? result.error.trim() : '';
  return { copy: null, problem: (error || COPY_NO_LINES).slice(0, COPY_PROBLEM_MAX) };
}

// Same gates as the Materials PATCH — WRITE access on the ticket, and not on a
// closed or cancelled ticket — and the same file rule as the extract door:
// loadTicketFile, so a lead or estimate file this caller could not open by the
// front door cannot be put in front of a crew through this one.
router.put('/:id/crew-takeoff', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
    if (svc.isTerminal(ticket.status)) {
      return res.status(409).json({ error: 'This ticket is ' + ticket.status + '. Reopen it before changing what the crew link shows.' });
    }

    const rawId = req.body ? req.body.attachment_id : undefined;
    let chosen = null;
    if (rawId !== null) {
      // A bad id shape, an absent id, another job's file and another tenant's
      // file are all this one 404 (loadTicketFile answers null for each).
      const att = await loadTicketFile(ticket, req.user, orgId, rawId);
      if (!att) return res.status(404).json({ error: FILE_NOT_FOUND });
      // By name here; a PDF or photo by name is proved from its bytes below
      // (kindFromBytes), and may be stored as another kind.
      let kind = takeoffKind(att.filename, att.mime_type);
      if (!kind) {
        return res.status(422).json({ error: 'That file type cannot be shown on the crew link.' });
      }
      // THE CREW DOOR'S SIZE CAP, on the stored size and before a byte is
      // fetched. Uploads allow 50 MB; the crew link sends no more than
      // MAX_FILE_BYTES (the extractor's own read cap, which the share side
      // reads too), so a 38 MB plan set stored here would show the crew a card
      // whose file never opens while the office was told it is on the link.
      const { MAX_FILE_BYTES } = require('../services/materials-extract');
      const size = att.size_bytes == null ? NaN : Number(att.size_bytes);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
        return res.status(422).json({
          error: 'That file is too large for the crew link (over ' + Math.round(MAX_FILE_BYTES / (1024 * 1024))
            + ' MB) — ask the office to send it another way.',
        });
      }
      let copy = null;
      let copyProblem = null;
      if (kind === 'xls') {
        // An old .xls cannot be read (a binary workbook, or an "Export to
        // Excel" HTML or XML file under that name), so there are no lines to
        // copy and nothing is fetched. Stored all the same: a financial link
        // still gets the original, and the office is told the one fix.
        copyProblem = XLS_COPY_PROBLEM;
      } else {
        // One read per user at a time, shared with the extract door and taken
        // before the storage fetch; given back as soon as the read is done. A
        // spreadsheet takes it to be copied, and a PDF or photo by name takes
        // it to have its bytes proved (kindFromBytes) — ONE slot for both, so a
        // workbook found behind a PDF's name is copied under the same read.
        const release = takeFileReadSlot(req, orgId);
        if (!release) return res.status(429).json({ error: FILE_READ_BUSY });
        let result = null;
        try {
          // Required here, not at the top: exceljs and the storage backend are
          // heavy, and a throw loading either must fail this request only.
          const { storage } = require('../storage');
          const { extractMaterials, sniffKind } = require('../services/materials-extract');
          // The bytes a PDF or photo by name was proved from. When they turn
          // out to be a spreadsheet the extractor is handed these same bytes,
          // so the file is fetched once. A row with no stored object has no
          // bytes to prove anything, and sniffs as 'unknown'.
          let held = null;
          if (kind === 'pdf' || kind === 'image') {
            held = att.original_key ? await storage.getBuffer(att.original_key) : null;
            kind = kindFromBytes(kind, sniffKind(held, att.filename, att.mime_type));
          }
          // Only a spreadsheet is read for lines. An arrow, not
          // storage.getBuffer bare: the R2 backend's getBuffer reads
          // this.client and loses its `this` when handed around.
          if (kind === 'xlsx' || kind === 'csv') {
            result = await extractMaterials({
              att,
              getBuffer: (key) => (held != null && key === att.original_key ? held : storage.getBuffer(key)),
              orgId,
              beforeAi: lazyAiGate(req, res),
            });
          }
        } finally {
          release();
        }
        // A limiter answered 429 inside beforeAi. Nothing is stored, and
        // writing again would throw.
        if (res.headersSent) return;
        // A limiter that FAILED rather than refused (a store error passed to
        // next) is still "try again later" — not a choice stored with a
        // problem the office would read as the file's fault.
        if (result && result.ok !== true && result.code === 'rate_limited') {
          return res.status(429).json({ error: result.error || 'Too many requests — please wait a moment and try again.' });
        }
        if (kind === 'xlsx' || kind === 'csv') {
          const made = copyFromExtraction(result);
          copy = made.copy;
          copyProblem = made.problem;
        } else if (kind === 'xls') {
          // An old .xls that arrived under a PDF's or photo's name: the same
          // one fix as one picked by its own name.
          copyProblem = XLS_COPY_PROBLEM;
        } else if (kind === 'unknown') {
          copyProblem = COPY_NOT_READABLE;
        }
      }
      chosen = {
        attachment_id: att.id,
        filename: att.filename == null ? '' : String(att.filename),
        kind: kind,
        set_at: new Date().toISOString(),
        set_by: (req.user && req.user.id) || null,
        copy: copy,
        copy_problem: copyProblem,
      };
    }

    const { rows } = await pool.query(
      `UPDATE service_tickets SET crew_takeoff = $1::jsonb, updated_at = NOW()
        WHERE id = $2 AND organization_id = $3
      RETURNING ${TICKET_COLS}`,
      [chosen ? JSON.stringify(chosen) : null, ticket.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: TICKET_NOT_FOUND });

    // SHAPE, not contents — the field name only, as the PATCH logs it. Never
    // the filename: a file called "Smith job - $48k bid.xlsx" is a price too.
    await logEvent(null, rows[0], 'field_changed', {
      actorUserId: (req.user && req.user.id) || null,
      detail: { fields: ['crew_takeoff'] },
    });
    res.json({ ok: true, ticket: rows[0], crew_takeoff: chosen });
  } catch (e) {
    console.error('[service-tickets] crew takeoff failed', e);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Failed to change the crew link takeoff' });
  }
});

// ── A5: status ──────────────────────────────────────────────────────────
// Its own door so the transition lattice is enforced in exactly one place
// (svc.ticketMayTransition). Everything around it — the stale-screen check,
// required reasons, the approve / cancel stamps, the send-back that reopens
// buildings, the buildings-still-open override and the guarded UPDATE — is
// services/work-order-review.js changeStatus, the one status executor.
//
// Body: { status, expected_status?, reason? (legacy: note), override?: true,
//         copy_scope?: true, reopen_tasks?: [id | { id, note }] }
// Notices go out only after the move COMMITTED, never on a refusal or a no-op.
router.post('/:id/status', requireAuth, requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) return res.status(404).json({ error: 'Service ticket not found' });

    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

    const body = req.body || {};
    const actor = actorOf(req);
    const result = await review.changeStatus(pool, {
      ticket,
      next: String(body.status || ''),
      expectedStatus: body.expected_status,
      reason: body.reason != null ? body.reason : body.note,
      override: body.override === true,
      copyScope: body.copy_scope === true,
      reopenTasks: body.reopen_tasks,
      actor,
      returning: TICKET_COLS,
    });
    if (!result.ok) {
      const refusal = { error: result.error };
      for (const k of ['code', 'current_status', 'open', 'total']) {
        if (result[k] !== undefined) refusal[k] = result[k];
      }
      return res.status(result.status).json(refusal);
    }
    if (!result.applied) return res.json({ ok: true, ticket: result.ticket });

    if (result.to === 'work_complete') {
      trackNotice('ticket_approval', () => ticketNotify.notifyAwaitingApproval(pool, {
        ticket: result.ticket,
        actor,
        reason: 'office_moved',
      }));
    }

    const answer = { ok: true, ticket: result.ticket };
    if (result.action === 'send_back' && result.sendBack) {
      // The crew hears why by email: every live responding link that has an
      // address. Looked up here so the answer can say whether anyone is being
      // emailed; the send itself is not awaited.
      let recipients = [];
      try {
        recipients = await notices.sendBackRecipients(pool, result.ticket);
      } catch (e) {
        recipients = [];
      }
      if (!Array.isArray(recipients)) recipients = [];
      if (recipients.length) {
        trackNotice('ticket_sent_back', () => notices.notifySentBack(pool, {
          ticket: result.ticket,
          actor,
          sendBack: result.sendBack,
          recipients,
        }));
      }
      answer.send_back = {
        reopened: (result.sendBack.buildings || []).filter((b) => b && b.reopened).length,
        crew_emailing: recipients.length,
      };
    }
    res.json(answer);
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

    // An archived work order does not leave the crew's problems open behind it,
    // for the same reason closing and cancelling do not (work-order-review.js
    // changeStatus): the office only gets a Resolve box while a ticket is
    // reachable, so an open flag on an archived one could never be cleared.
    // Same helper, same flag_resolved line, org-scoped by the ticket row.
    //
    // BEST EFFORT, unlike the close path: that one runs inside the status
    // transaction and is strict, because a swallowed failure there would turn
    // COMMIT into a silent no-op. Here the archive UPDATE has already landed on
    // its own, so a failure to tidy the flags must not turn a successful
    // archive into a 500 the caller would retry against an already-archived row
    // (and be told 404).
    try {
      await flagSvc.resolveOpenFlagsOnClose(pool, ticket, actorOf(req), 'Archived with the work order.');
    } catch (e) {
      console.warn('[service-tickets] archive flag clean-up failed', e && e.message);
    }

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

// The crew-safe whitelist GET /my-buildings shapes every row through, so a
// test asserts the key set without re-typing it (and a new column cannot be
// added to the projection without the test noticing).
router.MY_BUILDING_ROW_KEYS = MY_BUILDING_ROW_KEYS;

module.exports = router;
