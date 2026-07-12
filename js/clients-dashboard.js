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

  // Lead heat gauge (0-100) — Hot ≥70 (red), Warm ≥40 (amber), else Cold.
  function heatGauge(score, label) {
    score = Math.max(0, Math.min(100, Number(score) || 0));
    var col = score >= 70 ? '#f77066' : score >= 40 ? '#f2a55c' : '#8a93a6';
    return '<div title="Lead heat score" style="width:52px;height:52px;border-radius:50%;flex:none;display:grid;place-items:center;position:relative;background:conic-gradient(' + col + ' ' + (score * 3.6) + 'deg,#232838 0);">' +
      '<div style="position:absolute;inset:5px;border-radius:50%;background:var(--card-bg,#141419);"></div>' +
      '<div style="position:relative;text-align:center;line-height:1;">' +
        '<div style="font-family:monospace;font-size:15px;font-weight:800;color:' + col + ';">' + score + '</div>' +
        '<div style="font-size:7px;letter-spacing:.1em;text-transform:uppercase;color:' + col + ';font-weight:700;margin-top:1px;">' + esc(label || '') + '</div>' +
      '</div></div>';
  }
  // Property-intel SAFETY block — nearest hospital / fire, lazy-fetched.
  function safetyShell(msg) {
    return '<div style="border:1px solid rgba(79,209,197,.25);border-radius:10px;overflow:hidden;">' +
      '<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#4fd1c5;border-bottom:1px solid rgba(79,209,197,.18);">🛡️ Safety · nearest services</div>' +
      '<div style="padding:12px;color:var(--text-dim,#8a93a6);font-size:12px;">' + esc(msg) + '</div></div>';
  }
  function safRow(icon, name, sub, miles, tone) {
    var col = tone === 'er' ? '#f77066' : '#4fd1c5';
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border,#23262e);">' +
      '<span style="width:28px;height:28px;border-radius:8px;flex:none;display:grid;place-items:center;background:' + col + '1e;font-size:14px;">' + icon + '</span>' +
      '<span style="flex:1;min-width:0;"><span style="font-size:12.5px;font-weight:600;color:#fff;">' + esc(name || '—') + '</span>' +
        (sub ? '<br><span style="font-size:10.5px;color:var(--text-dim,#8a93a6);">' + esc(sub) + '</span>' : '') + '</span>' +
      '<span style="font-family:monospace;font-size:13px;font-weight:700;color:' + col + ';white-space:nowrap;">' + (miles != null ? miles + ' mi' : '—') + '</span></div>';
  }
  function safetyHtml(b) {
    var rows = '';
    if (b.hospital && !b.hospital.error) rows += safRow('✚', b.hospital.name, 'Nearest ER / hospital', b.hospital.miles, 'er');
    if (b.fire && !b.fire.error) rows += safRow('🚒', b.fire.name, 'Fire / rescue', b.fire.miles, 'fire');
    if (!rows) {
      // Distinguish an API/network problem from a genuinely empty result so a
      // blocked Places key doesn't read as "there are no hospitals nearby".
      var errd = (b.hospital && b.hospital.error) || (b.fire && b.fire.error);
      return safetyShell(errd ? 'Nearby-services lookup unavailable right now.' : 'No nearby services found.');
    }
    return '<div style="border:1px solid rgba(79,209,197,.25);border-radius:10px;overflow:hidden;">' +
      '<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#4fd1c5;border-bottom:1px solid rgba(79,209,197,.18);">🛡️ Safety · nearest services' +
        (b.property && b.property.address ? '<span style="margin-left:auto;font-size:10px;text-transform:none;letter-spacing:0;color:var(--text-dim,#8a93a6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52%;">' + esc(b.property.address) + '</span>' : '') +
      '</div><div style="padding:4px 12px 10px;">' + rows + '</div></div>';
  }
  function loadSafety(id, mapCtx) {
    var host = document.getElementById('clientDoss_safety');
    if (!host) return;
    host.innerHTML = safetyShell('Finding nearest ER, fire & rescue…');
    authedGet('/api/clients/' + encodeURIComponent(id) + '/nearby-safety').then(function (res) {
      var b = (res && res.body) || {};
      if (!res.ok) { host.innerHTML = ''; return; }
      if (b.ok === false) {
        var msg = b.reason === 'no_address' ? 'Add a property address to see nearby ER / fire.'
          : b.reason === 'geocode_failed' ? 'Could not locate the property address.'
          : 'Nearby services unavailable.';
        host.innerHTML = safetyShell(msg); return;
      }
      host.innerHTML = safetyHtml(b);
      renderSafetyMap(b, mapCtx);
    }).catch(function () { host.innerHTML = ''; });
  }

  // Drop property + safety pins on the dossier map. If the client has no
  // plotted leads/jobs (no map yet), mount one anchored on the property —
  // this is the "map + safety pins at the top of the dossier" view. Purely
  // progressive: any failure leaves the dossier as-is.
  function renderSafetyMap(b, ctx) {
    try {
      if (!window.p86EntitiesMap) return;
      var pins = [];
      if (b.property && b.property.lat != null) pins.push({ lat: b.property.lat, lng: b.property.lng, glyph: '⌂', color: '#4f46e5', title: b.property.address || 'Property' });
      if (b.hospital && !b.hospital.error && b.hospital.lat != null) pins.push({ lat: b.hospital.lat, lng: b.hospital.lng, glyph: 'H', color: '#ef4444', title: (b.hospital.name || 'Hospital') + (b.hospital.miles != null ? ' · ' + b.hospital.miles + ' mi' : '') });
      if (b.fire && !b.fire.error && b.fire.lat != null) pins.push({ lat: b.fire.lat, lng: b.fire.lng, glyph: 'FD', color: '#f59e0b', title: (b.fire.name || 'Fire / rescue') + (b.fire.miles != null ? ' · ' + b.fire.miles + ' mi' : '') });
      if (!pins.length) return;
      var mapEl = document.getElementById('clientDashboard_map');
      if (!mapEl) {
        var grid = document.getElementById('clientDoss_mapgrid');
        if (!grid) return; // dossier was closed before safety arrived
        grid.style.gridTemplateColumns = '2fr 1fr';
        var col = document.createElement('div');
        col.innerHTML = '<div style="font-size:13px;font-weight:600;color:#fff;margin-bottom:8px;">Map</div>' +
          '<div id="clientDashboard_map" style="position:relative;height:300px;border:1px solid var(--border,#2a2f3a);border-radius:10px;overflow:hidden;"></div>';
        grid.insertBefore(col, grid.firstChild);
      }
      window.p86EntitiesMap.render('clientDashboard_map', {
        items: (ctx && ctx.items) || { leads: [], jobs: [] },
        extraPins: pins
      });
    } catch (e) { /* map is a bonus layer — never break the dossier */ }
  }

  function render(host, d) {
    var c = d.client || {}, s = d.summary || {}, jobs = d.jobs || [], leads = d.leads || [];
    var mapItems = {
      leads: leads.filter(function (l) { return l.lat != null && l.lng != null; }).map(function (l) { return { id: l.id, title: l.title, lat: l.lat, lng: l.lng, kind: 'lead', status: l.status }; }),
      jobs: jobs.filter(function (j) { return j.lat != null && j.lng != null; }).map(function (j) { return { id: j.id, title: (j.jobNumber ? j.jobNumber + ' — ' : '') + (j.title || ''), lat: j.lat, lng: j.lng, kind: 'job', status: j.status, jobNumber: j.jobNumber }; })
    };
    var hasMap = (mapItems.leads.length + mapItems.jobs.length) > 0 && !!window.p86EntitiesMap;
    var actHtml = (d.activity || []).length ? (d.activity || []).map(function (a) {
      var icon = a.type === 'job' ? '🔧' : (a.type === 'lead' ? '🎯' : '📝');
      var when = ''; try { if (a.when) when = new Date(a.when).toLocaleDateString(); } catch (e) {}
      return '<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border,#23262e);font-size:12px;align-items:flex-start;"><span>' + icon + '</span><span style="color:#cdd;flex:1;">' + esc(a.label) + '</span><span style="color:var(--text-dim,#8a93a6);white-space:nowrap;">' + esc(when) + '</span></div>';
    }).join('') : '<div style="color:var(--text-dim,#8a93a6);font-size:12px;padding:10px;">No recent activity.</div>';
    var h = HEALTH[(s.health && s.health.tier) || 'healthy'] || HEALTH.healthy;
    var html = '';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
        heatGauge(s.heat, s.heatLabel) +
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
    if (c.property_address || c.market) contacts += '<span style="font-size:12px;color:var(--text-dim,#8a93a6);">' + (window.p86Icon ? window.p86Icon('map-pin') + ' ' : '') + esc([c.market, c.property_address].filter(Boolean).join(' · ')) + '</span>';
    if (contacts) html += '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px;">' + contacts + '</div>';

    html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;">' +
      card('Jobs', (s.jobCount || 0), '#fff') +
      card('Contract', money(s.contractValue), '#4f8cff') +
      card('Costs', money(s.costs), '#fbbf24') +
      card('Revenue', money(s.revenue), '#34d399') +
      card('Margin', pct(s.margin), (s.margin != null && s.margin < 0.15) ? '#f87171' : '#34d399') +
      card('Open Leads', (s.openLeads || 0), '#a78bfa', money(s.pipelineValue) + ' pipeline') +
    '</div>';

    // Property-intel: nearest-safety block (filled async by loadSafety).
    html += '<div id="clientDoss_safety" style="margin-bottom:18px;"></div>';

    html += '<div id="clientDoss_mapgrid" style="display:grid;grid-template-columns:' + (hasMap ? '2fr 1fr' : '1fr') + ';gap:16px;margin-bottom:18px;">';
    if (hasMap) html += '<div><div style="font-size:13px;font-weight:600;color:#fff;margin-bottom:8px;">Map</div><div id="clientDashboard_map" style="height:300px;border:1px solid var(--border,#2a2f3a);border-radius:10px;overflow:hidden;"></div></div>';
    html += '<div><div style="font-size:13px;font-weight:600;color:#fff;margin-bottom:8px;">Recent activity</div>' + actHtml + '</div></div>';

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
    if (hasMap) { try { window.p86EntitiesMap.render('clientDashboard_map', { items: mapItems }); } catch (e) {} }
    loadSafety(c.id, { items: mapItems });
  }

  // The open dossier's client id — read by router.js so /clients/:id
  // deep-links round-trip through the READ-ONLY dossier (the edit modal
  // is transient and deliberately not URL-addressable).
  var _openId = null;

  function openClientDashboard(id) {
    var host = document.getElementById('clientDashboard_body');
    if (!host) return;
    _openId = id;
    host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#8a93a6);">Loading client dashboard…</div>';
    show('clientDashboardModal');
    authedGet('/api/clients/' + encodeURIComponent(id) + '/dashboard').then(function (res) {
      if (!res.ok) { host.innerHTML = '<div style="padding:30px;color:#f87171;">Could not load dashboard: ' + esc((res.body && res.body.error) || 'server error') + '</div>'; return; }
      render(host, res.body);
    }).catch(function (e) { host.innerHTML = '<div style="padding:30px;color:#f87171;">Error: ' + esc(e && e.message) + '</div>'; });
  }
  function closeClientDashboard() { _openId = null; hide('clientDashboardModal'); }
  function openClientDashboardEdit(id) { closeClientDashboard(); if (typeof window.openEditClientModal === 'function') window.openEditClientModal(id); }

  window.openClientDashboard = openClientDashboard;
  window.closeClientDashboard = closeClientDashboard;
  window.openClientDashboardEdit = openClientDashboardEdit;
  window.p86ClientDossier = { getOpenId: function () { return _openId; } };
})();
