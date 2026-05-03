// Canonical catalog of email event types.
//
// One source of truth for: which events the app fires, what they're
// for, what variables their templates can interpolate, and the per-
// event settings shape stored in app_settings (key='email').
//
// When wiring a new email trigger:
//   1. Add an entry to EVENTS below
//   2. Define the template in server/email-templates.js
//   3. Wire the trigger in the relevant route (e.g., a POST handler)
//      using sendForEvent(eventKey, params) in server/email.js
//
// The admin Email page reads this list to render the events table —
// add an entry here and it shows up automatically with a toggle.

const EVENTS = [
  {
    key: 'user_invite',
    label: 'User invitation',
    description: 'Sent when an admin creates a new user. Contains login + temp password.',
    category: 'Administrative',
    defaultEnabled: true,
    audience: 'The new user',
    variables: ['user.name', 'user.email', 'user.password', 'invitedBy.name', 'appUrl'],
    wired: true
  },
  {
    key: 'password_reset',
    label: 'Password reset',
    description: 'Sent when an admin resets a user\'s password. Contains the new temp password.',
    category: 'Administrative',
    defaultEnabled: true,
    audience: 'The user',
    variables: ['user.name', 'user.email', 'user.password', 'resetBy.name', 'appUrl'],
    wired: true
  },
  {
    key: 'job_assigned',
    label: 'Job PM assignment',
    description: 'Sent when a user is assigned as PM on a job.',
    category: 'Project Management',
    defaultEnabled: true,
    audience: 'The PM',
    variables: ['recipientName', 'job.title', 'job.jobNumber', 'job.client', 'assignedBy.name', 'appUrl'],
    wired: true
  },
  {
    key: 'schedule_entry',
    label: 'Schedule assignment',
    description: 'Sent when a user (or sub) is assigned to a production schedule entry.',
    category: 'Project Management',
    defaultEnabled: true,
    audience: 'Assigned crew',
    variables: ['recipientName', 'entry.startDate', 'entry.endDate', 'entry.title', 'job.title', 'assignedBy.name', 'appUrl'],
    wired: true
  },
  {
    key: 'sub_assigned',
    label: 'Sub assigned to job',
    description: 'Sent when a sub is added to a job\'s subcontractor list. Useful for handoff.',
    category: 'Project Management',
    defaultEnabled: false,
    audience: 'Sub primary contact',
    variables: ['sub.name', 'sub.primaryContactFirst', 'job.title', 'job.jobNumber', 'contractAmt', 'assignedBy.name', 'appUrl'],
    wired: true
  },
  {
    key: 'lead_status_sold',
    label: 'Lead won (sold)',
    description: 'Sent when a lead\'s status flips to Sold. Goes to the salesperson.',
    category: 'Financial',
    defaultEnabled: false,
    audience: 'Salesperson',
    variables: ['lead.title', 'lead.client_company', 'lead.estimated_revenue_high', 'salesperson.name', 'changedBy.name', 'appUrl'],
    wired: true
  },
  {
    key: 'lead_status_lost',
    label: 'Lead lost',
    description: 'Sent when a lead\'s status flips to Lost or No Opportunity.',
    category: 'Financial',
    defaultEnabled: false,
    audience: 'Salesperson',
    variables: ['lead.title', 'lead.client_company', 'salesperson.name', 'changedBy.name', 'reason', 'appUrl'],
    wired: true
  },
  {
    key: 'cert_expiring',
    label: 'Certificate expiring',
    description: 'Daily cron: when a sub\'s GL/WC/W-9/Bank cert is within reminder_days of expiration.',
    category: 'Administrative',
    defaultEnabled: false,
    audience: 'Sub primary contact (+ admin BCC)',
    variables: ['sub.name', 'sub.primaryContactFirst', 'cert.type', 'cert.expirationDate', 'cert.daysUntilExpiry', 'appUrl'],
    wired: true
  }
];

// Default global settings shape. The admin Email page persists overrides
// to app_settings under key='email'. See getEmailSettings() in
// server/email.js.
const DEFAULT_SETTINGS = {
  events: EVENTS.reduce((acc, e) => {
    acc[e.key] = { enabled: e.defaultEnabled, bcc: [] };
    return acc;
  }, {}),
  globalBcc: '',
  digestMode: false,
  quietHours: { enabled: false, start: '21:00', end: '07:00' }
};

function getEvent(key) {
  return EVENTS.find(e => e.key === key) || null;
}

module.exports = { EVENTS, DEFAULT_SETTINGS, getEvent };
