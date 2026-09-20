// BUILDERTREND -> PROJECT 86 SYNC PREVIEW: MATCHER, MONEY, READER, MAPPING,
// TENANCY, KEY, NO-WRITES AND THE PAGE — EACH EXECUTED, NONE ASSERTED FROM SOURCE.
//
// Fixtures are shaped like the REAL Clickr records from the full pull of
// 2026-09-12 (692 jobs, 44 leads): exact keys (jobName, jobStatus,
// contractPrice {value, scale}, opportunityTitle, estimatedRevenueMin ...), job
// numbers as they actually occur (S / WO / RV / R / 6-digit, shared numbers,
// two numbers in one name, "(CO1)" rows, "General" / "Pre-sale"), Warranty
// status, and leads with NO status key at all.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames } = require('./helpers/db-schema');
const { proveOrgOnly } = require('./helpers/org-only');

const ALL_TABLES = tableNames();
const engine = createPgSqlite(
  sqliteSchema(ALL_TABLES, { pk: { organizations: 'id', users: 'id', roles: 'name', jobs: 'id', leads: 'id', clients: 'id', job_change_orders: 'id' } }),
  { jsonColumns: ['data'] }
);
// The ON CONFLICT targets of the preview's own memory — server/db.js's primary
// keys on bt_record_snapshots and bt_preview_views (the derived schema has none).
engine.db.exec(`
  CREATE UNIQUE INDEX pk_bt_record_snapshots ON bt_record_snapshots(organization_id, dataset, bt_id);
  CREATE UNIQUE INDEX pk_bt_preview_views ON bt_preview_views(organization_id, user_id);
`);
globalThis.__P86_CLICKR_PREVIEW_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLICKR_PREVIEW_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const match = require('../server/services/clickr/bt-match');
const client = require('../server/services/clickr/client');
const fieldMap = require('../server/services/clickr/field-map');
const preview = require('../server/services/clickr/sync-preview');

const { fetchDataset } = client;
const { DATASETS, readJob, readLead, describeMapping } = fieldMap;

// ══════════════════════════════════════════════════════════════════════════
// REAL-SHAPE FIXTURES
// ══════════════════════════════════════════════════════════════════════════

let seq = 0;
function jobRec(jobName, o) {
  o = o || {};
  seq++;
  const rec = {
    _id: 'clickr' + seq, accountId: 'acct', integrationId: 'intg', builderId: 107896,
    jobId: o.jobId != null ? o.jobId : 50000000 + seq,
    jobName,
    jobStatus: o.jobStatus === undefined ? 'Open' : o.jobStatus,
    street: o.street === undefined ? '' : o.street,
    city: o.city === undefined ? 'Tampa' : o.city,
    state: o.state === undefined ? 'FL' : o.state,
    zip: o.zip === undefined ? '33602' : o.zip,
    projectedStart: o.projectedStart === undefined ? null : o.projectedStart,
    projectedCompletion: null,
    contractPrice: o.contractPrice === undefined ? { value: 0, scale: 2 } : o.contractPrice,
    approvedCOPrice: o.approvedCOPrice === undefined ? { value: 0, scale: 2 } : o.approvedCOPrice,
    jobRunningTotal: { value: 0, scale: 2 },
    projectManager: o.projectManager || [],
    contacts: [{ id: 7001, name: 'PAC - Overlook at Crosstown Walk' }],
    customFields: [{ label: 'Market', value: [808020] }, { label: 'Gate Code (if applicable)', value: '' }],
    latitude: null, longitude: null,
    jobType: 'Handyman Services', groups: ['Service & Repair'],
    createdDate: '2025-01-02T15:00:00.000Z', isDeleted: false,
  };
  rec.raw = Object.assign({}, rec);
  return rec;
}

function leadRec(title, o) {
  o = o || {};
  seq++;
  const rec = {
    _id: 'clickr' + seq, accountId: 'acct', integrationId: 'intg', builderId: 107896,
    leadId: 60000000 + seq,
    opportunityTitle: title,
    opportunityStreet: o.street === undefined ? '' : o.street,
    opportunityCity: o.city === undefined ? 'Tampa' : o.city,
    opportunityState: o.state === undefined ? 'FL' : o.state,
    opportunityZip: o.zip === undefined ? '33602' : o.zip,
    contactId: 8000 + seq, contactName: o.contactName === undefined ? '' : o.contactName,
    salesperson: o.salesperson === undefined ? 'Jason Salinas' : o.salesperson,
    projectType: 'Service & Repair',
    source: o.source === undefined ? '' : o.source,
    confidence: o.confidence === undefined ? 0 : o.confidence,
    estimatedRevenueMin: o.min === undefined ? 0 : o.min,
    estimatedRevenueMax: o.max === undefined ? 0 : o.max,
    notes: '', createdDate: '2026-04-03T12:00:00.000Z',
    nextActivityDate: null, nextActivityTitle: null, nextActivityAssignee: null,
    hasBeenContacted: true,
  };
  return rec;
}

const pJob = (id, d) => ({ id, data: Object.assign({ city: 'Tampa', state: 'FL', zip: '33602', status: 'In Progress', street_address: '' }, d) });
const pLead = (id, d) => Object.assign({ id, status: 'new', street_address: '', city: 'Tampa', state: 'FL', zip: '33602',
  source: '', confidence: 0, estimated_revenue_low: null, estimated_revenue_high: null, job_id: null, salesperson_name: null, client_name: null }, d);

const one = (rows, raw) => {
  const hits = rows.filter((r) => r.bt.raw === raw);
  if (hits.length !== 1) throw new Error('expected exactly one BT row "' + raw + '", got ' + hits.length);
  return hits[0];
};
const fieldsOf = (r) => r.corrections.map((c) => c.field).sort();
const noProposals = (r) => { expect([r.corrections, r.btBlank, r.heldBack, r.flags]).toEqual([[], [], [], []]); };

// ══════════════════════════════════════════════════════════════════════════
// JOB NAMES
// ══════════════════════════════════════════════════════════════════════════

describe('JOB NAMES — the number is the first token, as it really occurs', () => {
  test.each([
    ['S0145 Overlook Railing Repair', 'S0145', 'Overlook Railing Repair'],
    ['WO16 Service Call', 'WO16', 'Service Call'],
    ['RV2004 Citi Lakes Repaint and Repairs', 'RV2004', 'Citi Lakes Repaint and Repairs'],
    ['R1093 Saab Residential Roof', 'R1093', 'Saab Residential Roof'],
    ['XN0007 Fence', 'XN0007', 'Fence'],
    ['AM1000 Fairway Annual Building Pressure', 'AM1000', 'Fairway Annual Building Pressure'],
    ['437775 Solace Exterior Paint & Repairs', '437775', 'Solace Exterior Paint & Repairs'],
    ['s0020 lower-case prefix', 'S0020', 'lower-case prefix'],
  ])('%s', (name, number, title) => {
    expect(match.parseJobName(name)).toMatchObject({ number, title, isChangeOrder: false });
  });
  test('no zero-stripping: WO0012 stays WO0012, and only a LOOSE key relates it to WO12', () => {
    expect(match.parseJobName('WO0012 X').number).toBe('WO0012');
    expect(match.exactNumberKey('WO0012')).not.toBe(match.exactNumberKey('WO12'));
    expect(match.looseNumberKey('WO0012')).toBe(match.looseNumberKey('WO12'));
  });
  test('two numbers in one name are both kept (and the row is never matched on either)', () => {
    expect(match.parseJobName('RV2012/RV2013 Saddlebrook Ext Paint & Repairs')).toMatchObject({ number: null, numbers: ['RV2012', 'RV2013'] });
  });
  test('"General", "Pre-sale" and a four-letter prefix carry no number', () => {
    expect(match.parseJobName('General').numbers).toEqual([]);
    expect(match.parseJobName('Pre-sale').numbers).toEqual([]);
    expect(match.parseJobName('ABCD1234 Four Letters').numbers).toEqual([]);
  });
  test('ONLY a parenthesised (CO<digits>) is a change order', () => {
    expect(match.parseJobName('427963 (CO1) Luxe Grill Replacements')).toMatchObject({ number: '427963', isChangeOrder: true, coLabel: 'CO1', title: 'Luxe Grill Replacements' });
    expect(match.parseJobName('S1234 Denver Repaint CO 80202').isChangeOrder).toBe(false);
    expect(match.parseJobName('S1235 CO2 Monitor Install').isChangeOrder).toBe(false);
    expect(match.parseJobName('S1236 Stair Repair - CO-2').isChangeOrder).toBe(false);
    expect(match.parseJobName('CO2 Monitor Install')).toMatchObject({ number: 'CO2', isChangeOrder: false });
  });
});

describe('BLANKS, DATES AND NAMES', () => {
  test('Buildertrend blank: empty, whitespace, --, —, n/a, Unassigned, TBD; a real value is not blank', () => {
    for (const v of [null, undefined, '', '   ', '--', '—', 'n/a', 'N/A', 'Unassigned', 'TBD', []]) expect(match.isBtBlank(v)).toBe(true);
    for (const v of ['0', 'Tamp', 0, 'None of the above']) expect(match.isBtBlank(v)).toBe(false);
  });
  test('a date is its written calendar day, never shifted through a timezone', () => {
    expect(match.dateKey('2025-02-03T05:00:00.000Z')).toBe('2025-02-03');
    expect(match.dateKey('2025-02-03T23:30:00-05:00')).toBe('2025-02-03');
    expect(match.dateKey('2/3/2025')).toBe('2025-02-03');
    expect(match.dateKey('soon')).toBe('');
  });
  test('names agree only on real overlap — a one-word BT name does not match a longer P86 title', () => {
    expect(match.namesAgree('Pool', 'Hannah Pool Screen Enclosure')).toBe(false);
    expect(match.namesAgree('Solace Exterior Paint', 'Solace Exterior Paint & Repairs')).toBe(true);
    expect(match.namesAgree('Citi Lakes Repaint', 'Citi Lakes Repaint and Repairs')).toBe(true);
    expect(match.namesAgree('Luxe Pergola', 'Totally Different Work')).toBe(false);
  });
  test('typo tolerance is for words, never for two-letter codes', () => {
    expect(match.fuzzyEq('tamp', 'tampa')).toBe(true);
    expect(match.fuzzyEq('tamap', 'tampa')).toBe(true);
    expect(match.fuzzyEq('fl', 'co')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// MONEY
// ══════════════════════════════════════════════════════════════════════════

describe('MONEY — parsed, never proposed', () => {
  test.each([
    [{ value: 514625, scale: 2 }, { kind: 'value', value: 514625 }],
    [{ value: 6747.06, scale: 2 }, { kind: 'value', value: 6747.06 }],
    [{ value: 0, scale: 2 }, { kind: 'blank', zero: true }],
    ['$1,234.00', { kind: 'value', value: 1234 }],
    ['($5.00)', { kind: 'value', value: -5 }],
    ['($0.00)', { kind: 'blank', zero: true }],
    ['12.5K', { kind: 'value', value: 12500 }],
    ['$10,000 - $12,000', { kind: 'range', low: 10000, high: 12000 }],
    ['--', { kind: 'blank' }],
    [17900, { kind: 'value', value: 17900 }],
    [0, { kind: 'blank', zero: true }],
    ['call the office', { kind: 'unparsed' }],
    ['1,23,4', { kind: 'unparsed' }],
    [{ amount: 5 }, { kind: 'unparsed' }],
  ])('%j', (input, want) => {
    expect(match.parseMoney(input)).toEqual(want);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// JOBS — classes and proposals
// ══════════════════════════════════════════════════════════════════════════

describe('MATCHER — jobs', () => {
  const P86 = [
    pJob('pj-s', { jobNumber: 'S1050', title: 'Harbor Club Railings', street_address: '1 Harbor Dr', startDate: '2025-03-01', contractAmount: 12000 }),
    pJob('pj-wo', { jobNumber: 'WO0012', title: 'Bayshore Gate Repair', street_address: '5 Bay Rd' }),
    pJob('pj-rv', { jobNumber: 'RV2012', title: 'Saddlebrook Paint', street_address: '5700 Saddlebrook Way' }),
    pJob('pj-dup-a', { jobNumber: 'S2000', title: 'Lakeview Deck' }),
    pJob('pj-dup-b', { jobNumber: 'S2000', title: 'Lakeview Deck Stairs' }),
    pJob('pj-fs', { jobNumber: 'S3000', title: 'Fountain Square Repaint', street_address: '10 Fountain Sq' }),
    pJob('pj-fs2', { jobNumber: 'S3999', title: 'Fountain Square Repaint', street_address: '99 Other St' }),
    pJob('pj-pool', { jobNumber: 'S4000', title: 'Hannah Pool Screen Enclosure', street_address: '400 Palm Ave' }),
    pJob('pj-oak', { jobNumber: 'S4100', title: 'Oak Hollow Gazebo' }),
    pJob('pj-palms', { jobNumber: 'S5000', title: 'Palms Deck', status: 'Completed', street_address: '50 Palm St' }),
    pJob('pj-sunset', { jobNumber: 'S5100', title: 'Sunset Roof' }),
    pJob('pj-odd', { jobNumber: 'S5200', title: 'Crosstown Gate', status: 'Pending' }),
    pJob('pj-money', { jobNumber: 'S5300', title: 'Money Oddities', contractAmount: 5000 }),
    pJob('pj-marina', { jobNumber: '', title: 'Marina Deck Rebuild', street_address: '7 Marina Blvd', city: 'Clearwater', zip: '33767' }),
    pJob('pj-twin', { jobNumber: '', title: 'Twin Stair Repair', street_address: '8 Twin Ln' }),
    pJob('pj-near', { jobNumber: 'S8000', title: 'Clearwater Point Interior Painting', street_address: '20 Point Dr' }),
    pJob('pj-nearaddr', { jobNumber: 'S8100', title: 'Bayview Pavers', street_address: '300 Bayview Ave', zip: '' }),
    pJob('pj-luxe', { jobNumber: '427963', title: 'Luxe Pergola Paint & Repair' }),
    pJob('pj-renum', { jobNumber: 'RV2043', title: 'Solace Exterior Paint', street_address: '5 Solace Way' }),
    pJob('pj-weak', { jobNumber: 'S8300', title: 'Harbor View Stairs', street_address: '1 North St' }),
    pJob('pj-orphan-active', { jobNumber: 'S9999', title: 'Only In Project 86' }),
    pJob('pj-orphan-done', { jobNumber: 'S9998', title: 'Old Completed Job', status: 'Completed' }),
    pJob('pj-orphan-odd', { jobNumber: 'S9997', title: 'Weird Status Job', status: '' }),
  ];
  const coTotals = new Map(P86.map((p) => [p.id, { computable: true, count: 0, total: 0, source: 'no change orders in P86' }]));
  coTotals.set('pj-s', { computable: true, count: 2, total: 1000, source: 'approved and applied change orders in P86 (1 of 2)' });
  coTotals.set('pj-money', { computable: true, count: 1, total: 700, source: 'approved and applied change orders in P86 (1 of 1)' });
  coTotals.set('pj-luxe', { computable: true, count: 3, total: 0, source: 'x' });

  const BT = [
    jobRec('S1050 Harbor Club Railings', { jobStatus: 'Closed', street: '1 Harbor Drive', city: 'Tamp', state: 'Fl', zip: '',
      projectedStart: '2025-03-01T05:00:00.000Z', contractPrice: { value: 15000.5, scale: 2 }, approvedCOPrice: { value: 2500, scale: 2 } }),
    jobRec('WO12 Bayshore Gate Repair', { street: '5 Bay Rd' }),
    jobRec('RV2012/RV2013 Saddlebrook Paint', { street: '5700 Saddlebrook Way' }),
    jobRec('WO16 Service Call A'), jobRec('WO16 Service Call B'), jobRec('WO16 Service Call C'), jobRec('WO16 Service Call D'),
    jobRec('S2000 Lakeview Deck'),
    jobRec('S3000 Fountain Square Repaint', { street: '10 Fountain Sq' }),
    jobRec('S4000 Pool', { street: '12 Elm St' }),
    jobRec('S4100 Totally Different Work', { street: '1 A St' }),
    jobRec('S5000 Palms Deck', { jobStatus: 'Open', street: '50 Palm St' }),
    jobRec('S5100 Sunset Roof', { jobStatus: 'Warranty' }),
    jobRec('S5200 Crosstown Gate', { jobStatus: 'Closed' }),
    jobRec('S5300 Money Oddities', { contractPrice: 'call the office', approvedCOPrice: { value: 0, scale: 2 } }),
    jobRec('S6000 Marina Deck Rebuild', { street: '7 Marina Blvd', city: 'Clearwater', zip: '33767' }),
    jobRec('S7001 Twin Stair Repair', { street: '8 Twin Ln' }),
    jobRec('S7002 Twin Stair Repair', { street: '8 Twin Ln' }),
    jobRec('S8888 Clearwater Point Interior Paintng', { street: '99 Nowhere Rd' }),
    jobRec('S8200 Entrance Monument', { street: '300 Bayview Ave', city: 'Tamap', zip: '' }),
    jobRec('437775 Solace Exterior Paint', { street: '5 Solace Way' }),
    jobRec('S8301 Harbor View Stairs', { street: '2 South St' }),
    jobRec('S9100 A Brand New Thing', { street: '3 Nowhere Ln', city: 'Orlando', zip: '32801' }),
    jobRec('S1234 Denver Repaint CO 80202', { state: 'CO', city: 'Denver', zip: '80202', street: '1 Blake St' }),
    jobRec('General', { jobStatus: 'Open' }),
    jobRec('Pre-sale', { jobStatus: 'Open' }),
    jobRec('   ', { jobStatus: 'Open' }),
    jobRec('427963 Luxe Pergola Paint & Repair', { jobStatus: 'Closed' }),
    jobRec('427963 (CO1) Luxe Grill Replacements', { jobStatus: 'Closed' }),
  ];
  const rows = match.matchJobs(BT.map(readJob), P86, { coTotals });

  test('EXACT NUMBER: BT street spelling (format), BT typo city (value, flagged), "Fl" (format), Closed -> Completed; blank BT zip is kept', () => {
    const r = one(rows, 'S1050 Harbor Club Railings');
    expect(r).toMatchObject({ class: 'conflict', rung: 'number' });
    expect(r.p86.id).toBe('pj-s');
    expect(fieldsOf(r)).toEqual(['city', 'contractPrice', 'state', 'status', 'street']);
    expect(r.corrections.find((c) => c.field === 'street')).toMatchObject({ from: '1 Harbor Dr', to: '1 Harbor Drive', kind: 'format' });
    const city = r.corrections.find((c) => c.field === 'city');
    expect(city).toMatchObject({ from: 'Tampa', to: 'Tamp', kind: 'value' });
    expect(city.typo).toMatch(/fix it in Buildertrend/);
    expect(r.corrections.find((c) => c.field === 'state')).toMatchObject({ from: 'FL', to: 'Fl', kind: 'format' });
    expect(r.corrections.find((c) => c.field === 'status')).toMatchObject({ from: 'In Progress', to: 'Closed', toP86: 'Completed' });
    expect(r.btBlank).toEqual([{ field: 'zip', label: 'Zip', p86: '33602' }]);
  });

  test('EXACT NUMBER: Buildertrend\'s contract price is a CORRECTION (owner: BT is the source of truth); approved COs stay held back, not applicable; the number is not proposed', () => {
    const r = one(rows, 'S1050 Harbor Club Railings');
    expect(r.corrections.find((c) => c.field === 'contractPrice')).toMatchObject({
      kind: 'value', money: true, from: '$12,000.00', to: '$15,000.50', value: 15000.5, p86Value: 12000 });
    expect(r.heldBack.map((h) => [h.field, h.p86, h.bt, h.reason, h.applicable])).toEqual([
      ['approvedCOPrice', '$1,000.00', '$2,500.00', 'money', false],
    ]);
    expect(r.corrections.some((c) => /approvedCO|jobNumber/i.test(c.field))).toBe(false);
  });

  test('the same calendar day written as an instant is not a correction', () => {
    expect(one(rows, 'S1050 Harbor Club Railings').corrections.some((c) => c.field === 'startDate')).toBe(false);
  });

  test('WO12 vs P86 WO0012: the same number WRITTEN DIFFERENTLY is ambiguous, never a match', () => {
    const r = one(rows, 'WO12 Bayshore Gate Repair');
    expect(r.class).toBe('ambiguous');
    expect(r.candidates.map((c) => c.id)).toEqual(['pj-wo']);
    expect(r.notes.join(' ')).toMatch(/written differently/);
    noProposals(r);
  });

  test('two numbers in one name: ambiguous', () => {
    const r = one(rows, 'RV2012/RV2013 Saddlebrook Paint');
    expect(r.class).toBe('ambiguous');
    expect(r.candidates.map((c) => c.id)).toEqual(['pj-rv']);
    noProposals(r);
  });

  test('a number shared by four BT rows: the number is ignored for them and each falls back to the evidence that remains', () => {
    const hits = rows.filter((r) => r.bt.number === 'WO16');
    expect(hits).toHaveLength(4);
    for (const r of hits) {
      // None of the four has a name or an address P86 knows, so each is NEW —
      // where the old refusal left all four permanently unclearable.
      expect(r.class).toBe('new');
      expect(r.notes.join(' ')).toMatch(/4 Buildertrend jobs carry the number WO16, so it identifies none of them/);
      // The renumber instruction survives only where it is still TRUE: the create.
      expect(r.notes.join(' ')).toMatch(/only one of the 4 can be created/);
    }
  });

  test('P86 holds two jobs with the number: ambiguous with both', () => {
    const r = one(rows, 'S2000 Lakeview Deck');
    expect(r.class).toBe('ambiguous');
    expect(r.candidates.map((c) => c.id).sort()).toEqual(['pj-dup-a', 'pj-dup-b']);
    expect(r.notes[0]).toMatch(/P86 holds 2 jobs numbered S2000/);
  });

  test('same name and address, but P86 numbers the job differently (RV2043 vs 437775): ambiguous, not a match', () => {
    const r = one(rows, '437775 Solace Exterior Paint');
    expect(r.class).toBe('ambiguous');
    expect(r.notes[0]).toMatch(/P86 numbers this job RV2043 and Buildertrend 437775/);
    noProposals(r);
  });

  test('a new number whose only counterpart shares the NAME at another address: weak, ambiguous', () => {
    const r = one(rows, 'S8301 Harbor View Stairs');
    expect(r.class).toBe('ambiguous');
    expect(r.notes[0]).toMatch(/Only a weak match \(name\)/);
    expect(r.candidates.map((c) => c.id)).toEqual(['pj-weak']);
  });

  test('NEVER FIRST-RUNG-WINS: one number hit, but a DIFFERENT P86 job has the same name — ambiguous, both listed', () => {
    const r = one(rows, 'S3000 Fountain Square Repaint');
    expect(r.class).toBe('ambiguous');
    expect(r.candidates.map((c) => c.id).sort()).toEqual(['pj-fs', 'pj-fs2']);
    expect(r.candidates.find((c) => c.id === 'pj-fs').rungs).toEqual(expect.arrayContaining(['number', 'name + address']));
    noProposals(r);
  });

  test('REUSED NUMBER: name AND street disagree — ambiguous, never a rename + re-address ("Pool" vs "Hannah Pool Screen Enclosure")', () => {
    const r = one(rows, 'S4000 Pool');
    expect(r.class).toBe('ambiguous');
    expect(r.notes.join(' ')).toMatch(/may be reused/);
    noProposals(r);
  });

  test('REUSED NUMBER, no street to confirm it: a disagreeing name is still ambiguous', () => {
    expect(one(rows, 'S4100 Totally Different Work').class).toBe('ambiguous');
  });

  test('BT Open against P86 Completed is proposed as an active status, with the choice named', () => {
    const r = one(rows, 'S5000 Palms Deck');
    expect(r.class).toBe('conflict');
    expect(r.corrections).toEqual([expect.objectContaining({ field: 'status', from: 'Completed', to: 'Open', toP86: 'In Progress' })]);
  });

  test('WARRANTY is a real P86 status now: a correction, not a flag', () => {
    const r = one(rows, 'S5100 Sunset Roof');
    expect(r.class).toBe('conflict');
    expect(r.flags).toEqual([]);
    expect(r.corrections).toEqual([expect.objectContaining({
      field: 'status', kind: 'value', from: 'In Progress', to: 'Warranty', toP86: 'Warranty' })]);
    expect(r.corrections[0].note).toMatch(/WIP, backlog, revenue earned and margin are unchanged/);
  });

  test('a P86 status outside P86\'s vocabulary is UNKNOWN: no status proposal', () => {
    const r = one(rows, 'S5200 Crosstown Gate');
    expect(r.class).toBe('matched');
    expect(r.corrections).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/outside P86's job status vocabulary/);
  });

  test('an unparseable contract is held back as UNPARSED (never blank); a $0 approved-CO total is Buildertrend blank and P86 keeps its $700', () => {
    const r = one(rows, 'S5300 Money Oddities');
    expect(r.heldBack).toEqual([expect.objectContaining({ field: 'contractPrice', reason: 'unparsed', p86: '$5,000.00' })]);
    expect(r.btBlank).toEqual([expect.objectContaining({ field: 'approvedCOPrice', p86: '$700.00', zero: true, money: true })]);
    expect(r.corrections).toEqual([]);
  });

  test('NAME + ADDRESS with a P86 job that has no number: matched, and the number is held back as identity', () => {
    const r = one(rows, 'S6000 Marina Deck Rebuild');
    expect(r).toMatchObject({ class: 'matched', rung: 'name + address' });
    expect(r.heldBack).toEqual([expect.objectContaining({ field: 'jobNumber', reason: 'identity', bt: 'S6000', p86: '' })]);
  });

  test('TWO BT rows landing confidently on ONE P86 job: both ambiguous, proposals cleared', () => {
    for (const raw of ['S7001 Twin Stair Repair', 'S7002 Twin Stair Repair']) {
      const r = one(rows, raw);
      expect(r.class).toBe('ambiguous');
      expect(r.candidates.map((c) => c.id)).toEqual(['pj-twin']);
      noProposals(r);
    }
  });

  test('POSSIBLE DUPLICATE, not "created": a similar name, and a same street with a typo\'d city (Tamap)', () => {
    const a = one(rows, 'S8888 Clearwater Point Interior Paintng');
    expect(a.class).toBe('possible_duplicate');
    expect(a.candidates.map((c) => c.id)).toEqual(['pj-near']);
    const b = one(rows, 'S8200 Entrance Monument');
    expect(b.class).toBe('possible_duplicate');
    expect(b.candidates.map((c) => c.id)).toEqual(['pj-nearaddr']);
    expect(b.candidates[0].rungs).toEqual(['same address, typo-tolerant']);
  });

  test('no counterpart anywhere: new — and "CO 80202" in a Denver job is not a change order', () => {
    expect(one(rows, 'S9100 A Brand New Thing').class).toBe('new');
    expect(one(rows, 'S1234 Denver Repaint CO 80202').class).toBe('new');
  });

  test('"General" and "Pre-sale" are NOT A JOB; a blank name is REFUSED and never created', () => {
    expect(one(rows, 'General').class).toBe('not_a_job');
    expect(one(rows, 'Pre-sale').class).toBe('not_a_job');
    const r = rows.find((x) => x.bt.raw === '');
    expect(r.class).toBe('refused');
    expect(r.notes[0]).toMatch(/no name.*never be created/);
  });

  test('a (CO1) row is a change order on its parent — the parent is NOT made ambiguous by sharing its number', () => {
    const parent = one(rows, '427963 Luxe Pergola Paint & Repair');
    expect(parent.class).toBe('conflict');
    const co = one(rows, '427963 (CO1) Luxe Grill Replacements');
    expect(co.class).toBe('change_order');
    expect(co.parent).toMatchObject({ btRaw: '427963 Luxe Pergola Paint & Repair', p86ChangeOrders: 3 });
    expect(co.parent.p86.id).toBe('pj-luxe');
    expect(co.p86).toBeNull();
    noProposals(co);
  });

  test('IN P86, NOT IN BUILDERTREND: only ACTIVE unreached jobs are listed (unknown status included); completed ones are counted; every candidate counts as reached', () => {
    const nib = match.notInBuildertrend(rows, P86, 'jobs');
    expect(nib.rows.map((p) => p.id).sort()).toEqual(['pj-orphan-active', 'pj-orphan-odd']);
    expect(nib.rows.find((p) => p.id === 'pj-orphan-odd').state86).toBe('unknown');
    expect(nib.notListed).toBe(1);
  });

  test('the match rate excludes change orders, not-a-job and refused rows', () => {
    const s = match.summarise(rows);
    // The four WO16 rows moved from ambiguous to new when the shared number
    // stopped refusing them; the match-rate base is unchanged (both count).
    expect(s.counts).toEqual({ matched: 3, conflict: 4, ambiguous: 10, possible_duplicate: 2, new: 6, change_order: 1, not_a_job: 2, refused: 1 });
    expect(s.matchRateBase).toBe(25);
    expect(s.matchRate).toBeCloseTo(7 / 25, 10);
    const open = match.summarise(rows, (r) => r.bt.scope === 'open');
    expect(open.records).toBe(rows.filter((r) => ['Open', 'Warranty'].includes(r.bt.status)).length);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// JOBS — WARRANTY, P86's own status
// ══════════════════════════════════════════════════════════════════════════
//
// Warranty is a state86 of its OWN and is deliberately NOT folded into
// 'active'. Both directions depend on that: folded in, "Buildertrend reopened
// this warranty job" could never fire; left out of the vocabulary entirely, a
// P86 job literally set to Warranty stops ALL status comparison and a later
// Buildertrend Closed proposes nothing at all, with no note, on a row that
// renders as a clean match.
describe('MATCHER — jobs — Warranty is in the vocabulary, in its own state', () => {
  test('the vocabulary itself: Warranty maps to its own state, never to active', () => {
    expect(match.p86JobState('Warranty')).toBe('warranty');
    expect(match.p86JobState('warranty')).toBe('warranty');
    expect(match.p86JobState('In Progress')).toBe('active');
    expect(match.p86JobState('Nonsense')).toBe(null);
  });

  const P86 = [
    pJob('w-same', { jobNumber: 'W1000', title: 'Warranty Job', status: 'Warranty' }),
    pJob('w-close', { jobNumber: 'W1001', title: 'Warranty Closing', status: 'Warranty' }),
    pJob('w-open', { jobNumber: 'W1002', title: 'Warranty Reopening', status: 'Warranty' }),
    pJob('w-into', { jobNumber: 'W1003', title: 'Active Job' }),
    pJob('w-done', { jobNumber: 'W1004', title: 'Finished Job', status: 'Completed' }),
    pJob('w-arch', { jobNumber: 'W1005', title: 'Archived Job', status: 'Archived' }),
  ];
  const coTotals = new Map(P86.map((p) => [p.id, { computable: true, count: 0, total: 0, source: 'no change orders in P86' }]));
  const BT = [
    jobRec('W1000 Warranty Job', { jobStatus: 'Warranty' }),
    jobRec('W1001 Warranty Closing', { jobStatus: 'Closed' }),
    jobRec('W1002 Warranty Reopening', { jobStatus: 'Open' }),
    jobRec('W1003 Active Job', { jobStatus: 'Warranty' }),
    jobRec('W1004 Finished Job', { jobStatus: 'Warranty' }),
    jobRec('W1005 Archived Job', { jobStatus: 'Warranty' }),
  ];
  const wrows = match.matchJobs(BT.map(readJob), P86, { coTotals });
  const statusOf = (raw) => one(wrows, raw).corrections.filter((c) => c.field === 'status');

  test('Warranty on BOTH sides agrees: matched, no correction, no flag, no note', () => {
    const r = one(wrows, 'W1000 Warranty Job');
    expect(r.class).toBe('matched');
    noProposals(r);
    expect(r.notes).toEqual([]);
  });

  test('Buildertrend CLOSED against a P86 Warranty job still proposes Completed', () => {
    // Without warranty in the closed arm this row proposes NOTHING, silently.
    expect(statusOf('W1001 Warranty Closing')).toEqual([expect.objectContaining({
      field: 'status', from: 'Warranty', to: 'Closed', toP86: 'Completed' })]);
    expect(one(wrows, 'W1001 Warranty Closing').notes).toEqual([]);
  });

  test('Buildertrend OPEN against a P86 Warranty job proposes In Progress (warranty is not folded into active)', () => {
    expect(statusOf('W1002 Warranty Reopening')).toEqual([expect.objectContaining({
      field: 'status', from: 'Warranty', to: 'Open', toP86: 'In Progress' })]);
  });

  test('Buildertrend WARRANTY against an active P86 job proposes Warranty', () => {
    expect(statusOf('W1003 Active Job')).toEqual([expect.objectContaining({
      field: 'status', from: 'In Progress', to: 'Warranty', toP86: 'Warranty' })]);
    expect(one(wrows, 'W1003 Active Job').flags).toEqual([]);
  });

  test('Buildertrend WARRANTY against a COMPLETED P86 job proposes Warranty', () => {
    // The ordinary way a job enters its warranty period.
    expect(statusOf('W1004 Finished Job')).toEqual([expect.objectContaining({
      field: 'status', from: 'Completed', to: 'Warranty', toP86: 'Warranty' })]);
  });

  test('Buildertrend WARRANTY against an ARCHIVED P86 job proposes NOTHING', () => {
    // The arm ENUMERATES the states a job goes into warranty from, as the
    // closed arm does. Negating it (`p.state86 !== 'warranty'') also fired on
    // 'archived': a correction, ticked by default, no confirm — one press
    // un-archived the job back into Active Jobs, the Schedule board, market P&L
    // and the WIP roll-up. What a Buildertrend status should do to an archived
    // P86 job is not decided, and the correction's own note ("the job stays
    // active") would be untrue of one coming out of the archive.
    expect(statusOf('W1005 Archived Job')).toEqual([]);
    const r = one(wrows, 'W1005 Archived Job');
    expect(r.corrections.map((c) => c.field)).not.toContain('status');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// REPEAT WORK AT ONE PROPERTY, AND A NUMBER BUILDERTREND GAVE OUT TWICE
//
// Both halves are the live 2026-09 preview, not theory: 31 of 34 ambiguous
// leads were refused for "only the address matches", and 35 of 41 ambiguous
// jobs had no P86 candidate at all — they were ambiguous against EACH OTHER
// inside Buildertrend over a number P86 cannot renumber.
// ══════════════════════════════════════════════════════════════════════════

describe('AN ADDRESS IS A PROPERTY; A LEAD IS A PIECE OF WORK AT IT', () => {
  // The real row. 21 P86 leads carry 257 Milwaukee Avenue because AGX has done
  // 21 pieces of work at that complex — a sign of a good client, not a
  // duplicate. Not one of them is a laundry-room conversion.
  const AT = { street_address: '257 Milwaukee Avenue', city: 'Dunedin', state: 'FL', zip: '34698' };
  const TITLES = [
    'Edgewater Golf Cart Charging Stations', 'Edgewater Roof Leak 255/205', 'Edgewater Leasing Office Leak',
    'Belleair Roof Hatch Replacement Building 1', 'Edgewater Pool Deck Pressure Wash', 'Edgewater Mailbox Kiosk Repaint',
    'Edgewater Dumpster Enclosure Gates', 'Edgewater Stair Tread Replacement 210', 'Edgewater Clubhouse Interior Paint',
    'Edgewater Carport Post Repairs', 'Edgewater Fence Section 12', 'Edgewater Sidewalk Trip Hazard Grinding',
    'Edgewater Breezeway Lighting', 'Edgewater Gutter Cleaning', 'Edgewater Balcony Railing Repaint 110',
    'Edgewater Entry Monument Sign', 'Edgewater Unit 304 Water Intrusion', 'Edgewater Roof Vent Boots',
    'Edgewater Soffit Repairs 230', 'Edgewater Car Charger Bollards', 'Edgewater Trash Chute Doors',
  ];
  const P86 = TITLES.map((t, i) => pLead('edge-' + i, Object.assign({ title: t }, AT)));
  const btAt = (title, o) => leadRec(title, Object.assign({ street: '257 Milwaukee Avenue', city: 'Dunedin', zip: '34698',
    contactName: 'BH - Promenade at Edgewater Apartments' }, o || {}));
  const run = (rec, p86) => match.matchLeads([rec].map(readLead), p86 || P86, {});

  test('THE EDGEWATER ROW: the only overlap with 21 P86 leads is the address, so it is NEW and nothing is proposed', () => {
    const rows = run(btAt('Edgewater - Building 259 Laundry Room Conversion'));
    expect(rows[0].class).toBe('new');
    expect(rows[0].candidates).toEqual([]);
    noProposals(rows[0]);
  });

  test('...and the row still NAMES every lead at that property, so nothing is created blind', () => {
    const rows = run(btAt('Edgewater - Building 259 Laundry Room Conversion'));
    expect(rows[0].considered.map((c) => c.id)).toEqual(P86.map((p) => p.id));
    expect(rows[0].considered.map((c) => c.rungs.join(', '))).toEqual(P86.map(() => 'address'));
    expect(rows[0].notes.join(' ')).toMatch(/P86 holds 21 leads at 257 Milwaukee Avenue, Dunedin, FL, 34698/);
    expect(rows[0].notes.join(' ')).toMatch(/an address is a property and a lead is a piece of work at it/i);
    // Shown on the row is what keeps them out of "in P86, not in Buildertrend".
    expect(match.notInBuildertrend(rows, P86, 'leads').rows).toEqual([]);
  });

  test('the note no longer tells anyone the address alone refused the row', () => {
    const rows = run(btAt('Edgewater - Building 259 Laundry Room Conversion'));
    expect(rows[0].notes.join(' ')).not.toMatch(/Only the address matches/);
    expect(rows[0].notes.join(' ')).not.toMatch(/Nothing is proposed/);
  });

  // ── THE RISK THE LOOSENING CREATES, AND THE PATH THAT HAS TO CLOSE IT ──
  // Today's refusal was preventing duplicates by accident. These are the cases
  // that must not become a second P86 lead. Each drives the real title
  // comparison, so weakening it turns them red.
  test.each([
    ['Edgewater Roof Leak 255/205', 'Roof leak at Edgewater 255 and 205'],
    ['Bldg 9 Balcony Repairs', 'Building 9 Balcony Repair'],
    ['Edgewater Roof Leak 255/205', 'Roof Leak - Edgewater Bldgs 255 & 205'],
    ['Waterside I Siding Replacement', 'Waterside 1 Siding Replacment'],
    ['Bay Pointe Roof Hatch Replacement', 'Roof hatch replacements at Bay Pointe'],
  ])('the same work worded differently is still the same work: %s / %s', (a, b) => {
    expect(match.nearTitles(a, b)).toBe(true);
    expect(match.nearTitles(b, a)).toBe(true);
  });

  test('...and a different piece of work at the same complex is NOT: the 21 stay apart', () => {
    for (const t of TITLES) {
      expect(match.nearTitles('Edgewater - Building 259 Laundry Room Conversion', t)).toBe(false);
    }
  });

  test('A BUILDERTREND LEAD THAT IS AN EXISTING P86 LEAD, WORDED DIFFERENTLY: possible_duplicate, never new', () => {
    const rows = run(btAt('Roof leak at Edgewater 255 and 205'));
    expect(rows[0].class).toBe('possible_duplicate');
    expect(rows[0].candidates.map((c) => [c.title, c.rungs.join(', ')]))
      .toEqual([['Edgewater Roof Leak 255/205', 'address, similar title']]);
    expect(rows[0].notes[0]).toMatch(/reads like this one worded differently/);
    noProposals(rows[0]);
    // The other 20 at that address are context, not candidates — and the note
    // counts the leads it lists, not the leads at the address.
    expect(rows[0].considered).toHaveLength(20);
    expect(rows[0].notes.join(' ')).toMatch(/P86 holds 20 other leads at 257 Milwaukee Avenue/);
  });

  test('...at a DIFFERENT address too: the fuzzy title carries it on its own', () => {
    const rows = run(btAt('Roof leak at Edgewater 255 and 205', { street: '9 Somewhere Else Rd', city: 'Tampa', zip: '33602' }));
    expect(rows[0].class).toBe('possible_duplicate');
    expect(rows[0].candidates.map((c) => [c.title, c.rungs.join(', ')]))
      .toEqual([['Edgewater Roof Leak 255/205', 'similar title']]);
    expect(rows[0].considered || []).toEqual([]);
  });

  // ── loosening the address rule loosened NEITHER confirming rung ──
  test('a title + address match still matches, and the other leads at the address stay "also considered"', () => {
    const rows = run(btAt('Edgewater Gutter Cleaning'));
    expect(rows[0]).toMatchObject({ class: 'matched', rung: 'title + address' });
    expect(rows[0].p86.title).toBe('Edgewater Gutter Cleaning');
    expect(rows[0].considered).toHaveLength(20);
  });

  test('a title + client match still matches, with no address at all in common', () => {
    const p86 = P86.map((p) => (p.title === 'Edgewater Gutter Cleaning'
      ? Object.assign({}, p, { client_name: 'BH - Promenade at Edgewater Apartments' }) : p));
    const rec = leadRec('Edgewater Gutter Cleaning', { street: '1 Elsewhere St', city: 'Tampa', zip: '33602',
      contactName: 'BH - Promenade at Edgewater Apartments' });
    const rows = match.matchLeads([rec].map(readLead), p86, {});
    // Confident on the client, so Buildertrend's address is PROPOSED onto it —
    // a confident row carrying a correction is "conflict", never "ambiguous".
    expect(rows[0]).toMatchObject({ class: 'conflict', rung: 'title + client' });
    expect(rows[0].p86.id).toBe('edge-13');
    expect(rows[0].corrections.map((c) => c.field).sort()).toEqual(['city', 'street', 'zip']);
  });
});

describe('THE NEAR INDEX AND THE ONE-PAIR TEST ANSWER THE SAME QUESTION', () => {
  // nearIndex sums Dice off a bigram posting list; nearTitles compares one pair
  // outright. The matcher reads BOTH — the index for its near rungs, the pair
  // test for a lead at an address it is deciding about — so a drift between
  // them would make the same two titles near on one path and not on the other.
  const WORDS = ['Harbor', 'Edgewater', 'Belleair', 'Waterside', 'Roof', 'Paint', 'Repairs', 'Repair', 'Railings',
    'Bldg 9', 'Building 9', 'Leak', 'Leaks', 'Balcony', 'Stairs', 'Gate', 'at', 'and', '255', '205', 'Phase 2'];
  const pick = (n, seed) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(WORDS[(seed * (i + 3) * 7 + i * 11) % WORDS.length]);
    return out.join(' ');
  };
  const ITEMS = [];
  for (let i = 0; i < 120; i++) ITEMS.push({ id: 'i' + i, title: pick(2 + (i % 4), i + 1), street: '' });

  test('every query: the posting list returns exactly the brute-force answer, in item order', () => {
    const near = match.nearIndex(ITEMS, (it) => it.title);
    const noSkip = () => false;
    const LABELS = { name: 'similar title', place: 'same address, typo-tolerant' };
    let hitRows = 0;
    for (let q = 0; q < 60; q++) {
      const title = pick(2 + (q % 4), q * 3 + 2);
      const got = near(title, { street: '', city: '', state: '', zip: '' }, noSkip, LABELS)
        .filter((h) => h.why.indexOf(LABELS.name) !== -1).map((h) => h.it.id);
      const want = ITEMS.filter((it) => match.nearTitles(title, it.title)).map((it) => it.id);
      expect(got).toEqual(want);
      if (want.length) hitRows++;
    }
    // A vacuous pass — no query ever matching anything — would prove nothing.
    expect(hitRows).toBeGreaterThan(10);
  });
});

describe('A BUILDERTREND NUMBER MORE THAN ONE JOB CARRIES IDENTIFIES NONE OF THEM', () => {
  const P86 = [
    pJob('wj-bal', { jobNumber: 'WO25', title: 'Edgewater Balcony Repairs', street_address: '257 Milwaukee Avenue', city: 'Dunedin', zip: '34698' }),
    pJob('wj-hatch', { jobNumber: 'WO31', title: 'Belleair Roof Hatch', street_address: '88 Belleair Rd', city: 'Largo', zip: '33770' }),
    pJob('wj-gate', { jobNumber: 'WO40', title: 'Seaside Gate Motor', street_address: '9 Other Way' }),
    pJob('wj-once', { jobNumber: 'WO90', title: 'Harborview Stair Repair' }),
  ];
  const BT = [
    jobRec('WO25 Edgewater Balcony Repairs', { street: '257 Milwaukee Avenue', city: 'Dunedin', zip: '34698' }),
    jobRec('WO25 Belleair Roof Hatch', { street: '88 Belleair Rd', city: 'Largo', zip: '33770' }),
    jobRec('WO25 Seaside Gate Motor', { street: '1 Nowhere Ln' }),
    jobRec('WO25 Brand New Pressure Wash', { street: '44 Fresh St' }),
    jobRec('WO25 Another Unknown Thing', { street: '77 Unknown Ave' }),
    jobRec('WO90 Harborview Stair Repair'),
  ];
  const rows = match.matchJobs(BT.map(readJob), P86, {});
  const at = (raw) => one(rows, raw);

  test('the one whose name AND address find a P86 job is MATCHED, although P86 numbers it WO25 itself', () => {
    expect(at('WO25 Edgewater Balcony Repairs')).toMatchObject({ class: 'matched', rung: 'name + address' });
    expect(at('WO25 Edgewater Balcony Repairs').p86.id).toBe('wj-bal');
    expect(at('WO25 Edgewater Balcony Repairs').notes.join(' ')).toMatch(/5 Buildertrend jobs carry the number WO25/);
  });

  test('a P86 job numbered DIFFERENTLY still matches on name + address, and its number is never offered for renumbering', () => {
    const r = at('WO25 Belleair Roof Hatch');
    expect(r).toMatchObject({ class: 'matched', rung: 'name + address' });
    expect(r.p86.id).toBe('wj-hatch');
    expect(r.notes.join(' ')).toMatch(/P86 keeps its own number WO31/);
    const held = r.heldBack.find((h) => h.field === 'jobNumber');
    expect(held).toMatchObject({ bt: 'WO25', p86: 'WO31', applicable: false });
    expect(held.note).toMatch(/5 Buildertrend jobs carry the number WO25, so it is not offered here/);
  });

  test('the one the remaining evidence cannot tell apart stays ambiguous, with a note that is now true', () => {
    const r = at('WO25 Seaside Gate Motor');
    expect(r.class).toBe('ambiguous');
    expect(r.candidates.map((c) => [c.id, c.rungs.join(', ')])).toEqual([['wj-gate', 'name']]);
    expect(r.notes.join(' ')).toMatch(/Only a weak match \(name\)/);
    expect(r.notes.join(' ')).toMatch(/5 Buildertrend jobs carry the number WO25, so it identifies none of them/);
    expect(r.notes.join(' ')).not.toMatch(/give each its own number in Buildertrend/);
    noProposals(r);
  });

  test('the ones P86 has never seen are NEW, and the renumber instruction survives only where it is still true', () => {
    for (const raw of ['WO25 Brand New Pressure Wash', 'WO25 Another Unknown Thing']) {
      expect(at(raw).class).toBe('new');
      expect(at(raw).notes.join(' ')).toMatch(/P86 numbers one job with it, so only one of the 5 can be created/);
    }
  });

  test('the P86 job that carries the shared number is shown on every row it did not decide, and never counted absent', () => {
    for (const raw of ['WO25 Seaside Gate Motor', 'WO25 Brand New Pressure Wash', 'WO25 Another Unknown Thing']) {
      expect(at(raw).considered.map((c) => [c.id, c.rungs.join(', ')])).toEqual([['wj-bal', 'number (shared in Buildertrend)']]);
    }
    expect(match.notInBuildertrend(rows, P86, 'jobs').rows).toEqual([]);
  });

  test('no two Buildertrend jobs claim one P86 job', () => {
    const claimed = rows.filter((r) => r.p86).map((r) => r.p86.id);
    expect(claimed.sort()).toEqual(['wj-bal', 'wj-hatch', 'wj-once']);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  test('a job number used ONCE still matches on the number alone, exactly as before', () => {
    expect(at('WO90 Harborview Stair Repair')).toMatchObject({ class: 'matched', rung: 'number' });
    expect(at('WO90 Harborview Stair Repair').p86.id).toBe('wj-once');
    expect(at('WO90 Harborview Stair Repair').considered).toEqual([]);
  });

  test('demoteCollisions still fires: two Buildertrend jobs that both land on one P86 job are BOTH refused', () => {
    const crash = match.matchJobs([
      jobRec('WO25 Belleair Roof Hatch', { street: '88 Belleair Rd', city: 'Largo', zip: '33770' }),
      jobRec('WO25 Filler Row'),
      jobRec('WO31 Belleair Roof Hatch', { street: '88 Belleair Rd', city: 'Largo', zip: '33770' }),
    ].map(readJob), P86, {});
    const hits = crash.filter((r) => r.bt.raw.indexOf('Belleair') !== -1);
    expect(hits).toHaveLength(2);
    for (const r of hits) {
      expect(r.class).toBe('ambiguous');
      expect(r.p86).toBe(null);
      expect(r.notes.join(' ')).toMatch(/2 Buildertrend jobs all land on this same P86 job/);
      noProposals(r);
    }
    expect(crash.filter((r) => r.p86)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// LEADS
// ══════════════════════════════════════════════════════════════════════════

describe('NEAR RUNGS — collected for every row, listed on ambiguous rows, never blocking an exact match', () => {
  test('jobs: a shared-number row lists the SAME-name job AND the similar-name job; neither is then "not in Buildertrend"', () => {
    const P86 = [
      pJob('n-exact', { jobNumber: 'S100', title: 'Harbor Club Railings' }),
      pJob('n-similar', { jobNumber: 'S900', title: 'Harbor Club Railing' }),
      pJob('n-typo-addr', { jobNumber: 'S901', title: 'Unrelated Pavers', street_address: '44 Seaside Blvd', city: 'Tampa', zip: '' }),
    ];
    const BT = [
      jobRec('WO16 Harbor Club Railings', { street: '44 Seaside Blvd', city: 'Tamap', zip: '' }),
      jobRec('WO16 Something Else'),
    ];
    const rows = match.matchJobs(BT.map(readJob), P86, {});
    const r = rows[0];
    expect(r.class).toBe('ambiguous');
    const byId = Object.fromEntries(r.candidates.map((c) => [c.id, c.rungs]));
    expect(byId).toEqual({ 'n-exact': ['name'], 'n-similar': ['similar name'], 'n-typo-addr': ['same address, typo-tolerant'] });
    noProposals(r);
    expect(match.notInBuildertrend(rows, P86, 'jobs').rows).toEqual([]);
  });

  test('jobs: an exact number whose name agrees stays CONFIDENT although another P86 job has a similar name — and that job is not reached', () => {
    const P86 = [
      pJob('n-exact', { jobNumber: 'S100', title: 'Harbor Club Railings' }),
      pJob('n-similar', { jobNumber: 'S900', title: 'Harbor Club Railing' }),
    ];
    const rows = match.matchJobs([jobRec('S100 Harbor Club Railings')].map(readJob), P86, {});
    expect(rows[0]).toMatchObject({ class: 'matched', rung: 'number' });
    expect(match.notInBuildertrend(rows, P86, 'jobs').rows.map((x) => x.id)).toEqual(['n-similar']);
  });

  test('leads: an unconfirmed title lists the similar-title lead too; neither is then "not in Buildertrend"', () => {
    const P86 = [
      pLead('nl-x', { title: 'Roof Hatch Replacement', street_address: '4 Bay Ct' }),
      pLead('nl-y', { title: 'Roof Hatch Replacemnt', street_address: '9 Other Rd' }),
    ];
    const rows = match.matchLeads([leadRec('Roof Hatch Replacement', { street: '1 Nowhere Rd' })].map(readLead), P86, {});
    expect(rows[0].class).toBe('ambiguous');
    expect(Object.fromEntries(rows[0].candidates.map((c) => [c.id, c.rungs]))).toEqual({ 'nl-x': ['title'], 'nl-y': ['similar title'] });
    expect(match.notInBuildertrend(rows, P86, 'leads').rows).toEqual([]);
  });
});

describe('MATCHER — leads (no status key exists; revenue $0 is blank)', () => {
  const P86 = [
    pLead('pl-gaz', { title: 'Gazebo at Oak Hollow', status: 'sent', street_address: '12 Oak Hollow Dr', zip: '33610',
      estimated_revenue_low: '10000.00', estimated_revenue_high: '12000.00', salesperson_name: 'Adam Silva', client_name: 'Oak Hollow HOA', source: 'Referral', confidence: 50 }),
    pLead('pl-w1', { title: 'Waterside I Siding Replacement', street_address: '1 Waterside Way', client_name: 'RPM - Waterside 1' }),
    pLead('pl-w2', { title: 'Waterside I Siding Replacement', street_address: '1 Waterside Way', client_name: 'RPM - Waterside 1' }),
    pLead('pl-bp1', { title: 'Bay Pointe - Roof Hatch Replacement', street_address: '4 Bay Pointe Ct', client_name: 'Associa Gulf Coast - Bay Pointe' }),
    // A LOST same-title lead: repeat work that is closed does not block the open match.
    pLead('pl-bp2', { title: 'Bay Pointe - Roof Hatch Replacement', status: 'lost', street_address: '900 Elsewhere Rd', client_name: 'Other' }),
    pLead('pl-sold', { title: 'Palms Clubhouse Roof', status: 'sold', street_address: '5 Palms Rd', has_job: true, client_name: 'Palms HOA' }),
    pLead('pl-noconf', { title: 'Fountain Square Repaint' }),
    pLead('pl-sp', { title: 'Bayview Pavers', street_address: '300 Bayview Ave', zip: '33611' }),
    pLead('pl-sp2', { title: 'Harbor Railings', street_address: '1 Harbor Dr' }),
    pLead('pl-typo', { title: 'Lakeshore Fence Replacement Project', street_address: '77 Lake St' }),
    pLead('pl-open-orphan', { title: 'Only In P86 Lead' }),
    pLead('pl-lost-orphan', { title: 'Lost Lead', status: 'lost' }),
    pLead('pl-odd', { title: 'Odd Status Lead', status: 'archived' }),
  ];
  const directory = {
    users: [{ id: 21, name: 'Jason Salinas' }, { id: 22, name: 'Noah Pillsbury' }, { id: 23, name: 'Noah  Pillsbury' }, { id: 24, name: 'Adam Silva' }],
    clients: [{ id: 'c-bay', name: 'Bayview HOA' }, { id: 'c-oak', name: 'Oak Hollow HOA' }, { id: 'c-tw1', name: 'Twice Client' }, { id: 'c-tw2', name: 'Twice Client' }],
  };
  const BT = [
    leadRec('Gazebo at Oak Hollow', { street: '12 Oak Hollow Dr', zip: '33610', contactName: 'Oak Hollow HOA', salesperson: 'Unassigned', min: 0, max: 17900 }),
    leadRec('Waterside I Siding Replacement', { street: '1 Waterside Way', contactName: 'RPM - Waterside 1', salesperson: 'Adam Silva' }),
    leadRec('Bay Pointe - Roof Hatch Replacement', { street: '4 Bay Pointe Ct', contactName: 'Associa Gulf Coast - Bay Pointe', salesperson: '' }),
    leadRec('Palms Clubhouse Roof', { street: '5 Palms Rd', contactName: 'Palms Condo Assn', salesperson: '' }),
    leadRec('Fountain Square Repaint', { street: '10 Fountain Sq', contactName: 'BH - Fountain Square Apartments', salesperson: '' }),
    leadRec('Bayview Pavers', { street: '300 Bayview Ave', zip: '33611', salesperson: 'Jason  Salinas ', contactName: 'Bayview HOA', source: 'Previous Client', confidence: 88 }),
    leadRec('Harbor Railings', { street: '1 Harbor Dr', salesperson: 'Noah Pillsbury', contactName: 'Twice Client', min: 'about 5k', max: '$10,000 - $12,000' }),
    leadRec('Lakeshore Fence Replacment Project', { street: '1 Different Rd' }),
    leadRec('Totally Unknown Opportunity', { street: '1 Unique Rd', zip: '33999' }),
    leadRec('  ', {}),
  ];
  const values = BT.map(readLead);
  const rows = match.matchLeads(values, P86, { directory });
  const nth = (i) => rows[i];

  test('the lead records carry no status key, and nothing about status is ever proposed', () => {
    expect(BT.every((r) => !('leadStatus' in r) && !('status' in r))).toBe(true);
    expect(rows.every((r) => r.corrections.every((c) => c.field !== 'status'))).toBe(true);
  });

  test('BT "Unassigned" salesperson, blank source, 0 confidence and $0 low revenue erase nothing; $17,900 high is held back with both figures', () => {
    const r = nth(0);
    expect(r).toMatchObject({ class: 'matched', rung: 'title + address' });
    expect(r.corrections).toEqual([]);
    expect(r.btBlank.map((b) => b.field)).toEqual(['salesperson', 'source', 'confidence', 'estimatedRevenueMin']);
    expect(r.btBlank.find((b) => b.field === 'estimatedRevenueMin')).toMatchObject({ p86: '$10,000.00', zero: true });
    expect(r.heldBack).toEqual([expect.objectContaining({ field: 'estimatedRevenueMax', p86: '$12,000.00', bt: '$17,900.00', reason: 'money' })]);
  });

  test('two same-title leads that BOTH agree on address and client: ambiguous', () => {
    expect(nth(1).class).toBe('ambiguous');
    expect(nth(1).candidates.map((c) => c.id).sort()).toEqual(['pl-w1', 'pl-w2']);
    noProposals(nth(1));
  });

  test('two same-title leads, exactly one agrees on address and the other is CLOSED: matched, the other shown as considered and kept out of "not in Buildertrend"', () => {
    expect(nth(2)).toMatchObject({ class: 'matched', rung: 'title + address' });
    expect(nth(2).p86.id).toBe('pl-bp1');
    expect(nth(2).considered.map((c) => c.id)).toEqual(['pl-bp2']);
    expect(nth(2).notes.join(' ')).toMatch(/1 other P86 lead with this title is closed or already a job/);
  });

  test('a SOLD, converted P86 lead: flagged, and its client is never proposed', () => {
    const r = nth(3);
    expect(r.class).toBe('matched');
    expect(r.flags[0].text).toMatch(/sold.*lists only open leads/);
    expect(r.notes.join(' ')).toMatch(/already converted/);
  });

  test('a unique title that neither address nor client confirms: ambiguous', () => {
    expect(nth(4).class).toBe('ambiguous');
    expect(nth(4).notes[0]).toMatch(/neither the address nor the client/);
  });

  test('salesperson onto EXACTLY ONE active user (spacing ignored), client onto exactly one client, source and non-zero confidence filled', () => {
    const r = nth(5);
    expect(r.class).toBe('conflict');
    expect(r.corrections.map((c) => [c.field, c.from, c.to, c.kind, c.toP86])).toEqual([
      ['salesperson', '', 'Jason Salinas', 'fill', 'user #21'],
      ['client', '', 'Bayview HOA', 'fill', 'client c-bay'],
      ['source', '', 'Previous Client', 'fill', undefined],
      ['confidence', '', '88', 'fill', undefined],
    ]);
  });

  test('two users share the salesperson name, two clients share the contact name: nothing proposed, each said; unparsed and range revenue held back', () => {
    const r = nth(6);
    expect(r.corrections).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/2 active P86 users have that name/);
    expect(r.notes.join(' ')).toMatch(/2 P86 clients have that name/);
    expect(r.heldBack.map((h) => [h.field, h.reason, h.bt])).toEqual([
      ['estimatedRevenueMin', 'unparsed', 'about 5k'],
      ['estimatedRevenueMax', 'money', '$10,000.00 – $12,000.00'],
    ]);
  });

  test('a typo\'d title is a possible duplicate, a new title is new, a blank title is refused', () => {
    expect(nth(7).class).toBe('possible_duplicate');
    expect(nth(7).candidates.map((c) => c.id)).toEqual(['pl-typo']);
    expect(nth(8).class).toBe('new');
    expect(nth(9).class).toBe('refused');
  });

  test('IN P86, NOT IN BUILDERTREND: open and unknown-status leads listed; lost leads expected absent and counted', () => {
    const nib = match.notInBuildertrend(rows, P86, 'leads');
    expect(nib.rows.map((p) => p.id).sort()).toEqual(['pl-odd', 'pl-open-orphan']);
    expect(nib.notListed).toBe(1);
  });

  // L1. Buildertrend's Leads dataset holds OPEN leads only, so a lead it sells,
  // loses or closes simply stops arriving. P86 is told, and nothing else.
  test('a lead linked to a Buildertrend lead that left the open list is MARKED, after a complete read only, and nothing is proposed for it', () => {
    const linked = P86.map((p) => (p.id === 'pl-open-orphan' ? Object.assign({}, p, { bt_lead_id: '  77880  ' }) : p));
    const complete = match.notInBuildertrend(rows, linked, 'leads', { readComplete: true });
    const gone = complete.rows.find((p) => p.id === 'pl-open-orphan');
    expect(gone.linkedGone).toBe(true);
    // Nothing is proposed: no correction, no new status, no archive.
    for (const k of ['corrections', 'heldBack', 'flags', 'btBlank', 'proposedStatus', 'archive']) expect(gone[k]).toBeUndefined();
    expect(gone.status).toBe('new');
    // A lead that carries no Buildertrend id says nothing either way.
    expect(complete.rows.find((p) => p.id === 'pl-odd').linkedGone).toBeUndefined();

    // A PARTIAL read proves nothing: the Buildertrend lead may be in the part never fetched.
    const partial = match.notInBuildertrend(rows, linked, 'leads', { readComplete: false });
    expect(partial.rows.find((p) => p.id === 'pl-open-orphan').linkedGone).toBeUndefined();
    expect(match.notInBuildertrend(rows, linked, 'leads').rows.find((p) => p.id === 'pl-open-orphan').linkedGone).toBeUndefined();

    // And an id the read DID carry is not "gone", even when this lead is unreached.
    const still = P86.map((p) => (p.id === 'pl-open-orphan' ? Object.assign({}, p, { bt_lead_id: String(rows[0].bt.btId) }) : p));
    expect(match.notInBuildertrend(rows, still, 'leads', { readComplete: true }).rows.find((p) => p.id === 'pl-open-orphan').linkedGone).toBeUndefined();

    // BOTH SIDES are normalised. Padding on the BUILDERTREND id must not make a
    // lead that IS still open read as sold, lost or closed — the mark is the only
    // thing this list says about it, and it cannot be a false positive.
    const padded = [{ bt: { index: 0, btId: '  77880  ', raw: 'padded' }, p86: null, candidates: [] }];
    const clean = P86.map((p) => (p.id === 'pl-open-orphan' ? Object.assign({}, p, { bt_lead_id: '77880' }) : p));
    expect(match.notInBuildertrend(padded, clean, 'leads', { readComplete: true }).rows.find((p) => p.id === 'pl-open-orphan').linkedGone).toBeUndefined();
    // A DIFFERENT id in the read still leaves it marked, so the check has teeth.
    const other = [{ bt: { index: 0, btId: '  99999  ', raw: 'padded' }, p86: null, candidates: [] }];
    expect(match.notInBuildertrend(other, clean, 'leads', { readComplete: true }).rows.find((p) => p.id === 'pl-open-orphan').linkedGone).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// MAPPING
// ══════════════════════════════════════════════════════════════════════════

describe('MAPPING — exact keys, required key on 95% of records', () => {
  test('a real-shape record reads every key, and ignores raw/_id', () => {
    const d = describeMapping('jobs', [jobRec('S1 A'), jobRec('S2 B')]);
    expect(d.requiredOk).toBe(true);
    expect(d.missingKeys).toEqual([]);
    expect(d.unexpectedKeys).toEqual([]);
  });

  test('jobName renamed to "Job" on every record: refused, with a sentence naming the field and the count; "Job" is listed as an unread key', () => {
    const recs = [jobRec('S1 A'), jobRec('S2 B')].map((r) => { const o = Object.assign({}, r, { Job: r.jobName }); delete o.jobName; return o; });
    const d = describeMapping('jobs', recs);
    expect(d.requiredOk).toBe(false);
    expect(d.refusal).toMatch(/^Only 0 of 2 jobs records carry a usable "jobName"/);
    expect(d.unexpectedKeys.map((k) => k.key)).toContain('Job');
    // No generic fallback: a record with only `name` has no job name.
    expect(readJob({ name: 'S1 A', title: 'x' }).jobName).toBeNull();
  });

  test('94% non-empty is refused, 95% is not', () => {
    const mk = (blank, n) => Array.from({ length: n }, (_, i) => leadRec(i < blank ? '' : 'Lead ' + i));
    expect(describeMapping('leads', mk(6, 100)).requiredOk).toBe(false);
    expect(describeMapping('leads', mk(5, 100)).requiredOk).toBe(true);
    expect(describeMapping('leads', mk(6, 100)).refusal).toMatch(/Only 94 of 100 leads records carry a usable "opportunityTitle"/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// READER
// ══════════════════════════════════════════════════════════════════════════

const KEY = 'ck_live_Zq9SECRETKEYxy7_0123456789ab';   // 36 chars, like production's
const BASE = 'https://api.clickr.cloud';
const recsN = (from, n) => Array.from({ length: n }, (_, i) => jobRec('S' + (from + i) + ' Row ' + (from + i), { jobId: 900000 + from + i }));

function scripted(handler) {
  const calls = [];
  const t = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization, timeoutMs: opts.timeoutMs });
    return handler(new URL(url), calls.length);
  };
  t.calls = calls;
  return t;
}
const ok = (body) => ({ status: 200, text: JSON.stringify(body) });
const envelope = (records, count, extra) => Object.assign({ recordType: 'jobs', columns: [{ key: 'jobName', label: 'Job', type: 'text' }], records, count, sort: {} }, extra || {});

function read(transport, extra) {
  return fetchDataset(Object.assign({ apiKey: KEY, datasetId: 'ds1', label: 'Jobs', transport, baseUrl: BASE, limits: { pageSize: 3 } }, extra || {}));
}

// A skip/limit server over `total` records that reports `count`.
function skipServer(total, opts) {
  const o = opts || {};
  const all = recsN(0, total);
  return scripted((u) => {
    const skip = Number(u.searchParams.get('skip') || 0);
    const limit = Number(u.searchParams.get('limit') || 3);
    const size = o.pageSize || limit;
    return ok(envelope(all.slice(skip, skip + size), o.count === undefined ? total : o.count));
  });
}

describe('READER — complete only when fetched === count AND Clickr signalled the end', () => {
  test('skip/limit over 7 records, count 7: complete, 3 pages, the key sent only in the header', async () => {
    const t = skipServer(7);
    const r = await read(t);
    expect(r).toMatchObject({ fetched: 7, reportedCount: 7, pages: 3, mode: 'skip/limit', complete: true, reason: null });
    expect(t.calls.map((c) => new URL(c.url).searchParams.get('skip'))).toEqual(['0', '3', '6']);
    expect(t.calls.every((c) => c.auth === 'Bearer ' + KEY && !c.url.includes(KEY))).toBe(true);
  });

  test('exactly a page multiple (6 of 6): the empty page after is the end signal', async () => {
    const r = await read(skipServer(6));
    expect(r).toMatchObject({ fetched: 6, pages: 3, complete: true });
  });

  test('Clickr ignores limit and sends all 7 at once: the follow-up empty page confirms it', async () => {
    const all = recsN(0, 7);
    const t = scripted((u) => ok(envelope(Number(u.searchParams.get('skip')) ? [] : all, 7)));
    expect(await read(t)).toMatchObject({ fetched: 7, complete: true });
  });

  test('COUNT USED AS LIMIT (count is the page size): fetched > count is PARTIAL', async () => {
    const r = await read(skipServer(7, { count: 3 }));
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/more records were fetched \(7\) than Clickr's count \(3\)/);
  });

  test('A SHORT PAGE before the count: PARTIAL, fetched N of M', async () => {
    const r = await read(skipServer(7, { pageSize: 2 }));
    expect(r.complete).toBe(false);
    expect(r.fetched).toBe(2);
    expect(r.reason).toMatch(/last page after 2 records, short of its count of 7/);
    const s = preview.fetchedSentence(DATASETS.jobs, r);
    expect(s).toMatch(/^PARTIAL READ: fetched 2 of 7 jobs\./);
  });

  test('no count at all: PARTIAL; a bare list: PARTIAL', async () => {
    const all = recsN(0, 2);
    expect((await read(scripted(() => ok({ records: all })))).reason).toMatch(/reported no count/);
    expect((await read(scripted(() => ok(all)))).reason).toMatch(/reported no count/);
  });

  test('a string total "1,234" is not a count: PARTIAL; "2" as a string is', async () => {
    const all = recsN(0, 2);
    const bad = await read(scripted(() => ok(envelope(all, '1,234'))));
    expect(bad.complete).toBe(false);
    expect(bad.reason).toMatch(/not a plain whole number/);
    expect((await read(scripted(() => ok(envelope(all, '2'))))).complete).toBe(true);
  });

  test('a count that changes between pages: PARTIAL', async () => {
    const all = recsN(0, 5);
    const t = scripted((u) => { const s = Number(u.searchParams.get('skip')); return ok(envelope(all.slice(s, s + 3), s ? 5 : 6)); });
    expect((await read(t)).reason).toMatch(/count changed between pages/);
  });

  test('a repeated page (skip ignored): PARTIAL, and it stops', async () => {
    const all = recsN(0, 3);
    const t = scripted(() => ok(envelope(all, 9)));
    const r = await read(t);
    expect(t.calls).toHaveLength(2);
    expect(r.reason).toMatch(/repeated a page/);
  });

  test('the same record on two pages (paging drifted): PARTIAL', async () => {
    const all = recsN(0, 5);
    const t = scripted((u) => { const s = Number(u.searchParams.get('skip')); return ok(envelope(s ? [all[2], all[3], all[4]].slice(0, 2) : all.slice(0, 3), 5)); });
    expect((await read(t)).reason).toMatch(/arrived more than once/);
  });

  test('NEXT LINK across pages: complete when the last page has no link and fetched === count', async () => {
    const all = recsN(0, 5);
    const t = scripted((u) => {
      const p = Number(u.searchParams.get('p') || 1);
      return ok(envelope(all.slice((p - 1) * 3, p * 3), 5, p === 1 ? { next: '/v2/datasets/ds1/records?p=2' } : {}));
    });
    expect(await read(t)).toMatchObject({ fetched: 5, pages: 2, mode: 'next link', complete: true });
  });

  test('MISSING NEXT LINK: page 1 has one, page 2 does not, count not reached — PARTIAL', async () => {
    const all = recsN(0, 9);
    const t = scripted((u) => {
      const p = Number(u.searchParams.get('p') || 1);
      return ok(envelope(all.slice((p - 1) * 3, p * 3), 9, p === 1 ? { next: BASE + '/v2/datasets/ds1/records?p=2' } : {}));
    });
    const r = await read(t);
    expect(r).toMatchObject({ fetched: 6, complete: false });
    expect(r.reason).toMatch(/short of its count of 9/);
  });

  test('a MALFORMED next link is a partial read with a sentence, never a throw', async () => {
    const t = scripted(() => ok(envelope(recsN(0, 3), 9, { next: 'http://[::1' })));
    const r = await read(t);
    expect(r.error).toBeNull();
    expect(r.reason).toMatch(/next-page link on page 1 could not be read/);
  });

  test('a next link to ANOTHER HOST is not followed, and the host is not echoed', async () => {
    const t = scripted(() => ok(envelope(recsN(0, 3), 9, { next: 'https://collector.evil.example/steal' })));
    const r = await read(t);
    expect(t.calls).toHaveLength(1);
    expect(r.reason).toMatch(/different host/);
    expect(JSON.stringify(r.reason)).not.toMatch(/evil/);
  });

  test('CURSOR with empty pages and hasMore: stops after two empty pages, PARTIAL', async () => {
    let n = 0;
    const t = scripted(() => { n++; return ok(envelope(n === 1 ? recsN(0, 3) : [], 10, { nextCursor: 'c' + n, hasMore: true })); });
    const r = await read(t);
    expect(t.calls).toHaveLength(3);
    expect(r.reason).toMatch(/two pages in a row came back empty/);
  });

  test('CURSOR ending with hasMore false and the count reached: complete', async () => {
    const t = scripted((u) => (u.searchParams.get('cursor')
      ? ok(envelope(recsN(3, 2), 5, { nextCursor: null, hasMore: false }))
      : ok(envelope(recsN(0, 3), 5, { nextCursor: 'abc', hasMore: true }))));
    expect(await read(t)).toMatchObject({ fetched: 5, mode: 'cursor', complete: true });
  });

  test('a LATER page failing keeps page 1 as PARTIAL with a fixed sentence', async () => {
    const t = scripted((u) => (Number(u.searchParams.get('skip')) ? { status: 503, text: '{"error":"db down at 10.0.0.5"}' } : ok(envelope(recsN(0, 3), 692))));
    const r = await read(t);
    expect(r).toMatchObject({ fetched: 3, complete: false, error: null });
    expect(r.reason).toBe('page 2 failed: Clickr failed on its side while serving the Jobs dataset (HTTP 503)');
    expect(preview.fetchedSentence(DATASETS.jobs, r)).toMatch(/^PARTIAL READ: fetched 3 of 692 jobs\./);
  });

  test('the page cap and the deadline each stop the read as PARTIAL', async () => {
    const capped = await read(skipServer(30), { limits: { pageSize: 3, maxPages: 4 } });
    expect(capped).toMatchObject({ pages: 4, complete: false });
    expect(capped.reason).toMatch(/4-page cap/);
    let clock = 0;
    const slow = scripted((u) => { clock += 6000; const s = Number(u.searchParams.get('skip')); return ok(envelope(recsN(s, 3), 30)); });
    const r = await read(slow, { now: () => clock, limits: { pageSize: 3, deadlineMs: 15000 } });
    expect(r.reason).toMatch(/time limit/);
  });

  test('the verdict: a loop that stopped without Clickr\'s end signal is PARTIAL even when fetched === count', () => {
    const fresh = () => ({ records: [1, 2, 3], fetched: 3, reportedCount: 3, complete: false, reason: null, error: null });
    // Control: the same numbers WITH the end signal are complete.
    expect(client.settleRead(fresh(), { endSignal: true })).toMatchObject({ complete: true, reason: null });
    for (const flags of [{}, { endSignal: false }, { endSignal: 'yes' }, undefined]) {
      const r = client.settleRead(fresh(), flags);
      expect(r.complete).toBe(false);
      expect(r.reason).toBe('the read ended without Clickr signalling the last page');
    }
    // A reason or an error recorded in the loop is kept, never overwritten.
    const withReason = Object.assign(fresh(), { reason: 'the read stopped at the 4-page cap' });
    expect(client.settleRead(withReason, { endSignal: true })).toMatchObject({ complete: false, reason: 'the read stopped at the 4-page cap' });
    const withError = Object.assign(fresh(), { error: { kind: 'auth', message: 'x' } });
    expect(client.settleRead(withError, { endSignal: true })).toMatchObject({ complete: false, reason: null });
  });
});

describe('READER — every failure is a FIXED sentence; Clickr\'s body is never read into it', () => {
  const hostile = JSON.stringify({ error: 'bad token ' + KEY, message: 'Bearer ' + KEY });
  test.each([
    [401, 'unauthorized', /^Clickr refused the key for the Jobs dataset \(HTTP 401\)/],
    [403, 'unauthorized', /HTTP 403/],
    [404, 'not_found', /no Jobs dataset at the configured id/],
    [429, 'rate_limited', /rate-limited/],
    [500, 'upstream', /failed on its side/],
    [418, 'http', /HTTP 418, which this preview does not accept/],
  ])('HTTP %i', async (status, kind, re) => {
    const r = await read(scripted(() => ({ status, text: hostile })));
    expect(r.error.kind).toBe(kind);
    expect(r.error.message).toMatch(re);
    expect(r.error.message).not.toMatch(/bad token|Bearer/);
    expect(JSON.stringify(r)).not.toContain(KEY.slice(0, 8));
  });
  test('missing key: nothing is requested', async () => {
    const t = scripted(() => ok(envelope([], 0)));
    const r = await fetchDataset({ apiKey: '', datasetId: 'ds1', label: 'Jobs', transport: t });
    expect(t.calls).toHaveLength(0);
    expect(r.error.message).toMatch(/CLICKR_API_KEY is not set/);
  });
  test('a transport error carrying the key is not echoed', async () => {
    const r = await read(async () => { throw new Error('socket hang up Bearer ' + KEY); });
    expect(r.error).toEqual({ kind: 'transport', message: 'Could not reach Clickr for the Jobs dataset (page 1).' });
  });
  test('a timeout', async () => {
    const r = await read(async () => { const e = new Error('x'); e.code = 'TIMEOUT'; throw e; });
    expect(r.error.kind).toBe('timeout');
  });
  test('a null JSON body gets its own sentence', async () => {
    const r = await read(scripted(() => ({ status: 200, text: 'null' })));
    expect(r.error.message).toMatch(/empty \(null\) JSON body/);
  });
  test('not JSON, and JSON with no records list', async () => {
    expect((await read(scripted(() => ({ status: 200, text: '<html>login</html>' })))).error.message).toMatch(/not JSON/);
    expect((await read(scripted(() => ok({ status: 'queued' })))).error.message).toMatch(/no "records" list/);
    expect((await read(scripted(() => ok(42)))).error.message).toMatch(/JSON number/);
  });
});

describe('READER — the real transport: the timeout really aborts, redirects are refused', () => {
  let srv;
  let port;
  let redirectTargetHits = 0;
  let hangingSockets = [];
  // The HTTP section swaps global.fetch for a Clickr stub; these tests need the
  // REAL fetch, or a refused redirect would pass for the stub's own reason.
  let stubbed;
  beforeAll(() => { stubbed = global.fetch; global.fetch = origFetch; });
  afterAll(() => { global.fetch = stubbed; });
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      if (req.url.startsWith('/hang')) { hangingSockets.push(res); return; }
      if (req.url.startsWith('/slow-body')) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"records":['); hangingSockets.push(res); return; }
      if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: '/target' }); res.end(); return; }
      if (req.url.startsWith('/target')) { redirectTargetHits++; res.writeHead(200); res.end('{"records":[],"count":0}'); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    port = srv.address().port;
  });
  afterAll(async () => {
    for (const s of hangingSockets) { try { s.destroy(); } catch (e) { /* closed */ } }
    await new Promise((r) => srv.close(r));
  });

  test('control: the real transport reads a plain 200 from this server (so the refusals below are not the transport failing for some other reason)', async () => {
    const r = await client.fetchTransport('http://127.0.0.1:' + port + '/target', { headers: {}, timeoutMs: 2000 });
    expect(r).toEqual({ status: 200, text: '{"records":[],"count":0}' });
    redirectTargetHits = 0;
  });

  test('a server that never answers is aborted at the timeout', async () => {
    const t0 = Date.now();
    await expect(client.fetchTransport('http://127.0.0.1:' + port + '/hang', { headers: {}, timeoutMs: 150 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test('a body that never finishes is aborted too (the timer covers the body read)', async () => {
    await expect(client.fetchTransport('http://127.0.0.1:' + port + '/slow-body', { headers: {}, timeoutMs: 150 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  test('a redirect is refused and its target never receives the Authorization header', async () => {
    await expect(client.fetchTransport('http://127.0.0.1:' + port + '/redirect', { headers: { Authorization: 'Bearer ' + KEY }, timeoutMs: 2000 }))
      .rejects.toMatchObject({ code: 'TRANSPORT' });
    expect(redirectTargetHits).toBe(0);
  });

  test('a refused connection is a TRANSPORT error whose message is the fixed word, never the exception\'s own text', async () => {
    const closed = http.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = closed.address().port;
    await new Promise((r) => closed.close(r));
    let err = null;
    try {
      await client.fetchTransport('http://127.0.0.1:' + deadPort + '/x', { headers: { Authorization: 'Bearer ' + KEY }, timeoutMs: 2000 });
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('TRANSPORT');
    expect(err.message).toBe('transport');
    expect(err.cause).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// HTTP — the real router, the real middleware, a real SQL engine
// ══════════════════════════════════════════════════════════════════════════

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const orgRoutes = require('../server/routes/admin-organizations-routes');

const AGX = 1;
const OTHER = 2;
const BT_MARK = 'ZZBUILDERTRENDMARK';
const B = 'ZZOTHERTENANTMARK';

let server;
let baseUrl;
const origFetch = global.fetch;
let fetchCalls = [];
let clickrMode = 'ok';
let leadsOverride = null;

const HTTP_JOBS = [
  jobRec('S1050 Harbor Club Railings ' + BT_MARK, { jobStatus: 'Open', street: '1 Harbor Dr', city: 'Tamp',
    contractPrice: { value: 15000, scale: 2 }, approvedCOPrice: { value: 2500, scale: 2 } }),
  jobRec('WO16 Service Call A'),
  jobRec('WO16 Service Call B'),
  jobRec('General'),
  jobRec('427963 (CO1) Luxe Grill Replacements', { jobStatus: 'Closed' }),
  jobRec('S5555 Shared Title Probe', { street: '55 Probe St' }),
];
const HTTP_LEADS = [
  leadRec('Gazebo at Oak Hollow ' + BT_MARK, { street: '12 Oak Hollow Dr', salesperson: 'Ana Ruiz', contactName: 'Oak Hollow HOA', max: 17900 }),
  leadRec('Cross Tenant Probe', { street: '9 Probe Rd', salesperson: B + ' Seller', contactName: B + ' Client' }),
];

function clickrFetch(url, opts) {
  const u = new URL(url);
  fetchCalls.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization, signal: !!(opts && opts.signal), redirect: opts && opts.redirect });
  if (u.origin !== BASE) throw new Error('test: fetch reached a non-Clickr host');
  const respond = (status, obj) => Promise.resolve({ status, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });
  if (clickrMode === 'unauthorized-echo') return respond(401, { error: 'bad token ' + KEY + ' (Authorization: Bearer ' + KEY + ')' });
  if (clickrMode === 'throw-with-key') return Promise.reject(new Error('socket hang up while sending Bearer ' + KEY));
  if (clickrMode === 'malformed-next-jobs' && u.pathname.includes(DATASETS.jobs.datasetId)) return respond(200, envelope(HTTP_JOBS, 9, { next: 'http://[::1' }));
  if (clickrMode === 'malformed-next-leads' && u.pathname.includes(DATASETS.leads.datasetId)) {
    const LP = leadsOverride || HTTP_LEADS;
    return respond(200, envelope(LP, LP.length + 3, { next: 'http://[::1' }));
  }
  const skip = Number(u.searchParams.get('skip') || 0);
  const limit = Number(u.searchParams.get('limit') || 200);
  if (u.pathname.includes(DATASETS.jobs.datasetId)) return respond(200, envelope(HTTP_JOBS.slice(skip, skip + limit), HTTP_JOBS.length));
  if (u.pathname.includes(DATASETS.leads.datasetId)) {
    const L = leadsOverride || HTTP_LEADS;
    return respond(200, envelope(L.slice(skip, skip + limit), L.length));
  }
  return respond(404, { error: 'Route not found' });
}

function seed() {
  engine.db.exec(`
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', '${B} Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ROLES_MANAGE","USERS_MANAGE","JOBS_VIEW_ALL"]'),
      ('pm', 'PM', '["JOBS_VIEW_ALL","LEADS_VIEW"]'),
      ('system_admin', 'System Admin', '["ROLES_MANAGE","USERS_MANAGE","SYSTEM_ADMIN"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'admin@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (11, 'pm@agx.test', 'x', 'Pat PM', 'pm', 1, 1),
      (12, 'owner@p86.test', 'x', 'Platform Owner', 'system_admin', 2, 1),
      (14, 'seller@other.test', 'x', '${B} Seller', 'pm', 2, 1),
      (15, 'gone@agx.test', 'x', 'Ana Ruiz', 'pm', 1, 0);
    INSERT INTO clients (id, name, organization_id) VALUES
      ('c-a', 'Oak Hollow HOA', 1), ('c-b', '${B} Client', 2), ('c-b2', '${B} Joined Client', 2);
  `);
  const job = engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, data) VALUES (?,?,?,?)');
  job.run('j-a1', 10, AGX, JSON.stringify({ jobNumber: 'S1050', title: 'Harbor Club Railings ' + BT_MARK, status: 'In Progress', street_address: '1 Harbor Dr', city: 'Tampa', state: 'FL', zip: '33602', contractAmount: 12000 }));
  job.run('j-a2', 10, AGX, JSON.stringify({ jobNumber: 'RV2043', title: 'Luxe Pergola Paint & Repair', status: 'In Progress' }));
  job.run('j-a3', 10, AGX, JSON.stringify({ jobNumber: 'S0001', title: 'Legacy CO Job', status: 'Completed', changeOrders: [{ income: 400 }, { income: 100 }] }));
  // Another tenant's job with the same title and street as a BT row: if the
  // jobs WHERE fell away, S5555 would gain a candidate from org B.
  job.run('j-b1', 12, OTHER, JSON.stringify({ jobNumber: 'S5555', title: 'Shared Title Probe', status: 'In Progress', street_address: '55 Probe St', city: 'Tampa', zip: '33602' }));
  job.run('j-b2', 12, OTHER, JSON.stringify({ jobNumber: 'S7777', title: B + ' Active Job', status: 'In Progress' }));
  job.run('j-null', 10, null, JSON.stringify({ jobNumber: 'S5555', title: 'Shared Title Probe', status: 'In Progress', street_address: '55 Probe St', city: 'Tampa', zip: '33602' }));
  const co = engine.db.prepare('INSERT INTO job_change_orders (id, job_id, status, co_number, organization_id, data) VALUES (?,?,?,?,?,?)');
  co.run('co-a1', 'j-a1', 'approved', 'CO-1', AGX, JSON.stringify({ lines: [{ qty: 1, unitCost: 1000 }] }));
  co.run('co-a2', 'j-a1', 'draft', 'CO-2', AGX, JSON.stringify({ lines: [{ qty: 1, unitCost: 9000 }] }));
  // A row mis-stamped to org B on AGX's job: only the org clause keeps its $50,000 out.
  co.run('co-b1', 'j-a1', 'approved', 'CO-9', OTHER, JSON.stringify({ lines: [{ qty: 1, unitCost: 50000 }] }));
  const lead = engine.db.prepare('INSERT INTO leads (id, title, status, client_id, salesperson_id, organization_id, street_address, city, state, zip, estimated_revenue_low, estimated_revenue_high) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  lead.run('l-a1', 'Gazebo at Oak Hollow ' + BT_MARK, 'sent', 'c-a', 10, AGX, '12 Oak Hollow Dr', 'Tampa', 'FL', '33602', 10000, 12000);
  // AGX lead pointing at org B's user and client: the JOIN guards must blank them.
  lead.run('l-a2', 'Cross Tenant Probe', 'new', 'c-b2', 14, AGX, '9 Probe Rd', 'Tampa', 'FL', '33602', null, null);
  lead.run('l-b1', B + ' Open Lead', 'new', 'c-b', 12, OTHER, '', '', '', '', 99999, 99999);
  lead.run('l-null', 'Gazebo at Oak Hollow ' + BT_MARK, 'new', null, null, null, '12 Oak Hollow Dr', 'Tampa', 'FL', '33602', null, null);
}

function get(pathname, user) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathname, { method: 'GET', headers: user ? { Authorization: 'Bearer ' + signToken(user) } : {} }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* not json */ } resolve({ status: res.statusCode, text: buf, json }); });
    });
    req.on('error', reject);
    req.end();
  });
}

const PREVIEW = '/api/admin/organizations/me?view=buildertrend-preview';
const ADMIN = { id: 10, email: 'admin@agx.test', name: 'Ana Ruiz', role: 'admin' };
const AGX_ADMIN = Object.assign({}, ADMIN, { organization_id: AGX });

function snapshot(opts) {
  const skip = (opts && opts.skipColumns) || {};
  const out = {};
  for (const t of engine.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name)) {
    const rows = engine.db.prepare('SELECT * FROM "' + t + '" ORDER BY rowid').all();
    const drop = skip[t] || [];
    const clean = rows.map((r) => { const o = Object.assign({}, r); for (const c of drop) delete o[c]; return o; });
    out[t] = { n: rows.length, h: crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex') };
  }
  return out;
}

beforeAll(async () => {
  seed();
  setRolePool(engine.pool);
  await refreshRoleCache();
  const app = express();
  app.use('/api/admin/organizations', orgRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  global.fetch = clickrFetch;
});

afterAll(async () => {
  global.fetch = origFetch;
  await new Promise((resolve) => server.close(resolve));
  engine.close();
});

beforeEach(() => {
  fetchCalls = [];
  clickrMode = 'ok';
  leadsOverride = null;
  process.env.CLICKR_API_KEY = KEY;
  delete process.env.CLICKR_ORG_SLUG;
});

describe('HTTP — the preview over real-shape Clickr pages', () => {
  test('the owning org\'s admin gets both datasets classified, complete, with money held back from the real SQL', async () => {
    const r = await get(PREVIEW, AGX_ADMIN);
    expect(r.status).toBe(200);
    const jobs = r.json.datasets.jobs;
    expect(jobs.fetch).toMatchObject({ fetched: 6, reportedCount: 6, complete: true, mode: 'skip/limit' });
    expect(jobs.sentence).toMatch(/^Fetched 6 of 6 jobs/);
    const s1050 = jobs.rows.find((x) => x.bt.number === 'S1050');
    expect(s1050.class).toBe('conflict');
    expect(s1050.corrections.map((c) => [c.field, c.to])).toEqual([['city', 'Tamp'], ['contractPrice', '$15,000.00']]);
    // Contract from data.contractAmount; approved COs = the $1,000 approved row only
    // (not the $9,000 draft, not org B's mis-stamped $50,000).
    expect(s1050.heldBack.map((h) => [h.field, h.p86, h.bt])).toEqual([['approvedCOPrice', '$1,000.00', '$2,500.00']]);
    expect(jobs.rows.filter((x) => x.bt.number === 'WO16').every((x) => x.class === 'new')).toBe(true);
    expect(jobs.summary.counts).toMatchObject({ not_a_job: 1, change_order: 1 });
    expect(r.json.p86).toMatchObject({ jobs: 3, leads: 2, unscopedJobs: 1, unscopedLeads: 1 });
    expect(jobs.notInBuildertrend).toMatchObject({ reliable: true });
    expect(jobs.notInBuildertrend.rows.map((x) => x.id)).toEqual(['j-a2']);
    expect(jobs.notInBuildertrend.notListed).toBe(1);
    expect(r.json.readOnly).toBe(true);
  });

  test('a P86 lead whose Buildertrend lead is no longer open is marked in "not in Buildertrend", and nothing is proposed for it', async () => {
    // Buildertrend serves the Gazebo lead only: "Cross Tenant Probe" has left its
    // open list, and l-a2 still carries that Buildertrend lead's id.
    leadsOverride = [HTTP_LEADS[0]];
    engine.db.prepare('UPDATE leads SET bt_lead_id = ? WHERE id = ?').run('bt-gone-1', 'l-a2');
    try {
      const r = await get(PREVIEW, AGX_ADMIN);
      expect(r.json.datasets.leads.fetch.complete).toBe(true);
      const nib = r.json.datasets.leads.notInBuildertrend;
      expect(nib.rows.find((p) => p.id === 'l-a2')).toMatchObject({ linkedGone: true });
      expect(nib.sentence).toMatch(/Buildertrend sold, lost or closed it, so it left that open list. Nothing is proposed for it./);
      // No Buildertrend row reached it, so nothing anywhere proposes anything for it.
      expect(JSON.stringify(r.json.datasets.leads.rows)).not.toContain('l-a2');
    } finally {
      engine.db.prepare('UPDATE leads SET bt_lead_id = NULL WHERE id = ?').run('l-a2');
    }
  });

  test('after a PARTIAL leads read the sentence says NO lead is marked, because none is', async () => {
    // The mark is gated on a complete read. If the sentence still described the
    // convention, an unmarked lead carrying a Buildertrend id would read as "still
    // open in Buildertrend" — the one conclusion a partial read cannot support.
    clickrMode = 'malformed-next-leads';
    engine.db.prepare('UPDATE leads SET bt_lead_id = ? WHERE id = ?').run('bt-gone-1', 'l-a2');
    try {
      const r = await get(PREVIEW, AGX_ADMIN);
      const leads = r.json.datasets.leads;
      expect(leads.fetch.complete).toBe(false);
      const nib = leads.notInBuildertrend;
      // Nothing is marked...
      expect(nib.rows.every((p) => p.linkedGone === undefined)).toBe(true);
      // ...and the sentence says so, instead of the complete-read convention.
      expect(nib.sentence).toMatch(/No lead is marked as having left that open list/);
      expect(nib.sentence).not.toMatch(/Buildertrend sold, lost or closed it/);
      expect(nib.sentence).toMatch(/NOT RELIABLE/);
    } finally {
      engine.db.prepare('UPDATE leads SET bt_lead_id = NULL WHERE id = ?').run('l-a2');
    }
  });

  test('the legacy per-job CO list is summed exactly as the WIP rollup sums it', async () => {
    const { rows } = await engine.pool.query("SELECT id, data->'changeOrders' AS legacy_cos FROM jobs WHERE id = 'j-a3'");
    const totals = preview.changeOrderTotals(rows, []);
    expect(totals.get('j-a3')).toMatchObject({ computable: true, total: 500, count: 2 });
  });

  test('without the view parameter /me answers exactly what it did before, and Clickr is never called', async () => {
    const r = await get('/api/admin/organizations/me', AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(['organization']);
    expect(fetchCalls).toHaveLength(0);
  });

  test('a Clickr 401 is a sentence in a 200, never OUR 401', async () => {
    clickrMode = 'unauthorized-echo';
    const r = await get(PREVIEW, AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(r.json.datasets.jobs.error.kind).toBe('unauthorized');
    expect(r.json.datasets.jobs.notInBuildertrend).toBeNull();
  });

  test('a malformed next link on Jobs is a per-dataset PARTIAL read (not a 500); Leads is unaffected; not-in-BT is NOT RELIABLE', async () => {
    clickrMode = 'malformed-next-jobs';
    const r = await get(PREVIEW, AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(r.json.datasets.jobs.fetch.complete).toBe(false);
    expect(r.json.datasets.jobs.sentence).toMatch(/^PARTIAL READ: fetched 6 of 9 jobs\. Clickr's next-page link/);
    expect(r.json.datasets.jobs.notInBuildertrend.reliable).toBe(false);
    expect(r.json.datasets.jobs.notInBuildertrend.sentence).toMatch(/NOT RELIABLE/);
    expect(r.json.datasets.leads.fetch.complete).toBe(true);
  });

  test('the transport is called with an abort signal and redirect:error', async () => {
    await get(PREVIEW, AGX_ADMIN);
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls.every((c) => c.signal && c.redirect === 'error')).toBe(true);
  });

  test('required key missing on the Leads dataset: refused with the sentence, nothing classified', async () => {
    leadsOverride = HTTP_LEADS.map((l) => { const o = Object.assign({}, l, { title: l.opportunityTitle }); delete o.opportunityTitle; return o; });
    const r = await get(PREVIEW, AGX_ADMIN);
    const leads = r.json.datasets.leads;
    expect(leads.classified).toBe(false);
    expect(leads.error).toMatchObject({ kind: 'mapping' });
    expect(leads.error.message).toMatch(/Only 0 of 2 leads records carry a usable "opportunityTitle"/);
    expect(leads.rows).toEqual([]);
  });

  test('missing key: a sentence per dataset, no request leaves the server', async () => {
    delete process.env.CLICKR_API_KEY;
    const r = await get(PREVIEW, AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(fetchCalls).toHaveLength(0);
    expect(r.json.datasets.jobs.error.message).toMatch(/CLICKR_API_KEY is not set/);
  });
});

describe('HTTP — TENANCY: every read clause, executed', () => {
  test('VARY ONLY THE ORG: the same admin is served in the owning org and refused in another, before Clickr is called', async () => {
    const { a, b } = await proveOrgOnly({
      caller: ADMIN, orgA: AGX, orgB: OTHER,
      run: async (caller) => { fetchCalls = []; const r = await get(PREVIEW, caller); r.fetches = fetchCalls.length; return r; },
    });
    expect(a.status).toBe(200);
    expect(a.text).toContain(BT_MARK);
    expect(b.status).toBe(403);
    expect(b.json.code).toBe('CLICKR_NOT_THIS_ORG');
    expect(b.text).not.toContain(BT_MARK);
    expect(b.fetches).toBe(0);
  });

  test('VARY ONLY THE CAPABILITY: a PM of the owning org is refused', async () => {
    const pm = Object.assign({}, AGX_ADMIN, { role: 'pm' });
    const rp = await get(PREVIEW, pm);
    expect(rp.status).toBe(403);
    expect(rp.text).not.toContain(BT_MARK);
  });

  test('SYSTEM_ADMIN buys nothing in another org', async () => {
    const r = await get(PREVIEW, { id: 12, email: 'owner@p86.test', name: 'Platform Owner', role: 'system_admin', organization_id: OTHER });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain(BT_MARK);
  });

  test('CLICKR_ORG_SLUG names the owning org', async () => {
    process.env.CLICKR_ORG_SLUG = 'other';
    expect((await get(PREVIEW, AGX_ADMIN)).status).toBe(403);
    expect((await get(PREVIEW, Object.assign({}, ADMIN, { organization_id: OTHER }))).status).toBe(200);
  });

  test('unauthenticated: 401 from the host route, nothing fetched', async () => {
    expect((await get(PREVIEW, null)).status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  describe('the P86 reads are AGX\'s rows only', () => {
    let body;
    let text;
    beforeAll(async () => {
      process.env.CLICKR_API_KEY = KEY;
      const r = await get(PREVIEW, AGX_ADMIN);
      body = r.json;
      text = r.text;
    });

    test('jobs WHERE: org B\'s same-title, same-street job is not a candidate, and org B\'s active job is not "not in Buildertrend"', () => {
      const probe = body.datasets.jobs.rows.find((x) => x.bt.number === 'S5555');
      expect(probe.class).toBe('new');
      expect(probe.candidates).toEqual([]);
      expect(body.datasets.jobs.notInBuildertrend.rows.map((x) => x.id)).not.toContain('j-b2');
    });

    test('jobs NULL-org rows are counted, never matched', () => {
      expect(body.p86.unscopedJobs).toBe(1);
      expect(text).not.toContain('j-null');
    });

    test('leads WHERE: org B\'s lead is not "not in Buildertrend", and the NULL-org twin of the Gazebo lead does not make it ambiguous', () => {
      expect(body.datasets.leads.notInBuildertrend.rows.map((x) => x.id)).not.toContain('l-b1');
      const gaz = body.datasets.leads.rows.find((x) => x.bt.raw.startsWith('Gazebo'));
      expect(gaz.class).toBe('matched');
      expect(gaz.p86.id).toBe('l-a1');
    });

    test('users JOIN and clients JOIN: an AGX lead pointing at org B\'s user and client reads them as BLANK', () => {
      const probe = body.datasets.leads.rows.find((x) => x.bt.raw === 'Cross Tenant Probe');
      expect(probe.p86.client).toBe('');
      expect(text).not.toContain(B + ' Joined Client');
    });

    test('users directory: a BT salesperson who is only a user in org B is not proposed; an INACTIVE AGX user is not counted', () => {
      const probe = body.datasets.leads.rows.find((x) => x.bt.raw === 'Cross Tenant Probe');
      expect(probe.corrections.some((c) => c.field === 'salesperson')).toBe(false);
      expect(probe.notes.join(' ')).toMatch(/no active P86 user in this organization has that name/);
      const gaz = body.datasets.leads.rows.find((x) => x.bt.raw.startsWith('Gazebo'));
      // Ana Ruiz is active in AGX once (id 10) and inactive once (id 15): same person as P86 has, nothing to say.
      expect(gaz.notes.join(' ')).not.toMatch(/users have that name/);
    });

    test('clients directory: a BT contact that is only a client in org B is not proposed', () => {
      const probe = body.datasets.leads.rows.find((x) => x.bt.raw === 'Cross Tenant Probe');
      expect(probe.corrections.some((c) => c.field === 'client')).toBe(false);
      expect(probe.notes.join(' ')).toMatch(/no P86 client in this organization has that name/);
    });

    test('change orders: org B\'s mis-stamped $50,000 CO on AGX\'s job is not in the P86 figure', () => {
      const s1050 = body.datasets.jobs.rows.find((x) => x.bt.number === 'S1050');
      expect(s1050.heldBack.find((h) => h.field === 'approvedCOPrice').p86).toBe('$1,000.00');
    });

    test('no org-B P86 row reaches the body at all (the org-B marker appears only where Buildertrend itself sent it)', () => {
      for (const s of [B + ' Joined Client', B + ' Active Job', B + ' Open Lead', B + ' Builders', 'j-b1', 'j-b2', 'l-b1', 'co-b1']) expect(text).not.toContain(s);
    });
  });

  test('users directory, the inactive guard: the only AGX user with a BT salesperson name is inactive — nothing proposed', async () => {
    engine.db.exec("INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES (16, 'old@agx.test', 'x', 'Retired Seller', 'pm', 1, 0)");
    leadsOverride = [HTTP_LEADS[0], leadRec('Cross Tenant Probe', { street: '9 Probe Rd', salesperson: 'Retired Seller', contactName: '' })];
    const r = await get(PREVIEW, AGX_ADMIN);
    const probe = r.json.datasets.leads.rows.find((x) => x.bt.raw === 'Cross Tenant Probe');
    expect(probe.corrections.some((c) => c.field === 'salesperson')).toBe(false);
    engine.db.exec('DELETE FROM users WHERE id = 16');
  });

  test('converted leads, BOTH link fields: AGX\'s job naming the lead blocks the client proposal; ANOTHER tenant\'s job naming it does not', async () => {
    engine.db.exec(`
      INSERT INTO leads (id, title, status, organization_id, street_address, city, state, zip) VALUES
        ('l-a3', 'Converted Via Job Link', 'new', 1, '31 Link St', 'Tampa', 'FL', '33602'),
        ('l-a4', 'Linked By Other Tenant', 'new', 1, '32 Link St', 'Tampa', 'FL', '33602');
      INSERT INTO jobs (id, owner_id, organization_id, lead_id, data) VALUES
        ('j-a9', 10, 1, 'l-a3', '{"jobNumber":"S0909","title":"Link Job","status":"Completed"}'),
        ('j-b9', 12, 2, 'l-a4', '{"jobNumber":"S0910","title":"Other Link Job","status":"Completed"}');
    `);
    try {
      leadsOverride = [
        leadRec('Converted Via Job Link', { street: '31 Link St', contactName: 'Oak Hollow HOA', salesperson: '' }),
        leadRec('Linked By Other Tenant', { street: '32 Link St', contactName: 'Oak Hollow HOA', salesperson: '' }),
      ];
      const r = await get(PREVIEW, AGX_ADMIN);
      const rows = r.json.datasets.leads.rows;
      const linked = rows.find((x) => x.bt.raw === 'Converted Via Job Link');
      const foreign = rows.find((x) => x.bt.raw === 'Linked By Other Tenant');
      expect(linked.class).toBe('matched');
      expect(linked.corrections.some((c) => c.field === 'client')).toBe(false);
      expect(linked.notes.join(' ')).toMatch(/already converted to a job/);
      // Control: the same shape with no AGX link IS proposed — so the block above is the link, not something else.
      expect(foreign.corrections.find((c) => c.field === 'client')).toMatchObject({ kind: 'fill', to: 'Oak Hollow HOA', toP86: 'client c-a' });
    } finally {
      engine.db.exec("DELETE FROM jobs WHERE id IN ('j-a9', 'j-b9'); DELETE FROM leads WHERE id IN ('l-a3', 'l-a4');");
    }
  });
});

describe('HTTP — the key never leaves the server', () => {
  const captured = [];
  let spies = [];
  beforeEach(() => {
    captured.length = 0;
    spies = ['log', 'warn', 'error', 'info', 'debug'].map((m) =>
      jest.spyOn(console, m).mockImplementation((...args) => { captured.push(args.map((x) => (x && x.stack) || String(x)).join(' ')); }));
  });
  afterEach(() => { spies.forEach((s) => s.mockRestore()); });

  test.each([
    ['success', 'ok'],
    ['an upstream 401 that echoes the key back', 'unauthorized-echo'],
    ['a transport error whose message contains the key', 'throw-with-key'],
  ])('%s: not in the body (any case, any 8-char prefix or suffix), not in any log line', async (_label, mode) => {
    clickrMode = mode;
    const r = await get(PREVIEW, AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(fetchCalls.every((c) => c.auth === 'Bearer ' + KEY)).toBe(true);
    const low = r.text.toLowerCase();
    expect(low).not.toContain(KEY.slice(0, 8).toLowerCase());
    expect(low).not.toContain(KEY.slice(-8).toLowerCase());
    expect(captured.join('\n').toLowerCase()).not.toContain(KEY.slice(-8).toLowerCase());
  });

  test.each([
    ['the whole key in a record value', () => KEY],
    ['the key upper-cased', () => KEY.toUpperCase()],
    ['only its last 8 characters', () => 'x' + KEY.slice(-8)],
    ['only its first 8 characters, inside the job name', () => null],
  ])('last line of defence — %s: the response is withheld with a fixed sentence', async (_label, val) => {
    const saved = global.fetch;
    global.fetch = (url, opts) => {
      fetchCalls.push({ url: String(url), auth: opts.headers.Authorization });
      const rec = jobRec('S1 Leak Probe');
      const v = val();
      if (v == null) rec.jobStatus = 'Open'; else rec.city = v;
      const body = envelope([rec], 1);
      if (v == null) { rec.jobName = 'S1 Leak Probe'; body.records = [Object.assign({}, rec)]; }
      return Promise.resolve({ status: 200, text: async () => {
        const t = JSON.stringify(body);
        return v == null ? t.replace('"S1 Leak Probe"', JSON.stringify('S1 ' + KEY.slice(0, 8))) : t;
      } });
    };
    try {
      const r = await get(PREVIEW, AGX_ADMIN);
      expect(r.status).toBe(500);
      expect(r.json.error).toBe('The Buildertrend preview was withheld because the response contained the Clickr API key.');
      expect(r.text.toLowerCase()).not.toContain(KEY.slice(0, 8).toLowerCase());
      expect(captured.join('\n').toLowerCase()).not.toContain(KEY.slice(0, 8).toLowerCase());
    } finally {
      global.fetch = saved;
    }
  });

  test('carriesKey checks object keys as well as values', () => {
    // 11 middle characters are below the 12-character window; 12 are caught.
    expect(preview.carriesKey({ a: { [KEY.slice(3, 14)]: 1 } }, KEY)).toBe(false);
    expect(preview.carriesKey({ a: { [KEY.slice(3, 15)]: 1 } }, KEY)).toBe(true);
    expect(preview.carriesKey({ a: { ['zz' + KEY.slice(0, 8)]: 1 } }, KEY)).toBe(true);
    expect(preview.carriesKey({ a: ['ok', 'y' + KEY.slice(-8).toUpperCase()] }, KEY)).toBe(true);
  });

  test('an exception inside the preview is a FIXED 500 sentence: its message (carrying the key) reaches neither the body nor a log line', async () => {
    const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
    const req = { organization: { id: AGX, slug: 'agx', name: 'AGX Central Florida' } };
    await preview.handle(req, res, { env: { CLICKR_API_KEY: KEY }, pool: engine.pool,
      now: () => { throw new Error('internal detail ZZEXCEPTIONTEXT ' + KEY); } });
    expect(res.code).toBe(500);
    expect(res.body).toEqual({ error: 'The Buildertrend preview failed inside this server.' });
    const all = (JSON.stringify(res.body) + '\n' + captured.join('\n')).toLowerCase();
    expect(all).not.toContain('zzexceptiontext');
    expect(all).not.toContain(KEY.slice(-8).toLowerCase());
    expect(captured.join('\n')).toContain('[clickr-preview] preview failed');
  });
});

// The preview's ONE write is its own memory of Buildertrend (services/clickr/
// since-refresh.js): bt_record_snapshots and the admin's bt_preview_views row.
// Every other table — every Project 86 record — is proved untouched, and every
// statement that is not a SELECT is one of those writes, for this organization.
describe('HTTP — it writes NOTHING to Project 86, proved on every table', () => {
  test('every other table identical before and after; every write is the preview\'s own memory, for this organization', async () => {
    await get('/api/admin/organizations/me', AGX_ADMIN);   // absorb requireAuth's last_seen_at bump
    const MEMORY = ['bt_record_snapshots', 'bt_preview_views'];
    const before = snapshot();
    expect(Object.keys(before).length).toBe(ALL_TABLES.length);
    const logStart = engine.log.length;
    const r = await get(PREVIEW, AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(r.json.datasets.jobs.summary.correctedFields).toBeGreaterThan(0);
    expect(r.json.datasets.leads.classified).toBe(true);
    const after = snapshot();
    for (const t of MEMORY) { delete before[t]; delete after[t]; }
    expect(after).toEqual(before);
    const stmts = engine.log.slice(logStart);
    expect(stmts.length).toBeGreaterThan(0);
    expect(stmts.filter((s) => !s.ok)).toEqual([]);
    const writes = stmts.filter((s) => !/^\s*SELECT\b/i.test(s.sql));
    // Jobs and leads read completely here, so both are remembered (inserted, or
    // touched when an earlier test already remembered them) and the marker moves.
    expect(writes.some((s) => /^(INSERT INTO|UPDATE) bt_record_snapshots\b/.test(s.sql))).toBe(true);
    expect(writes.some((s) => /^INSERT INTO bt_preview_views\b/.test(s.sql))).toBe(true);
    for (const w of writes) {
      if (/^(BEGIN|COMMIT)$/.test(w.sql)) continue;
      if (/^INSERT INTO (bt_record_snapshots|bt_preview_views) \(organization_id,/.test(w.sql)) { expect(w.params[0]).toBe(AGX); continue; }
      if (/^UPDATE bt_record_snapshots SET last_seen_at = \$1::timestamptz WHERE organization_id = \$2 AND dataset = \$3 /.test(w.sql)) { expect(w.params[1]).toBe(AGX); continue; }
      throw new Error('unexpected write: ' + w.sql);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE PAGE — escaping and the failure sentence, executed on the real file
// ══════════════════════════════════════════════════════════════════════════

describe('PAGE — js/bt-sync-preview.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8');
  const win = {};
  vm.runInNewContext(src, { window: win, document: {}, console });
  const T = win.p86BtSyncPreview._test;
  const XSS = '<img src=x onerror="alert(1)">\'&';

  test('esc() escapes every HTML-significant character', () => {
    expect(T.esc(XSS)).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;');
    expect(T.esc(null)).toBe('');
  });

  test('errorSentence: foreign org, non-admin, server sentence, bare status, network', () => {
    expect(T.errorSentence({ status: 403, data: { code: 'CLICKR_NOT_THIS_ORG', error: 'not this org' } })).toBe('not this org');
    expect(T.errorSentence({ status: 403, data: { error: 'Forbidden' } })).toMatch(/^Only an administrator/);
    expect(T.errorSentence({ status: 500, data: { error: 'The Buildertrend preview failed inside this server.' } })).toBe('The Buildertrend preview failed inside this server.');
    expect(T.errorSentence({ status: 502 })).toBe('The Buildertrend preview request failed (HTTP 502).');
    expect(T.errorSentence(new Error('Failed to fetch'))).toBe('The Buildertrend preview request did not complete: Failed to fetch');
  });

  test('a failure sentence carrying markup is rendered as text', () => {
    const html = T.render(null, T.errorSentence({ status: 500, data: { error: XSS } }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x');
  });

  test('a synthetic response with markup in EVERY rendered string: candidates, not-in-BT, held back, blanks, flags, notes, sentences, mapping keys', () => {
    T.setTab('jobs');
    const x = XSS;
    const cand = { id: x, jobNumber: x, title: x, status: x, street: x, city: x, state: x, zip: x, rungs: [x] };
    const row = (cls, extra) => Object.assign({ bt: { raw: x, status: x, street: x, city: x, state: x, zip: x, projectedStart: x, contractText: x, scope: 'open', coLabel: x, contactName: x, salesperson: x },
      class: cls, rung: x, p86: cand, candidates: [cand], corrections: [{ field: x, label: x, from: x, to: x, toP86: x, note: x, typo: x, kind: 'value' }],
      btBlank: [{ field: x, label: x, p86: x }], heldBack: [{ field: x, label: x, p86: x, bt: x, reason: x, note: x }], flags: [{ text: x }], notes: [x] }, extra || {});
    const ds = (key) => ({ key, label: x, datasetId: x, fetch: { fetched: 1, reportedCount: 1, complete: false, mode: x, pages: x, reason: x, elapsedMs: x },
      error: null, sentence: x, classified: true,
      mapping: { fields: [{ key: x, carriedBy: x, nonEmpty: x, required: true }], missingKeys: [x], unexpectedKeys: [{ key: x, carriedBy: x }] },
      rows: [row('conflict'), row('ambiguous', { p86: null }), row('possible_duplicate', { p86: null }), row('change_order', { parent: { btRaw: x, class: x, p86: cand, p86ChangeOrders: x } })],
      notInBuildertrend: { reliable: false, count: 1, sentence: x, rows: [cand] } });
    const data = { generatedAt: new Date().toISOString(), elapsedMs: x, organization: { name: x }, p86: { jobs: x, leads: x, unscopedJobs: x, unscopedLeads: x, error: x },
      datasets: { jobs: ds('jobs'), leads: ds('leads') } };
    const html = T.render(data, x);
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toMatch(/<img/i);
  });

  test('every server string in a real preview response is escaped when rendered', async () => {
    T.setTab('jobs');
    const saved = global.fetch;
    const evilJobs = [jobRec('S1050 ' + XSS, { street: '1 Harbor Dr', city: XSS }), jobRec(XSS), jobRec('WO16 ' + XSS), jobRec('WO16 b')];
    global.fetch = (url) => {
      const u = new URL(url);
      const recs = u.pathname.includes(DATASETS.jobs.datasetId) ? evilJobs : [leadRec(XSS, { contactName: XSS, salesperson: XSS })];
      return Promise.resolve({ status: 200, text: async () => JSON.stringify(envelope(Number(u.searchParams.get('skip')) ? [] : recs, recs.length)) });
    };
    try {
      const r = await get(PREVIEW, AGX_ADMIN);
      expect(r.status).toBe(200);
      const html = T.render(r.json, null);
      expect(html).toContain('&lt;img src=x');
      expect(html).not.toMatch(/<img/i);
      expect(html).not.toMatch(/onerror="/);
    } finally {
      global.fetch = saved;
    }
  });

  // ── J1. The default scope is "Open + Warranty"; closing a job is the
  // commonest Buildertrend status change there is, and it moves the row out of
  // that scope. A confident row carrying anything about STATUS stays in view.
  const jobRow = (n, scope, cls, extra) => Object.assign({
    bt: { index: n, btId: String(n), raw: 'ROW' + n, status: scope === 'closed' ? 'Closed' : 'Open', scope: scope,
      street: '', city: '', state: '', zip: '', projectedStart: '', contractText: '' },
    class: cls, rung: 'number',
    p86: { id: 'p' + n, jobNumber: 'S' + n, title: 'Job ' + n, status: 'In Progress', street: '', city: '', state: '', zip: '' },
    corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [],
  }, extra || {});
  const JOB_ROWS = [
    // Closed in Buildertrend, still active in P86: the correction that must be seen.
    jobRow(1, 'closed', 'conflict', { corrections: [{ field: 'status', label: 'Status', kind: 'value', from: 'In Progress', to: 'Closed', toP86: 'Completed' }] }),
    // Closed in Buildertrend and agreed in P86: nothing about status, so out of scope.
    jobRow(2, 'closed', 'matched'),
    // Closed, with a status item held back.
    jobRow(3, 'closed', 'matched', { heldBack: [{ field: 'status', label: 'Status', bt: 'Closed', p86: 'In Progress', applicable: false, note: 'held' }] }),
    // Closed, with a status FLAG.
    jobRow(4, 'closed', 'matched', { flags: [{ field: 'status', label: 'Status', text: 'not mapped' }] }),
    // Closed and AMBIGUOUS. Nothing is proposed for it, so nothing pulls it into
    // scope — not even a status item a future server leaves on the row.
    jobRow(5, 'closed', 'ambiguous', { p86: null, candidates: [], flags: [{ field: 'status', label: 'Status', text: 'left over' }] }),
    jobRow(6, 'open', 'matched'),
    // Warranty: in scope already, and P86 has no such word.
    jobRow(7, 'open', 'matched'),
  ];
  JOB_ROWS[6].bt.status = 'Warranty';
  JOB_ROWS[6].flags = [{ field: 'status', label: 'Status', text: 'Buildertrend says Warranty' }];
  const jobsDs = () => ({ key: 'jobs', label: 'Jobs', datasetId: 'd-jobs',
    fetch: { fetched: 7, reportedCount: 7, pages: 1, mode: 'skip/limit', complete: true, reason: null, elapsedMs: 1 },
    error: null, sentence: 'Fetched 7 of 7 jobs in 1 page — every record Clickr reported.', classified: true, mapping: null,
    rows: JOB_ROWS.map((r) => JSON.parse(JSON.stringify(r))),
    notInBuildertrend: { reliable: true, count: 0, notListed: 0, sentence: 'none', rows: [] } });
  const pageWith = (datasets) => ({ generatedAt: new Date().toISOString(), elapsedMs: 1, organization: { name: 'AGX' },
    p86: { jobs: 7, leads: 0, clients: 0, unscopedJobs: 0, unscopedLeads: 0, error: null },
    datasets: Object.assign({ jobs: { key: 'jobs', rows: [], classified: false, fetch: {} }, leads: { key: 'leads', rows: [], classified: false, fetch: {} } }, datasets) });

  test('a closed Buildertrend job carrying a status correction, held-back item or flag is in scope under “Open + Warranty”', () => {
    const data = pageWith({ jobs: jobsDs() });
    T.setTab('jobs');
    T.setView('jobs', 'all', 'open');
    const html = T.render(data);
    for (const n of [1, 3, 4, 6, 7]) expect(html).toContain('ROW' + n);
    // Closed with nothing to say about status, and a closed ambiguous row: hidden.
    expect(html).not.toContain('ROW2');
    expect(html).not.toContain('ROW5');
    expect(html).toContain('>5 shown</span>');
    // The scope sub-text says why a closed job is here at all.
    expect(html).toContain('Closed Buildertrend jobs appear here when their P86 status no longer matches.');

    // The tiles and the filters count exactly the rows the same rule shows.
    T.setView('jobs', 'matched', 'open');
    expect(T.render(data)).toContain('>4 shown</span>');
    T.setView('jobs', 'conflict', 'open');
    expect(T.render(data)).toContain('>1 shown</span>');
    T.setView('jobs', 'ambiguous', 'open');
    expect(T.render(data)).toContain('>0 shown</span>');

    // “All jobs” still shows every row.
    T.setView('jobs', 'all', 'all');
    const all = T.render(data);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(all).toContain('ROW' + n);
    expect(all).toContain('>7 shown</span>');
    T.setView('jobs', 'all', 'open');
  });

  // ── J2/C2. A linked job whose Buildertrend word has MOVED carries no
  // correction — P86 has no Warranty and no Pending — so its row shows a bare
  // "Linked" tag with nothing to press. The safe press is the thing that records
  // the word, so it has to stay live for exactly these rows; otherwise a fully
  // linked dataset never learns another Buildertrend word again.
  const linkedJob = (n, due) => Object.assign(jobRow(n, 'open', 'matched'), { rung: 'Buildertrend ID', btStatusDue: due });

  test('a linked job whose Buildertrend word has moved keeps the safe press live, and the button says what it records', () => {
    const rows = [linkedJob(11, true), linkedJob(12, false)];
    rows[0].bt.status = 'Warranty';
    rows[0].flags = [{ field: 'status', label: 'Status', text: 'Buildertrend says Warranty' }];
    const ds = Object.assign(jobsDs(), { rows });
    T.setTab('jobs');
    T.setView('jobs', 'all', 'all');
    const html = T.render(pageWith({ jobs: ds }));

    // The row offers nothing of its own: there is no correction to tick.
    expect(html).toContain('<span class="btp-tag is-linked">Linked</span>');
    expect(html).not.toContain('data-btp-apply="11"');
    // The safe press reaches it, counts it, and names what it will record.
    expect(html).toMatch(/data-btp-apply-safe="1">Link confident matches \+ fill blank start dates \(1\)</);
    expect(html).toContain('Records what Buildertrend now calls 1 job, beside the P86 status, which does not change.');
    expect(T.safeConfirmText('jobs', ds)).toContain('Records what Buildertrend now calls 1 job');

    // Once every word is recorded there is nothing left to press.
    const done = Object.assign(jobsDs(), { rows: [linkedJob(11, false), linkedJob(12, false)] });
    expect(T.render(pageWith({ jobs: done })))
      .toMatch(/data-btp-apply-safe="1" disabled>Link confident matches \+ fill blank start dates \(0\)</);
    expect(T.safeConfirmText('jobs', done)).toBe('Nothing is left to link. Start dates are filled only where P86 has none. No P86 status, money or other field changes.');
  });

  test('the safe button owns up to covering Buildertrend jobs the scope hides', () => {
    // The scope buttons filter the LIST; the press covers the whole read. The
    // count and the list therefore disagree on purpose, so the sub-text says so
    // — the way the create button says closed jobs are created one at a time.
    T.setTab('jobs');
    T.setView('jobs', 'all', 'open');
    const html = T.render(pageWith({ jobs: jobsDs() }));
    expect(html).toContain('>5 shown</span>');
    expect(html).toMatch(/data-btp-apply-safe="1">Link confident matches \+ fill blank start dates \(6\)</);
    expect(html).toContain('Every confident match counts here, including Buildertrend jobs the scope above hides.');
  });

  // ── J2. P86 has no Warranty and no Closed, so the row says Buildertrend's
  // own word — the same word an apply saves on the job (data.btStatus).
  test('the P86 side of a job row names Buildertrend’s own status', () => {
    const data = pageWith({ jobs: jobsDs() });
    T.setTab('jobs');
    T.setView('jobs', 'all', 'all');
    const html = T.render(data);
    expect(html).toContain('Buildertrend: Warranty');
    expect(html).toContain('Buildertrend: Closed');
    T.setView('jobs', 'all', 'open');
  });

  // ── L1. The wording is the lead's own, not the change orders'.
  test('a P86 lead whose Buildertrend lead left the open list says what that means, and offers nothing', () => {
    const leads = { key: 'leads', label: 'Leads', datasetId: 'd-leads',
      fetch: { fetched: 1, reportedCount: 1, pages: 1, mode: 'skip/limit', complete: true, reason: null, elapsedMs: 1 },
      error: null, sentence: 'ok', classified: true, mapping: null, rows: [],
      notInBuildertrend: { reliable: true, count: 1, notListed: 0, sentence: 'review only',
        rows: [{ id: 'l-9', title: 'Sold Elsewhere', status: 'sent', state86: 'open', client: 'HOA', street: '', city: '', state: '', zip: '', linkedGone: true }] } };
    T.setTab('leads');
    T.setView('leads', 'notinbt');
    const html = T.render(pageWith({ leads: leads }));
    expect(html).toContain('no longer an open lead in Buildertrend (sold, lost or closed there)');
    expect(html).not.toContain('linked to a Buildertrend change order');
    // Nothing is proposed: no status, no archive.
    expect(html).not.toContain('data-btp-archive=');
    expect(html).toContain('not archived: Buildertrend sends open leads only');
    T.setView('leads', 'all');
    T.setTab('jobs');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE OVERVIEW TAB — the dependency chain, the money, the health, and the one
// invariant that stops the page lying: every count it prints is the length of
// the list its own button lands on. Executed on the real file, no DOM.
// ══════════════════════════════════════════════════════════════════════════

describe('OVERVIEW — js/bt-sync-preview.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8');
  // Its own window, so nothing here depends on the tab or filter another
  // describe left behind.
  const win = {};
  vm.runInNewContext(src, { window: win, document: {}, console });
  const T = win.p86BtSyncPreview._test;

  // Every dataset the server returns — the page flags one it expected and did
  // not receive, so a fixture short of PREVIEW_KINDS reads as a failed dataset.
  const KEYS = ['jobs', 'leads', 'clients', 'changeOrders', 'purchaseOrders', 'bills', 'estimates', 'tasks'];
  const LABELS = { jobs: 'Jobs', leads: 'Leads', clients: 'Clients', changeOrders: 'Change orders',
    purchaseOrders: 'Purchase orders', bills: 'Bills', estimates: 'Estimates', tasks: 'Tasks' };

  const mapping = (o) => Object.assign({ recordCount: 1, requiredKey: 'k', requiredNonEmpty: 1, requiredUsable: 1,
    requiredOk: true, refusal: null, fields: [{ key: 'k', carriedBy: 1, nonEmpty: 1, required: true }],
    missingKeys: [], unexpectedKeys: [] }, o || {});

  const ds = (key, o) => Object.assign({
    key, label: LABELS[key], datasetId: 'd-' + key,
    fetch: { fetched: 1, reportedCount: 1, pages: 1, mode: 'skip/limit', complete: true, reason: null, elapsedMs: 7 },
    error: null, sentence: 'Fetched 1 of 1 — every record Clickr reported.', classified: true,
    mapping: mapping(), summary: null, summaryOpen: null, rows: [],
    notInBuildertrend: { reliable: true, count: 0, notListed: 0, sentence: 'none', rows: [] },
  }, o || {});

  const page = (over) => ({
    readOnly: true, generatedAt: '2026-09-20T12:00:00.000Z', elapsedMs: 9100,
    organization: { id: 1, slug: 'agx', name: 'AGX Central Florida' },
    p86: { jobs: 3, leads: 1, clients: 1, unscopedJobs: 0, unscopedLeads: 0, error: null },
    datasets: KEYS.reduce((acc, k) => { acc[k] = (over && over[k]) || ds(k, { fetch: { fetched: 0, reportedCount: 0, pages: 1, mode: 'skip/limit', complete: true, reason: null, elapsedMs: 1 } }); return acc; }, {}),
  });

  // A row of a job-scoped dataset that is refused ONLY because its Buildertrend
  // job is not a linked P86 job — the real shape co/po/bill/estimate-match emit.
  const waiting = (n, jobId, jobName) => ({
    bt: { index: n, btId: 'w' + n, raw: 'WAIT' + n, jobId, jobName, scope: 'open',
      statusText: 'Approved', priceText: '$0.00', costText: '$0.00', amountText: '$0.00',
      paidText: '$0.00', remainingText: '$0.00', ownerText: '$0.00', contractText: '$0.00', lineCount: 1 },
    class: 'refused', rung: null, p86: null, waitingOnJob: true,
    corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [
      'Its Buildertrend job "' + jobName + '" is not linked to a P86 job yet. Link or create the job on the Jobs tab, then refresh.'],
  });

  const jobRow = (btId, raw, cls, extra) => Object.assign({
    bt: { index: 0, btId: String(btId), raw, status: 'Open', scope: 'open', street: '', city: '', state: '', zip: '',
      projectedStart: '', contractText: '$0.00' },
    class: cls, rung: cls === 'matched' || cls === 'conflict' ? 'number' : null,
    p86: cls === 'matched' || cls === 'conflict' ? { id: 'p' + btId, jobNumber: 'S' + btId, title: raw, status: 'In Progress', street: '', city: '', state: '', zip: '' } : null,
    corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [],
  }, extra || {});

  // ── 1. THE DEPENDENCY CHAIN ───────────────────────────────────────────
  // Four datasets waiting on the same two Buildertrend jobs, plus a third job
  // nobody can identify and a set of rows that name no job at all.
  const DEP = () => page({
    jobs: ds('jobs', { fetch: { fetched: 3, reportedCount: 3, pages: 1, mode: 'skip/limit', complete: true, reason: null, elapsedMs: 7 },
      rows: [
        jobRow(900, 'S0001 Alpha', 'matched'),                    // confident, NOT linked -> one press links it
        jobRow(901, 'S0002 Bravo', 'new'),                        // nothing in P86 -> create it
        jobRow(902, 'S0003 Charlie', 'ambiguous', { candidates: [] }), // a person has to pick
      ] }),
    changeOrders: ds('changeOrders', { rows: [waiting(1, '900', 'S0001 Alpha'), waiting(2, '900', 'S0001 Alpha'),
      waiting(3, '900', 'S0001 Alpha'), waiting(4, '901', 'S0002 Bravo'), waiting(5, '902', 'S0003 Charlie')] }),
    purchaseOrders: ds('purchaseOrders', { rows: [waiting(6, '900', 'S0001 Alpha'), waiting(7, '900', 'S0001 Alpha'),
      waiting(8, '901', 'S0002 Bravo'), waiting(9, '901', 'S0002 Bravo')] }),
    bills: ds('bills', { rows: [waiting(10, '900', 'S0001 Alpha'), waiting(11, '', '')] }),
    estimates: ds('estimates', { rows: [waiting(12, '901', 'S0002 Bravo'), waiting(13, '901', 'S0002 Bravo'),
      waiting(14, '901', 'S0002 Bravo'), waiting(15, '901', 'S0002 Bravo')] }),
  });

  test('the chain ranks Buildertrend jobs by how much each one unblocks, and names what each needs', () => {
    T.render(DEP());
    const list = T.blockers();
    expect(list.map((b) => [b.key, b.total, b.action])).toEqual([
      ['id:901', 7, 'create'],   // 1 CO + 2 POs + 4 worksheets
      ['id:900', 6, 'link'],     // 3 COs + 2 POs + 1 bill
      ['id:902', 1, 'decide'],   // one CO behind a job nobody can pick
      ['', 1, 'unnamed'],        // a bill that names no job at all
    ]);
    expect(list[0].counts).toEqual({ changeOrders: 1, purchaseOrders: 2, bills: 0, estimates: 4, tasks: 0 });
    expect(list[1].counts).toEqual({ changeOrders: 3, purchaseOrders: 2, bills: 1, estimates: 0, tasks: 0 });
    expect(T.blockerSummary(list)).toEqual({
      create: { jobs: 1, blocked: 7 },
      link: { jobs: 1, blocked: 6 },
      decide: { jobs: 1, blocked: 1 },
      unnamed: { jobs: 1, blocked: 1 },
    });
  });

  // THE ARITHMETIC AND THE CLICK ARE TWO DIFFERENT COMPUTATIONS. The chain
  // groups rows by the job they wait on; the click filters the destination
  // tab. If they ever disagree the page is lying about what a press reaches.
  test('every blocked count in the chain is the number of rows its own click reaches', () => {
    const data = DEP();
    T.render(data);
    const list = T.blockers();
    let checked = 0;
    list.forEach((b) => {
      ['changeOrders', 'purchaseOrders', 'bills', 'estimates'].forEach((k) => {
        const target = { key: k, f: 'waitjob', scope: 'all', waitJob: b.key, waitJobLabel: b.jobName };
        expect([b.key, k, T.countTarget(target)]).toEqual([b.key, k, b.counts[k]]);
        if (!b.counts[k]) return;
        // ...and the destination tab, rendered, shows exactly that many.
        T.navigate(target);
        expect(T.render(data)).toContain('>' + b.counts[k] + ' shown</span>');
        checked++;
      });
    });
    expect(checked).toBe(8);
    T.navigate({ key: 'jobs', f: 'all', scope: 'all' });
  });

  test('the chain leads with the sentence a person can act on, and drops to a sentence when nothing waits', () => {
    const html = (T.navigate({ key: 'jobs', f: 'all', scope: 'all' }), T.setTab('overview'), T.render(DEP()));
    expect(html).toContain('15 records across 4 datasets are waiting on 4 Buildertrend jobs.');
    expect(html).toContain('<b>Chasing 1 job</b> unblocks 1 record');
    expect(html).toContain('<b>Creating 1 job</b> unblocks 7 records');
    expect(html).toContain('<b>Linking 1 job</b> unblocks 6 records');
    expect(html).toContain('S0002 Bravo');
    expect(T.render(page())).toContain('data-btp-dep-none="1">Nothing is waiting on a job.');
  });

  // ── 2. MONEY ──────────────────────────────────────────────────────────
  const moneyRow = (n, cls, bt, held) => ({
    bt: Object.assign({ index: n, btId: 'm' + n, raw: 'MONEY' + n, scope: 'open', costText: '$0.00', amountText: '$0.00',
      ownerText: '$0.00', contractText: '$0.00', paidText: '$0.00', remainingText: '$0.00', lineCount: 1 }, bt || {}),
    class: cls, rung: cls === 'matched' ? 'Buildertrend ID' : null,
    p86: cls === 'matched' ? { id: 'p' + n, title: 'P' + n, amountText: '$0.00', totalText: '$0.00', lineCount: 1 } : null,
    corrections: [], btBlank: [], heldBack: held || [], flags: [], candidates: [], notes: [],
  });

  const MONEY = () => page({
    bills: ds('bills', { rows: [
      // Tickable: one figure on each side.
      moneyRow(1, 'matched', {}, [{ field: 'amount', label: 'Amount', reason: 'money', money: true,
        bt: '$1,500.25', p86: '$1,200.00', value: 1500.25, p86Value: 1200, applicable: true, note: 'tick it' }]),
      // NOT applicable: P86 has it paid. Never counted, never totalled.
      moneyRow(2, 'matched', {}, [{ field: 'amount', label: 'Amount', reason: 'money', money: true,
        bt: '$999.99', p86: '$500.00', value: 999.99, p86Value: 500, applicable: false, note: 'settled' }]),
      // Created by one press, at Buildertrend's amount.
      moneyRow(3, 'new', { amountText: '$400.00' }),
    ] }),
    purchaseOrders: ds('purchaseOrders', { rows: [
      // reason 'money' with no money flag — the addendum item, which counts.
      moneyRow(4, 'matched', {}, [{ field: 'cost', label: 'Cost', reason: 'money',
        bt: '$300.50', p86: '$100.50', value: 300.5, p86Value: 100.5, applicable: true, note: 'addendum' }]),
      moneyRow(5, 'new', { costText: '$2,000.00', state86: 'issued' }),
      moneyRow(6, 'new', { costText: '$1,250.50', state86: 'draft' }),
      moneyRow(7, 'new', { costText: 'unparsed', state86: 'issued' }),
    ] }),
    estimates: ds('estimates', { rows: [
      // Tickable and about money, but its value is a whole set of line items.
      moneyRow(8, 'matched', {}, [{ field: 'lines', label: 'Line items', reason: 'money', money: true,
        bt: '4 lines · cost $10.00', p86: '3 lines', value: { lines: [] }, p86Value: 'fingerprint', applicable: true, note: 'replaces the lines' }]),
      moneyRow(9, 'new', { ownerText: '$12,345.67' }),
    ] }),
    clients: ds('clients', { rows: [
      // Applicable, but not about money at all.
      moneyRow(10, 'matched', {}, [{ field: 'email', label: 'Email', reason: 'differs',
        bt: 'a@b.c', p86: 'x@y.z', value: 'a@b.c', applicable: true, note: 'differs' }]),
    ] }),
  });

  test('money totals count only what a person could tick, and never add two different things', () => {
    T.setTab('overview');
    T.render(MONEY());
    const m = T.moneyAtStake();
    // The $999.99 bill is held back and NOT applicable: it is not in the total,
    // not in the item count, and it is named separately for review.
    expect(m.tick).toEqual({ items: 3, rows: 3, bt: 1800.75, p86: 1300.5, noFigure: 1, delta: 500.25 });
    expect(m.review).toEqual({ items: 1, rows: 1 });
    // The committed and the draft purchase orders are never summed together.
    expect(m.committed).toEqual({ n: 2, total: 2000, unreadable: 1 });
    expect(m.draft).toEqual({ n: 1, total: 1250.5, unreadable: 0 });
    expect(m.bills).toEqual({ n: 1, total: 400, unreadable: 0 });
    expect(m.estimates).toEqual({ n: 1, total: 12345.67, unreadable: 0 });

    // ...and the group does not REACH that bill either: a row whose only
    // money item cannot be ticked is not "money waiting for a tick".
    expect(T.countTarget({ key: 'bills', f: 'money', scope: 'all' })).toBe(1);
    const g = T.groups().filter((x) => x.id === 'money')[0];
    expect(g.parts.map((p) => [p.key, p.n])).toEqual([['purchaseOrders', 1], ['bills', 1], ['estimates', 1]]);
    expect(g.n).toBe(3);
  });

  test('the money section says the figures are proposed and owns up to what is not in the total', () => {
    T.setTab('overview');
    const html = T.render(MONEY());
    expect(html).toContain('every one of them is PROPOSED');
    expect(html).toContain('Buildertrend <b>$1,800.75</b> against Project 86’s <b>$1,300.50</b>');
    expect(html).toContain('a difference of <b>$500.25</b>');
    expect(html).toContain('a whole set of line items rather than one figure, so they are not in that total');
    expect(html).toContain('cannot be ticked at all');
    expect(html).not.toMatch(/applied to Project 86 already/);
  });

  test('money is read back out of the text the server formatted, and a range is no figure at all', () => {
    expect([T.moneyNum('$1,234.56'), T.moneyNum('-$99.00'), T.moneyNum('$0.00')]).toEqual([1234.56, -99, 0]);
    expect([T.moneyNum('$1.00 – $2.00'), T.moneyNum('unparsed'), T.moneyNum(''), T.moneyNum(null)])
      .toEqual([null, null, null, null]);
  });

  // ── 3. SYNC HEALTH ────────────────────────────────────────────────────
  test('a declared key no record carried renders as a DEFECT; keys P86 does not read do not', () => {
    T.setTab('overview');
    const html = T.render(page({
      // The condition that has shipped twice: a key P86 reads that nothing sends.
      estimates: ds('estimates', { mapping: mapping({ missingKeys: ['item'], unexpectedKeys: [{ key: 'itemTitle', carriedBy: 277 }] }) }),
      // Keys Buildertrend sends that P86 does not read — information, not a fault.
      leads: ds('leads', { mapping: mapping({ missingKeys: [], unexpectedKeys: [{ key: 'hasBeenContacted', carriedBy: 74 }] }) }),
    }));
    expect(html).toContain('data-btp-health-defect="estimates"');
    expect(html).toContain('declared key no record carried: <b>item</b>');
    expect(html).not.toContain('data-btp-health-defect="leads"');
    expect(html).toContain('data-btp-health-extra="leads"');
    expect(html).toContain('information, not a fault');
    expect(html).toContain('<b>1 mapping defect.</b>');
    const h = T.health();
    expect(h.filter((x) => x.defect).map((x) => x.key)).toEqual(['estimates']);
  });

  test('a partial read is shown as partial, above every count it limits', () => {
    T.setTab('overview');
    const html = T.render(page({
      jobs: ds('jobs', { fetch: { fetched: 300, reportedCount: 708, pages: 3, mode: 'skip/limit', complete: false,
        reason: 'the page limit was reached', elapsedMs: 4200 } }),
    }));
    expect(html).toContain('data-btp-health-read="jobs">Partial');
    expect(html).toContain('300 of 708 fetched');
    expect(html).toContain('<b>1 read partial</b> — every count on this page covers only what was fetched.');
    expect(T.health().filter((x) => x.read === 'partial').map((x) => x.key)).toEqual(['jobs']);
  });

  test('a dataset whose fetch failed, and one whose mapping refused, each read as what they are', () => {
    T.setTab('overview');
    const html = T.render(page({
      bills: ds('bills', { error: { kind: 'internal', message: 'The Bills read failed inside this server before Clickr answered.' },
        mapping: null, classified: false, rows: [],
        fetch: { fetched: 0, reportedCount: null, pages: 0, mode: null, complete: false, reason: null, elapsedMs: 0 } }),
      changeOrders: ds('changeOrders', { error: { kind: 'mapping', message: 'Only 3 of 55 change orders records carry a usable "coNumber".' },
        mapping: mapping({ refusal: 'Only 3 of 55 change orders records carry a usable "coNumber".', requiredOk: false }),
        classified: false, rows: [] }),
    }));
    expect(html).toContain('data-btp-health-read="bills">Failed');
    expect(html).toContain('The Bills read failed inside this server');
    // The read itself was complete; it is the MAPPING that refused.
    expect(html).toContain('data-btp-health-read="changeOrders">Complete');
    expect(html).toContain('data-btp-health-defect="changeOrders"');
    expect(html).toContain('Mapping refused: Only 3 of 55');
    // ...and it is said ONCE, as the defect it is.
    expect(html.split('Only 3 of 55 change orders records').length - 1).toBe(1);
    expect(html).toContain('<b>1 dataset failed.</b>');
    // A dataset that classified nothing contributes nothing, and nothing throws.
    expect(T.groups().every((g) => g.n === 0)).toBe(true);
  });

  // ── 4. THE INVARIANT ──────────────────────────────────────────────────
  // A spread wide enough that every group has something in it.
  const row = (key, n, cls, extra) => Object.assign({
    bt: { index: n, btId: key + n, raw: key.toUpperCase() + n, scope: 'open', jobId: '900', jobName: 'S0001 Alpha',
      status: 'Open', statusText: 'Approved', street: '', city: '', state: '', zip: '', projectedStart: '',
      contractText: '$0.00', costText: '$10.00', amountText: '$10.00', ownerText: '$10.00', priceText: '$10.00',
      paidText: '$0.00', remainingText: '$0.00', lineCount: 1, state86: 'issued' },
    class: cls, rung: null, p86: null, corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [],
  }, extra || {});

  const SPREAD = () => page({
    jobs: ds('jobs', { rows: [
      jobRow(900, 'S0001 Alpha', 'matched'),
      row('jobs', 1, 'new'),
      Object.assign(row('jobs', 2, 'new'), { bt: Object.assign(row('jobs', 2, 'new').bt, { scope: 'closed' }) }),
      row('jobs', 3, 'ambiguous'),
      row('jobs', 4, 'possible_duplicate'),
      row('jobs', 5, 'conflict', { p86: { id: 'p5', jobNumber: 'S5', title: 'five', status: 'In Progress', street: '', city: '', state: '', zip: '' },
        rung: 'number', corrections: [{ field: 'city', label: 'City', kind: 'value', from: 'Tampa', to: 'Orlando' }] }),
      row('jobs', 6, 'refused', { notes: ['Buildertrend marks this job deleted, so it is not matched and never created.'] }),
      row('jobs', 7, 'refused', { notes: ['Buildertrend marks this job deleted, so it is not matched and never created.'] }),
      row('jobs', 8, 'not_a_job', { notes: ['No job number at the front of the name.'] }),
    ] }),
    bills: ds('bills', { rows: [
      row('bills', 1, 'new'),
      waiting(20, '901', 'S0002 Bravo'),
      row('bills', 2, 'matched', { rung: 'Buildertrend ID', p86: { id: 'pb2', billNumber: 'B2', title: 'b', amountText: '$1.00' },
        heldBack: [{ field: 'amount', label: 'Amount', reason: 'money', money: true, bt: '$10.00', p86: '$1.00',
          value: 10, p86Value: 1, applicable: true, note: 'tick it' }] }),
      row('bills', 3, 'refused', { notes: ['Deleted in Buildertrend.'] }),
    ] }),
    estimates: ds('estimates', { rows: [waiting(21, '901', 'S0002 Bravo'), row('estimates', 1, 'new')] }),
  });

  test('EVERY group count is the number of rows its click actually reaches', () => {
    const data = SPREAD();
    T.setTab('overview');
    T.render(data);
    const gs = T.groups();
    // Nothing empty: a test that passes because every group is zero proves nothing.
    expect(gs.map((g) => g.id)).toEqual(['blocked', 'create', 'disagree', 'money', 'undecided', 'refused']);
    expect(gs.every((g) => g.n > 0)).toBe(true);
    let parts = 0;
    gs.forEach((g) => {
      // The group claims exactly the sum of its parts.
      expect([g.id, g.n]).toEqual([g.id, g.parts.reduce((s, p) => s + p.n, 0)]);
      g.parts.forEach((p) => {
        parts++;
        // ...and each part's click lands on a list of exactly that length.
        T.navigate({ key: p.key, f: p.f, scope: p.scope });
        const html = T.render(data);
        expect([g.id, p.key, p.f, html.indexOf('>' + p.n + ' shown</span>') >= 0]).toEqual([g.id, p.key, p.f, true]);
        T.setTab('overview');
      });
    });
    expect(parts).toBeGreaterThanOrEqual(8);
    // The group's own number, as the page prints it.
    const html = T.render(data);
    gs.forEach((g) => {
      expect(html).toContain('data-btp-group-n="' + g.id + '">' + g.n + '<');
    });
  });

  test('the refusal reasons add up to the refused group, and waiting rows are not counted twice', () => {
    const data = SPREAD();
    T.setTab('overview');
    T.render(data);
    const refused = T.groups().filter((g) => g.id === 'refused')[0];
    const blocked = T.groups().filter((g) => g.id === 'blocked')[0];
    const reasons = T.refusalReasons();
    expect(reasons.reduce((s, r) => s + r.n, 0)).toBe(refused.n);
    expect(reasons[0]).toEqual({ why: 'Buildertrend marks this job deleted, so it is not matched and never created.', n: 2 });
    // The two waiting rows are in "blocked" and NOWHERE else.
    expect(blocked.n).toBe(2);
    expect(reasons.some((r) => /not linked to a P86 job yet/.test(r.why))).toBe(false);
  });

  test('the create group counts exactly what the Create press makes, and says so about closed jobs', () => {
    const data = SPREAD();
    T.setTab('overview');
    const html = T.render(data);
    const create = T.groups().filter((g) => g.id === 'create')[0];
    // jobs1 (open) + bills1 + estimates1 are in the one press; jobs2 is closed.
    expect(create.parts.map((p) => [p.key, p.f, p.n])).toEqual([
      ['jobs', 'creatable', 1], ['bills', 'creatable', 1], ['estimates', 'creatable', 1], ['jobs', 'closed_new', 1],
    ]);
    expect(create.n).toBe(4);
    expect(html).toContain('closed in Buildertrend — created one at a time from the row');
    // The dashboard's count and the Jobs tab's own Create button agree.
    T.navigate({ key: 'jobs', f: 'creatable', scope: 'all' });
    expect(T.render(data)).toContain('Create 1 Buildertrend-only open + warranty job in P86');
    T.setTab('overview');
  });

  // ── 5. THE EDGES ──────────────────────────────────────────────────────
  test('the page renders with zero rows everywhere and claims nothing', () => {
    T.setTab('overview');
    const html = T.render(page());
    expect(html).toContain('Nothing is waiting on a job.');
    expect(html).toContain('data-btp-group-n="create">0<');
    expect(html).toContain('Every dataset read completely and every declared key arrived.');
    expect(T.blockers()).toEqual([]);
    expect(T.refusalReasons()).toEqual([]);
  });

  test('the Show box on the destination names the view its rows are in, including one Buildertrend job', () => {
    const data = DEP();
    T.navigate({ key: 'changeOrders', f: 'waitjob', scope: 'all', waitJob: 'id:900', waitJobLabel: 'S0001 Alpha' });
    const html = T.render(data);
    expect(html).toContain('<option value="waitjob" selected>Waiting on S0001 Alpha</option>');
    expect(html).toContain('>3 shown</span>');
    T.navigate({ key: 'bills', f: 'money', scope: 'all' });
    expect(T.render(data)).toContain('<option value="money" selected>Money waiting for a tick</option>');
    T.setTab('overview');
  });

  test('the automatic sync has a place to land, and the page says there is not one yet', () => {
    T.setTab('overview');
    const html = T.render(page());
    expect(html).toContain('data-btp-run-slot="1"');
    expect(html).toContain('No sync runs on its own yet');
    expect(html).toContain('its last run, what it changed and its undo appear in this block');
    // It is the FIRST thing on the tab, above everything a person presses.
    expect(html.indexOf('data-btp-run-slot="1"')).toBeLessThan(html.indexOf('data-btp-dash="dependencies"'));
  });

  test('every server string the Overview prints is escaped', () => {
    const x = '<img src=x onerror="alert(1)">\'&';
    const refusedWithMarkup = Object.assign(waiting(2, '', ''), { waitingOnJob: false, notes: [x] });
    const bad = page({
      jobs: ds('jobs', { label: x, sentence: x, mapping: mapping({ missingKeys: [x], unexpectedKeys: [{ key: x, carriedBy: 2 }] }),
        fetch: { fetched: 1, reportedCount: 1, pages: 1, mode: x, complete: false, reason: x, elapsedMs: 1 },
        rows: [jobRow(900, x, 'ambiguous')] }),
      bills: ds('bills', { label: x, rows: [waiting(1, '900', x), refusedWithMarkup] }),
    });
    bad.organization.name = x;
    T.setTab('overview');
    const html = T.render(bad);
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/onerror="/);
  });
});

// ── the Overview and the tabs walk the SAME datasets ──────────────────────
// A dataset the server returns but the Overview does not walk is a count that
// disagrees with the rows it claims to reach: the tab shows them, the Overview
// never counts them, and the chain under-ranks the jobs blocking them. This
// happened once already — tasks shipped while DS_ORDER still named seven
// datasets, and tasks span 64 Buildertrend jobs.
describe('the Overview walks every dataset the server returns', () => {
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8'),
    { window: win, document: {}, console });
  const T = win.p86BtSyncPreview._test;

  test('DS_ORDER is exactly PREVIEW_KINDS, in the server order', () => {
    expect(T.DS_ORDER).toEqual(preview.PREVIEW_KINDS);
  });

  test('every WAIT_KIND is a dataset the server returns', () => {
    expect(T.WAIT_KINDS.length).toBeGreaterThan(0);
    for (const k of T.WAIT_KINDS) expect(preview.PREVIEW_KINDS).toContain(k);
  });

  test('every dataset has a tab, and every tab but Overview and Archive is a dataset', () => {
    const tabKeys = T.TABS.map((t) => t[0]);
    for (const k of preview.PREVIEW_KINDS) expect(tabKeys).toContain(k);
    for (const k of tabKeys) {
      if (k === 'overview' || k === 'archive') continue;
      expect(preview.PREVIEW_KINDS).toContain(k);
    }
  });
});
