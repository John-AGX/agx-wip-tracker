// test/job-archive-restores-status.test.js — archiving a job and putting it
// back must not rewrite its status.
//
// There are FOUR archive doors and THREE restore doors, and they used to give
// three different answers:
//
//   services/clickr/reconcile-merge.js  stashes data.btArchivedFromStatus on
//                                       archive and puts it back on restore;
//   js/jobs.js archiveCurrentJob()      Unarchive → hardcoded 'Completed';
//   js/jobs.js restoreJob()             Restore   → hardcoded 'In Progress'.
//
// So a Warranty job archived from either UI surface came back as something
// else — and so did a Backlog, New or On Hold job, silently, for as long as
// those statuses have existed. The two UI doors now use the same stash slot as
// the sync does, so an archive through one door restores correctly through any.
//
// Driven, not modelled: the function TEXT is lifted out of js/jobs.js and
// evaluated with its free variables injected (test/helpers/browser-fn.js), so
// a change inside either function changes what this test runs.

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'jobs.js'), 'utf8');

function harness() {
  const calls = { saved: 0, painted: [] };
  const appData = { jobs: [] };
  const appState = { currentJobId: null };
  const win = {
    p86Confirm: () => Promise.resolve(true),   // the archive confirm, always yes
  };
  const fns = compile(
    [extractFunction(SRC, 'archiveCurrentJob'), extractFunction(SRC, 'restoreJob')],
    ['appData', 'appState', 'window', 'saveData', 'renderJobDetail', 'renderArchivedJobs'],
    [appData, appState, win,
      () => { calls.saved++; },
      (id) => { calls.painted.push(id); },
      () => { calls.painted.push('archived-list'); }],
    '({ archiveCurrentJob, restoreJob })');
  return { appData, appState, calls, fns };
}

const STATUSES = ['New', 'Backlog', 'In Progress', 'On Hold', 'Warranty', 'Completed'];

describe('the job-detail Archive / Unarchive toggle', () => {
  test.each(STATUSES)('a %s job archived and unarchived comes back a %s job', async (status) => {
    const h = harness();
    h.appData.jobs.push({ id: 'j1', title: 'T', status: status });
    h.appState.currentJobId = 'j1';

    h.fns.archiveCurrentJob();
    await new Promise((r) => setTimeout(r, 0));   // the confirm is a promise
    expect(h.appData.jobs[0].status).toBe('Archived');
    expect(h.appData.jobs[0].btArchivedFromStatus).toBe(status);

    h.fns.archiveCurrentJob();                    // now the Unarchive arm
    expect(h.appData.jobs[0].status).toBe(status);
    // The stash is consumed, so a later archive cannot resurrect a stale one.
    expect('btArchivedFromStatus' in h.appData.jobs[0]).toBe(false);
  });

  test('THE MUTATION: with no stash the Unarchive arm falls back, and Warranty is lost', () => {
    // The pre-change behaviour, reproduced deliberately: this is what every job
    // archived before the stash shipped still does, and what EVERY job did
    // before it. Pins the fallback rather than leaving it undescribed.
    const h = harness();
    h.appData.jobs.push({ id: 'j1', title: 'T', status: 'Archived' });
    h.appState.currentJobId = 'j1';
    h.fns.archiveCurrentJob();
    expect(h.appData.jobs[0].status).toBe('Completed');
  });

});

describe('the Archived tab Restore button', () => {
  test.each(STATUSES)('restores a %s job to %s', async (status) => {
    const h = harness();
    h.appData.jobs.push({ id: 'j1', title: 'T', status: status });
    h.appState.currentJobId = 'j1';
    h.fns.archiveCurrentJob();
    await new Promise((r) => setTimeout(r, 0));

    h.fns.restoreJob('j1');
    expect(h.appData.jobs[0].status).toBe(status);
    expect('btArchivedFromStatus' in h.appData.jobs[0]).toBe(false);
    expect(h.calls.painted).toContain('archived-list');
  });

  test('THE MUTATION: with no stash Restore falls back to In Progress', () => {
    const h = harness();
    h.appData.jobs.push({ id: 'j1', title: 'T', status: 'Archived' });
    h.fns.restoreJob('j1');
    expect(h.appData.jobs[0].status).toBe('In Progress');
  });

  test('an unknown job id is a no-op, not a throw', () => {
    const h = harness();
    expect(() => h.fns.restoreJob('nope')).not.toThrow();
  });
});

describe('the jobs-list bulk Set status menu', () => {
  // The fourth archive door, and a first-class one since Warranty joined its
  // menu: select the Warranty jobs -> Set status -> Archived. It wrote the
  // status with no stash at all, so Restore on the Archived tab fell through to
  // its 'In Progress' fallback and the status was gone.
  function bulkHarness() {
    const appData = { jobs: [] };
    const sel = new Set();
    const win = { p86Confirm: () => Promise.resolve(true) };
    const fns = compile(
      [extractFunction(SRC, 'jobsSelectedEditable'), extractFunction(SRC, 'bulkConfirm'),
        extractFunction(SRC, 'p86JobsBulkStatus'), extractFunction(SRC, 'restoreJob')],
      ['appData', '_jobsSelected', 'window', 'saveData', 'renderJobsTable', 'renderArchivedJobs'],
      [appData, sel, win, () => {}, () => {}, () => {}],
      '({ p86JobsBulkStatus, restoreJob })');
    return { appData, sel, fns };
  }

  test.each(STATUSES)('a %s job bulk-archived and restored comes back a %s job', async (status) => {
    const h = bulkHarness();
    h.appData.jobs.push({ id: 'j1', title: 'T', status: status });
    h.sel.add('j1');
    h.fns.p86JobsBulkStatus('Archived');
    await new Promise((r) => setTimeout(r, 0));   // the confirm is a promise
    expect(h.appData.jobs[0].status).toBe('Archived');
    expect(h.appData.jobs[0].btArchivedFromStatus).toBe(status);
    // js/map-pins.js colours an archived pin off archivedAt, so it is set here
    // too — the single-job door has always set it.
    expect(typeof h.appData.jobs[0].archivedAt).toBe('string');

    h.fns.restoreJob('j1');
    expect(h.appData.jobs[0].status).toBe(status);
    expect('btArchivedFromStatus' in h.appData.jobs[0]).toBe(false);
  });

  test('every other bulk status is an ordinary write: no stash, no archivedAt', async () => {
    const h = bulkHarness();
    h.appData.jobs.push({ id: 'j1', title: 'T', status: 'Warranty' });
    h.sel.add('j1');
    h.fns.p86JobsBulkStatus('On Hold');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.appData.jobs[0].status).toBe('On Hold');
    expect('btArchivedFromStatus' in h.appData.jobs[0]).toBe(false);
    expect('archivedAt' in h.appData.jobs[0]).toBe(false);
  });

  test('an already-Archived job re-archived does not overwrite the stash with "Archived"', async () => {
    const h = bulkHarness();
    h.appData.jobs.push({ id: 'j1', title: 'T', status: 'Archived', btArchivedFromStatus: 'Warranty' });
    h.sel.add('j1');
    h.fns.p86JobsBulkStatus('Archived');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.appData.jobs[0].btArchivedFromStatus).toBe('Warranty');
  });
});

describe('the SAME stash slot the Buildertrend sync uses', () => {
  test('services/clickr/reconcile-merge.js reads and writes data.btArchivedFromStatus', () => {
    // If these two drifted apart, a job archived by the sync and restored in the
    // UI (or the reverse) would lose its status again — the exact bug, moved.
    const rm = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'clickr', 'reconcile-merge.js'), 'utf8');
    expect(rm).toMatch(/d\.btArchivedFromStatus = d\.status \|\| '';/);
    expect(rm).toMatch(/d\.status = d\.btArchivedFromStatus \|\| 'In Progress';/);
    expect(SRC).toMatch(/job\.btArchivedFromStatus = job\.status \|\| '';/);
    expect((SRC.match(/delete job\.btArchivedFromStatus;/g) || []).length).toBe(2);
    // FOUR archive doors write the slot: archiveCurrentJob, the bulk menu, the
    // Job Information edit card, and the sync. A door added without it is the
    // whole bug again.
    expect((SRC.match(/btArchivedFromStatus = (job|j)\.status \|\| '';/g) || []).length).toBe(3);
  });
});

describe('the badge class, executed', () => {
  const jobStatusBadgeClass = compile(
    [extractFunction(SRC, 'jobStatusBadgeClass')], [], [], 'jobStatusBadgeClass');

  test.each([
    ['On Hold', 'at-risk'],
    ['Warranty', 'warranty'],
    ['Completed', 'on-track'],
    ['Archived', 'not-started'],
    ['In Progress', 'on-track'],
    ['New', 'on-track'],
    ['Backlog', 'on-track'],
  ])('%s -> .badge %s', (status, cls) => {
    expect(jobStatusBadgeClass(status)).toBe(cls);
  });

  test('Warranty is NOT the in-progress class — the whole point of the helper', () => {
    expect(jobStatusBadgeClass('Warranty')).not.toBe(jobStatusBadgeClass('In Progress'));
  });

  test('null / undefined / a nonsense status still returns a class, never throws', () => {
    expect(jobStatusBadgeClass(null)).toBe('on-track');
    expect(jobStatusBadgeClass(undefined)).toBe('on-track');
    expect(jobStatusBadgeClass('Something Else')).toBe('on-track');
  });
});
