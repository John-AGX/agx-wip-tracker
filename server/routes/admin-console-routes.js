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

// GET /api/admin/console/usage-forensics?from=ISO&to=ISO — token-usage
// forensics across EVERY Anthropic consumer the server records (chat
// turns, watch runs, background agent jobs, subtasks, replays), bucketed
// so an Anthropic-Console usage spike can be attributed to a specific
// agent / conversation / job. Read-only, parameterized, SYSTEM_ADMIN.
// Defaults to the last 48h; span clamped to 31 days. All timestamps UTC
// to line up with the Console's hour buckets.
router.get('/usage-forensics', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 48 * 3600e3);
    if (isNaN(from) || isNaN(to) || from >= to) {
      return res.status(400).json({ error: 'Bad from/to' });
    }
    if (to - from > 31 * 86400e3) {
      return res.status(400).json({ error: 'Range too large (max 31 days)' });
    }
    const P = [from.toISOString(), to.toISOString()];

    // Chat turns by UTC hour x model. total_in = uncached input + cache
    // writes + cache reads = what the Anthropic console charts as
    // "tokens in" for the request.
    const byHour = await pool.query(`
      SELECT to_char(date_trunc('hour', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:00"Z"') AS hour_utc,
             COALESCE(model, 'unknown') AS model,
             COUNT(*)::int AS turns,
             COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS cache_creation,
             COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read,
             COALESCE(SUM(input_tokens), 0)::bigint
               + COALESCE(SUM(cache_creation_input_tokens), 0)::bigint
               + COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_in,
             COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
        FROM ai_messages
       WHERE role = 'assistant' AND created_at >= $1 AND created_at < $2
       GROUP BY 1, 2
       ORDER BY 1, 2`, P);

    // Which surface (entity_type) drove it.
    const bySurface = await pool.query(`
      SELECT entity_type,
             COUNT(*)::int AS turns,
             COUNT(DISTINCT (estimate_id, user_id))::int AS conversations,
             COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS cache_creation,
             COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read,
             COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
        FROM ai_messages
       WHERE role = 'assistant' AND created_at >= $1 AND created_at < $2
       GROUP BY 1
       ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(cache_creation_input_tokens),0) + COALESCE(SUM(cache_read_input_tokens),0)) DESC`, P);

    // The specific conversations that burned it. total_in DESC.
    const topConversations = await pool.query(`
      SELECT m.entity_type, m.estimate_id AS entity_id, m.user_id,
             u.name AS user_name,
             COUNT(*)::int AS turns,
             COALESCE(SUM(m.tool_use_count), 0)::int AS tool_uses,
             array_agg(DISTINCT m.model) FILTER (WHERE m.model IS NOT NULL) AS models,
             MIN(m.created_at) AS first_turn,
             MAX(m.created_at) AS last_turn,
             COALESCE(SUM(m.input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(m.cache_creation_input_tokens), 0)::bigint AS cache_creation,
             COALESCE(SUM(m.cache_read_input_tokens), 0)::bigint AS cache_read,
             COALESCE(SUM(m.input_tokens), 0)::bigint
               + COALESCE(SUM(m.cache_creation_input_tokens), 0)::bigint
               + COALESCE(SUM(m.cache_read_input_tokens), 0)::bigint AS total_in,
             COALESCE(SUM(m.output_tokens), 0)::bigint AS output_tokens
        FROM ai_messages m
        LEFT JOIN users u ON u.id = m.user_id
       WHERE m.role = 'assistant' AND m.created_at >= $1 AND m.created_at < $2
       GROUP BY m.entity_type, m.estimate_id, m.user_id, u.name
       ORDER BY total_in DESC
       LIMIT 25`, P);

    // Assistant turns that recorded NO usage — undercount detector
    // (managed-session turns whose usage event never landed, crashes, etc).
    const unlogged = await pool.query(`
      SELECT entity_type, COUNT(*)::int AS turns_without_usage
        FROM ai_messages
       WHERE role = 'assistant' AND input_tokens IS NULL
         AND created_at >= $1 AND created_at < $2
       GROUP BY 1 ORDER BY 2 DESC`, P);

    // Watches (proactive runs).
    const watchRuns = await pool.query(`
      SELECT w.name, r.watch_id, COUNT(*)::int AS runs,
             COALESCE(SUM(r.input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(r.cache_creation_tokens), 0)::bigint AS cache_creation,
             COALESCE(SUM(r.cache_read_tokens), 0)::bigint AS cache_read,
             COALESCE(SUM(r.output_tokens), 0)::bigint AS output_tokens
        FROM ai_watch_runs r
        LEFT JOIN ai_watches w ON w.id = r.watch_id
       WHERE r.triggered_at >= $1 AND r.triggered_at < $2
       GROUP BY w.name, r.watch_id
       ORDER BY (COALESCE(SUM(r.input_tokens),0) + COALESCE(SUM(r.cache_creation_tokens),0) + COALESCE(SUM(r.cache_read_tokens),0)) DESC
       LIMIT 20`, P);

    // Background agent jobs.
    const agentJobs = await pool.query(`
      SELECT id, title, agent_key, status, created_at, started_at, completed_at,
             input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
             (input_tokens + cache_creation_tokens + cache_read_tokens)::bigint AS total_in
        FROM agent_jobs
       WHERE created_at >= $1 AND created_at < $2
       ORDER BY total_in DESC
       LIMIT 20`, P);

    // Subtasks + replays (usually zero these days, but count them so the
    // ledger is complete).
    const subtasks = await pool.query(`
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(cache_creation_tokens), 0)::bigint AS cache_creation,
             COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read,
             COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
        FROM ai_subtasks WHERE created_at >= $1 AND created_at < $2`, P);
    const replays = await pool.query(`
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
        FROM ai_replays WHERE run_at >= $1 AND run_at < $2`, P);

    // Grand ledger — everything the server recorded, to hold against the
    // Anthropic console total for the same window.
    const s = (rows, k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
    const chat = bySurface.rows;
    const grand = {
      chat_total_in: s(chat, 'input_tokens') + s(chat, 'cache_creation') + s(chat, 'cache_read'),
      chat_output: s(chat, 'output_tokens'),
      watches_total_in: s(watchRuns.rows, 'input_tokens') + s(watchRuns.rows, 'cache_creation') + s(watchRuns.rows, 'cache_read'),
      agent_jobs_total_in: s(agentJobs.rows, 'total_in'),
      subtasks_total_in: s(subtasks.rows, 'input_tokens') + s(subtasks.rows, 'cache_creation') + s(subtasks.rows, 'cache_read'),
      replays_in: s(replays.rows, 'input_tokens'),
    };
    grand.everything_total_in = grand.chat_total_in + grand.watches_total_in
      + grand.agent_jobs_total_in + grand.subtasks_total_in + grand.replays_in;

    res.json({
      from: P[0], to: P[1],
      byHour: byHour.rows,
      bySurface: bySurface.rows,
      topConversations: topConversations.rows,
      unlogged: unlogged.rows,
      watchRuns: watchRuns.rows,
      agentJobs: agentJobs.rows,
      subtasks: subtasks.rows[0],
      replays: replays.rows[0],
      grand,
    });
  } catch (e) {
    console.error('GET /api/admin/console/usage-forensics error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

module.exports = router;
