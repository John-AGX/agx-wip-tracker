// MUTATION TESTS FOR THE PHOTO-CAPTION WRITE DOOR.
//
// ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
// A guard that has never been observed to FIRE is a guard nobody has evidence
// for. This repo has a documented class of "vacuous assertions" — tests that
// pass four silent ways — and the specific way this one would go quiet is
// obvious: every refusal in the sibling file is a string match, and a string
// match is satisfied by the string, not by the behaviour.
//
// So each guard is REMOVED from a copy of the shipped source, the copy is
// loaded as a real module, and the same drive is shown to produce the exact
// wrong outcome the guard exists to prevent. Green here means: the guard was
// load-bearing, and the test that covers it goes red for the right reason.
//
// ── THE CRLF TRAP, WHICH THIS FILE WOULD OTHERWISE WALK INTO ──────────────
// The repo is checked out with core.autocrlf=true, so a source file on disk
// may be CRLF while a literal written in a test is LF. An LF-anchored
// String.replace against CRLF bytes changes NOTHING and returns the original
// string — at which point the "mutant" is the shipped code, the drive behaves
// correctly, and a mutation test PASSES having proved nothing whatsoever. That
// is the same defect class in a new costume.
//
// mutate() therefore asserts the bytes actually moved, every time, and prints
// the anchor it could not find. A mutation that fails to apply is a test
// FAILURE here, never a silent pass.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const SERVICES = path.join(__dirname, '..', 'server', 'services');
const REAL = path.join(SERVICES, 'payload-dispatcher.js');
const SOURCE = fs.readFileSync(REAL, 'utf8');

const TABLES = ['attachments', 'projects', 'users', 'organizations', 'roles',
                'project_activity', 'org_tags'];
const CAPS_PM = JSON.stringify(['LEADS_VIEW', 'LEADS_EDIT', 'JOBS_EDIT_ANY']);
const CAPS_VIEW = JSON.stringify(['LEADS_VIEW']);

let eng;
let auth;

function seed() {
  eng.db.exec(`
    DELETE FROM attachments; DELETE FROM projects; DELETE FROM users;
    DELETE FROM organizations; DELETE FROM roles; DELETE FROM project_activity;
    INSERT INTO roles (name, capabilities) VALUES ('pm','${CAPS_PM}'),('viewer','${CAPS_VIEW}');
    INSERT INTO organizations (id, name) VALUES (1,'AGX'),(2,'Rival Co');
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10,'John','j@agx.test','pm',1),(11,'Vera','v@agx.test','viewer',1);
    INSERT INTO projects (id, name, organization_id) VALUES ('p1','Maple St',1),('p9','Rival',2);
    INSERT INTO attachments (id, entity_type, entity_id, filename, caption, tags, organization_id, uploaded_by, mime_type)
      VALUES ('a1','project','p1','IMG_0001.jpg',NULL,'[]',1,10,'image/jpeg'),
             ('a2','project','p1','IMG_0002.jpg',NULL,'[]',1,10,'image/jpeg'),
             ('zz1','project','p9','RIVAL.jpg','their words','[]',2,20,'image/jpeg');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['tags', 'capabilities', 'detail'] });
  eng.db.function('hashtext', (s) => { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; });
  eng.db.function('pg_advisory_xact_lock', (_k) => 1);
  eng.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tags_ci_name ON org_tags (organization_id, LOWER(name))');
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
});

// recordActivity is fire-and-forget (it does not return its promise), so a
// late rejection can console.warn AFTER the engine is closed — a warning jest
// reports as "Cannot log after tests are done", i.e. a flake this file would
// have manufactured. Let the microtask/immediate queue drain first.
const flush = () => new Promise((r) => setTimeout(r, 25));
afterAll(async () => {
  await flush();
  // server/routes/project-routes.js schedules an unref'd 9s boot timer
  // (backfillProjectGeocodes). A suite that runs longer than 9 seconds sees it
  // fire against an engine this file has closed, and jest reports the
  // resulting console.error as 'Cannot log after tests are done' — a flake
  // this file would have manufactured. Point the module pool at a silent stub
  // BEFORE closing, so the late query is a no-op.
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});
beforeEach(() => seed());

// ── mutate(): remove ONE guard, load the result, hand back its dispatcher ──
//
// THE MUTANT LIVES OUTSIDE THE REPO, and that is not incidental. The obvious
// place to drop it is server/services/ — the module's own requires are
// relative ('./attachment-org-scope', '../db') and resolve there for free.
// Doing that put a transient _mutant_*.js inside a directory that OTHER
// suites census: test/ai-personal-surface-tenant.test.js and
// test/agent-instruction-honesty.test.js both walk server/ for source, and
// with jest running workers in parallel they intermittently caught a file that
// existed for two hundred milliseconds. Both passed alone and failed in a full
// run — a flake manufactured by this file, which is a worse defect than the
// one it is testing.
//
// So the copy goes to the OS temp dir and its relative requires are rewritten
// to absolute paths first. Same modules, same singletons (the require cache is
// keyed on the resolved path), nothing written anywhere the repo is scanned.
const os = require('os');
const SERVER = path.join(__dirname, '..', 'server');
const abs = (p) => p.split(path.sep).join('/');

// './x' -> <server>/services/x ; '../x' -> <server>/x. Absolute paths resolve
// identically from anywhere, so the mutant loads the SAME attachment-org-scope
// and the SAME db pool the shipped module does.
function absolutizeRequires(src) {
  return src
    .replace(/require\('\.\/([^']+)'\)/g, (_m, p) => `require('${abs(SERVICES)}/${p}')`)
    .replace(/require\('\.\.\/([^']+)'\)/g, (_m, p) => `require('${abs(SERVER)}/${p}')`);
}

let mutantPaths = [];

// Some defects only exist as a COMBINATION of two removed guards — the
// activity-feed source is one: with the tag cap still on, the ask that
// diverged from the column is refused before the writer ever sees it, so
// mutating the source line alone would prove nothing. mutatePairs() applies
// several anchors to ONE module and holds every one of them to the same two
// rules mutate() does: the anchor must be present, and the bytes must move.
function mutatePairs(pairs) {
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    if (out.indexOf(f) === -1) {
      throw new Error('MUTATION ANCHOR NOT FOUND. Anchor:\n' + JSON.stringify(f.slice(0, 200)));
    }
    const next = out.split(f).join(String(replace).replace(/\r?\n/g, eol));
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + f.slice(0, 60));
    out = next;
  }
  const p = path.join(os.tmpdir(), '_p86_mutant_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out), 'utf8');
  mutantPaths.push(p);
  return require(p);
}

function mutate(find, replace) {
  // Normalise the anchor to whatever the file on disk actually uses, so an
  // LF literal still matches CRLF bytes. Without this the replace is a no-op
  // and every assertion below passes against UNMUTATED code.
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const f = String(find).replace(/\r?\n/g, eol);
  const r = String(replace).replace(/\r?\n/g, eol);
  if (SOURCE.indexOf(f) === -1) {
    throw new Error('MUTATION ANCHOR NOT FOUND — the guard moved or the ' +
      'line endings differ. Anchor:\n' + JSON.stringify(f.slice(0, 200)));
  }
  const mutated = SOURCE.split(f).join(r);
  // THE BYTES MOVED. Not negotiable: a no-op replace is how a mutation test
  // "passes" having proved nothing.
  if (mutated === SOURCE) throw new Error('MUTATION CHANGED NO BYTES');
  const p = path.join(os.tmpdir(), '_p86_mutant_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(mutated), 'utf8');
  mutantPaths.push(p);
  return require(p);
}

afterEach(async () => {
  // Drain any fire-and-forget warn from a mutant before its file is unlinked
  // and its module cache entry dropped, or jest reports "Cannot log after
  // tests are done" — a flake this file would have manufactured.
  await flush();
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* not loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

const OWN = { userId: 10, organizationId: 1 };
const VIEWER = { userId: 11, organizationId: 1 };

async function driveWith(mod, ops, ctx, extra) {
  const target = Object.assign({ entity_type: 'attachment', ops }, extra || {});
  try { mod.validateTarget(target, 0); }
  catch (e) { return { stage: 'emit', message: e.message }; }
  const client = await eng.pool.connect();
  // Same model the sibling door file uses: applyPayload hands the dispatcher a
  // ctx.afterCommit buffer and drains it after COMMIT, so a successful target
  // here drains it and a refusal never does. (The TRANSACTION half of that
  // property needs two connections and lives in
  // test/attachment-photo-updates-rollback.test.js.)
  const afterCommit = [];
  const useCtx = Object.assign({}, ctx, { afterCommit });
  try {
    const res = await mod.internals.dispatchAttachment(client, target, {}, useCtx);
    for (const fn of afterCommit) await fn();
    return { stage: 'applied', res };
  } catch (e) { return { stage: 'apply', message: e.message }; }
}

const capOf = (id) => eng.all('SELECT caption FROM attachments WHERE id = ?', id)[0].caption;

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HARNESS ITSELF, FIRST. If mutate() cannot actually mutate, every test
 * below is decoration.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the mutation harness is not the thing being fooled', () => {
  test('an anchor that is not in the file THROWS instead of passing quietly', () => {
    expect(() => mutate('this string is nowhere in the dispatcher', 'x'))
      .toThrow(/MUTATION ANCHOR NOT FOUND/);
  });

  test('an anchor whose replacement is identical THROWS instead of passing quietly', () => {
    const anchor = 'const PHOTO_CAPTION_CAP = 2000;';
    expect(() => mutate(anchor, anchor)).toThrow(/MUTATION CHANGED NO BYTES/);
  });

  test('a real mutation loads and behaves DIFFERENTLY from the shipped module', async () => {
    const real = require('../server/services/payload-dispatcher');
    const mut = mutate('const PHOTO_UPDATES_CAP = 60;', 'const PHOTO_UPDATES_CAP = 1;');
    expect(mut).not.toBe(real);
    const two = { photo_updates: [
      { attachment_id: 'a1', caption: 'x' }, { attachment_id: 'a2', caption: 'y' }] };
    expect((await driveWith(real, two, OWN)).stage).toBe('applied');
    seed();
    expect((await driveWith(mut, two, OWN)).message).toMatch(/the cap is 1 per target/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * EVERY GUARD, REMOVED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('remove the unresolvable-id refusal and an id that resolves to nothing goes quiet', () => {
  test('without it, a ghost id is skipped and the batch still reports success', async () => {
    // The mutation is a SILENT SKIP, not a deletion of the branch: skipping is
    // what the shipped attach_files does with an id that misses, and it is the
    // outcome this refusal exists to replace. (Deleting the branch outright
    // would only produce a TypeError on the next line, which proves nothing —
    // a crash is not the failure mode anyone ships.)
    const mut = mutate(
      '    const inOrg = att ? await attachmentInOrg(dbClient, att, orgId) : false;\n' +
      '    if (!att || !inOrg) {',
      '    const inOrg = att ? await attachmentInOrg(dbClient, att, orgId) : false;\n' +
      '    if (!att || !inOrg) { continue; }\n' +
      '    if (false) {');
    const r = await driveWith(mut, { photo_updates: [
      { attachment_id: 'a1', caption: 'real' },
      { attachment_id: 'ghost', caption: 'nowhere' }] }, OWN);
    // THE DEFECT, RESTORED: it applies, it reports a success summary, and the
    // photo the user asked about was never touched and never mentioned.
    expect(r.stage).toBe('applied');
    expect(r.res.photos).toBe(1);
    expect(r.res.summary).toBe('1 photo: 1 description updated');
    expect(eng.count("SELECT 1 FROM attachments WHERE id='ghost'")).toBe(0);

    // ...and the SHIPPED module refuses the identical drive, naming the id.
    seed();
    const real = await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [
        { attachment_id: 'a1', caption: 'real' },
        { attachment_id: 'ghost', caption: 'nowhere' }] }, OWN);
    expect(real.stage).toBe('apply');
    expect(real.message).toMatch(/no such photo — attachment_id="ghost"/);
    expect(capOf('a1')).toBeNull();
  });
});

describe('remove the tenancy predicate and another tenant\'s photo is rewritten', () => {
  test('without attachmentInOrg, org 1 overwrites org 2\'s caption with a 200-shaped success', async () => {
    const mut = mutate(
      'const inOrg = att ? await attachmentInOrg(dbClient, att, orgId) : false;',
      'const inOrg = !!att;');
    const r = await driveWith(mut, { photo_updates: [{ attachment_id: 'zz1', caption: 'HIJACKED' }] }, OWN);
    expect(r.stage).toBe('applied');
    expect(capOf('zz1')).toBe('HIJACKED');       // the cross-tenant write, live

    seed();
    const real = await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [{ attachment_id: 'zz1', caption: 'HIJACKED' }] }, OWN);
    expect(real.stage).toBe('apply');
    expect(capOf('zz1')).toBe('their words');
  });
});

describe('remove the capability check and a view-only role writes captions', () => {
  test('without actorHoldsCapability, LEADS_VIEW alone is enough to describe a photo', async () => {
    const mut = mutate(
      '    if (!actorHoldsCapability(actor, cap, att)) {',
      '    if (false) { const cap2 = cap;');
    const r = await driveWith(mut, { photo_updates: [{ attachment_id: 'a1', caption: 'viewer wrote this' }] }, VIEWER);
    expect(r.stage).toBe('applied');
    expect(capOf('a1')).toBe('viewer wrote this');

    seed();
    const real = await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [{ attachment_id: 'a1', caption: 'viewer wrote this' }] }, VIEWER);
    expect(real.stage).toBe('apply');
    expect(real.message).toMatch(/requires LEADS_EDIT/);
    expect(capOf('a1')).toBeNull();
  });

  test('turn the __owner__ sentinel back into a bare pass and private files open up', async () => {
    // The first draft of this arm returned `true` for '__owner__' on the
    // reasoning that attachmentInOrg had already settled the tenant. It had —
    // and the tenant is not the question a personal-files bucket asks.
    eng.db.exec("INSERT INTO attachments (id, entity_type, entity_id, filename, caption, tags, organization_id, uploaded_by, mime_type)" +
      " VALUES ('theirs','user','11','VERA.jpg',NULL,'[]',1,11,'image/jpeg')");
    const mut = mutate(
      '    if (!att) return false;\n' +
      '    if (auth.isAdminish(actor)) return true;\n' +
      '    return String(att.entity_id) === String(actor.id);',
      '    return true;');
    const r = await driveWith(mut, { photo_updates: [{ attachment_id: 'theirs', caption: 'read your files' }] }, OWN);
    expect(r.stage).toBe('applied');
    expect(capOf('theirs')).toBe('read your files');

    seed();
    eng.db.exec("INSERT INTO attachments (id, entity_type, entity_id, filename, caption, tags, organization_id, uploaded_by, mime_type)" +
      " VALUES ('theirs','user','11','VERA.jpg',NULL,'[]',1,11,'image/jpeg')");
    const real = await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [{ attachment_id: 'theirs', caption: 'read your files' }] }, OWN);
    expect(real.stage).toBe('apply');
    expect(capOf('theirs')).toBeNull();
  });

  test('and the FAIL-CLOSED arm matters: make the auth load fail and the write must still refuse', async () => {
    const mut = mutate(
      "  try { auth = require('../auth'); }",
      "  try { auth = require('../auth-does-not-exist'); }");
    const r = await driveWith(mut, { photo_updates: [{ attachment_id: 'a1', caption: 'no auth module' }] }, OWN);
    expect(r.stage).toBe('apply');
    expect(capOf('a1')).toBeNull();
  });
});

describe('remove the caption cap and an unbounded string reaches the column', () => {
  test('without it a 2001-char caption is stored, and every later read pays for it', async () => {
    const mut = mutate(
      '        if (u.caption.length > PHOTO_CAPTION_CAP) {',
      '        if (false) {');
    const long = 'x'.repeat(2001);
    const r = await driveWith(mut, { photo_updates: [{ attachment_id: 'a1', caption: long }] }, OWN);
    expect(r.stage).toBe('applied');
    expect(capOf('a1')).toHaveLength(2001);

    seed();
    const real = await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [{ attachment_id: 'a1', caption: long }] }, OWN);
    expect(real.stage).toBe('emit');
    expect(real.message).toMatch(/is 2001 chars — the cap is 2000/);
    // AND IT DOES NOT TRUNCATE. A silently-shortened description is a silent
    // success, which is the class this whole change is about.
    expect(capOf('a1')).toBeNull();
  });
});

describe('collapse resolve-then-write into one pass and the batch writes half of itself', () => {
  test('without the two passes, the good id commits before the bad one refuses', async () => {
    // The mutation moves the WRITE into pass 1 by making pass 2 iterate the
    // items as they are resolved — modelled here by resolving lazily: each
    // item is written the moment it resolves, so a later refusal leaves
    // earlier rows changed. That is what "do not catch per item" and
    // "resolve everything, then write" are there to stop.
    const mut = mutate(
      '  // ── PASS 2 — every id resolved and authorized; now write. ──',
      '  // MUTANT: write as we go.');
    // Rebuild the same effect by driving the mutant twice: it is the ORDERING
    // that is under test, so assert on the shipped module's all-or-nothing
    // property directly and on the mutant's per-item property via a partial
    // batch. (The mutant above only removes the comment, so it must behave
    // identically — which is itself the control that comments are not the
    // guard.)
    const both = { photo_updates: [
      { attachment_id: 'a1', caption: 'first' },
      { attachment_id: 'ghost', caption: 'second' }] };
    const r = await driveWith(mut, both, OWN);
    expect(r.stage).toBe('apply');
    expect(capOf('a1')).toBeNull();      // comment removal changes nothing

    // The REAL ordering guard: pass 1 resolves + authorizes EVERY id before
    // pass 2 writes. Remove it by writing inside pass 1.
    seed();
    const mut2 = mutate(
      '    resolved.push({ att, u, where });',
      '    resolved.push({ att, u, where });\n' +
      "    if (Object.prototype.hasOwnProperty.call(u, 'caption')) {\n" +
      "      await dbClient.query('UPDATE attachments SET caption = $1 WHERE id = $2', [u.caption, att.id]);\n" +
      '    }');
    const r2 = await driveWith(mut2, both, OWN);
    expect(r2.stage).toBe('apply');
    // HALF-APPLIED: a1 carries a caption from a batch that REFUSED.
    expect(capOf('a1')).toBe('first');

    seed();
    const real = await driveWith(require('../server/services/payload-dispatcher'), both, OWN);
    expect(real.stage).toBe('apply');
    expect(capOf('a1')).toBeNull();
  });
});

describe('remove the unknown-key refusal and an invented field is silently dropped', () => {
  test('without it, {description:"..."} writes nothing and nobody is told', async () => {
    const mut = mutate(
      '      const strayKeys = Object.keys(u).filter((k) => !PHOTO_UPDATE_KEYS.has(k));\n' +
      '      if (strayKeys.length) {',
      '      const strayKeys = Object.keys(u).filter((k) => !PHOTO_UPDATE_KEYS.has(k));\n' +
      '      if (false) {');
    // `description` instead of `caption` — the single most likely near-miss.
    const r = await driveWith(mut, { photo_updates: [
      { attachment_id: 'a1', description: 'North elevation', caption: 'ok' }] }, OWN);
    expect(r.stage).toBe('applied');
    expect(capOf('a1')).toBe('ok');   // the invented key vanished without a word

    seed();
    const real = await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [{ attachment_id: 'a1', description: 'North elevation', caption: 'ok' }] }, OWN);
    expect(real.stage).toBe('emit');
    expect(real.message).toMatch(/unknown key\(s\): 'description'/);
  });
});

// NOTE ON WHERE THE DRY-RUN / ROLLBACK MUTANTS LIVE.
// They are NOT in this file, and that is deliberate. The property is "an
// activity row written on the MODULE pool is not reachable by this
// transaction's ROLLBACK", and this file has ONE sqlite handle — with one
// connection the rollback takes the activity row with it, the mutant behaves
// exactly like the shipped module, and the mutation test passes having proved
// nothing. That is precisely the trap the first version of this door fell
// into. Those mutants are in test/attachment-photo-updates-rollback.test.js,
// which models the pool with TWO engines.

describe('remove the tag element checks and a wrong-shaped list wipes the photo\'s tags', () => {
  test('without them, [1,2,3] stores [] and still reports a tag set updated', async () => {
    // The behaviour executed on the first version of this door, verbatim:
    // asked [1,2,3] -> stored [] -> "1 photo: 1 tag set updated", on a photo
    // that had two real tags. Nothing asked for was written and two tags were
    // destroyed, reported as success.
    const mut = mutate(
      '        u.tags.forEach((t, ti) => {',
      '        [].forEach((t, ti) => {');
    eng.db.exec("UPDATE attachments SET tags = '[\"Framing\",\"Roofing\"]' WHERE id='a1'");
    const r = await driveWith(mut, { photo_updates: [{ attachment_id: 'a1', tags: [1, 2, 3] }] }, OWN);
    expect(r.stage).toBe('applied');
    expect(r.res.summary).toBe('1 photo: 1 tag set updated');
    expect(eng.all("SELECT tags FROM attachments WHERE id='a1'")[0].tags).toEqual([]);

    seed();
    eng.db.exec("UPDATE attachments SET tags = '[\"Framing\",\"Roofing\"]' WHERE id='a1'");
    const real = await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [{ attachment_id: 'a1', tags: [1, 2, 3] }] }, OWN);
    expect(real.stage).toBe('emit');
    expect(real.message).toMatch(/is a number, not a string/);
    expect(eng.all("SELECT tags FROM attachments WHERE id='a1'")[0].tags)
      .toEqual(['Framing', 'Roofing']);
  });

  test('remove the 20-tag cap and 25 tags silently become 20', async () => {
    const mut = mutate(
      '        if (u.tags.length > PHOTO_TAGS_CAP) {',
      '        if (false) {');
    const many = Array.from({ length: 25 }, (_, i) => 'Tag' + (i + 1));
    const r = await driveWith(mut, { photo_updates: [{ attachment_id: 'a1', tags: many }] }, OWN);
    expect(r.stage).toBe('applied');
    expect(eng.all("SELECT tags FROM attachments WHERE id='a1'")[0].tags).toHaveLength(20);

    seed();
    const real = await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [{ attachment_id: 'a1', tags: many }] }, OWN);
    expect(real.stage).toBe('emit');
    expect(real.message).toMatch(/holds 25 tags — the cap is 20/);
  });

  test('remove the 32-char tag cap and a 40-char tag silently becomes 32', async () => {
    const mut = mutate(
      '          if (c.length > PHOTO_TAG_CHARS_CAP) {',
      '          if (false) {');
    const long = 'A'.repeat(40);
    const r = await driveWith(mut, { photo_updates: [{ attachment_id: 'a1', tags: [long] }] }, OWN);
    expect(r.stage).toBe('applied');
    expect(eng.all("SELECT tags FROM attachments WHERE id='a1'")[0].tags).toEqual(['A'.repeat(32)]);

    seed();
    const real = await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [{ attachment_id: 'a1', tags: [long] }] }, OWN);
    expect(real.stage).toBe('emit');
    expect(real.message).toMatch(/is 40 chars — a tag caps at 32/);
  });
});

describe('compute the activity feed from the ASK and it records tags that are not on the row', () => {
  test('without nextTags, project_activity holds a string the column never received', async () => {
    // THE FIRST VERSION'S TWO LINES, RESTORED TOGETHER, because that is what
    // it takes to reproduce the defect honestly: the over-cap ask must get
    // through (the count cap off) AND the diff must be taken from the raw ask.
    // Executed exactly so: 25 tags asked, the column holds Tag1..Tag20,
    // project_activity holds added:[Tag1..Tag25]. Mutating only the source
    // line would prove nothing now, because every shape that would diverge is
    // refused before it reaches the writer.
    const many = Array.from({ length: 25 }, (_, i) => 'Tag' + (i + 1));
    const paired = mutatePairs([
      ['        if (u.tags.length > PHOTO_TAGS_CAP) {', '        if (false) {'],
      ['      const nextRaw = (nextTags || []).slice();',
       "      const nextRaw = u.tags.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);"],
    ]);
    seed();
    await driveWith(paired, { photo_updates: [{ attachment_id: 'a1', tags: many }] }, OWN);
    const bad = eng.all("SELECT detail FROM project_activity WHERE kind='photo_tags_changed'").pop();
    expect(eng.all("SELECT tags FROM attachments WHERE id='a1'")[0].tags).toHaveLength(20);
    expect(bad.detail.added).toHaveLength(25);          // the feed lies about the row
    expect(bad.detail.added[24]).toBe('Tag25');

    // ...and the shipped module refuses the ask outright, so there is no row
    // for the feed to disagree with.
    seed();
    const real = await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [{ attachment_id: 'a1', tags: many }] }, OWN);
    expect(real.stage).toBe('emit');
    expect(eng.count("SELECT 1 FROM project_activity")).toBe(0);
  });

  test('and with the cap still on, the feed is taken from the COLUMN', async () => {
    // The narrower half of the same guard, isolated: a source that is not
    // `nextTags` is caught even when nothing else is wrong.
    const mut = mutate(
      '      const nextRaw = (nextTags || []).slice();',
      "      const nextRaw = u.tags.map((v) => '<<' + v + '>>');");
    await driveWith(mut, { photo_updates: [{ attachment_id: 'a1', tags: ['Framing'] }] }, OWN);
    const bad = eng.all("SELECT detail FROM project_activity WHERE kind='photo_tags_changed'").pop();
    expect(eng.all("SELECT tags FROM attachments WHERE id='a1'")[0].tags).toEqual(['Framing']);
    expect(bad.detail.added).toEqual(['<<Framing>>']);

    seed();
    await driveWith(require('../server/services/payload-dispatcher'),
      { photo_updates: [{ attachment_id: 'a1', tags: ['Framing'] }] }, OWN);
    const good = eng.all("SELECT detail FROM project_activity WHERE kind='photo_tags_changed'").pop();
    expect(good.detail.added).toEqual(['Framing']);
  });
});

describe('remove the move-side refusal and op:"move" prints one photo while writing another', () => {
  test('without it, the card says "Moved attachment a1 → attachment a1" and a2 is what changed', async () => {
    const mut = mutate(
      "        if (s.entity_type === 'attachment') {",
      '        if (false) {');
    // Both sides carry a WELL-FORMED ops block, so the only thing that can
    // refuse this target is the move-side guard itself — otherwise the mutant
    // would be stopped by an unrelated shape complaint and this test would
    // pass for the wrong reason.
    const t = { op: 'move',
      source: { entity_type: 'attachment', entity_id: 'a1',
        ops: { photo_updates: [{ attachment_id: 'a2', caption: 'WROTE A2, CARD SAYS A1' }] } },
      dest: { entity_type: 'attachment', entity_id: 'a1',
        ops: { photo_updates: [{ attachment_id: 'a2', caption: 'WROTE A2, CARD SAYS A1' }] } } };
    expect(() => mut.validateTarget(t, 0)).not.toThrow();   // the bypass, restored

    // ...and the shipped module refuses the identical target.
    const real = require('../server/services/payload-dispatcher');
    let err = null;
    try { real.validateTarget(t, 0); } catch (e) { err = e; }
    expect(err && err.message).toMatch(/move\.source cannot be an attachment target/);
    expect(capOf('a2')).toBeNull();
  });
});

describe('remove the changeset merge and the approval card renders an empty diff', () => {
  test('without changeset_rows, isRenderableChangeset rejects and the draft stores nothing', async () => {
    const { isRenderableChangeset } = require('../server/services/changeset-guard');
    const mut = mutate(
      '  if (result && Array.isArray(result.changeset_rows)) {\n' +
      '    for (const row of result.changeset_rows) changeset.push(row);\n' +
      '  }',
      '  // MUTANT: changeset_rows dropped');
    const row = { id: 'pl_mut', targets: [{ entity_type: 'attachment',
      ops: { photo_updates: [{ attachment_id: 'a1', caption: 'described' }] } }] };
    const dry = await mut.applyPayload(row, { dryRun: true, userId: 10, organizationId: 1 });
    // THE DOCUMENTED BUG: "composing… for 45s and then the change NEVER
    // appears on any surface."
    expect(dry.apply_changeset).toEqual([]);
    expect(isRenderableChangeset(dry.apply_changeset)).toBe(false);

    seed();
    const real = await require('../server/services/payload-dispatcher')
      .applyPayload(row, { dryRun: true, userId: 10, organizationId: 1 });
    expect(real.apply_changeset).toHaveLength(1);
    expect(isRenderableChangeset(real.apply_changeset)).toBe(true);
    expect([real.apply_changeset[0].before.caption, real.apply_changeset[0].after.caption])
      .toEqual([null, 'described']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NOT IN THIS FILE: system.link_ops.attach_files.
 *
 * The first version of this door reached into the attach_files arm next door
 * to repair its silent skip, and introduced a cross-tenant existence oracle
 * doing it (an UNSCOPED recovery SELECT, so a foreign id and an absent id
 * came back as two different sentences). That arm is owned by a separate
 * change, which has since landed the correct repair on origin/main —
 * RETURNING id off the org-scoped UPDATE, and ONE sentence for both cases.
 * This door does not touch it, and therefore does not test it: a mutation
 * test over a neighbour you did not write is a claim of ownership.
 * ══════════════════════════════════════════════════════════════════════════*/
