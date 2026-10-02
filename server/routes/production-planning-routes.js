// Production planning — the service manager's Thursday checklist.
//
// The rules live in services/production-planning.js, which requires nothing;
// this file is the plumbing. Every decision about who may see or move what is
// taken there so it can be tested without a database or a JWT_SECRET.
//
// ── CAPABILITIES, AND WHY THESE TWO ────────────────────────────────────────
// JOBS_VIEW_ALL gates the sheet, because that is already what gates the
// Schedule area this page lives in (server/routes/schedule-routes.js uses it
// on all four of its doors) — a service manager who can open Schedule can open
// the checklist.
//
// PROGRESS_UPDATE gates APPLY, and only apply. The capability is literally
// "Edit phase % complete + labor entries", and applying a row writes a scope
// line's pctComplete. No new capability is minted: the two that exist already
// describe exactly these two acts.
//
// ── THE GUEST DOORS ────────────────────────────────────────────────────────
// Two of the routes below take no auth at all — they are reached with a
// bearer token in the path. They are deliberately the LAST two in the file and
// they never call requireAuth/requireOrgId, because there is no user: the org
// is DERIVED from the share row the token resolves to, which is the shape
// test/create-doors-org-gate.test.js calls "derive". A token holder can move
// three fields on one sheet and can reach nothing else in this app.
'use strict';

const express = require('express');
const router = express.Router();

const { pool } = require('../db');
const { requireAuth, requireCapability, requireOrgId } = require('../auth');
const P = require('../services/production-planning');
const progress = require('../../js/progress-core');

const NOT_FOUND = 'Checklist not found';

// ── Reading the sheet ──────────────────────────────────────────────────────

const LIST_COLS = 'id, title, meeting_date, status, notes, created_by, closed_at, created_at, updated_at';
const ROW_COLS = 'id, checklist_id, job_id, job_number, job_title, client_label, address, ' +
  'contract_amount, pct, done, note, updated_by, updated_actor, updated_at, ' +
  'applied_at, applied_pct, applied_by, sort_key';

async function loadChecklist(orgId, id) {
  const r = await pool.query(
    'SELECT ' + LIST_COLS + ' FROM production_checklists WHERE id = $1 AND organization_id = $2',
    [String(id), orgId]
  );
  return r.rows[0] || null;
}

async function loadRows(orgId, checklistId) {
  const r = await pool.query(
    'SELECT ' + ROW_COLS + ' FROM production_checklist_rows ' +
    ' WHERE checklist_id = $1 AND organization_id = $2 ' +
    ' ORDER BY sort_key ASC NULLS LAST, job_number ASC',
    [String(checklistId), orgId]
  );
  // is_work_order is DERIVED from the snapshot title, never stored — "WO" at
  // the end of a job name is a Buildertrend naming convention with nothing in
  // the schema recording it.
  return r.rows.map((row) => Object.assign({}, row, {
    is_work_order: P.isWorkOrder({ title: row.job_title }),
  }));
}

// ── Building a sheet from the jobs that are open right now ─────────────────
//
// John chose "you create it when you want one": nothing appears on a schedule.
// The two retired ancestors of this feature both failed by being automatic —
// the 3 AM snapshot only fired if a browser tab happened to be open, and it
// silently lost days.
//
// The job list is read with the org predicate in SQL and filtered in JS,
// because "which jobs are open" is a rule (services/production-planning.js
// isPlannable) and rules do not belong in a WHERE clause built from a blob.
async function openJobsFor(orgId) {
  const r = await pool.query(
    `SELECT id, data, client_id, geocode_lat, geocode_lng, updated_at
       FROM jobs
      WHERE organization_id = $1`,
    [orgId]
  );
  return r.rows
    .map((j) => Object.assign({ id: j.id }, j.data || {}, {
      _clientId: j.client_id || (j.data && j.data.clientId) || null,
    }))
    .filter((j) => P.isPlannable(j));
}

function addressOf(job) {
  const parts = [job.street_address, job.city, job.state, job.zip].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return job.address ? String(job.address) : null;
}

// The reference design groups by property — "Associa Gulf Coast - Heatherwood
// Condos". A job has no property field; its only property signal is the
// free-text client name plus an optional link. The snapshot therefore stores
// the TEXT, which is what the heading shows, and is stable even if the client
// row is later renamed or merged.
function clientLabelOf(job) {
  const s = String(job.client || '').trim();
  return s || null;
}

function contractOf(job) {
  const n = Number(job.contractAmount);
  return Number.isFinite(n) ? n : null;
}

// ── Doors ──────────────────────────────────────────────────────────────────

// Param-less GET. By construction it joins the DRIVEN set in
// test/tenant-register2-http.test.js — a param-less GET may never be waived.
router.get('/', requireAuth, requireCapability('JOBS_VIEW_ALL'), requireOrgId, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT ' + LIST_COLS + ', ' +
      '  (SELECT COUNT(*) FROM production_checklist_rows x ' +
      '    WHERE x.checklist_id = c.id AND x.organization_id = c.organization_id) AS row_count ' +
      ' FROM production_checklists c WHERE c.organization_id = $1 ' +
      ' ORDER BY COALESCE(c.meeting_date, c.created_at::date) DESC, c.created_at DESC LIMIT 100',
      [req.orgId]
    );
    res.json({ checklists: r.rows });
  } catch (e) {
    console.error('[production-planning] list failed', e && e.message);
    res.status(500).json({ error: 'Failed to load checklists' });
  }
});

router.post('/', requireAuth, requireCapability('JOBS_VIEW_ALL'), requireOrgId, async (req, res) => {
  const client = await pool.connect();
  try {
    const orgId = req.orgId;
    const body = req.body || {};
    const jobs = await openJobsFor(orgId);

    const id = P.genId('pcl');
    const title = String(body.title || '').trim() ||
      ('Production planning — ' + new Date().toISOString().slice(0, 10));
    const meetingDate = body.meeting_date ? String(body.meeting_date).slice(0, 10) : null;

    await client.query('BEGIN');
    await client.query(
      'INSERT INTO production_checklists (id, organization_id, title, meeting_date, status, notes, created_by) ' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, orgId, title, meetingDate, 'open', P.cleanNote(body.notes), (req.user && req.user.id) || null]
    );
    for (const job of jobs) {
      const num = P.numberOf(job);
      await client.query(
        'INSERT INTO production_checklist_rows ' +
        ' (id, organization_id, checklist_id, job_id, job_number, job_title, client_label, ' +
        '  address, contract_amount, sort_key) ' +
        ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ' +
        ' ON CONFLICT (organization_id, checklist_id, job_id) DO NOTHING',
        [P.genId('pcr'), orgId, id, job.id, num, P.titleOf(job), clientLabelOf(job),
          addressOf(job), contractOf(job),
          // Grouped by property, then by number — the reading order of the sheet.
          (clientLabelOf(job) || '~') + '|' + num]
      );
    }
    await client.query('COMMIT');

    const list = await loadChecklist(orgId, id);
    res.status(201).json({ checklist: list, rows: await loadRows(orgId, id), added: jobs.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[production-planning] create failed', e && e.message);
    res.status(500).json({ error: 'Failed to create the checklist' });
  } finally {
    client.release();
  }
});

router.get('/:id', requireAuth, requireCapability('JOBS_VIEW_ALL'), requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const list = await loadChecklist(orgId, req.params.id);
    if (!list) return res.status(404).json({ error: NOT_FOUND });
    const rows = await loadRows(orgId, list.id);
    const shares = await pool.query(
      'SELECT id, scope, hide_financials, recipient_email, recipient_name, expires_at, ' +
      '       opened_at, revoked_at, last_used_at, view_count, created_at ' +
      '  FROM production_checklist_shares WHERE checklist_id = $1 AND organization_id = $2 ' +
      ' ORDER BY created_at DESC',
      [list.id, orgId]
    );
    // The office view is not a share: it shows everything, including money.
    res.json({
      checklist: list,
      rows: rows,
      summary: P.summarize(rows),
      shares: shares.rows,
    });
  } catch (e) {
    console.error('[production-planning] read failed', e && e.message);
    res.status(500).json({ error: 'Failed to load the checklist' });
  }
});

router.patch('/:id', requireAuth, requireCapability('JOBS_VIEW_ALL'), requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const list = await loadChecklist(orgId, req.params.id);
    if (!list) return res.status(404).json({ error: NOT_FOUND });
    const b = req.body || {};
    const sets = [];
    const vals = [];
    let n = 0;
    if (b.title !== undefined) { sets.push('title = $' + (++n)); vals.push(String(b.title).trim().slice(0, 200) || list.title); }
    if (b.meeting_date !== undefined) { sets.push('meeting_date = $' + (++n)); vals.push(b.meeting_date ? String(b.meeting_date).slice(0, 10) : null); }
    if (b.notes !== undefined) { sets.push('notes = $' + (++n)); vals.push(P.cleanNote(b.notes)); }
    if (b.status !== undefined) {
      const s = String(b.status) === 'closed' ? 'closed' : 'open';
      sets.push('status = $' + (++n)); vals.push(s);
      sets.push('closed_at = $' + (++n)); vals.push(s === 'closed' ? new Date() : null);
    }
    if (!sets.length) return res.json({ checklist: list });
    sets.push('updated_at = NOW()');
    vals.push(list.id, orgId);
    await pool.query(
      'UPDATE production_checklists SET ' + sets.join(', ') +
      ' WHERE id = $' + (n + 1) + ' AND organization_id = $' + (n + 2),
      vals
    );
    res.json({ checklist: await loadChecklist(orgId, list.id) });
  } catch (e) {
    console.error('[production-planning] patch failed', e && e.message);
    res.status(500).json({ error: 'Failed to update the checklist' });
  }
});

// Top up an existing sheet with jobs that have become open since it was
// raised. Never removes a row: a job that closed mid-week stays on the sheet
// because the sheet is a record of what was discussed.
router.post('/:id/sync', requireAuth, requireCapability('JOBS_VIEW_ALL'), requireOrgId, async (req, res) => {
  const client = await pool.connect();
  try {
    const orgId = req.orgId;
    const list = await loadChecklist(orgId, req.params.id);
    if (!list) return res.status(404).json({ error: NOT_FOUND });
    const jobs = await openJobsFor(orgId);
    let added = 0;
    await client.query('BEGIN');
    for (const job of jobs) {
      const num = P.numberOf(job);
      const r = await client.query(
        'INSERT INTO production_checklist_rows ' +
        ' (id, organization_id, checklist_id, job_id, job_number, job_title, client_label, ' +
        '  address, contract_amount, sort_key) ' +
        ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ' +
        ' ON CONFLICT (organization_id, checklist_id, job_id) DO NOTHING',
        [P.genId('pcr'), orgId, list.id, job.id, num, P.titleOf(job), clientLabelOf(job),
          addressOf(job), contractOf(job), (clientLabelOf(job) || '~') + '|' + num]
      );
      if (r.rowCount) added++;
    }
    await client.query('COMMIT');
    res.json({ added: added, rows: await loadRows(orgId, list.id) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[production-planning] sync failed', e && e.message);
    res.status(500).json({ error: 'Failed to refresh the checklist' });
  } finally {
    client.release();
  }
});

router.delete('/:id', requireAuth, requireCapability('JOBS_VIEW_ALL'), requireOrgId, async (req, res) => {
  try {
    const r = await pool.query(
      'DELETE FROM production_checklists WHERE id = $1 AND organization_id = $2',
      [String(req.params.id), req.orgId]
    );
    if (!r.rowCount) return res.status(404).json({ error: NOT_FOUND });
    res.json({ ok: true });
  } catch (e) {
    console.error('[production-planning] delete failed', e && e.message);
    res.status(500).json({ error: 'Failed to delete the checklist' });
  }
});

// ── The three fields the sheet exists to collect ───────────────────────────
// Shared by the signed-in door and the guest door below, so the rule that
// ticking done means 100 cannot diverge between them.
async function writeEntry(orgId, checklistId, rowId, body, actor) {
  const cur = await pool.query(
    'SELECT ' + ROW_COLS + ' FROM production_checklist_rows ' +
    ' WHERE id = $1 AND checklist_id = $2 AND organization_id = $3',
    [String(rowId), String(checklistId), orgId]
  );
  const row = cur.rows[0];
  if (!row) return { ok: false, status: 404, error: 'Row not found' };

  const { patch, refused } = P.splitEntryPatch(body);
  if (!Object.keys(patch).length) {
    return { ok: false, status: 400, error: 'Nothing to update. This sheet collects how far along, done, and what is left.' };
  }
  const next = P.normalizeEntry(patch, row);
  const upd = await pool.query(
    'UPDATE production_checklist_rows SET pct = $1, done = $2, note = $3, ' +
    '       updated_by = $4, updated_actor = $5, updated_at = NOW() ' +
    ' WHERE id = $6 AND checklist_id = $7 AND organization_id = $8 ' +
    ' RETURNING ' + ROW_COLS,
    [next.pct, next.done, next.note, actor.userId || null, actor.label || null,
      String(rowId), String(checklistId), orgId]
  );
  const out = upd.rows[0];
  return {
    ok: true,
    row: Object.assign({}, out, { is_work_order: P.isWorkOrder({ title: out.job_title }) }),
    refused: refused,
  };
}

router.put('/:id/rows/:rowId', requireAuth, requireCapability('JOBS_VIEW_ALL'), requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const list = await loadChecklist(orgId, req.params.id);
    if (!list) return res.status(404).json({ error: NOT_FOUND });
    const r = await writeEntry(orgId, list.id, req.params.rowId, req.body, {
      userId: (req.user && req.user.id) || null,
      label: (req.user && (req.user.name || req.user.email)) || null,
    });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ row: r.row, refused: r.refused });
  } catch (e) {
    console.error('[production-planning] row write failed', e && e.message);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// ── Apply one row's percent to the job's scope line ────────────────────────
//
// The ONE road from the manager's number to the WIP. PROGRESS_UPDATE, because
// this writes a scope line's pctComplete and that is what the capability says.
//
// Refuses rather than guesses when a job has several scope lines: splitting
// one number across lines carrying different revenue would invent a
// distribution nobody decided, and the lines are what the WIP reads.
router.post('/:id/rows/:rowId/apply', requireAuth, requireCapability('PROGRESS_UPDATE'), requireOrgId, async (req, res) => {
  const client = await pool.connect();
  try {
    const orgId = req.orgId;
    const list = await loadChecklist(orgId, req.params.id);
    if (!list) return res.status(404).json({ error: NOT_FOUND });

    const cur = await pool.query(
      'SELECT ' + ROW_COLS + ' FROM production_checklist_rows ' +
      ' WHERE id = $1 AND checklist_id = $2 AND organization_id = $3',
      [String(req.params.rowId), list.id, orgId]
    );
    const row = cur.rows[0];
    if (!row) return res.status(404).json({ error: 'Row not found' });

    await client.query('BEGIN');
    // FOR UPDATE: the job blob has no concurrency control of its own, so a
    // read-modify-write of data.phases must hold the row. Same reason the
    // payload dispatcher re-predicates its own blob rewrite.
    const jr = await client.query(
      'SELECT data FROM jobs WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [row.job_id, orgId]
    );
    if (!jr.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That job is no longer here' });
    }
    const data = jr.rows[0].data || {};
    const chosen = req.body && req.body.phase_id ? String(req.body.phase_id) : null;

    let phaseId = null;
    let plan = null;
    if (chosen) {
      const hit = (data.phases || []).find((p) => p && String(p.id) === chosen);
      if (!hit) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'That scope line is not on this job' });
      }
      phaseId = chosen;
    } else {
      plan = P.planApply({ phases: data.phases || [] }, row.pct);
      if (!plan.ok) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: plan.message, reason: plan.reason, choices: plan.choices });
      }
      phaseId = plan.phaseId;
    }

    const idx = (data.phases || []).findIndex((p) => p && String(p.id) === String(phaseId));
    const before = Number(data.phases[idx].pctComplete) || 0;
    data.phases[idx].pctComplete = P.snapPct(row.pct);

    await client.query(
      'UPDATE jobs SET data = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
      [data, row.job_id, orgId]
    );
    await client.query(
      'UPDATE production_checklist_rows SET applied_at = NOW(), applied_pct = $1, applied_by = $2 ' +
      ' WHERE id = $3 AND checklist_id = $4 AND organization_id = $5',
      [P.snapPct(row.pct), (req.user && req.user.id) || null, row.id, list.id, orgId]
    );
    await client.query('COMMIT');

    // The job's own percent, recomputed by the ONE clock — the same module the
    // browser and job-wip.js both use. Returned so the page can show what the
    // WIP will now read without a second round trip.
    const jobPct = progress.jobPct(data.phases || [], data.buildings || []);
    res.json({
      ok: true,
      phase_id: phaseId,
      from: before,
      to: P.snapPct(row.pct),
      job_pct: jobPct,
      rows: await loadRows(orgId, list.id),
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[production-planning] apply failed', e && e.message);
    res.status(500).json({ error: 'Failed to apply' });
  } finally {
    client.release();
  }
});

// ── Share links ────────────────────────────────────────────────────────────

router.post('/:id/shares', requireAuth, requireCapability('JOBS_VIEW_ALL'), requireOrgId, async (req, res) => {
  try {
    const orgId = req.orgId;
    const list = await loadChecklist(orgId, req.params.id);
    if (!list) return res.status(404).json({ error: NOT_FOUND });
    const b = req.body || {};
    const token = P.genToken();
    const id = P.genId('pcs');
    await pool.query(
      'INSERT INTO production_checklist_shares ' +
      ' (id, organization_id, checklist_id, token_hash, scope, hide_financials, ' +
      '  recipient_email, recipient_name, expires_at, created_by) ' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, orgId, list.id, P.hashToken(token), P.normalizeScope(b.scope),
        b.hide_financials === false ? false : true,
        b.recipient_email ? String(b.recipient_email).trim().slice(0, 200) : null,
        b.recipient_name ? String(b.recipient_name).trim().slice(0, 120) : null,
        P.shareExpiry(b.days), (req.user && req.user.id) || null]
    );
    // The raw token is returned ONCE, here, and never stored. The row keeps
    // only its sha256 — task_shares keeps the raw token and a leaked backup of
    // that table hands over every live link.
    res.status(201).json({
      id: id,
      token: token,
      // A PATH, never a query string: the URL is the credential, and a query
      // is far more likely to be logged by a proxy or kept in an analytics
      // payload than a path segment. Served by /pp/:token in server/index.js
      // with the three no-index / no-referrer / no-store headers.
      url: '/pp/' + token,
      scope: P.normalizeScope(b.scope),
    });
  } catch (e) {
    console.error('[production-planning] share mint failed', e && e.message);
    res.status(500).json({ error: 'Failed to create the link' });
  }
});

router.delete('/:id/shares/:shareId', requireAuth, requireCapability('JOBS_VIEW_ALL'), requireOrgId, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE production_checklist_shares SET revoked_at = NOW() ' +
      ' WHERE id = $1 AND checklist_id = $2 AND organization_id = $3 AND revoked_at IS NULL',
      [String(req.params.shareId), String(req.params.id), req.orgId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Link not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[production-planning] revoke failed', e && e.message);
    res.status(500).json({ error: 'Failed to revoke the link' });
  }
});

// ── Guest doors ────────────────────────────────────────────────────────────
// No requireAuth, no requireOrgId: there is no user. The org is DERIVED from
// the share row the token resolves to and then used as the predicate on every
// subsequent statement, which is the "derive" shape
// test/create-doors-org-gate.test.js describes.

const REFUSALS = {
  not_found: 'This link is not valid.',
  revoked: 'This link has been turned off.',
  expired: 'This link has expired. Ask for a new one.',
};

async function resolveShare(token) {
  if (!P.isWellFormedToken(token)) return { refusal: 'not_found' };
  const r = await pool.query(
    'SELECT id, organization_id, checklist_id, scope, hide_financials, recipient_name, ' +
    '       expires_at, revoked_at FROM production_checklist_shares WHERE token_hash = $1',
    [P.hashToken(token)]
  );
  const share = r.rows[0] || null;
  const refusal = P.shareRefusal(share);
  return refusal ? { refusal: refusal } : { share: share };
}

router.get('/share/:token', async (req, res) => {
  try {
    const { share, refusal } = await resolveShare(req.params.token);
    if (refusal) return res.status(404).json({ error: REFUSALS[refusal] || REFUSALS.not_found });
    const orgId = share.organization_id;
    const list = await loadChecklist(orgId, share.checklist_id);
    if (!list) return res.status(404).json({ error: REFUSALS.not_found });
    const rows = await loadRows(orgId, list.id);
    await pool.query(
      'UPDATE production_checklist_shares SET view_count = view_count + 1, last_used_at = NOW(), ' +
      '       opened_at = COALESCE(opened_at, NOW()) WHERE id = $1',
      [share.id]
    );
    res.json(P.publicChecklist(list, rows, {
      hideFinancials: share.hide_financials !== false,
      scope: P.normalizeScope(share.scope),
    }));
  } catch (e) {
    console.error('[production-planning] guest read failed', e && e.message);
    res.status(500).json({ error: 'Could not open the checklist' });
  }
});

router.put('/share/:token/rows/:rowId', async (req, res) => {
  try {
    const { share, refusal } = await resolveShare(req.params.token);
    if (refusal) return res.status(404).json({ error: REFUSALS[refusal] || REFUSALS.not_found });
    if (!P.mayUpdate(share)) {
      return res.status(403).json({ error: 'This link is read-only.' });
    }
    const orgId = share.organization_id;
    const r = await writeEntry(orgId, share.checklist_id, req.params.rowId, req.body, {
      userId: null,
      // A bearer token cannot identify a person, so the honest record is the
      // link it arrived through — the rule service_ticket_events states.
      label: 'Link' + (share.recipient_name ? ' — ' + share.recipient_name : ''),
    });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    await pool.query(
      'UPDATE production_checklist_shares SET last_used_at = NOW() WHERE id = $1',
      [share.id]
    );
    res.json({
      row: P.publicRow(r.row, { hideFinancials: share.hide_financials !== false }),
      refused: r.refused,
    });
  } catch (e) {
    console.error('[production-planning] guest write failed', e && e.message);
    res.status(500).json({ error: 'Could not save' });
  }
});

module.exports = router;
