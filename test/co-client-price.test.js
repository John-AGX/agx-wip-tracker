/**
 * @jest-environment jsdom
 */
// test/co-client-price.test.js
//
// John types the number the client will pay; the app back-computes the
// markup and the margin. `targetPrice` on a change-order record, absent
// everywhere it has ever been, solved by bisection on the real
// applyFeesAndTax, and allocated by scaling every unpromised line's PRICE
// by one factor with the cents settled in STORED LINE ORDER.
//
// WRITTEN AS PROPERTIES, not as a list of screenshots:
//
//   1. with no targetPrice key, EVERY number is byte-identical to today
//   2. with one, either the displayed total is the typed number exactly,
//      or the screen says why it cannot be
//   3. promised (unitSell) lines are NEVER restated
//   4. the line Amounts always sum to the marked-up total, to the cent
//   5. margin never reads positive on a loss
//
// FIXTURES ARE WHAT PRODUCERS ACTUALLY EMIT. Money arrives off input
// elements, so half of it is string-typed. Imported lines have no
// `unitSell`. `markup` is ''/null/number. qty and unitCost reach 0. And the
// document's own targetPrice arrives as a RAW STRING through a PUT that
// spreads req.body with no whitelist, which is why "$34,000" and "34,000.00"
// are in the corpus and not just 34000.
//
// RED AGAINST THE CODE AS IT STANDS BEFORE THIS COMMIT — measured, 35 of
// 42 fail. The 7 that pass are the deliberate controls: the two source
// assertions that estimates and bt-export never learn this word, the
// ceiling measurement, the reachable-total measurement, and the
// margin-never-positive-on-a-loss property the previous commit already
// guarantees. Stated plainly because a suite that is green before the
// change is not testing the change.
//
// One honest caveat on the no-reprice property below: its DIVERGENCE
// assertion is the control and holds either way, but the test as written
// also asserts that the new discriminator never fires, so it errors rather
// than passing on a build where that function does not yet exist.

const fs = require('fs');
const path = require('path');

global.window.p86Pricing = require('../js/pricing-pipeline.js');
window.p86Pricing = global.window.p86Pricing;
const P = window.p86Pricing;
const editor = require('../js/change-order-editor.js');
const T = editor.__test;

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
const money = (n) => '$' + Number(n).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function mount() {
  document.body.innerHTML =
    '<div id="co-editor-overlay">' +
      '<input data-field="targetMargin" /><input data-field="roundTo" />' +
      '<div id="p86CoTotals"></div><div id="p86CoLineTable"></div>' +
    '</div>';
}
const chips = () => Array.from(document.querySelectorAll('#p86CoTotals .p86-co-chip'))
  .reduce((a, c) => {
    a[c.querySelector('.p86-co-chip-label').textContent] =
      c.querySelector('.p86-co-chip-value').textContent;
    return a;
  }, {});
const noticeText = () => (document.getElementById('p86CoNotices') || { textContent: '' }).textContent;
const rowAmounts = () => Array.from(document.querySelectorAll('tr.p86-co-line-row td.ext'))
  .map((td) => td.textContent.replace(/[^0-9.\-]/g, ''));

// The whole document, priced the way every consumer prices it.
function priced(rec) {
  const lines = Array.isArray(rec.lines) ? rec.lines : [];
  const per = P.computeForLines(rec, lines);
  const markedUp = P.resolveMarkedUp(per, rec);
  const fees = P.applyFeesAndTax(markedUp, rec, per);
  return {
    subtotal: per.subtotal, markedUp, total: fees.total,
    feePctAmount: fees.feePctAmount, taxAmount: fees.taxAmount, rounded: fees.rounded,
  };
}

beforeEach(mount);

// ══════════════════════════════════════════════════════════════════════
// PROPERTY 1 — NOTHING ALREADY SAVED MAY REPRICE
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — a record with no targetPrice key is byte-identical', () => {
  // A deterministic LCG so a failure is reproducible from its seed alone.
  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  // Legacy shapes, built from what change-order producers actually emit.
  function legacyRecord(r) {
    const pick = (a) => a[Math.floor(r() * a.length)];
    // Money off an input element is a STRING half the time.
    const m = (n) => (r() < 0.5 ? String(n) : n);
    const n = 1 + Math.floor(r() * 6);
    const lines = [];
    for (let i = 0; i < n; i++) {
      if (r() < 0.22) {
        lines.push({
          id: 'S' + i, section: '__section_header__', label: 'Sec ' + i,
          markupMode: pick(['percent', 'dollar', '']),
          markup: pick(['', null, 0, 12.5, m(500), -250]),
          overrideLineMarkups: r() < 0.3,
        });
        continue;
      }
      const line = {
        description: 'Line ' + i,
        qty: pick([1, 2, 0, 4.5, m(3)]),
        unitCost: pick([0, 250, m(2750), 1650.25, m(0)]),
        markup: pick(['', null, 0, 10.4173, 20, m(35)]),
      };
      // Imported records have no id. That is the shape a suite whose
      // fixtures all carry one has never actually tested.
      if (r() < 0.6) line.id = 'L' + i;
      if (r() < 0.15) line.costPending = true;
      lines.push(line);
    }
    const rec = {
      lines,
      defaultMarkup: pick(['', null, 0, 15, m(22.5)]),
      feeFlat: pick([0, m(0), 1500, m(2500.75)]),
      feePct: pick([0, m(0), 3, 8]),
      taxPct: pick([0, m(0), 6.5, 7, 8.5]),
      roundTo: pick([0, m(0), 25, 500]),
      // Including the out-of-range values targetMarginActive rejects.
      targetMargin: pick(['', null, 0, 100, -5, 30, m(42.5)]),
    };
    return rec;
  }

  test('250,000 legacy-shaped records: zero divergences on six figures', () => {
    // The reference is the SHIPPED module as of the previous commit —
    // reconstructed here as the arithmetic it performed, so this asserts
    // against a fixed target rather than against itself.
    function legacyPrice(rec) {
      const lines = rec.lines;
      const per = P.computeForLines(rec, lines);
      let markedUp;
      if (P.targetMarginActive(rec)) {
        const ls = P.num(per.lockedSell), lsub = P.num(per.lockedSubtotal);
        markedUp = (!ls && !lsub)
          ? P.applyTargetMargin(per.subtotal, rec)
          : ls + P.applyTargetMargin(per.subtotal - lsub, rec);
      } else markedUp = per.markedUp;
      const feeFlat = P.num(rec.feeFlat);
      const feePctAmount = markedUp * P.num(rec.feePct) / 100;
      const preTax = markedUp + feeFlat + feePctAmount;
      const taxAmount = preTax * P.num(rec.taxPct) / 100;
      const beforeRound = preTax + taxAmount;
      const roundTo = P.num(rec.roundTo);
      let total = beforeRound, rounded = 0;
      if (roundTo > 0) { total = Math.ceil(beforeRound / roundTo) * roundTo; rounded = total - beforeRound; }
      return { subtotal: per.subtotal, markedUp, total, feePctAmount, taxAmount, rounded };
    }

    const r = rng(20260823);
    const KEYS = ['subtotal', 'markedUp', 'total', 'feePctAmount', 'taxAmount', 'rounded'];
    let driven = 0, withUnitSell = 0, branchFired = 0, diverged = 0;
    let firstBad = null;
    for (let i = 0; i < 250000; i++) {
      const rec = legacyRecord(r);
      driven++;
      if (rec.lines.some((l) => l.unitSell !== undefined)) withUnitSell++;
      if (P.clientPriceRequested(rec)) branchFired++;
      const got = priced(rec), want = legacyPrice(rec);
      for (const k of KEYS) {
        if (!Object.is(got[k], want[k])) {
          diverged++; if (!firstBad) firstBad = { i, k, got: got[k], want: want[k], rec };
          break;
        }
      }
    }
    expect({ driven, withUnitSell, branchFired, diverged })
      .toEqual({ driven: 250000, withUnitSell: 0, branchFired: 0, diverged: 0 });
    expect(firstBad).toBe(null);
  }, 240000);

  test('the discriminator: a cleared field is not a client price', () => {
    // ⚠ THE NEGATIVE CONTROL. Written as `rec.targetPrice != null`, an empty
    // string leaks true and the branch fires on a blank field.
    const base = { lines: [{ id: 'a', qty: 1, unitCost: 1000, markup: 20 }] };
    [undefined, null, '', '   ', '\t'].forEach((v) => {
      const rec = Object.assign({}, base);
      if (v !== undefined) rec.targetPrice = v;
      expect({ v, requested: P.clientPriceRequested(rec) }).toEqual({ v, requested: false });
      expect(priced(rec).total).toBe(1200);
    });
  });

  test('a record with targetPrice but no lines[] is not a change order', () => {
    // The structural gate. resolveMarkedUp is CO-only today, but the
    // estimate editor's own TODO invites it to start calling this.
    expect(P.clientPriceRequested({ targetPrice: '34000' })).toBe(false);
    expect(P.clientPriceRequested({ targetPrice: '34000', lines: {} })).toBe(false);
    expect(P.clientPriceRequested({ targetPrice: '34000', lines: [] })).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ESTIMATES — OUT OF SCOPE, AND STRUCTURALLY UNREACHABLE
// ══════════════════════════════════════════════════════════════════════
describe('an estimate can never reach this', () => {
  test('a record carrying alternates is refused outright', () => {
    const est = { targetPrice: '39285.71', alternates: [{ id: 1 }], lines: [] };
    expect(P.clientPriceRequested(est)).toBe(false);
    expect(P.clientPriceInForce(est)).toBe(false);
    expect(P.clientPriceState(est, [])).toBe(null);
  });

  test('the reason: an absolute price multiplies per included group', () => {
    // A rate is linear across a sum; an absolute is not. This is the
    // measurement, run against p86Pricing itself, that keeps the guard
    // above from looking like superstition.
    const target = 39285.71;
    const perGroupSubtotal = 27500;
    for (const groups of [1, 2, 3, 5]) {
      let byRate = 0, byAbsolute = 0;
      for (let g = 0; g < groups; g++) {
        byRate += P.applyTargetMargin(perGroupSubtotal, { targetMargin: 30 });
        byAbsolute += target;                       // one resolve PER GROUP
      }
      expect(byAbsolute).toBeCloseTo(target * groups, 6);
      expect(byRate).toBeCloseTo(39285.714285714286 * groups, 6);
    }
    // The absolute is silently N× the number typed. That is why it is
    // change-order-only.
    expect(39285.71 * 2).toBeCloseTo(78571.42, 2);
    expect(39285.71 * 5).toBeCloseTo(196428.55, 2);
  });

  test('js/estimate-editor.js never mentions targetPrice', () => {
    expect(SRC('estimate-editor.js')).not.toMatch(/targetPrice/);
    expect(SRC('estimate-preview.js')).not.toMatch(/targetPrice/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// FINDING 1 — PARSING. A typed price is CURRENCY, not a percent.
// ══════════════════════════════════════════════════════════════════════
describe('FINDING 1 — currency parsing, and unparseable is never zero', () => {
  test('num() is the wrong parser, and the table says by how much', () => {
    expect(P.num('34,000.00')).toBe(34);      // $34.00
    expect(P.num('$34,000')).toBe(0);
    expect(P.num(' ')).toBe(0);
    expect(P.parseMoney('34,000.00')).toBe(34000);
    expect(P.parseMoney('$34,000')).toBe(34000);
    expect(P.parseMoney('$ 34,000.00')).toBe(34000);
    expect(P.parseMoney(34000)).toBe(34000);
    expect(P.parseMoney('.5')).toBe(0.5);
  });

  test('anything unreadable returns null — never 0', () => {
    ['abc', '34000abc', '$', '1.2.3', '--5', 'NaN', 'Infinity', {}, [], true]
      .forEach((v) => expect({ v: String(v), got: P.parseMoney(v) }).toEqual({ v: String(v), got: null }));
  });

  test('an unparseable price REFUSES on screen and prices nothing', () => {
    T.setCo({ targetPrice: '$34,00O', lines: [{ id: 'a', qty: 1, unitCost: 27500, markup: 20 }] });
    T.paintTotals();
    expect(chips()['Change Order Total']).toBe(money(33000));   // the markup total
    expect(noticeText()).toContain('“$34,00O” is not an amount this can read');
    expect(noticeText()).toContain('priced from its line markups');
  });

  test('the human forms a person actually types all price correctly', () => {
    ['34000', '34,000', '34,000.00', '$34,000', '$34,000.00', '$ 34,000.00'].forEach((typed) => {
      T.setCo({ targetPrice: typed, lines: [{ id: 'a', qty: 1, unitCost: 27500, markup: 20 }] });
      T.paintTotals();
      expect({ typed, total: chips()['Change Order Total'] })
        .toEqual({ typed, total: money(34000) });
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// FINDING 2 — ROUND-TO. A ceiling is not injective.
// ══════════════════════════════════════════════════════════════════════
describe('FINDING 2 — Round to $ stands down, and says so', () => {
  const LINES = [{ id: 'a', qty: 1, unitCost: 27500, markup: 20 }];

  test('a ceiling collapses the reachable totals — the measurement', () => {
    const distinct = (roundTo) => {
      const s = new Set();
      for (let mu = 30000; mu <= 32000; mu += 0.5) {
        // sumOfPriced([]) — "no priced set contributed to this number", which
        // is the literal truth of a bare probe against a bare {roundTo} record.
        // The pause is off, so the ceiling is live and the collapse is what is
        // being measured.
        s.add(P.applyFeesAndTax(mu, { roundTo }, P.sumOfPriced([])).total);
      }
      return s.size;
    };
    expect(distinct(0)).toBe(4001);
    expect(distinct(500)).toBeLessThan(10);
  });

  test('a typed price that is NOT a multiple of roundTo is still exact', () => {
    T.setCo({ targetPrice: '34250', roundTo: 500, lines: LINES });
    T.paintTotals();
    expect(chips()['Change Order Total']).toBe(money(34250));
    expect(noticeText()).toContain('Round to ' + money(500) + ' is paused');
    expect(noticeText()).toContain('cannot land on an exact typed price');
  });

  test('the roundTo input itself shows paused, not merely a band elsewhere', () => {
    T.setCo({ targetPrice: '34250', roundTo: 500, lines: LINES });
    T.paintTotals();
    const rt = document.querySelector('[data-field="roundTo"]');
    expect(rt.readOnly).toBe(true);
    expect(rt.title).toContain('Paused');
  });

  test('clearing the client price restores the round-up exactly', () => {
    T.setCo({ targetPrice: '', roundTo: 400, lines: LINES });
    T.paintTotals();
    expect(chips()['Change Order Total']).toBe(money(33200));   // ceil(33000/400)*400
    expect(document.querySelector('[data-field="roundTo"]').readOnly).toBe(false);
  });

  test('js/bt-export.js is out of this blast radius, and here is why', () => {
    // It hand-rolls its own ceiling, so a pipeline-level pause cannot reach
    // it. It is also estimate-only — it reads appData.estimateLines filtered
    // by estimateId/alternateId — and a client price is change-order-only,
    // so there is nothing for the pause to reach there. The hand-rolled
    // pipeline remains a real standing drift risk FOR ESTIMATES; it is not
    // this commit's, and this test pins both halves of that claim.
    const bt = SRC('bt-export.js');
    expect(bt).toMatch(/estimateLines/);
    expect(bt).not.toMatch(/targetPrice/);
    expect(bt).not.toMatch(/changeOrder/i);
  });
});

// ══════════════════════════════════════════════════════════════════════
// FINDING 3 / 4 — freePool == 0, in all of its shapes.
// ══════════════════════════════════════════════════════════════════════
describe('FINDING 3 & 4 — nothing to scale is REFUSED, never divided by', () => {
  const SHAPES = [
    ['every line promised', [{ id: 'a', qty: 1, unitCost: 1, unitSell: 2000 }], 'already promised'],
    ['no lines at all', [], 'no lines'],
    ['one unpromised line at qty 0', [{ id: 'a', qty: 0, unitCost: 500, markup: 10 }], 'no price to scale'],
    ['one unpromised line at unitCost 0', [{ id: 'a', qty: 1, unitCost: 0, markup: 10 }], 'no price to scale'],
    ['unpromised lines that cancel', [{ id: 'a', qty: 1, unitCost: 500 }, { id: 'b', qty: 1, unitCost: -500 }], 'no price to scale'],
    ['three $0-cost lines (finding 4)', [
      { id: 'a', qty: 1, unitCost: 0 }, { id: 'b', qty: 1, unitCost: 0 }, { id: 'c', qty: 1, unitCost: 0 },
    ], 'no price to scale'],
  ];

  SHAPES.forEach(([name, lines, phrase]) => {
    test(name + ' — refused, with a finite total the rows account for', () => {
      const rec = { targetPrice: '34000', lines };
      const st = P.clientPriceState(rec, lines);
      expect({ name, ok: st.ok, reason: st.reason }).toEqual({ name, ok: false, reason: 'no-free-pool' });
      expect(st.sells).toBe(null);
      // No NaN, no ±Infinity, and no restated promise.
      const p = priced(rec);
      expect(Number.isFinite(p.total)).toBe(true);
      expect(Number.isFinite(p.markedUp)).toBe(true);
      T.setCo(rec); T.paintTotals(); T.paintLines();
      expect(noticeText()).toContain(phrase);
      rowAmounts().forEach((a) => expect(a).not.toMatch(/NaN|Infinity/));
    });
  });

  test('finding 4 exactly: the screen never shows a total it cannot account for', () => {
    // Before: line prices of $0.01 each summing to $0.03 under a printed
    // total of $34,000.00, with the amber affordance silent because it keys
    // off PROMISED lines and a $0-cost line is not promised.
    const lines = [{ id: 'a', qty: 1, unitCost: 0 }, { id: 'b', qty: 1, unitCost: 0 }, { id: 'c', qty: 1, unitCost: 0 }];
    T.setCo({ targetPrice: '34000', lines });
    T.paintTotals(); T.paintLines();
    expect(chips()['Change Order Total']).toBe(money(0));
    const sum = rowAmounts().reduce((a, b) => a + Number(b), 0);
    expect(sum).toBe(0);
    // and the affordance fires on the POOL, not on lockedCount.
    expect(noticeText()).toContain('3 of 3 unpromised lines price at ' + money(0));
  });

  test('promised prices that already exceed the typed price refuse too', () => {
    const lines = [
      { id: 'a', qty: 1, unitCost: 1, unitSell: 36000 },
      { id: 'b', qty: 1, unitCost: 100, markup: 10 },
    ];
    const st = P.clientPriceState({ targetPrice: '34000', lines }, lines);
    expect(st.reason).toBe('promised-exceeds');
    T.setCo({ targetPrice: '34000', lines }); T.paintTotals();
    expect(noticeText()).toContain('promised prices already come to more than');
    expect(noticeText()).toContain(money(36000));
  });
});

// ══════════════════════════════════════════════════════════════════════
// FINDING 5 — below the fee floor. It CONVERGES, so Rule A cannot see it.
// ══════════════════════════════════════════════════════════════════════
describe('FINDING 5 — a price below the fee floor is refused by name', () => {
  test('$4,000 against feeFlat 5000 + 7% tax: markedUp solves NEGATIVE', () => {
    const rec = { targetPrice: '4000', feeFlat: 5000, taxPct: 7, lines: [{ id: 'a', qty: 1, unitCost: 2000 }] };
    const st = P.clientPriceState(rec, rec.lines);
    // The solve SUCCEEDS — which is exactly why a convergence check alone
    // does not catch this.
    expect(st.markedUp).toBeCloseTo(-1261.68, 2);
    // The price is REFUSED (below-floor), so nothing was honoured and the
    // pause is off — sumOfPriced([]) says exactly that. roundTo is 0 here
    // anyway, which is why the solve still lands on the typed price.
    expect(Math.abs(P.applyFeesAndTax(st.markedUp, rec, P.sumOfPriced([])).total - 4000)).toBeLessThan(0.005);
    expect({ ok: st.ok, reason: st.reason }).toEqual({ ok: false, reason: 'below-floor' });
    expect(st.floorTotal).toBeCloseTo(5350, 6);
  });

  test('the refusal names the floor in currency, not "too low"', () => {
    T.setCo({ targetPrice: '4000', feeFlat: 5000, taxPct: 7, lines: [{ id: 'a', qty: 1, unitCost: 2000 }] });
    T.paintTotals(); T.paintLines();
    const n = noticeText();
    expect(n).toContain('below this change order’s floor');
    expect(n).toContain(money(5350));
    expect(n).toContain('every line would price below zero');
    // and NOT a single negative line price on screen
    rowAmounts().forEach((a) => expect(Number(a)).toBeGreaterThanOrEqual(0));
  });

  test('no chip ever reads a positive margin against a negative profit', () => {
    [
      { targetPrice: '4000', feeFlat: 5000, taxPct: 7, lines: [{ id: 'a', qty: 1, unitCost: 2000 }] },
      { targetPrice: '34000', feeFlat: 50000, lines: [{ id: 'a', qty: 1, unitCost: 28000 }] },
      { targetPrice: '535', feeFlat: 500, lines: [{ id: 'a', qty: 1, unitCost: 500 }] },
    ].forEach((rec) => {
      T.setCo(rec);
      const t = T.computeTotals();
      if (t.profit < 0) {
        expect(t.marginPct === null || t.marginPct < 0).toBe(true);
      }
      T.paintTotals();
      const m = chips()['Margin'];
      if (t.profit < 0) expect(m === '—' || m.startsWith('-')).toBe(true);
    });
  });

  test('a price that lands but loses money is SHOWN losing money', () => {
    // $535 against a $500 flat fee leaves $35 for $500 of work. That is a
    // legitimate, honourable allocation — so it is not refused — but the
    // loss is stated in words rather than left inside a percentage.
    T.setCo({ targetPrice: '535', feeFlat: 500, lines: [{ id: 'a', qty: 1, unitCost: 500 }] });
    T.paintTotals();
    expect(chips()['Change Order Total']).toBe(money(535));
    const n = noticeText();
    expect(n).toContain('prices the work below its cost');
    expect(n).toContain('a gross loss of ' + money(465));
    expect(chips()['Margin'].startsWith('-')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// FINDING 6 — the singularity.
// ══════════════════════════════════════════════════════════════════════
describe('FINDING 6 — (1+fee%)(1+tax%) === 0 refuses instead of delivering $0', () => {
  [['feePct', -100], ['taxPct', -100]].forEach(([field, v]) => {
    test(field + ' = -100 is refused, not solved to the bracket bound', () => {
      const rec = { targetPrice: '34000', lines: [{ id: 'a', qty: 1, unitCost: 27500 }] };
      rec[field] = v;
      const st = P.clientPriceState(rec, rec.lines);
      expect({ ok: st.ok, reason: st.reason }).toEqual({ ok: false, reason: 'unreachable' });
      expect(st.markedUp).toBe(null);
      // and NOT 1,000,000,000, which is what an unguarded bisect returns.
      expect(priced(rec).markedUp).toBe(27500);
      T.setCo(rec); T.paintTotals();
      expect(noticeText()).toContain('cannot be produced from these fees and tax');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE ALLOCATION RULE — scale, don't flatten. Cents in stored order.
// ══════════════════════════════════════════════════════════════════════
describe('the allocation rule', () => {
  // Passthrough sub at 0% markup, labor at 30%, materials at 20%.
  const REC = () => ({
    targetPrice: '34,000.00',
    lines: [
      { id: 'a', qty: 1, unitCost: 15000, markup: 0, description: 'Passthrough sub' },
      { id: 'b', qty: 1, unitCost: 7000, markup: 30, description: 'Labor' },
      { id: 'c', qty: 1, unitCost: 6500, markup: 20, description: 'Materials' },
    ],
  });

  test('one factor over every unpromised line, to the exact cent', () => {
    const rec = REC();
    const st = P.clientPriceState(rec, rec.lines);
    expect(st.ok).toBe(true);
    expect(st.scale).toBeCloseTo(1.0658307210031348, 12);
    expect(st.sells).toEqual([15987.46, 9699.06, 8313.48]);
    expect(st.sells.reduce((a, b) => a + b, 0)).toBe(34000);
  });

  test('SCALE, not FLATTEN — the zero-margin passthrough carries no markup', () => {
    const rec = REC();
    const st = P.clientPriceState(rec, rec.lines);
    // What flatten-to-one-margin would have done instead.
    const cost = [15000, 7000, 6500];
    const flatten = cost.map((c) => c / (1 - (1 - 28500 / 34000)));
    expect(flatten[0]).toBeCloseTo(17894.74, 2);
    expect(st.sells[0]).toBeCloseTo(15987.46, 2);
    expect(flatten[0] - st.sells[0]).toBeCloseTo(1907.28, 2);   // markup it must never carry
    expect(st.sells[1] - flatten[1]).toBeCloseTo(1348.18, 2);   // labor flatten would have cut
  });

  test('the solve is EXACT on a fee-bearing record, not merely close', () => {
    // This is what separates a bisection from the obvious algebraic
    // inverse. T/((1+fee%)(1+tax%)) - feeFlat forgets that feeFlat is taxed
    // but NOT fee-percented: on the first row below it lands $214.01 low,
    // which Rule A would then refuse — a working feature turned into a
    // refusal by arithmetic that looks right.
    [
      { feeFlat: 2500, feePct: 8, taxPct: 7 },
      { feeFlat: 1410.94, feePct: 0, taxPct: 7 },
      { feeFlat: 0, feePct: 3, taxPct: 8.5 },
      { feeFlat: 5000, feePct: 12, taxPct: 0 },
    ].forEach((fees) => {
      const rec = Object.assign({ targetPrice: '34000', lines: [{ id: 'a', qty: 1, unitCost: 20000, markup: 20 }] }, fees);
      const per = P.computeForLines(rec, rec.lines);
      const st = per.clientPrice;
      expect({ fees, ok: st.ok }).toEqual({ fees, ok: true });
      // The price IS honoured here, so the decision comes from the `per` that
      // honoured it — and st.markedUp is exactly what that per resolves to,
      // which is what makes the call legal at all.
      expect(P.applyFeesAndTax(st.markedUp, rec, per).total).toBeCloseTo(34000, 6);
      expect(money(priced(rec).total)).toBe(money(34000));
    });
  });

  test('a constant-total record refuses even when the typed price MATCHES', () => {
    // The singularity's nastiest form. feePct -100 makes every markedUp
    // produce $5,350.00, and the typed price IS $5,350.00 — so the bracket
    // test cannot reject it, and an unguarded bisect converges to -1e9 with
    // the verify passing at zero error. Nothing is solvable here: the total
    // does not depend on the work at all.
    const rec = { targetPrice: '5350', feeFlat: 5000, feePct: -100, taxPct: 7,
      lines: [{ id: 'a', qty: 1, unitCost: 100, markup: 20 }] };
    // Bare probes of the arithmetic at two markedUps — nothing was priced to
    // produce either number, and the price is refused anyway.
    expect(P.applyFeesAndTax(0, rec, P.sumOfPriced([])).total).toBeCloseTo(5350, 9);
    expect(P.applyFeesAndTax(999999, rec, P.sumOfPriced([])).total).toBeCloseTo(5350, 9);
    const st = P.clientPriceState(rec, rec.lines);
    expect({ ok: st.ok, reason: st.reason, markedUp: st.markedUp })
      .toEqual({ ok: false, reason: 'unreachable', markedUp: null });
  });

  test('an EXACT remainder tie goes to the earlier STORED line, always', () => {
    // The tie-break is the whole content of the building-sort rule: with
    // two remainders equal, "largest remainder" does not decide, and
    // anything but stored index makes the settling cent depend on how the
    // table happens to be ordered. $1,000 and $3,000 at 0% markup typed at
    // $1,000.06 puts both remainders at exactly 0.5 with one cent to place.
    const lines = [
      { id: 'first', qty: 1, unitCost: 1000, markup: 0 },
      { id: 'second', qty: 1, unitCost: 3000, markup: 0 },
    ];
    const st = P.clientPriceState({ targetPrice: '1000.06', lines }, lines);
    expect(st.sells).toEqual([250.02, 750.04]);          // NOT [250.01, 750.05]
    expect(st.sells.reduce((a, b) => a + b, 0)).toBe(1000.06);
    // and reversing the STORED order moves the cent with it, which is the
    // reason the array may never be sorted for display before this runs.
    const rev = [lines[1], lines[0]];
    expect(P.clientPriceState({ targetPrice: '1000.06', lines: rev }, rev).sells)
      .toEqual([750.05, 250.01]);
  });

  test('the cents settle in STORED ORDER and do not move on repaint', () => {
    // js/building-sort.js:39 — never re-order an array a remainder walk
    // reads. The tie-break is the stored index, so a display sort cannot
    // move a penny.
    const rec = REC();
    const a = P.clientPriceState(rec, rec.lines).sells;
    const b = P.clientPriceState(rec, rec.lines).sells;
    expect(a).toEqual(b);
    // The same lines in a DIFFERENT stored order allocate their cents to a
    // different line — which is correct, and is the reason the array may
    // never be sorted for display before this runs.
    const shuffled = { targetPrice: rec.targetPrice, lines: [rec.lines[2], rec.lines[0], rec.lines[1]] };
    const s = P.clientPriceState(shuffled, shuffled.lines).sells;
    expect(s.reduce((x, y) => x + y, 0)).toBe(34000);
    expect(new Set(s.map((n) => Math.round(n * 100) % 100)).size).toBeGreaterThan(0);
    expect(SRC('pricing-pipeline.js')).toMatch(/building-sort\.js/);
  });

  test('promised lines are NEVER restated, and the rest absorb the move', () => {
    const lines = [
      { id: 'a', qty: 1, unitCost: 1650, unitSell: 2750 },       // promised
      { id: 'b', qty: 1, unitCost: 7000, markup: 30 },
      { id: 'c', qty: 1, unitCost: 6500, markup: 20 },
    ];
    const rec = { targetPrice: '34000', lines };
    const st = P.clientPriceState(rec, lines);
    expect(st.ok).toBe(true);
    expect(st.sells[0]).toBe(2750);                              // untouched
    expect(st.sells.reduce((a, b) => a + b, 0)).toBe(34000);
    T.setCo(rec); T.paintTotals();
    expect(noticeText()).toContain('carved out at ' + money(2750));
  });

  test('a $-mode section adder scales with everything else it is not', () => {
    const lines = [
      { id: 's', section: '__section_header__', label: 'GC', markupMode: 'dollar', markup: 1000 },
      { id: 'a', qty: 1, unitCost: 9000, markup: 0 },
    ];
    const st = P.clientPriceState({ targetPrice: '20000', lines }, lines);
    expect(st.sells.reduce((a, b) => a + b, 0)).toBe(20000);
    expect(st.sells[0] / st.sells[1]).toBeCloseTo(1000 / 9000, 9);
  });
});

// ══════════════════════════════════════════════════════════════════════
// PROPERTIES 2, 4 and 5, swept.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — either the total is exact, or the screen says why', () => {
  function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  test('40,000 records carrying a client price: no silent wrong number', () => {
    const r = rng(861532);
    const pick = (a) => a[Math.floor(r() * a.length)];
    let honoured = 0, refused = 0;
    const reasons = {};
    for (let i = 0; i < 40000; i++) {
      const n = Math.floor(r() * 5);
      const lines = [];
      for (let k = 0; k < n; k++) {
        if (r() < 0.15) {
          lines.push({ section: '__section_header__', id: 'S' + k, markupMode: pick(['percent', 'dollar']), markup: pick(['', 0, 500, 12]) });
          continue;
        }
        const l = { qty: pick([0, 1, 2, 3.5]), unitCost: pick([0, 250, 2750, '1650.25']), markup: pick(['', null, 0, 20, 35]) };
        if (r() < 0.35) l.unitSell = pick([0, 500, 2750]);
        if (r() < 0.6) l.id = 'L' + k;
        lines.push(l);
      }
      const rec = {
        lines,
        targetPrice: pick(['34000', '$34,000', '34,000.00', '4000', '535', '0', '-500', 'abc', '  ', 250000]),
        feeFlat: pick([0, 500, 5000, 50000]), feePct: pick([0, 8, -100]),
        taxPct: pick([0, 7, 8.5, -100]), roundTo: pick([0, 25, 500]),
        targetMargin: pick(['', 0, 30]),
      };
      const st = P.clientPriceState(rec, lines);
      if (!st) continue;                                       // blank field
      const p = priced(rec);
      // Nothing is ever NaN or infinite, honoured or refused.
      expect(Number.isFinite(p.total) && Number.isFinite(p.markedUp)).toBe(true);
      if (st.ok) {
        honoured++;
        // 2 — the displayed total IS the typed number, to the cent.
        expect(money(p.total)).toBe(money(st.target));
        // 4 — the line Amounts sum to the marked-up total, to the cent.
        const sum = st.sells.reduce((a, b) => a + b, 0);
        expect(money(sum)).toBe(money(p.markedUp));
        st.sells.forEach((v) => expect(Number.isFinite(v)).toBe(true));
        // 3 — a promise is never restated.
        lines.forEach((l, ix) => {
          if (P.sellLocked(l)) expect(st.sells[ix]).toBe(P.num(l.qty) * P.num(l.unitSell));
        });
      } else {
        refused++;
        reasons[st.reason] = (reasons[st.reason] || 0) + 1;
        expect(st.sells).toBe(null);
        expect(typeof st.reason).toBe('string');
      }
      // 5 — margin never reads positive on a loss.
      const g = P.grossMarginPct(p.subtotal, p.markedUp);
      if (g !== null && p.markedUp - p.subtotal < 0) expect(g).toBeLessThan(0);
    }
    expect(honoured).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(1000);
    // every refusal reason this build can produce is actually exercised
    expect(Object.keys(reasons).sort()).toEqual(
      ['below-floor', 'no-free-pool', 'not-positive', 'promised-exceeds', 'unparseable', 'unreachable']);
  }, 240000);

  test('every refusal reason renders a band that names the reason', () => {
    const CASES = [
      ['unparseable', { targetPrice: 'abc', lines: [{ id: 'a', qty: 1, unitCost: 100 }] }, 'not an amount this can read'],
      ['not-positive', { targetPrice: '-500', lines: [{ id: 'a', qty: 1, unitCost: 100 }] }, 'must be more than ' + money(0)],
      ['below-floor', { targetPrice: '4000', feeFlat: 5000, taxPct: 7, lines: [{ id: 'a', qty: 1, unitCost: 2000 }] }, 'below this change order’s floor'],
      ['unreachable', { targetPrice: '34000', feePct: -100, lines: [{ id: 'a', qty: 1, unitCost: 100 }] }, 'cannot be produced from these fees and tax'],
      ['no-free-pool', { targetPrice: '34000', lines: [{ id: 'a', qty: 1, unitCost: 0 }] }, 'no price to scale'],
      ['promised-exceeds', { targetPrice: '1000', lines: [{ id: 'a', qty: 1, unitCost: 1, unitSell: 5000 }, { id: 'b', qty: 1, unitCost: 10 }] }, 'already come to more than'],
    ];
    CASES.forEach(([reason, rec, phrase]) => {
      const st = P.clientPriceState(rec, rec.lines);
      expect({ reason, got: st.reason }).toEqual({ reason, got: reason });
      mount();
      T.setCo(rec); T.paintTotals();
      const band = document.querySelector('.p86-co-notice-clientprice');
      expect(band).not.toBe(null);
      expect({ reason, said: band.textContent.indexOf(phrase) >= 0 }).toEqual({ reason, said: true });
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE SURFACE — where the control lives and how it saves.
// ══════════════════════════════════════════════════════════════════════
describe('the control, the stand-down and the save', () => {
  test('Client Price is a text field, not a number field', () => {
    // type="number" discards "$34,000" the instant the $ is typed.
    const src = SRC('change-order-editor.js');
    expect(src).toMatch(/<span>Client Price \$<\/span>/);
    expect(src).toMatch(/type="text" inputmode="decimal" autocomplete="off" data-field="targetPrice"/);
  });

  test('the raw string is stored, uncoerced', () => {
    expect(SRC('change-order-editor.js')).toMatch(/if \(f === 'targetPrice'\) \{[\s\S]{0,600}_state\.co\[f\] = v;/);
  });

  test('targetPrice is in the save payload, and a typed 0 round-trips', () => {
    T.setCo({ id: 1, targetPrice: '0', lines: [] });
    expect(T.coSavePayload(T.getCo()).targetPrice).toBe('0');
    T.setCo({ id: 1, lines: [] });
    expect(T.coSavePayload(T.getCo()).targetPrice).toBe('');
  });

  test('Target Margin visibly stands down when a client price is in force', () => {
    T.setCo({ targetPrice: '34000', targetMargin: 30, lines: [{ id: 'a', qty: 1, unitCost: 27500, markup: 20 }] });
    T.paintTotals();
    const tm = document.querySelector('[data-field="targetMargin"]');
    expect(tm.readOnly).toBe(true);
    expect(tm.title).toContain('Standing down');
    expect(noticeText()).toContain('Target Margin 30.0% is standing down');
    // and the typed price is what the document is worth
    expect(chips()['Change Order Total']).toBe(money(34000));
  });

  test('a REFUSED client price leaves the target margin live', () => {
    T.setCo({ targetPrice: 'abc', targetMargin: 30, lines: [{ id: 'a', qty: 1, unitCost: 27500, markup: 20 }] });
    T.paintTotals();
    expect(document.querySelector('[data-field="targetMargin"]').readOnly).toBe(false);
    // 27500 / (1 - 0.30)
    expect(chips()['Change Order Total']).toBe(money(39285.71));
  });

  test('the row Amounts on screen sum to the total, on both paint paths', () => {
    const rec = {
      targetPrice: '34,000.00',
      lines: [
        { id: 'a', qty: 1, unitCost: 15000, markup: 0 },
        { id: 'b', qty: 1, unitCost: 7000, markup: 30 },
        { id: 'c', qty: 1, unitCost: 6500, markup: 20 },
      ],
    };
    T.setCo(rec); T.paintLines(); T.paintTotals();
    expect(rowAmounts().map(Number)).toEqual([15987.46, 9699.06, 8313.48]);
    // the incremental repaint a keystroke takes must agree
    const qty = document.querySelectorAll('tr.p86-co-line-row [data-line-field="qty"]')[1];
    qty.value = '1';
    qty.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(rowAmounts().map(Number).reduce((a, b) => a + b, 0)).toBe(34000);
  });
});
