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

// Friendly labels mirror the front-end AGENT_LABELS.
const AGENT_LABELS = {
  estimate: '📐 AG (Estimator)',
  job:      '📊 WIP (Financial Analyst)',
  client:   '🤝 CRA (Customer Relations)'
};

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
router.get('/metrics', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const range = (req.query.range === '30d') ? '30 days' : '7 days';

    // Per-agent aggregates. role='assistant' rows carry the model +
    // token usage, so total_turns counts those; user rows are the
    // user-message side and don't carry tokens.
    const aggSql = `
      SELECT
        entity_type,
        COUNT(*) FILTER (WHERE role = 'assistant')                 AS turns,
        COUNT(*) FILTER (WHERE role = 'user')                      AS user_msgs,
        COUNT(DISTINCT (estimate_id, user_id))                     AS conversations,
        COUNT(DISTINCT user_id)                                    AS unique_users,
        COALESCE(SUM(input_tokens),  0)::bigint                    AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint                    AS output_tokens,
        COALESCE(SUM(tool_use_count), 0)::bigint                   AS tool_uses,
        COALESCE(SUM(photos_included), 0)::bigint                  AS photos_attached
      FROM ai_messages
      WHERE created_at >= NOW() - INTERVAL '${range}'
      GROUP BY entity_type
      ORDER BY entity_type
    `;
    const aggRes = await pool.query(aggSql);

    // Model-mix breakdown — useful when multiple models are in
    // rotation (A/B trials, sonnet vs opus). We approximate cost too.
    const modelSql = `
      SELECT
        entity_type,
        COALESCE(model, 'unknown') AS model,
        COUNT(*) FILTER (WHERE role = 'assistant') AS turns,
        COALESCE(SUM(input_tokens),  0)::bigint AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
      FROM ai_messages
      WHERE created_at >= NOW() - INTERVAL '${range}'
        AND role = 'assistant'
      GROUP BY entity_type, model
      ORDER BY entity_type, turns DESC
    `;
    const modelRes = await pool.query(modelSql);

    // Build the response payload. Always include all three agent
    // buckets (even if empty) so the UI can render zero-state cards
    // consistently.
    const byType = new Map(aggRes.rows.map(r => [r.entity_type, r]));
    const byTypeModel = new Map();
    for (const r of modelRes.rows) {
      if (!byTypeModel.has(r.entity_type)) byTypeModel.set(r.entity_type, []);
      byTypeModel.get(r.entity_type).push({
        model: r.model,
        turns: Number(r.turns),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        cost_usd: costFor(r.model, r.input_tokens, r.output_tokens)
      });
    }

    const agents = Object.keys(AGENT_LABELS).map(et => {
      const r = byType.get(et) || {};
      return {
        entity_type: et,
        label: AGENT_LABELS[et],
        turns: Number(r.turns || 0),
        user_msgs: Number(r.user_msgs || 0),
        conversations: Number(r.conversations || 0),
        unique_users: Number(r.unique_users || 0),
        input_tokens: Number(r.input_tokens || 0),
        output_tokens: Number(r.output_tokens || 0),
        tool_uses: Number(r.tool_uses || 0),
        photos_attached: Number(r.photos_attached || 0),
        models: byTypeModel.get(et) || []
      };
    });

    res.json({ range, agents });
  } catch (e) {
    console.error('GET /api/admin/agents/metrics error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/agents/conversations?range=7d|30d&entity_type=&user_id=&limit=
//
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
      const r = await pool.query(`SELECT id, title FROM estimates WHERE id = ANY($1::text[])`, [estIds]);
      r.rows.forEach(x => entityTitleByKey.set('estimate|' + x.id, x.title));
    }
    const jobIds = groupBy('job');
    if (jobIds.length) {
      // jobs.id is text in this schema; same lookup pattern.
      const r = await pool.query(
        `SELECT id, COALESCE(NULLIF(name, ''), 'Job ' || id) AS title FROM jobs WHERE id = ANY($1::text[])`,
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
      const e = await pool.query('SELECT title FROM estimates WHERE id = $1', [entityId]);
      if (e.rows[0]) entityTitle = e.rows[0].title || entityId;
    } else if (entityType === 'job') {
      const j = await pool.query('SELECT name FROM jobs WHERE id = $1', [entityId]);
      if (j.rows[0]) entityTitle = j.rows[0].name || entityId;
    } else if (entityId === '__global__') {
      entityTitle = 'Customer directory';
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

module.exports = router;
