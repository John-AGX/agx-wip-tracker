/* SEE WHAT THEY SEE — the admin window onto the sub portal.
 *
 * "i want this to just be something i can look at to see what they are seeing
 * on their end." So it is a window, not a session, and this file guards the
 * three things that make it worth having:
 *
 *   1. IT IS THE SAME READ. The preview and the live portal both go through
 *      services/sub-portal-view.js. A preview that re-implemented the read
 *      would be wrong in one of two directions and both mislead the office: it
 *      shows a document the sub has not been given, so nobody chases it; or it
 *      hides one they have, so it gets sent twice. Asserted by output AND by
 *      asserting neither caller keeps a second copy.
 *   2. IT CANNOT WRITE, and it is not a session. No route here mutates, and
 *      none of them changes who the caller is.
 *   3. IT CANNOT CROSS A TENANT. The sub id comes off the URL, which the live
 *      portal's never does — the portal reads it from the JWT. So the preview
 *      asks the tenancy question that the portal gets for free, and a foreign
 *      sub answers exactly as a missing one does.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { liveLines } = require('./helpers/live-line');

let tables;
let queries;

jest.mock('../server/db', () => ({
  pool: { query: async (sql, params) => mockRunQuery(sql, params) },
}));
jest.mock('../server/email', () => ({ sendEmail: async () => ({ ok: true }), isEnabled: () => false }));

function rowsOf(n) { return tables[n] || []; }
function orgOk(row, orgId) { return row.organization_id == null || String(row.organization_id) === String(orgId); }

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  if (/FROM roles/.test(text)) return { rows: rowsOf('roles') };

  // The sub identity read, org-predicated — served OFF the statement so that
  // dropping the predicate is observable here.
  if (/^SELECT id, name, trade, email, primary_contact_first, primary_contact_last FROM subs/.test(text)) {
    const scoped = /organization_id = \$2/.test(text);
    const s = rowsOf('subs').find((x) => String(x.id) === String(p[0]));
    if (!s) return { rows: [] };
    if (scoped && !orgOk(s, p[1])) return { rows: [] };
    return { rows: [{ id: s.id, name: s.name, trade: s.trade, email: s.email,
      primary_contact_first: null, primary_contact_last: null }] };
  }

  if (/FROM attachment_folder_grants g JOIN attachments a/.test(text)) {
    const out = [];
    for (const g of rowsOf('grants')) {
      if (String(g.sub_id) !== String(p[0])) continue;
      for (const a of rowsOf('attachments')) {
        if (a.entity_type !== g.entity_type || a.entity_id !== g.entity_id) continue;
        if (a.folder !== g.folder) continue;
        out.push(Object.assign({}, a, {
          grant_entity_type: g.entity_type, grant_entity_id: g.entity_id, grant_folder: g.folder,
        }));
      }
    }
    return { rows: out };
  }

  // The label resolver's job lookup, in the shape services/entity-labels.js
  // actually issues it: id::text plus a split jobNumber/title, never `data`.
  // An earlier version of this mock matched a query that file does not send,
  // so the label came back null and the test said the PRODUCT had lost its
  // folder headers.
  if (/FROM jobs WHERE id::text = ANY/.test(text)) {
    const want = (p[0] || []).map(String);
    return { rows: rowsOf('jobs')
      .filter((j) => want.includes(String(j.id)))
      .map((j) => ({
        id: String(j.id),
        num: (j.data && j.data.jobNumber) || '',
        label: (j.data && (j.data.title || j.data.name)) || '',
      })) };
  }
  if (/FROM leads WHERE id::text = ANY/.test(text)) {
    return { rows: [] };
  }

  if (/^SELECT email, name FROM users WHERE sub_id = \$1/.test(text)) {
    const u = rowsOf('users').find((x) => String(x.sub_id) === String(p[0]) && x.active !== false);
    return { rows: u ? [{ email: u.email, name: u.name }] : [] };
  }

  if (/FROM subs s LEFT JOIN users u/.test(text)) {
    const scoped = /s\.organization_id = \$1/.test(text);
    return { rows: rowsOf('subs')
      .filter((s) => !scoped || orgOk(s, p[0]))
      .map((s) => {
        const u = rowsOf('users').find((x) => String(x.sub_id) === String(s.id) && x.active !== false);
        return { id: s.id, name: s.name, trade: s.trade, email: s.email,
          portal_user_id: u ? u.id : null, portal_user_name: u ? u.name : null,
          grant_count: rowsOf('grants').filter((g) => String(g.sub_id) === String(s.id)).length };
      }) };
  }

  return { rows: [], rowCount: 0 };
}

const ORG = 1;
const OTHER_ORG = 2;

function freshTables() {
  return {
    roles: [
      { name: 'admin', capabilities: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'ESTIMATES_EDIT'] },
      { name: 'pm', capabilities: ['JOBS_VIEW_ALL', 'JOBS_EDIT_OWN', 'ESTIMATES_EDIT'] },
      { name: 'field_crew', capabilities: ['ESTIMATES_VIEW', 'ESTIMATES_EDIT'] },
      { name: 'sub', capabilities: ['SUB_PORTAL_VIEW', 'SUB_PORTAL_UPLOAD'] },
    ],
    users: [
      { id: 50, name: 'Acme Roofing', email: 'acme@vendor.test', sub_id: 'sub_1', active: true },
    ],
    subs: [
      { id: 'sub_1', name: 'Acme Roofing', trade: 'Roofing', email: 'acme@vendor.test', organization_id: ORG },
      { id: 'sub_2', name: 'Never Invited Ltd', trade: 'Glazing', email: null, organization_id: ORG },
      { id: 'sub_x', name: 'Someone Else’s Sub', trade: 'Paving', email: null, organization_id: OTHER_ORG },
    ],
    jobs: [{ id: 'j1', data: { jobNumber: '1042', title: 'River Landing' }, organization_id: ORG }],
    grants: [{ sub_id: 'sub_1', entity_type: 'job', entity_id: 'j1', folder: 'compliance' }],
    attachments: [{
      id: 'att_1', filename: 'COI.pdf', mime_type: 'application/pdf', size_bytes: 4096,
      thumb_url: null, web_url: null, original_url: 'https://cdn/x.pdf',
      entity_type: 'job', entity_id: 'j1', folder: 'compliance', position: 0,
      // must never reach a sub, and therefore must never reach the preview
      uploaded_by: 42,
      extracted_text: 'INTERNAL OCR BODY — pricing memo',
      annotations: [{ note: 'internal' }],
      anthropic_file_id: 'file_abc',
      tags: ['internal'],
      thumb_key: 'k1', web_key: 'k2', original_key: 'k3',
      organization_id: ORG,
    }],
  };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');

let server;
let base;

const USER = (role, id) => ({ id: id, email: role + '@agx.test', role: role, name: role, organization_id: ORG });

beforeAll(async () => {
  tables = freshTables();
  queries = [];
  setRolePool(pool);
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/preview', require('../server/routes/preview-routes'));
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});

afterAll((done) => { if (server) server.close(() => done()); else done(); });

beforeEach(async () => { tables = freshTables(); queries = []; await refreshRoleCache(); });

async function call(p, user) {
  const res = await fetch(base + p, {
    headers: user ? { authorization: 'Bearer ' + signToken(user) } : {},
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body: body };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * IT IS THE SAME READ
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the preview is the portal’s own read', () => {
  test('it serves the sub-facing projection and nothing else', async () => {
    const r = await call('/api/preview/sub-portal/sub_1/attachments', USER('admin', 10));
    expect(r.status).toBe(200);
    const a = r.body.attachments[0];
    expect(a.filename).toBe('COI.pdf');
    // Every field the sub never receives must be absent from the preview too —
    // otherwise the preview is not what they see, it is what WE see.
    for (const leak of ['uploaded_by', 'extracted_text', 'annotations',
      'anthropic_file_id', 'tags', 'thumb_key', 'web_key', 'original_key', 'organization_id']) {
      expect([leak, Object.prototype.hasOwnProperty.call(a, leak)]).toEqual([leak, false]);
    }
  });

  test('the folder label resolves the same way the portal resolves it', async () => {
    const r = await call('/api/preview/sub-portal/sub_1/attachments', USER('admin', 10));
    expect(r.body.attachments[0].grant_entity_label).toContain('River Landing');
  });

  test('the key set is exactly the shared whitelist', async () => {
    const view = require('../server/services/sub-portal-view');
    const r = await call('/api/preview/sub-portal/sub_1/attachments', USER('admin', 10));
    expect(Object.keys(r.body.attachments[0]).sort()).toEqual(view.SUB_ATTACHMENT_FIELDS.slice().sort());
  });

  test('NEITHER caller keeps a second copy of the read', () => {
    // This is the assertion that makes the preview trustworthy. If the portal
    // route ever grows its own projection again, the two drift and the preview
    // silently stops being what the sub sees.
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'sub-portal-routes.js'), 'utf8');
    const prevSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'preview-routes.js'), 'utf8');
    for (const [name, src] of [['portal', routeSrc], ['preview', prevSrc]]) {
      expect([name, liveLines(src, "require('../services/sub-portal-view')").length]).toEqual([name, 1]);
      expect([name, /SUB_ATTACHMENT_FIELDS\s*=/.test(src)]).toEqual([name, false]);
      expect([name, /function publicAttachment/.test(src)]).toEqual([name, false]);
    }
  });

  test('the identity read answers the portal’s shape', async () => {
    const r = await call('/api/preview/sub-portal/sub_1/me', USER('admin', 10));
    expect(r.status).toBe(200);
    expect(r.body.sub.name).toBe('Acme Roofing');
    expect(r.body.preview).toBe(true);
    expect(r.body.hasPortal).toBe(true);
  });

  test('a sub nobody has invited says so, rather than looking empty', async () => {
    const r = await call('/api/preview/sub-portal/sub_2/me', USER('admin', 10));
    expect(r.status).toBe(200);
    expect(r.body.hasPortal).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * IT CANNOT CROSS A TENANT
 * ══════════════════════════════════════════════════════════════════════════*/
describe('tenancy', () => {
  test('another tenant’s sub is not found', async () => {
    const r = await call('/api/preview/sub-portal/sub_x/me', USER('admin', 10));
    expect(r.status).toBe(404);
  });

  test('and its files are not served either', async () => {
    const r = await call('/api/preview/sub-portal/sub_x/attachments', USER('admin', 10));
    expect(r.status).toBe(404);
  });

  test('a sub that does not exist answers the SAME as a foreign one — no oracle', async () => {
    const foreign = await call('/api/preview/sub-portal/sub_x/me', USER('admin', 10));
    const absent = await call('/api/preview/sub-portal/sub_nope/me', USER('admin', 10));
    expect(absent.status).toBe(foreign.status);
    expect(absent.body).toEqual(foreign.body);
  });

  test('the sub list is scoped to the caller’s organisation', async () => {
    const r = await call('/api/preview/subs', USER('admin', 10));
    const ids = r.body.subs.map((s) => s.id);
    expect(ids).toContain('sub_1');
    expect(ids).not.toContain('sub_x');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * IT IS A WINDOW, NOT A SESSION
 * ══════════════════════════════════════════════════════════════════════════*/
describe('it only looks', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'preview-routes.js'), 'utf8');

  test('every route is a GET — there is nothing here to write with', () => {
    const verbs = (SRC.match(/router\.(get|post|put|patch|delete)\(/g) || []);
    expect(verbs.length).toBeGreaterThan(0);
    expect(verbs.every((v) => v === 'router.get(')).toBe(true);
  });

  test('it mints no token and signs nothing', () => {
    expect(/signToken|jwt\.sign|res\.cookie/.test(SRC)).toBe(false);
  });

  test('it issues no INSERT, UPDATE or DELETE', () => {
    expect(/INSERT INTO|UPDATE |DELETE FROM/.test(SRC)).toBe(false);
  });

  test('it is gated, and a role without JOBS_VIEW_ALL is refused', async () => {
    const r = await call('/api/preview/sub-portal/sub_1/me', USER('field_crew', 20));
    expect(r.status).toBe(403);
  });

  test('a signed-out caller gets nothing', async () => {
    const r = await call('/api/preview/sub-portal/sub_1/me', null);
    expect(r.status).toBe(401);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * IT IS HONEST ABOUT WHAT IT CANNOT SHOW
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the catalogue', () => {
  test('names the audiences that have no login, instead of pretending', async () => {
    const r = await call('/api/preview/audiences', USER('admin', 10));
    const byKey = Object.fromEntries(r.body.audiences.map((a) => [a.key, a]));
    expect(byKey.sub.ready).toBe(true);
    // A client never signs in to Project 86. Offering a "client portal"
    // preview would be inventing a surface that does not exist.
    expect(byKey.client.ready).toBe(false);
    expect(byKey.client.how).toBe('no login');
    expect(byKey.crew.how).toBe('token link');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PAGE UNDER TEST IS THE REAL PAGE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('portal.html in preview mode', () => {
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'portal.html'), 'utf8');

  test('it reads the preview endpoints when ?preview is present, and its own otherwise', () => {
    expect(HTML).toContain("'/api/preview/sub-portal/'");
    expect(liveLines(HTML, 'var IS_PREVIEW').length).toBe(1);
    // The CONDITION, not just the strings. Asserting both paths appear in the
    // file passed happily when the branch was mutated to `if (true) return the
    // live path` — the preview path was still there, just unreachable, and the
    // preview would have shown the VIEWER's own portal (i.e. nothing) while
    // looking like it worked.
    expect(liveLines(HTML, "if (!IS_PREVIEW) return '/api/sub-portal/' + which;").length).toBe(1);
  });

  test('the upload control is REMOVED in preview, not merely disabled', () => {
    // A control that looks live and is not is its own kind of lie — and the
    // viewer is not the sub, so an upload would be attributed to nobody.
    expect(HTML).toContain("(IS_PREVIEW ? '' :");
    const i = HTML.indexOf('data-upload-btn');
    const before = HTML.slice(Math.max(0, i - 800), i);
    expect(before).toContain('IS_PREVIEW');
  });

  test('the banner says whose portal it is and that it cannot be changed', () => {
    expect(HTML).toContain('preview-banner');
    expect(HTML).toContain('nothing here can be changed');
  });
});
