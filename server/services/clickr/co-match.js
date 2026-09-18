'use strict';
// ── BUILDERTREND CHANGE ORDERS → PROJECT 86 CHANGE ORDERS ─────────────────
//
// Buildertrend is the source of truth, and P86 mirrors it for change orders
// (owner, 2026-09-13). A Buildertrend change order is matched ONLY inside its
// own job, and only once that Buildertrend job is linked to a P86 job by id
// (jobs.bt_job_id). No job link, no match and no create: the row waits for the
// Jobs tab.
//
// Rungs, inside that one job:
//   0. job_change_orders.bt_co_id — the saved link;
//   1. the CO number with zeros ignored (CO-0003 = CO-3) AND titles that do not
//      disagree — confident. P86 numbered its own change orders on a separate
//      counter, so the same number under a different title is only a candidate;
//   2. an agreeing title under a different number — a candidate, never confident.
// A P86 change order already linked to a Buildertrend change order is never a
// candidate for another one.
//
// What a confident row proposes:
//   title  — a correction (not on an APPLIED change order: terminal in P86).
//   status — FOUR arms, because P86 now has a `pending` of its own:
//            Buildertrend Approved on a P86 draft OR pending is a MONEY
//            correction (an approved change order joins the contract, WIP and
//            pay apps); Buildertrend Pending on a P86 draft, and Buildertrend
//            Draft on a P86 pending, are plain value corrections worth $0 on
//            both sides (money: false — neither is a money press and neither
//            auto-applies in safe mode).
//            A sync never un-approves: Buildertrend Pending/Draft on an approved
//            or applied P86 change order is held back, not applicable.
//   price  — Buildertrend's total price against P86's income, computed by the
//            CO editor's own pipeline. A money correction, offered only when P86
//            can actually reach that price (withPrice below proves it).
//   cost   — Buildertrend's builder cost against P86's line cost. A money
//            correction only when the price stays put (withCost proves it).
// A Buildertrend $0 is "nothing entered": it never erases a P86 figure.
//
// withPrice / withCost are the ONLY way a price or cost is written — the matcher
// offers exactly what the writer (sync-apply.js) will then do, and both verify
// the result through services/money/change-order-totals.js to the cent.

const match = require('./bt-match');
const coMoney = require('../money/change-order-totals');
const pricing = require('../../../js/pricing-pipeline.js');
const { coNumberKey } = require('../job-financials');

const { isBtBlank, isP86Blank, textKey, parseMoney, fmtMoney, compareField, compareMoney, nameEvidence } = match;

const EPS = 0.005;
const str = (v) => (v == null ? '' : String(v));
const norm = (v) => str(v).trim().replace(/\s+/g, ' ');

function parseJsonish(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return v;
}

function btCoState(text) {
  const t = textKey(text);
  if (t === 'approved') return 'approved';
  if (t === 'pending') return 'pending';
  if (t === 'draft') return 'draft';
  return null;
}

// A calendar day for approved_at: noon UTC, so no timezone moves the day.
function approvalInstant(v) {
  const day = match.dateKey(v);
  return day ? day + 'T12:00:00.000Z' : null;
}

function contentIndexes(lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (l && typeof l === 'object' && !Array.isArray(l) && l.section !== '__section_header__') out.push(i);
  });
  return out;
}

function money(data) {
  try {
    const m = coMoney.changeOrderMoney(data || {});
    return Number.isFinite(m.income) && Number.isFinite(m.costs) ? m : null;
  } catch (e) {
    return null;
  }
}

function cloneData(data) {
  const d = Object.assign({}, data || {});
  d.lines = Array.isArray(d.lines) ? d.lines.map((l) => (l && typeof l === 'object' && !Array.isArray(l) ? Object.assign({}, l) : l)) : [];
  return d;
}

// The data blob with its price set to `price`, or null when P86's pipeline
// cannot land on it to the cent. One content line: that line's promised price.
// Several: a client price (targetPrice), which re-scales the unpromised lines.
function withPrice(data, price) {
  if (!Number.isFinite(price)) return null;
  const d = cloneData(data);
  const idx = contentIndexes(d.lines);
  if (!idx.length) return null;
  if (idx.length === 1) {
    const l = d.lines[idx[0]];
    const q = Number(l.qty);
    if (!(q > 0)) return null;
    l.unitSell = price / q;
  } else {
    d.targetPrice = price;
  }
  const m = money(d);
  return m && Math.abs(m.income - price) < EPS ? d : null;
}

// The data blob with its cost set to `cost` and its price unchanged, or null.
// One content line: its price is promised first (at what it sells for now), then
// its unit cost is set. Several: only when every line already carries a
// promised price, so a cost change cannot move the price; unit costs scale.
function withCost(data, cost) {
  if (!Number.isFinite(cost)) return null;
  const before = money(data);
  if (!before) return null;
  const d = cloneData(data);
  const idx = contentIndexes(d.lines);
  if (!idx.length) return null;
  if (idx.length === 1) {
    const l = d.lines[idx[0]];
    const q = Number(l.qty);
    if (!(q > 0)) return null;
    if (!pricing.sellLocked(l)) l.unitSell = pricing.lineMoney(l, d.lines, d).sell / q;
    l.unitCost = cost / q;
    l.costPending = false;
  } else {
    if (!idx.every((i) => pricing.sellLocked(d.lines[i]))) return null;
    if (Math.abs(before.costs) < EPS) return null;
    const factor = cost / before.costs;
    for (const i of idx) {
      d.lines[i].unitCost = Number(d.lines[i].unitCost || 0) * factor;
      d.lines[i].costPending = false;
    }
  }
  const m = money(d);
  return m && Math.abs(m.costs - cost) < EPS && Math.abs(m.income - before.income) < EPS ? d : null;
}

function p86CoView(r) {
  const data = parseJsonish(r.data) || {};
  const m = money(data);
  return {
    id: r.id, jobId: r.job_id, coNumber: str(r.co_number), title: str(data.title), status: str(r.status),
    locked: r.is_locked === true || r.is_locked === 1, linkedNode: !isP86Blank(r.linked_node_id), btId: norm(r.bt_co_id),
    data, money: m, incomeText: m ? fmtMoney(m.income) : '', costsText: m ? fmtMoney(m.costs) : '',
    costPending: (Array.isArray(data.lines) ? data.lines : []).some((l) => l && l.costPending),
  };
}

function coCand(v, rungs) {
  return { id: v.id, coNumber: v.coNumber, title: v.title, status: v.status + (v.locked ? ', locked' : ''), rungs: rungs.slice() };
}

function titlesDisagree(a, b) {
  if (isBtBlank(a) || isP86Blank(b)) return false;
  if (textKey(a) === textKey(b)) return false;
  return nameEvidence(a, b) === 'disagree';
}

function coProposals(bt, v) {
  const acc = { corrections: [], btBlank: [], heldBack: [], flags: [] };
  const notes = [];
  const applied = v.status === 'applied';
  const LOCKED = 'Approved and locked in P86 — applying still writes it, because Buildertrend is the source of truth.';

  // TITLE
  if (applied) {
    if (!isBtBlank(bt.title) && norm(bt.title) !== norm(v.title)) {
      acc.heldBack.push({ field: 'title', label: 'Title', reason: 'applied', bt: norm(bt.title), p86: v.title, applicable: false,
        note: 'An applied change order cannot be edited in P86.' });
    }
  } else {
    compareField(acc, { field: 'title', label: 'Title', bt: bt.title, p86: v.title, same: (a, b) => textKey(a) === textKey(b) });
  }

  // STATUS
  const bs = btCoState(bt.statusText);
  if (isBtBlank(bt.statusText)) {
    // Buildertrend says nothing about this change order's status. Nothing shown.
  } else if (!bs) {
    // Anything that is not Approved, Pending or Draft — DECLINED above all. It
    // used to be a bare note, so a change order Buildertrend declined while P86
    // counts it in the contract went by with nothing flagged and money standing.
    const said = norm(bt.statusText);
    if (v.status === 'approved' || v.status === 'applied') {
      acc.heldBack.push({ field: 'status', label: 'Status', reason: 'money', bt: said, p86: v.status, applicable: false,
        note: 'Buildertrend says ' + said + '; P86 counts this change order in the contract. A sync never un-approves — change it in P86.' });
    } else if (v.status === 'draft' || v.status === 'pending') {
      acc.flags.push({ field: 'status', label: 'Status',
        text: 'Buildertrend says ' + said + ', which is not a P86 change-order status. Not mapped — P86 keeps this change order '
          + (v.status === 'pending' ? 'pending approval' : 'as a draft') + ' and counts nothing.' });
    } else {
      notes.push('Buildertrend status "' + said + '" is not Approved, Pending or Draft, so status was not compared.');
    }
  } else if (bs === 'approved' && (v.status === 'draft' || v.status === 'pending')) {
    // From EITHER unsigned status. The from/p86Value carry v.status, never the
    // literal 'draft': sync-apply.js uses p86Value as the optimistic race
    // guard on the UPDATE, so a hardcoded 'draft' would make every approval of
    // a pending change order silently stale.
    if (v.linkedNode) {
      acc.heldBack.push({ field: 'status', label: 'Status', reason: 'money', bt: 'Approved', p86: v.status, applicable: false,
        note: 'This change order is linked to a Site Plan node. Approve it in P86 so its lines move to the node.' });
    } else {
      const day = match.dateKey(bt.statusChangedDate);
      acc.corrections.push({ field: 'status', label: 'Status', kind: 'value', money: true, from: v.status, to: 'approved', value: 'approved', p86Value: v.status,
        note: 'An approved change order joins the contract (WIP, backlog, pay applications) and is locked.' + (day ? ' Approval date: ' + day + ', from Buildertrend.' : '') });
    }
  } else if (bs === 'pending' && v.status === 'draft') {
    // $0 both sides: a pending change order is outside every money allow-list,
    // exactly as a draft is. money: false keeps it out of the money confirm
    // sentence on the page AND out of safe mode (isSafeCorrection is jobs/
    // startDate only), so it stays a deliberate press either way.
    acc.corrections.push({ field: 'status', label: 'Status', kind: 'value', money: false, from: 'draft', to: 'pending', value: 'pending', p86Value: 'draft',
      note: 'Pending approval: sent to the owner, nobody has signed it. It stays editable and it counts nothing — no contract, WIP, backlog or pay-application figure moves.' });
  } else if (bs === 'draft' && v.status === 'pending') {
    acc.corrections.push({ field: 'status', label: 'Status', kind: 'value', money: false, from: 'pending', to: 'draft', value: 'draft', p86Value: 'pending',
      note: 'Buildertrend has this change order back at draft. Both statuses count nothing, so no money moves either way.' });
  } else if (bs !== 'approved' && (v.status === 'approved' || v.status === 'applied')) {
    acc.heldBack.push({ field: 'status', label: 'Status', reason: 'money', bt: bs === 'pending' ? 'Pending' : 'Draft', p86: v.status, applicable: false,
      note: 'A sync never un-approves a change order. If Buildertrend is right, revert it to draft in P86.' });
  }

  // PRICE and COST
  if (!v.money) {
    notes.push('P86\'s total for this change order could not be computed, so price and cost were not compared.');
    return { acc, notes };
  }
  const price = parseMoney(bt.totalPrice);
  const priceOk = price.kind === 'value' && !applied && withPrice(v.data, price.value) != null;
  compareMoney(acc, { field: 'price', label: 'Price', bt: bt.totalPrice, p86: v.money.income, correction: priceOk,
    correctionNote: (contentIndexes(v.data.lines).length === 1 ? 'Sets the line\'s price.' : 'Sets a client price; P86 re-scales the line prices to reach it.') + (v.locked ? ' ' + LOCKED : ''),
    p86Note: applied ? 'An applied change order cannot be edited in P86.' : 'P86 cannot reach this price with this change order\'s lines — change them in the change-order editor.' });
  const cost = parseMoney(bt.builderCost);
  const costOk = cost.kind === 'value' && !applied && withCost(v.data, cost.value) != null;
  compareMoney(acc, { field: 'cost', label: 'Cost', bt: bt.builderCost, p86: v.money.costs, correction: costOk,
    correctionNote: 'Sets what the work costs; the price stays ' + v.incomeText + '.' + (v.costPending ? ' Replaces a placeholder cost.' : '') + (v.locked ? ' ' + LOCKED : ''),
    p86Note: applied ? 'An applied change order cannot be edited in P86.' : 'Not every line on this P86 change order carries a fixed price, so changing its cost would move its price too. Enter the cost per line in the change-order editor.' });
  return { acc, notes };
}

function row(bt, cls, extra) {
  return Object.assign({ bt, class: cls, rung: null, p86: null, corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [] }, extra || {});
}

function jobLabel(j) {
  return [j.jobNumber, j.title].filter((x) => !isP86Blank(x)).join(' ') || j.id;
}

// btValues: readChangeOrder() records. p86: { jobs: [{ id, bt_job_id, data: { jobNumber, title }, legacy_cos }], coRows }.
function matchChangeOrders(btValues, p86) {
  const jobByBt = new Map();
  for (const j of p86.jobs || []) {
    const k = norm(j.bt_job_id);
    if (k) jobByBt.set(k, { id: j.id, jobNumber: str(j.data && j.data.jobNumber), title: str(j.data && (j.data.title || j.data.name)), legacy: parseJsonish(j.legacy_cos) });
  }
  const views = (p86.coRows || []).map(p86CoView);
  const byJob = new Map();
  const byBtId = new Map();
  for (const v of views) {
    if (!byJob.has(v.jobId)) byJob.set(v.jobId, []);
    byJob.get(v.jobId).push(v);
    if (v.btId) byBtId.set(v.btId, v);
  }

  const rows = btValues.map((b, index) => {
    const bt = Object.assign({ index, scope: 'open', raw: [b.coNumber, b.title].filter((x) => !isBtBlank(x)).map(norm).join(' '),
      priceText: parseMoney(b.totalPrice).kind === 'value' ? fmtMoney(parseMoney(b.totalPrice).value) : '$0.00',
      costText: parseMoney(b.builderCost).kind === 'value' ? fmtMoney(parseMoney(b.builderCost).value) : '$0.00' }, b);
    const btId = norm(b.btId);
    if (!btId) return row(bt, 'refused', { notes: ['Buildertrend sent this change order without an id.'] });
    if (b.isDeleted) return row(bt, 'refused', { notes: ['Deleted in Buildertrend.'] });
    const job = jobByBt.get(norm(b.jobId));
    if (!job) {
      return row(bt, 'refused', { waitingOnJob: true,
        notes: ['Its Buildertrend job' + (isBtBlank(b.jobName) ? '' : ' "' + norm(b.jobName) + '"') + ' is not linked to a P86 job yet. Link or create the job on the Jobs tab, then refresh.'] });
    }
    const jobInfo = { id: job.id, label: jobLabel(job) };
    const onJob = byJob.get(job.id) || [];

    const linked = byBtId.get(btId);
    if (linked) {
      if (linked.jobId !== job.id) {
        return row(bt, 'refused', { job: jobInfo,
          notes: ['The P86 change order linked to this one (' + (linked.coNumber || linked.id) + ') is on a different P86 job than Buildertrend\'s job, so nothing is proposed. Move or unlink it in P86.'] });
      }
      const { acc, notes } = coProposals(b, linked);
      return row(bt, acc.corrections.length ? 'conflict' : 'matched', Object.assign({ rung: 'Buildertrend ID', job: jobInfo, notes, p86: p86Out(linked), btStatusDue: match.btStatusDue(b.statusText, linked.data && linked.data.btStatus) }, acc));
    }

    const open = onJob.filter((v) => !v.btId);
    const numKey = isBtBlank(b.coNumber) ? '' : coNumberKey(b.coNumber);
    const byNumber = numKey ? open.filter((v) => coNumberKey(v.coNumber) === numKey) : [];
    if (byNumber.length === 1 && !titlesDisagree(b.title, byNumber[0].title)) {
      const v = byNumber[0];
      const { acc, notes } = coProposals(b, v);
      return row(bt, acc.corrections.length ? 'conflict' : 'matched', Object.assign({ rung: 'CO number', job: jobInfo, notes, p86: p86Out(v), btStatusDue: match.btStatusDue(b.statusText, v.data && v.data.btStatus) }, acc));
    }
    if (byNumber.length) {
      return row(bt, 'ambiguous', { job: jobInfo, candidates: byNumber.map((v) => coCand(v, ['CO number'])),
        notes: [byNumber.length > 1 ? 'Several P86 change orders on this job carry this number.'
          : 'Same number, different title. P86 numbered its own change orders, so link it only if it is the same change order.'] });
    }
    const byTitle = isBtBlank(b.title) ? [] : open.filter((v) => !isP86Blank(v.title) && !titlesDisagree(b.title, v.title));
    if (byTitle.length) {
      return row(bt, 'ambiguous', { job: jobInfo, candidates: byTitle.map((v) => coCand(v, ['title'])),
        notes: ['A P86 change order on this job has a similar title under a different number. Link it only if it is the same change order.'] });
    }
    const legacy = Array.isArray(job.legacy) ? job.legacy.length : 0;
    const out = row(bt, 'new', { job: jobInfo });
    if (legacy && !onJob.length) {
      out.createBlocked = 'This job\'s ' + legacy + ' change order' + (legacy === 1 ? '' : 's') + ' still live in its old per-job list. Creating the first change order in the table would hide ' + (legacy === 1 ? 'it' : 'them') + ' from WIP, so nothing is created until they are moved into the change-order table.';
      out.notes.push(out.createBlocked);
    }
    return out;
  });

  // Two Buildertrend change orders landing confidently on one P86 change order.
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
      r.candidates = [coCand(views.find((v) => v.id === r.p86.id), [r.rung])];
      r.notes.push(group.length + ' Buildertrend change orders land on this same P86 change order, so none is matched and nothing is proposed.');
      r.class = 'ambiguous';
      r.rung = null;
      r.p86 = null;
      r.corrections = []; r.btBlank = []; r.heldBack = []; r.flags = [];
    }
  }
  return rows;
}

function p86Out(v) {
  return { id: v.id, coNumber: v.coNumber, title: v.title, status: v.status + (v.locked ? ', locked' : ''), incomeText: v.incomeText, costsText: v.costsText };
}

// P86 change orders no Buildertrend change order reached — only on P86 jobs
// whose Buildertrend job sent at least one change order in this read (Clickr's
// change-order dataset covers open jobs only, so a job it sent nothing for says
// nothing about its change orders).
function notInBuildertrend(rows, btValues, p86) {
  const reached = new Set();
  for (const r of rows) {
    if (r.p86) reached.add(r.p86.id);
    for (const c of r.candidates || []) reached.add(c.id);
  }
  const btJobs = new Set(btValues.map((b) => norm(b.jobId)).filter(Boolean));
  const jobs = new Map();
  for (const j of p86.jobs || []) {
    if (norm(j.bt_job_id) && btJobs.has(norm(j.bt_job_id))) jobs.set(j.id, jobLabel({ id: j.id, jobNumber: str(j.data && j.data.jobNumber), title: str(j.data && (j.data.title || j.data.name)) }));
  }
  const btIds = new Set(btValues.map((b) => norm(b.btId)).filter(Boolean));
  const listed = [];
  let notListed = 0;
  for (const v of (p86.coRows || []).map(p86CoView)) {
    if (reached.has(v.id)) continue;
    if (!jobs.has(v.jobId)) { notListed++; continue; }
    listed.push({ id: v.id, coNumber: v.coNumber, title: v.title, status: v.status + (v.locked ? ', locked' : ''), client: '', jobLabel: jobs.get(v.jobId),
      linkedGone: v.btId && !btIds.has(v.btId) ? true : undefined });
  }
  return { rows: listed, notListed };
}

module.exports = { matchChangeOrders, notInBuildertrend, withPrice, withCost, btCoState, approvalInstant, p86CoView, contentIndexes, money };
