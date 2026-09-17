'use strict';

// Idempotent uploads (1.29). On a bad signal a photo can reach the server and
// its answer never make it back, so the page sends it again. Each upload
// carries a client-made id (upload_id); the second arrival of the same id for
// the same parent finds the row the first one wrote and answers "already
// added" instead of storing the photo twice.
//
// attachments.client_upload_id with the unique partial index
// uq_attachments_client_upload (organization_id, entity_type, entity_id,
// client_upload_id) is the backstop for two arrivals racing past the lookup:
// the loser's INSERT raises 23505, the caller discards the bytes it just put
// in storage and answers with the winner's row.
//
// TENANCY: the lookup carries organization_id = $1 from the parent the caller
// already proved, so an id can never find another tenant's row.

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const UPLOAD_ID_INDEX = 'uq_attachments_client_upload';

// The upload id from a request body, or null when it is missing or malformed
// (a malformed id is ignored, and the upload proceeds as a normal one).
function uploadIdFrom(body) {
  const v = body && typeof body === 'object' ? body.upload_id : null;
  return typeof v === 'string' && UPLOAD_ID_RE.test(v) ? v : null;
}

/**
 * findUpload(db, { orgId, entityType, entityId, uploadId }) -> row | null
 * No query when the org or the upload id is missing.
 */
async function findUpload(db, opts) {
  const o = opts || {};
  if (o.orgId == null || !o.uploadId || !o.entityType || o.entityId == null || o.entityId === '') return null;
  const r = await db.query(
    'SELECT * FROM attachments WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3 AND client_upload_id = $4',
    [o.orgId, String(o.entityType), String(o.entityId), String(o.uploadId)]
  );
  return (r && r.rows && r.rows[0]) || null;
}

// A unique violation on THIS index — not any 23505 an INSERT could raise.
function isUploadIdConflict(e) {
  if (!e || String(e.code) !== '23505') return false;
  return String(e.constraint || '') === UPLOAD_ID_INDEX ||
    String(e.message || '').indexOf(UPLOAD_ID_INDEX) >= 0;
}

/**
 * discardKeys(storage, keys) -> Promise<number deleted>
 * Deletes each stored object, swallowing every error: it runs on the way to
 * answering "already added", and a leftover blob must not turn that into a
 * failure.
 */
async function discardKeys(storage, keys) {
  if (!storage || typeof storage.delete !== 'function') return 0;
  const unique = [];
  for (const k of Array.isArray(keys) ? keys : []) {
    if (k && unique.indexOf(k) < 0) unique.push(k);
  }
  const results = await Promise.all(unique.map(function (k) {
    return Promise.resolve()
      .then(function () { return storage.delete(k); })
      .then(function () { return true; }, function () { return false; });
  }));
  return results.filter(Boolean).length;
}

module.exports = {
  UPLOAD_ID_RE,
  uploadIdFrom,
  findUpload,
  isUploadIdConflict,
  discardKeys,
};
