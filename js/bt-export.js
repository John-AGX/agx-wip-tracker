// Buildertrend xlsx export — Phase D.
//
// Writes the active estimate (every INCLUDED group) as a single-sheet
// xlsx matching Buildertrend's NEW 13-column proposal-import layout
// (sample: ProposalReport (3).xls). One row per cost line, with the
// line's btCategory mapped to a BT Cost Code.
//
// What changed from Phase C:
//   - Dropped the auto-injected "Service & Repair Income" line and the
//     -100% per-line workaround. The export is now pure cost lines at
//     their real markups.
//   - Dropped the Parent Group / Subgroup / Cost Type tri-column —
//     BT's new import only needs Category + Cost Code.
//   - Section flat-$ markups + estimate-level fees + tax + round-up
//     are pro-rata distributed onto each line's effective % markup, so
//     the export total matches the proposal exactly without leaking a
//     pseudo "income" row.
//
// WHAT CHANGED WHEN unitSell REACHED ESTIMATES
//   This file used to carry a COMPLETE second copy of the markup cascade:
//   its own effectiveMarkup(), its own per-line `ext * (1 + m/100)`, and its
//   own group walk. That copy had already drifted — it never applied a
//   TARGET MARGIN, so an estimate priced by a target exported at its
//   bottom-up markup total and the spreadsheet disagreed with the proposal
//   the client had been sent — and it would have drifted again the moment a
//   line carried a promised price, because a fork cannot learn a field.
//
//   The cascade now comes from window.p86Pricing: computeForLines for the
//   per-line prices, resolveTargetMargin for the group total. What is
//   deliberately NOT taken from there is applyFeesAndTax — the fee/tax/
//   round-up arithmetic below is character-identical to the pipeline's with
//   the client-price pause off, and a change order's typed price is a
//   document absolute that must never reach an estimate (see
//   test/co-client-price.test.js, which pins that this file has never heard
//   of it BY NAME — which is why it is not written here). One rule for the
//   markup, one local ceiling, and the
//   reason for the split written down rather than rediscovered.
//
// SheetJS (XLSX global) is loaded by js/proposal.js, so it's already
// available by the time this module is invoked from the editor.
(function () {
  'use strict';

  // BT Cost Code names, copy/pasted from the BT dropdown so they match
  // exactly. The mapping admins edit is now just btCategory -> costCode
  // (a single string per category) — no more Parent Group / Subgroup /
  // Description fields. Cost Type column is gone too.
  var DEFAULT_MAPPING = {
    categories: {
      materials: { costCode: 'Materials & Supplies Costs' },
      labor:     { costCode: 'Direct Labor' },
      gc:        { costCode: 'General Conditions' },
      sub:       { costCode: 'Subcontractors Costs' }
    },
    fallback: { costCode: 'General Conditions' }
  };

  var _mappingCache = null;
  var _mappingPromise = null;

  // Reads the saved mapping from /api/settings. Migrates legacy mappings
  // (Phase C shape with parentGroup/subgroup/costType) by stripping
  // those fields — only `costCode` is consulted. If the legacy
  // costCode was blank (admins skipped it), we fall back to the
  // built-in default for that category so the export still works.
  function loadMapping() {
    if (_mappingCache) return Promise.resolve(_mappingCache);
    if (_mappingPromise) return _mappingPromise;
    if (!window.p86Api || !window.p86Api.isAuthenticated()) {
      _mappingCache = DEFAULT_MAPPING;
      return Promise.resolve(_mappingCache);
    }
    _mappingPromise = window.p86Api.settings.get('bt_export_mapping')
      .then(function (res) {
        var v = res && res.setting && res.setting.value;
        _mappingCache = normalizeMapping(v);
        return _mappingCache;
      })
      .catch(function () {
        _mappingCache = DEFAULT_MAPPING;
        return _mappingCache;
      });
    return _mappingPromise;
  }

  function normalizeMapping(v) {
    if (!v || typeof v !== 'object') return DEFAULT_MAPPING;
    var out = { categories: {}, fallback: { costCode: '' } };
    Object.keys(DEFAULT_MAPPING.categories).forEach(function (k) {
      var src = (v.categories && v.categories[k]) || {};
      var def = DEFAULT_MAPPING.categories[k];
      out.categories[k] = { costCode: src.costCode || def.costCode };
    });
    var fb = v.fallback || {};
    out.fallback = { costCode: fb.costCode || DEFAULT_MAPPING.fallback.costCode };
    return out;
  }

  function invalidateMappingCache() {
    _mappingCache = null;
    _mappingPromise = null;
  }

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  function includedGroupIds(estimate) {
    var alts = (estimate && estimate.alternates) || [];
    var included = alts.filter(function (a) { return !a.excludeFromTotal; });
    if (!included.length) return alts.map(function (a) { return a.id; });
    return included.map(function (a) { return a.id; });
  }

  // Walks lines in stored order; each line inherits the btCategory of
  // the most recent section header above it. Spans every INCLUDED
  // group so a multi-deck estimate exports as one cost-line list.
  //
  // `lines` is that concatenation and is the RIGHT array for the row LIST.
  // It is the WRONG array for PRICING, so `byGroup` is returned beside it
  // and no caller has to rebuild the boundary this walk already knows:
  // currentCat and currentSection both reset per group, because a section
  // header belongs to its own group and to nothing after it.
  function buildLineCategoryMap(estimate) {
    var includedIds = includedGroupIds(estimate);
    var altById = {};
    (estimate.alternates || []).forEach(function (a) { altById[a.id] = a; });
    var allLines = (window.appData && window.appData.estimateLines || []).filter(function (l) {
      return l.estimateId === estimate.id && includedIds.indexOf(l.alternateId) >= 0;
    });
    var byGroup = {};
    includedIds.forEach(function (gid) { byGroup[gid] = []; });
    allLines.forEach(function (l) { if (byGroup[l.alternateId]) byGroup[l.alternateId].push(l); });
    var orderedLines = [];
    var byLineId = {};
    var sectionByLineId = {};
    var groupNameByLineId = {};
    includedIds.forEach(function (gid) {
      var group = byGroup[gid] || [];
      var currentCat = null;
      var currentSection = null;
      group.forEach(function (l) {
        if (l.section === '__section_header__') {
          currentCat = l.btCategory || null;
          currentSection = l;
        } else {
          byLineId[l.id] = currentCat;
          sectionByLineId[l.id] = currentSection;
          groupNameByLineId[l.id] = altById[gid] ? altById[gid].name : '';
        }
        orderedLines.push(l);
      });
    });
    return {
      lines: orderedLines,
      byGroup: byGroup,
      byLineId: byLineId,
      sectionByLineId: sectionByLineId,
      groupNameByLineId: groupNameByLineId
    };
  }

  // THE pricing module, or nothing. A fallback that re-implements the
  // cascade when it is missing is the fork this file just deleted, wearing a
  // guard clause; an export that silently prices an estimate by a second
  // rule is worse than one that does not run.
  function P() {
    var p = window.p86Pricing;
    if (!p || !p.computeForLines || !p.resolveTargetMargin) {
      throw new Error('p86Pricing (js/pricing-pipeline.js) is not loaded — the Buildertrend export cannot price an estimate without it.');
    }
    return p;
  }

  // The local effectiveMarkup() that stood here is GONE rather than left
  // delegating: a wrapper with no caller is a second name for the rule, and
  // the next person to need a markup here would have reached for it instead
  // of for p86Pricing.lineMoney, which is what carries the promised price.
  //
  // Final client total — the editor's own pricing pipeline, so the BT export
  // total matches the proposal exactly. It picks up two things the fork here
  // never had: a TARGET MARGIN (applied per included group, which is how the
  // editor applies it) and the promised-price carve-out.
  function computeClientTotal(estimate) {
    var includedIds = includedGroupIds(estimate);
    var allLines = (window.appData && window.appData.estimateLines || []).filter(function (l) {
      return l.estimateId === estimate.id && includedIds.indexOf(l.alternateId) >= 0;
    });
    var markedUp = 0;
    includedIds.forEach(function (gid) {
      var group = allLines.filter(function (l) { return l.alternateId === gid; });
      markedUp += P().resolveTargetMargin(P().computeForLines(estimate, group), estimate);
    });
    var feeFlat = num(estimate.feeFlat);
    var feePct = num(estimate.feePct) / 100;
    var taxPct = num(estimate.taxPct) / 100;
    var roundTo = num(estimate.roundTo);
    var preTax = markedUp + feeFlat + (markedUp * feePct);
    var total = preTax + (preTax * taxPct);
    if (roundTo > 0) total = Math.ceil(total / roundTo) * roundTo;
    return total;
  }

  function safeFileName(s) {
    return String(s || 'P86_Estimate').replace(/[^\w \-]+/g, '').replace(/\s+/g, '_').slice(0, 60);
  }

  // Build the per-line export rows. Pro-rata distributes section
  // flat-$ markups + estimate-level feeFlat + feePct + taxPct + round-up
  // onto each line's effective markup so the row totals add up to the
  // proposal's client total without any pseudo "income" line.
  function buildExportRows(estimate, mapping) {
    var categories = mapping.categories || {};
    var fallback = mapping.fallback || DEFAULT_MAPPING.fallback;
    var catMap = buildLineCategoryMap(estimate);
    var nonHeaderLines = catMap.lines.filter(function (l) { return l.section !== '__section_header__'; });

    // Pass 1: compute each line's "base revenue" — builder cost +
    // line-level markup + its share of the section's flat-$ pool.
    // Section flat-$ is distributed pro-rata by builder cost so a
    // line with a $0 cost in a $-mode section still gets nothing
    // (avoids divide-by-zero when the section subtotal is 0).
    var sectionTotals = {}; // sectionId -> {bcTotal, flatDollars}
    nonHeaderLines.forEach(function (l) {
      var section = catMap.sectionByLineId[l.id];
      if (!section) return;
      var key = section.id;
      if (!sectionTotals[key]) {
        sectionTotals[key] = { bcTotal: 0, flatDollars: 0 };
        if (section.markupMode === 'dollar' && section.markup !== '' && section.markup != null) {
          sectionTotals[key].flatDollars = num(section.markup);
        }
      }
      sectionTotals[key].bcTotal += num(l.qty) * num(l.unitCost);
    });

    // PER GROUP, NEVER THE CONCATENATION. p86Pricing.sectionHeaderFor walks
    // BACKWARDS from a line's index and cannot see a group boundary, so
    // handing it catMap.lines lets a line that leads its own group inherit
    // the PREVIOUS group's last section header - a markup the editor never
    // showed it under. catMap.byGroup holds the same object references in
    // the same order as the array computeClientTotal prices below, so the
    // rows and the total now read one array per line instead of two.
    //
    // There is NO `|| catMap.lines` fallback here on purpose: it would read
    // as defence and behave as a silent reinstatement of the bug. Every
    // nonHeaderLine came out of byGroup's own walk, so the key is present.
    var lineRows = nonHeaderLines.map(function (l) {
      var mm = P().lineMoney(l, catMap.byGroup[l.alternateId], estimate);
      var bc = mm.ext;
      var section = catMap.sectionByLineId[l.id];
      var sectionFlatShare = 0;
      if (section) {
        var st = sectionTotals[section.id];
        if (st && st.flatDollars && st.bcTotal > 0) {
          sectionFlatShare = st.flatDollars * (bc / st.bcTotal);
        }
      }
      // A PROMISED line does not take a share of the section's flat-$ pool
      // either. The pool is markup being spread across derived prices; a
      // stated price is not a derived price, so there is nothing of it to
      // restate. (It still counts toward st.bcTotal, so the share the other
      // lines take is unchanged — the promise absorbs none of the pool and
      // steals none of it.)
      var baseRev = mm.locked ? mm.sell : (mm.sell + sectionFlatShare);
      return { line: l, bc: bc, baseRev: baseRev, promised: mm.locked };
    });

    // Pass 2: scale line revenues so they sum to the editor's computed
    // client total. This bakes in a target margin + feeFlat + feePct +
    // taxPct + round-up automatically. Lines with $0 builder cost still get
    // their baseRev (which is just sectionFlatShare) preserved.
    //
    // ⚠ A PROMISED LINE IS CARVED OUT OF THE SCALE, exactly as
    // p86Pricing.allocateFreePool carves it out of a typed client price, and
    // for the identical reason: the pool being spread is markup, fees and a
    // round-up, and none of those may restate a price that was PROMISED to
    // the owner. Scaling every line instead — which is what this did before
    // the field reached estimates — hands a $20,000 flat-rate line a share
    // of the tax on somebody else's work and exports it at a number nobody
    // quoted.
    //
    // THE ONE CASE THAT CANNOT CARVE: a worksheet whose lines are ALL
    // promised has no free revenue to absorb the fees, so there is nothing
    // to scale and the columns could not add up to the total whatever this
    // did. It falls back to scaling everything — the old behaviour — because
    // a spreadsheet whose Client Price column does not sum to its own total
    // is rejected by Buildertrend's import, and that is a worse answer than
    // a promise carrying its share of a fee the estimator chose to charge.
    var promisedRev = lineRows.reduce(function (s, r) { return s + (r.promised ? r.baseRev : 0); }, 0);
    var freeRev = lineRows.reduce(function (s, r) { return s + (r.promised ? 0 : r.baseRev); }, 0);
    var target = computeClientTotal(estimate);
    var carve = freeRev > 0;
    var scale = carve
      ? ((target - promisedRev) / freeRev)
      : ((promisedRev + freeRev) > 0 ? (target / (promisedRev + freeRev)) : 1);

    // Header row — exact column order from BT's ProposalReport sample.
    var headers = [
      'Category', 'Cost Code', 'Title', 'Description',
      'Quantity', 'Unit', 'Unit Cost', 'Builder Cost',
      'Markup', 'Markup Type', 'Client Price', 'Margin', 'Profit'
    ];
    var rows = [headers];

    lineRows.forEach(function (r) {
      var l = r.line;
      var cat = catMap.byLineId[l.id];
      var m = (cat && categories[cat]) || fallback;
      var qty = num(l.qty);
      var unitCost = num(l.unitCost);
      var bc = r.bc;
      var clientPrice = (carve && r.promised) ? r.baseRev : r.baseRev * scale;
      var profit = clientPrice - bc;
      var margin = (clientPrice > 0) ? (profit / clientPrice * 100) : 0;
      // Derive the effective % markup so BT shows it on each line.
      // For zero-cost lines we use $-mode so the dollar amount lands
      // verbatim in BT (otherwise % markup × 0 = 0 and the row
      // disappears).
      var markupType = '%';
      var markupVal = (bc > 0) ? ((clientPrice / bc - 1) * 100) : clientPrice;
      if (bc <= 0) markupType = '$';
      rows.push([
        'Costs',
        m.costCode || fallback.costCode || '',
        '',                                    // Title (BT sample leaves this blank)
        l.description || '',
        Number(qty.toFixed(4)),
        l.unit || 'ea',
        Number(unitCost.toFixed(2)),
        Number(bc.toFixed(2)),
        Number(markupVal.toFixed(4)),
        markupType,
        Number(clientPrice.toFixed(2)),
        Number(margin.toFixed(2)),
        Number(profit.toFixed(2))
      ]);
    });

    return rows;
  }

  function exportEstimateToBuildertrend(estId) {
    if (typeof XLSX === 'undefined') {
      alert('Excel library is still loading. Please try again in a moment.');
      return;
    }
    if (!estId && typeof window.getActiveEstimateForPreview === 'function') {
      var live = window.getActiveEstimateForPreview();
      if (live) estId = live.id;
    }
    var estimate = (window.appData && window.appData.estimates || []).find(function (e) { return e.id === estId; });
    if (!estimate) { alert('Estimate not found.'); return; }

    loadMapping().then(function (mapping) {
      var rows = buildExportRows(estimate, mapping);

      var ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [
        { wch: 8 },   // Category
        { wch: 26 },  // Cost Code
        { wch: 14 },  // Title
        { wch: 40 },  // Description
        { wch: 9 },   // Quantity
        { wch: 6 },   // Unit
        { wch: 11 },  // Unit Cost
        { wch: 12 },  // Builder Cost
        { wch: 9 },   // Markup
        { wch: 11 },  // Markup Type
        { wch: 12 },  // Client Price
        { wch: 9 },   // Margin
        { wch: 11 }   // Profit
      ];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Estimate Import');

      var fileName = 'BT_' + safeFileName(estimate.title) + '.xlsx';
      XLSX.writeFile(wb, fileName);
    });
  }

  window.exportEstimateToBuildertrend = exportEstimateToBuildertrend;
  window.invalidateBTMappingCache = invalidateMappingCache;
})();
