/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * "WHAT IS STILL OPEN IN BUILDERTREND?" — on the Jobs list.
 *
 * Buildertrend's own word for a job is stored by the sync as data.btStatus and
 * reaches the client flattened onto the job. P86's status is a SEPARATE
 * opinion and the two disagree on purpose (a job Open in Buildertrend can be
 * On Hold here, and one live job is), so this is its own filter facet and its
 * own sort — not a re-reading of j.status.
 *
 * Both run the REAL code: js/jobs-sort.js as shipped, and jobsBtStatusOptions
 * / matchesJobDrawer / getFilteredJobs lifted out of js/jobs.js, so what is
 * asserted is what the list does.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lf = (s) => s.replace(/\r\n/g, '\n');
const JOBS_SRC = lf(fs.readFileSync(path.join(ROOT, 'js', 'jobs.js'), 'utf8'));
const SORT = require('../js/jobs-sort.js');

function lift(open, close) {
  const i = JOBS_SRC.indexOf(open);
  if (i < 0) throw new Error('not found: ' + open);
  const j = JOBS_SRC.indexOf(close, i);
  if (j < 0) throw new Error('end not found: ' + close);
  return JOBS_SRC.slice(i, j + close.length);
}

// A portfolio with every shape that matters: Buildertrend's three words, a
// word it might add later, a job it has never heard of, and the two
// disagreements — Open there / On Hold here, and Open there / Archived here.
const JOBS = [
  { id: '1', jobNumber: 'RV0101', title: 'Open both sides', status: 'In Progress', jobType: 'Renovation', btStatus: 'Open' },
  { id: '2', jobNumber: 'RV0102', title: 'Open there, on hold here', status: 'On Hold', jobType: 'Renovation', btStatus: 'Open' },
  { id: '3', jobNumber: 'RV0103', title: 'Open there, ARCHIVED here', status: 'Archived', jobType: 'Renovation', btStatus: 'Open' },
  { id: '4', jobNumber: 'WR0104', title: 'Warranty', status: 'Warranty', jobType: 'Service', btStatus: 'Warranty' },
  { id: '5', jobNumber: 'CL0105', title: 'Closed', status: 'Completed', jobType: 'Renovation', btStatus: 'Closed' },
  { id: '6', jobNumber: 'NB0106', title: 'Never in Buildertrend', status: 'In Progress', jobType: 'Work Order', btStatus: '' },
  { id: '7', jobNumber: 'XX0107', title: 'A word BT added later', status: 'In Progress', jobType: 'Service', btStatus: 'On hold' }
];

// ── the shipped sort module ──────────────────────────────────────────────
describe('the sort ranks Buildertrend\'s word, not ours', () => {
  const ids = (id) => SORT.sort(JOBS, id).map((j) => j.id);

  test('"Open first" puts every Buildertrend-open job at the top', () => {
    const order = ids('btstatus-asc');
    expect(order.slice(0, 3).sort()).toEqual(['1', '2', '3']);
  });

  test('then warranty, then closed, then any word Buildertrend adds later', () => {
    const order = ids('btstatus-asc');
    expect(order.indexOf('4')).toBeLessThan(order.indexOf('5'));   // warranty before closed
    expect(order.indexOf('5')).toBeLessThan(order.indexOf('7'));   // closed before the unknown word
  });

  test('a job Buildertrend has never heard of sorts LAST in BOTH directions', () => {
    // Reversing "Open first" must not mean "the jobs with no Buildertrend
    // record at all, first" — they are not an answer to this question.
    expect(ids('btstatus-asc').slice(-1)).toEqual(['6']);
    expect(ids('btstatus-desc').slice(-1)).toEqual(['6']);
  });

  test('"Open last" really reverses the known words', () => {
    const order = ids('btstatus-desc');
    expect(order.indexOf('5')).toBeLessThan(order.indexOf('4'));   // closed before warranty
    expect(order.indexOf('4')).toBeLessThan(order.indexOf('1'));   // warranty before open
  });

  test('it is offered in the toolbar menu, where a phone can reach it', () => {
    // The thead is display:none under 640px, so a sort that is not in the
    // select does not exist on a phone.
    const menu = SORT.menuFor(SORT.DEFAULT_ID).filter((s) => s.key === 'btstatus');
    expect(menu.map((s) => s.id)).toEqual(['btstatus-asc']);
    expect(menu[0].label).toMatch(/Buildertrend/);
    expect(SORT.valid('btstatus-asc')).toBe(true);
    expect(SORT.valid('btstatus-desc')).toBe(true);
  });

  test('the word is read case- and space-insensitively', () => {
    const odd = [{ id: 'a', jobNumber: 'A', btStatus: '  OPEN ' }, { id: 'b', jobNumber: 'B', btStatus: 'closed' }];
    expect(SORT.sort(odd, 'btstatus-asc').map((j) => j.id)).toEqual(['a', 'b']);
    expect(SORT.btWord({ btStatus: '  Open ' })).toBe('open');
    expect(SORT.btWord({})).toBe('');
  });

  test('the sort does NOT fall back to the P86 status column', () => {
    // j.status and j.btStatus are different opinions; ranking by ours would
    // put the On Hold job below Completed ones and answer the wrong question.
    const byUs = [...JOBS].sort((a, b) => String(a.status).localeCompare(String(b.status))).map((j) => j.id);
    expect(ids('btstatus-asc')).not.toEqual(byUs);
    expect(ids('btstatus-asc').indexOf('2')).toBeLessThan(ids('btstatus-asc').indexOf('5'));
  });
});

// ── the filter facet, lifted out of the list ─────────────────────────────
function listEnv(drawer, over) {
  const win = {
    p86JobsSort: SORT,
    p86FilterDrawer: {
      resolveNumRange: () => ({ min: null, max: null }),
      countActive: () => 0,
      emptyValues: () => ({})
    },
    p86MarketFilter: null
  };
  const src = [
    lift('function jobsBtStatusOptions() {', '\n        }'),
    lift('function matchesJobDrawer(j, d) {', '\n        }'),
    lift('function getFilteredJobs() {', '\n        }'),
    'return { jobsBtStatusOptions: jobsBtStatusOptions, matchesJobDrawer: matchesJobDrawer, getFilteredJobs: getFilteredJobs };'
  ].join('\n');
  // The few globals those three touch.
  const fn = new Function('window', 'appData', 'appState', '_jobsDrawer', 'getJobOwnerName', 'getJobWIP',
    '_jobAddr', 'getJobTypeLabel', 'getJobType', src);
  return fn(
    win,
    { jobs: (over && over.jobs) || JOBS },
    Object.assign({ currentStatusFilter: '', currentTypeFilter: '' }, over && over.appState),
    drawer,
    () => '—', () => ({}), () => ({}), () => '', () => ''
  );
}

describe('the filter facet offers what the data actually holds', () => {
  test('Buildertrend\'s own words, in the order anybody asks about them', () => {
    const opts = listEnv(null).jobsBtStatusOptions();
    expect(opts.slice(0, 3)).toEqual([
      { v: 'open', label: 'Open' },
      { v: 'warranty', label: 'Warranty' },
      { v: 'closed', label: 'Closed' }
    ]);
  });

  test('a word Buildertrend adds later still gets a chip', () => {
    // Hard-coding three words would make a fourth silently unfilterable.
    const opts = listEnv(null).jobsBtStatusOptions().map((o) => o.v);
    expect(opts).toContain('on hold');
  });

  test('"Not in Buildertrend" is offered only when such a job exists', () => {
    expect(listEnv(null).jobsBtStatusOptions().map((o) => o.v)).toContain('__none');
    const allSynced = JOBS.filter((j) => j.btStatus);
    const opts = listEnv(null, { jobs: allSynced }).jobsBtStatusOptions().map((o) => o.v);
    expect(opts).not.toContain('__none');
  });

  test('a word no job carries is not offered', () => {
    const onlyOpen = [{ id: 'z', jobNumber: 'Z', btStatus: 'Open' }];
    expect(listEnv(null, { jobs: onlyOpen }).jobsBtStatusOptions()).toEqual([{ v: 'open', label: 'Open' }]);
  });
});

describe('filtering to Buildertrend-open', () => {
  const openOnly = { btStatus: ['open'] };

  test('keeps exactly the jobs Buildertrend calls open', () => {
    const env = listEnv(openOnly);
    expect(JOBS.filter((j) => env.matchesJobDrawer(j, openOnly)).map((j) => j.id)).toEqual(['1', '2', '3']);
  });

  test('including one ARCHIVED here — the disagreement is the point', () => {
    // getFilteredJobs hides Archived by default; asking Buildertrend's question
    // must not hide the job whose answer differs most.
    const env = listEnv(openOnly);
    expect(env.getFilteredJobs().map((j) => j.id)).toEqual(['1', '2', '3']);
  });

  test('with no Buildertrend facet, Archived stays hidden as before', () => {
    const env = listEnv(null);
    expect(env.getFilteredJobs().map((j) => j.id)).not.toContain('3');
  });

  test('"Not in Buildertrend" selects the jobs with no word at all', () => {
    const d = { btStatus: ['__none'] };
    const env = listEnv(d);
    expect(JOBS.filter((j) => env.matchesJobDrawer(j, d)).map((j) => j.id)).toEqual(['6']);
  });

  test('two chips are an OR, and the facet ANDs with the rest of the drawer', () => {
    const env = listEnv(null);
    const both = { btStatus: ['open', 'warranty'] };
    expect(JOBS.filter((j) => env.matchesJobDrawer(j, both)).map((j) => j.id)).toEqual(['1', '2', '3', '4']);
    const withType = { btStatus: ['open'], jobType: 'Renovation' };
    expect(JOBS.filter((j) => env.matchesJobDrawer(j, withType)).map((j) => j.id)).toEqual(['1', '2', '3']);
    const narrow = { btStatus: ['open'], jobType: 'Service' };
    expect(JOBS.filter((j) => env.matchesJobDrawer(j, narrow))).toEqual([]);
  });

  test('no facet means no filtering (an empty chip list is not "nothing matches")', () => {
    const env = listEnv(null);
    expect(JOBS.filter((j) => env.matchesJobDrawer(j, {})).length).toBe(JOBS.length);
    expect(JOBS.filter((j) => env.matchesJobDrawer(j, { btStatus: [] })).length).toBe(JOBS.length);
  });

  test('the facet and the sort read the SAME word through the same function', () => {
    // Two spellings of "open" would let the filter keep a job the sort ranks
    // as unknown. jobs.js delegates to the sort module for exactly that reason.
    expect(JOBS_SRC).toMatch(/window\.p86JobsSort\s*\?\s*window\.p86JobsSort\.btWord\(j\)/);
    expect(JOBS_SRC).toMatch(/jobsBtStatusOptions\(\)/);
  });
});

describe('it is wired into the list the user sees', () => {
  test('the drawer declares the facet, so it renders and is saved into a view', () => {
    // Saved views store the drawer wholesale, so a "BT Open" view needs only
    // the field to exist here.
    expect(JOBS_SRC).toMatch(/\{ key: 'btStatus', label: 'Buildertrend', type: 'chips', options: jobsBtStatusOptions\(\) \}/);
  });

  test('both files ship behind bumped cache-busters', () => {
    const INDEX = lf(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    const sort = INDEX.match(/js\/jobs-sort\.js\?v=(\d+)/);
    const jobs = INDEX.match(/js\/jobs\.js\?v=(\d+)/);
    expect(sort).toBeTruthy();
    expect(jobs).toBeTruthy();
    expect(Number(sort[1])).toBeGreaterThanOrEqual(2);
    expect(Number(jobs[1])).toBeGreaterThanOrEqual(266);
  });
});
