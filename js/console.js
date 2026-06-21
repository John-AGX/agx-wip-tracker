// Project 86 — Command Center (system_admin only).
//
// The platform-owner surface, distinct from the per-org admin tab. Reads:
// headline counts, cross-org AI activity + estimated spend, tenant registry,
// privileged-action audit trail. Writes (CC-5b): create/invite/archive
// tenants, delete account-wide Anthropic Skills — all hitting the existing
// requireSystemAdmin endpoints, each of which audit-logs server-side.
// Mounted as a top-level tab by app.js (renderConsoleInto), gated client-side
// to system_admin. 86 is untouched — this is a console, not an agent.
(function () {
  'use strict';

  function authHeaders(json) {
    var token = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken())
      || localStorage.getItem('p86-auth-token') || '';
    var h = { 'Accept': 'application/json' };
    if (json) h['Content-Type'] = 'application/json';
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }
  function parseRes(r) {
    return r.text().then(function (t) {
      var j; try { j = t ? JSON.parse(t) : {}; } catch (_) { j = { raw: t }; }
      if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
      return j;
    });
  }
  function cget(path) {
    if (window.p86Api && typeof window.p86Api.get === 'function') return window.p86Api.get(path);
    return fetch(path, { headers: authHeaders(false), credentials: 'same-origin' }).then(parseRes);
  }
  function cpost(path, body) {
    return fetch(path, { method: 'POST', headers: authHeaders(true), credentials: 'same-origin', body: JSON.stringify(body || {}) }).then(parseRes);
  }
  function cdel(path) {
    return fetch(path, { method: 'DELETE', headers: authHeaders(false), credentials: 'same-origin' }).then(parseRes);
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
  function toast(msg, isErr) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;' +
      'padding:10px 16px;border-radius:8px;font-size:13px;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.4);' +
      'background:' + (isErr ? '#b3261e' : '#2e7d32') + ';';
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 400); }, 2600);
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
          '<div style="font-size:12.5px;color:var(--text-dim,#9a9aa2);margin-top:3px;">Platform owner · system administrator · pick a section from the ⚙ Command Center menu in the sidebar.</div>' +
        '</div>' +
        // One section shown at a time, driven by the sidebar Command Center
        // dropdown (switchConsoleSubTab). The platform service views
        // (anthropic/email/btmapping/settings) mount the existing
        // host-parameterized admin.js renderers — single source of truth.
        '<div id="cc-overview"  class="cc-section" style="display:none;"></div>' +
        '<div id="cc-metrics"   class="cc-section" style="display:none;"></div>' +
        '<div id="cc-tenants"   class="cc-section" style="display:none;"></div>' +
        '<div id="cc-audit"     class="cc-section" style="display:none;"></div>' +
        '<div id="cc-anthropic" class="cc-section" style="display:none;"></div>' +
        '<div id="cc-email"     class="cc-section" style="display:none;"></div>' +
        '<div id="cc-btmapping" class="cc-section" style="display:none;"></div>' +
        '<div id="cc-settings"  class="cc-section" style="display:none;"></div>' +
        '<div id="cc-danger"    class="cc-section" style="display:none;"></div>' +
      '</div>';
    // Land on the last-viewed section (persisted) or Overview by default.
    var initial = 'overview';
    try { var saved = sessionStorage.getItem('agx_console_tab'); if (saved && CONSOLE_VIEWS.indexOf(saved) >= 0) initial = saved; } catch (e) {}
    switchConsoleSubTab(initial);
  }

  // The platform sub-views, in sidebar order.
  var CONSOLE_VIEWS = ['overview', 'metrics', 'tenants', 'audit', 'anthropic', 'email', 'btmapping', 'settings', 'danger'];

  // Each view's loader. The system-service views mount the existing
  // host-parameterized admin.js renderers (re-runs fresh each visit).
  function loadConsoleView(view) {
    if (view === 'overview') return loadOverview();
    if (view === 'metrics') return loadMetrics();
    if (view === 'tenants') return loadTenants();
    if (view === 'audit') return loadAudit();
    if (view === 'anthropic') return mountSystem('cc-anthropic', 'cc-anthropic-host', '🌐 Anthropic resources', window.renderSystemAnthropic);
    if (view === 'email') return mountSystem('cc-email', 'cc-email-host', '✉ Email provider', window.renderSystemEmailProvider);
    if (view === 'btmapping') return mountSystem('cc-btmapping', 'cc-btmapping-host', '🔗 Buildertrend cost-code mapping', window.renderSystemBTMapping);
    if (view === 'settings') return mountSystem('cc-settings', 'cc-settings-host', '🔧 Platform settings', window.renderSystemSettings);
    if (view === 'danger') return mountSystem('cc-danger', 'cc-danger-host', '⚠ Danger Zone — reset workspace data', window.renderSystemDanger);
  }

  // Show one section at a time — mirrors switchAdminSubTab. Toggles the sidebar
  // child active state, hides every .cc-section, reveals + (re)loads the
  // target, persists the choice, and syncs the sidebar highlight.
  function switchConsoleSubTab(view) {
    if (CONSOLE_VIEWS.indexOf(view) < 0) view = 'overview';
    var target = document.getElementById('cc-' + view);
    if (!target) {
      // Console chrome not built yet (child clicked from another tab) —
      // persist the desired view and render; renderConsoleInto reads
      // agx_console_tab and lands on it.
      try { sessionStorage.setItem('agx_console_tab', view); } catch (e) {}
      var host = document.getElementById('consolePageHost');
      if (host && typeof window.renderConsoleInto === 'function') window.renderConsoleInto(host);
      return;
    }
    document.querySelectorAll('[data-console-subtab]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-console-subtab') === view);
    });
    document.querySelectorAll('#consolePageHost .cc-section').forEach(function (s) { s.style.display = 'none'; });
    target.style.display = 'block';
    loadConsoleView(view);
    try { sessionStorage.setItem('agx_console_tab', view); } catch (e) {}
    if (typeof window.markVirtualTabActive === 'function') window.markVirtualTabActive('console-' + view);
  }

  function sectionTitle(t, right) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;margin:0 2px 8px;gap:10px;">' +
      '<div style="font-size:14px;font-weight:600;color:var(--text,#e8e8ea);">' + esc(t) + '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' + (right || '') + '</div></div>';
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
  function btn(label, attrs) {
    return '<button ' + (attrs || '') + ' style="font-size:12px;padding:5px 11px;border-radius:7px;cursor:pointer;' +
      'background:var(--accent,#4f8cff);color:#fff;border:none;">' + esc(label) + '</button>';
  }
  function ghostBtn(label, attrs) {
    return '<button ' + (attrs || '') + ' style="font-size:11.5px;padding:4px 9px;border-radius:6px;cursor:pointer;' +
      'background:transparent;color:var(--text-dim,#aaa);border:1px solid var(--border,#44444c);">' + esc(label) + '</button>';
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
    function rangeToggle() {
      return '<span style="font-size:11.5px;">' +
        '<a href="#" data-cc-range="7d" style="color:' + (_range === '7d' ? 'var(--accent,#7c9cff)' : 'var(--text-dim,#888)') + ';text-decoration:none;margin-right:8px;">7d</a>' +
        '<a href="#" data-cc-range="30d" style="color:' + (_range === '30d' ? 'var(--accent,#7c9cff)' : 'var(--text-dim,#888)') + ';text-decoration:none;">30d</a></span>';
    }
    function wire() {
      el.querySelectorAll('[data-cc-range]').forEach(function (a) {
        a.addEventListener('click', function (ev) { ev.preventDefault(); _range = a.getAttribute('data-cc-range'); loadMetrics(); });
      });
    }
    el.innerHTML = sectionTitle('Cross-org AI activity', rangeToggle()) + '<div style="color:var(--text-dim,#888);font-size:12px;padding:4px;">Loading…</div>';
    wire();
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
      el.innerHTML = sectionTitle('Cross-org AI activity', rangeToggle() +
          '<span style="font-size:11.5px;color:var(--text-dim,#888);">est. total ' + money(d.total_est_cost_usd) + '</span>') +
        panel('<table style="width:100%;border-collapse:collapse;font-size:12.5px;">' + head + body + '</table>') +
        '<div style="font-size:10.5px;color:var(--text-dim,#777);margin:6px 2px 0;">Cost is estimated from token counts at Opus 4.8 list rates — directional, not billed totals.</div>';
      wire();
    }).catch(function (e) { el.innerHTML = sectionTitle('Cross-org AI activity') + errBox('metrics', e); });
  }

  function loadTenants() {
    var el = document.getElementById('cc-tenants');
    if (!el) return;
    var actions = btn('+ New org', 'id="cc-neworg"') + ' ' + ghostBtn('Invite owner', 'id="cc-invite"');
    el.innerHTML = sectionTitle('Tenants', actions) +
      '<div id="cc-tenant-form"></div>' +
      '<div id="cc-tenant-list"><div style="color:var(--text-dim,#888);font-size:12px;padding:4px;">Loading…</div></div>';
    wireTenantActions();
    refreshTenantList();
  }

  function wireTenantActions() {
    var nb = document.getElementById('cc-neworg');
    var ib = document.getElementById('cc-invite');
    if (nb) nb.addEventListener('click', function () { showTenantForm('create'); });
    if (ib) ib.addEventListener('click', function () { showTenantForm('invite'); });
  }

  function showTenantForm(kind) {
    var f = document.getElementById('cc-tenant-form');
    if (!f) return;
    var fieldStyle = 'width:100%;box-sizing:border-box;padding:7px 9px;margin-top:4px;border-radius:7px;border:1px solid var(--border,#44444c);background:var(--bg,#15151a);color:var(--text,#e8e8ea);font-size:13px;';
    var labelStyle = 'font-size:11.5px;color:var(--text-dim,#9a9aa2);';
    if (kind === 'create') {
      f.innerHTML = '<div style="background:var(--panel,#1c1c22);border:1px solid var(--border,#33333a);border-radius:10px;padding:14px;margin-bottom:10px;">' +
        '<div style="font-weight:600;font-size:13px;margin-bottom:8px;">Create a tenant organization</div>' +
        '<label style="' + labelStyle + '">Slug (lowercase, used in URLs)<input id="cc-org-slug" style="' + fieldStyle + '" placeholder="acme"></label>' +
        '<label style="' + labelStyle + 'display:block;margin-top:8px;">Name<input id="cc-org-name" style="' + fieldStyle + '" placeholder="Acme Contracting"></label>' +
        '<div style="margin-top:10px;display:flex;gap:8px;">' + btn('Create', 'id="cc-org-submit"') + ghostBtn('Cancel', 'id="cc-org-cancel"') + '</div></div>';
      document.getElementById('cc-org-cancel').addEventListener('click', function () { f.innerHTML = ''; });
      document.getElementById('cc-org-submit').addEventListener('click', function () {
        var slug = (document.getElementById('cc-org-slug').value || '').trim();
        var name = (document.getElementById('cc-org-name').value || '').trim();
        if (!slug || !name) { toast('Slug and name are required', true); return; }
        cpost('/api/admin/organizations', { slug: slug, name: name }).then(function () {
          toast('Organization created'); f.innerHTML = ''; refreshTenantList(); loadOverview();
        }).catch(function (e) { toast(e.message || 'Create failed', true); });
      });
    } else {
      f.innerHTML = '<div style="background:var(--panel,#1c1c22);border:1px solid var(--border,#33333a);border-radius:10px;padding:14px;margin-bottom:10px;">' +
        '<div style="font-weight:600;font-size:13px;margin-bottom:8px;">Invite an org owner</div>' +
        '<label style="' + labelStyle + '">Owner email<input id="cc-inv-email" style="' + fieldStyle + '" placeholder="owner@acme.com"></label>' +
        '<label style="' + labelStyle + 'display:block;margin-top:8px;">Org name<input id="cc-inv-org" style="' + fieldStyle + '" placeholder="Acme Contracting"></label>' +
        '<div style="margin-top:10px;display:flex;gap:8px;">' + btn('Send invite', 'id="cc-inv-submit"') + ghostBtn('Cancel', 'id="cc-inv-cancel"') + '</div></div>';
      document.getElementById('cc-inv-cancel').addEventListener('click', function () { f.innerHTML = ''; });
      document.getElementById('cc-inv-submit').addEventListener('click', function () {
        var email = (document.getElementById('cc-inv-email').value || '').trim();
        var org = (document.getElementById('cc-inv-org').value || '').trim();
        if (!email || !org) { toast('Email and org name are required', true); return; }
        cpost('/api/admin/organizations/invites', { email: email, org_name: org }).then(function (d) {
          toast('Invite sent'); f.innerHTML = '';
          if (d && d.accept_url) { try { navigator.clipboard.writeText(d.accept_url); toast('Accept link copied to clipboard'); } catch (_) {} }
        }).catch(function (e) { toast(e.message || 'Invite failed', true); });
      });
    }
  }

  function refreshTenantList() {
    var el = document.getElementById('cc-tenant-list');
    if (!el) return;
    cget('/api/admin/organizations').then(function (d) {
      var orgs = (d && (d.organizations || d.orgs)) || [];
      var rows = orgs.map(function (o) {
        var archived = !!o.archived_at;
        var archiveBtn = archived ? '' : ghostBtn('Archive', 'data-cc-archive="' + esc(o.id) + '" data-cc-orgname="' + esc(o.name || o.slug || o.id) + '"');
        return '<tr>' +
          '<td style="padding:7px 10px;">' + esc(o.name || o.slug || ('org ' + o.id)) + '</td>' +
          '<td style="padding:7px 10px;color:var(--text-dim,#9a9aa2);">' + esc(o.slug || '') + '</td>' +
          '<td style="padding:7px 10px;color:var(--text-dim,#9a9aa2);">' + esc(o.plan_key || o.plan || 'internal') + '</td>' +
          '<td style="padding:7px 10px;color:' + (archived ? 'var(--text-dim,#888)' : 'var(--success,#5c9)') + ';">' + (archived ? 'archived' : 'active') + '</td>' +
          '<td style="padding:7px 10px;text-align:right;">' + archiveBtn + '</td>' +
          '</tr>';
      }).join('');
      el.innerHTML = panel('<table style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
        '<tr style="font-size:11px;color:var(--text-dim,#9a9aa2);text-transform:uppercase;letter-spacing:.03em;">' +
        '<th style="padding:8px 10px;text-align:left;">Name</th><th style="padding:8px 10px;text-align:left;">Slug</th>' +
        '<th style="padding:8px 10px;text-align:left;">Plan</th><th style="padding:8px 10px;text-align:left;">Status</th>' +
        '<th style="padding:8px 10px;"></th></tr>' +
        (rows || '<tr><td colspan="5" style="padding:14px;color:var(--text-dim,#888);">No organizations.</td></tr>') + '</table>');
      el.querySelectorAll('[data-cc-archive]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-cc-archive');
          var nm = b.getAttribute('data-cc-orgname');
          if (!window.confirm('Archive "' + nm + '"? Its users can no longer sign in. Data is retained.')) return;
          cdel('/api/admin/organizations/' + encodeURIComponent(id)).then(function () {
            toast('Organization archived'); refreshTenantList(); loadOverview();
          }).catch(function (e) { toast(e.message || 'Archive failed', true); });
        });
      });
    }).catch(function (e) { el.innerHTML = errBox('tenants', e); });
  }

  // Mount a platform-service sub-view migrated from the old admin "⚙ System"
  // sub-tab. The admin.js renderers (renderSystemAnthropic / EmailProvider /
  // BTMapping / Settings) are host-parameterized and build their own sub-DOM,
  // so we hand each one its own host div under a Command-Center section title.
  function mountSystem(wrapId, hostId, title, fn) {
    var wrap = document.getElementById(wrapId);
    if (!wrap) return;
    wrap.innerHTML = sectionTitle(title) + '<div id="' + hostId + '"></div>';
    var host = document.getElementById(hostId);
    if (!host) return;
    if (typeof fn !== 'function') {
      host.innerHTML = '<div style="padding:14px;color:var(--text-dim,#888);font-size:12px;">This panel isn\'t available — the admin module hasn\'t loaded.</div>';
      return;
    }
    try { fn(host); }
    catch (e) { host.innerHTML = errBox(title, e); }
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
  window.switchConsoleSubTab = switchConsoleSubTab;
})();
