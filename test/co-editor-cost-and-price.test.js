/**
 * @jest-environment jsdom
 */
// test/co-editor-cost-and-price.test.js — the editor where a human can
// finally see the difference between what a change order COSTS and what it
// SELLS for.
//
// The old line table was: Qty · Unit Cost · Description · Markup % ·
// Marked-Up. Two structural problems, and together they are the whole bug.
// The raw cost extension — the number that becomes the change order's
// `costs` and lands in the job's Total Est. Costs — was NEVER ON SCREEN.
// And cost and price were never visible at the same time. Pasting a
// Buildertrend flat rate into Unit Cost was therefore invisible by
// construction: nothing on screen contradicted it.
//
// So this asserts the rendered table, against a real DOM, rather than
// asserting the source that renders it.

const path = require('path');

// The pipeline is a plain script; the editor reads it off window.
global.window.p86Pricing = require('../js/pricing-pipeline.js');
window.p86Pricing = global.window.p86Pricing;
const editor = require('../js/change-order-editor.js');
const T = editor.__test;

const fs = require('fs');
const CO_ED_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'change-order-editor.js'), 'utf8');

function mount() {
  document.body.innerHTML =
    '<div id="p86CoTotals"></div><div id="p86CoLineTable"></div>';
}
const cellText = (tr, sel) => (tr.querySelector(sel) || {}).textContent || '';
const rows = () => Array.from(document.querySelectorAll('tr.p86-co-line-row'));
const secRows = () => Array.from(document.querySelectorAll('tr.p86-co-section-row'));
const chips = () => Array.from(document.querySelectorAll('#p86CoTotals .p86-co-chip'))
  .reduce((acc, c) => {
    acc[c.querySelector('.p86-co-chip-label').textContent] =
      c.querySelector('.p86-co-chip-value').textContent;
    return acc;
  }, {});

beforeEach(() => { mount(); });

describe('cost and price are on screen at the same time', () => {
  test('the table has an Ext. Cost column and a Unit Sell column', () => {
    T.setCo({ defaultMarkup: 0, lines: [{ id: 'a', qty: 1, unitCost: 2750 }] });
    T.paintLines();
    const heads = Array.from(document.querySelectorAll('thead th'))
      .map((th) => th.textContent.trim());
    expect(heads).toEqual(['Description', 'Qty', 'Unit', 'Unit Cost',
      'Markup %', 'Unit Sell', 'Ext. Cost', 'Amount', '']);
  });

  test('Ext. Cost shows qty x unitCost — the number that reaches the job', () => {
    T.setCo({ defaultMarkup: 20, lines: [{ id: 'a', qty: 4, unitCost: 250 }] });
    T.paintLines();
    expect(cellText(rows()[0], 'td.cost')).toBe('$1,000.00');
    expect(cellText(rows()[0], 'td.ext')).toContain('$1,200.00');
  });

  test('CO-0001 renders its own bug plainly: $2,750 of cost, $2,750 of price', () => {
    T.setCo({ defaultMarkup: 0, lines: [
      { id: 'a', qty: 1, unitCost: 2750, description: 'Gutters — Buildertrend Flat Rate' },
    ] });
    T.paintLines(); T.paintTotals();
    expect(cellText(rows()[0], 'td.cost')).toBe('$2,750.00');
    expect(cellText(rows()[0], 'td.ext')).toContain('$2,750.00');
    expect(chips()['Est. Cost']).toBe('$2,750.00');
    expect(chips().Profit).toBe('$0.00');
    expect(chips().Margin).toBe('0.0%');
  });

  test('the same line, repaired: $1,650 of cost behind a $2,750 promise', () => {
    T.setCo({ defaultMarkup: 0, lines: [
      { id: 'a', qty: 1, unitCost: 1650, unitSell: 2750, description: 'Gutters' },
    ] });
    T.paintLines(); T.paintTotals();
    expect(cellText(rows()[0], 'td.cost')).toBe('$1,650.00');
    expect(cellText(rows()[0], 'td.ext')).toContain('$2,750.00');
    expect(chips()['Est. Cost']).toBe('$1,650.00');
    expect(chips().Profit).toBe('$1,100.00');
    expect(chips().Margin).toBe('40.0%');
    expect(chips()['Change Order Total']).toBe('$2,750.00');
  });
});

describe('the chip that used to say Subtotal now says what it is', () => {
  test('Est. Cost, not Subtotal — that chip IS the job cost', () => {
    T.setCo({ defaultMarkup: 0, lines: [{ id: 'a', qty: 1, unitCost: 100 }] });
    T.paintTotals();
    const labels = Object.keys(chips());
    expect(labels).toContain('Est. Cost');
    expect(labels).toContain('Profit');
    expect(labels).not.toContain('Subtotal');
  });
});

describe('Markup % and Unit Sell are mutually exclusive', () => {
  test('a promised line greys its markup cell and shows the implied percent', () => {
    T.setCo({ defaultMarkup: 0, lines: [{ id: 'a', qty: 1, unitCost: 1650, unitSell: 2750 }] });
    T.paintLines();
    const mk = rows()[0].querySelector('[data-line-field="markup"]');
    expect(mk.hasAttribute('readonly')).toBe(true);
    expect(mk.getAttribute('placeholder')).toBe('66.7% implied');
  });

  test('an ordinary line keeps its markup cell live, with the inherited % as placeholder', () => {
    T.setCo({ defaultMarkup: 22, lines: [{ id: 'a', qty: 1, unitCost: 100 }] });
    T.paintLines();
    const mk = rows()[0].querySelector('[data-line-field="markup"]');
    expect(mk.hasAttribute('readonly')).toBe(false);
    expect(mk.getAttribute('placeholder')).toBe('22.0');
  });

  test('an unlocked line shows the price it WOULD carry as a Unit Sell placeholder', () => {
    T.setCo({ defaultMarkup: 25, lines: [{ id: 'a', qty: 4, unitCost: 200 }] });
    T.paintLines();
    const sell = rows()[0].querySelector('[data-line-field="unitSell"]');
    expect(sell.value).toBe('');                        // never a value
    expect(sell.getAttribute('placeholder')).toBe('250.00');
  });

  test('a target margin greys every markup cell — the cell used to LIE', () => {
    // A target margin already overrode per-line markups, but the cell
    // stayed editable-looking and swallowed keystrokes that did nothing.
    T.setCo({ targetMargin: 32, defaultMarkup: 10, lines: [{ id: 'a', qty: 1, unitCost: 100 }] });
    T.paintLines();
    const mk = rows()[0].querySelector('[data-line-field="markup"]');
    expect(mk.hasAttribute('readonly')).toBe(true);
    expect(mk.getAttribute('placeholder')).toBe('target margin');
  });

  test('under a target margin a promised line is still editable on the sell side', () => {
    T.setCo({ targetMargin: 32, lines: [{ id: 'a', qty: 1, unitCost: 100, unitSell: 180 }] });
    T.paintLines();
    const sell = rows()[0].querySelector('[data-line-field="unitSell"]');
    expect(sell.hasAttribute('readonly')).toBe(false);
    expect(sell.value).toBe('180');
  });

  test('implied markup is withheld rather than invented when there is no cost', () => {
    // "Infinite margin on $0 of cost" is a number that can only mislead.
    expect(T.coImpliedMarkup({ qty: 1, unitCost: 0, unitSell: 500 })).toBe(null);
    expect(T.coImpliedMarkup({ qty: 1, unitCost: 1650, unitSell: 2750 })).toBeCloseTo(66.667, 3);
  });
});

describe('a section shows its own margin, so a zero-margin trade is obvious', () => {
  const REC = { defaultMarkup: 0, lines: [
    { id: 's1', section: '__section_header__', label: 'Gutters', markup: '', markupMode: 'percent' },
    { id: 'a', qty: 1, unitCost: 1650, unitSell: 2750 },
    { id: 's2', section: '__section_header__', label: 'Paint', markup: '', markupMode: 'percent' },
    { id: 'b', qty: 1, unitCost: 4000 },
  ] };

  test('each header row carries its cost, its amount and a GM chip', () => {
    T.setCo(REC);
    T.paintLines();
    const [g, p] = secRows();
    expect(cellText(g, 'td.cost')).toBe('$1,650.00');
    expect(cellText(g, 'td.ext')).toContain('$2,750.00');
    expect(cellText(g, 'td.ext')).toContain('GM 40.0%');
    expect(cellText(p, 'td.cost')).toBe('$4,000.00');
    expect(cellText(p, 'td.ext')).toContain('GM 0.0%');   // priced at cost
  });

  test('section attribution is POSITIONAL, exactly as the pricing cascade is', () => {
    // Array order IS the section on a change order. That is also why the
    // catalog drawer splices a line inside its section rather than at the
    // array end — placement is money, not tidiness.
    const t = T.coSectionTotals(REC.lines, REC);
    expect(t.s1).toEqual({ cost: 1650, sell: 2750, locked: 1, lines: 1 });
    expect(t.s2).toEqual({ cost: 4000, sell: 4000, locked: 0, lines: 1 });
  });

  test("a $-mode section's flat adder counts toward that section's own amount", () => {
    const rec = { defaultMarkup: 0, lines: [
      { id: 's1', section: '__section_header__', label: 'Sub', markup: 1500, markupMode: 'dollar' },
      { id: 'a', qty: 1, unitCost: 8000 },
    ] };
    expect(T.coSectionTotals(rec.lines, rec).s1).toEqual({ cost: 8000, sell: 9500, locked: 0, lines: 1 });
  });

  test('lines before any header belong to no section and report nowhere', () => {
    const rec = { defaultMarkup: 0, lines: [
      { id: 'orphan', qty: 1, unitCost: 100 },
      { id: 's1', section: '__section_header__', label: 'Later', markup: '' },
    ] };
    const t = T.coSectionTotals(rec.lines, rec);
    expect(t.s1).toEqual({ cost: 0, sell: 0, locked: 0, lines: 0 });
    expect(Object.keys(t)).toEqual(['s1']);
  });
});

describe('the notices say what a chip cannot', () => {
  test('a target margin announces itself AND names the carved-out promises', () => {
    T.setCo({ targetMargin: 32, lines: [
      { id: 'a', qty: 1, unitCost: 1650, unitSell: 2750 },
      { id: 'b', qty: 1, unitCost: 3000 },
    ] });
    T.paintTotals();
    const txt = document.getElementById('p86CoNotices').textContent;
    expect(txt).toMatch(/Target margin 32\.0%/);
    expect(txt).toMatch(/per-line markups are ignored/);
    expect(txt).toMatch(/1 line with a promised Unit Sell is excluded/);
  });

  test('no target margin, no banner', () => {
    T.setCo({ defaultMarkup: 20, lines: [{ id: 'a', qty: 1, unitCost: 100 }] });
    T.paintTotals();
    expect(document.getElementById('p86CoNotices').textContent.trim()).toBe('');
  });

  test('placeholder costs are counted and called out', () => {
    T.setCo({ defaultMarkup: 0, lines: [
      { id: 'a', qty: 1, unitCost: 2750, unitSell: 2750, costPending: true },
      { id: 'b', qty: 1, unitCost: 1800, unitSell: 1800, costPending: true },
      { id: 'c', qty: 1, unitCost: 900, unitSell: 1500 },
    ] });
    T.paintLines(); T.paintTotals();
    expect(document.getElementById('p86CoNotices').textContent)
      .toMatch(/2 lines need a real cost/);
    expect(document.querySelectorAll('.p86-co-pending')).toHaveLength(2);
  });

  test('costPending is DISPLAY ONLY — it never reaches the money', () => {
    const withFlag = { defaultMarkup: 0, lines: [{ id: 'a', qty: 1, unitCost: 2750, costPending: true }] };
    const without = { defaultMarkup: 0, lines: [{ id: 'a', qty: 1, unitCost: 2750 }] };
    expect(window.p86Pricing.computeForLines(withFlag, withFlag.lines))
      .toEqual(window.p86Pricing.computeForLines(without, without.lines));
    // And the pipeline has never heard of the flag.
    expect(fs.readFileSync(path.join(__dirname, '..', 'js', 'pricing-pipeline.js'), 'utf8'))
      .not.toMatch(/costPending/);
  });
});

describe('blank is not zero, in the editor as in the pipeline', () => {
  test('+ Add Line seeds unitSell BLANK — writing 0 would lock the line at free', () => {
    expect(CO_ED_SRC).toMatch(/qty: 1, unitCost: 0, unit: 'ea', unitSell: '',/);
    expect(CO_ED_SRC).not.toMatch(/unitSell: 0[,}]/);
  });

  test('unitSell joins the numeric whitelists that keep a blank cell blank', () => {
    const hits = CO_ED_SRC.match(/\['qty', 'unitCost', 'markup', 'unitSell'\]/g) || [];
    expect(hits).toHaveLength(2);   // the input handler and the blur reconcile
  });

  test('a locked line renders its promise as a VALUE, not a placeholder', () => {
    T.setCo({ defaultMarkup: 0, lines: [{ id: 'a', qty: 1, unitCost: 100, unitSell: 0 }] });
    T.paintLines();
    const sell = rows()[0].querySelector('[data-line-field="unitSell"]');
    expect(sell.value).toBe('0');                 // a real lock at $0
    expect(cellText(rows()[0], 'td.ext')).toContain('$0.00');
    expect(cellText(rows()[0], 'td.cost')).toBe('$100.00');
  });
});

describe('the editor never normalises a record it merely opened', () => {
  test('painting an old change order adds no key to any line', () => {
    // A mount-time "seed unit/unitSell on every line" would be inert to
    // money and still wrong: the PUT's IS DISTINCT FROM guard would bump
    // updated_at on every change order anyone so much as looked at.
    const co = { defaultMarkup: 0, lines: [
      { id: 'a', qty: 1, unitCost: 2750, description: 'Buildertrend Flat Rate' },
    ] };
    const before = JSON.stringify(co);
    T.setCo(co);
    T.paintLines(); T.paintTotals();
    expect(JSON.stringify(T.getCo())).toBe(before);
  });
});

// ── The actual keystrokes John will make on Fairways ────────────────
describe('typing a price, then a cost, and watching only the cost move', () => {
  // The debounced autosave must not fire a real PUT in jsdom.
  let saves;
  beforeEach(() => {
    jest.useFakeTimers();
    saves = [];
    window.p86Api = { changeOrders: { update: (id, data) => { saves.push(data); return Promise.resolve({}); } } };
  });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  const type = (tr, field, value) => {
    const el = tr.querySelector('[data-line-field="' + field + '"]');
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    return el;
  };

  test('Unit Sell locks the line, greys markup, and moves the total — cost untouched', () => {
    const co = { defaultMarkup: 0, lines: [
      { id: 'a', qty: 1, unitCost: 2750, description: 'Gutters — Buildertrend Flat Rate' },
    ] };
    T.setCo(co);
    T.paintLines(); T.paintTotals();
    expect(chips().Profit).toBe('$0.00');

    // Step 1 — move the number into Unit Sell. The price is now a promise.
    type(rows()[0], 'unitSell', '2750');
    T.paintTotals();
    expect(T.getCo().lines[0].unitSell).toBe(2750);
    expect(T.getCo().lines[0].unitCost).toBe(2750);          // cost untouched
    expect(chips()['Change Order Total']).toBe('$2,750.00'); // income unmoved
    const mk = rows()[0].querySelector('[data-line-field="markup"]');
    expect(mk.readOnly).toBe(true);
    expect(mk.placeholder).toBe('0.0% implied');

    // Step 2 — type the real cost. ONLY the cost moves.
    type(rows()[0], 'unitCost', '1650');
    T.paintTotals();
    expect(T.getCo().lines[0].unitCost).toBe(1650);
    expect(chips()['Change Order Total']).toBe('$2,750.00'); // still unmoved
    expect(chips()['Est. Cost']).toBe('$1,650.00');
    expect(chips().Profit).toBe('$1,100.00');
    expect(chips().Margin).toBe('40.0%');
    expect(rows()[0].querySelector('[data-line-field="markup"]').placeholder)
      .toBe('66.7% implied');
    expect(cellText(rows()[0], 'td.cost')).toBe('$1,650.00');
    expect(cellText(rows()[0], 'td.ext')).toContain('$2,750.00');
  });

  test('the income number is stable across the whole repair, by construction', () => {
    // This is the property that makes it safe to fix live contract money
    // one change order at a time: locking the sell freezes the income, so
    // cost is the only thing left that a keystroke can change.
    const co = { defaultMarkup: 0, lines: [{ id: 'a', qty: 1, unitCost: 2750 }] };
    T.setCo(co); T.paintLines();
    type(rows()[0], 'unitSell', '2750');
    const totals = [];
    for (const c of ['2000', '1650', '900', '']) {
      type(rows()[0], 'unitCost', c);
      totals.push((T.computeTotals() || {}).total);
    }
    expect(totals).toEqual([2750, 2750, 2750, 2750]);
  });

  test('clearing Unit Sell un-locks the line and the total moves — visibly', () => {
    T.setCo({ defaultMarkup: 25, lines: [{ id: 'a', qty: 1, unitCost: 1650, unitSell: 2750 }] });
    T.paintLines();
    expect(T.computeTotals().total).toBe(2750);
    type(rows()[0], 'unitSell', '');
    expect(T.getCo().lines[0].unitSell).toBe('');   // blank, never 0
    expect(T.computeTotals().total).toBe(2062.5);
    expect(rows()[0].querySelector('[data-line-field="markup"]').readOnly).toBe(false);
  });

  test('a partial entry keeps the prior priced value rather than repricing to junk', () => {
    T.setCo({ defaultMarkup: 0, lines: [{ id: 'a', qty: 1, unitCost: 1000, unitSell: 1500 }] });
    T.paintLines();
    type(rows()[0], 'unitSell', '15.0.0');
    expect(T.getCo().lines[0].unitSell).toBe(1500);   // unchanged
  });

  test('typing a real cost over a placeholder clears the COST? flag', () => {
    T.setCo({ defaultMarkup: 0, lines: [
      { id: 'a', qty: 1, unitCost: 2750, unitSell: 2750, costPending: true },
    ] });
    T.paintLines(); T.paintTotals();
    expect(document.querySelectorAll('.p86-co-pending')).toHaveLength(1);
    const el = type(rows()[0], 'unitCost', '1650');
    T.paintTotals();
    expect(T.getCo().lines[0].costPending).toBeUndefined();
    expect(document.querySelectorAll('.p86-co-pending')).toHaveLength(0);
    // Repairing the cost is the whole point of this release, and it is
    // done by PASTING a number — one input event. Clearing the flag used
    // to repaint the entire table and then return, which detached the
    // input the caret was in and skipped markDirty(), so the paste was
    // never scheduled for save while the pill still read "Saved".
    expect(document.contains(el)).toBe(true);
    expect(el.style.color).toBe('');              // amber tint dropped in place
    jest.advanceTimersByTime(800);
    expect(saves).toHaveLength(1);
    expect(saves[0].lines[0]).toMatchObject({ unitCost: 1650 });
    expect(saves[0].lines[0].costPending).toBeUndefined();
    // And the banner that counts pending lines empties with the badge.
    expect(document.getElementById('p86CoNotices').textContent)
      .not.toMatch(/need a real cost/);
  });

  test('a partial cost entry does NOT clear the flag — it recorded no cost', () => {
    // The old predicate read the raw text: Number('-') is NaN and NaN is
    // !== everything, so a minus sign cleared the COST? badge while the
    // commit above deliberately kept the old placeholder. The badge went
    // away and the placeholder stayed.
    T.setCo({ defaultMarkup: 0, lines: [
      { id: 'a', qty: 1, unitCost: 2750, unitSell: 2750, costPending: true },
    ] });
    T.paintLines(); T.paintTotals();
    for (const junk of ['-', '1.2.3', '']) {
      type(rows()[0], 'unitCost', junk);
      expect(T.getCo().lines[0].costPending).toBe(true);
      expect(document.querySelectorAll('.p86-co-pending')).toHaveLength(1);
    }
    expect(T.getCo().lines[0].unitCost).toBe('');   // blank still stays blank
  });

  test('a placeholder line whose price was cleared can still be costed at zero', () => {
    // "Placeholder" means the cost merely mirrors the price. Number('') is
    // 0, so comparing against a BLANK Unit Sell made a typed "0" look like
    // the very placeholder it was replacing — such a line could never
    // clear its flag.
    T.setCo({ defaultMarkup: 0, lines: [
      { id: 'a', qty: 1, unitCost: 2750, unitSell: 2750, costPending: true },
    ] });
    T.paintLines(); T.paintTotals();
    type(rows()[0], 'unitSell', '');                       // no promise left
    expect(T.getCo().lines[0].costPending).toBe(true);     // still a placeholder
    type(rows()[0], 'unitCost', '0');
    expect(T.getCo().lines[0].costPending).toBeUndefined();
    expect(document.querySelectorAll('.p86-co-pending')).toHaveLength(0);
  });

  test('clearing the flag moves no money — only the cost the user typed', () => {
    // costPending is display-only. Run the identical keystroke on lines
    // that differ ONLY by the flag; every number the editor computes must
    // come out the same. If clearing it ever moved money, this is where
    // the two runs diverge.
    const run = (pending) => {
      mount();
      T.setCo({ defaultMarkup: 0, lines: [Object.assign(
        { id: 'a', qty: 1, unitCost: 2750, unitSell: 2750 },
        pending ? { costPending: true } : {}) ] });
      T.paintLines(); T.paintTotals();
      type(rows()[0], 'unitCost', '1650');
      return T.computeTotals();
    };
    expect(run(true)).toEqual(run(false));
  });

  test('the saved blob carries the promise, the unit and the flag', () => {
    // lines[] is already one of the whitelisted save keys, so the new
    // fields round-trip with no server change at all.
    T.setCo({ defaultMarkup: 0, lines: [
      { id: 'a', qty: 1, unitCost: 1650, unit: 'ea', unitSell: 2750, costPending: true },
    ] });
    T.paintLines();
    type(rows()[0], 'qty', '2');
    jest.advanceTimersByTime(800);
    expect(saves).toHaveLength(1);
    expect(saves[0].lines[0]).toMatchObject({
      qty: 2, unitCost: 1650, unit: 'ea', unitSell: 2750, costPending: true,
    });
  });
});

// ── The property, not the case ──────────────────────────────────────
// Both halves of the caret bug were branch-shaped: one branch returned
// before markDirty(), and the same branch rebuilt the table while a caret
// was in it. A test written against THAT branch goes green again the
// moment someone adds the next one. So state the rule over every field the
// line table renders instead:
//
//   an 'input' event on a line field always schedules the save,
//   and never destroys the element the caret is in.
//
// The list below is pinned against the real DOM by the first test, so a
// new line field cannot be added without being covered here.
describe('every line-field keystroke saves, and none of them eats the caret', () => {
  let saves;
  beforeEach(() => {
    jest.useFakeTimers();
    saves = [];
    window.p86Api = { changeOrders: { update: (id, data) => { saves.push(data); return Promise.resolve({}); } } };
  });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  // One change order carrying every shape a line can have: a section
  // header, a plain line priced by markup, a doc-imported line whose cost
  // is still a placeholder (the 1.19 repair workflow), and a line with a
  // promised Unit Sell (whose markup cell is readonly).
  const fixture = () => ({
    defaultMarkup: 20,
    lines: [
      { id: 's1', section: '__section_header__', label: 'Sitework', markup: 15 },
      { id: 'a', qty: 1, unitCost: 900, unit: 'ea', unitSell: '', description: 'Plain' },
      { id: 'b', qty: 1, unitCost: 2750, unit: 'ea', unitSell: 2750, costPending: true, description: 'Imported' },
      { id: 'c', qty: 2, unitCost: 400, unit: 'ea', unitSell: 1200, description: 'Promised' },
    ],
  });
  const FIELDS = [
    ['s1', 'label'], ['s1', 'overrideLineMarkups'], ['s1', 'markup'],
    ['a', 'description'], ['a', 'qty'], ['a', 'unit'], ['a', 'unitCost'], ['a', 'markup'], ['a', 'unitSell'],
    ['b', 'description'], ['b', 'qty'], ['b', 'unit'], ['b', 'unitCost'], ['b', 'markup'], ['b', 'unitSell'],
    ['c', 'description'], ['c', 'qty'], ['c', 'unit'], ['c', 'unitCost'], ['c', 'markup'], ['c', 'unitSell'],
  ];
  const NEW_VALUE = {
    label: 'Edited', description: 'edited', qty: '3', unit: 'lf',
    unitCost: '1650', markup: '35', unitSell: '2400',
  };
  // Toggling "override lines" re-prices every child line in the section at
  // once, so it legitimately rebuilds the table — and it calls markDirty()
  // BEFORE it does, so the save still lands. It is a checkbox: there is no
  // caret in it to lose. That is the ONLY carve-out, and the test below
  // pins it so the exemption cannot quietly widen to a text field.
  const CARET_FIELDS = FIELDS.filter(([, f]) => f !== 'overrideLineMarkups');

  const stroke = (lineId, field) => {
    mount();
    T.setCo(fixture());
    T.paintLines(); T.paintTotals();
    saves.length = 0;
    const tr = document.querySelector('tr[data-line-id="' + lineId + '"]');
    const el = tr.querySelector('[data-line-field="' + field + '"]');
    el.focus();
    expect(document.activeElement).toBe(el);      // the caret really is here
    if (el.type === 'checkbox') el.checked = !el.checked;
    else el.value = NEW_VALUE[field];
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    return el;
  };

  test('the covered field list IS what the table renders', () => {
    mount();
    T.setCo(fixture());
    T.paintLines(); T.paintTotals();
    const seen = [];
    document.querySelectorAll('tr[data-line-id]').forEach((tr) => {
      tr.querySelectorAll('[data-line-field]').forEach((el) => {
        seen.push([tr.getAttribute('data-line-id'), el.getAttribute('data-line-field')]);
      });
    });
    expect(seen).toEqual(FIELDS);
  });

  test('the override checkbox is the only field without a caret in it', () => {
    mount();
    T.setCo(fixture());
    T.paintLines();
    const boxes = Array.from(document.querySelectorAll('[data-line-field]'))
      .filter((el) => el.type === 'checkbox')
      .map((el) => el.getAttribute('data-line-field'));
    expect(boxes).toEqual(['overrideLineMarkups']);
  });

  test.each(FIELDS)('a keystroke in %s.%s schedules the autosave', (lineId, field) => {
    stroke(lineId, field);
    jest.advanceTimersByTime(800);
    expect(saves).toHaveLength(1);
  });

  test.each(CARET_FIELDS)('a keystroke in %s.%s leaves the caret where it was', (lineId, field) => {
    const el = stroke(lineId, field);
    expect(document.contains(el)).toBe(true);
    expect(document.activeElement).toBe(el);
  });
});

describe('exploding a promised line states the number before the click', () => {
  test('the confirm names the promise and both totals', () => {
    // The components are correctly born WITHOUT a Unit Sell — spreading
    // one promise across every component would multiply it. But that
    // means the promise is dropped and the total moves, and a confirm
    // dialog that lets contract money move silently is not a confirm.
    expect(CO_ED_SRC).toMatch(/if \(window\.p86Pricing\.sellLocked\(line\)\) \{/);
    expect(CO_ED_SRC).toMatch(/This line has a promised sell price of/);
    expect(CO_ED_SRC).toMatch(/moving the change order total from/);
  });

  test('exploded components carry no promise of their own', () => {
    // coApplyAddLineItem builds the child line and must not write unitSell.
    const add = CO_ED_SRC.slice(CO_ED_SRC.indexOf('function coApplyAddLineItem'));
    const body = add.slice(0, add.indexOf('function coApplyBulkAddLineItems'));
    expect(body).not.toMatch(/unitSell/);
    expect(body).toMatch(/markup: \(input\.markup_pct == null/);
  });
});
