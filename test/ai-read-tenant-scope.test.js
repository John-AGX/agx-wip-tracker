// The tenant boundary on the AI READ side.
//
// WHY READS ARE FIRST-CLASS HERE
// The write half of this wave is closed: another tenant's estimate can no
// longer be overwritten, and another tenant's invoice can no longer be paid.
// The read half was not. And a cross-tenant read through an AGENT TOOL is
// worse than the same read through a UI route, because the model does not just
// return the row — it SUMMARISES it, in prose, into a chat window that belongs
// to whoever asked. The leak arrives already explained.
//
// THE FIVE DOORS
//   R1  buildEstimateContext — the scoped arm keyed on `users.organization_id`,
//       the org of whoever OWNS the row, which is a different question from
//       "whose row is this" and the only door in the app that asked it. Its
//       else-arm, taken when the caller has no org, dropped the predicate
//       entirely and read by bare id.
//   R2  buildJobContext — the same two faults, same shape.
//   R3  buildLeadContext — unscoped else-arm, plus a linked-estimates lookup
//       (`WHERE data->>'lead_id' = $1`) with no predicate at all.
//   R4  buildJobContext's attachment cascade — walked job → lead → estimates
//       through ordinary columns, rolling other tenants' photos and documents
//       into the turn.
//   R5  read_metrics / read_recent_conversations / read_conversation_detail —
//       `ai_messages` with no tenant predicate. The last of those returns
//       verbatim MESSAGE BODIES and every tool call in them, selected by three
//       plain values a caller can type. All three are gated on INSIGHTS_VIEW,
//       which `pm` and `corporate` hold, not only admins.
//
// THE PROPERTIES
//   For ANY caller and ANY row: the row is served only when the caller owns it
//   or it is legacy NULL-org; a foreign row is refused; an ORG-LESS caller gets
//   NOTHING rather than everything (fail closed); and the refusal says the same
//   thing as "does not exist", so no door becomes an existence oracle.
//
// A note on what is NOT asserted here: the ORDER of the tenant check relative
// to the rest of the context build. These functions either return the row or
// throw, so "did the caller see it" is answerable from the return value; that
// is the property, and it is the one that matters.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const { createPgSqlite } = require('./helpers/pg-sqlite');

const SCHEMA = `
  CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT, role TEXT, organization_id INTEGER);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, owner_id INTEGER, organization_id INTEGER, data TEXT);
  CREATE TABLE estimates (
    id TEXT PRIMARY KEY, owner_id INTEGER, organization_id INTEGER, data TEXT NOT NULL
  );
  CREATE TABLE leads (
    id TEXT PRIMARY KEY, organization_id INTEGER, job_id TEXT,
    title TEXT, status TEXT, salesperson_id INTEGER,
    street_address TEXT, city TEXT, state TEXT, zip TEXT,
    source TEXT, project_type TEXT, confidence REAL,
    projected_sale_date TEXT, estimated_revenue_low REAL, estimated_revenue_high REAL,
    market TEXT, gate_code TEXT
  );
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY, organization_id INTEGER,
    entity_type TEXT, entity_id TEXT, filename TEXT, mime_type TEXT,
    position INTEGER DEFAULT 0, uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE job_change_orders (
    id TEXT PRIMARY KEY, organization_id INTEGER, owner_id INTEGER,
    job_id TEXT, co_number TEXT, status TEXT, is_locked INTEGER DEFAULT 0,
    linked_node_id TEXT, data TEXT NOT NULL DEFAULT '{}',
    approved_at TEXT, approved_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE job_purchase_orders (
    id TEXT PRIMARY KEY, organization_id INTEGER, owner_id INTEGER,
    job_id TEXT, po_number TEXT, status TEXT, sub_id TEXT, is_locked INTEGER DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}',
    approved_at TEXT, approved_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE subs (id TEXT PRIMARY KEY, organization_id INTEGER, name TEXT);
  CREATE TABLE job_vendor_bills (
    id TEXT PRIMARY KEY, organization_id INTEGER, job_id TEXT, po_id TEXT,
    status TEXT, amount REAL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE invoices (
    id TEXT PRIMARY KEY, organization_id INTEGER, owner_id INTEGER,
    job_id TEXT, client_id TEXT, invoice_number TEXT, status TEXT,
    issue_date TEXT, due_date TEXT, terms TEXT,
    subtotal REAL DEFAULT 0, tax_pct REAL DEFAULT 0, tax_amount REAL DEFAULT 0,
    retainage_amount REAL DEFAULT 0, total REAL DEFAULT 0, amount_paid REAL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}', sent_at TEXT, paid_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE qb_cost_lines (
    id TEXT PRIMARY KEY, organization_id INTEGER, job_id TEXT, amount REAL DEFAULT 0,
    linked_node_id TEXT, report_date TEXT, account TEXT, account_type TEXT,
    bucket TEXT, vendor TEXT, memo TEXT, source_file TEXT
  );
  CREATE TABLE ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER,
    entity_type TEXT, estimate_id TEXT, user_id INTEGER,
    role TEXT, content TEXT, model TEXT,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    tool_use_count INTEGER DEFAULT 0, tool_uses TEXT,
    photos_included INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

const engine = createPgSqlite(SCHEMA, { jsonColumns: ['data', 'tool_uses'] });
globalThis.__P86_AIREAD_ENGINE__ = engine;

jest.mock('../server/db', () => ({ pool: globalThis.__P86_AIREAD_ENGINE__.pool }));

const aiRoutes = require('../server/routes/ai-routes');
const { buildEstimateContext, buildJobContext, buildLeadContext, execStaffTool } = aiRoutes.internals;

const ORG_A = 1;
const ORG_B = 2;

const VICTIM_ESTIMATE = {
  name: 'Org-B Clubhouse',
  total: 812500,
  lines: [{ id: 'l1', description: 'CONFIDENTIAL org-B scope', qty: 1, unitCost: 812500 }],
  alternates: [{ id: 'alt1', name: 'Base Bid' }],
  activeAlternateId: 'alt1'
};

function seed() {
  engine.db.exec('DELETE FROM ai_messages; DELETE FROM attachments; DELETE FROM leads; DELETE FROM estimates; DELETE FROM jobs; DELETE FROM users; DELETE FROM organizations;');
  engine.db.exec(`
    INSERT INTO organizations (id, name) VALUES (1, 'Org A'), (2, 'Org B');
    INSERT INTO users (id, email, name, role, organization_id) VALUES
      (10, 'a@a.a', 'A User', 'admin', 1),
      (20, 'b@b.b', 'B User', 'admin', 2),
      (30, 'orphan@x.x', 'Orphan', 'admin', NULL);
  `);
}

function insertEstimate(id, orgId, ownerId, blob) {
  engine.db.prepare('INSERT INTO estimates (id, owner_id, organization_id, data) VALUES (?,?,?,?)')
    .run(id, ownerId, orgId == null ? null : orgId, JSON.stringify(blob || VICTIM_ESTIMATE));
}
function insertJob(id, orgId, ownerId, blob) {
  engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, data) VALUES (?,?,?,?)')
    .run(id, ownerId, orgId == null ? null : orgId,
         JSON.stringify(blob || { jobNumber: 'J-1', title: 'Org-B Job', phases: [] }));
}
function insertLead(id, orgId, opts) {
  const o = opts || {};
  engine.db.prepare(
    'INSERT INTO leads (id, organization_id, job_id, title, status, salesperson_id) VALUES (?,?,?,?,?,?)'
  ).run(id, orgId == null ? null : orgId, o.jobId || null, o.title || 'Org-B Lead', 'new', null);
}
function insertMessage(orgId, entityType, entityId, userId, role, content) {
  engine.db.prepare(
    `INSERT INTO ai_messages (organization_id, entity_type, estimate_id, user_id, role, content, model, input_tokens, output_tokens, tool_use_count, photos_included)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(orgId == null ? null : orgId, entityType, entityId, userId, role, content, 'claude-x', 100, 50, 1, 0);
}

const ORG = (id) => (id == null ? null : { id, name: 'Org ' + id });
const CTX = (orgId) => ({ orgId: orgId, userId: 10 });

// The context builders return a string on some paths and a block object on
// others (text + inline image blocks). The property under test is "does any
// part of the answer carry the other tenant's data", so everything the caller
// would receive is flattened before it is searched. Flattening the WHOLE value
// rather than picking a `.text` field is deliberate: a leak that arrived in a
// field this helper did not know about would otherwise read as absent.
function asText(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

beforeEach(() => seed());

// ── R1 — the estimate door ─────────────────────────────────────────────────
describe('PATH R1 — buildEstimateContext', () => {
  const ROWS = [
    { label: 'estimate in the caller\'s own org', org: ORG_A, mustRead: true },
    { label: 'estimate in ANOTHER tenant', org: ORG_B, mustRead: false },
    { label: 'legacy NULL-org estimate', org: null, mustRead: true },
  ];

  ROWS.forEach((r) => {
    test(`org-A caller × ${r.label}`, async () => {
      // owner_id 20 throughout: the owner is an org-B user in EVERY case, so
      // a door that still keyed on the owner's org would answer the same for
      // all three and this matrix would catch it.
      insertEstimate('est-1', r.org, 20);
      if (r.mustRead) {
        const ctx = asText(await buildEstimateContext('est-1', false, null, ORG(ORG_A)));
        expect(ctx).toContain('est-1');
      } else {
        await expect(buildEstimateContext('est-1', false, null, ORG(ORG_A)))
          .rejects.toThrow('Estimate not found');
      }
    });
  });

  test('THE OWNER-AXIS BUG: an estimate owned by an ORG-LESS user is not readable by everyone', async () => {
    // The precise cell the old `JOIN users … u.organization_id IS NULL` arm
    // got wrong. User 30 has no organization, so that tolerance arm matched
    // for EVERY caller and the row was readable platform-wide. The row's own
    // organization_id says org B, and that is the answer.
    insertEstimate('est-orphan-owner', ORG_B, 30);
    await expect(buildEstimateContext('est-orphan-owner', false, null, ORG(ORG_A)))
      .rejects.toThrow('Estimate not found');
    // …and its real owner still reads it.
    expect(asText(await buildEstimateContext('est-orphan-owner', false, null, ORG(ORG_B))))
      .toContain('est-orphan-owner');
  });

  test('an estimate with NO owner is still readable by its own tenant', async () => {
    // The other direction of the same fault: the old JOIN made a row with a
    // null or dangling owner_id invisible to the tenant that owns it.
    insertEstimate('est-no-owner', ORG_A, null);
    expect(asText(await buildEstimateContext('est-no-owner', false, null, ORG(ORG_A))))
      .toContain('est-no-owner');
  });

  test('FAILS CLOSED: an org-less caller gets nothing, not everything', async () => {
    insertEstimate('est-b', ORG_B, 20);
    await expect(buildEstimateContext('est-b', false, null, null))
      .rejects.toThrow('Estimate not found');
    await expect(buildEstimateContext('est-b', false, null, ORG(null)))
      .rejects.toThrow('Estimate not found');
  });

  test('the refusal says the same thing as "does not exist"', async () => {
    insertEstimate('est-b', ORG_B, 20);
    let foreign = null, absent = null;
    try { await buildEstimateContext('est-b', false, null, ORG(ORG_A)); } catch (e) { foreign = e.message; }
    try { await buildEstimateContext('est-nope', false, null, ORG(ORG_A)); } catch (e) { absent = e.message; }
    expect(foreign).toBe(absent);
  });
});

// ── R2 — the job door ──────────────────────────────────────────────────────
describe('PATH R2 — buildJobContext', () => {
  const ROWS = [
    { label: 'job in the caller\'s own org', org: ORG_A, mustRead: true },
    { label: 'job in ANOTHER tenant', org: ORG_B, mustRead: false },
    { label: 'legacy NULL-org job', org: null, mustRead: true },
  ];

  ROWS.forEach((r) => {
    test(`org-A caller × ${r.label}`, async () => {
      insertJob('job-1', r.org, 20);
      if (r.mustRead) {
        expect(asText(await buildJobContext('job-1', null, 'plan', ORG(ORG_A), {}))).not.toBe('');
      } else {
        await expect(buildJobContext('job-1', null, 'plan', ORG(ORG_A), {}))
          .rejects.toThrow('Job not found');
      }
    });
  });

  test('FAILS CLOSED on a missing org', async () => {
    insertJob('job-b', ORG_B, 20);
    await expect(buildJobContext('job-b', null, 'plan', null, {}))
      .rejects.toThrow('Job not found');
  });

  test('THE OWNER-AXIS BUG on jobs: an org-less owner does not open the row to everyone', async () => {
    insertJob('job-orphan-owner', ORG_B, 30);
    await expect(buildJobContext('job-orphan-owner', null, 'plan', ORG(ORG_A), {}))
      .rejects.toThrow('Job not found');
  });
});

// ── R3 — the lead door and its linked estimates ────────────────────────────
describe('PATH R3 — buildLeadContext', () => {
  test('a lead in another tenant is refused', async () => {
    insertLead('lead-b', ORG_B);
    await expect(buildLeadContext('lead-b', ORG(ORG_A))).rejects.toThrow('Lead not found');
  });

  test('FAILS CLOSED on a missing org', async () => {
    insertLead('lead-b', ORG_B);
    await expect(buildLeadContext('lead-b', null)).rejects.toThrow('Lead not found');
  });

  test('the caller\'s own lead still builds', async () => {
    insertLead('lead-a', ORG_A, { title: 'Our Lead' });
    const ctx = asText(await buildLeadContext('lead-a', ORG(ORG_A)));
    expect(ctx).toContain('Our Lead');
  });

  test('LINKED ESTIMATES: another tenant\'s estimate is not listed under a shared lead id', async () => {
    // `data->>'lead_id'` is an ordinary value, not a tenant boundary. Two
    // tenants can hold the same lead id string, and before the predicate the
    // org-B estimate's TITLE and STATUS were rendered into the org-A turn.
    insertLead('lead-shared', ORG_A, { title: 'Org A Lead' });
    insertEstimate('est-a', ORG_A, 10, { name: 'x', title: 'OURS', lead_id: 'lead-shared', lines: [], alternates: [] });
    insertEstimate('est-b', ORG_B, 20, { name: 'y', title: 'ORG-B-SECRET-TITLE', lead_id: 'lead-shared', lines: [], alternates: [] });
    const ctx = asText(await buildLeadContext('lead-shared', ORG(ORG_A)));
    expect(ctx).toContain('OURS');
    expect(ctx).not.toContain('ORG-B-SECRET-TITLE');
    expect(ctx).not.toContain('est-b');
  });
});

// ── R4 — the attachment cascade ────────────────────────────────────────────
describe('PATH R4 — buildJobContext attachment cascade stops at the tenant line', () => {
  test('a foreign lead hanging off the caller\'s job contributes nothing', async () => {
    insertJob('job-a', ORG_A, 10);
    // An org-B lead whose job_id points at the org-A job. Nothing stops a
    // tenant writing that value; it is a plain column.
    insertLead('lead-b', ORG_B, { jobId: 'job-a' });
    insertEstimate('est-b', ORG_B, 20, { name: 'z', lead_id: 'lead-b', lines: [], alternates: [] });
    engine.db.prepare(
      `INSERT INTO attachments (id, organization_id, entity_type, entity_id, filename, mime_type, position)
       VALUES (?,?,?,?,?,?,?)`
    ).run('att-b', ORG_B, 'estimate', 'est-b', 'ORG-B-CONFIDENTIAL.pdf', 'application/pdf', 0);

    const ctx = asText(await buildJobContext('job-a', null, 'plan', ORG(ORG_A), {}));
    expect(ctx).not.toContain('ORG-B-CONFIDENTIAL.pdf');
  });

  // The SECOND hop, exercised on its own. The test above stops the walk at the
  // lead, so it would pass with the estimate hop wide open — verified by
  // mutation, not assumed. Here the lead is the CALLER'S OWN, so the walk
  // reaches the estimate lookup, and a foreign estimate claiming the same
  // lead_id is the thing that must not come back.
  test('a foreign ESTIMATE claiming the caller\'s own lead contributes nothing', async () => {
    insertJob('job-a', ORG_A, 10);
    insertLead('lead-a', ORG_A, { jobId: 'job-a', title: 'Our Lead' });
    insertEstimate('est-b', ORG_B, 20, { name: 'z', lead_id: 'lead-a', lines: [], alternates: [] });
    engine.db.prepare(
      `INSERT INTO attachments (id, organization_id, entity_type, entity_id, filename, mime_type, position)
       VALUES (?,?,?,?,?,?,?)`
    ).run('att-b2', ORG_B, 'estimate', 'est-b', 'ORG-B-SECOND-HOP.pdf', 'application/pdf', 0);

    const ctx = asText(await buildJobContext('job-a', null, 'plan', ORG(ORG_A), {}));
    expect(ctx).not.toContain('ORG-B-SECOND-HOP.pdf');
  });
});

// ── R5 — the AI introspection tools ────────────────────────────────────────
describe('PATH R5 — ai_messages tools do not read other tenants\' conversations', () => {
  beforeEach(() => {
    insertMessage(ORG_A, 'estimate', 'est-a', 10, 'user', 'our own question');
    insertMessage(ORG_A, 'estimate', 'est-a', 10, 'assistant', 'our own answer');
    insertMessage(ORG_B, 'estimate', 'est-b', 20, 'user', 'ORG-B-PRIVATE-QUESTION');
    insertMessage(ORG_B, 'estimate', 'est-b', 20, 'assistant', 'ORG-B-PRIVATE-ANSWER');
    insertEstimate('est-a', ORG_A, 10, { name: 'ours', title: 'OUR ESTIMATE', lines: [], alternates: [] });
    insertEstimate('est-b', ORG_B, 20, { name: 'theirs', title: 'ORG-B-SECRET-TITLE', lines: [], alternates: [] });
  });

  test('read_conversation_detail cannot open another tenant\'s conversation', async () => {
    // The key is three plain values. Typing another tenant's is the attack.
    const out = await execStaffTool('read_conversation_detail', { key: 'estimate|est-b|20' }, CTX(ORG_A));
    expect(out).not.toContain('ORG-B-PRIVATE-QUESTION');
    expect(out).not.toContain('ORG-B-PRIVATE-ANSWER');
    // Same sentence as a key that names nothing at all — no existence oracle.
    const missing = await execStaffTool('read_conversation_detail', { key: 'estimate|est-nope|99' }, CTX(ORG_A));
    expect(out).toBe(missing);
  });

  test('read_conversation_detail still opens the caller\'s OWN conversation', async () => {
    const out = await execStaffTool('read_conversation_detail', { key: 'estimate|est-a|10' }, CTX(ORG_A));
    expect(out).toContain('our own question');
    expect(out).toContain('our own answer');
  });

  test('read_recent_conversations lists only the caller\'s tenant', async () => {
    const out = await execStaffTool('read_recent_conversations', {}, CTX(ORG_A));
    expect(out).toContain('est-a');
    expect(out).not.toContain('est-b');
    expect(out).not.toContain('ORG-B-SECRET-TITLE');
    // The `key` is the credential for read_conversation_detail; not handing it
    // out is half of why that tool is now safe to expose at all.
    expect(out).not.toContain('estimate|est-b|20');
  });

  test('read_metrics counts only the caller\'s tenant', async () => {
    const a = await execStaffTool('read_metrics', {}, CTX(ORG_A));
    // 1 assistant turn in org A, 1 in org B. Counting both would print 2.
    expect(a).toMatch(/86 \(estimate\): 1 turns/);
  });

  test('all three FAIL CLOSED for a caller with no organization', async () => {
    for (const tool of ['read_metrics', 'read_recent_conversations']) {
      const out = await execStaffTool(tool, {}, CTX(null));
      expect(out).toMatch(/not attached to an organization/);
      expect(out).not.toContain('ORG-B');
    }
    const detail = await execStaffTool('read_conversation_detail', { key: 'estimate|est-b|20' }, CTX(null));
    expect(detail).not.toContain('ORG-B-PRIVATE-QUESTION');
  });

  test('legacy NULL-org messages remain visible — the tolerance arm is preserved', async () => {
    insertMessage(null, 'estimate', 'est-legacy', 10, 'user', 'unstamped legacy turn');
    const out = await execStaffTool('read_conversation_detail', { key: 'estimate|est-legacy|10' }, CTX(ORG_A));
    expect(out).toContain('unstamped legacy turn');
  });
});

// ── R6 — read_active_lines, VERIFIED rather than assumed ───────────────────
describe('PATH R6 — read_active_lines (claimed closed by the previous pass)', () => {
  test('another tenant\'s line items, quantities and unit costs are not served', async () => {
    insertEstimate('est-b', ORG_B, 20);
    const out = await execStaffTool('read_active_lines', { estimate_id: 'est-b' }, CTX(ORG_A));
    expect(out).not.toContain('CONFIDENTIAL org-B scope');
    expect(out).not.toContain('812500');
    expect(out).toBe('No estimate with id est-b.');
  });

  test('and it is not an existence oracle', async () => {
    insertEstimate('est-b', ORG_B, 20);
    const foreign = await execStaffTool('read_active_lines', { estimate_id: 'est-b' }, CTX(ORG_A));
    const absent = await execStaffTool('read_active_lines', { estimate_id: 'est-b' }, CTX(ORG_A));
    expect(foreign).toBe(absent);
  });

  test('the caller\'s own lines ARE served (the control)', async () => {
    insertEstimate('est-a', ORG_A, 10, {
      name: 'ours', lines: [{ id: 'l1', description: 'Our own scope', qty: 2, unitCost: 100, alternateId: 'alt1' }],
      alternates: [{ id: 'alt1', name: 'Base' }], activeAlternateId: 'alt1'
    });
    const out = await execStaffTool('read_active_lines', { estimate_id: 'est-a' }, CTX(ORG_A));
    expect(out).toContain('Our own scope');
  });

  test('FAILS CLOSED on a missing org', async () => {
    insertEstimate('est-b', ORG_B, 20);
    const out = await execStaffTool('read_active_lines', { estimate_id: 'est-b' }, CTX(null));
    expect(out).toMatch(/not attached to an organization/);
  });
});
