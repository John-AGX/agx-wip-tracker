'use strict';

/* ONE RULE FOR A CALLER-SUPPLIED THREAD KEY.
 *
 * `messages.thread_key` is typed by the caller — the URL is
 * /api/messages/:threadKey — and nothing proved it. GET and POST each checked
 * only isValidThreadKey (a SHAPE check) and isForbiddenDm (a check that
 * deliberately returns false for every non-DM key, because entity threads are
 * meant to be shared inside an org). So an org-A user could name an org-B job
 * and read its comments, and POST stamped the row with the AUTHOR's
 * organization_id — landing an org-A row inside org-B's thread.
 *
 * This is the third form of the lesson services/attachment-org-scope.js
 * already names: `messages` has carried organization_id since Wave 1.A Phase 2,
 * and no DOOR consulted it. A column added for tenancy that no door reads is
 * not a boundary, it is a comment. That file's own header says so, and names
 * this table as the precedent.
 *
 * THE ANCHOR IS THE ENTITY THE THREAD HANGS ON, not the message rows. A thread
 * is a conversation ABOUT something: a job, a lead, an estimate, a photo. The
 * parent answers first, through the same entityOrgVerdict / attachmentInOrg the
 * attachment doors use — one answer to "is this row yours", not a second one
 * written here.
 *
 * TWO LAYERS, BOTH NEEDED:
 *   1. the DOOR refuses a key whose entity is known to be another tenant's
 *      (this file), and
 *   2. the READ is org-scoped on the message rows regardless (the route),
 *      so an entity that cannot be resolved still leaks nothing.
 *
 * "UNKNOWN" FALLS THROUGH TO THE CONVERSATION ITSELF, which is the one rung
 * attachmentInOrg does not have because an attachment row carries its own
 * stamp and a thread key carries nothing.
 *
 * A job can be deleted while its comments remain — messages has no FK to any
 * entity table — and refusing outright would lose a real conversation between
 * real colleagues. But allowing outright builds an existence oracle: a foreign
 * job would answer 404 while an absent one answered 200, so the pair tells an
 * authenticated user whether an id exists in another tenant. That is precisely
 * the oracle the 404 convention in services/attachment-org-scope.js exists to
 * prevent, and a test comparing the two answers is what caught it here.
 *
 * So an unresolvable parent asks the messages: a thread that already holds a
 * message of the caller's organization is a deleted-parent conversation and is
 * allowed; an EMPTY unresolvable thread is a probe and is refused, which makes
 * it answer exactly as a foreign one does. Layer 2 then scopes the rows
 * regardless, so even the allowed case shows the caller nothing but their own.
 */

const scope = require('./attachment-org-scope');

// job:/lead:/estimate: → the entity type attachment-org-scope already knows.
// `attachment:` is handled separately because its own ladder is richer.
const THREAD_ENTITY = Object.freeze({
  job: 'job',
  lead: 'lead',
  estimate: 'estimate',
});

function splitKey(key) {
  const s = String(key || '');
  const at = s.indexOf(':');
  if (at <= 0) return null;
  return { prefix: s.slice(0, at), rest: s.slice(at + 1) };
}

/* May this caller touch this thread at all?
 *
 * TRUE for a dm: key — a DM's boundary is its two participant ids, enforced by
 * isForbiddenDm in the route, and both of them are narrowed to the sender's
 * organization where the DM notice is sent. Re-deciding it here would be a
 * second answer to a question already answered.
 *
 * FALSE only when the parent is KNOWN to belong to another tenant.
 */
// The last rung: does this thread already hold a message of the caller's own
// organization? True for a conversation whose parent has been deleted; false
// for a key nobody has ever posted to, which is what a probe looks like.
async function hasOwnMessages(runner, key, orgId) {
  const r = await runner.query(
    'SELECT 1 FROM messages WHERE thread_key = $1 AND (organization_id = $2 OR organization_id IS NULL) LIMIT 1',
    [key, orgId]
  );
  return r.rows.length > 0;
}

async function threadInOrg(runner, key, orgId) {
  const parts = splitKey(key);
  if (!parts) return false;
  if (parts.prefix === 'dm') return true;

  if (parts.prefix === 'attachment') {
    const r = await runner.query(
      'SELECT id, entity_type, entity_id, organization_id, uploaded_by FROM attachments WHERE id = $1',
      [parts.rest]
    );
    // The photo is gone. Its comments may not be, so ask them.
    if (!r.rows.length) return await hasOwnMessages(runner, key, orgId);
    return await scope.attachmentInOrg(runner, r.rows[0], orgId);
  }

  const type = THREAD_ENTITY[parts.prefix];
  if (!type) return false;   // a prefix this file cannot scope is not one we admit
  const verdict = await scope.entityOrgVerdict(runner, type, parts.rest, orgId);
  if (verdict === 'in') return true;
  if (verdict === 'out') return false;
  return await hasOwnMessages(runner, key, orgId);
}

module.exports = { THREAD_ENTITY, threadInOrg, hasOwnMessages };
