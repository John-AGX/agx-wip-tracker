// Premium Email Hub — E1 folder API. Mounted at /api/email-folders
// (see server/index.js). Spec: docs/email-hub-premium.md §1.
//
// Ownership model (mirrors the table comment in db.js):
//   * The system spine (Inbox / Triaged + children / Sent / Drafts /
//     Scheduled / Snoozed / Archive / Spam / Trash) is PERSONAL — seeded
//     per user, lazily on first read of the tree, and again by the
//     boot-time backfill. Undeletable, unrenameable, unmovable.
//   * A user's own folders (user_id = caller) are theirs to CRUD.
//   * Org-shared folders (user_id NULL) are visible to the whole org;
//     creating or changing one needs the admin gate, because a rename
//     there changes what every colleague sees.
//
// SCOPING: every query is org-scoped AND user-scoped. Folder ids are
// resolved through services/email-folders.js, which takes the owner
// explicitly — a forged id from another org or another user resolves to
// nothing and returns 404, so it is not an existence oracle. Message
// moves are scoped user_id = req.user.id: the dropbox is personal and is
// excluded from admin act-as by construction (see email-inbox-routes).
// Org tolerance note: email_folders.organization_id is NOT NULL with no
// legacy rows, so these are strict equality checks — no
// "OR-IS-NULL (org tolerance)" clause.

'use strict';

const express = require('express');
const { requireAuth, hasCapability } = require('../auth');
const { callerOrgId } = require('../org-access');
const ef = require('../services/email-folders');

const router = express.Router();

// Mutating an ORG-SHARED folder (user_id NULL) is an admin action — it
// changes the rail for everyone. Same posture as org-tags-routes.
async function isOrgAdmin(req) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'system_admin')) return true;
  return !!(await hasCapability(req.user, 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN'));
}

// Resolve which namespace this request addresses. ?shared=1 (or
// shared:true in the body) targets the org-shared tree; anything else is
// the caller's personal tree. Returns null + sends 403 when the caller
// asks for shared without the admin gate.
async function resolveOwner(req, res, orgId) {
  const wantShared = String(req.query.shared || (req.body && req.body.shared) || '') === '1' ||
                     (req.body && req.body.shared === true);
  if (!wantShared) return { orgId: orgId, userId: req.user.id };
  if (!(await isOrgAdmin(req))) {
    res.status(403).json({ error: 'Only an admin can change org-shared folders' });
    return null;
  }
  return { orgId: orgId, userId: null };
}

// Map a service error (which carries .status) onto a response.
function fail(res, e, fallbackMsg) {
  const status = (e && e.status) || 500;
  if (status >= 500) console.error('[email-folders]', e);
  res.status(status).json({ error: (e && e.message) || fallbackMsg || 'Server error' });
}

// ── GET /api/email-folders ──────────────────────────────────────────
// The whole rail: the caller's personal tree + the org-shared folders,
// flat rows (the client builds the tree from parent_id, same as the file
// Explorer). Lazily seeds the system spine on first view — the same
// pattern file-folders-routes uses for default folders, so a user who
// has never received mail still gets a full rail.
// ?counts=0 skips the per-folder message/unread counts.
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ folders: [], counts: {} });
    let folders = await ef.listFolders(orgId, req.user.id);
    const hasSystem = folders.some(function (f) { return f.system; });
    if (!hasSystem) {
      // Best-effort: a seed failure must never break the (empty) tree.
      try {
        await ef.ensureSystemFolders(orgId, req.user.id);
        folders = await ef.listFolders(orgId, req.user.id);
      } catch (seedErr) {
        console.error('[email-folders] seed failed (non-fatal):', seedErr && seedErr.message);
      }
    }
    let counts = {};
    if (String(req.query.counts || '1') !== '0') {
      try { counts = await ef.folderCounts(req.user.id); } catch (e) { counts = {}; }
    }
    res.json({ folders: folders, counts: counts });
  } catch (e) {
    fail(res, e);
  }
});

// ── POST /api/email-folders ─────────────────────────────────────────
// Create a folder. Body: { name, parent_id?, icon?, color?, sort?,
// shared? }. kind is forced to 'custom' by the service — the spine is
// seeded, never POSTed.
router.post('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const b = req.body || {};
    if (typeof b.name !== 'string' || !b.name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const owner = await resolveOwner(req, res, orgId);
    if (!owner) return;
    const folder = await ef.createFolder(owner, b, { createdBy: req.user.id });
    res.json({ folder: folder });
  } catch (e) {
    fail(res, e, 'Could not create folder');
  }
});

// ── POST /api/email-folders/reorder ─────────────────────────────────
// Body: { ids: [folderId, ...] } — the desired display order; each is
// restamped sort = (index+1)*10. Declared BEFORE /:id so 'reorder' is
// never swallowed as a folder id.
router.post('/reorder', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const b = req.body || {};
    if (!Array.isArray(b.ids) || !b.ids.length) {
      return res.status(400).json({ error: 'ids[] is required' });
    }
    const owner = await resolveOwner(req, res, orgId);
    if (!owner) return;
    const reordered = await ef.reorderFolders(owner, b.ids);
    res.json({ ok: true, reordered: reordered });
  } catch (e) {
    fail(res, e, 'Could not reorder folders');
  }
});

// ── POST /api/email-folders/move-messages ───────────────────────────
// The move-message endpoint. Body: { ids: [messageId, ...] and/or
// thread_ids: [...], folder_id }. folder_id null re-files to the caller's
// Inbox rather than orphaning the mail. Only the caller's OWN messages
// move (user_id = req.user.id), and the target must be their folder or an
// org-shared one in their org. Moving by thread moves the whole
// conversation — see the service comment.
router.post('/move-messages', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : []);
    const threadIds = Array.isArray(b.thread_ids) ? b.thread_ids : (b.thread_id ? [b.thread_id] : []);
    const result = await ef.moveMessages(
      { orgId: orgId, userId: req.user.id }, ids, b.folder_id || null, { threadIds: threadIds }
    );
    res.json(Object.assign({ ok: true }, result));
  } catch (e) {
    fail(res, e, 'Could not move messages');
  }
});

// ── POST /api/email-folders/:id/mark-all-read ───────────────────────
// Body: { read?: true } — false marks the folder unread instead. Drives
// the rail's right-click "Mark all read". Only the caller's own mail,
// even when the folder is org-shared. Declared before PATCH/DELETE /:id
// but on its own sub-path, so there is no route shadowing.
router.post('/:id/mark-all-read', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const read = (req.body || {}).read !== false;
    const updated = await ef.markFolderRead({ orgId: orgId, userId: req.user.id }, req.params.id, read);
    res.json({ ok: true, updated: updated, read: read });
  } catch (e) {
    fail(res, e, 'Could not mark the folder read');
  }
});

// ── POST /api/email-folders/backfill ────────────────────────────────
// Re-run the "nothing is orphaned" sweep for the CALLER's mailbox only:
// seeds any missing system folders, then files every folder-less message
// into Sent (direction='outbound') or Inbox. Idempotent — messages the
// user has since moved are untouched (it only fills folder_id IS NULL).
router.post('/backfill', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const result = await ef.backfill({ orgId: orgId, userId: req.user.id });
    res.json(Object.assign({ ok: !result.error }, result));
  } catch (e) {
    fail(res, e, 'Backfill failed');
  }
});

// ── PATCH /api/email-folders/:id ────────────────────────────────────
// Rename and/or move and/or restyle. Body: any subset of
// { name, parent_id, icon, color, sort }.
// SYSTEM-FOLDER GUARD: name and parent_id are refused on system rows
// (403, enforced in the service); icon/color/sort stay editable.
// parent_id must be present as a key to move — { parent_id: null } means
// "move to root", which is why hasOwnProperty is the test, not truthiness.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const b = req.body || {};
    const owner = await resolveOwner(req, res, orgId);
    if (!owner) return;

    let folder = await ef.getFolder(owner.orgId, owner.userId, req.params.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    // Move first, then rename: renaming recomputes the path from the
    // (possibly new) parent, so this order needs only one repath pass.
    if (Object.prototype.hasOwnProperty.call(b, 'parent_id')) {
      folder = await ef.moveFolder(owner, folder.id, b.parent_id || null);
    }
    if (typeof b.name === 'string' && b.name.trim()) {
      folder = await ef.renameFolder(owner, folder.id, b.name);
    }
    const style = {};
    ['icon', 'color', 'sort'].forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(b, k)) style[k] = b[k];
    });
    if (Object.keys(style).length) {
      folder = await ef.styleFolder(owner, folder.id, style);
    }
    res.json({ ok: true, folder: folder });
  } catch (e) {
    fail(res, e, 'Could not update folder');
  }
});

// ── DELETE /api/email-folders/:id ───────────────────────────────────
// Delete a folder + its subtree. SYSTEM-FOLDER GUARD: 403 on system rows.
// Mail is never destroyed — every message in the subtree is re-filed to
// its owner's Inbox first (an org-shared folder can hold several users'
// mail, so each goes to their own Inbox).
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const owner = await resolveOwner(req, res, orgId);
    if (!owner) return;
    const result = await ef.deleteFolder(owner, req.params.id);
    res.json(Object.assign({ ok: true }, result));
  } catch (e) {
    fail(res, e, 'Could not delete folder');
  }
});

module.exports = router;
