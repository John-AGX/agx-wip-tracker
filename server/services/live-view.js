// Live Rooms — phase 02. What a guest is allowed to be shown, and in what shape.
//
// This file has NO require() of its own. That is deliberate and it is the same
// reason services/live-rooms.js is pure: a module that pulls in server/routes/*
// only loads where JWT_SECRET is set, so the logic that most needs a test
// becomes the logic hardest to test. The redactor is the load-bearing piece of
// this phase, so it is a pure function of its arguments, top to bottom.
//
// ══ THE ONE PROMISE ════════════════════════════════════════════════════════
// "The server never sends those numbers." Not a CSS class, not a client-side
// blank, not a value a guest could read in a network response. That promise is
// only keepable if it is structural, so:
//
//   1. A view document is HAND-BUILT. Nothing spreads a row. An unclassified
//      field is absent BY CONSTRUCTION, not by a deny-rule someone has to
//      remember. That is the allow-list argument phase 01 already made
//      (services/live-rooms.js:130) and reversing it here would leave two doors
//      on one feature disagreeing about their own safety posture.
//
//   2. MONEY IS A TYPE, NOT A FIELD NAME. Deleting a money field is not a
//      redaction — js/app.js:56 is `format(val || 0)`, so a missing
//      contractAmount prints "$0.00": a job sold at zero, rendered confidently
//      in the same style as a real figure. And refreshHeaderMetrics does
//      `w.pctComplete.toFixed(1)` unguarded, so a null throws mid-repaint. So
//      every money-bearing slot is a MONEY CELL with exactly two shapes:
//          visible  -> { m: <number|null> }
//          redacted -> { r: true }        (and NOTHING else on the object)
//      The renderer branches on the shape. It cannot print $0.00 because
//      { r:true } is not a number and the guest renderer has no `|| 0`.
//      js/jobs.js:3410 already gets this right in one place, printing "—"
//      rather than "0.0%" because those mean materially different things. This
//      generalises that.
//
//   3. FREE TEXT IS SCRUBBED. A CO titled "Add 3 doors — $4,200" puts a dollar
//      figure on the wire through a field no money-typed redactor would ever
//      look at. Author-written prose therefore goes through text() and has
//      currency-shaped tokens removed when money is hidden. Stated honestly:
//      an amount SPELLED OUT ("four thousand two hundred") is not catchable by
//      any scrubber, and that residue is named in the field list rather than
//      papered over.
//
//   4. A DERIVED FIGURE WHOSE INPUTS ARE HIDDEN IS ITSELF HIDDEN, and so is
//      anything that reconstructs a hidden term. See DERIVATION CLOSURE below.
//
// ══ THE DERIVATION CLOSURE ═════════════════════════════════════════════════
// The field list catches known fields. It does not catch a surviving ratio
// times a surviving total. Two rules, and the second is the one the first
// review of this design got wrong:
//
//   R1 (ratios): a visible non-money ratio may ship only when EVERY term in
//       its numerator and denominator is redacted or non-money.
//   R2 (products): a visible non-money COUNT may ship only when it cannot be
//       multiplied by a constant this repo SERVES PUBLICLY to reproduce a
//       hidden figure. server/index.js:477 mounts express.static on the repo
//       root with no auth in front of it, so `js/jobs.js` — and the `|| 40`
//       default labor rate inside it (js/jobs.js:6116) — is fetchable by any
//       anonymous caller. `hoursTotal` is a COUNT, passes every money-type
//       test, and `hoursTotal * 40` is a labor budget. R2 is why building
//       hours are not on any surface in this file.
//
// What survives, and why, per surface:
//   pctComplete  — progress, not profitability. Reconstructs revenueEarned
//                  only against totalIncome, and BOTH of those are redacted.
//   CO count     — a row count. No public constant turns it into money.
//   CO status    — an enum.
// Nothing else numeric ships.
//
// ══ WHAT IS NOT HERE, ON PURPOSE ═══════════════════════════════════════════
// No QB costs (blanking `amount` still ships vendor, memo and cadence — that is
// AGX's supplier list). No POs or invoices (sub names, contract structure). No
// pay apps (there is no half-redacted G703: whole, or not at all). No photos
// (attachment URLs resolve to storage.publicBase, an UNAUTHENTICATED host, so
// any URL a projection emits is a permanently fetchable credential that
// survives kick, revoke and expiry — that is a URL-emission problem, not a
// display one, and it needs an answer before it needs a tab). No Site Plan
// (Maps SDK + a key handed to an anonymous holder + geo footprints + a graph
// projection; the most expensive of the candidates by a wide margin, and
// shipping three surfaces honestly beats shipping four badly).

'use strict';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── Tagged cells ───────────────────────────────────────────────────────────
// The tags are private and NEVER serialized: redact() replaces every one of
// them, and the caller asserts none survived. A tag reaching the wire is a
// builder bug, and it is caught loudly rather than shipped quietly.
const MONEY_TAG = '__p86_money';
const TEXT_TAG = '__p86_text';

/** Wrap a money-bearing value. Every dollar, every margin, every rate. */
function money(v) {
  const n = Number(v);
  return { [MONEY_TAG]: Number.isFinite(n) ? n : null };
}

/** Wrap author-written prose. Anything a human typed into the app. */
function text(v) {
  return { [TEXT_TAG]: v == null ? '' : String(v) };
}

// Currency-shaped tokens in prose. Deliberately aggressive: a grouped number
// ($4,200 / 4,200 / 4200.00), any bare run of three or more digits, and any
// decimal fraction. "Add 3 doors" and "Phase 2" survive; "$4,200" does not.
//
// The residue, stated: a figure spelled out in words is not catchable. So is a
// figure split across a sentence. Prose is the ONE place this file's promise is
// best-effort rather than structural, and it is named here rather than implied.
const CURRENCY_SHAPES = /\$\s*\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:[,  ]\d{3})+(?:\.\d+)?\b|\b\d{3,}(?:\.\d+)?\b|\b\d+\.\d+\b/g;
const PROSE_MAX = 240;

function scrubProse(s) {
  return String(s == null ? '' : s).replace(CURRENCY_SHAPES, '—').slice(0, PROSE_MAX);
}
function plainProse(s) {
  return String(s == null ? '' : s).slice(0, PROSE_MAX);
}

// ── The policy ─────────────────────────────────────────────────────────────
// FAIL CLOSED. Every input that is not literally the two permitting cases
// returns the narrow answer, including a value written by a future build.
//
// Not a `scope` value: normalizeScope is fail-closed toward phase 04's DRAW
// capability, and "may draw" is orthogonal to "may see margin" — overloading
// one column would force a split the moment phase 04 lands.
//
// Not a client flag: js/auth.js:351's goOffline() fabricates {role:'admin'} and
// hasCapability returns true unconditionally in that mode, so ANY client-side
// redaction predicate keyed on a capability answers `true` for a guest.
// Redaction keys off the server's answer or it is not redaction.
function viewPolicy(room, participant) {
  if (!room || !participant) return { money: false };
  // The host is the presenter. They are looking at their own job in their own
  // app; a room does not take numbers away from the person who started it.
  if (participant.role === 'host') return { money: true };
  // Strict === false. NULL, undefined, 'f', 0 and anything a newer build might
  // write all mean HIDDEN.
  if (room.hide_financials === false) return { money: true };
  return { money: false };
}

// ── The redactor ───────────────────────────────────────────────────────────
// One walk, one place, one field list. Both the SSE seam and the read proxy
// call this, so there is exactly one classification in the repo rather than
// two that drift.
function redact(node, policy) {
  const showMoney = !!(policy && policy.money === true);
  const prose = showMoney ? plainProse : scrubProse;

  function walk(v, depth) {
    if (depth > 24) return null;                       // no cyclic doc ships
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (hasOwn(v, MONEY_TAG)) {
      if (!showMoney) return { r: true };              // EXACTLY one key
      const n = v[MONEY_TAG];
      return { m: (typeof n === 'number' && isFinite(n)) ? n : null };
    }
    if (hasOwn(v, TEXT_TAG)) return prose(v[TEXT_TAG]);
    const out = {};
    for (const k of Object.keys(v)) out[k] = walk(v[k], depth + 1);
    return out;
  }
  return walk(node, 0);
}

// The guard that makes "a builder bug is loud" true. A surviving tag means a
// container the walk could not enter (a Map, a class instance, a Date used as a
// value holder). Cheap, and it runs on a document that is about to be sent to
// someone who is not a user.
function containsRawTag(doc) {
  let s;
  try { s = JSON.stringify(doc); } catch (e) { return true; }
  return s == null || s.indexOf(MONEY_TAG) !== -1 || s.indexOf(TEXT_TAG) !== -1;
}

// ── Surfaces ───────────────────────────────────────────────────────────────
// A FROZEN allow-list. The registry is the contract: the wire test asserts
// every key here is driven through the canary sweep, so adding a surface and
// forgetting to test it breaks the build rather than relying on vigilance.
//
// Names match js/router.js KNOWN_JOB_SUBS, so a mirrored route maps to a
// surface with no translation table to drift.

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function isoDay(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  // Already a date-ish string: keep the day, drop the clock. A timestamp is a
  // fingerprint of activity; a day is what a meeting needs.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Surface 1 — Job Overview. The landing tab (workspace-layout.js RIGHT_TABS[0])
// and where a Present click lands.
//
// NO job id, NO organization id, NO client id, NO owner. Phase 01 ships a test
// asserting a guest never learns the id of the thing they are looking at
// (services/live-rooms.js:151), and a projection written from the app's own row
// shape would break that invariant on day one — job_id rides along on
// change-order-routes.js shapeRow, on buildings, on phases, on every canonical
// shape in this codebase.
function buildJobOverview(inp) {
  const job = (inp && inp.job) || {};
  const w = (inp && inp.wip) || {};
  return {
    surface: 'job-overview',
    title: text(inp && inp.title),
    facts: [
      { label: 'Status', value: text(job.status || job.jobStatus || '') },
      { label: 'Type', value: text(job.jobType || '') },
      { label: 'Client', value: text(job.client || '') },
      { label: 'Address', value: text(job.propertyAddr || job.address || '') },
      { label: 'Start', value: isoDay(job.startDate) },
      { label: 'Target completion', value: isoDay(job.endDate || job.targetCompletion) }
    ],
    // Progress survives. It reconstructs revenueEarned only against
    // totalIncome, and both of those are money cells. R1 holds.
    progress: { pct: num(w.pctComplete) },
    // The three tiles the job page leads with. All money.
    tiles: [
      { label: 'Contract', cell: money(w.totalIncome) },
      { label: 'Cost to date', cell: money(w.actualCosts) },
      { label: 'Profit', cell: money(w.displayProfit) },
      { label: 'Margin', cell: money(w.displayMargin), unit: '%' }
    ]
  };
}

// Surface 2 — WIP Report. Zero fetches on the app side and a flat read of the
// same 20 figures computeJobWIP already produces server-side, which is the
// cheapest surface in the repo to render honestly and the entire point of the
// toggle existing.
//
// EVERY figure below is a money cell, including the margins: a margin is not
// dollars but it is profitability, and the toggle's own words are "margins,
// cost and contract values". pctComplete is the single survivor.
function buildJobWip(inp) {
  const w = (inp && inp.wip) || {};
  const row = (label, key, unit) => ({ label, cell: money(w[key]), unit: unit || null });
  return {
    surface: 'job-wip-report',
    title: text(inp && inp.title),
    pctComplete: num(w.pctComplete),
    sections: [
      {
        heading: 'Contract',
        rows: [
          row('Contract income', 'contractIncome'),
          row('Change order income', 'coIncome'),
          row('Total income', 'totalIncome')
        ]
      },
      {
        heading: 'Estimated cost',
        rows: [
          row('Estimated costs', 'estimatedCosts'),
          row('Change order costs', 'coCosts'),
          row('Revised cost changes', 'revisedCostChanges'),
          row('Revised estimated costs', 'revisedEstCosts')
        ]
      },
      {
        heading: 'As sold',
        rows: [
          row('As-sold profit', 'asSoldProfit'),
          row('As-sold margin', 'asSoldMargin', '%'),
          row('Revised profit', 'revisedProfit'),
          row('Revised margin', 'revisedMargin', '%')
        ]
      },
      {
        heading: 'Job to date',
        rows: [
          row('Revenue earned', 'revenueEarned'),
          row('Actual costs', 'actualCosts'),
          row('JTD profit', 'jtdProfit'),
          row('JTD margin', 'jtdMargin', '%'),
          row('Accrued costs', 'accruedCosts'),
          row('Projected cost', 'projectedCost'),
          row('Projected profit', 'projectedProfit')
        ]
      },
      {
        heading: 'Billing',
        rows: [
          row('Invoiced to date', 'invoiced'),
          row('Unbilled', 'unbilled'),
          row('Backlog', 'backlog'),
          row('Remaining costs', 'remainingCosts')
        ]
      }
    ]
  };
}

// Surface 3 — Change Orders. The CO is the client-facing document: it is the
// one thing on this list a customer is MEANT to read, and it is requireAuth-only
// on the app side today (change-order-routes.js:73), so nothing is being
// subverted by serving a redacted copy.
//
// No CO id: a guest cannot act on a CO and an id is a handle. `description` is
// author prose and goes through text(), which is where the scrubber earns its
// keep — "Add 3 doors — $4,200" is the realistic way a dollar figure escapes a
// money-typed redactor.
function buildJobChangeOrders(inp) {
  const rows = Array.isArray(inp && inp.changeOrders) ? inp.changeOrders : [];
  return {
    surface: 'job-changeorders',
    title: text(inp && inp.title),
    count: rows.length,
    rows: rows.map((c) => ({
      number: text(c && (c.coNumber || c.co_number) || ''),
      status: text(c && c.status || ''),
      description: text(c && (c.description || c.title) || ''),
      approved: isoDay(c && (c.approved_at || c.approvedAt)),
      income: money(c && (c.counted ? c.income : c.proposedIncome)),
      costs: money(c && (c.counted ? c.costs : c.proposedCosts))
    }))
  };
}

const SURFACES = Object.freeze({
  'job-overview': Object.freeze({ entity: 'job', label: 'Overview', build: buildJobOverview }),
  'job-wip-report': Object.freeze({ entity: 'job', label: 'WIP Report', build: buildJobWip }),
  'job-changeorders': Object.freeze({ entity: 'job', label: 'Change Orders', build: buildJobChangeOrders })
});

const SURFACE_KEYS = Object.freeze(Object.keys(SURFACES));
const DEFAULT_SURFACE = 'job-overview';

function surfaceSpec(s) {
  if (typeof s !== 'string') return null;
  return hasOwn(SURFACES, s) ? SURFACES[s] : null;
}

/** Which surfaces a room's entity type offers, in tab order. */
function surfacesFor(entityType) {
  return SURFACE_KEYS
    .filter((k) => SURFACES[k].entity === entityType)
    .map((k) => ({ key: k, label: SURFACES[k].label }));
}

/**
 * Build one view document. `inputs` are already loaded and already
 * org-verified by the caller — this function does no I/O and takes no request.
 * Returns null for an unknown surface so the caller answers uniformly.
 */
function buildView(surface, inputs, policy) {
  const spec = surfaceSpec(surface);
  if (!spec) return null;
  return redact(spec.build(inputs || {}), policy);
}

// ── The mirrored route ─────────────────────────────────────────────────────
//
// THE MIRROR MAY MOVE THE GUEST WITHIN THE ROOM. IT MAY NEVER MOVE THE ROOM.
//
// Without that, the mirror BECOMES the authorization: every job id the host
// visits would be readable by everyone holding the link, and a host clicking a
// different job is a thing hosts do. So this compares the host's claimed route
// against the ROOM ROW — the sole tenancy authority — and, on a match, returns
// a surface and NOTHING ELSE. The entity id never enters the returned event,
// because publicRoom deliberately withholds it (services/live-rooms.js:157) and
// re-leaking it through the mirror would undo a shipped, tested invariant.
//
// This runs on the HOST'S BEAT, not inside the fan-out. emit() pushes onto the
// room's replay ring BEFORE any projection, so a foreign entity id filtered at
// the projection seam would already be sitting in shared room memory waiting to
// be replayed to every ?after= reconnect. Authorize at execution, not at
// proposal — one step earlier than the design first put it.
function hostViewEvent(raw, room) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  if (!room) return { surface: null, reason: 'away' };
  const et = typeof r.entity_type === 'string' ? r.entity_type : null;
  const eid = (r.entity_id == null || r.entity_id === '') ? null : String(r.entity_id);
  if (!et || !eid) return { surface: null, reason: 'away' };
  if (et !== room.entity_type || eid !== String(room.entity_id)) {
    return { surface: null, reason: 'off_room' };
  }
  const spec = surfaceSpec(r.surface);
  if (!spec || spec.entity !== room.entity_type) return { surface: null, reason: 'not_shared' };
  return { surface: r.surface, reason: null };
}

function viewEq(a, b) {
  const x = a || {}, y = b || {};
  return (x.surface || null) === (y.surface || null) && (x.reason || null) === (y.reason || null);
}

// ── The projection seam ────────────────────────────────────────────────────
// Phase 01 left project(event, participant) running on every event for every
// subscriber as the identity function, precisely so redaction is an edit to ONE
// function. It now does two kinds of redaction, and neither is money-shaped for
// both of them:
//
//   1. `view` is rebuilt from scratch rather than filtered, so no field a
//      future build adds to the host's beat can ride along by accident.
//   2. Per-participant `surface` — what each viewer is actually looking at — is
//      a PRESENTER-ONLY field. The host needs it (it is what tells them someone
//      stopped following BEFORE they say "as you can see here"). A guest must
//      not learn what the other guests are reading.
//
// `recipient` is the SUB, not a participant id: redaction cannot be decided
// from an id without a DB query, and a query inside emit() turns a per-second
// feature into a query storm across every open stream.
function stripPresenterOnly(p) {
  if (!p || typeof p !== 'object') return p;
  const q = {};
  for (const k of Object.keys(p)) {
    if (k === 'surface' || k === 'following') continue;
    q[k] = p[k];
  }
  return q;
}

function projectEvent(event, recipient) {
  if (!event || typeof event !== 'object') return event;
  const isHost = !!(recipient && recipient.role === 'host');
  const showMoney = !!(recipient && recipient.policy && recipient.policy.money === true);

  // The ROOM TITLE is author-written text and it rides the control channel, not
  // the read proxy — so it never passed through a builder and the first version
  // of this seam let it straight out. It is a forward-facing name resolved by
  // entity-labels ("RV2006 Waterside"), and a PM who types the contract value
  // into a job title puts that value on the very first frame every guest
  // receives. Same scrubber, applied where the text actually leaves.
  if (event.type === 'hello' && event.room && !showMoney) {
    const room = {};
    for (const k of Object.keys(event.room)) room[k] = event.room[k];
    room.title = scrubProse(room.title);
    const withRoom = {};
    for (const k of Object.keys(event)) withRoom[k] = event[k];
    withRoom.room = room;
    event = withRoom;
  }

  if (event.type === 'view') {
    const out = { type: 'view', surface: event.surface || null, reason: event.reason || null };
    if (typeof event.seq === 'number') out.seq = event.seq;
    if (event.at) out.at = event.at;
    return out;
  }

  if ((event.type === 'presence' || event.type === 'hello') && Array.isArray(event.participants) && !isHost) {
    const out = {};
    for (const k of Object.keys(event)) out[k] = event[k];
    out.participants = event.participants.map(stripPresenterOnly);
    return out;
  }

  return event;
}

module.exports = {
  MONEY_TAG, TEXT_TAG,
  money, text, scrubProse, redact, containsRawTag,
  viewPolicy,
  SURFACES, SURFACE_KEYS, DEFAULT_SURFACE, surfaceSpec, surfacesFor,
  buildView, buildJobOverview, buildJobWip, buildJobChangeOrders,
  hostViewEvent, viewEq, projectEvent, stripPresenterOnly
};
