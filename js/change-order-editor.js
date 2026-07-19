// Change Order editor — full-screen overlay for building a job-scoped
// Change Order with line items, target-margin math, and an approval
// lifecycle that gates WIP impact.
//
// Public surface:
//   window.p86ChangeOrders.openNew(jobId)  — create a draft + open editor
//   window.p86ChangeOrders.open(coId)      — load existing + open editor
//   window.p86ChangeOrders.close()         — close any open editor
//
// Save flow: debounced PUT /api/change-orders/:id (700ms) — same
// pattern as estimate-editor. The data blob mirrors the CO record's
// data column (title, scope, targetMargin, lines[], etc.) minus the
// canonical columns the server manages (status, co_number, etc.).
//
// All pricing math goes through window.p86Pricing (js/pricing-pipeline.js)
// — same module the estimate editor uses, so the totals chip bar
// here matches the estimate's PROPOSAL TOTAL bar exactly.
(function() {
  'use strict';

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, '&quot;'); }

  function fmtCurrency(n) {
    if (n == null || isNaN(n)) n = 0;
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) {
    if (n == null || isNaN(n)) return '0.0%';
    return Number(n).toFixed(1) + '%';
  }

  // Per-editor state — single CO open at a time. Reset on open() so
  // we never leak data between sessions.
  var _state = {
    co: null,         // server record (canonical columns + data blob spread on top)
    dirty: false,
    saveTimer: null,
    saving: false,
    lastSavedAt: null,
    saveError: null
  };

  // Idempotent random-ish id generator for new lines. Same convention
  // as estimate-editor — short enough to be readable in DevTools, long
  // enough that collision inside one CO is effectively impossible.
  function newLineId() {
    return 'line_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────
  // Default Terms & Conditions seeded on a NEW change order (fully editable
  // in the rich-text field; existing COs are never overwritten).
  var DEFAULT_CO_TERMS =
    '<p>Please review and approve this Change Order to confirm the adjustment to your original Scope of Work.</p>' +
    '<p>By approving, you acknowledge the updated construction schedule and understand that invoicing will occur either upon approval or at completion of the project. Timely payment helps us keep the project moving smoothly and on schedule.</p>';

  function openNew(jobId) {
    if (!jobId) { console.warn('openNew: jobId required'); return; }
    if (!window.p86Api || !window.p86Api.changeOrders) {
      alert('API not available'); return;
    }
    window.p86Api.changeOrders.create(jobId, {
      title: '',
      scope: '',
      terms: DEFAULT_CO_TERMS,
      targetMargin: '',
      defaultMarkup: '',
      feeFlat: 0, feePct: 0,
      taxPct: 0, roundTo: 0,
      lines: []
    }).then(function(r) {
      var co = r && r.change_order;
      if (!co) throw new Error('Create failed (empty response)');
      _state.co = co;
      mount();
    }).catch(function(e) {
      alert('Could not create change order: ' + (e.message || e));
    });
  }
  function openExisting(coId) {
    if (!coId) { console.warn('open: coId required'); return; }
    if (!window.p86Api || !window.p86Api.changeOrders) {
      alert('API not available'); return;
    }
    window.p86Api.changeOrders.get(coId).then(function(r) {
      var co = r && r.change_order;
      if (!co) throw new Error('Not found');
      _state.co = co;
      mount();
    }).catch(function(e) {
      alert('Could not open change order: ' + (e.message || e));
    });
  }
  function close() {
    // Flush any pending save before tearing down so we don't lose the
    // user's last keystroke.
    if (_state.saveTimer) {
      clearTimeout(_state.saveTimer);
      _state.saveTimer = null;
      if (_state.dirty) flushSave();
    }
    var overlay = document.getElementById('co-editor-overlay');
    if (overlay) overlay.remove();
    document.body.style.overflow = '';
    // Release the drawer target + close the drawer so it doesn't linger
    // pointed at a torn-down CO (falls back to the estimate editor).
    if (window.p86ActiveLineTarget === coLineTarget) {
      try { delete window.p86ActiveLineTarget; } catch (e) { window.p86ActiveLineTarget = null; }
      try {
        if (window.MaterialsDrawer && window.MaterialsDrawer.close) window.MaterialsDrawer.close();
        // Clear any CO-staged scope so it can't bleed into the next estimate.
        if (window.MaterialsDrawer && window.MaterialsDrawer.reset) window.MaterialsDrawer.reset();
      } catch (e) {}
    }
    _state.co = null;
    _state.dirty = false;
    _state.saving = false;
    _state.saveError = null;
    // The hub list underneath may show stale title/status — refresh it.
    if (typeof window.p86JobsHubRefresh === 'function') window.p86JobsHubRefresh();
  }

  // ──────────────────────────────────────────────────────────────────
  // Save flow — debounced PUT + save-state indicator
  // ──────────────────────────────────────────────────────────────────
  function markDirty() {
    _state.dirty = true;
    paintSaveStatus();
    if (_state.saveTimer) clearTimeout(_state.saveTimer);
    _state.saveTimer = setTimeout(flushSave, 700);
  }
  function flushSave() {
    if (!_state.co || _state.saving) return;
    var co = _state.co;
    // Build the data payload from the in-memory record, stripping the
    // canonical column fields. Server also strips defensively but we
    // keep the wire clean.
    var data = {
      title: co.title || '',
      scope: co.scope || '',
      terms: co.terms || '',
      targetMargin: co.targetMargin || '',
      defaultMarkup: co.defaultMarkup || '',
      feeFlat: co.feeFlat || 0,
      feePct: co.feePct || 0,
      taxPct: co.taxPct || 0,
      roundTo: co.roundTo || 0,
      lines: Array.isArray(co.lines) ? co.lines : []
    };
    _state.saving = true;
    _state.saveError = null;
    paintSaveStatus();
    window.p86Api.changeOrders.update(co.id, data)
      .then(function(r) {
        var fresh = r && r.change_order;
        if (fresh) {
          // Keep server-canonical fields fresh (updated_at, etc.) but
          // don't clobber in-progress local edits to data fields.
          _state.co.updated_at = fresh.updated_at;
          _state.co.status = fresh.status;
        }
        _state.dirty = false;
        _state.saving = false;
        _state.lastSavedAt = new Date();
        paintSaveStatus();
      })
      .catch(function(e) {
        _state.saving = false;
        _state.saveError = e && e.message ? e.message : 'Save failed';
        paintSaveStatus();
      });
  }

  // ──────────────────────────────────────────────────────────────────
  // Pricing / totals
  // ──────────────────────────────────────────────────────────────────
  function computeTotals() {
    var co = _state.co;
    if (!co || !window.p86Pricing) return null;
    var lines = Array.isArray(co.lines) ? co.lines : [];
    var per = window.p86Pricing.computeForLines(co, lines);
    var subtotal = per.subtotal;
    var markedUp = per.markedUp;
    if (window.p86Pricing.targetMarginActive(co)) {
      markedUp = window.p86Pricing.applyTargetMargin(subtotal, co);
    }
    var fees = window.p86Pricing.applyFeesAndTax(markedUp, co);
    var marginPct = fees.total > 0 ? ((fees.total - subtotal) / fees.total) * 100 : 0;
    var lineCount = lines.filter(function(l) { return l.section !== '__section_header__'; }).length;
    return {
      subtotal: subtotal,
      markupAmount: markedUp - subtotal,
      markedUp: markedUp,
      feeFlat: fees.feeFlat,
      feePctAmount: fees.feePctAmount,
      taxAmount: fees.taxAmount,
      total: fees.total,
      marginPct: marginPct,
      lineCount: lineCount
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Line-target adapter — lets the shared Materials Drawer (catalog +
  // 🧩 assemblies + explode) insert lines into THIS change order exactly
  // as it does for the estimate editor. The drawer already does the
  // assembly explode client-side and hands us line "specs"; we translate
  // each spec into a CO line and route it into a CO section by cost
  // bucket. No server change, no pricing-model change — every added line
  // is still a plain qty×unitCost CO line the shared p86Pricing consumes.
  // ──────────────────────────────────────────────────────────────────
  var CO_BUCKET_SECTION = {
    materials: 'Materials',
    labor: 'Labor',
    gc: 'General Conditions',
    sub: 'Subcontractor Costs'
  };
  function coNum(v) { return (window.p86Pricing && window.p86Pricing.num) ? window.p86Pricing.num(v) : (parseFloat(v) || 0); }
  // Which cost bucket a drawer spec belongs in (materials|labor|gc|sub).
  // Prefer an explicit bucket/cost-code; else infer from the drawer's
  // section_name by keyword (the drawer uses its own section labels like
  // "Direct Labor", so an exact-label match against ours would misroute).
  var CO_BUCKETS = ['materials', 'labor', 'gc', 'sub'];
  function coBucketFor(input) {
    var v = input.bt_category || input.assembly_bucket || input.cost_code;
    if (v) { v = String(v).toLowerCase(); if (CO_BUCKETS.indexOf(v) !== -1) return v; }
    var nm = String(input.section_name || '').toLowerCase();
    if (nm) {
      if (/labor/.test(nm)) return 'labor';
      if (/general\s*cond|\bgc\b/.test(nm)) return 'gc';
      if (/\bsub/.test(nm)) return 'sub';
      if (/material|supplies/.test(nm)) return 'materials';
    }
    return null;
  }
  // Find-or-create the section header for a bucket; returns its line id.
  // CO headers key off `label`; we also stamp `btCategory` so a later
  // add re-uses the same section deterministically (like the estimate).
  function coEnsureSection(bucket) {
    var lines = _state.co.lines = (Array.isArray(_state.co.lines) ? _state.co.lines : []);
    var label = CO_BUCKET_SECTION[bucket] || CO_BUCKET_SECTION.materials;
    var hdr = lines.find(function (l) {
      return l.section === '__section_header__' &&
        (l.btCategory === bucket || String(l.label || '').toLowerCase() === label.toLowerCase());
    });
    if (hdr) { if (!hdr.btCategory) hdr.btCategory = bucket; return hdr.id; }
    var id = newLineId();
    lines.push({ id: id, section: '__section_header__', label: label, btCategory: bucket, markup: '', markupMode: 'percent' });
    return id;
  }
  // Translate one drawer spec → a CO line, inserted inside its section
  // (right before the next section header, mirroring the estimate).
  function coApplyAddLineItem(input) {
    if (!_state.co) throw new Error('No change order open.');
    var lines = _state.co.lines = (Array.isArray(_state.co.lines) ? _state.co.lines : []);
    var bucket = coBucketFor(input) || 'materials';
    var sectionId = coEnsureSection(bucket);
    var line = {
      id: newLineId(),
      qty: coNum(input.qty),
      unitCost: coNum(input.unit_cost),
      description: input.description || '',
      unit: input.unit || 'ea',
      markup: (input.markup_pct == null || input.markup_pct === '') ? '' : Number(input.markup_pct),
      markupMode: 'percent'
    };
    if (input.source_material_id != null) line.sourceMaterialId = input.source_material_id;
    if (input.source_assembly_id != null) line.sourceAssemblyId = input.source_assembly_id;
    if (Array.isArray(input.assembly_breakdown) && input.assembly_breakdown.length) line.assemblyBreakdown = input.assembly_breakdown;
    if (input.assembly_bucket) line.assemblyBucket = String(input.assembly_bucket);
    if (input.assembly_params && typeof input.assembly_params === 'object') line.assemblyParams = input.assembly_params;
    // Insert just before the next section header so the line is "born in"
    // its section (never appended to the array end).
    var startIdx = lines.findIndex(function (l) { return l.id === sectionId; });
    if (startIdx >= 0) {
      var insertAt = lines.length;
      for (var j = startIdx + 1; j < lines.length; j++) {
        if (lines[j].section === '__section_header__') { insertAt = j; break; }
      }
      lines.splice(insertAt, 0, line);
    } else {
      lines.push(line);
    }
    if (!input._silent) { markDirty(); paintLines(); paintTotals(); }
    return 'Added: "' + line.description + '" — qty ' + line.qty + ' @ $' + line.unitCost.toFixed(2);
  }
  function coApplyBulkAddLineItems(specs) {
    if (!Array.isArray(specs) || !specs.length) return [];
    var out = [];
    specs.forEach(function (s) {
      try { out.push(coApplyAddLineItem(Object.assign({ _silent: true }, s || {}))); } catch (e) {}
    });
    markDirty(); paintLines(); paintTotals();
    return out;
  }
  // The 4-method contract the Materials Drawer talks to (targetApi()).
  var coLineTarget = {
    getOpenId: function () { return _state.co ? _state.co.id : null; },
    activeAlternateName: function () { return _state.co ? (_state.co.title || 'This change order') : null; },
    applyAddLineItem: coApplyAddLineItem,
    applyBulkAddLineItems: coApplyBulkAddLineItems
  };
  // Open the shared catalog/assemblies drawer pointed at THIS change order.
  function openCatalogDrawer() {
    if (!window.MaterialsDrawer || typeof window.MaterialsDrawer.open !== 'function') {
      alert('The catalog is still loading — try again in a moment.'); return;
    }
    // Start from a clean drawer so a scope staged for a prior target (e.g.
    // an estimate) can't bleed into this change order.
    if (typeof window.MaterialsDrawer.reset === 'function') window.MaterialsDrawer.reset();
    window.p86ActiveLineTarget = coLineTarget;
    window.MaterialsDrawer.open();
  }

  // ──────────────────────────────────────────────────────────────────
  // Customer-facing Change Order document (print / Save-as-PDF)
  // ──────────────────────────────────────────────────────────────────
  // Opens a clean, self-contained document in a new window rendering the
  // rich Scope of Work + included-work list + the authoritative Total +
  // rich Terms & Conditions + a signature block. Cost/markup are never
  // shown — only the customer price (Total). Rich fields are sanitized via
  // p86RichText.toDisplayHTML before injection.
  function openCoCustomerDoc() {
    var co = _state.co;
    if (!co) return;
    // Best-effort flush so the persisted CO matches what we print (the doc
    // itself reads the live in-memory record regardless).
    if (_state.dirty) { try { flushSave(); } catch (e) {} }

    var RT = window.p86RichText;
    var toHTML = function (v) { return (RT && RT.toDisplayHTML) ? RT.toDisplayHTML(v) : escapeHTML(v || ''); };
    var money = function (n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var t = computeTotals() || {};
    var job = (window.appData && window.appData.jobs || []).find(function (j) { return j.id === co.job_id; }) || {};
    var jobNo = job.jobNumber || '';
    var jobTitle = job.title || job.name || '';
    var addr = job.address || [job.street_address, job.city, job.state, job.zip].filter(Boolean).join(', ');
    var client = job.client || '';
    var coNo = co.co_number || '';
    var dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // Included-work: section headers → group titles, priced lines → bullets
    // (descriptions only — no per-line pricing so cost/margin never leak and
    // the single Total is always the authoritative number).
    var lines = Array.isArray(co.lines) ? co.lines : [];
    var workHTML = '', listOpen = false;
    lines.forEach(function (l) {
      if (l.section === '__section_header__') {
        if (listOpen) { workHTML += '</ul>'; listOpen = false; }
        workHTML += '<h3 class="co-sec">' + escapeHTML(l.label || 'Section') + '</h3>';
      } else {
        var d = (l.description || '').trim();
        if (!d) return;
        if (!listOpen) { workHTML += '<ul class="co-lines">'; listOpen = true; }
        var qty = parseFloat(l.qty);
        var qtyLabel = (qty && qty !== 1) ? ' <span class="co-qty">(&times;' + escapeHTML(String(qty)) + ')</span>' : '';
        workHTML += '<li>' + escapeHTML(d) + qtyLabel + '</li>';
      }
    });
    if (listOpen) workHTML += '</ul>';

    var logoUrl = location.origin + '/images/logo-color.png';
    var doc =
      '<!doctype html><html><head><meta charset="utf-8"><title>Change Order' + (coNo ? ' ' + escapeHTML(coNo) : '') + '</title>' +
      '<style>' +
        '*{box-sizing:border-box;} body{font-family:Georgia,"Times New Roman",serif;color:#1a1a1a;margin:0;padding:32px;line-height:1.5;}' +
        '.doc{max-width:800px;margin:0 auto;}' +
        '.hd{text-align:center;border-bottom:2px solid #1B8541;padding-bottom:14px;margin-bottom:16px;}' +
        '.hd img{height:60px;} .hd .co{font-size:12px;color:#555;letter-spacing:1px;margin-top:6px;}' +
        '.ttl{font-size:24px;font-weight:bold;color:#1B3A5C;text-align:center;margin:6px 0 14px;}' +
        '.meta{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;gap:20px;}' +
        '.meta .lbl{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px;}' +
        'h2.sec{font-size:15px;color:#1B3A5C;border-bottom:1px solid #ddd;padding-bottom:4px;margin:22px 0 10px;}' +
        'h3.co-sec{font-size:13px;color:#333;margin:12px 0 4px;} ul.co-lines{margin:0 0 8px;padding-left:22px;} ul.co-lines li{margin:2px 0;} .co-qty{color:#888;font-size:12px;}' +
        '.scope,.terms{font-size:13.5px;} .scope p,.terms p{margin:0 0 8px;}' +
        '.total{margin:20px 0 4px;padding:14px 18px;background:#f1f5f9;border-radius:8px;display:flex;justify-content:space-between;align-items:center;}' +
        '.total .l{font-weight:bold;color:#1B3A5C;font-size:15px;} .total .v{font-weight:bold;font-size:22px;color:#1B3A5C;}' +
        '.tax{font-size:12px;color:#666;text-align:right;margin:0 4px 16px;}' +
        '.sig{margin-top:40px;display:flex;gap:40px;} .sig .box{flex:1;} .sig .line{border-bottom:1px solid #333;height:34px;} .sig .cap{font-size:11px;color:#666;margin-top:4px;}' +
        '.bar{position:fixed;top:10px;right:10px;} .bar button{font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#1B8541;color:#fff;cursor:pointer;font-weight:bold;}' +
        '@media print{.bar{display:none;} body{padding:0;}}' +
      '</style></head><body>' +
      '<div class="bar"><button onclick="window.print()">Print / Save PDF</button></div>' +
      '<div class="doc">' +
        '<div class="hd"><img src="' + escapeAttr(logoUrl) + '" alt="AG Exteriors" onerror="this.style.display=\'none\'"/>' +
          '<div class="co">CHANGE ORDER' + (coNo ? ' ' + escapeHTML(coNo) : '') + '</div></div>' +
        '<div class="ttl">' + escapeHTML(co.title || 'Change Order') + '</div>' +
        '<div class="meta">' +
          '<div><div class="lbl">Job</div>' + escapeHTML((jobNo ? jobNo + ' — ' : '') + jobTitle) + (addr ? '<br>' + escapeHTML(addr) : '') + '</div>' +
          '<div style="text-align:right;">' + (client ? '<div class="lbl">Client</div>' + escapeHTML(client) + '<br>' : '') + '<span class="lbl">Date</span> ' + escapeHTML(dateStr) + '</div>' +
        '</div>' +
        '<h2 class="sec">Scope of Work</h2><div class="scope">' + toHTML(co.scope) + '</div>' +
        (workHTML ? '<h2 class="sec">Included Work</h2>' + workHTML : '') +
        '<div class="total"><span class="l">Change Order Total</span><span class="v">' + money(t.total) + '</span></div>' +
        ((t.taxAmount && t.taxAmount > 0) ? '<div class="tax">Includes tax ' + money(t.taxAmount) + '</div>' : '') +
        (co.terms ? '<h2 class="sec">Terms &amp; Conditions</h2><div class="terms">' + toHTML(co.terms) + '</div>' : '') +
        '<div class="sig">' +
          '<div class="box"><div class="line"></div><div class="cap">Client signature</div></div>' +
          '<div class="box"><div class="line"></div><div class="cap">Date</div></div>' +
        '</div>' +
      '</div></body></html>';

    var w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups to preview the Change Order PDF.'); return; }
    w.document.open(); w.document.write(doc); w.document.close();
  }

  // ──────────────────────────────────────────────────────────────────
  // Mount + paint
  // ──────────────────────────────────────────────────────────────────
  function mount() {
    var prior = document.getElementById('co-editor-overlay');
    if (prior) prior.remove();
    var overlay = document.createElement('div');
    overlay.id = 'co-editor-overlay';
    overlay.className = 'p86-co-overlay';
    overlay.innerHTML = renderShell();
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    // Claim the shared Materials Drawer's insert target so catalog +
    // assembly adds land in THIS change order (cleared on close()).
    window.p86ActiveLineTarget = coLineTarget;

    overlay.addEventListener('click', function(e) {
      // Close on backdrop click (NOT on inner content)
      if (e.target === overlay) {
        if (_state.dirty || _state.saving) {
          // Save is debounced — flush then close
          if (_state.saveTimer) clearTimeout(_state.saveTimer);
          flushSave();
        }
        close();
      }
    });

    wireHeader(overlay);
    wireSidePanel(overlay);
    wireRichFields(overlay);
    paintLines();
    paintTotals();
    paintStatusPill();
    applyCoLockState();
    paintSaveStatus();

    // Escape closes the editor (same as estimates / reports overlays).
    overlay.tabIndex = -1;
    overlay.focus();
    overlay.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  function renderShell() {
    var co = _state.co;
    var coNumber = co.co_number || '';
    return (
      '<div class="p86-co-host">' +
        // ── Top bar: title + status pill + close ────────────────
        '<div class="p86-co-topbar">' +
          '<div class="p86-co-topbar-left">' +
            '<span class="p86-co-conumber">' + escapeHTML(coNumber) + '</span>' +
            '<input class="p86-co-title-input" type="text" placeholder="Change Order title (e.g. Add gable vents)" ' +
              'value="' + escapeAttr(co.title || '') + '" data-field="title" />' +
          '</div>' +
          '<div class="p86-co-topbar-right">' +
            '<span id="p86CoStatusPill" class="p86-co-status-pill"></span>' +
            '<span id="p86CoSaveStatus" class="p86-co-save-status"></span>' +
            '<button class="ee-btn ghost" data-co-close title="Close">&times;</button>' +
          '</div>' +
        '</div>' +
        // ── Totals chip bar ───────────────────────────────────────
        '<div id="p86CoTotals" class="p86-co-totals"></div>' +
        // ── Body: side panel + line table ─────────────────────────
        '<div class="p86-co-body">' +
          // Side panel — title/scope/margins/fees/tax
          '<aside class="p86-co-side">' +
            '<div class="p86-co-field">' +
              '<span>Scope of Work</span>' +
              '<div id="p86CoScopeHost" class="p86-co-rt"></div>' +
            '</div>' +
            '<div class="p86-co-field">' +
              '<span>Terms &amp; Conditions</span>' +
              '<div id="p86CoTermsHost" class="p86-co-rt"></div>' +
            '</div>' +
            '<label class="p86-co-field">' +
              '<span>Target Margin %</span>' +
              '<input type="number" min="0" max="99" step="0.1" data-field="targetMargin" placeholder="(optional — overrides line markups)" value="' + escapeAttr(co.targetMargin == null ? '' : co.targetMargin) + '" />' +
            '</label>' +
            '<label class="p86-co-field">' +
              '<span>Default Markup %</span>' +
              '<input type="number" min="0" step="0.1" data-field="defaultMarkup" placeholder="Fallback when line/section markup is blank" value="' + escapeAttr(co.defaultMarkup == null ? '' : co.defaultMarkup) + '" />' +
            '</label>' +
            '<div class="p86-co-field-row">' +
              '<label class="p86-co-field">' +
                '<span>Flat Fee $</span>' +
                '<input type="number" step="0.01" data-field="feeFlat" value="' + escapeAttr(co.feeFlat || 0) + '" />' +
              '</label>' +
              '<label class="p86-co-field">' +
                '<span>Fee %</span>' +
                '<input type="number" step="0.1" data-field="feePct" value="' + escapeAttr(co.feePct || 0) + '" />' +
              '</label>' +
            '</div>' +
            '<div class="p86-co-field-row">' +
              '<label class="p86-co-field">' +
                '<span>Tax %</span>' +
                '<input type="number" step="0.01" data-field="taxPct" value="' + escapeAttr(co.taxPct || 0) + '" />' +
              '</label>' +
              '<label class="p86-co-field">' +
                '<span>Round to $</span>' +
                '<input type="number" step="1" data-field="roundTo" value="' + escapeAttr(co.roundTo || 0) + '" />' +
              '</label>' +
            '</div>' +
            // Linked-node chip
            '<div class="p86-co-link-chip" id="p86CoLinkChip">' +
              (co.linked_node_id
                ? '<span class="p86-co-link-on">⛓ Wired to node ' + escapeHTML(co.linked_node_id) + '</span>'
                : '<span class="p86-co-link-off">Not on graph yet — drop a CO node and link this CO from there</span>') +
            '</div>' +
          '</aside>' +
          // Line table
          '<section class="p86-co-lines">' +
            '<div class="p86-co-lines-toolbar">' +
              '<button class="ee-btn primary" data-co-add-line>+ Add Line</button>' +
              '<button class="ee-btn secondary" data-co-add-catalog title="Add materials from the catalog or explode a costed assembly into lines">+ Catalog / Assemblies</button>' +
              '<button class="ee-btn secondary" data-co-add-section>+ Section Header</button>' +
              '<button class="ee-btn ghost" data-co-preview title="Preview the customer-facing PDF">Preview PDF</button>' +
            '</div>' +
            '<div id="p86CoLineTable" class="p86-co-line-table"></div>' +
          '</section>' +
        '</div>' +
      '</div>'
    );
  }

  // ── Header wiring (title + close + status pill + side panel) ──
  function wireHeader(overlay) {
    var titleInput = overlay.querySelector('[data-field="title"]');
    if (titleInput) titleInput.addEventListener('input', function() {
      _state.co.title = titleInput.value;
      markDirty();
    });
    var closeBtn = overlay.querySelector('[data-co-close]');
    if (closeBtn) closeBtn.addEventListener('click', close);

    // Status pill — clicking opens the transition flow
    var pill = overlay.querySelector('#p86CoStatusPill');
    if (pill) pill.addEventListener('click', openStatusTransition);

    // Add line / add section / preview
    var addLine = overlay.querySelector('[data-co-add-line]');
    if (addLine) addLine.addEventListener('click', function() {
      if (!Array.isArray(_state.co.lines)) _state.co.lines = [];
      _state.co.lines.push({
        id: newLineId(),
        qty: 1, unitCost: 0, description: '', markup: '', markupMode: 'percent'
      });
      markDirty();
      paintLines();
      paintTotals();
    });
    var addSection = overlay.querySelector('[data-co-add-section]');
    if (addSection) addSection.addEventListener('click', function() {
      var label = window.prompt('Section header label', 'Materials');
      if (label == null) return;
      if (!Array.isArray(_state.co.lines)) _state.co.lines = [];
      _state.co.lines.push({
        id: newLineId(),
        section: '__section_header__',
        label: label,
        markup: '', markupMode: 'percent'
      });
      markDirty();
      paintLines();
      paintTotals();
    });
    var addCatalog = overlay.querySelector('[data-co-add-catalog]');
    if (addCatalog) addCatalog.addEventListener('click', openCatalogDrawer);
    var previewBtn = overlay.querySelector('[data-co-preview]');
    if (previewBtn) previewBtn.addEventListener('click', openCoCustomerDoc);
  }

  // ── Rich-text fields (Scope + Terms) ───────────────────────────
  // Mount the shared p86RichText editor onto each host; onChange writes the
  // sanitized HTML straight into the in-memory CO and debounce-saves. Falls
  // back to a plain textarea if the rich-text module didn't load.
  function mountCoRichField(overlay, sel, field, ph) {
    var host = overlay.querySelector(sel);
    if (!host) return;
    if (window.p86RichText && window.p86RichText.mount) {
      _state['rt_' + field] = window.p86RichText.mount(host, {
        value: _state.co[field] || '',
        placeholder: ph,
        minHeight: 110,
        compact: true,
        onChange: function (html) { if (_state.co) { _state.co[field] = html; markDirty(); } }
      });
    } else {
      var ta = document.createElement('textarea');
      ta.rows = 6; ta.placeholder = ph;
      ta.value = (window.p86RichText && window.p86RichText.toPlainText)
        ? window.p86RichText.toPlainText(_state.co[field] || '')
        : (_state.co[field] || '');
      host.appendChild(ta);
      ta.addEventListener('input', function () { if (_state.co) { _state.co[field] = ta.value; markDirty(); } });
    }
  }
  function wireRichFields(overlay) {
    mountCoRichField(overlay, '#p86CoScopeHost', 'scope',
      'Describe the work this change order covers. The customer sees this on the change order.');
    mountCoRichField(overlay, '#p86CoTermsHost', 'terms',
      'Terms the customer agrees to when they approve this change order.');
  }

  // ── Side-panel field wiring ────────────────────────────────────
  function wireSidePanel(overlay) {
    var fields = ['targetMargin', 'defaultMarkup', 'feeFlat', 'feePct', 'taxPct', 'roundTo'];
    fields.forEach(function(f) {
      var el = overlay.querySelector('[data-field="' + f + '"]');
      if (!el) return;
      el.addEventListener('input', function() {
        var v = el.value;
        // Numeric fields stay numeric in memory; empty strings stay
        // strings so the editor remembers "the user cleared this on
        // purpose" (vs. "this was never set").
        if (['targetMargin', 'defaultMarkup'].indexOf(f) !== -1) {
          _state.co[f] = v === '' ? '' : Number(v);
        } else if (['feeFlat', 'feePct', 'taxPct', 'roundTo'].indexOf(f) !== -1) {
          _state.co[f] = v === '' ? 0 : Number(v);
        } else {
          _state.co[f] = v;
        }
        markDirty();
        paintTotals();
      });
    });
  }

  // ── Line table ─────────────────────────────────────────────────
  function paintLines() {
    var host = document.getElementById('p86CoLineTable');
    if (!host) return;
    var lines = Array.isArray(_state.co.lines) ? _state.co.lines : [];
    if (!lines.length) {
      host.innerHTML = '<div class="p86-co-lines-empty">' +
        'No line items yet. Click <strong>+ Add Line</strong> to add the first one, or <strong>+ Section Header</strong> to group lines by trade.' +
      '</div>';
      return;
    }
    var html = '<table class="p86-co-line-tbl"><thead>' +
      '<tr>' +
        '<th class="qty">Qty</th>' +
        '<th class="unit">Unit Cost</th>' +
        '<th class="desc">Description</th>' +
        '<th class="markup">Markup %</th>' +
        '<th class="ext">Marked-Up</th>' +
        '<th class="del"></th>' +
      '</tr></thead><tbody>';
    lines.forEach(function(l) {
      if (l.section === '__section_header__') {
        html +=
          '<tr class="p86-co-section-row" data-line-id="' + escapeAttr(l.id) + '">' +
            '<td colspan="3"><input class="p86-co-section-label" type="text" data-line-field="label" value="' + escapeAttr(l.label || '') + '" placeholder="Section name" /></td>' +
            '<td><input class="p86-co-section-markup" type="number" step="0.1" data-line-field="markup" value="' + escapeAttr(l.markup == null ? '' : l.markup) + '" placeholder="Section %" /></td>' +
            '<td class="ext"></td>' +
            '<td class="del"><button type="button" class="p86-co-line-del" data-line-del title="Delete section">&times;</button></td>' +
          '</tr>';
      } else {
        var lineList = lines;
        var m = window.p86Pricing.effectiveMarkupForLine(l, lineList, _state.co);
        var ext = (parseFloat(l.qty) || 0) * (parseFloat(l.unitCost) || 0);
        var marked = ext * (1 + m / 100);
        html +=
          '<tr class="p86-co-line-row" data-line-id="' + escapeAttr(l.id) + '">' +
            '<td><input type="number" step="0.01" data-line-field="qty" value="' + escapeAttr(l.qty == null ? '' : l.qty) + '" /></td>' +
            '<td><input type="number" step="0.01" data-line-field="unitCost" value="' + escapeAttr(l.unitCost == null ? '' : l.unitCost) + '" /></td>' +
            '<td><input type="text" data-line-field="description" value="' + escapeAttr(l.description || '') + '" placeholder="Line description" /></td>' +
            '<td><input type="number" step="0.1" data-line-field="markup" value="' + escapeAttr(l.markup == null ? '' : l.markup) + '" placeholder="' + m.toFixed(1) + '" /></td>' +
            '<td class="ext">' + escapeHTML(fmtCurrency(marked)) + '</td>' +
            '<td class="del"><button type="button" class="p86-co-line-del" data-line-del title="Delete line">&times;</button></td>' +
          '</tr>';
      }
    });
    html += '</tbody></table>';
    host.innerHTML = html;

    // Wire each row's inputs + delete button. Delegated per-row keeps
    // re-paint cheap (full repaint on every keystroke would steal
    // focus from the input being typed in).
    host.querySelectorAll('tr[data-line-id]').forEach(function(tr) {
      var lineId = tr.getAttribute('data-line-id');
      tr.querySelectorAll('[data-line-field]').forEach(function(input) {
        input.addEventListener('input', function() {
          var line = (_state.co.lines || []).find(function(x) { return String(x.id) === String(lineId); });
          if (!line) return;
          var f = input.getAttribute('data-line-field');
          var v = input.value;
          if (['qty', 'unitCost'].indexOf(f) !== -1) {
            line[f] = v === '' ? '' : Number(v);
          } else if (f === 'markup') {
            line[f] = v === '' ? '' : Number(v);
          } else {
            line[f] = v;
          }
          markDirty();
          // Repaint the row's marked-up cell + totals; leave the rest
          // of the table alone so focus stays where it is.
          paintLineExt(tr);
          paintTotals();
        });
      });
      var del = tr.querySelector('[data-line-del]');
      if (del) del.addEventListener('click', function() {
        _state.co.lines = (_state.co.lines || []).filter(function(x) { return String(x.id) !== String(lineId); });
        markDirty();
        paintLines();
        paintTotals();
      });
    });
  }

  // Update the marked-up cell of a single line row without re-paint.
  function paintLineExt(tr) {
    var lineId = tr.getAttribute('data-line-id');
    var lines = _state.co.lines || [];
    var line = lines.find(function(x) { return String(x.id) === String(lineId); });
    if (!line || line.section === '__section_header__') return;
    var cell = tr.querySelector('td.ext');
    if (!cell) return;
    var m = window.p86Pricing.effectiveMarkupForLine(line, lines, _state.co);
    var ext = (parseFloat(line.qty) || 0) * (parseFloat(line.unitCost) || 0);
    cell.textContent = fmtCurrency(ext * (1 + m / 100));
  }

  // ── Totals chip bar ────────────────────────────────────────────
  function paintTotals() {
    var host = document.getElementById('p86CoTotals');
    if (!host) return;
    var t = computeTotals();
    if (!t) { host.innerHTML = ''; return; }
    function chip(label, value, accent) {
      return '<div class="p86-co-chip' + (accent ? ' accent' : '') + '">' +
        '<div class="p86-co-chip-label">' + escapeHTML(label) + '</div>' +
        '<div class="p86-co-chip-value">' + escapeHTML(value) + '</div>' +
      '</div>';
    }
    host.innerHTML =
      chip('Subtotal', fmtCurrency(t.subtotal)) +
      chip('Markup', fmtCurrency(t.markupAmount)) +
      chip('Tax + Fees', fmtCurrency(t.feeFlat + t.feePctAmount + t.taxAmount)) +
      chip('Change Order Total', fmtCurrency(t.total), true) +
      chip('Margin', fmtPct(t.marginPct)) +
      chip('Lines', String(t.lineCount));
  }

  // ── Status pill ────────────────────────────────────────────────
  function paintStatusPill() {
    var pill = document.getElementById('p86CoStatusPill');
    if (!pill) return;
    var s = (_state.co && _state.co.status) || 'draft';
    pill.className = 'p86-co-status-pill status-' + s;
    var label = s === 'draft' ? 'Draft'
              : s === 'approved' ? 'Approved'
              : s === 'applied' ? 'Applied'
              : s;
    pill.innerHTML = '<span class="dot"></span>' + escapeHTML(label) + '<span class="caret">▾</span>';
    pill.title = s === 'applied'
      ? 'Applied — locked. WIP has consumed these costs.'
      : s === 'approved'
      ? 'Approved — locked / read-only. Move back to Draft (or unlock) to edit.'
      : 'Click to change status';
  }

  // Approved/applied COs are locked → read-only. Mirror of the estimate lock:
  // a .co-locked class disables inputs via CSS + a banner with an admin unlock.
  function applyCoLockState() {
    var host = document.querySelector('#co-editor-overlay .p86-co-host');
    if (!host) return;
    var locked = !!(_state.co && _state.co.is_locked);
    host.classList.toggle('co-locked', locked);
    var banner = document.getElementById('co-lock-banner');
    if (!locked) { if (banner) banner.remove(); return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'co-lock-banner';
      banner.className = 'co-lock-banner';
      // Place under the topbar (CO #/title/status) so it reads clearly in the
      // editor body — inserting before the topbar tucks it at the clipped top edge.
      var topbar = host.querySelector('.p86-co-topbar');
      if (topbar && topbar.nextSibling) host.insertBefore(banner, topbar.nextSibling);
      else host.appendChild(banner);
    }
    banner.innerHTML =
      '<span><strong>🔒 Approved — locked.</strong> This change order is approved and read-only. ' +
      'Move it back to Draft via the status pill, or unlock it to make corrections.</span>' +
      '<button type="button" id="co-unlock-btn" class="ee-btn small">Unlock to edit</button>';
    var btn = document.getElementById('co-unlock-btn');
    if (btn) btn.onclick = unlockCo;
  }

  function unlockCo() {
    var co = _state.co;
    if (!co || !window.p86Api.changeOrders.lock) return;
    if (!confirm('Unlock this approved change order for editing? It stays Approved but becomes editable until re-locked.')) return;
    window.p86Api.changeOrders.lock(co.id, false).then(function () {
      _state.co.is_locked = false;
      applyCoLockState();
      paintSaveStatus();
    }).catch(function (e) { alert('Unlock failed: ' + (e && e.message || e)); });
  }

  function openStatusTransition() {
    var co = _state.co;
    if (!co) return;
    var current = co.status || 'draft';
    var allowed = {
      draft: ['approved'],
      approved: ['draft', 'applied'],
      applied: []
    }[current] || [];
    if (!allowed.length) {
      alert('Applied change orders cannot be re-transitioned.');
      return;
    }
    var prior = document.getElementById('p86CoStatusMenu');
    if (prior) prior.remove();
    var menu = document.createElement('div');
    menu.id = 'p86CoStatusMenu';
    menu.className = 'p86-co-status-menu';
    menu.innerHTML = allowed.map(function(next) {
      var msg = '';
      if (next === 'approved') msg = '<small>Copies lines to the linked node and impacts WIP.</small>';
      else if (next === 'applied') msg = '<small>Marks the CO as consumed by the field. Locks edits.</small>';
      else if (next === 'draft') msg = '<small>Returns to editable state. Linked-node items remain in place; re-approve to refresh them.</small>';
      var label = next === 'draft' ? 'Move back to Draft'
                : next === 'approved' ? 'Approve (signed by customer)'
                : 'Mark as Applied';
      return '<button data-next="' + next + '">' +
        '<strong>' + escapeHTML(label) + '</strong>' + msg +
      '</button>';
    }).join('');
    document.body.appendChild(menu);

    var pill = document.getElementById('p86CoStatusPill');
    if (pill) {
      var r = pill.getBoundingClientRect();
      menu.style.top = (r.bottom + window.scrollY + 4) + 'px';
      menu.style.left = Math.max(8, r.right - menu.offsetWidth + window.scrollX) + 'px';
    }
    function closeMenu() { menu.remove(); document.removeEventListener('click', onOutside, true); }
    function onOutside(e) { if (!menu.contains(e.target) && !(pill && pill.contains(e.target))) closeMenu(); }
    setTimeout(function() { document.addEventListener('click', onOutside, true); }, 0);

    menu.querySelectorAll('[data-next]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        closeMenu();
        var next = btn.getAttribute('data-next');
        applyStatusChange(next);
      });
    });
  }

  function applyStatusChange(next) {
    var co = _state.co;
    if (!co || !next) return;
    // Flush any pending data save first so the server applies the
    // status to the freshest record, not the previous version.
    if (_state.saveTimer) { clearTimeout(_state.saveTimer); _state.saveTimer = null; }
    var pending = _state.dirty ? flushSaveSync() : Promise.resolve();
    pending.then(function() {
      return window.p86Api.changeOrders.setStatus(co.id, next);
    }).then(function(r) {
      var fresh = r && r.change_order;
      if (fresh) {
        Object.assign(_state.co, fresh);
      }
      paintStatusPill();
      applyCoLockState();
      paintSaveStatus();
      // Keep the Jobs-hub CO list behind the overlay in sync (no-ops
      // harmlessly when the hub isn't mounted).
      if (typeof window.p86JobsHubRefresh === 'function') window.p86JobsHubRefresh();
    }).catch(function(e) {
      alert('Status change failed: ' + (e.message || e));
    });
  }
  // Synchronous wrapper for the debounced save — flushSave is async
  // internally but the only place that needs to wait for it (status
  // transition) returns the promise directly.
  function flushSaveSync() {
    var co = _state.co;
    if (!co) return Promise.resolve();
    var data = {
      title: co.title || '',
      scope: co.scope || '',
      terms: co.terms || '',
      targetMargin: co.targetMargin || '',
      defaultMarkup: co.defaultMarkup || '',
      feeFlat: co.feeFlat || 0,
      feePct: co.feePct || 0,
      taxPct: co.taxPct || 0,
      roundTo: co.roundTo || 0,
      lines: Array.isArray(co.lines) ? co.lines : []
    };
    _state.saving = true;
    _state.saveError = null;
    paintSaveStatus();
    return window.p86Api.changeOrders.update(co.id, data).then(function(r) {
      var fresh = r && r.change_order;
      if (fresh) {
        _state.co.updated_at = fresh.updated_at;
        _state.co.status = fresh.status;
      }
      _state.dirty = false;
      _state.saving = false;
      _state.lastSavedAt = new Date();
      paintSaveStatus();
    });
  }

  // ── Save-status indicator ──────────────────────────────────────
  function paintSaveStatus() {
    var el = document.getElementById('p86CoSaveStatus');
    if (!el) return;
    if (_state.saveError) {
      el.className = 'p86-co-save-status error';
      el.textContent = '⚠ ' + _state.saveError;
      return;
    }
    if (_state.saving) {
      el.className = 'p86-co-save-status saving';
      el.textContent = 'Saving…';
      return;
    }
    if (_state.dirty) {
      el.className = 'p86-co-save-status dirty';
      el.textContent = 'Unsaved changes';
      return;
    }
    el.className = 'p86-co-save-status saved';
    el.textContent = _state.lastSavedAt ? '✓ Saved' : '';
  }

  // ──────────────────────────────────────────────────────────────────
  // Public surface
  // ──────────────────────────────────────────────────────────────────
  window.p86ChangeOrders = {
    openNew: openNew,
    open: openExisting,
    close: close
  };
})();
