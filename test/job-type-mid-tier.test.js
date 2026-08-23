/**
 * @jest-environment jsdom
 */
// test/job-type-mid-tier.test.js — M, Mid-Tier Service.
//
// jsdom because two of the six doors are browser scripts (js/schedule.js's
// saved filter, js/job-costs-import.js's prefix learning). The server routes
// under test don't care which environment they run in.
//
// A job number is IDENTITY here. It is minted by claiming a per-org counter
// through POST /api/org/next-job-number, which serializes with FOR UPDATE and
// floors above the highest number already in use. Adding a type is therefore
// two separate claims that both have to hold:
//
//   1. M mints M#### from the M counter, atomically, and does not disturb the
//      S or RV counters (the two AGX actually uses — RV2000-2043, S2095-S2287).
//   2. NOTHING RENUMBERS. Introducing a type must not read, rewrite or
//      reclassify a single existing job.
//
// Plus the three doors that would have made M exist on paper and nowhere else:
// the convert path's prefix whitelist (which rejected everything but S and RV,
// so Work Order has been unconvertible since the registry shipped), the
// schedule board's saved filter (a key added after a user's last save reads
// undefined → falsy → those jobs vanish with no pill to turn back on), and the
// QB import's prefix learning (a type with no jobs yet is invisible to a set
// learned from job numbers).
//
// `../server/db` and `../server/auth` are mocked: auth.js hard-fails without a
// JWT_SECRET and none of this should depend on the environment having one.

const jobTypes = require('../server/services/job-types');

// ── Fake Postgres ─────────────────────────────────────────────────────
// Holds one organizations row (branding JSONB) and a jobs table, and answers
// only the statements these two routes emit. Records every statement so a test
// can assert what was NOT run — which is how "nothing renumbers" is measured
// rather than asserted.
function makeFakeDb(initialBranding, jobRows) {
  const state = {
    branding: initialBranding ? JSON.parse(JSON.stringify(initialBranding)) : {},
    jobs: (jobRows || []).slice(),
    log: [],
    committed: false,
    rolledBack: false,
  };
  let staged = null;

  const client = {
    released: false,
    async query(sql, params) {
      const text = String(sql);
      state.log.push({ sql: text.replace(/\s+/g, ' ').trim(), params: params || [] });

      if (/^BEGIN/i.test(text.trim())) { staged = JSON.parse(JSON.stringify(state.branding)); return { rows: [] }; }
      if (/^COMMIT/i.test(text.trim())) { state.committed = true; staged = null; return { rows: [] }; }
      if (/^ROLLBACK/i.test(text.trim())) {
        if (staged) state.branding = staged;
        state.rolledBack = true; staged = null; return { rows: [] };
      }

      if (/SELECT branding FROM organizations/i.test(text)) {
        return { rows: [{ branding: JSON.parse(JSON.stringify(state.branding)) }] };
      }
      if (/SELECT id, branding FROM organizations/i.test(text)) {
        return { rows: [{ id: 1, branding: JSON.parse(JSON.stringify(state.branding)) }] };
      }
      // The max-existing floor: MAX(substring(jobNumber from '^P([0-9]+)$')).
      if (/MAX\(\(substring/i.test(text)) {
        const re = new RegExp(String(params[1]));
        let max = null;
        state.jobs.forEach((j) => {
          const m = String(j.jobNumber || '').match(re);
          if (m) { const n = parseInt(m[1], 10); if (isFinite(n) && (max === null || n > max)) max = n; }
        });
        return { rows: [{ m: max }] };
      }
      if (/UPDATE organizations SET branding = \$2/i.test(text)) {
        state.branding = JSON.parse(params[1]);
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE organizations SET branding = COALESCE/i.test(text)) {
        Object.assign(state.branding, JSON.parse(params[1]));
        return { rows: [], rowCount: 1 };
      }
      throw new Error('fake pg: unhandled statement -> ' + text.replace(/\s+/g, ' ').trim().slice(0, 120));
    },
    release() { client.released = true; },
  };
  state.client = client;
  return state;
}

let fake;

jest.mock('../server/db', () => ({
  pool: {
    connect: async () => global.__jtFake.client,
    query: async (sql, params) => global.__jtFake.client.query(sql, params),
  },
}));

jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireOrg: (req, res, next) => next(),
  requireOrgId: (req, res, next) => { req.orgId = 1; next(); },
  requireCapability: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
  resolveOrgId: (req, res, next) => next(),
  isAdminish: () => true,
}));

const orgRouter = require('../server/routes/org-manifest-routes');

function handlerFor(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(method.toUpperCase() + ' ' + path + ' not found on the router');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  res.end = () => res;
  return res;
}

async function claim(body) {
  const res = fakeRes();
  await handlerFor(orgRouter, 'post', '/next-job-number')(
    { body, user: { organization_id: 1 }, orgId: 1 }, res
  );
  return res;
}

// AGX's real numbering, as it stands on the day M is introduced: RV and S in
// use, no M anywhere.
const AGX_JOBS = [
  'RV2000', 'RV2001', 'RV2013', 'RV2041', 'RV2043',
  'S2095', 'S2137', 'S2205', 'S2287',
].map((n) => ({ jobNumber: n }));

const AGX_REGISTRY_BEFORE_M = [
  { key: 'service', label: 'Service', prefix: 'S', pad: 4, next: 2288 },
  { key: 'renovation', label: 'Renovation', prefix: 'RV', pad: 4, next: 2044 },
  { key: 'work_order', label: 'Work Order', prefix: 'WO', pad: 4, next: 1 },
];

// ── 1. The type itself ────────────────────────────────────────────────
describe('M is a job type the product ships', () => {
  test('DEFAULT_JOB_TYPES carries Mid-Tier Service on prefix M', () => {
    const m = jobTypes.DEFAULT_JOB_TYPES.find((t) => t.prefix === 'M');
    expect(m).toBeTruthy();
    expect(m.key).toBe('mid_tier_service');
    expect(m.label).toBe('Mid-Tier Service');
    expect(m.pad).toBe(4);
  });

  test('it sits alongside the existing types, none of which change', () => {
    const byPrefix = {};
    jobTypes.DEFAULT_JOB_TYPES.forEach((t) => { byPrefix[t.prefix] = t; });
    expect(byPrefix.S.label).toBe('Service');
    expect(byPrefix.RV.label).toBe('Renovation');
    expect(byPrefix.WO.label).toBe('Work Order');
    // Prefixes stay unique — normJobTypes de-dupes on prefix, so a collision
    // would silently DROP a type rather than error.
    const prefixes = jobTypes.DEFAULT_JOB_TYPES.map((t) => t.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  test('M does not shadow S: a prefix test must not match the wrong type', () => {
    // The live hazard is the other direction — a `startsWith('S')` test placed
    // before a longer prefix. Pin that M and S are disjoint as literal prefixes
    // so no ordering of tests can confuse them.
    expect('M2001'.startsWith('S')).toBe(false);
    expect('S2287'.startsWith('M')).toBe(false);
    expect(jobTypes.allowedPrefixes(null)).toEqual(expect.arrayContaining(['S', 'M', 'RV', 'WO']));
  });
});

// ── 2. The claim ──────────────────────────────────────────────────────
describe('POST /api/org/next-job-number claims M atomically from the M counter', () => {
  beforeEach(() => {
    fake = makeFakeDb(
      { job_types: AGX_REGISTRY_BEFORE_M.concat([{ key: 'mid_tier_service', label: 'Mid-Tier Service', prefix: 'M', pad: 4, next: 1 }]) },
      AGX_JOBS
    );
    global.__jtFake = fake;
  });

  test('by key → M0001, and the counter advances to 2', async () => {
    const res = await claim({ key: 'mid_tier_service' });
    expect(res.statusCode).toBe(200);
    expect(res.body.jobNumber).toBe('M0001');
    expect(res.body.prefix).toBe('M');
    expect(res.body.label).toBe('Mid-Tier Service');
    const m = fake.branding.job_types.find((t) => t.prefix === 'M');
    expect(m.next).toBe(2);
  });

  test('by prefix → the same counter', async () => {
    const res = await claim({ prefix: 'M' });
    expect(res.body.jobNumber).toBe('M0001');
  });

  test('two claims in a row never repeat a number', async () => {
    const a = await claim({ key: 'mid_tier_service' });
    const b = await claim({ key: 'mid_tier_service' });
    expect(a.body.jobNumber).toBe('M0001');
    expect(b.body.jobNumber).toBe('M0002');
  });

  test('the claim is serialized — the org row is locked FOR UPDATE inside a transaction', async () => {
    await claim({ key: 'mid_tier_service' });
    const sqls = fake.log.map((l) => l.sql);
    expect(sqls.some((s) => /^BEGIN/i.test(s))).toBe(true);
    expect(sqls.some((s) => /SELECT branding FROM organizations WHERE id = \$1 FOR UPDATE/i.test(s))).toBe(true);
    expect(fake.committed).toBe(true);
  });

  test('a hand-typed M number already in use raises the floor — no re-issue', async () => {
    fake = makeFakeDb(
      { job_types: AGX_REGISTRY_BEFORE_M.concat([{ key: 'mid_tier_service', label: 'Mid-Tier Service', prefix: 'M', pad: 4, next: 1 }]) },
      AGX_JOBS.concat([{ jobNumber: 'M0042' }])
    );
    global.__jtFake = fake;
    const res = await claim({ key: 'mid_tier_service' });
    expect(res.body.jobNumber).toBe('M0043');
  });

  test('claiming M leaves the S and RV counters exactly where they were', async () => {
    await claim({ key: 'mid_tier_service' });
    const byPrefix = {};
    fake.branding.job_types.forEach((t) => { byPrefix[t.prefix] = t; });
    expect(byPrefix.S.next).toBe(2288);
    expect(byPrefix.RV.next).toBe(2044);
    expect(byPrefix.WO.next).toBe(1);
  });

  test('S and RV still claim the way they always did', async () => {
    const s = await claim({ key: 'service' });
    expect(s.body.jobNumber).toBe('S2288');
    const rv = await claim({ key: 'renovation' });
    expect(rv.body.jobNumber).toBe('RV2044');
  });

  test('an org with no registry yet can still claim M (seeded from the defaults)', async () => {
    fake = makeFakeDb({}, []);
    global.__jtFake = fake;
    const res = await claim({ key: 'mid_tier_service' });
    expect(res.statusCode).toBe(200);
    expect(res.body.jobNumber).toBe('M0001');
    // …and the seeded registry is PERSISTED, so the counter really advanced.
    expect(fake.branding.job_types.map((t) => t.prefix)).toEqual(['S', 'M', 'RV', 'WO']);
  });

  test('an unknown type is still refused', async () => {
    const res = await claim({ key: 'no_such_type' });
    expect(res.statusCode).toBe(400);
  });
});

// ── 3. Nothing renumbers ──────────────────────────────────────────────
describe('introducing M renumbers nothing', () => {
  test('the backfill APPENDS M and writes no jobs row', async () => {
    fake = makeFakeDb({ job_types: AGX_REGISTRY_BEFORE_M }, AGX_JOBS);
    global.__jtFake = fake;
    await jobTypes.backfill({ query: (sql, params) => fake.client.query(sql, params) });

    const prefixes = fake.branding.job_types.map((t) => t.prefix);
    expect(prefixes).toContain('M');
    // Placed next to Service rather than dumped at the end.
    expect(prefixes).toEqual(['S', 'M', 'RV', 'WO']);
    // Every pre-existing entry is byte-identical.
    AGX_REGISTRY_BEFORE_M.forEach((before) => {
      const after = fake.branding.job_types.find((t) => t.prefix === before.prefix);
      expect(after).toEqual(before);
    });
    // The only statements touching `jobs` are READS of the max number.
    const jobWrites = fake.log.filter((l) => /^(UPDATE|INSERT|DELETE)\b/i.test(l.sql) && /\bjobs\b/i.test(l.sql));
    expect(jobWrites).toEqual([]);
  });

  test('it runs once — a second boot does not re-add a type the org deleted', async () => {
    fake = makeFakeDb({ job_types: AGX_REGISTRY_BEFORE_M }, AGX_JOBS);
    global.__jtFake = fake;
    const pool = { query: (sql, params) => fake.client.query(sql, params) };
    await jobTypes.backfill(pool);
    expect(fake.branding.job_types_v).toBe(jobTypes.JOB_TYPES_VERSION);

    // The org decides it doesn't want Mid-Tier Service and removes it.
    fake.branding.job_types = fake.branding.job_types.filter((t) => t.prefix !== 'M');
    await jobTypes.backfill(pool);
    expect(fake.branding.job_types.map((t) => t.prefix)).toEqual(['S', 'RV', 'WO']);
  });

  test('an org that already has an M prefix is left alone', async () => {
    const mine = [{ key: 'maintenance', label: 'Maintenance', prefix: 'M', pad: 3, next: 77 }].concat(AGX_REGISTRY_BEFORE_M);
    fake = makeFakeDb({ job_types: mine }, AGX_JOBS);
    global.__jtFake = fake;
    await jobTypes.backfill({ query: (sql, params) => fake.client.query(sql, params) });
    const m = fake.branding.job_types.find((t) => t.prefix === 'M');
    expect(m.label).toBe('Maintenance');
    expect(m.next).toBe(77);
    expect(fake.branding.job_types.length).toBe(mine.length);
  });

  test('a hand-typed M number seeds the counter above it instead of colliding', async () => {
    fake = makeFakeDb({ job_types: AGX_REGISTRY_BEFORE_M }, AGX_JOBS.concat([{ jobNumber: 'M0009' }]));
    global.__jtFake = fake;
    await jobTypes.backfill({ query: (sql, params) => fake.client.query(sql, params) });
    expect(fake.branding.job_types.find((t) => t.prefix === 'M').next).toBe(10);
  });

  test('addMissingTypes is pure — it never mutates the array it is handed', () => {
    const stored = AGX_REGISTRY_BEFORE_M.map((t) => Object.assign({}, t));
    const before = JSON.stringify(stored);
    jobTypes.addMissingTypes(stored, ['M'], { M: 1 });
    expect(JSON.stringify(stored)).toBe(before);
  });
});

// ── 4. The convert door ───────────────────────────────────────────────
describe('an M job can actually be created from a lead or an estimate', () => {
  test('normalizeJobNumber accepts every prefix the org numbers under', () => {
    const reg = AGX_REGISTRY_BEFORE_M.concat([{ key: 'mid_tier_service', label: 'Mid-Tier Service', prefix: 'M', pad: 4, next: 1 }]);
    expect(jobTypes.normalizeJobNumber('M0001', reg)).toBe('M0001');
    expect(jobTypes.normalizeJobNumber('S2288', reg)).toBe('S2288');
    expect(jobTypes.normalizeJobNumber('RV2044', reg)).toBe('RV2044');
    // WO has been rejected by the convert path since the registry shipped,
    // even though the admin UI seeds it. Fixed by reading the registry.
    expect(jobTypes.normalizeJobNumber('WO0007', reg)).toBe('WO0007');
  });

  test('it stays a whitelist — a typo cannot mint a new prefix', () => {
    const reg = AGX_REGISTRY_BEFORE_M;
    expect(jobTypes.normalizeJobNumber('M0001', reg)).toBeNull(); // org has no M
    expect(jobTypes.normalizeJobNumber('XQ0001', reg)).toBeNull();
    expect(jobTypes.normalizeJobNumber('2288', reg)).toBeNull();
    expect(jobTypes.normalizeJobNumber('', reg)).toBeNull();
    expect(jobTypes.normalizeJobNumber('S', reg)).toBeNull();
  });

  test('an org with no registry falls back to the defaults rather than refusing everything', () => {
    expect(jobTypes.normalizeJobNumber('M0001', null)).toBe('M0001');
    expect(jobTypes.normalizeJobNumber('S2288', [])).toBe('S2288');
  });

  test('the prefix is normalized to upper case — identity is not case-dependent', () => {
    expect(jobTypes.normalizeJobNumber('m0001', null)).toBe('M0001');
    expect(jobTypes.normalizeJobNumber('rv2044', null)).toBe('RV2044');
  });

  test('the convert route no longer hardcodes S|RV', () => {
    // Pinned on the source because the alternative — driving POST /convert —
    // needs a transaction, a lead, an estimate and a market lookup, none of
    // which this claim is about. The regex was the whole defect.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'routes', 'job-routes.js'), 'utf8');
    expect(src).not.toMatch(/\/\^\(S\|RV\)\\d\{1,6\}\$\/i\.test/);
    expect(src).toMatch(/jobTypes\.normalizeJobNumber/);
  });
});

// ── 5. The schedule board's saved filter ──────────────────────────────
describe('a job type added after a user last saved does not hide their jobs', () => {
  const sched = require('../js/schedule.js');

  test('Mid-Tier Service is an offered filter', () => {
    expect(sched.JOB_TYPE_FILTERS).toContain('Mid-Tier Service');
    expect(sched.DEFAULT_JOB_TYPE_SET['Mid-Tier Service']).toBe(true);
  });

  test('a legacy saved filter is healed PER KEY, not just when absent', () => {
    // What every existing user has in localStorage right now: the three keys
    // that existed when they last touched the bar.
    window.localStorage.setItem('p86-schedule-settings', JSON.stringify({
      jobTypeFilter: { 'Service': true, 'Renovation': true, 'Work Order': false },
    }));
    const s = sched.loadSettings();
    // Without the per-key heal this is `undefined` → falsy → every M job is
    // absent from the board and there is no pill to turn back on.
    expect(s.jobTypeFilter['Mid-Tier Service']).toBe(true);
    // An explicit false is a real choice and survives.
    expect(s.jobTypeFilter['Work Order']).toBe(false);
    expect(s.jobTypeFilter['Service']).toBe(true);
  });

  test('an all-off filter is WILDCARD and is left alone', () => {
    window.localStorage.setItem('p86-schedule-settings', JSON.stringify({
      jobTypeFilter: { 'Service': false, 'Renovation': false, 'Work Order': false },
    }));
    const s = sched.loadSettings();
    // Seeding one key to true here would turn "show everything" into
    // "show only Mid-Tier Service" — hiding every job the user can see today.
    const anyOn = Object.keys(s.jobTypeFilter).some((k) => s.jobTypeFilter[k] === true);
    expect(anyOn).toBe(false);
  });

  afterEach(() => { try { window.localStorage.clear(); } catch (e) { /* node env */ } });
});

// ── 6. QB import: a type with no jobs yet ─────────────────────────────
describe('the QB import tolerates a job type that has no jobs yet', () => {
  const qb = require('../js/job-costs-import.js');
  const AGX_NUMBERS = AGX_JOBS.map((j) => j.jobNumber);

  test('without the registry it still does not break — it just cannot tell', () => {
    const shape = qb.orgJobNumberShape(AGX_NUMBERS);
    expect(shape.known).toBe(true);
    expect(qb.classifyUnmatchedCode('M0001', shape)).toBe('unclear');
    expect(() => qb.unmatchedReason('M0001', shape)).not.toThrow();
  });

  test('with the registry, M0001 is a MISSING JOB, not an unreadable code', () => {
    const shape = qb.orgJobNumberShape(AGX_NUMBERS, ['S', 'M', 'RV', 'WO']);
    expect(shape.prefixes.M).toBe(true);
    expect(qb.classifyUnmatchedCode('M0001', shape)).toBe('missing-job');
    expect(qb.unmatchedReason('M0001', shape)).toMatch(/Create job M0001/);
  });

  test('registry prefixes are not mistaken for EVIDENCE — `known` still means "we have jobs"', () => {
    // An org with a registry and no jobs has nothing to judge against. If
    // registry prefixes counted, every unmatched project on a fresh tenant
    // would be told to "create job X" when the truth is there is nothing here
    // at all.
    const shape = qb.orgJobNumberShape([], ['S', 'M', 'RV', 'WO']);
    expect(shape.known).toBe(false);
    expect(qb.unmatchedReason('M0001', shape)).toMatch(/no jobs yet/);
  });

  test('an org whose every job prefix is also in the registry is still `known`', () => {
    // The counting hazard in the other direction: if the registry pre-seeded
    // the same map the learner de-dupes against, AGX — with 25 jobs — would
    // report "no jobs yet" on every unmatched project.
    const shape = qb.orgJobNumberShape(AGX_NUMBERS, ['S', 'M', 'RV', 'WO']);
    expect(shape.known).toBe(true);
    expect(qb.classifyUnmatchedCode('S2240', shape)).toBe('missing-job');
  });

  test('existing diagnoses are unchanged by the new argument', () => {
    const shape = qb.orgJobNumberShape(AGX_NUMBERS, ['S', 'M', 'RV', 'WO']);
    expect(qb.classifyUnmatchedCode('437775', shape)).toBe('qb-autonumber');
    expect(qb.classifyUnmatchedCode('Citi Lakes', shape)).toBe('no-code');
    expect(qb.classifyUnmatchedCode('ZZ0001', shape)).toBe('unclear');
  });
});
