// FAST APPROVAL, AND THE AI-WRITE GUARDS UNDER IT (John, 2026-09-12).
//   1. the duplicate-emit guard      3. the one line a person approves
//   2. no yes before the line / from  4. approve_pending_write — the bound yes
//      a background run               5. quick_write — the fast lane
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
//    no card and nobody present. That flag is gone entirely now (section 2
//    below), and approve_pending_write is refused to a background run.
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
  // The REAL gate: the line's risk must be the one approve-in-chat applies.
  isHighRiskPayload: (p) => jest.requireActual('../server/routes/payload-routes').isHighRiskPayload(p),
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
    if (path.isAbsolute(spec)) return m;   // a mutant module handed in by absolute path
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
// 2. NO YES BEFORE THE LINE, AND NO YES FROM A BACKGROUND RUN.
//    scribe_write's model-set approved:true applied a draft the moment its dry
//    run came back clean — a yes to words nobody had seen, and from a
//    background task, a yes from nobody at all. The flag is gone: every call
//    drafts. The yes that applies is approve_pending_write (section 4), which
//    a background run is refused outright.
const SOLD = [{ entity_type: 'estimate', entity_id: 'e1', ops: { field_updates: { status: 'sold' } } }];
const scribeTurnsTitled = (targets, title) => [
  [{ type: 'agent.custom_tool_use', id: 'tu_t1', tool_name: 'emit_payload_file',
    input: { title, summary: 'One change', targets } },
   { type: 'session.status_idle', stop_reason: { type: 'requires_action' } }],
  [{ type: 'agent.message', content: [{ type: 'text', text: 'Done.' }] },
   { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }],
];
async function waitForNotice() {
  for (let i = 0; i < 6000; i++) {
    if (pushes.length) return engine.all('SELECT content FROM ai_messages ORDER BY rowid').map((m) => m.content).join('\n');
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the detached Scribe chain never notified');
}
async function driveForeground(mod, targets, title, input) {
  scribeTurnsTitled(targets, title || 'Model title').forEach((t) => sdk.turns.push(t));
  const handoff = await mod.execScribeWrite({ input: Object.assign({ instruction: 'do it' }, input || {}) },
    { userId: USER, organizationId: ORG, parentSession: { id: SESSION, organization_id: ORG } });
  return { handoff, chat: await waitForNotice() };
}
const draftRow = () => engine.all('SELECT id, draft_summary, draft_risk, status FROM payloads')[0];

describe('a yes before the draft exists approves nothing', () => {
  test('THE FINDING: scribe_write with approved:true only DRAFTS — nothing applies', async () => {
    const { handoff, chat } = await driveForeground(shipped, TODO, null, { approved: true });
    expect(applies).toHaveLength(0);
    expect(draftRow().status).toBe('ready');
    expect(handoff.summary).toMatch(/approve_pending_write/);
    expect(handoff.summary).not.toMatch(/APPROVED/);
    expect(chat).toMatch(/Ready to approve/);
  });

  test('a background run is refused approve_pending_write', async () => {
    const cb = shipped.makeBackgroundJobCallback(USER, { question: null }, ORG);
    const r = await cb({ name: 'approve_pending_write', input: {} });
    expect(r.error).toMatch(/Background tasks cannot approve/);
    expect(applies).toHaveLength(0);
  });

  test('MUTANT: without the background refusal, a background run reaches the approval lookup', async () => {
    const mutant = load([["    if (tu && tu.name === 'approve_pending_write') {\n      return { tier: 'auto', error: 'Background tasks cannot approve",
      "    if (false) {\n      return { tier: 'auto', error: 'Background tasks cannot approve"]]);
    const cb = mutant.makeBackgroundJobCallback(USER, { question: null }, ORG);
    const r = await cb({ name: 'approve_pending_write', input: {} });
    expect(String(r.error || '')).not.toMatch(/Background tasks cannot approve/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. THE LINE A PERSON APPROVES IS BUILT FROM THE OPS, AND STORED.
//    The Scribe's notice used to headline the MODEL's title. 2026-08-09: a
//    payload titled "Convert estimate to job" carried only status:'sold'.
describe('the draft line', () => {
  test('a low-risk draft stores its ops line and risk; the notice headlines that line and offers a spoken yes', async () => {
    const { chat } = await driveForeground(shipped, TODO, 'Something the model wrote');
    const row = draftRow();
    expect([row.draft_summary, row.draft_risk]).toEqual(['New to-do — title Call the stucco supplier, due date 2026-09-14', 'low']);
    expect(chat).toContain(row.draft_summary);
    expect(chat).toMatch(/Say yes, or tap \*\*Approve\*\*/);
    expect(chat).not.toContain('Something the model wrote');
  });

  test('THE INCIDENT: titled "Convert estimate to job", the line says status → sold, high risk, and the notice says it needs a tap', async () => {
    const { chat } = await driveForeground(shipped, SOLD, 'Convert estimate to job');
    const row = draftRow();
    expect(row.draft_summary).toMatch(/status → sold/);
    expect(row.draft_risk).toBe('high');
    expect(chat).toMatch(/status → sold/);
    expect(chat).not.toMatch(/Say yes/);
    expect(chat).not.toContain('Convert estimate to job');
  });

  test('MUTANT: the line never persisted — the notice falls back to the model\'s title', async () => {
    const mutant = load([[
      '        draftLine = await persistDraftLine(result.payloadId, result.changeset, scribeCtx.orgId, !!result.afterRefusal);\n', '',
    ]]);
    const { chat } = await driveForeground(mutant, SOLD, 'Convert estimate to job');
    expect(draftRow().draft_summary).toBeNull();
    expect(chat).toContain('Convert estimate to job');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. approve_pending_write — THE YES IS BOUND BY THE SERVER.
//    services/pending-write-approval.js: exactly one ready draft in THIS chat,
//    for THIS user, whose line was on screen (draft_shown_at) BEFORE the yes
//    (the latest user message), low risk by its stored line AND the live gate.
const APPROVER = { id: USER, organization_id: ORG, role: 'admin' };
const YES_CTX = { userId: USER, orgId: ORG, parentSession: { id: SESSION, organization_id: ORG }, gateUser: APPROVER };
let seq = 0;
function seedDraft(opts) {
  const o = Object.assign({ targets: TODO, risk: 'low', line: 'New to-do — title Call the stucco supplier',
    shownSecondsAgo: 30, session: SESSION }, opts || {});
  const id = 'pl_yes_' + (++seq);
  const shownSql = o.shownSecondsAgo == null ? 'NULL' : "datetime('now', ?)";
  const params = [id, ORG, USER, o.session, JSON.stringify(o.targets), o.line, o.risk];
  if (o.shownSecondsAgo != null) params.push('-' + o.shownSecondsAgo + ' seconds');
  engine.db.prepare(
    'INSERT INTO payloads (id, organization_id, user_id, session_id, status, targets, draft_summary, draft_risk, draft_shown_at, created_at) ' +
    "VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, " + shownSql + ", datetime('now', '-60 seconds'))"
  ).run(...params);
  return id;
}
function sayYes(secondsAgo) {
  engine.db.prepare("INSERT INTO ai_messages (id, user_id, role, content, session_id, organization_id, created_at) VALUES (?, ?, 'user', 'yes', ?, ?, datetime('now', ?))")
    .run('aim_yes_' + (++seq), USER, SESSION, ORG, '-' + (secondsAgo || 0) + ' seconds');
}
const approve = (mod) => (mod || shipped).execApprovePendingWrite({ name: 'approve_pending_write', input: {} }, YES_CTX);

describe('approve_pending_write', () => {
  test('THE FEATURE: a yes after the line was on screen applies it, and the reply is the one-line receipt', async () => {
    const id = seedDraft();
    sayYes();
    const r = await approve();
    expect(applies).toEqual([id]);
    expect(r.summary).toContain('✅ Applied — New to-do — title Call the stucco supplier');
  });

  test('a yes BEFORE the card was on screen applies nothing', async () => {
    seedDraft({ shownSecondsAgo: 5 });
    sayYes(20);
    const r = await approve();
    expect(applies).toHaveLength(0);
    expect(r.summary).toMatch(/not on the user's screen yet/);
  });

  test('a draft never shown applies nothing', async () => {
    seedDraft({ shownSecondsAgo: null });
    sayYes();
    expect((await approve()).summary).toMatch(/not on the user's screen yet/);
    expect(applies).toHaveLength(0);
  });

  test('two drafts on screen: a bare yes is ambiguous — nothing applies', async () => {
    seedDraft();
    seedDraft({ line: 'New to-do — title Order soffit vents', targets: TODO_2 });
    sayYes();
    expect((await approve()).summary).toMatch(/Several drafts/);
    expect(applies).toHaveLength(0);
  });

  test('a high-risk draft needs a tap, even after a yes', async () => {
    seedDraft({ targets: SOLD, risk: 'high', line: 'Estimate — status → sold' });
    sayYes();
    expect((await approve()).summary).toMatch(/needs a tap/);
    expect(applies).toHaveLength(0);
  });

  test('a row marked low under an older, looser gate is re-checked: the live gate still refuses status → sold', async () => {
    seedDraft({ targets: SOLD, risk: 'low', line: 'Estimate — status → sold' });
    sayYes();
    expect((await approve()).summary).toMatch(/needs a tap/);
    expect(applies).toHaveLength(0);
  });

  test('another conversation\'s draft is not this yes\'s to approve', async () => {
    seedDraft({ session: 999 });
    sayYes();
    expect((await approve()).summary).toMatch(/Nothing in this conversation/);
    expect(applies).toHaveLength(0);
  });

  test('a part-refused draft (stored high by persistDraftLine) cannot be applied by a yes', async () => {
    const id = seedDraft();
    engine.db.prepare("UPDATE payloads SET draft_risk = 'high' WHERE id = ?").run(id);
    sayYes();
    expect((await approve()).summary).toMatch(/needs a tap/);
    expect(applies).toHaveLength(0);
  });

  // ── mutants of the binding rule (services/pending-write-approval.js) ────
  const SERVICE = path.join(REPO, 'server', 'services', 'pending-write-approval.js');
  function withServiceMutant(find, replace) {
    const src = fs.readFileSync(SERVICE, 'utf8');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const f = find.split('\n').join(eol);
    if (src.split(f).length !== 2) throw new Error('SERVICE MUTATION ANCHOR not found exactly once: ' + find.slice(0, 80));
    const out = src.replace(f, replace.split('\n').join(eol));
    if (out === src) throw new Error('SERVICE MUTATION CHANGED NO BYTES');
    const p = path.join(os.tmpdir(), '_p86_pwa_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
    fs.writeFileSync(p, out, 'utf8');
    loadedPaths.push(p);
    return load([["  const { findApprovableDraft, REFUSAL_TEXT } = require('../services/pending-write-approval');",
      '  const { findApprovableDraft, REFUSAL_TEXT } = require(' + JSON.stringify(p.split(path.sep).join('/')) + ');']]);
  }

  test('MUTANT: "shown before the yes" removed — a yes typed before the card appeared applies it', async () => {
    const m = withServiceMutant('CASE WHEN draft_shown_at IS NOT NULL AND draft_shown_at < (', 'CASE WHEN 1 = 1 OR draft_shown_at < (');
    seedDraft({ shownSecondsAgo: 5 });
    sayYes(20);
    await approve(m);
    expect(applies).toHaveLength(1);
  });

  test('MUTANT: the ambiguity check removed — a bare yes applies one of two drafts', async () => {
    const m = withServiceMutant('  if (shown.length > 1) return { ok: false, reason: REASONS.several, count: shown.length };\n', '');
    seedDraft();
    seedDraft({ line: 'New to-do — title Order soffit vents', targets: TODO_2 });
    sayYes();
    await approve(m);
    expect(applies).toHaveLength(1);
  });

  test('MUTANT: the stored-risk check removed — a part-refused draft applies on a yes', async () => {
    const m = withServiceMutant("  if (row.draft_risk !== 'low') return { ok: false, reason: REASONS.click_only, row };\n", '');
    const id = seedDraft();
    engine.db.prepare("UPDATE payloads SET draft_risk = 'high' WHERE id = ?").run(id);
    sayYes();
    await approve(m);
    expect(applies).toEqual([id]);
  });

  test('MUTANT: the session scope removed — another conversation\'s draft applies', async () => {
    const m = withServiceMutant('      WHERE organization_id = $1 AND user_id = $2 AND session_id = $3\n', '      WHERE organization_id = $1 AND user_id = $2 AND ($3 = $3)\n');
    seedDraft({ session: 999 });
    sayYes();
    await approve(m);
    expect(applies).toHaveLength(1);
  });

  test('MUTANT: the live-gate re-check removed — a stale "low" on status → sold applies', async () => {
    const m = load([['  if (payloadRoutes.isHighRiskPayload({ targets: found.row.targets })) {\n', '  if (false) {\n']]);
    seedDraft({ targets: SOLD, risk: 'low', line: 'Estimate — status → sold' });
    sayYes();
    await approve(m);
    expect(applies).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. quick_write — THE FAST LANE.
//    A small change is drafted in the SAME turn: the server builds the payload
//    from a flat field map (the model never writes ops), then takes the Scribe
//    draft's road — execEmitPayloadFile, a dry run, the stored line and risk.
//    Nothing is applied here; the one-line card and a later yes do that.
const QW_CTX = { userId: USER, orgId: ORG, parentSession: { id: SESSION, organization_id: ORG } };
const quick = (input, mod) => (mod || shipped).execQuickWrite({ name: 'quick_write', input }, QW_CTX);
const qRows = () => engine.all('SELECT id, status, targets, draft_summary, draft_risk FROM payloads');

describe('quick_write', () => {
  test('THE FEATURE: a lead field update is drafted in this turn — one ready row, its line stored, nothing applied', async () => {
    const r = await quick({ entity_type: 'lead', entity_id: 'l_1', fields: { gate_code: '4455' } });
    expect(r.error).toBeUndefined();
    const rows = qRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ready');
    expect(rows[0].targets).toEqual([{ entity_type: 'lead', entity_id: 'l_1', ops: { op: 'update', fields: { gate_code: '4455' } } }]);
    expect(rows[0].draft_summary).toMatch(/gate code → 4455/);
    expect(rows[0].draft_risk).toBe('low');
    expect(r.summary).toMatch(/^Drafted\./);
    expect(r.summary).toMatch(/approve_pending_write/);
    expect(applies).toHaveLength(0);
    expect(drySpy).toHaveBeenCalledTimes(1);
  });

  test('a job update uses field_updates; a to-do with no id is a create', async () => {
    expect(shipped.buildQuickWriteTarget({ entity_type: 'job', entity_id: 'j_1', fields: { notes: 'Gate code changed' } }).target)
      .toEqual({ entity_type: 'job', entity_id: 'j_1', ops: { field_updates: { notes: 'Gate code changed' } } });
    await quick({ entity_type: 'todo', fields: { title: 'Call the stucco supplier', due_date: '2026-09-14' } });
    expect(qRows()[0].targets).toEqual([{ entity_type: 'todo', ops: { op: 'create', fields: { title: 'Call the stucco supplier', due_date: '2026-09-14' } } }]);
  });

  test('the fast lane end to end: quick_write, the card is shown, the user says yes — applied', async () => {
    await quick({ entity_type: 'todo', fields: { title: 'Call the stucco supplier' } });
    engine.db.exec("UPDATE payloads SET draft_shown_at = datetime('now', '-10 seconds')");
    sayYes();
    const yes = await approve();
    expect(applies).toEqual([qRows()[0].id]);
    expect(yes.summary).toMatch(/✅ Applied — New to-do/);
  });

  test('a money edit on a job is drafted but needs a tap — the summary says so', async () => {
    const r = await quick({ entity_type: 'job', entity_id: 'j_1', fields: { contractAmount: 250000 } });
    expect(qRows()[0].draft_risk).toBe('high');
    expect(r.summary).toMatch(/needs a tap/);
  });

  test.each([
    ['a new lead', { entity_type: 'lead', fields: { title: 'Smith Residence' } }, /Creating a lead goes through scribe_write/],
    ['an estimate', { entity_type: 'estimate', entity_id: 'e_1', fields: { title: 'x' } }, /cannot update a estimate|cannot update/],
    ['a structured value', { entity_type: 'lead', entity_id: 'l_1', fields: { notes: { text: 'x' } } }, /plain values only/],
    ['no fields', { entity_type: 'lead', entity_id: 'l_1', fields: {} }, /at least one field/],
    ['too many fields', { entity_type: 'lead', entity_id: 'l_1', fields: Object.fromEntries(Array.from({ length: 13 }, (_, i) => ['f' + i, 'x'])) }, /more than a quick change/],
  ])('refuses %s with no row written', async (_label, input, message) => {
    const r = await quick(input);
    expect(r.error).toMatch(message);
    expect(qRows()).toHaveLength(0);
    expect(drySpy).not.toHaveBeenCalled();
  });

  test('a field the dispatcher refuses comes back as an error, with no row', async () => {
    const r = await quick({ entity_type: 'lead', entity_id: 'l_1', fields: { phone: '555-0100' } });
    expect(r.error).toMatch(/non-editable column/);
    expect(qRows()).toHaveLength(0);
  });

  test('a change whose dry run fails is discarded — nothing waits in Pending approvals', async () => {
    drySpy.mockImplementationOnce(async () => { throw new Error('lead l_1 not found'); });
    const r = await quick({ entity_type: 'lead', entity_id: 'l_1', fields: { gate_code: '1' } });
    expect(r.error).toMatch(/would not apply: lead l_1 not found/);
    expect(qRows()).toHaveLength(0);
  });

  test('MUTANT: without the discard, a draft that cannot apply sits in Pending approvals', async () => {
    const m = load([["    try { await pool.query('DELETE FROM payloads WHERE id = $1 AND organization_id = $2', [payloadId, orgId]); } catch (_) {}\n", '']]);
    drySpy.mockImplementationOnce(async () => { throw new Error('lead l_1 not found'); });
    await quick({ entity_type: 'lead', entity_id: 'l_1', fields: { gate_code: '1' } }, m);
    expect(qRows()).toHaveLength(1);
  });

  test('MUTANT: without the plain-values check, a structured value reaches the dispatcher', async () => {
    const m = load([['    if (!scalar) return {', '    if (false) return {']]);
    const r = await quick({ entity_type: 'lead', entity_id: 'l_1', fields: { notes: { text: 'x' } } }, m);
    expect(String(r.error || '')).not.toMatch(/plain values only/);
  });

  test('MUTANT: without the create allowlist, quick_write would try to create a lead', async () => {
    const m = load([['  if (!QUICK_WRITE_CREATE.has(type)) {', '  if (false) {']]);
    expect(m.buildQuickWriteTarget({ entity_type: 'lead', fields: { title: 'x' } }).target)
      .toEqual({ entity_type: 'lead', ops: { op: 'create', fields: { title: 'x' } } });
  });
});
