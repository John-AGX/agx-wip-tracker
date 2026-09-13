// A REFUSAL THE SCRIBE CANNOT FIX STOPS THE DRIVE — AT EMIT TIME TOO.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────
// The dispatcher marks a refusal that re-emitting cannot fix with
// detail.retryable === false, and driveScribeWrite's retry loop stops on that
// flag instead of prompting "Fix it and re-emit". But the flag was only READ
// in the dry-run catch. Most ticket refusals are decided earlier, by
// validateTarget inside execEmitPayloadFile, whose catch returned a bare
// {error: string} — so status, scope_approved, a re-parent, an invalid op, the
// task cap, a condition and a move side all read as typos. The loop re-prompted,
// and a live Scribe's most available "fix" is to drop the refused field: that
// workaround dry-runs clean, is captured, and under approved:true is APPLIED
// with no card. The user was told one change and got another.
//
// Neighbours of that hole are closed with it and driven here:
//   * the refusal is STICKY for the drive. driveSubtaskTurn hands a refusal back
//     as a tool result and the Scribe may emit again in the SAME attempt, where
//     the retry loop never looks; the per-call reset let that workaround through.
//     Both halves: a refusal decided at emit time AND one the dry run throws.
//   * a draft captured BEFORE a terminal ticket refusal in the same drive is
//     carded, never auto-applied, and the refusal is printed beside it — the
//     user is never handed half a change as if it were the whole one.
//   * a second clean TICKET draft supersedes the first instead of orphaning it
//     in Pending approvals. Only a ticket one: a second payload is not always a
//     re-draft (the photo_updates cap asks for the rest as a second payload),
//     so every other drive keeps both rows, as before.
//
// ── AND WHAT IT MUST NOT DO ─────────────────────────────────────────────
// All of the above is SERVICE TICKETS ONLY. Other entities carry
// retryable:false at emit time too (estimate field_updates.lines, job
// ops.wire_updates, an attachment target's entity_id, a photo_update
// 'description' key); before the passthrough those flags never reached the
// loop, they were re-prompted, and the re-prompt is how they get fixed. And a
// RETRYABLE error — a typo, the wrong tool, a transient dry-run failure — is
// not a refusal: a correct draft after one still auto-applies under
// approved:true, for any entity type. Both are driven below.
//
// ── HOW ──────────────────────────────────────────────────────────────────
// Everything between the scripted Anthropic transport and the chat/push
// channels is the REAL code: driveSubtaskTurn, the retry loop,
// execEmitPayloadFile, and payload-dispatcher's validateTarget. Only the
// dry-run's DB work (applyPayload) and the auto-apply door are stubbed — they
// are what the loop decides whether to reach, so the stubs are the probes.
//
// Every guard is then removed from a copy of the shipped source and the same
// drive is shown to go wrong. The copy uses the file's real line endings (the
// repo is CRLF), an absent or repeated anchor throws, and a replace that moved
// no bytes throws — a mutant can never pass by not having been applied.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
// Each mutant is a fresh compile of a 17k-line module, and a drive runs a
// detached chain; under a parallel run the 5s default is not a property of the code.
jest.setTimeout(60000);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(['organizations', 'roles', 'users', 'ai_sessions', 'ai_messages', 'payloads', 'agent_jobs']) +
    '\nCREATE UNIQUE INDEX ux_payloads_id ON payloads(id);\n' +
    // db.js declares status NOT NULL DEFAULT 'ready' and the derived schema
    // carries no defaults; the supersede delete below is guarded on that value.
    "CREATE TRIGGER payloads_status_default AFTER INSERT ON payloads WHEN NEW.status IS NULL " +
    "BEGIN UPDATE payloads SET status = 'ready' WHERE rowid = NEW.rowid; END;\n",
  {
    jsonColumns: ['data', 'capabilities', 'notification_prefs', 'file_content',
      'targets', 'draft_changeset', 'apply_changeset', 'apply_error_detail'],
    dateColumns: ['created_at', 'updated_at', 'last_used_at'],
  }
);
globalThis.__P86_TERMREF_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_TERMREF_ENGINE__.pool }));

const sdk = { turns: [], sends: [] };
globalThis.__P86_TERMREF_SDK__ = sdk;
jest.mock('@anthropic-ai/sdk', () => {
  const state = globalThis.__P86_TERMREF_SDK__;
  function FakeAnthropic() {
    return {
      messages: {},
      beta: {
        sessions: {
          create: async () => ({ id: 'sess_termref' }),
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

globalThis.__P86_TERMREF_PUSHES__ = [];
jest.mock('../server/notify-events', () => ({
  sendPushForEvent: async (uid, kind, payload) => { globalThis.__P86_TERMREF_PUSHES__.push({ uid, kind, payload }); },
}));
const pushes = globalThis.__P86_TERMREF_PUSHES__;

// The auto-apply door. A call here IS the no-card apply this file guards.
globalThis.__P86_TERMREF_APPLIES__ = [];
jest.mock('../server/routes/payload-routes', () => ({
  isHighRiskPayload: () => false,
  applyPayloadForUser: async (user, id) => {
    globalThis.__P86_TERMREF_APPLIES__.push(id);
    return { ok: true, apply_summary: 'Applied it' };
  },
}));
const applies = globalThis.__P86_TERMREF_APPLIES__;

const dispatcher = require('../server/services/payload-dispatcher');

// ── mutated copies of ai-routes.js ────────────────────────────────────────
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
  const p = path.join(os.tmpdir(), '_p86_termref_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
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
const CTX = { userId: USER, orgId: ORG, parentSession: { id: SESSION, organization_id: ORG } };
// The ctx driveScribeWrite hands execEmitPayloadFile, for the direct call below.
const SCRIBE_CTX = { userId: USER, organizationId: ORG, parentSession: { id: SESSION, organization_id: ORG },
  payloadSource: 'scribe', emittingAgentKey: 'scribe' };
const REPROMPT = 'Your payload was not accepted';

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

const CLEAN_DRY = { dry_run: true, apply_summary: 'Would change one ticket',
  apply_changeset: [{ entity_type: 'service_ticket', id: 'st_1', before: { title: 'a' }, after: { title: 'b' } }] };

// The dry run a payload that passed validateTarget gets. Stubbed because
// whether it is REACHED is the question; its DB work is covered elsewhere.
// dryRunScript([f0, f1, ...]) makes the Nth dry run call fN (null = clean);
// every call past the script is clean.
let dryScript = [];
function dryRunScript(list) { dryScript = list; }
const refusalOnce = (message, detail) => async () => {
  throw new dispatcher.PayloadValidationError(message, detail);
};
function resetDrive() {
  sdk.turns = [];
  sdk.sends = [];
  pushes.length = 0;
  applies.length = 0;
  dryScript = [];
  engine.db.exec('DELETE FROM ai_messages; DELETE FROM payloads;');
  if (drySpy) drySpy.mockRestore();
  let calls = 0;
  drySpy = jest.spyOn(dispatcher, 'applyPayload').mockImplementation(async (row, opts) => {
    if (!opts || !opts.dryRun) throw new Error('only a dry run is expected from the Scribe loop');
    const step = dryScript[calls++];
    if (typeof step === 'function') return step(row, opts);
    return CLEAN_DRY;
  });
}
beforeEach(resetDrive);

const text = (t) => ({ type: 'agent.message', content: [{ type: 'text', text: t }] });
const idle = (kind) => ({ type: 'session.status_idle', stop_reason: { type: kind || 'end_turn' } });
let tuSeq = 0;
const toolUse = (name, input) => ({ type: 'agent.custom_tool_use', id: 'tu_' + (++tuSeq), tool_name: name, input });
const emit = (targets, title) => toolUse('emit_payload_file',
  { title: title || 'Ticket change', summary: 'Change one ticket', targets });

const upd = (ops) => ({ entity_type: 'service_ticket', entity_id: 'st_1', ops: Object.assign({ op: 'update' }, ops) });
const STATUS = [upd({ fields: { status: 'closed' } })];
// What a live Scribe does with "fix it and re-emit": drop the refused field
// and write the same intent somewhere that is allowed.
const WORKAROUND = [upd({ fields: { internal_notes: 'Closed per the office' } })];
const GOOD_CREATE = [{ entity_type: 'service_ticket', ops: { op: 'create', fields: { title: 'Replace fascia', job_id: 'j1' } } }];
const MISSING_TITLE = [{ entity_type: 'service_ticket', ops: { op: 'create', fields: { job_id: 'j1' } } }];
const GOOD_CREATE_2 = [{ entity_type: 'service_ticket', ops: { op: 'create', fields: { title: 'Replace soffit', job_id: 'j1' } } }];
// Passes validateTarget; the dry-run cases decide what happens to it.
const UPDATE_TITLE = [upd({ fields: { title: 'Replace fascia and soffit' } })];

// NON-ticket refusals the dispatcher marks retryable:false at emit time.
const ESTIMATE_LINES = [{ entity_type: 'estimate', entity_id: 'e1', ops: { field_updates: { lines: [] } } }];
const JOB_WIRE = [{ entity_type: 'job', entity_id: 'j1', ops: { wire_updates: [{ node_id: 'n1', pctComplete: 50 }] } }];
const ATTACHMENT_ENTITY_ID = [{ entity_type: 'attachment', entity_id: 'a1', ops: { photo_updates: [{ attachment_id: 'a1', caption: 'x' }] } }];
const PHOTO_DESCRIPTION = [{ entity_type: 'attachment', ops: { photo_updates: [{ attachment_id: 'a1', description: 'x' }] } }];
const ESTIMATE_GOOD = [{ entity_type: 'estimate', entity_id: 'e1', ops: { field_updates: { title: 'Kitchen' } } }];
const ESTIMATE_GOOD_2 = [{ entity_type: 'estimate', entity_id: 'e1', ops: { field_updates: { title: 'Kitchen and bath' } } }];
// A deliberate two-payload split: photo_updates is capped at 60 per target and
// the dispatcher's own refusal says "emit the rest as a second payload".
const photoBatch = (from, n) => [{ entity_type: 'attachment',
  ops: { photo_updates: Array.from({ length: n }, (_, i) => ({ attachment_id: 'a' + (from + i), caption: 'Photo ' + (from + i) })) } }];
const PHOTOS_FIRST_60 = photoBatch(0, 60);
const PHOTOS_REST = photoBatch(60, 12);
// Moves with a ticket on ONE side only.
const MOVE_ESTIMATE_TO_TICKET = [{ op: 'move', source: ESTIMATE_GOOD[0], dest: upd({ fields: { title: 'b' } }) }];
const MOVE_TICKET_TO_LEAD = [{ op: 'move', source: upd({ fields: { title: 'a' } }),
  dest: { entity_type: 'lead', entity_id: 'l1', ops: { field_updates: { title: 'x' } } } }];

// One attempt = stream turns until a turn with no tool call.
const attempt = (targets) => [[emit(targets), idle('requires_action')], [text('Done.'), idle('end_turn')]];
const push = (turns) => turns.forEach((t) => sdk.turns.push(t));
const reprompted = () => sdk.sends.some((b) => JSON.stringify(b).includes(REPROMPT));
const payloadRows = () => engine.all('SELECT id FROM payloads').length;

// A refused emit, then — IF the loop re-prompts — the workaround on every
// later attempt. So a loop that does not stop shows it as ok:true.
function scriptRefusalThenWorkaround(refused) {
  push(attempt(refused));
  push(attempt(WORKAROUND));
  push(attempt(WORKAROUND));
}

// ─────────────────────────────────────────────────────────────────────────
describe('an emit-time refusal is terminal', () => {
  test('status: the loop stops, reports the refusal, and never sends a re-emit prompt', async () => {
    scriptRefusalThenWorkaround(STATUS);
    const r = await shipped.driveScribeWrite({ instruction: 'close st_1' }, CTX);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/service_ticket\.ops\.fields\.status is not writable from a payload/);
    expect(r.noPayload).toBe(false);
    expect(reprompted()).toBe(false);
    expect(drySpy).not.toHaveBeenCalled();     // the workaround was never reached
    expect(payloadRows()).toBe(0);
  });

  test('the positive control: a RETRYABLE emit error still gets its re-emit prompt, and is not a refusal', async () => {
    // Without this the assertion above could pass on a loop that never
    // re-prompts anything.
    push(attempt(MISSING_TITLE));
    push(attempt(GOOD_CREATE));
    const r = await shipped.driveScribeWrite({ instruction: 'raise a ticket on j1' }, CTX);
    expect(reprompted()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.afterRefusal).toBe(false);
    expect(r.refusal).toBeNull();
  });

  test.each([
    ['scope_approved', [upd({ fields: { scope_approved: 'signed' } })], /scope_approved is not writable/],
    ['a re-parent', [upd({ fields: { job_id: 'j2' } })], /never re-parented/],
    ['an invalid op', [upd({ op: 'close', fields: { title: 'x' } })], /ops\.op must be 'create' or 'update'/],
    ['the task cap', [upd({ task_adds: Array.from({ length: 26 }, (_, i) => ({ title: 't' + i })) })], /the cap is 25 per ticket/],
    ['a condition', [Object.assign(upd({ fields: { title: 'x' } }), { condition: 'if_exists' })], /take no condition/],
    ['a move side', [{ op: 'move', source: upd({ fields: { title: 'a' } }), dest: upd({ fields: { title: 'b' } }) }],
      /move\.source cannot be a service_ticket target/],
  ])('%s: terminal at emit, no re-emit prompt, not ok', async (_label, refused, reason) => {
    scriptRefusalThenWorkaround(refused);
    const r = await shipped.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.error).toMatch(reason);
    expect(r.ok).toBe(false);
    expect(reprompted()).toBe(false);
    expect(drySpy).not.toHaveBeenCalled();
  });

  // A ticket on ONE side of a move is enough — each half of the move branch
  // of isTicketPayloadTarget is driven on its own.
  test.each([
    ['an estimate source and a ticket dest', MOVE_ESTIMATE_TO_TICKET, /move\.dest cannot be a service_ticket target/],
    ['a ticket source and a lead dest', MOVE_TICKET_TO_LEAD, /move\.source cannot be a service_ticket target/],
  ])('a move with %s: terminal at emit, no re-emit prompt, not ok', async (_label, refused, reason) => {
    let thrown = null;
    try { dispatcher.validateTarget(refused[0], 0); } catch (e) { thrown = e; }
    expect(thrown && thrown.message).toMatch(reason);
    expect(thrown && thrown.detail && thrown.detail.retryable).toBe(false);

    scriptRefusalThenWorkaround(refused);
    const r = await shipped.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.error).toMatch(reason);
    expect(r.ok).toBe(false);
    expect(reprompted()).toBe(false);
    expect(drySpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Every other entity keeps what it had before the passthrough: re-prompted.
describe('a non-ticket emit-time refusal is STILL re-prompted', () => {
  test.each([
    ['estimate field_updates.lines', ESTIMATE_LINES, /estimate\.ops\.field_updates blocked key: 'lines'/],
    ['job ops.wire_updates', JOB_WIRE, /job\.ops\.wire_updates is RETIRED/],
    ['an attachment target\'s entity_id', ATTACHMENT_ENTITY_ID, /attachment targets take no 'entity_id'/],
    ['a photo_update description key', PHOTO_DESCRIPTION, /unknown key\(s\): 'description'/],
  ])('%s: the dispatcher says retryable:false, and the loop re-prompts exactly as it did before', async (_label, refused, reason) => {
    // The flag really is on the refusal — this is not a retryable error that
    // would be re-prompted anyway.
    let thrown = null;
    try { dispatcher.validateTarget(refused[0], 0); } catch (e) { thrown = e; }
    expect(thrown && thrown.detail && thrown.detail.retryable).toBe(false);

    push(attempt(refused));
    push(attempt(ESTIMATE_GOOD));
    const r = await shipped.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(reprompted()).toBe(true);
    expect(JSON.stringify(sdk.sends)).toMatch(reason);
    expect(r.ok).toBe(true);
    expect(r.afterRefusal).toBe(false);
    expect(drySpy).toHaveBeenCalledTimes(1);
  });

  test('execEmitPayloadFile forwards no detail for a non-ticket refusal, and does for a ticket one', async () => {
    const est = await shipped.execEmitPayloadFile({ input: { title: 't', summary: 's', targets: ESTIMATE_LINES } }, SCRIBE_CTX);
    expect(est.error).toMatch(/blocked key: 'lines'/);
    expect(est).not.toHaveProperty('detail');
    const tk = await shipped.execEmitPayloadFile({ input: { title: 't', summary: 's', targets: STATUS } }, SCRIBE_CTX);
    expect(tk.detail && tk.detail.retryable).toBe(false);
  });

  test('approved:true: an estimate re-draft after that refusal is APPLIED, with no card', async () => {
    push(attempt(ESTIMATE_LINES));
    push(attempt(ESTIMATE_GOOD));
    const { chat } = await runApproved(shipped);
    expect(applies).toHaveLength(1);
    expect(chat[0]).toContain('Applied');
    expect(chat[0]).not.toMatch(/refused/i);
  });

  test('a non-ticket DRY-RUN retryable:false keeps its old shape: the loop stops, but the refusal is not sticky', async () => {
    // Before this change a dry-run refusal ended the retry loop for every
    // entity type and was cleared by the next emit. Tickets are now sticky;
    // an estimate is not.
    dryRunScript([refusalOnce('estimate refused at the dry run', { code: 'assembly_empty', retryable: false, target_index: 0 })]);
    push(attempt(ESTIMATE_GOOD));
    push(attempt(ESTIMATE_GOOD_2));
    let r = await shipped.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(reprompted()).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('estimate refused at the dry run');

    resetDrive();
    dryRunScript([refusalOnce('estimate refused at the dry run', { code: 'assembly_empty', retryable: false, target_index: 0 })]);
    push([[emit(ESTIMATE_GOOD), idle('requires_action')], [emit(ESTIMATE_GOOD_2, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    r = await shipped.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(true);
    expect(drySpy).toHaveBeenCalledTimes(2);
  });

  test('...and with NO target_index the whole payload decides: an estimate-only refusal is still not sticky', async () => {
    // The whole-payload fallback of refusalIsOfTicketTarget, the non-ticket way.
    dryRunScript([refusalOnce('estimate refused, no slot named', { code: 'assembly_empty', retryable: false })]);
    push([[emit(ESTIMATE_GOOD), idle('requires_action')], [emit(ESTIMATE_GOOD_2, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const r = await shipped.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(true);
    expect(r.afterRefusal).toBe(false);
    expect(drySpy).toHaveBeenCalledTimes(2);
  });
});

describe('a terminal refusal is sticky for the whole drive', () => {
  test('a workaround emitted in the SAME attempt is refused, not captured', async () => {
    push([[emit(STATUS), idle('requires_action')], [emit(WORKAROUND), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const r = await shipped.driveScribeWrite({ instruction: 'close st_1' }, CTX);
    expect(r.ok).toBe(false);
    // The ORIGINAL refusal, not the reminder the second emit got.
    expect(r.error).toMatch(/fields\.status is not writable/);
    expect(r.error).not.toMatch(/refusal is final/);
    expect(drySpy).not.toHaveBeenCalled();
    expect(payloadRows()).toBe(0);
    // ...and the Scribe was told why its second emit went nowhere.
    expect(JSON.stringify(sdk.sends)).toMatch(/refusal is final/);
  });
});

// The dry-run half. applyPayload THROWS the refusal here — a ticket already in
// a terminal status is only knowable once the row is read — so the emit-time
// passthrough is not what stops it.
describe('a ticket refusal thrown by the DRY RUN is terminal and sticky too', () => {
  const TERMINAL = 'service_ticket st_1 is closed — a closed ticket is not edited from a payload.';
  const scriptDryRunRefusal = () => {
    dryRunScript([
      refusalOnce(TERMINAL, { code: 'ticket_terminal', field_path: 'entity_id', received: 'closed', retryable: false }),
    ]);
    push([[emit(UPDATE_TITLE), idle('requires_action')], [emit(WORKAROUND, 'Workaround'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    push(attempt(WORKAROUND));
  };

  test('no re-prompt, not ok, the original refusal, and a second emit in the attempt is refused and not captured', async () => {
    scriptDryRunRefusal();
    const r = await shipped.driveScribeWrite({ instruction: 'retitle st_1' }, CTX);
    expect(reprompted()).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(TERMINAL);
    // Reached once — the second emit never got as far as a dry run.
    expect(drySpy).toHaveBeenCalledTimes(1);
    expect(payloadRows()).toBe(0);
    expect(JSON.stringify(sdk.sends)).toMatch(/refusal is final/);
  });

  test('in a mixed payload the refused SLOT decides: the estimate slot is not sticky, the ticket slot is', async () => {
    const MIXED = [ESTIMATE_GOOD[0], UPDATE_TITLE[0]];
    const runWith = async (targetIndex) => {
      resetDrive();
      dryRunScript([refusalOnce('refused at slot ' + targetIndex, { code: 'x', retryable: false, target_index: targetIndex })]);
      push([[emit(MIXED), idle('requires_action')], [emit(ESTIMATE_GOOD_2, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
      return shipped.driveScribeWrite({ instruction: 'x' }, CTX);
    };
    expect((await runWith(0)).ok).toBe(true);
    const ticketSlot = await runWith(1);
    expect(ticketSlot.ok).toBe(false);
    expect(ticketSlot.error).toBe('refused at slot 1');
  });

  test('approved:true never reaches applyPayloadForUser', async () => {
    scriptDryRunRefusal();
    const { chat, push: p } = await runApproved(shipped);
    expect(applies).toHaveLength(0);
    expect(chat[0]).toContain(TERMINAL);
    expect(p[0].payload.title).toMatch(/failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// approve-in-chat through execScribeWrite, to the channels.
async function runApproved(mod, approved) {
  const handoff = await mod.execScribeWrite({ input: { instruction: 'raise a ticket on j1', approved: approved !== false } }, CTX);
  expect(handoff.tier).toBe('auto');
  for (let i = 0; i < 6000; i++) {
    if (pushes.length) {
      return { chat: engine.all('SELECT content FROM ai_messages ORDER BY rowid').map((m) => m.content), push: pushes.slice() };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the detached chain never notified');
}

describe('approve-in-chat: a retryable error is not a refusal', () => {
  test('the positive control: a clean first draft under approved:true IS applied with no card', async () => {
    push(attempt(GOOD_CREATE));
    const { chat, push: p } = await runApproved(shipped);
    expect(applies).toHaveLength(1);
    expect(chat[0]).toContain('Applied');
    expect(p[0].payload.title).toMatch(/Applied/);
  });

  test('a correct draft after a typo in an earlier ATTEMPT is applied', async () => {
    push(attempt(MISSING_TITLE));
    push(attempt(GOOD_CREATE));
    const { chat } = await runApproved(shipped);
    expect(reprompted()).toBe(true);
    expect(applies).toHaveLength(1);
    expect(chat[0]).toContain('Applied');
    expect(chat[0]).not.toMatch(/refused/i);
  });

  test('a correct draft after a typo in the SAME attempt is applied', async () => {
    push([[emit(MISSING_TITLE), idle('requires_action')], [emit(GOOD_CREATE, 'Fixed'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const { chat } = await runApproved(shipped);
    expect(applies).toHaveLength(1);
    expect(chat[0]).toContain('Applied');
  });

  test('...after calling the wrong tool', async () => {
    push([[toolUse('read_entity', { entity_type: 'job', id: 'j1' }), idle('requires_action')], [emit(GOOD_CREATE), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const { chat } = await runApproved(shipped);
    expect(JSON.stringify(sdk.sends)).toMatch(/may only call emit_payload_file/);
    expect(applies).toHaveLength(1);
    expect(chat[0]).toContain('Applied');
  });

  test('...after a transient dry-run error (a plain Error, no retryable flag)', async () => {
    dryRunScript([async () => { throw new Error('connection reset'); }]);
    push([[emit(GOOD_CREATE), idle('requires_action')], [emit(GOOD_CREATE, 'Again'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const { chat } = await runApproved(shipped);
    expect(JSON.stringify(sdk.sends)).toMatch(/connection reset/);
    expect(applies).toHaveLength(1);
    expect(chat[0]).toContain('Applied');
  });
});

// A clean draft A, THEN a terminal ticket refusal of B, in one drive.
describe('a capture followed by a terminal ticket refusal is carded, with the refusal', () => {
  const script = () => push([[emit(GOOD_CREATE), idle('requires_action')], [emit(STATUS), idle('requires_action')], [text('ok'), idle('end_turn')]]);

  test('driveScribeWrite returns the draft AND the refusal, read at the end of the drive', async () => {
    script();
    const r = await shipped.driveScribeWrite({ instruction: 'raise a ticket and close st_1' }, CTX);
    expect(r.ok).toBe(true);
    expect(r.afterRefusal).toBe(true);
    expect(r.refusal).toMatch(/fields\.status is not writable/);
    expect(payloadRows()).toBe(1);
  });

  test('approved:true: NOT applied, the user hears what was refused, and the draft is kept for the card', async () => {
    script();
    const { chat, push: p } = await runApproved(shipped);
    expect(applies).toHaveLength(0);
    expect(chat[0]).toMatch(/Part of what you asked for was refused/);
    expect(chat[0]).toMatch(/fields\.status is not writable/);
    expect(chat[0]).toMatch(/NOT applied even though you approved it/);
    expect(p[0].payload.title).toMatch(/Needs your approval/);
    expect(p[0].payload.body).toMatch(/refused/);
    expect(payloadRows()).toBe(1);
  });

  test('approved:false: the review notice carries the refusal too', async () => {
    script();
    const { chat } = await runApproved(shipped, false);
    expect(applies).toHaveLength(0);
    expect(chat[0]).toMatch(/fields\.status is not writable/);
    expect(chat[0]).not.toMatch(/even though you approved/);
  });
});

// A second clean draft in one drive.
describe('a second clean TICKET emit supersedes the first instead of orphaning it', () => {
  test('service ticket: only the last draft is left, and it is the one returned', async () => {
    push([[emit(GOOD_CREATE, 'First'), idle('requires_action')], [emit(GOOD_CREATE_2, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const r = await shipped.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(true);
    expect(r.afterRefusal).toBe(false);
    const rows = engine.all('SELECT id, title FROM payloads');
    expect(rows).toEqual([{ id: r.payloadId, title: 'Second' }]);
  });

  // Every other drive keeps HEAD's behaviour: the earlier row stays 'ready'.
  // Deleting it lost the first half of a deliberate split with nothing said.
  // Both drafts must carry a ticket target; the two mixed rows pin each half.
  test.each([
    ['estimate', ESTIMATE_GOOD, ESTIMATE_GOOD_2],
    ['a photo_updates batch split at the 60 cap', PHOTOS_FIRST_60, PHOTOS_REST],
    ['a ticket draft, then an estimate draft', GOOD_CREATE, ESTIMATE_GOOD],
    ['an estimate draft, then a ticket draft', ESTIMATE_GOOD, GOOD_CREATE],
  ])('%s: both rows survive, still ready, and the last is the one returned', async (_label, first, second) => {
    push([[emit(first, 'First'), idle('requires_action')], [emit(second, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const r = await shipped.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(true);
    expect(r.afterRefusal).toBe(false);
    expect(drySpy).toHaveBeenCalledTimes(2);
    const rows = engine.all('SELECT title, status FROM payloads ORDER BY title');
    expect(rows).toEqual([{ title: 'First', status: 'ready' }, { title: 'Second', status: 'ready' }]);
    expect(engine.all('SELECT title FROM payloads WHERE id = ?', r.payloadId)).toEqual([{ title: 'Second' }]);
  });

  test('a first draft somebody already approved mid-drive is not removed', async () => {
    dryRunScript([null, async () => {
      engine.db.prepare("UPDATE payloads SET status = 'applied' WHERE title = 'First'").run();
      return CLEAN_DRY;
    }]);
    push([[emit(GOOD_CREATE, 'First'), idle('requires_action')], [emit(GOOD_CREATE_2, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const r = await shipped.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(true);
    expect(engine.all('SELECT title FROM payloads ORDER BY title').map((x) => x.title)).toEqual(['First', 'Second']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('every guard is load-bearing', () => {
  test('RED: without the detail passthrough, the status refusal is re-prompted and the workaround captured', async () => {
    const m = load([[
      '        if (err instanceof payloadDispatcher.PayloadValidationError && err.detail &&\n' +
      '            isTicketPayloadTarget(t)) {\n',
      '        if (false) {\n',
    ]]);
    scriptRefusalThenWorkaround(STATUS);
    const r = await m.driveScribeWrite({ instruction: 'close st_1' }, CTX);
    expect(reprompted()).toBe(true);
    expect(r.ok).toBe(true);
    expect(drySpy).toHaveBeenCalled();
  });

  test('RED: without the ticket scope on the passthrough, an estimate lines refusal is no longer re-prompted', async () => {
    const m = load([[
      '        if (err instanceof payloadDispatcher.PayloadValidationError && err.detail &&\n' +
      '            isTicketPayloadTarget(t)) {\n',
      '        if (err instanceof payloadDispatcher.PayloadValidationError && err.detail) {\n',
    ]]);
    push(attempt(ESTIMATE_LINES));
    push(attempt(ESTIMATE_GOOD));
    const r = await m.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(reprompted()).toBe(false);
    expect(r.ok).toBe(false);
  });

  test('RED: a ticket test that answers true for any target makes the estimate refusal terminal', async () => {
    const m = load([["  return t.entity_type === 'service_ticket';\n}\n", '  return true;\n}\n']]);
    push(attempt(ESTIMATE_LINES));
    push(attempt(ESTIMATE_GOOD));
    const r = await m.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(reprompted()).toBe(false);
    expect(r.ok).toBe(false);
  });

  test('RED: without the move branch of the ticket test, a move naming a ticket is re-prompted', async () => {
    const m = load([[
      "    return !!((t.source && t.source.entity_type === 'service_ticket') ||\n" +
      "              (t.dest && t.dest.entity_type === 'service_ticket'));\n",
      '    return false;\n',
    ]]);
    scriptRefusalThenWorkaround([{ op: 'move', source: upd({ fields: { title: 'a' } }), dest: upd({ fields: { title: 'b' } }) }]);
    const r = await m.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(reprompted()).toBe(true);
    expect(r.ok).toBe(true);
  });

  test.each([
    ['source', "    return !!((t.dest && t.dest.entity_type === 'service_ticket'));\n", MOVE_TICKET_TO_LEAD],
    ['dest', "    return !!((t.source && t.source.entity_type === 'service_ticket'));\n", MOVE_ESTIMATE_TO_TICKET],
  ])('RED: without the %s half of the move branch, a move with a ticket on only that side is re-prompted and the workaround captured', async (_half, replacement, refused) => {
    const m = load([[
      "    return !!((t.source && t.source.entity_type === 'service_ticket') ||\n" +
      "              (t.dest && t.dest.entity_type === 'service_ticket'));\n",
      replacement,
    ]]);
    scriptRefusalThenWorkaround(refused);
    const r = await m.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(reprompted()).toBe(true);
    expect(r.ok).toBe(true);
    expect(drySpy).toHaveBeenCalled();
  });

  test('RED: a whole-payload fallback that answers true holds an estimate-only dry-run refusal to the ticket rule', async () => {
    const m = load([['  return list.some(isTicketPayloadTarget);\n', '  return true;\n']]);
    dryRunScript([refusalOnce('estimate refused, no slot named', { code: 'assembly_empty', retryable: false })]);
    push([[emit(ESTIMATE_GOOD), idle('requires_action')], [emit(ESTIMATE_GOOD_2, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const r = await m.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(false);
    expect(drySpy).toHaveBeenCalledTimes(1);
  });

  test('RED: ignoring the refused slot holds an estimate slot to the ticket rule', async () => {
    const m = load([['  if (idx >= 0 && idx < list.length) return isTicketPayloadTarget(list[idx]);\n', '']]);
    dryRunScript([refusalOnce('refused at slot 0', { code: 'x', retryable: false, target_index: 0 })]);
    push([[emit([ESTIMATE_GOOD[0], UPDATE_TITLE[0]]), idle('requires_action')], [emit(ESTIMATE_GOOD_2, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const r = await m.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(false);
  });

  test('RED: without the emit-time assignment, the same drive is re-prompted and captured', async () => {
    const m = load([[
      '      lastErrorTerminal = !!(res.detail && res.detail.retryable === false);\n',
      '',
    ]]);
    scriptRefusalThenWorkaround(STATUS);
    const r = await m.driveScribeWrite({ instruction: 'close st_1' }, CTX);
    expect(reprompted()).toBe(true);
    expect(r.ok).toBe(true);
  });

  test('RED: without the emit-time terminalRefusal assignment, the in-attempt workaround is captured and a capture-then-refusal is applied', async () => {
    const m = load([['      if (lastErrorTerminal) terminalRefusal = res.error;\n', '']]);
    push([[emit(STATUS), idle('requires_action')], [emit(WORKAROUND), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const r = await m.driveScribeWrite({ instruction: 'close st_1' }, CTX);
    expect(r.ok).toBe(true);
    expect(drySpy).toHaveBeenCalled();
    resetDrive();
    push([[emit(GOOD_CREATE), idle('requires_action')], [emit(STATUS), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const { chat } = await runApproved(m);
    expect(applies).toHaveLength(1);
    expect(chat[0]).not.toMatch(/refused/);
  });

  test('RED: without the sticky refusal, an in-attempt workaround is captured', async () => {
    const m = load([['    if (terminalRefusal) {\n', '    if (false) {\n']]);
    push([[emit(STATUS), idle('requires_action')], [emit(WORKAROUND), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const r = await m.driveScribeWrite({ instruction: 'close st_1' }, CTX);
    expect(r.ok).toBe(true);
    expect(drySpy).toHaveBeenCalled();
  });

  describe('the dry-run half', () => {
    const TERMINAL = 'service_ticket st_1 is closed.';
    const scriptIt = () => {
      dryRunScript([refusalOnce(TERMINAL, { code: 'ticket_terminal', retryable: false })]);
      push([[emit(UPDATE_TITLE), idle('requires_action')], [emit(WORKAROUND, 'Workaround'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
      push(attempt(WORKAROUND));
    };

    test('RED: without the dry-run terminalRefusal assignment, the in-attempt workaround is captured and applied', async () => {
      const m = load([[
        '      if (lastErrorTerminal && refusalIsOfTicketTarget(tu.input && tu.input.targets, e && e.detail)) {\n' +
        '        terminalRefusal = lastError;\n' +
        '      }\n',
        '',
      ]]);
      scriptIt();
      const r = await m.driveScribeWrite({ instruction: 'retitle st_1' }, CTX);
      expect(r.ok).toBe(true);
      expect(drySpy).toHaveBeenCalledTimes(2);
      resetDrive();
      scriptIt();
      await runApproved(m);
      expect(applies).toHaveLength(1);
    });

    test('RED: with the dry-run lastErrorTerminal forced false, the workaround is captured too', async () => {
      const m = load([[
        '      lastErrorTerminal = !!(e && e.detail && e.detail.retryable === false);\n',
        '      lastErrorTerminal = false;\n',
      ]]);
      scriptIt();
      const r = await m.driveScribeWrite({ instruction: 'retitle st_1' }, CTX);
      expect(r.ok).toBe(true);
      resetDrive();
      scriptIt();
      await runApproved(m);
      expect(applies).toHaveLength(1);
    });

    test('RED: without the ticket scope on the dry-run sticky, an estimate dry-run refusal outlives the next emit', async () => {
      const m = load([[
        '      if (lastErrorTerminal && refusalIsOfTicketTarget(tu.input && tu.input.targets, e && e.detail)) {\n',
        '      if (lastErrorTerminal) {\n',
      ]]);
      dryRunScript([refusalOnce('estimate refused at the dry run', { code: 'assembly_empty', retryable: false, target_index: 0 })]);
      push([[emit(ESTIMATE_GOOD), idle('requires_action')], [emit(ESTIMATE_GOOD_2, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
      const r = await m.driveScribeWrite({ instruction: 'x' }, CTX);
      expect(r.ok).toBe(false);
    });
  });

  test('RED: without the card branch, a capture followed by a ticket refusal is applied and the refusal never heard', async () => {
    const m = load([['        if (result.payloadId && result.afterRefusal) {\n', '        if (false) {\n']]);
    push([[emit(GOOD_CREATE), idle('requires_action')], [emit(STATUS), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const { chat } = await runApproved(m);
    expect(applies).toHaveLength(1);
    expect(chat[0]).toContain('Applied');
    expect(chat[0]).not.toMatch(/refused/);
  });

  test('RED: with afterRefusal read at capture time instead of at the end (false), the same drive is applied', async () => {
    const m = load([['      applySummary: captured.applySummary, afterRefusal: !!terminalRefusal,\n',
      '      applySummary: captured.applySummary, afterRefusal: false,\n']]);
    push([[emit(GOOD_CREATE), idle('requires_action')], [emit(STATUS), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const { chat } = await runApproved(m);
    expect(applies).toHaveLength(1);
    expect(chat[0]).toContain('Applied');
  });

  test('RED: with afterRefusal set on any tool error (the old rule), a typo stops approve-in-chat', async () => {
    const m = load([['      applySummary: captured.applySummary, afterRefusal: !!terminalRefusal,\n',
      '      applySummary: captured.applySummary, afterRefusal: !!(terminalRefusal || everToolError),\n']]);
    push(attempt(MISSING_TITLE));
    push(attempt(GOOD_CREATE));
    const { chat } = await runApproved(m);
    expect(applies).toHaveLength(0);
    expect(chat[0]).toMatch(/refused/);
  });

  test('RED: without the supersede delete, the first clean draft is orphaned in Pending approvals', async () => {
    const m = load([[
      "        try { await pool.query(\"DELETE FROM payloads WHERE id = $1 AND status = 'ready'\", [superseded]); } catch (_) {}\n",
      '',
    ]]);
    push([[emit(GOOD_CREATE, 'First'), idle('requires_action')], [emit(GOOD_CREATE_2, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    await m.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(payloadRows()).toBe(2);
  });

  test('RED: without the status guard on that delete, a draft approved mid-drive is removed', async () => {
    const m = load([[
      "DELETE FROM payloads WHERE id = $1 AND status = 'ready'\", [superseded]",
      'DELETE FROM payloads WHERE id = $1", [superseded]',
    ]]);
    dryRunScript([null, async () => {
      engine.db.prepare("UPDATE payloads SET status = 'applied' WHERE title = 'First'").run();
      return CLEAN_DRY;
    }]);
    push([[emit(GOOD_CREATE, 'First'), idle('requires_action')], [emit(GOOD_CREATE_2, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    await m.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(engine.all('SELECT title FROM payloads').map((x) => x.title)).toEqual(['Second']);
  });

  // The ticket scope on the supersede. One mutant drops the whole check, one
  // each half; each is shown deleting a row the shipped drive keeps.
  const SUPERSEDE_SCOPE =
    '      const superseded = captured && captured.payloadId !== payloadId &&\n' +
    '        captured.ticketDraft && ticketDraft ? captured.payloadId : null;\n';
  test.each([
    ['the whole ticket scope', '      const superseded = captured && captured.payloadId !== payloadId ? captured.payloadId : null;\n',
      PHOTOS_FIRST_60, PHOTOS_REST],
    ['the earlier draft\'s half', '      const superseded = captured && captured.payloadId !== payloadId &&\n' +
      '        ticketDraft ? captured.payloadId : null;\n', ESTIMATE_GOOD, GOOD_CREATE],
    ['the later draft\'s half', '      const superseded = captured && captured.payloadId !== payloadId &&\n' +
      '        captured.ticketDraft ? captured.payloadId : null;\n', GOOD_CREATE, ESTIMATE_GOOD],
  ])('RED: without %s on the supersede, the first half of a two-payload drive is deleted', async (_label, replacement, first, second) => {
    const m = load([[SUPERSEDE_SCOPE, replacement]]);
    push([[emit(first, 'First'), idle('requires_action')], [emit(second, 'Second'), idle('requires_action')], [text('ok'), idle('end_turn')]]);
    const r = await m.driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(true);
    expect(engine.all('SELECT title FROM payloads').map((x) => x.title)).toEqual(['Second']);
  });
});
