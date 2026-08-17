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
const { requireAuth, requireCapability, requireOrgId } = require('../auth');
const { jobIdsInOrg, parentJobInOrgSql } = require('../services/job-org-scope');
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
// The write — ordered, chunked, and retried on a lock race.
//
// The 08.13.26 import POSTed 1205 matched rows and Postgres answered
// `40P01 deadlock detected`. The whole transaction rolled back, so the
// receipt read PARSED 3109 / MATCHED 1205 / WRITTEN 0.
//
// The import never conflicted with itself. It conflicted with
// PUT /api/jobs/bulk/save — which the importer's own client kicks off
// ~600ms BEFORE the POST lands, because it stamps qbCosts*/updatedAt on
// every matched job and that makes all of them dirty. Two writers, one
// shared resource, opposite orders:
//
//   * Every INSERT INTO qb_cost_lines fires the FK check for
//     job_id → jobs(id), and that check takes FOR KEY SHARE on the jobs
//     row and HOLDS IT TO COMMIT. One BEGIN wrapped around 1205
//     sequential round-trips therefore sat on ~25 jobs rows for the tens
//     of seconds the batch took. (The plain `SELECT 1 FROM jobs`
//     existence check took no lock — the FK did.)
//   * bulk/save takes FOR UPDATE on the same ~25 jobs rows, walking them
//     in appData order.
//
// FOR KEY SHARE conflicts with FOR UPDATE, and the two orderings were
// unrelated — QB report order on one side, Postgres heap order on the
// other. With a 30-60s hold over an identical row set, a cycle was close
// to certain rather than unlucky.
//
// Three changes, and they are only safe together:
//
//   1. TOTAL ORDER. The batch is flattened and sorted by (job_id, id)
//      before a single row is written. Sorting by the primary key means
//      any two transactions touching an overlapping set of rows walk the
//      intersection in the same sequence. job_id LEADS the key because
//      the jobs-row FK lock is the one that actually collided;
//      job-routes.js bulk/save now sorts by job.id for the same reason,
//      so the two routes agree on jobs ordering and the observed cycle
//      cannot form. id (the content hash) is the tiebreak, which
//      serialises two concurrent imports against each other.
//
//   2. CHUNKS. ~200 rows per transaction instead of all of them. A chunk
//      holds its jobs locks for a fraction of a second rather than the
//      length of the file, collapsing the collision window. Chunking
//      gives up all-or-nothing, and that trade is acceptable ONLY
//      because of the content-hash id: a half-landed import is repaired
//      by importing the same file again, which upserts every row by
//      primary key and cannot double-count.
//
//   3. RETRY. 40P01 (deadlock_detected) and 40001 (serialization_failure)
//      are the two SQLSTATEs Postgres raises to say "you lost a lock
//      race, run it again". Retrying is safe HERE BY CONSTRUCTION: every
//      id is a content hash and every write is INSERT … ON CONFLICT (id)
//      DO UPDATE, so re-running a rolled-back chunk reproduces exactly
//      the same rows — never extra ones. Counts are tallied per ATTEMPT
//      and folded into the receipt only on COMMIT, so a chunk that
//      deadlocked halfway and then succeeded is counted once, not twice.
//
// A chunk that exhausts its retries does NOT take the request down with
// it: it is reported as a rejection carrying its reason and row count,
// and `ok` goes false. A partial write has to read as partial. That is
// the whole point of this month's work on this importer — a write that
// did not land must never be able to look like one that did.
// ──────────────────────────────────────────────────────────────────

const IMPORT_CHUNK_ROWS = 200;
const IMPORT_MAX_ATTEMPTS = 4;   // 1 attempt + 3 retries
const IMPORT_BACKOFF_MS = 25;    // doubles per retry, plus jitter
// Exactly the two "re-run me" errors. Anything else is a real fault and
// is surfaced immediately rather than hammered at.
const RETRYABLE_SQLSTATE = new Set(['40P01', '40001']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ON CONFLICT update — but only the mutable fields (memo etc. can change
// between exports if the user edits in QB). Keep imported_at fresh so we
// know the row was seen this round.
// organization_id is read off the PARENT JOB, not off the caller -- a cost line
// belongs to whatever tenant its job belongs to, which makes the stamp
// unforgeable. It used to land NULL and be healed by the boot backfill; gating
// that backfill (9c1626a) was correct and turned this into a standing NULL, so
// it has to be stamped at insert instead. Left alone on DO UPDATE, for the same
// reason the jobs upsert leaves it alone: a re-import is not a tenant move.
const UPSERT_LINE_SQL = `INSERT INTO qb_cost_lines (
     id, job_id, vendor, txn_date, txn_type, num,
     account, account_type, klass, memo, amount,
     raw_data, source_file, report_date, imported_at, organization_id
   ) VALUES (
     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(),
     (SELECT organization_id FROM jobs WHERE id = $2)
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
   RETURNING (xmax = 0) AS inserted`;

// Retire the row the pre-fix parser wrote for this same credit. Credits
// used to import as $0.00 (QB writes negatives in accounting
// parentheses, which the old client toNumber() read as NaN → 0). Amount
// is part of the id, so that old row has a different hash than the
// corrected one and the upsert cannot reach it — it would sit there
// forever as a phantom $0.00 line beside the real credit. Money was
// never wrong (a $0 row adds nothing); the line list was.
//
// Scoped hard: same job, the exact superseded hash, and amount 0.
// Self-limiting — once a job is cleaned there is nothing left to match
// on later imports. It runs at a FIXED position in the sorted sequence
// (immediately after its own credit row), so it does not perturb the
// total order two concurrent imports agree on.
const RETIRE_STALE_ZERO_SQL =
  'DELETE FROM qb_cost_lines WHERE id = $1 AND job_id = $2 AND amount = 0';

// One chunk = one transaction, retried on a lock race.
//
// The tally is per-ATTEMPT and is only handed back on COMMIT. An attempt
// that rolled back put nothing in the database, so it must put nothing
// on the receipt either — that discard is what keeps a retried chunk
// from being counted twice.
async function writeChunk(rows) {
  let lastErr = null;
  for (let attempt = 1; attempt <= IMPORT_MAX_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    const tally = { inserted: 0, updated: 0, cleaned: 0, byJob: {} };
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        const jb = tally.byJob[row.jobId] ||
          (tally.byJob[row.jobId] = { inserted: 0, updated: 0, cleaned: 0 });
        const result = await client.query(UPSERT_LINE_SQL, row.params);
        if (result.rows[0] && result.rows[0].inserted) {
          tally.inserted++; jb.inserted++;
        } else {
          tally.updated++; jb.updated++;
        }
        if (row.staleId) {
          const del = await client.query(RETIRE_STALE_ZERO_SQL, [row.staleId, row.jobId]);
          if (del.rowCount) { tally.cleaned += del.rowCount; jb.cleaned += del.rowCount; }
        }
      }
      await client.query('COMMIT');
      return { ok: true, tally, attempts: attempt };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      lastErr = e;
      const retryable = RETRYABLE_SQLSTATE.has(e && e.code);
      if (!retryable || attempt === IMPORT_MAX_ATTEMPTS) {
        return { ok: false, error: e, attempts: attempt, retryable };
      }
      console.warn('[qb-costs] chunk of ' + rows.length + ' rows hit ' + e.code +
        ' on attempt ' + attempt + '/' + IMPORT_MAX_ATTEMPTS + ' — rolled back, retrying');
      await sleep(IMPORT_BACKOFF_MS * Math.pow(2, attempt - 1) +
        Math.floor(Math.random() * IMPORT_BACKOFF_MS));
    } finally {
      client.release();
    }
  }
  // Unreachable — the loop always returns on its last attempt. Here so a
  // future edit to the bounds cannot silently return undefined.
  return { ok: false, error: lastErr, attempts: IMPORT_MAX_ATTEMPTS, retryable: true };
}

// ──────────────────────────────────────────────────────────────────
// POST /api/qb-costs/import
// Body: { reportDate, sourceFile, jobs: [{ jobId, lines: [...] }] }
// Each line: { vendor, date, txnType, num, account, accountType,
//              klass, memo, amount }
// ──────────────────────────────────────────────────────────────────
router.post('/import',
  requireAuth, requireCapability('JOBS_EDIT_ANY'), requireOrgId,
  async (req, res) => {
    const { reportDate, sourceFile, jobs } = req.body || {};
    if (!Array.isArray(jobs)) {
      return res.status(400).json({ error: 'jobs array required' });
    }

    try {
      // `received` and `rejected` exist because the client used to have no
      // way to tell "wrote 224 rows" from "wrote nothing" — the whole
      // 08.13.26 import failure was invisible for three weeks. A count of
      // what arrived, plus a REASON for every row that did not land, is
      // what makes the importer's result screen trustworthy. `failed` is
      // the same idea one level down: rows the server accepted, tried to
      // write, and could not commit.
      const stats = {
        received: jobs.reduce((n, j) => n + (j && Array.isArray(j.lines) ? j.lines.length : 0), 0),
        inserted: 0, updated: 0, skipped: 0, cleaned: 0, failed: 0,
        rejected: [], byJob: {}
      };
      const reject = (jobId, lines, reason) => {
        stats.skipped += lines;
        stats.rejected.push({ jobId: jobId || null, lines, reason });
      };
      const reportDateNorm = normDate(reportDate);

      // Which jobs exist — ONE query, and deliberately OUTSIDE any
      // transaction. `SELECT 1 FROM jobs` never took a row lock, so this
      // check was not part of the deadlock; running it per-job inside the
      // batch just added a round-trip per job to the window during which
      // the FK locks were held open.
      const wanted = [...new Set(
        jobs.filter((j) => j && j.jobId).map((j) => String(j.jobId))
      )];
      // The parent-job gate is also the TENANT gate. Unscoped, this let an
      // org-A caller inject QB cost lines onto org-B jobs: the rows land keyed
      // to a foreign job and show up in that tenant's cost rollups as actuals.
      // A job in another tenant is simply not "known" here, so it takes the
      // existing rejection path with its existing message.
      const known = await jobIdsInOrg(pool, wanted, req.orgId);

      // ── Flatten + validate before anything is written ─────────────
      // Every rejection below is decided with no database work at all, so
      // the transactions further down carry only rows that can actually
      // land. `work` is the flat, sortable unit of that write.
      const work = [];

      for (const j of jobs) {
        if (!j || !j.jobId || !Array.isArray(j.lines)) {
          reject(j && j.jobId, (j && Array.isArray(j.lines) ? j.lines.length : 0),
            'malformed batch entry — missing jobId or lines array');
          continue;
        }
        // Verify the job exists. Skipping silently is friendlier than
        // throwing on a stale jobId.
        const jobId = String(j.jobId);
        if (!known.has(jobId)) {
          reject(jobId, j.lines.length,
            'no job with this id exists — it was deleted, or the browser is holding a stale copy of the jobs list');
          stats.byJob[jobId] = { inserted: 0, updated: 0, skipped: j.lines.length, reason: 'job not found' };
          continue;
        }

        const jobStats = stats.byJob[jobId] ||
          (stats.byJob[jobId] = { inserted: 0, updated: 0, skipped: 0 });

        for (const line of j.lines) {
          // Pre-flight, before the row can reach NUMERIC(12,2). A non-finite
          // amount stores as NaN in Postgres and silently poisons every
          // rollup that sums this job. Reject it by name instead — the
          // batch stays atomic because nothing here touches the write.
          if (!line || typeof line !== 'object') {
            jobStats.skipped++;
            reject(jobId, 1, 'line is not an object');
            continue;
          }
          // Exactly the expression the INSERT uses, so this rejects only
          // values that would actually be written as NaN — a missing or
          // empty amount still coerces to 0.00 the way it always has.
          const amount = Number(line.amount || 0);
          if (!Number.isFinite(amount)) {
            jobStats.skipped++;
            reject(jobId, 1,
              'amount is not a number (' + JSON.stringify(line.amount) + ') — vendor ' +
              JSON.stringify(line.vendor || '') + ', ' + JSON.stringify(line.date || ''));
            continue;
          }

          const id = hashLineId(jobId, line);
          const txnDate = normDate(line.date);
          // Credits carry the id their pre-fix $0.00 twin was stored
          // under, so the chunk can retire it right after writing the
          // corrected row. Computed here (no DB work) to keep the
          // transaction down to pure writes.
          const staleId = amount < 0 ? staleZeroLineId(jobId, line) : null;

          work.push({
            jobId,
            id,
            staleId: (staleId && staleId !== id) ? staleId : null,
            params: [
              id, jobId,
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
          });
        }
      }

      // ── TOTAL ORDER ───────────────────────────────────────────────
      // Sort by (job_id, id) — see the header comment. Plain byte
      // comparison, never localeCompare: this order has to be one every
      // process and every machine agrees on, independent of locale.
      work.sort((a, b) => (
        a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 :
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      ));

      // ── The write ─────────────────────────────────────────────────
      const chunkCount = Math.ceil(work.length / IMPORT_CHUNK_ROWS);
      let chunksCommitted = 0;
      let chunksFailed = 0;
      let attemptsUsed = 0;

      for (let start = 0, n = 0; start < work.length; start += IMPORT_CHUNK_ROWS) {
        const chunk = work.slice(start, start + IMPORT_CHUNK_ROWS);
        n++;
        const out = await writeChunk(chunk);
        attemptsUsed += out.attempts;

        if (out.ok) {
          chunksCommitted++;
          stats.inserted += out.tally.inserted;
          stats.updated += out.tally.updated;
          stats.cleaned += out.tally.cleaned;
          for (const [id, jb] of Object.entries(out.tally.byJob)) {
            const target = stats.byJob[id] ||
              (stats.byJob[id] = { inserted: 0, updated: 0, skipped: 0 });
            target.inserted += jb.inserted;
            target.updated += jb.updated;
            if (jb.cleaned) target.cleaned = (target.cleaned || 0) + jb.cleaned;
          }
          continue;
        }

        // A chunk that could not commit. Every one of its rows was rolled
        // back, so none of them are stored — and the receipt has to say so
        // by job, with the reason, or a partial import reads as a clean
        // one. This is the exact failure mode the whole importer rework
        // exists to make impossible.
        chunksFailed++;
        stats.failed += chunk.length;
        const code = (out.error && out.error.code) || '';
        const detail = out.retryable
          ? 'the database could not commit this batch after ' + out.attempts +
            ' attempts (' + (out.error && out.error.message || 'lock contention') +
            (code ? ', SQLSTATE ' + code : '') + ')'
          : 'the database rejected this batch (' +
            (out.error && out.error.message || 'unknown error') +
            (code ? ', SQLSTATE ' + code : '') + ')';
        const reason = 'batch ' + n + ' of ' + chunkCount + ' was rolled back — ' + detail +
          '. These rows are NOT stored. Re-import the same file: every line id is a ' +
          'content hash, so re-importing rewrites the same rows and cannot double-count.';

        const perJob = new Map();
        for (const row of chunk) perJob.set(row.jobId, (perJob.get(row.jobId) || 0) + 1);
        for (const [id, count] of perJob) {
          reject(id, count, reason);
          const target = stats.byJob[id] ||
            (stats.byJob[id] = { inserted: 0, updated: 0, skipped: 0 });
          target.skipped += count;
          target.failed = (target.failed || 0) + count;
        }
      }

      // (Removed: the post-import 86-pm agent-watcher nudge. The staff/watcher
      // agents were retired/archived — re-firing one on every QB import was the
      // one automatic trigger that could turn a routine import into recurring
      // Opus spend. QB lines are read on demand by 86/the assistant instead.)

      if (chunksFailed) {
        console.error('[qb-costs] import finished with ' + chunksFailed + ' of ' + chunkCount +
          ' batches rolled back — ' + stats.failed + ' of ' + work.length +
          ' rows were NOT stored (' + stats.inserted + ' inserted, ' + stats.updated + ' updated)');
      }

      // ok is false the moment anything failed to commit. The client
      // receipt keys off the counts (written / already-on-file /
      // rejected-with-reason) rather than this flag, but any programmatic
      // caller gets one unambiguous boolean instead of having to infer it.
      res.json({
        ok: chunksFailed === 0,
        ...stats,
        chunks: {
          size: IMPORT_CHUNK_ROWS,
          total: chunkCount,
          committed: chunksCommitted,
          failed: chunksFailed,
          attempts: attemptsUsed
        }
      });
    } catch (e) {
      console.error('POST /api/qb-costs/import error:', e);
      res.status(500).json({ error: e.message || 'Server error' });
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
      // Scoped through the parent job's organization_id COLUMN. This used to
      // join owner_id -> users.organization_id, which is a THIRD scoping
      // mechanism on the same table family: the column (job-routes,
      // assertTargetOrg), the owner join (org-access, this read), and nothing
      // at all (every write below, until this commit). The column is canonical.
      const orgId = req.user.organization_id;
      let rows;
      if (jobId) {
        const r = await pool.query(
          `SELECT q.* FROM qb_cost_lines q
             LEFT JOIN jobs j ON j.id = q.job_id
            WHERE q.job_id = $1
              AND (j.organization_id = $2 OR j.organization_id IS NULL)
            ORDER BY q.txn_date DESC NULLS LAST, q.amount DESC`,
          [jobId, orgId]
        );
        rows = r.rows;
      } else {
        const r = await pool.query(
          `SELECT q.* FROM qb_cost_lines q
             LEFT JOIN jobs j ON j.id = q.job_id
            WHERE (j.organization_id = $1 OR j.organization_id IS NULL)
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
  requireAuth, requireCapability('JOBS_EDIT_ANY'), requireOrgId,
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
      vals.push(req.orgId);
      // SAFE: column names come from req.body destructuring (linkedNodeId / memo); never user-key iteration.
      // The parent-job tenant predicate is part of the WHERE, not a pre-check:
      // this statement RETURNS * -- vendor, amount, account, memo -- so an
      // unscoped update was a cross-tenant read as well as a cross-tenant write.
      const result = await pool.query(
        `UPDATE qb_cost_lines SET ${sets.join(', ')}
          WHERE id = $${i}
            AND ${parentJobInOrgSql('qb_cost_lines.job_id', '$' + (i + 1))}
          RETURNING *`,
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
  requireAuth, requireCapability('JOBS_EDIT_ANY'), requireOrgId,
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
            AND ${parentJobInOrgSql('qb_cost_lines.job_id', '$3')}
          RETURNING id`,
        [target, ids, req.orgId]
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
  requireAuth, requireCapability('JOBS_EDIT_ANY'), requireOrgId,
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
      vals.push(req.orgId);
      // SAFE: column list is a fixed whitelist (bucket / building_id); ids passed as a param array.
      // This one re-attributes ACTUAL COSTS across buildings and cost buckets.
      // It changes no amount, so "money is out of scope" does not catch it --
      // and it still moved money between line items in another tenant's
      // rollups, 1000 rows per call.
      const result = await pool.query(
        `UPDATE qb_cost_lines SET ${sets.join(', ')}
          WHERE id = ANY($${i}::text[])
            AND ${parentJobInOrgSql('qb_cost_lines.job_id', '$' + (i + 1))}
          RETURNING id`,
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
  requireAuth, requireCapability('JOBS_EDIT_ANY'), requireOrgId,
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
            AND ${parentJobInOrgSql('qb_cost_lines.job_id', '$3')}
          RETURNING id`,
        [jobId, validList, req.orgId]
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
  requireAuth, requireCapability('JOBS_EDIT_ANY'), requireOrgId,
  async (req, res) => {
    try {
      const r = await pool.query(
        `DELETE FROM qb_cost_lines
          WHERE id = $1
            AND ${parentJobInOrgSql('qb_cost_lines.job_id', '$2')}`,
        [req.params.id, req.orgId]);
      res.json({ ok: true, deleted: r.rowCount });
    } catch (e) {
      console.error('DELETE /api/qb-costs/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
