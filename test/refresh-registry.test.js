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
//
// CRLF IS NORMALISED FIRST, and that is not cosmetic. Every file in js/ is
// checked out with CRLF endings (core.autocrlf), and JS `.` does not match \r —
// so `//.*$` could never reach the end of a real line and this function stripped
// NOTHING on any actual source file in the repo. It only looked correct because
// its own fixtures were LF and because the one pattern it fed was
// `window.`-qualified while the prose that quotes the forbidden call uses the
// bare form. The moment the scan below widened to the bare form, every comment
// describing the fix would have been reported as an offender. Same failure
// shape as the phantom comment: a stripper that silently does nothing.
function codeOnly(src) {
  return String(src)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, '$1'))
    .join('\n');
}

// A CALL to the hub refresh, in either form it can be written: `window.`-
// qualified or the bare global. The leading class excludes `.` and `$`/word
// chars so `foo.p86JobsHubRefresh(` is not counted, and requiring `(` means the
// assignment that DEFINES it is not counted either.
const HUB_CALL = /(^|[^\w.$])(?:window\.)?p86JobsHubRefresh\s*\(/g;

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
//
// The two are kept SEPARATE rather than merged in one pass, because their union
// cannot tell you whether both are alive. Today every DISPATCHERS key also
// appears as a literal, so the map contributes nothing UNIQUE to the union: if
// its regex rots the union does not shrink by a single type, and an assertion
// on the union (or on named canaries like `assembly` / `job`) still passes on
// the literals alone. Proven by breaking the map regex and adding a map-only
// target — the whole group stayed green. So each contribution is asserted on
// its OWN size below.
function dispatcherMapKeys() {
  const out = new Set();
  const map = DISPATCHER_SRC.match(/const DISPATCHERS\s*=\s*\{([\s\S]*?)\n\};/);
  if (map) (map[1].match(/^\s*([a-z_]+)\s*:/gm) || [])
    .forEach((m) => out.add(m.replace(/[\s:]/g, '')));
  return out;
}
function dispatcherLiteralTypes() {
  const out = new Set();
  (DISPATCHER_SRC.match(/entity_type:\s*'([a-z_]+)'/g) || [])
    .forEach((m) => out.add(m.replace(/.*'([a-z_]+)'.*/, '$1')));
  return out;
}
function emittedEntityTypes() {
  return new Set([...dispatcherMapKeys(), ...dispatcherLiteralTypes()]);
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
    // p86JobsHubRefresh() and THEN p86Refresh(...), whose surface calls it
    // again. Two hub refetches and two repaints, 200ms apart, per edit.
    //
    // This used to name purchase-order-editor.js and change-order-editor.js by
    // hand — and estimate-editor.js sat outside that list with a live call for
    // a whole release. An invariant enforced by enumerating call sites leaks,
    // so the check now walks EVERY file in js/.
    //
    // js/refresh.js is now the ONLY exclusion. jobs-hub.js used to be a second
    // one because its own bill editor reloaded the list it had just written to;
    // that path routes through p86Refresh.now('bill') instead, so the exception
    // is gone rather than grandfathered — the module that DEFINES the function
    // is held to the same rule as everything else.
    //
    // The pattern matches the BARE global as well as the window.-qualified
    // form. p86JobsHubRefresh IS a global, so `p86JobsHubRefresh()` on its own
    // was a call this scan could not see: "enforced, not remembered" was only
    // three-quarters true.
    const offenders = SOURCES
      .filter((s) => s.file !== 'refresh.js')
      .map((s) => ({ file: s.file, calls: (codeOnly(s.src).match(HUB_CALL) || []).length }))
      .filter((s) => s.calls > 0);
    expect(offenders).toEqual([]);
  });

  test('...and that scan can actually see a call — it is not matching nothing', () => {
    // Guards the guard: if codeOnly() or the pattern ever stopped matching, the
    // test above would pass on a codebase full of offenders.
    expect('window.p86JobsHubRefresh();'.match(HUB_CALL)).toHaveLength(1);
    // The bare global — the form the old pattern was blind to.
    expect('  p86JobsHubRefresh();'.match(HUB_CALL)).toHaveLength(1);
    expect('if (x) p86JobsHubRefresh();'.match(HUB_CALL)).toHaveLength(1);
    // ...but the DEFINITION is not a call, or the owner would report itself.
    expect('window.p86JobsHubRefresh = function () { refetch(true); };'.match(HUB_CALL)).toBeNull();
    // Comments in the money editors deliberately quote the old bad call, so the
    // scan must read code only or it would fail on prose describing the fix.
    expect(codeOnly('// used to call window.p86JobsHubRefresh() itself')).not.toContain('p86JobsHubRefresh');
    expect(codeOnly('  // a bare p86JobsHubRefresh() repainted from a stale store')).not.toContain('p86JobsHubRefresh');
    // CRLF: every file in js/ is checked out with \r\n, and JS `.` does not
    // match \r — so `//.*$` could not reach end-of-line and codeOnly stripped
    // nothing at all on real source. With the bare form now in the pattern,
    // that hole would have failed this suite on prose in four modules.
    expect(codeOnly('  // calls p86JobsHubRefresh() itself\r\nvar x = 1;')).not.toContain('p86JobsHubRefresh');
    // The regression that made this scan blind: a `/*` inside a STRING must not
    // hide the code that follows it. This is the exact shape in
    // estimate-editor.js — accept="application/pdf,image/*" — which swallowed a
    // live call and made the scan report a clean file.
    const trap = 'var a = "application/pdf,image/*";\nwindow.p86JobsHubRefresh();';
    expect(codeOnly(trap).match(HUB_CALL)).toHaveLength(1);
    // And with the trap in CRLF, which is how it actually sits on disk.
    const trapCrlf = 'var a = "application/pdf,image/*";\r\nwindow.p86JobsHubRefresh();\r\n';
    expect(codeOnly(trapCrlf).match(HUB_CALL)).toHaveLength(1);
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
    // EACH CONTRIBUTION IS ASSERTED ON ITS OWN SIZE. The previous version of
    // this test asserted on the UNION and claimed "if either regex rots, one of
    // these goes missing" — which was false. Every DISPATCHERS key is ALSO an
    // `entity_type: '<literal>'` in a result row, so the map contributes zero
    // unique types: with the map regex broken the union is unchanged and all
    // four named canaries (assembly / deal_memory / move / job) survive on the
    // literals alone. Verified by breaking the map regex AND adding a map-only
    // target — the whole group stayed 8/8 green.
    expect(dispatcherMapKeys().size).toBeGreaterThanOrEqual(13);
    expect(dispatcherLiteralTypes().size).toBeGreaterThanOrEqual(14);
    // And each half must carry a type the other half cannot supply, so neither
    // can be satisfied by the other's output.
    expect(dispatcherMapKeys().has('assembly')).toBe(true);
    expect([...dispatcherLiteralTypes()].filter((t) => !dispatcherMapKeys().has(t)))
      .toEqual(['move']);   // target-level op — a literal with no DISPATCHERS key
    const emitted = emittedEntityTypes();
    expect(emitted.has('deal_memory')).toBe(true);
    expect(emitted.has('job')).toBe(true);
    expect(emitted.size).toBeGreaterThanOrEqual(14);
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
    // NULL PREFIX: renderList keeps whichever host prefix and view filter the
    // visible Assembly Studio tab set. Passing a prefix here would yank the
    // user's Parametric filter off under them.
    //
    // QUIET: renderList blanks its host to "Loading assemblies…" before it
    // fetches, so a data-changed refresh was blanking a list the user was
    // already reading — the exact rule this same pass had just enforced for the
    // Jobs Hub, broken one entry away. The mode lives in renderList; this only
    // asks for it.
    expect(window.p86Assemblies.renderList).toHaveBeenCalledWith(null, { quiet: true });

    delete window.p86Assemblies;
  });

  test('renderList really HAS a quiet mode — asking for one it ignores is worse than not asking', () => {
    // Source check: the registry passing { quiet: true } proves nothing unless
    // the blank is actually behind that flag.
    const asm = codeOnly(SOURCES.find((s) => s.file === 'assemblies.js').src);
    const body = fnBody(asm, 'renderList');
    expect(body).not.toBeNull();
    expect(body).toMatch(/if\s*\(!\(opts\s*&&\s*opts\.quiet\)\)\s*host\.innerHTML\s*=/);
    // Exactly one place can paint the spinner, and it is behind that gate.
    expect({ blanks: (body.match(/Loading assemblies/g) || []).length }).toEqual({ blanks: 1 });
    // And a quiet refresh must not be mistaken for a VIEW SWITCH: keying the
    // filter reset on `opts` being truthy would drop the user's Parametric
    // filter every time a recipe was saved.
    expect(body).toMatch(/hasOwnProperty\.call\(opts,\s*'parametricOnly'\)/);
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

// ── the sequencing seam: p86Refresh.now ─────────────────────────────────────
// p86Refresh() coalesces on a timer and returns nothing, so a caller that has
// to hand control back to a callback AFTER the store patch lands could not use
// it — and js/jobs-hub.js's bill editor therefore hand-rolled its own
// store-then-surface pair, which then drifted from the registry and lost the
// p86RepaintJobMoneyTabs fallback entirely. `now` closes that gap so the copy
// can be deleted rather than kept in sync.
describe('p86Refresh.now — the promise-returning seam', () => {
  test('resolves only AFTER the store patch lands, so a caller can sequence on it', async () => {
    const order = [];
    let release;
    window.loadBillsForJob = jest.fn(() => {
      order.push('store-start');
      return new Promise((res) => { release = () => { order.push('store-done'); res(); }; });
    });
    window.renderJobsMain = jest.fn(() => { order.push('surface'); });

    let settled = false;
    const p = P.now('bill', { jobId: 'job_1' }).then(() => { order.push('onSaved'); settled = true; });

    await Promise.resolve();
    expect(order).toEqual(['store-start']);
    expect(settled).toBe(false);          // onSaved has NOT fired

    release();
    await p;

    // The exact ordering the bill editor depends on: the refetch, then the
    // repaint, then the caller's callback. Firing onSaved first is what painted
    // the pre-write numbers and made a saved bill look unsaved.
    expect(order).toEqual(['store-start', 'store-done', 'surface', 'onSaved']);
  });

  test('runs immediately — it does not wait out the coalescing window', async () => {
    window.loadBillsForJob = jest.fn(() => Promise.resolve());
    P.now('bill', { jobId: 'job_1' });
    await Promise.resolve();
    // No jest.advanceTimersByTime: a user pressing Save must not sit through a
    // 200ms debounce before the list they are looking at is refetched.
    expect(window.loadBillsForJob).toHaveBeenCalledWith('job_1', true);
  });

  test('takes the SAME registry path — forced refetch, then the money surfaces', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadBillsForJob = jest.fn(() => Promise.resolve());
    window.renderJobsMain = jest.fn();
    window.p86JobsHubRefresh = jest.fn();
    window.p86JobDetailRefresh = jest.fn(() => false);   // human edit — latch not set
    window.p86RepaintJobMoneyTabs = jest.fn();

    await P.now('bill', { jobId: 'job_open' });

    expect(window.loadBillsForJob).toHaveBeenCalledWith('job_open', true);
    expect(window.renderJobsMain).toHaveBeenCalledTimes(1);
    expect(window.p86JobsHubRefresh).toHaveBeenCalledTimes(1);
    // THE F0 DEFECT: the hand-rolled copy called p86JobDetailRefresh and stopped
    // there. It is latch-gated and returns false for a human edit, so a bill
    // edited from the Bills tab repainted the open job's money tabs ZERO times.
    expect(window.p86RepaintJobMoneyTabs).toHaveBeenCalledTimes(1);
  });

  test('an unknown type is a resolved promise, never a throw and never a hang', async () => {
    await expect(P.now('wormhole', { jobId: 'x' })).resolves.toBeUndefined();
    await expect(P.now(null)).resolves.toBeUndefined();
  });

  test('a rejecting store still resolves — a failed refetch must not strand onSaved', async () => {
    window.loadBillsForJob = jest.fn(() => Promise.reject(new Error('offline')));
    window.renderJobsMain = jest.fn();
    await P.now('bill', { jobId: 'job_1' });
    expect(window.renderJobsMain).toHaveBeenCalled();
  });

  test('it absorbs anything already queued in the window rather than running twice', async () => {
    window.loadBillsForJob = jest.fn(() => Promise.resolve());
    window.renderJobsMain = jest.fn();

    P('bill', { jobId: 'job_a' });          // queued on the timer
    await P.now('bill', { jobId: 'job_b' }); // flushes the bucket, both jobs
    await settle();                          // and the timer must find nothing left

    const jobs = window.loadBillsForJob.mock.calls.map((c) => c[0]).sort();
    expect(jobs).toEqual(['job_a', 'job_b']);
    expect(window.renderJobsMain).toHaveBeenCalledTimes(1);
  });

  test('refreshBillRollup is the registry, not a copy of it', () => {
    // Source check. The runtime tests above prove `now` behaves; this proves the
    // bill editor actually goes through it. A second implementation that merely
    // happens to agree today is what produced F0 in the first place.
    const hub = codeOnly(SOURCES.find((s) => s.file === 'jobs-hub.js').src);
    const body = fnBody(hub, 'refreshBillRollup');
    expect(body).not.toBeNull();
    expect(body).toMatch(/window\.p86Refresh\.now\('bill',\s*\{\s*jobId:\s*jobId\s*\}\)/);
    // And it no longer hand-rolls any of the three halves.
    expect({ loader: (body.match(/loadBillsForJob\s*\(/g) || []).length }).toEqual({ loader: 0 });
    expect({ paint: (body.match(/renderJobsMain\s*\(/g) || []).length }).toEqual({ paint: 0 });
    expect({ detail: (body.match(/p86JobDetailRefresh\s*\(/g) || []).length }).toEqual({ detail: 0 });
  });

  test('every bill mutation still AWAITS the rollup before handing back onSaved', () => {
    // save / setStatus / del / create — all four must chain, not fire-and-forget.
    // submitCreate was the one that did not: it called refreshBillRollup and
    // then onSaved on the next line.
    const hub = codeOnly(SOURCES.find((s) => s.file === 'jobs-hub.js').src);
    // `(?<!function )` so the declaration is not counted as a call site.
    const calls = hub.match(/(?<!function )refreshBillRollup\(/g) || [];
    expect(calls.length).toBe(4);
    // Each one is either returned into a .then chain or has .then( on it.
    const orphaned = hub
      .split('\n')
      .filter((l) => /refreshBillRollup\(/.test(l) && !/function refreshBillRollup\(/.test(l))
      .filter((l) => !/return\s+refreshBillRollup\(/.test(l) && !/refreshBillRollup\([^)]*\)\.then\(/.test(l));
    expect(orphaned).toEqual([]);
  });
});

// ── THE THIRD DIRECTION: client mutation sites → registry ───────────────────
// The two existing guards walk registry → door and door → registry. BOTH are
// blind to the same thing: client code that mutates a known store or drives a
// known loader/painter WITHOUT going through p86Refresh at all. Such a site has
// no registry entry to be wrong about and emits no dispatcher target, so it is
// invisible to every check above.
//
// js/doc-import.js was exactly that. Bulk Document Import creates purchase
// orders, change orders and vendor bills — contract and committed-cost dollars —
// and contained ZERO p86Refresh calls. It hand-concated create responses into
// appData.jobPurchaseOrders / jobChangeOrders, called loadBillsForJob() unforced
// and unawaited (so it could join a GET issued before the write), and finished
// with one bare renderJobsMain(). It went through a sweep whose stated goal was
// "everywhere" untouched, because nothing was looking in this direction.
//
// The allowlist below is NAMED AND JUSTIFIED, per file per symbol, exactly like
// META_TYPES — not a loosened pattern. A pattern that quietly matches the
// legitimate sites would also quietly match the next doc-import.js.
//
// WHAT IT WATCHES, all three derived from source and not from a brief:
//   · the five server-backed money mirrors on appData (cross-checked against
//     the boot hydrate in js/app.js), written by assignment, by computed key,
//     by in-place array mutation, or by truncating .length;
//   · the three load*ForJob money loaders (the whole set — scanned for, not
//     assumed), with an UNFORCED call reported as its own separate finding;
//   · all four repainters in refresh.js's REPAINT_JOB_MONEY_PATHS, in the
//     `window.`-qualified and bare-global spellings alike.
//
// AND WHAT IT DOES NOT: it matches text, so any indirection through a variable
// walks past it. That is not left to be discovered — the misses are pinned as
// a test of their own further down, so the guard cannot quietly imply a reach
// it does not have.
describe('mutation site → registry: nothing patches a money store behind the registry', () => {
  // The read-caches the registry declares as its own `store` half. Cross-checked
  // against js/app.js, which is where the boot hydrate seeds them: these five are
  // the SERVER-backed per-job money mirrors, and they are exactly the four the
  // registry's jobIdsFor() reads plus the subs directory.
  //
  // DELIBERATELY NOT LISTED, and this is a distinction the guard would be wrong
  // to blur: appData.purchaseOrders / changeOrders / invoices / subs. Those are
  // the LEGACY localStorage blobs (app.js seeds them from
  // safeLoadJSON('p86-jobs-purchaseorders') and friends) — the dead-store bug
  // class, not tables. No registry entry owns them, no dispatcher target names
  // them, and folding them in here would light up a dozen legacy filter/splice
  // sites that have nothing to do with the refresh heartbeat, which is how an
  // allowlist becomes noise nobody reads.
  const STORE_MIRRORS = ['jobPurchaseOrders', 'jobChangeOrders', 'jobVendorBills', 'arInvoices', 'subsDirectory'];
  // The money loaders the registry drives as its `store` half. Calling one
  // directly is doing by hand what the registry exists to do in one place, in
  // the right order.
  //
  // These three are the whole set, checked by scanning js/ for load*ForJob.
  // The one other match — loadPOsForJob in js/jobs-hub.js — is a LOCAL closure
  // inside the create-bill overlay that fills a <select> from the API and
  // touches no store, so it is not a sibling and is not listed. (Noted because
  // a future "just widen it to load\w+ForJob" would sweep it in and teach the
  // next reader that the allowlist is full of things that don't matter.)
  const MONEY_LOADERS = ['loadBillsForJob', 'loadPurchaseOrdersForJob', 'loadChangeOrdersForJob'];
  // The repainters the registry owns — REPAINT_JOB_MONEY_PATHS in js/refresh.js,
  // verbatim. Only renderJobsMain used to be checked here, which left three of
  // the four unwatched; p86JobsHubRefresh had its own single-name scan above and
  // p86JobDetailRefresh / p86RepaintJobMoneyTabs had nothing at all.
  const REPAINTERS = ['renderJobsMain', 'p86JobsHubRefresh', 'p86JobDetailRefresh', 'p86RepaintJobMoneyTabs'];
  const CALLABLES = MONEY_LOADERS.concat(REPAINTERS);

  // A reference to a mirror, in BOTH spellings: `appData.jobVendorBills` and the
  // computed `appData['jobVendorBills']`. The computed form is the obvious way
  // to walk past a dot-only pattern, so it is matched rather than left as a
  // documented hole.
  const MIRROR_ALT = STORE_MIRRORS.join('|');
  const MIRROR_REF = "(?:^|[^\\w.$])(?:window\\.)?appData\\s*(?:\\.(" + MIRROR_ALT +
                     ")|\\[\\s*['\"](" + MIRROR_ALT + ")['\"]\\s*\\])";
  // In-place array mutation. doc-import.js used `= (…||[]).concat(rec)`, so the
  // `=` half is what actually shipped — but `.push(rec)` is the same defect one
  // keystroke away, and a guard that only knows the shape of the bug it already
  // found is a guard for last week.
  const MUTATORS = 'push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin';
  const WRITE_RE = new RegExp(
    MIRROR_REF + "\\s*(?:=(?!=)|\\.(?:" + MUTATORS + ")\\s*\\(|\\.length\\s*=(?!=))", 'gm');
  const CALL_RE = new RegExp('(?:^|[^\\w.$])(?:window\\.)?(' + CALLABLES.join('|') + ')\\s*\\(', 'gm');

  // The argument list of the call whose `(` is at `openIdx`, brace-balanced.
  function argsAt(code, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < code.length; i++) {
      const c = code[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) return code.slice(openIdx + 1, i); }
    }
    return null;
  }
  function topLevelCommas(args) {
    let depth = 0, n = 0;
    for (const c of args) {
      if ('([{'.indexOf(c) !== -1) depth++;
      else if (')]}'.indexOf(c) !== -1) depth--;
      else if (c === ',' && depth === 0) n++;
    }
    return n;
  }

  // Every symbol a file touches behind the registry's back. A money loader called
  // with a SINGLE argument reports twice — once as a direct call, and once as
  // `<loader> (no force)`, because omitting `force` is a defect in its own right:
  // every load*ForJob is in-flight deduped per job, so an unforced call issued
  // after a write JOINS the GET that was issued before it and resolves with
  // pre-write rows. That is the exact trap refresh.js's loadAll() passes `true`
  // to avoid, and it is what doc-import.js did. Two symbols, two justifications:
  // "I own this loader" and "I meant to share the in-flight GET" are different
  // claims and should have to be made separately.
  function bypassesIn(src) {
    const code = codeOnly(src);
    const hits = new Set();
    let m;
    WRITE_RE.lastIndex = 0; while ((m = WRITE_RE.exec(code))) hits.add(m[1] || m[2]);
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(code))) {
      const sym = m[1];
      hits.add(sym);
      if (MONEY_LOADERS.indexOf(sym) === -1) continue;
      const open = code.indexOf('(', m.index + m[0].length - 1);
      const args = argsAt(code, open);
      // No args at all is a no-op call, not an unforced refetch.
      if (args !== null && args.trim() !== '' && topLevelCommas(args) === 0) hits.add(sym + ' (no force)');
    }
    return [...hits].sort();
  }

  // file → symbol → why this one is NOT a bypass. Every entry is a claim someone
  // had to write down; adding a file here is meant to be uncomfortable.
  const ALLOWED = {
    'app.js': {
      jobPurchaseOrders: 'The boot hydrate. loadData()/p86ReloadAllData SEED these mirrors from the server and from the localStorage cache — they are the read-cache the registry then patches, not a mutation behind it.',
      jobChangeOrders:   'Same boot hydrate as jobPurchaseOrders: the initial seed of the mirror, which is the thing every other site must go through the registry to amend.',
      jobVendorBills:    'Same boot hydrate: the bills list is fetched once at load and handed to appData wholesale, before any editor exists to write through the registry.',
      arInvoices:        'Same boot hydrate: AR invoices are seeded here; the registry `invoice` entry patches them afterwards via p86InvoicesSyncStore.',
      subsDirectory:     'Same boot hydrate for the subcontractor directory, which js/subs.js then owns.',
      renderJobsMain:    'app.js owns the post-hydrate fan-out. When a full appData reload lands, every list repaints from here — that IS the `job`/`estimate` registry entry running, not a bypass of it.',
      p86JobDetailRefresh: 'Same post-hydrate fan-out (fanOutRenderers). The open job page must repaint AFTER the appData load installs its objects, not off an event that races it — and the call is latch-gated, so it no-ops unless an agent write is actually pending. Firing a registry type here would re-enter the hydrate that is running.'
    },
    'jobs.js': {
      loadBillsForJob:          'DEFINES it, and is the module the registry `bill` store calls. Its own internal reads (a money tab opening) legitimately share the in-flight GET.',
      loadPurchaseOrdersForJob: 'DEFINES it — the registry `po` store resolves this very function off window.',
      loadChangeOrdersForJob:   'DEFINES it — the registry `co` store resolves this very function off window.',
      'loadBillsForJob (no force)':          'The money-tab OPEN path (Promise.all at the top of the bills/PO tab render). Opening a tab is navigation, not a write, so joining an in-flight GET is the point — it is a shared read, and forcing here would issue a duplicate fetch on every tab switch.',
      'loadPurchaseOrdersForJob (no force)': 'Same money-tab open: paired with loadBillsForJob in one Promise.all so the tab paints once both reads land. No write preceded it, so there is no pre-write GET to be fooled by.',
      'loadChangeOrdersForJob (no force)':   'The change-order tab open, same shape and same reason: a view transition reading rows it does not yet have, deliberately sharing whatever fetch is already in flight for that job.',
      renderJobsMain:           'DEFINES it, and re-paints the jobs list on its own view transitions (opening/closing the list), which are navigation, not data changes.',
      jobPurchaseOrders:        'The loader body: loadPurchaseOrdersForJob is where the mirror is legitimately replaced for a job, and it is what the registry calls to do so.',
      jobChangeOrders:          'The loader body: loadChangeOrdersForJob writes the mirror it exists to refresh.',
      jobVendorBills:           'The loader body: loadBillsForJob writes the mirror it exists to refresh.'
    },
    'invoices.js': {
      arInvoices: 'This IS the registry `invoice` store half — p86InvoicesSyncStore refetches /invoices and patches appData.arInvoices. The registry names it in the entry`s paths.'
    },
    'subs.js': {
      subsDirectory: 'Owns the subcontractor directory and refetches it on its own page. `sub` was deliberately REMOVED from the registry because no door emits it, so there is no entry to route through.'
    },
    'purchase-order-editor.js': {
      jobVendorBills: 'syncBillsToStore mirrors the PO editor`s LIVE, not-yet-saved bill rows into the store so the %-billed rollup reflects typing. It is a local echo of unsaved edits, not a post-write refresh; the editor`s save path does call p86Refresh.'
    },
    'admin.js': {
      renderJobsMain: 'loadUsersCache repaints after the USER-NAME cache lands, not after a money write. No entity row changed, so there is no registry type to fire and firing one would refetch money for nothing.'
    },
    'job-costs-import.js': {
      renderJobsMain: 'The QuickBooks cost import patches appData.qbCostLines — a store with no registry entry and no dispatcher door — and repaints the list that reads it. Wiring it would mean adding a `qb_cost` type nothing can emit.'
    },
    'estimate-editor.js': {
      renderJobsMain: 'syncEstimateToJob mirrors contract + estimated cost onto the local job and saves. The registry `job` entry is a FULL appData hydrate, which here would race the saveData it just issued and re-seed from localStorage; the narrow repaint is deliberate.'
    }
  };

  test('every client bypass of the refresh registry is named and justified', () => {
    const unjustified = [];
    SOURCES.filter((s) => s.file !== 'refresh.js').forEach((s) => {
      bypassesIn(s.src).forEach((sym) => {
        if (!ALLOWED[s.file] || !ALLOWED[s.file][sym]) unjustified.push(s.file + ' → ' + sym);
      });
    });
    // js/doc-import.js was this list, four entries long, on a money surface.
    expect(unjustified.sort()).toEqual([]);
  });

  test('the allowlist is not a graveyard — every entry is still a real site', () => {
    // An excuse for a call that no longer exists is dead documentation, and it
    // is how an allowlist turns into a place to hide the next one.
    const rotted = [];
    Object.keys(ALLOWED).forEach((file) => {
      const s = SOURCES.find((x) => x.file === file);
      if (!s) { rotted.push(file + ' (no such file)'); return; }
      const live = bypassesIn(s.src);
      Object.keys(ALLOWED[file]).forEach((sym) => {
        if (live.indexOf(sym) === -1) rotted.push(file + ' → ' + sym);
      });
    });
    expect(rotted.sort()).toEqual([]);
  });

  test('every justification is a real reason, not a shrug', () => {
    const thin = [];
    Object.keys(ALLOWED).forEach((file) => {
      Object.keys(ALLOWED[file]).forEach((sym) => {
        const why = ALLOWED[file][sym];
        if (!why || String(why).trim().length < 60) thin.push(file + ' → ' + sym);
      });
    });
    expect(thin).toEqual([]);
  });

  test('the scanner BITES — the exact shapes doc-import.js used are all caught', () => {
    // Guards the guard. Every pattern below is copied from what shipped.
    expect(bypassesIn('window.appData.jobPurchaseOrders = (window.appData.jobPurchaseOrders || []).concat(rec);'))
      .toEqual(['jobPurchaseOrders']);
    expect(bypassesIn('appData.jobChangeOrders = [];')).toEqual(['jobChangeOrders']);
    expect(bypassesIn('window.loadBillsForJob(it.jobId);'))
      .toEqual(['loadBillsForJob', 'loadBillsForJob (no force)']);
    expect(bypassesIn('  renderJobsMain();')).toEqual(['renderJobsMain']);
    expect(bypassesIn('if (typeof window.renderJobsMain === "function") window.renderJobsMain();'))
      .toEqual(['renderJobsMain']);
    // The unforced loader call is doc-import's OTHER defect and reports as its
    // own symbol, so it cannot be waved through by an excuse written about
    // owning the loader.
    expect(bypassesIn('loadBillsForJob(it.jobId);'))
      .toEqual(['loadBillsForJob', 'loadBillsForJob (no force)']);
    expect(bypassesIn('loadBillsForJob(jobId, true);')).toEqual(['loadBillsForJob']);
    // A nested call in the first argument is still ONE argument — the comma
    // scan is depth-aware, or `f(pick(a, b))` would read as forced.
    expect(bypassesIn('loadBillsForJob(pick(a, b));'))
      .toEqual(['loadBillsForJob', 'loadBillsForJob (no force)']);
  });

  test('the scanner catches the shapes doc-import did NOT use but the next one might', () => {
    // Widened beyond the bug that was found. None of these exists in js/ today
    // (verified: the whole tree's mirror writes are plain assignments), so every
    // one of them is here to fail the FIRST time someone writes it.
    expect(bypassesIn('appData.jobPurchaseOrders.push(rec);')).toEqual(['jobPurchaseOrders']);
    expect(bypassesIn('window.appData.jobVendorBills.splice(i, 1);')).toEqual(['jobVendorBills']);
    expect(bypassesIn('appData.arInvoices.unshift(row);')).toEqual(['arInvoices']);
    expect(bypassesIn('appData.jobChangeOrders.length = 0;')).toEqual(['jobChangeOrders']);
    // The computed property name — the obvious way around a dot-only pattern.
    expect(bypassesIn("appData['jobPurchaseOrders'] = rows;")).toEqual(['jobPurchaseOrders']);
    expect(bypassesIn('window.appData["arInvoices"].push(r);')).toEqual(['arInvoices']);
    // The three repainters that were NOT watched before this widening.
    expect(bypassesIn('p86JobsHubRefresh();')).toEqual(['p86JobsHubRefresh']);
    expect(bypassesIn('window.p86JobDetailRefresh(jobId);')).toEqual(['p86JobDetailRefresh']);
    expect(bypassesIn('p86RepaintJobMoneyTabs(String(cur));')).toEqual(['p86RepaintJobMoneyTabs']);
    // A call built inside a template literal is still source text, and is caught
    // for the same reason the `image/*` one is: nothing is being pre-stripped.
    expect(bypassesIn('var s = `${renderJobsMain()}`;')).toEqual(['renderJobsMain']);
  });

  // ── WHAT THIS SCANNER DOES NOT CATCH ──────────────────────────────────────
  // A source scan is only as good as its parser, and the honest failure of a
  // guard like this is not "it broke" — it is "it kept passing". So the misses
  // are pinned as tests rather than left to be discovered. If one of these ever
  // starts being caught, this test fails and the comment above the guard gets
  // to become less apologetic.
  //
  // Every miss below shares one root: the scanner matches TEXT, it does not
  // resolve VALUES. An indirection through a variable defeats it, always.
  test('the misses are named, not implied — this is a text scan, not a type check', () => {
    // 1. A store write through a local alias. The mirror is aliased once and
    //    then mutated under a name the scanner has never heard of.
    expect(bypassesIn('var m = appData.arInvoices; m.push(row);')).toEqual([]);
    // 2. A loader or repainter called through an alias, same reason.
    expect(bypassesIn('var f = window.loadBillsForJob; f(jobId);')).toEqual([]);
    expect(bypassesIn('var r = window["renderJobsMain"]; r();')).toEqual([]);
    // 3. A computed key built at runtime rather than written as a literal.
    expect(bypassesIn("appData['job' + 'VendorBills'] = rows;")).toEqual([]);
    expect(bypassesIn('appData[MIRROR] = rows;')).toEqual([]);
    // 4. A call assembled from a string.
    expect(bypassesIn('window["load" + "BillsForJob"](jobId);')).toEqual([]);
    // WHY THIS IS ACCEPTABLE, stated rather than assumed: every miss requires
    // an indirection that nobody writes by accident. The defect this guard
    // exists to stop — doc-import.js — was written in the most direct form
    // available, because that is what someone reaching for the read-cache
    // naturally types. The guard is a tripwire against the ordinary mistake,
    // not a sandbox against a determined author, and it must not be described
    // as the second thing.
  });

  test('...and does not fire on the shapes that are NOT writes or calls', () => {
    // A comparison is not an assignment.
    expect(bypassesIn('if (appData.arInvoices == null) return;')).toEqual([]);
    expect(bypassesIn('if (appData.jobVendorBills === undefined) return;')).toEqual([]);
    // A capability probe is not a call.
    expect(bypassesIn('if (typeof window.loadBillsForJob === "function") ok();')).toEqual([]);
    // A registry `paths` entry is a STRING naming the loader, not an invocation.
    expect(bypassesIn("var paths = ['loadBillsForJob'].concat(REPAINT);")).toEqual([]);
    // A read is not a write.
    expect(bypassesIn('var n = appData.jobPurchaseOrders.length;')).toEqual([]);
  });

  test('...and comments are not code — including in the CRLF the tree actually uses', () => {
    // Every module that was FIXED now documents in prose exactly what it used to
    // do. If the stripper stopped working, each of those explanations would be
    // reported as the defect it describes — which is how a guard starts failing
    // on the fix instead of the bug.
    expect(bypassesIn('// called loadBillsForJob(jobId) with no force')).toEqual([]);
    expect(bypassesIn('  // hand-concated into appData.jobPurchaseOrders = ... and repainted')).toEqual([]);
    expect(bypassesIn('  // one bare renderJobsMain() that painted first\r\nvar x = 1;\r\n')).toEqual([]);
    // THE PHANTOM-COMMENT TRAP, as a first-class fixture. A naive /* */ strip is
    // broken by this exact string in js/estimate-editor.js: the `/*` inside it
    // opens a block comment that swallows every line to the next `*/`, so the
    // scan reports a clean file and the bite test passes when it should fail.
    const trap = 'var a = "application/pdf,image/*";\nwindow.loadBillsForJob(jobId);';
    expect(bypassesIn(trap)).toEqual(['loadBillsForJob', 'loadBillsForJob (no force)']);
    const trapCrlf = 'var a = "application/pdf,image/*";\r\nappData.jobVendorBills = rows;\r\n';
    expect(bypassesIn(trapCrlf)).toEqual(['jobVendorBills']);
    // The same trap against the widened patterns, because widening a scanner is
    // exactly when its stripper stops being re-checked. js/jobs-hub.js:838 also
    // carries `image/*`, and the bulk-bar checks below sit downstream of it —
    // one real `*/` away from having been swallowed too.
    expect(bypassesIn('accept="application/pdf,image/*"\np86RepaintJobMoneyTabs(id);'))
      .toEqual(['p86RepaintJobMoneyTabs']);
    expect(bypassesIn("accept=\"image/*\"\nappData['arInvoices'].push(r);")).toEqual(['arInvoices']);
  });

  test('Bulk Document Import goes through the registry and nowhere else', () => {
    // The positive half: not merely "no bypass" (deleting the refresh entirely
    // would pass that), but that it actually fires p86Refresh — once per JOB for
    // the whole batch, not once per document.
    const di = codeOnly(SOURCES.find((s) => s.file === 'doc-import.js').src);
    expect(bypassesIn(SOURCES.find((s) => s.file === 'doc-import.js').src)).toEqual([]);
    const body = fnBody(di, 'refreshCreated');
    expect(body).not.toBeNull();
    expect(body).toMatch(/window\.p86Refresh\(type,\s*\{\s*jobId:\s*j\s*\}\)/);
    // Mapped from the import's own entity vocabulary — `invoice` is a vendor
    // Bill, so it must refresh `bill` and not a type that does not exist.
    expect(di).toMatch(/REFRESH_TYPE\s*=\s*\{\s*po:\s*'po',\s*co:\s*'co',\s*invoice:\s*'bill'\s*\}/);
    // Fired ONCE, from the batch's completion arm — not from createOne.
    expect({ calls: (di.match(/refreshCreated\s*\(/g) || []).length }).toEqual({ calls: 2 });  // 1 def + 1 call
    const one = fnBody(di, 'createOne');
    expect(one).not.toBeNull();
    expect({ inCreateOne: (one.match(/refreshCreated\s*\(|p86Refresh\s*\(/g) || []).length })
      .toEqual({ inCreateOne: 0 });
  });
});

// ── the bulk ribbon and the rows must agree ─────────────────────────────────
describe('a cleared bulk selection is cleared on screen too', () => {
  const HUB = codeOnly(SOURCES.find((s) => s.file === 'jobs-hub.js').src);

  test('afterBulk drops the selection in the DOM, not only in the model', () => {
    // afterBulk cleared `_selected` and hid the ribbon but left the checkboxes
    // ticked, so for the ~200ms until the refetch repainted, rows sat selected
    // with no ribbon. It self-corrected on repaint, which is exactly why it
    // survived review — and exactly why it needs a test rather than a memory.
    const body = fnBody(HUB, 'afterBulk');
    expect(body).not.toBeNull();
    expect({ clear: (body.match(/\bclearSelection\s*\(/g) || []).length }).toEqual({ clear: 1 });
    // And the helper really unchecks, rather than being a rename of _selected.clear().
    const helper = fnBody(HUB, 'clearSelection');
    expect(helper).not.toBeNull();
    expect(helper).toMatch(/_selected\.clear\(\)/);
    expect(helper).toMatch(/\.jh-check.*b\.checked\s*=\s*false/);
    expect(helper).toMatch(/indeterminate\s*=\s*false/);
  });

  test('the ribbon Clear button and afterBulk use the SAME helper', () => {
    // Two copies of "drop the selection" is how they came to disagree.
    // `(?<!function )` so the declaration is not counted as one of the uses.
    expect({ uses: (HUB.match(/(?<!function )\bclearSelection\s*\(\s*\)/g) || []).length })
      .toEqual({ uses: 2 });   // afterBulk + the ribbon's onClear
  });
});

// ── a repaint called with no id repaints nothing ────────────────────────────
describe('the job-card repaint is given the job it is meant to repaint', () => {
  test('syncEstimateToJob passes est.job_id to p86RerenderJobCards', () => {
    // p86RerenderJobCards(jobId) hands its argument straight to
    // renderJobBuildings(jobId, host) and to the phases filter. Called bare it
    // ran both with `undefined`, matched nothing, and left the building + phase
    // cards on the pre-sync contract — a repaint that reported success and
    // moved no pixel. Every other call site in js/jobs.js passes an id; this
    // was the only one that did not.
    const ee = codeOnly(SOURCES.find((s) => s.file === 'estimate-editor.js').src);
    const bare = ee.match(/p86RerenderJobCards\(\s*\)/g) || [];
    expect(bare).toEqual([]);
    expect(ee).toMatch(/window\.p86RerenderJobCards\(est\.job_id\)/);
  });
});
