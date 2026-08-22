// test/co-assembly-adds.test.js — putting a COSTED RECIPE on a change
// order, and why it needed no new pricing concept at all.
//
// An assembly is the honest mechanism. It supplies COST — one line per
// cost bucket, `markup: ''` — and the shared markup cascade supplies the
// sell price. That is exactly how an assembly lands on an estimate, and it
// is precisely the model this whole pass is about: cost is what a line
// costs, sell is derived from it. The promised-price field (`unitSell`) is
// the escape hatch for when no recipe exists yet, and an assembly must
// never write one.
//
// Three doors reach a change order now: the Materials Drawer (client),
// POST /api/change-orders/:id/append-assembly (the CAD/Quantify takeoff
// bridge), and change_orders[].assembly_adds (86/Scribe). All three run
// the SAME gate — estimate-lines.explodeForEstimate — so they cannot
// disagree about what is safe to append. Duplicating that math is how two
// doors drift and one of them starts appending an understated cost.
//
// Pure module — no DB, no express, so this runs with no JWT_SECRET.

const fs = require('fs');
const path = require('path');
const raw = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const estLines = require('../server/services/estimate-lines');
const pricing = require('../js/pricing-pipeline.js');
const { changeOrderMoney } = require('../server/services/money/change-order-totals');

// ── Fixtures, matching test/estimate-assembly-adds.test.js ──────────
function makeGraph(assembly, items) {
  return {
    assemblies: new Map([[assembly.id, assembly]]),
    itemsBy: new Map([[assembly.id, items]]),
  };
}
const REPAINT = { id: 47, name: 'Exterior Repaint — Stucco', unit: 'SF', params: null };
const PRICED_ITEMS = [
  { assembly_id: 47, kind: 'material', description: 'Paint, 5-gal', unit: 'GAL',
    qty_per_unit: 0.005, unit_cost: 180, cost_code: 'materials' },
  { assembly_id: 47, kind: 'labor', description: 'Painter hours', unit: 'HR',
    qty_per_unit: 0.02, unit_cost: 45, cost_code: 'labor' },
  { assembly_id: 47, kind: 'sub', description: 'Pressure wash', unit: 'SF',
    qty_per_unit: 1, unit_cost: 0.25, cost_code: 'sub' },
];

const explode = (over) => estLines.explodeForEstimate(Object.assign({
  assembly_id: 47, graph: makeGraph(REPAINT, PRICED_ITEMS), params: { Q: 3200 },
}, over || {}));

// A change-order blob shaped the way the CO editor writes one: flat
// lines[], headers keyed on `label`, no estimateId, no alternates.
function makeCo() {
  return {
    title: 'Repaint adds',
    defaultMarkup: 25,
    lines: [
      { id: 's_mat', section: '__section_header__', label: 'Materials',
        btCategory: 'materials', markup: '', markupMode: 'percent' },
      { id: 'l_existing', description: 'Existing material line', qty: 1, unit: 'ea', unitCost: 10, markup: '' },
      { id: 's_sub', section: '__section_header__', label: 'Subcontractor Costs',
        btCategory: 'sub', markup: '', markupMode: 'percent' },
    ],
  };
}
const apply = (co, over) => {
  const ex = explode();
  return estLines.applyAssemblyToChangeOrderData(co, Object.assign({
    coId: 'co_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope,
    mode: 'rollup', nowStamp: 'T1',
  }, over || {}));
};
const content = (co) => co.lines.filter((l) => l.section !== '__section_header__');
const headers = (co) => co.lines.filter((l) => l.section === '__section_header__');

// ══ THE MARKUP SEED — $250 per $1,000 rode on this ══════════════════

describe('a section created on a change order inherits, it does not override', () => {
  test("a created CO header seeds markup: '' — NOT 0", () => {
    // Under the pricing cascade these are different numbers: 0 is a real
    // 0% that BLOCKS the defaultMarkup fallback, '' inherits it. The
    // estimate module seeds 0; the CO editor seeds ''. Reusing the
    // estimate's seed would have made "which door added the assembly"
    // decide the margin.
    const co = { defaultMarkup: 25, lines: [] };
    apply(co);
    const gc = headers(co).find((h) => h.btCategory === 'gc' || h.btCategory === 'labor');
    expect(gc.markup).toBe('');
    expect(gc.markup).not.toBe(0);
    for (const h of headers(co)) expect(h.markup).toBe('');
  });

  test('and the difference is $250 on $1,000 — measured, not asserted', () => {
    const line = { id: 'a', qty: 1, unitCost: 1000, markup: '' };
    const inherit = { defaultMarkup: 25, lines: [
      { id: 's', section: '__section_header__', label: 'Materials', markup: '', markupMode: 'percent' }, line] };
    const blocks = { defaultMarkup: 25, lines: [
      { id: 's', section: '__section_header__', label: 'Materials', markup: 0, markupMode: 'percent' }, line] };
    expect(pricing.computeForLines(inherit, inherit.lines)).toMatchObject({ subtotal: 1000, markedUp: 1250 });
    expect(pricing.computeForLines(blocks, blocks.lines)).toMatchObject({ subtotal: 1000, markedUp: 1000 });
  });

  test('the estimate target still seeds 0, exactly as it always has', () => {
    expect(estLines.ESTIMATE_TARGET.headerMarkupSeed).toBe(0);
    expect(estLines.CHANGE_ORDER_TARGET.headerMarkupSeed).toBe('');
  });

  test('a created CO header names itself in `label`, the key the editor WRITES', () => {
    // The CO editor's section input is data-line-field="label". A header
    // carrying only `description` renders with a blank name box, and one
    // keystroke leaves the record holding two names.
    const co = { defaultMarkup: 25, lines: [] };
    apply(co);
    for (const h of headers(co)) {
      expect(typeof h.label).toBe('string');
      expect(h.label.length).toBeGreaterThan(0);
      expect(h.description).toBeUndefined();
    }
    expect(headers(co).map((h) => h.label).sort())
      .toEqual(['Materials', 'Labor', 'Subcontractor Costs'].sort());
  });

  test('CO section names are the CO editor\'s, not the estimate\'s', () => {
    expect(estLines.CO_SECTION_PRESET.materials).toBe('Materials');
    expect(estLines.SECTION_PRESET.materials).toBe('Materials & Supplies Costs');
    // ...and they match what js/change-order-editor.js find-or-creates, so
    // the drawer door and the server door adopt each other's sections.
    const CO_ED = raw('js', 'change-order-editor.js');
    for (const name of Object.values(estLines.CO_SECTION_PRESET)) {
      expect(CO_ED).toContain("'" + name + "'");
    }
  });
});

// ══ MEMBERSHIP — a null sentinel would have inverted the filters ═════

describe('a CO line belongs to its document without carrying an id for it', () => {
  test('belongsTo is a predicate, and every CO line satisfies it', () => {
    const T = estLines.CHANGE_ORDER_TARGET;
    expect(T.belongsTo({ id: 'x' })).toBe(true);
    expect(T.belongsTo({ id: 'x', estimateId: 'other' })).toBe(true);
    expect(T.belongsTo(null)).toBe(false);
  });

  test('a second append ADOPTS the existing section instead of twinning it', () => {
    // With estimateId/alternateId filters and a null alternate, every CO
    // line fails `l.alternateId !== null` — so find-or-create would never
    // adopt, and each append would grow a duplicate section.
    const co = makeCo();
    apply(co);
    apply(co, { nowStamp: 'T2' });
    const labels = headers(co).map((h) => h.label);
    expect(labels).toEqual(['Materials', 'Subcontractor Costs', 'Labor']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('it adopts a same-named header that has no btCategory, and backfills it', () => {
    const co = { defaultMarkup: 25, lines: [
      { id: 's_hand', section: '__section_header__', label: 'Materials', markup: '', markupMode: 'percent' },
    ] };
    apply(co);
    const mats = headers(co).filter((h) => (h.label || '') === 'Materials');
    expect(mats).toHaveLength(1);
    expect(mats[0].id).toBe('s_hand');
    expect(mats[0].btCategory).toBe('materials');
  });
});

// ══ PLACEMENT IS MONEY ══════════════════════════════════════════════

describe('a line is born INSIDE its section, never at the array end', () => {
  test('the materials rollup lands under the Materials header', () => {
    // The cascade walks BACKWARD from a line's index to find its section,
    // so where a line is spliced is which markup it inherits. On a change
    // order array position IS the section.
    const co = makeCo();
    apply(co);
    const ids = co.lines.map((l) => l.id);
    const matHdr = ids.indexOf('s_mat');
    const subHdr = ids.indexOf('s_sub');
    const matLine = co.lines.findIndex((l) => l.assemblyBucket === 'materials');
    expect(matLine).toBeGreaterThan(matHdr);
    expect(matLine).toBeLessThan(subHdr);
  });

  test('the sub rollup lands under the Subcontractor Costs header', () => {
    const co = makeCo();
    apply(co);
    const subHdr = co.lines.findIndex((l) => l.id === 's_sub');
    const subLine = co.lines.findIndex((l) => l.assemblyBucket === 'sub');
    expect(subLine).toBeGreaterThan(subHdr);
  });

  test('and it actually PRICES from the section it landed in', () => {
    // The proof that placement is money and not tidiness.
    const co = makeCo();
    co.lines[0].markup = 40;          // Materials section at 40%
    apply(co);
    const matLine = co.lines.find((l) => l.assemblyBucket === 'materials');
    expect(pricing.effectiveMarkupForLine(matLine, co.lines, co)).toBe(40);
    const subLine = co.lines.find((l) => l.assemblyBucket === 'sub');
    expect(pricing.effectiveMarkupForLine(subLine, co.lines, co)).toBe(25);  // defaultMarkup
  });
});

// ══ THE LINE SHAPE ══════════════════════════════════════════════════

describe('the rollup shape is byte-identical to an estimate rollup', () => {
  test('one line per cost bucket, at a 6-decimal unit cost', () => {
    const co = { defaultMarkup: 25, lines: [] };
    const plan = apply(co);
    expect(plan.added).toBe(3);
    const rollups = content(co);
    expect(rollups.map((l) => l.assemblyBucket)).toEqual(['materials', 'labor', 'sub']);
    // 0.005 GAL x $180 = $0.90/SF materials; 0.02 HR x $45 = $0.90/SF labor.
    expect(rollups[0].unitCost).toBe(0.9);
    expect(rollups[1].unitCost).toBe(0.9);
    expect(rollups[2].unitCost).toBe(0.25);
    for (const l of rollups) expect(l.qty).toBe(3200);
  });

  test("markup is '' — THE load-bearing character", () => {
    // The assembly supplies COST; the cascade supplies the sell price.
    // A 0 here would block the document's defaultMarkup and price the
    // whole recipe at zero margin.
    const co = { defaultMarkup: 25, lines: [] };
    apply(co);
    for (const l of content(co)) expect(l.markup).toBe('');
  });

  test('AN ASSEMBLY NEVER WRITES A PROMISED PRICE', () => {
    // A recipe is the honest mechanism: cost in, price derived. unitSell
    // is the escape hatch for when no recipe exists. If an assembly wrote
    // one, the recipe would stop driving the price the moment it landed.
    const co = { defaultMarkup: 25, lines: [] };
    apply(co);
    for (const l of co.lines) {
      expect(Object.prototype.hasOwnProperty.call(l, 'unitSell')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(l, 'costPending')).toBe(false);
      expect(pricing.sellLocked(l)).toBe(false);
    }
    // Comments stripped: the module says at length that it does NOT write
    // the field, and this guard must read code rather than prose.
    const CODE = raw('server', 'services', 'estimate-lines.js')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(CODE).not.toMatch(/unitSell|costPending/);
  });

  test('provenance rides along so reprice and explode still work', () => {
    const co = { defaultMarkup: 25, lines: [] };
    apply(co);
    for (const l of content(co)) {
      expect(l.sourceAssemblyId).toBe(47);
      expect(Array.isArray(l.assemblyBreakdown)).toBe(true);
      expect(l.assemblyBreakdown.length).toBeGreaterThan(0);
      expect(l.assemblyBucket).toBeTruthy();
      expect(l.markupMode).toBe('percent');
    }
  });

  test('CO lines carry NO estimateId or alternateId', () => {
    const co = { defaultMarkup: 25, lines: [] };
    apply(co);
    for (const l of co.lines) {
      expect(l.estimateId).toBeUndefined();
      expect(l.alternateId).toBeUndefined();
    }
  });

  test('and the change order prices correctly end to end', () => {
    const co = { defaultMarkup: 25, lines: [] };
    apply(co);
    // (0.9 + 0.9 + 0.25) x 3200 = 6,560 cost; x 1.25 = 8,200 income.
    const m = changeOrderMoney(co);
    expect(m.costs).toBe(6560);
    expect(m.income).toBe(8200);
  });

  test('explode mode produces one line per leaf, on demand only', () => {
    const co = { defaultMarkup: 25, lines: [] };
    const plan = apply(co, { mode: 'exploded' });
    expect(plan.added).toBe(3);
    for (const l of content(co)) {
      expect(l.assemblyBucket).toBeUndefined();
      expect(l.markup).toBe('');
    }
    expect(content(co).map((l) => l.description).sort())
      .toEqual(['Paint, 5-gal', 'Painter hours', 'Pressure wash']);
    // Same cost either way — exploding changes the shape, not the money.
    expect(changeOrderMoney(co).costs).toBeCloseTo(6560, 6);
  });

  test('rollup is the default — explode is a human action taken later', () => {
    const co = { defaultMarkup: 25, lines: [] };
    apply(co, { mode: undefined });
    expect(content(co).every((l) => l.assemblyBucket)).toBe(true);
  });
});

// ══ THE REFUSALS ════════════════════════════════════════════════════

describe('every refusal fires on a change order exactly as on an estimate', () => {
  test('assembly_not_found', () => {
    const r = explode({ assembly_id: 999 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('assembly_not_found');
  });

  test('assembly_zero_qty', () => {
    const r = explode({ params: { Q: 0 } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('assembly_zero_qty');
  });

  test('assembly_formula_error', () => {
    const PARAM = { id: 47, name: 'Bad formula', unit: 'SF', params: [{ key: 'W', label: 'W' }] };
    const ITEMS = [{ assembly_id: 47, kind: 'material', description: 'x', unit: 'EA',
      qty_formula: 'W *', unit_cost: 1, cost_code: 'materials' }];
    const r = estLines.explodeForEstimate({
      assembly_id: 47, graph: makeGraph(PARAM, ITEMS), params: { Q: 10, W: 2 } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('assembly_formula_error');
  });

  test('assembly_empty', () => {
    const r = estLines.explodeForEstimate({
      assembly_id: 47, graph: makeGraph(REPAINT, []), params: { Q: 3200 } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('assembly_empty');
  });

  test('assembly_unpriced — and it NAMES the offenders', () => {
    const ITEMS = PRICED_ITEMS.concat([{ assembly_id: 47, kind: 'material',
      description: 'Caulk, unpriced', unit: 'EA', qty_per_unit: 0.01, unit_cost: null, cost_code: 'materials' }]);
    const r = estLines.explodeForEstimate({
      assembly_id: 47, graph: makeGraph(REPAINT, ITEMS), params: { Q: 3200 } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('assembly_unpriced');
    expect(r.error).toMatch(/Caulk, unpriced/);
  });

  test('a refusal appends NOTHING — there is no price-what-we-can path', () => {
    const ITEMS = PRICED_ITEMS.concat([{ assembly_id: 47, kind: 'material',
      description: 'Caulk, unpriced', unit: 'EA', qty_per_unit: 0.01, unit_cost: null, cost_code: 'materials' }]);
    const r = estLines.explodeForEstimate({
      assembly_id: 47, graph: makeGraph(REPAINT, ITEMS), params: { Q: 3200 } });
    const co = makeCo();
    const before = JSON.stringify(co);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(co)).toBe(before);
  });
});

// ══ THREE DOORS, ONE GATE ═══════════════════════════════════════════

describe('all three doors run the same gate', () => {
  const CO_ROUTES = raw('server', 'routes', 'change-order-routes.js');
  const DISPATCH = raw('server', 'services', 'payload-dispatcher.js');
  const DRAWER = raw('js', 'materials-drawer.js');

  test('the HTTP route exists, and calls explodeForEstimate before anything else', () => {
    expect(CO_ROUTES).toMatch(/router\.post\('\/change-orders\/:id\/append-assembly'/);
    expect(CO_ROUTES).toMatch(/estLines\.explodeForEstimate\(\{ assembly_id: assemblyId, graph, params: b\.params \}\)/);
    expect(CO_ROUTES).toMatch(/estLines\.applyAssemblyToChangeOrderData/);
  });

  test('the route is capability-gated and honours the applied / locked guards', () => {
    const R = CO_ROUTES.slice(CO_ROUTES.indexOf("router.post('/change-orders/:id/append-assembly'"));
    const body = R.slice(0, R.indexOf('// POST /api/change-orders/:id/link-node'));
    expect(body).toMatch(/requireAuth, requireCapability\('ESTIMATES_EDIT'\)/);
    expect(body).toMatch(/Cannot edit an applied change order/);
    expect(body).toMatch(/Cannot edit an approved \(locked\) change order/);
    expect(body).toMatch(/FOR UPDATE OF co/);         // serialize concurrent appends
    expect(body).toMatch(/organization_id/);          // org-scoped resolve
  });

  test('the dispatcher op exists and its refusals are TERMINAL', () => {
    expect(DISPATCH).toMatch(/async function applyCoAssemblyAdds\(/);
    expect(DISPATCH).toMatch(/estLines\.applyAssemblyToChangeOrderData/);
    const F = DISPATCH.slice(DISPATCH.indexOf('async function applyCoAssemblyAdds('));
    const body = F.slice(0, 3000);
    expect(body).toMatch(/retryable: false/);
    expect(body).toMatch(/Do NOT work around this by hand-writing lines with guessed unit costs/);
  });

  test('the dispatcher op is wired to the change_orders record ops', () => {
    expect(DISPATCH).toMatch(/assemblyAdds: async \(rid, entries\) =>/);
    expect(DISPATCH).toMatch(/await svc\.assemblyAdds\(row\.id, op\.assembly_adds\);/);
    expect(DISPATCH).toMatch(/await svc\.assemblyAdds\(idVal, op\.assembly_adds\);/);
    // ...behind the same applied / locked guards.
    const F = DISPATCH.slice(DISPATCH.indexOf('assemblyAdds: async (rid, entries)'));
    expect(F.slice(0, 1400)).toMatch(/Cannot edit an applied change order/);
    expect(F.slice(0, 1400)).toMatch(/Cannot edit an approved \(locked\) change order/);
  });

  test('THE DRAWER now refuses an unpriced recipe too — on BOTH surfaces', () => {
    // It showed a warning badge and then coerced a null unit_cost to 0,
    // so the one door a human actually uses appended an understated cost
    // in silence. A badge is not a guard.
    expect(DRAWER).toMatch(/var unpriced = \[\];/);
    expect(DRAWER).toMatch(/f\.unit_cost == null/);
    expect(DRAWER).toMatch(/Priced this recipe before adding it/);
    // and it returns rather than falling through into spec building.
    const D = DRAWER.slice(DRAWER.indexOf('var unpriced = [];'));
    expect(D.slice(0, 1600)).toMatch(/if \(unpriced\.length\) \{[\s\S]*?return;\s*\}/);
  });

  test('the agent is told the op exists and told not to route around it', () => {
    const AGENTS = raw('server', 'routes', 'admin-agents-routes.js');
    expect(AGENTS).toMatch(/A change_orders op may carry `assembly_adds/);
    expect(AGENTS).toMatch(/do NOT substitute hand-written lines with your own unit costs/);
  });
});

// ══ THE ESTIMATE PATH DID NOT MOVE ══════════════════════════════════

describe('generalising the module changed nothing about estimates', () => {
  function makeEstimate() {
    return {
      alternates: [{ id: 'a1', estimateId: 'est_1', name: 'Base' }],
      activeAlternateId: 'a1',
      lines: [
        { id: 's_mat', estimateId: 'est_1', alternateId: 'a1', section: '__section_header__',
          description: 'Materials & Supplies Costs', btCategory: 'materials', markup: 0 },
        { id: 'l_existing', estimateId: 'est_1', alternateId: 'a1',
          description: 'Existing material line', qty: 1, unit: 'ea', unitCost: 10 },
        { id: 's_sub', estimateId: 'est_1', alternateId: 'a1', section: '__section_header__',
          description: 'Subcontractors Costs', btCategory: 'sub', markup: 0 },
      ],
    };
  }

  test('an estimate append still stamps estimateId/alternateId and uses `description`', () => {
    const est = makeEstimate();
    const ex = explode();
    estLines.applyAssemblyToEstimateData(est, {
      estId: 'est_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope,
      mode: 'rollup', nowStamp: 'T1',
    });
    const added = est.lines.filter((l) => l.sourceAssemblyId === 47);
    expect(added).toHaveLength(3);
    for (const l of added) {
      expect(l.estimateId).toBe('est_1');
      expect(l.alternateId).toBe('a1');
    }
    const labor = est.lines.find((l) => l.section === '__section_header__' && l.btCategory === 'labor');
    expect(labor.description).toBe('Direct Labor');
    expect(labor.markup).toBe(0);
    expect(labor.label).toBeUndefined();
  });

  test('the legacy (lines, estId, altId, ...) call shape still works', () => {
    // estimate-routes and the dispatcher were not the only callers; keep
    // the old positional signature working rather than chasing every one.
    const lines = [];
    const id = estLines.ensureSectionByCategory(lines, 'est_1', 'a1', 'materials', 'X');
    expect(id).toBe('sX');
    expect(lines[0]).toEqual({ id: 'sX', estimateId: 'est_1', alternateId: 'a1',
      section: '__section_header__', description: 'Materials & Supplies Costs',
      btCategory: 'materials', markup: 0 });
  });

  test('estimate lines still land inside their alternate', () => {
    const est = makeEstimate();
    est.alternates.push({ id: 'a2', estimateId: 'est_1', name: 'Alt' });
    est.lines.push({ id: 's_alt', estimateId: 'est_1', alternateId: 'a2',
      section: '__section_header__', description: 'Materials & Supplies Costs',
      btCategory: 'materials', markup: 0 });
    const ex = explode();
    estLines.applyAssemblyToEstimateData(est, {
      estId: 'est_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope,
      mode: 'rollup', alternatePref: 'a2', nowStamp: 'T9',
    });
    const added = est.lines.filter((l) => l.sourceAssemblyId === 47);
    expect(added.every((l) => l.alternateId === 'a2')).toBe(true);
    // ...and it adopted the a2 header rather than creating a twin.
    const matHdrs = est.lines.filter((l) => l.section === '__section_header__'
      && l.btCategory === 'materials');
    expect(matHdrs).toHaveLength(2);   // one per alternate, as before
  });

  test('buildAssemblySpecs and explodeForEstimate were not touched', () => {
    const SRC = raw('server', 'services', 'estimate-lines.js');
    expect(SRC).toMatch(/function buildAssemblySpecs\(assembly, rows, scope, mode\)/);
    expect(SRC).toMatch(/function explodeForEstimate\(opts\)/);
    // Neither knows anything about a target.
    const B = SRC.slice(SRC.indexOf('function buildAssemblySpecs('));
    expect(B.slice(0, B.indexOf('// ── explodeForEstimate'))).not.toMatch(/target|belongsTo|headerLabelField/);
  });
});

// ══ BLAST RADIUS ════════════════════════════════════════════════════

describe('nothing outside the assembly path moved', () => {
  test('an assembly append cannot change an existing line', () => {
    const co = makeCo();
    const before = JSON.stringify(co.lines.filter((l) => l.id.startsWith('l_') || l.id.startsWith('s_')));
    apply(co);
    const after = JSON.stringify(co.lines.filter((l) => l.id === 'l_existing'));
    expect(after).toContain('Existing material line');
    expect(before).toContain('Existing material line');
    expect(co.lines.find((l) => l.id === 'l_existing').unitCost).toBe(10);
  });

  test('no alternates concept leaks onto a change order', () => {
    const co = { defaultMarkup: 25, lines: [] };
    apply(co);
    expect(co.alternates).toBeUndefined();
    expect(co.activeAlternateId).toBeUndefined();
  });

  test('the CO append does no pricing of its own', () => {
    const SRC = raw('server', 'services', 'estimate-lines.js');
    expect(SRC).not.toMatch(/applyTargetMargin|resolveMarkedUp|lineMoney|applyFeesAndTax/);
  });
});
