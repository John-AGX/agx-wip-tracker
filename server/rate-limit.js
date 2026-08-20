// Centralized rate-limit middleware for Project 86.
//
// Why this exists (A2, 2026-05-23): /api/ai/* had zero rate limiting.
// Anthropic spend is the largest line item on the project. A single
// compromised account or misbehaving client script could burn the
// monthly budget in minutes. Mobile launch makes this worse — flaky
// connections retry aggressively, especially on the SSE chat path.
//
// Three layers, each with its own limiter:
//
//   1. ipLoginLimiter   — applied at /api/auth/login. Per-IP 10/min,
//                         60/hour. Protects against credential-stuffing
//                         and brute-force.
//
//   2. ipGenericLimiter — broad per-IP guard for all /api paths.
//                         200/min. Catches anonymous/runaway abuse before
//                         it can exhaust DB connections.
//
//   3. aiChatLimiter    — applied INSIDE the AI router after requireAuth
//                         (so req.user is set). Per-user 20/min,
//                         200/hour. Bypassed for SYSTEM_ADMIN role so
//                         the platform owner can still operate during
//                         incident response.
//
// Behavior on limit:
//   - Returns HTTP 429 with a JSON body {error, retryAfter}
//   - Sets Retry-After header (in seconds)
//   - Logs once per spike to Railway so we can see when limits hit
//
// Where rate-limits land in the stack:
//   - in-process counters (no Redis dependency)
//   - one Railway replica today, so a single counter is correct
//   - if we scale to multiple replicas, switch the `store` to
//     `rate-limit-redis` — same limiter API, just a different backend

const rateLimit = require('express-rate-limit');

// ─── helpers ────────────────────────────────────────────────────────

function jsonHandler(res, retryAfter) {
  res.status(429).json({
    error: 'Too many requests — please wait a moment and try again.',
    retryAfter: retryAfter,
  });
}

// Per-user key extractor. Called by express-rate-limit after the
// requireAuth middleware sets req.user. Falls back to IP if no user
// is present (shouldn't happen under requireAuth but defensive).
function userKey(req) {
  if (req.user && req.user.id) return 'u:' + req.user.id;
  return 'ip:' + (req.ip || 'unknown');
}

// SYSTEM_ADMIN bypass — the platform owner needs to be able to operate
// during incident response (e.g. running a recovery script that hits
// /api/ai/86/chat 50 times). Org admins do NOT bypass — only the
// system-tier role.
function bypassForSystemAdmin(req) {
  return !!(req.user && req.user.role === 'system_admin');
}

// ─── limiters ───────────────────────────────────────────────────────

// 1. Login throttle — per-IP because the caller is unauthenticated.
const ipLoginLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 10,                     // 10 attempts per minute per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again in a minute.' },
  handler: function (req, res /*, next, options*/) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] login throttle hit for IP', req.ip,
      '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

// 2. Generic per-IP guard. Applied broadly. Generous limit so we don't
// block legitimate traffic, just catch runaways.
const ipGenericLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,                    // 200 req/min per IP across all routes
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] per-IP guard hit for', req.ip, 'on', req.originalUrl,
      '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

// 3. Per-user AI chat limiter. Applied inside the AI router AFTER
// requireAuth fires. Protects Anthropic spend.
const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,                     // 20 chats per minute per user
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userKey,
  skip: bypassForSystemAdmin,
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] AI chat throttle for user',
      req.user && req.user.id, '(' + (req.user && req.user.email) + ')',
      'on', req.originalUrl, '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

// 4. Hourly per-user AI chat ceiling — a softer cap that catches
// pathological loops (a bug retrying every 3s would hit 20/min but
// 1200/hour, way past the realistic per-user budget). 200/hour is
// the equivalent of one chat every ~18 seconds for an hour straight.
const aiChatHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,    // 1 hour
  max: 200,                    // 200 chats per hour per user
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userKey,
  skip: bypassForSystemAdmin,
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 3600);
    console.warn('[rate-limit] AI chat HOURLY ceiling hit for user',
      req.user && req.user.id, '(' + (req.user && req.user.email) + ')',
      '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

// 5. Assembly-research ingest — token-authed (no cookie), so per-IP like the
// login throttle. Tight: this is a publicly-reachable write endpoint guarded
// only by a bearer token, so the limiter blunts token brute-force + packet
// spam. SYSTEM_ADMIN does NOT bypass here (there's no req.user pre-auth).
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,                     // 30 ingests per minute per TOKEN (else per IP)
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Key on the bearer token, not the IP: a leaked token driven from many source
  // IPs must still hit ONE 30/min bucket. Tokenless requests fall back to IP
  // (and the global 200/min per-IP guard still applies on top).
  keyGenerator: function (req) {
    const hdr = String((req.headers && req.headers.authorization) || '');
    const m = /^bearer\s+(.+)$/i.exec(hdr);
    const tok = (m && m[1].trim()) || String((req.headers && req.headers['x-ingest-token']) || '').trim();
    return tok ? ('tok:' + tok) : ('ip:' + (req.ip || 'unknown'));
  },
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] research-ingest throttle for IP', req.ip,
      '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

// 6 + 7. Live Rooms. These are NOT a "carve-out" of the global guard in the
// sense of replacing it — Express middleware is additive, so a limiter mounted
// ahead of `app.use('/api', ipGenericLimiter)` merely runs first and the
// request still lands in the 200/min-per-IP bucket. The /api/live router is
// therefore mounted ABOVE that line in server/index.js, which means it has NO
// per-IP guard from the global middleware and these two are the whole story.
//
// WHY IT HAD TO MOVE OUT. With trust proxy=2 the global bucket is per real
// client IP, so one NAT'd office shares 200/min across all of its ordinary app
// traffic. At the beacon's 60 req/min/participant, three people in one room
// consume 180 of those 200 and the office 429s on the whole app. Then it
// compounds: a 429 on the host's beacon starves last_host_beat_at and the room
// is ENDED at the 120s backstop. A transient limiter spike must not be able to
// terminate a live session.

// 6. The join door. This is the ONE live request that happens before a
// stream_key exists, so there is no credential to key on and it falls back to
// the IP — the ingestLimiter shape (keyGenerator with an `ip:` fallback), for
// the same reason. Tight, because it is an unauthenticated INSERT that also
// fans a `join` event out to every viewer. The hard per-room participant cap in
// live-routes is the other half: a rate limit slows this door down, a row count
// bounds it.
const liveJoinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: function (req) { return 'ip:' + (req.ip || 'unknown'); },
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] live join throttle for IP', req.ip, '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

// 7. The in-session channels: stream, beat, leave, status. Keyed on the
// participant's own stream_key so a shared office IP is irrelevant and one
// participant cannot starve another. Budget is double the 60/min the client
// aims for, leaving room for a reconnect storm without ever reaching the
// ceiling in normal use. The status probe rides the same bucket: it only fires
// on a close, and a client looping on it is exactly what should be slowed.
const liveStreamLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: function (req) {
    const k = (req.params && req.params.streamKey) || '';
    return k ? ('lsk:' + k) : ('ip:' + (req.ip || 'unknown'));
  },
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] live stream throttle on', req.originalUrl, '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

// 8. The guest READ proxy (phase 02). This is the first door under /api/live
// that returns a DOCUMENT rather than a control frame, so its 429 ceiling stops
// being a politeness budget and starts being a data-exfiltration bound. It is
// therefore stated as one, and it is TWO limiters rather than one.
//
// Why not the stream budget: a 429 on the beacon ends a participant's session,
// and sharing 180/min between a 5s heartbeat and a document fetch would let a
// scrape starve the thing that keeps the room alive.
//
// Why not a stream_key bucket ALONE, which was the first answer here: a stream
// key is not scarce. POST /:token/join mints a fresh one, liveJoinLimiter allows
// 12/min per IP, and POST /leave clears left_at immediately so the
// MAX_PARTICIPANTS row-count ceiling never binds. One IP could rotate its way to
// ~360 fetches a minute and N IPs would be unbounded. A per-key bucket bounds a
// POLITE client, not a determined one.
//
// So the bound that actually holds is keyed on the ROOM — a room is minted only
// through requireAuth, so it is the one identifier in this chain a link-holder
// cannot manufacture. The per-key bucket stays as the fast individual limit
// (express-rate-limit middleware is additive: both run).
//
// Honest residue: a guest can burn the room's shared budget for everyone in it.
// That is a nuisance available to someone who already holds the link, and the
// alternative — no real bound at all — is worse. The ceilings that actually stop
// a scrape are the three-surface allow-list and expires_at.
const liveViewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: function (req) {
    // MUST read req.params.streamKey. The route param has to be named
    // :streamKey or this silently falls back to the IP and every guest behind
    // one NAT shares a single bucket.
    const k = (req.params && req.params.streamKey) || '';
    return k ? ('lvk:' + k) : ('ip:' + (req.ip || 'unknown'));
  },
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] live view throttle on', req.originalUrl, '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

const liveRoomViewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: function (req) {
    const r = (req.params && req.params.roomId) || '';
    return r ? ('lvr:' + r) : ('ip:' + (req.ip || 'unknown'));
  },
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] live room view throttle on', req.originalUrl, '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

// 9. Phase 03 — the MIRROR channels. Two doors, two buckets, and neither of
// them shares one with the beat.
//
// THE BEAT'S BUDGET IS LOAD-BEARING FOR ROOM LIFETIME, which the comment above
// states as a consequence rather than a preference: a 429 on the host's beat
// starves last_host_beat_at and the room is ENDED at the 120s backstop. So the
// mutation channel gets its own bucket and is structurally unable to 429 the
// thing that keeps the room alive.
//
// A correction to the record while sizing these, because anyone reading the
// prose above will size a new budget wrong: the client aims at BEAT_MS = 5000
// (services/live-rooms.js:61, js/live-rooms.js beatMs), i.e. TWELVE requests a
// minute per participant, not the sixty the paragraph above describes. The
// stream bucket's 180 is therefore ~15x the shipped cadence, not 3x.
//
// The mutation up-channel coalesces at ~100ms with an early flush on a 32KB
// burst, so 1-3 POST/s is typical and ~10/s is the worst case. 900/min is that
// worst case with headroom, and it is HOST-ONLY — a viewer's POST is refused at
// the door by role, not merely rate-limited.
const liveMirrorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 900,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: function (req) {
    // MUST read req.params.streamKey — same trap as liveViewLimiter: name the
    // route param anything else and this silently falls back to the IP.
    const k = (req.params && req.params.streamKey) || '';
    return k ? ('lmk:' + k) : ('ip:' + (req.ip || 'unknown'));
  },
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] live mirror throttle on', req.originalUrl, '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

// 10. The snapshot PULL. Deliberately NOT liveViewLimiter's 30/min: that number
// was sized for a human tapping a surface picker, and this door is pulled by
// machinery. The big-batch rule turns this app's dominant render pattern
// (1,346 `innerHTML =` sites — remove-all plus insert-all to any observer) into
// a snapSeq bump, and a guest that falls behind is dropped to "resyncing",
// which ALSO pulls. Inheriting a 30/min bucket would produce a livelock built
// out of two correct-in-isolation rules: 429 -> resync -> pull -> 429.
//
// Sized against the resnapshot rate instead, and paired with a per-ROOM bucket
// for the same reason the read proxy has one: a stream key is not scarce (join
// mints a fresh one), so the bound that actually holds is keyed on the room id,
// which cannot be manufactured without requireAuth.
const liveSnapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: function (req) {
    const k = (req.params && req.params.streamKey) || '';
    return k ? ('lsn:' + k) : ('ip:' + (req.ip || 'unknown'));
  },
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] live snapshot throttle on', req.originalUrl, '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

const liveRoomSnapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 900,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: function (req) {
    const r = (req.params && req.params.roomId) || '';
    return r ? ('lsr:' + r) : ('ip:' + (req.ip || 'unknown'));
  },
  handler: function (req, res) {
    const retryAfter = Math.ceil(res.getHeader('Retry-After') || 60);
    console.warn('[rate-limit] live room snapshot throttle on', req.originalUrl, '(retry in', retryAfter, 's)');
    jsonHandler(res, retryAfter);
  },
});

module.exports = {
  ipLoginLimiter,
  ipGenericLimiter,
  aiChatLimiter,
  aiChatHourlyLimiter,
  ingestLimiter,
  liveJoinLimiter,
  liveStreamLimiter,
  liveViewLimiter,
  liveRoomViewLimiter,
  liveMirrorLimiter,
  liveSnapLimiter,
  liveRoomSnapLimiter,
};
