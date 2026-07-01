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
  var _receipts = [];
  var _selected = {};        // id -> true (multi-select for export)
  var _visibleRows = [];     // the currently filtered/sorted rows on screen
  // Column/row table is the only list view. Table sort state:
  var _tsort = { key: '', dir: 'desc' };

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
      { key: 'uploaded_by', label: 'Uploaded By', type: 'select', options: users },
      { key: 'amount', label: 'Total Amount', type: 'numrange' }
    ];
  }
  // Does a receipt pass the current drawer filters? (null drawer = default: hide void.)
  function matchesDrawer(r) {
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
    if (d.vendor && d.vendor.trim()) { if ((r.vendor || '').toLowerCase().indexOf(d.vendor.trim().toLowerCase()) < 0) return false; }
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
    var n = _drawer ? window.p86FilterDrawer.countActive(fields, _drawer) : 0;
    var btn = document.getElementById('ciFilterBtn');
    if (btn) { btn.classList.toggle('pf-on', n > 0); btn.innerHTML = 'Filter' + (n ? ' <strong>(' + n + ')</strong>' : ''); }
    var af = document.getElementById('ciActiveFilters');
    if (!af) return;
    if (!n) { af.innerHTML = ''; return; }
    function summary(f) {
      var v = _drawer[f.key];
      if (f.type === 'chips') { return v.map(function (x) { var o = (f.options || []).find(function (o) { return o.v === x; }); return o ? o.label : x; }).join(', '); }
      if (f.type === 'select') { var o = (f.options || []).find(function (o) { return String(o.v) === String(v); }); return o ? o.label : v; }
      if (f.type === 'daterange') { var r = window.p86FilterDrawer.resolveDateRange(v); return (r.from || '…') + ' → ' + (r.to || '…'); }
      if (f.type === 'numrange') { var r2 = window.p86FilterDrawer.resolveNumRange(v); return (r2.min != null ? ('$' + r2.min) : '$0') + ' → ' + (r2.max != null ? ('$' + r2.max) : '∞'); }
      return String(v);
    }
    af.innerHTML = fields.filter(function (f) { return _drawer && window.p86FilterDrawer.countActive([f], _drawer); }).map(function (f) {
      return '<span class="ci-fchip">' + esc(f.label) + ': ' + esc(summary(f)) + ' <button type="button" data-clr="' + esc(f.key) + '" aria-label="remove">&times;</button></span>';
    }).join('');
    af.querySelectorAll('button[data-clr]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-clr');
        var f = fields.find(function (x) { return x.key === k; });
        if (_drawer && f) { _drawer[k] = window.p86FilterDrawer.emptyValues([f])[k]; }
        if (_drawer && !window.p86FilterDrawer.countActive(fields, _drawer)) _drawer = null;
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

  function render(host) {
    if (!host) return;
    host.innerHTML =
      '<div class="ci-wrap">' +
        '<div class="ci-head">' +
          '<div><div class="ci-title">Cost Inbox</div><div class="ci-ocr-stat" id="ciOcrStat"></div></div>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<button class="ci-btn" id="ciExport" type="button" title="Export to Excel">⬇ Export to Excel</button>' +
            '<button class="ci-btn ci-btn-primary" id="ciNew">+ New Receipt</button>' +
          '</div>' +
        '</div>' +
        '<div class="ci-toolbar">' +
          '<button class="ci-btn" id="ciFilterBtn" type="button">Filter</button>' +
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
    renderOcrStat();
    var sEl = document.getElementById('ciSearch');
    sEl.addEventListener('input', function () { _filters.q = sEl.value || ''; renderList(); });

    loadEntities().then(function () { updateFilterUI(); reload(); });
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
    { key: 'date', label: 'Date', sort: true },
    { key: 'uploaded', label: 'Uploaded by', sort: true },
    { key: 'status', label: 'Status', sort: true }
  ];
  function ciSortVal(r, key) {
    switch (key) {
      case 'vendor': return (r.vendor || '').toLowerCase();
      case 'amount': return Number(r.amount || 0);
      case 'cost': return ciCodeLabel(r).toLowerCase();
      case 'linked': return entityLabel(r.entity_type, r.entity_id).toLowerCase();
      case 'date': return String(r.purchased_at || r.created_at || '');
      case 'uploaded': return (r.entered_by_name || '').toLowerCase();
      case 'status': return (r.status || '');
      default: return '';
    }
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
    var thead = '<thead><tr>' +
      '<th class="ci-th-check"><input type="checkbox" id="ciSelAll" title="Select all" /></th>' +
      CI_COLS.map(function (c) {
      if (!c.sort) return '<th class="ci-th-photo"></th>';
      var sc = (_tsort.key === c.key) ? (' sortable sort-' + (_tsort.dir === 'asc' ? 'asc' : 'desc')) : ' sortable';
      return '<th class="' + (c.num ? 'num' : '') + sc + '" data-sort="' + c.key + '">' + esc(c.label) + '</th>';
    }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (r) {
      var thumb = r.image_thumb_url || r.image_url;
      var ent = entityLabel(r.entity_type, r.entity_id);
      var amt = (r.amount != null && Number(r.amount) > 0) ? money(r.amount) : '<span class="ci-need">—</span>';
      return '<tr class="ci-trow" data-id="' + esc(r.id) + '">' +
        '<td class="ci-td-check"><input type="checkbox" class="ci-rowcheck" data-id="' + esc(r.id) + '"' + (_selected[r.id] ? ' checked' : '') + ' /></td>' +
        '<td class="ci-td-photo"><span class="ci-thumb ci-thumb-sm">' + (thumb ? '<img src="' + esc(thumb) + '" alt="" loading="lazy" />' : THUMB_PH) + '</span></td>' +
        '<td class="ci-td-vendor">' + esc(r.vendor || '(no vendor)') + '</td>' +
        '<td class="num">' + amt + '</td>' +
        '<td>' + esc(ciCodeLabel(r)) + '</td>' +
        '<td>' + (ent ? esc(ent) : '<span class="ci-chip-warn" style="font-size:11px;">no job</span>') + '</td>' +
        '<td>' + esc(fmtDate(r.purchased_at || r.created_at)) + '</td>' +
        '<td>' + esc(r.entered_by_name || (r.entered_by ? ('User ' + r.entered_by) : '—')) + '</td>' +
        '<td><span class="ci-badge ci-badge-' + (r.status || 'unprocessed') + '">' + esc(r.status || 'unprocessed') + '</span></td>' +
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
    if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
    ensureXLSX().then(function (XLSX) {
      var header = ['Date', 'Vendor', 'Amount', 'Cost type', 'Linked to', 'Link type', 'Uploaded by', 'Status', 'Receipt ID', 'Notes'];
      var aoa = [header];
      rows.forEach(function (r) {
        aoa.push([
          String(r.purchased_at || r.created_at || '').slice(0, 10),
          r.vendor || '',
          (r.amount != null ? Number(r.amount) : ''),
          (r.entity_type === 'category') ? '' : ciCodeLabel(r),
          entityLabel(r.entity_type, r.entity_id) || '',
          r.entity_type || 'unlinked',
          r.entered_by_name || (r.entered_by ? ('User ' + r.entered_by) : ''),
          r.status || '',
          r.ref || '',
          r.notes || ''
        ]);
      });
      var total = rows.reduce(function (s, r) { return s + (r.status === 'void' ? 0 : Number(r.amount || 0)); }, 0);
      aoa.push([]); aoa.push(['', 'TOTAL', total]);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 14 }, { wch: 30 }, { wch: 11 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 40 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Cost Inbox');
      var stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, 'Cost_Inbox_' + stamp + '.xlsx');
      if (btn) { btn.disabled = false; btn.textContent = '⬇ Export to Excel'; }
      toast('Exported ' + rows.length + ' receipt' + (rows.length === 1 ? '' : 's') + '.', 'success');
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '⬇ Export to Excel'; }
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
            viewRow('Date', fmtDate(r.purchased_at) || null) +
            viewRow('Uploaded by', r.entered_by_name || (r.entered_by ? ('User ' + r.entered_by) : null)) +
            viewRow('Captured', fmtDateTime(r.created_at) || null) +
            (r.updated_at && r.updated_at !== r.created_at ? viewRow('Last updated', fmtDateTime(r.updated_at)) : '') +
            viewRow('Receipt ID', r.ref || null) +
          '</div>' +
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
        var payload = {
          entity_type: entityId ? entityType : null,
          entity_id: entityId,
          amount: modal.querySelector('#ciAmount').value || null,
          cost_code: chosenCode,
          vendor: modal.querySelector('#ciVendor').value || null,
          notes: modal.querySelector('#ciNotes').value || null,
          purchased_at: modal.querySelector('#ciDate').value || null,
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
    _filters.job = entityType + ':' + entityId;
    _filters.status = '';
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
