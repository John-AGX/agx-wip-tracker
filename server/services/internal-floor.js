'use strict';

/* THE INTERNAL FLOOR — "are you inside this company at all?"
 *
 * Not "which role may see receipts". That is a policy question and this is not
 * it. This is the floor underneath every such policy: a door that carries
 * requireAuth and nothing else is open to EVERY authenticated caller, and in
 * Project 86 one of those is an EXTERNAL one — the builtin `sub` role, whose
 * entire capability set is SUB_PORTAL_VIEW and SUB_PORTAL_UPLOAD, and whose
 * session is a real JWT that requireAuth is perfectly happy with.
 *
 * The agent surface met this first. From routes/ai-routes.js, driven on
 * 8f5b2b31: "a user holding NO capability got the org's Cost Inbox dollar
 * totals with vendor names, every RFI on a job, and the compliance list
 * through 86 — directly, and again through escalate_to_86 ... The builtin
 * `sub` role (SUB_PORTAL_VIEW/UPLOAD only — an EXTERNAL user) is such a
 * caller, and it reaches 86."
 *
 * It fixed its own doors with the list below and recorded the rest as open:
 * "The REST twins are NOT changed here; whether they should carry the same
 * floor is John's call and is recorded as open." John, 2026-10-04: "fix the
 * receipts capability check."
 *
 * ━━ WHY THIS LIST, AND WHY IT LOCKS NOBODY OUT ━━
 *
 * It is every VIEW capability a builtin INTERNAL role holds, so every one of
 * them — system_admin, admin, corporate, pm, and field_crew, whose role
 * description is literally "Estimates and Cost Inbox only" — passes exactly as
 * before. It refuses only a caller holding none of them: the sub portal, and a
 * custom zero-capability role.
 *
 * That is deliberately weaker than a policy would be. A floor that tried to
 * also answer "may a field crew member capture a cost" would have locked out
 * whichever custom role an organisation actually uses for that, and this
 * repository cannot see those roles: the `roles` table has no organization_id,
 * every ROLES_MANAGE holder can edit builtin capabilities, and db.js
 * deliberately does not re-sync non-admin builtins on boot.
 *
 * So: refuse the outsider, admit every insider, and leave who-may-do-what to a
 * decision somebody makes on purpose.
 *
 * ━━ IT IS ONE LIST BECAUSE TWO WOULD DRIFT ━━
 *
 * The agent gate and the REST gate must refuse the same callers, or the hole
 * simply moves: 86 dispatches through the agent map, the app through the
 * routes, and a sub that cannot read receipts one way should not read them the
 * other. services/notice-delivery.js makes the same argument about preferences
 * — two modules each deciding what "off" means is how one of them keeps
 * writing.
 */

/* Every VIEW capability a builtin internal role holds. ANY of them admits;
 * holding none refuses. Order is not significant. */
const INTERNAL_VIEW_FLOOR = Object.freeze([
  'ESTIMATES_VIEW',
  'JOBS_VIEW_ALL',
  'JOBS_VIEW_ASSIGNED',
  'FINANCIALS_VIEW',
  'LEADS_VIEW',
]);

/* requireCapability takes a SPACE-SEPARATED list and reads it as ANY-of — see
 * its own header, which explains why it is never AND. This is the string form
 * of the list above, so a route reads `requireCapability(INTERNAL_FLOOR_CAPS)`
 * and cannot retype it wrongly. */
const INTERNAL_FLOOR_CAPS = INTERNAL_VIEW_FLOOR.join(' ');

module.exports = { INTERNAL_VIEW_FLOOR, INTERNAL_FLOOR_CAPS };
