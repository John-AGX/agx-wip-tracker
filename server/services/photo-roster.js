// THE PHOTO ROSTER — "which parents of this type have photos on them".
//
// Attachments in this app are polymorphic: one table, (entity_type, entity_id),
// with photos hanging off leads, jobs, projects, tasks and service tickets.
// Only the SURFACES were project-shaped. Somebody asked 86 to caption the
// photos on a gazebo LEAD and hit exactly that: the photos existed and nothing
// in the product could list them. This is the missing list, one roster per
// parent type, feeding the Jobs and Leads tabs of the Photos hub.
//
// ── THE TENANCY ANCHOR IS THE PARENT. NOT THE ATTACHMENT ROW. ────────────
// GET /api/attachments/recent — the route this mode hangs off — scopes by the
// UPLOADER's org (`uploaded_by -> users.organization_id`) with an
// `OR IS NULL` tolerance, and its own comment admits that is a shortcut
// appropriate to a discovery widget. THIS IS NOT THAT. A roster names parents.
// server/services/attachment-org-scope.js states the rule in its header and
// states why:
//
//     entity_type/entity_id are NOT NULL and written on every insert, while
//     organization_id is nullable and (until that commit) unwritten by the
//     upload path. Anchoring on the column would have meant every row created
//     since the last boot fell into the IS NULL tolerance arm — a predicate
//     that reads as strict and admits everything.
//
// So every roster filters `jobs.organization_id` / `leads.organization_id`,
// the parent's own stamp, with the `OR organization_id IS NULL` tolerance every
// read in this repo carries and that userInOrg() encodes (a legacy un-adopted
// row stays reachable; dropping that arm is its own reviewed change, gated on
// the stamp audit). A parent belonging to another tenant is not in the result
// and is indistinguishable from one that does not exist — the roster is a list,
// so absence IS the refusal and there is nothing to leak a 403 through.
//
// ── CAPABILITY IS NOT COSMETIC HERE ──────────────────────────────────────
// readCapForEntity('job') is an OR-list that INCLUDES the assigned-only tier
// ('JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN'). A field
// user who may see only their own jobs must not learn the NAMES of the rest
// from a photo roster — a roster of job names is exactly the thing that tier
// exists to withhold. `assignedOnlyUserId` narrows the population to the two
// clauses job-routes.js's canAccess() already uses for a non-admin: the job's
// own owner_id, or an explicit grant row in job_access. Not a new mechanism,
// the existing one, asked in SQL because the alternative is fetching every job
// in the org and filtering after.
//
// ── COUNTS ARE THE VIEWER'S COUNT ────────────────────────────────────────
// photo_count uses viewerImageSql() — js/attachments.js's own
// isImageAttachment() in SQL — and MEMBERSHIP uses the same expression
// (`... > 0`), from one place, so "has photos" and "has N photos" can never
// disagree. A roster that says 12 and opens to 3 is the defect class this repo
// is built around.
'use strict';

const { firstPhotoSql, viewerImageSql } = require('./photo-cover');
// The ONE definition of `jobNumber + ' ' + title`, loaded on both sides. Job
// labels are forward-facing; see js/job-label.js for why there is no
// server/client split of it.
const jobLabel = require('../../js/job-label');

// One entry per roster. `type` is the attachments.entity_type LITERAL and
// `table` the parent table — both come from HERE and never from a caller, the
// same whitelist discipline attachment-org-scope.js's ENTITY_TABLES uses.
//
// The name columns mirror server/services/entity-labels.js, which is this
// repo's authority on what an entity is CALLED. Jobs resolve to
// jobNumber + title through the shared formatter; leads to leads.title. The
// COALESCEs end in '' rather than a literal 'Job'/'Lead' for the reason that
// file gives: a bare type word is a synthetic string that reaches a
// forward-facing surface as if it were a real name.
// THE EMPTY STRING IS TYPED, AND THE SEARCH EXPRESSION IS EXPLICIT.
// Both are Postgres-only hazards that the SQLite harness would have hidden,
// which is exactly the pair worth stating rather than discovering in
// production:
//
//   • `'' AS num` on the lead roster is an UNKNOWN-typed literal. Alone in a
//     select list Postgres resolves it to text, but the moment it meets `||`
//     it does not: `'' || ' '` is unknown || unknown and Postgres answers
//     "operator is not unique". SQLite is dynamically typed and would have run
//     it happily, green suite and all. `''::text` pins it.
//   • searchExpr is written per roster rather than composed from numExpr,
//     so the lead roster never concatenates a constant onto anything. A
//     structure that cannot produce the bad statement beats a statement that
//     happens not to be bad.
const ROSTERS = {
  job: {
    type: 'job',
    table: 'jobs',
    // jobs.data is the JSONB blob; there is no title column.
    numExpr: 'COALESCE(NULLIF(e.data->>\'jobNumber\', \'\'), \'\')',
    labelExpr: 'COALESCE(e.data->>\'title\', e.data->>\'name\', \'\')',
    // Search the composed name — a PM types either the number or the title.
    searchExpr: 'COALESCE(e.data->>\'jobNumber\', \'\') || \' \' || COALESCE(e.data->>\'title\', e.data->>\'name\', \'\')',
    // The assigned-only tier exists for jobs and only for jobs.
    narrowable: true,
  },
  lead: {
    type: 'lead',
    table: 'leads',
    numExpr: '\'\'::text',
    labelExpr: 'COALESCE(e.title, \'\')',
    searchExpr: 'COALESCE(e.title, \'\')',
    narrowable: false,
  },
};

function isRosterType(t) {
  return Object.prototype.hasOwnProperty.call(ROSTERS, String(t));
}

// The all-jobs tier. Holding EITHER of these means the roster is the whole
// org; holding neither (but still holding one of readCapForEntity('job')'s
// assigned-only members, or the door would not have opened) narrows it.
const WIDE_JOB_CAPS = ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY'];

const MAX_LIMIT = 60;
const DEFAULT_LIMIT = 30;

// Build the roster statement + bound params.
//
//   orgId              the caller's tenant. Anchors on the PARENT's column.
//   assignedOnlyUserId non-null narrows a job roster to that user's own /
//                      granted jobs. Ignored for rosters with no such tier.
//   q                  optional name filter (server-side, so the search box in
//                      the hub header means the same thing on every tab).
//   limit / offset     paging.
//
// Returns { text, params }. Every value is BOUND; the only interpolated pieces
// are the literals held in ROSTERS above and the fragments photo-cover.js
// validates.
function buildRosterQuery(entityType, opts) {
  const spec = ROSTERS[String(entityType)];
  if (!spec) throw new Error('buildRosterQuery: unknown roster ' + entityType);
  const o = opts || {};

  const params = [];
  const bind = (v) => { params.push(v); return '$' + params.length; };

  // THE viewer predicate, used for the count AND for membership, so the two
  // are one expression and cannot drift apart.
  const photoCount =
    '(SELECT COUNT(*)::int FROM attachments a ' +
    '  WHERE a.entity_type = \'' + spec.type + '\' AND a.entity_id = e.id ' +
    '    AND ' + viewerImageSql('a') + ')';

  // Most recent photo, by the same clock the cover orders on (EXIF when we
  // have it, upload time when we do not) so "newest photo" and "first photo"
  // are measured on one timeline rather than two.
  const lastPhotoAt =
    '(SELECT MAX(COALESCE(a.taken_at, a.uploaded_at)) FROM attachments a ' +
    '  WHERE a.entity_type = \'' + spec.type + '\' AND a.entity_id = e.id ' +
    '    AND ' + viewerImageSql('a') + ')';

  const coverThumb = firstPhotoSql('thumb_url', spec.type, 'e.id');
  const coverWeb = firstPhotoSql('web_url', spec.type, 'e.id');

  const where = [];

  // ── TENANCY. The parent's own stamp. First, before anything else. ──────
  const orgParam = bind(o.orgId == null ? null : o.orgId);
  where.push('(e.organization_id = ' + orgParam + ' OR e.organization_id IS NULL)');

  // ── CAPABILITY. Narrow to owned/granted when the caller lacks the
  //    all-jobs tier. Mirrors canAccess() in job-routes.js.
  if (spec.narrowable && o.assignedOnlyUserId != null) {
    const meParam = bind(o.assignedOnlyUserId);
    where.push(
      '(e.owner_id = ' + meParam + ' OR EXISTS (SELECT 1 FROM job_access ja ' +
      '  WHERE ja.job_id = e.id AND ja.user_id = ' + meParam + '))'
    );
  }

  // ── SEARCH. Applied to the same composed name the row renders, so the
  //    header's search box is not a lie on these tabs.
  const q = String(o.q == null ? '' : o.q).trim();
  if (q) {
    const qParam = bind('%' + q + '%');
    where.push('(' + spec.searchExpr + ') ILIKE ' + qParam);
  }

  // ── "has at least one photo", stated as the count the row will show.
  where.push(photoCount + ' > 0');

  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(o.limit, 10) || DEFAULT_LIMIT));
  const offset = Math.max(0, parseInt(o.offset, 10) || 0);
  const limitParam = bind(limit);
  const offsetParam = bind(offset);

  const text =
    'SELECT e.id AS entity_id, ' +
    '       ' + spec.numExpr + ' AS num, ' +
    '       ' + spec.labelExpr + ' AS label, ' +
    '       ' + photoCount + ' AS photo_count, ' +
    '       ' + lastPhotoAt + ' AS last_photo_at, ' +
    '       ' + coverThumb + ' AS cover_thumb_url, ' +
    '       ' + coverWeb + ' AS cover_web_url ' +
    '  FROM ' + spec.table + ' e ' +
    ' WHERE ' + where.join(' AND ') +
    // Most-recent-first, ties broken on the id so paging is stable rather than
    // whatever the planner returns (two parents whose newest photo landed in
    // the same second would otherwise be able to swap places between pages and
    // be shown twice / never).
    ' ORDER BY last_photo_at DESC, e.id ASC ' +
    ' LIMIT ' + limitParam + ' OFFSET ' + offsetParam;

  return { text, params };
}

// Row -> what the client renders. Kept here rather than in the route so the
// name composition is testable without standing up auth.
//
// cover_is_auto is TRUE whenever a cover came back, and that is the honest
// answer: unlike projects, a job and a lead have no cover_attachment_id — there
// is no "Set as cover" on them — so nobody chose this shot, it is simply the
// first photo taken. The UI says so on hover, exactly as 7bc0c225 made the
// project rows say it.
function shapeRosterRow(entityType, row) {
  const num = row.num == null ? '' : String(row.num);
  const label = row.label == null ? '' : String(row.label);
  const name = (entityType === 'job')
    ? jobLabel(num, label, { fallback: 'Untitled job' })
    : (label.trim() || 'Untitled lead');
  const cover = row.cover_thumb_url || row.cover_web_url || null;
  return {
    entity_type: entityType,
    entity_id: String(row.entity_id),
    name,
    photo_count: Number(row.photo_count || 0),
    last_photo_at: row.last_photo_at == null ? null
      : (row.last_photo_at instanceof Date ? row.last_photo_at.toISOString() : String(row.last_photo_at)),
    cover_thumb_url: row.cover_thumb_url || null,
    cover_web_url: row.cover_web_url || null,
    cover_is_auto: !!cover,
  };
}

module.exports = {
  ROSTERS,
  WIDE_JOB_CAPS,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  isRosterType,
  buildRosterQuery,
  shapeRosterRow,
};
