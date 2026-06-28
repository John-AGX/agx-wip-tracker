// Change Order routes — job-scoped CO records with line items, an
// approval lifecycle, and a hand-off into the nodegraph CO node.
//
// Why a dedicated table (not a JSONB blob inside jobs.data):
//   - We want to query "all approved COs for job X" cheaply during the
//     WIP rollup. Indexed columns beat JSON-path queries here.
//   - The approval lifecycle has its own timestamps (approved_at,
//     approved_by) which belong on the row, not in the blob.
//   - Lines live inside data.lines[] using the same convention as the
//     estimates table — that's deliberate so js/pricing-pipeline.js
//     can read either record shape with a single helper.
//
// Endpoints:
//   GET    /api/jobs/:jobId/change-orders          list COs for a job
//   GET    /api/change-orders/:id                  single CO
//   POST   /api/jobs/:jobId/change-orders          create draft
//   PUT    /api/change-orders/:id                  update title/lines/etc.
//   POST   /api/change-orders/:id/status           transition draft→approved→applied
//   POST   /api/change-orders/:id/link-node        wire to a nodegraph CO node
//   DELETE /api/change-orders/:id                  hard delete (forbidden if 'applied')
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability, hasCapability } = require('../auth');
const { assertEntityInOrg } = require('../org-access');

const router = express.Router();

// Valid status values + allowed transitions. The 'draft → approved →
// applied' progression is one-way; you can drop back to 'draft' only
// from 'approved' (in case the customer wants edits before signing).
// 'applied' is terminal — once a CO has been consumed by the WIP in
// the field, we don't let it move back, only delete (and only by
// admin during the deletion-allowed window).
const STATUS_VALUES = ['draft', 'approved', 'applied'];
const ALLOWED_TRANSITIONS = {
  draft: ['approved'],
  approved: ['draft', 'applied'],
  applied: []
};

// Helper — generate the next CO number for a job. Picks the highest
// numeric suffix on existing 'CO-N' rows and adds 1. We don't worry
// about gaps (deleted COs leave holes) because PMs treat CO-N as a
// label, not a sequence guarantee.
async function nextCoNumber(jobId) {
  const { rows } = await pool.query(
    `SELECT co_number FROM job_change_orders WHERE job_id = $1 AND co_number ~ '^CO-[0-9]+$'`,
    [jobId]
  );
  let maxN = 0;
  for (const r of rows) {
    const n = parseInt(String(r.co_number).slice(3), 10);
    if (!isNaN(n) && n > maxN) maxN = n;
  }
  return 'CO-' + (maxN + 1);
}

// Helper — read a row and shape it into the response object. The
// canonical columns ride alongside the data blob; we spread data
// first so any stray field inside the blob (e.g. an accidental
// updated_at copy) can't shadow the real column value.
function shapeRow(r) {
  return {
    ...(r.data || {}),
    id: r.id,
    job_id: r.job_id,
    owner_id: r.owner_id,
    status: r.status,
    co_number: r.co_number,
    approved_at: r.approved_at,
    approved_by: r.approved_by,
    linked_node_id: r.linked_node_id,
    is_locked: !!r.is_locked,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

// GET /api/jobs/:jobId/change-orders
router.get('/jobs/:jobId/change-orders', requireAuth, async (req, res) => {
  try {
    // Wave A (A3): the job must belong to the caller's org. assertEntityInOrg
    // uses the owner->org join with OR-IS-NULL tolerance (no-op for AGX).
    const inOrg = await assertEntityInOrg('job', req.params.jobId, req.user.organization_id);
    if (!inOrg) return res.json({ change_orders: [] });
    const { rows } = await pool.query(
      `SELECT id, job_id, owner_id, status, co_number, data, approved_at,
              approved_by, linked_node_id, is_locked, created_at, updated_at
       FROM job_change_orders
       WHERE job_id = $1
       ORDER BY updated_at DESC`,
      [req.params.jobId]
    );
    res.json({ change_orders: rows.map(shapeRow) });
  } catch (e) {
    console.error('GET /api/jobs/:jobId/change-orders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/change-orders/summary — org-wide rollup for the Summary
// page attention card. Counts open COs (status='draft' or 'approved')
// and rough total dollar value across all active jobs. Org-scoped via
// the job join's organization_id filter (Wave 1.A).
router.get('/change-orders/summary', requireAuth, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE co.status = 'draft')::int     AS draft_count,
        COUNT(*) FILTER (WHERE co.status = 'approved')::int  AS approved_count,
        COUNT(*) FILTER (WHERE co.status IN ('draft', 'approved'))::int AS open_count
      FROM job_change_orders co
      JOIN jobs j ON j.id = co.job_id
      WHERE (j.organization_id = $1 OR j.organization_id IS NULL)
    `, [orgId]);
    res.json(r.rows[0] || { draft_count: 0, approved_count: 0, open_count: 0 });
  } catch (err) {
    console.error('GET /api/change-orders/summary error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/change-orders — cross-job org-wide list for the Jobs hub.
// Query: ?status=open|all|draft|approved|applied, ?job=<jobId>, ?limit=
//   open (default) = draft OR approved (still in play; not yet applied).
// Joins jobs for a display label (job_number / job_title). Org-scoped via
// the same jobs.organization_id filter the /summary route uses.
router.get('/change-orders', requireAuth, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const where = ['(j.organization_id = $1 OR j.organization_id IS NULL)'];
    const params = [orgId];
    let pn = 2;
    const statusQ = String(req.query.status || 'open').toLowerCase();
    if (req.query.job) { where.push('co.job_id = $' + (pn++)); params.push(String(req.query.job)); }
    if (statusQ === 'open') {
      where.push("co.status IN ('draft', 'approved')");
    } else if (statusQ && statusQ !== 'all' && STATUS_VALUES.includes(statusQ)) {
      where.push('co.status = $' + (pn++)); params.push(statusQ);
    }
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const { rows } = await pool.query(
      `SELECT co.id, co.job_id, co.owner_id, co.status, co.co_number, co.data,
              co.approved_at, co.approved_by, co.linked_node_id, co.is_locked,
              co.created_at, co.updated_at,
              j.data->>'jobNumber' AS job_number,
              j.data->>'title'     AS job_title
         FROM job_change_orders co
         JOIN jobs j ON j.id = co.job_id
        WHERE ${where.join(' AND ')}
        ORDER BY co.updated_at DESC
        LIMIT ${limit}`,
      params
    );
    res.json({
      change_orders: rows.map(r => Object.assign(shapeRow(r), {
        job_number: r.job_number, job_title: r.job_title
      }))
    });
  } catch (e) {
    console.error('GET /api/change-orders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/change-orders/:id
router.get('/change-orders/:id', requireAuth, async (req, res) => {
  try {
    // Org-scoped: resolve the CO through its job so a CO outside the
    // caller's org reads as 404 (no cross-tenant read by guessed id).
    const { rows } = await pool.query(
      `SELECT co.id, co.job_id, co.owner_id, co.status, co.co_number, co.data,
              co.approved_at, co.approved_by, co.linked_node_id, co.is_locked,
              co.created_at, co.updated_at
         FROM job_change_orders co
         JOIN jobs j ON j.id = co.job_id
        WHERE co.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ change_order: shapeRow(rows[0]) });
  } catch (e) {
    console.error('GET /api/change-orders/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/jobs/:jobId/change-orders — create draft.
// Body: { title?, scope?, lines?, targetMargin?, defaultMarkup?, feeFlat?,
//         feePct?, taxPct?, roundTo?, co_number? }
// The id is generated server-side so the client can fire-and-paint with
// the response.
router.post('/jobs/:jobId/change-orders', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const jobId = req.params.jobId;
    // Confirm the job exists AND belongs to the caller's org — a 404 is
    // clearer than the generic 500 the FK violation would produce, and the
    // org filter blocks creating a CO against another tenant's job.
    const job = await pool.query(
      'SELECT id FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [jobId, req.user.organization_id]
    );
    if (!job.rowCount) return res.status(404).json({ error: 'Job not found' });

    const id = 'co_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const coNumber = req.body.co_number || await nextCoNumber(jobId);

    // Build the data blob from the body, stripping any canonical
    // column fields that don't belong inside it.
    const data = { ...req.body };
    delete data.id;
    delete data.job_id;
    delete data.owner_id;
    delete data.status;
    delete data.co_number;
    delete data.approved_at;
    delete data.approved_by;
    delete data.linked_node_id;
    delete data.created_at;
    delete data.updated_at;
    // Ensure a lines[] array always exists so downstream readers can
    // safely .map / .filter without null-guards.
    if (!Array.isArray(data.lines)) data.lines = [];

    const { rows } = await pool.query(
      `INSERT INTO job_change_orders
         (id, job_id, owner_id, status, co_number, data)
       VALUES ($1, $2, $3, 'draft', $4, $5)
       RETURNING id, job_id, owner_id, status, co_number, data, approved_at,
                 approved_by, linked_node_id, is_locked, created_at, updated_at`,
      [id, jobId, req.user.id, coNumber, JSON.stringify(data)]
    );
    res.json({ change_order: shapeRow(rows[0]) });
  } catch (e) {
    console.error('POST /api/jobs/:jobId/change-orders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/change-orders/:id — update editable fields. Status, link,
// and approval columns are NOT updatable here; use the dedicated
// status / link-node endpoints so the lifecycle stays auditable.
router.put('/change-orders/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = req.params.id;
    // Org-scoped: a CO outside the caller's org reads as 404 (no
    // cross-tenant edit by guessed id).
    const existing = await pool.query(
      `SELECT co.status, co.is_locked FROM job_change_orders co
         JOIN jobs j ON j.id = co.job_id
        WHERE co.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [id, req.user.organization_id]
    );
    if (!existing.rowCount) return res.status(404).json({ error: 'Not found' });
    // Applied COs are immutable on the data side — they've already
    // fed the WIP and changing the lines would create reporting drift.
    if (existing.rows[0].status === 'applied') {
      return res.status(409).json({ error: 'Cannot edit an applied change order' });
    }
    // Approved COs are locked (committed scope change). An admin can clear the
    // lock via PUT /api/change-orders/:id/lock (or revert it to draft) to edit.
    if (existing.rows[0].is_locked) {
      return res.status(409).json({ error: 'Cannot edit an approved (locked) change order. Unlock it to edit.' });
    }

    const data = { ...req.body };
    delete data.id;
    delete data.job_id;
    delete data.owner_id;
    delete data.status;
    delete data.co_number;
    delete data.approved_at;
    delete data.approved_by;
    delete data.linked_node_id;
    delete data.created_at;
    delete data.updated_at;
    if (!Array.isArray(data.lines)) data.lines = [];

    // IS DISTINCT FROM keeps updated_at stable when nothing actually
    // changed — same trick estimate-routes.js uses to keep the
    // "Updated" column honest in the list view.
    const { rows } = await pool.query(
      `UPDATE job_change_orders
       SET data = $1::jsonb,
           updated_at = CASE
             WHEN data IS DISTINCT FROM $1::jsonb THEN NOW()
             ELSE updated_at
           END
       WHERE id = $2
       RETURNING id, job_id, owner_id, status, co_number, data, approved_at,
                 approved_by, linked_node_id, is_locked, created_at, updated_at`,
      [JSON.stringify(data), id]
    );
    res.json({ change_order: shapeRow(rows[0]) });
  } catch (e) {
    console.error('PUT /api/change-orders/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/change-orders/:id/status — transition draft↔approved→applied.
// On flip to 'approved', if linked_node_id is set we copy the CO's
// lines into that node's items[] so the existing wire-allocation +
// WIP rollup picks them up. The push is best-effort — if the linked
// node has gone missing (rare; node deleted between link + approve),
// we still flip the status so the PM can re-link.
router.post('/change-orders/:id/status', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const next = String(req.body.status || '').toLowerCase();
    if (!STATUS_VALUES.includes(next)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    // Wave A (A4): resolve the CO through its job's owner -> org so a CO outside
    // the caller's org reads as "not found". OR-IS-NULL (org tolerance) = no-op
    // for AGX today.
    const { rows } = await pool.query(
      `SELECT co.status, co.job_id, co.linked_node_id, co.data
         FROM job_change_orders co
         JOIN jobs j ON j.id = co.job_id
         JOIN users u ON u.id = j.owner_id
        WHERE co.id = $1 AND (u.organization_id = $2 OR u.organization_id IS NULL)`,
      [id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const current = rows[0].status;
    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      return res.status(409).json({ error: 'Transition not allowed: ' + current + ' → ' + next });
    }

    // Approval gate — the plan calls for JOBS_EDIT_ANY OR ownership.
    // Treat 'admin' / 'corporate' role as JOBS_EDIT_ANY and otherwise
    // require the user to own the job (job.owner_id check).
    if (next === 'approved' || next === 'applied') {
      const role = req.user.role || '';
      // Wave B (B1): the JWT carries no `capabilities` array — that check was
      // always false (wrongly blocked a non-owner PM holding JOBS_EDIT_ANY).
      // Use the role-cache helper, the way the rest of the app checks caps.
      const isPrivileged = hasCapability(req.user, 'JOBS_EDIT_ANY')
                          || role === 'admin' || role === 'corporate';
      if (!isPrivileged) {
        const ownerCheck = await pool.query('SELECT owner_id FROM jobs WHERE id = $1', [rows[0].job_id]);
        const ownsJob = ownerCheck.rowCount && ownerCheck.rows[0].owner_id === req.user.id;
        if (!ownsJob) return res.status(403).json({ error: 'Not allowed to approve this CO' });
      }
    }

    // If we're approving and there's a linked node, push the CO's
    // lines into that node's items[]. The nodegraph stores its state
    // in node_graphs.data JSONB (one row per job); we mutate the
    // specific node's items in-place and write it back inside the
    // same transaction as the status flip so a failure rolls both
    // back together.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let approvedAt = null;
      let approvedBy = null;
      // Approved/applied COs lock (committed scope change → read-only). Reverting
      // to draft (customer wants edits before signing) clears the lock.
      const lockState = (next === 'approved' || next === 'applied');
      if (next === 'approved') {
        approvedAt = new Date();
        approvedBy = req.user.id;

        if (rows[0].linked_node_id) {
          const graph = await client.query(
            'SELECT data FROM node_graphs WHERE job_id = $1',
            [rows[0].job_id]
          );
          if (graph.rowCount) {
            const g = graph.rows[0].data || {};
            const nodes = Array.isArray(g.nodes) ? g.nodes : [];
            const node = nodes.find(n => n.id === rows[0].linked_node_id);
            if (node) {
              const lines = ((rows[0].data || {}).lines) || [];
              // Map CO lines → CO node items (itemType:'co' uses {amount}).
              // Skip section-header rows (they're scope organizers, not
              // costable units). Each line's marked-up extension becomes
              // one item amount so the node's downstream wires carry the
              // customer-facing price, not the bare cost.
              node.items = lines
                .filter(l => l.section !== '__section_header__')
                .map(l => {
                  const qty = parseFloat(l.qty) || 0;
                  const unit = parseFloat(l.unitCost) || 0;
                  const m = parseFloat(l.markup) || 0;
                  const ext = qty * unit;
                  const marked = ext * (1 + m / 100);
                  return {
                    id: l.id || ('item_' + Math.random().toString(36).slice(2, 8)),
                    description: l.description || '',
                    amount: marked
                  };
                });
              await client.query(
                'UPDATE node_graphs SET data = $1::jsonb, updated_at = NOW() WHERE job_id = $2',
                [JSON.stringify(g), rows[0].job_id]
              );
            }
          }
        }
      }

      const upd = await client.query(
        `UPDATE job_change_orders
         SET status = $1,
             is_locked = $5,
             approved_at = COALESCE($2, approved_at),
             approved_by = COALESCE($3, approved_by),
             updated_at = NOW()
         WHERE id = $4
         RETURNING id, job_id, owner_id, status, co_number, data, approved_at,
                   approved_by, linked_node_id, is_locked, created_at, updated_at`,
        [next, approvedAt, approvedBy, id, lockState]
      );
      await client.query('COMMIT');
      res.json({ change_order: shapeRow(upd.rows[0]) });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('POST /api/change-orders/:id/status error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/change-orders/:id/lock — set/clear the lock. COs lock automatically
// on approval (committed scope change → read-only); this lets an admin re-open
// one for corrections without reverting the approval. Gated on ESTIMATES_EDIT,
// the same capability that governs CO create/edit.
router.put('/change-orders/:id/lock', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const locked = !!(req.body && req.body.locked);
    // Org-scoped existence check through the job join (no cross-tenant lock by id).
    const chk = await pool.query(
      `SELECT co.id FROM job_change_orders co
         JOIN jobs j ON j.id = co.job_id
        WHERE co.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]
    );
    if (!chk.rowCount) return res.status(404).json({ error: 'Change order not found' });
    await pool.query(
      'UPDATE job_change_orders SET is_locked = $1, updated_at = NOW() WHERE id = $2',
      [locked, req.params.id]
    );
    res.json({ ok: true, is_locked: locked });
  } catch (e) {
    console.error('PUT /api/change-orders/:id/lock error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/change-orders/:id/link-node — wire CO to a nodegraph CO node.
// Body: { node_id }. The node must exist in the job's graph and be of
// type 'co'. Pass node_id: null to unlink.
router.post('/change-orders/:id/link-node', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = req.params.id;
    const nodeId = req.body.node_id || null;
    // Org-scoped resolve so a CO outside the caller's org reads as 404.
    const { rows } = await pool.query(
      `SELECT co.job_id FROM job_change_orders co
         JOIN jobs j ON j.id = co.job_id
        WHERE co.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    if (nodeId) {
      const graph = await pool.query(
        'SELECT data FROM node_graphs WHERE job_id = $1',
        [rows[0].job_id]
      );
      if (!graph.rowCount) return res.status(400).json({ error: 'Job has no nodegraph yet' });
      const nodes = ((graph.rows[0].data || {}).nodes) || [];
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return res.status(404).json({ error: 'Node not found in job graph' });
      if (node.type !== 'co') return res.status(400).json({ error: 'Linked node must be a Change Order node' });
    }

    const upd = await pool.query(
      `UPDATE job_change_orders
       SET linked_node_id = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, job_id, owner_id, status, co_number, data, approved_at,
                 approved_by, linked_node_id, is_locked, created_at, updated_at`,
      [nodeId, id]
    );
    res.json({ change_order: shapeRow(upd.rows[0]) });
  } catch (e) {
    console.error('POST /api/change-orders/:id/link-node error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/change-orders/:id — admin or owner. Applied COs are
// blocked because their lines are already in the WIP — deleting
// would silently drop revenue from the rollup.
router.delete('/change-orders/:id', requireAuth, async (req, res) => {
  try {
    // Org-scoped: resolve through the job so a CO outside the caller's org
    // reads as 404 before the owner/admin permission check runs.
    const { rows } = await pool.query(
      `SELECT co.owner_id, co.status FROM job_change_orders co
         JOIN jobs j ON j.id = co.job_id
        WHERE co.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'No delete access' });
    }
    if (rows[0].status === 'applied') {
      return res.status(409).json({ error: 'Cannot delete an applied change order' });
    }
    await pool.query('DELETE FROM job_change_orders WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/change-orders/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
