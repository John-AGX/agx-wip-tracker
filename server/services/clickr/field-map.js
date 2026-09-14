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

function readRecord(kind, rec) {
  if (kind === 'jobs') return readJob(rec);
  if (kind === 'clients') return readClient(rec);
  if (kind === 'changeOrders') return readChangeOrder(rec);
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

module.exports = { DATASETS, REQUIRED_SHARE, readRecord, readJob, readLead, readChangeOrder, describeMapping, customField, isPlainObject };
