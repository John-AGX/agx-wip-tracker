/**
 * @jest-environment jsdom
 */
// jsdom because this file now CALLS js/doc-import.js rather than regexing it,
// and that module registers window.p86DocImport at load. The modules it tests
// alongside (pricing-pipeline, change-order-totals, job-financials) are pure
// and behave identically either way.
//
// test/co-line-intake.test.js — the two doors that actually PRODUCE the
// change-order lines this whole pass is about.
//
// Making the editor able to express cost and price separately fixes
// nothing on its own if the machines that create change orders keep
// writing a sell price into `unitCost`. Two of them do:
//
//   1. BULK DOCUMENT IMPORT (js/doc-import.js). The number on a
//      change-order PDF is a PRICE. It went into `unitCost`. Ten of those
//      are CO-0001.
//   2. THE AGENT (86/Scribe). Change-order lines had NO key normalizer at
//      all while estimates have had one for a long time, so an agent line
//      carrying `unit_cost` was stored verbatim, `unitCost` was undefined,
//      and the line priced at ZERO — with the payload reporting success.
//
// Pure modules and source assertions — no DB, no express.

const fs = require('fs');
const path = require('path');
const raw = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const pricing = require('../js/pricing-pipeline.js');
const { changeOrderMoney } = require('../server/services/money/change-order-totals');
const jobFin = require('../server/services/job-financials');

// ── 1. OCR bulk import ──────────────────────────────────────────────
// js/doc-import.js is a browser IIFE with no node export, so its intake
// rule is asserted as source and its ARITHMETIC is proven by running the
// resulting line shape through the real pipeline.
const IMPORT = raw('js', 'doc-import.js');

describe('a change order built from a PDF records the price AS a price', () => {
  // These two were regexes over the source of toLine, because the file had no
  // node export. It has one now (js/doc-import.js __test.toLine), so CALL it:
  // the shape the importer emits is the thing under test, and a regex over a
  // return statement stops matching the moment a key is added to it — which is
  // exactly what happened when the change-order line learned to carry an `id`.
  const { toLine } = require('../js/doc-import.js').__test;
  // server/routes/doc-import-routes.js:148 emits this per line; :88 says
  // qty/unit_cost are null when only an extended amount is printed, which is
  // what a "Buildertrend Flat Rate" row is.
  const ocr = (description, amount) => ({ description, qty: null, unit_cost: null, amount });

  test('the CO branch writes unitSell, and flags the cost as a placeholder', () => {
    expect(toLine(ocr('Gutters — Buildertrend Flat Rate', 2750), 'co'))
      .toMatchObject({ description: 'Gutters — Buildertrend Flat Rate', qty: 1,
        unitCost: 2750, unitSell: 2750, costPending: true });
  });

  test('a PURCHASE ORDER is untouched — its number really is a cost', () => {
    expect(toLine({ description: '2x4 studs', qty: 40, unit_cost: 4.25, amount: 170 }, 'po'))
      .toEqual({ description: '2x4 studs', qty: 40, unitCost: 4.25 });
  });

  test('the imported shape produces BYTE-IDENTICAL money to the old one', () => {
    // This is why unitCost is seeded to the same number rather than left
    // blank: nothing in any aggregate moves on the day this ships. The
    // record simply stops lying about which number is which.
    const FLAT = [2750, 1800, 3200, 4150, 2600, 1950, 3300, 2450, 2900, 2400];
    const before = { defaultMarkup: 0, status: 'approved',
      lines: FLAT.map((v, i) => ({ description: 'Flat Rate ' + i, qty: 1, unitCost: v })) };
    const after = { defaultMarkup: 0, status: 'approved',
      lines: FLAT.map((v, i) => ({ description: 'Flat Rate ' + i, qty: 1, unitCost: v, unitSell: v, costPending: true })) };
    const a = changeOrderMoney(before);
    const b = changeOrderMoney(after);
    expect(Object.is(a.income, b.income)).toBe(true);
    expect(Object.is(a.costs, b.costs)).toBe(true);
    expect(b).toEqual({ income: 27500, costs: 27500 });
  });

  test('blanking the cost instead would OVERSTATE margin — worse than the bug', () => {
    // The tempting alternative: unitSell = the price, unitCost = ''. That
    // books $0 of cost and reports 100% margin on work that has not been
    // priced at all.
    const blanked = { defaultMarkup: 0, lines: [{ qty: 1, unitCost: '', unitSell: 2750 }] };
    expect(changeOrderMoney(blanked)).toEqual({ income: 2750, costs: 0 });
    expect(IMPORT).not.toMatch(/unitCost: '', unitSell/);
  });

  test('one cell repairs an imported line, and income does not move', () => {
    const imported = { defaultMarkup: 0, lines: [{ qty: 1, unitCost: 2750, unitSell: 2750, costPending: true }] };
    const repaired = { defaultMarkup: 0, lines: [{ qty: 1, unitCost: 1650, unitSell: 2750 }] };
    expect(changeOrderMoney(imported).income).toBe(2750);
    expect(changeOrderMoney(repaired).income).toBe(2750);   // unmoved
    expect(changeOrderMoney(imported).costs).toBe(2750);
    expect(changeOrderMoney(repaired).costs).toBe(1650);    // this is the fix
  });

  test('costPending never reaches the pricing pipeline', () => {
    expect(raw('js', 'pricing-pipeline.js')).not.toMatch(/costPending/);
    expect(raw('server', 'services', 'money', 'change-order-totals.js')).not.toMatch(/costPending/);
    expect(raw('server', 'services', 'money', 'job-wip.js')).not.toMatch(/costPending/);
  });
});

// ── 2. The agent door ───────────────────────────────────────────────
describe('an agent line-key is normalized before it can price at $0', () => {
  const norm = (lines) => jobFin.normalizeCoLines(lines);

  test('unit_cost becomes unitCost — the silent-$0 bug', () => {
    const [l] = norm([{ description: 'Gutters', qty: 1, unit_cost: 1650 }]);
    expect(l).toEqual({ description: 'Gutters', qty: 1, unitCost: 1650 });
    // And prove the failure it prevents.
    const broken = { defaultMarkup: 0, lines: [{ qty: 1, unit_cost: 1650 }] };
    expect(changeOrderMoney(broken)).toEqual({ income: 0, costs: 0 });
    const fixed = { defaultMarkup: 0, lines: norm(broken.lines) };
    expect(changeOrderMoney(fixed)).toEqual({ income: 1650, costs: 1650 });
  });

  test('every alias the estimate normalizer knows, plus the CO-only one', () => {
    expect(norm([{ unit_price: 5 }])[0]).toEqual({ unitCost: 5 });
    expect(norm([{ unitPrice: 5 }])[0]).toEqual({ unitCost: 5 });
    expect(norm([{ markup_pct: 20 }])[0]).toEqual({ markup: 20 });
    expect(norm([{ markupPct: 20 }])[0]).toEqual({ markup: 20 });
    expect(norm([{ quantity: 3 }])[0]).toEqual({ qty: 3 });
    expect(norm([{ unit_sell: 2750 }])[0]).toEqual({ unitSell: 2750 });
    expect(norm([{ sell_price: 2750 }])[0]).toEqual({ unitSell: 2750 });
    expect(norm([{ cost_pending: true }])[0]).toEqual({ costPending: true });
  });

  test('an explicit camelCase value wins over a snake_case alias', () => {
    // Otherwise key iteration order decides the price.
    expect(norm([{ unitCost: 100, unit_cost: 999 }])[0]).toEqual({ unitCost: 100 });
    expect(norm([{ unitSell: 200, unit_sell: 999 }])[0]).toEqual({ unitSell: 200 });
  });

  test('an already-correct line is returned unchanged, key for key', () => {
    const l = { id: 'a', description: 'x', qty: 2, unit: 'ea', unitCost: 10, markup: '', unitSell: 25 };
    expect(norm([l])[0]).toEqual(l);
  });

  test('section headers and junk entries pass through untouched', () => {
    expect(norm([{ id: 's', section: '__section_header__', label: 'Labor', markup: '' }])[0])
      .toEqual({ id: 's', section: '__section_header__', label: 'Labor', markup: '' });
    expect(norm([null, 'x', 7])).toEqual([null, 'x', 7]);
    expect(norm(undefined)).toBeUndefined();
  });

  test('it does not mutate the array it is handed', () => {
    const src = [{ unit_cost: 5 }];
    norm(src);
    expect(src[0]).toEqual({ unit_cost: 5 });
  });
});

describe('the agent is TOLD what unitCost means, or it will never emit the field', () => {
  const AGENTS = raw('server', 'routes', 'admin-agents-routes.js');
  const FIN = raw('server', 'services', 'job-financials.js');

  test('the tool schema lists unitSell and costPending on a CO line', () => {
    expect(AGENTS).toMatch(/lines:\[\{description, qty, unitCost, markup\?, unitSell\?, costPending\?\}\]/);
  });

  test('and says outright that unitCost is not a quoted price', () => {
    expect(AGENTS).toMatch(/`unitCost` is WHAT THE WORK COSTS — never a price quoted to the owner/);
    expect(AGENTS).toMatch(/books the whole quote as job cost and reports \$0 profit/);
  });

  test('rejectFlatMoney teaches the same thing at the point of refusal', () => {
    expect(FIN).toMatch(/unitCost is what the work COSTS — never a price quoted to the owner/);
  });

  test('unitSell is NOT added to the flat-money blocklist', () => {
    // Its members are DOCUMENT-level flat money. unitSell is a LINE field —
    // the very shape rejectFlatMoney tells the model to use — so blocking
    // it would forbid the fix.
    let threw = null;
    try {
      jobFin.cleanCoData({ lines: [{ qty: 1, unitCost: 1650, unitSell: 2750 }] });
    } catch (e) { threw = e; }
    expect(threw).toBe(null);
    const flatList = FIN.slice(FIN.indexOf('function rejectFlatMoney'));
    expect(flatList.slice(0, 400)).not.toMatch(/'unitSell'/);
  });

  test('cleanCoData still strips only canonical columns and keeps line fields', () => {
    const out = jobFin.cleanCoData({
      id: 'nope', status: 'approved', co_number: 'CO-9',
      title: 'Gutters', lines: [{ qty: 1, unitCost: 1650, unitSell: 2750, unit: 'ea', costPending: true }],
    });
    expect(out.id).toBeUndefined();
    expect(out.status).toBeUndefined();
    expect(out.title).toBe('Gutters');
    expect(out.lines[0]).toEqual({ qty: 1, unitCost: 1650, unitSell: 2750, unit: 'ea', costPending: true });
  });
});

describe('normalization touches only the lines ARRIVING in an op', () => {
  test('the update path normalizes incoming lines and leaves merged ones alone', () => {
    // Repairing a stored row as a side effect of an unrelated field update
    // would move money on a change order nobody asked to touch.
    // The intake pass is a COMPOSITION — key mapping (normalizeCoLines) and
    // identity (stampCoLineIds), each a separate contract. What is pinned is
    // that both are applied to `incoming.lines` / `body.lines` and to nothing
    // else: a merged-out stored line must not be rewritten by an op that did
    // not name it.
    const FIN = raw('server', 'services', 'job-financials.js');
    expect(FIN).toMatch(/Array\.isArray\(incoming\.lines\) \? \{ lines: stampCoLineIds\(normalizeCoLines\(incoming\.lines\)\) \} : \{\}/);
    expect(FIN).toMatch(/Array\.isArray\(body\.lines\)\s*\n?\s*\? Object\.assign\(\{\}, body, \{ lines: stampCoLineIds\(normalizeCoLines\(body\.lines\)\) \}\)/);
  });

  test('there is no backfill, anywhere, over stored change orders', () => {
    const FIN = raw('server', 'services', 'job-financials.js')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(FIN).not.toMatch(/UPDATE job_change_orders[\s\S]{0,200}unitSell/);
    // And the only writes to the table are the create/update/delete the
    // service already had.
    const stmts = FIN.match(/(INSERT INTO|UPDATE|DELETE FROM) job_change_orders/g) || [];
    expect(stmts.sort()).toEqual([
      'DELETE FROM job_change_orders',
      'INSERT INTO job_change_orders',
      'UPDATE job_change_orders',
    ]);
    // ...and the one UPDATE is pinned to a single id. A bulk write over
    // this table is the migration this whole pass refuses.
    expect(FIN).toMatch(/UPDATE job_change_orders[\s\S]{0,300}?WHERE id = \$2/);
  });
});

describe('the pipeline still cannot be reached by any second implementation', () => {
  test('doc-import does no pricing of its own for a change order', () => {
    expect(IMPORT).not.toMatch(/applyTargetMargin|resolveMarkedUp|computeForLines/);
  });

  test('job-financials does no CO pricing of its own', () => {
    const FIN = raw('server', 'services', 'job-financials.js');
    expect(FIN).not.toMatch(/applyTargetMargin|resolveMarkedUp|lineMoney/);
  });

  test('and unitSell is still honoured in exactly one place', () => {
    expect(raw('js', 'pricing-pipeline.js')).toMatch(/num\(line\.qty\) \* num\(line\.unitSell\)/);
    expect(pricing.lineMoney({ qty: 2, unitCost: 10, unitSell: 30 }, [], {}))
      .toEqual({ ext: 20, sell: 60, locked: true, markup: null });
  });
});
