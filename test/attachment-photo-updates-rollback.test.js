// THE ACTIVITY FEED MUST NOT OUTLIVE THE WRITE IT DESCRIBES.
//
// ── THE DEFECT THIS FILE EXISTS FOR ───────────────────────────────────────
// dispatchAttachment records two things that CANNOT live inside the payload's
// transaction: a project_activity row (project-routes.recordActivity) and an
// org_tags bump (attachment-tags.upsertOrgTags). Both issue on the MODULE
// pool — `pool.query()` — which in node-postgres checks out a DIFFERENT
// connection from the one applyPayload was handed by `pool.connect()` for its
// BEGIN/COMMIT. server/db.js sets no `max`, so the default pool of 10 applies
// and the two are reliably different connections.
//
// The first version of this door fired them inline, gated only on ctx.dryRun.
// That covered one of the two ways the transaction can end. The other way —
// a REAL apply whose LATER target refuses — rolled the caption back and left
// project_activity permanently holding `caption_edited` for a caption that
// was never saved. Executed, and reproduced twice.
//
// ── WHY THIS FILE HAS TWO ENGINES AND THE SIBLING FILES HAVE ONE ──────────
// With a single sqlite handle serving both `pool.query` and `pool.connect`,
// the ROLLBACK takes the activity row with it, the defect vanishes, and a
// test written over that harness PASSES having proved nothing. That is
// exactly how this shipped the first time. So the pool is modelled honestly:
//
//   engine A  <- pool.connect()  : the transaction. attachments/projects/users
//   engine B  <- pool.query()    : the module pool. project_activity/org_tags
//
// Two independent databases, so nothing engine A rolls back can reach engine
// B. A row that appears in B after A rolled back is the defect, verbatim.
//
// ── AND THE OTHER HALF: THE BUFFER MUST ACTUALLY BE DRAINED ───────────────
// A guard that turns the feature off is not a fix. The CONTROL tests here
// prove that on a committed apply the rows DO land — i.e. ctx.afterCommit is
// consumed, not merely declared. A flag nothing reads is its own defect class
// in this repo.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const SERVER = path.join(__dirname, '..', 'server');
const SERVICES = path.join(SERVER, 'services');
const REAL = path.join(SERVICES, 'payload-dispatcher.js');
const SOURCE = fs.readFileSync(REAL, 'utf8');

// Engine A owns everything the TRANSACTION touches; engine B owns the two
// tables written on the module pool. Deliberately disjoint: if a write lands
// in the wrong engine the assertion fails rather than quietly passing.
const A_TABLES = ['attachments', 'projects', 'jobs', 'users', 'organizations', 'roles'];
const B_TABLES = ['project_activity', 'org_tags'];

const CAPS_PM = JSON.stringify(['LEADS_VIEW', 'LEADS_EDIT', 'JOBS_EDIT_ANY']);

let engA;
let engB;
let auth;

function seed() {
  engA.db.exec(`
    DELETE FROM attachments; DELETE FROM projects; DELETE FROM users;
    DELETE FROM organizations; DELETE FROM roles;
    INSERT INTO roles (name, capabilities) VALUES ('pm','${CAPS_PM}');
    INSERT INTO organizations (id, name) VALUES (1,'AGX');
    INSERT INTO users (id, name, email, role, organization_id) VALUES (10,'John','j@agx.test','pm',1);
    INSERT INTO projects (id, name, organization_id) VALUES ('p1','Maple St',1);
    INSERT INTO attachments (id, entity_type, entity_id, filename, caption, tags, organization_id, uploaded_by, mime_type)
      VALUES ('a1','project','p1','IMG_0001.jpg',NULL,'[]',1,10,'image/jpeg'),
             ('a2','project','p1','IMG_0002.jpg',NULL,'[]',1,10,'image/jpeg');
  `);
  engB.db.exec('DELETE FROM project_activity; DELETE FROM org_tags;');
}

beforeAll(async () => {
  engA = createPgSqlite(sqliteSchema(A_TABLES), { jsonColumns: ['tags', 'capabilities'] });
  engB = createPgSqlite(sqliteSchema(B_TABLES), { jsonColumns: ['detail'] });
  for (const e of [engA, engB]) {
    e.db.function('hashtext', (s) => { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; });
    e.db.function('pg_advisory_xact_lock', (_k) => 1);
  }
  engB.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tags_ci_name ON org_tags (organization_id, LOWER(name))');

  const db = require('../server/db');
  // THE WHOLE POINT OF THIS FILE, in two lines.
  db.pool.connect = engA.pool.connect;   // the transaction's connection
  db.pool.query = engB.pool.query;       // the module pool — a DIFFERENT one

  auth = require('../server/auth');
  auth.setRolePool(engA.pool);
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
  if (engA) engA.close();
  if (engB) engB.close();
});
// engB.log is cumulative across the file, so every org_tags assertion counts
// from a per-test baseline rather than from zero — a running total would make
// 'no upsert was issued' pass or fail depending on test order.
let logBase = 0;
beforeEach(() => { seed(); logBase = engB.log.length; });

// ── mutate(), CRLF-safe and self-proving (see the sibling mutation file) ──
const abs = (p) => p.split(path.sep).join('/');
function absolutizeRequires(src) {
  return src
    .replace(/require\('\.\/([^']+)'\)/g, (_m, p) => `require('${abs(SERVICES)}/${p}')`)
    .replace(/require\('\.\.\/([^']+)'\)/g, (_m, p) => `require('${abs(SERVER)}/${p}')`);
}
let mutantPaths = [];
function mutate(find, replace) {
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const f = String(find).replace(/\r?\n/g, eol);
  const r = String(replace).replace(/\r?\n/g, eol);
  if (SOURCE.indexOf(f) === -1) {
    throw new Error('MUTATION ANCHOR NOT FOUND. Anchor:\n' + JSON.stringify(f.slice(0, 200)));
  }
  const mutated = SOURCE.split(f).join(r);
  if (mutated === SOURCE) throw new Error('MUTATION CHANGED NO BYTES');
  const p = path.join(os.tmpdir(), '_p86_rbmutant_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(mutated), 'utf8');
  mutantPaths.push(p);
  return require(p);
}
afterEach(() => {
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* not loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

const OPTS = { userId: 10, organizationId: 1 };
const capOf = (id) => engA.all('SELECT caption FROM attachments WHERE id = ?', id)[0].caption;
const activity = () => engB.all('SELECT project_id, actor_user_id, kind, detail FROM project_activity');
const orgTagInserts = () => engB.log.slice(logBase).filter((q) => /INSERT INTO org_tags/.test(q.sql)).length;

// ONE target that writes a1; a SECOND target that names a photo which does not
// exist, so the payload refuses after the first target already wrote.
const GOOD = { entity_type: 'attachment',
  ops: { photo_updates: [{ attachment_id: 'a1', caption: 'committed', tags: ['Framing'] }] } };
const REFUSES = { entity_type: 'attachment',
  ops: { photo_updates: [{ attachment_id: 'ghost', caption: 'never' }] } };

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HARNESS FIRST — a two-engine model that is not really two engines
 * proves nothing, and neither does a mutate() that cannot mutate.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the two-connection model is real', () => {
  test('a ROLLBACK on engine A cannot reach a row written on engine B', async () => {
    const client = await engA.pool.connect();
    await client.query('BEGIN');
    await client.query("UPDATE attachments SET caption = 'in the transaction' WHERE id = $1", ['a1']);
    // Exactly what recordActivity does: pool.query, i.e. the OTHER connection.
    const db = require('../server/db');
    await db.pool.query(
      'INSERT INTO project_activity (project_id, actor_user_id, kind, detail) VALUES ($1,$2,$3,$4)',
      ['p1', 10, 'probe', JSON.stringify({})]);
    await client.query('ROLLBACK');
    expect(capOf('a1')).toBeNull();          // the transaction was undone
    expect(activity()).toHaveLength(1);      // the other connection was not
  });

  test('an anchor that is not in the file THROWS instead of passing quietly', () => {
    expect(() => mutate('nowhere in the dispatcher at all', 'x')).toThrow(/ANCHOR NOT FOUND/);
  });

  test('a replacement identical to its anchor THROWS instead of passing quietly', () => {
    const a = 'const PHOTO_TAGS_CAP = 20;';
    expect(() => mutate(a, a)).toThrow(/CHANGED NO BYTES/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CONTROL — a committed apply DOES write the feed. The buffer is drained,
 * not merely declared.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a payload that COMMITS records the activity the human PUT records', () => {
  test('caption on the row, caption_edited + photo_tags_changed in the feed', async () => {
    const real = require('../server/services/payload-dispatcher');
    const res = await real.applyPayload({ id: 'pl_ok', targets: [GOOD] }, OPTS);
    expect(res.ok).toBe(true);
    expect(res.dry_run).toBe(false);
    expect(capOf('a1')).toBe('committed');
    const rows = activity().sort((x, y) => x.kind.localeCompare(y.kind));
    expect(rows.map((r) => r.kind)).toEqual(['caption_edited', 'photo_tags_changed']);
    expect(rows[0]).toEqual({ project_id: 'p1', actor_user_id: 10, kind: 'caption_edited',
      detail: { attachment_id: 'a1', filename: 'IMG_0001.jpg' } });
    expect(rows[1].detail.added).toEqual(['Framing']);
    // ...and the org tag catalog was reached through the same upsert.
    expect(orgTagInserts()).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DEFECT — a later target refuses, so nothing was saved, and the feed
 * must say nothing was saved too.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a payload that ROLLS BACK leaves no trace in the activity feed', () => {
  test('the caption is gone AND the caption_edited row was never written', async () => {
    const real = require('../server/services/payload-dispatcher');
    let err = null;
    try { await real.applyPayload({ id: 'pl_rb', targets: [GOOD, REFUSES] }, OPTS); }
    catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.message).toMatch(/no such photo — attachment_id="ghost"/);
    expect(capOf('a1')).toBeNull();     // rolled back, as it must be
    expect(activity()).toEqual([]);     // and the feed agrees, which is the fix
    expect(orgTagInserts()).toBe(0);
  });

  test('MUTANT — fire the side effects inline and the feed outlives the write', async () => {
    // The shape the first version of this door shipped: the activity insert is
    // issued during the transaction, on the other connection, so the ROLLBACK
    // cannot reach it.
    const mut = mutate(
      '  const deferred = ctx && Array.isArray(ctx.afterCommit) ? ctx.afterCommit : null;\n' +
      '  if (deferred && (activity.length || (newTags.length && orgId))) {\n' +
      '    deferred.push(async () => {',
      '  const deferred = { push: async (fn) => { await fn(); } };\n' +
      '  if (deferred && (activity.length || (newTags.length && orgId))) {\n' +
      '    await deferred.push(async () => {');
    let err = null;
    try { await mut.applyPayload({ id: 'pl_mut', targets: [GOOD, REFUSES] }, OPTS); }
    catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(capOf('a1')).toBeNull();                    // the caption WAS rolled back
    const rows = activity();
    expect(rows.map((r) => r.kind).sort())
      .toEqual(['caption_edited', 'photo_tags_changed']);   // ...the feed was not
    expect(rows.find((r) => r.kind === 'caption_edited').detail.attachment_id).toBe('a1');
  });

  test('MUTANT — drain the buffer on the ROLLBACK path and the same row survives', async () => {
    // The other end of the same guard: the buffer exists, but it is released
    // by something other than a COMMIT.
    const mut = mutate(
      "    try { await dbClient.query('ROLLBACK'); } catch (_) {}\n" +
      '    throw err;',
      "    try { await dbClient.query('ROLLBACK'); } catch (_) {}\n" +
      '    for (const fn of afterCommit) { try { await fn(); } catch (_) {} }\n' +
      '    throw err;');
    let err = null;
    try { await mut.applyPayload({ id: 'pl_mut2', targets: [GOOD, REFUSES] }, OPTS); }
    catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(capOf('a1')).toBeNull();
    expect(activity().map((r) => r.kind).sort())
      .toEqual(['caption_edited', 'photo_tags_changed']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DRY RUN — the same mechanism, the half that WAS covered before.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a DRY RUN writes no activity row and bumps no tag catalog', () => {
  test('driveScribeWrite previews every draft; a preview must leave nothing behind', async () => {
    const real = require('../server/services/payload-dispatcher');
    const res = await real.applyPayload({ id: 'pl_dry', targets: [GOOD] },
      Object.assign({ dryRun: true }, OPTS));
    expect(res.dry_run).toBe(true);
    expect(res.apply_changeset).toHaveLength(1);   // the card still has its diff
    expect(capOf('a1')).toBeNull();
    expect(activity()).toEqual([]);
    expect(orgTagInserts()).toBe(0);
  });

  test('MUTANT — drain before the dry-run ROLLBACK and a preview nobody approved is logged', async () => {
    const mut = mutate(
      "      await dbClient.query('ROLLBACK');\n" +
      '      return {\n' +
      '        ok: true,\n' +
      '        dry_run: true,',
      "      await dbClient.query('ROLLBACK');\n" +
      '      for (const fn of afterCommit) { try { await fn(); } catch (_) {} }\n' +
      '      return {\n' +
      '        ok: true,\n' +
      '        dry_run: true,');
    await mut.applyPayload({ id: 'pl_dry2', targets: [GOOD] },
      Object.assign({ dryRun: true }, OPTS));
    expect(capOf('a1')).toBeNull();
    expect(activity()).toHaveLength(2);
  });
});
