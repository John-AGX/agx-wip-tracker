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
//   2. Every UPDATE / DELETE on `estimates`, `invoices` or `payments` —
//      the money tables this wave found holes in — carries an organization_id
//      predicate, or is named below with a reason.
//   3. Every UPDATE / DELETE on the MONEY SPINE (change orders, purchase
//      orders, vendor bills, pay applications) that does NOT carry a predicate
//      has the org-scoped read it leans on within reach above it. See the long
//      note over MONEY_SPINE below for why the bar is different there.
//
// WHY `payments` JOINED THE LIST IN 2. It is a money table, and its two
// statements — `PUT /payments/:id` and `DELETE /payments/:id` — were bare
// `WHERE id = $1` with an org-scoped SELECT above them as the entire guard.
// They refused a cross-tenant caller when attacked, and they are one edit away
// from the exact shape that started this wave: the estimates upsert was also
// "guarded" by a read, right up until a branch was added that reached the
// write without going through it. Both statements now carry the predicate, so
// adding the table here costs nothing and locks in what was just fixed.
//
// WHY THE LIST STOPS THERE. `job_change_orders`, `job_purchase_orders`,
// `job_vendor_bills` and `pay_applications` are money tables too, and 26 of
// their 26 UPDATE/DELETE statements are unpredicated. Adding them to
// INVARIANT 2 would mean either 26 rewrites on a live pilot in one commit, or
// 26 allowlist entries — and an allowlist entry is a claim that someone read
// the guard, so 26 unread entries would turn this file into decoration.
// INVARIANT 3 holds them at the bar they can actually meet today.
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

  // A browser push endpoint IS the row's identity, and a shared device whose
  // user changes MUST re-point the row — that part was always correct. What
  // the entry used to rest on was "endpoints are high-entropy and the app
  // never exposes them", which is an argument about how hard the row is to
  // FIND, not about what happens once someone has it. Executed: a user who
  // knew another user's endpoint POSTed it with their own keys and took the
  // row over, 200, victim silently unsubscribed. The DO UPDATE arm now
  // carries a WHERE requiring either the same user or a matching key pair, so
  // the re-point costs possession of the device rather than knowledge of a
  // string, and a refusal answers 409 instead of a 200 that wrote nothing.
  // Still exempt from the ORG invariant because the table has no
  // organization_id to predicate on — the risk here is cross-USER, and it is
  // held behaviourally in test/push-subscription-takeover.test.js.
  'server/routes/push-routes.js::push_subscriptions':
    'No organization_id column exists (not tenant data). The endpoint is the row identity; re-pointing is required for shared devices and is now gated on the caller presenting the subscription keys, so knowing an endpoint is not enough. See push-subscription-takeover.test.js.',

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

// The tables INVARIANT 2 governs. Each one is a table where a cross-tenant
// write MOVES MONEY, and each is at zero unpredicated statements today, which
// is what makes the bar affordable.
const MONEY_TABLES = ['estimates', 'invoices', 'payments'];

// ── INVARIANT 3's population ───────────────────────────────────────────────
// The rest of the money spine. These carry contract dollars (change orders,
// purchase orders, vendor bills, AIA draws) and every one of their
// UPDATE/DELETE statements today is a bare `WHERE id = $1` sitting under an
// org-scoped SELECT in the same handler. Attacked, they refuse — the read is a
// real guard. What they lack is a guard that survives the read being MOVED,
// and that is not a hypothetical: `PUT /api/estimates/bulk/save` had exactly
// this arrangement, and the hole opened when a branch was added that reached
// the upsert without passing the read.
//
// Requiring a predicate here means rewriting 26 money statements in one commit
// on a pilot with real money in it. Requiring the TWO-LAYER PATTERN instead
// costs nothing today (all 26 already satisfy it, the furthest guard being 84
// lines up) and fails the moment someone deletes the read — which is the
// failure this whole wave is about.
//
// WHAT THIS CANNOT DO, stated plainly because a check that is trusted for more
// than it proves is worse than no check. It is PROXIMITY, not dataflow. It
// cannot tell that the guard reads the same id the write uses, cannot tell
// that the guard's result is actually branched on, and cannot see a guard that
// lives in a helper called from an outer function. It is strictly weaker than
// a predicate on the statement, and weaker again than Postgres row-level
// security. It is worth having for one reason: the estimates hole would have
// been caught by it on the day the unguarded branch was added.
const MONEY_SPINE = [
  'job_change_orders', 'job_purchase_orders', 'job_vendor_bills', 'pay_applications',
];

// How far above an unpredicated write the org-scoped read may sit. 120 lines
// is chosen from the measured worst case (change-order-routes.js:434, 84 lines
// below its guard) with room for a handler to grow, not from taste. Widening
// it later weakens the check; that should take an argument.
const TWO_LAYER_WINDOW = 120;

// AND THE SEARCH STOPS AT THE ENCLOSING HANDLER. This is not a detail, it is
// what makes the check mean anything: route files stack handlers a few dozen
// lines apart, so a bare line-distance window finds the PREVIOUS handler's
// org guard and pronounces the current one safe. Measured, not reasoned —
// the first version of this invariant used distance alone, the org-scoped
// read above `DELETE FROM pay_applications WHERE id = $1` was deleted as a
// refactor would delete it, and all 13 tests still passed. It was reading
// `req.user.organization_id` out of the /status handler 30 lines further up.
// A guard belonging to a different request is not a second layer.
//
// Anchored at indentation 0-2, because that is where a handler or a top-level
// function begins and a statement inside one never does. Without the anchor
// the pattern matches ordinary code — `const nodes = ((graph.rows[0]…` in the
// CO link-node handler was read as the start of a new function and cut the
// search off two lines above the write, reporting a guard that is sitting
// right there at line 757 as missing. Both directions of that mistake are
// silent, so the anchor is load-bearing in both.
const HANDLER_START =
  /^\s{0,2}(?:router\.(?:get|post|put|patch|delete|use)\s*\(|(?:async\s+)?function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*async\s*(?:function\b|\()|module\.exports)/;

// Tokens that count as "an org-scoped guard happened here". `organization_id`
// covers the inline SELECTs; the named helpers cover the routes that factor
// the check out (subInOrg, ownedJob, jobInOrg…). `orgId` covers the service
// layer, which receives an already-resolved tenant rather than a req.
const TWO_LAYER_GUARD = /organization_id|orgPred|orgScope|InOrg|ownedJob|\borgId\b/;

const TWO_LAYER_EXEMPT = {
  'server/db.js':
    'Boot migrations and one-time backfills — no caller, no tenant to scope to. Same reason as EST_INV_EXEMPT above.',
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
  const spine = [];
  const moneyRe = new RegExp(
    '\\b(?:UPDATE\\s+(' + MONEY_TABLES.join('|') + ')\\b|DELETE\\s+FROM\\s+(' +
    MONEY_TABLES.join('|') + ')\\b)', 'i');
  const spineRe = new RegExp(
    '\\b(?:UPDATE\\s+(' + MONEY_SPINE.join('|') + ')\\b|DELETE\\s+FROM\\s+(' +
    MONEY_SPINE.join('|') + ')\\b)', 'i');
  for (const f of walk(SERVER, [])) {
    const text = fs.readFileSync(f, 'utf8');
    const srcLines = text.split(/\r?\n/);
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
      // The predicate can live in this literal, in the source concatenated
      // straight after it ('… WHERE ' + orgPred(x)), or in an interpolation.
      const predicated =
        /organization_id/i.test(lit.sql) ||
        /organization_id|orgPred|orgScope|InOrg/i.test(lit.trailing || '') ||
        /\$\{[^}]*[Oo]rg[^}]*\}/.test(lit.raw || '');

      const w = moneyRe.exec(lit.sql);
      if (w) {
        const table = (w[1] || w[2]).toLowerCase();
        estInv.push({ file: r, line: lit.line, table, predicated,
          sql: lit.sql.replace(/\s+/g, ' ').trim().slice(0, 180) });
      }

      const s = spineRe.exec(lit.sql);
      if (s) {
        const table = (s[1] || s[2]).toLowerCase();
        // Walk BACK from the statement looking for the org-scoped read it
        // leans on. `lit.line` is 1-based, so the statement's own line is
        // index lit.line - 1; start one line above it so the statement's own
        // parameter list cannot vouch for itself. Stop at the top of the
        // enclosing handler — see HANDLER_START.
        let guardAt = null, stoppedAt = null;
        for (let k = lit.line - 2; k >= 0 && k >= lit.line - 2 - TWO_LAYER_WINDOW; k--) {
          if (TWO_LAYER_GUARD.test(srcLines[k])) { guardAt = k + 1; break; }
          if (HANDLER_START.test(srcLines[k])) { stoppedAt = k + 1; break; }
        }
        spine.push({ file: r, line: lit.line, table, predicated, guardAt, stoppedAt,
          sql: lit.sql.replace(/\s+/g, ' ').trim().slice(0, 180) });
      }
    });
  }
  return { upserts, estInv, spine };
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

  test('it finds the estimates / invoices / payments writes', () => {
    expect(found.estInv.length).toBeGreaterThanOrEqual(20);
  });

  test('it finds a write on every money table it claims to govern', () => {
    // A table whose name stops matching — renamed, or the statement moved to
    // a builder this tokenizer cannot see — must fail LOUDLY. Silently
    // governing zero statements is the way this invariant would rot without
    // ever going red.
    const seen = new Set(found.estInv.map((e) => e.table));
    expect(MONEY_TABLES.filter((t) => !seen.has(t))).toEqual([]);
    const spineSeen = new Set(found.spine.map((e) => e.table));
    expect(MONEY_SPINE.filter((t) => !spineSeen.has(t))).toEqual([]);
  });

  test('it finds the money-spine writes INVARIANT 3 is built on', () => {
    // Measured at 26 unpredicated of 26 across the four spine tables when this
    // was written. The floor is on the POPULATION, not on the failures.
    expect(found.spine.length).toBeGreaterThanOrEqual(26);
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

describe('INVARIANT 2 — every estimates / invoices / payments write names its tenant', () => {
  test('no UPDATE or DELETE on a money table is unpredicated', () => {
    const violations = found.estInv
      .filter((e) => !e.predicated && !EST_INV_EXEMPT[e.file])
      .map((e) => e.file + ':' + e.line + ' → ' + e.sql);
    expect(violations).toEqual([]);
  });

  test('the payments statements specifically carry it', () => {
    // Named, because these are the two that were bare `WHERE id = $1` with the
    // org-scoped SELECT above them as the whole guard — the same one-JS-line-
    // deep arrangement the estimates upsert had. A regression here reads as a
    // generic list entry otherwise.
    const pay = found.estInv.filter((e) => e.table === 'payments');
    expect(pay.length).toBeGreaterThanOrEqual(2);
    expect(pay.filter((e) => !e.predicated)).toEqual([]);
  });
});

describe('INVARIANT 3 — an unpredicated money-spine write keeps its second layer', () => {
  // Not "these statements are safe". The claim is narrower and it is the claim
  // that can actually be held today: each of these writes leans on an
  // org-scoped read, and that read is still there. Delete the read and this
  // goes red — which is the one thing that did NOT happen when the estimates
  // upsert lost its guard.
  test('every unpredicated spine write has an org-scoped read within reach above it', () => {
    const violations = found.spine
      .filter((e) => !e.predicated && !e.guardAt && !TWO_LAYER_EXEMPT[e.file])
      .map((e) => e.file + ':' + e.line + ' → ' + e.table + ' — no org-scoped read within ' +
                  TWO_LAYER_WINDOW + ' lines above; add the predicate to the statement');
    expect(violations).toEqual([]);
  });

  test('the sites the sweep named by hand are all in the population', () => {
    // The audit that produced this invariant listed these by file:line. If a
    // refactor moves one out of the tokenizer's view, the invariant would go
    // green by seeing less — so the named sites are pinned to their table
    // rather than to their line, which survives edits above them.
    const byTable = {};
    found.spine.forEach((e) => { (byTable[e.table] = byTable[e.table] || []).push(e.file); });
    expect(new Set(byTable.job_change_orders)).toContain('server/routes/change-order-routes.js');
    expect(new Set(byTable.job_change_orders)).toContain('server/services/job-financials.js');
    expect(new Set(byTable.job_purchase_orders)).toContain('server/routes/purchase-order-routes.js');
    expect(new Set(byTable.job_purchase_orders)).toContain('server/services/job-financials.js');
    expect(new Set(byTable.job_vendor_bills)).toContain('server/routes/bill-routes.js');
    expect(new Set(byTable.pay_applications)).toContain('server/routes/pay-application-routes.js');
  });
});
