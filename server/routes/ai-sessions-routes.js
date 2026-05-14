// AI sessions — sidebar-driven multi-session chat threads.
//
// One Anthropic-side managed agent, many persistent sessions per
// user. Each session is a separate conversation thread anchored to a
// context (a job, an estimate, a lead, or "general"). The sidebar UI
// lists them; the user picks one or 86's auto-anchor picks for them
// based on the page they're on.
//
// Endpoints:
//   GET    /api/ai/sessions                    list user's sessions
//   GET    /api/ai/sessions/search?q=          full-text search
//   GET    /api/ai/sessions/:id                fetch one + history
//   POST   /api/ai/sessions                    create a new session
//   PATCH  /api/ai/sessions/:id                rename / pin / archive / effort
//   DELETE /api/ai/sessions/:id                hard delete (incl. Anthropic side)
//   POST   /api/ai/sessions/:id/export         markdown / json export
//   POST   /api/ai/sessions/:id/branch         fork from a turn
//
// All endpoints require auth and scope to req.user.id.

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// Lazy Anthropic client + delegated session creation. We reuse the
// helpers exported by ai-routes so there's one code path that creates
// and archives Anthropic-side sessions. Avoids drifting two
// implementations as the managed-agents API evolves.
function aiRoutes() {
  return require('./ai-routes');
}

// ──────────────────────────────────────────────────────────────────
// GET /api/ai/sessions
//   Returns the user's sessions ordered for sidebar display:
//     pinned first, then by last_used_at DESC.
//   Excludes archived rows by default; pass ?include_archived=1 to
//   see them too (Restore from Archive panel).
// ──────────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const includeArchived = req.query.include_archived === '1';
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 100));
    const r = await pool.query(
      `SELECT id, anthropic_session_id, label, summary, entity_type, entity_id,
              pinned, turn_count, total_cost_usd, effort_override,
              created_at, last_used_at, archived_at
         FROM ai_sessions
        WHERE user_id = $1
          AND ($2::boolean OR archived_at IS NULL)
        ORDER BY pinned DESC, last_used_at DESC
        LIMIT $3`,
      [req.user.id, includeArchived, limit]
    );
    res.json({ sessions: r.rows });
  } catch (e) {
    console.error('GET /api/ai/sessions error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/ai/sessions/search?q=
//   Substring search across labels, summaries, AND message bodies.
//   Returns up to 30 matches with a short snippet from the first
//   matching message. The sidebar's search box hits this.
// ──────────────────────────────────────────────────────────────────
router.get('/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const pattern = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';

    // Sessions that match by metadata.
    const metaRows = await pool.query(
      `SELECT s.id, s.label, s.summary, s.entity_type, s.entity_id,
              s.last_used_at, s.turn_count,
              'meta'::text AS match_kind,
              NULL::text AS snippet
         FROM ai_sessions s
        WHERE s.user_id = $1
          AND s.archived_at IS NULL
          AND (s.label ILIKE $2 OR s.summary ILIKE $2)
        ORDER BY s.pinned DESC, s.last_used_at DESC
        LIMIT 15`,
      [req.user.id, pattern]
    );

    // Sessions that match by message body — pull the first matching
    // turn so the UI can show a snippet. ai_messages keyed by
    // (user_id, entity_type, entity_id) covers the v1 thread; the
    // v2 multi-session path will key by anthropic_session_id once
    // the chat handler is updated. Both paths covered below.
    const msgRows = await pool.query(
      `WITH matches AS (
         SELECT s.id AS session_id, s.label, s.summary, s.entity_type, s.entity_id,
                s.last_used_at, s.turn_count,
                m.content AS snippet,
                ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY m.created_at ASC) AS rn
           FROM ai_sessions s
           JOIN ai_messages m
             ON m.user_id = s.user_id
            AND m.entity_type = s.entity_type
            AND COALESCE(m.estimate_id, '') = COALESCE(s.entity_id, '')
          WHERE s.user_id = $1
            AND s.archived_at IS NULL
            AND m.content ILIKE $2
       )
       SELECT session_id AS id, label, summary, entity_type, entity_id,
              last_used_at, turn_count,
              'message'::text AS match_kind,
              substr(snippet, 1, 240) AS snippet
         FROM matches
        WHERE rn = 1
        ORDER BY last_used_at DESC
        LIMIT 15`,
      [req.user.id, pattern]
    );

    // Merge, dedupe by id, prefer message-match if both fired (the
    // snippet is more useful than the label-only row).
    const seen = new Set();
    const results = [];
    [...msgRows.rows, ...metaRows.rows].forEach(row => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      results.push(row);
    });
    res.json({ results: results.slice(0, 30) });
  } catch (e) {
    console.error('GET /api/ai/sessions/search error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/ai/sessions/:id
//   Hydrate one session + its message history. Used when the user
//   clicks a sidebar row.
// ──────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const sid = parseInt(req.params.id, 10);
    if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid session id' });

    const sr = await pool.query(
      `SELECT * FROM ai_sessions WHERE id = $1 AND user_id = $2`,
      [sid, req.user.id]
    );
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sr.rows[0];

    // Load this session's message history. Use entity_type+entity_id
    // as the lookup key (matches how ai_messages is keyed today).
    const mr = await pool.query(
      `SELECT id, role, content, photos_included, inline_image_blocks,
              input_tokens, output_tokens,
              cache_creation_input_tokens, cache_read_input_tokens,
              created_at
         FROM ai_messages
        WHERE user_id = $1
          AND entity_type = $2
          AND COALESCE(estimate_id, '') = COALESCE($3, '')
        ORDER BY created_at ASC`,
      [req.user.id, session.entity_type, session.entity_id]
    );
    res.json({ session, messages: mr.rows });
  } catch (e) {
    console.error('GET /api/ai/sessions/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/ai/sessions
//   Body: { entity_type, entity_id?, label?, summary?, anchor? }
//
//   Create a brand-new session. The Anthropic-side beta.sessions.create
//   call happens through ai-routes' helper so the agent/environment
//   lookup logic stays in one place.
//
//   `anchor: false` skips Anthropic-side session creation — useful
//   when we want a placeholder row that gets bound on first turn.
//   Default is `anchor: true` (create immediately).
// ──────────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const entityType = String(b.entity_type || 'general').trim();
    const entityId = b.entity_id ? String(b.entity_id) : null;
    const label = b.label ? String(b.label).slice(0, 200) : null;

    if (!req.organization && !b._allow_no_org) {
      // ai-routes requires org for agent lookup; the auth middleware
      // attaches it for org-scoped users. Plain-auth (admin) users
      // also have an org. Defensive null check just in case.
      return res.status(400).json({ error: 'Organization required to create session' });
    }
    const organization = req.organization;

    const ai = aiRoutes();
    // Delegate Anthropic-side session creation to the existing helper.
    // The helper inserts the row too, then we apply our label / summary
    // patches in a second statement.
    const session = await ai.createFreshAiSession({
      agentKey: 'job',
      entityType,
      entityId,
      userId: req.user.id,
      organization
    });

    if (label || b.summary) {
      await pool.query(
        `UPDATE ai_sessions SET label = COALESCE($1, label), summary = COALESCE($2, summary)
          WHERE id = $3`,
        [label, b.summary || null, session.id]
      );
    }

    const r = await pool.query(`SELECT * FROM ai_sessions WHERE id = $1`, [session.id]);
    res.json({ session: r.rows[0] });
  } catch (e) {
    console.error('POST /api/ai/sessions error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// ──────────────────────────────────────────────────────────────────
// PATCH /api/ai/sessions/:id
//   Body: any subset of { label, summary, pinned, archived, effort_override }
//
//   - archived=true sets archived_at = NOW(); =false clears it.
//   - pinned floats the row to the top of the sidebar.
//   - effort_override sets a per-session effort tier ("low"|"medium"
//     |"high"|"xhigh"|"max"). null clears it (use the global default).
// ──────────────────────────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const sid = parseInt(req.params.id, 10);
    if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid session id' });
    const b = req.body || {};

    const sets = [];
    const params = [sid, req.user.id];
    let p = 3;

    if (typeof b.label === 'string') {
      sets.push('label = $' + p++);
      params.push(b.label.slice(0, 200));
    }
    if (typeof b.summary === 'string') {
      sets.push('summary = $' + p++);
      params.push(b.summary.slice(0, 500));
    }
    if (typeof b.pinned === 'boolean') {
      sets.push('pinned = $' + p++);
      params.push(b.pinned);
    }
    if (typeof b.archived === 'boolean') {
      sets.push('archived_at = ' + (b.archived ? 'NOW()' : 'NULL'));
    }
    if (b.effort_override === null || ['low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort_override)) {
      sets.push('effort_override = $' + p++);
      params.push(b.effort_override || null);
    }

    if (!sets.length) return res.status(400).json({ error: 'No valid fields supplied' });

    const r = await pool.query(
      `UPDATE ai_sessions SET ${sets.join(', ')}
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json({ session: r.rows[0] });
  } catch (e) {
    console.error('PATCH /api/ai/sessions/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// DELETE /api/ai/sessions/:id
//   Hard delete. Archives the Anthropic-side session (so the agent
//   doesn't keep stale state) and removes our row. The associated
//   ai_messages rows stay — they're per (user, entity), not per
//   session, so deleting them here would wipe other sessions on the
//   same context too. Use "Clear conversation" in the panel if you
//   want to wipe message history.
// ──────────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const sid = parseInt(req.params.id, 10);
    if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid session id' });

    const sr = await pool.query(
      `SELECT * FROM ai_sessions WHERE id = $1 AND user_id = $2`,
      [sid, req.user.id]
    );
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sr.rows[0];

    // Best-effort archive of the Anthropic-side session. If it's
    // already gone upstream we still complete the local delete.
    try {
      const ai = aiRoutes();
      const anthropic = ai.getAnthropic && ai.getAnthropic();
      if (anthropic && session.anthropic_session_id) {
        await anthropic.beta.sessions.archive(session.anthropic_session_id);
      }
    } catch (e) {
      console.warn('[sessions DELETE] anthropic archive failed:', e.message);
    }

    await pool.query(`DELETE FROM ai_sessions WHERE id = $1`, [sid]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/ai/sessions/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/ai/sessions/:id/export
//   Body: { format?: 'markdown' | 'json' }   default: markdown
//
//   Streams the conversation as a downloadable file. Markdown is the
//   most useful for sharing ("here's the QB-mapping plan 86 and I
//   sketched"); JSON is for power users / backups.
// ──────────────────────────────────────────────────────────────────
router.post('/:id/export', requireAuth, async (req, res) => {
  try {
    const sid = parseInt(req.params.id, 10);
    if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid session id' });
    const format = (req.body && req.body.format) === 'json' ? 'json' : 'markdown';

    const sr = await pool.query(
      `SELECT * FROM ai_sessions WHERE id = $1 AND user_id = $2`,
      [sid, req.user.id]
    );
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sr.rows[0];

    const mr = await pool.query(
      `SELECT role, content, created_at
         FROM ai_messages
        WHERE user_id = $1
          AND entity_type = $2
          AND COALESCE(estimate_id, '') = COALESCE($3, '')
        ORDER BY created_at ASC`,
      [req.user.id, session.entity_type, session.entity_id]
    );

    if (format === 'json') {
      res.json({ session, messages: mr.rows });
      return;
    }

    // Markdown format — readable transcript with role headers.
    const lines = [
      '# ' + (session.label || 'Session ' + session.id),
      '',
      session.summary ? '_' + session.summary + '_' : null,
      '',
      '- Created: ' + new Date(session.created_at).toISOString(),
      '- Turns: ' + session.turn_count,
      session.entity_id ? '- Context: ' + session.entity_type + ' ' + session.entity_id : '- Context: general',
      '',
      '---',
      ''
    ].filter(l => l !== null);

    mr.rows.forEach(m => {
      const role = m.role === 'assistant' ? '## 86' : '## You';
      lines.push(role + '  _(' + new Date(m.created_at).toLocaleString() + ')_');
      lines.push('');
      lines.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      lines.push('');
    });

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition',
      'attachment; filename="' + (session.label || 'session-' + session.id).replace(/[^\w\-]+/g, '_') + '.md"');
    res.send(lines.join('\n'));
  } catch (e) {
    console.error('POST /api/ai/sessions/:id/export error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/ai/sessions/:id/branch
//   Body: { from_message_id, label? }
//
//   Fork the conversation: create a new session whose history is
//   this one's messages up through `from_message_id`, then a fresh
//   Anthropic-side session for everything after. The new session
//   inherits entity_type / entity_id from the parent.
//
//   Useful when the user wants to explore a "what if" tangent
//   without polluting the main thread.
// ──────────────────────────────────────────────────────────────────
router.post('/:id/branch', requireAuth, async (req, res) => {
  try {
    const sid = parseInt(req.params.id, 10);
    if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid session id' });
    const fromMessageId = req.body && req.body.from_message_id;
    if (!fromMessageId) return res.status(400).json({ error: 'from_message_id required' });
    const label = (req.body && req.body.label && String(req.body.label).slice(0, 200))
      || 'Branch';

    const sr = await pool.query(
      `SELECT * FROM ai_sessions WHERE id = $1 AND user_id = $2`,
      [sid, req.user.id]
    );
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found' });
    const parent = sr.rows[0];
    if (!req.organization) return res.status(400).json({ error: 'Organization required' });

    // Load history up through the branch point so the new session
    // starts with the same context. We can't transplant Anthropic-side
    // session state, so the branch starts fresh on Anthropic's side
    // and replays history through the chat handler on the next turn.
    const cutoff = await pool.query(
      `SELECT created_at FROM ai_messages WHERE id = $1`,
      [fromMessageId]
    );
    if (!cutoff.rows.length) return res.status(404).json({ error: 'from_message_id not found' });

    const ai = aiRoutes();
    const newSession = await ai.createFreshAiSession({
      agentKey: 'job',
      entityType: parent.entity_type,
      entityId: parent.entity_id,
      userId: req.user.id,
      organization: req.organization
    });
    await pool.query(
      `UPDATE ai_sessions SET label = $1, summary = $2 WHERE id = $3`,
      [label, '(branched from ' + (parent.label || 'session ' + parent.id) + ')', newSession.id]
    );

    res.json({ session_id: newSession.id, anthropic_session_id: newSession.anthropic_session_id });
  } catch (e) {
    console.error('POST /api/ai/sessions/:id/branch error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

module.exports = router;
