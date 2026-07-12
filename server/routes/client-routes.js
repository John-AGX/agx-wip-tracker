const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

// Editable client fields. Whitelisted so request bodies can't sneak in
// columns like id/created_at/parent_client_id (parent has its own check).
const EDITABLE_FIELDS = [
  'name', 'client_type', 'activation_status',
  'first_name', 'last_name', 'email',
  'phone', 'cell',
  'address', 'city', 'state', 'zip',
  'company_name', 'community_name', 'market',
  'property_address', 'property_phone', 'website',
  'gate_code', 'additional_pocs',
  'community_manager', 'cm_email', 'cm_phone',
  'maintenance_manager', 'mm_email', 'mm_phone',
  'short_name',
  'notes'
];

function pickEditable(body) {
  const out = {};
  for (const k of EDITABLE_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

// Numeric client "heat" (0-100): active pipeline + $ + recency + depth.
// Shared by the single-client dashboard and the list-page heat rollup so
// the chip on the row and the gauge in the dossier can never disagree.
// Hot ≥70, Warm ≥40, else Cold.
function computeClientHeat({ openLeads, pipelineValue, jobCount, margin, lastActivityMs }) {
  let heat = 0;
  heat += Math.min(40, openLeads * 20);                       // active pipeline
  heat += Math.min(25, (pipelineValue / 20000) * 25);         // pipeline $
  heat += Math.min(15, jobCount * 3);                         // relationship depth
  if (lastActivityMs) {
    const days = (Date.now() - lastActivityMs) / 86400000;
    heat += days <= 30 ? 20 : days <= 90 ? 10 : days <= 180 ? 4 : 0;
  }
  if (margin != null) { if (margin >= 0.2) heat += 8; else if (margin < 0.15 && jobCount) heat -= 8; }
  heat = Math.max(0, Math.min(100, Math.round(heat)));
  return { heat, heatLabel: heat >= 70 ? 'Hot' : heat >= 40 ? 'Warm' : 'Cold' };
}

// GET /api/clients — list all clients with their parent linkage.
// Anyone with ESTIMATES_VIEW can see the directory (estimates point at
// clients, so the same audience needs to read the list).
router.get('/', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    // Wave 1.A Phase 2 — org-scoped client directory.
    const { rows } = await pool.query(
      'SELECT * FROM clients WHERE organization_id = $1 OR organization_id IS NULL ORDER BY name',
      [req.user.organization_id]
    );
    res.json({ clients: rows });
  } catch (e) {
    console.error('GET /api/clients error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/clients/heat-rollup — batched heat scores for the whole client
// directory (health-grid list chips). One request instead of N dashboard
// calls. Mirrors the /:id/dashboard aggregation exactly: jobs link by
// explicit client_id else client-name match, leads by client_id, recency
// from jobs + leads + agent notes. MUST stay registered before '/:id'.
router.get('/heat-rollup', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const [cq, jq, lq, qb] = await Promise.all([
      pool.query('SELECT id, name, agent_notes FROM clients WHERE organization_id = $1 OR organization_id IS NULL', [orgId]),
      pool.query('SELECT id, client_id, data, updated_at FROM jobs WHERE organization_id = $1 OR organization_id IS NULL', [orgId]),
      pool.query(
        `SELECT client_id, status, estimated_revenue_low, estimated_revenue_high, updated_at
           FROM leads WHERE client_id IS NOT NULL AND (organization_id = $1 OR organization_id IS NULL)`, [orgId]),
      pool.query(
        `SELECT job_id, COALESCE(SUM(amount),0)::float AS total FROM qb_cost_lines
          WHERE job_id IN (SELECT id FROM jobs WHERE organization_id = $1 OR organization_id IS NULL)
          GROUP BY job_id`, [orgId]),
    ]);

    const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
    const costByJob = {};
    qb.rows.forEach((r) => { costByJob[r.job_id] = Number(r.total) || 0; });

    // name → [clientIds] (a job with no client_id attaches to every client
    // sharing the name, same as each of their dashboards would claim it).
    const byName = {};
    const agg = {};
    cq.rows.forEach((c) => {
      agg[c.id] = { openLeads: 0, pipelineValue: 0, jobCount: 0, contractValue: 0, costs: 0, lastActivityMs: 0 };
      const key = (c.name || '').trim().toLowerCase();
      if (key) (byName[key] = byName[key] || []).push(c.id);
      const notes = Array.isArray(c.agent_notes) ? c.agent_notes : [];
      notes.forEach((n) => {
        const t = n && n.created_at ? new Date(n.created_at).getTime() : 0;
        if (t > agg[c.id].lastActivityMs) agg[c.id].lastActivityMs = t;
      });
    });

    jq.rows.forEach((j) => {
      const d = j.data || {};
      const owners = j.client_id
        ? (agg[j.client_id] ? [j.client_id] : [])
        : (byName[String(d.client || '').trim().toLowerCase()] || []);
      if (!owners.length) return;
      const contract = num(d.contractAmount);
      const cost = (costByJob[j.id] != null) ? costByJob[j.id] : (num(d.qbCostsTotal) || num(d.estimatedCosts));
      const t = j.updated_at ? new Date(j.updated_at).getTime() : 0;
      owners.forEach((id) => {
        const a = agg[id];
        a.jobCount++; a.contractValue += contract; a.costs += cost;
        if (t > a.lastActivityMs) a.lastActivityMs = t;
      });
    });

    const OPEN = new Set(['new', 'in_progress', 'sent']);
    lq.rows.forEach((l) => {
      const a = agg[l.client_id];
      if (!a) return;
      if (OPEN.has(String(l.status || '').toLowerCase())) {
        a.openLeads++;
        a.pipelineValue += num(l.estimated_revenue_high) || num(l.estimated_revenue_low);
      }
      const t = l.updated_at ? new Date(l.updated_at).getTime() : 0;
      if (t > a.lastActivityMs) a.lastActivityMs = t;
    });

    const rollups = {};
    Object.keys(agg).forEach((id) => {
      const a = agg[id];
      const margin = a.contractValue > 0 ? (a.contractValue - a.costs) / a.contractValue : null;
      const h = computeClientHeat({
        openLeads: a.openLeads, pipelineValue: a.pipelineValue,
        jobCount: a.jobCount, margin, lastActivityMs: a.lastActivityMs,
      });
      rollups[id] = { heat: h.heat, heatLabel: h.heatLabel, openLeads: a.openLeads, pipelineValue: a.pipelineValue, jobCount: a.jobCount };
    });

    res.json({ rollups });
  } catch (e) {
    console.error('GET /api/clients/heat-rollup error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/clients/:id — single client + count of direct children
router.get('/:id', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    // Wave 1.A Phase 2 — org-scoped client GET by id.
    const { rows } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    const children = await pool.query(
      'SELECT COUNT(*)::int AS c FROM clients WHERE parent_client_id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    res.json({ client: rows[0], childCount: children.rows[0].c });
  } catch (e) {
    console.error('GET /api/clients/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/clients/:id/dashboard — CRM rollup for the client page.
// Resolves the client's jobs by the explicit jobs.client_id link when set,
// else falls back to an exact name-match on data->>'client' (existing jobs
// aren't linked yet). Returns financial rollups + linked leads + jobs + a
// simple health badge. Resilient: every number defaults to 0, never throws.
router.get('/:id/dashboard', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const cr = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, orgId]
    );
    if (!cr.rows.length) return res.status(404).json({ error: 'Client not found' });
    const client = cr.rows[0];
    const cname = (client.name || '').trim().toLowerCase();

    const jr = await pool.query(
      `SELECT id, data, client_id, updated_at, geocode_lat, geocode_lng FROM jobs
        WHERE (organization_id = $1 OR organization_id IS NULL)
          AND ( client_id = $2
                OR (client_id IS NULL AND lower(btrim(data->>'client')) = $3) )`,
      [orgId, client.id, cname]
    );
    const jobRows = jr.rows;
    const jobIds = jobRows.map((j) => j.id);

    const costByJob = {};
    if (jobIds.length) {
      const qc = await pool.query(
        'SELECT job_id, COALESCE(SUM(amount),0)::float AS total FROM qb_cost_lines WHERE job_id = ANY($1::text[]) GROUP BY job_id',
        [jobIds]
      );
      qc.rows.forEach((r) => { costByJob[r.job_id] = Number(r.total) || 0; });
    }

    const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
    let contractValue = 0, costs = 0, revenue = 0;
    const jobs = jobRows.map((j) => {
      const d = j.data || {};
      const contract = num(d.contractAmount);
      const cost = (costByJob[j.id] != null) ? costByJob[j.id] : (num(d.qbCostsTotal) || num(d.estimatedCosts));
      const rev = num(d.invoicedToDate);
      contractValue += contract; costs += cost; revenue += rev;
      return {
        id: j.id, jobNumber: d.jobNumber || '', title: d.title || d.name || d.jobNumber || j.id,
        status: d.status || '', contract, cost, revenue: rev,
        margin: contract > 0 ? (contract - cost) / contract : null,
        lat: j.geocode_lat, lng: j.geocode_lng, updatedAt: j.updated_at,
      };
    }).sort((a, b) => (b.contract - a.contract));

    const lr = await pool.query(
      `SELECT id, title, status, estimated_revenue_low, estimated_revenue_high,
              geocode_lat, geocode_lng, updated_at
         FROM leads
        WHERE client_id = $1 AND (organization_id = $2 OR organization_id IS NULL)
        ORDER BY updated_at DESC NULLS LAST`,
      [client.id, orgId]
    );
    const OPEN = new Set(['new', 'in_progress', 'sent']);
    let pipelineValue = 0, openLeads = 0;
    const leads = lr.rows.map((l) => {
      const value = num(l.estimated_revenue_high) || num(l.estimated_revenue_low);
      const open = OPEN.has(String(l.status || '').toLowerCase());
      if (open) { openLeads++; pipelineValue += value; }
      return { id: l.id, title: l.title || '(untitled lead)', status: l.status || 'new', value, open,
        lat: l.geocode_lat, lng: l.geocode_lng, updatedAt: l.updated_at };
    });

    const margin = contractValue > 0 ? (contractValue - costs) / contractValue : null;

    // Account-activity health (property-condition health lands with the
    // property-intel layer). tier: healthy | watch | risk.
    let tier = 'healthy', reason = 'Active account';
    if (jobs.length === 0 && openLeads === 0) { tier = 'watch'; reason = 'No jobs or active leads'; }
    else if (margin != null && margin < 0.15 && jobs.length) { tier = 'watch'; reason = 'Thin margins on completed work'; }
    else if (openLeads > 0 && jobs.length === 0) { reason = openLeads + ' open lead(s), no jobs yet'; }

    // Activity feed — recent jobs + leads + agent notes, newest first.
    const activity = [];
    jobs.forEach((j) => { if (j.updatedAt) activity.push({ type: 'job', label: (j.jobNumber ? j.jobNumber + ' ' : '') + (j.title || '') + ' · ' + (j.status || ''), when: j.updatedAt }); });
    leads.forEach((l) => { if (l.updatedAt) activity.push({ type: 'lead', label: (l.title || 'Lead') + ' · ' + (l.status || ''), when: l.updatedAt }); });
    try {
      const notes = Array.isArray(client.agent_notes) ? client.agent_notes : [];
      notes.forEach((n) => { if (n && n.body) activity.push({ type: 'note', label: String(n.body).slice(0, 120), when: n.created_at || null }); });
    } catch (e) { /* agent_notes optional */ }
    activity.sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0));
    const activityTop = activity.slice(0, 8);

    const lastWhen = (activity.length && activity[0].when) ? new Date(activity[0].when).getTime() : 0;
    const { heat, heatLabel } = computeClientHeat({
      openLeads, pipelineValue, jobCount: jobs.length, margin, lastActivityMs: lastWhen,
    });

    res.json({
      client: {
        id: client.id, name: client.name, client_type: client.client_type,
        market: client.market, property_address: client.property_address,
        first_name: client.first_name, last_name: client.last_name,
        email: client.email, phone: client.phone || client.cell,
        community_manager: client.community_manager, cm_email: client.cm_email, cm_phone: client.cm_phone,
        maintenance_manager: client.maintenance_manager, mm_email: client.mm_email, mm_phone: client.mm_phone,
      },
      summary: {
        jobCount: jobs.length, contractValue, costs, revenue, margin,
        totalLeads: leads.length, openLeads, pipelineValue, health: { tier, reason },
        heat, heatLabel,
      },
      jobs, leads, activity: activityTop,
    });
  } catch (e) {
    console.error('GET /api/clients/:id/dashboard error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Property-intel: nearest safety services (Slice 1) ────────────────
// Geocode the client's property address, then find the nearest hospital +
// fire station via Google Places (New). Cached 7 days per (client, address)
// so we don't re-hit Places/geocoding on every dossier open.
const geocoder = require('../geocoder');
const places = require('../places');
const _safetyCache = new Map(); // key `${id}|${addr}` → { data, ts }
const SAFETY_TTL = 7 * 86400000;

router.get('/:id/nearby-safety', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const cr = await pool.query(
      'SELECT id, property_address, address, city, state, zip FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, orgId]
    );
    if (!cr.rows.length) return res.status(404).json({ error: 'Client not found' });
    const c = cr.rows[0];
    const addr = (c.property_address && c.property_address.trim())
      || [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
    if (!addr) return res.json({ ok: false, reason: 'no_address' });

    const cacheKey = req.params.id + '|' + addr;
    const hit = _safetyCache.get(cacheKey);
    if (hit && (Date.now() - hit.ts) < SAFETY_TTL) return res.json(hit.data);

    const geo = await geocoder.geocodeAddress(addr);
    if (!geo || geo.lat == null || geo.lng == null) return res.json({ ok: false, reason: 'geocode_failed', address: addr });

    const safety = await places.nearbySafety(geo.lat, geo.lng);
    const out = {
      ok: true,
      property: { address: addr, lat: geo.lat, lng: geo.lng },
      hospital: safety.hospital, fire: safety.fire,
      generatedAt: new Date().toISOString()
    };
    _safetyCache.set(cacheKey, { data: out, ts: Date.now() });
    res.json(out);
  } catch (e) {
    console.error('GET /api/clients/:id/nearby-safety error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clients — create. parent_client_id is validated against the
// existing set so we don't end up with dangling parents.
router.post('/', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const fields = pickEditable(req.body || {});
    if (!fields.name) return res.status(400).json({ error: 'name is required' });

    const id = (req.body && req.body.id) || ('client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const parentId = req.body && req.body.parent_client_id ? req.body.parent_client_id : null;
    if (parentId) {
      const parent = await pool.query('SELECT id FROM clients WHERE id = $1', [parentId]);
      if (!parent.rows.length) return res.status(400).json({ error: 'parent_client_id does not exist' });
      if (parentId === id) return res.status(400).json({ error: 'A client cannot be its own parent' });
    }

    // Wave 1.A — include organization_id on new clients so org-filtering
    // (next commit) finds them. Prepended to the cols/vals arrays.
    const cols = ['id', 'parent_client_id', 'organization_id'].concat(Object.keys(fields));
    const vals = [id, parentId, req.user.organization_id].concat(Object.keys(fields).map(k => fields[k]));
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
    await pool.query(
      `INSERT INTO clients (${cols.join(', ')}) VALUES (${placeholders})`,
      vals
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error('POST /api/clients error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/clients/:id — update editable fields. parent_client_id can be
// changed (or set to null to detach), with the same validation as create.
router.put('/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    // Wave 1.A Phase 2 — org-scoped existence check and parent-FK check.
    const exists = await pool.query(
      'SELECT id FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    if (!exists.rows.length) return res.status(404).json({ error: 'Client not found' });

    const fields = pickEditable(req.body || {});
    const sets = [];
    const params = [];
    let p = 1;
    for (const k of Object.keys(fields)) {
      sets.push(k + ' = $' + p++);
      params.push(fields[k]);
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'parent_client_id')) {
      const parentId = req.body.parent_client_id || null;
      if (parentId) {
        if (parentId === req.params.id) return res.status(400).json({ error: 'A client cannot be its own parent' });
        const parent = await pool.query(
          'SELECT id FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
          [parentId, req.user.organization_id]
        );
        if (!parent.rows.length) return res.status(400).json({ error: 'parent_client_id does not exist' });
      }
      sets.push('parent_client_id = $' + p++);
      params.push(parentId);
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    params.push(req.user.organization_id);
    // SAFE: column names sourced from pickEditable(req.body) which iterates the constant EDITABLE_FIELDS allowlist.
    const u = await pool.query(
      `UPDATE clients SET ${sets.join(', ')} WHERE id = $${p} AND (organization_id = $${p + 1} OR organization_id IS NULL)`,
      params
    );
    if (u.rowCount === 0) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/clients/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// Agent notes — small, structured bullets that get auto-injected into
// 86's system prompt (estimate / job / directory surfaces) when 86's
// work touches this client. Both the user and 86 (with approval) can write
// these. Stored on clients.agent_notes as a JSONB array.
//
// Shape:
//   { id, body, created_at, created_by_user_id, source_agent }
//   source_agent ∈ { null (user), 'ag', 'cra' }
//
// Anyone with ESTIMATES_EDIT can add/remove (same surface as updating
// other client fields). The agent path goes through tool execution,
// which uses these same endpoints under the hood.
// ──────────────────────────────────────────────────────────────────
function newNoteId() {
  return 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

router.post('/:id/notes', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const body = (req.body && typeof req.body.body === 'string') ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'body is required' });
    if (body.length > 2000) return res.status(400).json({ error: 'note body cannot exceed 2000 chars' });
    const sourceAgent = (req.body && typeof req.body.source_agent === 'string') ? req.body.source_agent : null;
    if (sourceAgent && sourceAgent !== 'ag' && sourceAgent !== 'cra') {
      return res.status(400).json({ error: 'source_agent must be "ag", "cra", or omitted' });
    }
    const exists = await pool.query('SELECT id FROM clients WHERE id = $1', [req.params.id]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Client not found' });
    const note = {
      id: newNoteId(),
      body,
      created_at: new Date().toISOString(),
      created_by_user_id: req.user ? req.user.id : null,
      source_agent: sourceAgent
    };
    await pool.query(
      `UPDATE clients
         SET agent_notes = COALESCE(agent_notes, '[]'::jsonb) || $1::jsonb,
             updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify([note]), req.params.id]
    );
    res.json({ ok: true, note });
  } catch (e) {
    console.error('POST /api/clients/:id/notes error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id/notes/:noteId', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const exists = await pool.query('SELECT id FROM clients WHERE id = $1', [req.params.id]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Client not found' });
    const r = await pool.query(
      `UPDATE clients
         SET agent_notes = COALESCE((
           SELECT jsonb_agg(elem) FROM jsonb_array_elements(agent_notes) elem
            WHERE elem->>'id' <> $1
         ), '[]'::jsonb),
             updated_at = NOW()
       WHERE id = $2
       RETURNING agent_notes`,
      [req.params.noteId, req.params.id]
    );
    res.json({ ok: true, agent_notes: r.rows[0].agent_notes });
  } catch (e) {
    console.error('DELETE /api/clients/:id/notes/:noteId error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/clients/:id — children are detached (parent_client_id -> NULL
// via the FK on-delete rule), not deleted. Estimates referencing this client
// are not modified here yet (no FK exists yet); will be tightened when
// estimates gain a client_id column.
router.delete('/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    // Wave 1.A Phase 2 — org-scoped DELETE.
    const r = await pool.query(
      'DELETE FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/clients/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clients/import — bulk insert/update clients from a Buildertrend
// export. The client parses the xlsx browser-side (via SheetJS) and POSTs
// a normalized rows array. We dedupe by case-insensitive name, auto-create
// parent clients from any unique `company_name` values, and link children.
//
// Body: { rows: [{ name, company_name?, community_name?, ... }] }
// Returns: { inserted, updated, parentsCreated, total, errors[] }
router.post('/import', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const incoming = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!incoming || !incoming.length) {
      return res.status(400).json({ error: 'rows array is required' });
    }

    // Build a name -> id index of the existing directory for case-insensitive
    // dedupe. We do this once up front and keep it in sync as we go.
    // Wave A (A7): scope the dedup/parent index to the caller's org so a
    // re-import can't dedup against (or attach a parent from) another org.
    // OR-IS-NULL = no-op for AGX.
    const existing = await pool.query(
      'SELECT id, name FROM clients WHERE (organization_id = $1 OR organization_id IS NULL)',
      [req.user.organization_id]
    );
    const byName = new Map();
    for (const r of existing.rows) byName.set(String(r.name).trim().toLowerCase(), r.id);

    // Phase 1: ensure a parent client exists for every unique company_name
    // that appears in the incoming rows. If no client with that name exists
    // yet, create a minimal one (just the company name) — its details will
    // be filled in later if a row in the import has its own data for the
    // company (e.g. when the company itself is also exported as a row).
    const companyNames = new Set();
    for (const row of incoming) {
      const c = row.company_name && String(row.company_name).trim();
      if (c) companyNames.add(c);
    }
    let parentsCreated = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const company of companyNames) {
        const key = company.toLowerCase();
        if (byName.has(key)) continue;
        const id = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await client.query(
          `INSERT INTO clients (id, name, company_name, client_type)
           VALUES ($1, $2, $2, 'Property Mgmt')`,
          [id, company]
        );
        byName.set(key, id);
        parentsCreated++;
      }

      // Phase 2: per-row upsert. We match by name (case-insensitive) and
      // either UPDATE existing or INSERT new. parent_client_id is resolved
      // from byName via the row's company_name (or null if none / row IS
      // the company itself).
      let inserted = 0;
      let updated = 0;
      const errors = [];
      for (let i = 0; i < incoming.length; i++) {
        const row = incoming[i] || {};
        const name = (row.name || '').trim();
        if (!name) { errors.push({ row: i, error: 'missing name' }); continue; }

        // Resolve parent — a row whose name equals its own company_name is
        // the company itself, so it has no parent.
        let parentId = null;
        if (row.company_name && row.company_name.trim().toLowerCase() !== name.toLowerCase()) {
          parentId = byName.get(row.company_name.trim().toLowerCase()) || null;
        }

        const key = name.toLowerCase();
        const fields = pickEditable(row);
        fields.activation_status = (fields.activation_status || 'active').toLowerCase();

        if (byName.has(key)) {
          // UPDATE: only set non-empty fields so partial rows don't blank
          // out richer existing data.
          const existingId = byName.get(key);
          const sets = [];
          const params = [];
          let p = 1;
          for (const k of Object.keys(fields)) {
            if (fields[k] === '' || fields[k] == null) continue;
            sets.push(k + ' = $' + p++);
            params.push(fields[k]);
          }
          if (parentId) {
            sets.push('parent_client_id = $' + p++);
            params.push(parentId);
          }
          if (sets.length) {
            sets.push('updated_at = NOW()');
            params.push(existingId);
            try {
              // SAFE: column names sourced from pickEditable(row) iterating the constant EDITABLE_FIELDS allowlist.
              await client.query(`UPDATE clients SET ${sets.join(', ')} WHERE id = $${p}`, params);
              updated++;
            } catch (e) {
              errors.push({ row: i, name, error: e.message });
            }
          }
        } else {
          const id = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          // Wave A (A7): stamp organization_id on import (clients has the column).
          const cols = ['id', 'name', 'parent_client_id', 'organization_id'];
          const vals = [id, name, parentId, req.user.organization_id];
          for (const k of Object.keys(fields)) {
            if (k === 'name') continue;
            if (fields[k] === '' || fields[k] == null) continue;
            cols.push(k);
            vals.push(fields[k]);
          }
          const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
          try {
            await client.query(`INSERT INTO clients (${cols.join(', ')}) VALUES (${placeholders})`, vals);
            byName.set(key, id);
            inserted++;
          } catch (e) {
            errors.push({ row: i, name, error: e.message });
          }
        }
      }

      await client.query('COMMIT');
      res.json({
        ok: true,
        total: incoming.length,
        inserted,
        updated,
        parentsCreated,
        errors
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('POST /api/clients/import error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

module.exports = router;
