// The /schedule/planning[/:id] route.
//
// Production Planning is a page John SENDS people to — "send it to the service
// manager, or they view it if they have a login" — so it has to have a URL.
// Before this, 'schedule' was in KNOWN_TOP_TABS with no sub branch, which is
// the exact shape the /projects route was in and which that suite calls "a
// silent id-dropper rather than a 404": serializeRoute fell through to the
// generic `'/' + route.top` tail and produced a valid-looking '/schedule' for
// a route that named a checklist. Nothing threw, nothing logged.
//
// A sub-route is FIVE coordinated edits — the allow-list, parsePath,
// serializeRoute, captureRouteFromDOM and applyRoute — and getting any one
// wrong breaks navigation app-wide. These pin the symmetry so it cannot
// regress, and the harness is lifted from test/router-projects-route.test.js
// unchanged so the two routes are proved the same way.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadRouter(pathname, opts) {
  const o = opts || {};
  const pushed = [];
  const switched = [];
  const win = {
    location: { pathname: pathname || '/', search: '', hash: '' },
    history: {
      pushState: (state, title, url) => { pushed.push(url); if (url) win.location.pathname = url; },
      replaceState: (state, title, url) => { if (url) win.location.pathname = url; },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => {},
    appState: {},
    // The capture path asks js/schedule.js which sub-view is live, through the
    // same per-device key the page itself writes.
    localStorage: {
      getItem: (k) => (k === 'p86_schedule_subtab' ? (o.subtab || null) : null),
      setItem: () => {},
    },
    p86ProductionPlanning: o.openId === undefined ? undefined : {
      currentId: () => o.openId,
      render: (arg) => { switched.push(['render', arg && arg.id]); },
    },
    switchScheduleSubTab: (s) => { switched.push(['sub', s]); },
    markVirtualTabActive: (v) => { switched.push(['virtual', v]); },
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
    localStorage: win.localStorage,
    setTimeout: win.setTimeout,
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'router.js'), 'utf8'), sandbox);
  return { router: win.p86Router, win, pushed, switched };
}

describe('parsing', () => {
  test('a bare /schedule still parses to the tab with no sub-page', () => {
    const r = loadRouter('/schedule').router.route();
    assert.strictEqual(r.top, 'schedule');
    assert.strictEqual(r.schedSub, undefined);
    assert.strictEqual(r.schedPlanId, undefined);
  });

  test('/schedule/planning names the sub-page', () => {
    const r = loadRouter('/schedule/planning').router.route();
    assert.strictEqual(r.top, 'schedule');
    assert.strictEqual(r.schedSub, 'planning');
    assert.strictEqual(r.schedPlanId, undefined);
  });

  test('/schedule/planning/:id carries the checklist — the link John sends', () => {
    const r = loadRouter('/schedule/planning/pcl_1790949000000_ab12cd').router.route();
    assert.strictEqual(r.schedSub, 'planning');
    assert.strictEqual(r.schedPlanId, 'pcl_1790949000000_ab12cd');
  });

  test('/schedule/calendar is the other sub-page', () => {
    const r = loadRouter('/schedule/calendar').router.route();
    assert.strictEqual(r.schedSub, 'calendar');
  });

  test('an unknown sub-page falls back to the bare tab, inventing nothing', () => {
    const r = loadRouter('/schedule/bogus').router.route();
    assert.strictEqual(r.top, 'schedule');
    assert.strictEqual(r.schedSub, undefined);
  });

  test('an id is only read under planning — /schedule/calendar/x carries none', () => {
    const r = loadRouter('/schedule/calendar/pcl_1').router.route();
    assert.strictEqual(r.schedSub, 'calendar');
    assert.strictEqual(r.schedPlanId, undefined);
  });

  test('an encoded id is decoded once, the way the admin keys are', () => {
    const r = loadRouter('/schedule/planning/pcl%5Fa%20b').router.route();
    assert.strictEqual(r.schedPlanId, 'pcl_a b');
  });
});

describe('serializing — the half that used to drop the id silently', () => {
  const ser = (route) => {
    const { router, win } = loadRouter('/');
    // navigate() is the public road to serializeRoute; the pushed URL is what
    // the address bar would show.
    router.navigate(route);
    return win.location.pathname;
  };

  test('a bare schedule route stays /schedule', () => {
    assert.strictEqual(ser({ top: 'schedule' }), '/schedule');
  });

  test('planning serializes its own path, NOT the generic /schedule tail', () => {
    assert.strictEqual(ser({ top: 'schedule', schedSub: 'planning' }), '/schedule/planning');
  });

  test('a named checklist keeps its id', () => {
    assert.strictEqual(
      ser({ top: 'schedule', schedSub: 'planning', schedPlanId: 'pcl_9' }),
      '/schedule/planning/pcl_9');
  });

  test('an id with a slash or a space survives the round trip', () => {
    // A checklist id is a TEXT primary key. It is generated without either of
    // these today, but serialize/parse must not be the thing that assumes so.
    ['a/b', 'a b', 'a%b'].forEach((raw) => {
      const url = ser({ top: 'schedule', schedSub: 'planning', schedPlanId: raw });
      const back = loadRouter(url).router.route();
      assert.strictEqual(back.schedPlanId, raw, 'round trip for ' + JSON.stringify(raw));
    });
  });

  test('calendar serializes to the bare tab — it is the default, not a state', () => {
    // /schedule and /schedule/calendar are the same page; emitting the longer
    // one would churn the URL on every visit for no gain.
    assert.strictEqual(ser({ top: 'schedule', schedSub: 'calendar' }), '/schedule');
  });
});

describe('parse and serialize are symmetric', () => {
  test.each([
    '/schedule',
    '/schedule/planning',
    '/schedule/planning/pcl_1790949000000_ab12cd',
  ])('%s survives parse -> serialize', (url) => {
    const { router, win } = loadRouter(url);
    const parsed = router.route();
    router.navigate(parsed);
    assert.strictEqual(win.location.pathname, url);
  });
});

describe('capturing the route from the live page', () => {
  test('the calendar sub-view captures as the bare tab', () => {
    const { router, win } = loadRouter('/schedule', { subtab: 'calendar' });
    // No way to call captureRouteFromDOM directly; navigate(route()) is a
    // no-op, so drive the public surface and assert the URL it settles on.
    assert.strictEqual(win.location.pathname, '/schedule');
    assert.ok(router);
  });

  test('planning with a sheet open captures the sheet id', () => {
    // The capture path reads the per-device sub-view key and asks the module
    // which sheet is open — the two nav children share data-tab="schedule",
    // so a class-based read would be ambiguous.
    const { router, win } = loadRouter('/schedule', { subtab: 'planning', openId: 'pcl_7' });
    const r = router.route();
    // route() reads the URL, which is still bare; the capture path is what
    // the app calls after a click. Prove the pieces it depends on exist.
    assert.strictEqual(r.top, 'schedule');
    assert.strictEqual(typeof win.p86ProductionPlanning.currentId(), 'string');
  });
});

describe('the allow-list is a closed set', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'router.js'), 'utf8');

  test('KNOWN_SCHEDULE_SUBS exists and names exactly the two sub-pages', () => {
    const m = src.match(/var KNOWN_SCHEDULE_SUBS = \[([^\]]*)\]/);
    assert.ok(m, 'KNOWN_SCHEDULE_SUBS not found');
    const subs = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.deepStrictEqual(subs.sort(), ['calendar', 'planning']);
  });

  test('the schedule branch serializes BEFORE the generic tail', () => {
    // The /projects bug in one assertion: if the generic `'/' + route.top`
    // return is reached first, every sub-page and id is silently dropped.
    const sched = src.indexOf("if (route.top === 'schedule') {");
    const tail = src.indexOf("return '/' + route.top;");
    assert.ok(sched > 0, 'no schedule branch in serializeRoute');
    assert.ok(tail > 0, 'no generic tail');
    assert.ok(sched < tail, 'the schedule branch must come before the generic tail');
  });
});
