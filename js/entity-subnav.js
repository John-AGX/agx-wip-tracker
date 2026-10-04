/* Project 86 — entity context card in the left sidebar.
   ─────────────────────────────────────────────────────────────
   Mirrors the job subnav: when the user opens a LEAD or ESTIMATE
   detail (both full-page in-page views with #app-sidebar visible),
   we mount the shared Pulse card (compact) at the top of the
   sidebar so they have the same at-a-glance context jobs get.

     window.p86EntitySubnav.mount(kind, vm, onAct)  // kind: 'lead' | 'estimate'
     window.p86EntitySubnav.unmount(kind)

   onAct(act, dataset) fires for any [data-act] control inside the card
   (icon row, Add follow-up). Until it existed this mount rendered the
   card and wired NOTHING, so every button the component emitted was
   decorative — which is why the card's icons did nothing.

   vm is a window.p86EntityCard view-model. The card is inserted
   just above the main nav (.app-nav stays visible — unlike the job
   subnav, leads/estimates have no section tabs to relocate). Hidden
   on the collapsed icon rail via CSS. Idempotent + guarded so a
   missing card module degrades to a no-op. */
(function () {
  'use strict';
  if (window.p86EntitySubnav) return;

  // WHERE THE CARD GOES. A detail page that offers a head slot
  // (#<kind>-head-card) gets the card in its own header, beside that page's
  // actions — the job page's arrangement, and the reason its header stopped
  // being an empty bar. Everything else keeps the sidebar mount, which is what
  // the estimate editor and the modal lead form still use.
  function hostFor(kind) {
    return document.getElementById(kind + '-head-card');
  }

  function mount(kind, vm, onAct) {
    var sb = document.getElementById('app-sidebar');
    var headSlot = hostFor(kind);
    if ((!sb && !headSlot) || !window.p86EntityCard || !kind) return;
    clearAll();  // single-card rule: only one lead/estimate context card at a time
    var wrap = document.createElement('div');
    wrap.id = 'app-' + kind + 'nav';
    wrap.className = 'app-entitynav';
    // In a page head the card is a STRIP — one slim line read left to right,
    // the shape the job's head card uses. In the sidebar it stays a column.
    wrap.innerHTML = window.p86EntityCard.render(vm || {}, { compact: true, strip: !!headSlot });
    // Delegate every [data-act] control in the card to the host. Listener
    // lives on the wrapper, so a re-mount (which replaces the wrapper)
    // disposes it — no accumulating handlers across repaints.
    if (typeof onAct === 'function') {
      wrap.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        if (!btn || !wrap.contains(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        try { onAct(btn.getAttribute('data-act'), btn.dataset || {}); } catch (err) {}
      });
    }
    if (headSlot) {
      // The page's own header owns it now. clearAll() above has already taken
      // the previous card out of this slot, which is what keeps a repaint
      // (every follow-up load repaints) from stacking a second one.
      headSlot.appendChild(wrap);
      headSlot.classList.add('has-card');
      return;
    }
    // Insert above .app-nav using its REAL parent (it may sit inside a
    // scroll wrapper), mirroring how the job subnav inserts #app-jobnav.
    var nav = sb.querySelector('.app-nav');
    if (nav && nav.parentNode) nav.parentNode.insertBefore(wrap, nav);
    else sb.appendChild(wrap);
  }

  function unmount(kind) {
    var el = document.getElementById('app-' + (kind || '') + 'nav');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    // The slot stays in the page (it is the page's markup); it just stops
    // claiming the space it only has while a card is in it.
    var slot = hostFor(kind);
    if (slot) slot.classList.remove('has-card');
  }

  // Remove every lead/estimate context card (the job uses its own #app-jobnav,
  // torn down by workspace-layout). Called before any mount + on detail close.
  function clearAll() { unmount('lead'); unmount('estimate'); }

  window.p86EntitySubnav = { mount: mount, unmount: unmount, clearAll: clearAll };
})();
