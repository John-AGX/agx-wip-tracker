/**
 * @jest-environment jsdom
 */
// test/co-sell-lock-legibility.test.js — the change order total that is right
// to hold still has to SAY it is holding.
//
// On a line carrying a promised `unitSell`, typing a real cost moves Est.
// Cost, Markup, Profit and Margin and leaves the Change Order Total exactly
// where it was. That is the sell lock working: the price is the promise, so
// cost is the only free variable. It is also indistinguishable, from the
// chair, from an app that cannot do arithmetic.
//
// Nothing on screen said so. The one explanation that existed — the amber
// "N lines need a real cost" banner — is keyed to `costPending`, and typing a
// real cost CLEARS costPending. The explanation deleted itself at the exact
// moment the user started wondering. Everything else was a title attribute on
// a 9px dot.
//
// THE PROPERTY IS THAT THE LABEL IS FALSIFIABLE. A chip annotated "Held by
// the promised price" must not move when a cost is typed, and a chip
// annotated "Moves with cost" must. A note that is merely present proves
// nothing; a note that is checked against the arithmetic it describes cannot
// drift away from it.

const P = require('../js/pricing-pipeline.js');
global.window.p86Pricing = P;
window.p86Pricing = P;
const editor = require('../js/change-order-editor.js');
const T = editor.__test;

const HELD = 'Held by the promised price';
const TRACKS = 'Moves with cost';

function mount() {
  document.body.innerHTML =
    '<div id="p86CoWrap"><div id="p86CoTotals"></div><div id="p86CoLineTable"></div></div>';
}
beforeEach(() => { mount(); });

function chips() {
  const out = {};
  document.querySelectorAll('#p86CoTotals .p86-co-chip').forEach((c) => {
    const note = c.querySelector('.p86-co-chip-note');
    out[c.querySelector('.p86-co-chip-label').textContent] = {
      value: c.querySelector('.p86-co-chip-value').textContent,
      note: note ? note.textContent : '',
    };
  });
  return out;
}
const rows = () => Array.from(document.querySelectorAll('tr.p86-co-line-row'));
const notices = () => Array.from(document.querySelectorAll('#p86CoNotices .p86-co-notice'))
  .map((n) => n.textContent);
const lockNotice = () => {
  const n = document.querySelector('#p86CoNotices .p86-co-notice-locked');
  return n ? n.textContent : '';
};
function type(input, v) {
  input.value = v;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function paint(co) { T.setCo(co); T.paintLines(); T.paintTotals(); }
const clone = (o) => JSON.parse(JSON.stringify(o));

// Every record-level lever, each holding a change order whose every priced
// line carries a promise. The claim under test is about the record, so the
// record is varied and the claim is not.
const ALL_LOCKED = [
  ['no markup', { defaultMarkup: 0 }],
  ['a default markup that is now moot', { defaultMarkup: 20 }],
  ['fees and tax', { defaultMarkup: 10, feeFlat: 100, feePct: 3, taxPct: 7 }],
  ['rounding', { defaultMarkup: 20, roundTo: 1000 }],
  ['an active target margin', { targetMargin: 30 }],
  ['a target margin with fees', { targetMargin: 25, feeFlat: 250, taxPct: 7 }],
];
const LOCKED_LINES = [
  { description: 'Gutters', qty: 1, unitCost: 2750, unitSell: 2750, costPending: true },
  { description: 'Soffit', qty: 2, unitCost: 900, unitSell: 1200 },
  { description: 'Stucco', qty: 1, unitCost: 2000, unitSell: '2600' },
];

describe('a promised price annotates the chip it is holding', () => {
  for (const [label, rec] of ALL_LOCKED) {
    test(`${label}: the notes on screen are TRUE of the arithmetic`, () => {
      paint(Object.assign(clone(rec), { lines: clone(LOCKED_LINES) }));
      const before = chips();
      expect(before['Change Order Total'].note).toBe(HELD);
      expect(before['Est. Cost'].note).toBe(TRACKS);
      expect(before.Profit.note).toBe(TRACKS);
      expect(before.Margin.note).toBe(TRACKS);
      expect(before['Tax + Fees'].note).toBe(HELD);

      // Now make the claim answerable: change a cost and see.
      type(rows()[0].querySelector('[data-line-field="unitCost"]'), '1650');
      const after = chips();
      for (const key of Object.keys(before)) {
        if (before[key].note === HELD) {
          expect({ chip: key, held: after[key].value === before[key].value })
            .toEqual({ chip: key, held: true });
        } else if (before[key].note === TRACKS) {
          expect({ chip: key, moved: after[key].value !== before[key].value })
            .toEqual({ chip: key, moved: true });
        }
      }
    });
  }

  test('a change order with NO promise carries no notes at all', () => {
    paint({ defaultMarkup: 20, lines: [
      { id: 'a', description: 'Demo', qty: 1, unitCost: 1000 },
      { id: 'b', description: 'Framing', qty: 2, unitCost: 900 },
    ] });
    const c = chips();
    expect(Object.keys(c).map((k) => c[k].note)).toEqual(['', '', '', '', '', '', '']);
    expect(lockNotice()).toBe('');
  });

  test('a MIXED change order counts rather than generalizes', () => {
    // Nothing here is true of the record as a whole, so the only note is the
    // one that reports a count — a blanket "moves with cost" would be a lie
    // about the locked line and a blanket "held" a lie about the other.
    paint({ defaultMarkup: 20, lines: [
      { id: 'a', description: 'Demo', qty: 1, unitCost: 1000 },
      { id: 'b', description: 'Stucco', qty: 1, unitCost: 2000, unitSell: 2600 },
    ] });
    const c = chips();
    expect(c['Change Order Total'].note).toBe('1 of 2 lines priced by promise');
    expect(c['Est. Cost'].note).toBe('');
    expect(c.Profit.note).toBe('');
    expect(c.Margin.note).toBe('');
    expect(c['Tax + Fees'].note).toBe('');
  });

  test('a blank Unit Sell is not a promise and is not counted', () => {
    paint({ defaultMarkup: 20, lines: [
      { id: 'a', qty: 1, unitCost: 1000, unitSell: '' },
      { id: 'b', qty: 1, unitCost: 1000 },
    ] });
    expect(chips()['Change Order Total'].note).toBe('');
    expect(lockNotice()).toBe('');
  });

  test('a promise of exactly $0 is still a promise', () => {
    paint({ defaultMarkup: 20, lines: [{ id: 'a', qty: 1, unitCost: 1650, unitSell: 0 }] });
    expect(chips()['Change Order Total'].note).toBe(HELD);
    expect(lockNotice()).toContain('Every line');
  });
});

describe('the explanation outlives the moment it is needed', () => {
  test('the lock notice says what holds and what moves, in words, on the page', () => {
    paint({ defaultMarkup: 0, lines: clone(LOCKED_LINES) });
    const n = lockNotice();
    expect(n).toContain('Est. Cost');
    expect(n).toContain('Profit');
    expect(n).toContain('Margin');
    expect(n).toContain('Change Order Total');
    // Not a tooltip. The text is in the document, not in an attribute.
    expect(document.querySelector('#p86CoNotices .p86-co-notice-locked')).toBeTruthy();
  });

  test('typing a real cost destroys the OLD explanation and not this one', () => {
    // The amber banner is keyed to costPending, which typing a real cost
    // clears — that is correct, and it is why this notice had to exist.
    paint({ defaultMarkup: 0, lines: clone(LOCKED_LINES) });
    expect(notices().join(' ')).toContain('need');
    type(rows()[0].querySelector('[data-line-field="unitCost"]'), '1650');
    expect(notices().join(' ')).not.toContain('needs a real cost');
    expect(lockNotice()).toContain('Every line');
  });

  test('clearing the promise clears the explanation with it', () => {
    paint({ defaultMarkup: 20, lines: [{ id: 'a', qty: 1, unitCost: 1000, unitSell: 2000 }] });
    expect(lockNotice()).toBeTruthy();
    type(rows()[0].querySelector('[data-line-field="unitSell"]'), '');
    expect(lockNotice()).toBe('');
    expect(chips()['Change Order Total'].note).toBe('');
  });

  test('the count in the notice tracks the record', () => {
    paint({ defaultMarkup: 20, lines: [
      { id: 'a', qty: 1, unitCost: 1000 },
      { id: 'b', qty: 1, unitCost: 1000 },
      { id: 'c', qty: 1, unitCost: 2000, unitSell: 2600 },
    ] });
    expect(lockNotice()).toContain('1 of 3 lines');
    type(rows()[0].querySelector('[data-line-field="unitSell"]'), '1500');
    expect(lockNotice()).toContain('2 of 3 lines');
  });
});

// ── the surfaces outside the overlay ──────────────────────────────────
describe('a landed save refreshes the surfaces that read the same number', () => {
  test('the debounced autosave calls the shared refresh primitive for this job', async () => {
    jest.useFakeTimers();
    const seen = [];
    let resolveSave;
    window.p86Refresh = (entity, opts) => { seen.push([entity, opts]); };
    window.p86Api = { changeOrders: { update: () => new Promise((r) => { resolveSave = r; }) } };

    paint({ id: 'co_1', job_id: 'job_9', defaultMarkup: 20,
      lines: [{ id: 'a', qty: 1, unitCost: 1000 }] });
    type(rows()[0].querySelector('[data-line-field="unitCost"]'), '1650');

    // Nothing yet — the save is debounced, and refreshing per keystroke
    // would refetch the job's change orders on every character.
    expect(seen).toEqual([]);
    jest.advanceTimersByTime(700);
    // Still nothing: the PUT is in flight. Refreshing before it lands is the
    // race close() has always had.
    expect(seen).toEqual([]);

    resolveSave({ change_order: { updated_at: 'now', status: 'draft' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(seen).toEqual([['co', { jobId: 'job_9' }]]);
    jest.useRealTimers();
    delete window.p86Refresh;
    delete window.p86Api;
  });

  test('a FAILED save refreshes nothing — there is no new number to show', async () => {
    jest.useFakeTimers();
    const seen = [];
    let rejectSave;
    window.p86Refresh = (entity, opts) => { seen.push([entity, opts]); };
    window.p86Api = { changeOrders: { update: () => new Promise((_r, rj) => { rejectSave = rj; }) } };

    paint({ id: 'co_1', job_id: 'job_9', defaultMarkup: 20,
      lines: [{ id: 'a', qty: 1, unitCost: 1000 }] });
    type(rows()[0].querySelector('[data-line-field="unitCost"]'), '1650');
    jest.advanceTimersByTime(700);
    rejectSave(new Error('409'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(seen).toEqual([]);
    jest.useRealTimers();
    delete window.p86Refresh;
    delete window.p86Api;
  });
});
