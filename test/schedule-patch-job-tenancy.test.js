// PATCH /api/schedule/:id — A MOVE MUST PROVE THE JOB IT MOVES ONTO.
//
// THE FINDING
// POST proves the parent job is the caller's (jobInOrg, "job not found").
// PATCH wrote body.jobId straight into job_id. Its one tenant gate,
// assertEntityInOrg('schedule_entry'), looks at the entry's CURRENT job, and
// job_id is a plain foreign key that any tenant's job satisfies. So an org-A
// scheduler PATCHing their own entry with an org-B job id got a 200, and from
// then on both the list read and the gate scope that entry through ITS JOB —
// it dropped off org A's calendar, notes and crew ids included, and appeared
// on org B's, where org B could read, edit and delete it. It was also an
// existence oracle: a made-up job id failed the foreign key as a 500 while a
// real org-B id answered 200.
//
// THE FIX (server/routes/schedule-routes.js)
//   * a PATCH carrying jobId proves it with jobInOrg, 404 "job not found" on a
//     miss — the same answer for another tenant's job and for no job at all —
//     and nothing is written;
//   * the UPDATE itself carries the tenant: the entry's current job AND the
//     job it moves onto must be in the caller's org, so a job changing tenant
//     between the checks and the write reopens neither door.
//
// THE ENGINE IS REAL. The route's SQL runs on test/helpers/pg-sqlite.js, so
// "nothing was written" is read back out of the table, not out of a fake's
// filter callback. Each guard is then removed on its own (mutants at the end):
// the pre-check alone, the predicates alone, and both — the committed shape,
// which reproduces the move onto org B's calendar.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');

const { createPgSqlite } = require('./helpers/pg-sqlite');

const SCHED_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'schedule-routes.js');

const SCHEMA = `
  CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, email TEXT, name TEXT, role TEXT, organization_id INTEGER,
    active INTEGER DEFAULT 1, notification_prefs TEXT, last_seen_at TEXT
  );
  CREATE TABLE roles (name TEXT PRIMARY KEY, label TEXT, capabilities TEXT);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, organization_id INTEGER, owner_id INTEGER, data TEXT);
  CREATE TABLE schedule_entries (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    start_date TEXT NOT NULL,
    days INTEGER NOT NULL DEFAULT 1,
    crew TEXT NOT NULL DEFAULT '[]',
    includes_weekends INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'planned',
    notes TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    organization_id INTEGER
  );
  PRAGMA foreign_keys = ON;
`;

const engine = createPgSqlite(SCHEMA, { jsonColumns: ['crew', 'data', 'notification_prefs'] });
// Postgres formats the DATE column; the column here is already that text.
// (node:sqlite takes the arity from the function's declared parameters.)
engine.db.function('to_char', (d, _format) => (d == null ? null : String(d).slice(0, 10)));
globalThis.__P86_SCHED_PATCH_ENGINE__ = engine;

jest.mock('../server/db', () => ({ pool: globalThis.__P86_SCHED_PATCH_ENGINE__.pool }));
jest.mock('../server/email', () => ({
  sendEmail: async () => ({ ok: true }),
  sendForEvent: async () => ({ ok: true }),
  isEnabled: () => false
}));

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const scheduleRoutes = require('../server/routes/schedule-routes');

const ORG_A = 1;
const ORG_B = 2;
const A_ADMIN = { id: 10, email: 'ann@a.test', role: 'admin', name: 'Ann', organization_id: ORG_A };
const B_ADMIN = { id: 20, email: 'bea@b.test', role: 'admin', name: 'Bea', organization_id: ORG_B };

const mutantPaths = [];
let server, baseUrl;
let current = scheduleRoutes;

function seed() {
  engine.db.exec(`
    DELETE FROM schedule_entries; DELETE FROM jobs; DELETE FROM users;
    DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, name) VALUES (1, 'AG Exteriors'), (2, 'Rival Roofing');
    INSERT INTO users (id, email, name, role, organization_id) VALUES
      (10, 'ann@a.test', 'Ann', 'admin', 1), (20, 'bea@b.test', 'Bea', 'admin', 2);
    INSERT INTO roles (name, label, capabilities) VALUES ('admin', 'Admin', '["JOBS_VIEW_ALL"]');
    INSERT INTO jobs (id, organization_id, owner_id, data) VALUES
      ('jA', 1, 10, '{"title":"Latitude"}'),
      ('jA2', 1, 10, '{"title":"Orienta"}'),
      ('jB', 2, 20, '{"title":"Theirs"}'),
      ('jN', NULL, NULL, '{"title":"Legacy, never stamped"}');
    INSERT INTO schedule_entries (id, job_id, start_date, days, crew, notes, created_by, organization_id, updated_at) VALUES
      ('sch_A', 'jA', '2026-09-14', 1, '[10]', 'org A gate code 4412', 10, 1, '2026-09-01 00:00:00'),
      ('sch_B', 'jB', '2026-09-15', 1, '[20]', 'org B notes', 20, 2, '2026-09-01 00:00:00');
  `);
  setRolePool(engine.pool);
  return refreshRoleCache();
}

const entry = (id) => engine.all('SELECT id, job_id, notes, days, updated_at FROM schedule_entries WHERE id = ?', id)[0];
const updates = () => engine.log.filter((q) => /^UPDATE schedule_entries/.test(q.sql));

async function call(method, urlPath, user, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

const calendar = async (user) => ((await call('GET', '/api/schedule', user)).body.entries || []).map((e) => e.id);

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/schedule', (req, res, next) => current(req, res, next));
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
});
afterAll((done) => {
  for (const p of mutantPaths) { try { fs.unlinkSync(p); } catch (e) { /* already gone */ } }
  engine.close();
  server.close(() => done());
});
beforeEach(async () => {
  current = scheduleRoutes;
  engine.log.length = 0;
  await seed();
});

describe('a schedule entry cannot be moved onto another tenant\'s job', () => {
  test('the fixture: each tenant sees its own entry and not the other\'s', async () => {
    // Guards the file: were the list read broken here, every "it did not
    // appear on org B's calendar" below would pass for the wrong reason.
    expect(await calendar(A_ADMIN)).toEqual(['sch_A']);
    expect(await calendar(B_ADMIN)).toEqual(['sch_B']);
  });

  test('HOLE: an org-A scheduler PATCHing jobId to an org-B job is "job not found", and nothing is written', async () => {
    const before = entry('sch_A');
    const r = await call('PATCH', '/api/schedule/sch_A', A_ADMIN, { jobId: 'jB', notes: 'moved' });
    expect(r).toEqual({ status: 404, body: { error: 'job not found' } });
    expect(entry('sch_A')).toEqual(before);
    expect(updates()).toEqual([]);              // refused before the write
    expect(await calendar(A_ADMIN)).toEqual(['sch_A']);
    expect(await calendar(B_ADMIN)).toEqual(['sch_B']);
  });

  test('another tenant\'s job and a job that does not exist answer the same', async () => {
    const foreign = await call('PATCH', '/api/schedule/sch_A', A_ADMIN, { jobId: 'jB' });
    const absent = await call('PATCH', '/api/schedule/sch_A', A_ADMIN, { jobId: 'job_that_never_was' });
    expect(absent).toEqual(foreign);
    expect(absent.status).toBe(404);             // was a foreign-key 500
    expect(entry('sch_A').job_id).toBe('jA');
  });

  test('a move onto another job in the same org still works', async () => {
    const r = await call('PATCH', '/api/schedule/sch_A', A_ADMIN, { jobId: 'jA2', days: 3 });
    expect(r.status).toBe(200);
    expect(r.body.entry).toMatchObject({ id: 'sch_A', jobId: 'jA2', days: 3, startDate: '2026-09-14', crew: [10] });
    expect(entry('sch_A')).toMatchObject({ job_id: 'jA2', days: 3 });
    expect(await calendar(A_ADMIN)).toEqual(['sch_A']);
  });

  test('the legacy tolerance is unchanged: a never-stamped job is still a valid target', async () => {
    const r = await call('PATCH', '/api/schedule/sch_A', A_ADMIN, { jobId: 'jN' });
    expect(r.status).toBe(200);
    expect(entry('sch_A').job_id).toBe('jN');
  });

  test('a PATCH without jobId writes as before', async () => {
    const r = await call('PATCH', '/api/schedule/sch_A', A_ADMIN, { notes: 'bring the lift', status: 'in-progress' });
    expect(r.status).toBe(200);
    expect(r.body.entry).toMatchObject({ jobId: 'jA', notes: 'bring the lift', status: 'in-progress' });
  });

  test('org B still cannot edit org A\'s entry, with or without a jobId', async () => {
    const before = entry('sch_A');
    expect((await call('PATCH', '/api/schedule/sch_A', B_ADMIN, { notes: 'x' })).status).toBe(404);
    expect((await call('PATCH', '/api/schedule/sch_A', B_ADMIN, { jobId: 'jB' })).status).toBe(404);
    expect(entry('sch_A')).toEqual(before);
  });

  test('the UPDATE carries the tenant for both jobs', async () => {
    // Evidence of the statement that ran, backing the mutants below — the
    // properties themselves are the rows above.
    await call('PATCH', '/api/schedule/sch_A', A_ADMIN, { jobId: 'jA2' });
    const [u] = updates();
    expect(u.sql).toMatch(/j_org_scope\.id = schedule_entries\.job_id/);
    expect(u.sql).toMatch(/j_org_scope\.id = \$1\b/);
    expect(u.params[u.params.length - 1]).toBe('sch_A');
    expect(u.params).toContain(ORG_A);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * EACH GUARD, REMOVED
 * ══════════════════════════════════════════════════════════════════════════*/
function mutant(pairs) {
  const SOURCE = fs.readFileSync(SCHED_ROUTES, 'utf8');
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const hits = out.split(f).length - 1;
    if (hits === 0) throw new Error('MUTATION ANCHOR NOT FOUND:\n' + JSON.stringify(f.slice(0, 200)));
    if (hits > 1) throw new Error('MUTATION ANCHOR IS AMBIGUOUS (' + hits + ' matches):\n' + JSON.stringify(f.slice(0, 200)));
    out = out.split(f).join(r);
  }
  const dir = path.dirname(SCHED_ROUTES);
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(dir, spec))
      : require.resolve(spec, { paths: [dir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_sched_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return require(p);
}

const PRECHECK = [
  "      if (v.jobId !== undefined && !(await jobInOrg(pool, v.jobId, req.orgId))) {\n"
    + "        return res.status(404).json({ error: 'job not found' });\n"
    + '      }\n',
  '      // MUTANT: the move does not prove its job\n',
];
const NEW_JOB_PREDICATE = [
  "        (jobParam ? ' AND ' + parentJobInOrgSql(jobParam, orgParam) : '') +\n",
  '',
];
const CURRENT_JOB_PREDICATE = [
  "        ' AND ' + parentJobInOrgSql('schedule_entries.job_id', orgParam) +\n",
  '',
];
const ENTRY_GATE = [
  "      const inOrg = await assertEntityInOrg('schedule_entry', req.params.id, req.orgId);\n"
    + "      if (!inOrg) return res.status(404).json({ error: 'not found' });\n",
  '      // MUTANT: the entry is not proved\n',
];

describe('mutants', () => {
  test('the harness refuses an absent anchor', () => {
    expect(() => mutant([['this string is nowhere in the routes', 'x']])).toThrow(/ANCHOR NOT FOUND/);
  });

  test('the committed shape (no pre-check, no predicates): the entry moves onto org B\'s calendar', async () => {
    current = mutant([PRECHECK, NEW_JOB_PREDICATE, CURRENT_JOB_PREDICATE]);
    const r = await call('PATCH', '/api/schedule/sch_A', A_ADMIN, { jobId: 'jB' });
    expect(r.status).toBe(200);
    expect(entry('sch_A').job_id).toBe('jB');
    current = scheduleRoutes;
    expect(await calendar(A_ADMIN)).toEqual([]);
    expect((await calendar(B_ADMIN)).sort()).toEqual(['sch_A', 'sch_B']);
    // And org B can now edit org A's entry.
    expect((await call('PATCH', '/api/schedule/sch_A', B_ADMIN, { notes: 'ours now' })).status).toBe(200);
  });

  test('drop only the pre-check: the UPDATE\'s own predicate still writes nothing', async () => {
    current = mutant([PRECHECK]);
    const before = entry('sch_A');
    const r = await call('PATCH', '/api/schedule/sch_A', A_ADMIN, { jobId: 'jB' });
    expect(r).toEqual({ status: 404, body: { error: 'not found' } });
    expect(updates().length).toBe(1);            // it reached the write, which refused
    expect(entry('sch_A')).toEqual(before);
  });

  test('drop the pre-check and the new-job predicate: the move lands on org B', async () => {
    current = mutant([PRECHECK, NEW_JOB_PREDICATE]);
    expect((await call('PATCH', '/api/schedule/sch_A', A_ADMIN, { jobId: 'jB' })).status).toBe(200);
    expect(entry('sch_A').job_id).toBe('jB');
  });

  test('drop the entry gate: the current-job predicate still refuses org B\'s entry', async () => {
    current = mutant([ENTRY_GATE]);
    const before = entry('sch_B');
    const r = await call('PATCH', '/api/schedule/sch_B', A_ADMIN, { notes: 'org A was here' });
    expect(r).toEqual({ status: 404, body: { error: 'not found' } });
    expect(entry('sch_B')).toEqual(before);
  });

  test('drop the entry gate and the current-job predicate: org A edits org B\'s entry', async () => {
    current = mutant([ENTRY_GATE, CURRENT_JOB_PREDICATE]);
    expect((await call('PATCH', '/api/schedule/sch_B', A_ADMIN, { notes: 'org A was here' })).status).toBe(200);
    expect(entry('sch_B').notes).toBe('org A was here');
  });
});
