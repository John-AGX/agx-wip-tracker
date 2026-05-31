/* ── Table enhancements (Jobs / Estimates / Leads lists) ─────────────
   Turns the three big list tables into "data-grid" style tables:

     1. Internal scroll — the table body scrolls inside the viewport
        instead of growing the page (max-height bounded to the screen).
     2. Reorder columns — drag a header left/right to move a column.
     3. Resize columns — drag the right edge of a header.
     4. Freeze the first column — the Job # / Title column stays pinned
        on the left while the rest of the table scrolls horizontally.
        The frozen column is ALWAYS forced to index 0.
     5. Persist layout — column order + widths are saved per-table in
        localStorage (`p86_tablayout_<key>_v1`) and reapplied on render.
     6. Right-click a header → "Reset columns" to restore defaults.

   Each list renderer calls window.p86Tables.enhance('<key>') at the end
   of building its table. The module is idempotent: it reorders the
   <th>/<td> cells by their `data-col` attribute and re-applies widths
   on every call, so it survives the renderers rebuilding their <tbody>.

   Cells WITHOUT a full set of data-col attributes (e.g. an empty-state
   "no results" colspan row) are skipped.

   Exposes window.p86Tables = { enhance, reset }. */
(function () {
  'use strict';

  var LS_PREFIX = 'p86_tablayout_';
  var LS_SUFFIX = '_v1';
  var DRAG_THRESHOLD = 5;   // px before a header mousedown becomes a drag
  var MIN_COL_W = 48;       // px, smallest a column can be resized to
  var BOTTOM_GAP = 20;      // px breathing room below the scroll area
  var MIN_TABLE_H = 240;    // px, never shrink the scroll area below this

  // Per-table config. `selector` resolves the <table> fresh each call
  // (estimates/leads rebuild their whole table on render). `frozen` is
  // the data-col key pinned to the left and forced to index 0. `widths`
  // are sensible default column widths (px) used until the user resizes.
  var REGISTRY = {
    jobs: {
      selector: '#jobs-table',
      frozen: 'name',
      frozenBg: 'var(--bg,#0f1117)',
      widths: { idx: 50, name: 320, client: 200, pm: 170, status: 130,
                contract: 150, pctcomplete: 150, profit: 150, margin: 110 }
    },
    estimates: {
      selector: '#estimates-list table',
      frozen: 'title',
      frozenBg: 'var(--card-bg,#0f0f1e)',
      widths: { title: 280, client: 220, lines: 70, baseCost: 130,
                markup: 110, clientPrice: 140, margin: 110, updated_at: 120 }
    },
    leads: {
      selector: '#leads-list table',
      frozen: 'title',
      frozenBg: 'var(--card-bg,#0f0f1e)',
      widths: { title: 280, client: 220, status: 130, revenue: 130,
                confidence: 90, salesperson: 160, project_type: 160,
                projected_sale_date: 130, updated_at: 120 }
    }
  };

  var active = null;          // in-flight drag/resize gesture state
  var suppressClick = false;  // swallow the trailing header click after a drag/resize
  var resizeHandlerInstalled = false;
  var menuEl = null;          // floating reset menu
  // Natural (renderer-emitted) column order per table, captured on the
  // first enhance BEFORE any reordering. This is the canonical default
  // that "Reset columns" restores to — the live DOM order can't serve as
  // the default because by reset time it's already the reordered layout.
  var DEFAULT_ORDER = {};

  // ── localStorage ────────────────────────────────────────────────
  function lsKey(key) { return LS_PREFIX + key + LS_SUFFIX; }

  function loadLayout(key) {
    try {
      var raw = localStorage.getItem(lsKey(key));
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      return {
        order: Array.isArray(o.order) ? o.order : null,
        widths: (o.widths && typeof o.widths === 'object') ? o.widths : {}
      };
    } catch (e) { return null; }
  }

  function saveLayout(key, layout) {
    try { localStorage.setItem(lsKey(key), JSON.stringify(layout)); } catch (e) {}
  }

  function clearLayout(key) {
    try { localStorage.removeItem(lsKey(key)); } catch (e) {}
  }

  // ── DOM helpers ─────────────────────────────────────────────────
  function headerCells(table) {
    var thead = table.tHead;
    if (!thead || !thead.rows.length) return [];
    return Array.prototype.slice.call(thead.rows[0].cells)
      .filter(function (th) { return th.getAttribute('data-col'); });
  }

  function currentOrder(table) {
    return headerCells(table).map(function (th) { return th.getAttribute('data-col'); });
  }

  function currentWidths(table) {
    var w = {};
    headerCells(table).forEach(function (th) {
      w[th.getAttribute('data-col')] = th.offsetWidth;
    });
    return w;
  }

  // Final column order: saved order (filtered to known cols) + any new
  // cols appended, then the frozen key forced to the front.
  function computeOrder(key, table) {
    // Base on the captured natural order so a reset (or a saved layout
    // missing some cols) restores the true default, not the live DOM
    // order which may already be reordered.
    var def = (DEFAULT_ORDER[key] || currentOrder(table)).slice();
    var order = def.slice();
    var layout = loadLayout(key);
    if (layout && layout.order && layout.order.length) {
      var known = {};
      def.forEach(function (c) { known[c] = true; });
      var saved = layout.order.filter(function (c) { return known[c]; });
      def.forEach(function (c) { if (saved.indexOf(c) === -1) saved.push(c); });
      order = saved;
    }
    var fr = REGISTRY[key].frozen;
    var i = order.indexOf(fr);
    if (i > 0) { order.splice(i, 1); order.unshift(fr); }
    return order;
  }

  function colWidths(key, table, order) {
    var layout = loadLayout(key);
    var saved = (layout && layout.widths) || {};
    var defs = REGISTRY[key].widths || {};
    var w = {};
    order.forEach(function (c) {
      var v = saved[c] != null ? saved[c] : defs[c];
      if (v == null) v = 140;
      w[c] = Math.max(MIN_COL_W, Math.round(v));
    });
    return w;
  }

  // ── apply layout ────────────────────────────────────────────────
  // Reorder <th> and every <tbody> row's <td> to match `order`. Uses
  // appendChild's move semantics — idempotent and cheap. Rows that lack
  // the full data-col set (empty-state colspan rows) are left alone.
  function applyOrder(table, order) {
    var thead = table.tHead;
    if (thead && thead.rows.length) {
      var hr = thead.rows[0];
      var hmap = {};
      Array.prototype.forEach.call(hr.cells, function (th) {
        var c = th.getAttribute('data-col');
        if (c) hmap[c] = th;
      });
      order.forEach(function (c) { if (hmap[c]) hr.appendChild(hmap[c]); });
    }
    var tb = table.tBodies[0];
    if (tb) {
      Array.prototype.forEach.call(tb.rows, function (tr) {
        var cmap = {}, count = 0;
        Array.prototype.forEach.call(tr.cells, function (td) {
          var c = td.getAttribute('data-col');
          if (c) { cmap[c] = td; count++; }
        });
        if (count < order.length) return; // empty-state / colspan row
        order.forEach(function (c) { if (cmap[c]) tr.appendChild(cmap[c]); });
      });
    }
  }

  function applyWidths(table, order, widths) {
    var total = 0;
    order.forEach(function (c) { total += widths[c]; });
    table.style.width = total + 'px';
    table.style.minWidth = total + 'px';
    var thead = table.tHead;
    if (thead && thead.rows.length) {
      Array.prototype.forEach.call(thead.rows[0].cells, function (th) {
        var c = th.getAttribute('data-col');
        if (c && widths[c] != null) th.style.width = widths[c] + 'px';
      });
    }
  }

  function applyFrozen(table, frozen) {
    var prev = table.querySelectorAll('.p86-frozen-col');
    Array.prototype.forEach.call(prev, function (el) { el.classList.remove('p86-frozen-col'); });
    if (!frozen) return;
    var thead = table.tHead;
    if (thead && thead.rows.length) {
      var th = thead.rows[0].querySelector('[data-col="' + frozen + '"]');
      if (th) th.classList.add('p86-frozen-col');
    }
    var tb = table.tBodies[0];
    if (tb) {
      Array.prototype.forEach.call(tb.rows, function (tr) {
        var td = tr.querySelector('[data-col="' + frozen + '"]');
        if (td) td.classList.add('p86-frozen-col');
      });
    }
  }

  // ── internal scroll height ──────────────────────────────────────
  function recomputeHeight(wrap) {
    if (!wrap || !wrap.offsetParent) return; // hidden tab — skip
    var rect = wrap.getBoundingClientRect();
    var reserve = BOTTOM_GAP;
    var nav = document.getElementById('p86-mobile-nav');
    if (nav) {
      var cs = window.getComputedStyle(nav);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') reserve += nav.offsetHeight;
    }
    var h = window.innerHeight - rect.top - reserve;
    if (h < MIN_TABLE_H) h = MIN_TABLE_H;
    wrap.style.maxHeight = h + 'px';
    wrap.style.overflow = 'auto';
  }

  function setupScroll(table) {
    var wrap = table.parentElement;
    if (!wrap) return;
    wrap.classList.add('p86-tbl-scroll');
    recomputeHeight(wrap);
    observeVisibility(wrap);
  }

  // Lists that live inside hidden subtabs (Estimates / Leads) render
  // while display:none, so recomputeHeight bails (correctly). When the
  // subtab is later shown, nothing re-triggers the measurement — the
  // window-resize handler only fires on an actual resize. An
  // IntersectionObserver re-bounds the wrapper the moment it becomes
  // visible. Guarded so we never attach twice to the same element.
  function observeVisibility(wrap) {
    if (wrap.dataset.p86VisObs) return;
    if (typeof IntersectionObserver === 'undefined') return;
    wrap.dataset.p86VisObs = '1';
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) { recomputeHeight(wrap); break; }
      }
    });
    io.observe(wrap);
  }

  function recomputeAll() {
    Object.keys(REGISTRY).forEach(function (key) {
      var table = document.querySelector(REGISTRY[key].selector);
      if (table && table.classList.contains('p86-enhanced')) {
        recomputeHeight(table.parentElement);
      }
    });
  }

  function installResizeHandler() {
    if (resizeHandlerInstalled) return;
    resizeHandlerInstalled = true;
    var t;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(recomputeAll, 120);
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(recomputeAll, 200);
    });
  }

  // ── resize gesture ──────────────────────────────────────────────
  function startResize(e, key, table, th, col) {
    e.preventDefault();
    e.stopPropagation();
    active = {
      type: 'resize', key: key, table: table, th: th, col: col,
      startX: e.clientX, startW: th.offsetWidth, widths: currentWidths(table)
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── reorder gesture ─────────────────────────────────────────────
  function startReorder(e, key, table, th, col) {
    active = {
      type: 'reorder', key: key, table: table, th: th, col: col,
      startX: e.clientX, dragging: false
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function onMove(e) {
    if (!active) return;
    if (active.type === 'resize') {
      var nw = Math.max(MIN_COL_W, active.startW + (e.clientX - active.startX));
      active.th.style.width = nw + 'px';
      active.widths[active.col] = nw;
      var total = 0;
      for (var k in active.widths) { if (active.widths.hasOwnProperty(k)) total += active.widths[k]; }
      active.table.style.width = total + 'px';
      active.table.style.minWidth = total + 'px';
      suppressClick = true;
    } else if (active.type === 'reorder') {
      if (!active.dragging) {
        if (Math.abs(e.clientX - active.startX) < DRAG_THRESHOLD) return;
        active.dragging = true;
        active.th.classList.add('p86-th-dragging');
        document.body.style.userSelect = 'none';
      }
      suppressClick = true;
    }
  }

  function onUp(e) {
    if (!active) { cleanupMove(); return; }
    if (active.type === 'resize') {
      persistWidths(active.key, active.table);
    } else if (active.type === 'reorder' && active.dragging) {
      active.th.classList.remove('p86-th-dragging');
      var order = computeDropOrder(active.key, active.table, active.col, e.clientX);
      applyOrder(active.table, order);
      applyFrozen(active.table, REGISTRY[active.key].frozen);
      persistOrder(active.key, active.table, order);
    }
    cleanupMove();
  }

  function cleanupMove() {
    active = null;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }

  // Where does the dragged column land? Count how many OTHER columns'
  // horizontal centers sit left of the cursor, insert there, then snap
  // the frozen column back to index 0.
  function computeDropOrder(key, table, col, clientX) {
    var order = currentOrder(table);
    var rects = {};
    headerCells(table).forEach(function (th) {
      rects[th.getAttribute('data-col')] = th.getBoundingClientRect();
    });
    var others = order.filter(function (c) { return c !== col; });
    var idx = 0;
    for (var i = 0; i < others.length; i++) {
      var r = rects[others[i]];
      if (r && (r.left + r.width / 2) < clientX) idx = i + 1;
    }
    others.splice(idx, 0, col);
    var fr = REGISTRY[key].frozen;
    var fi = others.indexOf(fr);
    if (fi > 0) { others.splice(fi, 1); others.unshift(fr); }
    return others;
  }

  function persistOrder(key, table, order) {
    var layout = loadLayout(key) || { order: null, widths: {} };
    layout.order = order;
    saveLayout(key, layout);
  }

  function persistWidths(key, table) {
    var layout = loadLayout(key) || { order: null, widths: {} };
    layout.widths = currentWidths(table);
    if (!layout.order) layout.order = currentOrder(table);
    saveLayout(key, layout);
  }

  // ── header wiring (resizer + drag + reset menu) ─────────────────
  function wireHeader(key, table) {
    var frozen = REGISTRY[key].frozen;
    var thead = table.tHead;
    if (!thead || !thead.rows.length) return;

    if (!thead.dataset.p86ClickGuard) {
      thead.dataset.p86ClickGuard = '1';
      // Capture-phase: swallow the click that follows a drag/resize so
      // it doesn't trigger the inline sort onclick on the <th>.
      thead.addEventListener('click', function (e) {
        if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
      }, true);
      thead.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        showResetMenu(key, e.clientX, e.clientY);
      });
    }

    Array.prototype.forEach.call(thead.rows[0].cells, function (th) {
      var c = th.getAttribute('data-col');
      if (!c || th.dataset.p86Wired) return;
      th.dataset.p86Wired = '1';

      var rz = document.createElement('div');
      rz.className = 'p86-col-resizer';
      rz.addEventListener('mousedown', function (e) { startResize(e, key, table, th, c); });
      rz.addEventListener('click', function (e) { e.stopPropagation(); });
      th.appendChild(rz);

      if (c !== frozen) {
        th.title = th.title || 'Drag to reorder · drag the right edge to resize';
        th.addEventListener('mousedown', function (e) {
          if (e.target === rz) return;       // resizer owns the edge
          if (e.button !== 0) return;         // left button only
          startReorder(e, key, table, th, c);
        });
      }
    });
  }

  // ── reset menu ──────────────────────────────────────────────────
  function showResetMenu(key, x, y) {
    hideResetMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'p86-tbl-menu';
    menuEl.style.left = x + 'px';
    menuEl.style.top = y + 'px';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'p86-tbl-menu-item';
    btn.textContent = 'Reset columns';
    btn.addEventListener('click', function () { hideResetMenu(); reset(key); });
    menuEl.appendChild(btn);
    document.body.appendChild(menuEl);
    // Keep the menu on-screen if opened near the right/bottom edge.
    var r = menuEl.getBoundingClientRect();
    if (r.right > window.innerWidth) menuEl.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight) menuEl.style.top = (window.innerHeight - r.height - 8) + 'px';
    setTimeout(function () {
      document.addEventListener('mousedown', onMenuOutside, true);
      document.addEventListener('keydown', onMenuKey, true);
    }, 0);
  }

  function onMenuOutside(e) { if (menuEl && !menuEl.contains(e.target)) hideResetMenu(); }
  function onMenuKey(e) { if (e.key === 'Escape') hideResetMenu(); }

  function hideResetMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
    document.removeEventListener('mousedown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }

  // ── public API ──────────────────────────────────────────────────
  function enhance(key) {
    var reg = REGISTRY[key];
    if (!reg) return;
    var table = document.querySelector(reg.selector);
    if (!table) return;
    if (!headerCells(table).length) return; // headers not tagged yet

    // Capture the renderer's natural column order ONCE, before we ever
    // reorder the DOM, so "Reset columns" has a true default to restore.
    if (!DEFAULT_ORDER[key]) DEFAULT_ORDER[key] = currentOrder(table);

    table.classList.add('p86-enhanced');
    table.style.setProperty('--p86-frozen-bg', reg.frozenBg);
    // Inline so it beats any inline `table-layout:auto` (leads sets one).
    table.style.tableLayout = 'fixed';

    var order = computeOrder(key, table);
    applyOrder(table, order);
    applyWidths(table, order, colWidths(key, table, order));
    applyFrozen(table, reg.frozen);
    wireHeader(key, table);
    setupScroll(table);
    installResizeHandler();

    // Re-measure once layout settles (covers tab-show after display:none).
    requestAnimationFrame(function () { recomputeHeight(table.parentElement); });
  }

  function reset(key) {
    var reg = REGISTRY[key];
    if (!reg) return;
    clearLayout(key);
    var table = document.querySelector(reg.selector);
    if (!table) return;
    var hr = table.tHead && table.tHead.rows[0];
    if (hr) Array.prototype.forEach.call(hr.cells, function (th) { th.style.width = ''; });
    table.style.width = '';
    table.style.minWidth = '';
    enhance(key); // reapply defaults
  }

  window.p86Tables = { enhance: enhance, reset: reset };
})();
