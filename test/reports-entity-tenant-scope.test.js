// reports-routes.js: the scoped-read / unscoped-write shape, third recurrence.
//
// WHAT WAS OPEN
// This file already carried its own tenancy proof —
//
//     ensureEntityVisible():  SELECT id FROM projects
//                              WHERE id = $1 AND organization_id = $2
//
// — and called it from GET list, GET one, and POST create. PATCH and DELETE
// did not call it. Their statements key on (reportId, entity_type, entity_id)
// with no org term, so a plain PM in org A — holding LEADS_EDIT and nothing
// else, no admin tier at all — could rewrite and then destroy another
// tenant's report:
//
//     PATCH  /api/reports/project/<orgB project>/<orgB report>   -> 200
//     DELETE /api/reports/project/<orgB project>/<orgB report>   -> 200
//
// The three sibling doors in the SAME FILE refused the same ids with 404.
// That is the tell this class always leaves: a predicate that exists, is
// correct, and is simply not asked on every door.
//
// WHY THE PROJECT AND NOT THE REPORT
// job_reports has no organization_id of its own. The only thing that can
// answer "is this row mine" is the entity it hangs on — the same
// parent-not-own-column anchor services/attachment-org-scope.js settled on,
// and the same one the three working doors here already used.
//
// THE REFUSAL SHAPE
// 404, identical to what an ABSENT project id gets, and identical to the
// rowCount-driven 404 the handlers already answered with. Project ids and
// report ids are enumerable; a distinguishable 403 would turn the pair into
// an existence oracle, which is the decision already shipped on the users,
// jobs, subs and attachments sides.
//
// AND THE HALF THAT MUST NOT BREAK
// In-tenant PATCH is a live feature — it is every save in the report editor.
// The fix is a predicate, not a gate, so the tests below assert the working
// case as loudly as the refused one.

const express = require('express');
const http = require('http');

let queries;
let tables;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockRunQuery(sql, params),
      release: () => {}
    })
  }
}));

function rowsOf(name) { return tables[name] || []; }

// A table-backed fake. The predicate under test is only meaningful if a
// foreign project can actually be looked up and rejected on its contents, and
// the "did the write happen" assertions are only meaningful if the writes
// actually mutate rows the next read can see.
function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: rowsOf('roles') };

  // ensureEntityVisible — the proof itself.
  if (/^SELECT id FROM projects WHERE id = \$1 AND organization_id = \$2/.test(text)) {
    const hit = rowsOf('projects').find(
      (r) => String(r.id) === String(p[0]) && String(r.organization_id) === String(p[1])
    );
    return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 };
  }

  // Both reads join the same two tables; the WHERE is what tells them apart.
  // Single-report read first, because the list's prefix is a prefix of it.
  if (text.includes('FROM job_reports r') && text.includes('WHERE r.id = $1')) {
    const hit = rowsOf('job_reports').find(
      (r) => String(r.id) === String(p[0]) && r.entity_type === p[1] && String(r.entity_id) === String(p[2])
    );
    return { rows: hit ? [Object.assign({ created_by_name: 'X' }, hit)] : [] };
  }
  if (text.includes('FROM job_reports r LEFT JOIN users u')) {
    const list = rowsOf('job_reports').filter(
      (r) => r.entity_type === p[0] && String(r.entity_id) === String(p[1])
    );
    return { rows: list.map((r) => Object.assign({ created_by_name: 'X' }, r)) };
  }
  if (/^INSERT INTO job_reports/.test(text)) {
    tables.job_reports.push({
      id: p[0], entity_type: p[1], entity_id: p[2], title: p[3], summary: p[4],
      sections: JSON.parse(p[5]), cover_page: JSON.parse(p[6]),
      template_type: p[7], style_pack: p[8], created_by: p[9]
    });
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE job_reports SET/.test(text)) {
    // The last three params are (reportId, entityType, entityId) — the WHERE
    // the route builds. Applying it here rather than restating it means the
    // test measures the route's own predicate.
    const [rid, etype, eid] = p.slice(-3);
    const hit = rowsOf('job_reports').find(
      (r) => String(r.id) === String(rid) && r.entity_type === etype && String(r.entity_id) === String(eid)
    );
    if (!hit) return { rows: [], rowCount: 0 };
    let i = 0;
    if (/title = \$/.test(text))         hit.title = p[i++];
    if (/summary = \$/.test(text))       hit.summary = p[i++];
    if (/sections = \$/.test(text))      hit.sections = JSON.parse(p[i++]);
    if (/cover_page = \$/.test(text))    hit.cover_page = JSON.parse(p[i++]);
    if (/template_type = \$/.test(text)) hit.template_type = p[i++];
    if (/style_pack = \$/.test(text))    hit.style_pack = p[i++];
    return { rows: [], rowCount: 1 };
  }
  if (/^DELETE FROM job_reports WHERE id = \$1/.test(text)) {
    const before = tables.job_reports.length;
    tables.job_reports = tables.job_reports.filter(
      (r) => !(String(r.id) === String(p[0]) && r.entity_type === p[1] && String(r.entity_id) === String(p[2]))
    );
    return { rows: [], rowCount: before - tables.job_reports.length };
  }
  if (text.includes('FROM attachments WHERE id = ANY($1::text[])')) return { rows: [] };

  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');

setRolePool(pool);

let server, baseUrl;

// A PLAIN PM. LEADS_EDIT and LEADS_VIEW, no admin tier, no SYSTEM_ADMIN.
// The lowest-privilege account that can reach these doors at all — so nothing
// below can be waved off as "well, they were an admin".
const PM_A = { id: 11, email: 'pm-a@a.test', role: 'pm', name: 'A PM', organization_id: 1 };
const PM_B = { id: 88, email: 'pm-b@b.test', role: 'pm', name: 'B PM', organization_id: 2 };
const ORPHAN = { id: 99, email: 'nobody@x.test', role: 'pm', name: 'No Org', organization_id: null };

function freshTables() {
  return {
    roles: [
      { name: 'pm', capabilities: ['LEADS_VIEW', 'LEADS_EDIT'] },
      // Capability-complete, cross-tenant tier. Included so the boundary can be
      // shown to hold for the strongest caller too — projects are not one of
      // the doors SYSTEM_ADMIN is allowed to cross.
      { name: 'system_admin', capabilities: ['LEADS_VIEW', 'LEADS_EDIT', 'SYSTEM_ADMIN'] }
    ],
    projects: [
      { id: 'projA', organization_id: 1 },
      { id: 'projB', organization_id: 2 }
    ],
    job_reports: [
      { id: 'rptA', entity_type: 'project', entity_id: 'projA', title: 'A walkthrough',
        summary: 'A summary', sections: [], cover_page: {}, template_type: 'walkthrough',
        style_pack: 'clean', created_by: 11 },
      { id: 'rptB', entity_type: 'project', entity_id: 'projB', title: 'B walkthrough',
        summary: 'B summary', sections: [], cover_page: {}, template_type: 'walkthrough',
        style_pack: 'clean', created_by: 88 }
    ]
  };
}

beforeAll(async () => {
  queries = []; tables = freshTables();
  await refreshRoleCache();
  const reportsRoutes = require('../server/routes/reports-routes');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/reports', reportsRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => { queries = []; tables = freshTables(); });

async function call(method, path, user, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, body: json, text };
}

function reportWrite() {
  return queries.find((q) => /^(UPDATE job_reports|DELETE FROM job_reports|INSERT INTO job_reports)/i.test(q.sql));
}
function reportById(id) { return tables.job_reports.find((r) => r.id === id); }

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. The two doors that were open.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('PATCH and DELETE cannot reach another tenant', () => {
  test('PATCH refuses, and does not run the UPDATE', async () => {
    const r = await call('PATCH', '/api/reports/project/projB/rptB', PM_A, {
      title: 'HIJACKED BY ORG A',
      summary: 'HIJACKED BY ORG A',
      sections: [{ id: 's1', label: 'HIJACKED BY ORG A' }],
      cover_page: { enabled: true, company_name: 'HIJACKED BY ORG A' }
    });
    expect(r.status).toBe(404);
    expect(reportWrite()).toBeUndefined();
    const b = reportById('rptB');
    expect(b.title).toBe('B walkthrough');
    expect(b.summary).toBe('B summary');
    expect(b.sections).toEqual([]);
    expect(b.cover_page).toEqual({});
  });

  test('DELETE refuses, and the row survives', async () => {
    const r = await call('DELETE', '/api/reports/project/projB/rptB', PM_A);
    expect(r.status).toBe(404);
    expect(reportWrite()).toBeUndefined();
    expect(reportById('rptB')).toBeTruthy();
  });

  test('the refusal is the ABSENT-key answer, byte for byte — no oracle', async () => {
    // A foreign project, a project that never existed, and a report id that
    // never existed must be indistinguishable. Anything else lets a caller
    // enumerate which project ids are real in other tenants.
    const foreign = await call('PATCH', '/api/reports/project/projB/rptB', PM_A, { title: 'x' });
    const absent  = await call('PATCH', '/api/reports/project/projNOPE/rptB', PM_A, { title: 'x' });
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body).toEqual(absent.body);

    const fDel = await call('DELETE', '/api/reports/project/projB/rptB', PM_A);
    const aDel = await call('DELETE', '/api/reports/project/projNOPE/rptB', PM_A);
    expect(fDel.status).toBe(aDel.status);
    expect(fDel.body).toEqual(aDel.body);
  });

  test('borrowing your OWN project id to reach their report does not work either', async () => {
    // The predicate passes (projA is mine) and the statement's own
    // (id, entity_type, entity_id) key is what refuses — belt and braces.
    const r = await call('PATCH', '/api/reports/project/projA/rptB', PM_A, { title: 'x' });
    expect(r.status).toBe(404);
    expect(reportById('rptB').title).toBe('B walkthrough');
  });

  test('a caller with NO organization reaches nothing', async () => {
    expect((await call('PATCH', '/api/reports/project/projA/rptA', ORPHAN, { title: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/api/reports/project/projA/rptA', ORPHAN)).status).toBe(404);
    expect(reportById('rptA').title).toBe('A walkthrough');
  });

  test('SYSTEM_ADMIN does not cross here — projects were never one of the audited crossings', async () => {
    const owner = { id: 1, email: 'o@p.test', role: 'system_admin', name: 'O', organization_id: 1 };
    expect((await call('PATCH', '/api/reports/project/projB/rptB', owner, { title: 'x' })).status).toBe(404);
    expect(reportById('rptB').title).toBe('B walkthrough');
  });

  test('and it runs in both directions', async () => {
    expect((await call('PATCH', '/api/reports/project/projA/rptA', PM_B, { title: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/api/reports/project/projA/rptA', PM_B)).status).toBe(404);
    expect(reportById('rptA')).toBeTruthy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Do not break what works. In-tenant PATCH is every save in the editor.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('in-tenant report editing still works', () => {
  test('PATCH writes title, summary, sections and cover_page', async () => {
    const r = await call('PATCH', '/api/reports/project/projA/rptA', PM_A, {
      title: 'Week 3 walkthrough',
      summary: 'Framing complete',
      sections: [{ id: 's1', label: 'Before' }],
      cover_page: { enabled: true, company_name: 'AGX' },
      template_type: 'daily-log',
      style_pack: 'clean'
    });
    expect(r.status).toBe(200);
    const a = reportById('rptA');
    expect(a.title).toBe('Week 3 walkthrough');
    expect(a.summary).toBe('Framing complete');
    expect(a.sections[0].label).toBe('Before');
    expect(a.cover_page.company_name).toBe('AGX');
    expect(a.template_type).toBe('daily-log');
  });

  test('a partial PATCH still only touches the fields it names', async () => {
    expect((await call('PATCH', '/api/reports/project/projA/rptA', PM_A, { title: 'Retitled' })).status).toBe(200);
    expect(reportById('rptA').title).toBe('Retitled');
    expect(reportById('rptA').summary).toBe('A summary');
  });

  test('an empty PATCH body still 400s, not 404 — the predicate did not steal that answer', async () => {
    const r = await call('PATCH', '/api/reports/project/projA/rptA', PM_A, {});
    expect(r.status).toBe(400);
  });

  test('an in-tenant project with a report id that does not exist still 404s', async () => {
    const r = await call('PATCH', '/api/reports/project/projA/rpt_NOPE', PM_A, { title: 'x' });
    expect(r.status).toBe(404);
  });

  test('DELETE removes the caller\'s own report', async () => {
    const r = await call('DELETE', '/api/reports/project/projA/rptA', PM_A);
    expect(r.status).toBe(200);
    expect(reportById('rptA')).toBeUndefined();
  });

  test('the three doors that were already correct still are', async () => {
    expect((await call('GET', '/api/reports/project/projA', PM_A)).status).toBe(200);
    expect((await call('GET', '/api/reports/project/projA/rptA', PM_A)).status).toBe(200);
    expect((await call('POST', '/api/reports/project/projA', PM_A, { title: 'New' })).status).toBe(200);
    expect((await call('GET', '/api/reports/project/projB', PM_A)).status).toBe(404);
    expect((await call('GET', '/api/reports/project/projB/rptB', PM_A)).status).toBe(404);
    expect((await call('POST', '/api/reports/project/projB', PM_A, { title: 'New' })).status).toBe(404);
  });

  test('an unsupported entity type is still a 400, before any of this', async () => {
    expect((await call('PATCH', '/api/reports/wormhole/x/y', PM_A, { title: 'x' })).status).toBe(400);
    expect((await call('DELETE', '/api/reports/wormhole/x/y', PM_A)).status).toBe(400);
  });
});
