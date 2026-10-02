// Production planning — the service manager's Thursday checklist.
//
// John, 2026-10-02: "in our schedule area we'll have a production planning,
// and that will be where the service manager can go in and check off progress
// on the open service jobs before my WIP meeting so that we can run our WIP
// numbers Thursday night."
//
// This module requires NOTHING — no pool, no express, no env — for the reason
// services/service-tickets.js states: the rules that decide what a stranger
// holding a link may see and change are the rules most worth unit testing, and
// tests that reach server/routes/* only pass where JWT_SECRET is set.
//
// ── THE THREE DECISIONS THIS FILE ENCODES ──────────────────────────────────
//
// 1. WHICH JOBS ARE ON IT. There are already three competing definitions of an
//    "open" job in this codebase (js/jobs-hub.js isActiveJob, the js/app.js
//    attention tiles, and js/schedule.js DEFAULT_STATUS_SET) and they disagree
//    about blank statuses and about case. This is the Schedule area, so it
//    uses Schedule's answer — the only one that is a positive allow-list and
//    the only one already described as "the jobs PMs schedule production for".
//    A fourth predicate is not invented here.
//
// 2. WHAT THE PERCENT IS. The manager's number is the manager's number. It is
//    NOT the job's percent and must never be written as one on its way in: a
//    job's percent is derived from its scope cells by js/progress-core.js, and
//    the scalar it caches drives PO/sub cost accrual on both sides AND is the
//    single figure an outside owner sees in a money-redacted Live Room. The
//    sheet therefore holds its own number, and `applyPlan` below is the only
//    road from one to the other.
//
// 3. WHAT A LINK HOLDER CAN DO. Three fields — how far along, done, what is
//    left — and nothing else. Projection is BY INCLUSION, the same rule
//    publicTicket()/publicTask()/publicPickup() follow, so a column added to
//    these tables later cannot leak through a share by default.
'use strict';

// ── Ids and tokens ─────────────────────────────────────────────────────────
// Lifted from services/service-tickets.js rather than re-derived: same
// generator, same 256 bits, same sha256-without-salt reasoning (the input
// already carries 256 bits of entropy, so a per-row salt would only defeat a
// precomputation attack that cannot exist against random 256-bit inputs).
const crypto = require('crypto');

const HEX64 = /^[a-f0-9]{64}$/;

function genId(prefix) {
  return String(prefix || 'pc') + '_' + Date.now() + '_' +
    Math.random().toString(36).slice(2, 8);
}
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}
function isWellFormedToken(token) {
  return HEX64.test(String(token || ''));
}

// ── Which jobs belong on a sheet ───────────────────────────────────────────
// Mirrors js/schedule.js DEFAULT_STATUS_SET and JOB_TYPE_FILTERS. Kept as
// frozen literals and exported, because test/job-status-vocabulary.test.js
// polices every list in the repo that offers or reads a job status — there are
// already six across five files and they have drifted once.
const PLANNING_STATUSES = Object.freeze(['New', 'In Progress', 'Backlog', 'Warranty']);

// John's list is all S#### and M#### — the service work. "Work order" is not a
// separate record: it is one of these jobs with WO at the end of its TITLE,
// which is a Buildertrend naming convention with nothing in the schema
// recording it. So WO is DERIVED here, never stored.
const PLANNING_PREFIXES = Object.freeze(['S', 'M']);

// Trailing "WO", optionally followed by a number ("… Leak Repair WO 15").
const WO_SUFFIX = /\bWO\s*\d*\s*$/i;

function statusOf(job) {
  return String((job && (job.status || (job.data && job.data.status))) || '').trim();
}
function numberOf(job) {
  return String((job && (job.jobNumber || (job.data && job.data.jobNumber))) || '')
    .toUpperCase().trim();
}
function titleOf(job) {
  const d = (job && job.data) || job || {};
  return String(job && job.title != null ? job.title : (d.title || d.name || '')).trim();
}

// The leading letter RUN, matched as a unit — the same rule every prefix
// lookup in this repo uses, and the reason R2006 never resolves to RV2006.
function prefixOf(jobNumber) {
  const m = String(jobNumber || '').toUpperCase().trim().match(/^([A-Z]+)\d/);
  return m ? m[1] : '';
}

function isWorkOrder(job) {
  return WO_SUFFIX.test(titleOf(job));
}

// A job is on the sheet when its status is one a PM schedules production for
// AND its number is service work. Both halves are explicit: a status we do not
// recognise is NOT on the sheet, because the alternative — treating an unknown
// status as open — is how a Completed job ends up in front of the service
// manager asking for a percent.
function isPlannable(job, opts) {
  const o = opts || {};
  const statuses = o.statuses && o.statuses.length ? o.statuses : PLANNING_STATUSES;
  const prefixes = o.prefixes && o.prefixes.length ? o.prefixes : PLANNING_PREFIXES;
  const st = statusOf(job);
  if (!st) return false;
  if (!statuses.some((s) => s.toLowerCase() === st.toLowerCase())) return false;
  const p = prefixOf(numberOf(job));
  if (!p) return false;
  return prefixes.some((x) => String(x).toUpperCase() === p);
}

// ── The manager's percent ──────────────────────────────────────────────────
// 0/25/50/75/100 — the control on the sheet. Anything else is snapped to the
// nearest step rather than refused: the number arrives from a segmented
// control, and a sheet that rejects a value a person could not have typed is
// a sheet that loses their answer.
const PCT_STEPS = Object.freeze([0, 25, 50, 75, 100]);

function snapPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const c = Math.max(0, Math.min(100, n));
  let best = PCT_STEPS[0];
  for (const s of PCT_STEPS) {
    if (Math.abs(s - c) < Math.abs(best - c)) best = s;
  }
  return best;
}

const NOTE_CAP = 2000;

function cleanNote(v) {
  if (v == null) return null;
  const s = String(v).replace(/\r\n/g, '\n').trim();
  if (!s) return null;
  return s.slice(0, NOTE_CAP);
}

// The three fields a sheet exists to collect, and the only three any writer —
// signed-in or link — may move. `done` and `pct` are kept consistent here
// rather than in two route handlers: ticking done means 100, and dropping off
// 100 clears done. That rule lived in the reference design's checkbox and is
// the kind of thing that silently diverges once two doors implement it.
function normalizeEntry(patch, current) {
  const cur = Object.assign({ pct: 0, done: false, note: null }, current || {});
  const out = {};
  let pct = cur.pct;
  let done = cur.done;

  if (Object.prototype.hasOwnProperty.call(patch || {}, 'pct')) {
    pct = snapPct(patch.pct);
    done = pct >= 100;
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, 'done')) {
    done = !!patch.done;
    // Ticking done is a shortcut for 100. Un-ticking a job that is at 100
    // drops it back to 75 — the step below — rather than to 0, which would
    // throw away everything the manager had recorded.
    if (done) pct = 100;
    else if (pct >= 100) pct = 75;
  }
  out.pct = snapPct(pct);
  out.done = !!done;
  if (Object.prototype.hasOwnProperty.call(patch || {}, 'note')) {
    out.note = cleanNote(patch.note);
  } else {
    out.note = cur.note == null ? null : cleanNote(cur.note);
  }
  return out;
}

function isEntryKey(k) {
  return k === 'pct' || k === 'done' || k === 'note';
}

// Refuse a patch that tries to move anything else. Returns the allowed subset
// plus the names it rejected, so the door can say which field it ignored
// instead of silently dropping it.
function splitEntryPatch(body) {
  const take = {};
  const refused = [];
  Object.keys(body || {}).forEach((k) => {
    if (isEntryKey(k)) take[k] = body[k];
    else refused.push(k);
  });
  return { patch: take, refused };
}

// ── Applying a row to the job ──────────────────────────────────────────────
//
// John's call, 2026-10-02, over two alternatives: the manager's percent is
// written to the job's SCOPE LINE, so the job's own percent recalculates the
// way it always does and one clock survives. The alternatives were setting the
// job's manual override — which freezes that job out of its own scope rollup
// and moves cost accrual and a Live-Rooms-visible figure — and writing nothing
// at all.
//
// Most service jobs have exactly one scope line, so this is exact. Where there
// are several, this function REFUSES and names them: splitting one number
// across lines that carry different revenue would invent a distribution nobody
// asked for, and the lines are what the WIP actually reads.
function planApply(job, pct) {
  const phases = (job && (job.phases || (job.data && job.data.phases))) || [];
  const live = phases.filter((p) => p && p.id != null);
  const target = snapPct(pct);

  if (!live.length) {
    return {
      ok: false,
      reason: 'no_scope_line',
      message: 'This job has no scope lines, so there is nowhere to record a percent. ' +
        'Add a scope on the job first, then apply.',
      choices: [],
    };
  }
  if (live.length > 1) {
    return {
      ok: false,
      reason: 'several_scope_lines',
      message: 'This job has ' + live.length + ' scope lines. Choose which one this ' +
        'percent belongs to — splitting it across lines with different revenue would ' +
        'invent a split nobody decided.',
      choices: live.map((p) => ({
        id: p.id,
        label: String(p.phase || p.name || p.id),
        buildingId: p.buildingId == null ? null : p.buildingId,
        pct: Number(p.pctComplete) || 0,
      })),
    };
  }
  return {
    ok: true,
    phaseId: live[0].id,
    from: Number(live[0].pctComplete) || 0,
    to: target,
    changed: (Number(live[0].pctComplete) || 0) !== target,
  };
}

// ── Projection ─────────────────────────────────────────────────────────────
// BY INCLUSION, like every other outward-facing projection in this app. A
// column added to production_checklist_rows later does not appear here, and
// therefore cannot reach a link holder, until somebody adds it on purpose.
//
// hideFinancials is the share's own flag and defaults TRUE everywhere a share
// exists in this app. Contract value is the ONLY money this sheet can ever
// carry (John, 2026-10-02: "contract value only") — there is no cost, no
// margin and no profit field to leak.
function publicRow(row, opts) {
  const o = opts || {};
  const r = row || {};
  const out = {
    id: r.id,
    job_id: r.job_id,
    job_number: r.job_number || null,
    job_title: r.job_title || null,
    client_label: r.client_label || null,
    address: r.address || null,
    pct: snapPct(r.pct),
    done: !!r.done,
    note: r.note == null ? null : String(r.note),
    updated_at: r.updated_at || null,
    updated_actor: r.updated_actor || null,
    applied_at: r.applied_at || null,
    // DERIVED here from the title the row already carries, not taken from the
    // caller. It used to read r.is_work_order, which meant every caller had to
    // remember to compute it first — and a caller that forgot would silently
    // drop the WO badge for link holders rather than fail. The title is on the
    // row; there is no reason to need anything else.
    is_work_order: isWorkOrder({ title: r.job_title }),
  };
  if (!o.hideFinancials) {
    out.contract_amount = r.contract_amount == null ? null : Number(r.contract_amount);
  }
  return out;
}

function publicChecklist(list, rows, opts) {
  const o = opts || {};
  const l = list || {};
  const projected = (rows || []).map((r) => publicRow(r, o));
  return {
    id: l.id,
    title: l.title,
    meeting_date: l.meeting_date || null,
    status: l.status || 'open',
    created_at: l.created_at || null,
    rows: projected,
    summary: summarize(projected),
    // What the holder of THIS link may do. The page reads this rather than
    // guessing from the presence of a token.
    can_update: o.scope === 'update',
    shows_money: !o.hideFinancials,
  };
}

// The tally bar: done / in progress / not started, and one overall percent.
// Overall is the mean of the row percents, NOT revenue-weighted — this is a
// progress checklist, not a WIP number, and weighting it by contract value
// would make it look like one.
function summarize(rows) {
  const list = rows || [];
  let done = 0, prog = 0, idle = 0, sum = 0;
  list.forEach((r) => {
    const p = snapPct(r && r.pct);
    sum += p;
    if (p >= 100) done++;
    else if (p > 0) prog++;
    else idle++;
  });
  return {
    total: list.length,
    done: done,
    in_progress: prog,
    not_started: idle,
    overall_pct: list.length ? Math.round(sum / list.length) : 0,
  };
}

// ── Share scope ────────────────────────────────────────────────────────────
// view   — read the sheet. No write door is reachable at all.
// update — additionally move pct / done / note, which is the whole point of
//          sending it. Narrower than an 'edit': a holder can never add a row,
//          remove one, rename the sheet, apply anything to a job, or reach a
//          different sheet.
const SHARE_SCOPES = Object.freeze(['view', 'update']);

function normalizeScope(scope) {
  const s = String(scope || '').trim().toLowerCase();
  return SHARE_SCOPES.indexOf(s) >= 0 ? s : 'view';
}

const DEFAULT_SHARE_DAYS = 30;
const MAX_SHARE_DAYS = 120;

// An absolute expiry, always set, capped. A link with no expiry is a password
// that never rotates.
function shareExpiry(days, now) {
  const base = now instanceof Date ? now.getTime() : Date.now();
  let d = Math.floor(Number(days));
  if (!Number.isFinite(d) || d <= 0) d = DEFAULT_SHARE_DAYS;
  if (d > MAX_SHARE_DAYS) d = MAX_SHARE_DAYS;
  return new Date(base + d * 24 * 60 * 60 * 1000);
}

// Why a token was refused, as a code the door turns into a sentence. Checked
// in this order on purpose: a revoked link and an expired one are different
// facts and the holder deserves the right one.
function shareRefusal(share, now) {
  const t = now instanceof Date ? now.getTime() : Date.now();
  if (!share) return 'not_found';
  if (share.revoked_at) return 'revoked';
  const exp = share.expires_at ? new Date(share.expires_at).getTime() : 0;
  if (!exp || exp <= t) return 'expired';
  return null;
}

function mayUpdate(share) {
  return !!share && normalizeScope(share.scope) === 'update' && !shareRefusal(share);
}

module.exports = {
  genId,
  genToken,
  hashToken,
  isWellFormedToken,
  PLANNING_STATUSES,
  PLANNING_PREFIXES,
  PCT_STEPS,
  NOTE_CAP,
  SHARE_SCOPES,
  DEFAULT_SHARE_DAYS,
  MAX_SHARE_DAYS,
  statusOf,
  numberOf,
  titleOf,
  prefixOf,
  isWorkOrder,
  isPlannable,
  snapPct,
  cleanNote,
  normalizeEntry,
  splitEntryPatch,
  planApply,
  publicRow,
  publicChecklist,
  summarize,
  normalizeScope,
  shareExpiry,
  shareRefusal,
  mayUpdate,
};
