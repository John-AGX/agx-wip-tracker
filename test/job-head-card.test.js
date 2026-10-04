/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * THE JOB PAGE HEAD: the job's card, where the empty bar used to be.
 *
 * Before this, the job page opened with (a) a right-aligned row holding Edit /
 * Archive / Delete and ~1,400px of empty bar beside them, (b) the job's
 * identity card off in the left sidebar, and (c) a "Job Information" strip
 * riding the top of EVERY section's content. Three places saying what one
 * control can say.
 *
 * Now the card sits in that bar and IS the disclosure: clicking it opens Job
 * Information beneath the head, where it belongs to the page rather than to
 * whichever section happens to be open.
 *
 * Driven through the REAL js/workspace-layout.js on the shared job-detail DOM
 * harness, so these assert what the page does on open, on section switch and
 * on close — not what a builder returns in isolation.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const H = require('./helpers/job-detail-dom');

const JOB = { id: 'job_1', jobNumber: 'S0012', title: 'Lanai screen repair' };
let observers = [];

beforeAll(() => {
  H.buildDom(document);
  observers = H.loadWorkspaceLayout(window, JOB);
});
afterAll(() => { observers.forEach((o) => o.disconnect()); });

beforeEach(async () => {
  await H.closeJob(window);
  delete JOB.layout;
  JOB.jobNumber = 'S0012';
  try { window.localStorage.removeItem('p86_job_info_open'); } catch (e) {}
});

const head = () => document.getElementById('jh-job-head');
const slot = () => document.getElementById('jh-job-card');
const panel = () => document.getElementById('jh-job-info-panel');
const infoCard = () => document.getElementById('job-info-card');

describe('the head is one row: the card, then the job actions', () => {
  test('both are in it, the card first', async () => {
    await H.openJobAt(window, null);
    expect(head()).toBeTruthy();
    const kids = [...head().children].map((c) => c.id || c.className);
    expect(kids[0]).toBe('jh-job-card');
    expect(kids.join(' ')).toMatch(/jh-job-actions/);
  });

  test('Edit / Archive / Delete keep their own element', async () => {
    await H.openJobAt(window, null);
    // The phone rules turn .jh-job-actions itself into the ⋯ menu. Had the
    // card been put INSIDE that element, the card would disappear into the
    // menu on a phone — which is where it is needed most.
    const actions = document.querySelector('.jh-job-actions');
    expect(actions).toBeTruthy();
    expect(actions.querySelector('#jh-job-card')).toBeNull();
    expect(actions.textContent).toMatch(/Edit/);
    expect(actions.textContent).toMatch(/Archive/);
    expect(actions.textContent).toMatch(/Delete/);
  });

  test('the card slot is a real control — focusable, labelled, wired to the panel', async () => {
    await H.openJobAt(window, null);
    expect(slot().getAttribute('role')).toBe('button');
    expect(slot().getAttribute('tabindex')).toBe('0');
    expect(slot().getAttribute('aria-controls')).toBe('jh-job-info-panel');
    expect(slot().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Job Information hangs off the card', () => {
  test('the card is moved into the head panel, not left in the section content', async () => {
    await H.openJobAt(window, null);
    expect(panel()).toBeTruthy();
    expect(infoCard().parentElement).toBe(panel());
    expect(panel().hidden).toBe(true);           // closed by default
  });

  test('the "Job Information" strip is gone from the section content', async () => {
    await H.openJobAt(window, null);
    // The old furniture: a <details> with a summary, inserted above whatever
    // section you opened.
    expect(document.querySelector('.ws-job-info-details')).toBeNull();
    expect(document.querySelector('.ws-job-info-summary')).toBeNull();
  });

  test('clicking the card opens it, clicking again closes it', async () => {
    await H.openJobAt(window, null);
    slot().click();
    expect(panel().hidden).toBe(false);
    expect(slot().getAttribute('aria-expanded')).toBe('true');
    expect(slot().classList.contains('is-open')).toBe(true);
    slot().click();
    expect(panel().hidden).toBe(true);
    expect(slot().getAttribute('aria-expanded')).toBe('false');
  });

  test('the keyboard opens it too', async () => {
    await H.openJobAt(window, null);
    const ev = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    slot().dispatchEvent(ev);
    expect(panel().hidden).toBe(false);
  });

  test('a control INSIDE the card still does its own job', async () => {
    await H.openJobAt(window, null);
    // "Add follow-up" and the icon row are [data-act] buttons the card owns.
    // If the disclosure swallowed them, the card would open job information
    // instead of filing the follow-up.
    slot().innerHTML = '<button data-act="addtask">Add follow-up</button>';
    slot().querySelector('[data-act]').click();
    expect(panel().hidden).toBe(true);
    expect(slot().getAttribute('aria-expanded')).toBe('false');
  });

  test('open stays open across a section switch — it belongs to the page', async () => {
    await H.openJobAt(window, null);
    slot().click();
    expect(panel().hidden).toBe(false);
    H.markSubTab(window, 'job-photos');
    await H.settle(document);
    expect(infoCard().parentElement).toBe(panel());
    expect(panel().hidden).toBe(false);
  });

  test('whether it was open is remembered for the next job', async () => {
    await H.openJobAt(window, null);
    slot().click();
    expect(window.localStorage.getItem('p86_job_info_open')).toBe('1');
    await H.closeJob(window);
    await H.openJobAt(window, null);
    expect(panel().hidden).toBe(false);
    expect(slot().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('closing the job gives the card back to the page', () => {
  test('#job-info-card returns to the detail view, and the head is gone', async () => {
    await H.openJobAt(window, null);
    expect(infoCard().parentElement).toBe(panel());
    await H.closeJob(window);
    // Had the head simply been removed, the card inside it would have gone
    // with it and the NEXT job would open with no Job Information at all.
    expect(infoCard()).toBeTruthy();
    expect(infoCard().closest('#jobs-job-detail-view')).toBeTruthy();
    expect(document.getElementById('jh-job-head')).toBeNull();
    expect(document.getElementById('jh-job-info-panel')).toBeNull();
  });

  test('and reopening builds it again, with the card still there', async () => {
    await H.openJobAt(window, null);
    await H.closeJob(window);
    await H.openJobAt(window, null);
    expect(head()).toBeTruthy();
    expect(infoCard().parentElement).toBe(panel());
  });
});

describe('Tasks is a section of its own', () => {
  test('it is offered on the short ticket page and on the full one', async () => {
    await H.openJobAt(window, null);
    expect(H.tabIds(document)).toContain('job-tasks');      // S job = ticket layout
    JOB.jobNumber = 'RV0142';
    await H.closeJob(window);
    await H.openJobAt(window, null);
    expect(H.tabIds(document)).toContain('job-tasks');      // RV job = full layout
  });

  test('it reads "Tasks" and selects the job-tasks pane', async () => {
    await H.openJobAt(window, null);
    const tab = [...document.querySelectorAll('.ws-right-tab[data-panel]')]
      .find((t) => t.getAttribute('data-panel') === 'job-tasks');
    expect(tab).toBeTruthy();
    expect(tab.textContent.replace(/\s+/g, ' ').trim()).toMatch(/Tasks/);
  });

  test('opening it shows the pane and nothing else', async () => {
    await H.openJobAt(window, 'job-tasks');
    expect(H.activePanel(document)).toBe('job-tasks');
    expect(H.paneShown(document, 'job-tasks')).not.toBe('none');
    expect(H.paneShown(document, 'job-photos')).toBe('none');
  });
});
