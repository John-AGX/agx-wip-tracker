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
    expect(fieldsOf(r)).toEqual(['city', 'state', 'status', 'street']);
    expect(r.corrections.find((c) => c.field === 'street')).toMatchObject({ from: '1 Harbor Dr', to: '1 Harbor Drive', kind: 'format' });
    const city = r.corrections.find((c) => c.field === 'city');
    expect(city).toMatchObject({ from: 'Tampa', to: 'Tamp', kind: 'value' });
    expect(city.typo).toMatch(/fix it in Buildertrend/);
    expect(r.corrections.find((c) => c.field === 'state')).toMatchObject({ from: 'FL', to: 'Fl', kind: 'format' });
    expect(r.corrections.find((c) => c.field === 'status')).toMatchObject({ from: 'In Progress', to: 'Closed', toP86: 'Completed' });
    expect(r.btBlank).toEqual([{ field: 'zip', label: 'Zip', p86: '33602' }]);
  });

  test('EXACT NUMBER: money is HELD BACK with both figures (contract vs data.contractAmount, approved COs vs P86\'s computed sum); the number is not proposed', () => {
    const r = one(rows, 'S1050 Harbor Club Railings');
    expect(r.heldBack.map((h) => [h.field, h.p86, h.bt, h.reason])).toEqual([
      ['contractPrice', '$12,000.00', '$15,000.50', 'money'],
      ['approvedCOPrice', '$1,000.00', '$2,500.00', 'money'],
    ]);
    expect(r.corrections.some((c) => /price|contract|jobNumber/i.test(c.field))).toBe(false);
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

  test('a number shared by four BT rows: every one of them ambiguous', () => {
    const hits = rows.filter((r) => r.bt.number === 'WO16');
    expect(hits).toHaveLength(4);
    for (const r of hits) {
      expect(r.class).toBe('ambiguous');
      expect(r.notes.join(' ')).toMatch(/4 Buildertrend jobs use the number WO16/);
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

  test('WARRANTY is flagged, not mapped, and is not a correction', () => {
    const r = one(rows, 'S5100 Sunset Roof');
    expect(r.class).toBe('matched');
    expect(r.flags).toEqual([expect.objectContaining({ field: 'status' })]);
    expect(r.flags[0].text).toMatch(/Warranty/);
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
    expect(s.counts).toEqual({ matched: 4, conflict: 3, ambiguous: 14, possible_duplicate: 2, new: 2, change_order: 1, not_a_job: 2, refused: 1 });
    expect(s.matchRateBase).toBe(25);
    expect(s.matchRate).toBeCloseTo(7 / 25, 10);
    const open = match.summarise(rows, (r) => r.bt.scope === 'open');
    expect(open.records).toBe(rows.filter((r) => ['Open', 'Warranty'].includes(r.bt.status)).length);
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
    expect(s1050.corrections.map((c) => [c.field, c.to])).toEqual([['city', 'Tamp']]);
    // Contract from data.contractAmount; approved COs = the $1,000 approved row only
    // (not the $9,000 draft, not org B's mis-stamped $50,000).
    expect(s1050.heldBack.map((h) => [h.field, h.p86, h.bt])).toEqual([
      ['contractPrice', '$12,000.00', '$15,000.00'], ['approvedCOPrice', '$1,000.00', '$2,500.00']]);
    expect(jobs.rows.filter((x) => x.bt.number === 'WO16').every((x) => x.class === 'ambiguous')).toBe(true);
    expect(jobs.summary.counts).toMatchObject({ not_a_job: 1, change_order: 1 });
    expect(r.json.p86).toMatchObject({ jobs: 3, leads: 2, unscopedJobs: 1, unscopedLeads: 1 });
    expect(jobs.notInBuildertrend).toMatchObject({ reliable: true });
    expect(jobs.notInBuildertrend.rows.map((x) => x.id)).toEqual(['j-a2']);
    expect(jobs.notInBuildertrend.notListed).toBe(1);
    expect(r.json.readOnly).toBe(true);
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

describe('HTTP — it writes NOTHING, proved on every table', () => {
  test('every table identical before and after, and every statement a SELECT', async () => {
    await get('/api/admin/organizations/me', AGX_ADMIN);   // absorb requireAuth's last_seen_at bump
    const before = snapshot();
    expect(Object.keys(before).length).toBe(ALL_TABLES.length);
    const logStart = engine.log.length;
    const r = await get(PREVIEW, AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(r.json.datasets.jobs.summary.correctedFields).toBeGreaterThan(0);
    expect(r.json.datasets.leads.classified).toBe(true);
    expect(snapshot()).toEqual(before);
    const stmts = engine.log.slice(logStart);
    expect(stmts.length).toBeGreaterThan(0);
    expect(stmts.filter((s) => !s.read).map((s) => s.sql)).toEqual([]);
    expect(stmts.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
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
});
