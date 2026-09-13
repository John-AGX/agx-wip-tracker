'use strict';

/**
 * deal-memory.js — the deal-thread's durable "core memory" (session/memory
 * architecture, slice 2). One row per lead→estimate→job LINEAGE, keyed on the
 * lineage ROOT. See docs/session-memory-architecture.md.
 *
 * resolveLineageRoot(db, entityType, entityId, scopeOrgId)
 *   Walk the lead→estimate→job chain from ANY deal surface to its root (the
 *   lead when one exists anywhere in the chain, else the estimate, else the
 *   job). Returns { lineage_root, root_type, organization_id, stage, leadId,
 *   estimateId, jobId } or null for a non-deal / missing entity — and null for
 *   an entity outside scopeOrgId, and null when scopeOrgId is missing.
 *
 * refreshDealNumbers(db, entityType, entityId, scopeOrgId)
 *   Recompute the DETERMINISTIC numbers sub-block from the money layer and
 *   upsert it. The model READS this block; it must NEVER write it — LLM prose
 *   does not own a money number.
 *
 * Numbers by stage (the furthest-along stage that exists drives them):
 *   lead     — estimated revenue + confidence + status (off the lead row)
 *   estimate — proposal total, parity with the editor (money/estimate-totals)
 *   job      — contract + %complete NOW (straight off the job row). The FULL
 *              WIP (CO income, actual costs, margin) lands in slice 2b via a
 *              shared loadJobWip extraction from buildJobContext, so the deal
 *              number can never drift from the WIP 86 sees. Contract +
 *              %complete are single-row reads, so they're safe to write today.
 *
 * Every function takes an explicit `db`. INTEGRATION CONTRACT: a refresh must
 * NOT run on a caller's open transaction client — refreshDealNumbers issues
 * several queries, and if any throws it poisons that transaction (Postgres
 * aborts it; a subsequent COMMIT silently rolls back → SILENT money-write loss,
 * worse than a visible error). Run it on a SEPARATE pool connection AFTER the
 * caller's COMMIT (the established best-effort pattern — see the post-commit
 * geocode in job-routes.js), or inside its own SAVEPOINT. Swallowing the throw
 * alone is NOT enough. Callers still swallow the throw so a failed refresh
 * never surfaces as an error on the real write.
 *
 * ── THE TENANT IS AN ARGUMENT, AND IT IS REQUIRED ──────────────────────────
 * Every read in this file used to be by bare id. The entity id arrives from
 * the chat request's current_context, so a user in org A who named org B's
 * job was handed org B's contract, % complete and deal notes in <deal_memory>
 * — and the refresh upserted org B's deal_memory row on the way. Worse, the
 * walk FOLLOWS ids stored on rows (jobs.lead_id / jobs.estimate_id /
 * leads.job_id / estimates.data->>'lead_id'), and those are ordinary values a
 * tenant's own users write, so an in-org entity could point the walk into
 * another tenant even when the named entity was fine.
 *
 * So `scopeOrgId` is the caller's organization (never the row's), every row
 * read carries `(organization_id = $n OR organization_id IS NULL)` — the same
 * legacy tolerance arm the rest of the tenancy model uses — and a missing
 * scopeOrgId resolves NOTHING rather than everything. An id-only reference to
 * a row that belongs to ANOTHER org is dropped as if it did not exist. A
 * reference to a row that does not exist at all is left exactly as it was
 * before this change, so an in-org lineage resolves byte-identically.
 */

const { computeEstimateTotals } = require('./money/estimate-totals');

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function round2(n) { return Math.round(num(n) * 100) / 100; }

// The one tenant arm. Always parameter $2 in the statements below.
const IN_ORG = '(organization_id = $2 OR organization_id IS NULL)';

// An id-only reference (jobs.estimate_id, leads.job_id) proven to name a row
// in ANOTHER tenant. True only on that proof: a missing row is not foreign,
// which keeps a same-org dangling reference resolving as it always did.
async function isForeign(db, table, id, scopeOrgId) {
  if (!id) return false;
  const r = await db.query(
    'SELECT 1 AS x FROM ' + table + ' WHERE id = $1 AND organization_id IS NOT NULL AND organization_id <> $2 LIMIT 1',
    [id, scopeOrgId]
  );
  return r.rows.length > 0;
}

async function resolveLineageRoot(db, entityType, entityId, scopeOrgId) {
  if (!entityType || !entityId) return null;
  // FAIL CLOSED: no tenant, no lineage. Never an unpredicated walk.
  if (scopeOrgId == null) return null;
  let leadId = null, estimateId = null, jobId = null, orgId = null;

  if (entityType === 'job') {
    const r = await db.query('SELECT id, organization_id, lead_id, estimate_id FROM jobs WHERE id = $1 AND ' + IN_ORG, [entityId, scopeOrgId]);
    if (!r.rows.length) return null;
    jobId = r.rows[0].id;
    orgId = r.rows[0].organization_id;
    leadId = r.rows[0].lead_id || null;
    estimateId = r.rows[0].estimate_id || null;
    if (await isForeign(db, 'estimates', estimateId, scopeOrgId)) estimateId = null;
  } else if (entityType === 'estimate') {
    const r = await db.query("SELECT id, organization_id, data->>'lead_id' AS lead_id FROM estimates WHERE id = $1 AND " + IN_ORG, [entityId, scopeOrgId]);
    if (!r.rows.length) return null;
    estimateId = r.rows[0].id;
    orgId = r.rows[0].organization_id;
    leadId = r.rows[0].lead_id || null;
  } else if (entityType === 'lead') {
    const r = await db.query('SELECT id, organization_id, job_id FROM leads WHERE id = $1 AND ' + IN_ORG, [entityId, scopeOrgId]);
    if (!r.rows.length) return null;
    leadId = r.rows[0].id;
    orgId = r.rows[0].organization_id;
    jobId = r.rows[0].job_id || null;
    if (await isForeign(db, 'jobs', jobId, scopeOrgId)) jobId = null;
  } else {
    return null; // not a deal surface
  }

  // Transitive lead recovery — the ONE-ROW-PER-DEAL invariant depends on it.
  // A convert-by-estimate job carries estimate_id but a NULL lead_id, while its
  // estimate blob DOES carry data.lead_id. Without recovering the lead here, the
  // job surface would root on the estimate while the lead/estimate surfaces root
  // on the lead → two deal_memory rows for one deal. Mirrors the cross-fill the
  // link-estimate route already does (job-routes.js).
  if (!leadId && estimateId) {
    const el = await db.query("SELECT data->>'lead_id' AS lead_id FROM estimates WHERE id = $1 AND " + IN_ORG, [estimateId, scopeOrgId]);
    if (el.rows.length && el.rows[0].lead_id) leadId = el.rows[0].lead_id;
  }

  // Phantom-lead guard — data->>'lead_id' is a raw string that can outlive a
  // deleted lead. Verify it exists before trusting it as the root (else fall
  // back to estimate/job root). Also backfills org from the lead when missing.
  // Scoped: another tenant's lead is, for this caller, a lead that does not
  // exist — which is exactly how the guard already treats a deleted one.
  if (leadId) {
    const lv = await db.query('SELECT id, organization_id FROM leads WHERE id = $1 AND ' + IN_ORG, [leadId, scopeOrgId]);
    if (!lv.rows.length) leadId = null;
    else if (orgId == null) orgId = lv.rows[0].organization_id;
  }

  // With a real lead, resolve the rest of the chain CANONICALLY — independent of
  // which surface triggered the refresh — so the same deal always resolves the
  // same job + estimate. Fixes the multi-estimate oscillation where the stored
  // proposalTotal flipped based on the triggering estimate.
  if (leadId) {
    if (!jobId) {
      const j = await db.query('SELECT id FROM jobs WHERE lead_id = $1 AND ' + IN_ORG + ' LIMIT 1', [leadId, scopeOrgId]);
      if (j.rows.length) jobId = j.rows[0].id;
    }
    let canonicalEst = null;
    if (jobId) {
      const je = await db.query('SELECT estimate_id FROM jobs WHERE id = $1 AND ' + IN_ORG, [jobId, scopeOrgId]);
      if (je.rows.length && je.rows[0].estimate_id) canonicalEst = je.rows[0].estimate_id;
      if (await isForeign(db, 'estimates', canonicalEst, scopeOrgId)) canonicalEst = null;
    }
    if (!canonicalEst) {
      const e = await db.query(
        "SELECT id FROM estimates WHERE data->>'lead_id' = $1 AND " + IN_ORG + " ORDER BY updated_at DESC NULLS LAST LIMIT 1",
        [leadId, scopeOrgId]
      );
      if (e.rows.length) canonicalEst = e.rows[0].id;
    }
    estimateId = canonicalEst || estimateId;
  }

  const lineage_root = leadId || estimateId || jobId;
  if (!lineage_root) return null;
  const root_type = leadId ? 'lead' : (estimateId ? 'estimate' : 'job');
  const stage = jobId ? 'job' : (estimateId ? 'estimate' : 'lead');
  return { lineage_root, root_type, organization_id: orgId, stage, leadId, estimateId, jobId };
}

// `scopeOrgId` is required for the same reason as above; without it there are
// no numbers, only the stage.
async function computeNumbers(db, resolved, scopeOrgId) {
  const out = { stage: resolved.stage };
  if (scopeOrgId == null) return out;
  if (resolved.stage === 'job' && resolved.jobId) {
    const r = await db.query('SELECT data FROM jobs WHERE id = $1 AND ' + IN_ORG, [resolved.jobId, scopeOrgId]);
    const j = r.rows.length ? (r.rows[0].data || {}) : {};
    out.jobId = resolved.jobId;
    out.contract = round2(j.contractAmount);
    out.pctComplete = num(j.pctComplete);
    // CO income — a cheap sum of the job's change orders (table + legacy blob
    // fallback), so the deal shows the CO-adjusted total. Full WIP (actual
    // costs, margin) still pulls via read tools. Best-effort.
    try {
      const cot = require('./money/change-order-totals');
      const cos = await cot.changeOrdersForJob(db, resolved.jobId, j.changeOrders);
      const coIncome = (cos || []).reduce(function (s, c) { return s + num(c.income); }, 0);
      if (coIncome) {
        out.coIncome = round2(coIncome);
        out.totalContract = round2(out.contract + coIncome);
      }
    } catch (_) { /* CO enrichment is best-effort */ }
    out.wipPending = true; // actual costs + margin still deferred (read tools)
  } else if (resolved.stage === 'estimate' && resolved.estimateId) {
    const r = await db.query('SELECT data FROM estimates WHERE id = $1 AND ' + IN_ORG, [resolved.estimateId, scopeOrgId]);
    const blob = r.rows.length ? (r.rows[0].data || {}) : {};
    const t = computeEstimateTotals(blob);
    out.estimateId = resolved.estimateId;
    out.proposalTotal = num(t.proposalTotal);
    out.baseCost = num(t.baseCost);
    out.blendedMarkupPct = Math.round(num(t.blendedMarkup) * 10) / 10;
  } else if (resolved.stage === 'lead' && resolved.leadId) {
    const r = await db.query(
      'SELECT estimated_revenue_low, estimated_revenue_high, confidence, status FROM leads WHERE id = $1 AND ' + IN_ORG,
      [resolved.leadId, scopeOrgId]
    );
    const l = r.rows.length ? r.rows[0] : {};
    out.leadId = resolved.leadId;
    out.estRevenueLow = num(l.estimated_revenue_low);
    out.estRevenueHigh = num(l.estimated_revenue_high);
    out.confidence = num(l.confidence);
    out.status = l.status || null;
  }
  return out;
}

async function refreshDealNumbers(db, entityType, entityId, scopeOrgId) {
  const resolved = await resolveLineageRoot(db, entityType, entityId, scopeOrgId);
  if (!resolved) return null;
  const numbers = await computeNumbers(db, resolved, scopeOrgId);

  // Root-stability cleanup: an estimate refreshed BEFORE its lead link existed
  // would have created an estimate-keyed row. Now that this deal roots on a
  // lead, remove any earlier estimate/job-keyed row for the same lineage so it
  // stays one-row-per-deal (readers always re-resolve, so those rows are dead
  // clutter, but we prune them to keep the table honest).
  if (resolved.root_type === 'lead') {
    const subsumed = [resolved.estimateId, resolved.jobId].filter(function (x) { return x && x !== resolved.lineage_root; });
    if (subsumed.length) {
      await db.query('DELETE FROM deal_memory WHERE lineage_root = ANY($1::text[]) AND ' + IN_ORG, [subsumed, scopeOrgId]);
    }
  }

  // The conflict arm may only touch a row that is this caller's or un-stamped.
  // The key is an in-org id by construction now, so this is belt-and-braces:
  // it is the difference between "cannot happen" and "cannot write".
  await db.query(
    `INSERT INTO deal_memory (lineage_root, root_type, organization_id, numbers, numbers_stage, numbers_at, updated_at)
          VALUES ($1, $2, $3, $4::jsonb, $5, NOW(), NOW())
     ON CONFLICT (lineage_root) DO UPDATE
          SET numbers         = EXCLUDED.numbers,
              numbers_stage   = EXCLUDED.numbers_stage,
              numbers_at      = NOW(),
              root_type       = EXCLUDED.root_type,
              organization_id = COALESCE(deal_memory.organization_id, EXCLUDED.organization_id),
              updated_at      = NOW()
        WHERE deal_memory.organization_id IS NULL OR deal_memory.organization_id = $6`,
    [resolved.lineage_root, resolved.root_type, resolved.organization_id, JSON.stringify(numbers), resolved.stage, scopeOrgId]
  );
  // Read the notes back so the caller can render them in the deal block (slice
  // 4). Notes are written only by the deal_memory payload dispatcher, never here.
  let notes = [];
  try {
    const nr = await db.query('SELECT notes FROM deal_memory WHERE lineage_root = $1 AND ' + IN_ORG, [resolved.lineage_root, scopeOrgId]);
    if (nr.rows.length && Array.isArray(nr.rows[0].notes)) notes = nr.rows[0].notes;
  } catch (_) { /* notes are best-effort in the block */ }
  // Return the full resolved lineage + numbers + notes so a caller can render
  // the deal block without re-resolving.
  return { ...resolved, numbers, notes };
}

function _fmtMoney(n) {
  const v = Number(n) || 0;
  // Cents only when there's a fractional part — a contract of $56,217.45 shows
  // its cents, but a round $150,000 stays clean.
  return Number.isInteger(v)
    ? '$' + v.toLocaleString()
    : '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Compact, injection-ready deal-memory block for a deal thread's turn context
// (slice 2b). The DETERMINISTIC numbers + the lineage arc, so 86 opens a deal
// thread already knowing the deal's money and where it sits lead→estimate→job.
// The model READS these numbers; it must not recompute them. `res` is the object
// refreshDealNumbers returns ({ lineage_root, stage, leadId, estimateId, jobId,
// numbers }). Returns '' when there's nothing to show.
//
// opts.numbersWithheld — a denial string from the caller's capability gate
// (ai-routes.js decides it with aiToolCapabilityDenial, the rule 86's own read
// tools apply to the same figures). When present the stage line carries NO
// figure and says why; the lineage, deal key and prose notes still render,
// because none of them is money. Absent, the block is byte-identical to what
// it always was.
function renderDealBlock(res, opts) {
  if (!res || !res.lineage_root) return '';
  const n = res.numbers || {};
  const withheld = opts && opts.numbersWithheld ? String(opts.numbersWithheld) : '';
  const L = [];
  L.push('<deal_memory>');
  L.push(withheld
    ? '# Deal (figures withheld for this user)'
    : '# Deal (deterministic — read these numbers, do not recompute)');
  const arc = [];
  if (res.leadId) arc.push('lead ' + res.leadId);
  if (res.estimateId) arc.push('estimate ' + res.estimateId);
  if (res.jobId) arc.push('job ' + res.jobId);
  if (arc.length) L.push('- Lineage: ' + arc.join(' → '));
  // The durable deal key — target this as entity_id when recording a deal note
  // (emit_payload_file { entity_type:'deal_memory', entity_id: <this> }).
  L.push('- Deal key: ' + res.lineage_root);
  if (withheld) {
    L.push('- Stage ' + String(n.stage || res.stage || '').toUpperCase() + ' · no figures attached: the user who asked may not see this deal\'s figures, and your read tools will refuse the same data for them. Do NOT state, estimate or infer those figures in your answer.');
    L.push('- ' + withheld);
  } else if (n.stage === 'job') {
    L.push('- Stage JOB · contract ' + _fmtMoney(n.contract)
      + (n.coIncome ? ' · +CO ' + _fmtMoney(n.coIncome) + ' → total ' + _fmtMoney(n.totalContract) : '')
      + ' · ' + (Number(n.pctComplete) || 0) + '% complete'
      + (n.wipPending ? ' · actual costs + margin: pull with read tools if needed' : ''));
  } else if (n.stage === 'estimate') {
    L.push('- Stage ESTIMATE · proposal total ' + _fmtMoney(n.proposalTotal)
      + ' · base cost ' + _fmtMoney(n.baseCost) + ' · blended markup ' + (n.blendedMarkupPct || 0) + '%');
  } else if (n.stage === 'lead') {
    const lo = n.estRevenueLow, hi = n.estRevenueHigh;
    L.push('- Stage LEAD · est. revenue ' + _fmtMoney(lo)
      + (String(lo) !== String(hi) ? ' – ' + _fmtMoney(hi) : '')
      + ' · confidence ' + (n.confidence || 0) + '% · status ' + (n.status || '—'));
  }
  // Durable notes (slice 4) — model-recorded decisions/constraints in prose that
  // persist across the lineage and survive compaction. Superseded ones are hidden.
  const activeNotes = (res.notes || []).filter(function (nt) { return nt && !nt.superseded_by; });
  if (activeNotes.length) {
    L.push('# Deal notes (durable decisions/constraints — prose, no numbers)');
    activeNotes.forEach(function (nt) { L.push('- [' + nt.id + '] ' + nt.text); });
  }
  L.push('# Record a durable deal decision/constraint (survives compaction): emit_payload_file { entity_type:"deal_memory", entity_id:"' + res.lineage_root + '", ops:{ note_adds:[{text:"…"}] } } — PROSE only, no $ or numbers. Supersede a stale one with note_supersedes:[{id}].');
  L.push('</deal_memory>');
  return L.join('\n');
}

// Where does a deal thread's lineage ROOT live, relative to an organization?
//
// ai_sessions has no organization_id: a session's tenant is its user's. Deal
// threads minted before resolveLineageRoot was org-scoped could be keyed on
// ANOTHER tenant's lead / estimate / job, and their history carries that
// tenant's figures. This is the ONE definition of "foreign lineage", shared by
// the boot-time archive (services/deal-thread-archive.js) and the explicit
// load refusals (ai-sessions-routes.js, GET /86/messages), so the thread the
// archive hides and the thread a load refuses can never disagree.
//
// The lookup is by bare id ON PURPOSE and returns only organization ids — its
// whole job is to find a row outside the org. The three id spaces do not
// overlap by construction, so the root is looked up in all three.
//   'missing'  — no lead / estimate / job carries this id (left alone)
//   'unscoped' — the root exists but no org was supplied to compare against
//   'in_org'   — a row with this id is in orgId, or is un-stamped (legacy)
//   'foreign'  — every row with this id is stamped with a DIFFERENT org
// Returns { placement, rootOrgId } (rootOrgId set only for 'foreign').
async function lineageRootPlacement(db, lineageRoot, orgId) {
  if (lineageRoot == null || String(lineageRoot) === '') return { placement: 'missing', rootOrgId: null };
  const m = await lineageRootPlacements(db, [lineageRoot], orgId);
  return m.get(String(lineageRoot));
}

// The batched form — three statements for any number of roots — for a list
// response that has to check every deal row it returns. Same answers.
async function lineageRootPlacements(db, lineageRoots, orgId) {
  const roots = [...new Set((lineageRoots || []).filter(function (x) { return x != null && String(x) !== ''; }).map(String))];
  const found = new Map();
  if (roots.length) {
    for (const table of ['leads', 'estimates', 'jobs']) {
      const r = await db.query('SELECT id, organization_id FROM ' + table + ' WHERE id = ANY($1::text[])', [roots]);
      for (const row of r.rows) {
        const k = String(row.id);
        if (!found.has(k)) found.set(k, []);
        found.get(k).push(row.organization_id);
      }
    }
  }
  const out = new Map();
  for (const root of roots) {
    const orgs = found.get(root) || [];
    if (!orgs.length) out.set(root, { placement: 'missing', rootOrgId: null });
    else if (orgId == null) out.set(root, { placement: 'unscoped', rootOrgId: null });
    else if (orgs.some(function (o) { return o == null || String(o) === String(orgId); })) out.set(root, { placement: 'in_org', rootOrgId: null });
    else out.set(root, { placement: 'foreign', rootOrgId: orgs[0] });
  }
  return out;
}

module.exports = { resolveLineageRoot, computeNumbers, refreshDealNumbers, renderDealBlock, lineageRootPlacement, lineageRootPlacements };
