'use strict';

// 2026-09-21: EVERY WRITE 86 DRAFTED FOR THE FAIRWAYS EMAILS FAILED, AND IT
// TOLD JOHN THEY WERE WAITING ON HIM.
//
//   1. Five tasks, assigned to John. The Scribe was handed a NAME and an email
//      (read_users printed everything about a user except the id an
//      assignment needs), wrote them where assignee_user_id goes, and the
//      dispatcher refused the batch.
//   2. One work order with six buildings. 86's own baseline told it to give
//      "each child task (title, due date, assignee)" — the one shape the
//      dispatcher refuses for a building — and the whole ticket was refused.
//   3. Asked where things stood, 86 checked John's to-dos, found none, and
//      said the approval card was "still sitting unactioned". The refusal
//      notices had been posted to the thread, which a managed session never
//      sees, and no turn-context block carried a Scribe refusal or a pending
//      draft.
//
// Each describe below holds one of those shut by RUNNING the code: the
// directory read, the dispatcher's refusals, and the turn context built from
// real payloads rows. The last one holds the instructions and the dispatcher
// to the same rule, so they cannot drift apart again.

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = ['organizations', 'roles', 'users', 'payloads', 'agent_jobs', 'context_load_events'];
const engine = createPgSqlite(sqliteSchema(TABLES, {
  pk: { organizations: 'id', roles: 'name', users: 'id', payloads: 'id', agent_jobs: 'id' },
}), {
  jsonColumns: ['capabilities', 'targets', 'file_content', 'settings', 'apply_error_detail', 'item_meta'],
  dateColumns: ['created_at', 'applied_at', 'updated_at', 'last_seen_at'],
});
globalThis.__P86_ASSIGNEE_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_ASSIGNEE_ENGINE__.pool }));

const I = require('../server/routes/ai-routes').internals;
const dispatcher = require('../server/services/payload-dispatcher');
const writeOutcomes = require('../server/services/write-outcomes');
const { AGENT_SYSTEM_BASELINE: B } = require('../server/routes/admin-agents-routes');
const { setRolePool, refreshRoleCache } = require('../server/auth');

const ADMIN = { id: 2, role: 'admin', organization_id: 1 };
const CTX = { userId: 2, orgId: 1, user: ADMIN };

const agoIso = (min) => new Date(Date.now() - min * 60000).toISOString();

beforeAll(async () => {
  engine.db.exec(`
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AG Exteriors'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES ('admin', 'Admin', '["ROLES_MANAGE","JOBS_VIEW_ALL","ESTIMATES_VIEW","LEADS_VIEW"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (2, 'admin@project86.net', 'x', 'John Thilking', 'admin', 1, 1),
      (255, 'john@agxco.com', 'x', 'John Thilking', 'admin', 1, 1),
      (15, 'calvin@agxco.com', 'x', 'Calvin Hamler', 'admin', 1, 1),
      (40, 'other@other.test', 'x', 'Oscar Other', 'admin', 2, 1);
  `);
  setRolePool(engine.pool);
  await refreshRoleCache();
});
afterAll(() => engine.close());

// ══════════════════════════════════════════════════════════════════════════
describe('1. the directory an agent assigns from prints the id', () => {
  const lookup = async (q) => String(await I.execAgentTool('search_entities', { entity_type: 'user', q }, CTX));

  test('every row carries user #N, the number an assignment needs', async () => {
    const out = await lookup('calvin');
    expect(out).toMatch(/Calvin Hamler \(calvin@agxco\.com\) · user #15 · role=admin/);
  });

  test('a shared name is SAID, with both ids and emails, so the agent asks instead of picking', async () => {
    const out = await lookup('john');
    expect(out).toMatch(/John Thilking \(admin@project86\.net\) · user #2/);
    expect(out).toMatch(/John Thilking \(john@agxco\.com\) · user #255/);
    expect(out).toMatch(/2 users share the name "John Thilking" \(user #2 admin@project86\.net, user #255 john@agxco\.com\)\. Ask which one/);
  });

  test('a unique name carries no warning', async () => {
    expect(await lookup('calvin')).not.toMatch(/share the name/);
  });

  test('another tenant\'s staff are still not listed', async () => {
    expect(await lookup('oscar')).toMatch(/No users match/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('2. the dispatcher refuses the two shapes, and says what to do instead', () => {
  const task = (assignee) => ({ entity_type: 'task', ops: { op: 'create', fields: { title: 'Paint the column', assignee_user_id: assignee } } });
  const refusalOf = (t) => { try { dispatcher.validateTarget(t, 0); return null; } catch (e) { return e; } };

  test('a NAME where the task\'s user id goes: refused, with the way out and structured detail', () => {
    const e = refusalOf(task('John Thilking (admin@project86.net)'));
    expect(e).toBeInstanceOf(dispatcher.PayloadValidationError);
    expect(e.message).toMatch(/must be a numeric user id/);
    expect(e.message).toMatch(/search_entities entity_type "user"/);
    expect(e.message).toMatch(/Leave it out to assign the task to the approving user/);
    expect(e.detail).toMatchObject({ code: 'wrong_type', field_path: 'task.ops.fields.assignee_user_id', received: 'John Thilking (admin@project86.net)' });
    expect(e.detail.suggestion).toMatch(/user #N/);
  });

  test('an email, zero and a negative are refused too; a number or a numeric string is accepted', () => {
    expect(refusalOf(task('admin@project86.net'))).not.toBeNull();
    expect(refusalOf(task('0'))).not.toBeNull();
    expect(refusalOf(task(-3))).not.toBeNull();
    expect(refusalOf(task(2))).toBeNull();
    expect(refusalOf(task('255'))).toBeNull();
  });

  test('an assignee on a work order BUILDING: refused, naming the one field the person belongs on', () => {
    const e = refusalOf({ entity_type: 'service_ticket', ops: { op: 'create',
      fields: { title: 'Fairways punch list', job_id: 'RV2008' },
      task_adds: [{ title: '4222 FC — patio column', assignee_user_id: 2 }] } });
    expect(e).toBeInstanceOf(dispatcher.PayloadValidationError);
    expect(e.detail.code).toBe('building_not_assignable');
    expect(e.message).toMatch(/service_ticket\.ops\.fields\.assignee_user_id, set once/);
    expect(e.detail.suggestion).toMatch(/service_ticket\.ops\.fields\.assignee_user_id once/);
  });

  test('the same person on the WORK ORDER is fine', () => {
    expect(refusalOf({ entity_type: 'service_ticket', ops: { op: 'create',
      fields: { title: 'Fairways punch list', job_id: 'RV2008', assignee_user_id: 2 },
      task_adds: [{ title: '4222 FC — patio column' }] } })).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('3. the agent reads what became of each write, every turn', () => {
  const insert = engine.db.prepare(
    'INSERT INTO payloads (id, organization_id, user_id, source, filename, file_content, targets, title, summary, status, apply_error, apply_summary, created_at, applied_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const row = (id, o) => insert.run(id, o.org == null ? 1 : o.org, o.user == null ? 2 : o.user, 'scribe', id + '.json', '{}',
    JSON.stringify(o.targets || [{ entity_type: 'task' }]), o.title, o.title, o.status, o.error || null, o.applied || null,
    agoIso(o.min), o.status === 'applied' ? agoIso(o.min - 1) : null);

  beforeAll(() => {
    // The Fairways day, as the payloads table recorded it.
    row('p-refused', { title: "Couldn't draft: Create 5 punch-list tasks for Fairways", status: 'failed', targets: [], min: 140,
      error: 'Invalid task target: task.fields.assignee_user_id must be a numeric user id (validated in-org at apply time).' });
    row('p-waiting', { title: 'Add 3 tasks to RV2008', status: 'ready', min: 5 });
    row('p-applied', { title: 'Set the gate code on Oak Hollow', status: 'applied', min: 60, applied: 'Updated 1 client: gate code.' });
    row('p-rejected', { title: 'Close PO 1043', status: 'rejected', min: 90 });
    row('p-failed', { title: 'Move phase 5 budget', status: 'failed', targets: [{ entity_type: 'job' }], min: 30, error: 'phase 5 no longer exists' });
    // Not this turn's business:
    row('p-old', { title: 'Yesterday morning', status: 'failed', targets: [], min: 30 * 60, error: 'old' });
    row('p-colleague', { title: "Calvin's change", status: 'ready', user: 15, min: 3 });
    row('p-other-tenant', { title: 'Another company', status: 'ready', org: 2, min: 2 });
  });

  let text = '';
  beforeAll(async () => {
    const out = await I.buildTurnContext({ entityType: null, entityId: null, userId: 2, organization: { id: 1, name: 'AG Exteriors' } });
    text = out.turnContextText;
  });
  const block = () => {
    const m = text.match(/<recent_writes>[\s\S]*?<\/recent_writes>/);
    return m ? m[0] : '';
  };

  test('a Scribe REFUSAL reaches the agent — hours later, with its reason — as nothing saved', () => {
    expect(block()).toMatch(/REFUSED — "Couldn't draft: Create 5 punch-list tasks for Fairways" \(\d+ hours? ago\) — nothing was saved: Invalid task target: task\.fields\.assignee_user_id must be a numeric user id/);
  });

  test('a draft whose card is still up is WAITING FOR APPROVAL, not "maybe it failed"', () => {
    expect(block()).toMatch(/WAITING FOR APPROVAL — "Add 3 tasks to RV2008" \(5 min ago\)/);
  });

  test('applied, rejected and failed-on-apply each say so', () => {
    expect(block()).toMatch(/APPLIED — "Set the gate code on Oak Hollow" \(1 hour ago\) — Updated 1 client: gate code\./);
    expect(block()).toMatch(/REJECTED — "Close PO 1043"/);
    expect(block()).toMatch(/FAILED — "Move phase 5 budget" \(30 min ago\) — it did not apply: phase 5 no longer exists/);
  });

  test('newest first; the agent is told to answer from the list, never from an absence', () => {
    const b = block();
    expect(b.indexOf('Add 3 tasks')).toBeLessThan(b.indexOf('Move phase 5'));
    expect(b.indexOf('Move phase 5')).toBeLessThan(b.indexOf('Set the gate code'));
    expect(b.indexOf('Set the gate code')).toBeLessThan(b.indexOf('Close PO 1043'));
    expect(b.indexOf('Close PO 1043')).toBeLessThan(b.indexOf("Couldn't draft"));
    expect(b).toMatch(/never from records being missing/);
  });

  test('older than a day, a colleague\'s, and another tenant\'s are not in it', () => {
    expect(block()).not.toMatch(/Yesterday morning|Calvin's change|Another company/);
  });

  test('the formatter maps every status, and a stored targets STRING is read', () => {
    expect(writeOutcomes.outcomeOf({ status: 'failed', targets: '[]' })).toBe('REFUSED');
    expect(writeOutcomes.outcomeOf({ status: 'failed', targets: '[{"entity_type":"job"}]' })).toBe('FAILED');
    expect(writeOutcomes.outcomeOf({ status: 'applying' })).toBe('APPLYING');
    expect(writeOutcomes.recentWritesBlock([], Date.now())).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('4. the instructions and the dispatcher say the same thing', () => {
  test('86 is no longer told to give a work order\'s child tasks an assignee', () => {
    expect(B.job).not.toMatch(/each child task \(title, due date, assignee\)/);
    expect(B.job).toMatch(/each child task — a building on its punch list — with its title, due date and notes ONLY/);
    expect(B.job).toMatch(/Never give a child task an assignee/);
  });

  test('both chat agents are told an assignee is a numeric id, to ask on a shared name, and to answer from <recent_writes>', () => {
    for (const k of ['job', 'assistant']) {
      expect([k, /NUMERIC user id/.test(B[k])]).toEqual([k, true]);
      expect([k, /every row shows `user #N`/.test(B[k])]).toEqual([k, true]);
      expect([k, /ASK which one, showing their emails; never pick one yourself/.test(B[k])]).toEqual([k, true]);
      expect([k, /<recent_writes> in your turn context/.test(B[k])]).toEqual([k, true]);
      expect([k, /Never infer an outcome from records being missing/.test(B[k])]).toEqual([k, true]);
    }
  });

  test('the Scribe writes a number, never a name, and lifts one shared assignee onto the work order', () => {
    expect(B.scribe).toMatch(/NEVER put a name or an email there/);
    expect(B.scribe).toMatch(/return one line saying which person's user id is missing/);
    expect(B.scribe).toMatch(/SAME person on all of them, that person IS the work order's assignee: put them on `fields\.assignee_user_id` once/);
    expect(B.scribe).toMatch(/DIFFERENT people to different child tasks, do not draft/);
  });

  test('the field the instructions send the person to is the field the dispatcher accepts', () => {
    // Taught: "put them on fields.assignee_user_id". Accepted: exactly that.
    expect(() => dispatcher.validateTarget({ entity_type: 'service_ticket',
      ops: { op: 'update', fields: { assignee_user_id: 2 } }, entity_id: 'st_1' }, 0)).not.toThrow();
  });
});
