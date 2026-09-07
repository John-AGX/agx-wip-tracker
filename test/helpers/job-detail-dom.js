'use strict';

// A jsdom stand-in for the job detail page, for driving the REAL
// js/workspace-layout.js (tab strip, layout, pane placement) in a test.
//
// Requires a jsdom test environment — put `@jest-environment jsdom` in the
// docblock of any file that uses this.
//
// The module under test is an IIFE that installs a body-wide MutationObserver
// when it loads, so a file evaluates it ONCE and isolates its tests with the
// module's own lifecycle instead: closeJob() hides the detail view, which is
// what drives cleanup() (panels rescued back into the detail, strip destroyed,
// layoutApplied reset) — the same close/reopen cycle the app performs.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// The nine legacy .sub-tab-btn-job buttons that actually exist in index.html.
// Every section added after that markup froze has NONE — which is the drift
// the deep-link tests pin.
const LEGACY_SUBS = [
  'job-overview', 'job-wip-report', 'job-changeorders', 'job-purchaseorders',
  'job-invoices', 'job-payapps', 'job-buildings', 'job-labor', 'job-workflow'
];

// Every pane id the strip can select — the legacy nine plus the newer set.
const PANES = LEGACY_SUBS.concat([
  'job-details', 'job-estimates', 'job-qb-costs', 'job-subs',
  'job-photos', 'job-files', 'job-daily-logs', 'job-reports',
  'job-service-tickets'
]);

function buildDom(document) {
  document.body.innerHTML =
    '<div id="app-sidebar"><div class="app-nav"></div></div>' +
    '<div id="jobs-main-view"></div>' +
    '<div id="jobs-job-detail-view" style="display:none">' +
      '<div class="job-detail-header"><h2 id="job-detail-title">JOB-1</h2></div>' +
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

// Evaluate the real module. `job` seeds appState/appData; pass extra appData
// collections via `data` (e.g. { jobChangeOrders: [...] }) to exercise the
// "never hide a tab that has data" rule.
//
// Returns the array of MutationObservers the module installed so a suite can
// disconnect them in afterAll — left connected, a notification queued by the
// last test fires after jest has torn the jsdom window down and crashes the
// worker inside jsdom's own error reporter.
function loadWorkspaceLayout(window, job, data) {
  const observers = [];
  const NativeMO = window.MutationObserver;
  window.MutationObserver = function (cb) {
    const mo = new NativeMO(cb);
    observers.push(mo);
    return mo;
  };
  const theJob = job || { id: 'job_1', jobNumber: 'JOB-1', title: 'Test' };
  window.appState = { currentJobId: theJob.id, currentJob: theJob };
  window.appData = Object.assign(
    { jobs: [theJob], buildings: [], phases: [], subs: [], estimates: [],
      qbCostLines: [], jobChangeOrders: [], jobPurchaseOrders: [], arInvoices: [] },
    data || {}
  );
  window.getJobWIP = function () { return {}; };
  window.saveData = function () {};
  window.eval(fs.readFileSync(path.join(ROOT, 'js', 'workspace-layout.js'), 'utf8'));
  return observers;
}

// The layout observer watches {childList:true, subtree:true} on body, and
// renderJobDetail churns the DOM constantly, so any append stands in for it.
function settle(document) {
  document.body.appendChild(document.createElement('span'));
  return new Promise(function (r) { setTimeout(r, 0); });
}

// The cold-boot order: the sub-tab choice is recorded while the job detail is
// still hidden and the ws-right-tab strip does not exist yet, THEN the detail
// becomes visible and the layout observer builds the strip + places the panes.
function openJobAt(window, subtab) {
  if (subtab) markSubTab(window, subtab);
  window.document.getElementById('jobs-job-detail-view').style.display = 'block';
  return settle(window.document);
}

function closeJob(window) {
  window.document.getElementById('jobs-job-detail-view').style.display = 'none';
  return settle(window.document);
}

// What js/app.js's switchJobSubTab does to the strips.
function markSubTab(window, subtab) {
  if (typeof window.p86MarkJobSubTab === 'function') {
    window.p86MarkJobSubTab(subtab);
    return;
  }
  // Pre-fix behaviour, kept so a failure still describes the bug it pins.
  window.document.querySelectorAll('.sub-tab-btn-job').forEach(function (b) {
    b.classList.remove('active');
  });
  const btn = window.document.querySelector('.sub-tab-btn-job[data-subtab="' + subtab + '"]');
  if (btn) btn.classList.add('active');
}

function activePanel(document) {
  const t = document.querySelector('.ws-right-tab.active');
  return t ? t.getAttribute('data-panel') : null;
}

function paneShown(document, id) {
  const el = document.getElementById(id);
  return el ? el.style.display : null;
}

function tabIds(document) {
  return Array.from(document.querySelectorAll('.ws-right-tab[data-panel]'))
    .map(function (t) { return t.getAttribute('data-panel'); });
}

module.exports = {
  LEGACY_SUBS, PANES,
  buildDom, loadWorkspaceLayout, settle,
  openJobAt, closeJob, markSubTab,
  activePanel, paneShown, tabIds,
};
