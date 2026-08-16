// GET /api/task-share/:token — what an OUTSIDE WORKER is allowed to see.
//
// The reader here holds a link and nothing else: no account, no login, no
// org. Two things are pinned.
//
//   1. They can tell which job the task belongs to. The page used to show
//      the task title alone, so someone completing "Replace damaged siding
//      — building 3" had no way to know which site that was.
//
//   2. Learning the job teaches them NOTHING else. publicTask() is already
//      a deliberate whitelist; the label must sit beside it without
//      re-opening it. So the fake Postgres hands back the full `tasks` row
//      the route really SELECTs — organization_id, created_by, the
//      entity link, assignee — and the test asserts the guest payload is
//      exactly the intended keys. A field added to publicTask() or to the
//      envelope fails here rather than shipping to the public internet.

let mockQueries;
let mockFixture;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => {
      mockQueries.push({ sql: String(sql), params: params });
      const text = String(sql);
      if (/FROM organizations/i.test(text)) return { rows: [{ name: 'AGX Central Florida' }] };
      if (/FROM attachments/i.test(text)) return { rows: (mockFixture.photos || []).slice() };
      const byId = (list) => {
        const ids = (params && params[0]) || [];
        return { rows: (list || []).filter((r) => ids.indexOf(r.id) >= 0) };
      };
      if (/FROM jobs/i.test(text)) return byId(mockFixture.jobs);
      if (/FROM leads/i.test(text)) return byId(mockFixture.leads);
      if (/FROM clients/i.test(text)) return byId(mockFixture.clients);
      return { rows: [], rowCount: 0 };
    }
  }
}));

jest.mock('../server/auth', () => ({ requireAuth: (req, res, next) => next() }));
jest.mock('../server/email', () => ({ sendEmail: async () => ({ ok: true }), isEnabled: () => false }));
jest.mock('../server/storage', () => ({ storage: { put: async () => 'https://cdn/x' } }));

const router = require('../server/routes/task-share-routes');

// The complete guest payload. `linked_label` is the only addition.
const GUEST_ENVELOPE_KEYS = ['task', 'photos', 'share', 'org_name', 'linked_label', 'maps_key'].sort();
// publicTask()'s whitelist — unchanged by the label work, and it stays that
// way: entity_type / entity_id are still withheld, only the composed string
// ships.
const GUEST_TASK_KEYS = ['title', 'notes', 'kind', 'status', 'priority',
  'due_date', 'checklist', 'lat', 'lng', 'directions'].sort();

// The tasks row as `SELECT *` really returns it.
function taskRow(over) {
  return Object.assign({
    id: 'tsk_1',
    title: 'Replace damaged siding — building 3',
    notes: 'Match existing profile.',
    kind: 'punch',
    status: 'open',
    priority: 'high',
    due_date: '2026-08-20',
    checklist: [{ text: 'Pull the damaged course', done: false }],
    lat: 28.5383, lng: -81.3792,
    directions: 'Gate code 4412',
    entity_type: 'job',
    entity_id: 'j1',
    // ── internal, must not ship ──────────────────────────────────────
    organization_id: 7,
    created_by: 'usr_42',
    assigned_to: 'usr_9',
    scope_id: 'scp_3',
    archived_at: null,
    completed_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z'
  }, over || {});
}

function shareRow(over) {
  return Object.assign({
    id: 'tsh_1', task_id: 'tsk_1', token: 'a'.repeat(64),
    organization_id: 7, sub_id: 'sub_1',
    recipient_email: 'crew@example.com', recipient_name: 'Marco',
    expires_at: '2026-09-01T00:00:00Z', completed_at: null, revoked_at: null
  }, over || {});
}

function jobRow(id, num, label) { return { id: id, num: num, label: label }; }

// Skip loadShare (it is not what changed) and drive the handler with the
// rows it would have attached.
function getHandler() {
  const layer = router.stack.find((l) => l.route
    && l.route.path === '/task-share/:token'
    && l.route.methods && l.route.methods.get);
  if (!layer) throw new Error('GET /task-share/:token not found on the router');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}

async function get(task) {
  const res = fakeRes();
  await getHandler()({ share: shareRow(), task: task || taskRow() }, res);
  return res;
}

beforeEach(() => {
  mockQueries = [];
  mockFixture = { jobs: [], leads: [], clients: [], photos: [] };
});

// ─────────────────────────────────────────────────────────────────────
describe('the guest payload stays narrow', () => {
  beforeEach(() => { mockFixture.jobs = [jobRow('j1', 'RV2006', 'Waterside 1 Siding Replacement')]; });

  test('the envelope has EXACTLY the intended keys', async () => {
    const res = await get();
    expect(Object.keys(res.body).sort()).toEqual(GUEST_ENVELOPE_KEYS);
  });

  test('the task projection is unchanged — still publicTask()\'s whitelist', async () => {
    const res = await get();
    expect(Object.keys(res.body.task).sort()).toEqual(GUEST_TASK_KEYS);
  });

  test('the entity LINK itself never ships — only the composed string', async () => {
    const res = await get();
    expect(res.body.task).not.toHaveProperty('entity_type');
    expect(res.body.task).not.toHaveProperty('entity_id');
    expect(res.body).not.toHaveProperty('entity_type');
    expect(res.body).not.toHaveProperty('entity_id');
    expect(JSON.stringify(res.body)).not.toContain('"j1"');
  });

  test('org ids, author and assignee stay internal', async () => {
    const res = await get();
    const wire = JSON.stringify(res.body);
    ['usr_42', 'usr_9', 'scp_3', 'tsk_1', 'tsh_1'].forEach((v) => {
      expect(wire).not.toContain(v);
    });
    expect(res.body).not.toHaveProperty('organization_id');
    expect(res.body.task).not.toHaveProperty('organization_id');
    expect(res.body.share).not.toHaveProperty('organization_id');
  });

  test('no money-shaped key reaches the guest', async () => {
    const res = await get();
    const scan = (o) => Object.keys(o).forEach((k) => {
      expect(k).not.toMatch(/amount|cost|price|margin|budget|revenue|profit|contract|invoice|retain/i);
    });
    scan(res.body);
    scan(res.body.task);
    scan(res.body.share);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('linked_label tells the worker which job', () => {
  const labelOf = async (task) => (await get(task)).body.linked_label;

  test('a job link → jobNumber + title', async () => {
    mockFixture.jobs = [jobRow('j1', 'RV2006', 'Waterside 1 Siding Replacement')];
    expect(await labelOf()).toBe('RV2006 Waterside 1 Siding Replacement');
  });

  test('number only → the number; title only → the title', async () => {
    mockFixture.jobs = [jobRow('j1', 'RV2006', '')];
    expect(await labelOf()).toBe('RV2006');
    mockFixture.jobs = [jobRow('j1', '', 'Waterside 1')];
    expect(await labelOf()).toBe('Waterside 1');
  });

  test('a job with neither → "Untitled job", never the word "job" alone', async () => {
    mockFixture.jobs = [jobRow('j1', '', '')];
    const l = await labelOf();
    expect(l).toBe('Untitled job');
    expect(l).not.toBe('job');
  });

  test('an UNLINKED task → null, and no lookup is attempted', async () => {
    // tasks.entity_type is nullable — this is the common case, not an edge.
    const l = await labelOf(taskRow({ entity_type: null, entity_id: null }));
    expect(l).toBeNull();
    expect(mockQueries.filter((q) => /FROM jobs|FROM leads/i.test(q.sql))).toHaveLength(0);
  });

  test('a deleted job → null rather than a raw id', async () => {
    mockFixture.jobs = [];
    const l = await labelOf();
    expect(l).toBeNull();
  });

  test('a lead link → the lead title', async () => {
    mockFixture.leads = [{ id: 'l9', label: 'Waterside 1 Siding Replacement' }];
    expect(await labelOf(taskRow({ entity_type: 'lead', entity_id: 'l9' }))).toBe('Waterside 1 Siding Replacement');
  });

  test('a CLIENT link is never named to an outside worker', async () => {
    mockFixture.clients = [{ id: 'c3', label: 'Waterside HOA' }];
    const res = await get(taskRow({ entity_type: 'client', entity_id: 'c3' }));
    expect(res.body.linked_label).toBeNull();
    expect(mockQueries.filter((q) => /FROM clients/i.test(q.sql))).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('Waterside HOA');
  });

  test('an unknown link type fails closed', async () => {
    expect(await labelOf(taskRow({ entity_type: 'purchaseorder', entity_id: 'po_1' }))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('the label survives the worker touching the task', () => {
  test('PATCH still returns publicTask() alone — so the page must hold the label separately', async () => {
    // task-share.html keeps it in state.linked, NOT on state.task, because
    // every PATCH overwrites state.task with this narrow shape. If a future
    // change moves the label onto the task, this test is the reminder that
    // ticking a checkbox would erase it.
    const layer = router.stack.find((l) => l.route
      && l.route.path === '/task-share/:token'
      && l.route.methods && l.route.methods.patch);
    const handle = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = fakeRes();
    await handle({ share: shareRow(), task: taskRow(), body: {} }, res);
    expect(Object.keys(res.body).sort()).toEqual(['ok', 'task']);
    expect(Object.keys(res.body.task).sort()).toEqual(GUEST_TASK_KEYS);
    expect(res.body).not.toHaveProperty('linked_label');
  });
});
