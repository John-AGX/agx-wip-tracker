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
  // Save status tracker — drives the indicator + Save button in the
  // sticky header. 'idle' = nothing pending, 'pending' = local debounce
  // running, 'saving' = saveData has fired and the server push is in
  // flight, 'saved' = recently saved (hold for 2s), 'error' = failed.
  var _saveState = 'idle';

  function setSaveState(state) {
    _saveState = state;
    renderSaveIndicator();
  }

  function debouncedSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    setSaveState('pending');
    _saveTimer = setTimeout(function() {
      _saveTimer = null;
      runSaveNow();
    }, 400);
  }

  // Force an immediate save — used by closeEstimateEditor and the manual
  // Save button. Skips the debounce timer and surfaces the result on the
  // status indicator.
  function runSaveNow() {
    if (typeof saveData !== 'function') { setSaveState('error'); return; }
    setSaveState('saving');
    try {
      saveData();
      // saveData() is fire-and-forget locally; localStorage is synchronous.
      // Server push is queued ~600ms later. Show "saved" optimistically and
      // fade after 2s — if the server push fails, the next user action
      // will retry.
      setTimeout(function() {
        if (_saveState === 'saving') setSaveState('saved');
        setTimeout(function() {
          if (_saveState === 'saved') setSaveState('idle');
        }, 2000);
      }, 700);
    } catch (e) {
      console.warn('Manual save failed:', e);
      setSaveState('error');
    }
  }

  function renderSaveIndicator() {
    var el = document.getElementById('ee-save-indicator');
    if (!el) return;
    var dot, label, color;
    switch (_saveState) {
      case 'pending': dot = '●'; label = 'Unsaved'; color = '#fbbf24'; break;
      case 'saving':  dot = '●'; label = 'Saving…'; color = '#60a5fa'; break;
      case 'saved':   dot = '✓'; label = 'Saved'; color = '#34d399'; break;
      case 'error':   dot = '!'; label = 'Save failed'; color = '#f87171'; break;
      default:        dot = '○'; label = 'No changes'; color = 'var(--text-dim,#888)'; break;
    }
    el.style.color = color;
    el.innerHTML = '<span style="font-weight:700;margin-right:5px;">' + dot + '</span>' + label;
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
  // records (no alternates array, lines without alternateId, alternates
  // missing the `scope` field) get a clean default and behave the same as
  // fresh ones. Saves silently after backfill so the cleaned state
  // persists.
  function ensureAlternates(est) {
    if (!est) return;
    var changed = false;
    if (!est.alternates || !est.alternates.length) {
      est.alternates = [{ id: 'alt_default', name: 'Base', isDefault: true, scope: '' }];
      changed = true;
    }
    if (!est.activeAlternateId || !est.alternates.find(function(a) { return a.id === est.activeAlternateId; })) {
      est.activeAlternateId = est.alternates[0].id;
      changed = true;
    }
    // Backfill `scope` so the right-panel textarea has a target on every
    // alternate. The first alternate inherits the legacy estimate-level
    // scopeOfWork on first open so existing data isn't lost.
    var firstAlt = est.alternates[0];
    if (firstAlt && firstAlt.scope == null) {
      firstAlt.scope = est.scopeOfWork || '';
      changed = true;
    }
    est.alternates.forEach(function(a) {
      if (a.scope == null) { a.scope = ''; changed = true; }
    });
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
    renderScopePanel();
    switchEstimateEditorTab('lines');
    // Reset save state to idle on every fresh editor open so we don't
    // carry "saved" / "error" indicators from a previous session.
    setSaveState('idle');
  }

  // Right-panel scope textarea — bound to the ACTIVE alternate's scope so
  // Good / Better / Best can each carry their own narrative. Falls back to
  // the legacy estimate.scopeOfWork only on first migration (handled in
  // ensureAlternates). Changes write straight through to the alternate.
  function renderScopePanel() {
    var pane = document.getElementById('ee-scope-panel');
    if (!pane) return;
    var est = getEstimate();
    var alt = getActiveAlternate();
    if (!est || !alt) { pane.innerHTML = ''; return; }
    pane.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:8px;">' +
        '<div style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Scope of Work</div>' +
        '<div style="font-size:11px;color:#4f8cff;font-weight:600;">' + escapeHTML(alt.name || 'Alternate') + '</div>' +
      '</div>' +
      '<textarea id="ee-alt-scope" rows="14" placeholder="Bulleted scope, narrative, or whatever the proposal needs. This is per-alternate." ' +
        'style="width:100%;resize:vertical;font-family:inherit;font-size:12px;line-height:1.5;padding:10px 12px;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:8px;color:var(--text,#fff);">' +
        escapeHTML(alt.scope || '') +
      '</textarea>' +
      '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:6px;">Saved per alternate. Used by the Preview tab and PDF/Buildertrend exports.</div>';
    var ta = document.getElementById('ee-alt-scope');
    if (ta) {
      ta.oninput = function() {
        var a = getActiveAlternate();
        if (!a) return;
        a.scope = ta.value;
        debouncedSave();
      };
    }
  }

  function closeEstimateEditor() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (typeof saveData === 'function') saveData();
    _currentId = null;
    _saveState = 'idle';
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
    // Photos tab — mount the shared widget. agxAttachments handles its own
    // state, so re-mounting on each switch is fine and keeps things simple.
    if (name === 'photos' && _currentId && window.agxAttachments) {
      var mountEl = document.getElementById('ee-photos-mount');
      if (mountEl) {
        window.agxAttachments.mount(mountEl, {
          entityType: 'estimate',
          entityId: _currentId,
          canEdit: true
        });
      }
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
        html += '<button class="ee-btn secondary" onclick="jumpToLeadFromEstimate(\'' + escapeHTML(lead.id) + '\')" style="display:inline-flex;align-items:center;gap:6px;">' +
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
    renderScopePanel();
  }

  function addAlternateFromEditor() {
    var est = getEstimate();
    if (!est) return;
    if (!est.alternates) est.alternates = [];
    var name = prompt('Name for the new alternate:', suggestNextAlternateName(est));
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    var newAlt = { id: 'alt_' + Date.now(), name: name, isDefault: false, scope: '' };
    est.alternates.push(newAlt);
    est.activeAlternateId = newAlt.id;
    debouncedSave();
    renderAlternateTabs();
    renderLineItems();
    renderTotals();
    renderScopePanel();
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
    var srcAlt = getActiveAlternate();
    var newAlt = { id: 'alt_' + Date.now(), name: name, isDefault: false, scope: (srcAlt && srcAlt.scope) || '' };
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
    var msg = lineCount
      ? 'This will also remove ' + lineCount + ' line item' + (lineCount === 1 ? '' : 's') + ' / section header' + (lineCount === 1 ? '' : 's') + '. This cannot be undone.'
      : 'This cannot be undone.';
    window.agxConfirm({
      title: 'Delete alternate "' + a.name + '"?',
      message: msg,
      confirmText: 'Delete',
      destructive: true
    }).then(function(ok) {
      if (!ok) return;
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
    });
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
  // Walk back from a given line to find its enclosing section header and
  // return that section's markup. Per-line `markup` overrides the section.
  // For legacy estimates that still carry an estimate-wide `defaultMarkup`,
  // fall through to it so existing data keeps pricing the same until the
  // user assigns explicit section markups.
  function effectiveMarkupForLine(line, allLines, est) {
    if (line && line.markup !== '' && line.markup != null) return num(line.markup);
    return sectionMarkupForLine(line, allLines, est);
  }
  // The section-derived markup for a line, ignoring any per-line override.
  // Used to populate the placeholder on the per-line markup field so the
  // user knows what they'd be overriding if they typed a value.
  function sectionMarkupForLine(line, allLines, est) {
    if (allLines && allLines.length) {
      var idx = allLines.indexOf(line);
      if (idx < 0) idx = allLines.length;
      for (var i = idx - 1; i >= 0; i--) {
        var L = allLines[i];
        if (L && L.section === '__section_header__') {
          if (L.markup !== '' && L.markup != null) return num(L.markup);
          break;
        }
      }
    }
    if (est && est.defaultMarkup != null && est.defaultMarkup !== '') return num(est.defaultMarkup);
    return 0;
  }

  function computeTotals() {
    var est = getEstimate();
    var allLines = getLines();
    var subtotal = 0;
    var markedUp = 0;
    allLines.forEach(function(l) {
      if (l.section === '__section_header__') return;
      var ext = num(l.qty) * num(l.unitCost);
      subtotal += ext;
      var m = effectiveMarkupForLine(l, allLines, est);
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

    var html = '<div class="ee-line-table" style="border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;">';
    html += renderLineHeaderRow();

    // Group rendering: walk lines in order, render section headers + lines
    // + per-section subtotals. Markup is now per-section — every line
    // inherits its section header's markup unless the line overrides.
    var currentSection = null;
    var sectionStartIdx = null;
    function flushSectionSubtotal(endIdx) {
      if (currentSection == null) return;
      var sum = 0;
      var marked = 0;
      for (var i = sectionStartIdx + 1; i < endIdx; i++) {
        var L = lines[i];
        if (!L || L.section === '__section_header__') continue;
        var ext = num(L.qty) * num(L.unitCost);
        sum += ext;
        var m = effectiveMarkupForLine(L, lines, est);
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
        html += renderLineItemRow(line, lines, est);
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
    var markupVal = (line.markup === '' || line.markup == null) ? '' : num(line.markup);
    return '<div data-section-id="' + idAttr + '" data-line-id="' + idAttr + '" ' +
        'ondragover="onLineDragOver(event)" ondragleave="onLineDragLeave(event)" ' +
        'ondrop="onLineDrop(event, \'' + idAttr + '\')" ' +
        'style="display:flex;align-items:center;background:rgba(79,140,255,0.06);border-bottom:1px solid var(--border,#333);padding:6px 10px;gap:8px;">' +
      dragHandleHTML(line.id) +
      '<input type="text" value="' + escapeHTML(line.description || '') + '" placeholder="Section name" ' +
        'oninput="updateSectionName(\'' + idAttr + '\', this.value)" ' +
        'style="flex:1;font-size:13px;font-weight:700;background:transparent;border:1px solid transparent;border-radius:4px;padding:4px 8px;color:#4f8cff;text-transform:uppercase;letter-spacing:0.5px;" ' +
        'onfocus="this.style.borderColor=\'var(--border,#333)\';" onblur="this.style.borderColor=\'transparent\';" />' +
      // Section markup — all lines under this header inherit this %.
      // Slider snaps to common increments; the number input is the source
      // of truth and accepts any value.
      '<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(0,0,0,0.18);padding:3px 8px;border-radius:14px;border:1px solid var(--border,#333);">' +
        '<span style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">Markup</span>' +
        '<input type="range" min="0" max="60" step="1" value="' + (markupVal === '' ? 0 : markupVal) + '" ' +
          'oninput="updateSectionMarkup(\'' + idAttr + '\', this.value, true)" ' +
          'style="width:70px;height:14px;cursor:pointer;accent-color:#4f8cff;" />' +
        '<input type="number" min="0" step="0.5" placeholder="0" value="' + markupVal + '" ' +
          'oninput="updateSectionMarkup(\'' + idAttr + '\', this.value, false)" ' +
          'style="width:50px;padding:2px 4px;font-size:12px;background:transparent;border:1px solid transparent;border-radius:4px;color:var(--text,#fff);text-align:right;font-family:\'SF Mono\',monospace;" ' +
          'onfocus="this.style.borderColor=\'var(--border,#333)\';" onblur="this.style.borderColor=\'transparent\';" />' +
        '<span style="font-size:11px;color:var(--text-dim,#888);">%</span>' +
      '</div>' +
      '<button class="ee-btn primary" onclick="addEstimateLineFromEditor(\'' + idAttr + '\')" title="Add a line under this section">&#x2795; Line Item</button>' +
      '<button class="ee-btn ee-icon-btn ghost" onclick="deleteSectionFromEditor(\'' + idAttr + '\')" title="Remove section header (lines stay)">&#x1F5D1;</button>' +
    '</div>';
  }

  function renderLineItemRow(line, allLines, est) {
    var ext = num(line.qty) * num(line.unitCost);
    var inherited = sectionMarkupForLine(line, allLines, est);
    var lineMarkup = (line.markup === '' || line.markup == null) ? inherited : num(line.markup);
    var clientPrice = ext * (1 + lineMarkup / 100);
    var markupPlaceholder = (line.markup === '' || line.markup == null) ? inherited + ' (section)' : '';
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
        '<button class="ee-btn ee-icon-btn danger" onclick="deleteLineFromEditor(\'' + idAttr + '\')" title="Delete line">&#x1F5D1;</button>' +
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

  // Section markup — applies to every line under the header unless the
  // line carries its own override. `fromSlider` syncs the matching number
  // input in the same row; both inputs feed into the same line.markup.
  function updateSectionMarkup(lineId, value, fromSlider) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    if (!line) return;
    var raw = (value == null) ? '' : String(value).trim();
    line.markup = raw === '' ? '' : Number(raw);
    debouncedSave();
    // Sync the sibling input visually so slider drag matches the number
    // box in real time.
    var row = document.querySelector('[data-section-id="' + lineId + '"]');
    if (row) {
      var sliderEl = row.querySelector('input[type="range"]');
      var numEl = row.querySelector('input[type="number"]');
      if (fromSlider && numEl) numEl.value = raw;
      if (!fromSlider && sliderEl) sliderEl.value = (raw === '' ? 0 : Number(raw));
    }
    // Markup change cascades into every line under this section AND the
    // grand totals strip. Re-render both.
    renderLineItems();
    renderTotals();
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
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    var preview = line && line.description ? line.description : 'this line';
    window.agxConfirm({
      title: 'Delete line item?',
      message: '"' + preview + '" will be removed from the active alternate. This cannot be undone.',
      confirmText: 'Delete',
      destructive: true
    }).then(function(ok) {
      if (!ok) return;
      appData.estimateLines = (appData.estimateLines || []).filter(function(l) { return l.id !== lineId; });
      debouncedSave();
      renderLineItems();
      renderTotals();
    });
  }

  function deleteSectionFromEditor(sectionId) {
    var section = (appData.estimateLines || []).find(function(l) { return l.id === sectionId; });
    var name = section && section.description ? section.description : 'this section';
    window.agxConfirm({
      title: 'Remove section header?',
      message: 'The header "' + name + '" will be removed. The line items underneath it stay where they are.',
      confirmText: 'Remove',
      destructive: true
    }).then(function(ok) {
      if (!ok) return;
      appData.estimateLines = (appData.estimateLines || []).filter(function(l) { return l.id !== sectionId; });
      debouncedSave();
      renderLineItems();
      renderTotals();
    });
  }

  // Standard cost-side sections used by the Buildertrend export pipeline.
  // Phase C will widen btCategory into a (parentGroup, subgroup) tuple for
  // BT's two-sheet import — keeping the simple keys here for now keeps
  // existing data forward-compatible.
  // Default markup per category mirrors AGX's typical pricing: materials
  // and subs run lean, direct labor carries the bulk of the margin, GC is
  // usually a flat percentage. Estimators can dial each section's slider
  // up or down per job in the editor.
  var STANDARD_SECTIONS_PRESET = [
    { name: 'Materials & Supplies Costs', btCategory: 'materials', markup: 20 },
    { name: 'Direct Labor',               btCategory: 'labor',     markup: 35 },
    { name: 'General Conditions',         btCategory: 'gc',        markup: 25 },
    { name: 'Subcontractors Costs',       btCategory: 'sub',       markup: 10 }
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
        btCategory: s.btCategory,
        markup: s.markup
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
      } else if (opts.options && opts.options.length) {
        // Select with a fixed option list. The current value is always
        // included as a fallback option even if it's not in the list, so
        // pre-existing free-text values from before this dropdown
        // landed don't silently get dropped on first save.
        var seen = false;
        var optHtml = '<option value="">— Select —</option>';
        opts.options.forEach(function(o) {
          var v = (typeof o === 'string') ? o : o.value;
          var lbl = (typeof o === 'string') ? o : (o.label || o.value);
          var sel = (value === v) ? ' selected' : '';
          if (sel) seen = true;
          optHtml += '<option value="' + escapeHTML(v) + '"' + sel + '>' + escapeHTML(lbl) + '</option>';
        });
        if (value && !seen) {
          optHtml += '<option value="' + escapeHTML(value) + '" selected>' + escapeHTML(value) + ' (legacy)</option>';
        }
        input = '<select id="' + id + '" style="width:100%;">' + optHtml + '</select>';
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
          field('Job Type', 'ee-jobType', est.jobType, { options: ['Renovation', 'Service & Repair', 'Work Order'] }) +
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
          '<div style="margin-bottom:12px;font-size:11px;color:var(--text-dim,#888);padding:8px 10px;background:rgba(79,140,255,0.06);border:1px solid var(--border,#333);border-radius:6px;line-height:1.5;">' +
            '<strong style="color:#4f8cff;">Scope of Work</strong> moved to the <strong>Line Items</strong> tab so each alternate carries its own. Find it in the right panel under the active alternate.' +
          '</div>' +
        '</div>' +
      '</div>' +
      // Pricing fieldset — tax + fees + round-up. Markup is per-section now;
      // set it on each section header inside the Line Items tab.
      '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-top:18px;max-width:900px;">' +
        '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Pricing</legend>' +
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">' +
          field('Tax %', 'ee-taxPct', est.taxPct, { type: 'number', step: '0.01', placeholder: '0' }) +
          field('Flat Fee ($)', 'ee-feeFlat', est.feeFlat, { type: 'number', step: '0.01', placeholder: '0' }) +
          field('Fee % of Marked-Up', 'ee-feePct', est.feePct, { type: 'number', step: '0.1', placeholder: '0' }) +
          field('Round Up to Nearest ($)', 'ee-roundTo', est.roundTo, { type: 'number', step: '1', placeholder: '0 = off' }) +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:8px;">' +
          'Markup is per-section — set it on each section header in <strong>Line Items</strong>. Tax applies after fees. Round-up is the last step.' +
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
      'ee-managerPhone': 'managerPhone'
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
  window.updateSectionMarkup = updateSectionMarkup;
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
  window.renderScopePanel = renderScopePanel;

  // Tiny shim so the sticky-header "Ask AI" button can find the active
  // estimate id without the AI panel having to read the editor's private
  // state. Just delegates to agxAI.open with the current id.
  // Manual save invoked by the sticky-header Save button + the save
  // indicator (clicking the chip also triggers an immediate save).
  window.saveEstimateNow = function() {
    if (!_currentId) return;
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    runSaveNow();
  };

  window.openEstimateAI = function() {
    if (!_currentId) { alert('Open an estimate first.'); return; }
    if (window.agxAI && typeof window.agxAI.open === 'function') {
      window.agxAI.open(_currentId);
    } else {
      alert('AI panel not loaded yet — refresh the page.');
    }
  };

  // Delete from the editor sticky header. Closes the editor first so the
  // user lands back on the list, then runs the existing global delete
  // (which handles the server-side remove + local state cleanup).
  window.deleteEstimateFromEditor = function() {
    if (!_currentId) return;
    var id = _currentId;
    if (typeof window.deleteEstimate !== 'function') {
      alert('Delete not available — refresh the page.');
      return;
    }
    // The global deleteEstimate prompts via confirm() and only removes
    // on yes. Close the editor view AFTER the user confirms so a cancel
    // leaves them in place.
    var prevConfirm = window.confirm;
    var userSaidYes = false;
    window.confirm = function(msg) {
      var ok = prevConfirm.call(window, msg);
      userSaidYes = userSaidYes || ok;
      return ok;
    };
    try { window.deleteEstimate(id); } finally { window.confirm = prevConfirm; }
    if (userSaidYes) closeEstimateEditor();
  };

  // ──────────────────────────────────────────────────────────────────
  // Public write API for the AI panel. Each function applies a single
  // approved proposal, mutating appData + saving + re-rendering. All
  // operations target the currently-open estimate's active alternate.
  // Returns a short summary string the AI panel can echo back to the
  // server in the tool_result so Claude knows what landed.
  // ──────────────────────────────────────────────────────────────────
  function applyAddLineItem(input) {
    var est = getEstimate();
    if (!est) throw new Error('No estimate open.');
    var alt = getActiveAlternate();
    if (!alt) throw new Error('No active alternate.');

    var sectionId = null;
    if (input.section_name) {
      var needle = String(input.section_name).toLowerCase();
      var match = (appData.estimateLines || []).find(function(l) {
        return l.estimateId === est.id
          && l.alternateId === alt.id
          && l.section === '__section_header__'
          && (l.description || '').toLowerCase().indexOf(needle) >= 0;
      });
      if (match) sectionId = match.id;
    }

    var newLine = {
      id: 'l' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      estimateId: est.id,
      alternateId: alt.id,
      description: input.description || '',
      qty: num(input.qty),
      unit: input.unit || 'ea',
      unitCost: num(input.unit_cost),
      markup: (input.markup_pct == null || input.markup_pct === '') ? '' : num(input.markup_pct)
    };

    if (sectionId) {
      // Same insertion logic as addEstimateLineFromEditor: walk forward to
      // the next section header in the same alternate.
      var arr = appData.estimateLines;
      var startIdx = arr.findIndex(function(l) { return l.id === sectionId; });
      if (startIdx >= 0) {
        var insertAt = arr.length;
        for (var j = startIdx + 1; j < arr.length; j++) {
          var L = arr[j];
          if (L.estimateId !== est.id || L.alternateId !== alt.id) continue;
          if (L.section === '__section_header__') { insertAt = j; break; }
        }
        if (insertAt === arr.length) {
          for (var k = arr.length - 1; k > startIdx; k--) {
            var M = arr[k];
            if (M.estimateId === est.id && M.alternateId === alt.id) {
              insertAt = k + 1; break;
            }
          }
        }
        arr.splice(insertAt, 0, newLine);
      } else {
        arr.push(newLine);
      }
    } else {
      appData.estimateLines.push(newLine);
    }

    debouncedSave();
    renderLineItems();
    renderTotals();
    return 'Added line: "' + newLine.description + '" — qty ' + newLine.qty + ' ' + newLine.unit + ' @ $' + newLine.unitCost.toFixed(2);
  }

  function applyAddSection(input) {
    var est = getEstimate();
    if (!est) throw new Error('No estimate open.');
    var alt = getActiveAlternate();
    if (!alt) throw new Error('No active alternate.');
    var newHeader = {
      id: 's' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      estimateId: est.id,
      alternateId: alt.id,
      section: '__section_header__',
      description: input.name || 'Untitled Section'
    };
    if (input.bt_category) newHeader.btCategory = input.bt_category;
    if (input.markup_pct != null && input.markup_pct !== '') newHeader.markup = Number(input.markup_pct);
    appData.estimateLines.push(newHeader);
    debouncedSave();
    renderLineItems();
    renderTotals();
    return 'Added section: "' + newHeader.description + '"' + (newHeader.markup != null ? ' (markup ' + newHeader.markup + '%)' : '');
  }

  function applyUpdateScope(input) {
    var alt = getActiveAlternate();
    if (!alt) throw new Error('No active alternate.');
    var mode = input.mode === 'append' ? 'append' : 'replace';
    var newScope;
    if (mode === 'append' && alt.scope) {
      newScope = alt.scope.replace(/\s+$/, '') + '\n\n' + (input.scope_text || '');
    } else {
      newScope = input.scope_text || '';
    }
    alt.scope = newScope;
    debouncedSave();
    renderScopePanel();
    return 'Updated scope on alternate "' + alt.name + '" (' + mode + ', ' + newScope.length + ' chars)';
  }

  window.estimateEditorAPI = {
    isOpenFor: function(estimateId) { return _currentId === estimateId; },
    activeAlternateName: function() { var a = getActiveAlternate(); return a ? a.name : null; },
    applyAddLineItem: applyAddLineItem,
    applyAddSection: applyAddSection,
    applyUpdateScope: applyUpdateScope
  };
  window.addAlternateFromEditor = addAlternateFromEditor;
  window.renameActiveAlternate = renameActiveAlternate;
  window.duplicateActiveAlternate = duplicateActiveAlternate;
  window.deleteActiveAlternate = deleteActiveAlternate;
})();
