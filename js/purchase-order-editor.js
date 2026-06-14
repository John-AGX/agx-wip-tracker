// Purchase Order editor — full-window overlay for the AGX <-> sub
// scope-of-work contract. Opened from the Jobs hub (Purchase Orders) and,
// later, from the job detail. Mirrors the change-order-editor feel:
// debounced autosave (PUT /api/purchase-orders/:id), a line-items grid,
// the scope-of-work contract text (seeded from the per-org template on
// create), internal notes, a status workflow, and sub e-sign acceptance.
//
// window.p86PurchaseOrders.open(id)         — load + edit an existing PO
// window.p86PurchaseOrders.openNew(jobId, opts) — create then open
// Attachments + lien-waiver/bill tracking are a later slice.
(function () {
  'use strict';

  var SAVE_DEBOUNCE_MS = 700;
  var _po = null;            // current PO object (server shape)
  var _saveTimer = null;
  var _subsCache = null;

  var STATUS_LABEL = {
    draft: 'Draft', issued: 'Issued', approved: 'Approved',
    work_complete: 'Work Complete', closed: 'Closed'
  };
  var STATUS_COLOR = {
    draft: '#94a3b8', issued: '#4f8cff', approved: '#34d399',
    work_complete: '#2dd4bf', closed: '#8b90a5'
  };
  // Forward step offered per status (the primary workflow button).
  var NEXT_STEP = {
    draft: { to: 'issued', label: 'Issue to sub' },
    issued: { to: 'approved', label: 'Mark approved (sub e-sign)' },
    approved: { to: 'work_complete', label: 'Mark work complete' },
    work_complete: { to: 'closed', label: 'Close PO' }
  };

  function esc(v) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(v == null ? '' : String(v));
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escAttr(v) { return esc(v); }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function money(n) {
    n = num(n);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function lineTotal(l) {
    if (!l || l.section === '__section_header__') return 0;
    return num(l.qty) * num(l.unitCost);
  }
  function poTotal(po) {
    return ((po && po.lines) || []).reduce(function (s, l) { return s + lineTotal(l); }, 0);
  }

  function loadSubs(cb) {
    if (_subsCache) { cb(_subsCache); return; }
    if (!window.p86Api || !window.p86Api.subs) { cb([]); return; }
    window.p86Api.subs.list().then(function (r) {
      _subsCache = (r && r.subs) || (Array.isArray(r) ? r : []);
      cb(_subsCache);
    }).catch(function () { cb([]); });
  }

  // ── open / create ───────────────────────────────────────────────────
  function open(id) {
    if (!window.p86Api || !window.p86Api.purchaseOrders) return;
    mountShell('Loading…');
    window.p86Api.purchaseOrders.get(id).then(function (r) {
      _po = (r && r.purchase_order) || null;
      if (!_po) { mountShell('Purchase order not found.'); return; }
      if (!Array.isArray(_po.lines)) _po.lines = [];
      render();
    }).catch(function (e) { mountShell('Failed to load: ' + esc((e && e.message) || 'error')); });
  }

  function openNew(jobId, opts) {
    opts = opts || {};
    if (!window.p86Api || !window.p86Api.purchaseOrders) return;
    mountShell('Creating…');
    window.p86Api.purchaseOrders.create(jobId, {
      title: opts.title || '', sub_id: opts.sub_id || null
    }).then(function (r) {
      _po = (r && r.purchase_order) || null;
      if (!_po) { mountShell('Could not create the purchase order.'); return; }
      if (!Array.isArray(_po.lines)) _po.lines = [];
      render();
    }).catch(function (e) { mountShell('Could not create: ' + esc((e && e.message) || 'error')); });
  }

  // ── shell + render ──────────────────────────────────────────────────
  function mountShell(msg) {
    var ov = document.getElementById('po-editor-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'po-editor-overlay';
      ov.className = 'po-ed-overlay';
      document.body.appendChild(ov);
    }
    ov.innerHTML = '<div class="po-ed"><div class="po-ed-loading">' + esc(msg || 'Loading…') + '</div></div>';
    ov.style.display = 'flex';
  }
  function close() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; saveNow(); }
    var ov = document.getElementById('po-editor-overlay');
    if (ov) ov.style.display = 'none';
    _po = null;
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var ov = document.getElementById('po-editor-overlay');
      if (ov && ov.style.display !== 'none') close();
    }
  });

  function render() {
    var ov = document.getElementById('po-editor-overlay');
    if (!ov || !_po) return;
    var st = _po.status || 'draft';
    var locked = (st === 'closed');
    var step = NEXT_STEP[st];
    var jobLabel = (_po.job_number ? _po.job_number + ' — ' : '') + (_po.job_title || '');

    ov.innerHTML =
      '<div class="po-ed">' +
        '<div class="po-ed-head">' +
          '<div class="po-ed-head-l">' +
            '<span class="po-ed-num">' + esc(_po.po_number || 'PO') + '</span>' +
            '<span class="badge" style="background:' + STATUS_COLOR[st] + '22;color:' + STATUS_COLOR[st] + ';border:1px solid ' + STATUS_COLOR[st] + '44;">' + esc(STATUS_LABEL[st] || st) + '</span>' +
            (jobLabel ? '<span class="po-ed-job">' + esc(jobLabel) + '</span>' : '') +
          '</div>' +
          '<div class="po-ed-head-r">' +
            '<span class="po-ed-saved" id="po-ed-saved"></span>' +
            (step && !locked ? '<button class="ee-btn primary" id="po-ed-step">' + esc(step.label) + '</button>' : '') +
            '<button class="ee-btn" id="po-ed-print">Print</button>' +
            '<button class="ee-btn" id="po-ed-close">Close</button>' +
          '</div>' +
        '</div>' +
        '<div class="po-ed-body">' +
          generalSectionHTML(locked) +
          lineItemsSectionHTML(locked) +
          scopeSectionHTML(locked) +
          notesSectionHTML(locked) +
          acceptanceSectionHTML() +
        '</div>' +
      '</div>';

    wire(locked);
  }

  function generalSectionHTML(locked) {
    var dis = locked ? ' disabled' : '';
    var subName = _po.sub_name || '';
    return '<div class="po-ed-sec">' +
      '<div class="po-ed-sec-title">General</div>' +
      '<div class="po-ed-grid">' +
        '<label class="po-ed-field po-ed-field-wide"><span>Title</span>' +
          '<input id="po-f-title" type="text" class="po-ed-input" value="' + escAttr(_po.title || '') + '" placeholder="e.g. Framing and Decking"' + dis + '></label>' +
        '<label class="po-ed-field"><span>Subcontractor</span>' +
          '<select id="po-f-sub" class="po-ed-input"' + dis + '><option value="">— Select sub —</option></select></label>' +
        '<label class="po-ed-field"><span>Scheduled completion</span>' +
          '<input id="po-f-sched" type="date" class="po-ed-input" value="' + escAttr(_po.scheduledCompletion || '') + '"' + dis + '></label>' +
        '<label class="po-ed-field po-ed-check"><input id="po-f-materials" type="checkbox"' + (_po.materialsOnly ? ' checked' : '') + dis + '> <span>Materials only</span></label>' +
      '</div>' +
      '<div class="po-ed-sub-current" id="po-ed-sub-current">' + (subName ? 'Assigned: <strong>' + esc(subName) + '</strong>' : '') + '</div>' +
    '</div>';
  }

  function lineItemsSectionHTML(locked) {
    var lines = _po.lines || [];
    var rows = lines.map(function (l, i) { return lineRowHTML(l, i, locked); }).join('');
    return '<div class="po-ed-sec">' +
      '<div class="po-ed-sec-title">Line Items</div>' +
      '<div class="po-ed-tbl-wrap"><table class="po-ed-tbl">' +
        '<thead><tr>' +
          '<th>Item</th><th>Cost type</th><th>Cost category</th>' +
          '<th class="num">Unit cost</th><th class="num">Qty</th><th>Unit</th>' +
          '<th class="num">Total</th><th></th>' +
        '</tr></thead>' +
        '<tbody id="po-ed-lines">' + (rows || '') + '</tbody>' +
        '<tfoot><tr><td colspan="6" class="po-ed-tot-label">Total</td>' +
          '<td class="num po-ed-tot" id="po-ed-total">' + money(poTotal(_po)) + '</td><td></td></tr></tfoot>' +
      '</table></div>' +
      (locked ? '' : '<button class="ee-btn po-ed-addrow" id="po-ed-addrow">+ Add line</button>') +
    '</div>';
  }
  function lineRowHTML(l, i, locked) {
    var dis = locked ? ' disabled' : '';
    return '<tr data-i="' + i + '">' +
      '<td><input class="po-ed-cell" data-f="description" value="' + escAttr(l.description || '') + '"' + dis + '></td>' +
      '<td><input class="po-ed-cell" data-f="costType" value="' + escAttr(l.costType || '') + '" placeholder="Subcontractor"' + dis + '></td>' +
      '<td><input class="po-ed-cell" data-f="costCategory" value="' + escAttr(l.costCategory || '') + '"' + dis + '></td>' +
      '<td class="num"><input class="po-ed-cell num" data-f="unitCost" type="number" step="0.01" value="' + escAttr(l.unitCost != null ? l.unitCost : '') + '"' + dis + '></td>' +
      '<td class="num"><input class="po-ed-cell num" data-f="qty" type="number" step="any" value="' + escAttr(l.qty != null ? l.qty : '') + '"' + dis + '></td>' +
      '<td><input class="po-ed-cell" data-f="unit" value="' + escAttr(l.unit || '') + '" placeholder="EA"' + dis + '></td>' +
      '<td class="num po-ed-rowtot">' + money(lineTotal(l)) + '</td>' +
      '<td>' + (locked ? '' : '<button class="po-ed-delrow" data-i="' + i + '" title="Remove">✕</button>') + '</td>' +
    '</tr>';
  }

  function scopeSectionHTML(locked) {
    return '<div class="po-ed-sec">' +
      '<div class="po-ed-sec-title">Scope of Work &amp; Terms</div>' +
      '<textarea id="po-f-scope" class="po-ed-input po-ed-scope" rows="14"' + (locked ? ' disabled' : '') + '>' + esc(_po.scope || '') + '</textarea>' +
    '</div>';
  }
  function notesSectionHTML(locked) {
    return '<div class="po-ed-sec">' +
      '<div class="po-ed-sec-title">Internal Notes <span class="po-ed-hint">(not shown to the sub)</span></div>' +
      '<textarea id="po-f-notes" class="po-ed-input" rows="3"' + (locked ? ' disabled' : '') + '>' + esc(_po.internalNotes || '') + '</textarea>' +
    '</div>';
  }
  function acceptanceSectionHTML() {
    var a = _po.acceptance;
    if (a && a.accepted) {
      return '<div class="po-ed-sec po-ed-accepted">' +
        '<div class="po-ed-sec-title">Acceptance</div>' +
        '<div>✓ Accepted by <strong>' + esc(a.name || 'sub') + '</strong> on ' + esc(a.date || '') + ' — this PO is the executed contract.</div>' +
      '</div>';
    }
    return '<div class="po-ed-sec po-ed-pending">' +
      '<div class="po-ed-sec-title">Acceptance</div>' +
      '<div class="po-ed-hint">Not yet accepted. Use “Mark approved (sub e-sign)” to record the subcontractor’s acceptance.</div>' +
    '</div>';
  }

  // ── wiring ──────────────────────────────────────────────────────────
  function wire(locked) {
    var byId = function (id) { return document.getElementById(id); };
    var closeBtn = byId('po-ed-close'); if (closeBtn) closeBtn.addEventListener('click', close);
    var printBtn = byId('po-ed-print'); if (printBtn) printBtn.addEventListener('click', printPO);
    var stepBtn = byId('po-ed-step'); if (stepBtn) stepBtn.addEventListener('click', advanceStatus);

    // Sub picker — populate from cache.
    var subSel = byId('po-f-sub');
    if (subSel) {
      loadSubs(function (subs) {
        subSel.innerHTML = '<option value="">— Select sub —</option>' + subs.map(function (s) {
          return '<option value="' + escAttr(s.id) + '"' + (String(s.id) === String(_po.sub_id) ? ' selected' : '') + '>' + esc(s.name || s.id) + '</option>';
        }).join('');
      });
      subSel.addEventListener('change', function () {
        _po.sub_id = subSel.value || null;
        var picked = (_subsCache || []).find(function (s) { return String(s.id) === String(_po.sub_id); });
        _po.sub_name = picked ? picked.name : '';
        var cur = byId('po-ed-sub-current');
        if (cur) cur.innerHTML = _po.sub_name ? 'Assigned: <strong>' + esc(_po.sub_name) + '</strong>' : '';
        queueSave();
      });
    }
    if (locked) return;

    bindInput('po-f-title', function (v) { _po.title = v; });
    bindInput('po-f-scope', function (v) { _po.scope = v; });
    bindInput('po-f-notes', function (v) { _po.internalNotes = v; });
    bindInput('po-f-sched', function (v) { _po.scheduledCompletion = v; });
    var mat = byId('po-f-materials');
    if (mat) mat.addEventListener('change', function () { _po.materialsOnly = mat.checked; queueSave(); });

    var addRow = byId('po-ed-addrow');
    if (addRow) addRow.addEventListener('click', function () {
      _po.lines.push({ id: 'pol_' + Math.random().toString(36).slice(2, 8), description: '', costType: 'Subcontractors Costs', costCategory: 'Subcontractor', unitCost: '', qty: 1, unit: 'EA' });
      reRenderLines();
      queueSave();
    });

    wireLineInputs();
  }

  function bindInput(id, setter) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function () { setter(el.value); queueSave(); });
  }

  function wireLineInputs() {
    var body = document.getElementById('po-ed-lines');
    if (!body) return;
    body.querySelectorAll('.po-ed-cell').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var tr = inp.closest('tr'); if (!tr) return;
        var i = parseInt(tr.getAttribute('data-i'), 10);
        var f = inp.getAttribute('data-f');
        if (!_po.lines[i]) return;
        _po.lines[i][f] = inp.value;
        if (f === 'unitCost' || f === 'qty') {
          var rt = tr.querySelector('.po-ed-rowtot');
          if (rt) rt.textContent = money(lineTotal(_po.lines[i]));
          var tot = document.getElementById('po-ed-total');
          if (tot) tot.textContent = money(poTotal(_po));
        }
        queueSave();
      });
    });
    body.querySelectorAll('.po-ed-delrow').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = parseInt(btn.getAttribute('data-i'), 10);
        _po.lines.splice(i, 1);
        reRenderLines();
        queueSave();
      });
    });
  }
  function reRenderLines() {
    var body = document.getElementById('po-ed-lines');
    if (!body) return;
    body.innerHTML = _po.lines.map(function (l, i) { return lineRowHTML(l, i, false); }).join('');
    var tot = document.getElementById('po-ed-total');
    if (tot) tot.textContent = money(poTotal(_po));
    wireLineInputs();
  }

  // ── save ────────────────────────────────────────────────────────────
  function queueSave() {
    setSaved('Saving…');
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }
  function saveNow() {
    _saveTimer = null;
    if (!_po || !window.p86Api || !window.p86Api.purchaseOrders) return;
    var payload = {
      title: _po.title || '', scope: _po.scope || '', internalNotes: _po.internalNotes || '',
      scheduledCompletion: _po.scheduledCompletion || '', materialsOnly: !!_po.materialsOnly,
      lines: _po.lines || [], sub_id: _po.sub_id || null
    };
    window.p86Api.purchaseOrders.update(_po.id, payload)
      .then(function () { setSaved('Saved'); })
      .catch(function () { setSaved('Save failed'); });
  }
  function setSaved(t) { var el = document.getElementById('po-ed-saved'); if (el) el.textContent = t; }

  // ── status workflow ─────────────────────────────────────────────────
  function advanceStatus() {
    var step = NEXT_STEP[_po.status || 'draft'];
    if (!step) return;
    var acceptance = null;
    if (step.to === 'approved') {
      var nm = window.prompt('Record subcontractor acceptance (e-sign).\n\nSubcontractor name (as signing):', _po.sub_name || '');
      if (nm === null) return; // cancelled
      acceptance = { name: nm, date: new Date().toISOString().slice(0, 10) };
    } else {
      if (!window.confirm('Move this PO to "' + (STATUS_LABEL[step.to] || step.to) + '"?')) return;
    }
    // Flush any pending data save first so the status call sees latest body.
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    saveNow();
    window.p86Api.purchaseOrders.setStatus(_po.id, step.to, acceptance)
      .then(function (r) {
        _po = (r && r.purchase_order) || _po;
        if (!Array.isArray(_po.lines)) _po.lines = [];
        // Preserve the sub_name display (status response doesn't re-join it).
        if (!_po.sub_name && _subsCache) {
          var picked = _subsCache.find(function (s) { return String(s.id) === String(_po.sub_id); });
          _po.sub_name = picked ? picked.name : '';
        }
        render();
        if (typeof window.p86JobsHubRefresh === 'function') window.p86JobsHubRefresh();
      })
      .catch(function (e) { alert('Could not update status: ' + ((e && e.message) || 'error')); });
  }

  // ── print ───────────────────────────────────────────────────────────
  function printPO() {
    var w = window.open('', '_blank');
    if (!w) return;
    var lines = (_po.lines || []).filter(function (l) { return l.section !== '__section_header__'; });
    var rowsHtml = lines.map(function (l) {
      return '<tr><td>' + esc(l.description || '') + '</td><td>' + esc(l.costType || '') + '</td>' +
        '<td style="text-align:right">' + money(l.unitCost) + '</td><td style="text-align:right">' + esc(l.qty != null ? l.qty : '') + '</td>' +
        '<td>' + esc(l.unit || '') + '</td><td style="text-align:right">' + money(lineTotal(l)) + '</td></tr>';
    }).join('');
    var a = _po.acceptance;
    w.document.write(
      '<html><head><title>' + esc(_po.po_number || 'Purchase Order') + '</title>' +
      '<style>body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:40px;font-size:12px;}' +
      'h1{font-size:18px;margin:0 0 4px;}h2{font-size:13px;border-bottom:1px solid #999;padding-bottom:3px;margin:18px 0 8px;}' +
      'table{width:100%;border-collapse:collapse;margin-top:6px;}th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;}' +
      'th{background:#f2f2f2;}pre{white-space:pre-wrap;font-family:inherit;font-size:12px;}' +
      '.meta{margin:2px 0;} .tot{text-align:right;font-weight:bold;}</style></head><body>' +
      '<h1>Purchase Order ' + esc(_po.po_number || '') + '</h1>' +
      '<div class="meta"><strong>' + esc(_po.title || '') + '</strong></div>' +
      '<div class="meta">Job: ' + esc((_po.job_number ? _po.job_number + ' — ' : '') + (_po.job_title || '')) + '</div>' +
      '<div class="meta">Subcontractor: ' + esc(_po.sub_name || '') + '</div>' +
      '<div class="meta">Scheduled completion: ' + esc(_po.scheduledCompletion || '') + (_po.materialsOnly ? ' &nbsp;·&nbsp; Materials only' : '') + '</div>' +
      '<h2>Line Items</h2><table><thead><tr><th>Item</th><th>Cost type</th><th style="text-align:right">Unit cost</th><th style="text-align:right">Qty</th><th>Unit</th><th style="text-align:right">Total</th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table>' +
      '<p class="tot">Total: ' + money(poTotal(_po)) + '</p>' +
      '<h2>Scope of Work &amp; Terms</h2><pre>' + esc(_po.scope || '') + '</pre>' +
      (a && a.accepted ? '<h2>Acceptance</h2><div class="meta">Accepted by ' + esc(a.name || '') + ' on ' + esc(a.date || '') + '</div>' : '') +
      '</body></html>'
    );
    w.document.close();
    w.focus();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 300);
  }

  window.p86PurchaseOrders = { open: open, openNew: openNew, close: close };
})();
