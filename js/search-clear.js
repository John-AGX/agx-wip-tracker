// Universal search-input clear (×) button.
// Overlay approach: instead of wrapping the input (which fought the app's global
// `input{display:block}` + inline min-width/margin-left:auto and made search bars
// balloon), we float a position:fixed × over the input's right edge and leave the
// input's own layout 100% untouched (only a little padding-right so text clears the
// ×). The × shows when the field is visible + has text, clears it, and fires
// input/change so the list re-filters. Works for every search bar across the app,
// including lazily-rendered lists (MutationObserver + a light reposition tick).
(function () {
  'use strict';
  if (window.__p86SearchClear) return; window.__p86SearchClear = true;

  function injectCss() {
    if (document.getElementById('p86-srch-clear-css')) return;
    var s = document.createElement('style'); s.id = 'p86-srch-clear-css';
    s.textContent =
      '.p86-srch-x{position:fixed;width:18px;height:18px;padding:0;border:0;border-radius:50%;' +
      'background:rgba(140,145,160,.32);color:#fff;font-size:14px;line-height:1;cursor:pointer;' +
      'display:none;align-items:center;justify-content:center;opacity:.85;z-index:2147483000;' +
      'transition:opacity .12s,background .12s;}' +
      '.p86-srch-x:hover{opacity:1;background:rgba(140,145,160,.55);}' +
      'body.light-mode .p86-srch-x{background:rgba(20,24,40,.34);}' +
      'body.light-mode .p86-srch-x:hover{background:rgba(20,24,40,.52);}';
    document.head.appendChild(s);
  }

  var recs = [];   // { input, btn, dead }

  function place(rec) {
    var input = rec.input, btn = rec.btn;
    if (!document.contains(input)) { btn.remove(); rec.dead = true; return; }
    var visible = input.offsetParent !== null && input.getClientRects().length > 0;
    if (!visible || !input.value) { btn.style.display = 'none'; return; }
    var r = input.getBoundingClientRect();
    if (r.width === 0) { btn.style.display = 'none'; return; }
    btn.style.display = 'flex';
    btn.style.left = Math.round(r.right - 23) + 'px';
    btn.style.top = Math.round(r.top + r.height / 2 - 9) + 'px';
  }
  function placeAll() {
    var live = [];
    for (var i = 0; i < recs.length; i++) { var rec = recs[i]; if (rec.dead) continue; place(rec); if (!rec.dead) live.push(rec); }
    recs = live;
  }

  function skip(input) {
    if (!input || input.dataset.p86SrchClear || input.type === 'hidden') return true;
    if (/create/i.test(input.getAttribute('placeholder') || '')) return true;   // tag comboboxes aren't search bars
    if (input.closest && input.closest('[data-p86-no-clear]')) return true;
    return false;
  }
  function decorate(input) {
    if (skip(input)) return;
    input.dataset.p86SrchClear = '1';
    try { var cs = window.getComputedStyle(input); if ((parseFloat(cs.paddingRight) || 0) < 24) input.style.paddingRight = '24px'; } catch (e) {}
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'p86-srch-x'; btn.tabIndex = -1;
    btn.setAttribute('aria-label', 'Clear search'); btn.innerHTML = '&times;';
    document.body.appendChild(btn);
    var rec = { input: input, btn: btn, dead: false };
    recs.push(rec);
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the input's focus
    btn.addEventListener('click', function () {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus(); place(rec);
    });
    input.addEventListener('input', function () { place(rec); });
    input.addEventListener('focus', function () { place(rec); });
    input.addEventListener('blur', function () { setTimeout(function () { place(rec); }, 0); });
    place(rec);
  }

  var SEL = 'input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]';
  function scan(root) { try { (root || document).querySelectorAll(SEL).forEach(decorate); } catch (e) {} }

  function boot() {
    injectCss();
    scan(document);
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var an = muts[i].addedNodes; if (!an) continue;
          for (var j = 0; j < an.length; j++) {
            var n = an[j]; if (n.nodeType !== 1) continue;
            if (n.matches && n.matches(SEL)) decorate(n);
            else if (n.querySelectorAll) scan(n);
          }
        }
        placeAll();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    window.addEventListener('scroll', placeAll, true);
    window.addEventListener('resize', placeAll);
    // Catches tab switches / list re-renders that don't fire scroll/resize/input.
    setInterval(placeAll, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
