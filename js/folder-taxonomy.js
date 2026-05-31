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

  // Default folder list for an entity type (returns a copy so callers
  // can't mutate the source). 'general' is always appended as the
  // catch-all. Unknown types → just ['general'].
  function foldersForEntity(type) {
    var key = String(type || '').toLowerCase();
    var list = FOLDER_TAXONOMY[key] ? FOLDER_TAXONOMY[key].slice() : [];
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
})();
