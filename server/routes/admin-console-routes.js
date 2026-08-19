// Project 86 Command Center — platform-owner (system_admin) read APIs.
//
// Every route is requireSystemAdmin: this is cross-tenant, platform-level
// data that only the platform owner may see. Org admins (ROLES_MANAGE)
// never reach this surface — that's the whole point of the two-tier split.
//
// Read-only by design (audit feed, cross-org metrics, headline counts, the
// org-boundary audit). Mutating platform ops live behind their own deliberate
// endpoints (org create/archive in admin-organizations-routes), each already
// audited.
//
// ONE EXCEPTION, and it is deliberate: POST /org-boundary/backfill. It belongs
// here rather than beside the org-lifecycle routes because it is meaningless
// without the audit it is paired with — you read the count, you stamp what is
// derivable, you read the count again. It is dry-by-default, evidence-only,
// idempotent, and logs its actor when applied. Nothing else mutating should
// join it without the same argument.

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
           WHERE created_at >= NOW() - INTERVAL '7 days')                   AS audit_events_7d,
        -- Denials in the same window. This is the enumeration signal: a walk
        -- of the settings key space, a run of failed logins, a refused
        -- escalation. It has its own partial index and it is the number worth
        -- looking at on a dashboard.
        (SELECT COUNT(*)::int FROM admin_audit_log
           WHERE created_at >= NOW() - INTERVAL '7 days'
             AND outcome <> 'ok')                                           AS audit_denied_7d
    `);
    // Beside the counts, whether the trail itself is healthy. A non-zero
    // write_failures means rows are going to stdout instead of the table right
    // now — the one condition under which the numbers above are understated.
    let health = null;
    try { health = require('../audit').auditHealth(); } catch (e) { /* never break the tile */ }
    res.json({ overview: q.rows[0], audit_health: health });
  } catch (e) {
    console.error('GET /api/admin/console/overview error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// GET /api/admin/console/audit — the PLATFORM tier of the audit read path.
//
//   ?limit=  1..500      ?before_id=  keyset cursor
//   ?action= exact, or ?action_prefix= for a family ('settings.')
//   ?actor=  exact email (?actor_prefix= for a partial)
//   ?target_type= ?target_id=   ?outcome= ?tier= ?scope= ?org=
//   ?from= ?to=  ISO timestamps
//
// FOUR THINGS WERE WRONG WITH THIS ENDPOINT AND ALL FOUR WERE CHEAP.
//
// 1. NO PAGINATION. A fixed LIMIT meant you could see the newest 500 rows and
//    there was no way to reach row 501 — on the one table whose whole value is
//    "what happened seven weeks ago". Keyset (`id < cursor`) rather than
//    OFFSET: at a million rows OFFSET 900000 reads 900,000 rows to discard
//    them, and id is BIGSERIAL so it orders identically to created_at.
//
// 2. UNINDEXABLE ACTOR FILTER. `actor_email ILIKE '%x%'` is a leading wildcard,
//    so it full-scans and then sorts before the limit can apply. Exact
//    lower(email) matches the new expression index; `actor_prefix` keeps the
//    partial search for the times you want it, and says out loud that it scans.
//
// 3. NO FILTER FOR THE QUESTION ACTUALLY ASKED. "Who touched this record" —
//    target_type + target_id — had neither a parameter nor an index. That is
//    THE acceptance-test query:
//      ?target_type=app_setting&target_id=vapid_keys&from=2026-07-01
//
// 4. THE API RETURNED MORE THAN THE UI SHOWED. `detail` and `ip` crossed the
//    wire on every row while the table painted four columns. Dead exposure of
//    the two most sensitive fields on the row. The list is now lean and the
//    full row is one click and one deliberate request away, below.
router.get('/audit', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    const where = [];
    const params = [];
    let p = 1;
    const q = req.query;
    if (q.action) { where.push('a.action = $' + p++); params.push(String(q.action)); }
    if (q.action_prefix) { where.push('a.action LIKE $' + p++); params.push(String(q.action_prefix) + '%'); }
    if (q.actor) { where.push('lower(a.actor_email) = lower($' + p++ + ')'); params.push(String(q.actor)); }
    // Deliberately separate from `actor`: this one cannot use the index, and
    // naming it differently is how a caller knows which they asked for.
    if (q.actor_prefix) { where.push('lower(a.actor_email) LIKE lower($' + p++ + ')'); params.push(String(q.actor_prefix) + '%'); }
    if (q.target_type) { where.push('a.target_type = $' + p++); params.push(String(q.target_type)); }
    if (q.target_id) { where.push('a.target_id = $' + p++); params.push(String(q.target_id)); }
    if (q.outcome) { where.push('a.outcome = $' + p++); params.push(String(q.outcome)); }
    if (q.tier) { where.push('a.tier = $' + p++); params.push(String(q.tier).toUpperCase().slice(0, 1)); }
    if (q.scope) { where.push('a.scope = $' + p++); params.push(String(q.scope)); }
    if (q.org) {
      const orgId = parseInt(q.org, 10);
      if (!Number.isFinite(orgId)) return res.status(400).json({ error: 'Bad org' });
      where.push('a.organization_id = $' + p++); params.push(orgId);
    }
    if (q.from) {
      const d = new Date(q.from);
      if (isNaN(d)) return res.status(400).json({ error: 'Bad from' });
      where.push('a.created_at >= $' + p++); params.push(d.toISOString());
    }
    if (q.to) {
      const d = new Date(q.to);
      if (isNaN(d)) return res.status(400).json({ error: 'Bad to' });
      where.push('a.created_at <= $' + p++); params.push(d.toISOString());
    }
    if (q.before_id) {
      const before = parseInt(q.before_id, 10);
      if (!Number.isFinite(before)) return res.status(400).json({ error: 'Bad before_id' });
      where.push('a.id < $' + p++); params.push(before);
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT a.id, a.created_at, a.actor_kind, a.actor_user_id, a.actor_email, a.actor_role,
              a.on_behalf_of_user_id, a.action, a.outcome, a.reason, a.tier, a.scope,
              a.target_type, a.target_id, a.organization_id, a.actor_org_id,
              (a.detail IS NOT NULL) AS has_detail, o.name AS org_name
         FROM admin_audit_log a
         LEFT JOIN organizations o ON o.id = a.organization_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.id DESC
        LIMIT $${p}`,
      params
    );
    res.json({
      entries: rows,
      next_before_id: rows.length === limit ? rows[rows.length - 1].id : null,
    });
  } catch (e) {
    console.error('GET /api/admin/console/audit error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// GET /api/admin/console/audit/:id — the full row, including `detail`, `ip` and
// `user_agent`. Same gate; a separate request so the two most sensitive fields
// on the row are fetched deliberately rather than shipped on every list page.
router.get('/audit/:id', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    const { rows } = await pool.query(
      `SELECT a.*, o.name AS org_name
         FROM admin_audit_log a
         LEFT JOIN organizations o ON o.id = a.organization_id
        WHERE a.id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ entry: rows[0] });
  } catch (e) {
    console.error('GET /api/admin/console/audit/:id error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// GET /api/admin/console/audit-health — is the trail itself working?
//
// A failing audit that only appears in scrollback is a failing audit nobody
// notices. write_failures is the number of rows that went to stdout instead of
// the table since this process started; anything above zero means the platform
// log is currently the only copy.
router.get('/audit-health', requireAuth, requireSystemAdmin, (req, res) => {
  try {
    res.json({ health: require('../audit').auditHealth() });
  } catch (e) {
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

// GET /api/admin/console/org-boundary — the tenant-boundary audit.
//
// WHY THIS EXISTS. The tenant-boundary endgame has exactly one gating
// question — "which rows would become invisible if the tolerance came out?"
// — and nothing in this repo could answer it. The two boot reporters in
// db.js cover 10 tables of ~75, run twice per boot inside the Railway swap
// window (which is why the three highest-row tables were deliberately
// excluded), and are read out of scrollback. This is the same measurement
// with none of those constraints: catalog-driven, complete, on demand, and
// able to say "I could not measure that" instead of "zero".
//
// It hides nothing and changes nothing. Every statement runs inside a
// READ ONLY transaction that is ROLLBACKed, under SET LOCAL
// statement_timeout — because server/db.js creates the pool with
// connectionString and ssl only, with NO statement_timeout and NO
// lock_timeout, and every count in here is a guaranteed sequential scan
// (the idx_*_org indexes are PARTIAL on `organization_id IS NOT NULL`, so
// none of them can serve `IS NULL`). Without that timeout one admin click
// could pin a pool connection on the attachments table indefinitely.
// Aborting a read costs nothing, so the bound is free.
//
// ?timeout_ms= overrides the per-statement bound (1s..120s, default 20s).
router.get('/org-boundary', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const { auditOrgBoundary } = require('../services/org-boundary-audit');
    const report = await auditOrgBoundary(pool, {
      timeoutMs: req.query.timeout_ms ? parseInt(req.query.timeout_ms, 10) : undefined,
    });
    res.json(report);
  } catch (e) {
    console.error('GET /api/admin/console/org-boundary error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// POST /api/admin/console/org-boundary/backfill — step 2 of the safety
// property: stamp the existing NULLs FROM EVIDENCE, never from a guess.
//
// DRY BY DEFAULT. Without `{"dry_run": false}` this counts what COULD be
// stamped, rolls back, and writes nothing — the same shape
// services/org-reset.js:previewOrgData uses to preview a destructive
// operation, so the operator sees the blast radius before authorising it.
//
// Every statement reads the tenant off a row that ALREADY STATES IT: the
// attachment's parent entity, the cost line's job, the message's user. That is
// what makes it different from the backfills in db.js, which are gated on
// NEVER_MULTI_ORG because they guess (lowest-numbered org, slug='agx') — a
// guess that is correct only while one tenant exists, and whose gate switches
// off at exactly the moment the boundary starts to matter. Nothing here is
// gated on the org count, because nothing here can be wrong.
//
// It cannot invent a tenant: `<source> IS NOT NULL` is half of every
// predicate, so a row whose parent is itself un-stamped or absent is left
// alone, stays NULL, and stays counted by GET /org-boundary. It is idempotent
// by construction (`WHERE organization_id IS NULL` re-checks on every run), and
// it is deliberately NOT on the boot path — index.js only calls listen() if
// init() resolved, so a migration that hangs on a lock never opens the port and
// never logs why.
//
// It also stamps NOTHING on users / jobs / estimates / leads / clients / subs.
// Those tables ARE the anchor: no other row states their tenant, so any value
// would be a guess by definition.
router.post('/org-boundary/backfill', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const { backfillFromEvidence } = require('../services/org-backfill-evidence');
    const body = req.body || {};
    const report = await backfillFromEvidence(pool, {
      dryRun: body.dry_run !== false,
      tables: Array.isArray(body.tables) ? body.tables : null,
      timeoutMs: body.timeout_ms ? parseInt(body.timeout_ms, 10) : undefined,
    });
    if (!report.dry_run) {
      console.log('[org] evidence backfill APPLIED by user=' + (req.user && req.user.id) + ' — ' +
        report.results.filter((r) => r.updated).map((r) => r.label + '=' + r.updated).join(' ') || '(nothing to stamp)');
    }
    res.json(report);
  } catch (e) {
    console.error('POST /api/admin/console/org-boundary/backfill error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

module.exports = router;
