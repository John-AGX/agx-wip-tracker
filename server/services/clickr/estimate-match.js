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
// (1 + markup/100) — price = cost x k. Buildertrend carries a markup TYPE plus
// three mutually exclusive figures. They do not all fit that shape:
//
//   percent  -> markup = markupPercent. Straight across; k = 1 + p/100.
//   margin   -> markup = m / (100 - m) x 100, for 0 <= m < 100. ALSO straight
//               across, and losslessly so: a margin says price = cost/(1-m/100)
//               and 1 + p/100 = 1/(1-m/100) by construction, so it is the SAME
//               k. Edit the quantity or the cost afterwards and a P86 percent
//               line and a Buildertrend margin line move identically. Nothing
//               is lost and nothing drifts, so this is a conversion of notation
//               and not of meaning. m outside [0, 100) has no k at all and is
//               refused with the rest.
//   per unit -> price = (unitCost + markupPerUnit) x qty
//   amount   -> price = qty x unitCost + markupAmount
//               NEITHER IS price = cost x k. Any percent chosen reproduces
//               Buildertrend's number TODAY and moves the instant somebody
//               edits the quantity or the cost — which is a silent change to
//               what the line means, written into a document that becomes a
//               proposal. So the WORKSHEET IS REFUSED, naming the lines and the
//               word Buildertrend used.
//
//               P86 does own a field that means exactly "a price was promised,
//               rather than derived from a cost": pricing-pipeline's `unitSell`,
//               whose own header cites a Buildertrend flat rate as the case it
//               was built for. It is NOT used here, and that is a deliberate
//               refusal rather than an oversight: it is change-order-only, that
//               is ENFORCED rather than assumed (test/co-income-call-sites.js),
//               and while it is honoured by the shared pipeline it is invisible
//               to js/bt-export.js's forked cascade, to the hand-rolled
//               cascades in server/routes/ai-routes.js, and to the estimate
//               editor's target-margin rebuild, which drops the locked pair. An
//               estimate priced one way by the total chip and another way by the
//               export is worse than an estimate that was never imported.
//               Bringing `unitSell` to estimates is its own commit; on the day
//               it lands, this arm becomes the one-line change it should be.
//
//   anything else, or no markup type at all -> REFUSED, naming the word. A
//               blank markupType on every record means the KEY NAME is wrong;
//               the refusal says so and points at the mapping diagnostic, which
//               is the only instrument that can settle it (CLICKR_API_KEY lives
//               on the deployed server and nothing here can reach it).
//
// AND IT IS PROVED, NOT ASSERTED. Every importable worksheet is priced through
// P86's OWN pricing code — services/money/estimate-totals.js, which runs
// js/pricing-pipeline.js, the same module the editor and the proposal run — and
// the result is compared with the sum of Buildertrend's ownerPrice. A
// difference of half a cent or more is a held-back money item naming both
// figures. It is never absorbed.

const match = require('./bt-match');
const estimateTotals = require('../money/estimate-totals');
const crypto = require('crypto');

const { isBtBlank, isP86Blank, textKey, parseMoney, fmtMoney } = match;

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

// Buildertrend's markup WORD -> what P86 can carry, or null for "P86 cannot".
// textKey lowercases and collapses punctuation, so every comparison below is
// exact on a collapsed word: no .includes(), because 'markup per unit'
// contains 'markup' and 'percent markup' contains 'markup'.
const MARKUP_KIND = {
  percent: 'percent', percentage: 'percent', 'markup percent': 'percent', 'percent markup': 'percent',
  'markup percentage': 'percent', 'percent of cost': 'percent',
  margin: 'margin', 'margin percent': 'margin', 'percent margin': 'margin', 'margin percentage': 'margin',
  'per unit': 'perUnit', 'markup per unit': 'perUnit', 'per unit markup': 'perUnit', unit: 'perUnit',
  'per item': 'perUnit',
  amount: 'amount', 'markup amount': 'amount', 'flat amount': 'amount', flat: 'amount',
  'flat rate': 'amount', 'lump sum': 'amount', dollar: 'amount', 'dollar amount': 'amount',
  'fixed amount': 'amount',
};
const MARKUP_WORD = { perUnit: 'a per-unit markup', amount: 'a flat markup amount' };
function markupKind(markupType) {
  const t = textKey(markupType);
  if (!t) return null;
  return MARKUP_KIND[t] || null;
}

// The P86 percent a Buildertrend line's markup becomes, or a refusal.
// Returns { pct } or { why }.
function markupPercentFor(L) {
  const kind = markupKind(L.markupType);
  if (kind === 'percent') {
    const p = numExact(L.markupPercent);
    if (p == null) return { why: 'its markup percent is not a readable number' };
    return { pct: p };
  }
  if (kind === 'margin') {
    const m = numExact(L.margin);
    if (m == null) return { why: 'its margin is not a readable number' };
    if (!(m >= 0 && m < 100)) return { why: 'its margin is ' + m + '%, which has no markup percent at all' };
    return { pct: (m / (100 - m)) * 100 };
  }
  if (kind === 'perUnit' || kind === 'amount') {
    return { why: 'Buildertrend prices it with ' + MARKUP_WORD[kind]
      + ', and a Project 86 estimate line carries a PERCENT markup only. Converting it to an equivalent percent would reproduce '
      + 'Buildertrend’s owner price today and change what the line means the moment a quantity or a cost is edited, so it is not converted' };
  }
  if (isBtBlank(L.markupType)) {
    return { why: 'Buildertrend sent no markup type on it, so how it is priced is unknown. If the Estimates diagnostic below lists '
      + '"markupType" as carried by no record, that key name is wrong in field-map.js — correct it and refresh' };
  }
  return { why: 'Buildertrend prices it with a markup type this sync has no rule for ("' + norm(L.markupType) + '")' };
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

// A line's printed name. The KEY is read once and strictly (field-map's `item`);
// this is a VALUE fallback, not a fallback chain of candidate key names — an
// estimate line has to print something, and Buildertrend really does leave the
// item name blank (a sampled record read "Item —").
function lineDescription(L) {
  if (!isBtBlank(L.item)) return norm(L.item);
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

// Build the P86 line array for a worksheet. Returns { lines, groups, refusals }.
// `refusals` is the list of per-line reasons a markup could not be carried;
// when it is non-empty the caller refuses the whole worksheet.
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
      // real money and keeps num's rounding to cents.
      const qty = numExact(L.quantity);
      const cost = num(L.unitCost);
      if (qty == null) { refusals.push({ line: lineDescription(L), lineId: L.lineId, why: 'its quantity is not a readable number' }); continue; }
      if (cost == null) { refusals.push({ line: lineDescription(L), lineId: L.lineId, why: 'its unit cost is not readable money' }); continue; }
      lines.push({
        id: lineId(L.lineId),
        description: lineDescription(L),
        qty, unit: 'ea', unitCost: cost,
        // A NUMBER, always, and never ''. Blank inherits the section and then
        // the document default, which would make an imported line's price
        // depend on a field nobody set. Buildertrend told us the percent.
        markup: Math.round(mk.pct * 1e6) / 1e6,
        btLineId: L.lineId || null,
      });
    }
  }
  return { lines, groups, refusals };
}

// What P86 will actually charge for these lines, computed by P86's OWN pricing
// code rather than by a formula written here. estimate-totals runs
// js/pricing-pipeline.js, which is the module the estimate editor, the proposal
// preview and the server all run, so this number cannot drift from the one the
// estimator will see.
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
  if (Math.abs(diff) >= EPS) {
    acc.heldBack.push({ field: 'totalDiff', label: 'Total difference', reason: 'money', money: true,
      bt: fmtMoney(ws.ownerTotal), p86: fmtMoney(ws.p86Total), applicable: false,
      note: 'Project 86 prices Buildertrend’s own lines at ' + fmtMoney(ws.p86Total) + ', and Buildertrend says the owner pays '
        + fmtMoney(ws.ownerTotal) + ' — ' + (diff > 0 ? 'up ' : 'down ') + fmtMoney(Math.abs(diff)) + '. '
        + 'That is computed by P86’s own pricing pipeline over the lines this import would write, so it is the difference the estimator would see. '
        + 'It is shown rather than absorbed: check those lines in Buildertrend before taking them.' });
  }
  if (ws.ownerUnreadable) {
    notes.push(ws.ownerUnreadable + ' of this worksheet’s lines sent an owner price that is not readable money, so the comparison above counts them as nothing.');
  }
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
    if (Math.abs(ws.p86Total - ws.ownerTotal) >= EPS) {
      out.notes.push('Project 86 prices these lines at ' + fmtMoney(ws.p86Total) + ' and Buildertrend says the owner pays ' + fmtMoney(ws.ownerTotal)
        + '. The estimate is created with Buildertrend’s own lines and markups; the difference is shown rather than absorbed.');
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
  markupKind, markupPercentFor, buildLines, headerNameFor, lineDescription,
  worksheetTitle, groupWorksheets, WS_FACTS,
  p86EstimateView, linesFingerprint, lifecycleLock, lockSentence, noLineIdSentence,
  p86PricedTotal, btOwnerTotal, btCostTotal, num, numExact, EPS,
};
