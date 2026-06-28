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
    var dt = new Date(d);
    if (isNaN(dt.getTime())) return String(d).slice(0, 10);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

  function render(host) {
    if (!host) return;
    host.innerHTML =
      '<div class="ci-wrap">' +
        '<div class="ci-head">' +
          '<div class="ci-title">Cost Inbox</div>' +
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
        '</div>' +
        '<div class="ci-list" id="ciList"><div class="ci-empty">Loading…</div></div>' +
      '</div>';

    document.getElementById('ciNew').addEventListener('click', function () { openReceiptModal(null); });
    var sEl = document.getElementById('ciSearch');
    sEl.addEventListener('input', function () { _filters.q = sEl.value || ''; renderList(); });
    document.getElementById('ciStatusFilter').addEventListener('change', function (e) { _filters.status = e.target.value; reload(); });
    document.getElementById('ciJobFilter').addEventListener('change', function (e) { _filters.job = e.target.value; renderList(); });

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
    var opts = {};
    if (_filters.status) opts.status = _filters.status; // 'all' includes void; '' = default (hides void)
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

    if (!rows.length) { listEl.innerHTML = '<div class="ci-empty">No receipts yet. Tap <strong>+ New Receipt</strong> to capture one.</div>'; return; }

    // group: Unprocessed first, then everything else by date desc
    rows.sort(function (a, b) {
      var au = a.status === 'unprocessed' ? 0 : 1, bu = b.status === 'unprocessed' ? 0 : 1;
      if (au !== bu) return au - bu;
      return String(b.purchased_at || b.created_at).localeCompare(String(a.purchased_at || a.created_at));
    });

    listEl.innerHTML = rows.map(function (r) {
      var thumb = r.image_thumb_url || r.image_url;
      var ent = entityLabel(r.entity_type, r.entity_id);
      var codeLabel = r.is_presale ? 'Pre-sale' : (CODE_LABEL[r.cost_code] || r.cost_code || '');
      var statusCls = 'ci-badge ci-badge-' + (r.status || 'unprocessed');
      return '<div class="ci-row" data-id="' + esc(r.id) + '">' +
        '<div class="ci-thumb">' + (thumb ? '<img src="' + esc(thumb) + '" alt="" loading="lazy" />' : '<span class="ci-thumb-ph">🧾</span>') + '</div>' +
        '<div class="ci-row-main">' +
          '<div class="ci-row-top">' +
            '<span class="ci-row-vendor">' + esc(r.vendor || '(no vendor)') + '</span>' +
            '<span class="ci-row-amt">' + (r.amount != null ? money(r.amount) : '<span class="ci-need">— add amount</span>') + '</span>' +
          '</div>' +
          '<div class="ci-row-sub">' +
            (ent ? '<span class="ci-chip">' + esc(ent) + '</span>' : '<span class="ci-chip ci-chip-warn">no job</span>') +
            '<span class="ci-chip ci-chip-code">' + esc(codeLabel) + '</span>' +
            '<span class="ci-row-date">' + esc(fmtDate(r.purchased_at || r.created_at)) + '</span>' +
            '<span class="' + statusCls + '">' + esc(r.status || 'unprocessed') + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    listEl.querySelectorAll('.ci-row').forEach(function (row) {
      row.addEventListener('click', function () {
        var rec = _receipts.find(function (x) { return String(x.id) === String(row.getAttribute('data-id')); });
        if (rec) openReceiptModal(rec);
      });
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
              (isEdit ? '<button class="ci-btn ci-btn-danger" id="ciDel">Void</button>' : '') +
              '<button class="ci-btn" id="ciCancel">Cancel</button>' +
              '<button class="ci-btn ci-btn-primary" id="ciSave">Save</button>' +
            '</div>' +
          '</div>' +
          '<div class="ci-modal-body">' +
            // Photo (camera-first)
            '<label class="ci-photo" id="ciPhotoTile">' +
              '<input type="file" accept="image/*" capture="environment" id="ciPhotoInput" hidden />' +
              '<div class="ci-photo-inner" id="ciPhotoInner">' +
                (existingThumb ? '<img src="' + esc(existingThumb) + '" alt="receipt" />' : '<span class="ci-photo-cta">📷<br/>Take / upload receipt</span>') +
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
        inner.innerHTML = '<img src="' + url + '" alt="receipt" />';
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
          purchased_at: modal.querySelector('#ciDate').value || null
        };
        // 1) create or update the receipt
        var save = isEdit
          ? window.p86Api.receipts.update(r.id, payload)
          : window.p86Api.receipts.create(payload);
        save.then(function (resp) {
          var saved = (resp && resp.receipt) || resp;
          // 2) if a new photo was picked, upload it (to the linked entity, else
          //    the user's bucket — both valid attachment entity_types) and link.
          if (_pendingFile) {
            var bucketType = entityId ? entityType : 'user';
            var bucketId = entityId || myUserId();
            if (bucketId) {
              return window.p86Api.attachments.upload(bucketType, bucketId, _pendingFile, { geo: false })
                .then(function (ar) {
                  var att = (ar && (ar.attachment || ar.attachments && ar.attachments[0])) || ar;
                  var attId = att && att.id;
                  if (attId) return window.p86Api.receipts.update(saved.id, { attachment_id: attId });
                }).catch(function () { /* photo optional — don't fail the receipt */ });
            }
          }
        }).then(function () {
          toast('Receipt saved', 'success');
          close();
          reload();
        }).catch(function (e2) {
          saveBtn.disabled = false; saveBtn.textContent = 'Save';
          toast('Could not save: ' + (e2 && e2.message || 'error'), 'error');
        });
      });
    });
  }

  window.p86CostInbox = { render: render, openNew: function () { openReceiptModal(null); } };
})();
