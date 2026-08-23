// test/co-agent-line-ops.test.js — "the agent isnt able to change the CO costs".
//
// It could not, and the reason was not a bug in a write. It was that no write
// existed to reach.
//
// FIRST DEATH — 86 could not RESOLVE a change order. read_entity has no
// change_order type, search_entities has none, and the per-turn job-context
// block prints "- CO-3: <desc> — income $X, cost $Y [draft]" with no row id
// and no lines. 86's own baseline says to resolve an entity before writing and
// to ask rather than guess, so declining WAS the correct behaviour given the
// tools. That is the report.
//
// SECOND DEATH — if it pushed on and named the change order by NUMBER, the
// Scribe emitted co_id "CO-3" and job-financials threw "Change order not
// found on this job: CO-3". Correct, and with no way forward.
//
// THIRD DEATH, THE DANGEROUS ONE — even with the right co_id, `fields.lines`
// is a WHOLE-ARRAY REPLACE and the Scribe has no read access, so the only
// array it can build holds the one line the instruction named. Measured: a
// 3-line $5,850 change order sent one line came back a 1-line $2,750 change
// order, and the payload reported SUCCESS. Fixing the first two without the
// third would have converted a refusal into silent revenue deletion.
//
// And `propose_change_order` — the one name in the repo that sounded like the
// missing tool — appeared exactly once, in the TOOL_REQUIRED_ENTITY gating
// map, with no schema, no executor and no registration anywhere.
//
// THE TWO PROPERTIES:
//   A. a write the model believes succeeded has changed the database;
//   B. a write that changed nothing SAID so.

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const jobFin = require('../server/services/job-financials');
const { internals } = require('../server/services/payload-dispatcher');
const { dispatchJob } = internals;
const { changeOrderMoney } = require('../server/services/money/change-order-totals');

// ── a change-order table that answers SQL ─────────────────────────────
// Not a fake that returns whatever the test wants: it holds one job and one
// change-order row, applies the UPDATE it is given, and hands the row back on
// the next read. So "the record afterwards" is the record the code wrote.
function world(co) {
  const state = {
    job: { id: 'job1', data: {} },
    co: Object.assign({ id: 'co_1', job_id: 'job1', co_number: 'CO-3', status: 'draft',
      is_locked: false, data: { lines: [] } }, co || {}),
    extraCos: [],
    queries: [],
  };
  state.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push(s);
    const p = params || [];
    if (/^SELECT 1 FROM jobs WHERE id/.test(s)) return { rowCount: 1, rows: [{}] };
    if (/SELECT data FROM jobs WHERE id/.test(s)) return { rowCount: 1, rows: [{ data: state.job.data }] };
    if (/SELECT organization_id FROM jobs WHERE id/.test(s)) return { rowCount: 1, rows: [{ organization_id: 1 }] };
    if (/UPDATE jobs SET data/.test(s)) { state.job.data = JSON.parse(p[0]); return { rowCount: 1, rows: [state.job] }; }
    if (/SELECT co\.id, co\.co_number FROM job_change_orders/.test(s)) {
      return { rowCount: 1 + state.extraCos.length,
        rows: [{ id: state.co.id, co_number: state.co.co_number }].concat(state.extraCos) };
    }
    if (/SELECT co\.status, co\.is_locked, co\.data FROM job_change_orders/.test(s)) {
      if (p[0] !== state.co.id) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ status: state.co.status, is_locked: state.co.is_locked, data: state.co.data }] };
    }
    if (/UPDATE job_change_orders SET data/.test(s)) {
      state.co.data = JSON.parse(p[0]);
      return { rowCount: 1, rows: [Object.assign({}, state.co)] };
    }
    return { rowCount: 0, rows: [] };
  };
  return state;
}

const CTX = { organizationId: 1, userId: 'u1' };
const jobTarget = (coOps) => ({ entity_type: 'job', entity_id: 'job1', ops: { change_orders: coOps } });

// The change order John is on: three lines, prices promised, costs still
// placeholders, plus record-level keys owned by other endpoints that a
// wholesale rewrite would drop.
const STORED = {
  title: 'Exterior repairs',
  buildingAllocations: { b1: 1 },
  completionMode: 'standalone',
  costSource: 'po',
  defaultMarkup: 0,
  lines: [
    { id: 'L1', description: 'Demo', qty: 1, unitCost: 900, unitSell: 900, costPending: true },
    { id: 'L2', description: 'Framing', qty: 1, unitCost: 2200, unitSell: 2200, costPending: true },
    { id: 'L3', description: 'Stucco patch', qty: 1, unitCost: 2750, unitSell: 2750, costPending: true },
  ],
};
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ═══════════════════════════════════════════════════════════════════════
 * A. a write the model believes succeeded has changed the database
 * ══════════════════════════════════════════════════════════════════════*/
describe('"set the cost on line 3 of CO-3 to $1,650" — end to end', () => {
  test('the instruction lands, by CO NUMBER and line_id, and moves the cost', async () => {
    const w = world({ data: clone(STORED) });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'CO-3', line_edits: [{ line_id: 'L3', unit_cost: 1650 }] },
    ]), {}, CTX);
    const lines = w.co.data.lines;
    expect(lines).toHaveLength(3);
    expect(lines[2].unitCost).toBe(1650);
  });

  test('THE OTHER LINES ARE BYTE-IDENTICAL — this is the clobber that was possible', async () => {
    const w = world({ data: clone(STORED) });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_edits: [{ line_id: 'L3', unitCost: 1650 }] },
    ]), {}, CTX);
    expect(w.co.data.lines[0]).toEqual(STORED.lines[0]);
    expect(w.co.data.lines[1]).toEqual(STORED.lines[1]);
  });

  test('and the record-level keys other endpoints own survive', async () => {
    const w = world({ data: clone(STORED) });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_edits: [{ line_id: 'L3', unitCost: 1650 }] },
    ]), {}, CTX);
    expect(w.co.data.buildingAllocations).toEqual({ b1: 1 });
    expect(w.co.data.completionMode).toBe('standalone');
    expect(w.co.data.costSource).toBe('po');
    expect(w.co.data.title).toBe('Exterior repairs');
  });

  test('the income the owner was promised does not move when a COST is repaired', async () => {
    const w = world({ data: clone(STORED) });
    const before = changeOrderMoney(w.co.data);
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_edits: [{ line_id: 'L3', unitCost: 1650 }] },
    ]), {}, CTX);
    const after = changeOrderMoney(w.co.data);
    expect(after.income).toBe(before.income);          // the promise is the promise
    expect(after.costs).toBe(before.costs - (2750 - 1650));
  });

  test('the OLD shape — one line in fields.lines — is what it always was, and is now avoidable', async () => {
    // Not a regression test for a fix: `fields.lines` is a full replacement by
    // design and the editor needs it. This pins the behaviour so the reason
    // the line ops exist stays visible.
    const w = world({ data: clone(STORED) });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', fields: { lines: [{ id: 'L3', description: 'Stucco patch', qty: 1, unitCost: 1650, unitSell: 2750 }] } },
    ]), {}, CTX);
    expect(w.co.data.lines).toHaveLength(1);
  });

  test('sending BOTH shapes at once is refused rather than half-applied', async () => {
    const w = world({ data: clone(STORED) });
    await expect(dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1',
        fields: { lines: [{ id: 'L3', qty: 1, unitCost: 1650 }] },
        line_edits: [{ line_id: 'L1', unitCost: 100 }] },
    ]), {}, CTX)).rejects.toThrow(/not both/);
    expect(w.co.data.lines).toHaveLength(3);
  });
});

describe('the key normalizer runs on THIS door too', () => {
  const ALIASES = [
    ['unit_cost', 'unitCost', 1650],
    ['unit_price', 'unitCost', 1650],
    ['unitPrice', 'unitCost', 1650],
    ['unit_sell', 'unitSell', 3200],
    ['sell_price', 'unitSell', 3200],
    ['markup_pct', 'markup', 22],
    ['markupPct', 'markup', 22],
    ['quantity', 'qty', 4],
    ['cost_pending', 'costPending', true],
  ];
  for (const [alias, target, value] of ALIASES) {
    test(`${alias} becomes ${target} — never stored verbatim to price at $0`, async () => {
      const w = world({ data: clone(STORED) });
      const edit = { line_id: 'L3' }; edit[alias] = value;
      await dispatchJob(w, jobTarget([{ op: 'update', co_id: 'co_1', line_edits: [edit] }]), {}, CTX);
      const l = w.co.data.lines[2];
      expect({ key: target, v: l[target] }).toEqual({ key: target, v: value });
      expect(Object.prototype.hasOwnProperty.call(l, alias) && alias !== target).toBe(false);
    });
  }
});

describe('unitSell is settable, or the agent can fix a cost and never a price', () => {
  test('a promised price can be SET on a line that had none', async () => {
    const w = world({ data: { defaultMarkup: 0, lines: [{ id: 'L1', qty: 1, unitCost: 1650 }] } });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_edits: [{ line_id: 'L1', unitSell: 2750 }] },
    ]), {}, CTX);
    expect(w.co.data.lines[0].unitSell).toBe(2750);
    expect(changeOrderMoney(w.co.data)).toEqual({ income: 2750, costs: 1650 });
  });

  test('the whole repair in one op: real cost behind the quoted price', async () => {
    const w = world({ data: clone(STORED) });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'CO-3', line_edits: [
        { line_id: 'L1', unitCost: 500, costPending: false },
        { line_id: 'L2', unitCost: 1400, costPending: false },
        { line_id: 'L3', unitCost: 1650, costPending: false },
      ] },
    ]), {}, CTX);
    expect(changeOrderMoney(w.co.data)).toEqual({ income: 5850, costs: 3550 });
    expect(w.co.data.lines.map((l) => l.costPending)).toEqual([false, false, false]);
  });

  test('BLANK clears a promise — blank is "price me from cost", 0 is "promised at $0"', async () => {
    const w = world({ data: { defaultMarkup: 20, lines: [{ id: 'L1', qty: 1, unitCost: 1000, unitSell: 5000 }] } });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_edits: [{ line_id: 'L1', unitSell: '' }] },
    ]), {}, CTX);
    expect(w.co.data.lines[0].unitSell).toBe('');
    expect(changeOrderMoney(w.co.data)).toEqual({ income: 1200, costs: 1000 });
  });

  test('a promise of 0 is stored as 0, not coerced to blank', async () => {
    const w = world({ data: { defaultMarkup: 20, lines: [{ id: 'L1', qty: 1, unitCost: 1000 }] } });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_edits: [{ line_id: 'L1', unitSell: 0 }] },
    ]), {}, CTX);
    expect(w.co.data.lines[0].unitSell).toBe(0);
    expect(changeOrderMoney(w.co.data).income).toBe(0);
  });
});

describe('adds and deletes touch what they name and nothing else', () => {
  test('an add appends and leaves the stored lines alone', async () => {
    const w = world({ data: clone(STORED) });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_adds: [{ description: 'Paint', qty: 2, unit_cost: 300 }] },
    ]), {}, CTX);
    expect(w.co.data.lines).toHaveLength(4);
    expect(w.co.data.lines.slice(0, 3)).toEqual(STORED.lines);
    expect(w.co.data.lines[3].unitCost).toBe(300);
    expect(w.co.data.lines[3].id).toBeTruthy();
  });

  test('a delete removes only the named line', async () => {
    const w = world({ data: clone(STORED) });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_deletes: [{ line_id: 'L2' }] },
    ]), {}, CTX);
    expect(w.co.data.lines.map((l) => l.id)).toEqual(['L1', 'L3']);
  });

  test('every reference in one op resolves against the array AS READ', async () => {
    // Edits, a delete and an add in one op. If deletes ran before edits, or
    // adds renumbered anything, "line 3" would stop meaning line 3 halfway
    // through the instruction.
    const w = world({ data: clone(STORED) });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1',
        line_edits: [{ line_number: 3, unitCost: 1650 }],
        line_deletes: [{ line_number: 1 }],
        line_adds: [{ description: 'Paint', qty: 1, unitCost: 300 }] },
    ]), {}, CTX);
    expect(w.co.data.lines.map((l) => l.description))
      .toEqual(['Framing', 'Stucco patch', 'Paint']);
    expect(w.co.data.lines[1].unitCost).toBe(1650);
  });

  test('a line_number addresses a change order too old to have line ids', async () => {
    // The records this whole pass is about: written before ids were stamped,
    // so there is no line_id to name and the number is the only address.
    const w = world({ data: { defaultMarkup: 0, lines: [
      { description: 'Gutters', qty: 1, unitCost: 2750, unitSell: 2750 },
      { description: 'Soffit', qty: 1, unitCost: 1800, unitSell: 1800 },
    ] } });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_edits: [{ line_number: 2, unitCost: 900 }] },
    ]), {}, CTX);
    expect(w.co.data.lines[1].unitCost).toBe(900);
    expect(w.co.data.lines[0].unitCost).toBe(2750);
    // …and the record is addressable by id from now on.
    expect(w.co.data.lines.every((l) => l.id)).toBe(true);
  });

  test('a section header is not a line — numbering counts what a human counts', async () => {
    const w = world({ data: { defaultMarkup: 0, lines: [
      { id: 'H1', section: '__section_header__', label: 'Exterior' },
      { id: 'A', description: 'Gutters', qty: 1, unitCost: 2750 },
      { id: 'B', description: 'Soffit', qty: 1, unitCost: 1800 },
    ] } });
    await dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_edits: [{ line_number: 2, unitCost: 900 }] },
    ]), {}, CTX);
    expect(w.co.data.lines[2].unitCost).toBe(900);
    expect(w.co.data.lines[0].section).toBe('__section_header__');
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * B. a write that changed nothing SAID so
 * ══════════════════════════════════════════════════════════════════════*/
describe('nothing silently succeeds', () => {
  const REFUSALS = [
    ['an unknown line_id', { line_edits: [{ line_id: 'nope', unitCost: 1 }] }, /no such line/],
    ['a line_number past the end', { line_edits: [{ line_number: 9, unitCost: 1 }] }, /no such line/],
    ['a line_number of zero', { line_edits: [{ line_number: 0, unitCost: 1 }] }, /no such line/],
    ['a delete of an unknown line', { line_deletes: [{ line_id: 'nope' }] }, /no such line/],
    ['an edit that names a line but sets nothing', { line_edits: [{ line_id: 'L1' }] }, /sets no field/],
    ['a field that is not a line field', { line_edits: [{ line_id: 'L1', income: 9000 }] }, /not an editable change-order line field/],
    ['structure smuggled in as a line field', { line_edits: [{ line_id: 'L1', section: '__section_header__' }] }, /not an editable change-order line field/],
    ['assembly provenance rewritten by hand', { line_edits: [{ line_id: 'L1', sourceAssemblyId: 7 }] }, /not an editable change-order line field/],
    ['a cost that is not a number', { line_edits: [{ line_id: 'L1', unitCost: 'about two grand' }] }, /must be a number or blank/],
    ['an add with no cost', { line_adds: [{ description: 'Paint', qty: 1 }] }, /unitCost is required/],
  ];
  for (const [label, op, re] of REFUSALS) {
    test(`${label} is refused, and the record is untouched`, async () => {
      const w = world({ data: clone(STORED) });
      await expect(dispatchJob(w, jobTarget([Object.assign({ op: 'update', co_id: 'co_1' }, op)]), {}, CTX))
        .rejects.toThrow(re);
      expect(w.co.data).toEqual(STORED);
    });
  }

  test('an unresolvable line names what the change order ACTUALLY holds', async () => {
    // A refusal the model cannot act on is a dead end wearing an error
    // message. This one carries the inventory and the two ways to address it.
    const w = world({ data: clone(STORED) });
    let err;
    try {
      await dispatchJob(w, jobTarget([
        { op: 'update', co_id: 'co_1', line_edits: [{ line_id: 'line-three', unitCost: 1650 }] },
      ]), {}, CTX);
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toContain('Stucco patch');
    expect(err.message).toContain('line_id=L3');
    expect(err.message).toContain('line_number');
    expect(err.message).toContain('Nothing was saved');
  });

  test('a record type with no line ops refuses the keys instead of dropping them', async () => {
    const w = world({ data: clone(STORED) });
    await expect(dispatchJob(w, { entity_type: 'job', entity_id: 'job1', ops: {
      purchase_orders: [{ op: 'update', po_id: 'po_1', line_edits: [{ line_id: 'x', unitCost: 1 }] }],
    } }, {}, CTX)).rejects.toThrow(/does not support line_edits/);
  });

  test('a non-array line op is caught in validation, before the transaction', () => {
    const { validateOps } = require('../server/services/payload-dispatcher');
    expect(() => validateOps('job', { change_orders: [{ op: 'update', co_id: 'co_1', line_edits: { line_id: 'L1' } }] }))
      .toThrow(/line_edits must be an array/);
  });
});

describe('the applied / approved lock still holds on the surgical door', () => {
  test('an APPLIED change order refuses a line edit', async () => {
    const w = world({ status: 'applied', data: clone(STORED) });
    await expect(dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', line_edits: [{ line_id: 'L3', unitCost: 1650 }] },
    ]), {}, CTX)).rejects.toThrow(/Cannot edit an applied change order/);
    expect(w.co.data).toEqual(STORED);
  });

  test('an APPROVED (locked) change order refuses a line edit', async () => {
    const w = world({ status: 'approved', is_locked: true, data: clone(STORED) });
    await expect(dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'CO-3', line_edits: [{ line_id: 'L3', unitCost: 1650 }] },
    ]), {}, CTX)).rejects.toThrow(/Cannot edit an approved \(locked\) change order/);
    expect(w.co.data).toEqual(STORED);
  });

  test('a flat document-level amount is still refused on a line-op payload', async () => {
    const w = world({ data: clone(STORED) });
    await expect(dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'co_1', fields: { total: 9000 }, line_edits: [{ line_id: 'L1', unitCost: 1 }] },
    ]), {}, CTX)).rejects.toThrow(/cannot be set directly/);
    expect(w.co.data).toEqual(STORED);
  });

  test('an org that does not own the change order gets the not-found refusal', async () => {
    const w = world({ data: clone(STORED) });
    // Different job pin: the record no longer answers the status probe.
    await expect(jobFin.updateChangeOrder(w, {
      id: 'co_other', orgId: 1, jobId: 'job1', lineOps: { line_edits: [{ line_id: 'L1', unitCost: 1 }] },
    })).rejects.toThrow(/Change order not found on this job/);
  });
});

describe('a change order named by NUMBER resolves, or refuses by name', () => {
  const SPELLINGS = ['CO-3', 'co-3', 'CO 3', 'co_number CO-3'.slice(10), 'CO-0003', '3'];
  for (const spelling of SPELLINGS) {
    test(`"${spelling}" reaches CO-3`, async () => {
      const w = world({ data: clone(STORED) });
      await dispatchJob(w, jobTarget([
        { op: 'update', co_id: spelling, line_edits: [{ line_id: 'L3', unitCost: 1650 }] },
      ]), {}, CTX);
      expect(w.co.data.lines[2].unitCost).toBe(1650);
    });
  }

  test('an ambiguous number refuses rather than picking one', async () => {
    const w = world({ data: clone(STORED) });
    w.extraCos.push({ id: 'co_2', co_number: 'CO-003' });
    await expect(dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'CO-3', line_edits: [{ line_id: 'L3', unitCost: 1650 }] },
    ]), {}, CTX)).rejects.toThrow(/Ambiguous change order reference/);
    expect(w.co.data).toEqual(STORED);
  });

  test('a number nobody has is refused naming what was asked for', async () => {
    const w = world({ data: clone(STORED) });
    await expect(dispatchJob(w, jobTarget([
      { op: 'update', co_id: 'CO-99', line_edits: [{ line_id: 'L3', unitCost: 1650 }] },
    ]), {}, CTX)).rejects.toThrow(/Change order not found on this job: CO-99/);
  });

  test('a co_ row id is never re-interpreted as a number', async () => {
    expect(await jobFin.resolveCoId({ query: async () => { throw new Error('must not query'); } },
      { id: 'co_1', orgId: 1, jobId: 'job1' })).toBe('co_1');
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The surface 86 actually has
 * ══════════════════════════════════════════════════════════════════════*/
const AI = read('server', 'routes', 'ai-routes.js');
const AGENTS = read('server', 'routes', 'admin-agents-routes.js');

describe('no name sits in a gating map with nothing behind it', () => {
  // The general rule, not a line about propose_change_order. A name in
  // TOOL_REQUIRED_ENTITY is a claim that a tool answers to it; the phantom
  // pre-armed an entity gate for a tool that could never be invoked, and the
  // next person to write one would have inherited a restriction nobody chose.
  const gated = [];
  for (const block of ['ESTIMATE_REQUIRED', 'JOB_REQUIRED']) {
    const m = new RegExp('const ' + block + ' = \\[([\\s\\S]*?)\\n\\];').exec(AI);
    expect(m).not.toBeNull();
    const body = m[1].replace(/\/\/[^\n]*/g, '');
    for (const q of body.match(/'([a-z0-9_]+)'/g) || []) gated.push(q.slice(1, -1));
  }

  test('the gating map is not empty (the scan is really scanning)', () => {
    expect(gated.length).toBeGreaterThan(5);
  });

  for (const name of new Set(gated)) {
    test(`${name} has a tool definition behind it`, () => {
      expect(new RegExp("name:\\s*'" + name + "'").test(AI)).toBe(true);
    });
  }

  test('propose_change_order is no longer a live name anywhere', () => {
    // The comment recording why it left is fine; a quoted token is not.
    const code = AI.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toContain('propose_change_order');
  });
});

describe('read_change_orders is registered on every surface a tool needs', () => {
  // The recurring miss in this file: a tool defined but absent from one of the
  // four sets, which surfaces as 86 answering "Change applied." having done
  // nothing. Asserted as a rule over EVERY project-inline tool, so the next
  // one added is covered too.
  const inline = (() => {
    const m = /const PROJECT_INLINE_TOOLS = \[([\s\S]*?)\n\];/.exec(AI);
    return (m[1].match(/name:\s*'([a-z0-9_]+)'/g) || []).map((s) => s.replace(/name:\s*'|'/g, ''));
  })();

  test('the scan found the tool list', () => {
    expect(inline).toContain('read_purchase_orders');
    expect(inline).toContain('read_change_orders');
  });

  for (const name of inline) {
    test(`${name}: has an executor branch, an executor-set entry and an auto tier`, () => {
      const execSet = /const PROJECT_INLINE_EXECUTOR_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(AI)[1];
      const autoSet = /const ALLOWED_AUTO_TIER_TOOLS = new Set\(\[([\s\S]*?)\n\]\)/.exec(AI)[1];
      expect({ tool: name, executorBranch: new RegExp("name === '" + name + "'").test(AI) })
        .toEqual({ tool: name, executorBranch: true });
      expect({ tool: name, inExecutorSet: execSet.includes("'" + name + "'") })
        .toEqual({ tool: name, inExecutorSet: true });
      expect({ tool: name, autoTier: autoSet.includes("'" + name + "'") })
        .toEqual({ tool: name, autoTier: true });
    });
  }

  test('a tool that reads EVERY job in the org is capability-gated, like its sibling', () => {
    // Not asserted for the whole list: the personal reads (calendar,
    // reminders, photo comments) are owner-scoped by construction and
    // deliberately carry no capability. read_change_orders reads across the
    // org exactly as read_purchase_orders does, so it carries the same gate.
    expect(AI).toMatch(/\['read_purchase_orders', 'JOBS_VIEW_ALL'\]/);
    expect(AI).toMatch(/\['read_change_orders', 'JOBS_VIEW_ALL'\]/);
  });

  test('86 can actually call it — the router allowlist is the last gate', () => {
    const m = /const ROUTER_TOOL_NAMES = new Set\(\[([\s\S]*?)\n\s*\]\);/.exec(AGENTS);
    expect(m[1]).toContain("'read_change_orders'");
  });

  test('the read returns the two addresses a write needs', () => {
    const branch = AI.slice(AI.indexOf("if (name === 'read_change_orders')"));
    expect(branch.slice(0, 6000)).toContain('co_id=');
    expect(branch.slice(0, 6000)).toContain('line_id=');
  });

  test('86 is TOLD to read a change order before writing one', () => {
    // The tool existing is not the same as 86 knowing to reach for it. Its
    // baseline already said change orders were writable and left it with no
    // way to resolve one; the instruction has to name the read AND the reason
    // the job-context block is not enough.
    const baseline = AGENTS.slice(AGENTS.indexOf('CHANGE ORDERS: the job-context block'));
    expect(AGENTS).toContain('CHANGE ORDERS: the job-context block');
    const para = baseline.slice(0, 1400);
    expect(para).toContain('carries no ids and no lines');
    expect(para).toContain('read_change_orders');
    expect(para).toContain('line_edits');
    expect(para).toContain('NEVER ask for a full `fields.lines` replacement');
  });

  test('the Scribe is told that fields.lines is a REPLACEMENT, and given the alternative', () => {
    const vocab = AGENTS.slice(AGENTS.indexOf('`fields.lines` REPLACES THE WHOLE ARRAY'));
    expect(AGENTS).toContain('`fields.lines` REPLACES THE WHOLE ARRAY');
    const para = vocab.slice(0, 2500);
    for (const k of ['line_edits', 'line_adds', 'line_deletes', 'line_number', 'DELETES THE REST']) {
      expect({ scribeBaselineMentions: k, found: para.includes(k) })
        .toEqual({ scribeBaselineMentions: k, found: true });
    }
  });
});
