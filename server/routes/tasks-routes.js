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
    let sql;
    if (type === 'lead')      sql = 'SELECT title AS label FROM leads WHERE id = $1';
    else if (type === 'client') sql = 'SELECT name AS label FROM clients WHERE id = $1';
    else if (type === 'sub')   sql = 'SELECT name AS label FROM subs WHERE id = $1';
    else if (type === 'project') sql = 'SELECT name AS label FROM projects WHERE id = $1 AND organization_id = ' + Number(orgId);
    else if (type === 'estimate') sql = "SELECT COALESCE(data->>'name', data->>'title', 'Estimate') AS label FROM estimates WHERE id = $1";
    else if (type === 'job')   sql = "SELECT COALESCE(data->>'title', data->>'name', 'Job') AS label FROM jobs WHERE id = $1";
    else return '';
    const { rows } = await pool.query(sql, [String(id)]);
    return rows.length ? (rows[0].label || '') : '';
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
async function notifyTaskAssigned(task, actorUserId, opts) {
  opts = opts || {};
  try {
    if (!task || !task.assignee_user_id) return;

    const { rows } = await pool.query(
      'SELECT email, name, notification_prefs FROM users WHERE id = $1 AND active = TRUE',
      [Number(task.assignee_user_id)]
    );
    if (!rows.length) return;
    const u = rows[0];
    const prefs = u.notification_prefs || {};
    if (prefs.task_assignment === false) return; // user opted out
    if (!u.email) return;

    // Who performed the assignment?
    let actorName = 'A teammate';
    if (actorUserId != null) {
      try {
        const a = await pool.query('SELECT name FROM users WHERE id = $1', [Number(actorUserId)]);
        if (a.rows.length && a.rows[0].name) actorName = a.rows[0].name;
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
      tag: 'task_assignment'
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
  'due_date', 'assignee_user_id', 'entity_type', 'entity_id', 'checklist'
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
// Archived tasks are always excluded.
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

    // 3-tier scope filter: scope='org' → org tasks only (the Team Tasks pane);
    // scope='personal' → the caller's OWN private to-dos only (My To-Dos). The
    // base privacy predicate already guarantees a personal row is the caller's,
    // so 'personal' here can only ever return the caller's own rows. Omit to
    // get both (back-compat with existing callers).
    const scopeFilter = String(req.query.scope || '').trim();
    if (scopeFilter === 'org') where.push("t.scope = 'org'");
    else if (scopeFilter === 'personal') where.push("t.scope = 'personal'");

    const assignee = String(req.query.assignee || '').trim();
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

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));

    // Order: incomplete first, then by due date (NULLs last), then by
    // priority weight, then most-recently-touched. Matches the "what
    // needs doing" reading order of the My Tasks list.
    const sql =
      'SELECT t.*, ' +
      '       au.name AS assignee_name, ' +
      '       cu.name AS created_by_name, ' +
      '       (SELECT COUNT(*)::int FROM attachments a ' +
      "          WHERE a.entity_type = 'task' AND a.entity_id = t.id) AS photo_count " +
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
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Task not found' });
    const { rows } = await pool.query(
      'SELECT t.*, ' +
      '       au.name AS assignee_name, ' +
      '       cu.name AS created_by_name, ' +
      '       (SELECT COUNT(*)::int FROM attachments a ' +
      "          WHERE a.entity_type = 'task' AND a.entity_id = t.id) AS photo_count " +
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

    // Assignee applies to ORG tasks only; a personal to-do is for the creator.
    if (!wantPersonal && body.assignee_user_id != null && !(await assigneeOk(orgId, body.assignee_user_id))) {
      return res.status(400).json({ error: 'Invalid assignee' });
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
    if (Array.isArray(body.checklist)) {
      cols.push('checklist'); vals.push('$' + pn++ + '::jsonb'); params.push(JSON.stringify(normalizeChecklist(body.checklist)));
    }
    // If created already-done, stamp completed_at.
    if (body.status === 'done') { cols.push('completed_at'); vals.push('NOW()'); }

    const sql = 'INSERT INTO tasks (' + cols.join(', ') + ') VALUES (' + vals.join(', ') + ') RETURNING *';
    const { rows } = await pool.query(sql, params);
    const task = rows[0];

    // Notify on assignment to someone other than the creator.
    if (task.assignee_user_id && Number(task.assignee_user_id) !== Number(req.user.id)) {
      maybeNotifyAssignee(task, req.user.id, { reason: 'created' });
    }

    res.json({ task: task });
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
      } else if (key === 'priority') {
        if (!PRIORITIES.has(String(val))) continue; val = String(val);
      } else if (key === 'due_date') {
        val = (val === '' || val == null) ? null : String(val);
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
    if (Object.prototype.hasOwnProperty.call(body, 'status') && STATUSES.has(String(body.status))) {
      if (String(body.status) === 'done' && before.status !== 'done') {
        sets.push('completed_at = NOW()');
      } else if (String(body.status) !== 'done' && before.status === 'done') {
        sets.push('completed_at = NULL');
      }
    }

    if (!sets.length) return res.json({ task: before });
    sets.push('updated_at = NOW()');

    params.push(req.params.id, orgId, Number(req.user.id));
    const sql =
      'UPDATE tasks SET ' + sets.join(', ') +
      ' WHERE id = $' + (pn++) + ' AND organization_id = $' + (pn++) +
      "   AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $" + (pn++) + '))' +
      ' RETURNING *';
    const r = await pool.query(sql, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Task not found' });
    const task = r.rows[0];

    if (assigneeChangedTo != null && Number(assigneeChangedTo) !== Number(req.user.id)) {
      maybeNotifyAssignee(task, req.user.id, { reason: 'reassigned' });
    }

    res.json({ task: task });
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
    const r = await pool.query(
      'UPDATE tasks SET archived_at = NOW(), updated_at = NOW() ' +
      ' WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL' +
      "   AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $3))",
      [req.params.id, orgId, Number(req.user.id)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/tasks/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
