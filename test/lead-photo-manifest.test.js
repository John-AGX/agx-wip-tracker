// THE LEAD SURFACE STOPS SENDING TWELVE IMAGES ON EVERY TURN.
//
// ── THE MEASUREMENT ───────────────────────────────────────────────────────
// buildJobContext and buildEstimateContext both default includePhotos to
// FALSE and render a manifest of ids instead. buildJobContext says why, in
// its own comment: "Default is false so the per-turn user.message stays
// small; 86 calls view_attachment_image by id when it actually needs to see
// one."
//
// buildLeadContext never got that change. It attached up to 12 photos as
// vision blocks unconditionally, on EVERY turn, rebuilt and re-sent whole
// each time — order 15,000 tokens a turn whether or not the question had
// anything to do with photos. Leads are where site-survey photos live, so
// it was the worst surface to leave un-gated, and it was the largest single
// per-turn cost found in this pass.
//
// ── AND THE CAP RAN THE WRONG WAY ─────────────────────────────────────────
// The 12 were taken in `position, uploaded_at` order — a human's gallery
// ordering, oldest upload first. On a lead with 30 photos, the 12 attached
// were the oldest and the photos taken THIS MORNING were the ones dropped.
//
// ── WHAT IS HELD ──────────────────────────────────────────────────────────
//   L1  no photo blocks by default, on the live call shape
//   L2  the manifest is there instead, with ids, so nothing is hidden
//   L3  it names view_attachment_image — the reopen path, which really does
//       hand back an image (one forwarding shape, tool-result-blocks)
//   L4  opts.includePhotos:true still attaches, for a caller that wants it
//   L5  the manifest is NEWEST FIRST, and a capped tail drops the OLDEST
//   L6  a capped tail says how many it dropped and how to list them all
//   L7  docs are untouched by any of this
//   L8  the other two builders still agree with this one — the default is
//       the same on all three surfaces

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = ['organizations', 'roles', 'users', 'leads', 'estimates', 'attachments'];

const engine = createPgSqlite(sqliteSchema(TABLES), {
  jsonColumns: ['data', 'capabilities', 'notification_prefs', 'tags'],
  dateColumns: ['updated_at', 'created_at', 'uploaded_at', 'taken_at'],
});
globalThis.__P86_LEAD_PHOTO_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_LEAD_PHOTO_ENGINE__.pool }));

// NO STORAGE MOCK. Every seeded photo already carries an anthropic_file_id,
// which is loadPhotoAsBlock's first and fastest path: it returns
// {type:'image', source:{type:'file', file_id}} without touching bytes, the
// SDK or the storage adapter. So the blocks this file counts are built by the
// real function on its real live path, and the file_id on each one says WHICH
// photo it is — which is what the ordering assertions need.

const { setRolePool, refreshRoleCache } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const { buildLeadContext } = aiRoutes.internals;

const ORG = { id: 1, name: 'Org A' };
const LEAD = 'lead_1';
const PHOTO_N = 30;   // past the 24-row manifest cap, so the cap is reachable

function seed() {
  engine.db.exec(`
    DELETE FROM attachments; DELETE FROM leads; DELETE FROM users;
    DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, name) VALUES (1, 'Org A');
    INSERT INTO users (id, email, name, role, organization_id) VALUES
      (10, 'sales@a.test', 'Sales', 'admin', 1);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["LEADS_VIEW","ESTIMATES_VIEW","JOBS_VIEW","FILES_VIEW"]');
    INSERT INTO leads (id, organization_id, title, status, salesperson_id)
      VALUES ('lead_1', 1, 'Fairways survey', 'new', 10);
  `);
  const ins = engine.db.prepare(
    `INSERT INTO attachments
       (id, entity_type, entity_id, filename, mime_type, size_bytes, thumb_key,
        web_key, anthropic_file_id, position, uploaded_by, uploaded_at, organization_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // position ASCENDING with uploaded_at ASCENDING: photo 1 is the oldest and
  // sits first in the OLD ordering, photo 30 is this morning's and sat last.
  // That is exactly the shape the old cap got wrong.
  for (let i = 1; i <= PHOTO_N; i++) {
    ins.run('att_p' + i, 'lead', LEAD, 'IMG_' + String(i).padStart(3, '0') + '.jpg',
      'image/jpeg', 1024 * (100 + i), 'thumbs/p' + i + '.jpg',
      'web/p' + i + '.jpg', 'file_p' + i, i, 10,
      '2026-09-' + String(i).padStart(2, '0') + ' 08:00:00', 1);
  }
  // Two docs, which this change must not touch.
  ins.run('att_d1', 'lead', LEAD, 'scope.pdf', 'application/pdf', 20480, null,
    null, null, 99, 10, '2026-09-01 08:00:00', 1);
  ins.run('att_d2', 'lead', LEAD, 'survey.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 10240, null,
    null, null, 98, 10, '2026-09-02 08:00:00', 1);
  setRolePool(engine.pool);
  return refreshRoleCache();
}

// Which photo each block is, in the order the builder produced them.
const idsOf = (blocks) => (blocks || []).map((b) => b && b.source && b.source.file_id);

beforeEach(() => { engine.log.length = 0; return seed(); });

describe('the fixture can catch this', () => {
  test('the lead holds more photos than the manifest cap', () => {
    const n = engine.db.prepare(
      "SELECT COUNT(*) AS n FROM attachments WHERE entity_type='lead' AND thumb_key IS NOT NULL").get().n;
    expect(n).toBe(PHOTO_N);
    expect(n).toBeGreaterThan(24);
  });
});

describe('buildLeadContext — the live call shape', () => {
  // How the live path calls it: ai-routes.js's buildTurnContext passes
  // organization and (at most) withholdRevenue. No opts.includePhotos.
  const live = () => buildLeadContext(LEAD, ORG);

  test('L1 no images are attached by default', async () => {
    // MUTANT: the shipped builder, which had no gate at all. 12 image blocks
    // on every turn of every lead conversation.
    const ctx = await live();
    expect(ctx.photoBlocks).toEqual([]);
  });

  test('L2 the manifest is there instead, with the ids', async () => {
    const { system } = await live();
    expect(system).toContain('# Photos (30) — newest first');
    expect(system).toContain('[att_p30]');
    expect(system).toContain('IMG_030.jpg');
    // Sizes, same shape as the job manifest.
    expect(system).toMatch(/\[att_p30\] IMG_030\.jpg · \d+ KB/);
  });

  test('L3 it names the reopen path', async () => {
    const { system } = await live();
    expect(system).toContain('view_attachment_image({attachment_id})');
    expect(system).toContain('each image costs vision tokens');
  });

  test('L5 the manifest is NEWEST FIRST, and the cap drops the OLDEST', async () => {
    // MUTANT: keeping `ORDER BY position, uploaded_at` for the cap. The answer
    // is the same length and lists the wrong 24 — the oldest — so the photos
    // taken this morning are the ones 86 is not told about.
    const { system } = await live();
    const block = system.slice(system.indexOf('# Photos'));
    const order = (block.match(/\[att_p(\d+)\]/g) || []).map((m) => Number(m.match(/\d+/)[0]));
    expect(order.length).toBe(24);
    expect(order[0]).toBe(30);
    expect(order[23]).toBe(7);
    // strictly descending
    expect(order.every((v, i) => i === 0 || v < order[i - 1])).toBe(true);
    // the oldest six are the ones left off
    [1, 2, 3, 4, 5, 6].forEach((i) => expect(block).not.toContain('[att_p' + i + ']'));
  });

  test('L6 the dropped tail is counted and reopened by name', async () => {
    const { system } = await live();
    expect(system).toContain('6 older photo(s) NOT listed here');
    expect(system).toContain('read_project_photos({entity_type:"lead", entity_id:"lead_1"})');
    expect(system).toContain('caption, tags and GPS');
  });

  test('L7 documents are untouched', async () => {
    const { system } = await live();
    expect(system).toContain('# Documents (2)');
    expect(system).toContain('scope.pdf');
    expect(system).toContain('survey.xlsx');
    expect(system).toContain('read_attachment_text({attachment_id})');
  });
});

describe('buildLeadContext — opts.includePhotos', () => {
  test('L4 a caller that asks for images still gets them, newest first', async () => {
    const ctx = await buildLeadContext(LEAD, ORG, { includePhotos: true });
    expect(ctx.photoBlocks.length).toBe(12);
    expect(ctx.system).toContain('12 shown inline as vision content below.');
    // The twelve attached are the twelve NEWEST — same direction as the
    // manifest. MUTANT: the old `position, uploaded_at` order attaches
    // file_p1..file_p12, the oldest twelve, and every length assertion above
    // still passes.
    expect(idsOf(ctx.photoBlocks)[0]).toBe('file_p30');
    expect(idsOf(ctx.photoBlocks)[11]).toBe('file_p19');
    expect(idsOf(ctx.photoBlocks)).not.toContain('file_p1');
  });

  test('a lead with no photos says nothing about photos either way', async () => {
    engine.db.exec("DELETE FROM attachments WHERE thumb_key IS NOT NULL");
    const { system, photoBlocks } = await buildLeadContext(LEAD, ORG, { includePhotos: true });
    expect(photoBlocks).toEqual([]);
    expect(system).not.toContain('# Photos');
    expect(system).toContain('# Documents (2)');
  });
});

describe('L8 all three surfaces agree on the default', () => {
  test('the reason is written down in one place and the behaviour matches it', () => {
    const src = require('fs').readFileSync('server/routes/ai-routes.js', 'utf8');
    // Each builder derives the gate from opts the same way. A surface that
    // reads the flag differently is how this one drifted for months.
    const gates = src.match(/const includePhotos = !!\(opts && opts\.includePhotos\);/g) || [];
    expect(gates.length).toBeGreaterThanOrEqual(2);
    // And the lead builder is one of them now.
    const leadBranch = src.slice(src.indexOf('async function buildLeadContext'));
    expect(leadBranch.slice(0, 6000)).toContain('const includePhotos = !!(opts && opts.includePhotos);');
  });
});
