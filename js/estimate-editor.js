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
  function getLines() {
    if (!_currentId || !window.appData) return [];
    return (appData.estimateLines || []).filter(function(l) { return l.estimateId === _currentId; });
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
  }

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
  // Live totals strip — recomputes on every line change.
  // ──────────────────────────────────────────────────────────────────

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
    return {
      subtotal: subtotal,
      markupAmount: markedUp - subtotal,
      total: markedUp,
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
      chip('Client Total', fmtCurrency(t.total), '#34d399') +
      chip('Lines', t.lineCount, 'var(--text-dim,#888)');
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

  function renderSectionHeaderRow(line) {
    return '<div data-section-id="' + escapeHTML(line.id) + '" style="display:flex;align-items:center;background:rgba(79,140,255,0.06);border-bottom:1px solid var(--border,#333);padding:6px 10px;gap:8px;">' +
      '<input type="text" value="' + escapeHTML(line.description || '') + '" placeholder="Section name" ' +
        'oninput="updateSectionName(\'' + escapeHTML(line.id) + '\', this.value)" ' +
        'style="flex:1;font-size:13px;font-weight:700;background:transparent;border:1px solid transparent;border-radius:4px;padding:4px 8px;color:#4f8cff;text-transform:uppercase;letter-spacing:0.5px;" ' +
        'onfocus="this.style.borderColor=\'var(--border,#333)\';" onblur="this.style.borderColor=\'transparent\';" />' +
      '<button class="small ghost" onclick="deleteSectionFromEditor(\'' + escapeHTML(line.id) + '\')" title="Remove section header (lines stay)">&#x1F5D1;</button>' +
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

    return '<div style="display:flex;align-items:center;border-bottom:1px solid var(--border,#333);">' +
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

  function addEstimateLineFromEditor() {
    var est = getEstimate();
    if (!est) return;
    var newLine = {
      id: 'l' + Date.now(),
      estimateId: est.id,
      description: '',
      qty: 1,
      unit: '',
      unitCost: 0,
      markup: ''
    };
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
          field('Manager Name', 'ee-managerName', est.managerName) +
          field('Manager Email', 'ee-managerEmail', est.managerEmail, { type: 'email' }) +
          field('Manager Phone', 'ee-managerPhone', est.managerPhone, { type: 'tel' }) +
          field('Default Markup %', 'ee-defaultMarkup', est.defaultMarkup, { type: 'number', step: '0.1' }) +
          field('Scope of Work', 'ee-scopeOfWork', est.scopeOfWork, { textarea: true, rows: 6 }) +
        '</div>' +
      '</div>';

    // Wire each field's onchange to live-update the estimate record.
    var fieldMap = {
      'ee-nickName': 'nickName',
      'ee-jobType': 'jobType',
      'ee-client': 'client',
      'ee-community': 'community',
      'ee-propertyAddr': 'propertyAddr',
      'ee-billingAddr': 'billingAddr',
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
    var markupEl = document.getElementById('ee-defaultMarkup');
    if (markupEl) {
      markupEl.onchange = function() {
        var e = getEstimate(); if (!e) return;
        e.defaultMarkup = num(markupEl.value);
        debouncedSave();
        renderLineItems(); // markup change ripples through line client prices
        renderTotals();
      };
    }
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
})();
