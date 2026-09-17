// THE SERVICE TICKETS PAGE'S BOARD MODULE, WITHOUT A DATABASE.
//
// server/services/service-ticket-board.js turns a query string into SQL that
// is ANDed onto the list route's own visibility. What this file pins, driven
// through the module's exports with a fake db that records every statement:
//   * parseBoardQuery refuses junk with the exact sentences, clamps paging and
//     is inert without board=1 (the job tab reads the same door).
//   * the status groups cover every ticket status, open and closed, no overlap.
//   * addDays is calendar arithmetic that no daylight-saving weekend can bend.
//   * boardDates takes today from the user's zone, else the org's.
//   * BIND EXACTNESS: every statement, for every view and sort and caller
//     shape, binds exactly the parameters its text references. Postgres
//     refuses anything else and the sqlite harness would not notice.
//   * a caller with no id gets (1 = 0) and binds nothing for "me".
//   * the write tier's narrow arm asks for an 'edit' grant (in the text here;
//     its behaviour is routes mutant l).
//   * every child subquery and each row-label join is pinned to the ticket's
//     org, except the two narrowing arms the list itself carries without one.
//   * the counts lay the explicit filters over every counted view, and the
//     status pill counts lay everything but the status over every group.
//   * priority and parent (jobs / leads) are fixed literals that bind nothing.
//   * rows are whitelisted: a priced or office-only column never leaves.
// Mutants at the end remove a guard from a temp copy and show the drive fail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const board = require('../server/services/service-ticket-board');
const svc = require('../server/services/service-tickets');

const BOARD = path.join(__dirname, '..', 'server', 'services', 'service-ticket-board.js');
const SOURCE = fs.readFileSync(BOARD, 'utf8');

const capsOf = (list) => (user, cap) => list.indexOf(cap) >= 0;

// The route's where for a narrow-tier caller: org, archived, visibility with $2.
const ROUTE_WHERE = [
  't.organization_id = $1',
  't.archived_at IS NULL',
  '((t.job_id IS NOT NULL AND (EXISTS (SELECT 1 FROM jobs j WHERE j.id = t.job_id AND j.owner_id = $2) OR EXISTS (SELECT 1 FROM job_access a WHERE a.job_id = t.job_id AND a.user_id = $2))))',
];
const TASK_COLS = '(SELECT COUNT(*)::int FROM tasks k WHERE k.service_ticket_id = t.id AND k.organization_id = t.organization_id AND k.owner_user_id = $3) AS task_total, 0 AS task_done';

function fakeDb(opts) {
  const o = opts || {};
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params: params || [] });
      if (/FROM organizations o/.test(sql)) return { rows: [{ org_tz: o.orgTz || 'America/New_York', user_tz: o.userTz || null }] };
      if (/FILTER/.test(sql)) return { rows: [o.counts || {}] };
      return { rows: o.rows || [] };
    },
  };
}

const referenced = (sql) => [...new Set((sql.match(/\$(\d+)\b/g) || []).map((m) => Number(m.slice(1))))].sort((a, b) => a - b);
const oneToN = (n) => Array.from({ length: n }, (_v, i) => i + 1);

describe('parseBoardQuery', () => {
  test('inactive without board=1, and nothing else is read', () => {
    const q = board.parseBoardQuery({ view: 'bogus', sort: 'bogus', due: 'soon' });
    expect(q.active).toBe(false);
    expect(q.error).toBeNull();
    expect(board.parseBoardQuery({ board: '0', view: 'bogus' }).error).toBeNull();
    expect(board.parseBoardQuery(undefined).active).toBe(false);
  });

  test('defaults: view open, sort due, limit 50, offset 0, no counts', () => {
    const q = board.parseBoardQuery({ board: '1' });
    expect([q.active, q.view, q.sort, q.limit, q.offset, q.includeCounts, q.error]).toEqual([true, 'open', 'due', 50, 0, false, null]);
    expect(q.filters).toEqual([['status_group', 'open']]);
    expect(board.parseBoardQuery({ board: 'true', include_counts: 'true' }).includeCounts).toBe(true);
    expect(board.parseBoardQuery({ board: '1', include_counts: '1' }).includeCounts).toBe(true);
    expect(board.parseBoardQuery({ board: '1', include_counts: '' }).includeCounts).toBe(false);
  });

  test('the exact refusals', () => {
    expect(board.parseBoardQuery({ board: '1', view: 'bogus' }).error).toBe('Unknown work order view');
    expect(board.parseBoardQuery({ board: '1', sort: 'bogus' }).error).toBe('Unknown sort');
    expect(board.parseBoardQuery({ board: '1', due: 'soon' }).error).toBe('Unknown filter: due');
    for (const name of ['status_group', 'approver', 'link', 'flags', 'suggestions', 'priority', 'parent']) {
      expect(board.parseBoardQuery({ board: '1', [name]: 'nope' }).error).toBe('Unknown filter: ' + name);
    }
    // A repeated parameter arrives as an array and is not a value.
    expect(board.parseBoardQuery({ board: '1', view: ['open', 'closed'] }).error).toBe('Unknown work order view');
    // Inherited keys are not views.
    expect(board.parseBoardQuery({ board: '1', view: 'toString' }).error).toBe('Unknown work order view');
  });

  test('limit clamps to 1..100 and offset to 0..5000; junk is the default', () => {
    const lim = (v) => board.parseBoardQuery({ board: '1', limit: v }).limit;
    const off = (v) => board.parseBoardQuery({ board: '1', offset: v }).offset;
    expect([lim('0'), lim('-5'), lim('7'), lim('100'), lim('101'), lim('abc'), lim(''), lim('12.9')]).toEqual([1, 1, 7, 100, 100, 50, 50, 12]);
    expect([off('-1'), off('20'), off('5000'), off('99999'), off('junk'), off('')]).toEqual([0, 20, 5000, 5000, 0, 0]);
  });

  test('explicit primitives AND with the view preset, preset first', () => {
    const q = board.parseBoardQuery({ board: '1', view: 'unassigned', due: 'week', flags: 'open' });
    expect(q.filters).toEqual([['assignee', 'none'], ['status_group', 'unfinished'], ['due', 'week'], ['flags', 'open']]);
    expect(q.explicit).toEqual([['due', 'week'], ['flags', 'open']]);
    expect(board.parseBoardQuery({ board: '1', view: 'all' }).filters).toEqual([]);
    expect(board.parseBoardQuery({ board: '1', view: 'overdue' }).explicit).toEqual([]);
  });
});

describe('the constants', () => {
  test('open plus closed is every ticket status, with no overlap', () => {
    const open = board.STATUS_GROUPS.open;
    const closed = board.STATUS_GROUPS.closed;
    expect(open.filter((s) => closed.indexOf(s) >= 0)).toEqual([]);
    expect(open.concat(closed).sort()).toEqual(svc.TICKET_STATUSES.slice().sort());
    for (const g of Object.keys(board.STATUS_GROUPS)) {
      for (const s of board.STATUS_GROUPS[g] || []) expect([g, svc.TICKET_STATUSES.indexOf(s) >= 0]).toEqual([g, true]);
    }
  });

  test('the counted status groups are the job tab\'s pills, each a real group', () => {
    expect(board.COUNTED_STATUS_GROUPS.slice()).toEqual(['all', 'active', 'draft', 'scheduled', 'in_progress', 'awaiting_approval', 'closed']);
    for (const g of board.COUNTED_STATUS_GROUPS) expect(Object.keys(board.STATUS_GROUPS)).toContain(g);
    expect(board.STATUS_GROUPS.active.slice()).toEqual(['open', 'scheduled', 'in_progress', 'work_complete']);
    expect(board.PRIMITIVES.priority.slice()).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(board.PRIMITIVES.parent.slice()).toEqual(['job', 'lead']);
  });

  test('every counted view is a view, and closed and all are not counted', () => {
    for (const v of board.COUNTED_VIEWS) expect(Object.keys(board.VIEWS)).toContain(v);
    expect(board.COUNTED_VIEWS).not.toContain('closed');
    expect(board.COUNTED_VIEWS).not.toContain('all');
    expect(Object.keys(board.SORTS)).toEqual(['due', 'priority', 'scheduled', 'updated', 'created']);
  });

  test('SEARCH_SQL uses the route placeholder and pins every child read to the ticket org', () => {
    expect(board.SEARCH_SQL.split('$$').length - 1).toBe(9);
    expect(board.SEARCH_SQL).toContain('jq.organization_id = t.organization_id');
    expect(board.SEARCH_SQL).toContain('lq.organization_id = t.organization_id');
    expect(board.SEARCH_SQL).toContain('uq.organization_id = t.organization_id');
    expect(board.SEARCH_SQL).toContain("(jq.data->>'name') ILIKE $$");
    expect(board.SEARCH_SQL).toContain('uq.name ILIKE $$');
  });
});

describe('addDays', () => {
  test('month end, year end, leap day and both DST weekends', () => {
    expect(board.addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(board.addDays('2026-12-28', 6)).toBe('2027-01-03');
    expect(board.addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(board.addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(board.addDays('2026-03-08', 6)).toBe('2026-03-14');
    expect(board.addDays('2026-10-31', 2)).toBe('2026-11-02');
    expect(board.addDays('2026-09-20', -1)).toBe('2026-09-19');
    expect(() => board.addDays('Sep 20', 1)).toThrow();
  });
});

describe('boardDates', () => {
  const NOW = new Date('2026-09-20T01:30:00Z');   // 9:30pm on the 19th in New York

  test('today in the org zone, the week end six days on, now as an ISO instant', async () => {
    const db = fakeDb({ orgTz: 'America/New_York' });
    expect(await board.boardDates(db, 7, 12, NOW)).toEqual({ today: '2026-09-19', weekEnd: '2026-09-25', nowIso: '2026-09-20T01:30:00.000Z' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].params).toEqual([7, 12]);
    expect(referenced(db.calls[0].sql)).toEqual([1, 2]);
    expect(db.calls[0].sql).toContain('u.organization_id = o.id');
  });

  test('the user\'s own zone wins, and a bad zone falls back', async () => {
    expect((await board.boardDates(fakeDb({ orgTz: 'America/New_York', userTz: 'Asia/Tokyo' }), 7, 12, NOW)).today).toBe('2026-09-20');
    expect((await board.boardDates(fakeDb({ orgTz: 'Nowhere/Nope', userTz: '' }), 7, null, NOW)).today).toBe('2026-09-19');
  });
});

describe('predicates', () => {
  const env = (over) => Object.assign({ today: '2026-09-19', weekEnd: '2026-09-25', nowIso: '2026-09-20T01:30:00.000Z', userId: 20, writeVis: { jobs: 'all', leads: true } }, over || {});

  test('a caller with no id: approver and assignee me are (1 = 0) and bind nothing', () => {
    for (const f of [[['approver', 'me']], [['assignee', 'me']]]) {
      const b = board.binder([1]);
      expect(board.predicateFor(f, env({ userId: null }), b)).toBe('(1 = 0)');
      expect(b.params).toEqual([1]);
    }
    const b = board.binder([1]);
    expect(board.predicateFor([['assignee', 'none']], env({ userId: null }), b)).toBe('t.assignee_user_id IS NULL');
    expect(b.params).toEqual([1]);
  });

  test('the binder appends a value once per key', () => {
    const b = board.binder([1, 2]);
    expect([b.p('me', 9), b.p('today', 'x'), b.p('me', 9)]).toEqual(['$3', '$4', '$3']);
    expect(b.params).toEqual([1, 2, 9, 'x']);
  });

  test('write tier: all, assigned with an edit grant, lead-only, none', () => {
    const tier = (vis, uid) => { const b = board.binder([]); return { sql: board.writeTierSql(vis, uid, b), params: b.params }; };
    expect(tier({ jobs: 'all', leads: false }, 20)).toEqual({ sql: 't.job_id IS NOT NULL', params: [] });
    const assigned = tier({ jobs: 'assigned', leads: false }, 20);
    expect(assigned.params).toEqual([20]);
    expect(assigned.sql).toContain('jw.owner_id = $1');
    expect(assigned.sql).toContain("aw.user_id = $1 AND aw.access_level = 'edit'");
    expect(tier({ jobs: 'none', leads: true }, 20)).toEqual({ sql: '(t.job_id IS NULL AND t.lead_id IS NOT NULL)', params: [] });
    expect(tier({ jobs: 'none', leads: false }, 20)).toEqual({ sql: '(1 = 0)', params: [] });
    expect(tier({ jobs: 'assigned', leads: false }, null)).toEqual({ sql: '(1 = 0)', params: [] });
    expect(tier({ jobs: 'all', leads: true }, 20).sql).toBe('(t.job_id IS NOT NULL OR (t.job_id IS NULL AND t.lead_id IS NOT NULL))');
  });

  test('my approvals is work complete AND the write tier AND the shared relation predicate', () => {
    const recipients = require('../server/services/work-order-recipients');
    const b = board.binder([1]);
    const sql = board.predicateFor([['approver', 'me']], env({ writeVis: { jobs: 'assigned', leads: false } }), b);
    expect(sql.indexOf("t.status = 'work_complete'")).toBeGreaterThan(-1);
    expect(sql).toContain("aw.access_level = 'edit'");
    expect(sql).toContain(recipients.myTicketRelationSql('t', '$2'));
    expect(b.params).toEqual([1, 20]);
    // No write arm at all: nothing to approve, nothing bound.
    const b2 = board.binder([1]);
    expect(board.predicateFor([['approver', 'me']], env({ writeVis: { jobs: 'none', leads: false } }), b2)).toBe('(1 = 0)');
    expect(b2.params).toEqual([1]);
  });

  test('priority, parent and the status pill groups are literals and bind nothing', () => {
    const b = board.binder([1]);
    expect(board.predicateFor([['priority', 'normal']], env(), b)).toBe("(COALESCE(t.priority, 'normal') = 'normal')");
    expect(board.predicateFor([['parent', 'job']], env(), b)).toBe('(t.job_id IS NOT NULL)');
    expect(board.predicateFor([['parent', 'lead']], env(), b)).toBe('(t.job_id IS NULL AND t.lead_id IS NOT NULL)');
    expect(board.predicateFor([['status_group', 'active']], env(), b)).toBe("t.status IN ('open', 'scheduled', 'in_progress', 'work_complete')");
    expect(board.predicateFor([['status_group', 'all']], env(), b)).toBe('(1 = 1)');
    expect(b.params).toEqual([1]);
    // A value that did not come through parseBoardQuery is refused, never pasted.
    expect(() => board.predicateFor([['priority', "x' OR 1=1 --"]], env(), board.binder([]))).toThrow(/unknown priority/);
    expect(() => board.predicateFor([['parent', 'both']], env(), board.binder([]))).toThrow(/unknown parent/);
  });

  test('an unknown primitive throws rather than silently matching everything', () => {
    expect(() => board.predicateFor([['colour', 'red']], env(), board.binder([]))).toThrow(/unknown primitive/);
  });
});

describe('bind exactness: every statement references exactly what it binds', () => {
  const USERS = [
    { name: 'wide', user: { id: 10 }, userId: 10, caps: ['JOBS_EDIT_ANY', 'LEADS_EDIT'] },
    { name: 'narrow', user: { id: 20 }, userId: 20, caps: ['JOBS_EDIT_OWN'] },
    { name: 'view only', user: { id: 30 }, userId: 30, caps: ['JOBS_VIEW_ALL'] },
    { name: 'no id', user: {}, userId: null, caps: ['JOBS_EDIT_ANY', 'LEADS_EDIT'] },
  ];

  test('for every view x sort x caller, with and without explicit primitives', async () => {
    let statements = 0;
    for (const u of USERS) {
      for (const view of Object.keys(board.VIEWS)) {
        for (const sort of Object.keys(board.SORTS)) {
          for (const extra of [{}, { due: 'week', link: 'none', approver: 'me', flags: 'open', suggestions: 'pending', status_group: 'crew', priority: 'high', parent: 'job' }]) {
            const query = board.parseBoardQuery(Object.assign({ board: '1', view, sort, include_counts: '1' }, extra));
            expect(query.error).toBeNull();
            const db = fakeDb();
            await board.runBoard(db, {
              orgId: 1, user: u.user, userId: u.userId, query, hasCapability: capsOf(u.caps),
              where: ROUTE_WHERE, baseParams: [1, 20], params: [1, 20, u.userId], taskCountCols: TASK_COLS,
              now: new Date('2026-09-20T01:30:00Z'),
            });
            expect(db.calls).toHaveLength(3);
            for (const c of db.calls) {
              expect([u.name, view, sort, referenced(c.sql)]).toEqual([u.name, view, sort, oneToN(c.params.length)]);
              statements += 1;
            }
          }
        }
      }
    }
    expect(statements).toBe(USERS.length * 11 * 5 * 2 * 3);
  });

  test('the counts statement never binds the caller id the task counts use', async () => {
    const db = fakeDb();
    await board.runBoard(db, {
      orgId: 1, user: { id: 20 }, userId: 20, query: board.parseBoardQuery({ board: '1', include_counts: '1' }), hasCapability: capsOf(['JOBS_EDIT_OWN']),
      where: ROUTE_WHERE, baseParams: [1, 20], params: [1, 20, 20], taskCountCols: TASK_COLS,
    });
    const counts = db.calls.find((c) => /FILTER/.test(c.sql));
    expect(counts.sql).not.toContain('tasks k');
    expect(counts.params.slice(0, 2)).toEqual([1, 20]);
    expect(counts.sql).toContain('FROM service_tickets t');
    for (const w of ROUTE_WHERE) expect(counts.sql).toContain(w);
  });

  test('no counts statement unless asked', async () => {
    const db = fakeDb();
    await board.runBoard(db, {
      orgId: 1, user: { id: 10 }, userId: 10, query: board.parseBoardQuery({ board: '1' }), hasCapability: capsOf(['JOBS_EDIT_ANY']),
      where: ['t.organization_id = $1'], baseParams: [1], params: [1, 10], taskCountCols: '0 AS task_total, 0 AS task_done',
    });
    expect(db.calls.filter((c) => /FILTER/.test(c.sql))).toEqual([]);
  });
});

// Every FROM/JOIN of a child table in the statements `mod` runs, one capture
// per child. A capture ends at the subquery's closing parenthesis, or at the
// next FROM, JOIN or SELECT, or at the statement's own WHERE on t, so three
// LEFT JOINs in a row are three captures and one join's predicate can never
// vouch for its neighbour's. Each statement is scanned on its own.
async function childReads(mod) {
  const db = fakeDb();
  await mod.runBoard(db, {
    orgId: 1, user: { id: 20 }, userId: 20, hasCapability: capsOf(['JOBS_EDIT_OWN', 'LEADS_EDIT']),
    query: mod.parseBoardQuery({ board: '1', include_counts: '1', approver: 'me', link: 'none', flags: 'open', suggestions: 'pending' }),
    where: ['t.organization_id = $1'], baseParams: [1], params: [1, 20], taskCountCols: '0 AS task_total, 0 AS task_done',
  });
  const CHILD = /\b(?:FROM|JOIN)\s+(?!service_tickets t\b)(?!organizations o\b)[a-z_]+\s+[a-z_0-9]+\b(?:(?!\bFROM\b|\bJOIN\b|\bSELECT\b|\bWHERE\s+t\.)[^)])*/gi;
  const children = [];
  for (const sql of db.calls.map((c) => c.sql).concat([mod.SEARCH_SQL])) children.push(...(sql.match(CHILD) || []));
  const name = (c) => c.split(/\s+/).slice(1, 3).join(' ');
  const unpinned = children.filter((c) => !/organization_id = (t|o)\.organization_id|u\.organization_id = o\.id/.test(c));
  return { children, names: children.map(name), unpinned: [...new Set(unpinned.map(name))].sort() };
}

describe('tenancy in the text', () => {
  test('every child subquery and join is pinned to the ticket org, except the list\'s own narrowing arms', async () => {
    const { children, names, unpinned } = await childReads(board);
    expect(children.length).toBeGreaterThan(15);
    // The three row labels are three separate captures, each ending before the next join.
    for (const join of ['jobs jl', 'leads ll', 'users ua']) {
      const hits = children.filter((c) => c.split(/\s+/).slice(1, 3).join(' ') === join);
      expect([join, hits.length]).toEqual([join, 1]);
      expect(hits[0]).not.toMatch(/\bJOIN\b[\s\S]*\bJOIN\b/);
    }
    expect(names).toEqual(expect.arrayContaining(['service_ticket_revisions r', 'service_ticket_shares s3', 'service_ticket_events e', 'service_ticket_flags f', 'jobs jq', 'leads lq', 'users uq', 'users u']));
    // jw and aw: the write tier's owner and edit-grant arms, which mirror the
    // list route's owner and grant arms (see the module header).
    expect(unpinned).toEqual(['job_access aw', 'jobs jw']);
  });

  test('the module never spells the legacy tolerance arm', () => {
    expect(SOURCE.indexOf('organization_id IS ' + 'NULL')).toBe(-1);
  });
});

describe('rows leave through a whitelist', () => {
  test('a priced or office-only column never reaches the body; counts are numbers, flags are booleans', async () => {
    const db = fakeDb({
      rows: [
        { id: 'st_1', title: 'Gate', status: 'in_progress', scope_approved: '$48,000', internal_notes: 'secret', crew_takeoff: '{}', task_total: '3', task_done: '1', links_total: '2', links_live: null, is_overdue: 1, last_crew_at: '2026-09-05 08:00:00', office_seen_at: null },
        { id: 'st_2', title: 'Fence', status: 'open', is_overdue: 0, last_crew_at: '2026-09-05 08:00:00', office_seen_at: '2026-09-06 08:00:00' },
        { id: 'st_3', title: 'Extra', status: 'open' },
      ],
      counts: { c_matching: '2', c_open: 5, c_overdue: '1' },
    });
    const out = await board.runBoard(db, {
      orgId: 1, user: { id: 10 }, userId: 10, hasCapability: capsOf(['JOBS_EDIT_ANY']),
      query: board.parseBoardQuery({ board: '1', include_counts: '1', limit: '2', offset: '4' }),
      where: ['t.organization_id = $1'], baseParams: [1], params: [1, 10], taskCountCols: '0 AS task_total, 0 AS task_done',
      now: new Date('2026-09-20T01:30:00Z'),
    });
    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body)).not.toMatch(/48,000|secret|crew_takeoff|scope/);
    expect(out.body.tickets.map((t) => t.id)).toEqual(['st_1', 'st_2']);
    expect(Object.keys(out.body.tickets[0])).toEqual(board.BOARD_ROW_KEYS.slice());
    const [a, b] = out.body.tickets;
    expect([a.task_total, a.task_done, a.links_total, a.links_live, a.is_overdue, a.new_from_crew]).toEqual([3, 1, 2, 0, true, true]);
    expect([b.is_overdue, b.new_from_crew]).toEqual([false, false]);
    expect([out.body.has_more, out.body.next_offset, out.body.today, out.body.total]).toEqual([true, 6, '2026-09-19', 2]);
    expect(Object.keys(out.body.counts)).toEqual(board.COUNTED_VIEWS.slice());
    expect([out.body.counts.open, out.body.counts.overdue, out.body.counts.flagged]).toEqual([5, 1, 0]);
    expect(Object.keys(out.body.status_counts)).toEqual(board.COUNTED_STATUS_GROUPS.slice());
    expect(Object.values(out.body.status_counts).every((n) => n === 0)).toBe(true);
    // The page asked for limit+1 to learn has_more.
    expect(db.calls.find((c) => /LIMIT/.test(c.sql)).sql).toMatch(/LIMIT 3 OFFSET 4/);
  });

  test('a database error is thrown to the route, not swallowed into an empty page', async () => {
    const db = { query: async () => { throw new Error('boom'); } };
    await expect(board.runBoard(db, {
      orgId: 1, user: { id: 10 }, userId: 10, query: board.parseBoardQuery({ board: '1' }),
      where: ['t.organization_id = $1'], baseParams: [1], params: [1, 10], taskCountCols: '0 AS task_total, 0 AS task_done',
    })).rejects.toThrow('boom');
  });
});

// ── mutants ───────────────────────────────────────────────────────────────
describe('mutants', () => {
  const made = [];
  afterAll(() => { for (const p of made) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } } });

  function mutant(pairs) {
    let src = SOURCE.replace(/\r\n/g, '\n');
    for (const [find, replace] of pairs) {
      if (src.split(find).length !== 2) throw new Error('anchor not found');
      src = src.split(find).join(replace);
    }
    const dir = path.dirname(BOARD);
    src = src.replace(/require\('(\.\.?\/[^']+)'\)/g, (_m, spec) => 'require(' + JSON.stringify(require.resolve(path.resolve(dir, spec)).split(path.sep).join('/')) + ')');
    const p = path.join(os.tmpdir(), '_p86_board_pure_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
    fs.writeFileSync(p, src, 'utf8');
    made.push(p);
    return require(p);
  }

  test('the harness throws on an absent anchor', () => {
    expect(() => mutant([['nowhere in the board module', 'x']])).toThrow('anchor not found');
  });

  test('a counts statement built on the rows params binds the caller id it never references', async () => {
    const mod = mutant([['countsStatement({ query, where: o.where, baseParams: o.baseParams, env })',
      'countsStatement({ query, where: o.where, baseParams: o.params, env })']]);
    const db = fakeDb();
    await mod.runBoard(db, {
      orgId: 1, user: { id: 20 }, userId: 20, hasCapability: capsOf(['JOBS_EDIT_OWN']),
      query: mod.parseBoardQuery({ board: '1', include_counts: '1' }),
      where: ROUTE_WHERE, baseParams: [1, 20], params: [1, 20, 20], taskCountCols: TASK_COLS,
    });
    const counts = db.calls.find((c) => /FILTER/.test(c.sql));
    expect(referenced(counts.sql)).not.toEqual(oneToN(counts.params.length));
  });

  test('an unclamped limit lets a caller ask for a million rows', () => {
    const mod = mutant([['  out.limit = clampInt(q.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);', '  out.limit = Number(q.limit) || DEFAULT_LIMIT;']]);
    expect(mod.parseBoardQuery({ board: '1', limit: '1000000' }).limit).toBe(1000000);
    expect(board.parseBoardQuery({ board: '1', limit: '1000000' }).limit).toBe(100);
  });

  test('without the whitelist a priced column reaches the page', async () => {
    const mod = mutant([['  const shaped = {};\n  BOARD_ROW_KEYS.forEach(function (k) { shaped[k] = out[k]; });\n  return shaped;', '  return Object.assign({}, r, out);']]);
    const db = fakeDb({ rows: [{ id: 'st_1', scope_approved: '$48,000' }] });
    const res = await mod.runBoard(db, {
      orgId: 1, user: { id: 10 }, userId: 10, query: mod.parseBoardQuery({ board: '1' }), hasCapability: capsOf(['JOBS_EDIT_ANY']),
      where: ['t.organization_id = $1'], baseParams: [1], params: [1, 10], taskCountCols: '0 AS task_total, 0 AS task_done',
    });
    expect(JSON.stringify(res.body)).toContain('48,000');
  });

  // The tenancy scan, run over a module with one row-label join unpinned. The
  // old capture ran from the first LEFT JOIN to the WHERE and let the leads
  // join's predicate vouch for the jobs join; each of these must now be seen.
  // (The behaviour of the same three is pinned in the routes file, mutants g, j, k.)
  for (const [join, alias] of [['jobs jl', 'jl'], ['leads ll', 'll'], ['users ua', 'ua']]) {
    test('drop the org predicate from the ' + join + ' join and the tenancy scan names it', async () => {
      const mod = mutant([[' AND ' + alias + '.organization_id = t.organization_id', '']]);
      expect((await childReads(mod)).unpinned).toEqual(['job_access aw', join, 'jobs jw'].sort());
      expect((await childReads(board)).unpinned).toEqual(['job_access aw', 'jobs jw']);
    });
  }

  // What each FILTER of the counts statement combines, by its output column.
  async function countFilters(m, query) {
    const db = fakeDb();
    await m.runBoard(db, {
      orgId: 1, user: { id: 10 }, userId: 10, hasCapability: capsOf(['JOBS_EDIT_ANY']),
      query: m.parseBoardQuery(Object.assign({ board: '1', include_counts: '1' }, query)),
      where: ['t.organization_id = $1'], baseParams: [1], params: [1, 10], taskCountCols: '0 AS task_total, 0 AS task_done',
    });
    const sql = db.calls.find((c) => /FILTER/.test(c.sql)).sql;
    const out = {};
    for (const m2 of sql.matchAll(/COUNT\(\*\) FILTER \(WHERE ([^)]*)\)\)::int AS ([a-z_]+)/g)) out[m2[2]] = m2[1];
    const inner = {};
    for (const m2 of sql.matchAll(/,?\s*(.+) AS ((?:p|v|g)_[a-z_]+)(?=,\n|\n)/g)) inner[m2[2]] = m2[1];
    return { out, inner };
  }

  test('the counts: each kind leaves out only its own choice', async () => {
    const { out, inner } = await countFilters(board, { view: 'overdue', status_group: 'closed', flags: 'open', priority: 'high' });
    expect(out.c_matching).toBe('x.p_view AND x.p_status AND x.p_other');
    for (const v of board.COUNTED_VIEWS) expect([v, out['c_' + v]]).toEqual([v, 'x.v_' + v + ' AND x.p_status AND x.p_other']);
    for (const g of board.COUNTED_STATUS_GROUPS) expect([g, out['s_' + g]]).toEqual([g, 'x.p_view AND x.g_' + g + ' AND x.p_other']);
    expect(inner.p_view).toContain('t.due_date < ');
    expect(inner.p_status).toBe("t.status IN ('closed', 'cancelled')");
    expect(inner.p_other).toContain('service_ticket_flags fo');
    expect(inner.p_other).toContain("COALESCE(t.priority, 'normal') = 'high'");
    // The selected status (closed) is not among the rest.
    expect(inner.p_other).not.toContain("'closed', 'cancelled'");
  });

  test('counts that ignore the explicit filters disagree with the rows those filters list', async () => {
    const mod = mutant([["'(COUNT(*) FILTER (WHERE x.v_' + key + ' AND x.p_status AND x.p_other))::int AS c_' + key", "'(COUNT(*) FILTER (WHERE x.v_' + key + '))::int AS c_' + key"]]);
    const shipped = (await countFilters(board, { view: 'open', flags: 'open' })).out;
    const mutated = (await countFilters(mod, { view: 'open', flags: 'open' })).out;
    // Shipped: every counted view carries the explicit filters; the mutant's carry none.
    expect(board.COUNTED_VIEWS.filter((v) => /x\.p_other/.test(shipped['c_' + v]))).toEqual(board.COUNTED_VIEWS.slice());
    expect(board.COUNTED_VIEWS.filter((v) => /x\.p_other/.test(mutated['c_' + v]))).toEqual([]);
  });

  test('status counts that keep the selected status count only that status', async () => {
    const mod = mutant([["predicateFor([['status_group', group]], env, b) + ' AS g_' + group", "predicateFor(statusPairs.length ? statusPairs : [['status_group', group]], env, b) + ' AS g_' + group"]]);
    const shipped = (await countFilters(board, { view: 'all', status_group: 'closed' })).inner;
    const mutated = (await countFilters(mod, { view: 'all', status_group: 'closed' })).inner;
    expect(shipped.g_active).toBe("t.status IN ('open', 'scheduled', 'in_progress', 'work_complete')");
    expect(mutated.g_active).toBe("t.status IN ('closed', 'cancelled')");
  });
});
