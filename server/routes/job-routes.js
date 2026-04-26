const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

async function canAccess(userId, userRole, jobId) {
  if (userRole === 'admin' || userRole === 'corporate') return true;
  const { rows } = await pool.query('SELECT owner_id FROM jobs WHERE id = $1', [jobId]);
  if (!rows.length) return false;
  if (rows[0].owner_id === userId) return true;
  const access = await pool.query('SELECT 1 FROM job_access WHERE job_id = $1 AND user_id = $2', [jobId, userId]);
  return access.rows.length > 0;
}

async function canEdit(userId, userRole, jobId) {
  if (userRole === 'admin') return true;
  if (userRole === 'corporate') return false;
  const { rows } = await pool.query('SELECT owner_id FROM jobs WHERE id = $1', [jobId]);
  if (!rows.length) return false;
  if (rows[0].owner_id === userId) return true;
  const access = await pool.query("SELECT access_level FROM job_access WHERE job_id = $1 AND user_id = $2", [jobId, userId]);
  return access.rows.length > 0 && access.rows[0].access_level === 'edit';
}

// GET /api/jobs
// Everyone authenticated sees every job. Edit rights are conveyed via _canEdit
// on each row so the client can render read-only indicators and skip non-editable
// jobs from its bulk-save payload.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT j.id, j.data, j.owner_id, j.created_at, j.updated_at,
             COALESCE(ja.access_level, '') AS access_level
      FROM jobs j
      LEFT JOIN job_access ja ON ja.job_id = j.id AND ja.user_id = $1
    `, [req.user.id]);
    const result = rows.map(j => {
      let canEdit = false;
      if (req.user.role === 'admin') canEdit = true;
      else if (req.user.role === 'corporate') canEdit = false;
      else if (j.owner_id === req.user.id) canEdit = true;
      else if (j.access_level === 'edit') canEdit = true;
      return { id: j.id, owner_id: j.owner_id, _canEdit: canEdit, ...j.data };
    });
    res.json({ jobs: result });
  } catch (e) {
    console.error('GET /api/jobs error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/jobs/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!(await canAccess(req.user.id, req.user.role, req.params.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    res.json({ id: rows[0].id, owner_id: rows[0].owner_id, ...rows[0].data });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/jobs
// Admins can assign ownership to any user via body.owner_id; PMs always own
// the jobs they create (the field is ignored from non-admin callers).
router.post('/', requireAuth, requireRole('admin', 'pm'), async (req, res) => {
  try {
    const id = req.body.id || 'job' + Date.now();
    let ownerId = req.user.id;
    if (req.user.role === 'admin' && req.body.owner_id) {
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1 AND active = true', [req.body.owner_id]);
      if (!rows.length) return res.status(400).json({ error: 'Invalid owner_id' });
      ownerId = req.body.owner_id;
    }
    await pool.query('INSERT INTO jobs (id, owner_id, data) VALUES ($1, $2, $3)',
      [id, ownerId, JSON.stringify(req.body)]);
    res.json({ id, owner_id: ownerId, ok: true });
  } catch (e) {
    console.error('POST /api/jobs error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/jobs/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    if (!(await canEdit(req.user.id, req.user.role, req.params.id))) {
      return res.status(403).json({ error: 'No edit access' });
    }
    await pool.query("UPDATE jobs SET data = $1, updated_at = NOW() WHERE id = $2",
      [JSON.stringify(req.body), req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/jobs/:id (admin only)
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM jobs WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/jobs/:id/access
router.post('/:id/access', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT owner_id FROM jobs WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    if (req.user.role !== 'admin' && rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Only owner or admin can manage access' });
    }
    const { userId, accessLevel } = req.body;
    await pool.query(
      'INSERT INTO job_access (job_id, user_id, access_level) VALUES ($1, $2, $3) ON CONFLICT (job_id, user_id) DO UPDATE SET access_level = $3',
      [req.params.id, userId, accessLevel || 'edit']);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/jobs/bulk/save
router.put('/bulk/save', requireAuth, requireRole('admin', 'pm'), async (req, res) => {
  try {
    const { appData } = req.body;
    if (!appData || !appData.jobs) return res.status(400).json({ error: 'Invalid appData' });

    const client = await pool.connect();
    let saved = 0;
    let skipped = 0;
    try {
      await client.query('BEGIN');
      for (const job of appData.jobs) {
        // Defense in depth: even if the client sends jobs the user can't edit,
        // we re-check here. Admins can edit anything; PMs need ownership or
        // explicit job_access edit grant; corporate is read-only.
        const existing = await client.query(
          'SELECT owner_id FROM jobs WHERE id = $1', [job.id]
        );
        if (existing.rows.length) {
          let canEdit = false;
          if (req.user.role === 'admin') canEdit = true;
          else if (req.user.role === 'corporate') canEdit = false;
          else if (existing.rows[0].owner_id === req.user.id) canEdit = true;
          else {
            const access = await client.query(
              "SELECT access_level FROM job_access WHERE job_id = $1 AND user_id = $2",
              [job.id, req.user.id]
            );
            canEdit = access.rows.length > 0 && access.rows[0].access_level === 'edit';
          }
          if (!canEdit) { skipped++; continue; }
        }
        const jobBlob = {
          ...job,
          buildings: (appData.buildings || []).filter(b => b.jobId === job.id),
          phases: (appData.phases || []).filter(p => p.jobId === job.id),
          changeOrders: (appData.changeOrders || []).filter(c => c.jobId === job.id),
          subs: (appData.subs || []).filter(s => s.jobId === job.id),
          purchaseOrders: (appData.purchaseOrders || []).filter(p => p.jobId === job.id),
          invoices: (appData.invoices || []).filter(i => i.jobId === job.id),
        };
        // Strip server-injected hints that shouldn't round-trip back into the blob
        delete jobBlob._canEdit;
        // For new jobs, admins can specify owner_id to assign a PM. Non-admins
        // (PMs creating their own jobs) always own what they create. ON CONFLICT
        // never touches owner_id, so existing jobs keep their original PM.
        const ownerId = (req.user.role === 'admin' && job.owner_id) ? job.owner_id : req.user.id;
        await client.query(
          `INSERT INTO jobs (id, owner_id, data) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET data = $3, updated_at = NOW()`,
          [job.id, ownerId, JSON.stringify(jobBlob)]
        );
        saved++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, count: saved, skipped: skipped });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Node graph routes
router.get('/:id/graph', requireAuth, async (req, res) => {
  try {
    if (!(await canAccess(req.user.id, req.user.role, req.params.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows } = await pool.query('SELECT data FROM node_graphs WHERE job_id = $1', [req.params.id]);
    res.json({ graph: rows.length ? rows[0].data : null });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id/graph', requireAuth, async (req, res) => {
  try {
    if (!(await canEdit(req.user.id, req.user.role, req.params.id))) {
      return res.status(403).json({ error: 'No edit access' });
    }
    await pool.query(
      `INSERT INTO node_graphs (job_id, data) VALUES ($1, $2)
       ON CONFLICT (job_id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [req.params.id, JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
