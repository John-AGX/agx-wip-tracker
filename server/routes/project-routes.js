// Projects — CompanyCam-style first-class entity that buckets photos +
// markups + reports around a single physical site / walkthrough.
//
// A project has nullable links to a lead (during sales), a job (once
// sold), and a client (the buyer). Photos live in the existing
// attachments table with entity_type='project'. Pairs (CompanyCam-
// style before/after) live in project_pairs. The detail timeline is
// fed by project_activity rows written from each mutation in this
// file.
//
// Capability gate: LEADS_VIEW for read, LEADS_EDIT for write. Same
// audience that touches leads can author projects — projects ARE the
// sales/job-lifecycle bucket.
//
// Org scoping: every row carries organization_id. Reads/writes filter
// to req.user.organization_id so a multi-tenant future doesn't leak
// project rows across orgs.

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

function newId() {
  return 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Resolve the caller's organization_id. Returns null when the user
// has no org assigned (shouldn't happen post-backfill, but defensive).
function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  if (!oid) return null;
  return Number(oid);
}

// Normalize a free-form tags input into a deduped lowercase string
// array. Strings only, max 32 chars per tag, max 20 tags total.
// Anything non-string is dropped silently.
function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < raw.length && out.length < 20; i++) {
    const v = raw[i];
    if (typeof v !== 'string') continue;
    const clean = v.trim().toLowerCase().slice(0, 32);
    if (!clean) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

// Fire-and-forget activity write. Caller doesn't await; failures are
// logged but don't fail the parent mutation — activity logging should
// never be the reason a user can't save their work.
function recordActivity(projectId, actorUserId, kind, detail) {
  pool.query(
    'INSERT INTO project_activity (project_id, actor_user_id, kind, detail) ' +
    'VALUES ($1, $2, $3, $4::jsonb)',
    [projectId, actorUserId || null, kind, JSON.stringify(detail || {})]
  ).catch(function(e) {
    console.warn('[projects] activity insert failed (' + kind + '):', e.message);
  });
}

// Allowlist of fields the PATCH route accepts. Anything outside this
// set is silently dropped — protects against SQL injection via the
// dynamic-SET pattern.
const EDITABLE_FIELDS = new Set([
  'name', 'description', 'cover_attachment_id',
  'lead_id', 'job_id', 'client_id',
  'address_text', 'geocode_lat', 'geocode_lng',
  'status', 'tags'
]);

// ──────────────────────────────────────────────────────────────────
// Static / specific paths first — Express matches in order, so
// /tags/suggest must register BEFORE /:id or "tags" would be parsed
// as the :id param.
// ──────────────────────────────────────────────────────────────────

// GET /api/projects/tags/suggest?q=<prefix>
// Autocomplete source for the tag editor. Returns up to 20 distinct
// tags from this org's projects matching the prefix (case-insensitive).
router.get('/tags/suggest', requireAuth, requireCapability('LEADS_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ tags: [] });
    const q = String(req.query.q || '').trim().toLowerCase();
    const sql =
      'SELECT DISTINCT t AS tag ' +
      '  FROM projects p, jsonb_array_elements_text(p.tags) AS t ' +
      ' WHERE p.organization_id = $1 ' +
      '   AND p.archived_at IS NULL ' +
      (q ? '   AND t ILIKE $2 ' : '') +
      ' ORDER BY tag ' +
      ' LIMIT 20';
    const params = q ? [orgId, q + '%'] : [orgId];
    const { rows } = await pool.query(sql, params);
    res.json({ tags: rows.map(function(r) { return r.tag; }) });
  } catch (e) {
    console.error('GET /api/projects/tags/suggest error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/projects
// Query params:
//   q          — substring search on name (case-insensitive)
//   status     — 'active' | 'archived' | 'all' (default 'active')
//   lead_id    — filter to projects linked to this lead
//   job_id     — filter to projects linked to this job
//   client_id  — filter to projects linked to this client
//   tag        — filter to projects whose tags array contains this string
//   has_pair   — '1' to filter to projects with at least one pair
//   limit      — max 200 (default 100)
//
// Returns { projects: [{ id, name, ..., tags, photo_count, pair_count,
//   cover_thumb_url, cover_web_url, lead_title, job_name, client_name,
//   created_at, updated_at }] }
router.get('/', requireAuth, requireCapability('LEADS_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ projects: [] });

    const where = ['p.organization_id = $1'];
    const params = [orgId];
    let pn = 2;

    const status = String(req.query.status || 'active').trim();
    if (status === 'active') {
      where.push('p.archived_at IS NULL');
    } else if (status === 'archived') {
      where.push('p.archived_at IS NOT NULL');
    } // 'all' = no filter

    if (req.query.q) {
      where.push('p.name ILIKE $' + (pn++));
      params.push('%' + String(req.query.q).trim() + '%');
    }
    if (req.query.lead_id) {
      where.push('p.lead_id = $' + (pn++));
      params.push(String(req.query.lead_id));
    }
    if (req.query.job_id) {
      where.push('p.job_id = $' + (pn++));
      params.push(String(req.query.job_id));
    }
    if (req.query.client_id) {
      where.push('p.client_id = $' + (pn++));
      params.push(String(req.query.client_id));
    }
    if (req.query.tag) {
      // GIN index on tags supports the @> containment operator.
      where.push("p.tags @> $" + (pn++) + "::jsonb");
      params.push(JSON.stringify([String(req.query.tag).trim().toLowerCase()]));
    }
    if (String(req.query.has_pair || '') === '1') {
      where.push('EXISTS (SELECT 1 FROM project_pairs pp WHERE pp.project_id = p.id)');
    }

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));

    // photo_count + pair_count + cover join. Cover priority:
    //   1. The explicit cover_attachment_id if set (LEFT JOIN cov)
    //   2. Falls back client-side to the newest attachment.
    const sql =
      'SELECT p.*, ' +
      '       (SELECT COUNT(*)::int FROM attachments a ' +
      '          WHERE a.entity_type = \'project\' AND a.entity_id = p.id) AS photo_count, ' +
      '       (SELECT COUNT(*)::int FROM project_pairs pp WHERE pp.project_id = p.id) AS pair_count, ' +
      '       cov.thumb_url AS cover_thumb_url, ' +
      '       cov.web_url   AS cover_web_url, ' +
      '       l.title       AS lead_title, ' +
      '       c.name        AS client_name, ' +
      '       COALESCE(j.data->>\'title\', j.data->>\'name\') AS job_name ' +
      '  FROM projects p ' +
      '  LEFT JOIN attachments cov ON cov.id = p.cover_attachment_id ' +
      '  LEFT JOIN leads l ON l.id = p.lead_id ' +
      '  LEFT JOIN clients c ON c.id = p.client_id ' +
      '  LEFT JOIN jobs j ON j.id = p.job_id ' +
      ' WHERE ' + where.join(' AND ') +
      ' ORDER BY p.updated_at DESC ' +
      ' LIMIT ' + limit;

    const { rows } = await pool.query(sql, params);
    res.json({ projects: rows });
  } catch (e) {
    console.error('GET /api/projects error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/projects/:id
// Single project, fully expanded. Hydrates the cover photo + lead /
// job / client names + photo / pair / activity counts.
router.get('/:id', requireAuth, requireCapability('LEADS_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Project not found' });
    const { rows } = await pool.query(
      'SELECT p.*, ' +
      '       (SELECT COUNT(*)::int FROM attachments a ' +
      '          WHERE a.entity_type = \'project\' AND a.entity_id = p.id) AS photo_count, ' +
      '       (SELECT COUNT(*)::int FROM project_pairs pp WHERE pp.project_id = p.id) AS pair_count, ' +
      '       (SELECT COUNT(*)::int FROM project_activity pa WHERE pa.project_id = p.id) AS activity_count, ' +
      '       cov.thumb_url AS cover_thumb_url, ' +
      '       cov.web_url   AS cover_web_url, ' +
      '       l.title       AS lead_title, ' +
      '       c.name        AS client_name, ' +
      '       COALESCE(j.data->>\'title\', j.data->>\'name\') AS job_name, ' +
      '       u.name        AS created_by_name ' +
      '  FROM projects p ' +
      '  LEFT JOIN attachments cov ON cov.id = p.cover_attachment_id ' +
      '  LEFT JOIN leads l ON l.id = p.lead_id ' +
      '  LEFT JOIN clients c ON c.id = p.client_id ' +
      '  LEFT JOIN jobs j ON j.id = p.job_id ' +
      '  LEFT JOIN users u ON u.id = p.created_by ' +
      ' WHERE p.id = $1 AND p.organization_id = $2',
      [req.params.id, orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: rows[0] });
  } catch (e) {
    console.error('GET /api/projects/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/projects/:id/activity?limit=N&before=<created_at>
// Paginated activity feed. before is a timestamp for cursor-style
// "load older" pagination — caller passes the oldest created_at they
// have, server returns the N entries older than that.
router.get('/:id/activity', requireAuth, requireCapability('LEADS_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ activity: [] });
    // Confirm the project belongs to this org before exposing activity.
    const ok = await pool.query(
      'SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!ok.rowCount) return res.status(404).json({ error: 'Project not found' });

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const before = req.query.before ? String(req.query.before) : null;

    let sql =
      'SELECT pa.id, pa.kind, pa.detail, pa.created_at, ' +
      '       pa.actor_user_id, u.name AS actor_name ' +
      '  FROM project_activity pa ' +
      '  LEFT JOIN users u ON u.id = pa.actor_user_id ' +
      ' WHERE pa.project_id = $1';
    const params = [req.params.id];
    if (before) {
      params.push(before);
      sql += ' AND pa.created_at < $2';
    }
    sql += ' ORDER BY pa.created_at DESC LIMIT ' + limit;

    const { rows } = await pool.query(sql, params);
    res.json({ activity: rows });
  } catch (e) {
    console.error('GET /api/projects/:id/activity error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/projects
// Body: { name, description?, lead_id?, job_id?, client_id?,
//   address_text?, geocode_lat?, geocode_lng?, tags? }
router.post('/', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const body = req.body || {};
    const name = (typeof body.name === 'string' && body.name.trim())
      ? body.name.trim().slice(0, 200)
      : 'Untitled project';
    const description = typeof body.description === 'string' ? body.description.slice(0, 5000) : null;
    const tags = normalizeTags(body.tags);
    const id = newId();

    const cols = ['id', 'organization_id', 'name', 'created_by', 'tags'];
    const vals = ['$1', '$2', '$3', '$4', '$5::jsonb'];
    const params = [id, orgId, name, req.user.id, JSON.stringify(tags)];
    let pn = 6;

    if (description != null) { cols.push('description'); vals.push('$' + pn++); params.push(description); }
    if (body.lead_id)        { cols.push('lead_id');     vals.push('$' + pn++); params.push(String(body.lead_id)); }
    if (body.job_id)         { cols.push('job_id');      vals.push('$' + pn++); params.push(String(body.job_id)); }
    if (body.client_id)      { cols.push('client_id');   vals.push('$' + pn++); params.push(String(body.client_id)); }
    if (body.address_text)   { cols.push('address_text');vals.push('$' + pn++); params.push(String(body.address_text).slice(0, 500)); }
    if (Number.isFinite(Number(body.geocode_lat))) { cols.push('geocode_lat'); vals.push('$' + pn++); params.push(Number(body.geocode_lat)); }
    if (Number.isFinite(Number(body.geocode_lng))) { cols.push('geocode_lng'); vals.push('$' + pn++); params.push(Number(body.geocode_lng)); }

    const sql = 'INSERT INTO projects (' + cols.join(', ') + ') VALUES (' + vals.join(', ') + ') RETURNING *';
    const { rows } = await pool.query(sql, params);
    recordActivity(id, req.user.id, 'created', { name: name });
    res.json({ project: rows[0] });
  } catch (e) {
    console.error('POST /api/projects error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/projects/:id
// Partial update. Only EDITABLE_FIELDS are accepted; unknown keys
// silently dropped. Setting status='archived' also stamps archived_at.
// Writes one activity row per meaningful field change, with the diff
// in detail.
router.patch('/:id', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Project not found' });
    const body = req.body || {};

    // Fetch the pre-update row to compute diffs for activity logging.
    const prior = await pool.query(
      'SELECT * FROM projects WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!prior.rowCount) return res.status(404).json({ error: 'Project not found' });
    const before = prior.rows[0];

    const sets = [];
    const params = [];
    let pn = 1;
    const changedFields = {};   // field → { before, after }

    Object.keys(body).forEach(function(key) {
      if (!EDITABLE_FIELDS.has(key)) return;
      let val = body[key];
      let priorVal = before[key];

      if (key === 'tags') {
        const normalized = normalizeTags(val);
        // Compare as JSON strings to detect any change.
        const priorJson = JSON.stringify(Array.isArray(priorVal) ? priorVal : []);
        const nextJson = JSON.stringify(normalized);
        if (priorJson === nextJson) return;
        sets.push('tags = $' + (pn++) + '::jsonb');
        params.push(nextJson);
        changedFields.tags = { before: priorJson, after: nextJson };
        return;
      }

      if (key === 'geocode_lat' || key === 'geocode_lng' || key === 'cover_attachment_id') {
        // cover_attachment_id is TEXT in the schema; legacy from when
        // we briefly had it as INTEGER. Coerce strings, accept null.
        if (val === '' || val == null) {
          val = null;
        } else if (key === 'cover_attachment_id') {
          val = String(val);
        } else if (!Number.isFinite(Number(val))) {
          return;
        } else {
          val = Number(val);
        }
      } else if (key === 'lead_id' || key === 'job_id' || key === 'client_id') {
        val = (val === '' || val == null) ? null : String(val);
      } else if (key === 'status') {
        val = String(val || 'active');
      } else {
        if (val == null) val = null;
        else val = String(val).slice(0, key === 'description' ? 5000 : 500);
      }

      // Skip the write if the value hasn't actually changed.
      const priorComparable = priorVal == null ? null : (typeof priorVal === 'object' ? JSON.stringify(priorVal) : String(priorVal));
      const nextComparable = val == null ? null : (typeof val === 'object' ? JSON.stringify(val) : String(val));
      if (priorComparable === nextComparable) return;

      sets.push(key + ' = $' + (pn++));
      params.push(val);
      changedFields[key] = { before: priorVal, after: val };
    });

    if (!sets.length) {
      // Nothing actually changed — return current row so the client
      // can refresh its cache without erroring.
      return res.json({ project: before });
    }

    // archived_at bookkeeping — sync with status.
    if (Object.prototype.hasOwnProperty.call(changedFields, 'status')) {
      if (String(body.status) === 'archived') {
        sets.push('archived_at = COALESCE(archived_at, NOW())');
      } else {
        sets.push('archived_at = NULL');
      }
    }
    sets.push('updated_at = NOW()');

    params.push(req.params.id, orgId);
    const sql =
      'UPDATE projects SET ' + sets.join(', ') +
      ' WHERE id = $' + (pn++) + ' AND organization_id = $' + (pn++) +
      ' RETURNING *';
    const r = await pool.query(sql, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Project not found' });

    // Write one activity row per changed field with the diff. Map the
    // raw field name to a more readable kind for the activity feed.
    Object.keys(changedFields).forEach(function(field) {
      const change = changedFields[field];
      let kind;
      let detail = { field: field, before: change.before, after: change.after };
      if (field === 'tags') {
        // Diff arrays so the feed can show "added X, removed Y".
        const beforeArr = JSON.parse(change.before);
        const afterArr = JSON.parse(change.after);
        const added = afterArr.filter(function(t) { return beforeArr.indexOf(t) === -1; });
        const removed = beforeArr.filter(function(t) { return afterArr.indexOf(t) === -1; });
        kind = 'tags_changed';
        detail = { added: added, removed: removed };
      } else if (field === 'cover_attachment_id') {
        kind = 'cover_set';
      } else if (field === 'lead_id' || field === 'job_id' || field === 'client_id') {
        kind = 'link_changed';
      } else if (field === 'status') {
        kind = 'status_changed';
      } else if (field === 'description') {
        kind = 'description_edited';
        // Don't dump full 5KB descriptions into the activity log.
        detail = { length_after: (change.after || '').length };
      } else if (field === 'address_text' || field === 'geocode_lat' || field === 'geocode_lng') {
        kind = 'address_edited';
      } else if (field === 'name') {
        kind = 'renamed';
      } else {
        kind = 'edited';
      }
      recordActivity(req.params.id, req.user.id, kind, detail);
    });

    res.json({ project: r.rows[0] });
  } catch (e) {
    console.error('PATCH /api/projects/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/projects/:id
// Soft delete (status='archived' + archived_at).
router.delete('/:id', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Project not found' });
    const r = await pool.query(
      'UPDATE projects SET status = \'archived\', archived_at = NOW(), updated_at = NOW() ' +
      ' WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Project not found' });
    recordActivity(req.params.id, req.user.id, 'status_changed', { before: 'active', after: 'archived' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/projects/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Expose recordActivity for sibling route modules (pairs, future
// reports) so they can post into the same activity feed without
// duplicating the helper.
module.exports = router;
module.exports.recordActivity = recordActivity;
