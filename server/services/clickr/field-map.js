'use strict';
// ── THE BUILDERTREND FIELD MAPPING — THE REAL KEYS, AND NOTHING ELSE ─────────
//
// These are the exact record keys of Clickr's Buildertrend datasets, taken from
// a full pull of every record on 2026-09-12 (692 jobs, 44 leads). There is no
// candidate list and no generic fallback: an earlier attempt read a job's name
// from any of 'Job' / 'name' / 'title', which would have silently matched on
// whatever column happened to be called "name" if Clickr ever renamed jobName.
// A renamed key must be LOUD, so a key is read exactly as named below or not at
// all, and describeMapping() reports every expected key that no record carried.
//
// The REQUIRED key of each dataset (jobName, opportunityTitle) must be present
// AND non-empty on at least 95% of the records. Below that the dataset is not
// classified: every record would otherwise read as blank-named, and a preview
// full of "refused" or "new" rows is a confident wrong answer.
//
// `raw` (a duplicate of the record in Buildertrend's native shape) and the
// Clickr internals (_id, accountId, integrationId, builderId) are never read.

const { isBtBlank } = require('./bt-match');

const REQUIRED_SHARE = 0.95;
// Carried by every record and deliberately never read (see the header).
// createdAt / updatedAt / __v are Clickr's own record bookkeeping: the app's
// tRPC read carries them, the REST read this server uses does not.
const IGNORED_KEYS = ['raw', '_id', 'accountId', 'integrationId', 'builderId', 'createdAt', 'updatedAt', '__v'];

const DATASETS = {
  jobs: {
    key: 'jobs',
    label: 'Jobs',
    noun: 'job',
    datasetId: '6aa5c94484f8135cf0cc5cff',
    requiredKey: 'jobName',
    idKey: 'jobId',
    keys: [
      'jobId', 'jobName', 'jobStatus', 'street', 'city', 'state', 'zip',
      'projectedStart', 'projectedCompletion',
      'contractPrice', 'approvedCOPrice', 'jobRunningTotal',
      'projectManager', 'contacts', 'customFields', 'latitude', 'longitude',
      'jobType', 'groups', 'createdDate', 'isDeleted',
    ],
  },
  leads: {
    key: 'leads',
    label: 'Leads',
    noun: 'lead',
    datasetId: '6aa5c7a284f8135cf0cc5ca6',
    requiredKey: 'opportunityTitle',
    idKey: 'leadId',
    keys: [
      'leadId', 'opportunityTitle', 'opportunityStreet', 'opportunityCity', 'opportunityState', 'opportunityZip',
      'contactId', 'contactName', 'salesperson', 'projectType', 'source', 'confidence',
      'estimatedRevenueMin', 'estimatedRevenueMax', 'notes', 'createdDate',
      'nextActivityDate', 'nextActivityTitle', 'nextActivityAssignee',
    ],
  },
  clients: {
    key: 'clients',
    label: 'Clients',
    noun: 'client',
    datasetId: '6aa5ca9384f8135cf0cc5dbd',
    requiredKey: 'displayName',
    idKey: 'contactId',
    keys: [
      'contactId', 'displayName', 'displayNameNormalized', 'firstName', 'lastName',
      'email', 'primaryEmail', 'emails', 'phone', 'cell', 'street', 'city', 'state', 'zip',
      'jobCount', 'jobTotalCount', 'leadCount', 'leadTotalCount', 'activationStatus', 'activationConfirmed', 'customFields',
    ],
  },
  // Keys confirmed against every record of the dataset on 2026-09-13 (53 change
  // orders). totalPrice equals subtotal on all of them: Buildertrend change
  // orders carry no tax. approvalStatus 3 and 4 both read "Approved", so the
  // text is what is compared.
  changeOrders: {
    key: 'changeOrders',
    label: 'Change orders',
    noun: 'change order',
    datasetId: '6aa5cc6c84f8135cf0cc5f0b',
    requiredKey: 'coNumber',
    idKey: 'changeOrderId',
    keys: [
      'changeOrderId', 'coNumber', 'title', 'jobId', 'jobName', 'approvalStatus', 'approvalStatusText',
      'builderCost', 'subtotal', 'totalMarkup', 'totalPrice', 'statusChangedDate', 'statusChangedBy',
      'dateAdded', 'createdBy', 'createdById', 'ownerName', 'ownerLastViewed', 'deadline', 'isDeleted', 'isInvoiceable',
      'purchaseOrderCost', 'poBuilderVariance', 'poCustomerVariance', 'relatedPurchaseOrderIds',
      'attachedFileCount', 'commentCount', 'rfiCount',
    ],
  },
  // Keys confirmed against every record on 2026-09-13 (91 purchase orders over
  // 21 open jobs). poNumber is per JOB ("0001"); cost is the PO total and there
  // are no line items; costCodes holds one cost-code name.
  purchaseOrders: {
    key: 'purchaseOrders',
    label: 'Purchase orders',
    noun: 'purchase order',
    datasetId: '6aa5d6f984f8135cf0cc6141',
    requiredKey: 'poNumber',
    idKey: 'purchaseOrderId',
    keys: [
      'purchaseOrderId', 'poNumber', 'title', 'jobId', 'jobName', 'approvalStatus', 'approvalStatusText', 'approvalUser', 'approvalNote',
      'workStatus', 'workStatusText', 'paidStatus', 'paidStatusText', 'cost', 'amountPaid', 'amountRemaining',
      'performingUserId', 'performingUserName', 'costCodes', 'estCompleteDate', 'externalId', 'dateAdded', 'createdBy', 'createdById',
      'fromEstimate', 'hasAmendment', 'isBill', 'isDeleted', 'isOriginatedFromAccounting', 'isRecalled', 'paymentRequested',
      'builderVarianceCodes', 'ownerVarianceCodes', 'attachedFileCount', 'commentCount', 'rfiCount',
    ],
  },
  // Bills — Buildertrend's accounts payable, 103 records. UNLIKE every dataset
  // above, these keys were NOT taken from a full pull: CLICKR_API_KEY lives only
  // on the deployed server, so not one bill record could be read from here. They
  // are the labels of ONE record's detail panel in the Clickr UI (2026-09-19),
  // converted to the camelCase this registry already uses. Every one is a CLAIM.
  //
  // describeMapping() is how the claim is settled, and it settles it without
  // echoing a single value: a key declared here that no record carries lands in
  // missingKeys, and the key the records really use lands in unexpectedKeys. Read
  // that diagnostic on the live Bills tab after this deploys and correct the list
  // from it. Until then a wrong name reads as ABSENT — never as a wrong value,
  // because readBill() below reads each key exactly as named, with no candidate
  // list and no fallback (see the header of this file).
  //
  // 'payTo' is the least certain of them. Clickr's LIST view shows a "Pay to"
  // column holding the vendor company name; its underlying key was never seen on
  // a record. It is declared under the label's own camelCase like every other key
  // here. If it is wrong, the vendor reads as absent, no P86 sub is ever filled
  // from it, and BOTH halves of the diagnostic name it.
  //
  // 'builderId' has no entry on purpose: the panel's "Builder ID" is Clickr's own
  // builderId, one of IGNORED_KEYS, carried by every record of every dataset and
  // never read. Declaring it would only make it look like a field this sync uses.
  bills: {
    key: 'bills',
    label: 'Bills',
    noun: 'bill',
    datasetId: '6aad3e1bc17fdb4c2d317bef',
    // jobName, deliberately, and not the bill's own number.
    //
    // WHY: bill-match matches a bill ONLY inside the P86 job its Buildertrend job
    // is linked to. A record with no job is refused whatever else it carries, so a
    // dataset that lost its job column is a dataset that classifies nothing —
    // exactly the condition this 95% guard exists to catch. Both job-scoped Clickr
    // datasets above (91 purchase orders, 53 change orders) carried jobName on
    // every record of a full pull, so a bills dataset that does not is a renamed
    // dataset, not a real one.
    //
    //   NOT billNumber — it is the VENDOR'S invoice number, typed by a person and
    //     routinely absent on a bill that came out of accounting or straight off a
    //     purchase order. Six blanks in 103 records would refuse the WHOLE dataset
    //     and print a refusal where 103 rows belong — a confident wrong answer of
    //     the opposite kind. As the rung-1 match key a blank one costs that row its
    //     rung; it must not cost the tab.
    //   NOT billId — it is the idKey. A required key that is the id asks only
    //     "did Clickr send ids", which fetchDataset already dedupes on and reports,
    //     and it would sit at 100% with every business field renamed underneath it.
    //   NOT jobId — the real matching key, but an opaque number. usableName screens
    //     through isBtBlank, a TEXT blankness test, so a numeric id can never read
    //     blank and the guard would pass vacuously. jobName is its human twin: it
    //     moves when the job columns are renamed, and it is what the row shows.
    //   NOT title — blank at least as often as billNumber, with none of its match
    //     value.
    requiredKey: 'jobName',
    idKey: 'billId',
    keys: [
      'billId', 'billNumber', 'title', 'jobId', 'jobName', 'documentType', 'source',
      'amount', 'amountPaid', 'remainingBalance', 'paymentStatus', 'payTo',
      'invoiceDate', 'dueDate', 'createdDate', 'createdBy', 'createdById',
      'relatedPurchaseOrderIds', 'costCodes',
      'lienWaiverStatus', 'lienWaiverStatusText', 'isSubRequested',
      'isOriginatedFromAccounting', 'attachedFileCount', 'commentCount', 'isDuplicated', 'isDeleted',
    ],
  },
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function has(rec, k) {
  return isPlainObject(rec) && Object.prototype.hasOwnProperty.call(rec, k);
}

// A string/number value, or null. Objects and arrays are NOT stringified — an
// object read as "[object Object]" would compare as a real, wrong value.
function scalarText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

// Diagnostic only ("non-empty" column): any value that is not blank.
function nonEmpty(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// The REQUIRED key is counted exactly as the classifier will read it: through
// scalarText() (an object or array is no name) and Buildertrend's blank rules
// ('--', 'TBD', whitespace ... are no name). Counting it any looser let a
// dataset of {text: ...} names or '--' names pass the guard and come out as a
// page of "refused: no name" rows.
function usableName(v) {
  const t = scalarText(v);
  return t != null && !isBtBlank(t);
}

// The Buildertrend custom field with this exact label, or null.
function customField(rec, label) {
  const list = has(rec, 'customFields') && Array.isArray(rec.customFields) ? rec.customFields : [];
  for (const f of list) {
    if (isPlainObject(f) && f.label === label) return f.value == null ? null : f.value;
  }
  return null;
}

function names(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => (typeof x === 'string' ? x : (isPlainObject(x) ? scalarText(x.name) : null)))
    .filter((x) => x != null && String(x).trim() !== '');
}

function readJob(rec) {
  const r = isPlainObject(rec) ? rec : {};
  return {
    btId: scalarText(r.jobId),
    jobName: scalarText(r.jobName),
    jobStatus: scalarText(r.jobStatus),
    street: scalarText(r.street),
    city: scalarText(r.city),
    state: scalarText(r.state),
    zip: scalarText(r.zip),
    projectedStart: scalarText(r.projectedStart),
    projectedCompletion: scalarText(r.projectedCompletion),
    // Money keeps its native shape ({value, scale} or a string); bt-match
    // parses it and never proposes it.
    contractPrice: r.contractPrice === undefined ? null : r.contractPrice,
    approvedCOPrice: r.approvedCOPrice === undefined ? null : r.approvedCOPrice,
    projectManager: names(r.projectManager),
    contacts: names(r.contacts),
    contactIds: Array.isArray(r.contacts) ? r.contacts.map((x) => (isPlainObject(x) ? scalarText(x.id) : null)).filter((x) => x != null && String(x).trim() !== '') : [],
    isDeleted: r.isDeleted === true,
  };
}

function readLead(rec) {
  const r = isPlainObject(rec) ? rec : {};
  return {
    btId: scalarText(r.leadId),
    title: scalarText(r.opportunityTitle),
    street: scalarText(r.opportunityStreet),
    city: scalarText(r.opportunityCity),
    state: scalarText(r.opportunityState),
    zip: scalarText(r.opportunityZip),
    contactId: scalarText(r.contactId),
    contactName: scalarText(r.contactName),
    salesperson: scalarText(r.salesperson),
    projectType: scalarText(r.projectType),
    source: scalarText(r.source),
    confidence: r.confidence === undefined ? null : r.confidence,
    estimatedRevenueMin: r.estimatedRevenueMin === undefined ? null : r.estimatedRevenueMin,
    estimatedRevenueMax: r.estimatedRevenueMax === undefined ? null : r.estimatedRevenueMax,
    createdDate: scalarText(r.createdDate),
  };
}

function readClient(rec) {
  const r = isPlainObject(rec) ? rec : {};
  const firstEmail = Array.isArray(r.emails) ? r.emails.map(scalarText).filter((x) => x && x.trim())[0] : null;
  return {
    btId: scalarText(r.contactId),
    displayName: scalarText(r.displayName),
    firstName: scalarText(r.firstName),
    lastName: scalarText(r.lastName),
    email: scalarText(r.primaryEmail) || scalarText(r.email) || firstEmail || null,
    phone: scalarText(r.phone),
    cell: scalarText(r.cell),
    street: scalarText(r.street),
    city: scalarText(r.city),
    state: scalarText(r.state),
    zip: scalarText(r.zip),
    jobCount: typeof r.jobCount === 'number' ? r.jobCount : null,
    leadCount: typeof r.leadCount === 'number' ? r.leadCount : null,
  };
}

function readChangeOrder(rec) {
  const r = isPlainObject(rec) ? rec : {};
  return {
    btId: scalarText(r.changeOrderId),
    coNumber: scalarText(r.coNumber),
    title: scalarText(r.title),
    jobId: scalarText(r.jobId),
    jobName: scalarText(r.jobName),
    statusText: scalarText(r.approvalStatusText),
    // Plain numbers in dollars today; bt-match's parseMoney also reads {value, scale}.
    builderCost: r.builderCost === undefined ? null : r.builderCost,
    totalPrice: r.totalPrice === undefined ? null : r.totalPrice,
    statusChangedDate: scalarText(r.statusChangedDate),
    statusChangedBy: scalarText(r.statusChangedBy),
    isDeleted: r.isDeleted === true,
  };
}

function readPurchaseOrder(rec) {
  const r = isPlainObject(rec) ? rec : {};
  return {
    btId: scalarText(r.purchaseOrderId),
    poNumber: scalarText(r.poNumber),
    title: scalarText(r.title),
    jobId: scalarText(r.jobId),
    jobName: scalarText(r.jobName),
    statusText: scalarText(r.approvalStatusText),
    workStatusText: scalarText(r.workStatusText),
    paidStatusText: scalarText(r.paidStatusText),
    approvalUser: scalarText(r.approvalUser),
    cost: r.cost === undefined ? null : r.cost,
    amountPaid: r.amountPaid === undefined ? null : r.amountPaid,
    subName: scalarText(r.performingUserName),
    costCodes: Array.isArray(r.costCodes) ? r.costCodes.map(scalarText).filter((x) => x != null && x.trim() !== '') : [],
    estCompleteDate: scalarText(r.estCompleteDate),
    isDeleted: r.isDeleted === true,
    isRecalled: r.isRecalled === true,
  };
}

// A Buildertrend bill. Every key is read EXACTLY as declared in the registry and
// never through a fallback, and every one of them may simply be ABSENT: this
// mapping came from a detail panel rather than a pull, so a name that turns out
// to be wrong has to read as null here — never crash the read, never read as a
// wrong value — and show itself in describeMapping instead.
function readBill(rec) {
  const r = isPlainObject(rec) ? rec : {};
  return {
    btId: scalarText(r.billId),
    billNumber: scalarText(r.billNumber),
    title: scalarText(r.title),
    jobId: scalarText(r.jobId),
    jobName: scalarText(r.jobName),
    documentType: scalarText(r.documentType),
    source: scalarText(r.source),
    // Buildertrend's payment word, read through scalarText so a NUMERIC code
    // arrives as its own digits rather than as null. bill-match maps only the
    // words it knows and holds anything else back NAMING it, so an unexpected
    // code lands on the page instead of disappearing into a null.
    paymentStatusText: scalarText(r.paymentStatus),
    // Money keeps its native shape (a number, a string or {value, scale});
    // bt-match's parseMoney reads all three and bill-match never proposes it.
    amount: r.amount === undefined ? null : r.amount,
    amountPaid: r.amountPaid === undefined ? null : r.amountPaid,
    remainingBalance: r.remainingBalance === undefined ? null : r.remainingBalance,
    // UNCERTAIN KEY — see the note on the registry entry.
    vendorName: scalarText(r.payTo),
    invoiceDate: scalarText(r.invoiceDate),
    dueDate: scalarText(r.dueDate),
    createdDate: scalarText(r.createdDate),
    // DEDUPED, and deduped through the SAME normalization both readers apply.
    // bill-match's resolvePo and sync-apply's createBill each do .map(norm) —
    // trim plus collapse inner whitespace — and then branch on length > 1, so a
    // Set over the raw strings would still let ['884', ' 884 '] read as two
    // purchase orders and refuse a link it can make. One purchase order named
    // twice is ONE purchase order; two DIFFERENT ids still refuse.
    relatedPurchaseOrderIds: Array.isArray(r.relatedPurchaseOrderIds)
      ? [...new Set(r.relatedPurchaseOrderIds
        .map(scalarText)
        .map((x) => (x == null ? '' : x.trim().replace(/\s+/g, ' ')))
        .filter((x) => x !== ''))] : [],
    costCodes: Array.isArray(r.costCodes) ? r.costCodes.map(scalarText).filter((x) => x != null && x.trim() !== '') : [],
    lienWaiverStatusText: scalarText(r.lienWaiverStatusText),
    isSubRequested: r.isSubRequested === true,
    isOriginatedFromAccounting: r.isOriginatedFromAccounting === true,
    isDuplicated: r.isDuplicated === true,
    isDeleted: r.isDeleted === true,
  };
}

function readRecord(kind, rec) {
  if (kind === 'jobs') return readJob(rec);
  if (kind === 'clients') return readClient(rec);
  if (kind === 'changeOrders') return readChangeOrder(rec);
  if (kind === 'purchaseOrders') return readPurchaseOrder(rec);
  if (kind === 'bills') return readBill(rec);
  return readLead(rec);
}

// THE DIAGNOSTIC. Key names and counts only — never a value, so nothing a
// record carries (a gate code, a phone number) is echoed by it.
function describeMapping(kind, records) {
  const ds = DATASETS[kind];
  const recs = Array.isArray(records) ? records : [];
  const expected = new Set(ds.keys.concat(IGNORED_KEYS));
  const unexpected = new Map();
  let notObjects = 0;
  const fields = ds.keys.map((k) => ({ key: k, carriedBy: 0, nonEmpty: 0, required: k === ds.requiredKey }));
  const byKey = new Map(fields.map((f) => [f.key, f]));
  let usable = 0;
  for (const r of recs) {
    if (!isPlainObject(r)) { notObjects++; continue; }
    if (usableName(r[ds.requiredKey])) usable++;
    for (const k of Object.keys(r)) {
      const f = byKey.get(k);
      if (f) {
        f.carriedBy++;
        if (nonEmpty(r[k])) f.nonEmpty++;
      } else if (!expected.has(k)) {
        unexpected.set(k, (unexpected.get(k) || 0) + 1);
      }
    }
  }
  const req = byKey.get(ds.requiredKey);
  const share = recs.length ? usable / recs.length : 0;
  const requiredOk = recs.length > 0 && share >= REQUIRED_SHARE;
  let refusal = null;
  if (recs.length > 0 && !requiredOk) {
    refusal = 'Only ' + usable + ' of ' + recs.length + ' ' + ds.label.toLowerCase() + ' records carry a usable "'
      + ds.requiredKey + '" (text that is not blank, "--", "TBD" or the like; at least ' + Math.round(REQUIRED_SHARE * 100) + '% must). Nothing in this dataset was classified, '
      + 'because a record without its ' + ds.noun + ' name cannot be matched, and Clickr may have renamed the field. '
      + (notObjects ? notObjects + ' records were not objects at all. ' : '')
      + 'The keys that did arrive are listed in the diagnostic below.';
  }
  return {
    recordCount: recs.length,
    notObjects,
    requiredKey: ds.requiredKey,
    requiredNonEmpty: req.nonEmpty,
    requiredUsable: usable,
    requiredOk,
    refusal,
    fields,
    missingKeys: fields.filter((f) => recs.length > 0 && f.carriedBy === 0).map((f) => f.key),
    unexpectedKeys: [...unexpected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
      .map(([key, carriedBy]) => ({ key, carriedBy })),
  };
}

module.exports = { DATASETS, REQUIRED_SHARE, readRecord, readJob, readLead, readChangeOrder, readPurchaseOrder, readBill, describeMapping, customField, isPlainObject };
