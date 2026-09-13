'use strict';
// ── BUILDERTREND → PROJECT 86: APPLY ─────────────────────────────────────
//
// The write half of the Buildertrend preview (sync-preview.js is the read
// half). An admin presses Apply on a row, or "Apply safe updates" for a whole
// dataset, and this module:
//
//   1. re-reads Clickr (or reuses the preview's read of the last few minutes)
//      and re-reads P86, then re-runs the SAME matcher. Nothing the browser
//      sends is trusted except which Buildertrend ids to act on;
//   2. acts only on rows the matcher calls matched/conflict — never ambiguous,
//      possible duplicate, new, change order or refused;
//   3. writes only the fields below, only when P86 still holds the value the
//      proposal was made from (a field someone edited since is skipped, named);
//   4. stamps the Buildertrend id (jobs.bt_job_id / leads.bt_lead_id, and
//      clients.bt_contact_id when the lead's client is the Buildertrend contact),
//      so every later preview finds the pair by id.
//
// MONEY AND IDENTITY: Buildertrend's contract price is a correction (owner: BT
// is the source of truth), applied when its box is ticked and never by safe
// mode. The job number and lead revenue are applied ONLY when a person ticks
// them (fields list). Approved change orders are never written (P86 sums them
// from its change orders). Estimates, change orders, POs and crew-side data are
// never written. Nothing is created or deleted.
//
// MODES
//   rows — the given Buildertrend ids: link + the ticked fields (every correction
//          on the row when no fields list is sent).
//   safe — every confident row in the dataset: link + fill a BLANK P86 start
//          date from Buildertrend's projected start (the owner's call: that is
//          safe to fill without review; P86's own start date is never replaced).
//
// Gates are the preview's: the host route's ROLES_MANAGE, then the caller's
// organization must be the one CLICKR_API_KEY belongs to (ownerSlug).
//
// Reached as a MODE of PUT /api/admin/organizations/me (?action=buildertrend-apply),
// so the committed route census does not move.

const { DATASETS, readRecord } = require('./field-map');
const { fetchDataset } = require('./client');
const match = require('./bt-match');
const preview = require('./sync-preview');
const { auditLog } = require('../../audit');

const ACTION_PARAM = 'buildertrend-apply';
const MAX_ROWS = 200;

const JOB_FIELD_KEYS = { title: 'title', street: 'street_address', city: 'city', state: 'state', zip: 'zip', status: 'status', startDate: 'startDate' };
const LEAD_FIELD_COLUMNS = { title: 'title', street: 'street_address', city: 'city', state: 'state', zip: 'zip', source: 'source', confidence: 'confidence' };
const LEAD_ADDRESS = ['street', 'city', 'state', 'zip'];
const JOB_ADDRESS = ['street', 'city', 'state', 'zip'];

const str = (v) => (v == null ? '' : String(v));
const norm = (v) => str(v).trim().replace(/\s+/g, ' ');
const CONFIDENT = new Set(['matched', 'conflict']);

// P86 may hold 0, '' or null for "no figure": compared as numbers.
const moneyEq = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
const LEAD_REVENUE_COLUMNS = { estimatedRevenueMin: 'estimated_revenue_low', estimatedRevenueMax: 'estimated_revenue_high' };

function isSafeCorrection(kind, c) {
  return kind === 'jobs' && c.field === 'startDate' && c.kind === 'fill';
}

// Which corrections a row may write in this mode. In rows mode a `fields` list
// (the boxes a person left ticked) narrows it; without one every correction on
// the row applies. Safe mode is the blank start date only — never money.
function writable(kind, row, mode, fields) {
  const allowed = kind === 'jobs'
    ? Object.assign({ contractPrice: 1 }, JOB_FIELD_KEYS)
    : Object.assign({ salesperson: 1, client: 1 }, LEAD_FIELD_COLUMNS);
  const pick = fields ? new Set(fields) : null;
  return (row.corrections || []).filter((c) => allowed[c.field]
    && (mode === 'rows' ? (!pick || pick.has(c.field)) : isSafeCorrection(kind, c)));
}

// Held-back items a person TICKED. Only in rows mode, only when the request
// names the field, only items the matcher marks applicable (job number, lead
// revenue). Approved change orders and unparsed money are never applicable.
function pickedHeldBack(kind, row, mode, fields) {
  if (mode !== 'rows' || !fields) return [];
  const allowed = kind === 'jobs' ? { jobNumber: 1 } : LEAD_REVENUE_COLUMNS;
  const pick = new Set(fields);
  return (row.heldBack || []).filter((h) => h.applicable === true && allowed[h.field] && pick.has(h.field));
}

async function readDataset(org, kind, deps) {
  const cached = preview.cachedFetch && preview.cachedFetch(org.id, kind, deps.maxAgeMs);
  if (cached) return cached;
  const env = deps.env || process.env;
  const apiKey = env.CLICKR_API_KEY ? String(env.CLICKR_API_KEY).trim() : '';
  return fetchDataset({ datasetId: DATASETS[kind].datasetId, label: DATASETS[kind].label, apiKey,
    transport: deps.transport, limits: deps.limits, now: deps.now, baseUrl: deps.baseUrl });
}

// ── jobs ─────────────────────────────────────────────────────────────────
async function applyJob(db, orgId, row, mode, fields) {
  const btId = norm(row.bt.btId);
  const cur = await db.query('SELECT id, data, bt_job_id FROM jobs WHERE id = $1 AND organization_id = $2 FOR UPDATE', [row.p86.id, orgId]);
  if (!cur.rows.length) return { skipped: 'The P86 job is no longer there.' };
  const job = cur.rows[0];
  const linkedTo = norm(job.bt_job_id);
  if (linkedTo && linkedTo !== btId) return { skipped: 'This P86 job is already linked to a different Buildertrend job.' };
  const taken = await db.query('SELECT id FROM jobs WHERE organization_id = $1 AND bt_job_id = $2 AND id <> $3', [orgId, btId, job.id]);
  if (taken.rows.length) return { skipped: 'Another P86 job is already linked to this Buildertrend job.' };

  const data = (job.data && typeof job.data === 'object') ? Object.assign({}, job.data) : {};
  const applied = [];
  const stale = [];
  for (const c of writable('jobs', row, mode, fields)) {
    if (c.field === 'contractPrice') {
      if (!moneyEq(data.contractAmount, c.p86Value) || !Number.isFinite(c.value)) { stale.push(c.label || c.field); continue; }
      data.contractAmount = c.value;
      applied.push({ field: c.field, from: c.from, to: c.to });
      continue;
    }
    const key = JOB_FIELD_KEYS[c.field];
    const now = c.field === 'title' ? (data.title || data.name) : data[key];
    if (norm(now) !== norm(c.from)) { stale.push(c.label || c.field); continue; }
    const value = c.field === 'status' ? (c.toP86 || c.to) : c.to;
    data[key] = value;
    applied.push({ field: c.field, from: c.from, to: value });
  }
  for (const h of pickedHeldBack('jobs', row, mode, fields)) {
    // JOB NUMBER, ticked on purpose. Still refused when P86 changed it since the
    // preview, or when another job of this organization already carries it.
    if (norm(data.jobNumber) !== norm(h.p86)) { stale.push(h.label || h.field); continue; }
    const clash = await db.query(
      "SELECT id FROM jobs WHERE organization_id = $1 AND id <> $2 AND UPPER(TRIM(data->>'jobNumber')) = UPPER(TRIM($3))",
      [orgId, job.id, h.value]);
    if (clash.rows.length) { stale.push((h.label || h.field) + ' — another P86 job already uses ' + h.value); continue; }
    data.jobNumber = h.value;
    applied.push({ field: h.field, from: h.p86, to: h.value });
  }
  if (applied.some((a) => JOB_ADDRESS.includes(a.field))) {
    // Same composition the job page uses (js/jobs.js saveJobAddress); the map
    // re-geocodes lazily when geocode_address no longer equals it.
    data.address = [data.street_address, data.city, data.state, data.zip].filter((x) => norm(x)).join(', ');
  }
  const wasLinked = linkedTo === btId;
  if (!applied.length && wasLinked) return { unchanged: true, stale };
  await db.query('UPDATE jobs SET data = $1::jsonb, bt_job_id = $2, updated_at = NOW() WHERE id = $3 AND organization_id = $4',
    [JSON.stringify(data), btId, job.id, orgId]);
  return { applied, linked: !wasLinked, stale };
}

// ── leads ────────────────────────────────────────────────────────────────
async function applyLead(db, orgId, row, mode, fields) {
  const btId = norm(row.bt.btId);
  // Lock the lead row on its own: Postgres refuses FOR UPDATE across the outer
  // joins below.
  await db.query('SELECT id FROM leads WHERE id = $1 AND organization_id = $2 FOR UPDATE', [row.p86.id, orgId]);
  const cur = await db.query(
    'SELECT l.id, l.title, l.street_address, l.city, l.state, l.zip, l.source, l.confidence, l.salesperson_id, l.client_id, l.bt_lead_id, '
    + 'l.estimated_revenue_low, l.estimated_revenue_high, '
    + 'u.name AS salesperson_name, c.name AS client_name '
    + 'FROM leads l '
    + 'LEFT JOIN users u ON u.id = l.salesperson_id AND u.organization_id = $2 '
    + 'LEFT JOIN clients c ON c.id = l.client_id AND c.organization_id = $2 '
    + 'WHERE l.id = $1 AND l.organization_id = $2', [row.p86.id, orgId]);
  if (!cur.rows.length) return { skipped: 'The P86 lead is no longer there.' };
  const lead = cur.rows[0];
  const linkedTo = norm(lead.bt_lead_id);
  if (linkedTo && linkedTo !== btId) return { skipped: 'This P86 lead is already linked to a different Buildertrend lead.' };
  const taken = await db.query('SELECT id FROM leads WHERE organization_id = $1 AND bt_lead_id = $2 AND id <> $3', [orgId, btId, lead.id]);
  if (taken.rows.length) return { skipped: 'Another P86 lead is already linked to this Buildertrend lead.' };

  const sets = {};
  const applied = [];
  const stale = [];
  for (const h of pickedHeldBack('leads', row, mode, fields)) {
    // LEAD REVENUE, ticked on purpose.
    const col = LEAD_REVENUE_COLUMNS[h.field];
    if (!moneyEq(lead[col], h.p86Value) || !Number.isFinite(h.value)) { stale.push(h.label || h.field); continue; }
    sets[col] = h.value;
    applied.push({ field: h.field, from: h.p86, to: h.bt });
  }
  for (const c of writable('leads', row, mode, fields)) {
    if (c.field === 'salesperson' || c.field === 'client') {
      const current = c.field === 'salesperson' ? lead.salesperson_name : lead.client_name;
      if (norm(current) !== norm(c.from)) { stale.push(c.label || c.field); continue; }
      // The matcher names exactly one org record; confirm it still is exactly one.
      const hit = c.field === 'salesperson'
        ? await db.query('SELECT id FROM users WHERE organization_id = $1 AND active = true AND LOWER(TRIM(name)) = LOWER(TRIM($2))', [orgId, c.to])
        : await db.query('SELECT id FROM clients WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))', [orgId, c.to]);
      if (hit.rows.length !== 1) { stale.push(c.label || c.field); continue; }
      sets[c.field === 'salesperson' ? 'salesperson_id' : 'client_id'] = hit.rows[0].id;
      applied.push({ field: c.field, from: c.from, to: c.to });
      continue;
    }
    const col = LEAD_FIELD_COLUMNS[c.field];
    if (norm(lead[col]) !== norm(c.from)) { stale.push(c.label || c.field); continue; }
    sets[col] = c.field === 'confidence' ? Math.max(0, Math.min(100, parseInt(c.to, 10) || 0)) : c.to;
    applied.push({ field: c.field, from: c.from, to: c.to });
  }
  const addressChanged = applied.some((a) => LEAD_ADDRESS.includes(a.field));
  if (addressChanged) { sets.geocode_lat = null; sets.geocode_lng = null; }
  const wasLinked = linkedTo === btId;

  let contactLinked = false;
  const contactId = norm(row.bt.contactId);
  if (contactId) {
    // The lead's client (after this apply) IS the Buildertrend contact when the
    // names agree exactly; stamp its id once, never over a different one.
    const clientId = sets.client_id != null ? sets.client_id : lead.client_id;
    if (clientId != null) {
      const cl = await db.query('SELECT id, name, bt_contact_id FROM clients WHERE id = $1 AND organization_id = $2', [clientId, orgId]);
      const client = cl.rows[0];
      if (client && !norm(client.bt_contact_id) && norm(client.name).toLowerCase() === norm(row.bt.contactName).toLowerCase()) {
        const other = await db.query('SELECT id FROM clients WHERE organization_id = $1 AND bt_contact_id = $2', [orgId, contactId]);
        if (!other.rows.length) {
          await db.query('UPDATE clients SET bt_contact_id = $1 WHERE id = $2 AND organization_id = $3', [contactId, client.id, orgId]);
          contactLinked = true;
        }
      }
    }
  }

  if (!applied.length && wasLinked) return { unchanged: !contactLinked, contactLinked, stale };
  const cols = Object.keys(sets);
  const params = cols.map((k) => sets[k]);
  params.push(btId, lead.id, orgId);
  const n = params.length;
  await db.query('UPDATE leads SET ' + cols.map((k, i) => k + ' = $' + (i + 1)).concat(['bt_lead_id = $' + (n - 2), 'updated_at = NOW()']).join(', ')
    + ' WHERE id = $' + (n - 1) + ' AND organization_id = $' + n, params);
  return { applied, linked: !wasLinked, stale, contactLinked, regeocode: addressChanged ? lead.id : null };
}

async function geocodeLeadLater(pool, id) {
  try {
    const r = await pool.query('SELECT street_address, city, state, zip FROM leads WHERE id = $1', [id]);
    const l = r.rows[0];
    if (!l) return;
    const parts = [l.street_address, l.city, l.state, l.zip].map((s) => norm(s)).filter(Boolean);
    if (parts.length < 2) return;
    const g = await require('../../geocoder').geocodeAddress(parts.join(', '));
    if (g && Number.isFinite(g.lat) && Number.isFinite(g.lng) && !(g.lat === 0 && g.lng === 0)) {
      await pool.query("UPDATE leads SET geocode_lat = $1, geocode_lng = $2, geocode_status = 'ok', geocode_at = NOW() WHERE id = $3", [g.lat, g.lng, id]);
    } else {
      await pool.query("UPDATE leads SET geocode_status = 'failed', geocode_at = NOW() WHERE id = $1", [id]);
    }
  } catch (e) { console.error('[clickr-apply] lead geocode failed'); }
}

// ── the operation ────────────────────────────────────────────────────────
async function apply(org, input, deps) {
  const kind = input.dataset;
  const mode = input.mode;
  const fr = await readDataset(org, kind, deps);
  if (fr.error) return { status: 502, body: { error: 'Clickr could not be read, so nothing was applied. ' + (fr.error.message || '') } };
  if (fr.complete !== true) {
    return { status: 409, body: { error: 'The Buildertrend read was incomplete (' + fr.fetched + ' records), so nothing was applied. Refresh the preview and try again.' } };
  }
  const p86 = await preview.readP86(deps.pool, org.id);
  const values = fr.records.map((r) => readRecord(kind, r));
  const rows = kind === 'jobs'
    ? match.matchJobs(values, p86.jobs, { coTotals: p86.coTotals })
    : match.matchLeads(values, p86.leads, { directory: p86.directory });

  let targets;
  if (mode === 'safe') {
    targets = rows.filter((r) => CONFIDENT.has(r.class));
  } else {
    const wanted = new Set(input.btIds.map(norm));
    targets = rows.filter((r) => wanted.has(norm(r.bt.btId)));
  }
  const results = [];
  const seen = new Set(targets.map((r) => norm(r.bt.btId)));
  if (mode === 'rows') {
    for (const id of input.btIds.map(norm)) {
      if (!seen.has(id)) results.push({ btId: id, outcome: 'skipped', reason: 'No Buildertrend record with that id in this read.' });
    }
  }

  const regeocode = [];
  for (const row of targets) {
    const base = { btId: norm(row.bt.btId), label: row.bt.raw || row.bt.title || '', p86Id: row.p86 ? row.p86.id : null };
    if (!CONFIDENT.has(row.class) || !row.p86) {
      results.push(Object.assign(base, { outcome: 'skipped', reason: 'Not a confident match (' + row.class.replace(/_/g, ' ') + '), so nothing was applied.' }));
      continue;
    }
    if (!norm(row.bt.btId)) {
      results.push(Object.assign(base, { outcome: 'skipped', reason: 'Buildertrend sent this record without an id, so it cannot be linked.' }));
      continue;
    }
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const r = kind === 'jobs' ? await applyJob(client, org.id, row, mode, input.fields) : await applyLead(client, org.id, row, mode, input.fields);
      await client.query('COMMIT');
      if (r.skipped) results.push(Object.assign(base, { outcome: 'skipped', reason: r.skipped }));
      else if (r.unchanged) results.push(Object.assign(base, { outcome: 'unchanged', stale: r.stale }));
      else {
        results.push(Object.assign(base, { outcome: 'applied', linked: !!r.linked, fields: r.applied, stale: r.stale, contactLinked: !!r.contactLinked }));
        if (r.regeocode) regeocode.push(r.regeocode);
      }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      results.push(Object.assign(base, { outcome: 'failed', reason: 'The write failed inside this server; nothing on this record was changed.' }));
    } finally {
      client.release();
    }
  }

  const counts = { applied: 0, unchanged: 0, skipped: 0, failed: 0, linked: 0, fields: 0 };
  for (const r of results) {
    counts[r.outcome]++;
    if (r.linked) counts.linked++;
    counts.fields += (r.fields || []).length;
  }
  if (preview.forgetFetch) preview.forgetFetch(org.id);
  return { status: 200, body: { dataset: kind, mode, counts, results }, regeocode };
}

function parseInput(body) {
  const b = body || {};
  const dataset = b.dataset;
  if (dataset !== 'jobs' && dataset !== 'leads') return { error: 'dataset must be "jobs" or "leads".' };
  const mode = b.mode === 'safe' ? 'safe' : 'rows';
  if (mode === 'rows') {
    const ids = Array.isArray(b.btIds) ? b.btIds.filter((x) => (typeof x === 'string' || typeof x === 'number') && norm(x)) : [];
    if (!ids.length) return { error: 'btIds must list at least one Buildertrend id.' };
    if (ids.length > MAX_ROWS) return { error: 'At most ' + MAX_ROWS + ' records per apply.' };
    let fields = null;
    if (b.fields !== undefined) {
      if (!Array.isArray(b.fields) || b.fields.length > 30 || b.fields.some((x) => typeof x !== 'string' || !/^[A-Za-z]{1,40}$/.test(x))) {
        return { error: 'fields must be a list of field names.' };
      }
      fields = b.fields;
    }
    return { dataset, mode, btIds: ids.map(String), fields };
  }
  return { dataset, mode, btIds: [], fields: null };
}

let inFlight = false;

// Called from PUT /api/admin/organizations/me AFTER requireAuth, requireOrg and
// requireCapability('ROLES_MANAGE') have passed.
async function handle(req, res, deps) {
  const env = (deps && deps.env) || process.env;
  const org = req.organization;
  if (!org || org.id == null) return res.status(403).json({ error: 'Buildertrend apply needs an organization.' });
  if (String(org.slug || '') !== preview.ownerSlug(env)) {
    return res.status(403).json({ error: 'Buildertrend apply is not available for this organization. The Buildertrend connection on this server belongs to a different company.', code: 'CLICKR_NOT_THIS_ORG' });
  }
  const input = parseInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  if (inFlight) return res.status(429).json({ error: 'A Buildertrend apply is already running on this server. Try again in a moment.', code: 'CLICKR_APPLY_BUSY' });
  inFlight = true;
  try {
    const out = await apply(org, input, Object.assign({ env }, deps));
    res.set('Cache-Control', 'no-store');
    res.status(out.status).json(out.body);
    if (out.status === 200) {
      auditLog(req, {
        action: 'buildertrend.apply',
        targetType: input.dataset === 'jobs' ? 'job' : 'lead',
        targetId: input.mode === 'safe' ? 'safe updates' : String(input.btIds.length) + ' records',
        organizationId: org.id,
        detail: { mode: input.mode, counts: out.body.counts,
          applied: out.body.results.filter((r) => r.outcome === 'applied').map((r) => ({ btId: r.btId, p86Id: r.p86Id, linked: r.linked, fields: r.fields })) },
      });
      for (const id of out.regeocode || []) geocodeLeadLater(deps.pool, id);
    }
  } catch (e) {
    console.error('[clickr-apply] apply failed');
    if (!res.headersSent) res.status(500).json({ error: 'The Buildertrend apply failed inside this server.' });
  } finally {
    inFlight = false;
  }
}

module.exports = { handle, apply, parseInput, writable, pickedHeldBack, ACTION_PARAM };
