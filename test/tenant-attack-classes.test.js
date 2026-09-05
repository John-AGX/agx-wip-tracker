// ALL EIGHT ATTACK CLASSES, PLANTED AND CAUGHT.
//
// ── WHY THIS FILE IS COMMITTED RATHER THAN PERFORMED ONCE ─────────────────
// The two-org fixture's whole claim is "this catches the eight shapes that beat
// every previous guard". A claim like that, demonstrated once by hand in a
// commit message and then deleted, decays into folklore the first time somebody
// simplifies the oracle to make an unrelated test pass. So the eight attacks
// live here, permanently, executed on every run.
//
// EACH ONE IS WRITTEN IN THE STYLE THAT ACTUALLY BEAT THE LAST GUARD — not a
// caricature. A2 is the live shape found in GET /managed/audit, which named
// `organization_id` four times and filtered on none. A4 is the laundering shape
// the brief describes. A6 hides the column name in a block comment because the
// scanner only blanked `--` line comments. A7 goes through a wrapper because the
// read scanner keyed on the literal text `.query(`. A8 lives in a module reached
// by a COMPUTED require, which no static walk can follow.
//
// ── WHAT "CAUGHT" MEANS HERE, AND WHAT IT DELIBERATELY DOES NOT MEAN ──────
// Caught means THE ORACLE FLAGS THE ANSWER. Every assertion below runs the
// leaky statement against the two-org fixture and asserts that at least one arm
// — marker, poison, or differential — reports it. No assertion reads the SQL
// text of the attack, because the moment "caught" means "the scanner recognised
// the string", A2, A6 and A7 are alive again and this file is theatre.
//
// ── THE SECOND HALF OF EACH CASE, WHICH IS THE PART THAT MATTERS ──────────
// Every attack is paired with its CORRECT counterpart: the same read, properly
// predicated, asserted to be CLEAN. Without that pairing this file would pass
// just as well if the oracle flagged literally everything, and an oracle that
// cries wolf on correct code is worth less than no oracle, because it gets
// muted. The pairing is what says the oracle discriminates.
'use strict';

const TWO = require('./helpers/two-org');
const { ORG_A, ORG_B, MARK } = TWO;

// The same overlay shape the conformance suite uses, reduced to the tables
// these eight statements touch. Ids are DERIVED — see test/helpers/two-org.js.
const ID = (t, tag) => TWO.idFor(t, tag);
const P = 900007000;

const OVERLAY = {
  organizations: [
    { id: ORG_A, name: 'Affiliate Alpha', slug: 'alpha' },
    { id: ORG_B, name: MARK + ' Affiliate', slug: 'zzvictimbravo' },
  ],
  clients: [
    { id: ID('clients', 'A'), organization_id: ORG_A, name: 'Alpha HOA' },
    { id: ID('clients', 'B'), organization_id: ORG_B, name: MARK + ' Property Group' },
    { id: ID('clients', 'N'), organization_id: null, name: 'Legacy Client' },
  ],
  subs: [
    { id: ID('subs', 'A'), organization_id: ORG_A, name: 'Alpha Roofing' },
    { id: ID('subs', 'B'), organization_id: ORG_B, name: MARK + ' Roofing' },
    { id: ID('subs', 'N'), organization_id: null, name: 'Legacy Roofing' },
  ],
  qb_cost_lines: [
    { id: ID('qb_cost_lines', 'A'), organization_id: ORG_A, job_id: ID('jobs', 'A'), amount: 150, vendor: 'Alpha Supply' },
    { id: ID('qb_cost_lines', 'B'), organization_id: ORG_B, job_id: ID('jobs', 'B'), amount: P, vendor: MARK + ' Supply' },
    { id: ID('qb_cost_lines', 'N'), organization_id: null, job_id: ID('jobs', 'N'), amount: 7, vendor: 'Legacy Supply' },
  ],
  estimates: [
    { id: ID('estimates', 'A'), organization_id: ORG_A, owner_id: 100, data: '{}' },
    { id: ID('estimates', 'B'), organization_id: ORG_B, owner_id: 900001001, data: '{}' },
    { id: ID('estimates', 'N'), organization_id: null, owner_id: null, data: '{}' },
  ],
  // A1's table: it carries organization_id and classify() calls it
  // "unclassified", which under a classification-derived population is exactly
  // how a table drops out and takes its leak with it.
  live_rooms: [
    { id: ID('live_rooms', 'A'), organization_id: ORG_A, token: 'alpha-token' },
    { id: ID('live_rooms', 'B'), organization_id: ORG_B, token: MARK + '-token' },
    { id: ID('live_rooms', 'N'), organization_id: null, token: 'legacy-token' },
  ],
};

const two = () => TWO.buildEngine({ overlay: OVERLAY });
const one = () => TWO.buildEngine({ overlay: OVERLAY, withB: false });

// ── the oracle, exactly as the conformance suite applies it ───────────────
// Three arms. `caughtBy` names which one fired, so a failure says WHY rather
// than only THAT.
async function verdict(run) {
  const twoOrg = await run(two().pool, ORG_A);
  const oneOrg = await run(one().pool, ORG_A);
  const scan = TWO.scanAnswer(twoOrg);
  const arms = [];
  if (scan.marked) arms.push('MARK');
  if (scan.poisoned.length) arms.push('POISON(' + scan.poisoned.join(',') + ')');
  if (TWO.flatten(twoOrg) !== TWO.flatten(oneOrg)) arms.push('DIFFERENTIAL');
  return { caughtBy: arms, answer: TWO.flatten(twoOrg) };
}

// A7's wrapper. A scanner keying on the literal `.query(` inside a route file
// never sees the statement that goes through here.
async function runSql(pool, sql, params) {
  const r = await pool.query(sql, params || []);
  return r.rows;
}

// Each case records itself here as it passes. See the summary at the foot of
// the file for why this is a recording rather than a source scan.
const CAUGHT = [];
const CLEAN = [];

const render = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');

// ══════════════════════════════════════════════════════════════════════════
describe('the eight attack classes, executed against a second organisation', () => {
  // ── A1 ────────────────────────────────────────────────────────────────
  // A tenant table classify() cannot place. Under a population derived FROM the
  // classification, this table is not in the fixture at all and the read below
  // has nothing to leak. The two-org fixture derives its schema from every
  // CREATE TABLE in server/db.js instead, so the table is present, seeded, and
  // the leak is visible.
  test('A1 — unclassified tenant table (live_rooms) — CAUGHT', async () => {
    const v = await verdict(async (pool) => render(await runSql(pool, 'SELECT token, organization_id FROM live_rooms')));
    expect(v.caughtBy).toContain('MARK');
    expect(TWO.classifyIsUnclassified('live_rooms')).toBe(true);
    CAUGHT.push('A1');
  });

  test('A1 — the same read, predicated — CLEAN', async () => {
    const v = await verdict(async (pool, org) =>
      render(await runSql(pool, 'SELECT token, organization_id FROM live_rooms WHERE organization_id = $1', [org])));
    expect(v.caughtBy).toEqual([]);
    CLEAN.push('A1');
  });

  // ── A2 ────────────────────────────────────────────────────────────────
  // The live shape from GET /managed/audit: `organization_id` in the
  // projection, in the JOIN ON, and in the ORDER BY — filtering on none of
  // them. Every "does this statement mention the tenant column" scan passes it.
  test('A2 — predicate moved into ORDER BY / JOIN ON, never into WHERE — CAUGHT', async () => {
    const v = await verdict(async (pool) => render(await runSql(pool, `
      SELECT c.name, c.organization_id, o.name AS org_name
        FROM clients c
        LEFT JOIN organizations o ON o.id = c.organization_id
       ORDER BY c.organization_id, c.id`)));
    expect(v.caughtBy).toContain('MARK');
    CAUGHT.push('A2');
  });

  test('A2 — the same statement with a real WHERE — CLEAN', async () => {
    const v = await verdict(async (pool, org) => render(await runSql(pool, `
      SELECT c.name, c.organization_id, o.name AS org_name
        FROM clients c
        LEFT JOIN organizations o ON o.id = c.organization_id
       WHERE (c.organization_id = $1 OR c.organization_id IS NULL)
       ORDER BY c.organization_id, c.id`, [org])));
    expect(v.caughtBy).toEqual([]);
    CLEAN.push('A2');
  });

  // ── A3 ────────────────────────────────────────────────────────────────
  // Leaks no string at all — a marker grep structurally cannot see it. It is
  // caught because ORG B'S OWN ID IS 900000002, so the GROUP BY puts a
  // band number straight into the projection.
  test('A3 — bare GROUP BY organization_id — CAUGHT BY POISON (no string leaks)', async () => {
    const v = await verdict(async (pool) => render(await runSql(pool,
      'SELECT organization_id, COUNT(*) AS n FROM estimates GROUP BY organization_id ORDER BY organization_id')));
    expect(v.caughtBy).toEqual(expect.arrayContaining(['POISON(900000002)']));
    // The point, stated as an assertion rather than as a comment: the marker
    // arm is BLIND here, and this is the case that justifies the second arm.
    expect(v.caughtBy).not.toContain('MARK');
    CAUGHT.push('A3');
  });

  test('A3 — grouped within one tenant — CLEAN', async () => {
    const v = await verdict(async (pool, org) => render(await runSql(pool,
      `SELECT organization_id, COUNT(*) AS n FROM estimates
        WHERE (organization_id = $1 OR organization_id IS NULL)
        GROUP BY organization_id ORDER BY organization_id`, [org])));
    expect(v.caughtBy).toEqual([]);
    CLEAN.push('A3');
  });

  // ── A4 ────────────────────────────────────────────────────────────────
  // THE HARDEST ONE, and the reason the numeric band exists. The ROWS are
  // correctly scoped — every row returned belongs to org A — but a scalar
  // subquery totals the whole table. No org-B row is ever returned, no marker
  // appears, and the only evidence is the MAGNITUDE of one number.
  test('A4 — rows scoped, subquery total NOT — CAUGHT BY POISON (no org-B row is returned)', async () => {
    const v = await verdict(async (pool, org) => render(await runSql(pool, `
      SELECT q.id, q.vendor, q.amount,
             (SELECT COALESCE(SUM(amount), 0) FROM qb_cost_lines) AS grand_total
        FROM qb_cost_lines q
       WHERE (q.organization_id = $1 OR q.organization_id IS NULL)
       ORDER BY q.id`, [org])));
    expect(v.caughtBy.join(' ')).toContain('POISON');
    // THE LAUNDERED TOTAL, TO THE DIGIT: org B's 900,007,000 plus org A's 150
    // plus the un-stamped row's 7. Asserting the exact figure rather than "some
    // number was flagged" is what shows the arm is reading the arithmetic and
    // not merely noticing that a big number exists somewhere.
    expect(v.answer).toContain('900007157');
    // Nothing belonging to org B came back — only its arithmetic did. This is
    // exactly what makes A4 invisible to a marker grep AND to any check that
    // inspects the returned ROWS rather than the returned NUMBERS.
    expect(v.answer).not.toContain(MARK);
    CAUGHT.push('A4');
  });

  test('A4 — the subquery scoped too — CLEAN', async () => {
    const v = await verdict(async (pool, org) => render(await runSql(pool, `
      SELECT q.id, q.vendor, q.amount,
             (SELECT COALESCE(SUM(amount), 0) FROM qb_cost_lines
               WHERE (organization_id = $1 OR organization_id IS NULL)) AS grand_total
        FROM qb_cost_lines q
       WHERE (q.organization_id = $1 OR q.organization_id IS NULL)
       ORDER BY q.id`, [org])));
    expect(v.caughtBy).toEqual([]);
    CLEAN.push('A4');
  });

  // ── A5 ────────────────────────────────────────────────────────────────
  // One arm of the UNION is predicated and one is not. The statement NAMES
  // organization_id and BINDS it, so it reads literal and correct to a scanner
  // — and returns the other tenant's subcontractors.
  test('A5 — one UNION arm unpredicated while the statement names the column — CAUGHT', async () => {
    const v = await verdict(async (pool, org) => render(await runSql(pool, `
      SELECT name, organization_id FROM clients WHERE (organization_id = $1 OR organization_id IS NULL)
      UNION ALL
      SELECT name, organization_id FROM subs
      ORDER BY name`, [org])));
    expect(v.caughtBy).toContain('MARK');
    CAUGHT.push('A5');
  });

  test('A5 — both arms predicated — CLEAN', async () => {
    const v = await verdict(async (pool, org) => render(await runSql(pool, `
      SELECT name, organization_id FROM clients WHERE (organization_id = $1 OR organization_id IS NULL)
      UNION ALL
      SELECT name, organization_id FROM subs WHERE (organization_id = $1 OR organization_id IS NULL)
      ORDER BY name`, [org])));
    expect(v.caughtBy).toEqual([]);
    CLEAN.push('A5');
  });

  // ── A6 ────────────────────────────────────────────────────────────────
  // The predicate is present in the SOURCE and absent from the STATEMENT. The
  // previous scanner blanked `--` line comments and not `/* */` blocks, so it
  // read the commented-out clause as a live filter.
  test('A6 — the predicate hidden inside a /* */ comment — CAUGHT', async () => {
    const v = await verdict(async (pool) => render(await runSql(pool,
      'SELECT name, organization_id FROM clients /* WHERE organization_id = 1 */ ORDER BY id')));
    expect(v.caughtBy).toContain('MARK');
    CAUGHT.push('A6');
  });

  test('A6 — the same predicate uncommented — CLEAN', async () => {
    const v = await verdict(async (pool, org) => render(await runSql(pool,
      'SELECT name, organization_id FROM clients WHERE organization_id = $1 ORDER BY id', [org])));
    expect(v.caughtBy).toEqual([]);
    CLEAN.push('A6');
  });

  // ── A7 ────────────────────────────────────────────────────────────────
  // Every statement in this file already goes through `runSql`, a wrapper, so
  // a scanner keying on the literal `.query(` has seen none of them. This case
  // states that explicitly: the wrapper is transparent to the oracle because
  // the oracle never looks at the call site, only at the rows.
  test('A7 — the statement handed to a wrapper, never to .query( directly — CAUGHT', async () => {
    const v = await verdict(async (pool) => {
      const rows = await runSql(pool, 'SELECT name, organization_id FROM subs ORDER BY id');
      return render(rows);
    });
    expect(v.caughtBy).toContain('MARK');
    CAUGHT.push('A7');
  });

  test('A7 — the same wrapper with a predicate passed through it — CLEAN', async () => {
    const v = await verdict(async (pool, org) =>
      render(await runSql(pool, 'SELECT name, organization_id FROM subs WHERE (organization_id = $1 OR organization_id IS NULL) ORDER BY id', [org])));
    expect(v.caughtBy).toEqual([]);
    CLEAN.push('A7');
  });

  // ── A8 ────────────────────────────────────────────────────────────────
  // The statement lives in test/fixtures/tenant-attack-a8.js, required by a
  // COMPUTED name so that no literal path exists for a require-graph walk to
  // follow. Execution does not care where code lives.
  test('A8 — a leak in a module reached only by a computed require — CAUGHT', async () => {
    const base = './fixtures/tenant-attack';
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const hidden = require(base + '-a8');
    const v = await verdict((pool) => hidden.hiddenCrossTenantRead(pool));
    expect(v.caughtBy).toContain('MARK');
    CAUGHT.push('A8');
  });

  // ── the summary, RECORDED BY THE CASES THEMSELVES ──────────────────────
  // The first draft of this counted test names by reading this file's own
  // source with a regex — in a file whose entire thesis is that reading source
  // is what let all eight of these through. It also miscounted, because the
  // needle matched the line that contained it. Both problems have the same
  // cure: the cases RECORD themselves as they run, and the summary asserts the
  // recording. Nothing here reads a character of source.
  test('ALL EIGHT classes were planted AND caught', () => {
    expect(CAUGHT.slice().sort()).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
  });

  // The discrimination property. An oracle that flagged everything would pass
  // every CAUGHT assertion above and be worthless — worse than worthless, since
  // a suite that cries wolf on correct code gets muted. Seven correctly
  // predicated counterparts run clean, and the list is asserted so one cannot
  // be quietly deleted to make a failing attack case look caught.
  test('the oracle DISCRIMINATES — the correctly predicated counterparts are clean', () => {
    expect(CLEAN.slice().sort()).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
  });

  // A8 has no CLEAN counterpart on purpose, and saying so out loud is cheaper
  // than leaving the asymmetry for a reader to wonder about: A8 is not a defect
  // in a statement, it is a claim about REACHABILITY. Its correct counterpart is
  // "the module is not required at all", which cannot be executed and therefore
  // cannot be asserted. What A8 proves is that hiding a statement from a walk
  // does not hide its rows.
  test('A8 has no CLEAN counterpart, and the reason is recorded', () => {
    expect(CLEAN).not.toContain('A8');
    expect(CAUGHT).toContain('A8');
  });
});
