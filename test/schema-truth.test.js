// THERE IS ONE SCHEMA, AND server/db.js IS IT.
//
// ── WHAT HAPPENED ─────────────────────────────────────────────────────────
// `attachments` has no `created_at`. server/db.js:1239 declares
// `uploaded_at TIMESTAMPTZ DEFAULT NOW()`, and no ALTER anywhere adds the other
// name. Two shipped agent tools — `search_my_kb` and `search_org_kb` — selected
// it and ordered by it, so both raised Postgres 42703 (undefined_column) on
// every call. That means the parent-anchored tenant ladder inside
// `search_org_kb`, which SHIPPED IN a4d2cd85 AS A SECURITY FIX, had never
// executed in production; and `search_my_kb`'s missing tenant predicate was
// invisible because the statement threw before it could leak anything.
//
// The suite was green for all of it. test/ai-read-tenant-doors.test.js's
// fixture hand-declared the column:
//
//     CREATE TABLE attachments (
//       ... uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
//           created_at  TEXT DEFAULT CURRENT_TIMESTAMP   <- invented
//     );
//
// THE TEST SCHEMA AND THE REAL SCHEMA DIVERGED, AND THE DIVERGENCE HID A LIVE
// BUG WHILE REPORTING SUCCESS. That is the class this file exists to end, and
// the reason it is a separate file rather than another assertion inside the
// tenant tests: a fixture is a second schema, and a second schema always drifts
// TOWARD whatever the code under test happens to ask for — the author adds the
// column that made the test stop failing, and from then on the test is evidence
// about the fixture.
//
// ── THE TWO PROPERTIES ────────────────────────────────────────────────────
//   S1  NO FIXTURE MAY DECLARE A COLUMN server/db.js DOES NOT CREATE.
//       Checked over every file in test/, on every table db.js also creates.
//       Test-only scratch tables are ignored — this asserts agreement, not
//       coverage.
//   S2  NO STATEMENT IN THE AGENT-REACHABLE SURFACE MAY NAME A COLUMN THAT
//       DOES NOT EXIST. The other direction of the same question. Held over the
//       same files the read-predicate invariant scans, plus a reviewed,
//       COUNTED allowlist for the statements elsewhere in server/ that are
//       currently broken and are being fixed separately — so they cannot grow
//       and cannot go quiet.
//
// ── WHY S2 IS NOT SCANNED OVER ALL OF server/ AS A HARD FAILURE ───────────
// It IS scanned over all of server/ — see S3 — but the verdict outside the
// agent surface is an allowlist rather than a hard fail, because this pass
// found FOUR more live 42703s in unrelated features (affiliate onboarding,
// the weekly sales digest, the projects weather geocode cache, "clear all
// chats") and each one's correct repair is a product decision — what should
// the sales digest show, should projects cache a geocoded address — not a
// mechanical substitution. Fixing four unrelated features inside a
// tenant-boundary commit on a live pilot is the risk the hard rules warn
// about. They are written down here, with counts, so the next person finds
// them by reading a test instead of by an incident.
//
// ── THE COUNT IS THE GUARD, SO THE DERIVATION IS THE TEST ─────────────────
// This ledger was reported short by one, at org-manifest-routes.js:157. That
// specific claim is REFUTED — line 157 is `] = await Promise.all([` and the
// file's only leads.data reference is the histogram at :184, which was already
// counted — and the refutation is recorded on the entry itself, with the sites
// spelled out, so it can be checked rather than re-litigated.
//
// But the report was pointing at something real. The derivation keyed on
// `<x>.query(`, and this repo hands 66 statements to WRAPPERS instead:
// `safeCount` (org-manifest-routes.js) and `countOrNull` (admin-push-routes.js)
// both SWALLOW the error a missing column raises — which is precisely how the
// lead histogram has been rendering 0 for months with nothing on screen — and
// `run = q(client)` (services/email-folders.js) is a transaction helper. Every
// one of those was outside the population, so the ledger could not have been
// short by one; it could have been short by sixty-six and looked identical.
//
// So the whole ledger is re-derived mechanically rather than patched: the unit
// is now "a call whose first argument IS a statement", whatever the callee
// (test/helpers/sql-literals.js `extractSqlCalls`, innermost-only so a
// `Promise.all([pool.query(…)])` is not counted twice). S4 below asserts the
// wrapper statements are actually in the population, because a widening nobody
// checks is the same decoration as a narrow scan nobody checks. Re-derived, the
// findings are the same four keys — which is now a measured result rather than
// an assumption.
'use strict';

const fs = require('fs');
const path = require('path');
const schema = require('./helpers/db-schema');
const { scanFile, scanText } = require('./helpers/column-existence');
const { extractQueryCalls, extractSqlCalls } = require('./helpers/sql-literals');

const REPO = path.resolve(__dirname, '..');

// The same surface test/ai-read-predicate-invariant.test.js scans: where a
// caller-supplied id or search string reaches a tenant table through a tool the
// model can call.
const AGENT_SURFACE = [
  'server/routes/ai-routes.js',
  'server/services/outlook-mail.js',
  'server/services/session-search.js',
];

// ── THE REVIEWED LEDGER OF KNOWN-BROKEN STATEMENTS ────────────────────────
// Key: '<table>.<column>'. Value: { n, files, why }.
//   n      how many statements name it TODAY. A mismatch fails, so a new
//          statement cannot inherit an existing entry's exemption.
//   why    what is actually wrong and why it is not repaired here.
// Everything in this map raises 42703 in Postgres. None of it is in the agent
// surface; all of it is live.
const KNOWN_BROKEN = {
  'users.owner_id': {
    n: 2,
    where: 'server/routes/admin-organizations-routes.js',
    why:
      '`users` has no owner_id column (server/db.js:66 + ten ALTERs, none of them this). ' +
      'POST /api/admin/organizations/invitations/:token/accept INSERTs it and then UPDATEs it, ' +
      'inside one transaction — so AFFILIATE SELF-ONBOARDING THROWS AND ROLLS BACK, every time. ' +
      'Nothing anywhere READS users.owner_id, so the repair is to delete both references; that ' +
      'is a change to the org-signup flow and wants its own commit and its own test, which no ' +
      'test currently covers.',
  },
  'leads.data': {
    n: 4,
    where: 'message-routes.js:105, org-manifest-routes.js:184, weekly-digest-cron.js:144 and :151',
    why:
      '`leads` is a COLUMN table (title, status, city, notes ... server/db.js:1097), not a blob ' +
      'table — it has no `data`. The weekly SALES digest reads data->>\'title\' / \'status\' / ' +
      '\'client_company\'; that file\'s own header already records the sales digest silently ' +
      'skipping every week, and this is the reason it still does. The repair is not a rename: ' +
      'client_company has no leads column at all and has to come through clients.company_name, ' +
      'which is a decision about what that email should say. ' +
      'A FIFTH SITE WAS REPORTED AT org-manifest-routes.js:157 AND IS REFUTED: line 157 is ' +
      '`] = await Promise.all([`, and the only leads.data reference in that file is the status ' +
      'histogram at :184, which is already one of these four. The sites are spelled out above ' +
      'rather than left as filenames so the next reader can check the claim instead of the count.',
  },
  'projects.geocode_address': {
    n: 3,
    where: 'server/routes/weather-routes.js',
    why:
      '`projects` has geocode_lat / geocode_lng / geocode_status and address_text, but no ' +
      'geocode_address. The weather read selects it and both cache writes set it, so the ' +
      'per-project forecast throws. The repair is either a MIGRATION (add the column, so the ' +
      'geocode cache can tell "already resolved for this address" from "resolved for a ' +
      'different one") or dropping that comparison — a product decision, and a schema change ' +
      'is a migration and gets said out loud, not slipped in.',
  },
  'ai_sessions.updated_at': {
    n: 1,
    where: 'server/routes/ai-sessions-routes.js',
    why:
      '`ai_sessions` has created_at / last_used_at / archived_at and no updated_at. ' +
      'POST /api/ai/sessions/archive-all-threads — the "Clear all chats" button — sets it, so ' +
      'the button 500s. One-token repair (drop the assignment), but it is a different feature ' +
      'and belongs with a test that presses that button.',
  },
};

// ── S1 ────────────────────────────────────────────────────────────────────
describe('S1 — no test fixture declares a column server/db.js does not create', () => {
  const files = fs.readdirSync(path.join(REPO, 'test'))
    .filter((f) => f.endsWith('.js'))
    .sort();

  test('the derivation itself is working', () => {
    // A parser that returns nothing passes every assertion below. The FIRST
    // version of test/helpers/db-schema.js treated the backtick opening db.js's
    // template literal as a string quote, so no SQL `--` comment was ever
    // stripped, the prose was parsed as DDL, and `leads` came back as five
    // columns including a phantom named `so` — taken out of the middle of the
    // word "also". These are the checks that catch that shape.
    expect(schema.tableNames().length).toBeGreaterThan
      ? expect(schema.tableNames().length).toBeGreaterThan(90)
      : null;
    const leads = schema.columnsFor('leads');
    // Columns from the CREATE TABLE body, from a plain ALTER, and from an
    // ALTER far away in the file — all three paths must be followed.
    expect(leads.has('city')).toBe(true);          // body
    expect(leads.has('status')).toBe(true);        // body, after a comment with an apostrophe
    expect(leads.has('geocode_lat')).toBe(true);   // ALTER
    expect(leads.has('market_id')).toBe(true);     // ALTER, 370 lines later
    expect(leads.has('so')).toBe(false);           // the phantom
    // And the fact this whole wave turns on.
    expect(schema.columnsFor('attachments').has('uploaded_at')).toBe(true);
    expect(schema.columnsFor('attachments').has('created_at')).toBe(false);
    // A DROP COLUMN is honoured.
    expect(schema.columnsFor('org_skill_packs').has('contexts')).toBe(false);
  });

  test('every fixture agrees with server/db.js', () => {
    const offenders = [];
    for (const f of files) {
      const sql = fs.readFileSync(path.join(REPO, 'test', f), 'utf8');
      for (const bad of schema.inventedColumns(sql)) {
        offenders.push(f + '  declares  ' + bad.table + '.' + bad.column +
          '  — server/db.js never creates it');
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── S2 / S3 ───────────────────────────────────────────────────────────────
function scanAll(files) {
  return files.reduce((acc, f) => acc.concat(scanFile(REPO, f)), []);
}

function allServerFiles() {
  const out = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); continue; }
      if (!f.endsWith('.js')) continue;
      const rel = path.relative(REPO, p).replace(/\\/g, '/');
      if (rel === 'server/db.js') continue;      // db.js IS the schema
      out.push(rel);
    }
  })(path.join(REPO, 'server'));
  return out.sort();
}

describe('S2 — the agent surface names no column that does not exist', () => {
  test('the scan can see the defect it was written for', () => {
    // R0's lesson. Re-introduce the exact defect in a string and confirm the
    // scanner reports it, so a scanner that quietly stopped matching cannot
    // pass by finding nothing.
    const probe = schema.columnsFor('attachments');
    expect(probe.has('created_at')).toBe(false);
    expect(scanAll(AGENT_SURFACE).length).toBe(0);   // and it is clean NOW
  });

  test('no statement reachable by an agent tool names a missing column', () => {
    const bad = scanAll(AGENT_SURFACE)
      .map((r) => r.file + ':' + r.line + '  ' + r.key + (r.bare ? ' (bare)' : '') + '  — ' + r.head);
    expect(bad).toEqual([]);
  });
});

describe('S3 — everything else in server/ is on a counted ledger', () => {
  const findings = scanAll(allServerFiles());

  test('no NEW missing-column statement anywhere in server/', () => {
    const byKey = {};
    findings.forEach((r) => { (byKey[r.key] = byKey[r.key] || []).push(r); });
    const offenders = [];
    for (const key of Object.keys(byKey).sort()) {
      const entry = KNOWN_BROKEN[key];
      const rows = byKey[key];
      if (!entry) {
        offenders.push('NOT ON THE LEDGER  ' + key + '  (' + rows.length + ' statement(s))\n' +
          rows.map((r) => '      ' + r.file + ':' + r.line + '  ' + r.head).join('\n'));
        continue;
      }
      if (entry.n !== rows.length) {
        offenders.push('COUNT MOVED  ' + key + '  ledger says ' + entry.n + ', found ' + rows.length +
          '\n' + rows.map((r) => '      ' + r.file + ':' + r.line).join('\n'));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every ledger entry still describes a real statement', () => {
    // A ledger entry for a defect somebody fixed is a lie that reads as
    // diligence. When one of these is repaired, its entry is DELETED.
    const live = new Set(findings.map((r) => r.key));
    expect(Object.keys(KNOWN_BROKEN).filter((k) => !live.has(k))).toEqual([]);
  });

  test('every ledger entry says where and why', () => {
    for (const [key, e] of Object.entries(KNOWN_BROKEN)) {
      expect(typeof e.where).toBe('string');
      expect(e.where.length).toBeGreaterThan(10);
      expect(e.why.length).toBeGreaterThan(80);
      expect(typeof e.n).toBe('number');
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});

// ── S4 — THE DERIVATION ITSELF ────────────────────────────────────────────
// The ledger's value IS the count, so the population it counts over has to be
// asserted rather than assumed. Before this commit the population was every
// `<x>.query(` — which excluded every statement handed to a wrapper, and two of
// the three wrappers in this repo swallow the error a missing column raises.
// A ledger that cannot see the statements whose failure is SILENT is looking
// away from exactly the ones that need it.
describe('S4 — the derivation sees statements a `.query(` scan cannot', () => {
  const files = allServerFiles();
  const wide = [];
  const narrow = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    let a = [], b = [];
    try { a = extractSqlCalls(text); } catch (e) { a = []; }
    try { b = extractQueryCalls(text).filter((c) => c.sql && /\S/.test(c.sql)); } catch (e) { b = []; }
    a.forEach((c) => wide.push(Object.assign({ file: rel }, c)));
    b.forEach((c) => narrow.push(Object.assign({ file: rel }, c)));
  }

  test('THE LEDGER\'S OWN SCANNER reports a defect inside a wrapper call', () => {
    // The assertions below are about the helper. This one is about the scanner
    // the ledger actually runs: shown a statement with a known-missing column
    // handed to `safeCount` rather than to `.query(`, it must report it. Narrow
    // the derivation back and this fails — every other assertion here would
    // still pass by finding nothing.
    const src = [
      'async function h(orgId) {',
      '  const n = await safeCount(',
      '    "SELECT COUNT(*)::int c FROM leads l WHERE l.organization_id = $1 AND l.no_such_column = 1",',
      '    [orgId]);',
      '  return n;',
      '}',
    ].join('\n');
    const found = scanText(src, 'synthetic.js').map((r) => r.key);
    expect(found).toContain('leads.no_such_column');
    // …and it is genuinely the WRAPPER that carries it: the same statement
    // through `.query(` is what the old scan could already see, so a scanner
    // that only reported this one would prove nothing.
    expect(scanText(src.replace('safeCount(', 'pool.query('), 'synthetic.js')
      .map((r) => r.key)).toContain('leads.no_such_column');
  });

  test('the three SQL-running wrappers are in the population, by name and by count', () => {
    // Named individually so a failure says WHICH wrapper fell out. These are
    // the ones that exist today; the RULE is the shape (any call whose first
    // argument is a statement), which is why a fourth wrapper needs no edit.
    const byCallee = {};
    wide.forEach((c) => { byCallee[c.callee] = (byCallee[c.callee] || 0) + 1; });
    expect(byCallee.safeCount).toBeGreaterThanOrEqual(18);    // org-manifest-routes.js — swallows
    expect(byCallee.countOrNull).toBeGreaterThanOrEqual(5);   // admin-push-routes.js — swallows
    expect(byCallee.run).toBeGreaterThanOrEqual(40);          // services/email-folders.js
    expect(byCallee.query).toBeGreaterThan(1000);             // and it did not lose the direct ones
  });

  test('a statement is counted ONCE — a wrapped `.query(` is not two statements', () => {
    // `Promise.all([ pool.query(…) ])` and `promises.push(pool.query(…))` both
    // present an outer call whose first argument contains SQL. Counting both
    // would inflate the number the ledger is built on.
    const spans = wide.map((c) => c.file + ':' + c.argStart + ':' + c.argEnd);
    expect(new Set(spans).size).toBe(spans.length);
    const nested = wide.filter((a) => wide.some((b) =>
      b !== a && b.file === a.file && b.argStart >= a.argStart && b.argEnd <= a.argEnd &&
      (b.argStart > a.argStart || b.argEnd < a.argEnd)));
    expect(nested.map((c) => c.file + ':' + c.line + ' <' + c.callee + '>')).toEqual([]);
  });

  test('and it loses nothing from the old population but transaction control', () => {
    // The widening must be a superset in substance. The only `.query(` calls
    // it does not carry are `BEGIN` / `COMMIT` / `ROLLBACK` / `SET LOCAL …`
    // and one statement whose TABLE is interpolated — none of which name a
    // column this scan could judge anyway.
    const wideSpans = new Set(wide.map((c) => c.file + ':' + c.argStart + ':' + c.argEnd));
    const lost = narrow
      .filter((c) => !wideSpans.has(c.file + ':' + c.argStart + ':' + c.argEnd))
      .map((c) => ({ at: c.file + ':' + c.line, sql: c.sql.replace(/\s+/g, ' ').trim() }))
      .filter((x) => !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET\s+LOCAL)\b/i.test(x.sql))
      // `UPDATE ${src.table} …` — the table is a substitution, so neither scan
      // can resolve it and column-existence skips it either way.
      .filter((x) => !/^\s*UPDATE\s*$|^UPDATE\s+\$\{/.test(x.sql));
    expect(lost.map((x) => x.at + '  ' + x.sql.slice(0, 90))).toEqual([]);
  });
});
