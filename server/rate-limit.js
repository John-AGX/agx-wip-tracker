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
//   2. ipGenericLimiter — broad per-IP guard for unauthenticated paths.
//                         60/min. Catches anonymous abuse before it can
//                         exhaust DB connections.
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

module.exports = {
  ipLoginLimiter,
  ipGenericLimiter,
  aiChatLimiter,
  aiChatHourlyLimiter,
};
