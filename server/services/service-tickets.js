// Service tickets — the pure decision layer.
//
// A service ticket is a WORK ORDER: dispatchable work with an owner, an
// address, a proposed scope and a lifecycle, raised on a job or a lead, with
// tasks hanging under it as the checklist of what has to happen.
//
// This module requires NOTHING — no pool, no express, no env. That is
// deliberate, and it is the same reason server/services/report-shares.js
// exists as its own file: the rules that decide what an anonymous stranger may
// see and change are the rules most worth unit testing, and tests that reach
// server/routes/* only pass where JWT_SECRET is set. Security logic therefore
// lives here, where it can be tested with no database and no secret.
'use strict';

const crypto = require('crypto');

// ── Ids ─────────────────────────────────────────────────────────────────
// Generated in JS, not the database — the convention every recent table in
// this repo uses (TEXT PRIMARY KEY, no SERIAL, no gen_random_uuid()).
function genId(prefix) {
  return String(prefix || 'st') + '_' + Date.now() + '_' +
    Math.random().toString(36).slice(2, 8);
}

// ── Token ───────────────────────────────────────────────────────────────
// 256 bits of entropy, hex — the same generator the report and task share
// links use.
const HEX64 = /^[a-f0-9]{64}$/;

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Tokens are stored HASHED. task_shares keeps the raw token in the row, so a
// leaked backup of that table hands over every live link; report_shares fixed
// that and this follows report_shares. sha256 with no salt is correct for this
// shape — the input already carries 256 bits of entropy, so it is not
// guessable and a per-row salt would only defeat a precomputation attack that
// cannot exist against random 256-bit inputs. Lookup stays one indexed
// equality on the hash.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function isWellFormedToken(token) {
  return HEX64.test(String(token || ''));
}

// ── Scope ───────────────────────────────────────────────────────────────
// 'view'    — read the work order. No write door exists at all.
// 'respond' — additionally FILE A FIELD REPORT: tick the checklist, append an
//             attributed note, upload site photos, move status forward within
//             the crew band. Every one of those is something the holder OWNS —
//             it is their work, their observation, their photograph.
// 'propose' — additionally SUBMIT A REVISION, which lands in
//             service_ticket_revisions as pending and never touches
//             service_tickets.
//
// There is deliberately NO 'edit', for the reason report-shares.js states: a
// bearer token has no identity — nothing distinguishes the person you sent it
// to from whoever they forwarded it to — so a direct edit could not be
// attributed, audited or undone against a subject.
//
// What the owner asked for, "editing potential from the share screen", is
// delivered by 'propose': the guest really does type into the scope and press
// Save. What they get is a proposal with their name on it, pending a PM's
// acceptance. That is also what the word "revise" means.
const SHARE_SCOPES = Object.freeze(['view', 'respond', 'propose']);
const SCOPE_RANK = Object.freeze({ view: 0, respond: 1, propose: 2 });

// An unrecognised scope means the NARROWEST thing, never the newest. A row
// written by a future build and read by an older one must narrow, not widen.
// normalizeScope('edit') === 'view' is the single most important line here.
function normalizeScope(scope) {
  const s = String(scope == null ? '' : scope).trim().toLowerCase();
  return SHARE_SCOPES.indexOf(s) >= 0 ? s : 'view';
}

function scopeAllows(scope, needed) {
  const have = SCOPE_RANK[normalizeScope(scope)];
  const want = SCOPE_RANK[normalizeScope(needed)];
  return have >= want;
}

// Financials are hidden unless the row EXPLICITLY says otherwise. Anything
// else — undefined, null, 0, 'false', a column added later that defaults NULL
// — hides. Only the literal boolean false reveals.
function hidesFinancials(share) {
  return !(share && share.hide_financials === false);
}

// ── Expiry ──────────────────────────────────────────────────────────────
const TTL_MIN_DAYS = 1;
const TTL_MAX_DAYS = 90;
const TTL_DEFAULT_DAYS = 30;

function clampTtlDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) return TTL_DEFAULT_DAYS;
  return Math.min(TTL_MAX_DAYS, Math.max(TTL_MIN_DAYS, Math.floor(n)));
}

// An ABSOLUTE expiry, computed once at mint. Not a sliding window: a link that
// renews itself every time it is opened never expires, which is the opposite
// of what an expiry is for.
function expiryFrom(days, now) {
  const base = now instanceof Date ? now.getTime() : (now || Date.now());
  return new Date(base + clampTtlDays(days) * 24 * 60 * 60 * 1000);
}

// ── Lifecycle ───────────────────────────────────────────────────────────
// draft → open → scheduled → in_progress → work_complete → approved → closed
// with cancelled reachable from any non-terminal state.
const TICKET_STATUSES = Object.freeze([
  'draft', 'open', 'scheduled', 'in_progress',
  'work_complete', 'approved', 'closed', 'cancelled',
]);

// Terminal for EVERY actor. Once here, token doors return 409 — the same
// "expires on completion" burn the task-share routes implement. Reopening is
// an authed PM action that writes a status_changed event.
const TERMINAL_STATUSES = Object.freeze(['closed', 'cancelled']);

const TICKET_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

function normalizeStatus(status) {
  const s = String(status == null ? '' : status).trim().toLowerCase();
  return TICKET_STATUSES.indexOf(s) >= 0 ? s : 'draft';
}

function normalizePriority(priority) {
  const p = String(priority == null ? '' : priority).trim().toLowerCase();
  return TICKET_PRIORITIES.indexOf(p) >= 0 ? p : 'normal';
}

function isTerminal(status) {
  return TERMINAL_STATUSES.indexOf(normalizeStatus(status)) >= 0;
}

// What a PM/admin may do. Everything forward, plus cancel from anywhere
// non-terminal, plus the two backward steps an office genuinely needs
// (draft ↔ open, and reopening a closed ticket).
const USER_TRANSITIONS = Object.freeze({
  draft:         ['open', 'cancelled'],
  open:          ['draft', 'scheduled', 'in_progress', 'cancelled'],
  scheduled:     ['open', 'in_progress', 'cancelled'],
  in_progress:   ['scheduled', 'work_complete', 'cancelled'],
  work_complete: ['in_progress', 'approved', 'cancelled'],
  approved:      ['work_complete', 'closed', 'cancelled'],
  closed:        ['open'],        // reopening is deliberate and audited
  cancelled:     ['open'],
});

// What a share-link holder may do. A STRICT SUBSET, forward-only, inside the
// crew band. A guest can never reach approved, closed or cancelled, and can
// never go back to draft or open. They are reporting on their own work, not
// administering the record.
const SHARE_TRANSITIONS = Object.freeze({
  draft:         [],              // a draft is not shareable at all
  open:          ['in_progress', 'work_complete'],
  scheduled:     ['in_progress', 'work_complete'],
  in_progress:   ['work_complete'],
  work_complete: [],              // the office decides what happens next
  approved:      [],
  closed:        [],
  cancelled:     [],
});

// actor is 'user' (an authenticated PM/admin) or 'share' (a token holder).
// Returns { ok } or { ok:false, reason } — the reason is shown to the caller,
// because a refused transition should say why rather than silently no-op.
function ticketMayTransition(from, to, actor) {
  const f = normalizeStatus(from);
  const t = String(to == null ? '' : to).trim().toLowerCase();
  if (TICKET_STATUSES.indexOf(t) < 0) {
    return { ok: false, reason: 'Unknown status.' };
  }
  if (f === t) return { ok: true };
  // Unknown actors are treated as the narrow one, never the privileged one.
  const table = actor === 'user' ? USER_TRANSITIONS : SHARE_TRANSITIONS;
  const allowed = table[f] || [];
  if (allowed.indexOf(t) < 0) {
    return {
      ok: false,
      reason: actor === 'user'
        ? 'A ticket cannot move from ' + f + ' to ' + t + '.'
        : 'This link cannot move the ticket from ' + f + ' to ' + t + '.',
    };
  }
  return { ok: true };
}

// A draft is not shareable: a link is a promise and a draft is not one.
function ticketMayBeShared(ticket) {
  const s = normalizeStatus(ticket && ticket.status);
  if (s === 'draft') {
    return { ok: false, reason: 'Issue the ticket before sharing it — a draft has no link.' };
  }
  if (isTerminal(s)) {
    return { ok: false, reason: 'This ticket is ' + s + '. Reopen it before sharing.' };
  }
  return { ok: true };
}

// ── Share lifecycle ─────────────────────────────────────────────────────
// Precedence is deliberate: revoked beats expired beats opened beats sent. A
// revoked share that has also expired reads 'revoked', because that is the
// fact the sender acted on.
function shareLifecycle(share, now) {
  if (!share) return 'unknown';
  const t = now instanceof Date ? now.getTime() : (now == null ? Date.now() : Number(now));
  if (share.revoked_at) return 'revoked';
  const exp = share.expires_at ? new Date(share.expires_at).getTime() : NaN;
  if (Number.isFinite(exp) && exp <= t) return 'expired';
  if (share.opened_at) return 'opened';
  return 'sent';
}

function shareIsUsable(share, now) {
  const s = shareLifecycle(share, now);
  return s === 'sent' || s === 'opened';
}

// ── Public projections ──────────────────────────────────────────────────
// WHITELISTS, not blacklists. The share table has no `document` snapshot — a
// work order is LIVE, so the guest read joins the ticket — which means a
// column added to service_tickets later would be visible to a stranger by
// default if this projected by exclusion. It projects by inclusion instead.

const PUBLIC_TICKET_KEYS = Object.freeze([
  'id', 'ticket_number', 'title', 'status', 'priority',
  'scope_proposed', 'checklist', 'guest_log',
  'site_contact_name', 'site_contact_phone',
  'street_address', 'city', 'state', 'zip', 'lat', 'lng',
  'access_notes', 'scheduled_for', 'due_date', 'created_at', 'updated_at',
]);

// scope_approved is the only field gated on hide_financials: it is where a
// priced, signed-off scope lands. internal_notes, assignee_user_id, created_by,
// organization_id, both parent ids and every timestamp the office uses to
// manage the ticket are absent from the whitelist entirely — not hidden, not
// reachable.
function publicTicket(ticket, share) {
  if (!ticket) return null;
  const out = {};
  for (const k of PUBLIC_TICKET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ticket, k)) out[k] = ticket[k];
  }
  if (!hidesFinancials(share)) out.scope_approved = ticket.scope_approved;
  return out;
}

const PUBLIC_SHARE_KEYS = Object.freeze(['id', 'scope', 'recipient_name', 'expires_at']);

// Never the token, never the hash, never the org id, never who minted it.
function publicShare(share) {
  if (!share) return null;
  const out = {};
  for (const k of PUBLIC_SHARE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(share, k)) out[k] = share[k];
  }
  out.scope = normalizeScope(share.scope);
  return out;
}

// ── What a token write may touch ────────────────────────────────────────

// The checklist a guest may return. The task-share precedent lets a guest
// REPLACE the whole array — rename items, add items, reorder, or wipe it with
// [] — while its own justification says "a named worker TICKING a defined
// checklist". The code permits authoring it. That gap is not carried forward.
//
// Only `done` flips land. Additions, deletions, reorders and text edits are
// dropped silently; the office owns what the list says, the guest owns whether
// each line is finished. Identity is matched by index AND text, so a guest who
// reorders cannot flip the wrong item.
function normalizeGuestChecklist(stored, incoming) {
  const base = Array.isArray(stored) ? stored : [];
  if (!Array.isArray(incoming)) return base.slice();
  return base.map(function (item, i) {
    const it = (item && typeof item === 'object') ? item : { text: String(item || ''), done: false };
    const cand = incoming[i];
    if (!cand || typeof cand !== 'object') return it;
    // Text must still match, or this is a reorder and the tick is meaningless.
    if (String(cand.text == null ? '' : cand.text) !== String(it.text == null ? '' : it.text)) {
      return it;
    }
    return Object.assign({}, it, { done: !!cand.done });
  });
}

// The office's checklist, on the authed path. The guest cap does not apply
// here; this only bounds and cleans what a PM saves.
const CHECKLIST_MAX_ITEMS = 50;
const CHECKLIST_MAX_TEXT = 500;

function normalizeChecklist(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (out.length >= CHECKLIST_MAX_ITEMS) break;
    const item = (raw && typeof raw === 'object') ? raw : { text: raw };
    const text = String(item.text == null ? '' : item.text).trim().slice(0, CHECKLIST_MAX_TEXT);
    if (!text) continue;
    out.push({ text: text, done: !!item.done });
  }
  return out;
}

// The attributed stamp prepended to an appended guest note. `who` falls back
// name → recipient email on file → the literal 'shared link', so the line is
// never anonymous. The caller concatenates this in SQL
// (guest_log = COALESCE(guest_log,'') || $n) rather than read-modify-write, so
// two guests writing at once cannot lose one another's note.
const GUEST_NOTE_MAX = 2000;

function guestNoteStamp(note, share) {
  const body = String(note == null ? '' : note).trim().slice(0, GUEST_NOTE_MAX);
  if (!body) return null;
  const who = (share && String(share.recipient_name || '').trim()) ||
              (share && String(share.recipient_email || '').trim()) ||
              'shared link';
  return '\n\n— ' + who + ' (via shared link): ' + body;
}

// A guest name is write-once: it labels every note they have already left, so
// letting it change would retroactively re-attribute them.
const GUEST_NAME_MAX = 120;

function guestNameUpdate(stored, incoming) {
  if (stored && String(stored).trim()) return null;   // already named
  const name = String(incoming == null ? '' : incoming).trim().slice(0, GUEST_NAME_MAX);
  return name || null;
}

// What a 'propose' revision may carry. Absent BY DESIGN: status,
// assignee_user_id, scope_approved, internal_notes, ticket_number, both parent
// ids, organization_id. A guest proposes what the WORK is, never who does it,
// where it is filed, or whether it is approved.
const PROPOSABLE_FIELDS = Object.freeze([
  'scope_proposed', 'title', 'priority', 'scheduled_for', 'due_date',
  'site_contact_name', 'site_contact_phone', 'access_notes',
]);

// Applied at BOTH emit time and apply time — never trust what was stored. A
// proposal containing only dropped keys returns {} and the route must answer
// 400, not a silent ok: an empty proposal that answers ok leaves the sender
// believing they were heard.
function filterProposedFields(fields, allow) {
  const src = (fields && typeof fields === 'object') ? fields : {};
  const permitted = Array.isArray(allow) && allow.length
    ? PROPOSABLE_FIELDS.filter(function (f) { return allow.indexOf(f) >= 0; })
    : PROPOSABLE_FIELDS;
  const out = {};
  for (const k of permitted) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

// ── Progress ────────────────────────────────────────────────────────────
// The honest work-completion number is the child tasks, not the status. The
// status is the ADMINISTRATIVE number and the two deliberately differ — a
// ticket can be 'approved' with tasks still open, and that disagreement is
// information rather than a bug.
function ticketProgress(ticket, tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const live = list.filter(function (t) { return t && !t.archived_at; });
  const done = live.filter(function (t) {
    return t.status === 'done' || t.status === 'complete' || !!t.completed_at;
  }).length;
  const status = normalizeStatus(ticket && ticket.status);
  return {
    status: status,
    terminal: isTerminal(status),
    step: Math.max(0, TICKET_STATUSES.indexOf(status)),
    tasksDone: done,
    tasksTotal: live.length,
  };
}

module.exports = {
  genId,
  genToken,
  hashToken,
  isWellFormedToken,
  SHARE_SCOPES,
  normalizeScope,
  scopeAllows,
  hidesFinancials,
  clampTtlDays,
  expiryFrom,
  TTL_MIN_DAYS,
  TTL_MAX_DAYS,
  TTL_DEFAULT_DAYS,
  TICKET_STATUSES,
  TICKET_PRIORITIES,
  TERMINAL_STATUSES,
  normalizeStatus,
  normalizePriority,
  isTerminal,
  ticketMayTransition,
  ticketMayBeShared,
  shareLifecycle,
  shareIsUsable,
  publicTicket,
  publicShare,
  normalizeChecklist,
  normalizeGuestChecklist,
  guestNoteStamp,
  guestNameUpdate,
  PROPOSABLE_FIELDS,
  filterProposedFields,
  ticketProgress,
};
