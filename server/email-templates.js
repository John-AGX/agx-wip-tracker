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
// localhost in dev, the Railway domain by default, and a future
// custom domain (e.g. https://wip-agxco.com) when the user
// promotes one without redeploying templates. Defaults to the
// Railway URL we shipped originally.
function appUrl() {
  var u = process.env.APP_URL;
  if (typeof u === 'string' && /^https?:\/\//.test(u.trim())) {
    return u.trim().replace(/\/$/, '');
  }
  return 'https://wip.up.railway.app';
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

module.exports = {
  newUserInvite,
  passwordReset,
  jobAssigned,
  scheduleAssigned
};
