// QB cost lines — imported from the weekly Detailed Job Cost xlsx
// export. The line id is a content-derived hash, so re-imports of the
// same QB row update in place rather than creating duplicates. That
// makes imports idempotent across devices, re-runs, and accidental
// double-clicks.
//
// Import flow (Phase 2):
//   1. Client parses the xlsx (job-costs-import.js, unchanged)
//   2. Client POSTs the parsed line array here
//   3. Server hashes each line's identity, upserts via INSERT ON
//      CONFLICT (id) DO UPDATE
//   4. Server returns counts (inserted / updated / skipped)
//
// linked_node_id is the integration point with the node graph — set
// by the user (Phase 2 UI) or the AI assistant (Phase 3) to attach
// a line to a specific cost node.

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

console.log('[qb-cost-routes] mounted at /api/qb-costs (Phase 2 — DB-backed cost lines)');

// ──────────────────────────────────────────────────────────────────
// Stable content-hash id. Same logical QB row → same id forever.
// Includes job_id so the same vendor invoice landing on two
// different jobs gets two distinct rows.
// ──────────────────────────────────────────────────────────────────
function hashLineId(jobId, line) {
  const parts = [
    String(jobId || ''),
    String(line.vendor || '').trim().toLowerCase(),
    String(line.date || '').trim(),
    String(line.txnType || '').trim().toLowerCase(),
    String(line.num || '').trim(),
    String(line.account || '').trim(),
    String(line.memo || '').trim(),
    Number(line.amount || 0).toFixed(2)
  ];
  const h = crypto.createHash('sha256');
  h.update(parts.join('␟')); // unit-separator char so legitimate "|" in memos doesn't collide
  return 'qbc_' + h.digest('hex').slice(0, 16);
}

// Convert ISO/parser dates to a Postgres-friendly value or null.
function normDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // QB exports often use MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    let yr = m[3];
    if (yr.length === 2) yr = (parseInt(yr, 10) > 50 ? '19' : '20') + yr;
    const mm = m[1].padStart(2, '0');
    const dd = m[2].padStart(2, '0');
    return `${yr}-${mm}-${dd}`;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// POST /api/qb-costs/import
// Body: { reportDate, sourceFile, jobs: [{ jobId, lines: [...] }] }
// Each line: { vendor, date, txnType, num, account, accountType,
//              klass, memo, amount }
// ──────────────────────────────────────────────────────────────────
router.post('/import',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    const { reportDate, sourceFile, jobs } = req.body || {};
    if (!Array.isArray(jobs)) {
      return res.status(400).json({ error: 'jobs array required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const stats = { inserted: 0, updated: 0, skipped: 0, byJob: {} };
      const reportDateNorm = normDate(reportDate);

      for (const j of jobs) {
        if (!j || !j.jobId || !Array.isArray(j.lines)) {
          stats.skipped += (j && Array.isArray(j.lines) ? j.lines.length : 0);
          continue;
        }
        // Verify the job exists. Skipping silently is friendlier than
        // throwing on a stale jobId.
        const jobCheck = await client.query('SELECT 1 FROM jobs WHERE id = $1', [j.jobId]);
        if (!jobCheck.rows.length) {
          stats.skipped += j.lines.length;
          stats.byJob[j.jobId] = { skipped: j.lines.length, reason: 'job not found' };
          continue;
        }

        const jobStats = { inserted: 0, updated: 0 };

        for (const line of j.lines) {
          const id = hashLineId(j.jobId, line);
          const txnDate = normDate(line.date);
          const amount = Number(line.amount || 0);

          // ON CONFLICT update — but only the mutable fields (memo etc.
          // can change between exports if the user edits in QB). Keep
          // imported_at fresh so we know it was seen this round.
          const result = await client.query(
            `INSERT INTO qb_cost_lines (
               id, job_id, vendor, txn_date, txn_type, num,
               account, account_type, klass, memo, amount,
               raw_data, source_file, report_date, imported_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()
             )
             ON CONFLICT (id) DO UPDATE SET
               vendor = EXCLUDED.vendor,
               txn_date = EXCLUDED.txn_date,
               txn_type = EXCLUDED.txn_type,
               num = EXCLUDED.num,
               account = EXCLUDED.account,
               account_type = EXCLUDED.account_type,
               klass = EXCLUDED.klass,
               memo = EXCLUDED.memo,
               amount = EXCLUDED.amount,
               raw_data = EXCLUDED.raw_data,
               source_file = EXCLUDED.source_file,
               report_date = EXCLUDED.report_date,
               imported_at = NOW(),
               updated_at = NOW()
             RETURNING (xmax = 0) AS inserted`,
            [
              id, j.jobId,
              line.vendor || null,
              txnDate,
              line.txnType || null,
              line.num || null,
              line.account || null,
              line.accountType || null,
              line.klass || null,
              line.memo || null,
              amount,
              line, // store full payload for forward-compat
              sourceFile || null,
              reportDateNorm
            ]
          );
          if (result.rows[0]?.inserted) {
            jobStats.inserted++;
            stats.inserted++;
          } else {
            jobStats.updated++;
            stats.updated++;
          }
        }
        stats.byJob[j.jobId] = jobStats;
      }

      await client.query('COMMIT');
      res.json({ ok: true, ...stats });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('POST /api/qb-costs/import error:', e);
      res.status(500).json({ error: e.message || 'Server error' });
    } finally {
      client.release();
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// GET /api/qb-costs?jobId=...   (or no jobId for all the user's jobs)
// Returns lines ordered by date desc, amount desc.
// ──────────────────────────────────────────────────────────────────
router.get('/',
  requireAuth, requireCapability('FINANCIALS_VIEW'),
  async (req, res) => {
    try {
      const { jobId } = req.query;
      let rows;
      if (jobId) {
        const r = await pool.query(
          `SELECT * FROM qb_cost_lines WHERE job_id = $1
           ORDER BY txn_date DESC NULLS LAST, amount DESC`,
          [jobId]
        );
        rows = r.rows;
      } else {
        const r = await pool.query(
          `SELECT * FROM qb_cost_lines
           ORDER BY txn_date DESC NULLS LAST, amount DESC LIMIT 5000`
        );
        rows = r.rows;
      }
      res.json({ lines: rows });
    } catch (e) {
      console.error('GET /api/qb-costs error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// PATCH /api/qb-costs/:id
// Currently used to set/clear linked_node_id. Other mutable fields
// (memo override) can be added if needed.
// ──────────────────────────────────────────────────────────────────
router.patch('/:id',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const { linkedNodeId, memo } = req.body || {};
      const sets = [];
      const vals = [];
      let i = 1;
      if (linkedNodeId !== undefined) {
        sets.push(`linked_node_id = $${i++}`);
        vals.push(linkedNodeId || null);
      }
      if (memo !== undefined) {
        sets.push(`memo = $${i++}`);
        vals.push(memo || null);
      }
      if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
      sets.push(`updated_at = NOW()`);
      vals.push(req.params.id);
      const result = await pool.query(
        `UPDATE qb_cost_lines SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        vals
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Line not found' });
      res.json({ line: result.rows[0] });
    } catch (e) {
      console.error('PATCH /api/qb-costs/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// POST /api/qb-costs/bulk-link
// Body: { ids: [...], linkedNodeId: 'n38' | null }
// Atomically applies one linked_node_id (or nulls it) to every line
// in `ids` that the user can edit. Returns the updated count.
// ──────────────────────────────────────────────────────────────────
router.post('/bulk-link',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const { ids, linkedNodeId } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'ids array is required' });
      }
      // Cap to a reasonable batch — 1000 is generous for a weekly
      // QB import (~500-800 lines is typical).
      if (ids.length > 1000) {
        return res.status(400).json({ error: 'bulk-link cap is 1000 lines per call' });
      }
      const target = linkedNodeId || null;
      const result = await pool.query(
        `UPDATE qb_cost_lines
            SET linked_node_id = $1, updated_at = NOW()
          WHERE id = ANY($2::text[])
          RETURNING id`,
        [target, ids]
      );
      res.json({ ok: true, updated: result.rowCount });
    } catch (e) {
      console.error('POST /api/qb-costs/bulk-link error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// POST /api/qb-costs/cleanup-orphans
// Body: { jobId, validNodeIds: [...] }
// Nulls out linked_node_id on any qb_cost_lines row for this job
// whose target node is no longer in the graph. Returns the count of
// fixed-up rows. Run-on-demand from the QB Costs view; can also be
// auto-fired after node deletion if we want to keep the data clean.
// ──────────────────────────────────────────────────────────────────
router.post('/cleanup-orphans',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const { jobId, validNodeIds } = req.body || {};
      if (!jobId) return res.status(400).json({ error: 'jobId is required' });
      if (!Array.isArray(validNodeIds)) {
        return res.status(400).json({ error: 'validNodeIds array is required' });
      }
      // Empty validNodeIds is legal — means "clear every link on
      // this job" (e.g. graph was deleted). pg array literal needs
      // at least one element; pass a sentinel that won't match real
      // node ids.
      const validList = validNodeIds.length ? validNodeIds : ['__no_nodes__'];
      const result = await pool.query(
        `UPDATE qb_cost_lines
            SET linked_node_id = NULL, updated_at = NOW()
          WHERE job_id = $1
            AND linked_node_id IS NOT NULL
            AND NOT (linked_node_id = ANY($2::text[]))
          RETURNING id`,
        [jobId, validList]
      );
      res.json({ ok: true, cleared: result.rowCount });
    } catch (e) {
      console.error('POST /api/qb-costs/cleanup-orphans error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// DELETE /api/qb-costs/:id   — manual cleanup
// ──────────────────────────────────────────────────────────────────
router.delete('/:id',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const r = await pool.query('DELETE FROM qb_cost_lines WHERE id = $1', [req.params.id]);
      res.json({ ok: true, deleted: r.rowCount });
    } catch (e) {
      console.error('DELETE /api/qb-costs/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
