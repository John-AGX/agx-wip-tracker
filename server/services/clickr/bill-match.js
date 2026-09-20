'use strict';
// ── BUILDERTREND BILLS → PROJECT 86 VENDOR BILLS ──────────────────────────
//
// Step 5 of the reconcile: P86 mirrors Buildertrend's accounts payable. Same
// shape as po-match.js — a Buildertrend bill is matched only inside its own
// job, once that job is linked to a P86 job by id:
//   0. job_vendor_bills.bt_bill_id — the saved link;
//   1. the job PLUS the bill number — the vendor's invoice number, compared
//      literally (see billNumberKey: no zero-stripping, and a P86 auto-number
//      is not a key at all).
// There is no third rung. A bill has no title worth matching on: two bills from
// one vendor in one month routinely carry the same words, and guessing between
// them would write bt_bill_id onto the wrong payable. Two candidates on one
// number, or two Buildertrend bills landing on one P86 bill, are AMBIGUOUS and
// propose nothing.
//
// WHAT IS HELD BACK, AND WHY IT IS NOT NEGOTIABLE
//   amount            — the number P86 owes this vendor. It feeds the PO's
//                       %-billed rollup, the job accrual and AP aging, so it is
//                       a held-back item a person ticks, never a correction and
//                       never something "Link confident matches" sweeps in. On a
//                       PAID or VOID bill it is settled: shown, not applicable.
//   amount paid,      — Buildertrend's settlement figures. P86 stores NEITHER on
//   remaining balance   a bill: its status is the whole payment story (a paid
//                       bill is paid in full; any other status has paid nothing).
//                       They are compared against what the P86 status implies and
//                       held back for review — never applied, because applying
//                       them would mean inventing columns P86 does not have.
//   status            — Buildertrend's payment word, FORWARD only along
//                       open → approved → paid. A sync NEVER un-approves and
//                       NEVER un-pays. 'void' is deliberately off that ladder: a
//                       sync neither voids a bill nor brings one back.
//   bill number       — a MATCH KEY. It is never corrected. It is OFFERED (a
//                       held-back item, ticked on purpose) only where P86 holds
//                       an auto-assigned BILL-#### , which means "no vendor
//                       invoice number recorded" rather than a different one.
//
// THE PURCHASE ORDER is deterministic, not guessed: Buildertrend names its
// related purchase order ids and P86's purchase orders already carry bt_po_id,
// so exactly one named id that P86 has imported ON THE SAME JOB resolves to
// exactly one P86 purchase order. More than one named id, an id P86 has not
// imported, or one resolving to a purchase order on another job sets nothing
// and says why. A bill that already has a DIFFERENT P86 purchase order is shown,
// never moved: re-pointing a bill moves its money from one commitment to another.
//
// THE VENDOR comes from po-match's resolveSub/normalizeVendorName — the same
// exact-normalized-name-to-exactly-one-sub-of-this-organization rule the PO
// reconcile uses. A blank P86 vendor is filled; a different one is shown only.
//
// DELETED AND DUPLICATED records are REFUSED outright and never created. Unlike
// a recalled purchase order, a deleted or duplicated bill is not a live record
// with a withdrawn approval — it is a record that is gone, so nothing is read
// off it and no correction is proposed FROM it. When a P86 bill is linked to
// one, the refusal NAMES that P86 bill (row.p86Linked, which is informational
// and is NOT row.p86, so no apply path can reach it) so a person can decide.
// A sync never deletes and never voids a P86 bill.

const match = require('./bt-match');
const poMatch = require('./po-match');

const { isBtBlank, isP86Blank, textKey, parseMoney, fmtMoney, compareField } = match;

const EPS = 0.005;
const str = (v) => (v == null ? '' : String(v));
const norm = (v) => str(v).trim().replace(/\s+/g, ' ');

// P86's bill lifecycle: open (received, unpaid) -> approved (OK to pay) -> paid.
// VOID IS NOT ON THIS LADDER ON PURPOSE. It means "discarded", it is a P86
// decision about a P86 record, and neither direction is a thing a Buildertrend
// payment status can assert. RANK['void'] is undefined, which is what makes
// every comparison below refuse to compare it.
const RANK = { open: 0, approved: 1, paid: 2 };
const STATUS_LABEL = { open: 'Open', approved: 'Approved', paid: 'Paid', void: 'Void' };

// Buildertrend's payment word -> P86's, or null for "P86 has no word for this".
//
// ONLY TWO MAP. 'Paid' is P86's 'paid'. 'Unpaid' (and the ways Buildertrend
// writes "nothing has been paid") is P86's 'open', which is the floor: a bill
// P86 already has open agrees with it and a bill past it is never pulled back,
// so this arm never produces a correction — it exists so an Unpaid bill against
// a P86 approved one is recognised as BUILDERTREND being behind rather than as
// an unmapped word.
//
// NOTHING MAPS TO 'approved'. P86's 'approved' means a person at AGX said this
// invoice is OK to pay. No payment status in Buildertrend asserts that, so a
// sync must not mint it — 'approved' stays a P86 decision.
// NOTHING MAPS TO 'void' either: see RANK above.
// 'Partially Paid' has no P86 word at all (P86 stores no part-payment on a
// bill) and deliberately falls through to null, so it is HELD BACK naming
// itself instead of being rounded to 'paid' or to 'open'.
//
// textKey lowercases and collapses punctuation, so 'Partially Paid' becomes
// 'partially paid'. The comparisons below are EXACT for that reason: a
// .includes('paid') would swallow it, and a .endsWith('paid') would too.
function btBillStatus(paymentStatusText) {
  const t = textKey(paymentStatusText);
  if (t === 'paid' || t === 'paid in full') return 'paid';
  if (t === 'unpaid' || t === 'not paid' || t === 'none' || t === 'no payments' || t === 'open') return 'open';
  return null;
}

// P86 auto-assigns BILL-#### when a bill is entered with no vendor invoice
// number (routes/bill-routes.js nextBillNumber). It is a placeholder, NOT a
// number to match on: without this a Buildertrend bill numbered "7" could match
// P86's BILL-0007, which is a bill whose vendor number nobody recorded.
const AUTO_BILL_NUMBER = /^\s*bill-\d+\s*$/i;

// A vendor's invoice number is an OPAQUE identifier. Unlike a Buildertrend PO
// number (per job, zero-padded, so 0003 is PO-3) it is whatever the vendor
// prints, so leading zeros are NOT stripped: "0042" and "42" may well be two
// different invoices from the same vendor, and a false match here writes
// bt_bill_id onto the wrong payable. Case, spacing and punctuation are all a
// vendor's own formatting and are collapsed. '' means "no usable number", which
// can never match anything.
function billNumberKey(v) {
  const s = norm(v);
  if (!s || isBtBlank(s) || AUTO_BILL_NUMBER.test(s)) return '';
  return textKey(s).replace(/\s+/g, '');
}

function parseJsonish(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return v;
}

// A P86 DATE column as a calendar day. node-pg parses type 1082 into a Date at
// LOCAL midnight, so the local Y-M-D IS the stored day; toISOString() would
// shift it a day west of UTC. Text (the test engine, and a data-blob string)
// goes through bt-match's dateKey, which is written-Y-M-D and never shifts.
function dayKey(v) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
  }
  return match.dateKey(v);
}

function p86BillView(r) {
  const data = parseJsonish(r.data) || {};
  return {
    id: r.id, jobId: r.job_id, billNumber: str(r.bill_number), status: str(r.status),
    amount: Number(r.amount) || 0,
    billDate: dayKey(r.bill_date), dueDate: dayKey(r.due_date),
    poId: r.po_id || null, poNumber: str(r.po_number),
    subId: r.sub_id || null, subName: str(r.sub_name),
    btId: norm(r.bt_bill_id), data, description: str(data.description),
  };
}

function billCand(v, rungs) {
  return { id: v.id, billNumber: v.billNumber, title: v.description, status: v.status + ' · ' + fmtMoney(v.amount), rungs: rungs.slice() };
}

function p86Out(v) {
  return { id: v.id, billNumber: v.billNumber, title: v.description, status: STATUS_LABEL[v.status] || v.status,
    amountText: fmtMoney(v.amount), subName: v.subName, poNumber: v.poNumber };
}

// Buildertrend's related purchase order ids against P86's imported ones. Never a
// guess: a P86 purchase order is reached ONLY through the bt_po_id it already
// carries, and only on the same P86 job as the bill.
function resolvePo(poByBt, bt, jobId) {
  const ids = (bt.relatedPurchaseOrderIds || []).map(norm).filter(Boolean);
  if (!ids.length) return { po: null, why: null };
  if (ids.length > 1) {
    return { po: null, why: 'Buildertrend names ' + ids.length + ' purchase orders on this bill (' + ids.join(', ')
      + '). A P86 bill belongs to exactly one, so none is set — split the bill in Buildertrend, or set the purchase order in P86.' };
  }
  const po = poByBt.get(ids[0]);
  if (!po) {
    return { po: null, why: 'Buildertrend purchase order ' + ids[0] + ' is not in P86 yet, so no purchase order is set on this bill. '
      + 'Create or link it on the Purchase orders tab, then refresh.' };
  }
  if (po.jobId !== jobId) {
    return { po: null, why: 'Buildertrend purchase order ' + ids[0] + ' is on a different P86 job than this bill, so none is set.' };
  }
  return { po, why: null };
}

function poLabel(po) {
  return [po.poNumber, po.title].filter((x) => !isP86Blank(x)).join(' ') || po.id;
}

function billProposals(bt, v, ctx) {
  const acc = { corrections: [], btBlank: [], heldBack: [], flags: [] };
  const notes = [];
  const voided = v.status === 'void';
  const settled = voided || v.status === 'paid';
  const p86StatusLabel = STATUS_LABEL[v.status] || v.status;
  const voidWhy = 'P86 has voided this bill. A sync never brings a voided bill back — reopen it in P86 first if Buildertrend is right.';

  // STATUS — forward only, and only along open -> approved -> paid.
  const bs = btBillStatus(bt.paymentStatusText);
  if (!bs) {
    if (!isBtBlank(bt.paymentStatusText)) {
      acc.heldBack.push({ field: 'status', label: 'Status', reason: 'review', bt: norm(bt.paymentStatusText), p86: p86StatusLabel, applicable: false,
        note: 'Buildertrend payment status "' + norm(bt.paymentStatusText) + '" has no Project 86 word, so nothing is proposed. '
          + 'P86 records a bill as open, approved, paid or void and keeps no part-payment figure on one. Set it in P86 if it should move.' });
    }
  } else if (RANK[v.status] == null) {
    acc.heldBack.push({ field: 'status', label: 'Status', reason: 'review', bt: STATUS_LABEL[bs], p86: p86StatusLabel, applicable: false,
      note: voided ? voidWhy : 'P86 status "' + v.status + '" is not a bill status, so status was not compared.' });
  } else if (RANK[bs] > RANK[v.status]) {
    acc.corrections.push({ field: 'status', label: 'Status', kind: 'value', money: true,
      from: p86StatusLabel, to: STATUS_LABEL[bs], value: bs, p86Value: v.status,
      note: 'Buildertrend has this bill ' + STATUS_LABEL[bs].toLowerCase() + '. Marking it paid in P86 settles the payable and drops it off AP aging.' });
  } else if (RANK[bs] < RANK[v.status]) {
    acc.heldBack.push({ field: 'status', label: 'Status', reason: 'money', bt: STATUS_LABEL[bs], p86: p86StatusLabel, applicable: false,
      note: 'A sync never un-approves and never un-pays a bill. If Buildertrend is right, change it in P86.' });
  }

  // AMOUNT — held back, always. Never a correction, so no "apply everything"
  // press and no safe sweep can move it; a person ticks it by name.
  const m = parseMoney(bt.amount);
  if (m.kind === 'blank') {
    if (Math.abs(v.amount) >= EPS) acc.btBlank.push({ field: 'amount', label: 'Amount', p86: fmtMoney(v.amount), zero: !!m.zero, money: true });
  } else if (m.kind !== 'value') {
    acc.heldBack.push({ field: 'amount', label: 'Amount', reason: 'unparsed', bt: '(not readable money)', p86: fmtMoney(v.amount), applicable: false, money: true,
      note: 'Buildertrend sent an amount that is not readable money, so it was not compared.' });
  } else if (Math.abs(m.value - v.amount) >= EPS) {
    acc.heldBack.push({ field: 'amount', label: 'Amount', reason: 'money', money: true,
      bt: fmtMoney(m.value), p86: fmtMoney(v.amount), value: m.value, p86Value: v.amount, applicable: !settled,
      note: settled
        ? (voided ? voidWhy : 'P86 has this bill paid, so its amount is settled and a sync does not change it. Correct it in P86 if Buildertrend is right.')
        : 'Tick it to take Buildertrend’s amount. This is the figure the purchase order’s %-billed, the job accrual and AP aging all count, '
          + 'so it is never applied by "Link confident matches".' });
  }

  // AMOUNT PAID and REMAINING BALANCE — Buildertrend's settlement figures.
  //
  // WHAT THEY ARE TESTED AGAINST IS BUILDERTREND'S OWN STORY, not P86's. A bill
  // Buildertrend reports as Paid for $950 against a P86 bill of $900 does not
  // need three items saying the same thing: the AMOUNT item already carries the
  // $50 and the STATUS item already carries the payment word. So these two fire
  // only when BUILDERTREND'S OWN figures disagree with the payment status
  // Buildertrend itself reports — a PART payment, which is precisely the state
  // P86 has no way to record. Measured any other way they were noise on every
  // ordinary row, and noise on a money page is how a real one gets missed.
  //
  // Review only either way: there is no P86 column to apply them to, and
  // inventing one would be a parallel design rather than this reconcile.
  const btAmount = m.kind === 'value' ? m.value : (m.kind === 'blank' ? 0 : null);
  // What Buildertrend's OWN payment word implies about its OWN amount, as the
  // LIST of figures consistent with it. A word P86 maps has exactly ONE. A word
  // it does NOT map has no reference point at all, so BOTH ENDS of the range are
  // consistent: nothing settled and settled in full are the two ordinary states
  // of a bill, and only a figure strictly between them is the part payment these
  // two items exist to show. Measured as "any non-zero figure" instead, the
  // remaining balance — which on a bill nobody has paid IS the full amount —
  // fired on the most ordinary row there is, under a note asserting a part
  // payment that was not there. An unreadable Buildertrend amount keeps [0]:
  // with no total there is no second end to compute, so that arm is unchanged.
  const both = btAmount == null ? [0] : [0, btAmount];
  const btPaidDue = btAmount == null ? [0] : (bs === 'paid' ? [btAmount] : bs === 'open' ? [0] : both);
  const btOweDue = btAmount == null ? [0] : (bs === 'paid' ? [0] : bs === 'open' ? [btAmount] : both);
  const p86Paid = v.status === 'paid' ? v.amount : 0;
  const p86Remaining = settled ? 0 : v.amount;
  const settlement = (field, label, btVal, consistentWith, p86Implied, what) => {
    const s = parseMoney(btVal);
    if (s.kind === 'range' || s.kind === 'unparsed') {
      acc.heldBack.push({ field, label, reason: 'unparsed', bt: '(not readable money)', p86: fmtMoney(p86Implied), applicable: false, money: true,
        note: 'Buildertrend sent a ' + what + ' figure that is not readable money, so it was not compared.' });
      return;
    }
    const value = s.kind === 'value' ? s.value : 0;
    if (consistentWith.some((c) => Math.abs(value - c) < EPS)) return;
    acc.heldBack.push({ field, label, reason: 'money', bt: fmtMoney(value), p86: fmtMoney(p86Implied), applicable: false, money: true,
      note: 'Buildertrend reports ' + fmtMoney(value) + ' ' + what + ' on this bill while calling it "'
        + (isBtBlank(bt.paymentStatusText) ? 'blank' : norm(bt.paymentStatusText)) + '", so it is carrying a part payment. '
        + 'P86 keeps NO ' + what + ' figure on a bill — its status is the whole payment story, and it reads '
        + p86StatusLabel.toLowerCase() + ' at ' + fmtMoney(p86Implied) + '. Shown for review and never applied; QuickBooks is the cost record.' });
  };
  settlement('amountPaid', 'Amount paid', bt.amountPaid, btPaidDue, p86Paid, 'paid');
  settlement('remainingBalance', 'Remaining balance', bt.remainingBalance, btOweDue, p86Remaining, 'still owing');

  // PURCHASE ORDER — deterministic through bt_po_id, or nothing.
  const rp = resolvePo(ctx.poByBt, bt, v.jobId);
  if (rp.why) notes.push(rp.why);
  if (rp.po) {
    if (!v.poId) {
      if (voided) {
        acc.heldBack.push({ field: 'po', label: 'Purchase order', reason: 'locked', bt: poLabel(rp.po), p86: '', applicable: false, note: voidWhy });
      } else {
        acc.corrections.push({ field: 'po', label: 'Purchase order', kind: 'fill', from: '', to: poLabel(rp.po), value: rp.po.id, p86Value: null,
          note: 'Buildertrend names this purchase order on the bill and P86 already carries its Buildertrend id, so the link is exact. '
            + 'It is what makes this bill count toward that purchase order’s %-billed.' });
      }
    } else if (String(v.poId) !== String(rp.po.id)) {
      acc.heldBack.push({ field: 'po', label: 'Purchase order', reason: 'money', bt: poLabel(rp.po), p86: v.poNumber || String(v.poId), applicable: false,
        note: 'A sync never moves a bill to a different purchase order: that moves its money from one commitment to another. Change it in P86 if Buildertrend is right.' });
    }
  }

  // VENDOR — po-match's rule, unchanged: exactly one sub of THIS organization
  // whose normalized name equals Buildertrend's.
  const rs = poMatch.resolveSub(ctx.subs, bt.vendorName);
  const sameVendor = v.subId && v.subName && poMatch.resolveSub([{ id: v.subId, name: v.subName }], bt.vendorName).sub;
  if (rs.why && !sameVendor) notes.push(rs.why);
  if (rs.sub) {
    if (!v.subId) {
      if (voided) acc.heldBack.push({ field: 'sub', label: 'Vendor', reason: 'locked', bt: rs.sub.name, p86: '', applicable: false, note: voidWhy });
      else acc.corrections.push({ field: 'sub', label: 'Vendor', kind: 'fill', from: '', to: rs.sub.name, value: rs.sub.id, p86Value: null });
    } else if (String(v.subId) !== String(rs.sub.id)) {
      acc.heldBack.push({ field: 'sub', label: 'Vendor', reason: 'review', bt: rs.sub.name, p86: v.subName || String(v.subId), applicable: false,
        note: 'A different vendor is never set by a sync: a bill’s vendor is who gets paid. Change it in P86 if Buildertrend is right.' });
    }
  }

  // BILL NUMBER — the MATCH KEY, so it is never corrected. Offered, ticked on
  // purpose, only where P86 holds an auto-assigned BILL-#### or nothing, which
  // both mean "no vendor invoice number recorded" rather than a different one.
  const btNum = isBtBlank(bt.billNumber) ? '' : norm(bt.billNumber);
  if (btNum && !voided && norm(v.billNumber) !== btNum) {
    if (billNumberKey(v.billNumber) === '') {
      acc.heldBack.push({ field: 'billNumber', label: 'Bill number', reason: 'review', bt: btNum, p86: v.billNumber || '', value: btNum, p86Value: v.billNumber, applicable: true,
        note: 'P86 has no vendor invoice number on this bill' + (v.billNumber ? ' (' + v.billNumber + ' is P86’s own placeholder)' : '')
          + '. Tick it to record Buildertrend’s. A bill number is a match key, so it is offered rather than corrected.' });
    } else {
      acc.heldBack.push({ field: 'billNumber', label: 'Bill number', reason: 'review', bt: btNum, p86: v.billNumber, applicable: false,
        note: 'P86 and Buildertrend carry different vendor invoice numbers. A bill number is a MATCH KEY, never something a sync corrects — '
          + 'if they are the same bill, fix the number on whichever side is wrong.' });
    }
  }

  // DESCRIPTION and the two DATES — ordinary corrections on a live bill; a void
  // one is shown and left alone.
  if (!voided) {
    compareField(acc, { field: 'description', label: 'Description', bt: bt.title, p86: v.description, same: (a, b) => textKey(a) === textKey(b) });
    const inv = match.dateKey(bt.invoiceDate);
    if (inv) compareField(acc, { field: 'billDate', label: 'Invoice date', bt: inv, p86: v.billDate, same: (a, b) => dayKey(a) === dayKey(b), literal: () => true });
    const due = match.dateKey(bt.dueDate);
    if (due) compareField(acc, { field: 'dueDate', label: 'Due date', bt: due, p86: v.dueDate, same: (a, b) => dayKey(a) === dayKey(b), literal: () => true });
  } else if (!isBtBlank(bt.title) && textKey(bt.title) !== textKey(v.description)) {
    acc.heldBack.push({ field: 'description', label: 'Description', reason: 'locked', bt: norm(bt.title), p86: v.description, applicable: false, note: voidWhy });
  }

  if (bt.isSubRequested) notes.push('The sub requested this payment in Buildertrend.');
  if (!isBtBlank(bt.lienWaiverStatusText)) {
    notes.push('Buildertrend lien waiver: ' + norm(bt.lienWaiverStatusText)
      + '. P86’s own lien-waiver field is its own vocabulary (none, conditional, unconditional) and is never set by a sync.');
  }
  return { acc, notes };
}

// Buildertrend's OWN payment word against what P86 last recorded beside its
// status (data.btStatus). Two sides that AGREE raise no correction at all, so
// without this a linked bill could never record a word P86 has no status for
// — "Partially Paid" being the standing example — and the page would offer
// nothing left to press on it ever again. Never a P86 status: see withBtStatus.
function btStatusDue(bt, v) {
  const word = isBtBlank(bt.paymentStatusText) ? '' : norm(bt.paymentStatusText);
  return !!word && norm((v.data || {}).btStatus) !== word;
}

function row(bt, cls, extra) {
  return Object.assign({ bt, class: cls, rung: null, p86: null, corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [] }, extra || {});
}

function jobLabel(j) {
  return [j.jobNumber, j.title].filter((x) => !isP86Blank(x)).join(' ') || j.id;
}

// A refused row that a P86 bill is nonetheless LINKED to. Informational only:
// deliberately NOT row.p86, because sync-apply acts on row.p86 and a deleted
// Buildertrend record must reach no write path at all.
function linkedInfo(v) {
  return { id: v.id, billNumber: v.billNumber, status: STATUS_LABEL[v.status] || v.status, amountText: fmtMoney(v.amount) };
}

// btValues: readBill() records. p86: { jobs, billRows, poRows, subs }.
function matchBills(btValues, p86) {
  const jobByBt = new Map();
  for (const j of p86.jobs || []) {
    const k = norm(j.bt_job_id);
    if (k) jobByBt.set(k, { id: j.id, jobNumber: str(j.data && j.data.jobNumber), title: str(j.data && (j.data.title || j.data.name)) });
  }
  // P86's purchase orders by the Buildertrend id they already carry. This is
  // the ONLY door from a Buildertrend purchase order id to a P86 one.
  const poByBt = new Map();
  for (const p of p86.poRows || []) {
    const k = norm(p.bt_po_id);
    if (k && !poByBt.has(k)) poByBt.set(k, { id: p.id, jobId: p.job_id, poNumber: str(p.po_number), title: str((parseJsonish(p.data) || {}).title) });
  }
  const ctx = { poByBt, subs: p86.subs || [] };

  const views = (p86.billRows || []).map(p86BillView);
  const byJob = new Map();
  const byBtId = new Map();
  for (const v of views) {
    if (!byJob.has(v.jobId)) byJob.set(v.jobId, []);
    byJob.get(v.jobId).push(v);
    if (v.btId) byBtId.set(v.btId, v);
  }

  const rows = btValues.map((b, index) => {
    const amount = parseMoney(b.amount);
    const paid = parseMoney(b.amountPaid);
    const remaining = parseMoney(b.remainingBalance);
    const bt = Object.assign({ index, scope: 'open',
      raw: [b.billNumber, b.title].filter((x) => !isBtBlank(x)).map(norm).join(' '),
      amountText: amount.kind === 'value' ? fmtMoney(amount.value) : '$0.00',
      paidText: paid.kind === 'value' ? fmtMoney(paid.value) : '$0.00',
      remainingText: remaining.kind === 'value' ? fmtMoney(remaining.value) : '$0.00',
      state86: btBillStatus(b.paymentStatusText) }, b);
    const btId = norm(b.btId);
    if (!btId) return row(bt, 'refused', { notes: ['Buildertrend sent this bill without an id.'] });
    // DELETED / DUPLICATED. Refused outright, never created, and nothing is read
    // off the record — but a P86 bill already linked to it is NAMED rather than
    // left to vanish off the page with the row.
    if (b.isDeleted || b.isDuplicated) {
      const word = b.isDeleted ? 'Deleted' : 'Marked a duplicate';
      const linked = byBtId.get(btId);
      const out = row(bt, 'refused', { notes: [word + ' in Buildertrend.'] });
      if (linked) {
        out.p86Linked = linkedInfo(linked);
        out.notes.push('P86 still has the bill linked to it (' + (linked.billNumber || linked.id) + ', ' + (STATUS_LABEL[linked.status] || linked.status)
          + ', ' + fmtMoney(linked.amount) + '). Nothing is proposed and a sync never deletes or voids a P86 bill — decide in P86 what happens to it.');
      }
      return out;
    }
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
          notes: ['The P86 bill linked to this one (' + (linked.billNumber || linked.id) + ') is on a different P86 job than Buildertrend’s job, so nothing is proposed.'] });
      }
      const { acc, notes } = billProposals(b, linked, ctx);
      return row(bt, acc.corrections.length ? 'conflict' : 'matched',
        Object.assign({ rung: 'Buildertrend ID', job: jobInfo, notes, p86: p86Out(linked), btStatusDue: btStatusDue(b, linked) }, acc));
    }
    const open = onJob.filter((v) => !v.btId);
    const numKey = billNumberKey(b.billNumber);
    const byNumber = numKey ? open.filter((v) => billNumberKey(v.billNumber) === numKey) : [];
    if (byNumber.length === 1) {
      const { acc, notes } = billProposals(b, byNumber[0], ctx);
      return row(bt, acc.corrections.length ? 'conflict' : 'matched',
        Object.assign({ rung: 'Bill number', job: jobInfo, notes, p86: p86Out(byNumber[0]), btStatusDue: btStatusDue(b, byNumber[0]) }, acc));
    }
    if (byNumber.length) {
      return row(bt, 'ambiguous', { job: jobInfo, candidates: byNumber.map((v) => billCand(v, ['bill number'])),
        notes: [byNumber.length + ' P86 bills on this job carry this vendor invoice number, so none is matched and nothing is proposed.'] });
    }
    const out = row(bt, 'new', { job: jobInfo });
    const rp = resolvePo(poByBt, b, job.id);
    if (rp.why) out.notes.push(rp.why);
    const rs = poMatch.resolveSub(ctx.subs, b.vendorName);
    if (rs.why) out.notes.push(rs.why);
    if (!btBillStatus(b.paymentStatusText) && !isBtBlank(b.paymentStatusText)) {
      out.notes.push('Buildertrend payment status "' + norm(b.paymentStatusText) + '" has no Project 86 word, so it would be created open.');
    }
    return out;
  });

  // Two Buildertrend bills landing on ONE P86 bill: neither is matched.
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
      r.candidates = [billCand(views.find((v) => v.id === r.p86.id), [r.rung])];
      r.notes.push(group.length + ' Buildertrend bills land on this same P86 bill, so none is matched and nothing is proposed.');
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
  }
  const btJobs = new Set(btValues.map((b) => norm(b.jobId)).filter(Boolean));
  const jobs = new Map();
  for (const j of p86.jobs || []) {
    if (norm(j.bt_job_id) && btJobs.has(norm(j.bt_job_id))) {
      jobs.set(j.id, jobLabel({ id: j.id, jobNumber: str(j.data && j.data.jobNumber), title: str(j.data && (j.data.title || j.data.name)) }));
    }
  }
  const btIds = new Set(btValues.map((b) => norm(b.btId)).filter(Boolean));
  const listed = [];
  let notListed = 0;
  for (const v of (p86.billRows || []).map(p86BillView)) {
    if (reached.has(v.id)) continue;
    if (!jobs.has(v.jobId)) { notListed++; continue; }
    listed.push({ id: v.id, billNumber: v.billNumber, title: v.description, status: (STATUS_LABEL[v.status] || v.status) + ' · ' + fmtMoney(v.amount),
      jobLabel: jobs.get(v.jobId), linkedGone: v.btId && !btIds.has(v.btId) ? true : undefined });
  }
  return { rows: listed, notListed };
}

module.exports = { matchBills, notInBuildertrend, btBillStatus, btStatusDue, billNumberKey, resolvePo, p86BillView, dayKey, RANK, STATUS_LABEL };
