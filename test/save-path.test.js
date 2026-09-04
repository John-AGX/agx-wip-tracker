/**
 * @jest-environment jsdom
 */
// The job/estimate save path (js/app.js), driven end to end against a model of
// the two bulk-save routes.
//
// WHY THE ASSERTIONS ARE ON THE SERVER AND NOT ON appData
// The defect this file exists for was invisible in appData by construction:
// the app rendered a job it had not created, kept it in localStorage, and only
// lost it when the hydrate landed. `appData.jobs` said "saved" the whole time.
// So every check that matters here reads the FAKE SERVER's rows and the exact
// payload the client put on the wire — the same rule as the standing
// instruction to verify persistence via GET /api/jobs/:id rather than memory.
//
// WHY A MODEL SERVER AND NOT THE REAL ROUTES
// server/routes/* pulls express + pg + JWT_SECRET, which is the documented
// reason pure logic belongs outside them. test/helpers/save-harness.js
// reproduces the two route behaviours this path depends on, and the
// `route fidelity` group at the bottom asserts those behaviours are still what
// the real routes do — so if the server changes, this file fails rather than
// quietly testing fiction. The model lives in ONE file because a second copy
// is a second thing to keep faithful, and the copy nobody pinned is the one
// that starts testing fiction.

const fs = require('fs');
const path = require('path');
const { makeServer, defer, boot, settle, jobRow } = require('./helpers/save-harness');

const JOB_ROUTES = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'routes', 'job-routes.js'), 'utf8');
const EST_ROUTES = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'routes', 'estimate-routes.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

beforeEach(() => { jest.useRealTimers(); });

/* ══════════════════════════════════════════════════════════════════════════
 * 1. An edit made while a hydrate is in flight survives it — and reaches the
 *    server. This is the sequence the whole change exists for.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('an edit made during an in-flight hydrate', () => {
  test('is not destroyed by the hydrate, and lands on the server', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    const gate = defer();
    let call = 0;

    boot(server, {
      // Call 1 = boot. Call 2 hangs on the gate — that is the hydrate the user
      // types across. Call 3 is the follow-up the hold issues once its push has
      // landed, and it reads the server FRESH, exactly as a real GET would.
      jobsList: () => {
        call++;
        if (call === 2) return gate.promise.then(() => server.listJobs());
        return Promise.resolve(server.listJobs());
      }
    });

    await window.p86Data.reloadFromServer();       // boot load: baselines built
    await settle();
    expect(window.appData.jobs).toHaveLength(1);

    // A second load starts (an agent write, a refresh, a reconnect)…
    const second = window.p86Data.reloadFromServer();
    await settle();
    // …and the user types into the job while that GET is on the wire.
    window.appData.jobs[0].contractAmount = 250000;

    // The GET resolves carrying the OLD server state — the exact payload that
    // used to overwrite memory, then the cache, then the evidence.
    gate.resolve();
    await second;
    await settle(40);

    // The part that actually matters: it reached Postgres, not just appData.
    expect(server.jobs.get('j1').data.contractAmount).toBe(250000);
    // …and memory converged on it rather than on the pre-edit snapshot.
    expect(window.appData.jobs[0].contractAmount).toBe(250000);
    // The cache too — a tab closed at any point in that sequence comes back
    // to the edit, not to the value the hydrate would have overwritten it with.
    expect(JSON.parse(window.localStorage.getItem('p86-jobs-jobs'))[0].contractAmount).toBe(250000);
  });

  test('the hold does not stall the direct-REST money mirrors', async () => {
    // The money tiles read jobPurchaseOrders / jobChangeOrders / arInvoices,
    // which are NOT on the appData+saveData path. Holding them back would put
    // wrong money on screen with nothing to explain it, so the hold is scoped
    // to the four job/estimate lines only.
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    const gate = defer();
    let call = 0;
    boot(server, { jobsList: () => { call++; return call === 2 ? gate.promise : Promise.resolve(server.listJobs()); } });
    window.p86Api.purchaseOrders.listAll = () =>
      Promise.resolve({ purchase_orders: [{ id: 'po9', job_id: 'j1', amount: 4200 }] });

    await window.p86Data.reloadFromServer();
    await settle();
    const second = window.p86Data.reloadFromServer();
    await settle();
    window.appData.jobs[0].contractAmount = 777;
    // Resolve with the PRE-push snapshot — the payload the hold refuses to
    // apply to jobs. The money mirrors ride the same response and must still
    // land, or the screen shows stale money with nothing to explain it.
    gate.resolve(server.listJobs());
    await second;
    await settle(6);

    expect(window.appData.jobPurchaseOrders).toHaveLength(1);   // hydrated anyway
    expect(server.wire.jobPayloads.length).toBeGreaterThan(0);  // and the hold pushed
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. An edit made after a failed boot is not silently lost.
 *    A 502 during a Railway swap used to latch pushes off for the whole
 *    session; the only signal was a console.warn.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('an edit made after a failed boot', () => {
  test('reaches the server once it comes back, carrying a real base version', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    const snapshot = server.listJobs().jobs;
    let down = true;

    boot(server, {
      // The cache is what a previous GOOD session left behind, so it carries
      // _updatedAt per job — which is what gives the failed boot a base.
      seedCache: (ls) => {
        ls.setItem('p86-jobs-jobs', JSON.stringify(snapshot.map((j) => {
          const c = { ...j };
          ['buildings', 'phases', 'changeOrders', 'subs', 'purchaseOrders', 'invoices']
            .forEach((k) => delete c[k]);
          return c;
        })));
        ['buildings', 'phases', 'subs', 'changeorders', 'purchaseorders', 'invoices']
          .forEach((k) => ls.setItem('p86-jobs-' + k, '[]'));
        ls.setItem('p86-estimates', '[]');
        ls.setItem('p86-estimate-lines', '[]');
      },
      jobsList: () => (down ? Promise.reject(new Error('HTTP 502')) : Promise.resolve(server.listJobs()))
    });

    await window.p86Data.reloadFromServer();      // boot GET 502s
    await settle();
    expect(window.p86SaveState().writable).toBe(false);

    // John keeps working through the deploy window.
    window.appData.jobs[0].contractAmount = 512000;
    window.p86FlushSave();                        // pagehide / manual flush
    await settle();
    expect(server.jobs.get('j1').data.contractAmount).toBe(100000);  // nothing pushed yet
    // …and it is NOT silent: the state names the row that is only on this device.
    expect(window.p86SaveState().jobs).toEqual(['Job j1']);

    // Railway finishes the swap.
    down = false;
    await window.p86Data.reloadFromServer();
    await settle(40);

    expect(server.jobs.get('j1').data.contractAmount).toBe(512000);
    // Refereed, not forced: the push carried the base the cache recorded.
    const bv = server.wire.jobBaseVersions[server.wire.jobBaseVersions.length - 1];
    expect(bv.j1).toBe(snapshot[0]._updatedAt);
  });

  test('the failed boot names only what the user changed, not the whole portfolio', async () => {
    // With no baseline at all, every job reads dirty — which would make the
    // banner claim 20-odd unsaved changes for one edited field, and would put
    // the entire stale cache on the wire the moment a push became possible.
    const server = makeServer();
    ['j1', 'j2', 'j3'].forEach((id) => server.seedJob(id, jobRow(id)));
    const snapshot = server.listJobs().jobs;
    boot(server, {
      seedCache: (ls) => {
        ls.setItem('p86-jobs-jobs', JSON.stringify(snapshot.map((j) => {
          const c = { ...j };
          ['buildings', 'phases', 'changeOrders', 'subs', 'purchaseOrders', 'invoices']
            .forEach((k) => delete c[k]);
          return c;
        })));
        ['buildings', 'phases', 'subs', 'changeorders', 'purchaseorders', 'invoices']
          .forEach((k) => ls.setItem('p86-jobs-' + k, '[]'));
        ls.setItem('p86-estimates', '[]');
        ls.setItem('p86-estimate-lines', '[]');
      },
      jobsList: () => Promise.reject(new Error('HTTP 502'))
    });

    await window.p86Data.reloadFromServer();
    await settle();
    expect(window.p86SaveState().jobIds).toEqual([]);      // nothing edited => nothing unsaved

    window.appData.jobs[1].contractAmount = 1;
    expect(window.p86SaveState().jobIds).toEqual(['j2']);  // exactly the one row
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. Nothing resurrects a deleted row.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('a row deleted elsewhere', () => {
  test('is not re-created by an unrelated estimate edit', async () => {
    // The shape that made this reachable: the estimates bulk save shipped
    // appData.estimates WHOLESALE on every save, against an endpoint whose
    // INSERT re-creates any id it does not find. Editing estimate F therefore
    // re-uploaded estimate E — which another session had just deleted.
    const server = makeServer();
    server.seedEstimate('e1', { title: 'Keep', lines: [] });
    server.seedEstimate('e2', { title: 'Doomed', lines: [] });
    boot(server);

    await window.p86Data.reloadFromServer();
    await settle();
    expect(window.appData.estimates).toHaveLength(2);

    // Another session deletes e2 (a real REST DELETE — it lands).
    server.estimates.delete('e2');

    // This client, still holding e2 in memory, edits e1.
    window.appData.estimates.find((e) => e.id === 'e1').title = 'Keep (edited)';
    window.p86FlushSave();
    await settle(20);

    expect(server.estimates.has('e2')).toBe(false);          // stayed deleted
    expect(server.estimates.get('e1').data.title).toBe('Keep (edited)');
    const sent = server.wire.estPayloads[server.wire.estPayloads.length - 1];
    expect(sent.estimates.map((e) => e.id)).toEqual(['e1']); // only the touched row
  });

  test('a job deleted elsewhere is not re-created by an unrelated job edit', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    server.seedJob('j2', jobRow('j2'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();

    server.jobs.delete('j2');
    window.appData.jobs.find((j) => j.id === 'j1').contractAmount = 5;
    window.p86FlushSave();
    await settle(20);

    expect(server.jobs.has('j2')).toBe(false);
    const sent = server.wire.jobPayloads[server.wire.jobPayloads.length - 1];
    expect(sent.jobs.map((j) => j.id)).toEqual(['j1']);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Stale local data never overwrites a newer server row.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('a newer server row', () => {
  test('is not overwritten by this client — the server refuses and says so', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();

    // Another session writes j1 after we loaded it.
    server.jobs.set('j1', {
      data: { ...server.jobs.get('j1').data, contractAmount: 999999 },
      updated_at: new Date(99999).toISOString()
    });

    window.appData.jobs[0].contractAmount = 42;
    window.p86FlushSave();
    await settle(20);

    // The other session's number is intact. Ours was rejected, not merged.
    expect(server.jobs.get('j1').data.contractAmount).toBe(999999);
  });

  test('a hydrate held for an unpushed change still sends a base version', async () => {
    // "Never push a replay without a base" — an unversioned push is the one
    // failure mode the server cannot referee, and therefore the only one that
    // would be silent.
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    const gate = defer();
    let first = true;
    boot(server, {
      jobsList: () => (first ? ((first = false), Promise.resolve(server.listJobs())) : gate.promise)
    });
    await window.p86Data.reloadFromServer();
    await settle();
    const second = window.p86Data.reloadFromServer();
    await settle();
    window.appData.jobs[0].contractAmount = 31337;
    gate.resolve(server.listJobs());
    await second;
    await settle(30);

    const bv = server.wire.jobBaseVersions[server.wire.jobBaseVersions.length - 1];
    expect(bv.j1).toBeTruthy();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. Money is never altered — only the timing of when it is written changes.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('money', () => {
  test('a held-then-pushed job round-trips every money field byte for byte', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1', {
      buildings: [{ id: 'b1', jobId: 'j1', name: 'A', asSoldBudget: 40000, coBudget: 1500, budget: 41500 }],
      phases: [{ id: 'p1', jobId: 'j1', buildingId: 'b1', phaseType: 'Gutters',
                 asSoldPhaseBudget: 12345.67, coPhaseBudget: 250.33, phaseBudget: 12596.00,
                 asSoldRevenue: 12345.67 }]
    }));
    const gate = defer();
    let first = true;
    boot(server, {
      jobsList: () => (first ? ((first = false), Promise.resolve(server.listJobs())) : gate.promise)
    });
    await window.p86Data.reloadFromServer();
    await settle();

    const second = window.p86Data.reloadFromServer();
    await settle();
    window.appData.jobs[0].notes = 'touched during the hydrate';   // the edit
    gate.resolve(server.listJobs());
    await second;
    await settle(30);

    const stored = server.jobs.get('j1').data;
    expect(stored.notes).toBe('touched during the hydrate');
    expect(stored.contractAmount).toBe(100000);
    expect(stored.estimatedCosts).toBe(60000);
    expect(stored.buildings[0]).toMatchObject({ asSoldBudget: 40000, coBudget: 1500, budget: 41500 });
    expect(stored.phases[0]).toMatchObject({
      asSoldPhaseBudget: 12345.67, coPhaseBudget: 250.33, phaseBudget: 12596.00, asSoldRevenue: 12345.67
    });
  });

  test('a job is never written without its phases — a torn slice is how a job reports two totals', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1', {
      phases: [{ id: 'p1', jobId: 'j1', phaseType: 'Gutters', asSoldPhaseBudget: 900, phaseBudget: 900 }]
    }));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();
    window.appData.jobs[0].title = 'renamed';
    window.p86FlushSave();
    await settle(20);

    // The route rebuilds the blob by FILTERING the payload arrays on jobId, so
    // a payload without the phases does not partially write — it writes an
    // EMPTY phases array and the money disappears.
    expect(server.jobs.get('j1').data.phases).toHaveLength(1);
    expect(server.jobs.get('j1').data.phases[0].phaseBudget).toBe(900);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. An edit that lands DURING a push is not marked saved.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('an edit that arrives mid-push', () => {
  test('stays dirty and goes out on the next push', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();

    const gate = defer();
    const realSave = server.bulkSaveJobs;
    let held = true;
    window.p86Api.jobs.bulkSave = (payload, bv) => {
      if (!held) return realSave(payload.appData || payload, bv);
      held = false;
      return gate.promise.then(() => realSave(payload.appData || payload, bv));
    };

    window.appData.jobs[0].contractAmount = 111;
    const push = window.p86Data.pushToServer();
    await settle();
    // A keystroke while the request is on the wire.
    window.appData.jobs[0].contractAmount = 222;
    gate.resolve();
    await push;
    await settle(10);

    // The re-baseline advanced to what was SENT (111), so 222 is still dirty…
    expect(window.p86SaveState().jobIds).toEqual(['j1']);
    // …and the next flush carries it.
    window.p86FlushSave();
    await settle(20);
    expect(server.jobs.get('j1').data.contractAmount).toBe(222);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. Silence is the defect: the blocked/failed states are announced.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('the signal', () => {
  test('a blocked save emits a status instead of returning silently', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    boot(server, { jobsList: () => Promise.reject(new Error('HTTP 502')) });

    const seen = [];
    window.p86PushStatus.subscribe((s, d) => seen.push([s, d && d.reason]));
    await window.p86Data.reloadFromServer();
    await settle();

    expect(seen.some(([s]) => s === 'load-failed')).toBe(true);
    // …and specifically NOT 'failed', which means "a push was refused after
    // its retries" and would show "Save failed" before the user has typed.
    expect(seen.some(([s]) => s === 'failed')).toBe(false);
  });

  test('flushPendingSave is not a no-op when no debounce timer was ever armed', async () => {
    // The guard in saveData returns BEFORE arming the 600ms timer, so
    // `if (!_serverPushTimer) return` made pagehide/beforeunload/visibility
    // permanent no-ops in exactly the case where the flush was the last chance.
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();

    window.appData.jobs[0].contractAmount = 8;   // mutate WITHOUT going through saveData
    window.p86FlushSave();
    await settle(20);
    expect(server.jobs.get('j1').data.contractAmount).toBe(8);
  });

  test('p86SaveState counts entities, not blocked calls', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle();
    const j = window.appData.jobs[0];
    j.contractAmount = 1; j.title = 'a'; j.notes = 'b'; j.client = 'c';
    expect(window.p86SaveState().jobs).toHaveLength(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. Source invariants — the shapes that made the defect possible.
 *    These are SOURCE checks because each one is a structural property that a
 *    runtime test can pass around: a re-baseline that reads live memory looks
 *    identical to one that reads the sent snapshot on any single-threaded run
 *    that happens not to interleave.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('source invariants in js/app.js', () => {
  const code = APP_SRC.replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

  test('the blocked branch of saveData does not return silently', () => {
    const m = code.match(/if \(!_serverLoadOk \|\| _serverLoadInFlight\) \{([\s\S]{0,1200}?)\n            \}/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/notifyPushStatus\(/);
  });

  test('_serverLoadOk is set before the hold is consulted, not inside it', () => {
    const okAt = code.indexOf('_serverLoadOk = true;\n                _pushRetryCount');
    const holdAt = code.indexOf('shouldVetoHydrate({');
    expect(okAt).toBeGreaterThan(-1);
    expect(holdAt).toBeGreaterThan(-1);
    expect(okAt).toBeLessThan(holdAt);
  });

  test('the hold pushes directly and never re-fires the refresh registry', () => {
    const hold = code.slice(code.indexOf('if (_held.veto) {'), code.lastIndexOf('_consecutiveHolds = 0;'));
    expect(hold.length).toBeGreaterThan(200);
    expect(hold).toMatch(/pushToServer\(\)/);
    expect(hold).not.toMatch(/p86Refresh/);
  });

  test('the estimates payload is scoped to touched rows, never the whole portfolio', () => {
    expect(code).not.toMatch(/estimates:\s*appData\.estimates\s*,/);
    expect(code).toMatch(/estimates:\s*appData\.estimates\.filter\(/);
  });

  test('the re-baseline advances to the SENT signature, not live memory', () => {
    expect(code).toMatch(/_jobBaseline\[id\] = sentJobSig\[id\]/);
    expect(code).not.toMatch(/_jobBaseline\[id\] = jobSliceSig\(id\)\s*;\s*\}\)\s*;/);
  });

  test("flushPendingSave does not open with the timer guard", () => {
    const fn = code.slice(code.indexOf('function flushPendingSave()'), code.indexOf('function flushPendingSave()') + 900);
    expect(fn).not.toMatch(/if \(!_serverPushTimer\) return/);
  });

  test('a partial-conflict response does not report success — from EITHER store', () => {
    expect(code).toMatch(/notifyPushStatus\('partial'/);
    const push = code.slice(code.indexOf("if (conflicts) handleSaveConflicts(conflicts, 'job');"),
                            code.indexOf('return r;'));
    expect(push.length).toBeGreaterThan(200);
    // An estimate conflict must reach the same branch a job conflict does. It
    // did not before: the estimates response was not read at all, so a refused
    // estimate reported a green check.
    expect(push).toMatch(/if \(estConflicts\) handleSaveConflicts\(estConflicts, 'estimate'\)/);
    expect(push).toMatch(/if \(conflicts \|\| estConflicts\) \{/);
    expect(push).toMatch(/else \{[\s\S]*notifyPushStatus\('saved'\)/);
  });

  test('a rejected estimate is not re-baselined as saved', () => {
    // `dirtyEstIds.forEach(id => _estimateBaseline[id] = sentEstSig[id])` with
    // no rejection filter marks a refused row clean, and the edit is gone on
    // the next hydrate with nothing having reported a failure.
    expect(code).toMatch(/dirtyEstIds\.forEach\(function\(id\) \{ if \(!estRejected\[id\]\) _estimateBaseline\[id\] = sentEstSig\[id\]; \}\);/);
  });

  test('the pushToServer guard is intact — nothing bypasses it', () => {
    expect(code).toMatch(/if \(!_serverLoadOk\) \{\s*console\.warn\('pushToServer skipped/);
  });

  test('the three editor-entry gates still check p86DataLoading, not _serverLoadOk', () => {
    const est = fs.readFileSync(path.join(__dirname, '..', 'js', 'estimates.js'), 'utf8');
    const ee = fs.readFileSync(path.join(__dirname, '..', 'js', 'estimate-editor.js'), 'utf8');
    // Widening these to _serverLoadOk is the lockout: after a failed boot it is
    // false for the session, so the user could not open an editor at all.
    expect((est.match(/p86DataLoading\(\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(ee).toMatch(/p86DataLoading\(\)/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 9. Route fidelity — the model above is only worth something if it still
 *    matches the real endpoints.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('route fidelity', () => {
  const jobsBulk = JOB_ROUTES.slice(JOB_ROUTES.indexOf("router.put('/bulk/save'"));

  test('jobs bulk save is an upsert that never deletes', () => {
    expect(jobsBulk).toMatch(/INSERT INTO jobs[\s\S]*ON CONFLICT \(id\) DO UPDATE/);
    expect(jobsBulk.slice(0, jobsBulk.indexOf('await client.query(\'COMMIT\')')))
      .not.toMatch(/DELETE FROM jobs/);
  });

  test('jobs bulk save guards on baseVersions under FOR UPDATE', () => {
    expect(jobsBulk).toMatch(/FOR UPDATE/);
    expect(jobsBulk).toMatch(/const base = bv\[job\.id\];/);
    expect(jobsBulk).toMatch(/conflicts\.push\(/);
  });

  test('a base version supplied for a row that no longer exists is a conflict, never an INSERT', () => {
    // THE resurrection guard. If this assertion ever has to be deleted, read
    // the comment above it in the route first: a client supplies a base only
    // for a row it LOADED, so a missing row means somebody deleted it, and the
    // INSERT below would put it back.
    expect(jobsBulk).toMatch(
      /if \(!existing\.rows\.length\) \{\s*if \(base\) \{\s*conflicts\.push\(\{ id: job\.id, reason: 'deleted'/);
  });

  test('estimates bulk save now guards on baseVersions under FOR UPDATE, exactly like jobs', () => {
    // It used to have NO version check of any kind, which is why estimates were
    // scoped client-side as the only mitigation. Scoping still applies — a row
    // you never touched has no business on the wire — but it is no longer the
    // ONLY thing standing between a held estimate and an agent's newer write.
    const estBulk = EST_ROUTES.slice(EST_ROUTES.indexOf("router.put('/bulk/save'"));
    expect(estBulk).toMatch(/INSERT INTO estimates[\s\S]*ON CONFLICT \(id\) DO UPDATE/);
    expect(estBulk).toMatch(/const ebv = \(baseVersions && typeof baseVersions === 'object'\)/);
    // organization_id joined updated_at in this PROJECTION when the tenant
    // branch landed (see test/estimate-org-boundary.test.js). It is asserted
    // here rather than the old exact string being relaxed: the read must stay
    // UNFILTERED — a `WHERE … AND organization_id = $2` would make a foreign
    // row indistinguishable from a deleted one and push it into the arm that
    // has no guard — while still carrying the tenant, because a branch cannot
    // decide on a column the SELECT did not fetch.
    expect(estBulk).toMatch(/SELECT updated_at, organization_id FROM estimates WHERE id = \$1 FOR UPDATE/);
    expect(estBulk).toMatch(/reason: 'not_in_org'/);
    expect(estBulk).toMatch(/reason: 'deleted'/);
    expect(estBulk).toMatch(/reason: 'unverifiable'/);
    expect(estBulk).toMatch(/reason: 'stale'/);
  });

  test('a locked estimate is REPORTED, not skipped in silence', () => {
    // `continue` left the client re-baselining the row as saved, which turned
    // "this estimate is sold and immutable" into a dropped edit.
    const estBulk = EST_ROUTES.slice(EST_ROUTES.indexOf("router.put('/bulk/save'"));
    expect(estBulk).toMatch(/if \(lockedIds\.has\(est\.id\)\) \{[\s\S]{0,600}?reason: 'locked'/);
    expect(estBulk).not.toMatch(/if \(lockedIds\.has\(est\.id\)\) continue;/);
  });

  test('the jobs blob is rebuilt by filtering the payload arrays on jobId', () => {
    expect(jobsBulk).toMatch(/buildings: \(appData\.buildings \|\| \[\]\)\.filter\(b => b\.jobId === job\.id\)/);
  });

  test('jobs GET hands the client _updatedAt as the base version', () => {
    expect(JOB_ROUTES).toMatch(/_updatedAt: j\.updated_at/);
  });

  test('estimates GET hands the client updated_at', () => {
    expect(EST_ROUTES).toMatch(/updated_at: r\.updated_at/);
  });
});
