// js/service-ticket-status-move.js — window.p86MoveTicketStatus(t, to, extra)
// (shared contracts 5.3, dialog wording per the plan review's correction #5).
//
// The shipped file is evaluated with its free variable (window) injected, the
// same way test/helpers/browser-fn.js drives browser scripts: what runs here
// is what ships. The server is a stubbed p86Api.serviceTickets.setStatus.
//
//   1. The move carries expected_status = the status on screen, and whatever
//      extra the reason dialog collected passes through untouched.
//   2. 409 buildings_open asks, with the exact sentence; yes resends the same
//      move with override:true, no resolves { outcome:'cancelled' }.
//   3. 409 status_changed resolves { outcome:'stale', message } — also when it
//      comes back on the override resend.
//   4. Every other failure rejects with the server's error.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MOVE_PATH = path.join(__dirname, '..', 'js', 'service-ticket-status-move.js');
const SRC = fs.readFileSync(MOVE_PATH, 'utf8');

const STALE = 'This work order just changed. Reload to see the latest.';
const OPEN_MSG = "2 of 5 subtasks aren't done yet.";
const ASK_MSG = "2 of 5 subtasks aren't done yet. Move this work order to Work complete anyway? The approvers will be told it's ready, and the timeline will show it was moved with subtasks still open.";

function httpError(status, message, data) {
  const e = new Error(message);
  e.status = status;
  e.data = data === undefined ? { error: message } : data;
  e.retryAfter = null;
  return e;
}

// answers: one entry per setStatus call — a value resolves, an Error rejects.
function boot(src, answers, opts) {
  opts = opts || {};
  const calls = [];
  const queue = answers.slice();
  const win = {
    p86Api: {
      serviceTickets: {
        setStatus: jest.fn((id, status, body) => {
          calls.push({ id, status, body: JSON.parse(JSON.stringify(body)) });
          const next = queue.shift();
          return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        }),
      },
    },
  };
  if (opts.confirm !== undefined) win.p86Confirm = jest.fn(() => Promise.resolve(opts.confirm));
  if (opts.nativeConfirm !== undefined) win.confirm = jest.fn(() => opts.nativeConfirm);
  if (opts.confirmRejects) win.p86Confirm = jest.fn(() => Promise.reject(new Error('dialog broke')));
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win);
  return { move: win.p86MoveTicketStatus, calls, win };
}

function mutant(anchor, replacement) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-move-mutant-'));
  const copy = path.join(dir, 'service-ticket-status-move.js');
  fs.writeFileSync(copy, SRC);
  const src = fs.readFileSync(copy, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length - 1 !== 1) throw new Error('anchor not found');
  const out = src.replace(anchor, replacement);
  // eslint-disable-next-line no-new-func
  new Function('window', out);
  return out;
}

async function mustFail(check) {
  let threw = false;
  try { await check(); } catch (e) { threw = true; }
  expect(threw).toBe(true);
}

const T = { id: 'st_1', status: 'in_progress', title: 'Replace rotted stair treads' };

// ── Checks, reused by the mutants ────────────────────────────────────────
async function checkExpectedStatus(src) {
  const response = { ok: true, ticket: { id: 'st_1', status: 'approved' } };
  const { move, calls } = boot(src, [response]);
  const extra = { reason: 'Walked it with the PM', copy_scope: true };
  const out = await move(T, 'approved', extra);
  expect(calls).toEqual([{ id: 'st_1', status: 'approved', body: { reason: 'Walked it with the PM', copy_scope: true, expected_status: 'in_progress' } }]);
  expect(out).toEqual({ outcome: 'moved', response, ticket: response.ticket });
  expect(out.response).toBe(response);
  expect(extra).toEqual({ reason: 'Walked it with the PM', copy_scope: true });
}

async function checkMoveAnyway(src) {
  const moved = { ok: true, ticket: { id: 'st_1', status: 'work_complete' } };
  const { move, calls, win } = boot(src, [httpError(409, OPEN_MSG, { error: OPEN_MSG, code: 'buildings_open', open: 2, total: 5 }), moved], { confirm: true });
  const out = await move(T, 'work_complete', { reason: 'Crew confirmed by phone' });
  expect(win.p86Confirm).toHaveBeenCalledTimes(1);
  expect(win.p86Confirm.mock.calls[0][0]).toEqual({
    title: 'Subtasks still open',
    message: ASK_MSG,
    confirmText: 'Move anyway',
    confirmLabel: 'Move anyway',
    cancelText: 'Cancel',
    cancelLabel: 'Cancel',
    destructive: false,
    danger: false,
  });
  expect(calls.map((c) => c.body)).toEqual([
    { reason: 'Crew confirmed by phone', expected_status: 'in_progress' },
    { reason: 'Crew confirmed by phone', expected_status: 'in_progress', override: true },
  ]);
  expect(out).toEqual({ outcome: 'moved', response: moved, ticket: moved.ticket });
}

async function checkStale(src) {
  const { move, calls } = boot(src, [httpError(409, STALE, { error: STALE, code: 'status_changed', current_status: 'approved' })]);
  const out = await move(T, 'in_progress', {});
  expect(out).toEqual({ outcome: 'stale', message: STALE });
  expect(calls).toHaveLength(1);
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('the move request', () => {
  test('expected_status is the status on screen; extra keys pass through; success is moved', () => checkExpectedStatus(SRC));

  test('extra cannot override expected_status', async () => {
    const { move, calls } = boot(SRC, [{ ok: true, ticket: { id: 'st_1', status: 'open' } }]);
    await move(T, 'open', { expected_status: 'closed', reopen_tasks: ['tk_790'] });
    expect(calls[0].body).toEqual({ expected_status: 'in_progress', reopen_tasks: ['tk_790'] });
  });

  test('no extra at all still sends expected_status', async () => {
    const { move, calls } = boot(SRC, [{ ok: true, ticket: null }]);
    const out = await move(T, 'on_hold');
    expect(calls[0].body).toEqual({ expected_status: 'in_progress' });
    expect(out).toEqual({ outcome: 'moved', response: { ok: true, ticket: null }, ticket: null });
  });

  test('MUTANT: not sending expected_status goes red', async () => {
    const src = mutant('var body = Object.assign({}, extra, { expected_status: t.status });', 'var body = Object.assign({}, extra);');
    await mustFail(() => checkExpectedStatus(src));
  });
});

describe('409 buildings_open', () => {
  test('asks with the exact sentence; yes resends with override:true', () => checkMoveAnyway(SRC));

  test('no gives { outcome: cancelled } and nothing is resent', async () => {
    const { move, calls, win } = boot(SRC, [httpError(409, OPEN_MSG, { error: OPEN_MSG, code: 'buildings_open', open: 2, total: 5 })], { confirm: false });
    await expect(move(T, 'work_complete', {})).resolves.toEqual({ outcome: 'cancelled' });
    expect(win.p86Confirm).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  test('a dialog that fails counts as no', async () => {
    const { move, calls } = boot(SRC, [httpError(409, OPEN_MSG, { error: OPEN_MSG, code: 'buildings_open' })], { confirmRejects: true });
    await expect(move(T, 'work_complete', {})).resolves.toEqual({ outcome: 'cancelled' });
    expect(calls).toHaveLength(1);
  });

  test('without the in-app dialog it falls back to window.confirm with the same sentence', async () => {
    const moved = { ok: true, ticket: { id: 'st_1', status: 'work_complete' } };
    const { move, calls, win } = boot(SRC, [httpError(409, OPEN_MSG, { error: OPEN_MSG, code: 'buildings_open' }), moved], { nativeConfirm: true });
    const out = await move(T, 'work_complete', {});
    expect(win.confirm).toHaveBeenCalledWith(ASK_MSG);
    expect(calls[1].body).toEqual({ expected_status: 'in_progress', override: true });
    expect(out.outcome).toBe('moved');
  });

  test('the override resend coming back stale is stale, not an error', async () => {
    const { move } = boot(SRC, [
      httpError(409, OPEN_MSG, { error: OPEN_MSG, code: 'buildings_open' }),
      httpError(409, STALE, { error: STALE, code: 'status_changed', current_status: 'cancelled' }),
    ], { confirm: true });
    await expect(move(T, 'work_complete', {})).resolves.toEqual({ outcome: 'stale', message: STALE });
  });

  test('any other failure on the resend rejects', async () => {
    const boom = httpError(500, 'Server error');
    const { move } = boot(SRC, [httpError(409, OPEN_MSG, { error: OPEN_MSG, code: 'buildings_open' }), boom], { confirm: true });
    await expect(move(T, 'work_complete', {})).rejects.toBe(boom);
  });

  test('MUTANT: yes resending without override goes red', async () => {
    const src = mutant('Object.assign({}, body, { override: true })', 'Object.assign({}, body)');
    await mustFail(() => checkMoveAnyway(src));
  });

  test('the dialog call passes the live spelling (confirmText / cancelText), so the destructive-dialog census stays as it is', () => {
    // Same walk as test/destructive-dialogs-look-destructive.test.js D4: read
    // the option object each call site writes.
    const src = SRC.replace(/\r\n/g, '\n');
    const sites = [];
    let i = 0;
    while ((i = src.indexOf('p86Confirm(', i)) !== -1) {
      let d = 0; let end = -1;
      for (let j = i + 10; j < src.length; j++) {
        if (src[j] === '(') d++;
        else if (src[j] === ')') { d--; if (d === 0) { end = j; break; } }
      }
      sites.push(src.slice(i + 10, end + 1));
      i = end;
    }
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatch(/\bconfirmText\s*:/);
    expect(sites[0]).toMatch(/\bcancelText\s*:/);
    expect(sites[0]).toMatch(/\bdestructive\s*:/);
  });
});

describe('409 status_changed and other failures', () => {
  test('status_changed resolves stale with the exact message', () => checkStale(SRC));

  test('a stale refusal with no message still gets the shared wording', async () => {
    const e = httpError(409, '', { code: 'status_changed' });
    const { move } = boot(SRC, [e]);
    await expect(move(T, 'approved', {})).resolves.toEqual({ outcome: 'stale', message: STALE });
  });

  test('MUTANT: not recognising status_changed goes red', async () => {
    const src = mutant("codeOf(err) === 'status_changed'", "codeOf(err) === 'never'");
    await mustFail(() => checkStale(src));
  });

  test.each([
    ['a lattice refusal (403)', httpError(403, 'A ticket cannot move from approved to in_progress.')],
    ['a required reason (400)', httpError(400, 'Say why this work order is being cancelled.')],
    ['another 409 code', httpError(409, 'This work order is closed.', { error: 'This work order is closed.', code: 'terminal' })],
    ['a 409 with no data', httpError(409, 'Conflict', null)],
    ['a network failure', new TypeError('Failed to fetch')],
  ])('%s rejects with the same error and never asks', async (name, err) => {
    const { move, calls, win } = boot(SRC, [err], { confirm: true });
    await expect(move(T, 'cancelled', {})).rejects.toBe(err);
    expect(win.p86Confirm).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  test('no API loaded rejects instead of throwing', async () => {
    const win = {};
    // eslint-disable-next-line no-new-func
    new Function('window', SRC)(win);
    await expect(win.p86MoveTicketStatus(T, 'approved', {})).rejects.toThrow('Reload the page to change the status.');
  });
});
