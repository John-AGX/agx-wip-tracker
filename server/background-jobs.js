'use strict';

// BACKGROUND WORK A MODULE STARTS WHEN IT IS REQUIRED.
//
// Several route modules schedule a sweep at load: the geocode backfills for
// projects (9s), leads (12s) and estimates (18s), and the reference-link
// agent resync (30s, then hourly). In the server that is right — the work
// should start once boot has settled.
//
// IN A TEST RUN IT IS WRONG, and measurably so. `npx jest` takes about ten
// minutes across 383 suites, so every one of those timers fires, in every
// worker that required the file, while the tests are running. They query the
// database, call a geocoder and call the Anthropic API. What that produces:
//
//   * "Cannot log after tests are done" — a sweep finishing after the suite
//     that required it, logging into a torn-down console;
//   * callbacks querying a pool the suite has already closed or re-stubbed;
//   * and, the reason this module exists, REAL CPU AND MEMORY taken from
//     the tests themselves on a machine already at its limit — which is how
//     a test that needs 500ms blows Jest's 5-second default and fails for
//     no reason anybody can reproduce alone.
//
// unref() IS NOT THIS. It was tried twice — admin-agents-routes.js and
// project-routes.js both say so in their own comments — and it is a
// different promise: "do not keep the process alive for my sake". While the
// process IS alive, which it is for the whole run, an unref'd timer still
// fires and the callback still does all of the above. The timer has to not
// be scheduled.
//
// NODE_ENV === 'test' is the repo's existing signal (server/auth.js uses it
// for the JWT secret), and Jest sets it when it is not already set.
//
// A job that a TEST wants to drive is still callable: these helpers schedule
// the function, they do not own it. Every call site keeps its function
// exported or in scope exactly as before.

function underTest() {
  return process.env.NODE_ENV === 'test';
}

/**
 * after(ms, fn, label) — run once, ms after load. Returns the timer, or null
 * under test. unref'd, so it still never holds a process open by itself.
 */
function after(ms, fn, label) {
  if (underTest()) return null;
  const t = setTimeout(function () {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch(function (e) { warn(label, e); });
    } catch (e) { warn(label, e); }
  }, ms);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

/** every(ms, fn, label) — the same, repeating. */
function every(ms, fn, label) {
  if (underTest()) return null;
  const t = setInterval(function () {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch(function (e) { warn(label, e); });
    } catch (e) { warn(label, e); }
  }, ms);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

// A background job that throws must never take the process with it — it has
// no request to fail and nobody waiting on it.
function warn(label, e) {
  try {
    console.warn('[background:' + (label || 'job') + ']', (e && e.message) || e);
  } catch (_) { /* a logger that is gone is not worth crashing over */ }
}

module.exports = { after, every, underTest };
