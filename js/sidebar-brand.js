// Org brand lockup at the top of the app sidebar — the org's logo (chosen
// per light/dark theme) + org name. Data comes from GET /api/org/branding
// (cached). The logo swaps live when the user toggles the theme. Falls back
// to the Primary logo, then to a text-only wordmark if no logo is set.
//
// Exposes:
//   window.p86OrgLogo()      → the logo URL for the current theme ('' if none)
//   window.p86OrgBrand()     → the cached { name, branding } object
//   window.p86RefreshOrgBrand() → re-fetch + re-render (admin calls after save)
(function () {
  'use strict';

  var _brand = null; // { name, branding }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Which library logo shows for the active theme. Light mode prefers
  // logo_light_url, dark prefers logo_dark_url; both fall back to the Primary
  // (logo_url), then the first library logo.
  function pickLogo(b) {
    if (!b) return '';
    var isLight = document.body.classList.contains('light-mode');
    var pick = isLight ? (b.logo_light_url || b.logo_url) : (b.logo_dark_url || b.logo_url);
    if (!pick && Array.isArray(b.logos) && b.logos.length) pick = b.logos[0].url;
    return pick || '';
  }

  window.p86OrgLogo = function () { return _brand ? pickLogo(_brand.branding) : ''; };
  window.p86OrgBrand = function () { return _brand; };

  function ensureEl() {
    var sb = document.getElementById('app-sidebar');
    if (!sb) return null;
    var el = document.getElementById('app-sidebar-brand');
    if (!el) {
      el = document.createElement('a');
      el.id = 'app-sidebar-brand';
      el.className = 'app-sidebar-brand';
      el.setAttribute('role', 'button');
      el.title = 'Home';
      el.style.display = 'none'; // hidden until we have something to show
      el.addEventListener('click', function () {
        if (typeof window.switchTab === 'function') window.switchTab('summary');
      });
      sb.insertBefore(el, sb.firstChild);
    }
    return el;
  }

  function render() {
    var el = ensureEl();
    if (!el || !_brand) return;
    var b = _brand.branding || {};
    var name = _brand.name || '';
    var logo = pickLogo(b);
    if (!logo && !name) { el.style.display = 'none'; return; }
    // Company name is opt-in when a logo exists (branding.sidebar_show_name,
    // for icon-only logos that need the wordmark); with NO logo it always
    // shows so the sidebar isn't headless.
    var showName = !!name && (!logo || b.sidebar_show_name === true);
    var html = '';
    if (logo) html += '<img class="app-sidebar-brand-logo" src="' + escHtml(logo) + '" alt="" />';
    if (showName) html += '<span class="app-sidebar-brand-name">' + escHtml(name) + '</span>';
    el.innerHTML = html;
    el.style.display = '';
  }

  function load() {
    if (!(window.p86Api && window.p86Api.org && window.p86Api.org.branding)) return;
    window.p86Api.org.branding().then(function (r) {
      _brand = r || null;
      render();
    }).catch(function () { /* leave the brand absent on failure (e.g. not authed yet) */ });
  }

  // Theme toggle only changes which logo image to show — no refetch needed.
  document.addEventListener('p86-theme-change', render);
  window.p86RefreshOrgBrand = load;

  function init() { ensureEl(); load(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
