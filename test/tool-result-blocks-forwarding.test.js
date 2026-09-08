// EVERY DISPATCHER FORWARDS A STRUCTURED TOOL RESULT IDENTICALLY.
//
// THE INSTANCE
// `view_attachment_image` returns a STRUCTURED result — `{ blocks: [imageBlock,
// textBlock] }` — so the pixels can ride to the model as tool_result content.
// runV2SessionStream (the live /86/chat dispatcher) forwarded `decision.blocks`.
// driveSubtaskTurn did not: it built `content: [{type:'text', text: summary}]`
// unconditionally, and `summary` for that tool is the literal string
//
//     'Image: ' + filename + ' (' + entity_type + ', ' + sizeKb + ')'
//
// so the model was handed A FILENAME AND A SIZE AND NO PICTURE. Reported from
// the field as "86 opens a project photo and only sees metadata".
//
// THE REASON IT LOOKED LIKE A PROJECT-PHOTO BUG, AND WAS NOT
// The tool is entity-agnostic — same query, same loader, same blocks for a job,
// a lead, an estimate and a project. What differs is WHICH DISPATCHER RUNS.
// Job/lead/estimate photos get looked at in ordinary chat (runV2SessionStream,
// which forwards). Project photos are not on the Assistant's manifest at all
// (read_projects / read_project_photos were cut from ASSISTANT_TOOL_NAMES on
// 2026-07-03, "CUT -> escalate_to_86 instead"), so a question about one must
// ESCALATE — and escalation runs driveSubtaskTurn, which dropped them. The
// variable was the path, never the entity. So the first property below is
// stated across entity types precisely because the field report said they
// differed: a test that only ever drove `entity_type='job'` (which is every
// other attachment fixture in this suite) could not see that.
//
// THE CLASS, NOT THE INSTANCE
// There is more than one place in this file's subject that turns a tool outcome
// into user.custom_tool_result content. One of them honoured `blocks` and the
// others open-coded a text array. That is the defect: not "driveSubtaskTurn has
// a bug" but "the forwarding shape is written out by hand at each site, so a
// site can silently disagree with the contract". These properties therefore
// hold EVERY dispatcher on the same fixture and require the SAME BYTES, and
// pin the one shared constructor they all now call.
//
// WHAT IS DRIVEN, AND WHY THAT IS THE ONLY ACCEPTABLE EVIDENCE
// Reading the dispatcher is how this survived from 2026-05-16 to 2026-09-08.
// Every assertion below runs the REAL dispatcher against a fake Anthropic
// Sessions transport that records the exact events sent, and asserts on the
// recorded bytes — what the model was actually handed. The three live entries
// are driven end to end:
//   PATH  live-chat   POST /api/ai/86/chat        -> runV2SessionStream
//   PATH  escalation  POST /api/ai/86/chat, model calls escalate_to_86
//                     -> execEscalateTo86 -> driveEscalateTo86 -> driveSubtaskTurn
//   PATH  background  runAgentJob                 -> driveSubtaskTurn
// The escalation path is driven through the REAL `escalate_to_86` tool rather
// than by calling the inner function, because "which dispatcher does an
// escalation actually reach" is the question the field report turned on.
//
// SCHEMA IS DERIVED, NEVER TYPED. test/helpers/db-schema.js parses
// server/db.js. A hand-written `attachments` fixture is how a shipped 42703 on
// this very table stayed green for months (see that file's header). The fixture
// here cannot invent a column because it never names one.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
process.env.AGENT_MODE_86 = 'agents';

// Each /86/chat turn spends ~2.2s in harvestOutputFiles' real
// `setTimeout(1100)` indexing-lag backoff (ai-routes.js:4126-4141), and a
// property here can drive four turns. Under jest's 5s default those tests were
// killed mid-drive, the abandoned turn then flushed its tool_result into the
// NEXT test's recording, and two runs of this file disagreed about which paths
// were broken. The timeout is the fix; the epoch stamp below is the belt.
jest.setTimeout(120000);

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = [
  'organizations', 'roles', 'users',
  'projects', 'jobs', 'leads', 'estimates',
  'attachments',
  'agent_jobs', 'ai_sessions', 'ai_messages', 'payloads',
  'context_load_events', 'app_settings', 'email_log', 'org_memory', 'messages'
];

const engine = createPgSqlite(
  sqliteSchema(TABLES, {
    pk: {
      organizations: 'id', roles: 'name', users: 'id', projects: 'id', jobs: 'id',
      leads: 'id', estimates: 'id', attachments: 'id', agent_jobs: 'id',
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

// Statements this fixture does not model are RECORDED, never swallowed
// silently: a test that hides the SQL it could not run is a test that has
// stopped being evidence. node:sqlite has no to_jsonb(); that one statement is
// bookkeeping on agent_jobs.payload and produces no tool result.
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

// Real bytes, so loadPhotoAsBlock builds a real image block. The SAME bytes
// for every key, deliberately: the properties below compare the emitted content
// across entity types byte for byte, and per-key bytes would make them differ
// for a reason that has nothing to do with forwarding. Which key was actually
// read is asserted separately, from __KEYS__.
const PIXEL_MARKER = 'PIXELBYTES';
globalThis.__KEYS__ = [];
jest.mock('../server/storage', () => ({
  storage: {
    getBuffer: async (k) => { globalThis.__KEYS__.push(k); return Buffer.from('PIXELBYTES'); },
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

// ── The fake Sessions transport ──────────────────────────────────────────
// SENT records every event the server hands Anthropic. SCRIPT is a queue of
// turns; each `events.stream()` call shifts one. Nested sessions (an escalation
// opens its own) draw from the same queue, so a script can walk an outer turn
// into an inner subtask turn in order.
globalThis.__SENT__ = [];
globalThis.__SCRIPT__ = [];
globalThis.__SESSIONS__ = [];

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
            return { id };
          },
          archive: async () => ({}),
          // (see the files stub below for why this object exists at all)
          events: {
            send: async (sid, body) => {
              // Stamped with the drive EPOCH. /86/chat leaves fire-and-forget
              // tails running after the response ends (the file-snapshot
              // harvest, session labelling); without the stamp those land in
              // the NEXT drive's recording and two runs of this file disagree
              // with each other. A stale event is now ignorable rather than
              // indistinguishable.
              for (const e of (body.events || [])) {
                globalThis.__SENT__.push(
                  Object.assign({ __session: sid, __epoch: globalThis.__EPOCH__ }, e));
              }
            },
            stream: async (sid) => {
              const turn = globalThis.__SCRIPT__.shift() || [];
              return {
                controller: { abort() {} },
                [Symbol.asyncIterator]() {
                  let i = 0;
                  return {
                    next: async () => (i < turn.length
                      ? { value: turn[i++], done: false }
                      : { value: undefined, done: true })
                  };
                }
              };
            }
          }
        },
        // The output-file harvest (ai-routes.js:4126-4141) polls files.list up
        // to three times with a real setTimeout(1100) between attempts, to ride
        // out Anthropic's indexing lag. With no files stub at all it took the
        // full 2.2s on EVERY turn of this matrix — two minutes of wall clock
        // spent sleeping, and long enough that tests were being killed
        // mid-drive. Yielding one previously-unseen id makes the loop break on
        // the first attempt, which is what a real successful list does. The
        // subsequent download throws and is caught by the same handler that
        // already caught it when this stub did not exist, so nothing is
        // persisted and the observable behaviour is unchanged.
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

const { setRolePool, refreshRoleCache, signToken } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const { execAgentTool, ALLOWED_AUTO_TIER_TOOLS } = aiRoutes.internals;
const { pool } = require('../server/db');
setRolePool(pool);

const ORG_A = 900000001;
const ORG_B = 900000002;           // the victim band this suite uses elsewhere
const USER_A = { id: 10, email: 'a@a.test', name: 'A', role: 'admin', organization_id: ORG_A };
const USER_B = { id: 20, email: 'b@b.test', name: 'B', role: 'admin', organization_id: ORG_B };

// Every image fixture is byte-identical apart from entity_type and the storage
// key, so a difference in the emitted content can only come from the path.
const SIZE = 2416640;
const IMAGES = [
  { id: 'att-job',      entity: 'job',      parent: 'j-a1' },
  { id: 'att-lead',     entity: 'lead',     parent: 'l-a1' },
  { id: 'att-estimate', entity: 'estimate', parent: 'e-a1' },
  { id: 'att-project',  entity: 'project',  parent: 'proj_1788899174934_rtqrb6' }
];

function seed() {
  const db = engine.db;
  for (const t of TABLES) db.exec('DELETE FROM ' + t + ';');
  db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').run(ORG_A, 'AG Exteriors', 'agx');
  db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').run(ORG_B, 'ZZVICTIM Co', 'victim');
  db.prepare('INSERT INTO roles (name,label,capabilities) VALUES (?,?,?)')
    .run('admin', 'Admin', JSON.stringify(['*']));
  const u = db.prepare('INSERT INTO users (id,email,name,role,organization_id,active) VALUES (?,?,?,?,?,1)');
  u.run(10, 'a@a.test', 'A', 'admin', ORG_A);
  u.run(20, 'b@b.test', 'B', 'admin', ORG_B);

  db.prepare('INSERT INTO projects (id,organization_id,name,status) VALUES (?,?,?,?)')
    .run('proj_1788899174934_rtqrb6', ORG_A, 'Fountain Square Gutters', 'active');
  db.prepare('INSERT INTO projects (id,organization_id,name,status) VALUES (?,?,?,?)')
    .run('proj_victim', ORG_B, 'ZZVICTIM Project', 'active');
  db.prepare('INSERT INTO jobs (id,owner_id,organization_id,data) VALUES (?,?,?,?)')
    .run('j-a1', 10, ORG_A, JSON.stringify({ jobNumber: 'G-101' }));
  db.prepare('INSERT INTO leads (id,organization_id,title) VALUES (?,?,?)').run('l-a1', ORG_A, 'A lead');
  db.prepare('INSERT INTO estimates (id,owner_id,organization_id,data) VALUES (?,?,?,?)')
    .run('e-a1', 10, ORG_A, JSON.stringify({ title: 'An estimate' }));

  const att = db.prepare(
    `INSERT INTO attachments (id, organization_id, entity_type, entity_id, filename,
                              mime_type, size_bytes, uploaded_by, web_key, thumb_key, caption)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const f of IMAGES) {
    att.run(f.id, ORG_A, f.entity, f.parent, 'IMG_4412.jpg', 'image/jpeg', SIZE, 10,
            'k/' + f.id, 't/' + f.id, null);
  }
  // The discriminators. Each must produce its OWN sentence, distinguishable
  // from a success and from each other.
  att.run('att-nokey', ORG_A, 'project', 'proj_1788899174934_rtqrb6', 'IMG_NOKEY.jpg',
          'image/jpeg', SIZE, 10, null, null, null);
  att.run('att-pdf', ORG_A, 'project', 'proj_1788899174934_rtqrb6', 'SCOPE.pdf',
          'application/pdf', SIZE, 10, 'k/pdf', null, null);
  // Another tenant's project photo, filename salted so a leak is unmistakable.
  att.run('att-foreign', ORG_B, 'project', 'proj_victim', 'ZZVICTIM_SECRET.jpg',
          'image/jpeg', SIZE, 20, 'k/foreign', 't/foreign', null);
}

beforeAll(async () => { seed(); await refreshRoleCache(); });
beforeEach(() => {
  seed();
  globalThis.__SENT__ = [];
  globalThis.__SCRIPT__ = [];
  globalThis.__SESSIONS__ = [];
  globalThis.__UNMODELLED__ = [];
});

// ── Script fragments ─────────────────────────────────────────────────────
const toolTurn = (id, name, input) => ([
  { type: 'agent.custom_tool_use', id, tool_name: name, input },
  { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [id] } }
]);
const finalTurn = (text) => ([
  { type: 'agent.message', content: [{ type: 'text', text }] },
  { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
]);

// EVERY drive() starts from an empty wire. Without this, a second drive inside
// the same test reads the FIRST drive's result back — which made an earlier
// revision of this file report all five fixtures as identical, including the
// ones that are supposed to differ. A comparison harness that does not clear
// what it compares proves nothing.
let epochSeq = 0;
function resetWire() {
  globalThis.__SENT__ = [];
  globalThis.__SCRIPT__ = [];
  globalThis.__SESSIONS__ = [];
  globalThis.__KEYS__ = [];
  globalThis.__EPOCH__ = ++epochSeq;
  return globalThis.__EPOCH__;
}

// POST /86/chat carries a per-user 20/minute throttle. This matrix makes far
// more than 20 calls as one user, so left alone the later drives 429 and return
// no tool result at all — which reads EXACTLY like the bug under test and made
// two runs of this file disagree with each other. Reset per drive, and assert
// the 200 below, so a throttle can never be mistaken for a dropped image.
const { aiChatLimiter, aiChatHourlyLimiter } = require('../server/rate-limit');
function unthrottle(user) {
  for (const l of [aiChatLimiter, aiChatHourlyLimiter]) {
    try { l.resetKey('u:' + user.id); } catch (_) {}
  }
}
async function postChat(user, message) {
  unthrottle(user);
  const r = await fetch(baseUrl + '/api/ai/86/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenFor(user) },
    body: JSON.stringify({ message })
  });
  const body = await r.text();
  if (r.status !== 200) {
    throw new Error('POST /86/chat answered ' + r.status + ' — not a forwarding result: ' + body.slice(0, 200));
  }
  return body;
}

function resultsSent(epoch) {
  return globalThis.__SENT__.filter(e =>
    e.type === 'user.custom_tool_result' && e.__epoch === epoch);
}
// The one thing every property below reads: the content array the model got
// for the view_attachment_image call, identified by the block that is NOT a
// recovery filler.
function contentFor(useId, epoch) {
  const hits = resultsSent(epoch).filter(e => e.custom_tool_use_id === useId);
  if (hits.length > 1) {
    // Two results for one tool_use id means a recovery branch re-answered it.
    // Silently taking the first would let a 'Continue.' padding stand in for a
    // dropped image, which is the very substitution this file exists to catch.
    throw new Error('AMBIGUOUS: ' + hits.length + ' results for ' + useId + ' :: ' +
      JSON.stringify(hits.map(h => h.content)).slice(0, 300));
  }
  return hits.length ? hits[0].content : null;
}

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/ai', aiRoutes);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });

function tokenFor(user) { return signToken(user); }

// NOTE ON THE SESSION ROW: this harness does NOT pre-insert one. ai_sessions.id
// is BIGSERIAL and anthropic_session_id is NOT NULL (server/db.js:3225-3232), so
// a hand-seeded {id:'sess_live'} row is not a row production could hold — an
// earlier probe of this same bug seeded exactly that, plus an organization_id
// column the table does not have. Letting resolveSessionForChat mint the session
// is both faithful and unforgeable.

// ── PATH live-chat: POST /api/ai/86/chat -> runV2SessionStream ───────────
async function driveLiveChat(attachmentId, user) {
  user = user || USER_A;
  const epoch = resetWire();
  globalThis.__SCRIPT__ = [
    toolTurn('evt_view', 'view_attachment_image', { attachment_id: attachmentId }),
    finalTurn('Looked.')
  ];
  await postChat(user, 'Look at ' + attachmentId + '.');
  return contentFor('evt_view', epoch);
}

// ── PATH escalation: the model calls escalate_to_86, which opens a SUBTASK
// session and runs driveSubtaskTurn. Driven through the real tool.
async function driveEscalation(attachmentId, user) {
  user = user || USER_A;
  const epoch = resetWire();
  globalThis.__SCRIPT__ = [
    // outer session: 86 escalates
    toolTurn('evt_esc', 'escalate_to_86', {
      question: 'Review the walkthrough photo ' + attachmentId + ' for defects.',
      entity_type: 'project', entity_id: 'proj_1788899174934_rtqrb6'
    }),
    // inner subtask session: the escalated agent opens the photo
    toolTurn('evt_view', 'view_attachment_image', { attachment_id: attachmentId }),
    finalTurn('Inner answer.'),      // inner subtask finishes
    finalTurn('Relayed.')            // outer session finishes
  ];
  await postChat(user, 'Escalate a visual review of ' + attachmentId + '.');
  return contentFor('evt_view', epoch);
}

// ── PATH background: runAgentJob -> driveSubtaskTurn ─────────────────────
let ajSeq = 0;
async function driveBackground(attachmentId, user) {
  user = user || USER_A;
  const epoch = resetWire();
  const jobId = 'aj_' + (++ajSeq);   // a fresh row per drive; agent_jobs.id is the PK
  engine.db.prepare(
    'INSERT INTO agent_jobs (id,organization_id,user_id,agent_key,status,title,prompt,payload) VALUES (?,?,?,?,?,?,?,?)'
  ).run(jobId, user.organization_id, user.id, 'job', 'running', 'look', 'Look at ' + attachmentId + '.', '{}');
  globalThis.__SCRIPT__ = [
    toolTurn('evt_view', 'view_attachment_image', { attachment_id: attachmentId }),
    finalTurn('Looked.')
  ];
  await aiRoutes.runAgentJob(jobId);
  return contentFor('evt_view', epoch);
}

const PATHS = [
  { key: 'live-chat',  label: 'runV2SessionStream  (POST /api/ai/86/chat)',        drive: driveLiveChat },
  { key: 'escalation', label: 'driveSubtaskTurn    (escalate_to_86 -> subtask)',   drive: driveEscalation },
  { key: 'background', label: 'driveSubtaskTurn    (runAgentJob, headless)',       drive: driveBackground }
];

// Normalise away the ONE thing a fixture legitimately varies — the entity-type
// word inside the text label — so "identical" means identical. The pixels do
// not need normalising because the storage stub returns the same bytes for
// every key; which key was read is asserted separately in P0.
function normalise(content) {
  return JSON.stringify(content).replace(/\((job|lead|estimate|project), /g, '(ENTITY, ');
}
const hasImage = (content) => Array.isArray(content) && content.some(b => b && b.type === 'image');
const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter(b => b && b.type === 'text').map(b => b.text).join('\n');
// The pixels, DECODED. An image block is only evidence that the picture
// arrived if its payload is actually the fixture's bytes.
function pixelsOf(content) {
  const img = (Array.isArray(content) ? content : []).find(b => b && b.type === 'image');
  if (!img || !img.source || img.source.type !== 'base64') return null;
  return Buffer.from(img.source.data, 'base64').toString('utf8');
}

// ═════════════════════════════════════════════════════════════════════════
// The properties.
// ═════════════════════════════════════════════════════════════════════════

describe('P0 — the fixture reaches the code under test', () => {
  test('view_attachment_image is an auto-tier tool, so a dispatcher DOES forward its result', () => {
    // If it were approval-tier, no dispatcher would ever build a tool_result
    // from it and every property below would pass vacuously.
    expect(ALLOWED_AUTO_TIER_TOOLS.has('view_attachment_image')).toBe(true);
  });

  test('the executor itself returns pixels for every entity type', async () => {
    for (const f of IMAGES) {
      const r = await execAgentTool('view_attachment_image', { attachment_id: f.id },
        { userId: 10, orgId: ORG_A, user: USER_A, gateUser: USER_A });
      expect(Array.isArray(r.blocks)).toBe(true);
      expect(r.blocks[0].type).toBe('image');
    }
  });

  test('each entity type reads its OWN web_key (the constant fixture bytes hide nothing)', async () => {
    globalThis.__KEYS__ = [];
    for (const f of IMAGES) {
      await execAgentTool('view_attachment_image', { attachment_id: f.id },
        { userId: 10, orgId: ORG_A, user: USER_A, gateUser: USER_A });
    }
    expect(globalThis.__KEYS__).toEqual(IMAGES.map(f => 'k/' + f.id));
  });

  test('no unmodelled statement produced a tool result', async () => {
    await driveLiveChat('att-project');
    const noisy = globalThis.__UNMODELLED__.filter(s => /FROM attachments/i.test(s));
    expect(noisy).toEqual([]);
  });
});

describe.each(PATHS)('P1 — $label : entity type does not change the answer', ({ drive }) => {
  test('a JOB image and a PROJECT image yield byte-identical content', async () => {
    const job = await drive('att-job');
    const project = await drive('att-project');
    expect(normalise(project)).toBe(normalise(job));
  });

  test('all four entity types yield byte-identical content', async () => {
    const seen = [];
    for (const f of IMAGES) seen.push([f.entity, normalise(await drive(f.id))]);
    const first = seen[0][1];
    for (const [entity, got] of seen) {
      expect([entity, got]).toEqual([entity, first]);
    }
  });
});

describe.each(PATHS)('P2 — $label : an image never succeeds without pixels', ({ drive }) => {
  test.each(IMAGES.map(f => [f.entity, f.id]))(
    'a %s image is forwarded WITH an image block', async (_entity, id) => {
      const content = await drive(id);
      expect(content).not.toBeNull();
      expect(hasImage(content)).toBe(true);
      expect(pixelsOf(content)).toBe(PIXEL_MARKER);
    });

  test('a text-only forward is never a description of the file', async () => {
    // The exact failure that shipped: content that parses as success, reads as
    // 'Image: IMG_4412.jpg (project, 2360 KB)', and carries no picture. Any
    // text-only forward must be one of the enumerated REFUSALS instead.
    for (const f of IMAGES) {
      const content = await drive(f.id);
      if (!hasImage(content)) {
        throw new Error(
          'PIXELS DROPPED on this path for entity_type=' + f.entity +
          ' — the model received text only: ' + JSON.stringify(textOf(content)));
      }
    }
  });
});

describe.each(PATHS)('P3 — $label : the refusals stay distinguishable', ({ drive }) => {
  test('an image whose bytes are missing says SO, and is not a silent success', async () => {
    const content = await drive('att-nokey');
    expect(hasImage(content)).toBe(false);
    expect(textOf(content)).toMatch(/Could not load image bytes/);
    // and it must not read like the success label
    expect(textOf(content)).not.toMatch(/^Image: /);
  });

  test('a non-image says it is not an image, and names the mime', async () => {
    const content = await drive('att-pdf');
    expect(hasImage(content)).toBe(false);
    expect(textOf(content)).toMatch(/is not an image \(mime=application\/pdf\)/);
  });

  test('the three outcomes are mutually distinguishable', async () => {
    const ok = textOf(await drive('att-project'));
    const nokey = textOf(await drive('att-nokey'));
    const notimg = textOf(await drive('att-pdf'));
    expect(new Set([ok, nokey, notimg]).size).toBe(3);
  });
});

describe.each(PATHS)('P4 — $label : another tenant is refused and the refusal leaks nothing', ({ drive }) => {
  test('org A asking for org B\'s project photo gets no pixels and no metadata', async () => {
    const content = await drive('att-foreign');
    expect(hasImage(content)).toBe(false);
    const wire = JSON.stringify(content);
    expect(wire).not.toContain('ZZVICTIM');       // filename / org name
    expect(wire).not.toContain(String(SIZE));      // size in bytes
    expect(wire).not.toContain('2360 KB');         // size as rendered
    expect(pixelsOf(content)).toBeNull();           // the bytes themselves
    // Refusal must read as absence, not as "exists but denied" — otherwise the
    // door is an existence oracle over every affiliate's attachment ids.
    expect(textOf(content)).toBe('No attachment with id att-foreign.');
  });

  test('org B still gets its OWN photo (the boundary is not a lockout)', async () => {
    const content = await drive('att-foreign', USER_B);
    expect(hasImage(content)).toBe(true);
  });
});

describe('P5 — THE CLASS: every dispatcher emits the same bytes', () => {
  test('all three paths forward one project photo identically', async () => {
    const got = {};
    for (const p of PATHS) got[p.key] = normalise(await p.drive('att-project'));
    const [first, ...rest] = PATHS.map(p => p.key);
    for (const k of rest) {
      expect([k, got[k]]).toEqual([k, got[first]]);
    }
  });

  test('all three paths refuse a foreign photo identically', async () => {
    const got = {};
    for (const p of PATHS) got[p.key] = normalise(await p.drive('att-foreign'));
    const [first, ...rest] = PATHS.map(p => p.key);
    for (const k of rest) expect([k, got[k]]).toEqual([k, got[first]]);
  });

  test('all three paths report a missing-bytes image identically', async () => {
    const got = {};
    for (const p of PATHS) got[p.key] = normalise(await p.drive('att-nokey'));
    const [first, ...rest] = PATHS.map(p => p.key);
    for (const k of rest) expect([k, got[k]]).toEqual([k, got[first]]);
  });

  // The forwarding shape is built by ONE function now. This holds the fourth
  // consumer — the /86/chat/continue approval executor — which cannot be
  // driven end to end because no approval-tier tool returns `blocks` today,
  // so there is no input that would make it emit an image. Driving the
  // constructor directly is the strongest behavioural statement available
  // about that site: it is the same code, given the same inputs.
  // The FOURTH consumer, driven over real HTTP. It cannot be made to emit a
  // real image — no approval-tier executor returns `blocks`, so no input
  // reaches that branch — but it CAN be asked to forward a client-supplied one,
  // and must refuse. Routing this site through the shared constructor without
  // this guard would have turned "the third hand-written copy" into an image
  // injection: `applied_summary` is read straight off req.body.
  test('POST /86/chat/continue refuses to forward CLIENT-SUPPLIED blocks', async () => {
    unthrottle(USER_A);
    // A session for the approval to land on, minted the same way a real turn
    // would mint it.
    await postChat(USER_A, 'hello');
    const sess = await pool.query(
      'SELECT id FROM ai_sessions WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [USER_A.id]);
    expect(sess.rows.length).toBe(1);

    const epoch = resetWire();
    globalThis.__SCRIPT__ = [finalTurn('Acknowledged.')];
    unthrottle(USER_A);
    const r = await fetch(baseUrl + '/api/ai/86/chat/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenFor(USER_A) },
      body: JSON.stringify({
        session_id: sess.rows[0].id,
        tool_results: [{
          tool_use_id: 'evt_appr',
          name: 'propose_something_harmless',
          approved: true,
          applied_summary: { blocks: [{ type: 'image', source: { type: 'file', file_id: 'file_SOMEONE_ELSES' } }] }
        }]
      })
    });
    await r.text();
    const sent = resultsSent(epoch).filter(e => e.custom_tool_use_id === 'evt_appr');
    expect(sent.length).toBe(1);
    expect(hasImage(sent[0].content)).toBe(false);
    expect(JSON.stringify(sent[0].content)).not.toContain('file_SOMEONE_ELSES');
    expect(sent[0].content.every(b => b.type === 'text')).toBe(true);
  });

  test('the shared constructor forwards blocks and falls back to text', () => {
    const { toolResultContent } = aiRoutes.internals;
    expect(typeof toolResultContent).toBe('function');
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } };
    const decision = { summary: 'Image: x.jpg (project, 1 KB)', blocks: [img, { type: 'text', text: 'Image: x.jpg (project, 1 KB)' }] };

    expect(toolResultContent(decision, decision.summary, false)).toEqual(decision.blocks);
    // an error never forwards pixels, however structured the result was
    expect(toolResultContent(decision, 'Error: nope', true)).toEqual([{ type: 'text', text: 'Error: nope' }]);
    // a plain string summary is unchanged
    expect(toolResultContent({ summary: 'Done.' }, 'Done.', false)).toEqual([{ type: 'text', text: 'Done.' }]);
    // the raw executor shape (what /86/chat/continue would hold) also forwards
    expect(toolResultContent({ blocks: [img] }, null, false)).toEqual([img]);
    // and never emits a non-string text
    const odd = toolResultContent({}, { not: 'a string' }, false);
    expect(typeof odd[0].text).toBe('string');
  });
});


