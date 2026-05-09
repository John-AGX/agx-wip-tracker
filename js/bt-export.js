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
      byLineId: byLineId,
      sectionByLineId: sectionByLineId,
      groupNameByLineId: groupNameByLineId
    };
  }

  // Per-line percent markup. Mirrors the editor pipeline. Returns a
  // plain percent (e.g. 35 = 35%). Dollar-mode sections return 0 here;
  // the section-flat-$ is folded into the per-line markup later by
  // pro-rata distribution.
  function effectiveMarkup(line, section, estimate) {
    var inDollar = section && section.markupMode === 'dollar';
    if (section && section.overrideLineMarkups) {
      if (inDollar) return 0;
      if (section.markup !== '' && section.markup != null) return num(section.markup);
      if (estimate && estimate.defaultMarkup != null && estimate.defaultMarkup !== '') return num(estimate.defaultMarkup);
      return 0;
    }
    if (line && line.markup !== '' && line.markup != null) return num(line.markup);
    if (inDollar) return 0;
    if (section && section.markup !== '' && section.markup != null) return num(section.markup);
    if (estimate && estimate.defaultMarkup != null && estimate.defaultMarkup !== '') return num(estimate.defaultMarkup);
    return 0;
  }

  // Final client total — must match the editor's pricing pipeline so
  // the BT export totals match the proposal exactly.
  function computeClientTotal(estimate) {
    var includedIds = includedGroupIds(estimate);
    var allLines = (window.appData && window.appData.estimateLines || []).filter(function (l) {
      return l.estimateId === estimate.id && includedIds.indexOf(l.alternateId) >= 0;
    });
    var markedUp = 0;
    includedIds.forEach(function (gid) {
      var group = allLines.filter(function (l) { return l.alternateId === gid; });
      var currentSection = null;
      group.forEach(function (l) {
        if (l.section === '__section_header__') {
          currentSection = l;
          if (l.markupMode === 'dollar' && l.markup !== '' && l.markup != null) {
            markedUp += num(l.markup);
          }
          return;
        }
        var ext = num(l.qty) * num(l.unitCost);
        var m = effectiveMarkup(l, currentSection, estimate);
        markedUp += ext * (1 + m / 100);
      });
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

    var lineRows = nonHeaderLines.map(function (l) {
      var bc = num(l.qty) * num(l.unitCost);
      var section = catMap.sectionByLineId[l.id];
      var pctMarkup = effectiveMarkup(l, section, estimate);
      var sectionFlatShare = 0;
      if (section) {
        var st = sectionTotals[section.id];
        if (st && st.flatDollars && st.bcTotal > 0) {
          sectionFlatShare = st.flatDollars * (bc / st.bcTotal);
        }
      }
      var baseRev = bc * (1 + pctMarkup / 100) + sectionFlatShare;
      return { line: l, bc: bc, baseRev: baseRev };
    });

    // Pass 2: scale all line revenues so they sum to the editor's
    // computed client total. This bakes in feeFlat + feePct + taxPct
    // + round-up automatically. Lines with $0 builder cost still get
    // their baseRev (which is just sectionFlatShare) preserved.
    var subtotal = lineRows.reduce(function (s, r) { return s + r.baseRev; }, 0);
    var target = computeClientTotal(estimate);
    var scale = (subtotal > 0) ? (target / subtotal) : 1;

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
      var clientPrice = r.baseRev * scale;
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
