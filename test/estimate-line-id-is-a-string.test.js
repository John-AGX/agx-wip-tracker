/**
 * @jest-environment node
 */
/* ──────────────────────────────────────────────────────────────────────────
 * test/estimate-line-id-is-a-string.test.js
 *
 * THE PROPERTY:
 *
 *     For ANY id a producer can actually store, that line is addressable
 *     FROM BOTH SIDES — typing into its row changes that row and only that
 *     row, deleting it removes that row and only that row, and the exact
 *     reference the producer used still resolves on the server and in the
 *     editor's own agent tools.
 *
 * WHY "BOTH SIDES" IS THE WHOLE POINT. An id is a two-sided contract:
 * something WRITES an address and something LOOKS IT UP. A row renders as
 * data-line-id="<l.id>" — an HTML attribute, therefore a STRING — and the
 * handlers resolved it with a strict compare. So a line whose stored id is
 * the NUMBER 12345 renders as data-line-id="12345" and then never matches,
 * because 12345 === "12345" is false. Measured on the shipped code, one such
 * row inside an otherwise healthy estimate: qty, unitCost, markup,
 * description and unit all inert, no save armed, the pill reading "No
 * changes", and delete taking 5 lines in and handing 5 lines back.
 *
 * And coercing only the STORED side moves the mismatch rather than removing
 * it. Measured on the shipped code, in the other direction:
 *
 *   reference │ client agent tool │ server applyLineEdits │ the DOM
 *   ──────────┼───────────────────┼───────────────────────┼──────────────
 *   4242 (n)  │ works             │ works                 │ never emits one
 *   "4242"    │ Error: Line not…  │ throws: not found     │ ALL it emits
 *
 * The stored id is the number, so the agent that created the line could
 * address it and the human could not. String()-ing storage and leaving the
 * lookups strict simply flips which of those two is broken. Both halves are
 * therefore asserted for every shape below.
 *
 * ── THE FIXTURE RULE ─────────────────────────────────────────────────────
 * Every id here comes from the REAL agent door — PD.validateOps accepting the
 * op, then payload-dispatcher's applyLineAdds storing `add.line_id`, then a
 * JSON wire round-trip, which is what a JSONB column does to the blob. The
 * provenance is asserted, not assumed: each shape's first test proves the
 * door really does accept and store it before anything is concluded from it.
 *
 * ── WHAT MAY NOT MOVE ────────────────────────────────────────────────────
 * An id is an internal key, not money. Section membership in an estimate is
 * ARRAY ORDER, so a heal that sorts, filters or re-creates the array
 * re-sections the record and moves money between scopes while the cost total
 * sits still. Every shape is priced through the shared module before and
 * after, and String("l_a") must be byte-identical to "l_a".
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const H = require('./helpers/estimate-editor-harness');
const P = require('../js/pricing-pipeline.js');
const LID = require('../js/line-identity.js');
const PD = require('../server/services/payload-dispatcher');
const dispatcher = PD.internals;

afterAll(() => H.closeAll());
const clone = (o) => JSON.parse(JSON.stringify(o));
const tick = () => new Promise((r) => setTimeout(r, 0));

const BASE_ALT = 'alt_default';

/* ── the record, as the estimates table actually holds it ────────────────
 * Placement, field names, section headers and markup all come from the REAL
 * producer: server/services/payload-dispatcher.js's applyLineAdds, the door
 * behind every 86/Scribe line write.
 *
 * The target line's id is then written back RAW, and that is deliberate and
 * declared: the shipped door read `id: add.line_id || newLineId()` — verbatim
 * storage, no per-line type check anywhere above it — so the rows already in
 * the estimates table carry whatever the model emitted. This commit coerces
 * that door going forward (asserted in its own block below), which repairs
 * new rows and does nothing at all for the ones already stored. An estimate
 * is a JSONB blob and is returned verbatim, so those keep their raw ids until
 * something reads them. This is what "something reads them" has to survive.
 *
 * The JSON round-trip at the end is the JSONB column. */
function storedRecord(estId, targetRawId) {
  const data = {
    id: estId, title: 'Agent-built ' + estId, defaultMarkup: 0,
    feeFlat: 500, feePct: 2, taxPct: 7,
    alternates: [{ id: BASE_ALT, name: 'Base', isDefault: true, scope: '' }],
    activeAlternateId: BASE_ALT,
    lines: [],
  };
  const adds = [
    { description: 'Slab prep', qty: 1, unit: 'ls', unit_cost: 3400, section_name: 'General Conditions' },
    { description: 'Rebar #4', qty: 800, unit: 'lf', unit_cost: 1.15, section_name: 'Materials & Supplies Costs', markup_pct: 15 },
    { line_id: targetRawId, description: 'TARGET', qty: 10, unit: 'ea', unit_cost: 25, section_name: 'Materials & Supplies Costs' },
    { description: 'Concrete pump', qty: 1, unit: 'day', unit_cost: 1250, section_name: 'Subcontractors Costs' },
    { description: 'Finishers', qty: 32, unit: 'hr', unit_cost: 62, section_name: 'Direct Labor', markup_pct: 25 },
  ];
  // The op really is accepted by the door — no per-line id type check.
  PD.validateOps('estimate', { line_adds: adds });
  dispatcher.applyLineAdds(data, adds);
  data.lines.filter((l) => l.section === '__section_header__')
    .forEach((h, i) => { h.markup = [10, 20, 30, 40][i % 4]; });
  // …and the row as the shipped door left it. See the block comment above.
  data.lines.find((l) => l.description === 'TARGET').id = targetRawId;
  return JSON.parse(JSON.stringify(data));      // the JSONB round-trip
}

function priceGroup(est, lines) {
  const group = (lines || []).filter((l) => l && l.alternateId === BASE_ALT);
  const per = P.computeForLines(est, group);
  const markedUp = P.resolveMarkedUp(per, est);
  const ft = P.applyFeesAndTax(P.num(markedUp), est, P.sumOfPriced([per]));
  return { cost: per.subtotal.toFixed(2), sell: P.num(markedUp).toFixed(2), total: ft.total.toFixed(2) };
}

/* Every id shape a producer can put in that column. Each carries the exact
 * value the producing agent would REUSE as a reference on its next turn —
 * which is the half of the contract that String()-ing storage would break. */
const ID_SHAPES = [
  ['a conventional string id', 'l_abc123'],
  ['a NUMBER, straight off the agent door', 12345],
  ['the number ZERO — an address, not an absence', 0],
  ['a string that merely LOOKS numeric', '4242'],
  ['whitespace, which is truthy and therefore stored', '  '],
  ['a very long id', 'l_' + 'x'.repeat(300)],
  // A plain {} used as an id set answers TRUE for this before anything is put
  // in it, so a bulk delete aimed at some other line took this one with it.
  // js/line-identity.js already uses a null-prototype map for exactly this
  // reason; the appliers did not.
  ['an id that names an Object.prototype member', 'constructor'],
];

describe.each(ID_SHAPES)('a line whose id is %s', (_label, rawId) => {
  let rec, shadow, h, asProduced;

  beforeEach(() => {
    rec = storedRecord('est_open', rawId);
    // TWO estimates, always: appData.estimateLines is ONE flat array across
    // the portfolio, so a lookup that misses can only be proved harmless to
    // the record that is NOT on screen by checking that record.
    shadow = storedRecord('est_shadow', 'l_shadow_target');
    asProduced = clone(rec.lines).concat(clone(shadow.lines));
    h = H.boot();
    h.hydrate([rec, shadow]);
    h.open('est_open');
  });
  afterEach(() => { if (h) h.dom.window.close(); });

  const target = () => h.lines().find((l) => l && l.estimateId === 'est_open' && l.description === 'TARGET');

  test('FIXTURE PROVENANCE: the agent door accepts this shape with no type check', () => {
    // This is why rows like this exist at all. validateOps is the only thing
    // between a model's JSON and the estimates table, and it checks that
    // line_adds is an ARRAY — nothing about the ids inside it.
    expect(() => PD.validateOps('estimate', {
      line_adds: [{ line_id: rawId, description: 'TARGET', qty: 1, unit_cost: 1 }],
    })).not.toThrow();
    // …and the stored blob really does hold the raw value, unhealed.
    const raw = storedRecord('probe', rawId);
    expect(raw.lines.find((l) => l.description === 'TARGET').id).toEqual(rawId);
  });

  test('the row is painted, and its address is the one the DOM can carry', () => {
    const t = target();
    expect(t).toBeTruthy();
    const row = h.rows().find((r) => r.id === String(t.id));
    expect(row).toBeTruthy();
    // An HTML attribute is a string. Whatever the producer stored, the stored
    // id and the painted address must be the SAME value, or the row is an
    // orphan the moment anyone touches it.
    expect(typeof t.id).toBe('string');
  });

  test('typing into that row changes THAT row and only that row, and arms the save', () => {
    const t = target();
    const row = h.rows().find((r) => r.id === String(t.id));
    const snap = h.lines().map((l) => JSON.stringify(l));
    const idx = h.lines().indexOf(t);

    h.typeInto(row.el, 'unitCost', 777);
    h.typeInto(row.el, 'qty', 99);
    h.typeInto(row.el, 'description', 'RENAMED');

    const moved = h.lines()
      .map((l, i) => (JSON.stringify(l) === snap[i] ? null : i))
      .filter((i) => i !== null);
    expect(moved).toEqual([idx]);
    expect(t.unitCost).toBe(777);
    expect(t.qty).toBe(99);
    expect(t.description).toBe('RENAMED');
    // The change-order bug's real tell was not the frozen number; it was the
    // pill still reading "Saved" while nothing had been written.
    expect(h.w.document.getElementById('ee-save-indicator').textContent).toContain('Unsaved');
  });

  test('deleting that row removes THAT row and only that row', async () => {
    const t = target();
    const before = h.lines();
    const shadowBefore = clone(before.filter((l) => l && l.estimateId === 'est_shadow'));

    h.w.deleteLineFromEditor(String(t.id));
    await tick();

    const after = h.lines();
    expect(after.length).toBe(before.length - 1);
    expect(after.indexOf(t)).toBe(-1);
    expect(after.map((l) => String(l.id)))
      .toEqual(before.filter((l) => l !== t).map((l) => String(l.id)));
    expect(after.filter((l) => l && l.estimateId === 'est_shadow')).toEqual(shadowBefore);
  });

  test("the CREATING agent's own reference still resolves — both the value it emitted and its string", () => {
    // This is the half that a storage-only String() breaks. The agent stored
    // `line_id: <rawId>` and will hand back exactly that on its next turn;
    // the DOM can only ever hand back String(rawId). Both must land on the
    // same line, and neither may land on a different one.
    const t = target();
    expect(String(h.w.estimateEditorAPI.applyUpdateLine({ line_id: rawId, description: 'BY RAW REF' })))
      .toMatch(/Updated/);
    expect(t.description).toBe('BY RAW REF');
    expect(String(h.w.estimateEditorAPI.applyUpdateLine({ line_id: String(rawId), description: 'BY STRING REF' })))
      .toMatch(/Updated/);
    expect(t.description).toBe('BY STRING REF');
  });

  test('the SERVER resolves the same two references against the stored blob', () => {
    const data = storedRecord('e1', rawId);
    expect(dispatcher.applyLineEdits(data, [{ line_id: rawId, unit_cost: 51 }])).toBe(1);
    expect(data.lines.find((l) => l.description === 'TARGET').unitCost).toBe(51);
    expect(dispatcher.applyLineEdits(data, [{ line_id: String(rawId), unit_cost: 52 }])).toBe(1);
    expect(data.lines.find((l) => l.description === 'TARGET').unitCost).toBe(52);
  });

  test('the SERVER deletes by either reference, and removes exactly one line', () => {
    const a = storedRecord('e1', rawId);
    const n = a.lines.length;
    expect(dispatcher.applyLineDeletes(a, [{ line_id: rawId }])).toBe(1);
    expect(a.lines.length).toBe(n - 1);
    expect(a.lines.filter((l) => l && l.description === 'TARGET')).toHaveLength(0);

    const b = storedRecord('e1', rawId);
    expect(dispatcher.applyLineDeletes(b, [{ line_id: String(rawId) }])).toBe(1);
    expect(b.lines.filter((l) => l && l.description === 'TARGET')).toHaveLength(0);
  });

  test("the delete button accepts the producer's OWN reference, not just the painted one", () => {
    // Both halves again. The row hands back String(id); the agent that made
    // the line hands back whatever it emitted. deleteLineFromEditor resolves
    // the OBJECT through the one door and then removes by identity, so
    // neither reference can miss and neither can take a second row with it.
    const t = target();
    const before = h.lines();
    h.w.deleteLineFromEditor(rawId);
    return Promise.resolve().then(tick).then(() => {
      const after = h.lines();
      expect(after.length).toBe(before.length - 1);
      expect(after.indexOf(t)).toBe(-1);
      expect(after.map((l) => String(l.id)))
        .toEqual(before.filter((l) => l !== t).map((l) => String(l.id)));
    });
  });

  test("the editor's OWN agent appliers delete by either reference too", () => {
    // applyDeleteLine opened with `if (!lineId) throw`, which refuses the id 0
    // outright — the same "0 is an absence" mistake the producer made.
    const t = target();
    const before = h.lines().length;
    expect(String(h.w.estimateEditorAPI.applyDeleteLine({ line_id: rawId }))).toMatch(/Deleted/);
    expect(h.lines().length).toBe(before - 1);
    expect(h.lines().indexOf(t)).toBe(-1);
  });

  test('applyBulkDeleteLines removes the line it names and NOT the one it does not', () => {
    const t = target();
    const other = h.lines().find((l) => l && l.estimateId === 'est_open' && l.description === 'Rebar #4');
    const before = h.lines().length;
    // Aim at a DIFFERENT line first. An id set built on a plain {} answers
    // true for 'constructor' before anything is added to it, so this delete
    // used to take the target with it.
    expect(String(h.w.estimateEditorAPI.applyBulkDeleteLines({ line_ids: [String(other.id)] })))
      .toMatch(/Deleted 1 line/);
    expect(h.lines().length).toBe(before - 1);
    expect(h.lines().indexOf(t)).toBeGreaterThanOrEqual(0);
    // …and then at the target, by the reference the producing agent used.
    expect(String(h.w.estimateEditorAPI.applyBulkDeleteLines({ line_ids: [rawId] })))
      .toMatch(/Deleted 1 line/);
    expect(h.lines().indexOf(t)).toBe(-1);
  });

  test('the heal touched `id` and NOTHING else — no field, no order, no membership', () => {
    const L = h.lines();
    expect(L.length).toBe(asProduced.length);
    expect(H.withoutIds(L)).toEqual(H.withoutIds(asProduced));
    expect(H.membership(L)).toEqual(H.membership(asProduced));
  });

  test('the heal moves no money — both records price to the cent as they did', () => {
    const est = h.w.appData.estimates.find((e) => e.id === 'est_open');
    const est2 = h.w.appData.estimates.find((e) => e.id === 'est_shadow');
    expect(priceGroup(est, h.lines().filter((l) => l && l.estimateId === 'est_open')))
      .toEqual(priceGroup(est, asProduced.filter((l) => l && l.estimateId === 'est_open')));
    expect(priceGroup(est2, h.lines().filter((l) => l && l.estimateId === 'est_shadow')))
      .toEqual(priceGroup(est2, asProduced.filter((l) => l && l.estimateId === 'est_shadow')));
  });

  test('addresses are byte-stable across repaints — the caret cannot detach', () => {
    const ids0 = h.lines().map((l) => String(l.id));
    const dom0 = h.rows().map((r) => r.id);
    h.w.estimateEditorAPI.rerender();
    h.w.estimateEditorAPI.rerender();
    h.open('est_open');
    expect(h.lines().map((l) => String(l.id))).toEqual(ids0);
    expect(h.rows().map((r) => r.id)).toEqual(dom0);
  });

  test('every id in the portfolio is unique, and every painted row resolves', () => {
    const ids = h.lines().map((l) => String(l.id));
    expect(new Set(ids).size).toBe(ids.length);
    const live = new Set(ids);
    expect(h.rows().map((r) => r.id).filter((id) => !live.has(id))).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE DOOR ITSELF, going forward. Coercing the lookups makes the stored
 * population addressable; coercing the producer stops adding to it.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('the agent door, after this change', () => {
  function addOne(lineId) {
    const data = {
      id: 'e1', title: 'x', alternates: [{ id: BASE_ALT, name: 'Base', isDefault: true }],
      activeAlternateId: BASE_ALT, lines: [],
    };
    const adds = [Object.assign(
      { description: 'ONE', qty: 1, unit_cost: 1, section_name: 'Direct Labor' },
      lineId === undefined ? {} : { line_id: lineId }
    )];
    dispatcher.applyLineAdds(data, adds);
    return data.lines.find((l) => l.description === 'ONE');
  }

  test('a numeric line_id is stored as the STRING address the DOM can carry', () => {
    expect(addOne(12345).id).toBe('12345');
  });

  test('the id 0 is an ADDRESS and is kept — the two editors agreed on that everywhere else', () => {
    // test/co-line-addressability.test.js has shipped that assertion for change
    // orders since the CO fix; `add.line_id || newLineId()` silently minted a
    // fresh id here instead, so the same model emitting the same op got two
    // different answers depending on which document it was writing.
    expect(addOne(0).id).toBe('0');
  });

  test('an absent or empty line_id still mints a fresh one', () => {
    expect(addOne(undefined).id).toMatch(/^line_/);
    expect(addOne('').id).toMatch(/^line_/);
    expect(addOne(null).id).toMatch(/^line_/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * A STRING ID MUST COME OUT BYTE-IDENTICAL. The overwhelming majority of the
 * live population is already strings; a heal that touches them is a change of
 * every address in the database for nothing.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('the heal, on the population that is already correct', () => {
  test('String() over a string id is a no-op, and mints nothing', () => {
    const rec = storedRecord('e1', 'l_abc123');
    const before = clone(rec.lines);
    const minted = LID.ensureLineIds(rec.lines);
    expect(minted).toBe(0);
    expect(rec.lines).toEqual(before);
    rec.lines.forEach((l, i) => expect(l.id).toBe(before[i].id));
  });

  test('coercing a NUMBER is not a mint — the CO suite reads that return value', () => {
    // test/co-line-identity.test.js asserts ensureLineIds' minted count. A
    // coercion is a repair of the SAME address, not a new one, and counting it
    // would move that suite under this change.
    const rec = storedRecord('e1', 12345);
    const before = clone(rec.lines);
    const minted = LID.ensureLineIds(rec.lines);
    expect(minted).toBe(0);
    expect(rec.lines.map((l) => l.id)).toEqual(before.map((l) => String(l.id)));
    expect(H.withoutIds(rec.lines)).toEqual(H.withoutIds(before));
    expect(H.membership(rec.lines)).toEqual(H.membership(before));
  });

  test('it is idempotent — a second pass changes nothing at all', () => {
    const rec = storedRecord('e1', 12345);
    LID.ensureLineIds(rec.lines);
    const once = clone(rec.lines);
    expect(LID.ensureLineIds(rec.lines)).toBe(0);
    expect(rec.lines).toEqual(once);
  });

  test('a hole is still skipped, never coerced into an object and never removed', () => {
    const rec = storedRecord('e1', 12345);
    rec.lines.splice(2, 0, undefined);
    const wire = JSON.parse(JSON.stringify(rec.lines));
    const n = wire.length;
    LID.ensureLineIds(wire);
    expect(wire.length).toBe(n);
    expect(wire[2]).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * A REFERENCE THAT RESOLVES TO NOTHING MUST INDEX TO NOTHING.
 *
 * The handlers that SPLICE resolve the object and then ask the raw array for
 * indexOf(object). That is only safe because a failed resolve is refused
 * before the indexOf: `[].indexOf(null)` finds a stored HOLE, and a hole is a
 * real element at a real position — so an unresolvable section id would have
 * inserted the new line at the hole's index instead of appending, which is a
 * silent re-sectioning.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('an unresolvable reference, on a record that also holds a hole', () => {
  function holed(estId) {
    const rec = storedRecord(estId, 'l_target');
    rec.lines.splice(1, 0, undefined);          // an `undefined` slot…
    const wire = JSON.parse(JSON.stringify(rec));  // …serialised, as JSONB does
    if (wire.lines[1] !== null) throw new Error('fixture did not produce a stored null');
    return wire;
  }

  test('"+ Line" under a section that does not exist appends — it does not land on the hole', () => {
    const h = H.boot();
    const rec = holed('est_open');
    h.hydrate([rec]);
    h.open('est_open');
    const before = h.lines().slice();

    h.w.addEstimateLineFromEditor('no_such_section');

    const after = h.lines();
    expect(after.length).toBe(before.length + 1);
    // The hole is still at index 1, and everything that was above/below it
    // still is. A line inserted AT the hole would have shifted it.
    expect(after[1]).toBeNull();
    expect(after.indexOf(before[2])).toBe(2);
    h.dom.window.close();
  });

  test('a drag whose source no longer resolves moves nothing', () => {
    const h = H.boot();
    h.hydrate([holed('est_open')]);
    h.open('est_open');
    const before = h.lines().slice();
    const to = before.find((l) => l && l.description === 'TARGET');

    h.w.onLineDragStart({ target: h.rows()[0].el, dataTransfer: { setData() {} } }, 'gone');
    h.w.onLineDrop({ preventDefault() {} }, String(to.id));

    expect(h.lines()).toEqual(before);
    h.dom.window.close();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE LEGACY MODAL, where a missed address is not a dead field — it is a
 * DELETED LINE. js/estimates.js's saveEstimateEdits rebuilds this estimate's
 * slice from the ids it read off the DOM and drops everything it did not see,
 * so a stored NUMBER (which the row carries as the string "12345") fell out
 * of the set and out of the record.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('the legacy edit-estimate modal', () => {
  const fs = require('fs');
  const path = require('path');
  const { JSDOM } = require('jsdom');

  const SHELL = '<!doctype html><html><body>' +
    ['title', 'jobType', 'client', 'community', 'clientId', 'propertyAddr', 'billingAddr',
      'managerName', 'managerEmail', 'managerPhone', 'scopeOfWork', 'defaultMarkup']
      .map((k) => '<input id="editEst_' + k + '" value="" />').join('') +
    '<table><tbody id="editEstimate_lineItemsBody"></tbody></table></body></html>';

  function bootLegacy(rec) {
    const dom = new JSDOM(SHELL, { runScripts: 'dangerously', url: 'https://project86.net/' });
    const w = dom.window;
    w.eval(`
      window.escapeHTML = function(s){ return s==null?'':String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); };
      window.formatCurrency = function(v){ return '$' + Number(v||0).toFixed(2); };
      window.saveData = function(){}; window.closeModal = function(){};
      window.openModal = function(){}; window.renderEstimatesList = function(){};
      window.recalcEstimateTotals = function(){}; window.p86Icon = function(){ return ''; };
      window.alert = function(){};
      window.appData = { estimates: [], estimateLines: [], leads: [], clients: [], jobs: [] };
      appData = window.appData;
    `);
    const s = w.document.createElement('script');
    s.textContent = fs.readFileSync(path.join(H.REPO, 'js', 'estimates.js'), 'utf8');
    w.document.body.appendChild(s);

    const meta = Object.assign({}, rec);
    delete meta.lines;
    w.appData.estimates.push(meta);
    w.appData.estimateLines = rec.lines.slice();
    w.eval('currentEditEstimateId = ' + JSON.stringify(rec.id) + ';');
    // The REAL renderer builds the rows — including row.dataset.lineId, which
    // is where a stored number becomes the string the save reads back.
    w.renderEditEstimateLineItems(w.appData.estimateLines.filter((l) => l && l.estimateId === rec.id));
    return { dom, w };
  }

  test.each(ID_SHAPES)('saving with an id that is %s keeps the line and edits it', (_label, rawId) => {
    const rec = storedRecord('e1', rawId);
    const { dom, w } = bootLegacy(rec);
    const n = w.appData.estimateLines.length;

    const row = w.document.querySelector('[data-line-id="' + String(rawId).replace(/"/g, '\\"') + '"]');
    expect(row).toBeTruthy();
    row.querySelector('[data-field="unitCost"]').value = '99';

    w.saveEstimateEdits();

    // NOT DELETED. This filter rebuilds the estimate's slice from what it
    // recognised, so a missed address removes the line outright.
    expect(w.appData.estimateLines.length).toBe(n);
    const line = w.appData.estimateLines.find((l) => l && l.description === 'TARGET');
    expect(line).toBeTruthy();
    expect(line.unitCost).toBe(99);
    dom.window.close();
  });

  test('removeEstimateLineRow removes the row it names and only that row', () => {
    const rec = storedRecord('e1', 12345);
    const { dom, w } = bootLegacy(rec);
    const n = w.appData.estimateLines.length;
    w.removeEstimateLineRow('12345');        // the address the DOM carries
    expect(w.appData.estimateLines.length).toBe(n - 1);
    expect(w.appData.estimateLines.filter((l) => l && l.description === 'TARGET')).toHaveLength(0);
    dom.window.close();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * AN EMPTY REFERENCE IS NOT A REFERENCE.
 *
 * `applyLineEdits` with line_id undefined matched the FIRST id-less line via
 * findIndex and wrote into it silently — `edited: 1`, a line nobody named.
 * `line_id: ''` and `line_id: null` correctly threw. And naive coercion makes
 * it WORSE, not better: String(undefined) === String(undefined) is true, so
 * `String(l.id) === String(rawId)` still matches the first blank-id line. The
 * guard has to be explicit and separate, which is why it lands in the same
 * commit as the coercion rather than after it.
 * ═════════════════════════════════════════════════════════════════════════ */
describe.each([
  ['undefined', undefined],
  ['null', null],
  ['an empty string', ''],
])('a line_id of %s', (_label, emptyRef) => {
  /* A record whose lines carry no id. This is the shape a bulk import
   * produced on the change-order side — the defect that started all of this —
   * and estimate blobs are stored and returned verbatim, so a record that got
   * in this way stays this way on the server, where nothing heals it. */
  function blankIdRecord() {
    const data = storedRecord('e1', 'l_real');
    data.lines.forEach((l) => { delete l.id; });
    return data;
  }

  test('the SERVER refuses it by name and writes NOTHING', () => {
    const data = blankIdRecord();
    const before = clone(data.lines);
    let thrown = null;
    try { dispatcher.applyLineEdits(data, [{ description: 'CLOBBERED', line_id: emptyRef }]); }
    catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    // Refusal has to NAME what it could not resolve. "0 lines edited,
    // success" is the failure mode this repo has been bitten by most.
    expect(String(thrown.message)).toMatch(/line_id/);
    expect(data.lines).toEqual(before);
  });

  test('an edit carrying NO line_id key at all is refused too', () => {
    const data = blankIdRecord();
    const before = clone(data.lines);
    expect(() => dispatcher.applyLineEdits(data, [{ description: 'CLOBBERED' }])).toThrow();
    expect(data.lines).toEqual(before);
  });

  test('the CLIENT applier refuses it and writes NOTHING', () => {
    const rec = storedRecord('est_open', 'l_real');
    const h = H.boot();
    h.hydrate([rec]);
    h.open('est_open');
    const before = clone(h.lines());
    expect(() => h.w.estimateEditorAPI.applyUpdateLine({ line_id: emptyRef, description: 'CLOBBERED' }))
      .toThrow();
    expect(h.lines().map((l) => l.description)).toEqual(before.map((l) => l.description));
    h.dom.window.close();
  });

  test('the SERVER deletes nothing for an empty reference', () => {
    const data = blankIdRecord();
    const n = data.lines.length;
    expect(dispatcher.applyLineDeletes(data, [{ line_id: emptyRef }])).toBe(0);
    expect(data.lines.length).toBe(n);
  });
});
