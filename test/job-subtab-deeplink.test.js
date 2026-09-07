/**
 * @jest-environment jsdom
 */
// Deep-linking to /jobs/:id/:jobSub must land with THAT sub-tab active in the
// visible strip and its pane on screen.
//
// The job detail carries TWO strips for one choice:
//   * the legacy hidden `.sub-tab-btn-job` buttons in index.html — only NINE
//     of them; every section added after that markup froze (Reports, Service
//     Tickets, Photos, Files, Daily Logs, Details, Estimates, Detailed, Subs)
//     has no button at all;
//   * the live `.ws-right-tab` strip built from RIGHT_TABS in
//     js/workspace-layout.js and relocated into the left sidebar.
//
// switchJobSubTab (js/app.js) drove only the first, and populateRightPanels
// read only the first when deciding which pane the freshly built layout should
// show. So a deep link to a section with no legacy button left NOTHING for the
// layout pass to honor: it fell through to tab index 0 and the app showed
// Overview while the URL said Reports.
//
// These tests drive the real js/workspace-layout.js over a jsdom copy of the
// static job-detail markup, in the order a cold boot produces: the sub-tab is
// marked BEFORE the layout is built (the router's replay runs inside editJob's
// synchronous body; the MutationObserver that builds the layout fires after).

const H = require('./helpers/job-detail-dom');

// The jsdom job-detail harness is shared with test/job-layout-ticket.test.js.
let _observers = [];
const markSubTab = (s) => H.markSubTab(window, s);
const openJobAt  = (s) => H.openJobAt(window, s);
const closeJob   = () => H.closeJob(window);
const activePanel = () => H.activePanel(document);
const paneShown  = (id) => H.paneShown(document, id);

beforeAll(() => {
  H.buildDom(document);
  _observers = H.loadWorkspaceLayout(window);
});

afterAll(() => { _observers.forEach((o) => o.disconnect()); });

// Every test starts from a closed job, so each one exercises a real open.
beforeEach(closeJob);

describe('cold deep link to /jobs/:id/:jobSub', () => {
  // FIRST test in the file on purpose: nothing has selected a sub-tab yet, so
  // this is the virgin-module state a page load starts in.
  test('no sub-tab in the URL lands on the first tab', async () => {
    await openJobAt(null);
    expect(activePanel()).toBe('job-overview');
    expect(paneShown('job-overview')).toBe('block');
  });

  // job-reports is the control the whole diagnosis rests on: a long-shipped
  // tab with no legacy button, so it cannot be a Service-Tickets wiring gap.
  test('job-reports lands active in the visible strip with its pane shown', async () => {
    await openJobAt('job-reports');
    expect(activePanel()).toBe('job-reports');
    expect(paneShown('job-reports')).toBe('block');
    expect(paneShown('job-overview')).toBe('none');
  });

  test('job-service-tickets lands active in the visible strip with its pane shown', async () => {
    await openJobAt('job-service-tickets');
    expect(activePanel()).toBe('job-service-tickets');
    expect(paneShown('job-service-tickets')).toBe('block');
    expect(paneShown('job-overview')).toBe('none');
  });

  test('job-overview — the default landing — still lands on itself', async () => {
    await openJobAt('job-overview');
    expect(activePanel()).toBe('job-overview');
    expect(paneShown('job-overview')).toBe('block');
  });

  // The tab that DOES have a legacy button. It worked before the fix, which is
  // what narrowed the bug to the missing-button set; it must keep working.
  test('job-wip-report (has a legacy button) still lands correctly', async () => {
    await openJobAt('job-wip-report');
    expect(activePanel()).toBe('job-wip-report');
    expect(paneShown('job-wip-report')).toBe('block');
  });

  // Pre-existing behaviour of the legacy strip, now uniform across all tabs:
  // the static .sub-tab-btn-job buttons kept their .active across a close, so
  // reopening a job landed on the section you left. Pinned because it is the
  // one visible consequence of holding the selection outside the DOM.
  test('a bare /jobs/:id reopen keeps the section you left', async () => {
    await openJobAt('job-service-tickets');
    await closeJob();
    await openJobAt(null);
    expect(activePanel()).toBe('job-service-tickets');
    expect(paneShown('job-service-tickets')).toBe('block');
  });
});

describe('the two strips cannot disagree', () => {
  test('marking a sub-tab after the layout exists moves BOTH strips', async () => {
    await openJobAt('job-overview');
    markSubTab('job-reports');
    expect(activePanel()).toBe('job-reports');
    // The legacy strip has no job-reports button, so "agreeing" means it stops
    // claiming a stale one rather than pointing at Reports.
    expect(document.querySelector('.sub-tab-btn-job.active')).toBeNull();
  });

  test('clicking a tab drives both strips (the path that already worked)', async () => {
    await openJobAt(null);
    document.querySelector('.ws-right-tab[data-panel="job-wip-report"]').onclick();
    expect(activePanel()).toBe('job-wip-report');
    expect(document.querySelector('.sub-tab-btn-job.active').getAttribute('data-subtab'))
      .toBe('job-wip-report');
    expect(paneShown('job-wip-report')).toBe('block');
  });
});
