// THE TWO-ORG CONFORMANCE FIXTURE.
//
// ── WHY THIS EXISTS, IN ONE PARAGRAPH ─────────────────────────────────────
// Six commits closed real tenant defects. An independent proof then added
// EIGHT NEW AGENT TOOLS, each with a genuine unpredicated cross-tenant read,
// ran the full suite, and got 156/4633 passing. The guard caught none of them.
// So the finding was never "we missed some" — it was "WE CANNOT TELL WHEN WE
// HAVE MISSED SOME", and with one organisation in production nothing
// observable ever proves us wrong. This file is the second organisation.
//
// ── THE EIGHT ATTACK CLASSES THIS IS BUILT AGAINST ────────────────────────
// Each one beat a SOURCE SCAN. None of them beats a row that came back.
//
//   A1  a tenant table classify()s as "unclassified" -> dropped from the
//       population entirely.
//   A2  the predicate moved into ORDER BY / GROUP BY, where it does not filter.
//   A3  bare `SELECT organization_id, COUNT(*) FROM t GROUP BY organization_id`.
//   A4  aggregate laundering: the rows are scoped, a subquery total is not.
//   A5  one arm of a UNION unpredicated; the statement NAMES the column, so it
//       reads literal to a scanner.
//   A6  the column name hidden inside a /* */ comment.
//   A7  the statement handed to a wrapper, so a scanner keying on `.query(`
//       never sees it.
//   A8  a module the closure walk will not pull in.
//
// ── HOW THE SHAPE OF THIS FILE KILLS EACH ONE ─────────────────────────────
// A1 AND A8 ARE ATTACKS ON POPULATION SHAPING, and they are answered
// STRUCTURALLY rather than by a better heuristic:
//
//   * THE SCHEMA IS EVERY TABLE server/db.js CREATES. All 108 of them, derived
//     by test/helpers/db-schema.js, never typed here. classify() is NOT
//     consulted to decide what exists. A table cannot drop out of a population
//     that is already everything, so A1 has nothing to shrink — and the
//     three tables that DO carry organization_id while classify() calls them
//     unclassified (email_attachments, live_participants, live_rooms) are in
//     the fixture anyway, seeded, with a marked victim row.
//
//   * THE TOOL POPULATION IS WHAT THE MODEL IS OFFERED. Not `case` labels, not
//     a regex over source, not a list anyone maintains: the eleven exported
//     accessors on ai-routes' `internals` (estimateTools, jobTools, …) unioned
//     with ALLOWED_AUTO_TIER_TOOLS and ORGLESS_ALLOWED_TOOLS. 112 names. A tool
//     the model can call is by construction in that union, so A8's "a module
//     the walk will not reach" has nowhere to hide: reachable means published,
//     published means enumerated.
//
// A2, A5, A6 AND A7 ARE ATTACKS ON READING SQL, and this file never reads any.
// A clause that does not filter does not remove rows; a comment does nothing at
// runtime; a wrapper executes against the same engine. The oracle is what came
// back.
//
// A3 AND A4 ARE THE TWO A MARKER GREP STRUCTURALLY CANNOT SEE, because neither
// leaks a string. They are answered by making the NUMBERS themselves the
// marker:
//
//   * ORG B'S OWN ID IS 900000002. Not 2. A `GROUP BY organization_id` that
//     leaks org B emits that number in its own projection, so A3 is caught by
//     the poison arm with no differential and no flake.
//   * EVERY ORG-B NUMERIC IS IN [900000000, 999999999) AND EVERY ORG-A AND
//     NULL-ORG NUMERIC IS <= 10000. A laundered SUM() that touched one org-B
//     row lands in the band BY CONSTRUCTION — org A cannot reach it, because
//     the largest total org A can produce is bounded by its own seed. That is
//     A4, caught by magnitude, with no byte-diff to flake.
//
// The band is a BAND and not a floor on purpose: epoch-milliseconds (1.7e12)
// and epoch-seconds (1.7e9) both sit outside [9e8, 1e9), so a timestamp that
// survives normalization cannot be read as a leak.
//
// ── WHAT THIS FILE REFUSES TO DO ──────────────────────────────────────────
// It does not look at SQL text, ever. `engine.log` is pulled into FAILURE
// MESSAGES so a human can find the statement, and it is never a pass/fail
// condition — the moment a log assertion becomes the property, the static
// scanner has been rebuilt inside the fixture and A2/A6/A7 come back.
//
// It does not decide what "leaked" means for a caller. scanAnswer() returns the
// evidence; the assertion lives in the test, where a reader can see which
// string is the victim's.
'use strict';

const { sqliteSchema, tableNames, columnsFor, tableColumns } = require('./db-schema');
const { createPgSqlite } = require('./pg-sqlite');
const { classify } = require('../../server/services/org-table-classification');

// ── the three tenants ─────────────────────────────────────────────────────
// ORG_A is the caller. ORG_B is the victim. NULL is the legacy un-stamped row
// that production genuinely has (server/db.js:721 backfills ai_messages from
// the author's user row at every boot, and rows written before that sweep — or
// by a path that skipped it — are exactly this shape). All three are seeded in
// every case, so a predicate that is right about two of them and wrong about
// the third cannot pass by never being asked.
const ORG_A = 1;

// ORG B'S ID IS ITSELF POISONED. See the header: this is what kills A3 without
// a differential. Any statement that groups by, projects, or sums
// organization_id and reaches org B puts a 9-digit band number in its answer.
const ORG_B = 900000002;

// ── the two markers ───────────────────────────────────────────────────────
// STRINGS. One grep over the flattened answer decides the case. Flattened and
// never field-picked, so a leak arriving in a field nobody anticipated cannot
// read as absent.
const MARK = 'ZZVICTIMBRAVO';

// NUMBERS. The half a marker grep cannot see.
const BRAVO_LO = 900000000;
const BRAVO_HI = 1000000000;   // exclusive
const ALPHA_MAX = 10000;       // every org-A and NULL-org numeric is <= this

function isPoisoned(n) {
  return typeof n === 'number' && isFinite(n) && n >= BRAVO_LO && n < BRAVO_HI;
}

// ── the schema: everything, derived ───────────────────────────────────────
// tableNames() is every CREATE TABLE in server/db.js, after its ALTERs. 108
// tables, ~31 KB of DDL, 3 ms to exec into an in-memory engine. There is no
// curation step, and that absence is the point — see A1 in the header.
const ALL_TABLES = tableNames();

// `id` is the primary key wherever the table has one, so ON CONFLICT (id)
// resolves; `roles` keys on `name` and `app_settings` on `key`. Everything else
// is left without a key, because a fixture asserting a constraint production
// does not have is its own kind of lie.
const PK = (() => {
  const pk = {};
  for (const t of ALL_TABLES) {
    const cols = columnsFor(t);
    if (!cols) continue;
    if (t === 'roles') pk[t] = 'name';
    else if (t === 'app_settings') pk[t] = 'key';
    else if (cols.has('id')) pk[t] = 'id';
  }
  return pk;
})();

const SCHEMA = sqliteSchema(ALL_TABLES, { pk: PK });

// ── the generic seeder ────────────────────────────────────────────────────
// EVERY TABLE GETS THREE ROWS: one for org A, one for org B, one un-stamped.
// Generic, from the DERIVED columns, so a table added to db.js next week is
// seeded by this fixture without anybody remembering to add it. That matters
// more than it sounds: a door that reads an UNSEEDED table returns nothing,
// and "nothing" passes every boundary assertion in this file for the wrong
// reason. An empty table is a vacuous pass, and a vacuous pass is what this
// whole wave is about.
//
// Columns whose value is load-bearing to a filter — a status, an entity_type,
// a mime type — get a REALISTIC shared value rather than a marked one, because
// marking them would make the org-B row invisible to its own tenant and the
// symmetry assertion ("B still sees B") would fail for a reason that has
// nothing to do with tenancy.
const ENUMISH = new Set([
  'status', 'role', 'state', 'entity_type', 'client_type', 'type', 'kind',
  'category', 'direction', 'tier', 'unit', 'currency', 'method', 'provider',
  'agent_key', 'model', 'mime_type', 'account_type', 'txn_type', 'bucket',
  'activation_status', 'source', 'phase', 'severity', 'level', 'action',
  'visibility', 'scope', 'target_type', 'cert_type', 'trade', 'frequency',
]);

// Sensible values for those, so a `WHERE status = 'active'` still matches.
const ENUM_VALUE = {
  status: 'active', role: 'assistant', state: 'FL', entity_type: 'estimate',
  client_type: 'hoa', type: 'general', kind: 'general', category: 'general',
  direction: 'inbound', tier: 'auto', unit: 'lf', currency: 'usd',
  method: 'GET', provider: 'anthropic', agent_key: 'job',
  model: 'claude-sonnet-5', mime_type: 'application/pdf',
  account_type: 'Expense', txn_type: 'Bill', bucket: 'material',
  activation_status: 'active', source: 'web', phase: 'post-migration',
  severity: 'info', level: 'info', action: 'read', visibility: 'org',
  scope: 'org', target_type: 'job', cert_type: 'GL', trade: 'roofing',
  frequency: 'weekly',
};

// Boolean-ish columns default to 1 (present/active) so a row is not filtered
// out of its own tenant's view by an `active = TRUE` arm.
const TRUEISH = /^(is_|has_|can_)|(_enabled|_active|active|enabled|approved|published|visible|include|included|is_system|is_locked|archived|deleted|dismissed|resolved|read|sent|paid|locked|hidden)$/;
const FALSEISH = new Set(['archived', 'deleted', 'dismissed', 'is_locked', 'hidden']);

// Fixed timestamps. Nothing in this fixture is allowed to depend on the wall
// clock: a numeric multiset that moves between two runs of the same engine is
// the flake that would get this suite muted, and a muted harness protects
// nothing while wearing the costume of protection.
const T_OLD = '2026-08-01 00:00:00';

function isNumericType(ty) {
  return /^(INTEGER|REAL)$/.test(ty);
}

// THE CANONICAL SEEDED ID for a table and a tenant, exported so an overlay or
// an input recipe never hand-types one. `messages.id` is an INTEGER primary key
// and `estimates.id` is TEXT; a hand-typed 'messages-A-0' is a sqlite "datatype
// mismatch" at best and, on a table without a key, a SECOND row that silently
// shadows the seeded one at worst. Deriving it means the overlay and the
// generic seed cannot disagree about which row they are talking about.
const TAG_ORDINAL = { A: 0, B: 1, N: 2 };

function idFor(t, tag) {
  const cols = columnsFor(t);
  if (!cols || !cols.has('id')) throw new Error('two-org idFor: ' + t + ' has no id column');
  const ordinal = TAG_ORDINAL[tag];
  if (ordinal === undefined) throw new Error('two-org idFor: unknown tenant tag ' + tag);
  const { tables } = tableColumns();
  const ty = require('./db-schema').toSqliteType(tables.get(t).get('id'));
  if (ty !== 'INTEGER') return t + '-' + tag + '-' + ordinal;
  return tag === 'B' ? BRAVO_LO + 1000 + ordinal : (tag === 'A' ? 100 + ordinal : 200 + ordinal);
}

// One row's worth of values for table `t`, for the tenant identified by `tag`.
function rowFor(t, tag, orgId, ordinal) {
  const { tables } = tableColumns();
  const cols = tables.get(t);
  const out = {};
  const victim = tag === 'B';
  for (const [col, pgType] of cols) {
    const ty = require('./db-schema').toSqliteType(pgType);
    if (col === 'organization_id') { out[col] = orgId; continue; }
    if (col === 'id') {
      // Deterministic and tenant-labelled, so a leaked id is legible in a
      // failure message. Integer keys take the poisoned band for org B, which
      // is what makes a leaked integer id caught by the number arm too.
      out[col] = ty === 'INTEGER'
        ? (victim ? BRAVO_LO + 1000 + ordinal : (tag === 'A' ? 100 + ordinal : 200 + ordinal))
        : t + '-' + tag + '-' + ordinal;
      continue;
    }
    if (ENUMISH.has(col)) { out[col] = ENUM_VALUE[col] || 'general'; continue; }
    if (ty === 'INTEGER' && TRUEISH.test(col)) { out[col] = FALSEISH.has(col) ? 0 : 1; continue; }
    if (isNumericType(ty)) {
      // THE POISON. Org B's every number is in the band; org A's and the
      // un-stamped row's are bounded well below it, so no org-A total can
      // reach the band by addition. See A4 in the header.
      out[col] = victim ? BRAVO_LO + 5000 + ordinal : (tag === 'A' ? 111 + ordinal : 7 + ordinal);
      continue;
    }
    if (/(^|_)(at|date|_on)$/.test(col) || /_at$/.test(col) || /_date$/.test(col)) {
      out[col] = T_OLD; continue;
    }
    if (col === 'data' || /_json$/.test(col) || col === 'detail' || col === 'value'
        || col === 'capabilities' || col === 'tool_uses' || col === 'metadata') {
      out[col] = victim ? JSON.stringify({ note: MARK + ' blob' }) : JSON.stringify({});
      continue;
    }
    // Everything else is free text and carries the marker for org B.
    out[col] = victim ? MARK + ' ' + t + '.' + col : tag + '-' + t + '-' + col;
  }
  return out;
}

function insertRow(db, t, row) {
  const cols = Object.keys(row);
  const sql = 'INSERT OR REPLACE INTO ' + t + ' (' + cols.join(',') + ') VALUES ('
    + cols.map(() => '?').join(',') + ')';
  // NAME THE TABLE AND THE VALUES ON FAILURE. sqlite's own message for this is
  // the bare string "datatype mismatch", with no table, no column and no value
  // — which is exactly the kind of diagnostic that gets a fixture abandoned
  // rather than fixed.
  try {
    db.prepare(sql).run(...cols.map((c) => {
      const v = row[c];
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    }));
  } catch (e) {
    throw new Error('two-org: INSERT into ' + t + ' failed (' + e.message + ')\n  columns: '
      + cols.join(',') + '\n  values: ' + JSON.stringify(row).slice(0, 400));
  }
}

// `overlay` is where a driven door's REALISTIC values go: a jobs.data blob with
// buildings and phases in it, an attachments row pointing at a real estimate
// id, a users row the caller is. It sets VALUES ONLY — every column it names is
// checked against the derived schema first, so an overlay cannot invent a
// column. That check is the whole reason the ledger in test/schema-truth.test.js
// exists: a hand-written fixture that declared `attachments.created_at` kept two
// shipped agent tools green while both raised 42703 in production.
function applyOverlay(db, overlay) {
  for (const [t, rows] of Object.entries(overlay)) {
    const cols = columnsFor(t);
    if (!cols) throw new Error('two-org overlay: server/db.js does not create table "' + t + '"');
    for (const row of rows) {
      for (const c of Object.keys(row)) {
        if (!cols.has(c)) {
          throw new Error('two-org overlay: ' + t + ' has no column "' + c
            + '" in server/db.js — the fixture may not invent one');
        }
      }
      insertRow(db, t, row);
    }
  }
}

// ── the two worlds ────────────────────────────────────────────────────────
// TWO-ORG   A + B + un-stamped. Where the boundary is proved.
// ONE-ORG   A + un-stamped only. This is PRODUCTION TODAY, and it is what the
//           no-op proof and the cardinality differential compare against.
//
// Both are built by the SAME function from the SAME overlay, so the one-org
// world cannot quietly diverge from the two-org one in some way that makes the
// differential meaningless.
function buildEngine(opts) {
  const withB = !(opts && opts.withB === false);
  const overlay = (opts && opts.overlay) || {};
  const engine = createPgSqlite(SCHEMA, {
    jsonColumns: ['data', 'tool_uses', 'agent_notes', 'crew', 'tags', 'capabilities',
      'notification_prefs', 'output_files', 'certs', 'detail', 'value', 'metadata'],
    dateColumns: ['updated_at', 'created_at', 'uploaded_at', 'last_seen_at', 'registered_at',
      'received_at', 'sent_at', 'accepted_at', 'expires_at', 'completed_at', 'started_at'],
  });
  // THE ORDINAL IS THE TENANT'S OWN, NOT A RUNNING COUNTER. A counter gave the
  // un-stamped row a different id in the one-org world (…-N-1) than in the
  // two-org one (…-N-2), which would have made every differential comparison
  // report a difference that is an artefact of the seeder rather than of the
  // code. The two worlds must differ in EXACTLY ONE WAY: whether org B exists.
  const TENANTS = [['A', ORG_A, 0], ['B', ORG_B, 1], ['N', null, 2]];
  const tenants = withB ? TENANTS : TENANTS.filter(([tag]) => tag !== 'B');
  for (const t of ALL_TABLES) {
    for (const [tag, orgId, ordinal] of tenants) {
      try { insertRow(engine.db, t, rowFor(t, tag, orgId, ordinal)); }
      catch (e) {
        throw new Error('two-org: could not seed ' + t + ' (' + tag + '): ' + e.message);
      }
    }
  }
  applyOverlay(engine.db, withB ? overlay : stripB(overlay));
  return engine;
}

// The one-org world gets the SAME overlay with every org-B row removed, rather
// than a second hand-written overlay. A differential built on two independently
// written seeds compares the seeds, not the code.
function stripB(overlay) {
  const out = {};
  for (const [t, rows] of Object.entries(overlay)) {
    out[t] = rows.filter((r) => r.organization_id !== ORG_B);
  }
  return out;
}

// ── the oracle ────────────────────────────────────────────────────────────
// Shape-blind. It takes whatever a door returned — a string, an object, an
// array of content blocks — flattens the WHOLE of it, and reports evidence.
function flatten(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// Timestamps out, so a wall-clock digit cannot enter the numeric multiset and
// make the differential arm flake. Money formatting in too: `$1,234,567` is one
// number, not three, and a laundered total printed with separators must not
// fall apart into three small ones.
const ISO_TS = /\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?/g;

// ── A DIGIT RUN INSIDE A WORD IS NOT A NUMBER ────────────────────────────
// The first version of this matched `/-?\d+(?:\.\d+)?/g` anywhere, and that
// produced a MEASURED, REPRODUCIBLE FALSE POSITIVE — roughly one run in twelve.
// `GET /api/email-folders` mints ids like
//
//     efld_mtp4sz915488502d
//
// from a base36 clock plus randomness, and the middle of that token is
// `915488502`, which sits inside the reserved band by pure chance. Arm 2 called
// it a leak, the ledger disagreed, and the suite went red on nothing at all.
//
// A flaky boundary assertion is worse than a missing one. It gets muted, and a
// muted harness protects nothing while wearing the costume of protection — so
// this is the one place where narrowing the oracle is the right move rather
// than a concession.
//
// THE RULE: a number is a digit run whose neighbours are not word characters.
// `"input_tokens":900007000` qualifies (`:` and `}`). `jobs-900001001`
// qualifies (`-` on both sides), so a leaked composite id is still seen.
// `mtp4sz915488502d` does NOT, on either side.
//
// WHAT THIS GIVES UP, SAID OUT LOUD: a leak that arrives welded to a letter
// with no delimiter — `org900000002` — is now invisible to Arm 2. Arm 1 still
// sees it if it carries the marker, and Arm 3 still sees it as a difference.
// Nothing in this codebase emits that shape today; if something starts to, this
// rule is where to look.
function numbersIn(text) {
  const cleaned = String(text)
    .replace(ISO_TS, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1');   // 1,234,567 -> 1234567
  const out = [];
  const re = /(?<![A-Za-z0-9_])-?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const n = Number(m[0]);
    if (isFinite(n)) out.push(n);
  }
  return out;
}

// THE EVIDENCE, never the verdict.
//   marked    the org-B string marker survived into the answer          (A2 A5 A6 A7)
//   poisoned  a number in the reserved band survived into the answer    (A3 A4)
//   numbers   the normalized numeric multiset, for the differential arm (bare COUNT(*))
function scanAnswer(value) {
  const text = flatten(value);
  const nums = numbersIn(text);
  return {
    text,
    marked: text.indexOf(MARK) !== -1,
    poisoned: nums.filter(isPoisoned),
    numbers: nums.slice().sort((a, b) => a - b),
  };
}

// A failure message that names the statements, so a human can find the one that
// leaked without re-deriving it. NOT a pass/fail input — see the header.
function statementTail(engine, n) {
  const log = engine.log.slice(-(n || 12));
  return log.map((e, i) => '  [' + i + '] ' + e.sql.slice(0, 220)).join('\n');
}

// classify() as a REPORT, not as a gate. The population above does not consult
// it, so this can never shrink the fixture; it exists so that a table carrying
// organization_id which nobody has classified is VISIBLE by name rather than
// silently absent. The waiver list is committed and counted — see
// test/tenant-conformance.test.js.
// Is this ONE table unclassified? Exported for the A1 case in
// test/tenant-attack-classes.test.js, which has to assert that the table it
// planted the leak in is genuinely one a classification-derived population
// would have dropped — otherwise the case proves nothing about A1.
function classifyIsUnclassified(t) {
  return classify(t) === 'unclassified';
}

function unclassifiedTenantTables() {
  return ALL_TABLES.filter((t) => {
    const cols = columnsFor(t);
    return cols && cols.has('organization_id') && classify(t) === 'unclassified';
  });
}

module.exports = {
  ORG_A, ORG_B, MARK, BRAVO_LO, BRAVO_HI, ALPHA_MAX, T_OLD,
  ALL_TABLES, SCHEMA, PK,
  idFor, isPoisoned, buildEngine, scanAnswer, flatten, numbersIn, statementTail,
  unclassifiedTenantTables, classifyIsUnclassified,
};
