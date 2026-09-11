// attachment.photo_updates — the write door for a photo's DESCRIPTION.
//
// ── WHAT WAS MISSING, AND WHAT IT LOOKED LIKE ─────────────────────────────
// "Scribe is failing to write to the photos." It was: nothing in the payload
// grammar could write attachments.caption. PAYLOAD_OPS_SCHEMAS had no
// 'attachment' key, so validateOps threw a bare `Unknown entity_type:
// attachment` with no field_path and no list of legal types, and the only
// statement in the tree that wrote the column outside the upload INSERT was
// the HUMAN PUT /api/attachments/:id. Meanwhile 86's baseline promised
// read_project_photos was there "to gather attachment ids before captioning".
//
// The worst of the three endings was not the refusal. system.link_ops
// .attach_files — the only op whose name mentions attachments — ACCEPTS
// `caption` and `captions` beside its own keys, ignores both, reports
// "System: ~1 updated", and still runs `UPDATE attachments SET entity_type,
// entity_id`. Aimed at a guessed parent that is data loss reported as success.
// THAT NEIGHBOUR IS NOT TESTED HERE and is not touched by this change: it is
// owned by a separate one, which has landed its own repair on origin/main. The
// only thing this door does about it is point the model away from it by name —
// in the Scribe baseline, and in the unknown-key refusal below.
//
// ── THE SHAPE, AND WHY ────────────────────────────────────────────────────
// ONE target, ONE op, N photos: `{entity_type:'attachment', ops:{photo_updates:
// [{attachment_id, caption?, tags?}]}}`. Forty-two separate approval cards is
// not an approval story, and the repo already has the right idiom for this —
// change_orders[].line_edits and job.phase_updates are both per-id batched ops
// under one target. A photo is addressed by attachment_id and by nothing else.
//
// ── WHAT IS ACTUALLY PROVEN HERE ──────────────────────────────────────────
// Every guard is MUTATION-TESTED in the sibling file
// test/attachment-photo-updates-mutation.test.js: the guard is removed from a
// copy of the source, the copy is loaded, and the same drive is shown to go
// wrong in the named way. A test that passes against the unfixed code is
// worthless, and this repo has a documented class of assertions that pass four
// silent ways.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = ['attachments', 'projects', 'jobs', 'users', 'organizations',
                'roles', 'project_activity', 'org_tags'];

// ── ONE engine for the whole file ─────────────────────────────────────────
// DatabaseSync is a native handle and a finalizer running over one while
// others are live kills the process with no output (see pg-sqlite's header).
// One engine, closed in afterAll.
let eng;
let dispatcher;
let auth;

const CAPS_PM = JSON.stringify(['LEADS_VIEW', 'LEADS_EDIT', 'JOBS_EDIT_ANY', 'ESTIMATES_EDIT']);
const CAPS_VIEW = JSON.stringify(['LEADS_VIEW']);

function seed() {
  eng.db.exec(`
    DELETE FROM attachments; DELETE FROM projects; DELETE FROM users;
    DELETE FROM organizations; DELETE FROM roles; DELETE FROM project_activity;
    DELETE FROM org_tags;
    INSERT INTO roles (name, capabilities) VALUES ('pm','${CAPS_PM}'),('viewer','${CAPS_VIEW}');
    INSERT INTO organizations (id, name) VALUES (1,'AGX'),(2,'Rival Co');
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10,'John','j@agx.test','pm',1),
      (11,'Vera','v@agx.test','viewer',1),
      (20,'Rival PM','r@rival.test','pm',2);
    INSERT INTO projects (id, name, organization_id) VALUES ('p1','Maple St',1),('p9','Rival Site',2);
  `);
  const rows = [];
  for (let i = 1; i <= 42; i++) {
    rows.push(`('a${i}','project','p1','IMG_${String(i).padStart(4, '0')}.jpg',NULL,'[]',1,10,'2026-09-08 08:00:00','image/jpeg')`);
  }
  // The foreign row is a real row in a real other tenant, so the predicate has
  // something to actually reject rather than an absence to trip over.
  rows.push(`('zz1','project','p9','RIVAL.jpg','their words','[]',2,20,'2026-09-08 08:00:00','image/jpeg')`);
  eng.db.exec(`INSERT INTO attachments
    (id, entity_type, entity_id, filename, caption, tags, organization_id, uploaded_by, uploaded_at, mime_type)
    VALUES ${rows.join(',')};`);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['tags', 'capabilities', 'detail'] });
  // sqlite has neither. applyPayload's per-entity advisory locks are not the
  // property under test, and the shim throws loudly rather than swallowing an
  // untranslatable statement, so they are supplied instead of stubbed out.
  eng.db.function('hashtext', (s) => { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; });
  eng.db.function('pg_advisory_xact_lock', () => 1);
  // The org tag catalog's ON CONFLICT targets a case-insensitive EXPRESSION
  // index (db.js idx_org_tags_ci_name). db-schema.js emits columns only, so
  // the index is created here — without it the upsert cannot even prepare and
  // the "the catalog is bumped" assertion would pass on the error path.
  eng.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tags_ci_name ON org_tags (organization_id, LOWER(name))');

  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;

  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  dispatcher = require('../server/services/payload-dispatcher');
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

const OWN = { userId: 10, organizationId: 1 };
const VIEWER = { userId: 11, organizationId: 1 };
const RIVAL = { userId: 20, organizationId: 2 };

// Drive the door the way applyPayload does: validate the target, then
// dispatch. Returns which stage answered and what it said.
async function drive(ops, ctx, extra) {
  const target = Object.assign({ entity_type: 'attachment', ops }, extra || {});
  try { dispatcher.validateTarget(target, 0); }
  catch (e) { return { stage: 'emit', name: e.name, message: e.message, detail: e.detail || null }; }
  const client = await eng.pool.connect();
  // applyPayload hands every dispatcher a ctx.afterCommit buffer and drains it
  // in exactly ONE place: after COMMIT returns. The side effects that go in it
  // (the activity feed, the org tag catalog) issue on the MODULE pool, a
  // different connection, so a ROLLBACK cannot reach them. These drives call
  // the dispatcher directly, so "the target succeeded" is modelled by draining
  // the buffer on the success path and never on the refusal path.
  //
  // The TRANSACTION semantics themselves — a dry run, and a real apply whose
  // later target refuses — are NOT modelled here, because this file has one
  // sqlite handle and one handle makes that whole class of bug disappear.
  // They live in test/attachment-photo-updates-rollback.test.js, which models
  // the pool with two.
  const afterCommit = [];
  const useCtx = Object.assign({}, ctx, { afterCommit });
  try {
    const res = await dispatcher.internals.dispatchAttachment(client, target, {}, useCtx);
    for (const fn of afterCommit) await fn();
    return { stage: 'applied', res, deferred: afterCommit.length };
  } catch (e) {
    return { stage: 'apply', name: e.name, message: e.message, detail: e.detail || null };
  }
}

const capOf = (id) => eng.all('SELECT caption FROM attachments WHERE id = ?', id)[0].caption;
const tagsOf = (id) => eng.all('SELECT tags FROM attachments WHERE id = ?', id)[0].tags;

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DOOR ITSELF
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a description written by an agent lands on the row', () => {
  test('one photo: the caption is on the row and the summary says so', async () => {
    const r = await drive({ photo_updates: [
      { attachment_id: 'a1', caption: 'North elevation after framing' }] }, OWN);
    expect(r.stage).toBe('applied');
    expect(r.res.summary).toBe('1 photo: 1 description updated');
    expect(capOf('a1')).toBe('North elevation after framing');
  });

  test('N=42 is ONE target, ONE op, ONE payload — not 42 approval cards', async () => {
    const batch = [];
    for (let i = 1; i <= 42; i++) {
      batch.push({ attachment_id: 'a' + i, caption: 'Framing progress, bay ' + i });
    }
    const r = await drive({ photo_updates: batch }, OWN);
    expect(r.stage).toBe('applied');
    expect(r.res.photos).toBe(42);
    expect(r.res.captions_written).toBe(42);
    expect(eng.count("SELECT 1 FROM attachments WHERE entity_id='p1' AND caption IS NOT NULL")).toBe(42);
    expect(capOf('a17')).toBe('Framing progress, bay 17');
    // ONE target => one approval card, and its diff carries all 42 rows.
    expect(r.res.changeset_rows).toHaveLength(42);
  });

  test('the approval card has a real diff — the empty-changeset bug is not reproduced', async () => {
    const { isRenderableChangeset } = require('../server/services/changeset-guard');
    const r = await drive({ photo_updates: [
      { attachment_id: 'a1', caption: 'first' },
      { attachment_id: 'a2', caption: 'second' }] }, OWN);
    // A dispatcher that writes N rows under ONE target gets no useful snapshot
    // from snapshotEntity (it photographs the single row target.entity_id
    // names, and an attachment target carries none). An empty changeset is
    // rejected by isRenderableChangeset and persistDraftChangeset then stores
    // nothing — the documented "composing... for 45s and the change NEVER
    // appears on any surface" failure.
    expect(isRenderableChangeset(r.res.changeset_rows)).toBe(true);
    expect(r.res.changeset_rows.map((c) => [c.id, c.before.caption, c.after.caption]))
      .toEqual([['a1', null, 'first'], ['a2', null, 'second']]);
  });

  test('it edits ONLY the ids it names — no full-replace semantics', async () => {
    await drive({ photo_updates: [{ attachment_id: 'a1', caption: 'only me' }] }, OWN);
    expect(capOf('a1')).toBe('only me');
    expect(eng.count("SELECT 1 FROM attachments WHERE entity_id='p1' AND caption IS NULL")).toBe(41);
  });

  test('tags REPLACE, and a well-formed list reaches the column with its case intact', async () => {
    const r = await drive({ photo_updates: [
      { attachment_id: 'a1', tags: ['Trim Carpentry', 'Framing'] }] }, OWN);
    expect(r.stage).toBe('applied');
    // Case PRESERVED — the behaviour of services/attachment-tags
    // .normalizeTagsInput, which is the same function PUT /api/attachments/:id
    // calls. (The comment at that call site said "lowercase"; it never did.)
    expect(tagsOf('a1')).toEqual(['Trim Carpentry', 'Framing']);
    // Replacement, not merge.
    await drive({ photo_updates: [{ attachment_id: 'a1', tags: ['Paint'] }] }, OWN);
    expect(tagsOf('a1')).toEqual(['Paint']);
  });

  test('what is asked for is exactly what is stored — nothing is reshaped on the way in', async () => {
    // The property the four refusals below exist to deliver. Anything the
    // normalizer WOULD reshape has already been refused, so for every list
    // that gets this far, asked === stored (modulo surrounding whitespace,
    // the one normalization deliberately left alone).
    const asked = ['Framing', 'Trim Carpentry', ' Deck '];
    await drive({ photo_updates: [{ attachment_id: 'a1', tags: asked }] }, OWN);
    expect(tagsOf('a1')).toEqual(['Framing', 'Trim Carpentry', 'Deck']);
  });

  test('the org tag catalog is reached through the SAME upsert the human PUT uses', async () => {
    // NOT an assertion about the resulting ROW, deliberately. Driven on the
    // shipped upsertOrgTags (moved here verbatim), the multi-row INSERT builds
    // its tuples as `($1, $(i+3), $2)` against columns
    // `(organization_id, created_by, name)` — so created_by receives the TAG
    // STRING and name receives the actor id:
    //     [{organization_id:1, created_by:"Framing", name:"10.0"}]
    // In Postgres org_tags.created_by is an integer column, so that statement
    // raises 22P02 and upsertOrgTags' own try/catch swallows it. The catalog
    // has therefore never been bumped from the human caption PUT either.
    //
    // That is a PRE-EXISTING defect in a best-effort side path and it is not
    // this door's to fix — but the door must not quietly route around it with
    // a private, differently-shaped INSERT, because then an agent tag and a
    // human tag would populate the catalog differently. So what is pinned is
    // that the same function is called with the added tags.
    const before = eng.log.length;
    await drive({ photo_updates: [{ attachment_id: 'a1', tags: ['Framing', 'Paint'] }] }, OWN);
    const attempt = eng.log.slice(before).find((q) => /INSERT INTO org_tags/.test(q.sql));
    expect(attempt).toBeDefined();
    expect(attempt.params.slice(2)).toEqual(['Framing', 'Paint']);
  });

  test('the activity feed records exactly what the human PUT records', async () => {
    await drive({ photo_updates: [
      { attachment_id: 'a1', caption: 'described', tags: ['Framing'] }] }, OWN);
    const rows = eng.all('SELECT project_id, actor_user_id, kind, detail FROM project_activity ORDER BY kind');
    expect(rows.map((r) => r.kind)).toEqual(['caption_edited', 'photo_tags_changed']);
    expect(rows[0]).toEqual({ project_id: 'p1', actor_user_id: 10, kind: 'caption_edited',
      detail: { attachment_id: 'a1', filename: 'IMG_0001.jpg' } });
    expect(rows[1].detail).toEqual({ attachment_id: 'a1', filename: 'IMG_0001.jpg',
      added: ['Framing'], removed: [] });
  });

  test('a caption set to the SAME value writes no activity row — as the PUT does not', async () => {
    await drive({ photo_updates: [{ attachment_id: 'a1', caption: 'same' }] }, OWN);
    const first = eng.count('SELECT 1 FROM project_activity');
    await drive({ photo_updates: [{ attachment_id: 'a1', caption: 'same' }] }, OWN);
    expect(eng.count('SELECT 1 FROM project_activity')).toBe(first);
  });

  test('the side effects are BUFFERED, not issued, while the transaction is open', async () => {
    // The activity row and the tag-catalog bump are the two writes this
    // dispatcher cannot put inside the payload's transaction: both issue on
    // the MODULE pool. So dispatchAttachment must not issue them at all — it
    // hands applyPayload a thunk and applyPayload releases it after COMMIT.
    // Here: nothing is issued during dispatch, and exactly one thunk comes out.
    const client = await eng.pool.connect();
    const afterCommit = [];
    const before = eng.log.length;
    await dispatcher.internals.dispatchAttachment(client,
      { entity_type: 'attachment', ops: { photo_updates: [
        { attachment_id: 'a1', caption: 'described', tags: ['Framing'] }] } },
      {}, { userId: 10, organizationId: 1, afterCommit });
    const issued = eng.log.slice(before)
      .filter((q) => /INSERT INTO (project_activity|org_tags)/.test(q.sql));
    expect(issued).toEqual([]);
    expect(afterCommit).toHaveLength(1);
    expect(eng.count('SELECT 1 FROM project_activity')).toBe(0);
    // Draining it — which is what a COMMIT does — is what writes them.
    for (const fn of afterCommit) await fn();
    expect(eng.count('SELECT 1 FROM project_activity')).toBe(2);
  });

  test('with NO afterCommit buffer nothing is fired at all — the safe direction', async () => {
    // dispatchAttachment is exported in internals, so it can be reached
    // without applyPayload. Outside a transaction it cannot know whether the
    // write it is describing survived, so it records nothing rather than
    // guessing. (applyPayload always supplies the buffer — proven in
    // test/attachment-photo-updates-rollback.test.js, where the row lands.)
    const client = await eng.pool.connect();
    await dispatcher.internals.dispatchAttachment(client,
      { entity_type: 'attachment', ops: { photo_updates: [
        { attachment_id: 'a1', caption: 'no buffer' }] } },
      {}, { userId: 10, organizationId: 1 });
    expect(eng.count('SELECT 1 FROM project_activity')).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE THREE REFUSALS
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an id that does not resolve REFUSES and prints the inventory', () => {
  test('an unresolvable id names itself, lists what the parent holds, and saves nothing', async () => {
    const r = await drive({ photo_updates: [
      { attachment_id: 'a1', caption: 'good' },
      { attachment_id: 'a999', caption: 'ghost' }] }, OWN);
    expect(r.stage).toBe('apply');
    expect(r.name).toBe('PayloadValidationError');
    expect(r.message).toMatch(/photo_updates\[1\]: no such photo — attachment_id="a999"/);
    // The inventory, in read_project_photos' own line format, so the refusal
    // and the read describe the same photos the same way and the model can
    // re-address without a second read. This is the change_orders line_edits
    // idiom, not the weaker phase_updates one.
    expect(r.message).toMatch(/This project holds 42 file\(s\)/);
    expect(r.message).toMatch(/\[a1\] IMG_0001\.jpg — caption:/);
    expect(r.message).toMatch(/read_project_photos prints in square brackets/);
    expect(r.detail.code).toBe('unresolvable_id');
    // ALL-OR-NOTHING: the sibling that DID resolve is untouched, because pass
    // 1 resolves every id before pass 2 writes anything.
    expect(capOf('a1')).toBeNull();
  });

  test('the load-bearing half of the refusal survives the 400-char chat cut', async () => {
    // THE SURFACE THIS SENTENCE IS READ ON CUTS IT. execScribeWrite's failure
    // branch posts `String(errMsg).slice(0, 400)` and the push body takes 200.
    // With the inventory in the middle, a 42-photo refusal ended mid-word and
    // the user never reached "Nothing was saved." or the name of the tool that
    // supplies a correct address. So the order was changed, not the length
    // alone: identity, then "Nothing was saved.", then how to re-address, and
    // the inventory last where a cut can only shorten a list.
    const r = await drive({ photo_updates: [
      { attachment_id: 'a1', caption: 'good' },
      { attachment_id: 'a999', caption: 'ghost' }] }, OWN);
    const chat = String(r.message).slice(0, 400);
    const push = String(r.message).slice(0, 200);
    expect(chat).toContain('a999');
    expect(chat).toContain('Nothing was saved.');
    expect(chat).toContain('read_project_photos');
    // Even the 200-char push body carries the id and the fact nothing landed.
    expect(push).toContain('a999');
    expect(push).toContain('Nothing was saved.');
  });

  test('an unresolvable id is never counted as an applied edit', async () => {
    const r = await drive({ photo_updates: [{ attachment_id: 'nope' }, ] }, OWN);
    expect(r.stage).not.toBe('applied');
    expect(r.res).toBeUndefined();
  });
});

describe('a foreign-tenant id refuses, and does not say the row exists', () => {
  test('varying ONLY the org flips the verdict', async () => {
    const foreign = await drive({ photo_updates: [{ attachment_id: 'zz1', caption: 'hijacked' }] }, OWN);
    expect(foreign.stage).toBe('apply');
    expect(capOf('zz1')).toBe('their words');

    // Same id, same op, same caption — only ctx.organizationId differs.
    const own = await drive({ photo_updates: [{ attachment_id: 'zz1', caption: 'their own edit' }] }, RIVAL);
    expect(own.stage).toBe('applied');
    expect(capOf('zz1')).toBe('their own edit');
  });

  test('the refusal for a FOREIGN row is byte-identical to the one for an ABSENT row', async () => {
    // attachments.id is a guessable string. A distinguishable refusal would
    // make this op a cross-tenant existence oracle, which is the leak the
    // org-scoped reads elsewhere in this repo were written to prevent.
    const foreign = await drive({ photo_updates: [{ attachment_id: 'zz1', caption: 'x' }] }, OWN);
    const absent = await drive({ photo_updates: [{ attachment_id: 'zz1-but-fake', caption: 'x' }] }, OWN);
    const strip = (m) => m.replace(/attachment_id="[^"]*"/, 'attachment_id="ID"');
    expect(strip(foreign.message)).toBe(strip(absent.message));
    expect(foreign.detail.code).toBe(absent.detail.code);
  });
});

describe('an over-length caption refuses rather than truncating', () => {
  test('one char over the upload path\'s own cap is refused by name', async () => {
    const CAP = dispatcher.internals.PHOTO_CAPTION_CAP;
    expect(CAP).toBe(2000);   // the same slice the upload path applies
    const r = await drive({ photo_updates: [
      { attachment_id: 'a1', caption: 'x'.repeat(CAP + 1) }] }, OWN);
    expect(r.stage).toBe('emit');
    expect(r.message).toMatch(/caption is 2001 chars — the cap is 2000/);
    expect(r.message).toMatch(/Nothing was saved\.$/);
    expect(r.detail.code).toBe('too_long');
    expect(capOf('a1')).toBeNull();
  });

  test('EXACTLY at the cap writes — and writes the whole string, untruncated', async () => {
    const CAP = dispatcher.internals.PHOTO_CAPTION_CAP;
    const r = await drive({ photo_updates: [
      { attachment_id: 'a1', caption: 'y'.repeat(CAP) }] }, OWN);
    expect(r.stage).toBe('applied');
    expect(capOf('a1')).toHaveLength(CAP);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CAPABILITY — the PUT's map, not a second opinion
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the capability is the one PUT /api/attachments/:id resolves', () => {
  test('varying ONLY the capability flips the verdict on the SAME row', async () => {
    const denied = await drive({ photo_updates: [{ attachment_id: 'a1', caption: 'view-only tries' }] }, VIEWER);
    expect(denied.stage).toBe('apply');
    expect(denied.detail.code).toBe('missing_capability');
    expect(denied.message).toMatch(/do not have permission to edit photos on a project \(requires LEADS_EDIT\)/);
    expect(capOf('a1')).toBeNull();

    // Same org, same row, same op — only ctx.userId (and therefore the role)
    // differs. Vera holds LEADS_VIEW; John holds LEADS_EDIT.
    const allowed = await drive({ photo_updates: [{ attachment_id: 'a1', caption: 'pm writes' }] }, OWN);
    expect(allowed.stage).toBe('applied');
    expect(capOf('a1')).toBe('pm writes');
  });

  test('the capability comes from writeCapForEntity, shared with the human door', async () => {
    // One definition, in services/, reachable from BOTH doors — the whole
    // point of moving it out of routes/attachment-routes.js. If these two ever
    // answer differently, an agent and a human disagree about who may write.
    const svc = require('../server/services/attachment-entity-access');
    const routeCopy = require('../server/routes/attachment-routes').entityAccess;
    expect(routeCopy.writeCapForEntity).toBe(svc.writeCapForEntity);
    expect(svc.writeCapForEntity('project')).toBe('LEADS_EDIT');
  });

  test('the __owner__ sentinel means the OWNER, not "any authenticated caller"', async () => {
    // writeCapForEntity('user') returns the sentinel '__owner__', which is not
    // a capability at all — the PUT resolves it with ensureUserAttachmentOwner
    // (your own bucket, or anyone's if you are adminish). Treating the
    // sentinel as "no capability required" would let every in-tenant user
    // caption every other user's private files, which is STRICTLY weaker than
    // the door being copied.
    eng.db.exec("INSERT INTO attachments (id, entity_type, entity_id, filename, caption, tags, organization_id, uploaded_by, mime_type)" +
      " VALUES ('mine','user','10','PRIVATE.jpg',NULL,'[]',1,10,'image/jpeg')," +
      "        ('theirs','user','11','VERA.jpg',NULL,'[]',1,11,'image/jpeg')");
    const own = await drive({ photo_updates: [{ attachment_id: 'mine', caption: 'my own file' }] }, OWN);
    expect(own.stage).toBe('applied');
    expect(capOf('mine')).toBe('my own file');

    const other = await drive({ photo_updates: [{ attachment_id: 'theirs', caption: 'not mine' }] }, OWN);
    expect(other.stage).toBe('apply');
    expect(other.detail.code).toBe('missing_capability');
    expect(other.message).toMatch(/ownership of that personal file bucket/);
    expect(capOf('theirs')).toBeNull();
  });

  test('an actor that cannot be resolved is refused, not waved through', async () => {
    const r = await drive({ photo_updates: [{ attachment_id: 'a1', caption: 'ghost actor' }] },
      { userId: 9999, organizationId: 1 });
    expect(r.stage).toBe('apply');
    expect(r.detail.code).toBe('missing_capability');
    expect(capOf('a1')).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SHAPE — an unknown key is a refusal, never a silent no-op
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the grammar refuses by name instead of ignoring', () => {
  const cases = [
    ['an unknown key inside an item', { photo_updates: [{ attachment_id: 'a1', description: 'x' }] },
      /unknown key\(s\): 'description'/, 'unknown_field'],
    ['an item that names a photo but sets nothing', { photo_updates: [{ attachment_id: 'a1' }] },
      /names photo 'a1' but sets no field/, 'empty_op'],
    ['the same id twice in one batch', { photo_updates: [
      { attachment_id: 'a1', caption: 'x' }, { attachment_id: 'a1', caption: 'y' }] },
      /appears more than once in this batch/, 'duplicate_id'],
    ['a caption that is not a string', { photo_updates: [{ attachment_id: 'a1', caption: 42 }] },
      /caption must be a string \(got number\)/, 'wrong_type'],
    ['tags that are not an array', { photo_updates: [{ attachment_id: 'a1', tags: 'framing' }] },
      /tags must be an array of strings/, 'wrong_type'],
    ['an empty batch', { photo_updates: [] }, /is empty — nothing would be written/, 'empty_op'],
    ['photo_updates that is not an array', { photo_updates: { a1: 'x' } },
      /must be an array of \{attachment_id, caption\?, tags\?\}/, 'wrong_type'],
    ['a missing attachment_id', { photo_updates: [{ caption: 'x' }] },
      /attachment_id is required/, 'missing_field'],
  ];
  test.each(cases)('%s is refused before any SQL runs', async (_label, ops, re, code) => {
    const r = await drive(ops, OWN);
    expect(r.stage).toBe('emit');
    expect(r.message).toMatch(re);
    expect(r.detail.code).toBe(code);
    expect(capOf('a1')).toBeNull();
  });

  test('a batch over the cap is refused and points at the read filters', async () => {
    const many = Array.from({ length: dispatcher.internals.PHOTO_UPDATES_CAP + 1 },
      (_, i) => ({ attachment_id: 'x' + i, caption: 'c' }));
    const r = await drive({ photo_updates: many }, OWN);
    expect(r.stage).toBe('emit');
    expect(r.message).toMatch(/holds 61 entries — the cap is 60 per target/);
    expect(r.message).toMatch(/missing_caption_only/);
    expect(r.detail.retryable).toBe(false);
  });

  test('a SECOND address at target level is refused, not silently ignored', async () => {
    // entity_id / bulk / condition would each be a second address for the same
    // write. Two addresses disagreeing while the write reports success is this
    // repo's documented failure.
    for (const extra of [{ entity_id: 'p1' }, { bulk: { items: [{ ops: {} }] } }, { condition: 'if_exists' }]) {
      const key = Object.keys(extra)[0];
      const r = await drive({ photo_updates: [{ attachment_id: 'a1', caption: 'x' }] }, OWN, extra);
      expect([key, r.stage]).toEqual([key, 'emit']);
      expect(r.message).toMatch(new RegExp("attachment targets take no '" + key + "'"));
    }
  });

  test('an unknown TOP-LEVEL op key names the one that exists', async () => {
    // The shape a Scribe reaching for this would most plausibly invent. Before
    // the door existed this was "Unknown entity_type: attachment"; it now
    // points at photo_updates by name.
    const r = await drive({ caption_updates: [{ attachment_id: 'a1', caption: 'x' }] }, OWN);
    expect(r.stage).toBe('emit');
    expect(r.message).toBe(
      "Unknown op key 'caption_updates' for entity_type=attachment. Allowed top-level op keys: photo_updates.");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE TAGS HALF GETS THE CAPTION HALF'S DISCIPLINE
 *
 * The caption arm refuses an over-length description on a stated principle:
 * "a silently-shortened description is a silent success". The tags arm used to
 * do exactly what that sentence forbids — validateOps checked only
 * Array.isArray and normalizeTagsInput then reshaped in silence. Executed,
 * asked -> stored -> reported:
 *   ['A'x40]                          -> ['A'x32]           -> "1 tag set updated"
 *   25 tags                           -> the first 20       -> "1 tag set updated"
 *   ['Framing',123,null,{a:1},'Deck'] -> ['Framing','Deck'] -> "1 tag set updated"
 *   [1,2,3]                           -> []                 -> "1 tag set updated"
 * The last one WIPED the photo's existing tags and called it an update. Each
 * of those four now refuses, and the row is proven untouched afterwards.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a tag list that would be silently reshaped is REFUSED instead', () => {
  const PRIOR = ['Framing', 'Roofing'];
  beforeEach(async () => {
    // A photo that ALREADY has tags, so "the row was not touched" is a real
    // assertion rather than null === null.
    await drive({ photo_updates: [{ attachment_id: 'a1', tags: PRIOR }] }, OWN);
  });

  const rows = [
    ['a tag over the 32-char cap', ['A'.repeat(40)], /is 40 chars — a tag caps at 32/, 'too_long'],
    ['more tags than the 20-tag cap',
      Array.from({ length: 25 }, (_, i) => 'Tag' + (i + 1)), /holds 25 tags — the cap is 20/, 'too_many'],
    ['a list with non-string entries mixed in',
      ['Framing', 123, null, { a: 1 }, 'Deck'], /tags\[1\] is a number, not a string/, 'wrong_type'],
    ['a list of nothing but non-strings', [1, 2, 3], /tags\[0\] is a number, not a string/, 'wrong_type'],
    ['a blank tag', ['Framing', '   '], /tags\[1\] is blank/, 'empty_value'],
    ['the same tag twice, differing only in case',
      ['Framing', 'framing'], /tags\[1\] repeats 'framing'/, 'duplicate_value'],
  ];

  test.each(rows)('%s refuses, and the photo keeps the tags it had', async (_label, tags, re, code) => {
    const r = await drive({ photo_updates: [{ attachment_id: 'a1', tags }] }, OWN);
    expect(r.stage).toBe('emit');                 // refused before any SQL
    expect(r.message).toMatch(re);
    expect(r.message).toMatch(/Nothing was saved\.$/);
    expect(r.detail.code).toBe(code);
    // ASKED nothing, STORED nothing, REPORTED nothing — the whole point.
    expect(r.res).toBeUndefined();
    expect(tagsOf('a1')).toEqual(PRIOR);
  });

  test('CONTROL — exactly at both caps still writes, so the guard did not close the door', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => 'Tag' + (i + 1));
    const r = await drive({ photo_updates: [
      { attachment_id: 'a1', tags: twenty },
      { attachment_id: 'a2', tags: ['B'.repeat(32)] }] }, OWN);
    expect(r.stage).toBe('applied');
    expect(tagsOf('a1')).toEqual(twenty);
    expect(tagsOf('a2')).toEqual(['B'.repeat(32)]);
  });

  test('the two caps are the normalizer\'s OWN caps, not a second opinion', async () => {
    // The refusals are worded in terms of 20 and 32. Those numbers are
    // restated in the dispatcher, so they are pinned against the function that
    // actually enforces them — if normalizeTagsInput ever moves, this fails
    // rather than letting the door refuse at one boundary and the human PUT
    // reshape at another.
    const { normalizeTagsInput } = require('../server/services/attachment-tags');
    expect(normalizeTagsInput(['C'.repeat(33)])).toEqual(['C'.repeat(32)]);
    expect(normalizeTagsInput(Array.from({ length: 21 }, (_, i) => 'T' + i))).toHaveLength(20);
    expect(normalizeTagsInput(['Foo', 'foo'])).toEqual(['Foo']);
  });

  test('the ACTIVITY FEED records the tags that are on the row, not the ones that were asked for', async () => {
    // `added` used to be diffed from the RAW u.tags. Executed before the fix:
    // 25 tags asked, the column held 20, and project_activity held 25. The
    // over-cap ask is refused now, so the way to prove the SOURCE changed is to
    // give it an ask that still differs from what lands — surrounding
    // whitespace, the one normalization left in place.
    await drive({ photo_updates: [{ attachment_id: 'a2', tags: ['  Framing  '] }] }, OWN);
    const row = eng.all("SELECT detail FROM project_activity WHERE kind='photo_tags_changed'").pop();
    expect(tagsOf('a2')).toEqual(['Framing']);
    expect(row.detail.added).toEqual(['Framing']);      // not ['  Framing  ']
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * op:"move" CANNOT REACH PAST THE SECOND-ADDRESS REFUSAL
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an attachment target is refused on a move, where it used to walk past the guard', () => {
  test('move.source / move.dest naming an attachment refuse by name', async () => {
    // validateTarget's move branch RETURNS before the target-level
    // entity_id/bulk/condition refusal, so `op:"move"` was one keyword that
    // walked straight past it. Executed before this refusal existed: a move
    // whose source carried entity_id 'a1' while photo_updates wrote 'a2'
    // APPLIED, and the approval card printed "Moved attachment a1 → attachment
    // a1" while a1 was never touched.
    const t = { op: 'move',
      source: { entity_type: 'attachment', entity_id: 'a1',
        ops: { photo_updates: [{ attachment_id: 'a2', caption: 'WROTE A2, CARD SAYS A1' }] } },
      dest: { entity_type: 'attachment', entity_id: 'a1', ops: {} } };
    let err = null;
    try { dispatcher.validateTarget(t, 0); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.name).toBe('PayloadValidationError');
    expect(err.message).toMatch(/move\.source cannot be an attachment target/);
    expect(err.message).toMatch(/Nothing was saved\./);
    expect(err.detail.field_path).toBe('move.source.entity_type');
    // And nothing was written by the attempt.
    expect(capOf('a2')).toBeNull();
  });

  test('dest alone is refused too — both sides, not just the first one checked', async () => {
    const t = { op: 'move',
      source: { entity_type: 'job', entity_id: 'j1', ops: {} },
      dest: { entity_type: 'attachment', entity_id: 'a1', ops: {} } };
    let err = null;
    try { dispatcher.validateTarget(t, 0); } catch (e) { err = e; }
    expect(err && err.message).toMatch(/move\.dest cannot be an attachment target/);
  });

  test('CONTROL — a non-attachment move still validates, so the guard is not a blanket', () => {
    expect(() => dispatcher.validateTarget({ op: 'move',
      source: { entity_type: 'job', entity_id: 'j1', ops: {} },
      dest: { entity_type: 'job', entity_id: 'j2', ops: {} } }, 0)).not.toThrow();
  });
});
