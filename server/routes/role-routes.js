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

// GET /api/roles — list all roles (any authenticated user; useful for the
// "New User" role dropdown). Capability arrays come back too so the admin
// Roles UI can render them inline.
router.get('/', requireAuth, async (req, res) => {
  try {
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
    const usage = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE role = $1', [req.params.name]);
    if (usage.rows[0].c > 0) {
      return res.status(409).json({
        error: 'Cannot delete: ' + usage.rows[0].c + ' user(s) are still assigned this role. Reassign them first.'
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
