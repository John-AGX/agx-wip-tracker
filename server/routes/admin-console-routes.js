// Project 86 Command Center — platform-owner (system_admin) read APIs.
//
// Every route is requireSystemAdmin: this is cross-tenant, platform-level
// data that only the platform owner may see. Org admins (ROLES_MANAGE)
// never reach this surface — that's the whole point of the two-tier split.
//
// Read-only by design for Phase 1 (audit feed, cross-org metrics, headline
// counts). Mutating platform ops live behind their own deliberate endpoints
// (org create/archive in admin-organizations-routes), each already audited.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireSystemAdmin } = require('../auth');

const router = express.Router();
console.log('[admin-console-routes] mounted at /api/admin/console (SYSTEM_ADMIN-gated)');

// GET /api/admin/console/overview — headline platform counts (all tenants).
router.get('/overview', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM organizations WHERE archived_at IS NULL) AS orgs,
        (SELECT COUNT(*)::int FROM users WHERE active = TRUE)               AS active_users,
        (SELECT COUNT(*)::int FROM users)                                   AS total_users,
        (SELECT COUNT(*)::int FROM jobs)                                    AS jobs,
        (SELECT COUNT(*)::int FROM estimates)                              AS estimates,
        (SELECT COUNT(*)::int FROM leads)                                   AS leads,
        (SELECT COUNT(*)::int FROM admin_audit_log
           WHERE created_at >= NOW() - INTERVAL '7 days')                   AS audit_events_7d
    `);
    res.json({ overview: q.rows[0] });
  } catch (e) {
    console.error('GET /api/admin/console/overview error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// GET /api/admin/console/audit?limit=100&action=&actor= — the privileged-
// action trail captured by server/audit.js, newest first.
router.get('/audit', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    const where = [];
    const params = [];
    let p = 1;
    if (req.query.action) { where.push('a.action = $' + p++); params.push(String(req.query.action)); }
    if (req.query.actor)  { where.push('a.actor_email ILIKE $' + p++); params.push('%' + String(req.query.actor) + '%'); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT a.id, a.created_at, a.actor_user_id, a.actor_email, a.actor_role,
              a.action, a.target_type, a.target_id, a.organization_id, a.actor_org_id,
              a.detail, a.ip, o.name AS org_name
         FROM admin_audit_log a
         LEFT JOIN organizations o ON o.id = a.organization_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.created_at DESC
        LIMIT $${p}`,
      params
    );
    res.json({ entries: rows });
  } catch (e) {
    console.error('GET /api/admin/console/audit error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// GET /api/admin/console/metrics?range=7d|30d — cross-org AI activity +
// estimated spend, one row per org. (range is constrained to two literals
// so it can't be injected.)
router.get('/metrics', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const range = (req.query.range === '30d') ? '30 days' : '7 days';
    const { rows } = await pool.query(`
      SELECT
        m.organization_id,
        o.name AS org_name,
        COUNT(*) FILTER (WHERE m.role = 'assistant')           AS turns,
        COUNT(DISTINCT m.user_id)                              AS users,
        COALESCE(SUM(m.input_tokens), 0)::bigint               AS input_tokens,
        COALESCE(SUM(m.output_tokens), 0)::bigint              AS output_tokens,
        COALESCE(SUM(m.cache_creation_input_tokens), 0)::bigint AS cache_creation_tokens,
        COALESCE(SUM(m.cache_read_input_tokens), 0)::bigint    AS cache_read_tokens,
        COALESCE(SUM(m.tool_use_count), 0)::bigint             AS tool_uses
      FROM ai_messages m
      LEFT JOIN organizations o ON o.id = m.organization_id
      WHERE m.created_at >= NOW() - INTERVAL '${range}'
      GROUP BY m.organization_id, o.name
      ORDER BY turns DESC
    `);
    // Estimated spend from token counts at Opus 4.8 list rates. Clearly an
    // estimate — actual billed cost is tracked per-session on ai_sessions.
    const RATE = { input: 5 / 1e6, output: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.5 / 1e6 };
    const orgs = rows.map((r) => {
      const est = Number(r.input_tokens) * RATE.input
        + Number(r.output_tokens) * RATE.output
        + Number(r.cache_creation_tokens) * RATE.cacheWrite
        + Number(r.cache_read_tokens) * RATE.cacheRead;
      return Object.assign({}, r, { est_cost_usd: Math.round(est * 100) / 100 });
    });
    const totalEst = Math.round(orgs.reduce((s, o) => s + o.est_cost_usd, 0) * 100) / 100;
    res.json({ range, orgs, total_est_cost_usd: totalEst });
  } catch (e) {
    console.error('GET /api/admin/console/metrics error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

module.exports = router;
