// Projects — CompanyCam-style first-class entity that buckets photos +
// markups + reports around a single physical site / walkthrough.
//
// A project has nullable links to a lead (during sales), a job (once
// sold), and a client (the buyer). Photos live in the existing
// attachments table with entity_type='project'. Reports (future P2)
// will reference a project via the polymorphic reports table.
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

// Resolve the caller's organization_id. Throws an error response if
// the user has no org assigned (shouldn't happen in practice — the
// users table backfilled everyone to AGX — but defensive).
function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  if (!oid) return null;
  return Number(oid);
}

// Allowlist of fields the PATCH route accepts. Anything outside this
// set is silently dropped — protects against SQL injection via the
// dynamic-SET pattern.
const EDITABLE_FIELDS = new Set([
  'name', 'description', 'cover_attachment_id',
  'lead_id', 'job_id', 'client_id',
  'address_text', 'geocode_lat', 'geocode_lng',
  'status'
]);

// GET /api/projects
// Query params:
//   q          — substring search on name (case-insensitive)
//   status     — 'active' | 'archived' | 'all' (default 'active')
//   lead_id    — filter to projects linked to this lead
//   job_id     — filter to projects linked to this job
//   client_id  — filter to projects linked to this client
//   limit      — max 200 (default 100)
//
// Returns { projects: [{ id, name, description, lead_id, job_id,
//   client_id, address_text, status, photo_count, cover_url,
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

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));

    // Photo count + cover_url join. Cover priority:
    //   1. The explicit cover_attachment_id if set
    //   2. The newest attachment under entity_type='project' (handled
    //      client-side; we just return the cover_attachment_id row).
    const sql =
      'SELECT p.*, ' +
      '       (SELECT COUNT(*)::int FROM attachments a ' +
      '          WHERE a.entity_type = \'project\' AND a.entity_id = p.id) AS photo_count, ' +
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
// job / client names + photo count.
router.get('/:id', requireAuth, requireCapability('LEADS_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Project not found' });
    const { rows } = await pool.query(
      'SELECT p.*, ' +
      '       (SELECT COUNT(*)::int FROM attachments a ' +
      '          WHERE a.entity_type = \'project\' AND a.entity_id = p.id) AS photo_count, ' +
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

// POST /api/projects
// Body: { name, description?, lead_id?, job_id?, client_id?,
//   address_text?, geocode_lat?, geocode_lng? }
router.post('/', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const body = req.body || {};
    const name = (typeof body.name === 'string' && body.name.trim())
      ? body.name.trim().slice(0, 200)
      : 'Untitled project';
    const description = typeof body.description === 'string' ? body.description.slice(0, 5000) : null;
    const id = newId();

    const cols = ['id', 'organization_id', 'name', 'created_by'];
    const vals = ['$1', '$2', '$3', '$4'];
    const params = [id, orgId, name, req.user.id];
    let pn = 5;

    if (description != null) { cols.push('description'); vals.push('$' + pn++); params.push(description); }
    if (body.lead_id)        { cols.push('lead_id');     vals.push('$' + pn++); params.push(String(body.lead_id)); }
    if (body.job_id)         { cols.push('job_id');      vals.push('$' + pn++); params.push(String(body.job_id)); }
    if (body.client_id)      { cols.push('client_id');   vals.push('$' + pn++); params.push(String(body.client_id)); }
    if (body.address_text)   { cols.push('address_text');vals.push('$' + pn++); params.push(String(body.address_text).slice(0, 500)); }
    if (Number.isFinite(Number(body.geocode_lat))) { cols.push('geocode_lat'); vals.push('$' + pn++); params.push(Number(body.geocode_lat)); }
    if (Number.isFinite(Number(body.geocode_lng))) { cols.push('geocode_lng'); vals.push('$' + pn++); params.push(Number(body.geocode_lng)); }

    const sql = 'INSERT INTO projects (' + cols.join(', ') + ') VALUES (' + vals.join(', ') + ') RETURNING *';
    const { rows } = await pool.query(sql, params);
    res.json({ project: rows[0] });
  } catch (e) {
    console.error('POST /api/projects error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/projects/:id
// Partial update. Only EDITABLE_FIELDS are accepted; unknown keys
// silently dropped. Setting status='archived' also stamps archived_at.
router.patch('/:id', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Project not found' });
    const body = req.body || {};
    const sets = [];
    const params = [];
    let pn = 1;

    Object.keys(body).forEach(function(key) {
      if (!EDITABLE_FIELDS.has(key)) return;
      let val = body[key];
      // String columns — coerce + cap. Numeric columns — coerce.
      if (key === 'geocode_lat' || key === 'geocode_lng' || key === 'cover_attachment_id') {
        if (val === '' || val == null) val = null;
        else if (!Number.isFinite(Number(val))) return;
        else val = Number(val);
      } else if (key === 'lead_id' || key === 'job_id' || key === 'client_id') {
        val = (val === '' || val == null) ? null : String(val);
      } else if (key === 'status') {
        val = String(val || 'active');
      } else {
        if (val == null) val = null;
        else val = String(val).slice(0, key === 'description' ? 5000 : 500);
      }
      sets.push(key + ' = $' + (pn++));
      params.push(val);
    });

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    // archived_at bookkeeping — sync with status.
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
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
    res.json({ project: r.rows[0] });
  } catch (e) {
    console.error('PATCH /api/projects/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/projects/:id
// Soft delete (status='archived' + archived_at). Hard delete is not
// supported via the API; the cascade fan-out (attachments orphaning,
// FK cleanup) would surprise users.
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
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/projects/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
