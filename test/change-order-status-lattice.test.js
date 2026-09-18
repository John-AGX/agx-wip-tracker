// test/change-order-status-lattice.test.js — ONE change-order status lattice,
// written down THREE times.
//
//   server/routes/change-order-routes.js  ALLOWED_TRANSITIONS  (the only one
//                                         that can actually refuse anything)
//   js/jobs-hub.js                        CO_TRANSITIONS       (the bulk menu)
//   js/change-order-editor.js             CO_TRANSITIONS       (the status pill)
//
// Nothing tested that the three agreed. Both client copies exist to filter a
// menu down to what the server will accept, so when they drift the user is
// offered a move that 409s — or, worse, is offered NOTHING and told a lie: the
// editor's copy used to be an inline object literal, and a status it had not
// heard of fell to `allowed = []`, which popped "Applied change orders cannot
// be re-transitioned." on a change order that was not applied.
//
// The two client copies are EVALUATED, not regex-matched, so a syntactically
// valid change to either is the thing compared.
//
// This file follows test/clickr-purchase-orders.test.js, which pins
// SUB_ACCESS_STATUS equal to PO_ACTIVE_STATUS the same way.

let db;

jest.mock('../server/db', () => ({
  pool: {
    connect: async () => ({ query: async (s, p) => global.__latticeDb.query(s, p), release() {} }),
    query: async (s, p) => global.__latticeDb.query(s, p),
  },
}));
jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireOrg: (req, res, next) => next(),
  requireOrgId: (req, res, next) => { req.orgId = 1; next(); },
  requireRole: () => (req, res, next) => next(),
  requireCapability: () => (req, res, next) => next(),
  resolveOrgId: (req, res, next) => next(),
  hasCapability: () => true,
  isAdminish: () => true,
}));

const fs = require('fs');
const path = require('path');
const coRouter = require('../server/routes/change-order-routes');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* Lift a `{...}` object literal out of a browser script by brace-counting and
 * EVALUATE it. Fails loudly (missing anchor, unbalanced braces, SyntaxError)
 * rather than quietly comparing nothing. */
function objectLiteral(src, anchor, where) {
  const i = src.indexOf(anchor);
  if (i === -1) throw new Error(where + ': anchor not found — ' + anchor);
  const open = src.indexOf('{', i);
  if (open === -1) throw new Error(where + ': no object literal after the anchor');
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) {
      // eslint-disable-next-line no-new-func
      return new Function('return ' + src.slice(open, j + 1) + ';')();
    }
  }
  throw new Error(where + ': unbalanced braces');
}

const SERVER = objectLiteral(read('server/routes/change-order-routes.js'),
  'const ALLOWED_TRANSITIONS =', 'change-order-routes.js');
const HUB = objectLiteral(read('js/jobs-hub.js'),
  'var CO_TRANSITIONS =', 'jobs-hub.js');
const EDITOR = objectLiteral(read('js/change-order-editor.js'),
  'var CO_TRANSITIONS =', 'change-order-editor.js');

describe('the three lattices are the same lattice', () => {
  test('none of the three is empty (the extractor really found something)', () => {
    [['server', SERVER], ['hub', HUB], ['editor', EDITOR]].forEach(([n, o]) => {
      expect([n, Object.keys(o).length > 0]).toEqual([n, true]);
    });
  });

  test('the client copies equal the server copy, key for key and move for move', () => {
    expect(HUB).toEqual(SERVER);
    expect(EDITOR).toEqual(SERVER);
  });

  test('every key and every target is a status the server will accept', () => {
    const values = objectLiteral(
      'x = { v: ' + read('server/routes/change-order-routes.js')
        .match(/const STATUS_VALUES = (\[[^\]]*\])/)[1] + ' }', 'x =', 'STATUS_VALUES').v;
    expect(values.length).toBeGreaterThan(0);
    const named = new Set(values);
    Object.keys(SERVER).forEach((from) => {
      expect([from, named.has(from)]).toEqual([from, true]);
      SERVER[from].forEach((to) => expect([from + '->' + to, named.has(to)]).toEqual([from + '->' + to, true]));
    });
    // And the vocabulary itself is the one this feature shipped.
    expect(values).toEqual(['draft', 'pending', 'approved', 'applied']);
  });

  test('the shape of the lattice, stated rather than inferred', () => {
    expect(SERVER).toEqual({
      draft: ['pending', 'approved'],      // direct draft→approved is KEPT
      pending: ['draft', 'approved'],
      approved: ['draft', 'applied'],
      applied: [],                          // terminal
    });
    // pending→applied is deliberately absent: 'applied' means the field
    // consumed it, which cannot be true of something nobody signed.
    expect(SERVER.pending).not.toContain('applied');
  });
});

/* ── The badge the job screen paints, driven ────────────────────────────── */

describe('the change-order badge on the job screen', () => {
  const { extractFunction, compile } = require('./helpers/browser-fn');
  const JOBS = read('js/jobs.js');
  const statusBadge = compile([extractFunction(JOBS, 'statusBadge')], [], [], 'statusBadge');

  const label = (s) => (statusBadge(s).match(/>([^<]*)<\/span>/) || [, ''])[1];

  test('every status in the lattice gets its own word', () => {
    expect(Object.keys(SERVER).map(label)).toEqual(['Draft', 'Pending approval', 'Approved', 'Applied']);
  });

  test('PENDING does not render as APPLIED — the worst wrong word available here', () => {
    // It used to: the label ternary ended `: 'Applied'`, so any status it had
    // not heard of printed the terminal status, in the terminal colour, on a
    // money surface.
    expect(label('pending')).not.toBe(label('applied'));
    expect(statusBadge('pending')).not.toBe(statusBadge('applied'));
  });

  test('pending gets the amber warning colour, not the approved green or applied blue', () => {
    expect(statusBadge('pending')).toMatch(/fbbf24/);
    expect(statusBadge('pending')).not.toMatch(/34d399|4f8cff/);
  });
});

/* ── The chip on the Change Orders hub, driven ──────────────────────────── */

describe('the change-order chip on the Jobs hub', () => {
  const { extractFunction, compile } = require('./helpers/browser-fn');
  const HUB = read('js/jobs-hub.js');
  const LABELS = (() => {
    const m = HUB.match(/var CO_STATUS_LABEL = (\{[^}]*\});/);
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-new-func
    return new Function('return (' + m[1] + ');')();
  })();
  const hubBadge = compile(
    [extractFunction(HUB, 'esc'), extractFunction(HUB, 'statusBadge')],
    ['STATUS_COLOR', 'window'],
    [{ draft: '#94a3b8', pending: '#fbbf24', approved: '#34d399', applied: '#2dd4bf' }, {}],
    'statusBadge');
  const label = (s, m) => (hubBadge(s, m).match(/>([^<]*)<\/span>/) || [, ''])[1];

  test('the CO list says "Pending approval", never a bare "Pending"', () => {
    // A bare "Pending" on these screens also means a placeholder unit cost
    // (costPending on a CO line) and an unsigned purchase-order addendum — and
    // it contradicted this list's OWN filter, which reads "Pending approval".
    expect(label('pending', LABELS)).toBe('Pending approval');
    expect(HUB).toMatch(/statusBadge\(r\.status, CO_STATUS_LABEL\)/);
  });

  test('the shared chip is unchanged for every other list', () => {
    // POs, RFIs, submittals and bills pass no map at all.
    expect(label('draft')).toBe('Draft');
    expect(label('work_complete')).toBe('Work Complete');
    expect(label('pending')).toBe('Pending');
    expect(label('approved', LABELS)).toBe('Approved');
  });
});

/* ── The row read_change_orders hands the model ─────────────────────────── */

describe('what the model is told a pending change order is', () => {
  const AI = read('server/routes/ai-routes.js');
  const m = AI.match(/\(x\.status !== 'approved' && x\.status !== 'applied'\s*\?([\s\S]*?): ''\)\);/);
  const tail = (status) => {
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-new-func
    return new Function('x', 'return (' + m[1] + ');')({ status });
  };

  test('a PENDING change order is not described as a DRAFT', () => {
    // The tail was a deny-list of two, exhaustive while the vocabulary was
    // draft|approved|applied. With pending in it the line printed
    // "· pending · … [DRAFT …]" — two statuses at once, and DRAFT is the word
    // the model repeats to the person who asked whether it is signed yet.
    expect(tail('pending')).not.toMatch(/DRAFT/);
    expect(tail('pending')).toMatch(/PENDING APPROVAL/);
    expect(tail('pending')).toMatch(/nobody has signed it/);
    // The $0 half was always right and stays.
    expect(tail('pending')).toMatch(/contributes \$0 to the job WIP until approved/);
  });

  test('a DRAFT still says DRAFT, and the tool description names all four', () => {
    expect(tail('draft')).toMatch(/\[DRAFT — contributes \$0/);
    expect(tail(undefined)).toMatch(/\[DRAFT/);
    expect(AI).toMatch(/draft \| pending \| approved \| applied/);
  });
});

/* ── The route itself, driven ───────────────────────────────────────────── */

function makeDb(currentStatus) {
  const state = { calls: [], update: null, current: currentStatus };
  state.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    state.calls.push(s);
    if (/^BEGIN|^COMMIT|^ROLLBACK/.test(s)) return { rowCount: 0, rows: [] };
    if (/SELECT co\.status/.test(s)) {
      return { rowCount: 1, rows: [{ status: state.current, job_id: 'job1', linked_node_id: null, data: { lines: [] } }] };
    }
    if (/UPDATE job_change_orders/.test(s)) {
      state.update = { status: params[0], approvedAt: params[1], approvedBy: params[2], lock: params[4] };
      return { rowCount: 1, rows: [{ id: 'co_1', job_id: 'job1', owner_id: 1, status: params[0],
        co_number: 'CO-0001', data: {}, approved_at: params[1], approved_by: params[2],
        linked_node_id: null, is_locked: params[4], created_at: null, updated_at: null }] };
    }
    if (/SELECT owner_id FROM jobs/.test(s)) return { rowCount: 1, rows: [{ owner_id: 1 }] };
    return { rowCount: 0, rows: [] };
  };
  return state;
}

function handlerFor(method, routePath) {
  const layer = coRouter.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(method.toUpperCase() + ' ' + routePath + ' not found');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function transition(from, to) {
  db = makeDb(from);
  global.__latticeDb = db;
  const handler = handlerFor('post', '/change-orders/:id/status');
  const res = { code: 200, body: null,
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ params: { id: 'co_1' }, body: { status: to },
    user: { id: 1, role: 'admin', organization_id: 1 } }, res);
  return { code: res.code, body: res.body, update: db.update };
}

describe('the status route, driven against a real router', () => {
  test('draft -> pending is accepted, writes pending, and does NOT lock or stamp', async () => {
    const r = await transition('draft', 'pending');
    expect(r.code).toBe(200);
    expect(r.update.status).toBe('pending');
    // lockState is (approved || applied): pending is in the false arm, and the
    // UPDATE writes is_locked unconditionally, so a bounced CO lands unlocked.
    expect(r.update.lock).toBe(false);
    expect(r.update.approvedAt).toBeNull();
    expect(r.update.approvedBy).toBeNull();
  });

  test('pending -> approved is accepted and locks and stamps, as draft -> approved does', async () => {
    const r = await transition('pending', 'approved');
    expect(r.code).toBe(200);
    expect(r.update.status).toBe('approved');
    expect(r.update.lock).toBe(true);
    expect(r.update.approvedAt).toBeInstanceOf(Date);
    expect(r.update.approvedBy).toBe(1);
  });

  test('pending -> draft is accepted and leaves it unlocked', async () => {
    const r = await transition('pending', 'draft');
    expect(r.code).toBe(200);
    expect([r.update.status, r.update.lock]).toEqual(['draft', false]);
  });

  test('approved -> draft -> pending lands unlocked (the bounce path)', async () => {
    expect((await transition('approved', 'draft')).update.lock).toBe(false);
    expect((await transition('draft', 'pending')).update.lock).toBe(false);
  });

  test('THE GUARD BITES — pending -> applied is 409 and writes nothing', async () => {
    const r = await transition('pending', 'applied');
    expect(r.code).toBe(409);
    expect(String(r.body.error)).toMatch(/Transition not allowed: pending → applied/);
    expect(r.update).toBeNull();
    expect(db.calls.some((s) => /UPDATE job_change_orders/.test(s))).toBe(false);
  });

  test('THE GUARD BITES — applied -> pending is 409 and writes nothing', async () => {
    const r = await transition('applied', 'pending');
    expect(r.code).toBe(409);
    expect(r.update).toBeNull();
  });

  test('THE GUARD BITES — approved -> pending is 409 (a sync never un-approves; nor does the route)', async () => {
    const r = await transition('approved', 'pending');
    expect(r.code).toBe(409);
    expect(r.update).toBeNull();
  });

  test('a status outside STATUS_VALUES is 400 before anything is read', async () => {
    const r = await transition('draft', 'sent');
    expect(r.code).toBe(400);
    expect(db.calls).toEqual([]);
  });

  test('a row at a status the lattice has no key for is a 409, never a 500', async () => {
    // ALLOWED_TRANSITIONS[current] used to be indexed unguarded. Harmless while
    // every row was draft/approved/applied; a TypeError the day one is not.
    const r = await transition('superseded', 'draft');
    expect(r.code).toBe(409);
    expect(r.update).toBeNull();
  });
});
