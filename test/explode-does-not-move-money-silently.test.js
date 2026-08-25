// test/explode-does-not-move-money-silently.test.js
//
// EXPLODING IS A VIEW CHANGE. IT MUST NOT BE A REPRICING — AND WHERE IT
// CANNOT HELP BEING ONE, THE DIALOG SAYS SO AND BY HOW MUCH.
//
// A rollup line takes ONE markup: its own, or the one it inherits from the
// section it sits in. Its components are routed by COST CODE, so a
// materials-plus-labour recipe lands in two different sections under two
// different markups — and the components were born with `markup: ''`, no
// per-line value at all, so each silently inherited its DESTINATION's.
//
// Measured on the bytes this replaces, 12,000 records per shape, totals read
// only from js/pricing-pipeline.js, with the rollup's unitCost set to the sum
// of its own recipe so the COST is unchanged by construction:
//
//   rollup markup      recipe          total moves   markup-drop  routing
//   blank (inherited)  spans codes        53.9%          0.0%      53.9%
//   blank (inherited)  one cost code      41.0%          0.0%       0.0%
//   typed on the row   spans codes        89.6%         88.0%       1.6%
//   typed on the row   one cost code      88.5%         88.5%       0.0%
//
// TWO REVIEWERS DISAGREED ABOUT THE CAUSE AND BOTH WERE RIGHT, ABOUT
// DIFFERENT HALVES, and the decomposition above is the settlement — it is
// reproduced as a test below rather than quoted, because it decided the fix.
// On a rollup carrying a markup somebody TYPED, the dropped markup is
// essentially the whole of it: 88.0 of 89.6 points, and forcing every
// component into ONE cost code still moves 88.5%, so re-routing is not the
// cause there. On a rollup whose markup is BLANK the drop cannot be the cause
// because there is nothing to drop: markup-drop alone moves 0.0%, and every
// dollar of the 53.9% is re-routing. Which one dominates depends entirely on
// whether a human typed a number in that row — and an assembly like a pool
// cage is materials PLUS labour by construction, so both halves are ordinary.
//
// And 48,000 of 48,000 of those confirms contained no dollar sign.
//
//   $1  THE TOTAL DOES NOT MOVE, or the dialog said it would and by how much.
//       Never a third thing, and never silence.
//   $2  THE QUOTED NUMBER IS THE NUMBER THE RECORD TAKES.
//   $3  NOTHING ALREADY SAVED REPRICES. Every line that existed before the
//       click is byte-identical after it, except the rollup that was replaced.
//       This affects records at the MOMENT of an explode and never at rest.
//   $4  INHERITANCE IS PRESERVED WHERE IT CAN BE — a component whose section
//       already resolves to the rollup's markup is left BLANK, so a later edit
//       to that section still moves it.
//   $5  COST IS NOT TOUCHED. An explode moves a price, never a cost.
//   $6  THE DECOMPOSITION, reproduced — so the reason for the rule is a test
//       and not a paragraph.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const P = require('../js/pricing-pipeline.js');
const H = require('./helpers/estimate-editor-harness.js');

const PRIOR_SHA = '8aef6d8d';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');
const prior = (rel) => execFileSync('git', ['show', PRIOR_SHA + ':' + rel],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  .split('\r\n').join('\n');

let PRIOR_EE_FILE = null;
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-prior-ee-money-'));
  PRIOR_EE_FILE = path.join(d, 'estimate-editor.js');
  fs.writeFileSync(PRIOR_EE_FILE, prior('js/estimate-editor.js'));
}

// ══════════════════════════════════════════════════════════════════════
// THE CHANGE-ORDER EDITOR FROM ITS OWN BYTES. Totals come from the editor's
// own computeTotals — which is js/pricing-pipeline.js — and are never
// re-derived here. Forking the pricing implementation to check the pricing
// implementation would prove only that the fork agrees with itself.
// ══════════════════════════════════════════════════════════════════════
function coEditor(src) {
  const cut = (a, b, opt) => {
    const i = src.indexOf(a);
    if (i < 0) { if (opt) return ''; throw new Error('anchor not found: ' + a); }
    const j = src.indexOf(b, i);
    if (j < 0) throw new Error('close anchor not found: ' + a);
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
    cut('  function coNotice(title, message) {', '\n  }\n', true),
    cut('  function coAsmRecipeRows(line) {', '\n  }\n', true),
    cut('  function coAsmExplode(lineId) {', '    } else if (confirm(msg)) doIt();\n  }\n'),
  ].join('\n');
  if (body.length < 8000) throw new Error('lift too small: ' + body.length);
  // eslint-disable-next-line no-new-func
  const build = new Function('window', 'env', `
    var _state={co:null}; var _coAsmOpen={}; var _seq=0;
    function newLineId(){return 'gen_'+(++_seq);}
    function markDirty(){env.dirty++;} function paintLines(){} function paintTotals(){}
    function alert(m){env.natives.push(String(m));}
${body}
    return { setCo:function(c){_state.co=c;_coAsmOpen={};_seq=0;}, getCo:function(){return _state.co;},
      explode:coAsmExplode, totals:computeTotals, addOne:coApplyAddLineItem, fmt:fmtCurrency };`);
  const env = { dirty: 0, natives: [] };
  const st = { msg: null, notices: [] };
  const ed = build({ p86Pricing: P,
    p86Confirm: (o) => { st.msg = o.message; return { then: (f) => f(true) }; },
    p86Alert: (o) => { st.notices.push(o.message); } }, env);
  return {
    fmt: ed.fmt,
    raw: ed,
    total(rec) { ed.setCo(JSON.parse(JSON.stringify(rec))); const t = ed.totals(); return t ? t.total : null; },
    run(rec, id) {
      st.msg = null; st.notices = []; env.natives = []; env.dirty = 0;
      ed.setCo(JSON.parse(JSON.stringify(rec)));
      const t = ed.totals();
      const before = t ? t.total : null;
      const subBefore = t ? t.subtotal : null;
      ed.explode(id);
      const t2 = ed.totals();
      return { before, subBefore, after: t2 ? t2.total : null, subAfter: t2 ? t2.subtotal : null,
        msg: st.msg, refused: st.notices.length > 0 || env.natives.length > 0, record: ed.getCo() };
    },
  };
}
const NOW = coEditor(read('js/change-order-editor.js'));
const OLD = coEditor(prior('js/change-order-editor.js'));

// ══════════════════════════════════════════════════════════════════════
// THE CORPUS. Deliberately generated around the FOUR shapes the decomposition
// separates, because a corpus that mixes them measures an average of two
// different diseases and points at neither.
//
// The rollup's unitCost is the SUM OF ITS OWN RECIPE — which is what
// coAsmRefresh writes. Without that, an explode changes COST as well as price
// and every record "moves" for a reason that has nothing to do with markup.
// Getting this wrong is how a first measurement reported 100% movement on
// every shape, which is the tell.
// ══════════════════════════════════════════════════════════════════════
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CODES = ['materials', 'labor', 'gc', 'sub'];
const SEC = { materials: 'MATERIALS', labor: 'LABOR', gc: 'GENERAL CONDITIONS', sub: 'SUBCONTRACTORS' };

function corpus(seed, opt) {
  const r = rng(seed);
  const out = [];
  for (let n = 0; n < opt.count; n++) {
    const lines = [];
    const nSec = 1 + Math.floor(r() * 2);
    for (let s = 0; s < nSec; s++) {
      const code = CODES[Math.floor(r() * 4)];
      const hdr = { id: 'h' + s, section: '__section_header__', label: SEC[code], btCategory: code,
        markupMode: 'percent', markup: r() < 0.35 ? '' : [10, 15, 20, 25, 30][Math.floor(r() * 5)] };
      // A fifth of headers carry NO btCategory — legacy rows, AI-created
      // sections, and anything added through the custom-name door. Those are
      // matched BY LABEL and coEnsureSection back-fills the category on them,
      // so the corpus has to contain the shape or the "nothing already saved
      // changes" property below is passing on a population that cannot fail it.
      if (r() < 0.20) delete hdr.btCategory;
      if (opt.dollarSections && r() < 0.25) { hdr.markupMode = 'dollar'; hdr.markup = [500, 1200, 2500][Math.floor(r() * 3)]; }
      if (opt.dollarSections && r() < 0.20) hdr.overrideLineMarkups = true;
      lines.push(hdr);
      const nl = Math.floor(r() * 3);
      for (let i = 0; i < nl; i++) {
        lines.push({ id: 'o' + s + '_' + i, description: 'Line ' + s + i,
          qty: [1, 2, 5][Math.floor(r() * 3)], unitCost: Math.round((5 + r() * 900) * 100) / 100,
          markup: r() < 0.4 ? '' : [10, 18, 22][Math.floor(r() * 3)], markupMode: 'percent' });
      }
    }
    const nb = 2 + Math.floor(r() * 3);
    const bd = [];
    for (let b = 0; b < nb; b++) {
      bd.push({ description: 'comp' + b, qty_per_unit: [0.02, 0.5, 1, 2, 3][Math.floor(r() * 5)],
        unit_cost: Math.round((r() * 500 + 5) * 100) / 100,
        cost_code: opt.oneCode ? 'materials' : CODES[Math.floor(r() * 4)], unit: 'ea' });
    }
    if (!opt.oneCode && nb > 1) { bd[0].cost_code = 'materials'; bd[1].cost_code = 'labor'; }
    const rollup = { id: 'ROLLUP', description: 'Pool cage package',
      qty: [1, 2, 3, 10][Math.floor(r() * 4)],
      unitCost: Math.round(bd.reduce((s, b) => s + b.qty_per_unit * b.unit_cost, 0) * 10000) / 10000,
      unit: 'ea', markupMode: 'percent',
      markup: opt.typedMarkup ? [12, 18, 25, 35, 45][Math.floor(r() * 5)] : '',
      sourceAssemblyId: 40 + Math.floor(r() * 9), assemblyBreakdown: bd };
    if (opt.promised && r() < 0.4) rollup.unitSell = Math.round(rollup.unitCost * (1 + r()) * 100) / 100;
    lines.splice(1 + Math.floor(r() * lines.length), 0, rollup);
    const rec = { id: 'co_' + n, title: 'CO ' + n, lines, defaultMarkup: [0, 10, 20, 25][Math.floor(r() * 4)] };
    if (r() < 0.30) rec.taxPct = [4, 6, 7][Math.floor(r() * 3)];
    if (r() < 0.20) rec.feePct = [1, 3, 5][Math.floor(r() * 3)];
    if (r() < 0.15) rec.feeFlat = [100, 500, 1200][Math.floor(r() * 3)];
    if (opt.roundTo && r() < 0.35) rec.roundTo = [25, 100, 500][Math.floor(r() * 3)];
    out.push(rec);
  }
  return out;
}

// EVERY FIELD THE MARKUP CASCADE AND THE TOTALS READ. If an explode leaves all
// of these untouched on a line that already existed, that line did not reprice
// — which is the whole claim, stated as the list of things it is about.
const MONEY_KEYS = ['qty', 'unitCost', 'unitSell', 'markup', 'markupMode',
  'overrideLineMarkups', 'section', 'costPending'];

const SHAPES = [
  ['blank markup · recipe spans cost codes', { seed: 11, typedMarkup: false, oneCode: false, roundTo: true }],
  ['blank markup · one cost code',           { seed: 12, typedMarkup: false, oneCode: true,  roundTo: true }],
  ['typed markup · recipe spans cost codes', { seed: 13, typedMarkup: true,  oneCode: false, roundTo: true }],
  ['typed markup · one cost code',           { seed: 14, typedMarkup: true,  oneCode: true,  roundTo: true }],
];
const N = 3000;

// The sentence, as a person reads it. The dialog is the only thing a person
// sees, so the assertions are on its TEXT.
const MOVES_RE = /changes the change order total from \$([\d,.\-]+) to \$([\d,.\-]+) — (up|down) \$([\d,.\-]+)\./;
const STILL_RE = /The change order total does not change\./;
const money = (s) => Number(String(s).replace(/,/g, ''));

// "THE QUOTED FIGURE IS THE RECORD'S FIGURE" MEANS TO THE CENT, AND THE CENT
// IS AS FAR AS IT CAN MEAN.
//
// fmtCurrency prints two decimals. A total of 17,260.605 prints as $17,260.61,
// which is half a cent away from the number the record holds and is the only
// thing a currency display can do with it. Measured across 1,151 disclosed
// moves on the promised-rollup corpus, the LARGEST absolute error across every
// figure in every sentence is exactly $0.005 — never $0.006, never a cent.
// So the tolerance is half a cent plus float slop, and anything beyond that is
// a real disagreement between the dialog and the record.
const CENT = 0.005 + 1e-6;
const quotesTheRecord = (quoted, actual) => Math.abs(money(quoted) - actual) <= CENT;

// ══════════════════════════════════════════════════════════════════════
// $1 + $2 — THE TOTAL DOES NOT MOVE, OR THE DIALOG SAID SO AND BY HOW MUCH.
// ══════════════════════════════════════════════════════════════════════
describe('$1 no total moves silently, in any shape', () => {
  test.each(SHAPES)('CHANGE ORDER — %s', (label, opt) => {
    const cs = corpus(opt.seed, Object.assign({ count: N }, opt));
    let silent = 0, moved = 0, wrongNumber = 0, saidStill = 0, priorMoved = 0;
    for (const rec of cs) {
      const a = NOW.run(rec, 'ROLLUP');
      if (a.refused) continue;
      const b = OLD.run(rec, 'ROLLUP');
      if (Math.abs(b.after - b.before) >= 0.005) priorMoved++;
      const delta = a.after - a.before;
      const m = (a.msg || '').match(MOVES_RE);
      if (Math.abs(delta) >= 0.005) {
        moved++;
        if (!m) { silent++; continue; }
        // The number in the sentence is the number the record took — to the
        // cent, which is all a two-decimal formatter can express.
        if (!quotesTheRecord(m[2], a.after)) wrongNumber++;
        if (!quotesTheRecord(m[1], a.before)) wrongNumber++;
        if (m[3] !== (delta > 0 ? 'up' : 'down')) wrongNumber++;
        if (!quotesTheRecord(m[4], Math.abs(delta))) wrongNumber++;
      } else {
        if (!STILL_RE.test(a.msg || '')) silent++;
        else saidStill++;
      }
    }
    // THE PRIOR BYTES MOVED MONEY ON THIS CORPUS. Without this the whole
    // describe could pass on a corpus where nothing was ever at stake.
    expect(priorMoved).toBeGreaterThan(0);
    expect(silent).toBe(0);
    expect(wrongNumber).toBe(0);
    expect(saidStill + moved).toBeGreaterThan(N * 0.9);
  });

  test('CHANGE ORDER — promised rollups: the promise drop is disclosed as a number', () => {
    const cs = corpus(31, { count: N, typedMarkup: true, oneCode: false, roundTo: true, promised: true });
    let promised = 0, silent = 0, moved = 0, wrongNumber = 0;
    for (const rec of cs) {
      const roll = rec.lines.find((l) => l.id === 'ROLLUP');
      if (!P.sellLocked(roll)) continue;
      promised++;
      const a = NOW.run(rec, 'ROLLUP');
      if (a.refused) { promised--; continue; }
      expect(a.msg).toMatch(/promised sell price of/);
      const delta = a.after - a.before;
      if (Math.abs(delta) >= 0.005) {
        moved++;
        const m = (a.msg || '').match(MOVES_RE);
        if (!m) { silent++; continue; }
        // EVERY FIGURE IN THE SENTENCE, against the record. A dialog that
        // raises the right branch and prints the wrong number is the same
        // defect wearing a disclosure.
        if (!quotesTheRecord(m[1], a.before)) wrongNumber++;
        if (!quotesTheRecord(m[2], a.after)) wrongNumber++;
        if (m[3] !== (delta > 0 ? 'up' : 'down')) wrongNumber++;
        if (!quotesTheRecord(m[4], Math.abs(delta))) wrongNumber++;
      } else if (!STILL_RE.test(a.msg)) silent++;
    }
    expect(promised).toBeGreaterThan(500);
    // The promise drop really does move most of them — otherwise the number
    // checks above are running on an empty set.
    expect(moved).toBeGreaterThan(promised * 0.5);
    expect(silent).toBe(0);
    expect(wrongNumber).toBe(0);
  });

  test('CHANGE ORDER — a rollup whose unitCost has drifted from its recipe: the move is quoted exactly', () => {
    // The markup carry cannot help here and is not supposed to: the stored
    // unitCost is simply not what the recipe costs any more (nobody has hit
    // "Reprice from recipe" since the catalog moved), so exploding changes the
    // COST and the total with it. This is the case the simulation exists for —
    // the number is measured, not predicted, so no rule has to know about it.
    const rec = { id: 'co_drift', title: 'drift', defaultMarkup: 20, lines: [
      { id: 'h0', section: '__section_header__', label: 'MATERIALS', btCategory: 'materials', markup: 25, markupMode: 'percent' },
      { id: 'ROLLUP', description: 'Kit', qty: 2, unitCost: 1000, unit: 'ea', markup: '', markupMode: 'percent',
        sourceAssemblyId: 7, assemblyBreakdown: [
          { description: 'A', qty_per_unit: 1, unit_cost: 100, cost_code: 'materials', unit: 'ea' },
          { description: 'B', qty_per_unit: 1, unit_cost: 150, cost_code: 'materials', unit: 'ea' }] },
    ] };
    const a = NOW.run(rec, 'ROLLUP');
    const delta = a.after - a.before;
    expect(Math.abs(delta)).toBeGreaterThan(0.005);      // it really does move
    const m = (a.msg || '').match(MOVES_RE);
    expect(m).toBeTruthy();
    expect(quotesTheRecord(m[1], a.before)).toBe(true);
    expect(quotesTheRecord(m[2], a.after)).toBe(true);
    expect(m[3]).toBe(delta > 0 ? 'up' : 'down');
    expect(quotesTheRecord(m[4], Math.abs(delta))).toBe(true);
    // The two numbers are DIFFERENT numbers — a sentence that quoted the same
    // total twice would satisfy a laxer check and say nothing at all.
    expect(m[1]).not.toBe(m[2]);
    // The PRIOR bytes moved it too, and mentioned no money.
    const b = OLD.run(rec, 'ROLLUP');
    expect(Math.abs(b.after - b.before)).toBeGreaterThan(0.005);
    expect((b.msg || '').indexOf('$')).toBe(-1);
  });

  test('CHANGE ORDER — the PRIOR bytes moved the total and said nothing', () => {
    const cs = corpus(11, { count: N, typedMarkup: false, oneCode: false, roundTo: true });
    let moved = 0, silentMoves = 0, anyDollar = 0;
    for (const rec of cs) {
      const b = OLD.run(rec, 'ROLLUP');
      if (b.refused || b.msg == null) continue;
      if ((b.msg || '').indexOf('$') >= 0) anyDollar++;
      if (Math.abs(b.after - b.before) >= 0.005) {
        moved++;
        if ((b.msg || '').indexOf('$') < 0) silentMoves++;
      }
    }
    expect(moved).toBeGreaterThan(N * 0.3);   // it moved on a third or more
    expect(anyDollar).toBe(0);                // and never mentioned money
    expect(silentMoves).toBe(moved);
  });
});

// ══════════════════════════════════════════════════════════════════════
// $3 — NOTHING ALREADY SAVED REPRICES.
// ══════════════════════════════════════════════════════════════════════
describe('$3 the explode touches only the rollup and the lines it creates', () => {
  test.each(SHAPES)('CHANGE ORDER — %s: every pre-existing line is byte-identical after', (label, opt) => {
    const cs = corpus(opt.seed + 500, Object.assign({ count: N }, opt));
    const damaged = [];
    for (const rec of cs) {
      const a = NOW.run(rec, 'ROLLUP');
      if (a.refused) continue;
      const wasById = {};
      rec.lines.forEach((l) => { wasById[String(l.id)] = JSON.stringify(l); });
      // THE PROPERTY. Every line the record already had is still there, in the
      // same relative order, with not one byte changed — no markup written on
      // to a neighbour, no section re-labelled, no reorder. Section membership
      // on a change order is POSITIONAL, so order is money.
      const survivors = a.record.lines.filter((l) => wasById[String(l.id)] !== undefined);
      const expectedOrder = rec.lines.filter((l) => String(l.id) !== 'ROLLUP').map((l) => String(l.id));
      if (survivors.map((l) => String(l.id)).join(',') !== expectedOrder.join(',')) {
        damaged.push({ id: rec.id, kind: 'order' });
        continue;
      }
      survivors.forEach((l) => {
        const was = JSON.parse(wasById[String(l.id)]);
        // MONEY, not bytes. coEnsureSection back-fills `btCategory` on a header
        // it matched BY LABEL and that carried none — a routing label that
        // predates all of this work and that appears nowhere in
        // js/pricing-pipeline.js (asserted in the estimate block below). That
        // one key is exempt; everything that prices is held exactly.
        MONEY_KEYS.forEach((k) => {
          if (JSON.stringify(l[k]) !== JSON.stringify(was[k])) {
            damaged.push({ id: rec.id, kind: 'repriced ' + k, line: l.id, was: was[k], now: l[k] });
          }
        });
        const a2 = Object.assign({}, l); delete a2.btCategory;
        const b2 = Object.assign({}, was); delete b2.btCategory;
        if (JSON.stringify(a2) !== JSON.stringify(b2)) {
          damaged.push({ id: rec.id, kind: 'bytes', line: l.id });
        }
      });
      // The rollup is gone, exactly once.
      if (a.record.lines.some((l) => String(l.id) === 'ROLLUP')) damaged.push({ id: rec.id, kind: 'rollup kept' });
    }
    expect(damaged.slice(0, 3)).toEqual([]);
    expect(damaged).toHaveLength(0);
  });

  test('a record AT REST is never repriced — opening and pricing it changes nothing', () => {
    // The distinction the whole commit rests on: this affects records at the
    // MOMENT of an explode and never at rest. If merely pricing a record could
    // move it, every saved change order in the database would be at risk on the
    // next page load, which is a completely different and much worse claim.
    const cs = corpus(999, { count: 500, typedMarkup: true, oneCode: false, roundTo: true, promised: true });
    for (const rec of cs) {
      const before = JSON.stringify(rec);
      NOW.total(rec);
      NOW.total(rec);
      expect(JSON.stringify(rec)).toBe(before);
    }
  });

  test('the markup carry writes ONLY on lines the explode creates', () => {
    const cs = corpus(321, { count: 1000, typedMarkup: true, oneCode: false, roundTo: true });
    for (const rec of cs) {
      const a = NOW.run(rec, 'ROLLUP');
      if (a.refused) continue;
      const known = {};
      rec.lines.forEach((l) => { known[String(l.id)] = l; });
      a.record.lines.forEach((l) => {
        if (known[String(l.id)]) {
          expect(l.markup).toEqual(known[String(l.id)].markup);
          expect(l.markupMode).toEqual(known[String(l.id)].markupMode);
        }
      });
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// $4 — INHERITANCE IS PRESERVED WHERE IT CAN BE.
// ══════════════════════════════════════════════════════════════════════
describe('$4 a component is left inheriting when its section already gives the right number', () => {
  test('a single-cost-code recipe under a blank rollup stamps NOTHING', () => {
    // The rollup inherits its section's markup; every component lands in that
    // same section and inherits the same number. Writing it out explicitly
    // would detach those lines from the section for good.
    const rec = { id: 'co_x', title: 'x', defaultMarkup: 20, lines: [
      { id: 'h0', section: '__section_header__', label: 'MATERIALS', btCategory: 'materials', markup: 15, markupMode: 'percent' },
      { id: 'ROLLUP', description: 'Kit', qty: 2, unitCost: 300, unit: 'ea', markup: '', markupMode: 'percent',
        sourceAssemblyId: 7, assemblyBreakdown: [
          { description: 'A', qty_per_unit: 1, unit_cost: 100, cost_code: 'materials', unit: 'ea' },
          { description: 'B', qty_per_unit: 1, unit_cost: 200, cost_code: 'materials', unit: 'ea' }] },
    ] };
    const a = NOW.run(rec, 'ROLLUP');
    const created = a.record.lines.filter((l) => String(l.id).indexOf('gen_') === 0 && l.section !== '__section_header__');
    expect(created).toHaveLength(2);
    created.forEach((l) => expect(l.markup).toBe(''));       // still inheriting
    expect(Math.abs(a.after - a.before)).toBeLessThan
      ? expect(Math.abs(a.after - a.before)).toBeLessThan(0.005)
      : null;
    // …and moving the section markup afterwards still moves them.
    const moved = JSON.parse(JSON.stringify(a.record));
    moved.lines.find((l) => l.id === 'h0').markup = 50;
    expect(NOW.total(moved)).toBeGreaterThan(a.after);
  });

  test('a cross-cost-code recipe stamps the rollup number on the components that need it', () => {
    // THE ROLLUP SITS BETWEEN THE TWO HEADERS, so it is INSIDE Materials.
    // Section membership on a change order is POSITIONAL — a line belongs to
    // the nearest header above it — and putting the rollup after both headers
    // would put it in Labor and invert everything this test claims. It is
    // spelled out because the first draft of this test got it wrong and the
    // shipped code was right.
    const rec = { id: 'co_y', title: 'y', defaultMarkup: 20, lines: [
      { id: 'h0', section: '__section_header__', label: 'MATERIALS', btCategory: 'materials', markup: 15, markupMode: 'percent' },
      { id: 'ROLLUP', description: 'Kit', qty: 2, unitCost: 300, unit: 'ea', markup: '', markupMode: 'percent',
        sourceAssemblyId: 7, assemblyBreakdown: [
          { description: 'A', qty_per_unit: 1, unit_cost: 100, cost_code: 'materials', unit: 'ea' },
          { description: 'B', qty_per_unit: 1, unit_cost: 200, cost_code: 'labor', unit: 'ea' }] },
      { id: 'h1', section: '__section_header__', label: 'Labor', btCategory: 'labor', markup: 40, markupMode: 'percent' },
    ] };
    // The rollup inherits Materials' 15%.
    expect(P.effectiveMarkupForLine(rec.lines[1], rec.lines, rec)).toBe(15);
    const a = NOW.run(rec, 'ROLLUP');
    const byDesc = {};
    a.record.lines.forEach((l) => { if (l.description) byDesc[l.description] = l; });
    // A stays in Materials and keeps INHERITING — nothing is written on it, so
    // a later edit to that section still moves it. B is routed to Labor, which
    // resolves to 40%, so it carries the rollup's 15 explicitly.
    expect(byDesc.A.markup).toBe('');
    expect(byDesc.B.markup).toBe(15);
    expect(Math.abs(a.after - a.before)).toBeLessThan(0.005);
    // The PRIOR bytes let B take Labor's 40% and said nothing.
    const b = OLD.run(rec, 'ROLLUP');
    const oldB = b.record.lines.find((l) => l.description === 'B');
    expect(oldB.markup).toBe('');
    expect(Math.abs(b.after - b.before)).toBeGreaterThan(0.005);
    expect((b.msg || '').indexOf('$')).toBe(-1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// $5 — COST IS NOT TOUCHED.
// ══════════════════════════════════════════════════════════════════════
describe('$5 an explode moves a price, never a cost', () => {
  test.each(SHAPES)('CHANGE ORDER — %s: the cost subtotal is unchanged', (label, opt) => {
    const cs = corpus(opt.seed + 900, Object.assign({ count: 1500 }, opt));
    const moved = [];
    for (const rec of cs) {
      const a = NOW.run(rec, 'ROLLUP');
      if (a.refused) continue;
      // The corpus sets the rollup's unitCost to the sum of its own recipe, so
      // cost is preserved by construction; a penny of drift here would mean the
      // adder is reinterpreting unitCost as something else.
      if (Math.abs(a.subAfter - a.subBefore) > 0.02) moved.push({ id: rec.id, d: a.subAfter - a.subBefore });
    }
    expect(moved.slice(0, 3)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// $6 — THE DECOMPOSITION THAT DECIDED THE FIX.
// ══════════════════════════════════════════════════════════════════════
describe('$6 the two reviewers were right about different halves', () => {
  // A = the shipped explode.
  // M = the markup dropped, components placed at the ROLLUP'S OWN INDEX, so
  //     nothing is re-routed. Isolates the dropped markup.
  // R = routed exactly as shipped, components CARRYING the rollup's markup.
  //     Isolates the re-routing (and is the rule that ships).
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function specsOf(roll) {
    const q = P.num(roll.qty);
    return (roll.assemblyBreakdown || []).map((b) => ({
      description: b.description, qty: Math.round(q * P.num(b.qty_per_unit) * 100) / 100,
      unit: b.unit || 'ea', unit_cost: b.unit_cost != null ? P.num(b.unit_cost) : 0,
      cost_code: b.cost_code || 'materials', source_assembly_id: roll.sourceAssemblyId,
    })).filter((s) => s.qty > 0);
  }
  function variantM(rec) {
    const c = clone(rec);
    const i = c.lines.findIndex((l) => l.id === 'ROLLUP');
    const parts = specsOf(c.lines[i]).map((s, k) => ({ id: 'm' + k, description: s.description,
      qty: s.qty, unit: s.unit, unitCost: s.unit_cost, markup: '', markupMode: 'percent' }));
    c.lines.splice(i, 1, ...parts);
    return c;
  }
  function rate(seed, opt, variant) {
    const cs = corpus(seed, Object.assign({ count: 2000 }, opt));
    let n = 0, moved = 0;
    for (const rec of cs) {
      const t0 = OLD.total(rec);
      let t1;
      if (variant === 'A') { const a = OLD.run(rec, 'ROLLUP'); if (a.refused) continue; t1 = a.after; }
      else if (variant === 'M') { t1 = OLD.total(variantM(rec)); }
      else { const a = NOW.run(rec, 'ROLLUP'); if (a.refused) continue; t1 = a.after; }
      n++;
      if (Math.abs(t1 - t0) >= 0.005) moved++;
    }
    return 100 * moved / n;
  }

  test('a BLANK rollup: the drop explains none of it — re-routing explains all of it', () => {
    const opt = { typedMarkup: false, oneCode: false, roundTo: true };
    const A = rate(11, opt, 'A');
    const M = rate(11, opt, 'M');
    const R = rate(11, opt, 'R');
    expect(A).toBeGreaterThan(30);   // the shipped explode moves the total often
    expect(M).toBeLessThan(0.5);     // dropping a markup it never had moves nothing
    expect(R).toBeLessThan(0.5);     // carrying it back holds the total still
  });

  test('a blank rollup with a SINGLE-cost-code recipe barely moves — so routing is the cause', () => {
    const one = rate(12, { typedMarkup: false, oneCode: true, roundTo: true }, 'A');
    const many = rate(11, { typedMarkup: false, oneCode: false, roundTo: true }, 'A');
    expect(many).toBeGreaterThan(one);
  });

  test('a TYPED rollup: the drop explains almost all of it', () => {
    const opt = { typedMarkup: true, oneCode: false, roundTo: true };
    const A = rate(13, opt, 'A');
    const M = rate(13, opt, 'M');
    const R = rate(13, opt, 'R');
    expect(A).toBeGreaterThan(80);
    expect(M).toBeGreaterThan(A - 5);   // the drop alone reproduces nearly the whole rate
    expect(R).toBeLessThan(0.5);        // and carrying it back still holds the total
  });

  test('a typed rollup forced into ONE cost code still moves — routing is not the cause there', () => {
    expect(rate(14, { typedMarkup: true, oneCode: true, roundTo: true }, 'A')).toBeGreaterThan(80);
  });

  test('$-mode sections and overrideLineMarkups are the residual, and they are DISCLOSED', () => {
    // The two cascade rules that ignore a per-line markup BY DESIGN, so the
    // carry cannot reach them. They are not hidden — they are priced by the
    // simulation and quoted like any other move.
    const cs = corpus(22, { count: 2000, typedMarkup: true, oneCode: false, roundTo: false, dollarSections: true });
    let moved = 0, disclosed = 0, n = 0;
    for (const rec of cs) {
      const a = NOW.run(rec, 'ROLLUP');
      if (a.refused) continue;
      n++;
      if (Math.abs(a.after - a.before) >= 0.005) { moved++; if (MOVES_RE.test(a.msg || '')) disclosed++; }
    }
    expect(moved).toBeGreaterThan(0);        // the residual is real
    expect(moved / n).toBeLessThan(0.15);    // and small
    expect(disclosed).toBe(moved);           // and every one of it is said out loud
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE ESTIMATE EDITOR — driven through its real click path in jsdom.
// ══════════════════════════════════════════════════════════════════════
describe('the estimate editor, which never had a money sentence at all', () => {
  const EE_MOVES = /changes the estimate total from \$([\d,.\-]+) to \$([\d,.\-]+) — (up|down) \$([\d,.\-]+)\./;
  const EE_STILL = /The estimate total does not change\./;

  function eeRecord(id, opt) {
    const o = opt || {};
    return { id: id, title: 'Est ' + id, activeAlternateId: 'a_' + id,
      alternates: [{ id: 'a_' + id, name: 'Base Bid' }], defaultMarkup: 20,
      lines: [
        { id: 's_' + id, estimateId: id, alternateId: 'a_' + id, section: '__section_header__',
          description: 'Materials & Supplies Costs', markup: o.sectionMarkup === undefined ? 15 : o.sectionMarkup, markupMode: 'percent' },
        { id: 'o_' + id, estimateId: id, alternateId: 'a_' + id, description: 'Existing line',
          qty: 2, unitCost: 100, markup: '' },
        { id: 'R_' + id, estimateId: id, alternateId: 'a_' + id, description: 'Pool cage package',
          qty: 2, unitCost: 300, unit: 'ea', markup: o.rollupMarkup === undefined ? '' : o.rollupMarkup,
          sourceAssemblyId: 41, assemblyBreakdown: o.recipe || [
            { description: 'Extrusion', qty_per_unit: 1, unit_cost: 100, cost_code: 'materials', unit: 'ea' },
            { description: 'Crew day', qty_per_unit: 1, unit_cost: 200, cost_code: 'labor', unit: 'HR' }] },
      ] };
  }

  // THE TOTAL COMES FROM js/pricing-pipeline.js, NOT FROM A MODEL OF IT.
  //
  // The estimate editor does not expose computeTotals, and a seam added to a
  // shipped file for a test's benefit is public surface bought with somebody
  // else's money. H.priceGroup calls the SAME chain computeTotals calls —
  // computeForLines → resolveMarkedUp → applyFeesAndTax — on the same group
  // slice, which for a single-alternate record with no target margin is the
  // identical number. That equivalence is asserted below rather than assumed.
  const totalOf = (w, rec) =>
    Number(H.priceGroup(P, rec, w.appData.estimateLines.filter((l) => l && l.estimateId === rec.id),
      'a_' + rec.id).total);

  function eeRun(rec, opts) {
    const o = opts || {};
    const h = H.boot(o.editorFile ? { editorFile: o.editorFile } : {});
    h.w.p86Alert = () => {};
    let msg = null, raised = false;
    h.w.p86Confirm = (x) => { msg = x.message; raised = true; return { then: (f) => f(true) }; };
    h.hydrate([rec]);
    h.open(rec.id);
    const before = totalOf(h.w, rec);
    const wasById = {};
    rec.lines.forEach((l) => { wasById[String(l.id)] = JSON.stringify(l); });
    h.w.eeAsmExplode('R_' + rec.id);
    const lines = h.w.appData.estimateLines.filter((l) => l && l.estimateId === rec.id);
    const after = totalOf(h.w, rec);
    h.w.close();
    return { msg, raised, before, after, lines, wasById };
  }

  test('the totals this suite reads agree with the dialog the editor writes', () => {
    // Non-vacuity, both ways: the number is a real number, and the sentence the
    // shipped editor produces quotes the same one. If these ever diverge, every
    // assertion below is measuring a different record than the person sees.
    const r = eeRun(eeRecord('e1'));
    expect(Number.isFinite(r.before)).toBe(true);
    expect(Number.isFinite(r.after)).toBe(true);
    expect(r.before).toBeGreaterThan(0);
    const m = (r.msg || '').match(EE_MOVES);
    if (m) {
      expect(Math.abs(Number(m[1].replace(/,/g, '')) - r.before)).toBeLessThanOrEqual(CENT);
      expect(Math.abs(Number(m[2].replace(/,/g, '')) - r.after)).toBeLessThanOrEqual(CENT);
    } else {
      expect(r.msg).toMatch(EE_STILL);
      expect(Math.abs(r.after - r.before)).toBeLessThan(0.005);
    }
  });

  test('a cross-cost-code explode holds the estimate total still, and says so', () => {
    const r = eeRun(eeRecord('e2'));
    expect(r.raised).toBe(true);
    expect(Math.abs(r.after - r.before)).toBeLessThan(0.005);
    expect(r.msg).toMatch(EE_STILL);
    // The Direct Labor component carries the rollup's 15 so it does not take
    // whatever Direct Labor resolves to.
    const crew = r.lines.find((l) => l.description === 'Crew day');
    expect(crew).toBeTruthy();
    expect(crew.markup).toBe(15);
  });

  test('the PRIOR bytes moved that same total and never mentioned money', () => {
    const r = eeRun(eeRecord('e3'), { editorFile: PRIOR_EE_FILE });
    expect(r.raised).toBe(true);
    expect(Math.abs(r.after - r.before)).toBeGreaterThan(0.005);
    expect(r.msg.indexOf('$')).toBe(-1);
  });

  test('nothing already on the estimate is repriced by the explode', () => {
    const r = eeRun(eeRecord('e4'));
    r.lines.forEach((l) => {
      const was = r.wasById[String(l.id)];
      if (was === undefined) return;
      const before = JSON.parse(was);
      // MONEY, not bytes — and the difference is a real one worth naming.
      //
      // eeEnsureSectionByCategory back-fills `btCategory` on a header it
      // matched BY NAME and that carried none (custom-add / AI / legacy rows).
      // That is a routing label, it predates all of this work, and it is not a
      // pricing input: `btCategory` appears nowhere in js/pricing-pipeline.js,
      // which is asserted below rather than claimed. Everything that DOES
      // price is held byte-for-byte.
      MONEY_KEYS.forEach((k) => expect([l.id, k, l[k]]).toEqual([l.id, k, before[k]]));
      // And the ONLY thing allowed to differ is that one key.
      const strippedNow = Object.assign({}, l); delete strippedNow.btCategory;
      const strippedWas = Object.assign({}, before); delete strippedWas.btCategory;
      expect(JSON.stringify(strippedNow)).toBe(JSON.stringify(strippedWas));
    });
    // …and the rollup is the one thing that went.
    expect(r.lines.some((l) => l.id === 'R_e4')).toBe(false);
  });

  test('btCategory really is not a pricing input', () => {
    // The exemption above is only defensible if this holds.
    expect(read('js/pricing-pipeline.js')).not.toContain('btCategory');
  });

  test('where the total cannot be held still, the estimate dialog quotes the number', () => {
    // A rollup whose stored unitCost has drifted from its own recipe — nobody
    // has hit "Refresh price from recipe" since the catalog moved. The markup
    // carry cannot help and is not meant to: exploding changes the COST, so the
    // total goes with it. The number is MEASURED off the simulation, which is
    // why no rule has to know this case exists.
    const rec = eeRecord('e5');
    rec.lines[2].unitCost = 1000;    // recipe costs 300
    const r = eeRun(rec);
    expect(r.raised).toBe(true);
    const delta = r.after - r.before;
    expect(Math.abs(delta)).toBeGreaterThan(0.005);      // it really does move
    const m = r.msg.match(EE_MOVES);
    expect(m).toBeTruthy();
    const money = (s) => Number(String(s).replace(/,/g, ''));
    expect(Math.abs(money(m[1]) - r.before)).toBeLessThanOrEqual(CENT);
    expect(Math.abs(money(m[2]) - r.after)).toBeLessThanOrEqual(CENT);
    expect(m[3]).toBe(delta > 0 ? 'up' : 'down');
    expect(quotesTheRecord(m[4], Math.abs(delta))).toBe(true);
    // The two totals are DIFFERENT numbers — quoting the same one twice would
    // satisfy a laxer check while telling the person nothing.
    expect(m[1]).not.toBe(m[2]);
  });

  test('a $-mode section is the other disclosed case, and it is disclosed', () => {
    // One of the two cascade rules that ignore a per-line markup BY DESIGN, so
    // the carry cannot reach it. Whatever it does to the total, the dialog says.
    const rec = eeRecord('e7');
    rec.lines[0].markupMode = 'dollar';
    rec.lines[0].markup = 1000;
    const r = eeRun(rec);
    expect(r.raised).toBe(true);
    if (Math.abs(r.after - r.before) >= 0.005) {
      const m = r.msg.match(EE_MOVES);
      expect(m).toBeTruthy();
      expect(Math.abs(Number(m[2].replace(/,/g, '')) - r.after)).toBeLessThanOrEqual(CENT);
    } else {
      expect(r.msg).toMatch(EE_STILL);
    }
  });

  test('a single-cost-code recipe leaves every component inheriting', () => {
    const rec = eeRecord('e6', { recipe: [
      { description: 'A', qty_per_unit: 1, unit_cost: 100, cost_code: 'materials', unit: 'ea' },
      { description: 'B', qty_per_unit: 1, unit_cost: 200, cost_code: 'materials', unit: 'ea' }] });
    const r = eeRun(rec);
    const made = r.lines.filter((l) => l.description === 'A' || l.description === 'B');
    expect(made).toHaveLength(2);
    made.forEach((l) => expect(l.markup).toBe(''));
    expect(r.msg).toMatch(EE_STILL);
  });
});

afterAll(() => H.closeAll());
