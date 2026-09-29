/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * The Jobs list sort, wired: one state behind the toolbar select, the desktop
 * header chevrons and the list; the CSV export following the same order.
 *
 * Runs the REAL functions lifted out of js/jobs.js (setJobsSort, sortJobsTable,
 * syncJobsSortUI, jobsListOrder, jobsCsv, exportJobsToCSV, jobCreated …)
 * against the real js/jobs-sort.js and js/bt-badge.js, and pins the index.html
 * and CSS contracts they depend on.
 *
 * Export CSV is here because it used to be a stub in js/app.js that only
 * raised alert('Export to CSV') — nothing at all in the installed app — while
 * the ⋯ menu promised "The jobs shown, as a spreadsheet".
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lf = (s) => s.replace(/\r\n/g, '\n');
const JOBS_SRC = lf(fs.readFileSync(path.join(ROOT, 'js', 'jobs.js'), 'utf8'));
const APP_SRC = lf(fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8'));
const INDEX = lf(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
const CSS = lf(fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8'));

function lift(open, close) {
  const i = JOBS_SRC.indexOf(open);
  if (i < 0) throw new Error('not found: ' + open);
  const j = JOBS_SRC.indexOf(close, i);
  return JOBS_SRC.slice(i, j + close.length);
}

// Two synced jobs (Buildertrend's date wins over the sync's) and one made here.
// WO0027 is newer in Buildertrend than RV0142 but sorts AFTER it by number, so
// an order that fell back to the sync date (a tie) and then job # would read
// RV0142 first — the Created wiring is what puts WO0027 ahead.
const SYNC = '2026-09-25T12:13:34.000Z';
const JOBS = [
  { id: 'a', jobNumber: 'RV0142', title: 'Bayside Terrace', client: 'Bayside HOA', status: 'In Progress', bt_created_at: '2025-03-04T14:00:00.000Z', bt_synced_at: SYNC, created_at: SYNC, startDate: '2025-04-01', address: '1 Bay St, Tampa, FL' },
  { id: 'b', jobNumber: 'S0318', title: 'Harbor, "Pointe" Stucco', client: '=HYPERLINK("http://x")', status: 'New', created_at: '2026-09-28T19:00:00.000Z' },
  { id: 'c', jobNumber: 'WO0027', title: 'Westshore Plaza', client: 'Westshore LLC', status: 'Backlog', bt_created_at: '2026-06-18T13:00:00.000Z', bt_synced_at: SYNC, created_at: SYNC },
];
const WIP = { a: { totalIncome: 412500, pctComplete: 42, displayProfit: 61875, displayMargin: 15 }, b: { totalIncome: 18450, pctComplete: 0, displayProfit: -450, displayMargin: -2.44 }, c: { totalIncome: 1236000, pctComplete: 8, displayProfit: 185400, displayMargin: 15 } };

let renders, toasts, wipCalls;
beforeAll(() => {
  document.body.innerHTML =
    '<select id="jobsSort"><option value="created-desc">Newest first</option></select>' +
    '<table id="jobs-table"><thead><tr>' +
    ['name', 'client', 'pm', 'status', 'contract', 'profit', 'margin', 'created', 'synced'].map((c) => '<th class="sortable" data-col="' + c + '" data-sort="' + c + '"></th>').join('') +
    '</tr></thead><tbody></tbody></table>';
  localStorage.clear();
  // eslint-disable-next-line no-eval
  window.eval(fs.readFileSync(path.join(ROOT, 'js', 'bt-badge.js'), 'utf8'));
  // eslint-disable-next-line no-eval
  window.eval(fs.readFileSync(path.join(ROOT, 'js', 'jobs-sort.js'), 'utf8'));
  window.escapeHTML = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  window.getJobWIP = (id) => { wipCalls++; return WIP[id]; };
  // The REAL resolver's shape: '—' when nobody owns the job.
  window.getJobOwnerName = (j) => j.pm || '—';
  window.marketName = () => '';
  window.getJobType = () => '';
  window.getJobTypeLabel = () => '';
  window.getFilteredJobs = () => JOBS.slice();
  window.p86Toast = (msg, kind) => toasts.push([kind, msg]);
  window.renderJobsTable = () => { renders++; window.syncJobsSortUI(); };
  const code = [
    lift('function jobCreated(job) {', '\n}\n'),
    lift('function jobSynced(job) {', '\n}\n'),
    lift('        var _jobsSortId = ', ';\n'),
    lift('        function setJobsSort(id) {', '\n        }\n'),
    '        window.jobsSetSort = setJobsSort;\n',
    lift('        function sortJobsTable(column) {', '\n        }\n'),
    lift('        function jobsWipCache() {', '\n        }\n'),
    lift('        function jobsOwnerText(job) {', '\n        }\n'),
    lift('        function jobsListOrder(jobs, wipOf) {', '\n        }\n'),
    lift('        function syncJobsSortUI() {', '\n        }\n'),
    lift('        function jobsCsvCell(v) {', '\n        }\n'),
    lift('        function fmtDayLocal(v) {', '\n        }\n'),
    lift('        function jobsCsv(jobs, wipOf) {', '\n        }\n'),
    lift('        function exportJobsToCSV() {', '\n        }\n'),
  ].join('\n');
  // eslint-disable-next-line no-eval
  window.eval(code + '\nwindow.syncJobsSortUI = syncJobsSortUI; window.sortJobsTable = sortJobsTable;' +
    ' window.jobsListOrder = jobsListOrder; window.jobsWipCache = jobsWipCache; window.jobsCsv = jobsCsv; window.exportJobsToCSV = exportJobsToCSV;');
});
beforeEach(() => { renders = 0; toasts = []; wipCalls = 0; });

const sel = () => document.getElementById('jobsSort');
const chevron = () => {
  const th = document.querySelector('#jobs-table th.sort-asc, #jobs-table th.sort-desc');
  return th ? [th.dataset.sort, th.classList.contains('sort-asc') ? 'asc' : 'desc', th.getAttribute('aria-sort')] : null;
};

describe('one state behind the select and the header', () => {
  test('first load: Newest first, with its chevron on the Created column', () => {
    window.syncJobsSortUI();
    expect(sel().value).toBe('created-desc');
    expect(sel().options.length).toBeGreaterThan(8);
    expect(chevron()).toEqual(['created', 'desc', 'descending']);
  });

  test('"Newest first" is the Created column\'s order — Buildertrend\'s date, not the sync\'s', () => {
    const order = window.jobsListOrder(JOBS, window.jobsWipCache()).map((j) => j.id);
    expect(order).toEqual(['b', 'c', 'a']);    // 2026-09-28 (made here), 2026-06-18, 2025-03-04
  });

  test('choosing in the select re-renders, remembers, and moves the chevron', () => {
    window.jobsSetSort('name-asc');
    expect(renders).toBe(1);
    expect(localStorage.getItem('p86_jobs_sort')).toBe('name-asc');
    expect(sel().value).toBe('name-asc');
    expect(chevron()).toEqual(['name', 'asc', 'ascending']);
  });

  test('a header click sets the select; a second click flips; there is no "off"', () => {
    window.sortJobsTable('contract');
    expect([sel().value, sel().options[sel().selectedIndex].text]).toEqual(['contract-desc', 'Income, high to low']);
    window.sortJobsTable('contract');
    expect([sel().value, sel().options[sel().selectedIndex].text]).toEqual(['contract-asc', 'Income, low to high']);
    window.sortJobsTable('contract');
    expect(sel().value).toBe('contract-desc');
    expect(chevron()).toEqual(['contract', 'desc', 'descending']);
  });

  test('a sort only a header can reach is added to the select while it is on', () => {
    window.sortJobsTable('synced');
    expect([...sel().options].map((o) => o.value)).toContain('synced-desc');
    expect(sel().value).toBe('synced-desc');
    window.jobsSetSort('created-asc');
    expect([...sel().options].map((o) => o.value)).not.toContain('synced-desc');
  });

  test('Synced sorts by what the Synced cell shows (jobSynced), whichever key the record carries it under', () => {
    // bt-badge's syncedInstant reads bt_synced_at OR btSyncedAt; a sort wired
    // to anything narrower would drop the second to the bottom as "unknown".
    const jobs = [
      { id: 'old', jobNumber: 'S1', bt_synced_at: '2026-01-01T00:00:00Z' },
      { id: 'new', jobNumber: 'S2', btSyncedAt: '2026-09-25T00:00:00Z' },
      { id: 'never', jobNumber: 'S0' },
    ];
    window.jobsSetSort('synced-desc');
    expect(window.jobsListOrder(jobs, window.jobsWipCache()).map((j) => j.id)).toEqual(['new', 'old', 'never']);
  });

  test('the list order is the module\'s, with ONE getJobWIP per job even for a money sort', () => {
    window.jobsSetSort('contract-desc');
    const wipOf = window.jobsWipCache();
    const order = window.jobsListOrder(JOBS, wipOf).map((j) => j.id);
    expect(order).toEqual(['c', 'a', 'b']);
    JOBS.forEach(wipOf);                         // the row loop reuses the same cache
    expect(wipCalls).toBe(3);
  });
});

describe('a job with no PM', () => {
  test('sorts LAST in PM A–Z and Z–A — the "—" in the cell is not a name', () => {
    const jobs = [{ id: 'x', jobNumber: 'S1', pm: 'Zoe' }, { id: 'y', jobNumber: 'S2', pm: '' }, { id: 'z', jobNumber: 'S3', pm: 'Adam' }];
    const wipOf = window.jobsWipCache();
    window.jobsSetSort('pm-asc');
    expect(window.jobsListOrder(jobs, wipOf).map((j) => j.id)).toEqual(['z', 'x', 'y']);
    window.jobsSetSort('pm-desc');
    expect(window.jobsListOrder(jobs, wipOf).map((j) => j.id)).toEqual(['x', 'z', 'y']);
  });

  test('and exports a blank PM, not an em dash', () => {
    const line = window.jobsCsv([{ id: 'y', jobNumber: 'S2', title: 'T', pm: '' }], () => ({})).split('\r\n')[1];
    expect(line.split(',')[3]).toBe('');
  });
});

describe('Export CSV: the jobs shown, in the order shown', () => {
  let csvLines;
  beforeAll(() => {
    window.jobsSetSort('created-desc');
    const wipOf = window.jobsWipCache();
    csvLines = window.jobsCsv(window.jobsListOrder(JOBS, wipOf), wipOf).split('\r\n');
  });

  test('a header row, then one line per job in list order', () => {
    expect(csvLines[0]).toBe('Job #,Name,Client,PM,Status,Type,Market,Total Income,% Complete,Gross Profit,Margin %,Start date,Created,Synced,Address');
    expect(csvLines.slice(1, 4).map((l) => l.split(',')[0])).toEqual(['S0318', 'WO0027', 'RV0142']);
    expect(csvLines[4]).toBe('');                 // trailing newline, nothing after it
  });

  test('money and % are plain numbers a spreadsheet can add up', () => {
    const rv = csvLines.find((l) => l.startsWith('RV0142,'));
    expect(rv).toContain(',412500,42,61875,15,');
  });

  test('a cell a spreadsheet would run as a formula is written as text, and quoting holds', () => {
    const s = csvLines.find((l) => l.startsWith('S0318,'));
    expect(s).toContain('"Harbor, ""Pointe"" Stucco"');
    expect(s).toContain('"\'=HYPERLINK(""http://x"")"');
    expect(s).toContain(',-450,');                 // a negative NUMBER is not a formula
  });

  test('Created is the Created column\'s day (Buildertrend\'s when it has one); Synced is its own', () => {
    const rv = csvLines.find((l) => l.startsWith('RV0142,')).split(',');
    expect(rv).toContain('2025-03-04');
    expect(rv).toContain('2026-09-25');
    const made = csvLines.find((l) => l.startsWith('S0318,'));
    expect(made).toMatch(/,2026-09-2[89],,/);      // made here: a Created day, and no Synced
  });

  test('the button downloads it, UTF-8 marked for Excel, and says how many', async () => {
    let blob = null, clicked = null;
    URL.createObjectURL = (b) => { blob = b; return 'blob:jobs'; };
    URL.revokeObjectURL = () => {};
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { clicked = this.download; };
    try {
      window.exportJobsToCSV();
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    expect(clicked).toMatch(/^Jobs_\d{4}-\d{2}-\d{2}\.csv$/);
    // jsdom's Blob has no .text(); read the BYTES, which is also the only way
    // to see the byte-order mark (a text decode strips it).
    const bytes = new Uint8Array(await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsArrayBuffer(blob);
    }));
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xEF, 0xBB, 0xBF]);
    expect(new (require('util').TextDecoder)('utf-8').decode(bytes).split('\r\n')[0]).toMatch(/^Job #,Name,/);
    expect(toasts).toEqual([['success', 'Exported 3 jobs.']]);
  });

  test('nothing shown means nothing downloaded — and a message, not silence', () => {
    const orig = window.getFilteredJobs;
    window.getFilteredJobs = () => [];
    let made = false;
    URL.createObjectURL = () => { made = true; return 'blob:x'; };
    try { window.exportJobsToCSV(); } finally { window.getFilteredJobs = orig; }
    expect(made).toBe(false);
    expect(toasts).toEqual([['error', 'No jobs to export.']]);
  });

  test('the old alert() stub is gone from js/app.js, so jobs.js is the only definition', () => {
    expect(APP_SRC).not.toMatch(/function exportJobsToCSV\s*\(/);
    expect(APP_SRC).not.toContain("alert('Export to CSV')");
    expect(JOBS_SRC).toContain('window.exportJobsToCSV = exportJobsToCSV;');
  });
});

describe('renderJobsTable reads the shared state', () => {
  const body = lift('        function renderJobsTable() {', '\n        }\n');

  test('it sorts through jobsListOrder, with the WIP cache the rows reuse', () => {
    expect(body).toContain('const wipOf = jobsWipCache();');
    expect(body).toContain('jobs = jobsListOrder(jobs, wipOf);');
    expect(body).toContain('syncJobsSortUI();');
    expect(body).toContain('const w = wipOf(job);');
    expect(JOBS_SRC).not.toMatch(/appState\.sort(Column|Direction)/);
  });

  test('sub costs are recalculated BEFORE the sort reads money, not inside the row loop after it', () => {
    const recalc = body.indexOf('recalcSubCosts(job.id)');
    const sort = body.indexOf('jobs = jobsListOrder(jobs, wipOf);');
    expect(recalc).toBeGreaterThan(-1);
    expect(recalc).toBeLessThan(sort);
    expect(body.split('recalcSubCosts(').length - 1).toBe(1);
  });
});

describe('the markup and CSS it depends on', () => {
  test('the select: a bare <select> INSIDE the toolbar, labelled, calling jobsSetSort', () => {
    expect(INDEX).toMatch(/<select id="jobsSort" class="jobs-sort-select" onchange="jobsSetSort\(this\.value\)" aria-label="Sort jobs"/);
    const toolbar = INDEX.slice(INDEX.indexOf('<div class="jobs-action-tabs jobs-toolbar">'));
    const at = toolbar.indexOf('id="jobsSort"');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(toolbar.indexOf('</div>'));
  });

  test('js/jobs-sort.js loads BEFORE js/jobs.js (jobs.js reads it at load)', () => {
    const a = INDEX.search(/<script src="js\/jobs-sort\.js\?v=\d+"><\/script>/);
    const b = INDEX.search(/<script src="js\/jobs\.js\?v=\d+"><\/script>/);
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  });

  test('on a phone the sort is a 38px icon in row two, 16px so iOS does not zoom', () => {
    const at = CSS.indexOf('  .jobs-toolbar .jobs-sort-select {\n    order: 10;');
    expect(at).toBeGreaterThan(-1);
    const rule = CSS.slice(at, CSS.indexOf('}', at));
    expect(rule).toContain('flex: 0 0 38px;');
    expect(rule).toContain('font-size: 16px;');
    expect(rule).toContain('color: transparent;');
  });

  test('on a phone the filter row starts on its own line at EVERY width up to 640px', () => {
    // A 30% basis alone let Status jump up beside Map from ~488px (measured).
    expect(CSS).toContain("  .jobs-toolbar::before { content: ''; order: 9; flex: 0 0 100%; height: 0; }");
  });

  test('wherever the toolbar is too narrow for the labelled sort, it is the icon (a container query, so the sidebar counts)', () => {
    expect(CSS).toContain('.jobs-toolbar { container-type: inline-size; }');
    const at = CSS.indexOf('@container (max-width: 800px) {');
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('\n}\n', at));
    expect(block).toContain('.jobs-toolbar .jobs-sort-select {');
    expect(block).toContain('width: 30px;');
    expect(block).toContain('color: transparent;');
  });
});
