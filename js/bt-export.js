// Buildertrend xlsx export — Phase C.
//
// Writes the active estimate (active alternate only) as a single-sheet
// xlsx matching Buildertrend's "Sample Estimate Import" layout: 16 columns
// with a row per line item carrying the line's btCategory mapped to a BT
// Parent Group / Subgroup / Cost Type. A "Service & Repair Income" line is
// auto-injected first carrying the total client price — that's the line
// AGX uses in BT to surface the proposal price to the client.
//
// SheetJS (XLSX global) is loaded by js/proposal.js, so it's already
// available by the time this module is invoked from the editor.
(function() {
  'use strict';

  // Hardcoded fallback used if the API lookup fails (offline, network
  // glitch, settings row missing). Mirrors the seed in server/db.js so a
  // first-time export still produces a usable file. Real values are loaded
  // from /api/settings/bt_export_mapping and edited via Admin -> Templates.
  var DEFAULT_MAPPING = {
    categories: {
      materials: { parentGroup: 'Materials & Supplies', parentDesc: 'Materials and supplies costs', subgroup: 'Materials',              subgroupDesc: 'General materials',          costCode: '', costType: 'Material' },
      labor:     { parentGroup: 'Direct Labor',         parentDesc: 'AG Exteriors direct labor',     subgroup: 'Field Labor',            subgroupDesc: 'Field crew labor',           costCode: '', costType: 'Labor' },
      gc:        { parentGroup: 'General Conditions',   parentDesc: 'Project general conditions',     subgroup: 'Site Operations',        subgroupDesc: 'General site operations',   costCode: '', costType: 'Other' },
      sub:       { parentGroup: 'Subcontractors',       parentDesc: 'Subcontracted scopes',           subgroup: 'General Subcontractors', subgroupDesc: 'General subcontracted work', costCode: '', costType: 'Subcontractor' }
    },
    fallback: { parentGroup: 'Uncategorized', parentDesc: '', subgroup: 'General', subgroupDesc: '', costCode: '', costType: 'Other' },
    income: {
      title: 'Service & Repair Income',
      parentGroup: 'Income',
      parentDesc: 'Client-facing income line',
      subgroup: 'Service & Repair',
      subgroupDesc: 'Service and repair income',
      costCode: 'Service & Repair Income',
      costType: 'Other'
    }
  };

  var _mappingCache = null;
  var _mappingPromise = null;

  function loadMapping() {
    if (_mappingCache) return Promise.resolve(_mappingCache);
    if (_mappingPromise) return _mappingPromise;
    if (!window.agxApi || !window.agxApi.isAuthenticated()) {
      _mappingCache = DEFAULT_MAPPING;
      return Promise.resolve(_mappingCache);
    }
    _mappingPromise = window.agxApi.settings.get('bt_export_mapping')
      .then(function(res) {
        var v = res && res.setting && res.setting.value;
        _mappingCache = (v && v.categories && v.income) ? v : DEFAULT_MAPPING;
        return _mappingCache;
      })
      .catch(function() {
        _mappingCache = DEFAULT_MAPPING;
        return _mappingCache;
      });
    return _mappingPromise;
  }

  // Called by the Admin Templates UI after a save so the next export uses
  // the freshly-edited mapping without a page refresh.
  function invalidateMappingCache() {
    _mappingCache = null;
    _mappingPromise = null;
  }

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // Walks lines in their stored order; each line inherits the btCategory
  // of the most recent section header above it. Lines before the first
  // section (or under a section with no btCategory) get null and fall
  // back to BT_FALLBACK at write time.
  function buildLineCategoryMap(estimate) {
    var lines = (window.appData && window.appData.estimateLines || []).filter(function(l) {
      return l.estimateId === estimate.id && l.alternateId === estimate.activeAlternateId;
    });
    var byLineId = {};
    var currentCat = null;
    lines.forEach(function(l) {
      if (l.section === '__section_header__') {
        currentCat = l.btCategory || null;
      } else {
        byLineId[l.id] = currentCat;
      }
    });
    return { lines: lines, byLineId: byLineId };
  }

  // Mirrors the editor's pricing pipeline: subtotal -> per-line markup ->
  // marked-up subtotal -> + flat fee -> + percent fee -> + tax -> round-up.
  function computeClientTotal(estimate) {
    var lines = (window.appData && window.appData.estimateLines || []).filter(function(l) {
      return l.estimateId === estimate.id && l.alternateId === estimate.activeAlternateId && l.section !== '__section_header__';
    });
    var defaultMarkup = num(estimate.defaultMarkup);
    var markedUp = 0;
    lines.forEach(function(l) {
      var ext = num(l.qty) * num(l.unitCost);
      var m = (l.markup === '' || l.markup == null) ? defaultMarkup : num(l.markup);
      markedUp += ext * (1 + m / 100);
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
    return String(s || 'AGX_Estimate').replace(/[^\w \-]+/g, '').replace(/\s+/g, '_').slice(0, 60);
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
    var estimate = (window.appData && window.appData.estimates || []).find(function(e) { return e.id === estId; });
    if (!estimate) { alert('Estimate not found.'); return; }

    loadMapping().then(function(mapping) {
      var categories = mapping.categories || {};
      var fallback = mapping.fallback || DEFAULT_MAPPING.fallback;
      var income = mapping.income || DEFAULT_MAPPING.income;

      var catMap = buildLineCategoryMap(estimate);
      var nonHeader = catMap.lines.filter(function(l) { return l.section !== '__section_header__'; });
      var defaultMarkup = num(estimate.defaultMarkup);
      var clientTotal = computeClientTotal(estimate);

      // Column order matches the BT sample exactly so an admin can drop the
      // file straight into BT's Estimate Import without remapping.
      var headers = [
        'Title', 'Description',
        'Parent Group', 'Parent Group Description',
        'Subgroup', 'Subgroup Description',
        'Cost Code', 'Quantity', 'Unit', 'Unit Cost',
        'Cost Type', 'Total Cost', 'Internal Notes',
        'Markup', 'Markup Type', 'Line Item Type'
      ];
      var rows = [headers];

      // === Service & Repair Income (auto-injected first row) ===
      rows.push([
        income.title, '',
        income.parentGroup, income.parentDesc,
        income.subgroup, income.subgroupDesc,
        income.costCode,
        1, 'ea',
        Number(clientTotal.toFixed(2)),
        income.costType,
        Number(clientTotal.toFixed(2)),
        'AGX export — total client price (auto-injected)',
        0, '$', 'Estimate'
      ]);

      // === Cost-side line items, in stored order ===
      nonHeader.forEach(function(l) {
        var cat = catMap.byLineId[l.id];
        var m = (cat && categories[cat]) || fallback;
        var qty = num(l.qty);
        var unitCost = num(l.unitCost);
        var totalCost = qty * unitCost;
        var markup = (l.markup === '' || l.markup == null) ? defaultMarkup : num(l.markup);
        rows.push([
          l.description || '', '',
          m.parentGroup, m.parentDesc,
          m.subgroup, m.subgroupDesc,
          m.costCode,
          qty, l.unit || 'ea',
          Number(unitCost.toFixed(2)),
          m.costType,
          Number(totalCost.toFixed(2)),
          l.notes || '',
          Number(markup), '%', 'Estimate'
        ]);
      });

      var ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [
        { wch: 24 }, { wch: 30 }, { wch: 22 }, { wch: 32 },
        { wch: 22 }, { wch: 32 }, { wch: 22 }, { wch: 9 }, { wch: 6 },
        { wch: 11 }, { wch: 14 }, { wch: 12 }, { wch: 30 },
        { wch: 8 }, { wch: 12 }, { wch: 13 }
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
