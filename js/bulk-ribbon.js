// Shared bulk-action ribbon — the compact Buildertrend-style pill that
// floats bottom-center while rows are multi-selected. One row: count,
// clear ✕, divider, icon-only actions. Dropdown-style actions open a
// small popup menu ABOVE the pill (the pill is anchored to the bottom
// of the viewport). Used by Leads / Jobs / Estimates / Jobs-Hub bars.
//
//   window.p86BulkRibbon.render(barEl, {
//     count: 3,
//     onClear: function () {},
//     actions: [
//       { icon: 'exports',  title: 'Export',     onClick: fn },
//       { icon: 'bookmark', title: 'Set status', menu: [{ label, onClick }] },
//       { icon: 'schedule', title: 'Follow-up',  date: true, onPick: fn(yyyy_mm_dd) },
//       { icon: 'delete',   title: 'Delete',     danger: true, onClick: fn }
//     ]
//   });
//   window.p86BulkRibbon.hide(barEl);
(function () {
  'use strict';

  // Two glyphs the generated icon catalog doesn't have (primitive shapes
  // only, drawn to match the heroicons 1.2-stroke look).
  var XMARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var XCIRCLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/></svg>';

  function iconHtml(name) {
    if (name === 'x-mark') return XMARK;
    if (name === 'x-circle') return XCIRCLE;
    try {
      if (window.p86Icon) {
        var s = window.p86Icon(name, { size: 18 });
        if (s) return s;
      }
    } catch (e) { /* fall through */ }
    return XCIRCLE;
  }

  function closeMenu() {
    var m = document.getElementById('p86-bulkmenu');
    if (m) m.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('popstate', closeMenu);
    window.removeEventListener('hashchange', closeMenu);
  }
  // The popup is position:fixed with coordinates computed once, so any
  // scroll/resize/navigation would detach it from its anchor — close instead.
  function onScroll(e) {
    var m = document.getElementById('p86-bulkmenu');
    if (m && m.contains(e.target)) return; // scrolling the menu's own list
    closeMenu();
  }
  function onDocDown(e) {
    var m = document.getElementById('p86-bulkmenu');
    if (!m || m.contains(e.target)) return;
    // Don't close on the anchor button's own mousedown — its click handler
    // owns the toggle (otherwise mousedown closes + click reopens forever).
    if (m._anchor && m._anchor.contains(e.target)) return;
    closeMenu();
  }
  function onKey(e) { if (e.key === 'Escape') closeMenu(); }

  function openMenu(btn, action) {
    var existing = document.getElementById('p86-bulkmenu');
    var toggling = existing && existing._anchor === btn;
    closeMenu();
    if (toggling) return;
    var pop = document.createElement('div');
    pop.id = 'p86-bulkmenu';
    pop.className = 'p86-bulkmenu';
    pop._anchor = btn;
    if (action.menu) {
      if (!action.menu.length) {
        var none = document.createElement('div');
        none.className = 'p86-bulkmenu-item';
        none.style.cursor = 'default';
        none.style.opacity = '0.6';
        none.textContent = 'No options';
        pop.appendChild(none);
      }
      action.menu.forEach(function (item) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'p86-bulkmenu-item';
        b.textContent = item.label;
        b.addEventListener('click', function () {
          closeMenu();
          if (item.onClick) item.onClick();
        });
        pop.appendChild(b);
      });
    } else if (action.date) {
      var wrap = document.createElement('div');
      wrap.className = 'p86-bulkmenu-date';
      var inp = document.createElement('input');
      inp.type = 'date';
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'p86-bulkmenu-apply';
      go.textContent = 'Apply';
      go.addEventListener('click', function () {
        var v = inp.value;
        if (!v) return;
        closeMenu();
        if (action.onPick) action.onPick(v);
      });
      wrap.appendChild(inp);
      wrap.appendChild(go);
      pop.appendChild(wrap);
    }
    document.body.appendChild(pop);
    // Anchor above the icon button, horizontally centered, clamped on-screen.
    // Vertically: never let a long list grow past the top of the viewport
    // (its own scrollbar takes over instead).
    var r = btn.getBoundingClientRect();
    pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    pop.style.maxHeight = Math.max(100, Math.min(280, r.top - 16)) + 'px';
    var left = r.left + r.width / 2 - pop.offsetWidth / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8));
    pop.style.left = left + 'px';
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('popstate', closeMenu);
    window.addEventListener('hashchange', closeMenu);
    var focusable = pop.querySelector('input');
    if (focusable && focusable.focus) focusable.focus();
  }

  function render(bar, cfg) {
    if (!bar) return;
    closeMenu();
    bar.style.cssText = '';
    bar.className = 'p86-bulkbar-float';
    bar.innerHTML = '';

    var count = document.createElement('span');
    count.className = 'p86-bulkbar-count';
    count.textContent = cfg.count + ' Selected';
    bar.appendChild(count);

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'p86-bulkbar-btn p86-bulkbar-x';
    x.title = 'Clear selection';
    x.setAttribute('aria-label', 'Clear selection');
    x.innerHTML = XMARK;
    x.addEventListener('click', function () {
      closeMenu();
      if (cfg.onClear) cfg.onClear();
    });
    bar.appendChild(x);

    var divider = document.createElement('span');
    divider.className = 'p86-bulkbar-divider';
    bar.appendChild(divider);

    (cfg.actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'p86-bulkbar-btn' + (a.danger ? ' danger' : '');
      b.title = a.title || '';
      b.setAttribute('aria-label', a.title || '');
      b.innerHTML = iconHtml(a.icon);
      if (a.menu || a.date) {
        b.addEventListener('click', function () { openMenu(b, a); });
      } else {
        b.addEventListener('click', function () {
          closeMenu();
          if (a.onClick) a.onClick();
        });
      }
      bar.appendChild(b);
    });
  }

  function hide(bar) {
    if (!bar) return;
    closeMenu();
    bar.className = '';
    bar.style.display = 'none';
    bar.innerHTML = '';
  }

  window.p86BulkRibbon = { render: render, hide: hide };
})();
