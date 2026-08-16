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
