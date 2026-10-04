/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * EDIT / ARCHIVE / DELETE: gated, and out of the head.
 *
 * These three were built into the page AFTER auth had already run its
 * document-wide [data-cap] sweep, so they were the only job actions in the app
 * nobody checked — a read-only (corporate) login got Edit, Archive and Delete
 * like everybody else, and Delete offered a press the server answers with 403
 * (DELETE /api/jobs/:id is requireRole('admin')).
 *
 * They also sat in the head as a row of three, which is the space the job's
 * card now spans, so they fold behind one button at every width — the menu
 * that used to exist only on a phone.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const H = require('./helpers/job-detail-dom');

const JOB = { id: 'job_1', jobNumber: 'S0012', title: 'Lanai screen repair' };
let observers = [];

function auth(caps, isAdmin) {
  window.p86Auth = {
    hasCapability: function (k) { return caps.indexOf(k) >= 0; },
    isAdmin: function () { return !!isAdmin; }
  };
}

beforeAll(() => {
  H.buildDom(document);
  observers = H.loadWorkspaceLayout(window, JOB);
});
afterAll(() => { observers.forEach((o) => o.disconnect()); });

beforeEach(async () => { await H.closeJob(window); });

const bar = () => document.querySelector('.jh-job-actions');
const more = () => document.querySelector('.jh-job-more');
const labels = () => Array.from(bar().querySelectorAll('button')).map((b) => b.textContent.trim());

describe('who may press what', () => {
  test('a PM who may edit jobs gets Edit and Archive, not Delete', async () => {
    auth(['JOBS_EDIT_OWN'], false);
    await H.openJobAt(window, null);
    expect(labels()).toEqual(['Edit', 'Archive']);
  });

  test('an admin gets Delete as well — the endpoint asks for admin', async () => {
    auth(['JOBS_EDIT_ANY'], true);
    await H.openJobAt(window, null);
    expect(labels()).toEqual(['Edit', 'Archive', 'Delete']);
  });

  test('a read-only login gets NONE of them, and no button to open an empty menu', async () => {
    auth([], false);
    await H.openJobAt(window, null);
    expect(labels()).toEqual([]);
    expect(more()).toBeNull();
  });

  test('with no auth module at all nothing is hidden — the gate fails OPEN, like the rest of the app offline', async () => {
    delete window.p86Auth;
    await H.openJobAt(window, null);
    expect(labels()).toEqual(['Edit', 'Archive', 'Delete']);
  });
});

describe('they fold behind one button, in the head', () => {
  beforeEach(() => auth(['JOBS_EDIT_ANY'], true));

  test('the button lives in the head row, beside the card — not in the metrics strip', async () => {
    await H.openJobAt(window, null);
    expect(more()).toBeTruthy();
    expect(more().parentElement.id).toBe('jh-job-head');
    expect(document.querySelector('#jh-strip-detached .jh-job-more')).toBeNull();
  });

  test('clicking it opens the menu at ANY width — it used to refuse above the phone breakpoint', async () => {
    await H.openJobAt(window, null);
    expect(bar().classList.contains('is-open')).toBe(false);
    more().click();
    expect(bar().classList.contains('is-open')).toBe(true);
    expect(more().getAttribute('aria-expanded')).toBe('true');
  });

  test('it drops from the button, not from the top of the page', async () => {
    await H.openJobAt(window, null);
    more().click();
    // jsdom measures everything as 0, so the assertion is that a position was
    // computed from the anchor at all rather than left at the old constant.
    expect(bar().style.top).toBeTruthy();
    expect(bar().style.right).toBeTruthy();
  });

  test('picking something closes it', async () => {
    await H.openJobAt(window, null);
    more().click();
    bar().querySelector('button').click();
    expect(bar().classList.contains('is-open')).toBe(false);
  });

  test('Escape closes it', async () => {
    await H.openJobAt(window, null);
    more().click();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bar().classList.contains('is-open')).toBe(false);
  });
});

describe('the head is the card and that button, nothing else', () => {
  test('the row holds the card slot first and the actions never render inline', async () => {
    auth(['JOBS_EDIT_ANY'], true);
    await H.openJobAt(window, null);
    const head = document.getElementById('jh-job-head');
    const kids = Array.from(head.children).map((c) => c.id || c.className);
    expect(kids[0]).toBe('jh-job-card');
    expect(kids).toContain('jh-job-actions');
    expect(kids).toContain('jh-job-more');
    // The menu is display:none until .is-open — the stylesheet, not the markup,
    // is what keeps three buttons out of the row.
    const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'css', 'workspace-layout.css'), 'utf8');
    // One rule set for both heads: the lead page's head runs the same control,
    // so the selectors are shared rather than copied.
    expect(css).toMatch(/\n\.jh-job-actions,\r?\n\.p86-head-actions \{ display: none; \}/);
    expect(css).toMatch(/\n\.jh-job-actions\.is-open,\r?\n\.p86-head-actions\.is-open \{/);
    // ...and NOTHING sets display on that element inline. It shipped once with
    // the three buttons still sitting in the head, because buildHeader set
    // style.cssText = "display:flex;…" on this element and an inline display
    // beats a stylesheet rule that is not !important. Asserted on the element,
    // so a future inline style fails here rather than on the live page.
    expect(bar().style.display).toBe('');
  });

  test('the card spans the head instead of being capped at a column width', async () => {
    const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'css', 'workspace-layout.css'), 'utf8');
    const rule = css.split('\n').find((l) => l.startsWith('.jh-job-card {'));
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/flex: 1 1 auto/);
    expect(rule).not.toMatch(/max-width/);
  });
});
