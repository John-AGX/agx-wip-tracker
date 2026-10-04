'use strict';

// WHY THIS FILE EXISTS
//
// The idle watchdog ended the turn for the USER and for nobody else. It wrote
// the error frame, persisted the failure, and `res.end()`ed — and left the
// upstream iterator generating with no consumer. On Managed Agents that is not
// a leak that ends when the socket does: everything the abandoned turn produces
// is accreted into the session's IMMUTABLE server-side history, which every
// later turn in that thread re-reads as cache_read. So the one failure path that
// fires on a wedged turn was unbounded in exactly the dimension the rest of this
// file spends its effort bounding. Three `stream.controller.abort()` calls
// already existed elsewhere in the driver; the watchdog was the path that
// skipped it.
//
// It also held the user hostage. The turn lock releases at the
// runV2SessionStream CALL SITE — when the function RETURNS — so a user told
// "ended after 5 minutes with no output" was then refused with "I'm still
// finishing your previous message" until ACTIVE_TURN_TTL_MS (6 min) expired.
// Cutting the stream makes the loop end, which returns, which releases. That is
// why `resolves` is asserted here and not merely `abort was called`.
//
// The fix had to be a HOLDER rather than a direct reference, and that is what
// most of these tests are really pinning. openStreamAndSend's own `stream` is
// scoped inside that helper, ~420 lines below the timer, and the watchdog runs
// in a synchronous setInterval callback: this file has twice put Railway into a
// deploy-restart loop by reaching a later binding from an earlier position, and
// an uncaught throw in a timer takes the process down. So the holder is declared
// beside the other turn state, above the heartbeat, and is re-pointed on EVERY
// successful open — which is what the reopen test exists to prove, because a
// holder assigned once would abort a stream that had already finished and leave
// the live one running.

// server/auth.js refuses a secret under 32 chars, so this matches the padded
// literal the rest of the suite uses rather than inventing a shorter one.
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

const AI_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js');
const aiRoutes = require('../server/routes/ai-routes');

// Mirrors the driver's own constant (ai-routes.js, inside runV2SessionStream).
// Deliberately re-stated rather than exported: a test that imported it would
// still pass if the constant were set to a week.
const TURN_IDLE_MS = 5 * 60 * 1000;
const PAST_IDLE = TURN_IDLE_MS + 30 * 1000;

// ── stream opens ──────────────────────────────────────────────────────────
// A wedged open never yields. Its controller.abort() REJECTS the gate, which
// is what the real SDK does, so this also proves the driver survives an
// AbortError arriving inside `for await` after it has already ended the turn.
function wedgedOpen() {
  let fail;
  const gate = new Promise((_resolve, reject) => { fail = reject; });
  const abort = jest.fn(() => {
    fail(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
  });
  return {
    abort,
    open: {
      controller: { abort },
      [Symbol.asyncIterator]: async function* () { await gate; },
    },
  };
}

// An open that yields its list and completes, like any healthy pass.
function listOpen(events) {
  const abort = jest.fn();
  return {
    abort,
    open: {
      controller: { abort },
      [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
    },
  };
}

const span = (i, o, cc, cr) => ({
  type: 'span.model_request_end',
  model_usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr },
});
const text = (t) => ({ type: 'agent.message', content: [{ type: 'text', text: t }] });
const customTool = (id, name) => ({ type: 'agent.custom_tool_use', id, tool_name: name, input: {} });
const idleBlocked = (ids) => ({ type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ids } });
const idleDone = () => ({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } });

function harness(opens, routes) {
  const mod = routes || aiRoutes;
  const written = [];
  let openCount = 0;
  const anthropic = {
    beta: {
      sessions: {
        events: {
          stream: async () => opens[openCount++],
          send: async () => ({}),
        },
      },
      files: { list: () => ({ [Symbol.asyncIterator]: async function* () { /* none */ } }) },
    },
  };
  const res = {
    writableEnded: false,
    setHeader: () => {}, flushHeaders: () => {},
    on: () => {}, once: () => {}, removeListener: () => {},
    write: (chunk) => { written.push(String(chunk)); return true; },
    end: () => { res.writableEnded = true; },
  };
  return {
    written, res,
    opens: () => openCount,
    run: () => mod.internals.runV2SessionStream({
      anthropic,
      res,
      session: {
        id: 1, anthropic_session_id: 'ses_test',
        entity_type: 'job', entity_id: 'j1',
        session_kind: 'user_thread', agent_key: 'job',
      },
      eventsToSend: [{ type: 'user.message', content: 'hi' }],
      persistAssistantText: async () => {},
      onCustomToolUse: async (tu) => ({ tier: 'auto', summary: 'rows: ' + tu.name }),
      freshlyCreated: true,
    }),
  };
}

// Drive the wedged turn to the point the watchdog fires, and return once the
// driver has actually finished. advanceTimersByTimeAsync flushes microtasks
// between timer runs, which a sync advance does not — without it the abort's
// rejection never reaches the `for await`.
async function runPastIdle(h) {
  const settled = h.run();
  await jest.advanceTimersByTimeAsync(PAST_IDLE);
  return settled;
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('the idle watchdog cuts the upstream stream', () => {
  test('aborts the live stream when the turn goes idle', async () => {
    const w = wedgedOpen();
    const h = harness([w.open]);
    await runPastIdle(h);
    expect(w.abort).toHaveBeenCalledTimes(1);
  });

  test('still explains the failure and closes the SSE stream', async () => {
    const w = wedgedOpen();
    const h = harness([w.open]);
    await runPastIdle(h);
    // The abort must be an ADDITION to the user-facing path, not a replacement
    // for it. A turn that is cut silently is the 39-dangling-turns bug again.
    const all = h.written.join('');
    expect(all).toContain('86 stopped responding');
    expect(all).toContain('[DONE]');
    expect(h.res.writableEnded).toBe(true);
  });

  test('returns, so the call site can release the user turn lock', async () => {
    const w = wedgedOpen();
    const h = harness([w.open]);
    // The assertion IS that this resolves. Before the abort, the loop had no
    // reason to end and the lock sat until ACTIVE_TURN_TTL_MS, so a user told
    // the turn was over got "I'm still finishing your previous message".
    await expect(runPastIdle(h)).resolves.toBeUndefined();
  });

  test('survives the AbortError arriving after the turn was already ended', async () => {
    const w = wedgedOpen();
    const h = harness([w.open]);
    await expect(runPastIdle(h)).resolves.toBeUndefined();
    // One error frame, from the watchdog — not a second one from the rejection
    // landing inside the loop after _ended was set.
    const frames = h.written.filter(c => c.indexOf('"error"') !== -1);
    expect(frames).toHaveLength(1);
  });

  test('on a reopened turn it aborts the CURRENT open, not the first', async () => {
    // Pass one reads a tool and blocks, which makes the driver reopen. Pass two
    // wedges. A holder assigned once would hold the finished stream and abort
    // nothing that matters.
    const first = listOpen([
      span(10, 5, 67100, 0), customTool('sevt_1', 'read_jobs'),
      span(20, 7, 0, 67110), idleBlocked(['sevt_1']),
    ]);
    const second = wedgedOpen();
    const h = harness([first.open, second.open]);
    await runPastIdle(h);
    expect(h.opens()).toBe(2);
    expect(second.abort).toHaveBeenCalledTimes(1);
    expect(first.abort).not.toHaveBeenCalled();
  });

  test('a turn that finishes normally is never aborted', async () => {
    const only = listOpen([span(10, 5, 1000, 0), text('Three jobs are over budget.'), idleDone()]);
    const h = harness([only.open]);
    const settled = h.run();
    await jest.advanceTimersByTimeAsync(PAST_IDLE);
    await settled;
    expect(only.abort).not.toHaveBeenCalled();
  });
});

// ── mutants ───────────────────────────────────────────────────────────────
// A fix that cannot be shown to fail when removed proves nothing. The mutant is
// a copy of ai-routes.js in a temp dir with its relative requires rewritten to
// absolute, so it loads the real neighbours rather than a second copy of them.
let mutantPaths = [];
afterEach(() => {
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

function mutantCopy(pairs) {
  let out = fs.readFileSync(AI_ROUTES, 'utf8').replace(/\r\n/g, '\n');
  const src = out;
  for (const [find, replace] of pairs) {
    const n = out.split(find).length - 1;
    if (n !== 1) throw new Error('anchor matched ' + n + ' times: ' + find.slice(0, 60));
    out = out.split(find).join(replace);
  }
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  const dir = path.dirname(AI_ROUTES);
  // BOTH forms have to be rewritten, not just the relative ones: the mutant
  // lives in os.tmpdir(), which has no node_modules above it, so a bare
  // `require('express')` left alone fails to resolve and the mutant never
  // loads — which reads exactly like a mutation that was caught.
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (m, _q, spec) => {
    try {
      const resolved = spec.charAt(0) === '.'
        ? require.resolve(path.resolve(dir, spec))
        : require.resolve(spec, { paths: [dir] });
      return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
    } catch (e) { return m; }
  });
  // The name must be unique PER CALL, not per test. mutantPaths resets in
  // afterEach, so an index-based name gave both mutants the same path — and
  // jest's module registry is separate from require.cache, so the second
  // require returned the FIRST mutant and that test silently graded the wrong
  // code. It read as a mutation that survived.
  const file = path.join(os.tmpdir(),
    'mutant-watchdog-' + process.pid + '-' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(file, out);
  mutantPaths.push(file);
  return require(file);
}

describe('mutants', () => {
  test('without the abort, the watchdog leaves the stream running', async () => {
    const broken = mutantCopy([[
      'const aborted = _activeStream.controller.abort();',
      'const aborted = null;',
    ]]);
    const w = wedgedOpen();
    const h = harness([w.open], broken);
    h.run();
    await jest.advanceTimersByTimeAsync(PAST_IDLE);
    // This is the bug, reproduced: the user has been told the turn ended...
    expect(h.res.writableEnded).toBe(true);
    // ...and the upstream was never cut, so it is still generating.
    expect(w.abort).not.toHaveBeenCalled();
  });

  test('a holder assigned once aborts the wrong stream on a reopen', async () => {
    // Pin the holder to the first open only — the shape the fix would have had
    // if the assignment sat outside openStreamAndSend.
    const broken = mutantCopy([[
      '      _activeStream = stream;',
      '      if (!_activeStream) _activeStream = stream;',
    ]]);
    const first = listOpen([
      span(10, 5, 67100, 0), customTool('sevt_1', 'read_jobs'),
      span(20, 7, 0, 67110), idleBlocked(['sevt_1']),
    ]);
    const second = wedgedOpen();
    const h = harness([first.open, second.open], broken);
    h.run();
    await jest.advanceTimersByTimeAsync(PAST_IDLE);
    expect(h.opens()).toBe(2);
    // The finished stream gets the abort; the wedged one keeps generating.
    expect(first.abort).toHaveBeenCalledTimes(1);
    expect(second.abort).not.toHaveBeenCalled();
  });
});
