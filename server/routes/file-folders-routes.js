// Folder tree API for the Explorer-style file system. Mounted at
// /api/file-folders (see server/index.js).
//
// Authorization: reuses attachment-routes' per-entity capability + owner/
// org scoping (module.exports.entityAccess) so folders enforce the SAME
// access rules as the files inside them — single source of truth. The
// tree bookkeeping itself lives in services/file-folders.js.

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const ff = require('../services/file-folders');
const { entityAccess } = require('./attachment-routes');

const { entityTypeOk, entityIdOk, readCapForEntity, writeCapForEntity, requireDynamicCapability } = entityAccess;

const router = express.Router();

// Validate the path params up front so a bad entity can't reach the DB.
function checkEntity(req, res) {
  const { entityType, entityId } = req.params;
  if (!entityTypeOk(entityType)) { res.status(400).json({ error: 'Invalid entity_type' }); return false; }
  if (!entityIdOk(entityId)) { res.status(400).json({ error: 'Invalid entity_id' }); return false; }
  return true;
}

// GET /api/file-folders/:entityType/:entityId — the folder tree (flat rows;
// the client assembles the tree from parent_id/path).
router.get('/:entityType/:entityId',
  requireAuth,
  requireDynamicCapability(req => entityTypeOk(req.params.entityType) ? readCapForEntity(req.params.entityType) : null),
  async (req, res) => {
    if (!checkEntity(req, res)) return;
    try {
      const { entityType, entityId } = req.params;
      let folders = await ff.listFolders(entityType, entityId);
      if (!folders.length) {
        // Preload the org's default folder structure the first time an
        // entity's tree is viewed (lead/estimate/job/client only — other
        // types have no taxonomy). Best-effort: a seed failure must never
        // break the (empty) tree response.
        try {
          const orgId = req.user && req.user.organization_id;
          const defaults = await ff.effectiveDefaultFolders(orgId, entityType);
          if (defaults.length) {
            await ff.seedDefaultFolders(entityType, entityId, defaults, {
              organizationId: orgId || null,
              createdBy: (req.user && req.user.id) || null
            });
            folders = await ff.listFolders(entityType, entityId);
          }
        } catch (seedErr) {
          console.error('[file-folders] seed defaults failed (non-fatal):', seedErr && seedErr.message);
        }
      }
      res.json({ folders });
    } catch (e) {
      console.error('GET /api/file-folders error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/file-folders/:entityType/:entityId — create a folder.
// Body: { name, parent_id? }.
router.post('/:entityType/:entityId',
  requireAuth,
  requireDynamicCapability(req => entityTypeOk(req.params.entityType) ? writeCapForEntity(req.params.entityType) : null),
  async (req, res) => {
    if (!checkEntity(req, res)) return;
    try {
      const b = req.body || {};
      const name = (typeof b.name === 'string') ? b.name : '';
      if (!name.trim()) return res.status(400).json({ error: 'name is required' });
      const folder = await ff.createFolder(req.params.entityType, req.params.entityId, b.parent_id || null, name, {
        organizationId: req.user && req.user.organization_id,
        createdBy: req.user && req.user.id
      });
      res.json({ folder });
    } catch (e) {
      console.error('POST /api/file-folders error:', e);
      res.status(400).json({ error: (e && e.message) || 'Could not create folder' });
    }
  }
);

// PATCH /api/file-folders/:entityType/:entityId/:folderId — rename and/or
// move. Body: { name? } and/or { parent_id? } (parent_id null = root).
router.patch('/:entityType/:entityId/:folderId',
  requireAuth,
  requireDynamicCapability(req => entityTypeOk(req.params.entityType) ? writeCapForEntity(req.params.entityType) : null),
  async (req, res) => {
    if (!checkEntity(req, res)) return;
    try {
      const { entityType, entityId, folderId } = req.params;
      const b = req.body || {};
      let path;
      if (Object.prototype.hasOwnProperty.call(b, 'parent_id')) {
        path = await ff.moveFolder(entityType, entityId, folderId, b.parent_id || null);
      }
      if (typeof b.name === 'string' && b.name.trim()) {
        path = await ff.renameFolder(entityType, entityId, folderId, b.name);
      }
      if (path === undefined) return res.status(400).json({ error: 'Nothing to update (provide name and/or parent_id)' });
      res.json({ ok: true, path });
    } catch (e) {
      console.error('PATCH /api/file-folders error:', e);
      res.status(400).json({ error: (e && e.message) || 'Could not update folder' });
    }
  }
);

// DELETE /api/file-folders/:entityType/:entityId/:folderId — delete a
// folder (subfolders cascade; contained files are unfiled to root, never
// destroyed).
router.delete('/:entityType/:entityId/:folderId',
  requireAuth,
  requireDynamicCapability(req => entityTypeOk(req.params.entityType) ? writeCapForEntity(req.params.entityType) : null),
  async (req, res) => {
    if (!checkEntity(req, res)) return;
    try {
      const ok = await ff.deleteFolder(req.params.entityType, req.params.entityId, req.params.folderId);
      if (!ok) return res.status(404).json({ error: 'Folder not found' });
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/file-folders error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/file-folders/:entityType/:entityId/move-files — move files
// between folders WITHIN this bucket. Body: { ids: [string], folder_id|null }.
// folder_id null moves them to the root ('general'). Scoped to this entity
// so a forged id can't touch another record's files.
router.post('/:entityType/:entityId/move-files',
  requireAuth,
  requireDynamicCapability(req => entityTypeOk(req.params.entityType) ? writeCapForEntity(req.params.entityType) : null),
  async (req, res) => {
    if (!checkEntity(req, res)) return;
    try {
      const { entityType, entityId } = req.params;
      const b = req.body || {};
      const ids = Array.isArray(b.ids) ? b.ids.filter(x => typeof x === 'string' && x) : [];
      if (!ids.length) return res.status(400).json({ error: 'ids[] is required' });
      let targetId = b.folder_id || null;
      let targetPath = 'general';
      if (targetId) {
        const f = await pool.query(
          `SELECT path FROM file_folders WHERE id=$1 AND entity_type=$2 AND entity_id=$3`,
          [targetId, entityType, entityId]
        );
        if (!f.rows[0]) return res.status(404).json({ error: 'Target folder not found' });
        targetPath = f.rows[0].path;
      }
      const { rowCount } = await pool.query(
        `UPDATE attachments SET folder_id=$1, folder=$2
           WHERE entity_type=$3 AND entity_id=$4 AND id = ANY($5::text[])`,
        [targetId, targetPath, entityType, entityId, ids]
      );
      res.json({ ok: true, moved: rowCount });
    } catch (e) {
      console.error('POST /api/file-folders/move-files error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
