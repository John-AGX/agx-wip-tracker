/* ── Global search (sidebar) ───────────────────────────────────────
   Single endpoint that searches jobs / estimates / leads / clients in
   one shot, directly against the DB. Unlike the client-side recents
   list (which only knows what's been opened) this covers everything,
   regardless of what appData has loaded.

   Why a dedicated route and not the AI `search_entities` tool: that
   tool formats its results as LLM-facing TEXT, not JSON, so it isn't
   reusable for a UI dropdown. This returns structured rows shaped to
   match the router's route shapes + the sidebar icon names.

   Scoping:
   - Org-scoped: (organization_id = $1 OR organization_id IS NULL),
     mirroring the list endpoints (NULL retained for unbackfilled
     legacy rows until the NOT NULL tightening).
   - Per-entity-type capability gating, inline via hasCapability:
       jobs       → auth only
       estimates  → auth only
       leads      → LEADS_VIEW
       clients    → ESTIMATES_VIEW
     A user missing a capability simply gets no rows of that type
     (the type is skipped), rather than a 403 for the whole search. */
const express = require('express');
const { pool } = require('../db');
const { requireAuth, hasCapability } = require('../auth');

const router = express.Router();

// Escape ILIKE metacharacters so a user typing "100%" or "a_b" gets a
// literal match instead of a wildcard. Backslash first, then % and _.
function escapeLike(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// GET /api/search?q=<term>&limit=<n per type>
router.get('/', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ results: [] });
    }

    // Clamp per-type limit to a sane range; default 6.
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 6;
    if (limit > 20) limit = 20;

    const orgId = req.user.organization_id;
    const term = '%' + escapeLike(q) + '%';

    // Build the set of queries to run, skipping types the caller can't
    // see. Each returns rows already shaped toward {type,id,name,sub}.
    const tasks = [];

    // jobs — auth only. title/jobNumber live inside JSONB `data`.
    tasks.push(
      pool.query(
        `SELECT id,
                data->>'jobNumber' AS job_number,
                data->>'title'     AS title
           FROM jobs
          WHERE (organization_id = $1 OR organization_id IS NULL)
            AND (data->>'title' ILIKE $2 OR data->>'jobNumber' ILIKE $2)
          ORDER BY updated_at DESC
          LIMIT $3`,
        [orgId, term, limit]
      ).then(({ rows }) => rows.map(r => {
        const title = r.title || '';
        const name = r.job_number ? (r.job_number + ' — ' + title) : (title || ('Job ' + r.id));
        return { type: 'jobs', id: r.id, name: name, sub: null };
      }))
    );

    // estimates — auth only. title in JSONB `data`.
    tasks.push(
      pool.query(
        `SELECT id, data->>'title' AS title
           FROM estimates
          WHERE (organization_id = $1 OR organization_id IS NULL)
            AND data->>'title' ILIKE $2
          ORDER BY updated_at DESC
          LIMIT $3`,
        [orgId, term, limit]
      ).then(({ rows }) => rows.map(r => ({
        type: 'estimates', id: r.id, name: r.title || ('Estimate ' + r.id), sub: null
      })))
    );

    // leads — LEADS_VIEW. real `title` column.
    if (hasCapability(req.user, 'LEADS_VIEW')) {
      tasks.push(
        pool.query(
          `SELECT id, title, status
             FROM leads
            WHERE (organization_id = $1 OR organization_id IS NULL)
              AND title ILIKE $2
            ORDER BY updated_at DESC
            LIMIT $3`,
          [orgId, term, limit]
        ).then(({ rows }) => rows.map(r => ({
          type: 'leads', id: r.id, name: r.title || ('Lead ' + r.id), sub: r.status || null
        })))
      );
    }

    // clients — ESTIMATES_VIEW. real `name` + `company_name` columns.
    if (hasCapability(req.user, 'ESTIMATES_VIEW')) {
      tasks.push(
        pool.query(
          `SELECT id, name, company_name
             FROM clients
            WHERE (organization_id = $1 OR organization_id IS NULL)
              AND (name ILIKE $2 OR company_name ILIKE $2)
            ORDER BY name
            LIMIT $3`,
          [orgId, term, limit]
        ).then(({ rows }) => rows.map(r => ({
          type: 'clients', id: r.id,
          name: r.name || r.company_name || ('Client ' + r.id),
          sub: (r.company_name && r.company_name !== r.name) ? r.company_name : null
        })))
      );
    }

    const grouped = await Promise.all(tasks);
    // Flatten in the task order (jobs, estimates, leads, clients) so the
    // dropdown groups naturally by type.
    const results = grouped.reduce((acc, arr) => acc.concat(arr), []);

    res.json({ results });
  } catch (e) {
    console.error('GET /api/search error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
