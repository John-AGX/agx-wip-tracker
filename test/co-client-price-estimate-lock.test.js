// test/co-client-price-estimate-lock.test.js
//
// THE ESTIMATE LOCK IS `alternates`, AND NOTHING ELSE.
//
// A document client price on an estimate multiplies the proposal by the
// number of included alternates — every estimate total loops `alternates`
// and SUMS a per-group resolve, so an absolute price is applied once PER
// INCLUDED GROUP: $39,285.71 becomes $196,428.57 at five, silently. A target
// margin survives that because a rate is linear across a sum; an absolute is
// not.
//
// clientPriceRequested guards it, and the guard is sound. But its comment
// claimed TWO locks — `alternates != null` AND "requires the flat `lines[]`
// array only a change order has". The second is false: every stored estimate
// blob has `lines[]` (estimate-totals.js reads `est.lines` as its primary
// input and filters it by alternateId), so that test discriminates nothing.
// A comment describing a belt that does not exist is how a future reader
// deletes the brace.
//
// The load on the single real lock went UP with the gate collapse: the
// client-price decision now rides on computeForLines, which estimates call
// ONCE PER INCLUDED ALTERNATE.

const fs = require('fs');
const path = require('path');
const P = require('../js/pricing-pipeline.js');

// ══════════════════════════════════════════════════════════════════════
// 4 — THE ESTIMATE GUARD IS ONE LOCK, AND THE COMMENT NOW SAYS SO
// ══════════════════════════════════════════════════════════════════════
describe('the estimate lock is `alternates`, and nothing else', () => {
  const PIPE = fs.readFileSync(path.join(__dirname, '..', 'js', 'pricing-pipeline.js'), 'utf8');

  test('every stored estimate blob HAS lines[], so that half locks nothing', () => {
    // The measured fact the old comment denied. estimate-totals.js reads
    // est.lines as its primary input.
    const EST = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'money', 'estimate-totals.js'), 'utf8');
    expect(EST).toMatch(/est\.lines/);
    const est = { lines: [{ id: 'x', qty: 1, unitCost: 100, markup: 10 }], targetPrice: '12000' };
    expect(Array.isArray(est.lines)).toBe(true);
    // With `alternates` absent, the lines[] test does NOT refuse it...
    expect(P.clientPriceRequested(est)).toBe(true);
    // ...so `alternates` is carrying the guard by itself.
    est.alternates = [];
    expect(P.clientPriceRequested(est)).toBe(false);
  });

  test('the comment no longer describes a belt that does not exist', () => {
    expect(PIPE).not.toMatch(/requires the flat\s*\n?\s*\/\/\s*`lines\[\]` array only a change order has/);
    expect(PIPE).toMatch(/THAT IS ONE LOCK, NOT TWO/);
    expect(PIPE).toMatch(/EVERY STORED ESTIMATE\s*\n?\s*\/\/\s*BLOB HAS `lines\[\]`/);
  });

  test('and the lock holds against the multiplication it exists to prevent', () => {
    const est = { targetPrice: '39285.71',
      alternates: [{ id: 'a', included: true }, { id: 'b', included: true }],
      lines: [{ id: 'x', qty: 1, unitCost: 30000, markup: 10 }] };
    expect(P.computeForLines(est, est.lines).clientPrice).toBe(null);
    // priced per alternate, the typed price would have been applied twice
    const per = P.computeForLines(est, est.lines);
    expect(P.resolveMarkedUp(per, est)).toBe(per.markedUp);
  });
});
