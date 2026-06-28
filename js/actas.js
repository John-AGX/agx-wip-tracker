(function () {
  'use strict';

  // Act-as / "disguise" mode — persistent "Acting as NAME — Exit" banner +
  // window.p86ActAs(userId). Self-contained: re-fetches /api/auth/me itself
  // (cookie auth, with a Bearer fallback) so it works on every page/view
  // regardless of script load order. Renders nothing unless the server returns
  // acting_as, so it is safe even before/without the backend in place.
  //
  // Backend contract: GET /api/auth/me returns { ..., acting_as: { id, name,
  // email } | null }; POST /api/auth/act-as { user_id }; POST /api/auth/act-as/
  // exit. Only a system admin can start act-as (server-enforced).

  var BANNER_ID = 'p86-actas-banner';

  function authHeaders() {
    var h = { 'Content-Type': 'application/json' };
    try {
      var tok = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken())
        || localStorage.getItem('p86-auth-token');
      if (tok) h['Authorization'] = 'Bearer ' + tok;
    } catch (_) {}
    return h;
  }

  function removeBanner() {
    var el = document.getElementById(BANNER_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    try { document.body.style.removeProperty('padding-top'); } catch (_) {}
  }

  function renderBanner(name) {
    removeBanner();
    var bar = document.createElement('div');
    bar.id = BANNER_ID;
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483600',
      'background:#b45309', 'color:#fff',
      'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'padding:8px 14px', 'display:flex', 'align-items:center',
      'justify-content:center', 'gap:14px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.35)', 'letter-spacing:0.2px'
    ].join(';') + ';';

    var label = document.createElement('span');
    label.innerHTML = '🎭 Acting as ';
    var strong = document.createElement('strong');
    strong.textContent = name || 'user';
    label.appendChild(strong);
    label.appendChild(document.createTextNode(' — your messages, tasks, events & reports will be attributed to them.'));
    bar.appendChild(label);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Exit';
    btn.style.cssText = [
      'background:#fff', 'color:#b45309', 'border:0', 'border-radius:5px',
      'padding:3px 12px', 'font:600 12px/1 inherit', 'cursor:pointer', 'flex:0 0 auto'
    ].join(';') + ';';
    btn.addEventListener('click', exitActAs);
    bar.appendChild(btn);

    document.body.appendChild(bar);
    // Push the page down so the fixed bar doesn't sit over the top chrome.
    try { document.body.style.paddingTop = bar.offsetHeight + 'px'; } catch (_) {}
  }

  function exitActAs() {
    fetch('/api/auth/act-as/exit', {
      method: 'POST', headers: authHeaders(), credentials: 'include'
    }).then(function () {
      window.location.reload();
    }).catch(function () { window.location.reload(); });
  }

  // Public: start acting as another user, then reload so the whole app
  // re-reads /api/auth/me (and re-signs the cookie) under the disguise.
  window.p86ActAs = function (userId) {
    if (userId == null) return;
    fetch('/api/auth/act-as', {
      method: 'POST', headers: authHeaders(), credentials: 'include',
      body: JSON.stringify({ user_id: userId })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || 'Act-as failed'); });
    }).then(function () {
      window.location.reload();
    }).catch(function (e) {
      try { alert((e && e.message) || 'Could not act as that user.'); } catch (_) {}
    });
  };

  function checkAndRender() {
    fetch('/api/auth/me', { headers: authHeaders(), credentials: 'include' })
      .then(function (r) { if (!r.ok) throw new Error('no session'); return r.json(); })
      .then(function (data) {
        var act = data && (data.acting_as || (data.user && data.user.acting_as));
        if (act) { renderBanner(act.name || act.email || 'user'); }
        else { removeBanner(); }
      })
      .catch(function () { /* not logged in / offline — no banner */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAndRender);
  } else {
    checkAndRender();
  }
})();
