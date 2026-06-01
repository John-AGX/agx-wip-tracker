// ───────────────────────────────────────────────────────────────────
// Server-side mirror of js/folder-taxonomy.js — the DEFAULT folder
// structure every lead / estimate / job / client carries before any
// file is uploaded.
//
// Folders in Project 86 are IMPLICIT: a folder only "exists" when an
// attachment row carries that `folder` value. This constant fills the
// "empty default folder has nowhere to live" gap. The client ships the
// same list in js/folder-taxonomy.js; this server copy is the
// authority used to (a) seed a fresh org_folder_templates response when
// no custom row exists, and (b) sanitize/validate folder arrays an
// admin submits through the templates editor.
//
// KEEP THIS IN LOCKSTEP with js/folder-taxonomy.js. Folder strings MUST
// already be in the shape sanitizeFolderPath() produces (lowercase,
// hyphenated, `/`-delimited, max 3 levels) so a taxonomy folder is
// never rejected when it round-trips through the move/grant endpoints.
// ───────────────────────────────────────────────────────────────────
'use strict';

const FOLDER_TAXONOMY = {
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

// The four entity types that carry a folder taxonomy. Anything else
// (e.g. 'user' for My Files) has no default set — just 'general'.
const TEMPLATE_ENTITY_TYPES = ['lead', 'estimate', 'job', 'client'];

// Sanitize one folder path to the EXACT shape attachment-routes.js's
// sanitizeFolderPath produces (lowercase, hyphenated, `/`-delimited
// subfolders, max 3 levels, segments max 60 chars). Returns '' for an
// input that sanitizes to nothing so callers can drop it rather than
// silently storing 'general'. (sanitizeFolderPath itself defaults
// empties to 'general'; here we want to DISCARD empties from a template
// list, since 'general' is always appended at render time anyway.)
function sanitizeFolderPath(raw) {
  const str = String(raw == null ? '' : raw).trim().slice(0, 180);
  const segs = str.split('/')
    .map(function (s) {
      return s.trim().slice(0, 60).toLowerCase()
        .replace(/[^a-z0-9 _\-]/g, '').replace(/\s+/g, '-');
    })
    .filter(Boolean)
    .slice(0, 3);
  return segs.join('/');
}

// Default folder list for an entity type (returns a copy). Does NOT
// append 'general' — the client owns that catch-all so the stored
// template stays clean. Unknown types → [].
function defaultFoldersForEntity(type) {
  const key = String(type || '').toLowerCase();
  return FOLDER_TAXONOMY[key] ? FOLDER_TAXONOMY[key].slice() : [];
}

// Clean + de-dupe a submitted folder array into a storable template:
// sanitize each entry, drop empties and 'general' (always appended
// client-side), drop dupes, preserve order, cap length so a runaway
// payload can't bloat a row. Returns a fresh array.
function sanitizeFolderList(arr) {
  const out = [];
  const seen = Object.create(null);
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length && out.length < 100; i++) {
    const v = sanitizeFolderPath(arr[i]);
    if (!v || v === 'general') continue;
    if (seen[v]) continue;
    seen[v] = true;
    out.push(v);
  }
  return out;
}

module.exports = {
  FOLDER_TAXONOMY,
  TEMPLATE_ENTITY_TYPES,
  sanitizeFolderPath,
  defaultFoldersForEntity,
  sanitizeFolderList
};
