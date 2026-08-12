// ── Global "Save address?" suppressor ──────────────────────────────────
// Chrome (and Edge) classify any street/city/state/zip field group as an
// address form: it autofills the user's saved profile into them, then pops a
// "Save address?" prompt whenever the form appears. That's noise on our lead /
// job / estimate / client editors (John, 2026-08-10). This stamps
// autocomplete="off" + the 1Password / LastPass opt-outs on every address-ish
// text input — on load and as new ones mount — so the browser leaves them
// alone. Scoped to ADDRESS fields ONLY (street/city/state/zip/postal/country),
// so email / name / phone autofill, which users often WANT, is untouched.
(function () {
  'use strict';

  // Address tokens on a normalized id/name/placeholder (camelCase is split to
  // '_' first, so jobState → job_state, so both naming styles are caught).
  var ADDR_RE = /(^|_)(street|address|addr|city|town|state|province|region|zip|zipcode|postal|postcode|country)(_|$)/;
  // A field that already declares a standard address autocomplete token.
  var AC_RE = /street-address|address-line|postal-code|address-level|country-name/i;

  function isAddrInput(el) {
    var t = (el.type || 'text').toLowerCase();
    if (t && t !== 'text' && t !== 'search') return false;   // only text-ish inputs
    if (AC_RE.test(el.getAttribute('autocomplete') || '')) return true;
    var raw = (el.id || '') + '_' + (el.name || '') + '_' + (el.getAttribute('placeholder') || '');
    var norm = raw.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    return ADDR_RE.test(norm);
  }

  function suppress(root) {
    try {
      // data-p86-noaf marks an input as already examined (address or not) so
      // repeat sweeps only touch newly-mounted fields.
      var list = (root || document).querySelectorAll('input:not([data-p86-noaf])');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        el.setAttribute('data-p86-noaf', '1');
        if (!isAddrInput(el)) continue;
        el.setAttribute('autocomplete', 'off');
        el.setAttribute('data-1p-ignore', '');
        el.setAttribute('data-lpignore', 'true');
      }
    } catch (e) { /* never let this break a page */ }
  }

  var pending = null;
  function schedule() { if (pending) return; pending = setTimeout(function () { pending = null; suppress(document); }, 120); }

  function boot() {
    suppress(document);
    try {
      // New editors mount dynamically — re-sweep (debounced) when nodes are added.
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].addedNodes && muts[i].addedNodes.length) { schedule(); return; }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* MutationObserver always present in target browsers */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Exposed so a surface can force an immediate sweep right after it renders a
  // form (no 120ms debounce window) — e.g. the lead editor already does this.
  window.p86SuppressAddressAutofill = suppress;
})();
