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
const { sendForEvent } = require('../email');

const router = express.Router();

console.log('[sub-routes] mounted at /api/subs (Phase A — sub directory + job_subs join)');

// Build the params payload + recipient list for the sub_assigned event
// and hand it to sendForEvent. Looks up sub/job after the assignment
// insert so the email reflects current data even if the request body
// only had ids.
async function notifySubAssigned({ subId, jobId, contractAmt, assignedByName }) {
  var subRow = await pool.query(
    'SELECT id, name, email, primary_contact_first FROM subs WHERE id = $1',
    [subId]
  );
  if (!subRow.rows.length || !subRow.rows[0].email) return; // no recipient
  var sub = subRow.rows[0];
  var jobData = {};
  if (jobId) {
    var j = await pool.query('SELECT data FROM jobs WHERE id = $1', [jobId]);
    if (j.rows.length) jobData = j.rows[0].data || {};
  }
  return sendForEvent('sub_assigned', {
    sub: { name: sub.name, primaryContactFirst: sub.primary_contact_first || '' },
    job: { title: jobData.title || '', jobNumber: jobData.jobNumber || '' },
    contractAmt: contractAmt,
    assignedBy: { name: assignedByName }
  }, { to: sub.email, tag: 'sub_assigned' });
}

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
      // Phase 1A: extended-detail columns (division, split address, primary
      // contact name parts, business/cell/fax phones, payment email + hold,
      // preferences + notification_prefs JSONB). All optional; existing
      // POST callers without these fields get NULLs and default JSONB.
      const result = await pool.query(`
        INSERT INTO subs (id, name, trade, contact_name, phone, email, license_no,
                          w9_on_file, w9_expires, insurance_expires, parent_sub_id, status, notes,
                          division, primary_contact_first, primary_contact_last,
                          business_phone, cell_phone, fax,
                          street_address, city, state, zip,
                          payment_email, payment_hold,
                          preferences, notification_prefs)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
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
        b.notes || null,
        b.division || null,
        b.primary_contact_first || b.primaryContactFirst || null,
        b.primary_contact_last  || b.primaryContactLast  || null,
        b.business_phone || b.businessPhone || null,
        b.cell_phone     || b.cellPhone     || null,
        b.fax            || null,
        b.street_address || b.streetAddress || null,
        b.city  || null,
        b.state || null,
        b.zip   || null,
        b.payment_email || b.paymentEmail || null,
        !!(b.payment_hold || b.paymentHold),
        b.preferences || {},
        b.notification_prefs || b.notificationPrefs || {}
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
        status: 'status', notes: 'notes',
        // Phase 1A: extended-detail fields. Both snake_case (server) and
        // camelCase (legacy/JS-friendly) keys accepted.
        division: 'division',
        primary_contact_first: 'primary_contact_first', primaryContactFirst: 'primary_contact_first',
        primary_contact_last:  'primary_contact_last',  primaryContactLast:  'primary_contact_last',
        business_phone: 'business_phone', businessPhone: 'business_phone',
        cell_phone:     'cell_phone',     cellPhone:     'cell_phone',
        fax: 'fax',
        street_address: 'street_address', streetAddress: 'street_address',
        city: 'city', state: 'state', zip: 'zip',
        payment_email: 'payment_email', paymentEmail: 'payment_email',
        payment_hold:  'payment_hold',  paymentHold:  'payment_hold',
        preferences: 'preferences',
        notification_prefs: 'notification_prefs', notificationPrefs: 'notification_prefs'
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
// Sub certificates (Phase 1B) — General liability, Worker's comp,
// W-9, Bank info. Each sub has at most one cert per type (UNIQUE
// constraint on (sub_id, cert_type)). The PDF itself lives in the
// attachments table with entity_type='sub'; this table just tracks
// the metadata layer (expiration date + reminder schedule).
// ──────────────────────────────────────────────────────────────────

// GET /api/subs/:subId/certificates — list all certs for one sub
router.get('/:subId/certificates',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT sc.*,
               a.filename AS attachment_filename,
               a.original_url AS attachment_url,
               a.mime_type AS attachment_mime
        FROM sub_certificates sc
        LEFT JOIN attachments a ON a.id = sc.attachment_id
        WHERE sc.sub_id = $1
        ORDER BY sc.cert_type
      `, [req.params.subId]);
      res.json({ certificates: rows });
    } catch (e) {
      console.error('GET /api/subs/:subId/certificates error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/subs/:subId/certificates — upsert a cert by (sub_id, cert_type).
// Body: { cert_type, attachment_id?, expiration_date?, reminder_days?,
//         reminder_direction?, reminder_limit? }
router.post('/:subId/certificates',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const certType = String(b.cert_type || b.certType || '').toLowerCase();
      if (!['gl', 'wc', 'w9', 'bank'].includes(certType)) {
        return res.status(400).json({ error: 'Invalid cert_type — must be gl, wc, w9, or bank' });
      }
      // Upsert. ON CONFLICT updates the metadata fields; attachment_id
      // is COALESCEd so a metadata-only update (e.g. user changes the
      // expiration date) doesn't wipe the existing PDF.
      const id = (b.id || ('cert_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)));
      const result = await pool.query(`
        INSERT INTO sub_certificates
          (id, sub_id, cert_type, attachment_id, expiration_date,
           reminder_days, reminder_direction, reminder_limit)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (sub_id, cert_type) DO UPDATE SET
          attachment_id = COALESCE(EXCLUDED.attachment_id, sub_certificates.attachment_id),
          expiration_date = EXCLUDED.expiration_date,
          reminder_days = EXCLUDED.reminder_days,
          reminder_direction = EXCLUDED.reminder_direction,
          reminder_limit = EXCLUDED.reminder_limit,
          updated_at = NOW()
        RETURNING *
      `, [
        id, req.params.subId, certType,
        b.attachment_id || b.attachmentId || null,
        b.expiration_date || b.expirationDate || null,
        b.reminder_days != null ? Number(b.reminder_days) : (b.reminderDays != null ? Number(b.reminderDays) : 30),
        (b.reminder_direction || b.reminderDirection || 'before'),
        b.reminder_limit != null ? Number(b.reminder_limit) : (b.reminderLimit != null ? Number(b.reminderLimit) : 5)
      ]);
      res.json({ certificate: result.rows[0] });
    } catch (e) {
      console.error('POST /api/subs/:subId/certificates error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PATCH /api/subs/:subId/certificates/:certType — partial update of one cert.
// Used for inline edits to expiration / reminder fields without re-uploading.
router.patch('/:subId/certificates/:certType',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const map = {
        attachment_id: 'attachment_id', attachmentId: 'attachment_id',
        expiration_date: 'expiration_date', expirationDate: 'expiration_date',
        reminder_days: 'reminder_days', reminderDays: 'reminder_days',
        reminder_direction: 'reminder_direction', reminderDirection: 'reminder_direction',
        reminder_limit: 'reminder_limit', reminderLimit: 'reminder_limit'
      };
      const sets = [];
      const vals = [];
      let i = 1;
      Object.keys(b).forEach(function(k) {
        if (map[k] && b[k] !== undefined) {
          sets.push(map[k] + ' = $' + i++);
          vals.push(b[k]);
        }
      });
      if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
      sets.push('updated_at = NOW()');
      vals.push(req.params.subId, req.params.certType);
      const result = await pool.query(
        'UPDATE sub_certificates SET ' + sets.join(', ') +
        ' WHERE sub_id = $' + i++ + ' AND cert_type = $' + i + ' RETURNING *',
        vals
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Certificate not found' });
      res.json({ certificate: result.rows[0] });
    } catch (e) {
      console.error('PATCH /api/subs/:subId/certificates/:certType error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /api/subs/:subId/certificates/:certType — removes the cert
// metadata row. Also deletes the underlying attachment so the PDF
// doesn't stay orphaned. Caller can re-upload to start fresh.
router.delete('/:subId/certificates/:certType',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const cur = await pool.query(
        'SELECT attachment_id FROM sub_certificates WHERE sub_id = $1 AND cert_type = $2',
        [req.params.subId, req.params.certType]
      );
      if (!cur.rows.length) return res.status(404).json({ error: 'Certificate not found' });
      const attId = cur.rows[0].attachment_id;
      await pool.query(
        'DELETE FROM sub_certificates WHERE sub_id = $1 AND cert_type = $2',
        [req.params.subId, req.params.certType]
      );
      // Best-effort attachment cleanup. The cert row was already deleted
      // so a failure here is logged but not surfaced — orphan cleanup
      // can run separately if it ever becomes a problem.
      if (attId) {
        try { await pool.query('DELETE FROM attachments WHERE id = $1', [attId]); }
        catch (cleanupErr) { console.warn('Sub cert attachment cleanup failed:', cleanupErr.message); }
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/subs/:subId/certificates/:certType error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Per-job assignments (job_subs)
// ──────────────────────────────────────────────────────────────────

// Phase 1C: GET /api/subs/:subId/jobs — list jobs this sub is
// assigned to. Inverted view of /jobs/:jobId so the sub-edit modal
// can render its Job access tab without a second join. Returns the
// minimal fields the UI needs (job name + status + dates) joined
// from the jobs table; full assignment metadata is on each row in
// case the modal grows to surface contract amounts later.
router.get('/:subId/jobs',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT js.id AS assignment_id, js.job_id, js.level, js.building_id,
               js.phase_id, js.contract_amt, js.billed_to_date, js.status,
               js.created_at AS assigned_at,
               j.data AS job_data
        FROM job_subs js
        LEFT JOIN jobs j ON j.id = js.job_id
        WHERE js.sub_id = $1
        ORDER BY js.created_at DESC
      `, [req.params.subId]);
      // Pluck the human-readable bits out of the jobs.data JSONB so
      // the client doesn't have to decode the whole blob just to show
      // a row.
      const out = rows.map(r => ({
        assignment_id: r.assignment_id,
        job_id: r.job_id,
        level: r.level,
        building_id: r.building_id,
        phase_id: r.phase_id,
        contract_amt: r.contract_amt,
        billed_to_date: r.billed_to_date,
        status: r.status,
        assigned_at: r.assigned_at,
        job_title: r.job_data ? (r.job_data.title || r.job_data.name || null) : null,
        job_number: r.job_data ? (r.job_data.jobNumber || null) : null,
        job_status: r.job_data ? (r.job_data.status || null) : null
      }));
      res.json({ assignments: out });
    } catch (e) {
      console.error('GET /api/subs/:subId/jobs error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

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

      // Fire sub_assigned notification (gated by isEventEnabled in
      // sendForEvent). Fire-and-forget — failures land in email_log
      // but don't block the response. Only fires for the top-level
      // 'job' assignment row, not building/phase children, to avoid
      // re-notifying when an admin is just refining the assignment level.
      if ((b.level || 'job') === 'job') {
        notifySubAssigned({
          subId: subId,
          jobId: req.params.jobId,
          contractAmt: Number(b.contract_amt || b.contractAmt || 0),
          assignedByName: (req.user && req.user.name) || (req.user && req.user.email) || 'AGX'
        }).catch(function(e) { console.warn('[sub_assigned] notify failed:', e && e.message); });
      }
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

// ───────────────────────────────────────────────────────────────────
// Phase 4: per-folder sub access. Grants live in
// `attachment_folder_grants`; each row = "sub X can see folder F on
// (entity_type, entity_id)". PMs grant/revoke from the attachment UI
// or sub editor; the future sub-facing portal reads these to surface
// only what each sub is allowed to see.
// ───────────────────────────────────────────────────────────────────

// Sanitize a free-text folder to match the rule used elsewhere
// (PUT /api/attachments/:id, POST /api/attachments/:id/move). Empty
// → 'general'.
function sanitizeFolder(s) {
  return String(s == null ? '' : s)
    .trim().slice(0, 60).toLowerCase()
    .replace(/[^a-z0-9 _\-]/g, '').replace(/\s+/g, '-') || 'general';
}

// GET /api/subs/:subId/attachment-grants — list every grant for one
// sub. Joined with the underlying entity name for display purposes
// (left-join so orphaned grants — entity deleted out from under us —
// still surface so a PM can clean them up).
router.get('/:subId/attachment-grants',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT g.id, g.sub_id, g.entity_type, g.entity_id, g.folder,
                g.granted_by, g.granted_at,
                u.username AS granted_by_username
           FROM attachment_folder_grants g
           LEFT JOIN users u ON u.id = g.granted_by
          WHERE g.sub_id = $1
          ORDER BY g.granted_at DESC`,
        [req.params.subId]
      );
      res.json({ grants: rows });
    } catch (e) {
      console.error('GET /api/subs/:subId/attachment-grants error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

// POST /api/subs/:subId/attachment-grants — grant access. Body:
//   { entity_type: 'job'|'lead'|'estimate'|'client'|'sub',
//     entity_id:  '<id>',
//     folder?:    'photos' (default 'general') }
// Idempotent — repeat grants no-op via the UNIQUE index.
router.post('/:subId/attachment-grants',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const subR = await pool.query('SELECT id FROM subs WHERE id = $1', [req.params.subId]);
      if (!subR.rows.length) return res.status(404).json({ error: 'Sub not found' });

      const b = req.body || {};
      const entity_type = String(b.entity_type || '').trim();
      const entity_id   = String(b.entity_id   || '').trim();
      if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type and entity_id are required' });
      const VALID = ['lead', 'estimate', 'client', 'job', 'sub'];
      if (VALID.indexOf(entity_type) === -1) return res.status(400).json({ error: 'invalid entity_type' });

      const folder = sanitizeFolder(b.folder);
      const id = genId('afg');
      const granted_by = (req.user && req.user.id) || null;

      const { rows } = await pool.query(
        `INSERT INTO attachment_folder_grants
           (id, sub_id, entity_type, entity_id, folder, granted_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sub_id, entity_type, entity_id, folder) DO UPDATE
           SET granted_at = NOW(), granted_by = EXCLUDED.granted_by
         RETURNING *`,
        [id, req.params.subId, entity_type, entity_id, folder, granted_by]
      );
      res.json({ grant: rows[0] });
    } catch (e) {
      console.error('POST /api/subs/:subId/attachment-grants error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

// DELETE /api/subs/:subId/attachment-grants/:grantId — revoke.
router.delete('/:subId/attachment-grants/:grantId',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM attachment_folder_grants WHERE id = $1 AND sub_id = $2',
        [req.params.grantId, req.params.subId]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Grant not found' });
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/subs/:subId/attachment-grants/:grantId error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

// GET /api/subs/:subId/shared-attachments — list every attachment a
// sub can see, scoped to their grants. Returns rows with the entity
// they came from + folder so a PM can preview the sub's view (and the
// future portal reads from this same shape). Orphan grants (entity
// since deleted) drop out via the INNER JOIN on attachments.
router.get('/:subId/shared-attachments',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT a.*, g.folder AS grant_folder,
                g.entity_type AS grant_entity_type,
                g.entity_id AS grant_entity_id,
                g.granted_at
           FROM attachment_folder_grants g
           JOIN attachments a
             ON a.entity_type = g.entity_type
            AND a.entity_id   = g.entity_id
            AND a.folder      = g.folder
          WHERE g.sub_id = $1
          ORDER BY g.entity_type, g.entity_id, g.folder, a.position`,
        [req.params.subId]
      );
      res.json({ attachments: rows });
    } catch (e) {
      console.error('GET /api/subs/:subId/shared-attachments error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

module.exports = router;
