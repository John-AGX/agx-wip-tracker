/**
 * @jest-environment jsdom
 */
/* ═══════════════════════════════════════════════════════════════════════════
 * THE MAGNIFIER ON A BUILDING CARD, AND WHAT IT DOES WHEN THERE IS NOTHING
 * TO ZOOM TO.
 *
 * John asked for "a small mag glass icon in the right upper corner that zooms
 * to that building on the site map". The screenshot he attached was three
 * cards — B1, B2, B3 — every one of them $0.00, BUDGET AUTO, 0.0% complete.
 * That is a young job, and on a young job NO building has been traced on the
 * satellite yet. So the case that decides whether this feature is honest is
 * not an edge case; it is the picture he sent.
 *
 * On the satellite Site Plan an untraced building is not a map object at all.
 * nodegraph/ui.js renderNodes returns early on
 *     !(n.polygon && n.polygon.length >= 3)
 * and renderPolygons draws nothing but polygons. A magnifier that focused one
 * would move the camera to a patch of empty grass and report success — the
 * failure class this repo has paid for repeatedly: a control that reports
 * success while achieving nothing. So the properties below hold BOTH halves:
 * the traced building really is framed, and the untraced one produces a
 * different, visible, honest outcome instead of a silent no-op.
 *
 * WHAT IS HELD, each clause failing on its own:
 *
 *   1. Pressing the magnifier on building X focuses X AND NO OTHER — the
 *      engine focus set, the selection, and the camera all land on X.
 *   2. It does not toggle the card. The card is itself a click-to-expand
 *      surface; the control test proves this suite CAN see a toggle, so a
 *      green result is not a blind one.
 *   3. A building with no traced footprint gets a visibly different outcome:
 *      no camera move, the building selected, and the map's own hint banner
 *      on screen naming the building and the next action. Three separate
 *      "nothing to zoom to" causes are each held: no node, no polygon, no
 *      geocoded job.
 *   4. Every id shape this app can mint reaches the map intact — including
 *      one carrying an apostrophe, one carrying a C0 control character, and
 *      one shaped like the injection that broke the estimate editor.
 *   5. No money figure and no allocation on any card moves. Held by BYTE
 *      DIFF: the same renderer, with the button mechanically removed from its
 *      own source, must paint bytes that are identical once the buttons are
 *      cut out of the other one.
 *
 * The functions under test are LIFTED OUT OF THE SHIPPED FILES (test/helpers/
 * browser-fn.js) rather than modelled, because a model of buggy code is green
 * for exactly as long as the bug is live.
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn.js');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const JOBS_SRC = read('js/jobs.js');
const UI_SRC = read('nodegraph/ui.js');
const ENGINE_SRC = read('nodegraph/engine.js');
const CSS_SRC = read('css/styles.css');
const INDEX_HTML = read('index.html');

const DOM = require('../js/dom-ref.js');

/* ── the painted-card renderer, out of js/jobs.js ─────────────────────────── */

const RENDER_DEPS = [
  '_bldgNumSort', 'appData', 'buildingEffectiveBudget', 'calcBuildingPctComplete',
  'document', 'escapeHTML', 'fillBuildingCrew', 'fmtAllocPct', 'formatCurrency',
  'getCOsConnectedTo', 'getJobBudgetRecon', 'getPhasesWiredToBuilding', 'p86Enc', 'window',
];

/* The real formatters, lifted out of the shipped files, so a change to how
 * money is printed is a change this file renders. formatCurrency is a const
 * arrow with no `function` keyword to lift, so its body is reproduced here and
 * pinned against the source in the money section below. */
const escapeHTML = compile([extractFunction(read('js/app.js'), 'escapeHTML')], [], [], 'escapeHTML');
const fmtAllocPct = compile([extractFunction(JOBS_SRC, 'fmtAllocPct')], [], [], 'fmtAllocPct');
const _bldgNumSort = compile(
  [extractFunction(JOBS_SRC, '_bldgNumSort')], ['window'],
  [{ p86BuildingSort: require('../js/building-sort.js').p86BuildingSort }], '_bldgNumSort'
);
const formatCurrency = (val) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);

function renderFrom(jobsSrc) {
  return compile([extractFunction(jobsSrc, 'renderJobBuildings')], RENDER_DEPS, [
    _bldgNumSort, APP.appData, APP.buildingEffectiveBudget, APP.calcBuildingPctComplete,
    document, escapeHTML, APP.fillBuildingCrew, fmtAllocPct, formatCurrency,
    APP.getCOsConnectedTo, APP.getJobBudgetRecon, APP.getPhasesWiredToBuilding,
    DOM.enc, global.window,
  ], 'renderJobBuildings');
}

/* ── the money the cards read, deterministic and non-trivial ──────────────── */

const APP = {
  appData: { buildings: [], phases: [], changeOrders: [], jobs: [] },
  budgets: {},           // buildingId -> { amount, derived }
  costs: {},             // buildingId -> phase cost
  pcts: {},              // buildingId -> % complete
  recon: { contract: 0, gap: 0, full: false, over: false },
  buildingEffectiveBudget: (b) => APP.budgets[b.id] || { amount: 0, derived: true },
  calcBuildingPctComplete: (id) => APP.pcts[id] || 0,
  getPhasesWiredToBuilding: (id) => APP.wired[id] || [],
  getCOsConnectedTo: (t, id) => APP.cos[id] || [],
  getJobBudgetRecon: () => APP.recon,
  fillBuildingCrew: () => {},
  wired: {},
  cos: {},
};

/* ── the Site Plan focus machinery, out of nodegraph/ui.js ────────────────── */

const spLatLngToGraph = compile(
  ['var SP_M_PER_UNIT = 0.5;', extractFunction(ENGINE_SRC, 'spLatLngToGraph')],
  [], [], 'spLatLngToGraph'
);

const UI_FNS = [
  'applySpFocus', 'getConnectedIds', 'buildingNodeFor', 'buildingIsTraced',
  'frameBuildingPolygon', '_zoomBldgToast', 'showSatHint', 'zoomBuildingOnMap',
];

/* Build a live harness: the REAL functions, sharing the REAL module-level
 * `_spFocus` / `selN` / `_satHintEl` variables they assign to, over a fake
 * engine and a real jsdom viewport. Nothing here re-implements the feature. */
function makeSitePlan(opts) {
  opts = opts || {};
  const nodes = opts.nodes || [];
  const wires = opts.wires || [];
  const origin = opts.origin === null ? null : (opts.origin || { lat: 28.5, lng: -81.4 });
  const originGraph = opts.originGraph || { x: 0, y: 0 };

  const rec = {
    focusSets: [], toasts: [], renders: 0, applyTx: 0, fanned: [], openedGraph: [],
  };
  let panX = 0, panY = 0, zoom = 1;

  const E = {
    nodes: () => nodes,
    wires: () => wires,
    findNode: (id) => nodes.filter((n) => n.id === id)[0] || null,
    job: () => opts.job === undefined ? 'J1' : opts.job,
    setSitePlanFocusSet: (s) => { rec.focusSets.push(s ? JSON.parse(JSON.stringify(s)) : null); },
    spLatLngToGraph,
    pan: (x, y) => { if (x != null) panX = x; if (y != null) panY = y; return { x: panX, y: panY }; },
    zm: (z) => { if (z != null) zoom = z; return zoom; },
  };

  const wrap = document.createElement('div');
  Object.defineProperty(wrap, 'clientWidth', { value: 1200 });
  Object.defineProperty(wrap, 'clientHeight', { value: 800 });
  document.body.appendChild(wrap);

  const tab = document.createElement('div');
  tab.id = 'nodeGraphTab';
  if (opts.tabActive !== false) tab.classList.add('active');
  document.body.appendChild(tab);

  window.openNodeGraph = (jid) => { rec.openedGraph.push(jid); };
  window.p86Toast = (msg) => { rec.toasts.push(msg); };

  const api = compile(
    ['var _spFocus = null, selN = null, _satHintEl = null;']
      .concat(UI_FNS.map((f) => extractFunction(UI_SRC, f))),
    ['E', '_geoOriginNow', 'appData', 'applyTx', 'document', 'fanFocusNodes', 'render', 'window', 'wrap'],
    [
      E,
      () => ({ o: origin, og: originGraph }),
      APP.appData,
      () => { rec.applyTx++; },
      document,
      (id) => { rec.fanned.push(id); },
      () => { rec.renders++; },
      window,
      wrap,
    ],
    '({ zoom: zoomBuildingOnMap, focus: function(){ return _spFocus; },'
      + ' sel: function(){ return selN; }, hint: function(){ return _satHintEl; } })'
  );

  return {
    api, rec, E, wrap, tab, nodes,
    camera: () => ({ pan: E.pan(), zoom: E.zm() }),
    teardown: () => { wrap.remove(); tab.remove(); },
  };
}

/* A traced footprint: four corners around a lat/lng, in metres. */
function footprintAt(lat, lng, m) {
  const dLat = (m || 12) / 111320;
  const dLng = (m || 12) / (111320 * Math.cos(lat * Math.PI / 180));
  return [
    { lat: lat - dLat, lng: lng - dLng }, { lat: lat - dLat, lng: lng + dLng },
    { lat: lat + dLat, lng: lng + dLng }, { lat: lat + dLat, lng: lng - dLng },
  ];
}

/* Where a lat/lng lands in graph space — the same projection renderPolygons
 * uses, so an expectation here is the pixel the renderer would draw at. */
function graphPt(v, origin, og) {
  const g = spLatLngToGraph(Number(v.lat), Number(v.lng), origin.lat, origin.lng);
  return { x: og.x + g.x, y: og.y + g.y };
}
function polygonCentre(poly, origin, og) {
  const pts = poly.map((v) => graphPt(v, origin, og));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/* ── a job with three buildings, real money on every one ──────────────────── */

const ORIGIN = { lat: 28.5, lng: -81.4 };
const OG = { x: 500, y: 400 };

function seedThreeBuildings() {
  APP.appData.buildings = [
    { id: 'b-one', jobId: 'J1', name: 'B1', materials: 1200, labor: 3400, sub: 900, equipment: 150 },
    { id: 'b-two', jobId: 'J1', name: 'B2', materials: 7000, labor: 250.55, sub: 0, equipment: 0 },
    { id: 'b-three', jobId: 'J1', name: 'B3', materials: 0, labor: 0, sub: 0, equipment: 0 },
  ];
  APP.budgets = {
    'b-one': { amount: 18250.75, derived: false },
    'b-two': { amount: 9000, derived: true },
    'b-three': { amount: 0, derived: true },
  };
  APP.pcts = { 'b-one': 42.5, 'b-two': 100, 'b-three': 0 };
  APP.wired = {
    'b-one': [{ phase: { id: 'p1', phase: 'Framing', materials: 500, labor: 700, sub: 0, equipment: 0, pctComplete: 55 }, allocPct: 60 }],
    'b-two': [{ phase: { id: "p2'x", phase: 'Roofing', materials: 300, labor: 0, sub: 1200, equipment: 0, pctComplete: 100 }, allocPct: 100 }],
    'b-three': [],
  };
  APP.cos = {
    'b-one': [{ co: { id: 'co-1', co_number: 'CO-0001', description: 'Add lanai', income: 4200 }, allocPct: 75 }],
    'b-two': [], 'b-three': [],
  };
  APP.recon = { contract: 40000, gap: 12749.25, full: false, over: false };
}

/* Three t1 nodes, one per building. Traced unless said otherwise. */
function threeNodes(tracedIds) {
  const traced = tracedIds || ['b-one', 'b-two', 'b-three'];
  const spots = { 'b-one': [28.5010, -81.4010], 'b-two': [28.5030, -81.3980], 'b-three': [28.4980, -81.4030] };
  return APP.appData.buildings.map((b, i) => {
    const [lat, lng] = spots[b.id];
    const n = { id: 'n' + (i + 1), type: 't1', label: b.name, data: { id: b.id }, x: 10000 + i * 500, y: -9000 - i * 700, budget: 50000 };
    if (traced.indexOf(b.id) !== -1) { n.geoLatLng = { lat, lng }; n.polygon = footprintAt(lat, lng); }
    return n;
  });
}

let host;
beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  host.id = 'insp-buildings';
  document.body.appendChild(host);
  window.p86Dec = DOM.dec;
  delete window.p86Icon;                 // keep painted bytes small and readable
  delete window.p86MapLink;
  seedThreeBuildings();
});

/* ═══ 0. THE HARNESS CAN SEE WHAT IT CLAIMS TO SEE ═══════════════════════════
 * Every behavioural clause below rides on jsdom compiling the inline handlers
 * this app paints. A jsdom that stopped doing that would turn "the press did
 * not toggle the card" green for the wrong reason, so it is asserted first. */

describe('the harness executes the painted handlers', () => {
  test('an inline onclick painted through innerHTML actually runs', () => {
    let fired = 0;
    window.__probe = () => { fired++; };
    host.innerHTML = '<button id="probe" onclick="window.__probe()">x</button>';
    document.getElementById('probe').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(fired).toBe(1);
    delete window.__probe;
  });
});

/* ═══ 1. THE BUTTON IS THERE, ON BOTH HOSTS, IN THE CORNER ══════════════════ */

describe('the control itself', () => {
  test('every building card carries exactly one magnifier', () => {
    renderFrom(JOBS_SRC)('J1', 'insp-buildings');
    const cards = host.querySelectorAll('.p86-mline');
    expect(cards.length).toBe(3);
    cards.forEach((c) => expect(c.querySelectorAll('.p86-mline-zoom').length).toBe(1));
  });

  test('it is the LAST thing in the top row — the tile\'s upper-right corner', () => {
    renderFrom(JOBS_SRC)('J1', 'insp-buildings');
    const top = host.querySelector('.p86-mline-top');
    expect(top.lastElementChild.classList.contains('p86-mline-zoom')).toBe(true);
    // and it sits AFTER the budget hero, so the money keeps its own corner
    expect(top.children[1].classList.contains('p86-mline-hero')).toBe(true);
  });

  test('it renders on the Site Plan inspector and NOT on the job overview', () => {
    // John: 'on the job overview we dont need the mag glass thats only for the
    // site inspector'. The overview has no map on screen, so a zoom control there
    // would be a navigation jump, not a zoom.
    renderFrom(JOBS_SRC)('J1', 'insp-buildings');
    expect(host.querySelectorAll('.p86-mline-zoom').length).toBe(3);

    const ov = document.createElement('div');
    ov.id = 'job-buildings-content';
    document.body.appendChild(ov);
    renderFrom(JOBS_SRC)('J1', 'job-buildings-content');
    expect(ov.querySelectorAll('.p86-mline-zoom').length).toBe(0);
    // no dead handler and no empty slot where the icon would have been
    expect(ov.innerHTML).not.toContain('p86ZoomBuildingOnMap');
    expect(ov.querySelectorAll('.p86-mline').length).toBe(3);
    ov.remove();
  });

  test('the corner rule and the compact-tile rule both ship in the stylesheet', () => {
    // Anchored at line start on purpose: `.p86-mline-grid .p86-mline-zoom {`
    // CONTAINS the base selector as a substring, so a plain toContain would
    // stay green with the base rule renamed away and the button unstyled.
    expect(CSS_SRC).toMatch(/^\.p86-mline-zoom \{/m);
    expect(CSS_SRC).toMatch(/^\.p86-mline-zoom:hover /m);
    expect(CSS_SRC).toMatch(/^\.p86-mline-grid \.p86-mline-zoom \{/m);
    // Theme vars, not hardcoded hex — light mode needs no separate twin.
    const rule = CSS_SRC.slice(CSS_SRC.search(/^\.p86-mline-zoom \{/m), CSS_SRC.search(/^\.p86-mline-zoom:hover /m));
    expect(rule).toContain('var(--border');
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,6}\s*[;}]/);
  });

  test('the compact tile got wider by exactly the control it now has to hold', () => {
    /* MEASURED, not guessed. .p86-mline-top is a flex row whose only shrinking
     * child is .p86-mline-id — the hero is flex:none — so a fourth element
     * takes its width straight out of the BUILDING NAME. At the old 122px tile
     * minimum the row was already full: the name got ~13px, exactly what "B1"
     * needs, and adding the magnifier rendered it at 0px. Browser measurement
     * across container widths 244..1200px put the threshold at a 140px tile.
     * So the tile minimum grew by the control's own footprint and no existing
     * element lost a pixel. This test ties the two numbers together: resize the
     * button without resizing the tile and it fails. */
    // Scoped to #insp-buildings: only that host paints the magnifier, so only it
    // buys the extra width. The job overview keeps its original density, and the
    // base rule is asserted NOT to have quietly kept the widened value.
    const grid = CSS_SRC.match(/^#insp-buildings \.p86-mline-grid \{[^}]*minmax\((\d+)px, 1fr\)/m);
    expect(grid).toBeTruthy();
    const base = CSS_SRC.match(/^\.p86-mline-grid \{[^}]*minmax\((\d+)px, 1fr\)/m);
    expect(base).toBeTruthy();
    expect(Number(base[1])).toBeLessThan(Number(grid[1]));
    const btn = CSS_SRC.match(/^\.p86-mline-grid \.p86-mline-zoom \{([^}]*)\}/m);
    expect(btn).toBeTruthy();
    const w = Number(btn[1].match(/width:\s*(-?\d+)px/)[1]);
    const mRight = Number(btn[1].match(/margin:\s*-?\d+px\s+(-?\d+)px/)[1]);
    const gap = Number(CSS_SRC.match(/^\.p86-mline-top \{[^}]*gap:\s*(\d+)px/m)[1]);
    const footprint = w + mRight + gap;            // 18 + (-2) + 10 = 26
    expect(footprint).toBeGreaterThan(0);
    expect(Number(grid[1])).toBeGreaterThanOrEqual(122 + footprint);
  });

  test('editing js/jobs.js, nodegraph/ui.js and css/styles.css bumped their ?v', () => {
    // The cache-buster rule: a stale ?v ships the old file to every installed
    // PWA, which is the same thing as not shipping at all. Asserted as
    // "at least", not "equal to": several sessions push to this repo and any of
    // them may bump these files again. A REVERSION still fails, which is the
    // failure this guards.
    const v = (f) => {
      const m = INDEX_HTML.match(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\?v=(\\d+)'));
      expect(m).toBeTruthy();
      return Number(m[1]);
    };
    expect(v('js/jobs.js')).toBeGreaterThanOrEqual(236);
    expect(v('nodegraph/ui.js')).toBeGreaterThanOrEqual(337);
    expect(v('css/styles.css')).toBeGreaterThanOrEqual(297);
  });
});

/* ═══ 2. PRESSING IT FOCUSES THAT BUILDING AND NO OTHER ═════════════════════ */

describe('the magnifier focuses the building it is on, and no other', () => {
  let sp;
  beforeEach(() => { sp = makeSitePlan({ nodes: threeNodes(), origin: ORIGIN, originGraph: OG }); });
  afterEach(() => sp.teardown());

  test.each([
    ['b-one', 'n1'], ['b-two', 'n2'], ['b-three', 'n3'],
  ])('%s focuses %s alone', (bldgId, nodeId) => {
    expect(sp.api.zoom(bldgId)).toBe(true);
    expect(sp.api.focus()).toBe(nodeId);
    expect(sp.api.sel()).toBe(nodeId);
    const set = sp.rec.focusSets[sp.rec.focusSets.length - 1];
    expect(set[nodeId]).toBe(1);
    ['n1', 'n2', 'n3'].filter((n) => n !== nodeId)
      .forEach((other) => expect(set[other]).toBeUndefined());
  });

  test('the camera lands on THAT building\'s footprint, not a neighbour\'s', () => {
    APP.appData.buildings.forEach((b, i) => {
      const node = sp.nodes[i];
      expect(sp.api.zoom(b.id)).toBe(true);
      const { pan, zoom } = sp.camera();
      const c = polygonCentre(node.polygon, ORIGIN, OG);
      // applyTx renders graph point p at viewport pixel (pan + p) * zoom.
      expect((pan.x + c.x) * zoom).toBeCloseTo(1200 / 2, 6);
      expect((pan.y + c.y) * zoom).toBeCloseTo(800 / 2, 6);
    });
  });

  test('three presses give three DIFFERENT cameras — not one shared view', () => {
    const seen = APP.appData.buildings.map((b) => {
      sp.api.zoom(b.id);
      const { pan, zoom } = sp.camera();
      return pan.x + ':' + pan.y + ':' + zoom;
    });
    expect(new Set(seen).size).toBe(3);
  });

  test('it drives the focus mechanism that already existed, not a second one', () => {
    // _spFocus + the engine's site-plan focus set is what the polygon
    // dbl-click and p86NgSelect use. If this ever stopped going through it,
    // the drilled-in view and the magnifier would disagree.
    sp.api.zoom('b-two');
    expect(sp.rec.focusSets.length).toBeGreaterThan(0);
    expect(sp.rec.fanned).toContain('n2');
  });

  test('a building on a job whose Site Plan is NOT open opens it first', () => {
    const other = makeSitePlan({ nodes: threeNodes(), origin: ORIGIN, originGraph: OG, job: 'J-OTHER' });
    other.api.zoom('b-one');
    expect(other.rec.openedGraph).toEqual(['J1']);
    other.teardown();
  });

  test('pressing it inside the ALREADY-OPEN Site Plan does not re-mount it', () => {
    // The tiles render inside the Site Plan's own inspector; re-running
    // openNodeGraph there resets the panel out from under the press.
    sp.api.zoom('b-one');
    expect(sp.rec.openedGraph).toEqual([]);
  });
});

/* ═══ 3. IT DOES NOT TOGGLE THE CARD ════════════════════════════════════════ */

describe('pressing the magnifier does not expand the card', () => {
  let sp;
  beforeEach(() => {
    sp = makeSitePlan({ nodes: threeNodes(), origin: ORIGIN, originGraph: OG });
    window.p86ZoomBuildingOnMap = sp.api.zoom;
    renderFrom(JOBS_SRC)('J1', 'insp-buildings');
  });
  afterEach(() => { sp.teardown(); delete window.p86ZoomBuildingOnMap; });

  const bodyOf = (card) => card.querySelector('.p86-mline-body');

  test('the CONTROL: clicking the card itself DOES expand it', () => {
    // Without this, "the magnifier did not expand it" could be true because
    // nothing in this harness can expand anything.
    const card = host.querySelectorAll('.p86-mline')[1];
    card.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(bodyOf(card).style.display).toBe('block');
    expect(card.classList.contains('is-open')).toBe(true);
  });

  test('clicking the magnifier leaves every card exactly as it was', () => {
    const cards = [...host.querySelectorAll('.p86-mline')];
    const before = cards.map((c) => bodyOf(c).style.display + '|' + c.className);
    cards[1].querySelector('.p86-mline-zoom')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(cards.map((c) => bodyOf(c).style.display + '|' + c.className)).toEqual(before);
    expect(cards[1].classList.contains('is-open')).toBe(false);
  });

  test('...and the press still reached the map', () => {
    // The stopPropagation must swallow the bubble, not the action.
    const cards = [...host.querySelectorAll('.p86-mline')];
    cards[2].querySelector('.p86-mline-zoom')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(sp.api.focus()).toBe('n3');
  });

  test('an OPEN card stays open when its magnifier is pressed', () => {
    const card = host.querySelectorAll('.p86-mline')[0];
    card.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(bodyOf(card).style.display).toBe('block');
    card.querySelector('.p86-mline-zoom')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(bodyOf(card).style.display).toBe('block');
  });
});

/* ═══ 4. THE UNTRACED BUILDING — JOHN'S OWN SCREENSHOT ══════════════════════ */

describe('a building that has never been traced', () => {
  test('the press does NOT move the camera and does NOT report success', () => {
    const sp = makeSitePlan({ nodes: threeNodes([]), origin: ORIGIN, originGraph: OG });
    const before = JSON.stringify(sp.camera());
    expect(sp.api.zoom('b-one')).toBe(false);
    expect(JSON.stringify(sp.camera())).toBe(before);
    sp.teardown();
  });

  test('it says so, on screen, naming the building and the next action', () => {
    const sp = makeSitePlan({ nodes: threeNodes([]), origin: ORIGIN, originGraph: OG });
    sp.api.zoom('b-two');
    const hint = sp.api.hint();
    expect(hint).toBeTruthy();
    expect(hint.style.display).toBe('block');            // actually visible
    expect(hint.textContent).toContain('B2');            // names the building
    expect(hint.textContent).toContain('Trace Building');// names what to do next
    expect(sp.rec.toasts.join(' ')).toContain('B2');
    sp.teardown();
  });

  test('it selects the building, so Trace Building re-traces THAT one', () => {
    // toggleTraceMode reads selN: "A selected building → re-trace its
    // footprint". Offering the next action means arming it, not just naming it.
    const sp = makeSitePlan({ nodes: threeNodes([]), origin: ORIGIN, originGraph: OG });
    sp.api.zoom('b-three');
    expect(sp.api.sel()).toBe('n3');
    sp.teardown();
  });

  test('the traced and untraced outcomes are VISIBLY different', () => {
    // The whole point. Same button, same job, one building traced and one not:
    // the user must be able to tell which happened without guessing.
    const sp = makeSitePlan({ nodes: threeNodes(['b-one']), origin: ORIGIN, originGraph: OG });
    const start = JSON.stringify(sp.camera());

    expect(sp.api.zoom('b-one')).toBe(true);
    const movedTo = JSON.stringify(sp.camera());
    expect(movedTo).not.toBe(start);
    const hintAfterHit = sp.api.hint();
    expect(hintAfterHit === null || hintAfterHit.style.display === 'none').toBe(true);
    const toastsAfterHit = sp.rec.toasts.length;

    expect(sp.api.zoom('b-two')).toBe(false);
    expect(JSON.stringify(sp.camera())).toBe(movedTo);          // camera did NOT move
    expect(sp.api.hint().style.display).toBe('block');          // banner appeared
    expect(sp.rec.toasts.length).toBe(toastsAfterHit + 1);      // and it spoke
    sp.teardown();
  });

  test('a building with no graph node at all is honest too, not a crash', () => {
    const sp = makeSitePlan({ nodes: [], origin: ORIGIN, originGraph: OG });
    expect(sp.api.zoom('b-one')).toBe(false);
    expect(sp.api.hint().style.display).toBe('block');
    expect(sp.api.hint().textContent).toContain('B1');
    expect(sp.rec.toasts.length).toBe(1);
    sp.teardown();
  });

  test('traced, but the job has no geocode — still honest, still no camera move', () => {
    const sp = makeSitePlan({ nodes: threeNodes(), origin: null, originGraph: OG });
    const before = JSON.stringify(sp.camera());
    expect(sp.api.zoom('b-one')).toBe(false);
    expect(JSON.stringify(sp.camera())).toBe(before);
    expect(sp.api.hint().style.display).toBe('block');
    expect(sp.rec.toasts.length).toBe(1);
    sp.teardown();
  });

  test('a polygon of two corners is NOT a footprint — the renderer\'s own rule', () => {
    // renderNodes skips a t1 unless polygon.length >= 3. Anything looser here
    // and the magnifier would frame a building the map does not draw.
    const nodes = threeNodes([]);
    nodes[0].geoLatLng = { lat: 28.501, lng: -81.401 };
    nodes[0].polygon = footprintAt(28.501, -81.401).slice(0, 2);
    const sp = makeSitePlan({ nodes, origin: ORIGIN, originGraph: OG });
    const before = JSON.stringify(sp.camera());
    expect(sp.api.zoom('b-one')).toBe(false);
    expect(JSON.stringify(sp.camera())).toBe(before);
    sp.teardown();
  });

  test('the guard the magnifier uses is the same string the renderer uses', () => {
    // Two copies of a predicate drift. Both are read out of the shipped file.
    expect(UI_SRC).toContain("n.type==='t1' && !(n.polygon && n.polygon.length>=3)");
    expect(UI_SRC).toContain('function buildingIsTraced(n){ return !!(n && n.polygon && n.polygon.length>=3); }');
  });
});

/* ═══ 5. EVERY ID SHAPE THIS APP CAN MINT ══════════════════════════════════ */

/* Every id shape a building record in this app can actually carry. Building
 * ids are minted in exactly three places and all three mint `'b' + Date.now()`
 * (js/jobs.js:6865, nodegraph/engine.js:199, nodegraph/ui.js orphan self-heal),
 * so the live shape is a string — but ids reach these surfaces from imports,
 * server rows and hand edits too, which is why the hostile shapes are here. */
const ID_SHAPES = [
  ['a plain slug', 'b-one'],
  ['a minted id', 'b1757200000000'],
  ['a number that arrived as a string', '7'],
  ['a uuid', '3f1a2b4c-90de-4f11-8a77-0c1d2e3f4a5b'],
  ['one carrying an apostrophe', "b'1"],
  ['the injection that broke the estimate editor', "1);alert(1);//"],
  ['one carrying a C0 control character', 'x\u0001y'],
  ['one shaped like markup', '<img src=x onerror=alert(1)>'],
  ['one with a double quote', 'b"2'],
  ['one with a backslash', 'b\\2'],
  ['non-ascii', 'edificio-ñ'],
];

describe('every id shape reaches the map intact', () => {
  test.each(ID_SHAPES)('%s', (_label, id) => {
    APP.appData.buildings = [{ id, jobId: 'J1', name: 'B1' }];
    APP.budgets = { [id]: { amount: 1000, derived: false } };
    APP.pcts = {}; APP.wired = {}; APP.cos = {};

    let hostile = 0;
    window.__hostile = () => { hostile++; };
    const got = [];
    window.p86ZoomBuildingOnMap = (v) => { got.push(v); return true; };

    renderFrom(JOBS_SRC)('J1', 'insp-buildings');
    host.querySelector('.p86-mline-zoom')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    // The handler hands the map the id, and nothing else executed on the way.
    expect(got).toEqual([String(id)]);
    expect(hostile).toBe(0);
    // And what the parser compiled was p86Dec + an alphabet, never the bytes.
    const onclick = host.querySelector('.p86-mline-zoom').getAttribute('onclick');
    expect(onclick).toContain("p86Dec('" + DOM.enc(String(id)) + "')");
    expect(DOM.isEncoded(DOM.enc(String(id)))).toBe(true);

    delete window.__hostile;
    delete window.p86ZoomBuildingOnMap;
  });

  test.each(ID_SHAPES)('%s resolves to ITS OWN node on the map', (_label, id) => {
    // The other half: arriving intact is worthless if the lookup then misses.
    // Ids arrive as number OR string across surfaces, so a node minted with a
    // numeric data.id must still be found by the stringified id the handler
    // hands over.
    APP.appData.buildings = [
      { id, jobId: 'J1', name: 'B1' },
      { id: 'decoy', jobId: 'J1', name: 'Decoy' },
    ];
    APP.budgets = {}; APP.pcts = {}; APP.wired = {}; APP.cos = {};
    const mine = {
      id: 'nMine', type: 't1', label: 'B1', data: { id },
      geoLatLng: { lat: 28.501, lng: -81.401 }, polygon: footprintAt(28.501, -81.401), budget: 1000,
    };
    const decoy = {
      id: 'nDecoy', type: 't1', label: 'Decoy', data: { id: 'decoy' },
      geoLatLng: { lat: 28.505, lng: -81.395 }, polygon: footprintAt(28.505, -81.395), budget: 1000,
    };
    const sp = makeSitePlan({ nodes: [decoy, mine], origin: ORIGIN, originGraph: OG });
    expect(sp.api.zoom(String(id))).toBe(true);
    expect(sp.api.focus()).toBe('nMine');
    const c = polygonCentre(mine.polygon, ORIGIN, OG);
    const { pan, zoom } = sp.camera();
    expect((pan.x + c.x) * zoom).toBeCloseTo(600, 6);
    sp.teardown();
  });

  test('nothing the value carries can close the string literal it sits in', () => {
    // The property is NOT "the bytes are absent" — `);alert(1);//` is harmless
    // INSIDE a JavaScript string literal, and p86Enc deliberately leaves it
    // alone. The property is that the value cannot LEAVE that literal: the
    // encoder's output carries no apostrophe, no backslash and no control
    // character, so the parser compiles one call and an alphabet.
    for (const [, id] of ID_SHAPES) {
      APP.appData.buildings = [{ id: String(id), jobId: 'J1', name: 'B1' }];
      APP.budgets = {}; APP.pcts = {}; APP.wired = {}; APP.cos = {};
      renderFrom(JOBS_SRC)('J1', 'insp-buildings');
      const onclick = host.querySelector('.p86-mline-zoom').getAttribute('onclick');
      const inner = onclick.slice(onclick.indexOf("p86Dec('") + 8, onclick.lastIndexOf("')"));
      expect(inner).not.toMatch(/['\\]|[\u0000-\u001f\u007f\u2028\u2029]/);
      expect(() => new Function(onclick)).not.toThrow();   // it parses as JavaScript
      expect(DOM.dec(inner)).toBe(String(id));             // and decodes back to the id
    }
  });

  test('THE KNOWN LIMIT: a NUMERIC building id never reaches the button at all', () => {
    // Asserted rather than hidden. js/jobs.js:4451 builds the card's expand
    // id as `building.id.replace(/\W/g,'_')`, which throws on a number — the
    // whole card dies before the magnifier is painted, and that is true with
    // or without this change. No shipped path mints a numeric building id, so
    // this is a pre-existing latent defect, not a regression, and it is out of
    // scope for a button. If someone widens the id contract, THIS test tells
    // them the paint corpus above must widen with it.
    APP.appData.buildings = [{ id: 7, jobId: 'J1', name: 'B1' }];
    APP.budgets = {}; APP.pcts = {}; APP.wired = {}; APP.cos = {};
    expect(() => renderFrom(JOBS_SRC)('J1', 'insp-buildings'))
      .toThrow(/replace is not a function/);
    expect(JOBS_SRC).toContain("building.id.replace(/\\W/g, '_')");
    // The map side, meanwhile, DOES handle it: a node minted from a server row
    // with a numeric data.id is still found by the stringified id.
    const n = {
      id: 'nNum', type: 't1', label: 'B1', data: { id: 7 },
      geoLatLng: { lat: 28.501, lng: -81.401 }, polygon: footprintAt(28.501, -81.401), budget: 1000,
    };
    const sp = makeSitePlan({ nodes: [n], origin: ORIGIN, originGraph: OG });
    expect(sp.api.zoom('7')).toBe(true);
    expect(sp.api.focus()).toBe('nNum');
    sp.teardown();
  });
});

/* ═══ 6. NO MONEY MOVED ════════════════════════════════════════════════════ *
 * By BYTE DIFF, not by assertion. The same renderer is compiled twice: once
 * as it ships, and once with the button mechanically cut out of its own
 * source. Cut the buttons out of the first one's output and the two must be
 * identical — every dollar, every percent, every allocation, the strip totals
 * and the CO rows included. A single changed digit anywhere fails this. */

/* The removal has to be exact, so it is two unambiguous cuts, each of which
 * throws rather than degrading if the source it is cutting has moved. */
function withoutButtonSource() {
  let src = JOBS_SRC;
  const paint = '\r\n                            zoomBtn +';
  if (src.split(paint).length - 1 !== 1) throw new Error('paint site is not unique');
  src = src.split(paint).join('');
  const a = src.indexOf('                const zoomBtn = ');
  const b = src.indexOf("+ '</button>';", a);
  if (a === -1 || b === -1) throw new Error('declaration not found');
  const end = src.indexOf('\r\n', b) + 2;
  return src.slice(0, a) + src.slice(end);
}

describe('not one figure on any card moves', () => {
  const BUTTONS = /<button type="button" class="p86-mline-zoom"[\s\S]*?<\/button>/g;

  test('with the button, and with it cut out, the bytes are IDENTICAL', () => {
    const withBtn = (() => { renderFrom(JOBS_SRC)('J1', 'insp-buildings'); return host.innerHTML; })();
    const withoutSrc = withoutButtonSource();
    expect(withoutSrc).not.toContain('zoomBtn');            // the cut really happened
    const without = (() => { renderFrom(withoutSrc)('J1', 'insp-buildings'); return host.innerHTML; })();

    const stripped = withBtn.replace(BUTTONS, '');
    expect((withBtn.match(BUTTONS) || []).length).toBe(3);  // one per building
    expect(stripped).toBe(without);
  });

  test('...and the diff is not vacuous — the corpus really carries money', () => {
    renderFrom(JOBS_SRC)('J1', 'insp-buildings');
    const html = host.innerHTML;
    // per-card hero budgets
    expect(html).toContain('$18,250.75');
    expect(html).toContain('$9,000.00');
    // the allocation strip: Allocated / Unallocated / Spent / Remaining
    expect(html).toContain('$27,250.75');                   // allocated
    expect(html).toContain('$12,749.25');                   // unallocated gap
    // a CO allocation, and a scope allocation percentage
    expect(html).toContain('CO-0001');
    expect(html).toContain('(75%)');
    expect(html).toContain('(60%)');
  });

  test('every money-bearing region survives the diff character for character', () => {
    // Named regions, so a failure says WHICH money moved rather than "bytes".
    const grab = (h, sel) => [...new window.DOMParser().parseFromString(h, 'text/html')
      .querySelectorAll(sel)].map((e) => e.textContent).join('␟');
    renderFrom(JOBS_SRC)('J1', 'insp-buildings');
    const withBtn = host.innerHTML;
    renderFrom(withoutButtonSource())('J1', 'insp-buildings');
    const without = host.innerHTML;
    for (const sel of ['.p86-mline-strip', '.p86-mline-hero', '.p86-mline-sub',
      '.p86-bldg-cost-row', '.p86-bldg-co-list', '.p86-bldg-chip-list', '.p86-mline-strip-note']) {
      expect(grab(withBtn, sel)).toBe(grab(without, sel));
    }
  });

  test('pressing the magnifier writes nothing to any record', () => {
    const sp = makeSitePlan({ nodes: threeNodes(['b-one']), origin: ORIGIN, originGraph: OG });
    const before = JSON.stringify(APP.appData);
    sp.api.zoom('b-one');        // traced   → frames it
    sp.api.zoom('b-two');        // untraced → honest miss
    sp.api.zoom('nope');         // unknown  → honest miss
    expect(JSON.stringify(APP.appData)).toBe(before);
    sp.teardown();
  });

  test('nor to the graph nodes it reads — geometry and budget untouched', () => {
    const nodes = threeNodes();
    const sp = makeSitePlan({ nodes, origin: ORIGIN, originGraph: OG });
    const before = JSON.stringify(nodes);
    APP.appData.buildings.forEach((b) => sp.api.zoom(b.id));
    expect(JSON.stringify(nodes)).toBe(before);
    sp.teardown();
  });
});
