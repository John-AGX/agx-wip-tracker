// GET /api/sub-portal/attachments — what a SUBCONTRACTOR is allowed to see.
//
// Two things are pinned here, and the second one is the point of the file.
//
//   1. The folder header reads as a job. It used to render the raw
//      grant entity_type, so a sub logging into the portal saw a folder
//      titled literally "job". Every fallback (no number, no title, neither,
//      a deleted record, a grant on a type we don't name to a sub) has to
//      land somewhere human — never "job", "undefined", "null", or an id.
//
//   2. NOTHING ELSE ships. This is the guard meant to outlive the label
//      work. The route reads `SELECT a.*` and now hangs a resolved label
//      off it, which is exactly the shape where a later "just add the
//      contract total to the join" quietly exports money to an outside
//      contractor. So the fake Postgres below deliberately returns rows
//      CARRYING money, client names, OCR text and internal user ids — the
//      columns a future join would bring — and the test asserts the
//      response key set is exactly the display allowlist regardless.
//      A handler that passes its query rows straight through fails this;
//      only an explicit projection passes.
//
// If you are here because this test broke: you added a field to a
// sub-facing payload. That is a decision, not an accident. Make it on
// purpose and update SUB_FACING_KEYS below.

let mockQueries;
let mockFixture;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => {
      mockQueries.push({ sql: String(sql), params: params });
      const text = String(sql);
      if (/attachment_folder_grants/i.test(text)) return { rows: (mockFixture.grants || []).slice() };
      const byId = (list) => {
        const ids = (params && params[0]) || [];
        return { rows: (list || []).filter((r) => ids.indexOf(r.id) >= 0) };
      };
      if (/FROM jobs/i.test(text)) return byId(mockFixture.jobs);
      if (/FROM leads/i.test(text)) return byId(mockFixture.leads);
      if (/FROM clients/i.test(text)) return byId(mockFixture.clients);
      return { rows: [] };
    }
  }
}));

// requireAuth hard-fails without JWT_SECRET (A1) — and the auth path is
// explicitly NOT what this change touches, so it is stubbed to a
// pass-through and the handler is driven directly.
jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireCapability: () => (req, res, next) => next(),
  signToken: () => 'tok'
}));
jest.mock('../server/email', () => ({ sendEmail: async () => ({ ok: true }), isEnabled: () => false }));
jest.mock('../server/storage', () => ({ storage: { put: async () => 'https://cdn/x' } }));

const router = require('../server/routes/sub-portal-routes');

// ── The allowlist ────────────────────────────────────────────────────
// Every key a subcontractor receives, and nothing else. Mirrors
// SUB_ATTACHMENT_FIELDS in server/routes/sub-portal-routes.js on purpose:
// the list is declared in two places so neither can drift silently.
const SUB_FACING_KEYS = [
  'entity_id', 'entity_type', 'filename', 'folder',
  'grant_entity_id', 'grant_entity_label', 'grant_entity_type', 'grant_folder',
  'id', 'mime_type', 'original_url', 'size_bytes', 'thumb_url', 'web_url'
].sort();

// A row shaped like `SELECT a.*` really returns it, plus the columns that
// must never reach a sub. uploaded_by / extracted_text / annotations /
// anthropic_file_id / tags / *_key exist on `attachments` TODAY; the money
// and client fields stand in for a join someone adds later.
function grantRow(over) {
  return Object.assign({
    id: 'att_1',
    filename: 'Scope of Work.pdf',
    mime_type: 'application/pdf',
    size_bytes: 20481,
    thumb_url: null,
    web_url: null,
    original_url: 'https://cdn.example/att_1_orig.pdf',
    entity_type: 'job',
    entity_id: 'j1',
    folder: 'scope',
    grant_entity_type: 'job',
    grant_entity_id: 'j1',
    grant_folder: 'scope',
    position: 0,
    // ── must never ship ──────────────────────────────────────────────
    uploaded_by: 'usr_42',
    extracted_text: 'INTERNAL OCR BODY — pricing memo, do not release',
    annotations: [{ note: 'lowball their change order' }],
    anthropic_file_id: 'file_abc123',
    tags: ['internal'],
    lat: 28.5383, lng: -81.3792,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
    thumb_key: 'k_thumb', web_key: 'k_web', original_key: 'k_orig',
    organization_id: 7,
    owner_id: 'usr_1',
    contract_amount: 412500,
    total_cost: 318000,
    margin_pct: 22.9,
    budget: 400000,
    client_name: 'Waterside HOA'
  }, over || {});
}

// Fixture rows shaped the way the entity-labels SQL hands them back.
function jobRow(id, num, label) { return { id: id, num: num, label: label }; }

function attachmentsHandler() {
  const layer = router.stack.find((l) => l.route
    && l.route.path === '/sub-portal/attachments'
    && l.route.methods && l.route.methods.get);
  if (!layer) throw new Error('GET /sub-portal/attachments not found on the router');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}

async function get(user) {
  const res = fakeRes();
  await attachmentsHandler()({ user: user || { sub_id: 'sub_1', organization_id: 7 } }, res);
  return res;
}

const grantQuery = () => mockQueries.find((q) => /attachment_folder_grants/i.test(q.sql));
const jobQuery = () => mockQueries.find((q) => /FROM jobs/i.test(q.sql));

beforeEach(() => {
  mockQueries = [];
  mockFixture = { grants: [], jobs: [], leads: [], clients: [] };
});

// ─────────────────────────────────────────────────────────────────────
describe('the sub-facing payload carries ONLY display fields', () => {
  beforeEach(() => {
    mockFixture.grants = [grantRow()];
    mockFixture.jobs = [jobRow('j1', 'RV2006', 'Waterside 1 Siding Replacement')];
  });

  test('the response envelope is just { attachments }', async () => {
    const res = await get();
    expect(Object.keys(res.body)).toEqual(['attachments']);
    expect(res.body.attachments).toHaveLength(1);
  });

  test('every attachment has EXACTLY the allowlisted keys', async () => {
    const res = await get();
    res.body.attachments.forEach((a) => {
      expect(Object.keys(a).sort()).toEqual(SUB_FACING_KEYS);
    });
  });

  test('no money, cost, margin, budget or client field survives', async () => {
    const res = await get();
    const wire = JSON.stringify(res.body);
    ['412500', '318000', '22.9', '400000', 'Waterside HOA'].forEach((v) => {
      expect(wire).not.toContain(v);
    });
    // And no key that even smells like one, so a differently-named money
    // column (invoice_total, unit_price, retainage…) is caught too.
    res.body.attachments.forEach((a) => {
      Object.keys(a).forEach((k) => {
        expect(k).not.toMatch(/amount|cost|price|margin|budget|revenue|profit|total|retain|invoice|client|owner|organization/i);
      });
    });
  });

  test('internal-only attachment columns are dropped', async () => {
    const res = await get();
    const wire = JSON.stringify(res.body);
    // OCR body, annotations, the uploading employee, storage keys, the AI
    // file handle — all present on the row the query returned.
    ['INTERNAL OCR BODY', 'lowball', 'usr_42', 'usr_1', 'file_abc123', 'k_orig'].forEach((v) => {
      expect(wire).not.toContain(v);
    });
    const a = res.body.attachments[0];
    ['uploaded_by', 'extracted_text', 'annotations', 'anthropic_file_id', 'tags',
      'organization_id', 'owner_id', 'thumb_key', 'web_key', 'original_key',
      'lat', 'lng', 'position', 'created_at', 'updated_at'].forEach((k) => {
      expect(a).not.toHaveProperty(k);
    });
  });

  test('the fields the portal actually paints are all present', async () => {
    const a = (await get()).body.attachments[0];
    expect(a.id).toBe('att_1');
    expect(a.filename).toBe('Scope of Work.pdf');
    expect(a.mime_type).toBe('application/pdf');
    expect(a.size_bytes).toBe(20481);
    expect(a.original_url).toBe('https://cdn.example/att_1_orig.pdf');
  });

  test('the RAW grant coordinates survive — the upload re-check runs on them', async () => {
    // portal.html echoes these back on POST, where the grant is verified
    // again. Replacing them with the label would 403 every upload.
    const a = (await get()).body.attachments[0];
    expect(a.grant_entity_type).toBe('job');
    expect(a.grant_entity_id).toBe('j1');
    expect(a.grant_folder).toBe('scope');
    expect(a.entity_type).toBe('job');
    expect(a.entity_id).toBe('j1');
    expect(a.folder).toBe('scope');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('security scope is unchanged by the label pass', () => {
  test('the listing is still driven by g.sub_id from the JWT', async () => {
    mockFixture.grants = [grantRow()];
    mockFixture.jobs = [jobRow('j1', 'RV2006', 'Waterside 1')];
    await get({ sub_id: 'sub_1', organization_id: 7 });
    const q = grantQuery();
    expect(q.sql).toMatch(/WHERE g\.sub_id = \$1/);
    expect(q.params).toEqual(['sub_1']);
  });

  test('a request with no sub_id is refused before any query runs', async () => {
    const res = await get({ organization_id: 7 });
    expect(res.statusCode).toBe(403);
    expect(mockQueries).toHaveLength(0);
  });

  test('labels are looked up BY the granted ids — the join cannot widen', async () => {
    // Two grants on j1, one on j2; a third job exists that the sub holds no
    // grant for. It must never be asked about, let alone returned.
    mockFixture.grants = [
      grantRow({ id: 'att_1', grant_entity_id: 'j1', entity_id: 'j1' }),
      grantRow({ id: 'att_2', grant_entity_id: 'j1', entity_id: 'j1', grant_folder: 'photos', folder: 'photos' }),
      grantRow({ id: 'att_3', grant_entity_id: 'j2', entity_id: 'j2' })
    ];
    mockFixture.jobs = [
      jobRow('j1', 'RV2006', 'Waterside 1'),
      jobRow('j2', 'RV2010', 'Fairways'),
      jobRow('j3', 'RV2099', 'A JOB THIS SUB CANNOT SEE')
    ];
    const res = await get();
    // Deduped to the granted ids only.
    expect(jobQuery().params[0].sort()).toEqual(['j1', 'j2']);
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain('RV2099');
    expect(wire).not.toContain('A JOB THIS SUB CANNOT SEE');
    // One row out per row in — the label pass adds and drops nothing.
    expect(res.body.attachments).toHaveLength(3);
  });

  test('no grants → no label query at all', async () => {
    const res = await get();
    expect(res.body.attachments).toEqual([]);
    expect(mockQueries.filter((q) => /FROM jobs|FROM leads/i.test(q.sql))).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('the folder header never renders a raw type or id', () => {
  const labelOf = async () => (await get()).body.attachments[0].grant_entity_label;

  test('a normal job → jobNumber + title, the one app-wide format', async () => {
    mockFixture.grants = [grantRow()];
    mockFixture.jobs = [jobRow('j1', 'RV2006', 'Waterside 1 Siding Replacement')];
    expect(await labelOf()).toBe('RV2006 Waterside 1 Siding Replacement');
  });

  test('job with a number but no title → the number alone', async () => {
    mockFixture.grants = [grantRow()];
    mockFixture.jobs = [jobRow('j1', 'RV2006', '')];
    expect(await labelOf()).toBe('RV2006');
  });

  test('job with a title but no number → the title alone', async () => {
    mockFixture.grants = [grantRow()];
    mockFixture.jobs = [jobRow('j1', '', 'Waterside 1')];
    expect(await labelOf()).toBe('Waterside 1');
  });

  test('job with neither → "Untitled job", not the type, not the id', async () => {
    mockFixture.grants = [grantRow()];
    mockFixture.jobs = [jobRow('j1', '', '')];
    const label = await labelOf();
    expect(label).toBe('Untitled job');
    expect(label).not.toBe('job');
    expect(label).not.toContain('j1');
  });

  test('a grant whose job row is gone → null, and the page says "Shared files"', async () => {
    mockFixture.grants = [grantRow()];
    mockFixture.jobs = [];
    expect(await labelOf()).toBeNull();
  });

  test('a lead grant → the lead title', async () => {
    mockFixture.grants = [grantRow({ grant_entity_type: 'lead', grant_entity_id: 'l9', entity_type: 'lead', entity_id: 'l9' })];
    mockFixture.leads = [{ id: 'l9', label: 'Waterside 1 Siding Replacement' }];
    expect(await labelOf()).toBe('Waterside 1 Siding Replacement');
  });

  test('a CLIENT grant is never named to a sub — no label, no clients query', async () => {
    // Naming the client on a sub-facing surface is the leak this whitelist
    // exists to prevent; same reasoning covers `sub` and `estimate`.
    mockFixture.grants = [grantRow({ grant_entity_type: 'client', grant_entity_id: 'c3', entity_type: 'client', entity_id: 'c3' })];
    mockFixture.clients = [{ id: 'c3', label: 'Waterside HOA' }];
    const res = await get();
    expect(res.body.attachments[0].grant_entity_label).toBeNull();
    expect(mockQueries.filter((q) => /FROM clients/i.test(q.sql))).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('Waterside HOA');
  });

  test('an unrecognised grant type fails CLOSED — no label, never the slug', async () => {
    mockFixture.grants = [grantRow({ grant_entity_type: 'warrantyclaim', grant_entity_id: 'w1' })];
    const res = await get();
    expect(res.body.attachments[0].grant_entity_label).toBeNull();
  });

  test('no label is ever the string "job", "undefined" or "null"', async () => {
    mockFixture.grants = [
      grantRow({ id: 'att_1', grant_entity_id: 'j1', entity_id: 'j1' }),
      grantRow({ id: 'att_2', grant_entity_id: 'jgone', entity_id: 'jgone' }),
      grantRow({ id: 'att_3', grant_entity_type: 'client', grant_entity_id: 'c3' })
    ];
    mockFixture.jobs = [jobRow('j1', '', '')];
    const res = await get();
    res.body.attachments.forEach((a) => {
      const l = a.grant_entity_label;
      expect(l === null || (typeof l === 'string' && l.trim() !== '')).toBe(true);
      expect(l).not.toBe('job');
      expect(l).not.toBe('undefined');
      expect(l).not.toBe('null');
    });
  });
});
