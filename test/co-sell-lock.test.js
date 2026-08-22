// test/co-sell-lock.test.js — cost drives sell, and sell can be promised.
//
// A change-order line has always been able to say what it COSTS and let the
// markup cascade derive what it SELLS for. It had nowhere to put the other
// direction: a Buildertrend flat rate is a price quoted to the owner, and
// the only field that would take it was `unitCost` — so the quote was booked
// as AGX's cost, the change order reported $0 profit, and the job's
// estimated cost absorbed the whole thing.
//
// `unitSell` is that missing direction and nothing more. When a line carries
// one, its contribution to the marked-up total is qty x unitSell and its
// markup is not consulted. `unitCost` still means cost. The line's profit is
// finally expressible.
//
// Pure module — no DB, no express, no JWT_SECRET.

const pricing = require('../js/pricing-pipeline.js');
const { changeOrderMoney } = require('../server/services/money/change-order-totals');

describe('a promised price wins over the markup cascade', () => {
  test('the Fairway gutter line, entered honestly', () => {
    // $2,750 quoted, $1,650 of actual cost behind it. Before this field the
    // only expressible version of this line was 2,750 cost / 2,750 sell.
    const rec = { defaultMarkup: 0, lines: [
      { id: 'g', qty: 1, unitCost: 1650, unitSell: 2750, description: 'Gutters — Buildertrend Flat Rate' },
    ] };
    const m = changeOrderMoney(rec);
    expect(m.income).toBe(2750);
    expect(m.costs).toBe(1650);
    expect(m.income - m.costs).toBe(1100);
  });

  test('a locked line ignores its own markup', () => {
    const rec = { defaultMarkup: 0, lines: [
      { id: 'a', qty: 2, unitCost: 100, markup: 500, unitSell: 250 },
    ] };
    expect(changeOrderMoney(rec).income).toBe(500);   // 2 x 250, not 2 x 100 x 6
  });

  test('a locked line ignores the document default markup', () => {
    const rec = { defaultMarkup: 40, lines: [
      { id: 'a', qty: 1, unitCost: 100, unitSell: 130 },
    ] };
    expect(changeOrderMoney(rec).income).toBe(130);   // not 140
  });

  test('a locked line ignores a section that overrides line markups', () => {
    // The section override exists to restate DERIVED prices. A promised
    // price is not derived, so there is nothing for it to restate. New
    // semantic, introduced with the field — no existing record can hit it,
    // because no existing record has a locked line.
    const rec = { defaultMarkup: 0, lines: [
      { id: 's', section: '__section_header__', label: 'Materials', markup: 30, markupMode: 'percent', overrideLineMarkups: true },
      { id: 'a', qty: 1, unitCost: 100, unitSell: 175 },
      { id: 'b', qty: 1, unitCost: 100 },
    ] };
    const m = changeOrderMoney(rec);
    expect(m.income).toBe(305);   // 175 promised + 130 derived
    expect(m.costs).toBe(200);
  });

  test('a $-mode section still adds its flat amount once, alongside a promise', () => {
    const rec = { defaultMarkup: 0, lines: [
      { id: 's', section: '__section_header__', label: 'Sub', markup: 1500, markupMode: 'dollar' },
      { id: 'a', qty: 1, unitCost: 8000, unitSell: 9500 },
    ] };
    const m = changeOrderMoney(rec);
    expect(m.income).toBe(11000);   // 9500 promised + 1500 section adder
    expect(m.costs).toBe(8000);
  });
});

describe('blank is not zero', () => {
  test('unitSell: 0 is a REAL lock at $0 against a real cost', () => {
    // A line given away. Mirrors markup: 0 being a real 0%, and it is why
    // no editor may ever write 0 into the field on the user's behalf.
    const rec = { defaultMarkup: 25, lines: [{ id: 'a', qty: 1, unitCost: 1650, unitSell: 0 }] };
    const m = changeOrderMoney(rec);
    expect(m.income).toBe(0);
    expect(m.costs).toBe(1650);
  });

  test("unitSell: '' is a blank cell and prices through markup", () => {
    const rec = { defaultMarkup: 25, lines: [{ id: 'a', qty: 1, unitCost: 1650, unitSell: '' }] };
    expect(changeOrderMoney(rec).income).toBe(2062.5);
  });

  test('clearing the field un-locks the line and the total moves', () => {
    const locked = { defaultMarkup: 25, lines: [{ id: 'a', qty: 1, unitCost: 1650, unitSell: 2750 }] };
    const cleared = { defaultMarkup: 25, lines: [{ id: 'a', qty: 1, unitCost: 1650, unitSell: '' }] };
    expect(changeOrderMoney(locked).income).toBe(2750);
    expect(changeOrderMoney(cleared).income).toBe(2062.5);
  });

  test('a string price off an input field is read as a number', () => {
    const rec = { defaultMarkup: 0, lines: [{ id: 'a', qty: '2', unitCost: '100', unitSell: '137.50' }] };
    expect(changeOrderMoney(rec).income).toBe(275);
  });
});

// ── The carve-out ───────────────────────────────────────────────────
// Target margin back-solves a marked-up total FROM COST. A promised price
// is not derived from cost, so a margin target may not restate it: the
// promises come out at face value and only the remaining cost is
// back-solved. Every income call site must run this rule, and this is the
// number that catches one that does not.
describe('target margin back-solves the UNLOCKED remainder only', () => {
  const REC = {
    targetMargin: 30,
    lines: [
      { id: 'promised', qty: 1, unitCost: 1650, unitSell: 2750 },
      { id: 'derived', qty: 1, unitCost: 3000 },
    ],
  };
  const CARVED = 7035.714285714286;      // 2750 + 3000 / 0.7
  const UNPORTED = 6642.857142857143;    // 4650 / 0.7 — the promise, discarded

  test('the resolver carves the promise out of the back-solve', () => {
    const per = pricing.computeForLines(REC, REC.lines);
    expect(pricing.resolveMarkedUp(per, REC)).toBe(CARVED);
  });

  test('changeOrderMoney — the WIP and AI-context authority — agrees', () => {
    const m = changeOrderMoney(REC);
    expect(m.income).toBe(CARVED);
    expect(m.costs).toBe(4650);
  });

  test('the OLD hand-rolled ternary is provably WRONG here, by $392.86', () => {
    // This is the assertion that makes an un-ported call site fail loudly
    // instead of silently under-reporting a change order. If someone
    // reverts resolveMarkedUp to `applyTargetMargin(per.subtotal, rec)`,
    // the test above goes red rather than the money going quiet.
    const per = pricing.computeForLines(REC, REC.lines);
    const unported = pricing.applyTargetMargin(per.subtotal, REC);
    expect(unported).toBe(UNPORTED);
    expect(unported).not.toBe(CARVED);
    expect(Math.round((CARVED - UNPORTED) * 100) / 100).toBe(392.86);
  });

  test('with nothing promised, the resolver IS the original expression', () => {
    // Character for character — this is the branch every change order in
    // the database takes, and it may not so much as re-associate.
    const rec = { targetMargin: 30, lines: [{ id: 'a', qty: 1, unitCost: 4650 }] };
    const per = pricing.computeForLines(rec, rec.lines);
    expect(pricing.resolveMarkedUp(per, rec)).toBe(pricing.applyTargetMargin(per.subtotal, rec));
    expect(pricing.resolveMarkedUp(per, rec)).toBe(UNPORTED);
  });

  test('with target margin inactive, the resolver returns markedUp untouched', () => {
    const rec = { defaultMarkup: 20, lines: [{ id: 'a', qty: 1, unitCost: 100 }] };
    const per = pricing.computeForLines(rec, rec.lines);
    expect(pricing.resolveMarkedUp(per, rec)).toBe(per.markedUp);
  });

  test('a fully promised record under a target margin is entirely its promises', () => {
    const rec = { targetMargin: 30, lines: [{ id: 'a', qty: 1, unitCost: 1650, unitSell: 2750 }] };
    // Remaining cost is zero, so the back-solve contributes nothing.
    expect(changeOrderMoney(rec).income).toBe(2750);
  });

  test('fees, tax and rounding still ride on top of the resolved total', () => {
    const rec = Object.assign({ feeFlat: 100, taxPct: 7, roundTo: 5 }, REC);
    // (7035.714285714286 + 100) * 1.07 = 7635.214285714286 → ceil to 5
    expect(changeOrderMoney(rec).income).toBe(7640);
  });
});

// ── The NaN trap the empty-array return exists to close ─────────────
describe('a stripped per-object degrades to today number, never to NaN', () => {
  test('the empty-lines return carries all four keys', () => {
    const per = pricing.computeForLines({ targetMargin: 30 }, []);
    expect(per).toEqual({ subtotal: 0, markedUp: 0, lockedSubtotal: 0, lockedSell: 0 });
  });

  test('an empty change order with a target margin and a fee is $500, not NaN', () => {
    // Omit lockedSubtotal/lockedSell from that early return and this
    // becomes NaN, which then propagates into totalIncome, revisedProfit,
    // revisedMargin and backlog — the entire job tile.
    const m = changeOrderMoney({ targetMargin: 30, feeFlat: 500, lines: [] });
    expect(m.income).toBe(500);
    expect(Number.isNaN(m.income)).toBe(false);
  });

  test('a hand-built {subtotal, markedUp} literal still resolves to a number', () => {
    // js/estimate-editor.js rebuilds `per` exactly like this in two places.
    // The locked keys are num()-coerced so this degrades to the old answer
    // rather than poisoning a job.
    const rec = { targetMargin: 30 };
    const stripped = { subtotal: 4650, markedUp: 5000 };
    const out = pricing.resolveMarkedUp(stripped, rec);
    expect(Number.isNaN(out)).toBe(false);
    expect(out).toBe(6642.857142857143);
  });

  test('resolveMarkedUp survives a null per-object', () => {
    expect(Number.isNaN(pricing.resolveMarkedUp(null, { targetMargin: 30 }))).toBe(false);
    expect(pricing.resolveMarkedUp(null, { targetMargin: 30 })).toBe(0);
  });
});

// ── lineMoney: one rule, so the rows and the total cannot disagree ──
describe('lineMoney is the single per-line rule the row paints share', () => {
  test('an unlocked line reports its derived sell and the markup that made it', () => {
    const lines = [{ id: 'a', qty: 2, unitCost: 100 }];
    const mm = pricing.lineMoney(lines[0], lines, { defaultMarkup: 25 });
    expect(mm).toEqual({ ext: 200, sell: 250, locked: false, markup: 25 });
  });

  test('a locked line reports its promise and says so', () => {
    const lines = [{ id: 'a', qty: 2, unitCost: 100, unitSell: 175 }];
    const mm = pricing.lineMoney(lines[0], lines, { defaultMarkup: 25 });
    expect(mm).toEqual({ ext: 200, sell: 350, locked: true, markup: null });
  });

  test('ext is ALWAYS qty x unitCost — locked or not', () => {
    const a = pricing.lineMoney({ qty: 3, unitCost: 40 }, [], {});
    const b = pricing.lineMoney({ qty: 3, unitCost: 40, unitSell: 999 }, [], {});
    expect(a.ext).toBe(120);
    expect(b.ext).toBe(120);
  });

  test('computeForLines sums exactly what lineMoney returns', () => {
    const rec = { defaultMarkup: 15 };
    const lines = [
      { id: 'a', qty: 2, unitCost: 100 },
      { id: 'b', qty: 1, unitCost: 500, unitSell: 800 },
      { id: 'c', qty: 4, unitCost: 25, markup: 60 },
    ];
    const per = pricing.computeForLines(rec, lines);
    const byHand = lines.reduce((acc, l) => {
      const mm = pricing.lineMoney(l, lines, rec);
      acc.subtotal += mm.ext; acc.markedUp += mm.sell;
      if (mm.locked) { acc.lockedSubtotal += mm.ext; acc.lockedSell += mm.sell; }
      return acc;
    }, { subtotal: 0, markedUp: 0, lockedSubtotal: 0, lockedSell: 0 });
    expect(per).toEqual(byHand);
  });

  test('sellLocked reads the same three states the pricing branch reads', () => {
    expect(pricing.sellLocked({ unitSell: 0 })).toBe(true);
    expect(pricing.sellLocked({ unitSell: 2750 })).toBe(true);
    expect(pricing.sellLocked({ unitSell: '' })).toBe(false);
    expect(pricing.sellLocked({ unitSell: null })).toBe(false);
    expect(pricing.sellLocked({})).toBe(false);
    expect(pricing.sellLocked(null)).toBe(false);
  });
});
