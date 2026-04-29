// Draggable + sticky modals.
//
// Two behaviors layered onto every .modal in the app:
//
//   1. The modal-header acts as a drag handle. mousedown on the header
//      starts a translate-based drag; the modal-content moves with the
//      cursor until mouseup. Position resets when the modal closes so
//      reopening starts centered.
//
//   2. Backdrop clicks no longer close the modal. The default UX of
//      "click outside to close" loses unsaved edits if the user
//      misclicks, so any click on .modal that bubbles up from outside
//      .modal-content gets swallowed. Modals only close via their own
//      Cancel / Save / × buttons.
//
// Runs as a single delegated listener on document, so dynamically-added
// modals (the merge / split / material-editor modals) get the behavior
// for free without any per-modal wiring.
(function() {
  'use strict';

  // ─── Drag ───────────────────────────────────────────────────────
  let active = null; // { content, startX, startY, originX, originY }

  function readTranslate(el) {
    // Parse `translate(Xpx, Ypx)` out of computed transform. The matrix
    // form (matrix(a,b,c,d,tx,ty)) is also handled — DOM occasionally
    // returns it after browser optimization.
    const t = el.style.transform || getComputedStyle(el).transform;
    if (!t || t === 'none') return { x: 0, y: 0 };
    const matrix = t.match(/matrix\(([^)]+)\)/);
    if (matrix) {
      const parts = matrix[1].split(',').map(s => parseFloat(s.trim()));
      return { x: parts[4] || 0, y: parts[5] || 0 };
    }
    const translate = t.match(/translate\((-?\d+(?:\.\d+)?)(?:px)?\s*,\s*(-?\d+(?:\.\d+)?)(?:px)?\)/);
    if (translate) return { x: parseFloat(translate[1]), y: parseFloat(translate[2]) };
    return { x: 0, y: 0 };
  }

  document.addEventListener('mousedown', function(e) {
    // Only initiate drag when the user grabs a modal-header AND the
    // header isn't an interactive child (button, input). Lets users
    // still click form controls inside the header without snagging a
    // drag.
    const header = e.target.closest && e.target.closest('.modal-header');
    if (!header) return;
    if (e.target.closest('button, input, select, textarea, a')) return;
    const content = header.closest('.modal-content');
    if (!content) return;
    const { x, y } = readTranslate(content);
    active = {
      content: content,
      startX: e.clientX,
      startY: e.clientY,
      originX: x,
      originY: y
    };
    // Visual: header gets a slight grab cursor while dragging
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', function(e) {
    if (!active) return;
    const dx = e.clientX - active.startX;
    const dy = e.clientY - active.startY;
    active.content.style.transform =
      'translate(' + (active.originX + dx) + 'px, ' + (active.originY + dy) + 'px)';
  });

  document.addEventListener('mouseup', function() {
    if (!active) return;
    active = null;
    document.body.style.userSelect = '';
  });

  // ─── Don't close on backdrop click ─────────────────────────────
  // Older modals were laid out so a click anywhere on .modal (the dim
  // overlay) would propagate to a global handler that toggled `.active`
  // off. None of the current code does that explicitly — but to make
  // the behavior bulletproof against future regressions, we install a
  // capturing handler that swallows any click whose target IS the
  // backdrop element itself (i.e., not a descendant of .modal-content).
  document.addEventListener('click', function(e) {
    if (!e.target || !e.target.classList) return;
    if (e.target.classList.contains('modal') && e.target.classList.contains('active')) {
      // Click landed on the backdrop, not on .modal-content. Stop any
      // legacy backdrop-close handler before it can run.
      e.stopPropagation();
    }
  }, true); // capture phase — fires before bubble-phase handlers

  // ─── Reset transform on close ──────────────────────────────────
  // When a modal's `.active` class is removed (closeModal call), clear
  // the drag offset so the next openModal lands centered. MutationObserver
  // is the cleanest hook since closeModal is just a classList.remove.
  const obs = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      if (m.type !== 'attributes' || m.attributeName !== 'class') return;
      const target = m.target;
      if (!target.classList || !target.classList.contains('modal')) return;
      // If the modal just closed (lost .active), reset its inner transform
      const wasActive = m.oldValue && m.oldValue.indexOf('active') >= 0;
      const nowActive = target.classList.contains('active');
      if (wasActive && !nowActive) {
        const content = target.querySelector('.modal-content');
        if (content) content.style.transform = '';
      }
    });
  });

  // Wait for DOMContentLoaded so we don't miss any modal element added
  // before this script runs. Pretty defensive — by the time index.html
  // loads us, .modal elements are usually already in the tree.
  function initObserver() {
    document.querySelectorAll('.modal').forEach(function(m) {
      obs.observe(m, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }

  // Newer modals get added dynamically (clientMergeModal, matEditorModal,
  // etc.). A separate watcher on document.body picks those up so they
  // also get the close-resets-transform behavior.
  const bodyObs = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes && m.addedNodes.forEach(function(n) {
        if (n.nodeType !== 1) return;
        if (n.classList && n.classList.contains('modal')) {
          obs.observe(n, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
        }
        // Catch nested modals too
        n.querySelectorAll && n.querySelectorAll('.modal').forEach(function(sub) {
          obs.observe(sub, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
        });
      });
    });
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      bodyObs.observe(document.body, { childList: true, subtree: true });
    });
  } else {
    bodyObs.observe(document.body, { childList: true, subtree: true });
  }
})();
