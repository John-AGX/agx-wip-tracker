/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * A JOB DOES NOT GO DIRTY BY BEING OPENED.
 *
 * The hold is keyed on the dirty SET rather than on a counter, and the whole
 * safety argument for that choice is one sentence: "a derived recompute that
 * lands on the same value is not dirty". saveData() runs on VIEW —
 * renderJobDetail force-recalculates sub costs and % complete every time a job
 * is opened — so if that sentence is false, opening a job raises the unsaved
 * banner and drops the job into the conflict window with no user edit anywhere
 * near it.
 *
 * It WAS false, for a reason that has nothing to do with the arithmetic:
 * `sub` ABSENT and `sub: 0` are different JSON. The recompute assigned
 * unconditionally, so it materialised keys that were not there, the slice
 * signature changed, and the job read dirty. A job created by lead→job convert
 * carries no `sub` key at all (see the newJob blob in js/estimate-editor.js),
 * so this fired on the first open of every converted job.
 *
 * The runtime tests below prove the MECHANISM against the real dirty set in
 * js/app.js. The source tests pin the fix in js/jobs.js, which is a bare IIFE
 * with no export seam — the same approach test/job-delete-order.test.js takes,
 * and for the same reason.
 * ────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const { makeServer, boot, settle, jobRow } = require('./helpers/save-harness');

const JOBS_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'jobs.js'), 'utf8');

beforeEach(() => { jest.useRealTimers(); });

/* The shape a lead→job convert actually produces: no `sub` on the job, one
 * seeded "Base Contract" scope, no buildings. */
function convertedJob(id) {
  const j = jobRow(id, {
    // convert stamps pctComplete: 0, and its single seeded scope is 0% — so a
    // faithful recompute lands on the same number. That agreement is the point:
    // the ONLY thing the old code changed here was the shape of the JSON.
    pctComplete: 0,
    phases: [{
      id: 'p1', jobId: id, buildingId: null, phase: 'Base Contract',
      pctComplete: 0, materials: 0, labor: 0, equipment: 0,
      asSoldRevenue: 75369.23, asSoldPhaseBudget: 75369.23, phaseBudget: 75369.23
    }]
  });
  delete j.sub;
  return j;
}

describe('the mechanism, against the real dirty set', () => {
  test('materialising an absent key marks the job dirty — this is what the old code did', async () => {
    const server = makeServer();
    server.seedJob('j1', convertedJob('j1'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();
    expect(window.p86SaveState().jobIds).toEqual([]);

    // The pre-fix recompute, verbatim: assign regardless.
    window.appData.jobs[0].sub = 0;
    window.appData.phases[0].sub = 0;

    // Nothing changed in any number a human can see, and the job is dirty.
    expect(window.p86SaveState().jobIds).toEqual(['j1']);
  });

  test('the post-fix recompute leaves an untouched job CLEAN', async () => {
    const server = makeServer();
    server.seedJob('j1', convertedJob('j1'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();

    // What js/jobs.js now does: assign only on a real change, with absent and
    // zero meaning the same number.
    const setIfChanged = (o, k, v) => { if ((o[k] || 0) !== v) o[k] = v; };
    setIfChanged(window.appData.jobs[0], 'sub', 0);
    setIfChanged(window.appData.phases[0], 'sub', 0);
    setIfChanged(window.appData.jobs[0], 'pctComplete', 0);

    expect(window.p86SaveState().jobIds).toEqual([]);
  });

  test('a derived value that GENUINELY differs still goes dirty and still pushes', async () => {
    // The narrowing must not swallow real corrections. The jobs-list % sort and
    // the progress filter read the stored value, so a stale one is a defect.
    const server = makeServer();
    server.seedJob('j1', convertedJob('j1'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();

    const setIfChanged = (o, k, v) => { if ((o[k] || 0) !== v) o[k] = v; };
    setIfChanged(window.appData.jobs[0], 'pctComplete', 62.5);
    expect(window.p86SaveState().jobIds).toEqual(['j1']);

    window.p86FlushSave();
    await settle(20);
    expect(server.jobs.get('j1').data.pctComplete).toBe(62.5);
  });
});

describe('the fix, in js/jobs.js', () => {
  const code = JOBS_SRC.replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

  test('recalcSubCosts assigns only on a real change', () => {
    const fn = code.slice(code.indexOf('function recalcSubCosts('),
                          code.indexOf('window.invalidateSubCostCache'));
    expect(fn.length).toBeGreaterThan(400);
    expect(fn).toMatch(/const setIfChanged = \(obj, key, v\) => \{ if \(\(obj\[key\] \|\| 0\) !== v\) obj\[key\] = v; \};/);
    // The three unconditional assignments that made opening a job a write.
    expect(fn).not.toMatch(/p\.sub = getSubCostForPhase/);
    expect(fn).not.toMatch(/b\.sub = getSubCostForBuilding/);
    expect(fn).not.toMatch(/job\.sub = appData\.subs\.filter/);
  });

  test("renderJobDetail's % complete write is conditional too", () => {
    expect(code).toMatch(/if \(\(job\.pctComplete \|\| 0\) !== _pct\) job\.pctComplete = _pct;/);
    expect(code).not.toMatch(/job\.pctComplete = Math\.round\(calcJobPctComplete\(jobId\) \* 10\) \/ 10;/);
  });

  test('there is no second, unfixed copy of the derived-write block', () => {
    // prepJobForView was exactly that: an unreferenced duplicate, not exported
    // and not called anywhere in the repo, sitting one wire-up away from
    // reopening this. A fix that has to be applied twice gets applied once.
    expect(JOBS_SRC).not.toMatch(/function prepJobForView\(/);
    const roots = ['js', 'server'];
    for (const root of roots) {
      for (const f of fs.readdirSync(path.join(__dirname, '..', root))) {
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(__dirname, '..', root, f), 'utf8');
        expect(src.replace(/\/\/.*$/gm, '')).not.toMatch(/prepJobForView\s*\(/);
      }
    }
  });

  test('the recompute still RUNS on open — narrowing the write is not skipping it', () => {
    expect(code).toMatch(/recalcSubCosts\(jobId, \{ force: true \}\)/);
    expect(code).toMatch(/getSubCostForPhase\(p\.id\)/);
    expect(code).toMatch(/getSubCostForBuilding\(b\.id, jobId\)/);
  });
});
