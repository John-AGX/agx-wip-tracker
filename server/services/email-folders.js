// Premium Email Hub — E1, the folder spine (docs/email-hub-premium.md §1).
//
// Folders are EXCLUSIVE: one per message. A folder is a row in
// email_folders with a self-referential parent_id and a materialized
// `path`, deliberately mirroring services/file-folders.js so the Explorer
// tree component (js/file-explorer.js) can be reused for the folder rail.
//
// The two differences from file_folders, both consequences of mail being
// personal rather than entity-scoped:
//   * ownership is (organization_id, user_id) instead of (entity_type,
//     entity_id). user_id NULL = an org-shared folder.
//   * `path` is a chain of SLUGS, not display names, so a folder can be
//     called "Bids / RFQs" or "Subs & Vendors" without the '/' and '&'
//     wrecking the path.
//
// SECURITY: this module does NOT authorize. Callers (routes) must have
// resolved the owner (orgId, userId) from the authenticated request
// first — every function takes that owner explicitly and scopes to it,
// but nothing here checks WHO is asking. It only does tree bookkeeping.

'use strict';

const crypto = require('crypto');
const { pool } = require('../db');

function newFolderId() {
  return 'efld_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

const MAX_DEPTH = 8;
const MAX_FOLDERS_PER_OWNER = 500;

// ── The system spine ────────────────────────────────────────────────
// Auto-seeded per user, undeletable, unrenameable. `parent` names the
// slug of the parent system folder (Triaged's auto-children). `kind` is
// the semantic role the rest of the hub keys behavior off; the Triaged
// children share kind 'triage_bucket' and are the targets the existing
// Haiku triage (services/email-triage.js) will file into in E4.
//
// sort leaves gaps of 10 so a future folder can slot between two without
// renumbering the world.
//
// The slugs here are FIXED CONSTANTS, not slugify(name) output — they are
// the stable identifiers the rest of the app addresses ('sent', 'inbox',
// 'subs-vendors'). Renaming a display name must never move a slug, and
// three of them deliberately differ from what slugify would produce
// ('subs-vendors' not 'subs-and-vendors', etc.). Do not "fix" them.
const SYSTEM_FOLDERS = [
  { slug: 'inbox',     name: 'Inbox',     kind: 'inbox',     sort: 10, icon: 'envelope' },
  { slug: 'triaged',   name: 'Triaged',   kind: 'triaged',   sort: 20, icon: 'funnel' },

  // Triaged auto-children — the Haiku triage categories.
  { slug: 'clients',               name: 'Clients',               kind: 'triage_bucket', sort: 10, icon: 'clients',       parent: 'triaged' },
  { slug: 'subs-vendors',          name: 'Subs & Vendors',        kind: 'triage_bucket', sort: 20, icon: 'subs',          parent: 'triaged' },
  { slug: 'bids-rfqs',             name: 'Bids / RFQs',           kind: 'triage_bucket', sort: 30, icon: 'leads',         parent: 'triaged' },
  { slug: 'invoices-bills',        name: 'Invoices & Bills',      kind: 'triage_bucket', sort: 40, icon: 'banknotes',     parent: 'triaged' },
  { slug: 'scheduling',            name: 'Scheduling',            kind: 'triage_bucket', sort: 50, icon: 'schedule',      parent: 'triaged' },
  { slug: 'permits-inspections',   name: 'Permits & Inspections', kind: 'triage_bucket', sort: 60, icon: 'document-text', parent: 'triaged' },
  { slug: 'insurance-legal',       name: 'Insurance / Legal',     kind: 'triage_bucket', sort: 70, icon: 'id-card',       parent: 'triaged' },
  { slug: 'internal',              name: 'Internal',              kind: 'triage_bucket', sort: 80, icon: 'users',         parent: 'triaged' },
  { slug: 'newsletters',           name: 'Newsletters',           kind: 'triage_bucket', sort: 90, icon: 'globe',         parent: 'triaged' },

  { slug: 'sent',      name: 'Sent',      kind: 'sent',      sort: 30, icon: 'composer-send' },
  { slug: 'drafts',    name: 'Drafts',    kind: 'drafts',    sort: 40, icon: 'edit' },
  { slug: 'scheduled', name: 'Scheduled', kind: 'scheduled', sort: 50, icon: 'schedule' },
  { slug: 'snoozed',   name: 'Snoozed',   kind: 'snoozed',   sort: 60, icon: 'bell' },
  { slug: 'archive',   name: 'Archive',   kind: 'archive',   sort: 70, icon: 'import' },
  { slug: 'spam',      name: 'Spam',      kind: 'spam',      sort: 80, icon: 'detective' },
  // 30-day purge (spec §1) is E2's sweep; E1 only lands the folder.
  { slug: 'trash',     name: 'Trash',     kind: 'trash',     sort: 90, icon: 'delete' },
];

// Every `kind` a system folder can carry. Anything a user creates is
// forced to 'custom' so a hand-crafted POST can't mint a second Inbox
// that the hub would then treat as the real one.
const SYSTEM_KINDS = SYSTEM_FOLDERS.reduce(function (acc, f) {
  if (acc.indexOf(f.kind) === -1) acc.push(f.kind);
  return acc;
}, []);

// ── Normalizers ─────────────────────────────────────────────────────

// Control characters (and DEL) become spaces. A code-point scan rather
// than a regex character class, so the source file carries no literal
// control bytes of its own.
function stripControls(s) {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    out += (c < 32 || c === 127) ? ' ' : s.charAt(i);
  }
  return out;
}

// Display name. Unlike file-folders' sanitizeSegment this KEEPS '/' and
// '&' — the path is built from slugs, so punctuation in a name is
// harmless and "Bids / RFQs" must survive verbatim. Strips control
// characters and collapses whitespace; never empty.
function sanitizeName(raw) {
  var s = stripControls(String(raw == null ? '' : raw))
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || 'Untitled';
}

// URL-safe path segment derived from the display name.
// "Bids / RFQs" → 'bids-rfqs', "Subs & Vendors" → 'subs-vendors'.
function slugify(raw) {
  var s = String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'folder';
}

// '#rrggbb' / '#rgb' chip color, or null to clear. Anything else is
// rejected rather than stored — the value lands in a style attribute.
function normColor(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') return null;
  var c = raw.trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c.toLowerCase() : null;
}

// An agx-icons.js name slug, or null.
function normIcon(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') return null;
  var c = raw.trim().slice(0, 40);
  return /^[a-z0-9-]+$/i.test(c) ? c : null;
}

function q(client) {
  return function (text, params) { return (client || pool).query(text, params); };
}

// The owner predicate every query in this module shares. Personal and
// org-shared folders live in one table, so "mine" means (my org) AND
// (my user_id, or NULL for the shared ones) — expressed as SQL with the
// caller's params appended.
//   ownerWhere(1, 2) → { sql: "organization_id = $1 AND COALESCE(user_id, 0) = $2" }
function ownerClause(orgParam, userParam) {
  return 'organization_id = $' + orgParam + ' AND COALESCE(user_id, 0) = $' + userParam;
}
// user_id is stored NULL for org-shared rows; COALESCE(...,0) is the
// namespace key used by the unique indexes, so callers pass 0 to address
// the shared namespace.
function ownerKey(userId) {
  return (userId == null) ? 0 : Number(userId);
}

// ── Reads ───────────────────────────────────────────────────────────

// One folder by id, scoped to an owner. Returns null when the id belongs
// to another user or another org — a forged id is indistinguishable from
// a missing one.
async function getFolder(orgId, userId, folderId, opts) {
  opts = opts || {};
  const run = q(opts.client);
  if (!folderId) return null;
  const r = await run(
    'SELECT * FROM email_folders WHERE id = $3 AND ' + ownerClause(1, 2) + ' LIMIT 1',
    [Number(orgId), ownerKey(userId), String(folderId)]
  );
  return r.rows[0] || null;
}

// A folder addressable by BOTH namespaces: the caller's personal tree or
// the org-shared tree. This is what a move/file target check needs — a
// user may file mail into a shared folder they didn't create.
async function getFolderForFiling(orgId, userId, folderId, opts) {
  opts = opts || {};
  const run = q(opts.client);
  if (!folderId) return null;
  const r = await run(
    `SELECT * FROM email_folders
      WHERE id = $1 AND organization_id = $2
        AND (user_id = $3 OR user_id IS NULL)
      LIMIT 1`,
    [String(folderId), Number(orgId), Number(userId)]
  );
  return r.rows[0] || null;
}

// The whole rail for one mailbox: the user's personal tree PLUS the
// org-shared folders, flat rows in display order (parents before
// children via `path`). The client assembles the tree from parent_id.
async function listFolders(orgId, userId, opts) {
  opts = opts || {};
  const run = q(opts.client);
  const r = await run(
    `SELECT id, organization_id, user_id, parent_id, name, slug, kind, path,
            sort, icon, color, system, created_at, updated_at
       FROM email_folders
      WHERE organization_id = $1 AND (user_id = $2 OR user_id IS NULL)
      ORDER BY (user_id IS NULL), sort ASC, name ASC`,
    [Number(orgId), Number(userId)]
  );
  return r.rows;
}

// Per-folder message + unread counts for the rail badges. Counts only the
// caller's own mail (the dropbox is personal even when the folder is
// shared). Returned as { folder_id: {total, unread} }.
async function folderCounts(userId, opts) {
  opts = opts || {};
  const run = q(opts.client);
  const r = await run(
    `SELECT folder_id,
            COUNT(*)::int                                 AS total,
            (COUNT(*) FILTER (WHERE is_read = FALSE))::int AS unread
       FROM inbound_emails
      WHERE user_id = $1 AND folder_id IS NOT NULL
      GROUP BY folder_id`,
    [Number(userId)]
  );
  const out = {};
  r.rows.forEach(function (row) { out[row.folder_id] = { total: row.total, unread: row.unread }; });
  return out;
}

// The id of a system folder by slug for one owner (e.g. 'inbox').
async function systemFolderId(orgId, userId, slug, opts) {
  opts = opts || {};
  const run = q(opts.client);
  const r = await run(
    `SELECT id FROM email_folders
      WHERE organization_id = $1 AND user_id = $2 AND system AND LOWER(slug) = $3
      LIMIT 1`,
    [Number(orgId), Number(userId), String(slug).toLowerCase()]
  );
  return r.rows[0] ? r.rows[0].id : null;
}

// ── Seeding ─────────────────────────────────────────────────────────

// Create the system spine for one user. Idempotent and concurrency-safe:
// every insert is ON CONFLICT DO NOTHING against
// uq_email_folders_system_slug, so two boots (or two requests) racing
// converge on one set of rows. Returns the number actually inserted.
//
// Seeds PERSONAL folders (user_id = userId) — the mailbox is personal, so
// each user gets their own Inbox/Sent/Trash. Never seeds into the shared
// (user_id NULL) namespace.
async function ensureSystemFolders(orgId, userId, opts) {
  opts = opts || {};
  const run = q(opts.client);
  if (!orgId || !userId) return 0;
  const org = Number(orgId);
  const uid = Number(userId);

  // Existing spine → slug:id, so a re-run resolves parents without
  // re-inserting and a partially-seeded owner is completed rather than
  // duplicated.
  const have = await run(
    'SELECT id, slug FROM email_folders WHERE organization_id = $1 AND user_id = $2 AND system',
    [org, uid]
  );
  const bySlug = {};
  have.rows.forEach(function (r) { bySlug[String(r.slug).toLowerCase()] = r.id; });

  let created = 0;
  // SYSTEM_FOLDERS lists parents before their children, so one pass
  // resolves every parent_id.
  for (const spec of SYSTEM_FOLDERS) {
    if (bySlug[spec.slug]) continue;
    const parentId = spec.parent ? (bySlug[spec.parent] || null) : null;
    // A child whose parent failed to resolve would silently land at root;
    // skip it instead and let the next run place it correctly.
    if (spec.parent && !parentId) continue;
    const path = spec.parent ? (spec.parent + '/' + spec.slug) : spec.slug;
    const id = newFolderId();
    await run(
      `INSERT INTO email_folders
         (id, organization_id, user_id, parent_id, name, slug, kind, path, sort, icon, system)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
       ON CONFLICT DO NOTHING`,
      [id, org, uid, parentId, spec.name, spec.slug, spec.kind, path, spec.sort, spec.icon || null]
    );
    // Re-read rather than trusting the insert: on a lost race the row
    // exists with the WINNER's id, and children must point at that one.
    const back = await run(
      `SELECT id FROM email_folders
        WHERE organization_id = $1 AND user_id = $2 AND system AND LOWER(slug) = $3 LIMIT 1`,
      [org, uid, spec.slug]
    );
    if (back.rows[0]) {
      bySlug[spec.slug] = back.rows[0].id;
      if (back.rows[0].id === id) created++;
    }
  }
  return created;
}

// ── Mutations ───────────────────────────────────────────────────────

// Create a user folder. kind is always 'custom' — the system spine is
// seeded, never POSTed. Returns the row.
// owner: { orgId, userId } — userId null creates an ORG-SHARED folder.
async function createFolder(owner, input, opts) {
  opts = opts || {};
  const run = q(opts.client);
  const org = Number(owner.orgId);
  const uid = owner.userId == null ? null : Number(owner.userId);
  const name = sanitizeName(input.name);
  const parentId = input.parent_id || null;

  let parentPath = '';
  if (parentId) {
    const p = await getFolder(org, uid, parentId, { client: opts.client });
    if (!p) { const e = new Error('Parent folder not found'); e.status = 404; throw e; }
    parentPath = p.path || '';
    if (parentPath.split('/').filter(Boolean).length >= MAX_DEPTH) {
      const e = new Error('Maximum folder depth reached'); e.status = 400; throw e;
    }
  }

  const count = await run(
    'SELECT COUNT(*)::int AS c FROM email_folders WHERE ' + ownerClause(1, 2),
    [org, ownerKey(uid)]
  );
  if (count.rows[0].c >= MAX_FOLDERS_PER_OWNER) {
    const e = new Error('Folder limit reached'); e.status = 400; throw e;
  }

  // Slug uniqueness is per-parent; suffix until free so two differently
  // named folders ("Bids / RFQs" and "Bids & RFQs") can coexist.
  const base = slugify(name);
  let slug = base;
  for (let n = 2; n < 100; n++) {
    const taken = await run(
      'SELECT 1 FROM email_folders WHERE ' + ownerClause(1, 2) +
      "  AND COALESCE(parent_id, '') = COALESCE($3, '') AND LOWER(slug) = $4 LIMIT 1",
      [org, ownerKey(uid), parentId, slug]
    );
    if (!taken.rows.length) break;
    slug = base.slice(0, 55) + '-' + n;
  }

  const sortRow = await run(
    'SELECT COALESCE(MAX(sort), 0) + 10 AS next FROM email_folders WHERE ' + ownerClause(1, 2) +
    "  AND COALESCE(parent_id, '') = COALESCE($3, '')",
    [org, ownerKey(uid), parentId]
  );
  const sort = (input.sort == null) ? sortRow.rows[0].next : Math.max(0, parseInt(input.sort, 10) || 0);
  const path = parentPath ? (parentPath + '/' + slug) : slug;
  const id = newFolderId();

  try {
    const r = await run(
      `INSERT INTO email_folders
         (id, organization_id, user_id, parent_id, name, slug, kind, path, sort, icon, color, system, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'custom',$7,$8,$9,$10,FALSE,$11)
       RETURNING *`,
      [id, org, uid, parentId, name, slug, path, sort,
       normIcon(input.icon), normColor(input.color), opts.createdBy || null]
    );
    return r.rows[0];
  } catch (e) {
    // uq_email_folders_name — a folder with this display name already
    // sits here. Surfaced as a 409 so the client can offer a rename.
    if (e && e.code === '23505') {
      const dup = new Error('A folder with that name already exists here');
      dup.status = 409;
      throw dup;
    }
    throw e;
  }
}

// Rewrite `path` for a subtree after its root moved or was renamed.
// Mirrors file-folders' prefix-substring update.
async function repathSubtree(run, org, ownerId, oldPath, newPath) {
  if (oldPath === newPath) return;
  await run(
    'UPDATE email_folders' +
    '   SET path = $1 || substring(path from char_length($2) + 1), updated_at = NOW()' +
    ' WHERE ' + ownerClause(3, 4) + ' AND path LIKE $5',
    [newPath, oldPath, org, ownerId, oldPath + '/%']
  );
}

// Rename a folder (same parent). Refuses system folders. Recomputes the
// slug + path for it and every descendant. Returns the updated row.
async function renameFolder(owner, folderId, newName, opts) {
  opts = opts || {};
  const run = q(opts.client);
  const org = Number(owner.orgId);
  const uid = owner.userId == null ? null : Number(owner.userId);
  const cur = await getFolder(org, uid, folderId, { client: opts.client });
  if (!cur) { const e = new Error('Folder not found'); e.status = 404; throw e; }
  if (cur.system) { const e = new Error('System folders cannot be renamed'); e.status = 403; throw e; }

  const name = sanitizeName(newName);
  const base = slugify(name);
  let slug = base;
  for (let n = 2; n < 100; n++) {
    const taken = await run(
      'SELECT 1 FROM email_folders WHERE ' + ownerClause(1, 2) +
      "  AND COALESCE(parent_id, '') = COALESCE($3, '') AND LOWER(slug) = $4 AND id <> $5 LIMIT 1",
      [org, ownerKey(uid), cur.parent_id, slug, cur.id]
    );
    if (!taken.rows.length) break;
    slug = base.slice(0, 55) + '-' + n;
  }

  const oldPath = cur.path || cur.slug;
  const lastSlash = oldPath.lastIndexOf('/');
  const parentPath = lastSlash >= 0 ? oldPath.slice(0, lastSlash) : '';
  const newPath = parentPath ? (parentPath + '/' + slug) : slug;

  let updated;
  try {
    updated = await run(
      'UPDATE email_folders SET name = $1, slug = $2, path = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
      [name, slug, newPath, cur.id]
    );
  } catch (e) {
    if (e && e.code === '23505') {
      const dup = new Error('A folder with that name already exists here');
      dup.status = 409;
      throw dup;
    }
    throw e;
  }
  await repathSubtree(run, org, ownerKey(uid), oldPath, newPath);
  return updated.rows[0];
}

// Move a folder under a new parent (null = root). Cycle-guarded, refuses
// system folders, recomputes the subtree paths. Returns the updated row.
async function moveFolder(owner, folderId, newParentId, opts) {
  opts = opts || {};
  const run = q(opts.client);
  const org = Number(owner.orgId);
  const uid = owner.userId == null ? null : Number(owner.userId);
  const cur = await getFolder(org, uid, folderId, { client: opts.client });
  if (!cur) { const e = new Error('Folder not found'); e.status = 404; throw e; }
  if (cur.system) { const e = new Error('System folders cannot be moved'); e.status = 403; throw e; }

  const oldPath = cur.path || cur.slug;
  let parentPath = '';
  const target = newParentId || null;
  if (target) {
    if (target === cur.id) { const e = new Error('Cannot move a folder into itself'); e.status = 400; throw e; }
    const p = await getFolder(org, uid, target, { client: opts.client });
    if (!p) { const e = new Error('Target folder not found'); e.status = 404; throw e; }
    parentPath = p.path || p.slug;
    // Cycle guard: the target must not be the node or one of its
    // descendants (path prefix is the cheap descendant test).
    if (parentPath === oldPath || parentPath.indexOf(oldPath + '/') === 0) {
      const e = new Error('Cannot move a folder into its own subtree'); e.status = 400; throw e;
    }
    // Depth: the target's depth plus this subtree's own height must fit.
    const targetDepth = parentPath.split('/').filter(Boolean).length;
    const deepest = await run(
      'SELECT MAX(array_length(string_to_array(path, \'/\'), 1))::int AS d' +
      '  FROM email_folders WHERE ' + ownerClause(1, 2) + ' AND (path = $3 OR path LIKE $4)',
      [org, ownerKey(uid), oldPath, oldPath + '/%']
    );
    const ownHeight = (deepest.rows[0] && deepest.rows[0].d ? deepest.rows[0].d : 1) -
                      oldPath.split('/').filter(Boolean).length + 1;
    if (targetDepth + ownHeight > MAX_DEPTH) {
      const e = new Error('Maximum folder depth reached'); e.status = 400; throw e;
    }
  }

  const newPath = parentPath ? (parentPath + '/' + cur.slug) : cur.slug;
  let updated;
  try {
    updated = await run(
      'UPDATE email_folders SET parent_id = $1, path = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [target, newPath, cur.id]
    );
  } catch (e) {
    if (e && e.code === '23505') {
      const dup = new Error('A folder with that name already exists in the target');
      dup.status = 409;
      throw dup;
    }
    throw e;
  }
  await repathSubtree(run, org, ownerKey(uid), oldPath, newPath);
  return updated.rows[0];
}

// Reorder siblings. `ids` is the desired order; each is restamped
// sort = (index + 1) * 10. Ids not owned by the caller are ignored
// rather than erroring, so a stale client list can't 500 the drag.
// System folders ARE reorderable (only rename/move/delete are barred).
// Returns the count restamped.
async function reorderFolders(owner, ids, opts) {
  opts = opts || {};
  const run = q(opts.client);
  const org = Number(owner.orgId);
  const uid = owner.userId == null ? null : Number(owner.userId);
  const list = (Array.isArray(ids) ? ids : []).filter(function (x) { return typeof x === 'string' && x; }).slice(0, MAX_FOLDERS_PER_OWNER);
  if (!list.length) return 0;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const r = await run(
      'UPDATE email_folders SET sort = $1, updated_at = NOW() WHERE id = $2 AND ' + ownerClause(3, 4),
      [(i + 1) * 10, list[i], org, ownerKey(uid)]
    );
    n += r.rowCount;
  }
  return n;
}

// Update the cosmetics (icon / color). Allowed on system folders — the
// guard is about identity and structure, not appearance.
async function styleFolder(owner, folderId, patch, opts) {
  opts = opts || {};
  const run = q(opts.client);
  const org = Number(owner.orgId);
  const uid = owner.userId == null ? null : Number(owner.userId);
  const cur = await getFolder(org, uid, folderId, { client: opts.client });
  if (!cur) { const e = new Error('Folder not found'); e.status = 404; throw e; }
  const sets = [];
  const vals = [];
  let pn = 1;
  if (Object.prototype.hasOwnProperty.call(patch, 'icon')) {
    sets.push('icon = $' + (pn++)); vals.push(normIcon(patch.icon));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
    sets.push('color = $' + (pn++)); vals.push(normColor(patch.color));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'sort')) {
    sets.push('sort = $' + (pn++)); vals.push(Math.max(0, parseInt(patch.sort, 10) || 0));
  }
  if (!sets.length) return cur;
  sets.push('updated_at = NOW()');
  vals.push(cur.id);
  const r = await run(
    'UPDATE email_folders SET ' + sets.join(', ') + ' WHERE id = $' + pn + ' RETURNING *',
    vals
  );
  return r.rows[0];
}

// Delete a folder. Refuses system folders. Messages in it AND in every
// descendant are re-filed to the owner's Inbox first — mail is never
// destroyed by a folder delete (same contract as file-folders unfiling
// attachments to root). Subfolders cascade via the parent_id FK.
// Returns { deleted:true, refiled:<n> }.
async function deleteFolder(owner, folderId, opts) {
  opts = opts || {};
  const run = q(opts.client);
  const org = Number(owner.orgId);
  const uid = owner.userId == null ? null : Number(owner.userId);
  const cur = await getFolder(org, uid, folderId, { client: opts.client });
  if (!cur) { const e = new Error('Folder not found'); e.status = 404; throw e; }
  if (cur.system) { const e = new Error('System folders cannot be deleted'); e.status = 403; throw e; }

  const path = cur.path || cur.slug;
  // Every folder id in the doomed subtree.
  const subtree = await run(
    'SELECT id FROM email_folders WHERE ' + ownerClause(1, 2) + ' AND (path = $3 OR path LIKE $4)',
    [org, ownerKey(uid), path, path + '/%']
  );
  const ids = subtree.rows.map(function (r) { return r.id; });

  // Re-file to Inbox. An ORG-SHARED folder can hold several users' mail,
  // so each affected user's messages go to THAT user's own Inbox — hence
  // the correlated subquery rather than one resolved id.
  let refiled = 0;
  if (ids.length) {
    const r = await run(
      `UPDATE inbound_emails e
          SET folder_id = (
                SELECT f.id FROM email_folders f
                 WHERE f.organization_id = e.organization_id
                   AND f.user_id = e.user_id
                   AND f.system AND f.slug = 'inbox'
                 LIMIT 1)
        WHERE e.folder_id = ANY($1::text[])`,
      [ids]
    );
    refiled = r.rowCount;
  }
  await run('DELETE FROM email_folders WHERE id = $1', [cur.id]);
  return { deleted: true, refiled: refiled };
}

// Move messages into a folder. STRICTLY the caller's own mail
// (user_id = userId) — the dropbox is personal, so a forged message id
// belonging to someone else simply doesn't match. The target must be the
// caller's own folder or an org-shared one in their org; folderId null
// unfiles to the owner's Inbox rather than leaving mail orphaned.
// Returns { moved, folder_id }.
async function moveMessages(owner, messageIds, folderId, opts) {
  opts = opts || {};
  const run = q(opts.client);
  const org = Number(owner.orgId);
  const uid = Number(owner.userId);
  const ids = (Array.isArray(messageIds) ? messageIds : [])
    .filter(function (x) { return typeof x === 'string' && x; })
    .slice(0, 1000);
  if (!ids.length) { const e = new Error('ids[] is required'); e.status = 400; throw e; }

  let targetId = folderId || null;
  if (targetId) {
    const target = await getFolderForFiling(org, uid, targetId, { client: opts.client });
    if (!target) { const e = new Error('Target folder not found'); e.status = 404; throw e; }
    targetId = target.id;
  } else {
    targetId = await systemFolderId(org, uid, 'inbox', { client: opts.client });
    if (!targetId) {
      await ensureSystemFolders(org, uid, { client: opts.client });
      targetId = await systemFolderId(org, uid, 'inbox', { client: opts.client });
    }
    if (!targetId) { const e = new Error('Inbox folder is missing'); e.status = 500; throw e; }
  }

  const r = await run(
    `UPDATE inbound_emails SET folder_id = $1
      WHERE user_id = $2 AND id = ANY($3::text[])`,
    [targetId, uid, ids]
  );
  return { moved: r.rowCount, folder_id: targetId };
}

// ── Backfill (idempotent; boot-time + an on-demand route) ───────────
// Nothing may be orphaned: every existing message gets a folder. Rows
// already flagged direction='outbound' (a captured copy of the user's own
// reply — see project_86_email_hub) land in Sent; everything else in
// Inbox. Only touches folder_id IS NULL rows, so re-running is a fast
// no-op and a message the user has since moved is never dragged back.
//
// scope: { orgId, userId } limits the sweep to one mailbox (the route);
// omitted, it sweeps every mailbox (boot).
async function backfill(scope) {
  scope = scope || {};
  const out = { mailboxes: 0, seeded: 0, filed_inbox: 0, filed_sent: 0 };
  try {
    const params = [];
    let where = '';
    if (scope.orgId != null && scope.userId != null) {
      params.push(Number(scope.orgId), Number(scope.userId));
      where = ' WHERE organization_id = $1 AND user_id = $2';
    }
    const boxes = await pool.query(
      'SELECT DISTINCT organization_id, user_id FROM inbound_emails' + where,
      params
    );
    for (const box of boxes.rows) {
      if (!box.organization_id || !box.user_id) continue;
      out.mailboxes++;
      out.seeded += await ensureSystemFolders(box.organization_id, box.user_id);
      const inboxId = await systemFolderId(box.organization_id, box.user_id, 'inbox');
      const sentId = await systemFolderId(box.organization_id, box.user_id, 'sent');
      if (sentId) {
        const s = await pool.query(
          `UPDATE inbound_emails SET folder_id = $1
            WHERE user_id = $2 AND folder_id IS NULL AND direction = 'outbound'`,
          [sentId, box.user_id]
        );
        out.filed_sent += s.rowCount;
      }
      if (inboxId) {
        const i = await pool.query(
          `UPDATE inbound_emails SET folder_id = $1
            WHERE user_id = $2 AND folder_id IS NULL`,
          [inboxId, box.user_id]
        );
        out.filed_inbox += i.rowCount;
      }
    }
    if (out.filed_inbox || out.filed_sent || out.seeded) {
      console.log('[email-folders] backfill:', JSON.stringify(out));
    }
  } catch (e) {
    console.error('[email-folders] backfill failed (non-fatal):', e && e.message);
    out.error = (e && e.message) || 'failed';
  }
  return out;
}

// File a freshly-stored inbound message. Called best-effort from
// storeInboundMessage AFTER the insert so a folder problem can never lose
// mail — the message is already durable; the worst case is folder_id NULL,
// which the backfill sweeps up. Returns the folder id or null.
async function fileNewMessage(orgId, userId, messageId, isOutbound) {
  try {
    if (!orgId || !userId || !messageId) return null;
    const slug = isOutbound ? 'sent' : 'inbox';
    let id = await systemFolderId(orgId, userId, slug);
    if (!id) {
      await ensureSystemFolders(orgId, userId);
      id = await systemFolderId(orgId, userId, slug);
    }
    if (!id) return null;
    await pool.query(
      'UPDATE inbound_emails SET folder_id = $1 WHERE id = $2 AND folder_id IS NULL',
      [id, messageId]
    );
    return id;
  } catch (e) {
    console.warn('[email-folders] fileNewMessage failed (message still stored):', e && e.message);
    return null;
  }
}

module.exports = {
  SYSTEM_FOLDERS,
  SYSTEM_KINDS,
  MAX_DEPTH,
  MAX_FOLDERS_PER_OWNER,
  sanitizeName,
  slugify,
  normColor,
  normIcon,
  getFolder,
  getFolderForFiling,
  listFolders,
  folderCounts,
  systemFolderId,
  ensureSystemFolders,
  createFolder,
  renameFolder,
  moveFolder,
  reorderFolders,
  styleFolder,
  deleteFolder,
  moveMessages,
  backfill,
  fileNewMessage,
};
