'use strict';
// Assembly research inbox — staging for web-gathered cost/recipe research (the
// Claude browser extension, or a user pasting) that 86 then builds/tunes
// assemblies from. This keeps 86's opus credits for the structured build, not
// the browsing. Reads/writes = ESTIMATES_EDIT (matches the Assembly Studio
// surface). Org-scoped strictly (user-authored, not shared-seed).

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();
const CAP = 'ESTIMATES_EDIT';
const STATUSES = ['unprocessed', 'consumed', 'void'];

function shape(r) {
  return {
    id: r.id, status: r.status, title: r.title, trade: r.trade, scope: r.scope,
    findings: r.findings || [], raw_text: r.raw_text, source_url: r.source_url,
    notes: r.notes, consumed_assembly_id: r.consumed_assembly_id,
    created_by: r.created_by, created_at: r.created_at, consumed_at: r.consumed_at,
    finding_count: Array.isArray(r.findings) ? r.findings.length : 0,
  };
}

// ── GET /api/assembly-research?status=unprocessed — list packets ─────────
router.get('/', requireAuth, requireCapability(CAP), async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const params = [req.user.organization_id];
    let sql = 'SELECT * FROM assembly_research WHERE organization_id = $1';
    if (STATUSES.indexOf(status) !== -1) { params.push(status); sql += ' AND status = $2'; }
    sql += " ORDER BY (status = 'unprocessed') DESC, created_at DESC LIMIT 200";
    const r = await pool.query(sql, params);
    // Counts by status for the inbox header badge.
    const cr = await pool.query(
      'SELECT status, COUNT(*)::int AS n FROM assembly_research WHERE organization_id = $1 GROUP BY status',
      [req.user.organization_id]
    );
    const counts = {};
    cr.rows.forEach((row) => { counts[row.status] = row.n; });
    res.json({ research: r.rows.map(shape), counts });
  } catch (e) { console.error('GET /api/assembly-research error:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/assembly-research/:id — one packet ──────────────────────────
router.get('/:id', requireAuth, requireCapability(CAP), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    const r = await pool.query('SELECT * FROM assembly_research WHERE id = $1 AND organization_id = $2', [id, req.user.organization_id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ research: shape(r.rows[0]) });
  } catch (e) { console.error('GET /api/assembly-research/:id error:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/assembly-research — create a research packet ───────────────
router.post('/', requireAuth, requireCapability(CAP), async (req, res) => {
  try {
    const b = req.body || {};
    const findings = Array.isArray(b.findings) ? b.findings.slice(0, 200) : [];
    const raw = (b.raw_text != null && b.raw_text !== '') ? String(b.raw_text).slice(0, 20000) : null;
    if (!raw && !findings.length && !b.title) {
      return res.status(400).json({ error: 'Provide at least a title, findings, or pasted text.' });
    }
    const r = await pool.query(
      `INSERT INTO assembly_research (organization_id, created_by, status, title, trade, scope, findings, raw_text, source_url, notes)
       VALUES ($1,$2,'unprocessed',$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
      [req.user.organization_id, req.user.id,
       b.title ? String(b.title).slice(0, 200) : null,
       b.trade ? String(b.trade).slice(0, 80) : null,
       b.scope ? String(b.scope).slice(0, 200) : null,
       JSON.stringify(findings), raw,
       b.source_url ? String(b.source_url).slice(0, 1000) : null,
       b.notes ? String(b.notes).slice(0, 2000) : null]
    );
    res.json({ ok: true, research: shape(r.rows[0]) });
  } catch (e) { console.error('POST /api/assembly-research error:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/assembly-research/:id/consume — 86 built an assembly from it ─
router.post('/:id/consume', requireAuth, requireCapability(CAP), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    const asmId = req.body && req.body.assembly_id ? parseInt(req.body.assembly_id, 10) : null;
    // Resolve consumed_assembly_id through an org-scoped subquery so an
    // out-of-org or non-existent assembly id lands as NULL rather than
    // planting a cross-tenant FK pointer or raising a generic 500 on the
    // FK violation. (The server-side auto-consume in dispatchAssembly is the
    // primary path; this covers the manual "✓ Built" button.)
    // status='unprocessed' guard: this route must NEVER clobber a packet the
    // in-txn dispatchAssembly path already consumed+linked to the exact source
    // assembly — a redundant client consume just no-ops (404) instead.
    const r = await pool.query(
      `UPDATE assembly_research SET status = 'consumed',
         consumed_assembly_id = (SELECT id FROM assemblies WHERE id = $3 AND organization_id = $2),
         consumed_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND status = 'unprocessed' RETURNING *`,
      [id, req.user.organization_id, (asmId && isFinite(asmId)) ? asmId : null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, research: shape(r.rows[0]) });
  } catch (e) { console.error('POST /api/assembly-research/:id/consume error:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/assembly-research/:id/void — discard a packet ──────────────
router.post('/:id/void', requireAuth, requireCapability(CAP), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    const r = await pool.query(
      "UPDATE assembly_research SET status = 'void' WHERE id = $1 AND organization_id = $2 RETURNING *",
      [id, req.user.organization_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, research: shape(r.rows[0]) });
  } catch (e) { console.error('POST /api/assembly-research/:id/void error:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── DELETE /api/assembly-research/:id ────────────────────────────────────
router.delete('/:id', requireAuth, requireCapability(CAP), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    const r = await pool.query('DELETE FROM assembly_research WHERE id = $1 AND organization_id = $2', [id, req.user.organization_id]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) { console.error('DELETE /api/assembly-research/:id error:', e); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
