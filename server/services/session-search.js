// server/services/session-search.js — finding a chat thread by the name you
// can SEE in the sidebar.
//
// ── The gap this closes ────────────────────────────────────────────────────
// A thread's title is composed per response and stored nowhere: `label` is
// human intent only (NULL when nothing human exists), and `display_label` is
// resolved at read time from the entity the thread is about
// (server/services/session-title.js). The boot migration that split those two
// jobs apart actively NULLed every machine-minted label, so for a thread now
// titled "Deal · Uptown - Dumpster Pad Repair" the old predicate
// `s.label ILIKE '%uptown%'` evaluates NULL — it matches nothing at all. The
// only surviving path was the LLM-written summary plus the accident of the
// name appearing in a message body.
//
// ── The trap, and why this file is not it ──────────────────────────────────
// The easy fix is to add a `display_label` column, populate it on write, and
// ILIKE that. It is the SAME defect that was just removed, one column to the
// left: a machine-derived string sitting in a row, going stale the moment the
// lead is renamed — and worse than `label` was, because `label` at least has
// isMachineLabel() to tell authored from minted, whereas EVERY value in such a
// column would be derived. The sidebar would retitle on rename (read-time
// compose) while search kept finding the old name. So: nothing derived is
// stored, here or anywhere.
//
// Instead the lookup is INVERTED. Resolve the search term against the entity
// tables first — org-scoped, indexed, bounded — to get candidate ids, then
// find the sessions anchored to those ids. One source of truth, follows
// renames, no new column.
//
// ── Ranking, and why it must precede the trim ──────────────────────────────
// Three branches, each capped, merged and deduped by session id:
//
//   rank 1  the thread's NAME — an authored `label`, or the entity it is
//           named after. One tier because composeTitle() treats them as one
//           slot: an authored label wins, otherwise the entity name IS the
//           title.
//   rank 2  `summary` — a machine-written gist. Real signal, not the name.
//   rank 3  a message body — somebody said the word once.
//
// The old code merged `[...msgRows, ...metaRows]` and trimmed by ARRAY
// POSITION, so a passing mention in a stale thread outranked and evicted a
// pinned exact-title hit. With a third branch that trim becomes lossy for
// real, so the order here is: merge → dedupe → attach titles → score → sort →
// TRIM. The composed title participates in RANKING only; what EXISTS is
// decided by indexed columns.

'use strict';

const { pool } = require('../db');
const { findEntityIdsByName } = require('./entity-labels');
const { attachSessionTitles } = require('./session-title');

// The three id spaces a lineage_root / deal_memory.numbers key can hold. They
// don't overlap by construction ('lead_…' / 'e…' / 'j…' — server/db.js), which
// is what makes the untyped lineage array safe where the entity array is not.
const LINEAGE_TYPES = ['lead', 'estimate', 'job'];

const SESSION_COLS =
  `s.id, s.label, s.summary, s.entity_type, s.entity_id, s.pinned,
   s.last_used_at, s.turn_count, s.session_kind, s.lineage_root,
   dm.numbers AS deal_numbers, dm.root_type AS deal_root_type`;

// ──────────────────────────────────────────────────────────────────────────
// Candidate discovery: term → entity ids (org-scoped) → lineage ids.
// ──────────────────────────────────────────────────────────────────────────
//
// The lineage walk is what makes "any stage of the deal" true rather than
// aspirational. computeNumbers() writes exactly ONE stage id — a lead-rooted
// deal that has become a job carries {stage:'job', jobId} and no estimateId at
// all — so matching only `lineage_root` and the `numbers` keys leaves the
// INTERMEDIATE estimate unreachable by name. Walking job → estimate → lead
// once, in two batched queries against indexes that already exist
// (idx_jobs_estimate_id, idx_estimates_lead_id), puts every stage of a matched
// lineage into the same candidate set.
//
// Both walk queries stay org-guarded even though their inputs are already
// org-verified: the guard is the boundary, and a predicate that only holds
// because of its caller is one refactor from not holding.
async function findSessionCandidates(orgId, q) {
  const labels = await findEntityIdsByName(orgId, q);
  const types = [];
  const ids = [];
  const lineage = new Set();
  // raw id → { type, label }, so a lineage match can say WHAT it matched
  // without a second query.
  const lineageLabels = new Map();
  const jobIds = [];
  const estIds = [];

  for (const [key, label] of labels) {
    const cut = key.indexOf(':');
    const type = key.slice(0, cut);
    const id = key.slice(cut + 1);
    types.push(type);
    ids.push(id);
    if (LINEAGE_TYPES.indexOf(type) >= 0) {
      lineage.add(id);
      lineageLabels.set(id, { type: type, label: label });
      if (type === 'job') jobIds.push(id);
      if (type === 'estimate') estIds.push(id);
    }
  }

  if (jobIds.length) {
    try {
      const r = await pool.query(
        `SELECT estimate_id::text AS parent
           FROM jobs
          WHERE id::text = ANY($1::text[])
            AND estimate_id IS NOT NULL
            AND (organization_id = $2 OR organization_id IS NULL)`,
        [jobIds, orgId]
      );
      r.rows.forEach((x) => { if (x.parent) { estIds.push(x.parent); lineage.add(x.parent); } });
    } catch (e) {
      console.warn('[session-search] job→estimate lineage walk failed:', e && e.message);
    }
  }
  if (estIds.length) {
    try {
      const r = await pool.query(
        `SELECT data->>'lead_id' AS parent
           FROM estimates
          WHERE id::text = ANY($1::text[])
            AND data->>'lead_id' IS NOT NULL
            AND (organization_id = $2 OR organization_id IS NULL)`,
        [estIds, orgId]
      );
      r.rows.forEach((x) => { if (x.parent) lineage.add(x.parent); });
    } catch (e) {
      console.warn('[session-search] estimate→lead lineage walk failed:', e && e.message);
    }
  }

  return { types: types, ids: ids, lineage: [...lineage], labels: labels, lineageLabels: lineageLabels };
}

// ──────────────────────────────────────────────────────────────────────────
// Which candidate made this row match? Used only to explain a hit whose title
// doesn't visibly contain the term (a deal found by its lead's name while
// displaying its job number).
// ──────────────────────────────────────────────────────────────────────────
function matchedCandidate(row, cand) {
  if (!row) return null;
  const direct = cand.labels.get(String(row.entity_type || '') + ':' + String(row.entity_id || ''));
  if (direct != null) return { type: String(row.entity_type || ''), label: direct };
  const n = (row.deal_numbers && typeof row.deal_numbers === 'object') ? row.deal_numbers : {};
  const probes = [row.lineage_root, n.jobId, n.estimateId, n.leadId];
  for (const p of probes) {
    if (p == null) continue;
    const hit = cand.lineageLabels.get(String(p));
    if (hit) return hit;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// searchSessions — the one implementation. Both the sidebar endpoint
// (GET /api/ai/sessions/search) and 86's search_my_sessions tool call this;
// they used to carry byte-for-byte twins of the same two queries, which is how
// the sidebar could be fixed while the agent kept failing.
//
// Returns { results, total }. `total` counts DISTINCT sessions matched before
// the trim, so a caller can honestly say "showing N of M".
// ──────────────────────────────────────────────────────────────────────────
async function searchSessions(opts) {
  const userId = opts && opts.userId;
  const orgId = (opts && opts.orgId != null) ? opts.orgId : null;
  const q = String((opts && opts.q) || '').trim();
  const limit = Math.min(50, Math.max(1, parseInt((opts && opts.limit), 10) || 30));
  const snippetLen = Math.max(60, parseInt((opts && opts.snippetLen), 10) || 240);
  if (!userId || !q) return { results: [], total: 0 };

  const pattern = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';

  // ── A USER ID IS NOT A TENANT ────────────────────────────────────────────
  // The two lineage walks above already carry
  // `AND (organization_id = $2 OR organization_id IS NULL)`. The three
  // statements below carried only `WHERE s.user_id = $1`, and the premise under
  // that — "these are the caller's own threads, so there is no tenant to cross"
  // — is the same false one search_my_kb was written on:
  // `users.organization_id` is MUTABLE (PUT /api/auth/users/:id writes it, and
  // moving somebody between orgs is a documented one-click admin action), so a
  // user who moves keeps `user_id` on every thread they ever had in their
  // FORMER tenant. Executed, this returned the verbatim body of an
  // ai_messages row stamped organization_id = 2 to an org-1 caller — "unit cost
  // 987.65 markup 42" — narrated back into an org-1 chat window.
  //
  // `ai_sessions` HAS NO organization_id COLUMN, so there is nothing on the row
  // itself to predicate on and adding one would be a migration. The tenant of a
  // thread is therefore the tenant of ITS MESSAGES: every INSERT into
  // ai_messages in ai-routes.js stamps organization_id, so the anchor is
  // current, not merely backfilled.
  //
  //   arm 1  at least one of the thread's messages names the caller's tenant,
  //          or names none (the `IS NULL` tolerance every read here carries —
  //          it is what keeps a user's own legacy rows visible to them).
  //   arm 2  the thread has no messages joined to it at all. That covers a
  //          freshly created thread and every pre-cutover row whose messages
  //          predate the session_id column, and it is a deliberate tolerance:
  //          refusing them would hide a user's own history from them, which is
  //          the lockout half of this boundary and just as much a defect.
  //
  // An org-less caller matches neither `= $n` arm, so they see un-stamped
  // threads and nothing that names a tenant — nothing rather than everything.
  //
  // ONE DEFINITION, THREE STATEMENTS. Written once here and interpolated, so a
  // fourth branch cannot be added with two of the three arms.
  const sessionTenantSql =
    '(EXISTS (SELECT 1 FROM ai_messages sm WHERE sm.session_id = s.id' +
    '           AND (sm.organization_id = $ORG OR sm.organization_id IS NULL))' +
    ' OR NOT EXISTS (SELECT 1 FROM ai_messages sx WHERE sx.session_id = s.id))';
  const metaOrgGuard   = sessionTenantSql.replace('$ORG', '$4');
  const msgOrgGuard    = sessionTenantSql.replace('$ORG', '$5');
  const entityOrgGuard = sessionTenantSql.replace('$ORG', '$6');

  // Candidate discovery runs alongside the two ILIKE branches — it touches
  // different tables and neither waits on the other.
  const [cand, metaRows, msgRows] = await Promise.all([
    findSessionCandidates(orgId, q).catch((e) => {
      console.warn('[session-search] candidate discovery failed:', e && e.message);
      return { types: [], ids: [], lineage: [], labels: new Map(), lineageLabels: new Map() };
    }),
    // Branch A — metadata. Predicate byte-identical to what it always was;
    // it gains only s.pinned and a rank literal. `label` outranks `summary`
    // because a name beats a gist.
    pool.query(
      `SELECT ${SESSION_COLS},
              'meta'::text AS match_kind,
              CASE WHEN s.label ILIKE $2 THEN 1 ELSE 2 END AS match_rank,
              NULL::text AS snippet
         FROM ai_sessions s
         LEFT JOIN deal_memory dm ON dm.lineage_root = s.lineage_root
        WHERE s.user_id = $1
          AND s.archived_at IS NULL
          AND (s.label ILIKE $2 OR s.summary ILIKE $2)
          AND ${metaOrgGuard}
        ORDER BY s.pinned DESC, s.last_used_at DESC
        LIMIT $3`,
      [userId, pattern, limit, orgId]
    ),
    // Branch B — message bodies. Its join key is still (user_id, entity_type,
    // estimate_id) rather than m.session_id = s.id, so one matching message
    // fans out to every session sharing that tuple. That is a real,
    // pre-existing defect, filed separately.
    //
    // IT IS ALSO WHY THIS BRANCH NEEDS TWO PREDICATES, NOT ONE. Because the
    // join does not go through session_id, the message that produces the
    // SNIPPET need not belong to the matched session at all — for a 'general'
    // thread both sides carry a NULL entity_id, so every one of the user's
    // general messages joins to every one of their general sessions, across
    // tenants. The session-level guard cannot see that: it asks about the
    // session's OWN messages. So the message is scoped on its own stamp here,
    // and that is the predicate the executed proof actually needed — the row it
    // leaked was an ai_messages body, not a session title.
    pool.query(
      `WITH matches AS (
         SELECT s.id AS session_id, s.label, s.summary, s.entity_type, s.entity_id,
                s.pinned, s.last_used_at, s.turn_count, s.session_kind, s.lineage_root,
                dm.numbers AS deal_numbers, dm.root_type AS deal_root_type,
                m.content AS snippet,
                ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY m.created_at ASC) AS rn
           FROM ai_sessions s
           JOIN ai_messages m
             ON m.user_id = s.user_id
            AND m.entity_type = s.entity_type
            AND COALESCE(m.estimate_id, '') = COALESCE(s.entity_id, '')
           LEFT JOIN deal_memory dm ON dm.lineage_root = s.lineage_root
          WHERE s.user_id = $1
            AND s.archived_at IS NULL
            AND m.content ILIKE $2
            AND (m.organization_id = $5 OR m.organization_id IS NULL)
            AND ${msgOrgGuard}
       )
       SELECT session_id AS id, label, summary, entity_type, entity_id, pinned,
              last_used_at, turn_count, session_kind, lineage_root,
              deal_numbers, deal_root_type,
              'message'::text AS match_kind,
              3::int AS match_rank,
              substr(snippet, 1, $4::int) AS snippet
         FROM matches
        WHERE rn = 1
        ORDER BY last_used_at DESC
        LIMIT $3`,
      [userId, pattern, limit, snippetLen, orgId]
    )
  ]);

  // Branch C — the inversion. Sessions anchored to an entity whose NAME
  // matched, or whose deal lineage contains one.
  //
  // The entity arm is row-wise ((entity_type, entity_id) against parallel
  // arrays) rather than a concatenated key: entity_id is TEXT and id spaces
  // are a convention rather than a guarantee (lead-routes.js accepts a
  // caller-supplied id), so pairing type with id keeps a project id from
  // lighting up a client-anchored session. It is deliberately NOT
  // `entity_type || ':' || entity_id` — no btree can serve a predicate on a
  // concatenation, and the OR across the LEFT-JOINed deal_memory means the
  // planner drives on ai_sessions via user_id (idx_ai_sessions_user_last)
  // regardless. This is bounded by ONE user's non-archived sessions, which is
  // why no new index is added for it.
  let entityRows = { rows: [] };
  if (cand.ids.length || cand.lineage.length) {
    try {
      entityRows = await pool.query(
        `SELECT ${SESSION_COLS},
                'entity'::text AS match_kind,
                1::int AS match_rank,
                NULL::text AS snippet
           FROM ai_sessions s
           LEFT JOIN deal_memory dm ON dm.lineage_root = s.lineage_root
          WHERE s.user_id = $1
            AND s.archived_at IS NULL
            AND (
                  (s.entity_type, s.entity_id) IN (
                    SELECT t, i FROM unnest($2::text[], $3::text[]) AS u(t, i)
                  )
               OR s.lineage_root            = ANY($4::text[])
               OR dm.numbers->>'leadId'     = ANY($4::text[])
               OR dm.numbers->>'estimateId' = ANY($4::text[])
               OR dm.numbers->>'jobId'      = ANY($4::text[])
            )
            AND ${entityOrgGuard}
          ORDER BY s.pinned DESC, s.last_used_at DESC
          LIMIT $5`,
        [userId, cand.types, cand.ids, cand.lineage, limit, orgId]
      );
    } catch (e) {
      // Best-effort, same posture as the resolver: a failure here must fall
      // back to the previous behaviour, not 500 the sidebar.
      console.warn('[session-search] entity-name branch failed:', e && e.message);
      entityRows = { rows: [] };
    }
  }

  // Dedupe by session id, KEEPING THE STRONGEST match — and carrying the
  // message branch's snippet onto whatever survives, which is the whole reason
  // the old code preferred the message row.
  const byId = new Map();
  [].concat(entityRows.rows, metaRows.rows, msgRows.rows).forEach((row) => {
    const prev = byId.get(row.id);
    if (!prev) { byId.set(row.id, row); return; }
    if (row.match_rank < prev.match_rank) {
      if (!row.snippet && prev.snippet) row.snippet = prev.snippet;
      byId.set(row.id, row);
    } else if (!prev.snippet && row.snippet) {
      prev.snippet = row.snippet;
    }
  });
  const merged = [...byId.values()];
  if (!merged.length) return { results: [], total: 0 };

  // Titles for EVERY merged row, before the trim. This is one batched resolve
  // (one query per entity TYPE, not per row) whether it covers 30 rows or 90,
  // so scoring on the composed title costs nothing extra — and scoring after
  // the trim would be scoring the survivors of an unranked cut.
  await attachSessionTitles(orgId, merged);

  const lc = q.toLowerCase();
  merged.forEach((r) => {
    const dl = String(r.display_label || '').toLowerCase();
    const titleBonus = dl === lc ? 3 : (dl.indexOf(lc) === 0 ? 2 : (dl.indexOf(lc) >= 0 ? 1 : 0));
    r._score = (Number(r.match_rank) || 3) * 10 - titleBonus - (r.pinned ? 0.5 : 0);
    // Explain a hit the title can't: a deal matched through its lead's name
    // while displaying its job number. When the title already contains the
    // term the snippet would be noise, so it stays off.
    if (r.match_kind === 'entity' && !r.snippet && titleBonus === 0) {
      const hit = matchedCandidate(r, cand);
      if (hit && hit.label) r.snippet = 'matched ' + hit.type + ': ' + hit.label;
    }
  });
  merged.sort((a, b) =>
    (a._score - b._score) ||
    (new Date(b.last_used_at || 0) - new Date(a.last_used_at || 0)));

  const results = merged.slice(0, limit);
  results.forEach((r) => { delete r._score; });
  return { results: results, total: merged.length };
}

module.exports = { searchSessions, findSessionCandidates, matchedCandidate };
