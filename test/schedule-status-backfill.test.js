/**
 * @jest-environment jsdom
 */
// test/schedule-status-backfill.test.js — a job STATUS added after a user last
// saved must not hide their jobs.
//
// The Schedule board's status pill bar reads a per-user object out of
// localStorage. A key that is not in that object reads `undefined` → falsy →
// every job carrying that status is filtered out of BOTH the board and the
// draggable jobs list, with the pill rendering unlit and no way to tell the
// difference between "you turned this off" and "this key did not exist when you
// last saved". That is exactly the bug js/schedule.js's jobTypeFilter backfill
// was written to fix; Warranty needs the same treatment on the status bar.
//
// The `_anyOn` guard is load-bearing and is tested on its own: "every pill off"
// is WILDCARD on this bar (filteredJobs only narrows when something is on), so
// seeding one key `true` for a user in that state converts show-everything into
// a single-status filter that hides every other job — strictly worse than the
// bug being fixed.

const sched = require('../js/schedule.js');
const KEY = sched.SETTINGS_KEY;

// The six keys that existed before Warranty — what every existing user has in
// localStorage right now.
const LEGACY = ['New', 'In Progress', 'Backlog', 'On Hold', 'Completed', 'Archived'];

function save(o) { window.localStorage.setItem(KEY, JSON.stringify(o)); }

beforeEach(() => { window.localStorage.clear(); });

describe('Warranty is an offered status filter', () => {
  test('it is in the pill list and on by default', () => {
    expect(sched.STATUS_FILTERS).toContain('Warranty');
    expect(sched.DEFAULT_STATUS_SET['Warranty']).toBe(true);
  });

  test('the two independently authored copies of the default agree', () => {
    // loadSettings() carries its OWN literal copy of the default statusFilter.
    // They diverge silently: one is used for a first-ever save, the other for
    // the per-key backfill's value.
    const fresh = sched.loadSettings().statusFilter;
    sched.STATUS_FILTERS.forEach((k) => {
      expect([k, fresh[k] === true]).toEqual([k, sched.DEFAULT_STATUS_SET[k] === true]);
    });
  });

  test('every status the pill bar offers is a status the jobs UI can set', () => {
    // Not vacuous: a pill for a status nothing can produce is dead, and a
    // status nothing offers cannot be filtered back on.
    expect(sched.STATUS_FILTERS).toEqual(
      ['New', 'In Progress', 'Backlog', 'On Hold', 'Warranty', 'Completed', 'Archived']);
  });
});

describe('a legacy saved statusFilter is healed PER KEY, not only when absent', () => {
  test('a legacy save with the six old keys gains Warranty: true', () => {
    const legacy = {};
    LEGACY.forEach((k) => { legacy[k] = k === 'New' || k === 'In Progress'; });
    save({ statusFilter: legacy });
    const s = sched.loadSettings();
    // Without the per-key heal this is `undefined` → falsy → every Warranty job
    // is absent from the board and there is no lit pill to explain it.
    expect(s.statusFilter['Warranty']).toBe(true);
    // The user's own choices are untouched.
    expect(s.statusFilter['New']).toBe(true);
    expect(s.statusFilter['On Hold']).toBe(false);
    expect(s.statusFilter['Completed']).toBe(false);
  });

  test('an explicit Warranty: false is a real choice and is NOT re-seeded', () => {
    save({ statusFilter: { 'New': true, 'In Progress': true, 'Warranty': false } });
    expect(sched.loadSettings().statusFilter['Warranty']).toBe(false);
  });

  test('an ALL-OFF filter is WILDCARD and is left completely alone', () => {
    const allOff = {};
    LEGACY.forEach((k) => { allOff[k] = false; });
    save({ statusFilter: allOff });
    const s = sched.loadSettings();
    // Seeding one key true here would turn "show every job" into "show only
    // Warranty jobs" and hide everything this user can see today.
    expect(Object.keys(s.statusFilter).some((k) => s.statusFilter[k] === true)).toBe(false);
    expect(s.statusFilter['Warranty']).toBeUndefined();
  });

  test('a missing statusFilter object still seeds the whole default', () => {
    save({ showWeekends: false });
    const s = sched.loadSettings();
    sched.STATUS_FILTERS.forEach((k) => {
      expect([k, s.statusFilter[k] === true]).toEqual([k, sched.DEFAULT_STATUS_SET[k] === true]);
    });
  });
});

describe('the filter itself: a Warranty job passes a healed filter and a wildcard', () => {
  const jobs = [
    { id: 'j1', status: 'Warranty', jobType: 'Renovation' },
    { id: 'j2', status: 'In Progress', jobType: 'Renovation' },
    { id: 'j3', status: 'Completed', jobType: 'Renovation' },
  ];

  function withJobs(fn) {
    const had = window.appData;
    window.appData = { jobs: jobs };
    try { return fn(); } finally { window.appData = had; }
  }

  test('a healed legacy save shows the Warranty job', () => {
    const legacy = {};
    LEGACY.forEach((k) => { legacy[k] = k === 'In Progress'; });
    save({ statusFilter: legacy, jobTypeFilter: {} });
    sched._state.settings = sched.loadSettings();
    const ids = withJobs(() => sched.filteredJobs().map((j) => j.id));
    expect(ids.sort()).toEqual(['j1', 'j2']);
  });

  test('THE MUTATION: with Warranty absent from the saved object it vanishes', () => {
    // Proves the heal is what carries the job, not the filter being lenient.
    const legacy = {};
    LEGACY.forEach((k) => { legacy[k] = k === 'In Progress'; });
    save({ statusFilter: legacy, jobTypeFilter: {} });
    const s = sched.loadSettings();
    delete s.statusFilter['Warranty'];
    sched._state.settings = s;
    const ids = withJobs(() => sched.filteredJobs().map((j) => j.id));
    expect(ids).toEqual(['j2']);
  });

  test('an all-off (wildcard) filter shows every job, Warranty included', () => {
    const allOff = {};
    LEGACY.forEach((k) => { allOff[k] = false; });
    save({ statusFilter: allOff, jobTypeFilter: {} });
    sched._state.settings = sched.loadSettings();
    const ids = withJobs(() => sched.filteredJobs().map((j) => j.id));
    expect(ids.sort()).toEqual(['j1', 'j2', 'j3']);
  });
});
