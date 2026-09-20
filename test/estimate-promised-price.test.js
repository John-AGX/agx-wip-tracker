// test/estimate-promised-price.test.js — ONE worksheet, EVERY path, one number.
//
// Project 86 imports Buildertrend estimate worksheets. Of 62 live worksheets
// 12 were REFUSED for one reason and all 19 offending lines were the same
// shape: Buildertrend lets an estimator type what the OWNER PAYS with the
// builder cost left at zero, markup type "2" — $20,000.00, $10,875.00,
// $49,750.00 — and a P86 estimate line was cost x (1 + markup), where no
// markup on a zero cost yields anything but zero. The import refused rather
// than carrying a $20,000 line in at $0.00.
//
// P86 already owned the field that answers it: a line's optional `unitSell`,
// the promised per-unit price, honoured by js/pricing-pipeline.js since it
// shipped. It was change-order-only by CONVENTION and by a guard test — not
// by the pricing code — because the ESTIMATE READERS priced by hand instead
// of through the pipeline and could not see it.
//
// ══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════
//
// An estimate priced one way by the editor's total chip and another way by
// the export is worse than one that never imported. So the property under
// test is not "the field works" — that is proven in test/co-sell-lock.test.js
// on the change-order side — but:
//
//     EVERY PATH THAT TURNS ESTIMATE LINES INTO MONEY AGREES, TO THE CENT,
//     ON A DOCUMENT THAT HOLDS BOTH A PROMISED LINE AND A DERIVED ONE.
//
// It is therefore exhaustive over the PATHS rather than over the cases. Each
// one is driven through its own real entry point — the shipped browser files
// in jsdom, the server modules by require — never re-implemented here:
//
//   P1  js/pricing-pipeline.js                      the reference
//   P2  server/services/money/estimate-totals.js    deal memory, the import proof
//   P3  js/estimates.js computeEstimateTotals       list, convert-to-job, lead cards
//   P4  js/estimates.js previewEstimate             the legacy modal js/leads.js opens
//   P5  js/estimate-editor.js computeTotals         the Proposal Total chip
//   P6  js/estimate-editor.js row + section paints  what the estimator reads
//   P7  js/estimate-preview.js computeTotal         the proposal document's total
//   P8  js/estimate-preview.js pricedTable          the proposal document's rows
//   P9  js/bt-export.js                             the Buildertrend xlsx
//   P10 server/services/clickr/estimate-match.js    the import's own verification
//
//   (P11, server/routes/ai-routes.js, produces PROSE rather than a document
//    total. Its wiring to the same pipeline is asserted in
//    test/co-income-call-sites.test.js; there is no number here to compare.)
//
// ══ AND WHAT IT DELIBERATELY DOES NOT CLAIM ════════════════════════════
// One PRE-EXISTING divergence between P6 and P8 survives this change and is
// asserted below as itself rather than left to be discovered: under a target
// margin the proposal's per-ROW unit prices are bottom-up while the editor's
// are scaled by the target factor. It predates the promised price, it is the
// same in both directions for a promised line (which neither marks up), and
// it is named here so it is not mistaken for this change's doing.

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const P = require('../js/pricing-pipeline.js');
const serverTotals = require('../server/services/money/estimate-totals');
const estMatch = require('../server/services/clickr/estimate-match');
const { readEstimateLine } = require('../server/services/clickr/field-map');
const H = require('./helpers/estimate-editor-harness.js');

const cents = (n) => Math.round(Number(n) * 100) / 100;
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// A rendered money cell back to a number. It strips EVERYTHING that is not
// part of a figure, because a promised row's Marked-Up cell carries the lock
// mark beside its amount — "$20,000.00●" — and a reader that only removed
// "$" and "," would silently produce NaN on exactly the rows this file is
// about.
const unMoney = (s) => Number(String(s).replace(/[^0-9.\-]/g, ''));

// ══════════════════════════════════════════════════════════════════════
// THE FIXTURE. One estimate, one group, one section, two lines:
//   • DERIVED  — 10 x $125.00 at 35%   → $1,687.50, priced from its cost
//   • PROMISED — 1 x $0.00 cost, $20,000.00 stated → $20,000.00
// The second is the live Buildertrend shape verbatim: a zero cost with a
// price typed for the owner.
// ══════════════════════════════════════════════════════════════════════
const DERIVED_SELL = 1687.5;
const PROMISED_SELL = 20000;
const BASE_COST = 1250;

function fixture(extra, lineExtra) {
  const est = Object.assign({
    id: 'e1', title: 'Structural Repairs', client: 'Citi Lakes',
    alternates: [{ id: 'a1', name: 'Base' }], activeAlternateId: 'a1',
  }, extra || {});
  const lines = [
    { id: 'h1', estimateId: 'e1', alternateId: 'a1', section: '__section_header__', description: 'Repairs', btCategory: 'labor', markup: 0 },
    { id: 'l1', estimateId: 'e1', alternateId: 'a1', description: 'Framing', qty: 10, unit: 'ea', unitCost: 125, markup: 35 },
    Object.assign({ id: 'l2', estimateId: 'e1', alternateId: 'a1', description: 'A. Structural Repairs at Building 9',
      qty: 1, unit: 'ls', unitCost: 0, markup: 0, unitSell: PROMISED_SELL }, lineExtra || {}),
  ];
  est.lines = lines;
  return { est, lines };
}

// The reference number, from the shared module and nothing else.
function reference(est, lines) {
  const group = lines.filter((l) => l.alternateId === est.activeAlternateId);
  const per = P.computeForLines(est, group);
  const markedUp = P.resolveTargetMargin(per, est);
  const fees = P.applyFeesAndTax(markedUp, est, P.sumOfPriced([per]));
  return { per, markedUp, total: fees.total };
}

// ── A jsdom window with the browser money files loaded, the way index.html
//    loads them. Nothing is stubbed that carries a number.
function browser() {
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
    '<div id="ee-tab-preview"></div><div id="estimatePreview_content"></div>' +
    '</body></html>',
    { runScripts: 'dangerously', url: 'https://project86.net/' });
  const w = dom.window;
  w.eval(`
    window.escapeHTML = function(s){ return String(s==null?'':s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); };
    window.appData = { estimates: [], estimateLines: [], phases: [] };
    appData = window.appData;
    window.saveData = function(){}; saveData = window.saveData;
    window.formatCurrency = function(n){
      return '$' + Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    window.openModal = function(){}; window.closeModal = function(){};
    window.__alerts = []; window.alert = function(m){ window.__alerts.push(String(m)); };
    window.p86Icon = function(){ return ''; };
    window.fetch = function(){ return Promise.reject(new Error('no net')); };
  `);
  let captured = null;
  w.XLSX = {
    utils: {
      aoa_to_sheet: (rows) => { captured = rows; return {}; },
      book_new: () => ({}), book_append_sheet: () => {},
    },
    writeFile: () => {},
  };
  const load = (rel) => {
    const s = w.document.createElement('script');
    s.textContent = fs.readFileSync(path.join(REPO, rel), 'utf8');
    w.document.body.appendChild(s);
  };
  ['js/dom-ref.js', 'js/pricing-pipeline.js', 'js/estimates.js',
    'js/estimate-doc-layouts.js', 'js/estimate-preview.js', 'js/bt-export.js'].forEach(load);
  return {
    w, dom,
    close() { try { dom.window.close(); } catch (e) {} },
    hydrate(est, lines) {
      const meta = Object.assign({}, est); delete meta.lines;
      w.appData.estimates.push(meta);
      w.appData.estimateLines = lines.slice();
      w.getActiveEstimateForPreview = function () { return meta; };
      return meta;
    },
    btRows() { return captured; },
  };
}

// P7/P8 — render the SOV proposal and read what it PRINTS.
function renderedProposal(b, meta) {
  b.w.setEstimateDocLayout('sov');
  b.w.renderEstimatePreview();
  return new Promise((resolve) => setTimeout(() => {
    const pane = b.w.document.getElementById('ee-tab-preview');
    const tot = pane.querySelector('.total-amount');
    const rows = Array.from(pane.querySelectorAll('.sov-table tbody tr'));
    const money = [];
    const subs = [];
    rows.forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll('td.c-money')).map((td) => unMoney(td.textContent));
      if (!cells.length) return;
      if (tr.classList.contains('sub-row')) subs.push(cells[cells.length - 1]);
      else money.push(cells);
    });
    resolve({ printedTotal: tot ? tot.textContent : null, rows: money, subtotals: subs });
  }, 30));
}

// P4 — the legacy modal js/leads.js's "Preview" button opens.
function legacyModal(b, meta) {
  b.w.previewEstimate(meta.id);
  const host = b.w.document.getElementById('estimatePreview_content');
  const clientPrice = unMoney(host.querySelector('div[style*="2ecc71"] span').textContent);
  const rowTotals = Array.from(host.querySelectorAll('tbody tr'))
    .map((tr) => tr.querySelectorAll('td'))
    .filter((tds) => tds.length === 5)
    .map((tds) => unMoney(tds[4].textContent));
  return { clientPrice, rowTotals, html: host.innerHTML };
}

// P9 — the Buildertrend xlsx, as an array of arrays.
function btExport(b, meta) {
  b.w.exportEstimateToBuildertrend(meta.id);
  return new Promise((resolve) => setTimeout(() => {
    const rows = b.btRows();
    const head = rows[0];
    const ix = (name) => head.indexOf(name);
    resolve({
      rows: rows.slice(1),
      clientPriceSum: cents(rows.slice(1).reduce((s, r) => s + r[ix('Client Price')], 0)),
      byDescription: Object.fromEntries(rows.slice(1).map((r) => [r[ix('Description')], {
        builderCost: r[ix('Builder Cost')], markup: r[ix('Markup')],
        markupType: r[ix('Markup Type')], clientPrice: r[ix('Client Price')],
        profit: r[ix('Profit')],
      }])),
    });
  }, 30));
}

// P5/P6 — the shipped editor in jsdom, through its own doors.
function editor(est, lines) {
  const h = H.boot();
  const rec = Object.assign({}, est, { lines: lines });
  h.hydrate(rec).open(est.id);
  const w = h.w;
  const chips = {};
  w.document.querySelectorAll('#ee-totals .p86-totals-chip').forEach((c) => {
    const l = c.querySelector('.p86-totals-chip-label');
    const v = c.querySelector('.p86-totals-chip-value');
    if (l && v) chips[l.textContent.trim()] = v.textContent.trim();
  });
  const rows = {};
  h.rows().forEach((r) => {
    const amt = r.el.querySelector('.ee-line-amount');
    if (!amt) return;
    const mkIn = r.el.querySelector('[data-cell="markup"] input');
    const mkRo = r.el.querySelector('[data-cell="markup"] .ee-markup-ro');
    const us = r.el.querySelector('[data-cell="unitSell"] input');
    rows[r.id] = {
      ext: unMoney(r.el.querySelector('.ee-line-ext').textContent),
      amount: unMoney(amt.textContent),
      promisedClass: /\bee-line-promised\b/.test(r.el.className),
      lockDot: !!amt.querySelector('.ee-line-lockdot'),
      markupEditable: !!mkIn,
      markupShown: mkIn ? mkIn.value : (mkRo ? mkRo.textContent.trim() : null),
      unitSellBox: us ? us.value : null,
      unitSellPlaceholder: us ? us.getAttribute('placeholder') : null,
    };
  });
  const sectionTotals = Array.from(w.document.querySelectorAll('.ee-section-total'))
    .map((e) => unMoney(e.textContent));
  const marginChip = w.document.getElementById('ee-margin-chip');
  const out = {
    chips, rows, sectionTotals, h, w,
    marginInput: marginChip ? marginChip.querySelector('#ee-margin-input').value : null,
    marginPromisedNote: marginChip && marginChip.querySelector('.ee-margin-promised')
      ? marginChip.querySelector('.ee-margin-promised').textContent.trim() : null,
    marginPromisedTitle: marginChip && marginChip.querySelector('.ee-margin-promised')
      ? marginChip.querySelector('.ee-margin-promised').getAttribute('title') : null,
  };
  return out;
}

afterEach(() => { H.closeAll(); });

// ══════════════════════════════════════════════════════════════════════
// 1 — THE THREE REAL FIGURES, imported and priced.
// ══════════════════════════════════════════════════════════════════════
describe('the live refusal: a Buildertrend price no percent can reach now imports', () => {
  // The three amounts off the live preview, in the shape that produced them:
  // markup type "2", builder cost $0.00, a price typed for the owner.
  const REAL = [
    ['A. Structural Repairs at Building 9', 20000],
    ['B. Structural Repairs at Building 14', 10875],
    ['C. Structural Repairs at Building 22', 49750],
  ];
  const btLine = (id, title, owner) => readEstimateLine({
    lineItemId: String(id), worksheetId: '9100', groupId: 'G1', groupTitle: 'Structural',
    displayOrder: id, itemTitle: title, quantity: 1, unitCost: 0, builderCost: 0,
    markupType: '2', markupPercent: 0, markupPerUnit: owner, markupAmount: owner,
    margin: 100, unitPrice: owner, ownerPrice: owner,
    jobId: '111', jobName: 'Citi Lakes', contractPrice: 100000, proposalStatus: 'Draft',
    worksheetLocked: false, isDeleted: false,
  });

  test('each one imports, and P86 prices it at Buildertrend’s own owner price EXACTLY', () => {
    REAL.forEach(([title, owner], i) => {
      const built = estMatch.buildLines([btLine(9101 + i, title, owner)], '9100');
      expect([title, built.refusals]).toEqual([title, []]);
      const l = built.lines.filter((x) => x.section !== '__section_header__')[0];
      // THE COST IS STILL THE COST. Buildertrend says $0.00 and P86 says
      // $0.00 — putting the quote in unitCost is the bug this field exists
      // to end, and it would book the whole $20,000 as job cost.
      expect([title, l.qty, l.unitCost, l.unitSell]).toEqual([title, 1, 0, owner]);
      // Priced through P86's OWN pipeline, not by an expression written here.
      expect([title, estMatch.p86PricedTotal(built.lines).clientPrice]).toEqual([title, owner]);
      // EXACT, not within a tolerance: a promise has no rounded percent to
      // forgive, so its tolerance is half a cent and its residual is zero.
      expect([title, built.tolerance]).toEqual([title, estMatch.EPS]);
    });
  });

  test('all three on ONE worksheet: the total is the sum, to the cent', () => {
    const live = REAL.map(([t, o], i) => btLine(9101 + i, t, o));
    const built = estMatch.buildLines(live, '9100');
    expect(built.refusals).toEqual([]);
    expect(built.promised).toHaveLength(3);
    const owner = estMatch.btOwnerTotal(live).total;
    expect(owner).toBe(80625);                       // 20000 + 10875 + 49750
    expect(estMatch.p86PricedTotal(built.lines).clientPrice).toBe(80625);
    // And the estimate's COST side is still nothing, which is what
    // Buildertrend says and what makes the profit expressible at all.
    expect(estMatch.p86PricedTotal(built.lines).baseCost).toBe(0);
    expect(estMatch.btCostTotal(live)).toBe(0);
  });

  test('the worksheet SAYS which lines were told their price rather than deriving it', () => {
    const live = REAL.map(([t, o], i) => btLine(9101 + i, t, o));
    const built = estMatch.buildLines(live, '9100');
    const note = estMatch.promisedSentence({ built });
    expect(note).toMatch(/3 of this worksheet’s lines carry a price Buildertrend states outright/);
    expect(note).toMatch(/“A\. Structural Repairs at Building 9” at \$20,000\.00/);
    expect(note).toMatch(/the cost stays exactly what Buildertrend says it is/);
    // The refusal note that used to describe a limit which no longer exists
    // is not what a person is shown for these lines.
    expect(note).not.toMatch(/rounded to two decimals/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2 — ONE WORKSHEET, EVERY PATH. The test that makes the change safe.
// ══════════════════════════════════════════════════════════════════════
describe('every estimate money path agrees to the cent', () => {
  // Every record-level lever that changes how a total is reached. The claim
  // is about the PATHS, so the document is varied and the claim is not.
  const SHAPES = [
    ['plain markup', {}],
    ['a target margin', { targetMargin: 30 }],
    ['fees and tax', { feeFlat: 250, feePct: 3, taxPct: 7 }],
    ['a target margin with fees and tax', { targetMargin: 25, feeFlat: 500, taxPct: 7 }],
    ['a round-up', { roundTo: 500 }],
    ['a document default markup the promise ignores', { defaultMarkup: 40 }],
  ];

  test.each(SHAPES)('%s — P1..P10 all report the same number', async (_name, extra) => {
    const { est, lines } = fixture(extra);
    const ref = reference(est, lines);

    // P1 — the reference itself, stated rather than assumed.
    expect(ref.per.lockedSell).toBe(PROMISED_SELL);
    expect(ref.per.lockedSubtotal).toBe(0);
    expect(cents(ref.markedUp)).toBe(cents(PROMISED_SELL + (est.targetMargin
      ? BASE_COST / (1 - est.targetMargin / 100)
      : DERIVED_SELL)));

    // P2 — the server module (deal memory, the clickr import proof).
    const t2 = serverTotals.computeEstimateTotals(est);
    expect(cents(t2.markedUp)).toBe(cents(ref.markedUp));
    expect(cents(t2.proposalTotal)).toBe(cents(ref.total));
    expect(t2.promisedSell).toBe(PROMISED_SELL);
    expect(t2.promisedCount).toBe(1);

    const b = browser();
    try {
      const meta = b.hydrate(est, lines);

      // P3 — js/estimates.js (the list, convert-to-job, the lead card).
      const t3 = b.w.computeEstimateTotals(meta);
      expect(cents(t3.markedUp)).toBe(cents(ref.markedUp));
      expect(cents(t3.proposalTotal)).toBe(cents(ref.total));

      // P4 — the legacy modal js/leads.js's Preview button opens.
      const t4 = legacyModal(b, meta);
      expect(t4.clientPrice).toBe(cents(ref.total));
      // Its rows price the promise at the promise, never at cost x markup.
      expect(t4.rowTotals).toEqual([DERIVED_SELL, PROMISED_SELL]);
      expect(t4.html).toMatch(/Promised price/);

      // P7 — the proposal document's printed total.
      const t7 = await renderedProposal(b, meta);
      expect(t7.printedTotal).toBe('$' + Math.round(ref.total).toLocaleString('en-US'));
      expect(t7.subtotals).toEqual([cents(ref.markedUp)]);

      // P8 — the proposal document's ROWS. The promised row is the promise,
      // in both the unit-price and the extension column.
      expect(t8Promised(t7)).toEqual([PROMISED_SELL, PROMISED_SELL]);

      // P9 — the Buildertrend xlsx.
      const t9 = await btExport(b, meta);
      expect(t9.clientPriceSum).toBe(cents(ref.total));
      const promisedRow = t9.byDescription['A. Structural Repairs at Building 9'];
      // A zero-cost promise round-trips to Buildertrend as what Buildertrend
      // sent: a FLAT amount, not a percent over nothing.
      expect([promisedRow.builderCost, promisedRow.markupType, promisedRow.clientPrice, promisedRow.profit])
        .toEqual([0, '$', PROMISED_SELL, PROMISED_SELL]);
    } finally { b.close(); }

    // P5 / P6 — the editor's chip, its rows and its section subtotal.
    const ed = editor(est, lines);
    expect(unMoney(ed.chips['Proposal Total'])).toBe(cents(ref.total));
    expect(unMoney(ed.chips.Subtotal)).toBe(BASE_COST);
    expect(ed.rows.l2.amount).toBe(PROMISED_SELL);
    expect(ed.sectionTotals).toEqual([cents(ref.markedUp)]);
    // The rows SUM to the group's marked-up total — promise included.
    expect(cents(ed.rows.l1.amount + ed.rows.l2.amount)).toBe(cents(ref.markedUp));

    // P10 — the import's own verification door, over the same lines.
    const t10 = estMatch.p86PricedTotal(lines.map((l) => Object.assign({}, l)));
    expect(cents(t10.markedUp)).toBe(cents(PROMISED_SELL + DERIVED_SELL));
  });

  // The promised row out of the proposal's SOV table: [unit price, extension].
  function t8Promised(t7) {
    return t7.rows[1];
  }

  test('THE PROMISED ROW IS THE PROMISE on every path, whatever the document does', async () => {
    // One assertion, gathered from every row-painting path at once. This is
    // the half a total cannot prove: a document total that is right while a
    // row is wrong is the exact shape that cost the change-order side a
    // median of $4,857.61 on 2.52% of client-priced records.
    for (const [, extra] of SHAPES) {
      const { est, lines } = fixture(extra);
      const b = browser();
      let printed;
      try {
        const meta = b.hydrate(est, lines);
        const legacy = legacyModal(b, meta);
        const doc = await renderedProposal(b, meta);
        const xls = await btExport(b, meta);
        printed = {
          legacy: legacy.rowTotals[1],
          proposalUnit: doc.rows[1][0],
          proposalExt: doc.rows[1][1],
          bt: xls.byDescription['A. Structural Repairs at Building 9'].clientPrice,
        };
      } finally { b.close(); }
      const ed = editor(est, lines);
      expect(Object.assign({ editor: ed.rows.l2.amount }, printed)).toEqual({
        editor: PROMISED_SELL, legacy: PROMISED_SELL,
        proposalUnit: PROMISED_SELL, proposalExt: PROMISED_SELL, bt: PROMISED_SELL,
      });
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2b — THE GROUP BOUNDARY. A row is priced against ITS OWN GROUP.
//
// Every fixture above this point is single-group, which is how the whole
// suite stayed green over a defect the export shipped with: buildExportRows
// handed p86Pricing.lineMoney `catMap.lines` — every INCLUDED group
// concatenated — while computeClientTotal below it priced strictly per
// group. p86Pricing.sectionHeaderFor walks BACKWARDS from a line's index
// and cannot see a group boundary, so a line that leads its own group
// adopted the PREVIOUS group's last section header.
//
// The column still summed to the document total, because pass 2 scales the
// rows onto it — so the only wrong number was the per-line Client Price the
// owner actually reads, and the sum is exactly the check that hid it. These
// tests therefore pin the ROWS and the TOTAL, never their agreement alone.
//
// It bites an estimate carrying NO promised line at all, so the first case
// below has none: it is collateral damage from routing this file through
// the shared cascade, not something the promised price introduced.
// ══════════════════════════════════════════════════════════════════════
describe('a row is priced against its own group, never the concatenation', () => {
  // Two INCLUDED groups. Group A opens with a section header; group B's
  // first CONTENT line precedes any header of its own — which is how a
  // Buildertrend worksheet imports ungrouped lines, how an agent `line_add`
  // without a subgroup arrives, and how legacy data already sits.
  function twoGroups(opts) {
    const o = opts || {};
    const est = Object.assign({
      id: 'e2', title: 'Two Decks', client: 'Citi Lakes', defaultMarkup: 0,
      alternates: [{ id: 'a1', name: 'Group A' }, { id: 'a2', name: 'Group B' }],
      activeAlternateId: 'a1',
    }, o.est || {});
    const lines = [
      { id: 'hA', estimateId: 'e2', alternateId: 'a1', section: '__section_header__', description: 'Sitework', btCategory: 'labor', markup: 50 },
      { id: 'lA', estimateId: 'e2', alternateId: 'a1', description: 'A line', qty: 1, unit: 'ea', unitCost: 100, markup: '' },
      { id: 'lB', estimateId: 'e2', alternateId: 'a2', description: 'B line', qty: 1, unit: 'ea', unitCost: 100, markup: '' },
    ];
    if (o.promised) {
      lines.push({ id: 'lP', estimateId: 'e2', alternateId: 'a2', description: 'A. Structural Repairs at Building 9',
        qty: 1, unit: 'ls', unitCost: 0, markup: 0, unitSell: PROMISED_SELL });
    }
    if (o.trailingSection) {
      lines.push({ id: 'hB', estimateId: 'e2', alternateId: 'a2', section: '__section_header__', description: 'Interiors', btCategory: 'labor', markup: 25 });
      lines.push({ id: 'lC', estimateId: 'e2', alternateId: 'a2', description: 'C line', qty: 1, unit: 'ea', unitCost: 100, markup: '' });
    }
    est.lines = lines;
    return { est, lines };
  }

  // The document total over MANY groups, from the shared module and nothing
  // else: resolveTargetMargin per included group, then one fee/tax/round-up.
  // This is what js/bt-export.js's computeClientTotal computes, so a row pass
  // that disagrees with it disagrees with the proposal.
  function multiGroupRef(est, lines) {
    const gids = est.alternates.filter((a) => !a.excludeFromTotal).map((a) => a.id);
    const pers = gids.map((gid) => P.computeForLines(est, lines.filter((l) => l.alternateId === gid)));
    const markedUp = pers.reduce((s, per) => s + P.resolveTargetMargin(per, est), 0);
    return { markedUp, total: P.applyFeesAndTax(markedUp, est, P.sumOfPriced(pers)).total };
  }

  // What the pipeline says a line is worth, priced against ITS OWN group —
  // the same slice computeClientTotal prices, and the same slice the editor's
  // getLines() paints from.
  const ownGroupSell = (est, lines, id) => {
    const l = lines.find((x) => x.id === id);
    return P.lineMoney(l, lines.filter((x) => x.alternateId === l.alternateId), est);
  };

  test('group B’s leading unsectioned line does NOT inherit group A’s header — with no promise anywhere', async () => {
    const { est, lines } = twoGroups();
    const b = browser();
    let xls;
    try {
      const meta = b.hydrate(est, lines);
      xls = await btExport(b, meta);
    } finally { b.close(); }

    // THE ROWS. A line is at its own section's 50%; B line has no section in
    // its own group, so it falls to the estimate default of 0%.
    expect(xls.byDescription['A line']).toMatchObject({ clientPrice: 150, markup: 50, markupType: '%' });
    expect(xls.byDescription['B line']).toMatchObject({ clientPrice: 100, markup: 0, markupType: '%' });
    // Stated as the invariant rather than as two literals: each row is what
    // the shared cascade prices it at against its OWN group.
    expect(xls.byDescription['A line'].clientPrice).toBe(cents(ownGroupSell(est, lines, 'lA').sell));
    expect(xls.byDescription['B line'].clientPrice).toBe(cents(ownGroupSell(est, lines, 'lB').sell));
    // AND the total, so no future change can "fix" the rows by moving it.
    const ref = multiGroupRef(est, lines);
    expect(xls.clientPriceSum).toBe(cents(ref.total));
    expect(cents(ref.total)).toBe(250);
  });

  test('the blast radius: group B’s shape cannot move group A’s prices', async () => {
    // The mis-sectioned line distorts the pass-2 scale DENOMINATOR, so every
    // row in the sheet shifts — including rows in a group that has nothing to
    // do with it. Group A is held identical across two shapes of group B.
    const priceOf = async (opts) => {
      const { est, lines } = twoGroups(opts);
      const b = browser();
      try {
        const meta = b.hydrate(est, lines);
        const xls = await btExport(b, meta);
        return { xls, est, lines };
      } finally { b.close(); }
    };
    const plain = await priceOf();
    const withTail = await priceOf({ trailingSection: true });
    expect(withTail.xls.byDescription['A line'].clientPrice)
      .toBe(plain.xls.byDescription['A line'].clientPrice);
    expect(withTail.xls.byDescription['A line'].clientPrice).toBe(150);
    // And group B’s own rows each read their own section: the leading line
    // still has none (0%), the line under 'Interiors' takes 25%.
    expect(withTail.xls.byDescription['B line']).toMatchObject({ clientPrice: 100, markup: 0 });
    expect(withTail.xls.byDescription['C line']).toMatchObject({ clientPrice: 125, markup: 25 });
    expect(withTail.xls.clientPriceSum).toBe(cents(multiGroupRef(withTail.est, withTail.lines).total));
  });

  test('a promise in the headerless group is carried at qty x unitSell, and the boundary still holds', async () => {
    const { est, lines } = twoGroups({ promised: true, trailingSection: true });
    const b = browser();
    let xls;
    try {
      const meta = b.hydrate(est, lines);
      xls = await btExport(b, meta);
    } finally { b.close(); }
    // The promise is exact and UNSCALED — the point of the whole change.
    expect(xls.byDescription['A. Structural Repairs at Building 9'])
      .toMatchObject({ builderCost: 0, markupType: '$', clientPrice: PROMISED_SELL, profit: PROMISED_SELL });
    // ...and it did not drag its neighbours onto another group's header.
    expect(xls.byDescription['A line'].clientPrice).toBe(150);
    expect(xls.byDescription['B line'].clientPrice).toBe(100);
    expect(xls.byDescription['C line'].clientPrice).toBe(125);
    ['lA', 'lB', 'lC'].forEach((id) => {
      const desc = lines.find((l) => l.id === id).description;
      expect({ id, price: xls.byDescription[desc].clientPrice })
        .toEqual({ id, price: cents(ownGroupSell(est, lines, id).sell) });
    });
    expect(xls.clientPriceSum).toBe(cents(multiGroupRef(est, lines).total));
    expect(xls.clientPriceSum).toBe(cents(PROMISED_SELL + 150 + 100 + 125));
  });

  test('with fees and tax on, every FREE row is its own-group price times ONE factor', async () => {
    // The scale is real here (not 1), which is what makes "one factor" a
    // claim worth pinning: a mis-sectioned row changes the denominator, so
    // the factors stop agreeing before any single row looks wrong.
    const { est, lines } = twoGroups({
      trailingSection: true,
      est: { feeFlat: 250, feePct: 3, taxPct: 7, roundTo: 5 },
    });
    const b = browser();
    let xls;
    try {
      const meta = b.hydrate(est, lines);
      xls = await btExport(b, meta);
    } finally { b.close(); }
    // ONE factor, asserted at the cent rather than derived from a rounded
    // cell: pass 2 spreads (target - promised) over the free rows, and with
    // no $-mode section a free row's baseRev IS its own-group sell. So the
    // scale is fully determined by the pipeline, and each row must be that
    // one scale applied to ITS OWN group's price. A mis-sectioned row moves
    // the denominator, so this fails before any single row looks wrong.
    const ref = multiGroupRef(est, lines);
    const ids = ['lA', 'lB', 'lC'];
    const free = ids.map((id) => ownGroupSell(est, lines, id).sell);
    const scale = ref.total / free.reduce((s, v) => s + v, 0);
    expect(scale).toBeGreaterThan(1);
    ids.forEach((id, i) => {
      const desc = lines.find((l) => l.id === id).description;
      expect({ id, price: xls.byDescription[desc].clientPrice })
        .toEqual({ id, price: cents(free[i] * scale) });
    });
    expect(xls.clientPriceSum).toBe(cents(multiGroupRef(est, lines).total));
  });

  test('the editor paints group B’s row at the same number the export sells it for', async () => {
    // getLines() is active-group-only (js/estimate-editor.js), so the editor
    // has always been group-correct. That is precisely why this defect was
    // invisible: the estimator’s screen and the owner’s spreadsheet
    // disagreed, and only the spreadsheet was wrong.
    const { est, lines } = twoGroups();
    const b = browser();
    let xls;
    try {
      const meta = b.hydrate(est, lines);
      xls = await btExport(b, meta);
    } finally { b.close(); }
    const edA = editor(Object.assign({}, est, { activeAlternateId: 'a1' }), lines);
    const edB = editor(Object.assign({}, est, { activeAlternateId: 'a2' }), lines);
    expect(edA.rows.lA.amount).toBe(xls.byDescription['A line'].clientPrice);
    expect(edB.rows.lB.amount).toBe(xls.byDescription['B line'].clientPrice);
    expect([edA.rows.lA.amount, edB.rows.lB.amount]).toEqual([150, 100]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3 — THE DISCRIMINATOR. 0 is a price; '' is not a price.
// ══════════════════════════════════════════════════════════════════════
describe('absence is the discriminator, and 0 is not absence', () => {
  test('unitSell: 0 is a REAL lock at $0 — the line is given away against a real cost', () => {
    const { est, lines } = fixture({}, { unitCost: 900, unitSell: 0 });
    expect(P.sellLocked(lines[2])).toBe(true);
    expect(P.promisedUnitSell(lines[2])).toBe(0);
    const ref = reference(est, lines);
    // Cost is real and counted; price is nothing.
    expect(ref.per.subtotal).toBe(BASE_COST + 900);
    expect(ref.per.lockedSell).toBe(0);
    expect(ref.per.lockedSubtotal).toBe(900);
    expect(cents(ref.markedUp)).toBe(DERIVED_SELL);
    // And EVERY path says the row is worth $0.00 rather than $900 x markup.
    const ed = editor(est, lines);
    expect([ed.rows.l2.ext, ed.rows.l2.amount, ed.rows.l2.promisedClass]).toEqual([900, 0, true]);
    expect(serverTotals.computeEstimateTotals(est).promisedCount).toBe(1);
    expect(serverTotals.computeEstimateTotals(est).promisedSell).toBe(0);
  });

  test("unitSell: '' is ABSENT — the line returns to cost x markup", () => {
    const { est, lines } = fixture({}, { unitCost: 900, markup: 20, unitSell: '' });
    expect(P.sellLocked(lines[2])).toBe(false);
    expect(P.promisedUnitSell(lines[2])).toBe(null);
    const ref = reference(est, lines);
    expect(ref.per.lockedSell).toBe(0);
    expect(ref.per.promisedCount).toBe(0);
    expect(cents(ref.markedUp)).toBe(cents(DERIVED_SELL + 900 * 1.2));
    const ed = editor(est, lines);
    expect([ed.rows.l2.amount, ed.rows.l2.promisedClass, ed.rows.l2.markupEditable])
      .toEqual([1080, false, true]);
    expect(serverTotals.computeEstimateTotals(est).promisedCount).toBe(0);
  });

  test('a line with NO unitSell key at all is absent — which is every estimate line that exists today', () => {
    const { est, lines } = fixture();
    delete lines[2].unitSell;
    expect(P.sellLocked(lines[2])).toBe(false);
    // Byte-identical to the number this estimate produced before the field
    // reached estimates: the branch never runs.
    expect(reference(est, lines).markedUp).toBe(DERIVED_SELL);
  });

  test('a unitSell typed into a BOX is a string, and a string is a promise', () => {
    // js/estimate-preview.js used to test `typeof line.unitSell === 'number'`
    // and therefore disagreed with the pipeline on exactly this shape: the
    // total honoured "20000" and the printed unit price showed the marked-up
    // COST instead. One rule, one answer.
    const { est, lines } = fixture({}, { unitSell: '20000' });
    expect(P.sellLocked(lines[2])).toBe(true);
    expect(P.promisedUnitSell(lines[2])).toBe(20000);
    expect(reference(est, lines).markedUp).toBe(DERIVED_SELL + PROMISED_SELL);
    return (async () => {
      const b = browser();
      try {
        const meta = b.hydrate(est, lines);
        const doc = await renderedProposal(b, meta);
        expect(doc.rows[1]).toEqual([PROMISED_SELL, PROMISED_SELL]);
      } finally { b.close(); }
    })();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4 — TARGET MARGIN. A promise is not something a margin target may restate.
// ══════════════════════════════════════════════════════════════════════
describe('a target margin does not mark up a promised line', () => {
  const TARGET = 30;
  // 20,000 promised + 1,250 of unpromised cost back-solved to 30% margin.
  const EXPECTED = 20000 + 1250 / 0.7;

  test('the carve-out, stated: the target applies to the UNPROMISED cost only', () => {
    const { est, lines } = fixture({ targetMargin: TARGET });
    const ref = reference(est, lines);
    expect(ref.markedUp).toBe(EXPECTED);
    // The number the un-ported path produced — every line's cost back-solved,
    // promise included — is a DIFFERENT number, so a missed site is a red
    // test rather than a silent under-report.
    const unported = P.applyTargetMargin(ref.per.subtotal, est);
    expect(cents(unported)).toBe(1785.71);
    expect(unported).not.toBe(EXPECTED);
  });

  test('the promised row is NOT scaled, and the rows still sum to the chip', () => {
    const { est, lines } = fixture({ targetMargin: TARGET });
    const ed = editor(est, lines);
    expect(ed.rows.l2.amount).toBe(PROMISED_SELL);            // untouched
    expect(cents(ed.rows.l1.amount)).toBe(cents(1250 / 0.7)); // the whole target lands here
    expect(cents(ed.rows.l1.amount + ed.rows.l2.amount)).toBe(cents(EXPECTED));
    expect(ed.sectionTotals).toEqual([cents(EXPECTED)]);
    expect(unMoney(ed.chips['Proposal Total'])).toBe(cents(EXPECTED));
  });

  test('THE CHIP AND THE PROPOSAL PRINT THE SAME NUMBER', async () => {
    const { est, lines } = fixture({ targetMargin: TARGET });
    const ed = editor(est, lines);
    const b = browser();
    try {
      const meta = b.hydrate(est, lines);
      const doc = await renderedProposal(b, meta);
      // The chip is to the cent; the proposal prints whole dollars. Same
      // number, formatted twice.
      expect(unMoney(ed.chips['Proposal Total'])).toBe(cents(EXPECTED));
      expect(doc.printedTotal).toBe('$' + Math.round(EXPECTED).toLocaleString('en-US'));
      expect(doc.subtotals).toEqual([cents(EXPECTED)]);
      expect(cents(b.w.computeEstimateTotals(meta).proposalTotal)).toBe(cents(EXPECTED));
    } finally { b.close(); }
  });

  test('WHAT THE TARGET MEANS is on screen, because it is no longer the document’s margin', () => {
    // 30% was asked of the unpromised work. The DOCUMENT lands at
    // (21,785.71 − 1,250) / 21,785.71 = 94.3%, because $20,000 of it was
    // promised against no cost. Printing "Target Margin 30.0%" alone would be
    // true about the instruction and misleading about the estimate.
    const { est, lines } = fixture({ targetMargin: TARGET });
    const ed = editor(est, lines);
    const docMargin = P.grossMarginPct(BASE_COST, EXPECTED);
    expect(ed.marginInput).toBe('30.0');
    expect(ed.marginPromisedNote).toBe('● ' + docMargin.toFixed(1) + '% doc');
    expect(ed.marginPromisedTitle).toMatch(/1 line on this estimate carries a promised Unit Sell worth \$20,000\.00/);
    expect(ed.marginPromisedTitle).toMatch(/carved out at face value and the target applies to the remaining cost/);
    expect(ed.marginPromisedTitle).toMatch(new RegExp('own gross margin is ' + docMargin.toFixed(1) + '%'));
  });

  test('A NEGATIVE UNPROMISED POOL still reconciles — a credit beside a promise', () => {
    // FOUND BY A MUTATION THAT DID NOT BITE. The target factor first shipped
    // as applyTargetMargin(free)/free guarded by `free > 0`, and a mutation
    // replacing its denominator with the whole subtotal changed nothing —
    // because applyTargetMargin is LINEAR and the two are the same number.
    // What the dead mutation was pointing at was the guard, which is not
    // scale-invariant and is false the moment the unpromised pool goes
    // negative: a credit line beside a promise.
    //
    //   $1,250 unpromised cost + a $2,000 credit + a $2,750 promise on
    //   $1,650 of cost, at a 30% target:
    //     free      = 1250 − 2000 = −750
    //     markedUp  = 2750 + (−750 / 0.7) = $1,678.57
    //     rows      = 1250/0.7 − 2000/0.7 + 2750  = $1,678.57
    //   The guarded version returned a factor of 1, so the rows came to
    //   $2,000.00 against a chip printing $1,678.57 — $321.43 apart, with
    //   the rows being the thing the estimator reads.
    const est = {
      id: 'e1', title: 'Credit + promise', targetMargin: 30,
      alternates: [{ id: 'a1', name: 'Base' }], activeAlternateId: 'a1',
    };
    const lines = [
      { id: 'h1', estimateId: 'e1', alternateId: 'a1', section: '__section_header__', description: 'Repairs', markup: 0 },
      { id: 'l1', estimateId: 'e1', alternateId: 'a1', description: 'Framing', qty: 10, unit: 'ea', unitCost: 125, markup: 35 },
      { id: 'lc', estimateId: 'e1', alternateId: 'a1', description: 'Credit — scope removed', qty: -1, unit: 'ls', unitCost: 2000, markup: 0 },
      { id: 'l2', estimateId: 'e1', alternateId: 'a1', description: 'Stucco at a promised price', qty: 1, unit: 'ls', unitCost: 1650, markup: 0, unitSell: 2750 },
    ];
    est.lines = lines;
    const EXPECT = 2750 + (-750 / 0.7);
    const ref = reference(est, lines);
    expect(ref.per.subtotal).toBe(900);
    expect(ref.per.lockedSubtotal).toBe(1650);
    expect(cents(ref.markedUp)).toBe(cents(EXPECT));
    expect(cents(EXPECT)).toBe(1678.57);

    // THE ROWS. Every one of them, summed, is the chip — including the credit,
    // which is scaled, and the promise, which is not.
    const ed = editor(est, lines);
    expect(ed.rows.l2.amount).toBe(2750);                    // the promise, untouched
    expect(cents(ed.rows.l1.amount)).toBe(cents(1250 / 0.7));
    expect(cents(ed.rows.lc.amount)).toBe(cents(-2000 / 0.7));
    expect(cents(ed.rows.l1.amount + ed.rows.lc.amount + ed.rows.l2.amount)).toBe(cents(EXPECT));
    expect(unMoney(ed.chips['Proposal Total'])).toBe(cents(EXPECT));
    expect(ed.sectionTotals).toEqual([cents(EXPECT)]);
    // The factor is the same number whatever pool it is measured over, which
    // is the property that makes the identity hold at every promise mix.
    expect(P.targetFactorFor(est)).toBe(1 / 0.7);
    expect(P.targetFactorFor({ targetMargin: 0 })).toBe(1);
  });

  test('with NO promised line the target margin is the document’s margin, unchanged', () => {
    // The whole legacy corpus. Nothing about it moves.
    const { est, lines } = fixture({ targetMargin: TARGET });
    delete lines[2].unitSell;
    lines[2].unitCost = 750;
    const ref = reference(est, lines);
    expect(ref.markedUp).toBe(P.applyTargetMargin(ref.per.subtotal, est));
    expect(cents(P.grossMarginPct(ref.per.subtotal, ref.markedUp))).toBe(30);
    const ed = editor(est, lines);
    expect(ed.marginPromisedNote).toBe(null);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5 — WHAT THE ESTIMATOR SEES.
// ══════════════════════════════════════════════════════════════════════
describe('a promised line is visibly a promised line', () => {
  test('the row carries the mark, and its markup box does not take keystrokes nothing reads', () => {
    const { est, lines } = fixture();
    const ed = editor(est, lines);
    expect(ed.rows.l2).toMatchObject({
      promisedClass: true,          // the row
      lockDot: true,                // beside the money
      markupEditable: false,        // the field that does nothing is not a field
      markupShown: 'promised',      // zero cost → no percent can be implied
      unitSellBox: '20000',
    });
    // The DERIVED line is untouched: its markup is still typeable and its
    // Unit Sell box is empty with the derived price as a placeholder.
    expect(ed.rows.l1).toMatchObject({
      promisedClass: false, lockDot: false, markupEditable: true,
      markupShown: '35', unitSellBox: '',
    });
    expect(ed.rows.l1.unitSellPlaceholder).toBe('168.75');
  });

  test('a promise over a REAL cost shows the percent it implies', () => {
    const { est, lines } = fixture({}, { unitCost: 1650, unitSell: 2750 });
    const ed = editor(est, lines);
    expect(ed.rows.l2.markupShown).toBe('66.7%');   // 2750/1650 − 1
    expect(ed.rows.l2.markupEditable).toBe(false);
    expect(ed.rows.l2.amount).toBe(2750);
    expect(ed.rows.l2.ext).toBe(1650);
  });

  test('typing a promise through the editor’s OWN door re-prices the document', () => {
    const { est, lines } = fixture();
    delete lines[2].unitSell;
    const ed = editor(est, lines);
    expect(unMoney(ed.chips['Proposal Total'])).toBe(DERIVED_SELL);
    const row = ed.h.rows().find((r) => r.id === 'l2');
    ed.h.typeInto(row.el, 'unitSell', '20000');
    const after = {};
    ed.w.document.querySelectorAll('#ee-totals .p86-totals-chip').forEach((c) => {
      const l = c.querySelector('.p86-totals-chip-label');
      const v = c.querySelector('.p86-totals-chip-value');
      if (l && v) after[l.textContent.trim()] = v.textContent.trim();
    });
    expect(unMoney(after['Proposal Total'])).toBe(DERIVED_SELL + PROMISED_SELL);
    expect(ed.h.lines().find((l) => l.id === 'l2').unitSell).toBe(20000);
    // And CLEARING it returns the line to cost x markup — blank is not zero,
    // so the field goes back to '' and the line un-locks.
    const row2 = ed.h.rows().find((r) => r.id === 'l2');
    ed.h.typeInto(row2.el, 'unitSell', '');
    expect(ed.h.lines().find((l) => l.id === 'l2').unitSell).toBe('');
    expect(P.sellLocked(ed.h.lines().find((l) => l.id === 'l2'))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6 — THE BLAST RADIUS. What this change may not have moved.
// ══════════════════════════════════════════════════════════════════════
describe('what a promised price on an estimate still may NOT do', () => {
  test('an ASSEMBLY still cannot mint one — the writer refuses the field', () => {
    // A recipe knows what something COSTS. It cannot know what was promised
    // for it, and a costed explode that invented a price would be a price
    // nobody quoted. Asserted on the module's own writable-key list.
    const src = fs.readFileSync(path.join(REPO, 'server', 'services', 'estimate-lines.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).toMatch(/module\.exports/);            // non-vacuity
    expect(/unitSell/.test(code)).toBe(false);
  });

  test('a DOCUMENT client price still prices nothing on an estimate, at any group count', () => {
    // targetPrice is a document ABSOLUTE, and an estimate total sums a
    // per-group resolve — so an absolute is applied once PER INCLUDED GROUP
    // and multiplies the proposal. That lock is why the estimate paths call
    // resolveTargetMargin and not resolveMarkedUp, and it has to hold WITH
    // promised lines present, which is the shape that is new.
    for (let n = 1; n <= 5; n++) {
      const alternates = [];
      const lines = [];
      for (let a = 0; a < n; a++) {
        alternates.push({ id: 'alt' + a, name: 'G' + a });
        lines.push({ id: 'd' + a, alternateId: 'alt' + a, qty: 1, unitCost: 5000, markup: 10 });
        lines.push({ id: 'p' + a, alternateId: 'alt' + a, qty: 1, unitCost: 0, unitSell: 2000 });
      }
      const without = { lines, alternates, roundTo: 500 };
      const withPrice = { lines, alternates, targetPrice: '39285.71', roundTo: 500 };
      expect(P.clientPriceRequested(withPrice)).toBe(false);
      expect(serverTotals.computeEstimateTotals(withPrice).proposalTotal)
        .toBe(serverTotals.computeEstimateTotals(without).proposalTotal);
      // And the promise IS being counted, or the equality above is vacuous.
      expect(serverTotals.computeEstimateTotals(without).promisedSell).toBe(2000 * n);
    }
  });

  test('the LEGACY arm — a blob with no `alternates` key — keeps the lock too', () => {
    // This is the shape where clientPriceRequested returns TRUE, and is the
    // whole reason resolveTargetMargin exists as its own function. Pointing
    // the estimate call sites at resolveMarkedUp would have moved this.
    const lines = [
      { id: 'd', qty: 1, unitCost: 5000, markup: 10 },
      { id: 'p', qty: 1, unitCost: 0, unitSell: 2000 },
    ];
    const without = { lines, roundTo: 500 };
    const withPrice = { lines, targetPrice: '39285.71', roundTo: 500 };
    expect(P.clientPriceRequested(withPrice)).toBe(true);   // it IS requested…
    expect(serverTotals.computeEstimateTotals(withPrice).proposalTotal)
      .toBe(serverTotals.computeEstimateTotals(without).proposalTotal);  // …and prices nothing
    expect(serverTotals.computeEstimateTotals(without).promisedSell).toBe(2000);
  });

  test('a Buildertrend line that still cannot be expressed still refuses its worksheet', () => {
    // A NON-ZERO cost can be reached by some percent, so a percent that
    // misses its own owner price means Buildertrend's two figures disagree
    // with EACH OTHER. A promise must not bury that.
    const disagree = readEstimateLine({
      lineItemId: '9201', worksheetId: '9200', groupId: 'G1', groupTitle: 'Doors',
      displayOrder: 1, itemTitle: 'Flat rate door', quantity: 2, unitCost: 100,
      builderCost: 200, markupType: '2', markupPercent: 0, markupPerUnit: 25,
      markupAmount: 50, ownerPrice: 250, jobId: '111', jobName: 'Citi Lakes', isDeleted: false,
    });
    const built = estMatch.buildLines([disagree], '9200');
    expect(built.lines.filter((l) => l.section !== '__section_header__')).toEqual([]);
    expect(built.promised).toEqual([]);
    expect(built.refusals[0].why)
      .toMatch(/owner pays \$250\.00 for it, and Project 86 prices the same quantity, unit cost and 0% markup at \$200\.00/);

    // And a ZERO cost with a ZERO quantity: qty x any unit price is $0.00, so
    // a promise cannot express it either. The refusal names THAT limit rather
    // than a markup tolerance that was never the binding one.
    const zeroQty = readEstimateLine({
      lineItemId: '9202', worksheetId: '9200', groupId: 'G1', groupTitle: 'Doors',
      displayOrder: 2, itemTitle: 'Permit', quantity: 0, unitCost: 0, builderCost: 0,
      markupType: '3', markupPercent: 0, markupAmount: 500, ownerPrice: 500,
      jobId: '111', jobName: 'Citi Lakes', isDeleted: false,
    });
    const built2 = estMatch.buildLines([zeroQty], '9200');
    expect(built2.lines.filter((l) => l.section !== '__section_header__')).toEqual([]);
    expect(built2.refusals[0].why).toMatch(/no markup percent can express that/);
    expect(built2.refusals[0].why).toMatch(/quantity is 0, so a stated unit price cannot reach it either/);
    // A refused line carries NO half-promise into the array.
    expect(JSON.stringify(built2.lines)).not.toMatch(/unitSell/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 7 — THE RESIDUAL, named rather than papered over.
// ══════════════════════════════════════════════════════════════════════
describe('one PRE-EXISTING divergence survives, and it is not this change’s', () => {
  test('under a target margin the proposal’s per-ROW unit prices stay bottom-up', async () => {
    // js/estimate-preview.js prices a ROW from the markup cascade and leaves
    // the target margin to the group total; js/estimate-editor.js scales
    // every unpromised row by the target factor. So on a target-margin
    // estimate the proposal's rows do not sum to the subtotal printed under
    // them — 1,687.50 + 20,000.00 against 21,785.71.
    //
    // THIS PREDATES THE PROMISED PRICE and is unchanged by it. It is here so
    // that a reader who finds it does not attribute it to this commit, and so
    // that fixing it (which touches the printed proposal of every
    // target-margin estimate, and runs into estimate-preview's separate habit
    // of resolving a section header against the WHOLE portfolio line array)
    // is a decision taken on purpose rather than by accident.
    const { est, lines } = fixture({ targetMargin: 30 });
    const b = browser();
    try {
      const meta = b.hydrate(est, lines);
      const doc = await renderedProposal(b, meta);
      const rowSum = cents(doc.rows.reduce((s, r) => s + r[1], 0));
      expect(rowSum).toBe(DERIVED_SELL + PROMISED_SELL);        // 21,687.50
      expect(doc.subtotals).toEqual([cents(20000 + 1250 / 0.7)]); // 21,785.71
      expect(rowSum).not.toBe(doc.subtotals[0]);
    } finally { b.close(); }
    // THE HALF THAT MATTERS HERE: the PROMISED row is the same on both sides
    // whatever the target does, because neither marks it up.
    const ed = editor(est, lines);
    expect(ed.rows.l2.amount).toBe(PROMISED_SELL);
  });
});
