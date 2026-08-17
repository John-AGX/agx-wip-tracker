/**
 * @jest-environment jsdom
 */
// The per-job money loaders in js/jobs.js — loadPurchaseOrdersForJob,
// loadChangeOrdersForJob, loadBillsForJob.
//
// These three keep the appData mirrors that the jobs-list ACCRUED / Total
// Income tiles and the job page's money sections are computed from. A refresh
// fired straight after a write calls them with force=true, and the ONLY thing
// that made a difference before was that `force` skipped the in-flight join.
// That is not enough: the pre-write GET is still running, its .then still
// installs its rows, and if it lands SECOND it overwrites the fresh ones —
// after the surface has already painted, so nothing corrects it.
//
// The fix is the generation stamp the leads/clients caches already use: a
// forced fetch bumps the job's generation and any response carrying an older
// one is dropped. These tests pin exactly that, plus the second half of the
// bug — the disowned .then deleting the in-flight key of the fetch that
// replaced it, which re-opened the same race for the next caller.

let deferPO;

beforeAll(() => {
  // js/jobs.js is a classic browser script: it publishes its loaders on window
  // and its top-level code only defines functions + listeners.
  window.appData = {};
  window.appState = {};
  require('../js/jobs.js');
});

function makeDeferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  window.appData = { jobPurchaseOrders: [], jobChangeOrders: [], jobVendorBills: [] };
  deferPO = [];
  window.p86Api = {
    purchaseOrders: { listForJob: jest.fn(() => { const d = makeDeferred(); deferPO.push(d); return d.promise; }) },
    changeOrders:   { listForJob: jest.fn(() => { const d = makeDeferred(); deferPO.push(d); return d.promise; }) },
    bills:          { listForJob: jest.fn(() => { const d = makeDeferred(); deferPO.push(d); return d.promise; }) }
  };
});

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

const CASES = [
  {
    name: 'loadPurchaseOrdersForJob',
    load: (j, f) => window.loadPurchaseOrdersForJob(j, f),
    mirror: 'jobPurchaseOrders',
    body: (rows) => ({ purchase_orders: rows })
  },
  {
    name: 'loadChangeOrdersForJob',
    load: (j, f) => window.loadChangeOrdersForJob(j, f),
    mirror: 'jobChangeOrders',
    body: (rows) => ({ change_orders: rows })
  },
  {
    name: 'loadBillsForJob',
    load: (j, f) => window.loadBillsForJob(j, f),
    mirror: 'jobVendorBills',
    body: (rows) => ({ bills: rows })
  }
];

describe.each(CASES)('$name — the pre-write GET must not land on top of the post-write one', (c) => {
  test('a stale GET resolving LAST does not overwrite the fresh rows', async () => {
    // The read that a tab-open issued, BEFORE the user's write.
    const pre = c.load('job_1', false);
    const preDeferred = deferPO[0];

    // The write lands; the refresh forces a fresh fetch.
    const post = c.load('job_1', true);
    const postDeferred = deferPO[1];
    expect(postDeferred).toBeDefined();

    // Fresh response lands first...
    postDeferred.resolve(c.body([{ id: 'r_new', job_id: 'job_1', amount: 500 }]));
    await post;
    await flush();
    expect(window.appData[c.mirror].map((r) => r.id)).toEqual(['r_new']);

    // ...then the pre-write one, carrying the OLD row, resolves late.
    preDeferred.resolve(c.body([{ id: 'r_old', job_id: 'job_1', amount: 100 }]));
    await pre;
    await flush();

    // Count assertion, not truthiness: the mirror must still hold exactly the
    // fresh row. Before the generation stamp this was ['r_old'].
    expect(window.appData[c.mirror].map((r) => r.id)).toEqual(['r_new']);
  });

  test('a disowned GET does not release the in-flight slot of the fetch that replaced it', async () => {
    const pre = c.load('job_2', false);
    const preDeferred = deferPO[0];
    c.load('job_2', true);           // forced — supersedes `pre`
    const postDeferred = deferPO[1];

    // The disowned one settles first and used to `delete inflight[jobId]`,
    // so the NEXT reader started a THIRD GET while the forced one was still
    // running — the same overlapping-fetch race, one layer down.
    preDeferred.resolve(c.body([{ id: 'r_old', job_id: 'job_2' }]));
    await pre;
    await flush();

    const callsBefore = window.p86Api.purchaseOrders.listForJob.mock.calls.length +
                        window.p86Api.changeOrders.listForJob.mock.calls.length +
                        window.p86Api.bills.listForJob.mock.calls.length;
    c.load('job_2', false);          // a plain read must JOIN the forced fetch
    const callsAfter = window.p86Api.purchaseOrders.listForJob.mock.calls.length +
                       window.p86Api.changeOrders.listForJob.mock.calls.length +
                       window.p86Api.bills.listForJob.mock.calls.length;
    expect(callsAfter).toBe(callsBefore);

    postDeferred.resolve(c.body([{ id: 'r_new', job_id: 'job_2' }]));
    await flush();
    expect(window.appData[c.mirror].map((r) => r.id)).toEqual(['r_new']);
  });

  test('the generation is PER JOB — a forced refetch of one job cannot disown another', async () => {
    const a = c.load('job_a', false);
    const aDeferred = deferPO[0];
    c.load('job_b', true);
    const bDeferred = deferPO[1];

    bDeferred.resolve(c.body([{ id: 'b1', job_id: 'job_b' }]));
    await flush();
    aDeferred.resolve(c.body([{ id: 'a1', job_id: 'job_a' }]));
    await a;
    await flush();

    const ids = window.appData[c.mirror].map((r) => r.id).sort();
    expect(ids).toEqual(['a1', 'b1']);
  });

  test('a plain read still JOINS an in-flight GET — only a write forces a new one', async () => {
    c.load('job_3', false);
    const n1 = window.p86Api.purchaseOrders.listForJob.mock.calls.length +
               window.p86Api.changeOrders.listForJob.mock.calls.length +
               window.p86Api.bills.listForJob.mock.calls.length;
    c.load('job_3', false);
    const n2 = window.p86Api.purchaseOrders.listForJob.mock.calls.length +
               window.p86Api.changeOrders.listForJob.mock.calls.length +
               window.p86Api.bills.listForJob.mock.calls.length;
    expect(n2).toBe(n1);
  });
});
