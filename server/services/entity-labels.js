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
//   job → data.title/name. Unknown types resolve to ''.
//
// IDs are compared as text (id::text = ANY($1::text[])) so a mix of
// text/serial id columns all work. Best-effort: a missing row yields no
// entry (caller falls back to the raw type/id).

'use strict';

const { pool } = require('../db');

// type → { sql(orgId) } returning rows of { id, label }. $1 = text[] ids.
function queryFor(type, ids, orgId) {
  switch (type) {
    case 'lead':
      return { text: 'SELECT id::text AS id, title AS label FROM leads WHERE id::text = ANY($1::text[])', params: [ids] };
    case 'client':
      return { text: 'SELECT id::text AS id, name AS label FROM clients WHERE id::text = ANY($1::text[])', params: [ids] };
    case 'sub':
      return { text: 'SELECT id::text AS id, name AS label FROM subs WHERE id::text = ANY($1::text[])', params: [ids] };
    case 'project':
      // projects carry organization_id — scope to the caller's org.
      return { text: 'SELECT id::text AS id, name AS label FROM projects WHERE id::text = ANY($1::text[]) AND organization_id = $2', params: [ids, orgId] };
    case 'estimate':
      return { text: "SELECT id::text AS id, COALESCE(data->>'name', data->>'title', 'Estimate') AS label FROM estimates WHERE id::text = ANY($1::text[])", params: [ids] };
    case 'job':
      return { text: "SELECT id::text AS id, COALESCE(NULLIF(data->>'jobNumber',''),'') AS num, COALESCE(data->>'title', data->>'name', 'Job') AS label FROM jobs WHERE id::text = ANY($1::text[])", params: [ids] };
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
        if (type === 'job' && r.num) label = '[' + r.num + '] ' + label;
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
