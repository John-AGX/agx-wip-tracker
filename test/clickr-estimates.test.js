// Buildertrend estimate worksheets -> P86 estimates
// (services/clickr/estimate-match.js, field-map.js, sync-preview.js,
// sync-apply.js, since-refresh.js).
//
// The promises this file exists to hold:
//   * A CLICKR RECORD IS ONE LINE ITEM AND A ROW IS ONE WORKSHEET. The read
//     dedupes on the LINE's id (keying it on the worksheet's would mark every
//     read partial and block every apply), and the matcher groups by worksheet,
//     orders by display order and turns each group into a header-delimited
//     section, which is the only shape P86 subgroups have;
//   * MARKUP IS NEVER GUESSED. A percent and a margin map across losslessly —
//     both are price = cost x k — and both are PROVED by pricing the imported
//     lines through P86's own pricing pipeline and comparing the answer with
//     Buildertrend's ownerPrice. A per-unit or flat markup is NOT price = cost
//     x k, so the whole worksheet is refused rather than imported at a number
//     that only matches until somebody edits a quantity;
//   * MONEY NEVER MOVES BY ITSELF. The line items are a held-back itemTitle: the
//     safe press does not apply them, an "apply everything" press that names no
//     fields does not apply them, and the DATABASE ROW is asserted unchanged
//     after both. The contract price and the total difference are never applied
//     at all;
//   * A SENT OR SOLD P86 ESTIMATE IS NEVER REWRITTEN. Its data blob is asserted
//     BYTE-IDENTICAL after a press that names every field;
//   * a worksheet whose lines disagree about a worksheet-level fact is refused,
//     never averaged; a worksheet whose every line is deleted is refused and
//     the P86 estimate linked to it is named; two worksheets that land on one
//     P86 estimate are refused, never guessed between;
//   * every read and write is this organization's, and a created estimate takes
//     its organization from its parent JOB, never from the request;
//   * describeMapping names a declared key no record carries and a carried key
//     nothing declares — the diagnostic that confirms the real key names after
//     deploy, since CLICKR_API_KEY could not be reached from here.
//
// Driven through the real express router, requireAuth / requireOrg /
// ROLES_MANAGE, a JWT, and the pg-sqlite engine derived from server/db.js.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(tableNames(), { pk: { organizations: 'id', users: 'id', roles: 'name', jobs: 'id', leads: 'id', clients: 'id', estimates: 'id' } }),
  { jsonColumns: ['data'] }
);

globalThis.__P86_CLICKR_EST_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLICKR_EST_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});
jest.mock('../server/geocoder', () => ({ geocodeAddress: async () => null, geocodeViaGoogle: async () => null, geocodeViaCensus: async () => null }));

const { DATASETS, readRecord, readEstimateLine, describeMapping } = require('../server/services/clickr/field-map');
const preview = require('../server/services/clickr/sync-preview');
const estMatch = require('../server/services/clickr/estimate-match');
const { matchEstimates } = estMatch;
const applyMod = require('../server/services/clickr/sync-apply');
const since = require('../server/services/clickr/since-refresh');
const estimateTotals = require('../server/services/money/estimate-totals');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const orgRoutes = require('../server/routes/admin-organizations-routes');

const KEY = 'ck_live_Zq9SECRETKEYxy7_0123456789ab';
const BASE = 'https://api.clickr.cloud';
const AGX = 1;
const OTHER = 2;

// Clickr's REST records carry NO _id: identity is lineItemId, and MANY records
// share a worksheetId — which is the whole shape of this dataset. Every declared
// key is present on every fixture record, so a mapping diagnostic that reports
// anything is reporting a real drift.
function lineRec(o) {
  const qty = o.qty === undefined ? 1 : o.qty;
  const cost = o.cost === undefined ? 0 : o.cost;
  return {
    accountId: 'a', integrationId: 'i', builderId: 'b',
    lineItemId: String(o.id),
    worksheetId: String(o.ws),
    groupId: o.groupId === undefined ? null : o.groupId,
    assemblyId: null, costCodeId: '5', costCategoryId: '2', formatId: '9',
    costCodeTitle: o.costCodeTitle === undefined ? 'Subcontractors Costs' : o.costCodeTitle,
    costCategoryName: 'Subcontractor',
    groupTitle: o.groupTitle === undefined ? null : o.groupTitle,
    groupPath: o.groupPath === undefined ? null : o.groupPath,
    displayOrder: o.order === undefined ? null : o.order,
    lineItemType: 'Line item',
    markedAs: 'Estimate',
    itemTitle: o.itemTitle === undefined ? null : o.itemTitle,
    // Buildertrend's SECOND text field, carried by every record and filled on
    // 44 of the real 277. A P86 line has ONE text field, so the fixtures that
    // set both prove which one is printed and that the other is NAMED.
    description: o.description === undefined ? null : o.description,
    quantity: qty,
    unitCost: cost,
    builderCost: qty * cost,
    markupType: o.markupType === undefined ? 'Percent' : o.markupType,
    markupPercent: o.markupPercent === undefined ? 0 : o.markupPercent,
    markupPerUnit: o.markupPerUnit === undefined ? 0 : o.markupPerUnit,
    markupAmount: o.markupAmount === undefined ? 0 : o.markupAmount,
    margin: o.margin === undefined ? 0 : o.margin,
    unitPrice: qty > 0 && typeof o.owner === 'number' ? o.owner / qty : 0,
    ownerPrice: o.owner === undefined ? 0 : o.owner,
    amountInvoiced: 0,
    totalWithTax: o.owner === undefined ? 0 : o.owner,
    jobId: String(o.jobId),
    jobName: o.jobName,
    contractPrice: o.contractPrice === undefined ? 100000 : o.contractPrice,
    proposalStatus: o.proposalStatus === undefined ? 'Draft' : o.proposalStatus,
    worksheetLocked: !!o.worksheetLocked,
    isSentToBudget: false,
    hasRelatedPurchaseOrder: false,
    dateAdded: '2026-03-01T10:00:00',
    isDeleted: !!o.deleted,
    raw: { secret: 'never read' },
  };
}

const CITI = { jobId: 111, jobName: 'Citi Lakes' };
const WATER = { jobId: 222, jobName: 'Waterside III' };
const SADDLE = { jobId: 333, jobName: 'Saddlebrook' };
const OAK = { jobId: 444, jobName: 'Oak Ridge' };
const PALM = { jobId: 555, jobName: 'Palm Bay' };
const BELLA = { jobId: 666, jobName: 'Bella Vista' };
const LAKE = { jobId: 777, jobName: 'Lakeview' };
const RIVER = { jobId: 888, jobName: 'Riverwalk' };
const NOJOB = { jobId: 999, jobName: 'Unlinked Job' };

const L = (base, o) => lineRec(Object.assign({}, base, o));

const BT_LINES = [
  // ws 100 — display order OUT of arrival order, two groups, one deleted line.
  L(CITI, { ws: 100, id: 1001, groupId: 'G1', groupTitle: 'Labor', order: 2, itemTitle: 'Framing labor', qty: 10, cost: 50, markupPercent: 20, owner: 600 }),
  L(CITI, { ws: 100, id: 1002, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'Cleanup', qty: 1, cost: 100, markupPercent: 0, owner: 100 }),
  L(CITI, { ws: 100, id: 1003, groupId: 'G2', groupTitle: 'Materials', order: 3, itemTitle: 'Lumber', qty: 4, cost: 25, markupPercent: 10, owner: 110 }),
  L(CITI, { ws: 100, id: 1004, groupId: 'G1', groupTitle: 'Labor', order: 4, itemTitle: 'Removed', qty: 99, cost: 99, markupPercent: 50, owner: 9999, deleted: true }),

  // ws 200 — rung 0, and P86 already holds exactly these lines.
  L(WATER, { ws: 200, id: 2001, groupId: 'G3', groupTitle: 'Sub', order: 1, itemTitle: 'Stucco', qty: 1, cost: 2000, markupPercent: 15, owner: 2300 }),

  // ws 300 — its P86 estimate was SENT to a client.
  L(OAK, { ws: 300, id: 3001, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'Paint', qty: 2, cost: 300, markupPercent: 25, owner: 750 }),

  // ws 400 — NEW, with an ungrouped line, a MARGIN line and two groups whose
  // titles are equal but whose paths are not.
  L(PALM, { ws: 400, id: 4001, order: 1, itemTitle: 'Mobilization', qty: 1, cost: 500, markupPercent: 10, owner: 550 }),
  L(PALM, { ws: 400, id: 4002, groupId: 'G4', groupTitle: 'Labor', groupPath: 'Building A > Labor', order: 2, itemTitle: 'Trim', qty: 3, cost: 100, markupType: '5', markupPercent: 25, margin: 20, owner: 375 }),
  L(PALM, { ws: 400, id: 4003, groupId: 'G5', groupTitle: 'Labor', groupPath: 'Building B > Labor', order: 3, itemTitle: 'Trim B', qty: 2, cost: 100, markupPercent: 25, owner: 250 }),
  L(PALM, { ws: 400, id: 4004, groupId: 'G4', groupTitle: 'Labor', groupPath: 'Building A > Labor', order: 4, itemTitle: 'Trim extra', qty: 1, cost: 40, markupPercent: 0, owner: 40 }),

  // ws 500 and 501 — two worksheets on one job, so both key on the same title
  // and both land on the same P86 estimate.
  L(BELLA, { ws: 500, id: 5001, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'A', qty: 1, cost: 10, markupPercent: 0, owner: 10 }),
  L(BELLA, { ws: 501, id: 5011, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'B', qty: 1, cost: 20, markupPercent: 0, owner: 20 }),

  // ws 600 — its Buildertrend job is not linked to a P86 job.
  L(NOJOB, { ws: 600, id: 6001, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'C', qty: 1, cost: 30, markupPercent: 0, owner: 30 }),

  // ws 700 — EVERY line deleted, and a P86 estimate is linked to it.
  L(CITI, { ws: 700, id: 7001, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'D', qty: 1, cost: 40, markupPercent: 0, owner: 40, deleted: true }),
  L(CITI, { ws: 700, id: 7002, groupId: 'G1', groupTitle: 'Labor', order: 2, itemTitle: 'E', qty: 1, cost: 50, markupPercent: 0, owner: 50, deleted: true }),

  // ws 800 — its lines DISAGREE about the worksheet's contract price.
  L(CITI, { ws: 800, id: 8001, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'F', qty: 1, cost: 60, markupPercent: 0, owner: 60, contractPrice: 100000 }),
  L(CITI, { ws: 800, id: 8002, groupId: 'G1', groupTitle: 'Labor', order: 2, itemTitle: 'G', qty: 1, cost: 70, markupPercent: 0, owner: 70, contractPrice: 250000 }),

  // ws 900 / 901 / 902 — the three lines P86 cannot carry, and not one of them
  // is refused for the WORD Buildertrend used.
  L(CITI, { ws: 900, id: 9001, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'Fine', qty: 1, cost: 80, markupPercent: 10, owner: 88 }),
  // Typed as a per-unit markup (code "2") — and the percent Buildertrend wrote
  // beside it does NOT reproduce what it says the owner pays. THAT refuses it.
  L(CITI, { ws: 900, id: 9002, groupId: 'G1', groupTitle: 'Labor', order: 2, itemTitle: 'Flat rate door', qty: 2, cost: 100, markupType: '2', markupPerUnit: 25, markupAmount: 50, owner: 250 }),
  // No markup percent AT ALL, which is the one thing here only the mapping
  // diagnostic can settle.
  L(CITI, { ws: 901, id: 9011, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'No percent', qty: 1, cost: 90, markupType: null, markupPercent: null, owner: 90 }),
  // A flat markup on a ZERO cost: 0 x k is 0 for every k, so no percent
  // expresses it — and the CHECK is what says so now.
  L(CITI, { ws: 902, id: 9021, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'Permit', qty: 1, cost: 0, markupType: '3', markupAmount: 500, owner: 500 }),

  // ws 1000 — a P86 estimate this sync already linked that has LOST its job.
  L(SADDLE, { ws: 1000, id: 10001, groupId: 'G1', groupTitle: 'Labor', order: 1, itemTitle: 'H', qty: 1, cost: 120, markupPercent: 0, owner: 120 }),

  // ws 1100 — Buildertrend's owner price does NOT agree with its own markup:
  // 1000 x 1.20 is 1200 and it says the owner pays 1500. The LINE is refused
  // and the worksheet with it.
  L(LAKE, { ws: 1100, id: 11001, groupId: 'G3', groupTitle: 'Sub', order: 1, itemTitle: 'Roof', qty: 1, cost: 1000, markupPercent: 20, owner: 1500 }),

  // ws 1200 — one line that checks out and one whose owner price is not
  // readable money at all. Nothing could check the second, so it is imported
  // and the WORKSHEET TOTAL is what names the difference.
  L(LAKE, { ws: 1200, id: 12001, groupId: 'G3', groupTitle: 'Sub', order: 1, itemTitle: 'Gutters', qty: 1, cost: 1000, markupPercent: 20, owner: 1200 }),
  L(LAKE, { ws: 1200, id: 12002, groupId: 'G3', groupTitle: 'Sub', order: 2, itemTitle: 'Soffit', qty: 1, cost: 500, markupPercent: 0, owner: '1 - 2' }),

  // ws 1300 — THE FOUR REAL LINES, by their real numbers, read out of Clickr's
  // own UI on 2026-09-20. Every one carries all four markup notations and
  // markupType is the CODE saying which one the person typed.
  L(RIVER, { ws: 1300, id: 13001, groupId: 'G8', groupTitle: 'Sitework', order: 1, itemTitle: 'A — percent typed', qty: 1, cost: 5100, markupType: '1', markupPercent: 100, markupPerUnit: 5100, markupAmount: 5100, margin: 50, owner: 10200 }),
  L(RIVER, { ws: 1300, id: 13002, groupId: 'G8', groupTitle: 'Sitework', order: 2, itemTitle: 'B — the rounded percent', qty: 1, cost: 770, markupType: '5', markupPercent: 88.68, markupPerUnit: 682.83, markupAmount: 682.83, margin: 47, owner: 1452.83 }),
  L(RIVER, { ws: 1300, id: 13003, groupId: 'G8', groupTitle: 'Sitework', order: 3, itemTitle: 'C — margin typed', qty: 1, cost: 9600, markupType: '5', markupPercent: 150, markupPerUnit: 14400, markupAmount: 14400, margin: 60, owner: 24000 }),
  L(RIVER, { ws: 1300, id: 13004, groupId: 'G8', groupTitle: 'Sitework', order: 4, itemTitle: 'D — excluded at -100%', description: 'Cabinets the owner is not being charged for', qty: 1, cost: 36000, markupType: '1', markupPercent: -100, markupPerUnit: -36000, markupAmount: -36000, margin: 0, owner: 0 }),

  // ws 1301 — a markup type code this sync has never seen. It imports, because
  // the PERCENT is what is used.
  L(RIVER, { ws: 1301, id: 13011, groupId: 'G8', groupTitle: 'Sitework', order: 1, itemTitle: 'Unknown code', qty: 1, cost: 200, markupType: '7', markupPercent: 25, owner: 250 }),
];

function clickrFetch(url) {
  const u = new URL(url);
  if (u.origin !== BASE) throw new Error('test: fetch reached a non-Clickr host');
  const skip = Number(u.searchParams.get('skip') || 0);
  const limit = Number(u.searchParams.get('limit') || 200);
  const list = u.pathname.includes(DATASETS.estimates.datasetId) ? BT_LINES : null;
  if (!list) return Promise.resolve({ status: 404, text: async () => '{"error":"Route not found"}' });
  const body = { recordType: 'x', columns: [], records: list.slice(skip, skip + limit), count: list.length, sort: {} };
  return Promise.resolve({ status: 200, text: async () => JSON.stringify(body) });
}

// The P86 line array a worksheet would produce, stamped into a document — the
// SAME builder the sync uses, so a fixture cannot drift from it.
function builtFor(wsId, estId, altId) {
  const live = BT_LINES.filter((r) => r.worksheetId === String(wsId)).map(readEstimateLine).filter((v) => !v.isDeleted);
  const b = estMatch.buildLines(live, String(wsId));
  return b.lines.map((l) => Object.assign({}, l, { estimateId: estId, alternateId: altId }));
}

function estBlob(id, title, lines, extra) {
  const altId = 'alt-' + id;
  return JSON.stringify(Object.assign({
    id, title, client: '',
    lines: (lines || []).map((l) => Object.assign({}, l, { estimateId: id, alternateId: altId })),
    alternates: [{ id: altId, estimateId: id, name: 'Base' }],
    activeAlternateId: altId,
  }, extra || {}));
}

const plain = (n, desc, qty, cost, markup) => ({ id: 'l' + n, description: desc, qty, unit: 'ea', unitCost: cost, markup });

function seed() {
  engine.db.exec(`
    DELETE FROM jobs; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations; DELETE FROM estimates;
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ROLES_MANAGE","USERS_MANAGE","JOBS_VIEW_ALL","ESTIMATES_EDIT"]'),
      ('pm', 'PM', '["JOBS_VIEW_ALL","LEADS_VIEW"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'admin@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (11, 'pm@agx.test', 'x', 'Pat PM', 'pm', 1, 1),
      (20, 'admin@other.test', 'x', 'Oscar Other', 'admin', 2, 1);
  `);
  const job = engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, bt_job_id, data) VALUES (?,?,?,?,?)');
  // ANOTHER TENANT’s jobs, carrying the SAME Buildertrend job ids as ours, and
  // inserted FIRST on purpose: a statement that forgets its organisation
  // predicate takes rows in insertion order, so a foreign job is the one it
  // reaches. Ordered the other way round, a missing predicate would pass by
  // luck rather than by being right.
  job.run('j-b', 20, OTHER, '111', JSON.stringify({ jobNumber: 'RV2004', title: 'Citi Lakes', status: 'In Progress' }));
  job.run('j-b2', 20, OTHER, '555', JSON.stringify({ jobNumber: 'RV2030', title: 'Palm Bay', status: 'In Progress' }));
  job.run('j-1', 10, AGX, '111', JSON.stringify({ jobNumber: 'RV2004', title: 'Citi Lakes', status: 'In Progress' }));
  job.run('j-2', 10, AGX, '222', JSON.stringify({ jobNumber: 'RV2000', title: 'Waterside III', status: 'In Progress' }));
  job.run('j-3', 10, AGX, '333', JSON.stringify({ jobNumber: 'RV2013', title: 'Saddlebrook', status: 'In Progress' }));
  job.run('j-4', 10, AGX, '444', JSON.stringify({ jobNumber: 'RV2020', title: 'Oak Ridge', status: 'In Progress' }));
  job.run('j-5', 10, AGX, '555', JSON.stringify({ jobNumber: 'RV2030', title: 'Palm Bay', status: 'In Progress' }));
  job.run('j-6', 10, AGX, '666', JSON.stringify({ jobNumber: 'RV2040', title: 'Bella Vista', status: 'In Progress' }));
  job.run('j-7', 10, AGX, '777', JSON.stringify({ jobNumber: 'RV2050', title: 'Lakeview', status: 'In Progress' }));
  job.run('j-8', 10, AGX, '888', JSON.stringify({ jobNumber: 'RV2060', title: 'Riverwalk', status: 'In Progress' }));


  const est = engine.db.prepare(
    'INSERT INTO estimates (id, owner_id, organization_id, attached_job_id, bt_worksheet_id, data, is_locked, sent_at, sent_count, approval_status, accepted_at, approved_at, declined_at) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const E = (id, org, jobId, btWs, title, lines, flags) => {
    const f = flags || {};
    est.run(id, 10, org, jobId, btWs, estBlob(id, title, lines, f.extra), f.locked ? 1 : 0,
      f.sentAt || null, f.sentCount || 0, f.approvalStatus || null, f.acceptedAt || null, f.approvedAt || null, f.declinedAt || null);
  };
  // rung 1, and P86's lines are NOT Buildertrend's.
  E('est-a', AGX, 'j-1', null, 'Citi Lakes', [plain(1, 'Old line', 1, 999, 0)]);
  // rung 0, and P86's lines ARE Buildertrend's.
  E('est-b', AGX, 'j-2', '200', 'Waterside III', []);
  engine.db.prepare('UPDATE estimates SET data = ? WHERE id = ?')
    .run(estBlob('est-b', 'Waterside III', []).replace('"lines":[]', '"lines":' + JSON.stringify(builtFor(200, 'est-b', 'alt-est-b'))), 'est-b');
  // SENT to a client, unlinked, title matches the worksheet.
  E('est-sent', AGX, 'j-4', null, 'Oak Ridge', [plain(2, 'What the client got', 1, 1, 0)], { sentAt: '2026-03-02T00:00:00Z', sentCount: 1 });
  // the target of the two claiming worksheets.
  E('est-claim', AGX, 'j-6', null, 'Bella Vista', [plain(3, 'x', 1, 1, 0)]);
  // linked to the worksheet whose every line is deleted.
  E('est-gone', AGX, 'j-1', '700', 'Gone in Buildertrend', [plain(4, 'y', 1, 1, 0)]);
  // ANOTHER TENANT’s jobless estimate carrying the SAME Buildertrend worksheet
  // id, inserted BEFORE ours for the reason the foreign jobs are: an estimate
  // with no job has no parent row to be scoped THROUGH, so the only thing
  // keeping it out of this read is the read’s own organisation predicate, and a
  // read that lost it would reach this one first.
  E('est-loose-x', OTHER, null, '1000', 'Saddlebrook', [plain(9, 'foreign and jobless', 1, 1, 0)]);
  // linked, and it has LOST its job.
  E('est-loose', AGX, null, '1000', 'Saddlebrook', [plain(5, 'z', 1, 1, 0)]);
  // where Buildertrend's owner price disagrees with its own markup.
  E('est-diff', AGX, 'j-7', null, 'Lakeview', [plain(6, 'w', 1, 1, 0)]);
  // P86-only, on a job this read reaches: listed under "not in Buildertrend".
  E('est-only', AGX, 'j-2', null, 'A P86 proposal Buildertrend never saw', [plain(7, 'v', 1, 1, 0)]);
  // ANOTHER TENANT's estimate, on its own job carrying the same BT job id and
  // the same title.
  E('est-x', OTHER, 'j-b', null, 'Citi Lakes', [plain(8, 'foreign', 1, 1, 0)]);
}

const estRow = (id) => engine.db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
const estData = (id) => JSON.parse(estRow(id).data);
const allEstimates = () => engine.db.prepare('SELECT * FROM estimates ORDER BY id').all();
const count = (table) => engine.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
const setEst = (id, sets) => engine.db.prepare('UPDATE estimates SET ' + Object.keys(sets).map((k) => k + ' = ?').join(', ') + ' WHERE id = ?')
  .run(...Object.values(sets), id);

let server;
let baseUrl;
const origFetch = global.fetch;

// THE WINDOW BETWEEN THE MATCH AND THE LOCK. apply() re-reads P86 and re-runs
// the matcher, then opens a transaction and re-reads the row FOR UPDATE. In
// Postgres another connection can change the row in between, and every
// re-check inside applyEstimate exists for that window. pg-sqlite has one
// connection, so the only way to stand in the window is to write from inside
// it: raceAtBegin(fn) runs fn once, on the next BEGIN, after the matcher has
// already decided and before the locked read happens.
let _race = null;
const raceAtBegin = (fn) => { _race = fn; };
function installRaceHook() {
  const rawConnect = engine.pool.connect;
  engine.pool.connect = async () => {
    const c = await rawConnect();
    return {
      query: async (sql, params) => {
        const out = await c.query(sql, params);
        if (String(sql).trim().toUpperCase() === 'BEGIN' && _race) { const f = _race; _race = null; f(); }
        return out;
      },
      release: () => c.release(),
    };
  };
}

function call(method, pathname, user, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request(baseUrl + pathname, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        user ? { Authorization: 'Bearer ' + signToken(user) } : {}),
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const APPLY = '/api/admin/organizations/me?action=buildertrend-apply';
const PREVIEW = '/api/admin/organizations/me?view=buildertrend-preview';
const ADMIN = { id: 10, email: 'admin@agx.test', name: 'Ana Ruiz', role: 'admin', organization_id: AGX };
const PM = { id: 11, email: 'pm@agx.test', name: 'Pat PM', role: 'pm', organization_id: AGX };
const OTHER_ADMIN = { id: 20, email: 'admin@other.test', name: 'Oscar Other', role: 'admin', organization_id: OTHER };
const put = (user, body) => call('PUT', APPLY, user, Object.assign({ dataset: 'estimates' }, body));

async function estRows() {
  preview.forgetFetch(AGX);
  const r = await call('GET', PREVIEW, ADMIN);
  expect(r.status).toBe(200);
  return r.json.datasets.estimates;
}
const byBt = (ds, id) => ds.rows.find((r) => String(r.bt.btId) === String(id));
const fieldsOf = (list) => Object.fromEntries((list || []).map((c) => [c.field, c]));
const contentOf = (lines) => (lines || []).filter((l) => l.section !== '__section_header__');
// THE DOCUMENT, minus the one key a press may write beside it. data.btStatus is
// Buildertrend's OWN proposal word, recorded next to P86's own state and never
// as one, exactly as it is on jobs, change orders and bills; it is not a line,
// a title, an alternate or a number. Every "nothing else moved" assertion below
// compares THIS, so the difference between "the safe press wrote a word beside
// the record" and "the safe press touched the proposal" cannot hide.
function doc(id) {
  const d = JSON.parse(estRow(id).data);
  delete d.btStatus;
  return JSON.stringify(d);
}

beforeAll(async () => {
  seed();
  setRolePool(engine.pool);
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/admin/organizations', orgRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  global.fetch = clickrFetch;
  installRaceHook();
});
afterAll(async () => {
  global.fetch = origFetch;
  await new Promise((resolve) => server.close(resolve));
  engine.close();
});
beforeEach(async () => {
  process.env.CLICKR_API_KEY = KEY;
  delete process.env.CLICKR_ORG_SLUG;
  preview.forgetFetch(AGX);
  seed();
  _race = null;
  await refreshRoleCache();
});

// ── THE READ, AND THE THING THAT MAKES THIS DATASET DIFFERENT ─────────────
describe('THE READ — a record is a LINE, and the dedupe key is the line', () => {
  test('the dataset is read complete and classified; MANY records share a worksheetId and none is lost', async () => {
    const ds = await estRows();
    expect([ds.fetch.complete, ds.fetch.reason]).toEqual([true, null]);
    expect(ds.fetch.fetched).toBe(BT_LINES.length);
    expect(ds.classified).toBe(true);
    expect(ds.error).toBeNull();
    // No fixture carries _id: identity is lineItemId alone.
    expect(BT_LINES.every((r) => !Object.prototype.hasOwnProperty.call(r, '_id'))).toBe(true);
    // The shape itself: far more records than rows.
    const worksheets = new Set(BT_LINES.map((r) => r.worksheetId));
    expect(BT_LINES.length).toBeGreaterThan(worksheets.size);
    expect(ds.rows.length).toBe(worksheets.size);
  });

  test('THE DEDUPE KEY IS THE LINE. Keyed on the worksheet, the same read would be PARTIAL and every apply blocked', () => {
    expect(DATASETS.estimates.idKey).toBe('lineItemId');
    // Proved, not asserted: run the reader's own duplicate rule both ways.
    const idsBy = (key) => BT_LINES.map((r) => r[key]);
    const dupes = (list) => list.length - new Set(list).size;
    expect(dupes(idsBy('lineItemId'))).toBe(0);
    expect(dupes(idsBy('worksheetId'))).toBeGreaterThan(0);
    expect(dupes(idsBy('jobId'))).toBeGreaterThan(0);
  });

  test('a read whose ids DO repeat is marked partial and says so — the failure keying on the worksheet would have caused', () => {
    const { settleRead } = require('../server/services/clickr/client');
    const out = settleRead({ fetched: 24, reportedCount: 24, complete: false, reason: null, error: null },
      { endSignal: true, duplicateIds: 11 });
    expect(out.complete).toBe(false);
    expect(out.reason).toMatch(/arrived more than once/);
  });

  test('every declared key is carried by the fixtures, and nothing undeclared is', async () => {
    const ds = await estRows();
    expect(ds.mapping.missingKeys).toEqual([]);
    expect(ds.mapping.unexpectedKeys).toEqual([]);
    expect([ds.mapping.requiredKey, ds.mapping.requiredOk, ds.mapping.requiredUsable]).toEqual(['jobName', true, BT_LINES.length]);
  });

  test('THE DIAGNOSTIC THAT SETTLED THE REAL KEY NAMES: a declared key nothing carries is missing, and the key it really used is unexpected', () => {
    // NOT hypothetical: this is how 'item' was settled. It was declared from
    // the Clickr LIST view's "Item" column, no record carried it, and the
    // diagnostic put it in missingKeys with the real key — 'itemTitle', on all
    // 277 — sitting in unexpectedKeys beside it. Run here the other way round.
    const renamed = BT_LINES.map((r) => {
      const c = Object.assign({}, r);
      delete c.itemTitle;
      c.item = 'Framing labor';
      return c;
    });
    const d = describeMapping('estimates', renamed);
    expect(d.missingKeys).toEqual(['itemTitle']);
    expect(d.unexpectedKeys).toEqual([{ key: 'item', carriedBy: renamed.length }]);
    // The dataset still classifies: a wrong key costs a line its name, not the tab.
    expect([d.requiredOk, d.refusal]).toEqual([true, null]);
    // And NO VALUE is echoed by the diagnostic.
    expect(JSON.stringify(d)).not.toContain('Framing labor');
    expect(JSON.stringify(d)).not.toContain('Citi Lakes');
  });

  test('a wrong key reads as ABSENT, never as a wrong value, and never throws', () => {
    const v = readEstimateLine({ worksheetId: '1', jobName: 'J', lineItemTitle: 'Acme', markupPct: 22 });
    expect([v.itemTitle, v.description, v.markupType, v.markupPercent, v.quantity, v.unitCost]).toEqual([null, null, null, null, null, null]);
    expect([v.worksheetLocked, v.isDeleted]).toEqual([false, false]);
    expect(readEstimateLine(null).btId).toBeNull();
    expect(readEstimateLine('nope').isDeleted).toBe(false);
  });

  test('THE KEY IS FIXED: itemTitle is declared and read, ‘item’ is gone, and the description beside it is read too', () => {
    expect(DATASETS.estimates.keys).toContain('itemTitle');
    expect(DATASETS.estimates.keys).toContain('description');
    expect(DATASETS.estimates.keys).not.toContain('item');
    // On records shaped the way the real 277 are, nothing is missing at all.
    expect(describeMapping('estimates', BT_LINES).missingKeys).toEqual([]);
    const v = readEstimateLine({ worksheetId: '1', jobName: 'J', itemTitle: 'Framing labor', description: 'two coats' });
    expect([v.itemTitle, v.description]).toEqual(['Framing labor', 'two coats']);
    // THE TITLE IS WHAT PRINTS, and the description is the next value down —
    // ahead of the cost code, which is a CATEGORY and not what the line is.
    expect(estMatch.lineDescription(v)).toBe('Framing labor');
    expect(estMatch.lineDescription(readEstimateLine({ description: 'Two coats of primer', costCodeTitle: 'Subcontractors Costs' }))).toBe('Two coats of primer');
    expect(estMatch.lineDescription(readEstimateLine({ costCodeTitle: 'Subcontractors Costs' }))).toBe('Subcontractors Costs');
    expect(estMatch.lineDescription(readEstimateLine({}))).toBe('(no description in Buildertrend)');
    // And a line carrying BOTH says so on its row rather than dropping one.
    const both = estMatch.buildLines([readEstimateLine(L(CITI, { ws: 8300, id: 8301, order: 1, itemTitle: 'Trim', description: 'two coats', cost: 10, owner: 10 }))], '8300');
    expect([both.described, contentOf(both.lines)[0].description]).toEqual([1, 'Trim']);
  });

  test('the required key is jobName, and losing it refuses the WHOLE dataset rather than classifying blanks', () => {
    expect(DATASETS.estimates.requiredKey).toBe('jobName');
    const nameless = BT_LINES.map((r) => Object.assign({}, r, { jobName: '--' }));
    const d = describeMapping('estimates', nameless);
    expect(d.requiredOk).toBe(false);
    expect(d.refusal).toMatch(/carry a usable "jobName"/);
    // And the two keys that would have passed it VACUOUSLY are numeric, so the
    // blankness test can never fail on them.
    const numeric = BT_LINES.map((r) => Object.assign({}, r, { jobName: '--' }));
    expect(describeMapping('estimates', numeric).fields.find((f) => f.key === 'worksheetId').nonEmpty).toBe(BT_LINES.length);
  });

  test('a record is a LINE, and the fetched sentence says so rather than calling 24 lines 24 estimates', async () => {
    const ds = await estRows();
    expect(ds.sentence).toMatch(/estimate line items/);
  });
});

// ── GROUPING: the heart of it ─────────────────────────────────────────────
describe('GROUPING — worksheets, display order, and header-delimited sections', () => {
  test('a worksheet becomes ONE row carrying its live line count and both totals', async () => {
    const ds = await estRows();
    const r = byBt(ds, 100);
    expect([r.bt.lineCount, r.bt.deletedCount]).toEqual([3, 1]);
    expect([r.bt.costText, r.bt.ownerText]).toEqual(['$700.00', '$810.00']);
    expect(r.bt.jobName).toBe('Citi Lakes');
  });

  test('DISPLAY ORDER decides the array, and each header is placed BEFORE the lines it owns', () => {
    const lines = builtFor(100, 'e', 'a');
    expect(lines.map((l) => (l.section === '__section_header__' ? 'H:' + l.description : l.description)))
      .toEqual(['H:Labor', 'Cleanup', 'Framing labor', 'H:Materials', 'Lumber']);
    // The deleted line is not in it at all.
    expect(lines.some((l) => l.description === 'Removed')).toBe(false);
    // And the header-delimited convention is what P86 reads: every content line
    // sits after its own header, which is the ONLY thing that makes it a section.
    expect(lines[0].section).toBe('__section_header__');
    expect(lines[1].section).toBeUndefined();
  });

  test('a GROUP PATH deeper than one level names the header, so two groups both called "Labor" stay apart', async () => {
    const lines = builtFor(400, 'e', 'a');
    expect(lines.filter((l) => l.section === '__section_header__').map((l) => l.description))
      .toEqual(['Building A > Labor', 'Building B > Labor']);
    // Nothing is nested and nothing is merged: one Buildertrend group, one P86 header.
    expect(lines.filter((l) => l.section === '__section_header__').length).toBe(2);
    const ds = await estRows();
    expect(byBt(ds, 400).notes.join(' ')).toMatch(/more than one level deep/);
  });

  test('UNGROUPED lines come first and carry no header at all', () => {
    const lines = builtFor(400, 'e', 'a');
    expect([lines[0].description, lines[0].section]).toEqual(['Mobilization', undefined]);
    expect(lines.map((l) => (l.section === '__section_header__' ? 'H' : l.description)))
      .toEqual(['Mobilization', 'H', 'Trim', 'Trim extra', 'H', 'Trim B']);
  });

  test('a worksheet whose lines DISAGREE about a worksheet-level fact is REFUSED, never averaged and never taken from the first line', async () => {
    const ds = await estRows();
    const r = byBt(ds, 800);
    expect([r['class'], r.p86]).toEqual(['refused', null]);
    expect(r.notes.join(' ')).toMatch(/disagree about contract price \(2 different values\)/);
    expect([r.corrections, r.heldBack]).toEqual([[], []]);
    // Directly: the fact list is what decides it, and every fact on it is read
    // from a LINE even though it describes the worksheet.
    expect(estMatch.WS_FACTS.map((f) => f[0]).sort())
      .toEqual(['contractPrice', 'jobId', 'jobName', 'proposalStatus', 'worksheetLocked']);
  });

  test('a worksheet whose EVERY line is deleted is refused, and the P86 estimate linked to it is NAMED, not lost', async () => {
    const ds = await estRows();
    const r = byBt(ds, 700);
    expect([r['class'], r.p86]).toEqual(['refused', null]);
    expect(r.notes.join(' ')).toMatch(/Every line of this Buildertrend worksheet is deleted/);
    // Informational only, and deliberately NOT row.p86 — no apply path reaches it.
    expect(r.p86Linked.id).toBe('est-gone');
    expect(r.notes.join(' ')).toMatch(/a sync never deletes a P86 estimate/);
  });

  test('a P86 estimate whose Buildertrend worksheet has GONE is marked rather than proposed for anything', async () => {
    // est-only is on a job this read reaches and nothing claims it.
    const ds = await estRows();
    const nib = ds.notInBuildertrend.rows.map((r) => r.id);
    expect(nib).toContain('est-only');
    expect(ds.notInBuildertrend.sentence).toMatch(/Nothing is proposed for deletion/);
    // And one carrying a Buildertrend id no longer in the read carries the mark.
    setEst('est-only', { bt_worksheet_id: '999999' });
    const ds2 = await estRows();
    expect(ds2.notInBuildertrend.rows.find((r) => r.id === 'est-only').linkedGone).toBe(true);
  });
});

// ── MARKUP ────────────────────────────────────────────────────────────────
describe('MARKUP — the percent is read and then CHECKED against Buildertrend’s own owner price', () => {
  test('a PERCENT maps straight across', () => {
    const lines = builtFor(100, 'e', 'a');
    expect(contentOf(lines).map((l) => [l.description, l.qty, l.unitCost, l.markup]))
      .toEqual([['Cleanup', 1, 100, 0], ['Framing labor', 10, 50, 20], ['Lumber', 4, 25, 10]]);
    // 0% is a REAL 0, never '' — blank would inherit the section and then the
    // document default, which is a price nobody chose.
    expect(contentOf(lines).every((l) => typeof l.markup === 'number')).toBe(true);
  });

  test('THE MARGIN IS NOT CONSULTED — the percent is, whatever notation the person typed', () => {
    // A margin and its percent are the same multiplier — 1 + p/100 = 1/(1 -
    // m/100) — which is WHY taking Buildertrend's percent on a margin-typed
    // line loses nothing. It is simply not something this module computes any
    // more, because Buildertrend writes the percent on the record itself.
    for (const m of [20, 47, 50, 60]) {
      expect(1 + ((m / (100 - m)) * 100) / 100).toBeCloseTo(1 / (1 - m / 100), 9);
    }
    // ws 400's 'Trim' is typed as a 20% margin and carries the percent 25.
    const trim = contentOf(builtFor(400, 'e', 'a')).find((l) => l.description === 'Trim');
    expect([trim.qty, trim.unitCost, trim.markup]).toEqual([3, 100, 25]);
    // And the margin is NOT a fallback: a line whose MARGIN would reproduce the
    // owner price and whose percent does not is refused, never rescued by it.
    const rescued = [readEstimateLine(L(CITI, { ws: 8100, id: 8101, order: 1, itemTitle: 'Margin only', qty: 1, cost: 100, markupType: '5', markupPercent: 0, margin: 20, owner: 125 }))];
    const b = estMatch.buildLines(rescued, '8100');
    expect(contentOf(b.lines)).toEqual([]);
    expect(b.refusals[0].why).toMatch(/owner pays \$125\.00 for it, and Project 86 prices the same quantity, unit cost and 0% markup at \$100\.00/);
  });

  test('a line whose percent does NOT reproduce Buildertrend’s own owner price refuses the WHOLE worksheet, naming both figures', async () => {
    const ds = await estRows();
    const r = byBt(ds, 900);
    expect([r['class'], r.p86]).toEqual(['refused', null]);
    expect(r.job.id).toBe('j-1');
    const text = r.notes.join(' ');
    expect(text).toMatch(/1 of this worksheet’s 2 lines cannot be carried/);
    // 2 x $100 at the 0% percent beside it is $200, and Buildertrend says the
    // owner pays $250. Both figures, on the row.
    expect(text).toMatch(/“Flat rate door” — Buildertrend says the owner pays \$250\.00 for it, and Project 86 prices the same quantity, unit cost and 0% markup at \$200\.00 — \$50\.00 less/);
    // The TYPE is quoted as information. It is not what refused anything.
    expect(text).toMatch(/Buildertrend records its markup type as "2"/);
    // An estimate missing lines is a wrong document: the GOOD line is not imported either.
    expect([r.corrections, r.heldBack]).toEqual([[], []]);
  });

  test('a FLAT markup on a ZERO cost is still refused, and for the reason it always had: 0 x k is 0 for every k', async () => {
    const ds = await estRows();
    const r = byBt(ds, 902);
    expect(r['class']).toBe('refused');
    expect(r.notes.join(' ')).toMatch(/“Permit” — Buildertrend says the owner pays \$500\.00 for it, and Project 86 prices the same quantity, unit cost and 0% markup at \$0\.00/);
    // Directly on the check: there is no percent that prices a zero cost at
    // $500, so no tolerance and no notation can rescue this line.
    expect(estMatch.lineAgreesWithBuildertrend({ qty: 1, unitCost: 0, markup: 0 }, { ownerPrice: 500, markupType: '3' }).why).toMatch(/\$500\.00 less/);
    expect(estMatch.lineAgreesWithBuildertrend({ qty: 1, unitCost: 0, markup: 9999 }, { ownerPrice: 500 }).why).toMatch(/\$500\.00 less/);
  });

  test('NO markup PERCENT refuses and points at the mapping diagnostic, which is the only thing that can settle a key name', async () => {
    const ds = await estRows();
    expect(byBt(ds, 901).notes.join(' ')).toMatch(/sent no markup percent on it.*markupPercent.*key name is wrong in field-map\.js/s);
    // A percent that is present but unreadable is named rather than zeroed.
    expect(estMatch.markupPercentFor({ markupPercent: 'abc' }).why).toMatch(/not a readable number/);
    // A BLANK TYPE no longer refuses anything: the percent is what is read.
    expect(estMatch.markupPercentFor({ markupType: null, markupPercent: 12 }).pct).toBe(12);
  });

  test('markupType is INFORMATIONAL: "1", "5" and a code this sync has never seen all import, because the percent is what is used', async () => {
    const ds = await estRows();
    // The two codes the real records carry, on the worksheet of real lines.
    expect(byBt(ds, 1300)['class']).toBe('new');
    expect(contentOf(byBt(ds, 1300).build.lines).length).toBe(4);
    // And a code nobody has ever seen. It imports, and nothing anywhere on the
    // page says "no rule for" — the sentence that refused all 62 worksheets.
    const r = byBt(ds, 1301);
    expect([r['class'], contentOf(r.build.lines)[0].markup]).toEqual(['new', 25]);
    expect(JSON.stringify(ds.rows)).not.toMatch(/no rule for/);
    // The word table is GONE, so there is nothing left to gate on.
    expect(estMatch.markupKind).toBeUndefined();
    for (const t of ['1', '5', '7', 'Sliding scale', 'Margin', null, '']) {
      expect([t, estMatch.markupPercentFor({ markupType: t, markupPercent: 88.68 }).pct]).toEqual([t, 88.68]);
    }
  });

  test('THE PROOF: P86 prices Buildertrend’s own lines at Buildertrend’s own owner price, through the REAL pricing code', () => {
    for (const ws of [100, 200, 300, 400, 1300, 1301]) {
      const live = BT_LINES.filter((r) => r.worksheetId === String(ws)).map(readEstimateLine).filter((v) => !v.isDeleted);
      const built = estMatch.buildLines(live, String(ws));
      expect([ws, built.refusals]).toEqual([ws, []]);
      // js/pricing-pipeline.js, via services/money/estimate-totals.js — the same
      // module the editor chip and the proposal preview run.
      const priced = Math.round(estimateTotals.computeEstimateTotals({ lines: built.lines, alternates: [] }).clientPrice * 100) / 100;
      const owner = estMatch.btOwnerTotal(live).total;
      // To the cent on every worksheet of round percents...
      if (ws !== 1300) expect([ws, priced]).toEqual([ws, owner]);
      // ...and within the worksheet's own tolerance on every one of them.
      expect([ws, Math.abs(priced - owner) <= built.tolerance + estMatch.EPS]).toEqual([ws, true]);
    }
  });

  test('THE PENNY THAT IS NOT AN ERROR: the worksheet of real lines is a cent out, and an absolute half cent would call that a money discrepancy', () => {
    const live = BT_LINES.filter((r) => r.worksheetId === '1300').map(readEstimateLine);
    const built = estMatch.buildLines(live, '1300');
    const priced = Math.round(estimateTotals.computeEstimateTotals({ lines: built.lines, alternates: [] }).clientPrice * 100) / 100;
    expect([priced, estMatch.btOwnerTotal(live).total]).toEqual([35652.84, 35652.83]);
    // The mutation, as arithmetic: EPS alone flags it; the worksheet's own
    // tolerance — the sum of its lines' — does not.
    expect(Math.abs(priced - 35652.83) >= estMatch.EPS).toBe(true);
    expect(Math.abs(priced - 35652.83) <= built.tolerance + estMatch.EPS).toBe(true);
  });

  test('and when they DISAGREE the difference is a held-back money item, never absorbed', async () => {
    const ds = await estRows();
    const r = byBt(ds, 1200);
    expect([r['class'], r.p86.id]).toEqual(['matched', 'est-diff']);
    const h = fieldsOf(r.heldBack);
    expect([h.totalDiff.bt, h.totalDiff.p86, h.totalDiff.applicable, h.totalDiff.money]).toEqual(['$1,200.00', '$1,700.00', false, true]);
    expect(h.totalDiff.note).toMatch(/up \$500\.00/);
    expect(h.totalDiff.note).toMatch(/shown rather than absorbed/);
    // AND THE REASON IT CAN STILL ARISE AT ALL, now that every readable line is
    // checked: one line's owner price is not readable money, so nothing checked
    // it. The row says exactly that.
    expect(r.notes.join(' ')).toMatch(/1 of this worksheet’s lines sent an owner price that is not readable money, so nothing could check/);
    // ...and the held-back note names the tolerance it broke, in the figures
    // the comparison actually used rather than rounded to a cent.
    expect(h.totalDiff.note).toMatch(/more than the \$0\.0900 that Buildertrend’s own two-decimal markup percents can explain/);
    // It is not a correction, so no apply path of any shape can reach it.
    expect(r.corrections.map((c) => c.field)).not.toContain('totalDiff');
  });

  test('a line whose percent does not reproduce its owner price is refused EVEN WHERE a P86 estimate is already matched to the worksheet', async () => {
    const ds = await estRows();
    const r = byBt(ds, 1100);
    expect([r['class'], r.p86]).toEqual(['refused', null]);
    expect(r.notes.join(' ')).toMatch(/“Roof” — Buildertrend says the owner pays \$1,500\.00 for it, and Project 86 prices the same quantity, unit cost and 20% markup at \$1,200\.00 — \$300\.00 less/);
    expect([r.corrections, r.heldBack]).toEqual([[], []]);
  });
});


// ── THE FOUR REAL LINES ───────────────────────────────────────────────────
//
// Read out of Clickr's own UI on 2026-09-20, by their real numbers, and they
// are the evidence the whole markup rule rests on: Buildertrend populates ALL
// FOUR notations on every line, markupType is only the CODE saying which one
// the person typed, and the percent always reproduces the owner price.
//
// Line B is the one that matters most. Its percent is rounded to two decimals,
// so P86 prices it six tenths of a cent above what Buildertrend says the owner
// pays — and a tolerance of an absolute half cent refuses a line that is right.
describe('THE REAL RECORDS, by their real numbers', () => {
  //     name  type   qty  unitCost  markupPercent  perUnit   amount   margin  ownerPrice
  const REAL = [
    ['A', '1', 1, 5100, 100, 5100, 5100, 50, 10200],
    ['B', '5', 1, 770, 88.68, 682.83, 682.83, 47, 1452.83],
    ['C', '5', 1, 9600, 150, 14400, 14400, 60, 24000],
    ['D', '1', 1, 36000, -100, -36000, -36000, 0, 0],
  ];
  const lineOf = (row) => readEstimateLine(L(RIVER, {
    ws: 9900, id: 9901, order: 1, itemTitle: row[0], markupType: row[1], qty: row[2], cost: row[3],
    markupPercent: row[4], markupPerUnit: row[5], markupAmount: row[6], margin: row[7], owner: row[8],
  }));
  const builtOf = (row) => estMatch.buildLines([lineOf(row)], '9900');
  const pricedOf = (row) => estMatch.p86PricedTotal(builtOf(row).lines).clientPrice;

  test('every one of the four imports, and P86 prices it at Buildertrend’s own owner price', () => {
    for (const row of REAL) {
      const built = builtOf(row);
      expect([row[0], built.refusals]).toEqual([row[0], []]);
      const l = contentOf(built.lines)[0];
      // The percent is taken WHATEVER the type says, and the quantity and cost
      // are Buildertrend's own.
      expect([row[0], l.qty, l.unitCost, l.markup]).toEqual([row[0], row[2], row[3], row[4]]);
      expect([row[0], Math.abs(pricedOf(row) - row[8]) <= estMatch.priceTolerance(row[2] * row[3])]).toEqual([row[0], true]);
    }
  });

  test('THE ARITHMETIC, stated: three are exact and B is six tenths of a cent out', () => {
    expect(pricedOf(REAL[0])).toBe(10200);          // 5100 x 2.00
    expect(pricedOf(REAL[2])).toBe(24000);          // 9600 x 2.50
    expect(pricedOf(REAL[3])).toBe(0);              // 36000 x 0
    expect(pricedOf(REAL[1])).toBeCloseTo(1452.836, 9);   // 770 x 1.8868
    expect(pricedOf(REAL[1]) - 1452.83).toBeCloseTo(0.006, 9);
  });

  test('LINE B IS THE TOLERANCE TEST: it imports, and an absolute half cent refuses it', () => {
    expect(builtOf(REAL[1]).refusals).toEqual([]);
    const resid = Math.abs(pricedOf(REAL[1]) - 1452.83);
    // The mutation this test exists to kill, run here as arithmetic: EPS alone
    // is smaller than a residual Buildertrend's own rounding guarantees.
    expect(resid > estMatch.EPS).toBe(true);
    expect(estMatch.priceTolerance(770)).toBeCloseTo(0.0435, 9);
    expect(resid <= estMatch.priceTolerance(770)).toBe(true);
  });

  test('and the tolerance still catches a percent that is wrong by ONE STEP', () => {
    // 88.69% instead of 88.68% on that same line: $0.08 out against $0.0435.
    const wrong = readEstimateLine(L(RIVER, { ws: 9900, id: 9902, order: 1, itemTitle: 'B', markupType: '5', qty: 1, cost: 770, markupPercent: 88.69, owner: 1452.83 }));
    const built = estMatch.buildLines([wrong], '9900');
    expect(contentOf(built.lines)).toEqual([]);
    expect(built.refusals[0].why).toMatch(/\$0\.08 more, which is more than the \$0\.0435/);
    // As the PROPERTY rather than the example: one step of a two-decimal
    // percent is worth C x 0.0001, and the tolerance is 0.005 + C x 0.00005 —
    // so above $100 of line cost a one-step error is always caught.
    for (const C of [101, 200, 770, 5100, 36000]) {
      expect([C, C * 0.0001 > estMatch.priceTolerance(C)]).toEqual([C, true]);
    }
  });

  test('a NEGATIVE markup imports exactly as Buildertrend priced it, and the row names the lines', async () => {
    const built = builtOf(REAL[3]);
    const l = contentOf(built.lines)[0];
    // The cost stays on the estimate; the price is nothing. Which is the
    // document Buildertrend shows.
    expect([l.unitCost, l.markup]).toEqual([36000, -100]);
    expect(estMatch.p86PricedTotal(built.lines).clientPrice).toBe(0);
    expect(built.negatives).toEqual([{ line: 'D', pct: -100 }]);
    const ds = await estRows();
    expect(byBt(ds, 1300).notes.join(' ')).toMatch(/1 of this worksheet’s lines carries a NEGATIVE Buildertrend markup .*at -100%.*the cost stays in the estimate/);
  });

  test('the worksheet of all four is OFFERED, and its own penny is not called a money discrepancy', async () => {
    const ds = await estRows();
    const r = byBt(ds, 1300);
    expect([r['class'], r.job.id]).toEqual(['new', 'j-8']);
    expect([r.bt.costText, r.bt.ownerText]).toEqual(['$51,470.00', '$35,652.83']);
    expect(r.notes.join(' ')).not.toMatch(/Project 86 prices these lines at/);
    // And the line carrying a Buildertrend description as well as a title says
    // so, because a P86 line has one text field and only the title fits.
    expect(r.notes.join(' ')).toMatch(/1 of this worksheet’s lines carries a Buildertrend description as well as a title/);
    expect(contentOf(r.build.lines).map((l) => l.description)).toEqual(['A — percent typed', 'B — the rounded percent', 'C — margin typed', 'D — excluded at -100%']);
  });
});

// ── A QUANTITY IS NOT MONEY ──────────────────────────────────────────
//
// num() reads money and rounds to cents, because that is what a dollar amount
// is. A QUANTITY and a PERCENT go through numExact instead. Rounding a
// quantity writes a figure NEITHER side ever had into a document that becomes
// a proposal, and the only thing that would surface it is the held-back total
// difference — which names the markup, not the quantity that actually moved.
//
// numExact reuses parseMoney's grammar with { round: false } rather than
// re-implementing it: Number('1,234.5678') and Number({ value: 1.3333 }) are
// both NaN, and Number([]) / Number(false) / Number(' ') are all 0, so a
// hand-rolled reader would refuse quantities that import correctly today and
// silently zero ones that are refused today. Both halves are pinned below.
describe('A QUANTITY AND A PERCENT ARE NOT MONEY, so neither is rounded to cents', () => {
  const one = (o) => [readEstimateLine(L(CITI, Object.assign({ ws: 8000, id: 8001, groupId: 'GQ', groupTitle: 'Sod', order: 1 }, o)))];
  const build = (o) => estMatch.buildLines(one(o), '8000');
  const content = (o) => contentOf(build(o).lines)[0];

  test('a four-decimal quantity is built as the figure Buildertrend sent, and the totals then AGREE', () => {
    const live = one({ itemTitle: 'Sod', qty: 1.3333, cost: 1000, markupPercent: 0, owner: 1333.30 });
    const built = estMatch.buildLines(live, '8000');
    expect(built.refusals).toEqual([]);
    const l = contentOf(built.lines)[0];
    expect([l.qty, l.unitCost, l.markup]).toEqual([1.3333, 1000, 0]);
    // THE CONSEQUENCE, not just the field: priced through P86's own pipeline
    // these lines now come to Buildertrend's own owner price, so there is no
    // held-back 'Total difference' blaming a markup for a quantity's error.
    const priced = Math.round(estMatch.p86PricedTotal(built.lines).clientPrice * 100) / 100;
    expect([priced, estMatch.btOwnerTotal(live).total]).toEqual([1333.3, 1333.3]);
    expect(Math.abs(priced - estMatch.btOwnerTotal(live).total) >= estMatch.EPS).toBe(false);
  });

  test('a quantity below half a cent is NOT zero', () => {
    expect(content({ itemTitle: 'Trace', qty: 0.004, cost: 100, markupPercent: 0, owner: 0.4 }).qty).toBe(0.004);
  });

  test('the cost total printed on the row is read the same way the lines are', () => {
    // btCostTotal feeds the 'cost $x' text beside the line-items item. Read
    // through num() it would say $1,330.00 for lines that cost $1,333.30.
    expect(estMatch.btCostTotal(one({ itemTitle: 'Sod', qty: 1.3333, cost: 1000, owner: 1333.30 }))).toBe(1333.3);
  });

  test('every shape readEstimateLine can deliver survives — number, comma text, and the {value, scale} envelope', () => {
    expect(estMatch.numExact(1.3333)).toBe(1.3333);
    expect(estMatch.numExact('1,234.5678')).toBe(1234.5678);
    // Buildertrend's envelope. A bare Number() on this is NaN, which would
    // refuse EVERY line of EVERY worksheet — so the grammar is reused for it.
    expect(estMatch.numExact({ value: 1.3333, scale: 4 })).toBe(1.3333);
    expect(content({ itemTitle: 'Env', qty: { value: 1.3333, scale: 4 }, cost: 1000, markupPercent: 0, owner: 1333.30 }).qty).toBe(1.3333);
    // num's contract, kept exactly: blank is 0, unreadable is null.
    expect([estMatch.numExact(null), estMatch.numExact(''), estMatch.numExact(0)]).toEqual([0, 0, 0]);
    expect([estMatch.numExact('abc'), estMatch.numExact('1 - 2'), estMatch.numExact([])]).toEqual([null, null, null]);
  });

  test('and the refusal it replaces is still there: an unreadable quantity is NAMED, never zeroed', () => {
    const b = build({ itemTitle: 'Junk', qty: 'abc', cost: 100, markupPercent: 0 });
    expect(contentOf(b.lines)).toEqual([]);
    expect(b.refusals.map((r) => r.why)).toEqual(['its quantity is not a readable number']);
  });

  test('THE ONLY difference between num and numExact is the cents rounding', () => {
    // Stated as a property, because that is the whole claim: same grammar,
    // same guards, same blank-is-zero, same refusals — parseMoney with
    // { round: false }. Re-implementing a reader here instead is what would
    // quietly change which inputs are accepted, in either direction.
    const SAME = [0, 1, -5, 1.25, '1,234.56', '$5', '($5.00)', '2k', { value: 12.5, scale: 2 },
      null, '', '   ', 'abc', '1 - 2', [], false, NaN, Infinity];
    for (const v of SAME) {
      expect({ v: String(v), n: estMatch.num(v) }).toEqual({ v: String(v), n: estMatch.numExact(v) });
    }
    // ...and where rounding DOES bite, only numExact keeps the figure.
    for (const v of [1.3333, '1,234.5678', { value: 0.004, scale: 4 }, 99.999]) {
      expect(estMatch.numExact(v)).toBe(Number(String(v.value === undefined ? v : v.value).replace(/,/g, '')));
      expect(estMatch.num(v)).toBe(Math.round(estMatch.numExact(v) * 100) / 100);
    }
  });

  test('a markup percent carried past two decimals is carried, not rounded', () => {
    expect(content({ itemTitle: 'P', qty: 1, cost: 100, markupPercent: 12.345, owner: 112.345 }).markup).toBe(12.345);
    expect(estMatch.markupPercentFor({ markupType: 'Percent', markupPercent: 12.345 }).pct).toBe(12.345);
  });

  test('a PERCENT past two decimals is carried, and the line still checks out — the tolerance does not force two decimals on anybody', () => {
    // num(99.999) is 100; numExact keeps the figure, and the check prices the
    // figure that was kept rather than the rounded one.
    expect(content({ itemTitle: 'Deep', qty: 1, cost: 100, markupPercent: 99.999, owner: 199.999 }).markup).toBe(99.999);
    expect(estMatch.markupPercentFor({ markupType: '5', markupPercent: 99.999 }).pct).toBe(99.999);
  });

  test('but MONEY is still money: a unit cost keeps its cents rounding', () => {
    expect(estMatch.num(1.3333)).toBe(1.33);
    expect(content({ itemTitle: 'M', qty: 1, cost: 10.005, markupPercent: 0, owner: 10.01 }).unitCost).toBe(10.01);
  });

  test('and where that rounding moves the PRICE, the line is refused naming Buildertrend’s own unit cost — never blamed on a markup', () => {
    // 1000 x $0.8756 is $875.60 and a P86 line can only carry $0.88, which is
    // $880.00: a real $4.40 that used to ride into a created estimate behind a
    // note. The refusal says whose limit it is, so nobody hunts the markup.
    const b = build({ itemTitle: 'Sod', qty: 1000, cost: 0.8756, markupPercent: 0, owner: 875.6 });
    expect(contentOf(b.lines)).toEqual([]);
    expect(b.refusals[0].why).toMatch(/\$880\.00 — \$4\.40 more/);
    expect(b.refusals[0].why).toMatch(/Buildertrend’s unit cost on it is 0\.8756 and a Project 86 line carries cents/);
  });
});

// ── A LINE ID IS AN ADDRESS IN THE WHOLE PORTFOLIO ──────────────────────
//
// appData.estimateLines is ONE flat array across every estimate in the
// portfolio, and js/line-identity.js RE-MINTS any duplicate id it finds in it.
// The seeds this builder has are Buildertrend's own group and line ids, and
// none of them is unique outside its worksheet: two worksheets can share a
// group id, a group with no id keys on its TITLE, and a missing line id seeds
// on ''. A re-mint moves that estimate's linesFingerprint, and from then on
// the sync proposes an applicable Line-items REPLACE — a MONEY item — on an
// estimate nobody edited, on every refresh, for ever. So this asserts the
// INVARIANT (ensureLineIds mints nothing) rather than the id FORMAT.
describe('LINE IDS are unique across the PORTFOLIO, not just inside one worksheet', () => {
  const identity = require('../js/line-identity');
  // The prefixFor js/app.js installs on appData.estimateLines, verbatim.
  const prefixFor = (l) => ((l && l.section === '__section_header__') ? 's' : 'l');
  const wsOf = (ws, rows) => rows.map((o, i) => readEstimateLine(L(CITI, Object.assign({ ws, id: ws * 10 + i, order: i + 1 }, o))));

  // The two seed collisions that need no missing key at all.
  const CASES = [
    ['a group title with NO group id', [{ groupTitle: 'Labor', itemTitle: 'A', cost: 10, owner: 10 }], [{ groupTitle: 'Labor', itemTitle: 'B', cost: 20, owner: 20 }]],
    ['the same group id on both', [{ groupId: 'G1', groupTitle: 'Labor', itemTitle: 'A', cost: 10, owner: 10 }], [{ groupId: 'G1', groupTitle: 'Labor', itemTitle: 'B', cost: 20, owner: 20 }]],
  ];

  test.each(CASES)('two worksheets grouping by %s share no id, and nothing is re-minted', (_w, a, b) => {
    const liveA = wsOf(9100, a);
    const liveB = wsOf(9200, b);
    const bA = estMatch.buildLines(liveA, '9100');
    const bB = estMatch.buildLines(liveB, '9200');
    expect([bA.refusals, bB.refusals]).toEqual([[], []]);
    const fpA = estMatch.linesFingerprint(bA.lines);
    const fpB = estMatch.linesFingerprint(bB.lines);

    // The portfolio-wide array, exactly as the client holds it.
    const flat = bA.lines.concat(bB.lines).map((l) => Object.assign({}, l));
    expect(identity.ensureLineIds(flat, { prefixFor })).toBe(0);
    // ...and because nothing was re-minted, NEITHER estimate's fingerprint
    // moved — which is what stops the permanent phantom money item.
    expect(estMatch.linesFingerprint(flat.slice(0, bA.lines.length))).toBe(fpA);
    expect(estMatch.linesFingerprint(flat.slice(bA.lines.length))).toBe(fpB);
  });

  test('a MISSING Buildertrend line id does not collide either, and it is not silent', () => {
    // slug('') is '', so every id-less line used to seed on the same 'x'.
    const noId = (ws, o) => [readEstimateLine(Object.assign(L(CITI, Object.assign({ ws, id: 1, order: 1, cost: 1, owner: 1 }, o)), { lineItemId: null }))];
    const liveA = noId(9300, { groupId: 'GA', groupTitle: 'A', itemTitle: 'A' });
    const liveB = noId(9400, { groupId: 'GB', groupTitle: 'B', itemTitle: 'B' });
    const flat = estMatch.buildLines(liveA, '9300').lines
      .concat(estMatch.buildLines(liveB, '9400').lines).map((l) => Object.assign({}, l));
    expect(new Set(flat.map((l) => l.id)).size).toBe(flat.length);
    expect(identity.ensureLineIds(flat, { prefixFor })).toBe(0);
    // It imports, but the line can no longer be traced back to Buildertrend,
    // and if that is true of EVERY line then the key name is what is wrong.
    expect(contentOf(flat).map((l) => l.btLineId)).toEqual([null, null]);
  });

  test('a header still reads like a header and a line like a line, so a heal matches its neighbours', () => {
    const built = estMatch.buildLines(wsOf(9500, [{ groupId: 'G1', groupTitle: 'Labor', itemTitle: 'A', cost: 1, owner: 1 }]), '9500');
    expect(built.lines.length).toBe(2);
    for (const l of built.lines) expect(String(l.id)[0]).toBe(prefixFor(l));
  });

  test('and the ids are still DETERMINISTIC, so a re-read is the same array and a re-apply is a no-op', () => {
    const rows = [{ groupId: 'G1', groupTitle: 'Labor', itemTitle: 'A', cost: 10, owner: 10 }, { groupTitle: 'Sub', itemTitle: 'B', cost: 20, owner: 20 }];
    const a = estMatch.buildLines(wsOf(9600, rows), '9600');
    const b = estMatch.buildLines(wsOf(9600, rows), '9600');
    expect(a.lines.map((l) => l.id)).toEqual(b.lines.map((l) => l.id));
    expect(estMatch.linesFingerprint(a.lines)).toBe(estMatch.linesFingerprint(b.lines));
  });

  test('THE WHOLE PAGE at once: no two lines anywhere in the preview share an id', async () => {
    // The pin on the CALL SITE rather than on the builder. Every test above
    // hands buildLines a worksheet id by hand; this one takes the arrays the
    // real preview actually built, from every row of every class, and pours
    // them into ONE array the way appData.estimateLines holds them.
    const ds = await estRows();
    const all = [];
    for (const r of ds.rows) {
      const h = fieldsOf(r.heldBack).lines;
      for (const l of (h && h.value && h.value.lines) || []) all.push(Object.assign({}, l));
      for (const l of (r.build && r.build.lines) || []) all.push(Object.assign({}, l));
    }
    // Two worksheets in the fixtures share a group id AND a group title, so
    // this is not a vacuous walk over one worksheet.
    expect(all.length).toBeGreaterThan(6);
    expect(new Set(all.map((l) => l.id)).size).toBe(all.length);
    expect(identity.ensureLineIds(all, { prefixFor })).toBe(0);
  });

  test('a worksheet whose lines carry NO Buildertrend line id says so, and names the key to check', () => {
    // Driven through matchEstimates itself: the note has to reach the ROW,
    // which is the only place the operator can read it.
    const p86 = { jobs: [{ id: 'j-x', bt_job_id: '111', data: { jobNumber: 'C1', title: 'Citi Lakes' } }], estimateRows: [] };
    const strip = (rows) => rows.map((o) => readEstimateLine(Object.assign(
      L(CITI, Object.assign({ ws: 9700, order: 1, cost: 10, owner: 10 }, o)), o.keep ? {} : { lineItemId: null })));

    const none = matchEstimates(strip([{ id: 1, groupId: 'GA', groupTitle: 'A', itemTitle: 'A' }]), p86);
    expect(none[0].notes.join(' ')).toMatch(/no line id on ANY of this worksheet.s lines.*"lineItemId".*key name is wrong in field-map\.js/s);

    const some = matchEstimates(strip([{ id: 1, groupId: 'GA', groupTitle: 'A', itemTitle: 'A', keep: true },
      { id: 2, groupId: 'GA', groupTitle: 'A', itemTitle: 'B', order: 2 }]), p86);
    expect(some[0].notes.join(' ')).toMatch(/1 of this worksheet.s lines came with no Buildertrend line id/);

    // And a worksheet whose lines all carry one says nothing at all.
    const ok = matchEstimates(strip([{ id: 1, groupId: 'GA', groupTitle: 'A', itemTitle: 'A', keep: true }]), p86);
    expect(ok[0].notes.join(' ')).not.toMatch(/line id/);

    // ...and on a MATCHED row too, which is a different notes array in a
    // different function. The row an operator reads is whichever one their
    // worksheet happens to land in, so one copy covering one path is not it.
    const linked = Object.assign({}, p86, { estimateRows: [{ id: 'e-x', attached_job_id: 'j-x',
      bt_worksheet_id: '9700', data: { id: 'e-x', title: 'Citi Lakes', lines: [], alternates: [] } }] });
    const m = matchEstimates(strip([{ id: 1, groupId: 'GA', groupTitle: 'A', itemTitle: 'A' }]), linked);
    expect(m[0]['class']).toBe('matched');
    expect(m[0].notes.join(' ')).toMatch(/no line id on ANY of this worksheet.s lines/);
  });
});
// ── THE RUNGS AND THE CLASSES ─────────────────────────────────────────────
describe('PREVIEW — rungs, classes, and the refusal to guess', () => {
  test('rung 1 (the job plus the worksheet title): the LINE ITEMS are held back, never a correction', async () => {
    const ds = await estRows();
    const r = byBt(ds, 100);
    expect([r['class'], r.rung, r.p86.id]).toEqual(['matched', 'Job + title', 'est-a']);
    expect(r.corrections).toEqual([]);
    const h = fieldsOf(r.heldBack);
    expect([h.lines.applicable, h.lines.money, h.lines.reason]).toEqual([true, true, 'money']);
    expect(h.lines.bt).toBe('3 lines in 2 groups · cost $700.00 · owner price $810.00');
    expect(h.lines.p86).toMatch(/^1 line · cost \$999\.00/);
    expect(contentOf(h.lines.value.lines).length).toBe(3);
  });

  test('rung 0 (a saved bt_worksheet_id), and lines that already agree raise NO item at all', async () => {
    const ds = await estRows();
    const r = byBt(ds, 200);
    expect([r['class'], r.rung, r.p86.id]).toEqual(['matched', 'Buildertrend ID', 'est-b']);
    expect(fieldsOf(r.heldBack).lines).toBeUndefined();
    expect(r.corrections).toEqual([]);
  });

  test('rung 0 onto an estimate that LOST its job: filing it is the one correction an estimate has', async () => {
    const ds = await estRows();
    const r = byBt(ds, 1000);
    expect([r['class'], r.rung, r.p86.id]).toEqual(['conflict', 'Buildertrend ID', 'est-loose']);
    const c = fieldsOf(r.corrections);
    expect([c.job.kind, c.job.value, c.job.to]).toEqual(['fill', 'j-3', 'RV2013 Saddlebrook']);
  });

  test('TWO worksheets landing on ONE P86 estimate: neither is matched and nothing is proposed', async () => {
    const ds = await estRows();
    for (const id of [500, 501]) {
      const r = byBt(ds, id);
      expect([r['class'], r.rung, r.p86]).toEqual(['ambiguous', null, null]);
      expect(r.candidates.map((c) => c.id)).toEqual(['est-claim']);
      expect([r.corrections, r.heldBack]).toEqual([[], []]);
      expect(r.notes.join(' ')).toMatch(/2 Buildertrend worksheets land on this same P86 estimate/);
    }
  });

  test('a worksheet whose Buildertrend job is not linked WAITS, and says where to link it', async () => {
    const ds = await estRows();
    const r = byBt(ds, 600);
    expect([r['class'], r.waitingOnJob]).toEqual(['refused', true]);
    expect(r.notes.join(' ')).toMatch(/"Unlinked Job" is not linked to a P86 job yet/);
  });

  test('a worksheet P86 has nothing like is NEW, and carries the lines the create would write', async () => {
    const ds = await estRows();
    const r = byBt(ds, 400);
    expect([r['class'], r.p86, r.job.id]).toEqual(['new', null, 'j-5']);
    expect(contentOf(r.build.lines).length).toBe(4);
    expect(r.build.lines.filter((l) => l.section === '__section_header__').length).toBe(2);
  });

  test('a matched row names the job it is on, the contract price is shown and NEVER applicable, and the deleted lines are accounted for', async () => {
    const ds = await estRows();
    const r = byBt(ds, 100);
    expect(r.job.label).toBe('RV2004 Citi Lakes');
    const h = fieldsOf(r.heldBack);
    expect([h.contractPrice.bt, h.contractPrice.applicable, h.contractPrice.money]).toEqual(['$100,000.00', false, true]);
    expect(h.contractPrice.note).toMatch(/the Jobs tab is where that one number is proposed/);
    expect(r.notes.join(' ')).toMatch(/1 deleted Buildertrend line was left out/);
  });
});

// ── NEVER TOUCH A SENT OR SOLD ESTIMATE ───────────────────────────────────
describe('THE GUARD — a document that went to a client or was sold is never rewritten', () => {
  test('the preview proposes nothing on a SENT estimate and says why', async () => {
    const ds = await estRows();
    const r = byBt(ds, 300);
    expect([r['class'], r.rung, r.p86.id]).toEqual(['matched', 'Job + title', 'est-sent']);
    expect(r.corrections).toEqual([]);
    const h = fieldsOf(r.heldBack);
    expect(h.lines.applicable).toBe(false);
    expect(h.lines.note).toMatch(/went to a client or was sold \(it was sent to a client\)/);
    expect(r.p86.lifecycle).toBe('it was sent to a client');
    expect(r.notes.join(' ')).toMatch(/A sync never rewrites its line items, its title or its money/);
  });

  test('APPLIED BY NAME with every field ticked, the DATABASE ROW keeps its lines, its title and its money — only the link is written', async () => {
    const before = estRow('est-sent');
    const r = await put(ADMIN, { mode: 'rows', btIds: ['300'], fields: ['lines', 'title', 'job'] });
    expect(r.status).toBe(200);
    expect(r.json.results[0].outcome).toBe('applied');
    const after = estRow('est-sent');
    // BYTE-IDENTICAL blob. Not "the lines are the same" — the whole document.
    expect(after.data).toEqual(before.data);
    expect([after.is_locked, after.sent_at, after.sent_count]).toEqual([before.is_locked, before.sent_at, before.sent_count]);
    expect(after.attached_job_id).toBe(before.attached_job_id);
    // The ONE thing that changed, and the reason it is allowed: without it the
    // next refresh reads this worksheet as new and creates a duplicate.
    expect(after.bt_worksheet_id).toBe('300');
    expect(r.json.results[0].fields).toEqual([]);
    expect(r.json.results[0].stale.join(' ')).toMatch(/went to a client or was sold/);
  });

  test('EVERY lifecycle fact locks it, one at a time', async () => {
    const facts = [
      ['is_locked', 1, 'it is locked'],
      ['sent_count', 3, 'it has been sent 3 times'],
      ['approval_status', 'pending', 'its approval status is "pending"'],
      ['accepted_at', '2026-03-03T00:00:00Z', 'it was accepted'],
      ['approved_at', '2026-03-03T00:00:00Z', 'it was approved'],
      ['declined_at', '2026-03-03T00:00:00Z', 'it was declined'],
    ];
    for (const [col, val, word] of facts) {
      seed();
      setEst('est-a', { [col]: val });
      const ds = await estRows();
      const h = fieldsOf(byBt(ds, 100).heldBack);
      expect([col, h.lines.applicable]).toEqual([col, false]);
      expect([col, h.lines.note.indexOf(word) !== -1]).toEqual([col, true]);
      const before = estRow('est-a').data;
      await put(ADMIN, { mode: 'rows', btIds: ['100'], fields: ['lines'] });
      expect([col, estRow('est-a').data]).toEqual([col, before]);
    }
  });

  test('the SOLD marker locks it too — data.job_id, which is not attached_job_id', async () => {
    const d = estData('est-a');
    d.job_id = 'j-1';
    setEst('est-a', { data: JSON.stringify(d) });
    const ds = await estRows();
    const r = byBt(ds, 100);
    expect(fieldsOf(r.heldBack).lines.applicable).toBe(false);
    expect(r.p86.lifecycle).toMatch(/it was sold onto a job/);
    const before = estRow('est-a').data;
    await put(ADMIN, { mode: 'rows', btIds: ['100'], fields: ['lines'] });
    expect(estRow('est-a').data).toBe(before);
  });

  test('an estimate SOLD in the window between the match and the write is still refused', async () => {
    // The preview is built, the row is applicable, and only then is the estimate
    // sent. apply() re-reads and re-matches, and lockedEstimate re-checks.
    const ds = await estRows();
    expect(fieldsOf(byBt(ds, 100).heldBack).lines.applicable).toBe(true);
    setEst('est-a', { sent_at: '2026-03-04T00:00:00Z', sent_count: 1 });
    const before = estRow('est-a').data;
    const r = await put(ADMIN, { mode: 'rows', btIds: ['100'], fields: ['lines'] });
    expect(estRow('est-a').data).toBe(before);
    expect(r.json.results[0].stale.join(' ')).toMatch(/went to a client or was sold/);
  });
});

// ── APPLY: the safe press, and the money ──────────────────────────────────
describe('APPLY — the safe press links and NOTHING else; the database row proves it', () => {
  test('"Link confident matches" leaves every line, title and money exactly as they were', async () => {
    const before = allEstimates().map((r) => [r.id, doc(r.id), r.attached_job_id]);
    const r = await put(ADMIN, { mode: 'safe' });
    expect(r.status).toBe(200);
    expect(r.json.counts.linked).toBeGreaterThan(0);
    for (const [id, d, job] of before) {
      expect([id, doc(id), estRow(id).attached_job_id]).toEqual([id, d, job]);
    }
    // A SENT estimate does not even get the word: its blob is not touched at all.
    expect(JSON.parse(estRow('est-sent').data).btStatus).toBeUndefined();
    // What it DID do: save the ids.
    expect(estRow('est-a').bt_worksheet_id).toBe('100');
    expect(estRow('est-sent').bt_worksheet_id).toBe('300');
    // And it created nothing and deleted nothing.
    expect(count('estimates')).toBe(before.length);
  });

  test('an "apply everything" press that names NO fields still does not move the lines', async () => {
    const before = doc('est-a');
    const r = await put(ADMIN, { mode: 'rows', btIds: ['100'] });
    expect(r.status).toBe(200);
    expect(doc('est-a')).toBe(before);
    expect(estRow('est-a').bt_worksheet_id).toBe('100');
  });

  test('pickedHeldBack refuses the lines unless the request NAMES them, and refuses them outright in safe mode', () => {
    const row = { heldBack: [{ field: 'lines', applicable: true }, { field: 'title', applicable: true },
      { field: 'contractPrice', applicable: false }, { field: 'totalDiff', applicable: false }] };
    expect(applyMod.pickedHeldBack('estimates', row, 'rows', ['lines']).map((h) => h.field)).toEqual(['lines']);
    expect(applyMod.pickedHeldBack('estimates', row, 'rows', ['lines', 'title']).map((h) => h.field)).toEqual(['lines', 'title']);
    // No fields list at all, and safe mode: nothing.
    expect(applyMod.pickedHeldBack('estimates', row, 'rows', null)).toEqual([]);
    expect(applyMod.pickedHeldBack('estimates', row, 'safe', ['lines'])).toEqual([]);
    // Not applicable is never picked, however it is named.
    expect(applyMod.pickedHeldBack('estimates', row, 'rows', ['contractPrice', 'totalDiff'])).toEqual([]);
  });

  test('the line items and the contract price are NOT in the correction table — writable() could not apply either', () => {
    const row = { corrections: [{ field: 'lines' }, { field: 'contractPrice' }, { field: 'title' }, { field: 'job' }] };
    expect(applyMod.writable('estimates', row, 'rows', null).map((c) => c.field)).toEqual(['job']);
    // Safe mode writes no estimate field at all.
    expect(applyMod.writable('estimates', row, 'safe', null)).toEqual([]);
  });

  test('TICKED BY NAME, the lines move — into the estimate’s own alternate, and only from the array the matcher built', async () => {
    const r = await put(ADMIN, { mode: 'rows', btIds: ['100'], fields: ['lines'] });
    expect(r.status).toBe(200);
    expect(r.json.results[0].fields.map((f) => f.field)).toEqual(['lines']);
    const d = estData('est-a');
    expect(contentOf(d.lines).map((l) => l.description)).toEqual(['Cleanup', 'Framing labor', 'Lumber']);
    expect(d.lines.filter((l) => l.section === '__section_header__').map((l) => l.description)).toEqual(['Labor', 'Materials']);
    // Stamped by the WRITER, into the document it landed in.
    expect(d.lines.every((l) => l.estimateId === 'est-a' && l.alternateId === 'alt-est-a')).toBe(true);
    // And the estimate now prices at Buildertrend's owner price.
    expect(Math.round(estimateTotals.computeEstimateTotals(d).clientPrice * 100) / 100).toBe(810);
    // Sent / approval state untouched by a line write.
    const row = estRow('est-a');
    expect([row.is_locked, row.sent_at, row.sent_count, row.approval_status]).toEqual([0, null, 0, null]);
  });

  test('applying twice is a no-op: the ids are deterministic, so the second press finds nothing to do', async () => {
    await put(ADMIN, { mode: 'rows', btIds: ['100'], fields: ['lines'] });
    const after1 = estRow('est-a').data;
    const r2 = await put(ADMIN, { mode: 'rows', btIds: ['100'], fields: ['lines'] });
    expect(r2.json.results[0].outcome).toBe('unchanged');
    expect(estRow('est-a').data).toBe(after1);
  });

  test('lines somebody EDITED IN THE WINDOW are refused rather than overwritten', async () => {
    // The matcher has already decided the lines are applicable; the estimator
    // then adds a line of their own INSIDE the transaction window, which is the
    // only thing the FOR UPDATE re-read of the fingerprint exists for.
    raceAtBegin(() => {
      const d = estData('est-a');
      d.lines.push({ id: 'lnew', description: 'Typed by a person', qty: 1, unitCost: 5, markup: 0, estimateId: 'est-a', alternateId: 'alt-est-a' });
      setEst('est-a', { data: JSON.stringify(d) });
    });
    const r = await put(ADMIN, { mode: 'rows', btIds: ['100'], fields: ['lines'] });
    expect(r.status).toBe(200);
    expect(r.json.results[0].stale.join(' ')).toMatch(/Line items — P86’s lines changed since the preview/);
    expect(r.json.results[0].fields.map((f) => f.field)).not.toContain('lines');
    // The person's own line is still there, and Buildertrend's are not.
    const after = estData('est-a');
    expect(contentOf(after.lines).map((l) => l.description)).toEqual(['Old line', 'Typed by a person']);
  });

  test('an estimate somebody SENT IN THE WINDOW keeps every byte of its document', async () => {
    // The guard that bites here is lockedEstimate + lifecycleLock on the row
    // re-read FOR UPDATE, not the matcher: the matcher already said applicable.
    const ds = await estRows();
    expect(fieldsOf(byBt(ds, 100).heldBack).lines.applicable).toBe(true);
    const before = estRow('est-a').data;
    raceAtBegin(() => { setEst('est-a', { sent_at: '2026-03-09T00:00:00Z', sent_count: 1 }); });
    const r = await put(ADMIN, { mode: 'rows', btIds: ['100'], fields: ['lines', 'title'] });
    expect(estRow('est-a').data).toBe(before);
    expect(r.json.results[0].stale.join(' ')).toMatch(/went to a client or was sold/);
    expect(estRow('est-a').bt_worksheet_id).toBe('100');
  });

  test('an estimate MOVED TO ANOTHER JOB in the window is not written at all', async () => {
    // lockedEstimate re-reads the estimate THROUGH ITS JOB, and requires that
    // job to be the one this Buildertrend job is linked to. Without that, an
    // estimate somebody re-filed inside the window takes this worksheet's lines
    // — Citi Lakes' prices written onto the Waterside proposal.
    const before = doc('est-a');
    raceAtBegin(() => { setEst('est-a', { attached_job_id: 'j-2' }); });
    const r = await put(ADMIN, { mode: 'rows', btIds: ['100'], fields: ['lines'] });
    expect(r.json.results[0].outcome).toBe('skipped');
    expect(r.json.results[0].reason).toMatch(/no longer on the job linked to this Buildertrend job/);
    expect(doc('est-a')).toBe(before);
    expect(estRow('est-a').bt_worksheet_id).toBeNull();
  });

  test('an estimate somebody LINKED ELSEWHERE in the window is refused, so no two estimates carry one worksheet id', async () => {
    // bt_worksheet_id is UNIQUE in Postgres. The guard is what turns that into a
    // refusal with a sentence instead of a 23505 nobody can read.
    raceAtBegin(() => { setEst('est-only', { bt_worksheet_id: '100' }); });
    const r = await put(ADMIN, { mode: 'rows', btIds: ['100'], fields: ['lines'] });
    expect(r.json.results[0].outcome).toBe('skipped');
    expect(r.json.results[0].reason).toMatch(/Another P86 estimate is already linked/);
    expect(estRow('est-a').bt_worksheet_id).toBeNull();
  });

  test('a jobless estimate MOVED TO ANOTHER TENANT in the window is not written at all', async () => {
    // An estimate with no job has no parent row to be scoped THROUGH, so the
    // jobless arm of lockedEstimate carries the organisation predicate itself.
    const before = doc('est-loose');
    raceAtBegin(() => { setEst('est-loose', { organization_id: OTHER }); });
    const r = await put(ADMIN, { mode: 'rows', btIds: ['1000'], fields: ['job'] });
    expect(r.json.results[0].outcome).toBe('skipped');
    expect(doc('est-loose')).toBe(before);
    expect(estRow('est-loose').attached_job_id).toBeNull();
  });

  test('the job fill writes the P86 job the Buildertrend job is linked to, and nothing else', async () => {
    const before = estData('est-loose');
    const r = await put(ADMIN, { mode: 'rows', btIds: ['1000'], fields: ['job'] });
    expect(r.status).toBe(200);
    expect(estRow('est-loose').attached_job_id).toBe('j-3');
    expect(estData('est-loose').lines.map((l) => l.description)).toEqual(before.lines.map((l) => l.description));
  });

  test('a REFUSED worksheet is never applied: it is not a confident row', async () => {
    for (const id of ['800', '900', '901', '902', '600', '700']) {
      const r = await put(ADMIN, { mode: 'rows', btIds: [id], fields: ['lines'] });
      expect([id, r.json.results[0].outcome]).toEqual([id, 'skipped']);
      expect([id, /Not a confident match/.test(r.json.results[0].reason)]).toEqual([id, true]);
    }
    expect(count('estimates')).toBe(10);
  });
});

// ── CREATE ────────────────────────────────────────────────────────────────
describe('CREATE — a Buildertrend-only worksheet becomes a real P86 estimate', () => {
  test('created on its linked job, with Buildertrend’s own lines and groups, unsent and unlocked', async () => {
    const r = await put(ADMIN, { mode: 'create', btIds: ['400'] });
    expect(r.status).toBe(200);
    expect(r.json.counts.created).toBe(1);
    const id = r.json.results[0].p86Id;
    const row = estRow(id);
    expect([row.attached_job_id, row.bt_worksheet_id]).toEqual(['j-5', '400']);
    // BORN UNSENT, UNLOCKED, UNAPPROVED, and by writing NOTHING: the INSERT names
    // six columns and none of these is one of them.
    //
    // Asserted as FALSY rather than as [false, null, 0, ...] on purpose. In
    // Postgres is_locked is NOT NULL DEFAULT FALSE and sent_count NOT NULL
    // DEFAULT 0; the derived sqlite fixture drops every default and makes every
    // column nullable (test/helpers/db-schema.js says so out loud), so pinning
    // the exact value here would be pinning the FIXTURE. What production and the
    // fixture agree on, and what the guard is actually about, is that nothing
    // was written.
    for (const col of ['is_locked', 'sent_at', 'sent_count', 'approval_status', 'accepted_at', 'approved_at', 'declined_at']) {
      expect([col, !row[col]]).toEqual([col, true]);
    }
    const d = JSON.parse(row.data);
    // And NOT sold: neither half of the marker the convert route stamps.
    expect([d.job_id, d.status]).toEqual([undefined, undefined]);
    expect(d.title).toBe('Palm Bay');
    expect(contentOf(d.lines).map((l) => l.description)).toEqual(['Mobilization', 'Trim', 'Trim extra', 'Trim B']);
    expect(d.lines.filter((l) => l.section === '__section_header__').map((l) => l.description))
      .toEqual(['Building A > Labor', 'Building B > Labor']);
    expect(d.alternates.length).toBe(1);
    expect(d.lines.every((l) => l.estimateId === id && l.alternateId === d.activeAlternateId)).toBe(true);
    expect(d.btStatus).toBe('Draft');
    // The whole point: P86 prices it at what Buildertrend says the owner pays.
    expect(Math.round(estimateTotals.computeEstimateTotals(d).clientPrice * 100) / 100).toBe(1215);
  });

  test('THE ORGANIZATION COMES FROM THE PARENT JOB, and the job is OURS — not whichever tenant holds that Buildertrend id', async () => {
    // j-b2 is another tenant's job carrying the SAME Buildertrend job id 555, and
    // it is inserted BEFORE ours. A create that looked the job up without its
    // organisation predicate would reach that one first and file this tenant's
    // proposal, with its prices, into another company.
    expect(engine.db.prepare("SELECT id FROM jobs WHERE bt_job_id = '555' ORDER BY rowid").all().map((x) => x.id)).toEqual(['j-b2', 'j-5']);
    const r = await put(ADMIN, { mode: 'create', btIds: ['400'] });
    expect(r.json.counts.created).toBe(1);
    const row = estRow(r.json.results[0].p86Id);
    expect([row.attached_job_id, row.organization_id]).toEqual(['j-5', AGX]);
  });

  test('a worksheet whose Buildertrend job belongs ONLY to another tenant is never created', async () => {
    // Move ours out of the way: the Buildertrend id 555 now names one job, and it
    // is not this caller's.
    engine.db.prepare('UPDATE jobs SET bt_job_id = NULL WHERE id = ?').run('j-5');
    const before = count('estimates');
    const r = await put(ADMIN, { mode: 'create', btIds: ['400'] });
    expect(r.json.counts.created).toBe(0);
    expect(count('estimates')).toBe(before);
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM estimates WHERE attached_job_id = 'j-b2'").get().n).toBe(0);
  });

  test('the same Buildertrend worksheet is never created twice', async () => {
    await put(ADMIN, { mode: 'create', btIds: ['400'] });
    const n = count('estimates');
    const again = await put(ADMIN, { mode: 'create', btIds: ['400'] });
    expect(again.json.results[0].outcome).toBe('skipped');
    expect(count('estimates')).toBe(n);
  });

  test('a bulk create makes every creatable worksheet and no refused, ambiguous or already-matched one', async () => {
    const before = count('estimates');
    const r = await put(ADMIN, { mode: 'create', btIds: [] });
    // ws 400, 1300 and 1301 are the 'new' rows: every other worksheet is
    // matched, ambiguous or refused.
    expect(r.json.counts.created).toBe(3);
    expect(count('estimates')).toBe(before + 3);
    expect(r.json.results.filter((x) => x.p86Id).map((x) => estRow(x.p86Id).bt_worksheet_id).sort()).toEqual(['1300', '1301', '400']);
  });

  test('a REFUSED worksheet is never created, by name or in the bulk press', async () => {
    const before = count('estimates');
    const r = await put(ADMIN, { mode: 'create', btIds: ['900', '901', '902', '800', '600', '700', '1100'] });
    expect(r.json.counts.created).toBe(0);
    expect(count('estimates')).toBe(before);
  });
});

// ── LINK ──────────────────────────────────────────────────────────────────
describe('LINK — a person picks between candidates, and only a listed one', () => {
  test('only a candidate the matcher listed links, and only the id is written', async () => {
    const before = estData('est-claim');
    const r = await call('PUT', APPLY, ADMIN, { dataset: 'estimates', mode: 'link', btId: '500', p86Id: 'est-claim' });
    expect(r.status).toBe(200);
    expect(r.json.results[0].outcome).toBe('linked');
    const row = estRow('est-claim');
    expect(row.bt_worksheet_id).toBe('500');
    expect(JSON.parse(row.data)).toEqual(before);
  });

  test('a P86 estimate that is NOT a listed candidate is refused', async () => {
    const r = await call('PUT', APPLY, ADMIN, { dataset: 'estimates', mode: 'link', btId: '500', p86Id: 'est-a' });
    expect(r.json.results[0].outcome).toBe('skipped');
    expect(r.json.results[0].reason).toMatch(/not one of the candidates/);
    expect(estRow('est-a').bt_worksheet_id).toBeNull();
  });

  test('ANOTHER ORGANIZATION’s estimate never links, however it is named', async () => {
    const r = await call('PUT', APPLY, ADMIN, { dataset: 'estimates', mode: 'link', btId: '500', p86Id: 'est-x' });
    expect(r.json.results[0].outcome).toBe('skipped');
    expect(estRow('est-x').bt_worksheet_id).toBeNull();
  });
});

// ── THE TENANT ────────────────────────────────────────────────────────────
describe('THE TENANT — another organization is never read, matched or written', () => {
  test('the other tenant’s job carries the same Buildertrend job id and the same estimate title, and reaches nothing', async () => {
    const ds = await estRows();
    const r = byBt(ds, 100);
    expect(r.p86.id).toBe('est-a');
    expect(JSON.stringify(ds)).not.toContain('est-x');
    expect(JSON.stringify(ds)).not.toContain('j-b');
  });

  test('no press of any shape touches the other tenant’s estimates — the one on its job, or the JOBLESS one carrying our worksheet id', async () => {
    const before = ['est-x', 'est-loose-x'].map((id) => [id, JSON.stringify(estRow(id))]);
    await put(ADMIN, { mode: 'safe' });
    await put(ADMIN, { mode: 'rows', btIds: ['100', '1000'], fields: ['lines', 'title', 'job'] });
    await put(ADMIN, { mode: 'create', btIds: [] });
    await call('PUT', APPLY, ADMIN, { dataset: 'estimates', mode: 'link', btId: '500', p86Id: 'est-loose-x' });
    for (const [id, snap] of before) expect([id, JSON.stringify(estRow(id))]).toEqual([id, snap]);
    // And ours is the one the worksheet reached.
    expect(estRow('est-loose').attached_job_id).toBe('j-3');
  });

  test('the estimates read is scoped to this organization’s jobs, so no P86 estimate hides behind an unlisted one', async () => {
    const ds = await estRows();
    const reached = new Set();
    for (const row of ds.rows) {
      if (row.p86) reached.add(row.p86.id);
      if (row.p86Linked) reached.add(row.p86Linked.id);
      for (const c of row.candidates || []) reached.add(c.id);
    }
    expect([...reached].sort()).toEqual(['est-a', 'est-b', 'est-claim', 'est-diff', 'est-gone', 'est-loose', 'est-sent']);
  });

  test('a PM without ROLES_MANAGE is refused, and the other tenant’s admin is refused by the owner gate', async () => {
    const pm = await call('GET', PREVIEW, PM);
    expect(pm.status).toBe(403);
    const other = await call('GET', PREVIEW, OTHER_ADMIN);
    expect(other.status).toBe(403);
    const write = await put(PM, { mode: 'rows', btIds: ['100'], fields: ['lines'] });
    expect(write.status).toBe(403);
    expect(estRow('est-a').bt_worksheet_id).toBeNull();
  });
});

// ── WIRED IN EVERYWHERE A DATASET HAS TO BE ───────────────────────────────
describe('the dataset is wired in everywhere a dataset has to be', () => {
  test('estimates is a preview kind, an apply dataset, and a since-refresh snapshot', () => {
    expect(DATASETS.estimates.datasetId).toBe('6aa5d2a084f8135cf0cc607d');
    expect(applyMod.parseInput({ dataset: 'estimates', mode: 'rows', btIds: ['1'] }).error).toBeUndefined();
    expect(applyMod.parseInput({ dataset: 'nope', mode: 'rows', btIds: ['1'] }).error).toMatch(/"estimates"/);
    expect(Object.keys(since.SNAPSHOT_FIELDS)).toContain('estimates');
  });

  test('A SNAPSHOT IS PER WORKSHEET, NOT PER LINE — and snapshotOf refuses to answer for a line', () => {
    const values = BT_LINES.map(readEstimateLine);
    const snaps = since.snapshotRecords('estimates', values);
    expect(snaps.length).toBe(new Set(BT_LINES.map((r) => r.worksheetId)).size);
    const w100 = snaps.find((s) => s.btId === '100').snapshot;
    // The live lines only, and the totals that make a LINE edit visible.
    expect([w100.lineCount, w100.costTotal, w100.ownerTotal]).toEqual(['3', 700, 810]);
    expect([w100.job, w100.contractPrice, w100.proposalStatus, w100.worksheetLocked]).toEqual(['Citi Lakes', 100000, 'Draft', 'No']);
    // Loud, rather than quietly handing back the first line under the worksheet's name.
    expect(() => since.snapshotOf('estimates', values[0])).toThrow(/per WORKSHEET/);
  });

  test('a re-priced LINE reads as a CHANGE, which is the whole reason the totals are in the snapshot', () => {
    const before = since.snapshotRecords('estimates', BT_LINES.map(readEstimateLine));
    const edited = BT_LINES.map((r) => (r.lineItemId === '1001' ? Object.assign({}, r, { unitCost: 60, ownerPrice: 720 }) : r));
    const after = since.snapshotRecords('estimates', edited.map(readEstimateLine));
    const a = before.find((s) => s.btId === '100').snapshot;
    const b = after.find((s) => s.btId === '100').snapshot;
    expect(since.sameSnapshot(a, b, 'estimates')).toBe(false);
    expect(since.diffSnapshots(a, b, 'estimates').map((d) => d.field).sort()).toEqual(['costTotal', 'ownerTotal']);
  });

  test('the preview page has an Estimates tab, and the apply route names it', () => {
    const fs = require('fs');
    const path = require('path');
    const page = fs.readFileSync(path.join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8');
    expect(page).toContain("['estimates', 'Estimates']");
    expect(page).toContain("estimates: 'estimate'");
    // And the cache-buster was bumped, or the browser never loads the tab.
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    expect(html).toMatch(/js\/bt-sync-preview\.js\?v=1[89]|js\/bt-sync-preview\.js\?v=[2-9]\d/);
  });

  test('the estimate list surfaces the job column, and the blob never shadows it', () => {
    const fs = require('fs');
    const path = require('path');
    const routes = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'estimate-routes.js'), 'utf8');
    expect(routes).toContain('attached_job_id: r.attached_job_id || null');
    expect(routes).toContain('delete blob.attached_job_id;');
    expect(routes).toContain('delete blob.bt_worksheet_id;');
  });
});
