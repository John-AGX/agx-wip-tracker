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
      host.innerHTML = isAdmin()
        ? placeholder('Studio — build & tune with 86', 'The build/tune cockpit (86 docked + research inbox + tuning center) is moving here from the Command Center. Coming next in this build.')
        : placeholder('Studio', 'The build & tune workbench is available to platform admins.');
    } else if (view === 'codes') {
      host.innerHTML = placeholder('Assembly Codes', 'The Trade · System · Variant code registry is moving here from Admin → Organization. Coming next in this build.');
    } else if (view === 'parametric') {
      host.innerHTML = placeholder('Parametric assemblies', 'Formula-driven recipes + draw-to-quantify. Coming next in this build.');
    }
  }

  window.p86AsmStudio = { render: renderAsmStudioInto, switchSubTab: switchSubTab };
  window.switchAsmStudioSubTab = switchSubTab;
})();
