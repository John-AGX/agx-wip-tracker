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
const { requireAuth, requireOrg, resolveUserOrg } = require('../auth');
// Session TITLES are computed here, never read from ai_sessions.label — see
// server/services/session-title.js for why label and display_label are two
// different things. One batched resolve per response, org-scoped.
const { attachSessionTitles, attachSessionTitle } = require('../services/session-title');
// Search resolves the same way the title does — see session-search.js.
const { searchSessions } = require('../services/session-search');

const router = express.Router();

// The org to resolve entity names against. ai_sessions has no
// organization_id column of its own (rows are per-USER), so the tenant comes
// from the caller: the JWT claim when present, a DB read for legacy tokens
// issued before organizations existed. Null means "don't scope" — the
// resolver keeps its previous behaviour rather than resolving nothing.
async function titleOrgId(req) {
  if (req && req.user && req.user.organization_id != null) return req.user.organization_id;
  try {
    const org = await resolveUserOrg(req);
    return org ? org.id : null;
  } catch (_) {
    return null;
  }
}

// Lazy Anthropic client + delegated session creation. We reuse the
// helpers exported by ai-routes so there's one code path that creates
// and archives Anthropic-side sessions. Avoids drifting two
// implementations as the managed-agents API evolves.
function aiRoutes() {
  return require('./ai-routes');
}

const dealMemory = require('../services/deal-memory');

// ── DEAL FIGURES ARE GATED ON EGRESS, BY THE <deal_memory> BLOCK'S OWN RULE ──
// deal_memory.numbers is a deal's contract / CO income / % complete (job
// stage), proposal total / base cost / blended markup (estimate stage) or
// estimated revenue / confidence (lead stage). 86's per-turn <deal_memory>
// block withholds those from a caller whose role may not read them
// (ai-routes.js turnContextMoneyDenial). These REST responses used to hand the
// same figures to the same caller in the sidebar JSON. This asks THAT function
// — the rule is not restated here.
//
// A denied caller still gets the row: the stage and the stage's id stay
// (the lineage chips and the server title need them, and neither is money),
// every other key is dropped, and deal_numbers_withheld:true tells the UI to
// say so rather than paint "$0". Keys are KEPT by allowlist, so a figure
// added to computeNumbers later is withheld by default. A numbers object
// carrying no figure at all is left exactly as it is, and an allowed caller's
// row is never touched — byte-identical to before.
const DEAL_STAGE_ID_KEY = { job: 'jobId', estimate: 'estimateId', lead: 'leadId' };
const DEAL_NON_FIGURE_KEYS = ['stage', 'leadId', 'estimateId', 'jobId'];
function withholdDealFigures(row, user) {
  if (!row || row.deal_numbers == null) return row;
  const isObj = typeof row.deal_numbers === 'object';
  const n = isObj ? row.deal_numbers : {};
  const carriesFigure = !isObj || Object.keys(n).some((k) => DEAL_NON_FIGURE_KEYS.indexOf(k) < 0);
  if (!carriesFigure) return row;
  const stage = n.stage || row.deal_stage || null;
  const idKey = DEAL_STAGE_ID_KEY[stage];
  // An unrecognised stage cannot be mapped to a rule, so it is withheld.
  const denial = idKey
    ? aiRoutes().internals.turnContextMoneyDenial(stage, n[idKey], user || null)
    : 'unrecognised deal stage';
  if (!denial) return row;
  const kept = {};
  DEAL_NON_FIGURE_KEYS.forEach((k) => { if (n[k] != null) kept[k] = n[k]; });
  row.deal_numbers = kept;
  row.deal_numbers_withheld = true;
  return row;
}

// The deal_memory join's tenant arm. deal_memory.lineage_root is a bare id and
// the join had no organization predicate, so a thread keyed on another
// tenant's lineage joined THAT tenant's row. Same legacy tolerance as
// deal-memory.js IN_ORG, and an unresolved org joins nothing.
function dealJoinOrgArm(p) {
  return '(' + p + '::integer IS NOT NULL AND (dm.organization_id = ' + p + ' OR dm.organization_id IS NULL))';
}

// A deal thread keyed on ANOTHER tenant's lineage (deal-memory.js
// lineageRootPlacement — the same definition the boot archive uses) is refused
// on every path that loads it by id, archived or not.
async function foreignLineageRefusal(res, session, orgId) {
  if (!session || session.session_kind !== 'deal_thread') return false;
  const { placement } = await dealMemory.lineageRootPlacement(pool, session.lineage_root, orgId);
  if (placement !== 'foreign') return false;
  res.status(409).json({
    error: 'This deal thread belongs to a record outside your organization, so it cannot be opened. It has been archived.',
    code: 'DEAL_THREAD_FOREIGN_LINEAGE'
  });
  return true;
}

// The LIST doors (sidebar list, search) cannot refuse a row without breaking
// the sidebar, so a foreign-lineage deal thread is returned as a husk: its
// last-message snippet, search snippet, AI summary and any joined deal figures
// are dropped — each can quote the other tenant's conversation — and
// foreign_lineage:true says why. One batched placement check per response;
// in-org rows are not touched.
async function redactForeignLineageRows(rows, orgId) {
  const deal = (rows || []).filter((r) => r && r.session_kind === 'deal_thread' && r.lineage_root);
  if (!deal.length || orgId == null) return;
  const placed = await dealMemory.lineageRootPlacements(pool, deal.map((r) => r.lineage_root), orgId);
  deal.forEach((r) => {
    const p = placed.get(String(r.lineage_root));
    if (!p || p.placement !== 'foreign') return;
    if ('last_snippet' in r) r.last_snippet = null;
    if ('snippet' in r) r.snippet = null;
    r.summary = null;
    r.deal_numbers = null;
    delete r.deal_numbers_withheld;
    r.foreign_lineage = true;
  });
}

// Paths that return message bodies refuse an unresolved org out loud, the same
// answer GET /api/ai/86/messages gives, rather than an unscoped read or a
// silent empty transcript.
function orgUnresolved(res) {
  res.status(409).json({
    error: 'This account is not attached to an organization, so your chat history cannot be scoped to a tenant. Nothing was lost — ask an administrator to open your user in Admin → Users and save it, which attaches you to their organization.',
    code: 'ORG_UNRESOLVED'
  });
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
    // Added session_kind + last_compacted_at so the sidebar can show
    // "user-thread (rolling)" badges and "last compacted Xh ago"
    // diagnostics. Compaction (compact-2026-01-12 beta) fires
    // automatically server-side when context approaches the 150K
    // token trigger; surfacing last_compacted_at lets us monitor
    // whether long-lived rolling sessions are actually compacting.
    // Deal-thread dashboard (slice 3b-2): also expose lineage_root, the deal
    // money digest (LEFT JOIN deal_memory), and a last-message snippet (LATERAL,
    // indexed by idx_ai_messages_session). All NULL for non-deal rows — additive,
    // nothing else that reads this list breaks.
    const orgId = await titleOrgId(req);
    const r = await pool.query(
      `SELECT s.id, s.anthropic_session_id, s.label, s.summary, s.entity_type, s.entity_id,
              s.pinned, s.turn_count, s.total_cost_usd, s.effort_override,
              s.created_at, s.last_used_at, s.archived_at,
              s.session_kind, s.last_compacted_at, s.lineage_root,
              dm.numbers       AS deal_numbers,
              dm.numbers_stage AS deal_stage,
              -- root_type says WHAT KIND of id lineage_root is. Without it a
              -- deal thread whose deal_memory row carries no stage id has to
              -- guess the type from the id prefix; with it the title resolver
              -- looks the root up in the right table.
              dm.root_type     AS deal_root_type,
              substr(lm.content, 1, 120) AS last_snippet
         FROM ai_sessions s
         LEFT JOIN deal_memory dm ON dm.lineage_root = s.lineage_root
                                 AND ${dealJoinOrgArm('$4')}
         LEFT JOIN LATERAL (
            SELECT content FROM ai_messages m
             WHERE m.session_id = s.id
             ORDER BY m.created_at DESC LIMIT 1
         ) lm ON true
        WHERE s.user_id = $1
          AND ($2::boolean OR s.archived_at IS NULL)
        ORDER BY s.pinned DESC, s.last_used_at DESC
        LIMIT $3`,
      [req.user.id, includeArchived, limit, orgId]
    );
    // display_label — what the sidebar paints. NOT stored: computed from the
    // row's entity reference every fetch, so a renamed lead retitles its
    // thread and the rows already carrying a raw id heal without a backfill.
    // Costs one query per entity TYPE for the whole page, not one per row.
    await attachSessionTitles(orgId, r.rows);
    r.rows.forEach((row) => withholdDealFigures(row, req.user));
    await redactForeignLineageRows(r.rows, orgId);
    res.json({ sessions: r.rows });
  } catch (e) {
    console.error('GET /api/ai/sessions error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/ai/sessions/:id/compact
//   Manually trigger Anthropic-side compaction on a session.
//
//   Compaction usually fires automatically once a session approaches
//   the trigger threshold (~150K input tokens). This endpoint lets an
//   admin force it early — useful for testing the round-trip and for
//   shrinking a long-lived session before it gets unwieldy.
//
//   Calls anthropic.beta.sessions.compact(session_id) when available;
//   if the SDK shape changes the endpoint surfaces the error so we
//   can fix it without crashing the chat path.
// ──────────────────────────────────────────────────────────────────
router.post('/:id/compact', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, anthropic_session_id, label, session_kind, last_compacted_at
         FROM ai_sessions
        WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = r.rows[0];
    if (!session.anthropic_session_id) {
      return res.status(400).json({ error: 'Session has no Anthropic-side id (legacy partitioned row)' });
    }
    const ai = aiRoutes().getAnthropic && aiRoutes().getAnthropic();
    if (!ai) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
    // Try the SDK's compact method — shape varies between minor
    // versions. Falls back to a direct POST if the helper is missing.
    let compactResp = null;
    if (ai.beta && ai.beta.sessions && typeof ai.beta.sessions.compact === 'function') {
      compactResp = await ai.beta.sessions.compact(session.anthropic_session_id);
    } else {
      return res.status(501).json({
        error: 'beta.sessions.compact not exposed on this SDK version. Update @anthropic-ai/sdk or wait for the next auto-fire.',
      });
    }
    await pool.query(
      `UPDATE ai_sessions SET last_compacted_at = NOW() WHERE id = $1`,
      [session.id]
    );
    res.json({ ok: true, session_id: session.id, anthropic_session_id: session.anthropic_session_id, response: compactResp });
  } catch (e) {
    console.error('POST /api/ai/sessions/:id/compact error:', e && e.stack || e);
    res.status(500).json({ error: 'Compaction failed: ' + (e.message || 'unknown') });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/ai/sessions/search?q=
//   Substring search across the thread's NAME (an authored label, or
//   the entity it is named after), its summary, and message bodies.
//   Returns up to 30 matches, strongest first, with a short snippet.
//   The sidebar's search box hits this.
//
//   The entity arm is the reason this delegates: a thread's visible
//   title is composed per response and stored nowhere, so searching
//   the name a user can SEE means resolving that name against the
//   entity tables first and finding the sessions pointing at it. See
//   server/services/session-search.js — it also backs 86's
//   search_my_sessions tool, so the sidebar and the agent can no
//   longer disagree about what is findable.
// ──────────────────────────────────────────────────────────────────
router.get('/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const orgId = await titleOrgId(req);
    const { results, total } = await searchSessions({
      userId: req.user.id,
      orgId,
      q,
      limit: 30,
      snippetLen: 240
    });
    // Search rows carry deal_numbers (session-search.js selects them for the
    // title and the lineage match) — same egress gate as the list.
    results.forEach((row) => withholdDealFigures(row, req.user));
    await redactForeignLineageRows(results, orgId);
    res.json({ results, total });
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

    const orgId = await titleOrgId(req);
    const sr = await pool.query(
      // deal_memory joined for the same reason the list query joins it: a deal
      // thread names itself after its CURRENT stage, which lives there.
      `SELECT s.*, dm.numbers AS deal_numbers, dm.root_type AS deal_root_type
         FROM ai_sessions s
         LEFT JOIN deal_memory dm ON dm.lineage_root = s.lineage_root
                                 AND ${dealJoinOrgArm('$3')}
        WHERE s.id = $1 AND s.user_id = $2`,
      [sid, req.user.id, orgId]
    );
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sr.rows[0];
    if (orgId == null) return orgUnresolved(res);
    if (await foreignLineageRefusal(res, session, orgId)) return;
    await attachSessionTitle(orgId, session);
    withholdDealFigures(session, req.user);

    // Load this session's message history. Use entity_type+entity_id
    // as the lookup key (matches how ai_messages is keyed today).
    const mr = await pool.query(
      `SELECT id, role, content, photos_included, inline_image_blocks,
              input_tokens, output_tokens,
              cache_creation_input_tokens, cache_read_input_tokens,
              output_files,
              created_at
         FROM ai_messages
        WHERE user_id = $1
          AND entity_type = $2
          AND COALESCE(estimate_id, '') = COALESCE($3, '')
          AND (organization_id = $4 OR organization_id IS NULL)
        ORDER BY created_at ASC`,
      [req.user.id, session.entity_type, session.entity_id, orgId]
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
router.post('/', requireAuth, requireOrg, async (req, res) => {
  try {
    const b = req.body || {};
    const entityType = String(b.entity_type || 'general').trim();
    const entityId = b.entity_id ? String(b.entity_id) : null;
    const label = b.label ? String(b.label).slice(0, 200) : null;
    // Sticky separate chats — when the sidebar "New chat" button mints a
    // session it asks for session_kind:'user_thread' so resolveSessionForChat
    // HONORS the explicit session_id (see ai-routes resolveSessionForChat,
    // line ~2876) instead of redirecting the first turn into the user's
    // most-recent rolling thread. Without this, every brand-new chat
    // collapsed back into the single existing user_thread ("new chats
    // aren't sticking"). A user_thread also gets compaction, so a sticky
    // chat still can't blow the context window. There is NO unique-active
    // index on ai_sessions (idx_ai_sessions_active was dropped — see
    // db.js ~line 1805), so multiple active user_thread rows per user are
    // allowed. Any other value falls back to the legacy default.
    const sessionKind = b.session_kind === 'user_thread' ? 'user_thread' : undefined;

    // requireOrg guarantees req.organization is set; bare-minimum
    // defensive check in case the middleware chain ever skips ahead.
    const organization = req.organization;
    if (!organization) {
      return res.status(400).json({ error: 'Organization required to create session' });
    }

    const ai = aiRoutes();
    // Stamp a "New chat" (user_thread) with the user's HOST agent — 'assistant'
    // for office staff, else 'job' (86) — so resolveSessionForChat HONORS the
    // explicit session_id instead of redirecting the turn into the user's
    // single existing rolling thread. Was hardcoded 'job', so office-staff new
    // chats carried agent_key='job' != hostKey('assistant') and collapsed back
    // into the one assistant thread ("new chats don't stick"). Non-user_thread
    // (legacy) sessions keep 'job'.
    const hostAgentKey = (sessionKind === 'user_thread' && typeof ai.resolveHostKeyForUser === 'function')
      ? await ai.resolveHostKeyForUser(req.user.id)
      : 'job';
    // Delegate Anthropic-side session creation to the existing helper.
    // The helper inserts the row too, then we apply our label / summary
    // patches in a second statement.
    const session = await ai.createFreshAiSession({
      agentKey: hostAgentKey,
      entityType,
      entityId,
      userId: req.user.id,
      organization,
      sessionKind
    });

    if (label || b.summary) {
      await pool.query(
        `UPDATE ai_sessions SET label = COALESCE($1, label), summary = COALESCE($2, summary)
          WHERE id = $3`,
        [label, b.summary || null, session.id]
      );
    }

    const r = await pool.query(`SELECT * FROM ai_sessions WHERE id = $1`, [session.id]);
    // The sidebar unshifts this row straight into its cached list and paints
    // display_label from it — without this a brand-new chat would title itself
    // "Untitled chat" until the next full fetchSessions.
    await attachSessionTitle(await titleOrgId(req), r.rows[0]);
    res.json({ session: r.rows[0] });
  } catch (e) {
    console.error('POST /api/ai/sessions error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/ai/sessions/archive-all-threads
//   Bulk-archive ALL of the caller's rolling chat threads (session_kind =
//   'user_thread') in one shot — the "Clear all chats" button. The panel only
//   ever resumes the most-recent NON-archived thread, so archiving them all
//   means the next panel open starts a clean, small-cache chat instead of
//   reloading a long accumulated conversation. Soft-delete (archived_at) — rows
//   are hidden + stop loading but stay recoverable (un-archive via PATCH). Only
//   the caller's own sessions; nothing else is touched.
//   Placed BEFORE the /:id routes so the literal path isn't captured by them.
// ──────────────────────────────────────────────────────────────────
router.post('/archive-all-threads', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE ai_sessions SET archived_at = NOW(), updated_at = NOW() " +
      " WHERE user_id = $1 AND session_kind = 'user_thread' AND archived_at IS NULL",
      [req.user.id]
    );
    res.json({ ok: true, archived: r.rowCount });
  } catch (e) {
    console.error('POST /api/ai/sessions/archive-all-threads error:', e);
    res.status(500).json({ error: 'Server error' });
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
      // Restoring a deal thread keyed on another tenant's lineage would undo
      // the boot archive; refuse it (archiving one stays allowed).
      if (!b.archived) {
        const cur = await pool.query(
          `SELECT session_kind, lineage_root FROM ai_sessions WHERE id = $1 AND user_id = $2`,
          [sid, req.user.id]
        );
        if (cur.rows.length && await foreignLineageRefusal(res, cur.rows[0], await titleOrgId(req))) return;
      }
    }
    if (b.effort_override === null || ['low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort_override)) {
      sets.push('effort_override = $' + p++);
      params.push(b.effort_override || null);
    }

    if (!sets.length) return res.status(400).json({ error: 'No valid fields supplied' });

    // SAFE: column names are hardcoded conditionals above (summary / pinned / archived_at / effort_override); no user-keys loop.
    const r = await pool.query(
      `UPDATE ai_sessions SET ${sets.join(', ')}
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Session not found' });
    // Rename is the one path where the client Object.assign's this row over its
    // cached copy. If the response carried no display_label the assign would
    // leave the STALE one in place and the sidebar would show the old title
    // after a successful rename.
    await attachSessionTitle(await titleOrgId(req), r.rows[0]);
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

    const orgId = await titleOrgId(req);
    const sr = await pool.query(
      `SELECT s.*, dm.numbers AS deal_numbers, dm.root_type AS deal_root_type
         FROM ai_sessions s
         LEFT JOIN deal_memory dm ON dm.lineage_root = s.lineage_root
                                 AND ${dealJoinOrgArm('$3')}
        WHERE s.id = $1 AND s.user_id = $2`,
      [sid, req.user.id, orgId]
    );
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sr.rows[0];
    if (orgId == null) return orgUnresolved(res);
    if (await foreignLineageRefusal(res, session, orgId)) return;
    // The export is a FILE the user keeps and forwards. Same standing rule as
    // the sidebar: its heading, its filename, and its context line name the
    // lead or the job, never the id (and never "Session 137" — a DB serial is
    // an id too).
    await attachSessionTitle(orgId, session);
    withholdDealFigures(session, req.user);
    const exportTitle = session.display_label || 'Untitled chat';

    const mr = await pool.query(
      `SELECT role, content, created_at
         FROM ai_messages
        WHERE user_id = $1
          AND entity_type = $2
          AND COALESCE(estimate_id, '') = COALESCE($3, '')
          AND (organization_id = $4 OR organization_id IS NULL)
        ORDER BY created_at ASC`,
      [req.user.id, session.entity_type, session.entity_id, orgId]
    );

    if (format === 'json') {
      res.json({ session, messages: mr.rows });
      return;
    }

    // Markdown format — readable transcript with role headers.
    const lines = [
      '# ' + exportTitle,
      '',
      session.summary ? '_' + session.summary + '_' : null,
      '',
      '- Created: ' + new Date(session.created_at).toISOString(),
      '- Turns: ' + session.turn_count,
      (session.entity_id && session.entity_id !== 'global')
        ? '- Context: ' + session.entity_type + ' — ' + exportTitle
        : '- Context: general',
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
      'attachment; filename="' + (exportTitle.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'chat') + '.md"');
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
router.post('/:id/branch', requireAuth, requireOrg, async (req, res) => {
  try {
    const sid = parseInt(req.params.id, 10);
    if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid session id' });
    const fromMessageId = req.body && req.body.from_message_id;
    if (!fromMessageId) return res.status(400).json({ error: 'from_message_id required' });
    const label = (req.body && req.body.label && String(req.body.label).slice(0, 200))
      || 'Branch';

    const orgId = await titleOrgId(req);
    const sr = await pool.query(
      `SELECT s.*, dm.numbers AS deal_numbers, dm.root_type AS deal_root_type
         FROM ai_sessions s
         LEFT JOIN deal_memory dm ON dm.lineage_root = s.lineage_root
                                 AND ${dealJoinOrgArm('$3')}
        WHERE s.id = $1 AND s.user_id = $2`,
      [sid, req.user.id, orgId]
    );
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found' });
    const parent = sr.rows[0];
    if (await foreignLineageRefusal(res, parent, orgId)) return;
    // "(branched from …)" is a summary the user reads — name the parent, don't
    // fall back to 'session 137'.
    await attachSessionTitle(orgId, parent);
    // requireOrg guarantees req.organization is set.

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
      [label, '(branched from ' + (parent.display_label || 'Untitled chat') + ')', newSession.id]
    );

    res.json({ session_id: newSession.id, anthropic_session_id: newSession.anthropic_session_id });
  } catch (e) {
    console.error('POST /api/ai/sessions/:id/branch error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

module.exports = router;
// Exported so the fail-closed edges (null user, role-less user, unknown stage)
// are held by RUNNING the gate — see test/deal-rest-figures.test.js.
module.exports.internals = { withholdDealFigures };
