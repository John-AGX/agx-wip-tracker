// test/explode-replaces-or-refuses.test.js
//
// AN EXPLODE REPLACES THE LINE WITH ITS PARTS, OR IT DOES NOTHING AND SAYS
// WHY. IT NEVER REMOVES THE LINE AND LEAVES NOTHING.
//
// "Explode to editable lines" turns an assembly rollup into one line per
// component. It exists twice — js/change-order-editor.js (coAsmExplode) and
// js/estimate-editor.js (eeAsmExplode) — and both shipped the same two
// defects, in the same shape, because both were written the same way.
//
//   1. THE SPLICE WAS UNCONDITIONAL AND THE ADD WAS NOT.
//
//        var specs = <components>.filter(qty > 0);
//        lines.splice(indexOf(line), 1);          // always
//        applyBulkAddLineItems(specs);            // returns early if empty
//
//      Both bulk adders open with `if (!specs.length) return []`, and that
//      early return sits ABOVE their markDirty/paintLines/paintTotals (change
//      order) and debouncedSave/renderLineItems/renderTotals (estimate). So on
//      a rollup whose own quantity is 0, or a CREDIT rollup carrying a
//      negative quantity, or a recipe whose every row is "included, no
//      charge", the line was removed and NOTHING was put back — with no save
//      armed and no repaint. The destroyed row stayed on screen. Close the
//      record and the deletion was dropped; touch anything else and it was
//      saved along with the unrelated edit. Silent, deferred, and triggered by
//      something else entirely.
//
//   2. THE SENTENCE QUOTED A COUNT IT WOULD NOT DELIVER.
//
//      Both confirms quoted `line.assemblyBreakdown.length` — every row in the
//      recipe — while the action built from the `qty > 0` filter.
//
// These are PROPERTIES, not cases. Each is a statement about EVERY rollup and
// EVERY recipe, and each is RED against 095dfbfa (release 1.21's cut, the
// bytes this file was written on) — which is asserted below against the real
// git blobs rather than described, because the wrong line count survived a
// green 3,628-test suite for exactly as long as nothing was watching it.
//
//   P1  REPLACE OR REFUSE  — the record after an explode either loses the
//                            rollup and gains exactly the parts created, or is
//                            BYTE-IDENTICAL to before and the person was told
//   P2  THE COUNT IS THE COUNT — the number in the sentence is the number of
//                            lines the action creates, always
//   P3  NOTHING MOVES SILENTLY — every mutation arms the save; a refusal
//                            arms nothing
//   P4  THE SCREEN IS THE RECORD — the rows painted afterwards are the lines
//                            the record holds
//   P5  NOTHING THAT WORKED CHANGES — against the SHIPPED BYTES, every explode
//                            that used to create at least one line produces a
//                            byte-identical record now
//
// WHY THE REFUSAL, AND WHY IT IS NOT A CREDIT EXPLODE. A rollup at qty −1 is a
// legitimate deductive line, and a person exploding it plausibly wants
// negative components. That is a defensible feature and it is NOT this commit:
// nothing in coApplyAddLineItem or the markup cascade has ever been asked to
// price negative-quantity components through find-or-create sections, so
// shipping it here would be introducing untested money semantics under cover
// of a data-loss fix. The server already refuses the same operation by name
// (server/services/estimate-lines.js → 'assembly_zero_qty' / 'assembly_empty');
// the client is now the same answer at the same door.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const P = require('../js/pricing-pipeline.js');
const H = require('./helpers/estimate-editor-harness.js');

// The bytes that SHIPPED as release 1.21 — the commit this repair was written
// on. Both editors carry both defects here, which is asserted, not assumed.
const SHIPPED_SHA = '095dfbfaf0e27eacc18be3471e3ee281fd1f74f3';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');
}
function shipped(rel) {
  try {
    return execFileSync('git', ['show', SHIPPED_SHA + ':' + rel],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .split('\r\n').join('\n');
  } catch (e) { return null; }
}
const SHIPPED_COE = shipped('js/change-order-editor.js');
const SHIPPED_EE = shipped('js/estimate-editor.js');

// The prior estimate editor has to be a FILE for the harness to load it as a
// <script>, and it must not land anywhere inside the shared working tree.
let SHIPPED_EE_FILE = null;
if (SHIPPED_EE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-shipped-ee-'));
  SHIPPED_EE_FILE = path.join(d, 'estimate-editor.js');
  fs.writeFileSync(SHIPPED_EE_FILE, SHIPPED_EE);
}

// A deterministic LCG so any failure is reproducible from its seed alone.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// THE SENTENCE, as a person reads it. Both editors print the same one.
const COUNT_RE = /\binto (\d+) editable lines?\?/;
function quotedCount(msg) {
  const m = msg && String(msg).match(COUNT_RE);
  return m ? Number(m[1]) : null;
}

// ══════════════════════════════════════════════════════════════════════
// THE CORPUS — every shape that reaches the explode button.
//
// Deliberately generated around the three ways a recipe comes out EMPTY,
// because that is the whole population defect 1 lives in and a corpus without
// it measures zero and calls the code clean:
//   • the rollup's own qty is 0
//   • the rollup's own qty is NEGATIVE (a deduct line)
//   • every row in the recipe carries qty_per_unit 0 ("included, no charge")
// plus an empty assemblyBreakdown, which the app can produce: coAsmRefresh
// filters a re-pulled recipe to the line's own bucket and warns when the
// result is empty rather than removing the array.
//
// Money arrives off input elements, so half of it is string-typed; markup is
// ''/null/number; components spread across all four cost codes so the
// find-or-create section routing is exercised, not just the materials path.
// ══════════════════════════════════════════════════════════════════════
const CODES = ['materials', 'labor', 'gc', 'sub'];

function rollupCorpus(seed, opts) {
  const o = opts || {};
  const r = rng(seed);
  const out = [];
  for (let n = 0; n < (o.count || 500); n++) {
    const lines = [];
    // Neighbours, so "everything else is untouched" has something to be about.
    const nOther = Math.floor(r() * 3);
    for (let i = 0; i < nOther; i++) {
      const m = Math.round(r() * 40 * 10) / 10;
      lines.push({
        id: 'other' + i, description: 'Line ' + i,
        qty: [0.5, 1, 2, 5][Math.floor(r() * 4)],
        unitCost: Math.round((5 + r() * 900) * 100) / 100,
        markup: r() < 0.2 ? '' : (r() < 0.5 ? m : String(m)),
      });
    }
    // A pre-existing section header a quarter of the time — section
    // membership on both surfaces is POSITIONAL, so this is what makes
    // "nothing was reordered" a real question.
    if (r() < 0.25) {
      lines.splice(Math.floor(r() * (lines.length + 1)), 0, {
        id: 'hdr', section: '__section_header__', label: 'Materials',
        btCategory: 'materials', markup: r() < 0.5 ? 15 : '', markupMode: 'percent',
      });
    }
    // THE ROLLUP.
    const shape = r();
    let qty;
    if (shape < 0.45) qty = [0.5, 1, 2, 3, 10, 12.5][Math.floor(r() * 6)];   // ordinary
    else if (shape < 0.70) qty = -[0.5, 1, 2, 5][Math.floor(r() * 4)];       // CREDIT
    else if (shape < 0.85) qty = 0;                                          // zero
    else qty = [1, 2, 4][Math.floor(r() * 3)];                               // ordinary
    const unitCost = Math.round((50 + r() * 4000) * 100) / 100;
    const rollup = {
      id: 'ROLLUP', description: ['Pool cage package', 'Trex deck framing', 'Exterior repaint', 'Deduct: cage'][Math.floor(r() * 4)],
      qty: r() < 0.5 ? qty : String(qty),
      unitCost: r() < 0.5 ? unitCost : String(unitCost),
      unit: 'ea', markup: '', markupMode: 'percent',
      sourceAssemblyId: 40 + Math.floor(r() * 9),
    };
    // The recipe.
    const recipeShape = r();
    const nb = 1 + Math.floor(r() * 4);
    const bd = [];
    if (recipeShape < 0.06) {
      // EMPTY recipe array.
    } else if (recipeShape < 0.18) {
      // Every row "included, no charge".
      for (let b = 0; b < nb; b++) {
        bd.push({ description: 'inc' + b, qty_per_unit: 0, unit_cost: Math.round(r() * 400 * 100) / 100,
          cost_code: CODES[Math.floor(r() * 4)], unit: 'ea' });
      }
    } else {
      for (let b = 0; b < nb; b++) {
        // A third of ordinary recipes carry ONE zero-qty row — the shape
        // that makes the quoted count wrong without making it empty.
        const zero = r() < 0.18;
        bd.push({
          description: 'comp' + b,
          qty_per_unit: zero ? 0 : [0.005, 0.02, 0.5, 1, 2, 3][Math.floor(r() * 6)],
          unit_cost: Math.round((r() * 500) * 100) / 100,
          cost_code: o.oneCode ? 'materials' : CODES[Math.floor(r() * 4)],
          unit: ['ea', 'SF', 'HR', 'GAL'][Math.floor(r() * 4)],
          material_id: r() < 0.5 ? 1000 + b : undefined,
        });
      }
    }
    rollup.assemblyBreakdown = bd;
    if (o.promise !== false && r() < 0.45) {
      const s = Math.round(unitCost * (1 + r()) * 100) / 100;
      rollup.unitSell = r() < 0.5 ? s : String(s);
    }
    lines.splice(Math.floor(r() * (lines.length + 1)), 0, rollup);
    const rec = { id: 'co_' + n, title: 'CO ' + n, lines, defaultMarkup: [0, 10, 20, 25][Math.floor(r() * 4)] };
    if (r() < 0.30) rec.taxPct = [4, 6, 7][Math.floor(r() * 3)];
    if (r() < 0.20) rec.feePct = [1, 3, 5][Math.floor(r() * 3)];
    if (r() < 0.15) rec.feeFlat = [100, 500, 1200][Math.floor(r() * 3)];
    if (r() < 0.35) rec.roundTo = [25, 100, 500][Math.floor(r() * 3)];
    if (r() < 0.20) rec.targetPrice = (1000 + Math.round(r() * 60000)).toFixed(2);
    out.push(rec);
  }
  return out;
}

// What SHOULD come out of a recipe — stated once, here, from the recipe and
// the rollup quantity and nothing else. This is the only re-expression in the
// file and it is deliberate: it is the ORACLE the editors are measured
// against, and it is three lines long precisely so it cannot quietly acquire
// the editors' bugs.
function expectedParts(rollup) {
  const q = P.num(rollup.qty);
  return (rollup.assemblyBreakdown || [])
    .map((b) => Math.round(q * P.num(b.qty_per_unit) * 100) / 100)
    .filter((n) => n > 0);
}

// ══════════════════════════════════════════════════════════════════════
// THE CHANGE-ORDER EDITOR, ASSEMBLED FROM ITS OWN BYTES.
//
// Lifted VERBATIM by anchor — the bucket router, the section find-or-create,
// the single-line adder, the bulk adder, computeTotals, fmtCurrency and
// coAsmExplode itself. Nothing here re-expresses any of it, and that is the
// point: BOTH defects were re-expressions, and a harness that modelled the
// explode would agree with itself and see neither.
//
// The three things the editor does to the world on a mutation — markDirty,
// paintLines, paintTotals — are COUNTED rather than stubbed away, because "did
// anything move without arming the save" is the property, not a detail.
// ══════════════════════════════════════════════════════════════════════
function coEditor(src, opts) {
  const o = opts || {};
  const cut = (a, b) => {
    const i = src.indexOf(a);
    const j = src.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error('anchor not found: ' + a);
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
    cut('  function coAsmExplode(lineId) {', '    } else if (confirm(msg)) doIt();\n  }\n'),
  ].join('\n');
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
${body}
    return {
      setCo: function (c) { _state.co = c; _coAsmOpen = {}; _seq = 0; },
      getCo: function () { return _state.co; },
      explode: coAsmExplode,
      fmt: fmtCurrency
    };
  `);
  const env = { dirty: 0, paints: 0, totals: 0, natives: [] };
  let message = null;
  let notice = null;
  const win = {
    p86Pricing: P,
    // Raise the dialog a person reads AND perform the irreversible change
    // they were shown a number for — one call, both halves.
    p86Confirm: (opt) => { message = opt.message; return { then: (f) => f(o.cancel ? false : true) }; },
  };
  if (!o.noAlertShim) win.p86Alert = (opt) => { notice = opt; };
  const ed = build(win, env);
  return {
    fmt: ed.fmt,
    run(co, lineId) {
      message = null; notice = null;
      env.dirty = 0; env.paints = 0; env.totals = 0; env.natives = [];
      const input = JSON.stringify(co);
      ed.setCo(JSON.parse(input));
      ed.explode(lineId);
      const record = ed.getCo();
      return {
        confirmed: message != null,
        message,
        count: quotedCount(message),
        refused: notice != null || env.natives.length > 0,
        why: notice ? notice.message : (env.natives[0] || null),
        dirty: env.dirty, paints: env.paints, totals: env.totals,
        record,
        unchanged: JSON.stringify(record) === input,
        input,
      };
    },
  };
}

const contentIds = (rec) => (rec.lines || [])
  .filter((l) => l.section !== '__section_header__').map((l) => String(l.id));
const headerIds = (rec) => (rec.lines || [])
  .filter((l) => l.section === '__section_header__').map((l) => String(l.id));

// ══════════════════════════════════════════════════════════════════════
// 0 — THE HARNESS IS NOT VACUOUS, AND THE SHIPPED BYTES ARE THE DEFECT.
// ══════════════════════════════════════════════════════════════════════
describe('the pin holds and the harness is real', () => {
  test('the shipped 1.21 blobs load, and both carry both defects', () => {
    expect(typeof SHIPPED_COE).toBe('string');
    expect(typeof SHIPPED_EE).toBe('string');
    // Defect 2, in the source of both, at the pin.
    expect(SHIPPED_COE).toContain("line.assemblyBreakdown.length + ' editable lines?");
    expect(SHIPPED_EE).toContain("line.assemblyBreakdown.length + ' editable lines?");
    // Defect 1: the splice with nothing between it and an adder that returns
    // early on empty.
    expect(SHIPPED_COE).toContain('if (idx >= 0) _state.co.lines.splice(idx, 1);');
    expect(SHIPPED_EE).toContain('if (idx >= 0) appData.estimateLines.splice(idx, 1);');
    // ...and NEITHER is present in the working tree any more.
    expect(read('js/change-order-editor.js')).not.toContain("line.assemblyBreakdown.length + ' editable lines?");
    expect(read('js/estimate-editor.js')).not.toContain("line.assemblyBreakdown.length + ' editable lines?");
  });

  test('the change-order editor really was assembled from its own bytes', () => {
    const NOW = coEditor(read('js/change-order-editor.js'));
    const co = {
      defaultMarkup: 25,
      lines: [
        { id: 'ROLLUP', description: 'Trex deck framing package', qty: 1, unitCost: 14000, markup: '',
          assemblyBreakdown: [
            { description: 'Trex boards', qty_per_unit: 1, unit_cost: 8200, cost_code: 'materials' },
            { description: 'Crew day', qty_per_unit: 1, unit_cost: 3400, cost_code: 'labor' },
            { description: 'Screen sub', qty_per_unit: 1, unit_cost: 2400, cost_code: 'sub' },
          ] },
        { id: 'L2', description: 'Screen enclosure', qty: 1, unitCost: 5600, markup: 20 },
      ],
    };
    const r = NOW.run(co, 'ROLLUP');
    expect(r.confirmed).toBe(true);
    expect(r.count).toBe(3);
    // The rollup really was replaced by its components, through the real
    // coApplyAddLineItem — which finds-or-creates a section header per cost
    // code, so three sections appear that the naive concat would not produce.
    expect(contentIds(r.record)).not.toContain('ROLLUP');
    expect(contentIds(r.record)).toHaveLength(4);
    expect(headerIds(r.record)).toHaveLength(3);
    expect(r.dirty).toBe(1);
    expect(r.paints).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// P1 + P2 + P3 — THE CHANGE ORDER, over the whole corpus.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — a change-order explode replaces the line with its parts, or does nothing and says why', () => {
  const NOW = coEditor(read('js/change-order-editor.js'));
  const corpus = rollupCorpus(701, { count: 4000 })
    .concat(rollupCorpus(702, { count: 4000, oneCode: true }))
    .concat(rollupCorpus(703, { count: 4000, promise: false }));

  test('12,000 explodes: replaced-by-exactly-the-parts, or byte-identical and told', () => {
    let proceeded = 0, refused = 0;
    const brokenP1 = [], brokenP2 = [], brokenP3 = [], mute = [];
    for (const co of corpus) {
      const rollup = co.lines.find((l) => l.id === 'ROLLUP');
      const want = expectedParts(rollup);
      const beforeContent = contentIds(co);
      const beforeOthers = beforeContent.filter((id) => id !== 'ROLLUP');
      const r = NOW.run(co, 'ROLLUP');

      if (want.length === 0) {
        // ── THE REFUSAL BRANCH ──
        refused++;
        // P1: byte-identical. Not "the line is still there" — IDENTICAL.
        if (!r.unchanged) brokenP1.push({ id: co.id, kind: 'mutated on refusal' });
        // ...and no dialog was raised asking to approve a thing that will
        // not happen.
        if (r.confirmed) brokenP1.push({ id: co.id, kind: 'confirm raised on an empty explode' });
        // P3: nothing armed.
        if (r.dirty !== 0 || r.paints !== 0 || r.totals !== 0) {
          brokenP3.push({ id: co.id, dirty: r.dirty, paints: r.paints, totals: r.totals });
        }
        // ...AND THE PERSON WAS TOLD, with a reason, not a shrug.
        if (!r.refused || !r.why || r.why.length < 20) mute.push({ id: co.id, why: r.why });
        continue;
      }

      // ── THE REPLACE BRANCH ──
      proceeded++;
      const after = contentIds(r.record);
      // P1: the rollup is gone, every other line is still there exactly once
      // and in the same relative order, and the lines that appeared number
      // exactly `want.length`.
      const survivors = after.filter((id) => beforeOthers.indexOf(id) >= 0);
      const created = after.filter((id) => beforeContent.indexOf(id) < 0);
      if (after.indexOf('ROLLUP') >= 0 ||
          survivors.join('|') !== beforeOthers.join('|') ||
          created.length !== want.length ||
          after.length !== beforeOthers.length + want.length) {
        brokenP1.push({ id: co.id, before: beforeContent, after, want: want.length });
      }
      // ...and the parts created ARE the parts the recipe implies. Compared as
      // a sorted multiset, not in recipe order: coApplyAddLineItem routes each
      // component into its own cost-code section, and section membership on a
      // change order is POSITIONAL, so the array order after an explode is the
      // section layout — which is correct behaviour, not drift.
      const asc = (a, b) => a - b;
      const madeQty = created.map((id) => r.record.lines.find((l) => String(l.id) === id).qty).sort(asc);
      if (JSON.stringify(madeQty) !== JSON.stringify(want.slice().sort(asc))) {
        brokenP1.push({ id: co.id, kind: 'quantities', made: madeQty, want });
      }
      // P2: THE COUNT IS THE COUNT.
      if (r.count !== created.length) {
        brokenP2.push({ id: co.id, quoted: r.count, created: created.length, msg: r.message });
      }
      // P3: the mutation armed the save and repainted, exactly once each.
      if (r.dirty !== 1 || r.paints !== 1 || r.totals !== 1) {
        brokenP3.push({ id: co.id, dirty: r.dirty, paints: r.paints, totals: r.totals });
      }
    }
    // The corpus reaches BOTH branches in force — a run that only ever
    // proceeds proves nothing about the refusal and vice versa.
    expect(proceeded).toBeGreaterThan(4000);
    expect(refused).toBeGreaterThan(4000);
    expect(brokenP1.slice(0, 3)).toEqual([]);
    expect(brokenP1).toHaveLength(0);
    expect(brokenP2.slice(0, 3)).toEqual([]);
    expect(brokenP2).toHaveLength(0);
    expect(brokenP3.slice(0, 3)).toEqual([]);
    expect(brokenP3).toHaveLength(0);
    expect(mute.slice(0, 3)).toEqual([]);
    expect(mute).toHaveLength(0);
  });

  test('the refusal names WHICH of the three reasons it is', () => {
    const mk = (qty, bd) => ({
      defaultMarkup: 20,
      lines: [{ id: 'ROLLUP', description: 'Pool cage', qty, unitCost: 6000, markup: '', assemblyBreakdown: bd },
        { id: 'L2', description: 'Base scope', qty: 1, unitCost: 10000, markup: 20 }],
    });
    const one = [{ description: 'Extrusion', qty_per_unit: 1, unit_cost: 2000, cost_code: 'materials' }];
    const zero = [{ description: 'Included', qty_per_unit: 0, unit_cost: 2000, cost_code: 'materials' }];

    const credit = NOW.run(mk(-1, one), 'ROLLUP');
    expect(credit.why).toMatch(/credit line \(quantity -1\)/);
    expect(credit.unchanged).toBe(true);

    const zeroQty = NOW.run(mk(0, one), 'ROLLUP');
    expect(zeroQty.why).toMatch(/quantity is 0/);
    expect(zeroQty.unchanged).toBe(true);

    const noCharge = NOW.run(mk(2, zero), 'ROLLUP');
    expect(noCharge.why).toMatch(/every item in this recipe works out to no quantity/);
    expect(noCharge.unchanged).toBe(true);

    const emptyRecipe = NOW.run(mk(2, []), 'ROLLUP');
    expect(emptyRecipe.why).toMatch(/no recipe items/);
    expect(emptyRecipe.unchanged).toBe(true);
  });

  test('the refusal reaches a person even where native dialogs do not', () => {
    // Installed PWAs no-op window.confirm/alert. p86Alert is the door that
    // works there, and it is tried FIRST — a refusal nobody can see is the
    // silence this commit is about.
    const co = { defaultMarkup: 20, lines: [
      { id: 'ROLLUP', description: 'Deduct: cage', qty: -1, unitCost: 6000, markup: '',
        assemblyBreakdown: [{ description: 'Extrusion', qty_per_unit: 1, unit_cost: 2000, cost_code: 'materials' }] }] };
    expect(NOW.run(co, 'ROLLUP').why).toBeTruthy();          // via p86Alert
    // ...and with p86Alert absent it still falls back rather than going quiet.
    const NATIVE = coEditor(read('js/change-order-editor.js'), { noAlertShim: true });
    expect(NATIVE.run(co, 'ROLLUP').why).toBeTruthy();        // via alert()
  });

  test('CANCELLING the confirm changes nothing', () => {
    const CANCEL = coEditor(read('js/change-order-editor.js'), { cancel: true });
    for (const co of rollupCorpus(704, { count: 400 })) {
      const r = CANCEL.run(co, 'ROLLUP');
      expect(r.unchanged).toBe(true);
      expect([r.dirty, r.paints, r.totals]).toEqual([0, 0, 0]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// P5 — NOTHING THAT ALREADY WORKED CHANGES. Against the shipped bytes.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — measured against 1.21: only the empty explode behaves differently', () => {
  const NOW = coEditor(read('js/change-order-editor.js'));
  const OLD = coEditor(SHIPPED_COE);
  const corpus = rollupCorpus(711, { count: 6000 }).concat(rollupCorpus(712, { count: 6000, oneCode: true }));

  test('12,000 explodes: every one that used to create a line produces the SAME record', () => {
    let same = 0, destroyed = 0;
    const moved = [], stillDestroys = [], oldLied = [];
    for (const co of corpus) {
      const before = JSON.stringify(co);
      const old = OLD.run(co, 'ROLLUP');
      const now = NOW.run(co, 'ROLLUP');
      const oldCreated = contentIds(old.record).filter((id) => contentIds(co).indexOf(id) < 0).length;

      if (oldCreated > 0) {
        // THE WORKING CASE. Byte-identical record — no line moved, no section
        // changed, no money repriced. Only the SENTENCE may differ, and only
        // where the shipped one was lying.
        same++;
        if (JSON.stringify(now.record) !== JSON.stringify(old.record)) {
          moved.push({ id: co.id, old: old.record.lines, now: now.record.lines });
        }
        if (old.count !== oldCreated) oldLied.push({ id: co.id, quoted: old.count, created: oldCreated });
        if (now.count !== oldCreated) moved.push({ id: co.id, kind: 'count', quoted: now.count, created: oldCreated });
      } else {
        // THE BROKEN CASE. The shipped bytes destroyed the rollup and put
        // nothing back — asserted, so this branch cannot go quietly vacuous.
        destroyed++;
        if (contentIds(old.record).indexOf('ROLLUP') >= 0) {
          stillDestroys.push({ id: co.id, kind: 'shipped did NOT destroy — pin is stale' });
        }
        if (old.dirty !== 0 || old.paints !== 0) {
          stillDestroys.push({ id: co.id, kind: 'shipped armed a save it did not', old: [old.dirty, old.paints] });
        }
        if (!now.unchanged || JSON.stringify(now.record) !== before) {
          stillDestroys.push({ id: co.id, kind: 'the repair still mutates' });
        }
      }
    }
    expect(same).toBeGreaterThan(4000);
    expect(destroyed).toBeGreaterThan(4000);
    expect(moved.slice(0, 3)).toEqual([]);
    expect(moved).toHaveLength(0);
    expect(stillDestroys.slice(0, 3)).toEqual([]);
    expect(stillDestroys).toHaveLength(0);
    // And the count defect was REAL and common on this corpus, not a rumour:
    // recipes carrying an "included, no charge" row.
    expect(oldLied.length).toBeGreaterThan(500);
  });

  test('the rates the shipped bytes ran at, on this corpus', () => {
    const all = rollupCorpus(713, { count: 8000 });
    let confirms = 0, destroyedNothingCreated = 0, countWrong = 0;
    for (const co of all) {
      const old = OLD.run(co, 'ROLLUP');
      if (!old.confirmed) continue;
      confirms++;
      const created = contentIds(old.record).filter((id) => contentIds(co).indexOf(id) < 0).length;
      if (created === 0 && contentIds(old.record).indexOf('ROLLUP') < 0) destroyedNothingCreated++;
      if (old.count !== created) countWrong++;
    }
    expect(confirms).toBeGreaterThan(7000);
    // Both are properties of the shape distribution, so they are pinned as
    // floors. A rate of ZERO — what a broken extraction produces — fails loud.
    expect(destroyedNothingCreated / confirms).toBeGreaterThan(0.25);
    expect(countWrong / confirms).toBeGreaterThan(0.35);
    // Same corpus, the repaired bytes: neither happens at all.
    let nowConfirms = 0, nowWrong = 0, nowDestroyed = 0;
    for (const co of all) {
      const now = NOW.run(co, 'ROLLUP');
      if (!now.confirmed) continue;
      nowConfirms++;
      const created = contentIds(now.record).filter((id) => contentIds(co).indexOf(id) < 0).length;
      if (created === 0) nowDestroyed++;
      if (now.count !== created) nowWrong++;
    }
    expect(nowConfirms).toBeGreaterThan(3000);
    expect(nowDestroyed).toBe(0);
    expect(nowWrong).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// fmtCurrency — the glyph, not the number.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — no total is ever printed as a negative zero', () => {
  test('both editors: -0 and everything that rounds to nothing from below', () => {
    const CO = coEditor(read('js/change-order-editor.js')).fmt;
    // The estimate editor's formatter, through its own bytes.
    const ee = read('js/estimate-editor.js');
    const i = ee.indexOf('  function fmtCurrency(v) {');
    // eslint-disable-next-line no-new-func
    const EE = new Function(ee.slice(i, ee.indexOf('\n  }\n', i) + 5) + '\n return fmtCurrency;')();
    for (const v of [-0, -0.0001, -0.001, -0.004, -1e-9]) {
      expect(CO(v)).toBe('$0.00');
      expect(EE(v)).toBe('$0.00');
    }
    // Every real number is untouched — this is a glyph fix, not a rounding one.
    for (const v of [0, 0.004, -0.006, -1, -1234.5, 1234.5, -0.01]) {
      expect(CO(v).startsWith('$-') && CO(v) === '$-0.00').toBe(false);
      expect(EE(v)).not.toBe('-$0.00');
    }
    expect(CO(-1234.5)).toBe('$-1,234.50');
    expect(EE(-1234.5)).toBe('-$1,234.50');
    expect(CO(-0.006)).toBe('$-0.01');
    expect(EE(-0.006)).toBe('-$0.01');
  });

  test('the reachable case: a promised credit at unitSell 0 makes exactly -0', () => {
    const NOW = coEditor(read('js/change-order-editor.js'));
    const co = { defaultMarkup: 20, lines: [
      { id: 'ROLLUP', description: 'Deduct: cage', qty: -1, unitCost: 6000, unitSell: 0, markup: '',
        assemblyBreakdown: [{ description: 'Extrusion', qty_per_unit: 1, unit_cost: 2000, cost_code: 'materials' }] },
      { id: 'L2', description: 'Base scope', qty: 1, unitCost: 10000, markup: 20 }] };
    expect(P.sellLocked(co.lines[0])).toBe(true);
    expect(-1 * 0).toBe(-0);
    // The shipped bytes printed "$-0.00" INSIDE a sentence that then destroyed
    // the line. Now the sentence is never written, because the explode is
    // refused before the dialog.
    const old = coEditor(SHIPPED_COE).run(co, 'ROLLUP');
    expect(old.message).toContain('$-0.00');
    const now = NOW.run(co, 'ROLLUP');
    expect(now.confirmed).toBe(false);
    expect(now.unchanged).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE ESTIMATE EDITOR — the same properties, driven through the real
// module in a real DOM, by the real inline onclick a person clicks.
// ══════════════════════════════════════════════════════════════════════
function estRecord(id, rollup, others) {
  return {
    id, name: 'Est ' + id, activeAlternateId: 'altA',
    alternates: [{ id: 'altA', name: 'Base' }],
    defaultMarkup: 20,
    lines: (others || []).concat([rollup]).map((l) => Object.assign({ estimateId: id, alternateId: 'altA' }, l)),
  };
}

function estHarness(editorFile) {
  const h = H.boot(editorFile ? { editorFile } : {});
  h.w.eval(`
    window.__confirms = []; window.__notices = [];
    window.p86Confirm = function (o) { window.__confirms.push(o && o.message); return Promise.resolve(window.__confirm !== false); };
    window.p86Alert = function (o) { window.__notices.push(o && o.message); return Promise.resolve(); };
    // A CLOCK THE TEST OWNS. The editor's save is debounced 400ms and this
    // window is its own realm, so jest's fake timers cannot reach it and
    // waiting 400ms of wall clock per record cannot pay for a corpus. Every
    // timer the editor arms is recorded; __flush() runs the queue. "Did this
    // action arm the save" then has a synchronous answer, which is the
    // property — not an implementation detail of the debounce.
    window.__armed = [];
    window.setTimeout = function (fn) { window.__armed.push(fn); return window.__armed.length; };
    window.clearTimeout = function (id) { if (id > 0 && window.__armed[id - 1]) window.__armed[id - 1] = null; };
    window.__flush = function () {
      for (var pass = 0; pass < 4 && window.__armed.length; pass++) {
        var q = window.__armed; window.__armed = [];
        for (var i = 0; i < q.length; i++) { if (q[i]) { try { q[i](); } catch (e) {} } }
      }
    };
  `);
  let n = 0;
  return {
    h,
    w: h.w,
    // ONE explode, through the doors the app uses: hydrate → open → click the
    // strip open → click "Explode to editable lines".
    async run(rollup, others) {
      const id = 'e' + (++n);
      h.w.appData.estimates.length = 0;
      h.w.appData.estimateLines = [];
      h.w.__confirms.length = 0; h.w.__notices.length = 0;
      const rec = estRecord(id, rollup, others);
      const input = JSON.stringify(rec.lines);
      h.hydrate([rec]);
      h.open(id);
      h.w.__flush();                    // drain whatever OPENING armed
      const savesBefore = h.saves();
      const indicatorBefore = (h.w.document.getElementById('ee-save-indicator') || {}).textContent;
      // _asmOpen is module state keyed by line id and lives for the life of
      // the window, so a toggle is not the same as "open". Ask for the
      // control; if the toggle closed the strip instead, toggle back.
      const control = () => Array.from(h.w.document.querySelectorAll('#ee-lines-container span'))
        .find((s) => /Explode to editable lines/.test(s.textContent || ''));
      h.w.eeToggleAsmBreakdown(String(rollup.id));
      let btn = control();
      if (!btn) { h.w.eeToggleAsmBreakdown(String(rollup.id)); btn = control(); }
      // A rollup whose recipe array is EMPTY renders no assembly strip at all,
      // so the control does not exist to click — but eeAsmExplode is a global
      // and other code can still reach it. Both doors are driven, and which
      // one was used is reported rather than papered over.
      const door = btn ? 'click' : 'direct';
      if (btn) btn.click();
      else h.w.eeAsmExplode(String(rollup.id));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      h.w.__flush();                    // let the debounced save land
      const message = h.w.__confirms[0] || null;
      const lines = h.w.appData.estimateLines;
      return {
        door,
        confirmed: message != null,
        message,
        count: quotedCount(message),
        why: h.w.__notices[0] || null,
        lines,
        unchanged: JSON.stringify(lines) === input,
        input,
        savesArmed: h.saves() > savesBefore,
        indicatorBefore,
        indicator: (h.w.document.getElementById('ee-save-indicator') || {}).textContent,
        // WHAT IS ON SCREEN — the ids the rendered table actually shows.
        rows: h.rows().map((r) => r.id),
      };
    },
  };
}

describe('PROPERTY — the estimate editor is the same door and now gives the same answer', () => {
  let NOW;
  beforeAll(() => { NOW = estHarness(null); });
  afterAll(() => { H.closeAll(); });

  const comp = (over) => Object.assign(
    { description: 'Extrusion', qty_per_unit: 1, unit_cost: 2000, cost_code: 'materials', unit: 'EA' }, over || {});
  const rollup = (over) => Object.assign({
    id: 'ROLLUP', description: 'Pool cage package', qty: 2, unitCost: 6000, unit: 'EA',
    markup: '', sourceAssemblyId: 47,
    assemblyBreakdown: [comp(), comp({ description: 'Crew day', cost_code: 'labor', unit_cost: 1500 })],
  }, over || {});
  const other = { id: 'OTHER', description: 'Base scope', qty: 1, unitCost: 10000, markup: 20 };

  test('a healthy rollup IS replaced, the count is right, the screen and the record agree', async () => {
    const r = await NOW.run(rollup(), [other]);
    expect(r.confirmed).toBe(true);
    expect(r.count).toBe(2);
    const created = r.lines.filter((l) => l.section !== '__section_header__' && l.id !== 'OTHER');
    expect(created).toHaveLength(2);
    expect(r.lines.map((l) => l.id)).not.toContain('ROLLUP');
    expect(r.savesArmed).toBe(true);
    // P4: what is painted is what is held.
    expect(r.rows).toEqual(expect.arrayContaining(r.lines.map((l) => String(l.id))));
    expect(r.rows).not.toContain('ROLLUP');
  });

  test('every empty explode: nothing changes, the screen still shows the line, and the person is told', async () => {
    const cases = [
      { name: 'credit', line: rollup({ qty: -1 }), why: /credit line \(quantity -1\)/ },
      { name: 'zero qty', line: rollup({ qty: 0 }), why: /quantity is 0/ },
      { name: 'no-charge recipe', line: rollup({ assemblyBreakdown: [comp({ qty_per_unit: 0 })] }), why: /works out to no quantity/ },
      { name: 'empty recipe', line: rollup({ assemblyBreakdown: [] }), why: /no recipe items/ },
    ];
    for (const c of cases) {
      const r = await NOW.run(c.line, [other]);
      expect({ name: c.name, unchanged: r.unchanged }).toEqual({ name: c.name, unchanged: true });
      expect({ name: c.name, confirmed: r.confirmed }).toEqual({ name: c.name, confirmed: false });
      expect(r.why).toMatch(c.why);
      expect({ name: c.name, saved: r.savesArmed }).toEqual({ name: c.name, saved: false });
      // The row is still on screen because it is still in the record — which
      // is exactly the pairing the shipped bytes broke.
      expect(r.rows).toContain('ROLLUP');
    }
  });

  test('the count is the count, over 400 records, screen and record in step', async () => {
    let proceeded = 0, refused = 0;
    const broken = [];
    for (const co of rollupCorpus(721, { count: 400 })) {
      const src = co.lines.find((l) => l.id === 'ROLLUP');
      const others = co.lines.filter((l) => l.id !== 'ROLLUP' && l.section !== '__section_header__');
      const want = expectedParts(src);
      const r = await NOW.run(src, others);
      const content = r.lines.filter((l) => l.section !== '__section_header__');
      if (want.length === 0) {
        refused++;
        if (!r.unchanged || r.confirmed || !r.why || r.savesArmed) {
          broken.push({ id: co.id, kind: 'refusal', unchanged: r.unchanged, confirmed: r.confirmed, why: r.why, saved: r.savesArmed });
        }
        if (r.rows.indexOf('ROLLUP') < 0) broken.push({ id: co.id, kind: 'row vanished off screen' });
      } else {
        proceeded++;
        const created = content.filter((l) => others.every((o) => o.id !== l.id));
        if (r.count !== created.length) broken.push({ id: co.id, kind: 'count', quoted: r.count, created: created.length });
        if (created.length !== want.length) broken.push({ id: co.id, kind: 'parts', made: created.length, want: want.length });
        if (!r.savesArmed) broken.push({ id: co.id, kind: 'mutated without arming the save' });
        if (r.rows.indexOf('ROLLUP') >= 0) broken.push({ id: co.id, kind: 'destroyed row still painted' });
        // P4, both directions: the painted content rows ARE the record's.
        const painted = r.rows.filter((id) => content.some((l) => String(l.id) === id));
        if (painted.length !== content.length) {
          broken.push({ id: co.id, kind: 'screen != record', rows: r.rows, record: content.map((l) => l.id) });
        }
      }
    }
    expect(proceeded).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(100);
    expect(broken.slice(0, 3)).toEqual([]);
    expect(broken).toHaveLength(0);
  });
});

describe('PROPERTY — the estimate editor, measured against the bytes that shipped as 1.21', () => {
  let OLD;
  beforeAll(() => { OLD = SHIPPED_EE_FILE ? estHarness(SHIPPED_EE_FILE) : null; });
  afterAll(() => { H.closeAll(); });

  test('the shipped estimate editor destroyed the line, said nothing, and saved nothing', async () => {
    expect(OLD).toBeTruthy();
    const line = { id: 'ROLLUP', description: 'Pool cage package', qty: -1, unitCost: 6000, unit: 'EA',
      markup: '', sourceAssemblyId: 47,
      assemblyBreakdown: [{ description: 'Extrusion', qty_per_unit: 1, unit_cost: 2000, cost_code: 'materials', unit: 'EA' }] };
    const other = { id: 'OTHER', description: 'Base scope', qty: 1, unitCost: 10000, markup: 20 };
    const r = await OLD.run(line, [other]);
    // It asked, promising one line...
    expect(r.count).toBe(1);
    // ...removed the rollup...
    expect(r.lines.map((l) => l.id)).not.toContain('ROLLUP');
    // ...created nothing...
    expect(r.lines.filter((l) => l.section !== '__section_header__')).toHaveLength(1);
    // ...armed no save — so the deletion sat in appData waiting for an
    // unrelated action anywhere in the app to commit it...
    expect(r.savesArmed).toBe(false);
    // ...and left the destroyed row painted on screen.
    expect(r.rows).toContain('ROLLUP');
  });

  test('the shipped count lie, on the estimate side', async () => {
    const line = { id: 'ROLLUP', description: 'Repaint', qty: 100, unitCost: 1.8, unit: 'SF',
      markup: '', sourceAssemblyId: 47,
      assemblyBreakdown: [
        { description: 'Paint', qty_per_unit: 0.005, unit_cost: 180, cost_code: 'materials', unit: 'GAL' },
        { description: 'Painter hours', qty_per_unit: 0.02, unit_cost: 45, cost_code: 'labor', unit: 'HR' },
        { description: 'Masking tape (on hand)', qty_per_unit: 0, unit_cost: 6, cost_code: 'materials', unit: 'EA' },
      ] };
    const r = await OLD.run(line, []);
    expect(r.count).toBe(3);
    expect(r.lines.filter((l) => l.section !== '__section_header__')).toHaveLength(2);
  });

  test('300 records: every explode that used to create a line still creates the same ones', async () => {
    const NOW = estHarness(null);
    let same = 0, wasDestroyed = 0;
    const moved = [];
    for (const co of rollupCorpus(731, { count: 300 })) {
      const src = co.lines.find((l) => l.id === 'ROLLUP');
      const others = co.lines.filter((l) => l.id !== 'ROLLUP' && l.section !== '__section_header__');
      const o = await OLD.run(src, others);
      const n = await NOW.run(src, others);
      const oldCreated = o.lines.filter((l) => l.section !== '__section_header__' && l.id !== 'ROLLUP'
        && others.every((x) => x.id !== l.id));
      if (oldCreated.length > 0) {
        same++;
        // Lines carry generated ids, so identity is compared on everything
        // BUT the id — description, qty, unit, cost, section, order.
        const strip = (ls) => ls.map((l) => { const c = Object.assign({}, l); delete c.id; delete c.estimateId; return c; });
        if (JSON.stringify(strip(n.lines)) !== JSON.stringify(strip(o.lines))) {
          moved.push({ id: co.id, old: strip(o.lines), now: strip(n.lines) });
        }
        if (n.count !== oldCreated.length) moved.push({ id: co.id, kind: 'count', quoted: n.count, created: oldCreated.length });
      } else {
        wasDestroyed++;
        if (o.lines.some((l) => l.id === 'ROLLUP')) moved.push({ id: co.id, kind: 'pin stale — shipped did not destroy' });
        if (!n.unchanged) moved.push({ id: co.id, kind: 'the repair still mutates' });
      }
    }
    expect(same).toBeGreaterThan(80);
    expect(wasDestroyed).toBeGreaterThan(80);
    expect(moved.slice(0, 2)).toEqual([]);
    expect(moved).toHaveLength(0);
  }, 120000);
});
