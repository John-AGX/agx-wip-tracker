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
  function cput(path, body) {
    return fetch(path, { method: 'PUT', headers: authHeaders(true), credentials: 'same-origin', body: JSON.stringify(body || {}) }).then(parseRes);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Only allow http(s) in an href — blocks javascript:/data: schemes from
  // research packets the Claude extension fills off arbitrary web pages.
  function safeUrl(u) {
    var s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) ? s : '';
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

  var RESTRICTED_HTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#888);">Command Center is restricted to the platform owner (system administrator).</div>';

  function renderConsoleInto(host) {
    if (!host) return;
    // Rescue the docked 86 panel BEFORE any innerHTML wipe below — a console
    // re-render (incl. same-tab re-entry via a Command Center child click)
    // would otherwise destroy the reparented singleton. undock() moves it back
    // to <body>; loadAssemblyTuning re-docks it when the studio view reopens.
    if (window.p86AI && window.p86AI.isDocked && window.p86AI.isDocked()) {
      try { window.p86AI.undock(); } catch (e) {}
    }
    var user = window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser();
    if (!user) {
      // A cold new-tab load can render this pane before /api/auth/me
      // resolves — a null user means "auth pending", NOT "not allowed".
      // Painting the restriction message here made a system_admin see
      // "restricted to the platform owner" until they refreshed. Show a
      // loading state, re-render once auth settles (auth.js dispatches
      // p86:auth-ready on window), and only fall back to the restriction
      // message if auth never settles (dead session — the login screen
      // is covering this pane anyway).
      host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#888);">Loading…</div>';
      var settled = false;
      var onReady = function () { settled = true; renderConsoleInto(host); };
      window.addEventListener('p86:auth-ready', onReady, { once: true });
      setTimeout(function () {
        if (settled) return;
        window.removeEventListener('p86:auth-ready', onReady);
        var u2 = window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser();
        if (u2) { renderConsoleInto(host); return; }
        host.innerHTML = RESTRICTED_HTML;
      }, 12000);
      return;
    }
    if (!(window.p86Auth.isSystemAdmin && window.p86Auth.isSystemAdmin())) {
      host.innerHTML = RESTRICTED_HTML;
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
        '<div id="cc-assemblies" class="cc-section" style="display:none;"></div>' +
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
  var CONSOLE_VIEWS = ['overview', 'assemblies', 'metrics', 'tenants', 'audit', 'anthropic', 'email', 'btmapping', 'settings', 'danger'];

  // Each view's loader. The system-service views mount the existing
  // host-parameterized admin.js renderers (re-runs fresh each visit).
  function loadConsoleView(view) {
    if (view === 'overview') return loadOverview();
    if (view === 'assemblies') return loadAssemblyTuning();
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
    // Leaving Assembly Studio for another Console sub-tab: pop the docked 86
    // panel back out so it isn't stranded inside a hidden section. Returning
    // re-docks it via loadAssemblyTuning -> ensureAsmDock.
    if (view !== 'assemblies' && window.p86AI && window.p86AI.isDocked && window.p86AI.isDocked()) {
      try { window.p86AI.undock(); } catch (e) {}
    }
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

  // ── Assembly Tuning Center — Cost Intelligence ─────────────────────
  // Every number shows its work: component costs render as derivation
  // chains (price × rate × waste), each factor expandable to its proof —
  // purchase history for prices, written rationale for rates. Edits save
  // with a reason and land in assembly_tuning_log (the flywheel's
  // training trail).
  var _asmT = { ov: null, sel: null, det: null, open: {} };
  // Left-rail mode + research-inbox state. mode: 'tuning' (worst-first queue) |
  // 'research' (packets the Claude extension / a paste dropped for 86 to build).
  var _asmR = { mode: 'tuning', list: [], counts: {}, sel: null, det: null, handedId: null, addOpen: false };

  // Per-turn context handed to the docked 86 pane so it knows what John is
  // looking at. open_data_summary reaches 86 via renderPageContextBlock — no
  // server context change needed. (Slice 3 adds a richer buildTurnContext branch.)
  function asmDockContext(det) {
    var a = det && det.assembly;
    if (!a) {
      return { entity_type: 'assembly', entity_id: '__global__', entity_label: 'Assembly Studio',
        open_data_summary: 'Assembly Studio — the cost-assembly database builder/tuner. No assembly selected. You OWN this database: research, build, tune, and catalog-link recipes; every change lands as an approval card and is logged to assembly_tuning_log.' };
    }
    var cost = (a.unit_cost != null) ? ('$' + Number(a.unit_cost).toFixed(2) + '/' + (a.unit || 'EA')) : 'unpriced';
    return {
      entity_type: 'assembly', entity_id: a.id, entity_label: a.name,
      open_data_summary: 'Assembly Studio — currently viewing assembly "' + a.name + '" (#' + a.id +
        ', code ' + (a.code || '—') + ', trade ' + (a.trade || '—') + '), resolved cost ' + cost + ', ' +
        ((det.items || []).length) + ' items' + (a.incomplete ? ' (has UNPRICED items)' : '') +
        '. You OWN this database — tune/build/link via approval cards; cite sources in the tuning-log evidence.'
    };
  }

  // Dock (or re-dock) the singleton 86 panel into the cockpit chat host,
  // pinned to 86 so it builds the DB directly. Idempotent — skips if already
  // docked into THIS host (survives sub-tab switches; re-docks after the
  // console rebuilds the shell on re-entry).
  function ensureAsmDock() {
    var chatHost = document.getElementById('cc-asm-chat');
    if (!chatHost || !(window.p86AI && typeof window.p86AI.dockInto === 'function')) return;
    var panel = document.getElementById('p86-ai-panel');
    if (!panel || panel.parentNode !== chatHost) {
      try { window.p86AI.dockInto(chatHost, { hostAgentKey: 'job', currentContext: asmDockContext(_asmT.det) }); } catch (e) {}
    }
  }

  function loadAssemblyTuning() {
    var el = document.getElementById('cc-assemblies');
    if (!el) return;
    // Build the cockpit shell ONCE so paint/refresh + assembly selection never
    // wipe the docked 86 pane (paintAsmMain only rebuilds #cc-asm-main). The
    // shell survives sub-tab switches; leaving the console wipes it (app.js
    // undocks the 86 panel first), then this rebuilds it fresh.
    if (!document.getElementById('cc-asm-main')) {
      el.innerHTML =
        sectionTitle('🧩 Assembly Studio — build & tune the cost database', ghostBtn('↻ Refresh', 'data-asmt-refresh')) +
        '<div style="display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:12px;align-items:start;">' +
          '<div id="cc-asm-main"><div style="color:var(--text-dim,#888);font-size:12px;padding:4px;">Loading…</div></div>' +
          '<div style="display:flex;flex-direction:column;gap:8px;">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);">🤖 86 — DB builder</div>' +
              '<span title="This chat is pinned to 86 (not the Assistant) so it can build/tune the DB directly" style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:9px;background:rgba(124,58,237,.16);color:#a78bfa;">PINNED TO 86</span>' +
            '</div>' +
            '<div style="font-size:10px;color:var(--text-dim,#9a9aa2);line-height:1.5;">Ask 86 to research, build, tune, or catalog-link recipes. Changes arrive as approval cards you review right here.</div>' +
            '<div id="cc-asm-chat" style="height:74vh;min-height:520px;"></div>' +
          '</div>' +
        '</div>';
      var rf = el.querySelector('[data-asmt-refresh]');
      if (rf) rf.addEventListener('click', loadAssemblyTuning);
    }
    ensureAsmDock();
    // One-time: when ANY assembly card is applied in the shared 86 pane,
    // re-sync the cockpit. We do NOT consume packets here — the server
    // consumes+links the source packet in-txn (via source_research_id on the
    // create op), so it links to exactly the assembly it was built from
    // rather than whichever card happens to land while a packet is handed.
    if (!_asmR._listenerWired) {
      _asmR._listenerWired = true;
      document.addEventListener('p86:payload-applied', function (e) {
        // Only act while Assembly Studio is the VISIBLE sub-tab — this
        // document-level listener outlives the view, #cc-asm-main persists
        // (display:none) under sibling sub-tabs, and assembly cards can be
        // approved from the global 86 drawer. Acting on a hidden studio would
        // re-dock the singleton 86 panel into a hidden host (drawer vanishes).
        var asmMain = document.getElementById('cc-asm-main');
        if (!asmMain || asmMain.offsetParent === null) return;
        var detail = e.detail || {};
        var targets = detail.affected_targets || [];
        var asmCreate = targets.find(function (t) {
          var ty = t && (t.entity_type || t.type); return ty === 'assembly' && (t.op === 'create' || !t.op);
        });
        var hitAssembly = targets.some(function (t) {
          var ty = t && (t.entity_type || t.type); return ty === 'assembly';
        });
        if (!hitAssembly) return;
        // Auto-link the handed packet to the assembly 86 just built from it.
        // The server-side path (source_research_id in the op) handles direct
        // emits; when 86 delegates to the Scribe the op field is lost, so we
        // correlate here by the EXACT applied payload id referencing this
        // packet ("research packet #<id>" in its title/summary). No blind
        // "any assembly card" guess — that would mislink in the shared pane.
        if (_asmR.handedId && asmCreate && detail.payload_id) {
          tryAutoConsumeHanded(detail.payload_id, asmCreate.entity_id || asmCreate.id, _asmR.handedId);
        }
        // Don't clear handedId on unrelated cards — loadResearchInbox retires
        // it precisely once the handed packet leaves the unprocessed list.
        loadResearchInbox();      // a consumed packet drops from unprocessed
        loadAssemblyTuning();     // refresh health tiles + queue with the new recipe
      });
    }
    cget('/api/assemblies/tuning/overview').then(function (d) {
      _asmT.ov = d;
      if (!_asmT.sel && d.queue && d.queue.length) _asmT.sel = d.queue[0].id;
      paintAsmMain();
      if (_asmT.sel) loadAsmDetail(_asmT.sel);
    }).catch(function (e) { var m = document.getElementById('cc-asm-main'); if (m) m.innerHTML = errBox('assembly tuning', e); });
  }

  function loadAsmDetail(id) {
    _asmT.sel = id; _asmT.det = null; _asmT.open = {};
    paintAsmMain();
    cget('/api/assemblies/' + id + '/tuning').then(function (d) {
      _asmT.det = d;
      paintAsmMain();
      // Tell the docked 86 which assembly is on screen.
      if (window.p86AI && typeof window.p86AI.setDockContext === 'function') {
        try { window.p86AI.setDockContext(asmDockContext(d)); } catch (e) {}
      }
    }).catch(function (e) {
      var ws = document.getElementById('cc-asm-ws');
      if (ws) ws.innerHTML = errBox('assembly detail', e);
    });
  }

  function asmFlags(q) {
    var f = [];
    if (q.flags.drift_items) f.push('<span style="font-size:8.5px;font-weight:700;padding:1px 6px;border-radius:7px;background:rgba(247,112,102,.14);color:#f77066;">DRIFT×' + q.flags.drift_items + '</span>');
    if (q.flags.seed_untuned) f.push('<span style="font-size:8.5px;font-weight:700;padding:1px 6px;border-radius:7px;background:rgba(242,165,92,.14);color:#f2a55c;">SEED</span>');
    if (q.flags.unlinked_items) f.push('<span style="font-size:8.5px;font-weight:700;padding:1px 6px;border-radius:7px;background:rgba(167,139,250,.14);color:#a78bfa;">' + q.flags.unlinked_items + ' UNLINKED</span>');
    if (!f.length) f.push('<span style="font-size:8.5px;font-weight:700;padding:1px 6px;border-radius:7px;background:rgba(74,222,128,.12);color:#4ade80;">OK</span>');
    return f.join(' ');
  }

  function paintAsmMain() {
    var el = document.getElementById('cc-asm-main');
    if (!el || !_asmT.ov) return;
    var s = _asmT.ov.stats || {};
    var tile = function (n, label, color) {
      return '<div style="flex:1;min-width:110px;background:var(--panel,#1c1c22);border:1px solid var(--border,#33333a);border-radius:10px;padding:10px 12px;">' +
        '<div style="font-size:20px;font-weight:700;font-family:Consolas,monospace;color:' + (color || 'var(--text,#e8e8ea)') + ';">' + n + '</div>' +
        '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim,#9a9aa2);margin-top:2px;">' + label + '</div></div>';
    };
    var queueHtml = (_asmT.ov.queue || []).map(function (q) {
      var sel = q.id === _asmT.sel;
      return '<div data-asmt-sel="' + q.id + '" style="padding:8px 9px;border-radius:8px;cursor:pointer;margin-bottom:4px;border:1px solid ' + (sel ? 'rgba(79,140,255,.4)' : 'transparent') + ';background:' + (sel ? 'rgba(79,140,255,.08)' : 'transparent') + ';">' +
        '<div style="font-size:12px;font-weight:600;">🧩 ' + esc(q.name) + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#9a9aa2);margin-top:2px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
          '<span style="font-family:Consolas,monospace;">$' + (Number(q.unit_cost) || 0).toFixed(2) + '/' + esc(q.unit || 'EA') + '</span>' + asmFlags(q) +
        '</div></div>';
    }).join('');

    // Left-rail mode toggle: Tuning queue ⇄ Research inbox.
    var modeBtn = function (m, label) {
      var on = _asmR.mode === m;
      return '<button data-asm-mode="' + m + '" style="border:1px solid ' + (on ? 'rgba(79,140,255,.5)' : 'var(--border,#33333a)') +
        ';background:' + (on ? 'rgba(79,140,255,.12)' : 'transparent') + ';color:' + (on ? '#7eb0ff' : 'var(--text-dim,#9a9aa2)') +
        ';border-radius:8px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;">' + label + '</button>';
    };
    var rCount = (_asmR.counts && _asmR.counts.unprocessed) || 0;
    var leftCol, wsHtml;
    if (_asmR.mode === 'research') {
      leftCol = researchListHtml();
      wsHtml = researchDetailHtml();
    } else {
      leftCol = '<div style="font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);padding:2px 6px 8px;">Tuning queue — worst first</div>' +
        (queueHtml || '<div style="padding:12px;color:var(--text-dim,#888);font-size:12px;">No assemblies yet.</div>');
      wsHtml = (_asmT.det ? asmWorkspaceHtml(_asmT.det) : '<div style="color:var(--text-dim,#888);font-size:12px;">Select an assembly from the queue.</div>');
    }
    el.innerHTML =
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">' +
        tile(s.total || 0, 'Assemblies') +
        tile(s.seed_untuned || 0, 'Seed — never tuned', s.seed_untuned ? '#f2a55c' : null) +
        tile(s.drift || 0, 'Price drift >10%', s.drift ? '#f77066' : null) +
        tile(s.unlinked_items || 0, 'Items not catalog-linked', s.unlinked_items ? '#a78bfa' : null) +
        tile(rCount, 'Research to build', rCount ? '#4fd1c5' : null) +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px;">' +
        modeBtn('tuning', '🔧 Tuning queue') +
        modeBtn('research', '📥 Research inbox' + (rCount ? ' (' + rCount + ')' : '')) +
      '</div>' +
      '<div style="display:grid;grid-template-columns:290px 1fr;gap:12px;align-items:start;">' +
        '<div style="background:var(--panel,#1c1c22);border:1px solid var(--border,#33333a);border-radius:10px;padding:8px;max-height:66vh;overflow:auto;">' + leftCol + '</div>' +
        '<div id="cc-asm-ws" style="background:var(--panel,#1c1c22);border:1px solid var(--border,#33333a);border-radius:10px;padding:14px;min-height:200px;">' + wsHtml + '</div>' +
      '</div>';

    el.querySelectorAll('[data-asm-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        _asmR.mode = b.dataset.asmMode;
        paintAsmMain();
        if (_asmR.mode === 'research' && !_asmR.list.length) loadResearchInbox();
      });
    });
    var rf = el.querySelector('[data-asmt-refresh]');
    if (rf) rf.addEventListener('click', loadAssemblyTuning);
    if (_asmR.mode === 'research') { wireResearch(el); return; }
    el.querySelectorAll('[data-asmt-sel]').forEach(function (r) {
      r.addEventListener('click', function () { loadAsmDetail(Number(r.dataset.asmtSel)); });
    });
    if (_asmT.det) wireAsmWorkspace(el);
  }

  // ── Research inbox — packets the Claude extension (or a paste) drops for 86
  // to build/tune assemblies from. ──────────────────────────────────────────
  function loadResearchInbox() {
    cget('/api/assembly-research?status=unprocessed').then(function (d) {
      _asmR.list = (d && d.research) || [];
      _asmR.counts = (d && d.counts) || {};
      // Retire the hand-off hint precisely: the handed packet is gone from the
      // unprocessed list only once the server consumed it (source_research_id).
      if (_asmR.handedId && !_asmR.list.some(function (p) { return p.id === _asmR.handedId; })) {
        _asmR.handedId = null;
      }
      if (!_asmR.sel && _asmR.list.length) _asmR.sel = _asmR.list[0].id;
      if (_asmR.mode === 'research') {
        // Load the auto-selected packet's detail so its row is not highlighted
        // over an empty detail pane (first entry + after consume/void).
        if (_asmR.sel && (!_asmR.det || _asmR.det.id !== _asmR.sel)) loadPacketDetail(_asmR.sel, true);
        else paintAsmMain();
      }
    }).catch(function (e) {
      var ws = document.getElementById('cc-asm-ws'); if (ws) ws.innerHTML = errBox('research inbox', e);
    });
  }
  // fromHeal guards against a refresh loop: a manual open of a stale row (packet
  // consumed/deleted elsewhere) drops it from the list via a refresh; the
  // auto-load that refresh triggers passes fromHeal, so a repeat 404 just shows
  // the error instead of refreshing again.
  function loadPacketDetail(id, fromHeal) {
    _asmR.sel = id; _asmR.det = null;
    if (_asmR.mode === 'research') paintAsmMain();
    cget('/api/assembly-research/' + id).then(function (d) {
      _asmR.det = (d && d.research) || null;
      if (_asmR.mode === 'research') paintAsmMain();
    }).catch(function (e) {
      _asmR.sel = null; _asmR.det = null;
      var ws = document.getElementById('cc-asm-ws'); if (ws) ws.innerHTML = errBox('packet', e);
      if (!fromHeal) loadResearchInbox();   // drop the now-stale row from the list
    });
  }
  function researchListHtml() {
    var rows = (_asmR.list || []).map(function (p) {
      var sel = p.id === _asmR.sel;
      return '<div data-asmr-sel="' + p.id + '" style="padding:8px 9px;border-radius:8px;cursor:pointer;margin-bottom:4px;border:1px solid ' +
        (sel ? 'rgba(79,209,197,.4)' : 'transparent') + ';background:' + (sel ? 'rgba(79,209,197,.08)' : 'transparent') + ';">' +
        '<div style="font-size:12px;font-weight:600;">📄 ' + esc(p.title || (p.trade ? p.trade + ' research' : 'Untitled packet')) + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#9a9aa2);margin-top:2px;">' +
          (p.trade ? esc(p.trade) + ' · ' : '') + (p.finding_count || 0) + ' finding' + (p.finding_count === 1 ? '' : 's') +
          (p.source_url ? ' · 🔗 source' : '') + '</div></div>';
    }).join('');
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:2px 6px 8px;">' +
        '<span style="font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);">Research to build</span>' +
        '<button data-asmr-add style="border:1px solid rgba(79,209,197,.4);background:rgba(79,209,197,.1);color:#4fd1c5;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600;cursor:pointer;">+ Add</button>' +
      '</div>' +
      (rows || '<div style="padding:12px;color:var(--text-dim,#888);font-size:12px;line-height:1.5;">Nothing to build yet. Drop web research here (or have the Claude extension fill it), then hand it to 86.</div>');
  }
  function researchDetailHtml() {
    if (_asmR.addOpen) return researchAddFormHtml();
    var p = _asmR.det;
    if (!p) return '<div style="color:var(--text-dim,#888);font-size:12px;">Select a research packet, or + Add one.</div>';
    var findings = Array.isArray(p.findings) ? p.findings : [];
    var fRows = findings.map(function (f) {
      return '<div style="border:1px solid var(--border,#33333a);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12px;">' +
        '<div style="font-weight:600;">' + esc(f.component || f.material || 'component') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#9a9aa2);font-family:Consolas,monospace;margin-top:2px;">' +
          (f.price != null ? '$' + esc(String(f.price)) : '?') + '/' + esc(f.unit || 'ea') +
          (f.qty_per_unit != null ? ' · qty/unit ' + esc(String(f.qty_per_unit)) : '') +
          (f.waste_pct != null ? ' · waste ' + esc(String(f.waste_pct)) + '%' : '') + '</div>' +
        (f.rationale ? '<div style="font-size:11px;color:var(--text-dim,#9a9aa2);margin-top:3px;">' + esc(f.rationale) + '</div>' : '') +
        (safeUrl(f.source_url) ? '<div style="font-size:10px;margin-top:3px;"><a href="' + esc(safeUrl(f.source_url)) + '" target="_blank" rel="noopener" style="color:#7eb0ff;">🔗 source</a></div>' : '') +
      '</div>';
    }).join('');
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">' +
        '<div style="font-size:15px;font-weight:700;">📄 ' + esc(p.title || 'Research packet') + '</div>' +
        '<div style="display:flex;gap:6px;">' +
          '<button data-asmr-hand="' + p.id + '" style="border:1px solid rgba(124,58,237,.5);background:rgba(124,58,237,.14);color:#a78bfa;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">🤖 Hand to 86</button>' +
          '<button data-asmr-consume="' + p.id + '" title="Mark this packet as built" style="border:1px solid var(--border,#33333a);background:transparent;color:var(--text-dim,#9a9aa2);border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;">✓ Built</button>' +
          '<button data-asmr-void="' + p.id + '" title="Discard" style="border:1px solid var(--border,#33333a);background:transparent;color:#f77066;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;">✕</button>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text-dim,#9a9aa2);margin-bottom:10px;">' +
        (p.trade ? esc(p.trade) : 'no trade') + (p.scope ? ' · ' + esc(p.scope) : '') +
        (safeUrl(p.source_url) ? ' · <a href="' + esc(safeUrl(p.source_url)) + '" target="_blank" rel="noopener" style="color:#7eb0ff;">🔗 source</a>' : '') +
      '</div>' +
      (findings.length ? '<div style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);margin-bottom:6px;">Structured findings</div>' + fRows : '') +
      (p.raw_text ? '<div style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);margin:10px 0 4px;">Pasted research (86 parses this)</div>' +
        '<pre style="white-space:pre-wrap;font-size:11px;line-height:1.5;color:var(--text,#e8e8ea);background:var(--bg,#15151a);border:1px solid var(--border,#33333a);border-radius:8px;padding:10px;max-height:280px;overflow:auto;">' + esc(p.raw_text) + '</pre>' : '') +
      (_asmR.handedId === p.id ? '<div style="margin-top:10px;font-size:11px;color:#a78bfa;">Handed to 86 → approve its recipe card in the pane, then this packet marks itself built.</div>' : '');
  }
  function researchAddFormHtml() {
    var inp = function (id, label, ph) {
      return '<label style="display:block;margin-bottom:8px;"><span style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim,#9a9aa2);margin-bottom:3px;">' + label + '</span>' +
        '<input id="' + id + '" placeholder="' + (ph || '') + '" style="width:100%;box-sizing:border-box;padding:6px 8px;font-size:12px;background:var(--bg,#15151a);border:1px solid var(--border,#33333a);border-radius:6px;color:var(--text,#e8e8ea);" /></label>';
    };
    return '<div style="font-size:15px;font-weight:700;margin-bottom:10px;">📥 New research packet</div>' +
      inp('asmr-title', 'Title', 'e.g. Stucco patch & repaint — Central FL') +
      inp('asmr-trade', 'Trade', 'e.g. stucco, paint, roofing') +
      inp('asmr-url', 'Source URL', 'https://…') +
      '<label style="display:block;margin-bottom:10px;"><span style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim,#9a9aa2);margin-bottom:3px;">Pasted research (freeform — 86 parses it)</span>' +
        '<textarea id="asmr-raw" rows="9" placeholder="Paste the components, prices, units, waste %, labor/productivity rates, and where they came from. The Claude extension can fill this while browsing." style="width:100%;box-sizing:border-box;padding:8px;font-size:12px;line-height:1.5;background:var(--bg,#15151a);border:1px solid var(--border,#33333a);border-radius:6px;color:var(--text,#e8e8ea);resize:vertical;"></textarea></label>' +
      '<div style="display:flex;gap:8px;">' +
        '<button data-asmr-save style="border:0;background:#4f8cff;color:#fff;border-radius:8px;padding:7px 16px;font-size:12px;font-weight:700;cursor:pointer;">Save packet</button>' +
        '<button data-asmr-cancel style="border:1px solid var(--border,#33333a);background:transparent;color:var(--text-dim,#9a9aa2);border-radius:8px;padding:7px 14px;font-size:12px;cursor:pointer;">Cancel</button>' +
      '</div>';
  }
  function wireResearch(el) {
    el.querySelectorAll('[data-asmr-sel]').forEach(function (r) {
      r.addEventListener('click', function () { _asmR.addOpen = false; loadPacketDetail(Number(r.dataset.asmrSel)); });
    });
    var add = el.querySelector('[data-asmr-add]');
    if (add) add.addEventListener('click', function () { _asmR.addOpen = true; paintAsmMain(); });
    var cancel = el.querySelector('[data-asmr-cancel]');
    if (cancel) cancel.addEventListener('click', function () { _asmR.addOpen = false; paintAsmMain(); });
    var save = el.querySelector('[data-asmr-save]');
    if (save) save.addEventListener('click', function () {
      var body = {
        title: (document.getElementById('asmr-title') || {}).value || '',
        trade: (document.getElementById('asmr-trade') || {}).value || '',
        source_url: (document.getElementById('asmr-url') || {}).value || '',
        raw_text: (document.getElementById('asmr-raw') || {}).value || ''
      };
      if (!body.title && !body.raw_text) { toast('Add a title or paste some research first', true); return; }
      cpost('/api/assembly-research', body).then(function (d) {
        _asmR.addOpen = false;
        toast('Research packet saved');
        if (d && d.research) _asmR.sel = d.research.id;
        loadResearchInbox();
      }).catch(function (e) { toast('Save failed: ' + (e.message || e), true); });
    });
    var hand = el.querySelector('[data-asmr-hand]');
    if (hand) hand.addEventListener('click', function () { handPacketTo86(Number(hand.dataset.asmrHand)); });
    var consume = el.querySelector('[data-asmr-consume]');
    if (consume) consume.addEventListener('click', function () { consumePacket(Number(consume.dataset.asmrConsume)); });
    var vd = el.querySelector('[data-asmr-void]');
    if (vd) vd.addEventListener('click', function () {
      var id = Number(vd.dataset.asmrVoid);
      cpost('/api/assembly-research/' + id + '/void', {}).then(function () {
        _asmR.sel = null; _asmR.det = null; toast('Packet discarded'); loadResearchInbox();
      }).catch(function (e) { toast('Failed: ' + (e.message || e), true); });
    });
  }
  // Hand a research packet to the docked 86 — inline the packet content in the
  // prompt (small enough) so 86 builds it into approval cards without a fetch.
  function handPacketTo86(id) {
    var p = _asmR.det;
    if (!p || p.id !== id) { toast('Open the packet first', true); return; }
    if (!(window.p86AI && typeof window.p86AI.askDocked === 'function')) { toast('86 pane not ready', true); return; }
    _asmR.handedId = id;
    var lines = [];
    lines.push('Build (or tune) assemblies from this web research packet. Draft each recipe as an approval card via scribe_write (entity_type "assembly"); link materials to our catalog where they exist; put the source URL in the tuning-log evidence/reason. Ask me before guessing at anything unclear.');
    lines.push('IMPORTANT for auto-filing: when you create the assembly, (a) set the op field "source_research_id" to ' + id + ', AND (b) include the exact text "research packet #' + id + '" in the payload title or summary. Either one lets this packet auto-link to the assembly and clear from my inbox the moment I approve.');
    lines.push('');
    lines.push('PACKET #' + p.id + (p.title ? ' — ' + p.title : '') + (p.trade ? ' [' + p.trade + ']' : ''));
    if (p.source_url) lines.push('Source: ' + p.source_url);
    var findings = Array.isArray(p.findings) ? p.findings : [];
    if (findings.length) {
      lines.push('Structured findings:');
      findings.forEach(function (f) {
        lines.push('- ' + (f.component || f.material || 'component') + ': ' + (f.price != null ? '$' + f.price : '?') + '/' + (f.unit || 'ea') +
          (f.qty_per_unit != null ? ', qty/unit ' + f.qty_per_unit : '') + (f.waste_pct != null ? ', waste ' + f.waste_pct + '%' : '') +
          (f.rationale ? ' — ' + f.rationale : '') + (f.source_url ? ' (' + f.source_url + ')' : ''));
      });
    }
    if (p.raw_text) { lines.push('Pasted research:'); lines.push(p.raw_text); }
    try { window.p86AI.askDocked(lines.join('\n')); } catch (e) {}
    paintAsmMain(); // reflect the "handed" hint
  }
  // Correlate an applied assembly card to the handed packet and consume it.
  // Deterministic: match the EXACT applied payload id, then confirm it belongs
  // to this packet (title/summary references "packet #<id>"). Never a blind
  // "any assembly card" guess. Falls back silently to the manual ✓ Built.
  function tryAutoConsumeHanded(payloadId, assemblyId, packetId) {
    if (!payloadId || !packetId) return;
    // Deterministic: fetch THIS payload by id (org-scoped). The list route
    // ignores ?status and caps at the 15 most-recent, so it would miss the
    // target in a busy org — /:id resolves it exactly.
    cget('/api/payloads/' + encodeURIComponent(payloadId)).then(function (d) {
      var pl = d && (d.payload || d);
      if (!pl || pl.id !== payloadId) return;
      var txt = String((pl.title || '') + ' ' + (pl.summary || ''));
      // word-boundaried "packet #<id>" so #1 doesn't match #12
      var re = new RegExp('packet\\s*#\\s*' + packetId + '(?!\\d)', 'i');
      // Only if still handed (the direct-emit path consumes server-side and
      // retires handedId first, so this won't double-fire there). The server
      // /consume is status='unprocessed'-guarded, so a redundant call no-ops.
      if (re.test(txt) && _asmR.handedId === packetId) {
        consumePacket(packetId, (assemblyId != null && isFinite(assemblyId)) ? assemblyId : null, true);
      }
    }).catch(function () {});
  }
  // "✓ Built" — mark a packet consumed. assemblyId links it to the built
  // recipe when known (auto-path); the manual button passes none. The server
  // org-scopes the id (out-of-org/unknown → NULL) and guards status, so a
  // redundant auto-path call can't clobber an authoritative link. silent
  // suppresses toasts + failure noise on that auto-path.
  function consumePacket(id, assemblyId, silent) {
    cpost('/api/assembly-research/' + id + '/consume', (assemblyId != null) ? { assembly_id: assemblyId } : {}).then(function () {
      if (_asmR.handedId === id) _asmR.handedId = null;
      _asmR.sel = null; _asmR.det = null;
      if (!silent) toast('Marked built');
      loadResearchInbox();
    }).catch(function (e) { if (!silent) { toast('Failed: ' + (e.message || e), true); loadResearchInbox(); } });
  }

  function asmItemPerUnit(it) {
    var eff = (it.unit_cost != null && it.unit_cost !== '') ? Number(it.unit_cost)
      : (it.child ? Number(it.child.unit_cost) : (it.live_unit_cost != null ? Number(it.live_unit_cost) : null));
    if (eff == null) return null;
    return eff * (Number(it.qty_per_unit) || 0) * (1 + (Number(it.waste_pct) || 0) / 100);
  }

  function asmWorkspaceHtml(d) {
    var a = d.assembly;
    var html = '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">' +
      '<div style="font-size:15px;font-weight:700;">🧩 ' + esc(a.name) + '</div>' +
      '<div style="font-family:Consolas,monospace;font-size:14px;color:#4fd1c5;font-weight:700;">$' + (Number(a.unit_cost) || 0).toFixed(2) + ' / ' + esc(a.unit || 'EA') + '</div>' +
      (a.incomplete ? '<span style="color:#f2a55c;font-size:11px;">⚠ has unpriced items</span>' : '') +
    '</div>' +
    '<div style="font-size:11px;color:var(--text-dim,#9a9aa2);margin:3px 0 14px;">' +
      esc(a.code || '') + (a.trade ? ' · ' + esc(a.trade) : '') + ' · ' + esc(a.source || 'manual') +
      ' · used on <b>' + (d.usage.estimate_count || 0) + ' estimate(s)</b>' +
      (d.usage.quoted_total ? ' ($' + Number(d.usage.quoted_total).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' quoted)' : '') +
    '</div>' +
    '<div style="font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);margin-bottom:8px;">Component derivations — click a row for proofs + tuning</div>';

    (d.items || []).forEach(function (it, i) {
      var per = asmItemPerUnit(it);
      var open = !!_asmT.open[i];
      var priceTxt, priceKind;
      if (it.kind === 'assembly' && it.child) {
        priceTxt = '$' + Number(it.child.unit_cost).toFixed(2) + '/' + esc(it.child.unit || 'EA') + ' — sub-assembly';
        priceKind = 'sub';
      } else if (it.unit_cost != null && it.unit_cost !== '') {
        priceTxt = '$' + Number(it.unit_cost).toFixed(2) + '/' + esc(it.unit || 'EA') + ' — ' + (it.material_id ? 'FROZEN (live is $' + (it.live_unit_cost != null ? Number(it.live_unit_cost).toFixed(2) : '?') + ')' : 'manual rate');
        priceKind = it.material_id ? 'frozen' : 'manual';
      } else if (it.price_proof) {
        priceTxt = '$' + (it.price_proof.last != null ? Number(it.price_proof.last).toFixed(2) : '—') + '/' + esc(it.unit || 'EA') + ' — catalog live';
        priceKind = 'live';
      } else {
        priceTxt = 'UNPRICED';
        priceKind = 'none';
      }
      var pc = priceKind === 'live' ? '#4fd1c5' : priceKind === 'frozen' ? '#f2a55c' : priceKind === 'manual' ? '#7eb0ff' : priceKind === 'sub' ? '#a78bfa' : '#f77066';
      html += '<div style="border:1px solid var(--border,#33333a);border-radius:9px;margin-bottom:7px;overflow:hidden;">' +
        '<div data-asmt-row="' + i + '" style="display:flex;align-items:center;gap:9px;padding:8px 11px;cursor:pointer;background:rgba(255,255,255,.02);">' +
          '<span style="color:#4f8cff;">' + (open ? '▾' : '▸') + '</span>' +
          '<span style="flex:1;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.description || '(item)') +
            (it.material_id ? ' <span title="catalog-linked" style="font-size:10px;">🔗</span>' : '') + '</span>' +
          '<span style="font-family:Consolas,monospace;font-size:12.5px;color:#4fd1c5;font-weight:700;">' + (per != null ? '$' + per.toFixed(3) : '—') + ' /' + esc(a.unit || 'EA') + '</span>' +
        '</div>' +
        '<div style="padding:6px 12px 8px 30px;font-family:Consolas,monospace;font-size:11px;border-top:1px solid rgba(255,255,255,.04);color:var(--text-dim,#9a9aa2);">' +
          '<span style="color:' + pc + ';">' + esc(priceTxt) + '</span>' +
          ' <span>×</span> <span style="color:#7eb0ff;">' + (Number(it.qty_per_unit) || 0) + ' ' + esc(it.unit || '') + '/' + esc(a.unit || 'EA') + '</span>' +
          ((Number(it.waste_pct) || 0) > 0 ? ' <span>×</span> <span style="color:#f2a55c;">1.' + String(Math.round(Number(it.waste_pct))).padStart(2, '0') + ' waste</span>' : '') +
          ' <span>=</span> <b style="color:var(--text,#e8e8ea);">' + (per != null ? '$' + per.toFixed(3) : '—') + '</b>' +
        '</div>';
      if (open) html += asmProofHtml(d, it, i);
      html += '</div>';
    });

    // Usage + estimate drift — where this recipe is quoted, at what price
    // vs today's resolved cost, with guarded one-click reprice.
    if ((d.usage.estimates || []).length) {
      html += '<div style="font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);margin:16px 0 6px;">Quoted on estimates — inserted price vs today</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:11.5px;">' +
        '<tr style="color:var(--text-dim,#9a9aa2);font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;">' +
          '<th style="text-align:left;padding:3px 6px;width:26px;"></th><th style="text-align:left;padding:3px 6px;">Estimate</th>' +
          '<th style="text-align:right;padding:3px 6px;">Quoted</th><th style="text-align:right;padding:3px 6px;">Inserted @</th>' +
          '<th style="text-align:right;padding:3px 6px;">Today @</th><th style="text-align:right;padding:3px 6px;">Drift</th></tr>' +
        d.usage.estimates.map(function (u) {
          var driftCol = u.drift_pct == null ? 'var(--text-dim,#888)' : Math.abs(u.drift_pct) < 2 ? '#4ade80' : u.drift_pct > 0 ? '#f77066' : '#f2a55c';
          var status = u.is_locked ? ' <span style="font-size:8.5px;padding:1px 5px;border-radius:7px;background:rgba(247,112,102,.14);color:#f77066;">LOCKED</span>'
            : (u.approval_status ? ' <span style="font-size:8.5px;padding:1px 5px;border-radius:7px;background:rgba(242,165,92,.14);color:#f2a55c;">' + esc(String(u.approval_status).toUpperCase()) + '</span>' : '');
          var rollupNote = u.rollup_count === 0 ? ' <span title="exploded lines only — never auto-repriced" style="font-size:8.5px;color:var(--text-dim,#888);">exploded</span>' : '';
          return '<tr style="border-top:1px solid rgba(255,255,255,.05);">' +
            '<td style="padding:3px 6px;">' + (u.refreshable ? '<input type="checkbox" data-asmt-est="' + esc(u.id) + '" />' : '') + '</td>' +
            '<td style="padding:3px 6px;">' + esc(String(u.title).slice(0, 44)) + status + rollupNote + '</td>' +
            '<td style="text-align:right;padding:3px 6px;font-family:Consolas,monospace;">$' + Number(u.quoted).toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</td>' +
            '<td style="text-align:right;padding:3px 6px;font-family:Consolas,monospace;">' + (u.inserted_unit_cost != null ? '$' + Number(u.inserted_unit_cost).toFixed(2) : '—') + '</td>' +
            '<td style="text-align:right;padding:3px 6px;font-family:Consolas,monospace;">$' + (Number(d.assembly.unit_cost) || 0).toFixed(2) + '</td>' +
            '<td style="text-align:right;padding:3px 6px;font-family:Consolas,monospace;color:' + driftCol + ';">' + (u.drift_pct != null ? (u.drift_pct > 0 ? '+' : '') + u.drift_pct + '%' : '—') + '</td></tr>';
        }).join('') + '</table>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:7px;">' +
          btn('⟳ Reprice selected from recipe', 'data-asmt-reprice') +
          '<span style="font-size:10.5px;color:var(--text-dim,#9a9aa2);">Rollup lines only · locked (sold) estimates can\'t be selected · logged</span>' +
        '</div>';
    }

    html += '<div style="border:1px dashed rgba(167,139,250,.4);border-radius:10px;padding:9px 13px;font-size:11px;color:#a78bfa;margin:14px 0;">🔮 Flywheel suggestions land here (T4): observed GAL/SF + HR/SF from job receipts &amp; QB actuals vs these assumptions — evidence-backed, always human-approved, every verdict a training example.</div>';

    html += '<div style="font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);margin:14px 0 6px;">Tuning log</div>';
    if (!(d.log || []).length) {
      html += '<div style="font-size:11.5px;color:var(--text-dim,#888);">No changes logged yet — the trail starts with the next save.</div>';
    } else {
      d.log.forEach(function (l) {
        var when = l.created_at ? new Date(l.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        var delta = l.field === 'created' ? ('created — ' + esc(l.new_value || ''))
          : l.field === 'items' ? (esc(l.item_desc || '') + ' ' + esc(l.new_value || ''))
          : esc(l.item_desc || '') + ' · ' + esc(l.field) + ' <span style="font-family:Consolas,monospace;"><span style="color:#f77066;text-decoration:line-through;">' + esc(l.old_value == null ? '—' : l.old_value) + '</span> → <span style="color:#4ade80;">' + esc(l.new_value == null ? '—' : l.new_value) + '</span></span>';
        html += '<div style="display:flex;gap:9px;padding:5px 2px;border-bottom:1px solid rgba(255,255,255,.04);font-size:11px;">' +
          '<span style="color:var(--text-dim,#888);flex:0 0 100px;font-family:Consolas,monospace;font-size:10px;">' + esc(when) + '</span>' +
          '<span style="color:#4f8cff;flex:0 0 66px;">' + esc(l.changed_by_name || l.source || '') + '</span>' +
          '<span style="flex:1;">' + delta + (l.reason ? ' <span style="color:var(--text-dim,#888);">— "' + esc(l.reason) + '"</span>' : '') + '</span>' +
        '</div>';
      });
    }
    return html;
  }

  function asmProofHtml(d, it, i) {
    var html = '<div style="background:rgba(0,0,0,.22);border-top:1px solid var(--border,#33333a);padding:10px 14px;font-size:11.5px;">';
    if (it.price_proof) {
      var pp = it.price_proof;
      html += '<div style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);margin-bottom:5px;">Price proof — ' + esc(pp.material_description || '') + '</div>';
      if ((pp.purchases || []).length) {
        html += '<table style="width:100%;border-collapse:collapse;font-size:10.5px;color:var(--text-dim,#9a9aa2);"><tr><th style="text-align:left;padding:2px 6px;">Date</th><th style="text-align:left;padding:2px 6px;">Store</th><th style="text-align:right;padding:2px 6px;">Qty</th><th style="text-align:right;padding:2px 6px;">Unit price</th></tr>' +
          pp.purchases.map(function (p) {
            return '<tr><td style="padding:2px 6px;">' + esc(String(p.purchase_date || '').slice(0, 10)) + '</td><td style="padding:2px 6px;">' + esc(p.store_number || '') + '</td><td style="text-align:right;padding:2px 6px;font-family:Consolas,monospace;">' + (Number(p.quantity) || 0) + '</td><td style="text-align:right;padding:2px 6px;font-family:Consolas,monospace;">$' + (Number(p.net_unit_price != null ? p.net_unit_price : p.unit_price) || 0).toFixed(2) + '</td></tr>';
          }).join('') + '</table>';
      } else {
        html += '<div style="color:var(--text-dim,#888);">No purchase rows imported for this SKU yet.</div>';
      }
      html += '<div style="margin-top:5px;color:var(--text-dim,#9a9aa2);">last <span style="font-family:Consolas,monospace;">$' + (pp.last != null ? Number(pp.last).toFixed(2) : '—') + '</span> · avg <span style="font-family:Consolas,monospace;">$' + (pp.avg != null ? Number(pp.avg).toFixed(2) : '—') + '</span>' +
        (pp.trend_pct != null ? ' · <b style="color:' + (pp.trend_pct > 0 ? '#f77066' : '#4ade80') + ';">' + (pp.trend_pct > 0 ? '+' : '') + pp.trend_pct + '% vs avg</b>' : '') +
        ' · price mode: <b>' + esc(pp.price_mode) + '</b></div>';
    }
    html += '<div style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);margin:9px 0 4px;">Rate rationale — the written why</div>' +
      '<div style="border-left:3px solid #4f8cff;background:rgba(79,140,255,.05);padding:7px 10px;border-radius:0 6px 6px 0;color:var(--text-dim,#9a9aa2);line-height:1.5;">' +
        (it.rationale ? esc(it.rationale) : '<i>No rationale recorded — tune below and say why.</i>') +
      '</div>' +
      '<div style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);margin:10px 0 5px;">Tune this row</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:7px;">' +
        asmInp('Qty / unit', 'qty', i, it.qty_per_unit) +
        asmInp('Unit cost (blank = live)', 'cost', i, it.unit_cost != null ? it.unit_cost : '') +
        asmInp('Waste %', 'waste', i, it.waste_pct) +
      '</div>' +
      '<input data-asmt-f="rat" data-asmt-i="' + i + '" placeholder="Rationale — the why behind these rates…" value="' + esc(it.rationale || '') + '" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid var(--border,#33333a);border-radius:6px;padding:6px 8px;color:var(--text,#e8e8ea);font-size:11.5px;margin-bottom:7px;" />' +
      '<div style="display:flex;gap:7px;align-items:center;">' +
        '<input data-asmt-f="reason" data-asmt-i="' + i + '" placeholder="Reason for this change (goes in the log)…" style="flex:1;background:rgba(255,255,255,.05);border:1px solid var(--border,#33333a);border-radius:6px;padding:6px 8px;color:var(--text,#e8e8ea);font-size:11.5px;" />' +
        btn('Save tune', 'data-asmt-save="' + i + '"') +
      '</div>' +
    '</div>';
    return html;
  }

  function asmInp(label, f, i, val) {
    return '<label style="display:flex;flex-direction:column;gap:3px;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim,#9a9aa2);">' + label +
      '<input data-asmt-f="' + f + '" data-asmt-i="' + i + '" value="' + esc(val == null ? '' : val) + '" inputmode="decimal" style="background:rgba(255,255,255,.05);border:1px solid var(--border,#33333a);border-radius:6px;padding:5px 7px;color:var(--text,#e8e8ea);font-family:Consolas,monospace;font-size:11.5px;" /></label>';
  }

  function wireAsmWorkspace(el) {
    el.querySelectorAll('[data-asmt-row]').forEach(function (r) {
      r.addEventListener('click', function () {
        var i = Number(r.dataset.asmtRow);
        _asmT.open[i] = !_asmT.open[i];
        paintAsmMain();
      });
    });
    el.querySelectorAll('[data-asmt-save]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.dataset.asmtSave);
        var get = function (f) { var inp = el.querySelector('[data-asmt-f="' + f + '"][data-asmt-i="' + i + '"]'); return inp ? inp.value : ''; };
        var det = _asmT.det;
        if (!det) return;
        var items = det.items.map(function (it, idx) {
          var row = {
            kind: it.kind, material_id: it.material_id, child_assembly_id: it.child_assembly_id,
            description: it.description, qty_per_unit: it.qty_per_unit, unit: it.unit,
            unit_cost: it.unit_cost, cost_code: it.cost_code, waste_pct: it.waste_pct,
            notes: it.notes, rationale: it.rationale,
          };
          if (idx === i) {
            row.qty_per_unit = parseFloat(get('qty')) || row.qty_per_unit;
            var c = get('cost');
            row.unit_cost = (c === '' ? null : parseFloat(c));
            row.waste_pct = parseFloat(get('waste')) || 0;
            row.rationale = get('rat');
          }
          return row;
        });
        cput('/api/assemblies/' + det.assembly.id + '/items', { items: items, reason: get('reason') || null })
          .then(function () { toast('Tuned — logged with reason'); loadAsmDetail(det.assembly.id); })
          .catch(function (e) { toast('Save failed: ' + (e.message || 'unknown'), true); });
      });
    });
    var rp = el.querySelector('[data-asmt-reprice]');
    if (rp) rp.addEventListener('click', function () {
      var ids = Array.prototype.map.call(el.querySelectorAll('[data-asmt-est]:checked'), function (c) { return c.dataset.asmtEst; });
      if (!ids.length) { toast('Check at least one estimate first', true); return; }
      var det = _asmT.det;
      cpost('/api/assemblies/' + det.assembly.id + '/refresh-estimates', { estimate_ids: ids, reason: 'Repriced from Tuning Center' })
        .then(function (r) {
          var ok = (r.results || []).filter(function (x) { return x.ok; }).length;
          var skipped = (r.results || []).filter(function (x) { return !x.ok; });
          toast(ok + ' estimate(s) repriced to $' + r.new_unit_cost + (skipped.length ? ' · ' + skipped.length + ' skipped' : ''));
          loadAsmDetail(det.assembly.id);
        })
        .catch(function (e) { toast('Reprice failed: ' + (e.message || 'unknown'), true); });
    });
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
