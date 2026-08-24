/**
 * @jest-environment node
 */
/* ──────────────────────────────────────────────────────────────────────────
 * test/estimate-line-addressability.test.js
 *
 * THE PROPERTY, stated once and then tested against everything that can
 * produce an estimate line:
 *
 *     For any estimate the app can load, from any producer, every line is
 *     INDEPENDENTLY ADDRESSABLE — typing into row N changes row N and only
 *     row N, deleting row N removes row N and only row N — and the SECTION
 *     each line belongs to is unchanged by the heal.
 *
 * The last clause is the money one. An estimate's sections are delimited by
 * `__section_header__` rows and membership is ARRAY ORDER: js/pricing-
 * pipeline.js's sectionHeaderFor does allLines.indexOf(line) and walks
 * BACKWARD to the nearest header. Nothing on the line records which section
 * it is in. So a "tidy-up" that sorts, filters, de-duplicates or re-creates
 * the array re-sections the estimate and moves money between scopes while
 * the cost total sits perfectly still — and nothing in the totals strip
 * flinches. Every producer below is therefore checked twice: once that its
 * lines came out addressable, and once that not one line changed section.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 * The change-order editor lost a day to this exact class. A line's `id` is
 * its ADDRESS: every row renders as data-line-id="<id>" and every handler
 * resolves the line by matching the attribute back. A bulk import produced
 * id-less lines, `String(undefined) === String("")` was false, and EVERY
 * handler returned on its first statement — qty, cost, markup, description,
 * delete — while the save pill went on reading "Saved". It survived review
 * because the customer-facing document iterates by ARRAY ORDER, not by id,
 * so the PDF printed perfectly the whole time the editor was inert.
 *
 * The estimate editor is the same id-resolved pattern. A ground pass over
 * every producer found that all twelve of them DO mint an id, so the
 * missing-id case is not reachable today. That is worth saying plainly
 * rather than dressing up:
 *
 *   • MISSING id  — a GUARD. No producer emits one. The cases below marked
 *     INVENTED test it anyway, because "not broken today" is exactly the
 *     sentence that was true of change orders the week before they broke,
 *     and because the guard is what keeps the thirteenth producer honest.
 *   • DUPLICATE id — a LIVE repair. Three producers minted ids as bare clock
 *     reads (`'l' + Date.now()`, `'s' + Date.now() + '_' + idx`, `'alt_' +
 *     Date.now()`), so uniqueness was a property of machine speed, not of
 *     the code. Frozen-clock cases below fail against the old code.
 *   • STALE addresses — a LIVE repair, and it needs no bad id at all. Two
 *     shipping call sites replace this estimate's slice of
 *     appData.estimateLines wholesale with fresh server rows and then guard
 *     their refresh on `estimateEditorAPI.rerender` / `.currentId`, neither
 *     of which existed. The guard was always false, the refresh never once
 *     fired, and after a take-off push every row on screen was addressed by
 *     an id no longer in appData.
 *
 * ── THE FIXTURE RULE ─────────────────────────────────────────────────────
 * A workflow "fixed and verified" a caret bug in the CO editor by driving
 * the real code in jsdom. It passed and it was useless: its fixtures gave
 * every line an id — a shape imported records do not have. So every fixture
 * here is DERIVED FROM WHAT A PRODUCER ACTUALLY EMITS:
 *
 *   EDITOR   estimateEditorAPI.applyBulkAddLineItems — the real applier the
 *            AI panel and the materials/catalog drawer both call.
 *   AGENT    payload-dispatcher internals.applyLineAdds — the real server
 *            producer behind 86/Scribe line writes.
 *   ASSEMBLY estimate-lines.explodeForEstimate + applyAssemblyToEstimateData
 *            — the real server producer behind take-offs and assemblies.
 *   GROUPS   applyAddGroup driven twice with Date.now() FROZEN. Not an
 *            invented shape: a real producer asked whether its uniqueness
 *            is a property of the code or an accident of clock resolution.
 *
 * Two shapes ARE invented, and are labelled INVENTED where they are built:
 * the id-stripped record (no producer emits it — it is the shape the
 * reviewer's claim is about) and a null inside lines[] (no producer emits
 * it either, but estimates are stored as a JSONB blob and round-tripped
 * verbatim, so one that got in would stay in).
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const H = require('./helpers/estimate-editor-harness');
const cacheBuster = require('./helpers/cache-buster');

const P = require('../js/pricing-pipeline.js');
const LID = require('../js/line-identity.js');
const estLines = require('../server/services/estimate-lines');
const dispatcher = require('../server/services/payload-dispatcher').internals;

const read = (rel) => fs.readFileSync(path.join(H.REPO, rel), 'utf8');

// Shut every jsdom window the harness opened, including ones a throwing test
// never got to close. A leaked window keeps the jest worker alive past the
// run ("a worker process has failed to exit gracefully").
afterAll(() => H.closeAll());
const clone = (o) => JSON.parse(JSON.stringify(o));
const tick = () => new Promise((r) => setTimeout(r, 0));

const BASE_ALT = 'alt_default';

// ── producers ─────────────────────────────────────────────────────────────

// EDITOR. Drive the shipped applier in a throwaway harness and keep what it
// produced. Section markups are set afterwards the way the section header
// controls set them, so the record exercises %, $-mode and override — the
// three shapes that make ARRAY POSITION decide money.
function fromEditorApplier(estId) {
  const h = H.boot();
  h.hydrate({
    id: estId, title: 'Editor-built', defaultMarkup: 0,
    feeFlat: 500, feePct: 2, taxPct: 7, roundTo: 5,
  });
  h.open(estId);
  h.w.estimateEditorAPI.applyBulkAddLineItems([
    { description: '2x4 stud 92-5/8', qty: 240, unit: 'ea', unit_cost: 4.25, bt_category: 'materials', markup_pct: 10 },
    { description: 'OSB 7/16 4x8', qty: 96, unit: 'sh', unit_cost: 21.37, bt_category: 'materials' },
    { description: 'Framing crew', qty: 168, unit: 'hr', unit_cost: 55, bt_category: 'labor', markup_pct: 30 },
    { description: 'Dumpster pulls', qty: 3, unit: 'ea', unit_cost: 465, bt_category: 'gc' },
    { description: 'Drywall subcontract', qty: 1, unit: 'ls', unit_cost: 8200, bt_category: 'sub', markup_pct: 12 },
    { description: 'Punch labor', qty: 12, unit: 'hr', unit_cost: 48, bt_category: 'labor' },
  ]);
  const L = h.lines();
  const hdrs = L.filter((l) => l.section === '__section_header__');
  hdrs[0].markup = 10;
  hdrs[1].markup = 20; hdrs[1].overrideLineMarkups = true;
  hdrs[2].markup = 300; hdrs[2].markupMode = 'dollar';
  hdrs[3].markup = 40;
  const rec = Object.assign(clone(h.w.appData.estimates[0]), { lines: clone(L) });
  h.dom.window.close();
  return rec;
}

// AGENT. The real server-side line producer. `data` is an estimate blob in
// exactly the shape the estimates table stores.
function fromAgentDispatcher(estId) {
  const data = {
    id: estId, title: 'Agent-built', defaultMarkup: 0,
    alternates: [{ id: BASE_ALT, name: 'Base', isDefault: true, scope: '' }],
    activeAlternateId: BASE_ALT,
    lines: [],
  };
  dispatcher.applyLineAdds(data, [
    { description: 'Slab prep', qty: 1, unit: 'ls', unit_cost: 3400, section_name: 'General Conditions' },
    { description: 'Rebar #4', qty: 800, unit: 'lf', unit_cost: 1.15, section_name: 'Materials & Supplies Costs', markup_pct: 15 },
    { description: 'Concrete pump', qty: 1, unit: 'day', unit_cost: 1250, section_name: 'Subcontractors Costs' },
    { description: 'Finishers', qty: 32, unit: 'hr', unit_cost: 62, section_name: 'Direct Labor', markup_pct: 25 },
  ]);
  return data;
}

// ASSEMBLY. The real take-off / assembly producer, server side.
const REPAINT = { id: 47, name: 'Exterior Repaint — Stucco', unit: 'SF', params: null };
const PRICED_ITEMS = [
  { assembly_id: 47, kind: 'material', description: 'Paint, 5-gal', unit: 'GAL', qty_per_unit: 0.005, unit_cost: 180, cost_code: 'materials' },
  { assembly_id: 47, kind: 'labor', description: 'Painter hours', unit: 'HR', qty_per_unit: 0.02, unit_cost: 45, cost_code: 'labor' },
  { assembly_id: 47, kind: 'sub', description: 'Pressure wash', unit: 'SF', qty_per_unit: 1, unit_cost: 0.25, cost_code: 'sub' },
];
function fromServerAssembly(estId) {
  const data = {
    id: estId, title: 'Assembly-built', defaultMarkup: 0,
    alternates: [{ id: BASE_ALT, estimateId: estId, name: 'Base' }],
    activeAlternateId: BASE_ALT,
    lines: [
      { id: 's_mat', estimateId: estId, alternateId: BASE_ALT, section: '__section_header__', description: 'Materials & Supplies Costs', btCategory: 'materials', markup: 12 },
      { id: 'l_existing', estimateId: estId, alternateId: BASE_ALT, description: 'Existing material line', qty: 4, unit: 'ea', unitCost: 10 },
      { id: 's_sub', estimateId: estId, alternateId: BASE_ALT, section: '__section_header__', description: 'Subcontractors Costs', btCategory: 'sub', markup: 8 },
    ],
  };
  const ex = estLines.explodeForEstimate({
    assembly_id: 47,
    graph: { assemblies: new Map([[47, REPAINT]]), itemsBy: new Map([[47, PRICED_ITEMS]]) },
    params: { Q: 3200 },
  });
  estLines.applyAssemblyToEstimateData(data, { estId, assembly: REPAINT, rows: ex.rows, scope: ex.scope, mode: 'rollup' });
  return data;
}

// INVENTED — every id deleted. No producer emits this today; it is the exact
// shape the thirteenth producer would emit, and it is the shape the review
// claim ("not broken today") is about. Built from the AGENT record so
// everything except identity is real.
function idStripped(estId) {
  const rec = fromAgentDispatcher(estId);
  rec.title = 'Id-stripped (INVENTED shape)';
  rec.lines = rec.lines.map((l) => { const c = Object.assign({}, l); delete c.id; return c; });
  return rec;
}

// INVENTED — every id set to the SAME string. Also not emitted by any
// producer as written, but it is what the frozen-clock producers below
// converge on, and it is the failure mode that is worse than absence: a
// duplicate does not freeze the row, it silently redirects the write.
function idCollided(estId) {
  const rec = fromEditorApplier(estId);
  rec.title = 'Id-collided (INVENTED shape)';
  rec.lines.forEach((l) => { l.id = 'same'; });
  return rec;
}

const PRODUCERS = [
  { name: 'EDITOR applyBulkAddLineItems  (real producer)', build: fromEditorApplier },
  { name: 'AGENT payload-dispatcher      (real producer)', build: fromAgentDispatcher },
  { name: 'ASSEMBLY server take-off      (real producer)', build: fromServerAssembly },
  { name: 'ID-STRIPPED                   (INVENTED shape)', build: idStripped },
  { name: 'ID-COLLIDED                   (INVENTED shape)', build: idCollided },
];

// ══════════════════════════════════════════════════════════════════════════
// THE PROPERTY
// ══════════════════════════════════════════════════════════════════════════
describe.each(PRODUCERS)('THE PROPERTY — %s', ({ build }) => {
  // TWO estimates in the portfolio, always. appData.estimateLines is ONE flat
  // array across every estimate the client holds and NOT ONE handler filters
  // by estimateId — a duplicate address does not freeze a row, it writes into
  // whichever copy is earlier in the array, possibly in a record that is not
  // on screen. A single-estimate fixture cannot see that at all.
  let h, open, shadow, asProduced;

  beforeEach(() => {
    open = build('est_open');
    shadow = build('est_shadow');
    // SNAPSHOT BEFORE ANYTHING HEALS. hydrate pushes these very objects into
    // appData by reference, so a snapshot taken after the open would be a
    // snapshot of the heal's own output — every "nothing changed" assertion
    // below would then be comparing the result to itself and would pass no
    // matter what the heal did. (Which it was, until a mutation run noticed:
    // a heal that SORTED the array left this whole block green.)
    asProduced = clone(open.lines).concat(clone(shadow.lines));
    h = H.boot();
    h.hydrate([open, shadow]);
    h.open('est_open');
  });
  afterEach(() => { if (h) h.dom.window.close(); });

  test('every line has a non-empty address, unique across the WHOLE portfolio', () => {
    const L = h.lines();
    expect(L.length).toBe(open.lines.length + shadow.lines.length);
    L.forEach((l, i) => {
      expect(`${i}:${l.id == null ? 'MISSING' : String(l.id)}`).not.toMatch(/:(MISSING|)$/);
    });
    const ids = L.map((l) => String(l.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the heal touched `id` and NOTHING else — no field, no order, no membership', () => {
    const L = h.lines();
    // Nothing added, nothing dropped, nothing moved.
    expect(L.length).toBe(asProduced.length);
    expect(H.withoutIds(L)).toEqual(H.withoutIds(asProduced));
    // And the money-safety clause, stated in its own terms.
    expect(H.membership(L)).toEqual(H.membership(asProduced));
  });

  test('the heal moves no money — the record prices to the cent as it did', () => {
    // The RAW producer output (snapshotted pre-heal) against the healed
    // array, through the shared pricing module. An id is an internal key,
    // not money: if a single cent moves, the heal is wrong no matter how
    // tidy the ids look.
    const rawOpen = asProduced.filter((l) => l && l.estimateId === 'est_open');
    const healedOpen = h.lines().filter((l) => l && l.estimateId === 'est_open');
    const est = h.w.appData.estimates.find((e) => e.id === 'est_open');
    expect(H.priceGroup(P, est, healedOpen)).toEqual(H.priceGroup(P, est, rawOpen));
    // Same question of the estimate that is NOT on screen — it shares the
    // array, so a heal aimed at one record can only be proved harmless to
    // the other by pricing the other.
    const rawShadow = asProduced.filter((l) => l && l.estimateId === 'est_shadow');
    const healedShadow = h.lines().filter((l) => l && l.estimateId === 'est_shadow');
    const est2 = h.w.appData.estimates.find((e) => e.id === 'est_shadow');
    expect(H.priceGroup(P, est2, healedShadow)).toEqual(H.priceGroup(P, est2, rawShadow));
  });

  test('typing into row N changes row N and ONLY row N — and arms the save', () => {
    const rows = h.rows();
    const L = h.lines();
    const byId = new Map(L.map((l) => [String(l.id), l]));
    const contentRows = rows.filter((r) => {
      const l = byId.get(r.id);
      return l && l.section !== '__section_header__';
    });
    expect(contentRows.length).toBeGreaterThan(1);

    contentRows.forEach((row, n) => {
      const snap = clone(h.lines());
      const target = byId.get(row.id);
      const targetIdx = h.lines().indexOf(target);
      const stamp = 1000 + n;
      h.typeInto(row.el, 'unitCost', stamp);

      const after = h.lines();
      const moved = after
        .map((l, i) => (JSON.stringify(l) === JSON.stringify(snap[i]) ? null : i))
        .filter((i) => i !== null);
      expect(moved).toEqual([targetIdx]);
      expect(after[targetIdx].unitCost).toBe(stamp);
    });

    // The CO bug's real tell was not the frozen number — it was the pill
    // still reading "Saved" while nothing had been written. A keystroke
    // that reaches the record must also arm the autosave.
    expect(h.w.document.getElementById('ee-save-indicator').textContent).toContain('Unsaved');
  });

  test('deleting row N removes row N and ONLY row N — the other estimate is untouched', async () => {
    const L0 = h.lines();
    const shadowBefore = clone(L0.filter((l) => l && l.estimateId === 'est_shadow'));
    const victim = h.rows()
      .map((r) => L0.find((l) => String(l.id) === r.id))
      .find((l) => l && l.section !== '__section_header__');
    expect(victim).toBeTruthy();

    h.w.deleteLineFromEditor(String(victim.id));
    await tick();

    const after = h.lines();
    expect(after.length).toBe(L0.length - 1);
    expect(after.filter((l) => String(l.id) === String(victim.id))).toHaveLength(0);
    // Nothing else moved — same objects, same order, minus exactly one.
    expect(after.map((l) => String(l.id)))
      .toEqual(L0.filter((l) => l !== victim).map((l) => String(l.id)));
    // And the estimate that is NOT on screen is byte-identical.
    expect(after.filter((l) => l && l.estimateId === 'est_shadow')).toEqual(shadowBefore);
  });

  test('addresses are byte-stable across repaints — the caret cannot detach', () => {
    const ids0 = h.lines().map((l) => String(l.id));
    const domIds0 = h.rows().map((r) => r.id);
    h.w.estimateEditorAPI.rerender();
    h.w.estimateEditorAPI.rerender();
    h.open('est_open');
    expect(h.lines().map((l) => String(l.id))).toEqual(ids0);
    expect(h.rows().map((r) => r.id)).toEqual(domIds0);
  });

  test('every rendered row is addressed by an id that is actually in appData', () => {
    const live = new Set(h.lines().map((l) => String(l.id)));
    const orphans = h.rows().map((r) => r.id).filter((id) => !live.has(id));
    expect(orphans).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE DOORS — where an unaddressed or stale line actually gets in
// ══════════════════════════════════════════════════════════════════════════
describe('the state boundary on appData.estimateLines', () => {
  let h;
  beforeEach(() => {
    h = H.boot();
    h.hydrate(fromAgentDispatcher('est_open'));
    h.open('est_open');
  });
  afterEach(() => h.dom.window.close());

  test('DOOR: wholesale reassignment (the take-off / assembly merge) heals', () => {
    // js/markup-viewer.js mergeAppendIntoAppData and js/sheet-editor.js
    // applyLinesToAppData both do exactly this: drop this estimate's slice,
    // concat the server's fresh rows. Fresh rows here arrive id-less.
    const ad = h.w.appData;
    const fresh = clone(ad.estimateLines).map((l) => { const c = Object.assign({}, l); delete c.id; return c; });
    ad.estimateLines = ad.estimateLines
      .filter((l) => String(l.estimateId) !== 'est_open')
      .concat(fresh);
    const L = h.lines();
    expect(L.every((l) => l && l.id != null && String(l.id) !== '')).toBe(true);
    expect(new Set(L.map((l) => String(l.id))).size).toBe(L.length);
  });

  test('DOOR: push / unshift / splice onto the live array heal — the hole the CO fix left open', () => {
    // A property accessor on the HOST intercepts `host.lines = X`. It does
    // NOT intercept `host.lines.push(x)` — that reads through the getter and
    // mutates what it returned. That hole was demonstrated live on the change
    // order editor; it must not exist here.
    const ad = h.w.appData;
    const bare = () => ({ estimateId: 'est_open', alternateId: BASE_ALT, description: 'no address', qty: 1, unit: 'ea', unitCost: 5 });
    ad.estimateLines.push(bare());
    ad.estimateLines.unshift(bare());
    ad.estimateLines.splice(2, 0, bare());
    const L = h.lines();
    expect(L.filter((l) => !l || l.id == null || String(l.id) === '')).toEqual([]);
    expect(new Set(L.map((l) => String(l.id))).size).toBe(L.length);
  });

  test('a line pushed while the editor is OPEN is addressable the moment it renders', () => {
    const ad = h.w.appData;
    ad.estimateLines.push({ estimateId: 'est_open', alternateId: BASE_ALT, description: 'late arrival', qty: 2, unit: 'ea', unitCost: 30 });
    h.w.estimateEditorAPI.rerender();
    const row = h.rows().find((r) => r.el.textContent.includes('late arrival'));
    expect(row).toBeTruthy();
    expect(row.id).not.toBe('');
    const before = clone(h.lines());
    h.typeInto(row.el, 'qty', 9);
    const moved = h.lines().map((l, i) => (JSON.stringify(l) === JSON.stringify(before[i]) ? null : i)).filter((i) => i !== null);
    expect(moved).toHaveLength(1);
    expect(h.lines()[moved[0]].qty).toBe(9);
  });

  test('a null inside lines[] does not brick the editor', () => {
    // No producer emits one. Estimates are stored as a JSONB blob and
    // round-tripped verbatim, so one that got in would stay in — and this is
    // the FIRST walk on open, so an unguarded throw here means the estimate
    // simply never opens and the click does nothing, with no error on screen.
    const h2 = H.boot();
    const rec = fromAgentDispatcher('est_null');
    h2.hydrate(rec);
    h2.w.appData.estimateLines.splice(2, 0, null);
    expect(() => h2.open('est_null')).not.toThrow();
    expect(h2.rows().length).toBeGreaterThan(0);
    // And the null was SKIPPED, never removed: removing it would shift array
    // positions, and section membership IS array position.
    expect(h2.lines().filter((l) => l === null)).toHaveLength(1);
    h2.dom.window.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE STALE-ADDRESS DOOR — needs no bad id at all
// ══════════════════════════════════════════════════════════════════════════
describe('a take-off / assembly push under a live editor', () => {
  // Reproduced as the two shipping call sites actually write it, quoted from
  // js/markup-viewer.js:2596 and js/sheet-editor.js:4521.
  function refreshLikeTheCallSites(w, estId) {
    if (w.estimateEditorAPI && typeof w.estimateEditorAPI.rerender === 'function'
        && w.estimateEditorAPI.currentId
        && String(w.estimateEditorAPI.currentId()) === String(estId)) {
      w.estimateEditorAPI.rerender();
      return true;
    }
    return false;
  }

  test('the refresh guard the call sites already wrote can actually fire', () => {
    const h = H.boot();
    h.hydrate(fromAgentDispatcher('est_open'));
    h.open('est_open');
    expect(refreshLikeTheCallSites(h.w, 'est_open')).toBe(true);
    expect(refreshLikeTheCallSites(h.w, 'some_other_estimate')).toBe(false);
    h.dom.window.close();
  });

  test('after the merge, no row is addressed by a dead id and typing still lands', () => {
    const h = H.boot();
    h.hydrate(fromAgentDispatcher('est_open'));
    h.open('est_open');
    const ad = h.w.appData;
    // The server's answer: the same lines, re-minted ids (which is what the
    // server does — it stamps its own).
    const fresh = clone(ad.estimateLines).map((l, i) => Object.assign({}, l, {
      id: (l.section === '__section_header__' ? 's' : 'l') + 'srv_' + i,
    }));
    ad.estimateLines = ad.estimateLines.filter((l) => String(l.estimateId) !== 'est_open').concat(fresh);
    refreshLikeTheCallSites(h.w, 'est_open');

    const live = new Set(h.lines().map((l) => String(l.id)));
    expect(h.rows().map((r) => r.id).filter((id) => !live.has(id))).toEqual([]);

    const row = h.rows().find((r) => {
      const l = h.lines().find((x) => String(x.id) === r.id);
      return l && l.section !== '__section_header__';
    });
    const before = clone(h.lines());
    h.typeInto(row.el, 'unitCost', 4321);
    const moved = h.lines().map((l, i) => (JSON.stringify(l) === JSON.stringify(before[i]) ? null : i)).filter((i) => i !== null);
    expect(moved).toHaveLength(1);
    expect(h.lines()[moved[0]].unitCost).toBe(4321);
    h.dom.window.close();
  });

  test('js/markup-viewer.js and js/sheet-editor.js still guard on exactly these two names', () => {
    // The repair was to DEFINE the names two callers already agreed on, not
    // to edit the callers. If a caller renames its probe, this file is the
    // thing that notices before John does.
    [read('js/markup-viewer.js'), read('js/sheet-editor.js')].forEach((src) => {
      expect(src).toMatch(/estimateEditorAPI\.rerender/);
      expect(src).toMatch(/estimateEditorAPI\.currentId\(\)/);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// UNIQUENESS IS A PROPERTY OF THE CODE, NOT OF THE CLOCK
// ══════════════════════════════════════════════════════════════════════════
describe('with Date.now() frozen to a single millisecond', () => {
  function frozen() {
    const h = H.boot();
    h.w.eval('Date.now = function(){ return 1787530000000; };');
    return h;
  }

  test('two groups added back to back get DIFFERENT group ids and different line ids', () => {
    const h = frozen();
    h.hydrate({ id: 'est_open', title: 'T', defaultMarkup: 0 });
    h.open('est_open');
    h.w.estimateEditorAPI.applyAddGroup({ name: 'Option A' });
    h.w.estimateEditorAPI.applyAddGroup({ name: 'Option B' });

    const est = h.w.appData.estimates[0];
    const altIds = est.alternates.map((a) => String(a.id));
    expect(new Set(altIds).size).toBe(altIds.length);

    const ids = h.lines().map((l) => String(l.id));
    expect(new Set(ids).size).toBe(ids.length);

    // …and the consequence, not just the count: a section markup written to
    // one group must not land on the other, and removing one header must not
    // remove its twin.
    const headers = h.lines().filter((l) => l.section === '__section_header__');
    const victim = headers[headers.length - 1];
    h.w.updateSectionMarkup(String(victim.id), 99);
    expect(h.lines().filter((l) => l.markup === 99)).toHaveLength(1);
    h.dom.window.close();
  });

  test('a duplicated group clones lines into addresses of their own', () => {
    const h = frozen();
    h.hydrate({ id: 'est_open', title: 'T', defaultMarkup: 0 });
    h.open('est_open');
    h.w.estimateEditorAPI.applyBulkAddLineItems([
      { description: 'A', qty: 1, unit: 'ea', unit_cost: 10, bt_category: 'materials' },
      { description: 'B', qty: 2, unit: 'ea', unit_cost: 20, bt_category: 'labor' },
    ]);
    h.w.estimateEditorAPI.applyAddGroup({ name: 'Clone 1', copy_from_active: true });
    h.w.estimateEditorAPI.applySwitchActiveGroup({ group_id: h.w.appData.estimates[0].alternates[0].id });
    h.w.estimateEditorAPI.applyAddGroup({ name: 'Clone 2', copy_from_active: true });

    const ids = h.lines().map((l) => String(l.id));
    expect(new Set(ids).size).toBe(ids.length);
    const altIds = h.w.appData.estimates[0].alternates.map((a) => String(a.id));
    expect(new Set(altIds).size).toBe(altIds.length);
    h.dom.window.close();
  });

  test('the minter makes progress by CONSTRUCTION, not by luck', () => {
    // `do { id = mint(); } while (seen[id]);` relies on Math.random
    // eventually disagreeing with itself; the client-side version of that
    // loop was measured exhausting the heap in 39 seconds. With BOTH entropy
    // sources pinned there is none left to disagree with, so a probabilistic
    // retry cannot terminate — and a structural one still must.
    const realNow = Date.now;
    const realRandom = Math.random;
    try {
      Date.now = () => 1787530000000;
      Math.random = () => 0.5;
      const taken = Object.create(null);
      const minted = [];
      for (let i = 0; i < 500; i++) {
        const id = LID.mintId(taken);
        expect(taken[id]).toBeUndefined();
        taken[id] = true;
        minted.push(id);
      }
      expect(new Set(minted).size).toBe(500);

      // The same question asked of the walk the editors actually call.
      const lines = Array.from({ length: 500 }, (_, i) => ({ description: 'row ' + i }));
      expect(LID.ensureLineIds(lines)).toBe(500);
      expect(new Set(lines.map((l) => l.id)).size).toBe(500);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  }, 15000);
});

// ══════════════════════════════════════════════════════════════════════════
// THE HELPER ITSELF — the two invariants that keep it out of the money
// ══════════════════════════════════════════════════════════════════════════
describe('js/line-identity.js', () => {
  test('idempotent: a second heal mints nothing and changes nothing', () => {
    const lines = [{ description: 'a' }, { id: 'x', description: 'b' }, { id: 'x', description: 'c' }];
    expect(LID.ensureLineIds(lines)).toBe(2);
    const snap = clone(lines);
    expect(LID.ensureLineIds(lines)).toBe(0);
    expect(lines).toEqual(snap);
  });

  test('a minted id never lands on one a LATER row is still holding', () => {
    // Asked DETERMINISTICALLY, because asked with real entropy this is a
    // coin that never comes up tails and the test proves nothing. Pin both
    // clock and random, ask the minter what it is about to produce, then
    // hand that exact string to a LATER row. A single-pass walk gives row 0
    // the id row 1 is already holding; the two-pass walk claims row 1's
    // address first and steps past it.
    const realNow = Date.now;
    const realRandom = Math.random;
    try {
      Date.now = () => 1787530000000;
      Math.random = () => 0.5;
      const collides = LID.newLineId();
      const lines = [{ description: 'blank' }, { id: collides, description: 'holds it' }];
      LID.ensureLineIds(lines);
      expect(lines[1].id).toBe(collides);          // never re-minted
      expect(lines[0].id).not.toBe(collides);
      expect(new Set(lines.map((l) => l.id)).size).toBe(2);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  });

  test('order, length and every non-id field survive untouched', () => {
    const lines = [
      { section: '__section_header__', description: 'Materials', markup: 10 },
      { description: 'stud', qty: 10, unitCost: 4.25, markup: '' },
      { section: '__section_header__', description: 'Labor', markup: 20 },
      { description: 'framer', qty: 8, unitCost: 55, markup: 0 },
    ];
    const before = clone(lines);
    LID.ensureLineIds(lines);
    expect(lines).toHaveLength(before.length);
    expect(H.withoutIds(lines)).toEqual(H.withoutIds(before));
    expect(H.membership(lines)).toEqual(H.membership(before));
    // `markup: 0` and `markup: ''` are DIFFERENT prices — a real 0% versus
    // "inherit the section". Nothing in a heal may blur them.
    expect(lines[3].markup).toBe(0);
    expect(lines[1].markup).toBe('');
  });

  test('a non-object element is skipped, never removed', () => {
    const lines = [{ description: 'a' }, null, { description: 'b' }];
    LID.ensureLineIds(lines);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBeNull();
    expect(lines[0].id).not.toBe(lines[2].id);
  });

  test('a "constructor"-shaped id cannot masquerade as already-taken', () => {
    const lines = [{ id: 'constructor' }, { description: 'needs one' }];
    expect(() => LID.ensureLineIds(lines)).not.toThrow();
    expect(typeof lines[1].id).toBe('string');
    expect(lines[1].id).not.toBe('constructor');
  });

  test('the array guard is invisible to JSON and to Object.keys', () => {
    const host = { lines: [{ description: 'a' }] };
    LID.guardHostArray(host, 'lines');
    host.lines.push({ description: 'b' });
    expect(Object.keys(host)).toEqual(['lines']);
    expect(Object.keys(host.lines)).toEqual(['0', '1']);
    const round = JSON.parse(JSON.stringify(host));
    expect(round.lines).toHaveLength(2);
    expect(round.lines.every((l) => l.id)).toBe(true);
    expect(Array.isArray(host.lines)).toBe(true);
  });

  test('Array.prototype.push.apply STEPS OVER the guard — which is why the hydrate assigns', () => {
    // Stated rather than hidden. The own-property guard shadows the
    // prototype method; invoking the prototype method directly bypasses it.
    // js/app.js's hydrateFromServerEstimates used that exact form, and was
    // rewritten to accumulate locally and assign through the boundary.
    const host = { lines: [] };
    LID.guardHostArray(host, 'lines');
    Array.prototype.push.apply(host.lines, [{ description: 'bypassed' }]);
    expect(host.lines[0].id).toBeUndefined();
    expect(read('js/app.js')).not.toMatch(/Array\.prototype\.push\.apply\(appData\.estimateLines/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE INSTALL — the boundary has to actually be on
// ══════════════════════════════════════════════════════════════════════════
describe('the boundary is installed where it has to be', () => {
  test('js/app.js installs it the moment appData exists, BEFORE any load', () => {
    const src = read('js/app.js');
    const create = src.indexOf('window.appData = appData;');
    const install = src.indexOf("guardHostArray(appData, 'estimateLines'");
    const hydrate = src.indexOf('function hydrateFromServerEstimates');
    const localSeed = src.indexOf('function loadFromLocalStorage');
    expect(create).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(create);
    // Both doors that seed the array run AFTER the install, so neither can
    // put an unaddressed line into memory.
    expect(hydrate).toBeGreaterThan(install);
    expect(localSeed).toBeGreaterThan(install);
  });

  test("…and js/app.js's install block, RUN as written, actually guards", () => {
    // The ordering test above is a source assertion, and a source assertion
    // is satisfied by text. Wrapping the install in `if (false)` leaves every
    // string it looks for exactly where it was — which is what a mutation run
    // found: the boot install could be switched off and nothing named went
    // red. So the block is lifted out of js/app.js verbatim and EXECUTED.
    const src = read('js/app.js');
    const start = src.indexOf('// ── THE ESTIMATE-LINE STATE BOUNDARY');
    const end = src.indexOf('let appState = {', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);

    const h = H.boot();                    // p86LineIdentity present, editor never opened
    expect(h.w.appData.estimateLines.__p86Guarded).toBeUndefined();
    h.w.eval('(function(){ var appData = window.appData;\n' + block + '\n})();');

    // The assignment door heals…
    h.w.appData.estimateLines = [{ description: 'no address', qty: 1, unitCost: 5 }];
    expect(h.w.appData.estimateLines[0].id).toBeTruthy();
    // …and so does the insert door, on the array the block installed onto.
    h.w.appData.estimateLines.push({ description: 'also no address' });
    expect(h.w.appData.estimateLines[1].id).toBeTruthy();
    expect(h.w.appData.estimateLines[0].id).not.toBe(h.w.appData.estimateLines[1].id);
    // The prefixFor it passes is the estimate convention, not the default.
    h.w.appData.estimateLines.push({ section: '__section_header__', description: 'Sitework' });
    expect(String(h.w.appData.estimateLines[2].id)[0]).toBe('s');
    expect(String(h.w.appData.estimateLines[1].id)[0]).toBe('l');
    h.dom.window.close();
  });

  test('the hydrate heals BEFORE rebuildBaselines — looking at an estimate is not a write', () => {
    // Order matters for more than tidiness. rebuildBaselines() snapshots the
    // per-estimate signature that decides what gets PUSHED, and that
    // signature stringifies the lines verbatim — so an id added after it
    // marks the record dirty and turns merely opening an estimate into a
    // server write, and every read into a candidate for a stale-version
    // conflict on a record nobody edited.
    const src = read('js/app.js');
    const call = src.indexOf('hydrateFromServerEstimates(results[1].estimates)');
    const rebuild = src.indexOf('rebuildBaselines();', call);
    expect(call).toBeGreaterThan(-1);
    expect(rebuild).toBeGreaterThan(call);
  });

  test('the editor re-confirms the boundary on open, so it owns its own invariant', () => {
    const src = read('js/estimate-editor.js');
    expect(src).toMatch(/function ensureEstimateLineBoundary\(\)/);
    expect(src).toMatch(/ensureEstimateLineBoundary\(\);/);
    // And behaviourally: an array that never went through app.js is healed.
    const h = H.boot();
    h.hydrate(idStripped('est_open'));
    expect(h.lines().every((l) => l.id == null)).toBe(true);   // unguarded on the way in
    h.open('est_open');
    expect(h.lines().every((l) => l.id != null && String(l.id) !== '')).toBe(true);
    h.dom.window.close();
  });

  test('index.html loads js/line-identity.js before js/app.js and both editors', () => {
    const html = read('index.html');
    // The SCRIPT TAG, not the first mention: js/app.js is named in the
    // comment above the line-identity tag, and indexOf would find that.
    const at = (f) => html.indexOf('src="js/' + f);
    expect(at('line-identity.js')).toBeGreaterThan(-1);
    ['app.js', 'estimate-editor.js', 'change-order-editor.js'].forEach((f) => {
      expect(at(f)).toBeGreaterThan(at('line-identity.js'));
    });
  });

  test('there is ONE implementation of the walk, and the CO editor uses it', () => {
    // This repo's recurring defect is the second copy that drifts. The
    // change-order editor keeps its function NAMES (every call site and its
    // test seam still work) but not a second body.
    const co = read('js/change-order-editor.js');
    expect(co).toMatch(/function ensureLineIds\(lines\) \{ return LID\.ensureLineIds\(lines\); \}/);
    expect(co).toMatch(/function mintLineId\(taken\) \{ return LID\.mintId\(taken\); \}/);
    expect(co).toMatch(/LID\.guardHostArray\(co, 'lines'\)/);
    // No re-implementation left behind in either editor.
    expect(read('js/estimate-editor.js')).not.toMatch(/function ensureLineIds\b/);
  });

  test('the ?v tag tells the truth for every file this change touched', () => {
    ['js/line-identity.js', 'js/estimate-editor.js', 'js/change-order-editor.js', 'js/app.js']
      .forEach((f) => {
        expect(cacheBuster.report(f)).toMatchObject(cacheBuster.healthy(f));
      });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE CHANGE-ORDER SIDE OF THE SAME HOLE
// ══════════════════════════════════════════════════════════════════════════
describe('change-order editor: the lines-array hole is closed', () => {
  let editor;
  beforeAll(() => {
    // The CO editor is a browser IIFE with a __test seam; it reads
    // window.p86Pricing at call time, so the global has to exist first.
    global.window = global.window || {};
    global.window.p86Pricing = P;
    editor = require('../js/change-order-editor.js');
  });

  test('assigning co.lines AFTER adoption heals — the demonstrated escape', () => {
    const T = editor.__test;
    T.setCo({ id: 1, title: 'CO', lines: [] });
    // This is the assignment the record-level accessor could never see.
    T.getCo().lines = [
      { description: 'no address 1', qty: 1, unitCost: 10 },
      { description: 'no address 2', qty: 2, unitCost: 20 },
      { id: 'dup', description: 'a' },
      { id: 'dup', description: 'b' },
    ];
    const lines = T.getCo().lines;
    expect(lines.every((l) => l.id != null && String(l.id) !== '')).toBe(true);
    expect(new Set(lines.map((l) => String(l.id))).size).toBe(4);
    expect(lines.map((l) => l.description))
      .toEqual(['no address 1', 'no address 2', 'a', 'b']);
  });

  test('pushing onto co.lines heals — the other half of the same hole', () => {
    const T = editor.__test;
    T.setCo({ id: 1, title: 'CO', lines: [{ id: 'a', description: 'kept' }] });
    T.getCo().lines.push({ description: 'pushed, unaddressed', qty: 1, unitCost: 5 });
    T.getCo().lines.splice(1, 0, { description: 'spliced, unaddressed' });
    const lines = T.getCo().lines;
    expect(lines.every((l) => l.id != null && String(l.id) !== '')).toBe(true);
    expect(new Set(lines.map((l) => String(l.id))).size).toBe(lines.length);
    expect(lines[0].id).toBe('a');           // an existing address is never re-minted
    expect(lines.map((l) => l.description))
      .toEqual(['kept', 'spliced, unaddressed', 'pushed, unaddressed']);
  });

  test('the CO record still serialises exactly as it did', () => {
    const T = editor.__test;
    T.setCo({ id: 7, title: 'CO', targetMargin: 20, lines: [{ id: 'a', qty: 1, unitCost: 3 }] });
    const round = JSON.parse(JSON.stringify(T.getCo()));
    expect(round).toMatchObject({ id: 7, title: 'CO', targetMargin: 20 });
    expect(round.lines).toEqual([{ id: 'a', qty: 1, unitCost: 3 }]);
  });
});
