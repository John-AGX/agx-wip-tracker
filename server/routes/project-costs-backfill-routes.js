// Project Costs bulk backfill — one-shot historical import.
//
// Unlike the weekly /api/qb-costs/import (which only attaches cost lines
// to jobs that ALREADY exist), this endpoint backfills from scratch: it
// reads the QB "Project Profitability" tab to CREATE the jobs (job
// number, name, customer, contract/income, cost) and the "Project costs
// detail" tab to ATTACH the per-line costs — in one idempotent pass.
//
// Idempotency:
//   - Jobs are matched/created by jobNumber (UPPER(data->>'jobNumber')),
//     so re-running never duplicates a job.
//   - Cost lines reuse qb_cost_lines' content-hash id + ON CONFLICT
//     upsert, so re-running updates in place.
//
// dryRun:true does the full computation inside a transaction and ROLLs
// BACK, returning the exact counts — that powers the approve-before-
// commit preview in js/project-costs-backfill.js.
//
// Body: {
//   dryRun, reportDate, sourceFile, defaultStatus,
//   jobs:        [{ code, name, customer, income, costs, profit }],
//   costsByCode: { CODE: [{ vendor,date,txnType,num,account,
//                            accountType,klass,memo,amount }, ...] }
// }

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

console.log('[project-costs-backfill] mounted at /api/project-costs-backfill');

// Stable content-hash id — identical to qb-cost-routes.js so a line
// imported here and re-imported by the weekly QB flow resolves to the
// same row (no duplication across the two paths).
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
  return 'qbc_' + crypto.createHash('sha256').update(parts.join('␟')).digest('hex').slice(0, 16);
}

function normDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    let yr = m[3];
    if (yr.length === 2) yr = (parseInt(yr, 10) > 50 ? '19' : '20') + yr;
    return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : 0;
}

// POST /api/project-costs-backfill
router.post('/', requireAuth, requireRole('admin', 'pm'), async (req, res) => {
  const { dryRun, reportDate, sourceFile, defaultStatus, jobs, costsByCode } = req.body || {};
  if (!Array.isArray(jobs)) {
    return res.status(400).json({ error: 'jobs array required' });
  }

  const orgId = req.user.organization_id;
  const ownerId = req.user.id;
  const status = defaultStatus || 'Closed';
  const reportDateNorm = normDate(reportDate);
  const nowIso = new Date().toISOString();
  const costs = (costsByCode && typeof costsByCode === 'object') ? costsByCode : {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const stats = {
      dryRun: !!dryRun,
      jobsCreated: 0, jobsMatched: 0, jobsWithNoCosts: 0,
      linesInserted: 0, linesUpdated: 0,
      totalIncome: 0, totalCost: 0,
      sample: []
    };
    const seenCodes = new Set();

    // Process one job spec: match-or-create the job, then upsert its lines.
    async function processSpec(spec) {
      if (!spec || !spec.code) return;
      const code = String(spec.code).trim().toUpperCase();
      if (!code || seenCodes.has(code)) return;
      seenCodes.add(code);
      stats.totalIncome += num(spec.income);

      const found = await client.query(
        `SELECT id FROM jobs
           WHERE (organization_id = $1 OR organization_id IS NULL)
             AND UPPER(data->>'jobNumber') = $2
           LIMIT 1`,
        [orgId, code]
      );

      let jobId, created = false;
      if (found.rows.length) {
        jobId = found.rows[0].id;
        stats.jobsMatched++;
      } else {
        jobId = 'job_bf_' + code.replace(/[^A-Z0-9]/g, '') + '_' +
          Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const data = {
          id: jobId,
          jobNumber: code,
          title: spec.name || code,
          client: spec.customer || '',
          status,
          contractAmount: num(spec.income),
          estimatedCosts: num(spec.costs),
          qbCostsTotal: num(spec.costs),
          qbCostsAsOf: reportDateNorm,
          backfill: {
            source: sourceFile || null,
            importedAt: nowIso,
            profit: num(spec.profit),
            period: reportDate || null
          },
          notes: 'Backfilled from QB Project Costs export (' + (sourceFile || 'upload') +
            ') on ' + nowIso.slice(0, 10) + '.',
          createdAt: nowIso,
          updatedAt: nowIso
        };
        await client.query(
          'INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ($1, $2, $3, $4)',
          [jobId, ownerId, JSON.stringify(data), orgId]
        );
        stats.jobsCreated++;
        created = true;
      }

      const lines = Array.isArray(costs[code]) ? costs[code] : [];
      if (!lines.length) stats.jobsWithNoCosts++;
      for (const line of lines) {
        const id = hashLineId(jobId, line);
        const amount = num(line.amount);
        stats.totalCost += amount;
        const r = await client.query(
          `INSERT INTO qb_cost_lines (
             id, job_id, vendor, txn_date, txn_type, num,
             account, account_type, klass, memo, amount,
             raw_data, source_file, report_date, imported_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
           ON CONFLICT (id) DO UPDATE SET
             vendor=EXCLUDED.vendor, txn_date=EXCLUDED.txn_date,
             txn_type=EXCLUDED.txn_type, num=EXCLUDED.num,
             account=EXCLUDED.account, account_type=EXCLUDED.account_type,
             klass=EXCLUDED.klass, memo=EXCLUDED.memo, amount=EXCLUDED.amount,
             raw_data=EXCLUDED.raw_data, source_file=EXCLUDED.source_file,
             report_date=EXCLUDED.report_date, imported_at=NOW(), updated_at=NOW()
           RETURNING (xmax = 0) AS inserted`,
          [
            id, jobId, line.vendor || null, normDate(line.date),
            line.txnType || null, line.num || null, line.account || null,
            line.accountType || null, line.klass || null, line.memo || null,
            amount, line, sourceFile || null, reportDateNorm
          ]
        );
        if (r.rows[0] && r.rows[0].inserted) stats.linesInserted++;
        else stats.linesUpdated++;
      }

      if (stats.sample.length < 10) {
        stats.sample.push({ code, name: spec.name || code, created, lines: lines.length, income: num(spec.income), cost: num(spec.costs) });
      }
    }

    for (const spec of jobs) await processSpec(spec);
    // Safety net: any cost code with no matching job spec still gets a
    // minimal job so its costs aren't dropped.
    for (const code of Object.keys(costs)) {
      if (!seenCodes.has(String(code).trim().toUpperCase())) {
        await processSpec({ code, name: code });
      }
    }

    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');

    res.json({ ok: true, ...stats });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/project-costs-backfill error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
