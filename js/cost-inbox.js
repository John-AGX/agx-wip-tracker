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

  // ── Entity (job/lead) cache for the picker + label resolution ──────
  var _jobs = [], _leads = [], _entLoaded = false;
  function loadEntities() {
    if (_entLoaded) return Promise.resolve();
    var a = window.p86Api;
    if (!a) return Promise.resolve();
    return Promise.all([
      a.jobs.list().then(function (r) { _jobs = (r && (r.jobs || r)) || []; }).catch(function () { _jobs = []; }),
      a.leads.list().then(function (r) { _leads = (r && (r.leads || r)) || []; }).catch(function () { _leads = []; })
    ]).then(function () { _entLoaded = true; });
  }
  function jobLabel(j) { return (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.name || j.id); }
  function entityLabel(type, id) {
    if (!type || !id) return '';
    if (type === 'job') { var j = _jobs.find(function (x) { return String(x.id) === String(id); }); return j ? jobLabel(j) : ('Job ' + id); }
    var l = _leads.find(function (x) { return String(x.id) === String(id); }); return l ? (l.title || ('Lead ' + id)) : ('Lead ' + id);
  }

  // ── List page ─────────────────────────────────────────────────────
  var _filters = { job: '', status: '', q: '' };
  var _receipts = [];
  // List presentation: 'card' (rich rows) or 'table' (column/row like leads/jobs).
  var _view = (function () { try { return localStorage.getItem('ciView') === 'table' ? 'table' : 'card'; } catch (_) { return 'card'; } })();
  // Table sort state (only used in table view).
  var _tsort = { key: '', dir: 'desc' };

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
          '<button class="ci-btn ci-btn-primary" id="ciNew">+ New Receipt</button>' +
        '</div>' +
        '<div class="ci-toolbar">' +
          '<select id="ciJobFilter" class="ci-input"><option value="">All jobs &amp; leads</option></select>' +
          '<select id="ciStatusFilter" class="ci-input">' +
            '<option value="">Unprocessed + Processed</option>' +
            '<option value="unprocessed">Unprocessed</option>' +
            '<option value="processed">Processed</option>' +
            '<option value="all">Include voided</option>' +
          '</select>' +
          '<input type="text" id="ciSearch" class="ci-input ci-search" placeholder="Search vendor, amount, notes, ID…" />' +
          '<div class="ci-total" id="ciTotal"></div>' +
          '<div class="ci-viewtoggle" id="ciViewToggle">' +
            '<button type="button" class="ci-vt-btn" data-view="card" title="Card view">Cards</button>' +
            '<button type="button" class="ci-vt-btn" data-view="table" title="Table view">Table</button>' +
          '</div>' +
        '</div>' +
        '<div class="ci-list" id="ciList"><div class="ci-empty">Loading…</div></div>' +
      '</div>';

    document.getElementById('ciNew').addEventListener('click', function () { openReceiptModal(null); });
    renderOcrStat();
    var sEl = document.getElementById('ciSearch');
    sEl.addEventListener('input', function () { _filters.q = sEl.value || ''; renderList(); });
    document.getElementById('ciStatusFilter').addEventListener('change', function (e) { _filters.status = e.target.value; reload(); });
    document.getElementById('ciJobFilter').addEventListener('change', function (e) { _filters.job = e.target.value; reload(); });

    // Card ⇄ Table view toggle (persisted).
    var vt = document.getElementById('ciViewToggle');
    if (vt) {
      vt.querySelectorAll('.ci-vt-btn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-view') === _view);
        b.addEventListener('click', function () {
          _view = b.getAttribute('data-view');
          try { localStorage.setItem('ciView', _view); } catch (_) {}
          vt.querySelectorAll('.ci-vt-btn').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-view') === _view); });
          renderList();
        });
      });
    }

    loadEntities().then(function () {
      // populate the job/lead filter
      var sel = document.getElementById('ciJobFilter');
      if (sel) {
        var opts = ['<option value="">All jobs &amp; leads</option>'];
        _jobs.forEach(function (j) { opts.push('<option value="job:' + esc(j.id) + '">' + esc(jobLabel(j)) + '</option>'); });
        _leads.forEach(function (l) { opts.push('<option value="lead:' + esc(l.id) + '">' + esc(l.title || ('Lead ' + l.id)) + '</option>'); });
        sel.innerHTML = opts.join('');
        sel.value = _filters.job;
      }
      reload();
    });
  }

  function reload() {
    var listEl = document.getElementById('ciList');
    if (!window.p86Api || !window.p86Api.receipts) { if (listEl) listEl.innerHTML = '<div class="ci-empty">Not connected.</div>'; return; }
    var opts = { limit: 500 };
    if (_filters.status) opts.status = _filters.status; // 'all' includes void; '' = default (hides void)
    // Push the job/lead filter to the server so filtering + the row cap happen
    // server-side (otherwise a busy org's per-job view/total would only reflect
    // the most-recent page of receipts).
    if (_filters.job) { var jf = _filters.job.split(':'); opts.entity_type = jf[0]; opts.entity_id = jf[1]; }
    window.p86Api.receipts.list(opts).then(function (r) {
      _receipts = (r && r.receipts) || [];
      renderList();
    }).catch(function () {
      if (listEl) listEl.innerHTML = '<div class="ci-empty">Could not load receipts.</div>';
    });
  }

  function renderList() {
    var listEl = document.getElementById('ciList');
    if (!listEl) return;
    var q = (_filters.q || '').trim().toLowerCase();
    var jobF = _filters.job ? _filters.job.split(':') : null; // ['job', id]
    var rows = _receipts.filter(function (r) {
      if (jobF && !(r.entity_type === jobF[0] && String(r.entity_id) === jobF[1])) return false;
      if (q) {
        var hay = [(r.vendor || ''), (r.ref || ''), (r.notes || ''), String(r.amount || ''), entityLabel(r.entity_type, r.entity_id)].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    // running total of the visible (non-void) set
    var total = rows.reduce(function (s, r) { return s + (r.status === 'void' ? 0 : Number(r.amount || 0)); }, 0);
    var totEl = document.getElementById('ciTotal');
    if (totEl) totEl.textContent = rows.length + ' receipt' + (rows.length === 1 ? '' : 's') + ' · ' + money(total);

    if (!rows.length) { listEl.className = 'ci-list'; listEl.innerHTML = '<div class="ci-empty">No receipts yet. Tap <strong>+ New Receipt</strong> to capture one.</div>'; return; }

    if (_view === 'table') { renderTableView(listEl, rows); }
    else { renderCardView(listEl, rows); }
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
    listEl.querySelectorAll('[data-id]').forEach(function (row) {
      row.addEventListener('click', function () {
        var rec = _receipts.find(function (x) { return String(x.id) === String(row.getAttribute('data-id')); });
        if (rec) openReceiptViewer(rec);
      });
    });
  }

  var THUMB_PH = '<span class="ci-thumb-ph"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/></svg></span>';

  function renderCardView(listEl, rows) {
    defaultSort(rows);
    listEl.className = 'ci-list';
    listEl.innerHTML = rows.map(function (r) {
      var thumb = r.image_thumb_url || r.image_url;
      var ent = entityLabel(r.entity_type, r.entity_id);
      var statusCls = 'ci-badge ci-badge-' + (r.status || 'unprocessed');
      return '<div class="ci-row" data-id="' + esc(r.id) + '">' +
        '<div class="ci-thumb">' + (thumb ? '<img src="' + esc(thumb) + '" alt="" loading="lazy" />' : THUMB_PH) + '</div>' +
        '<div class="ci-row-main">' +
          '<div class="ci-row-top">' +
            '<span class="ci-row-vendor">' + esc(r.vendor || '(no vendor)') + '</span>' +
            '<span class="ci-row-amt">' + ((r.amount != null && Number(r.amount) > 0) ? money(r.amount) : '<span class="ci-need">— add amount</span>') + '</span>' +
          '</div>' +
          '<div class="ci-row-sub">' +
            (ent ? '<span class="ci-chip">' + esc(ent) + '</span>' : '<span class="ci-chip ci-chip-warn">no job</span>') +
            '<span class="ci-chip ci-chip-code">' + esc(ciCodeLabel(r)) + '</span>' +
            '<span class="ci-row-date">' + esc(fmtDate(r.purchased_at || r.created_at)) + '</span>' +
            '<span class="' + statusCls + '">' + esc(r.status || 'unprocessed') + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    wireRowOpen(listEl);
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
    var thead = '<thead><tr>' + CI_COLS.map(function (c) {
      if (!c.sort) return '<th class="ci-th-photo"></th>';
      var sc = (_tsort.key === c.key) ? (' sortable sort-' + (_tsort.dir === 'asc' ? 'asc' : 'desc')) : ' sortable';
      return '<th class="' + (c.num ? 'num' : '') + sc + '" data-sort="' + c.key + '">' + esc(c.label) + '</th>';
    }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (r) {
      var thumb = r.image_thumb_url || r.image_url;
      var ent = entityLabel(r.entity_type, r.entity_id);
      var amt = (r.amount != null && Number(r.amount) > 0) ? money(r.amount) : '<span class="ci-need">—</span>';
      return '<tr class="ci-trow" data-id="' + esc(r.id) + '">' +
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
    wireRowOpen(listEl);
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

    // Photo → lightbox (reuse the shared CompanyCam-style viewer).
    if (fullImg) {
      var photoEl = modal.querySelector('#ciVPhoto');
      if (photoEl) photoEl.addEventListener('click', function () {
        if (window.p86Attachments && window.p86Attachments.openLightbox && r.attachment_id) {
          window.p86Attachments.openLightbox(
            [{ id: r.attachment_id, url: r.image_url || fullImg, thumb_url: r.image_thumb_url || fullImg, mime_type: 'image/jpeg' }],
            0, { parentLabel: r.vendor || 'Receipt' }
          );
        } else {
          window.open(r.image_url || fullImg, '_blank', 'noopener');
        }
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
            // Link to job / lead
            '<div class="ci-field">' +
              '<label>Link to</label>' +
              '<div class="ci-link-row">' +
                '<select id="ciLinkType" class="ci-input">' +
                  '<option value="job"' + (linkType === 'job' ? ' selected' : '') + '>Job</option>' +
                  '<option value="lead"' + (linkType === 'lead' ? ' selected' : '') + '>Lead (pre-sale)</option>' +
                '</select>' +
                '<select id="ciLinkId" class="ci-input"></select>' +
              '</div>' +
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
      var codeField = modal.querySelector('#ciCodeField');
      var presaleNote = modal.querySelector('#ciPresaleNote');
      var codeSeg = modal.querySelector('#ciCodeSeg');
      var chosenCode = r.cost_code || 'materials';
      var codeUserPicked = isEdit; // true once the user (or an existing record) owns the cost code — OCR won't override
      var ocrSuggestion = null;    // {vendor,date,cost_code,amount} from OCR — sent on save so accuracy is tracked

      function fillEntityOptions() {
        var type = selType.value;
        var list = type === 'lead' ? _leads : _jobs;
        var opts = ['<option value="">— select a ' + type + ' —</option>'];
        list.forEach(function (it) {
          opts.push('<option value="' + esc(it.id) + '">' + esc(type === 'lead' ? (it.title || ('Lead ' + it.id)) : jobLabel(it)) + '</option>');
        });
        selId.innerHTML = opts.join('');
        if (r.entity_type === type && r.entity_id) selId.value = r.entity_id;
        // lead → pre-sale: hide cost code
        var isLead = type === 'lead';
        codeField.style.display = isLead ? 'none' : '';
        presaleNote.style.display = isLead ? '' : 'none';
      }
      fillEntityOptions();
      selType.addEventListener('change', fillEntityOptions);

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
            if (resp.cost_code && !codeUserPicked && selType.value !== 'lead') {
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
            var bucketType = entityId ? entityType : 'user';
            var bucketId = entityId || myUserId();
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
