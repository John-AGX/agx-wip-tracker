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
// agent — every surface (estimate / job / intake / ask86 / unified 86)
// rolls up to a single '86' identity here. HR has its own. CoS is
// shown only when it has activity. The metrics SQL maps entity_type
// → identity via a CASE expression so the SQL aggregates collapse.
const AGENT_LABELS = {
  '86':    '86',
  'hr':    'HR (data steward)',
  'staff': 'Chief of Staff'
};

// Map raw entity_type values in ai_messages to a logical agent
// identity. Kept as a SQL CASE generator + a JS helper so the
// metrics aggregation and any client-side rollup stay in sync.
const ENTITY_TYPE_TO_AGENT_SQL = `
  CASE
    WHEN entity_type IN ('estimate', 'job', 'intake', 'ask86', '86') THEN '86'
    WHEN entity_type = 'client' THEN 'hr'
    WHEN entity_type = 'staff' THEN 'staff'
    ELSE entity_type
  END
`;
function entityTypeToAgent(entityType) {
  if (['estimate', 'job', 'intake', 'ask86', '86'].includes(entityType)) return '86';
  if (entityType === 'client') return 'hr';
  if (entityType === 'staff') return 'staff';
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
router.get('/metrics', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const range = (req.query.range === '30d') ? '30 days' : '7 days';

    // Per-agent aggregates rolled up to agent identity (86 / hr /
    // staff). The user's "estimator" vs "operator" split was an
    // artifact of entity_type — both are 86. The CASE expression
    // collapses them so the UI shows ONE 86 row.
    const aggSql = `
      SELECT
        ${ENTITY_TYPE_TO_AGENT_SQL}                                AS agent,
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
      GROUP BY agent
      ORDER BY agent
    `;
    const aggRes = await pool.query(aggSql);

    // Model-mix breakdown — useful when multiple models are in
    // rotation (A/B trials, sonnet vs opus). Same rollup so the
    // pricing rolls up alongside the rest of the agent's traffic.
    const modelSql = `
      SELECT
        ${ENTITY_TYPE_TO_AGENT_SQL}                AS agent,
        COALESCE(model, 'unknown') AS model,
        COUNT(*) FILTER (WHERE role = 'assistant') AS turns,
        COALESCE(SUM(input_tokens),  0)::bigint AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
      FROM ai_messages
      WHERE created_at >= NOW() - INTERVAL '${range}'
        AND role = 'assistant'
      GROUP BY agent, model
      ORDER BY agent, turns DESC
    `;
    const modelRes = await pool.query(modelSql);

    // Build the response payload. Always include all three agent
    // identities (even if empty) so the UI renders zero-state cards
    // consistently.
    const byAgent = new Map(aggRes.rows.map(r => [r.agent, r]));
    const byAgentModel = new Map();
    for (const r of modelRes.rows) {
      if (!byAgentModel.has(r.agent)) byAgentModel.set(r.agent, []);
      byAgentModel.get(r.agent).push({
        model: r.model,
        turns: Number(r.turns),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        cost_usd: costFor(r.model, r.input_tokens, r.output_tokens)
      });
    }

    const agents = Object.keys(AGENT_LABELS).map(agentKey => {
      const r = byAgent.get(agentKey) || {};
      return {
        // Keep the response field name `entity_type` for backwards
        // compatibility with the UI; the value is now the agent
        // identity (86 / hr / staff), not a raw entity_type.
        entity_type: agentKey,
        label: AGENT_LABELS[agentKey],
        turns: Number(r.turns || 0),
        user_msgs: Number(r.user_msgs || 0),
        conversations: Number(r.conversations || 0),
        unique_users: Number(r.unique_users || 0),
        input_tokens: Number(r.input_tokens || 0),
        output_tokens: Number(r.output_tokens || 0),
        tool_uses: Number(r.tool_uses || 0),
        photos_attached: Number(r.photos_attached || 0),
        models: byAgentModel.get(agentKey) || []
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
// internals that production 86 / HR consult on every chat turn,
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
function buildSkillMarkdown(pack) {
  const name = (pack.name || 'Project 86 skill').replace(/[\r\n]/g, ' ');
  const desc = (pack.replaces_section
    ? 'Section override for ' + pack.replaces_section
    : (pack.category ? 'Category: ' + pack.category : name)
  ).replace(/[\r\n]/g, ' ');
  const lines = [
    '---',
    'name: ' + name,
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
//   ?agent=ag|elle|hr|cos     — required. Which agent's system prompt to assemble.
//   ?estimate_id=<id>         — required when agent=ag
//   ?job_id=<id>              — required when agent=elle
//
// Returns the EXACT system-prompt blocks the agent would see right
// now if a chat turn were initiated against the supplied entity:
//   - stable_prefix: cached playbook (identity / structure / tools /
//     slotting / etc.) — token-counted so admin can see what % of the
//     turn is cacheable.
//   - dynamic_context: per-turn estimate / job / client data (refreshed
//     each turn — never cached).
//   - tools: list of tool names available to this agent in this phase.
//   - skill_packs: which always-on packs from app_settings.agent_skills
//     are loaded for this agent.
//   - ai_phase: 'plan' | 'build' (when applicable).
//
// Read-only, no side effects on conversation history. Used by
// Admin → Agents → Prompt Preview to show "what does AG actually see?"
router.get('/preview-prompt', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const aiInternals = require('./ai-routes-internals');
    if (!aiInternals) throw new Error('ai-routes internals not available.');
    const agent = String(req.query.agent || '').toLowerCase();
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

    if (agent === 'ag') {
      const estimateId = req.query.estimate_id;
      if (!estimateId) return res.status(400).json({ error: 'estimate_id is required for agent=ag' });
      const ctx = await aiInternals.buildEstimateContext(estimateId, false);
      systemBlocks = ctx.system;
      aiPhase = ctx.aiPhase;
      const toolList = aiInternals.estimateTools();
      // Plan-mode filter mirrors what the chat handler does so the
      // preview shows the actual tool subset the agent would have.
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
      // 86 unified: 'ag' agent_key was retired and migrated to 'job',
      // so the estimate-context preview pulls packs from 'job'.
      skillPackNames = await loadPackNamesFor('job');
    } else if (agent === 'elle' || agent === 'job') {
      const jobId = req.query.job_id;
      if (!jobId) return res.status(400).json({ error: 'job_id is required for agent=elle' });
      const ctx = await aiInternals.buildJobContext(jobId, '', null);
      systemBlocks = ctx.system;
      aiPhase = ctx.aiPhase;
      const toolList = aiInternals.jobTools();
      const filtered = (aiPhase === 'plan')
        ? toolList.filter(t => [
            'web_search', 'read_workspace_sheet_full', 'read_qb_cost_lines',
            'read_materials', 'read_purchase_history', 'read_subs',
            'read_building_breakdown', 'read_job_pct_audit', 'request_build_mode'
          ].indexOf(t.name) !== -1)
        : toolList;
      toolNames = filtered.map(t => t.name);
      const jRow = await pool.query('SELECT data FROM jobs WHERE id = $1', [jobId]);
      entityLabel = jRow.rows.length ? ((jRow.rows[0].data && jRow.rows[0].data.title) || jobId) : jobId;
      skillPackNames = await loadPackNamesFor('job');
    } else if (agent === 'hr' || agent === 'cra') {
      const ctx = await aiInternals.buildClientDirectoryContext();
      systemBlocks = ctx.system;
      toolNames = aiInternals.clientTools().map(t => t.name);
      entityLabel = 'Client directory (system-wide)';
      skillPackNames = await loadPackNamesFor('cra');
    } else if (agent === 'cos' || agent === 'staff') {
      const ctx = await aiInternals.buildStaffContext();
      systemBlocks = ctx.system;
      toolNames = aiInternals.staffTools().map(t => t.name);
      entityLabel = 'Chief of Staff (system-wide)';
      skillPackNames = await loadPackNamesFor('staff');
    } else {
      return res.status(400).json({ error: 'agent must be one of: ag, elle, hr, cos' });
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
      agent: agent,
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
    // operator), client threads against HR, staff threads against
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
  // Same identity, same tool union (estimating + job + intake + HR
  // client mutations), same continuous memory.
  //
  // The legacy 'ag' agent_key (former separate estimator persona) is
  // retired. The DB migration in server/db.js renames any 'ag' rows
  // to 'job' on boot. customToolsFor still has an 'ag' branch as
  // dead-code back-compat — if some old code path ever resolves an
  // 'ag' key, the baseline below also serves it (single source of
  // truth: 86's identity, never the old separate persona).
  job:   'You are 86, Project 86\'s ONE operator agent. Project 86 is a Central-Florida construction-services platform (painting, deck repair, roofing, exterior services for HOAs and apartment communities). One identity across every surface in the app — same brain whether you\'re on the global Ask 86 panel, a per-job WIP chat, a per-estimate editor, or the lead-intake flow.\n\n# Your scope\n  You have range across the whole company: revenue, cost, production, WIP, change orders, QB cost data, the node graph, margin trends, billing patterns, schedule slip, estimating, lead intake. You DRAFT estimates yourself — line items, sections, groups, pricing, scope edits — using your full tool union. You CAPTURE leads yourself. You read across HR\'s client directory and propose client mutations inline when the conversation calls for it. When the user asks to "go work on X," use the navigate tool to take them there, then keep working.\n\n# Your team\n  - HR — your client-relations + research assistant. HR validates addresses, gathers property photos and useful context, keeps the parent-company / property hierarchy clean. Ping HR when client info on a property is missing or stale; HR also has a dedicated panel the user can open directly.\n  - Chief of Staff — your handler. Observes the team, audits conversations, proposes skill-pack changes when patterns warrant. You don\'t talk to CoS; the user does.\n\n# Per-turn context\n  Every user turn carries data appropriate to the surface — a job WIP snapshot when the conversation is job-scoped, lead context when handling intake, an estimate snapshot when working in the editor, or a <page_context> block on the global Ask 86 surface telling you which page the user is on. Always reason about WHY a number is what it is. When estimating, anchor labor + sub costs to past-estimate history; price materials from real purchase data over training-data guesses.\n\n# Tone\n  Concise. Construction trade vocabulary welcome. Lead with the answer. Use the tools you have — don\'t announce hand-offs to other agents (you ARE the agent that does the work).',

  // HR — 86's client-relations + research assistant. Keeps the directory
  // clean so 86 doesn't have to spend cycles chasing bad addresses or
  // duplicate properties.
  cra:   'You are HR, 86\'s client-relations + job-health assistant. Project 86 — a Central-Florida construction-services platform. You keep the client directory clean and the per-property context fresh so 86 doesn\'t waste cycles on stale data.\n\nYour daily beats:\n- Validate addresses. Correct addresses make material takeoffs accurate and help find suppliers near the job site.\n- Search the web for property photos and useful context (community age, building count, recent storm damage, prior work history) — anything that helps 86 do its job.\n- Capture durable client notes that future turns can read.\n- Keep the parent-company / property hierarchy clean, hierarchical, dedupe-clean. Split parent-and-property compounds, link unparented properties, merge duplicates.\n- Watch internal user accounts — onboard new staff cleanly, surface stale accounts, fix capability/role drift.\n\nYou act as 86\'s assistant. When 86 flags a missing field on a client during intake, you fix it. When a property needs research before estimating, you have the answer ready. The user message will carry per-turn directory snapshot.',

  // CoS — the meta-agent. Observes 86 and tunes its playbooks via skill
  // packs. There is one operator agent (86) plus HR; CoS is the
  // handler.
  staff: 'You are Chief of Staff, Project 86\'s lead-agent handler. Range over the entire scope of the company, but specifically you\'re 86\'s handler — 86 is the operator across every surface (jobs, estimates, intake, Ask 86 global), and you keep 86 sharp.\n\nYour job is meta:\n- Observe usage patterns across 86 and HR.\n- Audit specific conversations when something looks off.\n- Propose skill-pack improvements when the playbook needs to evolve. Skill packs are reusable instruction blocks loaded into 86 or HR every turn, scoped per surface — when you spot a pattern (a recurring blind spot, a new pricing rule, a workflow that should be standardized), propose an edit to the relevant pack with the right contexts.\n- Surface drift between surfaces. If 86 starts under-pricing on the estimate surface relative to job-side margin compression, you catch it.\n\nThink of yourself as the meta-agent who makes the rest of the team better. You don\'t do the work; you tune the agent doing the work. The user message will carry per-turn live snapshot.',

  // The legacy 'ag' key — back-compat alias for 'job'. The DB migration
  // renamed any 'ag' rows to 'job' on boot, so this key should never
  // be resolved against managed_agent_registry. customToolsFor still
  // has a dead-code 'ag' branch; pointing it at 86's baseline ensures
  // nothing surfaces an old persona if it ever does fire.
  ag:    null // resolved at lookup time to AGENT_SYSTEM_BASELINE.job
};
// Resolve the back-compat alias after the literal initializer runs.
AGENT_SYSTEM_BASELINE.ag = AGENT_SYSTEM_BASELINE.job;

// Convert one of our local tool definitions (the ESTIMATE_TOOLS /
// JOB_TOOLS / CLIENT_TOOLS / STAFF_TOOLS shape) into Anthropic's
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
async function collectSkillsFor(agentKey) {
  const out = [];
  const seen = new Set();

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
  // Phase 3 — built-in toolset is split by role:
  //
  //   AG  / 86 / HR  → web_search, web_fetch
  //                      Pure web research. No filesystem tools —
  //                      read / glob / grep operate on the per-
  //                      session container's filesystem, which is
  //                      empty unless we mount files (we don't).
  //                      Exposing dead tools just confuses the
  //                      model into trying them and stalling.
  //                      No bash / write / edit either; task agents
  //                      mutate state through the propose_*
  //                      approval flow, not by scripting around it.
  //
  //   CoS              → full toolkit (every built-in on)
  //                      The meta-overseer can write scratch files
  //                      and then read them back, so the filesystem
  //                      tools earn their keep. bash + write + edit
  //                      let CoS investigate issues, draft skill-
  //                      pack edits, and run aggregate analyses.
  //
  // Tools run in a sandboxed per-session container — no path to our
  // DB / API / R2 / user data regardless of which subset is on.
  if (agentKey === 'staff') {
    return [{ type: 'agent_toolset_20260401', default_config: { enabled: true } }];
  }
  const opt = function(name) { return { name: name, enabled: true }; };
  return [{
    type: 'agent_toolset_20260401',
    default_config: { enabled: false },
    configs: ['web_search', 'web_fetch'].map(opt)
  }];
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
  if (agentKey === 'job' || agentKey === 'ag') {
    // ONE 86 — the managed `job` agent serves every 86 surface
    // (per-job WIP chat, per-estimate chat, lead intake, Ask 86).
    // The legacy 'ag' agent_key (former separate estimator) is now
    // a dead-code alias for 'job' — same identity, same tool union.
    //
    // Tools = UNION of every tool 86 uses anywhere:
    //   - estimateTools  (line items, sections, groups, scope edits)
    //   - jobTools       (phase pct, node graph, COs, POs, invoices)
    //   - clientTools    (HR client mutations used on the Ask 86 surface)
    // Deduped by name; first occurrence wins (estimate-first order).
    // INTAKE_TOOLS are already spread into jobTools().
    const seen = new Set();
    const merged = [];
    [
      ...aiInternals.estimateTools(),
      ...aiInternals.jobTools(),
      ...aiInternals.clientTools()
    ].forEach(t => {
      if (!t || !t.name || seen.has(t.name)) return;
      seen.add(t.name);
      merged.push(t);
    });
    tools = merged;
  } else if (agentKey === 'cra')    tools = aiInternals.clientTools();
  else if (agentKey === 'staff')  tools = aiInternals.staffTools();
  return tools
    .filter(t => t.name !== 'web_search')              // built-in toolset owns this
    .map(toCustomToolParam)
    .slice(0, 128);                                     // Anthropic caps tools at 128
}

// Idempotent register-or-update for one Project 86 agent. Creates the
// Anthropic-side Agent if no row exists in managed_agent_registry,
// otherwise leaves the existing record (no update path yet — Phase 2
// adds drift detection + agent.update calls).
async function ensureManagedAgent(agentKey) {
  const anthropic = getAnthropic();
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not set on this deployment.');
  const baseline = AGENT_SYSTEM_BASELINE[agentKey];
  if (!baseline) throw new Error('Unknown agent key: ' + agentKey);

  const existing = await pool.query(
    'SELECT * FROM managed_agent_registry WHERE agent_key = $1',
    [agentKey]
  );
  if (existing.rows.length) {
    return existing.rows[0]; // already registered — Phase 2 adds update path
  }

  const aiInternals = require('./ai-routes-internals');
  const model = aiInternals && aiInternals.defaultModel ? aiInternals.defaultModel() : 'claude-sonnet-4-6';
  const skills = await collectSkillsFor(agentKey);
  const customTools = customToolsFor(agentKey);
  const builtinTools = builtinToolsetFor(agentKey);

  const created = await anthropic.beta.agents.create({
    model: model,
    name: 'Project 86 ' + agentKey.toUpperCase(),
    description: baseline.slice(0, 200),
    system: baseline,
    skills: skills,
    tools: [...builtinTools, ...customTools]
  });

  await pool.query(
    `INSERT INTO managed_agent_registry
       (agent_key, anthropic_agent_id, model, tool_count, skill_count, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [agentKey, created.id, model, customTools.length + builtinTools.length, skills.length]
  );

  return {
    agent_key: agentKey,
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

// POST /api/admin/agents/managed/bootstrap?key=ag|job|cra|staff|all
//   Registers the requested Project 86 agent (or all four) as Anthropic-side
//   managed Agents. Idempotent — agents already in
//   managed_agent_registry are left alone.
router.post('/managed/bootstrap', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const key = String(req.query.key || 'all').toLowerCase();
    const agents = (key === 'all') ? ['ag', 'job', 'cra', 'staff'] : [key];
    const summary = [];
    for (const agentKey of agents) {
      try {
        const row = await ensureManagedAgent(agentKey);
        summary.push({ agent_key: agentKey, ok: true, anthropic_agent_id: row.anthropic_agent_id, tool_count: row.tool_count, skill_count: row.skill_count });
      } catch (e) {
        summary.push({ agent_key: agentKey, ok: false, error: e.message });
      }
    }
    res.json({ summary });
  } catch (e) {
    console.error('POST /api/admin/agents/managed/bootstrap error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

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

// GET /api/admin/agents/reference-links — list all
router.get('/reference-links', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, title, url, description, enabled, max_rows, last_fetched_at, ' +
      '       last_fetch_status, last_fetch_error, last_fetched_row_count, created_at, updated_at ' +
      'FROM agent_reference_links ORDER BY created_at ASC'
    );
    res.json({ links: r.rows });
  } catch (e) {
    console.error('GET /reference-links error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/agents/reference-links — create (and trigger first fetch)
router.post('/reference-links', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const { title, url, description, enabled, maxRows } = req.body || {};
    if (!title || !url) return res.status(400).json({ error: 'title and url are required' });
    const id = 'rl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const r = await pool.query(
      'INSERT INTO agent_reference_links (id, title, url, description, enabled, max_rows) ' +
      'VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [id, title, url, description || null, enabled !== false, parseInt(maxRows, 10) || 200]
    );
    // Fire and forget the initial fetch — UI shows last_fetch_status
    // and the user can hit /refresh manually if they want to wait for
    // a fresh result.
    refreshLinkRow(r.rows[0]).catch(function (err) {
      console.warn('[reference-links] initial fetch failed for ' + id + ':', err.message);
    });
    res.json({ link: r.rows[0] });
  } catch (e) {
    console.error('POST /reference-links error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/admin/agents/reference-links/:id — update fields
router.patch('/reference-links/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const id = req.params.id;
    const { title, url, description, enabled, maxRows } = req.body || {};
    const fields = [];
    const values = [];
    let n = 1;
    if (title       !== undefined) { fields.push('title = $' + (n++));        values.push(title); }
    if (url         !== undefined) { fields.push('url = $' + (n++));          values.push(url); }
    if (description !== undefined) { fields.push('description = $' + (n++));  values.push(description); }
    if (enabled     !== undefined) { fields.push('enabled = $' + (n++));      values.push(!!enabled); }
    if (maxRows     !== undefined) { fields.push('max_rows = $' + (n++));     values.push(parseInt(maxRows, 10) || 200); }
    if (!fields.length) return res.status(400).json({ error: 'no fields to update' });
    fields.push('updated_at = NOW()');
    values.push(id);
    const r = await pool.query(
      'UPDATE agent_reference_links SET ' + fields.join(', ') +
      ' WHERE id = $' + n + ' RETURNING *',
      values
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    // If the URL changed, re-fetch.
    if (url !== undefined) {
      refreshLinkRow(r.rows[0]).catch(function (err) {
        console.warn('[reference-links] re-fetch after URL change failed for ' + id + ':', err.message);
      });
    }
    res.json({ link: r.rows[0] });
  } catch (e) {
    console.error('PATCH /reference-links error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/agents/reference-links/:id
router.delete('/reference-links/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM agent_reference_links WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /reference-links error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/agents/reference-links/:id/refresh — force re-fetch
// and wait for the result so the user sees the new status inline.
router.post('/reference-links/:id/refresh', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM agent_reference_links WHERE id = $1', [req.params.id]);
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
router.get('/reference-links/:id/preview', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, title, last_fetched_text, last_fetch_status, last_fetched_row_count, last_fetched_at ' +
      'FROM agent_reference_links WHERE id = $1',
      [req.params.id]
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
async function buildReferenceLinksBlock() {
  try {
    const r = await pool.query(
      "SELECT title, last_fetched_text, last_fetched_at, last_fetch_status " +
      "FROM agent_reference_links " +
      "WHERE enabled = TRUE AND last_fetch_status = 'ok' AND last_fetched_text IS NOT NULL " +
      "ORDER BY created_at ASC"
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
async function backgroundRefreshAll() {
  try {
    const r = await pool.query(
      'SELECT * FROM agent_reference_links WHERE enabled = TRUE'
    );
    for (const row of r.rows) {
      // Skip rows we already refreshed within the window.
      if (row.last_fetched_at) {
        const age = Date.now() - new Date(row.last_fetched_at).getTime();
        if (age < REFRESH_INTERVAL_MS) continue;
      }
      try { await refreshLinkRow(row); }
      catch (e) { console.warn('[reference-links] bg refresh failed for ' + row.id + ':', e.message); }
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
    const baseline = AGENT_SYSTEM_BASELINE[agentKey] || '';
    const aiInternals = require('./ai-routes-internals');
    const localModel = aiInternals && aiInternals.defaultModel ? aiInternals.defaultModel() : 'claude-sonnet-4-6';
    const localSkills = await collectSkillsFor(agentKey);
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
router.post('/managed/:agentKey/sync', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '').toLowerCase();
    if (!['ag', 'job', 'cra', 'staff'].includes(agentKey)) {
      return res.status(400).json({ error: 'agentKey must be ag | job | cra | staff' });
    }
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

    const reg = await pool.query(
      `SELECT anthropic_agent_id FROM managed_agent_registry WHERE agent_key = $1`,
      [agentKey]
    );
    if (!reg.rows.length) return res.status(404).json({ error: 'Agent is not yet registered. Click Bootstrap first.' });
    const agentId = reg.rows[0].anthropic_agent_id;

    const baseline = AGENT_SYSTEM_BASELINE[agentKey] || '';
    const aiInternals = require('./ai-routes-internals');
    const model = aiInternals && aiInternals.defaultModel ? aiInternals.defaultModel() : 'claude-sonnet-4-6';
    const skills = await collectSkillsFor(agentKey);
    const customTools = customToolsFor(agentKey);
    const builtinTools = builtinToolsetFor(agentKey);
    const toolList = [...builtinTools, ...customTools];
    const toolCount = customTools.length + builtinTools.length;
    const name = 'Project 86 ' + agentKey.toUpperCase();
    const description = baseline.slice(0, 200);

    // Always retrieve so we can detect archived state (no unarchive
    // endpoint on Anthropic — archived means we have to mint a
    // fresh agent). force_version still bypasses the CAS lookup
    // when supplied; in that case we trust the caller saw the
    // archived flag separately.
    const remote = await anthropic.beta.agents.retrieve(agentId);
    if (remote.archived_at) {
      // Archived → create fresh, replace registry row.
      const created = await anthropic.beta.agents.create({
        model: model,
        name: name,
        description: description,
        system: baseline,
        skills: skills,
        tools: toolList
      });
      await pool.query(
        `UPDATE managed_agent_registry
            SET anthropic_agent_id = $2,
                model = $3,
                tool_count = $4,
                skill_count = $5,
                updated_at = NOW()
          WHERE agent_key = $1`,
        [agentKey, created.id, model, toolCount, skills.length]
      );
      return res.json({
        ok: true,
        agent_key: agentKey,
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

    const updated = await anthropic.beta.agents.update(agentId, {
      version: currentVersion,
      name: name,
      description: description,
      model: model,
      system: baseline,
      skills: skills,
      tools: toolList
    });

    await pool.query(
      `UPDATE managed_agent_registry
          SET model = $2,
              tool_count = $3,
              skill_count = $4,
              updated_at = NOW()
        WHERE agent_key = $1`,
      [agentKey, model, toolCount, skills.length]
    );

    res.json({
      ok: true,
      agent_key: agentKey,
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
router.post('/managed/sync-all', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

    const reg = await pool.query(
      `SELECT agent_key, anthropic_agent_id FROM managed_agent_registry ORDER BY agent_key`
    );
    if (!reg.rows.length) {
      return res.json({ summary: [], note: 'No agents registered yet. Bootstrap them first.' });
    }

    const aiInternals = require('./ai-routes-internals');
    const model = aiInternals && aiInternals.defaultModel ? aiInternals.defaultModel() : 'claude-sonnet-4-6';
    const summary = [];

    for (const row of reg.rows) {
      const agentKey = row.agent_key;
      const agentId = row.anthropic_agent_id;
      try {
        const baseline = AGENT_SYSTEM_BASELINE[agentKey];
        if (!baseline) {
          // Stale registry row — agent_key isn't in our current set
          // (e.g. 'intake' which was merged into 86). Skip with a
          // status so the admin can see it and decide whether to
          // delete the row.
          summary.push({
            agent_key: agentKey,
            ok: false,
            status: 'stale_row',
            error: 'No baseline system prompt — agent_key is not in the current set (was retired). Delete this row from managed_agent_registry to clean up.'
          });
          continue;
        }

        const skills = await collectSkillsFor(agentKey);
        const customTools = customToolsFor(agentKey);
        const builtinTools = builtinToolsetFor(agentKey);
        const toolList = [...builtinTools, ...customTools];
        const toolCount = customTools.length + builtinTools.length;
        const name = 'Project 86 ' + agentKey.toUpperCase();
        const description = baseline.slice(0, 200);

        // Fetch current state. If the agent is archived (archived_at
        // is non-null), update() will 400 with "Cannot modify
        // archived agent" — Anthropic has no unarchive endpoint, so
        // fall back to create() to mint a fresh agent (new id, v1)
        // and replace the registry row.
        const remote = await anthropic.beta.agents.retrieve(agentId);
        if (remote.archived_at) {
          const created = await anthropic.beta.agents.create({
            model: model,
            name: name,
            description: description,
            system: baseline,
            skills: skills,
            tools: toolList
          });
          await pool.query(
            `UPDATE managed_agent_registry
                SET anthropic_agent_id = $2,
                    model = $3,
                    tool_count = $4,
                    skill_count = $5,
                    updated_at = NOW()
              WHERE agent_key = $1`,
            [agentKey, created.id, model, toolCount, skills.length]
          );
          summary.push({
            agent_key: agentKey,
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
          system: baseline,
          skills: skills,
          tools: toolList
        });

        await pool.query(
          `UPDATE managed_agent_registry
              SET model = $2,
                  tool_count = $3,
                  skill_count = $4,
                  updated_at = NOW()
            WHERE agent_key = $1`,
          [agentKey, model, toolCount, skills.length]
        );

        summary.push({
          agent_key: agentKey,
          ok: true,
          status: 'updated',
          anthropic_agent_id: agentId,
          previous_version: currentVersion,
          new_version: updated.version,
          tool_count: toolCount,
          skill_count: skills.length
        });
      } catch (e) {
        summary.push({ agent_key: agentKey, ok: false, status: 'error', error: e.message || 'unknown' });
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
router.get('/:agentKey/native-skills', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '').trim();
    if (!agentKey) return res.status(400).json({ error: 'agentKey is required' });

    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

    // Load Anthropic-side metadata for ALL skills (we'll filter into
    // assigned vs available below). Cap at 200 — accounts with more
    // than that are unlikely in practice.
    let allSkills = [];
    try {
      const page = await anthropic.beta.skills.list({ limit: 200 });
      allSkills = (page && (page.data || page)) || [];
      if (!Array.isArray(allSkills)) allSkills = [];
    } catch (e) {
      console.warn('[native-skills GET] beta.skills.list failed:', e.message);
    }
    const metaById = new Map();
    allSkills.forEach(s => { if (s && s.id) metaById.set(s.id, s); });

    const r = await pool.query(
      `SELECT skill_id, position, enabled, created_at FROM managed_agent_skills
        WHERE agent_key = $1
        ORDER BY position ASC, created_at ASC`,
      [agentKey]
    );

    const assignedIds = new Set();
    const assigned = r.rows.map(row => {
      assignedIds.add(row.skill_id);
      const meta = metaById.get(row.skill_id) || {};
      return {
        skill_id: row.skill_id,
        position: row.position,
        enabled: row.enabled,
        attached_at: row.created_at,
        display_title: meta.display_title || meta.name || null,
        description: meta.description || null,
        anthropic_created_at: meta.created_at || null,
        anthropic_missing: !metaById.has(row.skill_id)
      };
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
