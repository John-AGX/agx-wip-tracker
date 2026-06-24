// Client dashboard — full-width CRM view opened from the directory row.
// Fetches /api/clients/:id/dashboard and renders financial rollups, the
// linked jobs + leads, key contacts, and a health badge. Read-only v1;
// "Edit" opens the existing client editor. No external deps.
(function () {
  'use strict';

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) {
    var v = Number(n) || 0, sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  function pct(n) { return (n == null) ? '—' : Math.round(n * 100) + '%'; }

  function authedGet(url) {
    var token = null; try { token = localStorage.getItem('p86-auth-token'); } catch (e) {}
    var headers = {}; if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, { headers: headers, credentials: 'include' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
  }
  function show(id) { if (typeof window.openModal === 'function') window.openModal(id); else { var m = document.getElementById(id); if (m) m.classList.add('active'); } }
  function hide(id) { if (typeof window.closeModal === 'function') window.closeModal(id); else { var m = document.getElementById(id); if (m) m.classList.remove('active'); } }

  var HEALTH = { healthy: { c: '#34d399', l: 'HEALTHY' }, watch: { c: '#fbbf24', l: 'WATCH' }, risk: { c: '#f87171', l: 'AT RISK' } };
  var STATUS = { done: '#34d399', sold: '#34d399', closed: '#8a93a6', lost: '#f87171', sent: '#4f8cff', in_progress: '#fbbf24', 'new': '#a78bfa' };

  function card(label, value, accent, sub) {
    return '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#2a2f3a);border-radius:10px;padding:14px 16px;flex:1;min-width:120px;">' +
      '<div style="font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:var(--text-dim,#8a93a6);margin-bottom:6px;">' + esc(label) + '</div>' +
      '<div style="font-size:22px;font-weight:700;color:' + (accent || '#fff') + ';">' + value + '</div>' +
      (sub ? '<div style="font-size:11px;color:var(--text-dim,#8a93a6);margin-top:3px;">' + sub + '</div>' : '') + '</div>';
  }
  function statusPill(s) {
    var c = STATUS[String(s || '').toLowerCase()] || '#8a93a6';
    return '<span style="padding:2px 8px;border-radius:9px;font-size:10px;text-transform:uppercase;letter-spacing:.4px;background:' + c + '22;color:' + c + ';">' + esc(s || '—') + '</span>';
  }
  function contactChip(label, name, email, phone) {
    if (!name && !email && !phone) return '';
    var bits = [];
    if (phone) bits.push('<a href="tel:' + esc(phone) + '" style="color:#4f8cff;text-decoration:none;">📞</a>');
    if (email) bits.push('<a href="mailto:' + esc(email) + '" style="color:#4f8cff;text-decoration:none;">✉️</a>');
    return '<span style="background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:20px;padding:5px 12px;font-size:12px;color:var(--text,#dde);">' +
      '<span style="color:var(--text-dim,#8a93a6);">' + esc(label) + ':</span> ' + esc(name || '—') + ' ' + bits.join(' ') + '</span>';
  }
  function listTable(headers, rows) {
    if (!rows.length) return '<div style="padding:18px;color:var(--text-dim,#8a93a6);font-size:12px;border:1px dashed var(--border,#2a2f3a);border-radius:8px;">None yet.</div>';
    var th = headers.map(function (x, i) { return '<th style="text-align:' + (i >= headers.length - 1 ? 'right' : 'left') + ';padding:7px 9px;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#8a93a6);">' + esc(x) + '</th>'; }).join('');
    return '<div style="border:1px solid var(--border,#2a2f3a);border-radius:8px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead style="background:rgba(255,255,255,0.03);"><tr>' + th + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }

  function render(host, d) {
    var c = d.client || {}, s = d.summary || {}, jobs = d.jobs || [], leads = d.leads || [];
    var h = HEALTH[(s.health && s.health.tier) || 'healthy'] || HEALTH.healthy;
    var html = '';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
        '<span style="font-size:20px;font-weight:700;color:#fff;">' + esc(c.name || 'Client') + '</span>' +
        (c.client_type ? '<span style="font-size:11px;color:var(--text-dim,#8a93a6);text-transform:uppercase;letter-spacing:.5px;">' + esc(c.client_type) + '</span>' : '') +
        '<span title="' + esc((s.health && s.health.reason) || '') + '" style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.5px;background:' + h.c + '22;color:' + h.c + ';">● ' + h.l + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<button class="ee-btn secondary" onclick="openClientDashboardEdit(\'' + esc(c.id) + '\')">✏️ Edit</button>' +
        '<button class="ee-btn ghost" onclick="closeClientDashboard()">✕ Close</button>' +
      '</div></div>';

    var contacts = [
      contactChip('CAM', c.community_manager, c.cm_email, c.cm_phone),
      contactChip('Maint', c.maintenance_manager, c.mm_email, c.mm_phone),
      contactChip('Contact', [c.first_name, c.last_name].filter(Boolean).join(' '), c.email, c.phone)
    ].filter(Boolean).join('');
    if (c.property_address || c.market) contacts += '<span style="font-size:12px;color:var(--text-dim,#8a93a6);">📍 ' + esc([c.market, c.property_address].filter(Boolean).join(' · ')) + '</span>';
    if (contacts) html += '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px;">' + contacts + '</div>';

    html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;">' +
      card('Jobs', (s.jobCount || 0), '#fff') +
      card('Contract', money(s.contractValue), '#4f8cff') +
      card('Costs', money(s.costs), '#fbbf24') +
      card('Revenue', money(s.revenue), '#34d399') +
      card('Margin', pct(s.margin), (s.margin != null && s.margin < 0.15) ? '#f87171' : '#34d399') +
      card('Open Leads', (s.openLeads || 0), '#a78bfa', money(s.pipelineValue) + ' pipeline') +
    '</div>';

    var jobRows = jobs.slice(0, 14).map(function (j) {
      return '<tr style="border-top:1px solid var(--border,#23262e);">' +
        '<td style="padding:7px 9px;color:#fff;"><span style="font-family:monospace;color:#4f8cff;">' + esc(j.jobNumber || '') + '</span> ' + esc(j.title || '') + '</td>' +
        '<td style="padding:7px 9px;">' + statusPill(j.status) + '</td>' +
        '<td style="padding:7px 9px;text-align:right;font-family:monospace;color:#cdd;">' + money(j.contract) + '</td>' +
        '<td style="padding:7px 9px;text-align:right;font-family:monospace;color:' + (j.margin != null && j.margin < 0.15 ? '#f87171' : '#34d399') + ';">' + pct(j.margin) + '</td></tr>';
    });
    var leadRows = leads.slice(0, 14).map(function (l) {
      return '<tr style="border-top:1px solid var(--border,#23262e);">' +
        '<td style="padding:7px 9px;color:#fff;">' + esc(l.title || '') + '</td>' +
        '<td style="padding:7px 9px;">' + statusPill(l.status) + '</td>' +
        '<td style="padding:7px 9px;text-align:right;font-family:monospace;color:#cdd;">' + money(l.value) + '</td></tr>';
    });

    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">' +
      '<div><div style="font-size:13px;font-weight:600;color:#fff;margin-bottom:8px;">Jobs (' + jobs.length + ')</div>' + listTable(['Job', 'Status', 'Contract', 'Margin'], jobRows) + '</div>' +
      '<div><div style="font-size:13px;font-weight:600;color:#fff;margin-bottom:8px;">Leads (' + leads.length + ')</div>' + listTable(['Lead', 'Status', 'Value'], leadRows) + '</div>' +
    '</div>';

    html += '<div style="margin-top:14px;font-size:11px;color:var(--text-dim,#8a93a6);">Health is account-activity based; property-condition health (roof/permit age, tenant reviews) lands with the property-intel layer. Jobs link by explicit client link or client-name match.</div>';
    host.innerHTML = html;
  }

  function openClientDashboard(id) {
    var host = document.getElementById('clientDashboard_body');
    if (!host) return;
    host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#8a93a6);">Loading client dashboard…</div>';
    show('clientDashboardModal');
    authedGet('/api/clients/' + encodeURIComponent(id) + '/dashboard').then(function (res) {
      if (!res.ok) { host.innerHTML = '<div style="padding:30px;color:#f87171;">Could not load dashboard: ' + esc((res.body && res.body.error) || 'server error') + '</div>'; return; }
      render(host, res.body);
    }).catch(function (e) { host.innerHTML = '<div style="padding:30px;color:#f87171;">Error: ' + esc(e && e.message) + '</div>'; });
  }
  function closeClientDashboard() { hide('clientDashboardModal'); }
  function openClientDashboardEdit(id) { hide('clientDashboardModal'); if (typeof window.openEditClientModal === 'function') window.openEditClientModal(id); }

  window.openClientDashboard = openClientDashboard;
  window.closeClientDashboard = closeClientDashboard;
  window.openClientDashboardEdit = openClientDashboardEdit;
})();
