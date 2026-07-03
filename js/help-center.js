// Help center — window.p86HelpCenter (+ window.openHelpOverlay).
//
// The immersive Help & What's New surface (avatar dropdown → Help &
// What's New). Replaces the old single-scroll overlay in app.js with
// three tabs over the org manifest:
//
//   What's New — versioned patch notes (releases[] from
//                server/feature-catalog.js) as a timeline. Rows with a
//                `tour` id get a "Show me" button → p86Guide.
//   Guides     — every guided tour as a start card, plus an "ask the
//                assistant" handoff for anything the guides don't cover.
//   Features   — the searchable feature atlas (label + blurb + where to
//                find it), with per-row "Ask the assistant" handoff.
//
// Also owns the What's New badge: a count pill on #help-btn for
// releases newer than the last time the user opened this overlay
// (localStorage p86-whatsnew-last-ack — same key the old overlay used,
// so nobody gets a false "9 new" on upgrade... they get it once, which
// is correct: they haven't seen these notes).
//
// Data comes from window.p86FetchManifest (app.js, 60s cache) with a
// direct /api/org/manifest fallback so this file works standalone.

(function () {
  'use strict';

  var ACK_KEY = 'p86-whatsnew-last-ack';
  var _tab = 'new';       // 'new' | 'guides' | 'features'
  var _manifest = null;
  var _query = '';
  var _closeActive = null; // teardown fn of the currently-open overlay

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name) { return window.p86Icon ? window.p86Icon(name) : ''; }

  function fetchManifest() {
    if (typeof window.p86FetchManifest === 'function') return window.p86FetchManifest();
    var token = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) || null;
    return fetch('/api/org/manifest', {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      credentials: 'same-origin'
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function getAck() {
    try { return localStorage.getItem(ACK_KEY) || null; } catch (e) { return null; }
  }

  // A release date is 'YYYY-MM-DD' (no time). Treat it as END of that
  // LOCAL day when comparing against the full-precision ack timestamp —
  // otherwise a bare date parses as UTC midnight and a release cut later
  // the same day as the user's last visit would never show as new.
  function relTime(r) {
    var t = new Date((r && r.date || '') + 'T23:59:59').getTime();
    return isFinite(t) ? t : 0;
  }

  function releasesSince(m, ackIso) {
    var rels = (m && m.releases) || [];
    if (!ackIso) return rels.length;
    var ack = new Date(ackIso).getTime();
    return rels.filter(function (r) { return relTime(r) > ack; }).length;
  }

  function fmtDate(iso) {
    try {
      var d = new Date(iso + 'T12:00:00');
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return iso; }
  }

  // ── What's New badge (count pill on the avatar-menu item) ──────
  function updateBadge(count) {
    var btn = document.getElementById('help-btn');
    if (!btn) return;
    var badge = btn.querySelector('.p86-hc-menubadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'p86-hc-menubadge';
      btn.appendChild(badge);
    }
    if (count > 0) { badge.textContent = count + ' new'; badge.style.display = ''; }
    else badge.style.display = 'none';
  }

  function refreshBadge() {
    fetchManifest().then(function (m) {
      if (m) updateBadge(releasesSince(m, getAck()));
    });
  }

  // ── Rendering ──────────────────────────────────────────────────
  var TYPE_META = {
    'new':      { label: 'NEW',      color: '#34d399' },
    'improved': { label: 'IMPROVED', color: '#60a5fa' },
    'fixed':    { label: 'FIXED',    color: '#fbbf24' }
  };

  function matches(q, parts) {
    if (!q) return true;
    var hay = parts.join(' ').toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) > -1; });
  }

  function showMeBtn(tourId) {
    if (!tourId || !window.p86Guide || !window.p86Guide.has(tourId)) return '';
    return '<button type="button" class="p86-hc-showme" data-tour="' + esc(tourId) + '">' +
      icon('map-pin') + ' Show me</button>';
  }

  function renderWhatsNew(m, prevAck) {
    var rels = m.releases || [];
    var ackT = prevAck ? new Date(prevAck).getTime() : 0;
    var q = _query.toLowerCase().trim();
    var newCount = prevAck ? rels.filter(function (r) { return relTime(r) > ackT; }).length : 0;
    var html = '';
    if (newCount > 0 && !q) {
      html += '<div class="p86-hc-sincebar">' + icon('bell') + ' ' + newCount +
        (newCount === 1 ? ' release' : ' releases') + ' since your last visit</div>';
    }
    var shown = 0;
    rels.forEach(function (r, i) {
      var changes = (r.changes || []).filter(function (c) {
        return matches(q, [c.text, c.type, r.version, r.name || '']);
      });
      if (q && !changes.length && !matches(q, [r.version, r.name || '', r.summary || ''])) return;
      if (!q) changes = r.changes || [];
      shown++;
      var isNew = ackT && relTime(r) > ackT;
      var open = q ? true : (i === 0 || isNew);
      html +=
        '<div class="p86-hc-release' + (open ? ' open' : '') + '">' +
          '<button type="button" class="p86-hc-relhead">' +
            '<span class="p86-hc-verchip">v' + esc(r.version) + '</span>' +
            '<span class="p86-hc-relname">' + esc(r.name || '') + '</span>' +
            (isNew ? '<span class="p86-hc-newdot">NEW</span>' : '') +
            '<span class="p86-hc-reldate">' + esc(fmtDate(r.date)) + '</span>' +
            '<span class="p86-hc-relcaret">&#9662;</span>' +
          '</button>' +
          '<div class="p86-hc-relbody">' +
            (r.summary ? '<div class="p86-hc-relsummary">' + esc(r.summary) + '</div>' : '') +
            changes.map(function (c) {
              var meta = Object.prototype.hasOwnProperty.call(TYPE_META, c.type) ? TYPE_META[c.type] : TYPE_META['new'];
              return '<div class="p86-hc-change">' +
                '<span class="p86-hc-typechip" style="color:' + meta.color + ';border-color:' + meta.color + '44;background:' + meta.color + '14">' + meta.label + '</span>' +
                '<span class="p86-hc-changetext">' + esc(c.text) + '</span>' +
                showMeBtn(c.tour) +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>';
    });
    if (!shown) html += '<div class="p86-hc-empty">Nothing matches "' + esc(_query) + '".</div>';
    return html;
  }

  function renderGuides() {
    var tours = (window.p86Guide && window.p86Guide.list()) || [];
    var q = _query.toLowerCase().trim();
    var cards = tours.filter(function (t) { return matches(q, [t.title, t.blurb]); }).map(function (t) {
      return '<div class="p86-hc-guide">' +
        '<div class="p86-hc-guide-ico">' + icon(t.icon) + '</div>' +
        '<div class="p86-hc-guide-main">' +
          '<div class="p86-hc-guide-title">' + esc(t.title) + '</div>' +
          '<div class="p86-hc-guide-blurb">' + esc(t.blurb) + '</div>' +
        '</div>' +
        '<button type="button" class="p86-hc-guide-start" data-tour="' + esc(t.id) + '">Start · ' + t.steps + ' steps</button>' +
      '</div>';
    }).join('');
    var askCard =
      '<div class="p86-hc-ask">' +
        '<div class="p86-hc-ask-title">' + icon('dna-86') + ' Can\'t find it? Ask the crew.</div>' +
        '<div class="p86-hc-ask-blurb">Your assistant knows every feature on this page — and your actual data. Ask "how do I…" anything.</div>' +
        '<button type="button" class="p86-hc-ask-btn" data-ask="How do I ">Ask the assistant</button>' +
      '</div>';
    return askCard + (cards || '<div class="p86-hc-empty">No guides match "' + esc(_query) + '".</div>');
  }

  function renderFeatures(m) {
    var features = m.features || [];
    var q = _query.toLowerCase().trim();
    var areas = {};
    features.forEach(function (f) {
      if (!matches(q, [f.label, f.blurb, f.area || '', f.access_path || ''])) return;
      var a = f.area || 'Other';
      (areas[a] = areas[a] || []).push(f);
    });
    var order = ['AI', 'Jobs', 'Estimating', 'Schedule', 'Photos', 'Reports', 'Org', 'Mobile', 'Other'];
    var html = order.filter(function (a) { return areas[a]; }).map(function (a) {
      return '<div class="p86-hc-area">' +
        '<div class="p86-hc-area-label">' + esc(a) + '</div>' +
        areas[a].map(function (f) {
          return '<div class="p86-hc-feat">' +
            '<div class="p86-hc-feat-main">' +
              '<div class="p86-hc-feat-label">' + esc(f.label) + '</div>' +
              '<div class="p86-hc-feat-blurb">' + esc(f.blurb) + '</div>' +
              '<div class="p86-hc-feat-path">' + icon('map-pin') + ' ' + esc(f.access_path || '') + '</div>' +
            '</div>' +
            '<button type="button" class="p86-hc-feat-ask" data-ask="How do I use &quot;' + esc(f.label) + '&quot;? Walk me through it." title="Ask the assistant about this">' + icon('dna-86') + '</button>' +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');
    return html || '<div class="p86-hc-empty">No features match "' + esc(_query) + '".</div>';
  }

  function renderBody(card, prevAck) {
    var body = card.querySelector('.p86-hc-body');
    if (!body || !_manifest) return;
    if (_tab === 'new') body.innerHTML = renderWhatsNew(_manifest, prevAck);
    else if (_tab === 'guides') body.innerHTML = renderGuides();
    else body.innerHTML = renderFeatures(_manifest);
    card.querySelectorAll('.p86-hc-tabbtn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-hc-tab') === _tab);
    });
  }

  // ── Overlay ────────────────────────────────────────────────────
  function open(opts) {
    opts = opts || {};
    if (opts.tab) _tab = opts.tab;
    // Tear the previous overlay down through its own close() so its
    // document-level Esc listener doesn't leak.
    if (typeof _closeActive === 'function') _closeActive();

    // Remember the PREVIOUS ack (drives "since your last visit"
    // highlights), then ack now so the badge clears.
    var prevAck = getAck();
    try { localStorage.setItem(ACK_KEY, new Date().toISOString()); } catch (e) {}
    updateBadge(0);
    _query = '';

    var overlay = document.createElement('div');
    overlay.id = 'p86-help-overlay';
    overlay.className = 'p86-help-overlay';
    overlay.innerHTML =
      '<div class="p86-help-card p86-hc" role="dialog" aria-labelledby="p86-help-title">' +
        '<div class="p86-hc-head">' +
          '<div class="p86-hc-head-titles">' +
            '<div id="p86-help-title" class="p86-hc-title">Help &amp; What\'s New</div>' +
            '<div class="p86-hc-version">loading&hellip;</div>' +
          '</div>' +
          '<div class="p86-hc-head-tools">' +
            '<input type="search" class="p86-hc-search" placeholder="Search updates, guides, features&hellip;" aria-label="Search help">' +
            '<button type="button" class="p86-help-close p86-hc-close" aria-label="Close">&times;</button>' +
          '</div>' +
        '</div>' +
        '<div class="p86-hc-tabs">' +
          '<button type="button" class="p86-hc-tabbtn active" data-hc-tab="new">What\'s New</button>' +
          '<button type="button" class="p86-hc-tabbtn" data-hc-tab="guides">Guides</button>' +
          '<button type="button" class="p86-hc-tabbtn" data-hc-tab="features">Features</button>' +
        '</div>' +
        '<div class="p86-hc-body"><div class="p86-help-loading">Loading&hellip;</div></div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    var card = overlay.querySelector('.p86-hc');

    function close() {
      overlay.remove();
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onEsc);
      if (_closeActive === close) _closeActive = null;
    }
    _closeActive = close;
    function onEsc(e) { if (e.key === 'Escape') close(); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.p86-hc-close').addEventListener('click', close);
    document.addEventListener('keydown', onEsc);

    // One delegated handler: tab switches, tour launches, assistant asks,
    // release collapse toggles.
    card.addEventListener('click', function (e) {
      var t = e.target;
      var tabBtn = t.closest ? t.closest('.p86-hc-tabbtn') : null;
      if (tabBtn) { _tab = tabBtn.getAttribute('data-hc-tab'); renderBody(card, prevAck); return; }
      var tourBtn = t.closest ? t.closest('[data-tour]') : null;
      if (tourBtn && window.p86Guide) { close(); window.p86Guide.start(tourBtn.getAttribute('data-tour')); return; }
      var askBtn = t.closest ? t.closest('[data-ask]') : null;
      if (askBtn) {
        var prompt = askBtn.getAttribute('data-ask') || '';
        close();
        if (window.p86AI && typeof window.p86AI.open === 'function') {
          window.p86AI.open({ entityType: 'ask86' });
          setTimeout(function () {
            var input = document.getElementById('ai-input');
            if (input) {
              input.value = prompt;
              input.dispatchEvent(new Event('input'));
              input.focus();
              try { input.setSelectionRange(input.value.length, input.value.length); } catch (err) {}
            }
          }, 300);
        }
        return;
      }
      var relHead = t.closest ? t.closest('.p86-hc-relhead') : null;
      if (relHead) { relHead.parentNode.classList.toggle('open'); return; }
    });

    var search = card.querySelector('.p86-hc-search');
    var debounce = null;
    search.addEventListener('input', function () {
      clearTimeout(debounce);
      var v = this.value;
      debounce = setTimeout(function () { _query = v; renderBody(card, prevAck); }, 140);
    });

    fetchManifest().then(function (m) {
      if (!document.getElementById('p86-help-overlay')) return; // closed while loading
      if (!m) {
        card.querySelector('.p86-hc-body').innerHTML =
          '<div class="p86-help-loading p86-help-error">Could not load help content. Try again later.</div>';
        return;
      }
      _manifest = m;
      var ver = card.querySelector('.p86-hc-version');
      ver.textContent = 'Project 86 v' + (m.app_version || '—') + (m.build ? ' · build ' + m.build : '');
      renderBody(card, prevAck);
    });
  }

  window.p86HelpCenter = { open: open, refreshBadge: refreshBadge };
  // The avatar-menu item calls window.openHelpOverlay() — keep that name.
  window.openHelpOverlay = open;

  // Paint the What's New badge shortly after boot (auth + manifest
  // need a beat; fetchManifest caches so this costs one request that
  // the Summary page reuses anyway).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(refreshBadge, 2500); });
  } else {
    setTimeout(refreshBadge, 2500);
  }
})();
