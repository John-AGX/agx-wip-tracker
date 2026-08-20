// GATE 0 — the plan document survives the save/load round trip.
//
// Every CAD sheet drawing in the product is persisted by exactly one chain:
//
//   editor doc --serializeDoc--> wire --sanitizePages--> plans.pages (JSONB)
//   plans.pages --loadDoc(toV2->toV3->healDoc)--> editor doc
//
// Nothing tested it. js/sheet-editor.js has exported its migration internals
// as `_v3` since the v3 migration landed, with the comment "exposed for
// round-trip verification", and no caller ever appeared. Meanwhile the chain
// was silently emptying every sheet drawing on reload:
//
//   sanitizePages synthesized `entities: []` / `layers: []` onto every stored
//   v2/v3 doc (serializeDoc deletes those flat aliases before sending), and
//   toV2's broken-alias rescue then adopted the empty array over the real
//   geometry in model.*. The row on disk was fine. The loader threw it away,
//   and the next autosave wrote the emptied document back over it.
//
// ── Why this suite asserts COUNTS and not a fixed point ─────────────────
// The obvious shape for this test — "loadDoc -> serializeDoc -> sanitize ->
// loadDoc is deep-equal" — is GREEN on the bug. A lossy pipeline is stable at
// its fixed point, and the fixed point here is the empty document: load a
// gutted row, get zero entities, round-trip zero entities, deep-equal passes.
// So every assertion below starts from an in-memory document that HAS content
// and asserts the content is still there, by count and by value.
//
// `test/should-fail/plan-doc-roundtrip.red.js` re-runs the core cases against
// the two pre-fix lines so the gate is provably load-bearing.

'use strict';

const H = require('./helpers/sheet-doc-harness');
const { sanitizePages, inspectPages } = require('../server/services/plan-doc');

const { V, loadDoc, serialize, clone, freshDoc } = H;

// One full trip through the wire and the database, as the product does it.
function roundTrip(doc) {
  const pages = sanitizePages([serialize(doc)]);
  return { stored: pages, doc: loadDoc({ pages }) };
}

// ── Fixtures: the real shapes the editor produces ───────────────────────
function mk(doc, over) {
  const vp = doc.viewports[0].id;
  return Object.assign({
    layer: 'L0', viewport: vp, color: '#1f2937', lineWidth: 3, lineType: 'solid'
  }, over);
}

function populate(doc) {
  const P = (o) => mk(doc, o);
  doc.entities.push(
    // straight geometry
    P({ id: 'E_line', tool: 'line', startX: 1.5, startY: 2.25, endX: 40.125, endY: 2.25 }),
    P({ id: 'E_rect', tool: 'rect', x: 10, y: 10, w: 24.5, h: 8.75 }),
    P({ id: 'E_circle', tool: 'circle', x: 60, y: 30, r: 6.375 }),
    // point-list geometry (polyline / arc / cloud) — the shapes a naive
    // field-level merge would mangle
    P({ id: 'E_poly', tool: 'polyline', points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 9 }, { x: 0, y: 9 }], closed: true }),
    P({ id: 'E_arc', tool: 'arc', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }] }),
    // annotation
    P({ id: 'E_text', tool: 'text', x: 5, y: 50, text: 'ROOM 101 — 12\'-6" CLR', size: 12, rot: 0 }),
    P({ id: 'E_leader', tool: 'leader', points: [{ x: 1, y: 1 }, { x: 6, y: 8 }], text: 'TYP. OF 4' }),
    // measurement geometry — the entities a takeoff is priced from
    P({ id: 'E_dim', tool: 'dim', layer: 'L_DIM', startX: 0, startY: 0, endX: 30, endY: 0, off: 3, label: "30'-0\"" }),
    P({ id: 'E_angle', tool: 'angle', points: [{ x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 }], label: '90°' }),
    P({ id: 'E_dimrad', tool: 'dimradius', x: 60, y: 30, r: 6.375, label: 'R 6 3/8"' }),
    // fills + symbols
    P({ id: 'E_hatch', tool: 'hatch', points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }], pattern: 'diagonal', spacing: 0.25 }),
    P({ id: 'E_symbol', tool: 'symbol', x: 20, y: 20, name: 'NORTH', size: 2 }),
    // a block insert + an assembly-bound entity (the priced takeoff link)
    P({ id: 'E_insert', tool: 'insert', name: 'DOOR-3068', x: 44, y: 12, rot: 90, sx: 1, sy: 1 }),
    P({ id: 'E_asm', tool: 'polyline', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
        assembly: { id: 'asm_wall_2x4', name: '2x4 Wall', unit: 'LF', mode: 'rollup', params: { height: 9 } } })
  );
  doc.layers.push(
    { id: 'L_DIM', name: 'Dimensions', color: '#f59e0b', weight: 2, lineType: 'solid', visible: true, locked: false },
    { id: 'L_HID', name: 'Hidden', color: '#94a3b8', weight: 2, lineType: 'dashed', visible: false, locked: true },
    { id: 'L_XREF', name: 'XREF-BASE', color: '#64748b', weight: 1, lineType: 'solid', visible: true, locked: true }
  );
  doc.blocks = [
    { id: 'B_door', name: 'DOOR-3068', base: { x: 0, y: 0 }, entities: [
      P({ id: 'BE_1', tool: 'line', startX: 0, startY: 0, endX: 3, endY: 0 }),
      P({ id: 'BE_2', tool: 'arc', points: [{ x: 3, y: 0 }, { x: 2.1, y: 2.1 }, { x: 0, y: 3 }] })
    ] }
  ];
  doc.underlay = { viewport: doc.viewports[0].id, attachmentId: 'att_9', x: 2, y: 3, w: 120.5, h: 80.25, opacity: 0.4 };
  doc.titleblock = Object.assign(doc.titleblock || {}, {
    project: 'Maple St. Addition', sheetNo: 'A-101', scale: '1/4" = 1\'-0"',
    generalNotes: '1. All dimensions to be field-verified.'
  });
  return doc;
}

// DXF import produces many short polylines on named layers — the awkward
// bulk case, and the one where a per-object cap bites first.
function dxfImported(doc, n) {
  const P = (o) => mk(doc, o);
  for (let i = 0; i < n; i++) {
    doc.entities.push(P({
      id: 'DXF_' + i, tool: 'polyline', layer: 'L_XREF', lineWidth: 1,
      points: [{ x: i * 0.5, y: 0 }, { x: i * 0.5, y: 10 }, { x: i * 0.5 + 0.5, y: 10 }]
    }));
  }
  return doc;
}

// ═══════════════════════════════════════════════════════════════════════
describe('Gate 0 — sheet document round trip', () => {

  test('the harness runs the real shipped editor, not a copy', () => {
    expect(Object.keys(H.SE._v3).sort())
      .toEqual(['healDoc', 'mToP', 'pToM', 'serializeDoc', 'toV2', 'toV3']);
  });

  test('a full drawing survives the save/load round trip by count', () => {
    const doc = populate(freshDoc());
    const before = {
      entities: doc.entities.length, layers: doc.layers.length,
      blocks: doc.blocks.length, underlay: !!doc.underlay
    };
    expect(before.entities).toBe(14);

    const { doc: after } = roundTrip(doc);
    expect(after.entities.length).toBe(before.entities);
    expect(after.layers.length).toBe(before.layers);
    expect(after.blocks.length).toBe(before.blocks);
    expect(!!after.underlay).toBe(before.underlay);
    expect(after.entities.map((e) => e.id).sort()).toEqual(doc.entities.map((e) => e.id).sort());
    expect(after.layers.map((l) => l.id).sort()).toEqual(doc.layers.map((l) => l.id).sort());
  });

  test('every entity is byte-identical after the round trip', () => {
    const doc = populate(freshDoc());
    const before = clone(doc.entities);
    const { doc: after } = roundTrip(doc);
    const byId = {};
    after.entities.forEach((e) => { byId[e.id] = e; });
    before.forEach((e) => {
      expect(byId[e.id]).toBeDefined();
      expect(byId[e.id]).toEqual(e);   // geometry, points[], labels, assembly binding
    });
  });

  test('the round trip is idempotent — repeated open/save never erodes', () => {
    let doc = populate(freshDoc());
    const first = clone(doc.entities);
    for (let i = 0; i < 5; i++) {
      doc = roundTrip(doc).doc;
      expect(doc.entities.length).toBe(14);
    }
    expect(clone(doc.entities)).toEqual(first);
  });

  test('measurement geometry keeps its exact numbers (a takeoff is priced off these)', () => {
    const doc = populate(freshDoc());
    const { doc: after } = roundTrip(doc);
    const dim = after.entities.find((e) => e.id === 'E_dim');
    expect(dim).toMatchObject({ tool: 'dim', startX: 0, startY: 0, endX: 30, endY: 0, off: 3, label: "30'-0\"" });
    const rad = after.entities.find((e) => e.id === 'E_dimrad');
    expect(rad.r).toBe(6.375);
    const asm = after.entities.find((e) => e.id === 'E_asm');
    expect(asm.assembly).toEqual({ id: 'asm_wall_2x4', name: '2x4 Wall', unit: 'LF', mode: 'rollup', params: { height: 9 } });
  });

  test('block definitions survive with their bodies intact', () => {
    const doc = populate(freshDoc());
    const { doc: after } = roundTrip(doc);
    expect(after.blocks).toHaveLength(1);
    expect(after.blocks[0].name).toBe('DOOR-3068');
    expect(after.blocks[0].entities.map((e) => e.id)).toEqual(['BE_1', 'BE_2']);
    expect(after.blocks[0].entities[1].points).toHaveLength(3);
    // the insert that references the block is still pointing at it
    expect(after.entities.find((e) => e.id === 'E_insert').name).toBe('DOOR-3068');
  });

  test('hidden and locked layer state survives (a lost lock silently unprotects an XREF)', () => {
    const doc = populate(freshDoc());
    const { doc: after } = roundTrip(doc);
    const hid = after.layers.find((l) => l.id === 'L_HID');
    expect(hid).toMatchObject({ visible: false, locked: true, lineType: 'dashed' });
    expect(after.layers.find((l) => l.id === 'L_XREF').locked).toBe(true);
  });

  test('the titleblock and the calibrated underlay rect survive', () => {
    const doc = populate(freshDoc());
    const { doc: after } = roundTrip(doc);
    expect(after.titleblock.sheetNo).toBe('A-101');
    expect(after.titleblock.scale).toBe('1/4" = 1\'-0"');
    expect(after.underlay).toMatchObject({ attachmentId: 'att_9', x: 2, y: 3, w: 120.5, h: 80.25, opacity: 0.4 });
  });

  test('a DXF-scale import (2000 entities) round-trips whole', () => {
    const doc = dxfImported(freshDoc(), 2000);
    expect(doc.entities.length).toBe(2000);
    const { doc: after } = roundTrip(doc);
    expect(after.entities.length).toBe(2000);
    expect(after.entities[1999].points).toHaveLength(3);
  });

  test('an empty drawing round-trips as an empty drawing (and keeps its default layer)', () => {
    const doc = freshDoc();
    expect(doc.entities).toHaveLength(0);
    const { doc: after } = roundTrip(doc);
    expect(after.entities).toHaveLength(0);
    expect(after.layers.length).toBeGreaterThanOrEqual(1);
    expect(after.viewports.length).toBeGreaterThanOrEqual(1);
  });

  test('viewport windows and scales survive — the model/paper mapping is the drawing', () => {
    const doc = populate(freshDoc());
    const vp0 = doc.viewports[0];
    vp0.window = { cx: 12.5, cy: -3.25 };
    vp0.scale = { pixelsPerInch: 2.5, unit: 'ft', label: '1/4" = 1\'-0"' };
    const { doc: after } = roundTrip(doc);
    expect(after.viewports[0].window).toEqual({ cx: 12.5, cy: -3.25 });
    expect(after.viewports[0].scale).toEqual({ pixelsPerInch: 2.5, unit: 'ft', label: '1/4" = 1\'-0"' });
  });

  test('multi-sheet documents keep every sheet and the active sheet', () => {
    const doc = populate(freshDoc());
    doc.sheets.push({ id: 'S2', name: 'A-102', size: doc.sheet.size, w: doc.sheet.w, h: doc.sheet.h,
      margin: doc.sheet.margin, titleblock: { sheetNo: 'A-102' },
      viewports: [{ id: 'VP_S2', label: 'DETAIL', x: 10, y: 10, w: 500, h: 400,
        scale: { pixelsPerInch: 10, unit: 'ft', label: '1" = 1\'-0"' }, window: { cx: 0, cy: 0 } }] });
    const { doc: after, stored } = roundTrip(doc);
    expect(stored[0].sheets).toHaveLength(2);
    expect(after.sheets.map((s) => s.id)).toEqual(['S1', 'S2']);
    expect(after.sheets[1].viewports[0].label).toBe('DETAIL');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('Gate 0 — the stored row is honest', () => {

  test('the sanitizer never synthesizes a key the client did not send', () => {
    const doc = populate(freshDoc());
    const wire = serialize(doc);
    // serializeDoc strips the flat aliases for v2+ docs; the row must not
    // grow them back. An empty `entities: []` here is the whole bug.
    expect(wire.entities).toBeUndefined();
    const stored = sanitizePages([wire])[0];
    expect(Object.prototype.hasOwnProperty.call(stored, 'entities')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(stored, 'layers')).toBe(false);
    expect(stored.model.entities).toHaveLength(14);
    expect(stored.model.layers).toHaveLength(freshDoc().layers.length + 3);
  });

  test('a v1 doc that really does carry flat arrays keeps them', () => {
    // v1 shape: no model, no sheets — the flat arrays ARE the drawing, and
    // serializeDoc deliberately declines to strip them.
    const v1 = {
      kind: 'sheet-doc', version: 1,
      sheet: { size: 'arch-d', w: 4320, h: 2880, margin: 60 },
      titleblock: { sheetNo: 'A-1' },
      layers: [{ id: 'L0', name: 'Default', color: '#1f2937', weight: 4, lineType: 'solid', visible: true, locked: false }],
      viewports: [{ id: 'VP1', label: 'PLAN', x: 60, y: 60, w: 4000, h: 2400, scale: { pixelsPerInch: 30, unit: 'ft' } }],
      entities: [{ id: 'V1_a', tool: 'line', layer: 'L0', viewport: 'VP1', startX: 0, startY: 0, endX: 100, endY: 0 }]
    };
    const stored = sanitizePages([clone(v1)])[0];
    expect(stored.entities).toHaveLength(1);
    expect(stored.layers).toHaveLength(1);
    const after = loadDoc({ pages: [stored] });
    expect(after.entities).toHaveLength(1);
    expect(after.entities[0].id).toBe('V1_a');
    // and it migrates forward without loss
    const trip = roundTrip(after);
    expect(trip.doc.entities).toHaveLength(1);
    expect(trip.doc.version).toBeGreaterThanOrEqual(2);
  });

  test('markup plan pages (blank/photo/pdf) are untouched by any of this', () => {
    const pages = [
      { page: 0, calibration: { ppu: 12.5, unit: 'ft' }, strokes: [{ id: 's1', kind: 'len', pts: [[0, 0], [10, 0]] }] },
      { page: 1, calibration: null, strokes: [] }
    ];
    expect(sanitizePages(clone(pages))).toEqual(pages);
  });

  test('size caps still hold', () => {
    const doc = dxfImported(freshDoc(), 3);
    const wire = serialize(doc);
    wire.model.entities = new Array(25000).fill(0).map((_, i) => ({ id: 'X' + i, tool: 'line' }));
    expect(sanitizePages([wire])[0].model.entities).toHaveLength(20000);
    const many = new Array(400).fill(0).map((_, i) => ({ id: 'B' + i, name: 'b', entities: [] }));
    expect(sanitizePages([Object.assign(serialize(doc), { blocks: many })])[0].blocks).toHaveLength(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('Gate 0 — recovery of rows already written by the bug', () => {

  // What is sitting in production: a good model.* next to a synthesized
  // empty flat alias. The geometry never left the row; the loader discarded it.
  function guttedRow() {
    const doc = populate(freshDoc());
    const wire = serialize(doc);
    return Object.assign({}, wire, { entities: [], layers: [], viewports: [], sheet: {}, titleblock: {} });
  }

  test('a gutted row still loads its drawing', () => {
    const row = guttedRow();
    expect(row.model.entities).toHaveLength(14);
    const after = loadDoc({ pages: [row] });
    expect(after.entities).toHaveLength(14);
    expect(after.layers).toHaveLength(freshDoc().layers.length + 3);
    expect(after.layers.find((l) => l.id === 'L_XREF').locked).toBe(true);
  });

  test('re-saving a recovered row writes the geometry back and drops the empty aliases', () => {
    const after = loadDoc({ pages: [guttedRow()] });
    const stored = sanitizePages([serialize(after)])[0];
    expect(stored.model.entities).toHaveLength(14);
    expect(Object.prototype.hasOwnProperty.call(stored, 'entities')).toBe(false);
    expect(loadDoc({ pages: [stored] }).entities).toHaveLength(14);
  });

  test('a POPULATED flat alias still wins — the rescue this guard sits inside still works', () => {
    // The original broken-alias bug: flat was the live data, model was stale.
    const doc = populate(freshDoc());
    const wire = serialize(doc);
    const broken = Object.assign({}, wire, {
      entities: [{ id: 'LIVE_1', tool: 'line', layer: 'L0', startX: 0, startY: 0, endX: 1, endY: 1 }]
    });
    broken.model = Object.assign({}, wire.model, { entities: [{ id: 'STALE_1', tool: 'line' }] });
    const after = loadDoc({ pages: [broken] });
    expect(after.entities.map((e) => e.id)).toEqual(['LIVE_1']);
  });

  test('inspectPages names a gutted row, and says whether it is recoverable', () => {
    const g = inspectPages([guttedRow()]);
    expect(g.gutted).toBe(true);
    expect(g.emptied).toBe(false);
    expect(g.modelEntities).toBe(14);
    expect(g.flatEntities).toBe(0);

    const healthy = inspectPages(sanitizePages([serialize(populate(freshDoc()))]));
    expect(healthy.gutted).toBe(false);
    expect(healthy.modelEntities).toBe(14);

    // a row that was already overwritten after a gutted load: nothing to recover
    const dead = inspectPages([Object.assign(guttedRow(), { model: { entities: [], layers: [] } })]);
    expect(dead.emptied).toBe(true);
  });

  test('inspectPages reports duplicate and missing entity ids', () => {
    const doc = populate(freshDoc());
    doc.entities.push(Object.assign(clone(doc.entities[0]), { id: 'E_line' }));
    doc.entities.push({ tool: 'line', startX: 0, startY: 0, endX: 1, endY: 1 });
    const rep = inspectPages(sanitizePages([serialize(doc)]));
    expect(rep.dupIds).toEqual(['E_line']);
    expect(rep.idless).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('Gate 0 — why this suite is shaped the way it is', () => {

  test('a fixed-point round-trip assertion is GREEN on an emptied document', () => {
    // Documented so nobody "simplifies" this suite back into the shape that
    // could not see the bug. loadDoc -> serialize -> sanitize -> loadDoc is
    // deep-equal for the empty document, because the empty document is the
    // fixed point a lossy pipeline settles on.
    const emptied = Object.assign(serialize(freshDoc()), { model: { entities: [], layers: [] } });
    const a = loadDoc({ pages: [emptied] });
    const b = loadDoc({ pages: sanitizePages([serialize(a)]) });
    expect(a.entities).toEqual(b.entities);
    expect(a.entities).toHaveLength(0);      // deep-equal, and worth nothing
  });
});
