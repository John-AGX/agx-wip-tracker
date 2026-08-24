/* ──────────────────────────────────────────────────────────────────────────
 * test/helpers/save-harness.js — ONE model of the two bulk-save routes.
 *
 * WHY IT IS A SHARED FILE AND NOT COPIED PER SUITE
 * The model is only worth something because `route fidelity` in
 * test/save-path.test.js pins it to the real endpoints. A second copy would be
 * a second thing to keep faithful, and the copy nobody pinned is the one that
 * quietly starts testing fiction. Every suite that drives js/app.js end to end
 * requires THIS file.
 *
 * Not named *.test.js on purpose — jest's default testMatch would collect it
 * as an empty suite.
 *
 * WHAT THE MODEL ENCODES (all four rules are asserted against the real routes)
 *   jobs bulk save
 *     - per-row UPSERT, never a delete
 *     - a base version that does not match the row's updated_at ⇒ conflict
 *       {reason:'stale'}, row untouched
 *     - a base that CANNOT BE COMPARED — the UNVERSIONED_BASE sentinel, or a
 *       row whose own updated_at is null ⇒ conflict {reason:'unverifiable'}.
 *       A guard that falls through when it cannot compare is not a guard.
 *     - a base version supplied for a row that DOES NOT EXIST ⇒ conflict
 *       {reason:'deleted'}. It is NOT re-inserted. A base means "I loaded this
 *       row and expect it to exist"; if it is gone, somebody deleted it, and
 *       re-creating it is the worst outcome available.
 *     - no base at all ⇒ INSERT. That is how a genuinely new job is created,
 *       and it is the only path that may create one.
 *   estimates bulk save
 *     - the same four rules, since ESTIMATES-GUARD landed. Before it, this
 *       endpoint had no version check of any kind and re-created any id it did
 *       not find, which is why estimates were scoped client-side instead.
 *     - a LOCKED estimate is refused as conflict {reason:'locked'} rather than
 *       skipped silently.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

/* The sentinel the client sends for a row it holds but cannot version. It is
 * not a timestamp, so no comparison can ever accept it — which is the point. */
const UNVERSIONED_BASE = 'unversioned';

function makeServer() {
  let clock = 1000;
  const stamp = () => new Date(clock++).toISOString();
  const jobs = new Map();
  const estimates = new Map();
  const lockedEstimates = new Set();
  const wire = { jobPayloads: [], jobBaseVersions: [], estPayloads: [], estBaseVersions: [] };

  function seedJob(id, blob) { jobs.set(id, { data: { id, ...blob }, updated_at: stamp() }); }
  function seedEstimate(id, blob) { estimates.set(id, { data: { id, ...blob }, updated_at: stamp() }); }

  function listJobs() {
    return {
      jobs: [...jobs.entries()].map(([id, row]) => ({
        ...row.data, id, _canEdit: true, _updatedAt: row.updated_at
      }))
    };
  }
  function listEstimates() {
    return {
      estimates: [...estimates.entries()].map(([id, row]) => ({
        ...row.data, id, updated_at: row.updated_at
      }))
    };
  }

  function bulkSaveJobs(body, baseVersions) {
    wire.jobPayloads.push(JSON.parse(JSON.stringify(body)));
    wire.jobBaseVersions.push(JSON.parse(JSON.stringify(baseVersions || {})));
    const conflicts = [], versions = {};
    const ordered = [...(body.jobs || [])].sort((a, b) =>
      String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
    for (const job of ordered) {
      const existing = jobs.get(job.id);
      const base = baseVersions && baseVersions[job.id];
      if (!existing) {
        if (base) { conflicts.push({ id: job.id, reason: 'deleted', serverUpdatedAt: null }); continue; }
      } else if (base) {
        if (base === UNVERSIONED_BASE || !existing.updated_at) {
          conflicts.push({ id: job.id, reason: 'unverifiable', serverUpdatedAt: existing.updated_at || null });
          continue;
        }
        if (existing.updated_at !== base) {
          conflicts.push({ id: job.id, reason: 'stale', serverUpdatedAt: existing.updated_at });
          continue;
        }
      }
      const blob = { ...job };
      ['buildings', 'phases', 'changeOrders', 'subs', 'purchaseOrders', 'invoices']
        .forEach((k) => { blob[k] = (body[k] || []).filter((r) => r.jobId === job.id); });
      delete blob._canEdit; delete blob._notify; delete blob.owner_id;
      delete blob.market_id; delete blob._updatedAt;
      jobs.set(job.id, { data: blob, updated_at: stamp() });
      versions[job.id] = jobs.get(job.id).updated_at;
    }
    return Promise.resolve({ saved: ordered.length - conflicts.length, conflicts, versions });
  }

  function bulkSaveEstimates(body, baseVersions) {
    wire.estPayloads.push(JSON.parse(JSON.stringify(body)));
    wire.estBaseVersions.push(JSON.parse(JSON.stringify(baseVersions || {})));
    const conflicts = [], versions = {};
    const ordered = [...(body.estimates || [])].sort((a, b) =>
      String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
    for (const est of ordered) {
      const existing = estimates.get(est.id);
      const base = baseVersions && baseVersions[est.id];
      if (lockedEstimates.has(est.id)) {
        conflicts.push({ id: est.id, reason: 'locked', serverUpdatedAt: existing ? existing.updated_at : null });
        continue;
      }
      if (!existing) {
        if (base) { conflicts.push({ id: est.id, reason: 'deleted', serverUpdatedAt: null }); continue; }
      } else if (base && existing.updated_at !== base) {
        conflicts.push({ id: est.id, reason: 'stale', serverUpdatedAt: existing.updated_at });
        continue;
      }
      const blob = { ...est, lines: (body.estimateLines || []).filter((l) => l && l.estimateId === est.id) };
      delete blob.updated_at; delete blob.created_at; delete blob.owner_id; delete blob.market_id;
      const changed = !existing || JSON.stringify(existing.data) !== JSON.stringify(blob);
      estimates.set(est.id, { data: blob, updated_at: changed ? stamp() : existing.updated_at });
      versions[est.id] = estimates.get(est.id).updated_at;
    }
    return Promise.resolve({ ok: true, conflicts, versions });
  }

  return {
    jobs, estimates, lockedEstimates, wire,
    seedJob, seedEstimate, listJobs, listEstimates, bulkSaveJobs, bulkSaveEstimates
  };
}

/* Deferred promise so a test can hold a GET open and edit "mid-flight". */
function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* Boot a FRESH copy of js/app.js against a given server. Module state
 * (_serverLoadOk, the baselines) lives in the module scope, so every scenario
 * gets its own instance rather than inheriting the previous test's history. */
function boot(server, opts) {
  opts = opts || {};
  jest.resetModules();
  window.localStorage.clear();
  if (opts.seedCache) opts.seedCache(window.localStorage);

  const api = {
    isAuthenticated: () => true,
    jobs: {
      list: opts.jobsList || (() => Promise.resolve(server.listJobs())),
      bulkSave: (payload, baseVersions) => server.bulkSaveJobs(payload.appData || payload, baseVersions),
      remove: () => Promise.resolve({ ok: true })
    },
    estimates: {
      list: opts.estimatesList || (() => Promise.resolve(server.listEstimates())),
      bulkSave: (payload, baseVersions) => server.bulkSaveEstimates(payload, baseVersions),
      remove: () => Promise.resolve({ ok: true })
    },
    qbCosts: { list: () => Promise.resolve({ lines: [] }) },
    subs: { list: () => Promise.resolve({ subs: [], trades: [] }) },
    purchaseOrders: { listAll: () => Promise.resolve({ purchase_orders: [] }) },
    changeOrders: { listAll: () => Promise.resolve({ change_orders: [] }) },
    bills: { listAll: () => Promise.resolve({ bills: [] }) },
    invoices: { list: () => Promise.resolve({ invoices: [] }) }
  };
  window.p86Api = api;
  window.p86Auth = { getToken: () => 't', isOffline: () => false };
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }));
  delete window.p86Refresh;   // no registry in the harness; loadData is called directly

  // Load order mirrors index.html. line-identity.js ships BEFORE app.js
  // (index.html: 3382 vs 3484) and app.js installs the estimate-line identity
  // boundary from it the moment appData is created — so a harness that skips
  // it is running a version of the save path the page never runs, and lines
  // arriving through the hydrate door come out unaddressed.
  require('../../js/line-identity.js');
  require('../../js/save-merge.js');
  require('../../js/app.js');
  return { api };
}

/* The real client wraps bulkSave as put('/api/jobs/bulk/save', { appData, baseVersions }),
 * so the harness above unwraps `payload.appData`. Drain microtasks between steps. */
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function jobRow(id, over) {
  return Object.assign({
    id, jobNumber: 'S' + id, title: 'Job ' + id, client: 'C', status: 'In Progress',
    contractAmount: 100000, estimatedCosts: 60000, pctComplete: 10,
    buildings: [], phases: [], changeOrders: [], subs: [], purchaseOrders: [], invoices: []
  }, over || {});
}

/* Seed localStorage the way a PREVIOUS good session left it: job objects carry
 * _updatedAt, which is what gives a failed boot a real base version. */
function cacheSeeder(snapshotJobs, estimates) {
  return function (ls) {
    ls.setItem('p86-jobs-jobs', JSON.stringify((snapshotJobs || []).map((j) => {
      const c = { ...j };
      ['buildings', 'phases', 'changeOrders', 'subs', 'purchaseOrders', 'invoices']
        .forEach((k) => delete c[k]);
      return c;
    })));
    ['buildings', 'phases', 'subs', 'changeorders', 'purchaseorders', 'invoices']
      .forEach((k) => ls.setItem('p86-jobs-' + k, '[]'));
    ls.setItem('p86-estimates', JSON.stringify(estimates || []));
    ls.setItem('p86-estimate-lines', '[]');
  };
}

module.exports = { makeServer, defer, boot, settle, jobRow, cacheSeeder, UNVERSIONED_BASE };
