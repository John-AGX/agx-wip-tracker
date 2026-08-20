// Live Rooms — phase 03. MIRROR MODE: the guest sees the host's actual pane,
// not a rebuilt document.
//
// This file has NO require() of its own, for the same reason services/
// live-view.js and services/live-rooms.js have none: the logic that most needs
// a test must not be the logic that only loads where JWT_SECRET is set.
//
// ══ WHAT CHANGED, AND WHAT DID NOT ═════════════════════════════════════════
// Phase 02 builds a guest's document FROM THE DATABASE under a hand-written
// allow-list. That path is untouched, still the default, and still the only
// mode for an audience that is not already inside the job. Mirror mode is a
// SECOND mode: the same room, the same roster, the same membership, expiry,
// kick and revoke — with pixels instead of a projection on the surfaces where
// pixels can be sent honestly.
//
// ══ THE CORRECTION THAT SHAPES THIS FILE ═══════════════════════════════════
// The first design said: "the mirror does not decide what to send; it sends
// what the route already authorized." That is FALSE, and the falsification is
// mechanical rather than a matter of taste.
//
//   hostViewEvent authorizes a SURFACE KEY. In projected mode that key resolves
//   through services/live-view.js SURFACES to a hand-built object with a closed
//   field list — about fifteen values for job-overview. In mirror mode the same
//   key would resolve to document.getElementById(key): a DOM subtree this
//   process never sees and cannot classify.
//
// For job-overview those two are not the same authorization by a wide margin.
// renderJobOverview (js/jobs.js:3603+) paints, inside that one element:
//   • the SUBCONTRACTOR ROSTER with each sub's contract amount, billed-to-date
//     and remaining (js/jobs.js:5979-6030) — other companies' commercial terms
//   • VENDOR BILLS with vendor, amount, due date and overdue flag, plus
//     Total / Paid / Outstanding (js/jobs.js:3549-3593) — AGX's payables aging
//   • INVOICES, purchase orders, the scope/phase matrix, the building cards
//   • the TASKS panel, whose rows carry assignee full names in title=
//     (js/tasks.js:1084-1109) — internal staffing
//   • the FILES panel (p86Explorer, canEdit:true) — the job's folder tree
//   • a Sharing button that states how many people the job is shared with
//
// "They have access to the job anyway" was said about the owner-facing contract
// math. It was not said about what AGX pays each trade, who AGX owes and how
// late, or which employee is assigned to what — and the link is FORWARDABLE by
// design ("anyone the link got forwarded to shows up here"). A holder of a
// forwarded link is authenticated to nothing.
//
// So mirror eligibility is its OWN allow-list, narrower than the projected one,
// and it is stated here rather than derived. The registry below is the whole
// answer to "what is captured".
//
// ══ THE SECOND CORRECTION: TENANCY IS PER-FLUSH, NOT PER-BEAT ══════════════
// The route rides the 5s beat (services/live-rooms.js BEAT_MS = 5000). Mutation
// flushes are ~10x faster than that. Switching jobs does NOT create new panes:
// renderWipTab and renderChangeOrders repaint the SAME element in place with
// the new job's numbers, and the observer is attached to that element. So a
// mirror that trusted the last beat's verdict would stream job B's pixels under
// job A's authorization for up to a beat.
//
// The fix is that the mirror up-channel carries its OWN claim on EVERY flush
// and the server runs it through hostViewEvent every time, DISCARDING the
// payload — not merely declining to fan it out — on any refusal. mirrorAuthorize
// below is that gate, and the window is zero because there is no window.
//
// ══ FAIL CLOSED, TWICE ═════════════════════════════════════════════════════
// normalizeMode maps anything that is not exactly 'mirror' to 'projected', for
// the same reason normalizeScope maps anything unrecognised to 'view': a row
// written by a newer build and read by an older one must NARROW, never widen.
//
// And modeWrite enforces mode='mirror' ⇒ hide_financials=false at the WRITE, so
// the row can never claim a redaction the transport is not performing. That
// invariant is not the only gate: services/live-view.js projectEvent drops
// mirror frames for any recipient whose policy does not say money, so the seam
// agrees with the row instead of trusting it.

'use strict';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── The mirror allow-list ──────────────────────────────────────────────────
// Two surfaces. Each entry states the DOM id of the pane that is captured —
// which is deliberately spelled out rather than assumed equal to the key,
// because for one of the four projected surfaces it is not (see below).
//
// job-wip-report      — index.html:1121. Static markup filled by ~22
//                       .textContent writes (js/jobs.js:652-676) plus one
//                       appended Captured Costs card: cost-code labels and
//                       receipt totals for THIS job, no vendor and no memo
//                       (js/cost-inbox.js mountRollup). Mirrors near-perfectly
//                       and discloses this job's own money and nothing else.
// job-changeorders    — index.html:1231, repainted by renderChangeOrders into
//                       a table of CO number, title, status and total. This
//                       job's own change orders.
const MIRROR_SURFACES = Object.freeze({
  'job-wip-report': Object.freeze({ entity: 'job', root: 'job-wip-report', label: 'WIP Report' }),
  'job-changeorders': Object.freeze({ entity: 'job', root: 'job-changeorders', label: 'Change Orders' })
});

const MIRROR_SURFACE_KEYS = Object.freeze(Object.keys(MIRROR_SURFACES));

// The surfaces the ROOM serves that the MIRROR refuses, each with the reason
// the host and the guest are both told. Naming them here rather than letting
// them fall through an `else` is what makes the refusal explainable on screen.
//
//   ledger  — the pane carries other parties' commercial terms and internal
//             staffing, not just this job's own figures. See the header.
//   no_root — there is no element with this id anywhere in the app. grep
//             'job-cost-summary' finds only server/services/live-view.js:517,
//             js/live-view.js:415 and three tests: the app's tab is
//             'job-qb-costs', so captureHostRoute can never even emit this key.
//             It is a projected-only surface reached through the guest's own
//             tab strip, and getElementById would return null.
const MIRROR_REFUSALS = Object.freeze({
  'job-overview': 'ledger',
  'job-cost-summary': 'no_root',
  'job-site-map': 'canvas'
});

/**
 * Can this surface be mirrored, and if not, why not.
 * Returns { ok, surface, root, label, reason }. `reason` is null on ok.
 */
function mirrorEligibility(surface) {
  const key = typeof surface === 'string' ? surface : null;
  if (!key) return { ok: false, surface: null, root: null, label: null, reason: 'away' };
  if (hasOwn(MIRROR_SURFACES, key)) {
    const spec = MIRROR_SURFACES[key];
    return { ok: true, surface: key, root: spec.root, label: spec.label, reason: null };
  }
  const named = hasOwn(MIRROR_REFUSALS, key) ? MIRROR_REFUSALS[key] : 'not_mirrorable';
  return { ok: false, surface: key, root: null, label: null, reason: named };
}

// ── Mode ───────────────────────────────────────────────────────────────────
// Fail closed. Anything that is not exactly 'mirror' is 'projected'.
function normalizeMode(v) { return v === 'mirror' ? 'mirror' : 'projected'; }

/**
 * The write-time invariant. A room in mirror mode is streaming the host's raw
 * pane, so it CANNOT also claim to be hiding financials — the row would be
 * describing a redaction the transport is not performing, and "a viewer who
 * believes they are seeing a filtered view while receiving a raw one" is the
 * stated bad outcome of this whole feature.
 *
 * Returns the pair to persist. Callers write BOTH columns from this, never one.
 */
function modeWrite(mode, hideFinancials) {
  const m = normalizeMode(mode);
  if (m === 'mirror') return { mode: 'mirror', hide_financials: false };
  return { mode: 'projected', hide_financials: hideFinancials !== false };
}

// ── The per-flush gate ─────────────────────────────────────────────────────
// `viewVerdict` is services/live-view.js hostViewEvent's answer for the claim
// carried on THIS flush — { surface, reason } — computed against the room row.
// `mode` is the room's own column.
//
// Every refusal is named, and the payload that produced it is discarded by the
// caller. Nothing an unauthorized flush contains may be stored, replayed or
// fanned out: emit() rings control events BEFORE projection, so a filter applied
// downstream would already have written the wrong job's bytes into shared room
// memory. Authorize at execution.
function mirrorAuthorize(viewVerdict, mode) {
  if (normalizeMode(mode) !== 'mirror') {
    return { ok: false, surface: null, root: null, label: null, reason: 'projected_mode' };
  }
  const v = viewVerdict || {};
  if (!v.surface) {
    // off_room / not_shared / away, straight through. The mirror does not
    // soften the room's own verdict and does not invent one of its own.
    return { ok: false, surface: null, root: null, label: null, reason: v.reason || 'away' };
  }
  return mirrorEligibility(v.surface);
}

// ── Bounds on what the hub holds ───────────────────────────────────────────
// A snapshot is the raw DOM of somebody's private job screen, held in process
// memory. It is bounded by BYTES and by AGE, never by a count: a count bounds
// nothing when one entry can be a megabyte.
const MIRROR_MAX_SNAP_BYTES = 1500000;   // ~1.5 MB. A pane, not a document.
const MIRROR_MAX_OPS_BYTES = 262144;     // ~256 KB of tail before a resnapshot
const MIRROR_OPS_MAX_AGE_MS = 30000;     // and no op older than 30s is replayed
const MIRROR_MAX_FLUSH_BYTES = 262144;   // one POST body ceiling

/**
 * Fold one accepted op batch into the hub's tail, enforcing both bounds.
 * Pure: takes and returns the tail shape, never mutates its argument in place
 * beyond the array it was handed.
 *
 * Returns { ops, bytes, stale }. `stale` means the tail can no longer reach the
 * current document from the snapshot, so a resuming guest must PULL rather than
 * replay — and the difference is reported by name rather than inferred from an
 * empty array, the same rule resumeDecision already states.
 */
function foldOps(tail, batch, bytes, now) {
  const ops = Array.isArray(tail) ? tail.slice() : [];
  const added = Array.isArray(batch) ? batch : [];
  for (const op of added) ops.push({ t: now, op: op });
  let total = (Number(bytes) || 0) + (Number(added.length) ? JSON.stringify(added).length : 0);
  let stale = false;
  // Age first: an op older than the window can never be replayed, so dropping
  // it is not a loss of coverage — but it DOES mean the tail no longer starts
  // at the snapshot, which is exactly what `stale` records.
  const cutoff = now - MIRROR_OPS_MAX_AGE_MS;
  while (ops.length && ops[0].t < cutoff) { ops.shift(); stale = true; }
  while (total > MIRROR_MAX_OPS_BYTES && ops.length) {
    const dropped = ops.shift();
    total -= JSON.stringify([dropped.op]).length;
    stale = true;
  }
  if (total < 0) total = 0;
  return { ops: ops, bytes: total, stale: stale };
}

/**
 * What a (re)connecting guest is owed.
 *
 * The vocabulary is NAMED rather than boolean, for the reason resumeDecision
 * gives at services/live-rooms.js: "resumed with nothing to send" and "cannot
 * cover you" are different answers and must not look alike.
 *
 *   no_snapshot    — the host has not sent one yet (fresh room, or a takeover
 *                    orphaned the hub). The guest waits and is TOLD it is
 *                    waiting; it is never shown a stale frame as current.
 *   pull           — the guest's snapSeq is behind, or the tail cannot cover it.
 *   replay         — the guest is on the current snapshot and the tail reaches
 *                    the present.
 *   surface_moved  — the host is on a different surface than the guest's frame
 *                    belongs to. Pull; never patch across surfaces.
 */
function mirrorResume(state) {
  const s = state || {};
  const have = Number(s.snapSeq) || 0;
  const want = Number(s.guestSnapSeq) || 0;
  if (!s.hasSnapshot) return { action: 'wait', reason: 'no_snapshot' };
  if (s.guestSurface && s.surface && s.guestSurface !== s.surface) {
    return { action: 'pull', reason: 'surface_moved' };
  }
  if (want !== have) return { action: 'pull', reason: want ? 'behind' : 'first_frame' };
  if (s.stale) return { action: 'pull', reason: 'mirror_stale' };
  return { action: 'replay', reason: 'mirror_resumed' };
}

// ── What the two ends SAY ──────────────────────────────────────────────────
// One sentence per refusal, written once, so the host's strip and the guest's
// bar cannot drift apart about the same fact. The host's copy names himself in
// the first person; the guest's names him in the third. Both come from here.
const HOST_REFUSAL_TEXT = Object.freeze({
  off_room: "Viewers can't see this — you're on a different record than the one you're presenting.",
  not_shared: "Viewers can't see this screen — it isn't one of the shared screens.",
  away: "Viewers can't see anything — you've left the job you're presenting.",
  ledger: 'This screen is not mirrored — it carries sub contracts, payables and internal tasks. Viewers get the structured Overview instead.',
  no_root: 'This screen is not mirrored. Viewers get the structured version instead.',
  canvas: 'The Site Plan is a drawing, not a page — it cannot be mirrored. Viewers see nothing from it.',
  not_mirrorable: 'This screen is not mirrored. Viewers get the structured version instead.',
  // A frame past MIRROR_MAX_SNAP_BYTES is REFUSED, never truncated: a truncated
  // DOM is a wrong screen that looks like a right one. Every refusal this gate
  // can produce needs words, or the honesty rule is a promise the host cannot
  // read — so this one is named beside the rest rather than falling through to
  // an empty string.
  too_big: 'This screen is too large to mirror. Viewers get the structured version instead.',
  projected_mode: ''
});

function hostRefusalText(reason) {
  return hasOwn(HOST_REFUSAL_TEXT, reason) ? HOST_REFUSAL_TEXT[reason] : '';
}

/**
 * Does a refusal leave the guest with SOMETHING honest to show, or nothing?
 *
 * This is the composition that pays for the mirror's narrowness. A surface the
 * mirror refuses on CONTENT grounds is still a surface the room serves through
 * the phase-02 read proxy — so the guest degrades to the structured document
 * for that same surface, labelled as such, rather than staring at a pause.
 * Nobody ever gets LESS than projected mode already gave them.
 *
 * A refusal that is about the ROOM (off_room / away / not_shared) has no
 * document behind it and never did; that stays a pause with a named reason.
 */
function fallsBackToProjected(reason) {
  return reason === 'ledger' || reason === 'no_root' ||
         reason === 'not_mirrorable' || reason === 'too_big';
}

module.exports = {
  MIRROR_SURFACES, MIRROR_SURFACE_KEYS, MIRROR_REFUSALS,
  mirrorEligibility,
  normalizeMode, modeWrite,
  mirrorAuthorize,
  MIRROR_MAX_SNAP_BYTES, MIRROR_MAX_OPS_BYTES, MIRROR_OPS_MAX_AGE_MS, MIRROR_MAX_FLUSH_BYTES,
  foldOps, mirrorResume,
  HOST_REFUSAL_TEXT, hostRefusalText, fallsBackToProjected
};
