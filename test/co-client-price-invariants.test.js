// test/co-client-price-invariants.test.js
//
// ONE DECISION, CONSUMED EVERYWHERE.
//
// The client-price feature shipped with the decision taken TWICE, by two
// functions that could not agree because they did not hold the same inputs:
//
//   clientPriceState(rec, lines)  ran allocateFreePool and could refuse
//   resolveMarkedUp(per, rec)     called solveClientPrice directly and could
//                                 not — no `lines` in its signature, so it
//                                 physically could not run the check
//
// So the rows painted a refusal while the Total chip, changeOrderMoney,
// job-wip's totalIncome/revisedMargin/backlog, the WIP report, job-audit R8,
// Live Rooms and the pay applications all honoured the price. Measured over
// 300,000 realistic change orders: the two gates split on 2.52% of them
// (7,548 records), by a median of $4,857.61 — 22.1% OF THE CHANGE ORDER, 90th
// percentile $23,961.66, worst $124,538.13. Not cents.
//
// These are PROPERTIES, not screenshots. Every one of them is a statement
// about EVERY record, and every one of them is red against the code as it
// stood before this commit. Stated plainly because a suite that is green
// before the change is not testing the change:
//
//   1. THE GATE     — the decision the total takes IS the decision the rows
//                     take, for any record and any typed string
//   2. THE ROWS     — when honoured, the rows sum to the reported number
//                     EXACTLY (not "within half a cent")
//   3. THE REFUSAL  — a refused price changes NOTHING: not the total, not
//                     round-to
//   4. THE PAST     — no record without a targetPrice reprices, proven
//                     against the REAL PRIOR GIT BLOB
//   5. THE SERVER   — what changeOrderMoney reports IS what the totals bar
//                     displays
//   6. STRUCTURE    — there is no second gate to fall out of sync, because
//                     resolveMarkedUp cannot solve anything

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const P = require('../js/pricing-pipeline.js');
const { changeOrderMoney } = require('../server/services/money/change-order-totals.js');

const PIPE = fs.readFileSync(path.join(__dirname, '..', 'js', 'pricing-pipeline.js'), 'utf8');

// A deterministic LCG so any failure is reproducible from its seed alone.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FIXTURES ARE WHAT PRODUCERS ACTUALLY EMIT. Money arrives off input
// elements, so half of it is string-typed; imported lines carry no unitSell;
// markup is ''/null/number; qty and unitCost reach 0 and go NEGATIVE on a
// credit line; and targetPrice arrives as a RAW STRING through a PUT that
// spreads req.body with no whitelist.
function corpus(seed, opts) {
  const o = opts || {};
  const r = rng(seed);
  const promiseRate = o.promiseRate == null ? 0.25 : o.promiseRate;
  const out = [];
  for (let n = 0; n < (o.count || 20000); n++) {
    const nl = 1 + Math.floor(r() * 6);
    const lines = [];
    for (let i = 0; i < nl; i++) {
      // Half-cent-prone quantities are deliberately over-represented: a
      // promised line at qty 0.5 is the shape that lands the pool on a half
      // cent, and the half cent is what the old tolerance was set to.
      let qty = [0.25, 0.5, 1, 2, 2.5, 3, 5, 10, 12.5][Math.floor(r() * 9)];
      if (o.credits && r() < 0.25) qty = -qty;
      const unitCost = Math.round((5 + r() * 2000) * 100) / 100;
      const l = { id: 'l' + i, qty, unitCost };
      if (r() < promiseRate) {
        const s = Math.round(unitCost * (1 + r()) * 100) / 100;
        l.unitSell = r() < 0.5 ? s : String(s);          // strings reach here
      } else {
        const m = Math.round(r() * 45 * 10) / 10;
        l.markup = r() < 0.15 ? '' : (r() < 0.5 ? m : String(m));
      }
      lines.push(l);
    }
    const rec = { lines };
    if (r() < 0.35) rec.taxPct = [4, 6, 6.5, 7, 8.25][Math.floor(r() * 5)];
    if (r() < 0.20) rec.feePct = [1, 2, 3, 5][Math.floor(r() * 4)];
    if (r() < 0.15) rec.feeFlat = [100, 250, 500][Math.floor(r() * 3)];
    if (o.roundTo !== false && r() < 0.30) rec.roundTo = [25, 100, 500][Math.floor(r() * 3)];
    if (o.targetMargin !== false && r() < 0.30) rec.targetMargin = 10 + Math.floor(r() * 40);
    if (o.withPrice !== false) {
      const base = lines.reduce((a, l) => a + (l.unitSell != null
        ? l.qty * Number(l.unitSell)
        : l.qty * l.unitCost * (1 + (Number(l.markup) || 0) / 100)), 0);
      let typed = base * (0.7 + r() * 0.9);
      if (!isFinite(typed) || typed <= 0) typed = 1000 + r() * 50000;
      // Round numbers are what people TYPE, and they are the worst case: a
      // round typed price lands markedUp on whole cents and leaves the
      // promised half-cent as the entire residual.
      const q = [0.01, 1, 100, 500][Math.floor(r() * 4)];
      typed = Math.round(typed / q) * q;
      rec.targetPrice = r() < 0.5 ? typed.toFixed(2) : ('$' + typed.toFixed(2));
    }
    out.push(rec);
  }
  return out;
}

// The whole document, priced the way every consumer prices it — the exact
// three calls every one of the seven call sites makes, in order.
function priced(rec) {
  const lines = Array.isArray(rec.lines) ? rec.lines : [];
  const per = P.computeForLines(rec, lines);
  const markedUp = P.resolveMarkedUp(per, rec);
  return { per, markedUp, fees: P.applyFeesAndTax(markedUp, rec) };
}

// ══════════════════════════════════════════════════════════════════════
// 1 — THE GATE. One decision, or none.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — the total and the rows take the SAME decision', () => {
  test('for any record and any typed price, they never split', () => {
    const all = corpus(1, { count: 3000, credits: true })
      .concat(corpus(2, { count: 3000, promiseRate: 0.5 }))
      .concat(corpus(3, { count: 3000, promiseRate: 0.1 }));
    const split = [];
    for (const rec of all) {
      const { per, markedUp } = priced(rec);
      // Deliberately asked through the PUBLIC surface both the row painter
      // and the totals path use, rather than through `per.clientPrice`:
      // this property has to be answerable against the code as it stood, and
      // reading a key that only exists after the fix would make it pass
      // vacuously on exactly the build it is supposed to indict.
      const st = P.clientPriceState(rec, rec.lines);
      if (!st) continue;
      // THE PROPERTY, stated exactly. The row painter is handed `st`; the
      // Total chip, changeOrderMoney and the WIP report are handed
      // `markedUp`. Those two must be answers to the SAME question:
      //   honoured → the total is the number the rows were allocated from
      //   refused  → the total is what an EMPTY field would have produced
      const bare = Object.assign({}, rec);
      delete bare.targetPrice;
      const fallback = P.resolveMarkedUp(P.computeForLines(bare, bare.lines), bare);
      const agreed = st.ok ? markedUp === st.markedUp : markedUp === fallback;
      if (!agreed) {
        split.push({ reason: st.reason, ok: st.ok, markedUp, fallback,
          stMarkedUp: st.markedUp, unaccounted: markedUp - fallback });
      }
    }
    expect(split.slice(0, 3)).toEqual([]);
    expect(split).toHaveLength(0);
  });

  // The measured instance, kept as a named regression: one promised line at
  // qty 0.5 x $1,650.07 leaves a $0.005 residual that straddles a strict
  // `> CP_EPS` where CP_EPS was set to exactly 0.005.
  test('the half-cent promised line — $14,500 typed, $3,388.97 unaccounted', () => {
    const rec = { targetPrice: '14500', lines: [
      { id: 'a', qty: 0.5, unitCost: 1000, unitSell: 1650.07 },
      { id: 'b', qty: 10, unitCost: 610, markup: 28 },
      { id: 'c', qty: 5, unitCost: 413, markup: 20 },
    ] };
    const { per, markedUp, fees } = priced(rec);
    expect(per.clientPrice.ok).toBe(true);
    expect(per.clientPrice.reason).toBe(null);
    expect(fees.total).toBeCloseTo(14500, 6);
    expect(per.clientPrice.sells.reduce((a, b) => a + b, 0)).toBe(markedUp);
  });

  // Sweeping the typed cents is how a user meets this: $14,505 worked and
  // $14,510 did not, which from their side is indistinguishable from random.
  // 20,001 consecutive typed cents, and the answer may not flicker.
  test('20,001 consecutive typed cents, no flicker', () => {
    const lines = [
      { id: 'a', qty: 0.5, unitCost: 1000, unitSell: 1650.07 },
      { id: 'b', qty: 10, unitCost: 610, markup: 28 },
      { id: 'c', qty: 5, unitCost: 413, markup: 20 },
    ];
    let split = 0;
    for (let c = 0; c <= 20000; c++) {
      const rec = { targetPrice: ((1000000 + c) / 100).toFixed(2), lines };
      const { per, markedUp } = priced(rec);
      const st = per.clientPrice;
      if (!!st.ok !== (st.ok && markedUp === st.markedUp)) split++;
    }
    expect(split).toBe(0);
  });

  // The channel a fix aimed at allocateFreePool or CP_EPS does NOT close:
  // the two gates computed `naturalFree` by different arithmetic — a direct
  // sum over unpromised lines vs a subtraction off an interleaved
  // accumulator. On a deduct CO whose add and credit cancel exactly, one
  // read 0 ('no-free-pool', refuse) and the other 3.6e-12 (> 0, honour),
  // $8,198.16 apart. Only collapsing the two computations fixes it.
  test('the deduct that cancels exactly — one naturalFree, not two', () => {
    const rec = { targetPrice: '24594.47', lines: [
      { id: 'p', qty: 1, unitCost: 10657.6015, unitSell: 16396.31 },
      { id: 'c', qty: -1, unitCost: 37872.94, markup: 30 },
      { id: 'a', qty: 1, unitCost: 37872.94, markup: 30 },
    ] };
    const per = P.computeForLines(rec, rec.lines);
    // The shape that produced the split: a direct sum says exactly zero
    // while the subtraction says float noise above zero.
    expect(per.naturalFree).toBe(0);
    expect(per.markedUp - per.lockedSell).not.toBe(0);
    // There is now ONE of them, and it is the direct sum.
    expect(per.clientPrice.ok).toBe(false);
    expect(per.clientPrice.reason).toBe('no-free-pool');
    // ...and the total agrees, rather than honouring $24,594.47.
    expect(P.resolveMarkedUp(per, rec)).toBe(per.markedUp);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2 — THE ROWS. Exactly, not approximately.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — an honoured price is the sum of its rows', () => {
  test('Σ sells === the reported markedUp, to the bit, over 9,000 records', () => {
    const all = corpus(11, { count: 3000, credits: true })
      .concat(corpus(12, { count: 3000, promiseRate: 0.5 }))
      .concat(corpus(13, { count: 3000 }));
    let checked = 0;
    const bad = [];
    for (const rec of all) {
      const { per, markedUp } = priced(rec);
      const st = per.clientPrice;
      if (!st || !st.ok) continue;
      checked++;
      const sum = st.sells.reduce((a, b) => a + b, 0);
      // NOT toBeCloseTo. The document number IS the sum; a tolerance here is
      // what let a half cent grow into $3,388.97.
      if (sum !== markedUp) bad.push({ sum, markedUp, diff: sum - markedUp });
    }
    expect(bad.slice(0, 3)).toEqual([]);
    expect(checked).toBeGreaterThan(900);
  });

  test('a promised line is never restated, even when it carries the sub-cent', () => {
    const all = corpus(21, { count: 3000, promiseRate: 0.5, credits: true });
    for (const rec of all) {
      const st = P.clientPriceState(rec, rec.lines);
      if (!st || !st.ok) continue;
      for (let i = 0; i < rec.lines.length; i++) {
        if (st.promisedFlags[i]) expect(st.sells[i]).toBe(st.natural[i]);
      }
    }
  });

  // The root fix, stated: the pool settles its own sub-cent rather than
  // being rounded to whole cents against an unrounded target.
  test('the free pool is spent exactly, not rounded away', () => {
    const all = corpus(31, { count: 4000, promiseRate: 0.45 });
    let sawSubCent = 0;
    for (const rec of all) {
      const st = P.clientPriceState(rec, rec.lines);
      if (!st || !st.ok) continue;
      let free = 0;
      for (let i = 0; i < st.sells.length; i++) if (!st.promisedFlags[i]) free += st.sells[i];
      expect(Math.abs(free - st.freePool)).toBeLessThan(1e-6);
      if (Math.round(st.freePool * 100) / 100 !== st.freePool) sawSubCent++;
    }
    // The corpus must actually CONTAIN the shape this fixes, or the
    // assertion above proves nothing.
    expect(sawSubCent).toBeGreaterThan(30);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3 — THE REFUSAL. It changes nothing.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — a refused price prices the record as an empty field would', () => {
  test('same total, same rows, same round-to — over 9,000 records', () => {
    const all = corpus(41, { count: 3000, credits: true })
      .concat(corpus(42, { count: 3000, promiseRate: 0.6 }))
      .concat(corpus(43, { count: 3000, promiseRate: 0.05 }));
    let refused = 0;
    const moved = [];
    for (const rec of all) {
      const { per, markedUp, fees } = priced(rec);
      const st = per.clientPrice;
      if (!st || st.ok) continue;
      refused++;
      const bare = Object.assign({}, rec);
      delete bare.targetPrice;
      const b = priced(bare);
      if (markedUp !== b.markedUp || fees.total !== b.fees.total) {
        moved.push({ reason: st.reason, roundTo: rec.roundTo,
          withPrice: fees.total, cleared: b.fees.total });
      }
    }
    expect(moved.slice(0, 5)).toEqual([]);
    expect(refused).toBeGreaterThan(100);
  });

  // The measured instances. clientPriceInForce tested only that the string
  // PARSES, so every SEMANTIC refusal still stood roundTo down and moved the
  // total — while the editor was explaining that it had refused.
  test.each([
    ['no-free-pool', { targetPrice: '17000', roundTo: 500, lines: [
      { id: 'a', qty: 1, unitCost: 10000, unitSell: 17600 }] }],
    ['promised-exceeds', { targetPrice: '12000', roundTo: 500, lines: [
      { id: 'a', qty: 1, unitCost: 8000, unitSell: 12200 },
      { id: 'b', qty: 1, unitCost: 100, markup: 10 }] }],
  ])('a refused price does not move the total: %s', (reason, rec) => {
    const { per, fees } = priced(rec);
    expect(per.clientPrice.reason).toBe(reason);
    expect(per.clientPrice.roundToPaused).toBe(false);
    const bare = Object.assign({}, rec);
    delete bare.targetPrice;
    expect(fees.total).toBe(priced(bare).fees.total);
    // and round-to is genuinely still doing its job on that number
    expect(fees.total % 500).toBe(0);
  });

  test('an HONOURED price still stands round-to down', () => {
    const rec = { targetPrice: '34250', roundTo: 500, lines: [
      { id: 'a', qty: 1, unitCost: 20000, markup: 20 },
      { id: 'b', qty: 1, unitCost: 5000, markup: 10 }] };
    const { per, fees } = priced(rec);
    expect(per.clientPrice.ok).toBe(true);
    expect(per.clientPrice.roundToPaused).toBe(true);
    // $34,250 against roundTo 500 would otherwise deliver $34,500 — $250 over.
    expect(fees.total).toBeCloseTo(34250, 6);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4 — THE PAST. Against the real prior blob.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — nothing already saved reprices', () => {
  // The pipeline as it was SHIPPED, read out of git rather than
  // reimplemented here: a reimplementation proves the test agrees with the
  // test. Skips (loudly) only if git or the object is unavailable.
  function priorBlob() {
    let src;
    try {
      src = execFileSync('git', ['show', '8ddc4598:js/pricing-pipeline.js'],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { return null; }
    const f = path.join(os.tmpdir(), 'p86-prior-pipeline-' + process.pid + '.js');
    fs.writeFileSync(f, src);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(f);
    fs.unlinkSync(f);
    return mod;
  }
  const PRIOR = priorBlob();

  test('the prior blob is actually loaded (this property is not silently skipped)', () => {
    expect(PRIOR && typeof PRIOR.resolveMarkedUp).toBe('function');
  });

  test('250,000 legacy-shaped records: every number byte-identical', () => {
    if (!PRIOR) return;
    const all = corpus(51, { count: 60000, withPrice: false, credits: true })
      .concat(corpus(52, { count: 60000, withPrice: false, promiseRate: 0.5 }))
      .concat(corpus(53, { count: 65000, withPrice: false, promiseRate: 0 }))
      .concat(corpus(54, { count: 65000, withPrice: false, promiseRate: 0.9 }));
    expect(all.length).toBeGreaterThanOrEqual(250000);
    const diverged = [];
    for (const rec of all) {
      const lines = rec.lines;
      const a = P.applyFeesAndTax(P.resolveMarkedUp(P.computeForLines(rec, lines), rec), rec);
      const b = PRIOR.applyFeesAndTax(
        PRIOR.resolveMarkedUp(PRIOR.computeForLines(rec, lines), rec), rec);
      if (a.total !== b.total || a.beforeRound !== b.beforeRound ||
          a.taxAmount !== b.taxAmount || a.rounded !== b.rounded) {
        diverged.push({ rec, now: a, before: b });
      }
    }
    expect(diverged.slice(0, 3)).toEqual([]);
    expect(diverged).toHaveLength(0);
  });

  test('and the costs side never moves either', () => {
    if (!PRIOR) return;
    const all = corpus(55, { count: 20000, withPrice: false, credits: true });
    for (const rec of all) {
      expect(P.computeForLines(rec, rec.lines).subtotal)
        .toBe(PRIOR.computeForLines(rec, rec.lines).subtotal);
    }
  });

  // THE ESTIMATE LOCK. A document client price on an estimate multiplies the
  // proposal by the number of included alternates — $39,285.71 becomes
  // $196,428.57 at five, silently. The decision now rides on computeForLines,
  // which estimates call PER INCLUDED ALTERNATE, so this lock is carrying
  // more load than it was, not less.
  test('a record carrying alternates never gets a decision, however priced', () => {
    const est = { targetPrice: '39285.71', alternates: [{ id: 'a', included: true }],
      lines: [{ id: 'x', qty: 1, unitCost: 1000, markup: 20 }] };
    expect(P.clientPriceRequested(est)).toBe(false);
    expect(P.clientPriceState(est, est.lines)).toBe(null);
    expect(P.computeForLines(est, est.lines).clientPrice).toBe(null);
    // even with an EMPTY alternates array — `!= null`, not truthiness
    const empty = Object.assign({}, est, { alternates: [] });
    expect(P.computeForLines(empty, empty.lines).clientPrice).toBe(null);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5 — THE SERVER. Same number as the screen.
// ══════════════════════════════════════════════════════════════════════
describe('PROPERTY — what the server reports IS what the totals bar displays', () => {
  test('changeOrderMoney === the editor pipeline, over 6,000 records', () => {
    const all = corpus(61, { count: 3000, credits: true })
      .concat(corpus(62, { count: 3000, promiseRate: 0.5 }));
    const diverged = [];
    for (const rec of all) {
      const { fees, per } = priced(rec);
      const srv = changeOrderMoney(rec);
      if (srv.income !== fees.total || srv.costs !== per.subtotal) {
        diverged.push({ srv, screen: fees.total });
      }
    }
    expect(diverged.slice(0, 3)).toEqual([]);
  });

  // The number the server puts in job-wip's totalIncome must be the number
  // the rows on screen add up to, plus fees and tax. That is the whole claim,
  // and it is the one that failed: changeOrderMoney reported $14,500.00 into
  // totalIncome, revisedMargin, backlog and the WIP report while the rows
  // came to $11,111.04.
  test('server income is the rows, plus fees and tax, and nothing else', () => {
    const all = corpus(63, { count: 4000, promiseRate: 0.45, credits: true });
    let honoured = 0;
    for (const rec of all) {
      const st = P.clientPriceState(rec, rec.lines);
      if (!st || !st.ok) continue;
      honoured++;
      const rows = st.sells.reduce((a, b) => a + b, 0);
      expect(changeOrderMoney(rec).income).toBe(P.applyFeesAndTax(rows, rec).total);
    }
    expect(honoured).toBeGreaterThan(100);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6 — STRUCTURE. There is nothing left to keep in sync.
// ══════════════════════════════════════════════════════════════════════
describe('STRUCTURE — a second gate is not currently absent, it is impossible', () => {
  // CODE, not prose. The comments in this file necessarily NAME the functions
  // the old second gate called, so a raw source match would read its own
  // explanation of the defect as the defect.
  const code = (s) => s.replace(/^\s*\/\/.*$/gm, '');

  test('resolveMarkedUp cannot solve a client price — it only reads one', () => {
    const body = PIPE.slice(PIPE.indexOf('function resolveMarkedUp(per, rec)'));
    const fn = code(body.slice(0, body.indexOf('\n  }')));
    // The exact defect: this function called the solver itself.
    expect(fn).not.toMatch(/solveClientPrice|allocateFreePool|parseMoney|solveMarkedUpForTotal/);
    // ...and it does not re-derive the input the two gates disagreed about.
    expect(fn).not.toMatch(/naturalFree|markedUp\)\s*-\s*lockedSell/);
    expect(fn).toMatch(/p\.clientPrice/);
  });

  test('the decision is taken in exactly one place, and it is not exported', () => {
    const calls = code(PIPE).split('decideClientPrice(').length - 1;
    expect(calls).toBe(2);                       // the definition + one call
    expect(PIPE).toMatch(/per\.clientPrice = decideClientPrice\(rec, per\)/);
    expect(PIPE).not.toMatch(/decideClientPrice: decideClientPrice/);
    // solveClientPrice reaches the outside world through that one door only.
    expect(PIPE).not.toMatch(/solveClientPrice: solveClientPrice/);
    expect(PIPE).not.toMatch(/allocateFreePool: allocateFreePool/);
  });

  test('clientPriceState is a READ of that decision, not a second taking', () => {
    const body = PIPE.slice(PIPE.indexOf('function clientPriceState(rec, lines)'));
    const fn = code(body.slice(0, body.indexOf('\n  }')));
    expect(fn).toMatch(/computeForLines\(rec, arr\)\.clientPrice/);
    expect(fn).not.toMatch(/solveClientPrice|allocateFreePool|lineMoney/);
  });

  // ── The three the mutation run left GREEN, now pinned ──────────────
  //
  // A bypass that turns no test red is a path nothing is holding. Two of
  // these are defence-in-depth that is UNREACHABLE while the code around it
  // is correct — deleting them changes no number, which is exactly why they
  // need pinning by structure rather than by behaviour. The third is a
  // deliberate choice that behaviour alone cannot see.

  test('the sub-cent settles on the LARGEST free line, not just any line', () => {
    // Both choices keep Σ sells === markedUp, so no arithmetic property can
    // tell them apart — but a half cent on a $0.01 line doubles it, and the
    // browser and the server must land it on the same row regardless.
    const rec = { targetPrice: '20000', lines: [
      { id: 'p', qty: 0.5, unitCost: 900, unitSell: 1650.07 },   // half-cent promise
      { id: 'small', qty: 1, unitCost: 0.01, markup: 0 },
      { id: 'big', qty: 1, unitCost: 15000, markup: 20 },
    ] };
    const st = P.clientPriceState(rec, rec.lines);
    expect(st.ok).toBe(true);
    const cents = (v) => Math.abs(v * 100 - Math.round(v * 100));
    // exactly one free row carries a fraction of a cent, and it is the big one
    expect(cents(st.sells[2])).toBeGreaterThan(1e-9);
    expect(cents(st.sells[1])).toBeLessThan(1e-9);
    // the promise is still untouched, fraction and all
    expect(st.sells[0]).toBe(825.035);
    expect(st.sells.reduce((a, b) => a + b, 0)).toBe(st.markedUp);
  });

  test('the allocation guard is still there, and still refuses by name', () => {
    // UNREACHABLE BY CONSTRUCTION, AND KEPT. Removing it turns no test red on
    // its own — measured, both before this change and after — because
    // allocateFreePool spends the pool exactly. Break the allocation as well
    // (flatten it, say) and it is the only thing standing between a wrong row
    // and a total that cannot explain it. Structure is the only thing that
    // can hold a guard whose whole job is to never fire.
    const body = PIPE.slice(PIPE.indexOf('function decideClientPrice(rec, per)'));
    const fn = body.slice(0, body.indexOf('\n  }'));
    expect(fn).toMatch(/if \(!isFinite\(sum\) \|\| Math\.abs\(sum - st\.markedUp\)/);
    expect(fn).toMatch(/st\.ok = false; st\.reason = 'allocation'; st\.sells = null;/);
    // and 'allocation' is still a reason the screen knows how to explain
    expect(fs.readFileSync(path.join(__dirname, '..', 'js', 'change-order-editor.js'), 'utf8'))
      .toMatch(/could not be allocated to these lines/);
  });

  test('its tolerance is float noise, not half a cent', () => {
    // THE ORIGINAL DEFECT IN ONE LINE. CP_EPS is 0.005, and the residual
    // allocateFreePool could produce was bounded by EXACTLY 0.005 — so the
    // guard fired only when float rounding pushed the difference past its own
    // bound, on 30% of the records sitting on that edge. A tolerance may
    // never again be set to the largest error the thing it guards can make.
    const body = PIPE.slice(PIPE.indexOf('function decideClientPrice(rec, per)'));
    const fn = body.slice(0, body.indexOf('\n  }'));
    expect(fn).not.toMatch(/CP_EPS/);
    expect(fn).toMatch(/1e-6 \+ Math\.abs\(sum\) \* 1e-12/);
  });

  // A caller cannot get a document total out of this module without also
  // getting the rows that add up to it, because they are the same object.
  test('every honoured total arrives with the rows that explain it', () => {
    const all = corpus(71, { count: 2500, credits: true });
    let honoured = 0;
    for (const rec of all) {
      const per = P.computeForLines(rec, rec.lines);
      const mu = P.resolveMarkedUp(per, rec);
      // Asked through the public surface so this is answerable against the
      // shipped build too, rather than passing vacuously on it.
      const st = P.clientPriceState(rec, rec.lines);
      if (!st) continue;
      if (st.ok) {
        honoured++;
        expect(Array.isArray(st.sells)).toBe(true);
        expect(st.sells.reduce((a, b) => a + b, 0)).toBe(mu);
      } else {
        expect(st.sells).toBe(null);
      }
    }
    expect(honoured).toBeGreaterThan(100);
  });
});
