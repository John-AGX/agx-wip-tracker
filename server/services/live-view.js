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
//   3. STRINGS HAVE TWO CLASSES, NOT ONE. A CO titled "Add 3 doors — $4,200"
//      puts a dollar figure on the wire through a field no money-typed redactor
//      would ever look at, so author PROSE goes through text() and is guessed
//      at aggressively. But the first build had only that one class, so text()
//      became the generic string wrapper and the heuristic ate a street number
//      and a ZIP out of the address on the guest's job card. Structured strings
//      — address, enum, document number — go through ident() and get explicit
//      currency removed and nothing else. See ident() for the full argument,
//      including why titles deliberately stay on the prose tier.
//      Stated honestly: an amount SPELLED OUT ("four thousand two hundred") is
//      not catchable by any scrubber, and that residue is named in the field
//      list rather than papered over.
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
// No raw QB COST LINES — blanking `amount` still ships vendor, memo and cadence,
// and that is AGX's supplier list. The Job Costs surface below is the ROLLUP of
// those lines into six frozen cost-code buckets and nothing else: no vendor, no
// memo, no date, no line count. No QB WEEKLY FLOW either, and the reason is
// worth writing down because it is the line this feature keeps having to draw:
// its 12-week bar is a SPEND PROFILE, and a profile survives redaction (the
// bars are ratios) while every figure is hidden. That is a new disclosure and
// it has to be weighed on purpose, not inherited by reusing a component that
// happens to be well-shaped. Per-bucket "% used" is deliberately NOT that: it
// is self-normalised per row, so it says nothing about how one bucket compares
// to another. No POs or invoices (sub names, contract structure). No
// pay apps (there is no half-redacted G703: whole, or not at all). No photos
// (attachment URLs resolve to storage.publicBase, an UNAUTHENTICATED host, so
// any URL a projection emits is a permanently fetchable credential that
// survives kick, revoke and expiry — that is a URL-emission problem, not a
// display one, and it needs an answer before it needs a tab). No Site Plan
// (Maps SDK + a key handed to an anonymous holder + geo footprints + a graph
// projection; the most expensive of the candidates by a wide margin, and
// shipping four surfaces honestly beats shipping six badly).

'use strict';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── Tagged cells ───────────────────────────────────────────────────────────
// The tags are private and NEVER serialized: redact() replaces every one of
// them, and the caller asserts none survived. A tag reaching the wire is a
// builder bug, and it is caught loudly rather than shipped quietly.
const MONEY_TAG = '__p86_money';
const TEXT_TAG = '__p86_text';
const IDENT_TAG = '__p86_ident';

/** Wrap a money-bearing value. Every dollar, every margin, every rate. */
function money(v) {
  const n = Number(v);
  return { [MONEY_TAG]: Number.isFinite(n) ? n : null };
}

/** Wrap author-written prose. Anything a human typed into the app. */
function text(v) {
  return { [TEXT_TAG]: v == null ? '' : String(v) };
}

/**
 * Wrap a STRUCTURED STRING — an address, an enum, a document number. Capped and
 * escaped like prose, but NOT run through the heuristic scrubber.
 *
 * ── WHY THIS EXISTS, AND WHAT NOT HAVING IT COST ──────────────────────────
 * The first build had exactly two string meanings: money-typed, or "author
 * prose, scrub it". text() therefore became the generic string wrapper for six
 * structurally different fields, and a guest's job card read
 *
 *     "— Fairway Circle, Tampa, FL —"
 *
 * because the prose scrubber's bare-3+-digit rule ate the street number and the
 * ZIP. That is redaction as a function of HOUSE-NUMBER DIGIT COUNT: "12 Oak St"
 * kept its number and "1420 Fairway Circle" did not. The address was never
 * classified as money — NOTHING classified it at all, and the missing CATEGORY
 * is the defect. The address is one instance; "CO-001" -> "CO-—" is another,
 * on the one document a client is actually meant to read.
 *
 * NOT on this tier, deliberately, and this is the correction that matters most:
 * job/room TITLE and CLIENT stay on prose. test/fixtures/live-money-canaries.js
 * seeds `job.title = 'Waterside Phase 2 — 776522 contract'` precisely because a
 * bare un-grouped figure typed into a title is the realistic leak, and the room
 * title rides the hello frame — the FIRST bytes every guest receives. Moving
 * titles here to win back the legibility of "MDW-2008" would have re-emitted
 * that canary. An identifier reading cleanly inside a title is worth less than
 * the tier that catches the money.
 */
function ident(v) {
  return { [IDENT_TAG]: v == null ? '' : String(v) };
}

// ── The two string tiers ───────────────────────────────────────────────────
// EXPLICIT: unambiguous currency — a dollar sign, or grouped thousands. Runs on
// EVERY string that reaches a guest, structured or prose. A PM who types
// "$120,000" into a job title means dollars no matter which field it was.
const EXPLICIT_MONEY = /\$\s*\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:[,  ]\d{3})+(?:\.\d+)?/g;

// HEURISTIC: the GUESS. A bare run of three or more digits, a bare decimal, or
// a percentage — every one of which is also a street number, a ZIP, a document
// number or a model number, which is why this tier is PROSE ONLY.
//
// Note the missing trailing \b on the digit runs. The old rule required one, so
// "9500sf", "250k" and "1.2M contract" — a digit glued to a unit letter, which
// is how people actually write a figure in a note — all survived it intact.
//
// The percentage clause is new and it is the one that earns its keep: the
// toggle's own words are "margins, cost and contract values", and a CO
// described as "repriced at 18% markup" shipped a margin in plain text.
//
// THE RESIDUE, NAMED RATHER THAN IMPLIED. A bare one- or two-digit figure
// ("bill 85 per door") survives, and so does an amount spelled out in words.
// Widening to catch those destroys "Add 3 doors" and "Phase 2", which this
// design protects on purpose. Prose is the ONE best-effort tier in this file.
const HEURISTIC_MONEY = new RegExp(
  EXPLICIT_MONEY.source + '|\\b\\d+(?:\\.\\d+)?\\s*%|\\b\\d{3,}(?:\\.\\d+)?|\\b\\d+\\.\\d+',
  'g'
);

const PROSE_MAX = 240;

// TWO SENTINELS, because they mean two different things and printing both as
// "—" is most of why the shipped card read as broken rather than careful. A
// money cell renders "—": the figure is withheld and the client styles it as
// such. Text removed from inside a sentence reads as REMOVED TEXT.
const PROSE_CUT = '[…]';

function scrubProse(s) {
  return String(s == null ? '' : s).replace(HEURISTIC_MONEY, PROSE_CUT).slice(0, PROSE_MAX);
}
// The structured-string tier: explicit currency only, no guessing.
function scrubIdent(s) {
  return String(s == null ? '' : s).replace(EXPLICIT_MONEY, PROSE_CUT).slice(0, PROSE_MAX);
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
  const structured = showMoney ? plainProse : scrubIdent;

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
    if (hasOwn(v, IDENT_TAG)) return structured(v[IDENT_TAG]);
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
  return s == null || s.indexOf(MONEY_TAG) !== -1 || s.indexOf(TEXT_TAG) !== -1
    || s.indexOf(IDENT_TAG) !== -1;
}

// ── Surfaces ───────────────────────────────────────────────────────────────
// A FROZEN allow-list. The registry is the contract: the wire test asserts
// every key here is driven through the canary sweep, so adding a surface and
// forgetting to test it breaks the build rather than relying on vigilance.
//
// Names match js/router.js KNOWN_JOB_SUBS, so a mirrored route maps to a
// surface with no translation table to drift.

// NULL-PRESERVING, and it has to be. Number(null) is 0 and Number('') is 0,
// both finite — so the obvious version turns "there is no denominator" into a
// confident 0%, which is the same lie as $0.00 for a missing figure, one column
// over. Caught on the cost surface: a bucket with no budget printed "0% used".
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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
//
// ── FIDELITY: THIS DOCUMENT IS SHAPED BY THE APP'S OWN CARD ────────────────
// index.html:1005 #job-info-card is the "money first" job card: a header
// (label / title / address / status pill), a THREE-TILE as-sold row
// (Contract (As Sold) · Est. Costs (As Sold) · Margin (As Sold)), and a meta
// grid. index.html:1061 then carries the 7-chip .p86-totals-strip. The guest
// document names those slots with the app's own labels so the two screens read
// as the same screen, and the guest renderer draws them in the app's own
// markup. Nothing here is a new KIND of field: every tile and chip is a money
// cell, every string is classified, and the sweep already drives every
// computeJobWIP output.
function buildJobOverview(inp) {
  const job = (inp && inp.job) || {};
  const w = (inp && inp.wip) || {};
  return {
    surface: 'job-overview',
    title: text(inp && inp.title),
    // Structured strings, not prose. This is the fix John saw: an address is
    // not money and nothing had ever said so.
    address: ident(job.propertyAddr || job.address || ''),
    status: ident(job.status || job.jobStatus || ''),
    // The app's three as-sold tiles, in the app's order, under the app's labels.
    tiles: [
      { label: 'Contract (As Sold)', cell: money(w.contractIncome), tone: 'accent' },
      { label: 'Est. Costs (As Sold)', cell: money(w.estimatedCosts) },
      { label: 'Margin (As Sold)', cell: money(w.asSoldMargin), unit: '%' }
    ],
    // The app's WIP chip strip, same seven chips in the same order.
    chips: wipChips(w),
    facts: [
      { label: 'Client', value: text(job.client || '') },
      { label: 'Type', value: ident(job.jobType || '') },
      { label: 'Start Date', value: isoDay(job.startDate) },
      { label: 'End Date', value: isoDay(job.endDate || job.targetCompletion) }
    ],
    // Progress survives. It reconstructs revenueEarned only against
    // totalIncome, and both of those are money cells. R1 holds.
    progress: { pct: num(w.pctComplete) }
  };
}

// The seven chips index.html:1061-1093 paints above every job. `tone` is the
// app's own chip modifier (accent / warn / info), carried as DATA so the guest
// renderer never has to pick a colour from a value — a colour driven by the
// sign of a hidden number would be a channel.
function wipChips(w) {
  w = w || {};
  return [
    { label: 'Total Income', cell: money(w.totalIncome), tone: 'accent' },
    { label: 'Actual Costs', cell: money(w.actualCosts), tone: 'warn' },
    { label: 'Accrued Costs', cell: money(w.accruedCosts), tone: 'warn' },
    { label: '% Complete', pct: num(w.pctComplete) },
    { label: 'Revenue Earned', cell: money(w.revenueEarned), tone: 'info' },
    { label: 'Gross Profit', cell: money(w.displayProfit) },
    { label: 'Margin %', cell: money(w.displayMargin), unit: '%' }
  ];
}

// Surface 2 — WIP Report. Zero fetches on the app side and a flat read of the
// same 20 figures computeJobWIP already produces server-side, which is the
// cheapest surface in the repo to render honestly and the entire point of the
// toggle existing.
//
// EVERY figure below is a money cell, including the margins: a margin is not
// dollars but it is profitability, and the toggle's own words are "margins,
// cost and contract values". pctComplete is the single survivor.
//
// ── FIDELITY: THE LABELS ARE THE APP'S, CHARACTER FOR CHARACTER ───────────
// index.html:1121-1226 is the host's WIP grid, and every string below is copied
// from it — five headings, in the host's order, with the host's row labels
// ("As Sold Gross Profit", not "As-sold profit"). That is not decoration: it is
// most of the pointer answer. The reason a remote arrow was dropped is that the
// two ends were different documents; once the row a presenter is reading has
// the SAME NAME on both screens, "look at As Sold Gross Profit" lands with no
// coordinate, no new channel, and it works over the phone too.
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
    // The same chip strip the host has sitting above this tab.
    chips: wipChips(w),
    sections: [
      {
        heading: 'Income',
        tone: 'accent',
        rows: [
          row('Contract (As Sold)', 'contractIncome'),
          row('+ Change Orders', 'coIncome'),
          Object.assign(row('Total Income', 'totalIncome'), { strong: true })
        ]
      },
      {
        heading: 'Estimated Costs',
        tone: 'accent',
        rows: [
          row('Est. Costs (As Sold)', 'estimatedCosts'),
          row('+ CO Est. Costs', 'coCosts'),
          row('+ Revised Changes', 'revisedCostChanges'),
          Object.assign(row('Total Est. Costs (Revised)', 'revisedEstCosts'), { strong: true })
        ]
      },
      {
        heading: 'Profit & Margin',
        tone: 'good',
        rows: [
          row('As Sold Gross Profit', 'asSoldProfit'),
          row('As Sold Margin %', 'asSoldMargin', '%'),
          row('Revised Gross Profit', 'revisedProfit'),
          Object.assign(row('Revised Margin %', 'revisedMargin', '%'), { strong: true })
        ]
      },
      {
        heading: 'Revenue & Billing',
        tone: 'warn',
        rows: [
          { label: '% Complete', pct: num(w.pctComplete) },
          row('Revenue Earned (Income × %)', 'revenueEarned'),
          row('JTD Gross Profit', 'jtdProfit'),
          row('JTD Margin %', 'jtdMargin', '%'),
          row('Invoiced to Date', 'invoiced'),
          row('Unbilled (Revenue - Invoiced)', 'unbilled'),
          Object.assign(row('Backlog (Income - Revenue)', 'backlog'), { strong: true })
        ]
      },
      {
        heading: 'Actual Costs vs Estimated',
        tone: 'orange',
        rows: [
          row('Actual Costs (from tracker)', 'actualCosts'),
          row('Revised Est. Costs', 'revisedEstCosts'),
          Object.assign(row('Remaining Est. Costs', 'remainingCosts'), { strong: true })
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
      // A CO NUMBER IS AN IDENTIFIER. On the prose tier "CO-001" rendered as
      // "CO-—" — the primary name of the one document a client is meant to
      // read, sentinelled by a rule written to catch dollar figures.
      number: ident(c && (c.coNumber || c.co_number) || ''),
      status: ident(c && c.status || ''),
      description: text(c && (c.description || c.title) || ''),
      // Was ALWAYS null: shapeChangeOrderRow's SELECT never asked for
      // approved_at, so this read a column that did not exist on the shape.
      approved: isoDay(c && (c.approved || c.approved_at || c.approvedAt)),
      income: money(c && (c.counted ? c.income : c.proposedIncome)),
      costs: money(c && (c.counted ? c.costs : c.proposedCosts))
    }))
  };
}

// Surface 4 — JOB COST SUMMARY. The table in the study's own mock: cost code,
// budget, committed, actual, variance, % used with a meter. It is the picture
// the whole feature was described around and it was the one surface that did
// not exist, because there was no server-side bucket rollup to build it from
// (js/cost-buckets.js is a browser IIFE over appData; there was no twin).
// money/job-cost-buckets.js is that twin, and it is PURE — the caller hands it
// inputs it has already loaded and org-verified.
//
// WHAT SHIPS AND WHY:
//   budget / committed / actual / variance — money cells, every one.
//   pctUsed — a ratio of two money terms that are BOTH redacted under the
//     policy, so R1 holds exactly as it does for pctComplete. It is also
//     per-row and self-normalised, so it discloses no cross-bucket spend
//     PROFILE: the relative height of one bucket against another never leaves.
//     That distinction is the reason the QB weekly-flow surface is still not
//     here — its bar IS the profile, and a profile is a disclosure that has to
//     be weighed on purpose rather than inherited from a component.
//   the cost-code LABEL — an enum from a frozen list in this repo.
// Nothing else. No line counts (a count times a public constant is money), no
// vendor names, no memos, no dates.
function buildJobCostSummary(inp) {
  const roll = (inp && inp.costBuckets) || { rows: [], total: null };
  const rows = Array.isArray(roll.rows) ? roll.rows : [];
  const shape = (r) => ({
    label: ident(r && r.label),
    budget: money(r && r.budget),
    committed: money(r && r.committed),
    actual: money(r && r.actual),
    variance: money(r && r.variance),
    // num(), not money(): a null budget must arrive as null, never as 0.
    pctUsed: num(r && r.pctUsed)
  });
  return {
    surface: 'job-cost-summary',
    title: text(inp && inp.title),
    columns: ['Cost Code', 'Budget', 'Committed', 'Actual', 'Variance', '% Used'],
    rows: rows.map(shape),
    // Summed SERVER-SIDE from the real figures, before redaction. Never summed
    // on the client from cells: js/insights.js's report.total does exactly that
    // through a num() that returns 0 for anything non-numeric, so reusing it
    // would have printed a confident "$0" company total in the one slot a
    // total belongs — the forbidden failure mode, reached by reuse alone.
    total: roll.total ? shape(roll.total) : null
  };
}

const SURFACES = Object.freeze({
  'job-overview': Object.freeze({ entity: 'job', label: 'Overview', build: buildJobOverview }),
  'job-wip-report': Object.freeze({ entity: 'job', label: 'WIP Report', build: buildJobWip }),
  'job-cost-summary': Object.freeze({ entity: 'job', label: 'Job Costs', build: buildJobCostSummary }),
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

  // ── The frames nobody draws ─────────────────────────────────────────────
  // A guest is sent the host's pointer at 10 Hz, buffered 12 samples to a 5s
  // beat, fanned out to everyone-but-the-sender — and live.html has never
  // drawn one. It cannot: the host's coordinate is measured against
  // index.html's workspace and the guest page is a different document, which
  // is exactly why the remote arrow was dropped on purpose rather than
  // shipped wrong. So the guest was paying roughly 3.6 KB a minute for frames
  // that end in a Map nothing reads, against a promise of "a few kilobytes a
  // minute". Dropped HERE rather than at the sampler so a second presenter —
  // the only recipient that could ever draw one — keeps receiving them.
  //
  // Returning null means DO NOT SEND. emit() skips a null projection.
  if (event.type === 'cursor' && !isHost) return null;

  // ── Mirror frames, and why this arm exists ──────────────────────────────
  // A mirror frame IS the host's raw pane. Every one of them is money-bearing
  // by construction, and no builder in this file ever walks it — projectEvent's
  // last line is `return event`, so an unknown type passes the seam untouched,
  // for every recipient, regardless of policy.
  //
  // Phase 03 enforces mode='mirror' => hide_financials=false at the WRITE
  // (services/live-mirror.js modeWrite), which is where the invariant belongs.
  // But this file is the repo's SINGLE classification point — "one walk, one
  // place, one field list, so there is exactly one classification rather than
  // two that drift" — and a DB invariant is not a classification. If that
  // invariant is ever violated (a migration default, a direct UPDATE, a row
  // written by a newer build and read by an older one — the exact failure
  // normalizeScope fails closed against) the seam would not catch it.
  //
  // So the seam AGREES with the row rather than trusting it: a mirror frame is
  // dropped for any recipient whose policy does not say money. Two independent
  // guards, one policy and one mechanism, the same pairing the Static Maps key
  // gets on the client.
  if (typeof event.type === 'string' && event.type.indexOf('mirror-') === 0 && !showMoney) return null;

  // The same rule for the mirror POINTER that rides `hello`. It is not a
  // mirror- typed frame, so the arm above does not reach it, and a recipient
  // who may not be shown the pixels must not be told where to fetch them
  // either. In practice mode='mirror' forces money on, so this only ever fires
  // if the row invariant has been violated — which is exactly the case this
  // seam exists to survive.
  if (event.type === 'hello' && event.mirror && !showMoney) {
    const noMirror = {};
    for (const k of Object.keys(event)) noMirror[k] = event[k];
    noMirror.mirror = null;
    event = noMirror;
  }

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
  MONEY_TAG, TEXT_TAG, IDENT_TAG,
  money, text, ident, scrubProse, scrubIdent, redact, containsRawTag,
  EXPLICIT_MONEY, HEURISTIC_MONEY, PROSE_CUT,
  viewPolicy,
  SURFACES, SURFACE_KEYS, DEFAULT_SURFACE, surfaceSpec, surfacesFor,
  buildView, buildJobOverview, buildJobWip, buildJobChangeOrders, buildJobCostSummary,
  hostViewEvent, viewEq, projectEvent, stripPresenterOnly
};
