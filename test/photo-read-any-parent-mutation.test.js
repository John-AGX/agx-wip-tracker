// MUTATION TESTS FOR THE ANY-PARENT PHOTO READ.
//
// ── WHY ───────────────────────────────────────────────────────────────────
// Every refusal asserted in test/photo-read-any-parent.test.js is a string
// match, and a string match is satisfied by the string — not by the behaviour
// behind it. This repo has a documented class of assertions that pass four
// silent ways, so each guard is REMOVED from a copy of the shipped source, the
// copy is loaded as a real module, and the same drive is shown to produce the
// exact wrong outcome the guard exists to prevent.
//
// ── THE CRLF TRAP ─────────────────────────────────────────────────────────
// The repo is core.autocrlf=true. An LF-anchored replace against CRLF bytes
// changes NOTHING and returns the original string, at which point the "mutant"
// is the shipped code and the mutation test passes having proved nothing.
// mutate() normalises the anchor to the file's real line endings, refuses if
// the anchor is absent, and refuses if the bytes did not move.
//
// ── WHERE THE MUTANT LIVES, AND WHY NOT IN THE REPO ───────────────────────
// Several suites walk server/ and test/ for source (agent-instruction-honesty,
// ai-personal-surface-tenant, ai-read-predicate-invariant, schema-truth…), and
// with jest running workers in parallel a transient file inside the tree is
// intermittently censused by one of them — a flake THIS file would have
// manufactured, which is worse than the defect it tests. So the copy goes to
// the OS temp dir, and every require in it is rewritten to an absolute path
// first: relative specifiers resolve against the real file's directory (so the
// mutant shares the same db pool, the same auth role cache and the same
// singletons), and bare third-party specifiers are pointed at the repo's own
// node_modules, which a file outside the tree could not otherwise reach.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const REPO = path.join(__dirname, '..');
const REAL = path.join(REPO, 'server', 'routes', 'ai-routes.js');
const REAL_DIR = path.dirname(REAL);
const SOURCE = fs.readFileSync(REAL, 'utf8');
const BUILTINS = new Set(require('module').builtinModules);
const abs = (p) => p.split(path.sep).join('/');

function absolutizeRequires(src) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (m, q, spec) => {
    if (spec.startsWith('.')) return `require(${q}${abs(path.resolve(REAL_DIR, spec))}${q})`;
    if (BUILTINS.has(spec) || spec.startsWith('node:')) return m;
    return `require(${q}${abs(path.join(REPO, 'node_modules', spec))}${q})`;
  });
}

const mutantPaths = [];
function mutate(pairs) {
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    if (out.indexOf(f) === -1) {
      throw new Error('MUTATION ANCHOR NOT FOUND — the guard moved or the line endings differ. Anchor:\n' + JSON.stringify(f.slice(0, 240)));
    }
    const next = out.split(f).join(r);
    // THE BYTES MOVED. Not negotiable: a no-op replace is how a mutation test
    // "passes" having proved nothing.
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + f.slice(0, 80));
    out = next;
  }
  const p = path.join(os.tmpdir(), '_p86_photoread_mutant_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out), 'utf8');
  mutantPaths.push(p);
  // ai-routes arms a setInterval at module load; faking the clock across the
  // require drops it so the worker can still exit.
  jest.useFakeTimers();
  let m;
  try { m = require(p); } finally { jest.useRealTimers(); }
  return m.internals;
}

// ── the world ─────────────────────────────────────────────────────────────
const TABLES = ['attachments', 'leads', 'jobs', 'projects', 'tasks', 'users',
                'organizations', 'roles'];
const CAPS_PM        = JSON.stringify(['ESTIMATES_VIEW', 'LEADS_VIEW', 'LEADS_EDIT', 'JOBS_VIEW_ALL', 'JOBS_EDIT_ANY']);
const CAPS_LEADSONLY = JSON.stringify(['ESTIMATES_VIEW', 'LEADS_VIEW', 'LEADS_EDIT']);

let eng, auth, shipped;

function seed() {
  eng.db.exec(`
    DELETE FROM attachments; DELETE FROM leads; DELETE FROM jobs;
    DELETE FROM projects; DELETE FROM tasks; DELETE FROM users;
    DELETE FROM organizations; DELETE FROM roles;
    INSERT INTO roles (name, capabilities) VALUES ('pm','${CAPS_PM}'),('leadsonly','${CAPS_LEADSONLY}');
    INSERT INTO organizations (id, name) VALUES (1,'AGX'),(2,'Rival Co');
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10,'John','j@agx.test','pm',1),(11,'Vera','v@agx.test','leadsonly',1),
      (20,'Rival PM','r@rival.test','pm',2),(30,'Dana','d@agx.test','pm',1);
    INSERT INTO leads (id, title, organization_id) VALUES ('l1','Waterside – Gazebo Wood Repairs',1),('l9','Rival Lead',2);
    INSERT INTO jobs (id, data, organization_id) VALUES ('j1','{"jobNumber":"25-100"}',1);
    INSERT INTO attachments (id, entity_type, entity_id, filename, caption, tags, organization_id, uploaded_by, uploaded_at, mime_type, size_bytes)
      VALUES ('att_l1_a','lead','l1','IMG_0001.jpg',NULL,'[]',1,10,'2026-09-08 08:00:00','image/jpeg',4000),
             ('att_j1_a','job','j1','JOB_0001.jpg',NULL,'[]',1,10,'2026-09-08 08:00:00','image/jpeg',4000),
             ('att_l9_a','lead','l9','RIVAL_LEAD.jpg','their words','[]',2,20,'2026-09-08 08:00:00','image/jpeg',4000),
             ('att_user_a','user','10','PRIVATE.jpg',NULL,'[]',1,10,'2026-09-08 08:00:00','image/jpeg',1000),
             ('att_user_d','user','30','DANA_PAYSTUB.jpg',NULL,'[]',1,30,'2026-09-08 08:00:00','image/jpeg',1000);
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['tags', 'capabilities'] });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  jest.useFakeTimers();
  auth = require('../server/auth');
  shipped = require('../server/routes/ai-routes').internals;
  jest.useRealTimers();
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
});

const flush = () => new Promise((r) => setTimeout(r, 25));
afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
  for (const p of mutantPaths) { try { fs.unlinkSync(p); } catch (_) {} }
});
beforeEach(() => seed());

const CTX_A = { userId: 10, orgId: 1, user: { id: 10, role: 'pm', organization_id: 1 } };
const VERA = { id: 11, role: 'leadsonly', organization_id: 1 };
const run = (api, input) => api.execAgentTool('read_project_photos', input, CTX_A);

/* ═══════════════════════════════════════════════════════════════════════════
 * GUARD 1 — THE TENANCY PREDICATE.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the parent-in-org predicate is load-bearing', () => {
  test('GREEN shipped: a foreign lead refuses and names nothing of theirs', async () => {
    const a = await run(shipped, { entity_type: 'lead', entity_id: 'l9' });
    expect(a).toBe('No lead l9 in your organization.');
    expect(a).not.toContain('RIVAL_LEAD.jpg');
  });

  test('RED mutant: with the predicate removed, org A reads org B\'s lead photos', async () => {
    const m = mutate([[
      "    const { attachmentEntityInOrg } = require('../services/attachment-org-scope');\n" +
      "    if (!(await attachmentEntityInOrg(pool, parentType, parentId, orgId))) {\n" +
      "      return `No ${parentType} ${parentId} in your organization.`;\n" +
      "    }",
      "    // MUTANT: tenancy predicate removed.",
    ]]);
    const leaked = await run(m, { entity_type: 'lead', entity_id: 'l9' });
    expect(leaked).toContain('1 photo on lead l9.');
    expect(leaked).toContain('RIVAL_LEAD.jpg');
    expect(leaked).toContain('their words');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * GUARD 2 — THE PARENT ALLOWLIST (which is what keeps the personal My Files
 * bucket out of a tool that has no per-row owner check).
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the parent allowlist is load-bearing', () => {
  test('GREEN shipped: the user bucket is refused and no private filename appears', async () => {
    let msg = '';
    try { await run(shipped, { entity_type: 'user', entity_id: '10' }); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/owner\/member buckets/);
    expect(msg).not.toContain('PRIVATE.jpg');
  });

  test("RED mutant: with the allowlist removed, one user reads another's private files", async () => {
    const m = mutate([[
      "    if (!PHOTO_PARENT_TYPES.has(parentType)) throw new Error(photoParentRefusal(parentType));",
      "    // MUTANT: parent allowlist removed.",
    ]]);
    // DANA'S personal bucket (user 30), read by JOHN (user 10, the caller in
    // CTX_A) — a different person in the SAME org. That distinction is the
    // whole test: this drive previously named user 10, i.e. the caller
    // reading their OWN My Files, which is not the disclosure the allowlist
    // exists to stop and would have passed with no allowlist worth having.
    // entityOrgVerdict('user') answers on the OWNING user's tenant, so the
    // tenancy predicate says 'in' and nothing else stands in the way — which
    // is precisely why the allowlist, and not the tenancy check, is what
    // protects another person's private files here.
    const leaked = await run(m, { entity_type: 'user', entity_id: '30' });
    expect(leaked).toContain('1 photo on user 30.');
    expect(leaked).toContain('DANA_PAYSTUB.jpg');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * GUARD 3 — THE PER-PARENT CAPABILITY.
 *
 * The mutation is the code as it SHIPPED before this change: a flat
 * 'LEADS_VIEW' for the whole tool. That is not a strawman — it is the exact
 * previous state, and it is what let a user with no jobs capability read a
 * job's photos the moment the read learned about jobs.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the per-parent capability is load-bearing', () => {
  test('GREEN shipped: a LEADS_VIEW-only user is denied a job\'s photos', () => {
    const denial = shipped.aiToolCapabilityDenial(
      'read_project_photos', { entity_type: 'job', entity_id: 'j1' }, VERA);
    expect(denial).toMatch(/Permission denied/);
    expect(denial).toMatch(/JOBS_VIEW_ALL or JOBS_VIEW_ASSIGNED/);
    // …and the same user on a LEAD is allowed, so the denial is about the
    // parent and not about the user being denied everything.
    expect(shipped.aiToolCapabilityDenial(
      'read_project_photos', { entity_type: 'lead', entity_id: 'l1' }, VERA)).toBe(null);
  });

  test('RED mutant: with the flat gate restored, that user is allowed the job', async () => {
    const m = mutate([[
      "  // Per-parent, for the reason stated above photoReadCapability.\n" +
      "  if (name === 'read_project_photos') return photoReadCapability(input || {});",
      "  // MUTANT: the flat pre-change gate.\n" +
      "  if (name === 'read_project_photos') return 'LEADS_VIEW';",
    ]]);
    expect(m.aiToolCapabilityDenial(
      'read_project_photos', { entity_type: 'job', entity_id: 'j1' }, VERA)).toBe(null);
    // And the gate being open is not theoretical — the executor then hands the
    // job's photo over.
    const seen = await run(m, { entity_type: 'job', entity_id: 'j1' });
    expect(seen).toContain('JOB_0001.jpg');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * GUARD 4 — ONE SENTENCE FOR "FOREIGN" AND FOR "ABSENT".
 *
 * Two different refusals is a cross-tenant existence oracle, and a patch in
 * this repo shipped one. The mutant is the plausible-looking version: ask the
 * verdict, and say "no such X" when nothing is there.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the refusal does not distinguish absent from foreign', () => {
  const FOREIGN = { entity_type: 'lead', entity_id: 'l9' };

  test('GREEN shipped: same id, two worlds, identical bytes', async () => {
    const foreign = await run(shipped, FOREIGN);
    eng.db.exec("DELETE FROM attachments WHERE entity_id='l9'");
    eng.db.exec("DELETE FROM leads WHERE id='l9'");
    const absent = await run(shipped, FOREIGN);
    expect(absent).toBe(foreign);
  });

  test('RED mutant: a verdict-aware refusal tells the caller which one it was', async () => {
    const m = mutate([[
      "      return `No ${parentType} ${parentId} in your organization.`;",
      "      const { entityOrgVerdict: _v } = require('../services/attachment-org-scope');\n" +
      "      if ((await _v(pool, parentType, parentId, orgId)) === 'unknown') return `No such ${parentType} ${parentId}.`;\n" +
      "      return `No ${parentType} ${parentId} in your organization.`;",
    ]]);
    const foreign = await run(m, FOREIGN);
    eng.db.exec("DELETE FROM attachments WHERE entity_id='l9'");
    eng.db.exec("DELETE FROM leads WHERE id='l9'");
    const absent = await run(m, FOREIGN);
    expect(foreign).toBe('No lead l9 in your organization.');
    expect(absent).toBe('No such lead l9.');
    // The oracle: the pair of answers tells an outsider that l9 exists
    // somewhere, which is precisely what the shipped code refuses to say.
    expect(absent).not.toBe(foreign);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HARNESS ITSELF IS NOT VACUOUS.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the mutation harness would notice if it stopped mutating', () => {
  test('an anchor that is not in the file is a FAILURE, not a silent pass', () => {
    expect(() => mutate([['this text is not in ai-routes.js', 'x']]))
      .toThrow(/MUTATION ANCHOR NOT FOUND/);
  });

  test('a replace that changes no bytes is a FAILURE', () => {
    expect(() => mutate([["  if (name === 'read_project_photos') return photoReadCapability(input || {});",
                         "  if (name === 'read_project_photos') return photoReadCapability(input || {});"]]))
      .toThrow(/MUTATION CHANGED NO BYTES/);
  });

  test('the source really is CRLF, which is what the normalisation is for', () => {
    expect(SOURCE.indexOf('\r\n')).toBeGreaterThan(-1);
  });

  test('every mutant that loaded is a DIFFERENT module object from the shipped one', () => {
    const m = mutate([["    // PARENT-AGNOSTIC, for the reason stated at PHOTO_PARENT_TYPES.",
                       "    // MUTANT MARKER"]]);
    expect(m).not.toBe(shipped);
    expect(typeof m.execAgentTool).toBe('function');
  });
});
