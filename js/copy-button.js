// Project 86 Copy-to-Clipboard helper.
//
// Auto-attaches a small clipboard button (📋) to:
//   • <input type="email">
//   • Any element with the data-p86-copy attribute (inputs, textareas)
//   • Read-only display elements with data-p86-copy-display
//
// Skipped on inputs that opt out with data-p86-no-copy.
//
// A MutationObserver re-scans whenever new nodes are added so modals
// rebuilt via `innerHTML = '<form…>'` get redecorated automatically.

(function () {
  'use strict';
  if (window.p86CopyToClipboard) return;

  function copy(text, btn) {
    if (!text) return;
    var s = String(text).trim();
    if (!s) return;
    var p = (navigator.clipboard && navigator.clipboard.writeText)
      ? navigator.clipboard.writeText(s)
      : Promise.reject(new Error('no clipboard api'));
    p.catch(function () {
      // Fallback for older / insecure contexts: invisible textarea +
      // document.execCommand. Loses focus on the active element so we
      // restore it afterwards.
      var prev = document.activeElement;
      var ta = document.createElement('textarea');
      ta.value = s;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
      if (prev && typeof prev.focus === 'function') prev.focus();
    });
    if (btn) flash(btn);
  }

  function flash(btn) {
    var orig = btn.dataset.p86CopyOrig || btn.textContent;
    btn.dataset.p86CopyOrig = orig;
    btn.textContent = '✓';
    btn.classList.add('p86-copy-flashed');
    clearTimeout(btn._p86CopyTimer);
    btn._p86CopyTimer = setTimeout(function () {
      btn.textContent = orig;
      btn.classList.remove('p86-copy-flashed');
    }, 900);
  }

  function isEligibleInput(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
    if (el.dataset.p86CopyDecorated === '1') return false;
    if (el.hasAttribute('data-p86-no-copy')) return false;
    if (el.hasAttribute('data-p86-copy')) return true;
    return tag === 'INPUT' && (el.type === 'email');
  }

  function decorateInput(input) {
    if (!isEligibleInput(input)) return;
    input.dataset.p86CopyDecorated = '1';

    var wrap;
    if (input.parentNode && input.parentNode.classList && input.parentNode.classList.contains('p86-copy-wrap')) {
      wrap = input.parentNode;
    } else {
      wrap = document.createElement('span');
      wrap.className = 'p86-copy-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'p86-copy-btn';
    btn.title = 'Copy to clipboard';
    btn.textContent = '📋';
    btn.tabIndex = -1;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      copy(input.value || '', btn);
    });
    wrap.appendChild(btn);
  }

  function decorateDisplay(el) {
    if (!el || el.dataset.p86CopyDecorated === '1') return;
    el.dataset.p86CopyDecorated = '1';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'p86-copy-btn p86-copy-btn-inline';
    btn.title = 'Copy to clipboard';
    btn.textContent = '📋';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var text = el.dataset.p86CopyValue != null
        ? el.dataset.p86CopyValue
        : (el.textContent || '');
      copy(text, btn);
    });
    if (el.nextSibling) el.parentNode.insertBefore(btn, el.nextSibling);
    else el.parentNode.appendChild(btn);
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    var inputs = root.querySelectorAll(
      'input[type="email"]:not([data-p86-no-copy]):not([data-p86-copy-decorated]),' +
      ' input[data-p86-copy]:not([data-p86-copy-decorated]),' +
      ' textarea[data-p86-copy]:not([data-p86-copy-decorated])'
    );
    for (var i = 0; i < inputs.length; i++) decorateInput(inputs[i]);
    var displays = root.querySelectorAll('[data-p86-copy-display]:not([data-p86-copy-decorated])');
    for (var j = 0; j < displays.length; j++) decorateDisplay(displays[j]);
  }

  function boot() {
    scan(document);
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        for (var j = 0; j < r.addedNodes.length; j++) {
          var n = r.addedNodes[j];
          if (n.nodeType === 1) scan(n);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.p86CopyToClipboard = copy;
  window.p86CopyDecorate = scan;
})();
