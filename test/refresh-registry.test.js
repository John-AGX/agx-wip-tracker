/**
 * @jest-environment jsdom
 */
// The refresh heartbeat (js/refresh.js).
//
// The bug class this exists to kill is a PAIRING failure: a mutation patches
// the boot read-cache but never repaints (stale screen), or repaints but never
// patches the cache (repaints the OLD number, which reads as "it didn't save").
// So the tests that matter most are the ones that pin store-then-surface
// ordering, and the three cross-cutting rules that can only be enforced here:
// type-first coalescing, never-concurrent hydrates, and never repainting over
// a focused editor.

jest.useFakeTimers();

let P;
beforeAll(() => {
  require('../js/refresh.js');
  P = window.p86Refresh;
});

// ── shared source seams ─────────────────────────────────────────────────────
// Several checks here are SOURCE checks, not runtime ones, because the defects
// they catch are invisible at runtime: a registry path pointing at a namespace
// no module creates, a dispatcher target with no client entry, a mutation site
// that refreshes a surface twice. Hoisted to module scope so both the
// registry-honesty and door-coverage groups read the same files.
const fs = require('fs');
const path = require('path');
const JS_DIR = path.join(__dirname, '..', 'js');
const SOURCES = fs.readdirSync(JS_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ file: f, src: fs.readFileSync(path.join(JS_DIR, f), 'utf8') }));
const DISPATCHER_PATH = path.join(__dirname, '..', 'server', 'services', 'payload-dispatcher.js');
const DISPATCHER_SRC = fs.readFileSync(DISPATCHER_PATH, 'utf8');

// Strip `//` comments before scanning for call sites. Several modules quote the
// exact call they document as forbidden, and a scan that counted prose would
// fail on the explanation of the fix rather than on the defect.
//
// LINE COMMENTS ONLY, deliberately. The first version of this also stripped
// /* … */ and that was a silent hole: js/estimate-editor.js contains the string
// "application/pdf,image/*", whose `/*` opened a phantom block comment that ate
// every line up to the next real `*/` — including a live window.p86JobsHubRefresh()
// call, which the scan then reported as absent. A checker that quietly stops
// seeing things is worse than no checker, so this only removes what it can
// remove safely, and `codeOnly` has its own test below.
function codeOnly(src) {
  return String(src)
    .split('\n')
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, '$1'))
    .join('\n');
}

// The body of `function <name>(...) { ... }`, brace-balanced, so a check can
// count calls INSIDE one function instead of across a 1,200-line module where
// a legitimate call elsewhere would mask the one that matters. Run it on
// comment-stripped source: a prose brace would throw the balance off.
function fnBody(src, name) {
  const head = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = head.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[0].length);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

// Every entity_type string that can reach the client in an applied payload's
// affected_targets. DERIVED FROM THE SERVER SOURCE, never hand-copied: a
// literal list here would go stale the first time someone adds a dispatcher
// target, which is precisely the failure these checks exist to catch.
//
// Two contributions, because the dispatcher has two shapes:
//   1. the DISPATCHERS map — the authoritative set of types that can be
//      WRITTEN. The bulk / conditional / skipped result rows echo
//      `target.entity_type` back verbatim, so every key here can surface.
//   2. `entity_type: '<literal>'` in the returned result objects — this also
//      picks up 'move', which is a target-level op with no DISPATCHERS key.
function emittedEntityTypes() {
  const out = new Set();
  const map = DISPATCHER_SRC.match(/const DISPATCHERS\s*=\s*\{([\s\S]*?)\n\};/);
  if (map) (map[1].match(/^\s*([a-z_]+)\s*:/gm) || [])
    .forEach((m) => out.add(m.replace(/[\s:]/g, '')));
  (DISPATCHER_SRC.match(/entity_type:\s*'([a-z_]+)'/g) || [])
    .forEach((m) => out.add(m.replace(/.*'([a-z_]+)'.*/, '$1')));
  return out;
}

// Emitted types that deliberately refresh NOTHING. Each carries its reason,
// because "we forgot to wire it" and "there is nothing on screen to wire"
// look identical from the outside — that ambiguity is how `assembly` sat
// unwired through a sweep whose stated goal was "everywhere".
const META_TYPES = {
  move: 'A summary receipt pushed AFTER both halves of the move have already ' +
        'emitted their own concrete targets (runTarget in payload-dispatcher.js). ' +
        'Refreshing on it would repaint those surfaces a second time.',
  system: 'Org/system settings multi-op. Not a row: it has no single backing ' +
        'table (it is absent from TABLE_FOR_ENTITY for the same reason) and no ' +
        'client read-cache to patch.',
  deal_memory: 'Append-only notes on a deal lineage, read server-side when a ' +
        'deal thread assembles its context. No client surface renders them.',
};

// Drain the coalescing window AND any promise microtasks the run chains on.
async function settle() {
  jest.advanceTimersByTime(300);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.appData = { jobPurchaseOrders: [], jobChangeOrders: [], jobVendorBills: [], arInvoices: [] };
  window.appState = {};
  [
    'renderJobsMain', 'p86JobsHubRefresh', 'p86RepaintJobMoneyTabs', 'p86JobDetailRefresh',
    'loadPurchaseOrdersForJob', 'loadChangeOrdersForJob', 'loadBillsForJob',
    'reloadLeadsCache', 'reloadClientsCache', 'p86ReloadAllData', 'p86DataLoading',
    'p86InvoicesSyncStore', 'p86RemountReceiptRollups', 'renderSchedule',
    'renderSummaryDashboard'
  ].forEach((k) => { delete window[k]; });
  window.p86Tasks = undefined;
  window.p86MyDay = undefined;
  window.p86Subs = undefined;
});

// ── the pairing: store patch AND surface repaint, in that order ──────────────
describe('store-then-surface — the pairing that IS the bug class', () => {
  test('a PO refresh patches the store AND repaints, never one without the other', async () => {
    const order = [];
    window.loadPurchaseOrdersForJob = jest.fn(() => { order.push('store'); return Promise.resolve(); });
    window.renderJobsMain = jest.fn(() => { order.push('surface'); });

    P('po', { jobId: 'job_1' });
    await settle();

    expect(window.loadPurchaseOrdersForJob).toHaveBeenCalled();
    expect(window.renderJobsMain).toHaveBeenCalled();
    expect(order).toEqual(['store', 'surface']);
  });

  test('the surface waits for a SLOW store — repainting first shows the pre-write number', async () => {
    const order = [];
    let release;
    window.loadPurchaseOrdersForJob = jest.fn(() => {
      order.push('store-start');
      return new Promise((res) => { release = () => { order.push('store-done'); res(); }; });
    });
    window.renderJobsMain = jest.fn(() => { order.push('surface'); });

    P('po', { jobId: 'job_1' });
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    expect(order).toEqual(['store-start']);   // surface has NOT run yet

    release();
    await settle();
    expect(order).toEqual(['store-start', 'store-done', 'surface']);
  });

  test('a store that REJECTS still repaints — a failed refetch must not freeze the screen', async () => {
    window.loadBillsForJob = jest.fn(() => Promise.reject(new Error('offline')));
    window.renderJobsMain = jest.fn();

    P('bill', { jobId: 'job_1' });
    await settle();

    expect(window.renderJobsMain).toHaveBeenCalled();
  });

  test('money refreshes force a fresh fetch — joining a pre-write GET returns stale rows', async () => {
    window.loadPurchaseOrdersForJob = jest.fn(() => Promise.resolve());
    P('po', { jobId: 'job_7' });
    await settle();
    // second arg is the `force` flag on loadXForJob
    expect(window.loadPurchaseOrdersForJob).toHaveBeenCalledWith('job_7', true);
  });
});

// ── coalescing is TYPE-first, because targets arrive one per changed ROW ─────
describe('coalescing', () => {
  test('40 targets of one type run the refresh ONCE, not 40 times', async () => {
    window.loadChangeOrdersForJob = jest.fn(() => Promise.resolve());
    window.renderJobsMain = jest.fn();

    for (let i = 0; i < 40; i++) P('co', { id: 'co_' + i, jobId: 'job_1' });
    await settle();

    expect(window.renderJobsMain).toHaveBeenCalledTimes(1);
  });

  test('job + estimate share ONE bucket, so a payload touching both hydrates once', async () => {
    window.p86ReloadAllData = jest.fn();

    P('job', { id: 'j1' });
    P('estimate', { id: 'e1' });
    await settle();

    expect(window.p86ReloadAllData).toHaveBeenCalledTimes(1);
  });

  test('task, todo, reminder and calendar_event share a bucket — one repaint, not four', async () => {
    window.p86Tasks = { refresh: jest.fn() };

    P('task'); P('todo'); P('reminder'); P('calendar_event');
    await settle();

    expect(window.p86Tasks.refresh).toHaveBeenCalledTimes(1);
  });

  test('different buckets do NOT collapse into each other', async () => {
    window.reloadLeadsCache = jest.fn();
    window.reloadClientsCache = jest.fn();

    P('lead'); P('client');
    await settle();

    expect(window.reloadLeadsCache).toHaveBeenCalledTimes(1);
    expect(window.reloadClientsCache).toHaveBeenCalledTimes(1);
  });
});

// ── never two concurrent appData hydrates ───────────────────────────────────
describe('hydrate serialisation', () => {
  test('no hydrate starts while one is in flight — a second re-seeds stale rows from cache', async () => {
    let loading = true;
    window.p86DataLoading = () => loading;
    window.p86ReloadAllData = jest.fn();

    P('job', { id: 'j1' });
    await settle();
    expect(window.p86ReloadAllData).not.toHaveBeenCalled();   // deferred, not dropped

    loading = false;
    jest.advanceTimersByTime(600);
    await Promise.resolve();
    expect(window.p86ReloadAllData).toHaveBeenCalledTimes(1);  // and it DID run
  });

  test('a deferred hydrate cannot spin forever if the in-flight flag wedges', async () => {
    window.p86DataLoading = () => true;   // never clears
    window.p86ReloadAllData = jest.fn();

    P('job', { id: 'j1' });
    await settle();
    jest.advanceTimersByTime(60000);
    await Promise.resolve();

    // Bounded: it gives up waiting and runs rather than polling forever.
    expect(window.p86ReloadAllData).toHaveBeenCalledTimes(1);
  });
});

// ── the focus guard: never repaint the container holding the caret ───────────
describe('isTyping — the guard that stops a refresh eating a half-typed row', () => {
  test('true when the caret is inside the container', () => {
    document.body.innerHTML = '<div id="ed"><input id="f"></div>';
    document.getElementById('f').focus();
    expect(P.isTypingIn('#ed')).toBe(true);
  });

  test('false when focus is elsewhere', () => {
    document.body.innerHTML = '<div id="ed"><input id="f"></div><input id="other">';
    document.getElementById('other').focus();
    expect(P.isTypingIn('#ed')).toBe(false);
  });

  test('false for a focused non-input (a button press must not block a repaint)', () => {
    document.body.innerHTML = '<div id="ed"><button id="b">x</button></div>';
    document.getElementById('b').focus();
    expect(P.isTypingIn('#ed')).toBe(false);
  });

  test('true for contenteditable — the rich-text scope editor is not an <input>', () => {
    document.body.innerHTML = '<div id="ed"><div id="rt" contenteditable="true"></div></div>';
    const rt = document.getElementById('rt');
    Object.defineProperty(rt, 'isContentEditable', { value: true });
    rt.focus();
    expect(P.isTypingIn('#ed')).toBe(true);
  });

  test('false for a selector that matches nothing', () => {
    expect(P.isTypingIn('#nope')).toBe(false);
  });
});

// ── fromTargets: the AI door ────────────────────────────────────────────────
describe('fromTargets — the agent-write fan-out', () => {
  test('dispatches every entity type in the payload, not just the four that used to be wired', async () => {
    window.p86ReloadAllData = jest.fn();
    window.reloadLeadsCache = jest.fn();
    window.p86Tasks = { refresh: jest.fn() };

    P.fromTargets([
      { entity_type: 'job', entity_id: 'j1' },
      { entity_type: 'lead', entity_id: 'l1' },
      { entity_type: 'task', entity_id: 't1' }      // had NO arm before
    ], 'pay_1');
    await settle();

    expect(window.p86ReloadAllData).toHaveBeenCalled();
    expect(window.reloadLeadsCache).toHaveBeenCalled();
    expect(window.p86Tasks.refresh).toHaveBeenCalled();
  });

  test('the same payload arriving through both doors refreshes once', async () => {
    window.reloadLeadsCache = jest.fn();

    expect(P.fromTargets([{ entity_type: 'lead', entity_id: 'l1' }], 'pay_dupe')).toBe(true);
    expect(P.fromTargets([{ entity_type: 'lead', entity_id: 'l1' }], 'pay_dupe')).toBe(false);
    await settle();

    expect(window.reloadLeadsCache).toHaveBeenCalledTimes(1);
  });

  test('an unknown entity type is a no-op, never a throw', async () => {
    expect(() => P.fromTargets([{ entity_type: 'wormhole', entity_id: 'x' }], 'pay_2')).not.toThrow();
    await settle();
  });

  test('missing targets and a missing payload id are both survivable', async () => {
    expect(() => P.fromTargets(undefined, undefined)).not.toThrow();
    expect(() => P.fromTargets([null, {}], null)).not.toThrow();
    await settle();
  });
});

// ── resilience: a broken surface must not take the rest down ────────────────
describe('isolation', () => {
  test('a throwing surface does not prevent later refreshes', async () => {
    window.reloadLeadsCache = jest.fn(() => { throw new Error('boom'); });
    window.reloadClientsCache = jest.fn();

    P('lead'); P('client');
    await settle();

    expect(window.reloadClientsCache).toHaveBeenCalled();
  });

  test('every registered type survives having no primitives defined at all', async () => {
    for (const t of P.types()) expect(() => P(t, { id: 'x' })).not.toThrow();
    await settle();
  });
});

// ── which job a money row belongs to ────────────────────────────────────────
describe('job resolution for the per-job money mirrors', () => {
  test('resolves the job from the mirror when the caller did not say', async () => {
    window.appData.jobPurchaseOrders = [{ id: 'po_9', job_id: 'job_from_mirror' }];
    window.loadPurchaseOrdersForJob = jest.fn(() => Promise.resolve());

    P('po', { id: 'po_9' });
    await settle();

    expect(window.loadPurchaseOrdersForJob).toHaveBeenCalledWith('job_from_mirror', true);
  });

  test('falls back to the job on screen for a row that is not cached yet', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadBillsForJob = jest.fn(() => Promise.resolve());

    P('bill', { id: 'brand_new' });
    await settle();

    expect(window.loadBillsForJob).toHaveBeenCalledWith('job_open', true);
  });

  test('an explicit jobId always wins over the mirror', async () => {
    window.appData.jobChangeOrders = [{ id: 'co_1', job_id: 'job_stale' }];
    window.loadChangeOrdersForJob = jest.fn(() => Promise.resolve());

    P('co', { id: 'co_1', jobId: 'job_explicit' });
    await settle();

    const jobs = window.loadChangeOrdersForJob.mock.calls.map((c) => c[0]);
    expect(jobs).toContain('job_explicit');
  });

  test('the open job page repaints when the changed row belongs to it', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadBillsForJob = jest.fn(() => Promise.resolve());
    window.p86RepaintJobMoneyTabs = jest.fn();

    P('bill', { jobId: 'job_open' });
    await settle();

    expect(window.p86RepaintJobMoneyTabs).toHaveBeenCalledWith('job_open');
  });

  test('the open job page does NOT repaint when a DIFFERENT job changed', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadBillsForJob = jest.fn(() => Promise.resolve());
    window.p86RepaintJobMoneyTabs = jest.fn();

    P('bill', { jobId: 'job_other' });
    await settle();

    expect(window.p86RepaintJobMoneyTabs).not.toHaveBeenCalled();
  });
});

// ── exactly ONCE per mutation ───────────────────────────────────────────────
// A double repaint is a defect, not a cost: it flickers, it can steal focus and
// it can drop a half-typed row — the same reason the old setTimeout repaints
// were deleted. So these assert COUNTS, never truthiness.
describe('one mutation repaints each surface exactly once', () => {
  test('a PO edit refetches once and repaints the jobs list + hub once each', async () => {
    window.loadPurchaseOrdersForJob = jest.fn(() => Promise.resolve());
    window.renderJobsMain = jest.fn();
    window.p86JobsHubRefresh = jest.fn();

    P('po', { jobId: 'job_1' });
    await settle();

    expect(window.loadPurchaseOrdersForJob).toHaveBeenCalledTimes(1);
    expect(window.renderJobsMain).toHaveBeenCalledTimes(1);
    expect(window.p86JobsHubRefresh).toHaveBeenCalledTimes(1);
  });

  test('a CO edit repaints the hub once', async () => {
    window.loadChangeOrdersForJob = jest.fn(() => Promise.resolve());
    window.p86JobsHubRefresh = jest.fn();

    P('co', { jobId: 'job_1' });
    await settle();

    expect(window.p86JobsHubRefresh).toHaveBeenCalledTimes(1);
  });

  test('an invoice edit repaints the jobs list once — the store half must not paint it too', async () => {
    // p86InvoicesSyncStore refetches /invoices and patches appData.arInvoices.
    // When it ALSO called renderJobsMain, this ran twice for one edit.
    window.p86InvoicesSyncStore = jest.fn(() => Promise.resolve());
    window.renderJobsMain = jest.fn();

    P('invoice', { jobId: 'job_1' });
    await settle();

    expect(window.p86InvoicesSyncStore).toHaveBeenCalledTimes(1);
    expect(window.renderJobsMain).toHaveBeenCalledTimes(1);
  });

  test('a full job-detail refresh SUPPRESSES the narrow money repaint — it is a superset', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadPurchaseOrdersForJob = jest.fn(() => Promise.resolve());
    window.p86JobDetailRefresh = jest.fn(() => true);    // the latch fired
    window.p86RepaintJobMoneyTabs = jest.fn();

    P('po', { jobId: 'job_open' });
    await settle();

    expect(window.p86JobDetailRefresh).toHaveBeenCalledTimes(1);
    // renderJobDetail already repaints the money sections. Running both painted
    // renderPurchaseOrders / renderChangeOrders / renderInvoices twice.
    expect(window.p86RepaintJobMoneyTabs).not.toHaveBeenCalled();
  });

  test('...but a human edit (latch not set) still gets its ONE repaint', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadPurchaseOrdersForJob = jest.fn(() => Promise.resolve());
    window.p86JobDetailRefresh = jest.fn(() => false);   // no pending write
    window.p86RepaintJobMoneyTabs = jest.fn();

    P('po', { jobId: 'job_open' });
    await settle();

    expect(window.p86RepaintJobMoneyTabs).toHaveBeenCalledTimes(1);
  });

  test('NO module outside the registry fires the hub refresh — scanned, not enumerated', () => {
    // The regression this guards is a CALL-SITE one: an editor calls
    // window.p86JobsHubRefresh() and THEN p86Refresh(...), whose surface calls
    // it again. Two hub refetches and two repaints, 200ms apart, per edit.
    //
    // This used to name purchase-order-editor.js and change-order-editor.js by
    // hand — and estimate-editor.js sat outside that list with a live call for
    // a whole release. An invariant enforced by enumerating call sites leaks,
    // so the check now walks EVERY file in js/.
    //
    // jobs-hub.js is the one exclusion, and it is structural rather than a
    // grandfather clause: that module DEFINES window.p86JobsHubRefresh, and
    // its own bill editor uses it to reload the list it just wrote to on a
    // path that does not also call p86Refresh.
    const OWNER = 'jobs-hub.js';
    const offenders = SOURCES
      .filter((s) => s.file !== 'refresh.js' && s.file !== OWNER)
      .map((s) => ({ file: s.file, calls: (codeOnly(s.src).match(/window\.p86JobsHubRefresh\s*\(/g) || []).length }))
      .filter((s) => s.calls > 0);
    expect(offenders).toEqual([]);
  });

  test('...and that scan can actually see a call — it is not matching nothing', () => {
    // Guards the guard: if codeOnly() or the pattern ever stopped matching, the
    // test above would pass on a codebase full of offenders.
    expect(codeOnly('window.p86JobsHubRefresh();').match(/window\.p86JobsHubRefresh\s*\(/g)).toHaveLength(1);
    // Comments in the money editors deliberately quote the old bad call, so the
    // scan must read code only or it would fail on prose describing the fix.
    expect(codeOnly('// used to call window.p86JobsHubRefresh() itself')).not.toContain('p86JobsHubRefresh');
    // The regression that made this scan blind: a `/*` inside a STRING must not
    // hide the code that follows it. This is the exact shape in
    // estimate-editor.js — accept="application/pdf,image/*" — which swallowed a
    // live call and made the scan report a clean file.
    const trap = 'var a = "application/pdf,image/*";\nwindow.p86JobsHubRefresh();';
    expect(codeOnly(trap).match(/window\.p86JobsHubRefresh\s*\(/g)).toHaveLength(1);
    // And the owner really does still contain one, so OWNER is a live
    // exclusion rather than a leftover.
    const owner = SOURCES.find((s) => s.file === 'jobs-hub.js');
    expect(codeOnly(owner.src).match(/window\.p86JobsHubRefresh\s*\(/g) || []).toHaveLength(1);
  });
});

// ── a bulk action touches N jobs, not just the last one ─────────────────────
describe('coalescing keeps every job, not the last', () => {
  test('three jobs changed in one window all get their store patched', async () => {
    window.loadBillsForJob = jest.fn(() => Promise.resolve());

    P('bill', { jobId: 'job_a' });
    P('bill', { jobId: 'job_b' });
    P('bill', { jobId: 'job_c' });
    await settle();

    const jobs = window.loadBillsForJob.mock.calls.map((c) => c[0]).sort();
    // Collapsing opts.jobId last-wins meant job_a and job_b silently kept their
    // pre-write rows while the surface repainted and reported success.
    expect(jobs).toEqual(['job_a', 'job_b', 'job_c']);
  });
});

// ── every entry must be REACHABLE and point at something REAL ───────────────
describe('registry honesty', () => {
  // A path is "published" when some module in js/ assigns its root onto window
  // (or declares it as a top-level function), and — for a dotted path — that
  // same module names the member. This is deliberately a SOURCE check: the
  // defect it exists to catch is `report -> p86Reports.refresh`, a namespace no
  // module has ever created, which no runtime stub could ever reveal.
  function publishedBy(dotted) {
    const [root, member] = String(dotted).split('.');
    const rootRe = new RegExp('(?:window\\.' + root + '\\s*=)|(?:^\\s*function\\s+' + root + '\\s*\\()', 'm');
    const owners = SOURCES.filter((s) => rootRe.test(s.src));
    if (!owners.length) return null;
    if (!member) return owners.map((o) => o.file);
    const memberRe = new RegExp('(?:^|[^\\w.$])' + member + '\\s*[:=]', 'm');
    const withMember = owners.filter((o) => memberRe.test(o.src));
    return withMember.length ? withMember.map((o) => o.file) : null;
  }

  test('every path the registry can call is actually published by a module', () => {
    const dead = P.paths().filter((p) => !publishedBy(p));
    expect(dead).toEqual([]);
  });

  test('the check is real — a path nobody publishes is reported dead', () => {
    // The exact entry that shipped: window.p86Reports does not exist anywhere.
    expect(publishedBy('p86Reports.refresh')).toBeNull();
    expect(publishedBy('renderJobsMain')).not.toBeNull();
  });

  test('every type is reachable — a dispatcher target or a p86Refresh() call site', () => {
    const emitted = emittedEntityTypes();
    const clientCalls = new Set();
    SOURCES.filter((s) => s.file !== 'refresh.js').forEach((s) => {
      (s.src.match(/p86Refresh\(\s*'([a-z_]+)'/g) || [])
        .forEach((m) => clientCalls.add(m.replace(/.*'([a-z_]+)'.*/, '$1')));
    });
    // Exactly ONE dispatch site passes the type indirectly: the Jobs Hub bulk
    // bar maps its list key to a refresh type. Read that map rather than
    // loosening the scan into a string search that would wave anything through.
    const hub = SOURCES.find((s) => s.file === 'jobs-hub.js').src;
    const bulkMap = hub.match(/BULK_REFRESH_TYPE\s*=\s*\{([\s\S]*?)\}/);
    expect(bulkMap).not.toBeNull();
    (bulkMap[1].match(/:\s*'([a-z_]+)'/g) || [])
      .forEach((m) => clientCalls.add(m.replace(/.*'([a-z_]+)'.*/, '$1')));
    const unreachable = P.types().filter((t) => !emitted.has(t) && !clientCalls.has(t));
    // `sub` and `project` were exactly this: entries no door could ever fire.
    expect(unreachable).toEqual([]);
  });

  test('every entry declares at least one path', () => {
    const bare = P.types().filter((t) => P.paths(t).length === 0);
    expect(bare).toEqual([]);
  });

  test('the report entry refreshes both surfaces a report can live on', async () => {
    window.appState.currentJobId = 'job_open';
    window.p86Projects = { refreshReports: jest.fn() };
    window.p86JobReportsRefresh = jest.fn();

    P('report', { id: 'rep_1' });
    await settle();

    expect(window.p86Projects.refreshReports).toHaveBeenCalledTimes(1);
    expect(window.p86JobReportsRefresh).toHaveBeenCalledTimes(1);

    delete window.p86Projects;
    delete window.p86JobReportsRefresh;
  });
});

// ── the Jobs Hub bulk bar: one refresh per action, and no visible blank ─────
// The registry surface reaches p86JobsHubRefresh() -> _currentRefetch() ->
// the hub's own refetch. A bulk handler that ALSO called refetch() therefore
// ran cfg.fetch twice ~200ms apart — and because refetch blanks the list to
// "Loading…" first, this double was the one the user could see.
//
// These are source checks that COUNT, because the two failure modes are
// "twice" and "zero" and both pass a truthiness check. They are scoped to a
// single function body rather than the whole module, so an unrelated refetch
// elsewhere can neither mask a regression nor cause a false alarm.
describe('the Jobs Hub bulk bar', () => {
  const HUB = codeOnly(SOURCES.find((s) => s.file === 'jobs-hub.js').src);

  test('both bulk actions funnel through afterBulk — neither refreshes on its own', () => {
    ['bulkSetStatus', 'bulkDelete'].forEach((name) => {
      const body = fnBody(HUB, name);
      expect({ fn: name, found: body !== null }).toEqual({ fn: name, found: true });
      // Anchor: prove we extracted the right function before counting in it.
      expect(body).toContain('bulkConfirm(');
      expect({ fn: name, refetch: (body.match(/\brefetch\s*\(/g) || []).length })
        .toEqual({ fn: name, refetch: 0 });
      expect({ fn: name, storeRefresh: (body.match(/\bbulkRefreshBillStore\s*\(/g) || []).length })
        .toEqual({ fn: name, storeRefresh: 0 });
      expect({ fn: name, afterBulk: (body.match(/\bafterBulk\s*\(/g) || []).length })
        .toEqual({ fn: name, afterBulk: 1 });
    });
  });

  test('afterBulk refreshes the list exactly once, and only when the registry will not', () => {
    const body = fnBody(HUB, 'afterBulk');
    expect(body).not.toBeNull();
    expect({ refetch: (body.match(/\brefetch\s*\(/g) || []).length }).toEqual({ refetch: 1 });
    // The surviving call is the FALLBACK, not the primary. This is the half
    // that matters most: bulkRefreshBillStore returns false when the list has
    // no refresh type or the registry isn't loaded, and a hub that refreshes
    // zero times is worse than one that refreshes twice.
    expect(body).toMatch(/if\s*\(\s*!\s*bulkRefreshBillStore\s*\(\s*ids\s*\)\s*\)\s*refetch\s*\(/);
  });

  test('bulkRefreshBillStore reports whether the registry actually took the write', () => {
    const body = fnBody(HUB, 'bulkRefreshBillStore');
    expect(body).not.toBeNull();
    // Every early exit that skips the registry must answer false, or afterBulk
    // would trust a refresh that never happens.
    expect(body).toMatch(/if\s*\(!type\s*\|\|\s*!window\.p86Refresh\)\s*return false;/);
    expect({ falses: (body.match(/return false;/g) || []).length }).toEqual({ falses: 1 });
    expect({ trues: (body.match(/return true;/g) || []).length }).toEqual({ trues: 2 });
  });

  test('a data-changed refetch does not blank the list to Loading…', () => {
    // p86JobsHubRefresh -> _currentRefetch, which must ask for the quiet form.
    expect(HUB).toMatch(/_currentRefetch\s*=\s*function\s*\(\s*\)\s*\{\s*refetch\(true\);\s*\}/);
    const body = fnBody(HUB, 'refetch');
    expect(body).not.toBeNull();
    expect(body).toMatch(/if\s*\(listEl\s*&&\s*!quiet\)/);
    // Exactly one place can paint the spinner, and it is behind that gate.
    expect({ blanks: (body.match(/jobshub-loading/g) || []).length }).toEqual({ blanks: 1 });
  });

  test('user-initiated loads still show the wait — quiet must not become the default', () => {
    // First paint, both filter selects, and the create modal: four explicit
    // loud loads. Losing these would trade a flicker for a dead-looking page.
    expect({ loud: (HUB.match(/\brefetch\(false\)/g) || []).length }).toEqual({ loud: 4 });
  });
});

// ── THE INVERSE DIRECTION: door → registry ──────────────────────────────────
// Everything above walks registry → door: each declared entry must be real and
// reachable. Nothing checked the other way — that every entity type the SERVER
// dispatcher can emit HAS an entry. That blind spot is exactly why `assembly`
// slipped through a sweep whose stated goal was "everywhere": an agent could
// create, retune or delete a cost recipe and not one surface moved, and every
// registry→door test still passed, because the missing entry was not there to
// be wrong about.
//
// The list of doors is derived from server/services/payload-dispatcher.js, not
// written down here. A hardcoded expectation would rot the first time someone
// added a target — which is the failure this exists to catch.
describe('door → registry: every type the dispatcher can emit is handled', () => {
  // Pure so the "does the check bite" test can run it against a mutilated
  // registry without touching the real one.
  function unhandled(emitted, registered) {
    return [...emitted].filter((t) => !registered.has(t) && !META_TYPES[t]).sort();
  }

  test('the derivation really reads the dispatcher — an empty scrape must not pass silently', () => {
    const emitted = emittedEntityTypes();
    // Both contributions have to be alive: the DISPATCHERS map and the literal
    // result rows. If either regex rots, one of these goes missing and the
    // coverage test below would start passing vacuously.
    expect(emitted.has('assembly')).toBe(true);      // DISPATCHERS key + 3 literals
    expect(emitted.has('deal_memory')).toBe(true);   // DISPATCHERS key
    expect(emitted.has('move')).toBe(true);          // literal only — no DISPATCHERS key
    expect(emitted.has('job')).toBe(true);
    expect(emitted.size).toBeGreaterThanOrEqual(13);
  });

  test('every emitted entity type has a registry entry, or a stated reason not to', () => {
    // `assembly` was the one that failed this: three emit sites in
    // payload-dispatcher.js (create / update / delete) and no entry at all.
    expect(unhandled(emittedEntityTypes(), new Set(P.types()))).toEqual([]);
  });

  test('the check bites — drop the entry that was missing and it is named', () => {
    const without = new Set(P.types());
    without.delete('assembly');
    expect(unhandled(emittedEntityTypes(), without)).toEqual(['assembly']);
  });

  test('the exclusion list is not a place to hide a real type', () => {
    // A type cannot be BOTH excluded as meta and registered — that means
    // somebody added the entry and left the excuse behind, and the next reader
    // cannot tell which one is the truth.
    const both = Object.keys(META_TYPES).filter((t) => P.types().indexOf(t) !== -1);
    expect(both).toEqual([]);
  });

  test('every exclusion is still emitted — no rotted excuses', () => {
    // If the dispatcher stops emitting one of these, the entry here is dead
    // documentation pointing at a door that no longer exists.
    const emitted = emittedEntityTypes();
    const rotted = Object.keys(META_TYPES).filter((t) => !emitted.has(t));
    expect(rotted).toEqual([]);
  });

  test('every exclusion carries a real reason, not an empty string', () => {
    const unjustified = Object.keys(META_TYPES)
      .filter((t) => !META_TYPES[t] || String(META_TYPES[t]).trim().length < 40);
    expect(unjustified).toEqual([]);
  });

  test('an agent assembly write refreshes the recipe list exactly once', async () => {
    // COUNT, not truthiness. The two failure modes are "zero" (what shipped)
    // and "twice" (what a careless fix produces).
    window.p86Assemblies = { renderList: jest.fn() };

    P.fromTargets([
      { entity_type: 'assembly', entity_id: 11 },
      { entity_type: 'assembly', entity_id: 12 },
      { entity_type: 'assembly', entity_id: 13 }
    ], 'pay_asm');
    await settle();

    expect(window.p86Assemblies.renderList).toHaveBeenCalledTimes(1);
    // Bare call: renderList keeps whichever host prefix and view filter the
    // visible Assembly Studio tab set. Passing a prefix here would yank the
    // user's Parametric filter off under them.
    expect(window.p86Assemblies.renderList).toHaveBeenCalledWith();

    delete window.p86Assemblies;
  });

  test('an assembly write does NOT also drive the Studio cockpit — console.js already does', async () => {
    // js/console.js has its own visibility-gated p86:payload-applied listener
    // for the research inbox + tuning queue. Naming them in the registry too
    // would refresh them twice per applied card.
    window.p86Assemblies = { renderList: jest.fn() };
    window.p86Console = { loadAssemblyStudio: jest.fn() };

    P('assembly', { id: 9 });
    await settle();

    expect(window.p86Console.loadAssemblyStudio).not.toHaveBeenCalled();

    delete window.p86Assemblies;
    delete window.p86Console;
  });
});
