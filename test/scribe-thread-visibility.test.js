// THE SCRIBE'S BACKGROUND NOTICES WERE UNREACHABLE BY ANY HISTORY QUERY.
//
// ── WHAT JOHN SAW, AND WHY IT LOOKED LIKE A WRITE BUG ─────────────────────
// "Scribe is failing to write to the photos." The write half genuinely did not
// exist — that is the sibling file's subject — but what made it look like
// nothing at all was this: 86's turn ends with scribe_write's canned line
// ("drafting in the BACKGROUND… they'll get a notification with the review
// card"), 86 relays it, and then the detached chain fails and posts the reason
// through postAgentJobToThread.
//
// That INSERT wrote entity_type='general', estimate_id='global' and — the
// load-bearing omission — session_id NULL, because the five call sites in
// execScribeWrite passed only `{ user_id }`. GET /api/ai/86/messages has two
// arms that could serve a Scribe notice, and the row satisfied neither:
//   • the user_thread arm loads STRICTLY by session_id, with no tuple fallback
//     (deliberately — a tuple fallback collapsed every "+ New chat" into one
//     shared bucket), and the row had no session_id;
//   • the no-session fallback filters entity_type='86', and the row is
//     'general'.
// So the failure notice could not be returned by any query, on that turn or on
// reload. Push fired — the only live signal — and the chat stayed silent. The
// success case was partly rescued by the panel polling /api/payloads for
// status='ready'; a refusal is recorded status='failed' and that strip filters
// it out by design, so a FAILURE had no rescue at all.
//
// This is not specific to photos. EVERY background Scribe post went the same
// way, "Applied" notices included.
//
// ── WHAT IS PROVEN HERE ───────────────────────────────────────────────────
// The real router, the real requireAuth with a locally-signed token, the real
// INSERT (postAgentJobToThread itself, not a copy), and the real GET. The
// mutation is the one-word revert: drop session_id from the descriptor and
// watch the same message become unfetchable.
'use strict';

process.env.JWT_SECRET = 'photo-caption-visibility-secret-0123456789ab';

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = ['ai_messages', 'ai_sessions', 'users', 'organizations'];

let eng;
let server;
let aiRoutes;
let TOKEN;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: server.address().port,
      path: urlPath, method: 'GET', headers: { Authorization: 'Bearer ' + TOKEN } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; });
        res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = b; }
          resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject);
    r.end();
  });
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['output_files'] });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  eng.db.exec(`
    INSERT INTO organizations (id, name) VALUES (1,'AGX');
    INSERT INTO users (id, name, email, role, organization_id)
      VALUES (10,'John','j@agx.test','pm',1);
    INSERT INTO ai_sessions (id, user_id, agent_key, entity_type, entity_id, session_kind)
      VALUES (7, 10, 'job', 'general', NULL, 'user_thread');
  `);
  aiRoutes = require('../server/routes/ai-routes');
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRoutes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  TOKEN = jwt.sign({ id: 10, email: 'j@agx.test', role: 'pm', organization_id: 1 },
    process.env.JWT_SECRET, { expiresIn: '1h' });
});

afterAll(() => { if (server) server.close(); if (eng) eng.close(); });
beforeEach(() => { eng.db.exec('DELETE FROM ai_messages'); });

const REFUSAL = '⚠️ **Scribe couldn\'t complete that draft**: ' +
  'attachment.ops.photo_updates[1]: no such photo — attachment_id="a999". Nothing was saved.';

describe('a Scribe refusal reaches the chat the user is looking at', () => {
  test('posted WITH the session, GET /86/messages returns it', async () => {
    // The REAL writer, with the descriptor execScribeWrite now builds.
    await aiRoutes.internals.postAgentJobToThread(
      { user_id: 10, organization_id: 1, session_id: 7 }, REFUSAL);
    const r = await get('/api/ai/86/messages?session_id=7');
    expect(r.status).toBe(200);
    expect(r.body.messages).toHaveLength(1);
    expect(r.body.messages[0].content).toBe(REFUSAL);
  });

  test('MUTATION — drop session_id and the identical message is unfetchable', async () => {
    // The exact shape the five call sites used before: `{ user_id: uid }`.
    await aiRoutes.internals.postAgentJobToThread({ user_id: 10 }, REFUSAL);
    // The row IS written. That is what made this so hard to see: nothing
    // failed, nothing logged, and the reason was sitting in the table.
    expect(eng.count('SELECT 1 FROM ai_messages')).toBe(1);
    const row = eng.all('SELECT entity_type, estimate_id, session_id, organization_id FROM ai_messages')[0];
    expect(row).toEqual({ entity_type: 'general', estimate_id: 'global',
      session_id: null, organization_id: null });

    // Neither arm can return it.
    const bySession = await get('/api/ai/86/messages?session_id=7');
    expect([bySession.status, bySession.body.messages.length]).toEqual([200, 0]);
    const noSession = await get('/api/ai/86/messages');
    expect([noSession.status, noSession.body.messages.length]).toEqual([200, 0]);
  });

  test('CONTROL — the query itself works, so the 0 above is the row and not the route', async () => {
    eng.db.exec("INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, organization_id, session_id)" +
      " VALUES ('aim_ctl','general','global',10,'assistant','a normal turn',1,7)");
    const r = await get('/api/ai/86/messages?session_id=7');
    expect(r.body.messages.map((m) => m.content)).toEqual(['a normal turn']);
  });

  test('an agent_jobs caller with no session still writes the NULL it always wrote', async () => {
    // agent_jobs rows have no session_id column, so `job.session_id` is
    // undefined there. The change must not turn that into a crash or a wrong
    // id — it writes exactly the NULL it wrote before.
    await aiRoutes.internals.postAgentJobToThread(
      { user_id: 10, organization_id: 1 }, 'background task finished');
    const row = eng.all('SELECT session_id, organization_id FROM ai_messages')[0];
    expect(row).toEqual({ session_id: null, organization_id: 1 });
  });
});
