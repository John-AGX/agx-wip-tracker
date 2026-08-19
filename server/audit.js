// Project 86 — the privileged-action trail. ONE writer, one row shape.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE QUESTION THIS FILE EXISTS TO ANSWER
//
// A private key sat in `app_settings` readable by any PM for seven weeks. Asked
// "if no one got the keys yet, is it safe now?", the honest answer was WE
// CANNOT TELL: no request logging, no audit row on the settings GET, and
// Railway's platform log does not reach seven weeks. The security answer had to
// be reasoned from who could plausibly have bothered, not from evidence.
//
// The acceptance test for everything below is one sentence: would the trail
// answer that question? Under this module a privileged read of a secret key
// writes a row naming actor, IP, browser and time — whether it SUCCEEDED or was
// REFUSED — so the query returns either an evidenced empty set ("nobody touched
// it") or N rows naming exactly who. Either is an answer. That is why this
// audits the READ and not only the write, and the REFUSAL and not only the
// success.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS RECORDED, AND WHAT DELIBERATELY IS NOT
//
// TARGETED, NOT TOTAL. The trigger is the AUTHORITY USED, not the person. If an
// action requires SYSTEM_ADMIN, requires ROLES_MANAGE over a global/platform
// resource, crosses a tenant boundary, reads or writes a credential or platform
// config, destroys data irreversibly, or changes who can log in — it is
// recorded. Opening a job, reading an estimate, editing a line item is NOT, and
// there is no route here that can record one.
//
// SHAPE, NOT CONTENTS. `detail` carries counts, booleans, enum codes, the NAMES
// of fields that changed, and blast-radius numbers. Never request or response
// bodies, never money, never client PII, never key material. An audit trail
// that copies sensitive payloads into a second table has MOVED the exposure,
// not reduced it — and unlike app_settings, this table is one an operator
// legitimately reads all day. redactDetail() below enforces that by denylist,
// because the next twenty call sites will not be written by whoever wrote the
// first twenty.
//
// ─────────────────────────────────────────────────────────────────────────────
// NEVER FAIL SILENT — THE TWO TIERS
//
// An audit insert that throws while the operation proceeds gives you an
// UNLOGGED privileged action, which is worse than no trail at all: the empty
// log now reads as "nothing happened".
//
//   TIER A — FAIL CLOSED. auditCritical() / auditedTransaction(). The row is
//     written inside the operation's transaction, or awaited-and-checked
//     immediately before the irreversible step. If it cannot be written the
//     OPERATION IS REFUSED. Safe precisely because every tier-A action is a
//     rare operator-initiated op with a human present: the cost of refusing is
//     a retry, the cost of performing it unrecorded is permanent.
//
//   TIER B — FAIL LOUD. auditLog(). The operation proceeds; a failed write
//     prints the COMPLETE redacted row to stdout under [AUDIT-FAIL] and bumps a
//     counter the Command Center surfaces. Blocking a LOGIN because an insert
//     failed is a self-inflicted outage and an availability attack — anyone who
//     can pressure the pool could lock every user out. Refusing a REFUSAL
//     because it could not be logged is incoherent for the same reason.
//
// Every audited event ALSO emits `[AUDIT] {json}` to stdout at write time,
// regardless of DB outcome. Railway's retention did not reach seven weeks, so
// stdout is the FALLBACK, never the trail — but it is the only reason a tier-B
// DB failure is tolerable.
//
// ─────────────────────────────────────────────────────────────────────────────
// FOUR THINGS THE ROW SHAPE FIXES
//
// 1. `outcome` (ok | denied | error | attempted). The table could previously
//    only record things that HAPPENED. The seven-week question is mostly about
//    things that were ATTEMPTED. A denial row is the enumeration signal.
//    `attempted` exists for irreversible ops with no joinable transaction (an
//    upstream Anthropic delete, a hard org reset): the attempted row is written
//    fail-closed BEFORE the point of no return, and a paired ok/error row
//    follows. An `attempted` with no terminal partner means the process died
//    mid-operation, which is itself the thing you want to see. Stamping `ok`
//    before the fact would be a row that asserts a write that never happened.
//
// 2. `scope` (platform | org). `roles` and `app_settings` are GLOBAL tables
//    with no organization_id, so every capability change and platform-config
//    write logs organization_id = NULL. A tenant reader doing
//    `WHERE organization_id = $1` silently misses them; adding
//    `OR organization_id IS NULL` hands every org admin the entire platform
//    trail. `scope` makes the correct predicate expressible with NO NULL ARM.
//
// 3. `on_behalf_of_user_id`. requireAuth already computes req.actingAs, but the
//    old writer read only u.id/email/role — so a role change made under an
//    act-as disguise was byte-identical to one made openly. Populated here, so
//    one change covers every call site. The ACTOR stays the real human, always.
//
// 4. `actor_kind` + auditActor(). The old writer resolved everything from
//    req.user, so the highest-value unaudited events in the codebase — the
//    unauthenticated invite-accept that creates an org AND its first admin, the
//    magic-link claim that mints a user — could only have been wired by logging
//    a NULL actor. A row that logs a null actor is worse than no row, because
//    it looks like coverage. A typed actor_kind ('invite' | 'guest' | 'system'
//    | 'anonymous') says WHY there is no user id.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LOG MUST NOT BECOME THE NEXT LEAK
//
// Never key material, passwords, tokens, hashes, cookies or JWTs. Never a money
// figure. Never third-party PII. The emails that DO appear are actor/target
// IDENTITIES — that is the record, not a payload — which means this table is
// already a PII store and inherits every access control that implies.
//
// Caller-controlled strings never land raw. An undeclared settings key and an
// unrecognised login identifier are both collapsed to a sha8 by the CALL SITE
// (see hashId below): enumeration stays detectable and aggregatable without
// turning the trail into a log-injection surface, and without a mistyped
// password in the email field becoming a permanent cleartext credential.

const crypto = require('crypto');
const { pool } = require('./db');

// ── Tier table — the failure contract, keyed on the ACTION ──────────────────
// Tier is a property of the action, not of the call site, so it cannot drift
// between two places that emit the same name. A call site may pass `tier`
// explicitly for a variable-risk action (a settings write is tier A for a
// platform key and tier B for shared boilerplate).
const TIER_A_ACTIONS = new Set([
  // privilege
  'role.create', 'role.update', 'role.delete',
  'user.role_change', 'user.org_adopted', 'user.delete',
  'user.act_as_start',
  'user.cross_tenant_write',
  // secrets / platform config
  'settings.write', 'email.settings_write', 'push.vapid_rotate',
  // destructive / upstream
  'org.hard_reset', 'org.fresh_reset',
  'anthropic.skill_delete', 'anthropic.skill_create',
  'platform.data_export',
  // lifecycle
  'org.create', 'org.archive', 'org.invite_accept',
  // the one path that can erase evidence
  'audit.purge',
]);

const OUTCOMES = new Set(['ok', 'denied', 'error', 'attempted']);

function tierFor(entry) {
  if (entry && entry.tier === 'A') return 'A';
  if (entry && entry.tier === 'B') return 'B';
  return TIER_A_ACTIONS.has(entry && entry.action) ? 'A' : 'B';
}

// ── Redaction ───────────────────────────────────────────────────────────────
// Rule 4 has to survive the next twenty call sites. Any detail key that looks
// like credential material is dropped and replaced with a marker, recursively,
// before the row is serialised for EITHER destination (table or stdout).
const DETAIL_DENY = /pass|secret|token|key|private|credential|hash|bcrypt|jwt|cookie|authorization|bearer/i;
// Keys that trip the denylist but are the deliberate SHAPE record, not contents.
const DETAIL_ALLOW = new Set([
  'key_class', 'key_sha8', 'key_count', 'keys_changed', 'skill_key', 'agent_key',
]);
const DETAIL_MAX_BYTES = 4096;

let _redactions = 0;

function redactDetail(value, depth) {
  const d = depth || 0;
  if (value == null || d > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redactDetail(v, d + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const k of Object.keys(value)) {
    if (!DETAIL_ALLOW.has(k) && DETAIL_DENY.test(k)) {
      out[k] = '<redacted:' + k + '>';
      _redactions++;
      console.error('[AUDIT-REDACT] dropped detail key "' + k + '" — credential-shaped keys never enter the trail');
      continue;
    }
    out[k] = redactDetail(value[k], d + 1);
  }
  return out;
}

// A stable, non-reversing handle for a caller-controlled identifier. Used for
// undeclared settings keys and unrecognised login identifiers: two attempts on
// the same string aggregate, and neither the string nor a mistyped password
// survives into the row.
function hashId(s) {
  if (s == null) return null;
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

// ── Denial coalescing ───────────────────────────────────────────────────────
// A loop can write thousands of denial rows. At most one row per
// (actor, action, target, outcome) per 5 minutes; the next row that lands
// carries detail.repeat_count. NEVER rate-limits the operation, only the row,
// and NEVER touches a tier-A row or a successful one — a successful secret read
// is the single row that must never be deduplicated.
//
// The map is keyed partly on attacker-controlled input (the login path lets a
// stranger vary the identifier), so it is a HARD-CAPPED LRU, not a Map that
// grows. Hitting the cap emits its own uncoalesced row.
//
// It is also IN-PROCESS: on a multi-replica deploy the window is per-replica
// and resets on every restart, so repeat_count is a FLOOR, never a total.
const COALESCE_WINDOW_MS = 5 * 60 * 1000;
const COALESCE_MAX_KEYS = 500;
const _coalesce = new Map(); // key -> { first: ms, count: n }
let _coalesceOverflows = 0;

function coalesceKey(row) {
  return [row.actor_user_id == null ? (row.actor_email || row.actor_kind || '?') : 'u' + row.actor_user_id,
    row.action, row.target_type || '', row.target_id || '', row.outcome].join('|');
}

// Returns null to write the row, or a number of suppressed repeats folded into
// the row about to be written.
function coalesceCheck(row, now) {
  if (row.tier === 'A') return { write: true, repeats: 0 };
  if (row.outcome === 'ok') return { write: true, repeats: 0 };
  const key = coalesceKey(row);
  const hit = _coalesce.get(key);
  if (hit && (now - hit.first) < COALESCE_WINDOW_MS) {
    hit.count++;
    _coalesce.delete(key); _coalesce.set(key, hit);   // LRU touch
    return { write: false, repeats: hit.count };
  }
  const repeats = hit ? hit.count : 0;
  _coalesce.delete(key);
  if (_coalesce.size >= COALESCE_MAX_KEYS) {
    // Evict oldest. Map preserves insertion order and every touch re-inserts.
    const oldest = _coalesce.keys().next();
    if (!oldest.done) _coalesce.delete(oldest.value);
    _coalesceOverflows++;
  }
  _coalesce.set(key, { first: now, count: 0 });
  return { write: true, repeats: repeats };
}

// Test seam — a suite that asserts coalescing must be able to start clean.
function _resetCoalescer() { _coalesce.clear(); _coalesceOverflows = 0; }

// ── Health — a silently failing audit must be visible on a dashboard ────────
const _health = { write_failures: 0, last_failure_at: null, last_failure_action: null };
function auditHealth() {
  return {
    write_failures: _health.write_failures,
    last_failure_at: _health.last_failure_at,
    last_failure_action: _health.last_failure_action,
    redactions: _redactions,
    coalescer_keys: _coalesce.size,
    coalescer_overflows: _coalesceOverflows,
  };
}

// ── Actor resolution ────────────────────────────────────────────────────────
// `source` is either an express req (the common case) or an explicit actor
// descriptor for the paths where there is no req.user and never will be:
//
//   { actorKind: 'invite',    actorLabel: 'invited@example.com', orgId, ip, ua }
//   { actorKind: 'guest',     actorLabel: 'sub@example.com', ... }
//   { actorKind: 'system',    actorLabel: 'reminders-cron' }
//   { actorKind: 'anonymous', actorLabel: null }
//
// Wiring one of those paths through the req-shaped entry point would log a NULL
// actor, which looks like coverage and is not.
function isReq(source) {
  return !!(source && (source.headers || source.cookies || source.user || source.method));
}

function clientIp(req) {
  if (!req) return null;
  // index.js sets `app.set('trust proxy', 2)`, so req.ip is the real client
  // behind Railway's edge + the app proxy. XFF is the fallback for a direct
  // hit. This column is the "from where" half of the record — see the note in
  // the report about the two stale "trust proxy=1" comments this replaced.
  return req.ip
    || (req.headers && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())
    || (req.connection && req.connection.remoteAddress)
    || null;
}

function requestId(req) {
  if (!req) return null;
  if (!req._auditRequestId) {
    req._auditRequestId = 'r_' + crypto.randomBytes(4).toString('hex');
  }
  return req._auditRequestId;
}

function trunc(v, n) {
  if (v == null) return null;
  const s = String(v);
  return s.length > n ? s.slice(0, n) : s;
}

function buildRow(source, entry) {
  const e = entry || {};
  const req = isReq(source) ? source : null;
  const desc = req ? null : (source || {});
  const u = (req && req.user) || {};

  const outcome = OUTCOMES.has(e.outcome) ? e.outcome : 'ok';
  const tier = tierFor(e);
  // organization_id is the TARGET org. scope says whether this event belongs to
  // a tenant AT ALL — a platform-level op has no tenant, and must never be
  // reachable through an org-scoped read.
  const orgId = e.organizationId != null ? e.organizationId
    : (desc && desc.orgId != null ? desc.orgId : null);
  const scope = e.scope || (orgId != null ? 'org' : 'platform');

  // The disguise. req.actingAs is set by requireAuth only when the token
  // carries acting_as_user_id AND the real caller still passes the live
  // SYSTEM_ADMIN predicate. The actor stays the real human.
  const acting = (req && req.actingAs) || null;

  return {
    actor_kind: req ? 'user' : trunc((desc && desc.actorKind) || 'anonymous', 32),
    actor_user_id: req ? (u.id || null) : ((desc && desc.actorUserId) || null),
    actor_email: req ? (u.email || null) : trunc((desc && desc.actorLabel) || null, 256),
    actor_role: req ? (u.role || null) : null,
    actor_org_id: req ? (u.organization_id || null) : ((desc && desc.actorOrgId) != null ? desc.actorOrgId : null),
    on_behalf_of_user_id: acting ? (acting.id || null) : null,
    on_behalf_of_email: acting ? (acting.email || null) : null,
    action: trunc(e.action, 128),
    outcome: outcome,
    reason: trunc(e.reason, 64),
    tier: tier,
    scope: scope,
    target_type: trunc(e.targetType, 64),
    target_id: trunc(e.targetId, 256),
    organization_id: orgId,
    detail: e.detail !== undefined ? redactDetail(e.detail, 0) : null,
    ip: req ? clientIp(req) : ((desc && desc.ip) || null),
    user_agent: trunc(req ? (req.headers && req.headers['user-agent']) : (desc && desc.ua), 256),
    request_id: req ? requestId(req) : ((desc && desc.requestId) || null),
  };
}

const INSERT_SQL =
  `INSERT INTO admin_audit_log
     (actor_kind, actor_user_id, actor_email, actor_role, actor_org_id,
      on_behalf_of_user_id, on_behalf_of_email,
      action, outcome, reason, tier, scope,
      target_type, target_id, organization_id, detail, ip, user_agent, request_id)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19)`;

function paramsOf(row) {
  let detailJson = row.detail !== null && row.detail !== undefined ? JSON.stringify(row.detail) : null;
  if (detailJson && detailJson.length > DETAIL_MAX_BYTES) {
    // A detail that big is the copied-payload failure mode arriving. Keep the
    // row (the row is the evidence) and record that the shape was oversized.
    detailJson = JSON.stringify({ _truncated: true, bytes: detailJson.length });
  }
  return [
    row.actor_kind, row.actor_user_id, row.actor_email, row.actor_role, row.actor_org_id,
    row.on_behalf_of_user_id, row.on_behalf_of_email,
    row.action, row.outcome, row.reason, row.tier, row.scope,
    row.target_type, row.target_id, row.organization_id, detailJson, row.ip, row.user_agent, row.request_id,
  ];
}

// The single write. Every public entry point funnels here, so the row shape
// cannot drift between call sites.
async function writeRow(row, opts) {
  const runner = (opts && opts.client) ? opts.client : pool;
  await runner.query(INSERT_SQL, paramsOf(row));
}

// ── Public entry points ─────────────────────────────────────────────────────

// TIER B — FAIL LOUD. Never rejects. Callers fire-and-forget or await; either
// way the operation proceeds and a failure screams to stdout with the COMPLETE
// row, so the evidence survives in the platform log even when the table does
// not.
async function auditLog(source, entry, opts) {
  const row = prepare(source, entry);
  if (!row) return;
  try {
    if (row._write) await writeRow(row, opts);
  } catch (e) {
    _health.write_failures++;
    _health.last_failure_at = new Date().toISOString();
    _health.last_failure_action = row.action;
    // The whole row, not just the action name: a bare action name tells you a
    // record was lost but not what it said.
    console.error('[AUDIT-FAIL]', JSON.stringify(Object.assign({ error: e && e.message }, publicRow(row))));
  }
}

// TIER A — FAIL CLOSED. Rejects when the row cannot be written, so the caller
// refuses the operation. Use it awaited, immediately before the irreversible
// step, or with { client } inside the operation's own transaction.
async function auditCritical(source, entry, opts) {
  const row = prepare(source, entry);
  if (!row) throw new Error('audit: refusing to record an entry with no action');
  try {
    await writeRow(row, opts);
  } catch (e) {
    _health.write_failures++;
    _health.last_failure_at = new Date().toISOString();
    _health.last_failure_action = row.action;
    console.error('[AUDIT-FAIL]', JSON.stringify(Object.assign({ error: e && e.message, fail_closed: true }, publicRow(row))));
    const err = new Error('AUDIT_WRITE_FAILED');
    err.auditFailure = true;
    err.cause = e;
    throw err;
  }
}

// TIER A, the strongest form. Runs `work(client)` and the audit insert in ONE
// transaction: both commit or neither does. This is the only shape that cannot
// produce an audit row for a rolled-back operation, or a completed operation
// with no row. `entry` may be a function of the work's return value, so the row
// can carry blast-radius counts the work computed.
async function auditedTransaction(source, entryOrFn, work, opts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    const entry = typeof entryOrFn === 'function' ? entryOrFn(result) : entryOrFn;
    await auditCritical(source, entry, Object.assign({}, opts, { client: client }));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

// Build an explicit actor descriptor that still carries the request's "from
// where". Login, invite-accept and magic-link claim all have a real HTTP
// request and no req.user — passing the req alone would log actor_kind 'user'
// with a NULL id, which is the shape that looks like coverage and is not.
function actorFromRequest(req, actor) {
  const a = actor || {};
  return {
    actorKind: a.actorKind || 'anonymous',
    actorLabel: a.actorLabel != null ? a.actorLabel : null,
    actorUserId: a.actorUserId != null ? a.actorUserId : null,
    actorOrgId: a.actorOrgId != null ? a.actorOrgId : null,
    orgId: a.orgId != null ? a.orgId : null,
    ip: clientIp(req),
    ua: req && req.headers ? req.headers['user-agent'] : null,
    requestId: requestId(req),
  };
}

// Explicit-actor form for the paths that have no req.user and never will:
// invite accept, magic-link claim, guest task share, cron/worker jobs.
function auditActor(actor, entry, opts) {
  return auditLog(actor || { actorKind: 'anonymous' }, entry, opts);
}
function auditActorCritical(actor, entry, opts) {
  return auditCritical(actor || { actorKind: 'anonymous' }, entry, opts);
}

// Shared preamble: build, validate, mirror to stdout, decide coalescing.
function prepare(source, entry) {
  if (!entry || !entry.action) {
    console.error('[AUDIT-FAIL]', JSON.stringify({ error: 'entry with no action', entry: entry || null }));
    return null;
  }
  const row = buildRow(source, entry);
  const c = coalesceCheck(row, Date.now());
  if (c.repeats) {
    row.detail = Object.assign({}, row.detail || {}, { repeat_count: c.repeats, repeat_count_is_floor: true });
  }
  row._write = c.write;
  // The stdout mirror fires for EVERY audited event at write time, whatever the
  // database then does. Suppressed repeats still print, so the platform log
  // keeps the full sequence even when the table keeps one row per window.
  console.log('[AUDIT]', JSON.stringify(publicRow(row)));
  return row;
}

function publicRow(row) {
  const out = {};
  for (const k of Object.keys(row)) if (k !== '_write') out[k] = row[k];
  return out;
}

module.exports = {
  auditLog,
  auditCritical,
  auditedTransaction,
  auditActor,
  auditActorCritical,
  actorFromRequest,
  auditHealth,
  hashId,
  redactDetail,
  TIER_A_ACTIONS,
  _resetCoalescer,
};
