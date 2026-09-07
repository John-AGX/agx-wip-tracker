// THE ONE PLACE AN INBOUND ADDRESS IS BUILT, VALIDATED OR TAKEN APART.
//
// WHY THIS FILE EXISTS
// The address shape is <local>.<orgslug>@<domain> — john.agx@project86.net.
// That shape now has four consumers: the delivery matcher, the auto-mint, the
// admin assignment door and the My Account read-back. Spread across four files
// it becomes four subtly different opinions about what a legal address is, and
// the one that disagrees produces an address that LOOKS assigned and never
// receives anything. Everything about the shape lives here, so changing it is
// one edit rather than a hunt.
//
// THE SLUG IS A CONSTRUCTION RULE AT ASSIGNMENT TIME, NOT A PARSING RULE AT
// DELIVERY TIME. This file will compose `john` + `agx` into `john.agx`, and it
// will strip a domain off an incoming address to recover `john.agx` — but it
// will NEVER split `john.agx` back into a name and an org. It cannot: a user
// legitimately named `mary.jane` composes to `mary.jane.agx`, and any parser
// that guesses where to cut delivers a stranger's mail. `localPartFromAddress`
// returns ONE OPAQUE STRING that is matched whole. Do not add a split here.
//
// THREE NAMESPACES THAT CANNOT COLLIDE, AND THE REASON IT MATTERS
//   reserved  bare, no dot          'postmaster'      platform-owned
//   minted    a hyphen, never a dot 'john-46bbee'     auto-generated
//   assigned  exactly one dot       'john.agx'        an org admin chose it
// Because an assigned address always carries the dot the reserved list can
// never intercept one, which is precisely why an org MAY hold `admin.agx`
// while `admin` stays platform-owned. That is a property of the shape, not a
// special case anybody has to remember.

'use strict';

// THE DOMAIN. Settled by DNS on 2026-09-07.
//
// This defaulted to in.project86.net since the feature shipped, while
// cloudflare/email-worker/README.md step 3 instructs setting
// INBOUND_EMAIL_DOMAIN to the bare domain and step 4 points a catch-all
// there. INBOUND_EMAIL_DOMAIN was never set in production, so the default
// was live — and storeInboundMessage hard-rejects any recipient whose
// domain is not equal to this string.
//
// The lookup that settles it:
//   project86.net      MX -> route1/2/3.mx.cloudflare.net
//   in.project86.net   NO MX RECORD
//
// Nothing was ever deliverable to in.project86.net. So every inbound
// message since the feature shipped fell out of the matcher and was
// discarded with a 200 — no bounce to the sender, no row for us, one line
// in a log. Changing this default cannot break a working address because
// there has never been one on that domain.
//
// Still worth setting INBOUND_EMAIL_DOMAIN explicitly in Railway: a value
// this consequential should not live only in a default.
function inboundDomain() {
  return process.env.INBOUND_EMAIL_DOMAIN || 'project86.net';
}

// Reserved WHOLE addresses. Bare (dotless) by construction — see the header.
// postmaster and abuse are required by RFC 2142. notifications is published as
// the VAPID subject by server/push.js. These are seeded into
// user_email_aliases as user_id NULL tombstones, so the primary key is the
// real enforcement and this list is what lets a refusal SAY "reserved" instead
// of the generic "already in use".
const RESERVED_LOCAL_PARTS = new Set([
  'postmaster', 'abuse', 'admin', 'support', 'noreply', 'no-reply',
  'info', 'billing', 'hostmaster', 'webmaster', 'notifications',
  'security', 'help', 'mailer-daemon', 'root',
]);

// RFC 5321 §4.5.3.1.1 caps a local part at 64 octets, and the cap applies to
// the COMPOSED string, so the ceiling on the typed half depends on the org
// slug. LOCAL_MAX is the floor-level cap; the real limit is computed per org
// by validateAssignedLocalPart and the refusal names the actual number.
const LOCAL_MIN = 2;
const LOCAL_MAX = 32;
const RFC5321_LOCAL_MAX = 64;

// Lowercase and trim, always server-side. The UNIQUE on users.inbound_email_key
// is case-SENSITIVE while the delivery match is case-INSENSITIVE, so `John.agx`
// and `john.agx` would be two permitted rows that both satisfy one delivery,
// resolved by a LIMIT 1 with no ORDER BY. Unreachable while the only writer was
// the mint (which lowercased); reachable the moment an admin can type. Never
// trust the client to have done this.
function normalizeLocalPart(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

// Compose the stored key from the half an admin types and the org slug the
// SERVER supplies. The slug is never accepted from a request body: it is read
// from the resolved organization of the user being edited, so an org can only
// ever mint inside its own namespace.
function composeLocalPart(typedLocal, orgSlug) {
  return normalizeLocalPart(typedLocal) + '.' + normalizeLocalPart(orgSlug);
}

function formatAddress(localPart) {
  return normalizeLocalPart(localPart) + '@' + inboundDomain();
}

// Delivery side. Takes a full recipient address, returns the local part to
// match WHOLE — or null when the address is not ours.
//
// The `+tag` strip mirrors what the matcher has always done, and it is the
// reason `+` must be refused at assignment: a stored key containing one could
// never be matched by anything, so it would be an address that looks fine in
// the UI and silently receives nothing.
function localPartFromAddress(addr) {
  const s = String(addr == null ? '' : addr).trim().toLowerCase();
  const at = s.indexOf('@');
  if (at < 0) return null;
  if (s.slice(at + 1) !== inboundDomain().toLowerCase()) return null;
  const local = s.slice(0, at).replace(/\+.*$/, '');
  return local || null;
}

// Validate the half an admin typed, against the org slug it will be composed
// with. Returns { ok: true, localPart, address } or { ok: false, code, error }.
//
// `error` IS THE SENTENCE THE ADMIN READS — js/admin.js surfaces the server's
// message verbatim. So each one says what is wrong and what to do, never
// "invalid input". A refusal that does not explain itself is the same class of
// failure as a success that does nothing.
function validateAssignedLocalPart(typedLocal, orgSlug) {
  const local = normalizeLocalPart(typedLocal);
  const slug = normalizeLocalPart(orgSlug);

  if (!slug) {
    return { ok: false, code: 'no_org_slug', error:
      'This user is not attached to an organization yet, so there is no company name to build the address from. Save the user first to attach them, then set the address.' };
  }
  if (!local) {
    return { ok: false, code: 'empty', error: 'Enter a name for the address.' };
  }
  // Named before the general character rule: the dot and the plus are the two
  // that a reasonable person WILL type, and "invalid character" would leave
  // them guessing which one.
  if (local.indexOf('.') !== -1) {
    return { ok: false, code: 'dot', error:
      'An address name cannot contain a dot. The dot is what separates the name from the company — you type "john" and the address becomes "' +
      formatAddress('john.' + slug) + '".' };
  }
  if (local.indexOf('+') !== -1) {
    return { ok: false, code: 'plus', error:
      'An address name cannot contain a plus sign. Everything after a "+" is stripped when mail arrives, so an address with one would never receive anything.' };
  }
  if (!/^[a-z0-9-]+$/.test(local)) {
    return { ok: false, code: 'charset', error:
      'Use lowercase letters, numbers and hyphens only.' };
  }
  if (local.startsWith('-') || local.endsWith('-')) {
    return { ok: false, code: 'edge_hyphen', error:
      'An address name cannot start or end with a hyphen.' };
  }
  if (local.indexOf('--') !== -1) {
    return { ok: false, code: 'double_hyphen', error:
      'An address name cannot contain two hyphens in a row.' };
  }
  if (local.length < LOCAL_MIN) {
    return { ok: false, code: 'too_short', error:
      'Use at least ' + LOCAL_MIN + ' characters.' };
  }
  // The ceiling is COMPUTED, and the refusal names the real number. A fixed cap
  // would be wrong: the affiliate invite path derives a slug from the company
  // name, so a long company leaves far less room than "agx" does.
  const room = Math.min(LOCAL_MAX, RFC5321_LOCAL_MAX - 1 - slug.length);
  if (room < LOCAL_MIN) {
    return { ok: false, code: 'slug_too_long', error:
      'The company name "' + slug + '" is too long to build an address from. An administrator needs to shorten it first.' };
  }
  if (local.length > room) {
    return { ok: false, code: 'too_long', error:
      'Too long — "' + slug + '" leaves room for ' + room + ' characters.' };
  }
  // Reachable only if a bare-name path is ever added: a composed address always
  // carries a dot and so can never equal a reserved bare name. Checked anyway,
  // because "structurally unreachable" is a property of today's callers and
  // this function outlives them.
  if (RESERVED_LOCAL_PARTS.has(local) && !slug) {
    return { ok: false, code: 'reserved', error: 'That name is reserved.' };
  }

  const localPart = composeLocalPart(local, slug);
  if (RESERVED_LOCAL_PARTS.has(localPart)) {
    return { ok: false, code: 'reserved', error: 'That name is reserved.' };
  }
  return { ok: true, local, slug, localPart, address: formatAddress(localPart) };
}

// The refusal for a name somebody else already holds. ONE STRING FOR EVERY
// CASE — held in this org, held in another org, held by a deleted user, or a
// reserved tombstone reached some other way.
//
// It names nobody and no company. users.id is SERIAL and the alias key space is
// global, so a refusal that distinguished "taken here" from "taken elsewhere"
// would be a cross-tenant existence oracle for any org admin — the exact leak
// the org-scoped GET /users was written to prevent. There is a real mitigating
// asymmetry (a caller can only ever compose <local>.<their own slug>, so almost
// every collision they can reach IS their own org's) but "almost" is not a
// security property, so the string does not depend on it.
const TAKEN_MESSAGE = 'That address is already in use. Try another name.';

module.exports = {
  inboundDomain,
  normalizeLocalPart,
  composeLocalPart,
  formatAddress,
  localPartFromAddress,
  validateAssignedLocalPart,
  RESERVED_LOCAL_PARTS,
  TAKEN_MESSAGE,
  LOCAL_MIN,
  LOCAL_MAX,
  RFC5321_LOCAL_MAX,
};
