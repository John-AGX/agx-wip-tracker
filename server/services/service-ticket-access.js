// WHO MAY READ OR EDIT A SERVICE TICKET — ONE RULE, EVERY DOOR.
//
// A ticket has no capability of its own; it inherits its PARENT's. A ticket on
// a job is governed by the job capabilities, a ticket on a lead by the lead
// ones, and when a converted lead's ticket carries both, the JOB wins — the
// work order belongs to the job now.
//
// ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────
// The rule used to live as two string-returning helpers copied into two route
// files, and it had two holes that the next door (86 reading and drafting
// tickets) would have inherited verbatim:
//
//   1. THE NARROW TIER WAS NEVER NARROWED. JOBS_VIEW_ASSIGNED and JOBS_EDIT_OWN
//      mean "the jobs I own or have been granted" — js-side and in
//      job-routes.js canAccess/canEdit, and in the attachment roster's
//      assigned-only arm. The ticket routes accepted either capability and then
//      checked nothing about the job, so a crew lead granted one job could read
//      and edit the tickets on every job in the company.
//   2. THE LIST HAD NO GATE AT ALL. GET /service-tickets checked the org and
//      nothing else, so any signed-in user — whatever their role — could list
//      every ticket with its scope and internal notes.
//
// A rule that has to be copied is a rule that drifts. So it is decided here,
// once, and every caller asks.
//
// ── TWO KINDS OF QUESTION ────────────────────────────────────────────────
// * mayAccessTicketParent — the real answer, for a KNOWN parent. It may query
//   (the narrow tier needs the job's owner and grants).
// * coarseCaps — input-only, for gates that run before any row is loaded (the
//   AI read gate, the payload apply gate). Holding one is NECESSARY, never
//   sufficient: a coarse pass must always be followed by mayAccessTicketParent
//   once the parent is known.
//
// The module requires nothing at load time. `auth` is required lazily, and a
// failure to load it is a REFUSAL — the same posture payload-dispatcher.js
// takes, and for the same reason: consumers load without a JWT_SECRET.
'use strict';

const JOB_CAPS = Object.freeze({
  read: Object.freeze({ wide: 'JOBS_VIEW_ALL', narrow: 'JOBS_VIEW_ASSIGNED' }),
  write: Object.freeze({ wide: 'JOBS_EDIT_ANY', narrow: 'JOBS_EDIT_OWN' }),
});
const LEAD_CAPS = Object.freeze({ read: 'LEADS_VIEW', write: 'LEADS_EDIT' });
const MODES = Object.freeze(['read', 'write']);

function normalizeMode(mode) {
  return MODES.indexOf(mode) >= 0 ? mode : null;
}

function loadHasCapability(injected) {
  if (typeof injected === 'function') return injected;
  try {
    const auth = require('../auth');
    return typeof auth.hasCapability === 'function' ? auth.hasCapability : null;
  } catch (e) {
    return null;
  }
}

// { kind: 'job' | 'lead' | null, id } for a ticket row or a create's fields.
function parentOf(ticketOrFields) {
  const t = ticketOrFields || {};
  const jobId = t.job_id == null || t.job_id === '' ? null : String(t.job_id);
  const leadId = t.lead_id == null || t.lead_id === '' ? null : String(t.lead_id);
  if (jobId) return { kind: 'job', id: jobId };
  if (leadId) return { kind: 'lead', id: leadId };
  return { kind: null, id: null };
}

// The any-of list that governs a parent kind in a mode. For messages and for
// callers that already know the parent kind but have not loaded the job.
function capsForParentKind(kind, mode) {
  const m = normalizeMode(mode);
  if (!m) return [];
  if (kind === 'job') return [JOB_CAPS[m].wide, JOB_CAPS[m].narrow];
  if (kind === 'lead') return [LEAD_CAPS[m]];
  return [];
}

// Every capability that could grant `mode` on SOME ticket. Input-only gates
// use this; see the header for why passing it proves nothing on its own.
function coarseCaps(mode) {
  const m = normalizeMode(mode);
  if (!m) return [];
  return [JOB_CAPS[m].wide, JOB_CAPS[m].narrow, LEAD_CAPS[m]];
}

function userIdOf(user) {
  if (!user || user.id == null || user.id === '') return null;
  const n = Number(user.id);
  return Number.isFinite(n) ? n : null;
}

// THE DECISION.
//
// opts:
//   query(sql, params) -> Promise<{ rows }>   pool.query or a transaction client
//   user                                         { id, role, ... } — the actor
//   parent                                       a ticket row or { job_id, lead_id }
//   mode                                         'read' | 'write'
//   orgId                                        the caller's organization
//   hasCapability(user, cap)                     optional; defaults to auth's
//
// Returns { ok: true } or { ok: false, reason }, where reason is one of
//   'bad_mode' | 'no_user' | 'no_parent' | 'no_capability' | 'not_assigned' |
//   'auth_unavailable'
// Every refusal is final. There is no path that answers ok on an error.
async function mayAccessTicketParent(opts) {
  const o = opts || {};
  const mode = normalizeMode(o.mode);
  if (!mode) return { ok: false, reason: 'bad_mode' };
  if (!o.user) return { ok: false, reason: 'no_user' };
  const parent = parentOf(o.parent);
  if (!parent.kind) return { ok: false, reason: 'no_parent' };
  const hasCap = loadHasCapability(o.hasCapability);
  if (!hasCap) return { ok: false, reason: 'auth_unavailable' };

  if (parent.kind === 'lead') {
    return hasCap(o.user, LEAD_CAPS[mode]) ? { ok: true } : { ok: false, reason: 'no_capability' };
  }

  const caps = JOB_CAPS[mode];
  if (hasCap(o.user, caps.wide)) return { ok: true };
  if (!hasCap(o.user, caps.narrow)) return { ok: false, reason: 'no_capability' };

  // THE NARROW TIER. Fail closed at every step: `undefined != null` is false in
  // JavaScript, so a missing id quietly skipping a clause is the classic way
  // this kind of check fails open.
  const uid = userIdOf(o.user);
  if (uid == null || o.orgId == null || typeof o.query !== 'function') {
    return { ok: false, reason: 'not_assigned' };
  }
  let row;
  try {
    const r = await o.query(
      `SELECT j.owner_id, a.access_level
         FROM jobs j
         LEFT JOIN job_access a ON a.job_id = j.id AND a.user_id = $3
        WHERE j.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [parent.id, o.orgId, uid]
    );
    row = r && r.rows && r.rows[0];
  } catch (e) {
    return { ok: false, reason: 'not_assigned' };
  }
  if (!row) return { ok: false, reason: 'not_assigned' };
  if (row.owner_id != null && Number(row.owner_id) === uid) return { ok: true };
  if (row.access_level == null) return { ok: false, reason: 'not_assigned' };
  // A grant of any level lets you SEE the job; only an 'edit' grant lets you
  // change what hangs off it — the same split job-routes.js canAccess/canEdit
  // draws.
  if (mode === 'read') return { ok: true };
  return row.access_level === 'edit' ? { ok: true } : { ok: false, reason: 'not_assigned' };
}

// For LIST queries, which cannot ask one parent at a time. The caller turns
// this into SQL:
//   jobs 'all'      — every job-parented ticket in the org
//   jobs 'assigned' — only tickets whose job the user owns or holds a grant on
//   jobs 'none'     — no job-parented tickets
//   leads true/false — lead-only tickets (job_id IS NULL)
// A caller with no usable identity gets nothing, not everything.
function listVisibility(user, injectedHasCapability) {
  const none = { jobs: 'none', leads: false, userId: null };
  if (!user) return none;
  const hasCap = loadHasCapability(injectedHasCapability);
  if (!hasCap) return none;
  const uid = userIdOf(user);
  let jobs = 'none';
  if (hasCap(user, JOB_CAPS.read.wide)) jobs = 'all';
  else if (hasCap(user, JOB_CAPS.read.narrow) && uid != null) jobs = 'assigned';
  return { jobs, leads: !!hasCap(user, LEAD_CAPS.read), userId: uid };
}

module.exports = {
  JOB_CAPS,
  LEAD_CAPS,
  parentOf,
  capsForParentKind,
  coarseCaps,
  mayAccessTicketParent,
  listVisibility,
};
