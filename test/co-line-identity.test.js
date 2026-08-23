/**
 * @jest-environment jsdom
 */
// test/co-line-identity.test.js — a change-order line's `id` is its ADDRESS,
// and a line without one is not hard to edit. It is silently uneditable.
//
// THE REPORT: "when i change the cost line manually it doesnt change the co
// total". Three different things can freeze that total and only one of them
// is a bug:
//
//   • a line carrying `unitSell` freezes the Change Order Total ON PURPOSE —
//     the price is promised, so cost is the free variable. Est. Cost, Markup,
//     Profit and Margin all move. Correct, and covered by co-sell-lock.
//   • `roundTo` can quantize a small cost change away. Also correct.
//   • a line with NO `id` freezes EVERYTHING — all seven chips, the in-memory
//     record, the autosave — while the save pill still reads "Saved".
//
// The third is this file. js/change-order-editor.js renders each row as
// data-line-id="<l.id>" and every handler bound to that row resolves the line
// by matching the attribute back. An undefined id renders as "" and the
// lookup compares String(undefined) === String("") — "undefined" === "",
// false — so the handler returns on its first statement. Nothing is written,
// markDirty() never fires, no autosave arms.
//
// The two producers of id-less lines are the two that matter: the BULK PDF
// IMPORTER (js/doc-import.js line shape: {description, qty, unitCost,
// unitSell, costPending} — no id) and the AGENT (the documented CO line shape
// has no id key either). Those are exactly the change orders 1.19 was built
// to repair, so the repair door was the dead one.
//
// WHAT IS PINNED HERE IS A PROPERTY, NOT THE SELL-LOCK CASE. For ANY line
// shape and ANY editable field:
//
//   A. the keystroke reaches the record — the in-memory line holds the value;
//   B. every chip equals what THE PRICING MODULE says about the record as it
//      now stands.
//
// Neither half is sufficient alone: a wholly frozen editor satisfies (B) on
// its own, because a frozen record and frozen chips agree with each other.

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const P = require('../js/pricing-pipeline.js');
global.window.p86Pricing = P;
window.p86Pricing = P;
const editor = require('../js/change-order-editor.js');
const T = editor.__test;

const jobFin = require('../server/services/job-financials');

// ── the oracle ────────────────────────────────────────────────────────
// What the SHARED pricing module says about a record. Not a re-derivation
// of the editor's arithmetic — the three composed calls are the pipeline's
// own contract, and the four remaining chips are definitional differences
// between the numbers it returns.
function priced(rec) {
  const lines = Array.isArray(rec.lines) ? rec.lines : [];
  const per = P.computeForLines(rec, lines);
  const markedUp = P.resolveMarkedUp(per, rec);
  const fees = P.applyFeesAndTax(markedUp, rec);
  const total = fees.total;
  return {
    'Est. Cost': per.subtotal,
    Markup: markedUp - per.subtotal,
    'Tax + Fees': fees.feeFlat + fees.feePctAmount + fees.taxAmount,
    Profit: total - per.subtotal,
    'Change Order Total': total,
    Margin: total > 0 ? ((total - per.subtotal) / total) * 100 : 0,
    Lines: lines.filter((l) => l.section !== '__section_header__').length,
  };
}

function mount() {
  document.body.innerHTML =
    '<div id="p86CoTotals"></div><div id="p86CoLineTable"></div>';
}
const chipText = () =>
  Array.from(document.querySelectorAll('#p86CoTotals .p86-co-chip')).reduce((a, c) => {
    a[c.querySelector('.p86-co-chip-label').textContent] =
      c.querySelector('.p86-co-chip-value').textContent;
    return a;
  }, {});
const chipNum = (s) => Number(String(s).replace(/[$,%]/g, ''));
const bodyRows = () => Array.from(document.querySelectorAll('tr.p86-co-line-row'));

function type(input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

beforeEach(() => { mount(); });

// ── the shapes ────────────────────────────────────────────────────────
// Not a list of special cases. A list of WAYS a change-order line arrives,
// including every producer in the repo and every sell shape 1.19 introduced.
const LINE_SHAPES = [
  ['the PDF importer shape — no id, price promised, cost a placeholder',
    { description: 'Gutters — Buildertrend Flat Rate', qty: 1, unitCost: 2750, unitSell: 2750, costPending: true }],
  ['the agent shape — no id, plain cost',
    { description: 'Demo', qty: 2, unitCost: 900 }],
  ['no id, own markup',
    { description: 'Framing', qty: 1, unitCost: 2200, markup: 18 }],
  ['no id, zero qty',
    { description: 'Allowance', qty: 0, unitCost: 500 }],
  ['no id, sell as a STRING (what an OCR pass produces)',
    { description: 'Stucco', qty: 1, unitCost: 2000, unitSell: '2000' }],
  ['no id, sell of exactly zero — a real promise at $0',
    { description: 'Goodwill', qty: 1, unitCost: 1650, unitSell: 0 }],
  ['no id, sell BLANK — not a lock',
    { description: 'Paint', qty: 1, unitCost: 1650, unitSell: '' }],
  ['id null rather than absent',
    { id: null, description: 'Trim', qty: 4, unitCost: 60 }],
  ['id empty string',
    { id: '', description: 'Haul-off', qty: 1, unitCost: 300 }],
  ['the editor shape — a real id',
    { id: 'line_seed_aaaa', description: 'Roof', qty: 1, unitCost: 1000, markup: 20 }],
  ['a DUPLICATE of that id — two rows, one address',
    { id: 'line_seed_aaaa', description: 'Flashing', qty: 3, unitCost: 120 }],
];

// Record-level shapes: every lever that can legitimately freeze a chip.
const RECORD_SHAPES = [
  ['no markup at all', {}],
  ['a default markup', { defaultMarkup: 20 }],
  ['fees and tax on top', { defaultMarkup: 15, feeFlat: 100, feePct: 3, taxPct: 7 }],
  ['rounding that quantizes small moves', { defaultMarkup: 20, roundTo: 1000 }],
  ['an active target margin', { targetMargin: 30 }],
  ['a target margin with fees', { targetMargin: 25, feeFlat: 250, taxPct: 7 }],
];

const clone = (o) => JSON.parse(JSON.stringify(o));

// The editor's own coercion rule for its inputmode=decimal fields, stated
// once: blank stays blank (a blank unitSell is "no promise", 0 is "promised
// at $0"), an unparseable partial entry keeps the prior value.
const NUMERIC = ['qty', 'unitCost', 'markup', 'unitSell'];
function coerce(field, typed, prior) {
  if (NUMERIC.indexOf(field) === -1) return typed;
  if (typed === '') return '';
  const n = Number(typed);
  return isNaN(n) ? prior : n;
}

describe('every rendered row is addressable, whatever produced the line', () => {
  for (const [label, shape] of LINE_SHAPES) {
    test(`${label}: its row carries a non-empty id that resolves to exactly one line`, () => {
      T.setCo({ defaultMarkup: 20, lines: [clone(shape)] });
      T.paintLines();
      const id = bodyRows()[0].getAttribute('data-line-id');
      expect(id).toBeTruthy();
      expect(id).not.toBe('undefined');
      const co = T.getCo();
      expect(co.lines.filter((l) => String(l.id) === String(id))).toHaveLength(1);
    });
  }

  test('a whole change order of id-less lines gets DISTINCT addresses', () => {
    T.setCo({ defaultMarkup: 0, lines: LINE_SHAPES.map(([, s]) => clone(s)) });
    T.paintLines();
    const ids = bodyRows().map((tr) => tr.getAttribute('data-line-id'));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a duplicate id is re-minted — two rows must never share one address', () => {
    // Left alone, the second row resolves to the FIRST line: typing a cost
    // into "Flashing" silently repriced "Roof".
    T.setCo({ defaultMarkup: 0, lines: [
      { id: 'dupe', description: 'Roof', qty: 1, unitCost: 1000 },
      { id: 'dupe', description: 'Flashing', qty: 1, unitCost: 120 },
    ] });
    T.paintLines();
    const ids = bodyRows().map((tr) => tr.getAttribute('data-line-id'));
    expect(new Set(ids).size).toBe(2);
    const co = T.getCo();
    for (const id of ids) {
      expect(co.lines.filter((l) => String(l.id) === String(id))).toHaveLength(1);
    }
  });

  test('minting does not dirty the record — opening a CO must not save it', () => {
    // The unhealed shape is now only reachable through setRawCo, the
    // deliberate bypass. setCo is the door openNew()/openExisting() use, and
    // it adopts the record: identity is a property of _state.co itself, so it
    // is already true here, BEFORE the first paint. That is the difference
    // between an invariant and a rendering side effect — see
    // test/co-line-addressability.test.js.
    T.setRawCo({ defaultMarkup: 20, lines: [{ qty: 1, unitCost: 1000 }] });
    expect(T.getCo().lines[0].id).toBeUndefined();

    T.setCo({ defaultMarkup: 20, lines: [{ qty: 1, unitCost: 1000 }] });
    const first = T.getCo().lines[0].id;
    expect(first).toBeTruthy();
    T.paintLines();
    T.paintLines();
    // Idempotent: a repaint must not re-address the row, or every repaint
    // would detach the caret's own row from its line.
    expect(T.getCo().lines[0].id).toBe(first);
  });
});

describe('THE PROPERTY: a keystroke reaches the record, and the chips follow the pricing module', () => {
  // A change order per record shape, holding every line shape at once —
  // so a locked line and an unlocked line are always in the same document
  // and the freeze can never be blamed on the record.
  for (const [recLabel, recShape] of RECORD_SHAPES) {
    for (let i = 0; i < LINE_SHAPES.length; i++) {
      const [lineLabel] = LINE_SHAPES[i];
      test(`${recLabel} · editing "${lineLabel}"`, () => {
        for (const field of ['unitCost', 'qty', 'unitSell', 'markup', 'description']) {
          for (const typed of (field === 'description' ? ['Repaired'] : ['1650', '0', ''])) {
            mount();
            T.setCo(Object.assign(clone(recShape), {
              lines: LINE_SHAPES.map(([, s]) => clone(s)),
            }));
            T.paintLines();
            T.paintTotals();

            const tr = bodyRows()[i];
            const input = tr.querySelector('[data-line-field="' + field + '"]');
            expect(input).toBeTruthy();

            const id = tr.getAttribute('data-line-id');
            const before = T.getCo().lines.find((l) => String(l.id) === String(id));
            const expected = coerce(field, typed, before[field]);

            type(input, typed);

            // A. the keystroke reached the record.
            const after = T.getCo().lines.find((l) => String(l.id) === String(id));
            expect({ field, typed, got: after[field] })
              .toEqual({ field, typed, got: expected });

            // B. every chip agrees with the pricing module about the record
            //    as it now stands. This is the general rule; "the total does
            //    not move when sell is locked" is one of its cases.
            const want = priced(T.getCo());
            const got = chipText();
            for (const key of Object.keys(want)) {
              // Each chip is compared at ITS OWN printed resolution — the
              // Margin chip renders one decimal, the money chips two.
              const dp = key === 'Margin' ? 1 : 2;
              const at = (n) => { const v = Number(Number(n).toFixed(dp)); return v === 0 ? 0 : v; };
              expect({ chip: key, v: at(chipNum(got[key])) })
                .toEqual({ chip: key, v: at(want[key]) });
            }
          }
        }
      });
    }
  }

  test('the delete button removes the row it is on, not the first one that looks like it', () => {
    T.setCo({ defaultMarkup: 0, lines: LINE_SHAPES.map(([, s]) => clone(s)) });
    T.paintLines(); T.paintTotals();
    const n = T.getCo().lines.length;
    const doomed = bodyRows()[1].getAttribute('data-line-id');
    bodyRows()[1].querySelector('[data-line-del]').click();
    expect(T.getCo().lines).toHaveLength(n - 1);
    expect(T.getCo().lines.some((l) => String(l.id) === String(doomed))).toBe(false);
  });

  test('CO-0001 exactly: ten id-less flat-rate lines, one repaired', () => {
    // The record John is on. Cost moves, Profit appears, and the Change
    // Order Total holds at $27,500 because every price is promised.
    const FLAT = [2750, 1800, 3200, 4150, 2600, 1950, 3300, 2450, 2900, 2400];
    T.setCo({ defaultMarkup: 0, lines: FLAT.map((v, k) => (
      { description: 'Flat Rate ' + k, qty: 1, unitCost: v, unitSell: v, costPending: true })) });
    T.paintLines(); T.paintTotals();
    expect(chipNum(chipText()['Est. Cost'])).toBe(27500);
    expect(chipNum(chipText()['Change Order Total'])).toBe(27500);

    type(bodyRows()[0].querySelector('[data-line-field="unitCost"]'), '1650');

    expect(T.getCo().lines[0].unitCost).toBe(1650);
    expect(T.getCo().lines[0].costPending).toBeUndefined();
    expect(chipNum(chipText()['Est. Cost'])).toBe(26400);
    expect(chipNum(chipText()['Change Order Total'])).toBe(27500);
    expect(chipNum(chipText().Profit)).toBe(1100);
  });
});

// ── the doors that PRODUCE the lines ──────────────────────────────────
// The editor heals what it is handed, but a record stored id-less stays
// stored id-less until something writes it. So both write doors stamp too.

function fakeDb(coRow) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      const s = String(sql);
      // Order matters: the INSERT carries both `co_number` and a `SELECT`
      // sub-query, so it has to be recognised before the lookups.
      if (/INSERT INTO job_change_orders/.test(s)) {
        return { rowCount: 1, rows: [{ id: 'co_1', data: JSON.parse(params[4]) }] };
      }
      if (/UPDATE job_change_orders/.test(s)) {
        return { rowCount: 1, rows: [{ id: 'co_1', data: JSON.parse(params[0]) }] };
      }
      if (/SELECT co\.status/.test(s)) return { rowCount: 1, rows: [coRow] };
      if (/^\s*SELECT 1 FROM jobs WHERE id/.test(s)) return { rowCount: 1, rows: [{ id: 'job1' }] };
      return { rowCount: 0, rows: [] };
    },
  };
}

describe('the agent door stamps identity at intake, beside the key normalizer', () => {
  test('a created CO comes back with an id on every line', async () => {
    const db = fakeDb(null);
    const row = await jobFin.createChangeOrder(db, {
      jobId: 'job1', orgId: 1, ownerId: 'u1',
      fields: { title: 'CO', lines: [
        { description: 'Demo', qty: 1, unit_cost: 900 },
        { description: 'Stucco', qty: 1, unit_cost: 2750, unit_sell: 3200 },
      ] },
    });
    const lines = row.data.lines;
    expect(lines.map((l) => !!l.id)).toEqual([true, true]);
    expect(new Set(lines.map((l) => l.id)).size).toBe(2);
    // …and identity did NOT displace the key normalizer commit c7bfdbd added.
    expect(lines[0].unitCost).toBe(900);
    expect(lines[1].unitSell).toBe(3200);
  });

  test('an updated CO stamps the lines the op carries', async () => {
    const db = fakeDb({ status: 'draft', is_locked: false, data: { lines: [] } });
    const row = await jobFin.updateChangeOrder(db, {
      id: 'co_1', orgId: 1, jobId: 'job1',
      fields: { lines: [{ description: 'Stucco', qty: 1, unitCost: 1650 }] },
    });
    expect(row.data.lines[0].id).toBeTruthy();
  });

  test('an id already present is left ALONE — an address must be stable', async () => {
    const db = fakeDb({ status: 'draft', is_locked: false, data: { lines: [] } });
    const row = await jobFin.updateChangeOrder(db, {
      id: 'co_1', orgId: 1, jobId: 'job1',
      fields: { lines: [{ id: 'keep_me', qty: 1, unitCost: 10 }] },
    });
    expect(row.data.lines[0].id).toBe('keep_me');
  });

  test('stamping moves no money — the priced record is byte-identical', () => {
    const before = { defaultMarkup: 20, feePct: 3, taxPct: 7, roundTo: 0,
      lines: [{ qty: 2, unitCost: 900 }, { qty: 1, unitCost: 2750, unitSell: 3200 }] };
    const after = Object.assign({}, before, { lines: jobFin.stampCoLineIds(before.lines) });
    expect(priced(after)).toEqual(priced(before));
  });

  test('duplicate ids arriving from a model are re-minted, not stored', () => {
    const out = jobFin.stampCoLineIds([{ id: 'x', qty: 1, unitCost: 1 }, { id: 'x', qty: 1, unitCost: 2 }]);
    expect(new Set(out.map((l) => l.id)).size).toBe(2);
  });
});

describe('the REST doors — the bulk PDF importer and the editor autosave', () => {
  const CO_ROUTES = read('server', 'routes', 'change-order-routes.js');

  // These two handlers hold their own inlined copy of the data cleaner
  // (drift this repo already carries), so the stamp is asserted at each.
  test('POST /jobs/:jobId/change-orders stamps before the INSERT', () => {
    const create = CO_ROUTES.slice(
      CO_ROUTES.indexOf("router.post('/jobs/:jobId/change-orders'"),
      CO_ROUTES.indexOf("router.put('/change-orders/:id'"));
    expect(create).toMatch(/data\.lines = jobFin\.stampCoLineIds\(data\.lines\);/);
    expect(create.indexOf('stampCoLineIds'))
      .toBeLessThan(create.indexOf('INSERT INTO job_change_orders'));
  });

  test('PUT /change-orders/:id stamps before the UPDATE', () => {
    const put = CO_ROUTES.slice(CO_ROUTES.indexOf("router.put('/change-orders/:id'"));
    expect(put).toMatch(/data\.lines = jobFin\.stampCoLineIds\(data\.lines\);/);
    expect(put.indexOf('stampCoLineIds'))
      .toBeLessThan(put.indexOf('UPDATE job_change_orders'));
  });
});
