// test/co-pricing-back-compat.test.js — THE MIGRATION GUARANTEE, EXECUTABLE.
//
// A change order's line model gained one optional field: `unitSell`, the
// promised per-unit price, for the case where the number you have is what
// you quoted the owner rather than what the work costs. Nothing is written
// to any existing change order to make that work — no backfill script, no
// lazy upgrade-on-read, no normalize-on-save. The discriminator is the
// ABSENCE of the key, so every record in the database prices through the
// arithmetic it always has.
//
// This file is that promise as literals. Each shape below is a change order
// that exists today, and each expected number is HARD-CODED — not diffed
// against the previous implementation, and not recomputed from the module
// under test. A test that derives its expectation from the code it is
// testing drifts with the code; these numbers cannot. If one of them moves,
// real contract money moved with it.
//
// The first fixture is CO-0001 on RV2008 Fairway Paint & Gutters
// (j1783317122508) verbatim — ten lines all reading "Buildertrend Flat
// Rate", defaultMarkup 0, no fees, no tax, no target margin. It is the
// record that prompted the whole change, it is the one most at risk from a
// helpful migration, and it must stay at income $27,500 / costs $27,500
// until a human opens it and types a real cost into a cell.
//
// Pure modules — no DB, no express, so this runs with no JWT_SECRET.

const fs = require('fs');
const path = require('path');
const { changeOrderMoney } = require('../server/services/money/change-order-totals');
const pricing = require('../js/pricing-pipeline.js');

const PIPELINE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'pricing-pipeline.js'), 'utf8');

// ── CO-0001, verbatim ───────────────────────────────────────────────
const CO_0001_COSTS = [2750, 1800, 3200, 4150, 2600, 1950, 3300, 2450, 2900, 2400];
const CO_0001 = {
  title: 'Fairway gutters + paint adds',
  defaultMarkup: 0,
  lines: CO_0001_COSTS.map((c, i) => ({
    id: 'l' + i, qty: 1, unitCost: c,
    description: 'Buildertrend Flat Rate — item ' + (i + 1),
  })),
};

// ── Every legacy shape, with the number it must produce ─────────────
// NOT ONE of these carries `unitSell`. That is the point.
const GOLDEN = [
  ['CO-0001 verbatim — ten Buildertrend Flat Rate lines, defaultMarkup 0',
    CO_0001, 27500, 27500],

  ["defaultMarkup: '' — the seed a brand-new CO is created with",
    { defaultMarkup: '', lines: [{ id: 'a', qty: 4, unitCost: 250 }] }, 1000, 1000],

  ['defaultMarkup absent entirely',
    { lines: [{ id: 'a', qty: 4, unitCost: 250 }] }, 1000, 1000],

  ['defaultMarkup: null',
    { defaultMarkup: null, lines: [{ id: 'a', qty: 4, unitCost: 250 }] }, 1000, 1000],

  ['defaultMarkup: 18 — the plain cascade fallback',
    { defaultMarkup: 18, lines: [{ id: 'a', qty: 4, unitCost: 250 }, { id: 'b', qty: 1, unitCost: 999.99 }] },
    2359.9882, 1999.99],

  ['per-line markup wins over defaultMarkup, and markup: 0 is a real 0%',
    { defaultMarkup: 18, lines: [
      { id: 'a', qty: 4, unitCost: 250, markup: 35 },
      { id: 'b', qty: 2, unitCost: 100, markup: 0 },
      { id: 'c', qty: 2, unitCost: 100, markup: '' },
    ] }, 1786, 1400],

  ['section %-mode header supplies the fallback markup',
    { defaultMarkup: 10, lines: [
      { id: 's1', section: '__section_header__', label: 'Labor', markup: 40, markupMode: 'percent' },
      { id: 'a', qty: 10, unitCost: 55 },
      { id: 'b', qty: 3, unitCost: 20, markup: 5 },
    ] }, 833, 610],

  ['section $-mode adds its flat amount ONCE and supplies 0% to its lines',
    { defaultMarkup: 25, lines: [
      { id: 's1', section: '__section_header__', label: 'Sub', markup: 1500, markupMode: 'dollar' },
      { id: 'a', qty: 1, unitCost: 8000 },
      { id: 'b', qty: 1, unitCost: 2000, markup: 12 },
    ] }, 11740, 10000],

  ['section %-mode + overrideLineMarkups ignores per-line markups',
    { defaultMarkup: 10, lines: [
      { id: 's1', section: '__section_header__', label: 'Materials', markup: 30, markupMode: 'percent', overrideLineMarkups: true },
      { id: 'a', qty: 5, unitCost: 120, markup: 90 },
      { id: 'b', qty: 5, unitCost: 120 },
    ] }, 1560, 1200],

  ['section $-mode + overrideLineMarkups forces 0% on every line',
    { defaultMarkup: 10, lines: [
      { id: 's1', section: '__section_header__', label: 'Materials', markup: 750, markupMode: 'dollar', overrideLineMarkups: true },
      { id: 'a', qty: 5, unitCost: 120, markup: 90 },
    ] }, 1350, 600],

  ['target margin 35% overrides every line markup — float tail and all',
    { targetMargin: 35, defaultMarkup: 12, lines: [
      { id: 'a', qty: 1, unitCost: 27500, markup: 5 },
      { id: 'b', qty: 2, unitCost: 250 },
    ] }, 43076.92307692308, 28000],

  ['target margin + flat fee + fee % + tax + round-to, in that order',
    { targetMargin: 30, defaultMarkup: 0, feeFlat: 500, feePct: 3, taxPct: 7, roundTo: 25,
      lines: [{ id: 'a', qty: 3, unitCost: 4100 }] }, 19925, 12300],

  ['assembly rollup — a 6-decimal unitCost survives to the cent and past it',
    { defaultMarkup: 22, lines: [
      { id: 's1', section: '__section_header__', label: 'Materials', btCategory: 'materials', markup: '', markupMode: 'percent' },
      { id: 'a', qty: 3200, unitCost: 0.771611, unit: 'SF', markup: '',
        sourceAssemblyId: 47, assemblyBucket: 'materials',
        assemblyBreakdown: [{ description: 'Paint, 5-gal', qty_per_unit: 0.005, unit_cost: 180, cost_code: 'materials' }] },
    ] }, 3012.369344, 2469.1552],

  ['zero-qty and zero-cost lines contribute nothing without breaking',
    { defaultMarkup: 20, lines: [
      { id: 'a', qty: 0, unitCost: 500 },
      { id: 'b', qty: 5, unitCost: 0 },
      { id: 'c', qty: 2, unitCost: 75 },
    ] }, 180, 150],

  ['string numerics straight off the input fields',
    { defaultMarkup: '15', targetMargin: '', lines: [
      { id: 'a', qty: '3', unitCost: '199.99', markup: '' },
      { id: 'b', qty: '1.5', unitCost: '80', markup: '7.5' },
    ] }, 818.9655, 719.97],

  ['a deductive change order — negative costs stay negative',
    { defaultMarkup: 20, lines: [{ id: 'a', qty: 1, unitCost: -4000 }, { id: 'b', qty: 1, unitCost: 1200 }] },
    -3360, -2800],

  ['empty lines array WITH an active target margin and a flat fee',
    { targetMargin: 30, feeFlat: 500, lines: [] }, 500, 0],

  ['lines key missing entirely',
    { targetMargin: 30, feeFlat: 500 }, 500, 0],

  ['header-only record — no content lines at all',
    { defaultMarkup: 15, lines: [{ id: 's1', section: '__section_header__', label: 'Materials', markup: '', markupMode: 'percent' }] },
    0, 0],

  ['junk numerics — unparseable strings read as zero, they do not throw',
    { defaultMarkup: 'abc', lines: [{ id: 'a', qty: 'two', unitCost: '1.2.3' }, { id: 'b', qty: 2, unitCost: 40 }] },
    80, 80],
];

describe('every change order that exists today prices exactly as it did', () => {
  test.each(GOLDEN)('%s', (_name, rec, income, costs) => {
    const m = changeOrderMoney(rec);
    // Object.is, not toBeCloseTo: this is contract money, and "close" is
    // how a restatement hides.
    expect(Object.is(m.income, income)).toBe(true);
    expect(Object.is(m.costs, costs)).toBe(true);
  });

  test('CO-0001 is $27,500 income against $27,500 cost — the bug, preserved', () => {
    // It reports $0 profit and it overstates the job's estimated cost by the
    // whole gutter quote. Both of those are WRONG and both must survive this
    // commit untouched: the repair is a human opening the change order, not a
    // migration restating every job in the org overnight.
    const m = changeOrderMoney(CO_0001);
    expect(m.income).toBe(27500);
    expect(m.costs).toBe(27500);
    expect(m.income - m.costs).toBe(0);
    expect(CO_0001.lines).toHaveLength(10);
    // And nothing in the record grew a key.
    for (const l of CO_0001.lines) {
      expect(Object.prototype.hasOwnProperty.call(l, 'unitSell')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(l, 'costPending')).toBe(false);
    }
  });

  test('the money functions never mutate the record they price', () => {
    // The cheapest possible migration is an accidental one.
    const before = JSON.stringify(CO_0001);
    changeOrderMoney(CO_0001);
    pricing.computeForLines(CO_0001, CO_0001.lines);
    expect(JSON.stringify(CO_0001)).toBe(before);
  });
});

describe('the discriminator is the ABSENCE of the key, not a version flag', () => {
  const line = (over) => Object.assign({ id: 'a', qty: 2, unitCost: 100 }, over || {});
  const rec = (l) => ({ defaultMarkup: 20, lines: [l] });

  test('absent unitSell falls through to markup pricing', () => {
    expect(changeOrderMoney(rec(line())).income).toBe(240);
  });
  test('empty-string unitSell falls through — the blank cell an editor writes', () => {
    expect(changeOrderMoney(rec(line({ unitSell: '' }))).income).toBe(240);
  });
  test('null unitSell falls through', () => {
    expect(changeOrderMoney(rec(line({ unitSell: null }))).income).toBe(240);
  });
  test('undefined unitSell falls through', () => {
    expect(changeOrderMoney(rec(line({ unitSell: undefined }))).income).toBe(240);
  });

  test('the guard is character-identical to the per-line markup guard', () => {
    // Same predicate, same file, same reasoning — that shared shape is why
    // no row needs rewriting. If one drifts from the other, a blank cell
    // starts meaning zero somewhere and a line silently reprices.
    expect(PIPELINE_SRC).toMatch(/line\.markup !== '' && line\.markup != null/);
    expect(PIPELINE_SRC).toMatch(/line\.unitSell !== '' && line\.unitSell != null/);
  });

  test('there is no version flag on the record or the line', () => {
    // A flag would need a value on every existing row. That is a migration.
    expect(PIPELINE_SRC).not.toMatch(/pricingModel|pricing_model|schemaVersion|lineVersion/);
  });
});

describe('costs keeps its definition: the raw line subtotal, pre-markup', () => {
  test('a promised sell price does not move the cost by one cent', () => {
    const costOnly = { defaultMarkup: 0, lines: [{ id: 'a', qty: 1, unitCost: 1650 }] };
    const promised = { defaultMarkup: 0, lines: [{ id: 'a', qty: 1, unitCost: 1650, unitSell: 2750 }] };
    expect(changeOrderMoney(costOnly).costs).toBe(1650);
    expect(changeOrderMoney(promised).costs).toBe(1650);   // unchanged
    expect(changeOrderMoney(promised).income).toBe(2750);  // only the price moved
  });

  test('subtotal stays cost even when every line on the record is locked', () => {
    const per = pricing.computeForLines({ defaultMarkup: 50 }, [
      { id: 'a', qty: 2, unitCost: 100, unitSell: 400 },
      { id: 'b', qty: 3, unitCost: 10, unitSell: 0 },
    ]);
    expect(per.subtotal).toBe(230);          // 200 + 30 — cost, untouched
    expect(per.markedUp).toBe(800);          // 2x400 + 3x0 — the promises
    expect(per.lockedSubtotal).toBe(230);
    expect(per.lockedSell).toBe(800);
  });

  test('nothing anywhere back-computes a margin out of cost == sell', () => {
    // The tempting "helpful" migration: notice CO-0001 has markup 0 and
    // cost equal to sell, decide the cost must really have been lower, and
    // restate it. That reprices every job in the org at once.
    for (const rel of [['js', 'pricing-pipeline.js'],
      ['server', 'services', 'money', 'change-order-totals.js'],
      ['server', 'services', 'job-financials.js'],
      ['server', 'routes', 'change-order-routes.js']]) {
      // Comments are stripped first, because the pipeline's own header
      // says at length that it does NOT do this and the guard must read
      // code, not prose.
      const src = fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      expect(src).not.toMatch(/impliedCost|inferredSell|backfill|migrateLine|upgradeLine/i);
    }
  });
});
