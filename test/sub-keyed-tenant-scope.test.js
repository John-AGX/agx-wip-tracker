// The tenant boundary on sub-routes.js — both of its keys.
//
// WHAT THIS FILE EXISTS FOR
// Commit a243b76, "money rows are born inside a tenant", edited the exact
// INSERT statements this file guards. It added
// `(SELECT organization_id FROM jobs WHERE id = $2)` to the job_subs inserts
// and, in the same commit, scoped notifySubAssigned because "unscoped, an
// assignment against a foreign job id mailed that job's identity
// off-platform." The author was looking straight at the door, closed the email
// leak, and left the write open.
//
// The stamp made detection WORSE. Before it, a forged assignment landed
// organization_id NULL and the boot stamp audit could count it. After it, the
// subselect reads the org off the PARENT JOB, so a row planted by an org-A
// admin lands stamped org B and is indistinguishable from org B's own data.
// That is the N4 interaction — "stamping the INSERT removed the orphaned-NULL
// tell" — recurring one table over, inside the commit written to answer it.
//
// So the property under test is not "the row carries the right org". It is:
//
//   every statement reachable by a caller-supplied job_id OR sub_id proves
//   that key belongs to the caller's tenant BEFORE it reads or writes.
//
// A stamp says which tenant a row claims to be in. A predicate is where the
// server decides. The five named doors were the finding; auditing by DOOR
// rather than by finding found fourteen more in the same file, including a
// `UPDATE subs` that could rewrite another tenant's payment_email.

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

let queries;
let handlers;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockRunQuery(sql, params),
      release: () => {}
    })
  }
}));

jest.mock('../server/email', () => ({ sendEmail: async () => ({}), sendForEvent: async () => ({}) }));
jest.mock('../server/services/file-folders', () => ({
  ensureFolderChain: async () => ({ id: 'folder_1' })
}));

function mockRunQuery(sql, params) {
  const text = String(sql);
  queries.push({ sql: text, params: params || [] });
  for (const key of Object.keys(handlers)) {
    if (text.includes(key)) return handlers[key](text, params || []);
  }
  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const subRoutes = require('../server/routes/sub-routes');

setRolePool(require('../server/db').pool);

const SUB_ROUTES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'routes', 'sub-routes.js'), 'utf8');

let server, baseUrl;

beforeAll(async () => {
  queries = [];
  handlers = {
    'SELECT name, capabilities FROM roles': () => ({ rows: [
      { name: 'admin', capabilities: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY'] }
    ] })
  };
  await refreshRoleCache();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/subs', subRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => { queries = []; handlers = {}; });

function token(user) {
  return signToken(Object.assign(
    { id: 10, email: 'a@a.test', role: 'admin', name: 'A', organization_id: 1 }, user || {}));
}

async function call(method, url, body, user) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token(user) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

// ── the world the recording pool answers from ───────────────────────────────
// Only these ids are the caller's. Everything else is another tenant's, and
// the route can only find that out by asking.
function ownJobs(...ids) {
  handlers['WHERE id = ANY($1::text[])'] = (sql, params) =>
    ({ rows: (params[0] || []).filter((id) => ids.includes(id)).map((id) => ({ id })) });
  handlers['SELECT 1 FROM jobs\n'] = (sql, params) =>
    ({ rows: ids.includes(String(params[0])) ? [{ ok: 1 }] : [] });
}
function ownSubs(...ids) {
  handlers['SELECT 1 FROM subs\n'] = (sql, params) =>
    ({ rows: ids.includes(String(params[0])) ? [{ ok: 1 }] : [] });
}

// Any statement that CHANGES one of this file's tables. The property is never
// "the response said no" — it is "no write was reached".
const WRITE_RE =
  /\b(INSERT INTO|UPDATE|DELETE FROM)\s+(job_subs|subs|sub_certificates|attachment_folder_grants|attachments)\b/i;
function write() { return queries.find((q) => WRITE_RE.test(q.sql)); }

// Any statement that READS the payload the door exists to return.
function reads(table) {
  return queries.filter((q) =>
    new RegExp('FROM ' + table + '\\b', 'i').test(q.sql) &&
    !/j_org_scope|s_org_scope|WHERE id = ANY|SELECT 1 FROM/i.test(q.sql));
}

const OURS = 'job_ours';
const THEIRS = 'job_theirs';
const OUR_SUB = 'sub_ours';
const THEIR_SUB = 'sub_theirs';

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. The five named doors, keyed on job_id.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the job_subs family refuses a foreign job id', () => {
  beforeEach(() => { ownJobs(OURS); ownSubs(OUR_SUB); });

  test('POST /jobs/:jobId — no assignment is planted', async () => {
    const r = await call('POST', '/api/subs/jobs/' + THEIRS, { subId: OUR_SUB, contract_amt: 250000 });
    expect(r.status).toBe(404);
    expect(write()).toBeUndefined();
  });

  test('POST /jobs/:jobId — a foreign SUB on OUR job is refused too', async () => {
    // Both ends are caller-supplied. Proving only the job would still let
    // another tenant's subcontractor onto our roster.
    const r = await call('POST', '/api/subs/jobs/' + OURS, { subId: THEIR_SUB });
    expect(r.status).toBe(404);
    expect(write()).toBeUndefined();
  });

  test('PATCH /jobs/:jobId/:assignmentId — the $400,000 rewrite carries the predicate', async () => {
    const r = await call('PATCH', '/api/subs/jobs/' + THEIRS + '/jsub_1', { contract_amt: 1 });
    expect(r.status).toBe(404);
    const u = queries.find((q) => /UPDATE job_subs SET/i.test(q.sql));
    // The statement may still be emitted — it is filtered, not pre-checked —
    // but it must carry the tenant predicate and it must match nothing.
    if (u) {
      expect(u.sql).toMatch(/j_org_scope\.id = job_subs\.job_id/);
      expect(u.params).toContain(1);              // the caller's org is bound
    }
  });

  test('DELETE /jobs/:jobId/:assignmentId — the delete is filtered on the parent job', async () => {
    await call('DELETE', '/api/subs/jobs/' + THEIRS + '/jsub_1');
    const d = queries.find((q) => /DELETE FROM job_subs/i.test(q.sql));
    expect(d).toBeDefined();
    expect(d.sql).toMatch(/j_org_scope\.id = job_subs\.job_id/);
    expect(d.params[2]).toBe(1);
  });

  test('POST /migrate-apply — a foreign job is SKIPPED, exactly like an absent one', async () => {
    const r = await call('POST', '/api/subs/migrate-apply', {
      inlineSubs: [
        { name: 'Acme Drywall', jobId: THEIRS, contractAmt: 88000 },
        { name: 'Acme Drywall', jobId: 'job_absent', contractAmt: 1 }
      ]
    });
    expect(r.status).toBe(200);
    expect(r.body.assignmentsSkipped).toBe(2);
    expect(r.body.assignmentsCreated).toBe(0);
    expect(queries.some((q) => /INSERT INTO job_subs/i.test(q.sql))).toBe(false);
  });

  test('POST /migrate-apply — an in-tenant job still migrates', async () => {
    const r = await call('POST', '/api/subs/migrate-apply', {
      inlineSubs: [{ name: 'Acme Drywall', jobId: OURS, contractAmt: 88000 }]
    });
    expect(r.status).toBe(200);
    expect(r.body.assignmentsCreated).toBe(1);
  });

  test('POST /migrate-apply — the ids are resolved BEFORE BEGIN', async () => {
    await call('POST', '/api/subs/migrate-apply', {
      inlineSubs: [{ name: 'Acme', jobId: OURS }]
    });
    const scope = queries.findIndex((q) => /WHERE id = ANY\(\$1::text\[\]\)/.test(q.sql));
    const begin = queries.findIndex((q) => /^BEGIN$/i.test(q.sql.trim()));
    expect(scope).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(scope);
  });

  test('POST /:subId/job-access — the exfiltration door, with the job id in the BODY', async () => {
    // A survey of `:jobId` ROUTES could not see this one. The key is what
    // matters, not where it rides.
    const r = await call('POST', '/api/subs/' + OUR_SUB + '/job-access',
      { jobId: THEIRS, folders: ['plans/current', 'contracts'] });
    expect(r.status).toBe(404);
    expect(write()).toBeUndefined();
  });

  test('POST /:subId/job-access — an in-tenant grant still writes', async () => {
    const r = await call('POST', '/api/subs/' + OUR_SUB + '/job-access',
      { jobId: OURS, folders: ['contracts'] });
    expect(r.status).toBe(200);
    expect(queries.some((q) => /INSERT INTO attachment_folder_grants/i.test(q.sql))).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. If five were open, look for a sixth. There were fourteen.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the doors beside the five', () => {
  beforeEach(() => { ownJobs(OURS); ownSubs(OUR_SUB); });

  test('GET /jobs/:jobId — the read half: contract amounts and sub contacts', async () => {
    const r = await call('GET', '/api/subs/jobs/' + THEIRS);
    expect(r.status).toBe(404);
    expect(reads('job_subs').length).toBe(0);
  });

  test('GET /:subId/jobs — another tenant\'s job numbers and titles', async () => {
    const r = await call('GET', '/api/subs/' + THEIR_SUB + '/jobs');
    expect(r.status).toBe(404);
    expect(reads('job_subs').length).toBe(0);
  });

  test('PUT /:id — a foreign sub\'s payment_email is not rewritable', async () => {
    // subs.payment_email and payment_hold decide where a vendor gets paid, and
    // GET /:id has been org-scoped since Wave A. A scoped read next to an
    // unscoped write is not half a boundary.
    const r = await call('PUT', '/api/subs/' + THEIR_SUB, { payment_email: 'attacker@a.test' });
    expect(r.status).toBe(404);
    const u = queries.find((q) => /UPDATE subs SET/i.test(q.sql));
    expect(u.sql).toMatch(/\(organization_id = \$\d+ OR organization_id IS NULL\)/);
    expect(u.params[u.params.length - 1]).toBe(1);
  });

  test('DELETE /:id — refused before the in-use probe, which is itself a read', async () => {
    const r = await call('DELETE', '/api/subs/' + THEIR_SUB);
    expect(r.status).toBe(404);
    expect(queries.some((q) => /FROM job_subs WHERE sub_id/i.test(q.sql))).toBe(false);
    expect(write()).toBeUndefined();
  });

  test('the four certificate doors — W-9 and bank metadata', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/subs/' + THEIR_SUB + '/certificates', undefined],
      ['POST', '/api/subs/' + THEIR_SUB + '/certificates', { cert_type: 'w9' }],
      ['DELETE', '/api/subs/' + THEIR_SUB + '/certificates/w9', undefined]
    ]) {
      queries = []; ownJobs(OURS); ownSubs(OUR_SUB);
      const r = await call(method, url, body);
      expect({ url, status: r.status }).toEqual({ url, status: 404 });
      expect({ url, wrote: !!write() }).toEqual({ url, wrote: false });
    }
  });

  test('PATCH /:subId/certificates/:certType — filtered on the parent sub', async () => {
    await call('PATCH', '/api/subs/' + THEIR_SUB + '/certificates/w9', { expiration_date: '2030-01-01' });
    const u = queries.find((q) => /UPDATE sub_certificates SET/i.test(q.sql));
    expect(u).toBeDefined();
    expect(u.sql).toMatch(/s_org_scope\.id = sub_certificates\.sub_id/);
    expect(u.params[u.params.length - 1]).toBe(1);
  });

  test('the DELETE cert door refuses before it reaches the ATTACHMENTS table', async () => {
    await call('DELETE', '/api/subs/' + THEIR_SUB + '/certificates/w9');
    expect(queries.some((q) => /DELETE FROM attachments/i.test(q.sql))).toBe(false);
  });

  test('the two pre-checked attachment-grant doors', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/subs/' + THEIR_SUB + '/attachment-grants', undefined],
      ['POST', '/api/subs/' + THEIR_SUB + '/attachment-grants', { entity_type: 'job', entity_id: OURS }]
    ]) {
      queries = []; ownJobs(OURS); ownSubs(OUR_SUB);
      const r = await call(method, url, body);
      expect({ url, status: r.status }).toEqual({ url, status: 404 });
      expect({ url, wrote: !!write() }).toEqual({ url, wrote: false });
    }
  });

  test('DELETE /:subId/attachment-grants/:grantId — filtered on the parent sub', async () => {
    // Keyed on the grant's own id, so this one is FILTERED rather than
    // pre-checked, the same shape as DELETE job_subs: the statement is emitted
    // and matches nothing. A JS probe first would be a round-trip and a TOCTOU.
    const r = await call('DELETE', '/api/subs/' + THEIR_SUB + '/attachment-grants/afg_1');
    expect(r.status).toBe(404);
    const d = queries.find((q) => /DELETE FROM attachment_folder_grants/i.test(q.sql));
    expect(d.sql).toMatch(/s_org_scope\.id = attachment_folder_grants\.sub_id/);
    expect(d.params[2]).toBe(1);
  });

  test('a grant from OUR sub onto ANOTHER tenant\'s entity is refused', async () => {
    // Both ends of a grant are caller-supplied, and this door accepts five
    // entity types — broader than job-access, which only accepts jobs.
    handlers['SELECT 1 FROM leads'] = () => ({ rows: [] });
    const r = await call('POST', '/api/subs/' + OUR_SUB + '/attachment-grants',
      { entity_type: 'lead', entity_id: 'lead_theirs', folder: 'contracts' });
    expect(r.status).toBe(404);
    expect(write()).toBeUndefined();
  });

  test('an unknown entity_type can never be scoped, so it is never written', async () => {
    const r = await call('POST', '/api/subs/' + OUR_SUB + '/attachment-grants',
      { entity_type: 'organization', entity_id: '1' });
    expect(r.status).toBe(400);
    expect(write()).toBeUndefined();
  });

  test('GET /:subId/job-access/:jobId — existence of a foreign pairing', async () => {
    const r = await call('GET', '/api/subs/' + OUR_SUB + '/job-access/' + THEIRS);
    expect(r.status).toBe(404);
    expect(reads('job_subs').length).toBe(0);
  });

  test('GET /:subId/shared-attachments — a foreign sub\'s whole file view', async () => {
    const r = await call('GET', '/api/subs/' + THEIR_SUB + '/shared-attachments');
    expect(r.status).toBe(404);
    expect(reads('attachment_folder_grants').length).toBe(0);
  });

  test('POST /migrate-preview no longer probes another tenant\'s directory by name', async () => {
    await call('POST', '/api/subs/migrate-preview', { inlineSubs: [{ name: 'Acme' }] });
    const q = queries.find((x) => /lower\(name\) = ANY/i.test(x.sql));
    expect(q.sql).toMatch(/organization_id = \$2 OR organization_id IS NULL/);
    expect(q.params[1]).toBe(1);
  });

  test('migrate-apply\'s dedupe cannot ADOPT another tenant\'s directory row', async () => {
    await call('POST', '/api/subs/migrate-apply', { inlineSubs: [{ name: 'Acme', jobId: OURS }] });
    const q = queries.find((x) => /lower\(name\) = \$1/i.test(x.sql));
    expect(q.sql).toMatch(/organization_id = \$2 OR organization_id IS NULL/);
    expect(q.params[1]).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. The stamps. Where a row says which tenant it is in.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the stamps, which are not the boundary but still have to be right', () => {
  beforeEach(() => { ownJobs(OURS); ownSubs(OUR_SUB); });

  test('POST /api/subs stamps the directory row from the SERVER-resolved org', async () => {
    const r = await call('POST', '/api/subs', { name: 'New Co', organization_id: 999 });
    expect(r.status).toBe(200);
    const ins = queries.find((q) => /INSERT INTO subs \(/i.test(q.sql));
    expect(ins.sql).toMatch(/organization_id\)/);
    expect(ins.params[ins.params.length - 1]).toBe(1);   // caller's org
    expect(ins.params).not.toContain(999);               // never the body's
  });

  test('sub_certificates is stamped off the PARENT SUB, not off the caller', async () => {
    await call('POST', '/api/subs/' + OUR_SUB + '/certificates', { cert_type: 'w9' });
    const ins = queries.find((q) => /INSERT INTO sub_certificates/i.test(q.sql));
    expect(ins.sql).toMatch(/\(SELECT organization_id FROM subs WHERE id = \$2\)/);
  });

  test('migrate-apply stamps the subs it creates', async () => {
    await call('POST', '/api/subs/migrate-apply', { inlineSubs: [{ name: 'Acme', jobId: OURS }] });
    const ins = queries.find((q) => /INSERT INTO subs \(id, name, trade, organization_id\)/i.test(q.sql));
    expect(ins).toBeDefined();
    expect(ins.params[3]).toBe(1);
  });

  test('the job_subs stamp still reads the parent job — a243b76 was right about that', async () => {
    await call('POST', '/api/subs/jobs/' + OURS, { subId: OUR_SUB, contract_amt: 5 });
    const ins = queries.find((q) => /INSERT INTO job_subs/i.test(q.sql));
    expect(ins.sql).toMatch(/\(SELECT organization_id FROM jobs WHERE id = \$2\)/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. Fail closed, and stay that way as the file grows.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the file as a whole', () => {
  test('EVERY route in this file resolves a tenant before its handler runs', () => {
    // The finding named five doors out of twenty-two. This is the assertion
    // that makes "look for a sixth" permanent: a new route added without
    // requireOrgId fails here, before anyone has to notice it by hand.
    const gated = SUB_ROUTES_SRC.match(/requireCapability\([^)]*\)[^\n]*/g) || [];
    expect(gated.length).toBeGreaterThan(15);
    const ungated = gated.filter((line) => !/requireOrgId/.test(line));
    expect(ungated).toEqual([]);
  });

  test('a caller with no resolvable tenant is refused, not defaulted', async () => {
    handlers['SELECT organization_id FROM users WHERE id = $1'] = () => ({ rows: [{ organization_id: null }] });
    const r = await call('POST', '/api/subs/jobs/' + OURS, { subId: OUR_SUB }, { organization_id: null });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ORG_UNRESOLVED');
    expect(write()).toBeUndefined();
  });

  test('an unanswerable tenant is retryable, and nothing is written', async () => {
    handlers['SELECT organization_id FROM users WHERE id = $1'] = () => { throw new Error('pool down'); };
    const r = await call('POST', '/api/subs/jobs/' + OURS, { subId: OUR_SUB }, { organization_id: null });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('ORG_LOOKUP_FAILED');
    expect(write()).toBeUndefined();
  });

  test('migrate-apply refuses retryably if the scope lookup itself fails', async () => {
    handlers['WHERE id = ANY($1::text[])'] = () => { throw new Error('pool down'); };
    const r = await call('POST', '/api/subs/migrate-apply', { inlineSubs: [{ name: 'A', jobId: OURS }] });
    expect(r.status).toBe(503);
    expect(queries.some((q) => /^BEGIN$/i.test(q.sql.trim()))).toBe(false);
  });

  test('the tolerance arm is intact — a legacy NULL-org row is still reachable', () => {
    const { subInOrg } = require('../server/services/sub-org-scope');
    expect(typeof subInOrg).toBe('function');
    const SCOPE = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'sub-org-scope.js'), 'utf8');
    expect(SCOPE).toMatch(/organization_id IS NULL/);
    expect(SCOPE).not.toMatch(/req\.body/);
  });

  test('the grant entity table is a WHITELIST, never interpolated from the request', () => {
    const { ENTITY_TABLES } = require('../server/services/sub-org-scope');
    expect(Object.keys(ENTITY_TABLES).sort()).toEqual(['client', 'estimate', 'job', 'lead', 'sub']);
    const SCOPE = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'sub-org-scope.js'), 'utf8');
    // The only ${} in a query string is the looked-up table name.
    const interpolated = SCOPE.match(/\$\{[^}]+\}/g) || [];
    expect(interpolated.every((s) => /table|subIdExpr|param/.test(s))).toBe(true);
  });
});
