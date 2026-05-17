// Admin Agents — observability endpoints for the in-app AI agents.
//
// Reads from the existing ai_messages table (see server/db.js). Each row
// is one user-or-assistant turn; rows for the same conversation share a
// (entity_type, estimate_id, user_id) tuple. The "estimate_id" column
// historically named the FK but actually stores the entity id for any
// entity_type — kept for backward compat.
//
// Three endpoints:
//   GET  /api/admin/agents/metrics           — per-agent aggregate stats
//   GET  /api/admin/agents/conversations     — list recent conversations
//   GET  /api/admin/agents/conversations/:k  — full message log for one
//
// All admin-gated by ROLES_MANAGE.
//
// Pricing constants approximate Anthropic API list prices (USD per 1M
// tokens, input/output) at the time of writing — used only for cost
// hints in the UI, NOT for billing. Update when models change.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

// Cost ($/1M tokens) — input, output. Mirrors what's listed in
// the public model pricing tables. Only used for friendly display
// math; not persisted.
const MODEL_COSTS = {
  'claude-opus-4-7':   { in: 5,    out: 25  },
  'claude-opus-4-6':   { in: 5,    out: 25  },
  'claude-opus-4-5':   { in: 15,   out: 75  },
  'claude-sonnet-4-6': { in: 3,    out: 15  },
  'claude-sonnet-4-5': { in: 3,    out: 15  },
  'claude-haiku-4-5':  { in: 1,    out: 5   }
};

// Friendly labels mirror the front-end AGENT_LABELS. Emojis stay
// here because these are server-rendered strings used in admin
// summaries / log lines — the page-wide icon swapper doesn't reach
// them. Front-end UIs that want SVG icons render them inline via
// p86Icon() at the call site.
// Display labels keyed by AGENT IDENTITY, not entity_type. 86 is one
// Phase 1 collapsed every agent identity into the unified 86. The
// former directory agent (HR) and Chief of Staff used to live here as
// separate buckets; both folded in. Anything still landing in 'hr' /
// 'staff' rows from old data rolls up to '86' via
// ENTITY_TYPE_TO_AGENT_SQL below.
const AGENT_LABELS = {
  '86': '86'
};

// Map raw entity_type values in ai_messages to a logical agent
// identity. Post-Phase-1, every entity_type that used to split into
// the directory surface or Chief of Staff (client / staff) folds back into the single
// unified 86 identity. Kept as a SQL CASE generator + a JS helper so
// the metrics aggregation and any client-side rollup stay in sync.
const ENTITY_TYPE_TO_AGENT_SQL = `
  CASE
    WHEN entity_type IN ('estimate', 'job', 'intake', 'ask86', '86', 'client', 'staff') THEN '86'
    ELSE entity_type
  END
`;
function entityTypeToAgent(entityType) {
  if (['estimate', 'job', 'intake', 'ask86', '86', 'client', 'staff'].includes(entityType)) return '86';
  return entityType;
}

function costFor(model, inputTokens, outputTokens) {
  const p = MODEL_COSTS[model];
  if (!p) return null;
  const inCost  = (Number(inputTokens  || 0) / 1_000_000) * p.in;
  const outCost = (Number(outputTokens || 0) / 1_000_000) * p.out;
  return inCost + outCost;
}

// GET /api/admin/agents/metrics?range=7d|30d
//
// Returns an aggregate snapshot per entity_type (estimate / job / client)
// for the requested window. Numbers are computed in one SQL pass for
// speed — even on a chatty deployment ai_messages stays small enough
// that a full table scan is fine for the admin window.
router.get('/metrics',
  requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg,
  async (req, res) => {
  try {
    const range = (req.query.range === '30d') ? '30 days' : '7 days';
    const orgId = req.organization.id;

    // Phase 1 unified the directory surface + Chief of Staff into 86 — every entity_type
    // below now feeds the single 86 agent. The card UI surfaces one
    // big metrics block with a "by surface" breakdown inside.
    const ENTITY_TYPES_FOR_86 = ['estimate', 'job', 'intake', 'ask86', '86', 'client', 'staff'];

    const aggSql = `
      SELECT
        COUNT(*) FILTER (WHERE role = 'assistant')                AS turns,
        COUNT(*) FILTER (WHERE role = 'user')                     AS user_msgs,
        COUNT(DISTINCT (entity_type, estimate_id, user_id))       AS conversations,
        COUNT(DISTINCT user_id)                                   AS unique_users,
        COALESCE(SUM(input_tokens),  0)::bigint                   AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint                   AS output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0)::bigint     AS cache_creation_tokens,
        COALESCE(SUM(cache_read_input_tokens),     0)::bigint     AS cache_read_tokens,
        COALESCE(SUM(tool_use_count), 0)::bigint                  AS tool_uses,
        COALESCE(SUM(photos_included), 0)::bigint                 AS photos_attached
      FROM ai_messages
      WHERE created_at >= NOW() - INTERVAL '${range}'
        AND entity_type = ANY($1)
    `;
    const aggRes = await pool.query(aggSql, [ENTITY_TYPES_FOR_86]);
    const agg = aggRes.rows[0] || {};

    // Surface breakdown — how 86 is being used: estimate panel vs
    // job WIP vs intake vs ask86 vs older directory (client) / CoS (staff)
    // entry points. Useful for spotting which workflows actually drive
    // usage.
    const surfaceSql = `
      SELECT
        entity_type,
        COUNT(*) FILTER (WHERE role = 'assistant')                AS turns,
        COUNT(DISTINCT (estimate_id, user_id))                    AS conversations,
        COALESCE(SUM(input_tokens),  0)::bigint                   AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint                   AS output_tokens
      FROM ai_messages
      WHERE created_at >= NOW() - INTERVAL '${range}'
        AND entity_type = ANY($1)
      GROUP BY entity_type
      ORDER BY turns DESC
    `;
    const surfaceRes = await pool.query(surfaceSql, [ENTITY_TYPES_FOR_86]);

    // Tool breakdown — pull tool_use names out of the JSONB array.
    // Only counts approval-tier proposals (auto-tier reads aren't
    // persisted per-call). Top 15 by frequency.
    const toolSql = `
      SELECT
        (jsonb_array_elements(tool_uses)->>'name') AS tool_name,
        COUNT(*) AS uses
      FROM ai_messages
      WHERE created_at >= NOW() - INTERVAL '${range}'
        AND tool_uses IS NOT NULL
        AND jsonb_typeof(tool_uses) = 'array'
        AND entity_type = ANY($1)
      GROUP BY tool_name
      ORDER BY uses DESC
      LIMIT 15
    `;
    const toolRes = await pool.query(toolSql, [ENTITY_TYPES_FOR_86]);

    // Model-mix breakdown.
    const modelSql = `
      SELECT
        COALESCE(model, 'unknown') AS model,
        COUNT(*) FILTER (WHERE role = 'assistant') AS turns,
        COALESCE(SUM(input_tokens),  0)::bigint AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
      FROM ai_messages
      WHERE created_at >= NOW() - INTERVAL '${range}'
        AND role = 'assistant'
        AND entity_type = ANY($1)
      GROUP BY model
      ORDER BY turns DESC
    `;
    const modelRes = await pool.query(modelSql, [ENTITY_TYPES_FOR_86]);

    // Phase 3 subtask rollup retired — fan-out replaced by native
    // parallel tool calls within one session. The ai_subtasks table
    // is preserved for historical reads but no longer populated.
    const sub = { total: 0, completed: 0, failed: 0, in_flight: 0, input_tokens: 0, output_tokens: 0 };

    // Phase 4 — memory counts (active + recently saved).
    const memorySql = `
      SELECT
        COUNT(*) FILTER (WHERE archived_at IS NULL)::int                                              AS active,
        COUNT(*) FILTER (WHERE archived_at IS NULL AND created_at >= NOW() - INTERVAL '${range}')::int AS recent_saves,
        COUNT(*) FILTER (WHERE archived_at IS NULL AND last_recalled_at >= NOW() - INTERVAL '${range}')::int AS recent_recalls
      FROM ai_memories
      WHERE organization_id = $1
    `;
    const memoryRes = await pool.query(memorySql, [orgId]);
    const mem = memoryRes.rows[0] || {};

    // Phase 5 — watch configuration + run rollup.
    const watchSql = `
      SELECT
        COUNT(*) FILTER (WHERE enabled = true AND archived_at IS NULL)::int AS active,
        COUNT(*) FILTER (WHERE archived_at IS NULL)::int                    AS configured
      FROM ai_watches
      WHERE organization_id = $1
    `;
    const watchRes = await pool.query(watchSql, [orgId]);
    const watch = watchRes.rows[0] || {};

    const watchRunsSql = `
      SELECT
        COUNT(*)::int                                       AS runs,
        COUNT(*) FILTER (WHERE status = 'completed')::int   AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::int      AS failed,
        COALESCE(SUM(input_tokens),  0)::bigint             AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint             AS output_tokens
      FROM ai_watch_runs
      WHERE organization_id = $1
        AND triggered_at >= NOW() - INTERVAL '${range}'
    `;
    const watchRunsRes = await pool.query(watchRunsSql, [orgId]);
    const watchRuns = watchRunsRes.rows[0] || {};

    // MCP servers — Phase 6.
    const mcpSql = `
      SELECT
        COUNT(*) FILTER (WHERE enabled = true AND archived_at IS NULL)::int AS active,
        COUNT(*) FILTER (WHERE archived_at IS NULL)::int                    AS configured
      FROM org_mcp_servers
      WHERE organization_id = $1
    `;
    const mcpRes = await pool.query(mcpSql, [orgId]);
    const mcp = mcpRes.rows[0] || {};

    // Compose the rich 86 payload.
    const models = modelRes.rows.map(r => ({
      model: r.model,
      turns: Number(r.turns),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cost_usd: costFor(r.model, r.input_tokens, r.output_tokens)
    }));
    const totalCost = models.reduce((s, m) => s + (m.cost_usd || 0), 0);
    const subtaskCost = 0; // Phase 3 subtasks retired — fan-out replaced by native parallel tool calls.
    const watchCost = costFor('claude-opus-4-7', watchRuns.input_tokens, watchRuns.output_tokens);

    const cacheReads = Number(agg.cache_read_tokens || 0);
    const directInputs = Number(agg.input_tokens || 0);
    const cacheRatio = (cacheReads + directInputs) > 0
      ? cacheReads / (cacheReads + directInputs)
      : 0;

    const agent86 = {
      label: '86',
      turns: Number(agg.turns || 0),
      user_msgs: Number(agg.user_msgs || 0),
      conversations: Number(agg.conversations || 0),
      unique_users: Number(agg.unique_users || 0),
      photos_attached: Number(agg.photos_attached || 0),
      tool_uses: Number(agg.tool_uses || 0),
      tokens: {
        input: directInputs,
        output: Number(agg.output_tokens || 0),
        cache_creation: Number(agg.cache_creation_tokens || 0),
        cache_read: cacheReads,
        cache_hit_ratio: cacheRatio
      },
      cost_usd: totalCost,
      surfaces: surfaceRes.rows.map(r => ({
        entity_type: r.entity_type,
        turns: Number(r.turns),
        conversations: Number(r.conversations),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens)
      })),
      tools_top: toolRes.rows.map(r => ({ name: r.tool_name, uses: Number(r.uses) })),
      models,
      subtasks: {
        total: Number(sub.total || 0),
        completed: Number(sub.completed || 0),
        failed: Number(sub.failed || 0),
        in_flight: Number(sub.in_flight || 0),
        input_tokens: Number(sub.input_tokens || 0),
        output_tokens: Number(sub.output_tokens || 0),
        cost_usd: subtaskCost
      },
      memory: {
        active: Number(mem.active || 0),
        recent_saves: Number(mem.recent_saves || 0),
        recent_recalls: Number(mem.recent_recalls || 0)
      },
      watches: {
        active: Number(watch.active || 0),
        configured: Number(watch.configured || 0),
        runs: Number(watchRuns.runs || 0),
        runs_completed: Number(watchRuns.completed || 0),
        runs_failed: Number(watchRuns.failed || 0),
        input_tokens: Number(watchRuns.input_tokens || 0),
        output_tokens: Number(watchRuns.output_tokens || 0),
        cost_usd: watchCost
      },
      mcp_servers: {
        active: Number(mcp.active || 0),
        configured: Number(mcp.configured || 0)
      }
    };

    // Backwards-compat: keep the `agents` array shape but emit a single
    // 86 entry derived from the rich object. Any consumer still on the
    // old shape (renderAgentMetricsCard fallback) keeps working.
    const agents = [{
      entity_type: '86',
      label: '86',
      turns: agent86.turns,
      user_msgs: agent86.user_msgs,
      conversations: agent86.conversations,
      unique_users: agent86.unique_users,
      input_tokens: agent86.tokens.input,
      output_tokens: agent86.tokens.output,
      tool_uses: agent86.tool_uses,
      photos_attached: agent86.photos_attached,
      models: agent86.models
    }];

    res.json({ range, agents, agent86 });
  } catch (e) {
    console.error('GET /api/admin/agents/metrics error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Subtask fan-out retired — endpoint kept as a stable 410 so any
// admin UI that still polls it gets a clean answer.
router.get('/subtasks/recent',
  requireAuth, requireCapability('ROLES_MANAGE'),
  (req, res) => res.json({ subtasks: [], rollup: {}, range: '7 days', retired: true })
);

// Lists recent conversations grouped by (entity_type, estimate_id,
// user_id). Each row carries the most recent activity timestamp,
// turn count, total tokens, and the entity's display title (looked up
// from estimates / jobs / clients depending on entity_type).
router.get('/conversations', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const range = (req.query.range === '30d') ? '30 days' : '7 days';
    const entityType = req.query.entity_type;
    const userIdFilter = req.query.user_id ? Number(req.query.user_id) : null;
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

    const params = [];
    const conds = [`created_at >= NOW() - INTERVAL '${range}'`];
    if (entityType) {
      params.push(entityType);
      conds.push(`entity_type = $${params.length}`);
    }
    if (userIdFilter) {
      params.push(userIdFilter);
      conds.push(`user_id = $${params.length}`);
    }

    // Group on the conversation key, get the rollups, then enrich
    // with entity titles and user emails in two separate lookups.
    const rollupSql = `
      SELECT
        entity_type,
        estimate_id AS entity_id,
        user_id,
        COUNT(*) FILTER (WHERE role = 'assistant') AS turns,
        COUNT(*) FILTER (WHERE role = 'user')      AS user_msgs,
        MAX(created_at)                            AS last_at,
        MIN(created_at)                            AS first_at,
        COALESCE(SUM(input_tokens),  0)::bigint    AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint    AS output_tokens,
        COALESCE(SUM(tool_use_count), 0)::bigint   AS tool_uses,
        STRING_AGG(DISTINCT model, ',')            AS models
      FROM ai_messages
      WHERE ${conds.join(' AND ')}
      GROUP BY entity_type, estimate_id, user_id
      ORDER BY MAX(created_at) DESC
      LIMIT ${limit}
    `;
    const rollup = await pool.query(rollupSql, params);
    const rows = rollup.rows;

    // Bulk-fetch user emails (small set, even on a chatty deployment).
    const userIds = [...new Set(rows.map(r => r.user_id).filter(x => x != null))];
    const userMap = new Map();
    if (userIds.length) {
      const uRes = await pool.query(
        `SELECT id, email, name FROM users WHERE id = ANY($1::int[])`,
        [userIds]
      );
      uRes.rows.forEach(u => userMap.set(u.id, u));
    }

    // Bulk-fetch entity titles per type — split by entity_type so we
    // hit the right table.
    const entityTitleByKey = new Map(); // `${type}|${id}` → title
    const groupBy = (key) => {
      const out = new Map();
      for (const r of rows) {
        if (r.entity_type !== key) continue;
        out.set(r.entity_id, true);
      }
      return [...out.keys()];
    };
    const estIds = groupBy('estimate');
    if (estIds.length) {
      // estimates / jobs store everything in a JSONB `data` column —
      // title and name are NOT top-level columns. Extract via ->>.
      const r = await pool.query(`SELECT id, data->>'title' AS title FROM estimates WHERE id = ANY($1::text[])`, [estIds]);
      r.rows.forEach(x => entityTitleByKey.set('estimate|' + x.id, x.title));
    }
    const jobIds = groupBy('job');
    if (jobIds.length) {
      // jobs.id is text in this schema; same lookup pattern.
      const r = await pool.query(
        `SELECT id, COALESCE(NULLIF(data->>'name', ''), NULLIF(data->>'jobName', ''), 'Job ' || id) AS title FROM jobs WHERE id = ANY($1::text[])`,
        [jobIds]
      );
      r.rows.forEach(x => entityTitleByKey.set('job|' + x.id, x.title));
    }
    // Client mode is "global" — entity_id is the literal "__global__"
    // sentinel. No title lookup needed.

    const conversations = rows.map(r => {
      const u = userMap.get(r.user_id);
      const titleKey = r.entity_type + '|' + r.entity_id;
      const title = entityTitleByKey.get(titleKey)
        || (r.entity_id === '__global__' ? 'Customer directory' : r.entity_id);
      const cost = (() => {
        const models = (r.models || '').split(',').filter(Boolean);
        if (models.length === 1) return costFor(models[0], r.input_tokens, r.output_tokens);
        // Mixed models — give the average list price across them so
        // the number is still indicative.
        const known = models.map(m => MODEL_COSTS[m]).filter(Boolean);
        if (!known.length) return null;
        const avgIn  = known.reduce((s, p) => s + p.in,  0) / known.length;
        const avgOut = known.reduce((s, p) => s + p.out, 0) / known.length;
        return (Number(r.input_tokens) / 1_000_000) * avgIn
             + (Number(r.output_tokens) / 1_000_000) * avgOut;
      })();
      return {
        key: [r.entity_type, r.entity_id, r.user_id].join('|'),
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        entity_title: title,
        user_id: r.user_id,
        user_email: u ? u.email : null,
        user_name: u ? u.name : null,
        turns: Number(r.turns),
        user_msgs: Number(r.user_msgs),
        first_at: r.first_at,
        last_at: r.last_at,
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        tool_uses: Number(r.tool_uses),
        models: (r.models || '').split(',').filter(Boolean),
        cost_usd: cost
      };
    });

    res.json({ range, conversations, total: conversations.length });
  } catch (e) {
    console.error('GET /api/admin/agents/conversations error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/agents/conversations/:key
//
// Full message log for one conversation. Key is the same entity_type|
// entity_id|user_id triple from the list endpoint, joined with pipes.
// Returns messages in chronological order with redacted body — we trim
// each message to MAX_BODY_BYTES so the response stays snappy on a
// 200-turn audit thread.
const MAX_BODY_BYTES = 16 * 1024;
router.get('/conversations/:key', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const parts = String(req.params.key || '').split('|');
    if (parts.length !== 3) return res.status(400).json({ error: 'Bad key — expected entity_type|entity_id|user_id' });
    const [entityType, entityId, userIdRaw] = parts;
    const userId = Number(userIdRaw);
    if (!entityType || !entityId || !Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Bad key — non-numeric user_id or missing parts' });
    }

    const r = await pool.query(
      `SELECT id, role, content, model, input_tokens, output_tokens,
              cache_creation_input_tokens, cache_read_input_tokens,
              packs_loaded,
              tool_use_count, photos_included, created_at
         FROM ai_messages
        WHERE entity_type = $1 AND estimate_id = $2 AND user_id = $3
        ORDER BY created_at ASC`,
      [entityType, entityId, userId]
    );

    const messages = r.rows.map(m => {
      let body = m.content || '';
      if (typeof body === 'string' && body.length > MAX_BODY_BYTES) {
        body = body.slice(0, MAX_BODY_BYTES) + '\n\n[...truncated]';
      }
      return {
        id: m.id,
        role: m.role,
        content: body,
        model: m.model,
        input_tokens: m.input_tokens,
        output_tokens: m.output_tokens,
        cache_creation_input_tokens: m.cache_creation_input_tokens,
        cache_read_input_tokens: m.cache_read_input_tokens,
        packs_loaded: m.packs_loaded || null,
        tool_use_count: m.tool_use_count,
        photos_included: m.photos_included,
        created_at: m.created_at
      };
    });

    // Lookup the user + entity title for the header.
    const uRes = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [userId]);
    const user = uRes.rows[0] || null;
    let entityTitle = entityId;
    if (entityType === 'estimate') {
      const e = await pool.query(`SELECT data->>'title' AS title FROM estimates WHERE id = $1`, [entityId]);
      if (e.rows[0]) entityTitle = e.rows[0].title || entityId;
    } else if (entityType === 'job') {
      const j = await pool.query(`SELECT COALESCE(NULLIF(data->>'name', ''), NULLIF(data->>'jobName', ''), 'Job ' || id) AS title FROM jobs WHERE id = $1`, [entityId]);
      if (j.rows[0]) entityTitle = j.rows[0].title || entityId;
    } else if (entityId === '__global__' || entityId === 'global') {
      entityTitle = entityType === 'staff' ? 'Chief of Staff' : 'Customer directory';
    }

    res.json({
      key: req.params.key,
      entity_type: entityType,
      entity_id: entityId,
      entity_title: entityTitle,
      user_id: userId,
      user_email: user ? user.email : null,
      user_name: user ? user.name : null,
      messages
    });
  } catch (e) {
    console.error('GET /api/admin/agents/conversations/:key error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Eval harness
// ══════════════════════════════════════════════════════════════════════
// Curated fixtures replayed against AG to catch regressions when
// prompts / models / skill packs change. Today only `estimate_draft`
// kind is supported — fixture references a real estimate id; runner
// rebuilds AG's normal context, sends a known user prompt, captures
// tool_use proposals + assistant text, and scores against
// expected_signals (line count range, must-mention keywords, must-
// have section names).
//
// Approach: reuse buildEstimateContext from ai-routes by lazy-requiring
// it. The fixture estimate must exist in the DB (drop a fixture by
// pointing at a finalized estimate's id).
// ══════════════════════════════════════════════════════════════════════
const { Anthropic } = require('@anthropic-ai/sdk');
let _anth = null;
function getAnthropic() {
  if (_anth) return _anth;
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  _anth = new Anthropic({ apiKey: key });
  return _anth;
}

// Pull the AG context builder + tools from the same module that powers
// production AG via a tiny shim (./ai-routes-internals). Lazy required
// inside the run handler to avoid load-time circulars.

// GET /api/admin/agents/config — returns the live agent runtime config
// (model + effort) the server is using. Read straight from the same
// internals that production 86 (every surface) consults on every chat turn,
// so a non-null effort or non-default model here means the env vars
// genuinely took effect on this deployment. Surfaced as a "Server
// config" badge on the Agents page so the user can verify env flips
// without having to open a chat and read a model name from a metric.
router.get('/config', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const aiInternals = require('./ai-routes-internals');
    if (!aiInternals) throw new Error('ai-routes internals not available.');
    const model = aiInternals.defaultModel();
    // Resolve effort the same way every chat turn does — passes the
    // resolved model so we get the same null-or-string production gets.
    const effort = aiInternals.effortFor(model, null);
    res.json({
      model,
      effort,
      env: {
        AI_MODEL: process.env.AI_MODEL || null,
        AI_EFFORT: process.env.AI_EFFORT || null
      }
    });
  } catch (e) {
    console.error('GET /api/admin/agents/config error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// ──── Skill-pack version history ─────────────────────────────────
//
// Every PUT /api/settings/agent_skills snapshots the PRIOR value into
// agent_skills_versions before overwriting. These endpoints let the
// admin see the snapshot list, view a specific version's full body,
// and restore (= re-save) a prior version.

// GET /api/admin/agents/skills/versions
//   Returns most recent N versions (default 50). Each row carries
//   saved_at + saved_by name + comment + skill count summary.
router.get('/skills/versions', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const r = await pool.query(
      `SELECT v.id, v.saved_at, v.comment,
              v.value->'skills' AS skills,
              u.name AS saved_by_name, u.email AS saved_by_email
         FROM agent_skills_versions v
         LEFT JOIN users u ON u.id = v.saved_by
        ORDER BY v.saved_at DESC
        LIMIT $1`,
      [limit]
    );
    const rows = r.rows.map(x => ({
      id: x.id,
      saved_at: x.saved_at,
      saved_by_name: x.saved_by_name,
      saved_by_email: x.saved_by_email,
      comment: x.comment,
      skill_count: Array.isArray(x.skills) ? x.skills.length : 0
    }));
    res.json({ versions: rows });
  } catch (e) {
    console.error('GET /api/admin/agents/skills/versions error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/agents/skills/versions/:id
//   Returns the full snapshot for one version.
router.get('/skills/versions/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT v.id, v.saved_at, v.comment, v.value,
              u.name AS saved_by_name, u.email AS saved_by_email
         FROM agent_skills_versions v
         LEFT JOIN users u ON u.id = v.saved_by
        WHERE v.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Version not found' });
    res.json({ version: r.rows[0] });
  } catch (e) {
    console.error('GET /api/admin/agents/skills/versions/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/agents/skills/versions/:id/restore
//   Re-applies the snapshot's value as the current agent_skills config.
//   The current value gets snapshotted first (via the PUT path's
//   snapshot side-effect — restore round-trips through PUT).
router.post('/skills/versions/:id/restore', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT value FROM agent_skills_versions WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Version not found' });
    // Snapshot the current value first so the restore is itself
    // reversible. Mirrors the PUT path's snapshot logic so we don't
    // depend on cross-route side effects.
    const prior = await pool.query(`SELECT value FROM app_settings WHERE key = 'agent_skills'`);
    if (prior.rows.length) {
      await pool.query(
        `INSERT INTO agent_skills_versions (saved_by, value, comment)
         VALUES ($1, $2::jsonb, $3)`,
        [req.user.id, JSON.stringify(prior.rows[0].value), 'Auto-snapshot before restore of v' + req.params.id]
      );
    }
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('agent_skills', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(r.rows[0].value)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/admin/agents/skills/versions/:id/restore error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──── Native Skills migration (sync local packs → Anthropic) ─────
//
// Anthropic's native Skills primitive expects directory bundles with a
// SKILL.md file at the root. We package each local pack body as a
// single-file SKILL.md and upload via beta.skills.create. The
// returned skill_id is persisted onto the local pack so the admin
// UI can show a "synced" badge and avoid re-uploading.
//
// IMPORTANT: this only mirrors packs to Anthropic. The chat path
// (messages.stream) doesn't load Skills at runtime — that requires
// migrating to beta.agents which is a separate workstream. For now
// local packs remain the source of truth.

// Reuses the Anthropic client + getAnthropic() defined earlier in this
// file for the eval runner. toFile is the SDK's helper for wrapping a
// Buffer as an Uploadable for beta.skills.create.
const { toFile } = require('@anthropic-ai/sdk');

// Build the SKILL.md content for one pack. Anthropic Skills typically
// open with YAML frontmatter declaring name + description so the
// loading runtime can decide when to fetch the skill body. We include
// both even though our current pack model doesn't separate them — the
// pack name doubles as the description for now.
function slugifySkillName(s) {
  return String(s || 'skill')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
}

function buildSkillMarkdown(pack) {
  const slug = slugifySkillName(pack.name);
  const human = (pack.name || 'Project 86 skill').replace(/[\r\n]/g, ' ');
  const desc = (pack.replaces_section
    ? 'Section override for ' + pack.replaces_section
    : (pack.category ? 'Category: ' + pack.category : human)
  ).replace(/[\r\n]/g, ' ');
  const lines = [
    '---',
    'name: ' + slug,
    'description: ' + desc,
    '---',
    '',
    pack.body || ''
  ];
  return lines.join('\n');
}

// POST /api/admin/agents/skills/sync-all-to-anthropic
//   For each local pack without anthropic_skill_id, packages SKILL.md,
//   uploads via beta.skills.create, persists the returned id back into
//   the agent_skills row. Returns per-pack summary.
router.post('/skills/sync-all-to-anthropic', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

    const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'agent_skills'`);
    if (!r.rows.length) return res.json({ summary: [], note: 'No skill packs to sync.' });
    const cfg = r.rows[0].value || {};
    const skills = Array.isArray(cfg.skills) ? cfg.skills.slice() : [];
    if (!skills.length) return res.json({ summary: [], note: 'No skill packs to sync.' });

    const summary = [];
    for (let i = 0; i < skills.length; i++) {
      const pack = skills[i];
      if (pack.anthropic_skill_id) {
        summary.push({ idx: i, name: pack.name, status: 'already_synced', anthropic_skill_id: pack.anthropic_skill_id });
        continue;
      }
      try {
        const md = buildSkillMarkdown(pack);
        const slug = slugifySkillName(pack.name);
        const file = await toFile(Buffer.from(md, 'utf8'), 'SKILL.md', { type: 'text/markdown' });
        const created = await anthropic.beta.skills.create({
          display_title: (pack.name || 'Project 86 skill').slice(0, 200),
          files: [file]
        });
        // Persist the returned id back onto the local pack. Mutating
        // skills[i] then writing the whole row preserves admin edits
        // on other packs (no race because admin is single-user).
        skills[i] = Object.assign({}, pack, { anthropic_skill_id: created.id });
        summary.push({ idx: i, name: pack.name, status: 'synced', anthropic_skill_id: created.id });
      } catch (e) {
        summary.push({ idx: i, name: pack.name, status: 'failed', error: e.message });
      }
    }

    // Single write at the end — only persist if at least one pack
    // changed. Avoids generating a snapshot version when no syncs
    // landed.
    const newSyncs = summary.filter(s => s.status === 'synced').length;
    if (newSyncs > 0) {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('agent_skills', $1::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(Object.assign({}, cfg, { skills }))]
      );
    }

    res.json({ summary, synced: newSyncs });
  } catch (e) {
    console.error('POST /api/admin/agents/skills/sync-all-to-anthropic error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/agents/skills/:idx/sync-to-anthropic
//   Sync one specific pack by its array index. Useful for debugging
//   a sync failure or refreshing a single pack after an edit.
router.post('/skills/:idx/sync-to-anthropic', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

    const idx = parseInt(req.params.idx, 10);
    if (!Number.isFinite(idx) || idx < 0) return res.status(400).json({ error: 'idx must be a non-negative integer.' });

    const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'agent_skills'`);
    if (!r.rows.length) return res.status(404).json({ error: 'No skill packs row exists.' });
    const cfg = r.rows[0].value || {};
    const skills = Array.isArray(cfg.skills) ? cfg.skills.slice() : [];
    if (idx >= skills.length) return res.status(404).json({ error: 'idx out of range.' });

    const pack = skills[idx];
    const md = buildSkillMarkdown(pack);
    const slug = slugifySkillName(pack.name);
    const file = await toFile(Buffer.from(md, 'utf8'), 'SKILL.md', { type: 'text/markdown' });
    const created = await anthropic.beta.skills.create({
      display_title: (pack.name || 'Project 86 skill').slice(0, 200),
      files: [file]
    });
    skills[idx] = Object.assign({}, pack, { anthropic_skill_id: created.id });
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('agent_skills', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(Object.assign({}, cfg, { skills }))]
    );
    res.json({ ok: true, anthropic_skill_id: created.id });
  } catch (e) {
    console.error('POST /api/admin/agents/skills/:idx/sync-to-anthropic error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/agents/skills/:idx/unsync-from-anthropic
//   Delete the Anthropic-side skill and clear the local id. Useful
//   when re-syncing after a body edit (delete + sync = fresh upload
//   with the new content). Future enhancement: use beta.skills
//   .versions to push a new version instead of full delete-recreate.
router.post('/skills/:idx/unsync-from-anthropic', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

    const idx = parseInt(req.params.idx, 10);
    if (!Number.isFinite(idx) || idx < 0) return res.status(400).json({ error: 'idx must be a non-negative integer.' });

    const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'agent_skills'`);
    if (!r.rows.length) return res.status(404).json({ error: 'No skill packs row exists.' });
    const cfg = r.rows[0].value || {};
    const skills = Array.isArray(cfg.skills) ? cfg.skills.slice() : [];
    if (idx >= skills.length) return res.status(404).json({ error: 'idx out of range.' });

    const pack = skills[idx];
    if (!pack.anthropic_skill_id) return res.status(400).json({ error: 'Pack is not currently synced.' });

    // Delete on the Anthropic side. If that fails (e.g. already
    // deleted out-of-band), still clear the local id so the next
    // sync makes a fresh one.
    let deleteError = null;
    try {
      await anthropic.beta.skills.delete(pack.anthropic_skill_id);
    } catch (e) {
      deleteError = e.message;
    }

    const updated = Object.assign({}, pack);
    delete updated.anthropic_skill_id;
    skills[idx] = updated;
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('agent_skills', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(Object.assign({}, cfg, { skills }))]
    );
    res.json({ ok: true, delete_error: deleteError });
  } catch (e) {
    console.error('POST /api/admin/agents/skills/:idx/unsync-from-anthropic error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/agents/skills/run-all-evals
//   Runs every saved AI eval against the current live config and
//   returns a summary { eval_id, name, passed, duration_ms, error? }.
//   Used as a post-save validation step in the Skills editor — the
//   admin saves their edits then clicks "Run all evals" to verify
//   nothing regressed. Each eval costs a real Anthropic API call so
//   this is manual-trigger, not automatic on every save.
//
// Sequential execution (not Promise.all) — keeps the cost predictable
// and lets the admin see partial progress as the response chunks
// (future enhancement: SSE-style streaming summary).
router.post('/skills/run-all-evals', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const evalsRes = await pool.query(
      `SELECT id, name, kind FROM ai_evals ORDER BY name`
    );
    if (!evalsRes.rows.length) {
      return res.json({ summary: [], note: 'No evals defined yet — add at least one fixture in Admin → Agents → Evals.' });
    }

    // Reuse the existing per-eval run logic by hitting the local
    // /evals/:id/run handler in-process. To stay decoupled from
    // route internals we pull the runner out here as a small helper.
    // Keeps the sequential semantics: one Anthropic call at a time so
    // burst cost is predictable.
    const summary = [];
    for (const ev of evalsRes.rows) {
      const t0 = Date.now();
      try {
        // Lazy-require + reuse the eval-run path. Easier than HTTP-loop.
        // We rebuild the request shape the run handler expects, capture
        // the response body via a fake res-like sink, then unpack.
        const fakeRes = makeJsonSink();
        await runOneEvalById(req, fakeRes, ev.id);
        const body = fakeRes._body || {};
        summary.push({
          eval_id: ev.id,
          name: ev.name,
          passed: !!body.passed,
          duration_ms: Date.now() - t0,
          score: body.score || null,
          run_id: body.run_id || null
        });
      } catch (e) {
        summary.push({
          eval_id: ev.id,
          name: ev.name,
          passed: false,
          duration_ms: Date.now() - t0,
          error: e.message || 'unknown'
        });
      }
    }
    res.json({ summary });
  } catch (e) {
    console.error('POST /api/admin/agents/skills/run-all-evals error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// In-memory JSON sink that mimics the subset of express.Response the
// per-eval run handler uses (status() + json()). Lets the batch runner
// invoke the same handler in-process without HTTP-looping.
function makeJsonSink() {
  return {
    statusCode: 200,
    _body: null,
    status: function(code) { this.statusCode = code; return this; },
    json: function(body) { this._body = body; return this; }
  };
}

// Local helper used by run-all-evals — calls the existing per-eval
// run handler with a synthetic params shape. The handler is registered
// later in this file so we bind to it through the router stack at
// invocation time rather than hoisting the logic.
async function runOneEvalById(req, fakeRes, evalId) {
  // Build a synthetic Express req for the per-eval handler. Everything
  // the handler reads off req.* must be present here.
  const synthReq = {
    user: req.user,
    params: { id: evalId },
    body: req.body || {},
    headers: req.headers || {},
    query: {}
  };
  // The per-eval handler is the second item registered for the path.
  // Find it by route lookup. Express stores handlers in router.stack.
  const layer = router.stack.find(l =>
    l.route && l.route.path === '/evals/:id/run' && l.route.methods && l.route.methods.post
  );
  if (!layer) throw new Error('Per-eval run handler not registered yet.');
  // The handler is the LAST middleware in the route stack (the actual
  // async function we wrote earlier). requireAuth + requireCapability
  // are earlier; skip them — caller already passed those for the batch
  // request. Run the actual handler directly.
  const stack = layer.route.stack;
  const handler = stack[stack.length - 1].handle;
  await handler(synthReq, fakeRes, () => {});
}

// GET /api/admin/agents/sections?agent=ag|elle|hr|cos
//   Returns the list of admin-overridable named sections for the
//   requested agent, with each section's stable id, description,
//   and default body. The skill-pack editor uses this to populate
//   the "Replaces section" dropdown — when an admin sets that field
//   on a pack, the pack's body substitutes for the section default
//   at render time.
router.get('/sections', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const aiInternals = require('./ai-routes-internals');
    if (!aiInternals || typeof aiInternals.sectionsForAgent !== 'function') {
      return res.json({ sections: [] });
    }
    const agent = String(req.query.agent || '').toLowerCase();
    if (!agent) return res.status(400).json({ error: 'agent is required' });
    res.json({ sections: aiInternals.sectionsForAgent(agent) });
  } catch (e) {
    console.error('GET /api/admin/agents/sections error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// GET /api/admin/agents/preview-prompt
//   ?surface=estimate|job|client|admin   — required. Which surface
//                                           context to assemble.
//   ?estimate_id=<id>                    — required when surface=estimate
//   ?job_id=<id>                         — required when surface=job
//
// Returns the EXACT system-prompt blocks 86 would see right now if a
// chat turn were initiated on the supplied surface. The legacy
// `agent` query param + agent-name values (ag/elle/hr/cos) are still
// accepted for back-compat — they map to surface values:
//   ag   → estimate   elle → job
//   hr   → client     cos  → admin
//
// Returns:
//   - stable_prefix: cached playbook (identity / structure / tools /
//     slotting / etc.) — token-counted so admin can see what % of the
//     turn is cacheable.
//   - dynamic_context: per-turn estimate / job / client data (refreshed
//     each turn — never cached).
//   - tools: list of tool names available on this surface in this phase.
//   - skill_packs: which packs from app_settings.agent_skills appear
//     in the manifest for this surface.
//   - ai_phase: 'plan' | 'build' (when applicable).
//
// Read-only, no side effects on conversation history.
router.get('/preview-prompt', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const aiInternals = require('./ai-routes-internals');
    if (!aiInternals) throw new Error('ai-routes internals not available.');
    // Accept `surface` (canonical) or `agent` (legacy). Normalize legacy
    // agent-name values to surface keys.
    const rawSurface = String(req.query.surface || req.query.agent || '').toLowerCase();
    const surface = ({
      ag: 'estimate', estimate: 'estimate',
      elle: 'job',   job: 'job',
      hr: 'client',  cra: 'client', client: 'client',
      cos: 'admin',  staff: 'admin', admin: 'admin'
    })[rawSurface] || rawSurface;
    let systemBlocks = null;
    let toolNames = [];
    let aiPhase = null;
    let entityLabel = null;
    let skillPackNames = [];

    // Helpers to count approximate tokens so the admin sees the cost
    // breakdown. Crude (chars / 4) — accurate enough for "is this
    // 5K or 50K".
    function approxTokens(s) {
      if (!s) return 0;
      return Math.round(String(s).length / 4);
    }

    // Look up which always-on packs would load for this agent so the
    // admin can see them as their own block. Mirrors loadActiveSkillsFor
    // but returns names + bodies for display.
    async function loadPackNamesFor(agentKey) {
      const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'agent_skills'`);
      if (!r.rows.length) return [];
      const cfg = r.rows[0].value || {};
      const skills = Array.isArray(cfg.skills) ? cfg.skills : [];
      return skills
        .filter(s => s && s.alwaysOn !== false && Array.isArray(s.agents) && s.agents.indexOf(agentKey) >= 0 && s.body)
        .map(s => ({ name: s.name || '(untitled)', tokens: approxTokens(s.body) }));
    }

    if (surface === 'estimate') {
      const estimateId = req.query.estimate_id;
      if (!estimateId) return res.status(400).json({ error: 'estimate_id is required for surface=estimate' });
      const ctx = await aiInternals.buildEstimateContext(estimateId, false);
      systemBlocks = ctx.system;
      aiPhase = ctx.aiPhase;
      const toolList = aiInternals.estimateTools();
      // Plan-mode filter mirrors what the chat handler does so the
      // preview shows the actual tool subset 86 would have on this turn.
      const filtered = (aiPhase === 'plan')
        ? toolList.filter(t => [
            'web_search', 'propose_update_scope', 'propose_add_client_note',
            'read_materials', 'read_purchase_history', 'read_subs', 'read_lead_pipeline',
            'read_clients', 'read_leads', 'read_past_estimate_lines', 'read_past_estimates'
          ].indexOf(t.name) !== -1)
        : toolList;
      toolNames = filtered.map(t => t.name);
      const eRow = await pool.query("SELECT data->>'title' AS title FROM estimates WHERE id = $1", [estimateId]);
      entityLabel = eRow.rows.length ? (eRow.rows[0].title || estimateId) : estimateId;
      skillPackNames = await loadPackNamesFor('job');
    } else if (surface === 'job') {
      const jobId = req.query.job_id;
      if (!jobId) return res.status(400).json({ error: 'job_id is required for surface=job' });
      const ctx = await aiInternals.buildJobContext(jobId, '', null);
      systemBlocks = ctx.system;
      aiPhase = ctx.aiPhase;
      const toolList = aiInternals.jobTools();
      const filtered = (aiPhase === 'plan')
        ? toolList.filter(t => [
            'web_search', 'read_workspace_sheet_full', 'read_qb_cost_lines',
            'read_materials', 'read_purchase_history', 'read_subs',
            'read_building_breakdown', 'read_job_pct_audit', 'request_edit_mode'
          ].indexOf(t.name) !== -1)
        : toolList;
      toolNames = filtered.map(t => t.name);
      const jRow = await pool.query('SELECT data FROM jobs WHERE id = $1', [jobId]);
      entityLabel = jRow.rows.length ? ((jRow.rows[0].data && jRow.rows[0].data.title) || jobId) : jobId;
      skillPackNames = await loadPackNamesFor('job');
    } else if (surface === 'client') {
      const ctx = await aiInternals.buildClientDirectoryContext();
      systemBlocks = ctx.system;
      toolNames = aiInternals.clientTools().map(t => t.name);
      entityLabel = 'Client directory (system-wide)';
      // After the directory→86 absorb, client-context packs are tagged
      // agent='job'. Old packs still tagged 'cra' show up too —
      // Phase 1c retargeted them in the DB but we accept both keys
      // here for any lingering legacy rows.
      const jobPacks = await loadPackNamesFor('job');
      const craPacks = await loadPackNamesFor('cra');
      const seen = new Set();
      skillPackNames = [...jobPacks, ...craPacks].filter(p => {
        if (seen.has(p.name)) return false;
        seen.add(p.name);
        return true;
      });
    } else if (surface === 'admin') {
      const ctx = await aiInternals.buildStaffContext();
      systemBlocks = ctx.system;
      // Admin surface uses 86's full tool union (CoS responsibilities
      // were absorbed). Approx by listing the staff-side reads.
      toolNames = aiInternals.staffTools().map(t => t.name);
      entityLabel = 'Admin / cross-agent (system-wide)';
      skillPackNames = await loadPackNamesFor('job');
    } else {
      return res.status(400).json({ error: 'surface must be one of: estimate, job, client, admin' });
    }

    // System blocks come back as an array — first is stable (cached),
    // second is dynamic (refreshed each turn). Some agents may not split
    // them (single block); handle both shapes.
    let stable = '';
    let dynamic = '';
    if (Array.isArray(systemBlocks)) {
      const stableBlock = systemBlocks.find(b => b.cache_control);
      const dynamicBlocks = systemBlocks.filter(b => b !== stableBlock);
      stable = stableBlock ? stableBlock.text : '';
      dynamic = dynamicBlocks.map(b => b.text || '').join('\n\n');
    } else if (typeof systemBlocks === 'string') {
      stable = systemBlocks;
    }

    res.json({
      surface: surface,
      entity: { label: entityLabel },
      ai_phase: aiPhase,
      stable_prefix: { text: stable, tokens: approxTokens(stable) },
      dynamic_context: { text: dynamic, tokens: approxTokens(dynamic) },
      tools: toolNames,
      tool_count: toolNames.length,
      skill_packs: skillPackNames,
      total_approx_tokens: approxTokens(stable) + approxTokens(dynamic),
      cache_strategy: 'Stable prefix is wrapped in cache_control:ephemeral. Dynamic context is fresh every turn.'
    });
  } catch (e) {
    console.error('GET /api/admin/agents/preview-prompt error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

router.get('/evals', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT e.id, e.name, e.kind, e.description, e.created_at, e.updated_at,
              (SELECT COUNT(*)::int FROM ai_eval_runs r WHERE r.eval_id = e.id) AS run_count,
              (SELECT row_to_json(latest) FROM (
                  SELECT run_at, passed, model, effort, input_tokens, output_tokens, duration_ms
                    FROM ai_eval_runs WHERE eval_id = e.id ORDER BY run_at DESC LIMIT 1
              ) latest) AS latest_run
         FROM ai_evals e
        ORDER BY e.created_at DESC`
    );
    res.json({ evals: r.rows });
  } catch (e) {
    console.error('GET /api/admin/agents/evals error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/evals/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM ai_evals WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Eval not found' });
    const runs = await pool.query(
      `SELECT id, run_at, run_by, model, effort, input_tokens, output_tokens, duration_ms,
              passed, score, response_text, tool_calls, error
         FROM ai_eval_runs WHERE eval_id = $1 ORDER BY run_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ eval: r.rows[0], runs: runs.rows });
  } catch (e) {
    console.error('GET /api/admin/agents/evals/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/evals', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || typeof body.name !== 'string') return res.status(400).json({ error: 'name is required' });
    if (!body.fixture || typeof body.fixture !== 'object') return res.status(400).json({ error: 'fixture (object) is required' });
    const id = 'eval_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const kind = body.kind || 'estimate_draft';
    await pool.query(
      `INSERT INTO ai_evals (id, name, kind, description, fixture, expected_signals)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, body.name, kind, body.description || null, JSON.stringify(body.fixture), JSON.stringify(body.expected_signals || {})]
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error('POST /api/admin/agents/evals error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

router.put('/evals/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const params = [];
    let p = 1;
    if (body.name)             { sets.push('name = $' + p++);             params.push(body.name); }
    if (body.description != null) { sets.push('description = $' + p++);   params.push(body.description); }
    if (body.fixture)          { sets.push('fixture = $' + p++);          params.push(JSON.stringify(body.fixture)); }
    if (body.expected_signals) { sets.push('expected_signals = $' + p++); params.push(JSON.stringify(body.expected_signals)); }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    await pool.query(`UPDATE ai_evals SET ${sets.join(', ')} WHERE id = $${p}`, params);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/admin/agents/evals/:id error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

router.delete('/evals/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    await pool.query('DELETE FROM ai_evals WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/admin/agents/evals/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/evals/:id/run', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  const t0 = Date.now();
  let runId = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  try {
    const evalRes = await pool.query('SELECT * FROM ai_evals WHERE id = $1', [req.params.id]);
    if (!evalRes.rows.length) return res.status(404).json({ error: 'Eval not found' });
    const ev = evalRes.rows[0];
    if (ev.kind !== 'estimate_draft') {
      return res.status(400).json({ error: 'Only estimate_draft kind is supported in this version.' });
    }

    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'AI not configured (ANTHROPIC_API_KEY missing).' });

    const fixture = ev.fixture || {};
    if (!fixture.estimate_id) return res.status(400).json({ error: 'fixture.estimate_id is required.' });
    if (!fixture.user_prompt) return res.status(400).json({ error: 'fixture.user_prompt is required.' });

    const aiInternals = require('./ai-routes-internals');  // lazy require to defer circular load
    if (!aiInternals || !aiInternals.buildEstimateContext) {
      throw new Error('ai-routes internals not available — server may not be fully booted yet.');
    }
    // Photos are included by default — AG's value is largely photo-driven
    // (counting damage areas, identifying materials, sizing scope), and
    // running an eval without them would test a hobbled version of the
    // agent. fixture.include_photos = false opts out for text-only fixtures.
    const includePhotos = fixture.include_photos !== false;
    const ctx = await aiInternals.buildEstimateContext(fixture.estimate_id, includePhotos);
    const tools = aiInternals.estimateTools();
    const model = (req.body && req.body.model_override) || aiInternals.defaultModel();
    const maxTokens = aiInternals.maxTokens();
    // effort honors AI_EFFORT env (default) unless the request body
    // overrides it. Mirrors what production AG does on every turn so
    // an eval is a faithful re-run of the live config.
    const effortOverride = req.body && req.body.effort_override;
    const effort = aiInternals.effortFor(model, effortOverride);

    // Production AG attaches photos as image blocks on the user message.
    // Mirror that here so the model has the same input shape as a real
    // chat turn. When no photos, send the prompt as a plain string.
    const photoBlocks = (ctx.photoBlocks || []);
    const userContent = photoBlocks.length
      ? [...photoBlocks, { type: 'text', text: fixture.user_prompt }]
      : fixture.user_prompt;

    const apiBody = {
      model,
      max_tokens: maxTokens,
      system: ctx.system,
      tools,
      messages: [{ role: 'user', content: userContent }]
    };
    if (effort) apiBody.output_config = { effort };
    const response = await anthropic.messages.create(apiBody);

    const content = response.content || [];
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const toolUses = content.filter(b => b.type === 'tool_use').map(b => ({ name: b.name, input: b.input || {} }));
    const usage = response.usage || {};
    const elapsed = Date.now() - t0;

    // Score against expected_signals.
    const exp = ev.expected_signals || {};
    const signalResults = {};
    let allPassed = true;

    if (exp.min_line_items != null || exp.max_line_items != null) {
      const lineCount = toolUses.filter(t => t.name === 'propose_add_line_item').length;
      const minOk = exp.min_line_items == null || lineCount >= exp.min_line_items;
      const maxOk = exp.max_line_items == null || lineCount <= exp.max_line_items;
      const passed = minOk && maxOk;
      signalResults.line_count = { passed, observed: lineCount, expected: { min: exp.min_line_items, max: exp.max_line_items } };
      if (!passed) allPassed = false;
    }

    if (Array.isArray(exp.must_mention) && exp.must_mention.length) {
      const haystack = (text + '\n' + JSON.stringify(toolUses)).toLowerCase();
      const missing = exp.must_mention.filter(kw => !haystack.includes(String(kw).toLowerCase()));
      const passed = missing.length === 0;
      signalResults.must_mention = { passed, observed: { missing } };
      if (!passed) allPassed = false;
    }

    if (Array.isArray(exp.must_have_section) && exp.must_have_section.length) {
      const sections = new Set();
      toolUses.forEach(t => {
        if (t.name === 'propose_add_line_item' && t.input && t.input.section_name) sections.add(t.input.section_name);
        if (t.name === 'propose_add_section'  && t.input && t.input.name)         sections.add(t.input.name);
      });
      const missing = exp.must_have_section.filter(s => !sections.has(s));
      const passed = missing.length === 0;
      signalResults.must_have_section = { passed, observed: { sections: [...sections], missing } };
      if (!passed) allPassed = false;
    }

    await pool.query(
      `INSERT INTO ai_eval_runs (id, eval_id, run_by, model, effort, input_tokens, output_tokens,
                                 duration_ms, passed, score, response_text, tool_calls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        runId, ev.id, req.user ? req.user.id : null, model, effort || null,
        usage.input_tokens || null, usage.output_tokens || null,
        elapsed, allPassed, JSON.stringify(signalResults),
        text, JSON.stringify(toolUses)
      ]
    );

    res.json({
      ok: true, run_id: runId, passed: allPassed, model, effort: effort || null,
      duration_ms: elapsed,
      input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
      tool_calls: toolUses, response_text: text, score: signalResults
    });
  } catch (e) {
    console.error('POST /api/admin/agents/evals/:id/run error:', e);
    try {
      await pool.query(
        `INSERT INTO ai_eval_runs (id, eval_id, run_by, duration_ms, passed, error)
         VALUES ($1, $2, $3, $4, false, $5)`,
        [runId, req.params.id, req.user ? req.user.id : null, Date.now() - t0, e.message || 'failed']
      );
    } catch (logErr) { /* ignore secondary failure */ }
    res.status(500).json({ error: 'Eval run failed: ' + (e.message || 'unknown') });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Conversation replay
// ══════════════════════════════════════════════════════════════════════
// Sandboxed re-run of an existing ai_messages thread under different
// model / effort / system-prefix params. Returns the new response
// side-by-side with the original so an admin can A/B compare prompts
// and models on real production conversations without polluting
// user-facing history or skewing metrics.
//
// Stored in ai_replays. NEVER writes to ai_messages.
// ══════════════════════════════════════════════════════════════════════

router.get('/conversations/:key/replays', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, conversation_key, from_index, model_override, effort_override,
              system_prefix, run_at, run_by, input_tokens, output_tokens,
              duration_ms, response_text, tool_calls, error
         FROM ai_replays
        WHERE conversation_key = $1
        ORDER BY run_at DESC
        LIMIT 50`,
      [req.params.key]
    );
    res.json({ replays: r.rows });
  } catch (e) {
    console.error('GET /api/admin/agents/conversations/:key/replays error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/conversations/:key/replay', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  const t0 = Date.now();
  const replayId = 'rep_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const key = req.params.key || '';
  try {
    const parts = key.split('|');
    if (parts.length !== 3) return res.status(400).json({ error: 'Bad conversation key' });
    const [entityType, entityId, userIdRaw] = parts;
    const userId = Number(userIdRaw);
    if (!entityType || !entityId || !Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Bad conversation key components' });
    }

    const body = req.body || {};
    const modelOverride  = (body.model_override || '').trim() || null;
    const effortOverride = (body.effort_override || '').trim().toLowerCase() || null;
    const systemPrefix   = (typeof body.system_prefix === 'string') ? body.system_prefix : null;
    const fromIndex      = Number.isFinite(Number(body.from_index)) ? Number(body.from_index) : null;

    // Pull the conversation. Replay needs the FULL row content (not the
    // 16KB-trimmed view the conversation detail endpoint returns) so we
    // can faithfully reconstruct what the model originally saw.
    const msgsRes = await pool.query(
      `SELECT role, content, model FROM ai_messages
        WHERE entity_type=$1 AND estimate_id=$2 AND user_id=$3
        ORDER BY created_at ASC`,
      [entityType, entityId, userId]
    );
    const allMessages = msgsRes.rows;
    if (!allMessages.length) return res.status(404).json({ error: 'Conversation has no messages' });

    // from_index slices the conversation. Default: replay the LAST user
    // message of the thread (so the admin sees what the agent would
    // have answered with different params on the most recent turn).
    let cutAt = (fromIndex != null) ? fromIndex : -1;
    if (cutAt < 0) {
      // Find last user-role message and use its index.
      for (let i = allMessages.length - 1; i >= 0; i--) {
        if (allMessages[i].role === 'user') { cutAt = i; break; }
      }
      if (cutAt < 0) return res.status(400).json({ error: 'No user message found in conversation' });
    }
    if (cutAt >= allMessages.length) return res.status(400).json({ error: 'from_index past end of conversation' });

    // Use messages [0..cutAt] inclusive — cutAt is the last user message
    // we want to replay. Anthropic expects the conversation to end with
    // a user message before generating the next assistant turn.
    const replayMessages = allMessages.slice(0, cutAt + 1).map(m => ({ role: m.role, content: m.content }));
    if (replayMessages[replayMessages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Replay slice must end with a user message — adjust from_index.' });
    }

    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'AI not configured (ANTHROPIC_API_KEY missing).' });

    const aiInternals = require('./ai-routes-internals');
    if (!aiInternals) throw new Error('ai-routes internals not available.');

    // Build the system context for whichever agent owned the original
    // conversation. Replays estimates and jobs against 86 (the unified
    // operator), client threads against the directory surface, staff threads against
    // the Chief of Staff.
    //
    // For estimate replays, attach photo blocks to the last user message
    // so AG sees the same input shape it saw in production. ai_messages
    // persists only text; the original image content is regenerated
    // here from the estimate's current attachments.
    let system, tools, photoBlocks = [];
    if (entityType === 'estimate') {
      const ctx = await aiInternals.buildEstimateContext(entityId, true);
      system = ctx.system;
      tools = aiInternals.estimateTools();
      photoBlocks = ctx.photoBlocks || [];
    } else if (entityType === 'job') {
      // Job context wants a clientContext arg; replays don't have one
      // since the original lived only in the chat session. Pass null;
      // WIP degrades to summary-only.
      const ctx = await aiInternals.buildJobContext(entityId, null);
      system = ctx.system;
      tools = aiInternals.jobTools();
    } else if (entityType === 'client') {
      const ctx = await aiInternals.buildClientDirectoryContext();
      system = ctx.system;
      tools = aiInternals.clientTools();
    } else if (entityType === 'staff') {
      const ctx = await aiInternals.buildStaffContext();
      system = ctx.system;
      tools = aiInternals.staffTools();
    } else {
      return res.status(400).json({ error: 'Unknown entity_type: ' + entityType });
    }

    // Optional system_prefix prepends a custom block in front of the
    // existing system prompt — useful for "what if I added this skill
    // pack?" experiments without actually saving it. Stays sandboxed
    // to this replay only.
    if (systemPrefix && Array.isArray(system)) {
      system = [{ type: 'text', text: systemPrefix }, ...system];
    } else if (systemPrefix) {
      system = systemPrefix + '\n\n' + system;
    }

    const model = modelOverride || aiInternals.defaultModel();
    const maxTokens = aiInternals.maxTokens();
    // Effort gating mirrors the production agent: only attach when the
    // model supports it and an effort value is set.
    const effortClause = effortOverride
      ? (new Set(['claude-opus-4-5','claude-opus-4-6','claude-opus-4-7','claude-sonnet-4-6']).has(model)
          ? { effort: effortOverride } : null)
      : null;

    // Promote the last user message to a content-array form with the
    // photo blocks prepended, when applicable. Anthropic accepts both
    // string and array content; arrays are required to mix images.
    if (photoBlocks.length && replayMessages.length) {
      const last = replayMessages[replayMessages.length - 1];
      if (last && last.role === 'user' && typeof last.content === 'string') {
        replayMessages[replayMessages.length - 1] = {
          role: 'user',
          content: [...photoBlocks, { type: 'text', text: last.content }]
        };
      }
    }

    const apiBody = {
      model,
      max_tokens: maxTokens,
      system,
      tools,
      messages: replayMessages
    };
    if (effortClause) apiBody.output_config = effortClause;

    const response = await anthropic.messages.create(apiBody);
    const content = response.content || [];
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const toolUses = content.filter(b => b.type === 'tool_use').map(b => ({ name: b.name, input: b.input || {} }));
    const usage = response.usage || {};
    const elapsed = Date.now() - t0;

    await pool.query(
      `INSERT INTO ai_replays (id, conversation_key, from_index, model_override, effort_override,
                               system_prefix, run_by, input_tokens, output_tokens,
                               duration_ms, response_text, tool_calls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        replayId, key, cutAt, modelOverride, effortOverride, systemPrefix,
        req.user ? req.user.id : null,
        usage.input_tokens || null, usage.output_tokens || null,
        elapsed, text, JSON.stringify(toolUses)
      ]
    );

    res.json({
      ok: true, replay_id: replayId, model, from_index: cutAt,
      duration_ms: elapsed,
      input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
      response_text: text, tool_calls: toolUses
    });
  } catch (e) {
    console.error('POST /api/admin/agents/conversations/:key/replay error:', e);
    try {
      await pool.query(
        `INSERT INTO ai_replays (id, conversation_key, run_by, duration_ms, error)
         VALUES ($1, $2, $3, $4, $5)`,
        [replayId, key, req.user ? req.user.id : null, Date.now() - t0, e.message || 'failed']
      );
    } catch (_) { /* ignore secondary */ }
    res.status(500).json({ error: 'Replay failed: ' + (e.message || 'unknown') });
  }
});

// ──── Managed Agents bootstrap (Phase 1a of Agents API migration) ──
//
// Anthropic's Agents API requires a registered Agent record (with
// attached skills + tools + system prompt) before we can create
// Sessions against it. This file's bootstrap endpoints handle the
// one-time registration. Production chat paths still use
// anthropic.messages.stream — the v2 chat path that uses Sessions
// lives in a follow-up commit (Phase 1b).

// Slim per-agent system prompt for the registered Agent. The detailed
// per-turn dynamic context (estimate state, photos, etc.) gets passed
// via the Session's first user message in Phase 1b — this is just the
// identity + capabilities baseline that survives across sessions.
const AGENT_SYSTEM_BASELINE = {
  // 86 — the ONE operator agent for Project 86. Serves every surface
  // (per-job WIP chat, per-estimate editor, lead intake, Ask 86 global).
  // Same identity, same tool union (estimating + job + intake +
  // client-directory mutations), same continuous memory.
  //
  // The legacy 'ag' agent_key (former separate estimator persona) is
  // retired. The DB migration in server/db.js renames any 'ag' rows
  // to 'job' on boot. customToolsFor still has an 'ag' branch as
  // dead-code back-compat — if some old code path ever resolves an
  // 'ag' key, the baseline below also serves it (single source of
  // truth: 86's identity, never the old separate persona).
  job:   'You are 86 — Project 86\'s operator agent. Project 86 is a SaaS platform for construction businesses. You serve as the SINGLE agent across every surface of the app — same brain whether you\'re on the global Ask 86 panel, a per-job WIP chat, a per-estimate editor, the lead-intake flow, the client directory, or admin context. There is no separate HR or Chief of Staff agent; you handle all of it.\n\nThe SPECIFIC COMPANY you\'re working for is appended below in the "About the company you serve" block — that section names the tenant, their industry / market / customer hierarchy / pricing standards. Those standards define how THAT company operates; they do NOT define who you are. You are 86 (the platform agent). The tenant is the company you currently work for.\n\n# Your scope\n  Range across the whole company you serve: revenue, cost, production, WIP, change orders, QB cost data, the node graph, margin trends, billing patterns, schedule slip, estimating, lead intake, client directory hygiene, skill-pack curation. You DRAFT estimates yourself (line items, sections, groups, pricing, scope edits). You CAPTURE leads yourself. You maintain the client directory yourself (split parent+property compounds, validate addresses, capture durable client notes). You curate your own skill packs via propose_skill_pack_* tools when you spot patterns worth standardizing. When the user asks to "go work on X," use the navigate tool to take them there, then keep working.\n\n# Per-turn context\n  Every user turn carries data appropriate to the surface — a job WIP snapshot when the conversation is job-scoped, lead context when handling intake, an estimate snapshot when working in the editor, a client directory snapshot when on the clients page, or a <page_context> block on the global Ask 86 surface telling you which page the user is on. Always reason about WHY a number is what it is. When estimating, anchor labor + sub costs to past-estimate history; price materials from real purchase data over training-data guesses.\n\n# Tone\n  Concise. Construction trade vocabulary welcome. Lead with the answer. Do not announce hand-offs to "other agents" — there are no other agents. You ARE the agent that does the work.',

  // Legacy 'cra' (directory) and 'staff' (Chief of Staff) baselines have been
  // retired. 86 absorbs both roles. These keys remain only as null
  // back-compat shims so any old `managed_agent_registry` row pointing
  // at 'cra' or 'staff' resolves to 86's baseline at sync time, and
  // the Anthropic-side agents can be archived via /managed/<key>/delete
  // without breaking the sync loop.
  cra:   null,
  staff: null,

  // The legacy 'ag' key — back-compat alias for 'job'. The DB migration
  // renamed any 'ag' rows to 'job' on boot, so this key should never
  // be resolved against managed_agent_registry. customToolsFor still
  // has a dead-code 'ag' branch; pointing it at 86's baseline ensures
  // nothing surfaces an old persona if it ever does fire.
  ag:    null // resolved at lookup time to AGENT_SYSTEM_BASELINE.job
};
// Resolve the back-compat aliases after the literal initializer runs.
// Every retired agent_key now resolves to 86's baseline so a stale
// registry row sync-loops harmlessly until the row is deleted.
AGENT_SYSTEM_BASELINE.ag = AGENT_SYSTEM_BASELINE.job;
AGENT_SYSTEM_BASELINE.cra = AGENT_SYSTEM_BASELINE.job;
AGENT_SYSTEM_BASELINE.staff = AGENT_SYSTEM_BASELINE.job;

// Convert one of our local tool definitions (the ESTIMATE_TOOLS /
// JOB_TOOLS / ClientDirectoryTools / STAFF_TOOLS shape) into Anthropic's
// BetaManagedAgentsCustomToolParams shape.
//
// Constraints the managed-agents schema enforces (vs the looser
// messages.create tool schema we use today on the v1 path):
//   - description max length 1024 chars
//   - input_schema must NOT contain `additionalProperties` at any
//     level (Anthropic's managed-agents schema validator rejects it
//     even though the messages.create path tolerates it)
function sanitizeInputSchemaForAgents(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeInputSchemaForAgents);
  const out = {};
  for (const k of Object.keys(node)) {
    if (k === 'additionalProperties') continue; // strip
    out[k] = sanitizeInputSchemaForAgents(node[k]);
  }
  return out;
}

function toCustomToolParam(tool) {
  const desc = (tool.description || '').toString();
  return {
    type: 'custom',
    name: tool.name,
    // Hard cap at the Anthropic managed-agents 1024-char limit.
    // Truncating beats failing the whole bootstrap; the agent still
    // sees the first 1024 chars which is plenty to disambiguate.
    description: desc.length > 1024 ? desc.slice(0, 1021) + '...' : desc,
    input_schema: sanitizeInputSchemaForAgents(tool.input_schema || { type: 'object', properties: {} })
  };
}

// Pull every native Anthropic Skill assigned to this agent key.
// Sources (UNIONed, deduped, capped at 20 per Anthropic's limit):
//
//   1. managed_agent_skills table (Phase 2 native-first source). Rows
//      with enabled=true and a non-null skill_id. Ordered by position
//      first so the admin's intentional ordering is preserved.
//
//   2. Legacy app_settings.agent_skills JSONB: packs with both
//      anthropic_skill_id set AND agents[] including this agent_key.
//      Kept for back-compat — existing assignments keep working while
//      the admin migrates to the new table.
//
// First source wins on conflict (skill_id already attached via the
// new table won't be re-added via the legacy path). Returns an array
// of {type:'custom', skill_id} entries shaped for beta.agents.create.
async function collectSkillsFor(agentKey, organization) {
  const out = [];
  const seen = new Set();

  // Source 0 (preferred — Phase 2d): per-tenant org_skill_packs rows
  // that have been mirrored to Anthropic native Skills. The
  // propose_skill_pack_mirror flow uploads a pack body via
  // anthropic.beta.skills.create and stamps the returned id onto
  // org_skill_packs.anthropic_skill_id; this is where we pick it up
  // so it actually lands in the agent's registered skills.
  //
  // Before this branch existed, mirrored packs were on Anthropic but
  // never linked to the agent — every sync reported skill_count: 0,
  // and 86 had to fall back to the load_skill_pack round-trip on
  // every turn. Closing that bridge is the whole reason the function
  // takes `organization` now.
  if (organization && organization.id) {
    try {
      const orgR = await pool.query(
        `SELECT anthropic_skill_id, name FROM org_skill_packs
          WHERE organization_id = $1
            AND anthropic_skill_id IS NOT NULL
            AND archived_at IS NULL
          ORDER BY created_at ASC`,
        [organization.id]
      );
      for (const row of orgR.rows) {
        if (out.length >= 20) break;
        if (seen.has(row.anthropic_skill_id)) continue;
        seen.add(row.anthropic_skill_id);
        out.push({ type: 'custom', skill_id: row.anthropic_skill_id });
      }
    } catch (e) {
      console.warn('[collectSkillsFor] org_skill_packs read failed:', e.message);
    }
  }

  // Source 1: managed_agent_skills (preferred — Phase 2)
  try {
    const newR = await pool.query(
      `SELECT skill_id FROM managed_agent_skills
        WHERE agent_key = $1 AND enabled = true AND skill_id IS NOT NULL
        ORDER BY position ASC, created_at ASC`,
      [agentKey]
    );
    for (const row of newR.rows) {
      if (out.length >= 20) break;
      if (seen.has(row.skill_id)) continue;
      seen.add(row.skill_id);
      out.push({ type: 'custom', skill_id: row.skill_id });
    }
  } catch (e) {
    // Table might not exist yet on a deploy that predates the
    // migration — fall through to the legacy source.
    console.warn('[collectSkillsFor] managed_agent_skills read failed:', e.message);
  }

  // Source 2: legacy app_settings.agent_skills (back-compat)
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'agent_skills'`);
    if (r.rows.length) {
      const cfg = r.rows[0].value || {};
      const skills = Array.isArray(cfg.skills) ? cfg.skills : [];
      for (const s of skills) {
        if (out.length >= 20) break;
        if (!s || !s.anthropic_skill_id || !Array.isArray(s.agents)) continue;
        if (s.agents.indexOf(agentKey) < 0) continue;
        if (seen.has(s.anthropic_skill_id)) continue;
        seen.add(s.anthropic_skill_id);
        out.push({ type: 'custom', skill_id: s.anthropic_skill_id });
      }
    }
  } catch (e) {
    console.warn('[collectSkillsFor] legacy pack scan failed:', e.message);
  }

  return out;
}

// Built-in toolset configuration per agent key. Conservative defaults —
// only enable what's clearly useful for that role. Phase 3 of the
// migration expands these (e.g. enabling bash/read on 86 for QB
// cost line analysis).
function builtinToolsetFor(agentKey) {
  // Built-in toolset — full toolkit for every agent. The sandboxed
  // per-session container has no path to our DB / API / R2 / user
  // data, so bash / write / edit can only touch the scratch
  // filesystem (which now also contains the agent's mounted Skills).
  // Letting 86 draft scratch docs, run quick computations, and chase
  // multi-file skill content earns its keep without weakening the
  // propose_* approval flow that gates real mutations.
  //
  // Built-ins available via agent_toolset_20260401:
  //   web_search, web_fetch    — research
  //   read, glob, grep         — read mounted skill files / scratch
  //   bash, write, edit        — sandbox scratch pad
  //
  // Custom Project-86 tools (91 today) and native Anthropic Skills
  // (12 today) ride alongside via customToolsFor / collectSkillsFor.
  return [{ type: 'agent_toolset_20260401', default_config: { enabled: true } }];
}

// Resolve the Project 86-side custom tools for an agent. Goes through the
// internals export from ai-routes so we don't duplicate definitions.
function customToolsFor(agentKey) {
  const aiInternals = require('./ai-routes-internals');
  if (!aiInternals) return [];
  // estimateTools / jobTools / clientTools / staffTools each include
  // the WEB_TOOLS prefix; strip those because we configure web_search
  // / web_fetch through the built-in toolset above instead.
  let tools = [];
  if (agentKey === 'job' || agentKey === 'ag' || agentKey === 'cra' || agentKey === 'staff') {
    // ONE 86 — the managed `job` agent serves every surface. The
    // legacy 'cra' (directory) and 'staff' (CoS) agent_keys resolve to the
    // same tool union so any stale registry row points at the unified
    // 86 brain at sync time. Once those rows are deleted via
    // /managed/<key>/delete, this branch only fires for 'job'.
    //
    // Tools = UNION of every tool 86 uses anywhere:
    //   - estimateTools  (line items, sections, groups, scope edits)
    //   - jobTools       (phase pct, node graph, COs, POs, invoices)
    //   - clientTools    (client-directory + property + sub mutations)
    //   - staffTools     (skill pack mutations + introspection reads)
    //   - memoryTools    (Phase 4: remember / recall / list_memories /
    //                     forget — cross-session memory)
    //   - watchTools     (Phase 5: propose_watch_create / list_watches /
    //                     read_recent_watch_runs / propose_watch_archive)
    // Phase 3 subtaskTools removed — native parallel tool calls within
    // one session cover the same use cases without per-child cache hits.
    // Deduped by name; first occurrence wins (estimate-first order).
    // INTAKE_TOOLS are already spread into jobTools().
    const seen = new Set();
    const merged = [];
    [
      ...aiInternals.estimateTools(),
      ...aiInternals.jobTools(),
      ...aiInternals.clientTools(),
      ...aiInternals.staffTools(),
      ...aiInternals.memoryTools(),
      ...aiInternals.watchTools()
    ].forEach(t => {
      if (!t || !t.name || seen.has(t.name)) return;
      seen.add(t.name);
      merged.push(t);
    });
    tools = merged;
  }
  return tools
    .filter(t => t.name !== 'web_search')              // built-in toolset owns this
    .map(toCustomToolParam)
    .slice(0, 128);                                     // Anthropic caps tools at 128
}

// Idempotent register-or-update for one Project 86 agent on behalf
// of one organization. Each (agent_key, organization_id) tuple maps
// to a distinct Anthropic agent so tenants can have their own
// identity_body composed into the registered system prompt.
//
// `organization` is the full org row (from organizations table).
// Required — callers must resolve it first. The previous single-arg
// signature (agentKey only) is no longer supported; passing only
// the key throws so any stale caller crashes loudly instead of
// silently registering against the wrong tenant.
// Phase 6 — load the org's active MCP servers and shape them for
// beta.agents.create's mcp_servers field. Returns an array (possibly
// empty); callers can spread it conditionally so an org with zero
// connectors registers the same way as before.
async function collectMcpServersFor(organization) {
  if (!organization || !organization.id) return [];
  const r = await pool.query(
    `SELECT name, url, authorization_token
       FROM org_mcp_servers
      WHERE organization_id = $1
        AND enabled = true
        AND archived_at IS NULL`,
    [organization.id]
  );
  return r.rows.map(row => {
    const server = { type: 'url', name: row.name, url: row.url };
    if (row.authorization_token) server.authorization_token = row.authorization_token;
    return server;
  });
}

async function ensureManagedAgent(agentKey, organization) {
  const anthropic = getAnthropic();
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not set on this deployment.');
  const baseline = AGENT_SYSTEM_BASELINE[agentKey];
  if (!baseline) throw new Error('Unknown agent key: ' + agentKey);
  if (!organization || !organization.id) {
    throw new Error('ensureManagedAgent requires an organization row (Phase 2c — every agent is per-tenant now).');
  }

  const existing = await pool.query(
    'SELECT * FROM managed_agent_registry WHERE agent_key = $1 AND organization_id = $2',
    [agentKey, organization.id]
  );
  if (existing.rows.length) {
    return existing.rows[0]; // already registered for this tenant
  }

  const aiInternals = require('./ai-routes-internals');
  const model = aiInternals && aiInternals.defaultModel ? aiInternals.defaultModel() : 'claude-sonnet-4-6';
  const skills = await collectSkillsFor(agentKey, organization);
  const customTools = customToolsFor(agentKey);
  const builtinTools = builtinToolsetFor(agentKey);
  const mcpServers = await collectMcpServersFor(organization);

  // Compose the full system: platform baseline + org.identity_body +
  // SECTION_DEFAULTS playbook. Per-tenant content gets cached on the
  // Anthropic agent so the per-turn prompt stays slim.
  const composedSystem = (aiInternals && aiInternals.composedAgentSystem)
    ? await aiInternals.composedAgentSystem(agentKey, baseline, organization)
    : baseline;

  const createPayload = {
    model: model,
    name: 'Project 86 ' + agentKey.toUpperCase() + ' · ' + (organization.name || organization.slug),
    description: (organization.description || baseline).slice(0, 200),
    system: composedSystem,
    skills: skills,
    tools: [...builtinTools, ...customTools]
  };
  if (mcpServers.length) createPayload.mcp_servers = mcpServers;
  const created = await anthropic.beta.agents.create(createPayload);

  await pool.query(
    `INSERT INTO managed_agent_registry
       (agent_key, organization_id, anthropic_agent_id, model, tool_count, skill_count, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [agentKey, organization.id, created.id, model, customTools.length + builtinTools.length, skills.length]
  );

  return {
    agent_key: agentKey,
    organization_id: organization.id,
    anthropic_agent_id: created.id,
    model: model,
    tool_count: customTools.length + builtinTools.length,
    skill_count: skills.length
  };
}

// POST /api/admin/agents/managed/reregister?key=ag|job|cra|staff
//   Force a fresh agents.create + replace the local registry row.
//   Use this when the local tool definitions or system prompt have
//   drifted from what the registered Anthropic-side agent has — e.g.
//   after a description rewrite that needed to fit under the
//   1024-char limit, or when adding a new tool. Sessions bound to
//   the OLD agent id keep working but won't see the new tool/prompt;
//   start a fresh chat to pick up the new agent.
router.post('/managed/reregister', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const key = String(req.query.key || '').toLowerCase();
    if (!['ag', 'job', 'cra', 'staff'].includes(key)) {
      return res.status(400).json({ error: 'key must be ag | job | cra | staff' });
    }
    const anthropic = getAnthropic();
    if (!anthropic) throw new Error('ANTHROPIC_API_KEY not set on this deployment.');
    const baseline = AGENT_SYSTEM_BASELINE[key];

    const aiInternals = require('./ai-routes-internals');
    const model = aiInternals && aiInternals.defaultModel ? aiInternals.defaultModel() : 'claude-sonnet-4-6';
    const skills = await collectSkillsFor(key);
    const customTools = customToolsFor(key);
    const builtinTools = builtinToolsetFor(key);

    const created = await anthropic.beta.agents.create({
      model: model,
      name: 'Project 86 ' + key.toUpperCase(),
      description: baseline.slice(0, 200),
      system: baseline,
      skills: skills,
      tools: [...builtinTools, ...customTools]
    });

    // Replace the registry row in place. The OLD anthropic_agent_id
    // is left active on Anthropic's side (sessions bound to it keep
    // working) but new sessions point at the new agent id.
    await pool.query(
      `INSERT INTO managed_agent_registry
         (agent_key, anthropic_agent_id, model, tool_count, skill_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (agent_key) DO UPDATE SET
         anthropic_agent_id = EXCLUDED.anthropic_agent_id,
         model = EXCLUDED.model,
         tool_count = EXCLUDED.tool_count,
         skill_count = EXCLUDED.skill_count,
         updated_at = NOW()`,
      [key, created.id, model, customTools.length + builtinTools.length, skills.length]
    );

    res.json({
      ok: true,
      agent_key: key,
      anthropic_agent_id: created.id,
      tool_count: customTools.length + builtinTools.length,
      skill_count: skills.length,
      note: 'Existing v2 sessions bound to the old agent id keep working but will not see the new tools/prompt. Start a fresh chat to pick up the new agent.'
    });
  } catch (e) {
    console.error('POST /api/admin/agents/managed/reregister error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/agents/managed/bootstrap?key=job|all
//   Registers 86 (the unified operator agent) as the caller's
//   organization's managed Anthropic Agent. Idempotent — if a row
//   already exists for (agent_key, organization_id), it's returned
//   as-is. Use /managed/sync to push changes to an already-registered
//   agent.
router.post('/managed/bootstrap',
  requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg,
  async (req, res) => {
    try {
      const key = String(req.query.key || 'all').toLowerCase();
      // Post-unification, only 'job' is a real agent. 'all' and any
      // legacy key alias to 'job'.
      const agents = (key === 'all' || key === '') ? ['job'] : [key === 'job' ? 'job' : 'job'];
      const summary = [];
      for (const agentKey of agents) {
        try {
          const row = await ensureManagedAgent(agentKey, req.organization);
          summary.push({
            agent_key: agentKey,
            organization_id: req.organization.id,
            organization_slug: req.organization.slug,
            ok: true,
            anthropic_agent_id: row.anthropic_agent_id,
            tool_count: row.tool_count,
            skill_count: row.skill_count
          });
        } catch (e) {
          summary.push({ agent_key: agentKey, ok: false, error: e.message });
        }
      }
      res.json({ summary });
    } catch (e) {
      console.error('POST /api/admin/agents/managed/bootstrap error:', e);
      res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
    }
  }
);

// GET /api/admin/agents/managed
//   Returns the current registry — agent_key + anthropic_agent_id +
//   counts. Drives the admin "Managed agents" panel.
router.get('/managed', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT agent_key, anthropic_agent_id, model, tool_count, skill_count,
              registered_at, updated_at
         FROM managed_agent_registry
        ORDER BY agent_key`
    );
    res.json({ agents: r.rows });
  } catch (e) {
    console.error('GET /api/admin/agents/managed error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// GET /api/admin/agents/managed/audit
//   Cross-references every managed_agent_registry row with the
//   Anthropic-side state and flags anything off-spec. Used to hunt
//   for stale per-tenant agents that survived the unified-86
//   migration (pre-unification each surface had its own agent_key —
//   'estimates', 'cra', 'staff' — but only 'job' should exist now).
//
//   Flags returned:
//     stale_agent_key       — agent_key isn't 'job' (legacy registry row)
//     anthropic_archived    — Anthropic-side agent is archived
//     anthropic_missing     — agent_id is stale (retrieve returned 404)
//     name_off_pattern      — Anthropic agent name doesn't match
//                             "Project 86 JOB · <org name|slug>"
//     no_org                — registry row has no organization_id
//
//   Pure read — does not modify either side. Use the existing
//   DELETE /managed/:agentKey to clean up flagged rows (or the new
//   /managed/audit/kill endpoint below to also archive the
//   Anthropic-side agent in one shot).
router.get('/managed/audit', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    const r = await pool.query(
      `SELECT r.agent_key, r.organization_id, r.anthropic_agent_id,
              r.model, r.tool_count, r.skill_count, r.registered_at, r.updated_at,
              o.slug AS org_slug, o.name AS org_name
         FROM managed_agent_registry r
         LEFT JOIN organizations o ON o.id = r.organization_id
        ORDER BY r.organization_id, r.agent_key`
    );
    const rows = [];
    for (const row of r.rows) {
      const flags = [];
      if (row.agent_key !== 'job') flags.push('stale_agent_key');
      if (!row.organization_id) flags.push('no_org');
      const expectedName = 'Project 86 ' + (row.agent_key || '').toUpperCase() + ' · ' + (row.org_name || row.org_slug || '');
      let anthropicState = null;
      if (anthropic && row.anthropic_agent_id) {
        try {
          const a = await anthropic.beta.agents.retrieve(row.anthropic_agent_id);
          anthropicState = {
            name: a.name,
            description: a.description ? a.description.slice(0, 120) : null,
            archived_at: a.archived_at || null,
            version: a.version,
            updated_at: a.updated_at
          };
          if (a.archived_at) flags.push('anthropic_archived');
          if (a.name && a.name !== expectedName) flags.push('name_off_pattern');
        } catch (e) {
          if (e && e.status === 404) flags.push('anthropic_missing');
          anthropicState = { error: e.message || String(e) };
        }
      } else if (!anthropic) {
        anthropicState = { skipped: 'no ANTHROPIC_API_KEY' };
      }
      rows.push({
        agent_key: row.agent_key,
        organization_id: row.organization_id,
        org_slug: row.org_slug,
        org_name: row.org_name,
        anthropic_agent_id: row.anthropic_agent_id,
        local: {
          model: row.model,
          tool_count: row.tool_count,
          skill_count: row.skill_count,
          registered_at: row.registered_at,
          updated_at: row.updated_at
        },
        anthropic: anthropicState,
        expected_name: expectedName,
        flags
      });
    }
    const summary = {
      total: rows.length,
      flagged: rows.filter(r => r.flags.length).length,
      stale: rows.filter(r => r.flags.includes('stale_agent_key')).length,
      archived: rows.filter(r => r.flags.includes('anthropic_archived')).length,
      missing: rows.filter(r => r.flags.includes('anthropic_missing')).length,
      off_pattern: rows.filter(r => r.flags.includes('name_off_pattern')).length
    };
    res.json({ summary, rows });
  } catch (e) {
    console.error('GET /api/admin/agents/managed/audit error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/agents/managed/audit/kill
//   Body: { agent_key: string, organization_id: number, archive_anthropic?: boolean }
//   Removes one (agent_key, organization_id) registry row. If
//   archive_anthropic is true (default), also archives the
//   Anthropic-side agent so any session token cached against that
//   agent_id stops working — the only reliable way to stop a stale
//   agent from continuing to bill.
router.post('/managed/audit/kill', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const b = req.body || {};
    const agentKey = String(b.agent_key || '').toLowerCase().trim();
    const orgId = b.organization_id != null ? Number(b.organization_id) : null;
    const archiveAnthropic = b.archive_anthropic !== false; // default true
    if (!agentKey) return res.status(400).json({ error: 'agent_key is required' });
    if (orgId == null || !Number.isFinite(orgId)) return res.status(400).json({ error: 'organization_id is required (integer)' });

    const r = await pool.query(
      `SELECT anthropic_agent_id FROM managed_agent_registry
        WHERE agent_key = $1 AND organization_id = $2`,
      [agentKey, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No registry row for ' + agentKey + '/' + orgId });
    const agentId = r.rows[0].anthropic_agent_id;

    let archived = false;
    if (archiveAnthropic && agentId) {
      try {
        const anthropic = getAnthropic();
        if (anthropic) {
          await anthropic.beta.agents.archive(agentId);
          archived = true;
        }
      } catch (e) {
        // 404 means it's already gone — fine. Any other error means
        // the local row got deleted but the Anthropic-side agent is
        // still live; surface that loudly so the admin can finish
        // the cleanup manually.
        if (e && e.status !== 404) {
          console.warn('[managed/audit/kill] archive failed for', agentId, ':', e.message);
        }
      }
    }

    await pool.query(
      `DELETE FROM managed_agent_registry WHERE agent_key = $1 AND organization_id = $2`,
      [agentKey, orgId]
    );
    res.json({
      ok: true,
      agent_key: agentKey,
      organization_id: orgId,
      freed_anthropic_agent_id: agentId,
      anthropic_archived: archived
    });
  } catch (e) {
    console.error('POST /managed/audit/kill error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// ──────────────────────────────────────────────────────────────────
// Phase 1b — Managed Environment bootstrap
//
// Sessions need an environment_id; we use one shared 'default' env
// across all four agents (cloud, unrestricted networking — matches
// today's agent egress posture). Idempotent: if a row already exists
// in managed_environment_registry, we return it untouched.
// ──────────────────────────────────────────────────────────────────
async function ensureManagedEnvironment() {
  const anthropic = getAnthropic();
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not set on this deployment.');

  const existing = await pool.query(
    `SELECT * FROM managed_environment_registry WHERE env_key = 'default'`
  );
  if (existing.rows.length) return existing.rows[0];

  const created = await anthropic.beta.environments.create({
    name: 'p86-default',
    config: {
      type: 'cloud',
      networking: { type: 'unrestricted' }
    }
  });

  await pool.query(
    `INSERT INTO managed_environment_registry
       (env_key, anthropic_environment_id, networking, updated_at)
     VALUES ('default', $1, 'unrestricted', NOW())
     ON CONFLICT (env_key) DO NOTHING`,
    [created.id]
  );

  // Re-read in case of a race (two concurrent bootstraps); the unique
  // constraint guarantees we end up with one row, and we want the
  // canonical one (whichever insert won).
  const after = await pool.query(
    `SELECT * FROM managed_environment_registry WHERE env_key = 'default'`
  );
  return after.rows[0];
}

// POST /api/admin/agents/managed/bootstrap-environment
router.post('/managed/bootstrap-environment', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const row = await ensureManagedEnvironment();
    res.json({ ok: true, env: row });
  } catch (e) {
    console.error('POST /api/admin/agents/managed/bootstrap-environment error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// GET /api/admin/agents/managed/environment
router.get('/managed/environment', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM managed_environment_registry WHERE env_key = 'default'`);
    res.json({ env: r.rows[0] || null });
  } catch (e) {
    console.error('GET /api/admin/agents/managed/environment error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// ──────────────────────────────────────────────────────────────────
// Reference Links — agent-visible SharePoint / OneDrive XLSX links.
// Admin-managed list of share URLs that the server fetches +
// parses + caches; the parsed text gets injected into every agent
// turn so models have live access to job-number lookups, the WIP
// report, and any other accounting-published reference.
// ──────────────────────────────────────────────────────────────────
const sharepoint = require('../sharepoint');

// In-memory background-refresh debouncer so concurrent /refresh
// hits don't trigger overlapping fetches for the same row.
const _refreshing = new Set();

async function refreshLinkRow(row) {
  if (_refreshing.has(row.id)) return;
  _refreshing.add(row.id);
  try {
    const result = await sharepoint.fetchAndRender(row.url, {
      title: row.title,
      description: row.description,
      maxRows: row.max_rows || 200
    });
    await pool.query(
      'UPDATE agent_reference_links SET ' +
      '  last_fetched_at = NOW(), last_fetch_status = $1, last_fetch_error = NULL, ' +
      '  last_fetched_text = $2, last_fetched_row_count = $3, updated_at = NOW() ' +
      'WHERE id = $4',
      ['ok', result.text, result.rowCount, row.id]
    );
    return { status: 'ok', rowCount: result.rowCount };
  } catch (e) {
    await pool.query(
      'UPDATE agent_reference_links SET ' +
      '  last_fetched_at = NOW(), last_fetch_status = $1, last_fetch_error = $2, updated_at = NOW() ' +
      'WHERE id = $3',
      ['failed', String(e && e.message || e).slice(0, 1000), row.id]
    );
    return { status: 'failed', error: e.message };
  } finally {
    _refreshing.delete(row.id);
  }
}

// GET /api/admin/agents/reference-links — list THIS org's reference
// links only. Phase D moved the table org-scoped; without the filter
// every admin would see every tenant's SharePoint URLs.
router.get('/reference-links', requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, title, url, description, enabled, max_rows, inject_mode, last_fetched_at, ' +
      '       last_fetch_status, last_fetch_error, last_fetched_row_count, created_at, updated_at ' +
      'FROM agent_reference_links WHERE organization_id = $1 ORDER BY created_at ASC',
      [req.organization.id]
    );
    res.json({ links: r.rows });
  } catch (e) {
    console.error('GET /reference-links error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/agents/reference-links — create (and trigger first fetch)
router.post('/reference-links', requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg, async (req, res) => {
  try {
    const { title, url, description, enabled, maxRows, injectMode } = req.body || {};
    if (!title || !url) return res.status(400).json({ error: 'title and url are required' });
    const mode = (injectMode === 'inline') ? 'inline' : 'lookup';
    const id = 'rl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const r = await pool.query(
      'INSERT INTO agent_reference_links (id, organization_id, title, url, description, enabled, max_rows, inject_mode) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [id, req.organization.id, title, url, description || null, enabled !== false, parseInt(maxRows, 10) || 200, mode]
    );
    // Fire and forget the initial fetch — UI shows last_fetch_status
    // and the user can hit /refresh manually if they want to wait for
    // a fresh result.
    refreshLinkRow(r.rows[0]).catch(function (err) {
      console.warn('[reference-links] initial fetch failed for ' + id + ':', err.message);
    });
    // If this new sheet is set to inline, it'll show up in the
    // composed system prompt — force a resync so the agent picks
    // it up on the next chat without waiting for the throttle.
    if (mode === 'inline') {
      resyncDriftedAgents(true).catch(function (err) {
        console.warn('[reference-links] force-sync after POST failed:', err && err.message);
      });
    }
    res.json({ link: r.rows[0] });
  } catch (e) {
    console.error('POST /reference-links error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/admin/agents/reference-links/:id — update fields
router.patch('/reference-links/:id', requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg, async (req, res) => {
  try {
    const id = req.params.id;
    const { title, url, description, enabled, maxRows, injectMode } = req.body || {};
    // Snapshot the prior row so we can detect a mode flip (lookup<->inline)
    // — those are the only edits that require an agent re-sync.
    // Scope check: the row must belong to the caller's org.
    const before = await pool.query(
      'SELECT inject_mode, enabled FROM agent_reference_links WHERE id = $1 AND organization_id = $2',
      [id, req.organization.id]
    );
    if (!before.rows.length) return res.status(404).json({ error: 'not found' });
    const priorMode = before.rows[0] && before.rows[0].inject_mode;
    const priorEnabled = before.rows[0] && before.rows[0].enabled;
    const fields = [];
    const values = [];
    let n = 1;
    if (title       !== undefined) { fields.push('title = $' + (n++));        values.push(title); }
    if (url         !== undefined) { fields.push('url = $' + (n++));          values.push(url); }
    if (description !== undefined) { fields.push('description = $' + (n++));  values.push(description); }
    if (enabled     !== undefined) { fields.push('enabled = $' + (n++));      values.push(!!enabled); }
    if (maxRows     !== undefined) { fields.push('max_rows = $' + (n++));     values.push(parseInt(maxRows, 10) || 200); }
    if (injectMode  !== undefined) {
      const mode = (injectMode === 'inline') ? 'inline' : 'lookup';
      fields.push('inject_mode = $' + (n++)); values.push(mode);
    }
    if (!fields.length) return res.status(400).json({ error: 'no fields to update' });
    fields.push('updated_at = NOW()');
    values.push(id);
    values.push(req.organization.id);
    const r = await pool.query(
      'UPDATE agent_reference_links SET ' + fields.join(', ') +
      ' WHERE id = $' + n + ' AND organization_id = $' + (n + 1) + ' RETURNING *',
      values
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    // If the URL changed, re-fetch.
    if (url !== undefined) {
      refreshLinkRow(r.rows[0]).catch(function (err) {
        console.warn('[reference-links] re-fetch after URL change failed for ' + id + ':', err.message);
      });
    }
    // Detect changes that affect the composed system prompt — mode
    // flip, or enabling/disabling an inline sheet. Force-sync so the
    // change lands on Anthropic immediately instead of waiting for
    // the next 6h throttle window.
    const newMode = r.rows[0].inject_mode;
    const newEnabled = r.rows[0].enabled;
    const modeFlip = (injectMode !== undefined) && (priorMode !== newMode);
    const inlineEnableToggle = (enabled !== undefined) && (priorEnabled !== newEnabled) &&
      (priorMode === 'inline' || newMode === 'inline');
    if (modeFlip || inlineEnableToggle) {
      resyncDriftedAgents(true).catch(function (err) {
        console.warn('[reference-links] force-sync after PATCH failed:', err && err.message);
      });
    }
    res.json({ link: r.rows[0] });
  } catch (e) {
    console.error('PATCH /reference-links error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/agents/reference-links/:id
router.delete('/reference-links/:id', requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg, async (req, res) => {
  try {
    const r = await pool.query(
      'DELETE FROM agent_reference_links WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.organization.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /reference-links error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/agents/reference-links/:id/refresh — force re-fetch
// and wait for the result so the user sees the new status inline.
router.post('/reference-links/:id/refresh', requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM agent_reference_links WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.organization.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    const result = await refreshLinkRow(r.rows[0]);
    const updated = await pool.query('SELECT * FROM agent_reference_links WHERE id = $1', [req.params.id]);
    res.json({ link: updated.rows[0], result: result });
  } catch (e) {
    console.error('POST /reference-links/:id/refresh error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/agents/reference-links/:id/preview — return the
// rendered text + parsed sheets so the admin can verify column
// matches before letting agents see it.
router.get('/reference-links/:id/preview', requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, title, last_fetched_text, last_fetch_status, last_fetched_row_count, last_fetched_at ' +
      'FROM agent_reference_links WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.organization.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ link: r.rows[0] });
  } catch (e) {
    console.error('GET /reference-links/:id/preview error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Helper exported for the agent prompt builder. Returns a single
// concatenated text block of every enabled link's last_fetched_text,
// or '' if there are none / all are stale failures. Trimmed to a
// reasonable cap so a runaway sheet doesn't blow the model context.
const REF_LINKS_PROMPT_CAP = 60000; // ~15k tokens of reference data
//
// Phase D made reference links org-scoped. Callers (composedAgentSystem
// in ai-routes.js, the resync sweep below) MUST pass organizationId so
// the inline block reflects the right tenant. Passing null returns ''
// (defensive — never leak another org's sheets into a composed prompt).
async function buildReferenceLinksBlock(organizationId) {
  if (!organizationId) return '';
  try {
    // Only inject_mode='inline' rows ride along in the registered
    // system prompt. 'lookup' rows are reachable via the
    // search_reference_sheet tool. Default for new rows is 'lookup'
    // so an empty result here just means no sheets are pinned to
    // every turn — exactly the cost-conscious default.
    const r = await pool.query(
      "SELECT title, last_fetched_text, last_fetched_at, last_fetch_status " +
      "FROM agent_reference_links " +
      "WHERE organization_id = $1 AND enabled = TRUE AND inject_mode = 'inline' " +
      "  AND last_fetch_status = 'ok' AND last_fetched_text IS NOT NULL " +
      "ORDER BY created_at ASC",
      [organizationId]
    );
    if (!r.rowCount) return '';
    let out = '\n\n# Live reference sheets\n\n' +
      'These are live company data sheets, refreshed from SharePoint by the server. Use them when the user asks about job numbers, WIP, or anything else listed below.\n';
    for (const row of r.rows) {
      const block = row.last_fetched_text || '';
      if (!block) continue;
      const stamp = row.last_fetched_at ? ' (fetched ' + row.last_fetched_at.toISOString() + ')' : '';
      const candidate = '\n\n[' + row.title + ']' + stamp + '\n' + block;
      if (out.length + candidate.length > REF_LINKS_PROMPT_CAP) break;
      out += candidate;
    }
    return out;
  } catch (e) {
    console.warn('[reference-links] buildReferenceLinksBlock failed:', e.message);
    return '';
  }
}

// Background refresh — every link gets a fresh fetch every 15
// minutes if it's enabled. Runs only on the route's import (the
// server's main module loads this once at boot).
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// Per-agent state we track to decide whether the background refresh
// tick should push a fresh system prompt to Anthropic. Each entry
// holds the SHA1 of the LAST prompt we pushed and the TIMESTAMP we
// pushed it. Cleared on process restart — first cycle after boot
// pushes once, then we throttle.
//
// Why throttle: every anthropic.beta.agents.update bumps the agent
// version, which invalidates Anthropic's per-agent prompt cache.
// Sessions opened (or resumed after the 5-min TTL) AFTER the bump
// pay full cache_creation tokens on the next turn. At Opus 4.7 cache_
// creation rates (~$6.25/M) and a ~300K-token system prompt, one
// unnecessary resync costs ~$1.89. SharePoint refresh ticks every
// 15 min, but the meaningful content rarely moves intra-day —
// without a throttle we were burning $9–18/day on cache invalidation.
const _lastSyncState = new Map(); // anthropic_agent_id → { hash, syncedAt }

// Re-sync only after at least this much wall-clock time AND a real
// content change. Six hours captures any morning vs end-of-day
// SharePoint update; finer granularity is rarely worth the cache cost.
const MIN_RESYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Also gate by content-magnitude — sub-2% byte changes are almost
// always whitespace / timestamp noise from the SharePoint fetcher.
// Bypassed on the very first sync per agent (boot case).
const MIN_DRIFT_RATIO = 0.02;

function _sha1(s) {
  return require('crypto').createHash('sha1').update(String(s || ''), 'utf8').digest('hex');
}

// Re-sync every org's registered managed agent IF the composed
// system prompt has drifted meaningfully since the last push. Called
// after backgroundRefreshAll completes — pre-throttle this was
// hitting the Anthropic agent every 15 min, busting the prompt
// cache. Now it's gated by both content delta + a 6-hour minimum
// interval, so a typical day sees 0–4 syncs instead of ~96.
async function resyncDriftedAgents(force) {
  const anthropic = getAnthropic();
  if (!anthropic) return; // No key on this deployment — skip silently.
  const aiInternals = require('./ai-routes-internals');
  if (!aiInternals || typeof aiInternals.composedAgentSystem !== 'function') return;
  try {
    const r = await pool.query(
      `SELECT r.agent_key, r.organization_id, r.anthropic_agent_id,
              o.id AS org_id, o.slug, o.name, o.description, o.identity_body
         FROM managed_agent_registry r
         JOIN organizations o ON o.id = r.organization_id
        WHERE r.anthropic_agent_id IS NOT NULL
          AND r.agent_key = 'job'`
    );
    for (const row of r.rows) {
      try {
        const baseline = AGENT_SYSTEM_BASELINE[row.agent_key];
        if (!baseline) continue;
        const org = {
          id: row.org_id, slug: row.slug, name: row.name,
          description: row.description, identity_body: row.identity_body
        };
        const composed = await aiInternals.composedAgentSystem(row.agent_key, baseline, org);
        const newHash = _sha1(composed);
        const prev = _lastSyncState.get(row.anthropic_agent_id);

        // Decision logic, in order:
        //   1. Force=true (e.g. admin clicked Sync now): always push.
        //   2. No prior sync this process: push (boot case).
        //   3. Hash identical: skip (no content change at all).
        //   4. < 6 hours since last push: skip (throttle).
        //   5. Tiny drift (<2% byte change): skip (whitespace noise).
        //   6. Real drift, throttle window passed: push.
        if (!force && prev) {
          if (prev.hash === newHash) continue;
          if (Date.now() - prev.syncedAt < MIN_RESYNC_INTERVAL_MS) {
            console.log('[reference-links] skipping resync of', row.anthropic_agent_id,
              '— throttled (last sync ' + Math.round((Date.now() - prev.syncedAt) / 60000) + 'min ago)');
            continue;
          }
          // Crude drift magnitude: ratio of byte-length delta to the larger size.
          // Sub-2% is almost certainly noise; bigger means content actually moved.
          const sizeDelta = Math.abs(composed.length - (prev.size || composed.length));
          const drift = composed.length ? sizeDelta / composed.length : 1;
          if (drift < MIN_DRIFT_RATIO) {
            // Same logical content; treat as the same sync to avoid a
            // re-check next tick.
            _lastSyncState.set(row.anthropic_agent_id, { hash: newHash, syncedAt: prev.syncedAt, size: composed.length });
            continue;
          }
        }

        const remote = await anthropic.beta.agents.retrieve(row.anthropic_agent_id);
        if (remote.archived_at) {
          // Don't auto-recreate archived agents from a background tick;
          // admin's sync-all endpoint handles that.
          continue;
        }
        await anthropic.beta.agents.update(row.anthropic_agent_id, {
          version: remote.version,
          system: composed
        });
        _lastSyncState.set(row.anthropic_agent_id, { hash: newHash, syncedAt: Date.now(), size: composed.length });
        console.log('[reference-links] resynced agent', row.anthropic_agent_id,
          '— composed system prompt drifted (' + composed.length + ' chars)' +
          (force ? ' [forced]' : ''));
      } catch (e) {
        console.warn('[reference-links] resync failed for', row.anthropic_agent_id, ':', e && e.message);
      }
    }
  } catch (e) {
    console.warn('[reference-links] resyncDriftedAgents outer error:', e && e.message);
  }
}

async function backgroundRefreshAll() {
  try {
    const r = await pool.query(
      'SELECT * FROM agent_reference_links WHERE enabled = TRUE'
    );
    let anyRefreshed = false;
    for (const row of r.rows) {
      // Skip rows we already refreshed within the window.
      if (row.last_fetched_at) {
        const age = Date.now() - new Date(row.last_fetched_at).getTime();
        if (age < REFRESH_INTERVAL_MS) continue;
      }
      try {
        await refreshLinkRow(row);
        anyRefreshed = true;
      } catch (e) { console.warn('[reference-links] bg refresh failed for ' + row.id + ':', e.message); }
    }
    // If we actually pulled any new data — OR if this is the boot
    // tick and the hash map is still empty — sweep the agents and
    // re-sync any whose composed prompt has drifted. The boot case
    // matters because the cached system prompt on Anthropic might
    // be days old (last admin click), so we want to land fresh
    // reference data on session 1 after a deploy.
    // Only call the resync sweep when we actually pulled new
    // reference-link data OR we haven't synced anything yet this
    // process (boot case). resyncDriftedAgents itself enforces the
    // 6-hour + 2% drift throttle.
    if (anyRefreshed || _lastSyncState.size === 0) {
      await resyncDriftedAgents();
    }
  } catch (e) {
    console.warn('[reference-links] backgroundRefreshAll outer error:', e.message);
  }
}
// Run at boot (after a small delay so DB init has time) and every
// 15 minutes thereafter. setInterval reference is intentionally not
// stored — process exit cleans up.
setTimeout(backgroundRefreshAll, 30 * 1000);
setInterval(backgroundRefreshAll, REFRESH_INTERVAL_MS);

// ──────── Anthropic-side agent inspection & sync (Phase 2) ────────
//
// The legacy /managed/reregister endpoint creates a brand-new agent
// every time it runs (new anthropic_agent_id, version 1). That's
// wrong for incremental updates — sessions bound to the old id keep
// using stale config. Anthropic's beta.agents.update() lets us push
// a new version of the SAME agent_id with the CAS-style `version`
// guard so concurrent updates can't clobber each other.
//
// The endpoints below give the admin a "look at the console" flow:
//   GET  → fetch current Anthropic-side state (version, model, etc.)
//   POST → push local config as a new version

// GET /api/admin/agents/managed/:agentKey/anthropic-state
//   Retrieves the current Anthropic-side record for this agent and
//   compares it to what the local code would generate. Useful when
//   the admin asks "is p86job up to date?" — the response includes
//   the version, last updated_at, tool/skill counts on Anthropic vs
//   local, and a list of fields that drifted.
router.get('/managed/:agentKey/anthropic-state', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '').toLowerCase();
    if (!['ag', 'job', 'cra', 'staff'].includes(agentKey)) {
      return res.status(400).json({ error: 'agentKey must be ag | job | cra | staff' });
    }
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

    const reg = await pool.query(
      `SELECT * FROM managed_agent_registry WHERE agent_key = $1`,
      [agentKey]
    );
    if (!reg.rows.length) {
      return res.json({
        registered: false,
        agent_key: agentKey,
        note: 'Agent is not yet registered. Click Bootstrap to create it on Anthropic.'
      });
    }
    const row = reg.rows[0];
    const remoteAgent = await anthropic.beta.agents.retrieve(row.anthropic_agent_id);

    // Build what the local code WOULD register so we can flag drift.
    // Pull the registry row's organization so collectSkillsFor can
    // include the org's mirrored org_skill_packs in the local count.
    const baseline = AGENT_SYSTEM_BASELINE[agentKey] || '';
    const aiInternals = require('./ai-routes-internals');
    const localModel = aiInternals && aiInternals.defaultModel ? aiInternals.defaultModel() : 'claude-sonnet-4-6';
    let localOrg = null;
    if (row.organization_id) {
      const orgRow = await pool.query('SELECT * FROM organizations WHERE id = $1', [row.organization_id]);
      localOrg = orgRow.rows[0] || null;
    }
    const localSkills = await collectSkillsFor(agentKey, localOrg);
    const localCustom = customToolsFor(agentKey);
    const localBuiltin = builtinToolsetFor(agentKey);
    const localToolCount = localCustom.length + localBuiltin.length;
    const localSkillCount = localSkills.length;
    const localSystem = baseline;
    const localName = 'Project 86 ' + agentKey.toUpperCase();
    const localDescription = baseline.slice(0, 200);

    // Drift signals — anything where the Anthropic-side value clearly
    // diverges from what we'd push now. Models on Anthropic can be a
    // full object (BetaManagedAgentsModelConfig) so unwrap .model.
    const remoteModel = (remoteAgent.model && (remoteAgent.model.model || remoteAgent.model)) || '';
    const remoteSkillCount = Array.isArray(remoteAgent.skills) ? remoteAgent.skills.length : 0;
    const remoteToolCount = Array.isArray(remoteAgent.tools) ? remoteAgent.tools.length : 0;
    const remoteSystem = remoteAgent.system || '';

    const drift = [];
    if (remoteModel && remoteModel !== localModel) {
      drift.push({ field: 'model', remote: remoteModel, local: localModel });
    }
    if (remoteSkillCount !== localSkillCount) {
      drift.push({ field: 'skill_count', remote: remoteSkillCount, local: localSkillCount });
    }
    if (remoteToolCount !== localToolCount) {
      drift.push({ field: 'tool_count', remote: remoteToolCount, local: localToolCount });
    }
    if (remoteSystem !== localSystem) {
      drift.push({
        field: 'system_prompt',
        remote_length: remoteSystem.length,
        local_length: localSystem.length,
        remote_snippet: remoteSystem.slice(0, 120),
        local_snippet: localSystem.slice(0, 120)
      });
    }
    if ((remoteAgent.name || '') !== localName) {
      drift.push({ field: 'name', remote: remoteAgent.name, local: localName });
    }
    if ((remoteAgent.description || '') !== localDescription) {
      drift.push({ field: 'description', remote_length: (remoteAgent.description || '').length, local_length: localDescription.length });
    }

    res.json({
      registered: true,
      agent_key: agentKey,
      anthropic_agent_id: row.anthropic_agent_id,
      anthropic: {
        version: remoteAgent.version,
        name: remoteAgent.name,
        description: remoteAgent.description,
        model: remoteModel,
        skill_count: remoteSkillCount,
        tool_count: remoteToolCount,
        system_length: remoteSystem.length,
        created_at: remoteAgent.created_at,
        updated_at: remoteAgent.updated_at,
        archived_at: remoteAgent.archived_at
      },
      local: {
        model: localModel,
        skill_count: localSkillCount,
        tool_count: localToolCount,
        system_length: localSystem.length,
        name: localName,
        description_length: localDescription.length
      },
      drift,
      up_to_date: drift.length === 0
    });
  } catch (e) {
    console.error('GET /managed/:agentKey/anthropic-state error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/agents/managed/:agentKey/sync
//   Pushes the local agent definition to Anthropic as a new version of
//   the SAME agent_id (versions, not a fresh create). Uses the CAS
//   `version` precondition so a concurrent update can't clobber.
//
//   Optional body: { force_version?: number } — bypass the auto-fetch
//   of current version and use this value. Useful when the admin
//   already knows the version from the inspection endpoint.
router.post('/managed/:agentKey/sync',
  requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg,
  async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '').toLowerCase();
    if (!['ag', 'job', 'cra', 'staff'].includes(agentKey)) {
      return res.status(400).json({ error: 'agentKey must be ag | job | cra | staff' });
    }
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

    const reg = await pool.query(
      `SELECT anthropic_agent_id FROM managed_agent_registry
        WHERE agent_key = $1 AND organization_id = $2`,
      [agentKey, req.organization.id]
    );
    if (!reg.rows.length) return res.status(404).json({ error: 'Agent is not yet registered for ' + req.organization.slug + '. Click Bootstrap first.' });
    const agentId = reg.rows[0].anthropic_agent_id;

    const baseline = AGENT_SYSTEM_BASELINE[agentKey] || '';
    const aiInternals = require('./ai-routes-internals');
    const model = aiInternals && aiInternals.defaultModel ? aiInternals.defaultModel() : 'claude-sonnet-4-6';
    const skills = await collectSkillsFor(agentKey, req.organization);
    const customTools = customToolsFor(agentKey);
    const builtinTools = builtinToolsetFor(agentKey);
    const toolList = [...builtinTools, ...customTools];
    const toolCount = customTools.length + builtinTools.length;
    const mcpServers = await collectMcpServersFor(req.organization);
    const name = 'Project 86 ' + agentKey.toUpperCase() + ' · ' + (req.organization.name || req.organization.slug);
    const description = (req.organization.description || baseline).slice(0, 200);
    // Compose: platform baseline + org.identity_body + SECTION_DEFAULTS.
    // Per-org content is cached on the Anthropic agent.
    const composedSystem = (aiInternals && aiInternals.composedAgentSystem)
      ? await aiInternals.composedAgentSystem(agentKey, baseline, req.organization)
      : baseline;

    // Always retrieve so we can detect archived state (no unarchive
    // endpoint on Anthropic — archived means we have to mint a
    // fresh agent). force_version still bypasses the CAS lookup
    // when supplied; in that case we trust the caller saw the
    // archived flag separately.
    const remote = await anthropic.beta.agents.retrieve(agentId);
    if (remote.archived_at) {
      // Archived → create fresh, replace registry row.
      const createPayload = {
        model: model,
        name: name,
        description: description,
        system: composedSystem,
        skills: skills,
        tools: toolList
      };
      if (mcpServers.length) createPayload.mcp_servers = mcpServers;
      const created = await anthropic.beta.agents.create(createPayload);
      await pool.query(
        `UPDATE managed_agent_registry
            SET anthropic_agent_id = $3,
                model = $4,
                tool_count = $5,
                skill_count = $6,
                updated_at = NOW()
          WHERE agent_key = $1 AND organization_id = $2`,
        [agentKey, req.organization.id, created.id, model, toolCount, skills.length]
      );
      return res.json({
        ok: true,
        agent_key: agentKey,
        organization_id: req.organization.id,
        status: 'recreated_after_archive',
        anthropic_agent_id: created.id,
        previous_anthropic_agent_id: agentId,
        new_version: created.version,
        tool_count: toolCount,
        skill_count: skills.length,
        note: 'Previous agent was archived on Anthropic. Created a fresh agent (new id, v1). Any v2 sessions bound to the old id are dead — start fresh chats to bind to the new id.'
      });
    }

    let currentVersion;
    if (req.body && typeof req.body.force_version === 'number') {
      currentVersion = req.body.force_version;
    } else {
      currentVersion = remote.version;
    }

    const updatePayload = {
      version: currentVersion,
      name: name,
      description: description,
      model: model,
      system: composedSystem,
      skills: skills,
      tools: toolList
    };
    if (mcpServers.length) updatePayload.mcp_servers = mcpServers;
    const updated = await anthropic.beta.agents.update(agentId, updatePayload);

    await pool.query(
      `UPDATE managed_agent_registry
          SET model = $3,
              tool_count = $4,
              skill_count = $5,
              updated_at = NOW()
        WHERE agent_key = $1 AND organization_id = $2`,
      [agentKey, req.organization.id, model, toolCount, skills.length]
    );

    res.json({
      ok: true,
      agent_key: agentKey,
      organization_id: req.organization.id,
      status: 'updated',
      anthropic_agent_id: agentId,
      new_version: updated.version,
      previous_version: currentVersion,
      tool_count: toolCount,
      skill_count: skills.length
    });
  } catch (e) {
    console.error('POST /managed/:agentKey/sync error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// DELETE /api/admin/agents/managed/:agentKey
//   Removes a stale row from managed_agent_registry. Does NOT touch
//   the Anthropic-side agent — that has its own delete/archive flow.
//   Use this when the local registry has a row whose agent_key was
//   retired (e.g. 'intake' after the merge into 86).
router.delete('/managed/:agentKey', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '').toLowerCase();
    if (!agentKey) return res.status(400).json({ error: 'agentKey is required' });
    const r = await pool.query(
      `DELETE FROM managed_agent_registry WHERE agent_key = $1 RETURNING anthropic_agent_id`,
      [agentKey]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No registry row for that agent_key.' });
    res.json({ ok: true, agent_key: agentKey, freed_anthropic_agent_id: r.rows[0].anthropic_agent_id });
  } catch (e) {
    console.error('DELETE /managed/:agentKey error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/agents/managed/sync-all
//   Bulk variant — syncs every registered agent in one round-trip.
//   Loops the per-agent sync logic and returns a per-agent summary so
//   the UI can show which ones moved + which failed. Failures on one
//   agent don't abort the rest; each agent gets its own try/catch.
// POST /api/admin/agents/managed/sync-all
//   Sync every (agent_key, organization_id) registry row to its
//   Anthropic agent. Body { organization_id?: number } scopes to a
//   single tenant — omit to sync EVERY tenant the platform owner
//   manages. The caller's own organization is the default if no
//   body param is given.
router.post('/managed/sync-all',
  requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg,
  async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

    // Default to syncing only the caller's org. Future: a platform-
    // owner role can pass ?all_orgs=true to sync every tenant.
    const targetOrgId = (req.body && req.body.organization_id) || req.organization.id;
    const reg = await pool.query(
      `SELECT r.agent_key, r.organization_id, r.anthropic_agent_id,
              o.slug AS org_slug, o.name AS org_name, o.description AS org_description, o.identity_body AS org_identity_body
         FROM managed_agent_registry r
         JOIN organizations o ON o.id = r.organization_id
        WHERE r.organization_id = $1
        ORDER BY r.agent_key`,
      [targetOrgId]
    );
    if (!reg.rows.length) {
      return res.json({ summary: [], note: 'No agents registered for organization ' + targetOrgId + '. Bootstrap first.' });
    }

    const aiInternals = require('./ai-routes-internals');
    const model = aiInternals && aiInternals.defaultModel ? aiInternals.defaultModel() : 'claude-sonnet-4-6';
    const summary = [];

    for (const row of reg.rows) {
      const agentKey = row.agent_key;
      const agentId = row.anthropic_agent_id;
      const org = {
        id: row.organization_id,
        slug: row.org_slug,
        name: row.org_name,
        description: row.org_description,
        identity_body: row.org_identity_body
      };
      try {
        const baseline = AGENT_SYSTEM_BASELINE[agentKey];
        if (!baseline) {
          // Stale registry row — agent_key isn't in the current set
          // (e.g. 'cra'/'staff' from the pre-unification era).
          summary.push({
            agent_key: agentKey,
            organization_id: row.organization_id,
            ok: false,
            status: 'stale_row',
            error: 'No baseline for agent_key=' + agentKey + ' — delete this row.'
          });
          continue;
        }

        const skills = await collectSkillsFor(agentKey, org);
        const customTools = customToolsFor(agentKey);
        const builtinTools = builtinToolsetFor(agentKey);
        const toolList = [...builtinTools, ...customTools];
        const toolCount = customTools.length + builtinTools.length;
        const name = 'Project 86 ' + agentKey.toUpperCase() + ' · ' + (org.name || org.slug);
        const description = (org.description || baseline).slice(0, 200);
        const composedSystem = (aiInternals && aiInternals.composedAgentSystem)
          ? await aiInternals.composedAgentSystem(agentKey, baseline, org)
          : baseline;

        const remote = await anthropic.beta.agents.retrieve(agentId);
        if (remote.archived_at) {
          const created = await anthropic.beta.agents.create({
            model: model,
            name: name,
            description: description,
            system: composedSystem,
            skills: skills,
            tools: toolList
          });
          await pool.query(
            `UPDATE managed_agent_registry
                SET anthropic_agent_id = $3,
                    model = $4,
                    tool_count = $5,
                    skill_count = $6,
                    updated_at = NOW()
              WHERE agent_key = $1 AND organization_id = $2`,
            [agentKey, row.organization_id, created.id, model, toolCount, skills.length]
          );
          summary.push({
            agent_key: agentKey,
            organization_id: row.organization_id,
            ok: true,
            status: 'recreated_after_archive',
            anthropic_agent_id: created.id,
            previous_anthropic_agent_id: agentId,
            new_version: created.version,
            tool_count: toolCount,
            skill_count: skills.length
          });
          continue;
        }

        const currentVersion = remote.version;
        const updated = await anthropic.beta.agents.update(agentId, {
          version: currentVersion,
          name: name,
          description: description,
          model: model,
          system: composedSystem,
          skills: skills,
          tools: toolList
        });

        // Record this manual sync against the throttle map so the
        // 15-min background tick doesn't immediately re-sync if its
        // drift detector also trips. Without this the admin's Sync
        // button + the auto-resync could double-push and rebuild
        // cache twice.
        _lastSyncState.set(agentId, { hash: _sha1(composedSystem), syncedAt: Date.now(), size: composedSystem.length });

        await pool.query(
          `UPDATE managed_agent_registry
              SET model = $3,
                  tool_count = $4,
                  skill_count = $5,
                  updated_at = NOW()
            WHERE agent_key = $1 AND organization_id = $2`,
          [agentKey, row.organization_id, model, toolCount, skills.length]
        );

        summary.push({
          agent_key: agentKey,
          organization_id: row.organization_id,
          ok: true,
          status: 'updated',
          anthropic_agent_id: agentId,
          previous_version: currentVersion,
          new_version: updated.version,
          tool_count: toolCount,
          skill_count: skills.length
        });
      } catch (e) {
        summary.push({ agent_key: agentKey, organization_id: row.organization_id, ok: false, status: 'error', error: e.message || 'unknown' });
      }
    }

    res.json({ summary });
  } catch (e) {
    console.error('POST /managed/sync-all error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// ──────── Native Skills assignment per agent (Phase 2) ────────
//
// Stores assignment rows in managed_agent_skills (agent_key, skill_id).
// The UI surfaces these per agent; collectSkillsFor unions them with
// the legacy local-pack source for back-compat. New work goes
// straight into this table — the legacy path is just there so we
// don't break working state during the transition.
//
// The skill_id list returned here mixes 'attached' (in our table)
// with metadata from the Anthropic side (display_title, description,
// created_at) so the UI can render a useful row without a second
// round-trip per skill.

// GET /api/admin/agents/:agentKey/native-skills
//   Returns: { assigned: [{skill_id, position, enabled, ...metadata}],
//              available: [{id, display_title, description, created_at}] }
//   `assigned` is everything in our table for this agent (joined with
//   beta.skills metadata where available). `available` is the full
//   Anthropic-side skill list minus already-assigned ones — the UI
//   uses this to populate an "Attach a skill" picker.
router.get('/:agentKey/native-skills',
  requireAuth, requireCapability('ROLES_MANAGE'), require('../auth').requireOrg,
  async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '').trim();
    if (!agentKey) return res.status(400).json({ error: 'agentKey is required' });

    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

    // Load Anthropic-side metadata for ALL skills (we'll filter into
    // assigned vs available below). Cap at 200 — accounts with more
    // than that are unlikely in practice. Phantom rows (no skill_ id
    // prefix) get stripped here so they never appear in the UI.
    let allSkills = [];
    try {
      const page = await anthropic.beta.skills.list({ limit: 200 });
      const raw = (page && (page.data || page)) || [];
      allSkills = (Array.isArray(raw) ? raw : []).filter(s =>
        s && typeof s.id === 'string' && s.id.startsWith('skill_')
      );
    } catch (e) {
      console.warn('[native-skills GET] beta.skills.list failed:', e.message);
    }
    const metaById = new Map();
    allSkills.forEach(s => { if (s && s.id) metaById.set(s.id, s); });

    // Two sources of "this skill is attached to this agent":
    // 1. managed_agent_skills — legacy direct-attach table (admin
    //    clicks "Attach" in the UI). Keyed by agent_key only.
    // 2. org_skill_packs.anthropic_skill_id — the per-tenant bridge
    //    that collectSkillsFor() reads. This is how the 12 mirrored
    //    packs reach the agent at sync time. The UI must report these
    //    as "attached" or the admin sees the misleading "No native
    //    skills attached" message while the agent actually has 12.
    const direct = await pool.query(
      `SELECT skill_id, position, enabled, created_at FROM managed_agent_skills
        WHERE agent_key = $1
        ORDER BY position ASC, created_at ASC`,
      [agentKey]
    );

    const orgId = req.organization && req.organization.id;
    const bridged = orgId
      ? await pool.query(
          `SELECT anthropic_skill_id AS skill_id, name AS pack_name, created_at
             FROM org_skill_packs
            WHERE organization_id = $1
              AND anthropic_skill_id IS NOT NULL
              AND archived_at IS NULL
              AND ($2::text = ANY (
                  SELECT jsonb_array_elements_text(agents)
                ) OR $2 = 'job')
            ORDER BY created_at ASC`,
          [orgId, agentKey]
        )
      : { rows: [] };

    const assignedIds = new Set();
    const assigned = [];

    // Direct attachments first (preserve admin-set position order).
    direct.rows.forEach(row => {
      if (assignedIds.has(row.skill_id)) return;
      assignedIds.add(row.skill_id);
      const meta = metaById.get(row.skill_id) || {};
      assigned.push({
        skill_id: row.skill_id,
        position: row.position,
        enabled: row.enabled,
        attached_at: row.created_at,
        source: 'direct',
        display_title: meta.display_title || meta.name || null,
        description: meta.description || null,
        anthropic_created_at: meta.created_at || null,
        anthropic_missing: !metaById.has(row.skill_id)
      });
    });

    // Org-pack bridge attachments. These don't have a position — they
    // ride along automatically based on the per-tenant pack registry.
    bridged.rows.forEach(row => {
      if (assignedIds.has(row.skill_id)) return;
      assignedIds.add(row.skill_id);
      const meta = metaById.get(row.skill_id) || {};
      assigned.push({
        skill_id: row.skill_id,
        position: null,
        enabled: true,
        attached_at: row.created_at,
        source: 'org_skill_pack',
        pack_name: row.pack_name,
        display_title: meta.display_title || meta.name || row.pack_name || null,
        description: meta.description || null,
        anthropic_created_at: meta.created_at || null,
        anthropic_missing: !metaById.has(row.skill_id)
      });
    });

    const available = allSkills
      .filter(s => s && s.id && !assignedIds.has(s.id))
      .map(s => ({
        id: s.id,
        display_title: s.display_title || s.name || null,
        description: s.description || null,
        created_at: s.created_at || null
      }));

    res.json({ agent_key: agentKey, assigned, available });
  } catch (e) {
    console.error('GET /agents/:agentKey/native-skills error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/agents/:agentKey/native-skills
//   Body: { skill_id: string, position?: number }
//   Attaches the skill_id to this agent. Idempotent: re-attaching an
//   already-attached skill returns ok without error.
router.post('/:agentKey/native-skills', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '').trim();
    const skillId = String(req.body && req.body.skill_id || '').trim();
    if (!agentKey || !skillId) return res.status(400).json({ error: 'agentKey and skill_id are required' });

    // Default position = max(existing) + 1 so new attachments append.
    let position;
    if (typeof req.body.position === 'number' && Number.isFinite(req.body.position)) {
      position = Math.max(0, Math.floor(req.body.position));
    } else {
      const mr = await pool.query(
        `SELECT COALESCE(MAX(position), -1) AS max_pos FROM managed_agent_skills WHERE agent_key = $1`,
        [agentKey]
      );
      position = (mr.rows[0] && mr.rows[0].max_pos != null) ? Number(mr.rows[0].max_pos) + 1 : 0;
    }

    await pool.query(
      `INSERT INTO managed_agent_skills (agent_key, skill_id, position, enabled, created_at)
       VALUES ($1, $2, $3, true, NOW())
       ON CONFLICT (agent_key, skill_id) DO UPDATE
         SET enabled = true, position = EXCLUDED.position`,
      [agentKey, skillId, position]
    );

    res.json({ ok: true, agent_key: agentKey, skill_id: skillId, position });
  } catch (e) {
    console.error('POST /agents/:agentKey/native-skills error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// DELETE /api/admin/agents/:agentKey/native-skills/:skillId
//   Detaches the skill from this agent. Does NOT delete the skill
//   from Anthropic — that's a separate operation
//   (DELETE /api/admin/anthropic/skills/:id).
router.delete('/:agentKey/native-skills/:skillId', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '').trim();
    const skillId = String(req.params.skillId || '').trim();
    if (!agentKey || !skillId) return res.status(400).json({ error: 'agentKey and skill_id are required' });
    await pool.query(
      `DELETE FROM managed_agent_skills WHERE agent_key = $1 AND skill_id = $2`,
      [agentKey, skillId]
    );
    res.json({ ok: true, agent_key: agentKey, skill_id: skillId });
  } catch (e) {
    console.error('DELETE /agents/:agentKey/native-skills/:skillId error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// Exported so ai-routes.js (Phase 1b chat path) can resolve the
// environment + agent ids without duplicating the SQL.
module.exports = router;
module.exports.ensureManagedAgent = ensureManagedAgent;
module.exports.ensureManagedEnvironment = ensureManagedEnvironment;
module.exports.buildReferenceLinksBlock = buildReferenceLinksBlock;
module.exports.collectMcpServersFor = collectMcpServersFor;
