// Job Reports: a dead gate, and the hole it was accidentally holding shut.
//
// WHAT WAS BROKEN
// All five endpoints in report-routes.js gate on a SPACE-SEPARATED capability
// list — `requireCapability('JOBS_EDIT_ANY JOBS_EDIT_OWN')`. Two other files
// document that as the house convention ("Returning a space-separated list is
// the convention used in report-routes / qb-cost-routes"), and
// attachment-routes hand-rolled requireDynamicCapability to implement it. But
// requireCapability itself passed the whole string to hasCapability, which does
// an exact `caps.has(capKey)`. No capability is named
// "JOBS_EDIT_ANY JOBS_EDIT_OWN", so the gate returned 403 to EVERYONE —
// including a capability-complete system admin. Job Reports has been entirely
// unreachable in production.
//
// WHY THE TWO HALVES SHIP TOGETHER
// `ensureJobExists` asked `SELECT id FROM jobs WHERE id = $1` — existence, not
// ownership. The only thing keeping that from being a cross-tenant hole was
// the broken gate in front of it. Fixing the gate alone would have opened the
// hole the same day the feature came back to life. So this file asserts both
// properties at once: the gate lets an authorised caller in, AND the caller
// still cannot reach another tenant's job.

const express = require('express');
const http = require('http');

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

function mockRunQuery(sql, params) {
  const text = String(sql);
  queries.push({ sql: text, params: params || [] });
  for (const key of Object.keys(handlers)) {
    if (text.includes(key)) return handlers[key](text, params || []);
  }
  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache, requireCapability } = require('../server/auth');
const reportRoutes = require('../server/routes/report-routes');

setRolePool(require('../server/db').pool);

let server, baseUrl;

const ROLES = [
  // The two edit caps live on DIFFERENT roles on purpose: an OR gate must let
  // each of them in on its own, which is the whole point of the list form.
  { name: 'admin', capabilities: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY'] },
  { name: 'pm', capabilities: ['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'] },
  { name: 'viewer', capabilities: ['JOBS_VIEW_ALL'] },
  { name: 'nobody', capabilities: [] }
];

beforeAll(async () => {
  queries = [];
  handlers = { 'SELECT name, capabilities FROM roles': () => ({ rows: ROLES }) };
  await refreshRoleCache();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/jobs/:jobId/reports', reportRoutes);
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

const OURS = 'job_ours';
const THEIRS = 'job_theirs';

function ownJobs(...ids) {
  handlers['WHERE id = ANY($1::text[])'] = (sql, params) =>
    ({ rows: (params[0] || []).filter((id) => ids.includes(id)).map((id) => ({ id })) });
}

const WRITE_RE = /\b(INSERT INTO|UPDATE|DELETE FROM)\s+job_reports\b/i;
function write() { return queries.find((q) => WRITE_RE.test(q.sql)); }
function reportRead() {
  return queries.find((q) => /FROM job_reports r/i.test(q.sql));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. The gate itself.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('requireCapability and the space-separated list', () => {
  function run(cap, user) {
    return new Promise((resolve) => {
      const req = { user };
      const res = {
        status(code) { this._code = code; return this; },
        json(body) { resolve({ status: this._code, body }); }
      };
      requireCapability(cap)(req, res, () => resolve({ status: 200 }));
    });
  }

  test('a single capability still works — the fix cannot regress the common case', async () => {
    expect((await run('JOBS_EDIT_ANY', { role: 'admin' })).status).toBe(200);
    expect((await run('JOBS_EDIT_ANY', { role: 'viewer' })).status).toBe(403);
  });

  test('a list is OR: holding EITHER member is enough', async () => {
    expect((await run('JOBS_EDIT_ANY JOBS_EDIT_OWN', { role: 'admin' })).status).toBe(200);
    expect((await run('JOBS_EDIT_ANY JOBS_EDIT_OWN', { role: 'pm' })).status).toBe(200);
  });

  test('a list is NOT and — holding one of two is not a refusal', async () => {
    // If this were read as AND, the pm (who holds only JOBS_EDIT_OWN) would be
    // refused, and every existing single-cap gate's meaning would shift.
    const r = await run('JOBS_EDIT_ANY JOBS_EDIT_OWN', { role: 'pm' });
    expect(r.status).toBe(200);
  });

  test('holding NONE of them is still refused, and the message names the gate', async () => {
    const r = await run('JOBS_EDIT_ANY JOBS_EDIT_OWN', { role: 'viewer' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/JOBS_EDIT_ANY JOBS_EDIT_OWN/);
  });

  test('an empty or whitespace-only gate is CLOSED, never open', async () => {
    // A missing capability name must not read as "no capability required".
    expect((await run('', { role: 'admin' })).status).toBe(403);
    expect((await run('   ', { role: 'admin' })).status).toBe(403);
    expect((await run(null, { role: 'admin' })).status).toBe(403);
  });

  test('an unauthenticated caller is 401, not 403', async () => {
    expect((await run('JOBS_EDIT_ANY', null)).status).toBe(401);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Job Reports is alive again.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('Job Reports is reachable by an authorised caller', () => {
  beforeEach(() => ownJobs(OURS));

  test('the list endpoint answers 200 instead of 403', async () => {
    const r = await call('GET', '/api/jobs/' + OURS + '/reports');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.reports)).toBe(true);
  });

  test('a PM with only the OWN-tier caps gets in too', async () => {
    const r = await call('GET', '/api/jobs/' + OURS + '/reports', undefined, { role: 'pm' });
    expect(r.status).toBe(200);
  });

  test('create works, and only after the job is proved', async () => {
    const r = await call('POST', '/api/jobs/' + OURS + '/reports', { title: 'Walkthrough' });
    expect(r.status).toBe(200);
    const ins = queries.find((q) => /INSERT INTO job_reports/i.test(q.sql));
    expect(ins).toBeDefined();
    const scopeIdx = queries.findIndex((q) => /WHERE id = ANY\(\$1::text\[\]\)/.test(q.sql));
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(queries.indexOf(ins)).toBeGreaterThan(scopeIdx);
  });

  test('a caller with no job capability at all is still refused', async () => {
    const r = await call('GET', '/api/jobs/' + OURS + '/reports', undefined, { role: 'nobody' });
    expect(r.status).toBe(403);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. …and it is not reachable across tenants.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a foreign job has no reports', () => {
  beforeEach(() => ownJobs(OURS));

  test('GET / — the list is refused before job_reports is read', async () => {
    const r = await call('GET', '/api/jobs/' + THEIRS + '/reports');
    expect(r.status).toBe(404);
    expect(reportRead()).toBeUndefined();
  });

  test('GET /:reportId — the single report is refused before it is read', async () => {
    const r = await call('GET', '/api/jobs/' + THEIRS + '/reports/rpt_1');
    expect(r.status).toBe(404);
    expect(reportRead()).toBeUndefined();
  });

  test('POST / — existence is not permission', async () => {
    const r = await call('POST', '/api/jobs/' + THEIRS + '/reports', { title: 'x' });
    expect(r.status).toBe(404);
    expect(write()).toBeUndefined();
    // The old question is gone entirely.
    expect(queries.some((q) => /SELECT id FROM jobs WHERE id = \$1'?$/.test(q.sql.trim()))).toBe(false);
  });

  test('PATCH /:reportId — filtered on the parent job', async () => {
    await call('PATCH', '/api/jobs/' + THEIRS + '/reports/rpt_1', { title: 'x' });
    const u = queries.find((q) => /UPDATE job_reports SET/i.test(q.sql));
    expect(u).toBeDefined();
    expect(u.sql).toMatch(/j_org_scope\.id = job_reports\.job_id/);
    expect(u.params[u.params.length - 1]).toBe(1);
  });

  test('DELETE /:reportId — filtered on the parent job', async () => {
    await call('DELETE', '/api/jobs/' + THEIRS + '/reports/rpt_1');
    const d = queries.find((q) => /DELETE FROM job_reports/i.test(q.sql));
    expect(d).toBeDefined();
    expect(d.sql).toMatch(/j_org_scope\.id = job_reports\.job_id/);
    expect(d.params[2]).toBe(1);
  });

  test('the refusal for a foreign job is the same as for an absent one', async () => {
    const foreign = await call('GET', '/api/jobs/' + THEIRS + '/reports');
    queries = []; ownJobs(OURS);
    const absent = await call('GET', '/api/jobs/job_nonexistent/reports');
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body).toEqual(absent.body);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. The photo ids inside a report are caller-supplied data too.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('hydration cannot reach another tenant\'s attachments', () => {
  test('the attachment lookup carries the caller org', async () => {
    ownJobs(OURS);
    handlers['FROM job_reports r'] = () => ({ rows: [{
      id: 'rpt_1', job_id: OURS, title: 't', summary: '',
      sections: [{ id: 's1', label: 'Before', photo_ids: ['att_theirs'], captions: {} }]
    }] });
    const r = await call('GET', '/api/jobs/' + OURS + '/reports/rpt_1');
    expect(r.status).toBe(200);
    const a = queries.find((q) => /FROM attachments WHERE id = ANY/i.test(q.sql));
    expect(a).toBeDefined();
    expect(a.sql).toMatch(/organization_id = \$2 OR organization_id IS NULL/);
    expect(a.params[1]).toBe(1);
    // The foreign photo simply is not in the answer — same posture as a
    // deleted attachment, which this function already drops silently.
    expect(r.body.report.sections[0].photos).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. Fail closed.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an unresolvable tenant', () => {
  test('409 ORG_UNRESOLVED, and no report is written', async () => {
    ownJobs(OURS);
    handlers['SELECT organization_id FROM users WHERE id = $1'] = () => ({ rows: [{ organization_id: null }] });
    const r = await call('POST', '/api/jobs/' + OURS + '/reports', { title: 'x' }, { organization_id: null });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ORG_UNRESOLVED');
    expect(write()).toBeUndefined();
  });

  test('503 ORG_LOOKUP_FAILED is retryable and is not a permission verdict', async () => {
    ownJobs(OURS);
    handlers['SELECT organization_id FROM users WHERE id = $1'] = () => { throw new Error('pool down'); };
    const r = await call('POST', '/api/jobs/' + OURS + '/reports', { title: 'x' }, { organization_id: null });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('ORG_LOOKUP_FAILED');
    expect(write()).toBeUndefined();
  });
});
