/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * THE CLICK-SWALLOWER HAS TO LET GO.
 *
 * js/table-enhancements.js keeps ONE module-global `suppressClick` shared by
 * every enhanced table (jobs, estimates, leads, the job hub's four lists). A
 * column resize or a reorder drag past 5px sets it, and the ONLY thing that
 * clears it is the thead's own capture-phase click listener — which runs only
 * when a click actually lands on that thead.
 *
 * A click event fires on the nearest common ancestor of the mousedown and
 * mouseup targets. So a drag released OUTSIDE the header (over the rows, the
 * page margin, another pane — the ordinary way a reorder ends, since you drag
 * a column sideways and let go wherever it landed) fires its click on <body>,
 * never on the thead. The flag stays true, and the NEXT header click on ANY
 * enhanced table is silently swallowed: the sort does not happen, and nothing
 * says why. Click again and it works, which is exactly the shape of bug people
 * stop reporting and start shrugging at.
 *
 * That matters more since 1.77, where a header click is one of the two ways to
 * sort the Jobs list (the other being the toolbar Sort select).
 *
 * jsdom does NOT synthesise a click from mousedown+mouseup, so each test
 * dispatches the clicks the BROWSER would have dispatched, and the two control
 * cases below pin that modelling in both directions: a drag that ends ON the
 * header still swallows its trailing click, and a plain click never is.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'table-enhancements.js'), 'utf8');

// Two enhanced tables, because the flag is shared: a drag on one can swallow a
// click on the other.
const JOBS_COLS = ['name', 'client', 'pm', 'status', 'contract', 'margin'];
const EST_COLS = ['title', 'client', 'status', 'clientPrice'];

let sorts;

function headRow(cols) {
  return '<thead><tr>' + cols.map((c) => '<th class="sortable" data-col="' + c + '" data-sort="' + c + '">' + c + '</th>').join('') + '</tr></thead>';
}
function bodyRow(cols) {
  return '<tbody><tr>' + cols.map((c) => '<td data-col="' + c + '">x</td>').join('') + '</tr></tbody>';
}

function build() {
  document.body.innerHTML =
    '<div class="table-container"><table id="jobs-table">' + headRow(JOBS_COLS) + bodyRow(JOBS_COLS) + '</table></div>' +
    '<div id="estimates-list"><div class="table-container"><table>' + headRow(EST_COLS) + bodyRow(EST_COLS) + '</table></div></div>';
  sorts = [];
  // Stands in for the inline onclick="sortJobsTable('…')" the real headers
  // carry. A capture-phase stopPropagation on the thead stops it reaching this,
  // exactly as it stops the inline handler.
  document.querySelectorAll('th[data-col]').forEach((th) => {
    th.addEventListener('click', () => sorts.push(th.getAttribute('data-col')));
  });
  window.p86Tables.enhance('jobs');
  window.p86Tables.enhance('estimates');
}

beforeAll(() => {
  // eslint-disable-next-line no-eval
  window.eval(SRC);
});
beforeEach(() => {
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  build();
});

const th = (table, col) => document.querySelector(table + ' th[data-col="' + col + '"]');
const JOBS = '#jobs-table';
const EST = '#estimates-list table';

function mouse(target, type, clientX) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: clientX }));
}

// A reorder drag: press a header, move past the 5px threshold, release. `upOn`
// is where the button came up — the whole point of this file.
function dragColumn(table, col, upOn) {
  const cell = th(table, col);
  mouse(cell, 'mousedown', 100);
  mouse(document, 'mousemove', 160);
  mouse(upOn, 'mouseup', 160);
}

// The trailing click the browser fires after a drag: one click on the nearest
// common ancestor of the press and the release. The press already happened.
function trailingClick(el) { mouse(el, 'click', 160); }

// A person clicking a header: press, release, click — all three, on the header.
// Dispatching the click alone would not be a click any browser produces, and
// the press is the half that matters here.
function clickHeader(cell) {
  mouse(cell, 'mousedown', 200);
  mouse(cell, 'mouseup', 200);
  mouse(cell, 'click', 200);
}

describe('a drag released outside the header', () => {
  test('does not eat the next header click on the SAME table', () => {
    dragColumn(JOBS, 'client', document.body);   // released over the page, so
    // the browser's click goes to <body>, not the thead. Nothing clears it.
    trailingClick(document.body);

    clickHeader(th(JOBS, 'status'));
    expect(sorts).toEqual(['status']);
  });

  test('does not eat a header click on ANOTHER table — the flag is shared', () => {
    dragColumn(JOBS, 'client', document.body);
    trailingClick(document.body);

    clickHeader(th(EST, 'status'));
    expect(sorts).toEqual(['status']);
  });

  test('a resize released outside the header does not eat the next click either', () => {
    const cell = th(JOBS, 'client');
    const rz = cell.querySelector('.p86-col-resizer');
    expect(rz).not.toBeNull();
    mouse(rz, 'mousedown', 100);
    mouse(document, 'mousemove', 160);
    mouse(document.body, 'mouseup', 160);
    trailingClick(document.body);

    clickHeader(th(JOBS, 'margin'));
    expect(sorts).toEqual(['margin']);
  });

  test('released over the table BODY — where a sideways drag usually ends', () => {
    dragColumn(JOBS, 'client', document.querySelector('#jobs-table td[data-col="status"]'));
    // Press was in the thead, release in the tbody: the common ancestor is the
    // <table>, so again no click reaches the thead.
    trailingClick(document.querySelector('#jobs-table'));

    clickHeader(th(JOBS, 'contract'));
    expect(sorts).toEqual(['contract']);
  });
});

describe('what the swallower is FOR still works', () => {
  test('a drag that ends on the header swallows its own trailing click, and only that one', () => {
    const cell = th(JOBS, 'client');
    mouse(cell, 'mousedown', 100);
    mouse(document, 'mousemove', 160);
    mouse(cell, 'mouseup', 160);
    // Press and release both inside the thead, so the browser DOES fire the
    // click there — the drag must not also sort the column.
    trailingClick(cell);
    expect(sorts).toEqual([]);

    // …and the list is not left deaf afterwards.
    clickHeader(th(JOBS, 'status'));
    expect(sorts).toEqual(['status']);
  });

  test('a press that never passes the 5px threshold is a click, not a drag', () => {
    const cell = th(JOBS, 'client');
    mouse(cell, 'mousedown', 100);
    mouse(document, 'mousemove', 103);
    mouse(cell, 'mouseup', 103);
    trailingClick(cell);
    expect(sorts).toEqual(['client']);
  });

  test('a plain click sorts (a check over nothing cannot fail)', () => {
    clickHeader(th(JOBS, 'status'));
    clickHeader(th(EST, 'status'));
    expect(sorts).toEqual(['status', 'status']);
  });
});
