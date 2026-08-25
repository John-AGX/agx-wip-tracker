// test/explode-decision-survives-the-dialog.test.js
//
// THE RECORD EITHER GETS EXACTLY THE ACTION THAT WAS QUOTED, OR NOTHING AT
// ALL AND THE PERSON IS TOLD.
//
// 55bfc689 made "Explode to editable lines" replace the rollup with its parts
// or do nothing and say why. It decided that BEFORE p86Confirm and acted on it
// AFTER. p86Confirm is a DOM overlay — it does not block JavaScript — so the
// decision and the mutation are separated by an unbounded amount of time in
// which the record can change, and every number the dialog quoted was computed
// on the near side of that gap.
//
// This is the same class this codebase has paid for repeatedly: A DECISION
// COMPUTED ONCE AND CONSUMED LATER, WITH NOTHING GUARANTEEING THE WORLD HELD
// STILL. The properties below are about the GAP, not about any one way of
// crossing it, which is why the interleavings are enumerated rather than
// exampled.
//
//   P1  THE QUOTE OR NOTHING   — for ANY interleaving of a record change and
//                                the confirm, the record either gets exactly
//                                the action that was quoted, or is
//                                BYTE-IDENTICAL to before and the person was
//                                told. Never a third thing.
//   P2  NO SWALLOWED ERROR     — a partial failure is never reported as
//                                success. The bulk adders carry their failures
//                                out, and the explode undoes itself and says so.
//   P3  A CREDIT IS REFUSED BY NAME — not as a side effect of what survives
//                                the `qty > 0` filter.
//   P4  A STORED HOLE CANNOT THROW  — a null inside assemblyBreakdown paints
//                                and explodes; it never freezes the table.
//   P5  THE SENTENCE IS THE ACTION  — the dialog names every line the action
//                                creates, INCLUDING the section headers that
//                                routing find-or-creates.
//   P6  NOTHING THAT WORKED CHANGES — against the PRIOR bytes, an explode on a
//                                record that did NOT move produces a
//                                byte-identical result.
//
// WHY THE PRIOR BLOBS ARE LOADED. Each property is asserted RED against
// 8aef6d8d — the bytes on main when this was written — rather than described
// as having been red. A suite that only passes is not evidence; a suite that
// passes and cannot be shown to fail is the third trap this repo hit today (a
// test that read a key which only exists after the fix). Every property below
// runs the SAME driver over both blobs and asserts the old one fails it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const P = require('../js/pricing-pipeline.js');
const H = require('./helpers/estimate-editor-harness.js');

const PRIOR_SHA = '8aef6d8d';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');
}
function prior(rel) {
  try {
    return execFileSync('git', ['show', PRIOR_SHA + ':' + rel],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .split('\r\n').join('\n');
  } catch (e) { return null; }
}
const NOW_COE = read('js/change-order-editor.js');
const OLD_COE = prior('js/change-order-editor.js');
const OLD_EE = prior('js/estimate-editor.js');

// The prior estimate editor has to be a FILE for the harness to load it as a
// <script>, and it must not land anywhere inside the shared working tree.
let OLD_EE_FILE = null;
if (OLD_EE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-prior-ee-'));
  OLD_EE_FILE = path.join(d, 'estimate-editor.js');
  fs.writeFileSync(OLD_EE_FILE, OLD_EE);
}

// ══════════════════════════════════════════════════════════════════════
// THE CHANGE-ORDER EDITOR, ASSEMBLED FROM ITS OWN BYTES.
//
// Lifted verbatim by anchor, the shape test/explode-replaces-or-refuses.js
// established: nothing here re-expresses the routing, the section
// find-or-create, the adder or the explode, because a harness that models the
// thing under test agrees with itself and sees nothing.
//
// `confirm` is left PENDING rather than answered inline — that gap IS the
// defect, and a harness whose confirm resolves synchronously cannot contain it.
// ══════════════════════════════════════════════════════════════════════
function coEditor(src) {
  const cut = (a, b, optional) => {
    const i = src.indexOf(a);
    if (i < 0) { if (optional) return ''; throw new Error('anchor not found: ' + a); }
    const j = src.indexOf(b, i);
    if (j < 0) throw new Error('close anchor not found for: ' + a);
    return src.slice(i, j + b.length);
  };
  const body = [
    cut('  function fmtCurrency(n) {', '\n  }\n'),
    cut('  function computeTotals() {', '\n  }\n'),
    cut('  var CO_BUCKET_SECTION', ';\n'),
    cut('  function coNum(v) {', '\n'),
    cut('  var CO_BUCKETS =', ';\n'),
    cut('  function coBucketFor(input) {', '\n  }\n'),
    cut('  function coEnsureSection(bucket) {', '\n  }\n'),
    cut('  function coApplyAddLineItem(input) {', '\n  }\n'),
    cut('  function coApplyBulkAddLineItems(specs) {', '\n  }\n'),
    // Present only after the repair; absent from the prior blob.
    cut('  function coNotice(title, message) {', '\n  }\n', true),
    cut('  function coAsmRecipeRows(line) {', '\n  }\n', true),
    cut('  function coAsmStripHTML(line) {', '\n  }\n'),
    cut('  function coAsmExplode(lineId) {', '    } else if (confirm(msg)) doIt();\n  }\n'),
  ].join('\n');
  if (body.length < 8000) throw new Error('lift too small — anchors matched nothing: ' + body.length);
  // eslint-disable-next-line no-new-func
  const build = new Function('window', 'env', `
    var _state = { co: null };
    var _coAsmOpen = {};
    var _seq = 0;
    function newLineId() { return 'gen_' + (++_seq); }
    function markDirty() { env.dirty++; }
    function paintLines() { env.paints++; }
    function paintTotals() { env.totals++; }
    function alert(m) { env.natives.push(String(m)); }
    function escapeAttr(s) { return String(s == null ? '' : s); }
    function escapeHTML(s) { return String(s == null ? '' : s); }
${body}
    return {
      setCo: function (c) { _state.co = c; },
      getCo: function () { return _state.co; },
      reset: function () { _coAsmOpen = {}; _seq = 0; },
      setOpen: function (id, v) { _coAsmOpen[id] = v; },
      strip: coAsmStripHTML,
      bulk: coApplyBulkAddLineItems,
      explode: coAsmExplode,
      totals: computeTotals
    };
  `);
  const env = { dirty: 0, paints: 0, totals: 0, natives: [] };
  const state = { pending: null, message: null, notices: [] };
  const win = {
    p86Pricing: P,
    // THE DIALOG IS RAISED AND LEFT OPEN. `.then` stores the resolver instead
    // of calling it, which is exactly what the real overlay does while the
    // person is reading it.
    p86Confirm: (opt) => {
      state.message = opt.message;
      return { then: (f) => { state.pending = f; } };
    },
    p86Alert: (opt) => { state.notices.push(opt && opt.message ? String(opt.message) : String(opt)); },
  };
  const ed = build(win, env);
  return {
    env, state, ed,
    // Raise the dialog on `co`, run `mutate` while it is open, then answer it.
    run(co, lineId, mutate) {
      state.pending = null; state.message = null; state.notices = [];
      env.dirty = 0; env.paints = 0; env.totals = 0; env.natives = [];
      ed.reset();
      const input = JSON.stringify(co);
      const live = JSON.parse(input);
      ed.setCo(live);
      let raiseThrew = null;
      try { ed.explode(lineId); } catch (e) { raiseThrew = e.message; }
      if (!state.pending) {
        return { raised: false, raiseThrew, refused: state.notices.length > 0 || env.natives.length > 0,
          why: state.notices[0] || env.natives[0] || null, record: ed.getCo(), input,
          unchanged: JSON.stringify(ed.getCo()) === input, dirty: env.dirty };
      }
      // raiseThrew is reported on BOTH branches. Reporting it only on the
      // no-dialog branch is how a test asserting "it did not throw on the way
      // in" reads `undefined` and passes without looking at anything.
      const message = state.message;
      const target = mutate ? mutate(ed, live) : live;
      let threw = null;
      try { state.pending(true); } catch (e) { threw = (e && e.message) || String(e); }
      const record = target === null ? null : (target || ed.getCo());
      return {
        raised: true, message, threw, raiseThrew,
        told: state.notices.length > 0 || env.natives.length > 0,
        notice: state.notices[state.notices.length - 1] || env.natives[0] || null,
        record,
        unchanged: record != null && JSON.stringify(record) === input,
        input, dirty: env.dirty,
      };
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// FIXTURES
// ══════════════════════════════════════════════════════════════════════
function coFixture(over) {
  const f = {
    id: 'co_A', title: 'CO A', defaultMarkup: 20,
    lines: [
      { id: 'h0', section: '__section_header__', label: 'MATERIALS', btCategory: 'materials',
        markup: 15, markupMode: 'percent' },
      { id: 'o1', description: 'Existing line', qty: 2, unitCost: 100, markup: '', markupMode: 'percent' },
      { id: 'ROLLUP', description: 'Pool cage package', qty: 2, unitCost: 1000, unit: 'ea',
        markup: '', markupMode: 'percent', sourceAssemblyId: 41,
        assemblyBreakdown: [
          { description: 'Extrusion', qty_per_unit: 1, unit_cost: 600, cost_code: 'materials', unit: 'ea' },
          { description: 'Crew day', qty_per_unit: 2, unit_cost: 200, cost_code: 'labor', unit: 'HR' },
        ] },
    ],
  };
  return Object.assign(f, over || {});
}
function eeFixture(id, altId) {
  return {
    id: id, title: 'Est ' + id, activeAlternateId: altId,
    alternates: [{ id: altId, name: 'Base Bid' }], defaultMarkup: 20,
    lines: [
      { id: 's1', estimateId: id, alternateId: altId, section: '__section_header__',
        description: 'Materials & Supplies Costs', markup: 15, markupMode: 'percent' },
      { id: 'o1', estimateId: id, alternateId: altId, description: 'Existing line',
        qty: 2, unitCost: 100, markup: '' },
      { id: 'R', estimateId: id, alternateId: altId, description: 'Pool cage package',
        qty: 2, unitCost: 1000, unit: 'ea', markup: '', sourceAssemblyId: 41,
        assemblyBreakdown: [
          { description: 'Extrusion', qty_per_unit: 1, unit_cost: 600, cost_code: 'materials', unit: 'ea' },
          { description: 'Crew day', qty_per_unit: 2, unit_cost: 200, cost_code: 'labor', unit: 'HR' },
        ] },
    ],
  };
}

// EVERY WAY THE WORLD MOVES WHILE THE BOX IS OPEN.
//
// Each returns the record whose CONTENT is the thing to judge afterwards, or
// null when the editor is gone. The routes are named for what actually reaches
// them in the app, not for the mechanic:
//
//   background hydrate  — js/ai-panel.js wirePayloadApplied → p86Refresh
//                         .fromTargets → p86ReloadAllData → loadData(). Fires
//                         on ANY job-or-estimate write landing: an 86/Scribe
//                         write, Live Writer auto-applying, an agent job
//                         draining. Also the online / visibilitychange
//                         load-recovery paths in js/app.js.
//   reprice             — coAsmRefresh's own fetch().then(), no network event
//                         needed beyond the one the person started.
//   editor closed       — navigation, a deep link, a notification.
//   second record       — reachable programmatically; the worst outcome.
const CO_INTERLEAVINGS = [
  ['editor closed', (ed) => { ed.setCo(null); return null; }],
  ['background hydrate: same CO, fresh objects', (ed, live) => {
    const fresh = JSON.parse(JSON.stringify(live)); ed.setCo(fresh); return fresh; }],
  ['background hydrate: lines array replaced', (ed, live) => {
    live.lines = JSON.parse(JSON.stringify(live.lines)); return live; }],
  ['a second change order opened', (ed) => {
    const b = coFixture({ id: 'co_B', title: 'CO B' });
    b.lines = b.lines.filter((l) => l.id !== 'ROLLUP');
    ed.setCo(b); return b; }],
  ['the rollup itself deleted', (ed, live) => {
    live.lines = live.lines.filter((l) => l.id !== 'ROLLUP'); return live; }],
  ['a reprice lands', (ed, live) => {
    const l = live.lines.find((x) => x.id === 'ROLLUP');
    l.unitCost = 5000;
    l.assemblyBreakdown = [{ description: 'NEW', qty_per_unit: 1, unit_cost: 5000, cost_code: 'sub', unit: 'ea' }];
    return live; }],
  ['an unrelated line deleted', (ed, live) => {
    live.lines = live.lines.filter((l) => l.id !== 'o1'); return live; }],
  ['an unrelated line repriced', (ed, live) => {
    live.lines.find((l) => l.id === 'o1').unitCost = 999; return live; }],
  // THE ONE THE OUTCOME COMPARISON CANNOT SEE.
  //
  // The rollup is REMOVED by the explode, so its own unit cost does not appear
  // anywhere in the post-explode record — two simulations either side of a
  // change to it produce byte-identical answers. But the dialog quoted a
  // "moving the change order total from $X to $Y" sentence whose $X was priced
  // WITH that cost, and on a promised line that sentence is the only number
  // the person is given. Only the rollup's own fingerprint catches this.
  ['the rollup is repriced but the recipe is not', (ed, live) => {
    live.lines.find((l) => l.id === 'ROLLUP').unitCost = 9999; return live; }],
];

// EVERY ROW CARRIES ALL THREE COLUMNS, INCLUDING THE ONES THAT DO NOT NEED A
// SECOND RECORD. jest's `each` decides a test is callback-style when the
// function's arity exceeds the row's length, so a two-column row against a
// three-parameter test hands `second` the `done` callback and the test hangs
// for five seconds and then "fails" for a reason that has nothing to do with
// the code. Measured: six of these silently became timeouts.
const EE_INTERLEAVINGS = [
  ['editor closed', (h) => { h.w.closeEstimateEditor(); }, false],
  ['appData.estimates emptied', (h) => { h.w.appData.estimates = []; }, false],
  ['est.alternates emptied', (h) => { h.w.appData.estimates[0].alternates = []; }, false],
  ['background hydrate: estimateLines replaced wholesale', (h) => {
    h.w.appData.estimateLines = JSON.parse(JSON.stringify(h.w.appData.estimateLines)); }, false],
  ['a different estimate opened', (h) => { h.w.openEstimateEditor('est_2'); }, true],
  ['an unrelated line deleted', (h) => {
    const a = h.w.appData.estimateLines; a.splice(a.findIndex((l) => l.id === 'o1'), 1); }, false],
  ['a reprice lands', (h) => {
    const l = h.w.appData.estimateLines.find((x) => x.id === 'R');
    l.unitCost = 5000;
    l.assemblyBreakdown = [{ description: 'NEW', qty_per_unit: 1, unit_cost: 5000, cost_code: 'sub', unit: 'ea' }]; }, false],
];

// Drive the ESTIMATE editor through its real click path with the confirm left
// pending. Returns what the record looks like on the far side.
function eeRun(mutate, opts) {
  const o = opts || {};
  const h = H.boot(o.editorFile ? { editorFile: o.editorFile } : {});
  const notices = [];
  h.w.p86Alert = (x) => { notices.push(x && x.message ? String(x.message) : String(x)); };
  let pending = null, message = null;
  h.w.p86Confirm = (opt) => { message = opt.message; return { then: (f) => { pending = f; } }; };
  const records = [eeFixture('est_1', 'a1')];
  if (o.second) records.push(eeFixture('est_2', 'a2'));
  h.hydrate(records);
  h.open('est_1');
  const mine = () => JSON.stringify(h.w.appData.estimateLines.filter((l) => l && l.estimateId === 'est_1'));
  const others = () => JSON.stringify(h.w.appData.estimateLines.filter((l) => l && l.estimateId !== 'est_1'));
  const before = mine();
  const othersBefore = others();
  let raiseThrew = null;
  try { h.w.eeAsmExplode(o.lineId || 'R'); } catch (e) { raiseThrew = e.message; }
  if (!pending) {
    const out = { raised: false, raiseThrew, refused: notices.length > 0,
      why: notices[0] || null, unchanged: mine() === before, message: null };
    h.w.close(); return out;
  }
  if (mutate) { try { mutate(h); } catch (e) { /* the mutation itself may throw; the record is what matters */ } }
  let threw = null;
  try { pending(true); } catch (e) { threw = (e && e.message) || String(e); }
  const out = {
    raised: true, message, threw,
    told: notices.length > 0,
    notice: notices[notices.length - 1] || null,
    unchanged: mine() === before,
    othersUntouched: others() === othersBefore,
    lines: JSON.parse(mine()),
    before: JSON.parse(before),
  };
  h.w.close();
  return out;
}

afterAll(() => H.closeAll());

// ══════════════════════════════════════════════════════════════════════
// 0 — THE PIN. The prior bytes load and carry the defects.
// ══════════════════════════════════════════════════════════════════════
describe('the pin holds', () => {
  test('the prior blobs load', () => {
    expect(typeof OLD_COE).toBe('string');
    expect(typeof OLD_EE).toBe('string');
    expect(OLD_EE_FILE).toBeTruthy();
  });
  test('the prior change-order bulk adder discards every failure', () => {
    // Scoped to the FUNCTION, not the file: `catch (e) {}` appears elsewhere in
    // change-order-editor.js for reasons that are nothing to do with this, and
    // a file-wide assertion would be measuring the wrong bytes.
    const bodyOf = (src) => {
      const i = src.indexOf('  function coApplyBulkAddLineItems(specs) {');
      return src.slice(i, src.indexOf('\n  }\n', i));
    };
    expect(bodyOf(OLD_COE)).toContain('catch (e) {}');
    expect(bodyOf(OLD_COE)).not.toContain('errors');
    expect(bodyOf(NOW_COE)).not.toContain('catch (e) {}');
    expect(bodyOf(NOW_COE)).toContain('out.errors.push');
  });
  test('the prior explodes decided before the dialog and never re-checked', () => {
    // The pre-dialog refusal existed; the post-dialog one did not.
    expect(OLD_COE).toContain('THE RECORD IS UNTOUCHED');
    expect(OLD_COE).not.toContain('stillQuoted');
    expect(OLD_EE).not.toContain('stillQuoted');
  });

  // ── AN UNCOVERED PATH, NAMED ──────────────────────────────────────────
  //
  // Both explodes undo themselves if the bulk add partially fails. That branch
  // is NOT REACHABLE BEHAVIOURALLY from any input the app can produce, and it
  // is pinned here as source rather than asserted as behaviour, which is the
  // honest way round.
  //
  // Why unreachable: coApplyAddLineItem's ONLY throw is `!_state.co`, and
  // applyAddLineItem's only two are `!getEstimate()` and `!getActiveAlternate()`
  // — and all three of those are conditions `stillQuoted()` has already refused
  // on, before either splice runs. So with the guard in place nothing can get
  // as far as a half-finished explode. Mutation confirms it: removing the undo
  // (M4) and silencing it (M16) both leave the behavioural suite fully green.
  //
  // It is kept because the guard is a heuristic over an unbounded set of
  // interleavings and the undo is what holds the property if the guard ever
  // misses one — and because the estimate adder is the one that grew two extra
  // throws since it was written, which is exactly how this became a defect the
  // first time. A pin cannot prove it works; it can stop it disappearing
  // without anyone deciding to remove it.
  test('both explodes still carry the undo, and both still report it', () => {
    const NOW_EE = read('js/estimate-editor.js');
    [['change order', NOW_COE], ['estimate', NOW_EE]].forEach(([, src]) => {
      expect(src).toContain('var failed = (res && res.errors) || [];');
      expect(src).toContain('if (failed.length) {');
      expect(src).toContain('Array.prototype.push.apply(');
      expect(src).toContain("'Nothing was exploded',");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// P1 — THE QUOTE OR NOTHING.
// ══════════════════════════════════════════════════════════════════════
describe('P1 the record gets exactly the quoted action, or nothing and a reason', () => {
  const contentOf = (rec) => (rec.lines || []).filter((l) => l.section !== '__section_header__');

  test('CHANGE ORDER — the control explodes, and it is the quote', () => {
    const ed = coEditor(NOW_COE);
    const r = ed.run(coFixture(), 'ROLLUP', null);
    expect(r.raised).toBe(true);
    expect(r.threw).toBeNull();
    expect(r.told).toBe(false);
    // The rollup is gone and exactly its two components are there.
    const descs = contentOf(r.record).map((l) => l.description);
    expect(descs).toEqual(['Existing line', 'Extrusion', 'Crew day']);
    expect(r.dirty).toBe(1);
  });

  test.each(CO_INTERLEAVINGS)('CHANGE ORDER — %s: the record is untouched and the person is told', (name, mutate) => {
    const ed = coEditor(NOW_COE);
    const r = ed.run(coFixture(), 'ROLLUP', mutate);
    expect(r.raised).toBe(true);
    // NEVER an unhandled throw. A dead click with no message is not a refusal.
    expect(r.threw).toBeNull();
    if (r.record === null) {
      // The editor is gone; there is no record left to damage. It must still
      // have said something rather than failing silently.
      expect(r.told).toBe(true);
      return;
    }
    // Whatever moved, the explode contributed NOTHING: no rollup removed with
    // nothing put back, no parts added on top of a kept rollup, no parts
    // landing on another record.
    const descs = contentOf(r.record).map((l) => l.description);
    expect(descs).not.toContain('Extrusion');
    expect(descs).not.toContain('Crew day');
    expect(r.told).toBe(true);
    expect(r.dirty).toBe(0);
  });

  test.each(CO_INTERLEAVINGS)('CHANGE ORDER — %s: the PRIOR bytes fail this', (name, mutate) => {
    const ed = coEditor(OLD_COE);
    const r = ed.run(coFixture(), 'ROLLUP', mutate);
    const bad =
      r.threw != null ||                                       // unhandled throw
      (r.record != null &&
        contentOf(r.record).map((l) => l.description).some((d) => d === 'Extrusion' || d === 'Crew day')) ||
      (r.record != null && !r.told && r.dirty === 0 && r.unchanged === false);
    expect(bad).toBe(true);
  });

  test('CHANGE ORDER — a second record NEVER receives the components', () => {
    const now = coEditor(NOW_COE).run(coFixture(), 'ROLLUP', CO_INTERLEAVINGS[3][1]);
    expect((now.record.lines || []).map((l) => l.description)).not.toContain('Extrusion');
    // And the prior bytes DID write into it — that is the defect, pinned.
    const old = coEditor(OLD_COE).run(coFixture(), 'ROLLUP', CO_INTERLEAVINGS[3][1]);
    expect((old.record.lines || []).map((l) => l.description)).toContain('Extrusion');
  });

  test('ESTIMATE — the control explodes, and it is the quote', () => {
    const r = eeRun(null);
    expect(r.raised).toBe(true);
    expect(r.threw).toBeNull();
    expect(r.told).toBe(false);
    const descs = r.lines.filter((l) => l.section !== '__section_header__').map((l) => l.description);
    expect(descs).toEqual(['Existing line', 'Extrusion', 'Crew day']);
  });

  test.each(EE_INTERLEAVINGS)('ESTIMATE — %s: the record is untouched and the person is told', (name, mutate, second) => {
    const r = eeRun(mutate, { second: !!second });
    expect(r.raised).toBe(true);
    expect(r.threw).toBeNull();
    const descs = r.lines.filter((l) => l.section !== '__section_header__').map((l) => l.description);
    expect(descs).not.toContain('Extrusion');
    expect(descs).not.toContain('Crew day');
    // THE ROLLUP IS STILL THERE. This is the destroy-with-nothing case: the
    // splice ran, the add threw into a swallow, and the record lost a line.
    expect(descs).toContain('Pool cage package');
    expect(r.told).toBe(true);
    if (second) expect(r.othersUntouched).toBe(true);
  });

  test.each(EE_INTERLEAVINGS)('ESTIMATE — %s: the PRIOR bytes fail this', (name, mutate, second) => {
    const r = eeRun(mutate, { second: !!second, editorFile: OLD_EE_FILE });
    const descs = r.lines.filter((l) => l.section !== '__section_header__').map((l) => l.description);
    const destroyed = !descs.includes('Pool cage package') && !descs.includes('Extrusion');
    const duplicated = descs.includes('Pool cage package') && descs.includes('Extrusion');
    const crossWrote = second && !r.othersUntouched;
    const silent = !r.told;
    expect(destroyed || duplicated || crossWrote || silent).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// P2 — NO ERROR IS SWALLOWED ON A PATH THAT REPORTS SUCCESS.
// ══════════════════════════════════════════════════════════════════════
describe('P2 a partial failure is never reported as success', () => {
  test('CHANGE ORDER — the bulk adder carries its failures out', () => {
    const ed = coEditor(NOW_COE);
    ed.ed.setCo(coFixture());
    // A spec the adder cannot place: coApplyAddLineItem's only throw is the
    // absent record, so the failure is produced the way the app produces it.
    ed.ed.setCo(null);
    const res = ed.ed.bulk([{ description: 'Extrusion', qty: 2, unit_cost: 600, cost_code: 'materials' }]);
    expect(Array.isArray(res)).toBe(true);
    expect(res.errors).toBeDefined();
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain('Extrusion');
  });

  test('CHANGE ORDER — the PRIOR bulk adder reports nothing at all', () => {
    const ed = coEditor(OLD_COE);
    ed.ed.setCo(null);
    const res = ed.ed.bulk([{ description: 'Extrusion', qty: 2, unit_cost: 600, cost_code: 'materials' }]);
    expect(res.length).toBe(0);
    expect(res.errors).toBeUndefined();   // the failure was discarded entirely
  });

  test('ESTIMATE — the bulk adder carries its failures out', () => {
    const h = H.boot();
    h.hydrate([eeFixture('est_1', 'a1')]);
    h.open('est_1');
    h.w.appData.estimates = [];          // → applyAddLineItem throws 'No estimate open.'
    const res = h.w.estimateEditorAPI.applyBulkAddLineItems([
      { description: 'Extrusion', qty: 2, unit_cost: 600, section_name: 'Materials & Supplies Costs' },
    ]);
    expect(res.errors).toBeDefined();
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain('Extrusion');
    h.w.close();
  });

  test('ESTIMATE — the PRIOR bulk adder discards the list it built', () => {
    const h = H.boot({ editorFile: OLD_EE_FILE });
    h.hydrate([eeFixture('est_1', 'a1')]);
    h.open('est_1');
    h.w.appData.estimates = [];
    const res = h.w.estimateEditorAPI.applyBulkAddLineItems([
      { description: 'Extrusion', qty: 2, unit_cost: 600, section_name: 'Materials & Supplies Costs' },
    ]);
    expect(res.errors).toBeUndefined();
    h.w.close();
  });

  test('an empty batch still answers in the same shape', () => {
    const ed = coEditor(NOW_COE);
    ed.ed.setCo(coFixture());
    const res = ed.ed.bulk([]);
    expect(Array.isArray(res)).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test('the returned value is still an ARRAY OF STRINGS for the drawer', () => {
    // js/materials-drawer.js treats this as the target contract's 4th method
    // and ignores the value; test/estimate-line-addressability.test.js reads
    // it as summaries. Attaching .errors may not have changed either.
    const ed = coEditor(NOW_COE);
    ed.ed.setCo(coFixture());
    const res = ed.ed.bulk([
      { description: 'A', qty: 1, unit_cost: 10, cost_code: 'materials' },
      { description: 'B', qty: 1, unit_cost: 20, cost_code: 'labor' },
    ]);
    expect(res.length).toBe(2);
    expect(res.every((s) => typeof s === 'string')).toBe(true);
    expect(res.join(' ')).toContain('Added');
  });
});

// ══════════════════════════════════════════════════════════════════════
// P3 — A CREDIT IS REFUSED BY NAME.
// ══════════════════════════════════════════════════════════════════════
describe('P3 a credit is refused by name, whatever the recipe signs are', () => {
  // Every combination of signs a recipe can carry under a NEGATIVE rollup
  // quantity. The middle rows are the ones `!specs.length` never caught,
  // because a negative × a negative survives the `qty > 0` filter.
  const RECIPES = [
    ['all rows positive', [1, 2]],
    ['ONE row negative', [-1, 2]],
    ['EVERY row negative', [-1, -2]],
    ['negative and a zero', [-1, 0]],
  ];
  const build = (signs) => {
    const f = coFixture();
    const roll = f.lines.find((l) => l.id === 'ROLLUP');
    roll.qty = -2;
    roll.assemblyBreakdown = signs.map((q, i) => ({
      description: 'comp' + i, qty_per_unit: q, unit_cost: 600,
      cost_code: i === 0 ? 'materials' : 'labor', unit: 'ea',
    }));
    roll.unitCost = roll.assemblyBreakdown.reduce((s, b) => s + b.qty_per_unit * b.unit_cost, 0);
    return f;
  };

  test.each(RECIPES)('CHANGE ORDER — %s: refused, record untouched, money unmoved', (name, signs) => {
    const ed = coEditor(NOW_COE);
    const f = build(signs);
    const r = ed.run(f, 'ROLLUP', null);
    expect(r.raised).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.why).toMatch(/credit line/i);
    expect(r.unchanged).toBe(true);
  });

  test.each(RECIPES.slice(1, 3))('CHANGE ORDER — %s: the PRIOR bytes exploded it anyway', (name, signs) => {
    const ed = coEditor(OLD_COE);
    const f = build(signs);
    const r = ed.run(f, 'ROLLUP', null);
    expect(r.raised).toBe(true);                  // it did NOT refuse
    expect(r.message.indexOf('$')).toBe(-1);      // and said nothing about money
    // THE SIGN INVERSION, stated without depending on what the record's own
    // total happened to be: a rollup at qty −2 produced content lines carrying
    // POSITIVE quantities. That is a deduction turning into a charge, and it
    // is the whole defect.
    const created = (r.record.lines || []).filter((l) => String(l.id).indexOf('gen_') === 0
      && l.section !== '__section_header__');
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((l) => l.qty > 0)).toBe(true);
    // …and the rollup it replaced was negative.
    expect(f.lines.find((l) => l.id === 'ROLLUP').qty).toBeLessThan(0);
  });

  test('ESTIMATE — a credit with a negative recipe row is refused by name', () => {
    const h = H.boot();
    const notices = [];
    h.w.p86Alert = (x) => notices.push(String(x.message || x));
    const rec = eeFixture('est_1', 'a1');
    const roll = rec.lines.find((l) => l.id === 'R');
    roll.qty = -2;
    roll.assemblyBreakdown = [
      { description: 'Extrusion', qty_per_unit: -1, unit_cost: 600, cost_code: 'materials', unit: 'ea' },
      { description: 'Crew day', qty_per_unit: 2, unit_cost: 200, cost_code: 'labor', unit: 'HR' },
    ];
    h.hydrate([rec]); h.open('est_1');
    const before = JSON.stringify(h.w.appData.estimateLines);
    let raised = false;
    h.w.p86Confirm = () => { raised = true; return { then() {} }; };
    h.w.eeAsmExplode('R');
    expect(raised).toBe(false);
    expect(notices[0]).toMatch(/credit line/i);
    expect(JSON.stringify(h.w.appData.estimateLines)).toBe(before);
    h.w.close();
  });

  test('ESTIMATE — the PRIOR bytes exploded that same credit', () => {
    const h = H.boot({ editorFile: OLD_EE_FILE });
    h.w.p86Alert = () => {};
    const rec = eeFixture('est_1', 'a1');
    const roll = rec.lines.find((l) => l.id === 'R');
    roll.qty = -2;
    roll.assemblyBreakdown = [
      { description: 'Extrusion', qty_per_unit: -1, unit_cost: 600, cost_code: 'materials', unit: 'ea' },
      { description: 'Crew day', qty_per_unit: 2, unit_cost: 200, cost_code: 'labor', unit: 'HR' },
    ];
    h.hydrate([rec]); h.open('est_1');
    let raised = false;
    h.w.p86Confirm = () => { raised = true; return { then(f) { f(true); } }; };
    h.w.eeAsmExplode('R');
    expect(raised).toBe(true);
    h.w.close();
  });

  test('an ORDINARY rollup is still exploded — the guard did not swallow the feature', () => {
    const ed = coEditor(NOW_COE);
    const r = ed.run(coFixture(), 'ROLLUP', null);
    expect(r.raised).toBe(true);
    expect(r.refused).toBeFalsy();
  });
});

// ══════════════════════════════════════════════════════════════════════
// P4 — A STORED HOLE CANNOT THROW.
// ══════════════════════════════════════════════════════════════════════
describe('P4 a null inside assemblyBreakdown paints and explodes', () => {
  const holed = () => {
    const f = coFixture();
    f.lines.find((l) => l.id === 'ROLLUP').assemblyBreakdown.splice(1, 0, null);
    return f;
  };

  test('CHANGE ORDER — the OPEN strip paints, and the prior bytes threw', () => {
    const now = coEditor(NOW_COE);
    now.ed.setCo(holed());
    now.ed.setOpen('ROLLUP', true);
    const line = now.ed.getCo().lines.find((l) => l.id === 'ROLLUP');
    expect(() => now.ed.strip(line)).not.toThrow();
    // The hole is SKIPPED, not removed: the record still holds it.
    expect(now.ed.getCo().lines.find((l) => l.id === 'ROLLUP').assemblyBreakdown.length).toBe(3);
    expect(now.ed.strip(line)).toContain('2 components');

    const old = coEditor(OLD_COE);
    old.ed.setCo(holed());
    old.ed.setOpen('ROLLUP', true);
    expect(() => old.ed.strip(old.ed.getCo().lines.find((l) => l.id === 'ROLLUP'))).toThrow();
  });

  test('CHANGE ORDER — the explode reaches its dialog, and the prior bytes threw', () => {
    const now = coEditor(NOW_COE);
    const r = now.run(holed(), 'ROLLUP', null);
    expect(r.raiseThrew).toBeNull();
    expect(r.raised).toBe(true);

    const old = coEditor(OLD_COE);
    const o = old.run(holed(), 'ROLLUP', null);
    expect(o.raiseThrew).not.toBeNull();
  });

  test('ESTIMATE — opening the strip does not throw, and the prior bytes did', () => {
    const withHole = () => {
      const rec = eeFixture('est_1', 'a1');
      rec.lines.find((l) => l.id === 'R').assemblyBreakdown.splice(1, 0, null);
      return rec;
    };
    const now = H.boot();
    now.hydrate([withHole()]); now.open('est_1');
    expect(() => now.w.eeToggleAsmBreakdown('R')).not.toThrow();
    now.w.close();

    const old = H.boot({ editorFile: OLD_EE_FILE });
    old.hydrate([withHole()]); old.open('est_1');
    expect(() => old.w.eeToggleAsmBreakdown('R')).toThrow();
    old.w.close();
  });
});

// ══════════════════════════════════════════════════════════════════════
// P5 — THE SENTENCE IS THE ACTION.
// ══════════════════════════════════════════════════════════════════════
describe('P5 the dialog names every line the action creates', () => {
  const COUNT_RE = /\binto (\d+) editable lines?\?/;

  test('CHANGE ORDER — the content count matches, and new sections are named', () => {
    const ed = coEditor(NOW_COE);
    const before = coFixture();
    const hdrBefore = before.lines.filter((l) => l.section === '__section_header__').length;
    const r = ed.run(before, 'ROLLUP', null);
    const quoted = Number(r.message.match(COUNT_RE)[1]);
    const content = r.record.lines.filter((l) => l.section !== '__section_header__');
    const created = content.filter((l) => String(l.id).indexOf('gen_') === 0);
    expect(created.length).toBe(quoted);
    // The action added a Labor section the fixture did not have.
    const hdrAfter = r.record.lines.filter((l) => l.section === '__section_header__').length;
    expect(hdrAfter).toBe(hdrBefore + 1);
    // …and the sentence says so, by name.
    expect(r.message).toMatch(/adds 1 new section/);
    // The name the SECTION is created with (CO_BUCKET_SECTION), not the badge
    // the strip prints (CO_BUCKET_LABEL). Those are two different maps and the
    // sentence must quote the one the record will actually carry.
    expect(r.message).toContain('Labor');
    const newHdr = r.record.lines.find((l) => l.section === '__section_header__' && l.label === 'Labor');
    expect(newHdr).toBeTruthy();
  });

  test('CHANGE ORDER — the PRIOR sentence never mentioned the section', () => {
    const ed = coEditor(OLD_COE);
    const r = ed.run(coFixture(), 'ROLLUP', null);
    expect(r.message).not.toMatch(/new section/);
    const hdrAfter = r.record.lines.filter((l) => l.section === '__section_header__').length;
    expect(hdrAfter).toBe(2);              // it silently created one anyway
  });

  test('CHANGE ORDER — a recipe that needs NO new section says nothing about one', () => {
    const f = coFixture();
    const roll = f.lines.find((l) => l.id === 'ROLLUP');
    roll.assemblyBreakdown = roll.assemblyBreakdown.map((b) => Object.assign({}, b, { cost_code: 'materials' }));
    const r = coEditor(NOW_COE).run(f, 'ROLLUP', null);
    expect(r.message).not.toMatch(/new section/);
    expect(r.record.lines.filter((l) => l.section === '__section_header__').length).toBe(1);
  });

  test('ESTIMATE — the sentence names the Direct Labor section it creates', () => {
    const r = eeRun(null);
    expect(r.message).toMatch(/adds 1 new section/);
    expect(r.message).toContain('Direct Labor');
    const hdrs = r.lines.filter((l) => l.section === '__section_header__').map((l) => l.description);
    expect(hdrs).toContain('Direct Labor');
  });

  test('ESTIMATE — the PRIOR sentence never mentioned it', () => {
    const r = eeRun(null, { editorFile: OLD_EE_FILE });
    expect(r.message).not.toMatch(/new section/);
    const hdrs = r.lines.filter((l) => l.section === '__section_header__').map((l) => l.description);
    expect(hdrs).toContain('Direct Labor');     // created silently
  });
});

// ══════════════════════════════════════════════════════════════════════
// P6 — NOTHING THAT WORKED CHANGES.
// ══════════════════════════════════════════════════════════════════════
describe('P6 an explode on a record that did not move is byte-identical to before', () => {
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const CODES = ['materials', 'labor', 'gc', 'sub'];

  // ORDINARY records only — positive quantity, at least one component that
  // survives the filter, no holes. Those are exactly the explodes that worked
  // before, and not one of them may come out different.
  function corpus(seed, n) {
    const r = rng(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
      const lines = [];
      const nSec = 1 + Math.floor(r() * 2);
      for (let s = 0; s < nSec; s++) {
        lines.push({ id: 'h' + s, section: '__section_header__',
          label: ['MATERIALS', 'LABOR', 'SUBCONTRACTORS'][Math.floor(r() * 3)],
          btCategory: CODES[Math.floor(r() * 4)],
          markup: r() < 0.4 ? '' : [10, 15, 25][Math.floor(r() * 3)], markupMode: 'percent' });
        const nl = Math.floor(r() * 3);
        for (let k = 0; k < nl; k++) {
          lines.push({ id: 'o' + s + '_' + k, description: 'Line ' + s + k,
            qty: [1, 2, 5][Math.floor(r() * 3)],
            unitCost: Math.round((5 + r() * 900) * 100) / 100,
            markup: r() < 0.4 ? '' : [10, 18][Math.floor(r() * 2)], markupMode: 'percent' });
        }
      }
      const nb = 1 + Math.floor(r() * 4);
      const bd = [];
      for (let b = 0; b < nb; b++) {
        bd.push({ description: 'comp' + b,
          qty_per_unit: [0.02, 0.5, 1, 2, 3][Math.floor(r() * 5)],
          unit_cost: Math.round((r() * 500 + 5) * 100) / 100,
          cost_code: CODES[Math.floor(r() * 4)],
          unit: ['ea', 'SF', 'HR'][Math.floor(r() * 3)] });
      }
      const roll = { id: 'ROLLUP', description: 'Assembly ' + i,
        qty: [1, 2, 3, 10][Math.floor(r() * 4)],
        unitCost: Math.round(bd.reduce((s, b) => s + b.qty_per_unit * b.unit_cost, 0) * 10000) / 10000,
        unit: 'ea', markup: r() < 0.5 ? '' : 20, markupMode: 'percent',
        sourceAssemblyId: 40 + Math.floor(r() * 9), assemblyBreakdown: bd };
      if (r() < 0.35) {
        const s = Math.round(roll.unitCost * (1 + r()) * 100) / 100;
        roll.unitSell = s;
      }
      lines.splice(1 + Math.floor(r() * lines.length), 0, roll);
      const rec = { id: 'co_' + i, title: 'CO ' + i, lines,
        defaultMarkup: [0, 10, 20, 25][Math.floor(r() * 4)] };
      if (r() < 0.3) rec.taxPct = [4, 6, 7][Math.floor(r() * 3)];
      if (r() < 0.2) rec.feePct = [1, 3][Math.floor(r() * 2)];
      if (r() < 0.3) rec.roundTo = [25, 100][Math.floor(r() * 2)];
      out.push(rec);
    }
    return out;
  }

  // MINTED IDS ARE RENUMBERED BEFORE COMPARING, AND THAT IS NOT A LOOPHOLE.
  //
  // The repaired explode runs simulateExplode BEFORE it mints anything real —
  // once for the sentence and once again inside stillQuoted — and each of
  // those consumes newLineId on the clone. So the real lines come out gen_5,
  // gen_6 where they used to be gen_1, gen_2. That is the id COUNTER moving,
  // not the record: `newLineId` is a per-session counter in both blobs and
  // nothing reads meaning out of the number.
  //
  // The renumbering is positional and total — if the repaired explode created
  // a different NUMBER of lines, or created them in a different ORDER, or gave
  // them different content, the strings still differ. Only the digits move.
  const normalize = (rec) => {
    let n = 0;
    const map = {};
    (rec.lines || []).forEach((l) => {
      if (l && String(l.id).indexOf('gen_') === 0) map[l.id] = 'new_' + (++n);
    });
    return JSON.stringify((rec.lines || []).map((l) => {
      if (!l || typeof l !== 'object') return l;
      const c = Object.assign({}, l);
      if (map[c.id]) c.id = map[c.id];
      return c;
    }));
  };

  test('CHANGE ORDER — 2,000 ordinary records come out identical to the prior bytes', () => {
    const now = coEditor(NOW_COE);
    const old = coEditor(OLD_COE);
    const cs = corpus(4242, 2000);
    let compared = 0;
    const diffs = [];
    for (const rec of cs) {
      const a = now.run(rec, 'ROLLUP', null);
      const b = old.run(rec, 'ROLLUP', null);
      if (!a.raised || !b.raised) continue;      // refusals are covered by P3
      compared++;
      if (normalize(a.record) !== normalize(b.record)) diffs.push(rec.id);
    }
    expect(compared).toBeGreaterThan(1500);
    expect(diffs).toEqual([]);
  });

  test('the normalizer is not a blanket — it still sees a real difference', () => {
    // Trap 3 in this repo today was a suite that passed vacuously. If
    // `normalize` flattened everything, P6 would pass no matter what the
    // repair did, so it is shown here refusing a record that genuinely moved.
    const a = { lines: [{ id: 'gen_1', description: 'X', qty: 1 }] };
    const b = { lines: [{ id: 'gen_9', description: 'X', qty: 1 }] };
    const c = { lines: [{ id: 'gen_9', description: 'X', qty: 2 }] };
    const d = { lines: [{ id: 'gen_1', description: 'X', qty: 1 }, { id: 'gen_2', description: 'Y', qty: 1 }] };
    expect(normalize(a)).toBe(normalize(b));      // only the counter moved
    expect(normalize(a)).not.toBe(normalize(c));  // the money moved
    expect(normalize(a)).not.toBe(normalize(d));  // the count moved
  });

  test('CHANGE ORDER — the COUNT in the sentence is unchanged on those records', () => {
    const now = coEditor(NOW_COE);
    const old = coEditor(OLD_COE);
    const cs = corpus(777, 500);
    const COUNT_RE = /\binto (\d+) editable lines?\?/;
    for (const rec of cs) {
      const a = now.run(rec, 'ROLLUP', null);
      const b = old.run(rec, 'ROLLUP', null);
      if (!a.raised || !b.raised) continue;
      expect(a.message.match(COUNT_RE)[1]).toBe(b.message.match(COUNT_RE)[1]);
    }
  });
});
