// The company knowledge base could not be opened by anybody.
//
// A HALF-IMPLEMENTED SENTINEL IS A DEAD FEATURE
// readCapForEntity('org') does not return a capability. It returns the
// sentinel '__org_member__', meaning "any authenticated member of THAT org
// may read this" — the company knowledge base is deliberately readable by
// everyone in the tenant and writable only by admins.
//
// Four places consume that value. Two interpreted it
// (requireDynamicCapability, suggestTags). Two did not: GET /raw/:id and
// canReadAttachment. In those two the sentinel fell through to
//
//     hasCapability(user, '__org_member__')
//
// and no capability is named that, so the answer was FALSE FOR EVERYONE.
// Observed in-tenant on an org-bucket file before this change:
// system_admin 403, admin 403, pm 403.
//
// WHAT THAT COST
// /raw/:id is the URL js/pdf-viewer.js and js/markup-viewer.js fetch, so no
// org-bucket PDF could be opened by anyone — a live outage, not a breach; the
// failure is closed. And canReadAttachment is the SOURCE check on
// POST /:id/copy, so an org-bucket file could not be copied into a job or a
// lead either. Same dead-feature class 45ac226 revived for the job / sub /
// task attachment doors, and the same class as the two shadowed routes and
// the space-separated capability gate before it.
//
// PREDICATE BEFORE GATE — THE ORDERING TRAP, CHECKED FIRST
// Repairing a broken capability check can un-403 a door that was never
// tenant-scoped. That has fired twice in this arc, so the property this file
// asserts is BOTH halves at once: the sentinel now grants in-tenant reads,
// AND the cross-tenant read is still refused — by the attachmentInOrg()
// predicate that already ran ahead of it, which for an org bucket compares the
// caller's org id directly against entity_id (the organizations.id) with no
// lookup and no bypass.

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

const storageCalls = [];
jest.mock('../server/storage', () => ({
  storage: {
    delete: async (k) => { storageCalls.push(['delete', k]); },
    getBuffer: async (k) => { storageCalls.push(['get', k]); return Buffer.from('PDFBYTES:' + k); },
    put: async (k) => { storageCalls.push(['put', k]); return 'https://cdn.test/' + k; }
  }
}));
jest.mock('../server/anthropic-files', () => ({
  eagerUploadAttachmentById: async () => {},
  deleteAnthropicFile: async () => {}
}));

function rowsOf(name) { return tables[name] || []; }

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: rowsOf('roles') };

  if (/^SELECT organization_id FROM (\w+) WHERE id = \$1/.test(text)) {
    const table = text.match(/^SELECT organization_id FROM (\w+) WHERE id = \$1/)[1];
    const hit = rowsOf(table).find((r) => String(r.id) === String(p[0]));
    return { rows: hit ? [{ organization_id: hit.organization_id }] : [] };
  }
  if (/FROM attachments WHERE id = \$1/.test(text) && text.startsWith('SELECT')) {
    const hit = rowsOf('attachments').find((r) => String(r.id) === String(p[0]));
    return { rows: hit ? [hit] : [] };
  }
  if (text.includes('COALESCE(MAX(position)')) return { rows: [{ max_pos: 3 }] };
  if (/^INSERT INTO attachments/.test(text)) {
    const row = { id: p[0], entity_type: p[1], entity_id: p[2], filename: p[4] };
    tables.attachments.push(row);
    return { rows: [row], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');

setRolePool(pool);

let server, baseUrl;

// Org 1's whole staff, top to bottom. The bug refused all three, which is the
// clearest evidence it was a dead lookup and not a policy: a capability-
// complete platform owner has no business being 403'd by a capability check.
const OWNER_A = { id: 1, email: 'owner@a.test', role: 'system_admin', name: 'Owner', organization_id: 1 };
const ADMIN_A = { id: 10, email: 'admin@a.test', role: 'admin', name: 'Admin', organization_id: 1 };
const PM_A    = { id: 11, email: 'pm@a.test', role: 'pm', name: 'PM', organization_id: 1 };
const ADMIN_B = { id: 77, email: 'admin@b.test', role: 'admin', name: 'B Admin', organization_id: 2 };
const ORPHAN  = { id: 99, email: 'nobody@x.test', role: 'pm', name: 'No Org', organization_id: null };

function freshTables() {
  return {
    roles: [
      { name: 'system_admin', capabilities: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT', 'ESTIMATES_VIEW', 'ESTIMATES_EDIT', 'USERS_MANAGE', 'ROLES_MANAGE', 'SYSTEM_ADMIN'] },
      { name: 'admin', capabilities: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT', 'ESTIMATES_VIEW', 'ESTIMATES_EDIT', 'USERS_MANAGE', 'ROLES_MANAGE'] },
      // No admin tier, no ROLES_MANAGE — the plain staffer the knowledge base
      // exists for. If the sentinel is read as a capability name, this user is
      // refused for the same reason the owner is, which is the tell.
      { name: 'pm', capabilities: ['JOBS_VIEW_ALL', 'JOBS_EDIT_OWN', 'LEADS_VIEW', 'LEADS_EDIT'] }
    ],
    users: [
      { id: 1, organization_id: 1 }, { id: 10, organization_id: 1 },
      { id: 11, organization_id: 1 }, { id: 77, organization_id: 2 },
      { id: 99, organization_id: null }
    ],
    organizations: [{ id: 1 }, { id: 2 }],
    leads: [{ id: 'leadA', organization_id: 1 }, { id: 'leadB', organization_id: 2 }],
    jobs: [{ id: 'jobA', organization_id: 1 }, { id: 'jobB', organization_id: 2 }],
    attachments: [
      // The company knowledge base. entity_id IS the organizations.id.
      { id: 'att_KB_A', entity_type: 'org', entity_id: '1', organization_id: 1, uploaded_by: 10,
        filename: 'safety-manual.pdf', mime_type: 'application/pdf', tags: [],
        thumb_key: null, web_key: null, original_key: 'org/1/att_KB_A_orig.pdf' },
      { id: 'att_KB_B', entity_type: 'org', entity_id: '2', organization_id: 2, uploaded_by: 77,
        filename: 'their-manual.pdf', mime_type: 'application/pdf', tags: [],
        thumb_key: null, web_key: null, original_key: 'org/2/att_KB_B_orig.pdf' },
      // A job file, to pin that the wave's existing wins are untouched by a
      // change to the sentinel branch beside them.
      { id: 'att_JOB_A', entity_type: 'job', entity_id: 'jobA', organization_id: 1, uploaded_by: 10,
        filename: 'plan.pdf', mime_type: 'application/pdf', tags: [],
        thumb_key: null, web_key: null, original_key: 'job/jobA/att_JOB_A_orig.pdf' },
      { id: 'att_JOB_B', entity_type: 'job', entity_id: 'jobB', organization_id: 2, uploaded_by: 77,
        filename: 'their-plan.pdf', mime_type: 'application/pdf', tags: [],
        thumb_key: null, web_key: null, original_key: 'job/jobB/att_JOB_B_orig.pdf' }
    ]
  };
}

beforeAll(async () => {
  queries = []; tables = freshTables();
  await refreshRoleCache();
  const attachmentRoutes = require('../server/routes/attachment-routes');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/attachments', attachmentRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => { queries = []; storageCalls.length = 0; tables = freshTables(); });

async function call(method, path, user, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* raw bytes */ }
  return { status: res.status, body: json, text };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. The revived feature: an org-bucket PDF opens, for every member.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('GET /raw/:id on the company knowledge base', () => {
  test('the platform owner can open it', async () => {
    const r = await call('GET', '/api/attachments/raw/att_KB_A?variant=original', OWNER_A);
    expect(r.status).toBe(200);
    expect(r.text).toContain('PDFBYTES:org/1/att_KB_A_orig.pdf');
  });

  test('an org admin can open it', async () => {
    const r = await call('GET', '/api/attachments/raw/att_KB_A?variant=original', ADMIN_A);
    expect(r.status).toBe(200);
    expect(r.text).toContain('PDFBYTES:');
  });

  test('a plain PM can open it — this is who the knowledge base is FOR', async () => {
    const r = await call('GET', '/api/attachments/raw/att_KB_A?variant=original', PM_A);
    expect(r.status).toBe(200);
    expect(r.text).toContain('PDFBYTES:');
  });

  test('the bytes go back as an inline PDF, which is what the viewer needs', async () => {
    // The whole point of routing bytes through the API rather than the CDN is
    // that js/pdf-viewer.js can render them same-origin; a Content-Disposition
    // of attachment would have "fixed" the 403 into a download prompt.
    const res = await fetch(baseUrl + '/api/attachments/raw/att_KB_A?variant=original', {
      headers: { authorization: 'Bearer ' + signToken(PM_A) }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Predicate before gate. Un-403ing a door must not un-scope it.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the other tenant\'s knowledge base is still unreachable', () => {
  test('an org admin cannot stream another org\'s file, and no bytes are fetched', async () => {
    const r = await call('GET', '/api/attachments/raw/att_KB_B?variant=original', ADMIN_A);
    expect(r.status).toBe(404);
    expect(storageCalls.length).toBe(0);
  });

  test('nor can the platform owner — attachmentInOrg has no system_admin arm', async () => {
    const r = await call('GET', '/api/attachments/raw/att_KB_B?variant=original', OWNER_A);
    expect(r.status).toBe(404);
    expect(storageCalls.length).toBe(0);
  });

  test('nor a plain PM, and it runs in both directions', async () => {
    expect((await call('GET', '/api/attachments/raw/att_KB_B', PM_A)).status).toBe(404);
    expect((await call('GET', '/api/attachments/raw/att_KB_A', ADMIN_B)).status).toBe(404);
    expect(storageCalls.length).toBe(0);
  });

  test('a caller who names no tenant may not read one that does', async () => {
    expect((await call('GET', '/api/attachments/raw/att_KB_A', ORPHAN)).status).toBe(404);
    expect(storageCalls.length).toBe(0);
  });

  test('a foreign file and an absent id answer identically — no oracle', async () => {
    const foreign = await call('GET', '/api/attachments/raw/att_KB_B', ADMIN_A);
    const absent  = await call('GET', '/api/attachments/raw/att_NOPE', ADMIN_A);
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body).toEqual(absent.body);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. The second un-interpreted site: canReadAttachment, the copy SOURCE.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an org-bucket file can be a copy source again', () => {
  test('copying the safety manual into an in-tenant lead works', async () => {
    const r = await call('POST', '/api/attachments/att_KB_A/copy', ADMIN_A, {
      entity_type: 'lead', entity_id: 'leadA'
    });
    expect(r.status).toBe(200);
    expect(r.body.attachment.entity_type).toBe('lead');
    expect(storageCalls.some((c) => c[0] === 'put')).toBe(true);
  });

  test('a plain PM can copy it too — read is by membership, not by tier', async () => {
    const r = await call('POST', '/api/attachments/att_KB_A/copy', PM_A, {
      entity_type: 'lead', entity_id: 'leadA'
    });
    expect(r.status).toBe(200);
  });

  test('the SOURCE boundary still holds — another tenant\'s manual is not copyable', async () => {
    const r = await call('POST', '/api/attachments/att_KB_B/copy', ADMIN_A, {
      entity_type: 'lead', entity_id: 'leadA'
    });
    expect(r.status).toBe(404);
    expect(storageCalls.some((c) => c[0] === 'put')).toBe(false);
  });

  test('the DESTINATION boundary still holds — it cannot be injected into another tenant', async () => {
    const r = await call('POST', '/api/attachments/att_KB_A/copy', ADMIN_A, {
      entity_type: 'lead', entity_id: 'leadB'
    });
    expect(r.status).toBe(404);
    expect(storageCalls.some((c) => c[0] === 'put')).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. The wave's existing wins, beside the branch that changed.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the non-sentinel branches are untouched', () => {
  test('an in-tenant job file still streams', async () => {
    const r = await call('GET', '/api/attachments/raw/att_JOB_A?variant=original', PM_A);
    expect(r.status).toBe(200);
    expect(r.text).toContain('PDFBYTES:job/jobA');
  });

  test('a foreign job file still refuses, with no bytes fetched', async () => {
    const r = await call('GET', '/api/attachments/raw/att_JOB_B?variant=original', ADMIN_A);
    expect(r.status).toBe(404);
    expect(storageCalls.length).toBe(0);
  });
});
