// GET /api/ai/86/messages — THE ORG-LESS CALLER MUST BE REFUSED, NOT BLANKED.
//
// ── WHAT THIS GUARDS, AND WHY IT IS ITS OWN FILE ─────────────────────────
// The tenancy wave added `AND (organization_id = $n OR organization_id IS NULL)`
// to all five arms of this handler. `$n` is `msgOrgId`, from `resolveOrgId`,
// and RESOLVEORGID RETURNS NULL — it does not throw — for a user whose `users`
// row carries no `organization_id` (server/auth.js:372-388; only a DB failure
// throws). Bound as NULL, that predicate reads
//
//     (organization_id = NULL OR organization_id IS NULL)
//
// whose first half is UNKNOWN for every row and whose second half matches only
// UN-STAMPED rows. `server/db.js` backfills `ai_messages.organization_id` at
// every boot, so on a real deployment the second half matches nothing either —
// and the handler answers **200 with `{"messages":[]}`**. No error, no log, no
// rollback: the user's entire chat history simply stops existing.
//
// That is the SILENT EMPTY the whole wave was chartered to eliminate, shipped
// by the wave itself. It gets its own file, and its own commit, so it can be
// reverted alone without touching the boundary work around it.
//
// ── REACHABILITY, STATED HONESTLY IN BOTH DIRECTIONS ─────────────────────
// TODAY it is effectively unreachable: `server/db.js:320` re-adopts every
// org-less user into AGX on every boot. That statement is gated on
// `NEVER_MULTI_ORG` — `(SELECT COUNT(*) FROM organizations) <= 1` — so THE DAY
// ORG #2 IS CREATED it stops running, org-less users stop being adopted, and
// the blanking becomes real, silent and permanent. `P86_TENANT_SCOPE` has zero
// reach into `server/routes/ai-routes.js` (grep count: 0), so there is no
// switch to pull either.
//
// This test therefore does NOT prove a live outage. It proves the handler has
// stopped answering a question it cannot answer, ahead of the moment that
// question starts being asked.
//
// ── THE SHAPE OF THE PROOF ───────────────────────────────────────────────
// Real express, real `requireAuth`, real JWT, the real handler, over a schema
// derived from `server/db.js`. THE CALLER RECORD IS HELD FIXED and only the
// caller's ORGANISATION varies — that is the only shape that says anything
// about tenancy (see test/helpers/org-only.js). Three arms of the handler are
// driven, because three is how many ways the sidebar reaches it.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = [
  'organizations', 'roles', 'users', 'ai_sessions', 'ai_messages',
  'estimates', 'jobs', 'leads', 'clients', 'deal_memory',
];

const engine = createPgSqlite(sqliteSchema(TABLES), {
  jsonColumns: ['data', 'capabilities', 'notification_prefs', 'tool_uses', 'output_files'],
  dateColumns: ['created_at', 'updated_at', 'last_used_at'],
});
globalThis.__P86_ORGLESS_ENGINE__ = engine;

jest.mock('../server/db', () => ({ pool: globalThis.__P86_ORGLESS_ENGINE__.pool }));

// No network from a unit test; the SDK is constructed at module load.
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');

const ORG_A = 1;
const USER_ID = 70;
const SESSION_USER_THREAD = 901;
const SESSION_LEGACY = 902;

let server, baseUrl;

beforeAll(async () => {
  const db = engine.db;
  db.prepare("INSERT INTO organizations (id, name, slug) VALUES (?,?,?)").run(ORG_A, 'Alpha', 'alpha');
  db.prepare("INSERT INTO roles (name, label, capabilities, builtin) VALUES (?,?,?,?)")
    .run('admin', 'Org Admin', JSON.stringify(['ROLES_MANAGE', 'INSIGHTS_VIEW']), 1);

  // ONE user row. Its organization_id is the ONLY thing any case changes.
  db.prepare("INSERT INTO users (id, email, name, role, active, organization_id) VALUES (?,?,?,?,?,?)")
    .run(USER_ID, 'a@a.a', 'A', 'admin', 1, ORG_A);

  db.prepare("INSERT INTO ai_sessions (id, user_id, entity_type, session_kind, label) VALUES (?,?,?,?,?)")
    .run(SESSION_USER_THREAD, USER_ID, 'general', 'user_thread', 'thread');
  db.prepare("INSERT INTO ai_sessions (id, user_id, entity_type, entity_id, session_kind, label) VALUES (?,?,?,?,?,?)")
    .run(SESSION_LEGACY, USER_ID, '86', null, 'entity', 'legacy');

  // Turns, STAMPED — which is what production has after db.js's boot backfill,
  // and precisely the state in which the null predicate matches nothing.
  const ins = db.prepare(
    "INSERT INTO ai_messages (id, organization_id, entity_type, estimate_id, user_id, session_id, role, content, model, created_at)"
    + " VALUES (?,?,?,?,?,?,?,?,?,?)");
  ins.run(1, ORG_A, 'general', null, USER_ID, SESSION_USER_THREAD, 'user', 'first turn', 'm', '2026-08-01 00:00:00');
  ins.run(2, ORG_A, 'general', null, USER_ID, SESSION_USER_THREAD, 'assistant', 'second turn', 'm', '2026-08-01 00:00:01');
  ins.run(3, ORG_A, '86', null, USER_ID, SESSION_LEGACY, 'user', 'legacy turn', 'm', '2026-08-01 00:00:02');

  setRolePool(engine.pool);
  await refreshRoleCache();

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/ai', aiRoutes);
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

afterAll(async () => {
  if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections();
  if (server) await new Promise((r) => server.close(r));
});

// THE CALLER RECORD, FIXED. Only `organization_id` moves — in the users row
// (which is what resolveOrgId's DB fallback reads) and in the token (which is
// what its fast path reads). Both have to move together or the case proves
// something about a stale claim instead of about an org-less account.
function callerToken(orgId) {
  return signToken({ id: USER_ID, email: 'a@a.a', name: 'A', role: 'admin', organization_id: orgId });
}

async function get(url, orgId) {
  engine.db.prepare('UPDATE users SET organization_id = ? WHERE id = ?').run(orgId, USER_ID);
  const res = await fetch(baseUrl + url, {
    headers: { authorization: 'Bearer ' + callerToken(orgId), connection: 'close' },
  });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body };
}

const ARMS = [
  ['user_thread arm (the one the sidebar uses for every thread)', '/api/ai/86/messages?session_id=' + SESSION_USER_THREAD, 2],
  ['legacy entity-tuple arm',                                     '/api/ai/86/messages?session_id=' + SESSION_LEGACY, 1],
  ['bare entity_type=86 fallback arm',                            '/api/ai/86/messages', 1],
];

describe('GET /86/messages — the org-less caller', () => {
  for (const [label, url, expectedRows] of ARMS) {
    // ANTI-LOBOTOMY FIRST. A refusal test whose sibling does not prove the
    // route still WORKS is satisfied by a handler that refuses everybody.
    test(`${label} — a caller WITH an organisation still gets their own turns`, async () => {
      const { status, body } = await get(url, ORG_A);
      expect(status).toBe(200);
      expect(body.messages.length).toBe(expectedRows);
    });

    test(`${label} — an ORG-LESS caller is REFUSED (409), never served an empty 200`, async () => {
      const { status, body } = await get(url, null);
      // The assertion that fails against the code as it stood: the old handler
      // answered `200 {"messages":[]}` here, which is a wrong answer wearing a
      // success code.
      expect(status).toBe(409);
      expect(body.code).toBe('ORG_UNRESOLVED');
      expect(body.messages).toBeUndefined();
      // The sentence must name an action a human can take, the way
      // requireOrgId's already does.
      expect(body.error).toMatch(/not attached to an organization/i);
      expect(body.error).toMatch(/Admin/);
    });
  }

  test('the refusal is DISTINGUISHABLE from the retryable resolution failure', async () => {
    // 409 ORG_UNRESOLVED ("you have no organisation") and 503 ORG_LOOKUP_FAILED
    // ("I could not tell") are different answers and the client must be able to
    // tell them apart — conflating them is how a pool blip becomes a permanent
    // -looking authorization failure. Both codes are spelled in the handler;
    // this asserts the pair is not one code wearing two numbers.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'routes', 'ai-routes.js'), 'utf8');
    const handler = src.slice(src.indexOf("router.get('/86/messages'"));
    const head = handler.slice(0, handler.indexOf("const q = req.query"));
    expect(head).toContain('ORG_LOOKUP_FAILED');
    expect(head).toContain('ORG_UNRESOLVED');
    expect(head).toContain('503');
    expect(head).toContain('409');
  });
});
