/**
 * @jest-environment jsdom
 */
// The viewer registry — "is the user looking at the record this write touched?"
//
// That question used to be one hardcoded lookup about one editor
// (getElementById('estimate-editor-view') + a global only the estimate editor
// defines), so every other page a write can land on was structurally unable to
// show the write ON the record.
//
// The generalisation exposed a hazard that was unreachable before it: claiming
// and painting are two different things. diffEntry produces row-addressable ops
// (o.lineId) ONLY for estimates — every other entity type goes through
// diffFields, which has no lineId at all. So a viewer can find its record open,
// claim the write, and have nothing to paint — and because surface B's copy
// steps down when C claims ("the strip took the op list because C took the
// document"), the write would then be reported by nobody. These tests pin the
// rule that closes it: CLAIM ONLY WHAT CAN BE PAINTED.

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

const L = (id, desc, qty, unitCost) => ({ id, description: desc, qty, unitCost, unit: 'ea' });
const doc = (id, lines) => ({ id, title: 'Fairways B4', data: { lines } });

// l1 edited (qty 10→12), l2 added.
const csFor = (entityType, id) => [{
  entity_type: entityType, id,
  before: doc(id, [L('l1', 'Framing', 10, 100)]),
  after: doc(id, [L('l1', 'Framing', 12, 100), L('l2', 'Paint', 1, 10)])
}];

// Mount a root and point a viewer at it. Deliberately uses an id that is NOT
// 'estimate-editor-view': if the engine were still reaching for that element
// directly, every painting test below would fail.
function mountViewer(entityType, openId, rootId) {
  rootId = rootId || 'some-other-editor';
  document.body.innerHTML =
    '<div id="' + rootId + '">' +
      '<div data-line-id="l1"></div><div data-line-id="l2"></div>' +
    '</div>' +
    '<div id="elsewhere"><div data-line-id="l1"></div></div>';
  LW.registerViewer({
    entityType: entityType,
    currentId: () => openId,
    root: () => document.getElementById(rootId)
  });
  return document.getElementById(rootId);
}

afterEach(() => {
  LW.dismiss();
  LW.flashViewerRows();                  // drain anything left pending
  document.body.innerHTML = '';
  jest.clearAllTimers();
});

describe('claim only what can be painted', () => {
  test('a viewer whose entity type yields NO row-addressable ops does not claim', () => {
    // change_order goes through diffFields — field ops, no lineId. The record
    // is open and the viewer is registered, and it still must not claim.
    mountViewer('change_order', 'co_1');
    const entry = LW.ingest(csFor('change_order', 'co_1'), { payloadId: 'v1', state: 'applied' });
    expect(entry.claimedBy).not.toContain('editor-flash');
    // …and the write is still reported, by the strip.
    expect(document.getElementById('p86-live-writer')).not.toBeNull();
  });

  test('an estimate viewer on the open estimate DOES claim', () => {
    mountViewer('estimate', 'est_1');
    const entry = LW.ingest(csFor('estimate', 'est_1'), { payloadId: 'v2', state: 'applied' });
    expect(entry.claimedBy).toContain('editor-flash');
  });

  test('a different record of the same type is not claimed', () => {
    mountViewer('estimate', 'est_other');
    const entry = LW.ingest(csFor('estimate', 'est_2'), { payloadId: 'v3', state: 'applied' });
    expect(entry.claimedBy).not.toContain('editor-flash');
    expect(document.getElementById('p86-live-writer')).not.toBeNull();
  });

  test('an entity type with no registered viewer is left to the strip', () => {
    document.body.innerHTML = '';
    const entry = LW.ingest(csFor('purchase_order', 'po_1'), { payloadId: 'v4', state: 'applied' });
    expect(entry.claimedBy).not.toContain('editor-flash');
    expect(document.getElementById('p86-live-writer')).not.toBeNull();
  });
});

describe('the registry refuses to make things worse', () => {
  test('re-registering an entity type REPLACES, it does not stack', () => {
    mountViewer('estimate', 'est_a', 'view-a');
    // Same type, now closed. A surviving first registration would still claim
    // est_a and then paint into a root that is gone.
    LW.registerViewer({ entityType: 'estimate', currentId: () => null, root: () => null });
    const entry = LW.ingest(csFor('estimate', 'est_a'), { payloadId: 'v5', state: 'applied' });
    expect(entry.claimedBy).not.toContain('editor-flash');
  });

  test('a viewer whose currentId() THROWS is treated as closed, not as a crash', () => {
    document.body.innerHTML = '<div id="boom"></div>';
    LW.registerViewer({
      entityType: 'estimate',
      currentId: () => { throw new Error('editor mid-teardown'); },
      root: () => document.getElementById('boom')
    });
    let entry;
    expect(() => {
      entry = LW.ingest(csFor('estimate', 'est_b'), { payloadId: 'v6', state: 'applied' });
    }).not.toThrow();
    expect(entry.claimedBy).not.toContain('editor-flash');
    // A broken editor must not take the report away from the strip.
    expect(document.getElementById('p86-live-writer')).not.toBeNull();
  });

  test('a malformed registration is ignored rather than half-registered', () => {
    expect(() => {
      LW.registerViewer(null);
      LW.registerViewer({});
      LW.registerViewer({ entityType: 'x' });          // no currentId
    }).not.toThrow();
  });
});

describe('painting is scoped to the viewer that claimed', () => {
  test('rows inside the viewer are decorated; an identical row elsewhere is not', () => {
    const root = mountViewer('estimate', 'est_3');
    LW.ingest(csFor('estimate', 'est_3'), { payloadId: 'v7', state: 'applied' });

    expect(LW.flashViewerRows('estimate', 'est_3')).toBeGreaterThan(0);
    // Ops run deletes → adds → edits and are staggered, so only the ADDED row
    // is painted synchronously; the edited one lands a stagger later. Advance
    // past the stagger but well under the 1800ms that removes the class again.
    jest.advanceTimersByTime(600);

    const inside = root.querySelector('[data-line-id="l1"]');
    const outside = document.querySelector('#elsewhere [data-line-id="l1"]');
    expect(inside.className).toMatch(/p86lw-flash-/);
    // THE POINT: a bare document.querySelector would have matched this one.
    expect(outside.className).toBe('');
  });

  test('one viewer cannot drain another viewer\'s pending flash', () => {
    mountViewer('estimate', 'est_4');
    LW.ingest(csFor('estimate', 'est_4'), { payloadId: 'v8', state: 'applied' });
    // A change-order repaint must not consume an estimate's pending flash.
    expect(LW.flashViewerRows('change_order', 'est_4')).toBe(0);
    // …and the rightful owner still gets it.
    expect(LW.flashViewerRows('estimate', 'est_4')).toBeGreaterThan(0);
  });

  test('flashEditorRows still works — the estimate call site is unchanged', () => {
    expect(typeof LW.flashEditorRows).toBe('function');
    expect(LW.flashEditorRows('nothing-pending')).toBe(0);
  });
});
