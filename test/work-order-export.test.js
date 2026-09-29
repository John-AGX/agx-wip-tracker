// EXPORT A WORK ORDER'S PHOTOS AND FILES AS A ZIP — through the shipped route.
//
// John, 2026-09-29: "export a service tickets files and photos to a zip
// folder, that sorts into before after and issues pictures ... so I can send
// the report and photos to someone."
//
// The last seven words are why the sharpest test in this file is about what
// does NOT go in. A receipt is a picture of prices; it is kept off every
// crew-facing surface already, and an export whose stated purpose is to be
// sent to an outsider is the last place it should start appearing. So it is
// excluded by default, opt-in behind a money capability, and driven both ways
// here.
//
// The rest: that the three folders are the taxonomy the work order already
// keeps (not a new guess), that a flagged problem's photo is an Issue even
// though it is technically a completion photo, that a building's name groups
// its photos, and that another tenant gets nothing.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

// The bytes every stored object answers with, keyed so a test can tell them
// apart inside the archive.
const mockBytes = new Map();
jest.mock('../server/storage', () => ({
  storage: {
    put: async (key) => 'https://cdn.test/' + key,
    delete: async () => {},
    getStream: async (key) => {
      const buf = mockBytes.get(key);
      if (!buf) throw new Error('no such object: ' + key);
      const { Readable } = require('stream');
      return { stream: Readable.from([buf]), size: buf.length };
    },
  },
}));
jest.mock('../server/services/work-order-notices', () => ({
  notifyProblemFlagged: async () => ({ sent: 0 }),
  notifyAssigned: async () => ({ sent: 0 }),
  sendBackRecipients: async () => [],
  notifySentBack: async () => ({ sent: 0 }),
}));
jest.mock('../server/services/service-ticket-notify', () => ({
  notifyAwaitingApproval: async () => ({ sent: 0 }),
}));

const exporter = require('../server/services/service-ticket-export');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks', 'attachments', 'clients',
  'estimates', 'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_flags', 'service_ticket_participants',
  'service_ticket_labor', 'service_ticket_materials_used',
];

const WIDE = 10;        // can read the work order, no money capability
const MONEY = 11;       // can also read money
const RIVAL = 50;
const USERS = {
  [WIDE]: { role: 'ex_wide', org: 1 },
  [MONEY]: { role: 'ex_money', org: 1 },
  [RIVAL]: { role: 'ex_wide', org: 2 },
};

let eng, auth, ticketRouter;

function att(o) {
  const key = o.id + '.bin';
  mockBytes.set(key, Buffer.from('BYTES:' + o.id));
  return Object.assign({ key }, o);
}

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  mockBytes.clear();
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs; DELETE FROM job_access;
    DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments; DELETE FROM clients; DELETE FROM estimates;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_flags;
    DELETE FROM service_ticket_participants;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO roles (name, capabilities) VALUES
      ('ex_wide',  ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW'])}),
      ('ex_money', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'FINANCIALS_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'ex_wide', 1, 1),
      (11, 'Mona Money', 'm@agx.test', 'ex_money', 1, 1),
      (50, 'Rival Ray', 'r@rival.test', 'ex_wide', 2, 1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);

    INSERT INTO service_tickets (id, organization_id, ticket_number, title, job_id, status, bill_as, ticket_kind, checklist, created_by, approval_notice_attempts, billing_status, archived_at, created_at) VALUES
      ('st_a', 1, 'WO-0001', 'Pump room leak', 'j1', 'approved', 'time_materials', 'work_order', '[]', 10, 0, 'unbilled', NULL, '2026-09-01 10:00:00'),
      ('st_empty', 1, 'WO-0002', 'Nothing on it', 'j1', 'approved', 'time_materials', 'work_order', '[]', 10, 0, 'unbilled', NULL, '2026-09-01 10:00:01'),
      ('st_b', 2, 'WO-9001', 'Rival work order', 'j9', 'approved', 'time_materials', 'work_order', '[]', 50, 0, 'unbilled', NULL, '2026-09-01 10:00:02');

    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at, created_at) VALUES
      ('k4', 1, 'Bldg 4 — Side A: pump room', 'done', 'org', 'st_a', 'job', 'j1', NULL, '2026-09-02 08:00:00'),
      ('k9', 1, 'Bldg 9 — rails',             'open', 'org', 'st_a', 'job', 'j1', NULL, '2026-09-02 08:00:01');

    INSERT INTO service_ticket_flags (id, organization_id, ticket_id, task_id, category, note, status, attachment_ids, created_at) VALUES
      ('fl1', 1, 'st_a', 'k9', 'other', 'Rot behind the rail', 'open', '["a_flag"]', '2026-09-03 09:00:00');
  `);

  const ins = eng.db.prepare(
    `INSERT INTO attachments (id, entity_type, entity_id, organization_id, filename, mime_type,
       original_key, web_key, thumb_url, web_url, original_url, tags, position, uploaded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rows = [
    // On building 4: a before and two completion photos.
    att({ id: 'a_b4', entity: 'task', on: 'k4', name: 'rail before.jpg', mime: 'image/jpeg', tags: '["before"]', pos: 0 }),
    att({ id: 'a_c4', entity: 'task', on: 'k4', name: 'rail done.jpg', mime: 'image/jpeg', tags: '[]', pos: 1 }),
    att({ id: 'a_c4b', entity: 'task', on: 'k4', name: 'valve.jpg', mime: 'image/jpeg', tags: '[]', pos: 2 }),
    // On building 9: a completion shot. The flagged problem's photo is NOT
    // here — a flag's photos hang off the TICKET, which is where
    // services/service-ticket-flags.js stores and reads them.
    att({ id: 'a_c9', entity: 'task', on: 'k9', name: 'rail fixed.jpg', mime: 'image/jpeg', tags: '[]', pos: 1 }),
    // On the ticket itself: a site photo, a RECEIPT, and a document.
    att({ id: 'a_site', entity: 'service_ticket', on: 'st_a', name: 'site.jpg', mime: 'image/jpeg', tags: '[]', pos: 0 }),
    att({ id: 'a_rcpt', entity: 'service_ticket', on: 'st_a', name: 'home depot.jpg', mime: 'image/jpeg', tags: '["receipt"]', pos: 1 }),
    att({ id: 'a_doc', entity: 'service_ticket', on: 'st_a', name: 'scope.pdf', mime: 'application/pdf', tags: '[]', pos: 2 }),
    att({ id: 'a_flag', entity: 'service_ticket', on: 'st_a', name: 'rot.jpg', mime: 'image/jpeg', tags: '["flag"]', pos: 3 }),
    // The rival's.
    att({ id: 'a_riv', entity: 'service_ticket', on: 'st_b', name: 'rival.jpg', mime: 'image/jpeg', tags: '[]', pos: 0, org: 2 }),
  ];
  for (const r of rows) {
    ins.run(r.id, r.entity, r.on, r.org || 1, r.name, r.mime, r.key, r.key,
      'https://cdn.test/t', 'https://cdn.test/w', 'https://cdn.test/o', r.tags, r.pos, '2026-09-03 10:00:00');
  }
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data', 'tags', 'materials',
                  'crew_takeoff', 'receipt_ids', 'attachment_ids'],
  });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  ticketRouter = require('../server/routes/service-ticket-routes');
});

beforeEach(() => seed());

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 25));
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

// ── the drive ─────────────────────────────────────────────────────────────
function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
}

/** A response that collects the streamed body, the way the socket would. */
function zipRes() {
  const chunks = [];
  const res = { statusCode: 200, body: undefined, headers: {}, headersSent: false, destroyed: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
  res.set = res.setHeader;
  res.write = (b) => { chunks.push(Buffer.from(b)); res.headersSent = true; return true; };
  res.end = () => { res.headersSent = true; };
  res.destroy = (e) => { res.destroyed = e || true; };
  res.buffer = () => Buffer.concat(chunks);
  return res;
}

async function exportZip(id, opts) {
  const o = opts || {};
  const layer = ticketRouter.stack.find((l) => l.route && l.route.path === '/:id/export.zip' && l.route.methods.get);
  if (!layer) throw new Error('route not declared');
  const res = zipRes();
  const req = {
    method: 'GET', params: { id }, query: o.query || {}, body: {}, cookies: {},
    headers: { authorization: 'Bearer ' + tokenFor(o.as || WIDE) },
    protocol: 'https', ip: '127.0.0.1', get: () => 'project86.test',
  };
  for (const h of layer.route.stack.map((s) => s.handle)) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

/** Entry names, read out of the archive's own central directory. */
function namesIn(buf) {
  const out = [];
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    out.push({
      name: buf.subarray(i + 30, i + 30 + nameLen).toString('utf8'),
      body: buf.subarray(i + 30 + nameLen + extraLen, i + 30 + nameLen + extraLen + size).toString('utf8'),
    });
    i += 30 + nameLen + extraLen + size;
  }
  return out;
}

const folderOf = (n) => (n.indexOf('/') >= 0 ? n.slice(0, n.indexOf('/')) : '(root)');

// ── 1. the sorting John asked for ────────────────────────────────────────
describe('before, after and issues', () => {
  test('every photo lands in the folder its own tag already said it was', async () => {
    const res = await exportZip('st_a');
    expect(res.statusCode).toBe(200);
    const byFolder = {};
    for (const e of namesIn(res.buffer())) {
      (byFolder[folderOf(e.name)] = byFolder[folderOf(e.name)] || []).push(e.name);
    }
    expect(Object.keys(byFolder).sort()).toEqual(['(root)', 'After', 'Before', 'Documents', 'Issues']);
    expect(byFolder.Before).toHaveLength(1);
    expect(byFolder.Before[0]).toContain('rail before');
    // Three completion shots: two on Bldg 4, one on Bldg 9 — and the site photo.
    expect(byFolder.After).toHaveLength(4);
    expect(byFolder.Issues).toHaveLength(1);
    expect(byFolder.Issues[0]).toContain('rot');
    expect(byFolder.Documents).toEqual(['Documents/01 — scope.pdf']);
  });

  test('a FLAGGED photo is an Issue even though it is technically a completion photo', () => {
    // This is the case a naive "before tag or not" split gets wrong: the flag
    // photo has no 'before' tag, so photoKindOf calls it a completion. The
    // folder rule has to look at the flag FIRST.
    const asFlag = { mime_type: 'image/jpeg', tags: '["flag"]' };
    expect(exporter.folderFor(asFlag, {})).toBe(exporter.FOLDER.issue);
    expect(exporter.folderFor({ mime_type: 'image/jpeg', tags: '[]', is_flag_photo: true }, {}))
      .toBe(exporter.FOLDER.issue);
    // …and without the flag it is exactly what the rest of the app calls it.
    expect(exporter.folderFor({ mime_type: 'image/jpeg', tags: '[]' }, {})).toBe(exporter.FOLDER.after);
    expect(exporter.folderFor({ mime_type: 'image/jpeg', tags: '["before"]' }, {})).toBe(exporter.FOLDER.before);
  });

  test('the building groups its photos, and they keep their order', async () => {
    const res = await exportZip('st_a');
    const after = namesIn(res.buffer()).map((e) => e.name).filter((n) => n.startsWith('After/'));
    expect(after).toEqual([
      'After/01 — site.jpg',
      'After/Bldg 4 — 02 — rail done.jpg',
      'After/Bldg 4 — 03 — valve.jpg',
      'After/Bldg 9 — 04 — rail fixed.jpg',
    ]);
  });

  test('a non-image is a Document, not a photo in the wrong folder', () => {
    expect(exporter.folderFor({ mime_type: 'application/pdf', tags: '[]' }, {})).toBe(exporter.FOLDER.document);
    expect(exporter.folderFor({ mime_type: 'text/csv', tags: '["before"]' }, {})).toBe(exporter.FOLDER.document);
  });

  test('the bytes in the archive are the bytes in storage', async () => {
    const res = await exportZip('st_a');
    const entry = namesIn(res.buffer()).find((e) => e.name.includes('rail before'));
    expect(entry.body).toBe('BYTES:a_b4');
  });
});

// ── 2. A RECEIPT IS A PICTURE OF PRICES ──────────────────────────────────
describe('receipts do not go out with the photos', () => {
  test('not in the archive, and not as an empty folder either', async () => {
    const res = await exportZip('st_a');
    const names = namesIn(res.buffer()).map((e) => e.name);
    expect(names.some((n) => /receipt/i.test(n))).toBe(false);
    expect(names.some((n) => /home depot/i.test(n))).toBe(false);
    expect(names.some((n) => n.startsWith('Receipts/'))).toBe(false);
  });

  test('the summary SAYS they were left out, so nobody assumes they are in there', async () => {
    const res = await exportZip('st_a');
    const summary = namesIn(res.buffer()).find((e) => e.name === 'Work order summary.txt');
    expect(summary.body).toContain('Receipts are not included');
  });

  test('asking for them needs a money capability, not just access to the work order', async () => {
    const res = await exportZip('st_a', { query: { receipts: '1' }, as: WIDE });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/cost/i);
    expect(res.buffer()).toHaveLength(0);
  });

  test('and with it they come, in their own folder, with the summary saying so', async () => {
    const res = await exportZip('st_a', { query: { receipts: '1' }, as: MONEY });
    expect(res.statusCode).toBe(200);
    const entries = namesIn(res.buffer());
    const receipts = entries.map((e) => e.name).filter((n) => n.startsWith('Receipts/'));
    expect(receipts).toEqual(['Receipts/01 — home depot.jpg']);
    const summary = entries.find((e) => e.name === 'Work order summary.txt');
    expect(summary.body).toContain('INCLUDES receipts');
  });

  test('a receipt stays a receipt even if it is also tagged before', () => {
    // Tag order must not decide this. The receipt rule is checked first.
    const row = { mime_type: 'image/jpeg', tags: '["before","receipt"]' };
    expect(exporter.folderFor(row, {})).toBe(null);
    expect(exporter.folderFor(row, { receipts: true })).toBe(exporter.FOLDER.receipt);
  });
});

// ── 3. the download itself ───────────────────────────────────────────────
describe('the response', () => {
  test('is a zip attachment named after the work order', async () => {
    const res = await exportZip('st_a');
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('attachment;');
    expect(res.headers['content-disposition']).toContain('WO-0001 Pump room leak.zip');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('it opens with a local file header and closes with an EOCD', async () => {
    const buf = (await exportZip('st_a')).buffer();
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
  });

  test('a work order with nothing on it is refused, not sent as an empty zip', async () => {
    const res = await exportZip('st_empty');
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe(exporter.MSG.nothing);
    expect(res.buffer()).toHaveLength(0);
  });

  test('an unreadable object leaves a MARKER, so the gap is visible', async () => {
    // A photo whose bytes have gone. The other eight must still arrive, and
    // the hole must be something somebody notices rather than a quiet absence.
    mockBytes.delete('a_c4.bin');
    const res = await exportZip('st_a');
    expect(res.statusCode).toBe(200);
    const names = namesIn(res.buffer()).map((e) => e.name);
    expect(names.some((n) => n.endsWith('.MISSING.txt'))).toBe(true);
    expect(names.some((n) => n.includes('rail before'))).toBe(true);   // the rest survived
  });
});

// ── 4. another tenant ────────────────────────────────────────────────────
describe('another tenant', () => {
  test('gets a 404 and not one byte', async () => {
    const res = await exportZip('st_a', { as: RIVAL });
    expect(res.statusCode).toBe(404);
    expect(res.buffer()).toHaveLength(0);
  });

  test('and its own photos are the only ones in its own export', async () => {
    const res = await exportZip('st_b', { as: RIVAL });
    expect(res.statusCode).toBe(200);
    const bodies = namesIn(res.buffer()).map((e) => e.body).join('|');
    expect(bodies).toContain('BYTES:a_riv');
    for (const id of ['a_b4', 'a_c4', 'a_site', 'a_doc', 'a_flag']) {
      expect([id, bodies.includes('BYTES:' + id)]).toEqual([id, false]);
    }
  });
});

// ── 5. names ─────────────────────────────────────────────────────────────
describe('what things are called', () => {
  test('the archive is named for the work order, and is safe as a filename', () => {
    expect(exporter.archiveName({ ticket_number: 'WO-0001', title: 'Pump room leak' }))
      .toBe('WO-0001 Pump room leak.zip');
    expect(exporter.archiveName({ ticket_number: 'WO-2', title: 'A/B: "quoted" <bad>' }))
      .toBe('WO-2 A B quoted bad .zip'.replace(/\s+\.zip$/, '.zip'));
    expect(exporter.archiveName({})).toBe('work-order.zip');
  });

  test('a building name comes off the subtask title the same way the rest does', () => {
    expect(exporter.headOf('Bldg 4 — Side A: pump room')).toBe('Bldg 4');
    expect(exporter.headOf('Bldg 9 - rails')).toBe('Bldg 9');
    expect(exporter.headOf('Just a name')).toBe('Just a name');
    expect(exporter.headOf('')).toBe(null);
  });

  test('a file with no extension still gets one from its type', () => {
    expect(exporter.entryNameFor({ filename: 'photo', mime_type: 'image/jpeg' }, 0)).toBe('01 — photo.jpg');
    expect(exporter.entryNameFor({ filename: 'x.JPG', mime_type: 'image/jpeg', building: 'Bldg 4' }, 4))
      .toBe('Bldg 4 — 05 — x.JPG');
  });
});
