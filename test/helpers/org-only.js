// THE ONLY WAY A CROSS-TENANT CLAIM IS PROVED IN THIS REPO.
//
// ── WHY A HELPER AND NOT A CONVENTION ─────────────────────────────────────
// The read invariant's allowlist carried this entry for three commits:
//
//   'read_email_inbox::inbound_emails': { n: 1, why: '… Executed cross-tenant
//     and refused: an org-B thread id returns nothing to org A because the
//     thread is not in the caller's user_id.' }
//
// The verification it cites VARIED THE USER AND THE ORG TOGETHER. Two different
// people were asked for each other's mail, and of course each got nothing — but
// that is the proposition "another user's mail is not yours", which nobody
// doubted. The proposition actually at issue is "a row I authored for my FORMER
// tenant is not mine now", and no test that moves the user can express it. A
// vacuous test with a confident reason attached is how three open doors
// survived four rounds of review.
//
// So the discipline is not written down for the next author to remember. It is
// a function. `proveOrgOnly` takes ONE caller record and TWO organisation ids,
// derives both contexts from that single record, and runs the same call twice.
// The user id in both arms is the same property of the same object — a test
// written with this CANNOT vary the caller, because there is only one caller in
// it. Varying the org is the only degree of freedom the signature has.
//
// ── WHAT IT RETURNS ───────────────────────────────────────────────────────
//   { a, b }  whatever `run` returned for the caller AS a member of orgA and
//             AS a member of orgB. The test asserts on those two values.
//
// The pair is deliberately raw. A helper that also decided what "leaked" means
// would be a second place for the property to be stated loosely; the assertion
// belongs in the test, where a reader can see which string is the victim's.
'use strict';

// A caller record shaped like the `users` row every door here is handed.
// Cloned per arm so a callee that mutates ctx.user (resolveOrgId repairs
// req.user.organization_id in place, and does) cannot leak the org from one
// arm into the other — that would silently turn arm B into arm A and the
// proof would pass by agreeing with itself.
function callerIn(caller, orgId) {
  if (!caller || caller.id == null) {
    throw new Error('proveOrgOnly: the caller record must have an id');
  }
  return Object.assign({}, caller, { organization_id: orgId });
}

async function proveOrgOnly(opts) {
  const caller = opts && opts.caller;
  const orgA = opts && opts.orgA;
  const orgB = opts && opts.orgB;
  const run = opts && opts.run;
  if (typeof run !== 'function') throw new Error('proveOrgOnly: run(caller) is required');
  if (orgA === orgB) {
    // Not a proof of anything. Fail loudly rather than pass by comparing a
    // value with itself.
    throw new Error('proveOrgOnly: orgA and orgB must differ — a proof that does not vary the org proves nothing');
  }
  const a = callerIn(caller, orgA);
  const b = callerIn(caller, orgB);
  // Structural, not decorative: this is the assertion the old allowlist entry
  // could not make.
  if (a.id !== b.id) throw new Error('proveOrgOnly: the caller must be the same in both arms');
  return { a: await run(a), b: await run(b), callerA: a, callerB: b };
}

module.exports = { proveOrgOnly, callerIn };
