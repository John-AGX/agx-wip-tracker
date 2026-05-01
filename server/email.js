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

module.exports = {
  sendEmail,
  isEnabled,
  isDryRun
};
