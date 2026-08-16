/**
 * @jest-environment jsdom
 */
// The ONE Live Writer engine: the differ, the estimate row model, the
// ingest/dedupe seam, and the surface registry that lets the Cowork page (A),
// the docked notification (B) and the in-editor flash (C) coexist.
//
// The registry is the part worth pinning hardest. Before it, "payload
// ingested" and "payload rendered by the one chosen host" were the same flag,
// so the FIRST consumer to see a write locked every other one out — which is
// precisely why a second surface could not be built without forking the
// differ.

// Fake timers BEFORE the module loads: it installs a 5s poll interval on
// load, and a live interval would outlive the test file.
jest.useFakeTimers();

let LW;

beforeAll(() => {
  // initPoll fetches on load. Hand it an empty, well-formed feed so it takes
  // the success path (baseline established, nothing replayed) instead of the
  // retry path.
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: [] }) })
  );
  global.localStorage = { getItem: () => null, setItem: () => {} };
  require('../js/live-writer.js');
  LW = window.p86LiveWriter;
});

// ── fixtures ────────────────────────────────────────────────────────────────
function est(lines, extra) {
  return Object.assign({ id: 'est_1', title: 'Fairways B4', data: { lines: lines } }, extra || {});
}
const L = (id, desc, qty, unitCost, unit) => ({ id, description: desc, qty, unitCost, unit: unit || 'ea' });

describe('diff() — the one differ', () => {
  test('adds, edits and deletes each become an op carrying its lineId', () => {
    const before = est([L('l1', 'Framing', 10, 100), L('l2', 'Drywall', 5, 50)]);
    const after = est([L('l1', 'Framing', 12, 100), L('l3', 'Paint', 2, 25)]);
    const groups = LW.diff([{ entity_type: 'estimate', id: 'est_1', before, after }]);

    expect(groups).toHaveLength(1);
    const byKind = {};
    groups[0].ops.forEach((o) => { (byKind[o.kind] = byKind[o.kind] || []).push(o); });

    expect(byKind.delete.map((o) => o.lineId)).toEqual(['l2']);
    expect(byKind.add.map((o) => o.lineId)).toEqual(['l3']);
    expect(byKind.edit.map((o) => o.lineId)).toEqual(['l1']);
    // lineId is the ONLY thing surface C needs from the engine. Without it,
    // C would have to re-derive the diff — a second differ.
    groups[0].ops.forEach((o) => expect(o.lineId).toBeTruthy());
  });

  test('cost impact is a signed DELTA, never a total', () => {
    const before = est([L('l1', 'Framing', 10, 100)]);            // 1000
    const after = est([L('l1', 'Framing', 12, 100), L('l2', 'Paint', 2, 25)]); // 1200 + 50
    const groups = LW.diff([{ entity_type: 'estimate', id: 'est_1', before, after }]);
    // +200 from the edit, +50 from the add. NOT 1250.
    expect(groups[0].impact).toBe(250);
  });

  test('deleting a line drives impact negative', () => {
    const before = est([L('l1', 'Framing', 10, 100), L('l2', 'Paint', 2, 25)]);
    const after = est([L('l1', 'Framing', 10, 100)]);
    const groups = LW.diff([{ entity_type: 'estimate', id: 'est_1', before, after }]);
    expect(groups[0].impact).toBe(-50);
  });

  // The 2026-08-09 live defect: a payload titled "Convert Estimate … to Job"
  // whose only op was {status:'sold'} produced ZERO ops, so the group was
  // dropped and the agent-authored TITLE became the whole story — and the
  // title was wrong. A card must describe its ops.
  test('a scalar-only estimate change still produces an op', () => {
    const before = est([L('l1', 'Framing', 10, 100)], { status: 'draft' });
    const after = est([L('l1', 'Framing', 10, 100)], { status: 'sold' });
    const groups = LW.diff([{ entity_type: 'estimate', id: 'est_1', before, after }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].ops.some((o) => /status/.test(o.label) && /draft→sold/.test(o.detail))).toBe(true);
  });

  // FOUND LIVE, 2026-08-16, on applied payload pl_1786915643428_q82xitei.
  // The Scribe set the Base group's scope-of-work. The dispatcher recorded a
  // perfectly good apply_changeset (one estimate entry, 17 lines before and
  // 17 after) — and every Live Writer surface rendered NOTHING, because
  // scalarFieldOps skips `data` wholesale and no line had moved. The page
  // then told the user "this write type doesn't record a before/after diff",
  // which was flatly untrue: it recorded one, we just couldn't read it.
  test('a scope change nested inside data.groups[] is an op, not a silence', () => {
    const withScope = (scope) => est([L('l1', 'Framing', 10, 100)]);
    const before = withScope();
    const after = withScope();
    before.data.groups = [{ id: 'g1', name: 'Base', scope: '' }];
    after.data.groups = [{ id: 'g1', name: 'Base', scope: 'Furnish and install dumpster pad.' }];

    const groups = LW.diff([{ entity_type: 'estimate', id: 'est_1', before, after }]);
    expect(groups).toHaveLength(1);
    const op = groups[0].ops.find((o) => /Base/.test(o.label) && /scope/.test(o.label));
    expect(op).toBeTruthy();
    expect(op.detail).toContain('Furnish and install dumpster pad.');
    // A scope edit is not money. Emitting an amount here would put a second
    // number on screen next to the impact delta.
    expect(op.amount).toBeNull();
    expect(groups[0].impact).toBe(0);
  });

  test('nested-data ops strip html and truncate rather than dumping a document', () => {
    const before = est([L('l1', 'Framing', 10, 100)]);
    const after = est([L('l1', 'Framing', 10, 100)]);
    before.data.groups = [{ id: 'g1', name: 'Base', scope: '' }];
    after.data.groups = [{ id: 'g1', name: 'Base', scope: '<p>' + 'x'.repeat(400) + '</p>' }];
    const op = LW.diff([{ entity_type: 'estimate', id: 'est_1', before, after }])[0].ops[0];
    expect(op.detail).not.toContain('<p>');
    expect(op.detail.length).toBeLessThan(120);
  });

  test('line items are NOT double-reported by the nested-data walk', () => {
    const before = est([L('l1', 'Framing', 10, 100)]);
    const after = est([L('l1', 'Framing', 12, 100)]);
    const ops = LW.diff([{ entity_type: 'estimate', id: 'est_1', before, after }])[0].ops;
    expect(ops).toHaveLength(1);
    expect(ops[0].lineId).toBe('l1');
  });

  test('non-estimate creates and deletes are framed as such', () => {
    const created = LW.diff([{ entity_type: 'lead', id: 'ld1', before: null, after: { id: 'ld1', title: 'Oak Bridge' } }]);
    expect(created[0].ops[0].kind).toBe('add');
    const removed = LW.diff([{ entity_type: 'lead', id: 'ld1', before: { id: 'ld1', title: 'Oak Bridge' }, after: null }]);
    expect(removed[0].ops[0].kind).toBe('delete');
  });

  test('a changeset with no real change yields no groups', () => {
    const same = est([L('l1', 'Framing', 10, 100)]);
    expect(LW.diff([{ entity_type: 'estimate', id: 'est_1', before: same, after: same }])).toHaveLength(0);
  });
});

describe('rows() — the one estimate row model', () => {
  test('classifies sections, adds, edits, untouched rows and deletes', () => {
    const before = est([
      { id: 's1', section: '__section_header__', description: 'Rough' },
      L('l1', 'Framing', 10, 100), L('l2', 'Drywall', 5, 50)
    ]);
    const after = est([
      { id: 's1', section: '__section_header__', description: 'Rough' },
      L('l1', 'Framing', 10, 120), L('l3', 'Paint', 2, 25)
    ]);
    const model = LW.rows({ entity_type: 'estimate', id: 'est_1', before, after });

    expect(model.name).toBe('Fairways B4');
    expect(model.rows.map((r) => r.kind)).toEqual(['section', 'edit', 'add']);
    // the unit-cost was→now pair the pane and the Cowork document both render
    expect(model.rows[1].unitCostWas).toBe(100);
    expect(model.rows[1].unitCost).toBe(120);
    expect(model.rows[2].unitCostWas).toBeNull();
    expect(model.deletes.map((d) => d.lineId)).toEqual(['l2']);
  });

  test('an unchanged line is "same" so it never animates', () => {
    const before = est([L('l1', 'Framing', 10, 100)]);
    const after = est([L('l1', 'Framing', 10, 100), L('l2', 'Paint', 1, 10)]);
    const model = LW.rows({ entity_type: 'estimate', id: 'est_1', before, after });
    expect(model.rows[0].kind).toBe('same');
    expect(model.rows[1].kind).toBe('add');
  });
});

describe('the surface registry — how A, B and C coexist', () => {
  let calls;
  const cs = (n) => [{
    entity_type: 'estimate', id: 'est_' + n,
    before: est([L('l1', 'Framing', 10, 100)]),
    after: est([L('l1', 'Framing', 10, 100), L('l2', 'Paint', 1, 10)])
  }];

  beforeEach(() => { calls = []; });

  function spy(name, opts) {
    return LW.registerSurface(Object.assign({
      name: name, exclusive: true, claims: () => true,
      render: (e) => calls.push([name, e.meta.state])
    }, opts || {}));
  }

  test('an exclusive surface that claims blocks the lower-priority one', () => {
    const offA = spy('t-cowork', { order: 20, claims: () => true });
    const offB = spy('t-strip', { order: 40, claims: () => true });
    LW.ingest(cs(1), { payloadId: 'p1', state: 'applied' });
    expect(calls.map((c) => c[0])).toEqual(['t-cowork']);
    offA(); offB();
  });

  test('when the higher-priority surface does not claim, the fallback renders', () => {
    const offA = spy('t-cowork', { order: 20, claims: () => false });
    const offB = spy('t-strip', { order: 40, claims: () => true });
    LW.ingest(cs(2), { payloadId: 'p2', state: 'applied' });
    expect(calls.map((c) => c[0])).toEqual(['t-strip']);
    offA(); offB();
  });

  test('a NON-exclusive surface renders alongside the exclusive winner', () => {
    const offC = spy('t-editor', { order: 10, exclusive: false, claims: () => true });
    const offA = spy('t-cowork', { order: 20, claims: () => true });
    const offB = spy('t-strip', { order: 40, claims: () => true });
    LW.ingest(cs(3), { payloadId: 'p3', state: 'applied' });
    expect(calls.map((c) => c[0])).toEqual(['t-editor', 't-cowork']);
    offC(); offA(); offB();
  });

  test('one surface throwing does not stop the others', () => {
    const offBad = LW.registerSurface({
      name: 't-bad', order: 5, exclusive: false, claims: () => true,
      render: () => { throw new Error('boom'); }
    });
    const offB = spy('t-strip', { order: 40 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    LW.ingest(cs(4), { payloadId: 'p4', state: 'applied' });
    expect(calls.map((c) => c[0])).toEqual(['t-strip']);
    warn.mockRestore();
    offBad(); offB();
  });
});

describe('ingest() — dedupe is per STATE, not per payload', () => {
  let calls;
  const cs = [{
    entity_type: 'estimate', id: 'est_9',
    before: est([L('l1', 'Framing', 10, 100)]),
    after: est([L('l1', 'Framing', 10, 100), L('l2', 'Paint', 1, 10)])
  }];
  let off;
  beforeEach(() => {
    calls = [];
    off = LW.registerSurface({
      name: 't-dedupe', order: 30, exclusive: true, claims: () => true,
      render: (e) => calls.push(e.meta.state)
    });
  });
  afterEach(() => off());

  // The poller and the client apply event both see the same commit. They must
  // not double-render it.
  test('the same payload in the same state renders exactly once', () => {
    expect(LW.ingest(cs, { payloadId: 'dupe1', state: 'applied' })).toBeTruthy();
    expect(LW.ingest(cs, { payloadId: 'dupe1', state: 'applied' })).toBeNull();
    expect(calls).toEqual(['applied']);
  });

  // But proposed → applied is a real transition and a real thing to show.
  // Keying dedupe on the payload id alone would have swallowed the apply.
  test('the same payload in a NEW state renders again', () => {
    LW.ingest(cs, { payloadId: 'dupe2', state: 'proposed' });
    LW.ingest(cs, { payloadId: 'dupe2', state: 'applying' });
    LW.ingest(cs, { payloadId: 'dupe2', state: 'applied' });
    expect(calls).toEqual(['proposed', 'applying', 'applied']);
  });
});

describe('states that used to render as silence', () => {
  let seen;
  let off;
  beforeEach(() => {
    seen = [];
    off = LW.registerSurface({
      name: 't-states', order: 30, exclusive: true, claims: () => true,
      render: (e) => seen.push(e.meta)
    });
  });
  afterEach(() => off());

  test('a proposal is flagged isDraft so no surface can render it as a document', () => {
    const entry = LW.ingest([{
      entity_type: 'estimate', id: 'est_5',
      before: est([L('l1', 'Framing', 10, 100)]),
      after: est([L('l1', 'Framing', 10, 100), L('l2', 'Paint', 1, 10)])
    }], { payloadId: 'draft1', state: 'proposed' });
    expect(entry.meta.isDraft).toBe(true);
    expect(seen[0].state).toBe('proposed');
  });

  test('a failed write carries its apply_error rather than vanishing', () => {
    const entry = LW.ingest([], {
      payloadId: 'fail1', state: 'failed', title: 'Add framing',
      applyError: 'Unresolved ref $new_id:line_2'
    });
    expect(entry.meta.state).toBe('failed');
    expect(entry.meta.applyError).toBe('Unresolved ref $new_id:line_2');
    expect(seen[0].applyError).toBe('Unresolved ref $new_id:line_2');
  });

  // schedule / system / assembly / deal_memory have no snapshot table in the
  // dispatcher, so the changeset is genuinely empty. The entry must still
  // exist and still reach the surfaces, which say so out loud — rendering
  // nothing reads as "the agent did nothing".
  test('a write with no recordable diff still produces an entry', () => {
    const entry = LW.ingest([], {
      payloadId: 'nodiff1', state: 'applied', title: 'Move Tuesday inspection',
      summary: 'Rescheduled 1 event'
    });
    expect(entry).toBeTruthy();
    expect(entry.groups).toHaveLength(0);
    expect(entry.meta.summary).toBe('Rescheduled 1 event');
    expect(seen[0].title).toBe('Move Tuesday inspection');
  });

  test('meta threads attribution and timing through to every surface', () => {
    LW.ingest([{
      entity_type: 'estimate', id: 'est_7',
      before: est([L('l1', 'Framing', 10, 100)]),
      after: est([L('l1', 'Framing', 11, 100)])
    }], {
      payloadId: 'meta1', state: 'applied', title: 'Bump framing qty',
      emittingAgentKey: 'scribe', appliedAt: '2026-08-16T12:00:00Z'
    });
    expect(seen[0].emittingAgentKey).toBe('scribe');
    expect(seen[0].appliedAt).toBe('2026-08-16T12:00:00Z');
    expect(seen[0].entityType).toBe('estimate');
    expect(seen[0].entityId).toBe('est_7');
  });
});
