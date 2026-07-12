// Project 86 — URL Router
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
//   /summary                          Summary landing page
//   /files                            personal Files tab (per-user folder)
//   /jobs                             Jobs list (formerly /wip)
//   /jobs/archived                    archived jobs view
//   /jobs/:jobId                      job detail (default sub-tab)
//   /jobs/:jobId/:jobSub              job detail at specific sub-tab
//   (Backcompat: /wip[/jobs/:id...] still parses to the Jobs section
//    so older shared links don't 404. New links serialize as /jobs.)
//   /estimates                        estimates landing (current active sub)
//   /estimates/:sub                   sub: list | leads
//   /estimates/leads/:leadId          lead detail view open
//   /estimates/edit/:estId            estimate editor open
//   /clients                          clients directory (renders inside Estimates pane)
//   /clients/:clientId                client DOSSIER open (read-only view;
//                                     the edit modal is transient and never
//                                     serialized — a relaunch/session-restore
//                                     must not reopen an edit form)
//   /subs                             subs/vendors directory
//   /subs/:subId                      legacy — replays to the subs directory
//                                     (the sub editor is transient and not
//                                     URL-addressable; no read-only sub view
//                                     exists yet to deep-link into)
//   /schedule
//   /insights
//   /admin
//   /admin/:sub                       sub: users | roles | ai | email | etc.
//   /admin/agents/conversations/:key  agent conversation detail
//   /admin/agents/evals/:evalId       eval fixture detail
//   /admin/agents/evals/new           new eval fixture form
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
    'job-overview', 'job-buildings', 'job-wip-report',
    'job-changeorders', 'job-invoices', 'job-labor', 'job-purchaseorders',
    'job-payapps', 'job-subs', 'job-reports', 'job-qb-costs', 'job-details', 'job-estimates',
    // Site Map — the node-graph structural-editing overlay, now a dedicated tab.
    'job-site-map',
    // Workflow (RFIs / Submittals / Transmittals) — jobs-hub row clicks
    // navigate with jobSub:'job-workflow', so the URL must round-trip.
    'job-workflow'
  ];
  // Legacy sub-tab id → new id. Old shared links / bookmarks using
  // /jobs/:id/job-wip transparently route to job-wip-report (the new
  // name for the WIP Report sub-tab inside a job).
  var LEGACY_JOB_SUB_REMAP = { 'job-wip': 'job-wip-report' };
  var KNOWN_EST_SUBS = ['list', 'leads', 'clients', 'subs', 'users'];
  // Canonical admin sub-tabs (per switchAdminSubTab in admin.js):
  //   users, roles, organization, agents, context, metrics, system.
  // The trailing legacy aliases (email / templates / jobs / materials /
  // sms) are kept so old deep links still parse — switchAdminSubTab's
  // ORG_REDIRECTS folds them into the Organization tab on replay.
  var KNOWN_ADMIN_SUBS = [
    'users', 'roles', 'organization', 'agents', 'context', 'metrics', 'system',
    'email', 'templates', 'jobs', 'materials', 'sms'
  ];
  // 'my-files' is the internal tab id (matches the pane element id and
  // TAB_TITLES key); the URL slug for it is '/files' — friendlier and
  // matches the header icon's purpose. parsePath/serializeRoute do the
  // translation.
  var KNOWN_TOP_TABS = ['summary', 'my-files', 'field-tools', 'jobs', 'jobshub', 'estimates', 'schedule', 'plans', 'insights', 'admin', 'projects', 'orgmap', 'orgleadsmap', 'console', 'cost-inbox', 'invoices', 'my-day', 'my-tasks', 'messages'];

  // ── URL <-> route object ──────────────────────────────────────
  function parsePath(pathname) {
    var parts = (pathname || '/').split('/').filter(Boolean);
    var route = { top: null };
    if (!parts.length) return route;
    var top = parts[0];
    // URL slug '/files' maps to internal tab id 'my-files'.
    if (top === 'files') top = 'my-files';
    // Backcompat: old /wip[/...] URLs route to the new Jobs section.
    // Old shared links and bookmarks keep working; serializeRoute emits
    // /jobs going forward.
    if (top === 'wip') top = 'jobs';
    // Pseudo-top-level: /clients[/:id] and /subs[/:id] route into the
    // Estimates tab UI with the matching sub-tab open. The sub-tabs
    // still live under #estimates internally — these URLs are an alias
    // so callers see clients and subs as first-class destinations
    // without a /estimates/ prefix.
    if (top === 'clients') {
      route.top = 'estimates'; route.estSub = 'clients';
      if (parts[1]) route.clientId = parts[1];
      return route;
    }
    if (top === 'subs') {
      route.top = 'estimates'; route.estSub = 'subs';
      if (parts[1]) route.subId = parts[1];
      return route;
    }
    // /leads[/:id] — same pseudo-top-level treatment (IA-C). Leads reads
    // as a first-class destination in the URL bar even though its UI
    // still lives under #estimates. Old /estimates/leads/:id links keep
    // parsing below; serializeRoute emits /leads going forward.
    if (top === 'leads') {
      route.top = 'estimates'; route.estSub = 'leads';
      if (parts[1]) route.leadId = parts[1];
      return route;
    }
    if (KNOWN_TOP_TABS.indexOf(top) === -1) return route;
    route.top = top;
    if (top === 'jobs') {
      // New shape: /jobs/:id[/:sub]
      // Legacy:    /wip/jobs/:id[/:sub]   (parts[0]='wip' was remapped to 'jobs' above,
      //                                    but the path segments still read 'jobs' at index 1)
      //            /jobs/archived  OR  /wip/archived
      var jobsIdIdx, jobsSubIdx;
      if (parts[1] === 'jobs' && parts[2]) {
        // legacy /wip/jobs/:id[/:sub] form
        jobsIdIdx = 2; jobsSubIdx = 3;
      } else if (parts[1] === 'archived') {
        route.archived = true;
        jobsIdIdx = null; jobsSubIdx = null;
      } else if (parts[1]) {
        // new /jobs/:id[/:sub] form
        jobsIdIdx = 1; jobsSubIdx = 2;
      }
      if (jobsIdIdx != null && parts[jobsIdIdx]) {
        route.jobId = parts[jobsIdIdx];
        var sub = parts[jobsSubIdx];
        if (sub) {
          // Apply legacy sub-tab remap before allow-list check.
          if (LEGACY_JOB_SUB_REMAP[sub]) sub = LEGACY_JOB_SUB_REMAP[sub];
          if (KNOWN_JOB_SUBS.indexOf(sub) !== -1) route.jobSub = sub;
        }
      }
    } else if (top === 'estimates') {
      // /estimates/edit/:id  OR  /estimates/leads/:id  OR  /estimates/:sub
      // Note: clients and subs paths are handled above as pseudo-top-level
      // routes (/clients[/:id], /subs[/:id]); they do NOT live under
      // /estimates/ in the URL even though their UI does.
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
        // /admin/agents/conversations/:key
        // /admin/agents/evals/:id  OR  /admin/agents/evals/new
        if (parts[1] === 'agents') {
          if (parts[2] === 'conversations' && parts[3]) {
            // The conversation key is `entity_type|entity_id|user_id`,
            // URL-encoded in the path (`staff%7Cglobal%7C2`). Decode
            // here so downstream code sees `staff|global|2`. Without
            // this, encodeURIComponent on the API call double-encodes
            // and the server's split('|') sees one long string and
            // 400s with "Bad key — expected entity_type|entity_id|user_id".
            try { route.adAgentConvKey = decodeURIComponent(parts[3]); }
            catch (e) { route.adAgentConvKey = parts[3]; }
          } else if (parts[2] === 'evals' && parts[3]) {
            if (parts[3] === 'new') route.adAgentEvalNew = true;
            else {
              try { route.adAgentEvalId = decodeURIComponent(parts[3]); }
              catch (e) { route.adAgentEvalId = parts[3]; }
            }
          }
        }
      }
    }
    return route;
  }

  function serializeRoute(route) {
    if (!route || !route.top) return '/';
    if (route.top === 'jobs') {
      if (route.jobId) {
        return '/jobs/' + encodeURIComponent(route.jobId) +
          (route.jobSub ? '/' + route.jobSub : '');
      }
      if (route.archived) return '/jobs/archived';
      return '/jobs';
    }
    if (route.top === 'estimates') {
      // Clients and subs surface as their own root paths even though
      // the UI lives under #estimates — keeps URLs aligned with how
      // users think about these entities.
      if (route.estSub === 'clients') {
        return route.clientId
          ? '/clients/' + encodeURIComponent(route.clientId)
          : '/clients';
      }
      if (route.estSub === 'subs') {
        return route.subId
          ? '/subs/' + encodeURIComponent(route.subId)
          : '/subs';
      }
      // Leads surfaces at /leads[/:id] (IA-C) — first-class URL like
      // clients/subs above. parsePath still accepts the legacy
      // /estimates/leads/:id shape for old bookmarks.
      if (route.leadId) return '/leads/' + encodeURIComponent(route.leadId);
      if (route.estSub === 'leads') return '/leads';
      if (route.estId) return '/estimates/edit/' + encodeURIComponent(route.estId);
      if (route.estSub) return '/estimates/' + route.estSub;
      return '/estimates';
    }
    if (route.top === 'my-files') return '/files';
    if (route.top === 'admin') {
      if (route.adSub === 'agents') {
        if (route.adAgentConvKey) return '/admin/agents/conversations/' + encodeURIComponent(route.adAgentConvKey);
        if (route.adAgentEvalNew) return '/admin/agents/evals/new';
        if (route.adAgentEvalId)  return '/admin/agents/evals/' + encodeURIComponent(route.adAgentEvalId);
      }
      return route.adSub ? '/admin/' + route.adSub : '/admin';
    }
    return '/' + route.top;
  }

  // ── Current URL state from DOM ─────────────────────────────────
  // Mirrors the logic in app.js#captureNavState but reads from the DOM
  // (active classes) so it stays in sync with whatever the nav
  // functions just did.
  function captureRouteFromDOM() {
    // Primary signal: which tab-btn is active. Summary + My Files have
    // no top-level .tab-btn (they're reached via the 86 logo + the
    // header folder icon respectively), so fall back to the active
    // .tab-content pane id when no tab-btn is highlighted.
    var topBtn = document.querySelector('.tab-btn.active');
    var top = topBtn ? topBtn.getAttribute('data-tab') : null;
    if (!top) {
      var activePane = document.querySelector('.tab-content.active');
      if (activePane && activePane.id) top = activePane.id;
    }
    if (!top || KNOWN_TOP_TABS.indexOf(top) === -1) return { top: null };
    var route = { top: top };
    if (top === 'jobs') {
      var detail = document.getElementById('jobs-job-detail-view');
      var jobId = (window.appState && window.appState.currentJobId) || null;
      if (detail && detail.style.display === 'block' && jobId) {
        route.jobId = jobId;
        // Job-sub detection follows the CURRENT nav model (the map overlay
        // + the .ws-right-tab strip), not the retired .sub-tab-btn-job
        // buttons. Precedence: (1) Site Map overlay active → job-site-map;
        // (2) the active right-tab's data-panel; (3) legacy sub-btn.
        var jobSub = null;
        var ngTab = document.getElementById('nodeGraphTab');
        if (ngTab && ngTab.classList.contains('active')) {
          jobSub = 'job-site-map';
        } else {
          var rTab = document.querySelector('.ws-right-tab.active');
          jobSub = rTab ? rTab.getAttribute('data-panel') : null;
          if (!jobSub) {
            var subBtn = document.querySelector('.sub-tab-btn-job.active');
            jobSub = subBtn ? subBtn.getAttribute('data-subtab') : null;
          }
        }
        if (jobSub && KNOWN_JOB_SUBS.indexOf(jobSub) !== -1) route.jobSub = jobSub;
      } else {
        var archiveView = document.getElementById('archived-jobs-list');
        if (archiveView && archiveView.style.display !== 'none') {
          route.archived = true;
        }
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
        if (leadOpen && window.p86Leads && typeof window.p86Leads.getOpenId === 'function') {
          var lid = window.p86Leads.getOpenId();
          if (lid) { route.estSub = 'leads'; route.leadId = lid; return route; }
        }
      }
      if (estSub === 'clients') {
        // Client DOSSIER (read-only) is the deep-linkable state. The edit
        // modal is intentionally NOT captured: serializing it meant a
        // Chrome/PWA session restore reopened an edit form (Delete button,
        // stale fields) the user never asked for.
        var dossModal = document.getElementById('clientDashboardModal');
        var dossOpen = dossModal && dossModal.classList.contains('active');
        var cid = (window.p86ClientDossier && typeof window.p86ClientDossier.getOpenId === 'function')
          ? window.p86ClientDossier.getOpenId() : null;
        if (dossOpen && cid) { route.estSub = 'clients'; route.clientId = cid; return route; }
      }
      // Subs: the editor modal is intentionally NOT captured (same relaunch
      // trap as the client editor — a session restore must not reopen an
      // edit form). The URL stays /subs while the editor is up.
      if (estSub && KNOWN_EST_SUBS.indexOf(estSub) !== -1) route.estSub = estSub;
    } else if (top === 'admin') {
      var adEl = document.querySelector('[data-admin-subtab].active');
      var adSub = adEl ? adEl.getAttribute('data-admin-subtab') : null;
      if (adSub && KNOWN_ADMIN_SUBS.indexOf(adSub) !== -1) route.adSub = adSub;
      // /admin/agents drill-downs — read from adminAgentsAPI which
      // tracks conv key / eval id / new-eval-form state internally.
      if (adSub === 'agents' && window.adminAgentsAPI) {
        try {
          var convKey = window.adminAgentsAPI.getOpenConvKey && window.adminAgentsAPI.getOpenConvKey();
          var evalId = window.adminAgentsAPI.getOpenEvalId && window.adminAgentsAPI.getOpenEvalId();
          var newOpen = window.adminAgentsAPI.isNewEvalOpen && window.adminAgentsAPI.isNewEvalOpen();
          if (convKey) route.adAgentConvKey = convKey;
          else if (newOpen) route.adAgentEvalNew = true;
          else if (evalId) route.adAgentEvalId = evalId;
        } catch (e) { /* defensive */ }
      }
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
    if (orig.__p86RouterWrapped) return true;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      // Skip the push when this call originated from our own replay
      // path — the URL is already correct, and pushing again would
      // double-stack identical entries in history.
      if (!replaying) scheduleSync();
      return r;
    };
    wrapped.__p86RouterWrapped = true;
    wrapped.__p86RouterOrig = orig;
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
    var dataReady = !(typeof window.p86DataLoading === 'function' && window.p86DataLoading());
    replaying = true;
    try {
      if (typeof window.switchTab === 'function') {
        var origSwitchTab = window.switchTab.__p86RouterOrig || window.switchTab;
        origSwitchTab(route.top);
      }

      if (route.top === 'estimates' && typeof window.switchEstimatesSubTab === 'function') {
        var origEstSub = window.switchEstimatesSubTab.__p86RouterOrig || window.switchEstimatesSubTab;
        // A bare /estimates deep link must land on the Estimate LIST subtab
        // (what the sidebar "Estimate List" button sets). switchTab alone
        // leaves whichever subtab pane is .active in the static DOM — Leads,
        // the first one — so /estimates used to render the Leads list.
        origEstSub(route.estSub || 'list');
      }
      // Drive the virtual-tab highlight so the right sibling lights up
      // on refresh. switchTab() above always activates the FIRST
      // [data-tab="estimates"] button (Leads, since it's first in the
      // DOM) — click handlers correct this via markVirtualTabActive,
      // but the router replay never called it. Mapping is per-estSub
      // since each Estimates sub-page has its own virtual-tab id.
      if (route.top === 'estimates' && typeof window.markVirtualTabActive === 'function') {
        var virtual;
        if (route.estSub === 'leads') virtual = 'leads';
        else if (route.estSub === 'clients') virtual = 'clients';
        else if (route.estSub === 'subs') virtual = 'subs';
        else if (route.estSub === 'users') virtual = 'users';
        else virtual = 'estimates';   // covers estSub='list' and undefined
        window.markVirtualTabActive(virtual);
      }
      if (route.top === 'admin' && route.adSub && typeof window.switchAdminSubTab === 'function') {
        var origAdSub = window.switchAdminSubTab.__p86RouterOrig || window.switchAdminSubTab;
        origAdSub(route.adSub);
      }
      // Drive the admin accordion child highlight on refresh, mirroring
      // the estimates handling above — switchTab('admin') alone doesn't
      // light the open child. The accordion children carry
      // data-virtual-tab="admin-<subtab>". Legacy alias subtabs
      // (templates/materials/jobs/sms/email) fold into Organization via
      // switchAdminSubTab's ORG_REDIRECTS, so they highlight that child.
      if (route.top === 'admin' && typeof window.markVirtualTabActive === 'function') {
        var ADMIN_VIRTUAL = {
          users: 'admin-users', roles: 'admin-roles',
          organization: 'admin-organization', agents: 'admin-agents',
          context: 'admin-context', metrics: 'admin-metrics',
          system: 'admin-system',
          templates: 'admin-organization', materials: 'admin-organization',
          jobs: 'admin-organization', sms: 'admin-organization',
          email: 'admin-organization', 'email-templates': 'admin-organization'
        };
        window.markVirtualTabActive(ADMIN_VIRTUAL[route.adSub] || 'admin-users');
      }
    } finally {
      replaying = false;
    }

    // Entity-open steps that depend on data being loaded — defer
    // until p86DataLoading clears, mirroring restoreNavState in app.js.
    function openEntities() {
      replaying = true;
      try {
        if (route.top === 'jobs' && route.jobId && typeof window.editJob === 'function') {
          var origEditJob = window.editJob.__p86RouterOrig || window.editJob;
          origEditJob(route.jobId);
          if (route.jobSub && typeof window.switchJobSubTab === 'function') {
            var origJobSub = window.switchJobSubTab.__p86RouterOrig || window.switchJobSubTab;
            origJobSub(route.jobSub);
          }
        } else if (route.top === 'jobs' && route.archived &&
                   typeof window.showArchivedJobs === 'function') {
          // Open archive view if it isn't already showing. showArchivedJobs
          // is a toggle, so check current state first to avoid closing it.
          var archiveEl = document.getElementById('archived-jobs-list');
          var alreadyOpen = archiveEl && archiveEl.style.display !== 'none';
          if (!alreadyOpen) {
            var origShowArchived = window.showArchivedJobs.__p86RouterOrig || window.showArchivedJobs;
            origShowArchived();
          }
        } else if (route.top === 'estimates' && route.estId && typeof window.editEstimate === 'function') {
          if (typeof window.switchEstimatesSubTab === 'function') {
            var origEstSub2 = window.switchEstimatesSubTab.__p86RouterOrig || window.switchEstimatesSubTab;
            origEstSub2('list');
          }
          var origEditEst = window.editEstimate.__p86RouterOrig || window.editEstimate;
          origEditEst(route.estId);
        } else if (route.top === 'estimates' && route.estSub === 'leads' && route.leadId &&
                   typeof window.openEditLeadModal === 'function') {
          var origOpenLead = window.openEditLeadModal.__p86RouterOrig || window.openEditLeadModal;
          origOpenLead(route.leadId);
        } else if (route.top === 'estimates' && route.estSub === 'leads' && !route.leadId) {
          // Back-nav from /estimates/leads/:id to /estimates/leads — close
          // the detail view if it's still up so the list shows through.
          var leadDetailEl = document.getElementById('lead-detail-view');
          if (leadDetailEl && leadDetailEl.style.display !== 'none' &&
              typeof window.closeLeadDetail === 'function') {
            var origCloseLead = window.closeLeadDetail.__p86RouterOrig || window.closeLeadDetail;
            origCloseLead();
          }
        } else if (route.top === 'estimates' && route.estSub === 'clients' && route.clientId &&
                   typeof window.openClientDashboard === 'function') {
          // Deep-link replays into the read-only dossier, never the editor.
          var origOpenClient = window.openClientDashboard.__p86RouterOrig || window.openClientDashboard;
          origOpenClient(route.clientId);
        } else if (route.top === 'estimates' && route.estSub === 'subs' && route.subId) {
          // Legacy /subs/:id link — land on the directory, clean the URL.
          // Deliberately does NOT open the sub editor (relaunch trap).
          try { history.replaceState({ route: { top: 'estimates', estSub: 'subs' } }, '', '/subs'); } catch (e) {}
        } else if (route.top === 'admin' && route.adSub === 'agents') {
          // Three drill-downs share /admin/agents — pick the right one
          // by which route field is set, then call switchAgentsView for
          // the matching parent view (conversations | evals) before
          // opening the entity. Without the view-switch the rendered
          // pane shows the wrong tab pill even though the entity opens
          // correctly.
          if (route.adAgentConvKey && typeof window.openAgentConversation === 'function') {
            if (typeof window.switchAgentsView === 'function') {
              try { window.switchAgentsView('conversations'); } catch (e) { /* defensive */ }
            }
            var origOpenConv = window.openAgentConversation.__p86RouterOrig || window.openAgentConversation;
            origOpenConv(route.adAgentConvKey);
          } else if (route.adAgentEvalNew && typeof window.openNewEvalModal === 'function') {
            if (typeof window.switchAgentsView === 'function') {
              try { window.switchAgentsView('evals'); } catch (e) { /* defensive */ }
            }
            var origOpenNewEval = window.openNewEvalModal.__p86RouterOrig || window.openNewEvalModal;
            origOpenNewEval();
          } else if (route.adAgentEvalId && typeof window.openEvalDetail === 'function') {
            if (typeof window.switchAgentsView === 'function') {
              try { window.switchAgentsView('evals'); } catch (e) { /* defensive */ }
            }
            var origOpenEval = window.openEvalDetail.__p86RouterOrig || window.openEvalDetail;
            origOpenEval(route.adAgentEvalId);
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
        var stillLoading = (typeof window.p86DataLoading === 'function') && window.p86DataLoading();
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
      'closeLeadDetail',
      'openEditClientModal',
      'openClientDashboard',
      'closeClientDashboard',
      'showArchivedJobs',
      'openAgentConversation',
      'closeAgentConversation',
      'openEvalDetail',
      'closeEvalDetail',
      'openNewEvalModal',
      'cancelNewEval',
      'switchAgentsView'
    ].forEach(wrapNav);

    // p86Subs.openEdit is namespaced (not on window directly), so wrap
    // it manually with the same shape as wrapNav. p86Subs may not be
    // initialized yet at boot; retry briefly until it shows up.
    function wrapSubsOpenEdit() {
      if (!window.p86Subs || typeof window.p86Subs.openEdit !== 'function') return false;
      var orig = window.p86Subs.openEdit;
      if (orig.__p86RouterWrapped) return true;
      var wrapped = function () {
        var r = orig.apply(this, arguments);
        if (!replaying) scheduleSync();
        return r;
      };
      wrapped.__p86RouterWrapped = true;
      wrapped.__p86RouterOrig = orig;
      window.p86Subs.openEdit = wrapped;
      return true;
    }
    if (!wrapSubsOpenEdit()) {
      var subsAttempts = 0;
      var subsIv = setInterval(function () {
        if (wrapSubsOpenEdit() || ++subsAttempts > 30) clearInterval(subsIv);
      }, 200);
    }

    window.addEventListener('popstate', onPopState);

    // Public hooks so other modules can opt in / inspect.
    window.p86Router = {
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
      // Replay only once the app shell is actually visible. auth.js boot
      // is async (token refresh → /me → capabilities → showApp()) and can
      // outlast any fixed delay — on a slow start (PWA update relaunch,
      // cold server) a timed replay ran against the still-hidden shell,
      // so views that measure the app chrome at open time (the job map
      // overlay) sized themselves to 0 and painted over the sidebar.
      // No cap: if the user is on the login screen, the deep link
      // replays right after login shows the shell instead of being lost
      // (showApp() skips its own nav restore whenever the URL has a
      // route, expecting this replay to run).
      var replayIv = setInterval(function () {
        var ac = document.getElementById('app-container');
        if (!ac || ac.offsetParent === null) return; // shell still hidden
        clearInterval(replayIv);
        applyRoute(initial);
      }, 150);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
