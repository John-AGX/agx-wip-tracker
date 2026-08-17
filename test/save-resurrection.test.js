/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * A ROW SOMEBODY DELETED STAYS DELETED.
 *
 * This is the repo's documented worst failure mode and the hold made it
 * reachable. The hold exists to keep a dirty id alive across a hydrate, so
 * inside a deploy window the sequence is:
 *
 *   1. the boot GET 502s (a normal Railway swap); the session is held
 *   2. John edits j1 — "1 change held on this device"
 *   3. an agent, or another PM, deletes j1 on the server
 *   4. the server comes back, the hold pushes what it is holding
 *   5. …and the jobs bulk save INSERTs j1 straight back into Postgres
 *
 * Both halves are asserted here: the row must NOT come back, AND the user must
 * be told which row it was, because a silent conflict that drops the edit is
 * one silence traded for another.
 *
 * The inverse is asserted just as hard. The hold exists to stop real data
 * loss, so a guard that refuses a legitimate held edit — or that refuses to
 * create a genuinely new job — has recreated the original bug with better
 * manners.
 * ────────────────────────────────────────────────────────────────────────── */
const { makeServer, boot, settle, jobRow, cacheSeeder, defer } = require('./helpers/save-harness');

beforeEach(() => { jest.useRealTimers(); });

/* handleSaveConflicts reloads on a 1200ms debounce and only then knows what was
 * lost, so the announcement genuinely needs wall-clock time. */
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/* Each boot() leaves a live app instance behind; jest.resetModules unhooks the
 * module registry but not the timers already scheduled. Without this drain, the
 * PREVIOUS test's conflict reload fires in the middle of the next test and
 * announces into its alert sink — which reads exactly like the product
 * announcing three times. Flush them where they belong. */
afterEach(async () => { await tick(1400); });

function captureAlerts() {
  const alerts = [];
  window.p86Alert = (o) => { alerts.push(o); return Promise.resolve(); };
  const toasts = [];
  window.p86Toast = (m, k) => { toasts.push([m, k]); };
  return { alerts, toasts };
}

describe('a job deleted while this client was holding a change to it', () => {
  /* The exact reported sequence, one app instance. */
  async function runTheRepro() {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    const snapshot = server.listJobs().jobs;
    let down = true;

    boot(server, {
      seedCache: cacheSeeder(snapshot),
      jobsList: () => (down ? Promise.reject(new Error('HTTP 502')) : Promise.resolve(server.listJobs()))
    });
    const seen = captureAlerts();

    await window.p86Data.reloadFromServer();        // 1. boot GET 502s
    await settle();
    expect(window.p86SaveState().writable).toBe(false);

    window.appData.jobs[0].contractAmount = 999000; // 2. John edits j1
    expect(window.p86SaveState().jobIds).toEqual(['j1']);

    server.jobs.delete('j1');                       // 3. an agent deletes it

    down = false;                                   // 4. the server returns
    await window.p86Data.reloadFromServer();
    await settle(40);
    return { server, seen };
  }

  test('is NOT re-created in the database', async () => {
    const { server } = await runTheRepro();
    // The line the whole commit is about. Before the guard this read `true`,
    // with data.contractAmount === 999000.
    expect(server.jobs.has('j1')).toBe(false);
  });

  test('the push that carried it did send a base version — that is what made the refusal possible', async () => {
    const { server } = await runTheRepro();
    const bv = server.wire.jobBaseVersions[server.wire.jobBaseVersions.length - 1];
    expect(bv.j1).toBeTruthy();
    // …and the client really did put the row on the wire. The refusal is the
    // SERVER's, not an accident of the client happening not to send it.
    const sent = server.wire.jobPayloads[server.wire.jobPayloads.length - 1];
    expect(sent.jobs.map((j) => j.id)).toEqual(['j1']);
  });

  test('the user is told, by name, that it was deleted and not re-created', async () => {
    const { seen } = await runTheRepro();
    await tick(1400);          // the conflict reload + the announcement
    await settle(20);

    expect(seen.alerts).toHaveLength(1);
    expect(seen.alerts[0].title).toBe('Deleted by someone else');
    expect(seen.alerts[0].message).toContain('Job j1');
    expect(seen.alerts[0].message).toContain('deleted by someone else');
    expect(seen.alerts[0].message).toContain('NOT re-created');
    // And specifically NOT the stale-conflict sentence, which says the current
    // version has been loaded — there is no current version.
    expect(seen.toasts.map((t) => t[0]).join(' ')).not.toContain('changed by someone else');
  });

  test('the ghost row leaves the screen, and the banner state clears with it', async () => {
    const { server } = await runTheRepro();
    await tick(1400);
    await settle(20);
    expect(window.appData.jobs.map((j) => j.id)).toEqual([]);
    expect(window.p86SaveState().jobIds).toEqual([]);
    expect(server.jobs.has('j1')).toBe(false);
  });

  test('it is announced ONCE even if the convergence reload keeps failing', async () => {
    // A reload that cannot land leaves the ghost dirty, so every later push
    // re-conflicts. The convergence must keep trying; the dialog must not.
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    const snapshot = server.listJobs().jobs;
    let down = true;
    let gets = 0;
    boot(server, {
      seedCache: cacheSeeder(snapshot),
      jobsList: () => {
        gets++;
        // Good enough to unblock the push, then down again for every reload.
        if (down) return Promise.reject(new Error('HTTP 502'));
        if (gets > 2) return Promise.reject(new Error('HTTP 502'));
        return Promise.resolve(server.listJobs());
      }
    });
    const seen = captureAlerts();
    await window.p86Data.reloadFromServer();
    await settle();
    window.appData.jobs[0].contractAmount = 999000;
    server.jobs.delete('j1');
    down = false;
    await window.p86Data.reloadFromServer();
    await settle(40);
    await tick(1400);
    await settle(20);

    window.p86FlushSave();                      // a second push, same ghost
    await settle(30);
    await tick(1400);
    await settle(20);

    expect(server.jobs.has('j1')).toBe(false);
    expect(seen.alerts).toHaveLength(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * The inverse. A guard that refuses legitimate writes is the original bug.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('what the guard must NOT refuse', () => {
  test('a brand-new job — no base version, therefore a create — still inserts', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();

    window.appData.jobs.push(jobRow('jNEW', { title: 'Poinciana Phase 3', contractAmount: 480000 }));
    window.p86FlushSave();
    await settle(30);

    expect(server.jobs.has('jNEW')).toBe(true);
    expect(server.jobs.get('jNEW').data.contractAmount).toBe(480000);
    // It went out with NO base — that absence is exactly what says "create".
    const bv = server.wire.jobBaseVersions[server.wire.jobBaseVersions.length - 1];
    expect(bv.jNEW).toBeUndefined();
  });

  test('a held edit to a job that still exists reaches the server, even in the same push as a deleted one', async () => {
    // The hold's whole purpose. One deleted row must not take the batch down
    // with it — the loop refuses per row and writes the rest.
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    server.seedJob('j2', jobRow('j2'));
    const snapshot = server.listJobs().jobs;
    let down = true;
    boot(server, {
      seedCache: cacheSeeder(snapshot),
      jobsList: () => (down ? Promise.reject(new Error('HTTP 502')) : Promise.resolve(server.listJobs()))
    });
    captureAlerts();
    await window.p86Data.reloadFromServer();
    await settle();

    window.appData.jobs.find((j) => j.id === 'j1').contractAmount = 999000;
    window.appData.jobs.find((j) => j.id === 'j2').contractAmount = 314000;
    server.jobs.delete('j1');
    down = false;
    await window.p86Data.reloadFromServer();
    await settle(40);

    expect(server.jobs.has('j1')).toBe(false);            // stayed deleted
    expect(server.jobs.get('j2').data.contractAmount).toBe(314000);  // and j2 landed
  });

  test('an edit during an in-flight hydrate still reaches the server', async () => {
    // The regression guard for the hold itself. If this ever goes red, the
    // deleted-row containment has re-opened the silent-drop it was built on.
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    const gate = defer();
    let call = 0;
    boot(server, {
      jobsList: () => {
        call++;
        if (call === 2) return gate.promise.then(() => server.listJobs());
        return Promise.resolve(server.listJobs());
      }
    });
    await window.p86Data.reloadFromServer();
    await settle();
    const second = window.p86Data.reloadFromServer();
    await settle();
    window.appData.jobs[0].contractAmount = 250000;
    gate.resolve();
    await second;
    await settle(40);

    expect(server.jobs.get('j1').data.contractAmount).toBe(250000);
  });
});
