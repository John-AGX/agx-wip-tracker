'use strict';
// ── BUILDERTREND → PROJECT 86 SYNC PREVIEW ────────────────────────────────
//
// READ-ONLY. This module issues SELECTs against the P86 database and GETs
// against Clickr, and nothing else. It stamps no audit row, caches nothing,
// geocodes nothing. What a proposal may contain is enforced in ./bt-match.js.
//
// ── WHO MAY SEE IT ───────────────────────────────────────────────────────
// CLICKR_API_KEY is ONE global env var belonging to AG Exteriors' Buildertrend
// account. Two gates, both required:
//   1. ROLES_MANAGE — the host route's own middleware, before this code runs;
//   2. the caller's organisation IS the organisation the key belongs to, named
//      by slug in CLICKR_ORG_SLUG (default 'agx', the slug server/db.js seeds for
//      AGX). req.organization comes from requireOrg, which loaded it from the
//      VERIFIED user's organization_id; nothing from the request is consulted.
// SYSTEM_ADMIN buys nothing: a platform owner in another tenant is refused.
//
// ── THE P86 SIDE IS THAT ORGANISATION, EXACTLY ────────────────────────────
// Every SELECT below is `organization_id = $1`, including both JOINs (a lead
// whose salesperson or client belongs to another tenant reads as blank here,
// never as that tenant's name). Rows with NO organization are COUNTED and never
// matched — the job list route includes them (job-routes.js), and this preview
// deliberately does not.
//
// ── HOW IT IS REACHED ────────────────────────────────────────────────────
// A MODE of GET /api/admin/organizations/me (?view=buildertrend-preview), not a
// route of its own, so test/tenant-register2-http.test.js's committed route
// census does not move. Without the parameter /me answers exactly what it did.

const { DATASETS, readRecord, describeMapping } = require('./field-map');
const { fetchDataset, MIN_KEY_LENGTH } = require('./client');
const match = require('./bt-match');
const coMatch = require('./co-match');
const poMatch = require('./po-match');
const coMoney = require('../money/change-order-totals');

const VIEW_PARAM = 'buildertrend-preview';

function ownerSlug(env) {
  const s = String((env && env.CLICKR_ORG_SLUG) || '').trim();
  return s || 'agx';
}

function parseJsonish(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return v;
}

// Approved change-order money per P86 job, computed exactly as the WIP rollup
// computes it: server/services/money/change-order-totals.js — table rows win
// outright; a job with NO table rows falls back to its legacy data.changeOrders
// list; only approved/applied table rows count.
function changeOrderTotals(jobRows, coRows) {
  const byJob = new Map();
  for (const r of coRows) {
    if (!byJob.has(r.job_id)) byJob.set(r.job_id, []);
    byJob.get(r.job_id).push(r);
  }
  const out = new Map();
  for (const j of jobRows) {
    const tableRows = byJob.get(j.id) || [];
    try {
      if (tableRows.length) {
        const shaped = tableRows.map((r) => coMoney.shapeChangeOrderRow(Object.assign({}, r, { data: parseJsonish(r.data) || {} })));
        out.set(j.id, { computable: true, count: shaped.length, total: shaped.reduce((s, x) => s + (x.counted ? x.income : 0), 0),
          source: 'approved and applied change orders in P86 (' + shaped.filter((x) => x.counted).length + ' of ' + shaped.length + ')' });
      } else {
        const legacy = parseJsonish(j.legacy_cos);
        const list = Array.isArray(legacy) ? legacy : [];
        const shaped = list.map(coMoney.shapeLegacyChangeOrder);
        out.set(j.id, { computable: true, count: shaped.length, total: shaped.reduce((s, x) => s + x.income, 0),
          source: list.length ? 'the job\'s legacy change-order list (' + list.length + ')' : 'no change orders in P86' });
      }
    } catch (e) {
      out.set(j.id, { computable: false, count: tableRows.length, total: null, source: '',
        why: 'P86\'s change-order total for this job could not be computed read-only.' });
    }
  }
  return out;
}

const JOB_KEYS = ['jobNumber', 'title', 'name', 'status', 'street_address', 'city', 'state', 'zip', 'startDate', 'contractAmount'];

// P86 side. SELECT only, every statement `organization_id = $1`.
async function readP86(pool, orgId) {
  const jobsRaw = await pool.query(
    'SELECT id, ' + JOB_KEYS.map((k) => "data->>'" + k + "' AS \"" + k + '"').join(', ')
    + ", data->'changeOrders' AS legacy_cos, data->'purchaseOrders' AS legacy_pos, bt_job_id FROM jobs WHERE organization_id = $1 AND bt_archived_at IS NULL", [orgId]);
  const jobRows = jobsRaw.rows.map((r) => ({ id: r.id, legacy_cos: r.legacy_cos, legacy_pos: r.legacy_pos, bt_job_id: r.bt_job_id,
    data: Object.fromEntries(JOB_KEYS.map((k) => [k, r[k] == null ? '' : r[k]])) }));
  const leads = await pool.query(
    'SELECT l.id, l.title, l.status, l.street_address, l.city, l.state, l.zip, l.source, l.confidence, '
    + 'l.estimated_revenue_low, l.estimated_revenue_high, l.bt_lead_id, '
    // Converted = the lead <-> job link on EITHER side (jobs.lead_id or
    // leads.job_id), and only through a job of THIS organization: another
    // tenant's job naming this lead, or this lead naming another tenant's job,
    // does not mark it converted. leads.job_id itself is never read raw.
    + 'EXISTS (SELECT 1 FROM jobs j WHERE (j.lead_id = l.id OR j.id = l.job_id) AND j.organization_id = $1) AS has_job, '
    + 'u.name AS salesperson_name, c.name AS client_name '
    + 'FROM leads l '
    + 'LEFT JOIN users u ON u.id = l.salesperson_id AND u.organization_id = $1 '
    + 'LEFT JOIN clients c ON c.id = l.client_id AND c.organization_id = $1 '
    + 'WHERE l.organization_id = $1 AND l.bt_archived_at IS NULL', [orgId]);
  // Change orders reached through THEIR JOB's organization AND their own: a row
  // stamped with another organization is never read (even on this org's job),
  // and an older row with no organization is — missing it would read its
  // Buildertrend twin as "new" and create a duplicate.
  const cos = await pool.query(
    'SELECT co.id, co.job_id, co.status, co.co_number, co.data, co.is_locked, co.linked_node_id, co.bt_co_id '
    + 'FROM job_change_orders co JOIN jobs j ON j.id = co.job_id '
    + 'WHERE j.organization_id = $1 AND j.bt_archived_at IS NULL AND (co.organization_id = $1 OR co.organization_id IS NULL)', [orgId]);
  // Purchase orders on the same terms as change orders, with what is already
  // billed against each (a Buildertrend cost is never set below it) and the
  // sub's name only when the sub is this organization's.
  const pos = await pool.query(
    'SELECT po.id, po.job_id, po.status, po.po_number, po.data, po.is_locked, po.sub_id, po.bt_po_id, s.name AS sub_name, '
    + "(SELECT COALESCE(SUM(b.amount), 0) FROM job_vendor_bills b WHERE b.po_id = po.id AND b.status <> 'void') AS billed "
    + 'FROM job_purchase_orders po JOIN jobs j ON j.id = po.job_id LEFT JOIN subs s ON s.id = po.sub_id AND s.organization_id = $1 '
    + 'WHERE j.organization_id = $1 AND j.bt_archived_at IS NULL AND (po.organization_id = $1 OR po.organization_id IS NULL)', [orgId]);
  const subs = await pool.query("SELECT id, name FROM subs WHERE organization_id = $1 AND COALESCE(status, 'active') <> 'closed'", [orgId]);
  const users = await pool.query(
    'SELECT id, name FROM users WHERE organization_id = $1 AND active = true', [orgId]);
  const clients = await pool.query(
    'SELECT id, name, first_name, last_name, email, phone, cell, address, city, state, zip, parent_client_id, bt_contact_id FROM clients WHERE organization_id = $1 AND bt_archived_at IS NULL', [orgId]);
  // Rows with no organization: all rows minus the rows that carry one. Counted,
  // never read — no id, title or value of theirs is selected.
  const orphanJobs = await pool.query('SELECT COUNT(*) - COUNT(organization_id) AS n FROM jobs');
  const orphanLeads = await pool.query('SELECT COUNT(*) - COUNT(organization_id) AS n FROM leads');
  return {
    jobs: jobRows,
    leads: leads.rows,
    coTotals: changeOrderTotals(jobRows, cos.rows),
    coRows: cos.rows,
    poRows: pos.rows,
    subs: subs.rows,
    directory: { users: users.rows.map((r) => ({ id: r.id, name: r.name })), clients: clients.rows.map((r) => ({ id: r.id, name: r.name })) },
    clients: clients.rows,
    unscopedJobs: Number((orphanJobs.rows[0] && orphanJobs.rows[0].n) || 0),
    unscopedLeads: Number((orphanLeads.rows[0] && orphanLeads.rows[0].n) || 0),
  };
}

function fetchedSentence(ds, fr) {
  if (fr.error) return fr.error.message;
  const noun = ds.label.toLowerCase();
  const of = fr.reportedCount != null ? ' of ' + fr.reportedCount : '';
  if (fr.complete) {
    return 'Fetched ' + fr.fetched + of + ' ' + noun + ' in ' + fr.pages + ' page' + (fr.pages === 1 ? '' : 's') + ' — every record Clickr reported.';
  }
  return 'PARTIAL READ: fetched ' + fr.fetched + of + ' ' + noun + '. ' + String(fr.reason || 'The read did not complete').replace(/^./, (x) => x.toUpperCase()).replace(/\.?$/, '.')
    + ' Every count below covers only the records fetched.';
}

function notInBtSentence(ds, reliable, fr, p86Error, n, notListed) {
  const noun = ds.label.toLowerCase();
  const extra = ds.key === 'jobs'
    ? ' Only active P86 jobs are listed; ' + notListed + ' Completed or Archived P86 jobs no Buildertrend row reached are not.'
    : ds.key === 'clients'
    ? ' Buildertrend\'s client contacts are its whole directory, so every such P86 client and property is listed.'
    : ds.key === 'changeOrders'
    ? ' Only change orders on P86 jobs whose Buildertrend job sent change orders in this read are listed; ' + notListed + ' on other jobs are not (Clickr\'s change-order dataset covers open jobs only).'
    : ds.key === 'purchaseOrders'
    ? ' Only purchase orders on P86 jobs whose Buildertrend job sent purchase orders in this read are listed; ' + notListed + ' on other jobs are not (Clickr\'s purchase-order dataset covers open jobs only).'
    : ' Only open P86 leads are listed; ' + notListed + ' sold, lost or no-opportunity leads are expected to be absent (Buildertrend\'s Leads dataset holds open leads only).';
  const base = n + ' Project 86 ' + noun + ' were not reached by any Buildertrend record. Review only — nothing is proposed for deletion.' + extra;
  if (reliable) return base;
  return base + ' NOT RELIABLE: ' + (p86Error ? 'Project 86 could not be read completely' : 'Buildertrend\'s read could not be confirmed complete (fetched ' + fr.fetched
    + (fr.reportedCount != null ? ' of ' + fr.reportedCount : ', count unconfirmed') + (fr.reason ? ' — ' + fr.reason : '') + ')')
    + ', so some of these may be in the part that was not read. Do not act on this list.';
}

// The one place a dataset's records meet its matcher; Apply re-runs the same.
function matchRows(kind, values, p86) {
  if (kind === 'jobs') return match.matchJobs(values, p86.jobs, { coTotals: p86.coTotals });
  if (kind === 'clients') return match.matchClients(values, p86.clients || []);
  if (kind === 'changeOrders') return coMatch.matchChangeOrders(values, { jobs: p86.jobs, coRows: p86.coRows || [] });
  if (kind === 'purchaseOrders') return poMatch.matchPurchaseOrders(values, { jobs: p86.jobs, poRows: p86.poRows || [], subs: p86.subs || [] });
  return match.matchLeads(values, p86.leads, { directory: p86.directory });
}

const PREVIEW_KINDS = ['jobs', 'leads', 'clients', 'changeOrders', 'purchaseOrders'];

function buildDataset(kind, fr, p86, p86Error) {
  const ds = DATASETS[kind];
  const out = {
    key: kind, label: ds.label, datasetId: ds.datasetId,
    fetch: { fetched: fr.fetched, reportedCount: fr.reportedCount, pages: fr.pages, mode: fr.mode,
      complete: fr.complete, reason: fr.reason, elapsedMs: fr.elapsedMs },
    error: fr.error ? { kind: fr.error.kind, message: fr.error.message } : null,
    sentence: fetchedSentence(ds, fr),
    mapping: null, classified: false, summary: null, summaryOpen: null, rows: [], notInBuildertrend: null,
  };
  if (fr.error) return out;
  out.mapping = describeMapping(kind, fr.records);
  if (fr.fetched === 0) {
    out.error = { kind: 'empty', message: 'Clickr returned zero ' + ds.label.toLowerCase() + ' records. That is not "no matches" — there was nothing to compare.' };
    return out;
  }
  if (out.mapping.refusal) {
    out.error = { kind: 'mapping', message: out.mapping.refusal };
    return out;
  }
  if (p86Error) {
    out.error = { kind: 'p86_read', message: p86Error };
    return out;
  }
  const values = fr.records.map((r) => readRecord(kind, r));
  const rows = matchRows(kind, values, p86);
  const nib = kind === 'changeOrders'
    ? coMatch.notInBuildertrend(rows, values, p86)
    : kind === 'purchaseOrders'
    ? poMatch.notInBuildertrend(rows, values, p86)
    : match.notInBuildertrend(rows, kind === 'jobs' ? p86.jobs : kind === 'clients' ? (p86.clients || []) : p86.leads, kind);
  const reliable = fr.complete === true && !p86Error;
  out.classified = true;
  out.rows = rows;
  out.summary = match.summarise(rows);
  if (kind === 'jobs') out.summaryOpen = match.summarise(rows, (r) => r.bt.scope === 'open');
  out.notInBuildertrend = {
    reliable, count: nib.rows.length, notListed: nib.notListed,
    sentence: notInBtSentence(ds, reliable, fr, p86Error, nib.rows.length, nib.notListed),
    rows: nib.rows,
  };
  return out;
}

const KEY_WINDOW = 12;
const ENCODED_WINDOW = 16;

function windows(s, n) {
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

// What a leaked key could look like inside the response, all lower-cased:
//   * its first and last 8 characters (any longer prefix or suffix contains them);
//   * ANY 12 consecutive characters of it (a middle chunk, a truncated copy);
//   * any 16 consecutive characters of it base64 / base64url encoded (at each of
//     the three byte alignments), hex encoded, URL encoded, JSON- or \u-escaped.
function keyNeedles(apiKey) {
  const key = String(apiKey || '').trim();
  const low = key.toLowerCase();
  const encoded = [];
  const buf = Buffer.from(key, 'utf8');
  for (let pad = 0; pad < 3; pad++) {
    const b64 = Buffer.concat([Buffer.alloc(pad), buf]).toString('base64');
    // Drop the characters the padding bytes and the tail touch.
    const mid = b64.slice(Math.ceil((pad * 4) / 3) + 1, b64.length - 4);
    encoded.push(mid, mid.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  encoded.push(buf.toString('hex'), encodeURIComponent(key), JSON.stringify(key).slice(1, -1),
    key.split('').map((ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
  const enc = new Set();
  for (const e of encoded) for (const w of windows(e.toLowerCase(), ENCODED_WINDOW)) enc.add(w);
  return { fixed: [low.slice(0, 8), low.slice(-8)], keyWindows: windows(low, KEY_WINDOW), encWindows: enc };
}

function stringCarries(s, n) {
  const t = s.toLowerCase();
  if (n.fixed.some((x) => t.includes(x))) return true;
  for (let i = 0; i + KEY_WINDOW <= t.length; i++) if (n.keyWindows.has(t.slice(i, i + KEY_WINDOW))) return true;
  for (let i = 0; i + ENCODED_WINDOW <= t.length; i++) if (n.encWindows.has(t.slice(i, i + ENCODED_WINDOW))) return true;
  return false;
}

// Every string in the body — keys and values — checked for the key in any of
// the forms above. A key shorter than MIN_KEY_LENGTH is refused before any
// request (client.js), and is treated here as carried: the check cannot work
// on it, so it fails closed.
function carriesKey(body, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return false;
  if (key.length < MIN_KEY_LENGTH) return true;
  const n = keyNeedles(key);
  const seen = new Set();
  const stack = [body];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (stringCarries(v, n)) return true;
    } else if (v && typeof v === 'object') {
      if (seen.has(v)) continue;
      seen.add(v);
      for (const [k, x] of Object.entries(v)) {
        if (stringCarries(k, n)) return true;
        stack.push(x);
      }
    }
  }
  return false;
}

async function buildPreview(org, deps) {
  const env = deps.env || process.env;
  const apiKey = env.CLICKR_API_KEY ? String(env.CLICKR_API_KEY).trim() : '';
  const started = (deps.now || Date.now)();

  let p86;
  let p86Error = null;
  try {
    p86 = await readP86(deps.pool, org.id);
  } catch (e) {
    p86 = { jobs: [], leads: [], clients: [], coRows: [], poRows: [], subs: [], coTotals: new Map(), directory: { users: [], clients: [] }, unscopedJobs: 0, unscopedLeads: 0 };
    p86Error = 'Could not read Project 86\'s own jobs and leads, so nothing was classified.';
  }

  const common = { apiKey, transport: deps.transport, limits: deps.limits, now: deps.now, baseUrl: deps.baseUrl };
  const settled = await Promise.allSettled(PREVIEW_KINDS.map((k) =>
    fetchDataset(Object.assign({ datasetId: DATASETS[k].datasetId, label: DATASETS[k].label, idKey: DATASETS[k].idKey }, common))));
  const datasets = {};
  PREVIEW_KINDS.forEach((k, i) => {
    const s = settled[i];
    const fr = s.status === 'fulfilled' ? s.value : {
      records: [], fetched: 0, pages: 0, reportedCount: null, mode: null, complete: false, reason: null, elapsedMs: 0,
      error: { kind: 'internal', message: 'The ' + DATASETS[k].label + ' read failed inside this server before Clickr answered.' },
    };
    datasets[k] = buildDataset(k, fr, p86, p86Error);
    if (fr && !fr.error && fr.complete === true) rememberFetch(org.id, k, fr, (deps.now || Date.now)());
  });

  const body = {
    readOnly: true,
    readOnlyNote: 'Preview only. Nothing is written to Project 86 or to Buildertrend.',
    direction: 'Buildertrend is the source of truth: every difference is shown as the correction Project 86 would receive. A blank in Buildertrend never overwrites a Project 86 value; money and job numbers are never auto-corrected; ambiguous matches propose nothing; nothing is proposed for deletion.',
    generatedAt: new Date().toISOString(),
    organization: { id: org.id, slug: org.slug, name: org.name },
    keyConfigured: !!apiKey,
    p86: { jobs: p86.jobs.length, leads: p86.leads.length, clients: (p86.clients || []).length, unscopedJobs: p86.unscopedJobs, unscopedLeads: p86.unscopedLeads, error: p86Error },
    datasets,
    elapsedMs: (deps.now || Date.now)() - started,
  };
  if (carriesKey(body, apiKey)) {
    throw Object.assign(new Error('withheld'), { keyLeak: true });
  }
  return body;
}

// Called from GET /api/admin/organizations/me AFTER requireAuth, requireOrg and
// requireCapability('ROLES_MANAGE') have all passed.
async function handle(req, res, deps) {
  const env = (deps && deps.env) || process.env;
  const org = req.organization;
  if (!org || org.id == null) {
    return res.status(403).json({ error: 'Buildertrend sync preview needs an organization.' });
  }
  if (String(org.slug || '') !== ownerSlug(env)) {
    return res.status(403).json({
      error: 'Buildertrend sync preview is not available for this organization. The Buildertrend connection on this server belongs to a different company.',
      code: 'CLICKR_NOT_THIS_ORG',
    });
  }
  // ONE build at a time on this server process. A build reads every Clickr page
  // and compares every record; a second admin (or a second tab) pressing Refresh
  // meanwhile gets a sentence instead of a second build.
  if (inFlight) {
    return res.status(429).json({ error: 'A Buildertrend preview is already being built on this server. Try Refresh again in a moment.', code: 'CLICKR_PREVIEW_BUSY' });
  }
  inFlight = true;
  try {
    const body = await buildPreview(org, Object.assign({ env }, deps));
    // 200 even when Clickr failed: the failure is a per-dataset sentence. A
    // Clickr 401 must never surface as OUR 401 — the client logs the admin out.
    res.set('Cache-Control', 'no-store');
    return res.json(body);
  } catch (e) {
    // Fixed sentences only: an exception message could carry anything.
    const leak = !!(e && e.keyLeak);
    console.error('[clickr-preview] ' + (leak ? 'response withheld: it contained the Clickr API key' : 'preview failed'));
    return res.status(500).json({ error: leak
      ? 'The Buildertrend preview was withheld because the response contained the Clickr API key.'
      : 'The Buildertrend preview failed inside this server.' });
  } finally {
    inFlight = false;
  }
}

// The last COMPLETE Clickr read per organization and dataset, kept briefly so
// Apply (sync-apply.js) right after a preview load does not re-read every
// page. Records only — never P86 data, never the key. Apply always re-reads
// P86 and re-runs the matcher; it drops this cache after any write.
const FETCH_TTL_MS = 5 * 60 * 1000;
const _fetches = new Map();
function rememberFetch(orgId, kind, fr, at) {
  _fetches.set(String(orgId) + ':' + kind, { at, fr });
}
function cachedFetch(orgId, kind, maxAgeMs, now) {
  const hit = _fetches.get(String(orgId) + ':' + kind);
  if (!hit) return null;
  const age = (now || Date.now)() - hit.at;
  return age >= 0 && age <= (maxAgeMs == null ? FETCH_TTL_MS : maxAgeMs) ? hit.fr : null;
}
function forgetFetch(orgId) {
  for (const k of [..._fetches.keys()]) if (k.startsWith(String(orgId) + ':')) _fetches.delete(k);
}

let inFlight = false;

module.exports = { handle, buildPreview, rememberFetch, cachedFetch, forgetFetch, readP86, matchRows, changeOrderTotals, ownerSlug, fetchedSentence, carriesKey, VIEW_PARAM };
