const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireOrgId, resolveOrgId, isAdminish } = require('../auth');
const { sendEmail } = require('../email');
const { jobAssigned } = require('../email-templates');
const markets = require('../services/markets');

const router = express.Router();

// Multi-market — resolve a job blob's market to the market_id FK.
// Jobs carry their market as a NAME inside the JSONB (`data.market`;
// there is no market column on jobs), so this maps that name onto the
// column every write, which is what keeps the FK from going stale when
// someone re-markets a job. Best-effort: a markets lookup failure
// returns null and the write proceeds unassigned — market is additive
// and nullable, and the re-runnable admin backfill catches strays.
async function marketIdForJob(job, orgId, client) {
  try {
    const map = await markets.loadMarketMap(orgId, client);
    return markets.resolveMarketId(map, job || {});
  } catch (e) {
    console.warn('[jobs] market resolve failed:', e && e.message);
    return null;
  }
}

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

// ── ORG FIRST, THEN ROLE ────────────────────────────────────────────────────
// These three gates used to answer `true` for any adminish (and, in canAccess,
// corporate) caller BEFORE touching the database. That short-circuit is why
// putting an org predicate on the `jobs` statements below would have fixed
// nothing: for the callers that matter the statement never ran at all.
//
// Every route in this file that takes a caller-supplied :id and then reads or
// writes a JOB-KEYED table — node_graphs, job_access — is gated by one of
// these and by nothing else. So the tenant check has to live here, ahead of
// the role check, or an org-A admin reaches an org-B job's site plan and share
// list through a guessable id.
//
// Tolerance arm unchanged: a NULL organization_id is legacy and still passes,
// exactly as `OR organization_id IS NULL` does on every read in this file.
// A row with no org is not this commit's business; a row with SOMEONE ELSE'S
// org is.
function orgAllows(rowOrg, callerOrg) {
  if (rowOrg == null) return true;                 // legacy / un-stamped
  if (callerOrg == null) return false;             // caller has no tenant: a stamped row is not theirs
  return Number(rowOrg) === Number(callerOrg);
}

// The caller's tenant, server-derived. requireOrgId is not on the read routes
// (adding it would turn a 403/404 into a 409 for callers who work today), so
// resolve the same way it does — from the verified token, with the users-row
// fallback for legacy claim-less tokens. Never from the body.
async function callerOrgId(req) {
  if (req.orgId != null) return req.orgId;
  try {
    const o = await resolveOrgId(req);
    if (o != null) req.orgId = o;
    return o;
  } catch (e) {
    // "I cannot tell" — refuse rather than guess. Reads only; the write
    // routes carry requireOrgId, which answers 503 for this case.
    console.warn('[jobs] caller org resolution failed:', e && e.message);
    return null;
  }
}

async function canAccess(userId, userRole, jobId, req) {
  const { rows } = await pool.query(
    'SELECT owner_id, organization_id FROM jobs WHERE id = $1', [jobId]);
  // Tenant before role. A missing row is left to the route (which answers 404
  // rather than 403, so existence is not leaked by the gate either way).
  if (rows.length && !orgAllows(rows[0].organization_id, await callerOrgId(req))) return false;
  if (isAdminish(userRole) || userRole === 'corporate') return true;
  if (!rows.length) return false;
  if (rows[0].owner_id === userId) return true;
  const access = await pool.query('SELECT 1 FROM job_access WHERE job_id = $1 AND user_id = $2', [jobId, userId]);
  return access.rows.length > 0;
}

async function canEdit(userId, userRole, jobId, req) {
  const { rows } = await pool.query(
    'SELECT owner_id, organization_id FROM jobs WHERE id = $1', [jobId]);
  if (rows.length && !orgAllows(rows[0].organization_id, await callerOrgId(req))) return false;
  if (isAdminish(userRole)) return true;
  if (userRole === 'corporate') return false;
  if (!rows.length) return false;
  if (rows[0].owner_id === userId) return true;
  const access = await pool.query("SELECT access_level FROM job_access WHERE job_id = $1 AND user_id = $2", [jobId, userId]);
  return access.rows.length > 0 && access.rows[0].access_level === 'edit';
}

// GET /api/jobs
// Everyone authenticated sees every job. Edit rights are conveyed via _canEdit
// on each row so the client can render read-only indicators and skip non-editable
// jobs from its bulk-save payload.
router.get('/', requireAuth, async (req, res) => {
  try {
    // Wave 1.A Phase 2 — list scoped to caller's org. Rows with NULL
    // organization_id (unbackfilled legacy) are included so existing
    // data remains visible until the NOT NULL tightening commit.
    const { rows } = await pool.query(`
      SELECT j.id, j.data, j.owner_id, j.created_at, j.updated_at,
             j.geocode_lat, j.geocode_lng, j.geocode_address, j.market_id,
             COALESCE(ja.access_level, '') AS access_level
      FROM jobs j
      LEFT JOIN job_access ja ON ja.job_id = j.id AND ja.user_id = $1
      WHERE j.organization_id = $2 OR j.organization_id IS NULL
    `, [req.user.id, req.user.organization_id]);
    const result = rows.map(j => {
      let canEdit = false;
      if (isAdminish(req.user)) canEdit = true;
      else if (req.user.role === 'corporate') canEdit = false;
      else if (j.owner_id === req.user.id) canEdit = true;
      else if (j.access_level === 'edit') canEdit = true;
      // Spread `data` FIRST so canonical column values (id, owner_id)
      // override any stale copies that may have crept into the JSONB
      // blob via a prior bulk-save round-trip. owner_id specifically
      // is mutable via PUT /:id/owner, so the column is the truth.
      // geocode_* columns power the Jobs map view (filled lazily by the
      // weather route's ensureGeocode).
      return { ...j.data, id: j.id, owner_id: j.owner_id, _canEdit: canEdit,
        // Base version for optimistic concurrency on bulk save (millisecond ISO).
        _updatedAt: j.updated_at ? new Date(j.updated_at).toISOString() : null,
        geocode_lat: j.geocode_lat, geocode_lng: j.geocode_lng, geocode_address: j.geocode_address,
        // Multi-market — the FK column, stringified to match how the
        // client compares market ids everywhere else. The blob's legacy
        // `market` NAME still rides along inside the spread above; the
        // shared p86Markets predicate prefers this and falls back to it.
        market_id: j.market_id != null ? String(j.market_id) : null };
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
    if (!(await canAccess(req.user.id, req.user.role, req.params.id, req))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // Wave 1.A Phase 2 — org filter at the SQL layer. Cross-org access
    // returns 404 (not 403) so we don't leak existence info.
    const { rows } = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
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
router.post('/', requireAuth, requireOrgId, requireRole('admin', 'pm'), async (req, res) => {
  try {
    const id = req.body.id || 'job' + Date.now();
    let ownerId = req.user.id;
    if (isAdminish(req.user) && req.body.owner_id) {
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1 AND active = true', [req.body.owner_id]);
      if (!rows.length) return res.status(400).json({ error: 'Invalid owner_id' });
      ownerId = req.body.owner_id;
    }
    // Wave 1.A — include organization_id on every new write so the
    // org-filtering routes (next commit) find this row immediately.
    // Multi-market — stamp market_id at birth so a new job never has to
    // wait on the backfill to show up in its market's P&L.
    const marketId = await marketIdForJob(req.body, req.user.organization_id);
    await pool.query(
      'INSERT INTO jobs (id, owner_id, data, organization_id, market_id) VALUES ($1, $2, $3, $4, $5)',
      [id, ownerId, JSON.stringify(req.body), req.user.organization_id, marketId]
    );

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

// POST /api/jobs/convert — atomically create a job from a lead and/or estimate
// and wire up the links in ONE transaction, so a partial failure can't leave an
// orphan job (the old client-side flow's failure mode). Establishes:
//   • jobs.lead_id / jobs.estimate_id  (provenance, queryable both ways)
//   • leads.job_id + lead.status = 'sold'
//   • estimate.data.job_id            (powers the Estimates "Won" filter)
// Body: { job: {…full job blob incl contractAmount + workbook}, lead_id?, estimate_id? }
router.post('/convert', requireAuth, requireOrgId, requireRole('admin', 'pm'), async (req, res) => {
  const client = await pool.connect();
  try {
    const job = (req.body && req.body.job) || {};
    const leadId = (req.body && req.body.lead_id) || null;
    const estimateId = (req.body && req.body.estimate_id) || null;
    if (!leadId && !estimateId) {
      return res.status(400).json({ error: 'lead_id or estimate_id is required' });
    }
    // Every job must carry a job number — S#### (Service) or RV#### (Renovation).
    if (!/^(S|RV)\d{1,6}$/i.test(String((job && job.jobNumber) || '').trim())) {
      return res.status(400).json({ error: 'A job number (S#### or RV####) is required to create a job.' });
    }
    const orgId = req.user.organization_id;

    // Resolve owner (mirror POST /): admins may assign, others own their own.
    let ownerId = req.user.id;
    if (isAdminish(req.user) && job.owner_id) {
      const u = await pool.query('SELECT id FROM users WHERE id = $1 AND active = true', [job.owner_id]);
      if (!u.rows.length) return res.status(400).json({ error: 'Invalid owner_id' });
      ownerId = job.owner_id;
    }

    // Guard: don't double-convert a lead that's already linked to a job.
    // Also grab the lead's market_id — the conversion is where a market
    // is inherited down the chain lead -> job -> estimate.
    let leadMarketId = null;
    if (leadId) {
      const lr = await pool.query(
        'SELECT job_id, market_id FROM leads WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
        [leadId, orgId]
      );
      if (!lr.rows.length) return res.status(404).json({ error: 'Lead not found' });
      if (lr.rows[0].job_id) {
        return res.status(409).json({ error: 'Lead already linked to a job', job_id: lr.rows[0].job_id });
      }
      leadMarketId = lr.rows[0].market_id || null;
    }

    const id = job.id || 'job' + Date.now();

    // Market for the converted job: what the job blob names wins (the
    // convert dialog carries the lead's market forward and the user can
    // have corrected it), with the lead's own FK as the fallback for a
    // lead whose market was assigned by id rather than by name.
    const jobMarketId = (await marketIdForJob(job, orgId)) || leadMarketId;

    await client.query('BEGIN');
    await client.query(
      'INSERT INTO jobs (id, owner_id, data, organization_id, lead_id, estimate_id, market_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, ownerId, JSON.stringify(job), orgId, leadId, estimateId, jobMarketId]
    );
    if (leadId) {
      await client.query(
        "UPDATE leads SET job_id = $1, status = 'sold', converted_at = COALESCE(converted_at, NOW()), status_changed_at = NOW(), lost_at = NULL, updated_at = NOW() WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
        [id, leadId, orgId]
      );
      // Carry the lead's captured receipts forward to the new job. They keep
      // is_presale=true (pre-award pursuit costs) so they show under "Pre-sale"
      // on the job — UNLESS roll_presale_to_cost is set, which folds them into
      // job COGS (is_presale=false). status is unaffected (still entity+amount).
      const rollPresale = !!(req.body && req.body.roll_presale_to_cost);
      await client.query(
        "UPDATE receipts SET entity_type = 'job', entity_id = $1, is_presale = CASE WHEN $2 THEN FALSE ELSE is_presale END, updated_at = NOW() WHERE entity_type = 'lead' AND entity_id = $3 AND organization_id = $4",
        [id, rollPresale, leadId, orgId]
      );
      // Carry the lead's Site Plan survey graph (traced footprints + saved
      // measurements + photo pins) forward into the new job's node_graph, so
      // the salesperson's field survey becomes the PM's starting site plan.
      // No-op when the lead has no survey (SELECT returns 0 rows).
      await client.query(
        // Stamp the org too — node_graphs carries organization_id and this
        // insert was leaving it NULL, which lands the site plan of a brand-new
        // job outside the tenant boundary the job itself is inside.
        `INSERT INTO node_graphs (job_id, data, organization_id)
         SELECT $1, data, $3 FROM lead_graphs WHERE lead_id = $2
         ON CONFLICT (job_id) DO NOTHING`,
        [id, leadId, orgId]
      );
    }
    if (estimateId) {
      // Estimates keep their fields in a JSONB `data` blob — stamp job_id +
      // status:'sold' there, and lock the row so it can't be edited after the
      // lead is won (an admin can unlock via PUT /api/estimates/:id/lock).
      // market_id rides along via COALESCE: the sold estimate inherits
      // the job's market when it doesn't already have one, and an
      // estimate that WAS already assigned keeps its own. A conversion
      // must never silently re-market an estimate that has one.
      await client.query(
        "UPDATE estimates SET data = jsonb_set(jsonb_set(COALESCE(data, '{}'::jsonb), '{job_id}', to_jsonb($1::text)), '{status}', to_jsonb('sold'::text)), is_locked = TRUE, accepted_at = COALESCE(accepted_at, NOW()), market_id = COALESCE(market_id, $4), updated_at = NOW() WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
        [id, estimateId, orgId, jobMarketId]
      );
    }
    await client.query('COMMIT');

    res.json({ ok: true, id: id, job_id: id, owner_id: ownerId, lead_id: leadId, estimate_id: estimateId });

    // Geocode the carried address (after the response; best-effort) so the map /
    // weather / Site Plan satellite get coordinates with no manual step. A failure
    // here can never affect the committed conversion.
    try {
      var _convAddr = (job && job.address) || (job ? [job.street_address, job.city, job.state, job.zip].filter(Boolean).join(', ') : '');
      if (_convAddr) {
        const { geocodeAddress } = require('../geocoder');
        Promise.resolve(geocodeAddress(_convAddr)).then(function (g) {
          if (g && Number.isFinite(g.lat) && Number.isFinite(g.lng) && !(g.lat === 0 && g.lng === 0)) {
            pool.query(
              "UPDATE jobs SET geocode_lat=$1, geocode_lng=$2, geocode_status='ok', geocode_address=$3, geocode_at=NOW() WHERE id=$4 AND (organization_id=$5 OR organization_id IS NULL)",
              [g.lat, g.lng, _convAddr, id, orgId]
            ).catch(function () {});
          }
        }).catch(function () {});
      }
    } catch (_) {}
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/jobs/convert error:', e);
    res.status(500).json({ error: 'Server error: ' + (e && e.message) });
  } finally {
    client.release();
  }
});

// POST /api/jobs/:id/link-estimate — attach an estimate to an EXISTING job (the
// backfill case: a lead-only job that had no cost basis, or re-syncing costs
// after the estimate changed). The estimate is the source of truth for the
// job's estimated costs, so the client passes the freshly-computed contract
// (proposal total) + estimatedCosts (base cost) + workspace snapshot; we merge
// them into the job, set jobs.estimate_id, and stamp estimate.data.job_id —
// all atomic. Mirrors /convert but UPDATEs instead of INSERTing.
router.post('/:id/link-estimate', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!(await canEdit(req.user.id, req.user.role, req.params.id, req))) {
      return res.status(403).json({ error: 'No edit access' });
    }
    const estimateId = req.body && req.body.estimate_id;
    if (!estimateId) return res.status(400).json({ error: 'estimate_id is required' });
    const orgId = req.user.organization_id;
    const contractAmount = req.body.contractAmount;
    const estimatedCosts = req.body.estimatedCosts;
    const workbook = req.body.workbook;

    await client.query('BEGIN');
    const jr = await client.query(
      'SELECT data, lead_id FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) FOR UPDATE',
      [req.params.id, orgId]
    );
    if (!jr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job not found' }); }
    const er = await client.query(
      'SELECT data FROM estimates WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [estimateId, orgId]
    );
    if (!er.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Estimate not found' }); }

    let data = jr.rows[0].data || {};
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { data = {}; } }
    data.estimate_id = estimateId;
    if (typeof contractAmount === 'number') data.contractAmount = contractAmount;
    if (typeof estimatedCosts === 'number') data.estimatedCosts = estimatedCosts;
    if (workbook && typeof workbook === 'object') data.workbook = workbook;
    const estData = er.rows[0].data || {};
    const estLeadId = (estData && estData.lead_id) || null;
    const newLeadId = jr.rows[0].lead_id || data.lead_id || estLeadId || null;
    if (newLeadId) data.lead_id = newLeadId;

    await client.query(
      'UPDATE jobs SET data = $1, estimate_id = $2, lead_id = $3, updated_at = NOW() WHERE id = $4 AND (organization_id = $5 OR organization_id IS NULL)',
      [JSON.stringify(data), estimateId, newLeadId, req.params.id, orgId]
    );
    await client.query(
      "UPDATE estimates SET data = jsonb_set(jsonb_set(COALESCE(data, '{}'::jsonb), '{job_id}', to_jsonb($1::text)), '{status}', to_jsonb('sold'::text)), is_locked = TRUE, updated_at = NOW() WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
      [req.params.id, estimateId, orgId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, id: req.params.id, estimate_id: estimateId, lead_id: newLeadId });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/jobs/:id/link-estimate error:', e);
    res.status(500).json({ error: 'Server error: ' + (e && e.message) });
  } finally {
    client.release();
  }
});

// PUT /api/jobs/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    if (!(await canEdit(req.user.id, req.user.role, req.params.id, req))) {
      return res.status(403).json({ error: 'No edit access' });
    }
    // Wave 1.A Phase 2 — org-scoped UPDATE. Returns affected row count
    // so we can 404 cross-org writes instead of silently no-op'ing.
    const u = await pool.query(
      "UPDATE jobs SET data = $1, updated_at = NOW() WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
      [JSON.stringify(req.body), req.params.id, req.user.organization_id]
    );
    if (u.rowCount === 0) return res.status(404).json({ error: 'Job not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// Workspace persistence — surgical jsonb_set on data.workbook
//
// Mirrors the estimates side. Without these endpoints, saving the
// workbook would require either round-tripping the entire job data
// blob (lossy + racy with non-workbook edits) or staying on
// localStorage (which 86 can't read and which doesn't survive a
// device switch). These touch ONLY data.workbook.
//
// Auth: canEdit gate — same as PUT /:id. Reads only require canAccess.
// ──────────────────────────────────────────────────────────────────

// GET /api/jobs/:id/workbook
router.get('/:id/workbook', requireAuth, async (req, res) => {
  try {
    if (!(await canAccess(req.user.id, req.user.role, req.params.id, req))) {
      return res.status(403).json({ error: 'No access' });
    }
    const { rows } = await pool.query(
      `SELECT data->'workbook' AS workbook
         FROM jobs
        WHERE id = $1
          AND (organization_id = $2 OR organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    res.json({ workbook: rows[0].workbook || null });
  } catch (e) {
    console.error('GET /api/jobs/:id/workbook error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/jobs/:id/workbook — body is the workbook JSON itself.
router.put('/:id/workbook', requireAuth, async (req, res) => {
  try {
    if (!(await canEdit(req.user.id, req.user.role, req.params.id, req))) {
      return res.status(403).json({ error: 'No edit access' });
    }
    const wb = req.body;
    if (!wb || typeof wb !== 'object') {
      return res.status(400).json({ error: 'workbook body required' });
    }
    const u = await pool.query(
      `UPDATE jobs
          SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{workbook}', $1::jsonb, true),
              updated_at = NOW()
        WHERE id = $2
          AND (organization_id = $3 OR organization_id IS NULL)`,
      [JSON.stringify(wb), req.params.id, req.user.organization_id]
    );
    if (u.rowCount === 0) return res.status(404).json({ error: 'Job not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/jobs/:id/workbook error:', e);
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
    // Wave 1.A Phase 2 — org-scoped owner reassignment. Both the read
    // and the write are filtered. Also reject reassignment to a user
    // in a DIFFERENT org (would orphan the job into the wrong tenant).
    const jobCheck = await pool.query(
      'SELECT id, owner_id, data FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error: 'Job not found' });
    const newOwnerOrg = await pool.query('SELECT organization_id FROM users WHERE id = $1', [ownerId]);
    if (!newOwnerOrg.rows.length || newOwnerOrg.rows[0].organization_id !== req.user.organization_id) {
      return res.status(400).json({ error: 'Cannot reassign job to a user in a different organization' });
    }
    const priorOwnerId = jobCheck.rows[0].owner_id;
    await pool.query(
      'UPDATE jobs SET owner_id = $1, updated_at = NOW() WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
      [ownerId, req.params.id, req.user.organization_id]
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
    // Wave 1.A Phase 2 — org-scoped DELETE. 404 cross-org.
    const d = await pool.query(
      'DELETE FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    if (d.rowCount === 0) return res.status(404).json({ error: 'Job not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper: only admin or job owner can manage access for a given job.
//
// Org first, then role — same reason as canAccess/canEdit above, and the stake
// here is higher: what this gates is an INSERT INTO job_access, a DURABLE
// cross-tenant edit grant that outlives any predicate later added to `jobs`.
// A job in another tenant reads as "not found" (null), never as 403, so the
// answer is identical to a job id that does not exist.
async function canManageAccess(req, jobId) {
  const { rows } = await pool.query(
    'SELECT owner_id, organization_id FROM jobs WHERE id = $1', [jobId]);
  if (!rows.length) return null; // job not found
  if (!orgAllows(rows[0].organization_id, await callerOrgId(req))) return null;
  if (isAdminish(req.user)) return true;
  return rows[0].owner_id === req.user.id;
}

// GET /api/jobs/:id/access — list users with explicit access plus the owner
router.get('/:id/access', requireAuth, async (req, res) => {
  try {
    if (!(await canAccess(req.user.id, req.user.role, req.params.id, req))) {
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
    // The GRANTEE is a tenancy decision too, and it arrived from the body with
    // no check of any kind — not existence, not active, not org. Both ends of
    // a share have to be inside the caller's tenant or the grant is a
    // cross-tenant one, and it survives everything done to `jobs`.
    const grantee = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND organization_id = $2',
      [userId, await callerOrgId(req)]
    );
    if (!grantee.rows.length) return res.status(400).json({ error: 'Invalid userId' });
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
router.put('/bulk/save', requireAuth, requireOrgId, requireRole('admin', 'pm'), async (req, res) => {
  try {
    const { appData, baseVersions } = req.body;
    if (!appData || !appData.jobs) return res.status(400).json({ error: 'Invalid appData' });
    // Optimistic concurrency. The client sends baseVersions = { jobId: base }
    // for every job it believes already exists here, where base is either the
    // updated_at it loaded, or UNVERSIONED_BASE when it holds the row but not
    // its version. Three answers, and only the third writes:
    //   the row is GONE          → conflict 'deleted'      (never re-create it)
    //   the base cannot be
    //     compared to the row    → conflict 'unverifiable' (never force it)
    //   the base does not match  → conflict 'stale'
    // A job with NO entry is a job the client is CREATING — that absence is the
    // only thing that authorises an INSERT of a new id.
    //
    // An old client that sends no baseVersions at all still writes as before.
    // That is deliberate back-compat for the deploy swap, not a standing
    // permission: every shipped client build sends them.
    const UNVERSIONED_BASE = 'unversioned';
    const bv = (baseVersions && typeof baseVersions === 'object') ? baseVersions : {};
    const conflicts = [];
    const versions = {};

    // Multi-market — one markets lookup for the whole batch. This is the
    // path a market CHANGE travels (the job picker writes data.market and
    // saves through here), so without it the FK would be correct only
    // until the first re-market and the backfill would never repair it
    // (the backfill only fills NULLs, by design).
    // The tenant this batch writes into. requireOrgId guarantees it is
    // non-null and server-derived; the handler is unreachable otherwise.
    // market is the OPERATING dimension and never stands in for this.
    const orgId = req.orgId;

    let marketMap = null;
    try {
      marketMap = await markets.loadMarketMap(orgId);
    } catch (e) {
      console.warn('[jobs] bulk market map load failed:', e && e.message);
    }

    // ── owner_id is a SECOND tenancy pointer, and it comes from the body ──
    // jobs has two org sources, not one:
    //   • the organization_id COLUMN — what job-routes.js reads
    //   • owner_id -> users.organization_id — what org-access.js reads
    //     ("Scoping source of truth" in its header), which is how
    //     assertEntityInOrg('job') gates change-orders and schedule entries.
    // Stamping the column alone would leave the second one caller-chosen:
    // `job.owner_id` is request data, and the strip at `delete jobBlob.owner_id`
    // CANNOT reach it (jobBlob is a copy; the assignment below reads `job`).
    // An admin could then create a job stamped to their own org while pointing
    // owner_id at another tenant's user, and the two sources would disagree —
    // a divergence no NULL check, and no future NOT NULL, could ever see.
    //
    // POST / and PUT /:id/owner already validate this ("would orphan the job
    // into the wrong tenant"). This path was the door that didn't.
    //
    // Validated once for the batch rather than per row. Membership only, NOT
    // `active = true`: tenancy is the security property, and a deactivated
    // user still has an org — refusing there would block admins from saving
    // jobs whose owner was since deactivated, which is not this fix's business.
    const wantedOwnerIds = [];
    if (isAdminish(req.user)) {
      for (const j of appData.jobs) {
        const n = Number(j && j.owner_id);
        if (Number.isInteger(n) && n > 0 && n !== Number(req.user.id)) wantedOwnerIds.push(n);
      }
    }
    const ownerIdsInOrg = new Set();
    if (wantedOwnerIds.length) {
      const ow = await pool.query(
        'SELECT id FROM users WHERE id = ANY($1::int[]) AND organization_id = $2',
        [[...new Set(wantedOwnerIds)], orgId]
      );
      for (const r of ow.rows) ownerIdsInOrg.add(Number(r.id));
    }

    const client = await pool.connect();
    let saved = 0;
    let skipped = 0;
    try {
      await client.query('BEGIN');
      // Deterministic lock order — the other half of the QB import
      // deadlock fix (see the header comment in qb-cost-routes.js).
      //
      // This loop takes `SELECT … FOR UPDATE` on every job row and holds
      // it to COMMIT. The QB cost import takes FOR KEY SHARE on the SAME
      // rows, because every INSERT INTO qb_cost_lines fires the
      // job_id → jobs(id) FK check. FOR KEY SHARE conflicts with FOR
      // UPDATE, so when the two walked the same ~25 jobs in different
      // orders — appData order here (Postgres heap order, unstable: the
      // jobs GET has no ORDER BY), QB report order there — they formed a
      // cycle and Postgres killed one of them. That is what wrote 0 of
      // 1205 cost rows on the 08.13.26 import.
      //
      // Both routes now walk jobs in ascending id order, so neither can
      // ever be behind the other on a row the other already holds. Order
      // is not otherwise meaningful here: each iteration is self-contained
      // and every result is keyed by job id, not by position.
      const ordered = [...appData.jobs].sort((a, b) => {
        const x = String((a && a.id) || '');
        const y = String((b && b.id) || '');
        return x < y ? -1 : x > y ? 1 : 0;
      });
      for (const job of ordered) {
        // Defense in depth: even if the client sends jobs the user can't edit,
        // we re-check here. Admins can edit anything; PMs need ownership or
        // explicit job_access edit grant; corporate is read-only.
        // FOR UPDATE locks the row for the txn so the version check below cannot
        // race a concurrent write between the read and the UPDATE.
        // organization_id rides in the PROJECTION, not in the WHERE clause.
        //
        // Filtering the read (`AND (organization_id = $2 OR IS NULL)`) looks
        // like the smaller change and is strictly worse: a filtered SELECT can
        // only say "no rows", and "no rows" is already load-bearing here. A
        // foreign-tenant row would land in the `!existing.rows.length` branch —
        //   with a base → conflict 'deleted', which the client escalates to the
        //     unrecoverable-data-loss modal, for a row that is alive and
        //     untouched in another tenant;
        //   with no base → straight through to INSERT … ON CONFLICT (id) DO
        //     UPDATE, which finds the foreign row BY PRIMARY KEY and overwrites
        //     it anyway.
        // The predicate on the SELECT does not close this. It relocates it into
        // the arm that has no guard at all. So the read stays unfiltered and
        // the tenant becomes data that the branch below decides on, under the
        // same lock, with no second round-trip and no TOCTOU.
        const existing = await client.query(
          'SELECT owner_id, updated_at, organization_id FROM jobs WHERE id = $1 FOR UPDATE', [job.id]
        );
        // ── the row belongs to ANOTHER TENANT ────────────────────────────────
        // Terminal, and deliberately NOT 'deleted': the two carry the same
        // serverUpdatedAt: null, so the reason string is the only discriminator
        // on the wire and they mean opposite things. 'deleted' = the row you
        // loaded is gone and your edit is unrecoverable. 'not_in_org' = this row
        // was never yours, nothing of yours was lost, and no data-loss modal is
        // warranted.
        if (existing.rows.length) {
          const rowOrg = existing.rows[0].organization_id;
          if (rowOrg != null && Number(rowOrg) !== Number(orgId)) {
            conflicts.push({ id: job.id, reason: 'not_in_org', serverUpdatedAt: null });
            continue;
          }
        }
        const base = bv[job.id];
        // ── the row is GONE and the client believes it exists ────────────────
        // A baseVersions entry means exactly one thing: "I loaded this row and
        // I expect it to be there." If it is not there, somebody deleted it —
        // and an INSERT here puts a record a human deliberately removed back
        // into a live database, on screen, with nothing saying so.
        //
        // That is not hypothetical and it is not rare. The client holds a
        // hydrate open while it carries an unpushed change (the whole point of
        // the hold is to keep a dirty id alive across a refresh), so a delete
        // landing inside a Railway deploy window arrives at this INSERT with a
        // base attached. Silent data loss became silent resurrection.
        //
        // The correct answer to "the row you loaded is gone" is a CONFLICT, not
        // a create. The client reloads, the row stays deleted, and the user is
        // told which row it was and that the change to it could not be saved.
        //
        // A genuinely NEW job sends no base (it has never been loaded, so there
        // is no _updatedAt to send), falls through this branch, and inserts
        // exactly as before. That asymmetry is the whole design: absence of a
        // base means "create", presence of a base means "must already exist".
        if (!existing.rows.length) {
          if (base) {
            conflicts.push({ id: job.id, reason: 'deleted', serverUpdatedAt: null });
            continue;
          }
        } else {
          let canEdit = false;
          if (isAdminish(req.user)) canEdit = true;
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
          // Version guard: only when the client provided a base for this job.
          // Compare at millisecond ISO precision (both sides serialize a JS Date
          // the same way), so no sub-millisecond mismatch. If they differ, the
          // row moved on since the client loaded it — record a conflict, skip.
          if (base) {
            const serverTs = existing.rows[0].updated_at
              ? new Date(existing.rows[0].updated_at).toISOString() : null;
            // A base we cannot COMPARE is not a base. Both directions of that
            // used to fall through to the write:
            //   - the client sends UNVERSIONED_BASE, meaning "this row exists
            //     and I cannot prove which version I am holding"
            //   - the row's own updated_at is NULL (the column is nullable —
            //     server/db.js, jobs.updated_at TIMESTAMPTZ DEFAULT NOW())
            // In both, the previous `if (serverTs && serverTs !== base)` did
            // nothing and a stale copy overwrote a newer row wholesale, money
            // fields included. Refusing is the only honest answer: the client
            // reloads, learns the current version, and the user is told the
            // write was refused rather than finding a reverted budget later.
            if (!serverTs || base === UNVERSIONED_BASE) {
              conflicts.push({ id: job.id, reason: 'unverifiable', serverUpdatedAt: serverTs });
              continue;
            }
            if (serverTs !== base) {
              conflicts.push({ id: job.id, reason: 'stale', serverUpdatedAt: serverTs });
              continue;
            }
          }
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
        // market_id is a COLUMN (hydrated onto the GET response), and the
        // job's USER-FACING market is the NAME in the picker. If a stale
        // id copy survived in the blob it would out-rank that name in
        // resolveMarketId below and re-marketing a job would update the
        // label while the FK — and therefore the market's P&L — silently
        // stayed put. Strip it so the name is what resolves.
        delete jobBlob.market_id;
        // organization_id is the TENANT boundary and it lives on the column,
        // stamped from the caller's token below. A copy in the JSONB would be
        // client-supplied and would shadow the column for anything reading the
        // blob — same failure mode as owner_id and market_id above.
        delete jobBlob.organization_id;
        // For new jobs, admins can specify owner_id to assign a PM. Non-admins
        // (PMs creating their own jobs) always own what they create. ON CONFLICT
        // never touches owner_id, so existing jobs keep their original PM.
        const isNewJob = !existing.rows.length;
        const priorOwnerId = isNewJob ? null : existing.rows[0].owner_id;
        const ownerId = (isAdminish(req.user) && job.owner_id) ? job.owner_id : req.user.id;
        // Enforce the org check only where an owner is actually being
        // ASSIGNED — a create, or a change of owner on an existing row. A
        // routine save that merely echoes the row's current owner back is not
        // an assignment and must not start failing because of historical data.
        if (isNewJob || Number(ownerId) !== Number(priorOwnerId)) {
          if (Number(ownerId) !== Number(req.user.id) && !ownerIdsInOrg.has(Number(ownerId))) {
            conflicts.push({ id: job.id, reason: 'invalid_owner', serverUpdatedAt: null });
            continue;
          }
        }
        // Resolve from the blob's market NAME. A blob that names no
        // market resolves to null, and COALESCE below keeps whatever the
        // row already had rather than blanking it — the same
        // never-un-assign-by-omission rule the estimates bulk save uses.
        const jobMarketId = marketMap ? markets.resolveMarketId(marketMap, jobBlob) : null;
        const up = await client.query(
          // organization_id is stamped on the INSERT arm and DELIBERATELY
          // absent from DO UPDATE. A row's org is its tenancy: letting a save
          // rewrite it would make every bulk save a potential tenant move, so
          // not EXCLUDED and not COALESCE — nothing. (Contrast market_id
          // immediately below, which correctly COALESCEs, because a market is
          // an operating dimension and CAN legitimately change.)
          //
          // Until this stamp existed, a genuinely new job — the create path
          // the resurrection guard above deliberately preserves — landed with
          // organization_id NULL, and every read in this file admits NULL
          // ("OR organization_id IS NULL"), so the row was visible to every
          // tenant rather than hidden from all of them.
          //
          // The WHERE on DO UPDATE is the second layer under the JS branch
          // above, and it should be unreachable — that is the point of it.
          `INSERT INTO jobs (id, owner_id, data, organization_id, market_id) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET data = $3,
                 market_id = COALESCE(EXCLUDED.market_id, jobs.market_id),
                 updated_at = NOW()
             WHERE jobs.organization_id = $4 OR jobs.organization_id IS NULL
           RETURNING updated_at`,
          [job.id, ownerId, JSON.stringify(jobBlob), orgId, jobMarketId]
        );
        // A DO UPDATE whose WHERE filters the row out returns ZERO rows — and
        // `saved++` below runs unconditionally, so without this the row would
        // be reported to the client as saved while nothing was written. Throw
        // rather than conflict: reaching here means a row passed the JS tenant
        // branch and was then refused by SQL, which is a server bug and should
        // read as one (500 + ROLLBACK), not as something the user did.
        if (!up.rows[0]) {
          throw new Error('bulk/save: job ' + job.id + ' passed the tenant branch but the ' +
            'DO UPDATE org guard refused it — the two disagree, nothing was written');
        }
        // Hand back the new version so the client can advance its base and not
        // false-conflict on its own next save.
        versions[job.id] = new Date(up.rows[0].updated_at).toISOString();
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
    res.json({ ok: true, count: saved, skipped: skipped, conflicts: conflicts, versions: versions });
  } catch (e) {
    // This logged nothing at all. When bulk/save was the losing side of the
    // QB-import deadlock rather than the import, the incident left no trace
    // anywhere on the server — the client saw a bare 500 and the deadlock
    // itself was only ever visible from the other route's logs.
    console.error('PUT /api/jobs/bulk/save error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Node graph routes
router.get('/:id/graph', requireAuth, async (req, res) => {
  try {
    if (!(await canAccess(req.user.id, req.user.role, req.params.id, req))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows } = await pool.query('SELECT data FROM node_graphs WHERE job_id = $1', [req.params.id]);
    res.json({ graph: rows.length ? rows[0].data : null });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Count building nodes carrying real geometry — a traced footprint
// polygon or a geo-anchor. Feeds the data-loss guard below.
function graphGeomCount(g) {
  if (!g || !Array.isArray(g.nodes)) return 0;
  let c = 0;
  for (const n of g.nodes) {
    if ((Array.isArray(n.polygon) && n.polygon.length > 0) ||
        (n.geoLatLng && typeof n.geoLatLng === 'object')) c++;
  }
  return c;
}

router.put('/:id/graph', requireAuth, async (req, res) => {
  try {
    if (!(await canEdit(req.user.id, req.user.role, req.params.id, req))) {
      return res.status(403).json({ error: 'No edit access' });
    }
    const incoming = req.body || {};
    // ── Data-loss guard ──────────────────────────────────────────────
    // The Site Map re-seeds a default (footprint-less) graph on open. If
    // the cloud load blips or a job was converted from a lead with an
    // empty survey graph, that bare seed can PUT here and wipe real drawn
    // footprints. Refuse any write that would take a graph WITH footprints
    // down to ZERO: a legit auto-save always re-sends the buildings'
    // geometry, so only a seed clobber ever trips this. An intentional
    // "clear everything" passes ?force=1.
    if (graphGeomCount(incoming) === 0 && req.query.force !== '1') {
      const { rows } = await pool.query('SELECT data FROM node_graphs WHERE job_id = $1', [req.params.id]);
      const existingGeom = rows.length ? graphGeomCount(rows[0].data) : 0;
      if (existingGeom > 0) {
        console.warn('[graph-guard] blocked footprint-wipe on job ' + req.params.id + ' (existing=' + existingGeom + ', incoming=0)');
        return res.status(409).json({
          error: 'geometry_wipe_blocked',
          existingGeom,
          message: 'Refusing to overwrite ' + existingGeom + ' saved building footprint(s) with a graph that has none. Pass force=1 to override.'
        });
      }
    }
    const g = await pool.query(
      // organization_id derived from the PARENT JOB, not from the caller: a
      // graph belongs to whatever tenant its job belongs to, and reading it
      // off the row makes the stamp unforgeable and correct even here, where
      // the route is requireAuth-only. A missing job yields NULL exactly as
      // before, so the row-count semantics of the INSERT arm are unchanged.
      //
      // The DO UPDATE arm carried NO tenant predicate, which made this the
      // bulk save's defect a second time and on the same shape: an ON CONFLICT
      // that finds the foreign row by primary key and rewrites it wholesale —
      // here a whole Site Plan, footprints, geo anchors, building money lines
      // and photo pins — while the org stamp is left alone, so the row stays
      // the other tenant's carrying this caller's contents.
      //
      // canEdit above is now org-first and should already have refused. This
      // is the second layer, and 0 rows means the two disagree.
      `INSERT INTO node_graphs (job_id, data, organization_id)
       VALUES ($1, $2, (SELECT organization_id FROM jobs WHERE id = $1))
       ON CONFLICT (job_id) DO UPDATE SET data = $2, updated_at = NOW()
         WHERE node_graphs.organization_id IS NULL OR node_graphs.organization_id = $3`,
      [req.params.id, JSON.stringify(incoming), await callerOrgId(req)]
    );
    if (!g.rowCount) {
      return res.status(409).json({
        error: 'not_in_org',
        message: 'That site plan belongs to a different organization. Nothing was saved, and nothing about it was changed.'
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
