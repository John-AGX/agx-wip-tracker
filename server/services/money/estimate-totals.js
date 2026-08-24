'use strict';

/**
 * estimate-totals.js — server-side estimate proposal totals, byte-parity with
 * the browser's computeEstimateTotals (js/estimates.js:45).
 *
 * Why parity is guaranteed
 * ------------------------
 * Both sides run the SAME pricing pipeline — js/pricing-pipeline.js, which is
 * dual-target (window.p86Pricing in the browser, module.exports on the server;
 * change-order-totals.js already requires it). This function replicates the
 * browser's computeEstimateTotals cascade call-for-call. The only difference:
 * the browser reads lines from the appData.estimateLines global, filtered by
 * estimateId; the server reads them from the estimate's own JSONB blob
 * (est.data.lines), which is the same data. Same math + same inputs → the
 * server number can never drift from the number the estimator saw.
 *
 * Used by the deal-memory numbers writer to carry the estimate-stage contract
 * value (proposalTotal) through the lead→estimate→job lineage. Never let LLM
 * prose own this number — it comes from here, deterministically.
 *
 * Input: the estimate JSONB blob (the `data` column), i.e. { lines, alternates,
 * activeAlternateId, defaultMarkup, targetMargin, feeFlat, feePct, taxPct,
 * roundTo, … } — exactly what buildEstimateContext calls `blob`.
 * Output: the same field set the browser returns.
 */

const pricing = require('../../../js/pricing-pipeline.js');

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

function computeEstimateTotals(blob) {
  const est = blob || {};
  const allLines = Array.isArray(est.lines) ? est.lines : [];
  let lineCount = 0, sectionCount = 0;
  allLines.forEach(function (l) {
    if (l.section === '__section_header__') sectionCount++; else lineCount++;
  });

  const P = pricing;
  if (!P || !P.computeForLines) {
    // Pricing pipeline unavailable — bare cost subtotal (mirrors the browser
    // fallback so a caller still gets a sane, non-throwing shape).
    let sub0 = 0;
    allLines.forEach(function (l) {
      if (l.section !== '__section_header__') sub0 += num(l.qty) * num(l.unitCost);
    });
    return {
      baseCost: sub0, markedUp: sub0, blendedMarkup: 0, clientPrice: sub0, proposalTotal: sub0,
      feeFlat: 0, feePctAmount: 0, taxAmount: 0, lineCount: lineCount, sectionCount: sectionCount,
      targetMarginActive: false
    };
  }

  const targetActive = P.targetMarginActive(est);
  let subtotal = 0, markedUp = 0;
  // EVERY PRICED SET THAT WENT INTO `markedUp`, kept rather than discarded.
  // An estimate total is a SUM of per-alternate resolves, so no single `per`
  // holds it and applyFeesAndTax cannot be handed one. It is handed the parts
  // instead: the round-to pause is decided from the line sets that were
  // actually priced here, and never — as it was until this commit — from a
  // second walk of est.lines taken inside applyFeesAndTax itself.
  const parts = [];
  const alts = Array.isArray(est.alternates) ? est.alternates : [];
  if (alts.length) {
    // Sum every INCLUDED group; excluded groups keep their bottom-up markup
    // (matching the editor) but don't contribute to the total.
    alts.forEach(function (alt) {
      if (alt.excludeFromTotal) return;
      const per = P.computeForLines(est, allLines.filter(function (l) { return l.alternateId === alt.id; }));
      parts.push(per);
      subtotal += per.subtotal;
      markedUp += targetActive ? P.applyTargetMargin(per.subtotal, est) : per.markedUp;
    });
  } else {
    // Legacy estimate with no alternates[] — one implicit group of all lines.
    const per = P.computeForLines(est, allLines);
    parts.push(per);
    subtotal = per.subtotal;
    markedUp = targetActive ? P.applyTargetMargin(per.subtotal, est) : per.markedUp;
  }

  // ⚠ THE ESTIMATE LOCK IS NOT TOUCHED HERE, AND DELIBERATELY NOT.
  // clientPriceRequested refuses any record carrying `alternates`, so on every
  // estimate that carries the key no part is ever honoured and this pause is
  // false — byte-identically to before. A blob with NO `alternates` key at all
  // still returns requested=true, and this still reads that part's decision,
  // which is what the old fallback read: `allLines` IS `est.lines` here, so
  // the number does not move. Repairing THAT — a client price standing a
  // round-up down on an estimate whose markedUp never had the price applied —
  // is a change to the lock itself and belongs in its own commit.
  const fees = P.applyFeesAndTax(markedUp, est, P.sumOfPriced(parts));
  const blendedMarkup = subtotal > 0 ? (markedUp / subtotal - 1) * 100 : 0;
  return {
    baseCost: subtotal,
    markedUp: markedUp,
    blendedMarkup: blendedMarkup,
    clientPrice: fees.total,     // matches Proposal Total in the editor
    proposalTotal: fees.total,
    feeFlat: fees.feeFlat,
    feePctAmount: fees.feePctAmount,
    taxAmount: fees.taxAmount,
    lineCount: lineCount,
    sectionCount: sectionCount,
    targetMarginActive: targetActive
  };
}

module.exports = { computeEstimateTotals };
