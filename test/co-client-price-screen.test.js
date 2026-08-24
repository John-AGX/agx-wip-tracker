/**
 * @jest-environment jsdom
 */
// test/co-client-price-screen.test.js
//
// WHAT THE SCREEN SAYS ABOUT A CLIENT PRICE, AND WHETHER IT IS TRUE.
//
// The gate collapse made the total and the rows take one decision. These are
// the three places the SCREEN still described that decision wrongly:
//
//   1. THE REFUSAL BAND asserted "This change order is priced from its line
//      markups until it is." On a record that also carries a Target Margin
//      that is false — resolveMarkedUp falls through the client price to the
//      target-margin back-solve. Measured: the band claimed $12,200.00 where
//      the app had priced $12,876.92, and a second band sat beneath it
//      saying "the total is back-solved from cost", so the two sentences on
//      screen contradicted each other and neither matched the chip.
//
//   2. ROUND TO paused on a price that merely PARSED, so a refused price
//      still moved the total — measured at -$400.00 and -$300.00 at
//      roundTo 500. (Fixed in the pipeline; asserted here at the screen.)
//
//   3. THE ROW carried a second idiom. `markupDead = locked || targetOn`
//      knew nothing about a client price, so the Markup % cell stayed live
//      and editable while its keystrokes no longer set the total; and the
//      Unit Sell placeholder divided the UNSCALED mm.sell, printing
//      $15,000.00 under a row priced at $15,987.46. 1.19's rule is that a
//      promise greys the dialects it overrides and a cell is never both
//      greyed and lying.

const fs = require('fs');
const path = require('path');

global.window.p86Pricing = require('../js/pricing-pipeline.js');
window.p86Pricing = global.window.p86Pricing;
const P = window.p86Pricing;
const editor = require('../js/change-order-editor.js');
const T = editor.__test;

const ED = fs.readFileSync(path.join(__dirname, '..', 'js', 'change-order-editor.js'), 'utf8');
const money = (n) => '$' + Number(n).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function mount() {
  document.body.innerHTML =
    '<div id="co-editor-overlay">' +
      '<input data-field="targetMargin" /><input data-field="roundTo" />' +
      '<div id="p86CoTotals"></div><div id="p86CoLineTable"></div>' +
    '</div>';
}
const noticeText = () => (document.getElementById('p86CoNotices') || { textContent: '' }).textContent;
const rows = () => Array.from(document.querySelectorAll('tr.p86-co-line-row'));
const cell = (tr, f) => tr.querySelector('[data-line-field="' + f + '"]');
const amountOf = (tr) => tr.querySelector('td.ext').textContent.replace(/[^0-9.\-]/g, '');

beforeEach(mount);

// ══════════════════════════════════════════════════════════════════════
// 1 — THE REFUSAL BAND DESCRIBES THE FALLBACK IT ACTUALLY TOOK
// ══════════════════════════════════════════════════════════════════════
describe('a refusal names the rule that actually priced the document', () => {
  // Every line promised → 'no-free-pool'. With a target margin also set,
  // the fallback is the TARGET MARGIN, not the line markups.
  const REFUSED_WITH_MARGIN = () => ({
    targetPrice: '12000', targetMargin: 30,
    lines: [
      { id: 'a', qty: 1, unitCost: 8000, unitSell: 12200 },
      { id: 'b', qty: 1, unitCost: 100, markup: 10 },
    ],
  });

  test('with a Target Margin set, the band says Target Margin — not line markups', () => {
    const co = REFUSED_WITH_MARGIN();
    T.setCo(co); T.paintTotals();
    const t = T.computeTotals();
    expect(t.clientPrice.ok).toBe(false);
    const txt = noticeText();
    // The false sentence is gone...
    expect(txt).not.toContain('priced from its line markups');
    // ...replaced by the rule that actually ran, named with its percent.
    expect(txt).toContain('priced from its Target Margin of 30.0%');
    // ...and by the number the chip is actually showing.
    expect(txt).toContain(money(t.total));
  });

  test('the band never claims a fallback the app did not take', () => {
    // Drive every refusal reason, with and without a target margin, and
    // require the sentence to match what resolveMarkedUp actually did.
    const recs = [
      ['unparseable', { targetPrice: 'not a number', lines: [{ id: 'a', qty: 1, unitCost: 100, markup: 10 }] }],
      ['not-positive', { targetPrice: '-500', lines: [{ id: 'a', qty: 1, unitCost: 100, markup: 10 }] }],
      ['below-floor', { targetPrice: '4000', feeFlat: 5000, taxPct: 7, lines: [{ id: 'a', qty: 1, unitCost: 2000 }] }],
      ['promised-exceeds', { targetPrice: '12000', lines: [
        { id: 'a', qty: 1, unitCost: 8000, unitSell: 12200 },
        { id: 'b', qty: 1, unitCost: 100, markup: 10 }] }],
      ['no-free-pool', { targetPrice: '17000', lines: [{ id: 'a', qty: 1, unitCost: 10000, unitSell: 17600 }] }],
    ];
    for (const [reason, base] of recs) {
      for (const margin of [null, 30]) {
        const co = Object.assign({}, base, margin ? { targetMargin: margin } : {});
        co.lines = base.lines.map((l) => Object.assign({}, l));
        T.setCo(co); T.paintTotals();
        const t = T.computeTotals();
        expect({ reason, margin, got: t.clientPrice.reason }).toEqual({ reason, margin, got: reason });
        const txt = noticeText();
        const marginRan = P.targetMarginActive(co);
        expect({ reason, margin, saysMarkups: txt.includes('priced from its line markups') })
          .toEqual({ reason, margin, saysMarkups: !marginRan });
        expect({ reason, margin, saysMargin: txt.includes('priced from its Target Margin') })
          .toEqual({ reason, margin, saysMargin: marginRan });
        // and whichever it named, it named the RIGHT NUMBER — the one the
        // Total chip is showing at that moment.
        expect(txt).toContain(money(t.total));
      }
    }
  });

  test('the two bands agree instead of contradicting each other', () => {
    const co = REFUSED_WITH_MARGIN();
    T.setCo(co); T.paintTotals();
    const txt = noticeText();
    // Both bands paint (the target-margin one carries the carve-out detail),
    // but they now describe the SAME rule rather than two different ones.
    expect(txt).toContain('back-solved from cost');
    expect(txt).toContain('priced from its Target Margin');
    expect(txt).not.toContain('priced from its line markups');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2 — A REFUSED PRICE DOES NOT PAUSE ROUND TO
// ══════════════════════════════════════════════════════════════════════
describe('round-to pauses on an HONOURED price, never on a refused one', () => {
  test('the refusal band does not claim Round to is paused', () => {
    const co = { targetPrice: '17000', roundTo: 500,
      lines: [{ id: 'a', qty: 1, unitCost: 10000, unitSell: 17600 }] };
    T.setCo(co); T.paintTotals();
    expect(T.computeTotals().clientPrice.roundToPaused).toBe(false);
    expect(noticeText()).not.toContain('is paused');
  });

  test('and the Round to field is not greyed while the price is refused', () => {
    const co = { targetPrice: '17000', roundTo: 500,
      lines: [{ id: 'a', qty: 1, unitCost: 10000, unitSell: 17600 }] };
    T.setCo(co); T.paintTotals();
    const rt = document.querySelector('[data-field="roundTo"]');
    expect(rt.readOnly).toBe(false);
    // ...and it is still doing its job on the number the chip shows.
    expect(T.computeTotals().total % 500).toBe(0);
  });

  test('an honoured price still pauses it, and still says so', () => {
    const co = { targetPrice: '34250', roundTo: 500,
      lines: [{ id: 'a', qty: 1, unitCost: 20000, markup: 20 },
              { id: 'b', qty: 1, unitCost: 5000, markup: 10 }] };
    T.setCo(co); T.paintTotals();
    const t = T.computeTotals();
    expect(t.clientPrice.ok).toBe(true);
    expect(t.clientPrice.roundToPaused).toBe(true);
    expect(noticeText()).toContain('is paused');
    expect(document.querySelector('[data-field="roundTo"]').readOnly).toBe(true);
    expect(t.total).toBeCloseTo(34250, 6);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3 — THE ROW IDIOM. 1.19: greyed, or truthful. Never both greyed and lying.
// ══════════════════════════════════════════════════════════════════════
describe('a client price greys the dialects it overrides', () => {
  // The measured record: $20,000 typed over two markup lines, scale
  // x1.092896. Row 0 paints $16,393.44 and its Unit Sell placeholder used
  // to read $15,000.00.
  const SCALED = () => ({ targetPrice: '20000', lines: [
    { id: 'a', qty: 1, unitCost: 12500, markup: 20 },
    { id: 'b', qty: 1, unitCost: 1500, markup: 10 },
  ] });

  test('the Markup % cell is greyed and unfocusable under a client price', () => {
    T.setCo(SCALED()); T.paintLines();
    for (const tr of rows()) {
      const mk = cell(tr, 'markup');
      expect(mk.hasAttribute('readonly')).toBe(true);
      expect(mk.getAttribute('tabindex')).toBe('-1');
      expect(mk.getAttribute('placeholder')).toBe('client price');
      expect(mk.getAttribute('title')).toContain('Client Price');
    }
  });

  test('the Unit Sell placeholder is the amount beside it, divided by qty', () => {
    T.setCo(SCALED()); T.paintLines();
    for (const tr of rows()) {
      const amount = Number(amountOf(tr));
      const qty = Number(cell(tr, 'qty').value);
      const ph = Number(cell(tr, 'unitSell').getAttribute('placeholder').replace(/,/g, ''));
      // The cell may not print a per-unit price the row does not charge.
      expect(ph).toBeCloseTo(amount / qty, 2);
    }
    // The specific lie: the UNSCALED cost x markup ($12,500 x 1.20 =
    // $15,000.00) printed under a row the document actually charges more
    // for. The placeholder must be the scaled figure, and the two must
    // genuinely differ or this record proves nothing.
    const co = SCALED();
    const st = P.clientPriceState(co, co.lines);
    const unscaled = 12500 * 1.2;
    expect(st.ok).toBe(true);
    expect(st.sells[0]).not.toBeCloseTo(unscaled, 2);
    const ph0 = Number(cell(rows()[0], 'unitSell').getAttribute('placeholder').replace(/,/g, ''));
    expect(ph0).not.toBeCloseTo(unscaled, 2);
    expect(ph0).toBeCloseTo(st.sells[0], 2);
  });

  test('a client price outranks a target margin in the placeholder too', () => {
    const co = Object.assign(SCALED(), { targetMargin: 30 });
    T.setCo(co); T.paintLines();
    expect(cell(rows()[0], 'markup').getAttribute('placeholder')).toBe('client price');
  });

  test('with the price REFUSED the markup cell is live again', () => {
    // ...unless a target margin is separately standing it down, which is
    // the pre-existing rule and is unchanged.
    const co = { targetPrice: 'not an amount', lines: [
      { id: 'a', qty: 1, unitCost: 12500, markup: 20 },
      { id: 'b', qty: 1, unitCost: 1500, markup: 10 }] };
    T.setCo(co); T.paintLines();
    expect(T.computeTotals().clientPrice.ok).toBe(false);
    const mk = cell(rows()[0], 'markup');
    expect(mk.hasAttribute('readonly')).toBe(false);
    expect(mk.getAttribute('placeholder')).toBe('20.0');
  });

  test('a promised line still reads as promised, not as client-priced', () => {
    const co = { targetPrice: '20000', lines: [
      { id: 'a', qty: 1, unitCost: 1650, unitSell: 2750 },
      { id: 'b', qty: 1, unitCost: 12500, markup: 20 }] };
    T.setCo(co); T.paintLines();
    // The promise is the more specific statement about ITS row.
    expect(cell(rows()[0], 'markup').getAttribute('placeholder')).toContain('implied');
    expect(cell(rows()[1], 'markup').getAttribute('placeholder')).toBe('client price');
    // ...and the promised row is not restated.
    expect(Number(amountOf(rows()[0]))).toBe(2750);
  });

  // The incremental repaint and the full repaint disagreeing about one row
  // is a bug class this editor has shipped before, so it is asserted rather
  // than assumed.
  test('the incremental repaint agrees with the full one', () => {
    jest.useFakeTimers();
    window.p86Api = { changeOrders: { update: () => Promise.resolve({}) } };
    try {
      T.setCo(SCALED()); T.paintLines();
      const tr = rows()[1];
      const q = cell(tr, 'qty');
      q.value = '2';
      q.dispatchEvent(new window.Event('input', { bubbles: true }));
      // what the row now says, after the incremental path ran
      const after = {
        amount: amountOf(tr),
        markupDead: cell(tr, 'markup').readOnly,
        markupPh: cell(tr, 'markup').placeholder,
        sellPh: cell(tr, 'unitSell').placeholder,
      };
      // ...and what a full rebuild would say
      T.paintLines();
      const full = rows()[1];
      expect(after).toEqual({
        amount: amountOf(full),
        markupDead: cell(full, 'markup').hasAttribute('readonly'),
        markupPh: cell(full, 'markup').getAttribute('placeholder'),
        sellPh: cell(full, 'unitSell').getAttribute('placeholder'),
      });
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  test('there is ONE row idiom, not two — both paint sites read the same three rules', () => {
    // The defect was a second copy that knew only two of them.
    const dead = ED.match(/^\s*var (?:markupDead|dead) = .*$/gm);
    expect(dead).toHaveLength(2);
    for (const d of dead) {
      expect(d).toMatch(/locked/);
      expect(d).toMatch(/targetOn/);
      expect(d).toMatch(/priceOn|alloc/);      // ...and the client price
    }
  });
});
