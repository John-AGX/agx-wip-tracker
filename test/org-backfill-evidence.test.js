// Step 2 of the safety property: stamp from EVIDENCE, never from a guess.
//
// db.js already contains backfills for most of these tables. They are gated on
// NEVER_MULTI_ORG — `(SELECT COUNT(*) FROM organizations) <= 1` — because they
// GUESS: the lowest-numbered org, or the org whose slug is 'agx'. That guess is
// correct exactly while there is one tenant, which is why it is gated, and it
// has two costs that cannot be undone afterwards:
//
//   * a guessed stamp is indistinguishable from an evidenced one in every
//     query, so "the count reached zero" stops meaning "the boundary is
//     provable"; and
//   * the gate switches OFF at the instant a second organization is created —
//     the same instant the boundary starts to matter — so the healer stops
//     exactly when the un-stamped rows become permanent.
//
// Everything asserted below is about the backfill that survives that day: one
// that reads the tenant off a row which already states it, and therefore needs
// no gate at all.

const fs = require('fs');
const path = require('path');

const { backfillFromEvidence, RULES } = require('../server/services/org-backfill-evidence');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const SRC = read('server', 'services', 'org-backfill-evidence.js');
const CONSOLE_SRC = read('server', 'routes', 'admin-console-routes.js');
const DB = read('server', 'db.js');

// A recording client. Counts answer from `counts` (first matching substring);
// UPDATEs record themselves and report a rowCount.
function makePool(opts) {
  opts = opts || {};
  const log = [];
  const client = {
    query: async (sql) => {
      const s = String(sql);
      log.push(s.replace(/\s+/g, ' ').trim());
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i.test(s)) return { rows: [], rowCount: 0 };
      for (const boom of (opts.explode || [])) {
        if (s.indexOf(boom) !== -1) { const e = new Error('boom'); e.code = '57014'; throw e; }
      }
      if (/^UPDATE/i.test(s)) return { rows: [], rowCount: opts.rowCount != null ? opts.rowCount : 3 };
      const key = Object.keys(opts.counts || {}).find((k) => s.indexOf(k) !== -1);
      return { rows: [{ n: String(key ? opts.counts[key] : (opts.defaultCount != null ? opts.defaultCount : 0)) }] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client }, log };
}

describe('it cannot invent a tenant', () => {
  test('every statement requires the SOURCE to be non-null', () => {
    // This is the half that makes it evidence rather than inference. A row
    // whose parent is itself un-stamped is left alone — it stays NULL and
    // stays counted, because a wrong tenant is worse than none.
    const { pool, log } = makePool({ defaultCount: 5 });
    return backfillFromEvidence(pool, { dryRun: true }).then(() => {
      const stmts = log.filter((l) => /^(SELECT COUNT|UPDATE)/i.test(l));
      expect(stmts.length).toBeGreaterThan(10);
      for (const s of stmts) {
        expect({ s: s.slice(0, 70), guarded: /organization_id IS NOT NULL/.test(s) })
          .toEqual({ s: s.slice(0, 70), guarded: true });
      }
    });
  });

  test('every statement only touches rows that are currently NULL', () => {
    const { pool, log } = makePool({ defaultCount: 5 });
    return backfillFromEvidence(pool, { dryRun: true }).then(() => {
      for (const s of log.filter((l) => /^(SELECT COUNT|UPDATE)/i.test(l))) {
        expect({ s: s.slice(0, 70), scoped: /organization_id IS NULL/.test(s) })
          .toEqual({ s: s.slice(0, 70), scoped: true });
      }
    });
  });

  test('it stamps NOTHING on the anchor tables', () => {
    // users / jobs / estimates / leads / clients / subs ARE the anchor: no
    // other row states their tenant, so any value would be a guess by
    // definition. Those stay with db.js's honestly-gated guessers and a human.
    const targets = RULES.map((r) => r.table);
    for (const anchor of ['users', 'jobs', 'estimates', 'leads', 'clients', 'subs']) {
      expect({ anchor, targeted: targets.indexOf(anchor) !== -1 }).toEqual({ anchor, targeted: false });
    }
  });

  test('it never touches the shared assembly taxonomy', () => {
    const targets = RULES.map((r) => r.table);
    for (const shared of ['assembly_trades', 'assembly_systems', 'assembly_variants', 'materials', 'assemblies']) {
      expect({ shared, targeted: targets.indexOf(shared) !== -1 }).toEqual({ shared, targeted: false });
    }
  });

  test('it is NOT gated on the organization count, and the file says why', () => {
    // The db.js backfills must be gated because they guess. These must not be,
    // because the gate would stop them at exactly the moment they matter most.
    // Comments explaining the contrast are expected; executable code must be
    // free of the gate.
    const code = SRC.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/NEVER_MULTI_ORG/);
    expect(code).not.toMatch(/COUNT\(\*\) FROM organizations/);
    expect(SRC).toMatch(/this is the backfill that survives the day the guessing one stops/);
    // …and the guessing ones are still gated, untouched.
    expect(DB).toMatch(/NEVER_MULTI_ORG/);
  });
});

describe('dry run is the default and writes nothing', () => {
  test('no options at all means no UPDATE and a ROLLBACK', async () => {
    const { pool, log } = makePool({ defaultCount: 9 });
    const r = await backfillFromEvidence(pool);
    expect(r.dry_run).toBe(true);
    expect(log.filter((l) => /^UPDATE/i.test(l))).toHaveLength(0);
    expect(log).toContain('ROLLBACK');
    expect(log.filter((l) => /^COMMIT/.test(l))).toHaveLength(0);
    expect(r.total_derivable).toBeGreaterThan(0);
    expect(r.note).toMatch(/nothing was written/);
  });

  test('dry_run must be EXPLICITLY false to write', async () => {
    // `dryRun: undefined`, `dryRun: 0`, a missing body — all stay dry.
    for (const opt of [{}, { dryRun: undefined }, { tables: ['ai_messages'] }]) {
      const { pool, log } = makePool({ defaultCount: 1 });
      await backfillFromEvidence(pool, opt);
      expect(log.filter((l) => /^UPDATE/i.test(l))).toHaveLength(0);
    }
  });

  test('an applied run COMMITs and reports what it wrote', async () => {
    const { pool, log } = makePool({ defaultCount: 4, rowCount: 4 });
    const r = await backfillFromEvidence(pool, { dryRun: false });
    expect(log.filter((l) => /^UPDATE/i.test(l)).length).toBeGreaterThan(10);
    expect(log).toContain('COMMIT');
    expect(r.results.every((x) => x.updated === 4)).toBe(true);
    expect(r.note).toMatch(/Anything still NULL after this could NOT be derived/);
  });

  test('a table with nothing to stamp issues no UPDATE at all', async () => {
    const { pool, log } = makePool({ defaultCount: 0 });
    await backfillFromEvidence(pool, { dryRun: false });
    expect(log.filter((l) => /^UPDATE/i.test(l))).toHaveLength(0);
  });
});

describe('it is idempotent, bounded, and off the boot path', () => {
  test('idempotence is structural — re-running matches nothing', () => {
    // There is no cursor and no partial state to resume: the second run's
    // WHERE clause excludes everything the first run stamped.
    expect(SRC).toMatch(/IDEMPOTENT BY CONSTRUCTION/);
    const { pool, log } = makePool({ defaultCount: 2 });
    return backfillFromEvidence(pool, { dryRun: true }).then(() => {
      for (const s of log.filter((l) => /^UPDATE/i.test(l) || /^SELECT COUNT/i.test(l))) {
        expect(s).toMatch(/organization_id IS NULL/);
      }
    });
  });

  test('statement_timeout and lock_timeout are set on the write connection', async () => {
    const { pool, log } = makePool({});
    await backfillFromEvidence(pool, { dryRun: false });
    expect(log.some((l) => /SET LOCAL statement_timeout = \d+/.test(l))).toBe(true);
    expect(log).toContain("SET LOCAL lock_timeout = '3s'");
    // The pool itself still has neither, which is why these must be here.
    expect(DB).not.toMatch(/new Pool\([\s\S]{0,300}statement_timeout/);
  });

  test('it is not called from init() — a boot migration that hangs never logs why', () => {
    expect(DB).not.toMatch(/backfillFromEvidence/);
    expect(read('server', 'index.js')).not.toMatch(/backfillFromEvidence/);
  });

  test('the endpoint is SYSTEM_ADMIN', () => {
    expect(CONSOLE_SRC).toMatch(
      /router\.post\('\/org-boundary\/backfill', requireAuth, requireSystemAdmin/);
  });

  test('an applied run is logged with the actor', () => {
    expect(CONSOLE_SRC).toMatch(/\[org\] evidence backfill APPLIED by user=/);
  });
});

describe('"could not measure" is never reported as "there is nothing to do"', () => {
  test('a failing table reports null and is named, and does not poison the rest', async () => {
    const { pool } = makePool({ defaultCount: 6, explode: ['FROM qb_cost_lines'] });
    const r = await backfillFromEvidence(pool, { dryRun: true });
    const bad = r.results.find((x) => x.label === 'qb_cost_lines');
    expect(bad.derivable).toBeNull();
    expect(r.not_measured.map((x) => x.what)).toContain('qb_cost_lines');
    // Its neighbours still measured.
    expect(r.results.find((x) => x.label === 'ai_messages').derivable).toBe(6);
    // …and it is not silently folded into the total as a zero.
    expect(r.unmeasured_tables).toBe(1);
  });
});

describe('the attachment ladder is respected, not flattened', () => {
  test('rung 1 (parent) and rung 3 (uploader) only — never rung 2 or 4', async () => {
    const { pool } = makePool({ defaultCount: 1 });
    const r = await backfillFromEvidence(pool, { dryRun: true });
    const labels = r.results.map((x) => x.label);
    expect(labels.some((l) => /^attachments \(parent entity\)/.test(l))).toBe(true);
    expect(labels.some((l) => /^attachments \(uploader\)/.test(l))).toBe(true);
    // Rung 2 IS the column being filled; rung 4 is the tolerance, and turning
    // tolerance into a stamp is the one thing this must never do.
    expect(labels.some((l) => /rung ?2|rung ?4/i.test(l))).toBe(false);
  });

  test('the uploader rung only touches ORPHANS, never a row with a live parent', async () => {
    // A row whose parent EXISTS but is itself un-stamped must keep waiting for
    // its parent. Giving it the uploader's tenant would create precisely the
    // two-pointer disagreement this wave exists to remove — a child stamped to
    // one tenant hanging off a parent stamped to another.
    const { pool, log } = makePool({ defaultCount: 1 });
    await backfillFromEvidence(pool, { dryRun: true });
    const rung3 = log.filter((l) => /uploaded_by/.test(l));
    expect(rung3.length).toBeGreaterThan(0);
    for (const s of rung3) expect(s).toMatch(/NOT \(/);
  });

  test('the parent rung runs one statement per entity type, from the shared whitelist', async () => {
    const { ENTITY_TABLES } = require('../server/services/attachment-org-scope');
    const { pool } = makePool({ defaultCount: 1 });
    const r = await backfillFromEvidence(pool, { dryRun: true });
    const parents = r.results.filter((x) => /^attachments \(parent entity\)/.test(x.label));
    expect(parents.length).toBe(Object.keys(ENTITY_TABLES).length);
    // Table names come from that map, never from a request.
    expect(SRC).toMatch(/const \{ ENTITY_TABLES \} = require\('\.\/attachment-org-scope'\)/);
  });
});

describe('every rule records WHAT it derived the tenant from', () => {
  test('each carries a `why`, and it names the source row', () => {
    for (const r of RULES) {
      expect(typeof r.why).toBe('string');
      expect(r.why.length).toBeGreaterThan(40);
    }
    // The two that need the most care say so.
    expect(RULES.find((r) => r.table === 'invoices').why).toMatch(/NULLABLE/);
    expect(RULES.find((r) => r.key === 'created_by').why).toMatch(/standalone|creator/i);
  });

  test('the report hands the reason back with the number', async () => {
    const { pool } = makePool({ defaultCount: 2 });
    const r = await backfillFromEvidence(pool, { dryRun: true });
    for (const row of r.results) expect(typeof row.why).toBe('string');
  });
});
