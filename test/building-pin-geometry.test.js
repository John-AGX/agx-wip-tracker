/**
 * @jest-environment jsdom
 */
/* ═══════════════════════════════════════════════════════════════════════════
 * A DROPPED PIN IS BUILDING GEOMETRY, NOT A LESSER KIND OF NOTHING.
 *
 * John, 2026-10-04: "I want a way — how we have our trace to drop a pin. I want
 * to be able just to drop, instead of trace, on the building when I create a
 * building: just drop the pin on that building and have it locked to that. We
 * can also use the pins we have for the orbit 3D view as those default pins
 * instead of a building trace. We can use the building trace when I want to
 * divide the scope up by square feet and area."
 *
 * Almost all of this already existed and was unreachable:
 *
 *   - bldgMapState already answered 'poly' | 'pin' | 'none'.
 *   - bldgGeoFlag already had a 📍 state whose tooltip read "Pinned but not
 *     traced — draw its footprint for area-driven quantities", which is John's
 *     sentence written down months earlier.
 *   - The Buildings panel already told the user to "trace a footprint or drop
 *     a pin so costs and photos have a place to land."
 *   - setNodeGeo already wrote and persisted a bare {lat,lng}, and the server's
 *     footprint-wipe guard already counted it as real geometry.
 *   - renderNodes already positioned a geo-bound building through geoRenderPos
 *     and sized it with spBuildingFootprint.
 *   - setGeoPortAnchor already had a "placed-only" branch for exactly this.
 *
 * And then ONE line refused to paint it:
 *     if(sitePlan && _spSatellite && n.type==='t1' && !(n.polygon && …>=3)) return;
 * So the copy promised a pin and the renderer withheld it, the "placed-only"
 * branches were dead code, and there was no way to CREATE a building by pinning
 * it at all — toggleGeoPick refused unless a t1 was already selected.
 *
 * WHAT THIS FILE HOLDS, each clause failing on its own:
 *
 *   1. ONE PREDICATE. bldgGeom is the single answer to "is it on the map", it
 *      lives in the engine, and it is hostile-input safe. The five copies that
 *      used to disagree are gone.
 *   2. THE GATE ADMITS A PIN AND STILL REFUSES NOWHERE — driven on the literal
 *      source line, not a retyped model of it.
 *   3. PIN-TO-CREATE EXISTS AND MINTS NO WIRE. Trace-to-create still mints its
 *      wire, so the existing path is untouched.
 *   4. THE PIN IS LOCKED TO THE SPOT CLICKED. The block is centred on it, and
 *      the port anchor agrees with the renderer about where its centre is.
 *   5. THE 3D VIEW GETS THE PIN. A pinned building reaches the orbit feed with
 *      a pin and no path; a traced one still sends its ring.
 *   6. NO MONEY MOVES. Nothing in the rollup, allocation, WIP or G703 path
 *      reads a polygon or an area, so a building that has a pin instead of a
 *      footprint cannot change a dollar. Held by enumeration over server/ + js/.
 *
 * Functions are LIFTED OUT OF THE SHIPPED FILES, never modelled — a model of
 * buggy code is green for exactly as long as the bug is live.
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn.js');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const UI_SRC = read('nodegraph/ui.js');
const ENGINE_SRC = read('nodegraph/engine.js');
const ORBIT_SRC = read('orbit3d.html');

/* Pull ONE literal line out of a shipped file by a distinctive substring, so a
 * test that drives a decision drives the decision that actually ships. */
function sourceLine(src, needle) {
  const hits = src.split(/\r?\n/).filter((l) => l.indexOf(needle) !== -1);
  if (hits.length !== 1) {
    throw new Error('sourceLine: ' + hits.length + ' lines contain ' + JSON.stringify(needle));
  }
  return hits[0];
}

const bldgGeom = compile(
  [extractFunction(ENGINE_SRC, 'bldgGeom'), extractFunction(ENGINE_SRC, '_coord')],
  [], [], 'bldgGeom'
);
const spLatLngToGraph = compile(
  ['var SP_M_PER_UNIT = 0.5;', extractFunction(ENGINE_SRC, 'spLatLngToGraph')],
  [], [], 'spLatLngToGraph'
);
const spBuildingFootprint = compile(
  ['var SP_M_PER_UNIT = 0.5;', extractFunction(ENGINE_SRC, 'spBuildingFootprint')],
  [], [], 'spBuildingFootprint'
);

const t1 = (extra) => Object.assign({ id: 'n1', type: 't1', label: 'B1', budget: 50000 }, extra || {});
const ring = (lat, lng) => [
  { lat: lat, lng: lng }, { lat: lat + 0.0002, lng: lng },
  { lat: lat + 0.0002, lng: lng + 0.0003 }, { lat: lat, lng: lng + 0.0003 },
];

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. ONE PREDICATE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('bldgGeom is the single answer, and it is hostile-input safe', () => {
  test('the three states', () => {
    expect(bldgGeom(t1({ polygon: ring(28.5, -81.4) }))).toBe('poly');
    expect(bldgGeom(t1({ geoLatLng: { lat: 28.5, lng: -81.4 } }))).toBe('pin');
    expect(bldgGeom(t1())).toBe('none');
  });

  test('a trace BEATS a pin — area wins, because area is the thing a pin lacks', () => {
    const both = t1({ geoLatLng: { lat: 28.5, lng: -81.4 }, polygon: ring(28.5, -81.4) });
    expect(bldgGeom(both)).toBe('poly');
  });

  test('a stub ring is not a footprint, at every length below three', () => {
    for (const k of [0, 1, 2]) {
      expect([k, bldgGeom(t1({ polygon: ring(28.5, -81.4).slice(0, k) }))]).toEqual([k, 'none']);
    }
    expect(bldgGeom(t1({ polygon: ring(28.5, -81.4).slice(0, 3) }))).toBe('poly');
  });

  test('a stub ring plus a pin is a PIN — it falls through, it does not fail', () => {
    // This is the case that used to read 'pin' from bldgMapState and 'skip me'
    // from the renderer at the same time.
    const n = t1({ geoLatLng: { lat: 28.5, lng: -81.4 }, polygon: ring(28.5, -81.4).slice(0, 2) });
    expect(bldgGeom(n)).toBe('pin');
  });

  test('a pin that is not a pin is NOT a pin', () => {
    // bldgMapState used to accept any truthy geoLatLng, so {lat:null} was a
    // "pin" that projects to NaN and renders at the top-left of the canvas.
    const junk = [
      null, undefined, {}, { lat: null, lng: null }, { lat: 28.5 }, { lng: -81.4 },
      { lat: NaN, lng: -81.4 }, { lat: 28.5, lng: NaN },
      { lat: Infinity, lng: -81.4 }, { lat: 28.5, lng: -Infinity },
      { lat: 'nope', lng: 'nope' }, { lat: '', lng: '' },
    ];
    for (const g of junk) {
      expect([JSON.stringify(g), bldgGeom(t1({ geoLatLng: g }))]).toEqual([JSON.stringify(g), 'none']);
    }
  });

  test('a numeric string pin IS accepted — geocoders and JSON round-trips hand back strings', () => {
    expect(bldgGeom(t1({ geoLatLng: { lat: '28.5', lng: '-81.4' } }))).toBe('pin');
  });

  test('lat/lng 0,0 is a real coordinate, not a falsy one', () => {
    expect(bldgGeom(t1({ geoLatLng: { lat: 0, lng: 0 } }))).toBe('pin');
  });

  test('no node at all', () => {
    expect(bldgGeom(null)).toBe('none');
    expect(bldgGeom(undefined)).toBe('none');
  });

  test('a lifted _pinSpec carries its fallback — the same trap, second instance', () => {
    // extractFunction hands back ONE function body. _pinSpec delegates to the
    // module-level _PIN_FALLBACK, so lifting it alone yields a copy that throws
    // on its very first fallback path — which is every path that matters.
    const dir = path.join(REPO, 'test');
    const offenders = fs.readdirSync(dir).filter((x) => x.endsWith('.test.js')).filter((x) => {
      const src = fs.readFileSync(path.join(dir, x), 'utf8');
      if (src.indexOf("extractFunction(UI_SRC, '_pinSpec')") === -1) return false;
      return src.indexOf('_PIN_FALLBACK') === -1;
    });
    expect(offenders).toEqual([]);
  });

  test('every suite that LIFTS bldgGeom lifts _coord with it', () => {
    // extractFunction hands back one function body. bldgGeom delegates to
    // _coord, so a suite that lifts only bldgGeom gets a copy that throws on
    // every call — which is exactly what happened to the zoom suite the moment
    // _coord was introduced, and it was mistaken for an unrelated flake.
    const dir = path.join(REPO, 'test');
    const offenders = fs.readdirSync(dir).filter((n) => n.endsWith('.test.js')).filter((n) => {
      const src = fs.readFileSync(path.join(dir, n), 'utf8');
      if (src.indexOf("extractFunction(ENGINE_SRC, 'bldgGeom')") === -1) return false;
      return src.indexOf("extractFunction(ENGINE_SRC, '_coord')") === -1;
    });
    expect(offenders).toEqual([]);
  });
  test('it is exported, or every caller is reading undefined', () => {
    expect(ENGINE_SRC).toContain('bldgGeom:bldgGeom,');
  });

  test('the five copies are down to one', () => {
    // The rule is `polygon && polygon.length>=3`. It may appear ONCE as live
    // code — inside bldgGeom. Everything else must ask the engine.
    const live = UI_SRC.split(/\r?\n/)
      .filter((l) => /polygon\s*&&\s*n?\.?polygon\.length\s*>=\s*3/.test(l))
      .filter((l) => !/^\s*(\/\/|\*)/.test(l.trim()));   // prose may quote it
    expect(live).toEqual([]);
    expect(UI_SRC).not.toContain('function buildingIsTraced');
    const engineLive = ENGINE_SRC.split(/\r?\n/)
      .filter((l) => /polygon\.length\s*>=\s*3/.test(l))
      .filter((l) => !/^\s*(\/\/|\*)/.test(l.trim()));
    expect(engineLive.length).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. THE GATE — driven on the literal shipped line
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the render gate admits a pin and still refuses nowhere', () => {
  // The real line, compiled into a function whose `true` means "renderNodes
  // returned early", i.e. this building is not painted.
  const GATE_LINE = sourceLine(UI_SRC, "n.type==='t1' && E.bldgGeom(n)==='none') return");
  // Only the RETURN is rewritten, so the condition under test is the shipped
  // one character for character. If the line ever stops ending in a bare
  // `return;` the rewrite is asserted below rather than silently vacuous.
  const GATE = GATE_LINE.trim().replace(/return;\s*$/, 'return true;');
  const skipped = compile(
    ['function skipped(sitePlan, _spSatellite, n, E){ ' + GATE + ' return false; }'],
    [], [], 'skipped'
  );
  const E = { bldgGeom: bldgGeom };

  test('the rewrite that makes "skipped" observable actually happened', () => {
    expect(GATE_LINE).toMatch(/return;\s*$/);
    expect(GATE).toContain('return true;');
  });

  test('a TRACED building paints, as it always did', () => {
    expect(skipped(true, true, t1({ polygon: ring(28.5, -81.4) }), E)).toBe(false);
  });

  test('a PINNED building paints — this is the whole change', () => {
    expect(skipped(true, true, t1({ geoLatLng: { lat: 28.5, lng: -81.4 } }), E)).toBe(false);
  });

  test('a building that is NOWHERE is still skipped', () => {
    expect(skipped(true, true, t1(), E)).toBe(true);
  });

  test('a junk pin is still skipped — it would project to NaN', () => {
    expect(skipped(true, true, t1({ geoLatLng: { lat: null, lng: null } }), E)).toBe(true);
  });

  test('the gate only applies to t1, on satellite, in site-plan mode', () => {
    expect(skipped(true, true, t1({ type: 'wip' }), E)).toBe(false);   // not a building
    expect(skipped(true, false, t1(), E)).toBe(false);                  // not satellite
    expect(skipped(false, true, t1(), E)).toBe(false);                  // not site plan
  });

  test('renderPolygons is NOT asked to draw a pin — a pin has no ring', () => {
    // The polygon layer still iterates polygons only. A pin renders as the
    // massing block in renderNodes, which is why nothing here had to change.
    const line = sourceLine(UI_SRC, "if(n.type!=='t1' || !n.polygon || n.polygon.length<3) return;");
    expect(line).toBeTruthy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. PIN-TO-CREATE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('Place can create a building, and it mints no wire', () => {
  function harness() {
    const nodes = [{ id: 'wip1', type: 'wip', x: 0, y: 0 }];
    const wires = [];
    let seq = 0;
    const E = {
      nodes: () => nodes,
      wires: () => wires,
      findNode: (id) => nodes.filter((n) => n.id === id)[0] || null,
      addNode: (type, x, y, label) => {
        const n = { id: 'new' + (++seq), type: type, x: x, y: y, label: label };
        nodes.push(n);
        return n;
      },
      spLatLngToGraph,                 // the REAL projection, lifted — a model here hid a sign flip
    };
    const newBuildingAt = compile(
      [extractFunction(UI_SRC, 'newBuildingAt')],
      ['E', '_geoOriginNow'],
      [E, () => ({ o: { lat: 28.5, lng: -81.4 }, og: { x: 500, y: 400 } })],
      'newBuildingAt'
    );
    return { nodes, wires, E, newBuildingAt };
  }

  test('it mints a t1 at the clicked point, named in the B-series', () => {
    const h = harness();
    const n = h.newBuildingAt(28.5, -81.4);
    expect(n.type).toBe('t1');
    expect(n.label).toBe('B1');
    expect(n).toEqual(expect.objectContaining({ x: 500, y: 400 }));
  });

  test('the B-series counts existing buildings, so a second pin is B2', () => {
    const h = harness();
    h.newBuildingAt(28.5, -81.4);
    expect(h.newBuildingAt(28.501, -81.401).label).toBe('B2');
  });

  test('the minted x/y is the REAL projection, asserted AWAY from the origin', () => {
    // At the origin the projection contributes (0,0), so a sign flip, a dropped
    // projection and a dropped Math.round all survived here. The abstract x/y is
    // what fitSiteplan, the non-satellite graph view and the persisted node
    // position all use, so a wrong one stacks every pinned building on the
    // centroid off-satellite and nothing notices.
    const h = harness();
    const g = spLatLngToGraph(28.501, -81.401, 28.5, -81.4);
    expect(g.x === 0 && g.y === 0).toBe(false);            // the fixture IS off-origin
    expect(h.newBuildingAt(28.501, -81.401)).toEqual(expect.objectContaining({
      x: Math.round(500 + g.x), y: Math.round(400 + g.y),
    }));
  });

  test('PIN-TO-CREATE ITSELF is driven, not merely named in the source', () => {
    // Deleting `creating || ` from the shipped guard kills the entire feature:
    // Place with nothing selected would enter pick mode, find no node, fall to
    // the else and report "Selection lost". Every source-text assertion in this
    // file still passed, because `var creating=(...)` and `newBuildingAt(...)`
    // both remain present — the second merely becomes unreachable.
    const GATE = sourceLine(UI_SRC, '&& _spOrigin && _spOriginGraph){').trim();
    expect(GATE.endsWith('){')).toBe(true);                // it really does open a block
    const creates = compile(
      ['function creates(creating, sel, _spOrigin, _spOriginGraph){ ' + GATE
        + ' return true; } return false; }'], [], [], 'creates');

    const bldg = { type: 't1', id: 'n1' };
    expect(creates(true, null, {}, {})).toBe(true);        // nothing selected -> CREATE
    expect(creates(false, bldg, {}, {})).toBe(true);       // a building selected -> re-pin
    expect(creates(false, null, {}, {})).toBe(false);      // selection lost -> refuse
    expect(creates(false, { type: 'co' }, {}, {})).toBe(false);   // not a building -> refuse
    expect(creates(true, null, null, {})).toBe(false);     // no geo origin -> refuse
    expect(creates(true, null, {}, null)).toBe(false);
  });

  test('IT ADDS NO WIRE. An edge that buys nothing is an edge that could move money later', () => {
    const h = harness();
    h.newBuildingAt(28.5, -81.4);
    expect(h.wires).toEqual([]);
  });

  test('trace-to-create still wires itself to the WIP hub — the old path is untouched', () => {
    const finish = extractFunction(UI_SRC, 'finishTrace');
    expect(finish).toContain('newBuildingAt');            // it shares the minter
    expect(finish).toContain('auto-connect to the WIP hub');
    expect(finish).toMatch(/wires\(\)\.push\(\{\s*fromNode/);
  });

  test('Place no longer refuses when nothing is selected', () => {
    const toggle = extractFunction(UI_SRC, 'toggleGeoPick');
    expect(toggle).not.toContain('Select a building first');
    expect(toggle).toContain('_geoPickId=existing?existing.id:null');
  });

  test('a null pick id means CREATE, and the handler says so by name', () => {
    const ov = extractFunction(UI_SRC, 'ensureGeoPickOverlay');
    expect(ov).toContain('var creating=(_geoPickId===null)');
    expect(ov).toContain('newBuildingAt(ll.lat, ll.lng)');
    // and a lost selection is still a lost selection, not an accidental create
    expect(ov).toContain('Selection lost');
  });

  test('the two MAP GESTURES cannot drift — there is exactly one inventor', () => {
    // t1 nodes are also minted by the appData->graph materialisers (syncFromData
    // and populate), but that is a different act: giving an EXISTING building
    // record a node, passing b.name and the record itself. The thing that must
    // not exist twice is the INVENTION of a new building from a map gesture,
    // which is the one that has to name itself in the B-series.
    const lines = UI_SRC.split(/\r?\n/).filter((l) => /E\.addNode\('t1'/.test(l) && !/^\s*\/\//.test(l.trim()));
    const invent = lines.filter((l) => /'B'\s*\+/.test(l));
    expect(invent).toHaveLength(1);
    expect(invent[0]).toContain('return E.addNode');       // it IS newBuildingAt
    // and both map gestures route through it
    expect(extractFunction(UI_SRC, 'finishTrace')).toContain('newBuildingAt(clat, clng)');
    expect(extractFunction(UI_SRC, 'ensureGeoPickOverlay')).toContain('newBuildingAt(ll.lat, ll.lng)');

    // the materialisers are distinguishable by shape, and there are exactly two
    const fromRecord = lines.filter((l) => l.indexOf("b.name||'Building'") !== -1);
    expect(fromRecord).toHaveLength(2);
    expect(invent.length + fromRecord.length).toBe(lines.length);   // no third kind
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. LOCKED TO THE SPOT CLICKED — THE TIP IS THE ANCHOR
 *
 * The first version painted a pinned building as the same budget-proportional
 * MASSING BLOCK a traced one gets. John looked at it: every pinned building
 * came out the same size, none lined up with the roof underneath, and a block
 * claims an extent that is precisely what a pin does not have. He chose the
 * teardrop. So the anchor moved from "centre of a block" to "tip of a pin",
 * which is the literal reading of "have it locked to that".
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the teardrop tip lands on the stored point, at every zoom', () => {
  // The two shipped lines that place it. left/top is the projected point
  // UNTOUCHED; the transform maps the spec's own anchor (ax,ay) onto it.
  const SIZE = sourceLine(UI_SRC, "div.style.width=_ps.w+'px'").trim() + ' '
    + sourceLine(UI_SRC, "div.style.height=_ps.h+'px'").trim();
  const XFORM = sourceLine(UI_SRC, "div.style.transform='scale('").trim();

  const place = compile(
    ['function place(_ps, E, div){ ' + SIZE + ' '
      + sourceLine(UI_SRC, "div.style.transformOrigin='0 0';").trim() + ' '
      + XFORM + ' return div; }'],
    [], [], 'place'
  );
  const SPEC = { url: 'data:image/svg+xml,x', ax: 14, ay: 40, w: 28, h: 40 };
  const at = (z) => {
    const div = { style: {} };
    place(SPEC, { zm: () => z }, div);
    return div.style;
  };

  test('the box is the PIN’s size, never the footprint', () => {
    const s = at(1);
    expect([s.width, s.height]).toEqual(['28px', '40px']);
    // and the 190px floor on .ng-node cannot claim it, because min-width is set
    // inline — the bug that made the old block paint 95 m wide.
    expect(s.minWidth).toBe('28px');
  });

  test('the transform puts the ANCHOR on the origin, so the tip is the point', () => {
    expect(at(1).transformOrigin).toBe('0 0');
    expect(at(1).transform).toBe('scale(1) translate(-14px,-40px)');
  });

  test('it holds CONSTANT SCREEN SIZE — the counter-scale is 1/zoom', () => {
    // A pin that grew with zoom would re-acquire the implied extent John just
    // rejected. Both point markers this canvas already has are fixed size.
    expect(at(2).transform).toBe('scale(0.5) translate(-14px,-40px)');
    expect(at(0.5).transform).toBe('scale(2) translate(-14px,-40px)');
    expect(at(4).transform).toBe('scale(0.25) translate(-14px,-40px)');
  });

  test('a zero or missing zoom does not produce Infinity', () => {
    expect(at(0).transform).toContain('scale(1)');
    expect(at(undefined).transform).toContain('scale(1)');
  });

  test('the tip offset comes from the SPEC, not a retyped constant', () => {
    // A hardcoded 14/40 would silently disagree with the glow variant, whose
    // box and anchor are different (47x54, anchor 23.3/45.9).
    const s = at(1);
    expect(s.transform).toContain('-' + SPEC.ax + 'px');
    expect(s.transform).toContain('-' + SPEC.ay + 'px');
    const wide = { url: 'x', ax: 23.3, ay: 45.9, w: 47, h: 54 };
    const d = { style: {} };
    place(wide, { zm: () => 1 }, d);
    expect(d.style.transform).toBe('scale(1) translate(-23.3px,-45.9px)');
    expect([d.style.width, d.style.height]).toEqual(['47px', '54px']);
  });

  test('the footprint sizer is NOT what sizes a pin any more', () => {
    const from = UI_SRC.indexOf('if(_isPinNode){');
    const branch = UI_SRC.slice(from, UI_SRC.indexOf('} else {', from));
    expect(branch.length).toBeGreaterThan(40);        // the slice found something
    expect(branch).toContain('_ps.w');
    expect(branch).not.toContain('_fp.w');
  });

  test('a traced building still sizes by footprint — the else arm is untouched', () => {
    const line = sourceLine(UI_SRC, "div.style.width=_fp.w+'px'; div.style.minHeight=_fp.h+'px';");
    expect(line).toContain('_fp.w');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4b. IT IS THE PRODUCT'S OWN PIN, NOT A NEW ONE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the teardrop is the job’s pin from the Jobs map', () => {
  const PINS_SRC = read('js/map-pins.js');
  // _pinSpec reads the module-level _PIN_FALLBACK, so that comes across too or
  // the lifted copy throws. Lifted from source, never retyped here.
  const FALLBACK_SRC = sourceLine(UI_SRC, 'var _PIN_FALLBACK =').trim();
  const spec = compile(
    [FALLBACK_SRC, extractFunction(UI_SRC, '_pinSpec')],
    ['window', 'E', 'appData'],
    [
      { p86MapPins: {
        specForType: (t) => ({ url: 'data:svg/' + t, ax: 14, ay: 40, w: 28, h: 40 }),
        typeForEntity: (job) => (String(job.jobNumber || '').indexOf('RV') === 0 ? 'reno' : 'job'),
      } },
      { job: () => 'J1' },
      { jobs: [{ id: 'J1', jobNumber: 'RV-100' }] },
    ],
    '_pinSpec'
  );

  test('it resolves the type from the OWNING JOB, so the two maps agree', () => {
    expect(spec().url).toBe('data:svg/reno');
  });

  test('it asks specForType, NOT previewSvg', () => {
    const fn = extractFunction(UI_SRC, '_pinSpec');
    expect(fn).toContain('specForType');
    // previewSvg's override is a WHOLESALE config replacement, so using it would
    // make this the one pin an org cannot re-skin from Admin.
    expect(fn).not.toContain('previewSvg');
  });

  test('a data URI, because inline SVG would collide on its filter id', () => {
    // pinSvgString hardcodes filter id="p"; N inline pins = N duplicate ids in
    // one document, and every filter:url(#p) resolves to the first.
    expect(PINS_SRC).toContain('<filter id="p"');
    expect(UI_SRC).toContain('_pimg.src=_pinSpec().url;');
  });

  test('it invents NO seventh pin type — the server whitelists exactly six', () => {
    const manifest = read('server/routes/org-manifest-routes.js');
    const m = manifest.match(/MAP_PIN_TYPES\s*=\s*\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    expect(m[1]).not.toContain('building');
    expect(extractFunction(UI_SRC, '_pinSpec')).not.toContain("'building'");
  });

  test('it never throws and never waits, whatever the page state', () => {
    const bare = (win, eng, app) => compile(
      [FALLBACK_SRC, extractFunction(UI_SRC, '_pinSpec')], ['window', 'E', 'appData'], [win, eng, app], '_pinSpec'
    )();
    const FALLBACK = { url: '', ax: 14, ay: 40, w: 28, h: 40 };
    expect(bare({}, { job: () => 'J1' }, { jobs: [] })).toEqual(FALLBACK);          // map-pins absent
    expect(bare({ p86MapPins: {} }, { job: () => 'J1' }, { jobs: [] })).toEqual(FALLBACK);
    expect(bare({ p86MapPins: { specForType: () => null } }, { job: () => 'J1' }, { jobs: [] }))
      .toEqual(FALLBACK);                                                           // spec came back empty
    expect(bare({ p86MapPins: { specForType: () => { throw new Error('boom'); } } },
      { job: () => 'J1' }, { jobs: [] })).toEqual(FALLBACK);                        // it threw
  });

  test('no job on the page still yields a pin — the generic type', () => {
    const s = compile(
      [FALLBACK_SRC, extractFunction(UI_SRC, '_pinSpec')], ['window', 'E', 'appData'],
      [{ p86MapPins: { specForType: (t) => ({ url: 'data:svg/' + t, ax: 14, ay: 40, w: 28, h: 40 }),
        typeForEntity: () => 'reno' } }, { job: () => 'NOPE' }, { jobs: [] }], '_pinSpec'
    )();
    expect(s.url).toBe('data:svg/job');     // typeForEntity is not consulted without a job
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4c. THE CARD STRIP IS KEPT, THE ROOF IS UNDONE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a pinned node keeps ng-sp-building and adds ng-sp-pin', () => {
  const CSS = read('nodegraph/nodegraph.css');

  test('ng-sp-building STAYS — it is what strips the data card and places the name', () => {
    // Dropping it would make every child visible: the header, the port dots, the
    // progress bar, the sub-items, the hover tools.
    expect(UI_SRC).toContain("if(_geoBldg) div.classList.add('ng-sp-building');");
    expect(CSS).toContain('.ng-sp-building > *{display:none !important}');
    expect(CSS).toMatch(/\.ng-sp-building > \.ng-node-cap\{[^}]*display:block !important/);
  });

  test('ng-sp-pin is added only for a pin, and only undoes the roof', () => {
    expect(UI_SRC).toContain("if(_isPinNode) div.classList.add('ng-sp-pin');");
    const rule = CSS.match(/\.ng-sp-building\.ng-sp-pin\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    for (const prop of ['background:none', 'border:0', 'box-shadow:none', 'cursor:pointer']) {
      expect([prop, rule[1].indexOf(prop) !== -1]).toEqual([prop, true]);
    }
  });

  test('the teardrop is exempted from the card strip by name', () => {
    expect(CSS).toMatch(/\.ng-sp-pin > \.ng-bldgpin\{[^}]*display:block !important/);
    expect(UI_SRC).toContain("_pimg.className='ng-bldgpin';");
  });

  test('the name is widened, or a 28px pin starves it', () => {
    const cap = CSS.match(/\.ng-sp-pin > \.ng-node-cap\{([^}]*)\}/);
    expect(cap).not.toBeNull();
    expect(cap[1]).toContain('-56px');
  });

  test('selection moves onto the silhouette, since there is no border left', () => {
    expect(CSS).toMatch(/\.ng-sp-pin\.ng-sel > \.ng-bldgpin\{[^}]*drop-shadow/);
    expect(CSS).toMatch(/\.ng-sp-pin\.ng-connected > \.ng-bldgpin\{[^}]*drop-shadow/);
  });

  test('a teardrop gets no 2.5D extrusion — it is not a mass', () => {
    expect(UI_SRC).toContain('if(_spMassing && !_isPinNode){');
  });

  test('the pin flag is per-iteration, not leaked across nodes by var hoisting', () => {
    // `var` is function-scoped: a flag assigned inside the t1 branch would still
    // be set for every node drawn after the last building.
    const decl = sourceLine(UI_SRC, 'var _isPinNode = sitePlan');
    expect(decl).toContain("n.type==='t1'");
    expect(decl).toContain("E.bldgGeom(n)==='pin'");
    // and it is declared before the branch that would otherwise own it
    expect(UI_SRC.indexOf('var _isPinNode')).toBeLessThan(UI_SRC.indexOf("classList.add('ng-sp-pin')"));
  });
});

describe('a geo-positioned building cannot be dragged', () => {
  // Its position belongs to its pin or its polygon. Dragging one wrote a bogus
  // abstract x/y, PERSISTED it, and let the block snap back on the next render,
  // while fitSiteplan and siteplanCentroid went on reading a position no
  // building occupied. Unreachable until pin-only buildings painted.
  const GUARD = sourceLine(UI_SRC, 'var _geoFixed = _spSatellite && E.viewMode')
    + ' ' + sourceLine(UI_SRC, "&& n3.type==='t1' && E.bldgGeom(n3)!=='none';")
    + ' ' + sourceLine(UI_SRC, 'dragN = _geoFixed ? null : nid2;');
  const arm = compile(
    ['function arm(_spSatellite, E, n3, nid2){ var dragN; ' + GUARD.replace(/\s+/g, ' ') + ' return dragN; }'],
    [], [], 'arm'
  );
  const E = { viewMode: () => 'siteplan', bldgGeom: bldgGeom };

  test('a pinned building does not arm the drag', () => {
    expect(arm(true, E, t1({ geoLatLng: { lat: 28.5, lng: -81.4 } }), 'n1')).toBeNull();
  });

  test('nor does a traced one', () => {
    expect(arm(true, E, t1({ polygon: ring(28.5, -81.4) }), 'n1')).toBeNull();
  });

  test('a building that is NOWHERE still drags — it has only its abstract x/y', () => {
    expect(arm(true, E, t1(), 'n1')).toBe('n1');
  });

  test('a non-building node still drags', () => {
    expect(arm(true, E, t1({ type: 'co', geoLatLng: { lat: 28.5, lng: -81.4 } }), 'n1')).toBe('n1');
  });

  test('and off the satellite, or off the site plan, everything drags as before', () => {
    const pinned = t1({ geoLatLng: { lat: 28.5, lng: -81.4 } });
    expect(arm(false, E, pinned, 'n1')).toBe('n1');
    expect(arm(true, { viewMode: () => 'graph', bldgGeom: bldgGeom }, pinned, 'n1')).toBe('n1');
  });

  test('selection is NOT what was disabled — only the drag', () => {
    const seg = UI_SRC.slice(UI_SRC.indexOf('var _geoFixed') - 600, UI_SRC.indexOf('var _geoFixed'));
    expect(seg).toContain('selN=nid2;');
  });
});

describe('the 3D card names the geometry it actually has', () => {
  test('a pinned building is not called "Traced building"', () => {
    const word = compile(
      ['function word(b){ ' + sourceLine(ORBIT_SRC, 'var _geomWord=').trim() + ' return _geomWord; }'],
      [], [], 'word'
    );
    expect(word({ path: null })).toBe('Pinned location');
    expect(word({ path: [1, 2] })).toBe('Pinned location');          // a stub ring is not a trace
    expect(word({ path: [1, 2, 3] })).toBe('Traced building');
  });

  test('and the card reads the word rather than a hard-coded one', () => {
    const line = sourceLine(ORBIT_SRC, "(b.units?b.units+' units':'')");
    expect(line).toContain('_geomWord');
    expect(line).not.toContain("'Traced building'");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. THE 3D VIEW GETS THE PIN
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the orbit 3D feed carries pinned buildings', () => {
  function feed(nodes) {
    const posted = [];
    const E = {
      nodes: () => nodes,
      wires: () => [],
      findNode: () => null,
      resetComp: () => {},
      getOutput: () => 0,
      getActual: () => 0,
      getT1WeightedPct: (n) => n.pctComplete || 0,
      bldgGeom: bldgGeom,
    };
    const postOrbitData = compile(
      [extractFunction(UI_SRC, 'postOrbitData')],
      ['E', '_orbitEl', '_orbitPending', 'jobOrigin', 'location'],
      [
        E,
        { __frame: { contentWindow: { postMessage: (m) => posted.push(m) } } },
        { lat: 28.5, lng: -81.4 },
        () => ({ lat: 28.5, lng: -81.4 }),
        { origin: 'http://localhost' },
      ],
      'postOrbitData'
    );
    postOrbitData();
    return posted[0] ? posted[0].buildings : null;
  }

  test('a traced building still sends its ring and no pin', () => {
    const out = feed([t1({ polygon: ring(28.5, -81.4) })]);
    expect(out).toHaveLength(1);
    expect(out[0].path).toHaveLength(4);
    expect(out[0].pin).toBeNull();
  });

  test('a PINNED building sends a pin and no ring — it used to be dropped entirely', () => {
    const out = feed([t1({ geoLatLng: { lat: 28.5012, lng: -81.4034 } })]);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBeNull();
    expect(out[0].pin).toEqual({ lat: 28.5012, lng: -81.4034 });
  });

  test('a building that is nowhere is still dropped', () => {
    expect(feed([t1()])).toEqual([]);
  });

  test('a junk pin is dropped rather than posted as NaN', () => {
    expect(feed([t1({ geoLatLng: { lat: null, lng: null } })])).toEqual([]);
  });

  test('both kinds travel together, in order', () => {
    const out = feed([
      t1({ id: 'a', polygon: ring(28.5, -81.4) }),
      t1({ id: 'b', geoLatLng: { lat: 28.502, lng: -81.402 } }),
    ]);
    expect(out.map((b) => (b.path ? 'poly' : 'pin'))).toEqual(['poly', 'pin']);
  });

  test('the iframe anchors on the pin when there is no ring, and skips the block', () => {
    // Driven on orbit3d.html's own lines: the block needs a trace, the marker
    // takes whichever anchor exists.
    expect(ORBIT_SRC).toContain('var traced=!!(b.path && b.path.length>=3);');
    expect(ORBIT_SRC).toContain('if(design.blocks && traced){');
    expect(ORBIT_SRC).toContain('var cen=anchor;');
    expect(ORBIT_SRC).not.toContain('if(!b.path || b.path.length<3) return;');
  });

  test('the iframe refuses a junk pin too, instead of placing a marker at NaN', () => {
    const anchorSrc = ORBIT_SRC.split(/\r?\n/)
      .filter((l) => /isFinite\(Number\(b\.pin\.lat\)\)/.test(l));
    expect(anchorSrc.length).toBe(1);
    expect(ORBIT_SRC).toContain('if(!anchor) return;');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. NO MONEY MOVES
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a pin instead of a footprint cannot move a dollar', () => {
  const MONEY = [
    'js/progress-core.js', 'js/progress.js', 'js/jobs.js', 'js/pay-applications.js',
    'js/building-sort.js', 'js/estimates.js',
    'server/services/money/job-wip.js', 'server/routes/production-planning-routes.js',
    'server/services/production-planning.js',
  ];

  test('no money or rollup file reads a polygon at all', () => {
    const offenders = [];
    for (const f of MONEY) {
      let src;
      try { src = read(f); } catch (_) { continue; }          // file moved: not a silent pass
      src.split(/\r?\n/).forEach((l, i) => {
        if (/\.polygon\b/.test(l) && !/^\s*(\/\/|\*)/.test(l.trim())) offenders.push(f + ':' + (i + 1));
      });
    }
    expect(offenders).toEqual([]);
  });

  test('every file in the list exists — an enumeration over nothing proves nothing', () => {
    for (const f of MONEY) {
      expect([f, fs.existsSync(path.join(REPO, f))]).toEqual([f, true]);
    }
  });

  test('the building split weights are a CLOSED set, and area is not in it', () => {
    // "divide the scope up by square feet" is NEW work, not a fallback this
    // change quietly enables. The weights are even / units / levels.
    const jobs = read('js/jobs.js');
    expect(jobs).toMatch(/'units'/);
    expect(jobs).toMatch(/'levels'/);
    expect(jobs).not.toMatch(/weight\s*===\s*'area'/);
    expect(jobs).not.toMatch(/'sqft'/);
  });

  test('no building record persists an area — footprint area is a label, not data', () => {
    // If an area field is ever stored, an area-weighted split becomes possible
    // and this test should be revisited on purpose rather than by accident.
    for (const f of ['js/jobs.js', 'nodegraph/engine.js']) {
      expect([f, /\b(bldg|b)\.area\s*=/.test(read(f))]).toEqual([f, false]);
    }
  });

  test('bldgGeom itself touches no money field', () => {
    const fn = extractFunction(ENGINE_SRC, 'bldgGeom');
    for (const bad of ['budget', 'pctComplete', 'Revenue', 'cost', 'phase']) {
      expect([bad, fn.indexOf(bad) !== -1]).toEqual([bad, false]);
    }
  });
});
