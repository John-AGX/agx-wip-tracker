// AGX email service — Phase 1 (Resend transport).
//
// One public function: sendEmail({ to, subject, html, text, replyTo, tag }).
// Wraps the Resend SDK so the rest of the app never imports the provider
// directly — swapping providers later means rewriting only this file.
//
// Configuration (env vars):
//   RESEND_API_KEY   — required, get from resend.com dashboard
//   EMAIL_FROM       — required, e.g. "AGX <notifications@agxco.com>"
//                      (must be a verified domain in Resend)
//   EMAIL_REPLY_TO   — optional, where replies go. Default: omit header.
//   EMAIL_DRY_RUN    — optional, when "true" don't actually send,
//                      just log + write to email_log. Useful for staging.
//
// Every send is recorded in the email_log table — see server/db.js.
// Failed sends are logged as 'failed' with the error; the caller decides
// whether to surface or retry. We don't auto-retry inside this module —
// callers (or a future cron) handle that.

const { pool } = require('./db');

// Lazy-load the SDK only when sendEmail is first called. Lets the
// server boot when RESEND_API_KEY isn't set yet (development before
// the key is in env) without crashing on require.
let _resendClient = null;
function getResendClient() {
  if (_resendClient) return _resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  try {
    const { Resend } = require('resend');
    _resendClient = new Resend(process.env.RESEND_API_KEY);
    return _resendClient;
  } catch (e) {
    console.error('[email] Failed to initialize Resend SDK:', e.message);
    return null;
  }
}

function isEnabled() {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
}

function isDryRun() {
  return String(process.env.EMAIL_DRY_RUN || '').toLowerCase() === 'true';
}

// Generate a stable id for log rows — short enough to surface in
// the dashboard, unique enough not to collide.
function genId() {
  return 'em_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Insert a log row. Returns the row id so callers can reference it.
async function logSend(row) {
  try {
    const id = row.id || genId();
    await pool.query(
      `INSERT INTO email_log
         (id, to_address, subject, tag, status, provider_id, error, dry_run, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        id,
        Array.isArray(row.to) ? row.to.join(', ') : (row.to || ''),
        (row.subject || '').slice(0, 500),
        (row.tag || '').slice(0, 100),
        row.status || 'unknown',
        row.providerId || null,
        row.error ? String(row.error).slice(0, 1000) : null,
        !!row.dryRun
      ]
    );
    return id;
  } catch (e) {
    console.error('[email] log insert failed:', e.message);
    return null;
  }
}

/**
 * Send a transactional email.
 *
 * @param {object} opts
 * @param {string|string[]} opts.to       — recipient(s)
 * @param {string} opts.subject           — subject line
 * @param {string} [opts.html]            — HTML body (preferred)
 * @param {string} [opts.text]            — plain-text fallback
 * @param {string} [opts.replyTo]         — Reply-To header
 * @param {string} [opts.tag]             — short tag for log/filter
 *                                          ("password_reset", "schedule_entry"...)
 * @returns {Promise<{ ok: boolean, id: string|null, providerId: string|null,
 *                     error: string|null, dryRun: boolean }>}
 */
async function sendEmail(opts) {
  opts = opts || {};
  const to = opts.to;
  const bcc = opts.bcc;
  const subject = opts.subject;
  const html = opts.html;
  const text = opts.text;
  const replyTo = opts.replyTo || process.env.EMAIL_REPLY_TO || null;
  const tag = opts.tag || '';

  if (!to || !subject) {
    const err = 'sendEmail requires `to` and `subject`';
    await logSend({ to, subject, tag, status: 'invalid', error: err });
    return { ok: false, id: null, providerId: null, error: err, dryRun: false };
  }
  if (!html && !text) {
    const err = 'sendEmail requires `html` or `text`';
    await logSend({ to, subject, tag, status: 'invalid', error: err });
    return { ok: false, id: null, providerId: null, error: err, dryRun: false };
  }

  // Hard-stop when the env isn't configured — prevents silently
  // dropping notifications during early setup. Callers can check
  // isEnabled() if they want to gate their own logic.
  if (!isEnabled()) {
    const err = 'Email service not configured (missing RESEND_API_KEY or EMAIL_FROM)';
    const id = await logSend({ to, subject, tag, status: 'unconfigured', error: err });
    return { ok: false, id, providerId: null, error: err, dryRun: false };
  }

  const dryRun = isDryRun();
  if (dryRun) {
    console.log('[email][dry-run]', { to, subject, tag });
    const id = await logSend({ to, subject, tag, status: 'dry-run', dryRun: true });
    return { ok: true, id, providerId: null, error: null, dryRun: true };
  }

  const client = getResendClient();
  if (!client) {
    const err = 'Resend SDK could not be initialized';
    const id = await logSend({ to, subject, tag, status: 'failed', error: err });
    return { ok: false, id, providerId: null, error: err, dryRun: false };
  }

  try {
    const payload = {
      from: process.env.EMAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      subject: subject,
      html: html,
      text: text
    };
    if (bcc && (Array.isArray(bcc) ? bcc.length : true)) {
      payload.bcc = Array.isArray(bcc) ? bcc : [bcc];
    }
    if (replyTo) payload.reply_to = replyTo;
    if (tag) payload.tags = [{ name: 'agx-tag', value: tag.slice(0, 100) }];

    const res = await client.emails.send(payload);
    // Resend returns { data: { id }, error: null } on success and
    // { data: null, error: {...} } on failure — handle both shapes.
    if (res && res.error) {
      const err = res.error.message || JSON.stringify(res.error);
      const id = await logSend({ to, subject, tag, status: 'failed', error: err });
      return { ok: false, id, providerId: null, error: err, dryRun: false };
    }
    const providerId = (res && res.data && res.data.id) || null;
    const id = await logSend({ to, subject, tag, status: 'sent', providerId });
    return { ok: true, id, providerId, error: null, dryRun: false };
  } catch (e) {
    const err = e && e.message ? e.message : String(e);
    const id = await logSend({ to, subject, tag, status: 'failed', error: err });
    return { ok: false, id, providerId: null, error: err, dryRun: false };
  }
}

// ── Email settings (admin-configurable per-event toggles + globals) ──
// Stored under app_settings(key='email'). DEFAULT_SETTINGS lives in
// server/email-events.js as the source of truth for shape; persisted
// values get merged on top so an event added to the catalog later
// shows up with its default state without breaking saved configs.
const { DEFAULT_SETTINGS, EVENTS } = require('./email-events');

async function getEmailSettings() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'email'"
    );
    var stored = (rows.length && rows[0].value) || {};
    var merged = {
      events: Object.assign({}, DEFAULT_SETTINGS.events, stored.events || {}),
      globalBcc: stored.globalBcc != null ? stored.globalBcc : DEFAULT_SETTINGS.globalBcc,
      digestMode: stored.digestMode != null ? stored.digestMode : DEFAULT_SETTINGS.digestMode,
      quietHours: Object.assign({}, DEFAULT_SETTINGS.quietHours, stored.quietHours || {})
    };
    // Ensure every event in the canonical catalog has an entry — new
    // events added in code won't have stored values; fall back to default.
    EVENTS.forEach(function(e) {
      if (!merged.events[e.key]) {
        merged.events[e.key] = { enabled: e.defaultEnabled, bcc: [] };
      }
    });
    return merged;
  } catch (e) {
    console.error('[email] getEmailSettings failed:', e.message);
    return DEFAULT_SETTINGS;
  }
}

async function setEmailSettings(settings) {
  await pool.query(
    "INSERT INTO app_settings (key, value) VALUES ('email', $1) " +
    "ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
    [JSON.stringify(settings)]
  );
}

// Check if a given event key is enabled in the current settings.
// Used at trigger sites in E2 to gate sends.
async function isEventEnabled(eventKey) {
  var s = await getEmailSettings();
  return !!(s.events && s.events[eventKey] && s.events[eventKey].enabled);
}

// ── sendForEvent ─────────────────────────────────────────────────────
// Canonical helper for firing notification emails by event key. Gates on
// the per-event toggle in app_settings('email'), renders the template
// (override-aware via email-templates.render), and merges per-event +
// global BCC lists onto the send. Fire-and-forget by design — caller
// should NOT await this on the request path; failures land in email_log.
//
//   sendForEvent('sub_assigned', { sub: {...}, job: {...}, ... }, {
//     to: 'mike@summit.com',          // single addr or array
//     tag: 'sub_assigned'             // optional, defaults to eventKey
//   });
//
// Returns the same shape as sendEmail. Skipped sends (event disabled, no
// recipients) resolve to { ok: false, skipped: true, reason }.
async function sendForEvent(eventKey, params, opts) {
  opts = opts || {};
  try {
    var enabled = await isEventEnabled(eventKey);
    if (!enabled) {
      return { ok: false, skipped: true, reason: 'event_disabled' };
    }
    var to = opts.to;
    if (Array.isArray(to)) to = to.filter(Boolean);
    if (!to || (Array.isArray(to) && !to.length)) {
      return { ok: false, skipped: true, reason: 'no_recipient' };
    }

    // Build BCC list: per-event BCC + global BCC. Dedupe so the same
    // address doesn't get N copies if it's in both lists.
    var settings = await getEmailSettings();
    var perEvent = (settings.events && settings.events[eventKey] && settings.events[eventKey].bcc) || [];
    var globalBcc = (settings.globalBcc || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    var bccSet = {};
    perEvent.concat(globalBcc).forEach(function(addr) { if (addr) bccSet[addr.toLowerCase()] = addr; });
    var bcc = Object.keys(bccSet).map(function(k) { return bccSet[k]; });

    // Lazy require to avoid a circular import (email-templates requires
    // ./db, which is already imported above; keeping the require inside
    // the function makes the dependency one-directional at module init).
    var emailTemplates = require('./email-templates');
    var rendered = await emailTemplates.render(eventKey, params || {});

    var payload = {
      to: to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tag: opts.tag || eventKey
    };
    if (bcc.length) payload.bcc = bcc;
    if (opts.replyTo) payload.replyTo = opts.replyTo;

    return await sendEmail(payload);
  } catch (e) {
    console.error('[email] sendForEvent failed for ' + eventKey + ':', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

module.exports = {
  sendEmail,
  sendForEvent,
  isEnabled,
  isDryRun,
  getEmailSettings,
  setEmailSettings,
  isEventEnabled
};
