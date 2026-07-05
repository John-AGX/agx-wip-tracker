// Universal search-input clear (×) button.
// Decorates every "search" input across the app with a right-side clear button
// that appears when there's text, clears the field, and fires input/change so the
// list re-filters. Self-mounting via a wrapper span so the × travels with the
// input (no orphaned buttons when a list re-renders). Author layout intent
// (inline margin/flex/width/min-width) is carried to the wrapper so the search
// bar keeps its position (e.g. margin-left:auto pushing it to the right).
(function () {
  'use strict';
  if (window.__p86SearchClear) return; window.__p86SearchClear = true;

  function injectCss() {
    if (document.getElementById('p86-srch-clear-css')) return;
    var s = document.createElement('style'); s.id = 'p86-srch-clear-css';
    s.textContent =
      '.p86-srch-wrap{position:relative;align-items:center;vertical-align:middle;}' +
      '.p86-srch-x{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:18px;height:18px;padding:0;border:0;' +
      'border-radius:50%;background:rgba(140,145,160,.30);color:#fff;font-size:15px;line-height:1;cursor:pointer;display:none;' +
      'align-items:center;justify-content:center;opacity:.82;z-index:2;transition:background .12s,opacity .12s;}' +
      '.p86-srch-x:hover{opacity:1;background:rgba(140,145,160,.55);}' +
      'body.light-mode .p86-srch-x{background:rgba(20,24,40,.32);}' +
      'body.light-mode .p86-srch-x:hover{background:rgba(20,24,40,.5);}';
    document.head.appendChild(s);
  }

  function skip(input) {
    if (!input || input.dataset.p86SrchClear || input.type === 'hidden') return true;
    var ph = input.getAttribute('placeholder') || '';
    if (/create/i.test(ph)) return true;                 // tag comboboxes ("Search or create…") aren't search bars
    if (input.closest && input.closest('[data-p86-no-clear]')) return true;
    return false;
  }

  function decorate(input) {
    if (skip(input)) return;
    input.dataset.p86SrchClear = '1';
    var cs;
    try { cs = window.getComputedStyle(input); } catch (e) { cs = null; }
    var block = cs && cs.display === 'block';
    var wrap = document.createElement('span');
    wrap.className = 'p86-srch-wrap';
    wrap.style.display = block ? 'flex' : 'inline-flex';

    var inl = input.style;
    // Does the input stretch to fill its slot (block, or a flex-grow item, or width:100%)?
    var grows = block || (cs && (parseFloat(cs.flexGrow) || 0) > 0) || inl.width === '100%';
    // Move only POSITIONING props (margin/flex/align) onto the wrapper so it sits exactly
    // where the input did — e.g. margin-left:auto keeps the bar right-aligned. Keep SIZING
    // (width / min-width) on the INPUT so a fixed/min-width search box stays compact and
    // the wrapper shrinks to fit it (the previous width:100% made every bar balloon).
    ['margin', 'marginLeft', 'marginRight', 'marginTop', 'marginBottom', 'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf'].forEach(function (p) {
      if (inl[p]) { wrap.style[p] = inl[p]; inl[p] = ''; }
    });
    if (block || inl.width) wrap.style.width = inl.width || '100%';

    if (!input.parentNode) return;
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    if (grows) { input.style.width = '100%'; input.style.minWidth = '0'; }
    input.style.boxSizing = 'border-box';
    var pr = cs ? (parseFloat(cs.paddingRight) || 0) : 0;
    if (pr < 26) input.style.paddingRight = '26px';

    var x = document.createElement('button');
    x.type = 'button'; x.className = 'p86-srch-x'; x.tabIndex = -1;
    x.setAttribute('aria-label', 'Clear search'); x.innerHTML = '&times;';
    wrap.appendChild(x);

    function sync() { x.style.display = (input.value && input.value.length) ? 'flex' : 'none'; }
    input.addEventListener('input', sync);
    x.addEventListener('mousedown', function (e) { e.preventDefault(); });   // don't steal focus/blur
    x.addEventListener('click', function () {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus(); sync();
    });
    sync();
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
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
