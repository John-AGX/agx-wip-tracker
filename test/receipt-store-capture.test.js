// CAPTURING THE STORE OFF A RECEIPT, AND SHOWING WHAT THE RECEIPTS ALREADY KNOW.
//
// Four properties, each stated as a property rather than as a walkthrough:
//
//   1. THE NORMALIZER GROUPS ONE MERCHANT AND REFUSES TO GROUP TWO.
//      "HOME DEPOT #0242" and "THE HOME DEPOT" are one counter. "HD SUPPLY"
//      is a different company. A collision is not permission.
//   2. NO EXISTING MONEY MOVES. Every receipt row that existed before the
//      capture flow ran is byte-identical after it, and the job-cost rollup
//      returns the same numbers.
//   3. A READ THAT CANNOT BE VOUCHED FOR DOES NOT LOOK LIKE ONE THAT CAN.
//      A phone is dialable only when two independent receipts read the same
//      digits, and the flag is computed on the SERVER so the client cannot
//      decide otherwise.
//   4. THE VIEW WRITES NOTHING, and it is org-scoped on both of its arms —
//      which have two different tenancy models.
//
// Driven against a real SQL engine holding the schema PARSED from server/db.js,
// through the real router, over real HTTP. `engine.log` is used for exactly one
// thing — proving no write statement was issued — and never as a substitute for
// looking at what came back.

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TWO = require('./helpers/two-org');
const VN = require('../server/services/vendor-name');

let mockEngine;

jest.mock('../server/db', () => ({
  pool: {
    query: (sql, params) => mockEngine.pool.query(sql, params),
    connect: async () => ({
      query: (sql, params) => mockEngine.pool.query(sql, params),
      release: () => {},
    }),
  },
}));

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const receiptRoutes = require('../server/routes/receipt-routes');

const ORG_A = TWO.ORG_A;
const ORG_B = TWO.ORG_B;
let server;
let baseUrl;

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE NORMALIZER — pure, so it is tested purely.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the normalizer groups spellings of one merchant', () => {
  const key = (s) => VN.normalizeVendorName(s).key;

  test.each([
    ['HOME DEPOT', 'THE HOME DEPOT'],
    ['HOME DEPOT', 'HOME DEPOT #0242'],
    ['HOME DEPOT', 'The Home Depot, Inc.'],
    ['HOME DEPOT #0242', 'HOME DEPOT STORE #6301'],
    ['ABC Supply', 'ABC SUPPLY CO'],
    ['ABC Supply', 'ABC Supply Co Inc'],
    ["LOWE'S", 'LOWES'],
    ['Sherwin-Williams', 'SHERWIN WILLIAMS CO.'],
    ['White Cap', 'WHITE CAP LLC'],
  ])('%s and %s are one counter', (a, b) => {
    expect(key(a)).toBe(key(b));
    expect(key(a)).not.toBe('');
  });

  test('the branch number comes off, and it is kept', () => {
    expect(VN.normalizeVendorName('HOME DEPOT #0242')).toMatchObject({ key: 'home depot', branch: '0242' });
    expect(VN.normalizeVendorName('HOME DEPOT STORE #6301')).toMatchObject({ key: 'home depot', branch: '6301' });
    // A number in the MIDDLE of a name is part of the name.
    expect(VN.normalizeVendorName('84 Lumber').branch).toBeNull();
    expect(VN.normalizeVendorName('84 Lumber').key).toBe('84 lumber');
  });
});

describe('the normalizer refuses to group two merchants', () => {
  const key = (s) => VN.normalizeVendorName(s).key;

  test.each([
    ['HOME DEPOT', 'HD SUPPLY'],
    ['HOME DEPOT', 'Home Depot Credit Services'],
    ['LOWES', 'LOWES HOME IMPROVEMENT'],
    ['WHITE CAP', 'White Cap Construction Supply'],
    ['ABC Supply', 'ABC Roofing'],
    // The empty-key trap, from both sides. Subtractive rules can subtract
    // everything, and if the residue were the key these two would merge.
    ['The Company', 'The Group'],
    // POSITION. A corporate form word is only noise in the SUFFIX position,
    // and `the` only in the prefix. Both client copies of this rule
    // (js/purchase-order-editor.js:782, js/doc-import.js:591) strip them
    // ANYWHERE, which merges each of these pairs into one merchant. This case
    // exists because a mutation that stripped them anywhere passed every other
    // assertion in this file.
    ['CO Supply', 'Supply'],
    ['Group Health Partners', 'Health Partners'],
    ['Holding Bay Lumber', 'Bay Lumber'],
  ])('%s and %s stay apart', (a, b) => {
    expect(key(a)).not.toBe(key(b));
  });

  test('a name that is nothing but noise still keeps its own identity', () => {
    expect(key('The Company')).toBe('the company');
    expect(key('The Group')).toBe('the group');
    // and a real one-word name is untouched — `co` is not a word inside Costco
    expect(key('COSTCO')).toBe('costco');
  });
});

describe('a misread field is refused rather than stored', () => {
  test('a phone is NANP-valid or it is null', () => {
    expect(VN.normalizePhone('(407) 555-0119')).toBe('(407) 555-0119');
    expect(VN.normalizePhone('407-555-0119')).toBe('(407) 555-0119');
    expect(VN.normalizePhone('1 407 555 0119')).toBe('(407) 555-0119');
    // Each of these is a class of OCR damage, not a class of phone number.
    expect(VN.normalizePhone('107-555-0119')).toBeNull();   // area code starts with 1
    expect(VN.normalizePhone('407-055-0119')).toBeNull();   // exchange starts with 0
    expect(VN.normalizePhone('911-555-0119')).toBeNull();   // N11 area code
    expect(VN.normalizePhone('40755501')).toBeNull();       // a digit went missing
    expect(VN.normalizePhone('4075550119123')).toBeNull();  // a digit was invented
    expect(VN.normalizePhone('')).toBeNull();
    expect(VN.normalizePhone(null)).toBeNull();
  });

  test('the BUYER\'s address is never stored as the seller\'s', () => {
    // The trap on a branch-distributor pickup ticket: the most prominent
    // address on the page is AGX's own.
    expect(VN.cleanStoreAddress('Bill To: AGX Central Florida, 123 Main St', 'ABC SUPPLY')).toBeNull();
    expect(VN.cleanStoreAddress('SHIP TO 456 Elm Street', 'ABC SUPPLY')).toBeNull();
    expect(VN.cleanStoreAddress('Sold to: 9 Oak Ave', 'ABC SUPPLY')).toBeNull();
    expect(VN.cleanStoreAddress('Remit To 1 Pay St', 'ABC SUPPLY')).toBeNull();
    // and a real one survives
    expect(VN.cleanStoreAddress('1120 W Osceola Pkwy, Kissimmee FL 34741', 'HOME DEPOT'))
      .toBe('1120 W Osceola Pkwy, Kissimmee FL 34741');
  });

  test('an "address" that is just the merchant name again is refused', () => {
    expect(VN.cleanStoreAddress('HOME DEPOT', 'HOME DEPOT')).toBeNull();
    expect(VN.cleanStoreAddress('a street', 'HOME DEPOT')).toBeNull(); // no number
  });

  test('a store number is not a phone and not a register id', () => {
    expect(VN.normalizeStoreNumber('#0242')).toBe('0242');
    expect(VN.normalizeStoreNumber('STORE 6301')).toBe('6301');
    expect(VN.normalizeStoreNumber('4075550119')).toBeNull();   // that is a phone
    expect(VN.normalizeStoreNumber('ABCD')).toBeNull();         // no digits
    expect(VN.normalizeStoreNumber('')).toBeNull();
  });
});

describe('confidence is agreement across receipts, never a self-reported score', () => {
  test('nothing read is "none", never a blank value that reads as an answer', () => {
    expect(VN.agreement([])).toMatchObject({ verdict: 'none', value: null, reads: 0 });
  });
  test('one reading is a reading, not a confirmation', () => {
    expect(VN.agreement(['(407) 555-0119'])).toMatchObject({ verdict: 'read_once', reads: 1 });
  });
  test('two independent readings that agree are evidence', () => {
    expect(VN.agreement(['(407) 555-0119', '(407) 555-0119']))
      .toMatchObject({ verdict: 'agreed', value: '(407) 555-0119', reads: 2 });
  });
  test('a conflict returns NO single value — a caller cannot render it as confident', () => {
    const a = VN.agreement(['(407) 555-0119', '(407) 555-0118', '(407) 555-0119']);
    expect(a.verdict).toBe('conflict');
    expect(a.value).toBeNull();
    expect(a.values.map((v) => v.value).sort())
      .toEqual(['(407) 555-0118', '(407) 555-0119']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2-4. THE ROUTES, against a real engine.
 * ══════════════════════════════════════════════════════════════════════════*/
function seedRow(table, cols) {
  const keys = Object.keys(cols);
  return mockEngine.pool.query(
    'INSERT INTO ' + table + ' (' + keys.join(',') + ') VALUES ('
      + keys.map((_, i) => '$' + (i + 1)).join(',') + ')',
    keys.map((k) => cols[k]));
}

// The world both orgs live in. Org A buys at two Home Depots and a White Cap;
// org B's rows carry the two-org markers and must never appear.
async function seedWorld() {
  // ── org A receipts. Two agree on #0242's phone; one reads #6301 once; one
  // has a store the model could not read at all.
  const A = [
    ['rc_a1', 'HOME DEPOT #0242', 412.66, 'materials', '0242', 'THE HOME DEPOT',
      '1120 W Osceola Pkwy, Kissimmee FL 34741', '(407) 555-0119'],
    ['rc_a2', 'THE HOME DEPOT', 88.10, 'materials', '0242', 'THE HOME DEPOT',
      '1120 W Osceola Pkwy, Kissimmee FL 34741', '(407) 555-0119'],
    ['rc_a3', 'HOME DEPOT', 51.25, 'materials', '6301', 'THE HOME DEPOT',
      '4600 Millenia Plaza Way, Orlando FL 32839', '(407) 555-0288'],
    ['rc_a4', 'WHITE CAP', 204.00, 'gc', null, null, null, null],
    ['rc_a5', 'HD SUPPLY', 19.99, 'materials', null, null, null, null],
  ];
  for (const [id, vendor, amount, code, num, nm, addr, ph] of A) {
    await seedRow('receipts', {
      id, organization_id: ORG_A, vendor, amount, cost_code: code, status: 'processed',
      entity_type: 'job', entity_id: 'jobs-A-0', purchased_at: '2026-08-01',
      attachment_id: 'att_' + id, is_presale: 0,
      store_number: num, store_name: nm, store_address: addr, store_phone: ph,
    });
  }
  // A receipt with a photo and NO store details — the backfill candidate.
  await seedRow('receipts', {
    id: 'rc_a6', organization_id: ORG_A, vendor: 'LOWES', amount: 30, cost_code: 'materials',
    status: 'processed', entity_type: 'job', entity_id: 'jobs-A-0', purchased_at: '2026-08-02',
    attachment_id: 'att_rc_a6', is_presale: 0,
  });

  // ── org B. Marked, poisoned, and it must not appear anywhere.
  await seedRow('receipts', {
    id: 'rc_b1', organization_id: ORG_B, vendor: TWO.MARK + ' Depot', amount: 900005111,
    cost_code: 'materials', status: 'processed', store_phone: '(900) 555-0002',
    store_address: TWO.MARK + ' Street', store_name: TWO.MARK + ' Depot', store_number: '9002',
  });

  // ── QuickBooks cost lines, scoped THROUGH THE JOB, not through their own
  // organization_id column. Org B's line hangs off org B's job.
  await seedRow('qb_cost_lines', {
    id: 'qb_a1', organization_id: ORG_A, job_id: 'jobs-A-0', vendor: 'HOME DEPOT',
    amount: 3120.48, txn_date: '2026-07-01', txn_type: 'Bill', account: 'Materials',
  });
  await seedRow('qb_cost_lines', {
    id: 'qb_a2', organization_id: ORG_A, job_id: 'jobs-A-0', vendor: 'The Home Depot Inc',
    amount: 220.00, txn_date: '2026-07-02', txn_type: 'Bill', account: 'Materials',
  });
  // An ACCRUAL journal entry. Excluded from the money by the shared classifier,
  // and its exclusion is COUNTED so it is not silently gone.
  await seedRow('qb_cost_lines', {
    id: 'qb_a3', organization_id: ORG_A, job_id: 'jobs-A-0', vendor: 'HOME DEPOT',
    amount: 9999.99, txn_date: '2026-07-31', txn_type: 'Journal Entry', account: 'Subcontractors',
  });
  // A Subcontractors line — match-only, reported on its OWN arm.
  await seedRow('qb_cost_lines', {
    id: 'qb_a4', organization_id: ORG_A, job_id: 'jobs-A-0', vendor: 'ABC Supply Co',
    amount: 740.00, txn_date: '2026-07-10', txn_type: 'Bill', account: 'Subcontractors',
  });
  await seedRow('qb_cost_lines', {
    id: 'qb_b1', organization_id: ORG_B, job_id: TWO.idFor('jobs', 'B'), vendor: TWO.MARK + ' Supply',
    amount: 900007000, txn_date: '2026-07-05', txn_type: 'Bill', account: 'Materials',
  });
  // ── THE ROW THAT MAKES THE TWO PREDICATES DISAGREE ──────────────────────
  // qb_cost_lines.organization_id is a DENORMALISED CACHE; the anchor is the
  // parent job (org-table-classification.js:87). This row's cache says org A
  // and its job says org B — which is what a stale or mis-stamped cache looks
  // like, and it is the ONLY row shape that can tell the correct predicate
  // apart from the convenient one at runtime.
  //
  // Without it the naive `WHERE q.organization_id = $1` passes every
  // behavioural assertion in this file, because every other row's cache
  // happens to agree with its job. That is precisely how a cross-tenant read
  // survives a green suite in a single-tenant production.
  await seedRow('qb_cost_lines', {
    id: 'qb_b2', organization_id: ORG_A, job_id: TWO.idFor('jobs', 'B'),
    vendor: TWO.MARK + ' Stale Cache Supply',
    amount: 900007001, txn_date: '2026-07-06', txn_type: 'Bill', account: 'Materials',
  });
}

beforeAll(async () => {
  mockEngine = TWO.buildEngine({
    overlay: {
      roles: [
        { name: 'admin', label: 'Admin', capabilities: JSON.stringify(['FINANCIALS_VIEW', 'ROLES_MANAGE']) },
        { name: 'field', label: 'Field', capabilities: JSON.stringify([]) },
      ],
      jobs: [
        { id: 'jobs-A-0', organization_id: ORG_A },
        { id: TWO.idFor('jobs', 'B'), organization_id: ORG_B },
      ],
    },
  });
  // The generic two-org seed puts a row in `receipts` and `qb_cost_lines` for
  // all three tenants. Cleared here so the counts below are the world this
  // file describes rather than the world plus three artefacts — the org-B rows
  // are then re-planted explicitly, so the boundary is still proved.
  await mockEngine.pool.query('DELETE FROM receipts', []);
  await mockEngine.pool.query('DELETE FROM qb_cost_lines', []);
  await seedWorld();

  setRolePool({ query: (sql, params) => mockEngine.pool.query(sql, params) });
  await refreshRoleCache();

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/receipts', receiptRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});

afterAll((done) => {
  server.close(() => { mockEngine.close(); done(); });
});

function token(over) {
  return signToken(Object.assign(
    { id: 101, email: 'a@a.test', role: 'admin', name: 'A', organization_id: ORG_A }, over || {}));
}

async function call(method, url, body, over) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: Object.assign(
      { authorization: 'Bearer ' + token(over), connection: 'close' },
      body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

// Any statement that CHANGES a row. `requireAuth` touches
// `users.last_seen_at` on every authenticated request in this app — that is
// the session clock, not this feature, and it is EXCLUDED BY NAME rather than
// by loosening the pattern, so a write to users that is NOT the session clock
// still fails this.
const WRITE_RE = /\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|CREATE\s+|DROP\s+|ALTER\s+)/i;
const AUTH_SESSION_CLOCK = /^UPDATE users SET last_seen_at = NOW\(\) WHERE id = \$1$/;
function writesIn(entries) {
  return entries
    .map((e) => String(e.sql).replace(/\s+/g, ' ').trim())
    .filter((sql) => WRITE_RE.test(sql))
    .filter((sql) => !AUTH_SESSION_CLOCK.test(sql));
}

// Every receipt row, in full, as a comparable string. The money invariant is
// stated against THIS, not against a total: a total can stay the same while two
// rows swap values.
function snapshotReceipts() {
  return mockEngine
    .all('SELECT * FROM receipts ORDER BY id')
    .map((r) => JSON.stringify(r))
    .join('\n');
}

describe('GET /api/receipts/merchants — it writes nothing', () => {
  test('not one write statement reaches the engine', async () => {
    const from = mockEngine.log.length;
    const r = await call('GET', '/api/receipts/merchants');
    expect(r.status).toBe(200);
    // Named, not counted: a failure has to say WHICH statement wrote.
    expect(writesIn(mockEngine.log.slice(from))).toEqual([]);
    // And the drive was real — a route that issued no statement at all would
    // pass the line above for the wrong reason. Three reads: receipts, QB, and
    // the backfill count.
    expect(mockEngine.log.length - from).toBeGreaterThanOrEqual(3);
  });

  test('and every receipt row is byte-identical afterwards', async () => {
    const before = snapshotReceipts();
    await call('GET', '/api/receipts/merchants');
    expect(snapshotReceipts()).toBe(before);
  });
});

describe('the merchant list is what the rows actually say', () => {
  let body;
  beforeAll(async () => { body = (await call('GET', '/api/receipts/merchants')).body; });

  test('one Home Depot, built from four spellings across both sources', () => {
    const hd = body.merchants.find((m) => m.key === 'home depot');
    expect(hd).toBeDefined();
    expect(hd.variants.map((v) => v.raw).sort())
      .toEqual(['HOME DEPOT', 'HOME DEPOT #0242', 'THE HOME DEPOT', 'The Home Depot Inc']);
    // The spellings are SHOWN, not silently absorbed — a split stays visible.
    expect(hd.variants.length).toBeGreaterThan(1);
  });

  test('HD Supply is its own merchant and its money is its own', () => {
    const hd = body.merchants.find((m) => m.key === 'home depot');
    const hds = body.merchants.find((m) => m.key === 'hd supply');
    expect(hds).toBeDefined();
    expect(hds.receipts.amount).toBe(19.99);
    // If these had merged, Home Depot's receipt total would carry the 19.99.
    expect(hd.receipts.amount).toBe(412.66 + 88.10 + 51.25);
  });

  test('receipt money and QuickBooks money are separate fields and there is NO total', () => {
    const hd = body.merchants.find((m) => m.key === 'home depot');
    expect(hd.qb_cost.amount).toBe(3120.48 + 220.00);
    expect(hd.receipts.amount).toBe(552.01);
    // Structurally impossible to render a combined figure: no such field
    // exists, at the merchant level or at the top.
    const keys = Object.keys(hd);
    expect(keys).not.toContain('total');
    expect(keys).not.toContain('spend');
    expect(keys).not.toContain('total_amount');
    expect(Object.keys(body)).not.toContain('total');
  });

  test('the accrual journal entry is excluded from money AND counted', () => {
    const hd = body.merchants.find((m) => m.key === 'home depot');
    // 9999.99 would be the single largest number on the screen if it counted.
    expect(hd.qb_cost.amount).not.toBeCloseTo(3340.48 + 9999.99, 2);
    expect(hd.qb_accrual_excluded.lines).toBe(1);
  });

  test('a Subcontractors line lands on its own arm, not in cost', () => {
    const abc = body.merchants.find((m) => m.key === 'abc supply');
    expect(abc.qb_sub).toEqual({ lines: 1, amount: 740 });
    expect(abc.qb_cost).toEqual({ lines: 0, amount: 0 });
  });

  test('the display name is a spelling a human wrote, never the normalized key', () => {
    body.merchants.forEach((m) => {
      expect(m.display).not.toBe(m.key);
      expect(m.variants.map((v) => v.raw)).toContain(m.display);
    });
  });

  test('a merchant with no store details says so rather than rendering nothing', () => {
    const wc = body.merchants.find((m) => m.key === 'white cap');
    expect(wc.stores).toHaveLength(1);
    expect(wc.stores[0].branch).toBeNull();
    expect(wc.stores[0].address.verdict).toBe('none');
    expect(wc.stores[0].phone.verdict).toBe('none');
  });

  test('the backfill is priced and NOT run', () => {
    expect(body.backfill.enabled).toBe(false);
    // rc_a4 (WHITE CAP), rc_a5 (HD SUPPLY) and rc_a6 (LOWES) each have a photo
    // on file and no store details. A receipt with no photo is NOT a candidate
    // — there is nothing to re-read — and that is the difference this counts.
    expect(body.backfill.candidates).toBe(3);
    expect(body.backfill.estimated_usd).toBeGreaterThan(0);
    expect(body.backfill.model).toBe('claude-haiku-4-5');
    // Priced from the real model config, not from a number typed here.
    expect(body.backfill.estimated_usd)
      .toBeCloseTo(body.backfill.candidates * body.backfill.usd_per_receipt, 4);
  });

  test('the sources are reported, including how many rows carry no vendor', () => {
    expect(body.sources.receipts.rows).toBe(6);
    expect(body.sources.qb_cost_lines.rows).toBe(4);
    expect(body.sources.receipts.truncated).toBe(false);
    expect(body.sources.qb_cost_lines.truncated).toBe(false);
  });
});

describe('a number nobody vouched for does not look like one somebody did', () => {
  let hd;
  beforeAll(async () => {
    const body = (await call('GET', '/api/receipts/merchants')).body;
    hd = body.merchants.find((m) => m.key === 'home depot');
  });

  test('two receipts reading the same digits makes the phone dialable', () => {
    const s = hd.stores.find((x) => x.branch === '0242');
    expect(s.phone).toMatchObject({ verdict: 'agreed', value: '(407) 555-0119', reads: 2, dialable: true });
  });

  test('one receipt does NOT — it is shown, labelled, and not a link', () => {
    const s = hd.stores.find((x) => x.branch === '6301');
    expect(s.phone).toMatchObject({ verdict: 'read_once', value: '(407) 555-0288', reads: 1, dialable: false });
  });

  test('dialable is decided by the SERVER, so the client cannot promote a guess', () => {
    hd.stores.forEach((s) => {
      expect(typeof s.phone.dialable).toBe('boolean');
      expect(s.phone.dialable).toBe(s.phone.verdict === 'agreed');
    });
  });

  test('a conflicting phone is never dialable and never shown as one value', async () => {
    // Plant a third reading of #0242 that disagrees, exactly as a bad photo
    // would. The verdict has to flip, and the number has to stop being a link.
    await seedRow('receipts', {
      id: 'rc_a7', organization_id: ORG_A, vendor: 'HOME DEPOT #0242', amount: 5, cost_code: 'materials',
      status: 'processed', store_number: '0242', store_phone: '(407) 555-0110',
      store_address: '1120 W Osceola Pkwy, Kissimmee FL 34741', purchased_at: '2026-08-03',
    });
    const body = (await call('GET', '/api/receipts/merchants')).body;
    const s = body.merchants.find((m) => m.key === 'home depot').stores.find((x) => x.branch === '0242');
    expect(s.phone.verdict).toBe('conflict');
    expect(s.phone.dialable).toBe(false);
    expect(s.phone.value).toBeNull();
    expect(s.phone.values.map((v) => v.value).sort()).toEqual(['(407) 555-0110', '(407) 555-0119']);
    // The address still agrees — one bad field does not poison the other.
    expect(s.address.verdict).toBe('agreed');
    await mockEngine.pool.query("DELETE FROM receipts WHERE id = 'rc_a7'", []);
  });
});

describe('the tenant boundary, on two arms with two different models', () => {
  test('a foreign org sees nothing of org A', async () => {
    const r = await call('GET', '/api/receipts/merchants', undefined, { organization_id: ORG_B, id: 999 });
    const flat = JSON.stringify(r.body);
    expect(flat).not.toContain('HOME DEPOT');
    expect(flat).not.toContain('Osceola');
    expect(flat).not.toContain('555-0119');
  });

  test('org A sees nothing of the foreign org — neither the marker nor its numbers', async () => {
    const r = await call('GET', '/api/receipts/merchants');
    const scan = TWO.scanAnswer(r.body);
    expect(scan.marked).toBe(false);
    expect(scan.poisoned).toEqual([]);
  });

  test('a QB line whose org CACHE says org A but whose JOB is org B stays out', async () => {
    // The behavioural half of the predicate claim. `WHERE q.organization_id`
    // would return this row — its cache says org A — and the marker would land
    // in org A's answer. Only the join through jobs excludes it.
    const r = await call('GET', '/api/receipts/merchants');
    expect(JSON.stringify(r.body)).not.toContain('Stale Cache Supply');
    expect(TWO.scanAnswer(r.body).poisoned).toEqual([]);
  });

  test('the QB arm is scoped THROUGH THE JOB, not on its own organization_id', () => {
    // qb_cost_lines.organization_id is a denormalised cache; the anchor is the
    // parent job (org-table-classification.js:87). Scoping on the cache because
    // it is right there is the cross-tenant read a one-org production can never
    // surface, so the SHAPE of the statement is pinned, not just its output.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'routes', 'receipt-routes.js'), 'utf8').replace(/\r\n?/g, '\n');
    const route = src.slice(src.indexOf("router.get('/merchants'"));
    const arm = route.slice(route.indexOf('FROM qb_cost_lines'), route.indexOf('const map'));
    expect(arm).toMatch(/LEFT JOIN jobs j ON j\.id = q\.job_id/);
    expect(arm).toMatch(/j\.organization_id = \$1/);
    expect(arm).not.toMatch(/q\.organization_id\s*=/);
  });

  test('it is gated on FINANCIALS_VIEW, not on the file\'s requireAuth habit', async () => {
    // Everything else on this router rides on requireAuth alone. This route
    // folds in QuickBooks spend, which qb-cost-routes gates on FINANCIALS_VIEW
    // — a capability that deliberately excludes roles allowed to photograph a
    // receipt. Inheriting the file's habit would have exposed the ledger.
    const r = await call('GET', '/api/receipts/merchants', undefined, { role: 'field' });
    expect(r.status).toBe(403);
  });
});

describe('capturing a store changes no existing money', () => {
  test('a new capture adds its own row and touches no other', async () => {
    const before = snapshotReceipts();
    const created = await call('POST', '/api/receipts', {
      entity_type: 'job', entity_id: 'jobs-A-0', amount: 77.77, cost_code: 'materials',
      vendor: 'HOME DEPOT #0242', purchased_at: '2026-09-01',
      store_number: '#0242', store_name: 'THE HOME DEPOT',
      store_address: '1120 W Osceola Pkwy, Kissimmee FL 34741', store_phone: '407-555-0119',
    });
    expect(created.status).toBe(200);
    const id = created.body.receipt.id;
    // Normalized on the way in, by the shared validators.
    expect(created.body.receipt).toMatchObject({
      store_number: '0242', store_phone: '(407) 555-0119', store_name: 'THE HOME DEPOT',
    });
    // Every row that existed before is still exactly what it was.
    const after = snapshotReceipts().split('\n').filter((l) => !l.includes('"' + id + '"')).join('\n');
    expect(after).toBe(before);
    await mockEngine.pool.query('DELETE FROM receipts WHERE id = $1', [id]);
  });

  test('the photo-attach PATCH does not blank the store it just captured', async () => {
    // THE TRAP THIS TABLE IS SHAPED FOR. js/cost-inbox.js saves the receipt,
    // uploads the photo, then PATCHes with attachment_id ALONE. A column in the
    // SET list without the preserve idiom is nulled by that second call, moments
    // after the first captured it.
    const created = await call('POST', '/api/receipts', {
      entity_type: 'job', entity_id: 'jobs-A-0', amount: 12.34, cost_code: 'materials',
      vendor: 'WHITE CAP', store_number: '77', store_name: 'WHITE CAP',
      store_address: '900 Industrial Blvd, Orlando FL', store_phone: '(321) 555-7788',
    });
    const id = created.body.receipt.id;
    const patched = await call('PATCH', '/api/receipts/' + id, { attachment_id: 'att_new' });
    expect(patched.status).toBe(200);
    expect(patched.body.receipt).toMatchObject({
      attachment_id: 'att_new',
      store_number: '77', store_name: 'WHITE CAP',
      store_address: '900 Industrial Blvd, Orlando FL', store_phone: '(321) 555-7788',
      // and the money is untouched too
      amount: 12.34, cost_code: 'materials', entity_type: 'job', entity_id: 'jobs-A-0',
    });
    // Void, the other one-field PATCH the UI issues.
    const voided = await call('PATCH', '/api/receipts/' + id, { status: 'void' });
    expect(voided.body.receipt).toMatchObject({ status: 'void', store_phone: '(321) 555-7788' });
    await mockEngine.pool.query('DELETE FROM receipts WHERE id = $1', [id]);
  });

  test('the job-cost rollup returns exactly what it returned before', async () => {
    const before = (await call('GET', '/api/receipts/rollup?entity_type=job&entity_id=jobs-A-0')).body;
    await call('GET', '/api/receipts/merchants');
    const after = (await call('GET', '/api/receipts/rollup?entity_type=job&entity_id=jobs-A-0')).body;
    expect(after).toEqual(before);
    // and it is not vacuously equal — the rollup has real money in it
    expect(JSON.stringify(before)).toMatch(/\d/);
  });

  test('a store field the server would refuse never lands in the row', async () => {
    const created = await call('POST', '/api/receipts', {
      entity_type: 'job', entity_id: 'jobs-A-0', amount: 1, cost_code: 'materials',
      vendor: 'ABC SUPPLY',
      store_phone: '911-555-0119',                     // N11 area code
      store_address: 'Bill To: AGX, 5 Main St',        // the buyer's address
      store_number: '4075550119',                      // a phone, not a branch
    });
    expect(created.body.receipt).toMatchObject({
      store_phone: null, store_address: null, store_number: null,
    });
    await mockEngine.pool.query('DELETE FROM receipts WHERE id = $1', [created.body.receipt.id]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SCREEN. js/cost-inbox.js is DOM-bound top-level script with no export
 * seam, so these are SOURCE checks and that limit is worth naming: they pin
 * that the never-blank sentence and the dialability gate EXIST, not that they
 * render. The runtime half of the dialability property is proved above,
 * server-side, where the flag is actually computed.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the screen never renders an empty store block', () => {
  const CI = fs.readFileSync(path.join(__dirname, '..', 'js', 'cost-inbox.js'), 'utf8')
    .replace(/\r\n?/g, '\n');
  const block = CI.slice(CI.indexOf("function storeReadBlock("), CI.indexOf("function openReceiptViewer("));

  test('a receipt with nothing read says so in words', () => {
    expect(block).toContain('No store details were read from this receipt');
    // The no-details branch RETURNS — it cannot fall through to four blank rows.
    const none = block.slice(block.indexOf('if (!any)'), block.indexOf('function line('));
    expect(none).toMatch(/return/);
  });

  test('each missing field names itself rather than rendering blank', () => {
    expect(block).toContain("'no address captured'");
    expect(block).toContain("'no phone captured'");
    expect(block).toContain("'not read'");
    // The renderer has no path that emits an empty value span.
    expect(block).toMatch(/value\s*\n?\s*\?/);
  });

  test('the block says out loud that nobody has confirmed any of it', () => {
    expect(block).toContain('unconfirmed');
  });

  test('there is exactly ONE store renderer, used by the form and the viewer', () => {
    // Two renderers is two definitions of "we could not read that", and they
    // drift.
    expect((CI.match(/function storeReadBlock\(/g) || []).length).toBe(1);
    expect((CI.match(/storeReadBlock\(/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the screen makes a phone a link only when the server says so', () => {
  const CI = fs.readFileSync(path.join(__dirname, '..', 'js', 'cost-inbox.js'), 'utf8')
    .replace(/\r\n?/g, '\n');

  test('every tel: href in the file is inside the dialable branch', () => {
    const tels = [...CI.matchAll(/href=\"tel:/g)].map((m) => m.index);
    expect(tels.length).toBe(1);
    const fn = CI.slice(CI.indexOf('function phoneLine('), CI.indexOf('function merchantCard('));
    expect(fn).toContain('if (p.dialable)');
    expect(fn.indexOf(String.fromCharCode(104,114,101,102,61,34,116,101,108,58))).toBeGreaterThan(fn.indexOf('if (p.dialable)'));
  });

  test('the client never recomputes dialability from the verdict itself', () => {
    // Reading `dialable` is the contract. Re-deriving it here would mean two
    // definitions of "verified", and the client's would win on screen.
    const fn = CI.slice(CI.indexOf('function phoneLine('), CI.indexOf('function merchantCard('));
    expect(fn).not.toMatch(/verdict\s*===\s*'agreed'/);
  });

  test('an unverified value is marked visually, not only in words', () => {
    expect(CI).toContain('ci-unverified');
    const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');
    expect(css).toMatch(/\.ci-unverified\s*\{[^}]*dashed/);
  });
});
