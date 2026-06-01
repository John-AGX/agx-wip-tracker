// Per-org folder templates (Phase: My Files taxonomy). Lets each
// organization customize the DEFAULT folder set shown for new leads /
// estimates / jobs / clients before any file is uploaded.
//
// Storage: org_folder_templates (organization_id, entity_type UNIQUE
// per org, folders JSONB ordered array). Absence of a row → the entity
// type falls back to the built-in defaults in server/folder-taxonomy.js
// (mirrored client-side in js/folder-taxonomy.js). A present row fully
// REPLACES the defaults for that type.
//
// Endpoints (mounted at /api/folder-templates):
//   GET    /              — effective templates for all 4 entity types
//                            (custom-or-default), + raw custom rows + the
//                            built-in defaults, so the editor can show
//                            "customized vs default" and offer a reset.
//   PUT    /:entityType   — upsert the custom folder list (admin)
//   DELETE /:entityType   — clear the custom row → revert to defaults (admin)
//
// Capability gates:
//   - GET: any authenticated user in the org (the entity Files views
//     read this to render empty buckets).
//   - PUT / DELETE: USERS_MANAGE | ROLES_MANAGE | SYSTEM_ADMIN
//     (same posture as org_tags / org_skill_packs admin).

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, hasCapability } = require('../auth');
const {
  TEMPLATE_ENTITY_TYPES,
  defaultFoldersForEntity,
  sanitizeFolderList
} = require('../folder-taxonomy');

const router = express.Router();

function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  return oid ? Number(oid) : null;
}

async function requireAdmin(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'system_admin')) {
    return next();
  }
  const ok = await hasCapability(req.user, 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN');
  if (ok) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

function normEntityType(raw) {
  const t = String(raw || '').toLowerCase().trim();
  return TEMPLATE_ENTITY_TYPES.indexOf(t) === -1 ? null : t;
}

// GET /api/folder-templates
// Returns, for every taxonomy entity type:
//   - effective:  custom folders if a row exists, else the defaults
//   - custom:     the stored override array, or null when none
//   - defaults:   the built-in default array (so the editor can show
//                 a "reset to default" affordance + diff)
//   - customized: boolean — true when a custom row exists
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const out = {};
    let customRows = [];
    if (orgId) {
      const { rows } = await pool.query(
        'SELECT entity_type, folders, updated_at, updated_by ' +
        '  FROM org_folder_templates WHERE organization_id = $1',
        [orgId]
      );
      customRows = rows;
    }
    const byType = {};
    customRows.forEach(function (r) { byType[r.entity_type] = r; });

    TEMPLATE_ENTITY_TYPES.forEach(function (type) {
      const defaults = defaultFoldersForEntity(type);
      const row = byType[type];
      // A row's presence — not its length — decides "customized". When a
      // custom row exists the org gets exactly what it configured (even
      // an empty list → no default buckets, just the always-appended
      // 'general'). Only the ABSENCE of a row falls back to defaults.
      const custom = row && Array.isArray(row.folders) ? row.folders : null;
      out[type] = {
        effective: custom ? custom.slice() : defaults,
        custom: custom,
        defaults: defaults,
        customized: !!custom,
        updated_at: row ? row.updated_at : null
      };
    });

    res.json({ templates: out });
  } catch (e) {
    console.error('GET /api/folder-templates error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/folder-templates/:entityType
// Body: { folders: [string] }
// Upserts the custom folder list for one entity type in the caller's
// org. Folders are sanitized to the canonical path shape and de-duped
// server-side; 'general' is stripped (always appended at render time).
// Submitting an empty list is allowed (an org that wants NO default
// buckets) — the row still exists so the type counts as "customized".
router.put('/:entityType', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const type = normEntityType(req.params.entityType);
    if (!type) return res.status(400).json({ error: 'Unknown entity_type' });

    const body = req.body || {};
    const folders = sanitizeFolderList(body.folders);

    const { rows } = await pool.query(
      'INSERT INTO org_folder_templates (organization_id, entity_type, folders, updated_by) ' +
      'VALUES ($1, $2, $3::jsonb, $4) ' +
      'ON CONFLICT (organization_id, entity_type) DO UPDATE ' +
      '  SET folders = EXCLUDED.folders, updated_by = EXCLUDED.updated_by, updated_at = NOW() ' +
      'RETURNING entity_type, folders, updated_at',
      [orgId, type, JSON.stringify(folders), req.user.id]
    );

    res.json({
      entity_type: type,
      folders: rows[0].folders,
      defaults: defaultFoldersForEntity(type),
      customized: true,
      updated_at: rows[0].updated_at
    });
  } catch (e) {
    console.error('PUT /api/folder-templates/:entityType error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/folder-templates/:entityType
// Removes the custom row → the entity type reverts to built-in defaults.
router.delete('/:entityType', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const type = normEntityType(req.params.entityType);
    if (!type) return res.status(400).json({ error: 'Unknown entity_type' });

    await pool.query(
      'DELETE FROM org_folder_templates WHERE organization_id = $1 AND entity_type = $2',
      [orgId, type]
    );

    res.json({
      entity_type: type,
      folders: null,
      defaults: defaultFoldersForEntity(type),
      customized: false
    });
  } catch (e) {
    console.error('DELETE /api/folder-templates/:entityType error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
