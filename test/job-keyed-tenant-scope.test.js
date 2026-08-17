// One rule, stated on the KEY rather than on the table.
//
// WHAT THIS FILE EXISTS FOR
// The survey that produced the tenant fixes on `jobs` counted STATEMENTS THAT
// NAME `jobs`. Every door below is keyed on job_id in a CHILD table, so none of
// them appeared in that count — and that is where the unfixed copies of the
// same defect lived. Adding a predicate to a `jobs` statement fixes none of
// them, because these statements never name `jobs` at all.
//
// So the property under test is not "route X answers 403". It is:
//
//   every statement reachable by a caller-supplied job_id proves the PARENT
//   JOB is in the caller's org before it reads or writes.
//
// The QB cost routes are the sharp end: six of seven endpoints were entirely
// unscoped, on contract cost. bulk-assign deserves its own mention — it
// re-attributes ACTUAL COSTS across buildings and cost buckets, 1000 rows per
// call, and it changes no amount, so "money is out of scope" does not catch it
// while it still moves money between line items in another tenant's rollups.

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const QB = read('server', 'routes', 'qb-cost-routes.js');
const SCHED = read('server', 'routes', 'schedule-routes.js');
const ORG_ACCESS = read('server', 'org-access.js');
const DISPATCH = read('server', 'services', 'payload-dispatcher.js');
const SCOPE = read('server', 'services', 'job-org-scope.js');

// ── the shared predicate ────────────────────────────────────────────────────
describe('the predicate itself', () => {
  const { parentJobInOrgSql } = require('../server/services/job-org-scope');

  test('it names the parent job and the caller org, and nothing else', () => {
    const sql = parentJobInOrgSql('qb_cost_lines.job_id', '$3');
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM jobs/);
    expect(sql).toMatch(/j_org_scope\.id = qb_cost_lines\.job_id/);
    expect(sql).toMatch(/j_org_scope\.organization_id = \$3/);
  });

  test('it keeps the legacy tolerance arm — dropping it is a different change', () => {
    // ~295 sites carry `OR organization_id IS NULL`, and removing it while
    // un-stamped rows exist locks AGX out of its own cost data. That removal is
    // gated on the stamp audit reading zero, not on this slice.
    expect(parentJobInOrgSql('x.job_id', '$1')).toMatch(/j_org_scope\.organization_id IS NULL/);
  });

  test('the org is the caller\'s, never the row\'s own claim about itself', () => {
    expect(SCOPE).not.toMatch(/req\.body/);
  });

  test('an unknown or foreign job id is simply absent from the answer', async () => {
    const { jobIdsInOrg } = require('../server/services/job-org-scope');
    const runner = {
      query: async (sql, params) => {
        expect(sql).toMatch(/organization_id = \$2 OR organization_id IS NULL/);
        expect(params[1]).toBe(7);
        return { rows: [{ id: 'jobA' }] };     // jobB is org B's; not returned
      }
    };
    const got = await jobIdsInOrg(runner, ['jobA', 'jobB'], 7);
    expect([...got]).toEqual(['jobA']);
    expect(got.has('jobB')).toBe(false);
  });
});

// ── qb-cost-routes: six endpoints, all on contract cost ─────────────────────
describe('QB cost lines cannot be reached across tenants', () => {
  const route = (name) => {
    const i = QB.indexOf(name);
    expect(i).toBeGreaterThan(-1);
    return QB.slice(i, QB.indexOf('\r\n);', i) + 4);
  };

  test('POST /import cannot inject cost lines onto another tenant\'s jobs', () => {
    const r = route("router.post('/import'");
    expect(r).toMatch(/jobIdsInOrg\(pool, wanted, req\.orgId\)/);
    // the unscoped gate is gone
    expect(QB).not.toMatch(/SELECT id FROM jobs WHERE id = ANY\(\$1::text\[\]\)'/);
  });

  test('PATCH /:id cannot write — or read back — another tenant\'s line', () => {
    // RETURNING * hands back vendor, amount, account and memo, so the unscoped
    // form was a cross-tenant read as well as a cross-tenant write.
    const r = route("router.patch('/:id'");
    expect(r).toMatch(/parentJobInOrgSql\('qb_cost_lines\.job_id'/);
    expect(r).toMatch(/RETURNING \*/);
  });

  test('bulk-link cannot re-point another tenant\'s lines', () => {
    expect(route("router.post('/bulk-link'")).toMatch(/parentJobInOrgSql\('qb_cost_lines\.job_id'/);
  });

  test('bulk-assign cannot re-attribute another tenant\'s actual costs', () => {
    expect(route("router.post('/bulk-assign'")).toMatch(/parentJobInOrgSql\('qb_cost_lines\.job_id'/);
  });

  test('cleanup-orphans cannot wipe links on a foreign job id', () => {
    expect(route("router.post('/cleanup-orphans'")).toMatch(/parentJobInOrgSql\('qb_cost_lines\.job_id'/);
  });

  test('DELETE /:id cannot destroy another tenant\'s cost row', () => {
    expect(route("router.delete('/:id'")).toMatch(/parentJobInOrgSql\('qb_cost_lines\.job_id'/);
  });

  test('every write door refuses before it writes when it has no tenant', () => {
    const mounts = QB.split(/\r?\n/).filter((l) => /requireCapability\('JOBS_EDIT_ANY'\)/.test(l));
    expect(mounts.length).toBe(6);
    for (const m of mounts) expect(m).toMatch(/requireOrgId/);
  });

  test('the read moved off the owner join onto the canonical column', () => {
    // There were THREE scoping mechanisms live on this table family: the column
    // (job-routes, assertTargetOrg), the owner join (org-access, this read),
    // and nothing at all (every write above). The column is canonical.
    const r = route("router.get('/'");
    expect(r).toMatch(/j\.organization_id = \$2 OR j\.organization_id IS NULL/);
    expect(r).not.toMatch(/LEFT JOIN users u ON u\.id = j\.owner_id/);
  });

  test('a cost line is stamped from its parent job, not from the caller', () => {
    const upsert = QB.slice(QB.indexOf('const UPSERT_LINE_SQL'));
    expect(upsert.slice(0, 900)).toMatch(/organization_id/);
    expect(upsert.slice(0, 900)).toMatch(/\(SELECT organization_id FROM jobs WHERE id = \$2\)/);
    // and a re-import is not a tenant move
    const doUpdate = upsert.slice(upsert.indexOf('DO UPDATE'), upsert.indexOf('DO UPDATE') + 700);
    expect(doUpdate.split(/WHERE/i)[0]).not.toMatch(/organization_id/);
  });
});

// ── schedule-routes: a create door, and the blob it emails ──────────────────
describe('a schedule entry cannot be hung on a foreign job', () => {
  test('the create door proves the parent job, not merely that it exists', () => {
    const post = SCHED.slice(SCHED.indexOf("router.post('/'"));
    const head = post.slice(0, post.indexOf('INSERT INTO schedule_entries'));
    expect(head).toMatch(/jobInOrg\(pool, v\.jobId, req\.orgId\)/);
    expect(head).toMatch(/job not found/);          // indistinguishable from absent
    expect(SCHED).not.toMatch(/'SELECT id FROM jobs WHERE id = \$1', \[v\.jobId\]/);
  });

  test('the notify reads the job under the tenant predicate before mailing it', () => {
    // This is not a title leak. scheduleAssigned() receives the whole job blob
    // and sendEmail puts it off-platform.
    const fn = SCHED.slice(SCHED.indexOf('async function notifyScheduleCrew'));
    const body = fn.slice(0, fn.search(/\r?\n\}\r?\n/));
    expect(body).toMatch(/orgId/);
    expect(body).toMatch(/organization_id = \$2 OR organization_id IS NULL/);
    expect(body).not.toMatch(/'SELECT id, data FROM jobs WHERE id = \$1'/);
  });

  test('both notify call sites pass a tenant', () => {
    // `function notifyScheduleCrew({` is the declaration, not a call site.
    const calls = SCHED.split(/(?<!function )notifyScheduleCrew\(\{/).slice(1);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c.slice(0, 300)).toMatch(/orgId:/);
  });

  test('the entry is stamped from its parent job at insert', () => {
    const ins = SCHED.slice(SCHED.indexOf('INSERT INTO schedule_entries'));
    expect(ins.slice(0, 400)).toMatch(/organization_id/);
    expect(ins.slice(0, 400)).toMatch(/\(SELECT organization_id FROM jobs WHERE id = \$2\)/);
  });
});

// ── org-access: an arm that let everything through ──────────────────────────
describe('the schedule_entry gate no longer has an unconditional open arm', () => {
  const clause = ORG_ACCESS.slice(ORG_ACCESS.indexOf("case 'schedule_entry':"),
    ORG_ACCESS.indexOf("case 'project':"));

  test('`OR s.job_id IS NULL` on its own is gone', () => {
    // It named neither the caller nor the caller's org, so EVERY standalone
    // schedule entry in EVERY tenant passed for everybody — and this gates PUT
    // and DELETE on schedule-routes.
    expect(clause).not.toMatch(/OR s\.job_id IS NULL\s*\r?\n\s*\)/);
  });

  test('the two arms are disjoint, so the LEFT JOIN cannot re-open it', () => {
    // A job-less entry makes j.organization_id NULL; without the disjunction
    // the tolerance arm would pass it unconditionally all over again.
    expect(clause).toMatch(/s\.job_id IS NOT NULL AND/);
    expect(clause).toMatch(/s\.job_id IS NULL AND/);
  });

  test('a job-linked entry scopes through the JOB COLUMN, the canonical pointer', () => {
    expect(clause).toMatch(/j\.organization_id = \$2/);
    expect(clause).not.toMatch(/uj\.organization_id/);
  });

  // The predicate, re-implemented, over the rows that matter.
  const passes = (row, callerOrg) => {
    if (row.job_id != null) {
      return row.job_org === callerOrg || row.job_org === null;
    }
    return row.entry_org === callerOrg || row.entry_org == null ||
           row.creator_org === callerOrg || row.creator_org == null;
  };

  test('another tenant\'s job-linked entry is refused', () => {
    expect(passes({ job_id: 'jobB', job_org: 9 }, 7)).toBe(false);
  });

  test('a standalone entry stamped to another tenant is refused — it used to pass', () => {
    expect(passes({ job_id: null, entry_org: 9, creator_org: 9 }, 7)).toBe(false);
  });

  test('AGX\'s own rows still pass, stamped or legacy', () => {
    expect(passes({ job_id: 'jobA', job_org: 7 }, 7)).toBe(true);
    expect(passes({ job_id: 'jobLegacy', job_org: null }, 7)).toBe(true);
    expect(passes({ job_id: null, entry_org: 7, creator_org: 7 }, 7)).toBe(true);
    expect(passes({ job_id: null, entry_org: null, creator_org: null }, 7)).toBe(true);
  });
});

// ── the agent write path ────────────────────────────────────────────────────
describe('the agent job-blob writes carry the predicate too', () => {
  test('assertTargetOrg fails CLOSED on a null org', () => {
    // It opened with `if (!orgId || …) return;` — a fail-OPEN guard sitting
    // underneath two fail-closed ones. Not reachable today (both apply doors
    // refuse without an org first), but agent contexts resolve their org
    // through _cdOrgId / ctx.orgId and several can be null by construction,
    // which is exactly the input it opened on.
    const fn = DISPATCH.slice(DISPATCH.indexOf('async function assertTargetOrg'));
    const body = fn.slice(0, fn.search(/\r?\n\}\r?\n/));
    expect(body).not.toMatch(/if \(!orgId \|\| !entityId/);
    expect(body).toMatch(/if \(!orgId\) throw/);
  });

  test('dispatchJob reads and writes the blob under the predicate', () => {
    const fn = DISPATCH.slice(DISPATCH.indexOf('await assertTargetOrg(dbClient, \'job\', id'));
    const seg = fn.slice(0, fn.indexOf('return {'));
    expect(seg).toMatch(/SELECT data FROM jobs WHERE id = \$1\s*\r?\n\s*AND \(organization_id = \$2 OR organization_id IS NULL\)/);
    expect(seg).toMatch(/UPDATE jobs SET data = \$1[\s\S]{0,120}AND \(organization_id = \$3 OR organization_id IS NULL\)/);
    expect(seg).toMatch(/if \(!wrote\.rowCount\) throw/);
  });

  test('link_job_to_client does too', () => {
    const i = DISPATCH.indexOf("updated.push({ kind: 'job_client_link'");
    const seg = DISPATCH.slice(i - 1400, i);
    expect(seg).toMatch(/SELECT data FROM jobs WHERE id = \$1[\s\S]{0,140}organization_id IS NULL/);
    expect(seg).toMatch(/UPDATE jobs SET data = \$1[\s\S]{0,160}organization_id IS NULL/);
    expect(seg).toMatch(/if \(!lw\.rowCount\) throw/);
  });

  test('no unpredicated wholesale job-blob write is left in the dispatcher', () => {
    expect(DISPATCH).not.toMatch(
      /UPDATE jobs SET data = \$1, updated_at = NOW\(\) WHERE id = \$2['`]/);
  });
});
