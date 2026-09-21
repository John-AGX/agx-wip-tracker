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
  // EVERY relative require is pointed back at the shipped module, not only
  // ./service-tickets: a copy in the OS temp dir resolves './x' against the
  // temp dir, and a require added to the file later (Phase 3 added one, inside
  // a function) would otherwise make the mutant throw instead of mutate.
  const dir = path.join(__dirname, '..', 'server', 'services');
  const out = src.replace(f, replace.split('\n').join(eol))
    .replace(/require\((['"])(\.[^'"]+)\1\)/g, (_m, _q, spec) =>
      'require(' + JSON.stringify(require.resolve(path.resolve(dir, spec)).split(path.sep).join('/')) + ')');
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

  // 86 is the office too. No caller hands setSubtaskDone an agent actor today —
  // the dispatcher only reaches recountTicket — but the two doors clear the
  // notice stamp for the same reason and must not drift apart when one does.
  async function untickAfterCrewUndo(W, actor) {
    photo('c1', 't782', ['completion']);
    photo('c2', 't784', ['completion']);
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: true, actor: ACTOR });
    eng.db.exec("UPDATE service_tickets SET approval_notified_at = datetime('now') WHERE id = 'st1'");
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: false, actor: ACTOR });  // crew undo
    return W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: false, actor: actor });
  }

  test('an agent untick clears the stamp on a ticket the recount does not move', async () => {
    const r = await untickAfterCrewUndo(load(), AGENT);
    expect([r.movedTo, ticket('st1').status, ticket('st1').approval_notified_at]).toEqual([null, 'in_progress', null]);
  });

  test('MUTANT: with only \'user\' on the untick allow-list, 86\'s untick leaves the stamp standing', async () => {
    const W = mutant("  if (!done && wasDone && opts.actor && (opts.actor.kind === 'user' || opts.actor.kind === 'agent')) {\n",
      "  if (!done && wasDone && opts.actor && opts.actor.kind === 'user') {\n");
    await untickAfterCrewUndo(W, AGENT);
    expect(ticket('st1').approval_notified_at).not.toBeNull();
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
    const W = mutant("    if (!verdict.ok) return { ok: false, status: 409, error: verdict.reason, code: 'completion_photo_required' };\n", '');
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
    const W = mutant("  let next = svc.autoStatusForSubtasks(ticket.status, allDone);\n", '  let next = null;\n');
    photo('c1', 't782', []);
    photo('c2', 't784', []);
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't784', done: true, actor: ACTOR });
    expect(ticket('st1').status).toBe('open');
  });
});

// ── 1.29: the lock, the gate, the guarded tick, the recount, strict events ──
// Every door that changes a punch list now decides on the ticket row as it is
// under FOR UPDATE, not on the copy a request loaded. pg-sqlite strips FOR
// UPDATE, so a race is modelled the only honest way it can be here: the
// caller's object is stale, or a pool wrapper writes the other side of the
// race right before the statement that would lose it.
const OFFICE = { kind: 'user', userId: 10, label: 'Jason Salinas' };
// 86's actor, as services/payload-dispatcher.js builds it for a task_add: the
// office asking through the assistant rather than through the REST door.
const AGENT = { kind: 'agent', userId: 10, label: null };
const kinds = () => events().map((e) => e.kind);
const detailOf = (e) => (typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail);

// A pool whose client runs `hook(sql)` before each statement. The hook may
// write straight to sqlite (the other side of a race) or throw.
function hookedPool(hook) {
  return {
    query: (sql, params) => eng.pool.query(sql, params),
    connect: async () => {
      const inner = await eng.pool.connect();
      return {
        query: async (sql, params) => { await hook(String(sql)); return inner.query(sql, params); },
        release: () => inner.release(),
      };
    },
  };
}

const crewGate = (locked) => {
  const svc = require('../server/services/service-tickets');
  const v = svc.crewSubtasksWritable(locked.status);
  return v.ok ? { ok: true } : { ok: false, status: 409, error: v.reason, code: 'work_order_locked' };
};

describe('withTicketLock', () => {
  test('a ticket object from another org finds no row: 404, and the work never runs', async () => {
    let ran = false;
    const r = await load().withTicketLock(eng.pool, Object.assign({}, ticket('st1'), { organization_id: 2 }),
      async () => { ran = true; return { ok: true }; });
    expect(r).toEqual({ ok: false, status: 404, error: 'This work order is no longer available.' });
    expect(ran).toBe(false);
    const lockRead = eng.log.filter((e) => /FROM service_tickets WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/.test(e.sql)).pop();
    expect(lockRead.params).toEqual(['st1', 2]);
  });

  test('ok:false rolls back what the work wrote; a normal answer commits it', async () => {
    const W = load();
    await W.withTicketLock(eng.pool, ticket('st1'), async (c) => {
      await c.query("UPDATE tasks SET status = 'done' WHERE id = 't782' AND organization_id = 1");
      return { ok: false, status: 409, error: 'no' };
    });
    expect(task('t782').status).toBe('open');
    await W.withTicketLock(eng.pool, ticket('st1'), async (c) => {
      await c.query("UPDATE tasks SET status = 'done' WHERE id = 't782' AND organization_id = 1");
      return { ok: true };
    });
    expect(task('t782').status).toBe('done');
  });

  test('a throw rolls back and is rethrown', async () => {
    await expect(load().withTicketLock(eng.pool, ticket('st1'), async (c) => {
      await c.query("UPDATE tasks SET status = 'done' WHERE id = 't782' AND organization_id = 1");
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(task('t782').status).toBe('open');
  });

  test('a client already in a transaction gets no BEGIN of its own; a query-only db runs the work directly', async () => {
    const W = load();
    const client = await eng.pool.connect();
    const t0 = eng.log.length;
    const r = await W.withTicketLock(client, ticket('st1'), async (c, locked) => ({ ok: true, status: locked.status }));
    expect(r).toEqual({ ok: true, status: 'open' });
    expect(eng.log.slice(t0).some((e) => /^(BEGIN|COMMIT|ROLLBACK)/.test(e.sql))).toBe(false);
    const bare = { query: (s, p) => eng.pool.query(s, p) };
    const r2 = await W.withTicketLock(bare, ticket('st1'), async (c, locked) => ({ ok: true, id: locked.id }));
    expect(r2).toEqual({ ok: true, id: 'st1' });
  });
});

describe('setSubtaskDone decides on the LOCKED row', () => {
  test('a stale object says open while the row is approved: the crew gate refuses 409 work_order_locked, nothing written', async () => {
    const stale = ticket('st1');
    eng.db.exec("UPDATE service_tickets SET status = 'approved' WHERE id = 'st1'");
    photo('c1', 't782', ['completion']);
    const r = await load().setSubtaskDone(eng.pool, { ticket: stale, taskId: 't782', done: true, actor: ACTOR, gate: crewGate });
    expect([r.ok, r.status, r.code]).toEqual([false, 409, 'work_order_locked']);
    expect(r.error).toMatch(/approved/);
    expect(task('t782').status).toBe('open');
    expect(events()).toEqual([]);
  });

  test('no gate, a stale in_progress object, the row cancelled: finishing every building never moves the cancelled ticket', async () => {
    eng.db.exec("UPDATE service_tickets SET status = 'in_progress' WHERE id = 'st1'");
    const stale = ticket('st1');
    eng.db.exec("UPDATE service_tickets SET status = 'cancelled' WHERE id = 'st1'");
    photo('c1', 't782', []);
    photo('c2', 't784', []);
    const W = load();
    await W.setSubtaskDone(eng.pool, { ticket: stale, taskId: 't782', done: true, actor: ACTOR });
    const last = await W.setSubtaskDone(eng.pool, { ticket: stale, taskId: 't784', done: true, actor: ACTOR });
    expect([last.ticketStatus, last.movedTo, last.ticket.status]).toEqual(['cancelled', null, 'cancelled']);
    expect(ticket('st1').status).toBe('cancelled');
    expect(kinds()).not.toContain('status_changed');
  });

  test('the photo refusal carries code completion_photo_required', async () => {
    const r = await load().setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    expect([r.status, r.code]).toEqual([409, 'completion_photo_required']);
  });

  test('result.ticket is the locked row with the status after the recount', async () => {
    photo('c1', 't782', []);
    photo('c2', 't784', []);
    const W = load();
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    const stale = Object.assign({}, ticket('st1'), { title: 'stale title' });
    const r = await W.setSubtaskDone(eng.pool, { ticket: stale, taskId: 't784', done: true, actor: ACTOR });
    expect([r.ticket.id, r.ticket.title, r.ticket.status, r.movedTo]).toEqual(['st1', 'Latitude 28 punch list', 'work_complete', 'work_complete']);
  });

  test('double tap: the second tap finds the building done and writes no second event', async () => {
    photo('c1', 't782', ['completion']);
    const W = load();
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    await W.setSubtaskDone(eng.pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    expect(kinds().filter((k) => k === 'subtask_completed')).toHaveLength(1);
  });

  test('the other tap lands between the read and the UPDATE: the guarded UPDATE matches nothing, so one event in all', async () => {
    photo('c1', 't782', ['completion']);
    let fired = false;
    const pool = hookedPool((sql) => {
      if (!fired && /^\s*UPDATE tasks/.test(sql)) {
        fired = true;
        eng.db.exec("UPDATE tasks SET status = 'done', completed_at = '2026-09-15 10:00:00' WHERE id = 't782'");
        eng.db.exec("INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_label, detail) VALUES ('ste_other', 1, 'st1', 'subtask_completed', 'share', 'Other tap', '{\"task_id\":\"t782\"}')");
      }
    });
    const r = await load().setSubtaskDone(pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    expect(fired).toBe(true);
    expect(r.ok).toBe(true);
    expect(kinds().filter((k) => k === 'subtask_completed')).toHaveLength(1);
    expect(task('t782').completed_at).toBe('2026-09-15 10:00:00');
  });

  test('STRICT: an event insert that fails throws, and the transaction takes the tick back', async () => {
    photo('c1', 't782', ['completion']);
    const pool = hookedPool((sql) => {
      if (/INSERT INTO service_ticket_events/.test(sql)) throw new Error('events table unavailable');
    });
    await expect(load().setSubtaskDone(pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR }))
      .rejects.toThrow('events table unavailable');
    expect(task('t782').status).toBe('open');
    expect(events()).toEqual([]);
  });
});

describe('recountTicket', () => {
  function workComplete() {
    eng.db.exec(`
      UPDATE tasks SET status = 'done' WHERE id IN ('t782', 't784');
      UPDATE service_tickets SET status = 'work_complete', approval_notified_at = '2026-09-15 09:00:00' WHERE id = 'st1';
    `);
  }

  test('an open building added to a work_complete ticket sends it back to in_progress (subtask_added), and the office clears the notice stamp', async () => {
    workComplete();
    eng.db.exec("INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id) VALUES ('t786', 1, 'Bldg 786', 'open', 'org', 'st1')");
    const r = await load().recountTicket(eng.pool, ticket('st1'), OFFICE, 'subtask_added');
    expect(r).toEqual({ ticketStatus: 'in_progress', movedTo: 'in_progress' });
    expect(ticket('st1').status).toBe('in_progress');
    expect(ticket('st1').completed_at).toBeNull();
    expect(ticket('st1').approval_notified_at).toBeNull();
    const ev = events().pop();
    expect([ev.kind, detailOf(ev)]).toEqual(['status_changed', { from: 'work_complete', to: 'in_progress', reason: 'subtask_added' }]);
  });

  test('the same move by a crew link keeps the notice stamp', async () => {
    workComplete();
    eng.db.exec("INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id) VALUES ('t786', 1, 'Bldg 786', 'open', 'org', 'st1')");
    await load().recountTicket(eng.pool, ticket('st1'), ACTOR, 'subtask_added');
    expect([ticket('st1').status, ticket('st1').approval_notified_at]).toEqual(['in_progress', '2026-09-15 09:00:00']);
  });

  function addBuilding() {
    workComplete();
    eng.db.exec("INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id) VALUES ('t786', 1, 'Bldg 786', 'open', 'org', 'st1')");
  }

  test('86 adding a building clears the stamp too: the agent actor is the office it acts for', async () => {
    // payload-dispatcher.js hands THIS recount { kind: 'agent', userId } for a
    // task_add, where every REST door hands { kind: 'user' }. Left off the
    // allow-list the stale stamp stood, the notice claim answered
    // 'already_notified' inside its 15-minute window, the cron's retry only
    // looks at approval_notified_at IS NULL, and the batched crew-activity
    // notice suppresses a work_complete ticket's rows — so the crew's second
    // arrival at Work complete reached nobody, ever.
    addBuilding();
    const r = await load().recountTicket(eng.pool, ticket('st1'), AGENT, 'subtask_added');
    expect(r).toEqual({ ticketStatus: 'in_progress', movedTo: 'in_progress' });
    expect(ticket('st1').approval_notified_at).toBeNull();
  });

  test('the notice cron is not the office: a system actor leaves the stamp alone', async () => {
    // Why the allow-list is explicit rather than `actor.kind !== 'share'`.
    addBuilding();
    await load().recountTicket(eng.pool, ticket('st1'), { kind: 'system' }, 'subtask_added');
    expect([ticket('st1').status, ticket('st1').approval_notified_at]).toEqual(['in_progress', '2026-09-15 09:00:00']);
  });

  test('MUTANT: with only \'user\' on the allow-list, 86\'s added building leaves the stamp standing', async () => {
    addBuilding();
    const W = mutant("      if (actor && (actor.kind === 'user' || actor.kind === 'agent') && movedTo === 'in_progress') {\n",
      "      if (actor && actor.kind === 'user' && movedTo === 'in_progress') {\n");
    const r = await W.recountTicket(eng.pool, ticket('st1'), AGENT, 'subtask_added');
    expect(r.movedTo).toBe('in_progress');
    expect(ticket('st1').approval_notified_at).toBe('2026-09-15 09:00:00');
  });

  test('archiving the last open building finishes the ticket, with movedTo and reason all_subtasks_done', async () => {
    eng.db.exec("UPDATE tasks SET status = 'done' WHERE id = 't782'; UPDATE tasks SET archived_at = '2026-09-15 10:00:00' WHERE id = 't784'; UPDATE service_tickets SET status = 'in_progress' WHERE id = 'st1';");
    const r = await load().recountTicket(eng.pool, ticket('st1'), OFFICE, 'subtask_removed');
    expect(r).toEqual({ ticketStatus: 'work_complete', movedTo: 'work_complete' });
    expect(detailOf(events().pop()).reason).toBe('all_subtasks_done');
  });

  test('the last building removed from a work_complete ticket: back to in_progress with reason subtask_removed', async () => {
    workComplete();
    eng.db.exec("UPDATE tasks SET archived_at = '2026-09-15 10:00:00' WHERE id IN ('t782', 't784')");
    const r = await load().recountTicket(eng.pool, ticket('st1'), OFFICE, 'subtask_removed');
    expect(r.movedTo).toBe('in_progress');
    expect(detailOf(events().pop()).reason).toBe('subtask_removed');
  });

  test('nothing to move: no UPDATE, no event', async () => {
    const t0 = eng.log.length;
    const r = await load().recountTicket(eng.pool, ticket('st1'), OFFICE, 'subtask_added');
    expect(r).toEqual({ ticketStatus: 'open', movedTo: null });
    expect(eng.log.slice(t0).some((e) => /^UPDATE service_tickets/.test(e.sql))).toBe(false);
    expect(events()).toEqual([]);
  });

  test('the guarded UPDATE loses to a row that already moved: no event, no movedTo', async () => {
    eng.db.exec("UPDATE tasks SET status = 'done' WHERE id IN ('t782', 't784')");
    const stale = ticket('st1');
    eng.db.exec("UPDATE service_tickets SET status = 'cancelled' WHERE id = 'st1'");
    const r = await load().recountTicket(eng.pool, stale, OFFICE, null);
    expect(r).toEqual({ ticketStatus: 'open', movedTo: null });
    expect(ticket('st1').status).toBe('cancelled');
    expect(events()).toEqual([]);
  });
});

describe('MUTANTS — 1.29', () => {
  test('drop the gate call and the approved ticket\'s building is reopened from a stale object', async () => {
    eng.db.exec("UPDATE tasks SET status = 'done' WHERE id = 't782'");
    const stale = ticket('st1');
    eng.db.exec("UPDATE service_tickets SET status = 'approved' WHERE id = 'st1'");
    const W = mutant('    const g = await opts.gate(ticket);\n', '    const g = { ok: true };\n');
    const r = await W.setSubtaskDone(eng.pool, { ticket: stale, taskId: 't782', done: false, actor: ACTOR, gate: crewGate });
    expect(r.ok).toBe(true);
    expect(task('t782').status).toBe('open');
    // …and the shipped module refuses the same call.
    eng.db.exec("UPDATE tasks SET status = 'done' WHERE id = 't782'");
    const real = await load().setSubtaskDone(eng.pool, { ticket: stale, taskId: 't782', done: false, actor: ACTOR, gate: crewGate });
    expect([real.ok, real.code, task('t782').status]).toEqual([false, 'work_order_locked', 'done']);
  });

  test('decide on opts.ticket instead of the locked row and the gate waves a stale open object through on an approved ticket', async () => {
    const stale = ticket('st1');
    eng.db.exec("UPDATE service_tickets SET status = 'approved' WHERE id = 'st1'");
    photo('c1', 't782', ['completion']);
    const W = mutant('    return applySubtaskDone(client, locked, opts);\n', '    return applySubtaskDone(client, opts.ticket, opts);\n');
    const r = await W.setSubtaskDone(eng.pool, { ticket: stale, taskId: 't782', done: true, actor: ACTOR, gate: crewGate });
    expect(r.ok).toBe(true);
    expect(task('t782').status).toBe('done');
  });

  test('make the event insert non-strict and a failed timeline row leaves the building done with no event', async () => {
    photo('c1', 't782', ['completion']);
    const pool = hookedPool((sql) => {
      if (/INSERT INTO service_ticket_events/.test(sql)) throw new Error('events table unavailable');
    });
    const W = mutant("        { task_id: task.id, title: String(task.title || '').slice(0, 200) }, { strict: true });\n",
      "        { task_id: task.id, title: String(task.title || '').slice(0, 200) });\n");
    const r = await W.setSubtaskDone(pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    expect(r.ok).toBe(true);
    expect(task('t782').status).toBe('done');
    expect(events()).toEqual([]);
  });

  test('drop the guard on the task UPDATE and the other tap\'s building gets a second completion event', async () => {
    photo('c1', 't782', ['completion']);
    let fired = false;
    const pool = hookedPool((sql) => {
      if (!fired && /^\s*UPDATE tasks/.test(sql)) {
        fired = true;
        eng.db.exec("UPDATE tasks SET status = 'done' WHERE id = 't782'");
        eng.db.exec("INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, detail) VALUES ('ste_other', 1, 'st1', 'subtask_completed', 'share', '{}')");
      }
    });
    const W = mutant("          AND ${done ? \"status <> 'done'\" : \"status = 'done'\"}\n", '');
    await W.setSubtaskDone(pool, { ticket: ticket('st1'), taskId: 't782', done: true, actor: ACTOR });
    expect(kinds().filter((k) => k === 'subtask_completed')).toHaveLength(2);
  });
});

// ── 1.30: A BUILDING NOTE IS WRITTEN ONCE, HOWEVER OFTEN IT IS SENT ─────────
// A crew phone on a dead spot sends the note, never sees the answer, and sends
// it again. Without a key the building's field log grows the same sentence
// twice and the crew cannot delete either copy. The page mints one client_ref
// per UNSENT note and repeats it on every retry, exactly as the site-photo,
// building-photo and flag doors already work.
describe('1.30: the building note carries a retry key', () => {
  const REF = 'note_ab12cd34';
  const LINK2 = { kind: 'share', shareId: 'sh2', label: 'Dana' };
  const NOTE = 'Post was rotted at the base';

  const notesOn = (ticketId, org) => eng.all(
    `SELECT share_id, actor_label, detail FROM service_ticket_events
      WHERE kind = 'subtask_note' AND ticket_id = ? AND organization_id = ? ORDER BY rowid`,
    ticketId, org == null ? 1 : org
  );
  const add = (W, opts) => W.addSubtaskNote(eng.pool, Object.assign(
    { ticket: ticket('st1'), taskId: 't782', note: NOTE, actor: ACTOR }, opts || {}
  ));
  // Another tenant's row under the SAME ticket id and the SAME key: only the
  // org predicate inside the lookup keeps it from silencing this note.
  const rivalNote = (ref) => eng.db.exec(
    "INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, share_id, actor_label, detail)" +
    " VALUES ('ste_rv', 2, 'st1', 'subtask_note', 'share', 'sh1', 'Ray', '{\"task_id\":\"t782\",\"note\":\"RIVAL\",\"client_ref\":\"" + ref + "\"}')"
  );

  test('the retry that repeats the key writes nothing and answers as if it landed', async () => {
    const W = load();
    expect(await add(W, { clientRef: REF })).toEqual({ ok: true });
    expect(await add(W, { clientRef: REF })).toEqual({ ok: true, duplicate: true });
    expect(notesOn('st1')).toHaveLength(1);
    expect(notesOn('st1')[0].detail).toEqual({ task_id: 't782', note: NOTE, client_ref: REF });
    // And the crew still sees exactly one line under the building.
    const act = await W.subtaskActivity(eng.pool, 1, 'st1');
    expect(act.get('t782').notes.map((n) => [n.note, n.by])).toEqual([[NOTE, 'Marco']]);
  });

  test('the key identifies the note, so a retry carrying edited words is still the same note', async () => {
    const W = load();
    await add(W, { clientRef: REF });
    expect(await add(W, { clientRef: REF, note: 'Post was rotted at the base — and the rail' }))
      .toEqual({ ok: true, duplicate: true });
    expect(notesOn('st1').map((e) => e.detail.note)).toEqual([NOTE]);
  });

  test('a different key is a different note, and no key at all always writes', async () => {
    const W = load();
    await add(W, { clientRef: REF });
    await add(W, { clientRef: 'note_zz998877' });
    expect(notesOn('st1')).toHaveLength(2);

    // An old cached page sends no key. It must never start silently dropping
    // the crew's notes — two sends are two notes, as they always were.
    await add(W, {});
    await add(W, {});
    expect(notesOn('st1')).toHaveLength(4);
    expect(notesOn('st1').slice(2).map((e) => e.detail)).toEqual([
      { task_id: 't782', note: NOTE }, { task_id: 't782', note: NOTE },
    ]);
  });

  test('a key that is not the agreed shape is ignored, never stored, and never dedupes', async () => {
    const W = load();
    for (const bad of ['short', 'has spaces here', 'a'.repeat(65), 42, null, { ref: REF }]) {
      await add(W, { clientRef: bad });
    }
    const rows = notesOn('st1');
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r.detail).toEqual({ task_id: 't782', note: NOTE });
  });

  test('the key is scoped: another link, another work order and another org all still write', async () => {
    const W = load();
    await add(W, { clientRef: REF });

    // Another link on the same building.
    expect(await add(W, { clientRef: REF, actor: LINK2 })).toEqual({ ok: true });
    // The same key on another work order of the same job.
    expect(await W.addSubtaskNote(eng.pool, {
      ticket: ticket('st2'), taskId: 'tother', note: NOTE, actor: ACTOR, clientRef: REF,
    })).toEqual({ ok: true });
    expect(notesOn('st1').map((e) => e.share_id)).toEqual(['sh1', 'sh2']);
    expect(notesOn('st2')).toHaveLength(1);

    // And a rival tenant's row under this ticket id never silences ours.
    seed();
    rivalNote(REF);
    expect(await add(W, { clientRef: REF })).toEqual({ ok: true });
    expect(notesOn('st1')).toHaveLength(1);
    expect(notesOn('st1', 2)).toHaveLength(1);
  });

  test('an empty note and an unknown building are refused before anything is keyed', async () => {
    const W = load();
    expect(await add(W, { note: '   ', clientRef: REF })).toEqual({ ok: false, status: 400, error: 'Write a note first.' });
    expect(await add(W, { taskId: 'tpriv', clientRef: REF }))
      .toEqual({ ok: false, status: 404, error: 'That subtask is not on this work order.' });
    expect(notesOn('st1')).toEqual([]);
    // The refusal stored no key, so the real note under it still lands.
    expect(await add(W, { clientRef: REF })).toEqual({ ok: true });
    expect(notesOn('st1')).toHaveLength(1);
  });

  describe('MUTANTS', () => {
    test('drop the lookup and the retry is two notes in the field log', async () => {
      const W = mutant('      if (seen.rows.length) return { ok: true, duplicate: true };\n', '');
      await add(W, { clientRef: REF });
      await add(W, { clientRef: REF });
      expect(notesOn('st1')).toHaveLength(2);
    });

    test('drop the key from the stored detail and the next retry has nothing to find', async () => {
      const W = mutant('    if (ref) detail.client_ref = ref;\n', '');
      await add(W, { clientRef: REF });
      await add(W, { clientRef: REF });
      expect(notesOn('st1')).toHaveLength(2);
    });

    test('drop organization_id from the lookup and another tenant\'s row silences the crew', async () => {
      rivalNote(REF);
      const W = mutant(
        '          WHERE ticket_id = $1 AND organization_id = $2\n            AND share_id IS NOT DISTINCT FROM $3\n',
        '          WHERE ticket_id = $1 AND $2 IS NOT NULL\n            AND share_id IS NOT DISTINCT FROM $3\n'
      );
      expect(await add(W, { clientRef: REF })).toEqual({ ok: true, duplicate: true });
      expect(notesOn('st1')).toEqual([]);
    });

    test('drop the link from the lookup and one crew\'s key swallows another crew\'s note', async () => {
      const W = mutant('            AND share_id IS NOT DISTINCT FROM $3\n', '            AND $3 IS NOT NULL\n');
      await add(W, { clientRef: REF });
      expect(await add(W, { clientRef: REF, actor: LINK2 })).toEqual({ ok: true, duplicate: true });
      expect(notesOn('st1')).toHaveLength(1);
    });

    test('make the note event non-strict and a failed timeline row answers ok with nothing written', async () => {
      const pool = hookedPool((sql) => {
        if (/INSERT INTO service_ticket_events/.test(sql)) throw new Error('events table unavailable');
      });
      const real = load();
      await expect(real.addSubtaskNote(pool, { ticket: ticket('st1'), taskId: 't782', note: NOTE, actor: ACTOR }))
        .rejects.toThrow('events table unavailable');
      expect(notesOn('st1')).toEqual([]);

      const W = mutant(
        "    await insertEvent(client, opts.ticket, 'subtask_note', opts.actor, detail, { strict: true });\n",
        "    await insertEvent(client, opts.ticket, 'subtask_note', opts.actor, detail);\n"
      );
      expect(await W.addSubtaskNote(pool, { ticket: ticket('st1'), taskId: 't782', note: NOTE, actor: ACTOR }))
        .toEqual({ ok: true });
      expect(notesOn('st1')).toEqual([]);
    });
  });
});
