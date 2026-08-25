// test/co-fees-decision-is-state.test.js
//
// THE PAUSE IS STATE, NOT AN ARGUMENT A CALLER MAY FORGET.
//
// Commit 6103b52d collapsed two client-price gates into one because the Total
// chip and the server honoured a price the rows had refused — 2.52% of
// client-priced change orders, median $4,857.61 apart. That repair is sound.
// The same CLASS survived one level down, in the signature of the function it
// was fixed in:
//
//     applyFeesAndTax(markedUp, rec, honoured)   ← honoured was OPTIONAL
//
// and when it was omitted the function RE-DECIDED the round-to pause by
// walking `rec.lines`. So a caller could hand over a number priced from one
// array and get a decision taken on another. js/change-order-editor.js did
// exactly that: it priced `sim` (the post-explode array) and let the pause be
// decided from `_state.co` (the pre-explode record).
//
// Measured on the shipped bytes, the confirm dialog that asks a person to
// approve exploding a promised assembly line quoted its after-total
// +$250.00 / +$266.00 / +$654.33 too high on three fixtures — always exactly
// ceil(target/roundTo)*roundTo − target, the round-up that should have stood
// down and did not.
//
//     AN INVARIANT ENFORCED AT CALL SITES LEAKS. ENFORCE IT AT THE STATE.
//
// So the argument is REQUIRED and it is not a boolean — a boolean is still a
// call-site invariant. It is the PRICED OBJECT: the same `per` the number came
// from. From one object the function reads both the markedUp it expects and
// the pause, and pricing one line set against another's decision is not
// unlikely, it is unrepresentable.
//
// These are PROPERTIES. Every one is a statement about EVERY record, and every
// one is red against the code as it stood before this commit:
//
//   1. THE OPTION IS GONE  — no shape of call omits the decision and survives
//   2. ONE OBJECT          — no (record, linesA, linesB) combination prices
//                            A's number against B's decision silently
//   3. THE DIALOG          — the confirm quotes the totals the change order
//                            actually takes, before AND after, driven through
//                            the editor's OWN bytes
//   4. THE PAST            — no legacy record reprices, change order OR
//                            estimate, against the REAL PRIOR GIT BLOBS
//   5. EVERY CALL SITE     — enumerated from source; each passes a decision
//                            derived from the same object as its lines

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const P = require('../js/pricing-pipeline.js');
const { changeOrderMoney } = require('../server/services/money/change-order-totals.js');
const serverEstimateTotals = require('../server/services/money/estimate-totals.js');

// The commit this change is measured against: release 1.20's cut. Every file
// in scope is byte-identical there and at the origin/main this commit was
// written on, so it is a stable pin that will not move under the suite.
const PRIOR_SHA = 'd30b11096935b93b3a8a8615b8b7d23df493a8fd';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');
}

// ── The prior blobs, read out of git rather than reimplemented ───────────
// A reimplementation proves the test agrees with the test. These are the
// bytes that shipped.
function priorTree() {
  const files = [
    'js/pricing-pipeline.js',
    'js/change-order-editor.js',
    'server/services/money/estimate-totals.js',
    'server/services/money/change-order-totals.js',
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-prior-'));
  try {
    for (const rel of files) {
      const src = execFileSync('git', ['show', PRIOR_SHA + ':' + rel],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, src);
    }
  } catch (e) { return null; }
  return dir;
}
const PRIOR_DIR = priorTree();
// eslint-disable-next-line global-require, import/no-dynamic-require
const PRIOR = PRIOR_DIR ? require(path.join(PRIOR_DIR, 'js/pricing-pipeline.js')) : null;
// eslint-disable-next-line global-require, import/no-dynamic-require
const PRIOR_EST = PRIOR_DIR ? require(path.join(PRIOR_DIR, 'server/services/money/estimate-totals.js')) : null;
const PRIOR_COE = PRIOR_DIR
  ? fs.readFileSync(path.join(PRIOR_DIR, 'js/change-order-editor.js'), 'utf8').split('\r\n').join('\n')
  : null;

// A deterministic LCG so any failure is reproducible from its seed alone.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ══════════════════════════════════════════════════════════════════════
// FIXTURES — what producers actually emit. Money arrives off input
// elements so half of it is string-typed; markup is ''/null/number; qty and
// unitCost reach 0 and go NEGATIVE on a credit line; targetPrice arrives as a
// raw string through a PUT that spreads req.body with no whitelist.
//
// The shape this file cares about most is a PROMISED ASSEMBLY ROLLUP: a line
// carrying both a unitSell and an assemblyBreakdown, because that is the only
// line the explode confirm can be raised on.
// ══════════════════════════════════════════════════════════════════════
function coCorpus(seed, opts) {
  const o = opts || {};
  const r = rng(seed);
  const promiseRate = o.promiseRate == null ? 0.35 : o.promiseRate;
  const out = [];
  for (let n = 0; n < (o.count || 20000); n++) {
    const nl = 1 + Math.floor(r() * 6);
    const lines = [];
    for (let i = 0; i < nl; i++) {
      let qty = [0.25, 0.5, 1, 2, 2.5, 3, 5, 10, 12.5][Math.floor(r() * 9)];
      if (o.credits && r() < 0.25) qty = -qty;
      const unitCost = Math.round((5 + r() * 2000) * 100) / 100;
      const l = { id: 'l' + i, qty, unitCost };
      if (r() < promiseRate) {
        const s = Math.round(unitCost * (1 + r()) * 100) / 100;
        l.unitSell = r() < 0.5 ? s : String(s);
        // Half of the promised lines are assembly rollups — the only shape
        // the explode confirm exists for.
        if (o.assemblies !== false && r() < 0.5) {
          const nb = 1 + Math.floor(r() * 4);
          l.assemblyBreakdown = [];
          for (let b = 0; b < nb; b++) {
            l.assemblyBreakdown.push({
              description: 'c' + b,
              qty_per_unit: [0.5, 1, 2, 3][Math.floor(r() * 4)],
              unit_cost: Math.round((r() * unitCost) * 100) / 100,
              cost_code: 'materials',
            });
          }
          l.sourceAssemblyId = 'asm' + i;
        }
      } else {
        const m = Math.round(r() * 45 * 10) / 10;
        l.markup = r() < 0.15 ? '' : (r() < 0.5 ? m : String(m));
      }
      lines.push(l);
    }
    if (o.sections && r() < 0.25) {
      lines.splice(Math.floor(r() * lines.length), 0, {
        id: 'h', section: '__section_header__',
        markup: r() < 0.5 ? 15 : 500,
        markupMode: r() < 0.5 ? 'dollar' : 'percent',
      });
    }
    const rec = { lines, defaultMarkup: [0, 10, 20, 25][Math.floor(r() * 4)] };
    if (r() < 0.35) rec.taxPct = [4, 6, 6.5, 7, 8.25][Math.floor(r() * 5)];
    if (r() < 0.20) rec.feePct = [1, 2, 3, 5][Math.floor(r() * 4)];
    if (r() < 0.15) rec.feeFlat = [100, 250, 500, 1200][Math.floor(r() * 4)];
    if (o.roundTo !== false && r() < 0.45) rec.roundTo = [25, 100, 500, 1000][Math.floor(r() * 4)];
    if (o.targetMargin !== false && r() < 0.30) rec.targetMargin = 10 + Math.floor(r() * 40);
    if (o.withPrice !== false) {
      const base = lines.reduce((a, l) => a + (l.section === '__section_header__' ? 0
        : (l.unitSell != null ? l.qty * Number(l.unitSell)
          : l.qty * l.unitCost * (1 + (Number(l.markup) || 0) / 100))), 0);
      let typed = base * (0.7 + r() * 0.9);
      if (!isFinite(typed) || typed <= 0) typed = 1000 + r() * 50000;
      const q = [0.01, 1, 100, 500][Math.floor(r() * 4)];
      typed = Math.round(typed / q) * q;
      rec.targetPrice = r() < 0.5 ? typed.toFixed(2) : ('$' + typed.toFixed(2));
    }
    out.push(rec);
  }
  return out;
}

// Estimate blobs, in the shape server/services/money/estimate-totals.js reads:
// a flat `lines[]` tagged by alternateId, plus `alternates[]`. Deliberately
// includes the shapes the estimate lock is asked about — an EMPTY alternates
// array, and NO alternates key at all — and puts a targetPrice on some of
// them, because nothing stops a raw PUT from doing so.
function estCorpus(seed, opts) {
  const o = opts || {};
  const r = rng(seed);
  const out = [];
  for (let n = 0; n < (o.count || 20000); n++) {
    const shape = r();
    const nAlts = 1 + Math.floor(r() * 3);
    const alts = [];
    for (let a = 0; a < nAlts; a++) {
      alts.push({ id: 'alt' + a, name: 'Alt ' + a, excludeFromTotal: r() < 0.25 });
    }
    const lines = [];
    const nl = 1 + Math.floor(r() * 8);
    for (let i = 0; i < nl; i++) {
      const l = {
        id: 'l' + i,
        alternateId: alts[Math.floor(r() * alts.length)].id,
        qty: [0.5, 1, 2, 5, 10][Math.floor(r() * 5)],
        unitCost: Math.round((5 + r() * 1500) * 100) / 100,
      };
      const m = Math.round(r() * 40 * 10) / 10;
      l.markup = r() < 0.2 ? '' : (r() < 0.5 ? m : String(m));
      lines.push(l);
    }
    const est = { lines, defaultMarkup: [0, 10, 20][Math.floor(r() * 3)] };
    // THE THREE SHAPES OF `alternates`, all reachable in the store.
    if (shape < 0.70) est.alternates = alts;               // normal
    else if (shape < 0.85) est.alternates = [];            // empty array
    // else: NO alternates key at all — the shape clientPriceRequested says
    // true for. Rare, and its number must still not move.
    if (r() < 0.35) est.taxPct = [4, 6, 7][Math.floor(r() * 3)];
    if (r() < 0.20) est.feePct = [1, 3, 5][Math.floor(r() * 3)];
    if (r() < 0.25) est.feeFlat = [100, 500, 1200][Math.floor(r() * 3)];
    if (r() < 0.45) est.roundTo = [25, 100, 500, 1000][Math.floor(r() * 4)];
    if (r() < 0.25) est.targetMargin = 10 + Math.floor(r() * 40);
    // A typed price on an ESTIMATE. The lock must keep it inert.
    if (r() < 0.35) est.targetPrice = (1000 + Math.round(r() * 60000)).toFixed(2);
    out.push(est);
  }
  return out;
}

// The three calls every consumer makes, in order — under the NEW contract.
function priceIt(rec) {
  const lines = Array.isArray(rec.lines) ? rec.lines : [];
  const per = P.computeForLines(rec, lines);
  return P.applyFeesAndTax(P.resolveMarkedUp(per, rec), rec, per);
}
function priorPriceIt(rec) {
  const lines = Array.isArray(rec.lines) ? rec.lines : [];
  return PRIOR.applyFeesAndTax(
    PRIOR.resolveMarkedUp(PRIOR.computeForLines(rec, lines), rec), rec);
}

// ══════════════════════════════════════════════════════════════════════
// 1 — THE OPTION IS GONE.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — no shape of call omits the decision and survives', () => {
  const rec = { targetPrice: '34250', roundTo: 500, defaultMarkup: 20,
    lines: [{ id: 'a', qty: 1, unitCost: 20000 }] };
  const per = P.computeForLines(rec, rec.lines);
  const mu = P.resolveMarkedUp(per, rec);

  test('omitting the third argument THROWS — it does not default', () => {
    expect(() => P.applyFeesAndTax(mu, rec)).toThrow(/REQUIRED/);
    expect(() => P.applyFeesAndTax(mu, rec, undefined)).toThrow(/REQUIRED/);
  });

  // A boolean is what the reviewer's first suggestion would have left in
  // place. It is still a CALL-SITE invariant: nothing about `true` ties it to
  // the lines being priced, so it is refused outright.
  test('a bare boolean is NOT a decision — both values throw', () => {
    expect(() => P.applyFeesAndTax(mu, rec, true)).toThrow(/REQUIRED/);
    expect(() => P.applyFeesAndTax(mu, rec, false)).toThrow(/REQUIRED/);
  });

  test('a hand-made object cannot pose as one', () => {
    expect(() => P.applyFeesAndTax(mu, rec, { clientPrice: { ok: true } })).toThrow(/REQUIRED/);
    expect(() => P.applyFeesAndTax(mu, rec, { honoured: true, __p86Sum: true })).toThrow(/REQUIRED/);
    expect(() => P.applyFeesAndTax(mu, rec, null)).toThrow(/REQUIRED/);
    expect(() => P.applyFeesAndTax(mu, rec, 1)).toThrow(/REQUIRED/);
    expect(() => P.applyFeesAndTax(mu, rec, 'true')).toThrow(/REQUIRED/);
  });

  // js/estimate-editor.js rebuilds `per` as a fresh {subtotal, markedUp}
  // literal in two places. Such a literal carries no decision, and the brand
  // is non-enumerable precisely so it cannot travel onto one.
  test('a stripped or spread copy of a real per is not a per', () => {
    expect(() => P.applyFeesAndTax(mu, rec, { ...per })).toThrow(/REQUIRED/);
    expect(() => P.applyFeesAndTax(mu, rec, Object.assign({}, per))).toThrow(/REQUIRED/);
    expect(() => P.applyFeesAndTax(mu, rec, JSON.parse(JSON.stringify(per)))).toThrow(/REQUIRED/);
    expect(() => P.applyFeesAndTax(mu, rec, { subtotal: per.subtotal, markedUp: per.markedUp }))
      .toThrow(/REQUIRED/);
  });

  test('a real per is accepted, and the pause it carries is the one applied', () => {
    expect(per.clientPrice.ok).toBe(true);
    // $34,250 at roundTo 500 would deliver $34,500 if the ceiling stood.
    expect(P.applyFeesAndTax(mu, rec, per).total).toBeCloseTo(34250, 6);
  });

  test('sumOfPriced refuses anything that did not come from computeForLines', () => {
    expect(() => P.sumOfPriced([{ clientPrice: { ok: true } }])).toThrow(/did not come from computeForLines/);
    expect(() => P.sumOfPriced([per, { ...per }])).toThrow(/part 1/);
    expect(() => P.sumOfPriced('nope')).toThrow(/must be an array/);
    expect(() => P.sumOfPriced()).toThrow(/must be an array/);
  });

  test('sumOfPriced reports the parts it was given, not a re-reading of rec', () => {
    expect(P.sumOfPriced([per]).honoured).toBe(true);
    expect(P.sumOfPriced([]).honoured).toBe(false);
    expect(P.sumOfPriced([]).partCount).toBe(0);
    // One refused part poisons the sum: a document total is not honoured
    // unless every set that went into it was.
    // Every line promised → no free pool → the price is refused by name.
    const refused = { targetPrice: '34250', roundTo: 500,
      lines: [{ id: 'a', qty: 1, unitCost: 20000, unitSell: 28000 }] };
    const perRefused = P.computeForLines(refused, refused.lines);
    expect(perRefused.clientPrice.ok).toBe(false);
    expect(P.sumOfPriced([per, perRefused]).honoured).toBe(false);
    expect(P.sumOfPriced([perRefused, per]).honoured).toBe(false);
  });

  // E2-a. The identical optional-argument shape, in the identical file, on the
  // public read of the same decision. It was LATENT — every caller passes an
  // explicit array — which is why it is closed here rather than left as an
  // idiom for the next reader to adopt.
  test('clientPriceState will not default its lines either', () => {
    expect(() => P.clientPriceState(rec)).toThrow(/REQUIRED/);
    expect(() => P.clientPriceState(rec, null)).toThrow(/REQUIRED/);
    expect(() => P.clientPriceState(rec, 'lines')).toThrow(/REQUIRED/);
    expect(P.clientPriceState(rec, rec.lines).ok).toBe(true);
    // And it answers about THE ARRAY IT WAS GIVEN, not about rec.lines.
    expect(P.clientPriceState(rec, []).ok).toBe(false);
    expect(P.clientPriceState(rec, []).reason).toBe('no-free-pool');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2 — ONE OBJECT. There is no combination that yields a mismatch.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — for ANY record and ANY two line sets, the pause cannot come from the wrong one', () => {
  // The space: real records, crossed with a DIFFERENT record's line array.
  // This is the "longer fuse" the brief names — a caller that passes the
  // argument but computes it from the wrong record. It must be impossible,
  // not merely unlikely.
  test('40,000 crossed pairs: a per from other lines never prices silently', () => {
    const all = coCorpus(101, { count: 12000, credits: true, sections: true });
    let crossed = 0, threw = 0, agreedAndPassed = 0;
    for (let i = 0; i + 1 < all.length; i += 2) {
      const rec = all[i];
      const other = all[i + 1];
      const perRight = P.computeForLines(rec, rec.lines);
      const perWrong = P.computeForLines(rec, other.lines);   // WRONG lines
      const mu = P.resolveMarkedUp(perRight, rec);
      crossed++;
      const truth = P.applyFeesAndTax(mu, rec, perRight);
      let got = null;
      try { got = P.applyFeesAndTax(mu, rec, perWrong); } catch (e) { threw++; continue; }
      // It did not throw. Then it MUST have produced the same money — which
      // is only possible when the two pers resolve to the same number AND
      // decide the same way. A silent difference is the defect.
      expect({ i, total: got.total, rounded: got.rounded })
        .toEqual({ i, total: truth.total, rounded: truth.rounded });
      agreedAndPassed++;
    }
    expect(crossed).toBe(6000);
    // The verify has to actually be doing work — if nothing ever threw, the
    // property is vacuous and this is the line that says so.
    expect(threw).toBeGreaterThan(crossed * 0.5);
    expect(threw + agreedAndPassed).toBe(crossed);
  });

  // The sharpest form: two line sets that DISAGREE about whether the price is
  // honoured. Under the old contract this is the whole bug — omit the
  // argument and the record answers. Under the new one there is no way to ask.
  test('when two line sets disagree about the price, the wrong one cannot be used', () => {
    const all = coCorpus(102, { count: 16000, promiseRate: 0.75, credits: true });
    let disagreements = 0;
    for (const rec of all) {
      const perFull = P.computeForLines(rec, rec.lines);
      const half = rec.lines.slice(0, Math.max(1, rec.lines.length - 1));
      const perHalf = P.computeForLines(rec, half);
      const okFull = !!(perFull.clientPrice && perFull.clientPrice.ok);
      const okHalf = !!(perHalf.clientPrice && perHalf.clientPrice.ok);
      if (okFull === okHalf) continue;
      disagreements++;
      const muHalf = P.resolveMarkedUp(perHalf, rec);
      // Pricing the half with the full record's decision is refused outright.
      expect(() => P.applyFeesAndTax(muHalf, rec, perFull)).toThrow(/SAME computeForLines/);
      // And the legal call takes the half's own answer.
      const fees = P.applyFeesAndTax(muHalf, rec, perHalf);
      expect(fees.rounded === 0 || !okHalf).toBe(true);
    }
    expect(disagreements).toBeGreaterThan(100);
  });

  test('a per is admissible only for the number it resolves to', () => {
    const rec = { targetPrice: '34250', roundTo: 500, defaultMarkup: 20,
      lines: [{ id: 'a', qty: 1, unitCost: 20000 }] };
    const per = P.computeForLines(rec, rec.lines);
    const mu = P.resolveMarkedUp(per, rec);
    expect(() => P.applyFeesAndTax(mu + 0.01, rec, per)).toThrow(/SAME computeForLines/);
    expect(() => P.applyFeesAndTax(0, rec, per)).toThrow(/SAME computeForLines/);
    expect(() => P.applyFeesAndTax(mu, rec, per)).not.toThrow();
  });

  // Every production CO consumer prices the same record identically, and the
  // pause they take is one answer. This is the cross-consumer statement the
  // gate collapse bought; it must survive the signature change.
  test('12,000 records: server income, the pipeline, and the rows are one number', () => {
    const all = coCorpus(103, { count: 8000, credits: true, sections: true });
    let honoured = 0;
    for (const rec of all) {
      const per = P.computeForLines(rec, rec.lines);
      const mine = P.applyFeesAndTax(P.resolveMarkedUp(per, rec), rec, per).total;
      expect(changeOrderMoney(rec).income).toBe(mine);
      const st = per.clientPrice;
      if (st && st.ok) {
        honoured++;
        const rows = st.sells.reduce((a, b) => a + b, 0);
        expect(P.applyFeesAndTax(rows, rec, per).total).toBe(mine);
        // The round-up stood down, so the typed price is delivered exactly.
        expect(Math.abs(mine - st.target)).toBeLessThan(0.005);
      }
    }
    expect(honoured).toBeGreaterThan(300);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3 — THE DIALOG. Driven through js/change-order-editor.js's OWN bytes.
// ══════════════════════════════════════════════════════════════════════
//
// The whole explode path is lifted VERBATIM out of the editor by anchor — the
// bucket router, the section find-or-create, the single-line adder, the bulk
// adder, computeTotals, and coAsmExplode itself. Nothing here re-expresses any
// of it, and that is the entire point: BOTH defects in this dialog were
// re-expressions. A test that re-expressed the explode would agree with itself
// and see neither.
//
// So the harness runs the real dialog AND the real mutation, and the oracle is
// the server's changeOrderMoney — which shares only the pricing pipeline.
function makeEditor(src, pricing) {
  const cut = (a, b, optional) => {
    const i = src.indexOf(a);
    if (i < 0) { if (optional) return ''; throw new Error('anchor not found: ' + a); }
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
    // Added by the stale-decision repair, and ABSENT from the prior blobs this
    // file also loads — so both are optional cuts.
    cut('  function coNotice(title, message) {', '\n  }\n', true),
    cut('  function coAsmRecipeRows(line) {', '\n  }\n', true),
    cut('  function coAsmExplode(lineId) {', '    } else if (confirm(msg)) doIt();\n  }\n'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const build = new Function('window', `
    var _state = { co: null };
    var _coAsmOpen = {};
    var _seq = 0;
    function newLineId() { return 'gen_' + (++_seq); }
    function markDirty() {} function paintLines() {} function paintTotals() {}
${body}
    return {
      setCo: function (c) { _state.co = c; _coAsmOpen = {}; },
      getCo: function () { return _state.co; },
      explode: coAsmExplode,
      fmt: fmtCurrency
    };
  `);
  let message = null;
  let notice = null;
  const win = {
    p86Pricing: pricing,
    // Confirm and say yes — so ONE call raises the dialog a person reads AND
    // performs the irreversible change they were shown a number for.
    p86Confirm: (o) => { message = o.message; return { then: (f) => f(true) }; },
    // THE OTHER DOOR. An explode whose recipe works out to no quantity at all
    // — a credit rollup, a zero-quantity rollup, an all-"included, no charge"
    // recipe — raises NO confirm: it refuses, says why, and leaves the record
    // alone. Without this the harness records those as "no sentence quoted"
    // and the property below cannot tell a refusal from a lie.
    p86Alert: (o) => { notice = o.message; },
  };
  const env = build(win);
  return {
    // THE EDITOR'S OWN FORMATTER, so the comparison is against the string a
    // person reads rather than against a double. A total can sit on a half
    // cent (a promised line at qty 0.5 does it), and at that point comparing
    // doubles — or multiplying by 100 and rounding — measures IEEE-754, not
    // whether the dialog told the truth. `$13,574.74` IS the truth for
    // 13574.744999999999; a test that calls it a defect is a broken test, and
    // this suite already has the scar of one.
    fmt: env.fmt,
    // Returns the two figures out of the sentence a person actually reads —
    // AS PRINTED — and the record the click actually produced.
    run(co, lineId) {
      message = null; notice = null;
      const input = JSON.stringify(co);
      env.setCo(JSON.parse(input));
      env.explode(lineId);
      // A credit change order prints a NEGATIVE total, and fmtCurrency puts
      // the minus INSIDE the dollar sign ($-3,141.59). A pattern that forgets
      // that reports "no sentence was quoted" on every deduct record — 1,492
      // of 10,528 confirms on this corpus — which is exactly the shape this
      // dialog is most likely to be wrong on, silently excluded from its own
      // property. Measured, not assumed: the first version of this harness
      // did precisely that.
      const m = message && message.match(/total from (\$-?[\d,]+\.\d\d) to (\$-?[\d,]+\.\d\d)\./);
      return {
        raised: message != null,
        // A refusal is not a failure to quote — it is the other outcome, and
        // it comes with a reason and with the record untouched.
        refused: notice != null,
        why: notice,
        unchanged: JSON.stringify(env.getCo()) === input,
        quoted: m != null,
        beforeText: m ? m[1] : null,
        afterText: m ? m[2] : null,
        before: m ? parseFloat(m[1].slice(1).replace(/,/g, '')) : null,
        after: m ? parseFloat(m[2].slice(1).replace(/,/g, '')) : null,
        record: env.getCo(),
      };
    },
  };
}

describe('PROPERTY — the confirm dialog quotes the totals the change order actually takes', () => {
  const NOW = makeEditor(read('js/change-order-editor.js'), P);

  test('the editor was actually assembled from its own bytes (not vacuous)', () => {
    const co = {
      targetPrice: '34250', roundTo: 500, defaultMarkup: 25,
      lines: [
        { id: 'L1', description: 'Trex deck framing package', qty: 1, unitCost: 14000, unitSell: 20000, markup: '',
          assemblyBreakdown: [
            { description: 'Trex boards', qty_per_unit: 1, unit_cost: 8200, cost_code: 'materials' },
            { description: 'Framing lbr', qty_per_unit: 1, unit_cost: 3400, cost_code: 'materials' },
            { description: 'Fasteners', qty_per_unit: 1, unit_cost: 2400, cost_code: 'materials' },
          ] },
        { id: 'L2', description: 'Screen enclosure', qty: 1, unitCost: 5600, unitSell: 8000, markup: '' },
      ],
    };
    const r = NOW.run(co, 'L1');
    expect({ raised: r.raised, quoted: r.quoted }).toEqual({ raised: true, quoted: true });
    // The rollup really was replaced by its components, through the real
    // coApplyAddLineItem — which finds-or-creates the section header, so there
    // are MORE lines than the naive concat the dialog used to model.
    expect(r.record.lines.some((l) => l.id === 'L1')).toBe(false);
    expect(r.record.lines.filter((l) => l.section === '__section_header__').length).toBe(1);
    expect(r.record.lines.length).toBe(5);          // 1 header + 3 components + L2
  });

  // ══ THE PROPERTY ══
  // For every change order carrying a promised assembly rollup: the two
  // numbers in the sentence a person is asked to approve are the total the
  // record holds now and the total it holds after the click. Not close — the
  // same number.
  //
  // This is red against the shipped code for TWO independent reasons, and it
  // has to hold both:
  //   • the round-to pause was decided from the un-exploded record;
  //   • the dialog's `sim` array was a SECOND hand-written model of the
  //     post-explode state — no `qty > 0` filter, and the components
  //     concatenated at the array END instead of routed into their cost-code
  //     sections, which on a change order is what decides their markup.
  //
  // AND THE SECOND OUTCOME. An explode that would create nothing raises no
  // dialog at all: it refuses by name and the record is BYTE-IDENTICAL. That
  // branch is not an exemption from the property — it is the property's other
  // half, and it is counted and asserted rather than skipped, because the
  // shipped bytes reached it on 24.8% of this very corpus and destroyed the
  // line every time.
  test('36,000 promised-rollup explodes: before AND after are the record own totals', () => {
    const all = coCorpus(201, { count: 12000, promiseRate: 0.6, credits: true, sections: true })
      .concat(coCorpus(202, { count: 12000, promiseRate: 0.9 }))
      .concat(coCorpus(203, { count: 12000, promiseRate: 0.4, sections: true }));
    let raised = 0;
    let refused = 0;
    const wrongAfter = [];
    const wrongBefore = [];
    const badRefusal = [];
    for (const co of all) {
      const line = co.lines.find((l) => P.sellLocked(l) && Array.isArray(l.assemblyBreakdown));
      if (!line) continue;
      const beforeTruth = changeOrderMoney(co).income;
      const r = NOW.run(co, line.id);
      if (r.refused) {
        refused++;
        // Nothing was said about money because nothing moved — and NOTHING
        // MOVED is checked on the bytes, not on the line's continued presence.
        if (r.raised || !r.unchanged || !r.why || r.why.length < 20) {
          badRefusal.push({ id: line.id, raised: r.raised, unchanged: r.unchanged, why: r.why });
        }
        continue;
      }
      raised++;
      if (!r.quoted) { wrongAfter.push({ id: line.id, quoted: false }); continue; }
      // The oracle is the SERVER's money function over the record the click
      // actually produced. It shares nothing with the dialog but the pipeline.
      const afterTruth = changeOrderMoney(r.record).income;
      // AS PRINTED, through the editor's own formatter. See the note on
      // makeEditor().fmt: a record can sit on a half cent, and there the
      // question "did the dialog tell the truth?" is a question about the
      // STRING, not about a double.
      if (r.afterText !== NOW.fmt(afterTruth)) {
        wrongAfter.push({ quoted: r.afterText, truth: NOW.fmt(afterTruth), raw: afterTruth });
      }
      // `+ 0` normalises NEGATIVE ZERO and nothing else. The dialog's own
      // `(computeTotals() || {}).total || 0` turns -0 into 0 before printing,
      // so a change order worth exactly nothing reads "$0.00" there and
      // "$-0.00" from the raw oracle. That is a display difference of one
      // glyph on a zero, not a money difference, and it is named rather than
      // hidden inside a tolerance.
      if (r.beforeText !== NOW.fmt(beforeTruth + 0)) {
        wrongBefore.push({ quoted: r.beforeText, truth: NOW.fmt(beforeTruth + 0), raw: beforeTruth });
      }
    }
    // Both outcomes are reached in force. A run that only ever proceeds proves
    // nothing about the refusal, and one that only ever refuses proves nothing
    // about the sentence.
    expect(raised).toBeGreaterThan(15000);
    expect(refused).toBeGreaterThan(1500);
    expect(badRefusal.slice(0, 3)).toEqual([]);
    expect(badRefusal).toHaveLength(0);
    expect(wrongBefore.slice(0, 3)).toEqual([]);
    expect(wrongBefore).toHaveLength(0);
    expect(wrongAfter.slice(0, 3)).toEqual([]);
    expect(wrongAfter).toHaveLength(0);
  });

  // THE TWO DEFECTS, SEPARATED AND PINNED IN CURRENCY against the shipped
  // bytes. This is what a person saw. If the prior blob ever stops being wrong
  // here, this test is what says the pin has gone stale.
  test('the shipped dialog was wrong two ways, measured', () => {
    if (!PRIOR || !PRIOR_COE) return;
    const OLD = makeEditor(PRIOR_COE, PRIOR);
    const rollup = () => ({
      id: 'L1', description: 'Trex deck framing package',
      qty: 1, unitCost: 14000, unitSell: 20000, markup: '',
      assemblyBreakdown: [
        { description: 'Trex boards', qty_per_unit: 1, unit_cost: 8200, cost_code: 'materials' },
        { description: 'Framing lbr', qty_per_unit: 1, unit_cost: 3400, cost_code: 'materials' },
        { description: 'Fasteners', qty_per_unit: 1, unit_cost: 2400, cost_code: 'materials' },
      ],
    });
    const screen = () => ({ id: 'L2', description: 'Screen enclosure', qty: 1, unitCost: 5600, unitSell: 8000, markup: '' });
    // A1-A3: the ROUND-TO PAUSE, in isolation. Every component is materials
    // and the record carries no section header, so the two line models land on
    // the same money and the only thing left to be wrong is the pause.
    const fixtures = [
      { name: 'A1', targetPrice: '34250', roundTo: 500, feeFlat: 0, feePct: 0, taxPct: 0 },
      { name: 'A2', targetPrice: '34234', roundTo: 500, feeFlat: 0, feePct: 0, taxPct: 0 },
      { name: 'A3', targetPrice: '34345.67', roundTo: 1000, feeFlat: 1200, feePct: 3, taxPct: 7 },
    ];
    const rows = fixtures.map((f) => {
      const co = { targetPrice: f.targetPrice, roundTo: f.roundTo, feeFlat: f.feeFlat,
        feePct: f.feePct, taxPct: f.taxPct, defaultMarkup: 25, lines: [rollup(), screen()] };
      const now = NOW.run(co, 'L1');
      const truth = changeOrderMoney(now.record).income;
      const old = OLD.run(co, 'L1');
      return {
        name: f.name,
        shippedOver: Math.round((old.after - truth) * 100) / 100,
        nowOver: Math.round((now.after - truth) * 100) / 100,
      };
    });
    expect(rows).toEqual([
      { name: 'A1', shippedOver: 250, nowOver: 0 },
      { name: 'A2', shippedOver: 266, nowOver: 0 },
      { name: 'A3', shippedOver: 654.33, nowOver: 0 },
    ]);

    // B: the SECOND MODEL, in isolation — no client price at all, so the pause
    // cannot be involved. The components route into three different cost-code
    // sections; the shipped `sim` concatenated them at the array end, where
    // the enclosing header is the Materials section at 35%.
    const B = {
      defaultMarkup: 20,
      lines: [
        { id: 'H', section: '__section_header__', label: 'Materials', btCategory: 'materials', markup: 35, markupMode: 'percent' },
        { id: 'L1', description: 'Pool cage package', qty: 2, unitCost: 6000, unitSell: 9000, markup: '',
          assemblyBreakdown: [
            { description: 'Extrusion', qty_per_unit: 1, unit_cost: 2000, cost_code: 'materials' },
            { description: 'Crew day', qty_per_unit: 1, unit_cost: 1500, cost_code: 'labor' },
            { description: 'Screen sub', qty_per_unit: 1, unit_cost: 2500, cost_code: 'sub' },
          ] },
      ],
    };
    expect(P.clientPriceRequested(B)).toBe(false);        // no price in play
    const nowB = NOW.run(B, 'L1');
    const truthB = changeOrderMoney(nowB.record).income;
    const oldB = OLD.run(B, 'L1');
    expect(Math.round((nowB.after - truthB) * 100) / 100).toBe(0);
    // The shipped dialog is out by the markup difference on the two components
    // that do NOT belong in the Materials section.
    expect(Math.round((oldB.after - truthB) * 100) / 100).toBe(1200);

    // C: a CREDIT rollup — the component quantities go negative, so doIt()'s
    // `qty > 0` filter drops them and the record keeps only what is left. The
    // shipped `sim` had no such filter and priced them all.
    const C = {
      defaultMarkup: 20,
      lines: [
        { id: 'L1', description: 'Deduct: cage', qty: -1, unitCost: 6000, unitSell: 9000, markup: '',
          assemblyBreakdown: [{ description: 'Extrusion', qty_per_unit: 1, unit_cost: 2000, cost_code: 'materials' }] },
        { id: 'L2', description: 'Base scope', qty: 1, unitCost: 10000, markup: 20 },
      ],
    };
    const nowC = NOW.run(C, 'L1');
    const oldC = OLD.run(C, 'L1');
    // THE SHIPPED BYTES, PINNED. They raised a dialog, quoted a total two
    // thousand four hundred dollars away from the one the record would take,
    // removed the rollup, and created nothing.
    expect(oldC.raised).toBe(true);
    expect(Math.round((oldC.after - changeOrderMoney(oldC.record).income) * 100) / 100).toBe(-2400);
    expect(oldC.record.lines.some((l) => l.id === 'L1')).toBe(false);
    expect(oldC.record.lines.filter((l) => l.section !== '__section_header__')).toHaveLength(1);
    // NOW: there is no sentence to be wrong, because there is no move. The
    // credit is refused by name and the change order is untouched.
    expect(nowC.raised).toBe(false);
    expect(nowC.refused).toBe(true);
    expect(nowC.why).toMatch(/credit line/);
    expect(nowC.unchanged).toBe(true);
  });

  // THE RATES, each stated beside the population it is a rate OF. Two
  // denominators are defensible for the pause defect and they differ by more
  // than 3x, so both are pinned rather than one being quoted loose.
  test('the shipped rates, measured against their stated denominators', () => {
    if (!PRIOR || !PRIOR_COE) return;
    const OLD = makeEditor(PRIOR_COE, PRIOR);
    const all = coCorpus(205, { count: 16000, promiseRate: 0.6, credits: true, sections: true });
    let raised = 0, exposed = 0, wrongShipped = 0, wrongNow = 0;
    let refusedNow = 0, destroyedByShipped = 0, mutatedOnRefusal = 0;
    for (const co of all) {
      const line = co.lines.find((l) => P.sellLocked(l) && Array.isArray(l.assemblyBreakdown));
      if (!line) continue;
      raised++;
      // Only a record with a parseable positive price AND a live ceiling can
      // reach the PAUSE defect at all — the stricter denominator.
      const t = P.parseMoney(co.targetPrice);
      if (t != null && t > 0 && P.num(co.roundTo) > 0) exposed++;
      const now = NOW.run(co, line.id);
      const old = OLD.run(co, line.id);
      const oldTruth = changeOrderMoney(old.record).income;
      if (old.afterText !== OLD.fmt(oldTruth)) wrongShipped++;
      // WHAT THE SHIPPED BYTES DID ON THE OTHER BRANCH: removed the rollup and
      // put nothing back. Counted here so the repair's rate is quoted beside
      // the damage it replaces rather than on its own.
      const oldContent = old.record.lines.filter((l) => l.section !== '__section_header__');
      const coContent = co.lines.filter((l) => l.section !== '__section_header__');
      if (oldContent.length < coContent.length) destroyedByShipped++;
      if (now.refused) {
        refusedNow++;
        if (!now.unchanged) mutatedOnRefusal++;
        continue;
      }
      if (now.afterText !== NOW.fmt(changeOrderMoney(now.record).income)) wrongNow++;
    }
    expect(raised).toBeGreaterThan(6000);
    expect(exposed).toBeGreaterThan(1000);
    // Shipped: wrong on 30.48% of every explode confirm raised on THIS corpus
    // (seed 205 — promiseRate 0.6, credits, sections), both defects in play.
    // The rate is a property of the shape distribution, so it is pinned as a
    // floor rather than quoted as a fact; a rate of zero — which is what a
    // broken extraction would produce — fails loudly.
    expect(wrongShipped / raised).toBeGreaterThan(0.25);
    // And on 24.8% of the same confirms the shipped bytes deleted a line and
    // created nothing. Pinned as a floor for the same reason.
    expect(destroyedByShipped / raised).toBeGreaterThan(0.20);
    expect(refusedNow / raised).toBeGreaterThan(0.20);
    // Now: zero wrong sentences, and not one byte moved on a refusal.
    expect(wrongNow).toBe(0);
    expect(mutatedOnRefusal).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4 — THE PAST. Against the real prior git blobs.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — nothing already saved reprices', () => {
  test('the prior blobs are actually loaded (this property is not silently skipped)', () => {
    expect(PRIOR && typeof PRIOR.resolveMarkedUp).toBe('function');
    expect(PRIOR_EST && typeof PRIOR_EST.computeEstimateTotals).toBe('function');
    expect(typeof PRIOR_COE).toBe('string');
    // And the prior blob is the one WITH the defect — otherwise "nothing
    // reprices" is being proven against the fix.
    expect(PRIOR.sumOfPriced).toBeUndefined();
    expect(() => PRIOR.applyFeesAndTax(0, { roundTo: 100 })).not.toThrow();
  });

  test('300,000 legacy-shaped change orders: every number byte-identical', () => {
    if (!PRIOR) return;
    const all = coCorpus(301, { count: 60000, withPrice: false, credits: true, sections: true })
      .concat(coCorpus(302, { count: 60000, withPrice: false, promiseRate: 0.5 }))
      .concat(coCorpus(303, { count: 60000, withPrice: false, promiseRate: 0 }))
      .concat(coCorpus(304, { count: 60000, withPrice: false, promiseRate: 0.9, credits: true }))
      .concat(coCorpus(305, { count: 60000, withPrice: false, promiseRate: 1, sections: true }));
    expect(all.length).toBeGreaterThanOrEqual(300000);
    const diverged = [];
    for (const rec of all) {
      const a = priceIt(rec);
      const b = priorPriceIt(rec);
      if (a.total !== b.total || a.beforeRound !== b.beforeRound ||
          a.taxAmount !== b.taxAmount || a.rounded !== b.rounded ||
          a.feeFlat !== b.feeFlat || a.feePctAmount !== b.feePctAmount) {
        diverged.push({ rec, now: a, before: b });
      }
    }
    expect(diverged.slice(0, 3)).toEqual([]);
    expect(diverged).toHaveLength(0);
  });

  // Client-priced change orders are NOT legacy — the field is new — but their
  // numbers must not move either, because 1.20 shipped them.
  test('60,000 client-priced change orders: every number byte-identical', () => {
    if (!PRIOR) return;
    const all = coCorpus(311, { count: 20000, credits: true, sections: true })
      .concat(coCorpus(312, { count: 20000, promiseRate: 0.75 }))
      .concat(coCorpus(313, { count: 20000, promiseRate: 0.1 }));
    const diverged = [];
    for (const rec of all) {
      const a = priceIt(rec);
      const b = priorPriceIt(rec);
      if (a.total !== b.total || a.rounded !== b.rounded) diverged.push({ rec, now: a, before: b });
    }
    expect(diverged.slice(0, 3)).toEqual([]);
    expect(diverged).toHaveLength(0);
  });

  // THE ESTIMATE LOCK STAYS SHUT, and the estimate numbers stay still. The
  // four estimate call sites changed shape in this commit — they now hand
  // applyFeesAndTax the PARTS they summed instead of letting it re-read
  // est.lines — so every estimate shape has to be proven against the shipped
  // server module, including the two `alternates` shapes that are not a
  // normal array.
  test('60,000 estimate blobs: proposalTotal byte-identical to the shipped module', () => {
    if (!PRIOR_EST) return;
    const all = estCorpus(321, { count: 30000 }).concat(estCorpus(322, { count: 30000 }));
    const diverged = [];
    let noAltKey = 0, emptyAlts = 0, priced = 0;
    for (const est of all) {
      if (!('alternates' in est)) noAltKey++;
      else if (est.alternates.length === 0) emptyAlts++;
      if (est.targetPrice != null) priced++;
      const a = serverEstimateTotals.computeEstimateTotals(est);
      const b = PRIOR_EST.computeEstimateTotals(est);
      for (const k of ['proposalTotal', 'clientPrice', 'markedUp', 'baseCost',
        'feeFlat', 'feePctAmount', 'taxAmount', 'blendedMarkup']) {
        if (a[k] !== b[k]) { diverged.push({ k, now: a[k], before: b[k], est }); break; }
      }
    }
    // The awkward shapes are actually present, or this proves nothing.
    expect(noAltKey).toBeGreaterThan(3000);
    expect(emptyAlts).toBeGreaterThan(3000);
    expect(priced).toBeGreaterThan(15000);
    expect(diverged.slice(0, 3)).toEqual([]);
    expect(diverged).toHaveLength(0);
  });

  // A DOCUMENT CLIENT PRICE STILL NEVER REACHES AN ESTIMATE. The lock is
  // `alternates != null`, it is untouched by this commit, and the reason it
  // matters is that an absolute price applied once PER INCLUDED ALTERNATE
  // multiplies the proposal.
  test('a typed price on an estimate prices nothing, at any alternate count', () => {
    const lines = [];
    for (let a = 0; a < 5; a++) {
      lines.push({ id: 'l' + a, alternateId: 'alt' + a, qty: 1, unitCost: 5000, markup: 10 });
    }
    for (let n = 1; n <= 5; n++) {
      const alternates = [];
      for (let a = 0; a < n; a++) alternates.push({ id: 'alt' + a, name: 'A' + a });
      const withPrice = { lines: lines.slice(0, n), alternates, targetPrice: '39285.71', roundTo: 500 };
      const without = { lines: lines.slice(0, n), alternates, roundTo: 500 };
      expect(P.clientPriceRequested(withPrice)).toBe(false);
      expect(serverEstimateTotals.computeEstimateTotals(withPrice).proposalTotal)
        .toBe(serverEstimateTotals.computeEstimateTotals(without).proposalTotal);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5 — EVERY CALL SITE, ENUMERATED FROM SOURCE.
// ══════════════════════════════════════════════════════════════════════
//
// The behavioural properties above hold the code that exists. This one holds
// the code that gets ADDED: a new call site that quietly prices one array
// against another record's decision would satisfy every property above by
// never being exercised. So the call sites are counted, and each one's third
// argument has to be a name bound in the same function from the same lines.
describe('PROPERTY — every production call site passes a decision from its own lines', () => {
  // DISCOVERED, NOT LISTED. A fixed list is a list of the call sites that
  // existed the day it was written: add a call in a file that is not on it and
  // this whole section goes quietly green, which is the one failure mode a
  // "holds the code that gets added" property may not have. So js/ and
  // server/ are walked.
  function walk(dir, out) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel, out); }
      else if (e.name.endsWith('.js')) out.push(rel);
    }
    return out;
  }
  // The pipeline itself is excluded: its own five solve calls go to the
  // module-private boolean form, which is pinned separately below.
  const SCANNED = walk('js', walk('server', [])).filter((f) => f !== 'js/pricing-pipeline.js');
  // The seven files that hold a call today. Named so that a call DISAPPEARING
  // from one of them is as visible as one appearing somewhere new.
  const FILES = [
    'js/change-order-editor.js', 'js/estimate-editor.js', 'js/estimate-preview.js',
    'js/estimates.js', 'js/jobs.js',
    'server/services/money/change-order-totals.js',
    'server/services/money/estimate-totals.js',
  ];

  // Balanced-paren argument split for one call. Good enough for this code
  // (no template literals or regex literals appear inside these calls) and it
  // fails loudly rather than guessing.
  function argsAt(src, open) {
    let depth = 0, start = open + 1, out = [];
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '(') { depth++; if (depth === 1) start = i + 1; }
      else if (c === ')') { depth--; if (depth === 0) { out.push(src.slice(start, i)); return out; } }
      else if (c === ',' && depth === 1) { out.push(src.slice(start, i)); start = i + 1; }
    }
    return null;
  }

  function callsIn(rel) {
    const src = read(rel);
    const out = [];
    let i = 0;
    for (;;) {
      const k = src.indexOf('applyFeesAndTax(', i);
      if (k < 0) break;
      i = k + 1;
      // Skip prose: only count it when it is actually a call on the module.
      const before = src.slice(Math.max(0, k - 24), k);
      if (!/(p86Pricing|pricing|_P|P)\.$/.test(before)) continue;
      const args = argsAt(src, k + 'applyFeesAndTax'.length);
      expect(args).not.toBeNull();
      out.push({ rel, args: args.map((a) => a.trim()), at: src.slice(0, k).split('\n').length });
    }
    return out;
  }

  const ALL = SCANNED.reduce((a, f) => a.concat(callsIn(f)), []);

  test('the enumeration walked the tree and found every production call site', () => {
    // The walk actually walked — a broken walk finds nothing and everything
    // below it passes vacuously.
    expect(SCANNED.length).toBeGreaterThan(100);
    expect(SCANNED).toContain('js/jobs.js');
    expect(SCANNED).toContain('server/services/money/change-order-totals.js');
    expect(SCANNED).not.toContain('js/pricing-pipeline.js');
    // Fifteen shipped: 5 inside the pipeline's own solve (now private and not
    // counted here) + 10 across the two editors, the money modules and jobs.
    expect(ALL.length).toBe(10);
    // Every call is in one of the seven known files — and every one of those
    // seven still holds a call.
    expect([...new Set(ALL.map((c) => c.rel))].sort()).toEqual(FILES.slice().sort());
  });

  test('not one of them omits the decision', () => {
    const two = ALL.filter((c) => c.args.length !== 3);
    expect(two.map((c) => c.rel + ':' + c.at)).toEqual([]);
  });

  test('none passes a boolean, and none passes a literal', () => {
    const bad = ALL.filter((c) => /^(true|false|!!|0|1|null|undefined)/.test(c.args[2]));
    expect(bad.map((c) => c.rel + ':' + c.at + ' → ' + c.args[2])).toEqual([]);
  });

  // THE ONE THAT MATTERS. The third argument must name the SAME object the
  // second argument's number was priced from. Either it is a bare identifier
  // that is also the `per` handed to the resolveMarkedUp on the line above,
  // or it is a sumOfPriced over parts collected in the same function.
  test('each decision is the per that produced the number, or the parts that were summed', () => {
    const offenders = [];
    for (const c of ALL) {
      const decision = c.args[2];
      const number = c.args[0];
      if (/^(_P|P)\.sumOfPriced\(parts\)$/.test(decision)) continue;   // the estimate sites
      if (!/^[A-Za-z_$][\w$]*$/.test(decision)) { offenders.push(c.rel + ':' + c.at + ' → ' + decision); continue; }
      // A bare identifier: the number must be resolveMarkedUp of that same
      // identifier, either inline or via a variable assigned from it.
      const src = read(c.rel);
      const inline = new RegExp('resolveMarkedUp\\(\\s*' + decision + '\\s*,');
      if (inline.test(number)) continue;
      if (!/^[A-Za-z_$][\w$]*$/.test(number)) { offenders.push(c.rel + ':' + c.at + ' → ' + number); continue; }
      // `var markedUp = <ns>.resolveMarkedUp(<decision>, <rec>);` must appear.
      const assigned = new RegExp(
        '(?:var|let|const)\\s+' + number + '\\s*=\\s*[\\w.$]*resolveMarkedUp\\(\\s*' + decision + '\\s*,');
      if (!assigned.test(src)) offenders.push(c.rel + ':' + c.at + ' → ' + number + ' is not resolveMarkedUp(' + decision + ')');
    }
    expect(offenders).toEqual([]);
  });

  // The estimate sites are the callers that GENUINELY CANNOT hand over a
  // single `per` — their number is a SUM across alternates, so no one object
  // holds it. They collect the parts instead. Verified structurally, because
  // "the parts are the ones that were summed" is not a runtime-checkable
  // claim: sumOfPriced cannot reproduce a caller's sum.
  test('the four estimate sites collect their parts in the same function that sums them', () => {
    for (const rel of ['js/estimate-editor.js', 'js/estimate-preview.js', 'js/estimates.js',
      'server/services/money/estimate-totals.js']) {
      const src = read(rel);
      expect({ rel, has: /parts\.push\(per\)/.test(src) }).toEqual({ rel, has: true });
      expect({ rel, has: /sumOfPriced\(parts\)/.test(src) }).toEqual({ rel, has: true });
    }
  });

  // The private arithmetic must stay private: it is the only shape that still
  // takes a bare boolean, and a bare boolean on the public surface is the
  // thing this commit removed.
  test('the boolean form is module-private and the solve is its only caller', () => {
    const PIPE = read('js/pricing-pipeline.js');
    expect(PIPE).not.toMatch(/feesAndTax: feesAndTax/);
    expect(PIPE).toMatch(/applyFeesAndTax: applyFeesAndTax/);
    expect(PIPE).toMatch(/sumOfPriced: sumOfPriced/);
    // CODE, not prose — the comments name the removed function on purpose,
    // so that the next reader learns what used to be here.
    const code = PIPE.replace(/^\s*\/\/.*$/gm, '');
    const priv = (code.match(/[^y]feesAndTax\(/g) || []).length;
    // the definition + 5 inside the solve + the one call the public wrapper
    // makes. Seven, and no more: an eighth means something outside this file's
    // own solve found its way to the boolean form.
    expect(priv).toBe(7);
    // And nothing re-derives the pause from the record any more. The whole
    // re-deriving function is gone, not merely unreferenced.
    expect(code).not.toMatch(/clientPriceHonoured/);
    expect(code).not.toMatch(/honoured === undefined/);
    expect(read('js/change-order-editor.js').replace(/^\s*\/\/.*$/gm, ''))
      .not.toMatch(/clientPriceHonoured/);
  });
});
