// THE WORK ORDER: where the job is, who to call, and a subtask is only done
// when a completion photo proves it (John, 2026-09-13).
//
// services/service-ticket-workorder.js is the one place both the office
// checkbox and the crew link go through, so its rules are driven here against
// node:sqlite through the pg shim, over the real schema:
//   * the site is the ticket's own address, else the job's (and its pin), and
//     the gate code is the ticket's access notes, else the lead's gate code;
//   * the contact is the first in-org user with a name, in the order given;
//   * a subtask needs a COMPLETION photo — a before photo does not count;
//   * the ticket follows its subtasks: the last one done → work_complete,
//     an undo on a ticket awaiting approval → in_progress;
//   * a task id from another ticket, another org, a private to-do or an
//     archived row is not a subtask of this ticket.
// Each rule is then removed from a copy of the module and shown to fail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const REAL = path.join(__dirname, '..', 'server', 'services', 'service-ticket-workorder.js');
const TABLES = ['organizations', 'users', 'jobs', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events'];

let eng;
const mutantPaths = [];

beforeAll(() => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['data', 'tags', 'detail', 'checklist', 'materials'] });
});
afterAll(() => {
  if (eng) eng.close();
  for (const p of mutantPaths) { try { fs.unlinkSync(p); } catch (_) {} }
});

function seed() {
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM leads; DELETE FROM tasks;
    DELETE FROM attachments; DELETE FROM service_tickets; DELETE FROM service_ticket_events;
    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival');
    INSERT INTO users (id, name, email, role, organization_id, phone_number) VALUES
      (10, 'Jason Salinas', 'j@agx.test', 'pm', 1, '(407) 555-0142'),
      (11, '', 'blank@agx.test', 'pm', 1, '555'),
      (50, 'Ray', 'r@rival.test', 'pm', 2, '999'),
      (12, 'Nophone Nick', 'n@agx.test', 'pm', 1, NULL);
    INSERT INTO leads (id, title, street_address, city, state, zip, gate_code, organization_id) VALUES
      ('l1', 'Latitude Wood Stair Tread Replace', '828 Orienta Ave', 'Altamonte Springs', 'FL', '32701', '#4410', 1);
    INSERT INTO jobs (id, owner_id, lead_id, organization_id, geocode_lat, geocode_lng, data) VALUES
      ('j1', 10, 'l1', 1, 28.66121, -81.3618,
       '{"jobNumber":"M1001","title":"BH Management Latitude Wood Stair Tread Replace","street_address":"828 Orienta Ave","city":"Altamonte Springs","state":"FL","zip":"32701","contractAmount":24000}'),
      ('j9', 50, NULL, 2, NULL, NULL, '{"jobNumber":"X9","title":"Rival job"}');
    INSERT INTO service_tickets (id, organization_id, title, job_id, status, checklist, created_by) VALUES
      ('st1', 1, 'Latitude 28 punch list', 'j1', 'open', '[]', 10),
      ('st2', 1, 'Other ticket', 'j1', 'open', '[]', 10),
      ('stx', 2, 'Rival ticket', 'j9', 'open', '[]', 50);
    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id) VALUES
      ('t782', 1, 'Bldg 782 — Side A: adjust metal railing', 'open', 'org', 'st1', 'job', 'j1'),
      ('t784', 1, 'Bldg 784 — Side A: replace 1 (4x4) post', 'open', 'org', 'st1', 'job', 'j1'),
      ('tpriv', 1, 'private to-do', 'open', 'personal', 'st1', 'job', 'j1'),
      ('tother', 1, 'task on another ticket', 'open', 'org', 'st2', 'job', 'j1');
  `);
}
beforeEach(seed);

function photo(id, taskId, tags, org, mime) {
  eng.db.prepare(
    "INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, thumb_url, web_url, tags, organization_id, position) VALUES (?, 'task', ?, 'p.jpg', ?, 'https://cdn/t', 'https://cdn/w', ?, ?, 0)"
  ).run(id, taskId, mime || 'image/jpeg', JSON.stringify(tags || []), org == null ? 1 : org);
}

const ticket = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const task = (id) => eng.all('SELECT id, status, completed_at FROM tasks WHERE id = ?', id)[0];
const events = () => eng.all('SELECT kind, actor_label, detail FROM service_ticket_events ORDER BY rowid');
const ACTOR = { kind: 'share', shareId: 'sh1', label: 'Marco' };

function load(mod) { return mod || require(REAL); }

function mutant(find, replace) {
  const src = fs.readFileSync(REAL, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const f = find.split('\n').join(eol);
  if (src.split(f).length !== 2) throw new Error('MUTATION ANCHOR not found exactly once: ' + find.slice(0, 80));
  const out = src.replace(f, replace.split('\n').join(eol))
    .replace("require('./service-tickets')", 'require(' + JSON.stringify(path.join(__dirname, '..', 'server', 'services', 'service-tickets.js').split(path.sep).join('/')) + ')');
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  const p = path.join(os.tmpdir(), '_p86_wo_' + process.pid + '_' + Math.random().toString(36).slice(2, 9) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return require(p);
}

describe('the site: where the work is', () => {
  test('a job ticket with no address of its own shows the job’s — number, name, address, pin, and the lead’s gate code', async () => {
    const site = await load().workOrderSite(eng.pool, ticket('st1'));
    expect(site).toEqual({
      kind: 'job', job_number: 'M1001', name: 'BH Management Latitude Wood Stair Tread Replace',
      address: '828 Orienta Ave, Altamonte Springs, FL, 32701', lat: 28.66121, lng: -81.3618, gate_code: '#4410',
    });
    expect(JSON.stringify(site)).not.toMatch(/24000|contract/i);
  });

  test('the ticket’s own address and access notes win, and the pin goes with the address', async () => {
    eng.db.exec("UPDATE service_tickets SET street_address = '800 Bldg Way', city = 'Altamonte Springs', state = 'FL', zip = '32701', lat = 28.7, lng = -81.4, access_notes = 'Gate 2 — code 1919' WHERE id = 'st1'");
    const site = await load().workOrderSite(eng.pool, ticket('st1'));
    expect([site.address, site.lat, site.lng, site.gate_code]).toEqual(['800 Bldg Way, Altamonte Springs, FL, 32701', 28.7, -81.4, 'Gate 2 — code 1919']);
  });

  test('a parent in another org yields no site at all', async () => {
    const t = Object.assign({}, ticket('st1'), { job_id: 'j9' });
    const site = await load().workOrderSite(eng.pool, t);
    expect([site.job_number, site.name, site.address]).toEqual([null, null, null]);
  });

  test('the contact is the first in-org user with a name, in the order given', async () => {
    const W = load();
    expect(await W.workOrderContact(eng.pool, 1, [11, 10])).toEqual({ name: 'Jason Salinas', phone: '(407) 555-0142' });
    expect(await W.workOrderContact(eng.pool, 1, [50])).toBeNull();
  });

  test('a sharer with no phone falls through to the next named user who has one', async () => {
    const W = load();
    expect(await W.workOrderContact(eng.pool, 1, [12, 10])).toEqual({ name: 'Jason Salinas', phone: '(407) 555-0142' });
    // Nobody with a phone: the first named user still comes back, with no number.
    expect(await W.workOrderContact(eng.pool, 1, [12])).toEqual({ name: 'Nophone Nick', phone: null });
  });
});

describe('subtask photos', () => {
  test('a photo is BEFORE only when tagged so; other orgs and non-images never appear', async () => {
    photo('a1', 't782', ['before']);
    photo('a2', 't782', ['completion']);
    photo('a3', 't782', []);
    photo('a4', 't782', ['completion'], 2);
    photo('a5', 't782', [], 1, 'application/pdf');
    const map = await load().taskPhotosByTask(eng.pool, 1, ['t782']);
    expect(map.get('t782').map((p) => [p.id, p.kind])).toEqual([['a1', 'before'], ['a2', 'completion'], ['a3', 'completion']]);
  });
});

describe('marking a subtask complete', () => {
  test('THE RULE: no completion photo → refused, nothing written', async () => {
    const r = await load().setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    expect([r.ok, r.status]).toEqual([false, 409]);
    expect(r.error).toMatch(/completion photo/);
    expect(task('t782').status).toBe('open');
    expect(events()).toEqual([]);
  });

  test('a BEFORE photo alone does not count', async () => {
    photo('b1', 't782', ['before']);
    const r = await load().setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    expect(r.status).toBe(409);
  });

  test('with a completion photo it is done, stamped, and attributed', async () => {
    photo('c1', 't782', ['completion']);
    const r = await load().setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    expect(r.ok).toBe(true);
    expect(task('t782').status).toBe('done');
    expect(task('t782').completed_at).toBeTruthy();
    expect(events().map((e) => [e.kind, e.actor_label])).toEqual([['subtask_completed', 'Marco']]);
    const act = await load().subtaskActivity(eng.pool, 1, 'st1');
    expect(act.get('t782').completed_by).toBe('Marco');
    expect(ticket('st1').status).toBe('open');   // one of two done: the ticket does not move
  });

  test('THE TICKET FOLLOWS: the last subtask done moves it to work_complete; an undo moves it back', async () => {
    const W = load();
    photo('c1', 't782', []);
    photo('c2', 't784', ['completion']);
    const first = await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    expect(first.movedTo).toBeNull();                 // work still outstanding — nothing to announce
    const last = await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: true, actor: ACTOR });
    expect([last.ticketStatus, last.movedTo]).toEqual(['work_complete', 'work_complete']);
    // Done again on a ticket already awaiting approval: it did not move, so the
    // routes have no arrival to announce.
    const repeat = await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: true, actor: ACTOR });
    expect([repeat.ticketStatus, repeat.movedTo]).toEqual(['work_complete', null]);
    expect(ticket('st1').status).toBe('work_complete');
    expect(events().slice(-1)[0].kind).toBe('status_changed');

    const undo = await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: false, actor: ACTOR });
    expect([undo.ok, task('t784').status, task('t784').completed_at, ticket('st1').status]).toEqual([true, 'open', null, 'in_progress']);
    const act = await W.subtaskActivity(eng.pool, 1, 'st1');
    expect(act.get('t784').completed_by).toBeNull();
  });

  test('the OFFICE unticking a building clears the approval-notice stamp; the crew undoing its own tick keeps it', async () => {
    const W = load();
    photo('c1', 't782', ['completion']);
    photo('c2', 't784', ['completion']);
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: true, actor: ACTOR });
    const stamp = () => ticket('st1').approval_notified_at;

    eng.db.exec("UPDATE service_tickets SET approval_notified_at = datetime('now') WHERE id = 'st1'");
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: false, actor: ACTOR });
    expect([ticket('st1').status, stamp()]).toEqual(['in_progress', expect.any(String)]);

    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: true, actor: ACTOR });
    eng.db.exec("UPDATE service_tickets SET approval_notified_at = datetime('now') WHERE id = 'st1'");
    const office = { kind: 'user', userId: 10, label: 'Jason Salinas' };
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: false, actor: office });
    expect([ticket('st1').status, stamp()]).toEqual(['in_progress', null]);
  });

  test('an office untick clears the stamp even when the ticket is already In progress from a crew undo', async () => {
    const W = load();
    photo('c1', 't782', ['completion']);
    photo('c2', 't784', ['completion']);
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: true, actor: ACTOR });
    eng.db.exec("UPDATE service_tickets SET approval_notified_at = datetime('now') WHERE id = 'st1'");
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: false, actor: ACTOR });  // crew undo
    expect(ticket('st1').approval_notified_at).not.toBeNull();
    const office = { kind: 'user', userId: 10, label: 'Jason Salinas' };
    const r = await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: false, actor: office });
    expect([r.movedTo, ticket('st1').status, ticket('st1').approval_notified_at]).toEqual([null, 'in_progress', null]);
  });

  test('the private to-do is not a subtask, so it does not hold the ticket open', async () => {
    photo('c1', 't782', []);
    photo('c2', 't784', []);
    const W = load();
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: true, actor: ACTOR });
    expect(ticket('st1').status).toBe('work_complete');
  });

  test.each([
    ['a task on another ticket', 'tother'],
    ['a private to-do', 'tpriv'],
    ['an absent id', 'nope'],
  ])('%s is not a subtask of this ticket — 404, nothing written', async (_label, id) => {
    photo('c9', id, []);
    const r = await load().setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: id, done: true, actor: ACTOR });
    expect([r.ok, r.status]).toEqual([false, 404]);
    expect(events()).toEqual([]);
  });

  test('an approved ticket is never moved by its subtasks', async () => {
    eng.db.exec("UPDATE service_tickets SET status = 'approved' WHERE id = 'st1'");
    photo('c1', 't782', []);
    photo('c2', 't784', []);
    const W = load();
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: true, actor: ACTOR });
    expect(ticket('st1').status).toBe('approved');
  });

  test('a note is attributed and listed under its subtask', async () => {
    const W = load();
    expect((await W.addSubtaskNote(eng.pool, { ticket: ticket('st1'), taskId: 't782', note: '  ', actor: ACTOR })).status).toBe(400);
    await W.addSubtaskNote(eng.pool, { ticket: ticket('st1'), taskId: 't782', note: 'Post was rotted at the base', actor: ACTOR });
    const act = await W.subtaskActivity(eng.pool, 1, 'st1');
    expect(act.get('t782').notes.map((n) => [n.note, n.by])).toEqual([['Post was rotted at the base', 'Marco']]);
  });
});

describe('MUTANTS', () => {
  test('without the photo check, a subtask is completed with no proof', async () => {
    const W = mutant('    if (!verdict.ok) return { ok: false, status: 409, error: verdict.reason };\n', '');
    const r = await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    expect(r.ok).toBe(true);
    expect(task('t782').status).toBe('done');
  });

  test('without the ticket predicate, a task on ANOTHER ticket can be completed through this one', async () => {
    photo('c9', 'tother', []);
    const W = mutant('      WHERE id = $1 AND service_ticket_id = $2 AND organization_id = $3\n        AND archived_at IS NULL AND scope = \'org\'',
      '      WHERE id = $1 AND ($2 = $2) AND organization_id = $3\n        AND archived_at IS NULL AND scope = \'org\'');
    const r = await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 'tother', done: true, actor: ACTOR });
    expect(r.status).not.toBe(404);
  });

  test('without the auto-move, finishing every subtask leaves the ticket open', async () => {
    const W = mutant("  const next = svc.autoStatusForSubtasks(ticket.status, allDone);\n", '  const next = null;\n');
    photo('c1', 't782', []);
    photo('c2', 't784', []);
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: true, actor: ACTOR });
    expect(ticket('st1').status).toBe('open');
  });
});
