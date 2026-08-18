// Two doors that shared one shape: the row was found without a predicate and
// then written without one either.
//
// N2 — POST /api/clients/:id/notes and DELETE /:id/notes/:noteId.
//   `SELECT id FROM clients WHERE id = $1` then `UPDATE clients ... WHERE id`,
//   both unscoped, gated only on ESTIMATES_EDIT. Its SIBLING,
//   DELETE /api/clients/:id, has been org-scoped since Wave 1.A Phase 2 — so
//   the file already knew the rule and applied it one endpoint over. The notes
//   these write are auto-injected into 86's system prompt, and the file's own
//   header says "the agent path goes through tool execution, which uses these
//   same endpoints under the hood": a prompt-injected client id arrives here.
//
// N3 — DELETE /api/messages/:id.
//   `SELECT user_id FROM messages WHERE id = $1`, then author-OR-isAdminish.
//   isAdminish is a ROLE answer and is true for an org-A admin standing in
//   front of an org-B row, so "author or admin" resolved to "any admin, any
//   tenant". `messages` carries organization_id — and 79b52ed edited THIS FILE
//   to stamp the INSERT with it while leaving this door unscoped. Third
//   recurrence of stamp-without-door, which is the interaction that makes
//   detection worse rather than better: a forged row lands correctly stamped.
//
// BOTH STATEMENTS, NOT JUST THE READ. A pre-check that the write does not
// repeat is a TOCTOU, so each test below asserts on the WRITE — the row is
// still there, and the UPDATE/DELETE carried the org term.

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
jest.mock('../server/email', () => ({ sendEmail: async () => ({}), sendForEvent: async () => ({}), isEnabled: () => false }));

function rowsOf(n) { return tables[n] || []; }

// Apply an `(organization_id = $n OR organization_id IS NULL)` term the way
// Postgres would, reading it off the SQL the route actually built. If a route
// stops binding the term, these helpers stop filtering and the tests go red —
// which is the point: the assertion is on the STATEMENT, not on a mock that
// was told the right answer.
function orgTermOk(sql, row, orgParamValue) {
  if (!/organization_id = \$\d+ OR organization_id IS NULL/.test(sql)) return true;  // unscoped
  if (row.organization_id == null) return true;
  return String(row.organization_id) === String(orgParamValue);
}

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: rowsOf('roles') };

  // ── clients ──────────────────────────────────────────────────────────
  if (/^SELECT id FROM clients WHERE id = \$1/.test(text)) {
    const hit = rowsOf('clients').find((c) => String(c.id) === String(p[0]));
    if (!hit || !orgTermOk(text, hit, p[1])) return { rows: [] };
    return { rows: [{ id: hit.id }] };
  }
  if (text.startsWith('UPDATE clients SET agent_notes')) {
    const id = p[1];
    const hit = rowsOf('clients').find((c) => String(c.id) === String(id));
    const orgParam = p[2];
    if (!hit || !orgTermOk(text, hit, orgParam)) return { rows: [], rowCount: 0 };
    // Append (POST) or filter (DELETE) — enough fidelity to prove the write ran.
    if (/agent_notes, '\[\]'::jsonb\) \|\| \$1::jsonb/.test(text)) {
      hit.agent_notes = (hit.agent_notes || []).concat(JSON.parse(p[0]));
    } else {
      hit.agent_notes = (hit.agent_notes || []).filter((n) => n.id !== p[0]);
    }
    return { rows: [{ agent_notes: hit.agent_notes }], rowCount: 1 };
  }

  // ── messages ─────────────────────────────────────────────────────────
  if (/^SELECT user_id.* FROM messages WHERE id = \$1/.test(text)) {
    const hit = rowsOf('messages').find((m) => String(m.id) === String(p[0]));
    return { rows: hit ? [hit] : [] };
  }
  if (text.startsWith('DELETE FROM messages WHERE id = $1')) {
    const hit = rowsOf('messages').find((m) => String(m.id) === String(p[0]));
    if (!hit || !orgTermOk(text, hit, p[1])) return { rows: [], rowCount: 0 };
    tables.messages = tables.messages.filter((m) => m !== hit);
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');
setRolePool(pool);

let server, baseUrl;

const ORG_A_ADMIN = { id: 10, email: 'a@a.test', role: 'admin', name: 'A', organization_id: 1 };
const ORG_A_PM    = { id: 11, email: 'pm@a.test', role: 'pm', name: 'PM', organization_id: 1 };

function freshTables() {
  return {
    roles: [
      { name: 'admin', capabilities: ['ESTIMATES_EDIT', 'ESTIMATES_VIEW', 'USERS_MANAGE', 'ROLES_MANAGE'] },
      { name: 'pm', capabilities: ['ESTIMATES_EDIT', 'ESTIMATES_VIEW'] }
    ],
    clients: [
      { id: 'cli_A', organization_id: 1, agent_notes: [] },
      { id: 'cli_B', organization_id: 2, agent_notes: [{ id: 'note_B', body: 'theirs' }] },
      { id: 'cli_LEGACY', organization_id: null, agent_notes: [] }
    ],
    messages: [
      { id: 'msg_A', user_id: 11, organization_id: 1 },
      { id: 'msg_B', user_id: 77, organization_id: 2 },
      { id: 'msg_LEGACY', user_id: 99, organization_id: null }
    ]
  };
}

beforeAll(async () => {
  queries = []; tables = freshTables();
  await refreshRoleCache();
  const clientRoutes = require('../server/routes/client-routes');
  const messageRoutes = require('../server/routes/message-routes');
  const app = express();
  app.use(express.json());
  app.use('/api/clients', clientRoutes);
  app.use('/api/messages', messageRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
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
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

function clientWrite() { return queries.find((q) => /^UPDATE clients/i.test(q.sql)); }
function messageDelete() { return queries.find((q) => /^DELETE FROM messages/i.test(q.sql)); }

/* ═══════════════════════════════════════════════════════════════════════════
 * N2 — clients agent_notes
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a foreign-tenant client is not a client you can annotate', () => {
  test('POST /:id/notes — the note is not written', async () => {
    const r = await call('POST', '/api/clients/cli_B/notes', ORG_A_ADMIN, { body: 'planted' });
    expect(r.status).toBe(404);
    expect(clientWrite()).toBeUndefined();
    expect(tables.clients.find((c) => c.id === 'cli_B').agent_notes.length).toBe(1);
  });

  test('DELETE /:id/notes/:noteId — their note survives', async () => {
    const r = await call('DELETE', '/api/clients/cli_B/notes/note_B', ORG_A_ADMIN);
    expect(r.status).toBe(404);
    expect(clientWrite()).toBeUndefined();
    expect(tables.clients.find((c) => c.id === 'cli_B').agent_notes.length).toBe(1);
  });

  test('the refusal matches an absent client exactly', async () => {
    const foreign = await call('POST', '/api/clients/cli_B/notes', ORG_A_ADMIN, { body: 'x' });
    const absent = await call('POST', '/api/clients/cli_NOPE/notes', ORG_A_ADMIN, { body: 'x' });
    expect(absent.status).toBe(foreign.status);
    expect(absent.body).toEqual(foreign.body);
  });

  test('the WRITE carries the org term, not just the read', async () => {
    await call('POST', '/api/clients/cli_A/notes', ORG_A_ADMIN, { body: 'mine' });
    const w = clientWrite();
    expect(w).toBeDefined();
    // A pre-check the write does not repeat is a TOCTOU, not a boundary.
    expect(w.sql).toMatch(/organization_id = \$\d+ OR organization_id IS NULL/);
    expect(w.params).toContain(1);
  });

  test('my own client still takes notes, and legacy NULL-org still works', async () => {
    const mine = await call('POST', '/api/clients/cli_A/notes', ORG_A_ADMIN, { body: 'mine' });
    expect(mine.status).toBe(200);
    expect(tables.clients.find((c) => c.id === 'cli_A').agent_notes.length).toBe(1);

    const legacy = await call('POST', '/api/clients/cli_LEGACY/notes', ORG_A_ADMIN, { body: 'ok' });
    expect(legacy.status).toBe(200);
  });

  test('a note I just added is removable', async () => {
    await call('POST', '/api/clients/cli_A/notes', ORG_A_ADMIN, { body: 'mine' });
    const noteId = tables.clients.find((c) => c.id === 'cli_A').agent_notes[0].id;
    const r = await call('DELETE', '/api/clients/cli_A/notes/' + noteId, ORG_A_ADMIN);
    expect(r.status).toBe(200);
    expect(tables.clients.find((c) => c.id === 'cli_A').agent_notes.length).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * N3 — messages
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a foreign-tenant message is not a message an admin can delete', () => {
  test('DELETE /:id — org B keeps its row', async () => {
    const r = await call('DELETE', '/api/messages/msg_B', ORG_A_ADMIN);
    expect(r.status).toBe(404);
    expect(tables.messages.some((m) => m.id === 'msg_B')).toBe(true);
    expect(messageDelete()).toBeUndefined();
  });

  test('the tenancy refusal is a 404 and the capability refusal is still a 403', async () => {
    // Two different questions, two different answers. A 403 for the foreign row
    // would make this an enumerator; a 404 for the in-tenant non-author would
    // make a real permissions message unreadable.
    const foreign = await call('DELETE', '/api/messages/msg_B', ORG_A_ADMIN);
    expect(foreign.status).toBe(404);

    // Same tenant, not the author, not an admin.
    tables.messages.push({ id: 'msg_A2', user_id: 12, organization_id: 1 });
    const notMine = await call('DELETE', '/api/messages/msg_A2', ORG_A_PM);
    expect(notMine.status).toBe(403);
  });

  test('the DELETE carries the org term, not just the read', async () => {
    await call('DELETE', '/api/messages/msg_A', ORG_A_ADMIN);
    const d = messageDelete();
    expect(d).toBeDefined();
    expect(d.sql).toMatch(/organization_id = \$\d+ OR organization_id IS NULL/);
  });

  test('an admin still deletes in their own tenant, and an author still deletes their own', async () => {
    expect((await call('DELETE', '/api/messages/msg_A', ORG_A_ADMIN)).status).toBe(200);
    tables = freshTables();
    expect((await call('DELETE', '/api/messages/msg_A', ORG_A_PM)).status).toBe(200);   // author id 11
  });

  test('a legacy NULL-org message is still deletable — the tolerance arm survives', async () => {
    const r = await call('DELETE', '/api/messages/msg_LEGACY', ORG_A_ADMIN);
    expect(r.status).toBe(200);
  });
});
