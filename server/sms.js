// SMS — Twilio client wrapper for the scheduling agent.
//
// Outbound is a thin send() that resolves Twilio creds from env and
// returns a Promise<MessageInstance>. The inbound webhook
// (server/routes/sms-routes.js) replies with TwiML directly so we
// don't usually need to call send() in the request lifecycle — keep
// this for cron jobs that proactively text crew (morning schedule
// blasts, etc.).
//
// Env vars (set on Railway):
//   TWILIO_ACCOUNT_SID    — starts with AC...
//   TWILIO_AUTH_TOKEN     — used both for outbound auth and inbound
//                           webhook signature validation
//   TWILIO_PHONE_NUMBER   — the From number, E.164 (+15555551234)
//
// If any of those are missing the module logs once at startup and
// every send() rejects — the rest of the app boots normally so dev
// envs without Twilio aren't blocked.

const { pool } = require('./db');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';

let _client = null;
let _twilioModule = null;

function isConfigured() {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER);
}

function getClient() {
  if (_client) return _client;
  if (!isConfigured()) return null;
  // Lazy-require so the dependency only loads when actually used.
  if (!_twilioModule) _twilioModule = require('twilio');
  _client = _twilioModule(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return _client;
}

function getValidator() {
  if (!_twilioModule) {
    try { _twilioModule = require('twilio'); } catch (e) { return null; }
  }
  return _twilioModule;
}

if (!isConfigured()) {
  console.log('[sms] TWILIO_* env vars not set — SMS agent disabled (inbound webhook will reject and outbound send() will reject)');
} else {
  console.log('[sms] configured for ' + TWILIO_PHONE_NUMBER);
}

// Send an outbound SMS. Logs to sms_log on both success and failure
// so admins can see what went out and why a particular send failed.
// Resolves with the Twilio Message instance on success.
async function send({ to, body, userId, intent }) {
  if (!isConfigured()) {
    throw new Error('Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER missing)');
  }
  const client = getClient();
  let msg = null;
  let errStr = null;
  try {
    msg = await client.messages.create({ from: TWILIO_PHONE_NUMBER, to: to, body: body });
  } catch (err) {
    errStr = (err && err.message) || String(err);
  }
  // Audit log — fire-and-forget, never throw on logging failure.
  pool.query(
    'INSERT INTO sms_log (direction, from_number, to_number, body, user_id, intent, twilio_sid, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    ['out', TWILIO_PHONE_NUMBER, to, body, userId || null, intent || null, msg ? msg.sid : null, errStr]
  ).catch(function(e) { console.warn('[sms] audit log write failed:', e.message); });
  if (errStr) throw new Error(errStr);
  return msg;
}

// Validate the inbound webhook came from Twilio. Returns true when
// the X-Twilio-Signature header matches the params under our auth
// token. Skipped (returns true) when SMS_SKIP_SIGNATURE_CHECK=1 — only
// for local dev with ngrok loops, never set this in production.
function validateInboundSignature({ url, params, signature }) {
  if (process.env.SMS_SKIP_SIGNATURE_CHECK === '1') return true;
  if (!isConfigured()) return false;
  const tw = getValidator();
  if (!tw || !tw.validateRequest) return false;
  return tw.validateRequest(TWILIO_AUTH_TOKEN, signature || '', url, params || {});
}

// Format a US phone number to E.164 ("+15555551234") given various
// input shapes (10-digit, 11-digit-with-1, formatted with dashes).
// Returns null if it can't make sense of the input. Used by the
// admin user-editor when an admin types in a phone like
// "(407) 555-1234" — we normalize before storing so the inbound
// webhook can match exactly on E.164.
function normalizeUSPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (String(raw).trim().startsWith('+') && digits.length >= 10) return '+' + digits;
  return null;
}

module.exports = {
  isConfigured,
  send,
  validateInboundSignature,
  normalizeUSPhone,
  fromNumber: function() { return TWILIO_PHONE_NUMBER; }
};
