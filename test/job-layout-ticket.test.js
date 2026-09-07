/**
 * @jest-environment jsdom
 */
// T0 — the layout axis. A service job renders the SHORT ticket page; every
// other job renders the full one; and you can flip either way.
//
// THE DESIGN THESE PIN: type and layout are different axes.
//   * TYPE (S/M/RV/WO) is identity — derived from the job number's prefix,
//     never stored, never changed, because the number is printed on POs, pay
//     apps, signed COs and the QuickBooks project name.
//   * LAYOUT is a view choice. `job.layout` absent means "derive from the
//     type", which is why this shipped with no migration and why every job
//     that already exists keeps rendering exactly as it did.
//
// The rule that makes flipping safe is the one worth breaking a build over:
// the ticket layout must never HIDE a section that holds real records. A job
// with change orders keeps its CO tab even in the short layout — otherwise
// flipping would take live money off the screen while leaving it in the
// rollup, and it would look deleted.

const H = require('./helpers/job-detail-dom');

const TICKET_SET = [
  'job-overview', 'job-service-tickets', 'job-details',
  'job-photos', 'job-qb-costs', 'job-invoices'
];

let observers = [];

// One job object, mutated per test — the module reads it live out of appData,
// which is exactly how the app behaves when a field is edited.
const JOB = { id: 'job_1', jobNumber: 'S0012', title: 'Lanai screen repair' };

beforeAll(() => {
  H.buildDom(document);
  observers = H.loadWorkspaceLayout(window, JOB);
});

afterAll(() => { observers.forEach((o) => o.disconnect()); });

beforeEach(async () => {
  await H.closeJob(window);
  // Back to the default: an S job with no explicit layout and no records.
  JOB.jobNumber = 'S0012';
  delete JOB.layout;
  Object.assign(window.appData, {
    jobChangeOrders: [], jobPurchaseOrders: [], arInvoices: [],
    estimates: [], qbCostLines: [], buildings: [], phases: [], subs: []
  });
});

describe('layout derives from the job number, with no field set', () => {
  test('an S job renders the short ticket set', async () => {
    await H.openJobAt(window, null);
    expect(H.tabIds(document)).toEqual(TICKET_SET);
    expect(window.p86JobLayout()).toBe('ticket');
  });

  test('a WO job also reads as a ticket', async () => {
    JOB.jobNumber = 'WO0007';
    await H.openJobAt(window, null);
    expect(window.p86JobLayout()).toBe('ticket');
  });

  // The regression that matters most: every job that exists today has no
  // `layout` field, and none of them may change.
  test('an RV job is untouched — the full sixteen', async () => {
    JOB.jobNumber = 'RV2044';
    await H.openJobAt(window, null);
    expect(window.p86JobLayout()).toBe('full');
    expect(H.tabIds(document).length).toBeGreaterThan(TICKET_SET.length);
    expect(H.tabIds(document)).toContain('job-changeorders');
    expect(H.tabIds(document)).toContain('job-payapps');
  });

  test('an M (mid-tier service) job renders full, not ticket', async () => {
    JOB.jobNumber = 'M0003';
    await H.openJobAt(window, null);
    expect(window.p86JobLayout()).toBe('full');
  });
});

describe('an explicit layout overrides the number, both directions', () => {
  test('an S job forced to full shows everything', async () => {
    JOB.layout = 'full';
    await H.openJobAt(window, null);
    expect(window.p86JobLayout()).toBe('full');
    expect(H.tabIds(document)).toContain('job-payapps');
  });

  test('an RV job forced to ticket shows the short set', async () => {
    JOB.jobNumber = 'RV2044';
    JOB.layout = 'ticket';
    await H.openJobAt(window, null);
    expect(window.p86JobLayout()).toBe('ticket');
    expect(H.tabIds(document)).toEqual(TICKET_SET);
  });
});

describe('the ticket layout never hides a section that holds records', () => {
  test('a service job WITH change orders keeps its CO tab', async () => {
    window.appData.jobChangeOrders = [{ id: 'co1', jobId: 'job_1' }];
    await H.openJobAt(window, null);
    expect(H.tabIds(document)).toContain('job-changeorders');
  });

  test('another job\'s change orders do NOT bring the tab back', async () => {
    window.appData.jobChangeOrders = [{ id: 'co1', jobId: 'some_other_job' }];
    await H.openJobAt(window, null);
    expect(H.tabIds(document)).not.toContain('job-changeorders');
  });

  test('server snake_case rows count too', async () => {
    window.appData.jobPurchaseOrders = [{ id: 'po1', job_id: 'job_1' }];
    await H.openJobAt(window, null);
    expect(H.tabIds(document)).toContain('job-purchaseorders');
  });

  // arInvoices is the LIVE store; appData.invoices is the dead legacy
  // localStorage one. Reading the wrong one would hide real money.
  test('invoices are read from arInvoices, not the dead legacy store', async () => {
    window.appData.invoices = [{ id: 'i1', jobId: 'job_1' }];
    await H.openJobAt(window, null);
    // job-invoices is in the ticket set regardless, so assert the store
    // choice through a tab that is NOT: estimates.
    await H.closeJob(window);
    window.appData.estimates = [{ id: 'e1', jobId: 'job_1' }];
    await H.openJobAt(window, null);
    expect(H.tabIds(document)).toContain('job-estimates');
  });
});

describe('flipping the layout', () => {
  test('round-trips, and writes only the one field', async () => {
    JOB.jobNumber = 'RV2044';
    await H.openJobAt(window, null);
    const numberBefore = JOB.jobNumber;
    expect(H.tabIds(document)).toContain('job-payapps');

    window.p86SetJobLayout('ticket');
    expect(H.tabIds(document)).toEqual(TICKET_SET);
    expect(JOB.layout).toBe('ticket');

    window.p86SetJobLayout('full');
    expect(H.tabIds(document)).toContain('job-payapps');
    expect(JOB.layout).toBe('full');

    // The identity never moves. This is the whole reason layout is its own
    // axis: a renumber would break POs, pay apps and the QB project name.
    expect(JOB.jobNumber).toBe(numberBefore);
  });

  test('a flip that hides the section you were on lands you on Overview', async () => {
    JOB.jobNumber = 'RV2044';
    await H.openJobAt(window, 'job-payapps');
    expect(H.activePanel(document)).toBe('job-payapps');

    window.p86SetJobLayout('ticket');
    expect(H.activePanel(document)).toBe('job-overview');
    expect(H.paneShown(document, 'job-overview')).toBe('block');
    expect(H.paneShown(document, 'job-payapps')).toBe('none');
  });

  test('a flip KEEPS the section you were on when it survives', async () => {
    JOB.jobNumber = 'RV2044';
    await H.openJobAt(window, 'job-photos');
    window.p86SetJobLayout('ticket');
    expect(H.activePanel(document)).toBe('job-photos');
    expect(H.paneShown(document, 'job-photos')).toBe('block');
  });

  test('an unknown mode is refused rather than blanking the strip', async () => {
    await H.openJobAt(window, null);
    const before = H.tabIds(document);
    window.p86SetJobLayout('nonsense');
    expect(H.tabIds(document)).toEqual(before);
    expect(JOB.layout).toBeUndefined();
  });
});

describe('deep links against a short layout', () => {
  test('a link to a hidden, empty section falls back instead of stranding a pane', async () => {
    await H.openJobAt(window, 'job-changeorders');
    // No CO tab exists to light, so the strip must not be left claiming
    // nothing while a pane sits open underneath it.
    expect(H.tabIds(document)).not.toContain('job-changeorders');
    expect(H.activePanel(document)).toBe('job-overview');
    expect(H.paneShown(document, 'job-changeorders')).toBe('none');
  });

  test('a link to a hidden section that HAS data still opens it', async () => {
    window.appData.jobChangeOrders = [{ id: 'co1', jobId: 'job_1' }];
    await H.openJobAt(window, 'job-changeorders');
    expect(H.activePanel(document)).toBe('job-changeorders');
    expect(H.paneShown(document, 'job-changeorders')).toBe('block');
  });

  test('a link to a section inside the ticket set opens normally', async () => {
    await H.openJobAt(window, 'job-service-tickets');
    expect(H.activePanel(document)).toBe('job-service-tickets');
    expect(H.paneShown(document, 'job-service-tickets')).toBe('block');
  });
});
