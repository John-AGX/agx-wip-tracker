// Subcontractor directory + per-job assignment.
//
// Replaces the inline `appData.subs` array (per-job strings) with a
// first-class directory. The directory ("subs" table) holds the
// company profile — name, trade, license, W-9 status, contact.
// Per-job financials (contract, billed, status, level/building/phase)
// live in "job_subs" so the same sub can be on N jobs without
// duplicating their profile.
//
// Endpoints:
//   GET    /api/subs                — directory list
//   POST   /api/subs                — create
//   PUT    /api/subs/:id            — update directory profile
//   DELETE /api/subs/:id            — delete (only if no job_subs)
//   GET    /api/subs/:id            — single record + cross-job
//                                     summary (every job that's used
//                                     them)
//   GET    /api/jobs/:jobId/subs    — per-job assignments
//   POST   /api/jobs/:jobId/subs    — assign a sub to a job
//   PATCH  /api/jobs/:jobId/subs/:assignmentId — update contract /
//                                                billed / status
//   DELETE /api/jobs/:jobId/subs/:assignmentId — unassign
//
//   POST   /api/subs/migrate-preview — no-write dedupe preview of
//                                       inline-job subs into directory
//   POST   /api/subs/migrate         — apply the preview

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

console.log('[sub-routes] mounted at /api/subs (Phase A — sub directory + job_subs join)');

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Curated trade list — UI presents these as the dropdown plus an
// "Other" freeform fallback. Server only validates that the value
// is non-empty if provided; storage is freeform TEXT.
const KNOWN_TRADES = [
  'Painter', 'Drywall', 'Roofing', 'Stucco', 'Concrete', 'Masonry',
  'Carpentry', 'Framing', 'Siding', 'Gutters', 'Windows & Doors',
  'Pressure Washing', 'Demolition', 'Tree Work', 'Landscaping',
  'Plumbing', 'Electrical', 'HVAC', 'Welding & Metal', 'Flooring',
  'Sealants & Caulking', 'General Labor', 'Other'
];

// ──────────────────────────────────────────────────────────────────
// GET /api/subs   — full directory list with active-job counts
// ──────────────────────────────────────────────────────────────────
router.get('/',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT s.*,
               COALESCE(js.active_job_count, 0) AS active_job_count,
               COALESCE(js.total_contracted, 0) AS total_contracted,
               COALESCE(js.total_billed, 0) AS total_billed
        FROM subs s
        LEFT JOIN (
          SELECT sub_id,
                 COUNT(*) FILTER (WHERE status = 'active') AS active_job_count,
                 SUM(contract_amt) AS total_contracted,
                 SUM(billed_to_date) AS total_billed
          FROM job_subs
          GROUP BY sub_id
        ) js ON js.sub_id = s.id
        ORDER BY lower(s.name) ASC
      `);
      res.json({ subs: rows, trades: KNOWN_TRADES });
    } catch (e) {
      console.error('GET /api/subs error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /api/subs/:id — single profile + cross-job rollup
router.get('/:id',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const subRes = await pool.query('SELECT * FROM subs WHERE id = $1', [req.params.id]);
      if (!subRes.rows.length) return res.status(404).json({ error: 'Sub not found' });
      const assignments = await pool.query(`
        SELECT js.*, j.data->>'jobNumber' AS job_number,
               j.data->>'title' AS job_title,
               j.data->>'status' AS job_status
        FROM job_subs js
        LEFT JOIN jobs j ON j.id = js.job_id
        WHERE js.sub_id = $1
        ORDER BY js.created_at DESC
      `, [req.params.id]);
      res.json({ sub: subRes.rows[0], assignments: assignments.rows });
    } catch (e) {
      console.error('GET /api/subs/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/subs — create
router.post('/',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
      const id = b.id || genId('sub');
      const result = await pool.query(`
        INSERT INTO subs (id, name, trade, contact_name, phone, email, license_no,
                          w9_on_file, w9_expires, insurance_expires, parent_sub_id, status, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *
      `, [
        id, b.name.trim(),
        b.trade || null, b.contact_name || b.contactName || null,
        b.phone || null, b.email || null, b.license_no || b.licenseNo || null,
        !!(b.w9_on_file || b.w9OnFile),
        b.w9_expires || b.w9Expires || null,
        b.insurance_expires || b.insuranceExpires || null,
        b.parent_sub_id || b.parentSubId || null,
        b.status || 'active',
        b.notes || null
      ]);
      res.json({ sub: result.rows[0] });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ error: 'A sub with that name already exists' });
      }
      console.error('POST /api/subs error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /api/subs/:id — full profile update (PATCH-compatible: only
// non-undefined fields applied)
router.put('/:id',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [];
      const vals = [];
      let i = 1;
      const map = {
        name: 'name', trade: 'trade',
        contact_name: 'contact_name', contactName: 'contact_name',
        phone: 'phone', email: 'email',
        license_no: 'license_no', licenseNo: 'license_no',
        w9_on_file: 'w9_on_file', w9OnFile: 'w9_on_file',
        w9_expires: 'w9_expires', w9Expires: 'w9_expires',
        insurance_expires: 'insurance_expires', insuranceExpires: 'insurance_expires',
        parent_sub_id: 'parent_sub_id', parentSubId: 'parent_sub_id',
        status: 'status', notes: 'notes'
      };
      Object.keys(b).forEach(function(k) {
        if (map[k] && b[k] !== undefined) {
          sets.push(map[k] + ' = $' + i++);
          vals.push(b[k]);
        }
      });
      if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
      sets.push('updated_at = NOW()');
      vals.push(req.params.id);
      const result = await pool.query(
        'UPDATE subs SET ' + sets.join(', ') + ' WHERE id = $' + i + ' RETURNING *',
        vals
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Sub not found' });
      res.json({ sub: result.rows[0] });
    } catch (e) {
      console.error('PUT /api/subs/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /api/subs/:id — only if no job_subs assignments exist
router.delete('/:id',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const inUse = await pool.query('SELECT 1 FROM job_subs WHERE sub_id = $1 LIMIT 1', [req.params.id]);
      if (inUse.rows.length) {
        return res.status(409).json({ error: 'Sub is assigned to one or more jobs. Unassign first or use status=closed.' });
      }
      const result = await pool.query('DELETE FROM subs WHERE id = $1', [req.params.id]);
      res.json({ ok: true, deleted: result.rowCount });
    } catch (e) {
      console.error('DELETE /api/subs/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Per-job assignments (job_subs)
// ──────────────────────────────────────────────────────────────────

// GET /api/subs/jobs/:jobId — list this job's sub assignments,
// joined with directory profile so the UI doesn't need a second
// fetch.
router.get('/jobs/:jobId',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT js.*, s.name AS sub_name, s.trade, s.contact_name,
               s.phone, s.email, s.w9_on_file, s.insurance_expires
        FROM job_subs js
        LEFT JOIN subs s ON s.id = js.sub_id
        WHERE js.job_id = $1
        ORDER BY js.created_at DESC
      `, [req.params.jobId]);
      res.json({ assignments: rows });
    } catch (e) {
      console.error('GET /api/subs/jobs/:jobId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/subs/jobs/:jobId — assign a sub to a job
router.post('/jobs/:jobId',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.subId && !b.sub_id) return res.status(400).json({ error: 'subId is required' });
      const subId = b.subId || b.sub_id;
      const id = b.id || genId('jsub');
      const result = await pool.query(`
        INSERT INTO job_subs (id, job_id, sub_id, level, building_id, phase_id,
                              contract_amt, billed_to_date, status, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
      `, [
        id, req.params.jobId, subId,
        b.level || 'job',
        b.building_id || b.buildingId || null,
        b.phase_id || b.phaseId || null,
        Number(b.contract_amt || b.contractAmt || 0),
        Number(b.billed_to_date || b.billedToDate || 0),
        b.status || 'active',
        b.notes || null
      ]);
      res.json({ assignment: result.rows[0] });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Sub is already assigned to this job at that level. Edit the existing assignment.' });
      }
      console.error('POST /api/subs/jobs/:jobId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PATCH /api/subs/jobs/:jobId/:assignmentId — update assignment
router.patch('/jobs/:jobId/:assignmentId',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [];
      const vals = [];
      let i = 1;
      const map = {
        level: 'level',
        building_id: 'building_id', buildingId: 'building_id',
        phase_id: 'phase_id', phaseId: 'phase_id',
        contract_amt: 'contract_amt', contractAmt: 'contract_amt',
        billed_to_date: 'billed_to_date', billedToDate: 'billed_to_date',
        status: 'status', notes: 'notes'
      };
      Object.keys(b).forEach(function(k) {
        if (map[k] && b[k] !== undefined) {
          sets.push(map[k] + ' = $' + i++);
          vals.push(b[k]);
        }
      });
      if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
      sets.push('updated_at = NOW()');
      vals.push(req.params.assignmentId);
      vals.push(req.params.jobId);
      const result = await pool.query(
        'UPDATE job_subs SET ' + sets.join(', ') + ' WHERE id = $' + i + ' AND job_id = $' + (i + 1) + ' RETURNING *',
        vals
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Assignment not found' });
      res.json({ assignment: result.rows[0] });
    } catch (e) {
      console.error('PATCH /api/subs/jobs/:jobId/:assignmentId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.delete('/jobs/:jobId/:assignmentId',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const r = await pool.query(
        'DELETE FROM job_subs WHERE id = $1 AND job_id = $2',
        [req.params.assignmentId, req.params.jobId]
      );
      res.json({ ok: true, deleted: r.rowCount });
    } catch (e) {
      console.error('DELETE assignment error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Migration: dedupe inline-per-job sub records into the directory.
//
// preview: no writes — returns the dedupe groups so the user can
//   eyeball them before committing.
// apply:   inserts the global subs (idempotent on lower(name)),
//   then writes job_subs rows linking each per-job inline record
//   to its global parent.
//
// The client sends inline records in the body since they live in
// per-job JSON blobs (jobs.data.subs); the server doesn't have a
// dedicated query for them.
// ──────────────────────────────────────────────────────────────────
router.post('/migrate-preview',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const { inlineSubs } = req.body || {};
      if (!Array.isArray(inlineSubs)) return res.status(400).json({ error: 'inlineSubs array required' });
      // Group by lower-trimmed name
      const groups = {};
      inlineSubs.forEach(function(s) {
        const key = String(s.name || '').trim().toLowerCase();
        if (!key) return;
        if (!groups[key]) groups[key] = { canonical: String(s.name || '').trim(), records: [] };
        groups[key].records.push({
          jobId: s.jobId,
          jobNumber: s.jobNumber || null,
          jobTitle: s.jobTitle || null,
          name: s.name,
          trade: s.trade || null,
          level: s.level || 'job',
          buildingId: s.buildingId || null,
          phaseId: s.phaseId || null,
          contractAmt: Number(s.contractAmt || s.amount || 0),
          billedToDate: Number(s.billedToDate || 0)
        });
      });
      // Check existing subs for collisions
      const names = Object.values(groups).map(function(g) { return g.canonical.toLowerCase(); });
      const existing = names.length
        ? (await pool.query('SELECT id, name FROM subs WHERE lower(name) = ANY($1::text[])', [names])).rows
        : [];
      const existingByName = {};
      existing.forEach(function(e) { existingByName[e.name.toLowerCase()] = e; });
      const preview = Object.keys(groups).map(function(k) {
        return {
          name: groups[k].canonical,
          existingSubId: existingByName[k] ? existingByName[k].id : null,
          recordCount: groups[k].records.length,
          totalContractAmt: groups[k].records.reduce(function(s, r) { return s + r.contractAmt; }, 0),
          jobs: Array.from(new Set(groups[k].records.map(function(r) { return r.jobNumber || r.jobId; }))),
          records: groups[k].records
        };
      }).sort(function(a, b) { return b.totalContractAmt - a.totalContractAmt; });
      res.json({
        preview: preview,
        totalInline: inlineSubs.length,
        uniqueSubs: preview.length,
        existingMatches: preview.filter(function(p) { return p.existingSubId; }).length
      });
    } catch (e) {
      console.error('POST /api/subs/migrate-preview error:', e);
      res.status(500).json({ error: e.message || 'Server error' });
    }
  }
);

router.post('/migrate-apply',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    const { inlineSubs } = req.body || {};
    if (!Array.isArray(inlineSubs)) return res.status(400).json({ error: 'inlineSubs array required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const groups = {};
      inlineSubs.forEach(function(s) {
        const key = String(s.name || '').trim().toLowerCase();
        if (!key) return;
        if (!groups[key]) groups[key] = { canonical: String(s.name || '').trim(), records: [] };
        groups[key].records.push(s);
      });

      const stats = { subsCreated: 0, subsReused: 0, assignmentsCreated: 0, assignmentsSkipped: 0 };

      for (const key of Object.keys(groups)) {
        const g = groups[key];
        // Look up existing sub by lowercased name
        let subRow = (await client.query('SELECT id FROM subs WHERE lower(name) = $1', [key])).rows[0];
        if (!subRow) {
          // Pick the most-frequent trade across records for the directory profile
          const tradeCounts = {};
          g.records.forEach(function(r) {
            if (r.trade) tradeCounts[r.trade] = (tradeCounts[r.trade] || 0) + 1;
          });
          const trade = Object.keys(tradeCounts).sort(function(a, b) { return tradeCounts[b] - tradeCounts[a]; })[0] || null;
          const id = genId('sub');
          await client.query(
            'INSERT INTO subs (id, name, trade) VALUES ($1, $2, $3)',
            [id, g.canonical, trade]
          );
          subRow = { id };
          stats.subsCreated++;
        } else {
          stats.subsReused++;
        }
        // Now create job_subs for each inline record
        for (const r of g.records) {
          if (!r.jobId) { stats.assignmentsSkipped++; continue; }
          // Verify the job exists
          const jobCheck = await client.query('SELECT 1 FROM jobs WHERE id = $1', [r.jobId]);
          if (!jobCheck.rows.length) { stats.assignmentsSkipped++; continue; }
          try {
            await client.query(
              `INSERT INTO job_subs (id, job_id, sub_id, level, building_id, phase_id, contract_amt, billed_to_date, status, notes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (job_id, sub_id, COALESCE(building_id, ''), COALESCE(phase_id, '')) DO UPDATE
                 SET contract_amt = EXCLUDED.contract_amt,
                     billed_to_date = EXCLUDED.billed_to_date,
                     status = EXCLUDED.status,
                     updated_at = NOW()`,
              [
                genId('jsub'),
                r.jobId, subRow.id,
                r.level || 'job',
                r.buildingId || null,
                r.phaseId || null,
                Number(r.contractAmt || r.amount || 0),
                Number(r.billedToDate || 0),
                'active',
                r.notes || null
              ]
            );
            stats.assignmentsCreated++;
          } catch (e) {
            console.warn('migrate-apply: assignment skipped:', e.message);
            stats.assignmentsSkipped++;
          }
        }
      }

      await client.query('COMMIT');
      res.json({ ok: true, ...stats });
    } catch (e) {
      await client.query('ROLLBACK').catch(function() {});
      console.error('POST /api/subs/migrate-apply error:', e);
      res.status(500).json({ error: e.message || 'Server error' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
