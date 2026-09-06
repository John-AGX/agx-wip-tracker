// THE PLANTS — REAL CROSS-TENANT DEFECTS, ONE SHAPE EACH.
//
// ── WHY THIS IS A COMMITTED FILE AND NOT A SCRATCH SCRIPT ────────────────
// Two waves of this work reported success on a harness that could not see the
// leaks in front of it. The first implementer planted eight and reported
// success; an independent agent then planted twelve more and got 85/85 green.
// So the only evidence anybody should accept for "the harness catches X" is a
// PLANT OF X THAT TURNS IT RED, and that evidence has to be re-runnable by the
// next person rather than quoted from a transcript.
//
//   node test/fixtures/tenant-plants.js list
//   node test/fixtures/tenant-plants.js run <id|all>
//
// ── THE RULES THIS RUNNER ENFORCES ON ITSELF ─────────────────────────────
//   * EVERY PLANT REFUSES A NON-UNIQUE OR MISSING MATCH. A plant that silently
//     no-ops produces a green run and a false claim of coverage, which is the
//     exact failure this whole exercise is about. `find` must occur EXACTLY
//     ONCE in the target file or the runner aborts before touching anything.
//   * EVERY MUTATION IS BYTE-DIFFED. sha256 before, sha256 after, sha256 after
//     restore. The restore must return the ORIGINAL hash or the runner says so
//     loudly and stops — a working tree several sessions share must never be
//     left carrying a planted leak.
//   * ONLY THE FILE THE PLANT NAMES IS EVER WRITTEN. No git stash, no
//     checkout, no reset: those reach files this process did not modify.
//
// ── WHAT A PLANT IS ALLOWED TO BE ────────────────────────────────────────
// A real defect, of a shape that has actually shipped somewhere. Not a
// tripwire, not a marker string, not something written to be found. Each entry
// says WHICH ATTACK CLASS or which repair it exercises, and what SHOULD catch
// it. `expect: 'ESCAPES'` is as important an entry as `expect: 'CAUGHT'` — the
// list of shapes that get through is the deliverable.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const F = (p) => path.join(ROOT, p);

const AI = 'server/routes/ai-routes.js';
const ADMIN = 'server/routes/admin-agents-routes.js';
const CLIENTS = 'server/routes/client-routes.js';
const DIGEST = 'server/weekly-digest-cron.js';

const CONF = 'tenant-conformance';
const REG2 = 'tenant-register2';
const IDOR = 'prompt-audit-org-id';
const ORGLESS = 'ai-messages-orgless';
const DOORS = 'ai-read-tenant-doors';

const PLANTS = [

  // ══ A8 — A TOOL GROUP THE ENUMERATION DOES NOT REACH ═══════════════════
  {
    id: 'a8-accessor',
    what: 'A new published tool group behind a new `lensTools` accessor, holding a read with no tenant predicate.',
    why: 'This is the plant that beat the previous harness. Its accessor list was ELEVEN HARD-CODED STRINGS, so a twelfth group was invisible: population 112 vs a real 113, and "the population size is committed (112)" PASSED.',
    caught_by: 'REGISTER 1 — the accessor list is now derived from `internals` by shape (/Tools$/), so a group either follows the convention every other one follows and is enumerated, or is never offered to an agent.',
    file: AI,
    suites: [CONF],
    expect: 'CAUGHT',
    find: "  readTools: () => READ_TOOLS.map(({ tier, ...t }) => t),",
    replace: [
      "  readTools: () => READ_TOOLS.map(({ tier, ...t }) => t),",
      "  lensTools: () => ([{",
      "    name: 'read_portfolio_digest',",
      "    description: 'Portfolio-wide digest of estimate value.',",
      "    input_schema: { type: 'object', properties: {} },",
      "  }]),",
    ].join('\n'),
    also: [{
      file: AI,
      find: "  if (INTAKE_EXECUTOR_TOOLS.has(name))         return execIntakeRead(name, input, ctx);",
      replace: [
        "  if (name === 'read_portfolio_digest') {",
        "    const r = await pool.query('SELECT id, data FROM estimates ORDER BY updated_at DESC LIMIT 25');",
        "    return 'Portfolio: ' + r.rows.map((x) => x.id + ' ' + JSON.stringify(x.data)).join(' | ');",
        "  }",
        "  if (INTAKE_EXECUTOR_TOOLS.has(name))         return execIntakeRead(name, input, ctx);",
      ].join('\n'),
    }],
  },

  // ══ REGISTER 2 — A ROUTE ADDED WHERE THE SCAFFOLD ALREADY LOOKED ═══════
  {
    id: 'r2-same-router',
    what: 'A new GET /portfolio-rollup on admin-agents-routes, one line below /metrics, summing every tenant\'s estimates.',
    why: 'The auditor planted exactly this. The old scaffold hard-coded four URLs on this router and drove none of the others, so adding a fifth changed nothing and 165 suites stayed green.',
    caught_by: 'REGISTER 2 — the population is router.stack, so a route added anywhere is driven the run it appears.',
    file: ADMIN,
    suites: [REG2],
    expect: 'CAUGHT',
    find: "router.get('/metrics',",
    replace: [
      "router.get('/portfolio-rollup', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {",
      "  const r = await pool.query('SELECT id, organization_id, data FROM estimates ORDER BY updated_at DESC LIMIT 50');",
      "  res.json({ rollup: r.rows });",
      "});",
      "",
      "router.get('/metrics',",
    ].join('\n'),
  },

  // ══ REGISTER 2 — A ROUTE ON A ROUTER THE SCAFFOLD NEVER TOUCHED ════════
  {
    id: 'r2-other-router',
    what: 'A new GET /api/clients/portfolio on client-routes — a router the old scaffold never mounted at all.',
    why: 'The previous harness drove 4 routes on 1 of 74 routers. A leak on any of the other 73 was outside its universe, which is A8 restated at the HTTP layer.',
    caught_by: 'REGISTER 2 — 74 routers, all mounted, all walked.',
    file: CLIENTS,
    suites: [REG2],
    expect: 'CAUGHT',
    find: "const router = express.Router();",
    replace: [
      "const router = express.Router();",
      "",
      "router.get('/portfolio', requireAuth, async (req, res) => {",
      "  const r = await pool.query('SELECT id, name, city FROM clients ORDER BY name LIMIT 50');",
      "  res.json({ clients: r.rows });",
      "});",
    ].join('\n'),
  },

  // ══ A3 — GROUP BY organization_id, WHICH LEAKS NO STRING ═══════════════
  {
    id: 'a3-group-by',
    what: 'read_metrics gains a per-organisation breakdown: `GROUP BY organization_id` with the tenant predicate removed.',
    why: 'Attack class A3. It emits no marker at all — the leak is the ORG ID in its own projection — so a marker grep is structurally blind to it.',
    caught_by: 'ARM 2 (POISON): org B\'s id is 900000002, inside the reserved band, so grouping by it puts the band number in the answer.',
    file: AI,
    suites: [CONF],
    expect: 'CAUGHT',
    find: "          AND entity_type IN ('estimate','job','client')\n          AND (organization_id = $1 OR organization_id IS NULL)\n        GROUP BY entity_type",
    replace: "          AND entity_type IN ('estimate','job','client')\n          AND ($1 IS NOT NULL)\n        GROUP BY entity_type, organization_id",
  },

  // ══ A4 — AGGREGATE LAUNDERING ═════════════════════════════════════════
  {
    id: 'a4-laundered-sum',
    what: 'read_metrics keeps its scoped rows and adds ONE unscoped subquery total for "platform context".',
    why: 'Attack class A4. Every row it returns is correctly scoped; the leak is a single SUM over the whole table. No id, no name, no marker — just a number.',
    caught_by: 'ARM 2 (POISON): org A\'s own seed is bounded below 10000 by construction, so a total that touched one org-B row lands in [9e8,1e9) and cannot be reached by addition from org A alone.',
    file: AI,
    suites: [CONF],
    expect: 'CAUGHT',
    find: "      out.push('Metrics for last ' + range + ':');",
    replace: [
      "      const _ctx = await pool.query('SELECT COALESCE(SUM(input_tokens),0) AS t FROM ai_messages');",
      "      out.push('Metrics for last ' + range + ' (platform total ' + (_ctx.rows[0] && _ctx.rows[0].t) + '):');",
    ].join('\n'),
  },

  // ══ A7 — THE STATEMENT HANDED TO A WRAPPER ════════════════════════════
  {
    id: 'a7-wrapper',
    what: 'read_clients routes its statement through a local `runSql` helper, so no `.query(` call site carries the SQL.',
    why: 'Attack class A7. A scanner keyed on `pool.query(` never sees the text, and the text is the only thing it could have judged.',
    caught_by: 'ARM 1 (MARK): the wrapper executes against the same engine, and the victim\'s row comes back either way. This harness never reads SQL, so there is nothing for a wrapper to hide from.',
    file: AI,
    suites: [CONF],
    expect: 'CAUGHT',
    find: "    case 'read_clients': {",
    replace: [
      "    case 'read_clients': {",
      "      const runSql = (t, p) => pool.query(t, p);",
      "      const _all = await runSql('SELECT id, name, city FROM clients ORDER BY name LIMIT 50', []);",
      "      if (_all.rows.length) return 'Clients: ' + _all.rows.map((c) => c.name + ' (' + c.city + ')').join(', ');",
    ].join('\n'),
  },

  // ══ A6 — THE COLUMN NAME HIDDEN IN A COMMENT ══════════════════════════
  {
    id: 'a6-commented-predicate',
    what: 'read_recent_conversations keeps the words `organization_id = $1` — inside a /* */ comment — and filters on nothing.',
    why: 'Attack class A6. The statement reads literally correct to any grep, and does nothing at runtime.',
    caught_by: 'ARM 1 (MARK). A comment is not a predicate, and the harness only ever looks at rows.',
    file: AI,
    suites: [CONF],
    expect: 'CAUGHT',
    find: "      const conds = [`created_at >= NOW() - INTERVAL '${range}'`,\n                     `(organization_id = $1 OR organization_id IS NULL)`];",
    replace: "      const conds = [`created_at >= NOW() - INTERVAL '${range}'`,\n                     `/* (organization_id = $1 OR organization_id IS NULL) */ ($1 IS NOT NULL)`];",
  },

  // ══ A2 — THE PREDICATE MOVED WHERE IT DOES NOT FILTER ═════════════════
  {
    id: 'a2-order-by',
    what: 'read_past_estimates moves its tenant arm out of WHERE and into ORDER BY, where it sorts instead of filtering.',
    why: 'Attack class A2. The column is named, the parameter is bound, the statement is syntactically fine, and every tenant\'s rows come back.',
    caught_by: 'ARM 1 (MARK) — a clause that does not filter does not remove rows.',
    file: AI,
    suites: [CONF],
    expect: 'CAUGHT',
    find: "    case 'read_past_estimates': {",
    replace: [
      "    case 'read_past_estimates': {",
      "      {",
      "        const _o = ctxOrgId(ctx);",
      "        const _r = await pool.query(",
      "          'SELECT id, data FROM estimates ORDER BY (organization_id = $1) DESC, updated_at DESC LIMIT 25', [_o]);",
      "        if (_r.rows.length) return 'Past estimates: ' + _r.rows.map((e) => e.id + ' ' + JSON.stringify(e.data).slice(0, 200)).join(' | ');",
      "      }",
    ].join('\n'),
  },

  // ══ THE IDOR — AN ID IN THE INPUT IS NOT AN AUTHORISATION ═════════════
  {
    id: 'idor-attachment',
    what: 'read_attachment_text drops its tenant arm and answers whatever attachment_id it is handed.',
    why: 'THE SHAPE THE OLD HARNESS WAS STRUCTURALLY BLIND TO. Every recipe passed an ORG-A id, so a planted IDOR produced an IDENTICAL answer in both worlds and Arms 1, 2 and 3 were ALL GREEN. Only the older ai-read-tenant-doors test, which passes a foreign id, caught it.',
    caught_by: 'ARM 4 — the recipes now carry a FOREIGN-ID axis, derived from the fixture rather than typed, so every id-bearing recipe gets its org-B twin.',
    file: AI,
    suites: [CONF, DOORS],
    expect: 'CAUGHT',
    find: "    case 'read_attachment_text': {",
    replace: [
      "    case 'read_attachment_text': {",
      "    {",
      "      const _a = await pool.query('SELECT filename, extracted_text FROM attachments WHERE id = $1', [input && input.attachment_id]);",
      "      if (_a.rows.length) return _a.rows[0].filename + ': ' + (_a.rows[0].extracted_text || '');",
      "    }",
    ].join('\n'),
  },

  // ══ THE APPROVAL-TIER EXECUTOR — DRIVEN BY NOTHING BEFORE THIS WAVE ════
  {
    id: 'approval-executor',
    what: 'add_client_note (routed by the approval chain, served by execClientDirectoryToolWithCtx) reads the client list with no tenant arm before writing.',
    why: 'The waived 54 were "covered" by a NAME REGEX. The executor that serves them had never been driven, and a cross-tenant read planted in it was caught by the static source scanner alone.',
    caught_by: 'REGISTER 1 — the approval-routed names are now EXECUTED against the second organisation under Arms 1 and 2.',
    file: AI,
    suites: [CONF],
    expect: 'CAUGHT',
    find: "  if (name === 'add_client_note') {",  // execClientDirectoryToolWithCtx, ai-routes.js:7078
    replace: [
      "  if (name === 'add_client_note') {",
      "    {",
      "      const _c = await pool.query('SELECT id, name FROM clients ORDER BY name LIMIT 25');",
      "      if (_c.rows.length) throw new Error('Which client? ' + _c.rows.map((x) => x.name).join(', '));",
      "    }",
    ].join('\n'),
  },

  // ══ THE ANTI-LOBOTOMY DIRECTION — A BOUNDARY THAT SERVES NOBODY ════════
  {
    id: 'lobotomy',
    what: 'read_clients is "repaired" by filtering on an organisation nobody is in — it now returns nothing to everybody.',
    why: 'The failure mode that killed the previous attempt at this work, and the one a boundary-only harness cannot see: every leak assertion passes when the answer is empty. On a live pilot with real money in it this is worse than the leak.',
    caught_by: 'ARM 3 (org A\'s answer must be unchanged in a world with no org B) AND ARM 0 (it must CHANGE when org A\'s own data goes). The second is what makes emptiness itself red.',
    file: AI,
    suites: [CONF],
    expect: 'CAUGHT',
    find: "    case 'read_clients': {",
    replace: [
      "    case 'read_clients': {",
      "      {",
      "        const _c = await pool.query('SELECT id, name FROM clients WHERE organization_id = -1');",
      "        return _c.rows.length ? 'Clients: ' + _c.rows.map((x) => x.name).join(', ') : 'No clients found.';",
      "      }",
    ].join('\n'),
  },

  // ══ THE REGRESSION THIS WAVE SHIPPED, RE-INTRODUCED ═══════════════════
  {
    id: 'silent-empty',
    what: 'GET /86/messages stops refusing an org-less caller and goes back to running a predicate that can only match nothing.',
    why: 'This is the defect this wave shipped and 9d2522ef fixed. Its failure mode is a 200 with an empty body — no error, no log, no rollback — and it becomes reachable the day org #2 exists.',
    caught_by: 'test/ai-messages-orgless-refusal.test.js, which drives three arms holding the caller record fixed and varying only its organisation.',
    file: AI,
    suites: [ORGLESS],
    expect: 'CAUGHT',
    find: "    if (msgOrgId == null) {\n      return res.status(409).json({",
    replace: "    if (false) {\n      return res.status(409).json({",
  },

  // ══ THE IDOR THIS WAVE FOUND AND FIXED, RE-INTRODUCED ═════════════════
  {
    id: 'prompt-audit-idor',
    what: 'prompt-audit goes back to taking org_id straight off the query string.',
    why: 'Found by REGISTER 2 on its first run, at HEAD, unplanted. Six rounds of static scanning missed it because the statement IS scoped — to a value the caller chose.',
    caught_by: 'test/prompt-audit-org-id-idor.test.js and REGISTER 2.',
    file: ADMIN,
    suites: [IDOR],
    expect: 'CAUGHT',
    find: "    if (askedOrgId != null && askedOrgId !== ownOrgId && !hasCapability(req.user, 'SYSTEM_ADMIN')) {",
    replace: "    if (false && askedOrgId != null && askedOrgId !== ownOrgId && !hasCapability(req.user, 'SYSTEM_ADMIN')) {",
  },

  // ══ REGISTER 3 — THE CRON SURFACE. NAMED, NOT CLAIMED. ════════════════
  {
    id: 'cron-digest',
    what: 'weekly-digest-cron gains a cross-tenant `GROUP BY organization_id` rollup and puts every tenant\'s totals in one digest.',
    why: 'The audit planted this shape and it escaped everything. REGISTER 3 does not exist. The only door any tenancy test has into a cron is GET /api/admin/reminders/cron-preview, which REGISTER 2 drives in dry mode — this plant measures how much that accident is actually worth.',
    caught_by: [
      "NOTHING — MEASURED, TWICE, with the sibling plant below. Both escape, and the reason is sharper than \"Register 3 does not exist\": ",
      "the ONE door any test has into a cron is GET /api/admin/reminders/cron-preview. It is requireSystemAdmin, so the org-admin arm gets 403 and sees nothing; ",
      "and for the platform owner it sits on PLATFORM_WIDE_BY_DESIGN, because a cron sweeps every tenant BY DEFINITION and the arm is correctly disarmed there. ",
      "A cron leak is therefore invisible to REGISTER 2 BY CONSTRUCTION, not by oversight. Register 3 has to assert something else entirely: not ",
      "\"it must not see two orgs\" but \"it must not COMBINE them into one output, and must not deliver one tenant rows to another tenant recipient\".",
    ].join(),
    file: DIGEST,
    suites: [REG2],
    expect: 'MEASURE',
    find: "async function runOnce(opts) {",
    replace: [
      "async function _platformRollup() {",
      "  const { pool } = require('./db');",
      "  const r = await pool.query('SELECT organization_id, COUNT(*) AS n FROM jobs GROUP BY organization_id');",
      "  return r.rows.map((x) => x.organization_id + ':' + x.n).join(',');",
      "}",
      "",
      "async function runOnce(opts) {",
      "  try { global.__PLANT_ROLLUP__ = await _platformRollup(); } catch (e) { global.__PLANT_ROLLUP__ = 'err'; }",
    ].join('\n'),
  },

  // ══ THE SAME CRON LEAK, MADE VISIBLE — TO SEPARATE TWO DIFFERENT HOLES ══
  {
    id: 'cron-digest-visible',
    what: 'The identical cross-tenant rollup, but surfaced in the RESULT runOnce returns instead of kept internal.',
    why: 'Run BESIDE cron-digest so the escape can be attributed precisely. If this one is CAUGHT and cron-digest is not, then the cron modules ARE reachable (through GET /api/admin/reminders/cron-preview, which REGISTER 2 drives in dry mode) and what escapes is specifically a leak that goes into an EMAIL rather than into a response body. If BOTH escape, the cron surface is not reached at all. Do not report an escape without knowing which.',
    caught_by: 'MEASURED BY THIS RUN.',
    file: DIGEST,
    suites: [REG2],
    expect: 'MEASURE',
    find: "  const plan = [];",
    replace: [
      "  const plan = [];",
      "  {",
      "    const _x = await pool.query('SELECT organization_id, COUNT(*) AS n FROM jobs GROUP BY organization_id');",
      "    plan.push({ orgId: 'PLATFORM', name: _x.rows.map((r) => r.organization_id + ':' + r.n).join(','), wouldFire: false });",
      "  }",
    ].join('\n'),
  },

  // ══ REGISTER 4 — WHAT THE MODEL IS HANDED. NAMED, NOT CLAIMED. ════════
  {
    id: 'model-context',
    what: 'buildEstimateContext pastes EVERY tenant\'s recent estimates into the prompt the model is given.',
    why: 'Nothing this harness measures ever sees a prompt. The conformance suite\'s SDK mock is `{ messages: {}, beta: {} }` and RECORDS NOTHING, and no context builder is driven by any register.',
    caught_by: 'NOTHING, predicted. This plant exists to prove the hole is real rather than theoretical, and to size Register 4.',
    file: AI,
    suites: [CONF, REG2, DOORS],
    expect: 'ESCAPES',
    find: "async function buildEstimateContext(",
    replace: [
      "async function _plantPortfolio() {",
      "  const r = await pool.query('SELECT id, data FROM estimates ORDER BY updated_at DESC LIMIT 20');",
      "  return 'PORTFOLIO CONTEXT: ' + r.rows.map((x) => x.id + ' ' + JSON.stringify(x.data)).join(' | ');",
      "}",
      "",
      "async function buildEstimateContext(",
    ].join('\n'),
  },

  // ══ P9 — A STRING-ID LEAK ON AN ARM-3-EXEMPT DOOR ═════════════════════
  {
    id: 'nd-string-id',
    what: 'create_property — ledgered non-deterministic, so Arm 3 skips it — leaks org B\'s TEXT ids, which carry neither the marker nor a number in the poison band.',
    why: 'The audit named this: a door exempt from Arm 3 that leaks in string-id form evades all three original arms at once. Org B\'s text ids are `<table>-B-1`, and neither ZZVICTIMBRAVO nor [9e8,1e9) appears in one.',
    caught_by: 'MEASURED BY THIS RUN. Arm 0 may or may not see it, since it compares against a starved world rather than looking for a marker.',
    file: AI,
    suites: [CONF],
    expect: 'MEASURE',
    find: "async function execClientDirectoryTool(name, input, ctx) {",
    replace: [
      "async function execClientDirectoryTool(name, input, ctx) {",
      "  if (name === 'create_property') {",
      "    const _p = await pool.query('SELECT id FROM clients ORDER BY id LIMIT 10');",
      "    return 'Created property. Existing: ' + _p.rows.map((r) => r.id).join(',');",
      "  }",
    ].join('\n'),
  },
];

// ── the runner ───────────────────────────────────────────────────────────
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function edits(plant) {
  return [{ file: plant.file, find: plant.find, replace: plant.replace }].concat(plant.also || []);
}

// LINE ENDINGS ARE NOT PART OF THE PLANT. This repo carries a mix — ai-routes.js
// is CRLF, weekly-digest-cron.js is LF — and git rewrites them on checkout, so
// a multi-line `find` written with \n matches zero times in half the files and
// the runner (correctly) refuses. That refusal is the guard working, and it is
// also a false negative about the PLANT: the defect is real, the search string
// was spelled for a different checkout. So both sides are converted to whatever
// the target file actually uses before anything is compared.
function toFileEol(text, sample) {
  const crlf = sample.indexOf('\r\n') !== -1;
  const lf = text.replace(/\r\n/g, '\n');
  return crlf ? lf.replace(/\n/g, '\r\n') : lf;
}

function apply(plant) {
  const before = new Map();
  for (const e of edits(plant)) {
    const p = F(e.file);
    if (!before.has(e.file)) before.set(e.file, { sha: sha(p), text: fs.readFileSync(p, 'utf8') });
  }
  // VALIDATE EVERY EDIT BEFORE WRITING ANY OF THEM. A plant that applies half
  // of itself is neither the defect nor the original.
  const staged = new Map();
  for (const e of edits(plant)) {
    const cur = staged.has(e.file) ? staged.get(e.file) : before.get(e.file).text;
    const find = toFileEol(e.find, cur);
    const repl = toFileEol(e.replace, cur);
    const n = cur.split(find).length - 1;
    if (n !== 1) {
      throw new Error('REFUSED: plant ' + plant.id + ' matched ' + n + ' times in ' + e.file
        + ' (needs exactly 1). Nothing was written.');
    }
    staged.set(e.file, cur.replace(find, repl));
  }
  for (const [file, text] of staged) fs.writeFileSync(F(file), text);
  return before;
}

function restore(before) {
  const bad = [];
  for (const [file, rec] of before) {
    fs.writeFileSync(F(file), rec.text);
    const now = sha(F(file));
    if (now !== rec.sha) bad.push(file + ' expected ' + rec.sha + ' got ' + now);
  }
  if (bad.length) {
    throw new Error('RESTORE FAILED — the working tree still carries a plant:\n  ' + bad.join('\n  '));
  }
}

function runSuites(names) {
  const env = Object.assign({}, process.env, {
    JWT_SECRET: process.env.JWT_SECRET || 'plant-runner-secret-with-at-least-32-characters',
  });
  try {
    execFileSync(process.execPath, [
      'node_modules/jest/bin/jest.js', '--roots=./test',
      '--testPathPatterns', names.join('|'),
    ], { cwd: ROOT, env, stdio: 'pipe', timeout: 600000 });
    return { red: false, tail: '' };
  } catch (e) {
    const out = String((e.stdout || '') + (e.stderr || ''));
    const m = out.match(/^\s*●\s+.+$/gm) || [];
    return { red: true, tail: m.slice(0, 6).join('\n    ') };
  }
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'list' || !cmd) {
    for (const p of PLANTS) console.log(p.id.padEnd(22) + p.expect.padEnd(9) + p.what.slice(0, 90));
    return;
  }
  if (cmd !== 'run') { console.error('usage: tenant-plants.js list | run <id|all>'); process.exit(2); }
  const chosen = arg === 'all' || !arg ? PLANTS : PLANTS.filter((p) => p.id === arg);
  if (!chosen.length) { console.error('no such plant: ' + arg); process.exit(2); }

  const results = [];
  for (const plant of chosen) {
    let before = null;
    try {
      before = apply(plant);
      const shas = [...before.keys()].map((f) => f + ' ' + sha(F(f)).slice(0, 12)).join(' | ');
      const r = runSuites(plant.suites);
      results.push({ id: plant.id, expect: plant.expect, red: r.red, tail: r.tail, shas });
      console.log((r.red ? 'RED   ' : 'GREEN ') + plant.id.padEnd(22)
        + '[' + plant.expect + '] suites=' + plant.suites.join(',') + '  planted:' + shas);
      if (r.red) console.log('    ' + r.tail);
    } finally {
      if (before) restore(before);
    }
  }
  console.log('\n— summary —');
  for (const r of results) {
    const verdict = r.expect === 'CAUGHT' ? (r.red ? 'ok (caught)' : 'FAILURE — the harness did not see it')
      : r.expect === 'ESCAPES' ? (r.red ? 'unexpected: it WAS caught' : 'confirmed: escapes')
        : (r.red ? 'measured: CAUGHT' : 'measured: ESCAPES');
    console.log('  ' + r.id.padEnd(22) + verdict);
  }
}

if (require.main === module) main();
module.exports = { PLANTS };
