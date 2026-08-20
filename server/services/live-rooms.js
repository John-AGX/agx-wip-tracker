// Live Rooms — phase 01 pure core.
//
// Everything in this file is a pure function of its arguments. That is
// deliberate and it is the same reason services/ exists at all: a module that
// require()s server/routes/* only loads where JWT_SECRET is set, so the logic
// that most needs a test is the logic hardest to test. The state machines that
// decide "is this person present", "may this caller mint here" and "what does a
// cursor frame mean" therefore live here, and the router is plumbing over them.
//
// THE ONE RULE THIS FILE ENCODES
// Presence is derived from a BEACON TIMESTAMP, never from socket liveness.
// This repo has already paid for the other answer: a `: hb` keepalive on the AI
// chat stream kept bytes flowing through a wedged turn, so no proxy idled the
// socket out, the client's fetch never rejected, and turns hung for a median
// eleven minutes (server/routes/ai-routes.js:3928 records the measurement). A
// live socket is not evidence of a live participant. A recent beat is.

'use strict';

// -- Entity whitelist -------------------------------------------------------
// The attachment-org-scope.js:66 idiom. entity_type is NEVER interpolated into
// SQL; it selects a frozen descriptor or it selects nothing. Phase 01 registers
// `job` only -- the COLUMN SHAPE is the point, so phase 02's lead/estimate
// rooms are a map entry rather than a migration.
const ROOM_ENTITIES = Object.freeze({
  job: Object.freeze({ table: 'jobs', idColumn: 'id', orgColumn: 'organization_id' })
});

function roomEntity(entityType) {
  if (typeof entityType !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(ROOM_ENTITIES, entityType)
    ? ROOM_ENTITIES[entityType]
    : null;
}

// -- Credential shape gates -------------------------------------------------
// Both the room token and the per-participant stream key are 32 random bytes
// rendered hex. The gate runs BEFORE the database is touched, so a malformed
// credential costs a regex rather than a query, and the only strings that ever
// reach a WHERE clause are 64 hex characters.
//
// The stream key is gated too. The design gated only the token, which left the
// credential that authenticates every request AFTER the first one ungated.
const HEX64 = /^[a-f0-9]{64}$/;
function isRoomToken(s) { return typeof s === 'string' && HEX64.test(s); }
function isStreamKey(s) { return typeof s === 'string' && HEX64.test(s); }

// -- Timings ----------------------------------------------------------------
// BEAT_MS is what the client aims for. STALE_MS is FOUR missed beats, not one:
// a viewer on a truck phone drops a POST regularly, and a roster that labels
// them "not responding" every ninety seconds teaches the host to ignore the one
// honest state this feature has.
//
// GONE_MS sits ABOVE Chrome's background-timer throttle floor. A backgrounded
// tab is throttled to roughly one timer callback per minute -- it does not
// stop. Against a 30s threshold that tab is declared gone, its stream closed,
// and it rejoins seconds later as a NEW participant row, forever: an hour in
// another tab mints on the order of a hundred rows and flickers the roster for
// someone who never left. 90s is above the throttle floor, so a backgrounded
// tab stays a participant instead of flapping.
const BEAT_MS = 5000;
const STALE_MS = 20000;
const GONE_MS = 90000;

// The host's own liveness, which decides whether the ROOM lives. Longer than a
// participant's, because ending someone's broadcast is the more expensive
// mistake of the two and the explicit End button is the fast path.
const HOST_ENDING_MS = 90000;
const HOST_ENDED_MS = 120000;

// Absolute ceilings.
const ROOM_TTL_MS = 8 * 60 * 60 * 1000;   // a room cannot outlive its own day
const STREAM_TTL_MS = 30 * 60 * 1000;     // no socket lives forever; the client
                                          // reconnects and is handed a snapshot
const MAX_PARTICIPANTS = 25;              // a ceiling expressed as a ROW COUNT,
                                          // because a rate limit only slows an
                                          // unauthenticated join door down

// -- Participant presence ---------------------------------------------------
// Three states, computed from the beacon and nothing else.
//   live  -- beat inside STALE_MS. Asserted.
//   stale -- beat between STALE_MS and GONE_MS. Rendered dimmed and LABELLED
//            "not responding". Still on the roster, because they probably are
//            still there; the surface simply stops claiming to know.
//   gone  -- past GONE_MS. Removed from the roster, leave(timeout) emitted. A
//            wedged tab ages out instead of sitting there as a phantom face,
//            which is the whole safety story of "anyone the link got forwarded
//            to shows up here".
function presenceOf(lastSeenAt, now) {
  const seen = lastSeenAt instanceof Date ? lastSeenAt.getTime() : Number(lastSeenAt);
  if (!Number.isFinite(seen)) return 'gone';
  const age = Number(now) - seen;
  if (age < STALE_MS) return 'live';
  if (age < GONE_MS) return 'stale';
  return 'gone';
}

// -- Room lifecycle ---------------------------------------------------------
// Six independent ways a room stops, one way it starts. That asymmetry is the
// point: the worst possible defect in this feature is a room that keeps
// broadcasting after the host believes it stopped, so every ambiguous input
// resolves toward "ended".
//
// Returned states:
//   live    -- usable
//   revoked -- the host or an org admin killed the link
//   expired -- past expires_at
//   ended   -- explicitly ended, or swept on boot after a deploy
//   ending  -- the host beacon has been silent HOST_ENDING_MS; still usable,
//              but the host's own indicator stops asserting
function roomLifecycle(room, now) {
  if (!room) return 'ended';
  const t = Number(now);
  if (room.revoked_at) return 'revoked';
  if (room.ended_at) return 'ended';
  const exp = room.expires_at instanceof Date ? room.expires_at.getTime() : Date.parse(room.expires_at);
  if (Number.isFinite(exp) && exp <= t) return 'expired';
  const beat = room.last_host_beat_at instanceof Date
    ? room.last_host_beat_at.getTime()
    : Date.parse(room.last_host_beat_at);
  if (Number.isFinite(beat)) {
    if (t - beat >= HOST_ENDED_MS) return 'ended';
    if (t - beat >= HOST_ENDING_MS) return 'ending';
  }
  return 'live';
}

// Is this room still usable by a participant? `ending` is -- the host may
// simply have driven through a tunnel -- but the host's own indicator stops
// asserting while it holds.
function roomIsUsable(state) { return state === 'live' || state === 'ending'; }

// -- Projections ------------------------------------------------------------
// Hand-written allow-lists, never a row spread. Two reasons, both concrete.
// First, GET /api/jobs/:id ships `{ ...rows[0].data }` (job-routes.js:185) and
// that is exactly how contract, margin and profit reach every caller that gets
// past the access check. Second, phase 02's redaction has to happen SOMEWHERE,
// and an allow-list written on day one is a function to edit rather than a
// fan-out to rewrite.
function publicParticipant(p, now) {
  return {
    id: p.id,
    name: p.display_name || 'Guest',
    role: p.role === 'host' ? 'host' : 'viewer',
    guest: p.user_id == null,
    joined_at: p.joined_at instanceof Date ? p.joined_at.toISOString() : p.joined_at,
    presence: presenceOf(p.last_seen_at, now)
  };
}

// The room as a participant is allowed to see it. No organization_id, no token,
// no host_user_id, no entity_id -- a guest holds a link, not a login, and must
// not be able to read the id of the thing they are looking at.
//
// `title` is the forward-facing name (job number + title) resolved by the
// caller through the same entity-label path the office sees. Never a raw id.
function publicRoom(room, title, now) {
  return {
    id: room.id,
    title: title || 'Live session',
    scope: normalizeScope(room.scope),
    started_at: room.created_at instanceof Date ? room.created_at.toISOString() : room.created_at,
    expires_at: room.expires_at instanceof Date ? room.expires_at.toISOString() : room.expires_at,
    state: roomLifecycle(room, now)
  };
}

// Fail closed on an unrecognised scope. Phase 04 ("guests who can draw") is a
// VALUE in this column, so an unknown value must mean the narrowest thing, not
// the newest thing -- a row written by a future build and read by an older one
// must never widen what a guest may do.
function normalizeScope(s) { return s === 'view' ? 'view' : 'view'; }

// -- Cursors ----------------------------------------------------------------
// One coordinate space, stated once. x and y are BOTH integers 0..10000,
// normalised to the document's content width and height respectively. Not
// viewport pixels: screens differ, and a mixed unit ("0..10000" for x, "CSS px
// of scroll position" for y) breaks silently the first time a job page is
// taller than ten thousand pixels.
const CURSOR_MAX = 10000;
const MAX_SAMPLES = 12;   // sampled at 10Hz, shipped at 1Hz, plus slack

function clampCoord(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > CURSOR_MAX) return CURSOR_MAX;
  return v;
}

// A batch of [t, x, y] triples. Anything malformed is DROPPED rather than
// coerced -- a cursor is cosmetic, and a frame we cannot read is not worth
// guessing at. Returns [] for junk and never throws: this runs on a
// token-authenticated request path and must not become a way to 500 the server.
function normalizeCursorSamples(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length && out.length < MAX_SAMPLES; i++) {
    const s = raw[i];
    if (!Array.isArray(s) || s.length < 3) continue;
    const t = Math.round(Number(s[0]));
    const x = clampCoord(s[1]);
    const y = clampCoord(s[2]);
    if (!Number.isFinite(t) || t < 0 || x === null || y === null) continue;
    out.push([t, x, y]);
  }
  return out;
}

// -- Display names ----------------------------------------------------------
// A guest types this, so it is untrusted text that will be rendered next to a
// cursor on someone else's screen. Trimmed, length-capped, and stripped of
// control characters and line breaks. Escaping is the renderer's job; keeping
// it short and free of layout-breaking junk is this one's.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;
function normalizeDisplayName(raw, fallback) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  s = s.slice(0, 40).trim();
  return s || (fallback || 'Guest');
}

// -- The mint predicate -----------------------------------------------------
// THIS IS THE SENTENCE THE WHOLE TENANCY STORY RESTS ON, so it is written out
// here rather than delegated.
//
// services/job-org-scope.js carries `AND (organization_id = $2 OR
// organization_id IS NULL)`. That tolerance arm is correct where it lives: it
// is the reason a READ does not lock AGX out of legacy rows the backfill
// declined to guess at (server/db.js:614 leaves anything it could not derive
// NULL, permanently, once a second org exists). But jobInOrg therefore proves
// "in your org OR unstamped" -- so reusing it here would let ANY tenant mint a
// room against ANY unstamped job, and then live_rooms.organization_id NOT NULL
// would have nothing to stamp from, forcing either a 500 (a lockout) or a
// silent fallback to the requester's own JWT (a room born in org A over a job
// no org owns -- the exact re-derivation the membership rule forbids).
//
// So a NEW door mints on STRICT EQUALITY and refuses an unstamped parent BY
// NAME, with the remediation requireOrgId's 409 already points at. That is
// fail-closed without locking anyone out, because the refusal is actionable.
//
// Returns { ok: true, orgId } or { ok: false, status, code, error }.
function mintVerdict(callerOrgId, entityRow) {
  if (callerOrgId == null) {
    return {
      ok: false, status: 409, code: 'ORG_UNRESOLVED',
      error: 'Your user is not assigned to an organization yet, so a live session cannot be started. Ask an administrator to open your user in Admin > Users and save it.'
    };
  }
  // Absent and foreign get the SAME answer. jobs.id is caller-supplied; a
  // distinguishable 403 would turn this into a cross-tenant job-existence
  // oracle, which is the leak user-org-scope.js:64 exists to prevent.
  if (!entityRow) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Not found' };
  const rowOrg = entityRow.organization_id;
  if (rowOrg == null) {
    return {
      ok: false, status: 409, code: 'ENTITY_UNSTAMPED',
      error: 'This record is not assigned to an organization yet, so it cannot host a live session. Ask an administrator to open it and save it.'
    };
  }
  if (String(rowOrg) !== String(callerOrgId)) {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Not found' };
  }
  return { ok: true, orgId: rowOrg };
}

// ── Resume: coverage has to be PROVED, not assumed ──────────────────────
// A reconnecting stream sends ?after=<last seq it saw> and the hub decides
// whether its ring can still cover the gap. The shipped rule was
//
//     if (after >= lowest - 1) { resumed = true; backlog = ring after `after` }
//
// which only ever looks DOWNWARD. It never asked whether this hub had emitted
// that many events at all — and hubs restart at seq 0 constantly. A takeover
// is the normal deploy path, destroyHub() deletes the object, and a fresh
// process starts at zero, while the client's lastSeq only ever RISES (it is
// reset solely inside _join). So after a takeover a plain reconnect sends a
// stale-high `after`, sails past `lowest - 1`, and gets resumed:true with a
// backlog that filters to EMPTY. The client is told it resumed, so it does not
// clear its state, and it receives nothing to replace it.
//
// Today the 15s full presence snapshot papers over it, which is why it has
// never been visible. Cursors have no such snapshot.
//
// The honest rule is that a client claiming to have seen more than this hub
// ever emitted has NOT been proved coverable, so it is a reset — and the
// reason is named rather than inferred from an empty array. Every branch
// returns a reason for exactly that: "resumed with nothing to send" and
// "cannot cover you" are different answers and must not look alike.
//
//   ring   — [{ seq }, …], oldest first.  hubSeq — this hub's current seq.
//   returns { resumed, backlog, reason }
function resumeDecision(after, ring, hubSeq) {
  const list = Array.isArray(ring) ? ring : [];
  const seq = Number.isFinite(hubSeq) ? hubSeq : 0;
  const none = (reason) => ({ resumed: false, backlog: [], reason: reason });
  if (!Number.isFinite(after) || after <= 0) return none('fresh');
  // The fix. A hub cannot have delivered events it never emitted, so this
  // client is talking to a different hub than the one it was reading.
  if (after > seq) return none('hub_restarted');
  if (!list.length) return none('no_ring');
  if (after < list[0].seq - 1) return none('gap');
  return {
    resumed: true,
    backlog: list.filter(function (e) { return e.seq > after; }),
    reason: null
  };
}

module.exports = {
  resumeDecision,
  ROOM_ENTITIES, roomEntity,
  isRoomToken, isStreamKey,
  BEAT_MS, STALE_MS, GONE_MS,
  HOST_ENDING_MS, HOST_ENDED_MS,
  ROOM_TTL_MS, STREAM_TTL_MS, MAX_PARTICIPANTS,
  CURSOR_MAX, MAX_SAMPLES,
  presenceOf, roomLifecycle, roomIsUsable,
  publicParticipant, publicRoom, normalizeScope,
  normalizeCursorSamples, normalizeDisplayName,
  mintVerdict
};
