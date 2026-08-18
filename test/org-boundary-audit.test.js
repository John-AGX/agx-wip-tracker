// The instrument the tenant-boundary endgame is gated on.
//
// The endgame's rule is "prove zero, then tighten". Every previous attempt to
// prove zero used a gauge that could not fail loudly:
//
//   * reportOrgStampAudit swallowed per-table errors into an empty slot, then
//     printed "every row in <all ten tables> carries an organization_id"
//     regardless of how many it had actually counted.
//   * reportOrgOwnerDivergence returned a bare, unlogged 0 when to_regclass
//     said public.jobs did not exist.
//   * Both cover 10 tables of ~75, and the three highest-row tables were
//     deliberately excluded because they run before listen().
//
// So the properties asserted here are not "does it count" — it is "can it lie".
// A measurement that renders NOT MEASURED as ZERO is worse than no measurement,
// because the next step after a zero is dropping a tolerance arm on live
// contract money.

const fs = require('fs');
const path = require('path');

const { auditOrgBoundary } = require('../server/services/org-boundary-audit');
const classification = require('../server/services/org-table-classification');

const DB_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
const CONSOLE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'routes', 'admin-console-routes.js'), 'utf8');
const ASSEMBLIES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'services', 'assemblies.js'), 'utf8');

// ── A recording pool whose per-statement answer is programmable ────────────
// `explode` matches a substring of the SQL; a matching statement throws, the
// way a statement_timeout or a missing column does in production.
function makePool(opts) {
  opts = opts || {};
  const catalogRows = opts.catalog || [
    { table_name: 'jobs', is_nullable: 'YES' },
    { table_name: 'clients', is_nullable: 'YES' },
    { table_name: 'projects', is_nullable: 'NO' },
    { table_name: 'assembly_trades', is_nullable: 'YES' },
    { table_name: 'attachments', is_nullable: 'YES' },
    { table_name: 'widgets_from_the_future', is_nullable: 'YES' },
  ];
  const counts = opts.counts || {};
  const log = [];
  const client = {
    query: async (sql, params) => {
      log.push(String(sql).replace(/\s+/g, ' ').trim());
      const s = String(sql);
      for (const boom of (opts.explode || [])) {
        if (s.indexOf(boom) !== -1) {
          const e = new Error('canceling statement due to statement timeout');
          e.code = '57014';
          throw e;
        }
      }
      if (/information_schema\.columns/.test(s)) return { rows: catalogRows };
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i.test(s)) return { rows: [] };
      if (/SELECT id FROM/.test(s)) return { rows: [{ id: 'sample_1' }] };
      // COUNT(*) — answer from the table named in the FROM clause, default 0.
      const m = s.match(/FROM ([a-z_]+)/);
      const t = m ? m[1] : '?';
      const key = Object.keys(counts).find((k) => s.indexOf(k) !== -1);
      const n = key ? counts[key] : (counts[t] != null ? counts[t] : 0);
      return { rows: [{ n: String(n) }] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client }, log };
}

describe('the audit cannot report "not measured" as "zero"', () => {
  test('a table whose count throws is null, is NAMED, and never reaches ready_for_not_null', async () => {
    const { pool } = makePool({
      explode: ['FROM clients WHERE organization_id IS NULL'],
      counts: { jobs: 0 },
    });
    const r = await auditOrgBoundary(pool);

    const clients = r.buckets.direct.find((x) => x.table === 'clients');
    expect(clients.nulls).toBeNull();                 // not 0
    expect(r.not_measured.map((x) => x.what)).toContain('nulls:clients');
    expect(r.not_measured[0].code).toBe('57014');     // the reason survives

    expect(r.ready_for_not_null).not.toContain('clients');
    const blocked = r.blocked.find((x) => x.table === 'clients');
    expect(blocked.reason).toMatch(/NOT MEASURED/);
    expect(blocked.reason).toMatch(/not the same as zero/);
  });

  test('a MEASURED zero is what licenses a table, and only that', async () => {
    const { pool } = makePool({ counts: { jobs: 0, clients: 0, attachments: 0 } });
    const r = await auditOrgBoundary(pool);
    expect(r.ready_for_not_null).toContain('jobs');
    expect(r.ready_for_not_null).toContain('clients');
  });

  test('a non-zero count blocks the table by name', async () => {
    const { pool } = makePool({ counts: { 'FROM jobs WHERE organization_id IS NULL': 7 } });
    const r = await auditOrgBoundary(pool);
    expect(r.ready_for_not_null).not.toContain('jobs');
    expect(r.blocked.find((x) => x.table === 'jobs').nulls).toBe(7);
  });

  test('one failing statement does not poison the rest of the run', async () => {
    // Without a savepoint per measurement, the first error aborts the
    // transaction and every subsequent count fails too — which would render as
    // "nothing could be measured" and look like a broken endpoint rather than
    // one bad table.
    const { pool } = makePool({ explode: ['FROM clients WHERE organization_id IS NULL'] });
    const r = await auditOrgBoundary(pool);
    expect(r.buckets.direct.find((x) => x.table === 'jobs').nulls).toBe(0);
    expect(r.pointers.divergent).toBe(0);
  });
});

describe('it is a pure read, and it is bounded', () => {
  test('READ ONLY transaction, always rolled back, never committed', async () => {
    const { pool, log } = makePool({});
    await auditOrgBoundary(pool);
    expect(log[0]).toBe('BEGIN READ ONLY');
    expect(log).toContain('ROLLBACK');
    expect(log.filter((l) => /^COMMIT/.test(l))).toHaveLength(0);
  });

  test('every statement runs under a statement_timeout, because the pool has none', async () => {
    // server/db.js creates the Pool with connectionString + ssl only. Every
    // count here is a guaranteed sequential scan (idx_*_org are PARTIAL on
    // IS NOT NULL and cannot serve IS NULL), so one admin click on attachments
    // could otherwise pin a pool connection indefinitely.
    expect(DB_SRC).not.toMatch(/new Pool\([\s\S]{0,300}statement_timeout/);
    const { pool, log } = makePool({});
    await auditOrgBoundary(pool);
    expect(log.some((l) => /SET LOCAL statement_timeout = \d+/.test(l))).toBe(true);
    expect(log).toContain("SET LOCAL lock_timeout = '3s'");
  });

  test('the timeout is clamped, so a query string cannot disable it', async () => {
    const { pool, log } = makePool({});
    await auditOrgBoundary(pool, { timeoutMs: 99999999 });
    const set = log.find((l) => /statement_timeout/.test(l));
    expect(Number(set.match(/= (\d+)/)[1])).toBeLessThanOrEqual(120000);
    const { pool: p2, log: l2 } = makePool({});
    await auditOrgBoundary(p2, { timeoutMs: 0 });
    expect(Number(l2.find((l) => /statement_timeout/.test(l)).match(/= (\d+)/)[1])).toBeGreaterThanOrEqual(1000);
  });

  test('it issues no INSERT, UPDATE or DELETE', async () => {
    const { pool, log } = makePool({});
    await auditOrgBoundary(pool);
    for (const l of log) expect(l).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)/i);
  });
});

describe('the table list comes from the catalog, not from an array', () => {
  test('a table nobody hardcoded is still counted', async () => {
    const { pool } = makePool({});
    const r = await auditOrgBoundary(pool);
    // The hardcoded ten in db.js is exactly how attachments / ai_messages /
    // messages — the three tables the write-path audit named as leaking — fell
    // out of the count.
    const all = [].concat(...Object.keys(r.buckets).map((k) => r.buckets[k])).map((x) => x.table);
    expect(all).toContain('attachments');
    expect(all).toContain('widgets_from_the_future');
  });

  test('a table with no classification is reported by name, not silently bucketed', async () => {
    const { pool } = makePool({});
    const r = await auditOrgBoundary(pool);
    expect(r.unclassified).toEqual(['widgets_from_the_future']);
    expect(r.unclassified_warning).toMatch(/where the next hole lives/);
  });

  test('is_nullable is read, so "zero because already tight" is distinguishable', async () => {
    const { pool } = makePool({});
    const r = await auditOrgBoundary(pool);
    const proj = r.buckets.direct.find((x) => x.table === 'projects');
    expect(proj.nullable).toBe(false);
    expect(proj.nulls).toBe(0);
    expect(proj.note).toMatch(/already NOT NULL/);
    // Already-tight tables are not "ready" — there is nothing left to do.
    expect(r.ready_for_not_null).not.toContain('projects');
  });
});

describe('a shared-catalog NULL is never counted as a leak', () => {
  test('shared tables land in their own bucket and in neither verdict list', async () => {
    const { pool } = makePool({ counts: { assembly_trades: 400 } });
    const r = await auditOrgBoundary(pool);
    expect(r.buckets.shared.map((x) => x.table)).toContain('assembly_trades');
    expect(r.buckets.direct.map((x) => x.table)).not.toContain('assembly_trades');
    expect(r.ready_for_not_null).not.toContain('assembly_trades');
    expect(r.blocked.map((x) => x.table)).not.toContain('assembly_trades');
  });

  test('the shared list is imported from the module that WRITES the NULLs', () => {
    // If this list were re-typed here, a table added to seedGlobalTaxonomy
    // would be enumerated by the catalog, counted as un-stamped, "fixed" by a
    // backfill, and the shared catalog would split per tenant and vanish from
    // every other org. Deriving it from the seeder makes that impossible.
    const CLS = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'org-table-classification.js'), 'utf8');
    expect(CLS).toMatch(/require\('\.\/assemblies'\)/);
    expect(CLS).toMatch(/SHARED_NULL_ORG_TABLES/);
    // …and the seeder actually inserts NULL into every table it declares.
    for (const t of classification.SHARED) {
      expect(ASSEMBLIES_SRC).toMatch(new RegExp('INSERT INTO ' + t + '[\\s\\S]{0,200}SELECT NULL'));
    }
  });
});

describe('the three pointer shapes, not just the one the boot reporter sees', () => {
  test('pointer-orphan and ownerless are measured alongside divergence', async () => {
    const { pool } = makePool({
      counts: {
        'j.organization_id <> u.organization_id': 0,
        'j.organization_id IS NOT NULL AND u.organization_id IS NULL': 3,
      },
    });
    const r = await auditOrgBoundary(pool);
    expect(r.pointers.divergent).toBe(0);
    // The armed state: fully stamped column (so the NULL audit reads clean)
    // with an org-less owner (so the divergence reporter's
    // `u.organization_id IS NOT NULL` guard skips it). Both existing gauges
    // read clean on exactly the rows that detonate.
    expect(r.pointers.pointer_orphan).toBe(3);
    expect(r.pointers).toHaveProperty('jobs_ownerless');
    expect(r.pointers).toHaveProperty('estimates_ownerless');
  });

  test('the boot divergence reporter no longer returns 0 for a missing table', () => {
    const body = DB_SRC.slice(DB_SRC.indexOf('async function reportOrgOwnerDivergence'));
    const head = body.slice(0, body.indexOf('const c = await pool.query'));
    expect(head).toMatch(/return null;/);
    expect(head).not.toMatch(/return 0;/);
    expect(head).toMatch(/could not be measured/);
  });

  test('the boot stamp audit no longer claims tables it did not count', () => {
    const body = DB_SRC.slice(DB_SRC.indexOf('async function reportOrgStampAudit'));
    const head = body.slice(0, body.indexOf('console.warn(`[org] ${phase}: rows with NO'));
    // It used to print ORG_STAMP_AUDIT_TABLES.join('/') — the whole list —
    // whether or not any given table had been measured.
    expect(head).toMatch(/unmeasured/);
    expect(head).toMatch(/NOT MEASURED/);
    expect(head).toMatch(/measured\.join\('\/'\)/);
    expect(head).not.toMatch(/ORG_STAMP_AUDIT_TABLES\.join\('\/'\)/);
  });
});

describe('the tightening simulator answers the gating question', () => {
  test('a direct arm reports the rows it would hide, with samples', async () => {
    const { pool } = makePool({ counts: { 'FROM jobs WHERE organization_id IS NULL': 5 } });
    const r = await auditOrgBoundary(pool);
    const arm = r.simulation.would_hide.find((x) => x.arm === 'jobs.organization_id');
    expect(arm.rows).toBe(5);
    expect(arm.sample).toEqual(['sample_1']);
  });

  test('the jobs arm reports its CASCADE — the children that carry no arm at all', async () => {
    // job_change_orders, qb_cost_lines and job_reports scope ENTIRELY through
    // the parent job. Dropping the jobs arm removes them silently, and their
    // own NULL count says nothing about it.
    const { pool } = makePool({ counts: {
      'FROM jobs WHERE organization_id IS NULL': 5,
      'JOIN jobs j ON j.id = ch.': 3,
    } });
    const r = await auditOrgBoundary(pool);
    const cascaded = r.simulation.would_hide.filter((x) => /CASCADE/.test(x.arm)).map((x) => x.table);
    expect(cascaded).toEqual(expect.arrayContaining(['job_change_orders', 'qb_cost_lines', 'job_reports']));
    const money = r.simulation.would_hide.find((x) => /MONEY/.test(x.arm));
    expect(money.note).toMatch(/job-wip/);
    expect(money.note).toMatch(/re-issue a live number/);
  });

  test('ALREADY-STRICT sites are reported too — they have no arm to diff', async () => {
    // 144 statements in this repo bind `organization_id = $1` with no
    // tolerance, 36 of them the Command-Center owner-joins. An arm-diff
    // reports 0 for every one of them, while the rows are hidden right now.
    const { pool } = makePool({ counts: { 'u.id IS NULL OR u.organization_id IS NULL': 12 } });
    const r = await auditOrgBoundary(pool);
    const strict = r.simulation.already_hidden;
    expect(strict.map((x) => x.table)).toEqual(expect.arrayContaining(['jobs', 'estimates', 'leads']));
    expect(strict.find((x) => x.table === 'jobs').rows).toBe(12);
    expect(strict.find((x) => x.table === 'leads').note).toMatch(/NO owner_id column/);
  });

  test('the JAVASCRIPT tolerance twin is reported, because no SQL diff can see it', async () => {
    // `userInOrg(orgId, rowOrg)` returns TRUE when rowOrg is null, in JS. It
    // gates every attachment by-id door and every admin user door. A simulator
    // that only diffs SQL arms certifies those surfaces clean.
    const { pool } = makePool({ counts: { 'FROM users WHERE organization_id IS NULL': 2 } });
    const r = await auditOrgBoundary(pool);
    const js = r.simulation.would_hide.find((x) => /JAVASCRIPT/.test(x.arm));
    expect(js.rows).toBe(2);
    expect(js.note).toMatch(/No SQL-level tightening can reach it/);
  });
});

describe('attachments is measured on its ladder, not on its own column', () => {
  test('four rungs, and only the fourth is un-derivable', async () => {
    const { pool } = makePool({});
    const r = await auditOrgBoundary(pool);
    expect(Object.keys(r.attachments)).toEqual(expect.arrayContaining([
      'rung1_parent_stamped', 'rung1_parent_null', 'rung2_own_stamp',
      'rung3_uploader', 'rung4_nothing',
    ]));
    expect(r.attachments.note).toMatch(/PARENT-anchored/);
    expect(r.attachments.note).toMatch(/rung4_nothing is the only un-derivable population/);
  });

  test('the ladder mirrors the real one in attachment-org-scope', () => {
    const SCOPE = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'attachment-org-scope.js'), 'utf8');
    // Rung order: parent -> own stamp -> uploader -> allow.
    expect(SCOPE.indexOf('entityOrgVerdict(runner, att.entity_type'))
      .toBeLessThan(SCOPE.indexOf('att.organization_id != null'));
    expect(SCOPE.indexOf('att.organization_id != null'))
      .toBeLessThan(SCOPE.indexOf('att.uploaded_by != null'));
  });
});

describe('the endpoint', () => {
  test('is SYSTEM_ADMIN and read-only, like every other route in this file', () => {
    expect(CONSOLE_SRC).toMatch(
      /router\.get\('\/org-boundary', requireAuth, requireSystemAdmin/);
    // No mutating verb was added to the platform console alongside it.
    expect(CONSOLE_SRC.match(/router\.(post|put|delete|patch)\(/g)).toBeNull();
  });

  test('it is not on the boot path — that is the whole reason it can be complete', () => {
    // db.js excluded attachments/ai_messages/messages from the boot audit
    // because it runs twice per boot, before listen(), inside the Railway swap
    // window. Off that path the same query has no deploy-window risk.
    expect(DB_SRC).not.toMatch(/auditOrgBoundary/);
    const INDEX = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    expect(INDEX).not.toMatch(/auditOrgBoundary/);
  });
});

describe('the classification is checkable, not merely written down', () => {
  test('every class a table can be given is one of the five', () => {
    for (const t of classification.DIRECT) expect(classification.classify(t)).toBe('direct');
    for (const t of Object.keys(classification.PARENT)) expect(classification.classify(t)).toBe('parent');
    for (const t of Object.keys(classification.PLATFORM)) expect(classification.classify(t)).toBe('platform');
    for (const t of classification.SHARED) expect(classification.classify(t)).toBe('shared');
    for (const t of classification.MIXED_SHARED) expect(classification.classify(t)).toBe('mixed_shared');
    expect(classification.classify('no_such_table_anywhere')).toBe('unclassified');
  });

  test('shared wins over every other class — a shared table can never be "fixed"', () => {
    // Ordering matters: assembly_trades/systems/variants were listed in the
    // design as Bucket B (unmeasured, tighten later) AND Bucket C (never
    // tighten) at the same time. Whichever list wins must be the safe one.
    for (const t of classification.SHARED) {
      expect(classification.DIRECT.indexOf(t)).toBe(-1);
      expect(classification.classify(t)).toBe('shared');
    }
  });

  test('every platform table records WHY it has no tenant', () => {
    for (const k of Object.keys(classification.PLATFORM)) {
      expect(typeof classification.PLATFORM[k]).toBe('string');
      expect(classification.PLATFORM[k].length).toBeGreaterThan(40);
    }
    expect(classification.PLATFORM.agent_skills_versions)
      .toMatch(/CHILD CANNOT CARRY A TENANT ITS PARENT DOES NOT HAVE/);
  });
});
