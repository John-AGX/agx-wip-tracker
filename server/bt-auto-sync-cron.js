// The clock for the unattended Buildertrend sync.
//
// It does nothing at all unless BT_AUTO_SYNC is on — start() arms the timers
// either way so the switch can be read at tick time rather than at boot, but
// runOnce() returns { skipped } immediately when it is off. That way turning
// it on does not need a deploy, and turning it off takes effect on the next
// tick rather than the next restart.
//
// One at a time, always. Clickr is read per tick and the apply path takes a
// process-wide lock of its own; two overlapping runs would fight over it and
// the second would only ever see 429s.
'use strict';

const autoSync = require('./services/clickr/auto-sync');

// Every 30 minutes. Clickr itself refreshes from Buildertrend on roughly a
// 20-minute cycle, so anything faster re-reads the same answer and spends the
// rate limit to learn nothing.
const TICK_MS = 30 * 60 * 1000;
// Not at boot: a deploy restarts every instance at once, and a sync that begins
// while the server is still warming would read a half-ready P86 side.
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
const LOG_KEY = '[bt-auto-sync]';

let started = false;
let firstTimer = null;
let tickTimer = null;
let running = false;

function pool() {
  return require('./db').pool;
}

async function runOnce(opts) {
  const deps = (opts && opts.deps) || { pool: pool(), env: process.env };
  const report = await autoSync.runOnce(deps);
  if (report && report.skipped) return report;
  if (report) {
    const t = report.totals || {};
    console.log(LOG_KEY + ' run ' + report.runId + ' — created ' + (t.created || 0)
      + ', applied ' + (t.applied || 0) + ', linked ' + (t.linked || 0)
      + ', failed ' + (t.failed || 0)
      + (report.permanentLeft ? ', ' + report.permanentLeft + ' left for a person' : ''));
  }
  return report;
}

function tick(opts) {
  if (running) return Promise.resolve(null);
  running = true;
  return runOnce(opts || {}).then(
    function (r) { running = false; return r; },
    function (e) { running = false; console.warn(LOG_KEY + ' tick failed:', e && e.message); return null; }
  );
}

function start() {
  if (started) return;
  started = true;
  firstTimer = setTimeout(function () { firstTimer = null; tick(); }, FIRST_RUN_DELAY_MS);
  if (firstTimer.unref) firstTimer.unref();
  tickTimer = setInterval(function () { tick(); }, TICK_MS);
  if (tickTimer.unref) tickTimer.unref();
  console.log(LOG_KEY + ' armed; tick every ' + Math.round(TICK_MS / 60000)
    + ' min (writes only while BT_AUTO_SYNC is on)');
}

function stop() {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  started = false;
}

module.exports = { start, stop, runOnce, tick, TICK_MS, FIRST_RUN_DELAY_MS, LOG_KEY };
