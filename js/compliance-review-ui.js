// Wave 3 — Compliance review drawer.
//
// Opens from the Summary "Certs Expiring" attention card. Shows
// compliance items grouped by urgency (Expired / Next 7d / Next 30d
// / Next 90d) so the user can triage renewals fast. Inline status +
// expiration-date editing; archive button per row.
//
// Surface: window.p86ComplianceReview.open()

(function() {
  'use strict';

  var STATE = {
    items: [],
    expandedId: null
  };

  var TYPE_LABELS = {
    client_coi:  { label: 'Client COI',     glyph: '🏢' },
    license:     { label: 'License',         glyph: '🎫' },
    lien_waiver: { label: 'Lien Waiver',     glyph: '📜' },
    wc_cert:     { label: 'Workers Comp',    glyph: '🦺' },
    other:       { label: 'Other',           glyph: '📄' }
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtDate(d) {
    if (!d) return '';
    var date = new Date(d);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function bucketize(days_left) {
    if (days_left < 0) return 'expired';
    if (days_left <= 7) return '7d';
    if (days_left <= 30) return '30d';
    return '90d';
  }
  var BUCKET_META = {
    expired: { label: 'Already Expired', color: '#f87171', glyph: '⚠' },
    '7d':    { label: 'Next 7 Days',     color: '#f87171', glyph: '🔴' },
    '30d':   { label: 'Next 30 Days',    color: '#fbbf24', glyph: '🟡' },
    '90d':   { label: 'Next 90 Days',    color: '#22d3ee', glyph: '🔵' }
  };

  function open() {
    var prior = document.getElementById('complianceReviewModal');
    if (prior) prior.remove();
    var modal = document.createElement('div');
    modal.id = 'complianceReviewModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML =
      '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);border-radius:10px;max-width:780px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;">' +
        '<div style="padding:14px 18px;border-bottom:1px solid var(--border,#2e3346);display:flex;align-items:center;gap:12px;">' +
          '<span style="font-size:22px;">📋</span>' +
          '<div style="flex:1;"><div style="font-size:14px;font-weight:700;color:var(--text,#fff);">Compliance Review</div>' +
          '<div style="font-size:11px;color:var(--text-dim,#888);">Certificates of insurance, licenses, lien waivers, WC certs</div></div>' +
          '<button data-compliance-new style="background:#34d399;color:#0f0f1e;border:none;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">+ New</button>' +
          '<button data-compliance-close style="background:transparent;border:none;color:var(--text-dim,#888);font-size:24px;cursor:pointer;line-height:1;">&times;</button>' +
        '</div>' +
        '<div data-compliance-body style="flex:1;overflow-y:auto;padding:14px 18px;">Loading…</div>' +
      '</div>';
    document.body.appendChild(modal);

    function close() { modal.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
    modal.querySelector('[data-compliance-close]').addEventListener('click', close);
    modal.querySelector('[data-compliance-new]').addEventListener('click', function() {
      openCreateModal(function() { load(); });
    });

    load();
  }

  function load() {
    var body = document.querySelector('#complianceReviewModal [data-compliance-body]');
    if (!body) return;
    // 90-day window with include_expired captures everything the user
    // wants to act on. Items farther out aren't urgent enough to
    // surface in the review drawer.
    Promise.all([
      window.p86Api.get('/api/compliance-items/expiring?days=90'),
      window.p86Api.get('/api/compliance-items/expired')
    ]).then(function(results) {
      var expiring = (results[0] && results[0].items) || [];
      var expired = (results[1] && results[1].items) || [];
      STATE.items = expired.concat(expiring);
      paint();
    }).catch(function(err) {
      body.innerHTML = '<div style="padding:24px;color:#f87171;">Failed to load: ' + esc(err && err.message || err) + '</div>';
    });
  }

  function paint() {
    var body = document.querySelector('#complianceReviewModal [data-compliance-body]');
    if (!body) return;
    if (!STATE.items.length) {
      body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-dim,#888);">' +
        '<div style="font-size:32px;margin-bottom:8px;">✓</div>' +
        '<div style="font-size:13px;font-weight:600;">All compliance items current</div>' +
        '<div style="font-size:11px;margin-top:4px;">Nothing expires in the next 90 days.</div>' +
        '</div>';
      return;
    }
    // Group by bucket.
    var groups = { expired: [], '7d': [], '30d': [], '90d': [] };
    STATE.items.forEach(function(it) {
      var days_left = Number(it.days_until_expiry != null ? it.days_until_expiry : -Number(it.days_overdue));
      it._days_left = days_left;
      groups[bucketize(days_left)].push(it);
    });
    var html = '';
    ['expired', '7d', '30d', '90d'].forEach(function(b) {
      var bm = BUCKET_META[b];
      var items = groups[b];
      if (!items.length) return;
      html += '<div style="margin-bottom:18px;">';
      html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,0.02);border-left:3px solid ' + bm.color + ';margin-bottom:6px;border-radius:0 4px 4px 0;">';
      html += '<span style="color:' + bm.color + ';font-size:13px;">' + bm.glyph + '</span>';
      html += '<span style="font-size:11px;font-weight:700;color:var(--text,#fff);text-transform:uppercase;letter-spacing:0.5px;">' + esc(bm.label) + ' (' + items.length + ')</span>';
      html += '</div>';
      items.forEach(function(it) {
        html += renderRow(it);
      });
      html += '</div>';
    });
    body.innerHTML = html;
    wireRowEvents();
  }

  function renderRow(it) {
    var tm = TYPE_LABELS[it.type] || { label: it.type, glyph: '📄' };
    var days_str = it._days_left < 0
      ? '⚠ ' + Math.abs(it._days_left) + 'd ago'
      : it._days_left + 'd remaining';
    var meta = it.metadata || {};
    var metaSnippet = Object.keys(meta).slice(0, 3).map(function(k) {
      var v = meta[k];
      return k + ': ' + String(v).slice(0, 30);
    }).join(' · ');
    var html = '<div data-compliance-row="' + esc(it.id) + '" class="cmp-row" style="padding:10px 12px;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);border-radius:6px;margin-bottom:6px;cursor:pointer;' +
      (STATE.expandedId === it.id ? 'border-color:#4f8cff;' : '') + '">';
    // Grid: on desktop, 4 columns (icon · title · date · days). On
    // narrow phones (<640px), CSS reflows this to 2 rows via the
    // .cmp-row-grid class so the long title row doesn't truncate.
    html += '<div class="cmp-row-grid" style="display:grid;grid-template-columns:30px 1fr 100px 90px;gap:10px;align-items:center;">';
    html += '<div class="cmp-row-icon" style="font-size:18px;">' + tm.glyph + '</div>';
    html += '<div class="cmp-row-body">';
    html += '<div style="font-size:13px;font-weight:600;color:var(--text,#fff);">' + esc(it.title) + '</div>';
    html += '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;">' + esc(tm.label) + ' · ' + esc(it.entity_type) + ':' + esc(it.entity_id) + (metaSnippet ? ' · ' + esc(metaSnippet) : '') + '</div>';
    html += '</div>';
    html += '<div class="cmp-row-date" style="font-size:11px;color:var(--text-dim,#aaa);text-align:right;">' + esc(fmtDate(it.expiration_date)) + '</div>';
    html += '<div class="cmp-row-days" style="font-size:11px;text-align:right;color:' + (it._days_left < 0 ? '#f87171' : '#fbbf24') + ';font-weight:600;">' + esc(days_str) + '</div>';
    html += '</div>';
    if (STATE.expandedId === it.id) {
      html += renderEditPanel(it);
    }
    html += '</div>';
    return html;
  }

  function renderEditPanel(it) {
    var html = '<div data-compliance-edit="' + esc(it.id) + '" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--ng-border2,#2e3346);">';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px;">';
    html += '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;display:block;margin-bottom:3px;">Status</label>';
    html += '<select data-cmp-edit-field="status" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:6px 8px;border-radius:5px;font-size:12px;">';
    ['active', 'pending', 'expired'].forEach(function(s) {
      html += '<option value="' + s + '"' + (it.status === s ? ' selected' : '') + '>' + s + '</option>';
    });
    html += '</select></div>';
    html += '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;display:block;margin-bottom:3px;">Expiration</label>';
    html += '<input type="date" data-cmp-edit-field="expiration_date" value="' + esc((it.expiration_date || '').slice(0, 10)) + '" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:6px 8px;border-radius:5px;font-size:12px;">';
    html += '</div></div>';
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;">';
    html += '<button data-cmp-archive="' + esc(it.id) + '" style="background:transparent;border:1px solid rgba(248,113,113,0.4);color:#f87171;padding:6px 12px;border-radius:5px;font-size:11px;cursor:pointer;">Archive</button>';
    html += '<button data-cmp-save="' + esc(it.id) + '" style="background:#4f8cff;border:none;color:#fff;padding:6px 12px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">Save</button>';
    html += '</div></div>';
    return html;
  }

  function wireRowEvents() {
    var body = document.querySelector('#complianceReviewModal [data-compliance-body]');
    if (!body) return;
    body.querySelectorAll('[data-compliance-row]').forEach(function(row) {
      row.addEventListener('click', function(e) {
        if (e.target.closest('[data-compliance-edit]') ||
            e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
        var id = row.getAttribute('data-compliance-row');
        STATE.expandedId = STATE.expandedId === id ? null : id;
        paint();
      });
    });
    body.querySelectorAll('[data-cmp-save]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-cmp-save');
        var panel = btn.closest('[data-compliance-edit]');
        if (!panel) return;
        var patch = {};
        panel.querySelectorAll('[data-cmp-edit-field]').forEach(function(input) {
          patch[input.getAttribute('data-cmp-edit-field')] = input.value || null;
        });
        window.p86Api.put('/api/compliance-items/' + encodeURIComponent(id), patch)
          .then(function() { STATE.expandedId = null; load(); })
          .catch(function(err) { alert('Save failed: ' + (err && err.message || err)); });
      });
    });
    body.querySelectorAll('[data-cmp-archive]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-cmp-archive');
        if (!confirm('Archive this compliance item?')) return;
        window.p86Api.post('/api/compliance-items/' + encodeURIComponent(id) + '/archive', {})
          .then(function() { STATE.expandedId = null; load(); })
          .catch(function(err) { alert('Archive failed: ' + (err && err.message || err)); });
      });
    });
  }

  function openCreateModal(onCreated) {
    var prior = document.getElementById('complianceCreateModal');
    if (prior) prior.remove();
    var modal = document.createElement('div');
    modal.id = 'complianceCreateModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML =
      '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);border-radius:10px;max-width:560px;width:100%;padding:18px 22px;">' +
        '<div style="font-size:14px;font-weight:700;color:var(--text,#fff);margin-bottom:14px;">New Compliance Item</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">' +
          '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;display:block;margin-bottom:3px;">Type *</label>' +
          '<select id="cmpCreateType" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;">' +
            '<option value="client_coi">Client COI</option>' +
            '<option value="license">License</option>' +
            '<option value="wc_cert">Workers Comp</option>' +
            '<option value="lien_waiver">Lien Waiver</option>' +
            '<option value="other">Other</option>' +
          '</select></div>' +
          '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;display:block;margin-bottom:3px;">Anchor *</label>' +
          '<select id="cmpCreateEntityType" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;">' +
            '<option value="client">Client</option>' +
            '<option value="sub">Sub</option>' +
            '<option value="user">User (employee)</option>' +
            '<option value="job">Job</option>' +
          '</select></div>' +
        '</div>' +
        '<label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;display:block;margin-bottom:3px;">Entity ID *</label>' +
        '<input type="text" id="cmpCreateEntityId" placeholder="e.g. cli_X or sub_Y" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:8px 10px;border-radius:6px;font-size:13px;margin-bottom:12px;">' +
        '<label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;display:block;margin-bottom:3px;">Title *</label>' +
        '<input type="text" id="cmpCreateTitle" autofocus placeholder="e.g. PAC General Liability — Travelers" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:8px 10px;border-radius:6px;font-size:13px;margin-bottom:12px;">' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px;">' +
          '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;display:block;margin-bottom:3px;">Effective</label>' +
          '<input type="date" id="cmpCreateEffective" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:8px 10px;border-radius:6px;font-size:13px;"></div>' +
          '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;display:block;margin-bottom:3px;">Expires</label>' +
          '<input type="date" id="cmpCreateExpires" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:8px 10px;border-radius:6px;font-size:13px;"></div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
          '<button id="cmpCreateCancel" style="background:transparent;border:1px solid var(--border,#2e3346);color:var(--text-dim,#888);padding:8px 16px;border-radius:6px;font-size:12px;cursor:pointer;">Cancel</button>' +
          '<button id="cmpCreateSubmit" style="background:#34d399;color:#0f0f1e;border:none;padding:8px 18px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">Create</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    function close() { modal.remove(); }
    document.getElementById('cmpCreateCancel').addEventListener('click', close);
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
    document.getElementById('cmpCreateSubmit').addEventListener('click', function() {
      var entity_id = document.getElementById('cmpCreateEntityId').value.trim();
      var title = document.getElementById('cmpCreateTitle').value.trim();
      if (!entity_id) { alert('Entity ID required.'); return; }
      if (!title) { alert('Title required.'); return; }
      var payload = {
        type: document.getElementById('cmpCreateType').value,
        entity_type: document.getElementById('cmpCreateEntityType').value,
        entity_id: entity_id,
        title: title,
        effective_date: document.getElementById('cmpCreateEffective').value || null,
        expiration_date: document.getElementById('cmpCreateExpires').value || null
      };
      window.p86Api.post('/api/compliance-items', payload)
        .then(function() { close(); if (onCreated) onCreated(); })
        .catch(function(err) { alert('Create failed: ' + (err && err.message || err)); });
    });
  }

  window.p86ComplianceReview = { open: open };
})();
