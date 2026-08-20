// Live Rooms — phase 01 (the room primitive: a room exists, it knows who is in
// it, and it moves cursors between them) plus phase 02 (the viewer link:
// mirrored navigation and a redacted read proxy).
//
// STILL NOT IN THIS FILE, ON PURPOSE: no whiteboard (03) and no guest WRITE
// capability of any kind (04). A phase-02 guest observes; the only bytes they
// send are their own name and a beacon.
//
// ── PHASE 02: MIRROR A ROUTE, NOT A SNAPSHOT ───────────────────────────────
// The host's browser sends four strings — entity type, entity id, surface — and
// no money at all. The server then builds the guest's document FROM THE
// DATABASE, under the guest's own policy, from a hand-written allow-list in
// services/live-view.js.
//
// That single choice is what makes "the server never sends those numbers"
// testable rather than hopeful. A snapshot would put the HOST'S BROWSER on the
// sending side of the redactor, and that browser has already run getJobWIP: it
// holds every number the guest must not have, in a tab this process does not
// control.
//
// Two rules fall out and both are enforced below rather than documented:
//   • THE MIRROR MAY MOVE THE GUEST WITHIN THE ROOM; IT MAY NEVER MOVE THE
//     ROOM. The host's claimed route is checked against the room row — the sole
//     tenancy authority — on the HOST'S BEAT, before the event enters the replay
//     ring. Filtering it later at the projection seam would already have written
//     a foreign entity id into shared room memory.
//   • THE GUEST NEVER NAMES AN ENTITY. The read proxy takes a surface and reads
//     the entity from ctx.room. It has no parameter that could carry a job id,
//     which is what preserves publicRoom's deliberate omission of entity_id.
//
// ── TRANSPORT ──────────────────────────────────────────────────────────────
// EventSource (GET) down, batched POST up. Chosen for one reason that survives
// scrutiny: SSE response bytes are the only streaming shape with production
// evidence on this exact chain (client -> Cloudflare -> Railway -> Express),
// via the AI chat stream. WebSocket is deferred, not rejected — a probe cannot
// distinguish "no WS server exists" from "a hop stripped Upgrade", and an
// unresolved question is not a foundation.
//
// Honest caveat, recorded rather than buried: the RESPONSE SHAPE is proven on
// this chain; the EventSource CLIENT is not. `EventSource` appears nowhere else
// in this repo. Which is precisely why this implementation does NOT depend on
// any of the browser's built-in EventSource behaviour — see below.
//
// ── WE DO OUR OWN RECONNECT ────────────────────────────────────────────────
// The browser's automatic EventSource retry is deliberately neutralised by the
// client (it calls es.close() inside onerror, always). The reason is that
// EventSource surfaces NO status code, NO body and NO headers on failure — a
// closed stream looks identical whether the room ended, the participant row
// aged out, the instance changed, or a rate limiter fired. A surface driven off
// EventSource.readyState alone would tell a phone that slept for an hour "this
// session ended" about a room that is still running, which is the same
// claim-more-than-you-know defect this project has been removing, pointed the
// other way.
//
// So every close is followed by a cheap GET /:token/status probe, and every
// client-visible terminal state names its reason from THAT answer, never from
// the readyState. Resume position rides in ?after=<seq> rather than
// Last-Event-ID, because we control the reconnect.
//
// ── MOUNTING (see server/index.js) ─────────────────────────────────────────
// This router is mounted ABOVE `app.use('/api', ipGenericLimiter)`. Express
// middleware is ADDITIVE, not exclusive: a second limiter mounted "ahead of"
// the global one does not replace it, it merely runs first and the request
// still falls into the 200/min-per-IP bucket. That matters here because with
// trust proxy=2 one NAT'd office shares one bucket with all of its ordinary app
// traffic, and at 60 req/min/participant three people in a room would consume
// 180 of 200 — 429ing the whole app. Worse, a 429 on the stream GET or on the
// host's beacon would end a live room.
//
// The consequence is stated rather than hidden: /api/live has NO per-IP guard
// from the global middleware. It carries its own, and the unauthenticated join
// door — the one request that happens before a stream_key exists to key on — is
// keyed per IP and additionally bounded by a hard per-room participant CAP, so
// the ceiling is a row count and not merely a rate.
//
// ── PATH PREFIX IS LOAD-BEARING ────────────────────────────────────────────
// The stream MUST live under /api/. sw.js returns early on non-GET (:132) and
// on /api/ (:137). A room stream is a GET, so the /api/ guard is the only thing
// standing between it and the stale-while-revalidate branch at sw.js:225, which
// would cache.put() an infinite stream.

'use strict';

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, resolveOrgId, ORG_LOOKUP_FAILED } = require('../auth');
const { resolveEntityLabels } = require('../services/entity-labels');
const {
  liveJoinLimiter, liveStreamLimiter, liveViewLimiter, liveRoomViewLimiter,
  liveMirrorLimiter, liveSnapLimiter, liveRoomSnapLimiter
} = require('../rate-limit');
const L = require('../services/live-rooms');
const LV = require('../services/live-view');
const LM = require('../services/live-mirror');
const jobMoney = require('../services/money/change-order-totals');
const jobWip = require('../services/money/job-wip');
const jobCostBuckets = require('../services/money/job-cost-buckets');

const router = express.Router();

console.log('[live-routes] mounted at /api/live (phase 01: rooms, presence, cursors; phase 02: mirrored routing + redacted views)');

// Which process is fanning rooms out. Fan-out is in-memory, so a room is served
// by exactly one instance at a time; this id is how a reconnect notices it
// landed somewhere else and takes the room over.
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');

function genId(p) { return p + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }
function genSecret() { return crypto.randomBytes(32).toString('hex'); }

// ── The hub: everything ephemeral ───────────────────────────────────────────
// Durable in Postgres: the room row, participant rows, the audit timestamps.
// Ephemeral here: open response handles, current cursor positions, the beacon
// clock, and a small ring of control events for resume.
//
// No LISTEN/NOTIFY: there is none in this repo, and the pg pool sets no `max`
// (server/db.js:9 -> default 10), so a dedicated listener client would
// permanently consume a tenth of DB capacity.
const _rooms = new Map(); // roomId -> hub

function hub(roomId) {
  let h = _rooms.get(roomId);
  if (!h) {
    h = {
      id: roomId,
      seq: 0,
      ring: [],                 // last RING_MAX CONTROL events, for resume
      subs: new Map(),          // participantId -> { res, streamKey, role, policy, connectedAt, fails }
      beats: new Map(),         // participantId -> epoch ms of last beacon
      cursors: new Map(),       // participantId -> [t, x, y]
      presence: new Map(),      // participantId -> last emitted presence state
      // Phase 02. `view` is where the host currently is, in the room's own
      // terms: a SURFACE and a reason, never an entity id. Shipped in `hello`
      // for the same reason current cursor positions already are — without it a
      // mid-session joiner stares at the default until the host next moves.
      view: { surface: LV.DEFAULT_SURFACE, reason: null },
      // What each participant is actually LOOKING AT, observed from their own
      // view fetch rather than self-reported. Presenter-only: it is what tells
      // the host someone stopped following BEFORE they say "as you can see
      // here", and project() strips it from every guest's copy.
      at: new Map(),            // participantId -> surface key
      // ── Phase 03: the mirror ────────────────────────────────────────────
      // The current frame of the host's pane, PULLED by guests rather than
      // pushed to them. Three things fall out of that choice and all three
      // matter:
      //   1. an ordinary JSON GET compresses for free — the SSE stream sets
      //      no-transform (see the stream route below) and there is no
      //      compression middleware anywhere in server/, so a pushed snapshot
      //      would cross the wire raw.
      //   2. the MAX_PARTICIPANTS-way fan-out never happens. emit() loops
      //      synchronously over every sub; one pushed snapshot is N x 25 bytes
      //      queued in a single pass, and a slow phone on LTE would stall the
      //      whole room. Pulling means each guest fetches at its own pace and
      //      stalls only itself.
      //   3. resume becomes a pointer comparison (services/live-mirror.js
      //      mirrorResume).
      //
      // MUTATIONS NEVER ENTER h.ring. The ring is RING_MAX CONTROL events;
      // feeding mutations in would evict `view`, `presence` and `policy` and
      // break the resume that already works — the same argument that kept
      // cursor frames out. The tail here is bounded by BYTES and by AGE, never
      // by a count, because one entry can be a megabyte.
      mirror: null              // { snapSeq, at, surface, body, meta, ops, opsBytes, stale }
    };
    _rooms.set(roomId, h);
  }
  return h;
}

const RING_MAX = 200;
const SWEEP_MS = 15000;
const HEARTBEAT_MS = 15000;
const MAX_CONSEC_WRITE_FAILS = 2;   // mirrors ai-routes.js:3841
// Sustained BACKPRESSURE, which is a different fault from a broken socket and
// deserves a different threshold. res.write returning false once is ordinary on
// a phone; twenty consecutive times means this subscriber cannot keep up, and
// the honest answer is to close it so it reconnects into a fresh snapshot
// rather than accumulating a DOM that drifts further from the host every second
// while the server reports a healthy stream.
const MAX_CONSEC_SOFT_FAILS = 20;

// Teardown is as explicit as the ways a room ends. The design listed six ways
// the ROW ends and none for the object; an in-memory room that is never deleted
// is a leak whose only collector is the next deploy.
function destroyHub(roomId, reason) {
  const h = _rooms.get(roomId);
  if (!h) return;
  for (const [, sub] of h.subs) {
    try { sub.res.end(); } catch (_) {}
  }
  h.subs.clear(); h.beats.clear(); h.cursors.clear(); h.presence.clear(); h.at.clear(); h.ring.length = 0;
  // The mirror frame is the raw DOM of someone's private job screen. It goes on
  // the EXPLICIT clear list beside the ring and the cursors rather than being
  // left to _rooms.delete: this list is the answer to "what does the end of a
  // room actually erase", and a cached copy of the host's screen belongs in it
  // by name.
  clearMirror(h);
  _rooms.delete(roomId);
  console.log('[live] hub destroyed', roomId, reason || '');
}

// ── The projection seam ─────────────────────────────────────────────────────
// EVERY event passes through here before serialization, for every subscriber
// individually. Phase 01 shipped the identity projection precisely so phase
// 02's redaction would be a change to this ONE function rather than a fan-out
// rewrite. It is now that change, and it does two kinds of redaction:
//
//   1. `view` is REBUILT rather than filtered, so no field a future build adds
//      to the host's beat body can ride along by accident. The entity id in
//      particular never reaches a guest: publicRoom withholds it deliberately
//      (services/live-rooms.js:157) and re-leaking it through the mirror would
//      undo a shipped, tested invariant.
//   2. Per-participant `surface` is PRESENTER-ONLY. The host needs to see who
//      broke off; a guest must not learn what the other guests are reading.
//
// The second argument is the SUB, not a participant id. Redaction cannot be
// decided from an id without a DB query, and a query inside emit() turns a
// per-second feature into a query storm across every open stream. The sub
// carries {role, policy}, stamped at stream open and re-stamped when the host
// flips the policy.
function project(event, sub) { return LV.projectEvent(event, sub); }

// Drop the mirror. Called on teardown, on a mode change, and whenever the
// host's claimed route stops being authorized — every one of which must leave
// the hub with no copy of the host's screen in it.
//
// Not merely "stop sending". loadStreamContext re-queries per request and
// enforces left_at/kicked_at/roomIsUsable, so kick, revoke and expiry already
// close the snapshot door — but MODE is not in that query, and a cached
// snapshot is frozen under the policy that captured it while the projected read
// proxy re-derives from the DB under viewPolicy on every hit. So a mode flip
// has to erase the bytes, not just change what future ones look like.
function clearMirror(h) {
  if (!h) return;
  if (h.mirror) { h.mirror.body = null; h.mirror.ops = null; }
  h.mirror = null;
}

function writeFrame(sub, payload) {
  try {
    // res.write's RETURN VALUE is the whole point of this line. The shipped
    // version discarded it, so MAX_CONSEC_WRITE_FAILS could only ever fire on a
    // THROW — a full socket buffer returns false and was invisible. A guest on
    // a truck's LTE therefore accumulated an ever-growing kernel queue and,
    // once the mirror is on the wire, an ever-more-desynced DOM, with the
    // server reporting a healthy stream throughout.
    const ok = sub.res.write('data: ' + JSON.stringify(payload) + '\n\n');
    if (ok) { sub.fails = 0; sub.soft = 0; return true; }
    // A SOFT fail: the socket is alive, its buffer is simply full. Counted
    // separately and tolerated far longer than a throw, because one buffered
    // write on a phone that just went through a tunnel is normal and closing
    // that stream would be the surface claiming a fault it has no evidence for.
    // Sustained backpressure is a different thing, and MAX_CONSEC_SOFT_FAILS is
    // where it stops being ignored.
    sub.soft = (sub.soft || 0) + 1;
    return false;
  } catch (e) {
    sub.fails = (sub.fails || 0) + 1;
    return false;
  }
}

// Fan out to every open stream on this room. Control events are SEQUENCED and
// ringed; cursor frames are neither. Cursor history is never replayed — a stale
// motion trail is worse than no trail — so an id on a cursor frame would be
// pure cost, and worse: with one shared id space a resuming client's last-seen
// id is nearly always a cursor id far past any control id, which makes "the
// ring cannot cover you" resolve to a full reset almost every time.
function emit(roomId, type, data, opts) {
  const h = _rooms.get(roomId);
  if (!h) return null;
  const control = !(opts && opts.cursor);
  let ev;
  if (control) {
    h.seq += 1;
    ev = Object.assign({ type: type, seq: h.seq }, data);
    h.ring.push(ev);
    if (h.ring.length > RING_MAX) h.ring.splice(0, h.ring.length - RING_MAX);
  } else {
    ev = Object.assign({ type: type }, data);
  }
  const except = (opts && opts.except) || null;
  for (const [pid, sub] of h.subs) {
    if (except && pid === except) continue;
    // A null projection means DO NOT SEND — not "send null". Today the only
    // one is a cursor frame bound for a recipient that has no way to draw it
    // (services/live-view.js projectEvent), which was the highest-frequency
    // channel on the wire and rendered nowhere.
    const payload = project(ev, sub);
    if (payload == null) continue;
    const ok = writeFrame(sub, payload);
    if (!ok && (sub.fails >= MAX_CONSEC_WRITE_FAILS || sub.soft >= MAX_CONSEC_SOFT_FAILS)) {
      // The TCP stream is clearly broken. Close it rather than waiting for the
      // OS to notice — ai-routes.js:3841 learned this the hard way, where empty
      // catch blocks swallowed every write failure and subsequent writes
      // silently no-op'd into a frozen client.
      try { sub.res.end(); } catch (_) {}
      h.subs.delete(pid);
    }
  }
  return ev;
}

// ── Roster ──────────────────────────────────────────────────────────────────
// Built from the DB rows for durability of identity, but the PRESENCE of each
// row comes from the in-memory beacon clock. A socket being open is not
// evidence that anyone is there.
async function loadParticipants(roomId) {
  const r = await pool.query(
    `SELECT id, user_id, display_name, role, joined_at
       FROM live_participants
      WHERE room_id = $1 AND left_at IS NULL AND kicked_at IS NULL
      ORDER BY joined_at ASC`,
    [roomId]
  );
  return r.rows;
}

async function rosterFor(roomId, now) {
  const h = _rooms.get(roomId);
  const rows = await loadParticipants(roomId);
  const out = [];
  for (const p of rows) {
    const beat = h ? h.beats.get(p.id) : null;
    // A row with no beacon on this instance yet (fresh join, or a room this
    // instance just took over) is reported by its DB last_seen_at, which the
    // join wrote. It ages out on the same clock as everyone else.
    const seen = beat != null ? beat : (p.joined_at instanceof Date ? p.joined_at.getTime() : Date.parse(p.joined_at));
    const pub = L.publicParticipant(Object.assign({}, p, { last_seen_at: seen }), now);
    // PRESENTER-ONLY, and stripped for every other recipient by project(). It
    // is a safety property rather than decoration: it is what tells the host
    // that someone stopped following BEFORE they say "as you can see here".
    // Observed from the guest's own view fetch, never self-reported — a
    // cooperative client could otherwise claim to be following while reading
    // something else.
    if (h) {
      const at = h.at.get(p.id) || null;
      pub.surface = at;
      pub.following = (pub.role === 'host') ? null : (at != null && at === (h.view && h.view.surface));
    }
    out.push(pub);
  }
  return out;
}

async function entityTitle(room) {
  try {
    const labels = await resolveEntityLabels(room.organization_id, [
      { entity_type: room.entity_type, entity_id: room.entity_id }
    ]);
    return labels.get(room.entity_type + ':' + String(room.entity_id)) || null;
  } catch (e) { return null; }
}

// ── View inputs (phase 02) ──────────────────────────────────────────────────
// Everything a projection needs, loaded from the tables, for the entity the
// ROOM names. The request has no say in which entity this is — there is no
// parameter that could carry one — which is what preserves publicRoom's
// deliberate omission of entity_id.
//
// STRICT org equality on the parent row. Not jobInOrg(), not GET
// /api/jobs/:id's `OR organization_id IS NULL`, not entity-labels.js's
// tolerance: every one of those passes an UNSTAMPED row, and a guest read is
// the last place to inherit a tolerance arm written for a backfill. mintVerdict
// already refuses an unstamped parent BY NAME at mint time, so a room whose
// parent is unstamped cannot exist and strict equality here can never lock out
// a legitimate room.
//
// This is a NEW read path, not a retrofit of the ~40 money endpoints. It has to
// be: requireAuth is JWT-only and a guest holds a room token, so those doors are
// unreachable to them — which is exactly why phase 02 must never mint a JWT for
// a guest. sub-portal-routes.js:392 is the scar.
async function loadJobViewInputs(room) {
  const jr = await pool.query(
    'SELECT id, organization_id, data FROM jobs WHERE id = $1',
    [room.entity_id]
  );
  if (!jr.rows.length) return null;
  const row = jr.rows[0];
  if (row.organization_id == null || String(row.organization_id) !== String(room.organization_id)) return null;

  const job = row.data || {};
  const phases = Array.isArray(job.phases) ? job.phases : [];
  const buildings = Array.isArray(job.buildings) ? job.buildings : [];
  const subs = Array.isArray(job.subs) ? job.subs : [];

  const changeOrders = await jobMoney.changeOrdersForJob(pool, room.entity_id, job.changeOrders);
  const invoices = await jobMoney.invoicesForJob(pool, room.entity_id, job.invoices);
  const wi = (await jobWip.loadWipInputs(pool, [room.entity_id])).get(room.entity_id) || {};

  // computeJobWIP runs on the REAL inputs, server-side, and redaction happens
  // after. Derive first, redact last: pctComplete is not money and a guest
  // legitimately sees progress, but it can only be computed from figures they
  // must not have. Recomputing it from redacted inputs would produce a wrong
  // number rather than a hidden one.
  const wipDeps = {
    phases, buildings, subs, changeOrders, invoices,
    qbCostLines: wi.qbCostLines || [],
    vendorBills: wi.vendorBills || [],
    purchaseOrders: wi.purchaseOrders || []
  };
  const wip = jobWip.computeJobWIP(job, wipDeps);

  // The per-cost-code decomposition, from the SAME inputs and reconciled
  // against the same actualCosts. Built here rather than inside the projection
  // so the rollup stays a pure money function with a test of its own, and so
  // "the guest's cost table agrees with the guest's WIP tab" is arithmetic
  // rather than hope.
  const costBuckets = jobCostBuckets.jobCostBuckets(job, Object.assign({ wip }, wipDeps));

  return { job, wip, costBuckets, changeOrders, title: await entityTitle(room) };
}

const VIEW_INPUT_LOADERS = Object.freeze({ job: loadJobViewInputs });

// ── Room row helpers ────────────────────────────────────────────────────────
async function endRoom(roomId, reason) {
  await pool.query(
    `UPDATE live_rooms SET ended_at = NOW(), ended_reason = $2
      WHERE id = $1 AND ended_at IS NULL`,
    [roomId, String(reason || 'ended').slice(0, 60)]
  );
  await pool.query(
    `UPDATE live_participants
        SET left_at = NOW(), left_reason = COALESCE(left_reason, $2), stream_key = NULL
      WHERE room_id = $1 AND left_at IS NULL`,
    [roomId, 'room_' + String(reason || 'ended').slice(0, 40)]
  );
  emit(roomId, 'end', { reason: String(reason || 'ended'), at: new Date().toISOString() });
  // Give the terminal frame a tick to flush before the sockets go.
  setTimeout(function () { destroyHub(roomId, 'ended:' + reason); }, 250).unref?.();
}

// ── The sweeper ─────────────────────────────────────────────────────────────
// The server BOUNDS; the client INFORMS. Every body here is inside try/catch:
// an uncaught throw in a setInterval callback takes the whole process down, and
// that has already happened once in this repo (ai-routes.js:3946 records it).
let _sweepTimer = null;
async function sweepOnce() {
  const now = Date.now();

  // 1. Participants whose beacon has gone silent past GONE_MS. They are removed
  //    from the roster and a leave(timeout) is emitted, so a wedged tab ages
  //    out instead of sitting there as a phantom face.
  for (const [roomId, h] of _rooms) {
    for (const [pid, beat] of Array.from(h.beats)) {
      if (now - beat < L.GONE_MS) continue;
      h.beats.delete(pid);
      h.cursors.delete(pid);
      h.at.delete(pid);
      const sub = h.subs.get(pid);
      if (sub) { try { sub.res.end(); } catch (_) {} h.subs.delete(pid); }
      try {
        await pool.query(
          `UPDATE live_participants SET left_at = NOW(), left_reason = 'timeout',
                  last_seen_at = to_timestamp($2 / 1000.0), stream_key = NULL
            WHERE id = $1 AND left_at IS NULL`,
          [pid, beat]
        );
      } catch (e) { console.warn('[live] sweep leave write failed', e && e.message); }
      emit(roomId, 'leave', { participant_id: pid, reason: 'timeout', at: new Date().toISOString() });
    }

    // 2. Absolute stream TTL. No socket lives forever; the client reconnects
    //    (which it does on any close) and is handed a fresh snapshot.
    for (const [pid, sub] of Array.from(h.subs)) {
      if (now - sub.connectedAt > L.STREAM_TTL_MS) {
        try { sub.res.end(); } catch (_) {}
        h.subs.delete(pid);
      }
    }

    // 3. Presence TRANSITIONS are what get PERSISTED, not every beat: a 1Hz
    //    UPDATE per participant would be HOT-update churn on the hot path,
    //    buying durability the design discards anyway (every restart ends every
    //    room). What lands in the DB is the audit trail.
    for (const [pid, beat] of h.beats) {
      const state = L.presenceOf(beat, now);
      if (h.presence.get(pid) === state) continue;
      h.presence.set(pid, state);
      try {
        await pool.query(
          'UPDATE live_participants SET last_seen_at = to_timestamp($2 / 1000.0) WHERE id = $1 AND left_at IS NULL',
          [pid, beat]
        );
      } catch (e) { /* audit only */ }
    }

    //    The SNAPSHOT, by contrast, goes out on a FIXED CADENCE and not only on
    //    change. That is what makes the client's freshness test mean anything:
    //    the roster's honesty rule is "if I have not been told recently, I stop
    //    claiming to know", and a quiet room that emitted nothing for minutes
    //    would drive a perfectly healthy client into "disconnected". A roster
    //    is never maintained by diffs alone.
    if (h.subs.size) {
      try { emit(roomId, 'presence', { participants: await rosterFor(roomId, now), at: new Date().toISOString() }); }
      catch (e) { console.warn('[live] presence emit failed', e && e.message); }
    }
  }

  // 4. Rooms that must stop. Deliberately queried across ALL live rooms rather
  //    than only the ones this instance serves: a room whose host never comes
  //    back would otherwise hold the one-live-room-per-entity index forever.
  let rows = [];
  try {
    const r = await pool.query(
      `SELECT id, expires_at, ended_at, revoked_at, last_host_beat_at, created_at, scope
         FROM live_rooms WHERE ended_at IS NULL AND revoked_at IS NULL`
    );
    rows = r.rows;
  } catch (e) { console.warn('[live] sweep room query failed', e && e.message); return; }

  for (const room of rows) {
    const state = L.roomLifecycle(room, now);
    if (state === 'live' || state === 'ending') continue;
    try { await endRoom(room.id, state === 'expired' ? 'expired' : 'host_timeout'); }
    catch (e) { console.warn('[live] sweep end failed', room.id, e && e.message); }
  }

  // 5. Keep this instance's claim warm, and drop hubs whose row is gone.
  const liveIds = new Set(rows.map(function (r) { return r.id; }));
  for (const roomId of Array.from(_rooms.keys())) {
    if (!liveIds.has(roomId)) destroyHub(roomId, 'row_gone');
  }
  if (liveIds.size) {
    try {
      await pool.query(
        `UPDATE live_rooms SET served_beat_at = NOW()
          WHERE served_by = $1 AND ended_at IS NULL AND revoked_at IS NULL`,
        [INSTANCE_ID]
      );
    } catch (e) { /* best effort */ }
  }
}

function startSweeper() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(function () {
    // The whole body wrapped: a throw here takes the process down.
    try { sweepOnce().catch(function (e) { console.warn('[live] sweep failed:', e && e.message); }); }
    catch (e) { console.warn('[live] sweep threw:', e && e.message); }
  }, SWEEP_MS);
  if (_sweepTimer.unref) _sweepTimer.unref();
}
startSweeper();

// ── Host-side doors (requireAuth) ───────────────────────────────────────────

// POST /api/live/rooms  { entity_type, entity_id }
// Mints a room, or returns the one already live on that entity when the caller
// already hosts it. Idempotent by construction: a double-tapped button, or a
// keepalive retry, must not mint a second forwardable credential.
router.post('/rooms', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const spec = L.roomEntity(body.entity_type);
    if (!spec) return res.status(400).json({ error: 'Unsupported entity type' });
    const entityId = String(body.entity_id == null ? '' : body.entity_id).trim();
    if (!entityId) return res.status(400).json({ error: 'entity_id is required' });

    let callerOrg;
    try { callerOrg = await resolveOrgId(req); }
    catch (e) {
      return res.status(503).json({
        error: 'Could not determine your organization right now. Nothing was started — retry shortly.',
        code: ORG_LOOKUP_FAILED
      });
    }

    // Strict equality against the PARENT, and a NAMED refusal for an unstamped
    // one. Not jobInOrg(): that carries `OR organization_id IS NULL`, which
    // would let any tenant mint against any unstamped job and then leave the
    // NOT NULL tenant stamp with nothing to read. See services/live-rooms.js.
    const eR = await pool.query(
      'SELECT ' + spec.idColumn + ' AS id, ' + spec.orgColumn + ' AS organization_id' +
      '  FROM ' + spec.table + ' WHERE ' + spec.idColumn + ' = $1',
      [entityId]
    );
    const verdict = L.mintVerdict(callerOrg, eR.rows[0] || null);
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error, code: verdict.code });

    // Already live on this entity?
    const exR = await pool.query(
      `SELECT * FROM live_rooms
        WHERE entity_type = $1 AND entity_id = $2 AND ended_at IS NULL AND revoked_at IS NULL`,
      [body.entity_type, entityId]
    );
    if (exR.rows.length) {
      const ex = exR.rows[0];
      const state = L.roomLifecycle(ex, Date.now());
      if (L.roomIsUsable(state)) {
        if (String(ex.host_user_id) === String(req.user.id)) {
          const title = await entityTitle(ex);
          return res.json({
            room: L.publicRoom(ex, title, Date.now()), token: ex.token, reused: true,
            // The host's own copy of the policy. Not on publicRoom: that
            // projection is what a GUEST is allowed to see, and phase 01 keeps
            // it to the smallest set that works.
            hide_financials: ex.hide_financials !== false,
            mode: L.normalizeMode(ex.mode)
          });
        }
        // Someone else is already presenting this entity. Refusing is honest —
        // they can join the existing session — and it is not a lockout.
        let hostName = null;
        try {
          const hR = await pool.query('SELECT name FROM users WHERE id = $1', [ex.host_user_id]);
          hostName = hR.rows.length ? hR.rows[0].name : null;
        } catch (e) {}
        return res.status(409).json({
          error: (hostName ? hostName : 'Someone else') + ' already has a live session on this record.',
          code: 'ROOM_ALREADY_LIVE'
        });
      }
      // Stale row holding the index — retire it before minting.
      await endRoom(ex.id, state === 'expired' ? 'expired' : 'superseded');
    }

    const id = genId('lrm');
    const token = genSecret();
    const expires = new Date(Date.now() + L.ROOM_TTL_MS);
    const insR = await pool.query(
      `INSERT INTO live_rooms
         (id, organization_id, token, entity_type, entity_id, host_user_id, scope,
          expires_at, last_host_beat_at, served_by, served_beat_at)
       VALUES ($1,$2,$3,$4,$5,$6,'view',$7,NOW(),$8,NOW())
       RETURNING *`,
      [id, verdict.orgId, token, body.entity_type, entityId, req.user.id, expires, INSTANCE_ID]
    );
    const room = insR.rows[0];
    hub(room.id);
    const title = await entityTitle(room);
    console.log('[live] room minted', room.id, 'org', verdict.orgId, body.entity_type + ':' + entityId);
    res.json({
      room: L.publicRoom(room, title, Date.now()), token: token, reused: false,
      hide_financials: room.hide_financials !== false,
      mode: L.normalizeMode(room.mode)
    });
  } catch (e) {
    // A UNIQUE violation on the one-live-room-per-entity index means someone
    // won the race. That is the constraint doing its job, not a server fault.
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'A live session is already running on this record.', code: 'ROOM_ALREADY_LIVE' });
    }
    console.error('[live] mint failed:', e && e.stack || e);
    res.status(500).json({ error: 'Could not start the live session.' });
  }
});

// GET /api/live/mine — the rooms I am hosting right now.
//
// This exists because of a defect that is otherwise reachable by pressing F5:
// the host's indicator reads its state from its own stream, and after a reload
// there is no stream and no room id, so the host would broadcast with NO
// indicator at all until the 120s backstop — precisely the situation the
// indicator exists to prevent. Solved server-side; localStorage here would be
// the cache-resurrection scar waiting to happen.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    let callerOrg;
    try { callerOrg = await resolveOrgId(req); }
    catch (e) { return res.status(503).json({ error: 'Could not determine your organization right now.', code: ORG_LOOKUP_FAILED }); }
    if (callerOrg == null) return res.json({ rooms: [] });
    const r = await pool.query(
      `SELECT * FROM live_rooms
        WHERE organization_id = $1 AND host_user_id = $2
          AND ended_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [callerOrg, req.user.id]
    );
    const now = Date.now();
    const out = [];
    for (const room of r.rows) {
      if (!L.roomIsUsable(L.roomLifecycle(room, now))) continue;
      const title = await entityTitle(room);
      out.push({
        room: L.publicRoom(room, title, now),
        token: room.token,
        entity_type: room.entity_type,
        entity_id: room.entity_id,
        hide_financials: room.hide_financials !== false,
        mode: L.normalizeMode(room.mode)
      });
    }
    res.json({ rooms: out });
  } catch (e) {
    console.error('[live] mine failed:', e && e.message);
    res.status(500).json({ error: 'Could not load your live sessions.' });
  }
});

// Load a room the CALLER HOSTS (or an org admin in the room's own org may act
// on). The tenant comes from the ROOM ROW, never from the requester's JWT.
async function loadOwnedRoom(req, res) {
  let callerOrg;
  try { callerOrg = await resolveOrgId(req); }
  catch (e) { res.status(503).json({ error: 'Could not determine your organization right now.', code: ORG_LOOKUP_FAILED }); return null; }
  const r = await pool.query('SELECT * FROM live_rooms WHERE id = $1', [req.params.id]);
  const room = r.rows[0];
  // Absent and foreign get the same answer.
  if (!room || callerOrg == null || String(room.organization_id) !== String(callerOrg)) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  const isHost = String(room.host_user_id) === String(req.user.id);
  const isAdmin = req.user.role === 'admin' || req.user.role === 'system_admin';
  if (!isHost && !isAdmin) { res.status(404).json({ error: 'Not found' }); return null; }
  return room;
}

// POST /api/live/rooms/:id/end — the fast path. The 90s/120s host-beacon
// expiry is the backstop; this is the button. It does NOT report success from
// the client's optimism — the client waits for the `end` event / the status
// probe before it stops saying "you may still be broadcasting".
router.post('/rooms/:id/end', requireAuth, async (req, res) => {
  try {
    const room = await loadOwnedRoom(req, res);
    if (!room) return;
    await endRoom(room.id, 'host_ended');
    res.json({ ok: true, state: 'ended', reason: 'host_ended' });
  } catch (e) {
    console.error('[live] end failed:', e && e.message);
    res.status(500).json({ error: 'Could not end the session.' });
  }
});

// POST /api/live/rooms/:id/beat — the host's own liveness.
router.post('/rooms/:id/beat', requireAuth, async (req, res) => {
  try {
    const room = await loadOwnedRoom(req, res);
    if (!room) return;
    const state = L.roomLifecycle(room, Date.now());
    if (!L.roomIsUsable(state)) return res.status(410).json({ state: state, reason: room.ended_reason || state });
    await pool.query('UPDATE live_rooms SET last_host_beat_at = NOW() WHERE id = $1 AND ended_at IS NULL', [room.id]);
    const h = _rooms.get(room.id);
    res.json({ ok: true, state: 'live', watching: h ? h.subs.size : 0 });
  } catch (e) {
    res.status(500).json({ error: 'beat failed' });
  }
});

// POST /api/live/rooms/:id/policy  { hide_financials: boolean }
//
// Flipping the toggle mid-session. Three things happen, and the third is the
// one that matters:
//
//   1. the ROW changes — the row is where redaction is decided, so nothing is
//      hidden or revealed until this lands;
//   2. every OPEN SUB is re-stamped, so the fan-out seam stops needing a query
//      it never had;
//   3. a `policy` event goes out and the guest DISCARDS its current document
//      and refetches. It never patches. Flipping OFF must not become a
//      client-side unhide of data the client already lacks; flipping ON must
//      not leave a document with live numbers sitting in a guest's memory.
//
// And the bar says the arrangement changed. The guest bar's whole job is honesty
// about the arrangement; a silent change of arrangement is the same lie one
// level up.
router.post('/rooms/:id/policy', requireAuth, async (req, res) => {
  try {
    const room = await loadOwnedRoom(req, res);
    if (!room) return;
    const body = req.body || {};
    if (typeof body.hide_financials !== 'boolean') {
      return res.status(400).json({ error: 'hide_financials must be true or false.' });
    }
    const hide = body.hide_financials;
    // THE INVARIANT, defended from the other side. A mirrored room is streaming
    // the host's raw pane; turning "hide financials" on would leave the row
    // claiming a redaction the transport is not performing, which is the exact
    // failure mode this feature names as the worst one. Refused BY NAME, with
    // the action that actually achieves it — never silently accepted and never
    // silently ignored.
    if (hide && LM.normalizeMode(room.mode) === 'mirror') {
      return res.status(409).json({
        error: 'This session is mirroring your screen, so financials cannot be hidden — viewers are seeing the pixels. Switch back to the structured view first.',
        code: 'MIRROR_MODE'
      });
    }
    await pool.query('UPDATE live_rooms SET hide_financials = $2 WHERE id = $1', [room.id, hide]);
    const next = Object.assign({}, room, { hide_financials: hide });

    const h = _rooms.get(room.id);
    if (h) {
      for (const [, sub] of h.subs) {
        sub.policy = LV.viewPolicy(next, { role: sub.role });
      }
    }
    emit(room.id, 'policy', { hide_financials: hide, at: new Date().toISOString() });

    res.json({
      ok: true,
      hide_financials: hide,
      // The mechanism, not a reassurance. It is the difference between this and
      // a CSS blur, and it is the only claim the surface is allowed to make.
      note: hide
        ? 'Viewers no longer receive margins, cost or contract values — the server stops sending them.'
        : 'Viewers can now see margins, cost and contract values.'
    });
  } catch (e) {
    console.error('[live] policy failed:', e && e.message);
    res.status(500).json({ error: 'Could not change what viewers can see.' });
  }
});

// POST /api/live/rooms/:id/mode  { mode: 'projected' | 'mirror' }
//
// MODE IS A ROOM PROPERTY, NOT A PER-SURFACE ONE. A mode that changes as the
// host wanders is a mode nobody can describe, and the guest bar's whole job is
// to describe the arrangement.
//
// Four things happen and each one closes a specific way this could go wrong:
//
//   1. modeWrite() computes BOTH columns. mode='mirror' forces
//      hide_financials=false at the WRITE, so the row can never claim a
//      redaction the transport is not performing. That is "a viewer who
//      believes they are seeing a filtered view while receiving a raw one"
//      turned into a data invariant instead of a UI promise.
//   2. every open sub is re-stamped, exactly as the policy door does it, so
//      the projection seam never needs a query it does not have.
//   3. THE CACHED FRAME IS ERASED. Switching back to projected must not leave
//      the host's raw pane sitting in hub memory behind a still-valid stream
//      key — "a mirrored frame surviving a switch-to-projected is the same
//      class as a revoked link leaving the WIP table on screen", and that rule
//      has to apply to the SERVER's copy and not only to the guest's DOM.
//   4. a CONTROL event goes out — seq, ring slot — so a guest reconnecting with
//      ?after= lands in the right mode. Same argument as `view`.
//
// Host only, checked at execution (loadOwnedRoom), never gated in the UI.
router.post('/rooms/:id/mode', requireAuth, async (req, res) => {
  try {
    const room = await loadOwnedRoom(req, res);
    if (!room) return;
    const body = req.body || {};
    if (body.mode !== 'projected' && body.mode !== 'mirror') {
      return res.status(400).json({ error: "mode must be 'projected' or 'mirror'." });
    }
    const write = LM.modeWrite(body.mode, room.hide_financials);
    await pool.query(
      'UPDATE live_rooms SET mode = $2, hide_financials = $3 WHERE id = $1',
      [room.id, write.mode, write.hide_financials]
    );
    const next = Object.assign({}, room, write);

    const h = _rooms.get(room.id);
    if (h) {
      clearMirror(h);
      for (const [, sub] of h.subs) sub.policy = LV.viewPolicy(next, { role: sub.role });
    }
    emit(room.id, 'mode', {
      mode: write.mode,
      hide_financials: write.hide_financials,
      at: new Date().toISOString()
    });
    // The policy moved as a side effect of the mode, so say so on that channel
    // too rather than letting a guest bar painted from `policy` drift out of
    // step with one painted from `mode`.
    emit(room.id, 'policy', { hide_financials: write.hide_financials, at: new Date().toISOString() });

    res.json({
      ok: true,
      mode: write.mode,
      hide_financials: write.hide_financials,
      // The MECHANISM, in the host's own terms. Switching to mirror is the one
      // change in this feature that widens what a link-holder can see, so it
      // says what it does plainly rather than in a reassurance.
      note: write.mode === 'mirror'
        ? 'Viewers now see this screen exactly as you see it, including every figure on it. Screens that are not mirrored fall back to the structured view.'
        : 'Viewers are back on the structured view, built by the server from the record.'
    });
  } catch (e) {
    console.error('[live] mode failed:', e && e.message);
    res.status(500).json({ error: 'Could not change how viewers see this session.' });
  }
});

// POST /api/live/rooms/:id/kick  { participant_id, revoke? }
//
// THE HONEST LIMITATION, stated at the door rather than discovered later: a
// guest's only identity IS the shared link. Removing them kills THIS SESSION;
// it cannot stop the same person following the same link again. So the caller
// chooses, and the response says which happened. `revoke: true` kills the link
// for everyone, which is the only removal that actually holds.
//
// A best-effort soft ban rides along on the plain remove — in memory, 30
// minutes, keyed on a coarse fingerprint. It is never reported as a guarantee
// because it is not one: it dies with the process and a different network drops
// straight through it.
const _softBans = new Map(); // roomId -> Map(fingerprint -> expiresAt)
const SOFT_BAN_MS = 30 * 60 * 1000;

function fingerprint(req) {
  const ua = String((req.headers && req.headers['user-agent']) || '');
  return crypto.createHash('sha256').update(String(req.ip || '') + '|' + ua).digest('hex').slice(0, 32);
}
function isSoftBanned(roomId, req) {
  const m = _softBans.get(roomId);
  if (!m) return false;
  const exp = m.get(fingerprint(req));
  if (!exp) return false;
  if (exp < Date.now()) { m.delete(fingerprint(req)); return false; }
  return true;
}

router.post('/rooms/:id/kick', requireAuth, async (req, res) => {
  try {
    const room = await loadOwnedRoom(req, res);
    if (!room) return;
    const pid = String((req.body && req.body.participant_id) || '').trim();
    if (!pid) return res.status(400).json({ error: 'participant_id is required' });
    const revoke = !!(req.body && req.body.revoke);

    const pR = await pool.query(
      'SELECT id, room_id, organization_id, role FROM live_participants WHERE id = $1 AND room_id = $2',
      [pid, room.id]
    );
    if (!pR.rows.length) return res.status(404).json({ error: 'Not found' });
    if (pR.rows[0].role === 'host') return res.status(400).json({ error: 'The host cannot be removed. End the session instead.' });

    await pool.query(
      `UPDATE live_participants
          SET kicked_at = NOW(), kicked_by = $2, left_at = COALESCE(left_at, NOW()),
              left_reason = COALESCE(left_reason, 'kicked'), stream_key = NULL
        WHERE id = $1`,
      [pid, req.user.id]
    );

    const h = _rooms.get(room.id);
    if (h) {
      const sub = h.subs.get(pid);
      if (sub) {
        // Terminal frame first, then close. The client's own status probe is
        // what turns this into a permanent stop; the frame is the fast path.
        writeFrame(sub, { type: 'kicked', participant_id: pid, at: new Date().toISOString() });
        try { sub.res.end(); } catch (_) {}
        h.subs.delete(pid);
      }
      h.beats.delete(pid); h.cursors.delete(pid); h.presence.delete(pid); h.at.delete(pid);
      const fp = sub && sub.fingerprint;
      if (fp && !revoke) {
        let m = _softBans.get(room.id);
        if (!m) { m = new Map(); _softBans.set(room.id, m); }
        m.set(fp, Date.now() + SOFT_BAN_MS);
      }
    }

    if (revoke) {
      await pool.query('UPDATE live_rooms SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [room.id]);
      await endRoom(room.id, 'link_revoked');
    } else {
      emit(room.id, 'leave', { participant_id: pid, reason: 'kicked', at: new Date().toISOString() });
      emit(room.id, 'presence', { participants: await rosterFor(room.id, Date.now()), at: new Date().toISOString() });
    }

    res.json({
      ok: true,
      revoked: revoke,
      // Said plainly, because the surface must not claim more than it knows.
      note: revoke
        ? 'The link is dead. Nobody can rejoin this session.'
        : 'Removed from this session. They still hold the link and can rejoin — revoke the link to stop that.'
    });
  } catch (e) {
    console.error('[live] kick failed:', e && e.message);
    res.status(500).json({ error: 'Could not remove that participant.' });
  }
});

// ── Token / stream-key doors ────────────────────────────────────────────────
// The complete list of what a room token can reach is these four routes. It
// cannot reach the job, any attachment, any list, any other room, or anything
// else under /api. It provisions no users row and sets no cookie — reusing the
// app's own cookie name is what made the sub-portal logout trap inescapable.

// GET /api/live/:token/status — the sixth endpoint, and the one that makes the
// honesty rule implementable. EventSource cannot tell a client WHY it closed,
// so the client probes here on every close and names the state from this
// answer. Cheap, token-scoped, and it is what stops a slept phone being told
// "this session ended" about a room that is still running.
router.get('/:token/status', liveStreamLimiter, async (req, res) => {
  if (!L.isRoomToken(req.params.token)) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await pool.query('SELECT * FROM live_rooms WHERE token = $1', [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const room = r.rows[0];
    const now = Date.now();
    const state = L.roomLifecycle(room, now);
    res.set('Cache-Control', 'no-store');
    res.json({
      state: state,
      usable: L.roomIsUsable(state),
      reason: room.ended_reason || (state === 'live' || state === 'ending' ? null : state),
      room_id: room.id
    });
  } catch (e) {
    // "I could not tell" is not "it ended". A 503 keeps the client retrying
    // instead of announcing a terminal state it has no evidence for.
    res.status(503).json({ error: 'Could not check the session right now.' });
  }
});

// POST /api/live/:token/join  { display_name }
router.post('/:token/join', liveJoinLimiter, async (req, res) => {
  if (!L.isRoomToken(req.params.token)) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await pool.query('SELECT * FROM live_rooms WHERE token = $1', [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const room = r.rows[0];
    const now = Date.now();
    const state = L.roomLifecycle(room, now);
    // Dead-but-real gets 410, not 404: the holder legitimately had the link and
    // deserves "this ended", not "this never was".
    if (!L.roomIsUsable(state)) return res.status(410).json({ error: 'This session has ended.', state: state, reason: room.ended_reason || state });

    if (isSoftBanned(room.id, req)) {
      return res.status(403).json({ error: 'You were removed from this session.', code: 'REMOVED' });
    }

    // A ceiling expressed as a ROW COUNT. A rate limit only slows an
    // unauthenticated join door down; this bounds it.
    const cR = await pool.query(
      'SELECT COUNT(*)::int AS n FROM live_participants WHERE room_id = $1 AND left_at IS NULL AND kicked_at IS NULL',
      [room.id]
    );
    if (cR.rows[0].n >= L.MAX_PARTICIPANTS) {
      return res.status(429).json({ error: 'This session is full.', code: 'ROOM_FULL' });
    }

    // Identity. The tenant is the ROOM's, never the requester's: a signed-in
    // org-B user opening an org-A link is a GUEST of org A. user_id is stamped
    // only when the session's org matches the room's, which keeps a foreign
    // user id off an org-A row while still letting the host see a real name.
    let userId = null, userName = null, isHost = false;
    try {
      const jwt = require('jsonwebtoken');
      const { JWT_SECRET } = require('../auth');
      const tok = (req.cookies && req.cookies.token) || (req.headers.authorization || '').replace('Bearer ', '');
      if (tok) {
        const claims = jwt.verify(tok, JWT_SECRET);
        if (claims && claims.organization_id != null &&
            String(claims.organization_id) === String(room.organization_id)) {
          userId = claims.id;
          userName = claims.name || claims.email || null;
          isHost = String(claims.id) === String(room.host_user_id);
        }
      }
    } catch (e) { /* not signed in, or another tenant: they are a guest */ }

    // A request may always ask for LESS, and that is the only kind of claim a
    // client gets to make about its own role. `as: 'viewer'` is honoured as a
    // HARD DOWNGRADE — it can never grant anything, so believing it authorizes
    // nothing.
    //
    // It exists because the host role is derived from the COOKIE, and the
    // cookie rides every same-origin join including the one the read-only guest
    // page makes. So the host opening the viewer link he had just copied joined
    // his OWN room as host from that page, tripped the one-host-row supersede
    // below, and terminated the tab he was actually presenting from — while the
    // guest page, which never calls setRoute, then held a host row that reported
    // no route at all. 2dd1239 gated the guest page's boot(); this gates the
    // join, which is the door that actually hands out the role.
    if (req.body && req.body.as === 'viewer') isHost = false;

    const name = L.normalizeDisplayName(
      (req.body && req.body.display_name) || userName,
      userId ? 'Teammate' : 'Guest'
    );

    // ONE host row per room. Without this, a second tab opened by the host
    // creates a second host row whose beacon keeps last_host_beat_at alive —
    // so closing the tab you THINK you are presenting from leaves the room
    // broadcasting on the strength of a forgotten background tab. That is the
    // named worst defect in this feature, reachable by ordinary behaviour.
    if (isHost) {
      const oldR = await pool.query(
        `UPDATE live_participants
            SET left_at = NOW(), left_reason = 'superseded', stream_key = NULL
          WHERE room_id = $1 AND role = 'host' AND left_at IS NULL
          RETURNING id`,
        [room.id]
      );
      const h0 = _rooms.get(room.id);
      for (const row of oldR.rows) {
        if (h0) {
          const s = h0.subs.get(row.id);
          if (s) { writeFrame(s, { type: 'superseded', at: new Date().toISOString() }); try { s.res.end(); } catch (_) {} h0.subs.delete(row.id); }
          h0.beats.delete(row.id); h0.cursors.delete(row.id); h0.presence.delete(row.id); h0.at.delete(row.id);
        }
        emit(room.id, 'leave', { participant_id: row.id, reason: 'superseded', at: new Date().toISOString() });
      }
    }

    const pid = genId('lpt');
    const streamKey = genSecret();
    await pool.query(
      `INSERT INTO live_participants
         (id, room_id, organization_id, user_id, display_name, role, stream_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [pid, room.id, room.organization_id, userId, name, isHost ? 'host' : 'viewer', streamKey]
    );

    const h = hub(room.id);
    h.beats.set(pid, Date.now());
    h.presence.set(pid, 'live');
    emit(room.id, 'join', { participant_id: pid, display_name: name, role: isHost ? 'host' : 'viewer', at: new Date().toISOString() });
    emit(room.id, 'presence', { participants: await rosterFor(room.id, Date.now()), at: new Date().toISOString() });

    res.set('Cache-Control', 'no-store');
    res.json({
      room_id: room.id,
      participant_id: pid,
      stream_key: streamKey,
      display_name: name,
      role: isHost ? 'host' : 'viewer',
      beat_ms: L.BEAT_MS
    });
  } catch (e) {
    console.error('[live] join failed:', e && e.message);
    res.status(500).json({ error: 'Could not join the session.' });
  }
});

// Match a participant by (room_id, stream_key) and answer 404 UNIFORMLY until
// that pair resolves. The design's ordering — load the room and differentiate
// 404 / 410 / 409 BEFORE any credential is checked — rebuilds the very
// existence oracle it cites user-org-scope.js:64 against. Here the credential
// is checked FIRST; only a caller who has proven they hold one learns anything
// about the room's state.
async function loadStreamContext(req, res) {
  const roomId = String(req.params.roomId || '');
  const key = req.params.streamKey;
  if (!L.isStreamKey(key)) { res.status(404).json({ error: 'Not found' }); return null; }
  const r = await pool.query(
    `SELECT p.id AS participant_id, p.role, p.display_name, p.user_id, p.joined_at,
            r.*
       FROM live_participants p
       JOIN live_rooms r ON r.id = p.room_id
      WHERE p.room_id = $1 AND p.stream_key = $2
        AND p.left_at IS NULL AND p.kicked_at IS NULL`,
    [roomId, key]
  );
  if (!r.rows.length) { res.status(404).json({ error: 'Not found' }); return null; }
  const row = r.rows[0];
  const state = L.roomLifecycle(row, Date.now());
  if (!L.roomIsUsable(state)) {
    res.status(410).json({ error: 'This session has ended.', state: state, reason: row.ended_reason || state });
    return null;
  }
  return { participantId: row.participant_id, role: row.role, room: row, state: state };
}

// GET /api/live/:roomId/stream/:streamKey?after=<seq>
router.get('/:roomId/stream/:streamKey', liveStreamLimiter, async (req, res) => {
  let ctx;
  try { ctx = await loadStreamContext(req, res); }
  catch (e) { return res.status(503).json({ error: 'Could not open the stream right now.' }); }
  if (!ctx) return;

  const room = ctx.room;
  const pid = ctx.participantId;

  // TAKEOVER, not refusal. If this instance is not the one serving the room, it
  // claims it. Refusing (a 409) deadlocks every ordinary deploy: the old
  // instance's stale served_by blocks the reconnect while the host's still
  // recent beacon blocks the sweep, so the host is locked out of their own live
  // session for the full 120s window and told something false about why.
  // Takeovers are COUNTED, and a room that keeps changing hands is the only
  // honest signal available that more than one replica is running.
  let multiInstance = false;
  try {
    if (room.served_by !== INSTANCE_ID) {
      const tR = await pool.query(
        `UPDATE live_rooms
            SET served_by = $2, served_beat_at = NOW(), takeover_count = takeover_count + 1
          WHERE id = $1 RETURNING takeover_count`,
        [room.id, INSTANCE_ID]
      );
      const n = tR.rows.length ? tR.rows[0].takeover_count : 0;
      multiInstance = n >= 4;
      console.log('[live] took over room', room.id, 'takeovers', n);
    }
  } catch (e) { /* the stream still works; only the bookkeeping is best-effort */ }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const h = hub(room.id);
  // One stream per participant. A reconnect replaces the old handle.
  const prev = h.subs.get(pid);
  if (prev) { try { prev.res.end(); } catch (_) {} }
  // The sub carries its own ROLE and its own POLICY. Both are stamped here,
  // where ctx.role is already in scope, so the fan-out never needs a query to
  // decide what a given recipient may be shown.
  const sub = {
    res: res, streamKey: req.params.streamKey, connectedAt: Date.now(), fails: 0, soft: 0,
    fingerprint: fingerprint(req),
    role: ctx.role,
    policy: LV.viewPolicy(room, { role: ctx.role })
  };
  h.subs.set(pid, sub);
  h.beats.set(pid, Date.now());

  // Resume. Only CONTROL events are replayed, and only when the ring can still
  // cover the caller's position. Cursor history is never replayed: a stale
  // motion trail is worse than no trail.
  //
  // The decision is in services/live-rooms.js so it can be tested where it
  // lives. It now also refuses to claim a resume it cannot prove: `after`
  // above this hub's own seq means the hub restarted (a takeover, or any
  // deploy) and the caller's position is meaningless here. That case used to
  // return resumed:true with an empty backlog — the client kept its stale
  // state because it was told it had resumed, and got nothing to replace it.
  const decision = L.resumeDecision(Number(req.query.after), h.ring, h.seq);
  const resumed = decision.resumed;
  const backlog = decision.backlog;

  try {
    const now = Date.now();
    const title = await entityTitle(room);
    // hello goes through project() TOO, so there is one seam and not two. The
    // design first left it outside; that is how a per-participant field the
    // seam strips everywhere else would have shipped intact on the very first
    // frame every guest receives.
    writeFrame(sub, project({
      type: 'hello',
      room: L.publicRoom(room, title, now),
      you: { participant_id: pid, role: ctx.role },
      participants: await rosterFor(room.id, now),
      seq: h.seq,
      resumed: resumed,
      // What this recipient may be shown, said out loud. The guest shell paints
      // its bar from this rather than assuming.
      policy: { money: !!(sub.policy && sub.policy.money) },
      // Where the host is right now, in surfaces. Without it a mid-session
      // joiner stares at the default until the host next navigates — the same
      // gap current cursor positions were already fixed for below.
      view: { surface: h.view.surface || null, reason: h.view.reason || null },
      // The mirror pointer, for the same reason `view` and the current cursor
      // positions are here: without it a mid-session joiner in a mirroring room
      // stares at nothing until the host's next wholesale repaint, which on the
      // WIP pane can be minutes. The FRAME is not here — it is pulled.
      mirror: (h.mirror && h.mirror.surface)
        ? { snapSeq: h.mirror.snapSeq, surface: h.mirror.surface, at: h.mirror.at }
        : null,
      surfaces: LV.surfacesFor(room.entity_type),
      // Which surfaces this room can mirror, so the guest can tell a screen it
      // is NOT getting pixels for from one it is, and say which — rather than
      // inferring the arrangement from what happens to arrive.
      mirror_surfaces: LM.MIRROR_SURFACE_KEYS,
      // Surfaced rather than swallowed. The host's strip says so.
      multi_instance_suspected: multiInstance,
      timings: { beat_ms: L.BEAT_MS, stale_ms: L.STALE_MS, gone_ms: L.GONE_MS }
    }, sub));
    for (const ev of backlog) {
      const payload = project(ev, sub);
      if (payload != null) writeFrame(sub, payload);
    }
    // Current cursor positions, so a joiner does not stare at an empty screen
    // until someone moves. This write BYPASSES project(), so the same rule has
    // to be stated here too — a guest cannot draw a pointer measured against a
    // document they are not looking at, and shipping it costs bytes on a phone
    // for nothing.
    if (ctx.role === 'host') {
      for (const [otherPid, s] of h.cursors) {
        if (otherPid === pid) continue;
        writeFrame(sub, { type: 'cursor', p: otherPid, s: [s] });
      }
    }
  } catch (e) {
    console.warn('[live] hello failed', e && e.message);
  }

  // Proxy-idle keepalive ONLY. This comment frame carries no meaning and is
  // never treated as evidence that a participant is there — that is the entire
  // lesson of the wedged-turn incident, and the reason presence is computed
  // from the beacon instead.
  const hb = setInterval(function () {
    try {
      if (res.writableEnded) { clearInterval(hb); return; }
      res.write(': hb\n\n');
    } catch (e) { try { clearInterval(hb); } catch (_) {} }
  }, HEARTBEAT_MS);
  if (hb.unref) hb.unref();

  // Socket close is the correct signal for HANDLE cleanup — it is just not
  // evidence about presence. The beacon decides whether they are still here.
  res.on('close', function () {
    try { clearInterval(hb); } catch (_) {}
    const cur = h.subs.get(pid);
    if (cur === sub) h.subs.delete(pid);
  });
});

// POST /api/live/:roomId/beat/:streamKey
//   { cursor: [[t,x,y], ...], view?: { entity_type, entity_id, surface } }
//
// The up-channel, which doubles as the liveness beacon. Cursor samples are
// batched; receivers interpolate, so a 5s wire cadence still reads as motion at
// roughly 13 KB/min per moving participant.
//
// `view` rides this existing request rather than getting a door of its own:
// zero new bytes, zero new connections, and the host's client flushes a beat
// immediately on a route change so the latency is a round trip rather than a
// beat interval. (`away`, which phase 01's signature named and nothing ever
// read, is gone: a signature that lies is how the next phase gets a bug.)
//
// A `view` in a VIEWER's body is DROPPED. Authorize at execution, not at
// proposal — /86/chat/continue ran writes with no capability check for exactly
// this shape of reason. Without the role test, any guest steers the room.
router.post('/:roomId/beat/:streamKey', liveStreamLimiter, async (req, res) => {
  let ctx;
  try { ctx = await loadStreamContext(req, res); }
  catch (e) { return res.status(503).json({ error: 'beat failed' }); }
  if (!ctx) return;

  const h = hub(ctx.room.id);
  const pid = ctx.participantId;
  const now = Date.now();
  const wasPresence = h.presence.get(pid);
  h.beats.set(pid, now);
  h.presence.set(pid, 'live');

  const samples = L.normalizeCursorSamples(req.body && req.body.cursor);
  if (samples.length) {
    h.cursors.set(pid, samples[samples.length - 1]);
    emit(ctx.room.id, 'cursor', { p: pid, s: samples }, { cursor: true, except: pid });
  }

  // Coming back from stale is a roster change, so say so rather than letting
  // the next sweep tick decide.
  if (wasPresence && wasPresence !== 'live') {
    try { emit(ctx.room.id, 'presence', { participants: await rosterFor(ctx.room.id, now), at: new Date().toISOString() }); } catch (e) {}
  }

  // ── Mirrored navigation ───────────────────────────────────────────────
  // HOST ONLY, and validated HERE rather than at the projection seam. emit()
  // pushes onto h.ring BEFORE any projection runs, so a foreign entity id
  // filtered downstream would already be sitting in shared room memory waiting
  // to be replayed to every ?after= reconnect. The filter has to run before the
  // event exists.
  //
  // hostViewEvent compares the claimed route against ctx.room — the room row is
  // the sole tenancy authority — and returns a SURFACE and a reason, never an
  // entity id. Three refusals, each with its own honest reason for the guest
  // bar to say: off_room (the host opened a different record), not_shared (a
  // surface this room does not serve), away (the host left the job entirely).
  if (ctx.role === 'host' && req.body && Object.prototype.hasOwnProperty.call(req.body, 'view')) {
    const next = LV.hostViewEvent(req.body.view, ctx.room);
    if (!LV.viewEq(next, h.view)) {
      h.view = next;
      // A CONTROL event, not a cursor frame: it takes a seq and a ring slot, so
      // a guest reconnecting with ?after= lands on the right page. Cursor
      // frames are deliberately never replayed; a route must be.
      emit(ctx.room.id, 'view', { surface: next.surface, reason: next.reason, at: new Date().toISOString() });
      // Who is still with him changed meaning, so the roster is re-emitted:
      // `following` is derived from this comparison.
      try { emit(ctx.room.id, 'presence', { participants: await rosterFor(ctx.room.id, now), at: new Date().toISOString() }); } catch (e) {}
    }
  }

  // The host's beat also keeps the ROOM alive. Throttled to once per ~15s so
  // this is not a 1Hz write.
  if (ctx.role === 'host') {
    const beatRow = ctx.room.last_host_beat_at;
    const last = beatRow instanceof Date ? beatRow.getTime() : Date.parse(beatRow);
    if (!Number.isFinite(last) || now - last > 15000) {
      try { await pool.query('UPDATE live_rooms SET last_host_beat_at = NOW() WHERE id = $1 AND ended_at IS NULL', [ctx.room.id]); } catch (e) {}
    }
  }

  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, watching: h.subs.size, state: ctx.state });
});

// GET /api/live/:roomId/view/:streamKey/:surface — THE READ PROXY.
//
// The one door in this file that returns a document. Everything about its shape
// is a consequence of "a guest is not a user":
//
//   • The param is named :streamKey EXACTLY. liveViewLimiter's keyGenerator
//     reads req.params.streamKey and silently falls back to 'ip:' otherwise —
//     name it :key and every guest behind one NAT shares one bucket.
//   • TWO limiters. Per-key bounds a polite client; per-ROOM is the bound that
//     actually holds, because a stream key can be rotated by rejoining and a
//     room id cannot be manufactured without requireAuth. See rate-limit.js.
//   • The credential is checked FIRST (loadStreamContext), so a caller who does
//     not hold one learns nothing about the room.
//   • The entity comes from ctx.room. There is no parameter that could carry an
//     entity id, so "a guest cannot reach any record but the presented one" is
//     a property of the ROUTE SHAPE rather than of a check someone must
//     remember to write.
//   • The surface must be in the frozen allow-list AND must belong to the
//     room's entity type. Both refusals answer the same 400.
//   • no-store. This response is a redacted copy of someone's private job.
router.get('/:roomId/view/:streamKey/:surface', liveRoomViewLimiter, liveViewLimiter, async (req, res) => {
  let ctx;
  try { ctx = await loadStreamContext(req, res); }
  catch (e) { return res.status(503).json({ error: 'Could not load that view right now.' }); }
  if (!ctx) return;

  const room = ctx.room;
  const surface = String(req.params.surface || '');
  const spec = LV.surfaceSpec(surface);
  // Unknown surface and wrong-entity surface get the SAME answer: a
  // distinguishable refusal would turn the allow-list into an oracle.
  if (!spec || spec.entity !== room.entity_type) {
    return res.status(400).json({ error: 'That view is not shared.', code: 'NOT_SHARED' });
  }

  const loader = Object.prototype.hasOwnProperty.call(VIEW_INPUT_LOADERS, room.entity_type)
    ? VIEW_INPUT_LOADERS[room.entity_type] : null;
  if (!loader) return res.status(400).json({ error: 'That view is not shared.', code: 'NOT_SHARED' });

  try {
    const inputs = await loader(room);
    // A room whose parent vanished or whose org stopped matching answers the
    // same "not shared" rather than naming what changed.
    if (!inputs) return res.status(404).json({ error: 'Not found' });

    const policy = LV.viewPolicy(room, { role: ctx.role });
    const doc = LV.buildView(surface, inputs, policy);
    if (!doc) return res.status(400).json({ error: 'That view is not shared.', code: 'NOT_SHARED' });

    // The guard that makes a builder bug LOUD instead of quiet. A surviving
    // internal tag means a container redact() could not walk, and shipping one
    // would ship a raw number under a name nothing renders. 500 rather than
    // send: a redactor that misses one field is worse than no redactor,
    // because the toggle says the numbers are gone.
    if (LV.containsRawTag(doc)) {
      console.error('[live] view builder leaked a raw cell tag; refusing to send', surface);
      return res.status(500).json({ error: 'Could not build that view.' });
    }

    // Observed, not self-reported: what the host's roster shows this guest is
    // reading comes from the fetch they actually made.
    const h = _rooms.get(room.id);
    if (h) h.at.set(ctx.participantId, surface);

    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.json({
      surface: surface,
      view: doc,
      // Said out loud on every document, so the guest bar can never drift out
      // of step with what the bytes actually contain.
      money_visible: !!policy.money,
      at: new Date().toISOString()
    });
  } catch (e) {
    console.error('[live] view failed:', e && e.message);
    res.status(500).json({ error: 'Could not load that view.' });
  }
});

// ── PHASE 03: THE MIRROR CHANNELS ───────────────────────────────────────────
//
// POST /api/live/:roomId/mirror/:streamKey
//   { claim: { entity_type, entity_id, surface }, kind: 'snap'|'ops'|'off',
//     snapSeq, root?, meta?, ops? }
//
// ══ WHY THE CLAIM RIDES EVERY FLUSH ════════════════════════════════════════
// This is the correction that the whole mode rests on, so it is written out
// rather than delegated.
//
// In PROJECTED mode a guest's document is built by this process FROM THE
// DATABASE, and the read proxy has no parameter that could carry an entity id —
// "a guest cannot reach any record but the presented one" is a property of the
// route SHAPE. In MIRROR mode the bytes come from the host's DOM, which is
// repainted before this process hears about anything.
//
// The route travels on the BEAT, at BEAT_MS = 5000. Mutation flushes are ~50x
// faster. And switching jobs does not create new panes: renderWipTab and
// renderChangeOrders repaint the SAME element in place with the new job's
// numbers, and the observer is attached to that element. So a mirror that
// trusted the last beat's verdict would stream job B's pixels under job A's
// authorization for up to a beat — and "they have access to the job anyway"
// stops covering it the moment the leaked job is a DIFFERENT job.
//
// A role check is not the same check. `ctx.role === 'host'` on the beat is
// authorization to STEER; hostViewEvent is the TENANCY test, and it runs
// against ctx.room — the sole tenancy authority. Both run here, on every flush,
// and a refusal DISCARDS the payload rather than merely declining to fan it
// out: emit() rings control events before any projection, so a filter applied
// downstream would already have written the wrong job's bytes into shared room
// memory.
//
// The window is therefore zero, because there is no window.
//
// ══ AND THE CONTENT ALLOW-LIST IS ITS OWN ══════════════════════════════════
// hostViewEvent authorizes a surface KEY. In projected mode that key resolves
// to a hand-built fifteen-field document; in mirror mode it would resolve to a
// DOM subtree this process cannot classify, and for job-overview those differ by
// the job's entire sub-contract, AP, AR and PO ledger, the task list with
// assignee names, and the file tree. services/live-mirror.js states which
// surfaces may be mirrored and names the refusal for every one that may not.
router.post('/:roomId/mirror/:streamKey', liveMirrorLimiter, async (req, res) => {
  let ctx;
  try { ctx = await loadStreamContext(req, res); }
  catch (e) { return res.status(503).json({ error: 'mirror failed' }); }
  if (!ctx) return;

  // AUTHORIZE AT EXECUTION. /86/chat/continue ran writes with no capability
  // check for exactly this shape of reason; a guest POSTing here must be
  // refused at the door, not filtered downstream.
  if (ctx.role !== 'host') return res.status(403).json({ error: 'Not found' });

  const h = hub(ctx.room.id);
  const body = req.body || {};

  // The tenancy test, then the content test. Both on THIS flush, both against
  // the room row.
  const verdict = LV.hostViewEvent(body.claim, ctx.room);
  const gate = LM.mirrorAuthorize(verdict, ctx.room.mode);

  if (!gate.ok || body.kind === 'off') {
    // DISCARD. Nothing this request carried is stored, replayed or fanned out.
    const had = !!h.mirror;
    clearMirror(h);
    if (had) {
      // Guests are moved off a frame that is no longer current rather than left
      // staring at it presented as live. Phase 01's honesty rule.
      emit(ctx.room.id, 'mirror-off', { reason: gate.reason || 'away', at: new Date().toISOString() });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: false,
      surface: null,
      reason: gate.reason || 'away',
      fallback: LM.fallsBackToProjected(gate.reason),
      watching: h.subs.size
    });
  }

  const surface = gate.surface;
  const now = Date.now();

  try {
    if (body.kind === 'snap') {
      const serialized = JSON.stringify({ root: body.root, meta: body.meta || {} });
      if (serialized.length > LM.MIRROR_MAX_SNAP_BYTES) {
        // Refused with a NAMED reason rather than truncated. A truncated DOM is
        // a wrong screen that looks like a right one.
        clearMirror(h);
        emit(ctx.room.id, 'mirror-off', { reason: 'too_big', at: new Date().toISOString() });
        return res.json({ ok: false, surface: null, reason: 'too_big', fallback: true, watching: h.subs.size });
      }
      h.mirror = {
        snapSeq: Number(body.snapSeq) || 1,
        at: new Date(now).toISOString(),
        surface: surface,
        body: serialized,
        meta: body.meta || {},
        ops: [],
        opsBytes: 0,
        stale: false
      };
      // A ~60-byte POINTER. The frame itself is pulled.
      //
      // NOT a control event, for the same reason mutations are not: the ring is
      // RING_MAX slots of `view`, `presence`, `policy` and `mode`, and a
      // pointer that re-fires on every wholesale repaint would evict all of
      // them within a busy minute. A guest that misses a pointer self-heals on
      // the next mirror-op, which carries snapSeq and no longer matches its own;
      // and a JOINING guest gets the current pointer in `hello`, which is where
      // per-connection state belongs.
      emit(ctx.room.id, 'mirror-snap', {
        snapSeq: h.mirror.snapSeq, surface: surface,
        w: (body.meta && body.meta.w) || null, h: (body.meta && body.meta.h) || null,
        at: h.mirror.at
      }, { cursor: true });
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, surface: surface, reason: null, watching: h.subs.size });
    }

    if (body.kind === 'ops') {
      // A takeover moved this room to a process that has no snapshot, so every
      // guest's DOM is orphaned. live-routes' takeover path only bumps
      // takeover_count; without this, every deploy would leave a room mirroring
      // into nothing. The host is told to re-send rather than the guests being
      // shown a stale frame.
      if (!h.mirror || h.mirror.surface !== surface || Number(body.snapSeq) !== h.mirror.snapSeq) {
        res.set('Cache-Control', 'no-store');
        return res.json({ ok: true, surface: surface, reason: null, resnapshot: true, watching: h.subs.size });
      }
      const ops = Array.isArray(body.ops) ? body.ops : [];
      // A batch this big means the sender's own big-batch rule did not fire —
      // a bug, or a client that is not ours. Answer with "send me a whole
      // frame" rather than folding a delta nobody can bound into the tail.
      let batchBytes = 0;
      try { batchBytes = JSON.stringify(ops).length; } catch (e) { batchBytes = LM.MIRROR_MAX_FLUSH_BYTES + 1; }
      if (batchBytes > LM.MIRROR_MAX_FLUSH_BYTES) {
        res.set('Cache-Control', 'no-store');
        return res.json({ ok: true, surface: surface, reason: null, resnapshot: true, watching: h.subs.size });
      }
      const folded = LM.foldOps(h.mirror.ops, ops, h.mirror.opsBytes, now);
      h.mirror.ops = folded.ops;
      h.mirror.opsBytes = folded.bytes;
      h.mirror.stale = h.mirror.stale || folded.stale;
      h.mirror.at = new Date(now).toISOString();
      // NOT a control event: mutations must never take a ring slot. `cursor:
      // true` is this file's existing name for "sequence-less, never replayed".
      emit(ctx.room.id, 'mirror-op', { snapSeq: h.mirror.snapSeq, surface: surface, ops: ops }, { cursor: true, except: ctx.participantId });
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, surface: surface, reason: null, watching: h.subs.size });
    }

    return res.status(400).json({ error: 'Unknown mirror frame.' });
  } catch (e) {
    console.error('[live] mirror failed:', e && e.message);
    return res.status(500).json({ error: 'mirror failed' });
  }
});

// GET /api/live/:roomId/mirror/:streamKey/snapshot — THE PULL.
//
// Same credential shape and the same ordering as the read proxy: the credential
// is checked FIRST, so a caller who does not hold one learns nothing about the
// room. Two limiters, sized against the RESNAPSHOT rate rather than inherited
// from the read proxy's 30/min — that number was sized for a human tapping a
// surface picker, and inheriting it here would produce a livelock, because the
// answer to "you fell behind" is itself a pull.
//
// MODE IS CHECKED HERE, and that check is not redundant with the mode door's
// clearMirror(): loadStreamContext re-queries the room row per request and
// covers kick, revoke and expiry, but it does not know about mode, and a cached
// snapshot is frozen under the policy that captured it while the projected read
// proxy re-derives under viewPolicy on every hit.
router.get('/:roomId/mirror/:streamKey/snapshot', liveRoomSnapLimiter, liveSnapLimiter, async (req, res) => {
  let ctx;
  try { ctx = await loadStreamContext(req, res); }
  catch (e) { return res.status(503).json({ error: 'Could not load that screen right now.' }); }
  if (!ctx) return;

  if (LM.normalizeMode(ctx.room.mode) !== 'mirror') {
    return res.status(409).json({ error: 'This session is not mirroring.', code: 'NOT_MIRRORING' });
  }
  const h = _rooms.get(ctx.room.id);
  const m = h && h.mirror;
  if (!m || !m.body) {
    // "I have nothing yet" is not "there is nothing". The guest waits and is
    // told it is waiting; it is never handed a stale frame as current.
    return res.status(404).json({ error: 'No frame yet.', code: 'NO_SNAPSHOT' });
  }
  // The surface the ROOM currently says the host is on. A frame captured for a
  // surface the room has since moved off is not served: every frame carries the
  // server-issued surface key so a guest can drop anything labelled for a
  // surface it is not showing.
  if (h.view && h.view.surface && m.surface !== h.view.surface) {
    return res.status(409).json({ error: 'That screen moved.', code: 'SURFACE_MOVED' });
  }

  if (h) h.at.set(ctx.participantId, m.surface);
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Type', 'application/json; charset=utf-8');
  // Assembled as text rather than through res.json so the stored frame is never
  // re-parsed and re-serialized on every pull. Unlike the SSE stream this
  // response sets NO no-transform, so it compresses on the way out for free.
  res.send('{"snapSeq":' + JSON.stringify(m.snapSeq) +
           ',"surface":' + JSON.stringify(m.surface) +
           ',"at":' + JSON.stringify(m.at) +
           ',"stale":' + JSON.stringify(!!m.stale) +
           ',"frame":' + m.body + '}');
});

// POST /api/live/:roomId/leave/:streamKey — sent with keepalive:true on
// pagehide, and the client clears its own room credentials BEFORE navigating.
// The sub-portal logout trap is the precedent: a leave that races a navigation
// leaves a credential behind that silently resurrects a session the host
// thought was over.
router.post('/:roomId/leave/:streamKey', liveStreamLimiter, async (req, res) => {
  let ctx;
  try { ctx = await loadStreamContext(req, res); }
  catch (e) { return res.status(503).json({ error: 'leave failed' }); }
  if (!ctx) return;
  try {
    await pool.query(
      `UPDATE live_participants
          SET left_at = NOW(), left_reason = 'left', last_seen_at = NOW(), stream_key = NULL
        WHERE id = $1 AND left_at IS NULL`,
      [ctx.participantId]
    );
    const h = _rooms.get(ctx.room.id);
    if (h) {
      const sub = h.subs.get(ctx.participantId);
      if (sub) { try { sub.res.end(); } catch (_) {} h.subs.delete(ctx.participantId); }
      h.beats.delete(ctx.participantId); h.cursors.delete(ctx.participantId); h.presence.delete(ctx.participantId); h.at.delete(ctx.participantId);
    }
    emit(ctx.room.id, 'leave', { participant_id: ctx.participantId, reason: 'left', at: new Date().toISOString() });
    // The host leaving ends the room. Ending must be as reliable as starting,
    // and this is the fast path for "closed the tab" — the 120s beacon backstop
    // still covers the case where this request never lands.
    if (ctx.role === 'host') {
      await endRoom(ctx.room.id, 'host_left');
    } else {
      emit(ctx.room.id, 'presence', { participants: await rosterFor(ctx.room.id, Date.now()), at: new Date().toISOString() });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'leave failed' });
  }
});

function stopSweeper() {
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
}

module.exports = router;
module.exports.__internals = {
  INSTANCE_ID, _rooms, sweepOnce, destroyHub, emit, hub, project,
  startSweeper, stopSweeper, _softBans
};
