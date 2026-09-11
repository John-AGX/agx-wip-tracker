// attachment-tags.js — tag normalization + the org tag catalog.
//
// Same reason attachment-entity-access.js is in services/: the payload
// dispatcher's attachment.photo_updates arm writes attachments.tags and must
// normalize them the way PUT /api/attachments/:id does, or the same tag typed
// by 86 and by a human lands in the column in two different shapes.
//
// NOTE ON CASE, because the comment at the old call site was WRONG. It said
// tags are normalized "lowercase, trimmed, deduped". normalizeTagsInput
// PRESERVES the author's case ('Trim Carpentry' stays 'Trim Carpentry') and
// only dedups case-INSENSITIVELY. Cap is 20 entries of 32 chars; a non-string
// entry is dropped.
//
// Moved here VERBATIM from routes/attachment-routes.js.
'use strict';

const { pool } = require('../db');
// Bump the org_tags catalog every time a tag string is added to an
// attachment. Idempotent via the (organization_id, name) UNIQUE
// constraint — INSERT ... ON CONFLICT DO UPDATE bumps use_count for
// existing rows. Best-effort; failures are logged but don't block
// the tag write that triggered them.
async function upsertOrgTags(orgId, tagNames, actorUserId) {
  if (!orgId || !Array.isArray(tagNames) || !tagNames.length) return;
  // Dedupe + clean inside this function so callers don't have to.
  // Preserve case but dedup case-insensitively so a user can't bloat
  // the catalog with "trim", "Trim", "TRIM".
  const seen = new Set();
  const clean = [];
  for (let i = 0; i < tagNames.length; i++) {
    const v = tagNames[i];
    if (typeof v !== 'string') continue;
    const c = v.trim().slice(0, 32);
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(c);
  }
  if (!clean.length) return;
  // Single multi-row INSERT for efficiency. ON CONFLICT targets the
  // case-insensitive expression index (idx_org_tags_ci_name in
  // db.js) so "Trim Carpentry" entered when "trim carpentry" already
  // exists bumps the existing row's use_count rather than creating a
  // dup. The pre-existing case-sensitive UNIQUE(org_id, name) on
  // org_tags also prevents exact dups; the expression index just
  // adds the case-insensitive layer on top.
  const placeholders = clean.map(function(_, i) {
    return '($1, $' + (i + 3) + ', $2)';
  }).join(', ');
  const params = [orgId, actorUserId || null].concat(clean);
  try {
    await pool.query(
      'INSERT INTO org_tags (organization_id, created_by, name) VALUES ' +
      placeholders +
      ' ON CONFLICT (organization_id, (LOWER(name))) DO UPDATE ' +
      '   SET use_count = org_tags.use_count + 1, updated_at = NOW()',
      params
    );
  } catch (e) {
    console.warn('[attachments] org_tags upsert failed:', e.message);
  }
}

// Normalize a tags-input from form-data or JSON body. Accepts:
//   - Array of strings (best — JSON body)
//   - JSON-stringified array (form-data field)
//   - Comma-separated string (mobile fallback)
// Returns a deduped lowercase array, max 20 entries of 32 chars.
function normalizeTagsInput(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try { arr = JSON.parse(trimmed); } catch (e) { arr = []; }
    } else {
      arr = trimmed.split(',');
    }
  }
  // Preserve the user's input case ("Trim Carpentry" stays "Trim
  // Carpentry", not "trim carpentry"). Dedup is case-INSENSITIVE so
  // ["Foo", "foo"] still collapses to one entry — keeping whichever
  // case showed up first.
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length && out.length < 20; i++) {
    const v = arr[i];
    if (typeof v !== 'string') continue;
    const c = v.trim().slice(0, 32);
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

module.exports = { upsertOrgTags, normalizeTagsInput };
