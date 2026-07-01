// Cost Inbox — receipt capture (photo + amount + cost code), job/lead-linked.
// Ported from John's AppSpace "Cost Inbox", streamlined + skinned in the P86
// dark theme. Backed by /api/receipts (server/routes/receipt-routes.js) +
// p86Api.receipts. Photos go through the existing attachments pipeline.
//
//   window.p86CostInbox.render(host)   — the Cost Inbox list page
//   window.p86CostInbox.openNew()      — + New Receipt (camera-first form)
'use strict';
(function () {
  if (window.p86CostInbox) return;

  // Inline an AGX icon SVG (dynamic innerHTML buttons need the SVG embedded now;
  // the data-p86-icon swapper won't catch dynamically-rendered content).
  function ciIcon(name) { try { return (window.p86Icon ? window.p86Icon(name) : ''); } catch (e) { return ''; } }
  var PAY_LABEL = { cash: 'Cash', company_card: 'Company card', personal_card: 'Personal card', check: 'Check', ach: 'ACH / transfer', other: 'Other' };
  // subs cache for the receipt sub-picker + name resolution (loaded on demand)
  var _subs = [];

  var COST_CODES = [
    { v: 'materials', label: 'Materials' },
    { v: 'labor',     label: 'Labor' },
    { v: 'sub',       label: 'Subcontractor' },
    { v: 'gc',        label: 'General Conditions' }
  ];
  var CODE_LABEL = { materials: 'Materials', labor: 'Labor', sub: 'Subcontractor', gc: 'General Conditions', presale: 'Pre-sale' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    var v = Number(n || 0);
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(d) {
    if (!d) return '';
    // purchased_at is a DATE (server serializes to UTC midnight) — parse the
    // calendar day as LOCAL so it doesn't render one day early in US timezones.
    var s = String(d);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    var dt = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
    if (isNaN(dt.getTime())) return s.slice(0, 10);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  // created_at / updated_at are full timestamps — show date + time (local).
  function fmtDateTime(d) {
    if (!d) return '';
    var dt = new Date(String(d));
    if (isNaN(dt.getTime())) return fmtDate(d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function toast(msg, kind) {
    // p86Toast is an object with .show() — but stay defensive across shapes so a
    // toast failure can never break the save/close flow.
    try {
      if (window.p86Toast && typeof window.p86Toast.show === 'function') return window.p86Toast.show(msg, kind);
      if (typeof window.p86Toast === 'function') return window.p86Toast(msg, kind);
    } catch (e) { /* non-fatal */ }
    if (kind === 'error') console.warn(msg);
  }
  function myUserId() {
    try {
      var t = localStorage.getItem('p86-auth-token');
      var p = JSON.parse(atob(t.split('.')[1]));
      return p.id || p.user_id || p.sub || null;
    } catch (e) { return null; }
  }
  // Downscale a picked photo to a JPEG data-URL before sending to OCR — keeps
  // the payload small/fast/cheap; ~1280px is plenty to read vendor + date text.
  function downscaleImage(file, maxDim, cb) {
    try {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        try {
          var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          var cw = Math.max(1, Math.round(img.width * scale));
          var ch = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
          URL.revokeObjectURL(url);
          cb(canvas.toDataURL('image/jpeg', 0.7));
        } catch (e) { URL.revokeObjectURL(url); cb(null); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
      img.src = url;
    } catch (e) { cb(null); }
  }
  function dataUrlToFile(dataUrl, name) {
    try {
      var arr = dataUrl.split(',');
      var mime = (arr[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
      var bstr = atob(arr[1]); var n = bstr.length; var u8 = new Uint8Array(n);
      while (n--) u8[n] = bstr.charCodeAt(n);
      return new File([u8], name || ('receipt_' + Date.now() + '.jpg'), { type: mime });
    } catch (e) { return null; }
  }

  // ── Entity (job/lead/category) cache for the picker + label resolution ──
  var _jobs = [], _leads = [], _categories = [], _entLoaded = false;
  function loadEntities() {
    var a = window.p86Api;
    if (!a) return Promise.resolve();
    var tasks = [];
    // Jobs + leads are heavier — cache them after the first load.
    if (!_entLoaded) {
      tasks.push(a.jobs.list().then(function (r) { _jobs = (r && (r.jobs || r)) || []; }).catch(function () { _jobs = []; }));
      tasks.push(a.leads.list().then(function (r) { _leads = (r && (r.leads || r)) || []; }).catch(function () { _leads = []; }));
      // Subs for the receipt Sub/Vendor picker (needs JOBS_VIEW_ALL — 403 => empty).
      tasks.push((a.subs && a.subs.list ? a.subs.list() : Promise.resolve(null)).then(function (r) { var s = r && (r.subs || r); if (Array.isArray(s)) _subs = s; }).catch(function () { _subs = []; }));
    }
    // Categories are tiny — ALWAYS refresh: self-heals a transient miss + picks
    // up any category just added in Admin without a full page reload. On error,
    // keep whatever we already have (don't wipe a good list).
    tasks.push((a.receipts && a.receipts.categories ? a.receipts.categories() : Promise.resolve(null))
      .then(function (r) { var c = r && (r.categories || r); if (Array.isArray(c)) _categories = c; }).catch(function () {}));
    return Promise.all(tasks).then(function () { _entLoaded = true; });
  }
  function jobLabel(j) { return (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.name || j.id); }
  function catLabel(c) { return c.name || ('Category ' + c.id); }
  function entityLabel(type, id) {
    if (!type || !id) return '';
    if (type === 'job') { var j = _jobs.find(function (x) { return String(x.id) === String(id); }); return j ? jobLabel(j) : ('Job ' + id); }
    if (type === 'category') { var c = _categories.find(function (x) { return String(x.id) === String(id); }); return c ? catLabel(c) : ('Category ' + id); }
    var l = _leads.find(function (x) { return String(x.id) === String(id); }); return l ? (l.title || ('Lead ' + id)) : ('Lead ' + id);
  }

  // ── List page ─────────────────────────────────────────────────────
  var _filters = { q: '' };       // inline quick-search
  var _drawer = null;             // rich filter-drawer values (null = none)
  var _pinnedEntity = null;       // {type,id} — exact deep-link pin from openFor()
  var _pinArmed = false;          // keep the pin for the next render only
  var _receipts = [];
  var _selected = {};        // id -> true (multi-select for export)
  var _visibleRows = [];     // the currently filtered/sorted rows on screen
  // Column/row table is the only list view. Table sort state:
  var _tsort = { key: '', dir: 'desc' };
  // Saved-view state (Slice 2): which columns show + the user's saved views.
  var _cols = null;            // visible column keys; null → all (set on first render)
  var _views = [];             // this user's saved views for the Cost Inbox
  var _activeViewId = null;    // id of the currently-applied saved view (null = ad-hoc)
  var CI_COL_LABEL = { photo: 'Photo', vendor: 'Vendor', amount: 'Amount', cost: 'Cost type', linked: 'Linked to', sub: 'Sub/Vendor', tags: 'Tags', payment: 'Payment', billable: 'Billable', invoice: 'Invoice #', date: 'Purchased', uploaded: 'Uploaded by', uploaded_at: 'Uploaded (date/time)', status: 'Status' };
  function allColKeys() { return CI_COLS.map(function (c) { return c.key; }); }
  function visibleCols() { var keys = _cols || DEFAULT_COLS; return CI_COLS.filter(function (c) { return keys.indexOf(c.key) >= 0; }); }
  function persistCols() { try { localStorage.setItem('p86-ci-cols', JSON.stringify(_cols || DEFAULT_COLS)); } catch (e) {} }
  function restoreCols() { try { var s = JSON.parse(localStorage.getItem('p86-ci-cols') || 'null'); if (Array.isArray(s) && s.length) _cols = s; } catch (e) {} }

  // Field spec for the filter drawer (uploaded-by options come from the loaded set).
  var COST_CODE_OPTS = [
    { v: 'materials', label: 'Materials' }, { v: 'labor', label: 'Labor' },
    { v: 'sub', label: 'Subcontractor' }, { v: 'gc', label: 'General Conditions' },
    { v: 'presale', label: 'Pre-sale' }
  ];
  function ciFilterFields() {
    var seen = {}, users = [{ v: '', label: 'All uploaders' }];
    _receipts.forEach(function (r) {
      if (r.entered_by == null) return; var k = String(r.entered_by);
      if (seen[k]) return; seen[k] = true;
      users.push({ v: k, label: r.entered_by_name || ('User ' + k) });
    });
    return [
      { key: 'status', label: 'Status', type: 'chips', options: [{ v: 'unprocessed', label: 'Unprocessed' }, { v: 'processed', label: 'Processed' }, { v: 'void', label: 'Voided' }] },
      { key: 'linked', label: 'Job / Lead / Category', type: 'text', placeholder: 'Type a job, lead, or category…' },
      { key: 'cost_code', label: 'Cost Code', type: 'chips', options: COST_CODE_OPTS },
      { key: 'purchase_date', label: 'Purchase Date', type: 'daterange' },
      { key: 'upload_date', label: 'Upload Date', type: 'daterange' },
      { key: 'vendor', label: 'Sub / Vendor', type: 'text', placeholder: 'Vendor name…' },
      { key: 'tags', label: 'Tags', type: 'text', placeholder: 'Tag contains…' },
      { key: 'payment', label: 'Payment Method', type: 'select', options: [{ v: '', label: 'Any' }].concat(Object.keys(PAY_LABEL).map(function (k) { return { v: k, label: PAY_LABEL[k] }; })) },
      { key: 'flags', label: 'Flags', type: 'chips', options: [{ v: 'billable', label: 'Billable' }, { v: 'reimbursable', label: 'Reimbursable' }] },
      { key: 'uploaded_by', label: 'Uploaded By', type: 'select', options: users },
      { key: 'amount', label: 'Total Amount', type: 'numrange' }
    ];
  }
  // Does a receipt pass the current drawer filters? (null drawer = default: hide void.)
  function matchesDrawer(r) {
    if (_pinnedEntity && !(r.entity_type === _pinnedEntity.type && String(r.entity_id) === String(_pinnedEntity.id))) return false;
    var d = _drawer;
    // status
    if (d && d.status && d.status.length) { if (d.status.indexOf(r.status) < 0) return false; }
    else if (r.status === 'void') return false; // no status chosen → hide voided
    if (!d) return true;
    if (d.linked && d.linked.trim()) { if (entityLabel(r.entity_type, r.entity_id).toLowerCase().indexOf(d.linked.trim().toLowerCase()) < 0) return false; }
    if (d.cost_code && d.cost_code.length) { var code = r.is_presale ? 'presale' : (r.cost_code || ''); if (d.cost_code.indexOf(code) < 0) return false; }
    var pr = window.p86FilterDrawer.resolveDateRange(d.purchase_date);
    if (pr.from || pr.to) { var pd = String(r.purchased_at || '').slice(0, 10); if (!pd) return false; if (pr.from && pd < pr.from) return false; if (pr.to && pd > pr.to) return false; }
    var ur = window.p86FilterDrawer.resolveDateRange(d.upload_date);
    if (ur.from || ur.to) { var ud = String(r.created_at || '').slice(0, 10); if (!ud) return false; if (ur.from && ud < ur.from) return false; if (ur.to && ud > ur.to) return false; }
    if (d.vendor && d.vendor.trim()) { var vhay = ((r.vendor || '') + ' ' + (r.sub_name || '')).toLowerCase(); if (vhay.indexOf(d.vendor.trim().toLowerCase()) < 0) return false; }
    if (d.tags && d.tags.trim()) { var tq = d.tags.trim().toLowerCase(); if (!(r.tags || []).some(function (t) { return String(t).toLowerCase().indexOf(tq) >= 0; })) return false; }
    if (d.payment) { if (r.payment_method !== d.payment) return false; }
    if (d.flags && d.flags.length) {
      if (d.flags.indexOf('billable') >= 0 && !r.is_billable) return false;
      if (d.flags.indexOf('reimbursable') >= 0 && !r.reimbursable) return false;
    }
    if (d.uploaded_by) { if (String(r.entered_by) !== String(d.uploaded_by)) return false; }
    var nr = window.p86FilterDrawer.resolveNumRange(d.amount);
    if (nr.min != null || nr.max != null) { var amt = Number(r.amount || 0); if (nr.min != null && amt < nr.min) return false; if (nr.max != null && amt > nr.max) return false; }
    return true;
  }
  function openFilterDrawer() {
    var fields = ciFilterFields();
    window.p86FilterDrawer.open({
      title: 'Filter',
      fields: fields,
      values: _drawer || window.p86FilterDrawer.emptyValues(fields),
      onApply: function (v) { _drawer = v; updateFilterUI(); renderList(); },
      onClear: function () { _drawer = null; updateFilterUI(); renderList(); }
    });
  }
  // "Filter (N)" badge + removable active-filter chips above the list.
  function updateFilterUI() {
    var fields = ciFilterFields();
    var dn = _drawer ? window.p86FilterDrawer.countActive(fields, _drawer) : 0;
    var total = dn + (_pinnedEntity ? 1 : 0);
    var btn = document.getElementById('ciFilterBtn');
    if (btn) { btn.classList.toggle('pf-on', total > 0); btn.innerHTML = ciIcon('funnel') + (total ? ' <strong>(' + total + ')</strong>' : ''); }
    var af = document.getElementById('ciActiveFilters');
    if (!af) return;
    if (!total) { af.innerHTML = ''; return; }
    function summary(f) {
      var v = _drawer[f.key];
      if (f.type === 'chips') { return v.map(function (x) { var o = (f.options || []).find(function (o) { return o.v === x; }); return o ? o.label : x; }).join(', '); }
      if (f.type === 'select') { var o = (f.options || []).find(function (o) { return String(o.v) === String(v); }); return o ? o.label : v; }
      if (f.type === 'daterange') { var r = window.p86FilterDrawer.resolveDateRange(v); return (r.from || '…') + ' → ' + (r.to || '…'); }
      if (f.type === 'numrange') { var r2 = window.p86FilterDrawer.resolveNumRange(v); return (r2.min != null ? ('$' + r2.min) : '$0') + ' → ' + (r2.max != null ? ('$' + r2.max) : '∞'); }
      return String(v);
    }
    var chips = [];
    if (_pinnedEntity) {
      chips.push('<span class="ci-fchip">Linked: ' + esc(entityLabel(_pinnedEntity.type, _pinnedEntity.id) || (_pinnedEntity.type + ' ' + _pinnedEntity.id)) + ' <button type="button" data-clr="__pin__" aria-label="remove">&times;</button></span>');
    }
    fields.filter(function (f) { return _drawer && window.p86FilterDrawer.countActive([f], _drawer); }).forEach(function (f) {
      chips.push('<span class="ci-fchip">' + esc(f.label) + ': ' + esc(summary(f)) + ' <button type="button" data-clr="' + esc(f.key) + '" aria-label="remove">&times;</button></span>');
    });
    af.innerHTML = chips.join('');
    af.querySelectorAll('button[data-clr]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-clr');
        if (k === '__pin__') { _pinnedEntity = null; }
        else {
          var f = fields.find(function (x) { return x.key === k; });
          if (_drawer && f) { _drawer[k] = window.p86FilterDrawer.emptyValues([f])[k]; }
          if (_drawer && !window.p86FilterDrawer.countActive(fields, _drawer)) _drawer = null;
        }
        updateFilterUI(); renderList();
      });
    });
  }

  // "OCR accuracy" line — the model's hit-rate per field, so John can watch it
  // improve as more receipts get captured/corrected (the learning loop).
  function renderOcrStat() {
    var el = document.getElementById('ciOcrStat');
    if (!el || !window.p86Api || !window.p86Api.receipts || !window.p86Api.receipts.ocrStats) return;
    window.p86Api.receipts.ocrStats().then(function (r) {
      var s = r && r.stats;
      if (!s || !s.samples) { el.textContent = ''; return; }
      var parts = [];
      [['amount', 'Amount'], ['vendor', 'Vendor'], ['date', 'Date'], ['cost_code', 'Cost type']].forEach(function (f) {
        var d = s[f[0]];
        if (d && d.rate != null) parts.push(f[1] + ' ' + d.rate + '%');
      });
      el.textContent = parts.length ? ('OCR accuracy · ' + parts.join(' · ') + '  (' + s.samples + ' scanned)') : '';
    }).catch(function () { el.textContent = ''; });
  }

  // ── Columns + Saved Views (Slice 2) ────────────────────────────────
  function closePopover() {
    var p = document.getElementById('ciPop');
    if (p) { if (p._outside) document.removeEventListener('mousedown', p._outside); p.remove(); }
  }
  function openPopover(anchor, html, onWire) {
    closePopover();
    var pop = document.createElement('div');
    pop.className = 'ci-pop'; pop.id = 'ciPop'; pop.innerHTML = html;
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12)) + 'px';
    if (onWire) onWire(pop);
    function outside(e) { if (!pop.contains(e.target) && e.target !== anchor) closePopover(); }
    pop._outside = outside;
    setTimeout(function () { document.addEventListener('mousedown', outside); }, 0);
  }
  // Column chooser, rendered INSIDE the Views menu ("Manage views"). Toggling a
  // column is ad-hoc (clears the active saved view) + persists per-user.
  function columnsSectionHtml() {
    var keys = _cols || DEFAULT_COLS;
    return '<div class="ci-pop-head">Columns shown</div>' +
      CI_COLS.map(function (c) {
        var on = keys.indexOf(c.key) >= 0;
        return '<label class="ci-pop-row"><input type="checkbox" data-col="' + esc(c.key) + '"' + (on ? ' checked' : '') + ' /> ' + esc(CI_COL_LABEL[c.key] || c.key) + '</label>';
      }).join('');
  }
  function wireColumnsSection(pop) {
    pop.querySelectorAll('input[data-col]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var set = allColKeys().filter(function (k) { var el = pop.querySelector('input[data-col="' + k + '"]'); return el && el.checked; });
        if (!set.length) { cb.checked = true; return; } // never hide every column
        _cols = set; _activeViewId = null; persistCols(); updateViewsBtn(); renderList();
      });
    });
    var rb = pop.querySelector('#ciColsReset');
    if (rb) rb.addEventListener('click', function () { _cols = DEFAULT_COLS.slice(); _activeViewId = null; persistCols(); closePopover(); updateViewsBtn(); renderList(); });
  }
  function loadViews() {
    if (!(window.p86Api && window.p86Api.listViews)) return Promise.resolve();
    return window.p86Api.listViews.list('cost_inbox').then(function (r) { _views = (r && r.views) || []; }).catch(function () { _views = []; });
  }
  function applyDefaultView() { var def = _views.find(function (v) { return v.is_default; }); if (def) applyView(def, true); }
  function applyView(v, silent) {
    _activeViewId = v.id;
    var cfg = v.config || {};
    _cols = (Array.isArray(cfg.columns) && cfg.columns.length) ? cfg.columns.slice() : allColKeys();
    _drawer = (cfg.filters && Object.keys(cfg.filters).length) ? cfg.filters : null;
    persistCols();
    if (!silent) { updateFilterUI(); updateViewsBtn(); renderList(); }
  }
  function updateViewsBtn() {
    var btn = document.getElementById('ciViewsBtn');
    if (!btn) return;
    var v = _views.find(function (x) { return x.id === _activeViewId; });
    btn.innerHTML = (v ? esc(v.name) : 'Views') + ' ▾';
    btn.classList.toggle('pf-on', !!v);
  }
  function openViewsMenu(anchor) {
    var rows = _views.length ? _views.map(function (v) {
      return '<div class="ci-pop-row ci-pop-view' + (v.id === _activeViewId ? ' on' : '') + '" data-view="' + esc(v.id) + '">' +
        '<span class="ci-pop-vname">' + (v.id === _activeViewId ? '✓ ' : '') + esc(v.name) + (v.is_default ? ' <em>· default</em>' : '') + '</span>' +
        '<span class="ci-pop-vacts"><button type="button" title="Set as default" data-def="' + esc(v.id) + '">★</button>' +
        '<button type="button" title="Delete" data-del="' + esc(v.id) + '">🗑</button></span></div>';
    }).join('') : '<div class="ci-pop-empty">No saved views yet.</div>';
    var html = '<div class="ci-pop-head">Your saved views</div>' + rows +
      '<div class="ci-pop-foot"><button type="button" class="ci-btn ci-btn-primary" id="ciSaveView">＋ Save current as view…</button></div>' +
      '<div class="ci-pop-divide"></div>' +
      columnsSectionHtml() +
      '<div class="ci-pop-foot"><button type="button" class="ci-btn" id="ciColsReset">Reset columns</button></div>';
    openPopover(anchor, html, function (pop) {
      wireColumnsSection(pop);
      pop.querySelectorAll('.ci-pop-view').forEach(function (row) {
        row.addEventListener('click', function (e) {
          if (e.target.closest('button')) return;
          var v = _views.find(function (x) { return x.id === row.getAttribute('data-view'); });
          if (v) { closePopover(); applyView(v); }
        });
      });
      pop.querySelectorAll('button[data-def]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation(); var id = b.getAttribute('data-def');
          window.p86Api.listViews.update(id, { is_default: true }).then(loadViews).then(function () { closePopover(); updateViewsBtn(); toast('Default view set', 'success'); });
        });
      });
      pop.querySelectorAll('button[data-del]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation(); var id = b.getAttribute('data-del');
          if (!confirm('Delete this saved view?')) return;
          window.p86Api.listViews.remove(id).then(function () { if (_activeViewId === id) _activeViewId = null; return loadViews(); }).then(function () { closePopover(); updateViewsBtn(); });
        });
      });
      var sv = pop.querySelector('#ciSaveView');
      if (sv) sv.addEventListener('click', function () {
        var name = window.prompt('Name this view (saves the current columns + filters):', '');
        if (name == null) return; name = String(name).trim(); if (!name) return;
        window.p86Api.listViews.create({ page: 'cost_inbox', name: name, config: { columns: _cols || allColKeys(), filters: _drawer || {} }, is_default: false })
          .then(function (r) { _activeViewId = (r && r.view && r.view.id) || null; return loadViews(); })
          .then(function () { closePopover(); updateViewsBtn(); toast('View saved', 'success'); })
          .catch(function (e) { toast('Could not save view: ' + (e && e.message || 'error'), 'error'); });
      });
    });
  }

  function render(host) {
    if (!host) return;
    // A deep-link pin (openFor) survives exactly one render; a normal open clears it.
    if (_pinArmed) { _pinArmed = false; } else { _pinnedEntity = null; }
    host.innerHTML =
      '<div class="ci-wrap">' +
        '<div class="ci-head">' +
          '<div><div class="ci-title">Cost Inbox</div><div class="ci-ocr-stat" id="ciOcrStat"></div></div>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<button class="ci-btn ci-iconbtn" id="ciExport" type="button" title="Export to Excel" aria-label="Export to Excel">' + ciIcon('exports') + '</button>' +
            '<button class="ci-btn ci-btn-primary" id="ciNew">+ New Receipt</button>' +
          '</div>' +
        '</div>' +
        '<div class="ci-toolbar">' +
          '<button class="ci-btn ci-iconbtn" id="ciFilterBtn" type="button" title="Filter" aria-label="Filter">' + ciIcon('funnel') + '</button>' +
          '<button class="ci-btn" id="ciViewsBtn" type="button">Views ▾</button>' +
          '<input type="text" id="ciSearch" class="ci-input ci-search" placeholder="Search vendor, amount, notes, ID…" />' +
          '<div class="ci-total" id="ciTotal"></div>' +
          '<span class="ci-selinfo" id="ciSelInfo"></span>' +
        '</div>' +
        '<div class="ci-activefilters" id="ciActiveFilters"></div>' +
        '<div class="ci-list" id="ciList"><div class="ci-empty">Loading…</div></div>' +
      '</div>';

    document.getElementById('ciNew').addEventListener('click', function () { openReceiptModal(null); });
    var expBtn = document.getElementById('ciExport');
    if (expBtn) expBtn.addEventListener('click', function () { exportToExcel(currentExportRows()); });
    var filterBtn = document.getElementById('ciFilterBtn');
    if (filterBtn) filterBtn.addEventListener('click', openFilterDrawer);
    var viewsBtn = document.getElementById('ciViewsBtn');
    if (viewsBtn) viewsBtn.addEventListener('click', function () { openViewsMenu(viewsBtn); });
    renderOcrStat();
    var sEl = document.getElementById('ciSearch');
    sEl.addEventListener('input', function () { _filters.q = sEl.value || ''; renderList(); });

    restoreCols();
    loadEntities()
      .then(function () { return loadViews(); })
      .then(function () { applyDefaultView(); updateFilterUI(); updateViewsBtn(); reload(); });
  }

  function reload() {
    var listEl = document.getElementById('ciList');
    if (!window.p86Api || !window.p86Api.receipts) { if (listEl) listEl.innerHTML = '<div class="ci-empty">Not connected.</div>'; return; }
    // Load the full set (incl. void, up to 500); the filter drawer narrows it
    // client-side — status/void is just one of the drawer's filters now.
    window.p86Api.receipts.list({ limit: 500, status: 'all' }).then(function (r) {
      _receipts = (r && r.receipts) || [];
      updateFilterUI(); // refresh uploader options in the drawer spec
      renderList();
    }).catch(function () {
      if (listEl) listEl.innerHTML = '<div class="ci-empty">Could not load receipts.</div>';
    });
  }

  function renderList() {
    var listEl = document.getElementById('ciList');
    if (!listEl) return;
    var q = (_filters.q || '').trim().toLowerCase();
    var rows = _receipts.filter(function (r) {
      if (!matchesDrawer(r)) return false;
      if (q) {
        var hay = [(r.vendor || ''), (r.ref || ''), (r.notes || ''), String(r.amount || ''), entityLabel(r.entity_type, r.entity_id)].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    _visibleRows = rows;
    // running total of the visible (non-void) set
    var total = rows.reduce(function (s, r) { return s + (r.status === 'void' ? 0 : Number(r.amount || 0)); }, 0);
    var totEl = document.getElementById('ciTotal');
    if (totEl) totEl.textContent = rows.length + ' receipt' + (rows.length === 1 ? '' : 's') + ' · ' + money(total);

    if (!rows.length) { listEl.className = 'ci-list'; listEl.innerHTML = '<div class="ci-empty">No receipts yet. Tap <strong>+ New Receipt</strong> to capture one.</div>'; return; }

    renderTableView(listEl, rows);
  }

  // Default ordering: Unprocessed first, then newest by date.
  function defaultSort(rows) {
    rows.sort(function (a, b) {
      var au = a.status === 'unprocessed' ? 0 : 1, bu = b.status === 'unprocessed' ? 0 : 1;
      if (au !== bu) return au - bu;
      return String(b.purchased_at || b.created_at).localeCompare(String(a.purchased_at || a.created_at));
    });
    return rows;
  }
  function ciCodeLabel(r) { return r.is_presale ? 'Pre-sale' : (CODE_LABEL[r.cost_code] || r.cost_code || ''); }
  // Clicking a row opens the read-only viewer (NOT straight to edit).
  function wireRowOpen(listEl) {
    listEl.querySelectorAll('tr[data-id]').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('.ci-td-check')) return; // checkbox cell — never opens the viewer
        var rec = _receipts.find(function (x) { return String(x.id) === String(row.getAttribute('data-id')); });
        if (rec) openReceiptViewer(rec);
      });
    });
  }

  var THUMB_PH = '<span class="ci-thumb-ph"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/></svg></span>';

  // Plain full-screen view of the ORIGINAL uploaded image — just the photo, no
  // tags / description / comments editor. Click anywhere or Esc to close.
  function openImageOverlay(url) {
    if (!url) return;
    var ov = document.createElement('div');
    ov.className = 'ci-img-overlay';
    ov.innerHTML = '<img src="' + esc(url) + '" alt="receipt" /><button type="button" class="ci-img-close" aria-label="Close">&times;</button>';
    function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
  }

  // Column/row table view (like Leads / Jobs): photo · vendor · amount · cost
  // type · linked job/lead · date · uploaded-by · status. Sortable headers.
  var CI_COLS = [
    { key: 'photo', label: '', sort: false },
    { key: 'vendor', label: 'Vendor', sort: true },
    { key: 'amount', label: 'Amount', sort: true, num: true },
    { key: 'cost', label: 'Cost type', sort: true },
    { key: 'linked', label: 'Linked to', sort: true },
    { key: 'sub', label: 'Sub/Vendor', sort: true },
    { key: 'tags', label: 'Tags', sort: false },
    { key: 'payment', label: 'Payment', sort: true },
    { key: 'billable', label: 'Billable', sort: true },
    { key: 'invoice', label: 'Invoice #', sort: true },
    { key: 'date', label: 'Purchased', sort: true },
    { key: 'uploaded', label: 'Uploaded by', sort: true },
    { key: 'uploaded_at', label: 'Uploaded', sort: true },
    { key: 'status', label: 'Status', sort: true }
  ];
  // "Standard" default = EVERY column visible; the user hides what they don't
  // want via Views ▾ → Columns (and can drag headers to reorder). Derived from
  // CI_COLS so a newly-added column is shown by default automatically.
  var DEFAULT_COLS = CI_COLS.map(function (c) { return c.key; });
  function ciSortVal(r, key) {
    switch (key) {
      case 'vendor': return (r.vendor || '').toLowerCase();
      case 'amount': return Number(r.amount || 0);
      case 'cost': return ciCodeLabel(r).toLowerCase();
      case 'linked': return entityLabel(r.entity_type, r.entity_id).toLowerCase();
      case 'sub': return (r.sub_name || '').toLowerCase();
      case 'payment': return (PAY_LABEL[r.payment_method] || '').toLowerCase();
      case 'billable': return r.is_billable ? 1 : 0;
      case 'invoice': return (r.invoice_no || '').toLowerCase();
      case 'date': return String(r.purchased_at || r.created_at || '');
      case 'uploaded': return (r.entered_by_name || '').toLowerCase();
      case 'uploaded_at': return String(r.created_at || '');
      case 'status': return (r.status || '');
      default: return '';
    }
  }
  // Render one <td> for a given column key (used so columns can be hidden/shown).
  function cellFor(r, key) {
    if (key === 'photo') { var thumb = r.image_thumb_url || r.image_url; return '<td class="ci-td-photo"><span class="ci-thumb ci-thumb-sm">' + (thumb ? '<img src="' + esc(thumb) + '" alt="" loading="lazy" />' : THUMB_PH) + '</span></td>'; }
    if (key === 'vendor') return '<td class="ci-td-vendor">' + esc(r.vendor || '(no vendor)') + '</td>';
    if (key === 'amount') { var amt = (r.amount != null && Number(r.amount) > 0) ? money(r.amount) : '<span class="ci-need">—</span>'; return '<td class="num">' + amt + '</td>'; }
    if (key === 'cost') return '<td>' + esc(ciCodeLabel(r)) + '</td>';
    if (key === 'linked') { var ent = entityLabel(r.entity_type, r.entity_id); return '<td>' + (ent ? esc(ent) : '<span class="ci-chip-warn" style="font-size:11px;">no job</span>') + '</td>'; }
    if (key === 'sub') return '<td>' + esc(r.sub_name || '—') + '</td>';
    if (key === 'tags') { var tg = (r.tags || []); return '<td>' + (tg.length ? tg.map(function (t) { return '<span class="ci-tagchip">' + esc(t) + '</span>'; }).join(' ') : '—') + '</td>'; }
    if (key === 'payment') return '<td>' + esc(PAY_LABEL[r.payment_method] || '—') + (r.reimbursable ? ' <span class="ci-tagchip">reimb.</span>' : '') + '</td>';
    if (key === 'billable') return '<td>' + (r.is_billable ? '<span class="ci-tagchip ci-tagchip-bill">Billable</span>' : '—') + '</td>';
    if (key === 'invoice') return '<td>' + esc(r.invoice_no || '—') + '</td>';
    if (key === 'date') return '<td>' + esc(fmtDate(r.purchased_at || r.created_at)) + '</td>';
    if (key === 'uploaded') return '<td>' + esc(r.entered_by_name || (r.entered_by ? ('User ' + r.entered_by) : '—')) + '</td>';
    if (key === 'uploaded_at') return '<td>' + esc(fmtDateTime(r.created_at)) + '</td>';
    if (key === 'status') return '<td><span class="ci-badge ci-badge-' + (r.status || 'unprocessed') + '">' + esc(r.status || 'unprocessed') + '</span></td>';
    return '<td></td>';
  }
  function renderTableView(listEl, rows) {
    if (_tsort.key) {
      var dir = _tsort.dir === 'asc' ? 1 : -1;
      rows.sort(function (a, b) {
        var av = ciSortVal(a, _tsort.key), bv = ciSortVal(b, _tsort.key);
        if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0;
      });
    } else { defaultSort(rows); }
    listEl.className = '';
    var cols = visibleCols();
    var thead = '<thead><tr>' +
      '<th class="ci-th-check"><input type="checkbox" id="ciSelAll" title="Select all" /></th>' +
      cols.map(function (c) {
        var dc = ' data-col="' + c.key + '"';
        if (c.key === 'photo') return '<th class="ci-th-photo"' + dc + '></th>';
        // Non-sortable columns (e.g. Tags) still show their label.
        if (!c.sort) return '<th' + dc + '>' + esc(c.label) + '</th>';
        var sc = (_tsort.key === c.key) ? (' sortable sort-' + (_tsort.dir === 'asc' ? 'asc' : 'desc')) : ' sortable';
        return '<th class="' + (c.num ? 'num' : '') + sc + '"' + dc + ' data-sort="' + c.key + '">' + esc(c.label) + '</th>';
      }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (r) {
      return '<tr class="ci-trow" data-id="' + esc(r.id) + '">' +
        '<td class="ci-td-check"><input type="checkbox" class="ci-rowcheck" data-id="' + esc(r.id) + '"' + (_selected[r.id] ? ' checked' : '') + ' /></td>' +
        // Tag each cell with data-col so p86Tables can reorder/resize columns.
        cols.map(function (c) { return cellFor(r, c.key).replace('<td', '<td data-col="' + c.key + '"'); }).join('') +
      '</tr>';
    }).join('') + '</tbody>';
    listEl.innerHTML = '<div class="p86-tbl-scroll"><table class="dense-table ci-table" id="ciTable">' + thead + tbody + '</table></div>';
    listEl.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sort');
        if (_tsort.key === k) { _tsort.dir = (_tsort.dir === 'asc') ? 'desc' : 'asc'; }
        else { _tsort.key = k; _tsort.dir = (k === 'amount' || k === 'date') ? 'desc' : 'asc'; }
        renderList();
      });
    });
    // Per-row select. stopPropagation so checking a box never opens the viewer.
    listEl.querySelectorAll('.ci-rowcheck').forEach(function (cb) {
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () {
        var id = cb.getAttribute('data-id');
        if (cb.checked) _selected[id] = true; else delete _selected[id];
        syncSelAll(); updateSelInfo();
      });
    });
    // Master "select all" = all CURRENTLY VISIBLE rows (respects job/user/search
    // filters), so "select all for this job" / "for this user" = filter then tick.
    var selAll = document.getElementById('ciSelAll');
    if (selAll) {
      selAll.addEventListener('change', function () {
        _visibleRows.forEach(function (r) { if (selAll.checked) _selected[r.id] = true; else delete _selected[r.id]; });
        renderTableView(listEl, _visibleRows); // re-render to reflect every checkbox
      });
    }
    syncSelAll(); updateSelInfo();
    wireRowOpen(listEl);
    // Drag-to-reorder + resize columns (shared with Jobs/Leads/Estimates). Runs
    // after every render; idempotent — re-applies the user's saved order/widths.
    if (window.p86Tables && window.p86Tables.enhance) { try { window.p86Tables.enhance('costinbox'); } catch (e) {} }
  }

  // Reflect how many visible rows are selected in the master checkbox (checked /
  // unchecked / indeterminate).
  function syncSelAll() {
    var selAll = document.getElementById('ciSelAll');
    if (!selAll) return;
    var vis = _visibleRows.length;
    var sel = _visibleRows.reduce(function (n, r) { return n + (_selected[r.id] ? 1 : 0); }, 0);
    selAll.checked = vis > 0 && sel === vis;
    selAll.indeterminate = sel > 0 && sel < vis;
  }

  // Selection-count chip + a Clear link in the toolbar; tells the Export button
  // whether it'll send the selection or the whole filtered view.
  function updateSelInfo() {
    var el = document.getElementById('ciSelInfo');
    if (!el) return;
    var n = Object.keys(_selected).length;
    if (!n) { el.innerHTML = ''; return; }
    el.innerHTML = '<strong>' + n + '</strong> selected · <a href="#" id="ciSelClear">clear</a>';
    var clr = document.getElementById('ciSelClear');
    if (clr) clr.addEventListener('click', function (e) { e.preventDefault(); _selected = {}; renderList(); });
  }

  // Rows the Export should write: the explicit selection (across the loaded set)
  // if any boxes are ticked, otherwise everything in the current filtered view.
  function currentExportRows() {
    var ids = Object.keys(_selected);
    if (ids.length) return _receipts.filter(function (r) { return _selected[r.id]; });
    return _visibleRows.slice();
  }

  // SheetJS loads lazily from CDN (same as job-costs-import / leads import).
  function ensureXLSX() {
    return new Promise(function (resolve, reject) {
      if (typeof XLSX !== 'undefined') return resolve(window.XLSX);
      var existing = document.getElementById('p86-xlsx-cdn');
      if (existing) {
        existing.addEventListener('load', function () { resolve(window.XLSX); });
        existing.addEventListener('error', function () { reject(new Error('Could not load the Excel library.')); });
        return;
      }
      var s = document.createElement('script');
      s.id = 'p86-xlsx-cdn';
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { reject(new Error('Could not load the Excel library.')); };
      document.head.appendChild(s);
    });
  }

  // Export the given receipts to a real .xlsx (Amount as a number so Excel sums;
  // a TOTAL row at the bottom). Exports the selection, else the filtered view.
  function exportToExcel(rows) {
    if (!rows || !rows.length) { toast('Nothing to export — select rows or adjust the filters.', 'error'); return; }
    var btn = document.getElementById('ciExport');
    if (btn) { btn.disabled = true; }
    ensureXLSX().then(function (XLSX) {
      var header = ['Purchased', 'Vendor', 'Sub/Vendor', 'Amount', 'Cost type', 'Linked to', 'Link type', 'Tags', 'Payment', 'Reimbursable', 'Reimburse to', 'Billable', 'Invoice #', 'Uploaded by', 'Uploaded', 'Status', 'Receipt ID', 'Notes'];
      var aoa = [header];
      rows.forEach(function (r) {
        aoa.push([
          String(r.purchased_at || r.created_at || '').slice(0, 10),
          r.vendor || '',
          r.sub_name || '',
          (r.amount != null ? Number(r.amount) : ''),
          (r.entity_type === 'category') ? '' : ciCodeLabel(r),
          entityLabel(r.entity_type, r.entity_id) || '',
          r.entity_type || 'unlinked',
          (r.tags || []).join(', '),
          PAY_LABEL[r.payment_method] || '',
          r.reimbursable ? 'Yes' : '',
          r.reimburse_to || '',
          r.is_billable ? 'Yes' : '',
          r.invoice_no || '',
          r.entered_by_name || (r.entered_by ? ('User ' + r.entered_by) : ''),
          r.created_at ? fmtDateTime(r.created_at) : '',
          r.status || '',
          r.ref || '',
          r.notes || ''
        ]);
      });
      var total = rows.reduce(function (s, r) { return s + (r.status === 'void' ? 0 : Number(r.amount || 0)); }, 0);
      aoa.push([]); aoa.push(['', '', 'TOTAL', total]);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 13 }, { wch: 26 }, { wch: 10 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 9 }, { wch: 13 }, { wch: 16 }, { wch: 20 }, { wch: 11 }, { wch: 12 }, { wch: 36 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Cost Inbox');
      var stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, 'Cost_Inbox_' + stamp + '.xlsx');
      if (btn) { btn.disabled = false; }
      toast('Exported ' + rows.length + ' receipt' + (rows.length === 1 ? '' : 's') + '.', 'success');
    }).catch(function (e) {
      if (btn) { btn.disabled = false; }
      toast('Export failed: ' + (e && e.message || 'error'), 'error');
    });
  }

  // ── Read-only viewer (with an Edit gate) ──────────────────────────
  // Clicking a receipt opens THIS (not the edit form). A robust detail card +
  // large photo; Edit re-opens the existing capture/edit form, Void/Restore work
  // here too so a quick void doesn't require entering edit mode.
  function viewRow(label, value, opts) {
    opts = opts || {};
    var v = (value == null || value === '') ? '<span class="ci-view-empty">—</span>' : (opts.raw ? value : esc(value));
    return '<div class="ci-view-row' + (opts.cls ? ' ' + opts.cls : '') + '">' +
      '<span class="ci-view-k">' + esc(label) + '</span>' +
      '<span class="ci-view-v">' + v + '</span>' +
    '</div>';
  }

  function openReceiptViewer(receipt) {
    var r = receipt || {};
    if (!r.id) { openReceiptModal(r); return; } // brand-new capture → straight to the form
    var fullImg = r.image_url || r.image_thumb_url;
    var ent = entityLabel(r.entity_type, r.entity_id);
    var amtBig = (r.amount != null && Number(r.amount) > 0) ? money(r.amount) : '— no amount';
    var statusCls = 'ci-badge ci-badge-' + (r.status || 'unprocessed');
    var isVoid = r.status === 'void';

    var modal = document.createElement('div');
    modal.className = 'ci-modal';
    modal.innerHTML =
      '<div class="ci-modal-card ci-view-card">' +
        '<div class="ci-modal-head">' +
          '<span>Receipt' + (r.ref ? ' · ' + esc(r.ref) : '') + '</span>' +
          '<div class="ci-modal-actions">' +
            (isVoid ? '<button class="ci-btn" id="ciVRestore">Restore</button>'
                    : '<button class="ci-btn ci-btn-danger" id="ciVVoid">Void</button>') +
            '<button class="ci-btn" id="ciVClose">Close</button>' +
            '<button class="ci-btn ci-btn-primary" id="ciVEdit">Edit</button>' +
          '</div>' +
        '</div>' +
        '<div class="ci-modal-body">' +
          '<div class="ci-view-hero">' +
            '<div class="ci-view-photo" id="ciVPhoto">' +
              (fullImg
                ? '<img src="' + esc(fullImg) + '" alt="receipt" /><span class="ci-view-zoom">Click to enlarge</span>'
                : '<div class="ci-view-nophoto">' + THUMB_PH + '<div>No photo</div></div>') +
            '</div>' +
            '<div class="ci-view-heroside">' +
              '<div class="ci-view-amt">' + esc(amtBig) + '</div>' +
              '<div><span class="' + statusCls + '">' + esc(r.status || 'unprocessed') + '</span></div>' +
              '<div class="ci-view-vendor">' + esc(r.vendor || '(no vendor)') + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="ci-view-grid">' +
            viewRow('Cost type', r.is_presale ? 'Pre-sale' : ciCodeLabel(r)) +
            viewRow('Linked to', ent ? ent : '<span class="ci-chip-warn" style="font-size:12px;">No job — cost not flowing</span>', { raw: !ent }) +
            viewRow('Purchased', fmtDate(r.purchased_at) || null) +
            viewRow('Sub / Vendor', r.sub_name || null) +
            viewRow('Payment', PAY_LABEL[r.payment_method] || null) +
            viewRow('Reimbursable', r.reimbursable ? ('Yes' + (r.reimburse_to ? (' → ' + r.reimburse_to) : '')) : null) +
            viewRow('Billable', r.is_billable ? 'Billable to client' : null) +
            viewRow('Invoice #', r.invoice_no || null) +
            viewRow('Uploaded by', r.entered_by_name || (r.entered_by ? ('User ' + r.entered_by) : null)) +
            viewRow('Uploaded', fmtDateTime(r.created_at) || null) +
            (r.updated_at && r.updated_at !== r.created_at ? viewRow('Last updated', fmtDateTime(r.updated_at)) : '') +
            viewRow('Receipt ID', r.ref || null) +
          '</div>' +
          ((r.tags && r.tags.length) ? '<div class="ci-view-notes"><div class="ci-view-k">Tags</div><div>' + r.tags.map(function (t) { return '<span class="ci-tagchip">' + esc(t) + '</span>'; }).join(' ') + '</div></div>' : '') +
          (r.notes ? '<div class="ci-view-notes"><div class="ci-view-k">Notes</div><div>' + esc(r.notes) + '</div></div>' : '') +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    function close() { modal.remove(); }
    modal.querySelector('#ciVClose').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

    // Edit gate → hand off to the existing capture/edit form.
    modal.querySelector('#ciVEdit').addEventListener('click', function () { close(); openReceiptModal(r); });

    // Photo → plain full-screen view of the ORIGINAL uploaded image. No tag /
    // description / comments editor — just the picture.
    if (fullImg) {
      var photoEl = modal.querySelector('#ciVPhoto');
      if (photoEl) photoEl.addEventListener('click', function () {
        openImageOverlay(r.image_url || fullImg);
      });
    }

    // Void / Restore inline (no need to enter edit mode).
    var voidBtn = modal.querySelector('#ciVVoid');
    if (voidBtn) voidBtn.addEventListener('click', function () {
      if (!window.confirm('Void this receipt?')) return;
      window.p86Api.receipts.remove(r.id).then(function () { toast('Receipt voided', 'success'); close(); reload(); })
        .catch(function () { toast('Could not void', 'error'); });
    });
    var vRestore = modal.querySelector('#ciVRestore');
    if (vRestore) vRestore.addEventListener('click', function () {
      window.p86Api.receipts.update(r.id, { status: 'unprocessed' }).then(function () { toast('Receipt restored', 'success'); close(); reload(); })
        .catch(function () { toast('Could not restore', 'error'); });
    });
  }

  // ── Capture / edit form (camera-first) ────────────────────────────
  var _pendingFile = null; // a freshly-picked photo File, uploaded on save

  function openReceiptModal(receipt) {
    _pendingFile = null;
    var isEdit = !!(receipt && receipt.id);
    var r = receipt || {};
    var linkType = r.entity_type || 'job';
    loadEntities().then(function () {
      var existingThumb = r.image_thumb_url || r.image_url;
      var modal = document.createElement('div');
      modal.className = 'ci-modal';
      modal.innerHTML =
        '<div class="ci-modal-card">' +
          '<div class="ci-modal-head">' +
            '<span>' + (isEdit ? 'Edit Receipt' : 'New Receipt') + '</span>' +
            '<div class="ci-modal-actions">' +
              (isEdit && r.status === 'void' ? '<button class="ci-btn" id="ciRestore">Restore</button>' : '') +
              (isEdit && r.status !== 'void' ? '<button class="ci-btn ci-btn-danger" id="ciDel">Void</button>' : '') +
              '<button class="ci-btn" id="ciCancel">Cancel</button>' +
              '<button class="ci-btn ci-btn-primary" id="ciSave">Save</button>' +
            '</div>' +
          '</div>' +
          '<div class="ci-modal-body">' +
            // Photo (camera-first)
            '<label class="ci-photo" id="ciPhotoTile">' +
              '<input type="file" accept="image/*" capture="environment" id="ciPhotoInput" hidden />' +
              '<div class="ci-photo-inner" id="ciPhotoInner">' +
                (existingThumb ? '<img src="' + esc(existingThumb) + '" alt="receipt" />' : '<span class="ci-photo-cta"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><br/>Take / upload receipt</span>') +
              '</div>' +
            '</label>' +
            // Link to job / lead / category
            '<div class="ci-field">' +
              '<label>Link to</label>' +
              '<div class="ci-link-row">' +
                '<select id="ciLinkType" class="ci-input">' +
                  '<option value="job"' + (linkType === 'job' ? ' selected' : '') + '>Job</option>' +
                  '<option value="lead"' + (linkType === 'lead' ? ' selected' : '') + '>Lead (pre-sale)</option>' +
                  '<option value="category"' + (linkType === 'category' ? ' selected' : '') + '>Tools</option>' +
                '</select>' +
                '<input type="text" id="ciLinkSearch" class="ci-input" placeholder="Search…" autocomplete="off" />' +
              '</div>' +
              '<select id="ciLinkId" class="ci-input" style="width:100%;margin-top:6px;"></select>' +
            '</div>' +
            // Amount
            '<div class="ci-field">' +
              '<label>Amount</label>' +
              '<input type="number" inputmode="decimal" step="0.01" min="0" id="ciAmount" class="ci-input" placeholder="0.00" value="' + (r.amount != null ? esc(r.amount) : '') + '" />' +
              '<div class="ci-amt-hint" id="ciAmtHint" style="display:none;">AI-read from the receipt — double-check it.</div>' +
            '</div>' +
            // Cost code (hidden when lead → pre-sale)
            '<div class="ci-field" id="ciCodeField">' +
              '<label>Cost type</label>' +
              '<div class="ci-seg" id="ciCodeSeg">' +
                COST_CODES.map(function (c) {
                  var active = (r.cost_code || 'materials') === c.v;
                  return '<button type="button" class="ci-seg-btn' + (active ? ' active' : '') + '" data-code="' + c.v + '">' + esc(c.label) + '</button>';
                }).join('') +
              '</div>' +
            '</div>' +
            '<div class="ci-presale-note" id="ciPresaleNote" style="display:none;">Lead receipt — logged as <strong>Pre-sale</strong> cost.</div>' +
            '<div class="ci-presale-note" id="ciCatNote" style="display:none;">Category cost — the category <strong>is</strong> the coding (no cost type needed).</div>' +
            // Vendor + date
            '<div class="ci-field-2">' +
              '<div class="ci-field"><label>Vendor</label><input type="text" id="ciVendor" class="ci-input" placeholder="Sherwin Williams…" value="' + esc(r.vendor || '') + '" /></div>' +
              '<div class="ci-field"><label>Date</label><input type="date" id="ciDate" class="ci-input" value="' + esc((r.purchased_at || '').slice(0, 10)) + '" /></div>' +
            '</div>' +
            // Notes
            '<div class="ci-field"><label>Notes</label><textarea id="ciNotes" class="ci-input" rows="2" placeholder="Optional">' + esc(r.notes || '') + '</textarea></div>' +
            // More details (Slice 3): sub link, tags, payment, reimbursable, billable, invoice
            '<div class="ci-field"><label>Sub / Vendor (from directory)</label>' +
              '<select id="ciSub" class="ci-input"><option value="">— none / free-text vendor above —</option>' +
              _subs.map(function (s) { return '<option value="' + esc(s.id) + '"' + (r.sub_id === s.id ? ' selected' : '') + '>' + esc(s.name || s.id) + (s.trade ? (' · ' + esc(s.trade)) : '') + '</option>'; }).join('') +
              '</select></div>' +
            '<div class="ci-field"><label>Tags</label><input type="text" id="ciTags" class="ci-input" placeholder="comma-separated — e.g. tools, warranty" value="' + esc((r.tags || []).join(', ')) + '" /></div>' +
            '<div class="ci-field-2">' +
              '<div class="ci-field"><label>Payment method</label><select id="ciPay" class="ci-input"><option value="">—</option>' +
                Object.keys(PAY_LABEL).map(function (k) { return '<option value="' + k + '"' + (r.payment_method === k ? ' selected' : '') + '>' + esc(PAY_LABEL[k]) + '</option>'; }).join('') +
              '</select></div>' +
              '<div class="ci-field"><label>Invoice #</label><input type="text" id="ciInvoice" class="ci-input" placeholder="Vendor invoice #" value="' + esc(r.invoice_no || '') + '" /></div>' +
            '</div>' +
            '<div class="ci-field-2">' +
              '<div class="ci-field"><label class="ci-check"><input type="checkbox" id="ciReimb"' + (r.reimbursable ? ' checked' : '') + ' /> Reimbursable</label>' +
                '<input type="text" id="ciReimbTo" class="ci-input" placeholder="Reimburse to (name)" value="' + esc(r.reimburse_to || '') + '" style="margin-top:5px;' + (r.reimbursable ? '' : 'display:none;') + '" /></div>' +
              '<div class="ci-field"><label class="ci-check"><input type="checkbox" id="ciBillable"' + (r.is_billable ? ' checked' : '') + ' /> Billable to client</label></div>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);

      var selType = modal.querySelector('#ciLinkType');
      var selId = modal.querySelector('#ciLinkId');
      var searchEl = modal.querySelector('#ciLinkSearch');
      var codeField = modal.querySelector('#ciCodeField');
      var presaleNote = modal.querySelector('#ciPresaleNote');
      var catNote = modal.querySelector('#ciCatNote');
      var codeSeg = modal.querySelector('#ciCodeSeg');
      var chosenCode = r.cost_code || 'materials';
      var codeUserPicked = isEdit; // true once the user (or an existing record) owns the cost code — OCR won't override
      var ocrSuggestion = null;    // {vendor,date,cost_code,amount} from OCR — sent on save so accuracy is tracked

      function fillEntityOptions(filter) {
        var type = selType.value;
        filter = (filter || '').trim().toLowerCase();
        var list, labelOf, word;
        if (type === 'lead') { list = _leads; labelOf = function (it) { return it.title || ('Lead ' + it.id); }; word = 'lead'; }
        else if (type === 'category') { list = _categories; labelOf = catLabel; word = 'category'; }
        else { list = _jobs; labelOf = jobLabel; word = 'job'; }
        var filtered = filter ? list.filter(function (it) { return labelOf(it).toLowerCase().indexOf(filter) >= 0; }) : list;
        // Categories: no empty placeholder — you always pick one, so default to
        // the first (Tools) so a category receipt "sticks" without a 2nd click.
        var opts = (type === 'category' && filtered.length) ? [] : ['<option value="">— select a ' + word + ' —</option>'];
        filtered.forEach(function (it) { opts.push('<option value="' + esc(it.id) + '">' + esc(labelOf(it)) + '</option>'); });
        if (filter && !filtered.length) opts.push('<option value="" disabled>No ' + word + 's match “' + esc(filter) + '”</option>');
        selId.innerHTML = opts.join('');
        if (r.entity_type === type && r.entity_id) selId.value = r.entity_id;
        else if (type === 'category' && filtered.length) selId.value = filtered[0].id;  // default → Tools
        // Search box only helps the long job/lead lists; categories are few.
        if (searchEl) searchEl.style.display = (type === 'category') ? 'none' : '';
        if (searchEl && type !== 'category') searchEl.placeholder = 'Search ' + word + 's…';
        // lead → pre-sale, category → category IS the coding: both hide cost type.
        var hideCode = (type === 'lead' || type === 'category');
        codeField.style.display = hideCode ? 'none' : '';
        presaleNote.style.display = (type === 'lead') ? '' : 'none';
        if (catNote) catNote.style.display = (type === 'category') ? '' : 'none';
      }
      fillEntityOptions('');
      selType.addEventListener('change', function () { if (searchEl) searchEl.value = ''; fillEntityOptions(''); });
      if (searchEl) searchEl.addEventListener('input', function () { fillEntityOptions(searchEl.value); });

      codeSeg.addEventListener('click', function (e) {
        var btn = e.target.closest('.ci-seg-btn'); if (!btn) return;
        chosenCode = btn.getAttribute('data-code');
        codeUserPicked = true;
        codeSeg.querySelectorAll('.ci-seg-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
      });
      // Reimbursable → reveal "reimburse to" name field.
      var reimbEl = modal.querySelector('#ciReimb'), reimbToEl = modal.querySelector('#ciReimbTo');
      if (reimbEl && reimbToEl) reimbEl.addEventListener('change', function () { reimbToEl.style.display = reimbEl.checked ? '' : 'none'; });

      // photo pick → preview, hold File for upload on save
      var photoInput = modal.querySelector('#ciPhotoInput');
      photoInput.addEventListener('change', function () {
        var f = photoInput.files && photoInput.files[0];
        if (!f) return;
        _pendingFile = f;
        var inner = modal.querySelector('#ciPhotoInner');
        var url = URL.createObjectURL(f);
        inner.innerHTML = '<img src="' + esc(url) + '" alt="receipt" />';
        // OCR autofill — reads the photo and pre-fills vendor + date + a cost-code
        // guess. NEVER the amount (that's the error-prone field — stays manual).
        // Only fills fields the user hasn't already entered.
        if (!window.p86Api || !window.p86Api.receipts || !window.p86Api.receipts.ocr) return;
        var tile = modal.querySelector('#ciPhotoTile');
        var tag = document.createElement('div'); tag.className = 'ci-ocr-status'; tag.textContent = 'Reading receipt…';
        if (tile) tile.appendChild(tag);
        downscaleImage(f, 1400, function (dataUrl) {
          if (!dataUrl) { if (tag.parentNode) tag.remove(); return; }
          window.p86Api.receipts.ocr({ image_base64: dataUrl, media_type: 'image/jpeg' }).then(function (resp) {
            if (!resp || !resp.ok) { if (tag.parentNode) tag.remove(); return; }
            // Fill the error-free fields (only if the user hasn't typed there).
            var vEl = modal.querySelector('#ciVendor'); if (vEl && !vEl.value && resp.vendor) vEl.value = resp.vendor;
            var dEl = modal.querySelector('#ciDate'); if (dEl && !dEl.value && resp.date) dEl.value = resp.date;
            if (resp.cost_code && !codeUserPicked && selType.value === 'job') {
              var cb = codeSeg.querySelector('.ci-seg-btn[data-code="' + resp.cost_code + '"]');
              if (cb) { chosenCode = resp.cost_code; codeSeg.querySelectorAll('.ci-seg-btn').forEach(function (b) { b.classList.toggle('active', b === cb); }); }
            }
            // Amount: now read too, but flagged "AI-read · verify" so the user
            // double-checks the error-prone field. Accuracy is tracked on save.
            var aEl = modal.querySelector('#ciAmount'), aHint = modal.querySelector('#ciAmtHint');
            if (aEl && !aEl.value && resp.amount != null) {
              aEl.value = resp.amount;
              if (aHint) aHint.style.display = '';
              aEl.classList.add('ci-amt-ai');
              aEl.addEventListener('input', function () { if (aHint) aHint.style.display = 'none'; aEl.classList.remove('ci-amt-ai'); }, { once: true });
            }
            // Hold the suggestion so the save can log OCR-vs-final accuracy.
            ocrSuggestion = { vendor: resp.vendor || null, date: resp.date || null, cost_code: resp.cost_code || null, amount: (resp.amount != null ? resp.amount : null) };
            // Scan: AI gave the receipt's corners → crop + flatten + clean it,
            // and make the cleaned image the one we store + show.
            if (resp.corners && window.p86ReceiptScanner && window.p86ReceiptScanner.scanFromCorners) {
              tag.textContent = 'Scanning…';
              window.p86ReceiptScanner.scanFromCorners(f, resp.corners, function (scanned) {
                if (tag.parentNode) tag.remove();
                if (scanned) {
                  var scanFile = dataUrlToFile(scanned);
                  if (scanFile) {
                    _pendingFile = scanFile;
                    var innerEl = modal.querySelector('#ciPhotoInner');
                    if (innerEl) innerEl.innerHTML = '<img src="' + esc(scanned) + '" alt="receipt" />';
                  }
                }
              });
            } else if (tag.parentNode) { tag.remove(); }
          }).catch(function () { if (tag.parentNode) tag.remove(); });
        });
      });

      function close() { modal.remove(); _pendingFile = null; }
      modal.querySelector('#ciCancel').addEventListener('click', close);
      modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

      var delBtn = modal.querySelector('#ciDel');
      if (delBtn) delBtn.addEventListener('click', function () {
        if (!window.confirm('Void this receipt?')) return;
        window.p86Api.receipts.remove(r.id).then(function () { toast('Receipt voided', 'success'); close(); reload(); })
          .catch(function () { toast('Could not void', 'error'); });
      });

      // Soft-void is reversible: Restore re-derives the status from completeness.
      var restoreBtn = modal.querySelector('#ciRestore');
      if (restoreBtn) restoreBtn.addEventListener('click', function () {
        window.p86Api.receipts.update(r.id, { status: 'unprocessed' }).then(function () { toast('Receipt restored', 'success'); close(); reload(); })
          .catch(function () { toast('Could not restore', 'error'); });
      });

      modal.querySelector('#ciSave').addEventListener('click', function () {
        var saveBtn = modal.querySelector('#ciSave');
        saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
        var entityType = selType.value;
        var entityId = selId.value || null;
        var tagsVal = (modal.querySelector('#ciTags').value || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
        var payload = {
          entity_type: entityId ? entityType : null,
          entity_id: entityId,
          amount: modal.querySelector('#ciAmount').value || null,
          cost_code: chosenCode,
          vendor: modal.querySelector('#ciVendor').value || null,
          notes: modal.querySelector('#ciNotes').value || null,
          purchased_at: modal.querySelector('#ciDate').value || null,
          // Slice 3 fields
          sub_id: (modal.querySelector('#ciSub').value || null),
          tags: tagsVal,
          payment_method: (modal.querySelector('#ciPay').value || null),
          reimbursable: modal.querySelector('#ciReimb').checked,
          reimburse_to: (modal.querySelector('#ciReimbTo').value || null),
          is_billable: modal.querySelector('#ciBillable').checked,
          invoice_no: (modal.querySelector('#ciInvoice').value || null),
          ocr: ocrSuggestion || undefined // lets the server log OCR-vs-saved accuracy
        };
        // 1) create or update the receipt
        var save = isEdit
          ? window.p86Api.receipts.update(r.id, payload)
          : window.p86Api.receipts.create(payload);
        var photoFailed = false;
        save.then(function (resp) {
          var saved = (resp && resp.receipt) || resp;
          // 2) if a new photo was picked, upload it (to the linked entity, else
          //    the user's bucket — both valid attachment entity_types) and link.
          if (_pendingFile) {
            // Photos attach to jobs/leads (real attachment buckets); a category
            // isn't an attachment entity, so its receipt photo goes to the user
            // bucket (same as an unlinked capture).
            var canBucket = (entityId && (entityType === 'job' || entityType === 'lead'));
            var bucketType = canBucket ? entityType : 'user';
            var bucketId = canBucket ? entityId : myUserId();
            if (!bucketId) { photoFailed = true; return; }
            return window.p86Api.attachments.upload(bucketType, bucketId, _pendingFile, { geo: false })
              .then(function (ar) {
                var att = (ar && (ar.attachment || ar.attachments && ar.attachments[0])) || ar;
                var attId = att && att.id;
                if (attId) return window.p86Api.receipts.update(saved.id, { attachment_id: attId });
                photoFailed = true; // upload returned no id — receipt saved, photo not linked
              }).catch(function () { photoFailed = true; }); // keep the receipt; warn below
          }
        }).then(function () {
          // The receipt itself saved either way; only the photo step is best-effort.
          if (photoFailed) toast('Receipt saved, but the photo didn’t upload — re-open to retry', 'error');
          else toast('Receipt saved', 'success');
          close();
          reload();
        }).catch(function (e2) {
          saveBtn.disabled = false; saveBtn.textContent = 'Save';
          toast('Could not save: ' + (e2 && e2.message || 'error'), 'error');
        });
      });
    });
  }

  // ── Captured-cost rollup card (embed on a job/lead detail page) ────
  // Reads /api/receipts/rollup and shows COGS by cost code + a Pre-sale line.
  function mountRollup(host, opts) {
    if (!host) return;
    opts = opts || {};
    var et = opts.entityType, eid = opts.entityId;
    var api = window.p86Api;
    if (!et || !eid || !api || !api.receipts || !api.receipts.rollup) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="ci-rollup"><div class="ci-rollup-empty">Loading…</div></div>';
    var link = '<a href="#" class="ci-rollup-link" data-ci-open>View / add receipts →</a>';
    api.receipts.rollup({ entity_type: et, entity_id: eid }).then(function (r) {
      var R = (r && r.rollup) || { by_code: {}, cogs_total: 0, presale_total: 0, grand_total: 0, count: 0 };
      if (!R.count) {
        host.innerHTML = '<div class="ci-rollup"><div class="ci-rollup-head"><span>Captured Costs</span></div>' +
          '<div class="ci-rollup-empty">No receipts captured yet. ' + link + '</div></div>';
      } else {
        var rows = '';
        COST_CODES.forEach(function (c) {
          var b = R.by_code[c.v];
          if (b && b.total) rows += '<div class="ci-rollup-row"><span>' + esc(c.label) + '</span><span>' + money(b.total) + ' <em>(' + b.count + ')</em></span></div>';
        });
        host.innerHTML = '<div class="ci-rollup"><div class="ci-rollup-head"><span>Captured Costs</span>' + link + '</div>' +
          '<div class="ci-rollup-body">' +
            (rows || '<div class="ci-rollup-row ci-rollup-muted"><span>No job-cost receipts yet</span><span></span></div>') +
            '<div class="ci-rollup-row ci-rollup-total"><span>' + (et === 'lead' ? 'Captured (pre-sale)' : 'Job cost (captured)') + '</span><span>' + money(R.cogs_total) + '</span></div>' +
            (R.presale_total ? '<div class="ci-rollup-row ci-rollup-presale"><span>Pre-sale costs</span><span>' + money(R.presale_total) + '</span></div>' : '') +
          '</div></div>';
      }
      var lk = host.querySelector('[data-ci-open]');
      if (lk) lk.addEventListener('click', function (e) { e.preventDefault(); openFor(et, eid); });
    }).catch(function () { host.innerHTML = ''; });
  }

  // Open the Cost Inbox pre-filtered to one job/lead.
  function openFor(entityType, entityId) {
    _pinnedEntity = { type: entityType, id: String(entityId) };
    _pinArmed = true;   // survive the one render triggered by switchTab
    _drawer = null;
    _filters.q = '';
    if (typeof window.switchTab === 'function') window.switchTab('cost-inbox');
  }

  // openNew works from anywhere (quick-add menu, mobile, etc.) — ensure the
  // job/lead picker has data even if the Cost Inbox tab was never opened.
  window.p86CostInbox = {
    render: render,
    openNew: function () { loadEntities().then(function () { openReceiptModal(null); }); },
    mountRollup: mountRollup,
    openFor: openFor
  };
})();
