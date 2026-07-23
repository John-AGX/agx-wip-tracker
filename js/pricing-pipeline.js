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
//   computeForLines(rec, lines) → { subtotal, markedUp }
//   targetMarginActive(rec) → boolean
//   applyTargetMargin(subtotal, rec) → markedUp
//   applyFeesAndTax(markedUp, rec) → { feeFlat, feePctAmount, preTax,
//                                       taxAmount, beforeRound,
//                                       rounded, total }
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

  // Marked-up subtotal for a flat array of lines (one group). Section
  // headers in $-mode add their flat $ amount once to the marked-up
  // total but don't contribute to the subtotal — that mirrors the
  // existing markedUpForGroup helper. Estimates pass per-alternate
  // line slices; the CO editor passes the whole co.data.lines array.
  function computeForLines(rec, lines) {
    if (!Array.isArray(lines) || !lines.length) return { subtotal: 0, markedUp: 0 };
    var subtotal = 0;
    var markedUp = 0;
    lines.forEach(function(l) {
      if (l.section === '__section_header__') {
        if (l.markupMode === 'dollar' && l.markup !== '' && l.markup != null) {
          markedUp += num(l.markup);
        }
        return;
      }
      var ext = num(l.qty) * num(l.unitCost);
      subtotal += ext;
      var m = effectiveMarkupForLine(l, lines, rec);
      markedUp += ext * (1 + m / 100);
    });
    return { subtotal: subtotal, markedUp: markedUp };
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
    computeForLines: computeForLines,
    targetMarginActive: targetMarginActive,
    applyTargetMargin: applyTargetMargin,
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
