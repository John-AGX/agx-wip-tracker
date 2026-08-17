/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * AN ESTIMATE IS REFEREED THE WAY A JOB IS.
 *
 * The hold's safety argument rested on the pre-hydrate flush being JOBS ONLY:
 * estimates had no version guard, so force-pushing one at the moment an agent
 * had just written would deterministically overwrite the newer copy. The
 * reasoning was right — and it was not applied to the hold's OWN push, which
 * runs at the same instant, off the same GET, carrying estimates.
 *
 * Scoping the payload to touched rows narrowed the blast radius but could not
 * fix it: scoping decides WHICH rows are on the wire, never what happens to a
 * row that IS. So the fix is the guard, not more scoping — the endpoint now
 * refuses a stale, unverifiable, deleted or locked row instead of taking it.
 *
 * The repro below is the reported one: an agent rewrites e1.scope server-side
 * while this client is held, John edits e1.total on his stale copy, and the
 * agent's write must still be there afterwards.
 * ────────────────────────────────────────────────────────────────────────── */
const {
  makeServer, boot, settle, jobRow, cacheSeeder, UNVERSIONED_BASE
} = require('./helpers/save-harness');

beforeEach(() => { jest.useRealTimers(); });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
afterEach(async () => { await tick(1400); });

function estCache(jobsSnapshot, estimates) {
  return cacheSeeder(jobsSnapshot, estimates);
}

describe("an agent's estimate write, and a held client editing the same row", () => {
  async function agentWritesWhileHeld() {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    server.seedEstimate('e1', { title: 'Poinciana', scope: 'ORIGINAL', total: 100000 });
    const jobSnap = server.listJobs().jobs;
    const estSnap = server.listEstimates().estimates;
    let down = true;

    boot(server, {
      seedCache: estCache(jobSnap, estSnap),
      jobsList: () => (down ? Promise.reject(new Error('HTTP 502')) : Promise.resolve(server.listJobs()))
    });
    const toasts = [];
    window.p86Toast = (m) => { toasts.push(m); };

    await window.p86Data.reloadFromServer();      // boot 502 — the session is held
    await settle();
    expect(window.p86SaveState().writable).toBe(false);

    // The agent rewrites the scope, server-side, while this client is held.
    server.estimates.set('e1', {
      data: { ...server.estimates.get('e1').data, scope: 'AGENT REWROTE THIS' },
      updated_at: new Date(80000).toISOString()
    });
    // John, on his stale copy, edits the total.
    window.appData.estimates[0].total = 133000;
    expect(window.p86SaveState().estimateIds).toEqual(['e1']);

    down = false;
    await window.p86Data.reloadFromServer();
    await settle(40);
    return { server, toasts };
  }

  test("the agent's scope survives — it is not reverted by the held copy", async () => {
    const { server } = await agentWritesWhileHeld();
    expect(server.estimates.get('e1').data.scope).toBe('AGENT REWROTE THIS');
  });

  test('the held edit is refused, not silently applied on top', async () => {
    const { server } = await agentWritesWhileHeld();
    expect(server.estimates.get('e1').data.total).toBe(100000);
  });

  test('the push carried a base version — the referee that did not exist before', async () => {
    const { server } = await agentWritesWhileHeld();
    const bv = server.wire.estBaseVersions[server.wire.estBaseVersions.length - 1];
    expect(bv.e1).toBeTruthy();
    expect(bv.e1).not.toBe(UNVERSIONED_BASE);
  });

  test('and it is announced — a refused write is never a green check', async () => {
    const { toasts } = await agentWritesWhileHeld();
    await tick(1400);
    await settle(20);
    expect(toasts.join(' | ')).toMatch(/changed by someone else/);
    // Named as an estimate, not as a job.
    expect(toasts.join(' | ')).toContain('Poinciana');
  });

  test('the refused estimate stays DIRTY rather than being marked saved', async () => {
    const { server } = await agentWritesWhileHeld();
    // Before the response was read at all, every pushed estimate was
    // re-baselined unconditionally: the row went clean, the banner cleared, and
    // the edit was gone at the next hydrate with nothing having said so.
    expect(window.p86SaveState().estimateIds).toEqual(['e1']);
    expect(server.estimates.get('e1').data.total).toBe(100000);
  });
});

describe('an estimate deleted while this client held a change to it', () => {
  test('is not re-created, and the user is told', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    server.seedEstimate('e1', { title: 'Doomed', total: 42000 });
    const jobSnap = server.listJobs().jobs;
    const estSnap = server.listEstimates().estimates;
    let down = true;
    boot(server, {
      seedCache: estCache(jobSnap, estSnap),
      jobsList: () => (down ? Promise.reject(new Error('HTTP 502')) : Promise.resolve(server.listJobs()))
    });
    const alerts = [];
    window.p86Alert = (o) => { alerts.push(o); return Promise.resolve(); };
    window.p86Toast = () => {};

    await window.p86Data.reloadFromServer();
    await settle();
    window.appData.estimates[0].total = 51000;
    server.estimates.delete('e1');
    down = false;
    await window.p86Data.reloadFromServer();
    await settle(40);
    await tick(1400);
    await settle(20);

    expect(server.estimates.has('e1')).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe('Deleted by someone else');
    expect(alerts[0].message).toContain('Doomed');
    expect(alerts[0].message).toContain('NOT re-created');
  });
});

describe('a locked (sold) estimate', () => {
  test('is reported and stays dirty instead of being skipped in silence', async () => {
    const server = makeServer();
    server.seedEstimate('e1', { title: 'Sold Work', total: 90000 });
    server.lockedEstimates.add('e1');
    boot(server);
    const toasts = [];
    window.p86Toast = (m) => { toasts.push(m); };

    await window.p86Data.reloadFromServer();
    await settle();
    window.appData.estimates[0].total = 5;
    window.p86FlushSave();
    await settle(30);

    expect(server.estimates.get('e1').data.total).toBe(90000);   // immutable, as designed
    // …and the client did not pretend it saved.
    expect(window.p86SaveState().estimateIds).toEqual(['e1']);
    await tick(1400);
    await settle(20);
    expect(toasts.join(' | ')).toMatch(/locked/);
  });
});

describe('what the estimate guard must NOT break', () => {
  test('an ordinary estimate edit still reaches the server', async () => {
    const server = makeServer();
    server.seedEstimate('e1', { title: 'Live', total: 10 });
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();
    window.appData.estimates[0].total = 77000;
    window.p86FlushSave();
    await settle(30);

    expect(server.estimates.get('e1').data.total).toBe(77000);
    expect(window.p86SaveState().estimateIds).toEqual([]);
  });

  test('two edits in a row still land — the base advances off the push response', async () => {
    // Without adopting the versions the server hands back, the SECOND save
    // would present the first save's base and false-conflict with itself.
    const server = makeServer();
    server.seedEstimate('e1', { title: 'Live', total: 10 });
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();
    window.appData.estimates[0].total = 100;
    window.p86FlushSave();
    await settle(30);
    window.appData.estimates[0].total = 200;
    window.p86FlushSave();
    await settle(30);

    expect(server.estimates.get('e1').data.total).toBe(200);
    expect(window.p86SaveState().estimateIds).toEqual([]);
  });

  test('a brand-new estimate is created — no base, therefore an insert', async () => {
    const server = makeServer();
    server.seedEstimate('e1', { title: 'Live', total: 10 });
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();
    window.appData.estimates.push({ id: 'eNEW', title: 'Fresh Bid', total: 250000 });
    window.p86FlushSave();
    await settle(30);

    expect(server.estimates.has('eNEW')).toBe(true);
    expect(server.estimates.get('eNEW').data.total).toBe(250000);
    const bv = server.wire.estBaseVersions[server.wire.estBaseVersions.length - 1];
    expect(bv.eNEW).toBeUndefined();
  });

  test('an estimate deleted elsewhere is still not shipped by an unrelated edit', async () => {
    const server = makeServer();
    server.seedEstimate('e1', { title: 'Keep', total: 1 });
    server.seedEstimate('e2', { title: 'Doomed', total: 2 });
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();
    server.estimates.delete('e2');
    window.appData.estimates.find((e) => e.id === 'e1').title = 'Keep (edited)';
    window.p86FlushSave();
    await settle(30);

    expect(server.estimates.has('e2')).toBe(false);
    const sent = server.wire.estPayloads[server.wire.estPayloads.length - 1];
    expect(sent.estimates.map((e) => e.id)).toEqual(['e1']);
  });
});
