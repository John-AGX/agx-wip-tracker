// AGX WIP Tracker — URL Router
//
// Adds pathname-based routing on top of the existing top-level nav
// functions (switchTab / switchJobSubTab / editJob / etc.) without
// rewriting them. Each registered nav function is wrapped so calling
// it normally also pushes a URL onto history. popstate reads the URL
// and replays the matching navigation, suppressing the push so we
// don't trap the user in a loop.
//
// URL grammar:
//   /                                 default landing (login routes here)
//   /wip                              WIP list
//   /wip/jobs/:jobId                  job detail (default sub-tab)
//   /wip/jobs/:jobId/:jobSub          job detail at specific sub-tab
//   /estimates                        estimates landing (current active sub)
//   /estimates/:sub                   sub: list | leads | clients | subs
//   /estimates/leads/:leadId          lead detail view open
//   /estimates/edit/:estId            estimate editor open
//   /schedule
//   /insights
//   /admin
//   /admin/:sub                       sub: users | roles | ai | email | etc.
//
// Server-side: server/index.js already serves index.html for any non-
// API path (the SPA fallback at app.get('*', ...)), so deep-link
// refresh works out of the box.

(function () {
  'use strict';

  // True while popstate or boot is replaying a URL — wrappers check
  // this and skip the pushState so we don't rewrite history while
  // re-entering a route.
  var replaying = false;

  // Sub-tab names we're willing to put in URLs. Anything else is
  // dropped on serialize (the page itself still works, the URL just
  // doesn't capture it). Keeps URLs from leaking ad-hoc sub-tabs the
  // user might add later without touching the router.
  var KNOWN_JOB_SUBS = [
    'job-overview', 'job-costs', 'job-buildings', 'job-wip',
    'job-changeorders', 'job-invoices', 'job-labor', 'job-purchaseorders'
  ];
  var KNOWN_EST_SUBS = ['list', 'leads', 'clients', 'subs'];
  var KNOWN_ADMIN_SUBS = [
    'users', 'roles', 'email', 'templates', 'agents',
    'jobs', 'materials', 'metrics'
  ];
  var KNOWN_TOP_TABS = ['wip', 'estimates', 'schedule', 'insights', 'admin'];

  // ── URL <-> route object ──────────────────────────────────────
  function parsePath(pathname) {
    var parts = (pathname || '/').split('/').filter(Boolean);
    var route = { top: null };
    if (!parts.length) return route;
    var top = parts[0];
    if (KNOWN_TOP_TABS.indexOf(top) === -1) return route;
    route.top = top;
    if (top === 'wip') {
      // /wip/jobs/:id[/:sub]
      if (parts[1] === 'jobs' && parts[2]) {
        route.jobId = parts[2];
        if (parts[3] && KNOWN_JOB_SUBS.indexOf(parts[3]) !== -1) {
          route.jobSub = parts[3];
        }
      }
    } else if (top === 'estimates') {
      // /estimates/edit/:id  OR  /estimates/leads/:id  OR  /estimates/:sub
      if (parts[1] === 'edit' && parts[2]) {
        route.estId = parts[2];
      } else if (parts[1] === 'leads' && parts[2]) {
        route.estSub = 'leads';
        route.leadId = parts[2];
      } else if (parts[1] && KNOWN_EST_SUBS.indexOf(parts[1]) !== -1) {
        route.estSub = parts[1];
      }
    } else if (top === 'admin') {
      if (parts[1] && KNOWN_ADMIN_SUBS.indexOf(parts[1]) !== -1) {
        route.adSub = parts[1];
      }
    }
    return route;
  }

  function serializeRoute(route) {
    if (!route || !route.top) return '/';
    if (route.top === 'wip') {
      if (route.jobId) {
        return '/wip/jobs/' + encodeURIComponent(route.jobId) +
          (route.jobSub ? '/' + route.jobSub : '');
      }
      return '/wip';
    }
    if (route.top === 'estimates') {
      if (route.estId) return '/estimates/edit/' + encodeURIComponent(route.estId);
      if (route.leadId) return '/estimates/leads/' + encodeURIComponent(route.leadId);
      if (route.estSub) return '/estimates/' + route.estSub;
      return '/estimates';
    }
    if (route.top === 'admin') {
      return route.adSub ? '/admin/' + route.adSub : '/admin';
    }
    return '/' + route.top;
  }

  // ── Current URL state from DOM ─────────────────────────────────
  // Mirrors the logic in app.js#captureNavState but reads from the DOM
  // (active classes) so it stays in sync with whatever the nav
  // functions just did.
  function captureRouteFromDOM() {
    var topBtn = document.querySelector('.tab-btn.active');
    var top = topBtn ? topBtn.getAttribute('data-tab') : null;
    if (!top || KNOWN_TOP_TABS.indexOf(top) === -1) return { top: null };
    var route = { top: top };
    if (top === 'wip') {
      var detail = document.getElementById('wip-job-detail-view');
      var jobId = (window.appState && window.appState.currentJobId) || null;
      if (detail && detail.style.display === 'block' && jobId) {
        route.jobId = jobId;
        var subBtn = document.querySelector('.sub-tab-btn-job.active');
        var jobSub = subBtn ? subBtn.getAttribute('data-subtab') : null;
        if (jobSub && KNOWN_JOB_SUBS.indexOf(jobSub) !== -1) route.jobSub = jobSub;
      }
    } else if (top === 'estimates') {
      var subEl = document.querySelector('#estimates [data-estimates-subtab].active');
      var estSub = subEl ? subEl.getAttribute('data-estimates-subtab') : null;
      if (estSub === 'list') {
        var editorView = document.getElementById('estimate-editor-view');
        var editorOpen = editorView && editorView.style.display !== 'none';
        if (editorOpen && window.estimateEditorAPI && typeof window.estimateEditorAPI.getOpenId === 'function') {
          var eid = window.estimateEditorAPI.getOpenId();
          if (eid) { route.estId = eid; return route; }
        }
      }
      if (estSub === 'leads') {
        var leadDetail = document.getElementById('lead-detail-view');
        var leadOpen = leadDetail && leadDetail.style.display !== 'none';
        if (leadOpen && window.agxLeads && typeof window.agxLeads.getOpenId === 'function') {
          var lid = window.agxLeads.getOpenId();
          if (lid) { route.estSub = 'leads'; route.leadId = lid; return route; }
        }
      }
      if (estSub && KNOWN_EST_SUBS.indexOf(estSub) !== -1) route.estSub = estSub;
    } else if (top === 'admin') {
      var adEl = document.querySelector('[data-admin-subtab].active');
      var adSub = adEl ? adEl.getAttribute('data-admin-subtab') : null;
      if (adSub && KNOWN_ADMIN_SUBS.indexOf(adSub) !== -1) route.adSub = adSub;
    }
    return route;
  }

  // ── pushState helper ──────────────────────────────────────────
  // Writes the captured DOM state to the URL bar. Skipped when
  // `replaying` is true (popstate / boot replay — those callers
  // already own the URL).
  function syncUrlFromDOM() {
    if (replaying) return;
    var route = captureRouteFromDOM();
    var newPath = serializeRoute(route);
    var current = location.pathname + location.search;
    if (newPath === current || newPath === location.pathname) return;
    try {
      history.pushState({ route: route }, '', newPath);
    } catch (e) { /* defensive — some envs reject pushState */ }
  }

  // Debounced sync — many nav functions call each other in quick
  // succession (switchTab → switchEstimatesSubTab → editEstimate). We
  // only want one URL push per tick reflecting the final state.
  var syncPending = false;
  function scheduleSync() {
    if (syncPending) return;
    syncPending = true;
    setTimeout(function () {
      syncPending = false;
      syncUrlFromDOM();
    }, 0);
  }

  // ── Wrapping helper ───────────────────────────────────────────
  // Replaces window[name] with a wrapper that calls the original and
  // schedules a URL sync. The original is captured on first wrap so
  // re-wrapping (e.g., proposal.js overrides editEstimate) compounds
  // cleanly.
  function wrapNav(name) {
    var orig = window[name];
    if (typeof orig !== 'function') return false;
    if (orig.__agxRouterWrapped) return true;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      // Skip the push when this call originated from our own replay
      // path — the URL is already correct, and pushing again would
      // double-stack identical entries in history.
      if (!replaying) scheduleSync();
      return r;
    };
    wrapped.__agxRouterWrapped = true;
    wrapped.__agxRouterOrig = orig;
    window[name] = wrapped;
    return true;
  }

  // ── popstate / boot replay ────────────────────────────────────
  // Walk a route object: top-level tab → sub-tab → entity. Each step
  // is suppressed (replaying=true) so wrappers don't push more
  // history while we're consuming the URL.
  function applyRoute(route, opts) {
    if (!route || !route.top) {
      // Empty route — leave whatever auth.js / nav-state already did.
      return;
    }
    var dataReady = !(typeof window.agxDataLoading === 'function' && window.agxDataLoading());
    replaying = true;
    try {
      if (typeof window.switchTab === 'function') {
        var origSwitchTab = window.switchTab.__agxRouterOrig || window.switchTab;
        origSwitchTab(route.top);
      }

      if (route.top === 'estimates' && route.estSub && typeof window.switchEstimatesSubTab === 'function') {
        var origEstSub = window.switchEstimatesSubTab.__agxRouterOrig || window.switchEstimatesSubTab;
        origEstSub(route.estSub);
      }
      if (route.top === 'admin' && route.adSub && typeof window.switchAdminSubTab === 'function') {
        var origAdSub = window.switchAdminSubTab.__agxRouterOrig || window.switchAdminSubTab;
        origAdSub(route.adSub);
      }
    } finally {
      replaying = false;
    }

    // Entity-open steps that depend on data being loaded — defer
    // until agxDataLoading clears, mirroring restoreNavState in app.js.
    function openEntities() {
      replaying = true;
      try {
        if (route.top === 'wip' && route.jobId && typeof window.editJob === 'function') {
          var origEditJob = window.editJob.__agxRouterOrig || window.editJob;
          origEditJob(route.jobId);
          if (route.jobSub && typeof window.switchJobSubTab === 'function') {
            var origJobSub = window.switchJobSubTab.__agxRouterOrig || window.switchJobSubTab;
            origJobSub(route.jobSub);
          }
        } else if (route.top === 'estimates' && route.estId && typeof window.editEstimate === 'function') {
          if (typeof window.switchEstimatesSubTab === 'function') {
            var origEstSub2 = window.switchEstimatesSubTab.__agxRouterOrig || window.switchEstimatesSubTab;
            origEstSub2('list');
          }
          var origEditEst = window.editEstimate.__agxRouterOrig || window.editEstimate;
          origEditEst(route.estId);
        } else if (route.top === 'estimates' && route.estSub === 'leads' && route.leadId &&
                   typeof window.openEditLeadModal === 'function') {
          var origOpenLead = window.openEditLeadModal.__agxRouterOrig || window.openEditLeadModal;
          origOpenLead(route.leadId);
        } else if (route.top === 'estimates' && route.estSub === 'leads' && !route.leadId) {
          // Back-nav from /estimates/leads/:id to /estimates/leads — close
          // the detail view if it's still up so the list shows through.
          var leadDetailEl = document.getElementById('lead-detail-view');
          if (leadDetailEl && leadDetailEl.style.display !== 'none' &&
              typeof window.closeLeadDetail === 'function') {
            var origCloseLead = window.closeLeadDetail.__agxRouterOrig || window.closeLeadDetail;
            origCloseLead();
          }
        }
      } catch (e) {
        console.warn('[router] entity open failed:', e);
      } finally {
        replaying = false;
      }
    }

    if (dataReady) openEntities();
    else {
      var attempts = 0;
      var iv = setInterval(function () {
        var stillLoading = (typeof window.agxDataLoading === 'function') && window.agxDataLoading();
        if (!stillLoading || ++attempts > 30) {
          clearInterval(iv);
          openEntities();
        }
      }, 200);
    }
  }

  function onPopState(e) {
    var route = (e.state && e.state.route) ? e.state.route : parsePath(location.pathname);
    applyRoute(route);
  }

  // ── Boot ──────────────────────────────────────────────────────
  // Wraps every nav function we care about, parses the current URL,
  // and either replays it (deep-link) or lets auth.js's existing
  // restore path land the user (bare `/`).
  function boot() {
    [
      'switchTab',
      'switchJobSubTab',
      'switchEstimatesSubTab',
      'switchAdminSubTab',
      'editJob',
      'editEstimate',
      'openEditLeadModal',
      'closeLeadDetail'
    ].forEach(wrapNav);

    window.addEventListener('popstate', onPopState);

    // Public hooks so other modules can opt in / inspect.
    window.agxRouter = {
      sync: scheduleSync,
      route: function () { return parsePath(location.pathname); },
      navigate: function (route) {
        var path = serializeRoute(route);
        try { history.pushState({ route: route }, '', path); } catch (e) { /* noop */ }
        applyRoute(route);
      }
    };

    // Boot-time replay — only if the URL points at something specific.
    // Bare `/` → leave it for auth.js + nav-state to handle so users
    // who haven't migrated yet don't lose their last-place.
    var initial = parsePath(location.pathname);
    if (initial.top) {
      // Wait for the rest of init to settle (auth.js resolves on
      // DOMContentLoaded too) before replaying — without this,
      // switchTab would run against a still-hidden app shell.
      setTimeout(function () { applyRoute(initial); }, 200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
