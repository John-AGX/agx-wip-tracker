/* Project 86 — entity context card in the left sidebar.
   ─────────────────────────────────────────────────────────────
   Mirrors the job subnav: when the user opens a LEAD or ESTIMATE
   detail (both full-page in-page views with #app-sidebar visible),
   we mount the shared Pulse card (compact) at the top of the
   sidebar so they have the same at-a-glance context jobs get.

     window.p86EntitySubnav.mount(kind, vm)   // kind: 'lead' | 'estimate'
     window.p86EntitySubnav.unmount(kind)

   vm is a window.p86EntityCard view-model. The card is inserted
   just above the main nav (.app-nav stays visible — unlike the job
   subnav, leads/estimates have no section tabs to relocate). Hidden
   on the collapsed icon rail via CSS. Idempotent + guarded so a
   missing card module degrades to a no-op. */
(function () {
  'use strict';
  if (window.p86EntitySubnav) return;

  function mount(kind, vm) {
    var sb = document.getElementById('app-sidebar');
    if (!sb || !window.p86EntityCard || !kind) return;
    clearAll();  // single-card rule: only one lead/estimate context card at a time
    var wrap = document.createElement('div');
    wrap.id = 'app-' + kind + 'nav';
    wrap.className = 'app-entitynav';
    wrap.innerHTML = window.p86EntityCard.render(vm || {}, { compact: true });
    // Insert above .app-nav using its REAL parent (it may sit inside a
    // scroll wrapper), mirroring how the job subnav inserts #app-jobnav.
    var nav = sb.querySelector('.app-nav');
    if (nav && nav.parentNode) nav.parentNode.insertBefore(wrap, nav);
    else sb.appendChild(wrap);
  }

  function unmount(kind) {
    var el = document.getElementById('app-' + (kind || '') + 'nav');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // Remove every lead/estimate context card (the job uses its own #app-jobnav,
  // torn down by workspace-layout). Called before any mount + on detail close.
  function clearAll() { unmount('lead'); unmount('estimate'); }

  window.p86EntitySubnav = { mount: mount, unmount: unmount, clearAll: clearAll };
})();
