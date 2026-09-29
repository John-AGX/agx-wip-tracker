'use strict';

// WHY THIS FILE EXISTS.
//
// The configuration was three lines in package.json's `jest` key, and
// everything else was Jest's defaults. Two of those defaults were wrong for
// this repo in a way that cost real time: a full run failed five to nine
// suites, a DIFFERENT five to nine each time, and every one of them passed
// when run alone. Re-running the suite to "confirm" never converged, because
// each run re-rolls which suites lose the race.
//
// Measured on 2026-09-29, one full run with the output kept (383 suites,
// 12,922 tests, ~10 minutes):
//
//   6 failures. FIVE were "Exceeded timeout of 5000 ms" — Jest's default
//   per-test timeout. The sixth asserted a wall-clock duration and is fixed
//   in the test itself (test/materials-extract.test.js).
//
//   The run also reported "A worker process has failed to exit gracefully"
//   and three "Cannot log after tests are done", traced to background timers
//   that production route modules start on require. Those are switched off
//   under test now — see server/background-jobs.js.
//
//   The machine during the run: 15.6 GB of RAM with 0.5 GB free, and Jest
//   workers grown past 1.1 GB each.
//
// So the flakiness was never one bug. It was a default timeout sized for a
// quiet machine, on a machine that is not quiet.

module.exports = {
  testPathIgnorePatterns: [
    '/node_modules/',
    '/\\.claude/',
  ],

  // Jest's default is 5000 ms, and nothing in this suite asserts speed —
  // the tests that fail at 5 s need well under one second on an idle box
  // and lose only because seven workers are competing for fourteen cores
  // that other work is also using.
  //
  // 30 s is headroom, not permission: a test that genuinely hangs still
  // fails, it just takes half a minute to say so, which against a ten-minute
  // run is nothing. A test that WANTS a tight bound still sets its own —
  // several already pass a third argument to test(), and those are
  // unaffected by this.
  //
  // This is deliberately not "make the timeout enormous". If a suite starts
  // needing more than 30 s per test, that is worth knowing about rather than
  // absorbing.
  testTimeout: 30000,

  // workerIdleMemoryLimit IS DELIBERATELY NOT SET, and that is a result
  // rather than an omission.
  //
  // It was tried at 768MB and it worked as advertised on the numbers: the
  // largest workers came down from 1140 MB to 771, and free RAM went from
  // 0.5 GB to 1.1 GB. It also made test/service-ticket-attachment-access.js
  // fail to run at all — "Jest worker encountered 4 child process
  // exceptions, exceeding retry limit" — taking 204 tests out of the run
  // with it. A setting that silently stops a suite from executing is worse
  // than the memory it saves, because a suite that does not run is a suite
  // that cannot fail.
  //
  // It was not needed either: with maxWorkers halved and the background jobs
  // off, the run is green and faster without it. Left out, with the
  // measurement written down, so the next person reaching for it knows it
  // was tried.

  // THIRTEEN was the number, not the seven I first assumed. jest-config's
  // defaults object says maxWorkers: '50%', but that is the WATCH-mode
  // default — `jest --showConfig` on a plain run reports cpus - 1, which is
  // 13 of the 14 cores here.
  //
  // 13 workers that each grow past a gigabyte is how a 15.6 GB machine ends
  // up with 0.5 GB free, and a machine that is swapping is a machine where
  // any test can miss any deadline. Even with the memory limit above, 13
  // × 768 MB is about 10 GB of ceiling on a box that also runs everything
  // else.
  //
  // 50% is the same figure Jest itself picks when it is being careful. On a
  // CPU-bound suite, halving the workers does not halve the throughput —
  // the cores were already oversubscribed — and it removes the swapping,
  // which is the part that made the failures random.
  maxWorkers: '50%',
};
