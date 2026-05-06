// Admin Batch — wraps Anthropic's Batches API for proactive analyses.
//
// Endpoints:
//   POST /api/admin/batch/elle-audit     submit Elle audit across active jobs
//   GET  /api/admin/batch/jobs           list batches (auto-polls non-terminal ones)
//   GET  /api/admin/batch/jobs/:id       single batch detail incl. results
//   POST /api/admin/batch/jobs/:id/refresh  force-poll one batch's status
//
// Batch processing trades 50% of the cost for up-to-24h latency. Used
// for things you'd want to look at in the morning, not mid-conversation:
//   - Nightly Elle audit on every active job → "morning briefing"
//   - Bulk re-run of past estimates against a new pricing pack
//
// Admin-gated by ROLES_MANAGE.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

console.log('[admin-batch-routes] mounted at /api/admin/batch');

const { Anthropic } = require('@anthropic-ai/sdk');
let _anth = null;
function getAnthropic() {
  if (_anth) return _anth;
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  _anth = new Anthropic({ apiKey: key });
  return _anth;
}

// Default audit prompt fired against every active job in an Elle batch.
// Kept small + structured so per-job outputs are easy to scan in the
// morning. Not configurable yet (admin can edit here when needs differ).
const ELLE_AUDIT_PROMPT =
  'Run a quick health audit on this job. ' +
  '5 bullet points max, lead with anything 🔴 needs action. ' +
  'Cover: margin drift (JTD vs Revised vs As-Sold), under-billing, ' +
  'missing COs, missing POs, % complete sanity. ' +
  'Be concise — this lands in a morning briefing across all active jobs.';

// POST /api/admin/batch/elle-audit
//   Submits an audit batch across every active job (status != Archived
//   and != Completed). One batch request per job, all firing in
//   parallel server-side at the Anthropic Batch API. Half the cost
//   of synchronous chat; up to 24h to complete (typically faster).
router.post('/elle-audit', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'AI not configured (ANTHROPIC_API_KEY missing).' });

    // Resolve the eligible job set. data is JSONB so we filter via
    // jsonb fields rather than a status column.
    const jobsRes = await pool.query(
      `SELECT id, data FROM jobs
        WHERE COALESCE(data->>'status', 'New') NOT IN ('Archived', 'Completed')
        ORDER BY id ASC`
    );
    if (!jobsRes.rows.length) {
      return res.status(400).json({ error: 'No active jobs to audit.' });
    }

    const aiInternals = require('./ai-routes-internals');
    if (!aiInternals || !aiInternals.buildJobContext) {
      throw new Error('ai-routes internals not available — server may not be fully booted yet.');
    }
    const tools = aiInternals.jobTools();
    const model = aiInternals.defaultModel();
    const maxTokens = aiInternals.maxTokens();

    // Build one Anthropic batch request per job. custom_id is the
    // job_id so we can match the result back to a row when the batch
    // completes.
    const requests = [];
    const skipped = [];
    for (const j of jobsRes.rows) {
      try {
        // aiPhase=plan keeps Elle in read-only mode in batches — we
        // don't want a batch run mutating WIP data without a human
        // in the loop reviewing the proposed writes.
        const ctx = await aiInternals.buildJobContext(j.id, '', 'plan');
        // Plan-mode tool filter must match what production uses on
        // a real Plan-mode chat turn — read tools + request_build_mode.
        // The exact list is duplicated from ai-routes for now; kept in
        // sync by hand. (Future: expose filterToolsForJobPhase via internals.)
        const planTools = tools.filter(t => [
          'web_search', 'read_workspace_sheet_full', 'read_qb_cost_lines',
          'read_materials', 'read_purchase_history', 'read_subs',
          'read_building_breakdown', 'read_job_pct_audit', 'request_build_mode'
        ].indexOf(t.name) !== -1);
        requests.push({
          custom_id: j.id,
          params: {
            model,
            max_tokens: maxTokens,
            system: ctx.system,
            tools: planTools,
            messages: [{ role: 'user', content: ELLE_AUDIT_PROMPT }]
          }
        });
      } catch (e) {
        // Per-job context build failure shouldn't kill the whole batch.
        skipped.push({ id: j.id, error: e.message });
      }
    }
    if (!requests.length) {
      return res.status(400).json({ error: 'Could not build context for any active job.', skipped });
    }

    // Submit. Anthropic returns a batch object with id + processing_status.
    const batch = await anthropic.beta.messages.batches.create({ requests });

    const id = 'bj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO batch_jobs (id, agent, kind, anthropic_batch_id, status, request_count, submitted_by)
       VALUES ($1, 'job', 'audit', $2, $3, $4, $5)`,
      [id, batch.id, batch.processing_status || 'submitted', requests.length, req.user.id]
    );

    res.json({
      ok: true,
      batch_job_id: id,
      anthropic_batch_id: batch.id,
      request_count: requests.length,
      skipped: skipped.length,
      processing_status: batch.processing_status || 'submitted'
    });
  } catch (e) {
    console.error('POST /api/admin/batch/elle-audit error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// Internal helper: poll Anthropic for a single batch's latest status,
// download results when terminal, persist to batch_jobs row.
async function refreshBatchStatus(row) {
  const anthropic = getAnthropic();
  if (!anthropic || !row.anthropic_batch_id) return row;
  try {
    const remote = await anthropic.beta.messages.batches.retrieve(row.anthropic_batch_id);
    const newStatus = remote.processing_status || row.status;
    let resultsJson = null;
    let completedAt = null;
    if (newStatus === 'ended') {
      // Download streaming results. The SDK exposes .results() which
      // returns an async iterable of per-request outputs. Drain into
      // an array — these batches are 10s-100s of jobs, not millions.
      try {
        const stream = await anthropic.beta.messages.batches.results(row.anthropic_batch_id);
        const arr = [];
        for await (const item of stream) {
          // Each item carries custom_id + result (success / errored /
          // canceled / expired). Pull the assistant text + usage
          // into a flat shape the UI can render without unpacking.
          let text = '';
          let usage = null;
          let resultType = item.result && item.result.type;
          if (resultType === 'succeeded' && item.result.message) {
            const msg = item.result.message;
            text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
            usage = msg.usage || null;
          }
          arr.push({
            custom_id: item.custom_id,
            result_type: resultType,
            text: text,
            usage: usage,
            error: (item.result && item.result.error && item.result.error.error && item.result.error.error.message) || null
          });
        }
        resultsJson = arr;
        completedAt = new Date();
      } catch (resErr) {
        console.warn('Batch results download failed for', row.id, ':', resErr.message);
      }
    }
    await pool.query(
      `UPDATE batch_jobs
          SET status = $1, results = $2::jsonb, completed_at = COALESCE($3, completed_at)
        WHERE id = $4`,
      [newStatus, resultsJson ? JSON.stringify(resultsJson) : null, completedAt, row.id]
    );
    return Object.assign({}, row, {
      status: newStatus,
      results: resultsJson || row.results,
      completed_at: completedAt || row.completed_at
    });
  } catch (e) {
    console.warn('refreshBatchStatus failed for', row.id, ':', e.message);
    return row;
  }
}

// GET /api/admin/batch/jobs
//   Lists batches, newest first. Auto-polls any batch in a non-terminal
//   state ('submitted' / 'in_progress') so the list refreshes itself
//   on every view. Heavy poll batches (5+ in flight) could stack up —
//   if that becomes an issue, gate this behind a query param.
router.get('/jobs', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id, b.agent, b.kind, b.anthropic_batch_id, b.status, b.request_count,
              b.submitted_at, b.completed_at, b.error,
              u.name AS submitted_by_name, u.email AS submitted_by_email
         FROM batch_jobs b
         LEFT JOIN users u ON u.id = b.submitted_by
        ORDER BY b.submitted_at DESC
        LIMIT 50`
    );
    // Auto-poll non-terminal rows and reflect refreshed status in the
    // response. Sequential to keep polling traffic predictable.
    const rows = [];
    for (const row of r.rows) {
      let updated = row;
      if (row.status !== 'ended' && row.status !== 'failed' && row.anthropic_batch_id) {
        updated = await refreshBatchStatus(row);
      }
      rows.push(updated);
    }
    res.json({ jobs: rows });
  } catch (e) {
    console.error('GET /api/admin/batch/jobs error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// GET /api/admin/batch/jobs/:id
//   Returns a single batch + its full results array (per-job audit text).
//   Auto-polls if non-terminal so opening the detail kicks the
//   refresh without an explicit click.
router.get('/jobs/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.*, u.name AS submitted_by_name, u.email AS submitted_by_email
         FROM batch_jobs b
         LEFT JOIN users u ON u.id = b.submitted_by
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Batch not found' });
    let row = r.rows[0];
    if (row.status !== 'ended' && row.status !== 'failed' && row.anthropic_batch_id) {
      row = await refreshBatchStatus(row);
    }
    // Enrich per-result rows with the job title so the morning briefing
    // reads as "Wimbledon Greens — finding" not "j32 — finding".
    if (Array.isArray(row.results)) {
      const ids = row.results.map(x => x.custom_id).filter(Boolean);
      if (ids.length) {
        const titlesRes = await pool.query(
          `SELECT id, COALESCE(NULLIF(data->>'title',''), NULLIF(data->>'jobName',''), id) AS title
             FROM jobs WHERE id = ANY($1::text[])`,
          [ids]
        );
        const titleMap = {};
        titlesRes.rows.forEach(t => { titleMap[t.id] = t.title; });
        row.results = row.results.map(x => Object.assign({}, x, { job_title: titleMap[x.custom_id] || x.custom_id }));
      }
    }
    res.json({ job: row });
  } catch (e) {
    console.error('GET /api/admin/batch/jobs/:id error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/batch/jobs/:id/refresh
//   Force-poll one batch. Useful when the admin is impatient or
//   the auto-poll loop didn't catch a state transition.
router.post('/jobs/:id/refresh', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM batch_jobs WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Batch not found' });
    const updated = await refreshBatchStatus(r.rows[0]);
    res.json({ ok: true, status: updated.status, completed_at: updated.completed_at });
  } catch (e) {
    console.error('POST /api/admin/batch/jobs/:id/refresh error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

module.exports = router;
