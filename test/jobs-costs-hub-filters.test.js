/**
 * @jest-environment jsdom
 */
// DETAILED COSTS — FILTERS, SORT AND SAVED VIEWS.
//
// John, 2026-10-02: "on the detailed cost tab, we need to add views and
// filters for sorting by job type, PM etc." He was looking at 434 jobs and
// 3,777 cost lines with one search box.
//
// The thing that makes this page different from its neighbours in the hub is
// that NONE of the words he used are on the data being displayed. A row here
// is a cost aggregate keyed by job id; the type, the PM, the market and the
// status all have to be fetched off the job record. So the tests that matter
// are: do the filters read the right field, do they offer only values that
// are actually on screen, and does the sort order the number it claims to.
//
// The real jobs-hub.js is evaluated in jsdom and driven through the seam it
// publishes, so a change to the shipped file changes this test.

'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'jobs-hub.js'), 'utf8');

const JOBS = [
  { id: 'j1', jobNumber: 'RV2013', title: 'Saddlebrook Ext Paint & Repairs Cluster 9', pm: 'John Thilking', jobType: 'Renovation', status: 'In Progress', market: 'Tampa', client: 'Saddlebrook Resort' },
  { id: 'j2', jobNumber: 'RV2012', title: 'Saddlebrook Ext Paint & Repairs Cluster 8', pm: 'John Thilking', jobType: 'Renovation', status: 'In Progress', market: 'Tampa', client: 'Saddlebrook Resort' },
  { id: 'j3', jobNumber: 'RV2017', title: 'Saddlebrook Ext Paint & Repairs Cluster 4', pm: 'Lena Ortiz', jobType: 'Renovation', status: 'Warranty', market: 'Tampa', client: 'Saddlebrook Resort' },
  { id: 'j4', jobNumber: 'S2423', title: 'Saddlebrook Cluster 1 & 5 Roof Wash', pm: 'Lena Ortiz', jobType: 'Service', status: 'In Progress', market: 'Tampa', client: 'Saddlebrook Resort' },
  { id: 'j5', jobNumber: 'M1002', title: 'Belleair Staircase & Landing Repairs', pm: 'Cody Reed', jobType: 'Mid-Tier Service', status: 'New', market: 'Orlando', client: 'BH' },
  // A job with costs but NO pm and NO market — the blob has no constraints,
  // so a row whose job is half-filled must not crash a facet or a sort.
  { id: 'j6', jobNumber: 'S2436', title: 'Heatherwood Fence Preparation & Painting', jobType: 'Service', status: 'New', client: 'Associa Gulf Coast' },
];

const ROWS = [
  { jobId: 'j1', lines: 113, total: 70402.80, subs: 113215, billed: 178215, accrual: 0, lastImport: '2026-10-02', buckets: { materials: 55755.21, labor: 9784.83, gc: 4862.76 } },
  { jobId: 'j2', lines: 59, total: 39901.00, subs: 89000, billed: 89000, accrual: 0, lastImport: '2026-10-01', buckets: { materials: 32966.69, labor: 4894.30, gc: 2040.01 } },
  { jobId: 'j3', lines: 26, total: 40861.47, subs: 0, billed: 0, accrual: 0, lastImport: '2026-09-28', buckets: { materials: 36048.23, labor: 457.98, gc: 4355.26 } },
  { jobId: 'j4', lines: 5, total: 4649.73, subs: 0, billed: 0, accrual: 0, lastImport: '2026-10-02', buckets: { materials: 563.48, labor: 4086.25 } },
  { jobId: 'j5', lines: 14, total: 7380.00, subs: 1500, billed: 0, accrual: 0, lastImport: '2026-10-02', buckets: { materials: 2200, labor: 5100, gc: 80 } },
  { jobId: 'j6', lines: 9, total: 8640.00, subs: 0, billed: 0, accrual: 0, lastImport: '2026-09-30', buckets: { materials: 7620, labor: 900, gc: 120 } },
];

let C;

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  window.appData = { jobs: JOBS.map((j) => Object.assign({}, j)) };
  window.p86CostBuckets = {
    CANON: [
      { code: 'materials', label: 'Materials & Supplies', color: '#1' },
      { code: 'labor', label: 'Labor', color: '#2' },
      { code: 'subs', label: 'Subcontractors', color: '#3' },
      { code: 'equipment', label: 'Equipment', color: '#4' },
      { code: 'gc', label: 'General Conditions', color: '#5' },
      { code: 'other', label: 'Other', color: '#6' },
    ],
    effectiveBucket: (l) => l.bucket || 'other',
    isAccrualLine: () => false,
  };
  window.p86JobLabel = { fromJob: (j) => j.jobNumber + ' ' + j.title };
  // The registry's answer wins over the free-text label — same order
  // jobTypeDisplay uses.
  window.p86JobFinalize = {
    labelForNumber: (n) => (/^RV/.test(n) ? 'Renovation' : /^M\d/.test(n) ? 'Mid-Tier Service' : /^S/.test(n) ? 'Service' : ''),
  };
  window.p86Api = { listViews: { list: () => Promise.resolve({ views: [] }) } };
  delete window.p86JobsHub;
  // eslint-disable-next-line no-eval
  window.eval(SRC);
  C = window.p86JobsHub.__costs;
  // A clean state for every test — the module keeps one per sub-page.
  Object.assign(C.state(), { q: '', type: '', pm: '', market: '', status: 'all', sort: 'counted-desc', job: '', viewId: null, _viewInit: true });
});

describe('the filters read the JOB, because none of this is on a cost row', () => {
  test('a cost row carries no type, PM, market or status of its own', () => {
    // The premise. If this ever stops being true the filters should read the
    // row directly and this whole indirection can go.
    const r = ROWS[0];
    ['pm', 'jobType', 'market', 'status'].forEach((k) => expect(r[k]).toBeUndefined());
  });

  test('type comes from the job NUMBER first, the free label second', () => {
    // data.jobType is a free string that can disagree with the number's
    // prefix; the prefix is what the registry minted, so it wins.
    expect(C.jobType({ jobNumber: 'RV2013', jobType: 'Service' })).toBe('Renovation');
    expect(C.jobType({ jobNumber: '', jobType: 'Service' })).toBe('Service');
    expect(C.jobType({ jobNumber: '437775', jobType: '' })).toBe('');
    expect(C.jobType(null)).toBe('');
  });

  test.each([
    ['pm', 'Cody Reed', ['j5']],
    ['pm', 'John Thilking', ['j1', 'j2']],
    ['type', 'Service', ['j4', 'j6']],
    ['type', 'Renovation', ['j1', 'j2', 'j3']],
    ['market', 'Orlando', ['j5']],
    ['market', 'Tampa', ['j1', 'j2', 'j3', 'j4']],
  ])('%s = %s keeps only the right jobs', (field, value, want) => {
    const st = Object.assign(C.state(), { [field]: value });
    expect(ROWS.filter((r) => C.passes(r, st)).map((r) => r.jobId)).toEqual(want);
  });

  test('status filters, and "all" means all', () => {
    expect(ROWS.filter((r) => C.passes(r, Object.assign(C.state(), { status: 'Warranty' }))).map((r) => r.jobId)).toEqual(['j3']);
    expect(ROWS.filter((r) => C.passes(r, Object.assign(C.state(), { status: 'all' })))).toHaveLength(6);
  });

  test('two filters narrow together, not instead of each other', () => {
    const st = Object.assign(C.state(), { pm: 'John Thilking', type: 'Renovation' });
    expect(ROWS.filter((r) => C.passes(r, st)).map((r) => r.jobId)).toEqual(['j1', 'j2']);
    const none = Object.assign(C.state(), { pm: 'Cody Reed', type: 'Renovation' });
    expect(ROWS.filter((r) => C.passes(r, none))).toEqual([]);
  });

  test('a job with no PM is excluded by a PM filter, not crashed over', () => {
    // j6 has no pm key at all. The blob has no constraints; half-filled rows
    // are normal and must not throw.
    const st = Object.assign(C.state(), { pm: 'Cody Reed' });
    expect(() => ROWS.filter((r) => C.passes(r, st))).not.toThrow();
    expect(ROWS.filter((r) => C.passes(r, st)).map((r) => r.jobId)).not.toContain('j6');
  });

  test('a row whose job has been deleted is not silently kept by every filter', () => {
    const orphan = { jobId: 'gone', lines: 1, total: 1, subs: 0, billed: 0, buckets: {} };
    // state() hands back the LIVE object, so each case gets its own copy —
    // assigning twice would leave the first filter on and prove nothing.
    const withPm = Object.assign({}, C.state(), { pm: 'Cody Reed' });
    const unfiltered = Object.assign({}, C.state(), { pm: '', type: '', market: '', status: 'all' });
    expect(C.passes(orphan, withPm)).toBe(false);
    // …but with nothing filtered it still shows, because its money is real.
    expect(C.passes(orphan, unfiltered)).toBe(true);
  });
});

describe('the filter lists offer only what is on screen', () => {
  test('every option is a value some row actually has', () => {
    const f = C.facets(ROWS);
    expect(f.types).toEqual(['Mid-Tier Service', 'Renovation', 'Service']);
    expect(f.pms).toEqual(['Cody Reed', 'John Thilking', 'Lena Ortiz']);
    expect(f.markets).toEqual(['Orlando', 'Tampa']);
    expect(f.statuses).toEqual(['In Progress', 'New', 'Warranty']);
  });

  test('a PM with jobs but NO costs is not offered', () => {
    // The whole point: a filter offering twelve PMs when five have costs is a
    // filter that mostly produces an empty table.
    window.appData.jobs.push({ id: 'jX', jobNumber: 'S9999', title: 'No costs yet', pm: 'Ghost PM', status: 'New' });
    expect(C.facets(ROWS).pms).not.toContain('Ghost PM');
  });

  test('blank fields do not become a blank option', () => {
    expect(C.facets(ROWS).pms.filter((x) => !x)).toEqual([]);
    expect(C.facets(ROWS).markets).not.toContain('');
  });

  test('no rows means no options, not a crash', () => {
    expect(C.facets([])).toEqual({ types: [], pms: [], markets: [], statuses: [] });
  });
});

describe('sorting orders the number it says it does', () => {
  const ids = (key) => C.sortRows(ROWS, key).map((r) => r.jobId);

  test('counted, both ways', () => {
    expect(ids('counted-desc')).toEqual(['j1', 'j3', 'j2', 'j6', 'j5', 'j4']);
    expect(ids('counted-asc')).toEqual(['j4', 'j5', 'j6', 'j2', 'j3', 'j1']);
  });

  test('job number, both ways', () => {
    expect(ids('job-asc')).toEqual(['j5', 'j2', 'j1', 'j3', 'j4', 'j6']);
    expect(ids('job-desc')).toEqual(['j6', 'j4', 'j3', 'j1', 'j2', 'j5']);
  });

  test('PM, with the job having none sorting first rather than vanishing', () => {
    const out = ids('pm-asc');
    expect(out[0]).toBe('j6');                 // no PM -> ''
    expect(out.slice(1)).toEqual(['j5', 'j1', 'j2', 'j3', 'j4']);
    expect(out).toHaveLength(ROWS.length);     // nothing dropped
  });

  test('job type', () => {
    expect(ids('type-asc')).toEqual(['j5', 'j1', 'j2', 'j3', 'j4', 'j6']);
  });

  test('the money columns each sort their own figure', () => {
    expect(ids('materials-desc')[0]).toBe('j1');
    expect(ids('labor-desc')[0]).toBe('j1');
    expect(ids('subs-desc')[0]).toBe('j1');
    expect(ids('lines-desc')[0]).toBe('j1');
  });

  test('the unbilled gap is subs MINUS billed, so an over-billed job sorts last', () => {
    // j1 has $113,215 of QuickBooks sub spend against $178,215 billed — a
    // NEGATIVE gap. Sorting "largest gap first" must not put it at the top
    // just because its numbers are the biggest.
    const out = ids('unbilled-desc');
    expect(out[0]).toBe('j5');                 // 1500 - 0
    expect(out[out.length - 1]).toBe('j1');    // 113215 - 178215
  });

  test('last import, newest first', () => {
    expect(C.sortRows(ROWS, 'import-desc')[0].lastImport).toBe('2026-10-02');
    expect(C.sortRows(ROWS, 'import-desc').slice(-1)[0].lastImport).toBe('2026-09-28');
  });

  test('sorting NEVER reorders the caller\'s array', () => {
    // The row list is the render input; sorting it in place would reorder the
    // source on every repaint and make the order depend on how many times the
    // page had been drawn.
    const before = ROWS.map((r) => r.jobId);
    C.sortRows(ROWS, 'job-asc');
    expect(ROWS.map((r) => r.jobId)).toEqual(before);
  });

  test('an unknown sort key falls back to counted rather than scrambling', () => {
    expect(ids('nonsense-desc')).toEqual(ids('counted-desc'));
  });

  test('every key the control offers is a key the sorter handles', () => {
    // The two lists are written in different places; this is the join.
    C.SORTS.forEach((s) => {
      const out = C.sortRows(ROWS, s.key);
      expect([s.key, out.length]).toEqual([s.key, ROWS.length]);
    });
  });
});

describe('search covers what people actually type', () => {
  test('the job label still matches', () => {
    expect(C.match(ROWS[0], 'cluster 9')).toBe(true);
    expect(C.match(ROWS[0], 'rv2013')).toBe(true);
  });

  test('a PM name matches — it did not before, and that was the complaint', () => {
    expect(C.match(ROWS[4], 'cody')).toBe(true);
    expect(C.match(ROWS[0], 'cody')).toBe(false);
  });

  test('the client and the type match too', () => {
    expect(C.match(ROWS[0], 'saddlebrook resort')).toBe(true);
    expect(C.match(ROWS[4], 'mid-tier')).toBe(true);
  });

  test('an empty search matches everything', () => {
    expect(ROWS.every((r) => C.match(r, ''))).toBe(true);
  });
});

describe('the toolbar on the page', () => {
  function paint() {
    C.setLines(
      ROWS.flatMap((r) => Object.keys(r.buckets).map((b) => ({
        job_id: r.jobId, amount: r.buckets[b], bucket: b, report_date: r.lastImport,
      }))),
      []
    );
    C.paint(document.getElementById('host'));
    return document.getElementById('host');
  }

  test('it draws a filter for each of the four, plus sort and views', () => {
    const el = paint();
    expect(el.querySelector('[data-f="type"]')).toBeTruthy();
    expect(el.querySelector('[data-f="pm"]')).toBeTruthy();
    expect(el.querySelector('[data-f="market"]')).toBeTruthy();
    expect(el.querySelector('[data-f="status"]')).toBeTruthy();
    expect(el.querySelector('.jhc-sort')).toBeTruthy();
    expect(el.querySelector('.jhc-views')).toBeTruthy();
  });

  test('changing a filter repaints the table with fewer rows', () => {
    const el = paint();
    const before = el.querySelectorAll('[data-jhc-job]').length;
    const sel = el.querySelector('[data-f="pm"]');
    sel.value = 'Cody Reed';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const after = document.getElementById('host').querySelectorAll('[data-jhc-job]');
    expect(after.length).toBeLessThan(before);
    expect(after[0].getAttribute('data-jhc-job')).toBe('j5');
  });

  test('Clear appears only once something is filtered, and puts it all back', () => {
    const el = paint();
    expect(el.querySelector('.jhc-clear')).toBeNull();
    const sel = el.querySelector('[data-f="type"]');
    sel.value = 'Service';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const host = document.getElementById('host');
    expect(host.querySelector('.jhc-clear')).toBeTruthy();
    host.querySelector('.jhc-clear').click();
    expect(document.getElementById('host').querySelectorAll('[data-jhc-job]')).toHaveLength(ROWS.length);
  });

  test('the count line says how many of how many, and what they add up to', () => {
    const el = paint();
    expect(el.textContent).toContain('6 of 6 shown');
    const sel = el.querySelector('[data-f="pm"]');
    sel.value = 'Cody Reed';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const txt = document.getElementById('host').textContent;
    expect(txt).toContain('1 of 6 shown');
    // The filtered total, so a filtered sheet still answers "how much is this".
    expect(txt).toMatch(/counted/);
  });

  test('clicking a row still opens that job — the toolbar did not eat the click', () => {
    const el = paint();
    const tr = el.querySelector('[data-jhc-job]');
    tr.click();
    expect(C.state().job).toBe(tr.getAttribute('data-jhc-job'));
  });
});
