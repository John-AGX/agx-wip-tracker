// Tasks — Project 86's streamlined to-do / task entity.
//
// ONE polymorphic table (server/db.js `tasks`): a `kind` discriminator
// (todo | punch | follow_up) covers the variants, and entity_type +
// entity_id link a task to ANY entity (job / lead / estimate / client /
// sub / project) the same way reports do — or stay NULL for a personal
// task. The design synthesizes Buildertrend (field assignment + due
// dates + photos), Todoist (fast single-line capture + Today/Upcoming/
// Overdue views), and Asana (subtasks via the checklist JSONB), without
// Procore's separate-table sprawl.
//
// CAPABILITY GATE — deliberately NONE beyond requireAuth.
//   Tasks are assignee-driven: the whole point is that any user in the
//   org can be assigned a task and must be able to see it in "My Tasks".
//   The existing capability keys (LEADS_*, JOBS_*) gate sales/ops
//   surfaces — a field user assigned a punch-list item might hold none
//   of them, so gating tasks on any of those caps would 403 the exact
//   people the feature targets. Adding a fresh TASKS_* cap wouldn't help
//   either: it grants to NO role until an admin toggles it per-role, so
//   the feature would be invisible on day one. Instead every authed user
//   may read/write tasks, and ORG SCOPING (organization_id filter on
//   every query) is the security boundary — identical posture to the
//   personal My Files space.
//
// Org scoping: every row carries organization_id; reads/writes filter to
// req.user.organization_id so nothing leaks across tenants.

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, getAttributedUserId } = require('../auth');
// Low-level transactional send. We deliberately use sendEmail (not
// sendForEvent) so task notifications don't depend on a catalog entry +
// template living in the protected email-events.js / email-templates.js
// files — the body is built inline below. Every send is still recorded in
// email_log (sendEmail logs unconditionally), and the per-user opt-out
// (notification_prefs.task_assignment) is honored, matching the
// job-assignment / schedule-assignment notification posture.
const { sendEmail } = require('../email');
// Sender identity helpers — a separate, never-mocked module (see its header).
const emailSender = require('../email-sender');
// The one job-label formatter, shared with the browser (window.p86JobLabel).
const jobLabel = require('../../js/job-label');
// A task with service_ticket_id is a BUILDING ON A WORK ORDER. Finishing,
// reopening, adding, moving, unlinking or archiving one goes through the same
// rules the office checkbox and the crew link use: the ticket is locked, the
// caller's right to it is decided (subtaskDoor), and completing, the timeline
// and the ticket's own status happen in services/service-ticket-workorder.js.
const svc = require('../services/service-tickets');
const workOrder = require('../services/service-ticket-workorder');
const subtaskDoor = require('../services/service-ticket-subtask-door');

const router = express.Router();

function newId() {
  return 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Resolve the caller's organization_id. Returns null when the user has
// no org assigned (shouldn't happen post-backfill, but defensive).
function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  if (!oid) return null;
  return Number(oid);
}

// Controlled vocabularies — values outside these sets are ignored on
// write (the column default stands) rather than rejected, so a stale
// client can never wedge a create/update.
const KINDS      = new Set(['todo', 'punch', 'follow_up']);
const STATUSES   = new Set(['open', 'in_progress', 'blocked', 'done']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

// Entity types a task may link to. Mirrors VALID_ENTITY_TYPES in
// attachment-routes.js minus 'user'/'org'/'task' (a task doesn't link
// to a person, the org, or itself). NULL entity_type = personal task.
const LINKABLE_ENTITY_TYPES = new Set(['lead', 'estimate', 'client', 'job', 'sub', 'project']);

// Normalize a checklist (subtasks) input into [{text, done}]. Strings
// are trimmed + capped; max 50 items. Anything malformed is dropped.
function normalizeChecklist(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length && out.length < 50; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, 300) : '';
    if (!text) continue;
    out.push({ text: text, done: !!item.done });
  }
  return out;
}

// Best-effort human label for a linked entity, used to hydrate the
// detail view + AI reads. Returns '' when the entity can't be resolved
// (deleted, cross-org, or an unknown type). Org-scoped where the table
// carries organization_id.
async function resolveEntityLabel(orgId, type, id) {
  if (!type || !id || !LINKABLE_ENTITY_TYPES.has(type)) return '';
  try {
    // Every branch org-scoped on the table's own column. These reached a
    // caller-supplied id with no tenant predicate, so a guessed id returned
    // another tenant's LEAD TITLE, CLIENT NAME, SUB NAME or JOB NUMBER + TITLE
    // — the whole guess-an-id-read-the-label probe, and the cheapest class in
    // the survey to close. ai-routes.js resolveEntityLabel already appends
    // exactly this guard; this is that pattern, applied where it was missing.
    // Tolerant OR-IS-NULL, as everywhere else.
    if (orgId == null) return '';
    const orgGuard = ' AND (organization_id = $2 OR organization_id IS NULL)';
    let sql;
    if (type === 'lead')      sql = 'SELECT title AS label FROM leads WHERE id = $1' + orgGuard;
    else if (type === 'client') sql = 'SELECT name AS label FROM clients WHERE id = $1' + orgGuard;
    else if (type === 'sub')   sql = 'SELECT name AS label FROM subs WHERE id = $1' + orgGuard;
    else if (type === 'project') sql = 'SELECT name AS label FROM projects WHERE id = $1 AND organization_id = $2';
    else if (type === 'estimate') sql = "SELECT COALESCE(data->>'name', data->>'title', 'Estimate') AS label FROM estimates WHERE id = $1" + orgGuard;
    else if (type === 'job')   sql = "SELECT COALESCE(NULLIF(data->>'jobNumber',''),'') AS num, COALESCE(data->>'title', data->>'name', '') AS label FROM jobs WHERE id = $1" + orgGuard;
    else return '';
    const { rows } = await pool.query(sql, [String(id), orgId]);
    if (!rows.length) return '';
    // Jobs get the shared jobNumber + title composition. This used to return
    // the title alone, so a task that showed "RV2006 Waterside" in the app
    // reached the outside worker's assignment email + share link as just
    // "Waterside" — the number, which is how the crew identifies the site,
    // was dropped exactly where it mattered most.
    if (type === 'job') return jobLabel(rows[0].num, rows[0].label, { fallback: 'Job' });
    return rows[0].label || '';
  } catch (e) {
    return '';
  }
}

// Public base URL for email links (env override → live domain fallback).
// Mirrors appUrl() in server/email-templates.js without importing it —
// that helper isn't exported, and keeping task email self-contained lets
// us stay entirely off the protected email-* files.
function taskAppUrl() {
  var u = process.env.APP_URL;
  if (typeof u === 'string' && /^https?:\/\//.test(u.trim())) {
    return u.trim().replace(/\/$/, '');
  }
  return 'https://project86.net';
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// DATE/timestamp → friendly label ("Mon, Jun 1, 2026"). DATE columns
// arrive from pg as a JS Date (server-TZ midnight); strings pass through.
function fmtDueLabel(due) {
  if (!due) return '';
  var d = (due instanceof Date) ? due : new Date(due);
  if (isNaN(d.getTime())) return String(due).slice(0, 10);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// Fire a task-assigned email to the assignee. Fire-and-forget; respects
// the user's notification_prefs.task_assignment opt-out — identical
// posture to maybeNotifyJobAssigned (job-routes) and notifyScheduleCrew
// (schedule-routes). Body is built inline (no email-templates dependency);
// the send is recorded in email_log by sendEmail. Never throws.
//
// Everything is read in the TASK'S org. The assignee was proved in-org at the
// door (assigneeOk), and the recipient read repeats it so the mail is never the
// one statement that forgot. The actor read is org-predicated too: it supplies
// both the name in the copy and the Reply-To, and under act-as req.user is
// platform staff from another tenant — no match, so the copy says "A teammate"
// and the mail carries no Reply-To rather than a stranger's name and address.
async function notifyTaskAssigned(task, actorUserId, opts) {
  opts = opts || {};
  try {
    if (!task || !task.assignee_user_id) return;
    const orgId = task.organization_id;
    if (orgId == null) return;

    const { rows } = await pool.query(
      'SELECT email, name, notification_prefs FROM users WHERE id = $1 AND organization_id = $2 AND active = TRUE',
      [Number(task.assignee_user_id), orgId]
    );
    if (!rows.length) return;
    const u = rows[0];
    const prefs = u.notification_prefs || {};
    if (prefs.task_assignment === false) return; // user opted out
    if (!u.email) return;

    // Who performed the assignment?
    let actorName = 'A teammate';
    let actorEmail = null;
    if (actorUserId != null) {
      try {
        const a = await pool.query(
          'SELECT name, email FROM users WHERE id = $1 AND organization_id = $2 AND active = TRUE',
          [Number(actorUserId), orgId]);
        if (a.rows.length && a.rows[0].name) actorName = a.rows[0].name;
        if (a.rows.length) actorEmail = emailSender.cleanReplyTo(a.rows[0].email, [u.email]);
      } catch (_) { /* fall back to generic actor name */ }
    }

    // Best-effort linked-entity label (org-scoped inside resolveEntityLabel).
    let linkedLabel = '';
    if (task.entity_type && task.entity_id) {
      linkedLabel = await resolveEntityLabel(Number(task.organization_id), task.entity_type, task.entity_id);
    }

    const base = taskAppUrl();
    const title = task.title || '(untitled task)';
    const due = fmtDueLabel(task.due_date);
    const priority = (task.priority && task.priority !== 'normal') ? String(task.priority) : '';
    const reason = (opts.reason === 'reassigned') ? 'reassigned to you' : 'assigned to you';
    const subject = (priority === 'urgent' ? '[Urgent] ' : '') + 'Task ' + reason + ': ' + title;

    const detailRows = [];
    detailRows.push('<tr><td style="padding:5px 10px;color:#6b7280;">Task</td><td style="padding:5px 10px;font-weight:600;">' + escHtml(title) + '</td></tr>');
    if (due)      detailRows.push('<tr><td style="padding:5px 10px;color:#6b7280;">Due</td><td style="padding:5px 10px;">' + escHtml(due) + '</td></tr>');
    if (priority) detailRows.push('<tr><td style="padding:5px 10px;color:#6b7280;">Priority</td><td style="padding:5px 10px;text-transform:capitalize;">' + escHtml(priority) + '</td></tr>');
    if (linkedLabel) detailRows.push('<tr><td style="padding:5px 10px;color:#6b7280;">Related</td><td style="padding:5px 10px;">' + escHtml(task.entity_type) + ' &mdash; ' + escHtml(linkedLabel) + '</td></tr>');

    const hostLabel = base.replace(/^https?:\/\//, '');
    const html =
      '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">' +
        '<div style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:10px;color:#1f2937;line-height:1.5;">' +
          '<div style="margin-bottom:12px;"><img src="' + base + '/images/logo-color.png" alt="Project 86" style="height:40px;display:block;" /></div>' +
          '<h2 style="margin:0 0 16px 0;color:#111827;font-size:20px;">' + escHtml(actorName) + ' ' + escHtml(reason) + '</h2>' +
          '<p>Hi ' + escHtml(u.name || 'there') + ',</p>' +
          '<p><strong>' + escHtml(actorName) + '</strong> ' + escHtml(reason) + ' a task on Project 86.</p>' +
          '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;margin:16px 0;font-size:14px;border-collapse:collapse;">' +
            detailRows.join('') +
          '</table>' +
          '<p><a href="' + base + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open My Tasks</a></p>' +
          '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">' +
            'Project 86 &middot; <a href="' + base + '" style="color:#4f8cff;text-decoration:none;">' + escHtml(hostLabel) + '</a><br/>' +
            'You\'re receiving this because a task was ' + escHtml(reason) + ' on your Project 86 account. ' +
            'Toggle notifications in <strong>My Account &rarr; Notifications</strong>.' +
          '</div>' +
        '</div>' +
      '</body></html>';

    const text =
      'Hi ' + (u.name || 'there') + ',\n\n' +
      actorName + ' ' + reason + ' a task on Project 86.\n\n' +
      'Task: ' + title + '\n' +
      (due ? 'Due: ' + due + '\n' : '') +
      (priority ? 'Priority: ' + priority + '\n' : '') +
      (linkedLabel ? 'Related: ' + task.entity_type + ' — ' + linkedLabel + '\n' : '') +
      '\nOpen My Tasks: ' + base + '\n\n' +
      'Toggle notifications in My Account → Notifications.';

    sendEmail({
      to: u.email,
      subject: subject,
      html: html,
      text: text,
      tag: 'task_assignment',
      organizationId: orgId,
      senderOrg: { id: orgId },
      replyTo: actorEmail || false
    }).catch((e) => console.warn('[tasks] notify email failed:', e && e.message));
  } catch (e) {
    console.warn('[tasks] notify lookup failed:', e && e.message);
  }
}

// Thin sync wrapper so callers on the request path never await the email.
// notifyTaskAssigned is self-guarding (never throws), but the try/catch
// here keeps a synchronous throw (shouldn't happen) from bubbling.
function maybeNotifyAssignee(task, actorUserId, opts) {
  try {
    notifyTaskAssigned(task, actorUserId, opts || {});
  } catch (e) {
    console.warn('[tasks] assignee notify failed:', e && e.message);
  }
}

// PATCH allowlist — anything outside is silently dropped (guards the
// dynamic-SET pattern against injection).
const EDITABLE_FIELDS = new Set([
  'title', 'notes', 'kind', 'status', 'priority',
  'due_date', 'assignee_user_id', 'entity_type', 'entity_id', 'checklist',
  'lat', 'lng', 'geo_accuracy', 'directions',
  // The work order this task belongs to, if any. A SEPARATE pointer from
  // (entity_type, entity_id) on purpose: a task under a ticket on a job keeps
  // entity_type='job' so it still appears on the job's Tasks panel, in the My
  // Tasks "Job" column and in read_entity(job, include:['tasks']). Both facts
  // are true at once. Validated in-org below — it is a caller-supplied id.
  'service_ticket_id'
]);

// Validate that a candidate assignee belongs to the caller's org.
// Returns true for null (unassign) or a same-org user; false otherwise.
async function assigneeOk(orgId, assigneeId) {
  if (assigneeId == null) return true;
  const n = Number(assigneeId);
  if (!Number.isInteger(n)) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM users WHERE id = $1 AND organization_id = $2',
    [n, orgId]
  );
  return rows.length > 0;
}

// Same shape as assigneeOk, for the same reason: service_ticket_id arrives in
// a request body, so it must be PROVED to belong to the caller's org before it
// is written. Without this a caller could file their task under another
// tenant's work order — the FK only proves the row exists, never whose it is.
// Returns true for null (unlink).
async function serviceTicketOk(orgId, ticketId) {
  if (ticketId == null || ticketId === '') return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM service_tickets WHERE id = $1 AND organization_id = $2',
    [String(ticketId), orgId]
  );
  return rows.length > 0;
}

// The office user as a timeline actor on a work order.
function userActor(req) {
  return { kind: 'user', userId: (req.user && req.user.id) || null, label: (req.user && req.user.name) || null };
}

// One transaction on its own client. `work(client)` answers { refusal } to
// roll back (nothing it wrote survives) or anything else to commit. A throw
// rolls back and rethrows.
async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    await client.query(out && out.refusal ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the throw is the news */ }
    throw e;
  } finally {
    client.release();
  }
}

function sendRefusal(res, refusal) {
  const body = { error: refusal.error };
  if (refusal.code) body.code = refusal.code;
  return res.status(refusal.status || 409).json(body);
}

function workOrderOut(ticket, moved) {
  return { ticket_id: ticket.id, ticket_status: moved.ticketStatus, moved_to: moved.movedTo || null };
}

// ──────────────────────────────────────────────────────────────────
// GET /api/tasks
// Query params:
//   assignee     — 'me' | 'unassigned' | <userId>
//   status       — exact: open | in_progress | blocked | done
//   exclude_done — '1' → status <> 'done'  (My Tasks default)
//   entity_type + entity_id — polymorphic filter (a job's Tasks panel)
//   kind         — todo | punch | follow_up
//   due_before   — ISO date; due_date <= this  (Today / Overdue)
//   due_after    — ISO date; due_date >= this  (Upcoming)
//   q            — substring search on title
//   limit        — max 200 (default 100)
//   service_ticket_id — one work order's tasks (its punch list)
//   include_work_orders — '1' → do NOT hide buildings (escape hatch)
//   count_only   — '1' → { count } only: every filter, no limit, no joins
// Archived tasks are always excluded.
//
// A BUILDING ON A WORK ORDER IS NOT A TO-DO, AND IS NOT ON THIS LIST (1.33).
// A work order's punch list is a list of BUILDINGS, stored as ordinary org
// tasks carrying service_ticket_id. They are not to-dos: a building lives on
// its work order, is finished there under the photo rule, and moves the ticket
// when the last one is done. Mixing them into My Tasks, Team Tasks, a job's
// Tasks panel or My Day made one job's twelve buildings drown every real
// to-do in the company. So every general task list now hides them.
//
// The person a building is assigned to has not lost it. They reach it from
// Service Tickets → My work, from the work-orders strip on My Day, and from
// the morning digest — and GET /api/tasks/:id still opens one by id, which is
// what those surfaces link to.
//
// The rule is ONE predicate, in server/services/service-ticket-subtask-door.js
// (notAWorkOrderBuildingSql / isWorkOrderSubtask), so the SQL here and the JS
// the write doors ask cannot drift apart. Its `scope = 'personal'` arm is
// load-bearing in the other direction: a PRIVATE to-do that happens to carry a
// ticket id belongs to its owner and stays on their list.
// ──────────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ tasks: [] });

    // PRIVACY PREDICATE (load-bearing, caller id from req.user ONLY): everyone
    // sees org tasks; a personal To-do is visible ONLY to its owner. A personal
    // row owned by someone else matches zero rows. Mirrors notes-routes.js.
    const where = ['t.organization_id = $1', 't.archived_at IS NULL',
      "(t.scope = 'org' OR (t.scope = 'personal' AND t.owner_user_id = $2))"];
    const params = [orgId, Number(req.user.id)];
    let pn = 3;

    // BUILDINGS OFF THE LIST — the two cases that keep them, together in one
    // place so neither can be read without the other:
    //   1. service_ticket_id — asking for a ticket's tasks IS asking for its
    //      buildings. The work order's own punch list is the one list they
    //      belong on, and it is served from here.
    //   2. include_work_orders=1 — a deliberate escape hatch. No client sends
    //      it today; it exists so a future caller that genuinely wants both
    //      says so out loud rather than deleting the predicate.
    const skipBuildingRule = !!req.query.service_ticket_id ||
      String(req.query.include_work_orders || '') === '1';
    if (!skipBuildingRule) where.push(subtaskDoor.notAWorkOrderBuildingSql('t'));

    // 3-tier scope filter: scope='org' → org tasks only (the Team Tasks pane);
    // scope='personal' → the caller's OWN private to-dos only (My To-Dos). The
    // base privacy predicate already guarantees a personal row is the caller's,
    // so 'personal' here can only ever return the caller's own rows. Omit to
    // get both (back-compat with existing callers).
    const scopeFilter = String(req.query.scope || '').trim();
    if (scopeFilter === 'org') where.push("t.scope = 'org'");
    else if (scopeFilter === 'personal') where.push("t.scope = 'personal'");

    // NO PER-BUILDING FILTER, ANYWHERE (1.35). `assignee` filters on the TASK
    // row's own assignee, and a building on a work order has no owner of its
    // own: responsibility sits on the record (service_tickets.assignee_user_id)
    // and everyone on it is equally responsible for every building on its punch
    // list. So in exactly the two cases above — the ones that let buildings
    // onto this list — the filter is not applied at all. Answering
    // `?service_ticket_id=X&assignee=me` with "the buildings that name me"
    // would be a per-building owner filter wearing a general-purpose name, and
    // it would read as authoritative while meaning nothing.
    //
    // Filtering by the WORK ORDER's assignee is a different, real question, and
    // it is still answered — by GET /api/service-tickets/my-buildings, which
    // matches the caller on the ticket and then returns its WHOLE punch list.
    const assignee = skipBuildingRule ? '' : String(req.query.assignee || '').trim();
    if (assignee === 'me') {
      where.push('t.assignee_user_id = $' + (pn++));
      params.push(Number(req.user.id));
    } else if (assignee === 'unassigned') {
      where.push('t.assignee_user_id IS NULL');
    } else if (assignee) {
      const n = Number(assignee);
      if (Number.isInteger(n)) { where.push('t.assignee_user_id = $' + (pn++)); params.push(n); }
    }

    if (req.query.status && STATUSES.has(String(req.query.status))) {
      where.push('t.status = $' + (pn++));
      params.push(String(req.query.status));
    }
    if (String(req.query.exclude_done || '') === '1') {
      where.push("t.status <> 'done'");
    }
    if (req.query.kind && KINDS.has(String(req.query.kind))) {
      where.push('t.kind = $' + (pn++));
      params.push(String(req.query.kind));
    }
    // entity_type may be filtered alone (e.g. "all open lead follow-ups"
    // for the Leads → Activities board) OR together with entity_id (the
    // per-entity Tasks panel). Both stay org-scoped via the base WHERE.
    if (req.query.entity_type && LINKABLE_ENTITY_TYPES.has(String(req.query.entity_type))) {
      where.push('t.entity_type = $' + (pn++)); params.push(String(req.query.entity_type));
      if (req.query.entity_id) {
        where.push('t.entity_id = $' + (pn++)); params.push(String(req.query.entity_id));
      }
    }
    // The work-order filter — "this ticket's tasks". Independent of the
    // entity_type/entity_id pair above, and both may be applied at once, which
    // is the point: a task carries its job AND its ticket.
    //
    // No in-org proof needed here (unlike the write path): the base WHERE
    // already pins organization_id, so a foreign ticket id simply matches
    // nothing rather than reaching another tenant's rows.
    if (req.query.service_ticket_id) {
      where.push('t.service_ticket_id = $' + (pn++));
      params.push(String(req.query.service_ticket_id));
    }
    if (req.query.due_before) {
      where.push('t.due_date IS NOT NULL AND t.due_date <= $' + (pn++));
      params.push(String(req.query.due_before));
    }
    if (req.query.due_after) {
      where.push('t.due_date IS NOT NULL AND t.due_date >= $' + (pn++));
      params.push(String(req.query.due_after));
    }
    if (req.query.q) {
      where.push('t.title ILIKE $' + (pn++));
      params.push('%' + String(req.query.q).trim() + '%');
    }

    // count_only=1 — the SAME rows the list would return, counted in the
    // database. The admin console's "Open tasks" KPI used to be the LENGTH OF
    // A PAGE: it fetched limit=200 and counted the array, so an org with more
    // than 200 open tasks read "200" forever. A count is not a page, so there
    // is no LIMIT, no join and no photo_count subquery here — and no `tasks`
    // key in the body, so nothing can mistake this for a truncated list.
    if (String(req.query.count_only || '') === '1') {
      const countSql = 'SELECT COUNT(*)::int AS count FROM tasks t WHERE ' + where.join(' AND ');
      const cr = await pool.query(countSql, params);
      return res.json({ count: Number((cr.rows[0] && cr.rows[0].count) || 0) });
    }

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));

    // Order: incomplete first, then by due date (NULLs last), then by
    // priority weight, then most-recently-touched. Matches the "what
    // needs doing" reading order of the My Tasks list.
    const sql =
      'SELECT t.*, ' +
      '       au.name AS assignee_name, ' +
      '       cu.name AS created_by_name, ' +
      // THE PHOTO COUNT CARRIES THE COMPANY. entity_type='task' + entity_id
      // is a polymorphic key with no tenant in it: task ids are random, but
      // "every query carries the organization" is the rule, not a bet on id
      // collisions. The tolerance arm is REQUIRED, not optional —
      // attachments.organization_id is nullable and only as current as the
      // last boot's backfill (see the header of
      // server/services/attachment-org-scope.js), so bare equality would
      // silently zero the completion-photo count on legacy rows, and that
      // count is the photo signal the whole work-order rule rests on.
      '       (SELECT COUNT(*)::int FROM attachments a ' +
      "          WHERE a.entity_type = 'task' AND a.entity_id = t.id " +
      '            AND (a.organization_id = t.organization_id OR a.organization_id IS NULL)) AS photo_count ' +
      '  FROM tasks t ' +
      '  LEFT JOIN users au ON au.id = t.assignee_user_id ' +
      '  LEFT JOIN users cu ON cu.id = t.created_by ' +
      ' WHERE ' + where.join(' AND ') +
      " ORDER BY (t.status = 'done') ASC, " +
      '          t.due_date ASC NULLS LAST, ' +
      "          CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END ASC, " +
      '          t.updated_at DESC ' +
      ' LIMIT ' + limit;

    const { rows } = await pool.query(sql, params);
    // Hydrate linked-record labels (client/job/lead/...) in one batched
    // pass so list consumers (My Day) can show the link without N+1.
    await require('../services/entity-labels').attachEntityLabels(orgId, rows);
    res.json({ tasks: rows });
  } catch (e) {
    console.error('GET /api/tasks error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tasks/:id — single task, hydrated with assignee + creator
// names, linked-entity label, and photo count.
//
// NO BUILDING EXCLUSION HERE, DELIBERATELY. The list above hides a work
// order's buildings; a read BY ID must still answer with one. This is the
// door every replacement surface links to — Service Tickets → My work, the My
// Day work-orders strip, the morning digest and window.p86Tasks.openDetail all
// open a building by its id, and it is how the assignee reaches theirs to tick
// it off. Adding notAWorkOrderBuildingSql here would look like finishing the
// job and would instead strand the crew lead the rule is meant to serve.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Task not found' });
    const { rows } = await pool.query(
      'SELECT t.*, ' +
      '       au.name AS assignee_name, ' +
      '       cu.name AS created_by_name, ' +
      // Same org predicate, same tolerance arm, same reason as the list above.
      '       (SELECT COUNT(*)::int FROM attachments a ' +
      "          WHERE a.entity_type = 'task' AND a.entity_id = t.id " +
      '            AND (a.organization_id = t.organization_id OR a.organization_id IS NULL)) AS photo_count ' +
      '  FROM tasks t ' +
      '  LEFT JOIN users au ON au.id = t.assignee_user_id ' +
      '  LEFT JOIN users cu ON cu.id = t.created_by ' +
      ' WHERE t.id = $1 AND t.organization_id = $2' +
      "   AND (t.scope = 'org' OR (t.scope = 'personal' AND t.owner_user_id = $3))",
      [req.params.id, orgId, Number(req.user.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = rows[0];
    task.linked_label = await resolveEntityLabel(orgId, task.entity_type, task.entity_id);
    res.json({ task: task });
  } catch (e) {
    console.error('GET /api/tasks/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/tasks
// Body: { title (required), notes?, kind?, status?, priority?, due_date?,
//   assignee_user_id?, entity_type?, entity_id?, checklist? }
router.post('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const body = req.body || {};

    const title = (typeof body.title === 'string' && body.title.trim())
      ? body.title.trim().slice(0, 500)
      : '';
    if (!title) return res.status(400).json({ error: 'title is required' });

    // Personal to-do (3-tier model): scope='personal' makes this row private to
    // the creator — visible ONLY to them (the fail-closed read predicate keys
    // on owner_user_id), and never assignable to another user. Org tasks (the
    // default) stay assignable + org-viewable.
    const wantPersonal = String(body.scope) === 'personal';

    // CREATING A BUILDING NEVER ACCEPTS AN ASSIGNEE (1.35). An org task with a
    // service_ticket_id is a building on that work order's punch list, and a
    // building is never assigned to one person — the work order's own Assigned
    // to is the one that means anything, and everyone on it is equally
    // responsible for the whole punch list. Refused BY NAME and before the
    // assignee is even validated, rather than dropped: "created" with the
    // assignee silently gone is a lie the caller would act on.
    const assigneeSent = body.assignee_user_id != null && body.assignee_user_id !== '';
    if (!wantPersonal && body.service_ticket_id && assigneeSent) {
      return sendRefusal(res, subtaskDoor.assignVerdict());
    }

    // Assignee applies to ORG tasks only; a personal to-do is for the creator.
    if (!wantPersonal && body.assignee_user_id != null && !(await assigneeOk(orgId, body.assignee_user_id))) {
      return res.status(400).json({ error: 'Invalid assignee' });
    }
    // Same proof for the work order, and for the same reason.
    if (body.service_ticket_id && !(await serviceTicketOk(orgId, body.service_ticket_id))) {
      return res.status(400).json({ error: 'Invalid service ticket' });
    }

    const id = newId();
    const cols = ['id', 'organization_id', 'title', 'created_by'];
    const vals = ['$1', '$2', '$3', '$4'];
    // created_by = attributed user (acted-as target when disguised). NOTE:
    // owner_user_id (personal-todo block below) is deliberately NOT flipped —
    // it doubles as the read/PATCH/DELETE owner guard, so flipping it would
    // hide an acted-as personal to-do from the real admin. created_by is the
    // safe author flip; all owner_user_id predicates stay on req.user.id.
    const params = [id, orgId, title, Number(getAttributedUserId(req))];
    let pn = 5;

    // Stamp the private scope + owner from the SESSION (never the body's
    // owner_user_id) so a personal to-do can only ever belong to its creator.
    if (wantPersonal) {
      cols.push('scope');         vals.push("'personal'");
      cols.push('owner_user_id'); vals.push('$' + pn++); params.push(Number(req.user.id));
    }

    if (typeof body.notes === 'string')              { cols.push('notes');    vals.push('$' + pn++); params.push(body.notes.slice(0, 5000)); }
    if (body.kind && KINDS.has(String(body.kind)))   { cols.push('kind');     vals.push('$' + pn++); params.push(String(body.kind)); }
    if (body.status && STATUSES.has(String(body.status))) { cols.push('status'); vals.push('$' + pn++); params.push(String(body.status)); }
    if (body.priority && PRIORITIES.has(String(body.priority))) { cols.push('priority'); vals.push('$' + pn++); params.push(String(body.priority)); }
    if (body.due_date)                               { cols.push('due_date'); vals.push('$' + pn++); params.push(String(body.due_date)); }
    if (!wantPersonal && body.assignee_user_id != null) { cols.push('assignee_user_id'); vals.push('$' + pn++); params.push(Number(body.assignee_user_id)); }
    if (body.entity_type && body.entity_id && LINKABLE_ENTITY_TYPES.has(String(body.entity_type))) {
      cols.push('entity_type'); vals.push('$' + pn++); params.push(String(body.entity_type));
      cols.push('entity_id');   vals.push('$' + pn++); params.push(String(body.entity_id));
    }
    // The work order this task belongs to. Proved in-org above, alongside the
    // assignee check, because the FK only proves the ticket EXISTS — never
    // whose it is.
    if (body.service_ticket_id) {
      cols.push('service_ticket_id'); vals.push('$' + pn++); params.push(String(body.service_ticket_id));
    }
    if (Array.isArray(body.checklist)) {
      cols.push('checklist'); vals.push('$' + pn++ + '::jsonb'); params.push(JSON.stringify(normalizeChecklist(body.checklist)));
    }
    if (typeof body.directions === 'string') { cols.push('directions'); vals.push('$' + pn++); params.push(body.directions.slice(0, 3000)); }
    // Geo pin — only persist when BOTH coords are valid (a half-set pin is meaningless).
    const _glat = Number(body.lat), _glng = Number(body.lng), _gacc = Number(body.geo_accuracy);
    if (Number.isFinite(_glat) && _glat >= -90 && _glat <= 90 && Number.isFinite(_glng) && _glng >= -180 && _glng <= 180) {
      cols.push('lat'); vals.push('$' + pn++); params.push(_glat);
      cols.push('lng'); vals.push('$' + pn++); params.push(_glng);
      if (Number.isFinite(_gacc) && _gacc > 0) { cols.push('geo_accuracy'); vals.push('$' + pn++); params.push(_gacc); }
    }
    // If created already-done, stamp completed_at.
    if (body.status === 'done') { cols.push('completed_at'); vals.push('NOW()'); }

    // A BUILDING ADDED TO A WORK ORDER. Written as an org subtask that starts
    // open (both stated, never left to a column default), under the ticket's
    // lock, by someone who can edit the ticket's job or lead, and only while
    // the ticket is not approved, closed or cancelled. It is a timeline line,
    // and a ticket awaiting approval goes back to In progress. A personal
    // to-do hanging off a ticket is its owner's and never a subtask.
    const onWorkOrder = !wantPersonal && !!body.service_ticket_id;
    if (onWorkOrder) {
      if (cols.indexOf('status') < 0) { cols.push('status'); vals.push("'open'"); }
      cols.push('scope'); vals.push("'org'");
    }

    const sql = 'INSERT INTO tasks (' + cols.join(', ') + ') VALUES (' + vals.join(', ') + ') RETURNING *';
    let task;
    let workOrderResult = null;
    if (onWorkOrder) {
      const ticketId = String(body.service_ticket_id);
      const actor = userActor(req);
      const out = await inTransaction(async (client) => {
        const ticket = (await subtaskDoor.lockTickets(client, orgId, [ticketId])).get(ticketId);
        if (!ticket) return { refusal: { status: 400, error: 'Invalid service ticket' } };
        const verdict = await subtaskDoor.structureVerdict(client, { user: req.user, orgId, ticket });
        if (!verdict.ok) return { refusal: verdict };
        if (String(body.status) === 'done') {
          return { refusal: { status: 409, error: subtaskDoor.MSG.startsOpen, code: 'subtask_starts_open' } };
        }
        const inserted = (await client.query(sql, params)).rows[0];
        await workOrder.insertEvent(client, ticket, 'task_added', actor,
          { task_id: inserted.id, title: String(inserted.title || '').slice(0, 200) }, { strict: true });
        const moved = await workOrder.recountTicket(client, ticket, actor, 'subtask_added');
        return { task: inserted, workOrder: workOrderOut(ticket, moved) };
      });
      if (out.refusal) return sendRefusal(res, out.refusal);
      task = out.task;
      workOrderResult = out.workOrder;
    } else {
      const { rows } = await pool.query(sql, params);
      task = rows[0];
    }

    // Notify on assignment to someone other than the creator.
    if (task.assignee_user_id && Number(task.assignee_user_id) !== Number(req.user.id)) {
      maybeNotifyAssignee(task, req.user.id, { reason: 'created' });
    }

    res.json(workOrderResult ? { task: task, work_order: workOrderResult } : { task: task });
  } catch (e) {
    console.error('POST /api/tasks error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/tasks/:id — partial update. Only EDITABLE_FIELDS accepted.
// status→done stamps completed_at; leaving done clears it. A changed
// assignee (to a non-actor) re-fires the assignment notification.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Task not found' });
    const body = req.body || {};

    const prior = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND organization_id = $2' +
      "   AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $3))",
      [req.params.id, orgId, Number(req.user.id)]
    );
    if (!prior.rowCount) return res.status(404).json({ error: 'Task not found' });
    const before = prior.rows[0];

    // THE PUNCH-LIST DOOR. A change to done-ness on a building of a work order,
    // or putting a task on, moving it between or taking it off a work order,
    // does not write the task directly: it runs under the tickets' locks with
    // the rules the office checkbox and the crew link use (see the header of
    // services/service-ticket-subtask-door.js). Everything else a PATCH carries
    // — title, notes, due date, the link itself — is still the generic UPDATE
    // below, run on the same transaction.
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const statusIn = has('status') && STATUSES.has(String(body.status)) ? String(body.status) : null;
    const finalStatus = statusIn || before.status;
    const touchesDone = (finalStatus === 'done') !== (before.status === 'done');
    const oldTicketId = before.service_ticket_id != null && before.service_ticket_id !== '' ? String(before.service_ticket_id) : null;
    const sentTicketId = has('service_ticket_id') && body.service_ticket_id != null && body.service_ticket_id !== ''
      ? String(body.service_ticket_id) : null;
    const newTicketId = has('service_ticket_id') ? sentTicketId : oldTicketId;
    const linkChange = has('service_ticket_id') && sentTicketId !== oldTicketId;
    const onWorkOrder = !!(newTicketId || oldTicketId);
    // Any status write on a building also runs under the ticket lock, so it is
    // decided on the task row as it is under the lock and not as it was read
    // above (A10 — a crew tick landing in between would otherwise be written
    // over).
    const assignRaw = has('assignee_user_id') ? body.assignee_user_id : undefined;
    const assignTo = assignRaw === undefined ? undefined
      : ((assignRaw === '' || assignRaw == null) ? null : Number(assignRaw));
    const assignChange = assignTo !== undefined && (assignTo === null || Number.isInteger(assignTo)) &&
      Number(before.assignee_user_id) !== Number(assignTo);
    const statusChange = !!statusIn && statusIn !== before.status;
    // REPLY ONLY (1.50). A line's kind decides whether it needs a completion
    // photo (svc.subtaskNeedsPhoto), so turning reply only on or off for a
    // building changes what its work order's punch list asks for proof of. It
    // is the door's, under the punch-list rule — never a quiet field edit the
    // crew lead could make on a line they are about to tick. A kind change that
    // leaves the photo question alone (todo <-> punch) is an ordinary edit.
    const kindIn = has('kind') && KINDS.has(String(body.kind)) ? String(body.kind) : null;
    const photoRuleMoves = (row) => !!kindIn && svc.subtaskNeedsPhoto({ kind: kindIn }) !== svc.subtaskNeedsPhoto(row);
    const kindChange = photoRuleMoves(before);

    // A BUILDING IS NEVER ASSIGNED TO ANYBODY (1.35). Not by the office, not by
    // a job editor, not by the person it used to name. This is no longer a
    // permission question — the work order's own Assigned to is where
    // responsibility lives, and everyone on that record is equally responsible
    // for every building on it — so it is refused before the transaction
    // rather than asked inside it.
    //
    // The test is where the row ENDS UP, not where it was: putting a plain task
    // onto a work order and naming an assignee in the same PATCH would make an
    // assigned building, and taking a building OFF one while assigning it is
    // fine, because afterwards it is an ordinary task again. Clearing an
    // assignee is refused too — a value an older release left on a building row
    // is history nothing reads, and rewriting it is still writing the field.
    //
    // AND AN ARCHIVED BUILDING IS STILL A BUILDING. This deliberately does NOT
    // ask about archived_at, unlike `throughDoor` below, where it means
    // something else (an archived row has left its work order's punch list, so
    // finishing it must not move the ticket). A rule stated as absolute cannot
    // carry a silent exception for a row that is out of sight: an unarchive
    // feature would inherit it, and until then the only thing the exception
    // bought was a write nobody reads.
    const endsUpABuilding = before.scope === 'org' && !!newTicketId;
    if (assignChange && endsUpABuilding) return sendRefusal(res, subtaskDoor.assignVerdict());

    const throughDoor = before.scope === 'org' && !before.archived_at &&
      ((touchesDone && onWorkOrder) || linkChange || (onWorkOrder && (statusChange || assignChange || kindChange)));
    // The door owns status and completed_at when done-ness changes on a task
    // that ends up on a work order. A task being taken OFF one keeps the
    // generic status write, because it is no longer a subtask afterwards.
    const doorOwnsDone = throughDoor && touchesDone && !!newTicketId;

    const sets = [];
    const params = [];
    let pn = 1;
    let assigneeChangedTo = undefined; // tracks a real assignee change

    for (const key of Object.keys(body)) {
      if (!EDITABLE_FIELDS.has(key)) continue;
      let val = body[key];

      if (key === 'title') {
        val = (typeof val === 'string' && val.trim()) ? val.trim().slice(0, 500) : null;
        if (!val) continue; // never blank out a required title
      } else if (key === 'notes') {
        val = (val == null) ? null : String(val).slice(0, 5000);
      } else if (key === 'kind') {
        if (!KINDS.has(String(val))) continue; val = String(val);
      } else if (key === 'status') {
        if (!STATUSES.has(String(val))) continue; val = String(val);
        if (doorOwnsDone) continue;
      } else if (key === 'priority') {
        if (!PRIORITIES.has(String(val))) continue; val = String(val);
      } else if (key === 'due_date') {
        val = (val === '' || val == null) ? null : String(val);
      } else if (key === 'directions') {
        val = (val == null) ? null : String(val).slice(0, 3000);
      } else if (key === 'lat' || key === 'lng' || key === 'geo_accuracy') {
        if (val === '' || val == null) { val = null; }
        else {
          const _n = Number(val);
          if (!Number.isFinite(_n)) continue;
          if (key === 'lat' && (_n < -90 || _n > 90)) continue;
          if (key === 'lng' && (_n < -180 || _n > 180)) continue;
          val = _n;
        }
      } else if (key === 'assignee_user_id') {
        if (val === '' || val == null) {
          val = null;
        } else {
          const n = Number(val);
          if (!Number.isInteger(n)) continue;
          if (!(await assigneeOk(orgId, n))) return res.status(400).json({ error: 'Invalid assignee' });
          val = n;
        }
        // Did the assignee actually change?
        if (Number(before.assignee_user_id) !== Number(val)) assigneeChangedTo = val;
      } else if (key === 'service_ticket_id') {
        if (val === '' || val == null) {
          val = null;
        } else {
          if (!(await serviceTicketOk(orgId, val))) {
            return res.status(400).json({ error: 'Invalid service ticket' });
          }
          val = String(val);
        }
      } else if (key === 'entity_type') {
        val = (val === '' || val == null) ? null : (LINKABLE_ENTITY_TYPES.has(String(val)) ? String(val) : before.entity_type);
      } else if (key === 'entity_id') {
        val = (val === '' || val == null) ? null : String(val);
      } else if (key === 'checklist') {
        sets.push('checklist = $' + (pn++) + '::jsonb');
        params.push(JSON.stringify(normalizeChecklist(val)));
        continue;
      }

      sets.push(key + ' = $' + (pn++));
      params.push(val);
    }

    // completed_at bookkeeping — sync with status transitions.
    if (!doorOwnsDone && has('status') && STATUSES.has(String(body.status))) {
      if (String(body.status) === 'done' && before.status !== 'done') {
        sets.push('completed_at = NOW()');
      } else if (String(body.status) !== 'done' && before.status === 'done') {
        sets.push('completed_at = NULL');
      }
    }

    if (!sets.length && !throughDoor) return res.json({ task: before });
    // An org task that was on no work order when it was read writes its status
    // or assignee without the lock, so the write only lands if it is STILL on
    // none: a task put on a work order in between is a building now, and its
    // status and assignee are the door's to decide.
    const stillUnlinked = !throughDoor && before.scope === 'org' && !before.archived_at && !oldTicketId &&
      (statusChange || assignChange);
    let sql = null;
    if (sets.length) {
      sets.push('updated_at = NOW()');
      params.push(req.params.id, orgId, Number(req.user.id));
      sql =
        'UPDATE tasks SET ' + sets.join(', ') +
        ' WHERE id = $' + (pn++) + ' AND organization_id = $' + (pn++) +
        "   AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $" + (pn++) + '))' +
        (stillUnlinked ? ' AND service_ticket_id IS NULL' : '') +
        ' RETURNING *';
    }

    if (!throughDoor) {
      const r = await pool.query(sql, params);
      if (!r.rowCount && stillUnlinked) return sendRefusal(res, subtaskDoor.stale());
      if (!r.rowCount) return res.status(404).json({ error: 'Task not found' });
      const task = r.rows[0];

      if (assigneeChangedTo != null && Number(assigneeChangedTo) !== Number(req.user.id)) {
        maybeNotifyAssignee(task, req.user.id, { reason: 'reassigned' });
      }

      return res.json({ task: task });
    }

    const actor = userActor(req);
    const out = await inTransaction(async (client) => {
      const locked = await subtaskDoor.lockTickets(client, orgId, [oldTicketId, newTicketId]);
      const oldTicket = oldTicketId ? (locked.get(oldTicketId) || null) : null;
      const newTicket = newTicketId ? (locked.get(newTicketId) || null) : null;
      if (newTicketId && !newTicket) return { refusal: { status: 400, error: 'Invalid service ticket' } };

      // The task as it is NOW, under the tickets' locks. Every door that
      // changes a building locks its ticket first, so no other door can move,
      // finish or reopen this row between this read and COMMIT. If one did so
      // between the read above and the lock, what this request decided from
      // `before` is stale: refuse, never write over it.
      const fresh = await client.query(
        'SELECT * FROM tasks WHERE id = $1 AND organization_id = $2' +
        "   AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $3)) FOR UPDATE",
        [before.id, orgId, Number(req.user.id)]
      );
      if (!fresh.rows[0]) return { refusal: { status: 404, error: 'Task not found' } };
      if (subtaskDoor.taskShifted(before, fresh.rows[0])) return { refusal: subtaskDoor.stale() };
      const current = fresh.rows[0];

      if (linkChange) {
        for (const t of [oldTicket, newTicket]) {
          if (!t) continue;
          const verdict = await subtaskDoor.structureVerdict(client, { user: req.user, orgId, ticket: t });
          if (!verdict.ok) return { refusal: verdict };
        }
        if (newTicket && finalStatus === 'done') {
          const photos = (await workOrder.taskPhotosByTask(client, orgId, [before.id])).get(String(before.id)) || [];
          // The kind the task will HAVE after this request: a finished follow-up
          // may join a work order without a photo, as a reply-only line.
          const kindAfter = kindIn || current.kind;
          if (!svc.subtaskMayComplete(photos, { kind: kindAfter }).ok) {
            return { refusal: { status: 409, error: subtaskDoor.MSG.doneNeedsPhoto, code: 'completion_photo_required' } };
          }
        }
      } else {
        // Not a link change, so newTicket is the ticket the task is on.
        //
        // Reply only on or off is a punch-list change (see kindChange): only
        // someone who can edit the job, and not on a locked work order. Asked of
        // the row as it is under the lock.
        if (newTicket && photoRuleMoves(current)) {
          const verdict = await subtaskDoor.structureVerdict(client, { user: req.user, orgId, ticket: newTicket });
          if (!verdict.ok) return { refusal: verdict };
        }
        // A FINISHED reply-only line made to need a photo again would be a done
        // building with no completion photo — the state the photo guard exists
        // to prevent. Refused unless it already has one, or is being reopened
        // in the same request.
        const kindAfter = kindIn || current.kind;
        if (newTicket && current.status === 'done' && finalStatus === 'done' &&
            !svc.subtaskNeedsPhoto(current) && svc.subtaskNeedsPhoto({ kind: kindAfter })) {
          const photos = (await workOrder.taskPhotosByTask(client, orgId, [before.id])).get(String(before.id)) || [];
          if (!svc.subtaskMayComplete(photos).ok) {
            return { refusal: { status: 409, error: subtaskDoor.MSG.replyOnlyDoneNeedsPhoto, code: 'completion_photo_required' } };
          }
        }
        if (touchesDone) {
          // The WORK ORDER's assignee may finish its buildings (1.35), so the
          // verdict is asked of the LOCKED ticket row, never of the task.
          const verdict = await subtaskDoor.doneVerdict(client, { user: req.user, orgId, ticket: newTicket, task: current });
          if (!verdict.ok) return { refusal: verdict };
        }
        // No assignee arm here: an assignee change on a row that ends up a
        // building was refused above, before this transaction opened, and
        // taskShifted refuses the request outright if the row stopped being
        // one under the lock.
      }

      let task = current;
      if (sql) {
        const r = await client.query(sql, params);
        if (!r.rowCount) return { refusal: { status: 404, error: 'Task not found' } };
        task = r.rows[0];
      }

      const title = String(before.title || '').slice(0, 200);
      if (linkChange && oldTicket) {
        await workOrder.insertEvent(client, oldTicket, 'task_removed', actor,
          { task_id: before.id, title, reason: newTicket ? 'moved' : 'unlinked' }, { strict: true });
      }
      if (linkChange && newTicket) {
        await workOrder.insertEvent(client, newTicket, 'task_added', actor,
          { task_id: before.id, title }, { strict: true });
      }

      const moves = [];
      let summary = null;
      if (doorOwnsDone) {
        const result = await workOrder.setSubtaskDone(client, {
          ticket: newTicket, taskId: before.id, done: finalStatus === 'done', actor,
        });
        if (!result.ok) return { refusal: result };
        moves.push({ ticket: result.ticket, movedTo: result.movedTo });
        summary = workOrderOut(newTicket, result);
        // Reopening lands on 'open'; a PATCH that asked for In progress or
        // Blocked gets that status on top.
        if (finalStatus === 'in_progress' || finalStatus === 'blocked') {
          await client.query(
            'UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
            [finalStatus, before.id, orgId]
          );
        }
      } else if (linkChange && newTicket) {
        const moved = await workOrder.recountTicket(client, newTicket, actor, 'subtask_added');
        moves.push({ ticket: Object.assign({}, newTicket, { status: moved.ticketStatus }), movedTo: moved.movedTo });
        summary = workOrderOut(newTicket, moved);
      }
      if (linkChange && oldTicket) {
        const moved = await workOrder.recountTicket(client, oldTicket, actor, 'subtask_removed');
        moves.push({ ticket: Object.assign({}, oldTicket, { status: moved.ticketStatus }), movedTo: moved.movedTo });
        if (!summary) summary = workOrderOut(oldTicket, moved);
      }

      const again = await client.query(
        'SELECT * FROM tasks WHERE id = $1 AND organization_id = $2' +
        "   AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $3))",
        [before.id, orgId, Number(req.user.id)]
      );
      return { task: again.rows[0] || task, moves, workOrder: summary };
    });
    if (out.refusal) return sendRefusal(res, out.refusal);

    // After COMMIT only: the last building done tells the approvers.
    subtaskDoor.notifyMoves(out.moves, actor, null);
    if (assigneeChangedTo != null && Number(assigneeChangedTo) !== Number(req.user.id)) {
      maybeNotifyAssignee(out.task, req.user.id, { reason: 'reassigned' });
    }

    res.json(out.workOrder ? { task: out.task, work_order: out.workOrder } : { task: out.task });
  } catch (e) {
    console.error('PATCH /api/tasks/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/tasks/:id — soft archive.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Task not found' });
    // Archiving a BUILDING takes it off its work order's punch list: the same
    // write rule as adding one, a timeline line, and a recount — archiving the
    // last open building finishes the work order and tells the approvers.
    const prior = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL' +
      "   AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $3))",
      [req.params.id, orgId, Number(req.user.id)]
    );
    const before = prior.rows[0];
    if (before && subtaskDoor.isWorkOrderSubtask(before)) {
      const actor = userActor(req);
      const ticketId = String(before.service_ticket_id);
      const out = await inTransaction(async (client) => {
        const ticket = (await subtaskDoor.lockTickets(client, orgId, [ticketId])).get(ticketId);
        if (!ticket) return { refusal: { status: 404, error: 'Task not found' } };
        const verdict = await subtaskDoor.structureVerdict(client, { user: req.user, orgId, ticket });
        if (!verdict.ok) return { refusal: verdict };
        // Only while it is still on the ticket just locked: a building moved to
        // another work order in between would come off that one unrecounted.
        const r = await client.query(
          'UPDATE tasks SET archived_at = NOW(), updated_at = NOW() ' +
          ' WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL' +
          "   AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $3))" +
          '   AND service_ticket_id = $4',
          [req.params.id, orgId, Number(req.user.id), ticketId]
        );
        if (!r.rowCount) return { refusal: subtaskDoor.stale() };
        await workOrder.insertEvent(client, ticket, 'task_removed', actor,
          { task_id: before.id, title: String(before.title || '').slice(0, 200), reason: 'archived' }, { strict: true });
        const moved = await workOrder.recountTicket(client, ticket, actor, 'subtask_removed');
        return {
          moves: [{ ticket: Object.assign({}, ticket, { status: moved.ticketStatus }), movedTo: moved.movedTo }],
          workOrder: workOrderOut(ticket, moved),
        };
      });
      if (out.refusal) return sendRefusal(res, out.refusal);
      subtaskDoor.notifyMoves(out.moves, actor, null);
      return res.json({ ok: true, work_order: out.workOrder });
    }

    // An org task read on no work order is archived only if it is still on
    // none — one put on a work order in between is a building, and archiving
    // it is the door's.
    const stillUnlinked = !!before && before.scope === 'org' && before.service_ticket_id == null;
    const r = await pool.query(
      'UPDATE tasks SET archived_at = NOW(), updated_at = NOW() ' +
      ' WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL' +
      "   AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $3))" +
      (stillUnlinked ? ' AND service_ticket_id IS NULL' : ''),
      [req.params.id, orgId, Number(req.user.id)]
    );
    if (!r.rowCount && stillUnlinked) return sendRefusal(res, subtaskDoor.stale());
    if (!r.rowCount) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/tasks/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
