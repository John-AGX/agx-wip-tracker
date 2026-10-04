// Project 86 — the ⋯ menu a detail page's head hangs its actions on.
// ─────────────────────────────────────────────────────────────────────
// The job page needed one when its card took the head: Edit / Archive /
// Delete stopped being a row of three and became a menu. The lead page needs
// the identical thing for Delete / Service Ticket / Convert — so this is the
// one implementation, rather than the second copy that would have drifted
// from it the first time either page changed.
//
//   window.p86HeadMenu.wire(button, panel)   -> { open, close, toggle, isOpen }
//
// The panel is positioned from the BUTTON (fixed, dropped under its right
// edge) so it lands in the same place on a 1,600px desktop and a phone, and
// so a page that moves its button does not have to tell this module.
//
// Wiring is idempotent: calling wire() again on the same button returns the
// same controller instead of stacking a second set of listeners, because both
// pages re-run their header build on every open.
(function () {
  'use strict';
  if (window.p86HeadMenu) return;

  function wire(button, panel) {
    if (!button || !panel) return null;
    if (button._p86HeadMenu) return button._p86HeadMenu;

    function isOpen() { return panel.classList.contains('is-open'); }

    function position() {
      var r = button.getBoundingClientRect();
      panel.style.top = Math.round(r.bottom + 6) + 'px';
      // Right-aligned to the button, clamped into the viewport so a button
      // near the edge cannot push the menu off it.
      panel.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    }

    function setOpen(open) {
      if (open) position();
      panel.classList.toggle('is-open', !!open);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');

    button.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!isOpen());
    });
    // A pick closes it; the button's own handler still runs.
    panel.addEventListener('click', function (e) {
      if (isOpen() && e.target.closest && e.target.closest('button')) setOpen(false);
    });
    // Anywhere else closes it. Capture, so a handler that stops propagation
    // on its own element cannot leave the menu open behind it.
    document.addEventListener('mousedown', function (e) {
      if (!isOpen()) return;
      if (panel.contains(e.target) || button.contains(e.target)) return;
      setOpen(false);
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) setOpen(false);
    });
    // The anchor moves when the page scrolls or the window resizes; an open
    // menu that stays where it was is pointing at nothing.
    window.addEventListener('resize', function () { if (isOpen()) position(); });
    window.addEventListener('scroll', function () { if (isOpen()) setOpen(false); }, true);

    var api = {
      open: function () { setOpen(true); },
      close: function () { setOpen(false); },
      toggle: function () { setOpen(!isOpen()); },
      isOpen: isOpen
    };
    button._p86HeadMenu = api;
    return api;
  }

  window.p86HeadMenu = { wire: wire };
})();
