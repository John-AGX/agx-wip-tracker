const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { sendEmail } = require('../email');
const { jobAssigned } = require('../email-templates');

const router = express.Router();

// Fire a job-assigned email to the new owner. Fire-and-forget; respects
// the user's notification_prefs.job_assignment opt-out.
async function maybeNotifyJobAssigned({ ownerId, job, action, fromUserName }) {
  try {
    const { rows } = await pool.query(
      'SELECT email, name, notification_prefs FROM users WHERE id = $1 AND active = TRUE',
      [ownerId]
    );
    if (!rows.length) return;
    const u = rows[0];
    const prefs = u.notification_prefs || {};
    if (prefs.job_assignment === false) return;
    if (!u.email) return;
    const tpl = jobAssigned({
      recipientName: u.name,
      job: job,
      assignedBy: fromUserName || 'An admin',
      action: action || 'assigned'
    });
    sendEmail({
      to: u.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: 'job_assignment'
    }).catch((e) => console.warn('[jobs] notify email failed:', e && e.message));
  } catch (e) {
    console.warn('[jobs] notify lookup failed:', e && e.message);
  }
}

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

// Looser gate for the node-graph layout. The graph is a shared
// visualization — position dragging, node creation, and wire edits
// affect what the team sees on screen but are tracked separately
// from the financial source-of-truth (jobs.data, phases, etc.). Any
// PM-tier user who can VIEW the job should be able to contribute
// layout changes; otherwise non-owner PMs silently dropped their
// drags into localStorage and other users kept seeing the owner's
// original layout. Corporate role stays read-only by company policy.
async function canEditGraph(userId, userRole, jobId) {
  if (userRole === 'corporate') return false;
  return canAccess(userId, userRole, jobId);
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
      // Spread `data` FIRST so canonical column values (id, owner_id)
      // override any stale copies that may have crept into the JSONB
      // blob via a prior bulk-save round-trip. owner_id specifically
      // is mutable via PUT /:id/owner, so the column is the truth.
      return { ...j.data, id: j.id, owner_id: j.owner_id, _canEdit: canEdit };
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
    // Same shape rule as the list endpoint: spread the JSONB first so
    // the canonical column values override anything stale in the blob.
    res.json({ ...rows[0].data, id: rows[0].id, owner_id: rows[0].owner_id });
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

    // Notify the new owner if the saving client opted in. Skip when
    // the owner == the creator (you don't need an email saying "you
    // assigned a job to yourself").
    if (req.body.notify === true && ownerId !== req.user.id) {
      maybeNotifyJobAssigned({
        ownerId: ownerId,
        job: Object.assign({ id: id }, req.body),
        action: 'assigned',
        fromUserName: req.user && req.user.name
      });
    }

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

// PUT /api/jobs/:id/owner — reassign job to a different PM/admin (admin only)
// Existing job_access entries are kept intact, so anyone who had explicit
// edit/view access still has it after a reassignment. The previous owner
// loses their implicit ownership; if you want them to keep access, add them
// as a share separately.
router.put('/:id/owner', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { ownerId } = req.body;
    if (!ownerId) return res.status(400).json({ error: 'ownerId required' });
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1 AND active = true', [ownerId]);
    if (!userCheck.rows.length) return res.status(400).json({ error: 'Invalid or inactive user' });
    const jobCheck = await pool.query('SELECT id, owner_id, data FROM jobs WHERE id = $1', [req.params.id]);
    if (!jobCheck.rows.length) return res.status(404).json({ error: 'Job not found' });
    const priorOwnerId = jobCheck.rows[0].owner_id;
    await pool.query(
      'UPDATE jobs SET owner_id = $1, updated_at = NOW() WHERE id = $2',
      [ownerId, req.params.id]
    );

    // Notify the new owner of the reassignment when the client opted
    // in. No-op when the owner didn't actually change.
    if (req.body.notify === true && Number(priorOwnerId) !== Number(ownerId) && Number(ownerId) !== req.user.id) {
      const jobData = jobCheck.rows[0].data || {};
      maybeNotifyJobAssigned({
        ownerId: ownerId,
        job: Object.assign({ id: req.params.id }, jobData),
        action: 'reassigned',
        fromUserName: req.user && req.user.name
      });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/jobs/:id/owner error:', e);
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

// Helper: only admin or job owner can manage access for a given job.
async function canManageAccess(req, jobId) {
  if (req.user.role === 'admin') return true;
  const { rows } = await pool.query('SELECT owner_id FROM jobs WHERE id = $1', [jobId]);
  if (!rows.length) return null; // job not found
  return rows[0].owner_id === req.user.id;
}

// GET /api/jobs/:id/access — list users with explicit access plus the owner
router.get('/:id/access', requireAuth, async (req, res) => {
  try {
    if (!(await canAccess(req.user.id, req.user.role, req.params.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows: jobRows } = await pool.query(
      'SELECT owner_id FROM jobs WHERE id = $1', [req.params.id]
    );
    if (!jobRows.length) return res.status(404).json({ error: 'Job not found' });
    const { rows: shares } = await pool.query(`
      SELECT ja.user_id, ja.access_level, u.name, u.email, u.role
      FROM job_access ja
      JOIN users u ON u.id = ja.user_id
      WHERE ja.job_id = $1
      ORDER BY u.name
    `, [req.params.id]);
    res.json({ owner_id: jobRows[0].owner_id, shares });
  } catch (e) {
    console.error('GET /api/jobs/:id/access error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/jobs/:id/access — grant or update a user's access to a job
router.post('/:id/access', requireAuth, async (req, res) => {
  try {
    const ok = await canManageAccess(req, req.params.id);
    if (ok === null) return res.status(404).json({ error: 'Job not found' });
    if (!ok) return res.status(403).json({ error: 'Only owner or admin can manage access' });

    const { userId, accessLevel } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const level = accessLevel === 'view' ? 'view' : 'edit';
    await pool.query(
      'INSERT INTO job_access (job_id, user_id, access_level) VALUES ($1, $2, $3) ON CONFLICT (job_id, user_id) DO UPDATE SET access_level = $3',
      [req.params.id, userId, level]);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/jobs/:id/access error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/jobs/:id/access/:userId — revoke a user's access
router.delete('/:id/access/:userId', requireAuth, async (req, res) => {
  try {
    const ok = await canManageAccess(req, req.params.id);
    if (ok === null) return res.status(404).json({ error: 'Job not found' });
    if (!ok) return res.status(403).json({ error: 'Only owner or admin can manage access' });

    await pool.query(
      'DELETE FROM job_access WHERE job_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/jobs/:id/access/:userId error:', e);
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
        // Strip server-injected hints + per-save flags that shouldn't
        // round-trip back into the blob. owner_id is also stripped —
        // it lives on the canonical column (changes via PUT /:id/owner)
        // and a stale copy in the JSONB would shadow the column on the
        // next GET (see the spread order in router.get('/')).
        delete jobBlob._canEdit;
        delete jobBlob._notify;
        delete jobBlob.owner_id;
        // For new jobs, admins can specify owner_id to assign a PM. Non-admins
        // (PMs creating their own jobs) always own what they create. ON CONFLICT
        // never touches owner_id, so existing jobs keep their original PM.
        const ownerId = (req.user.role === 'admin' && job.owner_id) ? job.owner_id : req.user.id;
        const isNewJob = !existing.rows.length;
        const priorOwnerId = isNewJob ? null : existing.rows[0].owner_id;
        await client.query(
          `INSERT INTO jobs (id, owner_id, data) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET data = $3, updated_at = NOW()`,
          [job.id, ownerId, JSON.stringify(jobBlob)]
        );
        // Notify the owner when the saving client opted in via the
        // _notify flag on this specific job. Only fires on creation
        // OR explicit reassignment — silent for routine field edits.
        if (job._notify === true && Number(ownerId) !== Number(req.user.id)) {
          if (isNewJob) {
            maybeNotifyJobAssigned({
              ownerId: ownerId,
              job: jobBlob,
              action: 'assigned',
              fromUserName: req.user && req.user.name
            });
          } else if (Number(priorOwnerId) !== Number(ownerId)) {
            maybeNotifyJobAssigned({
              ownerId: ownerId,
              job: jobBlob,
              action: 'reassigned',
              fromUserName: req.user && req.user.name
            });
          }
        }
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
    // canEditGraph (vs canEdit) — graph layout is shared
    // collaborative state. Any non-corporate user who can view the
    // job can save it. Fixes the bug where non-owner PMs dragged
    // nodes locally but their positions never reached the cloud
    // because canEdit's job_access edit-tier check rejected them.
    if (!(await canEditGraph(req.user.id, req.user.role, req.params.id))) {
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
