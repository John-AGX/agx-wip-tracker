// A global store must not be addressable by a caller-supplied key under a
// capability every tenant holds.
//
// WHAT WAS OPEN
// `app_settings` is a GLOBAL key/value table — `key TEXT PRIMARY KEY`, no
// organization_id, one row per key for the whole platform (db.js:1086).
// settings-routes.js addressed it by a caller-supplied key with no allowlist:
//
//   GET  /api/settings/:key   requireCapability('ESTIMATES_VIEW')  -> every PM
//   PUT  /api/settings/:key   requireCapability('ROLES_MANAGE')    -> every org admin
//
// So the key space WAS the attack surface. Verified live over HTTP:
//   · GET  /api/settings/vapid_keys   as a plain PM in either tenant -> 200,
//     the platform's VAPID PRIVATE KEY in cleartext. push.js:36-49 generates
//     and persists that pair into this table whenever the env vars are unset.
//   · GET  /api/settings/agent_skills as a plain PM -> 200, the whole
//     platform agent-playbook blob.
//   · PUT  /api/settings/agent_skills as an org-A admin -> 200. The route's
//     own preserveSkillIds then re-attached the real anthropic_skill_id, so
//     the injected body would ride the next managed/sync-all UPSTREAM.
//   · PUT  /api/settings/vapid_keys   as an org-A admin -> 200, platform push
//     keypair replaced.
//   · PUT  /api/settings/brand_new_key -> 200, arbitrary new global key.
//
// That last one is not cosmetic. db.js guards one-shot data migrations with
// SENTINEL rows in this table (`estimates_updated_at_reset_v1`,
// `ai_sessions_machine_label_null_v1`, and any future one): each runs only if
// its key is ABSENT. An open PUT lets any org admin pre-create a sentinel and
// suppress a migration for the whole platform, forever, silently.
//
// THE FIX IS THE CLASSIFICATION, NOT THE GATE
// Every key this codebase reads or writes is enumerated below and given a
// class. The route asks this module first and the database second, so an
// unauthorised caller never causes a read of the row — predicate before gate.
// The list is CLOSED: a key that is not named here is `internal`, which is
// never served and never written through the API. That is what closes the
// arbitrary-key-creation and sentinel-suppression arms at once.
//
//   'shared'    Config with no secret and no privilege in it, which every
//               tenant already reads out of one row today. Read ESTIMATES_VIEW
//               (the estimate preview renderer needs it), write ROLES_MANAGE.
//               STILL GLOBAL — see RESIDUALS below.
//   'platform'  Global config whose blast radius is the platform itself, or
//               that leaves the platform (Anthropic). SYSTEM_ADMIN both ways.
//   'own_door'  Has its own dedicated endpoint with its own gate. NEVER served
//               by the generic route — one door per key, so raising the gate on
//               the real door cannot be walked around here.
//   'secret'    Credential material. Never served and never written by ANY API
//               caller at ANY privilege. "Who may call it" and "should this
//               endpoint ever serve this value" are separate questions, and
//               this is the answer to the second one.
//   'internal'  Server-owned state — cron dedupe logs, migration sentinels.
//               Written by the process that owns it, never over HTTP.
//
// WHY `agent_skills` IS PLATFORM AND NOT SHARED
// It is one global row that becomes the platform's ANTHROPIC-ACCOUNT-WIDE
// native Skills, and the retire path beside it runs an unscoped
// `DELETE FROM managed_agent_skills` (no org column on that table either), so
// an org admin dropping a pack detached skills from the platform's agents for
// every tenant. The per-tenant skill surface already exists and is org-scoped:
// `org_skill_packs`. Org admins keep that one; this row is the operator's.
//
// WHY `proposal_template` / `bt_export_mapping` STAY AT ROLES_MANAGE
// Neither carries a secret or a privilege, both are documented in the admin UI
// as platform-wide ("Buildertrend cost-code mapping is platform-wide … not
// org-scoped", js/admin.js), and Admin -> Templates writes BOTH in one Save
// for org admins today. Raising them would trade a boundary for an outage on
// the two keys that do not carry the risk. They are named DELIBERATELY, which
// is the point of an allowlist: the decision is now written down.
//
// RESIDUALS THIS FILE CANNOT CLOSE (need a schema change — see the report)
//   · `app_settings` has no organization_id, so 'shared' really is shared:
//     org-A's admin still edits the proposal boilerplate and BT cost-code map
//     that org-B's estimates render with. Closing that means an org dimension
//     on the table, i.e. db.js.
//   · `vapid_keys` sitting in this table at all is the second-order defect:
//     a private key shares a key space with admin-editable config, so any
//     future generic reader over `app_settings` re-exposes it. The right home
//     is env-only or a dedicated table.
'use strict';

// Read/write classification for every key the codebase touches.
// Adding a setting means adding a line here — a key with no line is `internal`
// and unreachable, which is the safe default.
const KEY_CLASSES = {
  // ── shared: admin-editable boilerplate, no secret, no privilege ──────────
  proposal_template: {
    klass: 'shared', read: 'ESTIMATES_VIEW', write: 'ROLES_MANAGE',
    note: 'Proposal header / intro / about / exclusions / signature. Rendered by the estimate preview, so every ESTIMATES_VIEW holder reads it. Seeded in db.js.'
  },
  bt_export_mapping: {
    klass: 'shared', read: 'ESTIMATES_VIEW', write: 'ROLES_MANAGE',
    note: 'Project 86 btCategory -> Buildertrend cost code. Read by js/bt-export.js on every export. Seeded in db.js.'
  },

  // ── platform: one row, platform-wide blast radius ────────────────────────
  agent_skills: {
    klass: 'platform', read: 'SYSTEM_ADMIN', write: 'SYSTEM_ADMIN',
    note: 'Authoritative skill-pack array. Mirrors to Anthropic account-wide and its retire path detaches managed_agent_skills for every agent. Per-tenant equivalent is org_skill_packs.'
  },

  // ── own_door: a dedicated endpoint owns this key ─────────────────────────
  email: {
    klass: 'own_door', read: null, write: null,
    note: 'Global email config (per-event toggles, BCC lists, digest mode, quiet hours). Owned by GET/PUT /api/email/settings, which holds the BCC gate. Never reachable here — otherwise this route is a way around that gate.'
  },

  // ── secret: never served, never written, at any privilege ────────────────
  vapid_keys: {
    klass: 'secret', read: null, write: null,
    note: 'Web Push VAPID keypair including privateKey in cleartext. Self-generated and persisted by push.js when VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are unset. No API caller has a reason to read or write it.'
  },

  // ── internal: server-owned state, written by the process that owns it ────
  cert_expiry_log: {
    klass: 'internal', read: null, write: null,
    note: 'cert-expiry-cron.js dedupe ledger. Writing it suppresses expiry reminders platform-wide.'
  },
  reminders_log: {
    klass: 'internal', read: null, write: null,
    note: 'reminders-cron.js fire ledger. Writing it suppresses reminders platform-wide.'
  },
  weekly_digest_log: {
    klass: 'internal', read: null, write: null,
    note: 'weekly-digest-cron.js send ledger.'
  },
  ai_spend_alert_log: {
    klass: 'internal', read: null, write: null,
    note: 'ai-spend-cron.js alert ledger. Writing it suppresses spend alerts.'
  }
};

// Belt and braces, independent of the table above. A future edit to
// KEY_CLASSES — a typo, a merge, a well-meant "let system admins look at it" —
// must not be able to put credential material back on the wire. Checked first
// in both directions, so nothing below can grant it.
const NEVER_SERVED = new Set(['vapid_keys']);

// LOOK UP A DECLARED KEY, AND ONLY A DECLARED KEY.
//
// `KEY_CLASSES[key]` is not the same question as "is this key on the list".
// KEY_CLASSES is an ordinary object literal, so it inherits from
// Object.prototype, and the caller supplies the key. `KEY_CLASSES['constructor']`
// returns a function — truthy — and so did 'toString', 'valueOf',
// 'hasOwnProperty', '__proto__'. classOf then read `.klass` off it and
// returned UNDEFINED for those five, in flat contradiction of the sentence
// three lines above it and of the property the whole file exists to state:
// a key that is not named here is 'internal'.
//
// It was not exploitable — readCapabilityFor and writeCapabilityFor both go on
// to demand klass === 'shared' || 'platform', which undefined fails, so the
// route refused those keys anyway. But it was safe by ACCIDENT: the guard that
// saved it was written for a different reason, and any future caller that
// trusts classOf's stated contract (a permissive `if (classOf(k) !== 'secret')`
// would be the obvious one) inherits a hole. An allowlist that answers
// "undefined" for an input is not closed, whatever the callers happen to do.
//
// So the lookup asks for an OWN property, and the answer for everything else
// is the documented default.
function lookup(key) {
  if (typeof key !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(KEY_CLASSES, key) ? KEY_CLASSES[key] : null;
}

// The class of a key. An unknown key is 'internal': the allowlist is CLOSED,
// which is what makes `PUT /api/settings/brand_new_key` and pre-creating a
// db.js migration sentinel impossible rather than merely unlikely.
function classOf(key) {
  const entry = lookup(key);
  return entry ? entry.klass : 'internal';
}

// Capability required to READ this key through the generic settings route,
// or null when the route must never serve it. null is the answer for
// 'secret', 'internal', 'own_door', and every key not on the list.
function readCapabilityFor(key) {
  if (NEVER_SERVED.has(key)) return null;
  const entry = lookup(key);
  if (!entry) return null;
  if (entry.klass !== 'shared' && entry.klass !== 'platform') return null;
  return entry.read || null;
}

// Capability required to WRITE this key through the generic settings route,
// or null when the route must never write it.
function writeCapabilityFor(key) {
  if (NEVER_SERVED.has(key)) return null;
  const entry = lookup(key);
  if (!entry) return null;
  if (entry.klass !== 'shared' && entry.klass !== 'platform') return null;
  return entry.write || null;
}

// Is this key ON the list at all? classOf() answers 'internal' for both a
// DECLARED internal key (cert_expiry_log) and a key nobody has ever heard of,
// which is exactly right for the gate and exactly wrong for the audit row: one
// is a known server-owned key, the other is somebody walking the key space. The
// audit records the difference (and hashes the undeclared string rather than
// storing it — see server/audit.js hashId).
function isDeclaredKey(key) {
  return lookup(key) !== null;
}

module.exports = {
  KEY_CLASSES,
  NEVER_SERVED,
  classOf,
  isDeclaredKey,
  readCapabilityFor,
  writeCapabilityFor
};
