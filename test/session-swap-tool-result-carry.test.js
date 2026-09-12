// A TURN'S TOOL RESULTS MUST REACH THE MODEL, OR THE USER MUST BE TOLD THE TRUTH.
//
// THE INSTANCE (from the field, 2026-09-11)
// The user asked 86, in a NEW CHAT, for a task list off an attached scope of
// work. In one turn, 15 seconds, he got two strings in one bubble and nothing
// else:
//
//   (grey)  Used 6 tools but didn't produce a summary — ask again or rephrase.
//   (red)   The chat session was reset between turns, so those approval cards
//           no longer apply. Re-send your request and I'll redo the proposals
//           fresh.
//
// He was shown no approval cards. There were no proposals. There was no task
// list.
//
// THREE INDEPENDENT PRODUCERS MAKE THAT IDENTICAL SCREEN, and the first attempt
// at this fix closed two of them and left the third — which is the one that
// fires on his path:
//
//   1. NUCLEAR SWAP. The stuck-session catch archives the session, creates a
//      new one, and replays the SAME six user.custom_tool_result events. Every
//      id in them belongs to the archived session: a guaranteed 400.
//   2. IN-PLACE RECOVERY, no session change. It answered every blocked id with
//      "Continue." and THEN replayed the real results for those same ids — so
//      the model read "Continue." six times where the scope of work should have
//      been, and the replay is a second answer to an answered id.
//   3. requires_action carrying an EMPTY stop_reason.event_ids. Nothing to
//      re-key onto, so the idle handler posted the CAPTURED stream ids — which
//      this file's own contract note says are not authoritative. No session
//      change, six green chips, no answer.
//
// WHAT IS DRIVEN, AND WHY THAT IS THE ONLY ACCEPTABLE EVIDENCE
// Every assertion below runs the REAL POST /api/ai/86/chat (and the REAL
// /86/chat/continue) through the REAL runV2SessionStream against a fake
// Anthropic Sessions transport whose SEMANTICS ARE MODELLED, NOT SCRIPTED:
//   - a session accepts a user.custom_tool_result only for a custom_tool_use id
//     THAT session issued; an id it never issued raises the production 400;
//   - a session holding outstanding tool_use ids REJECTS a free-form
//     user.message with "waiting on responses to events [...]", exactly as this
//     file's own comments describe, until those ids are answered or a
//     user.interrupt clears them.
// The server has to get the ids right to pass — nothing tells it the answer.
//
// Controls exist so the rig cannot be rigged: with no interference the same six
// tools answer normally, and the strict re-key onto stop_reason.event_ids (the
// ONE path in the file that already honoured the SDK contract) must keep
// honouring it.
//
// SCHEMA IS DERIVED from server/db.js via test/helpers/db-schema.js, and
// capabilities are derived from auth.CAPABILITY_KEYS. No column name and no
// capability key is hand-typed: an earlier revision of this file seeded
// capabilities as ['*'], every read came back "Permission denied", and six
// tool_failed chips counted as six chips — the drive looked right and proved
// nothing.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
process.env.AGENT_MODE_86 = 'agents';

jest.setTimeout(180000);

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = [
  'organizations', 'roles', 'users',
  'projects', 'jobs', 'leads', 'estimates', 'clients',
  'attachments',
  'agent_jobs', 'ai_sessions', 'ai_messages', 'payloads',
  'context_load_events', 'app_settings', 'email_log', 'org_memory', 'messages'
];

const engine = createPgSqlite(
  sqliteSchema(TABLES, {
    pk: {
      organizations: 'id', roles: 'name', users: 'id', projects: 'id', jobs: 'id',
      leads: 'id', estimates: 'id', clients: 'id', attachments: 'id', agent_jobs: 'id',
      ai_sessions: 'id', ai_messages: 'id', payloads: 'id', app_settings: 'key',
      email_log: 'id', org_memory: 'id', messages: 'id'
    }
  }),
  {
    jsonColumns: ['data', 'capabilities', 'notification_prefs', 'tags', 'payload', 'settings', 'annotations'],
    dateColumns: ['updated_at', 'created_at', 'uploaded_at', 'last_seen_at', 'last_used_at']
  }
);
globalThis.__ENGINE__ = engine;
globalThis.__UNMODELLED__ = [];
jest.mock('../server/db', () => {
  const real = globalThis.__ENGINE__.pool;
  const q = async (sql, params) => {
    if (String(sql).includes('to_jsonb')) return { rows: [], rowCount: 1 };
    try { return await real.query(sql, params); }
    catch (e) {
      globalThis.__UNMODELLED__.push(
        String(sql).replace(/\s+/g, ' ').trim().slice(0, 110) + '  ||  ' + e.message);
      return { rows: [], rowCount: 0 };
    }
  };
  return { pool: { query: q, connect: async () => ({ query: q, release() {} }) } };
});

// Real bytes, so loadPhotoAsBlock builds a real image block.
jest.mock('../server/storage', () => ({
  storage: {
    getBuffer: async () => Buffer.from('PIXELBYTES'),
    put: async (k) => 'https://cdn.test/' + k,
    delete: async () => {}
  }
}));
// No Files-API upload, so the base64 arm runs and the block is inspectable.
jest.mock('../server/anthropic-files', () => ({
  uploadAttachmentToAnthropic: async () => null,
  eagerUploadAttachmentById: async () => {},
  deleteAnthropicFile: async () => {}
}));
jest.mock('../server/routes/admin-agents-routes', () => ({
  ensureManagedEnvironment: async () => ({ anthropic_environment_id: 'env_test' }),
  ensureManagedAgent: async () => ({ anthropic_agent_id: 'agent_test' })
}));

// ── The fake Sessions transport, with MODELLED semantics ──────────────────
globalThis.__SENT__ = [];
globalThis.__SCRIPT__ = [];
globalThis.__SESSIONS__ = [];
globalThis.__LOG__ = [];
globalThis.__ISSUED__ = {};       // sessionId -> Set of ids that session issued
globalThis.__OPEN__ = {};         // sessionId -> Set of ids not yet answered
globalThis.__ARMED__ = null;      // one-shot injected transport error
globalThis.__ARMQ__ = [];         // QUEUE of injected errors, consumed in order
globalThis.__CANONICAL__ = false; // session issues can_* ids but streams sevt_*
globalThis.__ONCE__ = false;      // one answer per id (a second answer 400s)

jest.mock('@anthropic-ai/sdk', () => {
  let n = 0;
  function FakeAnthropic() {
    return {
      messages: {},
      beta: {
        sessions: {
          create: async () => {
            const id = 'sess_' + (++n);
            globalThis.__SESSIONS__.push(id);
            globalThis.__ISSUED__[id] = new Set();
            globalThis.__OPEN__[id] = new Set();
            globalThis.__LOG__.push('CREATE ' + id);
            return { id };
          },
          archive: async (sid) => { globalThis.__LOG__.push('ARCHIVE ' + sid); return {}; },
          events: {
            send: async (sid, body) => {
              const evts = body.events || [];
              for (const e of evts) {
                globalThis.__LOG__.push('send ' + sid + ' ' + e.type +
                  (e.custom_tool_use_id ? ' ' + e.custom_tool_use_id : ''));
              }
              if (globalThis.__ARMQ__.length && globalThis.__ARMQ__[0].when(evts, sid)) {
                const spec = globalThis.__ARMQ__.shift();
                const err = new Error(spec.message);
                err.status = spec.status;
                throw err;
              }
              if (globalThis.__ARMED__ && globalThis.__ARMED__.when(evts, sid)) {
                const spec = globalThis.__ARMED__;
                globalThis.__ARMED__ = null;
                const err = new Error(spec.message);
                err.status = spec.status;
                throw err;
              }
              const issued = globalThis.__ISSUED__[sid] || (globalThis.__ISSUED__[sid] = new Set());
              const open = globalThis.__OPEN__[sid] || (globalThis.__OPEN__[sid] = new Set());
              // Validate and apply IN ORDER — a batch may legitimately clear
              // requires_action (interrupt / results) before a user.message.
              for (const e of evts) {
                if (e.type === 'user.custom_tool_result') {
                  // A session accepts a result ONLY for an id it issued.
                  if (!issued.has(e.custom_tool_use_id)) {
                    const err = new Error('custom_tool_use_id ' + e.custom_tool_use_id +
                      ' does not match any custom_tool_use event in this session');
                    err.status = 400;
                    throw err;
                  }
                  if (globalThis.__ONCE__) issued.delete(e.custom_tool_use_id);
                  open.delete(e.custom_tool_use_id);
                } else if (e.type === 'user.interrupt') {
                  open.clear();
                } else if (e.type === 'user.message' && open.size) {
                  // A free-form message cannot land on a session that is still
                  // waiting on tool responses — the documented 400 this file's
                  // stall-recovery comment describes.
                  const err = new Error('session is waiting on responses to events [' +
                    Array.from(open).join(', ') + ']');
                  err.status = 400;
                  throw err;
                }
                globalThis.__SENT__.push(
                  Object.assign({ __session: sid, __epoch: globalThis.__EPOCH__ }, e));
              }
            },
            stream: async (sid) => {
              const turn = globalThis.__SCRIPT__.shift() || [];
              globalThis.__LOG__.push('stream ' + sid);
              if (!globalThis.__ISSUED__[sid]) globalThis.__ISSUED__[sid] = new Set();
              if (!globalThis.__OPEN__[sid]) globalThis.__OPEN__[sid] = new Set();
              return {
                controller: { abort() {} },
                [Symbol.asyncIterator]() {
                  let i = 0;
                  return {
                    next: async () => {
                      if (i >= turn.length) return { value: undefined, done: true };
                      const ev = turn[i++];
                      if (ev.type === 'agent.custom_tool_use' && ev.id) {
                        const id = globalThis.__CANONICAL__
                          ? ev.id.replace('sevt_', 'can_') : ev.id;
                        globalThis.__ISSUED__[sid].add(id);
                        globalThis.__OPEN__[sid].add(id);
                      }
                      return { value: ev, done: false };
                    }
                  };
                }
              };
            }
          }
        },
        files: {
          list: (function () {
            let f = 0;
            return function () {
              const id = 'file_harvest_' + (++f);
              return { [Symbol.asyncIterator]() {
                let done = false;
                return { next: async () => (done ? { done: true } : (done = true, { value: { id }, done: false })) };
              } };
            };
          })()
        }
      }
    };
  }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const _auth = require('../server/auth');
const { setRolePool, refreshRoleCache, signToken } = _auth;
const ALL_CAPS = (_auth.CAPABILITY_KEYS || []).map(c => (typeof c === 'string' ? c : c.key));
const aiRoutes = require('../server/routes/ai-routes');
const { pool } = require('../server/db');
setRolePool(pool);

const ORG_A = 900000001;
const USER_A = { id: 10, email: 'a@a.test', name: 'A', role: 'admin', organization_id: ORG_A };

// Six DISTINCT jobs, so "all six results crossed" is a checkable claim rather
// than a count of one. A carry that delivers the first result and drops the
// other five is the confidently-wrong-answer failure mode this whole file
// exists to prevent — and it is invisible to any assertion that only counts
// carried messages.
const SIX = ['t1', 't2', 't3', 't4', 't5', 't6'];
const JOBS = SIX.map((t, i) => ({
  id: 'j-m100' + (i + 1),
  number: 'M100' + (i + 1),
  title: 'ScopeMarker' + (i + 1) + 'Unique'
}));

function seed() {
  const db = engine.db;
  for (const t of TABLES) db.exec('DELETE FROM ' + t + ';');
  db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').run(ORG_A, 'AG Exteriors', 'agx');
  db.prepare('INSERT INTO roles (name,label,capabilities) VALUES (?,?,?)')
    .run('admin', 'Admin', JSON.stringify(ALL_CAPS));
  db.prepare('INSERT INTO users (id,email,name,role,organization_id,active) VALUES (?,?,?,?,?,1)')
    .run(10, 'a@a.test', 'A', 'admin', ORG_A);
  for (const j of JOBS) {
    db.prepare('INSERT INTO jobs (id,owner_id,organization_id,data) VALUES (?,?,?,?)')
      .run(j.id, 10, ORG_A, JSON.stringify({ jobNumber: j.number, title: j.title }));
  }
  db.prepare(
    `INSERT INTO attachments (id, organization_id, entity_type, entity_id, filename,
                              mime_type, size_bytes, uploaded_by, web_key, thumb_key, caption)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('att-scope', ORG_A, 'job', JOBS[0].id, 'SCOPE.jpg', 'image/jpeg', 2416640, 10,
         'k/att-scope', 't/att-scope', null);
}

let server, baseUrl;
beforeAll((done) => {
  seed();
  refreshRoleCache().then(() => {
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/ai', aiRoutes);
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});
afterAll((done) => { server.close(() => done()); });

// POST /86/chat carries a per-user throttle; this file makes more calls than it
// allows, and a 429 reads EXACTLY like the bug under test.
const { aiChatLimiter, aiChatHourlyLimiter } = require('../server/rate-limit');
function unthrottle(user) {
  for (const l of [aiChatLimiter, aiChatHourlyLimiter]) {
    try { l.resetKey('u:' + user.id); } catch (_) {}
  }
}

let epochSeq = 0;
function resetWire() {
  globalThis.__SENT__ = [];
  globalThis.__SCRIPT__ = [];
  globalThis.__LOG__ = [];
  globalThis.__ARMED__ = null;
  globalThis.__ARMQ__ = [];
  globalThis.__CANONICAL__ = false;
  globalThis.__ONCE__ = false;
  globalThis.__EPOCH__ = ++epochSeq;
}

async function post(path, body) {
  unthrottle(USER_A);
  const r = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signToken(USER_A) },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (r.status !== 200) throw new Error('POST ' + path + ' answered ' + r.status + ': ' + text.slice(0, 300));
  return text;
}
const postChat = (message) => post('/api/ai/86/chat', { message });

function parseSSE(body) {
  const out = { chips: 0, applied: 0, failed: 0, text: '', errors: [], staleFlag: false };
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (raw === '[DONE]') continue;
    let p; try { p = JSON.parse(raw); } catch (_) { continue; }
    if (p.tool_applied) { out.chips++; out.applied++; }
    if (p.tool_failed) { out.chips++; out.failed++; }
    if (p.tool_rejected) out.chips++;
    if (p.delta) out.text += p.delta;
    if (p.error) out.errors.push(String(p.error));
    if (p.stale_tool_use_id) out.staleFlag = true;
  }
  return out;
}

// The client's finalize ladder (js/ai-panel.js:3928-3985), replicated in branch
// ORDER, so the grey caption is produced by the same decision the browser makes:
// chips-with-no-text outranks the server's error, which is why the user sees
// "ask again or rephrase" rather than the explanation.
function clientFinalize(sse) {
  if (sse.text) return { branch: 'text-bubble', grey: null };
  if (sse.chips > 0) {
    return {
      branch: 'GREY-used-N-tools',
      grey: 'Used ' + sse.chips + ' tool' + (sse.chips === 1 ? '' : 's') +
            ' but didn\'t produce a summary — ask again or rephrase.'
    };
  }
  if (sse.errors.length) return { branch: 'error-bubble', grey: null };
  return { branch: 'no-response', grey: null };
}

// search_entities is auto-tier and routes to the real read_jobs handler, so a
// per-job filter comes back carrying that job's own title. Six DIFFERENT
// filters therefore make "all six results crossed" checkable by content rather
// than by count.
const readTool = (id, title) => ({
  type: 'agent.custom_tool_use', id: 'sevt_' + id,
  tool_name: 'search_entities', input: { entity_type: 'job', filter: title }
});
const sixToolTurn = (eventIds) => ([
  ...SIX.map((t, i) => readTool(t, JOBS[i].title)),
  { type: 'session.status_idle',
    stop_reason: { type: 'requires_action', event_ids: eventIds || SIX.map(i => 'sevt_' + i) } }
]);
const finalTurn = (text) => ([
  { type: 'agent.message', content: [{ type: 'text', text }] },
  { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
]);
// A recovered turn opens MORE streams than the happy path. A script that runs
// dry mid-recovery reports "no text" for a reason unrelated to the code under
// test, so every wedge drive is given spare answering turns.
const ANSWER = 'Here is your task list.';
const spares = () => [finalTurn(ANSWER), finalTurn(ANSWER), finalTurn(ANSWER)];

const STUCK_NO_IDS = 'session is waiting on responses to events';
const STUCK_WITH_IDS = 'waiting on responses to events [' + SIX.map(i => 'sevt_' + i).join(', ') + ']';
const armOnFlush = (message) => ({
  status: 400, message,
  when: (evts) => evts.some(e => e.type === 'user.custom_tool_result')
});

// ── wire readers ──────────────────────────────────────────────────────────
const carriedMessages = () => globalThis.__SENT__.filter(e =>
  e.type === 'user.message' && JSON.stringify(e.content).indexOf('prior_tool_results') >= 0);
const resultsSent = () => globalThis.__SENT__.filter(e => e.type === 'user.custom_tool_result');
const continuesSent = () => resultsSent().filter(e =>
  JSON.stringify(e.content).indexOf('Continue.') >= 0).map(e => e.custom_tool_use_id);

// A warm-up turn so the wedge turn runs with freshlyCreated=false — the nuclear
// branch is gated on exactly that (ai-routes.js). seed() runs HERE, before the
// warm-up, so each drive inherits a warmed non-fresh session; reseeding after
// the warm-up would silently re-arm freshlyCreated and skip the branch.
async function warmUp() {
  seed();
  globalThis.__ISSUED__ = {};
  globalThis.__OPEN__ = {};
  globalThis.__SESSIONS__ = [];
  resetWire();
  globalThis.__SCRIPT__ = [finalTurn('Hi.')];
  await postChat('hello');
  resetWire();
}
// A brand-new chat: no prior turn, so freshlyCreated=true and the nuclear
// branch is NOT available. The reported failure happened in a New chat.
async function freshChat() {
  seed();
  globalThis.__ISSUED__ = {};
  globalThis.__OPEN__ = {};
  globalThis.__SESSIONS__ = [];
  resetWire();
}

describe('this turn\'s tool results must reach the model', () => {

  test('CONTROL — six auto-tier reads, no interference: the model answers', async () => {
    await warmUp();
    globalThis.__SCRIPT__ = [sixToolTurn(), finalTurn(ANSWER)];
    const sse = parseSSE(await postChat('task list off the scope of work'));
    // The reads must genuinely SUCCEED. Six tool_failed chips also count as six
    // chips on the client, so a permission-denied rig looks like a passing one.
    expect(sse.applied).toBe(6);
    expect(sse.failed).toBe(0);
    expect(sse.text).toContain('task list');
    expect(sse.errors).toEqual([]);
    expect(clientFinalize(sse).branch).toBe('text-bubble');
  });

  test('CONTROL — the strict re-key onto stop_reason.event_ids still holds', async () => {
    await warmUp();
    // Canonical mode: the session issues can_* ids but streams sevt_* ids —
    // the documented production reality that captured stream ids are not
    // authoritative. The idle handler's strict re-key is the ONE path in this
    // file that already honours the SDK contract; it must keep honouring it.
    globalThis.__CANONICAL__ = true;
    globalThis.__SCRIPT__ = [sixToolTurn(SIX.map(i => 'can_' + i)), finalTurn(ANSWER)];
    const sse = parseSSE(await postChat('task list off the scope of work'));
    expect(resultsSent().map(e => e.custom_tool_use_id)).toEqual(SIX.map(i => 'can_' + i));
    expect(sse.errors).toEqual([]);
    expect(sse.text).toContain('task list');
  });

  // ── PRODUCER 3 — the one that was still reproducing the user's screen ────

  test('W-5 — requires_action with EMPTY event_ids answers instead of dying (warmed session)', async () => {
    await warmUp();
    // The session DID issue canonical ids; the idle event names none of them.
    globalThis.__CANONICAL__ = true;
    globalThis.__SCRIPT__ = [sixToolTurn([]), finalTurn(ANSWER), ...spares()];
    const sse = parseSSE(await postChat('task list off the scope of work'));
    const fin = clientFinalize(sse);

    // THE USER'S SCREEN IS GONE: an answer, not six chips and a red line.
    expect(sse.text).toContain('task list');
    expect(sse.chips).toBe(6);
    expect(sse.errors).toEqual([]);
    expect(sse.staleFlag).toBe(false);
    expect(fin.branch).toBe('text-bubble');
    expect(fin.grey).toBeNull();

    // Not ONE non-authoritative id was posted. This is the fix: the captured
    // sevt_* ids are never sent, because the session never asked for them.
    expect(resultsSent()).toEqual([]);
    // The work crossed as ONE message, behind the interrupt that clears
    // requires_action — without the interrupt the message bounces off
    // "waiting on responses to events" and needs a recovery round-trip.
    const carried = carriedMessages();
    expect(carried.length).toBe(1);
    const interrupts = globalThis.__SENT__.filter(e => e.type === 'user.interrupt');
    expect(interrupts.length).toBe(1);
    expect(globalThis.__SENT__.indexOf(interrupts[0]))
      .toBeLessThan(globalThis.__SENT__.indexOf(carried[0]));
    // Nothing was padded over with "Continue.".
    expect(continuesSent()).toEqual([]);
    // ALL SIX reads crossed, not the first one. A carry that delivers one
    // result and drops five passes every count-based assertion and hands the
    // user a task list built off a sixth of the scope of work.
    const blob = JSON.stringify(carried[0].content);
    for (const j of JOBS) expect(blob).toContain(j.title);
    // And it never reaches the swap: no session identity change here.
    expect(globalThis.__LOG__.join(' ')).not.toMatch(/ARCHIVE /);
  });

  test('W-12 — the same on a brand-new chat, where nuclear recovery is unavailable', async () => {
    await freshChat();
    globalThis.__CANONICAL__ = true;
    globalThis.__SCRIPT__ = [sixToolTurn([]), finalTurn(ANSWER), ...spares()];
    const sse = parseSSE(await postChat('task list off the attached scope of work'));
    expect(sse.text).toContain('task list');
    expect(sse.chips).toBe(6);
    expect(sse.errors).toEqual([]);
    expect(clientFinalize(sse).grey).toBeNull();
    expect(resultsSent()).toEqual([]);
    const carried = carriedMessages();
    expect(carried.length).toBe(1);
    const blob = JSON.stringify(carried[0].content);
    for (const j of JOBS) expect(blob).toContain(j.title);
    // freshlyCreated=true, so the archive+recreate arm is gated off entirely:
    // this turn is saved by the empty-event_ids fix alone.
    expect(globalThis.__LOG__.join(' ')).not.toMatch(/ARCHIVE /);
  });

  // ── PRODUCER 1 — the nuclear swap (closed in attempt 1, must stay closed) ─

  test('the nuclear swap carries results across instead of replaying dead ids', async () => {
    await warmUp();
    globalThis.__SCRIPT__ = [sixToolTurn(), finalTurn(ANSWER), ...spares()];
    globalThis.__ARMED__ = armOnFlush(STUCK_NO_IDS);
    const sse = parseSSE(await postChat('task list off the scope of work'));
    const fin = clientFinalize(sse);

    // This drive must actually exercise the archive+recreate branch, else it
    // proves nothing about a session swap.
    expect(globalThis.__LOG__.join(' ')).toMatch(/ARCHIVE .*CREATE /);
    expect(sse.chips).toBe(6);
    expect(sse.text).toContain('task list');
    expect(sse.errors).toEqual([]);
    expect(sse.staleFlag).toBe(false);
    expect(fin.branch).toBe('text-bubble');
    // The orphaned results crossed as ONE user.message…
    const carried = carriedMessages();
    expect(carried.length).toBe(1);
    // …carrying ALL SIX, not just the first…
    const blob = JSON.stringify(carried[0].content);
    for (const j of JOBS) expect(blob).toContain(j.title);
    // …and NO tool_result was ever posted to the new session.
    const newSess = globalThis.__SESSIONS__[globalThis.__SESSIONS__.length - 1];
    expect(globalThis.__SENT__.filter(e =>
      e.__session === newSess && e.type === 'user.custom_tool_result')).toEqual([]);
  });

  test('a carried image result keeps its image block, not a description of one', async () => {
    await warmUp();
    globalThis.__SCRIPT__ = [
      [ { type: 'agent.custom_tool_use', id: 'sevt_img',
          tool_name: 'view_attachment_image', input: { attachment_id: 'att-scope' } },
        { type: 'session.status_idle',
          stop_reason: { type: 'requires_action', event_ids: ['sevt_img'] } } ],
      finalTurn(ANSWER), ...spares()
    ];
    globalThis.__ARMED__ = armOnFlush(STUCK_NO_IDS);
    const sse = parseSSE(await postChat('read the scope of work photo'));
    expect(globalThis.__LOG__.join(' ')).toMatch(/ARCHIVE .*CREATE /);
    expect(sse.text).toContain('task list');

    const carried = carriedMessages();
    expect(carried.length).toBe(1);
    // THE POINT: the pixels must ride. This file's subject already shipped an
    // image-drop regression once by flattening a structured tool result to
    // prose; carrying results across a swap must not reintroduce it.
    const kinds = carried[0].content.map(b => b && b.type);
    expect(kinds).toContain('image');
    const img = carried[0].content.find(b => b && b.type === 'image');
    expect(img.source && img.source.data).toBe(Buffer.from('PIXELBYTES').toString('base64'));
  });

  test('a carried result that ERRORED is still marked as one', async () => {
    await warmUp();
    // is_error is a FIELD on the queued tool_result event and no user.message
    // can express it. Dropped, a failed read crosses the swap looking exactly
    // like a successful one and the model loses the retry-vs-ask signal.
    globalThis.__SCRIPT__ = [
      [ { type: 'agent.custom_tool_use', id: 'sevt_bad',
          tool_name: 'read_materials', input: {} },
        readTool('t2', JOBS[1].title),
        { type: 'session.status_idle',
          stop_reason: { type: 'requires_action', event_ids: ['sevt_bad', 'sevt_t2'] } } ],
      finalTurn(ANSWER), ...spares()
    ];
    globalThis.__ARMED__ = armOnFlush(STUCK_NO_IDS);
    const sse = parseSSE(await postChat('read the scope photo and that job'));
    expect(sse.failed).toBe(1);
    expect(sse.applied).toBe(1);
    const carried = carriedMessages();
    expect(carried.length).toBe(1);
    const texts = carried[0].content.map(b => (b && b.text) || '');
    const markerAt = texts.findIndex(t => t.indexOf('is an ERROR') >= 0);
    expect(markerAt).toBeGreaterThanOrEqual(0);
    // …exactly ONE marker, sitting immediately before the failing tool’s own
    // output — the healthy result crosses unmarked, and still crosses.
    expect(texts.filter(t => t.indexOf('is an ERROR') >= 0).length).toBe(1);
    expect(texts[markerAt + 1]).toContain('Error:');
    expect(texts.join(" ")).toContain(JOBS[1].title);
    expect(sse.text).toContain('task list');
  });

  test('a carried batch keeps the events around it, in order', async () => {
    await warmUp();
    // Stall recovery is the one realistic batch that mixes results with a
    // non-result event: "Continue." results for the blocked ids PLUS a nudge
    // user.message. The carry must not drop the nudge (the session would sit
    // with nothing to answer) and must not reorder it ahead of… behind the
    // results it refers to.
    globalThis.__SCRIPT__ = [
      [ readTool('t1', JOBS[0].title),
        { type: 'session.status_idle',
          stop_reason: { type: 'requires_action', event_ids: ['sevt_t1'] } } ],
      // Second pass: the model says nothing and idles still-blocked on a ghost
      // id, which is the stall shape.
      [ { type: 'session.status_idle',
          stop_reason: { type: 'requires_action', event_ids: ['sevt_ghost'] } } ],
      finalTurn(ANSWER), ...spares()
    ];
    // Arm the stuck error on the stall-recovery batch. Events go out ONE per
    // events.send (EVENTS_PER_SEND=1), so this fires on the batch's first
    // event — the "Continue." result for the ghost id — with the nudge
    // user.message still undelivered behind it.
    globalThis.__ARMED__ = {
      status: 400, message: STUCK_NO_IDS,
      when: (evts) => evts.some(e => e.custom_tool_use_id === 'sevt_ghost')
    };
    const sse = parseSSE(await postChat('task list off the scope of work'));
    expect(globalThis.__LOG__.join(' ')).toMatch(/ARCHIVE .*CREATE /);
    const newSess = globalThis.__SESSIONS__[globalThis.__SESSIONS__.length - 1];
    const onNew = globalThis.__SENT__.filter(e => e.__session === newSess);
    const nudgeAt = onNew.findIndex(e => e.type === 'user.message' &&
      JSON.stringify(e.content).indexOf('prior_tool_results') < 0 &&
      JSON.stringify(e.content).indexOf('conversation_recap') < 0);
    const carriedAt = onNew.findIndex(e => e.type === 'user.message' &&
      JSON.stringify(e.content).indexOf('prior_tool_results') >= 0);
    expect(nudgeAt).toBeGreaterThanOrEqual(0);   // the survivor was NOT dropped
    expect(carriedAt).toBeGreaterThanOrEqual(0);
    expect(nudgeAt).toBeLessThan(carriedAt);     // and was NOT reordered
    expect(sse.text).toContain('task list');
  });

  // ── PRODUCER 2 — in-place recovery (closed in attempt 1, must stay closed) ─

  test('in-place recovery does not pre-answer the ids it is about to deliver', async () => {
    await warmUp();
    globalThis.__ONCE__ = true; // one answer per id
    globalThis.__SCRIPT__ = [sixToolTurn(), finalTurn(ANSWER), ...spares()];
    globalThis.__ARMED__ = armOnFlush(STUCK_WITH_IDS);
    const sse = parseSSE(await postChat('task list off the scope of work'));

    expect(continuesSent()).toEqual([]);
    expect(sse.chips).toBe(6);
    expect(sse.text).toContain('task list');
    expect(sse.errors).toEqual([]);
    expect(clientFinalize(sse).grey).toBeNull();
  });

  test('every real tool result reaches the model unreplaced by "Continue."', async () => {
    await warmUp();
    globalThis.__SCRIPT__ = [sixToolTurn(), finalTurn(ANSWER), ...spares()];
    globalThis.__ARMED__ = armOnFlush(STUCK_WITH_IDS);
    const sse = parseSSE(await postChat('task list off the scope of work'));

    const byId = {};
    for (const r of resultsSent()) {
      const kind = JSON.stringify(r.content).indexOf('Continue.') >= 0 ? 'CONTINUE' : 'REAL';
      (byId[r.custom_tool_use_id] = byId[r.custom_tool_use_id] || []).push(kind);
    }
    expect(Object.keys(byId).length).toBe(6);
    for (const id of Object.keys(byId)) expect(byId[id]).toEqual(['REAL']);
    expect(sse.text).toContain('task list');
  });

  test('narrowing the padding did NOT disable it — a genuinely dangling id is still repaired', async () => {
    await warmUp();
    // The stuck error names an ORPHAN id this send is not answering (a leftover
    // from an earlier turn). That one MUST still be padded, on the same
    // session, or the narrowing has quietly become a deletion — which is how a
    // guard in this repo gets hardened into a no-op.
    globalThis.__SCRIPT__ = [sixToolTurn(), finalTurn(ANSWER), ...spares()];
    globalThis.__ARMED__ = armOnFlush('waiting on responses to events [sevt_orphan]');
    // The orphan must be answerable, or the pad send itself 400s.
    const sess = globalThis.__SESSIONS__[globalThis.__SESSIONS__.length - 1];
    globalThis.__ISSUED__[sess].add('sevt_orphan');
    const sse = parseSSE(await postChat('task list off the scope of work'));

    expect(continuesSent()).toEqual(['sevt_orphan']);
    // Repaired IN PLACE — no session was archived to achieve it.
    expect(globalThis.__LOG__.join(' ')).not.toMatch(/ARCHIVE /);
    expect(sse.text).toContain('task list');
    expect(sse.errors).toEqual([]);
  });

  test('a PARTIAL flush replays only the tail, so the recovery does not kill the turn', async () => {
    await warmUp();
    globalThis.__ONCE__ = true; // one answer per id
    globalThis.__SCRIPT__ = [sixToolTurn(), finalTurn(ANSWER), ...spares()];
    // Let the first result land, then wedge on the second. Replaying the whole
    // array here re-answers t1 — a SECOND answer to an answered id, which is a
    // stale-id error, not a stuck one, so the recovery block is skipped
    // altogether and the turn dies with the carry sitting unreachable two lines
    // below it.
    let seen = 0;
    globalThis.__ARMED__ = {
      status: 400, message: STUCK_WITH_IDS,
      when: (evts) => evts.some(e => e.type === 'user.custom_tool_result') && ++seen >= 2
    };
    const sse = parseSSE(await postChat('task list off the scope of work'));
    expect(sse.text).toContain('task list');
    expect(sse.errors).toEqual([]);
    expect(clientFinalize(sse).branch).toBe('text-bubble');
    // Every id answered exactly ONCE, on the SAME session — no id re-answered,
    // no padding, and no session identity thrown away to achieve it.
    const byId = {};
    for (const r of resultsSent()) {
      (byId[r.custom_tool_use_id] = byId[r.custom_tool_use_id] || []).push(1);
    }
    expect(Object.keys(byId).sort()).toEqual(SIX.map(i => 'sevt_' + i));
    for (const id of Object.keys(byId)) expect(byId[id].length).toBe(1);
    expect(continuesSent()).toEqual([]);
    expect(globalThis.__LOG__.join(' ')).not.toMatch(/ARCHIVE /);
  });

  // ── THE COPY. Every clause, on every path that can reach it. ─────────────

  test('a turn that still cannot be delivered says exactly this, and it is true', async () => {
    await warmUp();
    globalThis.__CANONICAL__ = true;
    // A stale id the session never issued, reached through the auto-flush: six
    // tools DID run, the user is looking at six green chips.
    globalThis.__SCRIPT__ = [sixToolTurn(SIX.map(i => 'can_' + i)), finalTurn(ANSWER)];
    globalThis.__ARMED__ = null;
    // Re-key onto canonical ids, then take them away: the session forgot them.
    const sess = globalThis.__SESSIONS__[globalThis.__SESSIONS__.length - 1];
    const orig = globalThis.__ISSUED__[sess];
    globalThis.__ISSUED__[sess] = { has: (id) => !String(id).startsWith('can_') && orig.has(id),
                                    add: (id) => orig.add(id), delete: (id) => orig.delete(id) };
    const sse = parseSSE(await postChat('task list off the scope of work'));
    expect(sse.chips).toBe(6);
    expect(sse.text).toBe('');
    expect(sse.errors[0]).toBe(
      '86 ran 6 tools for this request. Their results could not be delivered back to the ' +
      'model, so it never wrote an answer. Your message and any attachments are saved. ' +
      'Re-sending runs the whole request, including those tools, again.');
    // The old copy claimed approval cards that were never shown and proposals
    // that never existed.
    expect(sse.errors[0]).not.toMatch(/approval cards/);
    expect(sse.errors[0]).not.toMatch(/proposals/);
  });

  test('on stall recovery — where NO tool ran — the message does not claim any ran', async () => {
    await warmUp();
    // The model thinks, runs nothing, and idles requires_action naming an id
    // the session never issued. Stall recovery answers it; that send is the
    // stale one. chipsAppended is 0, so the client shows this sentence ALONE,
    // with nothing on screen to contradict it.
    globalThis.__SCRIPT__ = [
      [ { type: 'session.status_idle',
          stop_reason: { type: 'requires_action', event_ids: ['sevt_ghost'] } } ],
      finalTurn(ANSWER), ...spares()
    ];
    const sse = parseSSE(await postChat('task list off the scope of work'));
    expect(sse.chips).toBe(0);
    expect(sse.errors[0]).toBe(
      '86 could not sync this turn with the model, so it never wrote an answer. ' +
      'Nothing was changed, and your message and any attachments are saved. ' +
      'Re-send it to try again.');
    expect(sse.errors[0]).not.toMatch(/ran the tools|ran \d+ tool/);
  });

  test('/86/chat/continue — the approved write COMMITTED, so the user is not told to re-send', async () => {
    await warmUp();
    const leadsBefore = engine.db.prepare('SELECT COUNT(*) c FROM leads').get().c;
    // The card's tool_use_id belongs to no session: the exact case the old copy
    // was written for. The approval executes server-side BEFORE the result is
    // posted, and execProposeCreateLead has no idempotency key.
    globalThis.__SCRIPT__ = [finalTurn(ANSWER), ...spares()];
    const sse = parseSSE(await post('/api/ai/86/chat/continue', {
      tool_results: [{
        tool_use_id: 'sevt_card_never_issued',
        name: 'propose_create_lead',
        approved: true,
        input: { title: 'Latitude reroof' }
      }]
    }));
    const leadsAfter = engine.db.prepare('SELECT COUNT(*) c FROM leads').get().c;
    // The write really did commit — this is why the copy matters.
    expect(leadsAfter).toBe(leadsBefore + 1);
    expect(sse.errors[0]).toBe(
      'Your approved change was applied and is saved. 86 could not hand that back ' +
      'to the model, so it never wrote a reply. Do NOT re-send this approval — the change ' +
      'is already made. Ask 86 to confirm the current state if you want to check it.');
    // The instruction that would duplicate a live CRM record must not appear.
    expect(sse.errors[0]).not.toMatch(/[Rr]e-send it to run the request again/);
    expect(sse.errors[0]).not.toMatch(/your attachments/);
    expect(sse.errors[0]).toMatch(/Do NOT re-send/);
  });

  test('/86/chat/continue — an approved write that ERRORED is not called "nothing changed"', async () => {
    await warmUp();
    // execProposeCreateLead throws on a missing title — but it can also throw
    // AFTER inserting the clients row it makes first. An approval whose
    // executor ran and failed is a third state: not applied, and not "nothing
    // was changed" either. Claiming the latter would send the user away from a
    // half-written record.
    globalThis.__SCRIPT__ = [finalTurn(ANSWER), ...spares()];
    const sse = parseSSE(await post('/api/ai/86/chat/continue', {
      tool_results: [{
        tool_use_id: 'sevt_card_never_issued_3',
        name: 'propose_create_lead',
        approved: true,
        input: {}
      }]
    }));
    expect(sse.errors[0]).toBe(
      'One approved change reported an error while it ran. 86 could not hand that back ' +
      'to the model, so it never wrote a reply. Do NOT re-send this approval blind — ' +
      'ask 86 to confirm the current state first.');
    expect(sse.errors[0]).not.toMatch(/Nothing was changed/);
    expect(sse.errors[0]).not.toMatch(/was applied and is saved/);
  });

  test('/86/chat/continue — a REJECTED proposal changed nothing, and says so', async () => {
    await warmUp();
    const leadsBefore = engine.db.prepare('SELECT COUNT(*) c FROM leads').get().c;
    globalThis.__SCRIPT__ = [finalTurn(ANSWER), ...spares()];
    const sse = parseSSE(await post('/api/ai/86/chat/continue', {
      tool_results: [{
        tool_use_id: 'sevt_card_never_issued_2',
        name: 'propose_create_lead',
        approved: false,
        reject_reason: 'No thanks.'
      }]
    }));
    expect(engine.db.prepare('SELECT COUNT(*) c FROM leads').get().c).toBe(leadsBefore);
    expect(sse.errors[0]).toBe(
      '86 could not sync this turn with the model, so it never wrote an answer. ' +
      'Nothing was changed. Send 86 a new message to pick this back up.');
    // There is no user message and no attachment on this route; the copy must
    // not reassure about either.
    expect(sse.errors[0]).not.toMatch(/your message|attachments/i);
  });

  // ── THE COMPOUND PATH: in-place recovery, THEN a session swap ─────────
  //
  // The narrowed replay (send the TAIL, not the whole array) is correct for
  // a retry on the SAME session — the old session already took the head, and
  // re-answering an answered id is a stale-id 400, not a stuck one. But the
  // recursion rebinds the parameter, so the nuclear branch in THAT frame was
  // carrying the tail across a session SWAP. The new session holds none of
  // the head, so those results are simply gone — and the turn then ANSWERS,
  // with a full row of green chips and nothing on screen to say the model
  // read five of six jobs. A confidently wrong task list off a scope of work
  // is worse than the dead screen this whole file exists to remove.
  test('in-place recovery THEN a swap still carries every result, not just the tail', async () => {
    await warmUp();
    globalThis.__SCRIPT__ = [sixToolTurn(), finalTurn(ANSWER), ...spares()];
    // EVENTS_PER_SEND is 1, so t1 lands, then the send of t2 throws stuck.
    // The in-place replay of the tail then throws stuck again, which
    // escalates to archive+recreate.
    const stuckOn = (id) => ({
      status: 400, message: STUCK_WITH_IDS,
      when: (evts) => evts.some(e =>
        e.type === 'user.custom_tool_result' && e.custom_tool_use_id === id)
    });
    globalThis.__ARMQ__ = [stuckOn('sevt_t2'), stuckOn('sevt_t2')];
    const sse = parseSSE(await postChat('task list off the scope of work'));

    // The drive must really have gone in-place FIRST and swapped SECOND,
    // else it proves nothing about the interaction.
    const log = globalThis.__LOG__.join(' ');
    expect(log).toMatch(/ARCHIVE .*CREATE /);
    expect(globalThis.__SENT__.some(e =>
      e.type === 'user.custom_tool_result' && e.custom_tool_use_id === 'sevt_t1')).toBe(true);

    // The turn answers…
    expect(sse.text).toContain('task list');
    expect(sse.errors).toEqual([]);
    // …and it answers off ALL SIX reads. Asserted by CONTENT: each job has a
    // distinct title, so a carry that drops the already-delivered head fails
    // here and passes every count-based assertion.
    const carried = carriedMessages();
    expect(carried.length).toBe(1);
    const blob = JSON.stringify(carried[0].content);
    for (const j of JOBS) expect(blob).toContain(j.title);
  });

  // ── THE SIBLING SENTENCES ON THE SAME ROUTE ───────────────────────────
  //
  // staleToolResultMessage is not the only way a turn dies. The stall note
  // is route-blind, and on /86/chat/continue the approved executor has
  // ALREADY COMMITTED by the time the turn can stall. "Nothing was changed.
  // Please send it again." is then false, and re-sending writes the record
  // twice: execProposeCreateLead mints lead_<Date.now()>_<rand> with no
  // idempotency key.
  const stallTurn = () => ([
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [] } }
  ]);
  test('/86/chat/continue — a stalled turn after a COMMITTED write does not invite a re-send', async () => {
    await warmUp();
    // The card's id must be one the session ISSUED, so the approved result
    // is genuinely DELIVERED and the turn dies further downstream, at the
    // stall note — not in the stale-id catch the fix above already covers.
    globalThis.__SCRIPT__ = [[
      { type: 'agent.custom_tool_use', id: 'sevt_stall_card',
        tool_name: 'propose_create_lead', input: { title: 'Stall reroof' } },
      { type: 'session.status_idle',
        stop_reason: { type: 'requires_action', event_ids: ['sevt_stall_card'] } }
    ]];
    await postChat('create that lead');
    const before = engine.db.prepare('SELECT COUNT(*) c FROM leads').get().c;
    // MAX_NUDGES is 2, so three stalls exhaust recovery and reach the note.
    globalThis.__SCRIPT__ = [stallTurn(), stallTurn(), stallTurn(), ...spares()];
    const sse = parseSSE(await post('/api/ai/86/chat/continue', {
      tool_results: [{
        tool_use_id: 'sevt_stall_card',
        name: 'propose_create_lead',
        approved: true,
        input: { title: 'Stall reroof' }
      }]
    }));
    // The write really committed — this is the whole reason the copy matters.
    expect(engine.db.prepare('SELECT COUNT(*) c FROM leads').get().c).toBe(before + 1);
    const shown = sse.text + ' ' + sse.errors.join(' ');
    expect(shown).toMatch(/I hit a snag finishing that request/);
    expect(shown).not.toMatch(/Nothing was changed/);
    expect(shown).not.toMatch(/Please send it again/);
    expect(shown).toMatch(/do NOT re-send this approval/i);
    expect(shown).toMatch(/already applied and is saved/);
  });

  test('/86/chat — a stalled turn with NO approval keeps its wording byte for byte', async () => {
    await warmUp();
    globalThis.__SCRIPT__ = [stallTurn(), stallTurn(), stallTurn(), ...spares()];
    const sse = parseSSE(await postChat('task list off the scope of work'));
    // The gate is a strict superset: on every path that committed nothing the
    // user sees exactly what shipped before, so this is not a copy rewrite.
    expect(sse.text).toContain(
      '⚠️ I hit a snag finishing that request — my tool calls stalled mid-turn ' +
      'and recovery didn\'t take. Nothing was changed. Please send it again.');
  });
});
