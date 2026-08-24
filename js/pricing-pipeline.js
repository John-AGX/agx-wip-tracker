// Shared pricing pipeline — single source of truth for the math behind
// Estimates AND job-scoped Change Orders.
//
// Why this exists: js/estimate-editor.js and js/estimate-preview.js
// historically each carried their own copies of the markup → fees →
// tax → round pipeline. They drifted (see the proposal-total bug
// that shipped a wrong $1,433 instead of $2,605.45 when target-margin
// was set). Pulling the math here means every editor + preview hits
// the same code; if the formula changes, only one place updates.
//
// The CO editor (js/change-order-editor.js — separate file) consumes
// these helpers without copying any math. Estimates have an extra
// alternates concept; CO records carry a single flat `lines[]` array.
// Both shapes drop into the same helpers because the building blocks
// take an explicit `lines` array as input rather than reading from a
// fixed location.
//
// Public surface (window.p86Pricing):
//   num(v)
//   sectionHeaderFor(line, lines)
//   sectionMarkupForLine(line, lines, rec)
//   effectiveMarkupForLine(line, lines, rec)
//   grossMarginPct(subtotal, markedUp) → percent | null
//   sellLocked(line) → boolean
//   lineMoney(line, lines, rec) → { ext, sell, locked, markup }
//   computeForLines(rec, lines) → { subtotal, markedUp,
//                                   lockedSubtotal, lockedSell,
//                                   natural[], promisedFlags[], naturalFree,
//                                   clientPrice }   ← THE one decision
//   targetMarginActive(rec) → boolean
//   applyTargetMargin(subtotal, rec) → markedUp
//   parseMoney(v) → number | null          (currency, not percent)
//   clientPriceRequested(rec) → boolean
//   clientPriceInForce(rec) → boolean
//   clientPriceState(rec, lines) → null | { ok, reason, target, markedUp,
//                                           scale, sells[], … }
//   resolveMarkedUp(per, rec) → markedUp
//   applyFeesAndTax(markedUp, rec[, honoured]) → { feeFlat, feePctAmount, preTax,
//                                       taxAmount, beforeRound,
//                                       rounded, total }
//
// COST DRIVES SELL — and, when a price was promised before a cost was
// known, sell can be stated outright.
// ---------------------------------------------------------------
// A line's `unitCost` is, and has always been, WHAT IT COSTS. Its sell
// price is derived from that by the markup cascade below. That works
// whenever the cost is the number you have.
//
// It does not work for the other direction. A Buildertrend flat rate is
// a PRICE quoted to the owner; pasting it into `unitCost` books the full
// sell price as AGX's cost, and with markup 0 the change order reports
// zero profit while the job's estimated cost absorbs the entire quote.
// That is the bug this field exists to end.
//
// So a line may carry an optional `unitSell`: the promised per-unit
// price. When set, the line's contribution to the marked-up total is
// qty × unitSell and its markup is not consulted. `unitCost` still
// means cost, so the line's profit is finally expressible.
//
// THE DISCRIMINATOR IS THE ABSENCE OF THE KEY — the same mechanism the
// per-line `markup` field has used since this module was written, and
// the reason no change order in the database has to be migrated,
// rewritten, or reinterpreted for this to ship. Every line that exists
// today has no `unitSell`; `undefined != null` is false; the branch
// never runs; the arithmetic is the arithmetic it has always been.
// There is no version flag, because a flag would need a value on every
// existing row — which is the migration this design refuses. Absence is
// per-line and self-describing, and one change order can legitimately
// hold both shapes at once (assembly rollups priced cost-up beside a
// flat-rate line priced sell-down).
(function() {
  'use strict';

  // Lenient number parser — strings, empty strings, and `null` all
  // become 0 so callers can hand us raw input-field values without
  // peppering the code with isNaN guards. Matches estimate-editor's
  // local `num()` exactly.
  function num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  // Returns the section header (line with section === '__section_header__')
  // that encloses the given line, or null if the line precedes any
  // header. Used by the markup-cascade lookup below.
  function sectionHeaderFor(line, allLines) {
    if (!allLines || !allLines.length) return null;
    var idx = allLines.indexOf(line);
    if (idx < 0) idx = allLines.length;
    for (var i = idx - 1; i >= 0; i--) {
      var L = allLines[i];
      if (L && L.section === '__section_header__') return L;
    }
    return null;
  }

  // The section-derived percent markup for a line, ignoring any per-line
  // override. Used both to drive the placeholder on the per-line markup
  // field AND as a fallback in the resolver below.
  function sectionMarkupForLine(line, allLines, rec) {
    var section = sectionHeaderFor(line, allLines);
    if (section && section.markup !== '' && section.markup != null) return num(section.markup);
    if (rec && rec.defaultMarkup != null && rec.defaultMarkup !== '') return num(rec.defaultMarkup);
    return 0;
  }

  // Resolve the markup-percent that should apply to a single line.
  // Cascade rules (mirrors estimate-editor.js exactly):
  //   1. If the line's section has overrideLineMarkups → ignore per-line
  //      markup. In $-mode the line uses 0% (dollar adds once at
  //      section level); in %-mode the section's % wins.
  //   2. Otherwise, per-line markup wins if set.
  //   3. If no per-line markup, fall back to the section's % markup
  //      (but only in %-mode; $-mode sections supply no per-line %).
  //   4. Final fallback is rec.defaultMarkup.
  function effectiveMarkupForLine(line, allLines, rec) {
    var section = sectionHeaderFor(line, allLines);
    if (section && section.overrideLineMarkups) {
      if (section.markupMode === 'dollar') return 0;
      return sectionMarkupForLine(line, allLines, rec);
    }
    if (line && line.markup !== '' && line.markup != null) return num(line.markup);
    if (section && section.markupMode === 'dollar') return 0;
    return sectionMarkupForLine(line, allLines, rec);
  }

  // Does this line carry a promised sell price?
  //
  // Character-identical to the per-line `markup` guard above, and for the
  // same reason: the absence of the key is the discriminator. Two
  // consequences worth saying out loud —
  //   • `unitSell: 0` is a REAL lock at $0 (a line given away against a
  //     real cost), exactly as `markup: 0` is a real 0%. Blank is not
  //     zero, so no UI may ever write 0 into the field on the user's
  //     behalf; a new line seeds `unitSell: ''`.
  //   • Clearing the field un-locks the line and it returns to markup
  //     pricing. The document total moves. That is a deliberate human
  //     action, not a migration.
  function sellLocked(line) {
    return !!(line && line.unitSell !== '' && line.unitSell != null);
  }

  // The money one CONTENT line contributes.
  //   ext   — its COST: qty × unitCost. Never anything else, ever. This
  //           is the number that becomes a change order's `costs` and
  //           lands in job-wip's totalEstCosts, so nothing here may
  //           reinterpret `unitCost` as a price.
  //   sell  — what it adds to the marked-up total.
  //   locked/markup — which rule produced `sell`, for the row paints.
  //
  // Exported because the CO editor paints a per-row amount in two more
  // places that each hand-rolled `ext * (1 + m/100)`. A rule written
  // four times is a rule that will disagree with itself; the rows and
  // the total now read the same function.
  //
  // A locked line ignores the markup cascade ENTIRELY — including a
  // section carrying overrideLineMarkups. The section override exists to
  // restate derived prices; a promised price is not derived, so there is
  // nothing for it to restate. (New semantic, introduced with the field;
  // it cannot change an existing record, which has no locked lines.)
  function lineMoney(line, allLines, rec) {
    var ext = num(line && line.qty) * num(line && line.unitCost);
    if (sellLocked(line)) {
      return { ext: ext, sell: num(line.qty) * num(line.unitSell), locked: true, markup: null };
    }
    var m = effectiveMarkupForLine(line, allLines, rec);
    return { ext: ext, sell: ext * (1 + m / 100), locked: false, markup: m };
  }

  // Marked-up subtotal for a flat array of lines (one group). Section
  // headers in $-mode add their flat $ amount once to the marked-up
  // total but don't contribute to the subtotal — that mirrors the
  // existing markedUpForGroup helper. Estimates pass per-alternate
  // line slices; the CO editor passes the whole co.data.lines array.
  //
  // `subtotal` and `markedUp` keep their exact prior meanings. The two
  // added keys report how much of each came from PROMISED lines, so
  // resolveMarkedUp below can carve them out of a target-margin
  // back-solve.
  //
  // THE EMPTY-ARRAY RETURN CARRIES ALL FOUR KEYS FOR SHAPE, NOT FOR
  // SAFETY. This comment used to say that omitting the locked pair
  // turned income into NaN and poisoned the whole job tile. That was
  // measured, and it is FALSE: with BOTH keys absent, resolveMarkedUp's
  // `!lockedSell && !lockedSubtotal` short-circuits to the legacy branch
  // and returns exactly today's number. Strip them and no figure moves
  // on either corpus — the only test that fails is the one asserting the
  // shape.
  //
  // The real NaN trap is a HALF-stripped `per`: one locked key present
  // and the other missing reaches
  // `lockedSell + applyTargetMargin(subtotal - lockedSubtotal)`, and
  // `4650 - undefined` is NaN. That is covered by resolveMarkedUp's
  // num() coercion, not by this line. js/estimate-editor.js rebuilds
  // `per` as a bare {subtotal, markedUp} literal in two places, so a
  // consumer reading the keys uncoerced is not hypothetical.
  //
  // The keys stay: every return path here should hand back one shape.
  // Defensive, not load-bearing. The distinction is worth the words — a
  // rationale that overstates is how the next reader concludes the guard
  // is here and stops looking for it where it actually is.
  // ⚠ ONE PASS, ONE DECISION. The per-line PRICES this loop already computes
  // are kept (`natural`), not thrown away and re-derived by a second function
  // over the same array. That is not an optimisation — it is the whole repair.
  // `clientPriceState` used to walk `lines` a second time to rebuild exactly
  // these numbers, and the two walks did not agree: this one accumulated
  // `naturalFree` as `markedUp - lockedSell` (a subtraction off an
  // interleaved accumulator) while that one summed the unpromised lines
  // directly. Measured, those disagreed numerically on 41% of records, and on
  // a deduct change order whose add and credit cancel exactly one read 0 and
  // the other 3.6e-12 — so the state gate refused `no-free-pool` while the
  // total honoured the price, $8,198.16 apart. There is now one array and one
  // `naturalFree`, so there is nothing left to disagree.
  function computeForLines(rec, lines) {
    var arr = Array.isArray(lines) ? lines : [];
    var subtotal = 0;
    var markedUp = 0;
    var lockedSubtotal = 0;
    var lockedSell = 0;
    var naturalFree = 0;
    var natural = new Array(arr.length);
    var promised = new Array(arr.length);
    var lineCount = 0, promisedCount = 0, zeroPriceCount = 0;
    arr.forEach(function(l, i) {
      if (l.section === '__section_header__') {
        // A $-mode section's flat adder is a price contribution like any
        // other, and it is not a promise, so it scales with everything else.
        var add = (l.markupMode === 'dollar' && l.markup !== '' && l.markup != null)
          ? num(l.markup) : 0;
        markedUp += add;
        natural[i] = add; promised[i] = false; naturalFree += add;
        return;
      }
      lineCount++;
      var mm = lineMoney(l, arr, rec);
      subtotal += mm.ext;
      markedUp += mm.sell;
      natural[i] = mm.sell;
      promised[i] = mm.locked;
      if (mm.locked) {
        promisedCount++;
        lockedSubtotal += mm.ext; lockedSell += mm.sell;
      } else {
        naturalFree += mm.sell;
        if (!mm.sell) zeroPriceCount++;
      }
    });
    var per = {
      subtotal: subtotal, markedUp: markedUp,
      lockedSubtotal: lockedSubtotal, lockedSell: lockedSell,
      naturalFree: naturalFree, natural: natural, promisedFlags: promised,
      lineCount: lineCount, promisedCount: promisedCount,
      zeroPriceCount: zeroPriceCount,
      clientPrice: null
    };
    // THE decision, taken once, here, on the object every consumer already
    // holds. resolveMarkedUp reads it; the row painter reads it; the refusal
    // band reads it. None of them may take it again.
    per.clientPrice = decideClientPrice(rec, per);
    return per;
  }

  // Target-margin override. When rec.targetMargin is a sane percent
  // (>0 and <100), the proposal abandons bottom-up markup math and
  // back-computes the marked-up subtotal so gross margin lands
  // exactly on the target:
  //
  //     markedUp = subtotal / (1 - targetMargin / 100)
  //
  // Callers decide whether to apply this (typically only on INCLUDED
  // alternates; excluded ones keep their bottom-up markup so the
  // breakdown stays meaningful).
  function targetMarginActive(rec) {
    if (!rec) return false;
    var m = num(rec.targetMargin);
    return m > 0 && m < 100;
  }
  function applyTargetMargin(subtotal, rec) {
    var m = num(rec.targetMargin);
    var divisor = 1 - m / 100;
    if (divisor <= 0) return subtotal; // sanity guard
    return subtotal / divisor;
  }

  // ═══════════════════════════════════════════════════════════════════
  // CLIENT PRICE — the number the client will pay, typed.
  //
  // "This allows me to change the change order total to what I want the
  // client price to be; the markup and margin are back computed from that.
  // This is IN ADDITION to being able to set the target margin."
  //
  // THE KEY IS `targetPrice`, AND ITS ABSENCE IS THE DISCRIMINATOR — the
  // same mechanism `markup` and `unitSell` have always used, and the reason
  // no change order in the database has to be migrated, rewritten or
  // reinterpreted for this to ship. Every record that exists today has no
  // targetPrice; the branch never runs; the arithmetic is the arithmetic it
  // has always been.
  //
  // It writes the SAME single variable targetMargin writes — markedUp — so
  // there is exactly one thing downstream of it, not a parallel pricing
  // model. When both are set the typed price wins, because it is the more
  // specific instruction; the editor makes Target Margin stand down on
  // screen rather than leaving two live controls fighting over one number.
  //
  // CHANGE ORDERS ONLY. Both reviewers proved a document-level absolute is
  // WRONG on an estimate: every estimate total loops `alternates` and SUMS a
  // per-group resolve, so an absolute price is applied once PER INCLUDED
  // GROUP. Measured on a $39,285.71 estimate — $78,571.43 at two included
  // alternates, $196,428.57 at five, silently. A target margin survives that
  // because a rate is linear across a sum; an absolute is not. Change orders
  // carry a flat lines[] and resolve exactly once per record, which is why
  // this side is safe and that side is not. clientPriceRequested therefore
  // refuses any record carrying `alternates` — a structural test, not a
  // convention, so it survives estimate-editor.js one day calling
  // resolveMarkedUp (which its own TODO already invites it to do).
  //
  // ⚠ THAT IS ONE LOCK, NOT TWO. This comment used to add "and requires the
  // flat `lines[]` array only a change order has". EVERY STORED ESTIMATE
  // BLOB HAS `lines[]` — server/services/money/estimate-totals.js reads
  // `est.lines` as its primary input and filters it by alternateId — so the
  // Array.isArray(rec.lines) test discriminates nothing at all. Measured: a
  // blob with `lines[]` and no `alternates` returns clientPriceRequested
  // true. The guard IS sound, and it is sound BECAUSE of `alternates !=
  // null`. The keys stay (a non-array `lines` would break the walk below
  // whatever it means), but the belt described here does not exist, and a
  // reader who believes there are two locks is a reader who deletes one.
  //
  // The load on that single lock went UP with the gate collapse, not down:
  // the decision now rides on computeForLines, which estimates call ONCE
  // PER INCLUDED ALTERNATE. It is the only thing between an estimate and
  // the $39,285.71 → $196,428.57 multiplication.
  // ═══════════════════════════════════════════════════════════════════

  // A typed client price is CURRENCY. num() above is percent-shaped, and
  // measured against a typed price it is dangerous rather than merely
  // lenient: "34,000.00" prices at $34.00, and "$34,000" and " " price at
  // $0.00 — while ALL THREE read as "present" to the discriminator, so the
  // branch fires with a wrong number instead of falling back.
  //
  // The DOM cannot be the guard. server/routes/change-order-routes.js
  // spreads req.body with no whitelist over the document money fields, and
  // the agent tool surface advertises the sibling fields as writable, so a
  // raw string reaches this blob whatever the side panel does.
  //
  // NULL IS NOT ZERO. Anything unreadable returns null and refuses ON
  // SCREEN; it never becomes a price.
  function parseMoney(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v == null) return null;
    var s = String(v).trim();
    if (!s) return null;
    var paren = s.charAt(0) === '(' && s.charAt(s.length - 1) === ')';
    if (paren) s = s.slice(1, -1).trim();
    s = s.replace(/[$,\s ]/g, '');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
    var n = parseFloat(s);
    if (!isFinite(n)) return null;
    return paren ? -n : n;
  }

  // Is a client price being ASKED FOR on this record? Presence and validity
  // are deliberately separate: an unparseable price is REQUESTED (so the
  // editor owes the user an explanation) but not IN FORCE (so it prices
  // nothing).
  //
  // ⚠ The one discriminator mistake that matters: written as
  // `rec.targetPrice != null`, an empty string leaks true and the branch
  // fires on a blank field. A field the user cleared, and a field holding
  // only spaces, are both "no client price" — they look empty, so they
  // behave empty.
  function clientPriceRequested(rec) {
    if (!rec) return false;
    var v = rec.targetPrice;
    if (v == null) return false;
    if (typeof v === 'string' && v.trim() === '') return false;
    if (rec.alternates != null) return false;        // estimates: see above
    if (!Array.isArray(rec.lines)) return false;     // change orders only
    return true;
  }
  function clientPriceInForce(rec) {
    if (!clientPriceRequested(rec)) return false;
    var t = parseMoney(rec.targetPrice);
    return t != null && t > 0;
  }

  // Half a cent. Money is decided at the cent; anything inside this is
  // float noise, anything outside it is a number a person would notice.
  var CP_EPS = 0.005;

  // BISECT ON THE REAL applyFeesAndTax — do not invert it by hand.
  //
  // Measured, three ways to get this wrong and one to get it right:
  //   • treat the typed price AS markedUp        → 23.4% out
  //   • T/((1+fee%)(1+tax%)) - feeFlat           →  0.63% out (feeFlat is
  //                                                 taxed but not
  //                                                 fee-percented)
  //   • (T/(1+tax%) - feeFlat)/(1+fee%)          →  exact, but ONLY while
  //                                                 roundTo is 0, and it
  //                                                 re-derives arithmetic
  //                                                 this module owns
  // A solve stays correct the day someone adds a step to applyFeesAndTax.
  // The closed form does not, and its wrongness is silent.
  function solveMarkedUpForTotal(rec, target) {
    var lo = -1e9, hi = 1e9;
    var flo = applyFeesAndTax(lo, rec, true).total;
    var fhi = applyFeesAndTax(hi, rec, true).total;
    if (!isFinite(flo) || !isFinite(fhi)) return null;
    // THE SINGULARITY. (1+feePct/100)*(1+taxPct/100) === 0 makes every
    // markedUp produce the same total, so nothing can be solved for. An
    // unguarded bisection does not return NaN here — it silently returns
    // the bracket bound, 1,000,000,000 — and a monotonicity check misses it
    // because f(lo) === f(hi).
    if (flo === fhi) return null;
    var inc = fhi > flo;
    if (inc ? (target < flo || target > fhi) : (target > flo || target < fhi)) return null;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      var fm = applyFeesAndTax(mid, rec, true).total;
      if (inc ? (fm < target) : (fm > target)) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // RULE A — THE SOLVE IS NOT TRUSTED UNTIL IT IS VERIFIED.
  // RULE B — TWO CONDITIONS REFUSE INDEPENDENT OF CONVERGENCE.
  //
  // Rule A catches an unreachable price and the singularity. It does NOT
  // catch a price below the fee floor: that one CONVERGES — a $4,000 client
  // price against a $5,000 flat fee solves to markedUp −$1,261.68, displays
  // $4,000.00 exactly, and prices every line at −$126.16 — which is why
  // Rule B exists as a separate gate rather than as a comment on Rule A.
  //
  // ⚠ RULE A'S VERIFY IS DELIBERATELY UNREACHABLE TODAY, AND THAT IS THE
  // POINT OF IT. With the ceiling stood down above, applyFeesAndTax is
  // LINEAR in markedUp, so a bisection cannot converge on a wrong answer and
  // deleting the check turns no test red on its own — measured. Delete the
  // pause as well and it fires immediately: a $34,250 price against
  // roundTo 500 becomes a silent $34,500 delivery, $250 over. It is what
  // makes the pause safe rather than lucky, and it is what will catch the
  // day someone adds a fifth step to applyFeesAndTax. Do not remove it
  // because a mutation run says nothing depends on it.
  //
  // Nothing here clamps. A client price that cannot be honoured is REFUSED,
  // the change order prices from its line markups exactly as it would with
  // the field empty, and the editor puts the reason on screen in currency.
  // A silent wrong number is the failure this whole feature exists to end.
  function solveClientPrice(rec, lockedSell, naturalFree) {
    var out = {
      requested: true, ok: false, reason: null, target: null, markedUp: null,
      lockedSell: lockedSell, naturalFree: naturalFree, freePool: null,
      scale: null, floorTotal: null
    };
    var target = parseMoney(rec.targetPrice);
    if (target == null) { out.reason = 'unparseable'; return out; }
    out.target = target;
    if (!(target > 0)) { out.reason = 'not-positive'; return out; }
    // What this record charges before a dollar of work is priced. Named so
    // the refusal can quote it rather than say "too low".
    out.floorTotal = applyFeesAndTax(0, rec, true).total;
    var mu = solveMarkedUpForTotal(rec, target);
    if (mu == null || !isFinite(mu) ||
        Math.abs(applyFeesAndTax(mu, rec, true).total - target) > CP_EPS) {
      out.reason = 'unreachable'; return out;
    }
    out.markedUp = mu;
    if (!(mu > 0)) { out.reason = 'below-floor'; return out; }
    // freePool == 0 is not exotic — measured between 6.7% and 18.5% of
    // realistic change orders depending on how promise-heavy the corpus is.
    // Five distinct shapes reach it: every line promised, no lines at all, a
    // single unpromised line at qty 0, one at unitCost 0, and unpromised
    // lines whose prices cancel. An unrestricted remainder walk from here
    // does not merely produce a bad scale factor — it produces NaN and
    // ±Infinity line prices, and it restates the promised lines the design
    // carves out.
    if (!(naturalFree > 0)) { out.reason = 'no-free-pool'; return out; }
    var freePool = mu - lockedSell;
    out.freePool = freePool;
    if (!(freePool > 0)) { out.reason = 'promised-exceeds'; return out; }
    out.scale = freePool / naturalFree;
    out.ok = true;
    return out;
  }

  // THE ALLOCATION RULE — scale each unpromised line's PRICE by ONE factor.
  //
  // Not "flatten every line to one margin": that is what a target margin
  // means and it should stay its job. Measured on a document taken from
  // $31,900 to $34,000 — a $15,000 passthrough sub at 0% markup, labor at
  // 30%, materials at 20% — flatten hands the ZERO-MARGIN PASSTHROUGH
  // $2,894.74 of markup it must never carry and moves labor −$749.12.
  // Scaling preserves the relative pricing a person built on purpose.
  //
  // Promised (unitSell) lines keep their promise and are carved out
  // entirely. A promise is not something a document total may restate.
  //
  // ⚠⚠ THE REMAINDER WALK READS STORED ORDER, AND MUST.
  // js/building-sort.js:30-50 carries the standing rule for this repo:
  // SORT AT THE PRESENTATION BOUNDARY — NEVER re-order an array that
  // remainder math walks by index. Line order in this editor IS stored
  // order (section membership is positional here; see coSectionTotals).
  // The sort below is over a COPY OF THE INDEX LIST, never over `lines`,
  // and its tie-break is the stored index ascending — so the settling cent
  // lands on the same line on every repaint, on the server as in the
  // browser, and re-sorting the table for display cannot move a penny.
  //
  // ⚠⚠ THE POOL SETTLES ITS OWN SUB-CENT — IT IS NOT ROUNDED AWAY.
  // `poolCents` below quantises the pool to whole cents while `freePool`
  // need not be one: a promised line at qty 0.5 x $1,650.07 contributes
  // $825.035, so the pool lands on a half cent and the rows come to
  // $0.005 less than the number they are supposed to explain. That residual
  // is bounded by EXACTLY half a cent — which is what CP_EPS was set to —
  // so the old belt-and-braces check fired only when IEEE-754 rounding
  // pushed the computed difference a few ulps past its own exact bound.
  // Measured: of ~17,300 records sitting on that knife edge, 30% landed on
  // the wrong side of a strict `>`, decided by float representation rather
  // than by anything about the change order. That is why it read as random.
  //
  // Rounding the pool harder cannot fix it and widening the tolerance
  // disables it. The pool is made whole instead: after the cent walk, the
  // difference between what was spent and the pool it was handed is added
  // back, so `Σ free sells === freePool` by construction and the check
  // becomes an assertion about float arithmetic rather than about rounding.
  //
  // The sub-cent lands on the LARGEST free line (tie → stored index), where
  // it cannot distort a displayed row: a half cent on a $16,000 line is
  // invisible, the same half cent on a $0.01 line doubles it. This is a
  // choice about VALUE, not about display order, so it does not re-order
  // anything the remainder walk reads and the building-sort rule above holds.
  function allocateFreePool(natural, promised, naturalFree, freePool) {
    var sells = new Array(natural.length);
    var idx = [];
    for (var i = 0; i < natural.length; i++) {
      if (promised[i]) { sells[i] = natural[i]; continue; }
      idx.push(i);
    }
    var scale = freePool / naturalFree;
    var poolCents = Math.round(freePool * 100);
    var floors = new Array(natural.length);
    var rem = new Array(natural.length);
    var sum = 0;
    for (var k = 0; k < idx.length; k++) {
      var j = idx[k];
      var exact = natural[j] * scale * 100;
      var fl = Math.floor(exact);
      floors[j] = fl; rem[j] = exact - fl; sum += fl;
    }
    var short = poolCents - sum;
    if (short !== 0 && idx.length) {
      var step = short > 0 ? 1 : -1;
      var order = idx.slice().sort(function(a, b) {
        var d = step > 0 ? (rem[b] - rem[a]) : (rem[a] - rem[b]);
        return d !== 0 ? d : (a - b);   // stored index — never a display sort
      });
      var n = Math.abs(short);
      for (var c = 0; c < n; c++) floors[order[c % order.length]] += step;
    }
    for (var m = 0; m < idx.length; m++) sells[idx[m]] = floors[idx[m]] / 100;
    // Settle the sub-cent the cent walk could not place. When freePool is
    // already a whole number of cents — every record whose promised lines
    // are — `tail` is 0 and this is a no-op, which is why it moves no
    // existing allocation by a penny.
    if (idx.length) {
      var spent = 0;
      for (var t = 0; t < idx.length; t++) spent += sells[idx[t]];
      var tail = freePool - spent;
      if (tail !== 0) {
        var big = idx[0];
        for (var b = 1; b < idx.length; b++) {
          if (Math.abs(natural[idx[b]]) > Math.abs(natural[big])) big = idx[b];
        }
        sells[big] += tail;
      }
    }
    return sells;
  }

  // THE ONE CLIENT-PRICE DECISION FOR ONE RECORD: whether one was asked for,
  // whether it can be honoured, why not if not, and — when it can — what each
  // entry in `lines` is worth, index-aligned with the array as stored.
  // Returns null when no client price was asked for at all, which is every
  // change order that exists today.
  //
  // ⚠⚠ THIS IS THE ONLY PLACE THE QUESTION IS ANSWERED, AND IT IS CALLED FROM
  // EXACTLY ONE PLACE — the tail of computeForLines. It is not exported.
  //
  // It used to be answered TWICE, by two functions with different signatures:
  // clientPriceState(rec, lines) ran the allocation and could refuse, while
  // resolveMarkedUp(per, rec) called solveClientPrice directly and could not —
  // it did not hold `lines`, so it physically could not run the check. So the
  // rows painted a refusal while the Total chip, changeOrderMoney, job-wip,
  // the WIP report, Live Rooms and the pay applications all honoured the
  // price. On 1%–4% of realistic change orders — 4.26% over 300,000 — they
  // disagreed, by a median 13% OF THE CHANGE ORDER. The repair is not a third
  // copy of the check: it is that there is no second answer to keep in sync,
  // because the answer rides on `per` and both paths read that one object.
  //
  // Index-aligned rather than keyed by line id ON PURPOSE: imported records
  // do not reliably carry ids, and a suite whose fixtures all have one is a
  // suite that proves nothing about them.
  function decideClientPrice(rec, per) {
    if (!clientPriceRequested(rec)) return null;
    var st = solveClientPrice(rec, per.lockedSell, per.naturalFree);
    st.lineCount = per.lineCount;
    st.promisedCount = per.promisedCount;
    st.unpromisedCount = per.lineCount - per.promisedCount;
    // ZERO-COST LINES ARE THE PROMISED-SET-EMPTY CASE OF freePool == 0, not
    // a separate defect: three $0-cost lines give subtotal 0, natural
    // markedUp 0 and lockedSell 0, so there is no pool and no promise. The
    // amber affordance that keys off PROMISED lines never fires for them —
    // which is exactly why the refusal below keys off the pool instead, and
    // why this count exists to name them.
    st.zeroPriceCount = per.zeroPriceCount;
    st.roundTo = num(rec.roundTo);
    st.natural = per.natural;
    st.promisedFlags = per.promisedFlags;
    st.sells = null;
    if (st.ok) {
      st.sells = allocateFreePool(per.natural, per.promisedFlags, per.naturalFree, st.freePool);
      // THE DOCUMENT NUMBER IS THE ROWS. Not a number the rows approximate to
      // within a tolerance — the sum itself, assigned. `Σ sells` and
      // `st.markedUp` are the same value read twice from here on, so the
      // totals path and the row-painting path cannot report different money
      // however either of them is later changed.
      //
      // The check below therefore no longer guards a rounding gap — the pool
      // settles its own sub-cent in allocateFreePool. It asserts that the
      // allocation SPENT THE POOL IT WAS HANDED, which is a statement about
      // IEEE-754: the tolerance is float noise scaled for magnitude, nowhere
      // near the half cent the residual used to be able to reach. Break the
      // allocation (flatten it, say) and this is still the only thing between
      // a wrong row and a total that cannot explain it.
      var sum = 0;
      for (var s = 0; s < st.sells.length; s++) sum += st.sells[s];
      if (!isFinite(sum) || Math.abs(sum - st.markedUp) > 1e-6 + Math.abs(sum) * 1e-12) {
        st.ok = false; st.reason = 'allocation'; st.sells = null;
      } else {
        st.markedUp = sum;
      }
    }
    // ROUND TO $ PAUSES ONLY ON A PRICE THAT WAS ACTUALLY HONOURED.
    // This used to read clientPriceInForce(rec), which tests only that the
    // string PARSES. A refused price still stood roundTo down and silently
    // moved the total — measured at −$400.00 and −$300.00 at roundTo 500 on
    // records whose price the editor was, at that moment, explaining it had
    // refused. Refusing and then changing the number anyway is the same bug
    // the gate collapse above exists to end, one field further down.
    st.roundToPaused = st.roundTo > 0 && st.ok;
    return st;
  }

  // The public read of that one decision. A wrapper, deliberately: it takes
  // the answer computeForLines already put on `per` rather than working it
  // out again, so there is no path by which a caller of this and a caller of
  // resolveMarkedUp can be told different things about the same record.
  function clientPriceState(rec, lines) {
    if (!clientPriceRequested(rec)) return null;
    var arr = Array.isArray(lines) ? lines
      : (Array.isArray(rec && rec.lines) ? rec.lines : []);
    return computeForLines(rec, arr).clientPrice;
  }

  // THE document-level marked-up total, target margin resolved.
  //
  // Every caller used to hand-roll `targetMarginActive(x) ?
  // applyTargetMargin(per.subtotal, x) : per.markedUp`. Six copies of one
  // ternary was survivable while there was only one rule. There are two
  // now, and a copy left un-ported does not throw — it silently discards
  // a promised price and under-reports the document. So the rule lives
  // here and the call sites call it.
  //
  // Target margin back-solves a marked-up total from COST. A promised
  // price is not derived from cost, so it may not be restated by a
  // margin target: the locked lines are carved out at face value and
  // only the remaining cost is back-solved.
  //
  //   income = Σ promised sell + applyTargetMargin(unlocked cost)
  //
  // `per` may arrive stripped — estimate-editor rebuilds it as a fresh
  // {subtotal, markedUp} literal in two places — so the locked keys are
  // num()-coerced and a stripped `per` degrades to exactly today's
  // number rather than poisoning the job with NaN.
  function resolveMarkedUp(per, rec) {
    var p = per || {};
    // A TYPED CLIENT PRICE OUTRANKS EVERYTHING BELOW IT, because it is the
    // most specific instruction there is: not a rate, a number. It writes
    // the same variable the target margin writes, so nothing downstream
    // learns a second pricing model.
    //
    // On a refusal this FALLS THROUGH deliberately: the change order prices
    // exactly as it would with the field empty, and the editor puts the
    // reason on screen. Returning a clamped or partial number here is the
    // one outcome this design will not have.
    // ⚠⚠ A READER, NOT A SECOND GATE. This used to call solveClientPrice
    // itself, re-deriving `naturalFree` as `markedUp - lockedSell` because
    // its signature carries no `lines` and it therefore could not run the
    // allocation check that clientPriceState ran. That is precisely how the
    // Total chip and the server came to honour a price the rows had refused.
    //
    // There is nothing to solve here any more: computeForLines took the
    // decision, `per` carries it, and the row painter reads the SAME object.
    // A `per` that never came from computeForLines carries no decision and
    // falls through to line markups — which is the safe direction, and is
    // what every caller in the repo already does, since all seven pass a
    // `per` from computeForLines(rec, lines) on the line immediately above.
    var cp = p.clientPrice;
    if (cp && cp.ok) return cp.markedUp;
    if (!targetMarginActive(rec)) return p.markedUp;
    var lockedSell = num(p.lockedSell);
    var lockedSubtotal = num(p.lockedSubtotal);
    // A real `per` always carries a numeric subtotal, and a number is
    // handed straight through with no coercion whatsoever — that is what
    // keeps the legacy branch below byte-identical. Only a missing or
    // non-numeric subtotal (a stripped or absent `per`) is coerced, so it
    // degrades to 0 rather than dividing `undefined` into NaN and
    // poisoning totalIncome, revisedProfit, revisedMargin and backlog.
    var subtotal = typeof p.subtotal === 'number' ? p.subtotal : num(p.subtotal);
    // Nothing promised on this record — which is EVERY change order that
    // exists today — takes the original expression, character for
    // character. It does not so much as re-associate an operation.
    if (!lockedSell && !lockedSubtotal) return applyTargetMargin(subtotal, rec);
    return lockedSell + applyTargetMargin(subtotal - lockedSubtotal, rec);
  }

  // Apply fees, tax, and round-up on top of an already-marked-up
  // total. Returns the full breakdown so the totals chip bar can
  // render each step. Both estimates and COs share this exactly —
  // the fee/tax/round fields live at the record root with identical
  // names (feeFlat, feePct, taxPct, roundTo).
  // Was a client price on this record actually HONOURED? Derived from the
  // one decider, never from a second reading of the fields.
  //
  // The recursion this would otherwise cause — decide → solve → bisect →
  // applyFeesAndTax → decide — is cut by the explicit third argument: every
  // call made from INSIDE the solve passes it, because during a solve the
  // pause is on by definition (that is what makes a typed price reachable
  // at all). Only calls from outside ask this question.
  function clientPriceHonoured(rec) {
    if (!clientPriceRequested(rec)) return false;
    var cp = computeForLines(rec, Array.isArray(rec.lines) ? rec.lines : []).clientPrice;
    return !!(cp && cp.ok);
  }

  function applyFeesAndTax(markedUp, rec, honoured) {
    var feeFlat = rec ? num(rec.feeFlat) : 0;
    var feePctAmount = markedUp * (rec ? num(rec.feePct) : 0) / 100;
    var preTax = markedUp + feeFlat + feePctAmount;
    var taxAmount = preTax * (rec ? num(rec.taxPct) : 0) / 100;
    var beforeRound = preTax + taxAmount;
    var roundTo = rec ? num(rec.roundTo) : 0;
    // ROUND TO $ STANDS DOWN WHILE A CLIENT PRICE IS IN FORCE.
    //
    // A ceiling is not injective. Over 150,000 markedUp samples, roundTo 0
    // yields 150,001 distinct totals, roundTo 25 yields 65, and roundTo 500
    // yields FOUR — so a typed client price that is not itself a multiple of
    // roundTo is simply unreachable: $34,250 at roundTo 500 delivers
    // $34,500.00, silently $250 over. The pause lives HERE rather than in
    // editor state so that the browser, the server's changeOrderMoney and
    // the solve below cannot disagree about it.
    //
    // The `roundTo > 0` test comes first on purpose: a record with no
    // targetPrice — every change order that exists today — never reaches
    // the honoured test at all when roundTo is 0, and gets false in one
    // property read when it isn't.
    //
    // ⚠ HONOURED, NOT MERELY TYPED. clientPriceInForce asks only whether the
    // string parses to a positive number, so a price the editor was refusing
    // on screen still stood roundTo down and moved the total anyway: −$400.00
    // on a no-free-pool record at roundTo 500, −$300.00 on promised-exceeds.
    // A refusal must change NOTHING.
    if (roundTo > 0) {
      var pause = honoured === undefined ? clientPriceHonoured(rec) : !!honoured;
      if (pause) roundTo = 0;
    }
    var total = beforeRound;
    var rounded = 0;
    if (roundTo > 0) {
      total = Math.ceil(beforeRound / roundTo) * roundTo;
      rounded = total - beforeRound;
    }
    return {
      feeFlat: feeFlat,
      feePctAmount: feePctAmount,
      preTax: preTax,
      taxAmount: taxAmount,
      beforeRound: beforeRound,
      rounded: rounded,
      total: total
    };
  }

  // GROSS MARGIN — ONE definition, because there were two and they
  // disagreed by 2.27x on a real change order.
  //
  // js/change-order-editor.js computed
  //     (applyFeesAndTax(...).total - subtotal) / applyFeesAndTax(...).total
  // and js/estimate-editor.js computed
  //     (markedUp - subtotal) / markedUp
  // for the same word, twelve hundred lines apart. Measured on $27,500 of
  // cost at 10.4173% markup with 7% sales tax and the flat fee that lands
  // the change order on exactly $34,000: the CO strip printed 19.1176%
  // where the true figure is 9.4344%, and its Profit chip printed $6,500
  // against a real $2,864.76 — $3,635.24 of overstatement, 2.27x.
  //
  // COLLECTED SALES TAX IS MONEY HELD FOR THE STATE. It is not revenue and
  // it is not margin. Neither is a round-up, which is a rounding artifact,
  // nor a fee — a fee may well be profit, but it is not profit ON THE WORK,
  // and gross margin is a statement about the work. `markedUp` is the
  // marked-up price of the work and nothing else, so it is the denominator.
  //
  // Character-for-character the estimate editor's expression, including its
  // `> 0` guard and its `null` return, so adopting it moves no estimate
  // number by a floating-point ulp. A number is handed straight through
  // with no coercion at all; only a missing or string-typed argument is
  // num()-coerced, so the legacy path cannot so much as re-associate.
  //
  // NULL IS NOT ZERO. With no revenue to divide by there is no margin, and
  // a chip that prints "0.0%" there is a confident wrong answer on the one
  // number people read. Callers must render null as an em dash. The guard
  // also catches the near-zero denominator that makes a percentage explode
  // (a $500.01 price against a $500 flat fee reads -5.0e+6%): it cannot
  // return a positive percentage on a loss, because markedUp > 0 and
  // markedUp < subtotal forces the numerator negative.
  function grossMarginPct(subtotal, markedUp) {
    var mu = typeof markedUp === 'number' ? markedUp : num(markedUp);
    if (!(mu > 0)) return null;
    var sub = typeof subtotal === 'number' ? subtotal : num(subtotal);
    return ((mu - sub) / mu) * 100;
  }

  var api = {
    num: num,
    grossMarginPct: grossMarginPct,
    sectionHeaderFor: sectionHeaderFor,
    sectionMarkupForLine: sectionMarkupForLine,
    effectiveMarkupForLine: effectiveMarkupForLine,
    sellLocked: sellLocked,
    lineMoney: lineMoney,
    computeForLines: computeForLines,
    targetMarginActive: targetMarginActive,
    applyTargetMargin: applyTargetMargin,
    parseMoney: parseMoney,
    clientPriceRequested: clientPriceRequested,
    clientPriceInForce: clientPriceInForce,
    clientPriceState: clientPriceState,
    resolveMarkedUp: resolveMarkedUp,
    applyFeesAndTax: applyFeesAndTax
  };

  // Dual-target. The browser gets window.p86Pricing from the script tag;
  // the server gets the very same object via require(). This file has no
  // DOM dependency, so there is no reason for a server-derived total and
  // the number on screen to be computed by different code — the drift
  // this module was written to end (see the header) applies just as much
  // across the client/server line as it did across two editors.
  if (typeof window !== 'undefined') window.p86Pricing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
