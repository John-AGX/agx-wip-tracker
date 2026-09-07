// Report share links — the pure decision layer.
//
// A share link is a BEARER CREDENTIAL: whoever holds the URL is the audience.
// It gets pasted into group chats and forwarded, so every default here is the
// NARROW one and every unknown value narrows rather than widens.
//
// This module requires NOTHING — no pool, no express, no env. That is
// deliberate (server/services/live-rooms.js is the model): the rules that
// decide what an anonymous stranger may see are the rules most worth unit
// testing, and they should be testable without a database or a JWT secret
// (see reference: tests needing server/routes/* only pass where JWT_SECRET is
// set, so security logic belongs in services/).
'use strict';

const crypto = require('crypto');

// ── Token ───────────────────────────────────────────────────────────────
// 256 bits of entropy, hex. Same generator the task-share links use.
const HEX64 = /^[a-f0-9]{64}$/;

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Tokens are stored HASHED. task_shares keeps the raw token in the row, which
// means a leaked backup or any read of that table hands over every live link;
// there is no reason to repeat that here. sha256 with no salt is correct for
// this shape — the input already carries 256 bits of entropy, so it is not
// guessable and a per-row salt would only prevent a precomputation attack that
// cannot exist. Lookup stays a single indexed equality on the hash.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function isWellFormedToken(token) {
  return HEX64.test(String(token || ''));
}

// ── Scope ───────────────────────────────────────────────────────────────
// 'view'    — read the published snapshot. No write door exists at all.
// 'comment' — additionally append a comment. Never edits the report.
//
// There is deliberately NO 'edit'. An anonymous bearer token has no identity:
// nothing distinguishes the person you sent it to from whoever they forwarded
// it to, so an edit could not be attributed, audited, or undone against a
// subject. The task-share guest may write only because it is a named worker
// ticking a defined checklist and every write is stamped with an attributed
// line; a report has no such shape. Someone who must edit gets an account.
const SHARE_SCOPES = Object.freeze(['view', 'comment']);
const SCOPE_RANK = Object.freeze({ view: 0, comment: 1 });

// An unrecognised scope means the NARROWEST thing, never the newest. A row
// written by a future build and read by an older one must narrow, not widen.
function normalizeScope(scope) {
  const s = String(scope == null ? '' : scope).trim().toLowerCase();
  return SHARE_SCOPES.indexOf(s) >= 0 ? s : 'view';
}

function scopeAllows(scope, needed) {
  const have = SCOPE_RANK[normalizeScope(scope)];
  const want = SCOPE_RANK[normalizeScope(needed)];
  return have >= want;
}

// ── Financial redaction ─────────────────────────────────────────────────
// Read STRICT: only an explicit boolean false reveals. NULL, 'f', 0, undefined
// and anything a newer build writes all mean HIDDEN. Same posture live_rooms
// takes on the same question, and for the same reason — the link is designed
// to be forwarded.
function hidesFinancials(row) {
  return !(row && row.hide_financials === false);
}

// ── Expiry ──────────────────────────────────────────────────────────────
// Stored as an ABSOLUTE timestamp, never a duration, so a row cannot silently
// extend its own life by being read later.
const DEFAULT_TTL_DAYS = 30;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 90;

function clampTtlDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) return DEFAULT_TTL_DAYS;
  return Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, Math.floor(n)));
}

function expiryFrom(days, now) {
  const base = now instanceof Date ? now.getTime() : (now || Date.now());
  return new Date(base + clampTtlDays(days) * 24 * 60 * 60 * 1000);
}

// ── Lifecycle ───────────────────────────────────────────────────────────
// One derived state for the owner's list. Order matters: revoked beats
// expired, because "I turned it off" is the more useful thing to show.
function shareLifecycle(row, now) {
  if (!row) return 'unknown';
  const t = now instanceof Date ? now.getTime() : (now || Date.now());
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() < t) return 'expired';
  if (row.opened_at) return 'opened';
  return 'sent';
}

function isLive(row, now) {
  const s = shareLifecycle(row, now);
  return s === 'opened' || s === 'sent';
}

// ── What the guest may learn about its own share ─────────────────────────
// Whitelist, not a delete-list: a column added to the table later cannot leak
// by default. Notably absent: token_hash, organization_id, created_by,
// recipient_email, the snapshot's internals, and every id.
function publicShare(row) {
  if (!row) return null;
  return {
    scope: normalizeScope(row.scope),
    expires_at: row.expires_at || null,
    recipient_name: row.recipient_name || null,
    hide_financials: hidesFinancials(row)
  };
}

// ── Comments ────────────────────────────────────────────────────────────
// A guest comment is UNTRUSTED free text from an anonymous holder of a
// forwarded URL. Caps are enforced here rather than at the route so the limits
// are testable without a database.
const COMMENT_MAX = 4000;
const AUTHOR_MAX = 120;

// Returns a normalized comment, or null when there is nothing worth storing.
// Null is the caller's cue to answer 400 — an empty comment is a mistake, not
// a silent no-op that leaves the guest thinking they were heard.
function normalizeComment(raw) {
  var body = String((raw && raw.body) || '').trim();
  if (!body) return null;
  // Collapse runs of blank lines without a regex, so there is no escaping to
  // get wrong in a path that handles untrusted text.
  var LF = String.fromCharCode(10);
  var triple = LF + LF + LF, dbl = LF + LF;
  while (body.indexOf(triple) >= 0) body = body.split(triple).join(dbl);
  body = body.slice(0, COMMENT_MAX);
  var author = String((raw && raw.author_name) || '').trim().slice(0, AUTHOR_MAX);
  var section = String((raw && raw.section_id) || '').trim().slice(0, 80);
  return { body: body, author_name: author || null, section_id: section || null };
}

// What a guest may see of a comment — including their own. No ids, no share id,
// no organization. The author name is a CLAIM the guest typed, never identity.
function publicComment(row) {
  if (!row) return null;
  return {
    body: row.body || '',
    author_name: row.author_name || null,
    section_id: row.section_id || null,
    created_at: row.created_at || null
  };
}

module.exports = {
  HEX64,
  genToken,
  hashToken,
  isWellFormedToken,
  SHARE_SCOPES,
  normalizeScope,
  scopeAllows,
  hidesFinancials,
  DEFAULT_TTL_DAYS,
  MIN_TTL_DAYS,
  MAX_TTL_DAYS,
  clampTtlDays,
  expiryFrom,
  shareLifecycle,
  isLive,
  COMMENT_MAX,
  AUTHOR_MAX,
  normalizeComment,
  publicComment,
  publicShare
};
