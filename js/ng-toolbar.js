// Site Plan ribbon extras — the 👁 Layers and ⋯ More popovers.
// The ribbon buttons that moved INTO the popovers keep their original
// classes/ids, so nodegraph/ui.js wiring (tab.querySelector) is
// untouched. This file only owns: popover open/close, the pure-CSS
// layer checks (wires / node chips / minimap / help bar), and their
// localStorage persistence.
(function () {
  var tab = document.getElementById('nodeGraphTab');
  if (!tab) return;

  var LS_KEY = 'p86-ng-layers';
  function loadState() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveState(st) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch (e) { /* ignore */ }
  }
  // state[key] === true means the layer is HIDDEN.
  var state = loadState();
  function applyLayer(key, hidden) {
    tab.classList.toggle('ngl-no-' + key, !!hidden);
  }
  Object.keys(state).forEach(function (k) { applyLayer(k, state[k]); });

  function closeAllPops() {
    document.querySelectorAll('.ng-pop').forEach(function (p) { p.setAttribute('hidden', ''); });
    ['ngLayersBtn', 'ngMoreBtn'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.classList.remove('ng-on');
    });
  }

  function wirePop(btnId, popId) {
    var btn = document.getElementById(btnId);
    var pop = document.getElementById(popId);
    if (!btn || !pop) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = pop.hasAttribute('hidden');
      closeAllPops();
      if (willOpen) {
        pop.removeAttribute('hidden');
        btn.classList.add('ng-on');
      }
    });
    // Clicks inside the popover shouldn't dismiss it (the pin toggles
    // and layer checks are multi-click affairs).
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
  }
  wirePop('ngLayersBtn', 'ngLayersPop');
  wirePop('ngMoreBtn', 'ngMorePop');

  document.addEventListener('click', closeAllPops);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAllPops();
  });

  document.querySelectorAll('.ng-pop-check[data-ngl]').forEach(function (chk) {
    var key = chk.getAttribute('data-ngl');
    function paint() { chk.classList.toggle('on', !state[key]); }
    paint();
    chk.addEventListener('click', function () {
      state[key] = !state[key];
      applyLayer(key, state[key]);
      saveState(state);
      paint();
    });
  });
})();
