// A WORK-ORDER PHOTO ANSWERS TO THE TICKET'S RULE ON EVERY AGENT PHOTO DOOR.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────
// read_attachment_text, view_attachment_image, read_photo_comments and
// add_photo_comment take a bare attachment id and asked one question of it:
// attachmentInOrg — "is this file in the caller's tenant". For a service ticket
// that is not the rule. A ticket inherits its PARENT's capability (a job's or a
// lead's), and on a job the narrow tier is narrowed to jobs the caller owns or
// was granted; the attachment REST doors ask that through
// ticketAttachmentAccess. So an in-org user the ticket rule refuses — a crew
// lead on a job they were never granted, a leads-only user on a job ticket —
// got the photo's PIXELS, its extracted text and its comment thread from the
// agent, and could post into that thread.
//
// ── WHAT IS DRIVEN ───────────────────────────────────────────────────────
// Against a real SQL engine with real role capabilities, through the live
// dispatcher the model's tool calls land on (make86OnCustomToolUse):
//   1. A hidden verdict (narrow tier, ungranted job; a ticket that is not
//      there) answers the tool's EXISTING not-found sentence, byte for byte the
//      one an invented attachment id gets.
//   2. Any other refusal answers read_entity's permission sentence for the
//      parent kind's capabilities — the write sentence for add_photo_comment,
//      which inserts nothing.
//   3. add_photo_comment takes the WRITE rule: a view grant reads the thread and
//      cannot post into it; an edit grant can.
//   4. Every other entity type is untouched: a job photo is still read and
//      commented on by an in-org caller holding no job capability at all, as
//      before.
// Then every guard is removed from a copy of the shipped source and the same
// drive is shown to leak. The copy keeps the file's real line endings (the repo
// is CRLF), an absent or repeated anchor throws, and a replace that moved no
// bytes throws.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
// Each mutant is a fresh compile of a 17k-line module, and a drive runs a
// detached chain; under a parallel run the 5s default is not a property of the code.
jest.setTimeout(60000);

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

const loadedPaths = [];
function load(pairs) {
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const at = out.indexOf(f);
    if (at === -1) throw new Error('MUTATION ANCHOR NOT FOUND: ' + JSON.stringify(f.slice(0, 200)));
    if (out.indexOf(f, at + 1) !== -1) throw new Error('MUTATION ANCHOR NOT UNIQUE: ' + JSON.stringify(f.slice(0, 200)));
    const next = out.slice(0, at) + r + out.slice(at + f.length);
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + f.slice(0, 80));
    out = next;
  }
  out += eol + 'module.exports.__make86OnCustomToolUse = make86OnCustomToolUse;' + eol;
  const p = path.join(os.tmpdir(), '_p86_ticketphoto_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out), 'utf8');
  loadedPaths.push(p);
  jest.useFakeTimers();
  let m;
  try { m = require(p); } finally { jest.useRealTimers(); }
  return m;
}

// ── the world ─────────────────────────────────────────────────────────────
const TABLES = ['users', 'organizations', 'roles', 'leads', 'jobs', 'job_access',
  'service_tickets', 'attachments', 'messages', 'message_reads', 'context_load_events'];

const ORG_A = 1;
const ORG_B = 2;
const ALICE = { id: 11, role: 'r_all', organization_id: ORG_A };        // every job + lead cap
const NATE = { id: 12, role: 'r_assigned', organization_id: ORG_A };    // narrow job tier only
const LEAH = { id: 13, role: 'r_leads', organization_id: ORG_A };       // LEADS_VIEW + LEADS_EDIT
const VIC = { id: 16, role: 'r_leadview', organization_id: ORG_A };     // LEADS_VIEW only
const NOCAP = { id: 15, role: 'r_none', organization_id: ORG_A };

let eng, shipped;

function seed() {
  eng.db.exec(`
    INSERT INTO roles (name, capabilities) VALUES
      ('r_all','${JSON.stringify(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}'),
      ('r_assigned','${JSON.stringify(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}'),
      ('r_leads','${JSON.stringify(['LEADS_VIEW', 'LEADS_EDIT'])}'),
      ('r_leadview','${JSON.stringify(['LEADS_VIEW'])}'),
      ('r_none','[]');
    INSERT INTO organizations (id, name) VALUES (${ORG_A},'AGX'), (${ORG_B},'Beta Builders');
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (11,'Alice Office','alice@agx.test','r_all',${ORG_A},1),
      (12,'Nate Narrow','nate@agx.test','r_assigned',${ORG_A},1),
      (13,'Leah Leads','leah@agx.test','r_leads',${ORG_A},1),
      (14,'Vera Owner','vera@agx.test','r_all',${ORG_A},1),
      (15,'Nobody Nocap','nocap@agx.test','r_none',${ORG_A},1),
      (16,'Vic Viewer','vic@agx.test','r_leadview',${ORG_A},1),
      (21,'Bob Beta','bob@beta.test','r_all',${ORG_B},1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 14, '{"jobNumber":"25-100","title":"Maple St"}', ${ORG_A}),
      ('j2', 14, '{"jobNumber":"25-200","title":"Oak Ave"}', ${ORG_A}),
      ('j3', 14, '{"jobNumber":"25-300","title":"Pine Ct"}', ${ORG_A});
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j2', 12, 'view'), ('j3', 12, 'edit');
    INSERT INTO leads (id, title, organization_id) VALUES ('l1','Waterside Gazebo',${ORG_A});

    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, priority) VALUES
      ('st_j1', ${ORG_A}, 'Ungranted job ticket', 'j1', NULL, 'open', 'normal'),
      ('st_j2', ${ORG_A}, 'View-granted job ticket', 'j2', NULL, 'open', 'normal'),
      ('st_j3', ${ORG_A}, 'Edit-granted job ticket', 'j3', NULL, 'open', 'normal'),
      ('st_l1', ${ORG_A}, 'Lead ticket', NULL, 'l1', 'open', 'normal'),
      ('st_np', ${ORG_A}, 'Parentless ticket', NULL, NULL, 'open', 'normal');

    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes, organization_id,
        uploaded_by, extracted_text, web_key, anthropic_file_id) VALUES
      ('att_tk_j1', 'service_ticket', 'st_j1', 'crew-j1.jpg', 'image/jpeg', 2048, ${ORG_A}, 14, 'TEXT-J1-MARKER', 'k/j1', 'file_tk_j1'),
      ('att_tk_j2', 'service_ticket', 'st_j2', 'crew-j2.jpg', 'image/jpeg', 2048, ${ORG_A}, 14, 'TEXT-J2-MARKER', 'k/j2', 'file_tk_j2'),
      ('att_tk_j3', 'service_ticket', 'st_j3', 'crew-j3.jpg', 'image/jpeg', 2048, ${ORG_A}, 14, 'TEXT-J3-MARKER', 'k/j3', 'file_tk_j3'),
      ('att_tk_l1', 'service_ticket', 'st_l1', 'crew-l1.jpg', 'image/jpeg', 2048, ${ORG_A}, 14, 'TEXT-L1-MARKER', 'k/l1', 'file_tk_l1'),
      ('att_tk_np', 'service_ticket', 'st_np', 'crew-np.jpg', 'image/jpeg', 2048, ${ORG_A}, 14, 'TEXT-NP-MARKER', 'k/np', 'file_tk_np'),
      -- Stamped in-org, so attachmentInOrg passes on the row's own stamp; the
      -- ticket it names is not there. The ticket rule must hide it.
      ('att_tk_gone', 'service_ticket', 'st_absent', 'crew-gone.jpg', 'image/jpeg', 2048, ${ORG_A}, 14, 'TEXT-GONE-MARKER', 'k/gone', 'file_tk_gone'),
      -- The two early returns that PRINT the filename and mime: an image with
      -- no extracted text (read_attachment_text) and a PDF (view_attachment_image),
      -- on an ungranted ticket and on a ticket that is not there.
      ('att_tk_j1_scan', 'service_ticket', 'st_j1', 'SCAN-J1-FILENAME.jpg', 'image/jpeg', 2048, ${ORG_A}, 14, NULL, 'k/j1s', 'file_tk_j1_scan'),
      ('att_tk_j1_pdf', 'service_ticket', 'st_j1', 'PDF-J1-FILENAME.pdf', 'application/pdf', 4096, ${ORG_A}, 14, NULL, 'k/j1p', NULL),
      ('att_tk_gone_scan', 'service_ticket', 'st_absent', 'SCAN-GONE-FILENAME.jpg', 'image/jpeg', 2048, ${ORG_A}, 14, NULL, 'k/gs', 'file_tk_gone_scan'),
      ('att_tk_gone_pdf', 'service_ticket', 'st_absent', 'PDF-GONE-FILENAME.pdf', 'application/pdf', 4096, ${ORG_A}, 14, NULL, 'k/gp', NULL),
      -- The non-ticket control.
      ('att_job_j1', 'job', 'j1', 'job-j1.jpg', 'image/jpeg', 2048, ${ORG_A}, 14, 'TEXT-JOB-MARKER', 'k/job', 'file_job_j1');

    INSERT INTO messages (id, thread_key, user_id, body, organization_id, created_at) VALUES
      ('m1', 'attachment:att_tk_j1', 14, 'COMMENT-J1-MARKER', ${ORG_A}, '2026-09-01T10:00:00Z'),
      ('m2', 'attachment:att_tk_j2', 14, 'COMMENT-J2-MARKER', ${ORG_A}, '2026-09-01T10:00:00Z'),
      ('m3', 'attachment:att_tk_l1', 14, 'COMMENT-L1-MARKER', ${ORG_A}, '2026-09-01T10:00:00Z'),
      ('m4', 'attachment:att_tk_gone', 14, 'COMMENT-GONE-MARKER', ${ORG_A}, '2026-09-01T10:00:00Z'),
      ('m5', 'attachment:att_job_j1', 14, 'COMMENT-JOB-MARKER', ${ORG_A}, '2026-09-01T10:00:00Z');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(
    sqliteSchema(TABLES) +
      // db.js: PRIMARY KEY (thread_key, user_id), which add_photo_comment's
      // ON CONFLICT names. The derived schema carries no keys.
      '\nCREATE UNIQUE INDEX ux_message_reads ON message_reads(thread_key, user_id);\n',
    { jsonColumns: ['capabilities', 'data'] });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  jest.useFakeTimers();
  const auth = require('../server/auth');
  jest.useRealTimers();
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  shipped = load([]);
});

const flush = () => new Promise((r) => setTimeout(r, 25));
afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
  for (const p of loadedPaths) { try { fs.unlinkSync(p); } catch (_) {} }
});

// The live dispatcher, as the model reaches it. A fresh door per call, so the
// per-turn dedupe cache never answers for a different caller or module.
// Returns the WHOLE answer flattened — a leak inside an image block must not
// read as absent.
async function call(mod, user, tool, input) {
  const door = mod.__make86OnCustomToolUse(user.id, null, '', user, user.organization_id);
  const r = await door({ name: tool, input });
  return r.error != null ? 'ERROR: ' + String(r.error) : JSON.stringify(r.blocks || r.summary);
}
const commentCount = (attId) =>
  eng.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_key = ?').all('attachment:' + attId)[0].n;

const READ_DENIED_JOB = JSON.stringify('Permission denied: the current user lacks the JOBS_VIEW_ALL or JOBS_VIEW_ASSIGNED ' +
  'capability required to read this. Tell the user you can\'t show this data because their role ' +
  'doesn\'t have access, and suggest they contact an admin if they need it.');
const READ_DENIED_LEAD = JSON.stringify('Permission denied: the current user lacks the LEADS_VIEW ' +
  'capability required to read this. Tell the user you can\'t show this data because their role ' +
  'doesn\'t have access, and suggest they contact an admin if they need it.');
const READ_DENIED_COARSE = JSON.stringify('Permission denied: the current user lacks the JOBS_VIEW_ALL or JOBS_VIEW_ASSIGNED or LEADS_VIEW ' +
  'capability required to read this. Tell the user you can\'t show this data because their role ' +
  'doesn\'t have access, and suggest they contact an admin if they need it.');
const WRITE_DENIED_LEAD = JSON.stringify('Permission denied: the current user lacks the LEADS_EDIT ' +
  'capability required to make this change. The change was NOT applied. Tell the user ' +
  'their role doesn\'t allow this action and suggest they ask an admin to do it.');

// The three reads, each with its own not-found sentence and its own evidence
// that the row was served.
const MARK = { att_tk_j1: 'J1', att_tk_j2: 'J2', att_tk_l1: 'L1', att_job_j1: 'JOB' };
const READS = [
  { tool: 'read_attachment_text', notFound: (id) => JSON.stringify('No attachment with id ' + id + '.'),
    served: (id) => 'TEXT-' + MARK[id] + '-MARKER' },
  { tool: 'view_attachment_image', notFound: (id) => JSON.stringify('No attachment with id ' + id + '.'),
    served: (id) => 'file_' + id.replace(/^att_/, '') },
  { tool: 'read_photo_comments', notFound: (id) => JSON.stringify('Attachment ' + id + ' not found.'),
    served: (id) => 'COMMENT-' + MARK[id] + '-MARKER' },
];

/* ═══════════════════════════════════════════════════════════════════════════
 * THE THREE READS
 * ══════════════════════════════════════════════════════════════════════════*/
describe.each(READS)('$tool', ({ tool, notFound, served }) => {
  const read = (mod, user, id) => call(mod, user, tool, { attachment_id: id });

  test('the positive control: a caller the ticket rule allows is served', async () => {
    expect(await read(shipped, ALICE, 'att_tk_j1')).toContain(served('att_tk_j1'));
    expect(await read(shipped, NATE, 'att_tk_j2')).toContain(served('att_tk_j2'));   // a view grant reads
    expect(await read(shipped, LEAH, 'att_tk_l1')).toContain(served('att_tk_l1'));
  });

  test('a narrow-tier caller on a job never granted to them gets exactly the absent-id sentence', async () => {
    const ungranted = await read(shipped, NATE, 'att_tk_j1');
    const absent = await read(shipped, NATE, 'att_nope');
    expect(ungranted).toBe(notFound('att_tk_j1'));
    expect(absent).toBe(notFound('att_nope'));
    expect(ungranted.replace('att_tk_j1', '<id>')).toBe(absent.replace('att_nope', '<id>'));
    expect(ungranted).not.toContain(served('att_tk_j1'));
  });

  test('a ticket that is not there answers as an absent attachment, even with the file stamped in-org', async () => {
    const gone = await read(shipped, ALICE, 'att_tk_gone');
    expect(gone).toBe(notFound('att_tk_gone'));
    expect(gone.replace('att_tk_gone', '<id>')).toBe((await read(shipped, ALICE, 'att_nope')).replace('att_nope', '<id>'));
  });

  test('a caller whose role cannot read the parent KIND gets read_entity\'s permission sentence', async () => {
    expect(await read(shipped, LEAH, 'att_tk_j1')).toBe(READ_DENIED_JOB);
    expect(await read(shipped, NOCAP, 'att_tk_l1')).toBe(READ_DENIED_LEAD);
    // A ticket with no parent kind names the coarse three, never an empty list.
    expect(await read(shipped, ALICE, 'att_tk_np')).toBe(READ_DENIED_COARSE);
  });

  test('every other entity type is untouched: an in-org caller with no job capability still reads a job photo', async () => {
    expect(await read(shipped, NOCAP, 'att_job_j1')).toContain(served('att_job_j1'));
    expect(await read(shipped, LEAH, 'att_job_j1')).toContain(served('att_job_j1'));
  });
});

// THE TICKET CHECK SITS ABOVE THE EARLY RETURNS THAT NAME THE FILE. Both reads
// have a return before the payload — "no extracted text" and "not an image" —
// and each prints the filename and mime. Below the ticket check, a caller the
// ticket rule refuses would learn the work order's file names from them.
const EARLY = [
  // [tool, the row that reaches that tool's early return, its absent-ticket twin, filename marker, twin's, the early return]
  ['read_attachment_text', 'att_tk_j1_scan', 'att_tk_gone_scan', 'SCAN-J1-FILENAME', 'SCAN-GONE-FILENAME', /has no extracted text on file/],
  ['view_attachment_image', 'att_tk_j1_pdf', 'att_tk_gone_pdf', 'PDF-J1-FILENAME', 'PDF-GONE-FILENAME', /is not an image \(mime=application\/pdf\)/],
];
const NOT_FOUND = (id) => JSON.stringify('No attachment with id ' + id + '.');

describe.each(EARLY)('%s: the ticket check comes before the early return', (tool, id, goneId, name, goneName, early) => {
  const read = (mod, user, attId) => call(mod, user, tool, { attachment_id: attId });

  test('the positive control: an allowed caller reaches that early return, and it names the file', async () => {
    const r = await read(shipped, ALICE, id);
    expect(r).toMatch(early);
    expect(r).toContain(name);
  });

  test('an ungranted narrow-tier reader gets exactly the absent-id sentence, never the filename', async () => {
    const ungranted = await read(shipped, NATE, id);
    const absent = await read(shipped, NATE, 'att_nope');
    expect(ungranted).toBe(NOT_FOUND(id));
    expect(ungranted.replace(id, '<id>')).toBe(absent.replace('att_nope', '<id>'));
    expect(ungranted).not.toContain(name);
  });

  test('a ticket that is not there answers as an absent attachment, never the filename', async () => {
    const gone = await read(shipped, ALICE, goneId);
    expect(gone).toBe(NOT_FOUND(goneId));
    expect(gone.replace(goneId, '<id>')).toBe((await read(shipped, ALICE, 'att_nope')).replace('att_nope', '<id>'));
    expect(gone).not.toContain(goneName);
  });

  test('a leads-only reader of a job ticket gets the job read-denied sentence, never the filename', async () => {
    const r = await read(shipped, LEAH, id);
    expect(r).toBe(READ_DENIED_JOB);
    expect(r).not.toContain(name);
  });
});

// Each tool against BOTH shapes, so neither answer depends on which early
// return a row happens to reach.
test.each([
  ['read_attachment_text', 'att_tk_j1_scan', 'att_tk_gone_scan'],
  ['read_attachment_text', 'att_tk_j1_pdf', 'att_tk_gone_pdf'],
  ['view_attachment_image', 'att_tk_j1_scan', 'att_tk_gone_scan'],
  ['view_attachment_image', 'att_tk_j1_pdf', 'att_tk_gone_pdf'],
])('%s on %s: ungranted and absent-ticket readers get the not-found sentence', async (tool, id, goneId) => {
  expect(await call(shipped, NATE, tool, { attachment_id: id })).toBe(NOT_FOUND(id));
  expect(await call(shipped, ALICE, tool, { attachment_id: goneId })).toBe(NOT_FOUND(goneId));
  expect(await call(shipped, LEAH, tool, { attachment_id: id })).toBe(READ_DENIED_JOB);
});

// A ctx with no acting user, through the one executor door every dispatcher
// shares. Returned text or a thrown message, flattened, so the two can be compared.
async function callNoUser(mod, tool, input) {
  try {
    return JSON.stringify(await mod.internals.execAgentTool(tool, input, { userId: 11, orgId: ORG_A, user: null }));
  } catch (e) {
    return 'THROWN: ' + String(e && e.message);
  }
}
const NO_USER_TOOLS = [
  ['read_attachment_text', READ_DENIED_COARSE, 'TEXT-J1-MARKER'],
  ['view_attachment_image', READ_DENIED_COARSE, 'file_tk_j1'],
  ['read_photo_comments', READ_DENIED_COARSE, 'COMMENT-J1-MARKER'],
  ['add_photo_comment', JSON.stringify('Permission denied: the current user lacks the JOBS_EDIT_ANY or JOBS_EDIT_OWN or LEADS_EDIT ' +
    'capability required to make this change. The change was NOT applied. Tell the user ' +
    'their role doesn\'t allow this action and suggest they ask an admin to do it.'), null],
];

describe.each(NO_USER_TOOLS)('%s with no acting user', (tool, denied, leak) => {
  test('is refused, never served, and a real ticket answers exactly as a ticket that is not there', async () => {
    const bj = commentCount('att_tk_j1');
    const bg = commentCount('att_tk_gone');
    const real = await callNoUser(shipped, tool, { attachment_id: 'att_tk_j1', body: 'x' });
    const gone = await callNoUser(shipped, tool, { attachment_id: 'att_tk_gone', body: 'x' });
    expect(real).toBe(denied);
    expect(gone).toBe(real);
    if (leak) expect(real).not.toContain(leak);
    expect(commentCount('att_tk_j1')).toBe(bj);
    expect(commentCount('att_tk_gone')).toBe(bg);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * add_photo_comment — THE WRITE RULE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('add_photo_comment', () => {
  const post = (mod, user, id, body) => call(mod, user, 'add_photo_comment', { attachment_id: id, body: body || 'from the agent' });

  test('the positive control: callers the write rule allows post', async () => {
    const before = commentCount('att_tk_j1');
    expect(await post(shipped, ALICE, 'att_tk_j1')).toMatch(/Comment posted on attachment att_tk_j1/);
    expect(commentCount('att_tk_j1')).toBe(before + 1);
    expect(await post(shipped, NATE, 'att_tk_j3')).toMatch(/Comment posted/);   // an EDIT grant posts
    expect(await post(shipped, LEAH, 'att_tk_l1')).toMatch(/Comment posted/);
  });

  test('a VIEW grant reads the thread but cannot post into it — the absent-id answer, nothing inserted', async () => {
    const before = commentCount('att_tk_j2');
    const viewOnly = await post(shipped, NATE, 'att_tk_j2');
    const absent = await post(shipped, NATE, 'att_nope');
    expect(viewOnly).toBe('ERROR: Error: Attachment att_tk_j2 not found.');
    expect(viewOnly.replace('att_tk_j2', '<id>')).toBe(absent.replace('att_nope', '<id>'));
    expect(commentCount('att_tk_j2')).toBe(before);
  });

  test('an ungranted job and an absent ticket are not found too', async () => {
    const b1 = commentCount('att_tk_j1');
    const bg = commentCount('att_tk_gone');
    expect(await post(shipped, NATE, 'att_tk_j1')).toBe('ERROR: Error: Attachment att_tk_j1 not found.');
    expect(await post(shipped, ALICE, 'att_tk_gone')).toBe('ERROR: Error: Attachment att_tk_gone not found.');
    expect(commentCount('att_tk_j1')).toBe(b1);
    expect(commentCount('att_tk_gone')).toBe(bg);
  });

  test('a role that can read the lead but not edit it gets the WRITE permission sentence, and nothing is inserted', async () => {
    const before = commentCount('att_tk_l1');
    expect(await post(shipped, VIC, 'att_tk_l1')).toBe(WRITE_DENIED_LEAD);
    expect(commentCount('att_tk_l1')).toBe(before);
    // ...while the same caller still READS that thread.
    expect(await call(shipped, VIC, 'read_photo_comments', { attachment_id: 'att_tk_l1' })).toContain('COMMENT-L1-MARKER');
  });

  test('every other entity type is untouched: a no-capability caller still comments on a job photo', async () => {
    const before = commentCount('att_job_j1');
    expect(await post(shipped, NOCAP, 'att_job_j1')).toMatch(/Comment posted/);
    expect(commentCount('att_job_j1')).toBe(before + 1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MUTATIONS — each guard removed, the same drive shown to leak
 * ══════════════════════════════════════════════════════════════════════════*/
describe('every guard is load-bearing', () => {
  test.each([
    ['read_attachment_text',
      "      if (_atTicket) return _atTicket.hidden ? 'No attachment with id ' + attachmentId + '.' : _atTicket.text;\n",
      'TEXT-J1-MARKER'],
    ['view_attachment_image',
      "      if (_viTicket) return _viTicket.hidden ? 'No attachment with id ' + attachmentId + '.' : _viTicket.text;\n",
      'file_tk_j1'],
    ['read_photo_comments',
      '    if (_pcTicket) return _pcTicket.hidden ? `Attachment ${attId} not found.` : _pcTicket.text;\n',
      'COMMENT-J1-MARKER'],
  ])('RED: without the ticket check in %s, an ungranted crew lead and a leads-only user are served', async (tool, find, leak) => {
    const m = load([[find, '']]);
    expect(await call(m, NATE, tool, { attachment_id: 'att_tk_j1' })).toContain(leak);
    expect(await call(m, LEAH, tool, { attachment_id: 'att_tk_j1' })).toContain(leak);
    expect(await call(shipped, NATE, tool, { attachment_id: 'att_tk_j1' })).not.toContain(leak);
  });

  // One mutant per reordering: the ticket check moved BELOW the early return.
  const AT_CHECK =
    "      const _atTicket = await ticketPhotoRefusal(r.rows[0], ctx, 'read');\n" +
    "      if (_atTicket) return _atTicket.hidden ? 'No attachment with id ' + attachmentId + '.' : _atTicket.text;\n";
  const AT_EARLY =
    "      const row = r.rows[0];\n" +
    "      const txt = row.extracted_text || '';\n" +
    '      if (!txt) {\n' +
    "        return 'Attachment \"' + (row.filename || attachmentId) + '\" (' + (row.mime_type || 'unknown') +\n" +
    "          ') has no extracted text on file. ' +\n" +
    "          'If this is a scanned PDF or image-only doc, ask the user to click \"Ask AI\" from the PDF viewer to attach page renders this turn.';\n" +
    '      }\n';
  const VI_CHECK =
    "      const _viTicket = await ticketPhotoRefusal(r.rows[0], ctx, 'read');\n" +
    "      if (_viTicket) return _viTicket.hidden ? 'No attachment with id ' + attachmentId + '.' : _viTicket.text;\n";
  const VI_EARLY =
    "      const row = r.rows[0];\n" +
    "      if (!row.mime_type || !row.mime_type.startsWith('image/')) {\n" +
    "        return 'Attachment \"' + (row.filename || attachmentId) + '\" is not an image (mime=' +\n" +
    "          (row.mime_type || 'unknown') + '). Use read_attachment_text for documents.';\n" +
    '      }\n';
  test.each([
    ['read_attachment_text', AT_CHECK + AT_EARLY, AT_EARLY + AT_CHECK, 'att_tk_j1_scan', 'att_tk_gone_scan', 'SCAN-J1-FILENAME', 'SCAN-GONE-FILENAME'],
    ['view_attachment_image', VI_CHECK + VI_EARLY, VI_EARLY + VI_CHECK, 'att_tk_j1_pdf', 'att_tk_gone_pdf', 'PDF-J1-FILENAME', 'PDF-GONE-FILENAME'],
  ])('RED: with the ticket check below the early return in %s, refused readers learn the filename', async (tool, find, replace, id, goneId, name, goneName) => {
    const m = load([[find, replace]]);
    expect(await call(m, NATE, tool, { attachment_id: id })).toContain(name);
    expect(await call(m, LEAH, tool, { attachment_id: id })).toContain(name);
    expect(await call(m, ALICE, tool, { attachment_id: goneId })).toContain(goneName);
  });

  test('RED: without the ticket check in add_photo_comment, a view grant posts into the thread', async () => {
    const m = load([[
      '    if (_acTicket) {\n',
      '    if (false) {\n',
    ]]);
    const before = commentCount('att_tk_j2');
    expect(await call(m, NATE, 'add_photo_comment', { attachment_id: 'att_tk_j2', body: 'x' })).toMatch(/Comment posted/);
    expect(commentCount('att_tk_j2')).toBe(before + 1);
  });

  test('RED: without the hidden-verdict throw in add_photo_comment, a view grant answers differently from an absent id', async () => {
    // The permission branch alone would hand back `undefined` text for a hidden
    // verdict — nothing inserted, but an answer that is not the absent-id error,
    // so "that work order exists" leaks to a narrow-tier caller.
    const m = load([['      if (_acTicket.hidden) throw new Error(`Attachment ${attId} not found.`);\n', '']]);
    const before = commentCount('att_tk_j2');
    const viewOnly = await call(m, NATE, 'add_photo_comment', { attachment_id: 'att_tk_j2', body: 'x' });
    const absent = await call(m, NATE, 'add_photo_comment', { attachment_id: 'att_nope', body: 'x' });
    expect(absent).toBe('ERROR: Error: Attachment att_nope not found.');
    expect(String(viewOnly).replace('att_tk_j2', '<id>')).not.toBe(absent.replace('att_nope', '<id>'));
    expect(commentCount('att_tk_j2')).toBe(before);
  });

  test('RED: asking the READ rule for add_photo_comment lets a view grant and a lead viewer post', async () => {
    const m = load([["    const _acTicket = await ticketPhotoRefusal(attChk.rows[0], ctx, 'write');\n",
      "    const _acTicket = await ticketPhotoRefusal(attChk.rows[0], ctx, 'read');\n"]]);
    expect(await call(m, NATE, 'add_photo_comment', { attachment_id: 'att_tk_j2', body: 'x' })).toMatch(/Comment posted/);
    expect(await call(m, VIC, 'add_photo_comment', { attachment_id: 'att_tk_l1', body: 'x' })).toMatch(/Comment posted/);
  });

  test('RED: answering a hidden verdict with the permission sentence makes the narrow tier an existence oracle', async () => {
    const m = load([['  if (!verdict || verdict.hidden !== false) return { hidden: true };\n',
      '  if (!verdict) return { hidden: true };\n']]);
    const real = await call(m, NATE, 'read_attachment_text', { attachment_id: 'att_tk_j1' });
    const absent = await call(m, NATE, 'read_attachment_text', { attachment_id: 'att_nope' });
    expect(real.replace('att_tk_j1', '<id>')).not.toBe(absent.replace('att_nope', '<id>'));
  });

  test('RED: without the entity_type test, every other entity type is dragged into the ticket rule', async () => {
    const m = load([['  if (!att || att.entity_type !== entityAccess.TICKET_ENTITY_TYPE) return null;\n',
      '  if (!att) return null;\n']]);
    expect(await call(m, NOCAP, 'read_attachment_text', { attachment_id: 'att_job_j1' })).not.toContain('TEXT-JOB-MARKER');
  });

  test('RED: naming the coarse caps instead of the parent kind\'s changes the sentence', async () => {
    const m = load([['  let caps = ticketAccess.capsForParentKind(verdict.kind, mode);\n',
      '  let caps = ticketAccess.coarseCaps(mode);\n']]);
    expect(await call(m, LEAH, 'read_attachment_text', { attachment_id: 'att_tk_j1' })).not.toBe(READ_DENIED_JOB);
  });

  test('RED: without the coarse fallback, a parentless ticket names no capability at all', async () => {
    const m = load([['  if (!caps.length) caps = ticketAccess.coarseCaps(mode);\n', '']]);
    expect(await call(m, ALICE, 'read_attachment_text', { attachment_id: 'att_tk_np' })).toContain('lacks the  capability');
  });

  test('RED: a write refusal worded as a read tells the model nothing about the change', async () => {
    const m = load([["  const verb = mode === 'write' ? 'write' : 'read';\n",
      "  const verb = 'read';\n"]]);
    expect(await call(m, VIC, 'add_photo_comment', { attachment_id: 'att_tk_l1', body: 'x' })).not.toBe(WRITE_DENIED_LEAD);
  });

  test('RED: without the no-user refusal before the load, a missing user turns the photo doors into a ticket-existence oracle', async () => {
    const m = load([[
      '  if (!user) return { hidden: false, text: capabilityDenialText(ticketAccess.coarseCaps(mode), verb) };\n',
      '',
    ]]);
    for (const [tool] of NO_USER_TOOLS) {
      const real = await callNoUser(m, tool, { attachment_id: 'att_tk_j1', body: 'x' });
      const gone = await callNoUser(m, tool, { attachment_id: 'att_tk_gone', body: 'x' });
      expect(real).not.toBe(gone);
    }
  });
});
