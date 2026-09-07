// The /projects/:projectId route.
//
// 'projects' was already in KNOWN_TOP_TABS, so /projects/abc always PARSED —
// parts[1] was simply never read. That made a missing route a silent
// id-dropper rather than a 404: serializeRoute fell through to the generic
// `'/' + route.top` tail and produced a perfectly valid-looking '/projects'
// for a route that named a project. Nothing threw, nothing logged. These
// tests pin the symmetry so it cannot regress back into that shape.
//
// router.js is a browser IIFE, so it runs in a vm sandbox with just enough
// of a window to boot. It is loaded ONCE and driven through its public
// surface (p86Router.route / canGo / navigate), which is what the app uses.

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
    setTimeout: (fn) => { /* keep the debounced sync out of these tests */ },
    appState: {},
    document: {
      // Every lookup misses: these tests exercise parse/serialize, not the
      // DOM-reading capture path.
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


test('a bare /projects parses to the tab with no project', () => {
  const { router } = loadRouter('/projects');
  const r = router.route();
  assert.strictEqual(r.top, 'projects');
  assert.strictEqual(r.projectId, undefined);
});

test('/projects/:id carries the project id', () => {
  const { router } = loadRouter('/projects/proj_1787667006389_92npse');
  const r = router.route();
  assert.strictEqual(r.top, 'projects');
  assert.strictEqual(r.projectId, 'proj_1787667006389_92npse');
});

test('THE SILENT DROPPER: serialize round-trips the id instead of falling through to /projects', () => {
  const { router, win, pushed } = loadRouter('/projects');
  router.navigate({ top: 'projects', projectId: 'proj_abc123' });
  assert.deepStrictEqual(pushed, ['/projects/proj_abc123'],
    'navigate() must push the id — the generic "/" + top tail silently drops it');
  assert.strictEqual(win.location.pathname, '/projects/proj_abc123');
});

test('parse ∘ serialize is identity for a project route', () => {
  const { router } = loadRouter('/projects/proj_abc123');
  const first = router.route();
  const { router: r2 } = loadRouter('/projects/' + first.projectId);
  // Compared as data, not as objects: each loadRouter builds its own vm
  // realm, so the two routes have different Object prototypes and
  // deepStrictEqual fails on realm identity while the data is identical.
  assert.strictEqual(JSON.stringify(r2.route()), JSON.stringify(first));
});

test('a project route with no id serializes back to the bare tab', () => {
  const { router, pushed } = loadRouter('/projects');
  router.navigate({ top: 'projects' });
  assert.deepStrictEqual(pushed, ['/projects']);
});

test('canGo accepts both shapes', () => {
  const { router } = loadRouter('/projects');
  assert.strictEqual(router.canGo('/projects'), true);
  assert.strictEqual(router.canGo('/projects/proj_abc123'), true);
});

test('an id needing encoding survives the round trip', () => {
  // Project ids are TEXT primary keys. They are stored raw and encoded on
  // the way out, mirroring route.jobId — so a hostile id must not be able to
  // inject a path segment.
  const { router, pushed } = loadRouter('/projects');
  router.navigate({ top: 'projects', projectId: 'a b/c?d#e' });
  assert.strictEqual(pushed.length, 1);
  assert.ok(pushed[0].indexOf('/projects/') === 0, 'stays under /projects/');
  assert.strictEqual(pushed[0].split('/').length, 3,
    'an embedded slash must be percent-encoded, not become a new path segment');
});

// ── Level 3: /projects/:id/reports/:reportId ────────────────────────────
// The report editor used to be a position:fixed div on <body> with no URL at
// all. As the third drill-in level it needs one, and it has to nest under the
// project rather than becoming a separate top-level route, because the editor
// cannot paint without the project's photos already loaded.

test('/projects/:id/reports/:rid carries both ids', () => {
  const { router } = loadRouter('/projects/proj_abc/reports/rep_123');
  const r = router.route();
  assert.strictEqual(r.top, 'projects');
  assert.strictEqual(r.projectId, 'proj_abc');
  assert.strictEqual(r.projectReportId, 'rep_123');
});

test('a report route serializes back to the same path', () => {
  const { router, pushed } = loadRouter('/projects');
  router.navigate({ top: 'projects', projectId: 'proj_abc', projectReportId: 'rep_123' });
  assert.deepStrictEqual(pushed, ['/projects/proj_abc/reports/rep_123']);
});

test('the literal "reports" segment is required', () => {
  // /projects/:id/<anything-else> must NOT be read as a report id, or a future
  // sub-tab segment would silently open a report that does not exist.
  const { router } = loadRouter('/projects/proj_abc/photos/xyz');
  const r = router.route();
  assert.strictEqual(r.projectId, 'proj_abc');
  assert.strictEqual(r.projectReportId, undefined);
});

test('a dangling /reports with no id does not set a report', () => {
  const { router } = loadRouter('/projects/proj_abc/reports');
  const r = router.route();
  assert.strictEqual(r.projectId, 'proj_abc');
  assert.strictEqual(r.projectReportId, undefined);
});

test('a report id cannot inject a path segment', () => {
  const { router, pushed } = loadRouter('/projects');
  router.navigate({ top: 'projects', projectId: 'p1', projectReportId: 'a/b' });
  assert.strictEqual(pushed[0].split('/').length, 5,
    '/projects/p1/reports/<encoded> — the slash inside the id must be encoded');
});

test('projectReportId without projectId cannot produce an orphan path', () => {
  const { router, pushed } = loadRouter('/projects');
  router.navigate({ top: 'projects', projectReportId: 'rep_123' });
  assert.deepStrictEqual(pushed, ['/projects'],
    'a report with no project is not addressable — fall back to the tab');
});

test('the projects branch does not disturb the jobs route', () => {
  const { router } = loadRouter('/jobs/j123/job-overview');
  const r = router.route();
  assert.strictEqual(r.top, 'jobs');
  assert.strictEqual(r.jobId, 'j123');
});

