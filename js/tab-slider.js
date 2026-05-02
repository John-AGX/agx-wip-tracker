// ──────────────────────────────────────────────────────────────────
// Sliding tab indicator
//
// Replaces per-tab border/underline/folder styling with a single
// shared 2px lime bar that floats between active tabs with a smooth
// CSS transition (Stripe / Vercel style). One indicator element is
// appended per tab bar; its left + width are set inline to match the
// currently-active tab's offset, and the CSS transition (defined in
// styles.css under .agx-tab-slider) drives the slide.
//
// Wires every tab bar in the app:
//   - nav.tabs            (top header tabs)
//   - .ws-right-tabs      (Estimates sub-tabs / lead editor tabs /
//                          job-detail right-panel tabs)
//   - .sub-tabs           (job-detail sub-tabs)
//   - .sub-modal-tabs     (sub-edit modal tabs — appears dynamically)
//
// Re-positions on:
//   - initial wire
//   - any class change inside the bar (catches both clicks and
//     programmatic switchTab() calls — uses MutationObserver so we
//     don't have to know who toggled the active state)
//   - window resize
//   - new tab bars added to the DOM (modals opening, panels
//     mounting later, etc.)
// ──────────────────────────────────────────────────────────────────
(function() {
  'use strict';

  var SELECTORS = ['nav.tabs', '.ws-right-tabs', '.sub-tabs', '.sub-modal-tabs'];

  function ensureSlider(bar) {
    var slider = bar.querySelector(':scope > .agx-tab-slider');
    if (!slider) {
      slider = document.createElement('div');
      slider.className = 'agx-tab-slider';
      bar.appendChild(slider);
    }
    return slider;
  }

  function positionSlider(bar) {
    var slider = ensureSlider(bar);
    // querySelector descends into the bar; we want the active TAB,
    // not the active class on a nested element. Filter to known tab
    // classnames so we don't accidentally match a status pill or
    // some other unrelated .active.
    var active = bar.querySelector(
      '.tab-btn.active, .ws-right-tab.active, .sub-tab-btn-job.active, .sub-modal-tab.active'
    );
    // Hidden bar (display:none, in a closed modal, etc.) has zero
    // width; punt rather than place the slider at 0,0 which would
    // animate from the wrong spot when the bar reveals.
    if (!active || bar.offsetWidth === 0) {
      slider.style.opacity = '0';
      return;
    }
    var barRect = bar.getBoundingClientRect();
    var tabRect = active.getBoundingClientRect();
    slider.style.opacity = '1';
    slider.style.width = tabRect.width + 'px';
    slider.style.transform = 'translateX(' + (tabRect.left - barRect.left) + 'px)';
  }

  function wireBar(bar) {
    if (bar.__agxSliderWired) {
      // Already wired — just nudge the slider in case the active
      // tab changed since last visit (e.g., the bar was hidden and
      // now reveals).
      positionSlider(bar);
      return;
    }
    bar.__agxSliderWired = true;
    ensureSlider(bar);
    // Bar must be a positioning context for the absolute slider.
    if (getComputedStyle(bar).position === 'static') {
      bar.style.position = 'relative';
    }
    positionSlider(bar);

    // Re-position whenever any class attribute changes within the
    // bar's subtree. Catches both direct user clicks (per-tab
    // handler toggles .active → MutationObserver fires) and
    // programmatic active swaps from app.js / subs.js / etc.
    var mo = new MutationObserver(function() { positionSlider(bar); });
    mo.observe(bar, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true
    });
  }

  function scan() {
    SELECTORS.forEach(function(sel) {
      document.querySelectorAll(sel).forEach(wireBar);
    });
  }

  function repositionAll() {
    SELECTORS.forEach(function(sel) {
      document.querySelectorAll(sel).forEach(positionSlider);
    });
  }

  function init() {
    scan();
    // Watch the whole DOM for new tab bars (e.g., the sub-edit
    // modal renders its bar dynamically when opened). Repaints
    // sliders for any nodes that suddenly have an active class
    // change pending too.
    var domObserver = new MutationObserver(function(records) {
      var sawAdds = false;
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes && records[i].addedNodes.length) {
          sawAdds = true;
          break;
        }
      }
      if (sawAdds) scan();
    });
    domObserver.observe(document.body, { childList: true, subtree: true });

    // Tab widths can change when the viewport resizes (e.g., a
    // wrap kicks in). Re-position all sliders so they stay
    // anchored to the right tab.
    window.addEventListener('resize', repositionAll);

    // First paint can land before fonts settle, throwing
    // tab.offsetWidth off by a px. Re-position once everything
    // has loaded so the slider lands clean.
    if (document.readyState !== 'complete') {
      window.addEventListener('load', repositionAll);
    }
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);

  // Public hook — let other scripts force a reposition after they
  // do something we can't observe from here (rare).
  window.agxTabSliderRefresh = repositionAll;
})();
