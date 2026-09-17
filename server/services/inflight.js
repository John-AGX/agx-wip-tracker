'use strict';

// IN-FLIGHT SENDS: the fire-and-forget work a request starts and does not wait
// for (the approval notice, an assignment email, a crew-problem alert).
//
// A deploy stops the process with SIGTERM. Without this module a notice that
// was half way through its sends when that signal arrived was simply cut off:
// the crew had finished, the office never heard. So every such call is handed
// to track(), and server/index.js, on SIGTERM, stops taking new work, calls
// beginClosing() and awaits drain(budget) before it exits. Whatever is still
// running when the budget ends is left to the notice cron's retry rules.
//
//   track(promise, label) -> a promise resolving to the value, or to undefined
//                            when it rejected (logged as '[inflight] <label>
//                            failed'). It never rejects, so a caller that does
//                            not await it cannot raise an unhandled rejection.
//   size()                -> how many tracked promises have not settled
//   isClosing()           -> true after beginClosing(); cron ticks skip then
//   beginClosing()
//   drain(ms)             -> resolves with the number still pending when every
//                            tracked promise has settled (0) or when the budget
//                            ran out, whichever comes first
//   _reset()              -> tests only
//
// No database, no timers left running (drain clears its own), and nothing here
// ends the process: only server/index.js does that.

const pending = new Set();
const waiters = new Set();
let closing = false;

function settledOne(entry) {
  pending.delete(entry);
  if (pending.size) return;
  Array.from(waiters).forEach(function (w) { w(); });
}

function track(promise, label) {
  const name = String(label == null || label === '' ? 'task' : label);
  let entry = null;
  entry = Promise.resolve(promise).then(
    function (value) { return value; },
    function (e) {
      console.warn('[inflight] ' + name + ' failed:', e && e.message ? e.message : e);
      return undefined;
    }
  ).then(function (value) {
    settledOne(entry);
    return value;
  });
  pending.add(entry);
  return entry;
}

function size() {
  return pending.size;
}

function isClosing() {
  return closing;
}

function beginClosing() {
  closing = true;
}

function drain(ms) {
  if (!pending.size) return Promise.resolve(0);
  const budget = Math.max(0, Number(ms) || 0);
  return new Promise(function (resolve) {
    let finished = false;
    let timer = null;
    function finish() {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      waiters.delete(finish);
      resolve(pending.size);
    }
    waiters.add(finish);
    timer = setTimeout(finish, budget);
  });
}

function _reset() {
  pending.clear();
  closing = false;
  Array.from(waiters).forEach(function (w) { w(); });
  waiters.clear();
}

module.exports = { track, size, isClosing, beginClosing, drain, _reset };
