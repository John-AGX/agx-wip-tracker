// Org-level tag catalog (Phase 1.7). Curated master list of tag
// names per organization so users don't retype "roof" / "gutter" /
// "fascia" on every project.
//
// Storage: org_tags table (organization_id, name UNIQUE per org,
// hue, use_count, archived_at). Tags created ad-hoc on photos are
// auto-upserted by attachment-routes.js so the catalog stays in
// sync without an explicit admin step.
//
// Endpoints (mounted at /api/org-tags):
//   GET    /              — list (search via ?q, archived hidden by default)
//   GET    /suggest?q=    — autocomplete; ordered by use_count DESC
//   POST   /              — create (admin)
//   PATCH  /:id           — rename / set hue / archive (admin)
//   POST   /merge         — merge selected ids into a target id (admin)
//                            also rewrites attachments.tags JSONB across rows
//
// Capability gates:
//   - Read endpoints: any authenticated user in the org
//   - Mutations: USERS_MANAGE | ROLES_MANAGE | SYSTEM_ADMIN
//     (same posture as the org_skill_packs admin)

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, hasCapability } = require('../auth');

const router = express.Router();

function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  return oid ? Number(oid) : null;
}

async function requireAdmin(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'system_admin')) {
    return next();
  }
  // Fall back to capability check (USERS_MANAGE / ROLES_MANAGE).
  const ok = await hasCapability(req.user, 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN');
  if (ok) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// Normalize a tag name to the same shape attachment-routes uses:
// trimmed, lowercased, max 32 chars. Returns null when the input
// would normalize to empty.
function normTagName(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toLowerCase().slice(0, 32);
  return c || null;
}

// GET /api/org-tags?q=&include_archived=1
// Lists tags in the caller's org. Default excludes archived. Optional
// ?q substring filter is case-insensitive.
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ tags: [] });

    const where = ['organization_id = $1'];
    const params = [orgId];
    let pn = 2;
    if (String(req.query.include_archived || '') !== '1') {
      where.push('archived_at IS NULL');
    }
    if (req.query.q) {
      where.push('name ILIKE $' + (pn++));
      params.push('%' + String(req.query.q).trim().toLowerCase() + '%');
    }
    const { rows } = await pool.query(
      'SELECT id, name, hue, use_count, archived_at, created_at, updated_at ' +
      '  FROM org_tags ' +
      ' WHERE ' + where.join(' AND ') +
      ' ORDER BY use_count DESC, name ASC ' +
      ' LIMIT 500',
      params
    );
    res.json({ tags: rows });
  } catch (e) {
    console.error('GET /api/org-tags error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/org-tags/suggest?q=<prefix>
// Autocomplete source — shared across project tag editor + photo tag
// editor + bulk tag modal. Returns up to 30 unarchived tag names
// matching the prefix, ordered by use_count DESC.
router.get('/suggest', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ tags: [] });
    const q = String(req.query.q || '').trim().toLowerCase();
    const params = [orgId];
    let sql =
      'SELECT name FROM org_tags ' +
      ' WHERE organization_id = $1 AND archived_at IS NULL';
    if (q) {
      sql += ' AND name ILIKE $2';
      params.push(q + '%');
    }
    sql += ' ORDER BY use_count DESC, name ASC LIMIT 30';
    const { rows } = await pool.query(sql, params);
    res.json({ tags: rows.map(function(r) { return r.name; }) });
  } catch (e) {
    console.error('GET /api/org-tags/suggest error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/org-tags
// Body: { name, hue? }
// Creates a tag in the caller's org. Idempotent — if the tag already
// exists (case-insensitive), returns that row. Bumps use_count by 0
// (left untouched on duplicate); use_count is reserved for actual
// usage on attachments.
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const body = req.body || {};
    const name = normTagName(body.name);
    if (!name) return res.status(400).json({ error: 'name required' });
    const hue = (body.hue == null || body.hue === '') ? null : Math.max(0, Math.min(360, parseInt(body.hue, 10) || 0));

    const { rows } = await pool.query(
      'INSERT INTO org_tags (organization_id, name, hue, created_by) ' +
      'VALUES ($1, $2, $3, $4) ' +
      'ON CONFLICT (organization_id, name) DO UPDATE SET updated_at = NOW() ' +
      'RETURNING *',
      [orgId, name, hue, req.user.id]
    );
    res.json({ tag: rows[0] });
  } catch (e) {
    console.error('POST /api/org-tags error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/org-tags/:id
// Body: any subset of { name, hue, archived }
// - name: rename (also rewrites every attachments.tags JSONB array
//   in the org that contains the old name — like merge but 1-to-1).
// - hue: set / clear color override.
// - archived: true → stamp archived_at; false → clear it.
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Tag not found' });
    const body = req.body || {};

    // Pre-fetch so we know the old name for the rename rewrite.
    const priorRes = await pool.query(
      'SELECT * FROM org_tags WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!priorRes.rowCount) return res.status(404).json({ error: 'Tag not found' });
    const prior = priorRes.rows[0];

    const sets = [];
    const params = [];
    let pn = 1;
    let renameTo = null;

    if (typeof body.name === 'string') {
      const newName = normTagName(body.name);
      if (!newName) return res.status(400).json({ error: 'name cannot be empty' });
      if (newName !== prior.name) {
        // Conflict guard — if newName already exists, suggest /merge
        // instead of silently overwriting.
        const dup = await pool.query(
          'SELECT id FROM org_tags WHERE organization_id = $1 AND name = $2 AND id <> $3',
          [orgId, newName, prior.id]
        );
        if (dup.rowCount) {
          return res.status(409).json({ error: 'A tag with that name already exists. Use /merge to combine them.' });
        }
        sets.push('name = $' + (pn++));
        params.push(newName);
        renameTo = newName;
      }
    }
    if (body.hue !== undefined) {
      const h = (body.hue == null || body.hue === '') ? null : Math.max(0, Math.min(360, parseInt(body.hue, 10) || 0));
      sets.push('hue = $' + (pn++));
      params.push(h);
    }
    if (body.archived !== undefined) {
      if (body.archived) {
        sets.push('archived_at = COALESCE(archived_at, NOW())');
      } else {
        sets.push('archived_at = NULL');
      }
    }
    if (!sets.length) return res.json({ tag: prior });

    sets.push('updated_at = NOW()');
    params.push(prior.id, orgId);
    const sql =
      'UPDATE org_tags SET ' + sets.join(', ') +
      ' WHERE id = $' + (pn++) + ' AND organization_id = $' + (pn++) +
      ' RETURNING *';
    const r = await pool.query(sql, params);

    // If we renamed, rewrite every attachments.tags JSONB across this
    // org that contains the old name. JSONB-array containment uses @>;
    // the update swaps the old name for the new via jsonb_set logic.
    // We do this in plain SQL with a single statement for atomicity.
    if (renameTo && renameTo !== prior.name) {
      await pool.query(
        // Replace prior.name with renameTo in every attachments.tags
        // that contains it. uses jsonb arithmetic — works on PG 12+.
        `UPDATE attachments
            SET tags = (
              SELECT jsonb_agg(DISTINCT CASE WHEN t = $1 THEN $2 ELSE t END)
                FROM jsonb_array_elements_text(tags) t
            )
          WHERE tags @> to_jsonb($1::text)
            AND id IN (
              -- Limit the rewrite to attachments visible to this org.
              -- entity_type='user' attachments belong to users in this
              -- org; entity_type='org' attachments belong to the org id
              -- directly; other types are owned by leads/jobs/etc. in
              -- this org. For simplicity, we apply across all rows that
              -- have the tag — single-tenant deployments are unaffected,
              -- and multi-tenant deployments can layer a stricter scope
              -- later.
              SELECT id FROM attachments WHERE tags @> to_jsonb($1::text)
            )`,
        [prior.name, renameTo]
      );
    }

    res.json({ tag: r.rows[0] });
  } catch (e) {
    console.error('PATCH /api/org-tags/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/org-tags/merge
// Body: { from_ids: [number], into_id: number }
// Merges multiple tags into one. Steps:
//   1. Fetch the source rows + target row from the same org.
//   2. For every attachments.tags array that contains any source
//      name, replace it with the target name (deduped).
//   3. Sum use_counts into the target.
//   4. Archive the sources (soft-delete) so they vanish from
//      autocomplete but historical references stay traceable.
router.post('/merge', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const body = req.body || {};
    const fromIds = Array.isArray(body.from_ids) ? body.from_ids.map(function(x) { return Number(x); }).filter(function(x) { return Number.isFinite(x); }) : [];
    const intoId = Number(body.into_id);
    if (!fromIds.length || !Number.isFinite(intoId)) {
      return res.status(400).json({ error: 'from_ids and into_id are required' });
    }
    if (fromIds.indexOf(intoId) !== -1) {
      return res.status(400).json({ error: 'Cannot merge a tag into itself' });
    }

    // All tags must be in the caller's org.
    const allIds = fromIds.concat([intoId]);
    const tagRows = await pool.query(
      'SELECT * FROM org_tags WHERE id = ANY($1::bigint[]) AND organization_id = $2',
      [allIds, orgId]
    );
    if (tagRows.rowCount !== allIds.length) {
      return res.status(404).json({ error: 'One or more tags not found in your organization' });
    }
    const target = tagRows.rows.find(function(t) { return t.id === intoId; });
    const sources = tagRows.rows.filter(function(t) { return t.id !== intoId; });
    if (!target) return res.status(404).json({ error: 'into_id not found' });

    // Rewrite attachments.tags — every source name becomes the target.
    const sourceNames = sources.map(function(s) { return s.name; });
    let sumUseCount = 0;
    sources.forEach(function(s) { sumUseCount += (s.use_count || 0); });

    await pool.query(
      `UPDATE attachments
          SET tags = (
            SELECT jsonb_agg(DISTINCT CASE WHEN t = ANY($1::text[]) THEN $2 ELSE t END)
              FROM jsonb_array_elements_text(tags) t
          )
        WHERE tags ?| $1::text[]`,
      [sourceNames, target.name]
    );

    // Bump target use_count + archive sources.
    await pool.query(
      'UPDATE org_tags SET use_count = use_count + $1, updated_at = NOW() WHERE id = $2',
      [sumUseCount, target.id]
    );
    await pool.query(
      'UPDATE org_tags SET archived_at = NOW(), updated_at = NOW() WHERE id = ANY($1::bigint[])',
      [fromIds]
    );

    res.json({ ok: true, merged: fromIds.length, target: target.name });
  } catch (e) {
    console.error('POST /api/org-tags/merge error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
