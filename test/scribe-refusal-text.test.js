// THE SCRIBE'S REAL REFUSAL REACHES BOTH CHANNELS — AND ONLY ITS REFUSAL DOES.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────
// `driveScribeWrite` has one ok:false ending in which `error` says nothing:
// the Scribe answered in prose and never emitted a payload. That is not a
// malfunction — its baseline instructs it to "return a one-line note saying
// what is missing instead of guessing" — and the note lands in `text`, while
// `error` falls through to the canned 'The Scribe did not produce a valid
// payload.'. `execScribeWrite` read `.error` on BOTH of its channels (the chat
// notice + push, and `recordRefusalOnce` → payloads.apply_error, which is the
// sentence the Live Writer toast and the Cowork ledger actually print), so the
// only useful sentence in the whole failure was discarded four words deep.
//
// ── WHY THIS FILE IS NOT "PREFER text" ───────────────────────────────────
// The first attempt made the message unconditionally text-first and was
// REFUTED: it fixes the refusal and breaks every other ending. A dispatcher
// validation error, a token-budget fail-stop and a stream failure all carry
// the real diagnosis in `error` and whatever the model happened to say in
// `text` — so text-first replaces the reason with chatter on exactly the
// failures where the reason is machine-authored and exact.
//
// So the fix is a DISCRIMINATION, and this file is built to tell the two forms
// apart. The previous suite could not: all 47 of its tests passed on both. Here
// every ok:false ending of driveScribeWrite is enumerated BY DRIVING IT — the
// real driveSubtaskTurn loop over a scripted session stream, the real retry
// loop, the real execEmitPayloadFile and the real payload-dispatcher
// validation — and each ending is then driven through the real execScribeWrite
// to both channels. The unconditional text-first form turns the validation,
// budget and stream cases RED.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = [
  'organizations', 'roles', 'users', 'ai_sessions', 'ai_messages',
  'payloads', 'agent_jobs',
];

// payloads.id is the PRIMARY KEY in server/db.js, but sqliteSchema emits every
// column nullable and no keys — so recordScribeRefusal's `ON CONFLICT (id) DO
// NOTHING` fails to PREPARE and the refusal row silently never lands, leaving
// every ledger assertion below vacuous. The index restores a constraint db.js
// has; it does not invent one.
const engine = createPgSqlite(
  sqliteSchema(TABLES) + '\nCREATE UNIQUE INDEX ux_payloads_id ON payloads(id);\n',
  {
    jsonColumns: ['data', 'capabilities', 'notification_prefs', 'file_content',
      'targets', 'draft_changeset', 'apply_changeset', 'apply_error_detail'],
    dateColumns: ['created_at', 'updated_at', 'last_used_at'],
  }
);
globalThis.__P86_SCRIBE_TEXT_ENGINE__ = engine;

jest.mock('../server/db', () => ({ pool: globalThis.__P86_SCRIBE_TEXT_ENGINE__.pool }));

// ── THE SCRIPTED SESSION STREAM ──────────────────────────────────────────
// Everything between here and execScribeWrite is the REAL code. Only the
// Anthropic transport is scripted, which is the one thing a test cannot have.
const sdk = {
  turns: [],          // array of event-arrays, one per stream() call
  createThrows: null,
  sends: [],
};
globalThis.__P86_SCRIBE_SDK__ = sdk;

jest.mock('@anthropic-ai/sdk', () => {
  const state = globalThis.__P86_SCRIBE_SDK__;
  function FakeAnthropic() {
    return {
      messages: {},
      beta: {
        sessions: {
          create: async () => {
            if (state.createThrows) throw new Error(state.createThrows);
            return { id: 'sess_test_1' };
          },
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

globalThis.__P86_SCRIBE_PUSHES__ = [];
jest.mock('../server/notify-events', () => ({
  sendPushForEvent: async (uid, kind, payload) => {
    globalThis.__P86_SCRIBE_PUSHES__.push({ uid, kind, payload });
  },
}));
const pushes = globalThis.__P86_SCRIBE_PUSHES__;

const aiRoutes = require('../server/routes/ai-routes');
const { driveScribeWrite, execScribeWrite } = aiRoutes.internals;

const ORG = 1;
const USER = 70;
const SESSION = 7;
const CANNED = 'The Scribe did not produce a valid payload.';

// The Scribe's actual one-line diagnosis on a pure refusal — the sentence the
// whole change exists to deliver.
const DIAGNOSIS = "I can't do that: an attachment has no description field the payload DSL can set.";
// What the model says on its way to a MACHINE failure. Chatter: true about its
// own intentions, useless as an explanation of what went wrong.
const CHATTER = 'Sure — emitting the payload for that attachment description now.';

beforeAll(() => {
  const db = engine.db;
  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?,?,?)').run(ORG, 'Alpha', 'alpha');
  db.prepare('INSERT INTO users (id, email, name, role, active, organization_id) VALUES (?,?,?,?,?,?)')
    .run(USER, 'a@a.a', 'A', 'admin', 1, ORG);
  db.prepare('INSERT INTO ai_sessions (id, user_id, entity_type, entity_id, session_kind, label) VALUES (?,?,?,?,?,?)')
    .run(SESSION, USER, 'general', 'global', 'user_thread', 'thread');
});

afterAll(() => engine.close());

beforeEach(() => {
  sdk.turns = [];
  sdk.createThrows = null;
  sdk.sends = [];
  pushes.length = 0;
  engine.db.exec('DELETE FROM ai_messages; DELETE FROM payloads;');
});

const text = (t) => ({ type: 'agent.message', content: [{ type: 'text', text: t }] });
const idle = (kind) => ({ type: 'session.status_idle', stop_reason: { type: kind || 'end_turn' } });
const toolUse = (id, name, input) => ({ type: 'agent.custom_tool_use', id, tool_name: name, input });
const usage = (n) => ({ type: 'span.model_request_end', model_usage: { input_tokens: n, output_tokens: 0 } });

const CTX = { userId: USER, orgId: ORG, parentSession: { id: SESSION, organization_id: ORG } };

// ── HOW MANY TURNS AN ATTEMPT EATS, MEASURED ─────────────────────────────
// driveScribeWrite RETRIES (SCRIBE_MAX_RETRIES = 2), and driveSubtaskTurn keeps
// pulling turns until one arrives with no tool call — so one ATTEMPT is "stream
// turns until a turn with no tool_use", and the value that survives is the LAST
// attempt's. Scripting a single turn and letting the rest fall through to the
// default idle leaves text '' and proves nothing about the real ending: it was
// measured doing exactly that. Both multi-attempt endings below are therefore
// scripted for all three attempts, which is what a live Scribe does when it is
// re-prompted with 'Your payload was not accepted'.
const pushAttempts = (n, build) => { for (let i = 0; i < n; i++) build().forEach((t) => sdk.turns.push(t)); };
// The Scribe re-emits the same refused payload on every attempt.
const emitAttempt = () => [[text(CHATTER), BAD_EMIT, idle('requires_action')], [text(CHATTER), idle('end_turn')]];
// The Scribe answers in prose and never emits, on every attempt.
const refuseAttempt = () => [[text(DIAGNOSIS), idle('end_turn')]];

// An emit_payload_file call the REAL dispatcher refuses on shape — the exact
// failure the refuted fix would have papered over with CHATTER.
const BAD_EMIT = toolUse('tu_1', 'emit_payload_file', {
  title: 'Caption that photo',
  summary: 'Set a description on one attachment',
  targets: [{ entity_type: 'attachment', id: 'att_1', ops: { set: { description: 'x' } } }],
});

// ─────────────────────────────────────────────────────────────────────────
// PART 1 — every ok:false ending of driveScribeWrite, DRIVEN.
// ─────────────────────────────────────────────────────────────────────────
describe('driveScribeWrite — the ok:false endings, enumerated by driving them', () => {
  test('E1 no API key — error, no text, NOT the no-payload ending', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await driveScribeWrite({ instruction: 'x' }, CTX);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/ANTHROPIC_API_KEY/);
      expect(r.text).toBeFalsy();
      expect(r.noPayload).toBeFalsy();
    } finally { process.env.ANTHROPIC_API_KEY = saved; }
  });

  test('E2 no instruction — error, no text', async () => {
    const r = await driveScribeWrite({}, CTX);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/requires intent\.instruction/);
    expect(r.noPayload).toBeFalsy();
  });

  test('E3 organization unresolved — error, no text', async () => {
    const r = await driveScribeWrite({ instruction: 'x' }, { userId: USER, orgId: 999 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not resolve the organization/);
    expect(r.noPayload).toBeFalsy();
  });

  test('E4 session could not be opened — error, no text', async () => {
    sdk.createThrows = 'upstream 503';
    const r = await driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Could not open Scribe session: upstream 503/);
    expect(r.noPayload).toBeFalsy();
  });

  test('E5 VALIDATION REFUSAL — error is the dispatcher reason, text is chatter', async () => {
    // Three turns: driveScribeWrite retries a fixable emit twice.
    pushAttempts(3, emitAttempt);
    const r = await driveScribeWrite({ instruction: 'caption att_1' }, CTX);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/for entity_type=attachment/);
    expect(r.text).toContain(CHATTER);            // the model DID speak
    expect(r.noPayload).toBe(false);              // …and it is not the diagnosis
  });

  test('E6 TOKEN-BUDGET STOP — error is the fail-stop, text is chatter', async () => {
    sdk.turns.push([text(CHATTER), usage(400000), idle('end_turn')]);
    const r = await driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exceeded token budget/);
    expect(r.text).toContain(CHATTER);
    expect(r.noPayload).toBe(false);
  });

  test('E7 STREAM FAILURE — error is the transport failure, text is chatter', async () => {
    sdk.turns.push([text(CHATTER), { type: 'session.error', error: { message: 'upstream 529 overloaded' } }]);
    const r = await driveScribeWrite({ instruction: 'x' }, CTX);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/upstream 529 overloaded/);
    expect(r.text).toContain(CHATTER);
    expect(r.noPayload).toBe(false);
  });

  test('E8 PURE REFUSAL — error is CANNED, the whole diagnosis is in text', async () => {
    pushAttempts(3, refuseAttempt);
    const r = await driveScribeWrite({ instruction: 'caption att_1' }, CTX);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(CANNED);                 // says nothing
    expect(r.text).toBe(DIAGNOSIS);               // says everything
    expect(r.noPayload).toBe(true);               // and THIS is what tells them apart
  });

  test('the discriminant is exact: true on the no-payload ending, false on the rest', async () => {
    // One assertion over several endings, so a future ok:false ending that
    // forgets to set it is caught here rather than by whichever channel starts
    // lying about it.
    const endings = [];
    sdk.createThrows = 'boom';
    endings.push(await driveScribeWrite({ instruction: 'x' }, CTX));
    sdk.createThrows = null;
    pushAttempts(3, emitAttempt);
    endings.push(await driveScribeWrite({ instruction: 'x' }, CTX));
    sdk.turns.push([text(CHATTER), { type: 'session.error', error: { message: 'nope' } }]);
    endings.push(await driveScribeWrite({ instruction: 'x' }, CTX));
    expect(endings.map((e) => !!e.noPayload)).toEqual([false, false, false]);

    pushAttempts(3, refuseAttempt);
    const refusal = await driveScribeWrite({ instruction: 'x' }, CTX);
    expect(refusal.noPayload).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PART 2 — what each ending SAYS, on both channels, through execScribeWrite.
// ─────────────────────────────────────────────────────────────────────────

// execScribeWrite hands back immediately and finishes on a detached chain; the
// refusal row is written on its LAST link, so waiting for that row waits for
// the chat post and the push too.
async function runDetached() {
  const handoff = await execScribeWrite(
    { input: { instruction: 'caption att_1 with "North elevation"' } },
    CTX
  );
  expect(handoff.tier).toBe('auto');   // the hand-off itself never fails
  for (let i = 0; i < 400; i++) {
    const rows = engine.all("SELECT * FROM payloads WHERE status = 'failed'");
    if (rows.length) {
      return {
        ledger: rows[0],
        chat: engine.all('SELECT * FROM ai_messages ORDER BY rowid'),
        push: pushes.slice(),
      };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the detached chain never recorded a refusal row');
}

describe('execScribeWrite — the sentence each channel carries', () => {
  test('PURE REFUSAL: chat, ledger and push all carry the Scribe real sentence', async () => {
    pushAttempts(3, refuseAttempt);
    const { ledger, chat, push } = await runDetached();

    // The ledger — payloads.apply_error — is what the Live Writer toast and
    // the Cowork refusal card print, so it is the channel a user reads today.
    expect(ledger.apply_error).toContain('no description field');
    expect(ledger.apply_error).not.toBe(CANNED);
    expect(ledger.apply_error).not.toContain('did not produce a valid payload');

    // The chat notice — the surface this app calls primary.
    expect(chat.length).toBe(1);
    expect(chat[0].content).toContain("Scribe couldn't complete that draft");
    expect(chat[0].content).toContain('no description field');
    expect(chat[0].content).not.toContain('did not produce a valid payload');

    // And the push body, which is the same string again.
    expect(push.length).toBe(1);
    // The push is a THIRD channel and it fires on the same string. Driven:
    // a refusal produces a Live Writer toast (surface B, whose claims() is
    // always true), this push, and the chat row — and NO Pending-approvals
    // card, because that strip polls status=ready and a refusal is written
    // status=failed. All three carry exactly this sentence.
    expect(push[0].payload.title).toMatch(/Scribe draft failed/);
    expect(push[0].payload.body).toContain('no description field');
    expect(push[0].payload.body).not.toBe(CANNED);
  });

  test('VALIDATION REFUSAL: every channel keeps the dispatcher reason, NOT the chatter', async () => {
    pushAttempts(3, emitAttempt);
    const { ledger, chat, push } = await runDetached();

    expect(ledger.apply_error).toContain('for entity_type=attachment');
    expect(ledger.apply_error).not.toContain(CHATTER);
    expect(chat[0].content).toContain('for entity_type=attachment');
    expect(chat[0].content).not.toContain(CHATTER);
    expect(push[0].payload.body).toContain('for entity_type=attachment');
    expect(push[0].payload.body).not.toContain(CHATTER);
  });

  test('TOKEN-BUDGET STOP: every channel keeps the fail-stop, NOT the chatter', async () => {
    sdk.turns.push([text(CHATTER), usage(400000), idle('end_turn')]);
    const { ledger, chat, push } = await runDetached();

    expect(ledger.apply_error).toMatch(/exceeded token budget/);
    expect(ledger.apply_error).not.toContain(CHATTER);
    expect(chat[0].content).toMatch(/exceeded token budget/);
    expect(chat[0].content).not.toContain(CHATTER);
    expect(push[0].payload.body).not.toContain(CHATTER);
  });

  test('STREAM FAILURE: every channel keeps the transport failure, NOT the chatter', async () => {
    sdk.turns.push([text(CHATTER), { type: 'session.error', error: { message: 'upstream 529 overloaded' } }]);
    const { ledger, chat, push } = await runDetached();

    expect(ledger.apply_error).toContain('upstream 529 overloaded');
    expect(ledger.apply_error).not.toContain(CHATTER);
    expect(chat[0].content).toContain('upstream 529 overloaded');
    expect(chat[0].content).not.toContain(CHATTER);
    expect(push[0].payload.body).not.toContain(CHATTER);
  });

  test('the two channels never disagree — ONE reading feeds both', async () => {
    // The refuted shipping order was "fix the chat message, leave the ledger":
    // the dead channel gets the truth and the live one keeps the canned four
    // words forever. Assert the pair, on the ending where they differ most.
    pushAttempts(3, refuseAttempt);
    const { ledger, chat } = await runDetached();
    expect(chat[0].content).toContain(ledger.apply_error.slice(0, 40));
  });

  test('a failure with NO text at all still says something', async () => {
    // The Scribe emitted nothing and said nothing: there is no diagnosis to
    // prefer, and the canned sentence is the honest answer. A guard that fell
    // through to 'unknown error' here would be worse than what shipped.
    sdk.turns.push([idle('end_turn')]);
    const { ledger, chat } = await runDetached();
    expect(ledger.apply_error).toContain('did not produce a valid payload');
    expect(chat[0].content).toContain('did not produce a valid payload');
    expect(chat[0].content).not.toContain('unknown error');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PART 3 — the ending the discriminant was WRONG about, and the guard that
// nothing was watching. Both were found by driving them; both were green
// either way before these tests existed.
// ─────────────────────────────────────────────────────────────────────────
describe('a refused payment followed by prose is NOT the no-payload ending', () => {
  // THE MIXED ENDING. The Scribe emits, the real dispatcher refuses it with
  // an exact reason, and the Scribe then answers in prose instead of
  // re-emitting. driveScribeWrite re-prompts on a fixable miss and CLEARS
  // lastError to do it, so this drive used to arrive at the terminal return
  // with lastError null, result.error null — indistinguishable from a Scribe
  // that never emitted at all. noPayload came out TRUE and all three channels
  // printed the model chatter. That is not merely uninformative: "Sure -
  // emitting the payload now" under the headline "couldn't complete that
  // draft" tells the user a write is in flight when two were refused and none
  // was written, and it is the exact regression class that refuted attempt 1.
  // `everToolError` outlives the clear; it is ANDed onto the exemption, so the
  // detector itself is unchanged and every other ending is byte-identical.
  const mixed = () => {
    emitAttempt().forEach((t) => sdk.turns.push(t));   // refused, with a reason
    chatter().forEach((t) => sdk.turns.push(t));       // then prose
    chatter().forEach((t) => sdk.turns.push(t));
  };
  const chatter = () => [[text(CHATTER), idle('end_turn')]];

  test('the drive keeps the dispatcher reason and does not claim no-payload', async () => {
    mixed();
    const r = await driveScribeWrite({ instruction: 'caption att_1' }, CTX);
    expect(r.ok).toBe(false);
    expect(r.noPayload).toBe(false);                       // a payload WAS emitted
    expect(r.error).toMatch(/for entity_type=attachment/);
    expect(r.error).not.toBe(CANNED);
    expect(r.text).toContain(CHATTER);                     // the chatter is still there
  });

  test('all three channels print the reason, never the chatter', async () => {
    mixed();
    const { ledger, chat, push } = await runDetached();
    expect(ledger.apply_error).toMatch(/for entity_type=attachment/);
    expect(ledger.apply_error).not.toContain(CHATTER);
    expect(chat[0].content).toMatch(/for entity_type=attachment/);
    expect(chat[0].content).not.toContain(CHATTER);
    expect(push[0].payload.body).not.toContain(CHATTER);
  });

  test('a PURE refusal is untouched by that hardening', async () => {
    // The whole point of ANDing rather than replacing: the ending this change
    // exists to serve must still behave exactly as it did.
    pushAttempts(3, refuseAttempt);
    const r = await driveScribeWrite({ instruction: 'caption att_1' }, CTX);
    expect(r.noPayload).toBe(true);
    expect(r.error).toBe(CANNED);
    expect(r.text).toBe(DIAGNOSIS);
  });
});

describe('a refusal whose only text is whitespace still says something', () => {
  // failureMessage does String(r.text).trim() before preferring text, and
  // NOTHING watched that call: dropping .trim() left every assertion in this
  // file green while the chat notice rendered "Scribe couldn't complete that
  // draft:    " — a headline with a blank reason. The existing "no text at
  // all" test cannot see it, because there r.text is the empty string and the
  // && short-circuits before .trim() is ever reached.
  test('whitespace-only prose falls through to the canned sentence', async () => {
    sdk.turns.push([text('   \n\t  '), idle('end_turn')]);
    sdk.turns.push([text('   \n\t  '), idle('end_turn')]);
    sdk.turns.push([text('   \n\t  '), idle('end_turn')]);
    const { ledger, chat } = await runDetached();
    expect(chat[0].content).toContain('did not produce a valid payload');
    // and specifically NOT a headline with an empty reason after the colon
    expect(chat[0].content).not.toMatch(/draft\*\*:\s*$/m);
    expect(String(ledger.apply_error).trim()).not.toBe('');
  });
});
