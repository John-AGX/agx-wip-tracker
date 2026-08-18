// One rule for every statement reachable by a caller-supplied ATTACHMENT id —
// and for the entity an attachment hangs on.
//
// WHY THIS EXISTS
// `services/job-org-scope.js` states the rule on the job key,
// `services/sub-org-scope.js` on the sub key, `services/user-org-scope.js` on
// the user key. attachment-routes.js is keyed on a THIRD enumerable id — the
// attachment's own `att_<ms>_<rand>` — and on the polymorphic
// (entity_type, entity_id) pair beside it. Neither key was proved anywhere in
// the file. Every row-keyed door read
//
//     SELECT * FROM attachments WHERE id = $1
//
// with no predicate at all and then asked hasCapability() — which answers "may
// this ROLE do this KIND of thing", never "is this ROW yours". A capability
// answer was standing in for a tenancy answer, so an org-A admin could delete
// an org-B row (and its storage blob), rewrite its caption, and stream its
// BYTES back through /raw/:id.
//
// THE SHARP PART, AND IT IS THE SAME ONE AS LAST TIME.
// `attachments` has carried `organization_id` since the Wave 1.A Phase 2
// migration in db.js, complete with a partial index and a backfill off
// `uploaded_by -> users.organization_id`. Nothing in attachment-routes.js ever
// read it — and the upload INSERT never wrote it either, so the column is only
// as current as the last boot's backfill. That is the recurring lesson in its
// third form: a column added for tenancy that no DOOR consults is not a
// boundary, it is a comment. The stamp is added to the INSERTs in the same
// commit as these predicates, deliberately in that order — stamping first
// would have made a forged row land correctly stamped and indistinguishable
// from real data, which is exactly what 79b52ed did to `messages`.
//
// THE RULE
//   every statement reachable by a caller-supplied attachment id, or by a
//   caller-supplied (entity_type, entity_id) pair, must prove that key belongs
//   to the caller's tenant BEFORE it reads or writes.
//
// THE ANCHOR: THE PARENT ENTITY, NOT THE ROW'S OWN COLUMN.
// An attachment is a CHILD of the entity it hangs on, the same way
// qb_cost_lines is a child of its job — and `parentJobInOrgSql` scopes those
// through the parent, not through their own stamp. Same here, and for a
// concrete reason: `entity_type`/`entity_id` are NOT NULL and written on every
// insert, while `organization_id` is nullable and (until this commit) unwritten
// by the upload path. Anchoring on the column would have meant every row
// created since the last boot fell into the `IS NULL` tolerance arm — a
// predicate that reads as strict and admits everything. The parent is asked
// first; the row's own stamp is the FALLBACK for when the parent cannot answer.
//
// TWO DIFFERENT ANSWERS FOR "NO SUCH ROW", ON PURPOSE.
//   • Entity-keyed doors (attachmentEntityInOrg): an entity id that resolves to
//     no row is REFUSED, with the same 404 a foreign one gets. Nothing is known
//     to exist behind it, so refusing costs nothing — and letting "absent" and
//     "another tenant's" answer differently would rebuild the existence oracle
//     the 404 convention exists to prevent.
//   • The row-keyed door (attachmentInOrg): the attachment row is already in
//     hand — it is a real file with real provenance. A missing PARENT there
//     means an orphan (its lead was deleted; attachments has no FK to any
//     entity table), not an absence, so the verdict falls through to the row's
//     own stamp and then to its uploader — db.js's own backfill anchor. Only
//     when NOTHING names a tenant does it allow, which is the same
//     `OR organization_id IS NULL` tolerance every read in this repo carries.
//     Refusing orphans outright would be a lockout, and DELETE here also
//     removes the storage blob.

const { userInOrg } = require('./user-org-scope');

// The tables a polymorphic attachment may hang on. A WHITELIST: entity_type
// comes off the request and is NEVER interpolated into SQL, only looked up
// here. Mirrors VALID_ENTITY_TYPES in attachment-routes.js minus the two
// IDENTITY buckets below; every table named here carries organization_id.
const ENTITY_TABLES = {
  lead:           'leads',
  estimate:       'estimates',
  client:         'clients',
  job:            'jobs',
  sub:            'subs',
  project:        'projects',
  task:           'tasks',
  purchase_order: 'job_purchase_orders',
  bill:           'job_vendor_bills',
};

// The two entity types with no table of their own:
//   'user' — entity_id is a users.id (the personal My Files bucket)
//   'org'  — entity_id IS an organizations.id (the company knowledge base)
const IDENTITY_TYPES = new Set(['user', 'org']);

// EVIDENCE, not a verdict: 'in' | 'out' | 'unknown'.
// Kept separate from the verdict so the two door families above can each
// decide what "unknown" means for them, and so the reason is inspectable.
async function entityOrgVerdict(runner, entityType, entityId, orgId) {
  const type = String(entityType || '');
  const id = entityId == null ? '' : String(entityId);
  if (!id) return 'unknown';

  // The org bucket IS the tenant: its entity_id is the organization id, so the
  // comparison needs no lookup. Same rule ensureOrgAttachmentScope already
  // applied — a caller with no org of their own can never match one.
  if (type === 'org') {
    if (orgId == null) return 'out';
    return String(orgId) === id ? 'in' : 'out';
  }

  // The personal bucket resolves through the owning user's tenant, which is
  // the one place the admin bypass in ensureUserAttachmentOwner used to cross:
  // isAdminish() is true for an org-A admin standing in front of an org-B
  // user's files.
  if (type === 'user') {
    const r = await runner.query('SELECT organization_id FROM users WHERE id = $1', [id]);
    if (!r.rows.length) return 'unknown';
    return userInOrg(orgId, r.rows[0].organization_id) ? 'in' : 'out';
  }

  const table = ENTITY_TABLES[type];
  if (!table) return 'unknown';   // an entity that cannot be scoped is not one we allow
  const r = await runner.query(`SELECT organization_id FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  if (!r.rows.length) return 'unknown';
  return userInOrg(orgId, r.rows[0].organization_id) ? 'in' : 'out';
}

// Guard for a door keyed on a caller-supplied (entity_type, entity_id) pair:
// the attachment LIST, the UPLOAD, the tag-suggest read, the move/copy
// DESTINATION, and — through the shared requireDynamicCapability — all five
// file-folders doors.
//
// FALSE for a foreign entity AND for an entity that resolves to nothing. The
// caller cannot tell those apart, which is the whole point.
async function attachmentEntityInOrg(runner, entityType, entityId, orgId) {
  return (await entityOrgVerdict(runner, entityType, entityId, orgId)) === 'in';
}

// Guard for a door keyed on the attachment's own id: raw stream, caption PUT,
// DELETE, bulk-tag, move/copy SOURCE. `att` is the row the handler already
// read; it MUST carry entity_type, entity_id, organization_id and uploaded_by.
//
// The ladder, strongest evidence first. See the header for why "unknown" from
// the parent falls through here instead of refusing.
async function attachmentInOrg(runner, att, orgId) {
  if (!att) return false;

  // 1. The parent entity the file hangs on. NOT NULL on every row, written by
  //    every insert path, and the thing a user actually navigates through.
  const parent = await entityOrgVerdict(runner, att.entity_type, att.entity_id, orgId);
  if (parent !== 'unknown') return parent === 'in';

  // 2. Orphan (the parent row is gone, or is one of the types with no table).
  //    The row's own stamp is the next-best claim about which tenant it is in.
  if (att.organization_id != null) return userInOrg(orgId, att.organization_id);

  // 3. Un-stamped orphan: the uploader. This is not a new mechanism — it is
  //    the exact anchor db.js's backfill uses for this table
  //    (`UPDATE attachments a SET organization_id = u.organization_id FROM
  //    users u WHERE u.id = a.uploaded_by`) and the one GET /recent already
  //    scopes by, so the door agrees with the read that was already right.
  if (att.uploaded_by != null) {
    const r = await runner.query('SELECT organization_id FROM users WHERE id = $1', [att.uploaded_by]);
    if (r.rows.length) return userInOrg(orgId, r.rows[0].organization_id);
  }

  // 4. Nothing names a tenant — no parent, no stamp, no uploader. The same
  //    tolerance every `OR organization_id IS NULL` in this repo carries.
  //    Dropping it is its own reviewed change, gated on the stamp audit.
  return true;
}

module.exports = {
  ENTITY_TABLES,
  IDENTITY_TYPES,
  entityOrgVerdict,
  attachmentEntityInOrg,
  attachmentInOrg,
};
