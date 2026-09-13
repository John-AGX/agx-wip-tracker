// TWO AI-WRITE GUARDS THAT LOOKED PRESENT AND DID NOTHING.
//
// 1. THE DUPLICATE-EMIT GUARD COULD NEVER MATCH. execEmitPayloadFile looked
//    for a recent row with byte-identical file_content — but file_content
//    carries emitted_at (a fresh timestamp) and id (a fresh payload id), so no
//    two emits were ever equal. The 2026-08-09 double lead (two clients, two
//    leads from one request) had a guard written for it that could not fire.
//    It now keys on the change itself: org + user + agent + targets, live rows
//    only, 90 seconds.
//
// 2. A BACKGROUND RUN COULD APPROVE ITS OWN WRITE. makeBackgroundJobCallback
//    refused approval-tier tools, but scribe_write is auto-tier, and its
//    approved:true — a flag the MODEL sets — applied the Scribe's draft with
//    no card and nobody present. The flag is now stripped there; the draft is
//    still written and waits in Pending approvals.
//
// Everything between the scripted Anthropic transport and the chat/push
// channels is the REAL ai-routes.js; only the dry run and the apply door are
// stubbed (they are the probes). Each guard is then removed from a copy of the
// shipped source and the same drive is shown to go wrong.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
jest.setTimeout(60000);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(['organizations', 'roles', 'users', 'ai_sessions', 'ai_messages', 'payloads', 'agent_jobs']) +
    '\nCREATE UNIQUE INDEX ux_payloads_id ON payloads(id);\n' +
    "CREATE TRIGGER payloads_status_default AFTER INSERT ON payloads WHEN NEW.status IS NULL " +
    "BEGIN UPDATE payloads SET status = 'ready' WHERE rowid = NEW.rowid; END;\n" +
    // …and no created_at default either; the dedupe window reads it.
    "CREATE TRIGGER payloads_created_default AFTER INSERT ON payloads WHEN NEW.created_at IS NULL " +
    "BEGIN UPDATE payloads SET created_at = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid; END;\n",
  {
    jsonColumns: ['data', 'capabilities', 'notification_prefs', 'file_content',
      'targets', 'draft_changeset', 'apply_changeset', 'apply_error_detail'],
    dateColumns: ['created_at', 'updated_at', 'last_used_at'],
  }
);
globalThis.__P86_AWS_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_AWS_ENGINE__.pool }));

const sdk = { turns: [], sends: [] };
globalThis.__P86_AWS_SDK__ = sdk;
jest.mock('@anthropic-ai/sdk', () => {
  const state = globalThis.__P86_AWS_SDK__;
  function FakeAnthropic() {
    return {
      messages: {},
      beta: {
        sessions: {
          create: async () => ({ id: 'sess_aws' }),
          archive: async () => ({}),
          events: {
            stream: async () => {
              const events = state.turns.shift()
                || [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }];
              return {
                controller: { abort: () => {} },
                [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
              };
            },
            send: async (id, body) => { state.sends.push(body); return {}; },
          },
        },
      },
    };
  }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

jest.mock('../server/routes/admin-agents-routes', () => ({
  ensureManagedEnvironment: async () => ({ anthropic_environment_id: 'env_1' }),
  ensureManagedAgent: async () => ({ anthropic_agent_id: 'agent_scribe' }),
}));

globalThis.__P86_AWS_PUSHES__ = [];
jest.mock('../server/notify-events', () => ({
  sendPushForEvent: async (uid, kind, payload) => { globalThis.__P86_AWS_PUSHES__.push({ uid, kind, payload }); },
}));
const pushes = globalThis.__P86_AWS_PUSHES__;

globalThis.__P86_AWS_APPLIES__ = [];
jest.mock('../server/routes/payload-routes', () => ({
  isHighRiskPayload: () => false,
  applyPayloadForUser: async (user, id) => {
    globalThis.__P86_AWS_APPLIES__.push(id);
    return { ok: true, apply_summary: 'Applied it' };
  },
}));
const applies = globalThis.__P86_AWS_APPLIES__;

const dispatcher = require('../server/services/payload-dispatcher');

const REPO = path.join(__dirname, '..');
const REAL = path.join(REPO, 'server', 'routes', 'ai-routes.js');
const REAL_DIR = path.dirname(REAL);
const SOURCE = fs.readFileSync(REAL, 'utf8');
const BUILTINS = new Set(require('module').builtinModules);
const abs = (p) => p.split(path.sep).join('/');
function absolutizeRequires(src) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (m, q, spec) => {
    if (spec.startsWith('.')) return `require(${q}${abs(path.resolve(REAL_DIR, spec))}${q})`;
    if (BUILTINS.has(spec) || spec.startsWith('node:')) return m;
    return `require(${q}${abs(path.join(REPO, 'node_modules', spec))}${q})`;
  });
}
const loadedPaths = [];
function load(pairs) {
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const at = out.indexOf(f);
    if (at === -1) throw new Error('MUTATION ANCHOR NOT FOUND: ' + JSON.stringify(f.slice(0, 200)));
    if (out.indexOf(f, at + 1) !== -1) throw new Error('MUTATION ANCHOR NOT UNIQUE: ' + JSON.stringify(f.slice(0, 200)));
    const next = out.slice(0, at) + r + out.slice(at + f.length);
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + f.slice(0, 80));
    out = next;
  }
  const p = path.join(os.tmpdir(), '_p86_aws_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out), 'utf8');
  loadedPaths.push(p);
  jest.useFakeTimers();
  let m;
  try { m = require(p); } finally { jest.useRealTimers(); }
  return m.internals;
}

const ORG = 1;
const USER = 70;
const SESSION = 7;
const CTX86 = { userId: USER, organizationId: ORG, parentSession: { id: SESSION, organization_id: ORG } };

let shipped;
let drySpy;
beforeAll(() => {
  const db = engine.db;
  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?,?,?)').run(ORG, 'Alpha', 'alpha');
  db.prepare('INSERT INTO users (id, email, name, role, active, organization_id) VALUES (?,?,?,?,?,?)')
    .run(USER, 'a@a.a', 'A', 'admin', 1, ORG);
  db.prepare('INSERT INTO ai_sessions (id, user_id, entity_type, entity_id, session_kind, label) VALUES (?,?,?,?,?,?)')
    .run(SESSION, USER, 'general', 'global', 'user_thread', 'thread');
  shipped = load([]);
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 25));
  if (drySpy) drySpy.mockRestore();
  engine.close();
  for (const p of loadedPaths) { try { fs.unlinkSync(p); } catch (_) {} }
});
beforeEach(() => {
  sdk.turns = [];
  sdk.sends = [];
  pushes.length = 0;
  applies.length = 0;
  engine.db.exec('DELETE FROM ai_messages; DELETE FROM payloads;');
  if (drySpy) drySpy.mockRestore();
  drySpy = jest.spyOn(dispatcher, 'applyPayload').mockImplementation(async () => ({
    dry_run: true, apply_summary: 'Would add one to-do',
    apply_changeset: [{ entity_type: 'todo', id: 'td_1', before: null, after: { title: 'Call the stucco supplier' } }],
  }));
});

const TODO = [{ entity_type: 'todo', ops: { op: 'create', fields: { title: 'Call the stucco supplier', due_date: '2026-09-14' } } }];
const TODO_2 = [{ entity_type: 'todo', ops: { op: 'create', fields: { title: 'Order soffit vents', due_date: '2026-09-14' } } }];
const emitTu = (targets, title) => ({ input: { title: title || 'Add a to-do', summary: 'One to-do', targets } });
const rows = () => engine.all('SELECT id, status FROM payloads');

// ─────────────────────────────────────────────────────────────────────────
describe('the duplicate-emit guard', () => {
  test('THE FINDING: the same change emitted twice in a row writes ONE payload, even reworded', async () => {
    const first = await shipped.execEmitPayloadFile(emitTu(TODO), CTX86);
    expect(first.error).toBeUndefined();
    const second = await shipped.execEmitPayloadFile(emitTu(TODO, 'Add that to-do'), CTX86);
    expect(second.summary).toMatch(/already submitted moments ago/);
    expect(second.meta).toBeUndefined();
    expect(rows()).toHaveLength(1);
  });

  test('a different change is not a duplicate', async () => {
    await shipped.execEmitPayloadFile(emitTu(TODO), CTX86);
    await shipped.execEmitPayloadFile(emitTu(TODO_2), CTX86);
    expect(rows()).toHaveLength(2);
  });

  test('a rejected prior row does not swallow the retry', async () => {
    await shipped.execEmitPayloadFile(emitTu(TODO), CTX86);
    engine.db.exec("UPDATE payloads SET status = 'rejected'");
    await shipped.execEmitPayloadFile(emitTu(TODO), CTX86);
    expect(rows().map((r) => r.status).sort()).toEqual(['ready', 'rejected']);
  });

  test('MUTANT: without the live-rows filter, a rejected change can never be retried for 90 seconds', async () => {
    const mutant = load([["            AND status IN ('ready', 'applying', 'applied')\n", '']]);
    await mutant.execEmitPayloadFile(emitTu(TODO), CTX86);
    engine.db.exec("UPDATE payloads SET status = 'rejected'");
    await mutant.execEmitPayloadFile(emitTu(TODO), CTX86);
    expect(rows().map((r) => r.status)).toEqual(['rejected']);
  });

  test('MUTANT: keyed on file_content again — the guard never fires and the change is written twice', async () => {
    const mutant = load([[
      "            AND emitting_agent_key IS NOT DISTINCT FROM $4\n" +
      "            AND targets = $3::jsonb\n",
      "            AND emitting_agent_key IS NOT DISTINCT FROM $4\n" +
      "            AND file_content = $3::jsonb\n",
    ], [
      '[orgId, ctx.userId || null, JSON.stringify(targets), emittingAgentKey]',
      '[orgId, ctx.userId || null, JSON.stringify(fileContent), emittingAgentKey]',
    ]]);
    await mutant.execEmitPayloadFile(emitTu(TODO), CTX86);
    await mutant.execEmitPayloadFile(emitTu(TODO), CTX86);
    expect(rows()).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
const scribeTurns = (targets) => [
  [{ type: 'agent.custom_tool_use', id: 'tu_s1', tool_name: 'emit_payload_file',
    input: { title: 'Add a to-do', summary: 'One to-do', targets } },
   { type: 'session.status_idle', stop_reason: { type: 'requires_action' } }],
  [{ type: 'agent.message', content: [{ type: 'text', text: 'Done.' }] },
   { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }],
];

async function driveBackground(mod) {
  scribeTurns(TODO).forEach((t) => sdk.turns.push(t));
  const cb = mod.makeBackgroundJobCallback(USER, { question: null }, ORG);
  const handoff = await cb({ name: 'scribe_write', input: { instruction: 'add a to-do to call the stucco supplier', approved: true } });
  expect(handoff && handoff.error).toBeFalsy();
  for (let i = 0; i < 6000; i++) {
    if (pushes.length) {
      return { handoff, chat: engine.all('SELECT content FROM ai_messages ORDER BY rowid').map((m) => m.content) };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the detached Scribe chain never notified');
}

describe('a background run cannot approve its own write', () => {
  test('THE FINDING: approved:true from a background run leaves the draft for a person — nothing applies', async () => {
    const { handoff, chat } = await driveBackground(shipped);
    expect(handoff.summary).not.toMatch(/APPROVED/);
    expect(applies).toHaveLength(0);
    expect(rows()).toEqual([expect.objectContaining({ status: 'ready' })]);
    expect(chat.join('\n')).toMatch(/Pending approvals/);
  });

  test('MUTANT: without the strip, the model\'s own flag applies the draft with nobody there', async () => {
    const mutant = load([[
      "    if (tu && tu.name === 'scribe_write' && tu.input && tu.input.approved) {\n",
      "    if (false) {\n",
    ]]);
    await driveBackground(mutant);
    expect(applies).toHaveLength(1);
  });
});
