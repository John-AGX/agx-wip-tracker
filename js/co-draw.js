'use strict';

/**
 * js/co-draw.js — where a change order's COST comes from.
 *
 * DUAL-TARGET, and in js/ for the reason js/pricing-pipeline.js is: the browser
 * gets window.p86CoDraw from a script tag and the server gets the very same
 * object through require(). A change order's cost source is shown on screen, is
 * validated by the API, and is quoted by 86 and by Live Rooms. There is no
 * version of "which PO carries this cost" that should be computed twice.
 *
 * John's rule, in his words: "the change order should have cost associated with
 * it, it would either draw from its own scope and PO or which ever PO is
 * attached to the scope or sub." One rule, two sources for the PO.
 *
 * ══ THE THING THAT MAKES THIS SAFE ═════════════════════════════════════════
 *
 * A draw is ATTRIBUTION, NOT ACCRUAL. It records WHICH purchase order carries
 * a change order's cost. It does not add a dollar to any total, and
 * computeJobWIP is byte-identical with and without draws present — there is a
 * test that asserts exactly that, because it is the whole safety argument.
 *
 * That is not a compromise; it is the correct answer, and working it out is
 * what killed the original design's formula. The design proposed
 *
 *     base   = poTotal - SUM(draws on this PO)
 *     earned = base * jobPct + SUM(draw.amount * thatCO'sPct)
 *
 * Work it through for the recommended configuration — an "extend the PO"
 * addendum, weighted at the job's percent — and every term cancels:
 *
 *     (poTotal - D) * J + D * J  ===  poTotal * J
 *
 * The addendum ALREADY moved the money. It raised the PO's committed total by
 * exactly the delta, and poAccruedOf already accrues the whole total at the
 * job's percent net of billings. Subtracting the draw out of the base and
 * adding it back is arithmetic theatre. Worse, it is UNSOUND in the window
 * where it differs: an addendum sits `pending` between the line edit and the
 * sub's signature, so a draw recorded at bind time discounts a live PO's own
 * committed cost by the draw amount for the entire pending window, against a
 * PO that is still worth its old total. Reviewer 1 found that; it is real.
 *
 * So: the addendum mechanism IS the money model. This file records which CO
 * consumed which commitment, enforces that a draw can never claim capacity
 * that does not exist, and makes the case with NO purchase order behind it
 * loud instead of silent. Nothing here is summed into cost.
 *
 * ══ THE FOUR WAYS A DOLLAR GETS COUNTED TWICE, AND WHY NONE OF THEM FIRE ═══
 *
 *  (i)   co.costs enters accrual as well as budget. It cannot: co.costs has
 *        exactly one consumer in the money layer — revisedEstCosts
 *        (job-wip.js) — and nothing in this file writes or reads it into a
 *        cost total. Budget and projection are parallel VIEWS; each holds the
 *        dollar once.
 *  (ii)  A second CO-cost channel adds it again. There is none, and this file
 *        deliberately does not create one.
 *  (iii) The cost falls back to the sub contract and evaporates. subAccruedOf
 *        SKIPS any sub that has a live PO on the job, so a cost routed to a
 *        sub contract instead of a PO lands in neither. Hence `unfunded` is a
 *        named, visible state rather than a silent fallback.
 *  (iv)  A `within` draw claims more capacity than the PO holds. Validated:
 *        the sum of `within` draws against one PO cannot exceed its total.
 *
 * ══ WHAT IS DELIBERATELY NOT HERE ══════════════════════════════════════════
 *
 * The fuzzy PO->scope match in js/jobs.js getJobPOAccrued (PO title + line
 * text searched for a scope name) never decides a draw. It stays a display
 * chip. A stored poId is the record; a guess is not.
 */

const EPS = 0.005;

const DRAW_MODES = new Set(['addendum', 'within']);
// '' is UNCLASSIFIED and is the default for every change order that exists
// today. It is not a synonym for 'self' and not a synonym for 'unfunded' —
// it means nobody has answered the question yet, which is why deploying this
// moves nothing.
const COST_SOURCES = new Set(['', 'po', 'self', 'unfunded']);
const LIVE_PO_STATUSES = (s) => s !== 'draft' && s !== 'cancelled' && s !== 'void';
// A change order's money only joins the contract once approved or applied —
// the same set change-order-totals.js counts. A VOIDED (or still-draft) CO
// contributes no cost, so its draw is inert. See coIsCounted.
const COUNTED_CO_STATUSES = new Set(['approved', 'applied']);

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function r2(v) { return Math.round(num(v) * 100) / 100; }

// A CO row arrives in two shapes — a table row ({status, data}) and the
// client's flattened mirror (shapeRow spreads data to the top level). Read
// both, data first, so a stale top-level copy never wins over the record.
function coField(co, key) {
  if (!co) return undefined;
  if (co.data && typeof co.data === 'object' && co.data[key] !== undefined) return co.data[key];
  return co[key];
}

function coCostSource(co) {
  const v = coField(co, 'costSource');
  return COST_SOURCES.has(v) ? v : '';
}

function coSubId(co) {
  const v = coField(co, 'subId');
  return v ? String(v) : null;
}

function coCompletionMode(co) {
  const v = coField(co, 'completionMode');
  return (v === 'rider' || v === 'standalone') ? v : '';
}

function coRiderScopeName(co) {
  return String(coField(co, 'riderScopeName') || '');
}

function coIsCounted(co) {
  return COUNTED_CO_STATUSES.has(co && co.status);
}

/**
 * The draws stored on a CO, sanitized. Rows without a poId or without a
 * positive amount are dropped; an unknown mode falls back to 'addendum',
 * which is the mode that requires the most proof before it counts as active.
 */
function normalizeDraws(co) {
  const raw = coField(co, 'costDraws');
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const d of raw) {
    if (!d || !d.poId) continue;
    const amount = r2(d.amount);
    if (!(amount > 0)) continue;
    out.push({
      poId: String(d.poId),
      poNumber: d.poNumber ? String(d.poNumber) : '',
      amount,
      mode: DRAW_MODES.has(d.mode) ? d.mode : 'addendum',
      addendumId: d.addendumId ? String(d.addendumId) : null,
    });
  }
  return out;
}

// ── PO money, the two totals this repo carries ─────────────────────────────
//
// They are NOT the same number and reconciling them is a separate, measured
// change (it moves accrued cost on jobs with no change order at all). Both are
// exposed so a caller can SAY they disagree rather than pick one silently.

/** Σ raw line items — what server poAccruedOf accrues from. */
function poOrderedTotal(poData) {
  return (Array.isArray(poData && poData.lines) ? poData.lines : []).reduce((s, l) => {
    if (!l || l.section === '__section_header__') return s;
    return s + num(l.qty) * num(l.unitCost);
  }, 0);
}

/** Frozen baseline + APPROVED addendum deltas — what the PO list commits. */
function poCommittedTotal(poData) {
  const d = poData || {};
  if (d.baselineTotal == null) return poOrderedTotal(d);
  const approved = (Array.isArray(d.addendums) ? d.addendums : [])
    .reduce((s, a) => s + (a && a.status === 'approved' ? num(a.delta) : 0), 0);
  return num(d.baselineTotal) + approved;
}

/**
 * The gap between them. Non-zero means a PO is mid-revision or carries a
 * PENDING addendum: the server is already accruing the new line total while
 * the PO list still shows the old committed one. Pre-existing and org-wide;
 * surfaced here so a CO bound to such a PO can say so instead of implying the
 * two agree.
 */
function poTotalDisagreement(poData) {
  const ordered = r2(poOrderedTotal(poData));
  const committed = r2(poCommittedTotal(poData));
  return { ordered, committed, delta: r2(ordered - committed) };
}

function findAddendum(poData, addendumId) {
  const list = Array.isArray(poData && poData.addendums) ? poData.addendums : [];
  return list.find((a) => a && a.id === addendumId) || null;
}

/**
 * What one draw actually is, against the PO it names.
 *
 *   'active'      the commitment exists and carries this cost
 *   'pending'     an `addendum` draw whose addendum is not approved yet — the
 *                 sub has not signed, so the cost is proposed, not committed
 *   'orphan'      the named PO or addendum is gone, or the addendum's delta no
 *                 longer equals the draw. NEVER treated as active: reviewer 1's
 *                 Break 1 is that an unrelated line edit in the same unlock
 *                 makes delta != amount, and a draw that trusts the mode alone
 *                 mis-states the PO by the difference.
 *   'dead-po'     the PO is draft / cancelled / void — no commitment at all
 *   'missing-po'  the PO is not on this job
 */
function drawState(draw, po) {
  if (!po) return 'missing-po';
  if (!LIVE_PO_STATUSES(po.status)) return 'dead-po';
  if (draw.mode === 'within') return 'active';
  // addendum mode: hard-bound to ONE addendum of EQUAL delta.
  if (!draw.addendumId) return 'orphan';
  const add = findAddendum(po.data || po, draw.addendumId);
  if (!add) return 'orphan';
  if (Math.abs(num(add.delta) - draw.amount) > EPS) return 'orphan';
  return add.status === 'approved' ? 'active' : 'pending';
}

/**
 * Resolve WHICH purchase order a change order's cost draws against.
 *
 * Four steps, no fuzzy matching anywhere in them:
 *
 *  1. An explicit draw WINS, in both modes, always. Once bound it never
 *     re-resolves — a stored poId is the record, not a hint.
 *  2. Rides a scope, unbound: candidates are live POs on the job whose
 *     data.phaseName equals the CO's riderScopeName. Exactly one -> PROPOSE it
 *     (one click to bind). Zero or many -> unresolved.
 *  3. Its own scope: never auto-resolves. Own scope means own PO.
 *  4. Never fall through to matching PO title/line text against a scope name.
 *
 * `pos` is [{ id, status, sub_id, po_number, data }].
 */
function resolvePoForCo(co, pos) {
  const list = Array.isArray(pos) ? pos : [];
  const byId = new Map(list.map((p) => [String(p.id), p]));
  const draws = normalizeDraws(co);
  const source = coCostSource(co);

  if (source === 'self') return { state: 'self', poId: null, candidates: [] };

  if (draws.length) {
    return {
      state: 'bound',
      poId: draws[0].poId,
      candidates: draws.map((d) => byId.get(d.poId) || null).filter(Boolean),
      draws,
    };
  }

  const live = list.filter((p) => LIVE_PO_STATUSES(p.status));
  const mode = coCompletionMode(co);

  if (mode === 'rider') {
    const scope = coRiderScopeName(co).trim();
    if (!scope) return { state: 'unresolved', poId: null, candidates: [], reason: 'no-scope' };
    const hits = live.filter((p) => String((p.data || {}).phaseName || '').trim() === scope);
    if (hits.length === 1) return { state: 'proposed', poId: String(hits[0].id), candidates: hits };
    if (hits.length > 1) return { state: 'ambiguous', poId: null, candidates: hits, reason: 'many-pos' };
    return { state: 'unresolved', poId: null, candidates: [], reason: 'no-po-on-scope' };
  }

  // Its own scope (or unset): the PO is picked, never guessed.
  return { state: 'unresolved', poId: null, candidates: live, reason: 'own-scope' };
}

/**
 * Is this CO's cost carried by a commitment, and how much of it is not?
 *
 * `cost` is the CO's own raw line subtotal — the caller passes it in rather
 * than this file re-deriving it, so there is exactly one pricing pipeline in
 * the repo and this is not a second opinion on what a CO costs.
 */
function coCostCoverage(co, pos, cost) {
  const total = r2(cost);
  const source = coCostSource(co);
  const draws = normalizeDraws(co);
  const byId = new Map((Array.isArray(pos) ? pos : []).map((p) => [String(p.id), p]));

  let active = 0, pending = 0, broken = 0;
  const detail = draws.map((d) => {
    const po = byId.get(d.poId) || null;
    const state = drawState(d, po);
    if (state === 'active') active += d.amount;
    else if (state === 'pending') pending += d.amount;
    else broken += d.amount;
    return {
      poId: d.poId,
      poNumber: d.poNumber || (po ? po.po_number : '') || '',
      amount: d.amount,
      mode: d.mode,
      addendumId: d.addendumId,
      state,
      subId: po ? (po.sub_id || null) : null,
      // Non-zero means the server is accruing a different total than the PO
      // list shows for this PO. Pre-existing; reported, never silently picked.
      totals: po ? poTotalDisagreement(po.data || po) : null,
    };
  });

  const uncovered = r2(Math.max(0, total - active));
  // 'self' is a real answer: the crew does the work, cost arrives as labor and
  // materials through QuickBooks, and there is nothing to commit. It is only a
  // legitimate answer when it was CHOSEN — which is why '' is a separate state.
  let state;
  if (total <= EPS) state = 'no-cost';
  else if (source === 'self') state = 'self';
  else if (source === '') state = 'unclassified';
  else if (source === 'unfunded') state = 'unfunded';
  else if (broken > EPS) state = 'broken';
  else if (uncovered > EPS) state = pending > EPS ? 'partly-pending' : 'partly-covered';
  else state = 'covered';

  return {
    cost: total,
    source,
    subId: coSubId(co),
    drawn: r2(active + pending + broken),
    active: r2(active),
    pending: r2(pending),
    broken: r2(broken),
    uncovered,
    state,
    counted: coIsCounted(co),
    draws: detail,
  };
}

/**
 * Job-level roll-up: how much change-order cost has NO commitment behind it.
 *
 * This is a NEW figure that sits BESIDE committed cost. It changes no existing
 * total. Only COUNTED change orders (approved / applied) contribute — a voided
 * CO's cost left the contract, so its draw is inert and its shortfall is not a
 * shortfall. Note the deliberate asymmetry that follows from that: voiding a
 * CO drops the draw, and it does NOT reverse an addendum the sub already
 * signed. The sub is still owed that money and the PO is still worth it.
 *
 * `costOf(co)` returns the CO's raw line subtotal.
 */
function jobCoCostCoverage(cos, pos, costOf) {
  let uncovered = 0, unclassified = 0, pending = 0, broken = 0, covered = 0, selfPerformed = 0;
  const rows = [];
  for (const co of (Array.isArray(cos) ? cos : [])) {
    if (!coIsCounted(co)) continue;
    const cov = coCostCoverage(co, pos, costOf ? costOf(co) : 0);
    if (cov.state === 'no-cost') continue;
    rows.push(cov);
    covered += cov.active;
    pending += cov.pending;
    broken += cov.broken;
    if (cov.state === 'self') selfPerformed += cov.cost;
    else if (cov.state === 'unclassified') unclassified += cov.uncovered;
    else uncovered += cov.uncovered;
  }
  return {
    covered: r2(covered),
    pending: r2(pending),
    broken: r2(broken),
    // Cost someone will be paid for with no purchase order behind it. LOUD.
    uncovered: r2(uncovered),
    // Nobody has answered the question yet. Every CO that exists today is here,
    // and that is what makes this ship move zero dollars.
    unclassified: r2(unclassified),
    selfPerformed: r2(selfPerformed),
    rows,
  };
}

/**
 * Server-side validation for a cost-source write. Returns [] when the payload
 * is legal, else a list of plain-English reasons. Every invariant that keeps a
 * draw from claiming capacity that does not exist lives here.
 */
function validateCostSource(payload, ctx) {
  const errs = [];
  const source = (payload && payload.costSource) || '';
  if (!COST_SOURCES.has(source)) {
    errs.push(`costSource must be one of "", "po", "self", "unfunded" — got "${source}".`);
    return errs;
  }

  const draws = normalizeDraws({ data: { costDraws: (payload && payload.costDraws) || [] } });
  if (source !== 'po' && draws.length) {
    errs.push('Cost draws can only be recorded when the cost source is a purchase order.');
  }

  const pos = Array.isArray(ctx && ctx.pos) ? ctx.pos : [];
  const byId = new Map(pos.map((p) => [String(p.id), p]));
  const withinByPo = new Map();

  for (const d of draws) {
    const po = byId.get(d.poId);
    if (!po) { errs.push(`Purchase order ${d.poNumber || d.poId} is not on this job.`); continue; }
    if (!LIVE_PO_STATUSES(po.status)) {
      errs.push(`${po.po_number || d.poId} is ${po.status} — a change order cannot draw against it.`);
      continue;
    }
    if (d.mode === 'addendum') {
      // Hard-bound, and the equality is the point: without it any unrelated
      // edit inside the same unlock silently detaches the draw from the money.
      if (!d.addendumId) {
        errs.push(`${po.po_number || d.poId}: an "extend the PO" draw must name the addendum that carries it.`);
        continue;
      }
      const add = findAddendum(po.data || po, d.addendumId);
      if (!add) { errs.push(`${po.po_number || d.poId}: addendum ${d.addendumId} no longer exists.`); continue; }
      if (Math.abs(num(add.delta) - d.amount) > EPS) {
        errs.push(`${po.po_number || d.poId}: addendum ${add.seq || d.addendumId} is ${r2(add.delta)}, but the draw is ${d.amount}. They must match.`);
      }
    } else {
      withinByPo.set(d.poId, r2((withinByPo.get(d.poId) || 0) + d.amount));
    }
  }

  for (const [poId, sum] of withinByPo) {
    const po = byId.get(poId);
    if (!po) continue;
    const cap = r2(poCommittedTotal(po.data || po));
    if (sum > cap + EPS) {
      errs.push(`${po.po_number || poId}: draws within this PO total ${sum}, above its committed ${cap}.`);
    }
  }

  const cost = r2(ctx && ctx.coCost);
  const drawn = r2(draws.reduce((s, d) => s + d.amount, 0));
  if (drawn > cost + EPS) {
    errs.push(`Draws total ${drawn}, above this change order's cost of ${cost}.`);
  }

  // A sub on the CO is IDENTITY (who performs the work); the PO is MONEY. They
  // are separate fields on purpose, but they may not contradict each other.
  const subId = (payload && payload.subId) ? String(payload.subId) : null;
  if (subId) {
    for (const d of draws) {
      const po = byId.get(d.poId);
      if (po && po.sub_id && String(po.sub_id) !== subId) {
        errs.push(`${po.po_number || d.poId} is issued to a different subcontractor than this change order names.`);
      }
    }
  }

  return errs;
}

const api = {
  EPS,
  DRAW_MODES,
  COST_SOURCES,
  COUNTED_CO_STATUSES,
  coCostSource,
  coSubId,
  coCompletionMode,
  coRiderScopeName,
  coIsCounted,
  normalizeDraws,
  poOrderedTotal,
  poCommittedTotal,
  poTotalDisagreement,
  drawState,
  resolvePoForCo,
  coCostCoverage,
  jobCoCostCoverage,
  validateCostSource,
};

// Dual-target, same as js/pricing-pipeline.js. No DOM dependency anywhere in
// this file, so the API's validation and the CO screen's badge are the same
// lines of code — there is no second opinion on whether a cost is committed.
if (typeof window !== 'undefined') window.p86CoDraw = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
