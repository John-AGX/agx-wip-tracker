'use strict';
/* ──────────────────────────────────────────────────────────────────────────
 * WHERE THE MARK ACTUALLY APPEARS.
 *
 * The badge is only worth having if it is on every list that shows these
 * records. A surface that quietly renders without one is the failure mode
 * this file exists to catch: "no badge" and "not in Buildertrend" look the
 * same to a person, so a missing call site reads as a confident, wrong answer.
 *
 * These are source assertions, which can pass for silly reasons. Each one
 * therefore anchors on the REAL row-building expression for that surface —
 * the same string the renderer uses — so it fails if the row is rewritten,
 * not merely if the file stops containing the word "badge".
 * ────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// [ file, what the surface is, the row expression that must carry a badge ]
const SURFACES = [
  ['js/jobs.js', 'the jobs list',
    "${escapeHTML(window.p86JobLabel.fromJob(job))}</strong>${btWhereBadge(job)}"],
  ['js/jobs.js', 'the job page header',
    'var html = btWhereBadge(job) + btOpenBadge(job);'],
  ['js/jobs.js', "a job's change orders",
    "escapeHTML(c.co_number || 'CO') + '</strong>' + btWhereBadge(c)"],
  ['js/jobs.js', "a job's purchase orders",
    "escapeHTML(p.po_number || 'PO') + '</strong>' + btWhereBadge(p)"],
  ['js/jobs-hub.js', 'the change orders list',
    "esc(r.co_number || '') + '</strong>' + (window.p86BtBadge ? window.p86BtBadge.render(r) : '')"],
  ['js/jobs-hub.js', 'the purchase orders list',
    "esc(r.po_number || '') + '</strong>' + (window.p86BtBadge ? window.p86BtBadge.render(r) : '')"],
  ['js/leads.js', 'the leads list',
    "'</strong>' + (window.p86BtBadge ? window.p86BtBadge.render(l) : '')"],
  ['js/estimates.js', 'the estimates list',
    "escapeHTML(est.title || '(untitled)') + '</strong>' + (window.p86BtBadge ? window.p86BtBadge.render(est) : '')"],
];

describe('every list that shows one of these records shows the mark', () => {
  test.each(SURFACES)('%s — %s', (file, _what, expr) => {
    expect(read(file)).toContain(expr);
  });

  test('the page loads the module before anything that calls it', () => {
    const html = read('index.html');
    const at = (f) => html.indexOf('js/' + f + '.js?v=');
    expect(at('bt-badge')).toBeGreaterThan(-1);
    for (const f of ['jobs', 'jobs-hub', 'leads', 'estimates']) {
      expect(at(f)).toBeGreaterThan(at('bt-badge'));
    }
  });

  test('btWhereBadge takes any record, not only a job', () => {
    // It is called with change orders and purchase orders now. A signature
    // that says `job` invites the next person to add a job-only field to it.
    const src = extractFunction(read('js/jobs.js'), 'btWhereBadge');
    expect(src).toMatch(/function btWhereBadge\(rec\)/);
    const fn = compile([src], ['window'], [{ p86BtBadge: { render: (r) => 'B:' + r.kind } }], 'btWhereBadge');
    expect(fn({ kind: 'co' })).toBe('B:co');
  });

  test('with the module absent every surface degrades to no badge, not a crash', () => {
    // bt-badge.js can be missing on a sub-portal page, a share link, or an old
    // cache. The guard is what keeps those pages rendering.
    const fn = compile([extractFunction(read('js/jobs.js'), 'btWhereBadge')], ['window'], [{}], 'btWhereBadge');
    expect(fn({ bt_job_id: '1' })).toBe('');
  });
});

describe('a change order carries its Buildertrend link to the browser', () => {
  // The real shapeRow, run — not a description of it. Every change-order door
  // returns through this function.
  const shapeRow = compile(
    [extractFunction(read('server/routes/change-order-routes.js'), 'shapeRow')],
    [], [], 'shapeRow'
  );

  test('bt_co_id comes through', () => {
    expect(shapeRow({ id: 'co1', data: {}, bt_co_id: '77123' }).bt_co_id).toBe('77123');
  });

  test('a door that did not SELECT the column yields undefined, not null', () => {
    // undefined -> the badge renders nothing. null would be a claim that the
    // change order is Project 86 only, which that door cannot know.
    expect(shapeRow({ id: 'co1', data: {} }).bt_co_id).toBeUndefined();
  });

  test('the data blob cannot forge the link — the column wins', () => {
    const out = shapeRow({ id: 'co1', data: { bt_co_id: 'forged' }, bt_co_id: 'real' });
    expect(out.bt_co_id).toBe('real');
  });

  test('every query that feeds shapeRow selects the column', () => {
    const src = read('server/routes/change-order-routes.js');
    // Each SELECT/RETURNING of the canonical column set must carry bt_co_id;
    // one that does not would hand shapeRow a row with the field missing and
    // silently drop the badge on that door.
    const lists = src.match(/approved_by, linked_node_id, is_locked, created_at, updated_at[^`\n]*/g) || [];
    expect(lists.length).toBeGreaterThan(0);
    for (const l of lists) expect(l).toContain('bt_co_id');
  });
});
