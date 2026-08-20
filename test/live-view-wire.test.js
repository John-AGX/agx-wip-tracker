// Live Rooms phase 02 — THE WIRE SWEEP.
//
// The claim this phase has to make true is "the server never sends those
// numbers". That is not a claim a grep can settle. A grep proves a STRING is
// absent from SOURCE; the claim is that a VALUE is absent from the BYTES A
// SPECIFIC READER RECEIVED. So this suite drives a real guest through a real
// router over a real socket, concatenates every byte written to that guest —
// SSE frames, view documents, beat responses, the ?after= replay — and searches
// the buffer.
//
// Six tests, and the fourth is the one that keeps the other five honest:
//
//   1. the corpus is sound (no seeded value collides with a constant the guest
//      legitimately receives, so a hit is a hit)
//   2. THE SWEEP — no canary, in any rendering, in any byte
//   3. the derivation closure — nothing that DID ship reconstructs one
//   4. THE POSITIVE CONTROL — the identical sweep with financials OFF finds the
//      canaries. Without this, a harness that silently captured nothing would
//      pass forever and a wire test that cannot fail proves nothing at all.
//   5. the shape assertion — every money cell is exactly { r: true }
//   6. THE REGISTRY LOCK — every surface in the frozen allow-list is driven by
//      test 2. Adding a surface and forgetting the sweep breaks the build,
//      which converts "did we remember" from vigilance into a compile error.
//
// Plus the boundary properties a guest read introduces: no entity but the
// presented one, no mutation, no resume after a kick or an expiry.

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const C = require('./fixtures/live-money-canaries');

let queries;
let db;

jest.mock('../server/rate-limit', () => ({
  ipLoginLimiter: (req, res, next) => next(),
  ipGenericLimiter: (req, res, next) => next(),
  aiChatLimiter: (req, res, next) => next(),
  aiChatHourlyLimiter: (req, res, next) => next(),
  ingestLimiter: (req, res, next) => next(),
  liveJoinLimiter: (req, res, next) => next(),
  liveStreamLimiter: (req, res, next) => next(),
  liveViewLimiter: (req, res, next) => next(),
  liveRoomViewLimiter: (req, res, next) => next()
}));

// The forward-facing title is stubbed to a string that CONTAINS a money canary,
// because entity labels are author-written text and the scrubber is what has to
// catch that. A stub with no numbers in it would make the prose clause
// unfalsifiable.
jest.mock('../server/services/entity-labels', () => ({
  resolveEntityLabels: async (orgId, items) => {
    const m = new Map();
    for (const it of items) {
      m.set(it.entity_type + ':' + String(it.entity_id), 'RV2006 Waterside — 776522 contract');
    }
    return m;
  }
}));

jest.mock('../server/db', () => ({
  pool: { query: async (sql, params) => mockRun(sql, params) }
}));

function nowish() { return new Date(); }

function mockRun(sql, params) {
  const text = String(sql);
  const p = params || [];
  queries.push({ sql: text, params: p });

  // ── the entity itself, with its blob ───────────────────────────────────
  if (/SELECT id, organization_id, data FROM jobs WHERE id/i.test(text)) {
    const j = db.jobs.find((x) => String(x.id) === String(p[0]));
    return { rows: j ? [j] : [] };
  }
  if (/FROM jobs WHERE/i.test(text)) {
    const j = db.jobs.find((x) => String(x.id) === String(p[0]));
    return { rows: j ? [{ id: j.id, organization_id: j.organization_id }] : [] };
  }
  if (/FROM users WHERE id/i.test(text)) {
    const u = db.users.find((x) => String(x.id) === String(p[0]));
    return { rows: u ? [u] : [] };
  }

  // ── the money tables ───────────────────────────────────────────────────
  if (/FROM job_change_orders WHERE job_id = \$1/i.test(text)) {
    return { rows: db.changeOrders.filter((r) => String(r.job_id) === String(p[0])) };
  }
  if (/FROM invoices WHERE job_id = \$1/i.test(text)) {
    return { rows: db.invoices.filter((r) => String(r.job_id) === String(p[0])) };
  }
  if (/FROM qb_cost_lines WHERE job_id = ANY/i.test(text)) {
    return { rows: db.qbCostLines.filter((r) => p[0].indexOf(r.job_id) !== -1) };
  }
  if (/FROM job_vendor_bills WHERE job_id = ANY/i.test(text)) {
    return { rows: db.vendorBills.filter((r) => p[0].indexOf(r.job_id) !== -1) };
  }
  if (/FROM job_purchase_orders WHERE job_id = ANY/i.test(text)) {
    return { rows: db.purchaseOrders.filter((r) => p[0].indexOf(r.job_id) !== -1) };
  }
  if (/FROM job_purchase_orders po/i.test(text)) {
    return { rows: db.purchaseOrders.filter((r) => String(r.job_id) === String(p[0])) };
  }

  // ── live_rooms ─────────────────────────────────────────────────────────
  if (/INSERT INTO live_rooms/i.test(text)) {
    const room = {
      id: p[0], organization_id: p[1], token: p[2], entity_type: p[3], entity_id: p[4],
      host_user_id: p[5], scope: 'view', expires_at: p[6], served_by: p[7],
      created_at: nowish(), last_host_beat_at: nowish(), served_beat_at: nowish(),
      ended_at: null, ended_reason: null, revoked_at: null, takeover_count: 0,
      hide_financials: true      // the column's DEFAULT TRUE, honoured by the mock
    };
    db.rooms.push(room);
    return { rows: [room] };
  }
  if (/SELECT \* FROM live_rooms\s+WHERE entity_type/i.test(text)) {
    return { rows: db.rooms.filter((r) => r.entity_type === p[0] && String(r.entity_id) === String(p[1]) && !r.ended_at && !r.revoked_at) };
  }
  if (/SELECT \* FROM live_rooms WHERE token/i.test(text)) {
    return { rows: db.rooms.filter((r) => r.token === p[0]) };
  }
  if (/SELECT \* FROM live_rooms WHERE id/i.test(text)) {
    return { rows: db.rooms.filter((r) => r.id === p[0]) };
  }
  if (/SELECT \* FROM live_rooms\s+WHERE organization_id/i.test(text)) {
    return { rows: db.rooms.filter((r) => String(r.organization_id) === String(p[0]) && String(r.host_user_id) === String(p[1]) && !r.ended_at && !r.revoked_at) };
  }
  if (/SELECT id, expires_at, ended_at/i.test(text)) {
    return { rows: db.rooms.filter((r) => !r.ended_at && !r.revoked_at) };
  }
  if (/UPDATE live_rooms SET hide_financials/i.test(text)) {
    const r = db.rooms.find((x) => x.id === p[0]);
    if (r) r.hide_financials = p[1];
    return { rows: [] };
  }
  if (/UPDATE live_rooms SET ended_at/i.test(text)) {
    const r = db.rooms.find((x) => x.id === p[0] && !x.ended_at);
    if (r) { r.ended_at = nowish(); r.ended_reason = p[1]; }
    return { rows: [] };
  }
  if (/UPDATE live_rooms SET revoked_at/i.test(text)) {
    const r = db.rooms.find((x) => x.id === p[0] && !x.revoked_at);
    if (r) r.revoked_at = nowish();
    return { rows: [] };
  }
  if (/UPDATE live_rooms\s+SET served_by/i.test(text)) {
    const r = db.rooms.find((x) => x.id === p[0]);
    if (r) { r.served_by = p[1]; r.takeover_count += 1; }
    return { rows: r ? [{ takeover_count: r.takeover_count }] : [] };
  }
  if (/UPDATE live_rooms SET last_host_beat_at/i.test(text)) {
    const r = db.rooms.find((x) => x.id === p[0] && !x.ended_at);
    if (r) r.last_host_beat_at = nowish();
    return { rows: [] };
  }
  if (/UPDATE live_rooms SET served_beat_at/i.test(text)) return { rows: [] };

  // ── live_participants ──────────────────────────────────────────────────
  if (/INSERT INTO live_participants/i.test(text)) {
    db.participants.push({
      id: p[0], room_id: p[1], organization_id: p[2], user_id: p[3],
      display_name: p[4], role: p[5], stream_key: p[6],
      joined_at: nowish(), last_seen_at: nowish(),
      left_at: null, left_reason: null, kicked_at: null, kicked_by: null
    });
    return { rows: [] };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM live_participants/i.test(text)) {
    return { rows: [{ n: db.participants.filter((x) => x.room_id === p[0] && !x.left_at && !x.kicked_at).length }] };
  }
  if (/FROM live_participants p\s+JOIN live_rooms r/i.test(text)) {
    const pt = db.participants.find((x) => x.room_id === p[0] && x.stream_key === p[1] && !x.left_at && !x.kicked_at);
    if (!pt) return { rows: [] };
    const r = db.rooms.find((x) => x.id === pt.room_id);
    if (!r) return { rows: [] };
    return { rows: [Object.assign({}, r, { participant_id: pt.id, role: pt.role, display_name: pt.display_name, user_id: pt.user_id, joined_at: pt.joined_at })] };
  }
  if (/SELECT id, user_id, display_name, role, joined_at/i.test(text)) {
    return { rows: db.participants.filter((x) => x.room_id === p[0] && !x.left_at && !x.kicked_at) };
  }
  if (/SELECT id, room_id, organization_id, role FROM live_participants/i.test(text)) {
    const pt = db.participants.find((x) => x.id === p[0] && x.room_id === p[1]);
    return { rows: pt ? [pt] : [] };
  }
  const revokes = /stream_key = NULL/i.test(text);
  if (/UPDATE live_participants\s+SET kicked_at/i.test(text)) {
    const pt = db.participants.find((x) => x.id === p[0]);
    if (pt) {
      pt.kicked_at = nowish(); pt.kicked_by = p[1];
      pt.left_at = pt.left_at || nowish(); pt.left_reason = pt.left_reason || 'kicked';
      if (revokes) pt.stream_key = null;
    }
    return { rows: [] };
  }
  if (/UPDATE live_participants[\s\S]*role = 'host'/i.test(text)) {
    const hits = db.participants.filter((x) => x.room_id === p[0] && x.role === 'host' && !x.left_at);
    for (const x of hits) { x.left_at = nowish(); x.left_reason = 'superseded'; if (revokes) x.stream_key = null; }
    return { rows: hits.map((x) => ({ id: x.id })) };
  }
  if (/UPDATE live_participants[\s\S]*left_reason = 'left'/i.test(text)) {
    const pt = db.participants.find((x) => x.id === p[0] && !x.left_at);
    if (pt) { pt.left_at = nowish(); pt.left_reason = 'left'; if (revokes) pt.stream_key = null; }
    return { rows: [] };
  }
  if (/UPDATE live_participants[\s\S]*left_reason = 'timeout'/i.test(text)) {
    const pt = db.participants.find((x) => x.id === p[0] && !x.left_at);
    if (pt) { pt.left_at = nowish(); pt.left_reason = 'timeout'; if (revokes) pt.stream_key = null; }
    return { rows: [] };
  }
  if (/UPDATE live_participants[\s\S]*SET left_at = NOW\(\), left_reason = COALESCE/i.test(text)) {
    for (const x of db.participants.filter((y) => y.room_id === p[0] && !y.left_at)) {
      x.left_at = nowish(); x.left_reason = x.left_reason || p[1];
      if (revokes) x.stream_key = null;
    }
    return { rows: [] };
  }
  if (/UPDATE live_participants SET last_seen_at/i.test(text)) return { rows: [] };

  return { rows: [] };
}

const { signToken, setRolePool } = require('../server/auth');
const liveRoutes = require('../server/routes/live-routes');
const LV = require('../server/services/live-view');
const jobWip = require('../server/services/money/job-wip');
const jobMoney = require('../server/services/money/change-order-totals');
const jobCostBuckets = require('../server/services/money/job-cost-buckets');
setRolePool(require('../server/db').pool);

let server, baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(require('cookie-parser')());
  app.use('/api/live', liveRoutes);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    done();
  });
});

afterAll((done) => {
  liveRoutes.__internals.stopSweeper();
  for (const id of Array.from(liveRoutes.__internals._rooms.keys())) {
    liveRoutes.__internals.destroyHub(id, 'test');
  }
  server.close(() => done());
});

beforeEach(() => {
  queries = [];
  db = {
    users: [{ id: 10, name: 'Host A', organization_id: C.IDENTITY.orgId }],
    jobs: [
      { id: C.IDENTITY.jobId, organization_id: C.IDENTITY.orgId, data: C.jobBlob() },
      // A second job in the SAME org. It is the one a mirror that trusted the
      // host's claimed entity id would happily serve.
      { id: 'job_other_9911', organization_id: C.IDENTITY.orgId, data: { title: 'Not this one', contractAmount: 999111.77 } }
    ],
    changeOrders: C.changeOrderRows(),
    invoices: C.invoiceRows(),
    qbCostLines: C.qbCostLineRows(),
    vendorBills: C.vendorBillRows(),
    purchaseOrders: C.purchaseOrderRows(),
    rooms: [],
    participants: []
  };
  for (const id of Array.from(liveRoutes.__internals._rooms.keys())) {
    liveRoutes.__internals.destroyHub(id, 'test-reset');
  }
  liveRoutes.__internals._softBans.clear();
});

function tokenFor(user) {
  return signToken(Object.assign(
    { id: 10, email: 'a@b.c', role: 'admin', name: 'Host A', organization_id: C.IDENTITY.orgId },
    user
  ));
}

async function call(method, path, opts) {
  opts = opts || {};
  const headers = { 'content-type': 'application/json' };
  if (opts.user !== null) headers.authorization = 'Bearer ' + tokenFor(opts.user || {});
  const res = await fetch(baseUrl + path, {
    method, headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch (e) {}
  return { status: res.status, body: json, raw: raw };
}

async function mint() {
  return call('POST', '/api/live/rooms', { body: { entity_type: 'job', entity_id: C.IDENTITY.jobId } });
}

// ── An SSE reader that keeps every byte ────────────────────────────────────
async function openStream(roomId, key, after) {
  const ctrl = new AbortController();
  const url = baseUrl + '/api/live/' + roomId + '/stream/' + key + '?after=' + (after || 0);
  const res = await fetch(url, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const chunks = [];
  const pump = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(Buffer.from(r.value));
      }
    } catch (e) { /* aborted */ }
  })();
  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    frames: function () {
      return Buffer.concat(chunks).toString('utf8')
        .split('\n\n')
        .map((b) => { const m = /^data: (.*)$/m.exec(b); return m ? m[1] : null; })
        .filter(Boolean)
        .map((s) => { try { return JSON.parse(s); } catch (e) { return null; } })
        .filter(Boolean);
    },
    close: async () => { try { ctrl.abort(); } catch (e) {} await pump; }
  };
}

// A generous floor on purpose. These waits are for a frame that has ALREADY
// been written to a socket, so a longer deadline costs nothing when the code is
// right and only buys headroom when the machine is loaded — a mutation run puts
// twenty jest processes through here back to back, and a flaky sweep is a sweep
// nobody trusts.
const WAIT_FLOOR_MS = 8000;
function waitFor(pred, ms) {
  const deadline = Date.now() + Math.max(ms || 0, WAIT_FLOOR_MS);
  return new Promise((resolve, reject) => {
    (function tick() {
      let ok = false;
      try { ok = pred(); } catch (e) { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    })();
  });
}

// ── The corpus, expanded ───────────────────────────────────────────────────
// The seeds PLUS every money figure computeJobWIP actually produces from them.
// The second half is the important one: only three of the thirty outputs are
// byte-identical to a stored scalar, so a sweep for seeds alone is blind to
// every margin and every profit figure this feature exists to hide.
const NON_MONEY_WIP_KEYS = new Set(['pctComplete', 'qbCostLineCount', 'qbCostsAsOf']);

async function wipInputs() {
  const job = C.jobBlob();
  const changeOrders = await jobMoney.changeOrdersForJob(
    { query: async (s, p) => mockRun(s, p) }, C.IDENTITY.jobId, job.changeOrders);
  const invoices = await jobMoney.invoicesForJob(
    { query: async (s, p) => mockRun(s, p) }, C.IDENTITY.jobId, job.invoices);
  const wi = (await jobWip.loadWipInputs({ query: async (s, p) => mockRun(s, p) }, [C.IDENTITY.jobId])).get(C.IDENTITY.jobId) || {};
  return {
    job,
    deps: {
      phases: job.phases, buildings: job.buildings, subs: job.subs,
      changeOrders, invoices,
      qbCostLines: wi.qbCostLines || [], vendorBills: wi.vendorBills || [],
      purchaseOrders: wi.purchaseOrders || []
    }
  };
}

async function expectedWipFigures() {
  const { job, deps } = await wipInputs();
  return jobWip.computeJobWIP(job, deps);
}

// The per-cost-code rollup, whose figures are SUB-SUMS: a bucket's budget is a
// slice of the phase matrix and a bucket's actual is a slice of the QB import.
// Not one of them is byte-identical to a seed, and not one is a computeJobWIP
// output either — so the two existing corpora are BOTH blind to them, and a new
// surface built on them would have been swept against a corpus that could not
// see its numbers. Widening the NEGATIVE corpus is what a new money dimension
// needs; MUST_SURVIVE is a different guarantee and does not substitute.
async function expectedBucketFigures() {
  const { job, deps } = await wipInputs();
  const wip = jobWip.computeJobWIP(job, deps);
  const roll = jobCostBuckets.jobCostBuckets(job, Object.assign({ wip }, deps));
  const out = [];
  for (const r of roll.rows.concat([roll.total])) {
    out.push(r.budget, r.committed, r.actual, r.variance);
  }
  return { roll, figures: out.filter((n) => typeof n === 'number' && isFinite(n) && n !== 0) };
}

// Every way a number can appear in a byte stream. The 4-digit floor keeps a
// coincidence from being reported as a leak: a two-digit fragment matches
// everything.
function renderings(n) {
  const out = new Set();
  if (typeof n !== 'number' || !isFinite(n)) return out;
  const abs = Math.abs(n);
  const push = (s) => {
    if (typeof s !== 'string') return;
    if (s.replace(/[^0-9]/g, '').length < 4) return;
    out.add(s);
  };
  push(String(n));
  push(String(abs));
  [0, 1, 2].forEach((d) => { push(n.toFixed(d)); push(abs.toFixed(d)); });
  const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  push(group(abs.toFixed(0)));
  push(group(abs.toFixed(2)));
  push(group(String(Math.trunc(abs))));
  return out;
}

function allNeedles() {
  const needles = new Map();   // needle string -> field name
  const add = (name, n) => { for (const s of renderings(n)) if (!needles.has(s)) needles.set(s, name); };
  for (const k of Object.keys(C.MONEY)) add(k, C.MONEY[k]);
  C.PROSE_NUMBERS.forEach((n, i) => add('prose#' + i, n));
  return needles;
}

function hitsIn(buffer, needles) {
  const hits = [];
  const b64 = Buffer.from(buffer, 'utf8').toString('base64');
  for (const [needle, field] of needles) {
    if (buffer.indexOf(needle) !== -1) hits.push(field + ' as "' + needle + '"');
    else if (b64.indexOf(Buffer.from(needle, 'utf8').toString('base64').replace(/=+$/, '')) !== -1 && needle.length >= 6) {
      // Only meaningful for a needle long enough that its base64 is not a
      // common substring. Reported separately so a false alarm is legible.
      hits.push(field + ' as base64("' + needle + '")');
    }
  }
  return hits;
}

// ── The sweep driver ───────────────────────────────────────────────────────
// One guest, end to end, and every byte they were sent kept. `hideFinancials`
// selects the whole point of test 4: the identical run with the policy off must
// FIND the canaries, or the harness is not capturing anything.
async function sweepGuest(opts) {
  opts = opts || {};
  const m = await mint();
  const roomId = m.body.room.id;
  const token = m.body.token;

  if (opts.hideFinancials === false) {
    const pol = await call('POST', '/api/live/rooms/' + roomId + '/policy', { body: { hide_financials: false } });
    expect(pol.status).toBe(200);
  }

  const hostJoin = await call('POST', '/api/live/' + token + '/join', { body: {} });
  const guestJoin = await call('POST', '/api/live/' + token + '/join', { user: null, body: { display_name: 'Dave' } });

  const bytes = [];
  bytes.push(guestJoin.raw);

  const stream = await openStream(roomId, guestJoin.body.stream_key, 0);
  await waitFor(() => stream.text().indexOf('"hello"') !== -1, 3000);

  // Every surface in the frozen registry. The registry lock (test 6) asserts
  // this list IS the registry, so a new surface cannot be added without being
  // swept.
  const driven = [];
  for (const s of LV.SURFACE_KEYS) {
    const r = await call('GET', '/api/live/' + roomId + '/view/' + guestJoin.body.stream_key + '/' + s, { user: null });
    bytes.push(r.raw);
    driven.push({ surface: s, status: r.status, body: r.body });
  }

  // Every `view` the host can emit: an allow-listed surface, a surface this
  // room does not serve, a DIFFERENT record in the same org, and off the job
  // entirely.
  // A REAL POINTER SAMPLE rides every beat, because that is what the host's
  // client actually sends — 10 Hz sampled, up to 12 triples per beat. It is
  // here so "a guest is sent no cursor frame" is asserted against traffic that
  // exists rather than against a quiet room.
  const hostBeat = (view) => call('POST', '/api/live/' + roomId + '/beat/' + hostJoin.body.stream_key,
    { user: null, body: { cursor: [[1, 4242, 8181], [2, 4243, 8182]], view: view } });
  await hostBeat({ entity_type: 'job', entity_id: C.IDENTITY.jobId, surface: 'job-wip-report' });
  await hostBeat({ entity_type: 'job', entity_id: C.IDENTITY.jobId, surface: 'job-qb-costs' });
  await hostBeat({ entity_type: 'job', entity_id: 'job_other_9911', surface: 'job-overview' });
  await hostBeat({ entity_type: null, entity_id: null, surface: null });
  await hostBeat({ entity_type: 'job', entity_id: C.IDENTITY.jobId, surface: 'job-changeorders' });

  // The guest's own beacon, and its response body.
  const gb = await call('POST', '/api/live/' + roomId + '/beat/' + guestJoin.body.stream_key, { user: null, body: { cursor: [] } });
  bytes.push(gb.raw);

  await waitFor(() => stream.frames().some((f) => f.type === 'view'), 3000);

  // The BACKLOG replay path: a second stream opened with ?after=0 replays every
  // control event from the ring, which is a wire the first stream never was.
  const replay = await openStream(roomId, guestJoin.body.stream_key, 0);
  await waitFor(() => replay.text().indexOf('"hello"') !== -1, 3000);

  const status = await call('GET', '/api/live/' + token + '/status', { user: null });
  bytes.push(status.raw);

  const frames = stream.frames().concat(replay.frames());
  bytes.push(stream.text());
  bytes.push(replay.text());

  await stream.close();
  await replay.close();

  return { roomId, token, hostJoin, guestJoin, driven, frames, buffer: bytes.join('\n') };
}

// ══ 1. The corpus is sound ═════════════════════════════════════════════════

describe('the corpus is sound before it is trusted', () => {
  test('no canary rendering collides with a constant the guest legitimately receives', async () => {
    const needles = allNeedles();
    const wip = await expectedWipFigures();
    for (const k of Object.keys(wip)) {
      if (NON_MONEY_WIP_KEYS.has(k)) continue;
      for (const s of renderings(wip[k])) if (!needles.has(s)) needles.set('wip.' + k, s) && 0;
    }
    // Everything numeric a guest is ALLOWED to see, spelled out. If a canary
    // rendering matched one of these, every later failure would be noise.
    const legitimate = ['5000', '20000', '90000', '51.3', '51.30', '10000', '1000'];
    for (const lit of legitimate) {
      expect(Array.from(needles.keys())).not.toContain(lit);
    }
  });

  test('the per-cost-code figures are a THIRD corpus — seeds and WIP outputs are both blind to them', async () => {
    // A bucket budget is a slice of the phase matrix; a bucket actual is a
    // slice of the QB import. Neither is a stored scalar and neither is a
    // computeJobWIP output, so adding the cost surface without widening the
    // corpus would have swept it for numbers that cannot be on its wire —
    // exactly the failure the WIP half of this corpus was written to fix.
    const { figures, roll } = await expectedBucketFigures();
    expect(figures.length).toBeGreaterThanOrEqual(8);

    const seeds = new Set(Object.values(C.MONEY));
    const wip = await expectedWipFigures();
    const wipVals = new Set(Object.keys(wip).filter((k) => !NON_MONEY_WIP_KEYS.has(k)).map((k) => wip[k]));
    const uncovered = figures.filter((n) => !seeds.has(n) && !wipVals.has(n));
    // Not "most of them are new" — a NAMED count, so the argument for widening
    // the corpus is arithmetic rather than assertion. Every one of these is a
    // figure the old sweep would have searched for and never found, because it
    // was searching a corpus that could not contain it.
    expect(uncovered.length).toBeGreaterThanOrEqual(10);

    // And the decomposition RECONCILES: the cost tab and the WIP tab cannot
    // disagree about the same job, which is the whole B6 failure class.
    const summed = roll.rows.reduce((s, r) => s + r.actual, 0);
    expect(Math.abs(summed - wip.actualCosts)).toBeLessThan(0.01);
    expect(Math.abs(roll.total.actual - wip.actualCosts)).toBeLessThan(0.01);
  });

  test('a sub-$1,000 figure is VISIBLE to the sweep — the 4-digit floor is a real blind spot', () => {
    // renderings() drops any needle with fewer than four digit characters, so
    // "847" would be invisible. Per-cost-code money is where small figures
    // live, so the fixture seeds them with cents and this asserts that choice
    // actually buys coverage rather than being a comment about one.
    expect(Array.from(renderings(847.23))).toContain('847.23');
    // The blind spot itself, stated: the BARE integer form of a sub-$1,000
    // figure is discarded, so a whole-dollar small budget is only findable
    // through its "847.00" rendering — which a JSON wire does not produce.
    expect(Array.from(renderings(847))).not.toContain('847');
    expect(Array.from(renderings(847.23))).not.toContain('847');
  });

  test('the money outputs are DERIVED, not copied — which is why seeds alone are blind', async () => {
    const wip = await expectedWipFigures();
    const seeds = new Set(Object.values(C.MONEY));
    const moneyKeys = Object.keys(wip).filter((k) => !NON_MONEY_WIP_KEYS.has(k));
    const copied = moneyKeys.filter((k) => seeds.has(wip[k]));
    // Most outputs are sums, differences and ratios of the seeds, so a sweep
    // for seeds ALONE cannot see them. That is the arithmetic behind expanding
    // the corpus, and it is asserted rather than asserted-about so the reasoning
    // cannot go stale if computeJobWIP changes shape.
    expect(copied.length).toBeLessThan(moneyKeys.length / 2);
    expect(moneyKeys.length).toBeGreaterThanOrEqual(25);
    // The headline figures — the ones the toggle names by name — are ALL
    // derived. Not one of them is findable by searching for a stored value.
    for (const k of ['displayMargin', 'displayProfit', 'jtdMargin', 'jtdProfit',
      'asSoldMargin', 'revisedMargin', 'totalIncome', 'projectedProfit']) {
      expect(copied).not.toContain(k);
    }
  });
});

// ══ 2. THE SWEEP ═══════════════════════════════════════════════════════════

describe('a guest never receives a hidden number in any response byte', () => {
  jest.setTimeout(30000);

  test('no seeded money value reaches the wire, in any rendering', async () => {
    const run = await sweepGuest();
    const hits = hitsIn(run.buffer, allNeedles());
    expect(hits).toEqual([]);
  });

  test('no COMPUTED money figure reaches the wire either — margins included', async () => {
    const run = await sweepGuest();
    const wip = await expectedWipFigures();
    const needles = new Map();
    for (const k of Object.keys(wip)) {
      if (NON_MONEY_WIP_KEYS.has(k)) continue;
      for (const s of renderings(wip[k])) if (!needles.has(s)) needles.set(s, 'wip.' + k);
    }
    // The named ones, so a regression report says which figure escaped.
    expect(Object.keys(wip)).toEqual(expect.arrayContaining(
      ['displayMargin', 'jtdMargin', 'asSoldMargin', 'revisedMargin', 'displayProfit', 'projectedProfit']));
    const hits = hitsIn(run.buffer, needles);
    expect(hits).toEqual([]);
  });

  test('no PER-COST-CODE figure reaches the wire — the surface the study asked for', async () => {
    const run = await sweepGuest();
    const { figures } = await expectedBucketFigures();
    const needles = new Map();
    figures.forEach((n, i) => { for (const s of renderings(n)) if (!needles.has(s)) needles.set(s, 'bucket#' + i); });
    expect(needles.size).toBeGreaterThan(0);
    const hits = hitsIn(run.buffer, needles);
    expect(hits).toEqual([]);
    // And the surface really is on the wire, so this is not vacuous.
    const cost = run.driven.find((d) => d.surface === 'job-cost-summary');
    expect(cost.status).toBe(200);
    expect(cost.body.view.rows.length).toBeGreaterThanOrEqual(6);
  });

  test('the host pointer is not on a guest wire at all', async () => {
    // Every beat in the sweep carries real cursor samples. The guest used to
    // receive all of them — highest-frequency channel on the wire — and had no
    // way to draw one, because the host measures against a document the guest
    // is not looking at.
    const run = await sweepGuest();
    expect(run.frames.some((f) => f.type === 'cursor')).toBe(false);
    expect(run.buffer).not.toContain('"cursor"');
    expect(run.buffer).not.toContain('4242');
    // A null projection means DO NOT SEND, never "send null".
    expect(run.buffer).not.toContain('data: null');
  });

  test('prose carrying a figure is scrubbed, not shipped', async () => {
    const run = await sweepGuest();
    const co = run.driven.find((d) => d.surface === 'job-changeorders');
    expect(co.status).toBe(200);
    // The description IS there — the surface is still useful — but the number
    // inside it is not.
    const rendered = JSON.stringify(co.body.view.rows);
    expect(rendered).toMatch(/Add 3 doors/);
    expect(rendered).not.toMatch(/412900/);
    expect(rendered).not.toMatch(/58,433/);
    // The forward-facing title comes from entity-labels, which is author text
    // too, and gets the same treatment.
    expect(JSON.stringify(co.body.view.title)).not.toMatch(/776522/);
  });

  test('the entity id, the org id and the room token never reach a guest', async () => {
    const run = await sweepGuest();
    // Phase 01 promised this and phase 02's surfaces are built from rows whose
    // canonical shapes carry it — change-order-routes.js shapeRow returns
    // job_id right beside the blob.
    expect(run.buffer).not.toContain(C.IDENTITY.jobId);
    expect(run.buffer).not.toContain('job_other_9911');
    expect(run.buffer).not.toContain(C.IDENTITY.coId);
    expect(run.buffer).not.toContain(C.IDENTITY.clientId);
    expect(run.buffer).not.toContain(C.IDENTITY.nodeId);
    expect(run.buffer).not.toContain(run.token);
    expect(run.buffer).not.toContain(run.hostJoin.body.stream_key);
  });

  test('the mirror carries a SURFACE, never a record — even when the host moves', async () => {
    const run = await sweepGuest();
    const views = run.frames.filter((f) => f.type === 'view');
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      expect(Object.keys(v).sort()).toEqual(expect.not.arrayContaining(['entity_id', 'entity_type']));
      expect(v).not.toHaveProperty('entity_id');
    }
    // The host visited a job this room was not minted for. The guest is told
    // the mirror stopped, and is NOT told which record.
    expect(views.some((v) => v.reason === 'off_room')).toBe(true);
    expect(views.some((v) => v.reason === 'not_shared')).toBe(true);
    expect(views.some((v) => v.reason === 'away')).toBe(true);
    expect(views.some((v) => v.surface === 'job-wip-report')).toBe(true);
  });

  test('a guest never learns what the OTHER guests are looking at', async () => {
    const run = await sweepGuest();
    const rosters = run.frames.filter((f) => f.type === 'presence' || f.type === 'hello');
    expect(rosters.length).toBeGreaterThan(0);
    for (const r of rosters) {
      for (const p of (r.participants || [])) {
        expect(p).not.toHaveProperty('surface');
        expect(p).not.toHaveProperty('following');
      }
    }
  });
});

// ══ 2b. THE OTHER DIRECTION ════════════════════════════════════════════════
//
// Everything above proves a value is ABSENT. Nothing proved a permitted field
// arrives INTACT, and that is not a theoretical gap: the address in the fixture
// shipped as "— Marina Way, Tampa FL" from the day the file was written, in a
// suite that stayed green through every run. The redactor was eating a street
// number and a ZIP because nothing had ever CLASSIFIED an address, and a
// one-directional proof cannot see that.
//
// So this block is the mirror image, with the same coverage discipline the
// registry lock already applies: the field list is a file, and every entry in
// it is asserted.

describe('a field a guest is ALLOWED to read arrives whole', () => {
  jest.setTimeout(30000);

  test('every MUST_SURVIVE string reaches the guest unmangled, with money hidden', async () => {
    const run = await sweepGuest();
    const missing = [];
    for (const k of Object.keys(C.MUST_SURVIVE)) {
      if (run.buffer.indexOf(C.MUST_SURVIVE[k]) === -1) missing.push(k + ' = ' + JSON.stringify(C.MUST_SURVIVE[k]));
    }
    expect(missing).toEqual([]);
  });

  test('the address is on the card, in one piece, on the surface John opened', async () => {
    const run = await sweepGuest();
    const ov = run.driven.find((d) => d.surface === 'job-overview');
    expect(ov.status).toBe(200);
    expect(ov.body.view.address).toBe(C.MUST_SURVIVE['job.propertyAddr']);
    // The sentinel is a MONEY glyph. It has no business in an address.
    expect(ov.body.view.address).not.toContain('—');
    expect(ov.body.view.address).not.toContain('[…]');
    expect(ov.body.view.status).toBe('In progress');
  });

  test('a CO number is an identifier, not a figure', async () => {
    const run = await sweepGuest();
    const co = run.driven.find((d) => d.surface === 'job-changeorders');
    expect(co.body.view.rows.map((r) => r.number)).toEqual(['CO-001', 'CO-002']);
    // And the approval date is now REAL. It read a column the shaper's SELECT
    // never asked for, so it was null on every CO, always.
    expect(co.body.view.rows[0].approved).toBe('2026-04-09');
  });

  test('the CO shaper asks the database for the column it claims to return', () => {
    // The mock DB hands back whole rows regardless of the SELECT list, so this
    // one is asserted on the SOURCE — a column the shaper reads and the query
    // never requests is invisible to any fixture-backed test, which is exactly
    // how `approved` stayed null on every CO in production while the suite
    // stayed green.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'money', 'change-order-totals.js'), 'utf8');
    expect((src.match(/SELECT id, job_id, status, co_number, linked_node_id, approved_at, data/g) || []).length).toBe(2);
    expect(jobMoney.shapeChangeOrderRow({
      id: 'x', status: 'approved', co_number: 'CO-001',
      approved_at: '2026-04-09T00:00:00.000Z', data: {}
    }).approved).toBe('2026-04-09T00:00:00.000Z');
  });

  test('a LEGACY change order gets the same shape — and exactly the same money', () => {
    // A job with no rows in job_change_orders returned the raw blob array,
    // unshaped: no `counted`, no `proposedIncome`, no `coNumber`. The guest
    // surface printed a row of dashes while the WIP tab, at the same moment,
    // counted those same COs into coIncome. Two tabs, one job, contradicting.
    const legacyBlob = [{ status: 'draft', coNumber: 'CO-7', income: 4210, estimatedCosts: 1900, title: 'Old CO' }];
    const shaped = jobMoney.shapeLegacyChangeOrder(legacyBlob[0]);
    expect(shaped.coNumber).toBe('CO-7');
    expect(shaped.proposedIncome).toBe(4210);
    // The record's cost is VISIBLE...
    expect(shaped.proposedCosts).toBe(1900);
    // ...and still NOT COUNTED, because coTotals reads `costs` and a legacy
    // blob spells it `estimatedCosts`. That gap predates this pass; naming it
    // is the fix that belongs in a rendering commit, closing it is not.
    expect(shaped.costs).toBe(0);
    // AND THE MONEY IS UNCHANGED. computeJobWIP has always summed the legacy
    // blob's raw `income` regardless of status; re-deciding which legacy COs
    // count is a change to org-wide job cost and has no business riding along
    // inside a rendering fix.
    expect(jobWip.coTotals([shaped])).toEqual(jobWip.coTotals(legacyBlob));
  });

  test('a percentage with no denominator is NULL, never 0% — the same lie one column over', async () => {
    // Number(null) is 0 and it is finite, so the obvious num() turns "this
    // bucket was never budgeted" into a confident "0% used". Found by looking
    // at the rendered page rather than by reading the code.
    const doc = LV.buildView('job-cost-summary', {
      costBuckets: { rows: [{ label: 'Other', budget: 0, committed: 0, actual: 0, variance: 0, pctUsed: null }], total: null }
    }, { money: false });
    expect(doc.rows[0].pctUsed).toBeNull();
    // A REAL zero still prints as zero: the two are different facts.
    const zero = LV.buildView('job-cost-summary', {
      costBuckets: { rows: [{ label: 'Labor', budget: 10, committed: 0, actual: 0, variance: 10, pctUsed: 0 }], total: null }
    }, { money: false });
    expect(zero.rows[0].pctUsed).toBe(0);
    // And the rollup itself produces the null rather than a zero.
    const { roll } = await expectedBucketFigures();
    expect(roll.rows.find((r) => r.code === 'other').pctUsed).toBeNull();
  });

  test('the two sentinels mean two different things', () => {
    // A money cell renders "—" and the client styles it. Text removed from
    // inside a sentence reads as removed TEXT. Printing both as "—" on one card
    // is most of why the shipped surface read as broken rather than careful.
    expect(LV.scrubProse('Add 3 doors — $4,200')).toContain('[…]');
    expect(LV.scrubProse('Add 3 doors — $4,200')).toContain('Add 3 doors');
    expect(LV.buildView('job-wip-report', { wip: {} }, { money: false })
      .sections[0].rows[0].cell).toEqual({ r: true });
  });

  test('the structured tier still catches EXPLICIT money, and the prose tier still catches the guess', () => {
    // The split is an axis, not a weakening. A PM who types a dollar figure
    // into any field means dollars.
    expect(LV.scrubIdent('$120,000 job')).not.toContain('120');
    expect(LV.scrubIdent('budget of 4,200 total')).not.toContain('4,200');
    // Prose keeps the guess, and it is now WIDER than it was: a digit glued to
    // a unit letter, and a percentage, both used to survive it intact.
    expect(LV.scrubProse('9500sf of deck')).not.toContain('9500');
    expect(LV.scrubProse('1.2M contract')).not.toContain('1.2');
    expect(LV.scrubProse('Repriced at 18% markup')).not.toContain('18%');
    // And what the design protects on purpose still survives.
    expect(LV.scrubProse('Add 3 doors')).toBe('Add 3 doors');
    expect(LV.scrubProse('Phase 2')).toBe('Phase 2');
  });

  test('a bare figure in a job TITLE is still caught — the tier split did not move it', async () => {
    // The realistic leak, and it rides the hello frame: the FIRST bytes every
    // guest receives. Moving titles onto the structured tier to win back the
    // legibility of "MDW-2008" would have re-emitted this canary.
    const run = await sweepGuest();
    expect(run.buffer).not.toContain('776522');
    const hello = run.frames.find((f) => f.type === 'hello');
    expect(hello.room.title).toContain('RV2006 Waterside');
    expect(hello.room.title).not.toContain('776522');
  });
});

// ══ 3. The derivation closure ══════════════════════════════════════════════

describe('a derived figure whose inputs are hidden is itself hidden', () => {
  jest.setTimeout(30000);

  test('nothing that DID ship reconstructs a canary by arithmetic', async () => {
    const run = await sweepGuest();
    // Every number the guest actually received, from the parsed documents and
    // frames rather than from a source read.
    const shipped = [];
    (function walk(v) {
      if (v == null) return;
      if (typeof v === 'number' && isFinite(v)) { shipped.push(v); return; }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (typeof v === 'object') { Object.keys(v).forEach((k) => walk(v[k])); }
    })({ frames: run.frames, docs: run.driven.map((d) => d.body) });

    const wip = await expectedWipFigures();
    const targets = Object.keys(wip)
      .filter((k) => !NON_MONEY_WIP_KEYS.has(k))
      .map((k) => wip[k])
      .concat(Object.values(C.MONEY))
      .filter((n) => typeof n === 'number' && isFinite(n) && Math.abs(n) >= 1000);

    const near = (a, b) => Math.abs(a - b) < 0.01;
    const found = [];
    for (let i = 0; i < shipped.length; i++) {
      for (let j = 0; j < shipped.length; j++) {
        const a = shipped[i], b = shipped[j];
        const cands = [a + b, a - b, a * b];
        if (b !== 0) cands.push(a / b, (a / b) * 100, a / (b / 100));
        for (const c of cands) {
          if (!isFinite(c)) continue;
          for (const t of targets) if (near(c, t)) found.push(a + ' op ' + b + ' -> ' + t);
        }
      }
    }
    expect(found).toEqual([]);
  });

  test('% complete survives ONLY because both terms it multiplies are redacted', async () => {
    const run = await sweepGuest();
    const overview = run.driven.find((d) => d.surface === 'job-overview');
    expect(overview.body.view.progress.pct).toBe(51.3);
    // revenueEarned = totalIncome x pct/100. Both of those are cells.
    const wipDoc = run.driven.find((d) => d.surface === 'job-wip-report').body.view;
    const cells = [];
    (function collect(v) {
      if (v && typeof v === 'object') {
        if (Object.prototype.hasOwnProperty.call(v, 'r') || Object.prototype.hasOwnProperty.call(v, 'm')) { cells.push(v); return; }
        Object.keys(v).forEach((k) => collect(v[k]));
      }
    })(wipDoc);
    expect(cells.length).toBeGreaterThanOrEqual(20);
    expect(cells.every((c) => c.r === true)).toBe(true);
  });

  test('building HOURS are on no surface — a count times a PUBLIC constant is money', async () => {
    const run = await sweepGuest();
    // hoursTotal is a count. It passes every money-TYPE test and every ratio
    // rule. But js/jobs.js defaults the labor rate to 40 and express.static
    // serves js/jobs.js to anonymous callers, so hoursTotal * 40 is a labor
    // budget a guest can compute offline. The rule is therefore about products
    // against public constants, not only ratios of redacted terms.
    expect(run.buffer).not.toContain('1284');
    expect(run.buffer).not.toContain('hoursTotal');
    expect(run.buffer).not.toContain('hoursWeek');
  });
});

// ══ 4. THE POSITIVE CONTROL ════════════════════════════════════════════════

describe('THE POSITIVE CONTROL — the sweep can fail', () => {
  jest.setTimeout(30000);

  test('with hide_financials OFF the identical sweep FINDS the canaries', async () => {
    const run = await sweepGuest({ hideFinancials: false });
    const wip = await expectedWipFigures();
    const needles = new Map();
    for (const k of ['contractIncome', 'displayMargin', 'jtdProfit', 'revenueEarned']) {
      for (const s of renderings(wip[k])) if (!needles.has(s)) needles.set(s, 'wip.' + k);
    }
    const hits = hitsIn(run.buffer, needles);
    // If this ever comes back empty, the harness is capturing nothing and every
    // other test in this file is vacuously green.
    expect(hits.length).toBeGreaterThan(0);
    expect(run.driven.every((d) => d.body && d.body.money_visible === true)).toBe(true);
  });

  test('with hide_financials OFF the PER-COST-CODE figures are found too', async () => {
    // The positive control, extended to the new dimension. Without it the
    // widened corpus could be searching for numbers that never reach any wire
    // under any policy, and the cost surface would be swept by a test that
    // cannot fail.
    const run = await sweepGuest({ hideFinancials: false });
    const { figures } = await expectedBucketFigures();
    const needles = new Map();
    figures.forEach((n, i) => { for (const s of renderings(n)) if (!needles.has(s)) needles.set(s, 'bucket#' + i); });
    expect(hitsIn(run.buffer, needles).length).toBeGreaterThan(0);
  });

  test('with the policy ON the same guest is told money_visible:false', async () => {
    const run = await sweepGuest();
    expect(run.driven.every((d) => d.body && d.body.money_visible === false)).toBe(true);
  });
});

// ══ 5. The shape assertion ═════════════════════════════════════════════════

describe('an unclassified money-shaped field is hidden by default', () => {
  jest.setTimeout(30000);

  test('every money cell is EXACTLY { r: true } — no debug field rode along', async () => {
    const run = await sweepGuest();
    for (const d of run.driven) {
      expect(d.status).toBe(200);
      (function check(v, path) {
        if (v == null || typeof v !== 'object') return;
        if (Array.isArray(v)) { v.forEach((x, i) => check(x, path + '[' + i + ']')); return; }
        if (Object.prototype.hasOwnProperty.call(v, 'r')) {
          expect(Object.keys(v)).toEqual(['r']);
          expect(v.r).toBe(true);
          return;
        }
        // `m` is RESERVED for a visible money cell across every view document.
        // With the policy on, it must not appear anywhere at all.
        expect(Object.prototype.hasOwnProperty.call(v, 'm')).toBe(false);
        Object.keys(v).forEach((k) => check(v[k], path + '.' + k));
      })(d.body.view, d.surface);
    }
  });

  test('a field nobody classified is ABSENT, because nothing spreads a row', () => {
    // The allow-list argument, made mechanically. A brand-new money field
    // arriving on jobs.data — four independent write paths write that blob —
    // does not appear on a guest surface until someone adds it to a builder.
    const doc = LV.buildView('job-overview', {
      title: 'x',
      job: { status: 'ok', secretNewMarginField: 918273.45, contractAmount: 5 },
      wip: { pctComplete: 12, totalIncome: 5 }
    }, { money: false });
    const s = JSON.stringify(doc);
    expect(s).not.toContain('918273');
    expect(s).not.toContain('secretNewMarginField');
  });

  test('a null money field prints as absent, never as $0.00', () => {
    // js/app.js formatCurrency is format(val || 0), so DELETING a money field
    // yields "$0.00": a job sold at zero, rendered confidently. A cell cannot
    // do that — { r: true } is not a number and the guest renderer has no
    // numeric fallback.
    const doc = LV.buildView('job-wip-report', { title: 'x', wip: {} }, { money: true });
    const first = doc.sections[0].rows[0].cell;
    expect(first).toEqual({ m: null });
    expect(first.m).not.toBe(0);
  });

  test('viewPolicy fails closed on every input that is not literally permitted', () => {
    const guest = { role: 'viewer' };
    expect(LV.viewPolicy({ hide_financials: true }, guest).money).toBe(false);
    expect(LV.viewPolicy({ hide_financials: null }, guest).money).toBe(false);
    expect(LV.viewPolicy({ hide_financials: undefined }, guest).money).toBe(false);
    expect(LV.viewPolicy({ hide_financials: 'f' }, guest).money).toBe(false);
    expect(LV.viewPolicy({ hide_financials: 0 }, guest).money).toBe(false);
    expect(LV.viewPolicy({}, guest).money).toBe(false);
    expect(LV.viewPolicy(null, guest).money).toBe(false);
    expect(LV.viewPolicy({ hide_financials: false }, null).money).toBe(false);
    // The only two permitting cases.
    expect(LV.viewPolicy({ hide_financials: false }, guest).money).toBe(true);
    expect(LV.viewPolicy({ hide_financials: true }, { role: 'host' }).money).toBe(true);
  });
});

// ══ 6. THE REGISTRY LOCK ═══════════════════════════════════════════════════

describe('the registry lock', () => {
  jest.setTimeout(30000);

  test('every surface in the frozen allow-list is driven by the sweep', async () => {
    const run = await sweepGuest();
    expect(run.driven.map((d) => d.surface).sort()).toEqual(LV.SURFACE_KEYS.slice().sort());
    expect(run.driven.every((d) => d.status === 200)).toBe(true);
    // Frozen: a surface cannot be added at runtime by anything that got a
    // reference to the map.
    expect(Object.isFrozen(LV.SURFACES)).toBe(true);
  });

  test('a surface outside the allow-list is refused, uniformly and BEFORE any read', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const key = g.body.stream_key;
    for (const bad of ['job-qb-costs', 'job-payapps', 'job-invoices', 'job-purchaseorders', 'job-photos', '../../jobs', 'lead-overview']) {
      queries = [];
      const r = await call('GET', '/api/live/' + m.body.room.id + '/view/' + key + '/' + encodeURIComponent(bad), { user: null });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('NOT_SHARED');
      // The refusal happens on the registry, not on a null document at the end
      // of a build. An unknown surface must not cost a read of the entity at
      // all: without the registry check the loader runs first and only the
      // builder's null answers, which reads the job, its COs, its invoices and
      // its QB lines to produce a 400.
      expect(queries.some((q) => /FROM jobs|job_change_orders|qb_cost_lines/i.test(q.sql))).toBe(false);
    }
  });

  test('a surface is bound to an ENTITY TYPE, not merely to a name', () => {
    // Phase 01 made lead/estimate rooms a map entry. When one is added, a job
    // surface must not be reachable from a lead room just because the string
    // matched — so the binding is asserted now, while there is only one entity.
    for (const k of LV.SURFACE_KEYS) expect(LV.SURFACES[k].entity).toBe('job');
    expect(LV.surfacesFor('lead')).toEqual([]);
    expect(LV.surfacesFor('job').map((s) => s.key)).toEqual(LV.SURFACE_KEYS.slice());
    expect(LV.surfaceSpec('__proto__')).toBe(null);
    expect(LV.surfaceSpec('constructor')).toBe(null);
    expect(LV.surfaceSpec(null)).toBe(null);
  });
});

// ══ The guest boundary ═════════════════════════════════════════════════════

describe('a guest is not a user', () => {
  jest.setTimeout(30000);

  test('there is NO parameter a guest could use to name another record', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const key = g.body.stream_key;
    const ok = await call('GET', '/api/live/' + m.body.room.id + '/view/' + key + '/job-overview', { user: null });
    expect(ok.status).toBe(200);
    // The proxy reads the entity from ctx.room. A query string is the only
    // place a caller could try to smuggle one, and it is not read.
    const smuggled = await call('GET', '/api/live/' + m.body.room.id + '/view/' + key + '/job-overview?entity_id=job_other_9911&job_id=job_other_9911', { user: null });
    expect(smuggled.status).toBe(200);
    // Byte-identical documents (the `at` stamp aside): the query string was not
    // read, because there is nothing that reads it.
    expect(JSON.stringify(smuggled.body.view)).toBe(JSON.stringify(ok.body.view));
    expect(JSON.stringify(smuggled.body)).not.toContain('Not this one');
    expect(JSON.stringify(smuggled.body)).not.toContain('999111');
  });

  test('a guest cannot mutate: no write door answers a stream key', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const roomId = m.body.room.id;
    // The host-only doors all sit behind requireAuth, so a guest gets 401 and
    // not a partial effect.
    for (const path of ['/end', '/kick', '/policy', '/beat']) {
      const r = await call('POST', '/api/live/rooms/' + roomId + path, { user: null, body: { hide_financials: false, participant_id: 'x' } });
      expect(r.status).toBe(401);
    }
    expect(db.rooms[0].hide_financials).toBe(true);
    // The view proxy is GET-only.
    const post = await call('POST', '/api/live/' + roomId + '/view/' + g.body.stream_key + '/job-overview', { user: null, body: {} });
    expect(post.status).toBe(404);
  });

  test("a viewer's `view` in a beat body cannot steer the room", async () => {
    const m = await mint();
    const roomId = m.body.room.id;
    const host = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const stream = await openStream(roomId, g.body.stream_key, 0);
    await waitFor(() => stream.text().indexOf('"hello"') !== -1, 3000);

    await call('POST', '/api/live/' + roomId + '/beat/' + host.body.stream_key, { user: null, body: { view: { entity_type: 'job', entity_id: C.IDENTITY.jobId, surface: 'job-wip-report' } } });
    await waitFor(() => stream.frames().some((f) => f.type === 'view'), 3000);

    await call('POST', '/api/live/' + roomId + '/beat/' + g.body.stream_key, { user: null, body: { view: { entity_type: 'job', entity_id: 'job_other_9911', surface: 'job-overview' } } });
    await new Promise((r) => setTimeout(r, 120));

    const views = stream.frames().filter((f) => f.type === 'view');
    expect(views.length).toBe(1);
    expect(views[0].surface).toBe('job-wip-report');
    await stream.close();
  });

  test('a kicked guest cannot resume — the view proxy dies with the key', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const key = g.body.stream_key;
    expect((await call('GET', '/api/live/' + m.body.room.id + '/view/' + key + '/job-overview', { user: null })).status).toBe(200);
    const pid = db.participants.find((p) => p.role === 'viewer').id;
    const k = await call('POST', '/api/live/rooms/' + m.body.room.id + '/kick', { body: { participant_id: pid } });
    expect(k.status).toBe(200);
    // The honesty phase 01 wrote at this door, kept verbatim.
    expect(k.body.note).toMatch(/They still hold the link and can rejoin/);
    expect((await call('GET', '/api/live/' + m.body.room.id + '/view/' + key + '/job-overview', { user: null })).status).toBe(404);
  });

  test('an ended room stops answering the view proxy', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const key = g.body.stream_key;
    await call('POST', '/api/live/rooms/' + m.body.room.id + '/end', { body: {} });
    const r = await call('GET', '/api/live/' + m.body.room.id + '/view/' + key + '/job-overview', { user: null });
    // Ending revokes every stream key, so this is a dead credential (404), not
    // a live one against a dead room.
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain('887711');
  });

  test('a room whose parent left its org stops serving that parent', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    db.jobs[0].organization_id = 9999;   // re-tenanted underneath a live room
    const r = await call('GET', '/api/live/' + m.body.room.id + '/view/' + g.body.stream_key + '/job-overview', { user: null });
    expect(r.status).toBe(404);
  });

  test('an UNSTAMPED parent is refused too — the read does not inherit the backfill tolerance', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    db.jobs[0].organization_id = null;
    const r = await call('GET', '/api/live/' + m.body.room.id + '/view/' + g.body.stream_key + '/job-overview', { user: null });
    expect(r.status).toBe(404);
  });
});

// ══ Follow-me ══════════════════════════════════════════════════════════════

describe('follow-me lands the viewer on the host surface', () => {
  jest.setTimeout(30000);

  test('hello carries where the host already is, so a late joiner is not stranded', async () => {
    const m = await mint();
    const roomId = m.body.room.id;
    const host = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    await call('POST', '/api/live/' + roomId + '/beat/' + host.body.stream_key, {
      user: null, body: { view: { entity_type: 'job', entity_id: C.IDENTITY.jobId, surface: 'job-changeorders' } }
    });
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Late' } });
    const stream = await openStream(roomId, g.body.stream_key, 0);
    await waitFor(() => stream.frames().some((f) => f.type === 'hello'), 3000);
    const hello = stream.frames().find((f) => f.type === 'hello');
    expect(hello.view.surface).toBe('job-changeorders');
    expect(hello.policy).toEqual({ money: false });
    expect(hello.surfaces.map((s) => s.key)).toEqual(LV.SURFACE_KEYS.slice());
    // Still no record id, on the very first frame every guest gets.
    expect(JSON.stringify(hello)).not.toContain(C.IDENTITY.jobId);
    await stream.close();
  });

  test('a route change is a SEQUENCED control event, so a reconnect replays it', async () => {
    const m = await mint();
    const roomId = m.body.room.id;
    const host = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const s1 = await openStream(roomId, g.body.stream_key, 0);
    await waitFor(() => s1.frames().some((f) => f.type === 'hello'), 3000);
    const seq0 = s1.frames().find((f) => f.type === 'hello').seq;
    await call('POST', '/api/live/' + roomId + '/beat/' + host.body.stream_key, {
      user: null, body: { view: { entity_type: 'job', entity_id: C.IDENTITY.jobId, surface: 'job-wip-report' } }
    });
    await waitFor(() => s1.frames().some((f) => f.type === 'view'), 3000);
    await s1.close();

    const s2 = await openStream(roomId, g.body.stream_key, seq0);
    await waitFor(() => s2.frames().some((f) => f.type === 'view'), 3000);
    const replayed = s2.frames().find((f) => f.type === 'view');
    expect(replayed.surface).toBe('job-wip-report');
    expect(typeof replayed.seq).toBe('number');
    await s2.close();
  });

  test('the presenter — and only the presenter — sees who broke off', async () => {
    const m = await mint();
    const roomId = m.body.room.id;
    const host = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const hs = await openStream(roomId, host.body.stream_key, 0);
    await waitFor(() => hs.frames().some((f) => f.type === 'hello'), 3000);

    await call('POST', '/api/live/' + roomId + '/beat/' + host.body.stream_key, {
      user: null, body: { view: { entity_type: 'job', entity_id: C.IDENTITY.jobId, surface: 'job-wip-report' } }
    });
    // The guest reads something else. The server learns it from the FETCH they
    // made, not from anything they claimed.
    await call('GET', '/api/live/' + roomId + '/view/' + g.body.stream_key + '/job-changeorders', { user: null });
    await call('POST', '/api/live/' + roomId + '/beat/' + host.body.stream_key, {
      user: null, body: { view: { entity_type: 'job', entity_id: C.IDENTITY.jobId, surface: 'job-overview' } }
    });
    // Wait for the roster that reflects the SECOND navigation, not merely for
    // any roster — the first one was emitted before the guest broke off.
    await waitFor(() => hs.frames().filter((f) => f.type === 'view').length >= 2, 3000);
    await waitFor(() => {
      const rs = hs.frames().filter((f) => f.type === 'presence');
      const l = rs[rs.length - 1];
      return !!(l && l.participants.find((p) => p.name === 'Dave' && p.surface));
    }, 3000);

    const rosters = hs.frames().filter((f) => f.type === 'presence');
    const last = rosters[rosters.length - 1];
    const dave = last.participants.find((p) => p.name === 'Dave');
    expect(dave.surface).toBe('job-changeorders');
    expect(dave.following).toBe(false);
    await hs.close();
  });
});

// ══ The policy toggle ══════════════════════════════════════════════════════

describe('flipping the toggle mid-session changes the WIRE, not a class', () => {
  jest.setTimeout(30000);

  test('the same guest, the same key: numbers appear only after the row changes', async () => {
    const m = await mint();
    const roomId = m.body.room.id;
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const key = g.body.stream_key;

    const before = await call('GET', '/api/live/' + roomId + '/view/' + key + '/job-wip-report', { user: null });
    expect(before.raw).not.toContain('887711');
    expect(before.body.money_visible).toBe(false);

    const flip = await call('POST', '/api/live/rooms/' + roomId + '/policy', { body: { hide_financials: false } });
    expect(flip.status).toBe(200);
    expect(flip.body.note).toMatch(/server stops sending|can now see/);

    const after = await call('GET', '/api/live/' + roomId + '/view/' + key + '/job-wip-report', { user: null });
    expect(after.raw).toContain('887711');
    expect(after.body.money_visible).toBe(true);

    const back = await call('POST', '/api/live/rooms/' + roomId + '/policy', { body: { hide_financials: true } });
    expect(back.status).toBe(200);
    const again = await call('GET', '/api/live/' + roomId + '/view/' + key + '/job-wip-report', { user: null });
    expect(again.raw).not.toContain('887711');
  });

  test('open streams are told, so a guest discards rather than keeps painting', async () => {
    const m = await mint();
    const roomId = m.body.room.id;
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const stream = await openStream(roomId, g.body.stream_key, 0);
    await waitFor(() => stream.frames().some((f) => f.type === 'hello'), 3000);
    await call('POST', '/api/live/rooms/' + roomId + '/policy', { body: { hide_financials: false } });
    await waitFor(() => stream.frames().some((f) => f.type === 'policy'), 3000);
    expect(stream.frames().find((f) => f.type === 'policy').hide_financials).toBe(false);
    await stream.close();
  });

  test('the toggle refuses anything that is not literally a boolean', async () => {
    const m = await mint();
    for (const bad of ['false', 0, null, undefined, 'yes']) {
      const r = await call('POST', '/api/live/rooms/' + m.body.room.id + '/policy', { body: { hide_financials: bad } });
      expect(r.status).toBe(400);
    }
    expect(db.rooms[0].hide_financials).toBe(true);
  });
});
