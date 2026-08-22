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
//   sellLocked(line) → boolean
//   lineMoney(line, lines, rec) → { ext, sell, locked, markup }
//   computeForLines(rec, lines) → { subtotal, markedUp,
//                                   lockedSubtotal, lockedSell }
//   targetMarginActive(rec) → boolean
//   applyTargetMargin(subtotal, rec) → markedUp
//   resolveMarkedUp(per, rec) → markedUp
//   applyFeesAndTax(markedUp, rec) → { feeFlat, feePctAmount, preTax,
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
  // back-solve. THE EMPTY-ARRAY RETURN CARRIES ALL FOUR KEYS ON
  // PURPOSE: omit the locked pair and resolveMarkedUp turns income into
  // NaN on any record with an active target margin and no lines, and
  // NaN propagates into totalIncome, revisedProfit, revisedMargin and
  // backlog — the whole job tile.
  function computeForLines(rec, lines) {
    if (!Array.isArray(lines) || !lines.length) {
      return { subtotal: 0, markedUp: 0, lockedSubtotal: 0, lockedSell: 0 };
    }
    var subtotal = 0;
    var markedUp = 0;
    var lockedSubtotal = 0;
    var lockedSell = 0;
    lines.forEach(function(l) {
      if (l.section === '__section_header__') {
        if (l.markupMode === 'dollar' && l.markup !== '' && l.markup != null) {
          markedUp += num(l.markup);
        }
        return;
      }
      var mm = lineMoney(l, lines, rec);
      subtotal += mm.ext;
      markedUp += mm.sell;
      if (mm.locked) { lockedSubtotal += mm.ext; lockedSell += mm.sell; }
    });
    return {
      subtotal: subtotal, markedUp: markedUp,
      lockedSubtotal: lockedSubtotal, lockedSell: lockedSell
    };
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
  function applyFeesAndTax(markedUp, rec) {
    var feeFlat = rec ? num(rec.feeFlat) : 0;
    var feePctAmount = markedUp * (rec ? num(rec.feePct) : 0) / 100;
    var preTax = markedUp + feeFlat + feePctAmount;
    var taxAmount = preTax * (rec ? num(rec.taxPct) : 0) / 100;
    var beforeRound = preTax + taxAmount;
    var roundTo = rec ? num(rec.roundTo) : 0;
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

  var api = {
    num: num,
    sectionHeaderFor: sectionHeaderFor,
    sectionMarkupForLine: sectionMarkupForLine,
    effectiveMarkupForLine: effectiveMarkupForLine,
    sellLocked: sellLocked,
    lineMoney: lineMoney,
    computeForLines: computeForLines,
    targetMarginActive: targetMarginActive,
    applyTargetMargin: applyTargetMargin,
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
