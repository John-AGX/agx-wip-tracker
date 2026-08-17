// One rule for every statement reachable by a caller-supplied USER id.
//
// WHY THIS EXISTS
// `server/services/job-org-scope.js` states the rule on the job key. This is
// the same rule on the other enumerable key in the system. `PUT /api/auth/
// users/:id` read `SELECT * FROM users WHERE id = $1` with no org predicate,
// so an org-A admin could set an org-B PM's email to an address they control
// (password reset then completes the takeover), flip that PM's role to admin,
// or set active=false and lock the tenant's staff out. Three more doors on the
// same key were open beside it: the password reset (which sets a foreign
// tenant's credential AND mails it out), the delete, and the notification-prefs
// write.
//
// `GET /api/auth/users` IS org-scoped, so the list never showed org B — but
// users.id is SERIAL, so the by-id doors did not need a list.
//
// THE RULE
//   every statement reachable by a caller-supplied user id must prove the
//   TARGET USER is in the caller's tenant before it reads back or writes.
//
// THE TOLERANCE ARM, AND WHY IT IS NOT A HOLE
// A target with organization_id NULL is reachable by any admin. That is not
// laxity, it is the adoption door: `PUT /users/:id` is the ONLY endpoint that
// writes users.organization_id after insert, and it is the remediation
// requireOrgId's 409 points at ("ask an administrator to open your user in
// Admin → Users and save it"). Scoping an un-stamped user out of that door
// would close the only exit from ORG_UNRESOLVED. It also matches every read in
// this repo, all of which carry `OR organization_id IS NULL`.
//
// A caller with NO resolvable org is the mirror case and is refused: it cannot
// name a tenant, so it may only touch targets that name none either. A legacy
// single-tenant install — every row NULL — is therefore completely unchanged.
//
// THE SYSTEM ADMIN, DECIDED ON PURPOSE
// SYSTEM_ADMIN is defined in auth.js as the platform-owner tier that "gates
// cross-tenant operations", and `POST /api/auth/act-as` already lets a holder
// become any user in any tenant. Refusing them here would be a fence with an
// open gate beside it. So: a SYSTEM_ADMIN capability holder MAY cross, and
// every crossing is audited as `user.cross_tenant_write` carrying both org ids.
// Deliberate, recorded, and one account wide — not incidental.
//
// Note the check is on the CAPABILITY, never on the role name and never on
// isAdminish(). `requireRole('admin')` already admits the system_admin ROLE, so
// a role-name test here would be satisfied by the gate that let the caller in,
// and the org verdict is computed BEFORE the capability is consulted so the
// capability can only ever widen a decision that has already been made.

const { resolveOrgId, hasCapability, ORG_LOOKUP_FAILED } = require('../auth');

// Is `targetOrg` reachable by a caller whose tenant is `callerOrg`?
// Pure, so the boundary can be reasoned about without a request.
function userInOrg(callerOrg, targetOrg) {
  if (targetOrg == null) return true;               // legacy / un-adopted row
  if (callerOrg == null) return false;              // caller names no tenant
  return String(callerOrg) === String(targetOrg);
}

// Route guard for an admin door keyed on another user's id.
//
// `targetUser` is the row the handler already read (it MUST include
// organization_id). Returns null after having answered the request — the
// handler returns immediately — or a verdict the handler proceeds with.
//
// A foreign target is answered with the SAME 404 a genuinely absent user gets.
// users.id is SERIAL: a distinguishable 403 would turn every one of these doors
// into a cross-tenant user-existence oracle for any org admin, which is the
// exact leak the org-scoped GET /users was written to prevent. The refusal is
// still named — to the operator, in the audit log, not to the prober.
async function guardUserTarget(req, res, targetUser) {
  let callerOrg;
  try {
    callerOrg = await resolveOrgId(req);
  } catch (e) {
    // "I could not tell which tenant the caller is in" is not "they may not" —
    // retryable, and it must not read as a permission verdict.
    res.status(503).json({
      error: 'Could not determine your organization right now. Nothing was changed — retry shortly.',
      code: ORG_LOOKUP_FAILED
    });
    return null;
  }

  const targetOrg = targetUser ? targetUser.organization_id : null;

  // The org verdict is reached FIRST. The capability below can only widen it.
  if (userInOrg(callerOrg, targetOrg)) {
    return { callerOrg, targetOrg, crossTenant: false };
  }

  if (hasCapability(req.user, 'SYSTEM_ADMIN')) {
    return { callerOrg, targetOrg, crossTenant: true };
  }

  res.status(404).json({ error: 'User not found' });
  return null;
}

module.exports = { userInOrg, guardUserTarget };
