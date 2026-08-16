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

module.exports = { resolveEntityLabels, attachEntityLabels };
