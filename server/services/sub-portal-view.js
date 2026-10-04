'use strict';

/* WHAT A SUBCONTRACTOR SEES, IN ONE PLACE.
 *
 * The sub portal reads two things: who the sub is, and every file in the
 * folders that have been shared with them. Both were inline in
 * routes/sub-portal-routes.js, which was fine while the portal was the only
 * reader — and stopped being fine the moment somebody internal wanted to LOOK
 * at the portal to see what a sub is seeing.
 *
 * A PREVIEW THAT RE-IMPLEMENTS THE READ IS WORSE THAN NO PREVIEW. It would be
 * wrong in one of two directions and both are bad:
 *
 *   SHOWS MORE than the sub sees — the office concludes the sub has a document
 *   they have not been given, and stops chasing it.
 *   SHOWS LESS — the office re-sends something the sub already has, or worse,
 *   believes a leak is impossible because the preview looked clean while the
 *   real portal served a field this one forgot to drop.
 *
 * The preview is only worth having if it is the same read. So it is the same
 * read: one function, two callers, and a test that asserts the portal route
 * does not keep a second copy.
 *
 * ━━ THE PROJECTION IS A WHITELIST AND MUST STAY ONE ━━
 *
 * SUB_ATTACHMENT_FIELDS below is the complete set of keys a subcontractor ever
 * receives. The query still reads `a.*` because the folder match needs the
 * whole row shape, so the safe list is declared in code rather than implied by
 * whatever the SELECT happens to return — a column added to `attachments`, or
 * a table joined in later, cannot reach a sub by accident.
 *
 * Deliberately absent: uploaded_by (an internal user id), extracted_text (the
 * full OCR body), annotations, tags, anthropic_file_id, lat/lng, created_at /
 * updated_at, and every storage key. No money field exists on this payload at
 * all — no contract, cost, margin, budget or client.
 *
 * Pinned by test/sub-portal-payload.test.js. Adding a key means changing that
 * test on purpose.
 */

const { pool } = require('../db');
const { resolveEntityLabels } = require('./entity-labels');

const SUB_ATTACHMENT_FIELDS = [
  'id', 'filename', 'mime_type', 'size_bytes',
  'thumb_url', 'web_url', 'original_url',
  // The grant coordinates portal.html echoes back on upload — these must stay
  // RAW (the POST re-checks the grant on them), so they are ids, not labels.
  'entity_type', 'entity_id', 'folder',
  'grant_entity_type', 'grant_entity_id', 'grant_folder',
  // The human label composed from those coordinates.
  'grant_entity_label',
];

/* Which grant types get a resolved label. A WHITELIST, so an unrecognised or
 * future grant type fails closed to "no label" rather than leaking.
 *   job  → jobNumber + ' ' + title
 *   lead → the lead title
 * Deliberately NOT here: client (a client's name), sub (another
 * subcontractor's name), estimate (titles routinely carry the client). Those
 * grants render a neutral header instead. */
const PORTAL_LABEL_TYPES = new Set(['job', 'lead']);

function publicAttachment(row) {
  const out = {};
  for (const k of SUB_ATTACHMENT_FIELDS) out[k] = row[k] === undefined ? null : row[k];
  return out;
}

/* The sub's own identity card. `orgId` is the tenant the CALLER is allowed to
 * read — the live portal passes the sub-user's own org, the preview passes the
 * admin's, and either way a sub outside it is not found. */
async function subIdentity(subId, orgId, runner) {
  const db = runner || pool;
  const { rows } = await db.query(
    'SELECT id, name, trade, email, primary_contact_first, primary_contact_last'
    + ' FROM subs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
    [subId, orgId]
  );
  return rows[0] || null;
}

/* Every file in every folder shared with this sub, exactly as the sub receives
 * it.
 *
 * The grant join is additive on purpose: a file belongs to a grant if its
 * legacy folder STRING matches, OR (when the grant carries a folder_id) its
 * folder_id matches. The two agree in steady state — the string is dual-written
 * as the folder's path — but the OR guarantees no lockout in any transient
 * state where one drifted from the other.
 *
 * Label resolution runs grants → jobs and never the reverse: the id list handed
 * to the resolver is built ENTIRELY from rows the sub_id-scoped query already
 * returned, and the resolver looks those ids up by primary key. It cannot
 * enumerate, cannot widen, and cannot add or drop a row — worst case a lookup
 * fails and the header falls back to a neutral word.
 */
async function sharedAttachments(subId, orgId, runner) {
  const db = runner || pool;
  const { rows } = await db.query(
    `SELECT a.*, g.entity_type AS grant_entity_type,
            g.entity_id AS grant_entity_id,
            g.folder AS grant_folder
       FROM attachment_folder_grants g
       JOIN attachments a
         ON a.entity_type = g.entity_type
        AND a.entity_id   = g.entity_id
        AND ( a.folder = g.folder
              OR (g.folder_id IS NOT NULL AND a.folder_id = g.folder_id) )
      WHERE g.sub_id = $1
      ORDER BY g.entity_type, g.entity_id, g.folder, a.position`,
    [subId]
  );

  const items = rows
    .filter((r) => PORTAL_LABEL_TYPES.has(r.grant_entity_type))
    .map((r) => ({ entity_type: r.grant_entity_type, entity_id: r.grant_entity_id }));
  const labels = await resolveEntityLabels(orgId == null ? null : orgId, items);

  return rows.map((r) => {
    const out = publicAttachment(r);
    out.grant_entity_label = PORTAL_LABEL_TYPES.has(r.grant_entity_type)
      ? (labels.get(r.grant_entity_type + ':' + String(r.grant_entity_id)) || null)
      : null;
    return out;
  });
}

module.exports = {
  SUB_ATTACHMENT_FIELDS,
  PORTAL_LABEL_TYPES,
  publicAttachment,
  subIdentity,
  sharedAttachments,
};
