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
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const { hashLineId, staleZeroLineId } = require('../util/qb-line-id');

const router = express.Router();

console.log('[qb-cost-routes] mounted at /api/qb-costs (Phase 2 — DB-backed cost lines)');

// ──────────────────────────────────────────────────────────────────
// hashLineId / staleZeroLineId now live in ../util/qb-line-id so they
// can be unit-tested without booting the DB pool + auth. The hash is
// unchanged — every existing qb_cost_lines row is keyed by it.
// ──────────────────────────────────────────────────────────────────

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

      // `received` and `rejected` exist because the client used to have no
      // way to tell "wrote 224 rows" from "wrote nothing" — the whole
      // 08.13.26 import failure was invisible for three weeks. A count of
      // what arrived, plus a REASON for every row that did not land, is
      // what makes the importer's result screen trustworthy.
      const stats = {
        received: jobs.reduce((n, j) => n + (j && Array.isArray(j.lines) ? j.lines.length : 0), 0),
        inserted: 0, updated: 0, skipped: 0, cleaned: 0,
        rejected: [], byJob: {}
      };
      const reject = (jobId, lines, reason) => {
        stats.skipped += lines;
        stats.rejected.push({ jobId: jobId || null, lines, reason });
      };
      const reportDateNorm = normDate(reportDate);

      for (const j of jobs) {
        if (!j || !j.jobId || !Array.isArray(j.lines)) {
          reject(j && j.jobId, (j && Array.isArray(j.lines) ? j.lines.length : 0),
            'malformed batch entry — missing jobId or lines array');
          continue;
        }
        // Verify the job exists. Skipping silently is friendlier than
        // throwing on a stale jobId.
        const jobCheck = await client.query('SELECT 1 FROM jobs WHERE id = $1', [j.jobId]);
        if (!jobCheck.rows.length) {
          reject(j.jobId, j.lines.length,
            'no job with this id exists — it was deleted, or the browser is holding a stale copy of the jobs list');
          stats.byJob[j.jobId] = { inserted: 0, updated: 0, skipped: j.lines.length, reason: 'job not found' };
          continue;
        }

        const jobStats = { inserted: 0, updated: 0, skipped: 0 };

        for (const line of j.lines) {
          // Pre-flight, before the row can reach NUMERIC(12,2). A non-finite
          // amount stores as NaN in Postgres and silently poisons every
          // rollup that sums this job. Reject it by name instead — the
          // batch stays atomic because nothing here touches the write.
          if (!line || typeof line !== 'object') {
            jobStats.skipped++;
            reject(j.jobId, 1, 'line is not an object');
            continue;
          }
          // Exactly the expression the INSERT uses, so this rejects only
          // values that would actually be written as NaN — a missing or
          // empty amount still coerces to 0.00 the way it always has.
          const amount = Number(line.amount || 0);
          if (!Number.isFinite(amount)) {
            jobStats.skipped++;
            reject(j.jobId, 1,
              'amount is not a number (' + JSON.stringify(line.amount) + ') — vendor ' +
              JSON.stringify(line.vendor || '') + ', ' + JSON.stringify(line.date || ''));
            continue;
          }

          const id = hashLineId(j.jobId, line);
          const txnDate = normDate(line.date);

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

          // Retire the row the pre-fix parser wrote for this same credit.
          // Credits used to import as $0.00 (QB writes negatives in
          // accounting parentheses, which the old client toNumber() read as
          // NaN → 0). Amount is part of the id, so that old row has a
          // different hash than the corrected one we just wrote and the
          // upsert above cannot reach it — it would sit there forever as a
          // phantom $0.00 line beside the real credit. Money was never
          // wrong (a $0 row adds nothing); the line list was.
          //
          // Scoped hard: same job, the exact superseded hash, and amount 0.
          // Self-limiting — once a job is cleaned there is nothing left to
          // match on later imports.
          if (amount < 0) {
            const staleId = staleZeroLineId(j.jobId, line);
            if (staleId !== id) {
              const del = await client.query(
                'DELETE FROM qb_cost_lines WHERE id = $1 AND job_id = $2 AND amount = 0',
                [staleId, j.jobId]
              );
              if (del.rowCount) {
                jobStats.cleaned = (jobStats.cleaned || 0) + del.rowCount;
                stats.cleaned += del.rowCount;
              }
            }
          }
        }
        stats.byJob[j.jobId] = jobStats;
      }

      await client.query('COMMIT');

      // (Removed: the post-import 86-pm agent-watcher nudge. The staff/watcher
      // agents were retired/archived — re-firing one on every QB import was the
      // one automatic trigger that could turn a routine import into recurring
      // Opus spend. QB lines are read on demand by 86/the assistant instead.)

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
      // Wave A (A2): scope cost lines to the caller's org via job -> owner -> org.
      // LEFT JOIN + OR-IS-NULL (org tolerance) = no-op for AGX today; tighten by
      // dropping the IS NULL clause once data is fully org-stamped.
      const orgId = req.user.organization_id;
      let rows;
      if (jobId) {
        const r = await pool.query(
          `SELECT q.* FROM qb_cost_lines q
             LEFT JOIN jobs j ON j.id = q.job_id
             LEFT JOIN users u ON u.id = j.owner_id
            WHERE q.job_id = $1
              AND (u.organization_id = $2 OR u.organization_id IS NULL)
            ORDER BY q.txn_date DESC NULLS LAST, q.amount DESC`,
          [jobId, orgId]
        );
        rows = r.rows;
      } else {
        const r = await pool.query(
          `SELECT q.* FROM qb_cost_lines q
             LEFT JOIN jobs j ON j.id = q.job_id
             LEFT JOIN users u ON u.id = j.owner_id
            WHERE (u.organization_id = $1 OR u.organization_id IS NULL)
            ORDER BY q.txn_date DESC NULLS LAST, q.amount DESC LIMIT 5000`,
          [orgId]
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
      const { linkedNodeId, memo, bucket, buildingId } = req.body || {};
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
      // Cost-bucket model: manual bucket override + building attribution.
      if (bucket !== undefined) {
        sets.push(`bucket = $${i++}`);
        vals.push(bucket || null);
      }
      if (buildingId !== undefined) {
        sets.push(`building_id = $${i++}`);
        vals.push(buildingId || null);
      }
      if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
      sets.push(`updated_at = NOW()`);
      vals.push(req.params.id);
      // SAFE: column names come from req.body destructuring (linkedNodeId / memo); never user-key iteration.
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
// POST /api/qb-costs/bulk-assign
// Body: { ids: [...], bucket?: 'materials'|…|null, buildingId?: '…'|null }
// Cost-bucket model (node retirement): set a manual bucket override
// and/or a building attribution on every line in `ids`. Pass a field as
// null to clear it; omit a field to leave it untouched. Returns count.
// ──────────────────────────────────────────────────────────────────
router.post('/bulk-assign',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const { ids, bucket, buildingId } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'ids array is required' });
      }
      if (ids.length > 1000) {
        return res.status(400).json({ error: 'bulk-assign cap is 1000 lines per call' });
      }
      const sets = [];
      const vals = [];
      let i = 1;
      if (bucket !== undefined) { sets.push(`bucket = $${i++}`); vals.push(bucket || null); }
      if (buildingId !== undefined) { sets.push(`building_id = $${i++}`); vals.push(buildingId || null); }
      if (!sets.length) return res.status(400).json({ error: 'nothing to assign (bucket or buildingId required)' });
      sets.push(`updated_at = NOW()`);
      vals.push(ids);
      // SAFE: column list is a fixed whitelist (bucket / building_id); ids passed as a param array.
      const result = await pool.query(
        `UPDATE qb_cost_lines SET ${sets.join(', ')} WHERE id = ANY($${i}::text[]) RETURNING id`,
        vals
      );
      res.json({ ok: true, updated: result.rowCount });
    } catch (e) {
      console.error('POST /api/qb-costs/bulk-assign error:', e);
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
