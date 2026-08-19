'use strict';
// The ORG tier of the audit read path — GET /api/org/audit.
//
// A SEPARATE ROUTER, NOT A PARAMETER. The platform trail lives at
// /api/admin/console/audit behind requireSystemAdmin. This is a different
// route, a different gate, a different projection and a different WHERE clause,
// so no query-string mistake can widen one into the other. Adding
// `?org=` to the platform endpoint would have been fewer lines and one typo
// away from a cross-tenant read.
//
// ── THE TRAP THIS FILE EXISTS TO AVOID ──────────────────────────────────────
//
// `admin_audit_log.organization_id` is documented as the TARGET org, "nullable
// for platform-level ops". `roles` and `app_settings` are GLOBAL tables with no
// organization_id at all, so every capability change and every platform-config
// write lands with organization_id = NULL. That leaves a tenant-scoped reader
// two bad options and one good one:
//
//   WHERE organization_id = $1                      → misses the tenant's own
//                                                     events on global tables
//   WHERE organization_id = $1 OR organization_id IS NULL
//                                                   → hands EVERY org admin the
//                                                     entire platform trail
//   WHERE scope = 'org' AND organization_id = $1    → correct, no NULL arm
//
// The third is only expressible because `scope` is a column. THERE IS NO
// `organization_id IS NULL` ARM IN THIS FILE, and there must never be one.
//
// ── ALLOWLIST, NOT DENYLIST ─────────────────────────────────────────────────
//
// A denylist means every action added later is visible to tenants by default,
// and the first one that shouldn't be is a leak nobody wrote. The list below is
// closed: an action not named here is not served, whatever its scope.
//
// ── WHAT AN ORG ADMIN DELIBERATELY CANNOT SEE ───────────────────────────────
//
//   · another tenant's rows — no query shape here can produce one;
//   · platform configuration and secret access (scope='platform');
//   · `auth.login / denied / no_such_user` — that row names an identifier that
//     did not resolve to a user, and serving it would turn the tenant's own
//     audit into the account-existence oracle the login endpoint refuses to be.
//     Those rows carry no organization_id at all, so the scope predicate
//     already excludes them; this note is so nobody "fixes" that;
//   · `org.invite` — the organisation does not exist yet when an invitation is
//     issued, so the row is genuinely platform-scoped. The paired
//     `org.invite_accept` IS org-stamped and IS on the list;
//   · role/capability CHANGES. `roles` is global, so `role.update` is
//     scope='platform' and an org admin cannot see what the role their staff
//     hold is now allowed to do — or that one of their own people tried to
//     escalate. That is a real gap with an honest cause (a global roles table)
//     and a real fix (a per-org roles model) that is a different project. Org
//     tier covers WHO HOLDS WHICH ROLE, not WHAT THAT ROLE CAN DO.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability, resolveUserOrg } = require('../auth');

const router = express.Router();

// Closed. Adding a line here is a deliberate decision to show tenants a class
// of event, and every one of these is about a person inside their own company.
const ORG_VISIBLE_ACTIONS = [
  'user.create',
  'user.update',
  'user.role_change',
  'user.delete',
  'user.password_reset',
  'user.password_change',
  'user.self_update',
  'user.org_adopted',
  'user.act_as_start',
  'user.act_as_exit',
  'user.cross_tenant_write',
  'auth.login',
  'org.create',
  'org.invite_accept',
];

// A platform operator reaching into this tenant.
//
// Showing the row verbatim discloses the operator's identity, their home org id
// and their IP to the tenant. Showing nothing means a tenant cannot see that
// somebody outside their company reached into their data — which is the worse
// failure, because the entire purpose of handing them a trail is trust. So the
// row is shown through a SERVER-SIDE projection: what happened, to which
// record, when, and the literal actor string "platform operator".
function project(row) {
  if (row.action !== 'user.cross_tenant_write') return row;
  return {
    id: row.id,
    created_at: row.created_at,
    actor_kind: 'platform',
    actor_user_id: null,
    actor_email: 'platform operator',
    actor_role: null,
    on_behalf_of_user_id: null,
    on_behalf_of_email: null,
    action: row.action,
    outcome: row.outcome,
    reason: row.reason,
    target_type: row.target_type,
    target_id: row.target_id,
    organization_id: row.organization_id,
    ip: null,
    user_agent: null,
    detail: { door: row.detail && row.detail.door },
  };
}

// GET /api/org/audit
//   ?limit=  (1..200)      ?before_id=  keyset cursor, never OFFSET
//   ?action= ?outcome= ?target_type= ?target_id= ?from= ?to=
router.get('/audit', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    // The org comes from the caller's resolved tenant, NEVER from the query.
    // resolveUserOrg reads the signed claim and falls back to a lookup keyed on
    // the verified user id; there is no path by which a caller names their own
    // organization_id here.
    const org = await resolveUserOrg(req);
    if (!org || !org.id) {
      return res.status(403).json({ error: 'User is not associated with an organization.' });
    }

    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 100));
    const where = ["a.scope = 'org'", 'a.organization_id = $1', 'a.action = ANY($2::text[])'];
    const params = [org.id, ORG_VISIBLE_ACTIONS];
    let p = 3;

    if (req.query.action) {
      // Still intersected with the allowlist by the ANY() above — this only
      // narrows, it cannot widen.
      where.push('a.action = $' + p++); params.push(String(req.query.action));
    }
    if (req.query.outcome) { where.push('a.outcome = $' + p++); params.push(String(req.query.outcome)); }
    if (req.query.target_type) { where.push('a.target_type = $' + p++); params.push(String(req.query.target_type)); }
    if (req.query.target_id) { where.push('a.target_id = $' + p++); params.push(String(req.query.target_id)); }
    if (req.query.from) {
      const d = new Date(req.query.from);
      if (isNaN(d)) return res.status(400).json({ error: 'Bad from' });
      where.push('a.created_at >= $' + p++); params.push(d.toISOString());
    }
    if (req.query.to) {
      const d = new Date(req.query.to);
      if (isNaN(d)) return res.status(400).json({ error: 'Bad to' });
      where.push('a.created_at <= $' + p++); params.push(d.toISOString());
    }
    // Keyset, not OFFSET. At a million rows OFFSET 900000 reads 900,000 rows to
    // throw them away; `id < cursor` on a descending index reads `limit` of
    // them. id is BIGSERIAL so it orders identically to created_at.
    if (req.query.before_id) {
      const before = parseInt(req.query.before_id, 10);
      if (!Number.isFinite(before)) return res.status(400).json({ error: 'Bad before_id' });
      where.push('a.id < $' + p++); params.push(before);
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT a.id, a.created_at, a.actor_kind, a.actor_user_id, a.actor_email, a.actor_role,
              a.on_behalf_of_user_id, a.on_behalf_of_email,
              a.action, a.outcome, a.reason, a.target_type, a.target_id,
              a.organization_id, a.ip, a.user_agent, a.detail
         FROM admin_audit_log a
        WHERE ${where.join(' AND ')}
        ORDER BY a.id DESC
        LIMIT $${p}`,
      params
    );

    const entries = rows.map(project);
    res.json({
      entries: entries,
      next_before_id: entries.length === limit ? entries[entries.length - 1].id : null,
      organization_id: org.id,
    });
  } catch (e) {
    console.error('GET /api/org/audit error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.ORG_VISIBLE_ACTIONS = ORG_VISIBLE_ACTIONS;
