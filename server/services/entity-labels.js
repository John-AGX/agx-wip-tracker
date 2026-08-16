// Batched polymorphic entity-label resolver.
//
// Given a set of {entity_type, entity_id} links (from calendar_events,
// tasks, etc.), resolve a human label for each in ONE query per type —
// not one per row. Used to hydrate list endpoints (My Day, a client's
// Appointments list) without an N+1 storm.
//
// Mirrors the single-row resolveEntityLabel in tasks-routes.js, batched:
//   lead → leads.title, client → clients.name, sub → subs.name,
//   project → projects.name (org-scoped), estimate → data.name/title,
//   job → jobNumber + ' ' + title via js/job-label. Unknown types → ''.
//
// The "mirrors" claim used to be false for jobs: this file prefixed
// "[RV2006] " while tasks-routes.js dropped the number entirely, so the same
// task rendered "[RV2006] Waterside" in-app and "Waterside" in the assignment
// email. Both now call the one shared formatter.
//
// IDs are compared as text (id::text = ANY($1::text[])) so a mix of
// text/serial id columns all work. Best-effort: a missing row yields no
// entry (caller falls back to the raw type/id).

'use strict';

const { pool } = require('../db');
// Same formatter the browser loads as window.p86JobLabel — one definition of
// `jobNumber + ' ' + title` for both sides. See js/job-label.js.
const jobLabel = require('../../js/job-label');

// Tenant guard. organization_id is the security boundary, and the ids handed
// to this resolver are NOT trustworthy: ai_sessions.entity_id is whatever the
// caller POSTed (ai-sessions-routes.js takes `b.entity_id` with no existence
// or ownership check), so an unscoped primary-key lookup turns a stored client
// string into a cross-tenant NAME ORACLE — mint N sessions pointing at another
// org's leads, read the list back, collect the titles in one batched response.
// Every table below carries organization_id, indexed (server/db.js:466-597),
// and the single-row twin in ai-routes.js (resolveTaskEntityLabel) already
// guards exactly this way.
//
// Applied ONLY when the caller supplies an org. A null orgId keeps the previous
// unscoped behaviour rather than silently resolving nothing for the callers
// that pass `req.user.organization_id || null` on a legacy token — tightening
// where we know the tenant, never breaking where we don't.
function orgGuard(orgId) {
  return orgId == null ? '' : ' AND (organization_id = $2 OR organization_id IS NULL)';
}
function orgParams(ids, orgId) {
  return orgId == null ? [ids] : [ids, orgId];
}

// type → { sql(orgId) } returning rows of { id, label }. $1 = text[] ids,
// $2 = orgId when scoped.
function queryFor(type, ids, orgId) {
  const g = orgGuard(orgId);
  const p = orgParams(ids, orgId);
  switch (type) {
    case 'lead':
      return { text: 'SELECT id::text AS id, title AS label FROM leads WHERE id::text = ANY($1::text[])' + g, params: p };
    case 'client':
      return { text: 'SELECT id::text AS id, name AS label FROM clients WHERE id::text = ANY($1::text[])' + g, params: p };
    case 'sub':
      return { text: 'SELECT id::text AS id, name AS label FROM subs WHERE id::text = ANY($1::text[])' + g, params: p };
    case 'project':
      // projects carry organization_id — scope to the caller's org. Unlike the
      // branches above this one has ALWAYS been strict (no OR-IS-NULL arm);
      // left exactly as it was.
      return { text: 'SELECT id::text AS id, name AS label FROM projects WHERE id::text = ANY($1::text[]) AND organization_id = $2', params: [ids, orgId] };
    case 'estimate':
      // Ends in '' — NOT the literal 'Estimate', for the same reason the job
      // branch below ends in '': a bare type word is a synthetic string that
      // reaches forward-facing surfaces as if it were a real name. Empty is
      // the honest answer and the caller picks the fallback it wants
      // ('Untitled estimate' for a session title).
      return { text: "SELECT id::text AS id, COALESCE(data->>'name', data->>'title', '') AS label FROM estimates WHERE id::text = ANY($1::text[])" + g, params: p };
    case 'job':
      // The title COALESCE ends in '' — NOT the literal 'Job'. A synthetic
      // word here reached jobLabel as a real title, so a numbered job with
      // no title rendered "RV2006 Job". Empty is the honest answer; the
      // formatter below decides what an empty pair looks like. Matches the
      // single-row twin in tasks-routes.js.
      return { text: "SELECT id::text AS id, COALESCE(NULLIF(data->>'jobNumber',''),'') AS num, COALESCE(data->>'title', data->>'name', '') AS label FROM jobs WHERE id::text = ANY($1::text[])" + g, params: p };
    default:
      return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// findEntityIdsByName — the INVERSE of queryFor(). Name → candidate ids.
// ──────────────────────────────────────────────────────────────────────────
//
// Why it lives here and not at the call site: it must read exactly the columns
// queryFor() reads. A session's display title is composed from those columns
// at READ time and stored nowhere (server/services/session-title.js), so the
// only way to search by the name a user can SEE is to match the entity first
// and then find the sessions pointing at it. If the two directions ever drift,
// search stops finding threads whose titles it can render. One diff touches
// both.
//
// The column expressions below are copied CHARACTER-FOR-CHARACTER from
// queryFor(). Change one, change the other — and change the matching trigram
// index in server/db.js, or search sequential-scans jobs/estimates.
//
// NOTE the deliberate absence of a `jobNumber || ' ' || title` expression.
// That composition is owned by js/job-label.js and by nothing else (it exists
// to end a six-way format drift), and re-authoring it in SQL would reproduce
// only its `n && t` branch. Instead the WHERE clause AND-s the whitespace
// tokens of the search term across the two component columns: "RV2006
// Waterside" matches because `RV2006` hits the number column and `Waterside`
// hits the title column, with no knowledge of how they get joined for display.
// Token-AND is a strict SUPERSET of a contiguous ILIKE over the same columns,
// so this can only ever add candidates.
const SEARCH_COLUMNS = {
  lead:     { table: 'leads',     label: 'title' },
  client:   { table: 'clients',   label: 'name' },
  sub:      { table: 'subs',      label: 'name' },
  // projects has ALWAYS been strictly scoped (organization_id is NOT NULL on
  // that table) — no OR-IS-NULL arm, matching queryFor().
  project:  { table: 'projects',  label: 'name', strictOrg: true },
  estimate: { table: 'estimates', label: "COALESCE(data->>'name', data->>'title', '')" },
  job:      { table: 'jobs',      label: "COALESCE(data->>'title', data->>'name', '')",
              num:   "COALESCE(NULLIF(data->>'jobNumber',''),'')" }
};

// A trigram GIN index cannot serve an ILIKE pattern with fewer than three
// extractable characters, and the sidebar's search box fires on a 180ms
// debounce with no minimum length. Tokens shorter than this are DROPPED rather
// than matched, so every pattern this function emits is index-servable —
// dropping a token only widens the match, never narrows it. If every token is
// short the whole search yields no entity candidates and the caller falls back
// to the label/summary/body branches, i.e. exactly today's behaviour.
const MIN_TOKEN_LEN = 3;
const MAX_TOKENS = 4;
// Ceiling on how many entities one term may nominate. A generic term
// ("repair", "siding") can match thousands; the sessions query that consumes
// these ids has to stay bounded. ORDER BY id makes *which* 200 deterministic —
// without it the set is heap order and can silently change after a VACUUM.
const CANDIDATE_LIMIT = 200;

function likeTokens(term) {
  return String(term == null ? '' : term)
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN)
    .slice(0, MAX_TOKENS)
    // Same escaping the search routes already apply before an ILIKE.
    .map((t) => '%' + t.replace(/[\\%_]/g, (m) => '\\' + m) + '%');
}

// orgId, searchTerm → Map keyed `${type}:${id}` → resolved label (composed the
// same way resolveEntityLabels composes it, jobLabel included).
//
// TENANT RULE, and it is the opposite of the one orgGuard() encodes. There the
// caller already holds the id and is only asking for its name, so an unscoped
// legacy token keeps its old behaviour. HERE the caller supplies the NAME and
// learns whether a row bearing it exists — an unscoped probe is a cross-tenant
// existence oracle. So a null orgId yields ZERO candidates. That is not a
// regression for anyone: before this function existed, searching a name
// matched no entity at all, so the null-org fallback is precisely the previous
// behaviour rather than a widened one.
async function findEntityIdsByName(orgId, term, opts) {
  const out = new Map();
  if (orgId == null) return out;
  const patterns = likeTokens(term);
  if (!patterns.length) return out;

  const types = (opts && Array.isArray(opts.types) && opts.types.length)
    ? opts.types.filter((t) => SEARCH_COLUMNS[t])
    : Object.keys(SEARCH_COLUMNS);

  await Promise.all(types.map(async (type) => {
    const spec = SEARCH_COLUMNS[type];
    if (!spec) return;
    // $1 = orgId, $2..$n = one pattern per token.
    const params = [orgId].concat(patterns);
    const cols = spec.num ? [spec.num, spec.label] : [spec.label];
    const tokenClauses = patterns.map((_, i) => {
      const p = '$' + (i + 2);
      return '(' + cols.map((c) => c + ' ILIKE ' + p).join(' OR ') + ')';
    });
    const org = spec.strictOrg
      ? 'organization_id = $1'
      : '(organization_id = $1 OR organization_id IS NULL)';
    const select = spec.num
      ? 'id::text AS id, ' + spec.num + ' AS num, ' + spec.label + ' AS label'
      : 'id::text AS id, ' + spec.label + ' AS label';
    const text = 'SELECT ' + select + ' FROM ' + spec.table +
      ' WHERE ' + tokenClauses.join(' AND ') + ' AND ' + org +
      ' ORDER BY id LIMIT ' + CANDIDATE_LIMIT;
    try {
      const { rows } = await pool.query(text, params);
      rows.forEach((r) => {
        let label = r.label || '';
        if (type === 'job') label = jobLabel(r.num, label);
        out.set(type + ':' + r.id, label);
      });
    } catch (e) {
      // Per-type, exactly like resolveEntityLabels: one bad column must not
      // turn every search into a 500.
      console.warn('[entity-labels] name search failed for type=' + type + ':', e && e.message);
    }
  }));

  return out;
}

// items: array of { entity_type, entity_id } (extra keys ignored).
// Returns a Map keyed `${type}:${id}` → label string.
async function resolveEntityLabels(orgId, items) {
  const out = new Map();
  if (!Array.isArray(items) || !items.length) return out;

  // Group distinct ids by type.
  const byType = {};
  for (const it of items) {
    const t = it && it.entity_type;
    const id = it && it.entity_id;
    if (!t || id == null || String(id).trim() === '') continue;
    (byType[t] = byType[t] || new Set()).add(String(id));
  }

  const types = Object.keys(byType);
  await Promise.all(types.map(async (type) => {
    const ids = [...byType[type]];
    const q = queryFor(type, ids, orgId);
    if (!q) return;
    try {
      const { rows } = await pool.query(q.text, q.params);
      rows.forEach((r) => {
        let label = r.label || '';
        // No local fallback string — a job with neither number nor title
        // gets js/job-label.js's own DEFAULT_FALLBACK ('Untitled job'), the
        // one the rest of the app already renders. Forward-facing surfaces
        // (sub portal, task share links) paint this verbatim, so it must
        // never be a bare type word.
        if (type === 'job') label = jobLabel(r.num, label);
        out.set(type + ':' + r.id, label);
      });
    } catch (e) {
      // Best-effort — a bad table/column for one type shouldn't sink the rest.
      console.warn('[entity-labels] resolve failed for type=' + type + ':', e && e.message);
    }
  }));

  return out;
}

// Convenience: mutate a list of rows in place, attaching `entity_label`
// for any row that carries entity_type + entity_id. Returns the rows.
async function attachEntityLabels(orgId, rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const labels = await resolveEntityLabels(orgId, rows);
  for (const r of rows) {
    if (r && r.entity_type && r.entity_id != null) {
      r.entity_label = labels.get(r.entity_type + ':' + String(r.entity_id)) || null;
    }
  }
  return rows;
}

module.exports = {
  resolveEntityLabels,
  attachEntityLabels,
  findEntityIdsByName,
  // exported for tests
  likeTokens,
  MIN_TOKEN_LEN,
  CANDIDATE_LIMIT
};
