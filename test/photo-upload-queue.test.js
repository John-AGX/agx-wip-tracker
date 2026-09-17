// js/photo-upload-queue.js — the photo upload queue core (window.p86PhotoQueue,
// shared contracts 5.5; crew-signal spec section 1).
//
// What runs here is the shipped block between '/* photo-queue core: begin */'
// and '/* photo-queue core: end */', evaluated with the browser globals it may
// touch injected (window, document, navigator, URL, Image, ...) and jest's
// fake clock. That block is also what service-ticket-share.html will carry a
// copy of; parity between the two copies is tested with the crew page (W3-F),
// not here.
//
//   (2) a refused photo never stops the photos behind it          + MUTANT
//   (3) network failures retry at +3 s and +15 s with the same id,
//       then fail; retry() resends with the same id                + MUTANTS
//   (4) 429 pauses the whole queue for Retry-After, attempt kept   + MUTANTS
//   (5) a send that never answers is aborted at its timeout and retried
//   (6) 403/409/410 refuse every photo still waiting
//   (7) add() skips a photo already queued for that target
//   (8) offline pauses until 'online'
//   (9) prepareImage: pass-through, HEIC refusal, the shrink with EXIF kept
//   (10) spliceExif on synthetic JPEGs (II and MM)
//   (11) uploadIdFor is FNV-1a over target|name|size|lastModified|type
//   plus the wording of statusText, the ES5 rule and the module shape.

const fs = require('fs');
const os = require('os');
const path = require('path');
const parser = require('@babel/parser');

const QUEUE_PATH = path.join(__dirname, '..', 'js', 'photo-upload-queue.js');
const SRC = fs.readFileSync(QUEUE_PATH, 'utf8');
const BEGIN = '/* photo-queue core: begin */';
const END = '/* photo-queue core: end */';
const MB = 1024 * 1024;

const HEIC_TEXT = "This photo is in HEIC format (High efficiency), which can't be opened here yet. Use Take photo, or set your camera to save photos as JPEG, then add it again.";
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function coreBlock(src) {
  const s = src.replace(/\r\n/g, '\n');
  const a = s.indexOf(BEGIN);
  const b = s.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error('core markers not found');
  if (s.indexOf(BEGIN, a + 1) !== -1 || s.indexOf(END, b + 1) !== -1) throw new Error('core markers appear twice');
  return s.slice(a + BEGIN.length, b);
}

const ENV_NAMES = ['window', 'document', 'navigator', 'URL', 'Image', 'AbortController', 'Blob', 'File', 'FileReader'];

function fakeTarget(extra) {
  const listeners = {};
  return Object.assign({
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((fn) => fn({ type })); },
  }, extra || {});
}

// Every test gets a fresh core, so the lazily cached canDecode never leaks.
function loadCore(env, src) {
  env = Object.assign({
    window: fakeTarget(),
    document: undefined,
    navigator: { onLine: true },
    URL: {},
    Image: undefined,
  }, env || {});
  // eslint-disable-next-line no-new-func
  const factory = new Function(...ENV_NAMES, '"use strict";\n' + coreBlock(src || SRC) + '\nreturn photoQueueCore();');
  return factory(...ENV_NAMES.map((n) => (Object.prototype.hasOwnProperty.call(env, n) ? env[n] : globalThis[n])));
}

function mutantSrc(anchor, replacement) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-queue-mutant-'));
  const copy = path.join(dir, 'photo-upload-queue.js');
  fs.writeFileSync(copy, SRC);
  const src = fs.readFileSync(copy, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length - 1 !== 1) throw new Error('anchor not found');
  const out = src.replace(anchor, replacement);
  loadCore({}, out); // still parses and boots
  return out;
}

async function mustFail(check) {
  let threw = false;
  try { await check(); } catch (e) { threw = true; }
  expect(threw).toBe(true);
}

async function flush(n) {
  for (let i = 0; i < (n || 400); i++) await Promise.resolve();
}

function photo(name, size, extra) {
  const opts = Object.assign({ type: 'image/jpeg', lastModified: 1757950000000 }, extra || {});
  return new File([new Uint8Array(size == null ? 10 : size)], name, opts);
}

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.data = { error: message };
  e.retryAfter = null;
  return Object.assign(e, extra || {});
}

// script(call) -> a value (resolves), an Error (rejects), or a Promise.
function sender(script) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const send = jest.fn((item, signal) => {
    const call = { name: item.name, uploadId: item.uploadId, key: item.key, blob: item.blob, signal, at: Date.now(), n: calls.length };
    calls.push(call);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let out = script ? script(call, item) : { ok: true, photo: { id: 'ph_' + calls.length } };
    if (out instanceof Error) out = Promise.reject(out);
    return Promise.resolve(out).then((v) => { inFlight--; return v; }, (e) => { inFlight--; throw e; });
  });
  return { send, calls, maxInFlight: () => maxInFlight };
}

const A = 'task:tk_784:completion';
const B = 'task:tk_790:before';

beforeEach(() => { jest.useFakeTimers({ now: new Date('2026-09-15T14:00:00Z') }); });
afterEach(() => { jest.useRealTimers(); });

// ── (2) a refusal never stops the rest ───────────────────────────────────
async function checkRefusalContinues(src) {
  const core = loadCore({}, src);
  const s = sender((call) => (call.name === 'f4.jpg' ? httpError(400, 'File contents do not match its type') : { ok: true }));
  const onIdle = jest.fn();
  const onChange = jest.fn();
  const q = core.createQueue({ send: s.send, onChange, onIdle });
  const files = [1, 2, 3, 4, 5, 6].map((i) => photo('f' + i + '.jpg', 100 + i));
  expect(q.add(files, { key: A, taskId: 'tk_784', kind: 'completion' })).toEqual({ added: 6, skipped: 0 });
  await flush();
  expect(s.calls.map((c) => c.name)).toEqual(['f1.jpg', 'f2.jpg', 'f3.jpg', 'f4.jpg', 'f5.jpg', 'f6.jpg']);
  const sum = q.summary(A);
  expect(sum).toMatchObject({ total: 6, done: 5, refused: 1, failed: 0, active: 0, waiting: 0 });
  expect(sum.refusals).toEqual([{ name: 'f4.jpg', message: 'File contents do not match its type' }]);
  expect(core.statusText(sum)).toBe("5 of 6 added. 1 didn't go through.\nf4.jpg wasn't sent: File contents do not match its type");
  expect(q.busy()).toBe(false);
  expect(q.unsettled()).toBe(false);
  expect(onIdle).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls.every((c) => c[1] === onIdle.mock.calls[0][0])).toBe(true);
}

describe('(2) one upload at a time, and a refusal never stops the rest', () => {
  test('six photos, the fourth refused with 400: five land, the refusal names the fourth', () => checkRefusalContinues(SRC));

  test('MUTANT: not restarting the pump after a refusal goes red', async () => {
    const src = mutantSrc('        touch(refusedNow);\n        kick();\n', '        touch(refusedNow);\n');
    await mustFail(() => checkRefusalContinues(src));
  });

  test('strictly one send in flight, across targets', async () => {
    const core = loadCore();
    const gates = [];
    const s = sender(() => new Promise((resolve) => gates.push(resolve)));
    const q = core.createQueue({ send: s.send });
    q.add([photo('a1.jpg'), photo('a2.jpg')], A);
    q.add([photo('b1.jpg')], B);
    await flush();
    expect(s.calls.map((c) => c.name)).toEqual(['a1.jpg']);
    expect(core.statusText(q.summary(A))).toBe('Uploading 1 of 2…');
    gates.shift()({ ok: true });
    await flush();
    expect(s.calls.map((c) => c.name)).toEqual(['a1.jpg', 'a2.jpg']);
    expect(core.statusText(q.summary(A))).toBe('Uploading 2 of 2…');
    gates.shift()({ ok: true });
    await flush();
    gates.shift()({ ok: true, photo: { id: 'ph_b1' } });
    await flush();
    expect(s.calls.map((c) => c.name)).toEqual(['a1.jpg', 'a2.jpg', 'b1.jpg']);
    expect(s.maxInFlight()).toBe(1);
    expect(q.items(B)[0]).toMatchObject({ state: 'done', result: { ok: true, photo: { id: 'ph_b1' } }, target: { key: B } });
    expect(core.statusText(q.summary(A))).toBe('2 photos added.');
    expect(core.statusText(q.summary(B))).toBe('Photo added.');
  });

  test('the send gets the item (uploadId, target, blob) and an AbortSignal', async () => {
    const core = loadCore();
    const s = sender();
    const q = core.createQueue({ send: s.send });
    const f = photo('IMG_2231.jpg', 500);
    q.add([f], { key: A, taskId: 'tk_784', kind: 'completion' });
    await flush();
    expect(s.send).toHaveBeenCalledTimes(1);
    const [item, signal] = s.send.mock.calls[0];
    expect(item.uploadId).toBe(core.uploadIdFor(f, A));
    expect(item.target).toEqual({ key: A, taskId: 'tk_784', kind: 'completion' });
    expect(item.blob).toBe(f);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });
});

// ── (3) retry with the same id ───────────────────────────────────────────
async function checkBackoffSameId(src) {
  const core = loadCore({}, src);
  let f2Heals = false;
  const s = sender((call) => (call.name === 'f2.jpg' && !f2Heals ? new TypeError('Failed to fetch') : { ok: true }));
  const q = core.createQueue({ send: s.send });
  const f2 = photo('f2.jpg', 222);
  const t0 = Date.now();
  q.add([photo('f1.jpg', 111), f2, photo('f3.jpg', 333)], A);
  await flush();
  const f2Calls = () => s.calls.filter((c) => c.name === 'f2.jpg');
  expect(s.calls.map((c) => c.name)).toEqual(['f1.jpg', 'f2.jpg', 'f3.jpg']);
  expect(core.statusText(q.summary(A))).toBe('Uploading 2 of 3… 1 will retry');
  await jest.advanceTimersByTimeAsync(2999);
  expect(f2Calls()).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);
  await flush();
  expect(f2Calls()).toHaveLength(2);
  await jest.advanceTimersByTimeAsync(14999);
  expect(f2Calls()).toHaveLength(2);
  await jest.advanceTimersByTimeAsync(1);
  await flush();
  expect(f2Calls().map((c) => c.at - t0)).toEqual([0, 3000, 18000]);
  const id = core.uploadIdFor(f2, A);
  expect(f2Calls().map((c) => c.uploadId)).toEqual([id, id, id]);
  expect(q.items(A)[1]).toMatchObject({ state: 'failed', attempts: 3, error: 'Failed to fetch' });
  expect(core.statusText(q.summary(A))).toBe("2 of 3 added. 1 didn't go through.");
  expect(q.busy()).toBe(false);
  expect(q.unsettled()).toBe(true);
  return { core, q, s, f2Calls, id, heal: () => { f2Heals = true; } };
}

async function checkRetrySameId(src) {
  const r = await checkBackoffSameId(src);
  r.heal();
  expect(r.q.retry(A)).toBe(1);
  await flush();
  expect(r.f2Calls()).toHaveLength(4);
  expect(r.f2Calls()[3].uploadId).toBe(r.id);
  expect(r.q.items(A)[1]).toMatchObject({ state: 'done', uploadId: r.id, attempts: 1 });
  expect(r.q.unsettled()).toBe(false);
  expect(r.core.statusText(r.q.summary(A))).toBe('3 photos added.');
}

describe('(3) network failures retry with the same upload id', () => {
  test('a TypeError retries at +3 s and +15 s with the same id, then fails', () => checkBackoffSameId(SRC));

  test('retry() resends the failed photo with the same id', () => checkRetrySameId(SRC));

  test('MUTANT: regenerating the id in retry() goes red', async () => {
    const src = mutantSrc('          it.attempts = 0;\n', "          it.attempts = 0;\n          it.uploadId = 'u' + String(Math.random()).slice(2, 14);\n");
    await mustFail(() => checkRetrySameId(src));
  });

  test('MUTANT: regenerating the id on the automatic backoff goes red', async () => {
    const src = mutantSrc(
      '            item.retryAt = now + BACKOFF_MS[item.attempts - 1];\n',
      "            item.retryAt = now + BACKOFF_MS[item.attempts - 1];\n            item.uploadId = 'u' + String(Math.random()).slice(2, 14);\n");
    await mustFail(() => checkBackoffSameId(src));
  });

  test.each([
    ['AbortError', Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })],
    ['408', httpError(408, 'The upload was cut off before it finished. Try again.')],
    ['500', httpError(500, 'Something went wrong uploading that.')],
    ['502', httpError(502, 'Bad gateway')],
    ['503 without Retry-After', httpError(503, 'Unavailable')],
    ['504', httpError(504, 'Gateway timeout')],
    ['an error with no status', new Error('socket hang up')],
  ])('%s is retryable', async (name, err) => {
    const core = loadCore();
    let first = true;
    const s = sender(() => { if (first) { first = false; return err; } return { ok: true }; });
    const q = core.createQueue({ send: s.send });
    q.add([photo('x.jpg')], A);
    await flush();
    expect(q.items(A)[0]).toMatchObject({ state: 'waiting', attempts: 1 });
    await jest.advanceTimersByTimeAsync(3000);
    await flush();
    expect(s.calls).toHaveLength(2);
    expect(q.items(A)[0].state).toBe('done');
  });

  test('visibilitychange to visible retries failed photos once', async () => {
    const document = fakeTarget({ visibilityState: 'hidden' });
    const core = loadCore({ document });
    let fail = true;
    const s = sender(() => (fail ? new TypeError('Failed to fetch') : { ok: true }));
    const q = core.createQueue({ send: s.send });
    q.add([photo('v.jpg')], A);
    await flush();
    await jest.advanceTimersByTimeAsync(20000);
    await flush();
    expect(q.items(A)[0].state).toBe('failed');
    fail = false;
    document.fire('visibilitychange');
    await flush();
    expect(s.calls).toHaveLength(3);
    document.visibilityState = 'visible';
    document.fire('visibilitychange');
    await flush();
    expect(s.calls).toHaveLength(4);
    expect(q.items(A)[0].state).toBe('done');
  });
});

// ── (4) 429 pauses everything ────────────────────────────────────────────
async function checkPause(src, retryAfter) {
  const core = loadCore({}, src);
  let first = true;
  const s = sender(() => {
    if (first) { first = false; return httpError(429, 'Too many uploads. Wait a moment.', { retryAfter }); }
    return { ok: true };
  });
  const q = core.createQueue({ send: s.send });
  const t0 = Date.now();
  q.add([photo('p1.jpg'), photo('p2.jpg')], A);
  q.add([photo('p3.jpg')], B);
  await flush();
  expect(s.calls).toHaveLength(1);
  expect(q.items(A)[0]).toMatchObject({ state: 'waiting', attempts: 0 });
  expect(q.summary(B).pausedUntil).toBe(t0 + retryAfter * 1000);
  expect(core.statusText(q.summary(A))).toBe('The server is busy. Trying again in ' + retryAfter + ' s…');
  expect(core.statusText(q.summary(B))).toBe('The server is busy. Trying again in ' + retryAfter + ' s…');
  await jest.advanceTimersByTimeAsync(3000);
  await flush();
  expect(s.calls).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(retryAfter * 1000 - 3001);
  await flush();
  expect(s.calls).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);
  await flush();
  expect(s.calls.map((c) => [c.name, c.at - t0])).toEqual([
    ['p1.jpg', 0], ['p1.jpg', retryAfter * 1000], ['p2.jpg', retryAfter * 1000], ['p3.jpg', retryAfter * 1000],
  ]);
  expect(q.items(A)[0]).toMatchObject({ state: 'done', attempts: 1 });
  expect(q.summary(A).pausedUntil).toBe(0);
}

describe('(4) 429 pauses the whole queue for Retry-After, without using an attempt', () => {
  test('retryAfter 30: every target waits 30 s', () => checkPause(SRC, 30));

  test('retryAfter 7: the server value is used, not the default', () => checkPause(SRC, 7));

  test('MUTANT: treating 429 like any other refusal goes red', async () => {
    const src = mutantSrc('if (status === 429 || (status === 503 && retryAfterOf(err) != null)) {', 'if (false) {');
    await mustFail(() => checkPause(src, 30));
  });

  test('MUTANT: ignoring retryAfter (always the default) goes red', async () => {
    const src = mutantSrc('var s = Number(retryAfterOf(err));', 'var s = Number(null);');
    await mustFail(() => checkPause(src, 7));
  });

  test.each([
    ['no hint -> 30 s', httpError(429, 'Slow down'), 30000],
    ['a body retryAfter -> that', httpError(429, 'Slow down', { retryAfter: null, data: { retryAfter: 12 } }), 12000],
    ['too long -> 300 s', httpError(429, 'Slow down', { retryAfter: 900 }), 300000],
    ['too short -> 1 s', httpError(429, 'Slow down', { retryAfter: 0.2 }), 1000],
    ['503 with Retry-After pauses too', httpError(503, 'Busy', { retryAfter: 5 }), 5000],
  ])('%s', async (name, err, ms) => {
    const core = loadCore();
    let first = true;
    const s = sender(() => { if (first) { first = false; return err; } return { ok: true }; });
    const q = core.createQueue({ send: s.send });
    const t0 = Date.now();
    q.add([photo('z.jpg')], A);
    await flush();
    expect(q.summary(A).pausedUntil).toBe(t0 + ms);
    expect(q.items(A)[0].attempts).toBe(0);
    await jest.advanceTimersByTimeAsync(ms);
    await flush();
    expect(s.calls.map((c) => c.at - t0)).toEqual([0, ms]);
  });
});

// ── (5) timeouts ─────────────────────────────────────────────────────────
describe('(5) every attempt has a timeout', () => {
  test('a send that never answers is aborted at 45 s + 30 s per started MB, then retried', async () => {
    const core = loadCore();
    const s = sender((call) => (call.n === 0 ? new Promise(() => {}) : { ok: true }));
    const q = core.createQueue({ send: s.send });
    const t0 = Date.now();
    q.add([photo('slow.jpg', 10)], A);
    await flush();
    const signal = s.calls[0].signal;
    await jest.advanceTimersByTimeAsync(74999);
    expect(signal.aborted).toBe(false);
    expect(q.items(A)[0].state).toBe('uploading');
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(signal.aborted).toBe(true);
    expect(q.items(A)[0]).toMatchObject({ state: 'waiting', attempts: 1, retryAt: t0 + 75000 + 3000, error: 'The upload timed out.' });
    await jest.advanceTimersByTimeAsync(3000);
    await flush();
    expect(s.calls.map((c) => c.at - t0)).toEqual([0, 78000]);
    expect(q.items(A)[0]).toMatchObject({ state: 'done', uploadId: s.calls[0].uploadId });
  });

  test.each([
    [MB + 1, 105000],
    [3 * MB, 135000],
    [20 * MB, 240000],
  ])('a %i byte photo times out after %i ms', async (size, ms) => {
    const core = loadCore();
    const s = sender(() => new Promise(() => {}));
    const q = core.createQueue({ send: s.send });
    q.add([photo('big.jpg', size)], A);
    await flush();
    await jest.advanceTimersByTimeAsync(ms - 1);
    expect(s.calls[0].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(s.calls[0].signal.aborted).toBe(true);
  });

  test('a late answer after the timeout does not overwrite the retry', async () => {
    const core = loadCore();
    let late;
    const s = sender((call) => (call.n === 0 ? new Promise((resolve) => { late = resolve; }) : new Promise(() => {})));
    const q = core.createQueue({ send: s.send });
    q.add([photo('late.jpg')], A);
    await flush();
    await jest.advanceTimersByTimeAsync(75000);
    await flush();
    late({ ok: true });
    await flush();
    expect(q.items(A)[0]).toMatchObject({ state: 'waiting', result: null });
  });
});

// ── (6) closed to writes ─────────────────────────────────────────────────
describe('(6) 403 / 409 / 410 refuse every photo still waiting', () => {
  test.each([
    [409, 'This work order is approved. Reopen it before changing its punch list.'],
    [403, 'This link is view-only.'],
    [410, 'This link has been turned off.'],
  ])('%i refuses the rest with the same message', async (status, message) => {
    const core = loadCore();
    const s = sender(() => httpError(status, message));
    const onIdle = jest.fn();
    const q = core.createQueue({ send: s.send, onIdle });
    q.add([photo('r1.jpg'), photo('r2.jpg'), photo('r3.jpg')], A);
    q.add([photo('r4.jpg')], B);
    await flush();
    expect(s.calls).toHaveLength(1);
    expect(q.items().map((i) => [i.name, i.state, i.error])).toEqual([
      ['r1.jpg', 'refused', message], ['r2.jpg', 'refused', message], ['r3.jpg', 'refused', message], ['r4.jpg', 'refused', message],
    ]);
    expect(core.statusText(q.summary(A))).toBe(
      "0 of 3 added. 3 didn't go through.\nr1.jpg wasn't sent: " + message + "\nr2.jpg wasn't sent: " + message);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  test('400 / 404 / 413 / 415 refuse only that photo', async () => {
    const core = loadCore();
    const answers = [
      httpError(400, 'Only photos can be uploaded here'),
      httpError(404, 'That subtask is not on this work order.'),
      httpError(413, "That photo is over 50 MB and can't be sent. Take it again, or pick a smaller photo."),
      httpError(415, HEIC_TEXT),
      { ok: true },
    ];
    const s = sender((call) => answers[call.n]);
    const q = core.createQueue({ send: s.send });
    q.add([1, 2, 3, 4, 5].map((i) => photo('s' + i + '.jpg')), A);
    await flush();
    expect(q.items(A).map((i) => i.state)).toEqual(['refused', 'refused', 'refused', 'refused', 'done']);
    expect(q.summary(A).refusals).toHaveLength(4);
  });

  test('422 on a shrunk photo retries once with the original; a second 422 refuses', async () => {
    const shrunkBlob = new File([new Uint8Array(5)], 'big.jpg', { type: 'image/jpeg' });
    const core = loadCore();
    const s = sender(() => httpError(422, "That photo couldn't be read. Take it again, or pick a different photo."));
    const q = core.createQueue({
      send: s.send,
      prepare: () => Promise.resolve({ blob: shrunkBlob, name: 'big.jpg', type: 'image/jpeg', shrunk: true }),
    });
    const original = photo('big.HEIC.jpg', 50);
    q.add([original], A);
    await flush();
    expect(s.calls.map((c) => c.blob)).toEqual([shrunkBlob, original]);
    expect(s.calls[0].uploadId).toBe(s.calls[1].uploadId);
    expect(q.items(A)[0]).toMatchObject({ state: 'refused', shrunk: false, attempts: 1 });
  });
});

// ── (7) duplicates ───────────────────────────────────────────────────────
describe('(7) add() skips a photo already queued for that target', () => {
  test('the same File twice for one target is skipped; for another target it is not', async () => {
    const core = loadCore();
    const gates = [];
    const s = sender(() => new Promise((resolve) => gates.push(resolve)));
    const q = core.createQueue({ send: s.send });
    const f = photo('IMG_2231.jpg', 900);
    expect(q.add([f], A)).toEqual({ added: 1, skipped: 0 });
    expect(q.add([f], A)).toEqual({ added: 0, skipped: 1 });
    expect(q.add([f, photo('IMG_2232.jpg', 901), f], B)).toEqual({ added: 2, skipped: 1 });
    expect(q.summary(A)).toMatchObject({ total: 1, skipped: 1 });
    expect(core.statusText(q.summary(A))).toBe('Uploading 1 of 1…\nSkipped 1 photo already added.');
    await flush();
    gates.shift()({ ok: true });
    await flush();
    expect(q.add([f, photo('IMG_2231.jpg', 900, { lastModified: 1757950000000 })], A)).toEqual({ added: 0, skipped: 2 });
    expect(core.statusText(q.summary(A))).toBe('Photo added.\nSkipped 2 photos already added.');
  });

  test('a refused photo does not block adding it again', async () => {
    const core = loadCore();
    let refuse = true;
    const s = sender(() => (refuse ? httpError(400, 'No file') : { ok: true }));
    const q = core.createQueue({ send: s.send });
    const f = photo('again.jpg');
    q.add([f], A);
    await flush();
    refuse = false;
    expect(q.add([f], A)).toEqual({ added: 1, skipped: 0 });
    await flush();
    expect(q.items(A).map((i) => i.state)).toEqual(['done']);
  });

  test('a new batch for a settled target starts its counts again', async () => {
    const core = loadCore();
    const s = sender();
    const q = core.createQueue({ send: s.send });
    q.add([photo('b1.jpg'), photo('b2.jpg')], A);
    await flush();
    expect(core.statusText(q.summary(A))).toBe('2 photos added.');
    q.add([photo('b3.jpg')], A);
    expect(q.summary(A).total).toBe(1);
    await flush();
    expect(core.statusText(q.summary(A))).toBe('Photo added.');
  });

  test('a target with a failed photo keeps its batch until Retry or Clear', async () => {
    const core = loadCore();
    let down = true;
    const s = sender((call) => (call.name === 'k1.jpg' && down ? new TypeError('Failed to fetch') : { ok: true }));
    const q = core.createQueue({ send: s.send });
    q.add([photo('k1.jpg')], A);
    await flush();
    await jest.advanceTimersByTimeAsync(18000);
    await flush();
    q.add([photo('k2.jpg')], A);
    await flush();
    expect(core.statusText(q.summary(A))).toBe("1 of 2 added. 1 didn't go through.");
    expect(q.discard(A)).toBe(1);
    expect(q.items(A).map((i) => i.name)).toEqual(['k2.jpg']);
    expect(q.unsettled()).toBe(false);
    down = false;
  });
});

// ── (8) offline ──────────────────────────────────────────────────────────
describe('(8) offline pauses until the connection is back', () => {
  test("navigator.onLine false holds every photo until 'online'", async () => {
    const window = fakeTarget();
    const navigator = { onLine: false };
    const core = loadCore({ window, navigator });
    const s = sender();
    const onChange = jest.fn();
    const q = core.createQueue({ send: s.send, onChange });
    q.add([photo('o1.jpg'), photo('o2.jpg')], A);
    await flush();
    expect(s.calls).toHaveLength(0);
    expect(q.summary(A).offline).toBe(true);
    expect(core.statusText(q.summary(A))).toBe("No signal. 2 photos waiting — they'll send when you're back online.");
    await jest.advanceTimersByTimeAsync(60000);
    await flush();
    expect(s.calls).toHaveLength(0);
    navigator.onLine = true;
    window.fire('online');
    await flush();
    expect(s.calls.map((c) => c.name)).toEqual(['o1.jpg', 'o2.jpg']);
    expect(q.summary(A).offline).toBe(false);
    expect(core.statusText(q.summary(A))).toBe('2 photos added.');
  });

  test('without an online event the queue re-checks every 15 s', async () => {
    const navigator = { onLine: false };
    const core = loadCore({ navigator });
    const s = sender();
    const q = core.createQueue({ send: s.send });
    q.add([photo('o3.jpg')], A);
    await flush();
    expect(core.statusText(q.summary(A))).toBe("No signal. 1 photo waiting — it'll send when you're back online.");
    navigator.onLine = true;
    await jest.advanceTimersByTimeAsync(14999);
    await flush();
    expect(s.calls).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(s.calls).toHaveLength(1);
  });

  test("a network failure while offline does not use an attempt, and 'online' retries failed photos", async () => {
    const window = fakeTarget();
    const navigator = { onLine: true };
    const core = loadCore({ window, navigator });
    let mode = 'drop-offline';
    const s = sender(() => {
      if (mode === 'drop-offline') { navigator.onLine = false; return new TypeError('Failed to fetch'); }
      if (mode === 'fail') return new TypeError('Failed to fetch');
      return { ok: true };
    });
    const q = core.createQueue({ send: s.send });
    q.add([photo('w1.jpg')], A);
    await flush();
    expect(q.items(A)[0]).toMatchObject({ state: 'waiting', attempts: 0 });
    mode = 'fail';
    navigator.onLine = true;
    window.fire('online');
    await flush();
    await jest.advanceTimersByTimeAsync(18000);
    await flush();
    expect(q.items(A)[0]).toMatchObject({ state: 'failed', attempts: 3 });
    mode = 'ok';
    window.fire('online');
    await flush();
    expect(q.items(A)[0].state).toBe('done');
  });
});

// ── (9) prepareImage ─────────────────────────────────────────────────────
function exifApp1(order, orientation) {
  const little = order === 'II';
  const u16 = (v) => (little ? [v & 255, (v >> 8) & 255] : [(v >> 8) & 255, v & 255]);
  const u32 = (v) => (little
    ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]
    : [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const tiff = [].concat(
    little ? [0x49, 0x49] : [0x4D, 0x4D], u16(42), u32(8),
    u16(2),
    u16(0x010F), u16(2), u32(4), [0x41, 0x47, 0x58, 0x00],
    u16(0x0112), u16(3), u32(1), u16(orientation), [0, 0],
    u32(0));
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0].concat(tiff);
  const len = payload.length + 2;
  return [0xFF, 0xE1, (len >> 8) & 255, len & 255].concat(payload);
}
const APP0 = [0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
function jpegBytes(segments, pad) {
  return Uint8Array.from([0xFF, 0xD8].concat(segments, [0xFF, 0xDA, 0x00, 0x08, 1, 2, 3, 4, 5, 6], new Array(pad || 0).fill(7), [0xFF, 0xD9]));
}

function readOrientation(bytes) {
  let i = 2;
  while (i < bytes.length) {
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xE1) {
      const t = i + 10;
      const little = bytes[t] === 0x49;
      const u16 = (p) => (little ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1]);
      const u32 = (p) => (little
        ? (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) + bytes[p + 3] * 16777216
        : bytes[p] * 16777216 + ((bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]));
      const ifd = t + u32(t + 4);
      for (let k = 0; k < u16(ifd); k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return null;
    }
    i += 2 + len;
  }
  return null;
}

// A browser that can decode: object URLs, an Image that loads with the given
// size (or errors / never loads), and a canvas whose toBlob returns `encoded`.
function decodingEnv(opts) {
  const record = { canvases: [], drawn: [], images: 0, revoked: [], quality: null, type: null };
  function FakeImage() {
    record.images++;
    const img = this;
    Object.defineProperty(img, 'src', {
      set() {
        if (opts.decode === 'never') return;
        Promise.resolve().then(() => {
          if (opts.decode === 'error') { img.onerror && img.onerror(); return; }
          img.naturalWidth = opts.width;
          img.naturalHeight = opts.height;
          img.onload && img.onload();
        });
      },
    });
  }
  const document = {
    createElement: jest.fn((tag) => {
      const canvas = {
        tag,
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => record.drawn.push([canvas.width, canvas.height]) }),
        toBlob: (cb, type, quality) => {
          record.type = type;
          record.quality = quality;
          Promise.resolve().then(() => cb(opts.encoded === null ? null : new Blob([opts.encoded], { type })));
        },
      };
      record.canvases.push(canvas);
      return canvas;
    }),
    addEventListener: () => {},
  };
  const URL = { createObjectURL: () => 'blob:fake/' + record.images, revokeObjectURL: (u) => record.revoked.push(u) };
  return { env: { document, URL, Image: FakeImage }, record };
}

describe('(9) prepareImage', () => {
  test('no URL.createObjectURL: a JPEG passes through untouched, and no canvas or Image is touched', async () => {
    const document = { createElement: jest.fn() };
    const Image = jest.fn();
    const core = loadCore({ URL: {}, document, Image });
    const f = photo('IMG_1.jpg', 3 * MB);
    await expect(core.prepareImage(f)).resolves.toEqual({ blob: f, name: 'IMG_1.jpg', type: 'image/jpeg', shrunk: false });
    expect(document.createElement).not.toHaveBeenCalled();
    expect(Image).not.toHaveBeenCalled();
  });

  test.each([
    ['a .heic name with no type', { name: 'IMG_2231.heic', type: '' }],
    ['image/heic', { name: 'IMG_2231', type: 'image/heic' }],
    ['image/heif', { name: 'x.HEIF', type: 'image/heif' }],
  ])('%s is refused with HEIC_MESSAGE without decoding', async (label, f) => {
    const Image = jest.fn();
    const core = loadCore({ URL: {}, Image });
    const file = new File([new Uint8Array(20)], f.name, { type: f.type });
    await expect(core.prepareImage(file)).rejects.toEqual({ permanent: true, message: HEIC_TEXT });
    expect(Image).not.toHaveBeenCalled();
  });

  test('a PDF and a GIF pass through even where the browser can decode', async () => {
    const { env, record } = decodingEnv({ width: 4000, height: 3000, encoded: jpegBytes([], 10) });
    const core = loadCore(env);
    const pdf = new File([new Uint8Array(5)], 'scope.pdf', { type: 'application/pdf' });
    const gif = new File([new Uint8Array(5)], 'a.gif', { type: 'image/gif' });
    await expect(core.prepareImage(pdf)).resolves.toMatchObject({ blob: pdf, shrunk: false });
    await expect(core.prepareImage(gif)).resolves.toMatchObject({ blob: gif, shrunk: false });
    expect(record.images).toBe(0);
  });

  test('a big JPEG is drawn at 2000 px on the long edge, JPEG 0.85, with its EXIF spliced back and Orientation 1', async () => {
    const encoded = jpegBytes(APP0, 100);
    const { env, record } = decodingEnv({ width: 4032, height: 3024, encoded });
    const core = loadCore(env);
    const originalBytes = jpegBytes(APP0.concat(exifApp1('II', 6)), 5000);
    const f = new File([originalBytes], 'IMG_0042.JPG', { type: 'image/jpeg' });
    const out = await core.prepareImage(f);
    expect(out).toMatchObject({ name: 'IMG_0042.jpg', type: 'image/jpeg', shrunk: true });
    expect(out.blob.name).toBe('IMG_0042.jpg');
    expect(record.drawn).toEqual([[2000, 1500]]);
    expect([record.type, record.quality]).toEqual(['image/jpeg', 0.85]);
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0xFF, 0xD8, 0xFF, 0xE1]);
    expect(readOrientation(bytes)).toBe(1);
    expect(readOrientation(originalBytes)).toBe(6);
    expect(record.revoked).toHaveLength(1);
  });

  test('a small JPEG (<= 2000 px, <= 1.5 MB) is sent untouched', async () => {
    const { env, record } = decodingEnv({ width: 2000, height: 1200, encoded: jpegBytes([], 1) });
    const core = loadCore(env);
    const f = photo('small.jpg', 1.5 * MB);
    await expect(core.prepareImage(f)).resolves.toEqual({ blob: f, name: 'small.jpg', type: 'image/jpeg', shrunk: false });
    expect(record.drawn).toEqual([]);
  });

  test('when EXIF was there but cannot be spliced, the original goes', async () => {
    const notAJpeg = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const { env } = decodingEnv({ width: 4000, height: 3000, encoded: notAJpeg });
    const core = loadCore(env);
    const f = new File([jpegBytes(exifApp1('MM', 8), 3000)], 'IMG_7.jpg', { type: 'image/jpeg' });
    await expect(core.prepareImage(f)).resolves.toEqual({ blob: f, name: 'IMG_7.jpg', type: 'image/jpeg', shrunk: false });
  });

  test('a JPEG with no EXIF is shrunk as it is', async () => {
    const { env } = decodingEnv({ width: 3000, height: 4000, encoded: jpegBytes(APP0, 10) });
    const core = loadCore(env);
    const f = new File([jpegBytes(APP0, 4000)], 'plain.jpeg', { type: 'image/jpeg' });
    const out = await core.prepareImage(f);
    expect(out).toMatchObject({ name: 'plain.jpg', shrunk: true });
    expect(Array.from(new Uint8Array(await out.blob.arrayBuffer()).slice(0, 4))).toEqual([0xFF, 0xD8, 0xFF, 0xE0]);
  });

  test('a re-encode no smaller than the original sends the original', async () => {
    const { env } = decodingEnv({ width: 4000, height: 3000, encoded: jpegBytes(APP0, 9000) });
    const core = loadCore(env);
    const f = new File([jpegBytes(APP0, 100)], 'tiny-but-huge.jpg', { type: 'image/jpeg' });
    await expect(core.prepareImage(f)).resolves.toMatchObject({ blob: f, shrunk: false });
  });

  test('a decodable HEIC becomes a JPEG; an undecodable one is refused', async () => {
    const ok = decodingEnv({ width: 4000, height: 3000, encoded: jpegBytes(APP0, 10) });
    const heic = new File([new Uint8Array(50)], 'IMG_2231.HEIC', { type: 'image/heic' });
    await expect(loadCore(ok.env).prepareImage(heic)).resolves.toMatchObject({ name: 'IMG_2231.jpg', type: 'image/jpeg', shrunk: true });
    const bad = decodingEnv({ decode: 'error' });
    await expect(loadCore(bad.env).prepareImage(heic)).rejects.toEqual({ permanent: true, message: HEIC_TEXT });
  });

  test('a decode that never finishes gives up after 20 s and sends the original', async () => {
    const { env } = decodingEnv({ decode: 'never' });
    const core = loadCore(env);
    const f = photo('stuck.jpg', 4 * MB);
    const p = core.prepareImage(f);
    await jest.advanceTimersByTimeAsync(20000);
    await expect(p).resolves.toEqual({ blob: f, name: 'stuck.jpg', type: 'image/jpeg', shrunk: false });
  });

  test('in the queue, a HEIC is refused with the HEIC line and the next photo still goes', async () => {
    const core = loadCore({ URL: {} });
    const s = sender();
    const q = core.createQueue({ send: s.send });
    q.add([new File([new Uint8Array(9)], 'IMG_2231.heic', { type: 'image/heic' }), photo('IMG_2232.jpg')], A);
    await flush();
    expect(s.calls.map((c) => c.name)).toEqual(['IMG_2232.jpg']);
    expect(core.statusText(q.summary(A))).toBe("1 of 2 added. 1 didn't go through.\nIMG_2231.heic wasn't sent: " + HEIC_TEXT);
  });
});

// ── (10) spliceExif ──────────────────────────────────────────────────────
describe('(10) spliceExif', () => {
  test.each(['II', 'MM'])('%s byte order: EXIF right after SOI, Orientation 6 becomes 1', (order) => {
    const core = loadCore();
    const original = jpegBytes(APP0.concat(exifApp1(order, 6)), 20);
    const before = Array.from(original);
    const next = jpegBytes(APP0, 40);
    const out = core.spliceExif(original.buffer, next.buffer);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out.slice(0, 4))).toEqual([0xFF, 0xD8, 0xFF, 0xE1]);
    expect(readOrientation(out)).toBe(1);
    const app1 = exifApp1(order, 6);
    expect(Array.from(out.slice(2 + app1.length))).toEqual(Array.from(next.slice(2)));
    expect(out.length).toBe(next.length + app1.length);
    expect(Array.from(original)).toEqual(before);
  });

  test('no APP1 Exif in the original -> null', () => {
    const core = loadCore();
    expect(core.spliceExif(jpegBytes(APP0, 5), jpegBytes(APP0, 5))).toBeNull();
  });

  test('a truncated APP1 -> null', () => {
    const core = loadCore();
    const full = jpegBytes(exifApp1('II', 6), 0);
    const cut = full.slice(0, 30);
    expect(core.spliceExif(cut, jpegBytes(APP0, 5))).toBeNull();
    const lying = Uint8Array.from(full);
    lying[4] = 0x7F; // the declared length runs past the end of the file
    expect(core.spliceExif(lying, jpegBytes(APP0, 5))).toBeNull();
  });

  test('a new image that is not a JPEG, or a broken TIFF header -> null', () => {
    const core = loadCore();
    expect(core.spliceExif(jpegBytes(exifApp1('II', 6)), Uint8Array.from([0x89, 0x50, 0x4E, 0x47]))).toBeNull();
    const badTiff = jpegBytes(exifApp1('II', 6));
    badTiff[12] = 0x58; // 'X' instead of 'I'
    expect(core.spliceExif(badTiff, jpegBytes(APP0, 5))).toBeNull();
  });

  test('EXIF without an Orientation tag is still carried over', () => {
    const core = loadCore();
    const app1 = exifApp1('MM', 3);
    // Rename tag 0x0112 to 0x0131 (Software) — no orientation left to reset.
    const at = app1.findIndex((b, i) => b === 0x01 && app1[i + 1] === 0x12);
    app1[at + 1] = 0x31;
    const out = core.spliceExif(jpegBytes(app1), jpegBytes(APP0, 5));
    expect(Array.from(out.slice(2, 2 + app1.length))).toEqual(app1);
  });
});

// ── (11) uploadIdFor ─────────────────────────────────────────────────────
function referenceFnv(str, basis) {
  let h = basis >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

describe('(11) uploadIdFor', () => {
  test('is FNV-1a (two bases) over target|name|size|lastModified|type', () => {
    const core = loadCore();
    const f = photo('IMG_2231.jpg', 1234, { lastModified: 1757949000000 });
    const s = A + '|IMG_2231.jpg|1234|1757949000000|image/jpeg';
    const hex = (n) => n.toString(16).padStart(8, '0');
    expect(core.uploadIdFor(f, A)).toBe('u' + hex(referenceFnv(s, 0x811c9dc5)) + hex(referenceFnv(s, 0x050c5d1f)));
    expect(referenceFnv('a', 0x811c9dc5)).toBe(0xe40c292c); // the published FNV-1a test vector
  });

  test('is stable, and changes with target, name, size, lastModified or type', () => {
    const core = loadCore();
    const base = photo('IMG_1.jpg', 100, { lastModified: 1 });
    const id = core.uploadIdFor(base, A);
    expect(core.uploadIdFor(photo('IMG_1.jpg', 100, { lastModified: 1 }), A)).toBe(id);
    const others = [
      core.uploadIdFor(base, B),
      core.uploadIdFor(photo('IMG_2.jpg', 100, { lastModified: 1 }), A),
      core.uploadIdFor(photo('IMG_1.jpg', 101, { lastModified: 1 }), A),
      core.uploadIdFor(photo('IMG_1.jpg', 100, { lastModified: 2 }), A),
      core.uploadIdFor(photo('IMG_1.jpg', 100, { lastModified: 1, type: 'image/png' }), A),
    ];
    expect(new Set(others.concat(id)).size).toBe(6);
    others.concat(id).forEach((x) => expect(x).toMatch(UPLOAD_ID_RE));
    expect(id).toMatch(/^u[0-9a-f]{16}$/);
  });

  test('works for a bare object and a missing key', () => {
    const core = loadCore();
    expect(core.uploadIdFor({}, undefined)).toMatch(UPLOAD_ID_RE);
    expect(core.uploadIdFor(null, 'site')).toMatch(UPLOAD_ID_RE);
  });
});

// ── statusText wording ───────────────────────────────────────────────────
describe('statusText wording', () => {
  const core = loadCore();
  const base = { total: 0, done: 0, active: 0, waiting: 0, retrying: 0, failed: 0, refused: 0, pausedUntil: 0, offline: false, index: 0, refusals: [], skipped: 0 };
  const S = (o) => Object.assign({}, base, o);

  test.each([
    ['active', S({ total: 6, index: 2, active: 1, waiting: 4, done: 1 }), 'Uploading 2 of 6…'],
    ['active with waits', S({ total: 6, index: 3, active: 1, waiting: 3, retrying: 1, done: 2 }), 'Uploading 3 of 6… 1 will retry'],
    ['offline', S({ total: 2, waiting: 2, offline: true }), "No signal. 2 photos waiting — they'll send when you're back online."],
    ['all done, one', S({ total: 1, done: 1 }), 'Photo added.'],
    ['all done, six', S({ total: 6, done: 6 }), '6 photos added.'],
    ['with failures', S({ total: 6, done: 4, failed: 1, refused: 1, refusals: [{ name: 'IMG_2231.heic', message: HEIC_TEXT }] }),
      "4 of 6 added. 2 didn't go through.\nIMG_2231.heic wasn't sent: " + HEIC_TEXT],
    ['skipped only', S({ skipped: 2 }), 'Skipped 2 photos already added.'],
    ['nothing', S({}), ''],
    ['at most two refusal lines', S({ total: 3, refused: 3, refusals: [{ name: 'a', message: 'x' }, { name: 'b', message: 'y' }, { name: 'c', message: 'z' }] }),
      "0 of 3 added. 3 didn't go through.\na wasn't sent: x\nb wasn't sent: y"],
  ])('%s', (name, summary, text) => {
    expect(core.statusText(summary)).toBe(text);
  });

  test('paused: the seconds count down from pausedUntil', () => {
    expect(core.statusText(S({ total: 3, waiting: 3, pausedUntil: Date.now() + 30000 }))).toBe('The server is busy. Trying again in 30 s…');
    expect(core.statusText(S({ total: 3, waiting: 3, pausedUntil: Date.now() + 1200 }))).toBe('The server is busy. Trying again in 2 s…');
  });

  test('other nouns', () => {
    expect(core.statusText(S({ total: 1, done: 1 }), { one: 'file', many: 'files' })).toBe('File added.');
    expect(core.statusText(S({ skipped: 3 }), { one: 'file', many: 'files' })).toBe('Skipped 3 files already added.');
  });
});

// ── onChange / onIdle / discard ──────────────────────────────────────────
describe('page callbacks', () => {
  test('onChange sees every state; onIdle fires once when the queue goes quiet', async () => {
    const core = loadCore();
    const s = sender();
    const seen = [];
    const onIdle = jest.fn(() => seen.push('idle'));
    const q = core.createQueue({ send: s.send, onChange: (item, queue) => { seen.push(item.name + ':' + item.state); expect(queue).toBe(q); }, onIdle });
    q.add([photo('c1.jpg')], A);
    await flush();
    expect(seen).toEqual(['c1.jpg:waiting', 'c1.jpg:preparing', 'c1.jpg:uploading', 'c1.jpg:done', 'idle']);
    expect(onIdle).toHaveBeenCalledWith(q);
  });

  test('a page callback that throws does not stop the queue', async () => {
    const core = loadCore();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = sender();
    const q = core.createQueue({ send: s.send, onChange: () => { throw new Error('repaint broke'); } });
    q.add([photo('t1.jpg'), photo('t2.jpg')], A);
    await flush();
    expect(s.calls).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('prepared previews are object URLs, revoked when the photo is cleared', async () => {
    const revoked = [];
    let n = 0;
    const core = loadCore({ URL: { createObjectURL: () => 'blob:p/' + (++n), revokeObjectURL: (u) => revoked.push(u) } });
    const s = sender(() => httpError(400, 'No file'));
    const q = core.createQueue({ send: s.send });
    q.add([photo('d1.jpg')], A);
    await flush();
    expect(q.items(A)[0]).toMatchObject({ state: 'refused', previewUrl: 'blob:p/1' });
    expect(q.discard(A)).toBe(1);
    expect(revoked).toEqual(['blob:p/1']);
    expect(q.items(A)).toEqual([]);
  });
});

// ── The rules the core lives under ───────────────────────────────────────
describe('the core block', () => {
  const block = coreBlock(SRC);

  test('is ES5: no let/const, arrows, classes, templates, spreads, destructuring or shorthand', () => {
    const ast = parser.parse(block, { sourceType: 'script' });
    const bad = [];
    const visit = (node) => {
      if (!node || typeof node.type !== 'string') return;
      const t = node.type;
      if (['ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression', 'TemplateLiteral', 'SpreadElement',
        'RestElement', 'ObjectPattern', 'ArrayPattern', 'AssignmentPattern', 'ForOfStatement', 'AwaitExpression',
        'YieldExpression'].includes(t)) bad.push(t + '@' + node.loc.start.line);
      if (t === 'VariableDeclaration' && node.kind !== 'var') bad.push(node.kind + '@' + node.loc.start.line);
      if (t === 'ObjectProperty' && (node.shorthand || node.computed)) bad.push('property@' + node.loc.start.line);
      if (t === 'ObjectMethod') bad.push('method@' + node.loc.start.line);
      if ((t === 'FunctionDeclaration' || t === 'FunctionExpression') && (node.async || node.generator)) bad.push('async@' + node.loc.start.line);
      for (const k of Object.keys(node)) {
        if (k === 'loc') continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v.type === 'string') visit(v);
      }
    };
    visit(ast.program);
    expect(bad).toEqual([]);
    // Library calls newer than ES5, in code (a comment may name them).
    let code = block;
    ast.comments.slice().reverse().forEach((c) => { code = code.slice(0, c.start) + code.slice(c.end); });
    expect(code).not.toMatch(/Object\.assign|Array\.from|\.includes\(|\.padStart\(|Math\.imul|\bSymbol\b/);
  });

  test('touches no app globals and makes no request of its own', () => {
    expect(block).not.toMatch(/\bp86|\bappData\b|localStorage|\bfetch\s*\(|XMLHttpRequest|\/api\//);
  });

  test('defines exactly one top-level function, photoQueueCore', () => {
    const ast = parser.parse(block, { sourceType: 'script' });
    expect(ast.program.body.map((n) => n.type + ':' + (n.id && n.id.name))).toEqual(['FunctionDeclaration:photoQueueCore']);
  });

  test('HEIC_MESSAGE is the shared refusal wording', () => {
    expect(loadCore().HEIC_MESSAGE).toBe(HEIC_TEXT);
  });
});

describe('module shape', () => {
  test('module.exports and window.p86PhotoQueue carry the contract', () => {
    const keys = ['HEIC_MESSAGE', 'createQueue', 'prepareImage', 'spliceExif', 'statusText', 'uploadIdFor'];
    expect(Object.keys(require('../js/photo-upload-queue.js')).sort()).toEqual(keys);
    const win = {};
    // eslint-disable-next-line no-new-func
    new Function('window', 'module', SRC)(win, undefined);
    expect(Object.keys(win.p86PhotoQueue).sort()).toEqual(keys);
    const q = win.p86PhotoQueue.createQueue({ send: () => Promise.resolve({}) });
    expect(Object.keys(q).sort()).toEqual(['add', 'busy', 'discard', 'items', 'retry', 'summary', 'unsettled']);
  });
});
