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

  // ── N4: the thread door ──────────────────────────────────────────────
  // services/thread-org-scope.js asks the PARENT first, through
  // attachment-org-scope's entityOrgVerdict, so the mock has to answer the
  // same statements that file issues.
  if (/^SELECT organization_id FROM jobs WHERE id = \$1 LIMIT 1/.test(text)) {
    const hit = rowsOf('jobs').find((j) => String(j.id) === String(p[0]));
    return { rows: hit ? [{ organization_id: hit.organization_id }] : [] };
  }
  if (/^SELECT organization_id FROM users WHERE id = \$1/.test(text)) {
    const hit = rowsOf('users').find((u) => String(u.id) === String(p[0]));
    return { rows: hit ? [{ organization_id: hit.organization_id }] : [] };
  }
  if (/^SELECT id, entity_type, entity_id, organization_id, uploaded_by FROM attachments WHERE id = \$1/.test(text)) {
    const hit = rowsOf('attachments').find((a) => String(a.id) === String(p[0]));
    return { rows: hit ? [hit] : [] };
  }
  if (/^SELECT data FROM jobs WHERE id = \$1/.test(text)) {
    const hit = rowsOf('jobs').find((j) => String(j.id) === String(p[0]));
    if (!hit || !orgTermOk(text, hit, p[1])) return { rows: [] };
    return { rows: [{ data: hit.data || {} }] };
  }
  if (/^SELECT organization_id FROM estimates WHERE id = \$1 LIMIT 1/.test(text)) {
    const hit = rowsOf('estimates').find((e) => String(e.id) === String(p[0]));
    return { rows: hit ? [{ organization_id: hit.organization_id }] : [] };
  }
  if (/^SELECT organization_id FROM leads WHERE id = \$1 LIMIT 1/.test(text)) {
    const hit = rowsOf('leads').find((l) => String(l.id) === String(p[0]));
    return { rows: hit ? [{ organization_id: hit.organization_id }] : [] };
  }
  if (/^SELECT data FROM estimates WHERE id = \$1/.test(text)) {
    const hit = rowsOf('estimates').find((e) => String(e.id) === String(p[0]));
    if (!hit || !orgTermOk(text, hit, p[1])) return { rows: [] };
    return { rows: [{ data: hit.data || {} }] };
  }
  // The thread read. Its org term is what layer 2 is; orgTermOk reads it off
  // the statement, so dropping the term stops this filtering and goes red.
  if (/FROM messages m/.test(text) && /WHERE m\.thread_key = \$1/.test(text)) {
    const rows = rowsOf('messages')
      .filter((m) => String(m.thread_key) === String(p[0]))
      .filter((m) => {
        if (!/m\.organization_id = \$\d+ OR m\.organization_id IS NULL/.test(text)) return true;
        return m.organization_id == null || String(m.organization_id) === String(p[1]);
      });
    return { rows: rows };
  }
  if (/^SELECT m\.id, m\.thread_key/.test(text) && /WHERE m\.id = \$1/.test(text)) {
    const hit = rowsOf('messages').find((m) => String(m.id) === String(p[0]));
    return { rows: hit ? [hit] : [] };
  }
  if (/^INSERT INTO messages \(id, thread_key, user_id, body, organization_id\)/.test(text)) {
    tables.messages.push({ id: p[0], thread_key: p[1], user_id: p[2], body: p[3], organization_id: 1 });
    return { rows: [], rowCount: 1 };
  }
  if (/^INSERT INTO message_reads/.test(text)) return { rows: [], rowCount: 1 };
  // thread-org-scope's last rung: does this thread hold a message of ours?
  // orgTermOk, not a hand-rolled filter on p[1] — the caller passes orgId
  // whether or not the SQL binds it, so filtering on the param regardless
  // made dropping the term from the STATEMENT invisible. Caught by mutation.
  if (/^SELECT 1 FROM messages WHERE thread_key = \$1/.test(text)) {
    const hit = rowsOf('messages').find((m) =>
      String(m.thread_key) === String(p[0]) && orgTermOk(text, m, p[1]));
    return { rows: hit ? [{ '1': 1 }] : [] };
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
      { id: 'msg_LEGACY', user_id: 99, organization_id: null },
      // N4 — comments on a thread, one per tenant, on the SAME job keys the
      // tests below name. The org-B rows are what an unscoped read handed over.
      { id: 'cmt_A', thread_key: 'job:job_A', user_id: 11, organization_id: 1, body: 'ours' },
      { id: 'cmt_B', thread_key: 'job:job_B', user_id: 77, organization_id: 2, body: 'theirs' },
      // A planted org-B row sitting inside OUR thread: the shape the unscoped
      // POST produced, and what layer 2 has to filter even on our own job.
      { id: 'cmt_PLANT', thread_key: 'job:job_A', user_id: 77, organization_id: 2, body: 'planted' }
    ],
    jobs: [
      { id: 'job_A', organization_id: 1, data: { jobNumber: 'S1', title: 'Ours' } },
      { id: 'job_B', organization_id: 2, data: { jobNumber: 'S2', title: 'Theirs' } },
      { id: 'job_LEGACY', organization_id: null, data: { jobNumber: 'S0', title: 'Legacy' } }
    ],
    attachments: [
      { id: 'att_A', entity_type: 'job', entity_id: 'job_A', organization_id: 1, uploaded_by: 11 },
      { id: 'att_B', entity_type: 'job', entity_id: 'job_B', organization_id: 2, uploaded_by: 77 }
    ],
    users: [
      { id: 11, organization_id: 1 },
      { id: 77, organization_id: 2 }
    ],
    estimates: [],
    leads: []
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

/* ═══════════════════════════════════════════════════════════════════════════
 * N4 — the THREAD KEY itself, on GET and POST /api/messages/:threadKey
 *
 * The fourth recurrence, and the one the file's own header predicted. Both
 * doors checked isValidThreadKey (a SHAPE check) and isForbiddenDm — which
 * returns FALSE for every non-DM key on purpose, because entity threads are
 * meant to be shared inside an organization. Nothing established WHICH
 * organization. So an org-A user could name an org-B job and read its
 * comments, and POST stamped the row with the AUTHOR's organization_id,
 * landing an org-A row inside org-B's thread: a forged row that looks
 * correctly stamped, which is exactly what services/attachment-org-scope.js
 * warns about for this table by name.
 *
 * TWO LAYERS, and each test says which one it is about. The door refuses a
 * known-foreign entity; the read scopes the rows regardless, so a thread whose
 * job has been deleted still shows the caller only their own messages.
 * ══════════════════════════════════════════════════════════════════════════*/
describe("a foreign tenant's thread is not a thread you can read or post to", () => {
  const threadRead = () => queries.find((q) => /FROM messages m/.test(q.sql) && /thread_key = \$1/.test(q.sql));
  const threadInsert = () => queries.find((q) => /^INSERT INTO messages \(id, thread_key/i.test(q.sql));

  test('LAYER 1 — GET on their job refuses, and never reads the rows', async () => {
    const r = await call('GET', '/api/messages/job:job_B', ORG_A_ADMIN);
    expect(r.status).toBe(404);
    expect(threadRead()).toBeUndefined();
  });

  test('LAYER 1 — POST into their job writes nothing', async () => {
    const r = await call('POST', '/api/messages/job:job_B', ORG_A_ADMIN, { body: 'planted' });
    expect(r.status).toBe(404);
    expect(threadInsert()).toBeUndefined();
    expect(tables.messages.filter((m) => m.thread_key === 'job:job_B').length).toBe(1);
  });

  test('NO EXISTENCE ORACLE — a foreign job and an absent one answer alike', async () => {
    // This test is why the gate has a last rung. The first version allowed
    // every unresolvable parent, so an absent job answered 200 while a foreign
    // one answered 404 — and the pair told an authenticated user whether an id
    // exists in another tenant. An EMPTY unresolvable thread is now refused.
    const foreign = await call('GET', '/api/messages/job:job_B', ORG_A_ADMIN);
    const absent = await call('GET', '/api/messages/job:job_NOPE', ORG_A_ADMIN);
    expect([foreign.status, absent.status]).toEqual([404, 404]);
  });

  test('and posting into either is refused the same way', async () => {
    const foreign = await call('POST', '/api/messages/job:job_B', ORG_A_ADMIN, { body: 'x' });
    const absent = await call('POST', '/api/messages/job:job_NOPE', ORG_A_ADMIN, { body: 'x' });
    expect([foreign.status, absent.status]).toEqual([404, 404]);
    expect(threadInsert()).toBeUndefined();
  });

  test('LAYER 2 — our own thread still hides a planted foreign row', async () => {
    // The door says yes (it is our job), so this is the rows' own term doing
    // the work. Without it the org-B comment sitting in our thread is readable.
    const r = await call('GET', '/api/messages/job:job_A', ORG_A_ADMIN);
    expect(r.status).toBe(200);
    const ids = (r.body.messages || []).map((m) => m.id).sort();
    expect(ids).toEqual(['cmt_A']);
  });

  test('LAYER 2 — the read carries the org term, not just the door', async () => {
    await call('GET', '/api/messages/job:job_A', ORG_A_ADMIN);
    const q = threadRead();
    expect(q).toBeDefined();
    expect(q.sql).toMatch(/m\.organization_id = \$\d+ OR m\.organization_id IS NULL/);
  });

  test('an attachment thread is scoped through the file it hangs on', async () => {
    expect((await call('GET', '/api/messages/attachment:att_B', ORG_A_ADMIN)).status).toBe(404);
    expect((await call('GET', '/api/messages/attachment:att_A', ORG_A_ADMIN)).status).toBe(200);
  });

  test('OUR OWN WORK STILL WORKS — read and post on our own job', async () => {
    expect((await call('GET', '/api/messages/job:job_A', ORG_A_ADMIN)).status).toBe(200);
    const post = await call('POST', '/api/messages/job:job_A', ORG_A_ADMIN, { body: 'mine' });
    expect(post.status).toBe(200);
    expect(threadInsert()).toBeDefined();
  });

  test('a legacy NULL-org job keeps its thread — the tolerance arm survives', async () => {
    expect((await call('GET', '/api/messages/job:job_LEGACY', ORG_A_ADMIN)).status).toBe(200);
    expect((await call('POST', '/api/messages/job:job_LEGACY', ORG_A_ADMIN, { body: 'ok' })).status).toBe(200);
  });

  test('a deleted job does NOT make a foreign conversation readable', async () => {
    // The last rung's own org term. Delete the parent so the verdict is
    // unknown, and leave the thread holding only org-B's comment: the rung
    // must find no message of OURS and refuse. Without the term in that
    // statement the rung finds their comment and opens the door — layer 2
    // would still empty the list, but the 200 alone tells us the thread
    // exists, which is the oracle two tests up.
    tables.jobs = tables.jobs.filter((j) => j.id !== 'job_B');
    const r = await call('GET', '/api/messages/job:job_B', ORG_A_ADMIN);
    expect(r.status).toBe(404);
  });

  test('a thread whose job was DELETED is not orphaned', async () => {
    // messages has no FK to any entity table, so a deleted job leaves real
    // comments behind. Refusing would lose a conversation between colleagues;
    // layer 2 is what makes allowing it safe.
    tables.jobs = tables.jobs.filter((j) => j.id !== 'job_A');
    const r = await call('GET', '/api/messages/job:job_A', ORG_A_ADMIN);
    expect(r.status).toBe(200);
    expect((r.body.messages || []).map((m) => m.id)).toEqual(['cmt_A']);
  });

  test('an estimate thread label is scoped too', async () => {
    // describeThread's job and lead lookups were hardened in an earlier pass
    // and its estimate and attachment ones were left unscoped, so a guessed id
    // printed another tenant's estimate TITLE as the thread's name. The label
    // is the leak here, not the messages.
    //
    // HONEST NOTE ON WHAT THIS COVERS. The door now refuses a foreign key
    // before describeThread runs, and /recent only describes threads the
    // caller has posted in — which they can no longer do in another tenant.
    // So the predicate added to the estimate and attachment lookups is
    // defence in depth, and a mutation removing it survives this suite. That
    // is recorded rather than papered over with an assertion that cannot
    // fail: the reason to keep it is that describeThread is reachable from two
    // callers and a third would not inherit the door.
    tables.estimates = [
      { id: 'est_A', organization_id: 1, data: { title: 'Ours' } },
      { id: 'est_B', organization_id: 2, data: { title: 'THEIR SECRET PROJECT' } }
    ];
    tables.messages.push({ id: 'cmt_EA', thread_key: 'estimate:est_A', user_id: 11, organization_id: 1, body: 'x' });
    tables.messages.push({ id: 'cmt_EB', thread_key: 'estimate:est_B', user_id: 77, organization_id: 2, body: 'y' });
    // Their estimate: refused at the door, so the title never renders.
    expect((await call('GET', '/api/messages/estimate:est_B', ORG_A_ADMIN)).status).toBe(404);
    // Ours: the real title comes through, which is what proves the predicate
    // narrows rather than simply breaking the lookup.
    const mine = await call('GET', '/api/messages/estimate:est_A', ORG_A_ADMIN);
    expect([mine.status, mine.body.label]).toEqual([200, 'Ours']);
  });

  test('a DM is still decided by its two participants, not by this gate', async () => {
    // threadInOrg returns true for dm: on purpose — re-deciding it here would
    // be a second answer to a question isForbiddenDm already answers.
    expect((await call('GET', '/api/messages/dm:10:11', ORG_A_ADMIN)).status).toBe(200);
    expect((await call('GET', '/api/messages/dm:77:78', ORG_A_ADMIN)).status).toBe(403);
  });
});

/* The gate itself, called directly.
 *
 * Two of its branches cannot be reached through the route, because
 * isValidThreadKey refuses the key before the gate sees it — so a mutation to
 * either survived every HTTP test above. threadInOrg is EXPORTED, and the next
 * caller (the comment notices) will not have isValidThreadKey in front of it,
 * so the function has to be right on its own terms rather than right by
 * accident of who calls it today. */
describe('threadInOrg on its own', () => {
  const { threadInOrg } = require('../server/services/thread-org-scope');
  const runner = { query: async (sql, params) => mockRunQuery(sql, params) };

  test('a prefix it cannot scope is refused, not admitted', async () => {
    // Unreachable through the route today; a default-allow here would become a
    // hole the moment a new thread kind is added to isValidThreadKey and not
    // to THREAD_ENTITY — which is exactly how attachment-org-scope's own
    // entity-type mirror went wrong once already.
    expect(await threadInOrg(runner, 'receipt:rc_1', 1)).toBe(false);
    expect(await threadInOrg(runner, 'nonsense', 1)).toBe(false);
    expect(await threadInOrg(runner, '', 1)).toBe(false);
    expect(await threadInOrg(runner, ':leading', 1)).toBe(false);
  });

  test('the three scopable prefixes each resolve through their own table', async () => {
    tables.estimates = [{ id: 'est_B', organization_id: 2, data: {} }];
    tables.leads = [{ id: 'lead_B', organization_id: 2, data: {} }];
    expect(await threadInOrg(runner, 'job:job_A', 1)).toBe(true);
    expect(await threadInOrg(runner, 'job:job_B', 1)).toBe(false);
    expect(await threadInOrg(runner, 'estimate:est_B', 1)).toBe(false);
    expect(await threadInOrg(runner, 'lead:lead_B', 1)).toBe(false);
  });
});
