// THE SERVICE TICKETS PAGE — BOARD MODE OF THE ONE TICKET LIST DOOR.
//
// The company-wide Service Tickets page (sidebar → Operations → Service
// Tickets, js/work-orders-board.js) reads this mode. Its status pills, saved
// views, priority and jobs/leads filters, search and sort are all answered
// here, so the page pages through every ticket instead of filtering the newest
// few hundred in the browser.
//
// GET /api/service-tickets?board=1 is the SAME handler the job's Service
// Tickets tab reads. The org predicate, the archived filter and the visibility
// block (access.listVisibility written as SQL) are built by the route BEFORE
// this module is asked anything, and they arrive here as `where`. So "the page
// shows exactly what the job tab would show you" is true by construction: this
// module only ever ANDs more predicates onto that list, it never builds its
// own idea of who may see a ticket.
//
// Everything board-specific lives here so the route grows by a few lines:
//   STATUS_GROUPS, VIEWS, COUNTED_VIEWS, COUNTED_STATUS_GROUPS, SORTS, SEARCH_SQL
//   parseBoardQuery(query)       the query string, validated (400 on junk)
//   addDays(ymd, n)              calendar arithmetic, no timezone
//   boardDates(db, org, user)    today / weekEnd in the user's (else org's) zone
//   predicateFor(filters, env, b) the primitive filters as SQL
//   runBoard(db, opts)           the rows statement, the counts statement
//
// TENANCY. Every clause is on the ticket alias `t`, already pinned by the
// route's `t.organization_id = $1`. Every child subquery and join carries
// `<child>.organization_id = t.organization_id`, so a revision, share, event,
// flag or user of another tenant can never be counted or named on a row, even
// when its ticket id or user id collides with one of ours.
//
// The one deliberate exception is the write tier's narrow arm (jw / aw below).
// It mirrors the list's own owner and grant arms in
// server/routes/service-ticket-routes.js and the comment there: those arms
// return nothing, they only NARROW a ticket row already pinned to the caller's
// org, they match on the caller's own id, and pinning the job's org would make
// this page disagree with the detail door for a legacy job whose org column was
// never stamped.
//
// PARAMETERS. Postgres refuses a statement that binds a parameter it does not
// reference ("bind message supplies N parameters, but prepared statement
// requires M"), and sqlite does not care, so the harness cannot catch it. Each
// statement therefore gets its own binder over its own copy of the params, and
// binds a value only when a predicate asks for it. The counts statement starts
// from the route's baseParams, which stop BEFORE the caller id the task counts
// use, because the counts statement has no task counts.
//
// NO MONEY, NO OFFICE TEXT. Board rows are a slim, whitelisted column set: no
// scope, internal notes, guest log, materials or crew takeoff, and nothing
// priced. BOARD_ROW_KEYS is applied on the way out, so a column added to the
// SELECT by mistake still never reaches the page.
'use strict';

const tz = require('../timezone');
const access = require('./service-ticket-access');
const recipients = require('./work-order-recipients');
const flags = require('./service-ticket-flags');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_OFFSET = 5000;

// active, draft, scheduled, in_progress, awaiting_approval and closed are the
// job tab's own status pills (FILTERS and matchesFilter in
// js/service-tickets.js: All, Active, Draft, Scheduled, In progress, Awaiting
// approval, Closed), so a pill on the page lists what the same pill on a job
// lists. test/service-tickets-page.test.js holds the two together.
const STATUS_GROUPS = Object.freeze({
  open: Object.freeze(['draft', 'open', 'scheduled', 'in_progress', 'work_complete', 'approved']),
  unfinished: Object.freeze(['draft', 'open', 'scheduled', 'in_progress']),
  crew: Object.freeze(['open', 'scheduled', 'in_progress']),
  active: Object.freeze(['open', 'scheduled', 'in_progress', 'work_complete']),
  scheduled: Object.freeze(['scheduled']),
  in_progress: Object.freeze(['in_progress']),
  awaiting_approval: Object.freeze(['work_complete']),
  approved: Object.freeze(['approved']),
  draft: Object.freeze(['draft']),
  closed: Object.freeze(['closed', 'cancelled']),
  all: null,
});

// Presets of the primitives below. The page's pills.
const VIEWS = Object.freeze({
  open: Object.freeze({ status_group: 'open' }),
  my_approvals: Object.freeze({ approver: 'me' }),
  overdue: Object.freeze({ due: 'overdue' }),
  due_week: Object.freeze({ due: 'week' }),
  mine: Object.freeze({ assignee: 'me', status_group: 'open' }),
  unassigned: Object.freeze({ assignee: 'none', status_group: 'unfinished' }),
  no_link: Object.freeze({ link: 'none' }),
  flagged: Object.freeze({ flags: 'open' }),
  suggestions: Object.freeze({ suggestions: 'pending' }),
  closed: Object.freeze({ status_group: 'closed' }),
  all: Object.freeze({}),
});

const COUNTED_VIEWS = Object.freeze([
  'open', 'my_approvals', 'overdue', 'due_week', 'mine', 'unassigned', 'no_link', 'flagged', 'suggestions',
]);

// The status pills' counts (body.status_counts), in the pills' order.
const COUNTED_STATUS_GROUPS = Object.freeze([
  'all', 'active', 'draft', 'scheduled', 'in_progress', 'awaiting_approval', 'closed',
]);

const PRIORITIES = Object.freeze(['urgent', 'high', 'normal', 'low']);

// The explicit primitives a caller may add to a view, and their values.
const PRIMITIVES = Object.freeze({
  status_group: Object.freeze(Object.keys(STATUS_GROUPS)),
  due: Object.freeze(['overdue', 'week']),
  approver: Object.freeze(['me']),
  link: Object.freeze(['none']),
  flags: Object.freeze(['open']),
  suggestions: Object.freeze(['pending']),
  priority: PRIORITIES,
  parent: Object.freeze(['job', 'lead']),
});

const PRIORITY_RANK = "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";

const SORTS = Object.freeze({
  due: '(t.due_date IS NULL), t.due_date ASC, ' + PRIORITY_RANK + ', (t.scheduled_for IS NULL), t.scheduled_for ASC, t.created_at DESC, t.id ASC',
  priority: PRIORITY_RANK + ', (t.due_date IS NULL), t.due_date ASC, t.created_at DESC, t.id ASC',
  scheduled: '(t.scheduled_for IS NULL), t.scheduled_for ASC, ' + PRIORITY_RANK + ', t.id ASC',
  updated: 't.updated_at DESC, t.id ASC',
  created: 't.created_at DESC, t.id ASC',
});

// Board search: the title, the work order number, the address, the job's
// number, title or name, the lead's title and the assignee's name. `$$` is the
// route's placeholder: its add() swaps every one for the same parameter, so
// the whole clause binds one value. Each child read is pinned to the ticket's
// org, so a search can never match on another tenant's job, lead or user.
const SEARCH_SQL =
  '(t.title ILIKE $$ OR t.ticket_number ILIKE $$ OR t.street_address ILIKE $$ OR t.city ILIKE $$' +
  ' OR EXISTS (SELECT 1 FROM jobs jq WHERE jq.id = t.job_id AND jq.organization_id = t.organization_id' +
  " AND ((jq.data->>'jobNumber') ILIKE $$ OR (jq.data->>'title') ILIKE $$ OR (jq.data->>'name') ILIKE $$))" +
  ' OR EXISTS (SELECT 1 FROM leads lq WHERE lq.id = t.lead_id AND lq.organization_id = t.organization_id AND lq.title ILIKE $$)' +
  ' OR EXISTS (SELECT 1 FROM users uq WHERE uq.id = t.assignee_user_id AND uq.organization_id = t.organization_id AND uq.name ILIKE $$))';

// What a board row may carry. Nothing else leaves this module.
const BOARD_ROW_KEYS = Object.freeze([
  'id', 'ticket_number', 'title', 'job_id', 'lead_id', 'status', 'priority',
  'scheduled_for', 'due_date', 'assignee_user_id', 'assignee_name',
  'completed_at', 'closed_at', 'created_at', 'updated_at', 'street_address', 'city',
  'job_number', 'job_title', 'lead_title', 'task_total', 'task_done',
  'pending_suggestions', 'links_total', 'links_live', 'links_opened',
  'last_crew_at', 'open_flags', 'office_seen_at', 'new_from_crew', 'is_overdue',
]);
const COUNT_KEYS = Object.freeze(['task_total', 'task_done', 'pending_suggestions', 'links_total', 'links_live', 'links_opened', 'open_flags']);

function isOn(v) {
  return v === '1' || v === 'true' || v === 1 || v === true;
}

function present(v) {
  return v !== undefined && v !== null && v !== '';
}

function clampInt(v, min, max, fallback) {
  if (!present(v)) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// parseBoardQuery(query) -> { active, view, sort, limit, offset, includeCounts, filters, explicit, error }
// Inactive (no board=1) reads nothing else, so the job tab's list is untouched.
// filters is a list of [primitive, value] pairs: the view's preset first, then
// any explicit primitives, all ANDed together. explicit is those explicit
// pairs alone, so the counts can lay them over every other view's preset.
function parseBoardQuery(query) {
  const q = query || {};
  const out = { active: false, view: null, sort: null, limit: DEFAULT_LIMIT, offset: 0, includeCounts: false, filters: [], explicit: [], error: null };
  if (!isOn(q.board)) return out;
  out.active = true;

  const view = present(q.view) ? String(q.view) : 'open';
  if (!Object.prototype.hasOwnProperty.call(VIEWS, view)) {
    out.error = 'Unknown work order view';
    return out;
  }
  out.view = view;

  const sort = present(q.sort) ? String(q.sort) : 'due';
  if (!Object.prototype.hasOwnProperty.call(SORTS, sort)) {
    out.error = 'Unknown sort';
    return out;
  }
  out.sort = sort;

  const explicit = [];
  for (const name of Object.keys(PRIMITIVES)) {
    if (!present(q[name])) continue;
    const value = String(q[name]);
    if (PRIMITIVES[name].indexOf(value) < 0) {
      out.error = 'Unknown filter: ' + name;
      return out;
    }
    explicit.push([name, value]);
  }
  out.filters = viewFilters(view).concat(explicit);
  out.explicit = explicit;
  out.limit = clampInt(q.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  out.offset = clampInt(q.offset, 0, MAX_OFFSET, 0);
  out.includeCounts = isOn(q.include_counts);
  return out;
}

// 'YYYY-MM-DD' + n days, on the calendar. UTC arithmetic on a date with no
// time, so a daylight-saving weekend can never lose or add a day.
function addDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) throw new Error('addDays: not a calendar day: ' + ymd);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(n || 0)));
  return d.toISOString().slice(0, 10);
}

// Today in the caller's zone (their override, else the org's, else the
// platform default), never the request's and never the server's.
async function boardDates(db, orgId, userId, now) {
  const at = now instanceof Date ? now : (now ? new Date(now) : new Date());
  const r = await db.query(
    `SELECT o.timezone AS org_tz, u.timezone AS user_tz
       FROM organizations o
       LEFT JOIN users u ON u.id = $2 AND u.organization_id = o.id
      WHERE o.id = $1`,
    [orgId, userId == null ? null : userId]
  );
  const row = (r && r.rows && r.rows[0]) || {};
  const zone = tz.resolveTz(row.user_tz, row.org_tz);
  const today = tz.localDateInTz(zone, at);
  return { today, weekEnd: addDays(today, 6), nowIso: at.toISOString() };
}

// binder(params): p(key, value) appends the value once per key and returns
// its $n. A statement binds exactly what its predicates asked for.
function binder(params) {
  const list = Array.isArray(params) ? params.slice() : [];
  const refs = Object.create(null);
  return {
    params: list,
    p: function (key, value) {
      if (!(key in refs)) {
        list.push(value);
        refs[key] = '$' + list.length;
      }
      return refs[key];
    },
  };
}

function statusIn(group) {
  const list = STATUS_GROUPS[group];
  if (!list) return null;
  return 't.status IN (' + list.map(function (s) { return "'" + s + "'"; }).join(', ') + ')';
}

// The tickets the caller can EDIT, as SQL: listVisibility(user, _, 'write').
// A view grant sees a job but cannot approve its work, so the narrow arm asks
// for the job's owner or an 'edit' grant — the split mayAccessTicketParent
// draws. No arms is no rows.
function writeTierSql(vis, userId, b) {
  const v = vis || {};
  const arms = [];
  if (v.jobs === 'all') {
    arms.push('t.job_id IS NOT NULL');
  } else if (v.jobs === 'assigned' && userId != null) {
    const me = b.p('me', userId);
    arms.push(
      '(t.job_id IS NOT NULL AND (' +
        'EXISTS (SELECT 1 FROM jobs jw WHERE jw.id = t.job_id AND jw.owner_id = ' + me + ')' +
        ' OR EXISTS (SELECT 1 FROM job_access aw WHERE aw.job_id = t.job_id AND aw.user_id = ' + me + " AND aw.access_level = 'edit')))"
    );
  }
  if (v.leads) arms.push('(t.job_id IS NULL AND t.lead_id IS NOT NULL)');
  if (!arms.length) return '(1 = 0)';
  return arms.length === 1 ? arms[0] : '(' + arms.join(' OR ') + ')';
}

// One primitive as SQL. env: { today, weekEnd, nowIso, userId, writeVis }.
function primitiveSql(name, value, env, b) {
  const crew = statusIn('crew');
  const open = statusIn('open');
  switch (name) {
    case 'status_group':
      return statusIn(value);
    case 'due':
      if (value === 'overdue') {
        return '(t.due_date IS NOT NULL AND t.due_date < ' + b.p('today', env.today) + ' AND ' + crew + ')';
      }
      return '(t.due_date >= ' + b.p('today', env.today) + ' AND t.due_date <= ' + b.p('weekEnd', env.weekEnd) + ' AND ' + crew + ')';
    case 'approver': {
      if (env.userId == null) return '(1 = 0)';
      const tier = writeTierSql(env.writeVis, env.userId, b);
      if (tier === '(1 = 0)') return '(1 = 0)';
      return "(t.status = 'work_complete' AND " + tier + ' AND ' +
        recipients.myTicketRelationSql('t', b.p('me', env.userId)) + ')';
    }
    case 'link':
      return '(' + crew + ' AND NOT EXISTS (SELECT 1 FROM service_ticket_shares sn WHERE sn.ticket_id = t.id' +
        ' AND sn.organization_id = t.organization_id AND sn.revoked_at IS NULL AND sn.expires_at > ' + b.p('now', env.nowIso) + '))';
    case 'flags':
      return '(' + open + ' AND EXISTS (SELECT 1 FROM service_ticket_flags fo WHERE fo.ticket_id = t.id' +
        " AND fo.organization_id = t.organization_id AND fo.status = 'open'))";
    case 'suggestions':
      return '(' + open + ' AND EXISTS (SELECT 1 FROM service_ticket_revisions rp WHERE rp.ticket_id = t.id' +
        " AND rp.organization_id = t.organization_id AND rp.status = 'pending'))";
    case 'assignee':
      if (value === 'none') return 't.assignee_user_id IS NULL';
      if (env.userId == null) return '(1 = 0)';
      return 't.assignee_user_id = ' + b.p('me', env.userId);
    // Both values are checked against PRIMITIVES before they get here, so the
    // literal is one of a fixed few and binds nothing. A ticket with no
    // priority is Normal, as the job tab shows it.
    case 'priority':
      if (PRIORITIES.indexOf(value) < 0) throw new Error('service-ticket-board: unknown priority ' + value);
      return "(COALESCE(t.priority, 'normal') = '" + value + "')";
    // A converted lead's ticket carries a job and is the job's, exactly as the
    // list's visibility decides it.
    case 'parent':
      if (value === 'job') return '(t.job_id IS NOT NULL)';
      if (value === 'lead') return '(t.job_id IS NULL AND t.lead_id IS NOT NULL)';
      throw new Error('service-ticket-board: unknown parent ' + value);
    default:
      throw new Error('service-ticket-board: unknown primitive ' + name);
  }
}

// filters: [[name, value], ...] (or a plain {name: value} preset). Every
// clause ANDed; no clauses is every row the `where` already allows.
function predicateFor(filters, env, b) {
  const pairs = Array.isArray(filters)
    ? filters
    : Object.keys(filters || {}).map(function (k) { return [k, filters[k]]; });
  const parts = [];
  pairs.forEach(function (pair) {
    const sql = primitiveSql(pair[0], pair[1], env || {}, b);
    if (sql) parts.push(sql);
  });
  if (!parts.length) return '(1 = 1)';
  return parts.length === 1 ? parts[0] : '(' + parts.join(' AND ') + ')';
}

function viewFilters(view) {
  const preset = VIEWS[view] || {};
  return Object.keys(preset).map(function (k) { return [k, preset[k]]; });
}

// The rows statement. `params` already ends with the caller id the task counts
// reference; this statement's own values are appended after it.
function rowsStatement(o) {
  const b = binder(o.params);
  const env = o.env;
  const now = function () { return b.p('now', env.nowIso); };
  const predicate = predicateFor(o.query.filters, env, b);
  const sql =
    `SELECT t.id, t.ticket_number, t.title, t.job_id, t.lead_id, t.status, t.priority, t.scheduled_for, t.due_date,
            t.assignee_user_id, t.completed_at, t.closed_at, t.created_at, t.updated_at, t.street_address, t.city,
            jl.data->>'jobNumber' AS job_number, COALESCE(NULLIF(jl.data->>'title', ''), jl.data->>'name') AS job_title,
            CASE WHEN t.job_id IS NULL THEN ll.title END AS lead_title, ua.name AS assignee_name,
            ${o.taskCountCols},
            (SELECT COUNT(*)::int FROM service_ticket_revisions r WHERE r.ticket_id = t.id AND r.organization_id = t.organization_id AND r.status = 'pending') AS pending_suggestions,
            (SELECT COUNT(*)::int FROM service_ticket_shares s1 WHERE s1.ticket_id = t.id AND s1.organization_id = t.organization_id) AS links_total,
            (SELECT COUNT(*)::int FROM service_ticket_shares s2 WHERE s2.ticket_id = t.id AND s2.organization_id = t.organization_id AND s2.revoked_at IS NULL AND s2.expires_at > ${now()}) AS links_live,
            (SELECT COUNT(*)::int FROM service_ticket_shares s3 WHERE s3.ticket_id = t.id AND s3.organization_id = t.organization_id AND s3.revoked_at IS NULL AND s3.expires_at > ${now()} AND s3.opened_at IS NOT NULL) AS links_opened,
            (SELECT MAX(e.created_at) FROM service_ticket_events e WHERE e.ticket_id = t.id AND e.organization_id = t.organization_id AND e.actor_kind = 'share' AND e.kind <> 'share_opened') AS last_crew_at,
            (SELECT COUNT(*)::int FROM service_ticket_flags f WHERE f.ticket_id = t.id AND f.organization_id = t.organization_id AND f.status = 'open') AS open_flags,
            t.office_seen_at,
            (t.due_date IS NOT NULL AND t.due_date < ${b.p('today', env.today)} AND ${statusIn('crew')}) AS is_overdue
       FROM service_tickets t
       LEFT JOIN jobs jl ON jl.id = t.job_id AND jl.organization_id = t.organization_id
       LEFT JOIN leads ll ON ll.id = t.lead_id AND ll.organization_id = t.organization_id
       LEFT JOIN users ua ON ua.id = t.assignee_user_id AND ua.organization_id = t.organization_id
      WHERE ${o.where.join(' AND ')} AND ${predicate}
      ORDER BY ${SORTS[o.query.sort] || SORTS.due}
      LIMIT ${o.query.limit + 1} OFFSET ${o.query.offset}`;
  return { sql, params: b.params };
}

// The counts statement, over the same `where`: the query's total, one count
// per counted view and one per counted status group. Search (in `where`)
// narrows every one. Each kind of count leaves out only its OWN choice, so a
// number is exactly the rows its pill would list if it were pressed next:
//   total                 the selected view AND the status AND the rest
//   counts[view]          that view's preset AND the status AND the rest
//   status_counts[group]  the selected view AND that group AND the rest
// where "the status" is the explicit status_group and "the rest" is every
// other explicit primitive (priority, parent, due, link, ...). Each predicate
// is evaluated once per row in a derived table, so every FILTER only combines
// bare column references.
function countsStatement(o) {
  const b = binder(o.baseParams);
  const env = o.env;
  const explicit = Array.isArray(o.query.explicit) ? o.query.explicit : [];
  const statusPairs = explicit.filter(function (pair) { return pair[0] === 'status_group'; });
  const otherPairs = explicit.filter(function (pair) { return pair[0] !== 'status_group'; });
  const inner = [
    predicateFor(viewFilters(o.query.view), env, b) + ' AS p_view',
    predicateFor(statusPairs, env, b) + ' AS p_status',
    predicateFor(otherPairs, env, b) + ' AS p_other',
  ];
  const outer = ['(COUNT(*) FILTER (WHERE x.p_view AND x.p_status AND x.p_other))::int AS c_matching'];
  COUNTED_VIEWS.forEach(function (key) {
    inner.push(predicateFor(viewFilters(key), env, b) + ' AS v_' + key);
    outer.push('(COUNT(*) FILTER (WHERE x.v_' + key + ' AND x.p_status AND x.p_other))::int AS c_' + key);
  });
  COUNTED_STATUS_GROUPS.forEach(function (group) {
    inner.push(predicateFor([['status_group', group]], env, b) + ' AS g_' + group);
    outer.push('(COUNT(*) FILTER (WHERE x.p_view AND x.g_' + group + ' AND x.p_other))::int AS s_' + group);
  });
  const countsWhere = o.where.join(' AND ');
  const sql =
    'SELECT ' + outer.join(', ') +
    '\n  FROM (SELECT ' + inner.join(',\n               ') +
    '\n          FROM service_tickets t\n         WHERE ' + countsWhere + ') x';
  return { sql, params: b.params };
}

function shapeRow(row) {
  const r = row || {};
  const out = {};
  BOARD_ROW_KEYS.forEach(function (k) {
    if (k === 'new_from_crew') return;
    out[k] = r[k] === undefined ? null : r[k];
  });
  COUNT_KEYS.forEach(function (k) {
    const n = Number(out[k]);
    out[k] = Number.isFinite(n) ? n : 0;
  });
  out.is_overdue = out.is_overdue === true || out.is_overdue === 1 || out.is_overdue === '1' || out.is_overdue === 't';
  out.new_from_crew = flags.isNewFromCrew(out.last_crew_at, out.office_seen_at);
  const shaped = {};
  BOARD_ROW_KEYS.forEach(function (k) { shaped[k] = out[k]; });
  return shaped;
}

/**
 * runBoard(db, { orgId, user, userId, query, where, baseParams, params, taskCountCols, now?, hasCapability? })
 *   -> { status: 200, body }
 * `where`, `baseParams`, `params` and `taskCountCols` come from the list route,
 * visibility already applied. Throws on a database error; the route's catch
 * answers 500.
 */
async function runBoard(db, opts) {
  const o = opts || {};
  const query = o.query;
  const dates = await boardDates(db, o.orgId, o.userId, o.now);
  const env = {
    today: dates.today,
    weekEnd: dates.weekEnd,
    nowIso: dates.nowIso,
    userId: o.userId == null ? null : o.userId,
    writeVis: access.listVisibility(o.user, o.hasCapability, 'write'),
  };
  const rowsSt = rowsStatement({ query, where: o.where, params: o.params, taskCountCols: o.taskCountCols, env });
  const countsSt = query.includeCounts
    ? countsStatement({ query, where: o.where, baseParams: o.baseParams, env })
    : null;
  const results = await Promise.all([
    db.query(rowsSt.sql, rowsSt.params),
    countsSt ? db.query(countsSt.sql, countsSt.params) : Promise.resolve(null),
  ]);
  const rows = (results[0] && results[0].rows) || [];
  const hasMore = rows.length > query.limit;
  const body = {
    tickets: rows.slice(0, query.limit).map(shapeRow),
    today: dates.today,
    has_more: hasMore,
    next_offset: hasMore ? query.offset + query.limit : null,
  };
  if (countsSt) {
    const c = (results[1] && results[1].rows && results[1].rows[0]) || {};
    const num = function (v) { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    body.total = num(c.c_matching);
    body.counts = {};
    COUNTED_VIEWS.forEach(function (key) { body.counts[key] = num(c['c_' + key]); });
    body.status_counts = {};
    COUNTED_STATUS_GROUPS.forEach(function (group) { body.status_counts[group] = num(c['s_' + group]); });
  }
  return { status: 200, body };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_OFFSET,
  STATUS_GROUPS,
  VIEWS,
  COUNTED_VIEWS,
  COUNTED_STATUS_GROUPS,
  PRIORITIES,
  PRIMITIVES,
  SORTS,
  SEARCH_SQL,
  BOARD_ROW_KEYS,
  parseBoardQuery,
  addDays,
  boardDates,
  binder,
  writeTierSql,
  predicateFor,
  rowsStatement,
  countsStatement,
  runBoard,
};
