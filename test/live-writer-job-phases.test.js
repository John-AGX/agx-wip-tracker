/**
 * @jest-environment jsdom
 */
// A job's phase write, rendered.
//
// THE BUG THIS FIXES. `phase_updates` is the only lever on % complete and
// therefore on revenue earned — the highest-stakes write an agent makes. A
// phase lives in jobs.data.phases and the dispatcher snapshots the whole row,
// so the before/after was always there. But scalarFieldOps SKIPs `data`
// wholesale and returns early on any nested object, so a phase-only write
// produced ZERO ops, diffChangeset filtered the empty group out, and the user
// was told "nothing in it comes out as a change this view can list" about a
// write that moved the job's money.
//
// The first test below is the regression: it fails on the old differ.

jest.useFakeTimers();

let LW;

beforeAll(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: [] }) })
  );
  global.localStorage = { getItem: () => null, setItem: () => {} };
  require('../js/live-writer.js');
  LW = window.p86LiveWriter;
});

// A phase as the app really stores it: the scope NAME lives in `phase`, and
// there is no `name` or `title` field at all.
const P = (id, over) => Object.assign({
  id, phase: 'Framing', jobId: 'j1', pctComplete: 40, phaseBudget: 10000
}, over || {});

const job = (phases, over) => Object.assign({
  id: 'j1', data: Object.assign({ title: 'Harbor Point', status: 'active', phases }, over || {})
}, {});

const entry = (beforePhases, afterPhases, bOver, aOver) => ({
  entity_type: 'job', id: 'j1',
  before: job(beforePhases, bOver),
  after: job(afterPhases, aOver)
});

describe('a phase write is listable at all', () => {
  test('REGRESSION: pctComplete moving produces ops (was zero)', () => {
    const d = LW._diffEntry(entry([P('p1')], [P('p1', { pctComplete: 60 })]));
    expect(d.ops.length).toBeGreaterThan(0);
    expect(d.entity_type).toBe('job');
  });

  test('the op is PAINTABLE — it carries the phase id as lineId', () => {
    const d = LW._diffEntry(entry([P('p1')], [P('p1', { pctComplete: 60 })]));
    expect(d.ops[0].lineId).toBe('p1');
  });

  test('it is named from `phase`, not the raw id', () => {
    const d = LW._diffEntry(entry([P('p1')], [P('p1', { pctComplete: 60 })]));
    expect(d.ops[0].label).toBe('Framing');
    expect(d.ops[0].label).not.toMatch(/^p1$/);
  });

  test('camelCase is humanised — "% complete", not "pctComplete"', () => {
    const d = LW._diffEntry(entry([P('p1')], [P('p1', { pctComplete: 60 })]));
    expect(d.ops[0].detail).toContain('% complete 40% → 60%');
    expect(d.ops[0].detail).not.toContain('pctComplete');
  });

  test('ONE op per phase, not one per field', () => {
    // Three fields move on one phase. The flash merges on kind + lineId, so
    // three ops would collapse to one paint and only inflate the strip count.
    const d = LW._diffEntry(entry(
      [P('p1')],
      [P('p1', { pctComplete: 60, materials: 500, labor: 250 })]
    ));
    expect(d.ops.length).toBe(1);
    expect(d.ops[0].detail).toContain('materials');
    expect(d.ops[0].detail).toContain('labor');
  });

  test('two phases moving yields two ops, each addressed to its own row', () => {
    const d = LW._diffEntry(entry(
      [P('p1'), P('p2', { phase: 'Stucco' })],
      [P('p1', { pctComplete: 60 }), P('p2', { phase: 'Stucco', pctComplete: 75 })]
    ));
    expect(d.ops.length).toBe(2);
    expect(d.ops.map(o => o.lineId).sort()).toEqual(['p1', 'p2']);
    expect(d.ops.map(o => o.label).sort()).toEqual(['Framing', 'Stucco']);
  });
});

describe('money, and the three-field mirror', () => {
  // phaseRevenue is a TRUTHY chain: asSoldRevenue || asSoldPhaseBudget ||
  // phaseBudget. Because the read stops at the first non-zero, a write can
  // change the stored bytes and move no money at all.
  test('revenue is reported ONCE, derived, when it actually moves', () => {
    const d = LW._diffEntry(entry(
      [P('p1', { phaseBudget: 10000 })],
      [P('p1', { phaseBudget: 12000 })]
    ));
    expect(d.ops[0].detail).toContain('revenue');
    expect(d.ops[0].amount).toBe(2000);
    expect(d.impact).toBe(2000);
  });

  test('THE MIRROR TRAP: a budget field moves but revenue does NOT — no money line', () => {
    // asSoldRevenue is non-zero, so the truthy chain never reaches
    // asSoldPhaseBudget. Moving it changes bytes and moves zero money.
    // Printing a field delta here would be true AND financially false.
    const before = P('p1', { asSoldRevenue: 7500, asSoldPhaseBudget: 4250 });
    const after  = P('p1', { asSoldRevenue: 7500, asSoldPhaseBudget: 9999 });
    const d = LW._diffEntry(entry([before], [after]));
    expect(d.ops.length).toBe(1);                       // still reported
    expect(d.ops[0].detail).toMatch(/revenue unchanged/);
    expect(d.ops[0].detail).not.toMatch(/revenue \$/);  // no money delta claimed
    expect(d.ops[0].amount).toBeNull();
    expect(d.impact).toBe(0);
  });

  test('a mirror write that DOES move the chain reports the real delta', () => {
    // asSoldRevenue is the first link, so moving it moves the money.
    const d = LW._diffEntry(entry(
      [P('p1', { asSoldRevenue: 4250, asSoldPhaseBudget: 4250 })],
      [P('p1', { asSoldRevenue: 7500, asSoldPhaseBudget: 4250 })]
    ));
    expect(d.ops[0].amount).toBe(3250);                 // the Oak Bridge number
  });
});

describe('adds, deletes, and not stealing other writes', () => {
  test('a new phase is an add and carries its revenue', () => {
    const d = LW._diffEntry(entry([P('p1')], [P('p1'), P('p2', { phase: 'Paint', phaseBudget: 5000 })]));
    const add = d.ops.find(o => o.kind === 'add');
    expect(add.lineId).toBe('p2');
    expect(add.label).toBe('Paint');
    expect(d.impact).toBe(5000);
  });

  test('a removed phase is a delete and subtracts', () => {
    const d = LW._diffEntry(entry([P('p1'), P('p2', { phase: 'Paint', phaseBudget: 5000 })], [P('p1')]));
    const del = d.ops.find(o => o.kind === 'delete');
    expect(del.lineId).toBe('p2');
    expect(d.impact).toBe(-5000);
  });

  test('SECOND REGRESSION: a field-only job write is listable too', () => {
    // Found by this very test while building the phase fix. The jobs table is
    // `id + data JSONB` plus a few FK columns, so status / title /
    // contractAmount all live INSIDE data — and scalarFieldOps SKIPs data
    // wholesale. So an ordinary job edit reported as nothing either. Fixing
    // only phases would have left this one standing.
    const d = LW._diffEntry({
      entity_type: 'job', id: 'j1',
      before: job([P('p1')], { status: 'active' }),
      after:  job([P('p1')], { status: 'complete' })
    });
    expect(d.ops.length).toBeGreaterThan(0);
    expect(d.ops[0].detail).toContain('active → complete');
    // A job field has no row on the page, so it is correctly
    // reportable-but-not-paintable: no lineId means surface C declines it.
    expect(d.ops.every(o => !o.lineId)).toBe(true);
  });

  test('money-ish job fields are formatted as money', () => {
    const d = LW._diffEntry({
      entity_type: 'job', id: 'j1',
      before: job([P('p1')], { contractAmount: 250000 }),
      after:  job([P('p1')], { contractAmount: 275000 })
    });
    expect(d.ops[0].detail).toMatch(/\$250,000.*\$275,000/);
  });

  test('a phase AND a field moving reports both, and only the phase is paintable', () => {
    const d = LW._diffEntry({
      entity_type: 'job', id: 'j1',
      before: job([P('p1')], { status: 'active' }),
      after:  job([P('p1', { pctComplete: 90 })], { status: 'complete' })
    });
    const paintable = d.ops.filter(o => o.lineId);
    expect(paintable.length).toBe(1);
    expect(paintable[0].lineId).toBe('p1');
    expect(d.ops.length).toBeGreaterThan(1);           // the field op is there too
  });

  test('a job snapshot with no phases array at all is left to the field differ', () => {
    const d = LW._diffEntry({
      entity_type: 'job', id: 'j1',
      before: { id: 'j1', data: { title: 'Harbor Point', status: 'active' } },
      after:  { id: 'j1', data: { title: 'Harbor Point', status: 'complete' } }
    });
    expect(d.ops.every(o => !o.lineId)).toBe(true);
  });

  test('an estimate is untouched by any of this', () => {
    const d = LW._diffEntry({
      entity_type: 'estimate', id: 'e1',
      before: { id: 'e1', title: 'E', data: { lines: [{ id: 'l1', description: 'X', qty: 1, unitCost: 10 }] } },
      after:  { id: 'e1', title: 'E', data: { lines: [{ id: 'l1', description: 'X', qty: 2, unitCost: 10 }] } }
    });
    expect(d.entity_type).toBe('estimate');
  });
});
