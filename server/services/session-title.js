// server/services/session-title.js — what a chat thread is CALLED.
//
// The bug this exists to kill (John, live pilot, 2026-08-16): the sidebar was
// painting `Deal · lead_1786497735707_d39nqj` and `Estimate e1786502505932`.
// Those are raw system ids on a user-facing surface, which the standing rule
// forbids outright — a thread is named for the lead or the job it is about.
//
// ── The governing split ────────────────────────────────────────────────────
// `ai_sessions.label` had been doing two incompatible jobs at once: holding a
// HUMAN-authored title (a rename, a first-message derive, an LLM auto-title)
// AND holding a MACHINE-derived display name (INITCAP(type) || ' ' || id).
// Every symptom followed from that collision — a machine string landed in the
// human column, and from then on nothing would touch it because it looked
// authored.
//
//   label          → human intent ONLY. NULL when nothing human exists.
//   display_label  → computed here, per response, NEVER stored.
//
// Resolving at READ time (not at write time) is deliberate:
//   • it heals the rows already broken — the entity reference (entity_type /
//     entity_id / lineage_root) survived on every one of them, so nothing has
//     to be re-derived into the table;
//   • it follows a rename — retitle a lead and its thread retitles;
//   • it costs ~one query per entity TYPE per page, not per row (see
//     resolveEntityLabels), on an endpoint already running a LATERAL subselect
//     per row. Adding a second, stored writer is exactly how a derived label
//     goes stale and freezes forever, so there is one source, not two.
//
// Everything here composes on top of resolveEntityLabels — no second lookup.
// That resolver is a dumb (type, id) → name map; this layer knows the three
// things it must not: the `Deal · ` prefix, the deal's stage preference, and
// when a stored label outranks a derived one.

'use strict';

const { resolveEntityLabels } = require('./entity-labels');

// Types resolveEntityLabels can actually answer for.
const RESOLVABLE = new Set(['lead', 'estimate', 'job', 'client', 'sub', 'project']);

// Never `undefined`, never `null`, never a raw id, and never "Session 137"
// (a DB serial is still an id). A named fallback per type so two unresolvable
// threads don't collapse into one look-alike row.
const TYPE_FALLBACK = {
  lead: 'Untitled lead',
  estimate: 'Untitled estimate',
  job: 'Untitled job',            // matches js/job-label.js DEFAULT_FALLBACK
  client: 'Untitled client',
  sub: 'Untitled sub',
  project: 'Untitled project'
};

// Non-entity threads are already human — leave them alone.
const GENERAL_TITLES = { general: 'General', '86': '86', ask86: 'Assistant' };

const DEAL_PREFIX = 'Deal · ';
const DEAL_FALLBACK = 'Deal';
const CHAT_FALLBACK = 'Untitled chat';
const MAX_LEN = 160;

// Control characters (C0 + DEL) collapse to a space. Tested by code point
// rather than a character class: a literal control byte in a regex literal
// is invisible in the diff that would review it.
function stripControls(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    out.push((c < 32 || c === 127) ? String.fromCharCode(32) : str.charAt(i));
  }
  return out.join(String.fromCharCode());
}

function initcap(s) {
  s = String(s || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// A title is user-entered text (a lead title, an estimate name) and it lands
// in three places with three different hazards: HTML (the client escapes it),
// a Content-Disposition filename (sanitised at that call site), and — the one
// worth naming — a TOOL RESULT read by an agent that holds write tools. So:
// one line, no control characters, bounded length. Prompt-injection hygiene,
// not XSS; escaping stays the renderer's job.
function sanitize(s) {
  if (s == null) return '';
  return stripControls(String(s)).replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
}

// Is this stored label machine-minted rather than authored?
//
// EXACT reconstruction of the strings the writers actually emit — not a
// heuristic "looks like an id" regex. That distinction is the whole ballgame:
// the narrow shape-detector this repo already carries (looksLikeSystemId,
// js/ai-panel.js) returns FALSE for "Estimate e1786502505932" and
// "Job j1786502505932" — the two strings in John's screenshot — while
// returning TRUE for "Fairways_bldg3", a perfectly good human title. Matching
// the literal mint patterns is under-inclusive on nothing and over-inclusive
// on nothing, by construction.
//
// The mints, all of them:
//   server/db.js boot backfill     → INITCAP(entity_type) || ' ' || entity_id
//                                  → INITCAP(entity_type)
//   ai-routes autoLabelFromContext → cap + ' ' + entityId
//   ai-routes deal mint            → 'Deal · ' + lineage_root
//
// "Let's look At the fire unit es…" — a real title sitting beside the broken
// ones in the same screenshot — matches none of these and is never touched.
function isMachineLabel(row) {
  const raw = row && row.label;
  if (raw == null || String(raw).trim() === '') return true;   // nothing authored
  const s = String(raw).trim();
  const t = String((row && row.entity_type) || '');
  const id = (row && row.entity_id != null) ? String(row.entity_id) : '';
  if (t && s === initcap(t)) return true;
  if (t && id && s === initcap(t) + ' ' + id) return true;
  if (id && s === DEAL_PREFIX + id) return true;
  if (row && row.lineage_root && s === DEAL_PREFIX + String(row.lineage_root)) return true;
  // A deal thread's title is the deal's IDENTITY, not a conversation summary,
  // so it tracks the entity. The deal mint is the only writer of the 'Deal · '
  // prefix, so any label carrying it is machine-minted by construction — a
  // user who renames the thread types something else, and that something else
  // is honoured.
  if (row && row.session_kind === 'deal_thread' && s.indexOf(DEAL_PREFIX) === 0) return true;
  return false;
}

// Which entity does this thread name itself after?
//
// For a deal thread that's the CURRENT stage, newest first — a deal that has
// become a job is called by its job number, not by the lead it started as.
// deal_memory.numbers carries exactly ONE of these (computeNumbers writes the
// current stage's id and no other), so this is a preference over a sparse
// object, not a chain over a dense one. When there is no deal_memory row yet
// (minted, never refreshed) we fall through to the stage stamped at mint.
function entityRefFor(row) {
  if (!row) return null;
  if (row.session_kind === 'deal_thread') {
    const n = (row.deal_numbers && typeof row.deal_numbers === 'object') ? row.deal_numbers : {};
    if (n.jobId) return { entity_type: 'job', entity_id: String(n.jobId) };
    if (n.estimateId) return { entity_type: 'estimate', entity_id: String(n.estimateId) };
    if (n.leadId) return { entity_type: 'lead', entity_id: String(n.leadId) };
    // root_type records what kind of id lineage_root is, so a reader never has
    // to infer it from the 'lead_' / 'e' / 'j' prefix (server/db.js).
    if (row.lineage_root && RESOLVABLE.has(String(row.deal_root_type || ''))) {
      return { entity_type: String(row.deal_root_type), entity_id: String(row.lineage_root) };
    }
  }
  const t = String(row.entity_type || '');
  if (!RESOLVABLE.has(t)) return null;
  const id = (row.entity_id == null) ? '' : String(row.entity_id).trim();
  // 'global' is the legacy sentinel a general session carries so
  // ai_messages.estimate_id (NOT NULL) is satisfied — not a real entity.
  if (!id || id === 'global') return null;
  return { entity_type: t, entity_id: id };
}

// Compose one row's display title from the batch-resolved label map.
function composeTitle(row, labels) {
  const ref = entityRefFor(row);
  let name = '';
  if (ref) {
    const got = labels.get(ref.entity_type + ':' + ref.entity_id);
    // `undefined` = no such row (deleted, or another tenant's — the resolver
    // is org-scoped). `''` = the row is there but has no name yet. Both land
    // on the named fallback; neither is ever allowed to become the id.
    name = sanitize(got) || (TYPE_FALLBACK[ref.entity_type] || '');
  }

  const authored = !isMachineLabel(row);

  if (row && row.session_kind === 'deal_thread') {
    // The 'Deal · ' prefix is intentional and stays — only the lineage key
    // after it was ever the problem.
    if (authored) return sanitize(row.label);
    return DEAL_PREFIX + (name || DEAL_FALLBACK);
  }

  if (authored) return sanitize(row.label);

  const t = String((row && row.entity_type) || '');
  if (GENERAL_TITLES[t]) return GENERAL_TITLES[t];
  return name || CHAT_FALLBACK;
}

// Attach `display_label` to every row, in place, using ONE resolveEntityLabels
// call for the whole page (which is itself one query per entity type, not per
// row). Returns the rows. Best-effort: a resolver failure leaves a sane
// fallback rather than 500-ing a sidebar fetch.
async function attachSessionTitles(orgId, rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  let labels = new Map();
  try {
    const refs = rows.map(entityRefFor).filter(Boolean);
    if (refs.length) labels = await resolveEntityLabels(orgId, refs);
  } catch (e) {
    console.warn('[session-title] label resolve failed:', e && e.message);
  }
  for (const r of rows) {
    if (!r) continue;
    try {
      r.display_label = composeTitle(r, labels);
    } catch (_) {
      r.display_label = CHAT_FALLBACK;
    }
  }
  return rows;
}

// Single-row convenience for the endpoints that return one session
// (POST / PATCH / GET :id / branch parent / export header).
async function attachSessionTitle(orgId, row) {
  if (!row) return row;
  await attachSessionTitles(orgId, [row]);
  return row;
}

module.exports = {
  attachSessionTitles,
  attachSessionTitle,
  // exported for tests
  isMachineLabel,
  entityRefFor,
  composeTitle,
  sanitize,
  TYPE_FALLBACK,
  CHAT_FALLBACK,
  DEAL_PREFIX
};
