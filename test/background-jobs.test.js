// BACKGROUND WORK MUST NOT RUN INSIDE A TEST RUN (server/background-jobs.js).
//
// The 2026-09-29 flake hunt. A full run failed five to nine suites, a
// DIFFERENT set each time, and every one passed alone. One measured run with
// the output kept showed what it actually was:
//
//   * five of six failures were "Exceeded timeout of 5000 ms" — Jest's
//     default, not a number anybody here chose;
//   * the sixth asserted a wall-clock duration;
//   * plus "A worker process has failed to exit gracefully" and three
//     "Cannot log after tests are done", traced to timers that production
//     route modules start when they are REQUIRED: geocode backfills at 9s,
//     12s and 18s, and an Anthropic agent sweep at 30s then hourly.
//
// A full run takes about ten minutes, so every one of those fires, in every
// worker that required the file. They query the database, call a geocoder
// and call an API — taking CPU and memory from the tests on a machine that
// had 0.5 GB of 15.6 GB free. That is how a test needing half a second
// misses a five-second deadline.
//
// unref() IS NOT THE FIX and had already been tried twice, in
// admin-agents-routes.js and project-routes.js, both of which say so in
// their own comments. unref means "do not keep the process alive for my
// sake"; while the process is alive the timer still fires. THREE test files
// had also grown per-file workarounds pointing the pool at a stub before
// closing, to survive the 9s one.
//
// What this file pins is that the cause stays fixed.
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server');

// A timer that fires when the module is REQUIRED, which is the shape that
// wakes up inside a test worker. That means COLUMN ZERO: a timer indented at
// all is inside a function and runs when something calls it — a request doing
// work, not a module waking up by itself.
//
// Written once and used by both checks below. The first version allowed two
// leading spaces and then let `\w*` match nothing and `\s*` eat the rest of
// the indentation, so it flagged a setTimeout four spaces deep inside a route
// handler. A false positive there teaches the next reader to loosen the test
// rather than trust it.
function moduleLoadTimers(src) {
  return src.split(/\r?\n/).filter(function (line) {
    if (/^\s/.test(line)) return false;
    return /^(?:(?:const|let|var)\s+\w+\s*=\s*)?set(?:Timeout|Interval)\s*\(/.test(line);
  });
}
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the helper', () => {
  const bg = require('../server/background-jobs');

  test('jest sets NODE_ENV=test, so the guard is live in this very run', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(bg.underTest()).toBe(true);
  });

  test('under test it schedules NOTHING, and says so by returning null', () => {
    let ran = 0;
    expect(bg.after(1, () => { ran += 1; }, 'probe')).toBe(null);
    expect(bg.every(1, () => { ran += 1; }, 'probe')).toBe(null);
    expect(ran).toBe(0);
  });

  test('nothing fires even after the delay has comfortably passed', async () => {
    let ran = 0;
    bg.after(1, () => { ran += 1; }, 'probe');
    bg.every(1, () => { ran += 1; }, 'probe');
    await new Promise((r) => setTimeout(r, 60));
    expect(ran).toBe(0);
  });

  test('OUTSIDE a test it schedules, unrefs, and the callback really runs', async () => {
    // The other half of the claim. A guard that also switched the job off in
    // production would be a far worse bug than the flakes it fixed, so this
    // drives the real thing with the flag cleared.
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(bg.underTest()).toBe(false);
      let ran = 0;
      const t = bg.after(5, () => { ran += 1; }, 'probe');
      expect(t).not.toBe(null);
      expect(typeof t.unref).toBe('function');
      const i = bg.every(5, () => {}, 'probe');
      expect(i).not.toBe(null);
      await new Promise((r) => setTimeout(r, 60));
      clearInterval(i);
      expect(ran).toBe(1);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  test('a job that throws is contained — it has no request to fail', async () => {
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      bg.after(5, () => { throw new Error('boom'); }, 'thrower');
      bg.after(5, () => Promise.reject(new Error('async boom')), 'rejecter');
      await new Promise((r) => setTimeout(r, 60));
      const said = warn.mock.calls.map((c) => c.join(' ')).join('|');
      expect(said).toContain('background:thrower');
      expect(said).toContain('background:rejecter');
    } finally {
      warn.mockRestore();
      process.env.NODE_ENV = saved;
    }
  });
});

describe('no route module starts its own timer on require', () => {
  // The four that did. Each now goes through the helper, so a test run does
  // not wake them up.
  const CONVERTED = [
    ['routes/admin-agents-routes.js', 'the Anthropic agent resync sweep'],
    ['routes/estimate-routes.js', 'the estimate geocode backfill'],
    ['routes/lead-routes.js', 'the lead geocode backfill'],
    ['routes/project-routes.js', 'the project geocode backfill'],
  ];

  test.each(CONVERTED)('%s schedules through the helper', (rel) => {
    expect(code(rel)).toMatch(/background\.(after|every)\(/);
  });

  test.each(CONVERTED)('%s has no bare top-level setTimeout/setInterval left', (rel) => {
    expect(moduleLoadTimers(code(rel))).toEqual([]);
  });

  test('and the whole server has no NEW module-load timer', () => {
    // The scan that would have caught this in the first place.
    const offenders = [];
    for (const d of ['routes', 'services']) {
      for (const name of fs.readdirSync(path.join(SERVER, d))) {
        if (!name.endsWith('.js')) continue;
        const rel = d + '/' + name;
        for (const line of moduleLoadTimers(code(rel))) offenders.push(rel + ': ' + line.trim().slice(0, 70));
      }
    }
    // server/routes/ai-routes.js keeps one: a 10-minute prune of an
    // in-memory Map. It touches no database, no network and no console, and
    // a ten-minute run barely reaches it once — converting it would be
    // churn, not a fix. Named here so the list is a decision, not an
    // oversight.
    expect(offenders).toEqual([
      'routes/ai-routes.js: setInterval(() => {',
    ]);
  });
});

describe('the jest config says what it chose, and why it is not a default', () => {
  const cfg = require('../jest.config.js');

  test('the per-test timeout is explicit, not Jest’s 5 s default', () => {
    // Five of six failures in the measured run were exactly this.
    expect(cfg.testTimeout).toBe(30000);
  });

  test('workerIdleMemoryLimit is NOT set, and that is a measured result', () => {
    // It was tried at 768MB. It did bound the memory — largest worker 1140
    // MB down to 771, free RAM 0.5 GB up to 1.1 — and it also made
    // test/service-ticket-attachment-access.js fail to RUN, "4 child
    // process exceptions, exceeding retry limit", taking 204 tests out of
    // the run. A suite that does not execute cannot fail, which is the
    // worst thing a test setting can do.
    expect(cfg.workerIdleMemoryLimit).toBeUndefined();
  });

  test('and the worker count is chosen rather than inherited', () => {
    // jest-config's defaults object says '50%', but that is the WATCH-mode
    // default: a plain run reports cpus - 1, which was 13 of 14 here.
    expect(cfg.maxWorkers).toBe('50%');
  });

  test('the config lives in ONE place — not here and in package.json', () => {
    // Jest reads package.json's `jest` key too, and two sources that
    // disagree is a config nobody can reason about.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.jest).toBeUndefined();
    expect(cfg.testPathIgnorePatterns).toEqual(['/node_modules/', '/\\.claude/']);
  });
});
