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
  function openNew(jobId) {
    if (!jobId) { console.warn('openNew: jobId required'); return; }
    if (!window.p86Api || !window.p86Api.changeOrders) {
      alert('API not available'); return;
    }
    window.p86Api.changeOrders.create(jobId, {
      title: '',
      scope: '',
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
    _state.co = null;
    _state.dirty = false;
    _state.saving = false;
    _state.saveError = null;
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
            '<label class="p86-co-field">' +
              '<span>Scope of Work</span>' +
              '<textarea data-field="scope" rows="6" placeholder="Describe the work this change order covers. Customer sees this text on the proposal PDF.">' + escapeHTML(co.scope || '') + '</textarea>' +
            '</label>' +
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
    var previewBtn = overlay.querySelector('[data-co-preview]');
    if (previewBtn) previewBtn.addEventListener('click', function() {
      // Preview hook lands in Phase 7. For now, alert so the user
      // knows the button is intentional and waiting on the PDF pipe.
      alert('Customer PDF preview lands in the next phase. For now, totals + lines are saved and the CO can be approved.');
    });
  }

  // ── Side-panel field wiring ────────────────────────────────────
  function wireSidePanel(overlay) {
    var fields = ['scope', 'targetMargin', 'defaultMarkup', 'feeFlat', 'feePct', 'taxPct', 'roundTo'];
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
      host.insertBefore(banner, host.firstChild);
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
