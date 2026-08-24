/**
 * @jest-environment jsdom
 */
// test/co-margin-tax-is-not-profit.test.js
//
// Sales tax is money collected for the state. It is not revenue, it is not
// profit, and it may not appear in a margin. Neither may a flat fee, a
// percentage fee, or a round-up — none of them are the marked-up price of
// the work, which is what "gross margin" means everywhere else in this app.
//
// The change-order editor computed margin as
//     (applyFeesAndTax(...).total - subtotal) / applyFeesAndTax(...).total
// and profit as
//     applyFeesAndTax(...).total - subtotal
// so BOTH carried four non-cost additions in the numerator. The estimate
// editor, twelve hundred lines away, used markedUp for the same word.
//
// THIS SUITE IS RED AGAINST THE CODE AS IT STANDS. On the reviewer's
// $34,000 / 7% fixture the editor prints 19.1176% and $6,500.00; the
// assertions below demand 9.4344% and $2,864.76. Every case that names a
// number was run against unfixed source first and observed to fail.
//
// The cure is ONE definition in js/pricing-pipeline.js — grossMarginPct —
// so the disagreement is structurally impossible rather than currently
// absent.

const fs = require('fs');
const path = require('path');

global.window.p86Pricing = require('../js/pricing-pipeline.js');
window.p86Pricing = global.window.p86Pricing;
const P = window.p86Pricing;
const editor = require('../js/change-order-editor.js');
const T = editor.__test;

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');

function mount() {
  document.body.innerHTML =
    '<div id="p86CoTotals"></div><div id="p86CoLineTable"></div>';
}
const chips = () => Array.from(document.querySelectorAll('#p86CoTotals .p86-co-chip'))
  .reduce((acc, c) => {
    acc[c.querySelector('.p86-co-chip-label').textContent] =
      c.querySelector('.p86-co-chip-value').textContent;
    return acc;
  }, {});

beforeEach(mount);

// The reviewer's record, rebuilt from its stated parts rather than from a
// screenshot: $27,500 of cost at 10.4173% markup, 7% sales tax, and the flat
// fee that lands the change order on exactly $34,000.00.
const REV_COST = 27500;
const REV_MARKUP = 10.4173;
const REV_MARKED_UP = REV_COST * (1 + REV_MARKUP / 100);   // 30,364.7575
const REV_FEE_FLAT = 34000 / 1.07 - REV_MARKED_UP;         // ~ 1,410.94
function reviewerCo(extra) {
  return Object.assign({
    taxPct: 7,
    feeFlat: REV_FEE_FLAT,
    lines: [{ id: 'L1', qty: 1, unitCost: REV_COST, markup: REV_MARKUP }],
  }, extra || {});
}

describe('the reviewer fixture — the number John was shown', () => {
  test('the record really does total $34,000.00 at 7% tax', () => {
    T.setCo(reviewerCo());
    const t = T.computeTotals();
    expect(t.total).toBeCloseTo(34000, 6);
    expect(t.subtotal).toBeCloseTo(27500, 6);
  });

  test('MARGIN excludes tax, both fees and the round-up: 9.4344%, not 19.1176%', () => {
    T.setCo(reviewerCo());
    const t = T.computeTotals();
    expect(t.marginPct).toBeCloseTo(9.4344, 3);
    // The number the strip printed before this commit. Named so a reader
    // can see the size of the correction without re-deriving it.
    const OLD = ((t.total - t.subtotal) / t.total) * 100;
    expect(OLD).toBeCloseTo(19.1176, 3);
  });

  test('PROFIT excludes them too: $2,864.76, not $6,500.00 — 2.27x overstated', () => {
    T.setCo(reviewerCo());
    const t = T.computeTotals();
    expect(t.profit).toBeCloseTo(REV_MARKED_UP - REV_COST, 6);
    expect(t.profit).toBeCloseTo(2864.7575, 4);
    const OLD = t.total - t.subtotal;
    expect(OLD).toBeCloseTo(6500, 6);
    expect(OLD - t.profit).toBeCloseTo(3635.2425, 4);
    expect(OLD / t.profit).toBeCloseTo(2.2689, 3);
  });

  test('Profit and Margin agree with each other on screen', () => {
    T.setCo(reviewerCo());
    T.paintTotals();
    const c = chips();
    expect(c['Profit']).toBe('$2,864.76');
    expect(c['Margin']).toBe('9.4%');
    // profit / markedUp === margin. The pair used to be internally
    // consistent only because both were wrong in the same direction.
    const t = T.computeTotals();
    expect((t.profit / t.markedUp) * 100).toBeCloseTo(t.marginPct, 9);
  });
});

describe('PROPERTY — margin does not move when a non-cost addition moves', () => {
  const MARKUPS = [0, 10.4173, 20, 35, 50, 137.5];
  const TAXES = [0, 6.5, 7, 8.5, 13];
  test('tax never touches margin or profit', () => {
    MARKUPS.forEach((m) => {
      T.setCo({ taxPct: 0, lines: [{ id: 'a', qty: 1, unitCost: 27500, markup: m }] });
      const base = T.computeTotals();
      TAXES.forEach((tax) => {
        T.setCo({ taxPct: tax, lines: [{ id: 'a', qty: 1, unitCost: 27500, markup: m }] });
        const t = T.computeTotals();
        expect(t.marginPct).toBeCloseTo(base.marginPct, 12);
        expect(t.profit).toBeCloseTo(base.profit, 9);
      });
    });
  });

  test('feeFlat, feePct and roundTo never touch margin or profit either', () => {
    const lines = [{ id: 'a', qty: 1, unitCost: 27500, markup: 20 }];
    T.setCo({ lines });
    const base = T.computeTotals();
    [
      { feeFlat: 1000 }, { feeFlat: 2500, feePct: 5 }, { feePct: 3 },
      { roundTo: 500 }, { roundTo: 25, feeFlat: 999.99, feePct: 8, taxPct: 7 },
    ].forEach((extra) => {
      T.setCo(Object.assign({ lines }, extra));
      const t = T.computeTotals();
      expect(t.marginPct).toBeCloseTo(base.marginPct, 12);
      expect(t.profit).toBeCloseTo(base.profit, 9);
    });
  });
});

describe('Fairways CO-0001 — the claim John was told, and its real condition', () => {
  // 52.8% margin: $47,200 of cost sold at $100,000.
  const FAIRWAYS = { qty: 1, unitCost: 47200, markup: 111.86440677966102, id: 'F1' };
  test('taxPct 0, no fees, no round-up → 52.8000%, unchanged by this commit', () => {
    T.setCo({ taxPct: 0, feeFlat: 0, feePct: 0, roundTo: 0, lines: [FAIRWAYS] });
    expect(T.computeTotals().marginPct).toBeCloseTo(52.8, 9);
  });
  test('the flat version of the claim is wrong: taxPct 0 alone was NOT sufficient', () => {
    // Before this commit these three printed 52.9915%, 53.5965% and 54.1748%
    // on a record carrying no tax at all. They print 52.8% now.
    [{ roundTo: 500 }, { feeFlat: 1000 }, { feePct: 3 }].forEach((extra) => {
      T.setCo(Object.assign({ taxPct: 0, lines: [FAIRWAYS] }, extra));
      expect(T.computeTotals().marginPct).toBeCloseTo(52.8, 9);
    });
  });
});

describe('ONE definition — the disagreement is structurally impossible', () => {
  test('js/pricing-pipeline.js owns grossMarginPct and both editors call it', () => {
    expect(typeof P.grossMarginPct).toBe('function');
    expect(SRC('change-order-editor.js')).toMatch(/p86Pricing\.grossMarginPct\(/);
    expect(SRC('estimate-editor.js')).toMatch(/grossMarginPct\(/);
  });
  test('no editor still divides by a fee/tax-bearing total', () => {
    expect(SRC('change-order-editor.js')).not.toMatch(/fees\.total\s*-\s*subtotal/);
    expect(SRC('change-order-editor.js')).not.toMatch(/\(\s*st\.sell\s*-\s*st\.cost\s*\)\s*\/\s*st\.sell/);
  });
  test('the shared helper reproduces the estimate editor arithmetic exactly', () => {
    const cases = [[27500, 30364.7575], [0, 0], [100, 200], [47200, 100000],
                   [1, 3], [12345.67, 20000.01], [-500, 1000]];
    cases.forEach(([sub, mu]) => {
      const legacy = (mu > 0) ? (((mu - sub) / mu) * 100) : null;
      expect(P.grossMarginPct(sub, mu)).toBe(legacy);
    });
  });
});

describe('the null contract — a margin nobody can compute says so', () => {
  test('grossMarginPct returns null when there is no revenue to divide by', () => {
    [0, -1, -34000].forEach((mu) => expect(P.grossMarginPct(27500, mu)).toBe(null));
    expect(P.grossMarginPct(27500, NaN)).toBe(null);
  });
  test('the CO Margin chip prints an em dash, NOT a confident 0.0%', () => {
    T.setCo({ lines: [] });
    T.paintTotals();
    expect(chips()['Margin']).toBe('—');
  });
});

describe('PROPERTY — margin never reads positive on a loss', () => {
  test('across a wide sweep of subtotal/markedUp pairs', () => {
    for (let sub = 0; sub <= 60000; sub += 977) {
      for (let mu = -20000; mu <= 60000; mu += 1013) {
        const g = P.grossMarginPct(sub, mu);
        if (g === null) continue;
        const profit = mu - sub;
        if (profit < 0) expect(g).toBeLessThan(0);
        if (profit === 0) expect(g).toBe(0);
        if (profit > 0) expect(g).toBeGreaterThan(0);
      }
    }
  });
  test('a change order that loses money never shows a positive margin chip', () => {
    // A $-mode section that gives away more than the lines cost.
    T.setCo({
      taxPct: 7, feeFlat: 5000,
      lines: [
        { id: 's', section: '__section_header__', name: 'Give-back', markupMode: 'dollar', markup: -20000 },
        { id: 'a', qty: 1, unitCost: 10000, markup: 0 },
      ],
    });
    const t = T.computeTotals();
    expect(t.profit).toBeLessThan(0);
    expect(t.marginPct === null || t.marginPct < 0).toBe(true);
  });
});
