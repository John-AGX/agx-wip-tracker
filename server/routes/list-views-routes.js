// Saved list views — per-USER grid configuration (columns + filters) for a list
// page. Personal only (no sharing yet). Owner-scoped by (organization_id,
// user_id) from the authenticated req.user — never the body. Mounted at
// /api/list-views (server/index.js).
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
const COLS = 'id, page, name, config, is_default, created_at, updated_at';
const PAGES = new Set(['cost_inbox', 'jobs', 'leads', 'estimates', 'clients', 'subs',
                       'change_orders', 'purchase_orders', 'rfis', 'submittals']);

function callerOrgId(req) { const o = req.user && req.user.organization_id; return o ? Number(o) : null; }
function callerUserId(req) { return Number(req.user && req.user.id); }
function newId() { return 'view_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function cleanConfig(c) {
  if (!c || typeof c !== 'object') return {};
  const out = {};
  if (Array.isArray(c.columns)) out.columns = c.columns.filter((x) => typeof x === 'string').slice(0, 40);
  if (c.filters && typeof c.filters === 'object') out.filters = c.filters;
  return out;
}

// GET /api/list-views?page=cost_inbox — the caller's own views for that page.
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ views: [] });
    const page = String(req.query.page || '');
    if (!PAGES.has(page)) return res.json({ views: [] });
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM list_views WHERE organization_id = $1 AND user_id = $2 AND page = $3
        ORDER BY is_default DESC, lower(name)`,
      [orgId, callerUserId(req), page]
    );
    res.json({ views: rows });
  } catch (e) {
    console.error('GET /api/list-views error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/list-views — create a view. { page, name, config, is_default }.
router.post('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'Organization required' });
    const b = req.body || {};
    const page = String(b.page || '');
    if (!PAGES.has(page)) return res.status(400).json({ error: 'Unknown page' });
    const name = (typeof b.name === 'string' ? b.name.trim() : '').slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Name required' });
    const userId = callerUserId(req);
    const isDefault = !!b.is_default;
    const id = newId();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (isDefault) await client.query('UPDATE list_views SET is_default = FALSE WHERE organization_id = $1 AND user_id = $2 AND page = $3', [orgId, userId, page]);
      const { rows } = await client.query(
        `INSERT INTO list_views (id, organization_id, user_id, page, name, config, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLS}`,
        [id, orgId, userId, page, name, JSON.stringify(cleanConfig(b.config)), isDefault]
      );
      await client.query('COMMIT');
      res.json({ view: rows[0] });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (e) {
    console.error('POST /api/list-views error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/list-views/:id — rename / update config / set default. Owner only.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const userId = callerUserId(req);
    const cur = await pool.query('SELECT * FROM list_views WHERE id = $1 AND organization_id = $2 AND user_id = $3', [req.params.id, orgId, userId]);
    if (!cur.rows.length) return res.status(404).json({ error: 'View not found' });
    const row = cur.rows[0];
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const name = has('name') ? (String(b.name || '').trim().slice(0, 80) || row.name) : row.name;
    const config = has('config') ? cleanConfig(b.config) : row.config;
    const isDefault = has('is_default') ? !!b.is_default : row.is_default;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (isDefault && !row.is_default) await client.query('UPDATE list_views SET is_default = FALSE WHERE organization_id = $1 AND user_id = $2 AND page = $3', [orgId, userId, row.page]);
      const { rows } = await client.query(
        `UPDATE list_views SET name = $4, config = $5, is_default = $6, updated_at = NOW()
          WHERE id = $1 AND organization_id = $2 AND user_id = $3 RETURNING ${COLS}`,
        [req.params.id, orgId, userId, name, JSON.stringify(config), isDefault]
      );
      await client.query('COMMIT');
      res.json({ view: rows[0] });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (e) {
    console.error('PATCH /api/list-views/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/list-views/:id — owner only.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM list_views WHERE id = $1 AND organization_id = $2 AND user_id = $3',
      [req.params.id, callerOrgId(req), callerUserId(req)]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('DELETE /api/list-views/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
