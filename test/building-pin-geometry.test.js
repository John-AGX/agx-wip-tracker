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
      spLatLngToGraph: (lat, lng, oLat, oLng) => ({ x: (lng - oLng) * 1000, y: (oLat - lat) * 1000 }),
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
 * 4. LOCKED TO THE SPOT CLICKED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a pinned block is centred on its pin, and the wires agree', () => {
  const CENTRE_LINE = sourceLine(UI_SRC, "div.style.left=(_rx-_fp.w/2)");

  test('the block is shifted by half a footprint, both axes', () => {
    const place = compile(
      ['function place(_rx, _ry, _fp, div){ ' + CENTRE_LINE.trim() + ' return div; }'],
      [], [], 'place'
    );
    const div = { style: {} };
    place(1000, 800, { w: 60, h: 40 }, div);
    expect(div.style.left).toBe('970px');
    expect(div.style.top).toBe('780px');
  });

  test('it is gated on the PIN state, so a traced building is not moved', () => {
    const guard = sourceLine(UI_SRC, "if(_spSatellite && E.bldgGeom(n)==='pin'){");
    expect(guard).toContain("==='pin'");
  });

  test('the port anchor no longer shifts — the renderer centres the block for it', () => {
    // These two have to agree about where a pinned building's centre is, or the
    // wires land half a footprint away from the block they feed.
    // setGeoPortAnchor takes an anonymous callback, so this reads the file.
    expect(UI_SRC).toContain('E.setGeoPortAnchor(function(n){');
    expect(UI_SRC).not.toContain('cx + fp.w/2');
    expect(UI_SRC).not.toContain('cy + fp.h/2');
    // and it still returns the projected point for a geo-bound building
    expect(UI_SRC).toContain('return { x:cx, y:cy };');
  });

  test('the footprint a pin is sized and framed by is the SAME call the renderer uses', () => {
    expect(spBuildingFootprint(50000)).toEqual(spBuildingFootprint(50000));
    const fp = spBuildingFootprint(50000);
    expect(fp.w).toBeGreaterThan(0);
    expect(fp.h).toBeGreaterThan(0);
    expect(UI_SRC).toContain('E.spBuildingFootprint(n.budget)');
  });

  test('a $0 building still gets a real footprint, not a zero-size block', () => {
    const fp = spBuildingFootprint(0);
    expect(fp.w).toBeGreaterThan(0);
    expect(fp.h).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4b. THE ROOF BLOCK ONLY EVER PAINTS FOR A PIN
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the massing-block CSS was written for this case and was unreachable', () => {
  const CSS = read('nodegraph/nodegraph.css');

  test('a TRACED geo building hides its card entirely — the polygon carries it', () => {
    // Which is why .ng-sp-building WITHOUT .ng-has-poly never painted: the only
    // buildings that reached the massing-block rules were traced ones, and those
    // are display:none. The roof + label styling below it was dead code.
    expect(CSS).toContain('.ng-sp-building.ng-has-poly{display:none !important}');
  });

  test('the roof block strips every child EXCEPT the name', () => {
    expect(CSS).toContain('.ng-sp-building > *{display:none !important}');
    expect(CSS).toMatch(/.ng-sp-building > .ng-node-cap{[^}]*display:block !important/);
  });

  test('and the name is POSITIONED, not just un-hidden', () => {
    // display:block alone left the name inside the roof rectangle: the geometry
    // lived only on the Clean Mode rule, and a pinned building paints outside
    // Clean Mode too. Each property is asserted, so dropping one is caught.
    const m = CSS.match(/.ng-sp-building > .ng-node-cap{([^}]*)}/);
    expect(m).not.toBeNull();
    for (const prop of ['position:absolute', 'top:100%', 'text-align:center', 'white-space:nowrap']) {
      expect([prop, m[1].indexOf(prop) !== -1]).toEqual([prop, true]);
    }
  });

  test('a pinned building is the ONLY thing that reaches it, by construction', () => {
    // renderNodes adds ng-sp-building for any geo-bound building and ng-has-poly
    // on top when it is traced. So: traced -> hidden, pinned -> roof block.
    expect(UI_SRC).toContain("if(_geoBldg) div.classList.add('ng-sp-building');");
    expect(UI_SRC).toContain("if(_geoBldg && E.bldgGeom(n)==='poly') div.classList.add('ng-has-poly');");
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
