'use strict';
// ── BUILDERTREND ESTIMATE WORKSHEETS → PROJECT 86 ESTIMATES ───────────────
//
// Step 6 of the reconcile. Every dataset before this one was record-for-record:
// a Buildertrend bill is a P86 bill. THIS ONE IS NOT. A Clickr "Estimates"
// record is ONE LINE ITEM. The estimate is the WORKSHEET (worksheetId), a
// record is one line on it, and the worksheet-level facts (jobId, jobName,
// contractPrice, proposalStatus, worksheetLocked) are repeated on every line.
// So this module is the only matcher that GROUPS before it matches: field-map's
// readEstimateLine hands back lines, matchEstimates() folds them into
// worksheets, and every row on the page is one worksheet.
//
// A worksheet becomes a REAL P86 ESTIMATE — its own row in `estimates`, with
// its own lines — attached to the P86 job its Buildertrend job is linked to.
// That is the owner's decision, taken over landing the lines as job budget rows
// and over a read-only panel. Its consequence is the new column: until now a
// P86 estimate belonged to a lead and a client and had no job link at all, so
// `estimates.attached_job_id` is a shape no reader of estimates had seen (see
// server/db.js, which says at length why it is NOT data.job_id).
//
// THE RUNGS
//   0. estimates.bt_worksheet_id — the saved link;
//   1. the job PLUS the worksheet title. Buildertrend sends no per-worksheet
//      name, so the worksheet's title IS its job name (worksheetTitle below) —
//      the only worksheet-level name the dataset carries. Two worksheets on one
//      job therefore key identically, which is exactly why two candidates are
//      AMBIGUOUS and propose nothing rather than being guessed between.
//
// THE CLASSES: matched / conflict / ambiguous / new / refused, plus
// waitingOnJob on a refusal whose Buildertrend job is not linked to a P86 job.
//
// ── MONEY IS HELD BACK ────────────────────────────────────────────────────
//   line items      — the whole point of the import, and pure money: a line's
//                     qty x unitCost is the estimate's cost and drives its
//                     price. A ticked item carrying money: true. It is never a
//                     correction, so "Link confident matches" cannot sweep it
//                     in and an "apply everything" press that names no fields
//                     cannot either.
//   contract price  — Buildertrend's contract figure for the JOB, repeated on
//                     every line of the worksheet. P86 keeps it on the JOB
//                     (data.contractAmount), and the JOBS tab already proposes
//                     it there. Shown here for review and NEVER applied: two
//                     tabs writing one number is how they end up disagreeing.
//   total difference— what P86's own pricing code makes of the imported lines
//                     against what Buildertrend says the owner pays. Review
//                     only; there is no field to apply it to. It exists so a
//                     markup this sync mapped wrongly cannot be absorbed in
//                     silence.
//
// ── NEVER TOUCH A SENT OR SOLD ESTIMATE ───────────────────────────────────
// THE MOST IMPORTANT GUARD IN THIS CHANGE. A P86 estimate carrying sent_at,
// sent_count > 0, approval_status, accepted_at, approved_at, is_locked or the
// sold marker data.job_id is a document that went to a client or was sold. Its
// lines and its money are what the client agreed to. The sync refuses to
// rewrite any of it and SAYS SO on the row; the only thing it will still write
// on such an estimate is the Buildertrend id itself, because the link is what
// stops the next refresh reading the worksheet as new and creating a duplicate.
//
// ── MARKUP, WHICH IS WHERE THE MONEY IS EASIEST TO GET WRONG ──────────────
// A P86 line's `markup` is a PERCENT and its price is qty x unitCost x
// (1 + markup/100) — price = cost x k. Buildertrend carries a markup TYPE and
// four figures beside it, and the first version of this module read that type
// as a WORD (percent / margin / per unit / amount), mapping the words it knew
// and refusing everything else.
//
// AGAINST THE REAL DATASET THAT REFUSED ALL 62 WORKSHEETS. 277 line records
// folded into 62 worksheets, a complete fetch, 0 matched, 0 new, 62 refused,
// and 178 line notes reading "a markup type this sync has no rule for ("1")".
// markupType is not a word. It is a NUMERIC CODE.
//
// WHAT THE REAL RECORDS SAY — four lines read out of Clickr's own UI:
//
//   line  type  qty  unitCost  markupPercent  markupPerUnit  markupAmount  margin  ownerPrice
//    A    "1"    1      5100         100          5100          5100         50      10200
//    B    "5"    1       770       88.68        682.83        682.83         47     1452.83
//    C    "5"    1      9600         150         14400         14400         60      24000
//    D    "1"    1     36000        -100        -36000        -36000          0          0
//
// BUILDERTREND POPULATES ALL FOUR NOTATIONS ON EVERY LINE, CONSISTENTLY. The
// type only records which one the person typed. The percent is always there,
// and it always reproduces the owner price: 5100 x 2.00 = 10200, 9600 x 2.50 =
// 24000 and 36000 x 0 = 0, all exact — and 770 x 1.8868 = 1452.836 against an
// owner price of 1452.83, six tenths of a cent, because markupPercent is itself
// rounded to two decimals (the exact markup is 682.83/770 = 88.6792…%).
//
// SO THE MARKUP IS markupPercent, WHATEVER THE TYPE SAYS — and the rule is not
// "trust it", it is "check it":
//
//   * every line is priced through P86's OWN pricing code from its quantity,
//     its unit cost and that percent, and compared with Buildertrend's own
//     ownerPrice for that line (lineAgreesWithBuildertrend below);
//   * a line that agrees is imported. A line that does NOT agree is refused,
//     naming both figures — and a refused line still refuses the WHOLE
//     worksheet, because an estimate missing lines is a wrong document rather
//     than a partial one. That is where the refusal machinery now points;
//   * the tolerance is priceTolerance() below, and it is NOT an absolute half
//     cent: a half cent refuses line B, and line B is a correct line.
//
// THE CASES THE WORD-GATE USED TO REFUSE, AND WHAT BECOMES OF THEM.
//   per-unit and flat-amount markups — there is no line in this data carrying
//     ONLY a per-unit or a flat figure; the percent is on it too. Where the
//     percent and the owner price agree, the line means exactly what the
//     percent says and it imports. Where they do not — a flat markup on a ZERO
//     cost is the case no percent can express at all, because 0 x k is 0 for
//     every k — the check refuses it and names the two figures. The refusal is
//     EARNED PER LINE now, instead of assumed from a word.
//   a margin — not converted any more, because it no longer has to be: the
//     percent is on the same record. (1 + p/100 = 1/(1 - m/100) is still true;
//     it is just not something this module has to compute.)
//   an unknown type — IMPORTS, because the percent is what is used. The type is
//     quoted in a refusal instead, so a person can see which notation was typed.
//
// A NEGATIVE markup is legitimate and is IMPORTED. Line D is marked up -100%:
// Buildertrend charges the owner nothing for a line that still costs $36,000,
// which is how a worksheet carries a cost it has decided not to sell. A P86
// markup is a percent and carries -100 exactly, so the estimate shows that
// line's cost in full and its price at $0.00 — which is the document
// Buildertrend shows. The worksheet SAYS so in a note rather than leaving it to
// be found in a total.
//
// AND WHERE THE PERCENT CANNOT REACH THE PRICE, THE PRICE IS CARRIED DIRECTLY.
// P86 owns a field that means exactly "a price was promised, rather than
// derived from a cost": pricing-pipeline's `unitSell`, whose own header cites a
// Buildertrend flat rate as the case it was built for. It used to be refused
// here because it was change-order-only — enforced, not assumed — and because
// it was invisible to js/bt-export.js's forked cascade, to the hand-rolled
// cascades in server/routes/ai-routes.js and to the estimate editor's
// target-margin rebuild. Every one of those now runs the shared pipeline, so
// the reason is gone and the field is used.
//
// IT IS USED ONLY WHERE NO PERCENT COULD HAVE WORKED — which is narrower than
// "where the percent failed", and the difference is the whole safety of this.
// A line whose cost base is not zero CAN be reached by some percent, so a
// percent that misses its own owner price means Buildertrend's two figures
// disagree with each other; that stays refused and still names both, because
// burying a disagreement under a promise is the opposite of carrying it. Only
// a ZERO cost base is unreachable by construction, and a promoted line is put
// back through the same check, which for a promise is exact. A line that
// imports today therefore imports tomorrow with the same keys, the same
// fingerprint and the same arithmetic.
//
// THE CASE IT ANSWERS, verbatim from the live preview: "A. Structural Repairs
// at Building 9" — Buildertrend says the owner pays $20,000.00, the builder
// cost is $0.00, markup type "2". 0 x k is 0 for every k, so no percent can
// express it and the worksheet was refused. The cost stays $0.00, because
// `unitCost` means COST and Buildertrend says the cost is nothing; the price
// is stated; the line's profit is finally the whole $20,000.00, which is what
// Buildertrend's own worksheet says it is.
//
// WHAT STILL REFUSES: a price that cannot be expressed EITHER way. A quantity
// of zero is the one that actually occurs — qty x any unit price is $0.00, so
// a non-zero owner price is unreachable — and the refusal names that limit
// instead of the markup-percent limit, which no longer applies.
//
// AND THE WORKSHEET IS PROVED TOO. Every importable worksheet is priced through
// P86's OWN pricing code — services/money/estimate-totals.js, which runs
// js/pricing-pipeline.js, the same module the editor and the proposal run — and
// the result is compared with the sum of Buildertrend's ownerPrice. With every
// LINE verified, that total can now only differ where a line's owner price was
// not readable money at all and nothing could check it; the difference is a
// held-back money item naming both figures. It is never absorbed.

const match = require('./bt-match');
const estimateTotals = require('../money/estimate-totals');
// sellLocked, and nothing else: the ONE rule for "does this line carry a
// promised price". A local copy of that discriminator is a copy that will
// disagree — `unitSell: 0` is a real promise at $0 and `unitSell: ''` is no
// promise at all, and both shapes are reachable from this importer.
const pricing = require('../../../js/pricing-pipeline.js');
const crypto = require('crypto');

const { isBtBlank, isP86Blank, textKey, parseMoney, fmtMoney } = match;

// HALF A CENT — the floor of every money comparison in this file, and the
// constant term of priceTolerance() below.
const EPS = 0.005;
const str = (v) => (v == null ? '' : String(v));
const norm = (v) => str(v).trim().replace(/\s+/g, ' ');

// A MONEY FIGURE, with 0 kept as 0. Rounds to cents, because that is what a
// dollar amount is. A QUANTITY or a PERCENT is NOT money and goes through
// numExact below instead — see the comment there.
//
// parseMoney answers { kind: 'blank', zero: true } for a real zero, because on
// a money field "blank" and "$0.00" are the same statement about a dollar
// amount. On a QUANTITY or a PERCENT they are not: 0% markup is a decision and
// a quantity of 0 is a line that contributes nothing, and both have to reach
// the arithmetic as 0 rather than as "no figure". Everything unreadable stays
// null so it can be named instead of silently becoming zero.
function num(v) {
  const m = parseMoney(v);
  if (m.kind === 'value') return m.value;
  // Blank is 0, exactly as P86's own lenient num() reads a blank input box
  // (pricing-pipeline: parseFloat -> NaN -> 0). A RANGE or unreadable text is
  // null, so it can be named instead of silently becoming zero.
  if (m.kind === 'blank') return 0;
  return null;
}

// A COUNT OR A PERCENT, NOT MONEY — num() without the rounding to cents.
//
// num goes through parseMoney, which rounds EVERY figure to cents because a
// dollar amount has cents. A quantity does not: 1.3333 squares, 0.004 tons and
// 1,333.3333 square feet are figures Buildertrend holds and a P86 line can hold
// (pricing-pipeline's own num is a bare parseFloat), so rounding them here
// would write a number NEITHER side ever had, into a document that becomes a
// proposal — and the only thing that would surface it is the held-back total
// difference below, which would name the markup for a quantity's error. Same
// for a percent: num(99.999) is 100, and markupPercentFor would then refuse a
// perfectly readable margin as "its margin is 100%".
//
// It REUSES parseMoney's grammar rather than re-implementing it, because that
// grammar is what reads the three shapes readEstimateLine can deliver — a
// number, a string, or Buildertrend's { value, scale } envelope — and it is
// what keeps unreadable input NAMED instead of silently becoming zero.
// Number('1,333.3333') and Number({ value: 1.3333 }) are both NaN, and
// Number([]), Number(false) and Number(' ') are all 0; a hand-rolled reader
// here would refuse quantities that import correctly today and zero ones that
// are refused today. The contract is num's, exactly: value -> value, blank ->
// 0, a range or unreadable text -> null.
function numExact(v) {
  const m = parseMoney(v, { round: false });
  if (m.kind === 'value') return m.value;
  if (m.kind === 'blank') return 0;
  return null;
}

// ── WHAT THE MARKUP IS ────────────────────────────────────────────────────
//
// The P86 percent a Buildertrend line's markup IS. markupPercent is read and
// nothing else is: the type is a numeric code and the other three figures are
// the same markup written differently (see the header). Returns { pct } or
// { why }.
//
// A line with NO markup percent at all is refused pointing at the mapping
// diagnostic, exactly as the missing-TYPE refusal used to. The key that has to
// be right has moved, and the sentence moved with it: markupPercent is now the
// one key here whose name only the diagnostic can settle, because
// CLICKR_API_KEY lives on the deployed server and nothing here can reach it.
function markupPercentFor(L) {
  if (L.markupPercent == null) {
    return { why: 'Buildertrend sent no markup percent on it, so what it charges the owner over its cost is unknown. If the Estimates diagnostic below '
      + 'lists "markupPercent" as carried by no record, that key name is wrong in field-map.js — correct it and refresh' };
  }
  const p = numExact(L.markupPercent);
  if (p == null) return { why: 'its markup percent is not a readable number' };
  return { pct: p };
}

// ── THE TOLERANCE ─────────────────────────────────────────────────────────
//
// What "the same price" means when one side wrote the markup as a percent
// ROUNDED TO TWO DECIMALS. It is not an absolute half cent: line B of the
// header is 770 x 88.68% = 1452.836 against an owner price of 1452.83, six
// tenths of a cent out, and an absolute half cent refuses it.
//
// That residual is not noise and it is not a fixed amount either — it SCALES
// with the line, because the thing that was rounded is the percent:
//
//     ownerPrice = C x (1 + p_true/100), and |p - p_true| <= 0.005 points,
//     so |P86 price - ownerPrice| <= C x 0.005/100 = C x 0.00005
//
// where C is the line's own cost, qty x unitCost. Buildertrend stores the owner
// price in cents, so add half a cent for that:
//
//     tolerance(C) = 0.005 + C x 0.00005
//
// Line B: 0.005 + 770 x 0.00005 = $0.0435, against a residual of $0.006. It
// imports. AND IT STILL CATCHES A WRONG PERCENT, which is the whole point of
// having one: the smallest wrong percent Buildertrend can even express is ONE
// STEP, 0.01 points, worth C x 0.0001 — twice the scaled term — so on every
// line costing more than $100 a one-step-wrong percent is always caught, and
// below $100 one step is worth less than a cent, which the owner price's own
// rounding to cents already hides. Line B carrying 88.69% instead of 88.68% is
// $0.077 out against a $0.0435 tolerance: refused, as it must be.
const PCT_STEP = 0.01;
function priceTolerance(costBase) {
  const c = Number(costBase);
  return EPS + (Number.isFinite(c) ? Math.abs(c) : 0) * ((PCT_STEP / 2) / 100);
}

// A tolerance is not a dollar amount anybody is charged, and fmtMoney would
// print the thing a comparison actually allowed as "$0.00".
const fmtTol = (t) => '$' + t.toFixed(4);

// ── THE CHECK THAT REPLACED THE WORD-GATE ─────────────────────────────────
//
// P86's own pricing code against Buildertrend's own owner price, for ONE line.
//   agree  -> { tol }
//   differ -> { tol, why } — the worksheet is refused and both figures named
//
// AN OWNER PRICE THAT IS NOT READABLE MONEY AGREES, because nothing compared
// it. The line itself is perfectly carryable — a quantity, a unit cost and a
// percent — and refusing a worksheet over a figure this sync could not READ
// would refuse it for Clickr's shape rather than for Buildertrend's money.
// Nothing checked it, though, and the row says so: btOwnerTotal counts exactly
// these lines (it reads the same field through the same parseMoney), the note
// names the count, and the worksheet's total difference is what stands over
// them. The count is NOT taken a second time here — one rule, one counter.
function lineAgreesWithBuildertrend(line, L, exactCost) {
  // A PROMISED LINE'S TOLERANCE IS HALF A CENT AND NOTHING MORE. The scaled
  // term of priceTolerance exists to forgive a markup PERCENT rounded to two
  // decimals; a promised line has no percent to round, so P86 prices it at
  // exactly the figure Buildertrend sent and the only slack it may have is
  // the cent Buildertrend's own storage rounds to. Handing a promise the
  // cost-scaled tolerance would forgive a real error on a big line.
  const promised = pricing.sellLocked(line);
  const base = line.qty * line.unitCost;
  const tol = priceTolerance(promised ? 0 : base);
  const m = parseMoney(L.ownerPrice);
  if (m.kind !== 'value' && m.kind !== 'blank') return { tol };
  // A blank owner price IS $0.00: on a money field "blank" and "zero" are the
  // same statement about a dollar amount (see num above), and btOwnerTotal
  // already counts it as nothing. A costed line the owner pays nothing for and
  // that is not marked up -100% is exactly the disagreement this check exists
  // to catch, so it is compared rather than skipped.
  const owner = m.kind === 'value' ? m.value : 0;
  // The SAME pricing code the whole worksheet is proved through, one line at a
  // time, so a change to either cannot leave the two disagreeing.
  const p86 = p86PricedTotal([line]).clientPrice;
  const diff = p86 - owner;
  if (Math.abs(diff) <= tol) return { tol };
  // A unit cost carrying more than cents is P86's OWN limit rather than
  // Buildertrend disagreeing with itself, and it is named as what it is.
  const rounded = exactCost != null && exactCost !== line.unitCost;
  // A promise that does not verify is not a markup problem and must not be
  // described as one. In practice only one shape reaches here: a quantity of
  // zero, where qty x any unit price is $0.00 and the owner price is not.
  if (promised) {
    return { tol, promisedFailed: true,
      why: 'Buildertrend says the owner pays ' + fmtMoney(owner) + ' for it and Project 86 cannot carry that price at all: '
        + 'its cost and markup do not reach it, and neither does the promised price it was given, which prices at '
        + fmtMoney(p86)
        + (isBtBlank(L.markupType) ? '' : '. Buildertrend records its markup type as "' + norm(L.markupType) + '"') };
  }
  // A ZERO COST IS NOT A DISAGREEMENT, IT IS AN IMPOSSIBILITY, and the two
  // must not be worded the same. No markup percent can carry a price over a
  // cost of $0.00 — 0 x k is $0.00 for every k — so quoting a tolerance "a
  // markup percent rounded to two decimals can explain" describes a limit
  // that was never the binding one. A line reaching here has already been
  // offered a promised price and could not take one, which leaves exactly one
  // shape: a quantity of zero.
  if (base === 0) {
    return { tol, why: 'Buildertrend says the owner pays ' + fmtMoney(owner) + ' for it over a builder cost of ' + fmtMoney(0)
      + ', and no markup percent can express that — 0 x k is ' + fmtMoney(0) + ' for every k. A price like this can only be carried '
      + 'by stating it on the line rather than deriving it'
      + (Number(line.qty) === 0
        ? ', and this line’s quantity is 0, so a stated unit price cannot reach it either: 0 x any unit price is ' + fmtMoney(0)
        : '')
      + (isBtBlank(L.markupType) ? '' : '. Buildertrend records its markup type as "' + norm(L.markupType) + '"') };
  }
  return { tol, why: 'Buildertrend says the owner pays ' + fmtMoney(owner) + ' for it, and Project 86 prices the same quantity, unit cost and '
    + line.markup + '% markup at ' + fmtMoney(p86) + ' — ' + fmtMoney(Math.abs(diff)) + (diff > 0 ? ' more' : ' less')
    + ', which is more than the ' + fmtTol(tol) + ' that a markup percent rounded to two decimals can explain'
    + (rounded
      ? '. Buildertrend’s unit cost on it is ' + exactCost + ' and a Project 86 line carries cents, so this line cannot be carried at Buildertrend’s price at all'
      : (isBtBlank(L.markupType) ? '' : '. Buildertrend records its markup type as "' + norm(L.markupType) + '"')) };
}

// ── THE PROMOTION ─────────────────────────────────────────────────────────
//
// The per-unit promised price that would make this line worth exactly what
// Buildertrend says the owner pays — or NOTHING, which is the answer far more
// often than it is not.
//
// ⚠⚠ THE GATE IS "NO PERCENT EXISTS", NOT "THE PERCENT DISAGREES". Those are
// different facts and conflating them destroys the check this sits inside.
//
//   * A line whose cost base is NOT zero can always be reached by SOME
//     percent — p = ownerPrice/base − 1 exists — so when Buildertrend's own
//     percent does not reach its own owner price, the two figures Buildertrend
//     sent DISAGREE WITH EACH OTHER. Importing that at the owner price would
//     bury the disagreement under a promise and hand the estimator a document
//     nobody can reconcile. It stays refused, and the refusal still names both
//     figures. Line B of the tolerance suite — $770 at 88.69% against an owner
//     price of $1,452.83, eight cents out against a $0.0435 tolerance — is
//     exactly this, and it must stay red.
//   * A line whose cost base IS zero can be reached by no percent at all:
//     0 x k is 0 for every k. There is nothing to disagree with, because there
//     is no arithmetic that could have produced the owner price in the first
//     place. That — and only that — is what the promised price is for, and it
//     is what all 19 of the live offenders are: markup type "2", a price typed
//     for the owner with the builder cost left at zero.
//
// So: base must be exactly zero, and the quantity must not be, because
// qty x unitSell is $0.00 for every unitSell when qty is 0 — the one shape a
// promise cannot express either.
//
// TWO CANDIDATES, IN ORDER, and the caller verifies whichever comes back
// through lineAgreesWithBuildertrend like any other line:
//   * owner / qty ROUNDED to six decimals — what markupPercentFor already
//     does to a percent, and what keeps the stored number a figure a person
//     can read in the editor's Unit Sell box rather than 6666.666666666667;
//   * the exact quotient, when the rounded one would not reproduce the owner
//     price to the cent. A quantity of 10,000 turns a rounding of 5e-7 into
//     half a cent, which is exactly the tolerance, so the rounded candidate
//     cannot simply be trusted at every quantity.
//
// An owner price that is not readable money returns nothing: there is no
// figure to promise, and lineAgreesWithBuildertrend has already agreed about
// it because nothing compared it (btOwnerTotal counts those separately).
function promisedCandidates(line, L) {
  const q = Number(line.qty);
  const c = Number(line.unitCost);
  if (!Number.isFinite(q) || !Number.isFinite(c)) return [];
  if (q === 0) return [];          // qty x anything is $0.00
  if (q * c !== 0) return [];      // a percent CAN reach it — see the gate above
  const m = parseMoney(L.ownerPrice);
  if (m.kind !== 'value' && m.kind !== 'blank') return [];
  const owner = m.kind === 'value' ? m.value : 0;
  const exact = owner / q;
  if (!Number.isFinite(exact)) return [];
  const rounded = Math.round(exact * 1e6) / 1e6;
  return rounded === exact ? [exact] : [rounded, exact];
}

// ── THE LINE ARRAY ────────────────────────────────────────────────────────
//
// P86's subgroups are defined by ARRAY ORDER, header-delimited: a line carrying
// section '__section_header__' owns every line after it until the next header.
// They are NOT derived from a cost code, which is why this builder emits a
// header and then that header's lines, in order, rather than tagging lines.
//
// GROUPING RULE
//   * deleted lines are dropped before anything else is decided;
//   * a line's group is its groupId when Buildertrend sends one, else its
//     groupTitle. (Two groups that genuinely share a title stay two groups when
//     they have ids, which reproduces Buildertrend rather than merging them.)
//   * lines are ordered by displayOrder ascending. A line with no readable
//     displayOrder sorts after the ones that have one, in the order it arrived;
//     ties keep arrival order, so the sort is stable and a re-read produces the
//     same array.
//   * groups come out in the order of their FIRST line, which is Buildertrend's
//     own worksheet order whether displayOrder runs across the worksheet or
//     restarts inside each group.
//   * UNGROUPED lines (no group id and no group title) are emitted FIRST, with
//     no header. P86 allows lines before the first header and the pricing
//     cascade handles them; inventing a header named "Ungrouped" would put a
//     word on the proposal that nobody typed. Every line this builder writes
//     carries an explicit numeric markup, so no line ever depends on the
//     cascade for its price anyway.
//
// GROUP PATH DEEPER THAN ONE LEVEL. P86 has exactly ONE level of header, so the
// choice is between losing Buildertrend's ancestors and keeping them inside the
// one name P86 has. Losing them is not free: "Labor" under "Building A" and
// "Labor" under "Building B" arrive as two headers a person cannot tell apart,
// and re-deriving which is which afterwards is guesswork. The path carries
// strictly more and costs only a longer header, so THE HEADER IS NAMED BY
// groupPath whenever Buildertrend sends a path that is not just the leaf title,
// and by groupTitle otherwise. Nothing is nested and nothing is merged: each
// distinct Buildertrend group is still exactly one P86 header, and the row says
// when a path was used.
function headerNameFor(L) {
  const path = isBtBlank(L.groupPath) ? '' : norm(L.groupPath);
  const title = isBtBlank(L.groupTitle) ? '' : norm(L.groupTitle);
  if (path && textKey(path) !== textKey(title)) return { name: path, fromPath: true };
  return { name: title, fromPath: false };
}

// A line's printed name. Every KEY is read once and strictly (field-map's
// `itemTitle`, `description`, `costCodeTitle`); this is a VALUE fallback and
// never a fallback chain of candidate key names — an estimate line has to print
// something, and Buildertrend really does leave the item name blank (a sampled
// record read "Item —").
//
// THE TITLE FIRST, THEN BUILDERTREND'S OWN DESCRIPTION. Buildertrend has two
// text fields on a line and a P86 estimate line has exactly ONE, so a line
// carrying both keeps its TITLE — the shorter of the two, and the one
// Buildertrend's own list view shows — and the worksheet SAYS the description
// was not carried (describedSentence below) rather than dropping it in silence.
// A line with no title and a description prints the description, which is
// strictly better than what it printed before: "Subcontractors Costs" is a cost
// CODE's name, a category, not what the line is.
function lineDescription(L) {
  if (!isBtBlank(L.itemTitle)) return norm(L.itemTitle);
  if (!isBtBlank(L.description)) return norm(L.description);
  if (!isBtBlank(L.costCodeTitle)) return norm(L.costCodeTitle);
  return '(no description in Buildertrend)';
}

const slug = (v) => str(v).replace(/[^A-Za-z0-9]+/g, '').slice(0, 40);

// Deterministic ids: the same worksheet read twice produces the same array,
// which is what makes the staleness fingerprint stable and a re-apply a no-op.
function idMaker(prefix) {
  const used = new Set();
  return (seed) => {
    let id = prefix + 'bt' + (slug(seed) || 'x');
    let n = 2;
    while (used.has(id)) { id = prefix + 'bt' + (slug(seed) || 'x') + '_' + n; n++; }
    used.add(id);
    return id;
  };
}

// Build the P86 line array for a worksheet. Returns
// { lines, groups, refusals, tolerance, negatives, described }.
//
//   refusals  — the per-line reasons a line cannot be carried: a markup percent
//               that is missing or unreadable, a quantity or a unit cost that is
//               unreadable, or a PRICE P86 and Buildertrend do not agree on.
//               When it is non-empty the caller refuses the WHOLE worksheet.
//   tolerance — the sum of the lines' own tolerances, which is what the
//               worksheet TOTAL may differ by for the same reason one line may.
//   negatives — the lines Buildertrend prices below cost, named on the row.
//   promised  — the lines whose owner price no markup percent could express,
//               imported carrying that price in `unitSell`. Named on the row:
//               a price P86 was told rather than derived is a thing to SEE.
//   described — how many lines carried a Buildertrend description as well as a
//               title, which a P86 line has no second text field for.
function buildLines(live, wsId) {
  const ordered = live.map((L, i) => ({ L, i }))
    .sort((a, b) => {
      const ao = a.L.displayOrder;
      const bo = b.L.displayOrder;
      if (ao == null && bo == null) return a.i - b.i;
      if (ao == null) return 1;
      if (bo == null) return -1;
      if (ao !== bo) return ao - bo;
      return a.i - b.i;
    });

  const groups = [];
  const byKey = new Map();
  for (const { L } of ordered) {
    const hdr = headerNameFor(L);
    const key = !isBtBlank(L.groupId) ? 'g:' + norm(L.groupId) : (hdr.name ? 't:' + textKey(hdr.name) : '');
    if (key === '') {
      if (!byKey.has('')) { const g = { key: '', name: '', fromPath: false, lines: [] }; byKey.set('', g); groups.push(g); }
      byKey.get('').lines.push(L);
      continue;
    }
    if (!byKey.has(key)) { const g = { key, name: hdr.name, fromPath: hdr.fromPath, lines: [] }; byKey.set(key, g); groups.push(g); }
    byKey.get(key).lines.push(L);
  }
  // Ungrouped first; every other group keeps its first-line order.
  groups.sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : 0));

  // NAMESPACED BY THE WORKSHEET, and in the PREFIX rather than in the seed so a
  // seed that is empty cannot fall back into a shared bucket.
  //
  // idMaker's `used` set is per call and every seed is Buildertrend's own group
  // or line id — neither is unique outside this worksheet. Two worksheets can
  // carry the same group id, a group with NO id keys on its TITLE (so every
  // worksheet with a 'Labor' group emits the same header id), and a line whose
  // lineId is missing seeds on ''. But P86's line-id space is the WHOLE
  // PORTFOLIO: appData.estimateLines is one flat array across every estimate
  // (js/app.js), and js/line-identity.js RE-MINTS any duplicate it finds there.
  // A re-minted id moves that estimate's linesFingerprint, so the next save
  // makes this sync propose an applicable Line-items REPLACE — a MONEY item —
  // on an estimate nobody edited, on every refresh, for ever. Folding the
  // worksheet id in keeps the ids deterministic, so a re-read still produces
  // the same array and a re-apply is still a no-op, while making them unique.
  //
  // 'l' and 's' stay the FIRST character: js/app.js installs p86LineIdentity
  // with a prefixFor returning 's' for a __section_header__ and 'l' otherwise,
  // so a healed id has to keep reading like the ones around it.
  const ns = slug(wsId) || 'x';
  const lineId = idMaker('l' + ns + '_');
  const hdrId = idMaker('s' + ns + '_');
  const lines = [];
  const refusals = [];
  const negatives = [];
  const promised = [];
  let tolerance = 0;
  let described = 0;
  for (const g of groups) {
    if (g.key !== '' && g.name) {
      lines.push({
        id: hdrId(g.key),
        section: '__section_header__', description: g.name,
        // 0, the seed services/estimate-lines.js uses for an estimate header.
        // It changes no price here: every content line below carries its own
        // explicit percent, so the cascade is never consulted, and a header in
        // percent mode contributes nothing to the marked-up total.
        markup: 0,
      });
    }
    for (const L of g.lines) {
      const mk = markupPercentFor(L);
      if (mk.why) {
        refusals.push({ line: lineDescription(L), lineId: L.lineId, why: mk.why });
        continue;
      }
      // numExact, not num: a quantity is a COUNT. The unit cost beside it is
      // real money and keeps num's rounding to cents — and the EXACT figure is
      // read beside it, not to be written, but so that a price P86 cannot reach
      // because of that rounding is named as what it is rather than as
      // Buildertrend disagreeing with itself.
      const qty = numExact(L.quantity);
      const cost = num(L.unitCost);
      const exactCost = numExact(L.unitCost);
      if (qty == null) { refusals.push({ line: lineDescription(L), lineId: L.lineId, why: 'its quantity is not a readable number' }); continue; }
      if (cost == null) { refusals.push({ line: lineDescription(L), lineId: L.lineId, why: 'its unit cost is not readable money' }); continue; }
      const line = {
        description: lineDescription(L),
        qty, unit: 'ea', unitCost: cost,
        // A NUMBER, always, and never ''. Blank inherits the section and then
        // the document default, which would make an imported line's price
        // depend on a field nobody set. Buildertrend told us the percent.
        markup: Math.round(mk.pct * 1e6) / 1e6,
        btLineId: L.lineId || null,
      };
      // THE PRICE IS CHECKED BEFORE THE LINE EXISTS. A refused line must not
      // mint an id: idMaker's `used` set is what keeps the array deterministic,
      // so a line that is not written must not consume a seed either.
      let agrees = lineAgreesWithBuildertrend(line, L, exactCost);
      // ── THE PROMOTION, and ONLY after the percent has already failed ──
      // A line the percent reaches is untouched: same keys, same fingerprint,
      // same arithmetic as before this existed. A line it cannot reach — the
      // zero-cost flat rate, markup type "2" — carries the owner's price
      // directly instead of refusing the whole worksheet, and is then put
      // back through the SAME check, which for a promise is exact.
      if (agrees.why) {
        for (const cand of promisedCandidates(line, L)) {
          line.unitSell = cand;
          const retry = lineAgreesWithBuildertrend(line, L, exactCost);
          if (!retry.why) { agrees = retry; break; }
          agrees = retry;            // keep the PROMISED refusal sentence
        }
        if (agrees.why) delete line.unitSell;   // refused — carry no half-promise
      }
      if (agrees.why) { refusals.push({ line: line.description, lineId: L.lineId, why: agrees.why }); continue; }
      tolerance += agrees.tol;
      if (pricing.sellLocked(line)) {
        promised.push({ line: line.description, price: Number(line.qty) * Number(line.unitSell), cost: Number(line.qty) * Number(line.unitCost) });
      } else if (line.markup < 0) {
        negatives.push({ line: line.description, pct: line.markup });
      }
      if (!isBtBlank(L.itemTitle) && !isBtBlank(L.description)) described++;
      lines.push(Object.assign({ id: lineId(L.lineId) }, line));
    }
  }
  return { lines, groups, refusals, tolerance, negatives, promised, described };
}

// What P86 will actually charge for these lines, computed by P86's OWN pricing
// code rather than by a formula written here. estimate-totals runs
// js/pricing-pipeline.js, which is the module the estimate editor, the proposal
// preview and the server all run, so this number cannot drift from the one the
// estimator will see.
//
// Called with the WHOLE worksheet (the proof) and with ONE line at a time
// (lineAgreesWithBuildertrend). A single line prices exactly as it prices inside
// the array — no header precedes it, and its markup is an explicit number, so
// the section-and-document cascade is never consulted either way — which is why
// the line checks and the worksheet proof are the same arithmetic and cannot
// come apart.
function p86PricedTotal(lines) {
  // `alternates: []` is computeEstimateTotals' legacy arm: ONE implicit group
  // of all the lines. It is used deliberately, so this number does not depend
  // on an alternate id that has not been assigned yet — the writer stamps the
  // estimate id and the alternate id, and neither changes a price.
  return estimateTotals.computeEstimateTotals({ lines, alternates: [] });
}

// Buildertrend's own owner price for the worksheet: the sum of its live lines'
// ownerPrice. Returns { total, unreadable } — a figure that is not readable
// money is counted rather than guessed at, and its worksheet says so.
function btOwnerTotal(live) {
  let total = 0;
  let unreadable = 0;
  for (const L of live) {
    const m = parseMoney(L.ownerPrice);
    if (m.kind === 'value') total += m.value;
    else if (m.kind === 'blank') total += 0;
    else unreadable++;
  }
  return { total: Math.round(total * 100) / 100, unreadable };
}

function btCostTotal(live) {
  let total = 0;
  for (const L of live) {
    // numExact on the quantity, exactly as buildLines reads it, so the cost
    // printed on the row is the cost the lines written from it will price at.
    const q = numExact(L.quantity);
    const c = num(L.unitCost);
    if (q != null && c != null) total += q * c;
  }
  return Math.round(total * 100) / 100;
}

// ── THE P86 SIDE ──────────────────────────────────────────────────────────

function parseJsonish(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return v;
}

const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// A stable digest of an estimate's line array, so an apply can tell whether the
// lines it was proposed against are still the lines in the database. Built from
// a CANONICAL projection rather than from the stored JSON: two saves of the same
// estimate can differ in key order and in keys this sync does not read, and
// neither is an edit.
function linesFingerprint(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const canon = arr.map((l) => [
    str(l && l.id),
    (l && l.section) === '__section_header__' ? 'h' : 'l',
    norm((l && (l.description || l.label)) || ''),
    N(l && l.qty), N(l && l.unitCost),
    (l && (l.markup === '' || l.markup == null)) ? '' : N(l.markup),
    (l && (l.unitSell === '' || l.unitSell == null)) ? '' : N(l.unitSell),
    // NOT alternateId, and not estimateId. Neither is something this import
    // decides — the writer stamps both — and the item that carries the lines is
    // refused outright on an estimate holding more than one alternate, so there
    // is no case where a line moving between alternates is the change being
    // measured. Including them would make the fingerprint of the array this
    // module builds differ from the array it writes, on every single row.
  ]);
  return crypto.createHash('sha1').update(JSON.stringify(canon)).digest('hex');
}

function p86EstimateView(r) {
  const data = parseJsonish(r.data) || {};
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const alternates = Array.isArray(data.alternates) ? data.alternates : [];
  const totals = (() => {
    try { return estimateTotals.computeEstimateTotals(data); } catch (e) { return null; }
  })();
  return {
    id: r.id,
    jobId: r.attached_job_id || null,
    btId: norm(r.bt_worksheet_id),
    data,
    title: str(data.title || data.name),
    client: str(data.client),
    leadId: data.lead_id == null ? null : String(data.lead_id),
    soldJobId: data.job_id == null ? null : String(data.job_id),
    lines,
    alternates,
    activeAlternateId: data.activeAlternateId || null,
    contentLines: lines.filter((l) => l && l.section !== '__section_header__').length,
    baseCost: totals ? totals.baseCost : null,
    clientPrice: totals ? totals.clientPrice : null,
    fingerprint: linesFingerprint(lines),
    isLocked: r.is_locked === true || r.is_locked === 1,
    sentAt: r.sent_at || null,
    sentCount: Number(r.sent_count) || 0,
    approvalStatus: isP86Blank(r.approval_status) ? '' : String(r.approval_status),
    acceptedAt: r.accepted_at || null,
    approvedAt: r.approved_at || null,
    declinedAt: r.declined_at || null,
  };
}

// THE GUARD. A document that went to a client or was sold is never rewritten by
// a sync; the reasons are listed so the row can say which one it is.
function lifecycleLock(v) {
  const why = [];
  if (v.isLocked) why.push('it is locked');
  if (v.sentAt) why.push('it was sent to a client');
  else if (v.sentCount > 0) why.push('it has been sent ' + v.sentCount + ' time' + (v.sentCount === 1 ? '' : 's'));
  if (v.approvalStatus) why.push('its approval status is "' + v.approvalStatus + '"');
  if (v.acceptedAt) why.push('it was accepted');
  if (v.approvedAt) why.push('it was approved');
  if (v.declinedAt) why.push('it was declined');
  if (v.soldJobId) why.push('it was sold onto a job');
  return why.length ? why : null;
}

// Lines Buildertrend sent with no readable line id. Nothing BREAKS on one —
// the ids are namespaced by worksheet and idMaker's suffix keeps them unique
// inside it — but the line carries btLineId: null, so nothing can trace it
// back to Buildertrend. ALL of them means the `lineItemId` key name is wrong,
// which only the mapping diagnostic can settle; it is said out loud rather
// than imported in silence. Returns '' when every line carries one.
function noLineIdSentence(ws) {
  if (!ws.noLineId) return '';
  if (ws.noLineId === ws.live.length) {
    return 'Buildertrend sent no line id on ANY of this worksheet’s lines. If the Estimates diagnostic below lists "lineItemId" '
      + 'as carried by no record, that key name is wrong in field-map.js — correct it and refresh.';
  }
  return ws.noLineId + ' of this worksheet’s lines came with no Buildertrend line id, so those lines cannot be traced back to Buildertrend.';
}

// A line Buildertrend prices BELOW its cost. At -100% the owner pays nothing at
// all for work that still costs money, which is how a Buildertrend worksheet
// holds a cost it has decided not to sell. P86's markup is a percent and
// carries a negative one exactly, so the line is imported as Buildertrend
// priced it — but an estimate carrying cost it will never charge for is a thing
// to SEE on the row, not to discover in a total.
function negativeSentence(ws) {
  const list = (ws.built && ws.built.negatives) || [];
  if (!list.length) return '';
  const shown = list.slice(0, 3).map((n) => '“' + n.line + '” at ' + n.pct + '%');
  return list.length + ' of this worksheet’s lines ' + (list.length === 1 ? 'carries' : 'carry') + ' a NEGATIVE Buildertrend markup (' + shown.join(', ')
    + (list.length > shown.length ? ', and ' + (list.length - shown.length) + ' more' : '') + '). Buildertrend prices them below cost — at -100% the owner '
    + 'pays nothing for a line that still costs money — and they are imported exactly that way: the cost stays in the estimate and the line’s price follows the percent.';
}

// A line whose owner price no markup percent could reach, imported carrying
// that price directly. This is the Buildertrend flat rate — a price typed for
// the owner with the builder cost left at zero, markup type "2" — and before
// P86 could express it the whole worksheet was refused over it. The cost is
// still Buildertrend's cost and the price is still Buildertrend's price; what
// is new is that they no longer have to be reachable from one another.
function promisedSentence(ws) {
  const list = (ws.built && ws.built.promised) || [];
  if (!list.length) return '';
  const shown = list.slice(0, 3).map((n) => '“' + n.line + '” at ' + fmtMoney(n.price));
  return list.length + ' of this worksheet’s lines ' + (list.length === 1 ? 'carries' : 'carry') + ' a price Buildertrend states outright rather than '
    + 'deriving from a cost (' + shown.join(', ')
    + (list.length > shown.length ? ', and ' + (list.length - shown.length) + ' more' : '') + '). No markup percent can express a price over a cost of '
    + '$0.00, so those lines are imported carrying the owner’s price on the line itself: the cost stays exactly what Buildertrend says it is, the price '
    + 'stays exactly what Buildertrend charges, and the markup is not consulted. Clearing that price in the estimate editor returns the line to cost x markup.';
}

// Buildertrend has a title AND a description on a line; a P86 estimate line has
// one text field. The title is what is written (lineDescription above), so a
// line carrying both loses the description — said out loud here rather than
// dropped in silence.
function describedSentence(ws) {
  const n = (ws.built && ws.built.described) || 0;
  if (!n) return '';
  return n + ' of this worksheet’s lines ' + (n === 1 ? 'carries' : 'carry') + ' a Buildertrend description as well as a title. A Project 86 estimate line has one text field, so the title is '
    + 'what is written and the description is not carried across.';
}

function lockSentence(why) {
  return 'This Project 86 estimate is a document that went to a client or was sold (' + why.join('; ')
    + '). A sync never rewrites its line items, its title or its money. Nothing is proposed for it beyond saving the Buildertrend id, '
    + 'which is only what stops the next refresh reading this worksheet as new and creating a duplicate.';
}

// ── WORKSHEETS ────────────────────────────────────────────────────────────

// The worksheet's title. Buildertrend sends no per-worksheet name — the field
// list has a Job name and a Group title and nothing between them — so the job
// name is the only worksheet-level name there is, and it is what a created P86
// estimate is called and what rung 1 compares. Because it is shared by every
// worksheet on a job, rung 1 can never tell two of them apart: that is not a
// weakness of this key, it is the dataset saying there is nothing to tell them
// apart with, and the ambiguity below is the honest answer.
function worksheetTitle(ws) {
  return isBtBlank(ws.jobName) ? '' : norm(ws.jobName);
}

// Worksheet-level facts, which every line of a worksheet repeats. A worksheet
// whose lines DISAGREE about one of them is refused, never averaged and never
// resolved by taking the first line: two different contract prices under one
// worksheetId means the read is not what this module believes it is.
const WS_FACTS = [
  ['jobId', 'Buildertrend job id', (L) => (isBtBlank(L.jobId) ? '' : norm(L.jobId))],
  ['jobName', 'Buildertrend job name', (L) => textKey(L.jobName)],
  ['contractPrice', 'contract price', (L) => {
    const m = parseMoney(L.contractPrice);
    return m.kind === 'value' ? String(m.value) : m.kind === 'blank' ? '0' : 'unreadable';
  }],
  ['proposalStatus', 'proposal status', (L) => textKey(L.proposalStatus)],
  ['worksheetLocked', 'worksheet locked', (L) => (L.worksheetLocked ? '1' : '0')],
];

function groupWorksheets(btValues) {
  const order = [];
  const byId = new Map();
  const noId = [];
  (btValues || []).forEach((L, index) => {
    const wsId = norm(L.btId);
    if (!wsId) { noId.push(Object.assign({ index }, L)); return; }
    if (!byId.has(wsId)) { const w = { btId: wsId, all: [] }; byId.set(wsId, w); order.push(w); }
    byId.get(wsId).all.push(Object.assign({ index }, L));
  });
  return { worksheets: order, noId };
}

// The Buildertrend side of a row: a worksheet, summarised. Values only — the
// same shape every other dataset's bt side has.
function btSide(w, live, cost, owner) {
  const first = live[0] || w.all[0] || {};
  const contract = parseMoney(first.contractPrice);
  return {
    btId: w.btId,
    worksheetId: w.btId,
    scope: 'open',
    title: worksheetTitle(first),
    raw: worksheetTitle(first) || 'Worksheet ' + w.btId,
    jobId: isBtBlank(first.jobId) ? '' : norm(first.jobId),
    jobName: isBtBlank(first.jobName) ? '' : norm(first.jobName),
    proposalStatus: isBtBlank(first.proposalStatus) ? '' : norm(first.proposalStatus),
    worksheetLocked: first.worksheetLocked === true,
    lineCount: live.length,
    deletedCount: w.all.length - live.length,
    costText: fmtMoney(cost),
    ownerText: fmtMoney(owner),
    contractText: contract.kind === 'value' ? fmtMoney(contract.value) : '$0.00',
  };
}

function row(bt, cls, extra) {
  return Object.assign({ bt, class: cls, rung: null, p86: null, corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [] }, extra || {});
}

function jobLabel(j) {
  return [j.jobNumber, j.title].filter((x) => !isP86Blank(x)).join(' ') || j.id;
}

function estCand(v, rungs) {
  return { id: v.id, title: v.title, status: v.contentLines + ' line' + (v.contentLines === 1 ? '' : 's')
    + (v.clientPrice == null ? '' : ' · ' + fmtMoney(v.clientPrice)), rungs: (rungs || []).slice() };
}

function p86Out(v) {
  return { id: v.id, title: v.title || v.id, lineCount: v.contentLines,
    costText: v.baseCost == null ? '' : fmtMoney(v.baseCost),
    priceText: v.clientPrice == null ? '' : fmtMoney(v.clientPrice),
    alternates: v.alternates.length,
    lifecycle: (lifecycleLock(v) || []).join('; '),
    leadId: v.leadId, hasJob: !!v.jobId };
}

// A refused row a P86 estimate is nonetheless LINKED to. Informational only:
// deliberately NOT row.p86, because sync-apply acts on row.p86 and a worksheet
// that is gone must reach no write path at all.
function linkedInfo(v) {
  return { id: v.id, title: v.title || v.id, lineCount: v.contentLines,
    priceText: v.clientPrice == null ? '' : fmtMoney(v.clientPrice) };
}

// ── THE PROPOSALS ON A LINKED / MATCHED ESTIMATE ──────────────────────────
function estimateProposals(ws, v, ctx) {
  const acc = { corrections: [], btBlank: [], heldBack: [], flags: [] };
  const notes = [];
  const locked = lifecycleLock(v);
  const lockWhy = locked ? lockSentence(locked) : null;

  // THE JOB. Reached only on a rung-0 match whose P86 estimate has lost its
  // attachment: rung 1 only ever considers estimates already on this job. A
  // sync never MOVES an estimate between jobs — that moves a proposal's money
  // from one job to another — so a different job is shown, never corrected.
  if (!v.jobId) {
    if (locked) {
      acc.heldBack.push({ field: 'job', label: 'Job', reason: 'locked', bt: ctx.job.label, p86: '', applicable: false, note: lockWhy });
    } else {
      acc.corrections.push({ field: 'job', label: 'Job', kind: 'fill', from: '', to: ctx.job.label, value: ctx.job.id, p86Value: null,
        note: 'This P86 estimate carries the Buildertrend worksheet id but is not filed under any job. Buildertrend keeps the worksheet on '
          + ctx.job.label + ', so this files it there.' });
    }
  } else if (String(v.jobId) !== String(ctx.job.id)) {
    acc.heldBack.push({ field: 'job', label: 'Job', reason: 'money', bt: ctx.job.label, p86: String(v.jobId), applicable: false,
      note: 'A sync never moves an estimate to a different job: that moves a proposal’s money from one job to another. Change it in P86 if Buildertrend is right.' });
  }

  // TITLE — the rung-1 MATCH KEY, so it is never corrected. Offered, ticked on
  // purpose, only where P86 holds nothing at all.
  const btTitle = worksheetTitle(ws.first);
  if (btTitle && norm(v.title) !== btTitle) {
    if (isP86Blank(v.title)) {
      acc.heldBack.push({ field: 'title', label: 'Title', reason: 'review', bt: btTitle, p86: '', value: btTitle, p86Value: v.title || '',
        applicable: !locked,
        note: locked ? lockWhy
          : 'This P86 estimate has no title. Tick it to take Buildertrend’s. A title is a match key, so it is offered rather than corrected.' });
    } else {
      acc.heldBack.push({ field: 'title', label: 'Title', reason: 'review', bt: btTitle, p86: v.title, applicable: false,
        note: locked ? lockWhy
          : 'P86 and Buildertrend call this estimate different things. A title is a MATCH KEY, never something a sync corrects — '
            + 'if they are the same estimate, fix the name on whichever side is wrong.' });
    }
  }

  // THE LINE ITEMS — money, always held back, and never applicable on a
  // document that went to a client or was sold.
  const same = ws.built.fingerprint === v.fingerprint;
  if (!same) {
    const why = locked ? lockWhy
      : v.alternates.length > 1
        ? 'P86 holds ' + v.alternates.length + ' alternates on this estimate. A sync does not choose which one Buildertrend’s worksheet is, '
          + 'so nothing is rewritten. Import it as a new estimate, or reduce it to one group in P86.'
        : null;
    acc.heldBack.push({
      field: 'lines', label: 'Line items', reason: 'money', money: true,
      bt: ws.built.lines.filter((l) => l.section !== '__section_header__').length + ' line'
        + (ws.built.lines.filter((l) => l.section !== '__section_header__').length === 1 ? '' : 's')
        + ' in ' + ws.built.groups.filter((g) => g.key !== '' && g.name).length + ' group'
        + (ws.built.groups.filter((g) => g.key !== '' && g.name).length === 1 ? '' : 's')
        + ' · cost ' + fmtMoney(ws.costTotal) + ' · owner price ' + fmtMoney(ws.ownerTotal),
      p86: v.contentLines + ' line' + (v.contentLines === 1 ? '' : 's')
        + (v.baseCost == null ? '' : ' · cost ' + fmtMoney(v.baseCost))
        + (v.clientPrice == null ? '' : ' · price ' + fmtMoney(v.clientPrice)),
      value: { lines: ws.built.lines },
      p86Value: v.fingerprint,
      applicable: !why,
      note: why || 'Tick it to REPLACE this estimate’s line items with Buildertrend’s worksheet. Every line’s cost and every price on the '
        + 'proposal moves, so it is never applied by "Link confident matches" and never by an apply that names no fields.',
    });
  }

  // CONTRACT PRICE — Buildertrend's figure for the JOB, repeated on every line
  // of the worksheet. Review only, here.
  const cp = parseMoney(ws.first.contractPrice);
  if (cp.kind === 'value') {
    acc.heldBack.push({ field: 'contractPrice', label: 'Contract price', reason: 'money', money: true,
      bt: fmtMoney(cp.value), p86: ctx.job.label, applicable: false,
      note: 'Buildertrend carries this contract price on the JOB, not on the estimate, and P86 does too (the job’s contract amount). '
        + 'It is shown here and never applied from this tab — the Jobs tab is where that one number is proposed, and two tabs writing it is how they come to disagree.' });
  } else if (cp.kind === 'range' || cp.kind === 'unparsed') {
    acc.heldBack.push({ field: 'contractPrice', label: 'Contract price', reason: 'unparsed', money: true,
      bt: '(not readable money)', p86: ctx.job.label, applicable: false,
      note: 'Buildertrend sent a contract price that is not readable money, so it was not compared.' });
  }

  // THE TOTAL DIFFERENCE — P86's own pricing code against Buildertrend's owner
  // price. The proof that the markup rule above did what it claims.
  const diff = ws.p86Total - ws.ownerTotal;
  if (Math.abs(diff) > ws.tol) {
    acc.heldBack.push({ field: 'totalDiff', label: 'Total difference', reason: 'money', money: true,
      bt: fmtMoney(ws.ownerTotal), p86: fmtMoney(ws.p86Total), applicable: false,
      note: 'Project 86 prices Buildertrend’s own lines at ' + fmtMoney(ws.p86Total) + ', and Buildertrend says the owner pays '
        + fmtMoney(ws.ownerTotal) + ' — ' + (diff > 0 ? 'up ' : 'down ') + fmtMoney(Math.abs(diff)) + ', which is more than the ' + fmtTol(ws.tol)
        + ' that Buildertrend’s own two-decimal markup percents can explain. '
        + 'That is computed by P86’s own pricing pipeline over the lines this import would write, so it is the difference the estimator would see. '
        + 'It is shown rather than absorbed: check those lines in Buildertrend before taking them.' });
  }
  if (ws.ownerUnreadable) {
    notes.push(ws.ownerUnreadable + ' of this worksheet’s lines sent an owner price that is not readable money, so nothing could check what P86 prices those '
      + 'lines at against what Buildertrend charges for them, and the comparison above counts them as nothing.');
  }
  const promWhy = promisedSentence(ws);
  if (promWhy) notes.push(promWhy);
  const negWhy = negativeSentence(ws);
  if (negWhy) notes.push(negWhy);
  const descWhy = describedSentence(ws);
  if (descWhy) notes.push(descWhy);
  if (ws.built.groups.some((g) => g.fromPath)) {
    notes.push('Buildertrend groups some of these lines more than one level deep. P86 has exactly one level of section header, so the header is named by the full Buildertrend group path.');
  }
  if (ws.deletedCount) notes.push(ws.deletedCount + ' deleted Buildertrend line' + (ws.deletedCount === 1 ? ' was' : 's were') + ' left out.');
  const noIdWhy = noLineIdSentence(ws);
  if (noIdWhy) notes.push(noIdWhy);
  if (locked) notes.push(lockWhy);
  return { acc, notes };
}

// Buildertrend's OWN proposal word against what P86 last recorded beside it
// (data.btStatus). Two sides that AGREE raise no correction at all, so without
// this a linked estimate whose Buildertrend proposal status later moved could
// never record it. Never a P86 status.
function btStatusDue(ws, v) {
  const word = isBtBlank(ws.proposalStatus) ? '' : norm(ws.proposalStatus);
  return !!word && norm((v.data || {}).btStatus) !== word;
}

// btValues: readEstimateLine() records (LINES). p86: { jobs, estimateRows }.
function matchEstimates(btValues, p86) {
  const jobByBt = new Map();
  for (const j of p86.jobs || []) {
    const k = norm(j.bt_job_id);
    if (k) jobByBt.set(k, { id: j.id, jobNumber: str(j.data && j.data.jobNumber), title: str(j.data && (j.data.title || j.data.name)) });
  }

  const views = (p86.estimateRows || []).map(p86EstimateView);
  const byJob = new Map();
  const byBtId = new Map();
  for (const v of views) {
    if (v.jobId) {
      if (!byJob.has(v.jobId)) byJob.set(v.jobId, []);
      byJob.get(v.jobId).push(v);
    }
    if (v.btId && !byBtId.has(v.btId)) byBtId.set(v.btId, v);
  }

  const { worksheets, noId } = groupWorksheets(btValues);
  const rows = [];

  // Lines Clickr sent with no worksheet id at all. One refusal, not one per
  // line: they name no worksheet, so there is nothing to act on and nothing to
  // create — and a page of identical refusals hides everything else.
  if (noId.length) {
    rows.push(row({ btId: '', worksheetId: '', scope: 'open', raw: '(no worksheet id)', jobName: '', lineCount: noId.length,
      costText: '$0.00', ownerText: '$0.00', contractText: '$0.00' }, 'refused',
    { notes: ['Clickr sent ' + noId.length + ' estimate line' + (noId.length === 1 ? '' : 's') + ' with no worksheet id, so there is no estimate to put '
      + (noId.length === 1 ? 'it' : 'them') + ' on. If the Estimates diagnostic below lists "worksheetId" as carried by no record, that key name is wrong in field-map.js.'] }));
  }

  for (const w of worksheets) {
    const live = w.all.filter((L) => !L.isDeleted);
    const cost = btCostTotal(live);
    const owner = btOwnerTotal(live);
    const bt = btSide(w, live, cost, owner.total);

    // EVERY LINE DELETED (or a worksheet that arrived with none). The worksheet
    // is gone; nothing is read off it, nothing is created from it, and a P86
    // estimate linked to it is NAMED rather than left to vanish with the row.
    if (!live.length) {
      const linked = byBtId.get(w.btId);
      const out = row(bt, 'refused', { notes: ['Every line of this Buildertrend worksheet is deleted, so there is no estimate left in Buildertrend to import.'] });
      if (linked) {
        out.p86Linked = linkedInfo(linked);
        out.notes.push('P86 still has an estimate linked to it (' + (linked.title || linked.id) + ', ' + linked.contentLines + ' line'
          + (linked.contentLines === 1 ? '' : 's') + '). Nothing is proposed and a sync never deletes a P86 estimate — decide in P86 what happens to it.');
      }
      rows.push(out);
      continue;
    }

    // WORKSHEET-LEVEL FACTS MUST AGREE ACROSS ITS LINES.
    const disagree = [];
    for (const [, label, read] of WS_FACTS) {
      const seen = new Set(live.map(read));
      if (seen.size > 1) disagree.push(label + ' (' + seen.size + ' different values)');
    }
    if (disagree.length) {
      rows.push(row(bt, 'refused', { notes: ['This Buildertrend worksheet’s lines disagree about ' + disagree.join(', ')
        + '. Those facts belong to the worksheet and every line of it should repeat them, so nothing is averaged and nothing is taken from the first line — the worksheet is refused. '
        + 'Either these lines are not one worksheet, or the read is not what this sync believes it is.'] }));
      continue;
    }

    const first = live[0];
    const job = jobByBt.get(norm(first.jobId));
    if (!job) {
      rows.push(row(bt, 'refused', { waitingOnJob: true,
        notes: ['Its Buildertrend job' + (isBtBlank(first.jobName) ? '' : ' "' + norm(first.jobName) + '"')
          + ' is not linked to a P86 job yet. Link or create the job on the Jobs tab, then refresh.'] }));
      continue;
    }
    const jobInfo = { id: job.id, label: jobLabel(job) };

    // THE MARKUP. A line P86 cannot carry refuses the WHOLE worksheet: an
    // estimate missing lines is a wrong document, not a partial one.
    const probe = buildLines(live, w.btId);
    if (probe.refusals.length) {
      const shown = probe.refusals.slice(0, 5);
      rows.push(row(bt, 'refused', { job: jobInfo,
        notes: [probe.refusals.length + ' of this worksheet’s ' + live.length + ' line' + (live.length === 1 ? '' : 's')
          + ' cannot be carried by a Project 86 estimate line, so the whole worksheet is refused — an estimate missing lines is a wrong document, not a partial one.']
          .concat(shown.map((r) => '“' + r.line + '” — ' + r.why + '.'))
          .concat(probe.refusals.length > shown.length ? ['and ' + (probe.refusals.length - shown.length) + ' more.'] : []) }));
      continue;
    }

    const built = probe;
    const p86Total = p86PricedTotal(built.lines).clientPrice;
    const ws = {
      btId: w.btId, first, live, all: w.all,
      built: Object.assign({}, built, { fingerprint: linesFingerprint(built.lines) }),
      costTotal: cost, ownerTotal: owner.total, ownerUnreadable: owner.unreadable,
      p86Total: Math.round(p86Total * 100) / 100,
      // WHAT THE TOTAL MAY DIFFER BY: every line's own tolerance, summed —
      // plus one more half cent, because both figures compared against it are
      // rounded to cents before they are compared.
      tol: built.tolerance + EPS,
      deletedCount: w.all.length - live.length,
      // Counted here, worded by noLineIdSentence.
      noLineId: live.filter((L) => isBtBlank(L.lineId)).length,
      proposalStatus: first.proposalStatus,
    };
    const ctx = { job: jobInfo };

    const linked = byBtId.get(w.btId);
    if (linked) {
      if (linked.jobId && linked.jobId !== job.id) {
        rows.push(row(bt, 'refused', { job: jobInfo,
          notes: ['The P86 estimate linked to this worksheet (' + (linked.title || linked.id)
            + ') is filed under a different P86 job than Buildertrend’s job, so nothing is proposed.'] }));
        continue;
      }
      const { acc, notes } = estimateProposals(ws, linked, ctx);
      rows.push(row(bt, acc.corrections.length ? 'conflict' : 'matched',
        Object.assign({ rung: 'Buildertrend ID', job: jobInfo, notes, p86: p86Out(linked), btStatusDue: btStatusDue(ws, linked) }, acc)));
      continue;
    }

    // RUNG 1 — the job plus the worksheet title, among UNLINKED P86 estimates
    // filed under that job.
    const onJob = (byJob.get(job.id) || []).filter((v) => !v.btId);
    const key = textKey(worksheetTitle(first));
    const byTitle = key ? onJob.filter((v) => textKey(v.title) === key) : [];
    if (byTitle.length === 1) {
      const { acc, notes } = estimateProposals(ws, byTitle[0], ctx);
      rows.push(row(bt, acc.corrections.length ? 'conflict' : 'matched',
        Object.assign({ rung: 'Job + title', job: jobInfo, notes, p86: p86Out(byTitle[0]), btStatusDue: btStatusDue(ws, byTitle[0]) }, acc)));
      continue;
    }
    if (byTitle.length) {
      rows.push(row(bt, 'ambiguous', { job: jobInfo, candidates: byTitle.map((v) => estCand(v, ['job + title'])),
        notes: [byTitle.length + ' P86 estimates on this job carry this title, so none is matched and nothing is proposed. '
          + 'Buildertrend sends no per-worksheet name, so there is nothing else to tell them apart with — pick one below, or rename them in P86.'] }));
      continue;
    }

    const out = row(bt, 'new', { job: jobInfo,
      // Not candidates and not a match: the estimates already on this job that
      // NOTHING matched. Listed so a person can point this worksheet at one
      // instead of creating a second, which is a decision only they can make.
      considered: onJob.map((v) => estCand(v, ['on this job'])),
      // THE LINES THE CREATE WOULD WRITE. A matched worksheet carries them on
      // its held-back "Line items" item, where the person ticks them; a NEW one
      // has no P86 side to hold them back from, so they ride the row. Built
      // here and never by sync-apply, so the array a person is shown the shape
      // of and the array that is written are the same array. The page does not
      // render it.
      build: { lines: built.lines, fingerprint: ws.built.fingerprint } });
    if (onJob.length) {
      out.notes.push('P86 already has ' + onJob.length + ' estimate' + (onJob.length === 1 ? '' : 's') + ' on this job that no Buildertrend worksheet matched by title ('
        + onJob.slice(0, 5).map((v) => v.title || v.id).join(', ') + (onJob.length > 5 ? ', …' : '')
        + '). Creating this one adds another — link it to one of them instead if it is the same estimate.');
    }
    if (ws.deletedCount) out.notes.push(ws.deletedCount + ' deleted Buildertrend line' + (ws.deletedCount === 1 ? ' was' : 's were') + ' left out.');
    const noIdWhy = noLineIdSentence(ws);
    if (noIdWhy) out.notes.push(noIdWhy);
    if (built.groups.some((g) => g.fromPath)) {
      out.notes.push('Buildertrend groups some of these lines more than one level deep. P86 has exactly one level of section header, so the header is named by the full Buildertrend group path.');
    }
    if (ws.ownerUnreadable) {
      out.notes.push(ws.ownerUnreadable + ' of this worksheet’s lines sent an owner price that is not readable money, so nothing could check what P86 prices those '
        + 'lines at against what Buildertrend charges for them, and the comparison below counts them as nothing.');
    }
    const promNew = promisedSentence(ws);
    if (promNew) out.notes.push(promNew);
    const negNew = negativeSentence(ws);
    if (negNew) out.notes.push(negNew);
    const descNew = describedSentence(ws);
    if (descNew) out.notes.push(descNew);
    if (Math.abs(ws.p86Total - ws.ownerTotal) > ws.tol) {
      out.notes.push('Project 86 prices these lines at ' + fmtMoney(ws.p86Total) + ' and Buildertrend says the owner pays ' + fmtMoney(ws.ownerTotal)
        + ', which is more than the ' + fmtTol(ws.tol) + ' that Buildertrend’s own two-decimal markup percents can explain. '
        + 'The estimate is created with Buildertrend’s own lines and markups; the difference is shown rather than absorbed.');
    }
    rows.push(out);
  }

  // Two Buildertrend worksheets landing on ONE P86 estimate: neither is matched.
  const claims = new Map();
  for (const r of rows) {
    if ((r.class === 'matched' || r.class === 'conflict') && r.p86) {
      if (!claims.has(r.p86.id)) claims.set(r.p86.id, []);
      claims.get(r.p86.id).push(r);
    }
  }
  for (const group of claims.values()) {
    if (group.length < 2) continue;
    for (const r of group) {
      r.candidates = [estCand(views.find((v) => v.id === r.p86.id), [r.rung])];
      r.notes.push(group.length + ' Buildertrend worksheets land on this same P86 estimate, so none is matched and nothing is proposed.');
      r.class = 'ambiguous';
      r.rung = null;
      r.p86 = null;
      r.btStatusDue = false;
      r.corrections = []; r.btBlank = []; r.heldBack = []; r.flags = [];
    }
  }
  return rows;
}

function notInBuildertrend(rows, btValues, p86) {
  const reached = new Set();
  for (const r of rows) {
    if (r.p86) reached.add(r.p86.id);
    if (r.p86Linked) reached.add(r.p86Linked.id);
    for (const c of r.candidates || []) reached.add(c.id);
    for (const c of r.considered || []) reached.add(c.id);
  }
  const btJobs = new Set((btValues || []).map((b) => norm(b.jobId)).filter(Boolean));
  const jobs = new Map();
  for (const j of p86.jobs || []) {
    if (norm(j.bt_job_id) && btJobs.has(norm(j.bt_job_id))) {
      jobs.set(j.id, jobLabel({ id: j.id, jobNumber: str(j.data && j.data.jobNumber), title: str(j.data && (j.data.title || j.data.name)) }));
    }
  }
  const btIds = new Set((btValues || []).map((b) => norm(b.btId)).filter(Boolean));
  const listed = [];
  let notListed = 0;
  for (const v of (p86.estimateRows || []).map(p86EstimateView)) {
    if (reached.has(v.id)) continue;
    if (!v.jobId || !jobs.has(v.jobId)) { notListed++; continue; }
    listed.push({ id: v.id, title: v.title || v.id,
      status: v.contentLines + ' line' + (v.contentLines === 1 ? '' : 's') + (v.clientPrice == null ? '' : ' · ' + fmtMoney(v.clientPrice)),
      jobLabel: jobs.get(v.jobId), linkedGone: v.btId && !btIds.has(v.btId) ? true : undefined });
  }
  return { rows: listed, notListed };
}

module.exports = {
  matchEstimates, notInBuildertrend, btStatusDue,
  markupPercentFor, priceTolerance, lineAgreesWithBuildertrend, buildLines, headerNameFor, lineDescription,
  worksheetTitle, groupWorksheets, WS_FACTS,
  p86EstimateView, linesFingerprint, lifecycleLock, lockSentence, noLineIdSentence,
  promisedCandidates, promisedSentence,
  p86PricedTotal, btOwnerTotal, btCostTotal, num, numExact, EPS,
};
