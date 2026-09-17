// IN-FLIGHT SENDS FINISH BEFORE A DEPLOY STOPS THE PROCESS.
//
// services/inflight.js is what server/index.js drains on SIGTERM. Driven here
// with hand-made promises, so what is asserted is the tracker's own contract:
//   * track hands back the value, and a rejection becomes undefined plus a
//     warning, never an unhandled rejection;
//   * size counts what has not settled;
//   * drain resolves 0 once everything settles, and the number still pending
//     when the budget runs out — without leaving a timer behind;
//   * the closing flag.
// Two rules are then removed from a copy of the module and shown to fail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL = path.join(__dirname, '..', 'server', 'services', 'inflight.js');
const inflight = require(REAL);
const tmpDirs = [];

function mutant(anchor, replacement) {
  const src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length !== 2) throw new Error('anchor not found');
  const out = src.replace(anchor, () => replacement);
  if (out === src) throw new Error('mutation changed nothing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-inflight-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'inflight.js');
  fs.writeFileSync(p, out, 'utf8');
  return require(p);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let warn;
beforeEach(() => {
  inflight._reset();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); });
afterAll(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

describe('track', () => {
  test('hands back the value and stops counting it once settled', async () => {
    const d = deferred();
    const tracked = inflight.track(d.promise, 'ticket_approval');
    expect(inflight.size()).toBe(1);
    d.resolve({ sent: 2 });
    await expect(tracked).resolves.toEqual({ sent: 2 });
    expect(inflight.size()).toBe(0);
  });

  test('a rejection resolves undefined, warns with the label, and never rejects', async () => {
    const tracked = inflight.track(Promise.reject(new Error('smtp down')), 'ticket_problem');
    await expect(tracked).resolves.toBeUndefined();
    expect(inflight.size()).toBe(0);
    expect(warn).toHaveBeenCalledWith('[inflight] ticket_problem failed:', 'smtp down');
  });

  test('a plain value is tracked too', async () => {
    await expect(inflight.track(7, 'x')).resolves.toBe(7);
    expect(inflight.size()).toBe(0);
  });

  test('size counts only what has not settled', async () => {
    const a = deferred();
    const b = deferred();
    inflight.track(a.promise, 'a');
    const tb = inflight.track(b.promise, 'b');
    expect(inflight.size()).toBe(2);
    b.resolve(1);
    await tb;
    expect(inflight.size()).toBe(1);
    a.resolve(1);
  });
});

describe('drain', () => {
  test('resolves 0 at once with nothing pending', async () => {
    await expect(inflight.drain(1000)).resolves.toBe(0);
  });

  test('resolves 0 as soon as everything settles, well inside the budget', async () => {
    const a = deferred();
    const b = deferred();
    inflight.track(a.promise, 'a');
    inflight.track(b.promise, 'b');
    const started = Date.now();
    const draining = inflight.drain(5000);
    setTimeout(() => a.resolve('ok'), 5);
    setTimeout(() => b.reject(new Error('boom')), 10);
    await expect(draining).resolves.toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('resolves with the number still pending when the budget runs out', async () => {
    const stuck = deferred();
    const quick = deferred();
    inflight.track(stuck.promise, 'stuck');
    inflight.track(quick.promise, 'quick');
    quick.resolve();
    await expect(inflight.drain(30)).resolves.toBe(1);
    stuck.resolve();
  });

  test('leaves no timer running once it resolved early', async () => {
    jest.useFakeTimers();
    try {
      const d = deferred();
      inflight.track(d.promise, 'a');
      const draining = inflight.drain(60000);
      expect(jest.getTimerCount()).toBe(1);
      d.resolve();
      await draining;
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('closing', () => {
  test('beginClosing sets the flag; _reset clears it and the pending set', () => {
    expect(inflight.isClosing()).toBe(false);
    inflight.beginClosing();
    expect(inflight.isClosing()).toBe(true);
    inflight.track(new Promise(() => {}), 'never');
    expect(inflight.size()).toBe(1);
    inflight._reset();
    expect(inflight.isClosing()).toBe(false);
    expect(inflight.size()).toBe(0);
  });

  test('the module never ends the process itself', () => {
    const src = fs.readFileSync(REAL, 'utf8');
    expect(src).not.toMatch(/process\.exit/);
  });
});

describe('mutants', () => {
  test('MUTANT: stop swallowing the rejection and a failed send rejects out of track', async () => {
    const mod = mutant(
      "      console.warn('[inflight] ' + name + ' failed:', e && e.message ? e.message : e);\n      return undefined;",
      '      throw e;');
    const tracked = mod.track(Promise.reject(new Error('smtp down')), 'x');
    await expect(tracked).rejects.toThrow('smtp down');
  });

  test('MUTANT: never forget a settled promise and drain waits out the whole budget', async () => {
    const mod = mutant('  pending.delete(entry);\n', '');
    await mod.track(Promise.resolve(1), 'done');
    await expect(mod.drain(20)).resolves.toBe(1);
  });
});
