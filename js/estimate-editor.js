// AGX Estimate Editor — Phase A.
//
// Full-page editor that replaces the modal. Sticky header with linked-lead
// + linked-client chips and a live totals strip. Body splits into three
// tabs: Line Items (the meat), Details (header info, addresses, manager,
// scope, default markup), Preview (placeholder until Phase C).
//
// Autosave on blur — every input commits straight to appData.estimates /
// appData.estimateLines and triggers saveData(). The list view re-renders
// on close so a user can pop in/out without losing context.
(function() {
  'use strict';

  var _currentId = null;
  var _saveTimer = null;

  function debouncedSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function() { if (typeof saveData === 'function') saveData(); }, 400);
  }

  function getEstimate() {
    if (!_currentId || !window.appData) return null;
    return appData.estimates.find(function(e) { return e.id === _currentId; }) || null;
  }

  // Returns lines belonging to the estimate AND to the currently-active
  // alternate. Old estimates without an alternate id fall back to the
  // estimate's default alternate during ensureAlternates().
  function getLines() {
    if (!_currentId || !window.appData) return [];
    var est = getEstimate();
    var altId = est && est.activeAlternateId;
    return (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === _currentId && l.alternateId === altId;
    });
  }
  function getAllLinesForEstimate() {
    if (!_currentId || !window.appData) return [];
    return (appData.estimateLines || []).filter(function(l) { return l.estimateId === _currentId; });
  }
  function getActiveAlternate() {
    var est = getEstimate();
    if (!est || !est.alternates) return null;
    return est.alternates.find(function(a) { return a.id === est.activeAlternateId; }) || est.alternates[0] || null;
  }

  // Idempotent migration. Runs every time an estimate is opened so old
  // records (no alternates array, lines without alternateId) get a clean
  // default and behave the same as fresh ones. Saves silently after
  // backfill so the cleaned state persists.
  function ensureAlternates(est) {
    if (!est) return;
    var changed = false;
    if (!est.alternates || !est.alternates.length) {
      est.alternates = [{ id: 'alt_default', name: 'Base', isDefault: true }];
      changed = true;
    }
    if (!est.activeAlternateId || !est.alternates.find(function(a) { return a.id === est.activeAlternateId; })) {
      est.activeAlternateId = est.alternates[0].id;
      changed = true;
    }
    var defaultId = est.alternates[0].id;
    (appData.estimateLines || []).forEach(function(l) {
      if (l.estimateId === est.id && !l.alternateId) {
        l.alternateId = defaultId;
        changed = true;
      }
    });
    if (changed) debouncedSave();
  }

  function fmtCurrency(v) {
    if (v == null || isNaN(v)) v = 0;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // ──────────────────────────────────────────────────────────────────
  // Open / close — swap visibility between the estimates list view and
  // the editor. We reuse the existing list view div and the editor view
  // div is what gets populated by this module.
  // ──────────────────────────────────────────────────────────────────

  function openEstimateEditor(estimateId) {
    var est = (window.appData && appData.estimates || []).find(function(e) { return e.id === estimateId; });
    if (!est) { alert('Estimate not found.'); return; }
    _currentId = estimateId;
    // Idempotent: ensures the estimate has at least one alternate and that
    // every line is tagged with one. Old records get a "Base" alternate
    // and have their existing lines silently associated to it.
    ensureAlternates(est);

    var listView = document.getElementById('estimates-list-view');
    var editorView = document.getElementById('estimate-editor-view');
    if (listView) listView.style.display = 'none';
    if (editorView) editorView.style.display = '';

    // Title input — keystrokes update the estimate title live; debounced save
    var titleEl = document.getElementById('ee-title');
    if (titleEl) {
      titleEl.value = est.title || '';
      titleEl.oninput = function() {
        var e = getEstimate(); if (!e) return;
        e.title = titleEl.value;
        debouncedSave();
      };
    }

    renderHeaderChips();
    renderAlternateTabs();
    renderTotals();
    renderDetailsForm();
    renderLineItems();
    switchEstimateEditorTab('lines');
  }

  function closeEstimateEditor() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (typeof saveData === 'function') saveData();
    _currentId = null;
    var listView = document.getElementById('estimates-list-view');
    var editorView = document.getElementById('estimate-editor-view');
    if (editorView) editorView.style.display = 'none';
    if (listView) listView.style.display = '';
    if (typeof renderEstimatesList === 'function') renderEstimatesList();
  }

  function switchEstimateEditorTab(name) {
    document.querySelectorAll('[data-ee-tab]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.eeTab === name);
    });
    document.querySelectorAll('.ee-tab-content').forEach(function(el) {
      el.style.display = 'none';
    });
    var target = document.getElementById('ee-tab-' + name);
    if (target) target.style.display = '';
    // Preview tab is rendered on demand by js/estimate-preview.js since
    // pulling the template is async (one network round-trip the first time).
    if (name === 'preview' && typeof window.renderEstimatePreview === 'function') {
      window.renderEstimatePreview();
    }
  }

  // Expose the currently-open estimate for the preview module so it doesn't
  // have to crack open the IIFE's private state.
  window.getActiveEstimateForPreview = function() { return getEstimate(); };

  // ──────────────────────────────────────────────────────────────────
  // Header chips — linked lead and linked client surface here so users
  // can jump back to either with one click.
  // ──────────────────────────────────────────────────────────────────

  function renderHeaderChips() {
    var est = getEstimate();
    var chipsEl = document.getElementById('ee-linked-chips');
    if (!chipsEl) return;
    var html = '';

    if (est.client_id) {
      var clients = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
      var c = clients.find(function(x) { return x.id === est.client_id; });
      if (c) {
        html += '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:14px;background:rgba(79,140,255,0.12);color:#4f8cff;font-size:11px;font-weight:600;">' +
          '<span>&#x1F465;</span>' + escapeHTML(c.name) +
          (c.community_name && c.community_name !== c.name ? ' · ' + escapeHTML(c.community_name) : '') +
        '</span>';
      }
    }
    if (est.lead_id) {
      var leads = (window.agxLeads && window.agxLeads.getCached && window.agxLeads.getCached()) || [];
      var lead = leads.find(function(x) { return x.id === est.lead_id; });
      if (lead) {
        html += '<button class="small secondary" onclick="jumpToLeadFromEstimate(\'' + escapeHTML(lead.id) + '\')" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:14px;font-size:11px;">' +
          '<span>&#x1F4CB;</span>From lead: ' + escapeHTML(lead.title) + ' &rarr;' +
        '</button>';
      } else {
        html += '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:14px;background:rgba(251,191,36,0.10);color:#fbbf24;font-size:11px;">' +
          '<span>&#x1F4CB;</span>Linked to lead' +
        '</span>';
      }
    }
    chipsEl.innerHTML = html;
  }

  // Closes the editor and switches to the lead's modal — handy quick-jump
  // from the estimate header chip back to the parent lead.
  function jumpToLeadFromEstimate(leadId) {
    closeEstimateEditor();
    if (typeof window.openEditLeadModal === 'function') {
      setTimeout(function() { window.openEditLeadModal(leadId); }, 100);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Alternates / tiers — Good / Better / Best style parallel line sets.
  // Tax / fees / round-up are estimate-wide; each alternate has its
  // own subtotal -> markup -> client total computed from its own lines.
  // ──────────────────────────────────────────────────────────────────

  function renderAlternateTabs() {
    var wrap = document.getElementById('ee-alternate-tabs');
    if (!wrap) return;
    var est = getEstimate();
    if (!est || !est.alternates) { wrap.innerHTML = ''; return; }
    var activeId = est.activeAlternateId;
    var html = '';
    est.alternates.forEach(function(a) {
      var isActive = (a.id === activeId);
      var lineCount = (appData.estimateLines || []).filter(function(l) {
        return l.estimateId === est.id && l.alternateId === a.id && l.section !== '__section_header__';
      }).length;
      var bg = isActive ? 'rgba(79,140,255,0.18)' : 'transparent';
      var border = isActive ? '#4f8cff' : 'var(--border,#333)';
      var color = isActive ? '#fff' : 'var(--text-dim,#888)';
      html += '<button onclick="switchAlternate(\'' + escapeHTML(a.id) + '\')" ' +
        'style="padding:6px 14px;border:1px solid ' + border + ';border-radius:18px;' +
        'background:' + bg + ';color:' + color + ';font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">' +
        escapeHTML(a.name) +
        '<span style="font-size:10px;color:var(--text-dim,#888);font-weight:400;">' + lineCount + '</span>' +
        '</button>';
    });
    wrap.innerHTML = html;

    // Disable Delete when only one alternate exists — there's always at
    // least one parallel set, even if the user only ever uses Base.
    var deleteBtn = document.getElementById('ee-altDeleteBtn');
    if (deleteBtn) deleteBtn.disabled = (est.alternates.length <= 1);
  }

  function switchAlternate(altId) {
    var est = getEstimate();
    if (!est || !est.alternates) return;
    if (!est.alternates.find(function(a) { return a.id === altId; })) return;
    est.activeAlternateId = altId;
    debouncedSave();
    renderAlternateTabs();
    renderLineItems();
    renderTotals();
  }

  function addAlternateFromEditor() {
    var est = getEstimate();
    if (!est) return;
    if (!est.alternates) est.alternates = [];
    var name = prompt('Name for the new alternate:', suggestNextAlternateName(est));
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    var newAlt = { id: 'alt_' + Date.now(), name: name, isDefault: false };
    est.alternates.push(newAlt);
    est.activeAlternateId = newAlt.id;
    debouncedSave();
    renderAlternateTabs();
    renderLineItems();
    renderTotals();
  }

  function suggestNextAlternateName(est) {
    var existing = (est.alternates || []).map(function(a) { return (a.name || '').toLowerCase(); });
    var ladder = ['Good', 'Better', 'Best'];
    for (var i = 0; i < ladder.length; i++) {
      if (existing.indexOf(ladder[i].toLowerCase()) === -1) return ladder[i];
    }
    return 'Alternate ' + (est.alternates.length + 1);
  }

  function renameActiveAlternate() {
    var est = getEstimate();
    var a = getActiveAlternate();
    if (!est || !a) return;
    var name = prompt('Rename alternate:', a.name);
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    a.name = name;
    debouncedSave();
    renderAlternateTabs();
  }

  function duplicateActiveAlternate() {
    var est = getEstimate();
    var a = getActiveAlternate();
    if (!est || !a) return;
    var name = prompt('Name for the duplicated alternate:', suggestNextAlternateName(est));
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    var newAlt = { id: 'alt_' + Date.now(), name: name, isDefault: false };
    est.alternates.push(newAlt);
    // Clone every line in the active alternate over to the new one. Section
    // headers are cloned too so the structure carries over intact.
    var sourceLines = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.alternateId === a.id;
    });
    sourceLines.forEach(function(l, idx) {
      var copy = Object.assign({}, l);
      copy.id = (l.section === '__section_header__' ? 's' : 'l') + Date.now() + '_' + idx;
      copy.alternateId = newAlt.id;
      appData.estimateLines.push(copy);
    });
    est.activeAlternateId = newAlt.id;
    debouncedSave();
    renderAlternateTabs();
    renderLineItems();
    renderTotals();
  }

  function deleteActiveAlternate() {
    var est = getEstimate();
    var a = getActiveAlternate();
    if (!est || !a) return;
    if ((est.alternates || []).length <= 1) {
      alert('Cannot delete the last alternate — at least one is required.');
      return;
    }
    var lineCount = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.alternateId === a.id;
    }).length;
    var msg = 'Delete alternate "' + a.name + '"?';
    if (lineCount) msg += '\n\nThis will also remove ' + lineCount + ' line item' + (lineCount === 1 ? '' : 's') + ' / section header' + (lineCount === 1 ? '' : 's') + '.';
    if (!confirm(msg)) return;
    // Remove the alternate's lines first, then the alternate itself
    appData.estimateLines = (appData.estimateLines || []).filter(function(l) {
      return !(l.estimateId === est.id && l.alternateId === a.id);
    });
    est.alternates = est.alternates.filter(function(x) { return x.id !== a.id; });
    est.activeAlternateId = est.alternates[0].id;
    debouncedSave();
    renderAlternateTabs();
    renderLineItems();
    renderTotals();
  }

  // ──────────────────────────────────────────────────────────────────
  // Live totals strip — recomputes on every line change.
  // ──────────────────────────────────────────────────────────────────

  // Math pipeline (in order):
  //   subtotal           = Σ qty × unitCost
  //   markupAmount       = Σ ext × (line markup % or default)
  //   markedUp           = subtotal + markupAmount
  //   feeFlat            = est.feeFlat
  //   feePct             = markedUp × (est.feePct / 100)
  //   preTax             = markedUp + feeFlat + feePct
  //   taxAmount          = preTax × (est.taxPct / 100)
  //   beforeRound        = preTax + taxAmount
  //   total              = round up beforeRound to nearest est.roundTo
  function computeTotals() {
    var est = getEstimate();
    var lines = getLines().filter(function(l) { return l.section !== '__section_header__'; });
    var defaultMarkup = num(est && est.defaultMarkup);
    var subtotal = 0;
    var markedUp = 0;
    lines.forEach(function(l) {
      var ext = num(l.qty) * num(l.unitCost);
      subtotal += ext;
      var m = (l.markup === '' || l.markup == null) ? defaultMarkup : num(l.markup);
      markedUp += ext * (1 + m / 100);
    });
    var feeFlat = est ? num(est.feeFlat) : 0;
    var feePctAmount = markedUp * (est ? num(est.feePct) : 0) / 100;
    var preTax = markedUp + feeFlat + feePctAmount;
    var taxAmount = preTax * (est ? num(est.taxPct) : 0) / 100;
    var beforeRound = preTax + taxAmount;
    var roundTo = est ? num(est.roundTo) : 0;
    var total = beforeRound;
    var rounded = 0;
    if (roundTo > 0) {
      total = Math.ceil(beforeRound / roundTo) * roundTo;
      rounded = total - beforeRound;
    }
    return {
      subtotal: subtotal,
      markupAmount: markedUp - subtotal,
      markedUp: markedUp,
      feeFlat: feeFlat,
      feePctAmount: feePctAmount,
      preTax: preTax,
      taxAmount: taxAmount,
      beforeRound: beforeRound,
      rounded: rounded,
      total: total,
      lineCount: lines.length
    };
  }

  function renderTotals() {
    var t = computeTotals();
    var totalsEl = document.getElementById('ee-totals');
    if (!totalsEl) return;
    function chip(label, value, color) {
      return '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:6px 12px;min-width:120px;">' +
        '<div style="font-size:9px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">' + label + '</div>' +
        '<div style="font-size:14px;font-weight:700;color:' + color + ';font-family:\'SF Mono\',\'Fira Code\',monospace;">' + value + '</div>' +
      '</div>';
    }
    totalsEl.innerHTML =
      chip('Subtotal', fmtCurrency(t.subtotal), 'var(--text,#fff)') +
      chip('Markup', fmtCurrency(t.markupAmount), '#fbbf24') +
      chip('Tax + Fees', fmtCurrency(t.feeFlat + t.feePctAmount + t.taxAmount), '#60a5fa') +
      chip('Client Total', fmtCurrency(t.total), '#34d399') +
      chip('Lines', t.lineCount, 'var(--text-dim,#888)');
    // Also refresh the detailed breakdown card under the line items.
    renderPricingBreakdown();
  }

  // Detailed breakdown shown under the line items table. Hides components
  // that are zero so a simple estimate (no fees / no tax / no rounding)
  // doesn't render visual clutter.
  function renderPricingBreakdown() {
    var el = document.getElementById('ee-pricing-breakdown');
    if (!el) return;
    var t = computeTotals();
    function row(label, value, opts) {
      opts = opts || {};
      var color = opts.color || 'var(--text,#fff)';
      var weight = opts.bold ? 700 : 500;
      var size = opts.bold ? 14 : 12;
      var divider = opts.divider ? 'border-top:1px solid var(--border,#333);padding-top:8px;margin-top:8px;' : '';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;' + divider + '">' +
        '<span style="font-size:' + (opts.bold ? 12 : 11) + 'px;color:var(--text-dim,#888);' + (opts.bold ? 'text-transform:uppercase;letter-spacing:0.5px;font-weight:700;' : '') + '">' + label + '</span>' +
        '<span style="font-family:\'SF Mono\',monospace;font-size:' + size + 'px;font-weight:' + weight + ';color:' + color + ';">' + fmtCurrency(value) + '</span>' +
      '</div>';
    }
    var html = '';
    html += row('Subtotal (cost)', t.subtotal);
    html += row('Markup', t.markupAmount, { color: '#fbbf24' });
    html += row('Marked-Up Subtotal', t.markedUp, { divider: true });
    if (t.feeFlat) html += row('+ Flat Fee', t.feeFlat, { color: '#60a5fa' });
    if (t.feePctAmount) html += row('+ Percentage Fee', t.feePctAmount, { color: '#60a5fa' });
    if (t.feeFlat || t.feePctAmount) html += row('Pre-Tax Total', t.preTax, { divider: true });
    if (t.taxAmount) html += row('+ Tax', t.taxAmount, { color: '#60a5fa' });
    if (t.rounded) html += row('+ Round Up', t.rounded, { color: 'var(--text-dim,#888)' });
    html += row('Client Total', t.total, { bold: true, color: '#34d399', divider: true });
    el.innerHTML = html;
  }

  // ──────────────────────────────────────────────────────────────────
  // Line items — sections + rows. A section header lives as a special
  // row in appData.estimateLines with section === '__section_header__'
  // (legacy convention from the existing modal). Order in the array IS
  // the display order; drag-reorder lands in Phase B.
  // ──────────────────────────────────────────────────────────────────

  function renderLineItems() {
    var container = document.getElementById('ee-lines-container');
    if (!container) return;
    var est = getEstimate();
    var lines = getLines();
    if (!lines.length) {
      container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#888);border:1px dashed var(--border,#333);border-radius:8px;">' +
        'No line items yet. Click <strong>+ Line Item</strong> or <strong>+ Section</strong> to start.' +
      '</div>';
      return;
    }

    var defaultMarkup = num(est.defaultMarkup);
    var html = '<div class="ee-line-table" style="border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;">';
    html += renderLineHeaderRow();

    // Group rendering: walk lines in order, render section headers + lines
    // + per-section subtotals.
    var currentSection = null;
    var sectionStartIdx = null;
    function flushSectionSubtotal(endIdx) {
      if (currentSection == null) return;
      // Sum from sectionStartIdx (inclusive of the header row index in ALL
      // lines) up through endIdx
      var sum = 0;
      var marked = 0;
      for (var i = sectionStartIdx + 1; i < endIdx; i++) {
        var L = lines[i];
        if (!L || L.section === '__section_header__') continue;
        var ext = num(L.qty) * num(L.unitCost);
        sum += ext;
        var m = (L.markup === '' || L.markup == null) ? defaultMarkup : num(L.markup);
        marked += ext * (1 + m / 100);
      }
      html += renderSectionSubtotal(sum, marked);
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.section === '__section_header__') {
        if (currentSection != null) flushSectionSubtotal(i);
        html += renderSectionHeaderRow(line);
        currentSection = line.description || 'Section';
        sectionStartIdx = i;
      } else {
        html += renderLineItemRow(line, defaultMarkup);
      }
    }
    if (currentSection != null) flushSectionSubtotal(lines.length);

    html += '</div>';
    container.innerHTML = html;
  }

  function renderLineHeaderRow() {
    var th = function(label, w, align) {
      return '<div style="flex:' + (w || '1 1 auto') + ';padding:8px 10px;font-size:10px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;text-align:' + (align || 'left') + ';">' + label + '</div>';
    };
    return '<div style="display:flex;background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border,#333);">' +
      th('', '0 0 28px') + // drag handle column
      th('Description', '2 1 200px') +
      th('Qty', '0 0 70px', 'right') +
      th('Unit', '0 0 70px') +
      th('Unit Cost', '0 0 110px', 'right') +
      th('Markup %', '0 0 90px', 'right') +
      th('Extended', '0 0 110px', 'right') +
      th('Client Price', '0 0 120px', 'right') +
      th('', '0 0 36px') +
    '</div>';
  }

  // Drag handle markup shared by section headers + line rows. The HTML5
  // drag-and-drop dance: dragstart records the dragged id, dragover preserves
  // the drop target highlight, drop reorders the array.
  function dragHandleHTML(id) {
    return '<div ' +
      'draggable="true" ' +
      'ondragstart="onLineDragStart(event, \'' + escapeHTML(id) + '\')" ' +
      'ondragend="onLineDragEnd(event)" ' +
      'style="flex:0 0 28px;text-align:center;cursor:grab;color:var(--text-dim,#888);font-size:14px;user-select:none;padding:6px 0;line-height:1;" ' +
      'title="Drag to reorder">&#x2630;</div>';
  }

  function renderSectionHeaderRow(line) {
    var idAttr = escapeHTML(line.id);
    return '<div data-section-id="' + idAttr + '" data-line-id="' + idAttr + '" ' +
        'ondragover="onLineDragOver(event)" ondragleave="onLineDragLeave(event)" ' +
        'ondrop="onLineDrop(event, \'' + idAttr + '\')" ' +
        'style="display:flex;align-items:center;background:rgba(79,140,255,0.06);border-bottom:1px solid var(--border,#333);padding:6px 10px;gap:8px;">' +
      dragHandleHTML(line.id) +
      '<input type="text" value="' + escapeHTML(line.description || '') + '" placeholder="Section name" ' +
        'oninput="updateSectionName(\'' + idAttr + '\', this.value)" ' +
        'style="flex:1;font-size:13px;font-weight:700;background:transparent;border:1px solid transparent;border-radius:4px;padding:4px 8px;color:#4f8cff;text-transform:uppercase;letter-spacing:0.5px;" ' +
        'onfocus="this.style.borderColor=\'var(--border,#333)\';" onblur="this.style.borderColor=\'transparent\';" />' +
      '<button class="small primary" onclick="addEstimateLineFromEditor(\'' + idAttr + '\')" title="Add a line under this section" style="padding:4px 10px;font-size:11px;">&#x2795; Line Item</button>' +
      '<button class="small ghost" onclick="deleteSectionFromEditor(\'' + idAttr + '\')" title="Remove section header (lines stay)">&#x1F5D1;</button>' +
    '</div>';
  }

  function renderLineItemRow(line, defaultMarkup) {
    var ext = num(line.qty) * num(line.unitCost);
    var lineMarkup = (line.markup === '' || line.markup == null) ? defaultMarkup : num(line.markup);
    var clientPrice = ext * (1 + lineMarkup / 100);
    var markupPlaceholder = (line.markup === '' || line.markup == null) ? defaultMarkup + ' (default)' : '';
    var idAttr = escapeHTML(line.id);

    var input = function(field, value, opts) {
      opts = opts || {};
      return '<div style="flex:' + (opts.flex || '1') + ';padding:4px 6px;">' +
        '<input ' + (opts.type ? 'type="' + opts.type + '"' : 'type="text"') +
          ' value="' + escapeHTML(value == null ? '' : String(value)) + '"' +
          (opts.placeholder ? ' placeholder="' + escapeHTML(opts.placeholder) + '"' : '') +
          ' onchange="updateLineField(\'' + idAttr + '\', \'' + field + '\', this.value)"' +
          ' style="width:100%;padding:6px 8px;font-size:12px;background:transparent;border:1px solid var(--border,#333);border-radius:4px;color:var(--text,#fff);' +
          (opts.align ? 'text-align:' + opts.align + ';' : '') +
          (opts.mono ? 'font-family:\'SF Mono\',monospace;' : '') +
          '" />' +
        '</div>';
    };
    var readOnly = function(value, flex, color) {
      return '<div style="flex:' + flex + ';padding:8px 10px;font-size:12px;text-align:right;color:' + (color || 'var(--text-dim,#888)') + ';font-family:\'SF Mono\',monospace;">' + value + '</div>';
    };

    return '<div data-line-id="' + idAttr + '" ' +
        'ondragover="onLineDragOver(event)" ondragleave="onLineDragLeave(event)" ' +
        'ondrop="onLineDrop(event, \'' + idAttr + '\')" ' +
        'style="display:flex;align-items:center;border-bottom:1px solid var(--border,#333);">' +
      dragHandleHTML(line.id) +
      input('description', line.description, { flex: '2 1 200px' }) +
      input('qty', line.qty, { flex: '0 0 70px', type: 'number', align: 'right', mono: true }) +
      input('unit', line.unit, { flex: '0 0 70px' }) +
      input('unitCost', line.unitCost, { flex: '0 0 110px', type: 'number', align: 'right', mono: true }) +
      input('markup', line.markup, { flex: '0 0 90px', type: 'number', align: 'right', mono: true, placeholder: markupPlaceholder }) +
      readOnly(fmtCurrency(ext), '0 0 110px') +
      readOnly(fmtCurrency(clientPrice), '0 0 120px', '#34d399') +
      '<div style="flex:0 0 36px;text-align:center;">' +
        '<button class="small ghost" onclick="deleteLineFromEditor(\'' + idAttr + '\')" title="Delete line" style="padding:4px 8px;">&#x1F5D1;</button>' +
      '</div>' +
    '</div>';
  }

  function renderSectionSubtotal(rawSum, markedUp) {
    return '<div style="display:flex;align-items:center;background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border,#333);padding:6px 10px;">' +
      '<div style="flex:0 0 28px;"></div>' + // matches the drag-handle column
      '<div style="flex:2 1 200px;font-size:11px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;font-weight:600;padding-left:8px;">Section Subtotal</div>' +
      '<div style="flex:0 0 70px;"></div>' +
      '<div style="flex:0 0 70px;"></div>' +
      '<div style="flex:0 0 110px;"></div>' +
      '<div style="flex:0 0 90px;"></div>' +
      '<div style="flex:0 0 110px;text-align:right;font-family:\'SF Mono\',monospace;font-size:12px;color:var(--text,#fff);padding:0 10px;">' + fmtCurrency(rawSum) + '</div>' +
      '<div style="flex:0 0 120px;text-align:right;font-family:\'SF Mono\',monospace;font-size:12px;color:#34d399;font-weight:700;padding:0 10px;">' + fmtCurrency(markedUp) + '</div>' +
      '<div style="flex:0 0 36px;"></div>' +
    '</div>';
  }

  // Inline-edit handlers wired via onchange. Each writes back to the
  // estimateLines record, recomputes totals + re-renders so the section
  // subtotals + the totals strip update.
  function updateLineField(lineId, field, value) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    if (!line) return;
    if (field === 'qty' || field === 'unitCost') line[field] = num(value);
    else if (field === 'markup') line.markup = (value === '' || value == null) ? '' : num(value);
    else line[field] = value;
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  function updateSectionName(lineId, value) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    if (!line) return;
    line.description = value;
    debouncedSave();
    // Don't re-render the whole thing on every keystroke — the input keeps
    // its value as-typed; subtotals don't depend on the section name.
  }

  // Optional sectionId — when provided, the new line is inserted just
  // before the next section header (i.e. at the end of that section's
  // group), so the standard-sections layout stays intact. Without it,
  // the line is appended to the end as before.
  function addEstimateLineFromEditor(sectionId) {
    var est = getEstimate();
    if (!est) return;
    var newLine = {
      id: 'l' + Date.now(),
      estimateId: est.id,
      alternateId: est.activeAlternateId,
      description: '',
      qty: 1,
      unit: '',
      unitCost: 0,
      markup: ''
    };
    if (sectionId) {
      var arr = appData.estimateLines;
      var startIdx = arr.findIndex(function(l) { return l.id === sectionId; });
      if (startIdx >= 0) {
        // Walk forward from the section header until we hit the next
        // header in the same alternate, or run out of lines.
        var insertAt = arr.length;
        for (var j = startIdx + 1; j < arr.length; j++) {
          var L = arr[j];
          if (L.estimateId !== est.id || L.alternateId !== est.activeAlternateId) continue;
          if (L.section === '__section_header__') { insertAt = j; break; }
        }
        // If we never found a next header, find the index after the last
        // line in this alternate so we don't sneak into another alternate.
        if (insertAt === arr.length) {
          for (var k = arr.length - 1; k > startIdx; k--) {
            var M = arr[k];
            if (M.estimateId === est.id && M.alternateId === est.activeAlternateId) {
              insertAt = k + 1; break;
            }
          }
        }
        arr.splice(insertAt, 0, newLine);
        debouncedSave();
        renderLineItems();
        renderTotals();
        return;
      }
    }
    appData.estimateLines.push(newLine);
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  function addEstimateSectionFromEditor() {
    var est = getEstimate();
    if (!est) return;
    var name = prompt('Section name:', '');
    if (name == null) return;
    var newHeader = {
      id: 's' + Date.now(),
      estimateId: est.id,
      alternateId: est.activeAlternateId,
      section: '__section_header__',
      description: name || 'Untitled Section'
    };
    appData.estimateLines.push(newHeader);
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  function deleteLineFromEditor(lineId) {
    if (!confirm('Delete this line?')) return;
    appData.estimateLines = (appData.estimateLines || []).filter(function(l) { return l.id !== lineId; });
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  function deleteSectionFromEditor(sectionId) {
    if (!confirm('Remove this section header? The line items below it stay.')) return;
    appData.estimateLines = (appData.estimateLines || []).filter(function(l) { return l.id !== sectionId; });
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  // Standard cost-side sections used by the Buildertrend export pipeline.
  // Phase C will widen btCategory into a (parentGroup, subgroup) tuple for
  // BT's two-sheet import — keeping the simple keys here for now keeps
  // existing data forward-compatible.
  var STANDARD_SECTIONS_PRESET = [
    { name: 'Materials & Supplies Costs', btCategory: 'materials' },
    { name: 'Direct Labor',               btCategory: 'labor' },
    { name: 'General Conditions',         btCategory: 'gc' },
    { name: 'Subcontractors Costs',       btCategory: 'sub' }
  ];

  function addStandardSectionsFromEditor() {
    var est = getEstimate();
    if (!est) return;
    var altId = est.activeAlternateId;
    var existing = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.alternateId === altId && l.section === '__section_header__';
    });
    var existingCats = {};
    existing.forEach(function(s) { if (s.btCategory) existingCats[s.btCategory] = true; });
    var added = 0;
    STANDARD_SECTIONS_PRESET.forEach(function(s, idx) {
      if (existingCats[s.btCategory]) return; // already present in this alternate
      appData.estimateLines.push({
        id: 's' + Date.now() + '_' + idx,
        estimateId: est.id,
        alternateId: altId,
        section: '__section_header__',
        description: s.name,
        btCategory: s.btCategory
      });
      added++;
    });
    if (!added) {
      alert('All four standard sections are already present in this alternate.');
      return;
    }
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  // ──────────────────────────────────────────────────────────────────
  // Drag-reorder — native HTML5 D&D. Each line / section row is a drop
  // target; the dragged item's id is stashed on dragstart and the row
  // gets a faint highlight on dragover. Drop reorders the
  // appData.estimateLines array in-place.
  // ──────────────────────────────────────────────────────────────────

  var _draggedLineId = null;

  function onLineDragStart(e, id) {
    _draggedLineId = id;
    try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
    try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
    // Fade the source row a touch so the user can see what they're moving
    var row = e.target.closest('[data-line-id]');
    if (row) row.style.opacity = '0.45';
  }

  function onLineDragOver(e) {
    if (!_draggedLineId) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    var row = e.currentTarget;
    if (row && row.style) row.style.background = 'rgba(79,140,255,0.10)';
  }

  function onLineDragLeave(e) {
    var row = e.currentTarget;
    if (!row || !row.style) return;
    // Restore the original background. Section headers + subtotals have
    // their own background; resetting to '' lets the inline style win
    // back from the row's original :style attribute when re-rendered.
    row.style.background = '';
  }

  function onLineDragEnd(e) {
    // Source row opacity restore — we re-render after a successful drop,
    // but if the drop didn't land on a target (cancelled drag) we need to
    // restore the visual state.
    var row = e.target.closest('[data-line-id]');
    if (row) row.style.opacity = '';
    _draggedLineId = null;
    // Clear any stuck drop-target highlight
    document.querySelectorAll('[data-line-id]').forEach(function(el) { el.style.background = ''; });
  }

  function onLineDrop(e, targetId) {
    e.preventDefault();
    if (!_draggedLineId || _draggedLineId === targetId) {
      _draggedLineId = null;
      renderLineItems();
      return;
    }
    var lines = appData.estimateLines;
    var fromIdx = lines.findIndex(function(l) { return l.id === _draggedLineId; });
    var toIdx = lines.findIndex(function(l) { return l.id === targetId; });
    if (fromIdx < 0 || toIdx < 0) {
      _draggedLineId = null;
      renderLineItems();
      return;
    }
    var moved = lines.splice(fromIdx, 1)[0];
    // If we removed an earlier item, the target index shifts left by 1
    if (fromIdx < toIdx) toIdx--;
    lines.splice(toIdx, 0, moved);
    _draggedLineId = null;
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  // ──────────────────────────────────────────────────────────────────
  // Details tab — header info, addresses, manager, scope, default markup.
  // Mirrors the old modal's fields, just laid out for the page width.
  // ──────────────────────────────────────────────────────────────────

  function renderDetailsForm() {
    var est = getEstimate();
    var formEl = document.getElementById('ee-details-form');
    if (!formEl || !est) return;

    function field(label, id, value, opts) {
      opts = opts || {};
      var input = '';
      if (opts.textarea) {
        input = '<textarea id="' + id + '" rows="' + (opts.rows || 4) + '" style="width:100%;padding:8px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);resize:vertical;">' + escapeHTML(value || '') + '</textarea>';
      } else {
        input = '<input id="' + id + '" type="' + (opts.type || 'text') + '" value="' + escapeHTML(value == null ? '' : String(value)) + '"' +
                (opts.step ? ' step="' + opts.step + '"' : '') +
                (opts.placeholder ? ' placeholder="' + escapeHTML(opts.placeholder) + '"' : '') +
                ' style="width:100%;" />';
      }
      return '<div style="margin-bottom:12px;"><label style="display:block;">' + label + '</label>' + input + '</div>';
    }

    formEl.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:900px;">' +
        '<div>' +
          '<div style="margin-bottom:12px;">' +
            '<label style="display:block;">Pick from Client Directory</label>' +
            '<select id="ee-clientPicker" onchange="onEstimateClientPicked(\'edit\')" style="width:100%;"></select>' +
          '</div>' +
          '<input type="hidden" id="editEst_clientId" value="' + escapeHTML(est.client_id || '') + '" />' +
          '<input type="hidden" id="editEst_leadId" value="' + escapeHTML(est.lead_id || '') + '" />' +
          field('Nickname (internal)', 'ee-nickName', est.nickName, { placeholder: 'Short label for internal lists' }) +
          field('Job Type', 'ee-jobType', est.jobType) +
          field('Client Company Name', 'ee-client', est.client) +
          field('Community / Property Name', 'ee-community', est.community) +
          field('Property Address', 'ee-propertyAddr', est.propertyAddr) +
          field('Client Billing Address', 'ee-billingAddr', est.billingAddr) +
        '</div>' +
        '<div>' +
          field('Proposal Salutation (Dear ___,)', 'ee-salutation', est.salutation, { placeholder: 'Auto-filled from client; e.g. PAC Team' }) +
          field('Issue / Repair (proposal headline)', 'ee-issue', est.issue, { placeholder: 'e.g. Metal Stair Repairs' }) +
          field('Manager Name', 'ee-managerName', est.managerName) +
          field('Manager Email', 'ee-managerEmail', est.managerEmail, { type: 'email' }) +
          field('Manager Phone', 'ee-managerPhone', est.managerPhone, { type: 'tel' }) +
          field('Scope of Work', 'ee-scopeOfWork', est.scopeOfWork, { textarea: true, rows: 6 }) +
        '</div>' +
      '</div>' +
      // Pricing fieldset — default markup + tax + fees + round-up.
      // Lives below the two-column block so it stretches full width.
      '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-top:18px;max-width:900px;">' +
        '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Pricing</legend>' +
        '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;">' +
          field('Default Markup %', 'ee-defaultMarkup', est.defaultMarkup, { type: 'number', step: '0.1', placeholder: '0' }) +
          field('Tax %', 'ee-taxPct', est.taxPct, { type: 'number', step: '0.01', placeholder: '0' }) +
          field('Flat Fee ($)', 'ee-feeFlat', est.feeFlat, { type: 'number', step: '0.01', placeholder: '0' }) +
          field('Fee % of Marked-Up', 'ee-feePct', est.feePct, { type: 'number', step: '0.1', placeholder: '0' }) +
          field('Round Up to Nearest ($)', 'ee-roundTo', est.roundTo, { type: 'number', step: '1', placeholder: '0 = off' }) +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:8px;">' +
          'Tax applies after fees. Round-up is the last step — set to 0 to disable.' +
        '</div>' +
      '</fieldset>';

    // Wire each field's onchange to live-update the estimate record.
    var fieldMap = {
      'ee-nickName': 'nickName',
      'ee-jobType': 'jobType',
      'ee-client': 'client',
      'ee-community': 'community',
      'ee-propertyAddr': 'propertyAddr',
      'ee-billingAddr': 'billingAddr',
      'ee-salutation': 'salutation',
      'ee-issue': 'issue',
      'ee-managerName': 'managerName',
      'ee-managerEmail': 'managerEmail',
      'ee-managerPhone': 'managerPhone',
      'ee-scopeOfWork': 'scopeOfWork'
    };
    Object.keys(fieldMap).forEach(function(elId) {
      var el = document.getElementById(elId);
      if (!el) return;
      el.onchange = function() {
        var e = getEstimate(); if (!e) return;
        e[fieldMap[elId]] = el.value;
        debouncedSave();
      };
    });
    // Pricing-affecting fields: changing any of these means the line table
    // (default-markup placeholder + computed columns) and the totals strip
    // both need to update.
    var pricingMap = {
      'ee-defaultMarkup': 'defaultMarkup',
      'ee-taxPct':        'taxPct',
      'ee-feeFlat':       'feeFlat',
      'ee-feePct':        'feePct',
      'ee-roundTo':       'roundTo'
    };
    Object.keys(pricingMap).forEach(function(elId) {
      var el = document.getElementById(elId);
      if (!el) return;
      el.onchange = function() {
        var e = getEstimate(); if (!e) return;
        e[pricingMap[elId]] = num(el.value);
        debouncedSave();
        renderLineItems();
        renderTotals();
      };
    });
    // Hidden client_id field — the picker writes into it. Mirror to the
    // estimate record on every change.
    var clientIdEl = document.getElementById('editEst_clientId');
    if (clientIdEl) {
      clientIdEl.addEventListener('change', function() {
        var e = getEstimate(); if (!e) return;
        e.client_id = clientIdEl.value || null;
        debouncedSave();
        renderHeaderChips();
      });
    }
    // Populate the client picker now that the hidden field is rendered
    if (typeof populateEstimateClientPicker === 'function') {
      populateEstimateClientPicker('ee-clientPicker', est.client_id || '');
    }
  }

  // Re-rendering helpers exposed so the client picker's auto-fill writes
  // through cleanly. populateEstimateClientPicker / onEstimateClientPicked
  // (in clients.js) target field ids prefixed with 'editEst_' / 'est' —
  // we need a hook here so the new editor field ids stay in sync.
  // Override onEstimateClientPicked when our form is open.
  var _origOnPicked = window.onEstimateClientPicked;
  window.onEstimateClientPicked = function(mode) {
    // If we're in the new editor, route through the editor's mapping.
    if (_currentId && document.getElementById('ee-clientPicker')) {
      var sel = document.getElementById('ee-clientPicker');
      var hidden = document.getElementById('editEst_clientId');
      if (hidden) hidden.value = sel.value || '';
      if (!sel.value) { renderHeaderChips(); return; }
      var clients = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
      var c = clients.find(function(x) { return x.id === sel.value; });
      if (!c) return;
      var setIf = function(elId, v) {
        var el = document.getElementById(elId);
        if (el && v != null && v !== '') {
          el.value = v;
          el.dispatchEvent(new Event('change'));
        }
      };
      setIf('ee-client', c.company_name || c.name || '');
      setIf('ee-community', c.community_name || c.name || '');
      var pAddr = [c.property_address || c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
      var bAddr = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
      setIf('ee-propertyAddr', pAddr);
      setIf('ee-billingAddr', bAddr);
      setIf('ee-managerName', c.community_manager || '');
      setIf('ee-managerEmail', c.cm_email || c.email || '');
      setIf('ee-managerPhone', c.cm_phone || c.phone || c.cell || '');
      // Snapshot the client's salutation onto the estimate so editing the
      // client later doesn't rewrite a sent proposal. Falls through to
      // first/last name -> contact name -> client name if salutation is blank.
      var salutationGuess = c.salutation
        || ((c.first_name || c.last_name) ? [c.first_name, c.last_name].filter(Boolean).join(' ') : '')
        || c.community_manager
        || c.name || '';
      setIf('ee-salutation', salutationGuess);
      // Update estimate.client_id directly + chips
      var e = getEstimate();
      if (e) { e.client_id = sel.value; debouncedSave(); }
      renderHeaderChips();
      return;
    }
    if (typeof _origOnPicked === 'function') return _origOnPicked(mode);
  };

  // ──────────────────────────────────────────────────────────────────
  // Replace the legacy editEstimate(id) entry point so clicking Edit on
  // the list opens the new full-page editor instead of the modal.
  // The modal markup stays in HTML for reference but is no longer opened.
  // ──────────────────────────────────────────────────────────────────

  var _origEditEstimate = window.editEstimate;
  window.editEstimate = function(estId) {
    openEstimateEditor(estId);
  };
  void _origEditEstimate; // kept for future fallback if we need it

  window.openEstimateEditor = openEstimateEditor;
  window.closeEstimateEditor = closeEstimateEditor;
  window.switchEstimateEditorTab = switchEstimateEditorTab;
  window.updateLineField = updateLineField;
  window.updateSectionName = updateSectionName;
  window.addEstimateLineFromEditor = addEstimateLineFromEditor;
  window.addEstimateSectionFromEditor = addEstimateSectionFromEditor;
  window.deleteLineFromEditor = deleteLineFromEditor;
  window.deleteSectionFromEditor = deleteSectionFromEditor;
  window.jumpToLeadFromEstimate = jumpToLeadFromEstimate;
  window.onLineDragStart = onLineDragStart;
  window.onLineDragOver = onLineDragOver;
  window.onLineDragLeave = onLineDragLeave;
  window.onLineDragEnd = onLineDragEnd;
  window.onLineDrop = onLineDrop;
  window.switchAlternate = switchAlternate;
  window.addAlternateFromEditor = addAlternateFromEditor;
  window.renameActiveAlternate = renameActiveAlternate;
  window.duplicateActiveAlternate = duplicateActiveAlternate;
  window.deleteActiveAlternate = deleteActiveAlternate;
})();
