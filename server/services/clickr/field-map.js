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
  // Estimates — Buildertrend’s estimate worksheets, 277 records. A RECORD IS
  // ONE LINE ITEM, not one estimate: the ESTIMATE is the WORKSHEET, and the
  // worksheet-level facts (jobId, jobName, contractPrice, proposalStatus,
  // worksheetLocked) are repeated on every line of it. estimate-match.js
  // groups by worksheetId and orders by displayOrder; this registry only
  // reads lines.
  //
  // These keys were NOT taken from a pull when they were written: they were the
  // labels of ONE record’s detail panel in the Clickr UI (2026-09-20), and
  // describeMapping() is what settles a claim like that — without echoing a
  // value, because a declared key no record carries lands in missingKeys and
  // the key the records really use lands in unexpectedKeys. THE DIAGNOSTIC HAS
  // NOW BEEN READ AGAINST ALL 277 LIVE RECORDS, and this entry is what it says:
  //
  //   * every key below is carried by all 277 records (assemblyId by 265), and
  //     the required key jobName reads usable on 277 of 277;
  //   * ‘item’ WAS WRONG. It was declared from the LIST view’s "Item" column
  //     and NO record carries it: the real key is ‘itemTitle’, carried by all
  //     277. It was the least certain key in the entry and it is now the
  //     settled one — by the diagnostic, which is the instrument this entry
  //     was built to be settled by.
  //   * ‘description’ is a SECOND text field, on 44 of the 277: Buildertrend’s
  //     per-line description beside the title. It is declared and read because
  //     a P86 line has to print something and a line whose title is blank (a
  //     sampled row read "Item —") can print this instead — see
  //     lineDescription() in estimate-match.js, which is a VALUE fallback and
  //     never a fallback chain of key names. A P86 estimate line has exactly
  //     ONE text field, so a line carrying both keeps its title and the
  //     worksheet SAYS the description was not carried.
  //   * costTypes (277), relatedItems (277), relatedPurchaseOrderLineItemId (4)
  //     and internalNotes (2) are real keys this sync does NOT declare, so they
  //     stay in unexpectedKeys for good. That is the honest state and not a
  //     defect to be tidied away: declaring a key nothing reads would make the
  //     diagnostic quieter and the sync no better informed.
  //
  // readEstimateLine() below reads each key exactly as named, with no candidate
  // list and no fallback (see the header of this file), so a wrong name reads
  // as ABSENT and never as a wrong value.
  estimates: {
    key: 'estimates',
    label: 'Estimates',
    noun: 'estimate',
    datasetId: '6aa5d2a084f8135cf0cc607d',
    // jobName, for the bills reasoning and two more of its own.
    //
    // WHY: a worksheet is matched ONLY inside the P86 job its Buildertrend job
    // is linked to, and a record with no job is refused whatever else it
    // carries — so a dataset that lost its job column is a dataset that
    // classifies nothing, which is the condition this 95% guard exists to
    // catch. Both job-scoped datasets of a full pull carried jobName on every
    // record, and jobName is repeated on every LINE of a worksheet, so the
    // share is measured over lines without being diluted.
    //
    //   NOT lineItemId — it is the idKey. A required key that is the id asks
    //     only "did Clickr send ids", which fetchDataset already dedupes on and
    //     reports, and it would sit at 100% with every business field renamed
    //     underneath it.
    //   NOT worksheetId — the grouping key, and the thing this sync acts on,
    //     but an opaque number. usableName screens through isBtBlank, a TEXT
    //     blankness test, so a numeric id can NEVER read blank and the guard
    //     would pass vacuously on a dataset whose every other key had moved.
    //   NOT itemTitle — the line’s own name, and blank on real records (a
    //     sampled row read "Item —"). Requiring it would refuse the whole
    //     dataset over a key that costs one line its printed name.
    //   NOT costCodeTitle or groupTitle — a line need belong to neither.
    requiredKey: 'jobName',
    // THE LINE’S OWN id, and getting this wrong is expensive: fetchDataset
    // dedupes on idKey and marks a read PARTIAL when an id arrives twice, and a
    // partial read blocks every apply. Keying on worksheetId (or on jobId)
    // would make all 277 lines look like a handful of records arriving over and
    // over. The WORKSHEET id is what estimate-match.js exposes as the row’s
    // btId; the LINE id is only ever the read’s identity.
    idKey: 'lineItemId',
    keys: [
      'lineItemId', 'worksheetId', 'groupId', 'assemblyId', 'costCodeId', 'costCategoryId', 'formatId',
      'costCodeTitle', 'costCategoryName', 'groupTitle', 'groupPath', 'displayOrder', 'lineItemType', 'markedAs',
      'itemTitle', 'description',
      'quantity', 'unitCost', 'builderCost', 'markupType', 'markupPercent', 'markupPerUnit', 'markupAmount',
      'margin', 'unitPrice', 'ownerPrice', 'amountInvoiced', 'totalWithTax',
      'jobId', 'jobName', 'contractPrice', 'proposalStatus', 'worksheetLocked', 'isSentToBudget',
      'hasRelatedPurchaseOrder', 'dateAdded', 'isDeleted',
    ],
  },
  // TASKS — Buildertrend's to-dos: 578 records over 64 jobs. UNLIKE bills and
  // estimates, these key names were never a claim off a detail panel waiting to
  // be settled. They are what services/clickr/scout.js MEASURED over a complete
  // read of the live dataset on 2026-09-20 (fetched 578 of 578, 3 pages,
  // complete). Every key below is carried by at least one record and nothing
  // undeclared is carried at all. Clickr's record-detail panel lists eight
  // fields; 'notes' (141 records) and 'dueDate' (128) are NOT among them and
  // were found only by that measurement, which is the argument for measuring.
  //
  // THE ONE THING THIS ENTRY EXISTS TO SAY OUT LOUD:
  // isCompleted AND status DISAGREE, AND ONLY isCompleted IS COMPLETION.
  //
  //     isCompleted   578 carried, 578 non-empty, 2 distinct: false 490, true 88
  //     status        578 carried, 578 non-empty, 2 distinct: Completed 544, Pending 34
  //     completedAt    88 carried,  88 non-empty, 3 distinct
  //
  // completedAt is carried by EXACTLY 88 records — the same 88 isCompleted
  // calls done — so isCompleted is the per-task completion flag. 544
  // "Completed" against 88 completions is not a task-level fact at all; it is
  // almost certainly the state of the Buildertrend to-do LIST the task hangs
  // on. (Three distinct completion dates across 88 tasks says the same thing
  // from the other side: those 88 were closed on three days, in batches, which
  // is what finishing a LIST looks like and not what 88 people finishing 88
  // jobs looks like.) So the real split is 490 OPEN and 88 DONE.
  //
  // task-match.js therefore reads isCompleted and nothing else for completion,
  // and carries Buildertrend's own status WORD across to tasks.bt_task_status —
  // beside the P86 status, never as one. Reading status as completion instead
  // would mark 456 open tasks finished in a single press. If a later
  // measurement contradicts this, the measurement is what says so; this comment
  // is not evidence.
  tasks: {
    key: 'tasks',
    label: 'Tasks',
    noun: 'task',
    datasetId: '6aa5da9184f8135cf0cc6327',
    // jobName, for the reason bills and estimates use it, plus one the
    // measurement supplies.
    //
    // WHY: a task is matched ONLY inside the P86 job its Buildertrend job is
    // linked to, and a record with no job is refused whatever else it carries —
    // so a dataset that lost its job column is a dataset that classifies
    // nothing, which is the condition this 95% guard exists to catch. jobName
    // read usable on 578 of 578.
    //
    //   NOT taskId — it is the idKey. A required key that is the id asks only
    //     "did Clickr send ids", which fetchDataset already dedupes on and
    //     reports, and it would sit at 100% with every business field renamed
    //     underneath it.
    //   NOT jobId — the real matching key, but an opaque number. usableName
    //     screens through isBtBlank, a TEXT blankness test that answers false
    //     for every number, so a numeric key passes this guard VACUOUSLY and
    //     proves nothing about the dataset. jobName is its human twin: it moves
    //     when the job columns are renamed, and it is what the row prints.
    //   NOT isCompleted — worse than vacuous, in the other direction.
    //     scalarText() answers null for a boolean, so usableName would read 0
    //     of 578 and REFUSE THE WHOLE DATASET over a key that is present and
    //     correct on every record.
    //   NOT status — it would pass at 578 of 578, and that is the trap. This
    //     entry exists to warn that status is not what it looks like; making it
    //     the dataset's admission test would stake 578 rows on the one field
    //     nothing here is allowed to trust.
    //   NOT title — the rung-2 match key, and a match key's job is to
    //     discriminate rows, not to admit a dataset. It repeats heavily (153
    //     distinct over 578) and a blank one must cost THAT ROW its rung, never
    //     cost the tab its 578 rows.
    requiredKey: 'jobName',
    // THE TASK'S OWN id — 578 distinct over 578 records, which is what an
    // identity looks like. fetchDataset dedupes the read on idKey and marks a
    // read PARTIAL when one arrives twice, and a partial read blocks every
    // apply, so keying on jobId (64 distinct) would make 578 tasks look like 64
    // records arriving over and over and would block the tab outright.
    idKey: 'taskId',
    keys: [
      'taskId', 'title', 'jobId', 'jobName',
      'isCompleted', 'status', 'completedAt', 'dueDate',
      'assignedUsers', 'notes',
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
    // DECLARED SINCE THE BEGINNING AND NEVER READ. The registry listed these
    // four, so describeMapping reported them present and healthy, and the
    // reader dropped them on the floor — 72 of 75 live leads carry notes, all
    // 72 of them different. That is the declared-but-unread shape, and the
    // diagnostic cannot catch it: it checks what Buildertrend SENDS against
    // what the registry DECLARES, never what the reader actually takes.
    notes: scalarText(r.notes),
    nextActivityDate: scalarText(r.nextActivityDate),
    nextActivityTitle: scalarText(r.nextActivityTitle),
    nextActivityAssignee: scalarText(r.nextActivityAssignee),
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

// ONE LINE of a Buildertrend estimate worksheet. Every key is read EXACTLY as
// declared in the registry and never through a fallback, and every one of them
// may simply be ABSENT: this mapping came from a detail panel rather than a
// pull, so a name that turns out to be wrong has to read as null here — never
// crash the read, never read as a wrong value — and show itself in
// describeMapping instead.
//
// btId IS THE WORKSHEET, NOT THE LINE, and that is deliberate. Every other
// dataset’s btId is the record’s own id because the record IS the thing a
// person acts on. Here the record is a LINE and the thing a person acts on is
// the WORKSHEET: estimate-match.js emits one row per worksheet, sync-apply acts
// on the ids those rows carry, and since-refresh remembers one snapshot per
// worksheet. The line’s own id is `lineId`, and it is what DATASETS.estimates
// declares as idKey so fetchDataset dedupes the READ on the right thing.
function readEstimateLine(rec) {
  const r = isPlainObject(rec) ? rec : {};
  return {
    btId: scalarText(r.worksheetId),
    lineId: scalarText(r.lineItemId),
    groupId: scalarText(r.groupId),
    groupTitle: scalarText(r.groupTitle),
    groupPath: scalarText(r.groupPath),
    // Buildertrend’s own ordering inside the worksheet. A number, or null when
    // Clickr sent something else — estimate-match.js then falls back to the
    // order the records arrived in, which it says out loud.
    displayOrder: typeof r.displayOrder === 'number' && Number.isFinite(r.displayOrder) ? r.displayOrder
      : (typeof r.displayOrder === 'string' && /^-?\d+(\.\d+)?$/.test(r.displayOrder.trim()) ? Number(r.displayOrder.trim()) : null),
    lineItemType: scalarText(r.lineItemType),
    markedAs: scalarText(r.markedAs),
    // THE LINE’S OWN NAME, and Buildertrend’s own description beside it. Both
    // are settled keys of the live dataset (itemTitle on all 277 records,
    // description on 44). Which one a P86 line PRINTS is decided in
    // estimate-match.js, because P86 has one text field for the two of them.
    itemTitle: scalarText(r.itemTitle),
    description: scalarText(r.description),
    costCodeTitle: scalarText(r.costCodeTitle),
    costCategoryName: scalarText(r.costCategoryName),
    assemblyId: scalarText(r.assemblyId),
    // Money and quantities keep their native shape (a number, a string or
    // {value, scale}); bt-match’s parseMoney reads all three, and this reader
    // never decides what any of them means.
    quantity: r.quantity === undefined ? null : r.quantity,
    unitCost: r.unitCost === undefined ? null : r.unitCost,
    builderCost: r.builderCost === undefined ? null : r.builderCost,
    // The markup TYPE and the four figures beside it. The type is a NUMERIC
    // CODE ("1", "5"), not a word, and the figures are NOT mutually exclusive:
    // Buildertrend populates all four on every line and the type only records
    // which one the person typed. estimate-match.js reads the PERCENT and
    // checks it against ownerPrice rather than gating on the type. Read here
    // exactly as named; decided there.
    markupType: scalarText(r.markupType),
    markupPercent: r.markupPercent === undefined ? null : r.markupPercent,
    markupPerUnit: r.markupPerUnit === undefined ? null : r.markupPerUnit,
    markupAmount: r.markupAmount === undefined ? null : r.markupAmount,
    margin: r.margin === undefined ? null : r.margin,
    unitPrice: r.unitPrice === undefined ? null : r.unitPrice,
    ownerPrice: r.ownerPrice === undefined ? null : r.ownerPrice,
    amountInvoiced: r.amountInvoiced === undefined ? null : r.amountInvoiced,
    totalWithTax: r.totalWithTax === undefined ? null : r.totalWithTax,
    jobId: scalarText(r.jobId),
    jobName: scalarText(r.jobName),
    // WORKSHEET-LEVEL, repeated on every line. estimate-match refuses a
    // worksheet whose lines disagree about any of them rather than averaging.
    contractPrice: r.contractPrice === undefined ? null : r.contractPrice,
    proposalStatus: scalarText(r.proposalStatus),
    worksheetLocked: r.worksheetLocked === true,
    isSentToBudget: r.isSentToBudget === true,
    hasRelatedPurchaseOrder: r.hasRelatedPurchaseOrder === true,
    dateAdded: scalarText(r.dateAdded),
    isDeleted: r.isDeleted === true,
  };
}

// A Buildertrend TO-DO. Every key is read EXACTLY as declared in the registry
// and never through a fallback of names (see the header of this file), so a key
// Clickr renames reads as ABSENT here and shows itself in describeMapping —
// never as a wrong value.
function readTask(rec) {
  const r = isPlainObject(rec) ? rec : {};
  const assigned = scalarText(r.assignedUsers);
  return {
    btId: scalarText(r.taskId),
    title: scalarText(r.title),
    jobId: scalarText(r.jobId),
    jobName: scalarText(r.jobName),
    // THE COMPLETION FLAG, AND IT IS THREE-STATE ON PURPOSE.
    //
    // The live dataset sends booleans (490 false, 88 true) and `=== true` is
    // the reading every other flag in this file uses. It is wrong here, because
    // the answer it gives to a value that is NOT a boolean is "not done" — so a
    // retyped or renamed field would report all 578 tasks open, quietly, with
    // no diagnostic and no refusal, and the one dataset whose completion is
    // already contested would have lost it in silence. true is done, false is
    // open, and ANYTHING ELSE (absent, a string, a number) is null: Buildertrend
    // did not say. task-match.js proposes no completion on a null and says why
    // on the row.
    isCompleted: r.isCompleted === true ? true : (r.isCompleted === false ? false : null),
    // BUILDERTREND'S OWN STATUS WORD, WHICH IS NOT COMPLETION — see the registry
    // entry for the measurement that settles that. Read through scalarText so a
    // numeric code arrives as its own digits rather than as null, and carried
    // across as a word (tasks.bt_task_status) beside the P86 status.
    statusText: scalarText(r.status),
    completedAt: scalarText(r.completedAt),
    dueDate: scalarText(r.dueDate),
    notes: scalarText(r.notes),
    // ASSIGNED PEOPLE, PLURAL, and the plural is the whole difficulty: P86's
    // assignee_user_id is one real foreign key to users(id). A LIST is read
    // through names(), which takes the two shapes a Clickr list arrives in
    // (plain strings, or objects carrying a name) and nothing else.
    //
    // A BARE STRING IS ONE NAME AND IS NEVER SPLIT. No comma, no slash, no
    // semicolon: "Ruiz, Ana" is one person, and splitting on a delimiter would
    // invent two who do not exist and then hand one of them somebody's work. If
    // a single string really does hold two people it resolves to nobody and the
    // task imports UNASSIGNED, which is the honest outcome. What a list of
    // names MEANS is decided in task-match.js resolveAssignee, not here.
    assignedUsers: Array.isArray(r.assignedUsers) ? names(r.assignedUsers)
      : (assigned != null && assigned.trim() !== '' ? [assigned.trim()] : []),
  };
}

function readRecord(kind, rec) {
  if (kind === 'jobs') return readJob(rec);
  if (kind === 'clients') return readClient(rec);
  if (kind === 'changeOrders') return readChangeOrder(rec);
  if (kind === 'purchaseOrders') return readPurchaseOrder(rec);
  if (kind === 'bills') return readBill(rec);
  if (kind === 'estimates') return readEstimateLine(rec);
  if (kind === 'tasks') return readTask(rec);
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

module.exports = { DATASETS, REQUIRED_SHARE, readRecord, readJob, readLead, readChangeOrder, readPurchaseOrder, readBill, readEstimateLine, readTask, describeMapping, customField, isPlainObject };
