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

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The nine legacy buttons that actually exist in index.html.
const LEGACY_SUBS = [
  'job-overview', 'job-wip-report', 'job-changeorders', 'job-purchaseorders',
  'job-invoices', 'job-payapps', 'job-buildings', 'job-labor', 'job-workflow'
];

// Every pane id the strip can select. Superset of the legacy nine — this is
// the drift the bug lived in.
const PANES = LEGACY_SUBS.concat([
  'job-details', 'job-estimates', 'job-qb-costs', 'job-subs',
  'job-photos', 'job-files', 'job-daily-logs', 'job-reports',
  'job-service-tickets'
]);

function buildDom() {
  document.body.innerHTML =
    '<div id="app-sidebar"><div class="app-nav"></div></div>' +
    '<div id="jobs-main-view"></div>' +
    '<div id="jobs-job-detail-view" style="display:none">' +
      '<div class="job-detail-header"><h2 id="job-detail-title">JOB-1 &mdash; Test</h2></div>' +
      '<div class="sub-tabs">' +
        LEGACY_SUBS.map(function (id, i) {
          return '<button class="sub-tab-btn-job' + (i === 0 ? ' active' : '') +
                 '" data-subtab="' + id + '"></button>';
        }).join('') +
      '</div>' +
      PANES.map(function (id, i) {
        return '<div id="' + id + '" class="sub-tab-content-job' +
               (i === 0 ? ' active' : '') + '"></div>';
      }).join('') +
    '</div>';
}

// js/workspace-layout.js is an IIFE that installs a body-wide MutationObserver
// on load, so it is evaluated ONCE for the file. Tests isolate themselves with
// the module's own lifecycle instead: closeJob() hides the detail view, which
// drives its cleanup() (panels rescued back into the detail, strip destroyed,
// layoutApplied reset) — the same close/reopen cycle the app performs.
const _observers = [];
function loadWorkspaceLayout() {
  // Hand back every MutationObserver the module installs so afterAll can
  // disconnect them. Left connected, a notification queued by the last test
  // fires after jest has torn the jsdom window down and crashes the worker
  // inside jsdom's own error reporter.
  const NativeMO = window.MutationObserver;
  window.MutationObserver = function (cb) {
    const mo = new NativeMO(cb);
    _observers.push(mo);
    return mo;
  };
  window.appState = {
    currentJobId: 'job_1',
    currentJob: { id: 'job_1', jobNumber: 'JOB-1', name: 'Test', status: 'In Progress' }
  };
  window.appData = { jobs: [{ id: 'job_1', jobNumber: 'JOB-1', title: 'Test' }], buildings: [], invoices: [] };
  window.getJobWIP = function () { return {}; };
  window.eval(fs.readFileSync(path.join(ROOT, 'js', 'workspace-layout.js'), 'utf8'));
}

// What js/app.js's switchJobSubTab does to the strips.
function markSubTab(subtab) {
  if (typeof window.p86MarkJobSubTab === 'function') {
    window.p86MarkJobSubTab(subtab);
    return;
  }
  // Pre-fix behaviour, kept so this file still describes the bug it pins.
  document.querySelectorAll('.sub-tab-btn-job').forEach(function (b) { b.classList.remove('active'); });
  const btn = document.querySelector('.sub-tab-btn-job[data-subtab="' + subtab + '"]');
  if (btn) btn.classList.add('active');
}

// The cold-boot order: the sub-tab choice is recorded while the job detail is
// still hidden and the ws-right-tab strip does not exist yet, THEN the detail
// becomes visible and the layout observer builds the strip + places the panes.
function openJobAt(subtab) {
  if (subtab) markSubTab(subtab);
  document.getElementById('jobs-job-detail-view').style.display = 'block';
  return settle();
}

function closeJob() {
  document.getElementById('jobs-job-detail-view').style.display = 'none';
  return settle();
}

// The layout observer watches {childList:true, subtree:true} on body, and
// renderJobDetail churns the DOM constantly, so any append stands in for it.
function settle() {
  document.body.appendChild(document.createElement('span'));
  return new Promise(function (r) { setTimeout(r, 0); });
}

function activePanel() {
  const t = document.querySelector('.ws-right-tab.active');
  return t ? t.getAttribute('data-panel') : null;
}
function paneShown(id) {
  const el = document.getElementById(id);
  return el ? el.style.display : null;
}

beforeAll(() => {
  buildDom();
  loadWorkspaceLayout();
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
