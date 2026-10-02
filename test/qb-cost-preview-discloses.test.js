/**
 * @jest-environment jsdom
 */
// THE PREVIEW HAS TO SHOW WHAT THE MATCHER DID.
//
// Two things on this screen are now decided by something other than string
// equality, and both of them move real money, so neither may be silent:
//
//   * A PADDED MATCH. Project 86 pads job numbers (WO0004), the accounting
//     system does not (WO4). The importer reconciles the two — and says so,
//     because this is the one row where the job the cost lands on is not the
//     string QuickBooks printed. A reconciliation nobody is shown is one
//     nobody can check.
//   * AN AMBIGUOUS ONE. Two jobs differing only by leading zeros. The
//     importer refuses to pick and NAMES them. Reporting it as a plain
//     "no such job" would send John off to create a third.
//
// Drives the real renderPreview in jsdom, the way payload-compact-card.test.js
// drives the real card.

'use strict';

const imp = require('../js/job-costs-import');
// The unmatched rows carry a "+ Create stub job" button whose inline handler
// is built with p86Code (js/dom-ref.js — a separate script tag in the real
// page). Load the real one rather than a stub so the escaping in that cell is
// the escaping that ships.
window.p86Code = require('../js/dom-ref').code;

const jobsOnWindow = (numbers) => {
  window.appData = {
    jobs: numbers.map((n, i) => ({ id: 'job_' + i, jobNumber: n, title: 'Job ' + n }))
  };
};

const project = (code, name, total) => ({
  code,
  name: name || (code + ' work'),
  rawHeader: code + ' ' + (name || 'work'),
  lines: [{ vendor: 'Home Depot', date: '07/07/2026', amount: total || 100 }],
  computedTotal: total || 100,
  reportedTotal: total || 100,
  hasReportedTotal: true
});

function preview(jobNumbers, parsedProjects) {
  document.body.innerHTML = '<div id="qbCostsImport_body"></div>';
  jobsOnWindow(jobNumbers);
  imp.__setLastParse({
    jobs: parsedProjects,
    reportDate: '2026-10-01',
    fileName: 'AG Exteriors_Project costs detail (51).xlsx'
  });
  imp.renderPreview();
  return document.getElementById('qbCostsImport_body');
}

afterEach(() => { imp.__setLastParse(null); delete window.appData; });

describe('a padded match is disclosed on the row', () => {
  test('the QuickBooks code is shown beside the job number it reached', () => {
    const el = preview(['WO0004'], [project('WO4', 'Indian Shores Paver Repairs', 22.19)]);
    const text = el.textContent;
    expect(text).toContain('WO0004');
    expect(text).toContain('WO4');
    // The arrow is what says "these are the same job spelled two ways".
    expect(text).toMatch(/WO0004\s*←\s*WO4/);
  });

  test('…and it counts as MATCHED, not as a problem', () => {
    const el = preview(['WO0004'], [project('WO4', 'Indian Shores Paver Repairs', 22.19)]);
    expect(el.textContent).toContain('Matched');
    expect(el.textContent).not.toContain('Unmatched —');
    expect(el.textContent).toContain('$22.19');
  });

  test('an EXACT match shows no arrow — only the reconciled ones are annotated', () => {
    const el = preview(['S2240'], [project('S2240', 'Citi Lakes Garage Repair', 620.57)]);
    expect(el.textContent).toContain('S2240');
    expect(el.textContent).not.toContain('←');
  });

  test('the disclosure is HTML-escaped like every other cell', () => {
    const el = preview(['WO0004'], [project('WO4', '<img src=x onerror=alert(1)>', 1)]);
    expect(el.querySelector('img')).toBeNull();
    expect(el.innerHTML).not.toContain('onerror=');
  });
});

describe('an ambiguous padding is named, not guessed at', () => {
  test('both candidate job numbers are printed, with what to do', () => {
    const el = preview(['WO0004', 'WO004'], [project('WO4', 'Indian Shores Paver Repairs', 22.19)]);
    const text = el.textContent;
    expect(text).toContain('Two jobs could be this');
    expect(text).toContain('WO0004');
    expect(text).toContain('WO004');
    expect(text).toMatch(/Renumber one of them/);
  });

  test('it sits in the UNMATCHED table — nothing was imported on a guess', () => {
    const el = preview(['WO0004', 'WO004'], [project('WO4', 'Indian Shores Paver Repairs', 22.19)]);
    expect(el.textContent).toContain('Unmatched');
    // And the money is counted as at risk, not as imported.
    expect(el.textContent).toContain('$22.19');
  });

  test('the SUMMARY does not tell John to create a job that already exists twice', () => {
    // The trap 9a25db88 closed, reopened by the padding tolerance: an
    // ambiguous code looks exactly like a well-formed missing one, so it was
    // classified 'missing-job' and the banner said "Create that job (the
    // + Create stub job button below does it)". A third WO24 is the worst
    // available move.
    const el = preview(['WO0004', 'WO004'], [project('WO4', 'Indian Shores Paver Repairs', 22.19)]);
    const text = el.textContent;
    expect(text).toContain('matches TWO jobs');
    expect(text).toContain('Nothing was guessed');
    expect(text).not.toContain('does not exist in Project 86 yet');
    expect(text).not.toMatch(/Create that job/);
  });

  test('the "+ Create stub job" button is DISABLED on an ambiguous row', () => {
    const el = preview(['WO0004', 'WO004'], [project('WO4', 'Indian Shores Paver Repairs', 22.19)]);
    const btn = el.querySelector('tbody button');
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/creating a third would not help/i);
  });

  test('…but stays enabled for a genuinely missing job', () => {
    const el = preview(['S2240'], [project('M1002', 'Belleair Staircase & Landing Repairs', 7109.82)]);
    const btn = el.querySelector('tbody button');
    expect(btn.disabled).toBe(false);
  });

  test('an ambiguous project and a missing one are reported as SEPARATE causes', () => {
    // S9999 uses a prefix the org demonstrably numbers under (S2240 exists),
    // so it classifies 'missing-job' — "create it". M1002 would land in
    // 'unclear' here, because this fixture's job list teaches no M prefix.
    const el = preview(['WO0004', 'WO004', 'S2240'], [
      project('WO4', 'Indian Shores Paver Repairs', 22.19),
      project('S9999', 'Heatherwood Roof Grout Repair', 42.32)
    ]);
    const text = el.textContent;
    expect(text).toContain('matches TWO jobs');
    expect(text).toContain('does not exist in Project 86 yet');
    // Ambiguity leads — it is the one the reader could otherwise act on wrongly.
    expect(text.indexOf('matches TWO jobs')).toBeLessThan(text.indexOf('does not exist in Project 86 yet'));
  });

  test('an ordinary missing job gets NO ambiguity line', () => {
    const el = preview(['S2240'], [project('M1002', 'Belleair Staircase & Landing Repairs', 7109.82)]);
    expect(el.textContent).toContain('M1002');
    expect(el.textContent).not.toContain('Two jobs could be this');
  });
});

describe('the rest of the preview is unchanged', () => {
  test('a mixed file reports matched and unmatched separately', () => {
    const el = preview(['S2240', 'WO0004'], [
      project('S2240', 'Citi Lakes Garage Repair', 620.57),
      project('WO4', 'Indian Shores Paver Repairs', 22.19),
      project('M1002', 'Belleair Staircase & Landing Repairs', 7109.82)
    ]);
    const text = el.textContent;
    expect(text).toContain('Matched');
    expect(text).toContain('Unmatched');
    expect(text).toContain('M1002');
    // Two matched (one exact, one padded), one unmatched.
    expect(text).toMatch(/WO0004\s*←\s*WO4/);
  });

  test('the file name and report date still head the dialog', () => {
    const el = preview(['S2240'], [project('S2240', 'Citi Lakes', 1)]);
    expect(el.textContent).toContain('AG Exteriors_Project costs detail (51).xlsx');
    expect(el.textContent).toContain('2026-10-01');
  });
});
