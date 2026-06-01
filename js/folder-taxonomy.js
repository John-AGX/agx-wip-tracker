// ───────────────────────────────────────────────────────────────────
// Folder taxonomy — single source of truth for the DEFAULT folder
// structure that every lead / estimate / job / client carries.
//
// Folders in Project 86 are *implicit*: a folder only "exists" when an
// attachment row carries that `folder` value (free-text, sanitized to
// lowercase-hyphenated, `/`-delimited subfolders, max 3 levels — see
// sanitizeFolder in js/my-files.js and sanitizeFolderPath in
// server/routes/attachment-routes.js). That means an empty default
// folder has nowhere to live.
//
// This constant fills that gap WITHOUT a migration or per-row seeding:
// the My Files tree, the send/copy picker, and the sub grant dropdown
// all MERGE this list with the live DISTINCT folders for an entity, so
// the default set shows up for every lead/estimate/job — new AND
// existing — even when no file has been uploaded yet. An estimate
// inherits the lead set and "appends" its sales folders simply by being
// an estimate; a job exposes subfolders that sub grants can be scoped
// to.
//
// Folder strings MUST already be in the shape sanitizeFolder() produces
// (lowercase, hyphenated, `/`-delimited) so a taxonomy folder is never
// rejected when it round-trips through the move/grant endpoints.
// ───────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  var FOLDER_TAXONOMY = {
    // Lead = a prospect, pre-sale. Limited set.
    lead: [
      'site-photos',
      'plans-specs',
      'proposals',
      'correspondence'
    ],
    // Estimate = the lead set + sales-cycle folders appended on top.
    estimate: [
      'site-photos',
      'plans-specs',
      'proposals',
      'correspondence',
      'takeoff',
      'sub-bids',
      'contract'
    ],
    // Job = full doc-control set. Subfolders (plans/*, photos/*,
    // closeout/*) are the grant-scopable units a sub can be given
    // access to without seeing the whole job.
    job: [
      'contracts',
      'plans/current',
      'plans/revisions',
      'permits',
      'submittals',
      'rfis',
      'photos/progress',
      'photos/before-after',
      'change-orders',
      'daily-reports',
      'closeout/warranties',
      'closeout/as-builts',
      'safety'
    ],
    // Client = light shared set spanning that client's work.
    client: [
      'contracts',
      'correspondence',
      'documents'
    ]
  };

  // ─── Org-template cache ────────────────────────────────────────
  // FOLDER_TAXONOMY above is the built-in DEFAULT. Each org can
  // override the set per entity type via Settings → Templates →
  // Folder Templates (stored in org_folder_templates, served by
  // /api/folder-templates). loadFolderTemplates() fetches the org's
  // effective sets once and caches them; foldersForEntity() then
  // prefers the cached org set over the built-in default. Until the
  // fetch resolves (or if it fails), we fall back to FOLDER_TAXONOMY
  // so the picker / tree never render empty.
  var _templateCache = null;   // { lead:[...], estimate:[...], ... } or null
  var _loadPromise = null;     // de-dupes concurrent loads

  // Returns the effective default list for a type, preferring the
  // cached org template, falling back to the built-in taxonomy. Does
  // NOT append 'general' — that's foldersForEntity's job.
  function effectiveBase(type) {
    var key = String(type || '').toLowerCase();
    if (_templateCache && Object.prototype.hasOwnProperty.call(_templateCache, key)) {
      return _templateCache[key].slice();
    }
    return FOLDER_TAXONOMY[key] ? FOLDER_TAXONOMY[key].slice() : [];
  }

  // Fetch the org's folder templates and cache the effective sets.
  // Idempotent + de-duped: concurrent callers share one request, and
  // once loaded it returns the resolved cache without re-fetching
  // unless force=true. Safe to call before auth — a failed/empty
  // fetch just leaves the built-in defaults in play.
  function loadFolderTemplates(force) {
    if (_loadPromise && !force) return _loadPromise;
    if (_templateCache && !force) return Promise.resolve(_templateCache);
    if (!(window.p86Api && window.p86Api.folderTemplates && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated())) {
      return Promise.resolve(null);
    }
    _loadPromise = window.p86Api.folderTemplates.list()
      .then(function (resp) {
        var t = (resp && resp.templates) || {};
        var cache = {};
        Object.keys(t).forEach(function (k) {
          var eff = t[k] && t[k].effective;
          cache[k] = Array.isArray(eff) ? eff.slice() : [];
        });
        _templateCache = cache;
        return _templateCache;
      })
      .catch(function () { return _templateCache; })
      .then(function (c) { _loadPromise = null; return c; });
    return _loadPromise;
  }

  // Drop the cache so the next loadFolderTemplates() re-fetches.
  // Call after an admin edits the templates in Settings.
  function invalidateFolderTemplates() {
    _templateCache = null;
    _loadPromise = null;
  }

  // Default folder list for an entity type (returns a copy so callers
  // can't mutate the source). Prefers the cached org template, falls
  // back to the built-in taxonomy. 'general' is always appended as the
  // catch-all. Unknown types → just ['general'].
  function foldersForEntity(type) {
    var list = effectiveBase(type);
    if (list.indexOf('general') === -1) list.push('general');
    return list;
  }

  // Merge the default folders for `type` with any live folders that
  // already hold files. Defaults come first (in taxonomy order, with
  // 'general' last), then any extra live folders sorted alphabetically.
  // De-duped. liveFolders is an array of folder strings (e.g. derived
  // from an attachments list).
  function mergeFolders(type, liveFolders) {
    var out = foldersForEntity(type);
    var seen = {};
    out.forEach(function (f) { seen[f] = true; });
    var extras = [];
    (liveFolders || []).forEach(function (f) {
      var v = String(f == null ? '' : f).trim();
      if (!v || seen[v]) return;
      seen[v] = true;
      extras.push(v);
    });
    extras.sort();
    return out.concat(extras);
  }

  window.P86_FOLDER_TAXONOMY = FOLDER_TAXONOMY;
  window.foldersForEntity = foldersForEntity;
  window.mergeFolders = mergeFolders;
  window.loadFolderTemplates = loadFolderTemplates;
  window.invalidateFolderTemplates = invalidateFolderTemplates;

  // Warm the cache once the API client reports authentication. auth.js
  // dispatches 'p86:auth-ready' after login / token restore; listen for
  // it so the org templates are ready before the first Files view
  // renders. Also try an immediate load in case auth already resolved
  // before this script ran. Best-effort — if neither fires, the
  // built-in defaults remain in play.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('p86:auth-ready', function () { loadFolderTemplates(true); });
  }
  loadFolderTemplates();
})();
