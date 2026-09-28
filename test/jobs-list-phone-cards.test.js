/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * The Jobs list, streamlined.
 *
 * Before: on a phone the toolbar took three rows (Add Job, Import QB Costs,
 * Export CSV, Print, Archived, Filter, Views, Map) plus two full-width
 * labelled "Filter by" selects, and each job was a tall label/value table —
 * about one job per screen, with a stray unlabelled "—" row and a bare
 * checkbox on every card.
 *
 * After: one toolbar row on desktop (two on a phone), the four utilities
 * behind a ⋯ menu, and each job a three-line card with captioned stats.
 *
 * The stray "—" was a real bug, not a style choice: syncJobsMarketColumn()
 * hid the Market cell with an inline display:none, and the phone card CSS
 * forces td display with !important (it must, to beat table-enhancements'
 * column widths) — which beats inline style. So a single-market org showed
 * an unlabelled Market row on every card. The fix is a class the card CSS
 * reads; this pins both halves.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JOBS = fs.readFileSync(path.join(ROOT, 'js', 'jobs.js'), 'utf8').replace(/\r\n/g, '\n');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');

// Lift one function out of jobs.js by its opening line up to the first
// line that closes it at the same indent.
function lift(openLine, closeLine) {
  const i = JOBS.indexOf(openLine);
  if (i < 0) throw new Error('not found: ' + openLine);
  const j = JOBS.indexOf(closeLine, i);
  if (j < 0) throw new Error('no close for: ' + openLine);
  return JOBS.slice(i, j + closeLine.length);
}

describe('compact money on the card', () => {
  // eslint-disable-next-line no-new-func
  const short = new Function(lift('        function jobsMoneyShort(v) {', '\n        }\n') + '\nreturn jobsMoneyShort;')();

  test('thousands, millions, small, negative, zero', () => {
    expect(short(412500)).toBe('$413k');
    expect(short(18450)).toBe('$18k');
    expect(short(1236000)).toBe('$1.24M');
    expect(short(24800000)).toBe('$24.8M');
    expect(short(-450)).toBe('-$450');
    expect(short(-61875)).toBe('-$62k');
    expect(short(0)).toBe('$0');
    expect(short(null)).toBe('$0');
  });

  test('the row hands the card the compact figure on both money cells', () => {
    const body = lift('        function renderJobsTable() {', '\n        }\n');
    expect(body).toMatch(/data-col="contract" data-short="\$\{jobsMoneyShort\(w\.totalIncome\)\}"/);
    expect(body).toMatch(/data-col="profit" data-short="\$\{jobsMoneyShort\(w\.displayProfit\)\}"/);
  });

  test('the card shows data-short and hides the full figure', () => {
    expect(CSS).toContain('#jobs-table td[data-col="contract"][data-short]::after');
    expect(CSS).toMatch(/content: attr\(data-short\)/);
  });
});

describe('a hidden Market column stays hidden on the card', () => {
  // eslint-disable-next-line no-new-func
  const sync = new Function(lift('        function syncJobsMarketColumn() {', '\n        }\n') + '\nreturn syncJobsMarketColumn;')();

  function table() {
    document.body.innerHTML =
      '<table id="jobs-table"><thead><tr><th data-col="market">Market</th></tr></thead>' +
      '<tbody><tr><td data-col="market">—</td></tr><tr><td data-col="market">—</td></tr></tbody></table>';
    return [...document.querySelectorAll('#jobs-table [data-col="market"]')];
  }

  test('single-market org: every market cell carries the class the card CSS reads', () => {
    window.p86Markets = { hasMulti: () => false };
    const cells = table();
    sync();
    expect(cells.length).toBe(3);
    cells.forEach((c) => {
      expect(c.classList.contains('is-col-off')).toBe(true);
      expect(c.style.display).toBe('none');
    });
  });

  test('multi-market org: the class comes off again', () => {
    const cells = table();
    window.p86Markets = { hasMulti: () => false };
    sync();
    window.p86Markets = { hasMulti: () => true };
    sync();
    cells.forEach((c) => expect(c.classList.contains('is-col-off')).toBe(false));
  });

  test('the phone card hides that class (and the bulk checkbox) with !important', () => {
    expect(CSS).toMatch(/#jobs-table td\.job-check-cell,\n\s*#jobs-table td\.is-col-off \{ display: none !important; \}/);
  });
});

describe('the ⋯ menu reaches every utility the toolbar used to show', () => {
  let calls;
  beforeAll(() => {
    calls = [];
    window.escapeHTML = (s) => String(s);
    window.exportJobsToCSV = () => calls.push('export');
    window.showArchivedJobs = () => calls.push('archived');
    window.print = () => calls.push('print');
    // eslint-disable-next-line no-eval
    window.eval(lift('        window.jobsOpenMore = function(anchor) {', '\n        };\n'));
  });

  function open() {
    document.body.innerHTML =
      '<button id="jobs-more-btn" aria-expanded="false"></button>' +
      '<input type="file" id="qb-costs-import-file">';
    document.getElementById('qb-costs-import-file').click = () => calls.push('import');
    const btn = document.getElementById('jobs-more-btn');
    window.jobsOpenMore(btn);
    return btn;
  }

  test('four items, in order', () => {
    open();
    const labels = [...document.querySelectorAll('#jobs-more-pop .jobs-more-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Import QB costs', 'Export CSV', 'Print list', 'Archived jobs']);
  });

  test.each([['import'], ['export'], ['print'], ['archived']])('%s runs what its old button ran, and closes the menu', (act) => {
    calls.length = 0;
    const btn = open();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    document.querySelector('.jobs-more-item[data-act="' + act + '"]').click();
    expect(calls).toEqual([act]);
    expect(document.getElementById('jobs-more-pop')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  test('a second tap on ⋯ closes it', () => {
    const btn = open();
    window.jobsOpenMore(btn);
    expect(document.getElementById('jobs-more-pop')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the toolbar', () => {
  const i = INDEX.indexOf('<div class="jobs-action-tabs jobs-toolbar">');
  const toolbar = INDEX.slice(i, INDEX.indexOf('</div>', i));

  test('exists (a check over nothing cannot fail)', () => {
    expect(i).toBeGreaterThan(-1);
    expect(toolbar).toContain('openAddJobModal()');
  });

  test('the quick filters keep the ids + handler filterJobs() and setupTypeFilter() bind to', () => {
    expect(toolbar).toMatch(/<select id="statusFilter"[^>]*onchange="filterJobs\(\)"/);
    expect(toolbar).toMatch(/<select id="typeFilter"[^>]*onchange="filterJobs\(\)"/);
    expect(INDEX).not.toContain('Filter by Status:');
  });

  test('the utilities moved behind ⋯ — and the import still has its file input', () => {
    expect(toolbar).toContain('onclick="jobsOpenMore(this)"');
    expect(toolbar).not.toContain('>Import QB Costs<');
    expect(toolbar).not.toContain('>Export CSV<');
    expect(toolbar).toContain('id="qb-costs-import-file"');
  });

  test('phone quick filters have a real flex basis (at basis 0 the first one crushes to a chevron on row one)', () => {
    const at = CSS.indexOf('  .jobs-toolbar .jobs-quick-select {\n    order: 10;');
    expect(at).toBeGreaterThan(-1);
    const rule = CSS.slice(at, CSS.indexOf('}', at));
    expect(rule).not.toMatch(/flex: 1 1 0;/);
    expect(rule).toMatch(/flex: 1 1 \d+%;/);
    expect(rule).toContain('font-size: 16px');
  });
});
