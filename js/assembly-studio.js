// Assembly Studio — the consolidated home for AGX's cost-assembly system.
// =====================================================================
// A top-level tab (#assembly-studio pane) that gathers the previously
// scattered assembly surfaces into one place on the main side nav:
//   Assemblies  — browse & build costed recipes (js/assemblies.js)
//   Studio      — build & tune with 86 (moved out of the Command Center)
//   Codes       — Trade · System · Variant taxonomy (moved out of Admin)
//   Parametric  — formula-driven recipes + draw-to-quantify
//
// Mirrors the Jobs-hub pattern: renderAsmStudioInto(host) builds the
// section scaffold once the tab opens (called from app.js switchTab), and
// the sidebar accordion children (data-asmstudio-subtab) drive
// switchAsmStudioSubTab. Sub-tab choice persists per session like jobshub.
(function () {
  'use strict';

  var VIEWS = ['assemblies', 'studio', 'codes', 'parametric'];
  var DEFAULT_VIEW = 'assemblies';
  var _view = null;
  var _built = false;

  function esc(v) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(v == null ? '' : String(v));
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // ESTIMATES_EDIT gates writes (New Assembly, code edits). Offline / no
  // auth = full local access, matching applyRoleVisibility's default.
  function canEdit() {
    return !window.p86Auth || typeof window.p86Auth.hasCapability !== 'function' ||
      window.p86Auth.hasCapability('ESTIMATES_EDIT');
  }
  function isAdmin() {
    return !!(window.p86Auth && window.p86Auth.isSystemAdmin && window.p86Auth.isSystemAdmin());
  }

  function placeholder(title, body) {
    return '<div style="padding:44px 24px;text-align:center;color:var(--text-dim,#8a93a6);">' +
      '<div style="font-size:15px;font-weight:600;color:var(--text,#fff);margin-bottom:6px;">' + esc(title) + '</div>' +
      '<div style="font-size:13px;max-width:560px;margin:0 auto;line-height:1.5;">' + body + '</div></div>';
  }

  function renderAsmStudioInto(host) {
    if (!host) return;
    host.innerHTML =
      '<div class="asmstudio">' +
        // Assemblies — the recipe list + editor, hosted via p86Assemblies
        // with the 'asmstudio-asm' host prefix (own ids so the classic
        // Estimates → Assemblies host can coexist during the transition).
        '<div class="asmstudio-section" id="asmstudio-section-assemblies" style="display:none;">' +
          '<div class="action-buttons">' +
            (canEdit() ? '<button onclick="p86Assemblies.openEditor(null)" data-p86-icon="plus">New Assembly</button>' : '') +
            (canEdit() ? '<button onclick="p86Assemblies.openLinkAudit()" class="ghost" title="Link every recipe row to a catalog material">🔗 Fix links</button>' : '') +
            '<input id="asmstudio-asm-search" type="text" placeholder="Search assemblies…" oninput="p86Assemblies.paintList()" ' +
              'style="flex:1;max-width:320px;background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:8px;padding:8px 12px;color:var(--text,#fff);font-size:13px;" />' +
            '<span id="asmstudio-asm-summary" style="font-size:12px;color:var(--text-dim,#8a93a6);align-self:center;"></span>' +
          '</div>' +
          '<div id="asmstudio-asm-list" style="margin-top:12px;"></div>' +
        '</div>' +
        '<div class="asmstudio-section" id="asmstudio-section-studio" style="display:none;"></div>' +
        '<div class="asmstudio-section" id="asmstudio-section-codes" style="display:none;"></div>' +
        '<div class="asmstudio-section" id="asmstudio-section-parametric" style="display:none;"></div>' +
      '</div>';
    _built = true;
    var persisted = null;
    try { persisted = sessionStorage.getItem('p86_asmstudio_tab'); } catch (e) {}
    switchSubTab(VIEWS.indexOf(persisted) >= 0 ? persisted : DEFAULT_VIEW);
  }

  function switchSubTab(view) {
    if (VIEWS.indexOf(view) < 0) view = DEFAULT_VIEW;
    // Leaving the Studio sub-tab: pop the docked 86 panel back to its drawer
    // BEFORE its host (#cc-asm-chat) goes display:none — the panel is a
    // page-wide singleton and would vanish inside a hidden host otherwise
    // (mirrors console.js switchConsoleSubTab).
    var prev = _view;
    if (prev === 'studio' && view !== 'studio' && window.p86AI &&
        typeof window.p86AI.isDocked === 'function' && window.p86AI.isDocked()) {
      try { window.p86AI.undock(); } catch (e) {}
    }
    _view = view;
    try { sessionStorage.setItem('p86_asmstudio_tab', view); } catch (e) {}
    // If the pane isn't built yet (sub-tab clicked before the tab opened),
    // build it — renderAsmStudioInto calls back here with the same view.
    if (!_built || !document.getElementById('asmstudio-section-assemblies')) {
      var host = document.getElementById('asmStudioPageHost');
      if (host) { renderAsmStudioInto(host); return; }
    }
    VIEWS.forEach(function (v) {
      var el = document.getElementById('asmstudio-section-' + v);
      if (el) el.style.display = (v === view) ? 'block' : 'none';
    });
    if (typeof window.markVirtualTabActive === 'function') window.markVirtualTabActive('asmstudio-' + view);
    loadView(view);
  }

  function loadView(view) {
    if (view === 'assemblies') {
      if (window.p86Assemblies && typeof window.p86Assemblies.renderList === 'function') {
        window.p86Assemblies.renderList('asmstudio-asm');
      }
      return;
    }
    var host = document.getElementById('asmstudio-section-' + view);
    if (!host) return;
    // Studio / Codes / Parametric are filled in by their own slices — until
    // then, a clear placeholder so the home reads as complete.
    if (view === 'studio') {
      if (!isAdmin()) { host.innerHTML = placeholder('Studio', 'The build &amp; tune workbench is available to platform admins.'); return; }
      // Host the shared build/tune cockpit (86 docked + research inbox +
      // tuning center) from console.js. It targets #cc-assemblies; provide
      // it once, then let loadAssemblyStudio (idempotent) rebuild + re-dock.
      if (!document.getElementById('cc-assemblies')) {
        host.innerHTML = '<div id="cc-assemblies" class="cc-section" style="display:block;"></div>';
      }
      if (window.p86Console && typeof window.p86Console.loadAssemblyStudio === 'function') {
        window.p86Console.loadAssemblyStudio();
      } else {
        host.innerHTML = placeholder('Studio', 'The build &amp; tune module is still loading — try again in a moment.');
      }
    } else if (view === 'codes') {
      // Reuse the Trade · System · Variant taxonomy manager (formerly under
      // Admin → Organization). admin.js exposes renderOrgAssemblyTaxonomy and
      // it mounts into #admin-org-asmcodes-host using a singleton state, so
      // this is the ONLY live host now (the admin entry was removed). Any
      // signed-in user with ESTIMATES_VIEW can browse; write actions inside
      // the manager are gated server-side (ESTIMATES_EDIT).
      if (!document.getElementById('admin-org-asmcodes-host')) {
        host.innerHTML = '<div id="admin-org-asmcodes-host"></div>';
      }
      if (typeof window.renderOrgAssemblyTaxonomy === 'function') {
        window.renderOrgAssemblyTaxonomy();
      } else {
        host.innerHTML = placeholder('Assembly Codes', 'The Trade · System · Variant code manager is still loading — try again in a moment.');
      }
    } else if (view === 'parametric') {
      // Parametric recipes = declared params or a qty formula. Reuse the
      // assemblies list, filtered to that subset (own host prefix so its
      // search box is independent of the Assemblies tab), and link out to
      // Plans & Takeoffs where draw-to-quantify actually lives (it's welded
      // to the CAD overlay — we don't re-host it here).
      host.innerHTML =
        '<div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:14px;">' +
          '<div style="flex:1;min-width:260px;font-size:13px;color:var(--text-dim,#8a93a6);line-height:1.5;max-width:660px;">' +
            'Parametric recipes price from <strong style="color:var(--text,#fff);">geometry</strong> — declare parameters (span, height, pitch…) or a quantity formula and one recipe covers every size. Draw a shape on a plan and its measurements drive the takeoff.' +
          '</div>' +
          '<button onclick="switchTab(\'plans\')" data-p86-icon="map" style="white-space:nowrap;align-self:flex-start;">Draw to quantify →</button>' +
        '</div>' +
        '<div class="action-buttons">' +
          '<input id="asmstudio-param-search" type="text" placeholder="Search parametric recipes…" oninput="p86Assemblies.paintList()" ' +
            'style="flex:1;max-width:320px;background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:8px;padding:8px 12px;color:var(--text,#fff);font-size:13px;" />' +
          '<span id="asmstudio-param-summary" style="font-size:12px;color:var(--text-dim,#8a93a6);align-self:center;"></span>' +
        '</div>' +
        '<div id="asmstudio-param-list" style="margin-top:12px;"></div>';
      if (window.p86Assemblies && typeof window.p86Assemblies.renderList === 'function') {
        window.p86Assemblies.renderList('asmstudio-param', { parametricOnly: true });
      }
    }
  }

  window.p86AsmStudio = { render: renderAsmStudioInto, switchSubTab: switchSubTab };
  window.switchAsmStudioSubTab = switchSubTab;
})();
