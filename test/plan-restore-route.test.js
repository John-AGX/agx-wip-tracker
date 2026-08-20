// GATE 1 — recovery writes over live data, so it shows first, acts once, and
// leaves a record.
//
// Restoring a plan_versions snapshot is the only operation in Plans that
// deliberately overwrites a drawing. Before this suite it took a plan id and a
// version id and nothing else: no statement of what was being taken, no
// statement of what was being replaced, no audit row. A stale restore point
// silently landing on a drawing somebody had since redrawn would have been
// this incident happening a second time, and there would have been no evidence
// that it had.
//
// So the route now requires `expect_entities` — the count the operator was
// SHOWN — re-measures the snapshot server-side, and refuses on any mismatch;
// and the safety snapshot, the audit row and the overwrite commit in one
// transaction or not at all.
//
// Driven through the real router handlers against a transactional in-memory
// fake pg, with the REAL server/audit.js writing through the same fake — so
// the tier-A fail-closed path is the shipped one, not a stub of it.

'use strict';

const { inspectPages } = require('../server/services/plan-doc');

// ── Fake Postgres ────────────────────────────────────────────────────────
// Transactional on purpose: the whole point of the restore's audited
// transaction is that a failed audit write leaves NOTHING behind, and a fake
// that kept staged writes could not tell that apart from a successful one.
function makeDb() {
  const db = {
    plans: new Map(),
    versions: [],
    audit: [],
    log: [],
    nextVersionId: 100,
    failAudit: false
  };
  let staged = null;                       // { plans, versions, audit } overlay

  const view = () => staged || db;
  const count = (pages) => inspectPages(pages).entities;

  function snapshotState() {
    return {
      plans: new Map([...db.plans].map(([k, v]) => [k, Object.assign({}, v)])),
      versions: db.versions.slice(),
      audit: db.audit.slice()
    };
  }
  function publish(s) { db.plans = s.plans; db.versions = s.versions; db.audit = s.audit; }

  async function query(sql, params) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    db.log.push(text);
    const st = view();

    if (/^BEGIN/i.test(text)) { staged = snapshotState(); return { rows: [], rowCount: 0 }; }
    if (/^COMMIT/i.test(text)) { if (staged) publish(staged); staged = null; return { rows: [], rowCount: 0 }; }
    if (/^ROLLBACK/i.test(text)) { staged = null; return { rows: [], rowCount: 0 }; }

    if (/INSERT INTO admin_audit_log/i.test(text)) {
      if (db.failAudit) throw new Error('audit table unavailable');
      const cols = ['actor_kind', 'actor_user_id', 'actor_email', 'actor_role', 'actor_org_id',
        'on_behalf_of_user_id', 'on_behalf_of_email', 'action', 'outcome', 'reason', 'tier', 'scope',
        'target_type', 'target_id', 'organization_id', 'detail', 'ip', 'user_agent', 'request_id'];
      const row = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      row.detail = row.detail ? JSON.parse(row.detail) : null;
      st.audit.push(row);
      return { rows: [], rowCount: 1 };
    }

    // restore pre-flight: "how many objects on each side"
    if (/AS live/.test(text)) {
      const p = st.plans.get(params[0]);
      if (!p || p.organization_id !== params[1]) return { rows: [], rowCount: 0 };
      const v = st.versions.find((x) => x.id === params[2] && x.plan_id === p.id && x.organization_id === p.organization_id);
      return { rows: [{ live: count(p.pages), snap: v ? count(v.pages) : null }], rowCount: 1 };
    }

    // GET /versions — live row count
    if (/AS entity_count FROM plans p/.test(text)) {
      const p = st.plans.get(params[0]);
      if (!p || p.organization_id !== params[1]) return { rows: [], rowCount: 0 };
      return { rows: [{ entity_count: count(p.pages) }], rowCount: 1 };
    }
    // GET /versions — the restore points
    if (/FROM plan_versions v/.test(text) && /^SELECT/i.test(text)) {
      const rows = st.versions
        .filter((v) => v.plan_id === params[0] && v.organization_id === params[1])
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map((v) => ({
          id: v.id, name: v.name, created_at: v.created_at, created_by_name: null,
          page_count: Array.isArray(v.pages) ? v.pages.length : 0, entity_count: count(v.pages)
        }));
      return { rows, rowCount: rows.length };
    }

    if (/INSERT INTO plan_versions/i.test(text)) {
      const p = st.plans.get(params[0]);
      if (!p || p.organization_id !== params[1]) return { rows: [], rowCount: 0 };
      // The safety snapshot is gated on the target version existing.
      if (params.length >= 4) {
        const exists = st.versions.some((x) => x.id === params[3] && x.plan_id === p.id);
        if (!exists) return { rows: [], rowCount: 0 };
      }
      const row = {
        id: db.nextVersionId++, plan_id: p.id, organization_id: p.organization_id,
        name: p.name, pages: p.pages, totals: p.totals, created_at: new Date().toISOString(),
        _safety: true
      };
      st.versions.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (/UPDATE plans p SET pages = v\.pages/i.test(text)) {
      const p = st.plans.get(params[0]);
      if (!p || p.organization_id !== params[1]) return { rows: [], rowCount: 0 };
      const v = st.versions.find((x) => x.id === params[2] && x.plan_id === p.id && x.organization_id === p.organization_id);
      if (!v) return { rows: [], rowCount: 0 };
      p.pages = v.pages;
      return { rows: [{ id: p.id }], rowCount: 1 };
    }

    if (/^DELETE FROM plan_versions/i.test(text)) return { rows: [], rowCount: 0 };
    if (/^UPDATE plans SET/i.test(text)) {
      const p = st.plans.get(params[params.length - 2]);
      if (!p) return { rows: [], rowCount: 0 };
      return { rows: [Object.assign({}, p)], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  db.query = query;
  return db;
}

jest.mock('../server/db', () => ({
  pool: {
    query: (sql, params) => global.__planDb.query(sql, params),
    connect: async () => ({ query: (sql, params) => global.__planDb.query(sql, params), release() {} })
  }
}));
jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireCapability: () => (req, res, next) => next()
}));

const router = require('../server/routes/plans-routes');

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(method.toUpperCase() + ' ' + path + ' not found on the router');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}
const USER = { id: 42, email: 'john@agxco.com', role: 'system_admin', organization_id: 7 };
async function call(method, path, req) {
  const res = fakeRes();
  await handlerFor(method, path)(Object.assign({ user: USER, params: {}, query: {}, body: {}, headers: {} }, req), res);
  return res;
}

// ── Fixtures ─────────────────────────────────────────────────────────────
function sheetPages(n) {
  const ents = new Array(n).fill(0).map((_, i) => ({ id: 'E' + i, tool: 'line', layer: 'L0' }));
  return [{ kind: 'sheet-doc', version: 3, model: { entities: ents, layers: [{ id: 'L0' }] }, sheets: [{ id: 'S1', viewports: [] }] }];
}

let db;
beforeEach(() => {
  db = makeDb();
  global.__planDb = db;
  db.plans.set('plan_1', { id: 'plan_1', organization_id: 7, name: 'Bldg 3 layout', pages: sheetPages(0), totals: {} });
  db.versions.push(
    { id: 11, plan_id: 'plan_1', organization_id: 7, name: 'Bldg 3 layout', pages: sheetPages(15), totals: {}, created_at: '2026-07-10T14:00:00Z' },
    { id: 12, plan_id: 'plan_1', organization_id: 7, name: 'Bldg 3 layout', pages: sheetPages(0), totals: {}, created_at: '2026-08-02T09:00:00Z' }
  );
});
afterEach(() => { delete global.__planDb; });

// ═══════════════════════════════════════════════════════════════════════
describe('show before act', () => {

  test('the version list says how many objects each restore point holds, and what is live now', async () => {
    const res = await call('get', '/:id/versions', { params: { id: 'plan_1' } });
    expect(res.statusCode).toBe(200);
    // page_count was always 1 for a sheet drawing — it could not tell the
    // operator whether the restore point they were about to take had a
    // drawing in it at all.
    const byId = Object.fromEntries(res.body.versions.map((v) => [v.id, v.entity_count]));
    expect(byId[11]).toBe(15);
    expect(byId[12]).toBe(0);
    expect(res.body.current_entity_count).toBe(0);
  });

  test('listing restore points writes nothing', async () => {
    db.log.length = 0;
    await call('get', '/:id/versions', { params: { id: 'plan_1' } });
    expect(db.log.every((s) => /^SELECT/i.test(s))).toBe(true);
    expect(db.versions).toHaveLength(2);
    expect(db.audit).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('nothing restores by itself', () => {

  test('a restore with no stated expectation is refused, and changes nothing', async () => {
    const res = await call('post', '/:id/versions/:vid/restore', { params: { id: 'plan_1', vid: '11' }, body: {} });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/expect_entities is required/);
    expect(inspectPages(db.plans.get('plan_1').pages).entities).toBe(0);
    expect(db.versions).toHaveLength(2);
    expect(db.audit).toHaveLength(0);
  });

  test('a stale expectation is refused with both numbers, and changes nothing', async () => {
    const res = await call('post', '/:id/versions/:vid/restore',
      { params: { id: 'plan_1', vid: '11' }, body: { expect_entities: 9 } });
    expect(res.statusCode).toBe(409);
    expect(res.body.actual_entities).toBe(15);
    expect(res.body.expect_entities).toBe(9);
    expect(inspectPages(db.plans.get('plan_1').pages).entities).toBe(0);
    expect(db.audit).toHaveLength(0);
  });

  test('the router exposes exactly one restore path, and it names a single version', () => {
    const restorePaths = router.stack
      .filter((l) => l.route && /restore/.test(l.route.path))
      .map((l) => l.route.path);
    expect(restorePaths).toEqual(['/:id/versions/:vid/restore']);
    // No bulk form, no "repair all", nothing that walks a list of plans. A
    // tool that pushed snapshots back over live rows on its own would be this
    // incident again with better intentions.
    expect(router.stack.some((l) => l.route && /repair|recover|heal|restore-all/.test(l.route.path))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('an accepted restore is reversible and recorded', () => {

  test('it takes the snapshot, reports both sides, and keeps an undo', async () => {
    const res = await call('post', '/:id/versions/:vid/restore',
      { params: { id: 'plan_1', vid: '11' }, body: { expect_entities: 15 } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, restored: 11, entities_taken: 15, entities_replaced: 0 });
    expect(inspectPages(db.plans.get('plan_1').pages).entities).toBe(15);
    // The pre-restore state was snapshotted, so the restore is itself undoable.
    const safety = db.versions.filter((v) => v._safety);
    expect(safety).toHaveLength(1);
    expect(inspectPages(safety[0].pages).entities).toBe(0);
  });

  test('it writes one tier-A audit row naming what was taken and what it replaced', async () => {
    await call('post', '/:id/versions/:vid/restore',
      { params: { id: 'plan_1', vid: '11' }, body: { expect_entities: 15 } });
    expect(db.audit).toHaveLength(1);
    const row = db.audit[0];
    expect(row.action).toBe('plan.version_restore');
    expect(row.tier).toBe('A');
    expect(row.outcome).toBe('ok');
    expect(row.target_type).toBe('plan');
    expect(row.target_id).toBe('plan_1');
    expect(row.organization_id).toBe(7);
    expect(row.actor_user_id).toBe(42);
    expect(row.detail).toMatchObject({
      version_id: 11, entities_taken: 15, entities_replaced: 0,
      replaced_a_populated_drawing: false, safety_snapshot: true
    });
  });

  test('restoring OVER a populated drawing is recorded as exactly that', async () => {
    db.plans.get('plan_1').pages = sheetPages(4);
    await call('post', '/:id/versions/:vid/restore',
      { params: { id: 'plan_1', vid: '11' }, body: { expect_entities: 15 } });
    expect(db.audit[0].detail).toMatchObject({ entities_replaced: 4, replaced_a_populated_drawing: true });
  });

  test('if the audit row cannot be written the restore is REFUSED, not performed unrecorded', async () => {
    db.failAudit = true;
    const res = await call('post', '/:id/versions/:vid/restore',
      { params: { id: 'plan_1', vid: '11' }, body: { expect_entities: 15 } });
    expect(res.statusCode).toBe(503);
    // Tier A, fail closed: the plan is untouched, the safety snapshot rolled
    // back with it, and nothing in the table claims a restore happened.
    expect(inspectPages(db.plans.get('plan_1').pages).entities).toBe(0);
    expect(db.versions.filter((v) => v._safety)).toHaveLength(0);
    expect(db.audit).toHaveLength(0);
  });

  test('a version that does not exist is a 404, with no snapshot and no audit row', async () => {
    const res = await call('post', '/:id/versions/:vid/restore',
      { params: { id: 'plan_1', vid: '999' }, body: { expect_entities: 15 } });
    expect(res.statusCode).toBe(404);
    expect(db.versions).toHaveLength(2);
    expect(db.audit).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('the prune stops eating the evidence', () => {

  // 30 snapshots at one per 10 minutes span >= 5 hours of saving. Every save
  // on an already-emptied plan was pruning a good restore point to make room
  // for another empty one — the cap was deleting the only copy of the drawing.
  //
  // The exemption is a SQL predicate, and no Postgres is reachable from this
  // suite, so what is asserted here is that the statement carries it. The
  // predicate's behaviour against real jsonb is NOT proved by this test and
  // this comment is the honest statement of that limit.
  test('the prune statement exempts a geometry-bearing snapshot while the live row is empty', async () => {
    db.log.length = 0;
    await call('patch', '/:id', { params: { id: 'plan_1' }, body: { pages: sheetPages(3) } });
    const del = db.log.find((s) => /^DELETE FROM plan_versions/i.test(s));
    expect(del).toBeTruthy();
    expect(del).toMatch(/LIMIT 30/);                       // the cap still exists
    expect(del).toMatch(/AND NOT \(GREATEST\(/);           // ...and is now conditional
    expect(del).toMatch(/FROM plans p WHERE p\.id = v\.plan_id/);
    expect(del).toMatch(/= 0\)\)$/);                       // only when the live row is empty
  });

  test('a save still takes its throttled snapshot', async () => {
    db.log.length = 0;
    await call('patch', '/:id', { params: { id: 'plan_1' }, body: { pages: sheetPages(3) } });
    expect(db.log.some((s) => /INSERT INTO plan_versions/i.test(s) && /10 minutes/.test(s))).toBe(true);
  });
});
