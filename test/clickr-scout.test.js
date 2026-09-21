// CLICKR DATASET SCOUT — THE GATES, THE DATASET ID, THE DISCLOSURE RULE AND
// THE NO-WRITE CLAIM, EACH EXECUTED.
//
// The disclosure rule is the reason this tool is allowed to exist, so it is
// tested from both ends: a low-cardinality key must be NAMED (otherwise the
// tool answers nothing), and a key that fails any one of the four conditions
// must not surface a single value — proved by searching the whole response body
// for every distinct string the fixture actually holds, not by reading the
// module's own `withheld` field back to itself.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames } = require('./helpers/db-schema');
const { proveOrgOnly } = require('./helpers/org-only');

const ALL_TABLES = tableNames();
const engine = createPgSqlite(
  sqliteSchema(ALL_TABLES, { pk: { organizations: 'id', users: 'id', roles: 'name' } }),
  { jsonColumns: ['data'] }
);
globalThis.__P86_CLICKR_SCOUT_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLICKR_SCOUT_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const scout = require('../server/services/clickr/scout');
const { DATASETS } = require('../server/services/clickr/field-map');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const orgRoutes = require('../server/routes/admin-organizations-routes');

const { summarize, RULE } = scout;

// ══════════════════════════════════════════════════════════════════════════
// FIXTURES — one record shape per branch of the rule
// ══════════════════════════════════════════════════════════════════════════

const BASE = 'https://api.clickr.cloud';
const KEY = 'clickr_live_scoutkey_0123456789abcdef';

// AN UNDECLARED DATASET — the question this tool was built for, and the whole
// point of the assertions below is that field-map.js does NOT know it.
//
// This used to be the REAL Tasks dataset id (6aa5da9184f8135cf0cc6327), because
// at the time that dataset was declared nowhere. The scout was then pointed at
// it, measured all 578 records, and the measurement is what DATASETS.tasks was
// written from — so the id stopped being undeclared and this fixture stopped
// being about the thing it names. Holding it as a literal here would have made
// this suite go red every time the tool did its job, which is the wrong
// incentive: the fixture is now a made-up id, and the DECLARED side of the same
// rule is covered by DS_DECLARED below.
const DS_MAIN = 'dd11ee22ff334455aabbccdd';
const DS_SMALL = 'aa11bb22cc33dd44ee55ff66';
const DS_PARTIAL = 'bb11cc22dd33ee44ff556677';
const DS_DECLARED = DATASETS.jobs.datasetId;
const DS_LEAK = 'cc11dd22ee33ff445566aabb';

// A key short enough and plain enough to pass the disclosure rule on its own
// (20 characters, no digits, no "@"): the ONLY thing standing between it and
// the response is the key check the preview already owns.
const LEAK_KEY = 'clickrscoutkeyabcdef';
const LEAK_RECS = Array.from({ length: 8 }, () => ({ status: 'Open', apiToken: LEAK_KEY }));

// 200 records. Each key exercises exactly one outcome of the rule.
function mainRec(i) {
  return {
    _id: 'rec' + i,
    // NAMED: two short values, 200 records.
    status: i % 5 === 0 ? 'Not Started' : 'Completed',
    isCompleted: i % 5 !== 0,                                   // NAMED: boolean
    markupType: String((i % 3) + 1),                            // NAMED: numeric code as text
    priority: i % 4,                                            // NAMED: small number
    // WITHHELD — cardinality: 200 distinct (also long, but the count refuses it first).
    title: 'ZZTITLE' + i + ' Replace the north elevation handrail',
    // WITHHELD — cardinality ONLY: 30 distinct SHORT values, 200 records, so
    // every other condition passes. This is the key that goes red if the
    // distinct cap is raised.
    code: 'ZZCODE' + String(i % 30).padStart(2, '0'),
    // WITHHELD — contact: 2 distinct, short, but an address.
    owner: 'zzowner' + (i % 2) + '@example.test',
    // WITHHELD — length: 3 distinct, well over the character limit.
    longFew: 'ZZLONGVALUE' + (i % 3) + '-abcdefghijklmnopqrstuvwxyz',
    // WITHHELD — digits: 3 distinct, short, but eight digits (a date).
    dueDate: '2026-09-0' + ((i % 3) + 1),
    // WITHHELD — shape: an object. `amount` is also high-cardinality;
    // `sizeFew` holds THREE distinct objects, so only the scalar condition
    // stands between it and the response.
    amount: { value: 1000 + i, scale: 2 },
    sizeFew: { w: i % 3, h: 1 },
    blank: '',                                                  // carried, never filled
  };
}
const MAIN = Array.from({ length: 200 }, (_, i) => mainRec(i));

// 10 records: the identifier condition is the ONLY one that refuses `ident`.
const SMALL = Array.from({ length: 10 }, (_, i) => ({
  status: i < 4 ? 'Open' : 'Completed',
  ident: 'ZZIDENT' + i,
}));

const PARTIAL = Array.from({ length: 5 }, (_, i) => ({ status: 'Completed', n: i }));
const DECLARED_RECS = [
  { _id: 'j1', jobId: 51000001, jobName: 'S1050 Harbor Club Railings', jobStatus: 'Open' },
  { _id: 'j2', jobId: 51000002, jobName: 'WO16 Service Call', jobStatus: 'Open' },
];

const distinctOf = (rows, key) => [...new Set(rows.map((r) => r[key]).filter((v) => typeof v === 'string'))];

let fetchCalls = [];
const origFetch = global.fetch;

function clickrFetch(url, opts) {
  const u = new URL(url);
  fetchCalls.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization });
  if (u.origin !== BASE) throw new Error('test: fetch reached a non-Clickr host');
  const respond = (status, obj) => Promise.resolve({ status, text: async () => JSON.stringify(obj) });
  const skip = Number(u.searchParams.get('skip') || 0);
  const limit = Number(u.searchParams.get('limit') || 200);
  const page = (rows, count) => respond(200, {
    recordType: 'scout', columns: [], records: rows.slice(skip, skip + limit),
    count: count == null ? rows.length : count, sort: {},
  });
  if (u.pathname.includes(DS_MAIN)) return page(MAIN);
  if (u.pathname.includes(DS_SMALL)) return page(SMALL);
  if (u.pathname.includes(DS_PARTIAL)) return page(PARTIAL, 99);
  if (u.pathname.includes(DS_DECLARED)) return page(DECLARED_RECS);
  if (u.pathname.includes(DS_LEAK)) return page(LEAK_RECS);
  return respond(404, { error: 'Route not found' });
}

// ══════════════════════════════════════════════════════════════════════════
// THE DISCLOSURE RULE, EXECUTED DIRECTLY
// ══════════════════════════════════════════════════════════════════════════

const byKey = (s, k) => s.fields.find((f) => f.key === k);

describe('RULE — a key is named only when all four conditions hold', () => {
  const s = summarize(MAIN);

  test('a low-cardinality key is named, and its counts sum to nonEmpty', () => {
    const f = byKey(s, 'status');
    expect(f.distinctCount).toBe(2);
    expect(f.withheld).toBeNull();
    expect(f.values).toEqual([{ value: 'Completed', count: 160 }, { value: 'Not Started', count: 40 }]);
    expect(f.values.reduce((n, v) => n + v.count, 0)).toBe(f.nonEmpty);
    expect(f.nonEmpty).toBe(200);
    expect(f.carriedBy).toBe(200);
  });

  test('booleans and numeric codes are named — 0 and false are values, not blanks', () => {
    const b = byKey(s, 'isCompleted');
    expect(b.distinctCount).toBe(2);
    expect(b.nonEmpty).toBe(200);
    expect(b.values.reduce((n, v) => n + v.count, 0)).toBe(200);
    expect(b.values.map((v) => v.value).sort()).toEqual([false, true]);
    expect(byKey(s, 'markupType').values.map((v) => v.value).sort()).toEqual(['1', '2', '3']);
    const p = byKey(s, 'priority');
    expect(p.values.map((v) => v.value).sort()).toEqual([0, 1, 2, 3]);
    expect(p.values.reduce((n, v) => n + v.count, 0)).toBe(200);
  });

  test('CARDINALITY: 30 short distinct values are counted and not named', () => {
    const f = byKey(s, 'code');
    expect(f.distinctCount).toBe(30);
    expect(f.withheldRule).toBe('cardinality');
    expect(f.values).toBeNull();
    expect(f.withheld).toContain('30 distinct values');
  });

  test('LENGTH: three distinct values, all too long, are still withheld', () => {
    const f = byKey(s, 'longFew');
    expect(f.distinctCount).toBe(3);
    expect(f.withheldRule).toBe('length');
    expect(f.values).toBeNull();
  });

  test('DIGITS: a short, low-cardinality date is withheld', () => {
    const f = byKey(s, 'dueDate');
    expect(f.distinctCount).toBe(3);
    expect(f.withheldRule).toBe('digits');
    expect(f.values).toBeNull();
  });

  test('CONTACT: two short values carrying "@" are withheld', () => {
    const f = byKey(s, 'owner');
    expect(f.distinctCount).toBe(2);
    expect(f.withheldRule).toBe('contact');
    expect(f.values).toBeNull();
  });

  test('SHAPE: objects are counted and never named, even three of them', () => {
    const f = byKey(s, 'amount');
    expect(f.distinctCount).toBe(200);
    expect(f.values).toBeNull();
    const few = byKey(s, 'sizeFew');
    expect(few.distinctCount).toBe(3);
    expect(few.withheldRule).toBe('shape');
    expect(few.values).toBeNull();
    expect(JSON.stringify(s)).not.toContain('"w"');
  });

  test('IDENTIFIER: ten distinct short values over ten records is a label, not an enum', () => {
    const t = summarize(SMALL);
    const f = byKey(t, 'ident');
    expect(f.distinctCount).toBe(10);
    expect(f.withheldRule).toBe('identifier');
    expect(f.values).toBeNull();
    expect(f.withheld).toContain('10 records');
    // The same dataset still answers the question it was opened for.
    expect(byKey(t, 'status').values).toEqual([{ value: 'Completed', count: 6 }, { value: 'Open', count: 4 }]);
  });

  // The shape this rule exists for, and the one it originally missed: a key
  // carried by a SMALL SLICE of a large dataset. 12 distinct values clears the
  // cardinality cap, and 12 x 4 = 48 clears 578 records — so measured against
  // the dataset a crew list is named in full. Measured against its own 12 rows
  // it is refused. This is the Buildertrend Tasks dataset's 'Assigned users'.
  test('IDENTIFIER: a sparse key is judged against the rows that carry it, not the dataset', () => {
    const CREW = ['Ana Ruiz', 'Bo Childs', 'Cal Reyes', 'Dee Park', 'Eli Vance', 'Fay Monk',
      'Gus Pratt', 'Hal Ober', 'Ivy Sands', 'Jo Lark', 'Kit Nunn', 'Lou Adair'];
    const recs = Array.from({ length: 578 }, (_, i) => (
      i < CREW.length ? { status: 'Completed', assignedTo: CREW[i] } : { status: 'Completed' }
    ));
    const t = summarize(recs);
    const f = byKey(t, 'assignedTo');
    expect([f.carriedBy, f.nonEmpty, f.distinctCount]).toEqual([12, 12, 12]);
    expect(f.withheldRule).toBe('identifier');
    expect(f.values).toBeNull();
    // Not one of them reaches the wire, by whole-body search.
    const body = JSON.stringify(t);
    for (const name of CREW) expect(body).not.toContain(name);
    // And the sentence names the denominator the code actually divided by.
    expect(f.withheld).toContain('12 records that carry this key');
    expect(f.withheld).not.toContain('578');
    // NOT VACUOUS: the dense key on the very same records is still named, so
    // this is the rule discriminating, not the whole dataset being withheld.
    expect(byKey(t, 'status').values).toEqual([{ value: 'Completed', count: 578 }]);
  });

  test('a key that is carried but never filled reports nonEmpty 0 and an empty histogram', () => {
    const f = byKey(s, 'blank');
    expect([f.carriedBy, f.nonEmpty, f.distinctCount]).toEqual([200, 0, 0]);
    expect(f.values).toEqual([]);
  });

  test('a withheld key never carries a sample value, at any depth of the response', () => {
    const text = JSON.stringify(s);
    for (const v of distinctOf(MAIN, 'code')) expect(text).not.toContain(v);
    for (const v of distinctOf(MAIN, 'longFew')) expect(text).not.toContain(v);
    for (const v of distinctOf(MAIN, 'dueDate')) expect(text).not.toContain(v);
    for (const v of distinctOf(MAIN, 'owner')) expect(text).not.toContain(v);
    expect(text).not.toContain('scale');
  });

  test('non-object records are counted, not summarised', () => {
    const t = summarize([{ a: 'x' }, null, 7, 'text', [1, 2]]);
    expect(t.notObjects).toBe(4);
    expect(t.recordCount).toBe(5);
  });

  test('a three-record dataset names nothing: no key can average four records per value', () => {
    const t = summarize([{ s: 'Open' }, { s: 'Open' }, { s: 'Shut' }]);
    expect(byKey(t, 's').withheldRule).toBe('identifier');
  });
});

describe('RULE — the response is capped', () => {
  test('a record with 500 keys reports 200 of them and says so', () => {
    const wide = {};
    for (let k = 0; k < 500; k++) wide['k' + String(k).padStart(3, '0')] = 'Open';
    const t = summarize(Array.from({ length: 30 }, () => Object.assign({}, wide)));
    expect(t.keysTotal).toBe(500);
    expect(t.keysReported).toBe(scout.MAX_KEYS);
    expect(t.fields).toHaveLength(scout.MAX_KEYS);
  });

  test('a pathological dataset cannot answer megabytes', async () => {
    const wide = {};
    for (let k = 0; k < 500; k++) wide['key_' + String(k).padStart(3, '0') + '_'.repeat(1000)] = 'Open';
    const rows = Array.from({ length: 40 }, () => Object.assign({}, wide));
    const body = await scout.scoutDataset(DS_SMALL, {
      env: { CLICKR_API_KEY: KEY },
      transport: async () => ({ status: 200, text: JSON.stringify({ records: rows, count: rows.length }) }),
    });
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(scout.MAX_BODY_BYTES);
    expect(body.truncated).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// HTTP — the real router, the real middleware, a real SQL engine
// ══════════════════════════════════════════════════════════════════════════

const AGX = 1;
const OTHER = 2;
let server;
let baseUrl;

function seed() {
  engine.db.exec(`
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ROLES_MANAGE","USERS_MANAGE","JOBS_VIEW_ALL"]'),
      ('pm', 'PM', '["JOBS_VIEW_ALL","LEADS_VIEW"]'),
      ('system_admin', 'System Admin', '["ROLES_MANAGE","USERS_MANAGE","SYSTEM_ADMIN"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'admin@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (11, 'pm@agx.test', 'x', 'Pat PM', 'pm', 1, 1),
      (12, 'owner@p86.test', 'x', 'Platform Owner', 'system_admin', 2, 1);
  `);
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

const SCOUT = (ds) => '/api/admin/organizations/me?view=clickr-scout&dataset=' + encodeURIComponent(ds);
const ADMIN = { id: 10, email: 'admin@agx.test', name: 'Ana Ruiz', role: 'admin' };
const AGX_ADMIN = Object.assign({}, ADMIN, { organization_id: AGX });

function snapshot() {
  const out = {};
  for (const t of engine.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name)) {
    const rows = engine.db.prepare('SELECT * FROM "' + t + '" ORDER BY rowid').all();
    out[t] = { n: rows.length, h: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
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
  process.env.CLICKR_API_KEY = KEY;
  delete process.env.CLICKR_ORG_SLUG;
});

describe('HTTP — the gates', () => {
  test('VARY ONLY THE ORG: the same admin is served in the owning org and refused in another, before Clickr is called', async () => {
    const { a, b } = await proveOrgOnly({
      caller: ADMIN, orgA: AGX, orgB: OTHER,
      run: async (caller) => { fetchCalls = []; const r = await get(SCOUT(DS_MAIN), caller); r.fetches = fetchCalls.length; return r; },
    });
    expect(a.status).toBe(200);
    expect(a.json.fields.length).toBeGreaterThan(0);
    expect(b.status).toBe(403);
    expect(b.json.code).toBe('CLICKR_NOT_THIS_ORG');
    expect(b.fetches).toBe(0);
    expect(b.text).not.toContain('Completed');
  });

  test('VARY ONLY THE CAPABILITY: a PM of the owning org is refused, and nothing is fetched', async () => {
    const r = await get(SCOUT(DS_MAIN), Object.assign({}, AGX_ADMIN, { role: 'pm', id: 11 }));
    expect(r.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(r.text).not.toContain('Completed');
  });

  test('SYSTEM_ADMIN buys nothing in another org', async () => {
    const r = await get(SCOUT(DS_MAIN), { id: 12, email: 'owner@p86.test', name: 'Platform Owner', role: 'system_admin', organization_id: OTHER });
    expect(r.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  test('CLICKR_ORG_SLUG names the owning org', async () => {
    process.env.CLICKR_ORG_SLUG = 'other';
    expect((await get(SCOUT(DS_MAIN), AGX_ADMIN)).status).toBe(403);
    expect((await get(SCOUT(DS_MAIN), Object.assign({}, ADMIN, { organization_id: OTHER }))).status).toBe(200);
  });

  test('unauthenticated: 401 from the host route, nothing fetched', async () => {
    expect((await get(SCOUT(DS_MAIN), null)).status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  test('without the view parameter /me answers exactly what it answered before', async () => {
    const r = await get('/api/admin/organizations/me', AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(['organization']);
    expect(r.json.organization.slug).toBe('agx');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('HTTP — the dataset id is a Clickr object id or it is a 400', () => {
  const BAD = [
    ['empty', ''],
    ['missing', null],
    ['too short', '6aa5da9184f8135cf0cc632'],
    ['too long', '6aa5da9184f8135cf0cc63277'],
    ['upper case', '6AA5DA9184F8135CF0CC6327'],
    ['not hex', '6aa5da9184f8135cf0cc632z'],
    ['a path', '6aa5da9184f8135cf0cc6327/../../secrets'],
    ['a url', 'https://collector.evil.example/v2/datasets/x/records'],
    ['with a space', '6aa5da9184f8135cf0cc63 7'],
    ['with a newline', '6aa5da9184f8135cf0cc6327\n'],
  ];
  for (const [why, ds] of BAD) {
    test('refused before any network call: ' + why, async () => {
      const url = ds == null
        ? '/api/admin/organizations/me?view=clickr-scout'
        : SCOUT(ds);
      const r = await get(url, AGX_ADMIN);
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('CLICKR_BAD_DATASET_ID');
      expect(fetchCalls).toHaveLength(0);
    });
  }

  test('a real id reaches exactly that dataset', async () => {
    const r = await get(SCOUT(DS_MAIN), AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const c of fetchCalls) {
      expect(c.url.startsWith(BASE + '/v2/datasets/' + DS_MAIN + '/records')).toBe(true);
      expect(c.auth).toBe('Bearer ' + KEY);
    }
  });
});

describe('HTTP — what comes back', () => {
  let body;
  beforeAll(async () => {
    process.env.CLICKR_API_KEY = KEY;
    delete process.env.CLICKR_ORG_SLUG;
    fetchCalls = [];
    const r = await get(SCOUT(DS_MAIN), AGX_ADMIN);
    expect(r.status).toBe(200);
    body = r.json;
  });

  test('custom fields are reported beside the keys, even when a dataset has none', () => {
    expect(body.customFields).toEqual(expect.objectContaining({ carriedBy: 0, nonEmpty: 0, fields: [] }));
  });

  test('the fetch reports itself complete, with the counts that settle it', () => {
    expect(body.fetch.complete).toBe(true);
    expect(body.fetch.fetched).toBe(200);
    expect(body.fetch.reportedCount).toBe(200);
    expect(body.fetch.reason).toBeNull();
    expect(body.fetch.error).toBeNull();
    expect(body.recordCount).toBe(200);
    expect(body.readOnly).toBe(true);
  });

  test('an undeclared dataset says so, and says no id key was guessed', () => {
    expect(body.dataset.id).toBe(DS_MAIN);
    expect(body.dataset.declaredAs).toBeNull();
    expect(body.fetch.idKey).toBeNull();
    expect(body.fetch.idKeyNote).toMatch(/not declared in field-map\.js/);
    expect(body.declared).toBeUndefined();
  });

  test('the low-cardinality answer survives the whole route', () => {
    const f = byKey(body, 'status');
    expect(f.values).toEqual([{ value: 'Completed', count: 160 }, { value: 'Not Started', count: 40 }]);
    expect(f.values.reduce((n, v) => n + v.count, 0)).toBe(f.nonEmpty);
    expect(byKey(body, 'isCompleted').values.reduce((n, v) => n + v.count, 0)).toBe(200);
  });

  test('THE SAFETY RULE: no withheld key\'s values appear anywhere in the response', () => {
    for (const key of ['title', 'code', 'longFew', 'dueDate', 'owner', 'amount']) {
      const f = byKey(body, key);
      expect(f.values).toBeNull();
      expect(f.distinctCount).toBeGreaterThan(0);
    }
    expect(byKey(body, 'title').distinctCount).toBe(200);
    expect(byKey(body, 'code').distinctCount).toBe(30);
    for (const key of ['title', 'code', 'longFew', 'dueDate', 'owner']) {
      const values = distinctOf(MAIN, key);
      expect(values.length).toBeGreaterThan(1);
      for (const v of values) expect(JSON.stringify(body)).not.toContain(v);
    }
    expect(JSON.stringify(body)).not.toContain('scale');
  });

  test('the thresholds are published with the answer', () => {
    expect(body.disclosure).toMatchObject({
      maxDistinct: RULE.maxDistinct, recordsPerDistinct: RULE.recordsPerDistinct,
      maxValueChars: RULE.maxValueChars, maxDigits: RULE.maxDigits,
    });
  });

  test('a small dataset withholds a per-record label and still answers the enum', async () => {
    const r = await get(SCOUT(DS_SMALL), AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(byKey(r.json, 'ident').values).toBeNull();
    expect(byKey(r.json, 'ident').withheldRule).toBe('identifier');
    for (const v of distinctOf(SMALL, 'ident')) expect(r.text).not.toContain(v);
    expect(byKey(r.json, 'status').values).toEqual([{ value: 'Completed', count: 6 }, { value: 'Open', count: 4 }]);
  });

  test('a partial read is reported as partial, and still summarises what arrived', async () => {
    const r = await get(SCOUT(DS_PARTIAL), AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(r.json.fetch.complete).toBe(false);
    expect(r.json.fetch.reason).toContain('99');
    expect(r.json.fetch.fetched).toBe(5);
    expect(r.json.recordCount).toBe(5);
  });

  test('a DECLARED dataset is scouted with its own id key and carries the mapping diagnostic', async () => {
    const r = await get(SCOUT(DS_DECLARED), AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(r.json.dataset.declaredAs).toBe('jobs');
    expect(r.json.fetch.idKey).toBe('jobId');
    expect(r.json.declared.requiredKey).toBe('jobName');
    expect(r.json.declared.missingKeys).toContain('contractPrice');
  });

  test('the response is not cacheable', async () => {
    const r = await new Promise((resolve, reject) => {
      const req = http.request(baseUrl + SCOUT(DS_SMALL), { method: 'GET', headers: { Authorization: 'Bearer ' + signToken(AGX_ADMIN) } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers));
      });
      req.on('error', reject);
      req.end();
    });
    expect(r['cache-control']).toBe('no-store');
  });
});

describe('HTTP — the key never leaves the server', () => {
  test('an ordinary answer does not carry the key', async () => {
    const r = await get(SCOUT(DS_MAIN), AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(KEY);
  });

  test('a dataset that stores the key would be NAMED by the disclosure rule, and is withheld instead', async () => {
    process.env.CLICKR_API_KEY = LEAK_KEY;
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The rule alone would name it: 1 distinct value, 8 records, 20 plain characters.
      expect(byKey(summarize(LEAK_RECS), 'apiToken').values).toEqual([{ value: LEAK_KEY, count: 8 }]);
      const r = await get(SCOUT(DS_LEAK), AGX_ADMIN);
      expect(r.status).toBe(500);
      expect(r.json.error).toContain('withheld');
      expect(r.text).not.toContain(LEAK_KEY);
    } finally {
      quiet.mockRestore();
      process.env.CLICKR_API_KEY = KEY;
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// IT WRITES NOTHING — executed, then structurally
// ══════════════════════════════════════════════════════════════════════════

describe('NO WRITES', () => {
  test('every table is byte-identical before and after a scout, and no statement but SELECT runs', async () => {
    await get('/api/admin/organizations/me', AGX_ADMIN);   // absorb requireAuth's last_seen_at bump
    const before = snapshot();
    expect(Object.keys(before).length).toBe(ALL_TABLES.length);
    const logStart = engine.log.length;
    const r = await get(SCOUT(DS_MAIN), AGX_ADMIN);
    expect(r.status).toBe(200);
    expect(byKey(r.json, 'status').values).toHaveLength(2);
    const after = snapshot();
    expect(after).toEqual(before);
    const stmts = engine.log.slice(logStart);
    expect(stmts.filter((s) => !s.ok)).toEqual([]);
    expect(stmts.filter((s) => !/^\s*SELECT\b/i.test(s.sql))).toEqual([]);
  });

  const SRC_PATH = path.join(__dirname, '..', 'server', 'services', 'clickr', 'scout.js');
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  // Comments are removed first so a sentence ABOUT a write cannot pass for one,
  // and a write cannot hide behind one.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  const hasWrite = (s) => /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)/i.test(s);

  test('the detector is not vacuous: it sees a write and ignores a comment about one', () => {
    expect(hasWrite(strip('// INSERT INTO jobs (a) VALUES (1)\r\nconst a = 1;'))).toBe(false);
    expect(hasWrite(strip('/* DELETE FROM jobs */\r\nconst a = 1;'))).toBe(false);
    expect(hasWrite(strip("await pool.query('INSERT INTO jobs (a) VALUES ($1)', [1]);"))).toBe(true);
    expect(hasWrite(strip("await pool.query('UPDATE jobs SET a = 1');"))).toBe(true);
  });

  test('the module holds no write statement at all', () => {
    expect(src.length).toBeGreaterThan(4000);
    expect(src).toContain('fetchDataset');
    expect(hasWrite(strip(src))).toBe(false);
  });

  test('the module requires nothing that could reach the database', () => {
    const requires = [...strip(src).matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort();
    expect(requires).toEqual(['./client', './field-map', './sync-preview', 'crypto']);
  });

  test('the route hands it no pool', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'admin-organizations-routes.js'), 'utf8');
    expect(route).toContain("return require('../services/clickr/scout').handle(req, res, {});");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// CUSTOM FIELDS — the columns Buildertrend's own admins added. The list is
// withheld whole by rule 3; this opens it into label -> value and puts every
// value back through the same four rules. A label is a column name, shown
// only when it reads like one.
// ══════════════════════════════════════════════════════════════════════════
describe('CUSTOM FIELDS — labels are named, values keep the rule', () => {
  const cfRec = (i) => ({
    _id: 'cf' + i,
    customFields: [
      { label: 'Market', value: i % 2 ? 'Tampa' : 'Orlando', type: 'dropdown' },
      // Per-record: every value different. Named label, WITHHELD values.
      { label: 'Gate Code', value: 'ZZGATE' + i, type: 'text' },
      // Filled on none of them: a field defined and never used.
      { label: 'Community Name', value: '', type: 'text' },
      // A contact value under a column-name label: the value rule refuses it.
      { label: 'CM Email', value: 'zzcm' + (i % 2) + '@example.test', type: 'text' },
    ].concat(i < 2 ? [{ label: 'ZZSPARSE Person Name', value: 'x', type: 'text' }] : [])
     .concat(i === 0 ? [{ label: 'zzlabel@example.test', value: 'y' }, 'not-an-object', { value: 'no label' }] : []),
  });
  const RECS = Array.from({ length: 20 }, (_, i) => cfRec(i)).concat([{ _id: 'none' }, { _id: 'empty', customFields: [] }]);
  const out = scout.summarizeCustomFields(RECS);
  const by = (label) => out.fields.find((f) => f.label === label);

  test('counts who carries the list and who fills it', () => {
    expect([out.carriedBy, out.nonEmpty, out.shape]).toEqual([21, 20, 'list']);
  });

  test('a low-cardinality value under a label is named, like any enum key', () => {
    expect(by('Market').values).toEqual([{ value: 'Orlando', count: 10 }, { value: 'Tampa', count: 10 }]);
  });

  test('a per-record value is counted, never named — the label still is', () => {
    expect(by('Gate Code').values).toBeNull();
    expect(by('Gate Code').withheldRule).toBe('cardinality');
    expect(JSON.stringify(out)).not.toMatch(/ZZGATE/);
  });

  test('a value the rule refuses stays refused inside the list', () => {
    expect(by('CM Email').values).toBeNull();
    expect(by('CM Email').withheldRule).toBe('contact');
    expect(JSON.stringify(out)).not.toMatch(/zzcm/);
  });

  test('a defined-but-empty field is reported as carried and unfilled', () => {
    expect([by('Community Name').carriedBy, by('Community Name').nonEmpty]).toEqual([20, 0]);
  });

  test('a label on too few records, or one that is contact data, is counted and never named', () => {
    expect(by('ZZSPARSE Person Name')).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/ZZSPARSE|zzlabel/);
    expect(out.labelsWithheld).toBe(2);
    expect(out.labelsWithheldNote).toMatch(/^2 labels were not shown/);
  });

  test('the SHAPE is reported, so a wrong guess about it shows up on the first read', () => {
    expect(out.elementKeys.map((k) => k.key)).toEqual(['value', 'label', 'type']);
    expect(out.unlabelled).toBe(2);   // the string, and the entry with no label
  });

  test('each label rule refuses on its OWN — a common label is still withheld when it is contact data, a link, free text or a number', () => {
    // Carried by every record, so the sparse rule has nothing to say: only
    // the label's own text can withhold it.
    const bad = ['zzowner@example.test', 'see https://zz.example', 'ZZLONG ' + 'x'.repeat(70), 'ZZLINE\nbreak', 'Call 8135550100'];
    const recs = Array.from({ length: 10 }, () => ({ customFields: bad.map((label) => ({ label, value: 'Yes' })).concat([{ label: 'Market', value: 'Tampa' }]) }));
    const o = scout.summarizeCustomFields(recs);
    expect(o.fields.map((f) => f.label)).toEqual(['Market']);
    expect(o.labelsWithheld).toBe(bad.length);
    expect(JSON.stringify(o)).not.toMatch(/zzowner|zz\.example|ZZLONG|ZZLINE|8135550100/);
  });

  test('a DROPDOWN value (an object) is opened one level, and each part keeps the rule', () => {
    const recs = Array.from({ length: 12 }, (_, i) => ({ customFields: [
      { label: 'Market', value: { id: 900100 + (i % 3), name: ['Tampa', 'Orlando', 'Denver'][i % 3] } },
      // A one-object list is that object.
      { label: 'Region', value: [{ name: i % 2 ? 'North' : 'South' }] },
      // Several objects (a multi-select) stay whole.
      { label: 'Trades', value: [{ name: 'Paint' }, { name: 'Roof' + (i % 2) }] },
      // An empty object is an unfilled field, not a value.
      { label: 'Blank Pick', value: {} },
    ] }));
    const o = scout.summarizeCustomFields(recs);
    const by = (label) => o.fields.find((f) => f.label === label);
    expect(by('Market › name').values).toEqual([{ value: 'Denver', count: 4 }, { value: 'Orlando', count: 4 }, { value: 'Tampa', count: 4 }]);
    expect(by('Market › id').withheldRule).toBe('digits');
    expect(by('Market')).toBeUndefined();
    expect(by('Region › name').values.map((v) => v.value)).toEqual(['North', 'South']);
    expect(by('Trades').withheldRule).toBe('shape');
    expect([by('Blank Pick').carriedBy, by('Blank Pick').nonEmpty]).toEqual([12, 0]);
    expect(JSON.stringify(o)).not.toMatch(/9001\d\d/);
  });

  test('a name-keyed object is read the same way as a list', () => {
    const o = scout.summarizeCustomFields(Array.from({ length: 8 }, (_, i) => ({ customFields: { Market: i % 2 ? 'Tampa' : 'Orlando' } })));
    expect(o.shape).toBe('object');
    expect(o.fields[0].label).toBe('Market');
    expect(o.fields[0].values.length).toBe(2);
  });

  test('a label spelled __proto__ is a label, not a way into the prototype', () => {
    const o = scout.summarizeCustomFields(Array.from({ length: 8 }, () => ({ customFields: [{ label: '__proto__', value: 'Open' }] })));
    expect(o.fields.map((f) => f.label)).toEqual(['__proto__']);
    expect(({}).value).toBeUndefined();
  });

  test('the scout response carries it, and a dataset without the list says so with zeros', () => {
    const none = scout.summarizeCustomFields(MAIN);
    expect([none.carriedBy, none.fields]).toEqual([0, []]);
  });
});
