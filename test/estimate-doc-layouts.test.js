// Estimate document layouts + takeoff levels.
//
// js/estimate-doc-layouts.js declares WHAT each document contains (an ordered
// list of section keys); js/estimate-preview.js owns one builder per key and
// walks the list. This test loads both in a vm sandbox with a synthetic
// estimate and renders all 6 proposal layouts and all 5 takeoff levels through
// the real print path.
//
// The point is the DECLARATIVE split: a layout that names a section key with no
// builder behind it renders a visible "[key could not be rendered]" stub rather
// than throwing, so without this test a typo in the registry would ship as a
// hole in a client-facing document that still looks basically fine.
//
// Kept honest per the standing rule about vacuous assertions: every layout
// assertion below names a distinguishing feature of THAT layout, so a build
// that quietly emitted the same letterhead for all six would fail rather than
// pass six times.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function makeSandbox() {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }
  };
  const win = {
    localStorage,
    location: { origin: 'https://example.test' },
    addEventListener() {},
    print() {},
    alert() {}
  };
  win.window = win;

  const sandbox = {
    window: win,
    localStorage,
    alert: () => {},
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    console: { log() {}, warn() {}, error() {} },
    Promise, Intl, Date, Math, JSON, setTimeout,
    isNaN, Number, String, Array, Object, parseFloat, parseInt
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const load = (rel) => vm.runInContext(
    fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel }
  );

  load('js/pricing-pipeline.js');
  load('js/estimate-doc-layouts.js');

  // Two INCLUDED groups (multi-group paths), one EXCLUDED group (so alternates,
  // service add-ons and the third option tier have something to draw), section
  // headers with their own markup, an assembly rollup line carrying a component
  // snapshot, and one line with an explicit unitSell.
  const EST = {
    id: 'e1',
    estimateNumber: 'EST-1042',
    title: 'Building 3 Roof Replacement',
    client: 'Sunset Ridge Management',
    community: 'Sunset Ridge Condominium Association',
    issue: 'Roof Replacement',
    propertyAddr: '400 Gulf Blvd, Clearwater, FL 33767',
    billingAddr: 'PO Box 55, Clearwater, FL 33758',
    salutation: 'Board',
    alternates: [
      { id: 'a1', name: 'Roofing', scope: 'Tear off to deck and install new shingle system.' },
      { id: 'a2', name: 'Gutters', scope: 'Replace all 6" seamless aluminum gutter and downspouts.' },
      { id: 'a3', name: 'Soffit Repair', scope: 'Repair damaged soffit panels.', excludeFromTotal: true }
    ]
  };
  const L = (o) => Object.assign({ estimateId: 'e1', unit: 'EA', markup: '' }, o);
  const LINES = [
    L({ id: 'h1', alternateId: 'a1', section: '__section_header__', description: 'Materials & Supplies Costs', markup: 20 }),
    L({ id: 'l1', alternateId: 'a1', description: 'Architectural shingles', qty: 42, unit: 'SQ', unitCost: 118.5 }),
    L({ id: 'l2', alternateId: 'a1', description: 'Synthetic underlayment', qty: 42, unit: 'SQ', unitCost: 22 }),
    L({ id: 'h2', alternateId: 'a1', section: '__section_header__', description: 'Direct Labor', markup: 35 }),
    L({
      id: 'l3', alternateId: 'a1', description: 'Install shingle roof system', qty: 42, unit: 'SQ', unitCost: 210,
      sourceAssemblyId: 9, assemblyBucket: 'labor',
      assemblyBreakdown: [
        { description: 'Roofer hours', qty_per_unit: 2.5, unit: 'HR', unit_cost: 46, cost_code: 'labor' },
        { description: 'Starter strip', qty_per_unit: 1.2, unit: 'LF', unit_cost: 1.85, cost_code: 'materials' }
      ]
    }),
    L({ id: 'h3', alternateId: 'a2', section: '__section_header__', description: 'Materials & Supplies Costs', markup: 20 }),
    L({ id: 'l4', alternateId: 'a2', description: '6" seamless gutter', qty: 380, unit: 'LF', unitCost: 6.4, unitSell: 9.15 }),
    L({ id: 'h4', alternateId: 'a3', section: '__section_header__', description: 'Subcontractors Costs', markup: 15 }),
    L({ id: 'l5', alternateId: 'a3', description: 'Soffit panel replacement', qty: 120, unit: 'LF', unitCost: 7.2 })
  ];

  win.appData = { estimates: [EST], estimateLines: LINES, currentEstimateId: 'e1' };
  win.p86Org = { branding: { logo_url: '/uploads/org-logo.png' } };
  win.p86Api = { isAuthenticated: () => false };
  win.getActiveEstimateForPreview = () => EST;

  load('js/estimate-preview.js');

  // The builders are private to the IIFE. Drive them through the public print
  // path and capture what it writes into the popup.
  let captured = null;
  win.open = function () {
    let buf = '';
    return { document: { write(s) { buf += s; }, close() { captured = buf; } } };
  };

  // printEstimate* builds inside Promise.all().then(), so flush before reading.
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const proposal = async (id) => {
    win.setEstimateDocLayout(id); captured = null;
    win.printEstimateProposal(); await flush(); return captured;
  };
  const takeoff = async (id) => {
    win.setEstimateTakeoffLevel(id); captured = null;
    win.printEstimateTakeoff(); await flush(); return captured;
  };

  return { win, store, proposal, takeoff, registry: win.p86EstimateDocLayouts };
}

let S;
beforeAll(() => { S = makeSandbox(); });

describe('document registry', () => {
  test('exposes 6 proposal layouts and 5 takeoff levels', () => {
    expect(S.registry.listProposals()).toHaveLength(6);
    expect(S.registry.listTakeoffs()).toHaveLength(5);
  });

  test('clamps an unknown id to the safe default instead of returning null', () => {
    // A retired layout id can outlive its registry entry in someone's
    // localStorage; that must degrade, not blank the preview.
    expect(S.registry.getProposal('retired-in-2027').id).toBe('letterhead');
    expect(S.registry.getTakeoff('nope').id).toBe('t1');
  });

  test('every declared section key resolves to a real builder', async () => {
    // The renderer emits "[key could not be rendered]" for an unknown or
    // throwing key. Nothing may hit that path.
    for (const layout of S.registry.listProposals()) {
      const html = await S.proposal(layout.id);
      expect(html).not.toMatch(/could not be rendered/);
    }
  });
});

describe('proposal layouts', () => {
  test('all six render substantial output with no leaked undefined/NaN', async () => {
    for (const layout of S.registry.listProposals()) {
      const html = await S.proposal(layout.id);
      expect(html.length).toBeGreaterThan(500);
      expect(html).not.toMatch(/undefined|\[object Object\]|NaN/);
    }
  });

  test('letterhead still emits the original AGX document', async () => {
    const html = await S.proposal('letterhead');
    expect(html).toMatch(/Proposal for /);
    expect(html).toMatch(/Assumptions, Clarifications and Exclusions/);
  });

  test('schedule of values numbers items continuously and subtotals each group', async () => {
    const html = await S.proposal('sov');
    // Item numbers are the identity a pay application later bills against.
    expect(html).toMatch(/class="c-no">1</);
    expect(html).toMatch(/class="c-no">4</);
    expect((html.match(/sub-row/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/Unit Price/);
    expect(html).toMatch(/Scheduled Value/);
  });

  test('base bid + alternates quarantines the excluded group AFTER the base bid', async () => {
    const html = await S.proposal('rfp');
    expect(html).toMatch(/Alternates/);
    expect(html).toMatch(/Unit Prices/);
    // The excluded group must not be priced into the base bid.
    expect(html.indexOf('Base Bid')).toBeLessThan(html.indexOf('Soffit Repair'));
  });

  test('options layout renders a card per group and flags one recommendation', async () => {
    const html = await S.proposal('options');
    expect((html.match(/class="tier[ "]/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(html).toMatch(/tier-badge/);
  });

  test('service quote offers excluded groups as checkbox add-ons', async () => {
    const html = await S.proposal('service');
    expect(html).toMatch(/Optional/);
    expect(html).toMatch(/doc-box/);
  });

  test('board presentation leads with a cover and signs by officer title', async () => {
    const html = await S.proposal('board');
    expect(html).toMatch(/doc-cover/);
    // A board signature block without a Title line comes back from counsel.
    expect(html).toMatch(/Title:/);
  });

  test('documents use the org branding logo, not the packaged AGX mark', async () => {
    const html = await S.proposal('sov');
    expect(html).toContain('/uploads/org-logo.png');
    expect(html).not.toContain('images/logo-color.png');
  });
});

describe('takeoff levels', () => {
  test('all five render substantial output with no leaked undefined/NaN', async () => {
    for (const level of S.registry.listTakeoffs()) {
      const html = await S.takeoff(level.id);
      expect(html.length).toBeGreaterThan(500);
      expect(html).not.toMatch(/undefined|\[object Object\]|NaN/);
    }
  });

  test('T5 field pull sheet contains NO pricing at all', async () => {
    const html = (await S.takeoff('t5')).replace(/<style>[\s\S]*?<\/style>/, '');
    expect(html).not.toMatch(/\$\d/);
    expect(html).toMatch(/doc-flag-field/);
  });

  test('T4 exposes cost and margin and is loudly flagged internal', async () => {
    const html = await S.takeoff('t4');
    expect(html).toMatch(/Unit Cost/);
    expect(html).toMatch(/Margin/);
    // The expensive mistake this system could make easy is a cost sheet
    // reaching a client. The badge is the guard.
    expect(html).toMatch(/doc-flag-internal/);
  });

  test('T3 explodes assembly components and scales qty by the parent line', async () => {
    const html = await S.takeoff('t3');
    expect(html).toContain('Roofer hours');
    expect(html).toContain('Starter strip');
    // 42 SQ x 2.5 HR per SQ = 105 — same math as the editor's breakdown strip.
    expect(html).toContain('>105<');
  });

  test('T2 pivots into a matrix', async () => {
    expect(await S.takeoff('t2')).toMatch(/matrix-table/);
  });

  test('T1 collapses to one row per scope group', async () => {
    expect(await S.takeoff('t1')).toMatch(/Covers/);
  });

  test('levels the model cannot fully back print their gap on the document', async () => {
    // Honesty is the contract: `status: partial` must reach the reader, not
    // just the registry comment.
    for (const level of S.registry.listTakeoffs()) {
      const html = await S.takeoff(level.id);
      if (level.status === 'partial') expect(html).toMatch(/Known gap/);
      else expect(html).not.toMatch(/Known gap/);
    }
  });
});

describe('preference persistence', () => {
  test('layout and level choices are written to localStorage', async () => {
    await S.proposal('board');
    await S.takeoff('t3');
    expect(S.store['p86-preview-doc-layout']).toBe('board');
    expect(S.store['p86-preview-takeoff-level']).toBe('t3');
  });
});
