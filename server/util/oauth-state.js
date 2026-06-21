// oauth-state — the anti-CSRF / login-CSRF guard for the OAuth round-trip.
//
// On /connect we mint a random `state` + PKCE verifier and pack {state,
// verifier, uid, org, ts} into an ENCRYPTED (secretbox) HttpOnly cookie bound
// to the logged-in user. On /callback we decrypt + verify it: the cookie must
// exist, its state must equal the ?state Microsoft echoed back, and it must be
// fresh. Because the cookie is encrypted with our key it cannot be forged, so
// the callback trusts {uid, org} from it WITHOUT relying on the auth cookie —
// which both defends login-CSRF (an attacker can't plant a valid cookie in the
// victim's browser) and survives the cross-site redirect from Microsoft + any
// multi-instance deploy (no server-side state map).
'use strict';

const secretbox = require('./secretbox');

// Pack the per-flow secret into a cookie value. Stamps the current time.
function pack(state, verifier, uid, org) {
  return secretbox.encrypt(JSON.stringify({
    state: state, verifier: verifier, uid: Number(uid), org: Number(org), ts: Date.now(),
  }));
}

// Verify a callback. Returns { ok:true, verifier, uid, org } or
// { ok:false, reason }. `now` is injectable for testing.
function verify(rawCookie, queryState, ttlMs, now) {
  now = now || Date.now();
  if (!rawCookie || !queryState) return { ok: false, reason: 'missing' };
  let st;
  try { st = JSON.parse(secretbox.decrypt(rawCookie)); } catch (_) { return { ok: false, reason: 'badcookie' }; }
  if (!st || !st.state) return { ok: false, reason: 'nostate' };
  if (st.state !== queryState) return { ok: false, reason: 'state' };
  if (!(now - Number(st.ts) <= ttlMs)) return { ok: false, reason: 'expired' };
  if (!st.uid || !st.org) return { ok: false, reason: 'noowner' };
  return { ok: true, verifier: st.verifier, uid: Number(st.uid), org: Number(st.org) };
}

module.exports = { pack, verify };
