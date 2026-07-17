'use strict';
// Assembly code registry — the controlled Trade + System vocabulary behind the
// TRADE-SYSTEM-VARIANT code protocol. GET is readable by anyone who can view
// estimates (drives the editor dropdowns + the /assemblies tree); writes need
// ESTIMATES_EDIT. Rows are org-scoped; the global (organization_id NULL) seed
// is read-only here — an org "shadows" a global by creating a row of the same
// code. Mirrors the org_tags catalog posture.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const asm = require('../services/assemblies');

const router = express.Router();

const seg = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── GET / — merged globals + org registry (org shadows global) ────────
router.get('/', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const reg = await asm.loadRegistry(pool, req.user.organization_id);
    const trades = [...reg.trades.values()].sort((a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code));
    const systems = [];
    reg.systemsByTrade.forEach((map, tradeCode) => {
      [...map.values()].sort((a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code))
        .forEach((s) => systems.push({ id: s.id, trade_code: tradeCode, code: s.code, name: s.name, default_unit: s.default_unit || null, org: s.org }));
    });
    res.json({ trades, systems });
  } catch (e) {
    console.error('GET /api/assembly-taxonomy error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /trades — create an org-scoped trade ─────────────────────────
router.post('/trades', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const code = seg(req.body && req.body.code);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    if (!code) return res.status(400).json({ error: 'A code (letters/digits) is required' });
    if (!name) return res.status(400).json({ error: 'A name is required' });
    const sort = Number.isFinite(+(req.body && req.body.sort_order)) ? +req.body.sort_order : 0;
    const dup = await pool.query(
      `SELECT 1 FROM assembly_trades WHERE COALESCE(organization_id,0)=COALESCE($1,0) AND UPPER(code)=UPPER($2)`,
      [req.user.organization_id, code]);
    if (dup.rows.length) return res.status(409).json({ error: `Trade code ${code} already exists` });
    const r = await pool.query(
      `INSERT INTO assembly_trades (organization_id, code, name, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.user.organization_id, code, name, sort, req.user.id]);
    res.json({ ok: true, id: r.rows[0].id, code });
  } catch (e) {
    console.error('POST /api/assembly-taxonomy/trades error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /trades/:id — rename / re-sort / archive (org rows only) ─────
router.patch('/trades/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query(
      `SELECT id, code FROM assembly_trades WHERE id=$1 AND organization_id=$2`, [id, req.user.organization_id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Trade not found (global seeds are read-only)' });
    const b = req.body || {};
    if (b.archived === true) {
      const used = await pool.query(
        `SELECT COUNT(*)::int c FROM assemblies WHERE (organization_id=$1 OR organization_id IS NULL) AND is_hidden=FALSE AND UPPER(trade)=UPPER($2)`,
        [req.user.organization_id, cur.rows[0].code]);
      if (used.rows[0].c > 0) return res.status(409).json({ error: `${used.rows[0].c} assembly(ies) still use ${cur.rows[0].code}. Reassign them first.` });
    }
    const sets = [], vals = [];
    if (b.name !== undefined) { sets.push('name'); vals.push(String(b.name).trim().slice(0, 80)); }
    if (b.sort_order !== undefined && Number.isFinite(+b.sort_order)) { sets.push('sort_order'); vals.push(+b.sort_order); }
    if (b.archived !== undefined) { sets.push('archived_at'); vals.push(b.archived ? new Date() : null); }
    if (!sets.length) return res.json({ ok: true });
    const setSql = sets.map((k, i) => `${k}=$${i + 1}`).join(', ');
    await pool.query(
      `UPDATE assembly_trades SET ${setSql}, updated_at=NOW() WHERE id=$${sets.length + 1} AND organization_id=$${sets.length + 2}`,
      [...vals, id, req.user.organization_id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/assembly-taxonomy/trades/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /systems — create an org-scoped system under a trade ──────────
router.post('/systems', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const tradeCode = seg(req.body && req.body.trade_code);
    const code = seg(req.body && req.body.code);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    const defaultUnit = req.body && req.body.default_unit ? String(req.body.default_unit).trim().slice(0, 12) : null;
    if (!tradeCode || !code) return res.status(400).json({ error: 'trade_code and code are required' });
    if (!name) return res.status(400).json({ error: 'A name is required' });
    const reg = await asm.loadRegistry(pool, req.user.organization_id);
    if (!reg.trades.get(tradeCode)) return res.status(400).json({ error: `Unknown trade ${tradeCode}` });
    const sort = Number.isFinite(+(req.body && req.body.sort_order)) ? +req.body.sort_order : 0;
    const dup = await pool.query(
      `SELECT 1 FROM assembly_systems WHERE COALESCE(organization_id,0)=COALESCE($1,0) AND UPPER(trade_code)=UPPER($2) AND UPPER(code)=UPPER($3)`,
      [req.user.organization_id, tradeCode, code]);
    if (dup.rows.length) return res.status(409).json({ error: `System ${tradeCode}-${code} already exists` });
    const r = await pool.query(
      `INSERT INTO assembly_systems (organization_id, trade_code, code, name, default_unit, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.organization_id, tradeCode, code, name, defaultUnit, sort, req.user.id]);
    res.json({ ok: true, id: r.rows[0].id, code });
  } catch (e) {
    console.error('POST /api/assembly-taxonomy/systems error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /systems/:id — rename / unit / re-sort / archive (org only) ──
router.patch('/systems/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query(
      `SELECT id, trade_code, code FROM assembly_systems WHERE id=$1 AND organization_id=$2`, [id, req.user.organization_id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'System not found (global seeds are read-only)' });
    const b = req.body || {};
    if (b.archived === true) {
      const used = await pool.query(
        `SELECT COUNT(*)::int c FROM assemblies WHERE (organization_id=$1 OR organization_id IS NULL) AND is_hidden=FALSE AND UPPER(trade)=UPPER($2) AND UPPER(system)=UPPER($3)`,
        [req.user.organization_id, cur.rows[0].trade_code, cur.rows[0].code]);
      if (used.rows[0].c > 0) return res.status(409).json({ error: `${used.rows[0].c} assembly(ies) still use this system. Reassign them first.` });
    }
    const sets = [], vals = [];
    if (b.name !== undefined) { sets.push('name'); vals.push(String(b.name).trim().slice(0, 80)); }
    if (b.default_unit !== undefined) { sets.push('default_unit'); vals.push(b.default_unit ? String(b.default_unit).trim().slice(0, 12) : null); }
    if (b.sort_order !== undefined && Number.isFinite(+b.sort_order)) { sets.push('sort_order'); vals.push(+b.sort_order); }
    if (b.archived !== undefined) { sets.push('archived_at'); vals.push(b.archived ? new Date() : null); }
    if (!sets.length) return res.json({ ok: true });
    const setSql = sets.map((k, i) => `${k}=$${i + 1}`).join(', ');
    await pool.query(
      `UPDATE assembly_systems SET ${setSql}, updated_at=NOW() WHERE id=$${sets.length + 1} AND organization_id=$${sets.length + 2}`,
      [...vals, id, req.user.organization_id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/assembly-taxonomy/systems/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
