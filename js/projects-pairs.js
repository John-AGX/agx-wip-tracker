// Before/After pair widget — CompanyCam's signature slider control.
//
// Renders two photos with a draggable vertical divider; dragging the
// divider left/right reveals more of the before vs after photo. The
// component is pure DOM (no canvas) so it's snappy on mobile and the
// images themselves stay sharp.
//
// Two usage modes:
//   1. Tile mode — small embedded in the project photo feed
//      window.p86ProjectsPairs.renderTile(pair) → returns an HTMLElement
//   2. Lightbox mode — full-screen slider overlay
//      window.p86ProjectsPairs.openLightbox(pair)
//
// The slider is keyboard-accessible (left/right arrows step the divider)
// and pointer-driven (mouse + touch). On touch devices, dragging the
// divider intentionally captures pointer events so the page doesn't
// scroll while the user is comparing.
(function() {
  'use strict';

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
  }

  var _idCounter = 0;
  function nextId() { return 'p86-pair-' + (++_idCounter); }

  // Build a slider widget. Returns an HTMLElement containing two
  // overlaid images and a draggable divider. The container must be
  // given a width/height by its parent — the slider fills it.
  function buildSlider(beforeUrl, afterUrl, opts) {
    opts = opts || {};
    var startPct = Number.isFinite(opts.start) ? opts.start : 50;

    var root = document.createElement('div');
    root.className = 'p86-pair-slider';
    root.setAttribute('tabindex', '0');
    root.setAttribute('role', 'slider');
    root.setAttribute('aria-label', 'Before / After comparison');
    root.setAttribute('aria-valuemin', '0');
    root.setAttribute('aria-valuemax', '100');
    root.setAttribute('aria-valuenow', String(startPct));

    // Both images fill the slider; the BEFORE image is clipped from
    // the right edge using clip-path: inset(0 <100-pct>% 0 0). This
    // avoids the wrap-width hack which squishes the inner image as
    // the divider moves. clip-path has full browser support since
    // ~2020.
    root.innerHTML =
      '<img class="p86-pair-after" src="' + escapeAttr(afterUrl) + '" alt="After" />' +
      '<img class="p86-pair-before" src="' + escapeAttr(beforeUrl) + '" alt="Before" style="clip-path: inset(0 ' + (100 - startPct) + '% 0 0);" />' +
      '<div class="p86-pair-handle" style="left:' + startPct + '%;" aria-hidden="true">' +
        '<div class="p86-pair-handle-bar"></div>' +
        '<div class="p86-pair-handle-knob">&#x2B0C;</div>' +
      '</div>' +
      '<div class="p86-pair-label p86-pair-label-before">BEFORE</div>' +
      '<div class="p86-pair-label p86-pair-label-after">AFTER</div>';

    var beforeImg = root.querySelector('.p86-pair-before');
    var handle = root.querySelector('.p86-pair-handle');

    function setPct(pct) {
      pct = Math.max(0, Math.min(100, pct));
      beforeImg.style.clipPath = 'inset(0 ' + (100 - pct) + '% 0 0)';
      handle.style.left = pct + '%';
      root.setAttribute('aria-valuenow', String(Math.round(pct)));
      root._currentPct = pct;
    }
    root._currentPct = startPct;

    function pctFromEvent(e) {
      var rect = root.getBoundingClientRect();
      var x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      return (x / rect.width) * 100;
    }

    var dragging = false;
    function onDown(e) {
      dragging = true;
      root.classList.add('p86-pair-dragging');
      setPct(pctFromEvent(e));
      if (e.cancelable) e.preventDefault();
    }
    function onMove(e) {
      if (!dragging) return;
      setPct(pctFromEvent(e));
      if (e.cancelable) e.preventDefault();
    }
    function onUp() {
      dragging = false;
      root.classList.remove('p86-pair-dragging');
    }

    root.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    root.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);

    // Keyboard support — arrow keys move 5% per press.
    root.addEventListener('keydown', function(e) {
      var current = root._currentPct == null ? 50 : root._currentPct;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        setPct(current - 5);
        e.preventDefault();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        setPct(current + 5);
        e.preventDefault();
      } else if (e.key === 'Home') {
        setPct(0); e.preventDefault();
      } else if (e.key === 'End') {
        setPct(100); e.preventDefault();
      }
    });

    return root;
  }

  // Compact tile for the photo feed. Same slider, sized for a grid.
  // The whole tile is clickable to open the lightbox EXCEPT the
  // slider handle area — we use a stop-propagation on the handle so
  // dragging doesn't trigger an open.
  function renderTile(pair, opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'p86-pair-tile';
    wrap.setAttribute('data-pair-id', pair.id);

    var slider = buildSlider(pair.before_thumb_url || pair.before_web_url, pair.after_thumb_url || pair.after_web_url, { start: 50 });
    wrap.appendChild(slider);

    // Caption strip below the slider — label + delete button.
    var caption = document.createElement('div');
    caption.className = 'p86-pair-tile-caption';
    caption.innerHTML =
      '<div class="p86-pair-tile-label" title="' + escapeAttr(pair.label || '') + '">' +
        (pair.label ? escapeHTML(pair.label) : '<span style="font-style:italic;color:var(--text-dim,#888);">Untitled pair</span>') +
      '</div>' +
      '<button type="button" class="p86-pair-tile-menu" title="Pair options">&#x22EE;</button>';
    wrap.appendChild(caption);

    // Click slider area (not the handle) → lightbox.
    slider.addEventListener('click', function(e) {
      if (e.target.closest('.p86-pair-handle')) return;
      openLightbox(pair, opts);
    });

    // Menu → delete.
    caption.querySelector('.p86-pair-tile-menu').addEventListener('click', function(e) {
      e.stopPropagation();
      if (typeof opts.onDelete === 'function') {
        if (window.confirm('Delete this Before/After pair? The underlying photos stay.')) {
          opts.onDelete(pair);
        }
      }
    });

    return wrap;
  }

  // Full-screen lightbox-style overlay. Reuses the same slider but
  // scaled up to fit the viewport.
  function openLightbox(pair, opts) {
    opts = opts || {};
    var prior = document.getElementById('p86-pair-lightbox');
    if (prior) prior.remove();

    var overlay = document.createElement('div');
    overlay.id = 'p86-pair-lightbox';
    overlay.className = 'p86-pair-lightbox-overlay';
    overlay.innerHTML =
      '<div class="p86-pair-lightbox-header">' +
        '<div class="p86-pair-lightbox-title">' +
          (pair.label ? escapeHTML(pair.label) : '<span style="font-style:italic;opacity:0.7;">Untitled pair</span>') +
        '</div>' +
        '<button type="button" class="p86-pair-lightbox-close">&times;</button>' +
      '</div>' +
      '<div class="p86-pair-lightbox-body"></div>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    var body = overlay.querySelector('.p86-pair-lightbox-body');
    var slider = buildSlider(
      pair.before_web_url || pair.before_thumb_url,
      pair.after_web_url || pair.after_thumb_url,
      { start: 50 }
    );
    slider.classList.add('p86-pair-slider-lightbox');
    body.appendChild(slider);

    function close() {
      overlay.remove();
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.p86-pair-lightbox-close').addEventListener('click', close);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) close();
    });
  }

  window.p86ProjectsPairs = {
    renderTile: renderTile,
    openLightbox: openLightbox,
    buildSlider: buildSlider
  };
})();
