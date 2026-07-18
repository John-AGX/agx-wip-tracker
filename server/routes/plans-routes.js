// Plans & Takeoffs — first-class scale-drawing documents (the dedicated
// home for the Bluebeam-style markup/measure tool). A plan is a drawing
// surface (blank gridded canvas / photo / PDF) plus its per-page
// calibration + measurement strokes (the `pages` JSONB) and cached
// headline totals (`totals`).
//
// Storage mirrors the markup viewer's annotations shape, but owned by the
// plan row rather than an attachment — so blank canvases and standalone
// takeoffs are first-class. The client computes geometry/totals (it has
// the calibration + stroke math); the server just persists what it sends.
//
// Capability gate: ESTIMATES_VIEW for read, ESTIMATES_EDIT for write —
// takeoffs are an estimating tool, same audience as estimates/clients.
//
// Org scoping: every row carries organization_id; reads/writes filter to
// req.user.organization_id so plan rows never leak across orgs.

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

function newId() {
  return 'plan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  if (!oid) return null;
  return Number(oid);
}

// VALID_ENTITY_TYPES mirror — a plan may link to any of these, or stay
// null (standalone). Kept in sync with attachment-routes VALID_ENTITY_TYPES.
const VALID_ENTITY_TYPES = new Set([
  'lead', 'estimate', 'client', 'job', 'sub', 'user', 'org', 'project', 'task'
]);

const BASE_KINDS = new Set(['blank', 'sheet', 'photo', 'pdf']);

// Coerce the `pages` payload to a safe JSONB-able array. Each page is
// { page:int, calibration:obj|null, strokes:[...] }. We don't deeply
// validate stroke shapes (the client owns that + the renderer is
// defensive), but we cap sizes so a runaway payload can't bloat a row.
function sanitizePages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).map(function (pg, i) {
    pg = pg || {};
    // Sheet-doc (CAD shop-drawing) entries are a different shape than the
    // markup {page,calibration,strokes} pages — pass them through (with
    // light size caps) instead of coercing, which would strip the doc.
    if (pg.kind === 'sheet-doc') {
      const out = {
        kind: 'sheet-doc',
        version: Number.isFinite(pg.version) ? (pg.version | 0) : 1,
        sheet: (pg.sheet && typeof pg.sheet === 'object') ? pg.sheet : {},
        titleblock: (pg.titleblock && typeof pg.titleblock === 'object') ? pg.titleblock : {},
        layers: Array.isArray(pg.layers) ? pg.layers.slice(0, 200) : [],
        viewports: Array.isArray(pg.viewports) ? pg.viewports.slice(0, 50) : [],
        entities: Array.isArray(pg.entities) ? pg.entities.slice(0, 20000) : []
      };
      // CRITICAL: v2/v3 docs store the drawing under model/sheets (serializeDoc
      // DELETES the flat entities/layers/viewports above before sending) —
      // dropping these fields silently gutted every saved CAD sheet: the plan
      // reloaded EMPTY. Pass them through with the same size caps.
      // Pass model through WHOLE (caps only, no field whitelist) — a
      // whitelist here is exactly what caused the data loss.
      if (pg.model && typeof pg.model === 'object') {
        out.model = Object.assign({}, pg.model, {
          entities: Array.isArray(pg.model.entities) ? pg.model.entities.slice(0, 20000) : []
        });
      }
      if (Array.isArray(pg.sheets)) out.sheets = pg.sheets.slice(0, 50);
      if (pg.activeSheetId != null) out.activeSheetId = String(pg.activeSheetId);
      if (pg.space === 'sheet' || pg.space === 'model') out.space = pg.space;
      if (pg.underlay && typeof pg.underlay === 'object') out.underlay = pg.underlay;
      return out;
    }
    return {
      page: Number.isFinite(pg.page) ? (pg.page | 0) : i,
      calibration: (pg.calibration && typeof pg.calibration === 'object') ? pg.calibration : null,
      strokes: Array.isArray(pg.strokes) ? pg.strokes.slice(0, 5000) : []
    };
  });
}

function sanitizeTotals(raw) {
  raw = raw || {};
  const num = function (v) { return Number.isFinite(v) ? v : 0; };
  return { lf: num(raw.lf), sf: num(raw.sf), count: num(raw.count) };
}

// Fields the PATCH route accepts. JSONB columns (pages, totals) are
// handled specially below; the rest are plain scalar assignments.
const EDITABLE_SCALAR = new Set([
  'name', 'base_kind', 'base_attachment_id',
  'width', 'height', 'grid_spacing', 'thumb_url',
  'entity_type', 'entity_id'
]);

// ──────────────────────────────────────────────────────────────────
// GET /api/plans
//   q           — substring search on name (case-insensitive)
//   entity_type — filter to plans linked to this entity type
//   entity_id   — filter to plans linked to this entity id
//   status      — 'active' | 'archived' | 'all' (default 'active')
//   limit       — max 200 (default 100)
// Returns { plans: [{ id, name, base_kind, totals, entity_type, ... }] }
router.get('/', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ plans: [] });

    const where = ['p.organization_id = $1'];
    const params = [orgId];
    let pn = 2;

    const status = String(req.query.status || 'active').trim();
    if (status === 'active') where.push('p.archived_at IS NULL');
    else if (status === 'archived') where.push('p.archived_at IS NOT NULL');

    if (req.query.q) {
      where.push('p.name ILIKE $' + (pn++));
      params.push('%' + String(req.query.q).trim() + '%');
    }
    if (req.query.entity_type && req.query.entity_id) {
      where.push('p.entity_type = $' + (pn++));
      params.push(String(req.query.entity_type));
      where.push('p.entity_id = $' + (pn++));
      params.push(String(req.query.entity_id));
    }

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));

    // Hydrate the base attachment's preview (for photo/pdf plans) and the
    // author name. pages is excluded from the list query to keep it light
    // — the detail GET returns the full pages payload.
    const sql =
      'SELECT p.id, p.name, p.base_kind, p.base_attachment_id, p.width, p.height, ' +
      '       p.grid_spacing, p.totals, p.entity_type, p.entity_id, p.thumb_url, ' +
      '       p.created_by, p.created_at, p.updated_at, p.archived_at, ' +
      '       jsonb_array_length(p.pages) AS page_count, ' +
      '       ba.thumb_url AS base_thumb_url, ba.web_url AS base_web_url, ' +
      '       ba.filename  AS base_filename, ' +
      '       u.name       AS created_by_name ' +
      '  FROM plans p ' +
      '  LEFT JOIN attachments ba ON ba.id = p.base_attachment_id ' +
      '  LEFT JOIN users u ON u.id = p.created_by ' +
      ' WHERE ' + where.join(' AND ') +
      ' ORDER BY p.updated_at DESC ' +
      ' LIMIT ' + limit;

    const { rows } = await pool.query(sql, params);
    res.json({ plans: rows });
  } catch (e) {
    console.error('GET /api/plans error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/plans/:id — full plan incl. the pages payload.
router.get('/:id', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Plan not found' });
    const { rows } = await pool.query(
      'SELECT p.*, ' +
      '       ba.thumb_url AS base_thumb_url, ba.web_url AS base_web_url, ' +
      '       ba.original_url AS base_original_url, ba.filename AS base_filename, ' +
      '       ba.mime_type AS base_mime_type, ' +
      '       u.name AS created_by_name ' +
      '  FROM plans p ' +
      '  LEFT JOIN attachments ba ON ba.id = p.base_attachment_id ' +
      '  LEFT JOIN users u ON u.id = p.created_by ' +
      ' WHERE p.id = $1 AND p.organization_id = $2',
      [req.params.id, orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' });
    res.json({ plan: rows[0] });
  } catch (e) {
    console.error('GET /api/plans/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/plans
// Body: { name?, base_kind?, base_attachment_id?, width?, height?,
//   grid_spacing?, pages?, totals?, entity_type?, entity_id?, thumb_url? }
router.post('/', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const body = req.body || {};

    const name = (typeof body.name === 'string' && body.name.trim())
      ? body.name.trim().slice(0, 200)
      : 'Untitled plan';
    const baseKind = BASE_KINDS.has(body.base_kind) ? body.base_kind : 'blank';
    const baseAttachmentId = (typeof body.base_attachment_id === 'string' && body.base_attachment_id)
      ? body.base_attachment_id : null;
    const width = Number.isFinite(body.width) ? (body.width | 0) : null;
    const height = Number.isFinite(body.height) ? (body.height | 0) : null;
    const grid = Number.isFinite(body.grid_spacing) ? (body.grid_spacing | 0) : 40;
    const pages = sanitizePages(body.pages);
    const totals = sanitizeTotals(body.totals);
    const thumbUrl = (typeof body.thumb_url === 'string') ? body.thumb_url.slice(0, 2000) : null;

    let entityType = null, entityId = null;
    if (body.entity_type && body.entity_id &&
        VALID_ENTITY_TYPES.has(String(body.entity_type))) {
      entityType = String(body.entity_type);
      entityId = String(body.entity_id);
    }

    const id = newId();
    const { rows } = await pool.query(
      'INSERT INTO plans (id, organization_id, name, base_kind, base_attachment_id, ' +
      '  width, height, grid_spacing, pages, totals, entity_type, entity_id, thumb_url, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14) RETURNING *',
      [id, orgId, name, baseKind, baseAttachmentId, width, height, grid,
       JSON.stringify(pages), JSON.stringify(totals), entityType, entityId, thumbUrl,
       (req.user && req.user.id) || null]
    );
    res.status(201).json({ plan: rows[0] });
  } catch (e) {
    console.error('POST /api/plans error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/plans/:id — update editable fields. pages/totals are JSONB.
router.patch('/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Plan not found' });
    const body = req.body || {};

    // Version snapshot: when drawing content is about to be overwritten,
    // keep a restore point of the CURRENT row. Throttled (>=10 min since
    // the last snapshot) so the 2.5s autosave doesn't flood; last 30 kept.
    // Best-effort — a snapshot failure must never block the save itself.
    if (Object.prototype.hasOwnProperty.call(body, 'pages')) {
      try {
        const ins = await pool.query(
          'INSERT INTO plan_versions (plan_id, organization_id, name, pages, totals, created_by) ' +
          'SELECT p.id, p.organization_id, p.name, p.pages, p.totals, $3 FROM plans p ' +
          ' WHERE p.id = $1 AND p.organization_id = $2 ' +
          "   AND NOT EXISTS (SELECT 1 FROM plan_versions v WHERE v.plan_id = p.id " +
          "        AND v.created_at > NOW() - INTERVAL '10 minutes')",
          [req.params.id, orgId, (req.user && req.user.id) || null]
        );
        // Prune only when a snapshot was actually taken (skips the two extra
        // statements on every throttled autosave) and stay org-scoped.
        if (ins.rowCount > 0) {
          await pool.query(
            'DELETE FROM plan_versions WHERE plan_id = $1 AND organization_id = $2 AND id NOT IN ' +
            ' (SELECT id FROM plan_versions WHERE plan_id = $1 ORDER BY created_at DESC LIMIT 30)',
            [req.params.id, orgId]
          );
        }
      } catch (ve) { console.warn('plan_versions snapshot failed (non-fatal):', ve.message); }
    }

    const sets = [];
    const params = [];
    let pn = 1;

    Object.keys(body).forEach(function (k) {
      if (!EDITABLE_SCALAR.has(k)) return;
      // Validate the constrained scalars; drop bad values rather than 400.
      if (k === 'base_kind' && !BASE_KINDS.has(body[k])) return;
      if (k === 'entity_type' && body[k] != null && !VALID_ENTITY_TYPES.has(String(body[k]))) return;
      sets.push(k + ' = $' + (pn++));
      params.push(body[k]);
    });
    if (Object.prototype.hasOwnProperty.call(body, 'pages')) {
      sets.push('pages = $' + (pn++) + '::jsonb');
      params.push(JSON.stringify(sanitizePages(body.pages)));
    }
    if (Object.prototype.hasOwnProperty.call(body, 'totals')) {
      sets.push('totals = $' + (pn++) + '::jsonb');
      params.push(JSON.stringify(sanitizeTotals(body.totals)));
    }
    if (!sets.length) return res.status(400).json({ error: 'No editable fields supplied' });

    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    params.push(orgId);
    const sql = 'UPDATE plans SET ' + sets.join(', ') +
      ' WHERE id = $' + (pn++) + ' AND organization_id = $' + (pn++) + ' RETURNING *';
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' });
    res.json({ plan: rows[0] });
  } catch (e) {
    console.error('PATCH /api/plans/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/plans/:id — soft archive (set archived_at). Pass ?hard=1 to
// permanently delete (rarely needed; kept symmetric with other surfaces).
router.delete('/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Plan not found' });
    if (String(req.query.hard || '') === '1') {
      const r = await pool.query(
        'DELETE FROM plans WHERE id = $1 AND organization_id = $2',
        [req.params.id, orgId]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Plan not found' });
      return res.json({ ok: true, deleted: true });
    }
    const { rows } = await pool.query(
      'UPDATE plans SET archived_at = NOW(), updated_at = NOW() ' +
      ' WHERE id = $1 AND organization_id = $2 RETURNING id',
      [req.params.id, orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' });
    res.json({ ok: true, archived: true });
  } catch (e) {
    console.error('DELETE /api/plans/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/plans/:id/versions — restore points, newest first (meta only;
// the pages payload stays server-side until a restore).
router.get('/:id/versions', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ versions: [] });
    const { rows } = await pool.query(
      'SELECT v.id, v.name, v.created_at, u.name AS created_by_name, ' +
      '       jsonb_array_length(v.pages) AS page_count ' +
      '  FROM plan_versions v ' +
      '  LEFT JOIN users u ON u.id = v.created_by ' +
      ' WHERE v.plan_id = $1 AND v.organization_id = $2 ' +
      ' ORDER BY v.created_at DESC LIMIT 50',
      [req.params.id, orgId]
    );
    res.json({ versions: rows });
  } catch (e) {
    console.error('GET /api/plans/:id/versions error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/plans/:id/versions/:vid/restore — write a restore point back
// onto the plan. The CURRENT content is snapshotted first (unthrottled),
// so a restore is itself always undoable via another restore.
router.post('/:id/versions/:vid/restore', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Plan not found' });
    const vid = parseInt(req.params.vid, 10);
    if (!Number.isFinite(vid)) return res.status(400).json({ error: 'Bad version id' });

    // Safety snapshot of what's about to be replaced — gated on the target
    // version actually existing, so a bad vid can't litter orphan snapshots.
    await pool.query(
      'INSERT INTO plan_versions (plan_id, organization_id, name, pages, totals, created_by) ' +
      'SELECT p.id, p.organization_id, p.name, p.pages, p.totals, $3 FROM plans p ' +
      ' WHERE p.id = $1 AND p.organization_id = $2 ' +
      '   AND EXISTS (SELECT 1 FROM plan_versions v WHERE v.id = $4 AND v.plan_id = p.id AND v.organization_id = p.organization_id)',
      [req.params.id, orgId, (req.user && req.user.id) || null, vid]
    );

    const { rows } = await pool.query(
      'UPDATE plans p SET pages = v.pages, totals = COALESCE(v.totals, p.totals), updated_at = NOW() ' +
      '  FROM plan_versions v ' +
      ' WHERE p.id = $1 AND p.organization_id = $2 ' +
      '   AND v.id = $3 AND v.plan_id = p.id AND v.organization_id = p.organization_id ' +
      ' RETURNING p.id',
      [req.params.id, orgId, vid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Version not found' });
    res.json({ ok: true, restored: vid });
  } catch (e) {
    console.error('POST /api/plans/:id/versions/:vid/restore error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
