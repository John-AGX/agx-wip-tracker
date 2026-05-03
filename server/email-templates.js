// AGX transactional email templates.
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

// ─── Tiny utilities ────────────────────────────────────────────────

// Public app URL used by every email's "Sign in" / "Open" button.
// APP_URL env wins; default tracks the live AGX domain.
function appUrl() {
  var u = process.env.APP_URL;
  if (typeof u === 'string' && /^https?:\/\//.test(u.trim())) {
    return u.trim().replace(/\/$/, '');
  }
  return 'https://wip-agxco.com';
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
  '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">' +
    'AGX WIP Tracker &middot; <a href="{{appUrl}}" style="color:#4f8cff;text-decoration:none;">{{appUrlHost}}</a><br/>' +
    'You\'re receiving this because of activity on your AGX account. ' +
    'Toggle notifications in <strong>My Account &rarr; Notifications</strong>.' +
  '</div>'
);

function shellWrap(title, bodyHtml) {
  return (
    '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">' +
      '<div style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:10px;color:#1f2937;line-height:1.5;">' +
        // AGX logo. Email clients fetch this via absolute URL since the
        // email is rendered outside our domain. {{appUrl}} resolves at
        // render time so dev/staging/prod each load the right image.
        '<div style="margin-bottom:12px;"><img src="{{appUrl}}/images/logo-color.png" alt="AGX" style="height:40px;display:block;" /></div>' +
        '<h2 style="margin:0 0 16px 0;color:#111827;font-size:20px;">' + title + '</h2>' +
        bodyHtml +
        COMMON_FOOTER +
      '</div>' +
    '</body></html>'
  );
}

var TEMPLATE_SOURCES = {

  user_invite: {
    subject: 'You\'re invited to AGX WIP Tracker',
    html_body: shellWrap('Welcome to AGX',
      '<p>Hi {{name}},</p>' +
      '<p>{{invitedBy}} just created an account for you on the AGX WIP Tracker. ' +
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
    subject: 'Your AGX password was reset',
    html_body: shellWrap('Password reset',
      '<p>Hi {{name}},</p>' +
      '<p>{{resetBy}} has reset your AGX password. Use the credentials below to sign in:</p>' +
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
    html_body: shellWrap('Job {{verb}}',
      '<p>Hi {{recipientName}},</p>' +
      '<p>{{assignedBy}} just {{verb}} on AGX:</p>' +
      '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
        '{{{job.detailsRowsHtml}}}' +
      '</table>' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in AGX</a></p>'
    )
  },

  schedule_entry: {
    subject: 'Scheduled: {{job.jobLabel}} — {{entry.startDateFmt}}',
    html_body: shellWrap('You\'ve been scheduled',
      '<p>Hi {{recipientName}},</p>' +
      '<p>{{assignedBy}} just added you to a production schedule entry on AGX:</p>' +
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
    html_body: shellWrap('You\'ve been assigned to a job',
      '<p>Hi {{sub.greetingName}},</p>' +
      '<p>{{assignedBy.name}} just added <strong>{{sub.name}}</strong> as a subcontractor on this AGX job:</p>' +
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
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in AGX</a></p>'
    )
  },

  lead_status_lost: {
    subject: '{{statusLabel}}: {{lead.title}}',
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
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in AGX</a></p>'
    )
  },

  cert_expiring: {
    subject: 'Cert expiring: {{cert.typeLabel}} ({{sub.name}})',
    html_body: shellWrap('{{cert.typeLabel}} certificate expiring',
      '<p>Hi {{sub.greetingName}},</p>' +
      '<p>Your <strong>{{cert.typeLabel}}</strong> certificate on file with AGX is approaching expiration.</p>' +
      '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:16px 0;font-size:13px;">' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Sub</td><td style="padding:4px 8px;font-weight:600;">{{sub.name}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Certificate</td><td style="padding:4px 8px;font-weight:600;">{{cert.typeLabel}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Expiration date</td><td style="padding:4px 8px;font-weight:600;">{{cert.expirationDateFmt}}</td></tr>' +
        '<tr><td style="padding:4px 8px;color:#6b7280;">Status</td><td style="padding:4px 8px;">{{{cert.urgencyHtml}}}</td></tr>' +
      '</table>' +
      '<p>Please send an updated copy at your earliest convenience &mdash; reply to this email or use the button below.</p>' +
      '<p><a href="{{appUrl}}" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open in AGX</a></p>'
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
    if (!p.assignedBy) p.assignedBy = { name: 'AGX' };
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

// Render the baked-in default for an event by interpolating the
// template source against enriched params.
function renderDefault(eventKey, params) {
  var src = TEMPLATE_SOURCES[eventKey];
  if (!src) throw new Error('No baked-in template for event: ' + eventKey);
  var enriched = enrichParams(eventKey, params);
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
async function render(eventKey, params) {
  var enriched = enrichParams(eventKey, params);
  var override = await getOverride(eventKey);

  if (!override || (!override.subject && !override.html_body)) {
    return renderDefault(eventKey, params);
  }

  var defSrc = TEMPLATE_SOURCES[eventKey];
  var subjectSrc = override.subject || (defSrc && defSrc.subject) || '';
  var bodySrc = override.html_body || (defSrc && defSrc.html_body) || '';
  var subject = interpolate(subjectSrc, enriched);
  var html = interpolate(bodySrc, enriched);
  return {
    subject: subject || '(no subject)',
    html: html,
    text: htmlToText(html)
  };
}

// Returns the SOURCE (with {{var}} placeholders) for an event. The
// admin Email Templates editor uses this so what the admin edits is
// exactly what the renderer interpolates against.
function getDefaultSource(eventKey) {
  var s = TEMPLATE_SOURCES[eventKey];
  return s ? { subject: s.subject, html_body: s.html_body } : null;
}

// Sample params for each event — used by the editor's preview pane
// for live render before any real data exists.
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
      return { lead: { title: 'Solace Powerwash', client_company: 'Solace Communities' }, salesperson: { name: 'Jane Smith' }, changedBy: { name: 'John AGX' }, reason: 'Lost to competitor', status: 'lost' };
    case 'cert_expiring':
      return { sub: { name: 'Summit Sealants', primaryContactFirst: 'Mike' }, cert: { type: 'gl', expirationDate: '2026-05-15', daysUntilExpiry: 12 } };
    default: return {};
  }
}

async function renderSample(eventKey) {
  return render(eventKey, sampleParams(eventKey));
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
  htmlToText
};
