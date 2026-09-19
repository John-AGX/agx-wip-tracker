const express = require('express');
const { pool } = require('../db');
// requireOrgId — fail CLOSED on a create whose tenant cannot be determined.
// Binding req.user.organization_id straight into an INSERT with no gate is how
// un-stamped rows got into every org's reads: an org-less caller is a state
// this system explicitly supports (db.js logs "Admin … has NO organization" by
// name, and services/user-org-scope.js's whole tolerance rationale is that
// such users must stay reachable), so the null was never hypothetical.
const { requireAuth, requireCapability, requireOrgId } = require('../auth');
const jobLabel = require('../../js/job-label');
// Editable client fields. Whitelisted so request bodies can't sneak in
// columns like id/created_at/parent_client_id (parent has its own check).
// Defined in services/client-merge.js because the merge fills the survivor's
// blank ones from the folded row: two copies of this list would let "what a
// user may edit" and "what a merge may fill" drift apart silently.
const { mergeClients, EDITABLE_FIELDS } = require('../services/client-merge');
// isBtBlank - what "unknown" looks like on the Buildertrend side. The
// import's rung 0 reads a Buildertrend-shaped cell, so it honours the same
// test rather than inventing a second one. services/clickr/bt-match.js
// requires nothing and does no I/O, so this costs nothing at boot.
const { isBtBlank } = require('../services/clickr/bt-match');

const router = express.Router();

function pickEditable(body) {
  const out = {};
  for (const k of EDITABLE_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

// ── THE BULK IMPORT'S KEY LADDER ─────────────────────────────────────────
// A name is not an identity, and POST /import treated it as one. It decided
// every insert-vs-update on String(name).trim().toLowerCase(), which trims the
// ENDS and never touches what is INSIDE — so "Sentry  Management - Largo" with
// two spaces minted a whole second client beside "Sentry Management - Largo",
// and the same Buildertrend contact imported once as "Greystar - Castilian
// Apartments" and once as the bare "Castilian Apartments" minted another.
// NINE such pairs are live in production, every one of them one property held
// twice, and eight of them with the Buildertrend id on exactly one side.
//
// So the decision is made on a LADDER, in the vocabulary
// services/clickr/bt-match.js already uses for this same question:
//   rung 0  bt_contact_id — the Buildertrend record id, when the sheet
//           actually carries one. Nothing a name says can outrank it.
//   rung 1  email — but only where the address is a 1:1 identity rather than
//           a management firm's shared mailbox, AND the names corroborate.
//   rung 2  the normalized name.
// Reaching no rung INSERTS — unless the email says the row is one of the
// nine, in which case it is REFUSED and reported instead of duplicated.

// Columns the BULK IMPORT may write that a hand edit may NOT.
// EDITABLE_FIELDS is the PUT allowlist and services/client-merge.js's
// blank-fill list at the same time, and bt_contact_id belongs in neither: it
// is an IDENTITY, stamped by services/clickr/sync-apply.js when an admin
// applies a confident match and unique per (organization_id, bt_contact_id).
// A user must not be able to type one into the client editor and silently
// re-point a Buildertrend link, and a merge must not copy one onto a
// survivor. Keeping it OUT of EDITABLE_FIELDS and naming it only here is
// what holds the two paths apart — pickEditable() cannot return it, so no
// POST / PUT body can carry it in, and pickImportOnly() below is the single
// door it does come through.
const IMPORT_ONLY_FIELDS = ['bt_contact_id'];

function pickImportOnly(row) {
  const out = {};
  for (const k of IMPORT_ONLY_FIELDS) {
    const v = row && row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = String(v).trim();
  }
  return out;
}

// The dash glyphs a spreadsheet round-trip swaps for one another.
// Buildertrend writes "Manager - Property" with a plain hyphen; Excel's
// autocorrect and a paste out of a PDF both hand back an en or em dash. One
// separator, one client — the key must not see three different names.
const IMPORT_DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;

// rung 2's key: lowercased, ends trimmed, internal whitespace COLLAPSED.
// \s in JS covers the NBSP and the BOM an xlsx cell really carries, so a
// non-breaking space pasted into a Buildertrend field folds here too.
//
// It deliberately stops there. Other punctuation is NOT stripped, because
// this rung commits an UPDATE with nobody reviewing it: a period, a comma,
// an "&" or a roman numeral is authored content that can genuinely tell two
// directory rows apart, while a double space and a dash glyph are
// typographic noise the source cannot even preserve. Folding further would
// close the duplicate class by opening a wrong-merge class, which is the one
// thing this change must not do.
function importNameKey(v) {
  return String(v == null ? '' : v)
    .replace(IMPORT_DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// rung 1's corroboration key — importNameKey with the rest of the
// punctuation folded too. It is never a key on its own and never decides a
// match by itself: it is only ever asked whether two names AGREE once a 1:1
// email has already claimed they are the same client. That pairing is the
// whole reason the looser fold is safe here and not above.
function importNameKeyLoose(v) {
  return importNameKey(v).replace(/[^a-z0-9]+/g, ' ').trim();
}

// A malformed cell is NOT a key. "n/a", "--", "none" and "" in an Email
// column would otherwise all collide into one identity and fold unrelated
// clients together — the same shape bt-match.js's emailKey() insists on.
function importEmailKey(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

// rung 0's key. A cell that does not NAME a Buildertrend record is not an
// identity - exactly what importEmailKey above says about an Email column,
// and the stakes are higher here because rung 0 outranks both other rungs.
// An Id column reading "N/A" on every line made row 1 INSERT, stamped the
// placeholder on it, and then had every later row rung-0 match the client
// row 1 had just created and rename it in turn: three properties in, one
// client out, reported as a clean import.
//
// bt-match.js's isBtBlank is the blank test, reused rather than rewritten.
// The extra words are the ones a SPREADSHEET puts in an id column and the
// Clickr matcher has no reason to know about, so they stay local here:
// widening its BLANK_WORDS would change the sync preview and its pinned
// tests.
//
// No positive FORMAT is imposed. services/clickr/sync-apply.js stamps the
// id with no shape test at all, so there is no shape to require, and a
// format gate that rejected a real Buildertrend id would silently re-inert
// this rung and re-open the very class it exists to close.
const IMPORT_BT_PLACEHOLDERS = new Set(['none', 'null', 'nil', 'unknown', 'pending', 'na']);
function importBtKey(v) {
  const s = String(v == null ? '' : v).trim();
  if (isBtBlank(s)) return '';            // '', whitespace, a dash run, n/a, unassigned, tbd
  if (!/[a-z0-9]/i.test(s)) return '';    // punctuation only - "--", "#", "..."
  if (/^0+$/.test(s)) return '';          // "0" is a spreadsheet default, not a record
  return IMPORT_BT_PLACEHOLDERS.has(s.toLowerCase()) ? '' : s;
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
      // bt_archived_at: a client set aside by the Buildertrend reconcile is reviewed in its archive, not listed.
      'SELECT * FROM clients WHERE (organization_id = $1 OR organization_id IS NULL) AND bt_archived_at IS NULL ORDER BY name',
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
      pool.query('SELECT id, name, agent_notes FROM clients WHERE (organization_id = $1 OR organization_id IS NULL) AND bt_archived_at IS NULL', [orgId]),
      pool.query('SELECT id, client_id, data, updated_at FROM jobs WHERE organization_id = $1 OR organization_id IS NULL', [orgId]),
      pool.query(
        `SELECT client_id, status, estimated_revenue_low, estimated_revenue_high, updated_at
           FROM leads WHERE client_id IS NOT NULL AND (organization_id = $1 OR organization_id IS NULL) AND bt_archived_at IS NULL`, [orgId]),
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
    jobs.forEach((j) => { if (j.updatedAt) activity.push({ type: 'job', label: jobLabel.fromJob(j) + ' · ' + (j.status || ''), when: j.updatedAt }); });
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
    // Only cache lookups that actually found something. Caching error
    // results (e.g. Places API not yet enabled on the key) would pin the
    // failure for 7 days after the key is fixed.
    const gotAny = (safety.hospital && !safety.hospital.error) || (safety.fire && !safety.fire.error);
    if (gotAny) _safetyCache.set(cacheKey, { data: out, ts: Date.now() });
    res.json(out);
  } catch (e) {
    console.error('GET /api/clients/:id/nearby-safety error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clients — create. parent_client_id is validated against the
// existing set so we don't end up with dangling parents.
// requireOrgId AFTER the capability gate: an org-less caller who would have
// been 403'd anyway must not be told about their org state instead.
router.post('/', requireAuth, requireCapability('ESTIMATES_EDIT'), requireOrgId, async (req, res) => {
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
    const vals = [id, parentId, req.orgId].concat(Object.keys(fields).map(k => fields[k]));
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
    // PREDICATE BOTH STATEMENTS. The scoped-read/unscoped-write shape is not
    // available here — the read was unscoped too — so both get the predicate
    // the sibling DELETE /:id has carried since Wave 1.A Phase 2. The UPDATE
    // repeats it rather than trusting the SELECT: a pre-check alone is a
    // TOCTOU, and this endpoint is also the one 86 writes through ("the agent
    // path goes through tool execution, which uses these same endpoints under
    // the hood"), so a prompt-injected client id would have arrived here.
    const orgId = req.user.organization_id;
    const exists = await pool.query(
      'SELECT id FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, orgId]
    );
    if (!exists.rows.length) return res.status(404).json({ error: 'Client not found' });
    const note = {
      id: newNoteId(),
      body,
      created_at: new Date().toISOString(),
      created_by_user_id: req.user ? req.user.id : null,
      source_agent: sourceAgent
    };
    const w = await pool.query(
      `UPDATE clients
         SET agent_notes = COALESCE(agent_notes, '[]'::jsonb) || $1::jsonb,
             updated_at = NOW()
       WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)`,
      [JSON.stringify([note]), req.params.id, orgId]
    );
    if (!w.rowCount) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true, note });
  } catch (e) {
    console.error('POST /api/clients/:id/notes error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id/notes/:noteId', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    // Same shape as POST above — predicate on the read AND on the write.
    // Reported as source-traced only (the jsonb_agg didn't translate in the
    // harness); it is the identical defect and gets the identical fix.
    const orgId = req.user.organization_id;
    const exists = await pool.query(
      'SELECT id FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, orgId]
    );
    if (!exists.rows.length) return res.status(404).json({ error: 'Client not found' });
    const r = await pool.query(
      `UPDATE clients
         SET agent_notes = COALESCE((
           SELECT jsonb_agg(elem) FROM jsonb_array_elements(agent_notes) elem
            WHERE elem->>'id' <> $1
         ), '[]'::jsonb),
             updated_at = NOW()
       WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)
       RETURNING agent_notes`,
      [req.params.noteId, req.params.id, orgId]
    );
    // The UPDATE can still match nothing even after the SELECT did — another
    // request may have moved the row between the two. Answer that the same way
    // an absent client is answered rather than dereferencing rows[0].
    if (!r.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true, agent_notes: r.rows[0].agent_notes });
  } catch (e) {
    console.error('DELETE /api/clients/:id/notes/:noteId error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clients/merge — fold one client into another.
//
// This is the endpoint the directory's "Merge Client" always needed. It used
// to be orchestrated from the browser as a blank-fill PUT, a PUT per child,
// and a DELETE — no transaction, and nothing at all for the leads, estimates,
// jobs, projects, invoices, payments or filed documents that pointed at the
// row being deleted. The whole operation now runs server-side inside ONE
// transaction; services/client-merge.js has the reference list and the reason
// for every statement in it.
//
// Same gate as the DELETE below, because that is what this replaces: a merge
// is a delete that takes its references with it.
//
// Body:    { sourceId, targetId }
// Returns: { ok, moved: { leads, estimates, jobs, projects, invoices,
//            payments, children }, also: {...}, filled: [column names] }
router.post('/merge', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  const sourceId = String((req.body && req.body.sourceId) || '').trim();
  const targetId = String((req.body && req.body.targetId) || '').trim();
  if (!sourceId || !targetId) return res.status(400).json({ error: 'sourceId and targetId are required' });
  // One pooled client for the whole merge. Every statement has to see the
  // same transaction, so pool.query() — which hands out an arbitrary
  // connection per call — is not usable here. Same shape as
  // services/clickr/sync-apply.js runBucket().
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const r = await mergeClients(db, req.user.organization_id, sourceId, targetId);
    if (r.refused) {
      await db.query('ROLLBACK');
      return res.status(r.status || 400).json({ error: r.refused });
    }
    await db.query('COMMIT');
    return res.json({ ok: true, moved: r.moved, also: r.also, filled: r.filled, survivor: r.survivor, source: r.source });
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch (_) { /* the connection is going back to the pool either way */ }
    console.error('POST /api/clients/merge error:', e);
    return res.status(500).json({ error: 'Merge failed; nothing was changed.' });
  } finally {
    db.release();
  }
});

// DELETE /api/clients/:id — children are detached (parent_client_id -> NULL
// via the FK on-delete rule), not deleted. Estimates, jobs, invoices and
// payments referencing this client are NOT repaired here: this is the plain
// delete, and the references it leaves behind are the reason POST /merge
// above exists. Use the merge when the row has a successor.
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
// a normalized rows array. We match each row on the rung ladder above
// (bt_contact_id, then a 1:1 email, then the normalized name), auto-create
// parent clients from any unique `company_name` values, and link children.
//
// Body: { rows: [{ name, company_name?, community_name?, bt_contact_id?, ... }] }
// Returns: { inserted, updated, skipped, matchedBy, parentsCreated, total, errors[] }
// `matchedBy` counts the rung each update came through.
// `skipped` counts rows REFUSED as possible duplicates; each one is in
// errors[] naming both sides, because a row that vanished silently is how
// this got to nine duplicates in the first place.
router.post('/import', requireAuth, requireCapability('ESTIMATES_EDIT'), requireOrgId, async (req, res) => {
  try {
    const incoming = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!incoming || !incoming.length) {
      return res.status(400).json({ error: 'rows array is required' });
    }

    // ── THE LADDER'S INDEX ───────────────────────────────────────────────
    // ONE org-scoped read, carrying every column all three rungs need, built
    // once up front and kept in sync as we go. Wave A (A7): scoped to the
    // caller's org so a re-import can't dedup against (or attach a parent
    // from) another org. OR-IS-NULL = no-op for AGX.
    const existing = await pool.query(
      'SELECT id, name, email, bt_contact_id FROM clients WHERE (organization_id = $1 OR organization_id IS NULL)',
      [req.user.organization_id]
    );
    // EVERY rung is indexed the way services/clickr/bt-match.js's indexBy()
    // does it: key -> [client id]. A single-valued Map keeps whichever row
    // the unordered SELECT returned LAST, so the rung silently resolves to a
    // coin toss whenever two clients share a key - and the premise of this
    // whole change is that such pairs are in the directory today. rung 1
    // already refused to guess for exactly that reason; now so do the other
    // two, and an ambiguous key is REPORTED rather than written.
    const byBtId = new Map();   // rung 0: bt key -> [client id]
    const byEmail = new Map();  // rung 1: email key -> [client id]. A LIST:
                                //         one firm's address sits on many rows.
    const byName = new Map();   // rung 2: normalized name -> [client id]
    const nameOf = new Map();   // client id -> its name, for the refusal text
    const btIdOf = new Map();   // client id -> the BT id it is already linked to
    // Add or remove ONE id, never the whole key: a key two clients share must
    // not lose its other inhabitant when one of them is renamed.
    const pushIdx = (m, k, id) => {
      if (!k) return;
      if (!m.has(k)) m.set(k, []);
      if (m.get(k).indexOf(id) < 0) m.get(k).push(id);
    };
    const dropIdx = (m, k, id) => {
      if (!k || !m.has(k)) return;
      const left = m.get(k).filter((x) => x !== id);
      if (left.length) m.set(k, left); else m.delete(k);
    };
    for (const r of existing.rows) {
      nameOf.set(r.id, String(r.name == null ? '' : r.name));
      pushIdx(byName, importNameKey(r.name), r.id);
      pushIdx(byEmail, importEmailKey(r.email), r.id);
      const bk = importBtKey(r.bt_contact_id);
      if (bk) { pushIdx(byBtId, bk, r.id); btIdOf.set(r.id, bk); }
    }

    // ── IS THIS EMAIL AN IDENTITY, OR A MANAGEMENT FIRM'S MAILBOX? ───────
    // This directory has exactly that shape: one Greystar regional manager's
    // address sits on several genuinely different properties. So an email
    // match cannot be believed on its own, and the SHEET is what settles it —
    // if the same address is written against two differently named properties
    // in this very import, it is a mailbox, not an identity. For such an
    // address rung 1 never fires AND the duplicate refusal never fires, so
    // the second property is created exactly as it should be. Asking the
    // INCOMING side rather than the existing one is deliberate: the existing
    // side being doubled up is the bug we are closing, so it is not evidence.
    const emailNames = new Map();
    for (const row of incoming) {
      const ek = importEmailKey(row && row.email);
      const nk = importNameKey(row && row.name);
      if (!ek || !nk) continue;
      if (!emailNames.has(ek)) emailNames.set(ek, new Set());
      emailNames.get(ek).add(nk);
    }
    function sharedMailbox(ek) {
      const seen = ek ? emailNames.get(ek) : null;
      return !!seen && seen.size > 1;
    }

    // ── IS THIS BT ID AN IDENTITY, OR A COLUMN OF ROW NUMBERS? ──────────
    // The INCOMING side is counted, the way bt-match.js counts btNameCount /
    // btEmailCount before it will let a rung fire. An id written against two
    // different rows of one file identifies neither of them: row 1 INSERTs
    // and is stamped with it, and row 2 then rung-0 matches the client row 1
    // had just made and renames it. That is how a 384-row sheet whose Id
    // column holds one repeated value collapses to a single client and still
    // reports 0 errors - and no denylist can catch a repeated value that is
    // well-formed ("PENDING", a genuine id pasted down the column).
    const btRowCount = new Map();
    for (const row of incoming) {
      const k = importBtKey(pickImportOnly(row || {}).bt_contact_id);
      if (k) btRowCount.set(k, (btRowCount.get(k) || 0) + 1);
    }

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
        // The SAME normalized key the rows below use. A firm written "Sentry
        // Management" in one row and "Sentry  Management" in the next is one
        // firm; this loop minted two of it, and then handed half the
        // properties a different parent than the other half.
        //
        // A stub is keyed by NAME ONLY, never by email, and that is a
        // decision rather than an omission. The sheet carries no address for
        // the FIRM — the email on a row is the property contact's. Letting a
        // stub match it would bind the parent to whichever property came
        // first in the file, and every later row under that firm would then
        // resolve parent_client_id to a sibling PROPERTY instead of the
        // firm, inverting the hierarchy this loop exists to build. The
        // company name is the only thing the sheet actually says about the
        // company, so it is the only thing the stub may key on.
        const key = importNameKey(company);
        if ((byName.get(key) || []).length) continue;
        const id = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await client.query(
          // The parent-company stub created by the import. Every other client
          // insert in this file builds its column list dynamically and already
          // emits organization_id; this fixed list did not, so a re-import
          // seeded un-stamped parents that the dedup index above (correctly
          // org-scoped) would then never match again from another tenant.
          // req.user.organization_id is what the surrounding read already binds.
          `INSERT INTO clients (id, name, company_name, client_type, organization_id)
           VALUES ($1, $2, $2, 'Property Mgmt', $3)`,
          [id, company, req.orgId]
        );
        pushIdx(byName, key, id);
        nameOf.set(id, company);
        parentsCreated++;
      }

      // Phase 2: per-row upsert. Each row walks the rung ladder and either
      // UPDATEs the client it identified, INSERTs a new one, or is REFUSED as
      // a possible duplicate. parent_client_id is resolved from byName via
      // the row's company_name (or null if none / row IS the company itself).
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      const errors = [];
      // WHICH rung matched, counted. Without this the response says "updated:
      // 384" and cannot tell the user whether their Buildertrend ids did any
      // work or whether every row fell through to the name again.
      const matchedBy = { bt_contact_id: 0, email: 0, name: 0 };

      // bt_contact_id lives under UNIQUE (organization_id, bt_contact_id)
      // WHERE bt_contact_id IS NOT NULL, so the import stamps one only where
      // it is free to: never over a different link, never onto a second
      // client. That is the same "taken" check
      // services/clickr/sync-apply.js makes before IT stamps. A refusal is
      // REPORTED rather than swallowed — quietly dropping an identity is the
      // same class of bug as the one this change closes. The row's other
      // fields still import; only the id is withheld.
      const stampFor = (bk, targetId, i, name) => {
        if (!bk) return '';
        // The other direction — "this id already belongs to a DIFFERENT client"
        // — is not checked here because it cannot happen: if byBtId held this
        // id, rung 0 matched it and targetId IS that client. Rung 0 is what
        // keeps the unique index safe, not a second guard down here, and a
        // guard that can never fire is a line no test can ever defend.
        const cur = btIdOf.get(targetId);
        if (cur === bk) return '';   // already linked — nothing to write
        if (cur) {
          errors.push({ row: i, name, reason: 'bt_id_conflict', rung: 'bt_contact_id',
            matchedId: targetId, matchedName: nameOf.get(targetId) || '',
            error: '"' + (nameOf.get(targetId) || name) + '" is already linked to Buildertrend id ' + cur
              + ', so id ' + bk + ' from this row was not written. The rest of this row was imported.' });
          return '';
        }
        return bk;
      };
      for (let i = 0; i < incoming.length; i++) {
        const row = incoming[i] || {};
        const name = (row.name || '').trim();
        if (!name) { errors.push({ row: i, error: 'missing name' }); continue; }


        const key = importNameKey(name);
        const ek = importEmailKey(row.email);
        // The ONLY read of bt_contact_id off a request body in this file, and
        // the ONE predicate both doors use - the same importBtKey that indexed
        // the existing side above. The key and the STAMP are the same value,
        // so a cell rung 0 refuses to match on can never be written either.
        const rawBk = importBtKey(pickImportOnly(row).bt_contact_id);
        const bk = rawBk && btRowCount.get(rawBk) === 1 ? rawBk : '';
        if (rawBk && !bk) {
          // Reported, not swallowed: "384 rows, 0 errors" is exactly the lie
          // this change exists to stop telling. The row itself still imports
          // on its name or email - precisely what happens today when the
          // sheet has no id column at all - and only the id is withheld.
          errors.push({ row: i, name, reason: 'bt_id_repeated', rung: 'bt_contact_id',
            error: 'Buildertrend id ' + rawBk + ' appears on ' + btRowCount.get(rawBk)
              + ' rows of this file, so it identifies none of them. This row was matched on'
              + ' its email or name instead and no id was written.' });
        }

        // ── THE LADDER ────────────────────────────────────────────────────
        let matchId = null;
        let rung = null;
        const btHits = bk ? (byBtId.get(bk) || []) : [];
        const nameHits = byName.get(key) || [];
        // A bt key held by more than one client is not an identity. Taking
        // btHits[0] would write the SELECT's arbitrary row order into the
        // database; INSERTing would mint one more duplicate. Refusing does
        // neither, and names every side so the user can fold them with the
        // merge action. This is reachable in production, not only in a
        // constraint-free harness: uq_clients_org_bt_contact_id is UNIQUE
        // (organization_id, bt_contact_id), Postgres never conflicts a NULL
        // organization on that index against a real one, and the read above
        // deliberately carries the org-less tolerance arm - so it can hand
        // this rung an org-less row and this org's row under one id.
        if (btHits.length > 1) {
          errors.push({ row: i, name, reason: 'possible_duplicate', rung: 'bt_contact_id',
            matchedId: btHits[0], matchedName: nameOf.get(btHits[0]) || '',
            error: 'Possible duplicate - NOT imported. Buildertrend id ' + bk + ' is linked to '
              + btHits.map((h) => '"' + (nameOf.get(h) || h) + '"').join(', ')
              + '. Unlink or merge them, then re-import.' });
          skipped++;
          continue;
        }
        if (btHits.length) { matchId = btHits[0]; rung = 'bt_contact_id'; }   // >1 already continued
        if (!matchId && ek && !sharedMailbox(ek)) {
          // A 1:1 address AND names that corroborate. Either half on its own
          // is how a wrong merge gets made: the address alone folds two of a
          // firm's properties together, and a name alone is what we are here
          // to stop trusting.
          //
          // But this rung corroborates with a LOOSER key than rung 2 keys on,
          // so it may not outrank rung 2's exact answer. If the directory
          // already holds this exact name on a DIFFERENT client, that client
          // is the match and this rung stands down - otherwise it renames an
          // approximate neighbour ONTO the incoming name, mints the
          // byte-identical duplicate this ladder exists to close, and leaves
          // the exactly-named client sitting untouched beside it. An empty
          // loose key is not agreement either: a Name cell of "-", "." or an
          // em dash, which a spreadsheet produces routinely, folds to '' and
          // would make the corroboration vacuous on '' === ''.
          const hits = byEmail.get(ek) || [];
          const lk = importNameKeyLoose(name);
          if (lk && hits.length === 1
              && (nameHits.length === 0 || (nameHits.length === 1 && nameHits[0] === hits[0]))
              && importNameKeyLoose(nameOf.get(hits[0])) === lk) {
            matchId = hits[0];
            rung = 'email';
          }
        }
        if (!matchId && nameHits.length === 1) { matchId = nameHits[0]; rung = 'name'; }

        // ── THE NAME REFUSAL ──────────────────────────────────────────────
        // A name key held by two clients is not an identity either, and this
        // refusal is NOT gated on an email, unlike the one below it. Today's
        // sheet carries no id column, so essentially every row lands on rung
        // 2, and a collapsed pair with no address on either half would
        // otherwise fall straight past both refusals into INSERT and mint a
        // third copy of a property already in the directory twice.
        if (!matchId && nameHits.length > 1) {
          errors.push({ row: i, name, reason: 'possible_duplicate', rung: 'name',
            matchedId: nameHits[0], matchedName: nameOf.get(nameHits[0]) || '',
            error: 'Possible duplicate - NOT imported. "' + name + '" matches ' + nameHits.length
              + ' existing clients whose names differ only by spacing, dash glyph or case: '
              + nameHits.map((h) => '"' + (nameOf.get(h) || h) + '"').join(', ')
              + '. Merge them, then re-import.' });
          skipped++;
          continue;
        }

        // ── THE EMAIL REFUSAL ─────────────────────────────────────────────
        // No rung reached this row, but its email is already on a client under
        // a different name. That is exactly the nine: one property, once as
        // "Pensum - Fountain Square Apartments" and once as "BH - Fountain
        // Square Apartments". Inserting here is how the tenth gets made.
        // Nothing is written and the row is reported with BOTH names, so the
        // user can fold them with POST /api/clients/merge or fix the sheet.
        // sharedMailbox() has already carved out the firm-mailbox case above,
        // so a second genuinely different property is created, not refused.
        if (!matchId && ek && !sharedMailbox(ek)) {
          const hits = byEmail.get(ek) || [];
          if (hits.length) {
            errors.push({
              row: i, name, reason: 'possible_duplicate', rung: 'email',
              matchedId: hits[0], matchedName: nameOf.get(hits[0]) || '',
              error: 'Possible duplicate — NOT imported. "' + name + '" carries the email ' + ek
                + ', which already belongs to ' + hits.map((h) => '"' + (nameOf.get(h) || h) + '"').join(', ')
                + '. If they are the same client, merge them; if they are different, give this row its own email.'
            });
            skipped++;
            continue;
          }
        }

        // Resolve parent, AFTER the refusals rather than before them.
        // parentId is read only by the UPDATE and INSERT branches below, and
        // the ambiguous-firm report says "This row imported" - which a row
        // that had just been refused would make into a lie.
        //
        // A row whose name equals its own company_name is
        // the company itself, so it has no parent. Normalized on both sides,
        // or the extra space that split the firm splits it again here.
        let parentId = null;
        if (row.company_name && importNameKey(row.company_name) !== importNameKey(name)) {
          // A company name that resolves to TWO clients cannot say which is
          // the parent either. Hanging half a firm's properties off one twin
          // and half off the other inverts the hierarchy the stub loop exists
          // to build, and no rollup can add the halves back together - so an
          // ambiguous firm leaves parent_client_id null, and says so.
          const ph = byName.get(importNameKey(row.company_name)) || [];
          parentId = ph.length === 1 ? ph[0] : null;
          if (ph.length > 1) {
            errors.push({ row: i, name, reason: 'ambiguous_parent', rung: 'name',
              error: '"' + String(row.company_name).trim() + '" names ' + ph.length + ' clients ('
                + ph.map((h) => '"' + (nameOf.get(h) || h) + '"').join(', ')
                + '), so it cannot say which is the parent. This row imported with no parent company.' });
          }
        }
        const fields = pickEditable(row);
        fields.activation_status = (fields.activation_status || 'active').toLowerCase();

        if (matchId) {
          // UPDATE: only set non-empty fields so partial rows don't blank
          // out richer existing data. The id comes from whichever rung matched,
          // NOT from the name — that is the whole change.
          const existingId = matchId;
          const sets = [];
          const params = [];
          let p = 1;
          for (const k of Object.keys(fields)) {
            if (fields[k] === '' || fields[k] == null) continue;
            sets.push(k + ' = $' + p++);
            params.push(fields[k]);
          }
          const stamp = stampFor(bk, existingId, i, name);
          if (stamp) {
            sets.push('bt_contact_id = $' + p++);
            params.push(stamp);
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
              if (rung) matchedBy[rung]++;
              // Keep the ladder's index true for the rows still to come: a
              // rung-0 match may have RENAMED this client, and a later row
              // carrying the new name must land on it and not mint a twin.
              //
              // The OLD key has to be RETIRED as well as the new one installed
              // - the direction the forward test does not cover. Leave it
              // behind and a later row carrying the old name rung-2 matches a
              // client that no longer bears it, renames it straight back, and
              // is itself never created: two rows in, one row out, reported as
              // "updated: 2, 0 errors". nameOf still holds the PRE-update name
              // on this line, which is what makes the old key findable. Only
              // THIS id leaves it - a key two clients share must keep its
              // other inhabitant, or the next row mints a twin of a client
              // that is sitting right there.
              const prevKey = importNameKey(nameOf.get(existingId));
              if (prevKey && prevKey !== key) dropIdx(byName, prevKey, existingId);
              pushIdx(byName, key, existingId);
              nameOf.set(existingId, name);
              if (ek) pushIdx(byEmail, ek, existingId);
              if (stamp) { pushIdx(byBtId, stamp, existingId); btIdOf.set(existingId, stamp); }
            } catch (e) {
              errors.push({ row: i, name, error: e.message });
            }
          }
        } else {
          const id = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          // Wave A (A7): stamp organization_id on import (clients has the column).
          const cols = ['id', 'name', 'parent_client_id', 'organization_id'];
          const vals = [id, name, parentId, req.orgId];
          for (const k of Object.keys(fields)) {
            if (k === 'name') continue;
            if (fields[k] === '' || fields[k] == null) continue;
            cols.push(k);
            vals.push(fields[k]);
          }
          const stamp = stampFor(bk, id, i, name);
          if (stamp) { cols.push('bt_contact_id'); vals.push(stamp); }
          const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
          try {
            await client.query(`INSERT INTO clients (${cols.join(', ')}) VALUES (${placeholders})`, vals);
            pushIdx(byName, key, id);
            nameOf.set(id, name);
            if (ek) pushIdx(byEmail, ek, id);
            if (stamp) { pushIdx(byBtId, stamp, id); btIdOf.set(id, stamp); }
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
        skipped,
        matchedBy,
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
