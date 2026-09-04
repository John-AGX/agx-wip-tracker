// The tenant predicate is an INVARIANT OF THE STATEMENT, not a habit of the
// author.
//
// WHY THIS FILE EXISTS
// `PUT /api/estimates/bulk/save` overwrote another tenant's estimate through
// an `INSERT … ON CONFLICT (id) DO UPDATE` whose DO UPDATE arm had no
// predicate. Commit aebad8a8 had already found, diagnosed and fixed that exact
// defect on the jobs twin — including writing the reason into the code — and
// the estimates copy, whose own header says it "Mirrors /api/jobs/bulk/save",
// was left behind for four months. It survived a green 146-suite run and it
// survived the survey that produced aebad8a8.
//
// It survived the survey for a reason worth stating, because it is the reason
// this file is shaped the way it is: the vulnerable statement NAMES
// organization_id (on the INSERT arm's column list) while PREDICATING on
// nothing. Any check of the form "does this statement mention organization_id"
// answers TRUE on it. So the arms are split, and the DO UPDATE arm's own WHERE
// is what gets read.
//
// WHAT IT ASSERTS
//   1. Every `ON CONFLICT … DO UPDATE` on a table that has a tenant must
//      either be keyed on that tenant (organization_id / user_id in the
//      conflict target, so a cross-tenant match is impossible by
//      construction), or carry an organization_id predicate on the DO UPDATE
//      arm, or be named below with a reason.
//   2. Every UPDATE / DELETE on `estimates` or `invoices` — the two tables
//      this wave found holes in — carries an organization_id predicate, or is
//      named below with a reason.
//
// WHAT IT DOES NOT ASSERT. It reads SQL text; it cannot know whether an
// upstream JS guard is correct, only whether the statement defends itself. A
// site on the allowlist is a site whose guard was READ, and the reason is the
// reading. That is weaker than Postgres row-level security, which would make
// the predicate unwritable-around because it would not be in the query at all
// — and it is what the tolerance arm (`OR organization_id IS NULL`, load-
// bearing until the un-stamped count reaches zero) and a shared, tenant-less
// connection pool make too large a change to land on a live pilot in the same
// week as the fix. This is the affordable half: it fails at commit time
// instead of at incident time, and it would have caught the estimates bug on
// the day aebad8a8 shipped.

'use strict';

const fs = require('fs');
const path = require('path');
const { extractSqlLiterals } = require('./helpers/sql-literals');
const { classify } = require('../server/services/org-table-classification');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server');

// ── the reviewed allowlist ────────────────────────────────────────────────
// One entry per statement, keyed `<repo-relative file>::<table>`, and the
// value is WHY. An entry is a claim that someone read the guard. Adding one
// without reading is how this list stops being worth anything.
const UPSERT_EXEMPT = {
  // Boot / bootstrap. No request reaches these; there is no caller to scope to.
  'server/db.js::users':
    'Boot bootstrap of the first admin (db.js init). Keyed on email, runs before any request exists.',

  // Parent-scoped, with the parent proved in-org BEFORE the write, and
  // organization_id read off the PARENT ROW inside the INSERT (unforgeable).
  'server/routes/sub-routes.js::sub_certificates':
    'subInOrg(req.params.subId, req.orgId) refuses first; the INSERT reads organization_id from the parent sub row, not from the caller.',
  'server/routes/sub-routes.js::job_subs':
    'Jobs are filtered through the org-scoped allowedJobIds set and the sub comes from an org-scoped subs lookup; organization_id is a sub-select off the parent job. The DO UPDATE arm is additive (contract_amt + EXCLUDED), never a replace.',
  'server/routes/sub-routes.js::attachment_folder_grants':
    'BOTH ends are checked: subInOrg on the sub and grantEntityInOrg / jobInOrg on the entity. The table has no organization_id column of its own (classified parent, via subs).',
  'server/routes/purchase-order-routes.js::attachment_folder_grants':
    'subInOrg refuses before the write and the job is derived from an already-org-checked PO. Same tenant-less table as above.',
  'server/routes/qb-cost-routes.js::qb_cost_lines':
    'The conflict key IS tenant-derived: id = sha256(job_id‖…) from util/qb-line-id.js, and job ids are filtered through jobIdsInOrg first, so a cross-tenant key cannot be formed.',
  'server/routes/lead-routes.js::lead_graphs':
    'Table has no organization_id. The parent lead is org-checked immediately above the write and 404s.',
  'server/routes/job-routes.js::job_access':
    'Table has no organization_id. canManageAccess was made org-first by aebad8a8.',

  // Derived / recomputed rows keyed on something the caller cannot forge into
  // another tenant, with the org COALESCEd so it is never moved.
  'server/services/deal-memory.js::deal_memory':
    'Key is the resolved lineage root, not a caller id; organization_id is COALESCE(existing, new) so a refresh can never move a deal between tenants; the payload is recomputed from the deal\'s own rows.',

  // Keyed on the CALLER'S OWN user_id — a cross-tenant write can only reach
  // the attacker's own row.
  'server/routes/field-tools-routes.js::field_tool_drafts':
    'Keyed on the caller\'s own user_id; the worst case is overwriting your own draft.',

  // A browser push endpoint IS the row's identity. A shared device whose user
  // changes MUST re-point the row, so re-assignment is the correct behaviour,
  // not a defect. Endpoints are high-entropy and the app never exposes them.
  'server/routes/push-routes.js::push_subscriptions':
    'The push endpoint URL is the row identity; re-pointing it at the current user is required for shared devices. Not tenant data.',

  // Platform stores behind SYSTEM_ADMIN. A child cannot carry a tenant its
  // parent does not have (app_settings has none).
  'server/routes/admin-agents-routes.js::managed_agent_skills':
    'Platform skill store behind SYSTEM_ADMIN; no tenant exists to stamp (see PLATFORM in org-table-classification.js).',
};

const EST_INV_EXEMPT = {
  'server/db.js':
    'Boot migrations and one-time backfills. They run at init with no caller and no tenant to scope to; org-boundary-audit.js is what watches their results.',
  'server/services/markets.js':
    'Market backfill. market_id is the OPERATING dimension, never the tenant; the statement only fills NULLs and joins estimates to their own job / lead.',
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function rel(p) { return path.relative(REPO, p).replace(/\\/g, '/'); }

// A statement split across concatenated string literals ('INSERT INTO x … ' +
// 'ON CONFLICT …') arrives here as two entries. Join a literal to the one
// before it when they are within a few lines, so the table name is not lost —
// a lost table name is an UNCHECKED statement, and unchecked must never read
// as absent.
function joined(lits, i) {
  let sql = lits[i].sql;
  let raw = lits[i].raw;
  for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
    if (lits[i].line - lits[k].line > 3) break;
    sql = lits[k].sql + ' ' + sql;
    raw = lits[k].raw + ' ' + raw;
    if (/INSERT\s+INTO\s+[a-z_]/i.test(lits[k].sql)) break;
  }
  return { sql, raw };
}

function collect() {
  const upserts = [];
  const estInv = [];
  for (const f of walk(SERVER, [])) {
    const text = fs.readFileSync(f, 'utf8');
    const r = rel(f);
    const lits = extractSqlLiterals(text);
    lits.forEach((lit, i) => {
      const j = joined(lits, i);
      const conflict = /ON\s+CONFLICT\s*(?:\(([^)]*)\)|ON\s+CONSTRAINT\s+\w+)?\s*DO\s+UPDATE/i.exec(j.sql);
      if (conflict) {
        const ins = /INSERT\s+INTO\s+([a-z_][a-z_0-9]*)/i.exec(j.sql);
        const table = ins ? ins[1] : null;
        const target = (conflict[1] || '').toLowerCase();
        const arm = j.sql.slice(j.sql.search(/DO\s+UPDATE/i));
        upserts.push({
          file: r, line: lit.line, table,
          keyQualified: /organization_id|user_id/.test(target),
          armPredicated: /\bWHERE\b[\s\S]*organization_id/i.test(arm)
        });
      }
      const w = /\b(?:UPDATE\s+(estimates|invoices)\b|DELETE\s+FROM\s+(estimates|invoices)\b)/i.exec(lit.sql);
      if (w) {
        const table = (w[1] || w[2]).toLowerCase();
        // The predicate can live in this literal, in the source concatenated
        // straight after it ('… WHERE ' + orgPred(x)), or in an interpolation.
        const predicated =
          /organization_id/i.test(lit.sql) ||
          /organization_id|orgPred|orgScope|InOrg/i.test(lit.trailing || '') ||
          /\$\{[^}]*[Oo]rg[^}]*\}/.test(lit.raw || '');
        estInv.push({ file: r, line: lit.line, table, predicated,
          sql: lit.sql.replace(/\s+/g, ' ').trim().slice(0, 180) });
      }
    });
  }
  return { upserts, estInv };
}

const found = collect();

describe('the scan itself is honest before anything is asserted with it', () => {
  // A scanner that silently sees less than it should reports green for the
  // wrong reason. The first version of this scan guessed literal boundaries
  // with a lastIndexOf on quote characters and found 23 of 40 upserts — it
  // would have PASSED against the code that had the hole. These two floors are
  // what stop that regressing.
  test('it finds the upserts that are actually in server/', () => {
    expect(found.upserts.length).toBeGreaterThanOrEqual(38);
  });

  test('it resolves a table name for every upsert it finds', () => {
    const unresolved = found.upserts.filter((u) => !u.table)
      .map((u) => u.file + ':' + u.line);
    // An unresolved table is an UNCHECKED statement. It must fail as such
    // rather than fall out of the population and read as compliant.
    expect(unresolved).toEqual([]);
  });

  test('it finds the estimates / invoices writes', () => {
    expect(found.estInv.length).toBeGreaterThanOrEqual(20);
  });

  test('every allowlist entry still corresponds to a real statement', () => {
    // A stale exemption is a hole with a note on it. If a site is fixed or
    // deleted, its entry has to go too, or the next statement at that
    // file+table inherits an exemption nobody granted it.
    const live = new Set(found.upserts.map((u) => u.file + '::' + u.table));
    const stale = Object.keys(UPSERT_EXEMPT).filter((k) => !live.has(k));
    expect(stale).toEqual([]);

    const liveFiles = new Set(found.estInv.map((e) => e.file));
    const staleFiles = Object.keys(EST_INV_EXEMPT).filter((k) => !liveFiles.has(k));
    expect(staleFiles).toEqual([]);
  });
});

describe('INVARIANT 1 — an upsert on a tenant table cannot reach another tenant', () => {
  test('every DO UPDATE arm is tenant-keyed, tenant-predicated, or exempt with a reason', () => {
    const violations = found.upserts.filter((u) => {
      const cls = classify(u.table);
      // shared / mixed_shared / platform have no tenant to predicate on; that
      // is a documented property of those tables, not an omission. Everything
      // else — including `unclassified`, which the classification file itself
      // calls "where the next hole lives" — must answer for itself.
      if (cls === 'shared' || cls === 'mixed_shared' || cls === 'platform') return false;
      if (u.keyQualified || u.armPredicated) return false;
      return !UPSERT_EXEMPT[u.file + '::' + u.table];
    }).map((u) => u.file + ':' + u.line + ' → ' + u.table + ' [' + classify(u.table) + ']');

    expect(violations).toEqual([]);
  });

  // The disagreement branch. This one is asserted on SOURCE and I am labelling
  // it as such: it CANNOT be reached behaviourally, because reaching it means
  // the JS tenant branch and the SQL guard disagree about the same row inside
  // one FOR UPDATE transaction, which is a state Postgres will not produce.
  // A mutation that swaps the throw back for a bare `continue` therefore fails
  // no behavioural test — verified, not assumed. What that `continue` would
  // restore is a SILENT SKIP: no version, no conflict, and a client that
  // re-baselines the row as though it had been written. estimate-routes.js
  // already refuses to do that for the locked case, in a comment, for exactly
  // this reason. So the guard is held here, at the only altitude that can
  // hold it.
  test('a refused DO UPDATE throws — it is never reported as saved', () => {
    const src = fs.readFileSync(path.join(SERVER, 'routes/estimate-routes.js'), 'utf8');
    const jobs = fs.readFileSync(path.join(SERVER, 'routes/job-routes.js'), 'utf8');
    expect(src).toMatch(/passed the tenant branch but the[\s\S]{0,80}DO UPDATE org guard refused it/);
    expect(jobs).toMatch(/passed the tenant branch but the[\s\S]{0,80}DO UPDATE org guard refused it/);
    // And the skip it replaced is gone: no `if (_up.rows[0])` gate on the
    // version write, which is what made the refusal silent.
    expect(src).not.toMatch(/if\s*\(_up\.rows\[0\]\)\s*versions/);
  });

  test('the two bulk saves both carry the predicate on the DO UPDATE arm', () => {
    // Named explicitly, because these are the twins the whole finding is
    // about: jobs was fixed, estimates was not, and nothing tied the two
    // together except a comment saying one mirrors the other.
    const armed = found.upserts.filter((u) => u.armPredicated)
      .map((u) => u.file + '::' + u.table);
    expect(armed).toContain('server/routes/estimate-routes.js::estimates');
    expect(armed).toContain('server/routes/job-routes.js::jobs');
  });
});

describe('INVARIANT 2 — every estimates / invoices write names its tenant', () => {
  test('no UPDATE or DELETE on estimates or invoices is unpredicated', () => {
    const violations = found.estInv
      .filter((e) => !e.predicated && !EST_INV_EXEMPT[e.file])
      .map((e) => e.file + ':' + e.line + ' → ' + e.sql);
    expect(violations).toEqual([]);
  });
});
