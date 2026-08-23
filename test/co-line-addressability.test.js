/**
 * @jest-environment jsdom
 */
// test/co-line-addressability.test.js
//
// THE PROPERTY, stated once and then tested against everything that can
// produce a change-order line:
//
//     For any change order the app can load, from any producer, every line
//     is INDEPENDENTLY ADDRESSABLE — typing into row N changes row N and
//     only row N, and deleting row N removes row N and only row N.
//
// Not "imported lines get ids". That is one case of it, and testing the case
// instead of the property is how this defect shipped: a line's `id` is its
// ADDRESS in js/change-order-editor.js — every row renders as
// data-line-id="<id>" and every handler on it resolves the line by matching
// that attribute back against _state.co.lines[].id — and a suite whose
// fixtures all happened to carry an id could never see that an address is a
// thing a line can lack.
//
// THE FIXTURE RULE. Every fixture below is derived from what a producer
// ACTUALLY emits, not from what the editor would like to receive:
//
//   • the bulk PDF importer is CALLED (js/doc-import.js __test.toLine) on
//     OCR rows in the shape server/routes/doc-import-routes.js:148 returns;
//   • the agent's flat `fields.lines` door is run through the real intake
//     normalizer (server/services/job-financials.js normalizeCoLines);
//   • the record John is on is reconstructed from git — the change-order
//     branch of toLine before c7bfdbdf was `{description, qty, unitCost}`,
//     three keys, no id, no unitSell — and that reconstruction is stated as
//     an inference, not as a fact, because nobody in this workflow could
//     read the row.
//
// Where a shape IS invented it is flagged and justified in place.
//
// WHAT THIS FILE ADDS OVER test/co-line-identity.test.js. That file proves
// the editor can be MADE to hold addressable lines by painting them: every
// one of its cases is `setCo(...)` followed by `paintLines()`. This one
// asserts the invariant of the STATE — that the editor cannot hold an
// unaddressed line at all, before any paint, whether or not anything ever
// paints, and with the line table absent from the DOM entirely. That is the
// difference between an invariant and a rendering side effect, and it is the
// difference that decides whether the NEXT producer to omit an id is a bug.

const fs = require('fs');
const path = require('path');

const P = require('../js/pricing-pipeline.js');
global.window.p86Pricing = P;
window.p86Pricing = P;

const editor = require('../js/change-order-editor.js');
const T = editor.__test;

const importer = require('../js/doc-import.js').__test;   // the real toLine
const jobFin = require('../server/services/job-financials');

// ── harness ───────────────────────────────────────────────────────────
const SHELL =
  '<div id="p86CoTotals"></div>' +
  '<span id="p86CoSaveStatus"></span>' +
  '<div id="p86CoLineTable"></div>';

function mount() { document.body.innerHTML = SHELL; }
function unmount() { document.body.innerHTML = ''; }

const bodyRows = () => Array.from(document.querySelectorAll('tr.p86-co-line-row'));
const allRows = () => Array.from(document.querySelectorAll('tr[data-line-id]'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const isHeader = (l) => l && l.section === '__section_header__';

function type(input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const chips = () =>
  Array.from(document.querySelectorAll('#p86CoTotals .p86-co-chip')).reduce((a, c) => {
    a[c.querySelector('.p86-co-chip-label').textContent] =
      c.querySelector('.p86-co-chip-value').textContent;
    return a;
  }, {});

// The editor's own coercion rule for its inputmode=decimal fields: blank
// stays blank, an unparseable partial entry keeps the prior value.
const NUMERIC = ['qty', 'unitCost', 'markup', 'unitSell'];
function coerce(field, typed, prior) {
  if (NUMERIC.indexOf(field) === -1) return typed;
  if (typed === '') return '';
  const n = Number(typed);
  return isNaN(n) ? prior : n;
}

// ── the producers, called for real ────────────────────────────────────

// server/routes/doc-import-routes.js:148 returns one of these per line, and
// :88 says qty/unit_cost are null when only an extended amount is printed —
// which is exactly a "Buildertrend Flat Rate" row.
const ocrFlatRate = (description, amount) =>
  ({ description, qty: null, unit_cost: null, amount });
const ocrItemised = (description, qty, unit_cost) =>
  ({ description, qty, unit_cost, amount: qty * unit_cost });

const FAIRWAYS_TRADES = [
  'Exterior Paint — Buildertrend Flat Rate',
  'Gutters — Buildertrend Flat Rate',
  'Soffit & Fascia — Buildertrend Flat Rate',
  'Pressure Wash — Buildertrend Flat Rate',
  'Downspouts — Buildertrend Flat Rate',
  'Trim Paint — Buildertrend Flat Rate',
  'Caulking — Buildertrend Flat Rate',
  'Prep & Masking — Buildertrend Flat Rate',
  'Gutter Guards — Buildertrend Flat Rate',
  'Final Clean — Buildertrend Flat Rate',
];
// Ten lines totalling $27,500. INFERENCE, flagged: the split across the ten
// is not known to this workflow — only the count and the total are — and
// nothing here depends on it, because the property is per-row.
const FAIRWAYS_AMOUNTS = [2750, 1800, 3200, 4150, 2600, 1950, 3300, 2450, 2900, 2400];

// The CO branch of toLine as it stood BEFORE c7bfdbdf, verified with
// `git show c7bfdbdf~1:js/doc-import.js`: a single shared po+co branch
// returning `{ description, qty, unitCost }`. This is the shape stored on
// RV2008 CO-0001 today — barer than what the importer emits now, with no
// unitSell and no costPending. Restated rather than called because the code
// that produced it is two commits gone; it is quoted from git, not guessed.
const legacyToLineCo = (l) => {
  const amt = (l.amount != null) ? Number(l.amount)
    : (l.qty != null && l.unit_cost != null ? Number(l.qty) * Number(l.unit_cost) : null);
  const q = (l.qty != null && Number(l.qty) > 0) ? Number(l.qty) : 1;
  const unit = (l.unit_cost != null) ? Number(l.unit_cost) : (amt != null ? amt / q : 0);
  return { description: l.description || '(item)', qty: q, unitCost: unit };
};

// The healer's own output, made predictable so a fixture can be built that
// collides with it head-on. newLineId() is
// 'line_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6),
// so pinning both makes it a constant.
function withPinnedMint(fn) {
  const d = jest.spyOn(Date, 'now').mockReturnValue(1755900000000);
  const r = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  try { return fn(); } finally { d.mockRestore(); r.mockRestore(); }
}
const PINNED_ID = withPinnedMint(() => T.newLineId());

// ── the fixtures ──────────────────────────────────────────────────────
// Each is a function so every test gets its own objects: the heal MUTATES
// the record, which is the point, and a shared fixture would leak a healed
// id into the next case and quietly make it pass.
const FIXTURES = [
  {
    name: 'the bulk PDF importer, as it ships today',
    why: 'js/doc-import.js toLine("co") — called, not restated',
    build: () => ({
      defaultMarkup: 0,
      lines: FAIRWAYS_TRADES.slice(0, 4).map((d, i) =>
        importer.toLine(ocrFlatRate(d, FAIRWAYS_AMOUNTS[i]), 'co')),
    }),
  },
  {
    name: 'the bulk PDF importer WITH ITS ID REMOVED — a producer left broken on purpose',
    why: 'the state-level guarantee has to stand on its own, with no help from any producer',
    build: () => ({
      defaultMarkup: 0,
      lines: FAIRWAYS_TRADES.slice(0, 4).map((d, i) => {
        const l = importer.toLine(ocrFlatRate(d, FAIRWAYS_AMOUNTS[i]), 'co');
        delete l.id;              // pretend the fix to js/doc-import.js was never made
        return l;
      }),
    }),
  },
  {
    name: 'RV2008 CO-0001 as reconstructed from git — ten flat-rate lines, three keys each',
    why: 'pre-c7bfdbdf toLine output; the record John is actually on',
    build: () => ({
      defaultMarkup: 0,
      lines: FAIRWAYS_TRADES.map((d, i) => legacyToLineCo(ocrFlatRate(d, FAIRWAYS_AMOUNTS[i]))),
    }),
  },
  {
    name: 'the agent door, key-normalised but unstamped',
    why: 'normalizeCoLines() is the real intake mapper; it maps keys and mints nothing',
    build: () => ({
      defaultMarkup: 15,
      lines: jobFin.normalizeCoLines([
        { description: 'Demo', qty: 2, unit_cost: 900 },
        { description: 'Stucco patch', qty: 1, unit_cost: 2750, unit_sell: 3200 },
        { description: 'Haul-off', qty: 1, unit_cost: 300, cost_pending: true },
      ]),
    }),
  },
  {
    name: 'SOME ids — an imported change order after John clicks + Add Line',
    why: 'the two-class table: a working row beside dead ones is what makes this look intermittent',
    build: () => ({
      defaultMarkup: 0,
      lines: [
        legacyToLineCo(ocrFlatRate(FAIRWAYS_TRADES[0], 2750)),
        { id: T.newLineId(), description: 'Added by hand', qty: 1, unitCost: 500, unit: 'ea', unitSell: '', markup: '', markupMode: 'percent' },
        legacyToLineCo(ocrFlatRate(FAIRWAYS_TRADES[1], 1800)),
        { id: 'line_seed_keepme', description: 'Also identified', qty: 2, unitCost: 40 },
      ],
    }),
  },
  {
    name: 'DUPLICATE ids — two rows, one address',
    why: 'the same defect wearing a different hat: both rows resolve to the first line',
    build: () => ({
      defaultMarkup: 20,
      lines: [
        { id: 'dupe', description: 'Roof', qty: 1, unitCost: 1000 },
        { id: 'dupe', description: 'Flashing', qty: 3, unitCost: 120 },
        { id: 'dupe', description: 'Drip edge', qty: 2, unitCost: 45 },
      ],
    }),
  },
  {
    name: 'ids that COLLIDE with what the healer itself would mint',
    why: 'a heal must not hand a repaired row an address another row already holds',
    build: () => ({
      defaultMarkup: 0,
      // INVENTED, and justified: no producer emits this. It is the adversarial
      // case for the minter — a stored record already holding the exact id the
      // generator is about to produce. PINNED_ID is that id, taken from the
      // editor's own newLineId() with Date.now and Math.random pinned.
      lines: [
        { id: PINNED_ID, description: 'Already holds the address', qty: 1, unitCost: 900 },
        { description: 'Needs one', qty: 1, unitCost: 1200 },
        { description: 'Needs one too', qty: 1, unitCost: 1300 },
        { id: PINNED_ID + '_1', description: 'And the first retry', qty: 1, unitCost: 400 },
      ],
    }),
  },
  {
    name: 'sections whose HEADERS have no id',
    why: 'an id-less header swallows its section: coSectionTotals skips every child because undefined == null',
    build: () => ({
      defaultMarkup: 10,
      lines: [
        { section: '__section_header__', label: 'Paint', markup: '', markupMode: 'percent' },
        legacyToLineCo(ocrFlatRate(FAIRWAYS_TRADES[0], 2750)),
        legacyToLineCo(ocrFlatRate(FAIRWAYS_TRADES[5], 1950)),
        { section: '__section_header__', label: 'Gutters', markup: 12, markupMode: 'percent' },
        legacyToLineCo(ocrFlatRate(FAIRWAYS_TRADES[1], 1800)),
      ],
    }),
  },
  {
    name: 'falsy-but-real ids',
    why: 'id 0 is a legitimate address; null and "" are not',
    build: () => ({
      defaultMarkup: 0,
      // INVENTED, and justified: `id: 0` is the one falsy value that is a
      // valid address, and a `!l.id` test would silently re-mint it — losing
      // the row's identity across a reload for no reason. `null` and `''`
      // are the two shapes a JSON round trip actually produces for an
      // absent id, so they are the ones worth pinning.
      lines: [
        { id: 0, description: 'Zero is an address', qty: 1, unitCost: 100 },
        { id: null, description: 'Null is not', qty: 1, unitCost: 200 },
        { id: '', description: 'Nor is blank', qty: 1, unitCost: 300 },
        { id: 'keep', description: 'Kept', qty: 1, unitCost: 400 },
      ],
    }),
  },
];

// The oracle: what the SHARED pricing module says about a record.
function priced(rec) {
  const lines = Array.isArray(rec.lines) ? rec.lines.filter(Boolean) : [];
  const per = P.computeForLines(rec, lines);
  const markedUp = P.resolveMarkedUp(per, rec);
  const fees = P.applyFeesAndTax(markedUp, rec);
  return {
    subtotal: per.subtotal,
    markedUp,
    total: fees.total,
    profit: fees.total - per.subtotal,
  };
}

beforeEach(() => { mount(); });
afterEach(() => { T.setRawCo(null); });

// ══════════════════════════════════════════════════════════════════════
// 1. THE INVARIANT IS A PROPERTY OF THE STATE, NOT OF THE LAST PAINT
// ══════════════════════════════════════════════════════════════════════
// Every assertion in this block runs with NOTHING painted. They are the
// ones that separate "the editor heals what it renders" from "the editor
// cannot hold an unaddressed line".
describe('the state cannot hold a line without an address', () => {
  for (const fx of FIXTURES) {
    test(`${fx.name}: every line is addressed the moment the editor holds it`, () => {
      unmount();                    // no #p86CoLineTable anywhere. Nothing can paint.
      T.setCo(fx.build());
      const lines = T.getCo().lines.filter(Boolean);
      for (const l of lines) {
        expect(l.id == null || String(l.id) === '').toBe(false);
      }
      const ids = lines.map((l) => String(l.id));
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  test('the bypass still shows the shape the editor refuses to hold', () => {
    // setRawCo exists so this file can prove the heal is what does the work,
    // rather than assuming it. Without it there would be no way to observe
    // the defect at all — which is a good property of the fix and a bad one
    // for a test, so the bypass is explicit and used only here.
    const raw = FIXTURES[2].build();
    T.setRawCo(raw);
    expect(T.getCo().lines.every((l) => l.id === undefined)).toBe(true);
    T.setCo(raw);
    expect(T.getCo().lines.every((l) => !!l.id)).toBe(true);
  });

  test('a healed id never lands on an address another line already holds', () => {
    // Adopted WITH THE MINTER PINNED, so the collision is forced rather than
    // hoped for. Row 3 already holds the address the minter's first retry
    // produces, and rows 1-2 are the ones being repaired — so a heal that
    // claims addresses as it walks (one pass) hands row 1 the id row 3 is
    // still using, and row 3 loses the identity it arrived with.
    withPinnedMint(() => T.setCo(FIXTURES[6].build()));
    const lines = T.getCo().lines;
    expect(lines[0].id).toBe(PINNED_ID);            // an existing address is KEPT
    expect(lines[3].id).toBe(PINNED_ID + '_1');     // …including one that looks minted
    const ids = lines.map((l) => String(l.id));
    expect(new Set(ids).size).toBe(4);
  });

  test('minting terminates without relying on randomness', () => {
    // WITH Date.now AND Math.random PINNED, newLineId() is a constant. A
    // minter shaped `do { id = newLineId(); } while (taken[id]);` cannot
    // leave this loop — it spins on the main thread forever. The retry must
    // make progress by construction, not by chance.
    //
    // If this test ever HANGS rather than fails, that is the regression.
    withPinnedMint(() => {
      T.setCo({ lines: [
        { id: PINNED_ID, qty: 1, unitCost: 1 },
        { qty: 1, unitCost: 2 },
        { qty: 1, unitCost: 3 },
        { qty: 1, unitCost: 4 },
      ] });
    });
    const ids = T.getCo().lines.map((l) => String(l.id));
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toBe(PINNED_ID);
  });

  test('id 0 is an address and is kept; null and blank are not and are replaced', () => {
    T.setCo(FIXTURES[8].build());
    const lines = T.getCo().lines;
    expect(lines[0].id).toBe(0);
    expect(String(lines[1].id)).not.toBe('null');
    expect(String(lines[1].id)).not.toBe('undefined');
    expect(String(lines[2].id)).not.toBe('');
    expect(lines[3].id).toBe('keep');
  });

  test('a junk entry in lines[] does not throw on the way in', () => {
    // A truncated payload has put a null in lines[] before. Adopting must
    // step over it rather than die on the whole record.
    //
    // NOT PAINTED, deliberately, and this is a REPORTABLE finding rather
    // than something this workflow fixes: coSectionTotals
    // (js/change-order-editor.js:963) does a bare `l.section` over lines[],
    // so a null entry throws TypeError out of paintLines and takes the
    // whole editor down. That is a different defect from this one, in code
    // this change does not touch.
    expect(() => T.setCo({ lines: [null, { qty: 1, unitCost: 5 }, undefined, 7] }))
      .not.toThrow();
    const lines = T.getCo().lines;
    expect(lines[0]).toBe(null);
    expect(lines[1].id).toBeTruthy();
    expect(lines[3]).toBe(7);
  });

  test('adopting is idempotent — a record can be re-held without being re-addressed', () => {
    const rec = FIXTURES[2].build();
    T.setCo(rec);
    const first = T.getCo().lines.map((l) => l.id);
    T.setCo(T.getCo());               // the same record handed back through the door
    expect(T.getCo().lines.map((l) => l.id)).toEqual(first);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. THE PROPERTY ITSELF
// ══════════════════════════════════════════════════════════════════════
describe('typing into row N changes row N and only row N', () => {
  for (const fx of FIXTURES) {
    test(fx.name, () => {
      const bodyIdx = [];            // body-row k → index in lines[]
      {
        const probe = fx.build();
        T.setCo(probe);
        probe.lines.forEach((l, i) => { if (l && !isHeader(l)) bodyIdx.push(i); });
      }

      for (let k = 0; k < bodyIdx.length; k++) {
        for (const field of ['unitCost', 'qty', 'unitSell', 'markup', 'description']) {
          for (const typed of (field === 'description' ? ['Repaired by hand'] : ['1650', '0', ''])) {
            mount();
            T.setCo(fx.build());
            T.paintLines(); T.paintTotals();

            const lines = T.getCo().lines;
            const target = bodyIdx[k];
            const rows = bodyRows();
            expect(rows).toHaveLength(bodyIdx.length);

            // The row must ADDRESS the line that sits at its position. This
            // is the half a by-id lookup cannot check for itself.
            expect(String(rows[k].getAttribute('data-line-id')))
              .toBe(String(lines[target].id));

            const before = clone(lines);
            const input = rows[k].querySelector('[data-line-field="' + field + '"]');
            expect(input).toBeTruthy();
            const expected = coerce(field, typed, before[target][field]);

            type(input, typed);

            const after = T.getCo().lines;
            expect(after).toHaveLength(before.length);

            // …row N changed.
            expect({ where: k, field, got: after[target][field] })
              .toEqual({ where: k, field, got: expected });

            // …and ONLY row N. Every other line byte-identical, id included.
            for (let i = 0; i < before.length; i++) {
              if (i === target) continue;
              expect({ line: i, v: clone(after[i]) }).toEqual({ line: i, v: before[i] });
            }
          }
        }
      }
    });
  }
});

describe('deleting row N removes row N and only row N', () => {
  for (const fx of FIXTURES) {
    test(fx.name, () => {
      const probe = fx.build();
      T.setCo(probe);
      const bodyCount = probe.lines.filter((l) => l && !isHeader(l)).length;

      for (let k = 0; k < bodyCount; k++) {
        mount();
        T.setCo(fx.build());
        T.paintLines(); T.paintTotals();

        const before = clone(T.getCo().lines);
        const rows = bodyRows();
        const doomedId = String(rows[k].getAttribute('data-line-id'));
        const doomedAt = before.findIndex((l) => l && String(l.id) === doomedId);
        expect(doomedAt).toBeGreaterThan(-1);

        const del = rows[k].querySelector('[data-line-del]');
        expect(del).toBeTruthy();
        del.click();

        const after = T.getCo().lines;
        // Exactly one line gone…
        expect(after).toHaveLength(before.length - 1);
        expect(after.some((l) => l && String(l.id) === doomedId)).toBe(false);
        // …and it is THAT one: the survivors are the others, in order.
        const survivors = before.filter((_, i) => i !== doomedAt);
        expect(clone(after)).toEqual(survivors);
      }
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 3. THE CONSTRAINTS THE BRIEF PUT ON THE HEAL
// ══════════════════════════════════════════════════════════════════════
describe('an address is an internal key, not money', () => {
  for (const fx of FIXTURES) {
    test(`${fx.name}: prices identically to the same record hand-identified`, () => {
      // The control is the SAME record with ids assigned by something other
      // than the healer, so any difference can only come from the heal.
      const control = fx.build();
      control.lines = control.lines.map((l, i) =>
        (l && typeof l === 'object') ? Object.assign({}, l, { id: 'ctl_' + i }) : l);

      const healed = fx.build();
      T.setCo(healed);

      expect(priced(T.getCo())).toEqual(priced(control));
    });
  }

  test('CO-0001 prices at $27,500 before and after, to the cent', () => {
    const rec = FIXTURES[2].build();
    const control = clone(rec);
    T.setCo(rec);
    T.paintLines(); T.paintTotals();
    expect(priced(T.getCo())).toEqual(priced(control));
    expect(chips()['Est. Cost']).toBe('$27,500.00');
    expect(chips()['Change Order Total']).toBe('$27,500.00');
    expect(chips().Profit).toBe('$0.00');
  });

  test('a healed pre-1.19 line still carries no promise — 1.19 back-compat is untouched', () => {
    T.setCo(FIXTURES[2].build());
    for (const l of T.getCo().lines) {
      expect('unitSell' in l).toBe(false);
      expect(P.sellLocked(l)).toBe(false);
    }
  });
});

describe('an address is stable', () => {
  for (const fx of FIXTURES) {
    test(`${fx.name}: byte-stable across repaints`, () => {
      T.setCo(fx.build());
      T.paintLines();
      const first = allRows().map((tr) => tr.getAttribute('data-line-id'));
      for (let i = 0; i < 5; i++) T.paintLines();
      expect(allRows().map((tr) => tr.getAttribute('data-line-id'))).toEqual(first);
      // …and the record agrees with the screen.
      expect(T.getCo().lines.filter(Boolean).map((l) => String(l.id))).toEqual(first);
    });
  }

  test('a repaint does not move the caret off the row being typed into', () => {
    // The reason stability is not cosmetic. paintLines() assigns over the
    // table's innerHTML, so a row whose address changed loses its input
    // node, its focus and any in-flight edit. A section-header keystroke
    // repaints the whole table on every character.
    T.setCo(FIXTURES[7].build());
    T.paintLines(); T.paintTotals();
    const headerRow = document.querySelector('tr.p86-co-section-row');
    const id = headerRow.getAttribute('data-line-id');
    const label = headerRow.querySelector('[data-line-field="label"]');
    label.focus();
    type(label, 'Paint & Gutters');
    const again = document.querySelector('tr[data-line-id="' + id + '"]');
    expect(again).toBeTruthy();
    expect(again.querySelector('[data-line-field="label"]').value).toBe('Paint & Gutters');
    expect(T.getCo().lines[0].label).toBe('Paint & Gutters');
  });

  test('an address survives the round trip through the doors that store it', () => {
    // The heal is in memory. It becomes permanent because the PUT stores
    // lines verbatim — so the ids ride out with the first real edit and the
    // next open is a no-op. Both server doors are exercised, not asserted
    // as source.
    T.setCo(FIXTURES[2].build());
    const minted = T.getCo().lines.map((l) => String(l.id));
    const stored = jobFin.stampCoLineIds(clone(T.getCo().lines));
    expect(stored.map((l) => String(l.id))).toEqual(minted);
    // Reopening the stored record re-adopts it and changes nothing.
    T.setCo({ defaultMarkup: 0, lines: stored });
    expect(T.getCo().lines.map((l) => String(l.id))).toEqual(minted);
  });
});

describe('the row stops being inert — the two things John reported', () => {
  test('typing a real cost moves Est. Cost and arms the autosave', () => {
    jest.useFakeTimers();
    const puts = [];
    window.p86Api = { changeOrders: { update: (id, data) => { puts.push({ id, data }); return Promise.resolve({ change_order: {} }); } } };
    try {
      T.setCo(Object.assign({ id: 'co_1' }, FIXTURES[2].build()));
      T.paintLines(); T.paintTotals();
      expect(document.getElementById('p86CoSaveStatus').textContent).not.toBe('Unsaved changes');

      type(bodyRows()[0].querySelector('[data-line-field="unitCost"]'), '1650');

      expect(T.getCo().lines[0].unitCost).toBe(1650);
      expect(chips()['Est. Cost']).toBe('$26,400.00');
      expect(document.getElementById('p86CoSaveStatus').textContent).toBe('Unsaved changes');

      jest.advanceTimersByTime(1000);
      expect(puts).toHaveLength(1);
      // …and the save carries the addresses, so the record heals for good.
      expect(puts[0].data.lines.every((l) => !!l.id)).toBe(true);
    } finally {
      jest.useRealTimers();
      delete window.p86Api;
    }
  });

  test('delete actually deletes — it used to keep every line', () => {
    T.setCo(FIXTURES[2].build());
    T.paintLines(); T.paintTotals();
    expect(bodyRows()).toHaveLength(10);
    bodyRows()[3].querySelector('[data-line-del]').click();
    expect(T.getCo().lines).toHaveLength(9);
    expect(bodyRows()).toHaveLength(9);
  });

  test('a section with an id-less header stops swallowing its lines', () => {
    T.setCo(FIXTURES[7].build());
    T.paintLines(); T.paintTotals();
    const secRows = Array.from(document.querySelectorAll('tr.p86-co-section-row'));
    expect(secRows).toHaveLength(2);
    for (const tr of secRows) {
      expect(tr.getAttribute('data-line-id')).toBeTruthy();
      expect(tr.getAttribute('data-line-id')).not.toBe('undefined');
      // The section's own cost cell is painted rather than left blank.
      expect(tr.textContent).toMatch(/\$/);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. THE PRODUCERS
// ══════════════════════════════════════════════════════════════════════
describe('the producers that can still omit an address', () => {
  test('the importer now mints one for a change-order line', () => {
    const l = importer.toLine(ocrFlatRate('Gutters — Buildertrend Flat Rate', 2750), 'co');
    expect(l.id).toBeTruthy();
    // …and the money it records is unchanged: price recorded as a price,
    // cost seeded to the same number, zero margin. 1.19's guarantee.
    expect(l).toMatchObject({ qty: 1, unitCost: 2750, unitSell: 2750, costPending: true });
  });

  test('ids minted inside one bulk import are unique, not merely improbable', () => {
    const batch = FAIRWAYS_TRADES.map((d, i) =>
      importer.toLine(ocrFlatRate(d, FAIRWAYS_AMOUNTS[i]), 'co'));
    expect(new Set(batch.map((l) => l.id)).size).toBe(batch.length);
  });

  test('PO and INVOICE lines still carry none, deliberately', () => {
    // Their editors resolve a row by ARRAY INDEX (js/purchase-order-editor.js
    // data-i, js/invoices.js data-li) and never read a line id, so an id
    // there would be dead weight in every stored record. Asserted so the
    // omission reads as a decision rather than the same oversight.
    expect(importer.toLine(ocrItemised('2x4 studs', 40, 4.25), 'po').id).toBeUndefined();
    expect(importer.toLine(ocrItemised('Labor', 8, 65), 'invoice').id).toBeUndefined();
    const src = ['js', 'purchase-order-editor.js'];
    expect(fs.readFileSync(path.join(__dirname, '..', ...src), 'utf8')).not.toMatch(/data-line-id/);
    expect(fs.readFileSync(path.join(__dirname, '..', 'js', 'invoices.js'), 'utf8')).not.toMatch(/data-line-id/);
  });

  test('the editor survives a producer that never learned — the guarantee is the state\'s alone', () => {
    // FIXTURES[1] is the importer with its id deleted after the fact. If the
    // whole property suite passes for it, then closing the producers is
    // belt-and-braces and the state boundary is the belt.
    const rec = FIXTURES[1].build();
    expect(rec.lines.every((l) => l.id === undefined)).toBe(true);
    T.setCo(rec);
    T.paintLines(); T.paintTotals();
    type(bodyRows()[2].querySelector('[data-line-field="unitCost"]'), '999');
    expect(T.getCo().lines[2].unitCost).toBe(999);
    expect(T.getCo().lines[0].unitCost).toBe(2750);
  });
});
