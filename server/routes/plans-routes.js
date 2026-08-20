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
const { auditedTransaction } = require('../audit');

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

// `pages`/`totals` sanitizing lives in services/plan-doc.js — pure logic,
// unit-tested there without booting the auth stack. See that file's header
// for the flat-alias trap that made this the most dangerous code in Plans.
const { sanitizePages, sanitizeTotals, sqlSheetEntityCount } = require('../services/plan-doc');

// "How many entities does this stored pages value hold" — ONE definition,
// shared with scripts/plan-doc-census.js and scripts/plan-recover.js so the
// prune guard, the restore preview and the census cannot disagree about which
// rows still have a drawing in them.
const V_ENTITIES = sqlSheetEntityCount('v.pages');
const P_ENTITIES = sqlSheetEntityCount('p.pages');

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
    const cuts = [];
    const pages = sanitizePages(body.pages, cuts);
    if (cuts.length) console.warn('[plans] size cap TRUNCATED content on create: %s', JSON.stringify(cuts));
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
        //
        // ── THE PRUNE IS ALSO THE EVIDENCE DESTROYER ────────────────────
        // 30 snapshots at one per 10 minutes span >= 5 hours of saving. Any
        // plan gutted by the 2026-07-12 alias bug and edited across more than
        // that since has been steadily pushing its last pre-bug restore point
        // out of the window — and for a row that is ALREADY empty, every one
        // of those saves prunes a good snapshot to make room for another empty
        // one. The cap was quietly deleting the only copy of the drawing.
        //
        // So the cap no longer applies to a snapshot that still HOLDS geometry
        // while the live row holds none. A plan with a real drawing in it
        // prunes exactly as before (the exemption's second clause is false);
        // a plan that has been emptied keeps every restore point that still
        // has a drawing, indefinitely, until someone restores it or deletes
        // the plan. Unbounded growth is bounded by the same 10-minute throttle
        // and is the correct trade against permanent loss.
        if (ins.rowCount > 0) {
          await pool.query(
            'DELETE FROM plan_versions v WHERE v.plan_id = $1 AND v.organization_id = $2 ' +
            '   AND v.id NOT IN (SELECT id FROM plan_versions WHERE plan_id = $1 ORDER BY created_at DESC LIMIT 30) ' +
            '   AND NOT (' + V_ENTITIES + ' > 0 AND EXISTS (' +
            '         SELECT 1 FROM plans p WHERE p.id = v.plan_id AND ' + P_ENTITIES + ' = 0))',
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
      // Truncation at the size caps is data loss. It used to be silent — a
      // 20001-entity drawing stored 20000 and returned 200 OK. It still does
      // not reject the save (refusing a drawing at the cap would be a new way
      // to lose work) but it can no longer happen unobserved.
      const cuts = [];
      const clean = sanitizePages(body.pages, cuts);
      if (cuts.length) {
        console.warn('[plans] size cap TRUNCATED content on plan %s: %s',
          req.params.id, JSON.stringify(cuts));
      }
      sets.push('pages = $' + (pn++) + '::jsonb');
      params.push(JSON.stringify(clean));
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
//
// `entity_count` is what makes this a SHOW-BEFORE-ACT surface rather than a
// list of timestamps. `page_count` was always 1 for a sheet drawing, so the
// operator picking a restore point could not see whether the one they were
// about to take held a drawing at all — which is the only question that
// matters when recovering from the alias bug. `current_entity_count` is the
// live row, so the answer to "what am I replacing" ships with the answer to
// "what am I taking".
router.get('/:id/versions', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ versions: [] });
    const cur = await pool.query(
      'SELECT ' + P_ENTITIES + ' AS entity_count FROM plans p WHERE p.id = $1 AND p.organization_id = $2',
      [req.params.id, orgId]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Plan not found' });
    const { rows } = await pool.query(
      'SELECT v.id, v.name, v.created_at, u.name AS created_by_name, ' +
      '       jsonb_array_length(v.pages) AS page_count, ' +
      '       ' + V_ENTITIES + ' AS entity_count ' +
      '  FROM plan_versions v ' +
      '  LEFT JOIN users u ON u.id = v.created_by ' +
      ' WHERE v.plan_id = $1 AND v.organization_id = $2 ' +
      ' ORDER BY v.created_at DESC LIMIT 50',
      [req.params.id, orgId]
    );
    res.json({ versions: rows, current_entity_count: Number(cur.rows[0].entity_count) || 0 });
  } catch (e) {
    console.error('GET /api/plans/:id/versions error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/plans/:id/versions/:vid/restore — write a restore point back
// onto the plan. The CURRENT content is snapshotted first (unthrottled), so a
// restore is itself always undoable via another restore.
//
// Body: { expect_entities: <int> } — REQUIRED. The number of entities the
// caller was shown for this version. A restore overwrites live drawing data;
// if it can run from a stale preview then "the operator saw what they took"
// is a claim about a screen, not about the write. The server re-measures the
// snapshot and refuses (409) on any mismatch, so the read that authorised the
// restore has to be current. There is no bulk form and nothing calls this
// except an explicit human action — recovery never happens by itself, because
// a stale snapshot silently replacing a drawing someone has since redrawn
// would be this incident happening a second time.
//
// The whole thing runs in one audited transaction: safety snapshot, audit row
// and overwrite commit together or not at all.
router.post('/:id/versions/:vid/restore', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Plan not found' });
    const vid = parseInt(req.params.vid, 10);
    if (!Number.isFinite(vid)) return res.status(400).json({ error: 'Bad version id' });
    const body = req.body || {};
    const expect = Number.isFinite(body.expect_entities) ? (body.expect_entities | 0)
      : (typeof body.expect_entities === 'string' && /^\d+$/.test(body.expect_entities) ? parseInt(body.expect_entities, 10) : null);
    if (expect === null) {
      return res.status(400).json({
        error: 'expect_entities is required — read GET /api/plans/:id/versions first and pass the entity_count you were shown'
      });
    }

    // Measure both sides BEFORE touching anything, and hand the operator's
    // claim to the server for checking rather than trusting it.
    const pre = await pool.query(
      'SELECT ' + P_ENTITIES + ' AS live, ' +
      '       (SELECT ' + V_ENTITIES + ' FROM plan_versions v ' +
      '         WHERE v.id = $3 AND v.plan_id = p.id AND v.organization_id = p.organization_id) AS snap ' +
      '  FROM plans p WHERE p.id = $1 AND p.organization_id = $2',
      [req.params.id, orgId, vid]
    );
    if (!pre.rows.length) return res.status(404).json({ error: 'Plan not found' });
    if (pre.rows[0].snap == null) return res.status(404).json({ error: 'Version not found' });
    const live = Number(pre.rows[0].live) || 0;
    const snap = Number(pre.rows[0].snap) || 0;
    if (snap !== expect) {
      return res.status(409).json({
        error: 'Stale preview: this restore point holds ' + snap + ' entities, not ' + expect +
               '. Re-read the version list and confirm against the current numbers.',
        expect_entities: expect, actual_entities: snap
      });
    }

    await auditedTransaction(req, {
      action: 'plan.version_restore', tier: 'A', outcome: 'ok',
      targetType: 'plan', targetId: String(req.params.id), organizationId: orgId,
      detail: {
        version_id: vid,
        entities_taken: snap,
        entities_replaced: live,
        replaced_a_populated_drawing: live > 0,
        safety_snapshot: true
      }
    }, async (client) => {
      // Safety snapshot of what's about to be replaced — gated on the target
      // version actually existing, so a bad vid can't litter orphan snapshots.
      await client.query(
        'INSERT INTO plan_versions (plan_id, organization_id, name, pages, totals, created_by) ' +
        'SELECT p.id, p.organization_id, p.name, p.pages, p.totals, $3 FROM plans p ' +
        ' WHERE p.id = $1 AND p.organization_id = $2 ' +
        '   AND EXISTS (SELECT 1 FROM plan_versions v WHERE v.id = $4 AND v.plan_id = p.id AND v.organization_id = p.organization_id)',
        [req.params.id, orgId, (req.user && req.user.id) || null, vid]
      );
      const { rows } = await client.query(
        'UPDATE plans p SET pages = v.pages, totals = COALESCE(v.totals, p.totals), updated_at = NOW() ' +
        '  FROM plan_versions v ' +
        ' WHERE p.id = $1 AND p.organization_id = $2 ' +
        '   AND v.id = $3 AND v.plan_id = p.id AND v.organization_id = p.organization_id ' +
        ' RETURNING p.id',
        [req.params.id, orgId, vid]
      );
      if (!rows.length) { const e = new Error('VERSION_NOT_FOUND'); e.notFound = true; throw e; }
      return rows;
    });

    res.json({ ok: true, restored: vid, entities_taken: snap, entities_replaced: live });
  } catch (e) {
    if (e && e.notFound) return res.status(404).json({ error: 'Version not found' });
    if (e && e.auditFailure) {
      // Tier A: the restore is refused rather than performed unrecorded.
      return res.status(503).json({ error: 'Restore refused — the audit trail could not be written. Nothing was changed.' });
    }
    console.error('POST /api/plans/:id/versions/:vid/restore error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
