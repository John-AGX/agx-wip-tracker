// VOID MUST ASK, AND THEN MUST ACTUALLY VOID.
//
// Both Void buttons in the Cost Inbox were guarded by raw window.confirm():
//
//   if (!window.confirm('Void this receipt?')) return;
//
// NATIVE confirm() IS A NO-OP IN AN INSTALLED PWA. It returns undefined
// without ever drawing a dialog, so !undefined is true and the guard returned
// immediately. On John's phone the button asked nothing and did nothing — a
// dead control that looked like a working one. The file has defined the right
// helper since line 5 and already uses it elsewhere; these two call sites were
// simply missed.
//
// The tests execute the REAL handlers, lifted out of the shipped file, because
// the property has two halves and a source scan can only see one of them: it
// must ASK, and on a yes it must actually reach the void endpoint. A handler
// that asks and then drops the answer would pass any "no window.confirm here"
// grep.
//
// The cancel case is also what proves the answer is AWAITED. p86Ask returns a
// PROMISE, and a promise object is truthy — so an un-awaited guard would sail
// past a "no" and void the receipt anyway. That is the same class of bug as
// the one being fixed, one turn of the screw further on.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'cost-inbox.js'), 'utf8')
  .replace(/\r\n?/g, '\n');

function liftHandler(anchor) {
  const i = SRC.indexOf(anchor);
  if (i < 0) throw new Error('cost-inbox.js no longer contains: ' + anchor);
  if (SRC.indexOf(anchor, i + 1) !== -1) throw new Error('anchor is not unique: ' + anchor);
  const start = i + anchor.length;
  let depth = 0;
  let started = false;
  for (let k = SRC.indexOf('{', start); k < SRC.length; k++) {
    if (SRC[k] === '{') { depth++; started = true; } else if (SRC[k] === '}') {
      depth--;
      if (started && depth === 0) return SRC.slice(start, k + 1);
    }
  }
  throw new Error('unbalanced braces lifting handler at ' + anchor);
}

const SITES = [
  ['the receipt viewer', "if (voidBtn) voidBtn.addEventListener('click', "],
  ['the capture form', "if (delBtn) delBtn.addEventListener('click', "],
];

function harness(handlerSrc, answer, removeResult) {
  const log = { asked: [], removed: [], toasts: [], closed: 0, reloaded: 0, nativeConfirm: 0 };
  const win = {
    // The installed-PWA behaviour of the thing that used to be called here:
    // no dialog, undefined returned. If the handler reaches for it the test
    // sees it, rather than the user discovering it.
    confirm: () => { log.nativeConfirm++; return undefined; },
    p86Api: {
      receipts: {
        remove: (id) => {
          log.removed.push(id);
          return removeResult === 'reject' ? Promise.reject(new Error('nope')) : Promise.resolve({});
        },
      },
    },
  };
  const p86Ask = (message, opts) => {
    log.asked.push({ message, opts });
    return Promise.resolve(answer);   // a PROMISE, exactly as the real helper returns
  };
  const fn = new Function(
    'p86Ask', 'window', 'toast', 'close', 'reload', 'r',
    'return (' + handlerSrc + ');'
  )(
    p86Ask,
    win,
    (m, k) => log.toasts.push([m, k]),
    () => { log.closed++; },
    () => { log.reloaded++; },
    { id: 'rc_42' }
  );
  return { fn, log };
}

// Let the .then() chain inside the handler settle.
const settle = () => new Promise((res) => setTimeout(res, 0));

describe.each(SITES)('%s Void button', (_name, anchor) => {
  const handlerSrc = liftHandler(anchor);

  test('it is an async handler, so the answer can be waited for', () => {
    expect(handlerSrc).toMatch(/^async function/);
  });

  test('it ASKS — and through the in-app helper, not the native dialog', async () => {
    const { fn, log } = harness(handlerSrc, true);
    await fn();
    await settle();
    expect(log.asked).toHaveLength(1);
    expect(log.asked[0].message).toBe('Void this receipt?');
    expect(log.nativeConfirm).toBe(0);
  });

  test('the question names the destructive act in its button', async () => {
    // "Confirm" on a dialog that voids money is not a question anybody read.
    const { fn, log } = harness(handlerSrc, true);
    await fn();
    await settle();
    expect(log.asked[0].opts).toMatchObject({ confirmLabel: 'Void' });
  });

  test('on YES it ACTUALLY VOIDS — the half a grep cannot see', async () => {
    const { fn, log } = harness(handlerSrc, true);
    await fn();
    await settle();
    expect(log.removed).toEqual(['rc_42']);
    expect(log.toasts).toContainEqual(['Receipt voided', 'success']);
    expect(log.closed).toBe(1);
    expect(log.reloaded).toBe(1);
  });

  test('on NO it voids nothing', async () => {
    // Also the proof that the promise is awaited: a promise object is truthy,
    // so an un-awaited guard would sail straight past this "no".
    const { fn, log } = harness(handlerSrc, false);
    await fn();
    await settle();
    expect(log.removed).toEqual([]);
    expect(log.toasts).toEqual([]);
    expect(log.closed).toBe(0);
    expect(log.reloaded).toBe(0);
  });

  test('a failed void says so and does not pretend the receipt is gone', async () => {
    const { fn, log } = harness(handlerSrc, true, 'reject');
    await fn();
    await settle();
    expect(log.toasts).toContainEqual(['Could not void', 'error']);
    expect(log.closed).toBe(0);
    expect(log.reloaded).toBe(0);
  });
});

describe('no confirm guard in this file is a no-op on a phone', () => {
  test('window.confirm survives in exactly one place: inside p86Ask', () => {
    const hits = [...SRC.matchAll(/window\.confirm\(/g)].map((m) => m.index);
    expect(hits).toHaveLength(1);
    const helper = SRC.slice(SRC.indexOf('function p86Ask('), SRC.indexOf('// Cost Inbox —'));
    expect(hits[0]).toBeGreaterThan(SRC.indexOf('function p86Ask('));
    expect(helper).toContain('window.confirm(message)');
  });

  test('every void guard goes through the helper', () => {
    const guards = [...SRC.matchAll(/Void this receipt\?/g)];
    expect(guards).toHaveLength(2);
    guards.forEach((g) => {
      const line = SRC.slice(SRC.lastIndexOf('\n', g.index) + 1, SRC.indexOf('\n', g.index));
      expect(line).toContain('await p86Ask(');
      expect(line).not.toContain('window.confirm');
    });
  });
});
