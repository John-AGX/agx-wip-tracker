// /jobs/:id/:jobSub — the parse/serialize half of job sub-tab deep links.
// (The activation half — which tab lights up and which pane shows — is
// DOM-level and lives in test/job-subtab-deeplink.test.js.)
//
// A sub-tab that is not in the router's KNOWN_JOB_SUBS does not 404: it is
// silently DROPPED. parsePath refuses to read it, serializeRoute leaves it off,
// and the section becomes unlinkable while every visible part of the app keeps
// working. job-photos, job-files and job-daily-logs shipped in that state.
//
// So the load-bearing test here is the registry one: KNOWN_JOB_SUBS must cover
// every tab in RIGHT_TABS. Both lists are read straight out of the source so
// adding a tab in js/workspace-layout.js and forgetting js/router.js fails
// here rather than shipping a dead URL.
//
// router.js is a browser IIFE, so it runs in a vm sandbox with just enough of a
// window to boot, and is driven through p86Router — the surface the app uses.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadRouter(pathname) {
  const pushed = [];
  const win = {
    location: { pathname: pathname || '/', search: '', hash: '' },
    history: {
      pushState: (state, title, url) => { pushed.push(url); if (url) win.location.pathname = url; },
      replaceState: (state, title, url) => { if (url) win.location.pathname = url; },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => { /* keep the debounced sync out of these tests */ },
    appState: {},
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      readyState: 'complete',
    },
    console: { warn: () => {}, log: () => {}, error: () => {} },
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: win.document,
    location: win.location,
    history: win.history,
    console: win.console,
    setTimeout: win.setTimeout,
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'router.js'), 'utf8'), sandbox);
  return { router: win.p86Router, win, pushed };
}

// The tab ids the job detail can actually show, lifted from the RIGHT_TABS
// literal in js/workspace-layout.js — the authoritative list.
function rightTabIds() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'workspace-layout.js'), 'utf8');
  const block = src.match(/const RIGHT_TABS = \[([\s\S]*?)\n {2}\];/);
  assert.ok(block, 'RIGHT_TABS literal not found — did workspace-layout.js move it?');
  const ids = [...block[1].matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(ids.length > 5, 'expected the full RIGHT_TABS list, got ' + ids.length);
  return ids;
}

test('THE SILENT DROPPER: every RIGHT_TABS tab round-trips through the URL', () => {
  const { router, win } = loadRouter('/jobs/job_1');
  // route() parses location.pathname, so walk the URL rather than reloading
  // the module for each tab.
  const missing = rightTabIds().filter((id) => {
    win.location.pathname = '/jobs/job_1/' + id;
    return router.route().jobSub !== id;
  });
  assert.deepStrictEqual(missing, [],
    'these job sub-tabs are missing from KNOWN_JOB_SUBS in js/router.js, so ' +
    'their deep links silently drop back to the bare job URL');
});

test('/jobs/:id/job-reports parses the sub-tab', () => {
  const { router } = loadRouter('/jobs/job_1/job-reports');
  const r = router.route();
  assert.strictEqual(r.top, 'jobs');
  assert.strictEqual(r.jobId, 'job_1');
  assert.strictEqual(r.jobSub, 'job-reports');
});

test('/jobs/:id/job-service-tickets parses the sub-tab', () => {
  const { router } = loadRouter('/jobs/job_1/job-service-tickets');
  assert.strictEqual(router.route().jobSub, 'job-service-tickets');
});

test('navigate() serializes the sub-tab back into the URL', () => {
  const { router, pushed } = loadRouter('/jobs/job_1');
  router.navigate({ top: 'jobs', jobId: 'job_1', jobSub: 'job-service-tickets' });
  assert.deepStrictEqual(pushed, ['/jobs/job_1/job-service-tickets']);
});

test('an unknown sub-tab is dropped rather than trusted', () => {
  const { router } = loadRouter('/jobs/job_1/job-not-a-tab');
  const r = router.route();
  assert.strictEqual(r.jobId, 'job_1');
  assert.strictEqual(r.jobSub, undefined);
});
