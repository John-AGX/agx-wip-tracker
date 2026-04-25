const express = require('express');
const { getDb } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// Check if user can access a job
function canAccess(userId, userRole, jobId) {
  if (userRole === 'admin' || userRole === 'corporate') return true;
  const db = getDb();
  const job = db.prepare('SELECT owner_id FROM jobs WHERE id = ?').get(jobId);
  if (!job) return false;
  if (job.owner_id === userId) return true;
  const access = db.prepare('SELECT 1 FROM job_access WHERE job_id = ? AND user_id = ?').get(jobId, userId);
  return !!access;
}

function canEdit(userId, userRole, jobId) {
  if (userRole === 'admin') return true;
  if (userRole === 'corporate') return false;
  const db = getDb();
  const job = db.prepare('SELECT owner_id FROM jobs WHERE id = ?').get(jobId);
  if (!job) return false;
  if (job.owner_id === userId) return true;
  const access = db.prepare("SELECT access_level FROM job_access WHERE job_id = ? AND user_id = ?").get(jobId, userId);
  return access && access.access_level === 'edit';
}

// GET /api/jobs — list all jobs the user can see
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  let jobs;
  if (req.user.role === 'admin' || req.user.role === 'corporate') {
    jobs = db.prepare('SELECT id, data, owner_id, created_at, updated_at FROM jobs').all();
  } else {
    jobs = db.prepare(`
      SELECT j.id, j.data, j.owner_id, j.created_at, j.updated_at FROM jobs j
      LEFT JOIN job_access ja ON ja.job_id = j.id AND ja.user_id = ?
      WHERE j.owner_id = ? OR ja.user_id IS NOT NULL
    `).all(req.user.id, req.user.id);
  }
  const result = jobs.map(j => {
    const parsed = JSON.parse(j.data);
    return { id: j.id, owner_id: j.owner_id, ...parsed };
  });
  res.json({ jobs: result });
});

// GET /api/jobs/:id
router.get('/:id', requireAuth, (req, res) => {
  if (!canAccess(req.user.id, req.user.role, req.params.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ id: job.id, owner_id: job.owner_id, ...JSON.parse(job.data) });
});

// POST /api/jobs — create a new job
router.post('/', requireAuth, requireRole('admin', 'pm'), (req, res) => {
  const db = getDb();
  const id = req.body.id || 'job' + Date.now();
  const data = JSON.stringify(req.body);
  db.prepare('INSERT INTO jobs (id, owner_id, data) VALUES (?, ?, ?)')
    .run(id, req.user.id, data);
  res.json({ id, ok: true });
});

// PUT /api/jobs/:id — update a job
router.put('/:id', requireAuth, (req, res) => {
  if (!canEdit(req.user.id, req.user.role, req.params.id)) {
    return res.status(403).json({ error: 'No edit access' });
  }
  const db = getDb();
  const data = JSON.stringify(req.body);
  db.prepare("UPDATE jobs SET data = ?, updated_at = datetime('now') WHERE id = ?")
    .run(data, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/jobs/:id (admin only)
router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/jobs/:id/access — grant access to another user (admin or owner)
router.post('/:id/access', requireAuth, (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT owner_id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (req.user.role !== 'admin' && job.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Only owner or admin can manage access' });
  }
  const { userId, accessLevel } = req.body;
  db.prepare('INSERT OR REPLACE INTO job_access (job_id, user_id, access_level) VALUES (?, ?, ?)')
    .run(req.params.id, userId, accessLevel || 'edit');
  res.json({ ok: true });
});

// PUT /api/jobs/bulk/save — save full appData blob (migration helper)
router.put('/bulk/save', requireAuth, requireRole('admin', 'pm'), (req, res) => {
  const db = getDb();
  const { appData } = req.body;
  if (!appData || !appData.jobs) return res.status(400).json({ error: 'Invalid appData' });

  const upsert = db.prepare(`
    INSERT INTO jobs (id, owner_id, data) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = ?, updated_at = datetime('now')
  `);

  const transaction = db.transaction(() => {
    appData.jobs.forEach(job => {
      const jobBlob = {
        ...job,
        buildings: (appData.buildings || []).filter(b => b.jobId === job.id),
        phases: (appData.phases || []).filter(p => p.jobId === job.id),
        changeOrders: (appData.changeOrders || []).filter(c => c.jobId === job.id),
        subs: (appData.subs || []).filter(s => s.jobId === job.id),
        purchaseOrders: (appData.purchaseOrders || []).filter(p => p.jobId === job.id),
        invoices: (appData.invoices || []).filter(i => i.jobId === job.id),
      };
      const data = JSON.stringify(jobBlob);
      upsert.run(job.id, req.user.id, data, data);
    });
  });
  transaction();
  res.json({ ok: true, count: appData.jobs.length });
});

// Node graph routes
router.get('/:id/graph', requireAuth, (req, res) => {
  if (!canAccess(req.user.id, req.user.role, req.params.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const db = getDb();
  const row = db.prepare('SELECT data FROM node_graphs WHERE job_id = ?').get(req.params.id);
  res.json({ graph: row ? JSON.parse(row.data) : null });
});

router.put('/:id/graph', requireAuth, (req, res) => {
  if (!canEdit(req.user.id, req.user.role, req.params.id)) {
    return res.status(403).json({ error: 'No edit access' });
  }
  const db = getDb();
  const data = JSON.stringify(req.body);
  db.prepare(`
    INSERT INTO node_graphs (job_id, data) VALUES (?, ?)
    ON CONFLICT(job_id) DO UPDATE SET data = ?, updated_at = datetime('now')
  `).run(req.params.id, data, data);
  res.json({ ok: true });
});

module.exports = router;
