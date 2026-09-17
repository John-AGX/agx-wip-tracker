// Service ticket fields — the one check every office write runs.
//
// POST /api/service-tickets (create) and PATCH /api/service-tickets/:id both
// hand their body to validateTicketFields before anything touches the
// database, so a bad date, a pasted NUL byte or an over-long scope is a
// readable 400 that names the field, never a Postgres 22007 / 22021 surfacing
// as a blank 500.
//
// PURE, like service-tickets.js: this module requires nothing — no pool, no
// express, no env — so its rules are unit tested with no database and no
// JWT_SECRET. The routes own the questions that need the database (is the
// assignee in this org, can they open the parent, did someone else change the
// field first); this file owns the shape of each value and the wording.
'use strict';

const ASSIGNEE_REFUSAL = 'Assignee is not a user in this organization';
const TITLE_REFUSAL = 'Give the ticket a title.';
const PRIORITY_REFUSAL = 'Priority must be Low, Normal, High or Urgent.';
const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

function rule(key, kind, label, extra) {
  return Object.freeze(Object.assign({ key: key, kind: kind, label: label }, extra || {}));
}

// Walked IN THIS ORDER, and the first problem wins, so the error a caller sees
// for a body with several problems is deterministic.
const TICKET_FIELD_RULES = Object.freeze([
  rule('title', 'text', 'Title', { max: 300, required: true }),
  rule('scope_proposed', 'text', 'Scope', { max: 20000 }),
  rule('scope_approved', 'text', 'Approved scope', { max: 20000 }),
  rule('internal_notes', 'text', 'Internal notes', { max: 10000 }),
  rule('requested_by', 'text', 'Requested by', { max: 200 }),
  rule('site_contact_name', 'text', 'Site contact', { max: 200 }),
  rule('site_contact_phone', 'phone', 'Site phone', { max: 40 }),
  rule('access_notes', 'text', 'Gate code / access', { max: 1000 }),
  rule('street_address', 'text', 'Street address', { max: 300 }),
  rule('city', 'text', 'City', { max: 120 }),
  rule('state', 'text', 'State', { max: 60 }),
  rule('zip', 'text', 'ZIP', { max: 20 }),
  rule('lat', 'coord', 'Latitude', { min: -90, max: 90 }),
  rule('lng', 'coord', 'Longitude', { min: -180, max: 180 }),
  rule('priority', 'priority', 'Priority'),
  rule('scheduled_for', 'date', 'Scheduled date'),
  rule('due_date', 'date', 'Due date'),
  rule('assignee_user_id', 'user', 'Assignee'),
]);

const RULE_BY_KEY = Object.freeze(TICKET_FIELD_RULES.reduce(function (m, r) {
  m[r.key] = r;
  return m;
}, {}));

const TICKET_FIELD_LABELS = Object.freeze(TICKET_FIELD_RULES.reduce(function (m, r) {
  m[r.key] = r.label;
  return m;
}, {}));

const NUL_RE = /\u0000/g;

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

function refuse(field, error) {
  return { ok: false, field: field, error: error };
}

// ── Kinds ───────────────────────────────────────────────────────────────
// Each returns { value } or { error }. `omit: true` means "leave the key out of
// values" (a blank priority on create, where the database default applies).

function checkText(r, raw) {
  if (raw === null || raw === '') {
    return r.required ? { error: TITLE_REFUSAL } : { value: null };
  }
  let s;
  if (typeof raw === 'string') s = raw;
  else if (typeof raw === 'number' || typeof raw === 'boolean') s = String(raw);
  else return { error: r.label + ' must be text.' };
  // Postgres text refuses NUL (22021), which would surface as a 500.
  s = s.replace(NUL_RE, '').trim();
  if (!s) return r.required ? { error: TITLE_REFUSAL } : { value: null };
  if (r.max && s.length > r.max) {
    return { error: r.label + ' is too long — ' + r.max + ' characters at most.' };
  }
  return { value: s };
}

function checkPhone(r, raw) {
  const bad = { error: r.label + " doesn't look like a phone number." };
  if (raw === null) return { value: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') return bad;
  const s = String(raw).replace(NUL_RE, '').trim();
  if (!s) return { value: null };
  if (r.max && s.length > r.max) {
    return { error: r.label + ' is too long — ' + r.max + ' characters at most.' };
  }
  const bare = s.replace(/ext\.?/gi, '');
  if (!/^[0-9 +().\-\/#*xX,;]*$/.test(bare)) return bad;
  const digits = bare.replace(/[^0-9]/g, '').length;
  if (digits < 7 || digits > 20) return bad;
  // The stored value keeps the formatting the office typed.
  return { value: s };
}

function checkPriority(r, raw, mode) {
  const s = raw == null ? '' : String(raw).trim().toLowerCase();
  if (!s) {
    // The column is NOT NULL with a default: omitted on create, refused on
    // update (it used to be coerced and could reach NOT NULL as a 500).
    return mode === 'create' ? { omit: true } : { error: PRIORITY_REFUSAL };
  }
  if (typeof raw !== 'string' || PRIORITIES.indexOf(s) < 0) return { error: PRIORITY_REFUSAL };
  return { value: s };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/;

function checkDate(r, raw) {
  if (raw === null || raw === '') return { value: null };
  const bad = { error: r.label + ' must be a real date (YYYY-MM-DD).' };
  if (typeof raw !== 'string') return bad;
  const s = raw.trim();
  if (!s) return { value: null };
  const m = DATE_RE.exec(s);
  if (!m) return bad;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100) return bad;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return bad;
  return { value: m[1] + '-' + m[2] + '-' + m[3] };
}

const NUMERIC_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

function checkCoord(r, raw) {
  if (raw === null || raw === '') return { value: null };
  const bad = { error: r.label + ' must be a number between ' + r.min + ' and ' + r.max + '.' };
  let n;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return { value: null };
    if (!NUMERIC_RE.test(s)) return bad;
    n = Number(s);
  } else {
    return bad;
  }
  if (!Number.isFinite(n) || n < r.min || n > r.max) return bad;
  return { value: n };
}

function checkUser(r, raw) {
  if (raw === null || raw === '') return { value: null };
  let n = NaN;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) return { error: ASSIGNEE_REFUSAL };
  return { value: n };
}

const CHECKS = Object.freeze({
  text: checkText,
  phone: checkPhone,
  priority: checkPriority,
  date: checkDate,
  coord: checkCoord,
  user: checkUser,
});

/**
 * validateTicketFields(body, { mode: 'create'|'update' })
 *   -> { ok: true, values } | { ok: false, field, error }
 *
 * Only keys present in body with a value other than undefined are checked;
 * unknown keys are ignored (the routes' allow-list decides what is writable).
 * `values` holds the normalized value of every checked key.
 */
function validateTicketFields(body, opts) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const mode = opts && opts.mode === 'create' ? 'create' : 'update';
  const values = {};
  for (const r of TICKET_FIELD_RULES) {
    if (!has(src, r.key)) {
      if (r.required && mode === 'create') return refuse(r.key, TITLE_REFUSAL);
      continue;
    }
    const out = CHECKS[r.kind](r, src[r.key], mode);
    if (out.error) return refuse(r.key, out.error);
    if (out.omit) continue;
    values[r.key] = out.value;
  }
  return { ok: true, values: values };
}

// ── Comparing what was loaded with what is stored ───────────────────────

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// A Date gives its LOCAL Y-M-D: pg parses a DATE column at local midnight, so
// the UTC parts can be the previous day. A string gives its leading YYYY-MM-DD.
function ticketFieldDateOnly(v) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  }
  if (typeof v === 'string') {
    const m = /^\s*(\d{4}-\d{2}-\d{2})/.exec(v);
    return m ? m[1] : null;
  }
  return null;
}

// The form a value is compared in, so a round trip through the browser does
// not read as a change: null and '' are the same, a textarea's LF equals the
// stored CRLF, a DATE column's Date equals the 'YYYY-MM-DD' the page sent back,
// and an assignee id is the same number whether it arrived as 7 or '7'.
function ticketFieldComparable(key, v) {
  if (v == null) return '';
  const r = RULE_BY_KEY[key];
  const kind = r ? r.kind : 'text';
  if (kind === 'date') {
    const d = ticketFieldDateOnly(v);
    return d != null ? d : String(v).trim();
  }
  if (kind === 'user') {
    const s = String(v).trim();
    if (!/^\d+$/.test(s)) return '';
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? String(n) : '';
  }
  if (kind === 'coord') {
    const s = String(v).trim();
    if (!s) return '';
    const n = Number(s);
    return Number.isFinite(n) ? String(n) : s;
  }
  if (kind === 'priority') return String(v).trim().toLowerCase();
  return String(v).replace(/\r\n?/g, '\n').trim();
}

function sameTicketFieldValue(key, a, b) {
  return ticketFieldComparable(key, a) === ticketFieldComparable(key, b);
}

function blank(v) {
  return v == null || String(v).trim() === '';
}

// A ticket's own address is all or nothing on the street: City, State or ZIP
// with no street would override the job's address with half an address.
function ticketAddressProblem(row) {
  const r = row || {};
  if (blank(r.street_address) && (!blank(r.city) || !blank(r.state) || !blank(r.zip))) {
    return { field: 'street_address', error: 'Add a street address, or clear City, State and ZIP.' };
  }
  return null;
}

// 'A' | 'A and B' | 'A, B and C'. Keys become their labels (a string that is
// not a known key is used as written), and a label is listed once.
function labelList(keys) {
  const seen = [];
  for (const k of Array.isArray(keys) ? keys : []) {
    if (k == null || k === '') continue;
    const label = Object.prototype.hasOwnProperty.call(TICKET_FIELD_LABELS, k) ? TICKET_FIELD_LABELS[k] : String(k);
    if (seen.indexOf(label) < 0) seen.push(label);
  }
  if (seen.length <= 1) return seen.join('');
  return seen.slice(0, -1).join(', ') + ' and ' + seen[seen.length - 1];
}

module.exports = {
  validateTicketFields,
  TICKET_FIELD_RULES,
  TICKET_FIELD_LABELS,
  ASSIGNEE_REFUSAL,
  ticketFieldDateOnly,
  ticketFieldComparable,
  sameTicketFieldValue,
  ticketAddressProblem,
  labelList,
};
