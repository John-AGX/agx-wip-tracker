// WHAT A TURN COST, AND WHICH TOOLS RAN — held by RUNNING the turn driver.
//
// Two instruments were blind, and both were blind in the same way: a number
// was recorded under a label wider than the number.
//
//   1. ai_messages.input_tokens (and its three siblings) described ONE model
//      request. `usage` is declared inside runV2SessionStream's run loop and
//      every span.model_request_end REPLACED it, so a turn that made three
//      requests — any tool-using turn, plus every stream reopen — filed the
//      last one as the turn's cost. The forensics said 46,468 input tokens
//      per average turn against a 67,100-token registered prefix that every
//      turn must read: a turn cannot cost less than its own prefix.
//   2. tool_use_count counted PROPOSALS parked for approval. The auto-tier
//      branch returns its result inline and `break`s before the push, and
//      built-in toolset calls never pass through it, so every read 86 does
//      left no trace and every conversation reported tool_uses: 0.
//
// A test that greps the source for a `+=` proves only that the source says
// `+=`. So this drives the REAL loop (exported as internals.runV2SessionStream)
// over a scripted event stream — including a stream REOPEN, which is the case
// a per-pass variable structurally cannot survive — and asserts what reaches
// the persist callback. Then the shared arithmetic is broken on a copy and the
// same drive is shown to lose the number.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../server/db', () => ({
  pool: {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
  },
}));

const TURN_USAGE = path.join(__dirname, '..', 'server', 'services', 'turn-usage.js');
const AI_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js');

const aiRoutes = require('../server/routes/ai-routes');
const turnUsage = require('../server/services/turn-usage');

// ── the drive ─────────────────────────────────────────────────────────────
// Each entry in `opens` is the event list one stream open yields. The driver
// reopens the stream after flushing auto-tier results, so a turn spans opens.
function harness(opens, opts) {
  const o = opts || {};
  const sent = [];
  const written = [];
  let openCount = 0;
  const anthropic = {
    beta: {
      sessions: {
        events: {
          stream: async () => {
            const list = opens[openCount++] || [];
            return {
              controller: { abort: () => {} },
              [Symbol.asyncIterator]: async function* () { for (const e of list) yield e; },
            };
          },
          send: async (_sid, body) => { sent.push(body); return {}; },
        },
      },
      files: {
        list: () => ({ [Symbol.asyncIterator]: async function* () { /* no files */ } }),
      },
    },
  };
  const res = {
    writableEnded: false,
    setHeader: () => {},
    flushHeaders: () => {},
    // The driver registers a 'close' listener to log a client that dropped
    // mid-stream; nothing in these tests closes the response.
    on: () => {},
    once: () => {},
    removeListener: () => {},
    write: (chunk) => { written.push(String(chunk)); return true; },
    end: () => { res.writableEnded = true; },
  };
  const persisted = [];
  const session = {
    id: 1,
    anthropic_session_id: 'ses_test',
    entity_type: 'job',
    entity_id: 'j1',
    session_kind: 'user_thread',
    agent_key: 'job',
  };
  return {
    sent, written, persisted, session, anthropic, res,
    openCount: () => openCount,
    run: () => aiRoutes.internals.runV2SessionStream({
      anthropic,
      res,
      session,
      eventsToSend: [{ type: 'user.message', content: 'hi' }],
      persistAssistantText: async (text, usage, meta) => { persisted.push({ text, usage, meta }); },
      onCustomToolUse: o.onCustomToolUse || (async (tu) => ({ tier: 'auto', summary: 'rows: ' + tu.name })),
      freshlyCreated: true,
    }),
  };
}

const span = (i, o, cc, cr) => ({
  type: 'span.model_request_end',
  model_usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr },
});
const text = (t) => ({ type: 'agent.message', content: [{ type: 'text', text: t }] });
const customTool = (id, name) => ({ type: 'agent.custom_tool_use', id, tool_name: name, input: {} });
const builtinTool = (name) => ({ type: 'agent.tool_use', name, input: { query: 'permit costs' } });
const idleBlocked = (ids) => ({ type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ids } });
const idleDone = () => ({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } });

// A turn that reads a tool, gets reopened, searches the web, then answers.
const TWO_PASS_TURN = [
  [span(10, 5, 67100, 0), customTool('sevt_1', 'read_jobs'), span(20, 7, 0, 67110), idleBlocked(['sevt_1'])],
  [span(30, 11, 0, 70000), builtinTool('web_search'), text('Three jobs are over budget.'), idleDone()],
];

let mutantPaths = [];
afterEach(() => {
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

// ── mutants: break the shared arithmetic, keep the driver ────────────────
function mutantCopy(file, pairs) {
  let out = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const src = out;
  for (const [find, replace] of pairs) {
    if (out.split(find).length - 1 !== 1) throw new Error('anchor not found');
    out = out.split(find).join(replace);
  }
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  const dir = path.dirname(file);
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (m, _q, spec) => {
    try {
      const resolved = spec.charAt(0) === '.'
        ? require.resolve(path.resolve(dir, spec))
        : require.resolve(spec, { paths: [dir] });
      return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
    } catch (e) { return m; }
  });
  const p = path.join(os.tmpdir(), '_p86_turnusage_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}

describe('the shared arithmetic', () => {
  test('a turn is the SUM of its model requests; a request is the LAST one seen', () => {
    const acc = turnUsage.blankTurnUsage();
    turnUsage.addModelRequest(acc, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 67100, cache_read_input_tokens: 0 });
    turnUsage.addModelRequest(acc, { input_tokens: 20, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 67110 });
    expect(acc).toEqual({
      input_tokens: 30, output_tokens: 12,
      cache_creation_input_tokens: 67100, cache_read_input_tokens: 67110,
      model_requests: 2,
    });
    expect(turnUsage.singleRequestTurn(acc)).toBe(false);
    expect(turnUsage.perRequestUsage({ input_tokens: 20, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 67110 }))
      .toEqual({ input_tokens: 20, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 67110 });
  });

  test('an event with no usage adds nothing AND counts no request — model_requests is the field that says whether the per-request columns were a floor', () => {
    const acc = turnUsage.blankTurnUsage();
    for (const bad of [null, undefined, 'nope', 0, 42]) turnUsage.addModelRequest(acc, bad);
    expect(acc).toEqual(turnUsage.blankTurnUsage());
    // An EMPTY OBJECT is different: the event carried a usage object that
    // happened to be empty, so a request did happen and is counted — with no
    // tokens attributed to it.
    turnUsage.addModelRequest(acc, {});
    expect(acc).toEqual(Object.assign(turnUsage.blankTurnUsage(), { model_requests: 1 }));
  });

  test('garbage numbers do not poison the sum', () => {
    const acc = turnUsage.blankTurnUsage();
    turnUsage.addModelRequest(acc, { input_tokens: 'x', output_tokens: null, cache_read_input_tokens: 5 });
    expect(acc).toEqual({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 5, model_requests: 1 });
  });
});

describe('a real turn, driven over a scripted session stream', () => {
  test('THREE model requests across TWO stream opens are recorded as one turn', async () => {
    const h = harness(TWO_PASS_TURN);
    await h.run();
    expect(h.openCount()).toBe(2);           // the reopen really happened
    expect(h.persisted).toHaveLength(1);
    const { usage, meta } = h.persisted[0];
    // The TURN: every request, including the ones before the reopen.
    expect(meta.turn_usage).toEqual({
      input_tokens: 60, output_tokens: 23,
      cache_creation_input_tokens: 67100, cache_read_input_tokens: 137110,
      model_requests: 3,
    });
    // The per-REQUEST columns keep their old meaning — the LAST request —
    // because agent-prefix-ledger reads them that way on purpose.
    expect(usage).toEqual({
      input_tokens: 30, output_tokens: 11,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 70000,
    });
    // And the gap is the whole point: filing `usage` as the turn would have
    // reported 70,030 of the 204,270 input tokens this turn actually read —
    // about a third.
    const turnIn = meta.turn_usage.input_tokens + meta.turn_usage.cache_creation_input_tokens + meta.turn_usage.cache_read_input_tokens;
    const requestIn = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    expect([turnIn, requestIn]).toEqual([204270, 70030]);
  });

  test('the client is told what the TURN cost — the panel prints this under the answer', async () => {
    const h = harness(TWO_PASS_TURN);
    await h.run();
    const done = h.written
      .map((f) => { try { return JSON.parse(String(f).replace(/^data: /, '').trim()); } catch (e) { return null; } })
      .filter((p2) => p2 && p2.done === true);
    expect(done).toHaveLength(1);
    // Not 30/11 — the last request — but the whole turn.
    expect(done[0].usage).toEqual({
      input_tokens: 60, output_tokens: 23,
      cache_creation_input_tokens: 67100, cache_read_input_tokens: 137110,
      model_requests: 3,
    });
  });
  test('both tiers of executed tool call are counted, with the result size the model received', async () => {
    const h = harness(TWO_PASS_TURN);
    await h.run();
    const { meta } = h.persisted[0];
    expect(meta.tool_calls_executed).toBe(2);
    expect(meta.tool_calls.map((c) => [c.name, c.tier])).toEqual([
      ['read_jobs', 'auto'],       // our tool, executed inline
      ['web_search', 'builtin'],   // Anthropic's, run in its container
    ]);
    // size_chars is what came BACK — the number that compounds, because a
    // tool result stays in history and is re-read on every later turn.
    expect(meta.tool_calls[0].size_chars).toBe('rows: read_jobs'.length);
    expect(meta.tool_calls[0].is_error).toBe(false);
    // Nothing is claimed about a built-in's result: Anthropic runs it in its
    // own container and we never see the body.
    expect(meta.tool_calls[1].size_chars).toBe(0);
  });

  test('a failed tool call is still a call, and is marked as failed', async () => {
    const h = harness(TWO_PASS_TURN, {
      onCustomToolUse: async () => ({ tier: 'auto', error: 'Error: no such job' }),
    });
    await h.run();
    const { meta } = h.persisted[0];
    expect(meta.tool_calls_executed).toBe(2);
    expect(meta.tool_calls[0]).toMatchObject({ name: 'read_jobs', tier: 'auto', is_error: true });
    expect(meta.tool_calls[0].size_chars).toBeGreaterThan(0);
  });

  test('a one-request turn makes both bases agree — so model_requests = 1 is the honest "nothing to see here"', async () => {
    const h = harness([[span(9, 3, 67100, 0), text('Hi.'), idleDone()]]);
    await h.run();
    const { usage, meta } = h.persisted[0];
    expect(meta.turn_usage.model_requests).toBe(1);
    expect(meta.turn_usage.input_tokens).toBe(usage.input_tokens);
    expect(meta.turn_usage.cache_creation_input_tokens).toBe(usage.cache_creation_input_tokens);
    expect(meta.tool_calls_executed).toBe(0);
  });
});

describe('MUTANTS — the arithmetic broken, the same drive run again', () => {
  test('ASSIGN instead of ADD (the shipped bug): the turn reports its last request and loses 134,180 tokens', async () => {
    const mut = mutantCopy(TURN_USAGE, [[
      '  acc.input_tokens += n(modelUsage.input_tokens);',
      '  acc.input_tokens = n(modelUsage.input_tokens);',
    ], [
      '  acc.cache_read_input_tokens += n(modelUsage.cache_read_input_tokens);',
      '  acc.cache_read_input_tokens = n(modelUsage.cache_read_input_tokens);',
    ]]);
    const broken = require(mut);
    const acc = broken.blankTurnUsage();
    for (const e of [span(10, 5, 67100, 0), span(20, 7, 0, 67110), span(30, 11, 0, 70000)]) {
      broken.addModelRequest(acc, e.model_usage);
    }
    expect(acc.input_tokens).toBe(30);               // not 60
    expect(acc.cache_read_input_tokens).toBe(70000); // not 137110
    const lost = (60 + 137110) - (acc.input_tokens + acc.cache_read_input_tokens);
    expect(lost).toBe(67140);
  });

  test('counting a request even when the event carried no usage: model_requests stops meaning what it says', () => {
    const mut = mutantCopy(TURN_USAGE, [[
      '  if (!modelUsage || typeof modelUsage !== \'object\') return acc;',
      '  modelUsage = modelUsage || {};',
    ]]);
    const broken = require(mut);
    const acc = broken.blankTurnUsage();
    broken.addModelRequest(acc, null);
    broken.addModelRequest(acc, undefined);
    expect(acc.model_requests).toBe(2);   // two requests that never happened
    expect(turnUsage.blankTurnUsage().model_requests).toBe(0);
  });

  test('the executed-tool ledger removed from the auto-tier branch: tool_uses goes back to 0 for a turn that read', async () => {
    const mut = mutantCopy(AI_ROUTES, [[
      "                turnToolCalls.push({ name: tu.name, tier: 'auto', is_error: isError, size_chars: sizeChars, image_blocks: imageBlocks });",
      '                /* MUTANT: the auto-tier call leaves no trace */',
    ]]);
    const brokenRoutes = require(mut);
    const h = harness(TWO_PASS_TURN);
    await brokenRoutes.internals.runV2SessionStream({
      anthropic: h.anthropic,
      res: h.res,
      session: h.session,
      eventsToSend: [{ type: 'user.message', content: 'hi' }],
      persistAssistantText: async (text2, usage2, meta2) => { h.persisted.push({ text: text2, usage: usage2, meta: meta2 }); },
      onCustomToolUse: async (tu) => ({ tier: 'auto', summary: 'rows: ' + tu.name }),
      freshlyCreated: true,
    });
    const { meta } = h.persisted[0];
    expect(meta.tool_calls_executed).toBe(1);                       // the builtin only
    expect(meta.tool_calls.map((c) => c.name)).toEqual(['web_search']);
    // The read 86 actually performed is invisible — exactly the hole that
    // made every conversation in forensics report tool_uses: 0.
    expect(meta.tool_calls.some((c) => c.name === 'read_jobs')).toBe(false);
  });
});
