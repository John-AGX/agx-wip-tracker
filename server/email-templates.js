// Transactional email templates.
//
// Each function returns { subject, html, text } for one event type.
// Keep templates in this single module so the visual / copy pass can
// happen in one place rather than chasing template strings through
// route handlers.
//
// Style: AGX-blue accent (#4f8cff), system font, generous whitespace.
// Plain-text fallback always provided for clients that strip HTML.

// Pick the public app URL for "Sign in" / "Open in AGX" links in
// emails. Reads APP_URL env var so the same code works against
// localhost in dev, the prod custom domain by default, and a
// staging deploy can point at its own URL without redeploying
// templates. Default tracks the live AGX domain.
function appUrl() {
  var u = process.env.APP_URL;
  if (typeof u === 'string' && /^https?:\/\//.test(u.trim())) {
    return u.trim().replace(/\/$/, '');
  }
  return 'https://wip-agxco.com';
}

// Default footer used by every template.
function footer() {
  var url = appUrl();
  var hostname = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return {
    html:
      '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">' +
        'AGX WIP Tracker &middot; <a href="' + url + '" style="color:#4f8cff;text-decoration:none;">' + hostname + '</a><br/>' +
        'You\'re receiving this because of activity on your AGX account. ' +
        'Toggle notifications in <strong>My Account &rarr; Notifications</strong>.' +
      '</div>',
    text:
      '\n\n— AGX WIP Tracker · ' + url + '\n' +
      'Manage notifications: app → My Account → Notifications.'
  };
}

function shell(title, bodyHtml) {
  return '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:10px;color:#1f2937;line-height:1.5;">' +
      '<div style="font-size:13px;font-weight:700;color:#4f8cff;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">AGX</div>' +
      '<h2 style="margin:0 0 16px 0;color:#111827;font-size:20px;">' + escapeHtml(title) + '</h2>' +
      bodyHtml +
      footer().html +
    '</div></body></html>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(n) {
  var v = Number(n || 0);
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtDate(iso) {
  if (!iso) return '';
  // Accept YYYY-MM-DD or full Date — return "Mon, Oct 5"
  var d = (iso instanceof Date) ? iso : new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ─── Templates ────────────────────────────────────────────────

// New user invite (admin → invitee)
//   Sent by /api/auth/register when admin creates a user. Carries the
//   credentials the admin chose so the invitee can log in immediately.
//   Recommendation in the body to change password on first login.
function newUserInvite({ name, email, password, invitedBy }) {
  var subject = 'You\'re invited to AGX WIP Tracker';
  var loginUrl = appUrl();
  var html = shell(
    'Welcome to AGX',
    '<p>Hi ' + escapeHtml(name || 'there') + ',</p>' +
    '<p>' + escapeHtml(invitedBy || 'An admin') + ' just created an account for you on the AGX WIP Tracker. ' +
      'You can sign in with the credentials below:</p>' +
    '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-family:monospace;font-size:13px;">' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Email</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(email) + '</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Password</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(password) + '</td></tr>' +
    '</table>' +
    '<p><a href="' + loginUrl + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Sign in</a></p>' +
    '<p style="color:#6b7280;font-size:13px;">For security, please change this password after your first login (Admin → Users → set new password).</p>'
  );
  var text = 'Welcome to AGX WIP Tracker.\n\n' +
    (invitedBy || 'An admin') + ' created an account for you.\n\n' +
    'Email: ' + email + '\n' +
    'Password: ' + password + '\n\n' +
    'Sign in: ' + loginUrl + '\n\n' +
    'Please change your password after your first login.' + footer().text;
  return { subject: subject, html: html, text: text };
}

// Password reset (admin reset on behalf of a user)
//   Sent by /api/auth/users/:id/password when admin sets a new password.
function passwordReset({ name, email, password, resetBy }) {
  var subject = 'Your AGX password was reset';
  var loginUrl = appUrl();
  var html = shell(
    'Password reset',
    '<p>Hi ' + escapeHtml(name || 'there') + ',</p>' +
    '<p>' + escapeHtml(resetBy || 'An admin') + ' has reset your AGX password. ' +
      'Use the credentials below to sign in:</p>' +
    '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-family:monospace;font-size:13px;">' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Email</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(email) + '</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">New password</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(password) + '</td></tr>' +
    '</table>' +
    '<p><a href="' + loginUrl + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Sign in</a></p>' +
    '<p style="color:#6b7280;font-size:13px;">If you didn\'t request this reset, contact the admin who issued it.</p>'
  );
  var text = 'Your AGX password was reset by ' + (resetBy || 'an admin') + '.\n\n' +
    'Email: ' + email + '\n' +
    'New password: ' + password + '\n\n' +
    'Sign in: ' + loginUrl + footer().text;
  return { subject: subject, html: html, text: text };
}

// Job assigned to PM (or reassigned)
//   Sent on POST /api/jobs creation OR when owner_id changes via the
//   bulk save path — only when the saving client opts in (notify
//   checkbox). Recipient is the new owner.
function jobAssigned({ recipientName, job, assignedBy, action }) {
  // action: "assigned" (new) | "reassigned" (changed)
  var subject = (action === 'reassigned' ? 'Reassigned: ' : 'New job: ') +
    (job.jobNumber || '') + ' — ' + (job.title || '(untitled)');
  var loginUrl = appUrl();
  var verb = action === 'reassigned' ? 'reassigned to you' : 'assigned to you';
  var html = shell(
    'Job ' + verb,
    '<p>Hi ' + escapeHtml(recipientName || 'there') + ',</p>' +
    '<p>' + escapeHtml(assignedBy || 'An admin') + ' just ' + verb + ' on AGX:</p>' +
    '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
      (job.jobNumber ? '<tr><td style="padding:4px 8px;color:#6b7280;">Job number</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(job.jobNumber) + '</td></tr>' : '') +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Title</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(job.title || '(untitled)') + '</td></tr>' +
      (job.client ? '<tr><td style="padding:4px 8px;color:#6b7280;">Client</td><td style="padding:4px 8px;">' + escapeHtml(job.client) + '</td></tr>' : '') +
      (job.community ? '<tr><td style="padding:4px 8px;color:#6b7280;">Community</td><td style="padding:4px 8px;">' + escapeHtml(job.community) + '</td></tr>' : '') +
      (job.contractAmount ? '<tr><td style="padding:4px 8px;color:#6b7280;">Contract</td><td style="padding:4px 8px;font-weight:600;color:#059669;">' + fmtMoney(job.contractAmount) + '</td></tr>' : '') +
      (job.status ? '<tr><td style="padding:4px 8px;color:#6b7280;">Status</td><td style="padding:4px 8px;">' + escapeHtml(job.status) + '</td></tr>' : '') +
    '</table>' +
    '<p><a href="' + loginUrl + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in AGX</a></p>'
  );
  var text = 'Job ' + verb + '.\n\n' +
    (job.jobNumber ? 'Job: ' + job.jobNumber + '\n' : '') +
    'Title: ' + (job.title || '(untitled)') + '\n' +
    (job.client ? 'Client: ' + job.client + '\n' : '') +
    (job.contractAmount ? 'Contract: ' + fmtMoney(job.contractAmount) + '\n' : '') +
    (job.status ? 'Status: ' + job.status + '\n' : '') +
    '\nOpen: ' + loginUrl + footer().text;
  return { subject: subject, html: html, text: text };
}

// Schedule entry: a crew member was assigned to a production day.
//   Sent on POST/PATCH /api/schedule when the saving client opts in
//   AND the crew array changed in a way that adds this user. Recipient
//   is each newly-added user.
function scheduleAssigned({ recipientName, entry, job, assignedBy }) {
  var startDate = entry.startDate || '';
  var subject = 'Scheduled: ' + (job ? (job.jobNumber || job.title || 'Job') : 'Job') +
    ' — ' + fmtDate(startDate);
  var loginUrl = appUrl();
  var dayPlural = (entry.days > 1) ? 'days' : 'day';
  var html = shell(
    'You\'ve been scheduled',
    '<p>Hi ' + escapeHtml(recipientName || 'there') + ',</p>' +
    '<p>' + escapeHtml(assignedBy || 'An admin') + ' just added you to a production schedule entry on AGX:</p>' +
    '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Job</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(job ? ((job.jobNumber || '') + ' — ' + (job.title || '')) : '(unknown)') + '</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Start date</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(fmtDate(startDate)) + '</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Days</td><td style="padding:4px 8px;font-weight:600;">' + (entry.days || 1) + ' ' + dayPlural +
        (entry.includesWeekends ? ' (incl. weekends)' : '') + '</td></tr>' +
      (entry.notes ? '<tr><td style="padding:4px 8px;color:#6b7280;">Notes</td><td style="padding:4px 8px;">' + escapeHtml(entry.notes) + '</td></tr>' : '') +
      (entry.status && entry.status !== 'planned' ? '<tr><td style="padding:4px 8px;color:#6b7280;">Status</td><td style="padding:4px 8px;">' + escapeHtml(entry.status) + '</td></tr>' : '') +
    '</table>' +
    '<p><a href="' + loginUrl + '#schedule" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open Schedule</a></p>'
  );
  var text = 'You\'ve been scheduled by ' + (assignedBy || 'an admin') + '.\n\n' +
    'Job: ' + (job ? ((job.jobNumber || '') + ' — ' + (job.title || '')) : '(unknown)') + '\n' +
    'Start: ' + fmtDate(startDate) + '\n' +
    'Days: ' + (entry.days || 1) + ' ' + dayPlural + (entry.includesWeekends ? ' (incl. weekends)' : '') + '\n' +
    (entry.notes ? 'Notes: ' + entry.notes + '\n' : '') +
    '\nOpen Schedule: ' + loginUrl + '#schedule' + footer().text;
  return { subject: subject, html: html, text: text };
}

// Sub assigned to job (sent to the sub's primary contact email)
//   Recipient learns they've been added to a job and at what contract amount.
//   Params shape: { sub: { name, primaryContactFirst }, job: { title, jobNumber },
//     contractAmt, assignedBy: { name } }
function subAssigned({ sub, job, contractAmt, assignedBy }) {
  sub = sub || {}; job = job || {}; assignedBy = assignedBy || {};
  var jobLabel = (job.jobNumber ? job.jobNumber + ' — ' : '') + (job.title || '(untitled)');
  var subject = 'Assigned to ' + jobLabel;
  var loginUrl = appUrl();
  var html = shell(
    'You\'ve been assigned to a job',
    '<p>Hi ' + escapeHtml(sub.primaryContactFirst || sub.name || 'there') + ',</p>' +
    '<p>' + escapeHtml(assignedBy.name || 'AGX') + ' just added <strong>' + escapeHtml(sub.name || 'your company') +
      '</strong> as a subcontractor on this AGX job:</p>' +
    '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
      (job.jobNumber ? '<tr><td style="padding:4px 8px;color:#6b7280;">Job number</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(job.jobNumber) + '</td></tr>' : '') +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Job</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(job.title || '(untitled)') + '</td></tr>' +
      (contractAmt ? '<tr><td style="padding:4px 8px;color:#6b7280;">Contract</td><td style="padding:4px 8px;font-weight:600;color:#059669;">' + fmtMoney(contractAmt) + '</td></tr>' : '') +
    '</table>' +
    '<p style="color:#6b7280;font-size:13px;">If you have questions about scope or schedule, reply to this email and we\'ll loop in the right person.</p>'
  );
  var text = (sub.primaryContactFirst || sub.name || 'Hi') + ',\n\n' +
    (assignedBy.name || 'AGX') + ' just assigned ' + (sub.name || 'your company') + ' to a job:\n\n' +
    (job.jobNumber ? 'Job number: ' + job.jobNumber + '\n' : '') +
    'Job: ' + (job.title || '(untitled)') + '\n' +
    (contractAmt ? 'Contract: ' + fmtMoney(contractAmt) + '\n' : '') +
    '\nReply with questions about scope or schedule.' + footer().text;
  return { subject: subject, html: html, text: text };
}

// Lead status → Sold (sent to the salesperson)
//   Variables: lead.title, lead.client_company, lead.estimated_revenue_high,
//   salesperson.name, changedBy.name
function leadStatusSold({ lead, salesperson, changedBy }) {
  lead = lead || {}; salesperson = salesperson || {}; changedBy = changedBy || {};
  var subject = '\u{1F389} Lead won: ' + (lead.title || '(untitled)');
  var loginUrl = appUrl();
  var html = shell(
    'Lead won — Sold',
    '<p>Hi ' + escapeHtml(salesperson.name || 'there') + ',</p>' +
    '<p>Congrats &mdash; <strong>' + escapeHtml(lead.title || '(untitled)') + '</strong> just flipped to ' +
      '<span style="color:#059669;font-weight:700;">Sold</span>.</p>' +
    '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Lead</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(lead.title || '') + '</td></tr>' +
      (lead.client_company ? '<tr><td style="padding:4px 8px;color:#6b7280;">Client</td><td style="padding:4px 8px;">' + escapeHtml(lead.client_company) + '</td></tr>' : '') +
      (lead.estimated_revenue_high ? '<tr><td style="padding:4px 8px;color:#6b7280;">Est. revenue</td><td style="padding:4px 8px;font-weight:600;color:#059669;">' + fmtMoney(lead.estimated_revenue_high) + '</td></tr>' : '') +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Marked by</td><td style="padding:4px 8px;">' + escapeHtml(changedBy.name || 'someone') + '</td></tr>' +
    '</table>' +
    '<p><a href="' + loginUrl + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in AGX</a></p>'
  );
  var text = (salesperson.name || 'Hi') + ',\n\n' +
    'Lead won! "' + (lead.title || '') + '" was just marked Sold by ' + (changedBy.name || 'someone') + '.\n\n' +
    (lead.client_company ? 'Client: ' + lead.client_company + '\n' : '') +
    (lead.estimated_revenue_high ? 'Est. revenue: ' + fmtMoney(lead.estimated_revenue_high) + '\n' : '') +
    '\nOpen: ' + loginUrl + footer().text;
  return { subject: subject, html: html, text: text };
}

// Lead status → Lost / No Opportunity (sent to the salesperson)
//   Variables: lead.title, lead.client_company, salesperson.name, changedBy.name, reason
function leadStatusLost({ lead, salesperson, changedBy, reason, status }) {
  lead = lead || {}; salesperson = salesperson || {}; changedBy = changedBy || {};
  // status param: 'lost' | 'no_opportunity' (drives the verb in subject line)
  var verb = status === 'no_opportunity' ? 'No opportunity' : 'Lost';
  var subject = verb + ': ' + (lead.title || '(untitled)');
  var loginUrl = appUrl();
  var html = shell(
    'Lead status: ' + verb,
    '<p>Hi ' + escapeHtml(salesperson.name || 'there') + ',</p>' +
    '<p><strong>' + escapeHtml(lead.title || '(untitled)') + '</strong> just flipped to ' +
      '<span style="color:#dc2626;font-weight:700;">' + escapeHtml(verb) + '</span>.</p>' +
    '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Lead</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(lead.title || '') + '</td></tr>' +
      (lead.client_company ? '<tr><td style="padding:4px 8px;color:#6b7280;">Client</td><td style="padding:4px 8px;">' + escapeHtml(lead.client_company) + '</td></tr>' : '') +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Marked by</td><td style="padding:4px 8px;">' + escapeHtml(changedBy.name || 'someone') + '</td></tr>' +
      (reason ? '<tr><td style="padding:4px 8px;color:#6b7280;">Reason / notes</td><td style="padding:4px 8px;">' + escapeHtml(reason) + '</td></tr>' : '') +
    '</table>' +
    '<p><a href="' + loginUrl + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in AGX</a></p>'
  );
  var text = (salesperson.name || 'Hi') + ',\n\n' +
    '"' + (lead.title || '') + '" was marked ' + verb + ' by ' + (changedBy.name || 'someone') + '.\n\n' +
    (lead.client_company ? 'Client: ' + lead.client_company + '\n' : '') +
    (reason ? 'Reason: ' + reason + '\n' : '') +
    '\nOpen: ' + loginUrl + footer().text;
  return { subject: subject, html: html, text: text };
}

// Certificate expiring (sent by daily cron to the sub primary contact)
//   Variables: sub.name, sub.primaryContactFirst, cert.type, cert.expirationDate, cert.daysUntilExpiry
//
// `cert.type` may arrive as the raw enum ('gl', 'wc', 'w9', 'bank') or
// the friendly label ('General Liability', etc.). Normalize so the
// email reads the same either way.
function certExpiring({ sub, cert }) {
  sub = sub || {}; cert = cert || {};
  var typeLabel = certTypeLabel(cert.type);
  var days = Number(cert.daysUntilExpiry);
  var urgency = isFinite(days) ?
    (days <= 0 ? '<span style="color:#dc2626;font-weight:700;">Already expired</span>' :
     days <= 7 ? '<span style="color:#dc2626;font-weight:700;">Expires in ' + days + ' day' + (days === 1 ? '' : 's') + '</span>' :
                 '<span style="color:#d97706;font-weight:600;">Expires in ' + days + ' days</span>') :
    'Expiring soon';
  var subject = 'Cert expiring: ' + typeLabel + ' (' + (sub.name || 'sub') + ')';
  var loginUrl = appUrl();
  var html = shell(
    typeLabel + ' certificate expiring',
    '<p>Hi ' + escapeHtml(sub.primaryContactFirst || sub.name || 'there') + ',</p>' +
    '<p>Your <strong>' + escapeHtml(typeLabel) + '</strong> certificate on file with AGX is approaching expiration.</p>' +
    '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Sub</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(sub.name || '') + '</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Certificate</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(typeLabel) + '</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Expiration date</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(fmtDate(cert.expirationDate)) + '</td></tr>' +
      '<tr><td style="padding:4px 8px;color:#6b7280;">Status</td><td style="padding:4px 8px;">' + urgency + '</td></tr>' +
    '</table>' +
    '<p>Please send an updated copy at your earliest convenience &mdash; reply to this email or use the button below.</p>' +
    '<p><a href="' + loginUrl + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in AGX</a></p>'
  );
  var text = (sub.primaryContactFirst || sub.name || 'Hi') + ',\n\n' +
    'Your ' + typeLabel + ' certificate on file with AGX is expiring.\n\n' +
    'Sub: ' + (sub.name || '') + '\n' +
    'Expiration: ' + fmtDate(cert.expirationDate) + '\n' +
    (isFinite(days) ? 'Days until expiry: ' + days + '\n' : '') +
    '\nPlease send an updated copy.\n' +
    'Open: ' + loginUrl + footer().text;
  return { subject: subject, html: html, text: text };
}

function certTypeLabel(t) {
  var key = String(t || '').toLowerCase();
  if (key === 'gl') return 'General Liability';
  if (key === 'wc') return 'Workers Comp';
  if (key === 'w9') return 'W-9';
  if (key === 'bank') return 'Bank / ACH';
  // Already a friendly label (admin-edited override or sample data) — pass through.
  return t || 'Certificate';
}

// ── Override resolution ─────────────────────────────────────────────
// Admins can customize template subject + body via the Email Templates
// admin sub-tab; overrides land in email_template_overrides keyed by
// event_key. render(eventKey, params) prefers the override (with
// {{path}} variable interpolation against params); falls back to the
// baked-in default if no override is saved.

const { pool } = require('./db');

async function getOverride(eventKey) {
  try {
    const { rows } = await pool.query(
      'SELECT subject, html_body FROM email_template_overrides WHERE event_key = $1',
      [eventKey]
    );
    return rows.length ? { subject: rows[0].subject, html_body: rows[0].html_body } : null;
  } catch (e) {
    console.warn('[email-templates] override lookup failed:', e.message);
    return null;
  }
}

// {{path.to.value}} interpolation — looks up dotted paths in params.
// Missing values render as empty string. Output IS escaped via
// escapeHtml since admin-edited text could otherwise smuggle HTML
// (intentional or accidental). Use {{{raw.path}}} for unescaped if
// the admin needs to embed HTML — but most templates don't need it.
function interpolate(str, params) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\{\{\{\s*([^}]+?)\s*\}\}\}/g, function(_, path) {
      var val = resolvePath(path, params);
      return val == null ? '' : String(val);
    })
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, function(_, path) {
      var val = resolvePath(path, params);
      return val == null ? '' : escapeHtml(String(val));
    });
}

function resolvePath(path, obj) {
  return path.split('.').reduce(function(o, k) {
    return (o && o[k] != null) ? o[k] : null;
  }, obj);
}

// Strip HTML to plain text for the text/plain fallback when rendering
// an override. Cheap regex-based, not bulletproof — fine for the
// kinds of HTML admins write in the editor.
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Defaults dispatch — call the baked-in template for an event.
function renderDefault(eventKey, params) {
  switch (eventKey) {
    case 'user_invite':       return newUserInvite(params);
    case 'password_reset':    return passwordReset(params);
    case 'job_assigned':      return jobAssigned(params);
    case 'schedule_entry':    return scheduleAssigned(params);
    case 'sub_assigned':      return subAssigned(params);
    case 'lead_status_sold':  return leadStatusSold(params);
    case 'lead_status_lost':  return leadStatusLost(params);
    case 'cert_expiring':     return certExpiring(params);
    default:
      throw new Error('No baked-in template for event: ' + eventKey);
  }
}

// Public render — preferred call site for sending. Routes pass the
// event key + params; this function does override-or-default
// dispatch and returns { subject, html, text }.
//
// Override behavior: the admin's html_body is rendered AS-IS — no
// AGX shell wrap, no auto footer. Whatever the admin wrote is the
// entire email body. {{appUrl}} is auto-injected into params so
// links can resolve without the admin pasting the literal URL.
//
// Partial overrides: if html_body is empty, fall back to the
// default body. Same for subject. Lets an admin tweak just the
// subject or just the body without retyping the rest.
async function render(eventKey, params) {
  // Auto-inject appUrl so {{appUrl}} works in admin-edited templates.
  params = Object.assign({ appUrl: appUrl() }, params || {});

  var override = await getOverride(eventKey);
  if (!override || (!override.subject && !override.html_body)) {
    return renderDefault(eventKey, params);
  }

  var def = null;
  if (!override.subject || !override.html_body) {
    try { def = renderDefault(eventKey, params); } catch (e) { def = null; }
  }

  var subject = override.subject
    ? interpolate(override.subject, params)
    : (def && def.subject) || '(no subject)';
  var bodyHtml = override.html_body
    ? interpolate(override.html_body, params)
    : (def && def.html) || '';

  return {
    subject: subject || '(no subject)',
    html: bodyHtml,
    text: htmlToText(bodyHtml)
  };
}

// Sample params for each event — used by the Email Templates editor
// for live preview rendering before any real data exists.
function sampleParams(eventKey) {
  switch (eventKey) {
    case 'user_invite':
      return { name: 'Jane Smith', email: 'jane@example.com', password: 'temp-pass-123', invitedBy: 'John AGX' };
    case 'password_reset':
      return { name: 'Jane Smith', email: 'jane@example.com', password: 'new-pass-123', resetBy: 'John AGX' };
    case 'job_assigned':
      return { recipientName: 'Jane Smith', job: { title: 'Madeira Bay Restoration', jobNumber: 'S2245', client: 'Madeira Bay HOA', contractAmount: 125000, status: 'In Progress' }, assignedBy: 'John AGX', action: 'assigned' };
    case 'schedule_entry':
      return { recipientName: 'Mike Crew', entry: { startDate: '2026-05-10', days: 3, includesWeekends: false, notes: 'Bring scaffold' }, job: { title: 'Madeira Bay Restoration', jobNumber: 'S2245' }, assignedBy: 'John AGX' };
    case 'sub_assigned':
      return { sub: { name: 'Summit Sealants', primaryContactFirst: 'Mike' }, job: { title: 'Madeira Bay Restoration', jobNumber: 'S2245' }, contractAmt: 12500, assignedBy: { name: 'John AGX' } };
    case 'lead_status_sold':
      return { lead: { title: 'Solace Powerwash', client_company: 'Solace Communities', estimated_revenue_high: 18000 }, salesperson: { name: 'Jane Smith' }, changedBy: { name: 'John AGX' } };
    case 'lead_status_lost':
      return { lead: { title: 'Solace Powerwash', client_company: 'Solace Communities' }, salesperson: { name: 'Jane Smith' }, changedBy: { name: 'John AGX' }, reason: 'Lost to competitor' };
    case 'cert_expiring':
      return { sub: { name: 'Summit Sealants', primaryContactFirst: 'Mike' }, cert: { type: 'General Liability', expirationDate: '2026-05-15', daysUntilExpiry: 12 } };
    default: return {};
  }
}

// Render with sample data — used by the editor's Preview pane and
// "Reset to default" button.
async function renderSample(eventKey) {
  return render(eventKey, sampleParams(eventKey));
}

// Render the baked-in default with sample data — used by "Reset to
// default" button to show the admin what the original looks like
// (bypasses any saved override).
function renderSampleDefault(eventKey) {
  return renderDefault(eventKey, sampleParams(eventKey));
}

module.exports = {
  newUserInvite,
  passwordReset,
  jobAssigned,
  scheduleAssigned,
  subAssigned,
  leadStatusSold,
  leadStatusLost,
  certExpiring,
  certTypeLabel,
  render,
  renderSample,
  renderSampleDefault,
  sampleParams,
  interpolate,
  htmlToText
};
