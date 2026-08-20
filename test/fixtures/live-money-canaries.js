// THE FIELD LIST, as a file the test loads rather than a paragraph in a doc.
//
// Every money-bearing field a phase-02 guest surface could conceivably touch is
// seeded here with a UNIQUE, unmistakable value. test/live-view-wire.test.js
// then drives a guest end to end, concatenates every byte written to them, and
// asserts none of these values appears in any rendering.
//
// ── WHY THE VALUES LOOK LIKE THIS ──────────────────────────────────────────
// Each is a 6-digit-or-larger number with a distinctive fractional part, so a
// match in a byte buffer is a match and not a coincidence. They are DELIBERATELY
// NOT chosen so that no sum or product of two collides with a third — the first
// version of this design asked for exactly that, and it is the mistake that made
// the whole sweep blind.
//
// Here is why. computeJobWIP has 30 money outputs and only THREE of them are
// byte-identical to a stored scalar (contractIncome, estimatedCosts,
// revisedCostChanges). Every other one — totalIncome, actualCosts, asSoldMargin,
// jtdProfit, displayProfit, displayMargin, projectedProfit, backlog, unbilled,
// and the rest — is a sum, difference or ratio. A "no combination collides"
// constraint GUARANTEES those fall outside the seeded set, so a sweep for seeds
// alone would search for values that cannot be on the wire, find none, and pass
// while `displayMargin` sat in the response. The toggle is named "hide MARGINS,
// cost and contract values" and that sweep could see the contract value and not
// one margin: 3 of 30.
//
// So the corpus is the seeds AND the outputs. The test calls computeJobWIP on
// these inputs, takes its real 30 figures, and sweeps for those too. That costs
// one function call and it is the difference between a proof and a ritual.
//
// ── IDENTITY IS THE SECOND LIST ────────────────────────────────────────────
// Money is not the only thing phase 01 promised a guest never receives.
// services/live-rooms.js:151 states it and test/live-rooms-boundary.test.js
// asserts it: "a guest holds a link, not a login, and must not be able to read
// the id of the thing they are looking at". The surfaces phase 02 serves are
// built from rows whose canonical shapes carry that id — change-order-routes.js
// shapeRow returns job_id right next to the data blob — so a projection written
// from the app's own shape would break a shipped invariant on day one.
//
// The identity canaries below get the same six renderings and the same sweep.
//
// ── PROSE IS THE THIRD ─────────────────────────────────────────────────────
// A CO titled "Add 3 doors — $412,900" puts a dollar figure on the wire through
// a field no money-TYPED redactor would ever look at. Those strings are seeded
// too, and the scrubber in services/live-view.js is what has to catch them.
//
// RESIDUE, NAMED: an amount spelled out in words ("four hundred twelve
// thousand") is not catchable by any scrubber and is not claimed to be.

'use strict';

// ── Identity ───────────────────────────────────────────────────────────────
const IDENTITY = Object.freeze({
  jobId: 'job_canary_7f3a91c4d2',
  orgId: 4471,
  clientId: 'client_canary_88b1e5',
  ownerId: 991233,
  coId: 'co_canary_5d7e2b',
  nodeId: 'node_canary_3ac91f'
});

// ── Money seeds ────────────────────────────────────────────────────────────
// Keyed by where the value lives, so a failure names the field rather than the
// number. The keys ARE the field list.
const MONEY = Object.freeze({
  // jobs.data root scalars
  'job.contractAmount': 887711.13,
  'job.estimatedCosts': 613455.27,
  'job.revisedCostChanges': 42317.41,
  'job.invoicedToDate': 501199.53,
  'job.materials': 71233.19,
  'job.labor': 92455.61,
  'job.sub': 63177.29,
  'job.equipment': 18944.83,
  'job.generalConditions': 27511.47,

  // the node-graph money mirror on the blob (nodegraph/engine.js pushes these)
  'job.ngActualCosts': 388211.71,
  'job.ngRevenueEarned': 455322.19,
  'job.ngBacklog': 431199.87,
  'job.ngAccruedCosts': 77455.33,
  'job.ngTotalIncome': 887711.13,

  // buildings[] — per-building cost buckets
  'buildings[0].materials': 33122.51,
  'buildings[0].labor': 41988.77,
  'buildings[0].sub': 29455.13,
  'buildings[0].equipment': 8177.29,
  'buildings[0].rate': 137.71,
  'buildings[0].asSoldRevenue': 265422.31,
  'buildings[0].phaseBudget': 265422.31,

  // phases[] — the same three-field money mirror one level down
  'phases[0].materials': 22455.91,
  'phases[0].labor': 31788.43,
  'phases[0].sub': 17211.67,
  'phases[0].equipment': 6455.19,
  'phases[0].asSoldPhaseBudget': 199877.53,

  // A SECOND PHASE, DELIBERATELY SUB-$1,000. renderings() drops any needle with
  // fewer than four digit characters, so a figure under a thousand is invisible
  // to the sweep unless it carries cents — and per-cost-code budgets are
  // exactly where small figures live. These four keep two decimals so the
  // "847.23" rendering has five digit characters and IS swept, while the
  // "847" rendering is correctly discarded as a coincidence risk.
  'phases[1].materials': 847.23,
  'phases[1].labor': 604.91,
  'phases[1].sub': 388.47,
  'phases[1].equipment': 917.61,

  // subs[] — contract + billed
  'subs[0].contractAmt': 155433.29,
  'subs[0].billedToDate': 61277.83,

  // job_change_orders.data — money derived through the pricing pipeline
  'changeOrders[0].lines[0].amount': 74522.91,
  'changeOrders[1].lines[0].amount': 38199.47,

  // job_purchase_orders.data.lines
  'purchaseOrders[0].lines[0].unitCost': 24788.31,

  // job_vendor_bills
  'vendorBills[0].amount': 51344.77,
  'vendorBills[1].amount': 19822.53,

  // qb_cost_lines
  'qbCostLines[0].amount': 211455.19,
  'qbCostLines[1].amount': 96733.41,

  // invoices
  'invoices[0].total': 322188.71,
  'invoices[0].amount_paid': 210455.33
});

// ── Prose seeds ────────────────────────────────────────────────────────────
// Author-written text that carries a figure. The strings themselves are seeded;
// the sweep looks for the NUMBERS inside them.
const PROSE = Object.freeze({
  'changeOrders[0].title': 'Add 3 doors and regrade — 412900 all in',
  'changeOrders[1].title': 'Owner allowance credit of $58,433.19',
  'job.title': 'Waterside Phase 2 — 776522 contract'
});
const PROSE_NUMBERS = Object.freeze([412900, 58433.19, 776522]);

// ── The OTHER half of the proof ────────────────────────────────────────────
// Every canary above asserts a value is ABSENT. Nothing asserted a permitted
// field arrives INTACT — and that gap is not hypothetical: the address in this
// very fixture shipped as "— Marina Way, Tampa FL" for as long as the file has
// existed, in a suite that was green the whole time. A one-directional proof
// cannot see a redactor eating the wrong thing, and "you cannot responsibly add
// a field to a document whose test suite only proves absence" is why this list
// exists before the cost surface does.
//
// Each entry is a string that MUST reach the guest whole, with money hidden.
const MUST_SURVIVE = Object.freeze({
  'job.propertyAddr': '1400 Marina Way, Tampa, FL 33607',
  'job.propertyAddr#street': '1400',
  'job.propertyAddr#zip': '33607',
  'changeOrders[0].co_number': 'CO-001',
  'changeOrders[1].co_number': 'CO-002',
  'job.client': 'Waterside HOA',
  'job.status': 'In progress',
  'job.jobType': 'Renovation'
});

// ── The fixture ────────────────────────────────────────────────────────────
// Realistic shapes, seeded values. Note that BOTH halves of every three-field
// money mirror are seeded (asSoldRevenue / asSoldPhaseBudget / phaseBudget):
// those are one number in three fields, so redacting a member rather than the
// set would leave a survivor to read the hidden one off.
function jobBlob() {
  return {
    id: IDENTITY.jobId,
    title: PROSE['job.title'],
    jobNumber: 'RV2006',
    client: 'Waterside HOA',
    client_id: IDENTITY.clientId,
    // A REAL address: a 4-digit street number and a 5-digit ZIP, because both
    // are what the prose scrubber's bare-digit rule ate. The old fixture value
    // had no ZIP and the suite asserted nothing about it, so it sat mangled in
    // a green build from the day it was written. See MUST_SURVIVE in
    // test/live-view-wire.test.js — the list that proves a PERMITTED field
    // arrives whole, which is the half this corpus never had.
    propertyAddr: '1400 Marina Way, Tampa, FL 33607',
    jobType: 'Renovation',
    status: 'In progress',
    startDate: '2026-03-02',
    endDate: '2026-11-20',
    pctComplete: 51.3,

    contractAmount: MONEY['job.contractAmount'],
    estimatedCosts: MONEY['job.estimatedCosts'],
    revisedCostChanges: MONEY['job.revisedCostChanges'],
    invoicedToDate: MONEY['job.invoicedToDate'],
    materials: MONEY['job.materials'],
    labor: MONEY['job.labor'],
    sub: MONEY['job.sub'],
    equipment: MONEY['job.equipment'],
    generalConditions: MONEY['job.generalConditions'],

    ngActualCosts: MONEY['job.ngActualCosts'],
    ngRevenueEarned: MONEY['job.ngRevenueEarned'],
    ngBacklog: MONEY['job.ngBacklog'],
    ngAccruedCosts: MONEY['job.ngAccruedCosts'],
    ngTotalIncome: MONEY['job.ngTotalIncome'],

    buildings: [{
      id: 'bldg_canary_1',
      name: 'Building A',
      materials: MONEY['buildings[0].materials'],
      labor: MONEY['buildings[0].labor'],
      sub: MONEY['buildings[0].sub'],
      equipment: MONEY['buildings[0].equipment'],
      // COUNTS, not money — and precisely the pair that a money-TYPED redactor
      // waves through. hoursTotal * the `|| 40` default rate in js/jobs.js is a
      // labor budget, and express.static serves js/jobs.js to anonymous
      // callers, so the constant is public. This is why no surface ships them.
      hoursTotal: 1284,
      hoursWeek: 96,
      rate: MONEY['buildings[0].rate'],
      asSoldRevenue: MONEY['buildings[0].asSoldRevenue'],
      phaseBudget: MONEY['buildings[0].phaseBudget']
    }],

    phases: [{
      id: 'phase_canary_1',
      name: 'Sitework',
      materials: MONEY['phases[0].materials'],
      labor: MONEY['phases[0].labor'],
      sub: MONEY['phases[0].sub'],
      equipment: MONEY['phases[0].equipment'],
      asSoldPhaseBudget: MONEY['phases[0].asSoldPhaseBudget']
    }, {
      id: 'phase_canary_2',
      name: 'Punch',
      materials: MONEY['phases[1].materials'],
      labor: MONEY['phases[1].labor'],
      sub: MONEY['phases[1].sub'],
      equipment: MONEY['phases[1].equipment']
    }],

    subs: [{
      id: 'sub_canary_1',
      name: 'Gulf Concrete',
      contractAmt: MONEY['subs[0].contractAmt'],
      billedToDate: MONEY['subs[0].billedToDate']
    }]
  };
}

// job_change_orders rows, in the table's own shape (id + job_id + data blob) —
// exactly what a projection written from the app's shapeRow would spread.
function changeOrderRows() {
  return [
    {
      id: IDENTITY.coId,
      job_id: IDENTITY.jobId,
      status: 'approved',
      // PADDED, which is house style and is the shape the bug destroyed:
      // "CO-001" went out as "CO-—". An unpadded "CO-1" cannot fail the test,
      // which is why the old fixture could not see the defect.
      co_number: 'CO-001',
      linked_node_id: IDENTITY.nodeId,
      created_at: '2026-04-02T00:00:00.000Z',
      approved_at: '2026-04-09T00:00:00.000Z',
      data: {
        title: PROSE['changeOrders[0].title'],
        lines: [{ description: 'Doors', qty: 1, unitCost: MONEY['changeOrders[0].lines[0].amount'] }]
      }
    },
    {
      id: 'co_canary_second',
      job_id: IDENTITY.jobId,
      status: 'draft',
      co_number: 'CO-002',
      linked_node_id: null,
      created_at: '2026-05-11T00:00:00.000Z',
      approved_at: null,
      data: {
        title: PROSE['changeOrders[1].title'],
        lines: [{ description: 'Credit', qty: 1, unitCost: MONEY['changeOrders[1].lines[0].amount'] }]
      }
    }
  ];
}

function invoiceRows() {
  return [{
    id: 'inv_canary_1',
    job_id: IDENTITY.jobId,
    status: 'sent',
    invoice_number: 'INV-1',
    issue_date: '2026-06-01',
    due_date: '2026-07-01',
    total: MONEY['invoices[0].total'],
    amount_paid: MONEY['invoices[0].amount_paid']
  }];
}

function qbCostLineRows() {
  return [
    { job_id: IDENTITY.jobId, amount: MONEY['qbCostLines[0].amount'], linked_node_id: IDENTITY.nodeId, report_date: '2026-06-14', account: 'Lumber', account_type: 'Expense', bucket: 'materials' },
    { job_id: IDENTITY.jobId, amount: MONEY['qbCostLines[1].amount'], linked_node_id: null, report_date: '2026-06-21', account: 'Field labor', account_type: 'Expense', bucket: 'labor' }
  ];
}

function vendorBillRows() {
  return [
    { job_id: IDENTITY.jobId, po_id: 'po_canary_1', amount: MONEY['vendorBills[0].amount'], status: 'approved' },
    { job_id: IDENTITY.jobId, po_id: null, amount: MONEY['vendorBills[1].amount'], status: 'approved' }
  ];
}

function purchaseOrderRows() {
  return [{
    id: 'po_canary_1',
    job_id: IDENTITY.jobId,
    sub_id: 'sub_canary_1',
    status: 'issued',
    po_number: 'PO-1',
    created_at: '2026-04-20T00:00:00.000Z',
    data: {
      title: 'Concrete package',
      lines: [{ description: 'Slab', qty: 1, unitCost: MONEY['purchaseOrders[0].lines[0].unitCost'] }]
    }
  }];
}

module.exports = {
  IDENTITY, MONEY, PROSE, PROSE_NUMBERS, MUST_SURVIVE,
  jobBlob, changeOrderRows, invoiceRows,
  qbCostLineRows, vendorBillRows, purchaseOrderRows
};
