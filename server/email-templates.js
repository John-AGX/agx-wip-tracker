// Project 86 transactional email templates.
//
// Each event has a single source-of-truth: TEMPLATE_SOURCES[eventKey].
// The source is plain HTML / text with {{variable}} placeholders. The
// renderer interpolates real values into the placeholders and returns
// the email. Admin overrides (Email Templates UI) edit the SAME source
// shape — what an admin sees in the editor is exactly what the
// pipeline renders against.
//
// Variable interpolation:
//   {{path.to.value}}    — HTML-escaped (safe for body text)
//   {{{path.to.value}}}  — raw, not escaped (use for pre-rendered HTML
//                          fragments produced by enrichParams below)
//
// Helpers like cert urgency badges, job detail rows, formatted money,
// etc. that used to live as JS string concatenation are pre-computed
// in enrichParams() and exposed to templates as triple-brace raw
// fragments. Admins can either keep using them or replace with their
// own HTML.

const { pool } = require('./db');
const { getEvent } = require('./email-events');

// ─── Tiny utilities ────────────────────────────────────────────────

// Public app URL used by every email's "Sign in" / "Open" button.
// APP_URL env wins; the fallback tracks the live Project 86 domain.
// Set APP_URL in Railway to override (e.g., during a domain swap or
// when the trial-vs-prod hostnames diverge).
function appUrl() {
  var u = process.env.APP_URL;
  if (typeof u === 'string' && /^https?:\/\//.test(u.trim())) {
    return u.trim().replace(/\/$/, '');
  }
  return 'https://project86.net';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Escape a value for use inside a double-quoted HTML attribute (src, href,
// alt, …). Was referenced by renderBlock() but never defined — its absence
// threw a ReferenceError on every block-mode render (header logo / button /
// image / footer), so block emails were failing. Defined here.
function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtMoney(n) {
  var v = Number(n || 0);
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtDate(iso) {
  if (!iso) return '';
  var d = (iso instanceof Date) ? iso : new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

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

function certTypeLabel(t) {
  var key = String(t || '').toLowerCase();
  if (key === 'gl') return 'General Liability';
  if (key === 'wc') return 'Workers Comp';
  if (key === 'w9') return 'W-9';
  if (key === 'bank') return 'Bank / ACH';
  return t || 'Certificate';
}

// ─── Shared shell — used as a starter for every template source so
// admins can pull the same HTML scaffold into their override. The
// templates below inline this content rather than calling shell() at
// render time, so an admin who edits the template can also edit the
// header logo, footer, etc. without code changes.

// ─── Template sources ──────────────────────────────────────────────
// Each entry: { subject, html_body }. All variables come from the
// per-event params (with enrichParams() pre-computing helpers like
// urgency badges) plus the auto-injected appUrl + appUrlHost.

var COMMON_FOOTER = (
  '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;font-size:12px;color:#6b7280;">' +
    '<img src="{{appUrl}}/images/logo-p86-email.png" alt="Project 86" style="height:22px;display:inline-block;margin-bottom:8px;" /><br/>' +
    'Powered by <a href="{{appUrl}}" style="color:#6b7280;text-decoration:none;">Project 86</a> &middot; {{appUrlHost}}<br/>' +
    'You\'re receiving this because of activity on your Project 86 account. ' +
    'Toggle notifications in <strong>My Account &rarr; Notifications</strong>.' +
  '</div>'
);

function shellWrap(title, bodyHtml) {
  return (
    '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">' +
      '<div style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:10px;color:#1f2937;line-height:1.5;">' +
        // Project 86 logo. Email clients fetch this via absolute URL since the
        // email is rendered outside our domain. {{appUrl}} resolves at
        // render time so dev/staging/prod each load the right image.
        '<div style="margin-bottom:12px;"><img src="{{appUrl}}/images/logo-p86-email.png" alt="Project 86" style="height:40px;display:block;" /></div>' +
        '<h2 style="margin:0 0 16px 0;color:#111827;font-size:20px;">' + title + '</h2>' +
        bodyHtml +
        COMMON_FOOTER +
      '</div>' +
    '</body></html>'
  );
}

var TEMPLATE_SOURCES = {

  org_invite: {
    subject: 'You\'re invited to join {{platform_name}}',
    // Wave 3 — block-based default. The visual editor opens this in
    // block mode out of the box. Legacy raw-HTML fallback (html_body)
    // mirrors the old shape so any consumer that ignores .blocks
    // (older render paths) still works.
    blocks: [
      { type: 'header', title: 'Welcome to {{platform_name}}', subtitle: 'You\'ve been invited' },
      { type: 'text', html: '<p>Hi,</p><p><strong>{{invited_by}}</strong> has invited you to set up <strong>{{org_name}}</strong> on {{platform_name}}. Click the button below to claim your organization, set a password, and start using the platform.</p>' },
      { type: 'button', label: 'Accept invitation & get started', url: '{{accept_url}}', bg_color: '#4f8cff' },
      { type: 'spacer', height_px: 8 },
      { type: 'text', html: '<p>This invitation expires on <strong>{{expires_at}}</strong>. If the button doesn\'t work, paste this link into your browser:</p><p><a href="{{accept_url}}">{{accept_url}}</a></p><p>If you weren\'t expecting this invitation, you can safely ignore this email.</p>' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('Welcome to {{platform_name}}',
      '<p>Hi,</p>' +
      '<p><strong>{{invited_by}}</strong> has invited you to set up <strong>{{org_name}}</strong> on {{platform_name}}. ' +
        'Click the button below to claim your organization, set a password, and start using the platform.</p>' +
      '<p><a href="{{accept_url}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;font-size:15px;">Accept invitation &amp; get started</a></p>' +
      '<p style="color:#6b7280;font-size:13px;">This invitation expires on <strong>{{expires_at}}</strong>. ' +
        'If the button doesn\'t work, paste this link into your browser:<br/>' +
        '<a href="{{accept_url}}" style="color:#4f8cff;word-break:break-all;">{{accept_url}}</a></p>' +
      '<p style="color:#6b7280;font-size:13px;">If you weren\'t expecting this invitation, you can safely ignore this email.</p>'
    )
  },

  user_invite: {
    subject: 'You\'re invited to Project 86',
    blocks: [
      { type: 'header', title: 'Welcome to Project 86', subtitle: 'Your account is ready' },
      { type: 'text', html: '<p>Hi {{name}},</p><p>{{invitedBy}} just created an account for you on Project 86. You can sign in with the credentials below:</p><p><strong>Email:</strong> {{email}}<br/><strong>Password:</strong> {{password}}</p>' },
      { type: 'button', label: 'Sign in', url: '{{appUrl}}', bg_color: '#4f8cff' },
      { type: 'text', html: '<p>For security, please change this password after your first login (Admin → Users → set new password).</p>' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('Welcome to Project 86',
      '<p>Hi {{name}},</p>' +
      '<p>{{invitedBy}} just created an account for you on Project 86. ' +
        'You can sign in with the credentials below:</p>' +
      '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-family:monospace;font-size:13px;">' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Email</td><td style="padding:4px 8px;font-weight:600;">{{email}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Password</td><td style="padding:4px 8px;font-weight:600;">{{password}}</td></tr>' +
      '</table>' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Sign in</a></p>' +
      '<p style="color:#6b7280;font-size:13px;">For security, please change this password after your first login (Admin &rarr; Users &rarr; set new password).</p>'
    )
  },

  password_reset: {
    subject: 'Your Project 86 password was reset',
    blocks: [
      { type: 'header', title: 'Password reset', subtitle: 'Your password was changed' },
      { type: 'text', html: '<p>Hi {{name}},</p><p>{{resetBy}} has reset your Project 86 password. Use the credentials below to sign in:</p><p><strong>Email:</strong> {{email}}<br/><strong>New password:</strong> {{password}}</p>' },
      { type: 'button', label: 'Sign in', url: '{{appUrl}}', bg_color: '#4f8cff' },
      { type: 'text', html: '<p>If you didn\'t request this reset, contact the admin who issued it.</p>' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('Password reset',
      '<p>Hi {{name}},</p>' +
      '<p>{{resetBy}} has reset your Project 86 password. Use the credentials below to sign in:</p>' +
      '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-family:monospace;font-size:13px;">' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Email</td><td style="padding:4px 8px;font-weight:600;">{{email}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">New password</td><td style="padding:4px 8px;font-weight:600;">{{password}}</td></tr>' +
      '</table>' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Sign in</a></p>' +
      '<p style="color:#6b7280;font-size:13px;">If you didn\'t request this reset, contact the admin who issued it.</p>'
    )
  },

  job_assigned: {
    subject: '{{subjectAction}}: {{job.jobNumber}} — {{job.title}}',
    // Wave 4 — block-based default. Note: the detail "rows" used to
    // live in a <table> with conditional rows via {{{detailsRowsHtml}}}.
    // In block form we capture the canonical fields in a single text
    // block; admins who want richer per-row control can switch to
    // HTML mode.
    blocks: [
      { type: 'header', title: 'Job {{verb}}' },
      { type: 'text', html: '<p>Hi {{recipientName}},</p><p><strong>{{assignedBy}}</strong> just {{verb}} on Project 86.</p>' },
      { type: 'text', html: '<p><strong>Job #:</strong> {{job.jobNumber}}<br><strong>Title:</strong> {{job.title}}<br><strong>Client:</strong> {{job.client}}<br><strong>Status:</strong> {{job.status}}</p>' },
      { type: 'button', label: 'Open in Project 86', url: '{{appUrl}}', bg_color: '#4f8cff' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('Job {{verb}}',
      '<p>Hi {{recipientName}},</p>' +
      '<p>{{assignedBy}} just {{verb}} on Project 86:</p>' +
      '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
        '{{{job.detailsRowsHtml}}}' +
      '</table>' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in Project 86</a></p>'
    )
  },

  schedule_entry: {
    subject: 'Scheduled: {{job.jobLabel}} — {{entry.startDateFmt}}',
    blocks: [
      { type: 'header', title: 'You\'ve been scheduled' },
      { type: 'text', html: '<p>Hi {{recipientName}},</p><p><strong>{{assignedBy}}</strong> just added you to a production schedule entry on Project 86.</p>' },
      { type: 'text', html: '<p><strong>Job:</strong> {{job.jobLabel}}<br><strong>Start date:</strong> {{entry.startDateFmt}}<br><strong>Days:</strong> {{entry.daysLabel}}</p>' },
      { type: 'button', label: 'Open Schedule', url: '{{appUrl}}#schedule', bg_color: '#4f8cff' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('You\'ve been scheduled',
      '<p>Hi {{recipientName}},</p>' +
      '<p>{{assignedBy}} just added you to a production schedule entry on Project 86:</p>' +
      '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Job</td><td style="padding:4px 8px;font-weight:600;">{{job.jobLabel}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Start date</td><td style="padding:4px 8px;font-weight:600;">{{entry.startDateFmt}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Days</td><td style="padding:4px 8px;font-weight:600;">{{entry.daysLabel}}</td></tr>' +
        '{{{entry.notesRowHtml}}}' +
      '</table>' +
      '<p><a href="{{appUrl}}#schedule" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open Schedule</a></p>'
    )
  },

  sub_assigned: {
    subject: 'Assigned to {{job.jobLabel}}',
    blocks: [
      { type: 'header', title: 'You\'ve been assigned to a job' },
      { type: 'text', html: '<p>Hi {{sub.greetingName}},</p><p>{{assignedBy.name}} just added <strong>{{sub.name}}</strong> as a subcontractor on this Project 86 job:</p>' },
      { type: 'text', html: '<p><strong>Job #:</strong> {{job.jobNumber}}<br><strong>Job:</strong> {{job.title}}</p>' },
      { type: 'text', html: '<p>If you have questions about scope or schedule, reply to this email and we\'ll loop in the right person.</p>' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('You\'ve been assigned to a job',
      '<p>Hi {{sub.greetingName}},</p>' +
      '<p>{{assignedBy.name}} just added <strong>{{sub.name}}</strong> as a subcontractor on this Project 86 job:</p>' +
      '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Job number</td><td style="padding:4px 8px;font-weight:600;">{{job.jobNumber}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Job</td><td style="padding:4px 8px;font-weight:600;">{{job.title}}</td></tr>' +
        '{{{contractRowHtml}}}' +
      '</table>' +
      '<p style="color:#6b7280;font-size:13px;">If you have questions about scope or schedule, reply to this email and we\'ll loop in the right person.</p>'
    )
  },

  lead_status_sold: {
    subject: '\u{1F389} Lead won: {{lead.title}}',
    blocks: [
      { type: 'header', title: 'Lead won — Sold' },
      { type: 'text', html: '<p>Hi {{salesperson.name}},</p><p>Congrats — <strong>{{lead.title}}</strong> just flipped to <strong>Sold</strong>.</p>' },
      { type: 'text', html: '<p><strong>Lead:</strong> {{lead.title}}<br><strong>Client:</strong> {{lead.client_company}}<br><strong>Est. revenue:</strong> {{lead.estimatedRevenueFmt}}<br><strong>Marked by:</strong> {{changedBy.name}}</p>' },
      { type: 'button', label: 'Open in Project 86', url: '{{appUrl}}', bg_color: '#059669' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('Lead won — Sold',
      '<p>Hi {{salesperson.name}},</p>' +
      '<p>Congrats &mdash; <strong>{{lead.title}}</strong> just flipped to ' +
        '<span style="color:#059669;font-weight:700;">Sold</span>.</p>' +
      '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Lead</td><td style="padding:4px 8px;font-weight:600;">{{lead.title}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Client</td><td style="padding:4px 8px;">{{lead.client_company}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Est. revenue</td><td style="padding:4px 8px;font-weight:600;color:#059669;">{{lead.estimatedRevenueFmt}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Marked by</td><td style="padding:4px 8px;">{{changedBy.name}}</td></tr>' +
      '</table>' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in Project 86</a></p>'
    )
  },

  lead_status_lost: {
    subject: '{{statusLabel}}: {{lead.title}}',
    blocks: [
      { type: 'header', title: 'Lead status: {{statusLabel}}' },
      { type: 'text', html: '<p>Hi {{salesperson.name}},</p><p><strong>{{lead.title}}</strong> just flipped to <strong>{{statusLabel}}</strong>.</p>' },
      { type: 'text', html: '<p><strong>Lead:</strong> {{lead.title}}<br><strong>Client:</strong> {{lead.client_company}}<br><strong>Marked by:</strong> {{changedBy.name}}<br><strong>Reason:</strong> {{reason}}</p>' },
      { type: 'button', label: 'Open in Project 86', url: '{{appUrl}}', bg_color: '#4f8cff' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('Lead status: {{statusLabel}}',
      '<p>Hi {{salesperson.name}},</p>' +
      '<p><strong>{{lead.title}}</strong> just flipped to ' +
        '<span style="color:#dc2626;font-weight:700;">{{statusLabel}}</span>.</p>' +
      '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Lead</td><td style="padding:4px 8px;font-weight:600;">{{lead.title}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Client</td><td style="padding:4px 8px;">{{lead.client_company}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Marked by</td><td style="padding:4px 8px;">{{changedBy.name}}</td></tr>' +
        '{{{reasonRowHtml}}}' +
      '</table>' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in Project 86</a></p>'
    )
  },

  // ── Weekly digests (Wave 8) ─────────────────────────────────────
  weekly_digest_pm: {
    subject: 'Your weekly digest — {{week_label}}',
    blocks: [
      { type: 'header', title: 'Your week at a glance', subtitle: '{{week_label}}' },
      { type: 'text', html: '<p>Hi {{recipientName}},</p><p>Here\'s what happened on your jobs this week and what\'s coming up next.</p>' },
      { type: 'text', html: '<p><strong>Jobs touched this week:</strong> {{jobsTouchedCount}}</p>{{{jobsTouchedListHtml}}}' },
      { type: 'text', html: '<p><strong>Coming up next week:</strong> {{scheduleNextWeekCount}} schedule entries</p>{{{scheduleNextWeekListHtml}}}' },
      { type: 'button', label: 'Open Project 86', url: '{{appUrl}}', bg_color: '#4f8cff' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('Your week at a glance',
      '<p>Hi {{recipientName}},</p>' +
      '<p>Jobs touched this week: <strong>{{jobsTouchedCount}}</strong></p>' +
      '{{{jobsTouchedListHtml}}}' +
      '<p>Coming up next week: <strong>{{scheduleNextWeekCount}}</strong> schedule entries</p>' +
      '{{{scheduleNextWeekListHtml}}}' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open Project 86</a></p>'
    )
  },

  weekly_digest_sales: {
    subject: 'Sales digest — {{week_label}}',
    blocks: [
      { type: 'header', title: 'Sales recap', subtitle: '{{week_label}}' },
      { type: 'text', html: '<p>Hi {{recipientName}},</p><p>A quick rollup of your week:</p>' },
      { type: 'text', html: '<p><strong>Leads progressed:</strong> {{leadsProgressedCount}}<br><strong>Leads won (Sold):</strong> {{leadsWonCount}}<br><strong>Estimates sent:</strong> {{estimatesSentCount}}</p>' },
      { type: 'text', html: '{{{leadsProgressedListHtml}}}' },
      { type: 'button', label: 'Open pipeline', url: '{{appUrl}}', bg_color: '#059669' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('Sales recap — {{week_label}}',
      '<p>Hi {{recipientName}},</p>' +
      '<p>Leads progressed: <strong>{{leadsProgressedCount}}</strong> · Won: <strong>{{leadsWonCount}}</strong> · Estimates sent: <strong>{{estimatesSentCount}}</strong></p>' +
      '{{{leadsProgressedListHtml}}}' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open pipeline</a></p>'
    )
  },

  weekly_digest_ops: {
    subject: 'Ops digest — {{week_label}}',
    blocks: [
      { type: 'header', title: 'Operations digest', subtitle: '{{week_label}}' },
      { type: 'text', html: '<p>Hi {{recipientName}},</p><p>Heads-up for the week ahead:</p>' },
      { type: 'text', html: '<p><strong>Certificates expiring soon:</strong> {{certsExpiringCount}}</p>{{{certsExpiringListHtml}}}' },
      { type: 'text', html: '<p><strong>Jobs starting next week:</strong> {{jobsStartingNextWeekCount}}</p>' },
      { type: 'button', label: 'Open Project 86', url: '{{appUrl}}', bg_color: '#4f8cff' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('Operations digest — {{week_label}}',
      '<p>Hi {{recipientName}},</p>' +
      '<p>Certificates expiring soon: <strong>{{certsExpiringCount}}</strong></p>' +
      '{{{certsExpiringListHtml}}}' +
      '<p>Jobs starting next week: <strong>{{jobsStartingNextWeekCount}}</strong></p>' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open Project 86</a></p>'
    )
  },

  cert_expiring: {
    subject: 'Cert expiring: {{cert.typeLabel}} ({{sub.name}})',
    blocks: [
      { type: 'header', title: '{{cert.typeLabel}} certificate expiring' },
      { type: 'text', html: '<p>Hi {{sub.greetingName}},</p><p>Your <strong>{{cert.typeLabel}}</strong> certificate on file with Project 86 is approaching expiration.</p>' },
      { type: 'text', html: '<p><strong>Sub:</strong> {{sub.name}}<br><strong>Certificate:</strong> {{cert.typeLabel}}<br><strong>Expiration date:</strong> {{cert.expirationDateFmt}}</p>' },
      { type: 'text', html: '<p>Please send an updated copy at your earliest convenience — reply to this email or use the button below.</p>' },
      { type: 'button', label: 'Open in Project 86', url: '{{appUrl}}', bg_color: '#4f8cff' },
      { type: 'footer', address: 'Project 86' }
    ],
    html_body: shellWrap('{{cert.typeLabel}} certificate expiring',
      '<p>Hi {{sub.greetingName}},</p>' +
      '<p>Your <strong>{{cert.typeLabel}}</strong> certificate on file with Project 86 is approaching expiration.</p>' +
      '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Sub</td><td style="padding:4px 8px;font-weight:600;">{{sub.name}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Certificate</td><td style="padding:4px 8px;font-weight:600;">{{cert.typeLabel}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Expiration date</td><td style="padding:4px 8px;font-weight:600;">{{cert.expirationDateFmt}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Status</td><td style="padding:4px 8px;">{{{cert.urgencyHtml}}}</td></tr>' +
      '</table>' +
      '<p>Please send an updated copy at your earliest convenience &mdash; reply to this email or use the button below.</p>' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in Project 86</a></p>'
    )
  }

};

// ─── Param enrichment ──────────────────────────────────────────────
// Every render path goes through enrichParams() which pre-computes
// display helpers (formatted dates, money, conditional row HTML, etc.)
// so the source string only has simple {{paths}} to interpolate.
function enrichParams(eventKey, raw) {
  var p = Object.assign({}, raw || {});
  // Globals every template gets.
  if (!p.appUrl) p.appUrl = appUrl();
  p.appUrlHost = String(p.appUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

  // Wave 8 — digest defaults. The cron does the real data assembly
  // (in weekly-digest-cron.js) and passes the full {{listHtml}}
  // strings as triple-brace raw HTML. enrichParams just covers the
  // greeting + week_label + zero defaults so live preview renders
  // sensibly even before the cron has run.
  if (eventKey === 'weekly_digest_pm' || eventKey === 'weekly_digest_sales' || eventKey === 'weekly_digest_ops') {
    if (!p.recipientName) p.recipientName = 'there';
    if (!p.week_label) {
      var now = new Date();
      p.week_label = now.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    }
    if (p.jobsTouchedCount == null) p.jobsTouchedCount = 0;
    if (p.jobsTouchedListHtml == null) p.jobsTouchedListHtml = '';
    if (p.scheduleNextWeekCount == null) p.scheduleNextWeekCount = 0;
    if (p.scheduleNextWeekListHtml == null) p.scheduleNextWeekListHtml = '';
    if (p.leadsProgressedCount == null) p.leadsProgressedCount = 0;
    if (p.leadsProgressedListHtml == null) p.leadsProgressedListHtml = '';
    if (p.leadsWonCount == null) p.leadsWonCount = 0;
    if (p.estimatesSentCount == null) p.estimatesSentCount = 0;
    if (p.certsExpiringCount == null) p.certsExpiringCount = 0;
    if (p.certsExpiringListHtml == null) p.certsExpiringListHtml = '';
    if (p.jobsStartingNextWeekCount == null) p.jobsStartingNextWeekCount = 0;
  }
  if (eventKey === 'org_invite') {
    if (!p.platform_name) p.platform_name = 'Project 86';
    if (!p.invited_by) p.invited_by = 'A system admin';
    if (!p.org_name) p.org_name = 'your organization';
    // accept_url + expires_at come from the caller; we pre-format
    // expires_at for the email body (e.g. "Tuesday, May 27, 2026").
    // Callers pass ISO STRINGS ('2026-06-15T00:00:00Z') — the old
    // non-string-only check skipped those, so recipients saw the raw
    // timestamp. Format anything that parses as a date; a value that
    // doesn't parse (e.g. 'in 7 days') passes through untouched.
    if (p.expires_at) {
      try {
        var expDate = new Date(p.expires_at);
        if (!isNaN(expDate.getTime())) {
          p.expires_at = expDate.toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
          });
        }
      } catch (e) { /* leave as-is */ }
    } else {
      p.expires_at = 'in 7 days';
    }
    if (!p.accept_url) p.accept_url = appUrl();
  }
  if (eventKey === 'user_invite') {
    if (!p.invitedBy) p.invitedBy = 'An admin';
    if (!p.name) p.name = 'there';
  }
  if (eventKey === 'password_reset') {
    if (!p.resetBy) p.resetBy = 'An admin';
    if (!p.name) p.name = 'there';
  }
  if (eventKey === 'job_assigned') {
    if (!p.recipientName) p.recipientName = 'there';
    if (!p.assignedBy) p.assignedBy = 'An admin';
    var action = p.action || 'assigned';
    p.verb = action === 'reassigned' ? 'reassigned to you' : 'assigned to you';
    p.subjectAction = action === 'reassigned' ? 'Reassigned' : 'New job';
    var job = p.job || {};
    var rows = '';
    if (job.jobNumber) rows += '<tr><td style="padding:4px 8px;color:#6b7280;">Job number</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(job.jobNumber) + '</td></tr>';
    rows += '<tr><td style="padding:4px 8px;color:#6b7280;">Title</td><td style="padding:4px 8px;font-weight:600;">' + escapeHtml(job.title || '(untitled)') + '</td></tr>';
    if (job.client) rows += '<tr><td style="padding:4px 8px;color:#6b7280;">Client</td><td style="padding:4px 8px;">' + escapeHtml(job.client) + '</td></tr>';
    if (job.community) rows += '<tr><td style="padding:4px 8px;color:#6b7280;">Community</td><td style="padding:4px 8px;">' + escapeHtml(job.community) + '</td></tr>';
    if (job.contractAmount) rows += '<tr><td style="padding:4px 8px;color:#6b7280;">Contract</td><td style="padding:4px 8px;font-weight:600;color:#059669;">' + fmtMoney(job.contractAmount) + '</td></tr>';
    if (job.status) rows += '<tr><td style="padding:4px 8px;color:#6b7280;">Status</td><td style="padding:4px 8px;">' + escapeHtml(job.status) + '</td></tr>';
    p.job = Object.assign({}, job, { detailsRowsHtml: rows });
  }
  if (eventKey === 'schedule_entry') {
    if (!p.recipientName) p.recipientName = 'there';
    if (!p.assignedBy) p.assignedBy = 'An admin';
    var entry = p.entry || {};
    var days = entry.days || 1;
    var dayPlural = days > 1 ? 'days' : 'day';
    var weekendNote = entry.includesWeekends ? ' (incl. weekends)' : '';
    var notesHtml = entry.notes ? '<tr><td style="padding:4px 8px;color:#6b7280;">Notes</td><td style="padding:4px 8px;">' + escapeHtml(entry.notes) + '</td></tr>' : '';
    p.entry = Object.assign({}, entry, {
      startDateFmt: fmtDate(entry.startDate),
      daysLabel: days + ' ' + dayPlural + weekendNote,
      notesRowHtml: notesHtml
    });
    var j = p.job || {};
    p.job = Object.assign({}, j, { jobLabel: ((j.jobNumber || '') + ' — ' + (j.title || '')).trim() });
  }
  if (eventKey === 'sub_assigned') {
    var s = p.sub || {};
    p.sub = Object.assign({}, s, { greetingName: s.primaryContactFirst || s.name || 'there' });
    var ja = p.job || {};
    p.job = Object.assign({}, ja, { jobLabel: (ja.jobNumber ? ja.jobNumber + ' — ' : '') + (ja.title || '(untitled)') });
    if (!p.assignedBy) p.assignedBy = { name: 'Project 86' };
    if (p.contractAmt) {
      p.contractAmtFmt = fmtMoney(p.contractAmt);
      p.contractRowHtml = '<tr><td style="padding:4px 8px;color:#6b7280;">Contract</td><td style="padding:4px 8px;font-weight:600;color:#059669;">' + fmtMoney(p.contractAmt) + '</td></tr>';
    } else {
      p.contractAmtFmt = '';
      p.contractRowHtml = '';
    }
  }
  if (eventKey === 'lead_status_sold') {
    var lead = p.lead || {};
    p.lead = Object.assign({}, lead, {
      estimatedRevenueFmt: lead.estimated_revenue_high ? fmtMoney(lead.estimated_revenue_high) : ''
    });
    if (!p.salesperson) p.salesperson = { name: 'there' };
    if (!p.changedBy) p.changedBy = { name: 'someone' };
  }
  if (eventKey === 'lead_status_lost') {
    var lead2 = p.lead || {};
    p.lead = Object.assign({}, lead2);
    if (!p.salesperson) p.salesperson = { name: 'there' };
    if (!p.changedBy) p.changedBy = { name: 'someone' };
    p.statusLabel = p.status === 'no_opportunity' ? 'No opportunity' : 'Lost';
    p.reasonRowHtml = p.reason
      ? '<tr><td style="padding:4px 8px;color:#6b7280;">Reason / notes</td><td style="padding:4px 8px;">' + escapeHtml(p.reason) + '</td></tr>'
      : '';
  }
  if (eventKey === 'cert_expiring') {
    var cert = p.cert || {};
    var typeLabel = certTypeLabel(cert.type);
    var d = Number(cert.daysUntilExpiry);
    var urgency = isFinite(d)
      ? (d <= 0
          ? '<span style="color:#dc2626;font-weight:700;">Already expired</span>'
          : (d <= 7
              ? '<span style="color:#dc2626;font-weight:700;">Expires in ' + d + ' day' + (d === 1 ? '' : 's') + '</span>'
              : '<span style="color:#d97706;font-weight:600;">Expires in ' + d + ' days</span>'))
      : 'Expiring soon';
    p.cert = Object.assign({}, cert, {
      typeLabel: typeLabel,
      expirationDateFmt: fmtDate(cert.expirationDate),
      urgencyHtml: urgency
    });
    var sb = p.sub || {};
    p.sub = Object.assign({}, sb, { greetingName: sb.primaryContactFirst || sb.name || 'there' });
  }
  return p;
}

// ─── Override resolution ───────────────────────────────────────────

// Override lookup. When orgId is provided, prefers the org-scoped row;
// when not, returns the first row found (legacy behavior — used by
// system-level send paths where no specific org owns the message).
//
// The table is keyed by (organization_id, event_key) per Phase F.
// System admins overriding a system template (e.g. user_invite) for
// their primary org write to (their_org_id, event_key); the send
// path looks up by (recipient's_org_id, event_key) and falls back
// to baked default when no row exists.
async function getOverride(eventKey, orgId) {
  try {
    if (orgId != null) {
      const { rows } = await pool.query(
        'SELECT subject, html_body FROM email_template_overrides WHERE event_key = $1 AND organization_id = $2',
        [eventKey, orgId]
      );
      if (rows.length) return { subject: rows[0].subject, html_body: rows[0].html_body };
      return null;
    }
    // No org context — return any row (most-recently-updated) so the
    // legacy single-org behavior keeps working.
    const { rows } = await pool.query(
      'SELECT subject, html_body FROM email_template_overrides WHERE event_key = $1 ORDER BY updated_at DESC LIMIT 1',
      [eventKey]
    );
    return rows.length ? { subject: rows[0].subject, html_body: rows[0].html_body } : null;
  } catch (e) {
    console.warn('[email-templates] override lookup failed:', e.message);
    return null;
  }
}

// ─── Block-based template renderer (Wave 3) ────────────────────────
//
// Templates can be stored EITHER as raw HTML (legacy) OR as a JSON
// blocks array. A body string that starts with `{` and contains
// `"blocks"` gets parsed as JSON; anything else is treated as legacy
// raw HTML and interpolated normally.
//
// Block schema (all fields optional except `type`):
//   { type: 'header',  logo_url, title, subtitle }
//   { type: 'text',    html }
//   { type: 'button',  label, url, bg_color }
//   { type: 'spacer',  height_px }
//   { type: 'image',   url, alt, max_width_px }
//   { type: 'footer',  address, unsubscribe_url }
//
// Each block renders as a self-contained `<table>` with inline
// styles — the only layout primitive that's reliable across Gmail,
// Outlook, Apple Mail. The outer wrapper is the same shellWrap()
// used by legacy templates so headers/footers stay consistent.

// Whitelist of tags allowed inside text-block html. Anything else
// gets stripped on save AND defensively at render time. Attributes
// allow only href on <a> and href targets must be http(s):// or
// mailto: or a template variable placeholder.
var TEXT_BLOCK_TAG_WHITELIST = ['b', 'strong', 'i', 'em', 'a', 'br', 'p', 'ul', 'ol', 'li'];
function sanitizeBlockHtml(html) {
  if (typeof html !== 'string') return '';
  // Strip <script>, <style>, <iframe>, <object>, <embed>, comments,
  // and any tag not in the whitelist. Simple regex pass — for
  // production we'd use a real HTML parser, but for the constrained
  // input from the visual editor it's sufficient.
  var s = String(html);
  // Drop comments
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Drop dangerous tags entirely (including content).
  s = s.replace(/<(script|style|iframe|object|embed|form|input|button)\b[\s\S]*?<\/\1>/gi, '');
  // Strip on* event handlers and javascript: URIs from attributes.
  s = s.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/javascript\s*:/gi, '');
  // For each tag, if not in whitelist, strip the tag (keep content).
  s = s.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, function(match, tag) {
    if (TEXT_BLOCK_TAG_WHITELIST.indexOf(String(tag).toLowerCase()) === -1) return '';
    // For <a> tags, validate href to safe schemes only.
    if (tag.toLowerCase() === 'a' && match[1] !== '/') {
      var hrefMatch = match.match(/href\s*=\s*["']([^"']+)["']/i);
      if (hrefMatch) {
        var url = hrefMatch[1].trim();
        if (!/^(https?:|mailto:|\{\{)/i.test(url)) {
          // Strip the href if it's not a safe scheme.
          match = match.replace(/href\s*=\s*["'][^"']+["']/i, 'href="#"');
        }
      }
      // Force target=_blank + rel for security.
      if (!/target\s*=/i.test(match)) {
        match = match.replace(/<a\b/i, '<a target="_blank" rel="noopener"');
      }
    }
    return match;
  });
  return s;
}

// ── System brand header — the app's sticky-header lockup, email-safe ──
// Colors from the brand kit (images/project-86-lockup-dark.svg): navy
// #0F172A, cyan #22D3EE, wordmark #F8FAFC. The wordmark mirrors
// .header-wordmark in styles.css (Inter 200, 2.5px tracking); email
// clients that strip webfonts fall back to Segoe/Roboto light.
var BRAND_NAVY = '#0F172A';
var BRAND_CYAN = '#22D3EE';
var WORDMARK_CSS = "font-family:Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-weight:200;letter-spacing:2.5px;";
function brandLockupRow(style, appUrlStr) {
  var icon = escapeAttr(appUrlStr + '/images/pwa/icon-192.png');
  var s = String(style || 'bar').toLowerCase();
  if (s === 'light') {
    return '<tr><td style="padding:20px 24px 0;text-align:center;">' +
      '<img src="' + icon + '" width="34" height="34" alt="" style="display:inline-block;vertical-align:middle;border-radius:7px;" />' +
      '<span style="' + WORDMARK_CSS + 'font-size:16px;color:' + BRAND_NAVY + ';vertical-align:middle;padding-left:12px;">PROJECT&nbsp;86</span>' +
      '<div style="height:2px;line-height:2px;font-size:2px;background:' + BRAND_CYAN + ';margin-top:14px;">&nbsp;</div>' +
    '</td></tr>';
  }
  if (s === 'banner') {
    return '<tr><td style="padding:0;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND_NAVY + ';border-bottom:2px solid ' + BRAND_CYAN + ';"><tr>' +
        '<td style="padding:22px 24px 18px;text-align:center;">' +
          '<img src="' + icon + '" width="44" height="44" alt="" style="display:inline-block;border-radius:9px;" />' +
          '<div style="' + WORDMARK_CSS + 'font-size:17px;color:#F8FAFC;margin-top:10px;">PROJECT&nbsp;86</div>' +
        '</td></tr></table>' +
    '</td></tr>';
  }
  // Default 'bar' — the app's sticky header, left-aligned. alt="" on all
  // variants: when a client blocks remote images (default for new
  // senders), alt text wraps awkwardly beside the broken-image glyph
  // ("Pr / ojec…" observed live in John's inbox) — with an empty alt the
  // blocked state collapses and the TEXT wordmark carries the brand.
  return '<tr><td style="padding:0;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND_NAVY + ';border-bottom:2px solid ' + BRAND_CYAN + ';"><tr>' +
      '<td style="padding:14px 24px;">' +
        '<img src="' + icon + '" width="32" height="32" alt="" style="display:inline-block;vertical-align:middle;border-radius:6px;" />' +
        '<span style="' + WORDMARK_CSS + 'font-size:16px;color:#F8FAFC;vertical-align:middle;padding-left:12px;">PROJECT&nbsp;86</span>' +
      '</td></tr></table>' +
  '</td></tr>';
}

// table so it survives every email client's layout engine.
function renderBlock(block, ctx) {
  if (!block || typeof block !== 'object') return '';
  ctx = ctx || {};
  var accent = ctx.accent || '#4f8cff';
  var appUrlStr = ctx.appUrl || appUrl();
  var p86Logo = appUrlStr + '/images/logo-p86-email.png';
  var t = String(block.type || '').toLowerCase();
  switch (t) {
    case 'header': {
      var title = escapeHtml(block.title || '');
      var subtitle = block.subtitle
        ? '<div style="font-size:13px;color:#6b7280;text-align:center;margin-top:4px;">' + escapeHtml(block.subtitle) + '</div>'
        : '';
      var titleRow = '<tr><td style="padding:16px 24px 8px;text-align:center;">' +
        (title ? '<div style="font-size:22px;font-weight:700;color:#111827;line-height:1.2;">' + title + '</div>' : '') +
        subtitle +
      '</td></tr>';
      if (ctx.scope === 'system') {
        // System emails wear the APP'S STICKY-HEADER lockup (John's call,
        // 2026-07-02): cube icon + tracked-out ultra-light "PROJECT 86"
        // wordmark on the brand navy, cyan hairline under. Email-safe:
        // PNG icon (Gmail blocks SVG), wordmark as real text with the
        // Inter→Segoe/Roboto stack (webfonts don't survive most clients;
        // letter-spacing does). block.brand_style picks the variant:
        //   'bar' (default) — left-aligned navy bar, exactly like the app
        //   'banner'        — centered navy banner, stacked lockup
        //   'light'         — white header, navy wordmark, cyan hairline
        return brandLockupRow(block.brand_style, appUrlStr) + titleRow;
      }
      // Org emails keep the centered-logo header: admin-set logo_url wins,
      // then the org branding kit, then P86 so the header is never empty.
      var logoSrc = block.logo_url || ctx.orgLogoUrl || p86Logo;
      var logo = '<img src="' + escapeAttr(logoSrc) + '" alt="" style="max-height:42px;display:block;margin:0 auto 10px;" />';
      return '<tr><td style="padding:16px 24px 0;text-align:center;">' + logo + '</td></tr>' + titleRow;
    }
    case 'text': {
      // text.html has already been sanitized on save, but re-sanitize
      // here as a defense-in-depth measure since legacy rows might
      // skip the save-time pass.
      var safe = sanitizeBlockHtml(block.html || '');
      return '<tr><td style="padding:12px 24px;font-size:14px;line-height:1.55;color:#1f2937;">' +
        safe +
      '</td></tr>';
    }
    case 'button': {
      var label = escapeHtml(block.label || 'Click');
      var url = escapeAttr(block.url || '#');
      // A button left at the platform default (#4f8cff) or unset inherits the
      // scope accent — the org's accent_color for org emails, the platform
      // blue for system. An admin's custom non-default color is respected.
      var bc = String(block.bg_color || '').toLowerCase();
      var bg = (!bc || bc === '#4f8cff')
        ? accent
        : (/^#[0-9a-f]{3,8}$/i.test(bc) ? block.bg_color : accent);
      return '<tr><td style="padding:18px 24px;text-align:center;">' +
        '<a href="' + url + '" target="_blank" rel="noopener" ' +
          'style="display:inline-block;background:' + bg + ';color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;font-size:15px;">' +
          label +
        '</a>' +
      '</td></tr>';
    }
    case 'spacer': {
      var h = Number(block.height_px);
      if (!Number.isFinite(h)) h = 16;
      h = Math.max(4, Math.min(120, h));
      return '<tr><td style="padding:0;line-height:0;font-size:0;">' +
        '<div style="height:' + h + 'px;">&nbsp;</div>' +
      '</td></tr>';
    }
    case 'image': {
      if (!block.url) return '';
      var max = Number(block.max_width_px);
      if (!Number.isFinite(max)) max = 560;
      max = Math.max(80, Math.min(900, max));
      return '<tr><td style="padding:12px 24px;text-align:center;">' +
        '<img src="' + escapeAttr(block.url) + '" alt="' + escapeAttr(block.alt || '') + '" ' +
          'style="max-width:' + max + 'px;width:100%;height:auto;border-radius:4px;display:inline-block;" />' +
      '</td></tr>';
    }
    case 'footer': {
      // Project 86 logo + "Powered by Project 86" anchor EVERY footer — the
      // platform's brand presence on every email, org or system.
      var p86 = '<img src="' + escapeAttr(p86Logo) + '" alt="Project 86" style="height:22px;display:inline-block;margin:0 auto 8px;" />';
      var addr = block.address ? '<div style="margin-top:2px;">' + escapeHtml(block.address) + '</div>' : '';
      var unsubHtml = block.unsubscribe_url
        ? '<div style="margin-top:6px;"><a href="' + escapeAttr(block.unsubscribe_url) + '" style="color:#6b7280;text-decoration:underline;font-size:11px;">Unsubscribe</a></div>'
        : '';
      return '<tr><td style="padding:18px 24px;text-align:center;color:#6b7280;font-size:11px;border-top:1px solid #e5e7eb;">' +
        p86 +
        '<div>Powered by <a href="' + escapeAttr(appUrlStr) + '" style="color:#6b7280;text-decoration:none;">Project 86</a></div>' +
        addr +
        unsubHtml +
      '</td></tr>';
    }
    default:
      return '';
  }
}

// Render a blocks array to a full email-safe HTML body. accent is
// the brand color used for default buttons (falls back to org
// branding's accent_color, then to the platform blue).
//
// Wave 6: when params includes __branding, missing block fields fall
// back to the org's branding kit:
//   header.logo_url        → branding.logo_url
//   button.bg_color        → branding.accent_color  (or 'accent' arg)
//   footer.address (empty) → branding.footer_address
function renderBlocks(blocks, params, ctxIn) {
  if (!Array.isArray(blocks)) return '';
  var enriched = params || {};
  var branding = (enriched.__branding && typeof enriched.__branding === 'object') ? enriched.__branding : {};
  ctxIn = ctxIn || {};
  var scope = ctxIn.scope || 'org';
  // System emails are locked to the platform blue; org emails use the org's
  // accent color (falling back to the platform blue when unset).
  var resolvedAccent = (scope === 'system')
    ? '#4f8cff'
    : (ctxIn.accent || branding.accent_color || '#4f8cff');
  var ctx = {
    accent: resolvedAccent,
    scope: scope,
    appUrl: ctxIn.appUrl || appUrl(),
    orgLogoUrl: branding.logo_url || ''
  };
  var rows = blocks.map(function(block) {
    // Interpolate every string field inside the block against params.
    var prepared = {};
    Object.keys(block || {}).forEach(function(k) {
      var v = block[k];
      if (typeof v === 'string') prepared[k] = interpolate(v, enriched);
      else prepared[k] = v;
    });
    prepared.type = block.type;  // type is the dispatch key
    // Footer address still falls back to the org branding kit; the header
    // logo + button accent are resolved per-scope inside renderBlock.
    if (prepared.type === 'footer' && !prepared.address && branding.footer_address) {
      prepared.address = branding.footer_address;
    }
    return renderBlock(prepared, ctx);
  }).join('');
  // Guarantee a Project 86 footer on EVERY email — if the template has no
  // footer block (admin removed it, or a starter without one), append the
  // canonical footer so the P86 logo + "Powered by Project 86" always lands.
  var hasFooter = blocks.some(function(b) { return b && String(b.type || '').toLowerCase() === 'footer'; });
  if (!hasFooter) {
    rows += renderBlock({ type: 'footer', address: branding.footer_address || '' }, ctx);
  }
  // Wrap in a centered max-width table — email-safe centering.
  // font-family on the wrapper: without it, clients that default <body>
  // to a serif (and the admin preview iframe) rendered every title/text
  // block in Times. Gmail/Apple inherit from the table; Outlook falls
  // back to its own Segoe default, which matches the stack anyway.
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ' +
    'style="width:100%;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;' +
    "font-family:Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" + '">' +
    rows +
  '</table>';
}

// Sniff whether a body string is a blocks-JSON template or legacy
// raw HTML. Returns the parsed { subject, blocks } shape or null.
function tryParseBlocks(bodyStr) {
  if (typeof bodyStr !== 'string') return null;
  var trimmed = bodyStr.trim();
  if (trimmed[0] !== '{') return null;
  if (trimmed.indexOf('"blocks"') === -1) return null;
  try {
    var parsed = JSON.parse(trimmed);
    if (parsed && Array.isArray(parsed.blocks)) return parsed;
  } catch (e) { /* not a valid JSON template */ }
  return null;
}

// Render the baked-in default for an event by interpolating the
// template source against enriched params. enriched.__branding (when
// present) is honored by renderBlocks for branding fallbacks; raw
// html_body templates don't see it.
function renderDefault(eventKey, params) {
  var src = TEMPLATE_SOURCES[eventKey];
  if (!src) throw new Error('No baked-in template for event: ' + eventKey);
  var enriched = enrichParams(eventKey, params);
  // Block-based default? Render via renderBlocks; subject is
  // interpolated normally.
  if (Array.isArray(src.blocks)) {
    var subjectB = interpolate(src.subject, enriched);
    var evDef = getEvent(eventKey);
    var htmlB = renderBlocks(src.blocks, enriched, { scope: evDef ? evDef.scope : 'org', appUrl: appUrl() });
    return { subject: subjectB, html: htmlB, text: htmlToText(htmlB) };
  }
  var subject = interpolate(src.subject, enriched);
  var html = interpolate(src.html_body, enriched);
  return { subject: subject, html: html, text: htmlToText(html) };
}

// Public render — preferred call site for sending. Routes pass the
// event key + params; this function does override-or-default
// dispatch and returns { subject, html, text }.
//
// Override behavior: the admin's html_body is rendered AS-IS — same
// {{var}} interpolation pipeline as the default. Empty subject or
// empty body falls back to the default for that field so partial
// overrides work.
async function render(eventKey, params, opts) {
  var enriched = enrichParams(eventKey, params);
  var orgId = opts && opts.orgId != null ? opts.orgId : (params && params.__orgId);
  // Branding kit (Wave 6). When we have an orgId, fetch the org's
  // branding JSONB and stash it on enriched.__branding so renderBlocks
  // can fall back to it for missing block fields.
  if (orgId != null && !enriched.__branding) {
    try {
      var b = await pool.query('SELECT branding FROM organizations WHERE id = $1', [orgId]);
      if (b.rows.length && b.rows[0].branding) enriched.__branding = b.rows[0].branding;
    } catch (e) { /* branding lookup is best-effort */ }
  }
  var override = await getOverride(eventKey, orgId);

  if (!override || (!override.subject && !override.html_body)) {
    return renderDefault(eventKey, params);
  }

  var defSrc = TEMPLATE_SOURCES[eventKey];
  var subjectSrc = override.subject || (defSrc && defSrc.subject) || '';
  var bodySrc = override.html_body || (defSrc && defSrc.html_body) || '';
  var subject = interpolate(subjectSrc, enriched);
  // Block-based override? The body is a JSON string with blocks[].
  // Parse and render via renderBlocks. Falls back to legacy raw-HTML
  // interpolation if parsing fails.
  var parsedBlocks = tryParseBlocks(bodySrc);
  var html;
  if (parsedBlocks && Array.isArray(parsedBlocks.blocks)) {
    var evOv = getEvent(eventKey);
    html = renderBlocks(parsedBlocks.blocks, enriched, { scope: evOv ? evOv.scope : 'org', appUrl: appUrl() });
  } else {
    html = interpolate(bodySrc, enriched);
  }
  return {
    subject: subject || '(no subject)',
    html: html,
    text: htmlToText(html)
  };
}

// Returns the SOURCE (with {{var}} placeholders) for an event. The
// admin Email Templates editor uses this so what the admin edits is
// exactly what the renderer interpolates against. For block-based
// defaults we also surface the blocks array so the editor can open
// in visual mode.
function getDefaultSource(eventKey) {
  var s = TEMPLATE_SOURCES[eventKey];
  if (!s) return null;
  var out = { subject: s.subject, html_body: s.html_body || '' };
  if (Array.isArray(s.blocks)) out.blocks = s.blocks;
  return out;
}

// Sample params for each event — used by the editor's preview pane
// for live render before any real data exists.
function sampleParams(eventKey) {
  switch (eventKey) {
    case 'org_invite':
      return {
        platform_name: 'Project 86',
        org_name: 'Acme Construction',
        invited_by: 'System Admin',
        accept_url: 'https://project86.net/accept-org-invite?token=sample-token',
        expires_at: '2026-06-15T00:00:00Z'
      };
    case 'user_invite':
      return { name: 'Jane Smith', email: 'jane@example.com', password: 'temp-pass-123', invitedBy: 'Sample Admin' };
    case 'password_reset':
      return { name: 'Jane Smith', email: 'jane@example.com', password: 'new-pass-123', resetBy: 'Sample Admin' };
    case 'job_assigned':
      return { recipientName: 'Jane Smith', job: { title: 'Madeira Bay Restoration', jobNumber: 'S2245', client: 'Madeira Bay HOA', contractAmount: 125000, status: 'In Progress' }, assignedBy: 'Sample Admin', action: 'assigned' };
    case 'schedule_entry':
      return { recipientName: 'Mike Crew', entry: { startDate: '2026-05-10', days: 3, includesWeekends: false, notes: 'Bring scaffold' }, job: { title: 'Madeira Bay Restoration', jobNumber: 'S2245' }, assignedBy: 'Sample Admin' };
    case 'sub_assigned':
      return { sub: { name: 'Summit Sealants', primaryContactFirst: 'Mike' }, job: { title: 'Madeira Bay Restoration', jobNumber: 'S2245' }, contractAmt: 12500, assignedBy: { name: 'Sample Admin' } };
    case 'lead_status_sold':
      return { lead: { title: 'Solace Powerwash', client_company: 'Solace Communities', estimated_revenue_high: 18000 }, salesperson: { name: 'Jane Smith' }, changedBy: { name: 'Sample Admin' } };
    case 'lead_status_lost':
      return { lead: { title: 'Solace Powerwash', client_company: 'Solace Communities' }, salesperson: { name: 'Jane Smith' }, changedBy: { name: 'Sample Admin' }, reason: 'Lost to competitor', status: 'lost' };
    case 'cert_expiring':
      return { sub: { name: 'Summit Sealants', primaryContactFirst: 'Mike' }, cert: { type: 'gl', expirationDate: '2026-05-15', daysUntilExpiry: 12 } };
    case 'weekly_digest_pm':
      return {
        recipientName: 'Jane Smith',
        week_label: 'Week of May 27, 2026',
        jobsTouchedCount: 5,
        jobsTouchedListHtml: '<ul style="color:#1f2937;font-size:13px;line-height:1.6;"><li>Madeira Bay Restoration (S2245) — 3 new photos, status: In Progress</li><li>Solace Powerwash (S2247) — schedule updated</li><li>Penthouse Groves (S2248) — completed</li></ul>',
        scheduleNextWeekCount: 3,
        scheduleNextWeekListHtml: '<ul style="color:#1f2937;font-size:13px;line-height:1.6;"><li>Mon — Madeira Bay Restoration crew (3 days)</li><li>Wed — Solace Powerwash (1 day)</li><li>Fri — Hidden Creek (2 days)</li></ul>'
      };
    case 'weekly_digest_sales':
      return {
        recipientName: 'Scott Ryan',
        week_label: 'Week of May 27, 2026',
        leadsProgressedCount: 7,
        leadsProgressedListHtml: '<ul style="color:#1f2937;font-size:13px;line-height:1.6;"><li>Acme HOA — moved to Proposal sent</li><li>Riverside Apartments — site visit booked</li><li>Westshore Bay — estimate in review</li></ul>',
        leadsWonCount: 2,
        estimatesSentCount: 4
      };
    case 'weekly_digest_ops':
      return {
        recipientName: 'Admin',
        week_label: 'Week of May 27, 2026',
        certsExpiringCount: 3,
        certsExpiringListHtml: '<ul style="color:#1f2937;font-size:13px;line-height:1.6;"><li>Summit Sealants — GL expires in 12 days</li><li>Coast Painters — WC expires in 21 days</li><li>Florida Roofing — W-9 expires in 28 days</li></ul>',
        jobsStartingNextWeekCount: 2
      };
    default: return {};
  }
}

async function renderSample(eventKey, overrides) {
  // overrides let the test-send route swap sample placeholders for real
  // values (e.g. the caller's own name as the inviter) so a test email
  // reads like the real thing instead of "Sample Admin invited you".
  var params = Object.assign({}, sampleParams(eventKey), overrides || {});
  return render(eventKey, params);
}

function renderSampleDefault(eventKey) {
  return renderDefault(eventKey, sampleParams(eventKey));
}

// Back-compat function exports — old call sites that still use them
// (server/routes/auth-routes.js, server/routes/schedule-routes.js,
// server/routes/job-routes.js) keep working. They route through the
// same source + interpolation pipeline now.
function newUserInvite(params) { return renderDefault('user_invite', params); }
function passwordReset(params) { return renderDefault('password_reset', params); }
function jobAssigned(params) { return renderDefault('job_assigned', params); }
function scheduleAssigned(params) { return renderDefault('schedule_entry', params); }
function subAssigned(params) { return renderDefault('sub_assigned', params); }
function leadStatusSold(params) { return renderDefault('lead_status_sold', params); }
function leadStatusLost(params) { return renderDefault('lead_status_lost', params); }
function certExpiring(params) { return renderDefault('cert_expiring', params); }

// Returns the enriched sample params for an event — the same params
// the renderer interpolates against. Used by the admin Email Templates
// editor to do client-side live preview as the admin types.
function enrichedSampleParams(eventKey) {
  return enrichParams(eventKey, sampleParams(eventKey));
}

module.exports = {
  // Per-event back-compat wrappers (unchanged signature for callers)
  newUserInvite,
  passwordReset,
  jobAssigned,
  scheduleAssigned,
  subAssigned,
  leadStatusSold,
  leadStatusLost,
  certExpiring,
  certTypeLabel,
  // Source-driven rendering
  render,
  renderSample,
  renderSampleDefault,
  getDefaultSource,
  sampleParams,
  enrichedSampleParams,
  // Helpers exposed for tests / utilities
  interpolate,
  htmlToText,
  // Wave 3 block renderer helpers (used by routes that need to render
  // or validate block-shaped templates).
  renderBlocks,
  sanitizeBlockHtml,
  tryParseBlocks
};
