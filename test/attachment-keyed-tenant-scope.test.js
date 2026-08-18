// The tenant boundary on attachment-routes.js — both of its keys.
//
// WHAT THIS FILE EXISTS FOR
// Every row-keyed door in attachment-routes.js read
//
//     SELECT * FROM attachments WHERE id = $1
//
// with no predicate and then asked hasCapability(). That is a CAPABILITY
// answer — "may this role do this kind of thing" — standing where a TENANCY
// answer belongs. The two are not interchangeable, and the file is the clearest
// case in the repo of what happens when they are treated as if they were: an
// org-A admin could delete an org-B row (and the storage blob behind it),
// rewrite its caption, and stream its BYTES back through /raw/:id.
//
// The table has carried organization_id since Wave 1.A Phase 2, complete with
// an index and a backfill. No door read it, and the upload INSERT never wrote
// it. A column added for tenancy that no door consults is not a boundary.
//
// The property under test is therefore not "the row carries the right org":
//
//   every statement reachable by a caller-supplied attachment id, or by a
//   caller-supplied (entity_type, entity_id) pair, proves that key belongs to
//   the caller's tenant BEFORE it reads or writes.
//
// TWO THINGS THIS FILE ALSO PINS THAT ARE NOT THE FINDING
//   • Route ORDER. POST /:id/move and /:id/copy were registered AFTER the
//     two-segment POST /:entityType/:entityId, which swallowed them as
//     entityType='att_x' and answered 400 "Bad entity type". My Files' "Move
//     to" / "Copy to" were unreachable in production for everyone. The tests
//     below assert they are reachable AND scoped — un-shadowing a route that
//     hides an unscoped write is only safe in that order.
//   • Auditing by DOOR rather than by finding. Four doors were reported; the
//     scan behind POST /extract-text was the fifth, and it both rewrote and
//     listed the filenames of every tenant's rows.

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

// Storage is the thing DELETE destroys before the row goes, so the spy on it
// is the real assertion for that door — a refused delete must not have touched
// the blob.
const storageCalls = [];
jest.mock('../server/storage', () => ({
  storage: {
    delete: async (k) => { storageCalls.push(['delete', k]); },
    getBuffer: async (k) => { storageCalls.push(['get', k]); return Buffer.from('BYTES:' + k); },
    put: async (k) => { storageCalls.push(['put', k]); return 'https://cdn.test/' + k; }
  }
}));
jest.mock('../server/anthropic-files', () => ({
  eagerUploadAttachmentById: async () => {},
  deleteAnthropicFile: async () => {}
}));

// ── A table-backed fake, not a script of canned answers ───────────────────
// The predicates under test are only meaningful if a foreign row can actually
// be looked up and rejected on its contents, so the org lookups read from real
// rows rather than a handler that was told what to say.
function rowsOf(name) { return tables[name] || []; }

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: rowsOf('roles') };

  // The org lookups the predicate ladder makes.
  if (/^SELECT organization_id FROM (\w+) WHERE id = \$1/.test(text)) {
    const table = text.match(/^SELECT organization_id FROM (\w+) WHERE id = \$1/)[1];
    const hit = rowsOf(table).find((r) => String(r.id) === String(p[0]));
    return { rows: hit ? [{ organization_id: hit.organization_id }] : [] };
  }

  if (text.includes('FROM attachments WHERE id = ANY($1::text[])')) {
    const want = (p[0] || []).map(String);
    return { rows: rowsOf('attachments').filter((r) => want.includes(String(r.id))) };
  }
  if (/FROM attachments WHERE id = \$1/.test(text) && text.startsWith('SELECT')) {
    const hit = rowsOf('attachments').find((r) => String(r.id) === String(p[0]));
    return { rows: hit ? [hit] : [] };
  }
  if (text.startsWith('DELETE FROM attachments WHERE id = $1')) {
    const before = tables.attachments.length;
    tables.attachments = tables.attachments.filter((r) => String(r.id) !== String(p[0]));
    return { rows: [], rowCount: before - tables.attachments.length };
  }
  if (text.startsWith('UPDATE attachments SET')) return { rows: [], rowCount: 1 };
  if (text.includes('COALESCE(MAX(position)')) return { rows: [{ max_pos: 3 }] };
  if (text.includes('COUNT(*)::int AS c FROM attachments')) return { rows: [{ c: 0 }] };
  if (text.startsWith('INSERT INTO attachments')) return { rows: [{ id: 'att_new' }] };

  // The extract-text scan. Answered by applying the WHERE the route built, so
  // the test measures the route's own predicate rather than restating it.
  if (text.includes('FROM attachments a LEFT JOIN users u')) {
    const orgParam = p[p.length - 1];
    return { rows: rowsOf('attachments').filter((a) => {
      const u = rowsOf('users').find((x) => String(x.id) === String(a.uploaded_by));
      if (a.organization_id != null) return String(a.organization_id) === String(orgParam);
      return !u || u.organization_id == null || String(u.organization_id) === String(orgParam);
    }) };
  }

  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const {
  attachmentInOrg, attachmentEntityInOrg, entityOrgVerdict
} = require('../server/services/attachment-org-scope');
const { pool } = require('../server/db');

setRolePool(pool);

let attachmentRoutes, server, baseUrl;

const ORG_A_ADMIN = { id: 10, email: 'admin-a@a.test', role: 'admin', name: 'A', organization_id: 1 };
const ORG_B_ADMIN = { id: 77, email: 'admin-b@b.test', role: 'admin', name: 'B', organization_id: 2 };

function freshTables() {
  return {
    roles: [
      // Capability-COMPLETE, both tiers. Nothing below may be explained by a
      // missing capability — every refusal has to be the boundary.
      { name: 'admin', capabilities: ['JOBS_EDIT_ANY', 'JOBS_VIEW_ALL', 'LEADS_EDIT', 'LEADS_VIEW', 'ESTIMATES_EDIT', 'ESTIMATES_VIEW', 'ROLES_MANAGE', 'USERS_MANAGE'] },
      { name: 'system_admin', capabilities: ['JOBS_EDIT_ANY', 'JOBS_VIEW_ALL', 'LEADS_EDIT', 'LEADS_VIEW', 'ESTIMATES_EDIT', 'ESTIMATES_VIEW', 'ROLES_MANAGE', 'USERS_MANAGE', 'SYSTEM_ADMIN'] }
    ],
    users: [
      { id: 10, organization_id: 1 },
      { id: 77, organization_id: 2 },
      { id: 99, organization_id: null }
    ],
    jobs: [
      { id: 'jobA', organization_id: 1 },
      { id: 'jobB', organization_id: 2 },
      { id: 'jobLegacy', organization_id: null }
    ],
    leads: [{ id: 'leadA', organization_id: 1 }, { id: 'leadB', organization_id: 2 }],
    attachments: [
      { id: 'att_A', entity_type: 'job', entity_id: 'jobA', organization_id: 1, uploaded_by: 10,
        filename: 'a.pdf', mime_type: 'application/pdf', tags: [],
        thumb_key: null, web_key: null, original_key: 'job/jobA/att_A_orig.pdf' },
      { id: 'att_B', entity_type: 'job', entity_id: 'jobB', organization_id: 2, uploaded_by: 77,
        filename: 'b.pdf', mime_type: 'application/pdf', tags: [],
        thumb_key: null, web_key: null, original_key: 'job/jobB/att_B_orig.pdf' },
      // The population the ladder exists for: the stamp says one thing and the
      // parent says another, and the parent is what the user navigates through.
      { id: 'att_MIS', entity_type: 'job', entity_id: 'jobA', organization_id: 2, uploaded_by: 77,
        filename: 'mis.pdf', mime_type: 'application/pdf', tags: [],
        thumb_key: null, web_key: null, original_key: 'job/jobA/att_MIS_orig.pdf' },
      // A legacy orphan: parent gone, no stamp, no uploader. Nothing names a
      // tenant, so nothing may be inferred — and nobody gets locked out.
      { id: 'att_ORPH', entity_type: 'lead', entity_id: 'leadGONE', organization_id: null, uploaded_by: null,
        filename: 'orphan.pdf', mime_type: 'application/pdf', tags: [],
        thumb_key: null, web_key: null, original_key: 'lead/leadGONE/o.pdf' }
    ]
  };
}

beforeAll(async () => {
  queries = []; tables = freshTables();
  await refreshRoleCache();
  attachmentRoutes = require('../server/routes/attachment-routes');
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
  try { json = JSON.parse(text); } catch (e) { /* raw bytes / plain text */ }
  return { status: res.status, body: json, text };
}

function attachmentWrite() {
  return queries.find((q) => /^(UPDATE attachments|DELETE FROM attachments|INSERT INTO attachments)/i.test(q.sql));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. The predicate itself, before any door uses it.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the predicate', () => {
  test('the parent entity decides — same tenant reaches, another does not', async () => {
    expect(await entityOrgVerdict(pool, 'job', 'jobA', 1)).toBe('in');
    expect(await entityOrgVerdict(pool, 'job', 'jobB', 1)).toBe('out');
  });

  test('a legacy un-stamped parent is reachable — the same tolerance every read carries', async () => {
    expect(await entityOrgVerdict(pool, 'job', 'jobLegacy', 1)).toBe('in');
    expect(await entityOrgVerdict(pool, 'job', 'jobLegacy', null)).toBe('in');
  });

  test('a caller who names no tenant may not touch one that does', async () => {
    expect(await entityOrgVerdict(pool, 'job', 'jobA', null)).toBe('out');
  });

  test('the org bucket IS the tenant, and needs no lookup to say so', async () => {
    expect(await entityOrgVerdict(pool, 'org', '1', 1)).toBe('in');
    expect(await entityOrgVerdict(pool, 'org', '2', 1)).toBe('out');
    expect(await entityOrgVerdict(pool, 'org', '1', null)).toBe('out');
  });

  test('the personal bucket resolves through its owner — this is where isAdminish used to cross', async () => {
    expect(await entityOrgVerdict(pool, 'user', '10', 1)).toBe('in');
    expect(await entityOrgVerdict(pool, 'user', '77', 1)).toBe('out');
  });

  test('an entity type with no table cannot be scoped, so it is not "in"', async () => {
    expect(await entityOrgVerdict(pool, 'wormhole', 'x', 1)).toBe('unknown');
    expect(await attachmentEntityInOrg(pool, 'wormhole', 'x', 1)).toBe(false);
  });

  test('an ABSENT entity is refused exactly like a foreign one — no oracle', async () => {
    expect(await attachmentEntityInOrg(pool, 'job', 'jobNOPE', 1)).toBe(false);
    expect(await attachmentEntityInOrg(pool, 'job', 'jobB', 1)).toBe(false);
  });

  test('the row ladder prefers the PARENT over the row stamp', async () => {
    const mis = tables.attachments.find((a) => a.id === 'att_MIS');
    // Stamp says org 2, parent job says org 1. The parent wins, because it is
    // NOT NULL on every row while the stamp was unwritten by the upload path
    // until this commit — anchoring on the stamp would have put every recent
    // row in the IS NULL tolerance arm.
    expect(await attachmentInOrg(pool, mis, 1)).toBe(true);
    expect(await attachmentInOrg(pool, mis, 2)).toBe(false);
  });

  test('an orphan with a stamp falls through to the stamp', async () => {
    const orphan = { entity_type: 'lead', entity_id: 'GONE', organization_id: 2, uploaded_by: null };
    expect(await attachmentInOrg(pool, orphan, 2)).toBe(true);
    expect(await attachmentInOrg(pool, orphan, 1)).toBe(false);
  });

  test('an orphan with neither stamp nor parent falls through to the UPLOADER', async () => {
    const orphan = { entity_type: 'lead', entity_id: 'GONE', organization_id: null, uploaded_by: 77 };
    expect(await attachmentInOrg(pool, orphan, 2)).toBe(true);
    expect(await attachmentInOrg(pool, orphan, 1)).toBe(false);
  });

  test('when NOTHING names a tenant the row is reachable — a shrug is not a verdict', async () => {
    const orphan = tables.attachments.find((a) => a.id === 'att_ORPH');
    expect(await attachmentInOrg(pool, orphan, 1)).toBe(true);
    expect(await attachmentInOrg(pool, orphan, 2)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Every row-keyed door refuses a foreign attachment id.
 *    A capability-COMPLETE org admin is the caller throughout, so nothing here
 *    can be explained away as a missing capability.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a foreign-tenant attachment is not an attachment you can touch', () => {
  test('GET /raw/:id — the BYTES do not come back', async () => {
    const r = await call('GET', '/api/attachments/raw/att_B?variant=original', ORG_A_ADMIN);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('BYTES:');
    expect(storageCalls.length).toBe(0);
  });

  test('DELETE /:id — the row survives AND the storage blob is never touched', async () => {
    const r = await call('DELETE', '/api/attachments/att_B', ORG_A_ADMIN);
    expect(r.status).toBe(404);
    expect(tables.attachments.some((a) => a.id === 'att_B')).toBe(true);
    // The order matters: the handler deletes blobs BEFORE the row, so a
    // predicate placed after the capability check would already have destroyed
    // the file by the time it refused.
    expect(storageCalls).toEqual([]);
    expect(attachmentWrite()).toBeUndefined();
  });

  test('PUT /:id — the caption is not rewritten', async () => {
    const r = await call('PUT', '/api/attachments/att_B', ORG_A_ADMIN, { caption: 'HIJACKED' });
    expect(r.status).toBe(404);
    expect(attachmentWrite()).toBeUndefined();
  });

  test('POST /bulk-tag — one foreign id fails the batch, and nothing is written', async () => {
    const r = await call('POST', '/api/attachments/bulk-tag', ORG_A_ADMIN, {
      ids: ['att_B'], add: ['pwned']
    });
    expect(r.status).toBe(404);
    expect(attachmentWrite()).toBeUndefined();
  });

  test('POST /bulk-tag — a foreign id smuggled beside a legitimate one still fails closed', async () => {
    // The same-entity check the route already had is a capability convenience
    // keyed on rows[0], not a boundary. Give it a batch that passes that check
    // and still crosses: both rows hang on jobA, but att_MIS is org B's stamp.
    const r = await call('POST', '/api/attachments/bulk-tag', ORG_B_ADMIN, {
      ids: ['att_MIS', 'att_A'], add: ['pwned']
    });
    expect(r.status).toBe(404);
    expect(attachmentWrite()).toBeUndefined();
  });

  test('POST /:id/move — a foreign SOURCE is refused, and no UPDATE runs', async () => {
    const r = await call('POST', '/api/attachments/att_B/move', ORG_A_ADMIN, {
      entity_type: 'job', entity_id: 'jobA'
    });
    expect(r.status).toBe(404);
    expect(attachmentWrite()).toBeUndefined();
  });

  test('POST /:id/move — my own file may not be pushed INTO another tenant', async () => {
    const r = await call('POST', '/api/attachments/att_A/move', ORG_A_ADMIN, {
      entity_type: 'job', entity_id: 'jobB'
    });
    expect(r.status).toBe(404);
    expect(attachmentWrite()).toBeUndefined();
  });

  test('POST /:id/copy — a foreign SOURCE is refused before any byte is read', async () => {
    const r = await call('POST', '/api/attachments/att_B/copy', ORG_A_ADMIN, {
      entity_type: 'job', entity_id: 'jobA'
    });
    expect(r.status).toBe(404);
    expect(storageCalls).toEqual([]);
    expect(attachmentWrite()).toBeUndefined();
  });

  test('POST /:id/copy — my own file may not be duplicated INTO another tenant', async () => {
    const r = await call('POST', '/api/attachments/att_A/copy', ORG_A_ADMIN, {
      entity_type: 'job', entity_id: 'jobB'
    });
    expect(r.status).toBe(404);
    expect(storageCalls).toEqual([]);
    expect(attachmentWrite()).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. Entity-keyed doors, including the ones that reach this middleware from
 *    file-folders-routes.js.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a foreign-tenant entity is not an entity you can list, tag or upload to', () => {
  test('GET /:entityType/:entityId — the list is refused, not returned empty', async () => {
    const r = await call('GET', '/api/attachments/job/jobB', ORG_A_ADMIN);
    expect(r.status).toBe(404);
  });

  test('an ABSENT entity gets the same answer a foreign one gets', async () => {
    const foreign = await call('GET', '/api/attachments/job/jobB', ORG_A_ADMIN);
    const absent = await call('GET', '/api/attachments/job/jobNOPE', ORG_A_ADMIN);
    expect(absent.status).toBe(foreign.status);
    expect(absent.body).toEqual(foreign.body);
  });

  test('GET /tags/suggest — the query-string entity is scoped too', async () => {
    const r = await call('GET', '/api/attachments/tags/suggest?entity_type=job&entity_id=jobB', ORG_A_ADMIN);
    expect(r.status).toBe(404);
  });

  test('the personal bucket: an org admin cannot reach another tenant user\'s files', async () => {
    // isAdminish() returns true for this caller, which is exactly how the old
    // ensureUserAttachmentOwner bypass crossed the boundary.
    const r = await call('GET', '/api/attachments/user/77', ORG_A_ADMIN);
    expect(r.status).toBe(404);
  });

  test('the org knowledge base: another tenant\'s bucket is not readable', async () => {
    const r = await call('GET', '/api/attachments/org/2', ORG_A_ADMIN);
    expect(r.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. The fifth door — the scan nobody reported.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('POST /extract-text scans one tenant', () => {
  test('another tenant\'s filenames are neither rewritten nor listed', async () => {
    const r = await call('POST', '/api/attachments/extract-text', ORG_A_ADMIN);
    expect(r.status).toBe(200);
    expect(r.text).toContain('a.pdf');       // mine
    expect(r.text).not.toContain('b.pdf');   // org B's, and it used to be here
  });

  test('the scan actually carries an org term — not just a filtered result', async () => {
    await call('POST', '/api/attachments/extract-text', ORG_A_ADMIN);
    const scan = queries.find((q) => /FROM attachments a LEFT JOIN users u/.test(q.sql));
    expect(scan).toBeDefined();
    expect(scan.sql).toMatch(/a\.organization_id = \$\d/);
    expect(scan.params).toContain(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. In-tenant work still works — as far as the GATE currently allows.
 *
 *    THE DOORS BELOW ARE THE ONES hasCapability() 403s TODAY, and pinning that
 *    here is the point of this block, not an accident.
 *    readCapForEntity/writeCapForEntity return a SPACE-SEPARATED LIST for
 *    job/sub/task — the documented house convention — and hasCapability() does
 *    an exact `caps.has(key)`. No capability is named
 *    "JOBS_EDIT_ANY JOBS_EDIT_OWN", so these answer 403 to EVERYONE, including
 *    the capability-complete admin below. Job/sub/task attachments have been
 *    dead in production for that reason, and the dead gate has been holding the
 *    tenancy hole above shut by accident.
 *
 *    That is why the predicates land in THIS commit and the gate in the NEXT
 *    one, in that order: repairing the gate first would flip these six doors to
 *    allowed while they were still unscoped. The follow-up commit changes each
 *    403 below to 200.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('nobody is locked out of their own tenant', () => {
  test('GET /raw/:id — reaches the gate, which is what still refuses it', async () => {
    const r = await call('GET', '/api/attachments/raw/att_A?variant=original', ORG_A_ADMIN);
    expect(r.status).toBe(403);          // gate, not boundary — 404 would be the boundary
    expect(r.text).not.toContain('BYTES:');
  });

  test('DELETE /:id — the boundary passes; the gate refuses', async () => {
    const r = await call('DELETE', '/api/attachments/att_A', ORG_A_ADMIN);
    expect(r.status).toBe(403);
    expect(storageCalls).toEqual([]);
  });

  test('PUT /:id — the boundary passes; the gate refuses', async () => {
    const r = await call('PUT', '/api/attachments/att_A', ORG_A_ADMIN, { caption: 'fine' });
    expect(r.status).toBe(403);
  });

  test('POST /bulk-tag — the boundary passes; the gate refuses', async () => {
    const r = await call('POST', '/api/attachments/bulk-tag', ORG_A_ADMIN, {
      ids: ['att_A'], add: ['ok']
    });
    expect(r.status).toBe(403);
  });

  test('GET /tags/suggest — the boundary passes; the gate refuses', async () => {
    const r = await call('GET', '/api/attachments/tags/suggest?entity_type=job&entity_id=jobA', ORG_A_ADMIN);
    expect(r.status).toBe(403);
  });

  // These two never touched the list-cap path — they were gated by
  // requireDynamicCapability, which has hand-rolled the split correctly all
  // along. They work now and must keep working.
  test('GET /:entityType/:entityId lists my own entity', async () => {
    const r = await call('GET', '/api/attachments/job/jobA', ORG_A_ADMIN);
    expect(r.status).toBe(200);
  });

  test('a legacy NULL-org parent is still reachable — the tolerance arm survives', async () => {
    const r = await call('GET', '/api/attachments/job/jobLegacy', ORG_A_ADMIN);
    expect(r.status).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. Route order. Three routes were unreachable for EVERYONE, in-tenant
 *    included. Reachable now means they get as far as the gate — the 403s
 *    below are that same gate, and they become 200s in the follow-up commit.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the shadowed routes are reachable at all', () => {
  test('POST /:id/move is no longer swallowed as entityType="att_A"', async () => {
    const r = await call('POST', '/api/attachments/att_A/move', ORG_A_ADMIN, {
      entity_type: 'job', entity_id: 'jobA'
    });
    expect(r.body).not.toEqual({ error: 'Bad entity type' });
    expect(r.status).toBe(403);
  });

  test('POST /:id/copy is no longer swallowed either', async () => {
    const r = await call('POST', '/api/attachments/att_A/copy', ORG_A_ADMIN, {
      entity_type: 'job', entity_id: 'jobA'
    });
    expect(r.body).not.toEqual({ error: 'Bad entity type' });
    expect(r.status).toBe(403);
  });

  test('GET /tags/suggest is no longer swallowed as entityType="tags"', async () => {
    const r = await call('GET', '/api/attachments/tags/suggest?entity_type=job&entity_id=jobA', ORG_A_ADMIN);
    expect(r.body).not.toEqual({ error: 'Bad entity type' });
  });

  test('the upload route they used to shadow still resolves', async () => {
    // No multipart body, so the handler's own 400 is the proof it was REACHED
    // — a routing regression would answer 404 from the predicate or 400 "Bad
    // entity type" from the wrong handler.
    const r = await call('POST', '/api/attachments/job/jobA', ORG_A_ADMIN, {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('file is required');
  });
});
