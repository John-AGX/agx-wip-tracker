// A COUNT COSTS A COUNT, AND A CAPPED LIST SAYS WHAT IT DROPPED.
//
// ── WHAT WAS WRONG, MEASURED ──────────────────────────────────────────────
// The question "how many active jobs are there right now?" cost three tool
// calls and ~27,000 characters of job rows to answer with the number 46.
// context_load_events recorded it: search_entities, 3 calls, average 9,158
// chars, max 18,225. Two defects compose to produce that:
//
//   1. status:'active' COULD NOT MATCH. read_jobs and read_wip_summary each
//      compared the filter against a job's status with one exact string
//      compare, and "active" is not a status — it is four of them (New,
//      Backlog, In Progress, On Hold). So the cheap filter answered "No jobs
//      with status active" about 46 live jobs, and the model fell back to
//      enumerating the portfolio.
//   2. THERE WAS NO WAY TO COUNT. Every read in this surface is a list; the
//      only count 86 could obtain was a side effect of printing rows.
//
// And a third, found in the same place: read_jobs sliced to `limit` and said
// nothing, so 20 rows out of 46 read as all of them.
//
// ── HOW THIS FILE PROVES IT ───────────────────────────────────────────────
// Through the REAL dispatcher the model's tool calls land on
// (make86OnCustomToolUse), against node:sqlite via the pg shim, over the seven
// job statuses test/job-status-vocabulary.test.js pins. Then each guard is
// removed from a copy of the shipped file and the same drive shows the old
// behaviour returning.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const AI_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js');
const SOURCE = fs.readFileSync(AI_ROUTES, 'utf8');

const TABLES = ['users', 'organizations', 'roles', 'leads', 'clients', 'jobs', 'tasks',
  'context_load_events', 'job_change_orders', 'invoices', 'qb_cost_lines',
  'job_vendor_bills', 'job_purchase_orders', 'subs', 'sub_certificates'];

// THE PINNED VOCABULARY — test/job-status-vocabulary.test.js asserts these
// seven and their states. Four are `active`; the other three are their own.
const ACTIVE = ['New', 'Backlog', 'In Progress', 'On Hold'];
const OTHER = ['Warranty', 'Completed', 'Archived'];

let eng, auth, shipped;
const loadedPaths = [];

function absolutizeRequires(src) {
  const dir = path.dirname(AI_ROUTES);
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (m, _q, spec) => {
    try {
      const resolved = spec.charAt(0) === '.'
        ? require.resolve(path.resolve(dir, spec))
        : require.resolve(spec, { paths: [dir] });
      return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
    } catch (e) { return m; }
  });
}

// Load ai-routes with optional mutations, exposing the live tool dispatcher.
function load(pairs) {
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs || []) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const at = out.indexOf(f);
    if (at === -1) throw new Error('MUTATION ANCHOR NOT FOUND: ' + JSON.stringify(f.slice(0, 120)));
    if (out.indexOf(f, at + 1) !== -1) throw new Error('MUTATION ANCHOR NOT UNIQUE');
    out = out.slice(0, at) + r + out.slice(at + f.length);
  }
  out += eol + 'module.exports.__make86OnCustomToolUse = make86OnCustomToolUse;' + eol;
  const p = path.join(os.tmpdir(), '_p86_jobcount_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out), 'utf8');
  loadedPaths.push(p);
  jest.useFakeTimers();
  let m;
  try { m = require(p); } finally { jest.useRealTimers(); }
  return m;
}

// 46 jobs, so the measured incident's own number is the fixture: 24 active
// across the four active statuses, 22 across the other three.
const JOBS = [];
(function buildJobs() {
  let n = 0;
  const add = (status, count) => {
    for (let i = 0; i < count; i++) {
      n += 1;
      JOBS.push({ id: 'j' + n, jobNumber: 'RV' + (2000 + n), title: 'Job ' + n, status });
    }
  };
  add('New', 4); add('Backlog', 7); add('In Progress', 11); add('On Hold', 2);  // 24 active
  add('Warranty', 3); add('Completed', 14); add('Archived', 5);                 // 22 other
})();
const ACTIVE_COUNT = 24;
const TOTAL_COUNT = 46;

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const ALL = auth.CAPABILITY_KEYS.map((k) => k.key);
  eng.db.exec(`
    DELETE FROM users; DELETE FROM organizations; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM clients; DELETE FROM subs; DELETE FROM sub_certificates;
    INSERT INTO organizations (id, name) VALUES (1, 'AGX');
    INSERT INTO roles (name, capabilities) VALUES ('everything', ${caps(ALL)});
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (50, 'Olive Owner', 'olive@agx.test', 'everything', 1, 1);
    INSERT INTO clients (id, name, organization_id) VALUES ('c1', 'Waterside HOA', 1);
  `);
  const ins = eng.db.prepare('INSERT INTO jobs (id, data, organization_id, updated_at) VALUES (?, ?, 1, ?)');
  JOBS.forEach((j, i) => ins.run(j.id, JSON.stringify({
    jobNumber: j.jobNumber, title: j.title, status: j.status, clientId: 'c1', pm: 'John Thilking',
    address: '100 Waterside Dr',
  }), '2026-09-' + String((i % 28) + 1).padStart(2, '0') + ' 10:00:00'));
  // Three subs, so the id and the cap notice have something to print.
  const si = eng.db.prepare(
    'INSERT INTO subs (id, name, trade, status, organization_id) VALUES (?, ?, ?, ?, 1)');
  si.run('sub_aaa', 'ABC Drywall', 'Drywall', 'active');
  si.run('sub_bbb', 'Best Painting', 'Painting', 'active');
  si.run('sub_ccc', 'Coastal Gutters', 'Gutters', 'active');
}

beforeAll(async () => {
  // 'certs' is read_subs' json_agg alias — the shim hands it back as a string
  // unless it is named here, and the executor calls .map on it.
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['capabilities', 'data', 'item_meta', 'certs'] });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  jest.useFakeTimers();
  auth = require('../server/auth');
  jest.useRealTimers();
  auth.setRolePool(eng.pool);
  shipped = load([]);
  seed();
  await auth.refreshRoleCache();
});

const flush = () => new Promise((r) => setTimeout(r, 25));
afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
  for (const p of loadedPaths) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } }
});

const USER = { id: 50, role: 'everything', organization_id: 1 };

// The live door, exactly as a model's tool call reaches it.
async function call(mod, name, input) {
  const door = (mod || shipped).__make86OnCustomToolUse(USER.id, null, '', USER, 1);
  const out = await door({ id: 'tu_1', name, input });
  return String((out && (out.summary || out.error)) || '');
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. A COUNT COSTS A COUNT
 * ══════════════════════════════════════════════════════════════════════════*/
describe('search_entities mode:count', () => {
  test('one line answers the measured question, with the states broken out', async () => {
    const out = await call(null, 'search_entities', { entity_type: 'job', mode: 'count' });
    expect(out).toContain(TOTAL_COUNT + ' jobs');
    expect(out).toContain('active ' + ACTIVE_COUNT);
    // The follow-up question is answered in the same line, so it costs no
    // second call: "how many are on hold?"
    expect(out).toMatch(/On Hold 2/);
    expect(out).toContain('completed 14');
    // And it is ONE line — the whole point.
    expect(out.split('\n')).toHaveLength(1);
  });

  test('it is radically smaller than the rows it replaces — the measured defect', async () => {
    const counted = await call(null, 'search_entities', { entity_type: 'job', mode: 'count' });
    const listed = await call(null, 'search_entities', { entity_type: 'job', limit: 100 });
    expect(counted.length).toBeLessThan(260);
    expect(listed.length).toBeGreaterThan(4000);
    // The recorded incident was ~27,000 chars across three calls for this one
    // number. One call, two orders of magnitude smaller.
    expect(listed.length / counted.length).toBeGreaterThan(20);
  });

  test('a status filter narrows the count, and says what it counted', async () => {
    const out = await call(null, 'search_entities', { entity_type: 'job', mode: 'count', status: 'active' });
    expect(out).toContain(ACTIVE_COUNT + ' jobs');
    expect(out).toContain('matching status "active"');
    expect(out).not.toContain('completed');
  });

  test('the count and the list cannot disagree — both come off the same filtered set', async () => {
    const out = await call(null, 'search_entities', { entity_type: 'job', mode: 'count', status: 'On Hold' });
    const rows = await call(null, 'search_entities', { entity_type: 'job', status: 'On Hold', limit: 100 });
    expect(out).toContain('2 jobs');
    expect((rows.match(/On Hold/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('a status nothing uses counts zero and says so, rather than looking like an empty company', async () => {
    const out = await call(null, 'search_entities', { entity_type: 'job', mode: 'count', status: 'Zorblax' });
    expect(out).toMatch(/0 jobs/);
    expect(out).toContain('Zorblax');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. 'active' MEANS THE FOUR STATUSES IT MEANS
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a job status filter takes a state word', () => {
  test('status:active returns the active jobs instead of nothing', async () => {
    const out = await call(null, 'search_entities', { entity_type: 'job', filter: 'Job', status: 'active', limit: 100 });
    expect(out).not.toMatch(/No jobs/);
    for (const st of ACTIVE) expect(out).toContain(st);
    for (const st of OTHER) expect(out).not.toContain(st);
  });

  test('every state word works, and together they partition the portfolio', async () => {
    let sum = 0;
    for (const state of ['active', 'warranty', 'completed', 'archived']) {
      const out = await call(null, 'search_entities', { entity_type: 'job', mode: 'count', status: state });
      const n = Number((out.match(/^(\d+) jobs?/) || [])[1]);
      expect(Number.isFinite(n)).toBe(true);
      sum += n;
    }
    expect(sum).toBe(TOTAL_COUNT);
  });

  test('an EXACT status still behaves exactly as it did — nothing that worked is changed', async () => {
    const out = await call(null, 'search_entities', { entity_type: 'job', filter: 'Job', status: 'In Progress', limit: 100 });
    expect(out).toContain('In Progress');
    expect(out).not.toContain('Backlog');
    const lower = await call(null, 'search_entities', { entity_type: 'job', filter: 'Job', status: 'in progress', limit: 100 });
    expect(lower).toContain('In Progress');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. A CAPPED LIST SAYS WHAT IT DROPPED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('honest truncation', () => {
  test('read_jobs states the real total, the number shown, and how to get the rest', async () => {
    const out = await call(null, 'search_entities', { entity_type: 'job', filter: 'Job', limit: 20 });
    expect(out).toMatch(/^46 jobs match; showing 20, most recently updated first\./m);
    expect(out).toMatch(/higher limit \(max 100\)/);
    // The rows are still there, under the notice.
    expect((out.match(/\[id j/g) || []).length).toBe(20);
  });

  test('an uncapped list says the total without inventing a cap notice', async () => {
    // The free-text filter searches jobNumber/title/client/address — NOT
    // status — so the status filter is what narrows this to two.
    const out = await call(null, 'search_entities', { entity_type: 'job', filter: 'Job', status: 'On Hold', limit: 100 });
    expect(out).toMatch(/^2 jobs match\./m);
    expect(out).not.toMatch(/showing/);
  });

  test('the WIP roll-up names each job with an id, so a ranking can be drilled into', async () => {
    const out = await call(null, 'search_entities', { entity_type: 'wip', limit: 5 });
    expect(out).toContain('WIP ROLL-UP');
    expect(out).toMatch(/\[id j\d+\]/);
  });

  test('read_subs prints the id the Scribe needs for a purchase order', async () => {
    const out = await call(null, 'search_entities', { entity_type: 'sub', limit: 10 });
    expect(out).toContain('[id=sub_aaa]');
    expect(out).toContain('ABC Drywall');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. MUTANTS — each guard removed, the old behaviour returning
 * ══════════════════════════════════════════════════════════════════════════*/
describe('MUTANTS', () => {
  test('the exact-match status filter back on read_jobs: "active" answers nothing about 24 active jobs', async () => {
    const mut = load([[
      "      if (status) rows = rows.filter(j => jobStatusFilter.matchesJobStatus(j.status, status));",
      "      if (status) rows = rows.filter(j => String(j.status || '').toLowerCase() === status.toLowerCase());",
    ]]);
    const out = await call(mut, 'search_entities', { entity_type: 'job', filter: 'Job', status: 'active', limit: 100 });
    expect(out).toMatch(/No jobs match the filters/);
  });

  test('the exact-match status filter back on the roll-up: the same silence, from the other door', async () => {
    const mut = load([[
      '        ? allJobs.filter(j => jobStatusFilter.matchesJobStatus(j.status, statusFilter))',
      "        ? allJobs.filter(j => String(j.status || '').toLowerCase() === statusFilter.toLowerCase())",
    ]]);
    const out = await call(mut, 'search_entities', { entity_type: 'wip', status: 'active' });
    expect(out).toMatch(/No jobs with status "active"/);
  });

  test('without the count mode, the same question costs the whole portfolio', async () => {
    const mut = load([[
      "      if (String(input.mode || '').toLowerCase() === 'count') {",
      '      if (false) {',
    ]]);
    const out = await call(mut, 'search_entities', { entity_type: 'job', mode: 'count' });
    expect(out).toContain('WIP ROLL-UP');
    expect(out.length).toBeGreaterThan(1000);
  });

  test('without the total, a capped list reads as the whole list', async () => {
    const mut = load([[
      '      const matchTotal = rows.length;',
      '      const matchTotal = -1; // MUTANT',
    ]]);
    const out = await call(mut, 'search_entities', { entity_type: 'job', filter: 'Job', limit: 20 });
    expect(out).not.toMatch(/46 jobs match/);
    expect((out.match(/\[id j/g) || []).length).toBe(20);
  });

  test('without the id, read_subs lists subs nothing can address', async () => {
    const mut = load([[
      "        out.push('- ' + s.name + ' [id=' + s.id + ']' +",
      "        out.push('- ' + s.name +",
    ]]);
    const out = await call(mut, 'search_entities', { entity_type: 'sub', limit: 10 });
    expect(out).toContain('ABC Drywall');
    expect(out).not.toContain('sub_aaa');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. THE SHARED WRITER — one mapping, not two
 * ══════════════════════════════════════════════════════════════════════════*/
describe('services/job-status-filter', () => {
  const f = require('../server/services/job-status-filter');
  const match = require('../server/services/clickr/bt-match');

  test('it reuses the PINNED vocabulary rather than keeping a second copy', () => {
    // Every status test/job-status-vocabulary.test.js pins must be matched by
    // its own state word. A second mapping in job-status-filter.js is exactly
    // how the two would drift, so this asserts the tie, not the table.
    for (const st of ACTIVE.concat(OTHER)) {
      const state = match.p86JobState(st);
      expect(state).not.toBeNull();
      expect(f.matchesJobStatus(st, state)).toBe(true);
      expect(f.JOB_STATES).toContain(state);
    }
  });

  test('a state word matches its whole state and nothing else', () => {
    expect(ACTIVE.every((s) => f.matchesJobStatus(s, 'active'))).toBe(true);
    expect(OTHER.some((s) => f.matchesJobStatus(s, 'active'))).toBe(false);
    expect(f.matchesJobStatus('Completed', 'completed')).toBe(true);
    expect(f.matchesJobStatus('Completed', 'archived')).toBe(false);
  });

  test('an exact status still wins, case- and space-insensitively', () => {
    expect(f.matchesJobStatus('On Hold', 'on hold')).toBe(true);
    expect(f.matchesJobStatus('On Hold', 'ON  HOLD')).toBe(true);
    expect(f.matchesJobStatus('On Hold', 'New')).toBe(false);
  });

  test('no filter matches everything, including a job with no status', () => {
    expect(f.matchesJobStatus('Archived', '')).toBe(true);
    expect(f.matchesJobStatus(null, null)).toBe(true);
  });

  test('a status the vocabulary does not know is counted BY NAME, never dropped', () => {
    const h = f.jobStateHistogram(['In Progress', 'Zorblax', null]);
    expect(h.total).toBe(3);
    expect(h.states.active.count).toBe(1);
    expect(h.unknown.Zorblax).toBe(1);
    expect(h.unknown['(no status)']).toBe(1);
    const line = f.formatJobCount(h);
    expect(line).toContain('3 jobs');
    expect(line).toContain('Zorblax');
    // A job missing from a total is worse than a job in an ugly bucket: the
    // parts must add up to the whole.
    const counted = Object.values(h.states).reduce((a, s) => a + s.count, 0)
      + Object.values(h.unknown).reduce((a, n) => a + n, 0);
    expect(counted).toBe(h.total);
  });

  test('the count is ONE line, and an empty portfolio reads cleanly', () => {
    expect(f.formatJobCount(f.jobStateHistogram([]))).toBe('0 jobs.');
    expect(f.formatJobCount(f.jobStateHistogram(['New'])).split('\n')).toHaveLength(1);
    expect(f.formatJobCount(f.jobStateHistogram(['New']))).toContain('1 job —');
  });
});
