/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * THE VERSION GUARD IS NOT OPT-IN.
 *
 * It used to be, twice over. The server only checked `if (base)`, and the only
 * thing supplying a base was the client's `if (j._updatedAt)`. A copy that had
 * lost its _updatedAt therefore went out with baseVersions {} and force-
 * overwrote whatever was on the server — money fields included — with no
 * conflict, no banner and no toast. The server had the same hole from its own
 * side: `if (serverTs && serverTs !== base)` fell through to the write whenever
 * the row's own updated_at was null (the column is nullable).
 *
 * Closing it cannot simply mean "no version ⇒ refuse", because a job this
 * client just CREATED has no version either, and refusing that would destroy a
 * new job — the same bug pointed the other way. The separator is the server's
 * own list of ids, recorded off every GET that resolved:
 *   in the list, unversioned → send the sentinel → the server refuses
 *   not in the list          → send nothing      → the server creates
 * Both halves are asserted here.
 * ────────────────────────────────────────────────────────────────────────── */
const {
  makeServer, boot, settle, jobRow, cacheSeeder, UNVERSIONED_BASE
} = require('./helpers/save-harness');

beforeEach(() => { jest.useRealTimers(); });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
afterEach(async () => { await tick(1400); });

/* A cache written before _updatedAt was handed to the client: real job rows,
 * no version stamp on any of them. */
function versionlessCache(jobs) {
  return cacheSeeder(jobs.map((j) => { const c = { ...j }; delete c._updatedAt; return c; }));
}

describe('a held copy with no recorded version', () => {
  async function heldUnversioned() {
    const server = makeServer();
    // What the client cached, long ago.
    server.seedJob('j1', jobRow('j1', { gutterBudget: 12000 }));
    const snapshot = server.listJobs().jobs;
    let down = true;
    boot(server, {
      seedCache: versionlessCache(snapshot),
      jobsList: () => (down ? Promise.reject(new Error('HTTP 502')) : Promise.resolve(server.listJobs()))
    });
    const toasts = [];
    window.p86Toast = (m) => { toasts.push(m); };

    await window.p86Data.reloadFromServer();       // boot 502 — memory is the cache
    await settle();
    expect(window.p86SaveState().writable).toBe(false);

    // Meanwhile someone corrects the Gutters budget on the real row.
    server.jobs.set('j1', {
      data: { ...server.jobs.get('j1').data, gutterBudget: 27500 },
      updated_at: new Date(90000).toISOString()
    });
    // John, on his stale copy, types over it.
    window.appData.jobs[0].gutterBudget = 12000;
    window.appData.jobs[0].notes = 'from the truck';
    expect(window.p86SaveState().jobIds).toEqual(['j1']);

    down = false;
    await window.p86Data.reloadFromServer();
    await settle(40);
    return { server, toasts };
  }

  test('does NOT overwrite the newer server row', async () => {
    const { server } = await heldUnversioned();
    // 27500 is the corrected number. Before this change the stale copy landed
    // on top of it and reverted it to 12000, silently.
    expect(server.jobs.get('j1').data.gutterBudget).toBe(27500);
    expect(server.jobs.get('j1').data.notes).toBeUndefined();
  });

  test('goes out carrying the sentinel, not an empty baseVersions', async () => {
    const { server } = await heldUnversioned();
    const bv = server.wire.jobBaseVersions[server.wire.jobBaseVersions.length - 1];
    expect(bv.j1).toBe(UNVERSIONED_BASE);
  });

  test('and the user is told why, in words that are true of THIS refusal', async () => {
    const { toasts } = await heldUnversioned();
    await tick(1400);
    await settle(20);
    const all = toasts.join(' | ');
    expect(all).toContain('could not tell which version');
    // Nobody necessarily changed that row — saying so would be a guess.
    expect(all).not.toContain('was changed by someone else');
  });
});

describe('what "no version" must still be allowed to do', () => {
  test('a job created while the server was down is CREATED, not refused', async () => {
    // The inverse test. A new job has no version either, and a guard that
    // cannot tell it apart from a stale copy destroys it.
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    const snapshot = server.listJobs().jobs;
    let down = true;
    boot(server, {
      seedCache: cacheSeeder(snapshot),
      jobsList: () => (down ? Promise.reject(new Error('HTTP 502')) : Promise.resolve(server.listJobs()))
    });
    await window.p86Data.reloadFromServer();
    await settle();

    window.appData.jobs.push(jobRow('jNEW', { title: 'Saddlebrook 12', contractAmount: 615000 }));
    down = false;
    await window.p86Data.reloadFromServer();
    await settle(40);

    expect(server.jobs.has('jNEW')).toBe(true);
    expect(server.jobs.get('jNEW').data.contractAmount).toBe(615000);
    const bv = server.wire.jobBaseVersions[server.wire.jobBaseVersions.length - 1];
    expect(bv.jNEW).toBeUndefined();       // absent — that absence IS the create
    expect(bv.jNEW).not.toBe(UNVERSIONED_BASE);
  });

  test('a healthy session still sends the REAL version, never the sentinel', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();
    window.appData.jobs[0].contractAmount = 123;
    window.p86FlushSave();
    await settle(20);

    const bv = server.wire.jobBaseVersions[server.wire.jobBaseVersions.length - 1];
    expect(bv.j1).not.toBe(UNVERSIONED_BASE);
    expect(bv.j1).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(server.jobs.get('j1').data.contractAmount).toBe(123);
  });
});

describe('the server half of the same hole', () => {
  test('a row whose own updated_at is null refuses the write instead of taking it', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1', { contractAmount: 400000 }));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();

    // The row loses its timestamp (a backfill, a migration, a hand-written
    // INSERT). The client's base is now uncomparable from the other side.
    server.jobs.set('j1', { data: server.jobs.get('j1').data, updated_at: null });

    window.appData.jobs[0].contractAmount = 1;
    window.p86FlushSave();
    await settle(20);

    expect(server.jobs.get('j1').data.contractAmount).toBe(400000);
  });
});

describe('route fidelity for the guard', () => {
  const fs = require('fs');
  const path = require('path');
  const JOB_ROUTES = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'job-routes.js'), 'utf8');
  const jobsBulk = JOB_ROUTES.slice(JOB_ROUTES.indexOf("router.put('/bulk/save'"));
  const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

  test('the route knows the sentinel and refuses on it', () => {
    expect(jobsBulk).toMatch(/const UNVERSIONED_BASE = 'unversioned';/);
    expect(jobsBulk).toMatch(/if \(!serverTs \|\| base === UNVERSIONED_BASE\) \{/);
    expect(jobsBulk).toMatch(/reason: 'unverifiable'/);
  });

  test('the route no longer writes when it cannot compare', () => {
    // The exact shape of the old hole: a comparison that only fires when the
    // server timestamp happens to be truthy, and writes otherwise. Comments are
    // stripped first — the route quotes the old line while explaining it.
    const code = jobsBulk.replace(/\r\n?/g, '\n').split('\n')
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    expect(code).not.toMatch(/if \(serverTs && serverTs !== base\)/);
  });

  test('the client sends a base for every row the server said it has', () => {
    expect(APP_SRC).toMatch(/else if \(_serverJobIds\[id\]\) baseVersions\[id\] = UNVERSIONED_BASE;/);
    expect(APP_SRC).toMatch(/var UNVERSIONED_BASE = 'unversioned';/);
  });

  test('the server id list records existence only — never a base version', () => {
    // Adopting _updatedAt from a response the hold REFUSED to apply would claim
    // this client is current at the exact moment it is not.
    const m = APP_SRC.match(/_serverJobIds = \{\};[\s\S]{0,200}?\n/);
    expect(m).not.toBeNull();
    expect(m[0]).not.toMatch(/_jobVersion/);
  });
});
