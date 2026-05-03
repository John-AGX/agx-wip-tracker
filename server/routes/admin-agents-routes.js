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
  job:      '📊 Elle (WIP Analyst)',
  client:   '🤝 HR (Customer Relations)'
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
// internals that production AG / Elle / HR consult on every chat turn,
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
    // conversation. Replays an estimate against AG, a job against Elle,
    // a client thread against HR, a staff thread against the chief
    // of staff.
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

module.exports = router;
