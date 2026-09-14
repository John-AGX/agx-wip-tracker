// Project 86 email service — Phase 1 (Resend transport).
//
// One public function: sendEmail({ to, subject, html, text, replyTo, tag,
// senderOrg }).
// Wraps the Resend SDK so the rest of the app never imports the provider
// directly — swapping providers later means rewriting only this file.
//
// Configuration (env vars):
//   RESEND_API_KEY   — required, get from resend.com dashboard
//   EMAIL_FROM       — required, e.g. "Project 86 <notifications@project86.net>"
//                      (must be a verified domain in Resend). Org-branded
//                      mail keeps this ADDRESS and swaps only the display
//                      name — see server/email-sender.js.
//   EMAIL_REPLY_TO   — optional, where replies to PLATFORM mail go. Never
//                      applied to org-branded mail. Default: omit header.
//   EMAIL_PLATFORM_NAME — optional, the "via <name>" suffix on branded
//                      mail. Default "Project 86".
//   EMAIL_DRY_RUN    — optional, when "true" don't actually send,
//                      just log + write to email_log. Useful for staging.
//
// Every send is recorded in the email_log table — see server/db.js.
// Failed sends are logged as 'failed' with the error; the caller decides
// whether to surface or retry. We don't auto-retry inside this module —
// callers (or a future cron) handle that.

const { pool } = require('./db');
const emailSender = require('./email-sender');

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
// the dashboard, unique enough not to collide. Also serves as the
// tracking token in open/click URLs (Wave 7), so no separate token
// table or column is needed.
function genId() {
  return 'em_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Resolve the public base URL for tracking links. Falls back to
// project86.net so previews work even when env vars aren't set.
function trackingBaseUrl() {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN;
  return 'https://project86.net';
}

// Inject open-tracking pixel + rewrite anchor hrefs through the
// click-tracking endpoint. The logId becomes the lookup key in both
// URLs; the track endpoints record events keyed by it.
//
// Skipped on:
//   - mailto: and tel: links (no value in click-tracking these)
//   - anchors with an existing data-no-track attribute
//   - URLs that already point at our tracking endpoint (defensive)
function injectTracking(html, logId) {
  if (!html || !logId) return html;
  const base = trackingBaseUrl();
  // Rewrite <a href="...">.
  const rewritten = html.replace(/<a\s+([^>]*?)href\s*=\s*"([^"]+)"([^>]*)>/gi, function(match, before, url, after) {
    if (/^(mailto:|tel:|#)/i.test(url)) return match;
    if (url.indexOf(base + '/api/email/track/') === 0) return match;
    if (/data-no-track/i.test(before + after)) return match;
    const wrapped = base + '/api/email/track/click/' + encodeURIComponent(logId) + '?u=' + encodeURIComponent(url);
    return '<a ' + before + 'href="' + wrapped + '"' + after + '>';
  });
  // Append the tracking pixel just before </body>, or at the end if
  // no </body> tag is present (block-rendered emails don't wrap).
  const pixel = '<img src="' + base + '/api/email/track/open/' + encodeURIComponent(logId) + '.gif" alt="" width="1" height="1" style="display:block;max-height:1px;border:0;" />';
  if (/<\/body>/i.test(rewritten)) {
    return rewritten.replace(/<\/body>/i, pixel + '</body>');
  }
  return rewritten + pixel;
}

// Insert a log row. Returns the row id so callers can reference it.
async function logSend(row) {
  try {
    const id = row.id || genId();
    await pool.query(
      `INSERT INTO email_log
         (id, to_address, subject, tag, status, provider_id, error, dry_run, from_header, reply_to, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        id,
        Array.isArray(row.to) ? row.to.join(', ') : (row.to || ''),
        (row.subject || '').slice(0, 500),
        (row.tag || '').slice(0, 100),
        row.status || 'unknown',
        row.providerId || null,
        row.error ? String(row.error).slice(0, 1000) : null,
        !!row.dryRun,
        // The From / Reply-To actually used, so a branded vs platform send
        // can be audited afterwards (and staging can verify in dry-run).
        row.from ? String(row.from).slice(0, 500) : null,
        row.replyTo ? String(row.replyTo).slice(0, 254) : null
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
 * @param {string|false} [opts.replyTo]   — Reply-To address. A string is
 *                                          validated (one plain addr-spec, not
 *                                          a recipient) and dropped if it
 *                                          fails. false = no Reply-To at all.
 *                                          Omitted = EMAIL_REPLY_TO, but only
 *                                          for platform (unbranded) mail.
 * @param {{id, name?}} [opts.senderOrg]  — EXPLICIT opt-in to org branding:
 *                                          From becomes "<Org> via Project 86"
 *                                          <EMAIL_FROM address>. The name is
 *                                          looked up by id when not given.
 *                                          opts.organizationId never implies
 *                                          this — it is metering only.
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

  // Sender identity is resolved BEFORE the unconfigured / dry-run exits so
  // every log row records the From and Reply-To the mail would have
  // carried — staging can verify branding without sending anything.
  const identity = await resolveSenderIdentity(opts, to);
  const from = identity.from;
  const replyTo = identity.replyTo;

  // Hard-stop when the env isn't configured — prevents silently
  // dropping notifications during early setup. Callers can check
  // isEnabled() if they want to gate their own logic.
  if (!isEnabled()) {
    const err = 'Email service not configured (missing RESEND_API_KEY or EMAIL_FROM)';
    const id = await logSend({ to, subject, tag, status: 'unconfigured', error: err, from, replyTo });
    return { ok: false, id, providerId: null, error: err, dryRun: false };
  }

  const dryRun = isDryRun();
  if (dryRun) {
    console.log('[email][dry-run]', { to, subject, tag, from, replyTo });
    const id = await logSend({ to, subject, tag, status: 'dry-run', dryRun: true, from, replyTo });
    return { ok: true, id, providerId: null, error: null, dryRun: true };
  }

  const client = getResendClient();
  if (!client) {
    const err = 'Resend SDK could not be initialized';
    const id = await logSend({ to, subject, tag, status: 'failed', error: err, from, replyTo });
    return { ok: false, id, providerId: null, error: err, dryRun: false };
  }

  // Pre-allocate the log id so we can inject it into the open
  // pixel + click-tracking links BEFORE the email is sent. The
  // INSERT happens AFTER the send so we have the provider id;
  // ON CONFLICT keeps us idempotent if the same id were ever re-used.
  // Declared outside the try so the catch path logs under the same id the
  // tracking pixel already points at.
  const logId = genId();
  let sentFrom = from;
  let sentReplyTo = replyTo;
  try {
    const trackedHtml = injectTracking(html, logId);

    const payload = {
      from: from,
      to: Array.isArray(to) ? to : [to],
      subject: subject,
      html: trackedHtml,
      text: text
    };
    if (bcc && (Array.isArray(bcc) ? bcc.length : true)) {
      payload.bcc = Array.isArray(bcc) ? bcc : [bcc];
    }
    // camelCase: resend@4 maps payload.replyTo onto the API's reply_to and
    // silently ignores a snake_case reply_to key. This line used to set
    // payload.reply_to, so no Reply-To ever left the app.
    if (replyTo) payload.replyTo = replyTo;
    if (tag) payload.tags = [{ name: 'p86-tag', value: tag.slice(0, 100) }];

    let res = await client.emails.send(payload);
    let retryNote = null;
    // At most ONE resend, and only when the refusal names the header that
    // this code can take back:
    //   - the From: a branded display name the provider will not accept must
    //     never cost the recipient their notification, so resend on the plain
    //     platform From (Reply-To kept).
    //   - the Reply-To: the address came from a users row checked only for
    //     shape, so resend WITHOUT it and keep the branded From.
    // Anything else (a bad recipient, an unverified domain, bad tags, rate
    // limits) is logged exactly as the provider returned it. Resending would
    // fail the same way, spend rate budget during a bulk send, and a
    // "branded From rejected" note would blame an org name that was fine.
    const refused = res && res.error ? refusedHeader(res.error) : null;
    if (refused === 'from' && identity.branded) {
      const firstErr = res.error.message || JSON.stringify(res.error);
      console.warn('[email] branded From rejected (' + firstErr + '); retrying with EMAIL_FROM. tag=' + tag);
      retryNote = 'branded From rejected by provider (' + firstErr + '); resent with platform From';
      sentFrom = process.env.EMAIL_FROM;
      res = await client.emails.send(Object.assign({}, payload, { from: sentFrom }));
    } else if (refused === 'reply_to' && payload.replyTo) {
      const firstErr = res.error.message || JSON.stringify(res.error);
      console.warn('[email] Reply-To rejected (' + firstErr + '); retrying without it. tag=' + tag);
      retryNote = 'Reply-To ' + payload.replyTo + ' rejected by provider (' + firstErr + '); resent without Reply-To';
      sentReplyTo = null;
      const withoutReplyTo = Object.assign({}, payload);
      delete withoutReplyTo.replyTo;
      res = await client.emails.send(withoutReplyTo);
    }
    // Resend returns { data: { id }, error: null } on success and
    // { data: null, error: {...} } on failure — handle both shapes.
    if (res && res.error) {
      let err = res.error.message || JSON.stringify(res.error);
      if (retryNote) err = retryNote + '; retry failed: ' + err;
      const id = await logSend({ id: logId, to, subject, tag, status: 'failed', error: err, from: sentFrom, replyTo: sentReplyTo });
      return { ok: false, id, providerId: null, error: err, dryRun: false };
    }
    const providerId = (res && res.data && res.data.id) || null;
    const id = await logSend({ id: logId, to, subject, tag, status: 'sent', providerId, error: retryNote, from: sentFrom, replyTo: sentReplyTo });
    // Usage metering (SaaS scaffold) — the one live example of the meter
    // accumulating. Counts billable sends per org per month. Fire-and-
    // forget: recordUsage never throws and a null org is a silent no-op,
    // so this can't affect the send result. Pure accounting — nothing
    // enforces the email_sends limit yet.
    if (opts.organizationId) {
      const recipients = Array.isArray(to) ? to.length : 1;
      require('./usage-meter').recordUsage(opts.organizationId, 'email_sends', recipients);
    }
    return { ok: true, id, providerId, error: null, dryRun: false };
  } catch (e) {
    const err = e && e.message ? e.message : String(e);
    const id = await logSend({ id: logId, to, subject, tag, status: 'failed', error: err, from: sentFrom, replyTo: sentReplyTo });
    return { ok: false, id, providerId: null, error: err, dryRun: false };
  }
}

// Which header a provider refusal is about: 'from', 'reply_to', or null.
//
// Resend files many different refusals under one name, validation_error (a
// bad recipient, an invalid reply_to, tags with invalid characters, and even
// a 403 for an unverified domain), so the name or a 422 alone says nothing
// about WHICH field was refused. Its message does: "Invalid `from` field. ..."
// or "Invalid `reply_to` field. ...". So:
//   'from'      the error is named invalid_from_address, or it is a
//               validation refusal whose message names the from FIELD (or
//               header);
//   'reply_to'  a validation refusal whose message names the reply_to field.
// "from" alone is not enough: the testing-mode 403 (validation_error) says
// "...change the `from` address to an email using this domain", and resending
// that on the platform From fails identically. Auth, rate-limit and outage
// errors are never validation refusals and always come back null.
const FROM_FIELD_RE = /(?:^|[^a-z_])[`"']?from[`"']?\s+(?:field|header)\b/i;
const REPLY_TO_FIELD_RE = /[`"']reply_?to[`"']|\breply[_\s-]?to\s+(?:field|header|address)\b/i;
function refusedHeader(error) {
  if (!error || typeof error !== 'object') return null;
  if (error.name === 'invalid_from_address') return 'from';
  const validation = Number(error.statusCode) === 422 || error.name === 'validation_error';
  if (!validation) return null;
  const message = typeof error.message === 'string' ? error.message : '';
  if (FROM_FIELD_RE.test(message)) return 'from';
  if (REPLY_TO_FIELD_RE.test(message)) return 'reply_to';
  return null;
}

// Resolve the From and Reply-To one send will carry.
//
//   From      EMAIL_FROM verbatim, unless the caller opted in with
//             opts.senderOrg and the org's name survives
//             email-sender.cleanOrgName — then "<Org> via Project 86"
//             <EMAIL_FROM's address>.
//   Reply-To  a string opts.replyTo, validated; false = none; omitted =
//             EMAIL_REPLY_TO for platform mail only. "Org mail" means the
//             caller passed senderOrg, even when the name itself was refused
//             and the From fell back — a tenant's sub replying to a notice
//             must never land in the platform's support inbox.
async function resolveSenderIdentity(opts, to) {
  const envFrom = process.env.EMAIL_FROM || '';
  const so = opts.senderOrg;
  const givenName = so && typeof so === 'object' && typeof so.name === 'string' && so.name.trim() ? so.name : null;
  const givenId = so && typeof so === 'object' && so.id != null && so.id !== '' ? so.id : null;
  const orgMail = !!(givenName || givenId != null);

  let from = envFrom;
  let branded = false;
  if (orgMail && envFrom) {
    const name = givenName || await emailSender.orgNameFor(pool, givenId);
    const built = emailSender.fromHeader(envFrom, name);
    if (built && built !== envFrom) { from = built; branded = true; }
  }

  let replyTo = null;
  if (typeof opts.replyTo === 'string') {
    replyTo = emailSender.cleanReplyTo(opts.replyTo, to);
  } else if (opts.replyTo == null) {
    if (!orgMail && process.env.EMAIL_REPLY_TO) {
      replyTo = emailSender.cleanReplyTo(process.env.EMAIL_REPLY_TO, to);
    }
  }
  // false (or any other non-string value) = no Reply-To header.
  return { from: from || null, branded, orgMail, replyTo };
}

// ── Email settings (admin-configurable per-event toggles + globals) ──
// Stored under app_settings(key='email'). DEFAULT_SETTINGS lives in
// server/email-events.js as the source of truth for shape; persisted
// values get merged on top so an event added to the catalog later
// shows up with its default state without breaking saved configs.
const { DEFAULT_SETTINGS, EVENTS, getEvent } = require('./email-events');

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
//     tag: 'sub_assigned',            // optional, defaults to eventKey
//     replyTo: pmEmail                // optional; false = no Reply-To
//   });
//
// Org-scope events carrying params.__orgId go out as "<Org> via Project 86";
// system-scope events always use the platform sender.
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

    var orgId = (params && params.__orgId) || opts.organizationId || null;
    var payload = {
      to: to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tag: opts.tag || eventKey,
      // Thread the org scope through so sendEmail can meter the send
      // against the right tenant (SaaS scaffold). params.__orgId is the
      // branding-cascade key the digest/notification callers already set.
      organizationId: orgId
    };
    // Sender branding follows the event catalog, not the presence of an org
    // id: callers pass __orgId on system events too (admin samples, invites),
    // and credential / onboarding mail (scope 'system': org_invite,
    // user_invite, password_reset) stays on the one recognisable platform
    // sender. render() already read the org row for branding, so the name
    // rides along with no extra query.
    var ev = getEvent(eventKey);
    if (ev && ev.scope === 'org' && orgId) {
      payload.senderOrg = { id: orgId };
      if (rendered && typeof rendered.orgName === 'string' && rendered.orgName) {
        payload.senderOrg.name = rendered.orgName;
      }
    }
    if (bcc.length) payload.bcc = bcc;
    // Passed through as given — a string, or false to suppress. sendEmail
    // validates it and applies the platform fallback rules.
    if (opts.replyTo !== undefined) payload.replyTo = opts.replyTo;

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
