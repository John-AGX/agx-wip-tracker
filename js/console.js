// Project 86 — Command Center (system_admin only).
//
// The platform-owner surface, distinct from the per-org admin tab. Read-only
// in Phase 1: headline platform counts, cross-org AI activity + estimated
// spend, the privileged-action audit trail, and the tenant registry. All data
// comes from /api/admin/console/* (requireSystemAdmin) + the existing
// /api/admin/organizations list. Mounted as a top-level tab by app.js
// (renderConsoleInto) and gated client-side to system_admin.
(function () {
  'use strict';

  // ── authed GET, reusing p86Api when present, bearer fallback otherwise ──
  function cget(path) {
    if (window.p86Api && typeof window.p86Api.get === 'function') {
      return window.p86Api.get(path);
    }
    var token = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken())
      || localStorage.getItem('p86-auth-token') || '';
    var headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(path, { headers: headers, credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + (t ? ': ' + t.slice(0, 200) : '')); });
      return r.json();
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) { return (Number(n) || 0).toLocaleString(); }
  function money(n) { return '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function tokK(n) { var v = Number(n) || 0; return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : String(v); }
  function ago(ts) {
    if (!ts) return '';
    var d = new Date(ts), s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return d.toLocaleString();
  }

  var _range = '7d';

  function renderConsoleInto(host) {
    if (!host) return;
    if (!(window.p86Auth && window.p86Auth.isSystemAdmin && window.p86Auth.isSystemAdmin())) {
      host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#888);">Command Center is restricted to the platform owner (system administrator).</div>';
      return;
    }
    host.innerHTML =
      '<div class="cc-wrap" style="max-width:1100px;margin:0 auto;padding:8px 4px 40px;">' +
        '<div class="cc-header" style="border-radius:12px;padding:18px 22px;margin-bottom:18px;' +
          'background:linear-gradient(135deg,rgba(124,58,237,0.16),rgba(79,140,255,0.14));' +
          'border:1px solid rgba(124,58,237,0.35);">' +
          '<div style="font-size:20px;font-weight:600;color:var(--text,#e8e8ea);">⚙ Project 86 — Command Center</div>' +
          '<div style="font-size:12.5px;color:var(--text-dim,#9a9aa2);margin-top:3px;">Platform owner · system administrator · every privileged action is logged below.</div>' +
        '</div>' +
        '<div id="cc-overview" style="margin-bottom:22px;"></div>' +
        '<div id="cc-metrics" style="margin-bottom:22px;"></div>' +
        '<div id="cc-tenants" style="margin-bottom:22px;"></div>' +
        '<div id="cc-audit"></div>' +
      '</div>';
    loadOverview();
    loadMetrics();
    loadTenants();
    loadAudit();
  }

  function sectionTitle(t, right) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;margin:0 2px 8px;">' +
      '<div style="font-size:14px;font-weight:600;color:var(--text,#e8e8ea);">' + esc(t) + '</div>' +
      '<div>' + (right || '') + '</div></div>';
  }
  function card(label, value, sub) {
    return '<div style="flex:1;min-width:120px;background:var(--panel,#1c1c22);border:1px solid var(--border,#33333a);' +
      'border-radius:10px;padding:12px 14px;">' +
      '<div style="font-size:22px;font-weight:600;color:var(--text,#e8e8ea);">' + esc(value) + '</div>' +
      '<div style="font-size:11.5px;color:var(--text-dim,#9a9aa2);margin-top:2px;">' + esc(label) + '</div>' +
      (sub ? '<div style="font-size:10.5px;color:var(--text-dim,#888);margin-top:1px;">' + esc(sub) + '</div>' : '') +
      '</div>';
  }
  function panel(inner) {
    return '<div style="background:var(--panel,#1c1c22);border:1px solid var(--border,#33333a);border-radius:10px;overflow:hidden;">' + inner + '</div>';
  }
  function errBox(where, e) {
    return '<div style="padding:14px;color:var(--danger,#e66);font-size:12.5px;">Couldn\'t load ' + esc(where) + ': ' + esc((e && e.message) || e) + '</div>';
  }

  function loadOverview() {
    var el = document.getElementById('cc-overview');
    if (!el) return;
    el.innerHTML = sectionTitle('Platform overview') + '<div style="color:var(--text-dim,#888);font-size:12px;padding:4px;">Loading…</div>';
    cget('/api/admin/console/overview').then(function (d) {
      var o = (d && d.overview) || {};
      el.innerHTML = sectionTitle('Platform overview') +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
          card('Organizations', num(o.orgs)) +
          card('Active users', num(o.active_users), num(o.total_users) + ' total') +
          card('Jobs', num(o.jobs)) +
          card('Estimates', num(o.estimates)) +
          card('Leads', num(o.leads)) +
          card('Audit events', num(o.audit_events_7d), 'last 7 days') +
        '</div>';
    }).catch(function (e) { el.innerHTML = sectionTitle('Platform overview') + errBox('overview', e); });
  }

  function loadMetrics() {
    var el = document.getElementById('cc-metrics');
    if (!el) return;
    var toggle = '<span style="font-size:11.5px;">' +
      '<a href="#" data-cc-range="7d" style="color:' + (_range === '7d' ? 'var(--accent,#7c9cff)' : 'var(--text-dim,#888)') + ';text-decoration:none;margin-right:8px;">7d</a>' +
      '<a href="#" data-cc-range="30d" style="color:' + (_range === '30d' ? 'var(--accent,#7c9cff)' : 'var(--text-dim,#888)') + ';text-decoration:none;">30d</a></span>';
    el.innerHTML = sectionTitle('Cross-org AI activity', toggle) + '<div style="color:var(--text-dim,#888);font-size:12px;padding:4px;">Loading…</div>';
    el.querySelectorAll('[data-cc-range]').forEach(function (a) {
      a.addEventListener('click', function (ev) { ev.preventDefault(); _range = a.getAttribute('data-cc-range'); loadMetrics(); });
    });
    cget('/api/admin/console/metrics?range=' + encodeURIComponent(_range)).then(function (d) {
      var orgs = (d && d.orgs) || [];
      var rows = orgs.map(function (r) {
        return '<tr>' +
          '<td style="padding:7px 10px;">' + esc(r.org_name || ('org ' + (r.organization_id == null ? '—' : r.organization_id))) + '</td>' +
          '<td style="padding:7px 10px;text-align:right;">' + num(r.turns) + '</td>' +
          '<td style="padding:7px 10px;text-align:right;">' + num(r.users) + '</td>' +
          '<td style="padding:7px 10px;text-align:right;">' + tokK(r.input_tokens) + ' / ' + tokK(r.output_tokens) + '</td>' +
          '<td style="padding:7px 10px;text-align:right;">' + num(r.tool_uses) + '</td>' +
          '<td style="padding:7px 10px;text-align:right;font-weight:600;">' + money(r.est_cost_usd) + '</td>' +
          '</tr>';
      }).join('');
      var head = '<tr style="font-size:11px;color:var(--text-dim,#9a9aa2);text-transform:uppercase;letter-spacing:.03em;">' +
        '<th style="padding:8px 10px;text-align:left;">Org</th><th style="padding:8px 10px;text-align:right;">Turns</th>' +
        '<th style="padding:8px 10px;text-align:right;">Users</th><th style="padding:8px 10px;text-align:right;">Tokens in/out</th>' +
        '<th style="padding:8px 10px;text-align:right;">Tool uses</th><th style="padding:8px 10px;text-align:right;">Est. cost</th></tr>';
      var body = rows || '<tr><td colspan="6" style="padding:14px;color:var(--text-dim,#888);">No AI activity in this window.</td></tr>';
      el.innerHTML = sectionTitle('Cross-org AI activity', toggle +
          ' <span style="font-size:11.5px;color:var(--text-dim,#888);">est. total ' + money(d.total_est_cost_usd) + '</span>') +
        panel('<table style="width:100%;border-collapse:collapse;font-size:12.5px;">' + head + body + '</table>') +
        '<div style="font-size:10.5px;color:var(--text-dim,#777);margin:6px 2px 0;">Cost is estimated from token counts at Opus 4.8 list rates — directional, not billed totals.</div>';
      el.querySelectorAll('[data-cc-range]').forEach(function (a) {
        a.addEventListener('click', function (ev) { ev.preventDefault(); _range = a.getAttribute('data-cc-range'); loadMetrics(); });
      });
    }).catch(function (e) { el.innerHTML = sectionTitle('Cross-org AI activity') + errBox('metrics', e); });
  }

  function loadTenants() {
    var el = document.getElementById('cc-tenants');
    if (!el) return;
    el.innerHTML = sectionTitle('Tenants') + '<div style="color:var(--text-dim,#888);font-size:12px;padding:4px;">Loading…</div>';
    cget('/api/admin/organizations').then(function (d) {
      var orgs = (d && (d.organizations || d.orgs)) || [];
      var rows = orgs.map(function (o) {
        return '<tr>' +
          '<td style="padding:7px 10px;">' + esc(o.name || o.slug || ('org ' + o.id)) + '</td>' +
          '<td style="padding:7px 10px;color:var(--text-dim,#9a9aa2);">' + esc(o.slug || '') + '</td>' +
          '<td style="padding:7px 10px;color:var(--text-dim,#9a9aa2);">' + esc(o.plan_key || o.plan || 'internal') + '</td>' +
          '<td style="padding:7px 10px;color:' + (o.archived_at ? 'var(--text-dim,#888)' : 'var(--success,#5c9)') + ';">' + (o.archived_at ? 'archived' : 'active') + '</td>' +
          '</tr>';
      }).join('');
      el.innerHTML = sectionTitle('Tenants', '<span style="font-size:11.5px;color:var(--text-dim,#888);">' + orgs.length + ' org' + (orgs.length === 1 ? '' : 's') + '</span>') +
        panel('<table style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
          '<tr style="font-size:11px;color:var(--text-dim,#9a9aa2);text-transform:uppercase;letter-spacing:.03em;">' +
          '<th style="padding:8px 10px;text-align:left;">Name</th><th style="padding:8px 10px;text-align:left;">Slug</th>' +
          '<th style="padding:8px 10px;text-align:left;">Plan</th><th style="padding:8px 10px;text-align:left;">Status</th></tr>' +
          (rows || '<tr><td colspan="4" style="padding:14px;color:var(--text-dim,#888);">No organizations.</td></tr>') + '</table>');
    }).catch(function (e) { el.innerHTML = sectionTitle('Tenants') + errBox('tenants', e); });
  }

  function loadAudit() {
    var el = document.getElementById('cc-audit');
    if (!el) return;
    el.innerHTML = sectionTitle('Audit trail') + '<div style="color:var(--text-dim,#888);font-size:12px;padding:4px;">Loading…</div>';
    cget('/api/admin/console/audit?limit=100').then(function (d) {
      var entries = (d && d.entries) || [];
      var rows = entries.map(function (a) {
        var tgt = a.target_type ? (a.target_type + (a.target_id ? ' ' + a.target_id : '')) : '';
        return '<tr>' +
          '<td style="padding:7px 10px;color:var(--text-dim,#9a9aa2);white-space:nowrap;" title="' + esc(a.created_at) + '">' + esc(ago(a.created_at)) + '</td>' +
          '<td style="padding:7px 10px;">' + esc(a.actor_email || ('user ' + (a.actor_user_id == null ? '—' : a.actor_user_id))) + '<div style="font-size:10.5px;color:var(--text-dim,#888);">' + esc(a.actor_role || '') + '</div></td>' +
          '<td style="padding:7px 10px;"><code style="font-size:11.5px;color:var(--accent,#7c9cff);">' + esc(a.action) + '</code></td>' +
          '<td style="padding:7px 10px;color:var(--text-dim,#bbb);">' + esc(tgt) + (a.org_name ? '<div style="font-size:10.5px;color:var(--text-dim,#888);">' + esc(a.org_name) + '</div>' : '') + '</td>' +
          '</tr>';
      }).join('');
      el.innerHTML = sectionTitle('Audit trail', '<span style="font-size:11.5px;color:var(--text-dim,#888);">' + entries.length + ' recent</span>') +
        panel('<table style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
          '<tr style="font-size:11px;color:var(--text-dim,#9a9aa2);text-transform:uppercase;letter-spacing:.03em;">' +
          '<th style="padding:8px 10px;text-align:left;">When</th><th style="padding:8px 10px;text-align:left;">Actor</th>' +
          '<th style="padding:8px 10px;text-align:left;">Action</th><th style="padding:8px 10px;text-align:left;">Target</th></tr>' +
          (rows || '<tr><td colspan="4" style="padding:14px;color:var(--text-dim,#888);">No privileged actions recorded yet.</td></tr>') + '</table>');
    }).catch(function (e) { el.innerHTML = sectionTitle('Audit trail') + errBox('audit log', e); });
  }

  window.renderConsoleInto = renderConsoleInto;
})();
