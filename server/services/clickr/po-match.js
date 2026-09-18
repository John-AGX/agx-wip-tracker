'use strict';
// ── BUILDERTREND PURCHASE ORDERS → PROJECT 86 PURCHASE ORDERS ─────────────
//
// Step 4 of the reconcile: P86 mirrors Buildertrend's purchase orders. Same
// shape as co-match.js — a Buildertrend PO is matched only inside its own job,
// once that job is linked to a P86 job by id:
//   0. job_purchase_orders.bt_po_id — the saved link;
//   1. the PO number with zeros and any "PO-" ignored (0003 = PO-3) AND titles
//      that do not disagree — confident; the same number under another title is
//      only a candidate;
//   2. an agreeing title under another number — a candidate.
//
// What a confident row proposes:
//   status — Buildertrend's approval (and work) status, FORWARD only:
//            Draft → draft, Sent to Sub/Vendor → issued, any Approved → approved,
//            Approved + work Complete → work_complete. Leaving draft locks the PO
//            and freezes its price, as P86's own status route does. A sync never
//            moves a PO backwards. A P86 CLOSED purchase
//            order is the END of one, so Buildertrend approved or work complete
//            AGREES with it: nothing is corrected and nothing is held back, and
//            only a Buildertrend draft or sent PO is called out — as Buildertrend
//            being behind, not P86. WHICH Buildertrend approval it was (the sub's
//            or the builder's own) is kept in data.approvedInBuildertrend.kind,
//            because P86's own 'approved' means the sub e-signed.
//   close  — OFFERED, never proposed. When Buildertrend has the purchase order
//            approved, its work Complete AND its payment status exactly Paid,
//            a P86 purchase order at approved or work_complete may be CLOSED.
//            It is a held-back item on its own field key ('close', never
//            'status'), unticked, applicable, out of safe mode, and it says
//            plainly that closing is permanent. btPoState is NOT taught
//            'closed' — see the note on it — so nothing is ever created closed
//            and no ordinary forward correction can reach it.
//   recalled — a Buildertrend purchase order marked recalled is refused while no
//            P86 purchase order is linked to it (nothing is ever created from
//            one). Once a P86 purchase order IS linked, the row is computed
//            normally and carries a never-applicable status item naming what P86
//            still has, so a person can act on it. That item is the WHOLE status
//            story: nothing else about status is proposed, so no box ever offers
//            to carry an approval Buildertrend has withdrawn.
//   cost   — Buildertrend's cost against P86's committed total. An unlocked
//            draft with one line (or none) takes it on the line; a locked PO
//            takes the difference as an APPROVED ADDENDUM — P86's own way a
//            committed price changes — ticked on purpose, never by default, and
//            never below what is already billed against it.
//   title, cost code, estimated completion — fills and corrections on an
//            unlocked PO; a locked PO's contract fields change in P86.
//   sub    — a blank P86 sub on an unlocked PO is filled when Buildertrend's
//            sub/vendor name is exactly one P86 sub of this organization. A
//            different sub is shown, never applied.
// Buildertrend's paid amounts are shown only: P86 never creates bills from
// Buildertrend (QuickBooks is the cost record, and a bill would count it twice).
// When a PO is sent or approved (any active status) and has a sub of this
// organization, the sub gets portal access to the job's files, as it does on
// the PO page — the same grant, run by sync-apply.js after the write commits.

const match = require('./bt-match');
const coMoney = require('../money/change-order-totals');
const { normalizeVendorName } = require('../vendor-name');

const { isBtBlank, isP86Blank, textKey, parseMoney, fmtMoney, compareField, nameEvidence } = match;

const EPS = 0.005;
const str = (v) => (v == null ? '' : String(v));
const norm = (v) => str(v).trim().replace(/\s+/g, ' ');

const RANK = { draft: 0, issued: 1, approved: 2, work_complete: 3, closed: 4 };
// The statuses that give a PO's sub portal access: services/po-sub-access.js
// PO_ACTIVE_STATUS (test/clickr-purchase-orders.test.js pins them equal).
const SUB_ACCESS_STATUS = new Set(['issued', 'approved', 'work_complete', 'closed']);
const ACCESS_NOTE = 'Its sub has no portal access to this job\'s files yet. "Link confident matches + give subs portal access" gives it, as on the PO page.';
const STATUS_LABEL = { draft: 'Draft', issued: 'Issued', approved: 'Approved', work_complete: 'Work complete', closed: 'Closed' };

function parseJsonish(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return v;
}

function poNumberKey(v) {
  const m = /^\s*(?:po[-\s_#]*)?0*(\d+)\s*$/i.exec(str(v));
  return m ? m[1] : norm(v).toUpperCase();
}

// NEVER TEACH THIS FUNCTION 'closed'. It is the shared mapper: poProposals
// uses it for the status correction, matchPurchaseOrders ships its answer as
// bt.state86 ("would be created as") and sync-apply.js's createPurchaseOrder
// takes its initial status from it. Returning 'closed' here would turn a close
// into a plain forward correction TICKED BY DEFAULT, let a create mint a
// born-closed, permanently uneditable, undeletable purchase order with no
// e-signature, and put it inside safe mode's create sweep. The close offer is
// a separate, unticked item on its own field key; see poProposals.
function btPoState(approvalText, workText) {
  const a = textKey(approvalText);
  let s = null;
  if (a === 'draft') s = 'draft';
  else if (a.startsWith('sent to sub')) s = 'issued';
  else if (a === 'sub vendor approved' || a === 'internally approved' || a.startsWith('approved')) s = 'approved';
  if (s === 'approved' && textKey(workText) === 'complete') s = 'work_complete';
  return s;
}

// WHO approved it in Buildertrend. Three Buildertrend texts land on P86's one
// 'approved' — "Sub/Vendor Approved", "Internally Approved" and "Approved -
// Assigned Internally" — and in P86 'approved' means the SUB e-signed. The
// distinction is kept (data.approvedInBuildertrend.kind) instead of being lost
// in the mapping. It is never P86 acceptance and never claims an e-sign.
// ONLY those three carry a kind. btPoState keeps a broader fallback on purpose,
// because Buildertrend's vocabulary is not closed — but an unrecognised
// "Approved …" text never says WHO approved it, so it returns null (no claim)
// rather than inventing one of the two.
function btApprovalKind(approvalText) {
  const a = textKey(approvalText);
  if (a === 'sub vendor approved') return 'sub';
  if (a === 'internally approved' || a === 'approved assigned internally') return 'internal';
  return null;
}

function contentLines(data) {
  return (Array.isArray(data && data.lines) ? data.lines : []).filter((l) => l && typeof l === 'object' && l.section !== '__section_header__');
}

function rawLinesTotal(data) {
  return contentLines(data).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
}

function approvedAddSum(data) {
  return (Array.isArray(data && data.addendums) ? data.addendums : [])
    .reduce((s, a) => s + (a && a.status === 'approved' ? (Number(a.delta) || 0) : 0), 0);
}

// Is there a price change on this purchase order that NOBODY HAS RECORDED?
// True when it is unlocked to revise, or when its line items no longer sum to
// what it has committed. P86's own /relock route refuses exactly this shape
// (409 price_changed: record it as an addendum, e-signed), and a person can
// also leave it behind by moving the status while revising — that route clears
// `revising` without asking about the price.
//
// Buildertrend cost addendums are left OUT of the committed sum on purpose:
// withAddendum below records that money without touching the lines, so counting
// them would report an unrecorded change on every purchase order the sync has
// ever corrected — the one case where the change IS recorded. Same formula as
// purchase-order-routes.js /relock otherwise, half-cent tolerance included.
function unrecordedPriceChange(data) {
  const d = data || {};
  if (d.revising) return true;
  if (d.baselineTotal == null) return false;   // legacy PO: nothing to reconcile
  const nativeAdds = (Array.isArray(d.addendums) ? d.addendums : [])
    .reduce((s, a) => s + (a && a.status === 'approved' && a.source !== 'buildertrend' ? (Number(a.delta) || 0) : 0), 0);
  return Math.abs(Math.round((rawLinesTotal(d) - ((Number(d.baselineTotal) || 0) + nativeAdds)) * 100) / 100) >= 0.005;
}

// The committed total P86 counts (baseline + approved addendums when locked).
function poTotal(data) {
  return coMoney.purchaseOrderMoney(data || {});
}

// An unlocked PO with one line (or none) with its cost set to `cost`, or null.
function withLineCost(data, cost, description) {
  if (!Number.isFinite(cost)) return null;
  const d = Object.assign({}, data || {});
  const lines = Array.isArray(d.lines) ? d.lines.slice() : [];
  const idx = [];
  lines.forEach((l, i) => { if (l && typeof l === 'object' && l.section !== '__section_header__') idx.push(i); });
  if (idx.length > 1) return null;
  if (idx.length === 0) {
    lines.push({ description: description || 'Buildertrend purchase order', qty: 1, unitCost: cost });
  } else {
    const l = Object.assign({}, lines[idx[0]]);
    if (l.amount != null && l.amount !== '') return null;
    const q = Number(l.qty);
    if (!(q > 0)) return null;
    l.unitCost = cost / q;
    lines[idx[0]] = l;
  }
  d.lines = lines;
  return Math.abs(poTotal(d) - cost) < EPS ? d : null;
}

// A locked PO with the difference to `cost` recorded as an approved addendum, or
// null when there is no committed baseline to measure against.
function withAddendum(data, cost, when) {
  if (!Number.isFinite(cost)) return null;
  const d = Object.assign({}, data || {});
  if (d.baselineTotal == null) d.baselineTotal = rawLinesTotal(d);
  const delta = Math.round((cost - ((Number(d.baselineTotal) || 0) + approvedAddSum(d))) * 100) / 100;
  if (Math.abs(delta) < EPS) return null;
  const addendums = Array.isArray(d.addendums) ? d.addendums.slice() : [];
  addendums.push({ id: 'add_bt_' + Date.now().toString(36) + '_' + addendums.length, seq: addendums.length + 1, delta,
    reason: 'Buildertrend cost', status: 'approved', source: 'buildertrend', createdAt: when || new Date().toISOString(),
    createdBy: null, approvedAt: when || new Date().toISOString(), acceptance: null });
  d.addendums = addendums;
  return Math.abs(poTotal(d) - cost) < EPS ? d : null;
}

function subKey(name) {
  return normalizeVendorName(name).key;
}

function p86PoView(r) {
  const data = parseJsonish(r.data) || {};
  return {
    id: r.id, jobId: r.job_id, poNumber: str(r.po_number), title: str(data.title), status: str(r.status),
    locked: r.is_locked === true || r.is_locked === 1, subId: r.sub_id || null, subName: str(r.sub_name),
    subAccess: r.sub_access == null ? null : (r.sub_access === true || r.sub_access === 1 || r.sub_access === '1' || r.sub_access === 't'),
    btId: norm(r.bt_po_id), data, total: poTotal(data), billed: Number(r.billed) || 0,
    costCode: str(data.costCode), scheduledCompletion: str(data.scheduledCompletion),
  };
}

// WHICH Buildertrend approval a committed purchase order carries, against what
// P86 stored (data.approvedInBuildertrend.kind). Buildertrend must say an
// approval, P86 must already be approved or past it, and a recall never counts.
// A purchase order P86 already had approved raises no correction at all, so
// without this the distinction could only ever be stored by a purchase order
// that still had a forward move left in it.
function approvalKindDue(bt, v) {
  if (bt.isRecalled) return false;
  const kind = btApprovalKind(bt.statusText);
  if (!kind) return false;
  const bs = btPoState(bt.statusText, bt.workStatusText);
  if (!(RANK[bs] >= RANK.approved) || !(RANK[v.status] >= RANK.approved)) return false;
  const had = v.data && v.data.approvedInBuildertrend;
  return !had || had.kind !== kind;
}

// Sent or approved with a sub of THIS organization (its name came through the
// org-scoped join) whose access to the job's files the read showed missing.
function subAccessDue(v) {
  return !!(v.subId && v.subName && SUB_ACCESS_STATUS.has(v.status) && v.subAccess === false);
}

function poCand(v, rungs) {
  return { id: v.id, poNumber: v.poNumber, title: v.title, status: v.status + (v.locked ? ', locked' : ''), rungs: rungs.slice() };
}

function titlesDisagree(a, b) {
  if (isBtBlank(a) || isP86Blank(b)) return false;
  if (textKey(a) === textKey(b)) return false;
  return nameEvidence(a, b) === 'disagree';
}

// subs: [{ id, name }] of this organization. One exact normalized name, or null.
function resolveSub(subs, btName) {
  if (isBtBlank(btName)) return { sub: null, why: null };
  const k = subKey(btName);
  const hits = (subs || []).filter((s) => subKey(s.name) === k);
  if (hits.length === 1) return { sub: hits[0], why: null };
  return { sub: null, why: hits.length ? 'Buildertrend sub/vendor "' + norm(btName) + '" matches ' + hits.length + ' P86 subs, so none is set.'
    : 'Buildertrend sub/vendor "' + norm(btName) + '" is not a P86 sub yet, so none is set.' };
}

function poProposals(bt, v, subs) {
  const acc = { corrections: [], btBlank: [], heldBack: [], flags: [] };
  const notes = [];
  const closed = v.status === 'closed';
  const editable = !v.locked && !closed;
  const lockedWhy = closed ? 'A closed purchase order cannot be edited in P86.' : 'Locked in P86 (it has left draft): contract fields change there, through unlock and an addendum.';

  // The sub this PO will carry: its own of this organization, or the one a fill sets.
  const rs = resolveSub(subs, bt.subName);
  const orgSub = (v.subId && v.subName) || (!v.subId && editable && rs.sub);

  const p86StatusLabel = STATUS_LABEL[v.status] || v.status;

  // STATUS — forward only.
  const bs = btPoState(bt.statusText, bt.workStatusText);
  if (bt.isRecalled) {
    // RECALLED IN BUILDERTREND (P3). The row used to be refused outright, so a
    // P86 purchase order already issued or approved stood with nothing said about
    // it. The recall REPLACES the status comparison rather than sitting beside it:
    // Buildertrend withdrew the approval, so proposing to carry that approval
    // forward — committing the PO, locking its price and starting its cost — would
    // contradict this very item. P86 keeps what it has and a person decides.
    acc.heldBack.push({ field: 'status', label: 'Status', reason: 'review', bt: 'Recalled', p86: p86StatusLabel, applicable: false,
      note: 'Recalled in Buildertrend. P86 still has this purchase order as ' + p86StatusLabel
        + '. A recall is never applied — decide in P86 what happens to it.' });
  } else if (!bs) {
    if (!isBtBlank(bt.statusText)) notes.push('Buildertrend status "' + norm(bt.statusText) + '" is not one P86 maps, so status was not compared.');
  } else if (RANK[v.status] == null) {
    notes.push('P86 status "' + v.status + '" is not a purchase-order status, so status was not compared.');
  } else if (closed) {
    // P86 CLOSED is the end of a purchase order (P1). Buildertrend approved or
    // work complete is the same place, not a step backwards, so it AGREES:
    // nothing is corrected and nothing is held back. Only a Buildertrend
    // purchase order still in draft or sent is genuinely behind — and it is
    // Buildertrend that is behind, not P86.
    if (bs === 'draft' || bs === 'issued') {
      acc.heldBack.push({ field: 'status', label: 'Status', reason: 'review', bt: STATUS_LABEL[bs], p86: p86StatusLabel, applicable: false,
        note: 'Buildertrend is behind P86 here: P86 closed this purchase order. Nothing is proposed — move it on in Buildertrend if P86 is right.' });
    }
  } else if (RANK[bs] > RANK[v.status]) {
    acc.corrections.push({ field: 'status', label: 'Status', kind: 'value', money: true, from: STATUS_LABEL[v.status], to: STATUS_LABEL[bs], value: bs, p86Value: v.status,
      note: ((v.status === 'draft' ? 'Leaving draft commits the PO: its cost starts to accrue and its price is locked. ' : '')
        + (orgSub ? 'Once it is sent or approved, its sub gets portal access to the job\'s files, as on the PO page.' : '')).trim() || undefined });
  } else if (RANK[bs] < RANK[v.status]) {
    acc.heldBack.push({ field: 'status', label: 'Status', reason: 'money', bt: STATUS_LABEL[bs], p86: STATUS_LABEL[v.status], applicable: false,
      note: 'A sync never moves a purchase order backwards. If Buildertrend is right, change it in P86.' });
  }

  // CLOSE — offered, never proposed (John, 2026-09-18). Buildertrend has this
  // purchase order approved, its work Complete and its payment status exactly
  // Paid, so P86 MAY close it. Everything about this item is deliberate:
  //
  //   field 'close', not 'status' — against a P86 purchase order at `approved`
  //     a status correction to work_complete is ALREADY pushed and ticked by
  //     default, and the page keys its tick boxes, its applied `fields` array
  //     and the server's writable()/pickedHeldBack() all on the field NAME. Two
  //     items called 'status' on one row collide in three places at once.
  //   reason 'permanent', not 'money' — 'money' would fold it into the money
  //     confirm sentence on the page. Closing moves no money at all; what it
  //     costs is the ability to ever change this record again.
  //   applicable true, and the page defaults every applicable held-back item to
  //     UNTICKED. pickedHeldBack refuses it unless the request names it by
  //     field, which is what keeps it out of safe mode and out of an
  //     "apply everything" press.
  //   textKey(...) === 'paid' EXACTLY. textKey lowercases and collapses
  //     punctuation, so 'Partially Paid' becomes 'partially paid'. A
  //     .includes('paid') or .endsWith('paid') would both match it. Never
  //     use either.
  //   RANK >= approved — below that the sub never e-signed (approved_at and
  //     data.acceptance are stamped only on the approved transition), and a
  //     close would freeze that for ever with no route back.
  //   no pending addendum — approving one raises the committed total, and the
  //     addendum route now refuses a closed purchase order outright.
  //   not mid-revision — a purchase order unlocked to revise, or whose lines no
  //     longer sum to its committed baseline, carries a price change nobody has
  //     recorded. It is INVISIBLE on this row: poTotal returns baseline +
  //     approved addendums once a baseline is frozen, so P86's shown total still
  //     agrees with Buildertrend while the edited line value sits outside it.
  //     P86's own re-lock route refuses exactly this shape (409 price_changed:
  //     record it as an addendum, e-signed). Closing would freeze it with every
  //     door back already shut, so the offer is withheld and the reason shown.
  //   NOT gated on bt.amountPaid (shown only, never trusted: Buildertrend can
  //     record Paid with a null amount) and NOT on P86's billed total (P86
  //     creates no bills from Buildertrend by design, so billed = 0 is normal).
  const btPaidDone = textKey(bt.paidStatusText) === 'paid';
  const pendingAddendum = (Array.isArray(v.data && v.data.addendums) ? v.data.addendums : [])
    .some((a) => a && a.status === 'pending');
  const unrecorded = unrecordedPriceChange(v.data);
  const closeInRange = !bt.isRecalled && bs === 'work_complete' && btPaidDone
    && RANK[v.status] != null && RANK[v.status] >= RANK.approved && RANK[v.status] < RANK.closed;
  if (closeInRange && !pendingAddendum && !unrecorded) {
    acc.heldBack.push({ field: 'close', label: 'Close', reason: 'permanent',
      bt: 'Closed', p86: p86StatusLabel, value: 'closed', p86Value: v.status, applicable: true,
      note: 'Buildertrend has this purchase order approved, its work Complete and its payment status Paid. '
        + 'Closing it in P86 is PERMANENT: a closed purchase order cannot be edited, unlocked, revised by addendum or deleted, by anyone, ever — '
        + 'and it drops off the Purchase orders hub\'s open list. Its cost does not change (a closed purchase order still counts exactly what it counts today) '
        + 'and its sub keeps portal access to the job\'s files. This is Buildertrend\'s settlement record, not a P86 payment: P86 creates no bills from '
        + 'Buildertrend, so this purchase order may still show $0.00 billed here.' });
  } else if (closeInRange && pendingAddendum) {
    acc.heldBack.push({ field: 'close', label: 'Close', reason: 'review',
      bt: 'Closed', p86: p86StatusLabel, applicable: false,
      note: 'Buildertrend has this purchase order paid and complete, but P86 has an addendum on it still awaiting a signature. '
        + 'Closing would freeze the purchase order with that addendum unresolved and no way to approve it. Settle it in P86 first.' });
  } else if (closeInRange) {
    acc.heldBack.push({ field: 'close', label: 'Close', reason: 'review',
      bt: 'Closed', p86: p86StatusLabel, applicable: false,
      note: 'Buildertrend has this purchase order paid and complete, but P86 has it '
        + (v.data && v.data.revising ? 'unlocked to revise' : 'holding line items that no longer sum to its committed total')
        + ', so there is a price change on it that nobody has recorded. The total shown here is still the committed one, so that difference is not on this row. '
        + 'Record it as an addendum in P86 (it is e-signed) or put the lines back and re-lock it, then close it. Closing now would freeze the purchase order '
        + 'with that change lost for ever — a closed purchase order cannot be edited, unlocked, revised by addendum or deleted.' });
  }

  // TITLE
  if (editable) compareField(acc, { field: 'title', label: 'Title', bt: bt.title, p86: v.title, same: (a, b) => textKey(a) === textKey(b) });
  else if (!isBtBlank(bt.title) && norm(bt.title) !== norm(v.title)) {
    acc.heldBack.push({ field: 'title', label: 'Title', reason: 'locked', bt: norm(bt.title), p86: v.title, applicable: false, note: lockedWhy });
  }

  // COST CODE and ESTIMATED COMPLETION — fill a blank on an unlocked PO.
  const btCode = Array.isArray(bt.costCodes) && bt.costCodes.length === 1 ? norm(bt.costCodes[0]) : '';
  if (btCode && editable) compareField(acc, { field: 'costCode', label: 'Cost code', bt: btCode, p86: v.costCode, same: (a, b) => textKey(a) === textKey(b) });
  const btDay = match.dateKey(bt.estCompleteDate);
  if (btDay && editable) compareField(acc, { field: 'scheduledCompletion', label: 'Estimated completion', bt: btDay, p86: v.scheduledCompletion, same: (a, b) => match.dateKey(a) === match.dateKey(b), literal: () => true });

  // SUB
  if (rs.why && !(v.subId && subKey(v.subName) === subKey(bt.subName))) notes.push(rs.why);
  if (rs.sub) {
    if (!v.subId) {
      if (editable) acc.corrections.push({ field: 'sub', label: 'Sub/vendor', kind: 'fill', from: '', to: rs.sub.name, value: rs.sub.id, p86Value: null,
        note: 'The sub gets portal access to the job\'s files once the purchase order is sent or approved, as on the PO page.' });
      else acc.heldBack.push({ field: 'sub', label: 'Sub/vendor', reason: 'locked', bt: rs.sub.name, p86: '', applicable: false, note: lockedWhy });
    } else if (String(v.subId) !== String(rs.sub.id)) {
      acc.heldBack.push({ field: 'sub', label: 'Sub/vendor', reason: 'review', bt: rs.sub.name, p86: v.subName || String(v.subId), applicable: false,
        note: 'A different sub is never set by a sync: a PO\'s sub decides portal access and sub cost. Change it in P86 if Buildertrend is right.' });
    }
  }

  // COST
  const m = parseMoney(bt.cost);
  if (m.kind === 'blank') {
    if (Math.abs(v.total) >= EPS) acc.btBlank.push({ field: 'cost', label: 'Cost', p86: fmtMoney(v.total), zero: !!m.zero, money: true });
  } else if (m.kind !== 'value') {
    acc.heldBack.push({ field: 'cost', label: 'Cost', reason: 'unparsed', bt: '(not readable money)', p86: fmtMoney(v.total), applicable: false,
      note: 'Buildertrend sent a cost that is not readable money, so it was not compared.' });
  } else if (Math.abs(m.value - v.total) >= EPS) {
    const base = { field: 'cost', label: 'Cost', from: fmtMoney(v.total), to: fmtMoney(m.value), value: m.value, p86Value: v.total, money: true };
    if (closed) {
      acc.heldBack.push({ field: 'cost', label: 'Cost', reason: 'money', bt: base.to, p86: base.from, applicable: false, note: lockedWhy });
    } else if (!v.locked) {
      if (withLineCost(v.data, m.value, bt.title) != null) acc.corrections.push(Object.assign({ kind: Math.abs(v.total) < EPS ? 'fill' : 'value', note: 'Sets the line\'s cost.' }, base));
      else acc.heldBack.push({ field: 'cost', label: 'Cost', reason: 'money', bt: base.to, p86: base.from, applicable: false, note: 'This P86 purchase order has several lines; enter the cost per line in P86.' });
    } else if (m.value < v.billed - EPS) {
      acc.heldBack.push({ field: 'cost', label: 'Cost', reason: 'money', bt: base.to, p86: base.from, applicable: false,
        note: 'Buildertrend\'s cost is below the ' + fmtMoney(v.billed) + ' already billed against this PO in P86.' });
    } else if (withAddendum(v.data, m.value) != null) {
      acc.heldBack.push({ field: 'cost', label: 'Cost', reason: 'money', bt: base.to, p86: base.from, value: m.value, p86Value: v.total, applicable: true,
        note: 'Locked in P86. Tick it to record the ' + fmtMoney(Math.round((m.value - v.total) * 100) / 100) + ' difference as an approved addendum — P86\'s own way a committed price changes.' });
    }
  }

  // PAID — shown only.
  const paid = parseMoney(bt.amountPaid);
  if (paid.kind === 'value') {
    notes.push('Buildertrend: ' + (norm(bt.paidStatusText) || 'paid') + ', ' + fmtMoney(paid.value) + ' paid. P86 does not create bills from Buildertrend — QuickBooks is the cost record.');
  }
  return { acc, notes };
}

function row(bt, cls, extra) {
  return Object.assign({ bt, class: cls, rung: null, p86: null, corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [] }, extra || {});
}

function jobLabel(j) {
  return [j.jobNumber, j.title].filter((x) => !isP86Blank(x)).join(' ') || j.id;
}

function p86Out(v) {
  return { id: v.id, poNumber: v.poNumber, title: v.title, status: v.status + (v.locked ? ', locked' : ''), totalText: fmtMoney(v.total), subName: v.subName };
}

// btValues: readPurchaseOrder() records. p86: { jobs, poRows, subs }.
function matchPurchaseOrders(btValues, p86) {
  const jobByBt = new Map();
  for (const j of p86.jobs || []) {
    const k = norm(j.bt_job_id);
    if (k) jobByBt.set(k, { id: j.id, jobNumber: str(j.data && j.data.jobNumber), title: str(j.data && (j.data.title || j.data.name)), legacy: parseJsonish(j.legacy_pos) });
  }
  const views = (p86.poRows || []).map(p86PoView);
  const byJob = new Map();
  const byBtId = new Map();
  for (const v of views) {
    if (!byJob.has(v.jobId)) byJob.set(v.jobId, []);
    byJob.get(v.jobId).push(v);
    if (v.btId) byBtId.set(v.btId, v);
  }

  const rows = btValues.map((b, index) => {
    const cost = parseMoney(b.cost);
    const bt = Object.assign({ index, scope: 'open', raw: [b.poNumber, b.title].filter((x) => !isBtBlank(x)).map(norm).join(' '),
      costText: cost.kind === 'value' ? fmtMoney(cost.value) : '$0.00', state86: btPoState(b.statusText, b.workStatusText),
      approvalKind: btApprovalKind(b.statusText) }, b);
    const btId = norm(b.btId);
    if (!btId) return row(bt, 'refused', { notes: ['Buildertrend sent this purchase order without an id.'] });
    if (b.isDeleted) return row(bt, 'refused', { notes: ['Deleted in Buildertrend.'] });
    // RECALLED (P3). An UNLINKED one stays refused, as a deleted one does:
    // nothing is ever created from it. One a P86 purchase order is already
    // linked to is computed like any other row, so what P86 still holds is
    // named instead of vanishing with the row.
    if (b.isRecalled && !byBtId.get(btId)) return row(bt, 'refused', { notes: ['Recalled in Buildertrend, and no P86 purchase order is linked to it.'] });
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
          notes: ['The P86 purchase order linked to this one (' + (linked.poNumber || linked.id) + ') is on a different P86 job than Buildertrend\'s job, so nothing is proposed.'] });
      }
      const { acc, notes } = poProposals(b, linked, p86.subs);
      if (subAccessDue(linked)) notes.push(ACCESS_NOTE);
      return row(bt, acc.corrections.length ? 'conflict' : 'matched', Object.assign({ rung: 'Buildertrend ID', job: jobInfo, notes, p86: p86Out(linked), subAccessDue: subAccessDue(linked), approvalKindDue: approvalKindDue(b, linked) }, acc));
    }
    const open = onJob.filter((v) => !v.btId);
    const numKey = isBtBlank(b.poNumber) ? '' : poNumberKey(b.poNumber);
    const byNumber = numKey ? open.filter((v) => poNumberKey(v.poNumber) === numKey) : [];
    if (byNumber.length === 1 && !titlesDisagree(b.title, byNumber[0].title)) {
      const { acc, notes } = poProposals(b, byNumber[0], p86.subs);
      if (subAccessDue(byNumber[0])) notes.push(ACCESS_NOTE);
      return row(bt, acc.corrections.length ? 'conflict' : 'matched', Object.assign({ rung: 'PO number', job: jobInfo, notes, p86: p86Out(byNumber[0]), subAccessDue: subAccessDue(byNumber[0]), approvalKindDue: approvalKindDue(b, byNumber[0]) }, acc));
    }
    if (byNumber.length) {
      return row(bt, 'ambiguous', { job: jobInfo, candidates: byNumber.map((v) => poCand(v, ['PO number'])),
        notes: [byNumber.length > 1 ? 'Several P86 purchase orders on this job carry this number.' : 'Same number, different title — link it only if it is the same purchase order.'] });
    }
    const byTitle = isBtBlank(b.title) ? [] : open.filter((v) => !isP86Blank(v.title) && !titlesDisagree(b.title, v.title));
    if (byTitle.length) {
      return row(bt, 'ambiguous', { job: jobInfo, candidates: byTitle.map((v) => poCand(v, ['title'])),
        notes: ['A P86 purchase order on this job has a similar title under a different number. Link it only if it is the same purchase order.'] });
    }
    const out = row(bt, 'new', { job: jobInfo });
    const legacy = Array.isArray(job.legacy) ? job.legacy.length : 0;
    if (legacy && !onJob.length) {
      out.createBlocked = 'This job\'s ' + legacy + ' purchase order' + (legacy === 1 ? '' : 's') + ' still live in its old per-job list. Creating the first purchase order in the table would hide ' + (legacy === 1 ? 'it' : 'them') + ', so nothing is created until they are moved.';
      out.notes.push(out.createBlocked);
    }
    const rs = resolveSub(p86.subs, b.subName);
    if (rs.why) out.notes.push(rs.why);
    return out;
  });

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
      r.candidates = [poCand(views.find((v) => v.id === r.p86.id), [r.rung])];
      r.notes.push(group.length + ' Buildertrend purchase orders land on this same P86 purchase order, so none is matched and nothing is proposed.');
      r.class = 'ambiguous';
      r.rung = null;
      r.p86 = null;
      r.subAccessDue = false;
      r.approvalKindDue = false;
      r.notes = r.notes.filter((n) => n !== ACCESS_NOTE);
      r.corrections = []; r.btBlank = []; r.heldBack = []; r.flags = [];
    }
  }
  return rows;
}

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
  for (const v of (p86.poRows || []).map(p86PoView)) {
    if (reached.has(v.id)) continue;
    if (!jobs.has(v.jobId)) { notListed++; continue; }
    listed.push({ id: v.id, poNumber: v.poNumber, title: v.title, status: v.status + (v.locked ? ', locked' : ''), jobLabel: jobs.get(v.jobId),
      linkedGone: v.btId && !btIds.has(v.btId) ? true : undefined });
  }
  return { rows: listed, notListed };
}

module.exports = { matchPurchaseOrders, notInBuildertrend, btPoState, btApprovalKind, approvalKindDue, poNumberKey, withLineCost, withAddendum, resolveSub, poTotal, unrecordedPriceChange, RANK, SUB_ACCESS_STATUS };
