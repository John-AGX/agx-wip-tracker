/* ──────────────────────────────────────────────────────────────────────────
 * The Jobs list sort (js/jobs-sort.js).
 *
 * The things a user would notice going wrong, one test each:
 *  - "Newest/Oldest first" disagreeing with the Created column it stands for;
 *  - blanks jumping to the top when the direction flips;
 *  - RV999 landing after RV2044, or Status sorting alphabetically;
 *  - % complete / PM sorting on stored copies the row does not display;
 *  - a header click switching sorting OFF (the server's heap order), or a
 *    click on "Job # / Name" swapping a Name sort for job number;
 *  - the list reshuffling between reloads when keys tie.
 * (How Created itself is chosen — Buildertrend's date over the sync's — is
 * test/bt-created-dates-jobs.test.js.)
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const S = require('../js/jobs-sort.js');

const ids = (list) => list.map((j) => j.id);

describe('sorting', () => {
  const JOBS = [
    { id: 'a', jobNumber: 'RV2044', title: 'zulu Towers', status: 'Backlog', client: 'beta', created: '2026-01-01T00:00:00.000Z', startDate: '2026-02-01' },
    { id: 'b', jobNumber: 'RV999', title: 'Alpha Court', status: 'New', client: 'Alpha', created: '2026-05-01T00:00:00.000Z', startDate: '' },
    { id: 'c', jobNumber: 'M0027', title: 'Mid Plaza', status: 'Completed', client: '', created: null, startDate: '2025-12-31T05:00:00.000Z' },
    { id: 'd', jobNumber: '', title: '', status: 'In Progress', client: 'gamma', created: '2025-06-01T00:00:00.000Z' },
  ];
  const created = (j) => j.created;

  test('Newest and Oldest first read the Created instant — a job with none is LAST both ways', () => {
    expect(ids(S.sort(JOBS, 'created-desc', { created }))).toEqual(['b', 'a', 'd', 'c']);
    expect(ids(S.sort(JOBS, 'created-asc', { created }))).toEqual(['d', 'a', 'b', 'c']);
    // Unparseable is unknown, not 1970.
    expect(ids(S.sort([{ id: 'x', created: 'soon' }, { id: 'y', created: '2020-01-01T00:00:00Z' }], 'created-asc', { created }))).toEqual(['y', 'x']);
  });

  test('Synced reads its own instant, not the creation date', () => {
    const jobs = [{ id: 'p', synced: null, created: '2020-01-01T00:00:00Z' }, { id: 'q', synced: '2026-09-25T12:00:00Z' }];
    expect(ids(S.sort(jobs, 'synced-desc', { synced: (j) => j.synced, created }))).toEqual(['q', 'p']);
  });

  test('Name sorts by the TITLE, case-insensitively; a nameless job is last', () => {
    expect(ids(S.sort(JOBS, 'name-asc'))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(S.sort(JOBS, 'name-desc'))).toEqual(['a', 'c', 'b', 'd']);
  });

  test('Job number collates digits as numbers: RV999 before RV2044', () => {
    expect(ids(S.sort(JOBS, 'number-asc'))).toEqual(['c', 'b', 'a', 'd']);
  });

  test('Status follows the lifecycle, not the alphabet', () => {
    expect(ids(S.sort(JOBS, 'status-asc'))).toEqual(['b', 'a', 'd', 'c']);   // New, Backlog, In Progress, Completed
  });

  test('Start date compares the written calendar day; blanks last', () => {
    expect(ids(S.sort(JOBS, 'start-desc'))).toEqual(['a', 'c', 'b', 'd']);
    expect(ids(S.sort(JOBS, 'start-asc'))).toEqual(['c', 'a', 'b', 'd']);
  });

  test('money and % read the DISPLAYED WIP, once per job', () => {
    const W = { a: { totalIncome: 100, pctComplete: 90 }, b: { totalIncome: '2500', pctComplete: 10 }, c: { totalIncome: null }, d: { totalIncome: 0, pctComplete: 50 } };
    let calls = 0;
    const wip = (j) => { calls++; return W[j.id]; };
    expect(ids(S.sort(JOBS, 'contract-desc', { wip }))).toEqual(['b', 'a', 'd', 'c']);   // null last; 0 is a value
    expect(calls).toBe(4);
    expect(ids(S.sort(JOBS, 'pctcomplete-desc', { wip }))).toEqual(['a', 'd', 'b', 'c']);
  });

  test('PM and Market read what the row shows, through the callbacks', () => {
    const owner = (j) => ({ a: 'Ann', b: 'Zed', c: 'Mo', d: '' })[j.id];
    expect(ids(S.sort(JOBS, 'pm-asc', { owner }))).toEqual(['a', 'c', 'b', 'd']);
  });

  test('ties break on job number, then id — never on arrival order', () => {
    const tied = [{ id: 'z', jobNumber: 'S2' }, { id: 'y', jobNumber: 'S10' }, { id: 'x', jobNumber: 'S2' }];
    expect(ids(S.sort(tied, 'client-asc'))).toEqual(['x', 'z', 'y']);
    expect(ids(S.sort(tied.slice().reverse(), 'client-asc'))).toEqual(['x', 'z', 'y']);
  });

  test('the input array is not reordered', () => {
    const before = ids(JOBS);
    S.sort(JOBS, 'name-desc');
    expect(ids(JOBS)).toEqual(before);
  });
});

describe('the one sort state', () => {
  test('an unknown or stale id is the default, never nothing', () => {
    expect(S.spec('nope').id).toBe(S.DEFAULT_ID);
    expect(S.spec(undefined).id).toBe('created-desc');
    expect(S.spec('added-desc').id).toBe('created-desc');   // a name that never shipped
  });

  test('a header click is two-state: text starts A–Z, money and dates start high', () => {
    expect(S.headerNext('created-desc', 'client')).toBe('client-asc');
    expect(S.headerNext('client-asc', 'client')).toBe('client-desc');
    expect(S.headerNext('client-desc', 'client')).toBe('client-asc');       // no third "off" click
    expect(S.headerNext('name-asc', 'contract')).toBe('contract-desc');
    expect(S.headerNext('contract-desc', 'created')).toBe('created-desc');
    expect(S.headerNext('created-desc', 'created')).toBe('created-asc');
    expect(S.headerNext('created-desc', 'synced')).toBe('synced-desc');
    // "Job # / Name" sorts by the number, which is what the cell leads with.
    expect(S.headerNext('created-desc', 'name')).toBe('number-asc');
    expect(S.headerNext('number-asc', 'name')).toBe('number-desc');
    // …but a NAME sort already shows its chevron on that header, so a click
    // there reverses the name sort — it must not swap to job number under a
    // chevron that did not move.
    expect(S.headerNext('name-asc', 'name')).toBe('name-desc');
    expect(S.headerNext('name-desc', 'name')).toBe('name-asc');
    expect(S.headerNext('created-desc', 'unknown-col')).toBe('created-desc');
  });

  test('the chevron lands on the column that sort belongs to (or nowhere)', () => {
    expect(S.headerMark('name-desc')).toEqual({ th: 'name', dir: 'desc' });
    expect(S.headerMark('number-asc')).toEqual({ th: 'name', dir: 'asc' });
    expect(S.headerMark('created-asc')).toEqual({ th: 'created', dir: 'asc' });
    expect(S.headerMark('synced-desc')).toEqual({ th: 'synced', dir: 'desc' });
    expect(S.headerMark('start-desc')).toBeNull();
  });

  test('the select always carries the sort the list is in', () => {
    const menu = S.menuFor('created-desc').map((s) => s.id);
    expect(menu).toEqual(expect.arrayContaining(['created-desc', 'created-asc', 'name-asc', 'name-desc']));
    expect(menu).not.toContain('client-asc');
    expect(S.menuFor('client-asc').map((s) => s.id)).toContain('client-asc');
  });

  test('remembered per browser, whitelisted on read, and a throwing store is survived', () => {
    const mem = {};
    const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; } };
    S.save('margin-desc', store);
    expect(mem[S.STORAGE_KEY]).toBe('margin-desc');
    expect(S.load(store)).toBe('margin-desc');
    mem[S.STORAGE_KEY] = 'margin-sideways';
    expect(S.load(store)).toBe('created-desc');
    S.save('not-a-sort', store);
    expect(mem[S.STORAGE_KEY]).toBe('margin-sideways');                     // refused, not written
    const boom = { getItem() { throw new Error('quota'); }, setItem() { throw new Error('quota'); } };
    expect(S.load(boom)).toBe('created-desc');
    expect(() => S.save('name-asc', boom)).not.toThrow();
  });

  test('every id is <key>-<asc|desc> and every label is unique', () => {
    const labels = new Set();
    for (const s of S.SORTS) {
      expect(s.id).toMatch(/^[a-z]+-(asc|desc)$/);
      expect(labels.has(s.label)).toBe(false);
      labels.add(s.label);
    }
  });
});
