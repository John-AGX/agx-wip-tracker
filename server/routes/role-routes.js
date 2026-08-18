const express = require('express');
const { pool } = require('../db');
const {
  requireAuth, requireRole, CAPABILITY_KEYS,
  refreshRoleCache, requireCapability, hasCapability
} = require('../auth');
const { auditLog } = require('../audit');

const router = express.Router();

// ── A privilege gate must not be settable by the privilege it gates ────────
//
// WHAT WAS OPEN
// Every door in this file is gated on ROLES_MANAGE, which EVERY org admin
// holds (db.js BUILTIN_ROLES: the `admin` builtin carries it). POST / and
// PUT /:name filtered submitted capabilities against CAPABILITY_KEYS — a list
// that INCLUDES `SYSTEM_ADMIN` — and asked nothing about the caller. So a
// plain org admin could
//
//     PUT /api/roles/admin  { capabilities: [...existing, 'SYSTEM_ADMIN'] }
//
// and hold SYSTEM_ADMIN before the response was written: the handler calls
// refreshRoleCache() itself, so the grant takes effect inside the same
// request. `POST /` with a fresh role carrying it worked the same way.
//
// WHY IT OUTRANKS AN ORDINARY CAPABILITY BUG
// SYSTEM_ADMIN is the anchor of the whole tenant boundary: it is the audited
// cross-tenant crossing arm in services/user-org-scope.js, what
// requireSystemAdmin and POST /api/auth/act-as key on, and what the narrowed
// org-bucket bypass defers to. And because `roles` is a GLOBAL table (see the
// note on the table below), the grant landed for every tenant's admins at
// once.
//
// auth-routes.js:511 (validateRoleAssignment) already refuses to ASSIGN a
// SYSTEM_ADMIN-carrying role to a user unless the caller holds SYSTEM_ADMIN.
// The guard existed on one side of the pair and not the other; this is the
// other side. Together they close the two-step: escalate the role, then pin
// the escalation into a user row where the next boot's seed can't undo it.
//
// TWO-SIDED, AND STATED ON THE ROLE RATHER THAN ON THE DELTA
// Refusing only the ADD would leave the REMOVE open, and on a global table
// that is its own cross-tenant attack: a non-holder could
// `PUT /api/roles/system_admin { capabilities: [] }` and strip the platform
// owner of the capability every cross-tenant door keys on — from inside any
// tenant. So the rule is:
//
//   A role that carries SYSTEM_ADMIN — before the write or after it — may
//   only be created, modified, or deleted by a caller who holds SYSTEM_ADMIN.
//
// WHAT THIS DELIBERATELY DOES NOT CHANGE
// A holder is unaffected: a system admin still edits every role. And an org
// admin still edits every role that does NOT carry SYSTEM_ADMIN, including
// the `admin` builtin (which does not carry it — db.js marks the omission
// "SYSTEM_ADMIN intentionally absent") and every custom role. The documented
// product behaviour — "admins can tweak which caps a PM has" — is intact.
//
// WHAT IT DOES NOT REACH: `roles` HAS NO organization_id.
// `name` is the primary key, the table is global, and auth.js `_roleCache`
// keys on the role NAME alone. One tenant editing `pm` changes what every
// other tenant's PMs may do, and db.js re-asserts capabilities on boot for
// only `admin` and `system_admin` — so a strip of `pm` / `corporate` /
// `field_crew` / `sub` is permanent. That is a per-org-roles change (schema +
// migration + re-keying `_roleCache` and therefore every hasCapability call
// site) and is deliberately not attempted here. See the report.
const SYSTEM_ADMIN_CAP = 'SYSTEM_ADMIN';

function carriesSystemAdmin(caps) {
  return Array.isArray(caps) && caps.indexOf(SYSTEM_ADMIN_CAP) !== -1;
}

// Returns { status, error } to answer with, or null to proceed.
// `submittedCaps` may be null (the body left capabilities alone);
// `existingCaps` may be null (the role does not exist yet).
function systemAdminRoleGuard(callerUser, submittedCaps, existingCaps) {
  if (hasCapability(callerUser, SYSTEM_ADMIN_CAP)) return null;
  if (carriesSystemAdmin(submittedCaps)) {
    return {
      status: 403,
      error: 'Only a system administrator can grant the "' + SYSTEM_ADMIN_CAP + '" capability.'
    };
  }
  if (carriesSystemAdmin(existingCaps)) {
    return {
      status: 403,
      error: 'Only a system administrator can change a role that carries the "' + SYSTEM_ADMIN_CAP + '" capability.'
    };
  }
  return null;
}

// GET /api/roles/capabilities — list all capability keys + display metadata.
// Available to any authenticated user so the admin Roles UI can render the
// checkbox list. The keys themselves are not sensitive.
router.get('/capabilities', requireAuth, (req, res) => {
  res.json({ capabilities: CAPABILITY_KEYS });
});

// GET /api/roles — the role list.
//
// WHAT WAS OPEN. `requireAuth` and nothing else, over a table with no
// organization_id. Verified live: an org-A PM received a seeded org-B CUSTOM
// role by name, label, description and full capability array. A `sub` in the
// contractor portal got the same list. That is another tenant's internal
// org-design handed to anyone with a login — and, for an attacker, a map of
// exactly which named role to aim the (now-closed) escalation at.
//
// WHAT CLOSES WITHOUT PER-ORG ROLES. The leak is not the table being global —
// that needs a schema change — it is that the FULL list goes to callers who
// have no use for it. Only two consumers exist, and they want different things:
//
//   js/auth.js loadCapabilities()  finds the caller's OWN role by name and
//                                  reads its capability array. One row.
//   js/admin.js Roles tab (ROLES_MANAGE) and the New/Edit User role dropdown
//                                  (USERS_MANAGE) want the whole list.
//
// So: an administrator of either kind gets the list unchanged, and everyone
// else — PM, corporate, field crew, sub — gets exactly their own role. Nobody
// loses a capability they could act on, and the recon surface goes to zero for
// every non-admin session, which is nearly all of them.
//
// WHAT THIS DOES NOT REACH. `roles` is still global, so two org admins still
// see each other's custom roles. Filtering that needs an organization_id on the
// table and a re-keyed _roleCache — per-org roles, deliberately not attempted
// here. See the report.
router.get('/', requireAuth, async (req, res) => {
  try {
    // Predicate before gate: decide WHICH rows this caller may see, then ask
    // the database for those and no others. A narrowed caller never causes a
    // read of another tenant's row at all.
    const isRoleAdmin = hasCapability(req.user, 'ROLES_MANAGE') ||
                        hasCapability(req.user, 'USERS_MANAGE');
    if (!isRoleAdmin) {
      // An absent / unknown role yields an empty list, which is what
      // loadCapabilities already treats as "no capabilities" — a closed gate.
      const own = await pool.query(
        'SELECT name, label, description, builtin, capabilities, created_at, updated_at FROM roles WHERE name = $1',
        [req.user && req.user.role ? req.user.role : '']
      );
      return res.json({ roles: own.rows });
    }
    const { rows } = await pool.query(
      'SELECT name, label, description, builtin, capabilities, created_at, updated_at FROM roles ORDER BY builtin DESC, label'
    );
    res.json({ roles: rows });
  } catch (e) {
    console.error('GET /api/roles error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/roles — create a custom role (admin only).
// builtin always set to false; you can't create a builtin from outside the
// db.js seed code.
router.post('/', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const { name, label, description, capabilities } = req.body || {};
    if (!name || !label) return res.status(400).json({ error: 'name and label are required' });
    if (!/^[a-z0-9_]+$/.test(name)) {
      return res.status(400).json({ error: 'name must be lowercase letters, digits, and underscores' });
    }
    const validCaps = new Set(CAPABILITY_KEYS.map(c => c.key));
    const caps = Array.isArray(capabilities)
      ? capabilities.filter(c => validCaps.has(c))
      : [];
    // The escalation gate. Checked AFTER the CAPABILITY_KEYS filter so the
    // guard sees exactly the array that is about to be written, never a
    // hopeful one — an unrecognized key can't smuggle the cap past it, and a
    // recognized one can't survive the filter and skip it.
    const capErr = systemAdminRoleGuard(req.user, caps, null);
    if (capErr) return res.status(capErr.status).json({ error: capErr.error });
    await pool.query(
      `INSERT INTO roles (name, label, description, builtin, capabilities)
       VALUES ($1, $2, $3, false, $4::jsonb)`,
      [name, label, description || null, JSON.stringify(caps)]
    );
    await refreshRoleCache();
    auditLog(req, { action: 'role.create', targetType: 'role', targetId: name, detail: { label, capabilities: caps } });
    res.json({ ok: true, name });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A role with that name already exists.' });
    }
    console.error('POST /api/roles error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/roles/:name — update a role's label, description, or capabilities.
// Builtin roles can have all three edited (so admins can tweak which caps a
// PM has, for example), but the name + builtin flag stay locked.
router.put('/:name', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT builtin, capabilities FROM roles WHERE name = $1', [req.params.name]);
    if (!rows.length) return res.status(404).json({ error: 'Role not found' });

    const { label, description, capabilities } = req.body || {};
    const validCaps = new Set(CAPABILITY_KEYS.map(c => c.key));
    const caps = Array.isArray(capabilities)
      ? capabilities.filter(c => validCaps.has(c))
      : null;

    // Both sides of the pair, in one call: the submitted array may not
    // introduce SYSTEM_ADMIN, and the role's EXISTING array being carrying it
    // makes the whole row off-limits — label and description included, since
    // relabelling the platform-owner role is not something a tenant admin has
    // any business doing either.
    const capErr = systemAdminRoleGuard(req.user, caps, rows[0].capabilities);
    if (capErr) return res.status(capErr.status).json({ error: capErr.error });

    const sets = [];
    const params = [];
    let p = 1;
    if (label != null)       { sets.push('label = $' + p++); params.push(label); }
    if (description != null) { sets.push('description = $' + p++); params.push(description); }
    if (caps != null)        { sets.push('capabilities = $' + p++ + '::jsonb'); params.push(JSON.stringify(caps)); }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    sets.push('updated_at = NOW()');
    params.push(req.params.name);
    // SAFE: column names come from req.body destructuring (label / description / capabilities); never user-key iteration.
    await pool.query(
      `UPDATE roles SET ${sets.join(', ')} WHERE name = $${p}`,
      params
    );
    await refreshRoleCache();
    auditLog(req, {
      action: 'role.update', targetType: 'role', targetId: req.params.name,
      detail: { capabilities_before: rows[0].capabilities, capabilities_after: caps != null ? caps : '(unchanged)' },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/roles/:name error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/roles/:name — only custom (non-builtin) roles. Refuses if any
// user is currently assigned that role; admin should reassign first.
router.delete('/:name', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT builtin, capabilities FROM roles WHERE name = $1', [req.params.name]);
    if (!rows.length) return res.status(404).json({ error: 'Role not found' });
    // The `system_admin` builtin is already unreachable here (builtin roles
    // cannot be deleted), but a CUSTOM role carrying SYSTEM_ADMIN — created by
    // a holder, for a second platform operator — is not, and deleting it is a
    // way to revoke the platform owner's own tier from inside a tenant. Same
    // rule as the two write doors, asked before the builtin check so the
    // answer does not depend on which branch happens to fire first.
    const capErr = systemAdminRoleGuard(req.user, null, rows[0].capabilities);
    if (capErr) return res.status(capErr.status).json({ error: capErr.error });
    if (rows[0].builtin) {
      return res.status(400).json({ error: 'Built-in roles cannot be deleted.' });
    }
    // ── The 409 body was a cross-tenant headcount ──────────────────────────
    //
    // `roles` is global, so the refusal has to be decided on the GLOBAL count:
    // deleting a row another tenant's users are sitting on would strip their
    // capabilities. But the NUMBER that came back was that global count, which
    // turned this endpoint into a free headcount oracle — an org-A admin could
    // name any role and read how many users exist across every tenant, and by
    // repeating it, watch another org's hiring.
    //
    // Split the two: refuse on the global count, report only the caller's own
    // organization's. When the assignment is entirely outside the caller's org
    // the message carries no number at all — the refusal is unavoidable (the
    // row genuinely cannot go) but nothing about the size or shape of the other
    // tenant crosses with it.
    const usage = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE role = $1', [req.params.name]);
    if (usage.rows[0].c > 0) {
      const callerOrg = (req.user && req.user.organization_id) || null;
      let mine = 0;
      if (callerOrg) {
        const ownUsage = await pool.query(
          'SELECT COUNT(*)::int AS c FROM users WHERE role = $1 AND organization_id = $2',
          [req.params.name, callerOrg]
        );
        mine = ownUsage.rows[0].c;
      }
      return res.status(409).json({
        error: mine > 0
          ? 'Cannot delete: ' + mine + ' user(s) in your organization are still assigned this role. Reassign them first.'
          : 'Cannot delete: this role is still assigned to at least one user. Reassign them first.'
      });
    }
    await pool.query('DELETE FROM roles WHERE name = $1', [req.params.name]);
    await refreshRoleCache();
    auditLog(req, { action: 'role.delete', targetType: 'role', targetId: req.params.name });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/roles/:name error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
