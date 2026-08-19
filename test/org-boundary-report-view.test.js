/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * THE REPORT VIEW MUST NOT UNDO THE AUDIT'S ONE GUARANTEE
 *
 * services/org-boundary-audit.js goes to real trouble — a SAVEPOINT around
 * every single measurement — to preserve one distinction: a count that could
 * not be taken comes back as `null`, and `null` is NOT zero. Its own header
 * calls that "the single most important property of the whole file", and names
 * the two boot reporters that get it wrong as the reason it exists.
 *
 * A renderer is where that property dies quietly. `Number(v) || 0`,
 * `v || '—'`, `(v ?? 0).toLocaleString()` — every idiomatic way to put a
 * number on a screen converts null to something that reads as zero, on the
 * last inch, after the service protected it all the way through the database
 * layer. And the consequence is specific: a table whose count TIMED OUT would
 * render as "0 un-stamped rows", which is the exact license somebody needs to
 * drop a tolerance arm or add a NOT NULL that then hides live rows.
 *
 * So these tests are about the pixels, not the payload. They take a report in
 * the shape the endpoint really returns, with nulls scattered through every
 * section, and assert that each one reaches the screen as the word "unknown"
 * and that no zero was invented anywhere near it.
 * ────────────────────────────────────────────────────────────────────────── */

let CC;

beforeAll(() => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }));
  require('../js/console.js');
  CC = window.p86Console;
});

// The shape auditOrgBoundary really returns, with a null in every section
// that can produce one.
function report(over) {
  return Object.assign({
    generated_at: '2026-08-19T12:00:00.000Z',
    organizations: 1,
    sole_org: true,
    gate_note: 'SOLE ORG. Every NEVER_MULTI_ORG backfill in db.js is still running.',
    tables_with_org_column: 4,
    not_measured: [
      { what: 'nulls:attachments', code: '57014', error: 'canceling statement due to statement timeout' }
    ],
    buckets: {
      direct: [
        { table: 'jobs', nullable: true, class: 'direct', nulls: 0, total: 120 },
        { table: 'attachments', nullable: true, class: 'direct', nulls: null, total: null },
        { table: 'leads', nullable: false, class: 'direct', nulls: 0, total: null,
          note: 'column is already NOT NULL — its tolerance arms are dead code' }
      ],
      parent: [], shared: [], mixed_shared: [], platform: [], unclassified: []
    },
    parent_families: [
      { table: 'job_change_orders', parent: 'jobs', fk: 'job_id', parent_stamped: 40, parent_null: null, orphan: 2 }
    ],
    attachments: {
      rung1_parent_stamped: 900, rung1_parent_null: null,
      rung2_own_stamp: 3, rung3_uploader: null, rung4_nothing: 7
    },
    pointers: { divergent: null, pointer_orphan: 0, jobs_ownerless: 5, estimates_ownerless: null },
    simulation: {
      would_hide: [
        { arm: 'jobs.organization_id', table: 'jobs', rows: 12, sample: [1, 2, 3] },
        { arm: 'attachments.organization_id', table: 'attachments', rows: null, sample: [] }
      ],
      already_hidden: [
        { site: 'org-manifest-routes.js owner-join', table: 'jobs', rows: null, note: 'hidden right now' }
      ]
    },
    ready_for_not_null: ['jobs'],
    blocked: [
      { table: 'attachments', nulls: null, reason: 'NOT MEASURED — could not be counted, which is not the same as zero' }
    ],
    unclassified: []
  }, over || {});
}

// Strip the markup so a "0" inside a style/colour/hex value cannot be mistaken
// for a rendered count. Only visible text is examined.
function textOf(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent;
}
// The visible cells of the row whose first cell is `label`. `width` picks the
// right table when the same name appears in more than one (a table name shows
// up in the verdict summary AND in its bucket), so an assertion cannot
// silently drift onto a different table than the one it means.
function rowCells(html, label, width) {
  const d = document.createElement('div');
  d.innerHTML = html;
  const tr = Array.from(d.querySelectorAll('tr')).find((r) => {
    const tds = r.querySelectorAll('td');
    if (!tds.length) return false;
    if (width && tds.length !== width) return false;
    return tds[0].textContent.trim() === label;
  });
  return tr ? Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()) : null;
}

describe('an unmeasured count renders as "unknown", never as a digit', () => {
  test('a table whose NULL count timed out shows "unknown" in the NULLs cell', () => {
    const cells = rowCells(CC.boundaryReportHtml(report()), 'attachments', 5);
    expect(cells).not.toBeNull();
    // table | nullable | nulls | total | note
    expect(cells[2]).toBe('unknown');
    expect(cells[3]).toBe('unknown');
    expect(cells[2]).not.toBe('0');
    expect(cells[2]).not.toBe('—');
  });

  test('a MEASURED zero still renders as 0 — the two must stay distinguishable', () => {
    const cells = rowCells(CC.boundaryReportHtml(report()), 'jobs', 5);
    expect(cells[2]).toBe('0');
    expect(cells[2]).not.toBe('unknown');
  });

  test('the unknown cell carries a tooltip saying it is not zero', () => {
    const d = document.createElement('div');
    d.innerHTML = CC.boundaryReportHtml(report());
    const marks = Array.from(d.querySelectorAll('.cc-unknown'));
    expect(marks.length).toBeGreaterThan(0);
    marks.forEach((m) => {
      expect(m.textContent).toBe('unknown');
      expect(m.getAttribute('title')).toMatch(/not zero/i);
    });
  });

  test('a null in the per-arm simulation reads unknown, not "0 rows would be hidden"', () => {
    const html = CC.boundaryReportHtml(report());
    const d = document.createElement('div');
    d.innerHTML = html;
    const tr = Array.from(d.querySelectorAll('tr')).find((r) =>
      r.textContent.indexOf('attachments.organization_id') === 0);
    expect(tr).toBeTruthy();
    const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
    expect(cells[2]).toBe('unknown');
  });

  test('nulls in the attachment ladder, parent families and pointer shapes all read unknown', () => {
    const html = CC.boundaryReportHtml(report());
    const ladder = rowCells(html, 'Rung 1 — parent exists but un-stamped', 3);
    expect(ladder[1]).toBe('unknown');
    const fam = rowCells(html, 'job_change_orders', 6);
    // child | parent | fk | parent_stamped | parent_null | orphan
    expect(fam[4]).toBe('unknown');
    expect(fam[3]).toBe('40');
    const ptr = rowCells(html, 'divergent', 2);
    expect(ptr[1]).toBe('unknown');
    const ptr0 = rowCells(html, 'pointer_orphan', 2);
    expect(ptr0[1]).toBe('0');
  });

  test('a blocked table with an unmeasured count is not listed as ready', () => {
    const html = CC.boundaryReportHtml(report());
    const cells = rowCells(html, 'attachments', 5);
    expect(cells).not.toBeNull();
    // Its verdict row says unknown, not "ready".
    const d = document.createElement('div');
    d.innerHTML = html;
    const verdictRow = Array.from(d.querySelectorAll('tr')).find((r) => {
      const tds = r.querySelectorAll('td');
      return tds.length === 3 && tds[0].textContent.trim() === 'attachments';
    });
    expect(verdictRow.textContent).toMatch(/unknown/);
    expect(verdictRow.textContent).not.toMatch(/ready/);
  });
});

describe('the reader is told the measurement itself was incomplete', () => {
  test('a banner names how many measurements failed, above the numbers', () => {
    const txt = textOf(CC.boundaryReportHtml(report()));
    expect(txt).toMatch(/1 measurement could not be taken/);
    expect(txt).toMatch(/nulls:attachments/);
    expect(txt).toMatch(/57014/);
  });

  test('a clean run says so instead, rather than showing nothing', () => {
    const txt = textOf(CC.boundaryReportHtml(report({ not_measured: [] })));
    expect(txt).toMatch(/Every measurement in this run completed/);
  });

  test('the gate note about the still-running guessing backfills is shown', () => {
    const txt = textOf(CC.boundaryReportHtml(report()));
    expect(txt).toMatch(/SOLE ORG/);
    expect(txt).toMatch(/NEVER_MULTI_ORG/);
  });

  test('an unmeasured headline count is not rendered as zero either', () => {
    const txt = textOf(CC.boundaryReportHtml(report({ organizations: null, tables_with_org_column: null })));
    expect(txt).toMatch(/unknown/);
  });
});

describe('the backfill is unmistakably a dry run until it is not', () => {
  test('a dry run says nothing was written', () => {
    const txt = textOf(CC.boundaryBackfillHtml({
      dry_run: true, results: [{ label: 'attachments', derivable: 12, updated: 0, why: 'parent states it' }],
      note: 'DRY RUN — nothing was written.'
    }));
    expect(txt).toMatch(/DRY RUN/);
    expect(txt).toMatch(/nothing was written/i);
    expect(txt).toMatch(/not written/);
  });

  test('an applied run says APPLIED instead', () => {
    const txt = textOf(CC.boundaryBackfillHtml({
      dry_run: false, results: [{ label: 'attachments', derivable: 12, updated: 12 }], note: 'APPLIED.'
    }));
    expect(txt).toMatch(/APPLIED/);
    expect(txt).not.toMatch(/DRY RUN/);
  });

  test('a rule whose count failed shows unknown, not zero derivable', () => {
    const html = CC.boundaryBackfillHtml({
      dry_run: true, results: [{ label: 'messages', derivable: null, updated: null, error: 'timeout' }]
    });
    const cells = rowCells(html, 'messages', 4);
    expect(cells[1]).toBe('unknown');
    expect(cells[3]).toMatch(/ERROR: timeout/);
  });
});
