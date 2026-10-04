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

  if (/^SELECT \* FROM service_tickets WHERE id = \$1/.test(text)) {
    // The org term is read OFF THE STATEMENT. Applying it on this mock's own
    // authority made "the ticket read loses its org predicate" invisible — the
    // third time in this session a mock has hidden exactly that mutation.
    const scoped = /organization_id = \$2/.test(text);
    const t = rowsOf('tickets').find((x) => String(x.id) === String(p[0])
      && (!scoped || String(x.organization_id) === String(p[1])));
    return { rows: t ? [t] : [] };
  }
  // The column is ticket_id. An earlier version of this mock matched on a
  // regex and keyed the fixture on service_ticket_id — a column that does not
  // exist — so the tests passed while both queries would have thrown at
  // runtime. test/schema-truth.test.js caught it; this mock could not, because
  // a mock that does not know the schema cannot police it. The fixture now
  // carries the real column name, which at least makes the mismatch visible.
  if (/FROM service_ticket_shares s/.test(text) && /JOIN service_tickets t/.test(text)) {
    return { rows: rowsOf('ticketShares').filter((x) => String(x.ticket_id) === String(p[0])) };
  }
  if (/^SELECT id, entity_type, entity_id, report_id/.test(text)) {
    const scoped = /organization_id = \$1/.test(text);
    return { rows: rowsOf('reportShares').filter((x) => !scoped || String(x.organization_id) === String(p[0])) };
  }
  if (/^SELECT id, document, revoked_at, expires_at FROM report_shares/.test(text)) {
    const scoped = /organization_id = \$2/.test(text);
    const r = rowsOf('reportShares').find((x) => String(x.id) === String(p[0])
      && (!scoped || String(x.organization_id) === String(p[1])));
    return { rows: r ? [r] : [] };
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
    tickets: [
      { id: 't1', organization_id: ORG, title: 'Pool pump', status: 'scheduled' },
      { id: 't_other', organization_id: OTHER_ORG, title: 'Not yours', status: 'scheduled' },
    ],
    ticketShares: [
      { id: 'sh1', ticket_id: 't1', scope: 'respond', hide_financials: true,
        recipient_name: 'Ray', recipient_email: 'ray@crew.test', opened_at: null, view_count: 0 },
    ],
    reportShares: [
      { id: 'rs1', organization_id: ORG, entity_type: 'job', entity_id: 'j1', report_id: 'rep1',
        recipient_email: 'client@example.test', document: { title: 'Final report', blocks: ['x'] },
        revoked_at: null, expires_at: null, opened_at: null, view_count: 0, created_at: '2026-10-01' },
      { id: 'rs_other', organization_id: OTHER_ORG, entity_type: 'job', entity_id: 'jx', report_id: 'r2',
        recipient_email: 'nope@other.test', document: { title: 'Theirs' },
        revoked_at: null, expires_at: null, opened_at: null, view_count: 0, created_at: '2026-10-01' },
    ],
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
    expect(byKey.client.ready).toBe(true);
    expect(byKey.client.how).toBe('no login');
    expect(byKey.crew.how).toBe('token link');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CREW — AND THE ONE THING A PREVIEW MUST NOT DO
 *
 * Opening a crew link stamps opened_at, bumps view_count and raises a
 * crew-activity notice. Those are how the office knows the crew has seen the
 * work order. An internal preview that recorded them would be the office
 * lying to itself — and it is the reason this preview runs the real handler
 * with a flag rather than opening the real link.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('previewing a crew link records nothing', () => {
  test('no open is stamped, no counter moves', async () => {
    await call('/api/preview/work-order/t1', USER('admin', 10));
    const writes = queries.filter(function (q) {
      return /UPDATE service_ticket_shares/.test(q.sql);
    });
    expect(writes).toEqual([]);
  });

  test('it reaches the real handler rather than 404ing early', async () => {
    await call('/api/preview/work-order/t1', USER('admin', 10));
    // The ticket lookup happened and the body ran far enough to read the
    // ticket's own child rows — which is how we know it is the real body and
    // not a stub that returns early.
    expect(queries.some(function (q) { return /FROM service_tickets WHERE id/.test(q.sql); })).toBe(true);
  });

  test('another tenant’s work order is not found', async () => {
    const r = await call('/api/preview/work-order/t_other', USER('admin', 10));
    expect(r.status).toBe(404);
  });

  test('its shares are listed so you can pick WHOSE link to look through', async () => {
    const r = await call('/api/preview/work-order/t1/shares', USER('admin', 10));
    expect(r.status).toBe(200);
    expect(r.body.shares[0].recipient_name).toBe('Ray');
  });

  test('the recording is inside the preview guard, in the crew page itself', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'service-ticket-share-routes.js'), 'utf8');
    expect(liveLines(src, 'if (!req.preview) {').length).toBe(1);
    const i = src.indexOf('if (!req.preview) {');
    const guarded = src.slice(i, i + 900);
    expect(guarded).toContain('UPDATE service_ticket_shares');
    expect(guarded).toContain("'share_opened'");
  });

  test('the preview runs the crew page’s OWN body, not a copy of it', () => {
    const prev = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'preview-routes.js'), 'utf8');
    expect(liveLines(prev, "require('./service-ticket-share-routes').crewPageBody(req, res)").length).toBe(1);
    // and it does not rebuild the payload
    expect(/publicTicket|site_photos:|send_back:/.test(prev)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CLIENT — THE DOCUMENT THEY WERE ACTUALLY SENT
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the client view is what was sent, not what exists now', () => {
  test('it serves the stored snapshot', async () => {
    const r = await call('/api/preview/client/report-share/rs1', USER('admin', 10));
    expect(r.status).toBe(200);
    expect(r.body.document.title).toBe('Final report');
    expect(r.body.preview).toBe(true);
  });

  test('reading it does not forge evidence that the client read it', async () => {
    await call('/api/preview/client/report-share/rs1', USER('admin', 10));
    const writes = queries.filter(function (q) { return /UPDATE report_shares/.test(q.sql); });
    expect(writes).toEqual([]);
  });

  test('another tenant’s share is not found', async () => {
    const r = await call('/api/preview/client/report-share/rs_other', USER('admin', 10));
    expect(r.status).toBe(404);
  });

  test('the list is scoped to this organisation', async () => {
    const r = await call('/api/preview/client/report-shares', USER('admin', 10));
    expect(r.body.shares.map(function (x) { return x.id; })).toEqual(['rs1']);
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
