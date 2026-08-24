/**
 * @jest-environment node
 */
/* ──────────────────────────────────────────────────────────────────────────
 * test/estimate-null-line-entry-points.test.js
 *
 * THE PROPERTY:
 *
 *     For ANY position a hole can occupy in a stored lines[], EVERY entry
 *     point on that estimate either works or fails loudly — and none of
 *     them removes the hole.
 *
 * The second clause is the money clause and it is the one that looks
 * backwards. Section membership in an estimate is ARRAY ORDER: a line
 * belongs to the nearest `__section_header__` above it and nothing on the
 * line records that. So the tidy fix — filter the holes out — reindexes the
 * array and re-sections the estimate, moving money between scopes while the
 * cost total sits perfectly still. Holes are SKIPPED, never removed.
 *
 * WHY THE EDITOR STILL HAS TO BE GUARDED even though js/app.js now repairs
 * holes at its hydrate door: that door is the SERVER hydrate. The localStorage
 * boot seed assigns the same flat array from cache, and a flat array's hole
 * carries no estimateId — it cannot be attributed, therefore it cannot be
 * repaired, only survived. An editor opened in that window meets the raw
 * shape. This harness reproduces exactly that: it hydrates through the app's
 * own door WITHOUT app.js's repair, so every guard below is load-bearing.
 *
 * ── THE FIXTURE RULE ─────────────────────────────────────────────────────
 * The record comes from a REAL producer — payload-dispatcher's applyLineAdds,
 * the server-side door behind every 86/Scribe line write. The hole is
 * produced the way storage produces one: an `undefined` slot serialised to
 * JSON, which is what a JSONB round-trip does to it. Nothing here is a
 * literal `null` typed into a fixture.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const H = require('./helpers/estimate-editor-harness');
const dispatcher = require('../server/services/payload-dispatcher').internals;

afterAll(() => H.closeAll());
const clone = (o) => JSON.parse(JSON.stringify(o));
const tick = () => new Promise((r) => setTimeout(r, 0));

const BASE_ALT = 'alt_default';

function producedRecord(estId) {
  const data = {
    id: estId, title: 'Produced ' + estId, defaultMarkup: 0,
    alternates: [{ id: BASE_ALT, name: 'Base', isDefault: true, scope: '' }],
    activeAlternateId: BASE_ALT,
    lines: [],
  };
  dispatcher.applyLineAdds(data, [
    { description: 'Slab prep', qty: 1, unit: 'ls', unit_cost: 3400, section_name: 'General Conditions' },
    { description: 'Rebar #4', qty: 800, unit: 'lf', unit_cost: 1.15, section_name: 'Materials & Supplies Costs', markup_pct: 15 },
    { description: 'Concrete pump', qty: 1, unit: 'day', unit_cost: 1250, section_name: 'Subcontractors Costs' },
    { description: 'Finishers', qty: 32, unit: 'hr', unit_cost: 62, section_name: 'Direct Labor', markup_pct: 25 },
    { description: 'Sealer', qty: 40, unit: 'gal', unit_cost: 38, section_name: 'Materials & Supplies Costs' },
  ]);
  data.lines.filter((l) => l.section === '__section_header__')
    .forEach((h, i) => { h.markup = [10, 20, 30, 40][i % 4]; });
  return data;
}

/* An `undefined` slot, serialised — what a JSONB column stores and returns. */
function withHoleAt(rec, idx) {
  const copy = clone(rec);
  copy.lines.splice(idx, 0, undefined);
  const stored = JSON.parse(JSON.stringify(copy));
  if (stored.lines[idx] !== null) throw new Error('fixture did not produce a stored null');
  return stored;
}

/* The header a line currently sits under — the same backward walk
 * js/pricing-pipeline.js does, which is what makes it the truth about
 * section membership. */
function headerAbove(lines, line) {
  for (let i = lines.indexOf(line) - 1; i >= 0; i--) {
    const L = lines[i];
    if (L && L.section === '__section_header__') return L.description || '(unnamed)';
  }
  return '(no section)';
}

const REF = producedRecord('ref');
const ALL_POSITIONS = [];
for (let i = 0; i <= REF.lines.length; i++) ALL_POSITIONS.push([i]);

describe.each(ALL_POSITIONS)('a stored hole at index %i', (idx) => {
  let h, holed, namedBefore;

  beforeEach(() => {
    holed = withHoleAt(producedRecord('est_open'), idx);
    // A SECOND estimate in the portfolio, always. appData.estimateLines is one
    // flat array across every estimate the client holds, so an entry point
    // that walks it can damage a record that is not on screen.
    const shadow = producedRecord('est_shadow');
    h = H.boot();
    h.hydrate([holed, shadow]);
    namedBefore = H.membership(h.lines());
    h.open('est_open');
  });
  afterEach(() => { if (h) h.dom.window.close(); });

  const holeIsStillThere = () => {
    const holes = h.lines().filter((l) => !l || typeof l !== 'object');
    expect(holes).toHaveLength(1);
  };

  test('the editor opens and paints every real line', () => {
    const real = h.lines().filter((l) => l && l.estimateId === 'est_open' && l.section !== '__section_header__');
    const painted = new Set(h.rows().map((r) => r.id));
    real.forEach((l) => expect(painted.has(String(l.id))).toBe(true));
  });

  test('"+ Line" works under EVERY section header, and lands in that section', () => {
    const headers = h.lines().filter((l) => l && l.estimateId === 'est_open' && l.section === '__section_header__');
    expect(headers.length).toBeGreaterThan(1);
    headers.forEach((hdr) => {
      const before = h.lines().length;
      h.w.addEstimateLineFromEditor(String(hdr.id));
      const after = h.lines();
      expect(after.length).toBe(before + 1);
      const added = after.find((l) => l && l.estimateId === 'est_open' && l.description === '' && l.qty === 1);
      expect(added).toBeTruthy();
      expect(headerAbove(after, added)).toBe(hdr.description);
      // Put it back so the next header starts from the same array.
      h.w.appData.estimateLines.splice(after.indexOf(added), 1);
    });
    holeIsStillThere();
  });

  test('"+ Line" with no section (the legacy no-arg caller) does not throw', () => {
    expect(() => h.w.addEstimateLineFromEditor()).not.toThrow();
    holeIsStillThere();
  });

  test('typing into row N changes row N and ONLY row N', () => {
    const byId = new Map(h.lines().filter((l) => l).map((l) => [String(l.id), l]));
    const rows = h.rows().filter((r) => {
      const l = byId.get(r.id);
      return l && l.section !== '__section_header__';
    });
    expect(rows.length).toBeGreaterThan(1);
    rows.forEach((row, n) => {
      const snap = h.lines().map((l) => JSON.stringify(l));
      const targetIdx = h.lines().indexOf(byId.get(row.id));
      h.typeInto(row.el, 'unitCost', 900 + n);
      const moved = h.lines()
        .map((l, i) => (JSON.stringify(l) === snap[i] ? null : i))
        .filter((i) => i !== null);
      expect(moved).toEqual([targetIdx]);
    });
    expect(h.w.document.getElementById('ee-save-indicator').textContent).toContain('Unsaved');
    holeIsStillThere();
  });

  test('deleting row N removes row N and ONLY row N — the hole survives', async () => {
    const before = h.lines();
    const victim = before.find((l) => l && l.estimateId === 'est_open' && l.section !== '__section_header__');
    h.w.deleteLineFromEditor(String(victim.id));
    await tick();
    const after = h.lines();
    expect(after.length).toBe(before.length - 1);
    expect(after.filter((l) => l && String(l.id) === String(victim.id))).toHaveLength(0);
    holeIsStillThere();
  });

  test('drag-reorder resolves both ends and moves exactly one line', () => {
    const content = h.lines()
      .filter((l) => l && l.estimateId === 'est_open' && l.section !== '__section_header__');
    expect(content.length).toBeGreaterThan(1);
    const from = content[0], to = content[content.length - 1];
    const rowEl = h.rows().find((r) => r.id === String(from.id)).el;
    const before = h.lines().length;

    h.w.onLineDragStart({ target: rowEl, dataTransfer: { setData() {} } }, String(from.id));
    h.w.onLineDrop({ preventDefault() {} }, String(to.id));

    const after = h.lines();
    expect(after.length).toBe(before);                 // nothing dropped, nothing duplicated
    // Dropped onto a row BELOW it, the dragged line takes that row's old slot.
    expect(after.indexOf(from)).toBe(after.indexOf(to) - 1);
    expect(after.filter((l) => l === from)).toHaveLength(1);
    holeIsStillThere();
  });

  test('applyUpdateLine with a section move does not throw, and lands in the section', () => {
    const L = h.lines();
    const line = L.find((l) => l && l.estimateId === 'est_open' && l.description === 'Sealer');
    const out = h.w.estimateEditorAPI.applyUpdateLine({
      line_id: String(line.id), section_name: 'Direct Labor',
    });
    expect(String(out)).toMatch(/Updated/);
    expect(headerAbove(h.lines(), line)).toBe('Direct Labor');
    holeIsStillThere();
  });

  test('applyBulkUpdateLines with a section move does not throw', () => {
    const L = h.lines();
    const ids = L.filter((l) => l && l.estimateId === 'est_open' && l.section !== '__section_header__')
      .slice(0, 2).map((l) => String(l.id));
    expect(() => h.w.estimateEditorAPI.applyBulkUpdateLines({
      line_ids: ids, changes: { section_name: 'General Conditions' },
    })).not.toThrow();
    holeIsStillThere();
  });

  test('applyAddLineItem does not throw and lands in the named section', () => {
    expect(() => h.w.estimateEditorAPI.applyAddLineItem({
      description: 'Added by agent', qty: 2, unit: 'ea', unit_cost: 12.5,
      section_name: 'Materials & Supplies Costs',
    })).not.toThrow();
    const added = h.lines().find((l) => l && l.description === 'Added by agent');
    expect(added).toBeTruthy();
    expect(headerAbove(h.lines(), added)).toBe('Materials & Supplies Costs');
    holeIsStillThere();
  });

  test('the estimate that is NOT on screen is byte-identical after all of it', () => {
    const shadowBefore = clone(h.lines().filter((l) => l && l.estimateId === 'est_shadow'));
    h.w.addEstimateLineFromEditor();
    h.w.estimateEditorAPI.applyAddLineItem({ description: 'X', qty: 1, unit_cost: 1, section_name: 'Direct Labor' });
    expect(h.lines().filter((l) => l && l.estimateId === 'est_shadow')).toEqual(shadowBefore);
  });

  test('no named line changed the section it was in', () => {
    // Every entry point above ran on its own harness; this one asserts the
    // baseline itself — hydrating a holed record re-sections nothing.
    expect(H.membership(h.lines())).toEqual(namedBefore);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE SERVER SIDE OF THE SAME ARRAY. 86's own line writes run through
 * payload-dispatcher against the identical stored shape, and an unguarded
 * predicate there throws an opaque TypeError out of the middle of the
 * transaction — the agent is told about `null`, not about the record.
 * ═════════════════════════════════════════════════════════════════════════ */
describe.each(ALL_POSITIONS)('the agent door, hole at index %i', (idx) => {
  test('applyLineEdits resolves a real line and refuses an unknown one BY NAME', () => {
    const data = withHoleAt(producedRecord('e1'), idx);
    const target = data.lines.find((l) => l && l.description === 'Sealer');
    expect(dispatcher.applyLineEdits(data, [{ line_id: target.id, unit_cost: 44 }])).toBe(1);
    expect(data.lines.find((l) => l && l.description === 'Sealer').unitCost).toBe(44);
    expect(() => dispatcher.applyLineEdits(data, [{ line_id: 'nope', unit_cost: 1 }]))
      .toThrow(/line_id/);
    expect(data.lines[idx]).toBeNull();
  });

  test('applyLineDeletes removes the named line and KEEPS the hole', () => {
    const data = withHoleAt(producedRecord('e1'), idx);
    const before = data.lines.length;
    const target = data.lines.find((l) => l && l.description === 'Sealer');
    expect(dispatcher.applyLineDeletes(data, [{ line_id: target.id }])).toBe(1);
    expect(data.lines.length).toBe(before - 1);
    expect(data.lines.filter((l) => !l)).toHaveLength(1);
  });
});
