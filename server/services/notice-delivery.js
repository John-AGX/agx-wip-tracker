'use strict';

/* ONE PERSON, ONE MESSAGE, TWO CHANNELS — for every kind of notice.
 *
 * This was private to services/work-order-notices.js until the money notices
 * needed the same thing (services/money-notices.js). It moved here rather than
 * being copied, because the copy would have been the bug: a user who switches a
 * notification off in My Account must go quiet on every surface, and two
 * modules each deciding what "off" means is how one of them keeps writing.
 *
 * PREFERENCES (server/notify-events.js own the catalog):
 *   email off  when users.notification_prefs[key] === false
 *   push  off  when users.notification_prefs.push[key] === false
 * A MISSING KEY IS ON. Both are opt-OUT, so a new event starts switched on for
 * everybody and the catalog row is what gives them the switch.
 *
 * BEST-EFFORT. deliver() never throws: the write that justified the notice has
 * already committed before it is called, and a mail provider having a bad
 * minute must not turn a successful save into a 500. It returns whether either
 * channel reached the person, which callers log.
 *
 * A MESSAGE is { subject, html, text, push: {title, body, url, tag} | null },
 * built by services/notice-text.js primitives.
 */

function senderHelpers() { return require('../email-sender'); }

// Senders are injected so a test can drive this without a database or a mail
// provider, and resolved lazily so requiring this module costs nothing.
function resolveDeps(deps) {
  const d = deps || {};
  let isEnabled = d.isEnabled;
  if (typeof isEnabled !== 'function') {
    isEnabled = d.sendEmail
      ? function () { return true; }
      : function () { return require('../email').isEnabled(); };
  }
  return {
    sendEmail: d.sendEmail || function (m) { return require('../email').sendEmail(m); },
    sendPush: d.sendPush || function (userId, key, payload, prefs) {
      return require('../notify-events').sendPushForEvent(userId, key, payload, prefs);
    },
    hasCapability: d.hasCapability,
    isEnabled: isEnabled,
  };
}

// notification_prefs arrives as an object from node-postgres and as a string
// from the sqlite test engine; both read the same here.
function prefsOf(u) {
  let p = u && u.notification_prefs;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = {}; } }
  return (p && typeof p === 'object') ? p : {};
}

function emailOn(u, key) {
  return !!(u && u.email) && prefsOf(u)[key] !== false;
}

function pushOn(u, key) {
  const prefs = prefsOf(u);
  return !(prefs.push && typeof prefs.push === 'object' && prefs.push[key] === false);
}

// Worth sending to at all. Checked BEFORE the work of composing a message and
// reading the rows it needs, so a muted recipient costs nothing.
function reachable(u, key) {
  return emailOn(u, key) || pushOn(u, key);
}

function displayName(u) {
  return String((u && (u.name || u.email)) || ('User ' + (u && u.id))).slice(0, 80);
}

// One person, one message: email when their email pref is on, push when their
// push pref is on. True when either channel reached them.
async function deliver(d, u, key, message, opts) {
  const o = opts || {};
  let reached = false;
  if (emailOn(u, key)) {
    try {
      const helpers = senderHelpers();
      const r = await d.sendEmail({
        to: u.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
        tag: key,
        organizationId: o.orgId,
        senderOrg: o.senderOrg,
        replyTo: helpers.cleanReplyTo(o.replyTo, [u.email]) || false,
      });
      if (r && r.ok) reached = true;
    } catch (e) {
      console.warn('[notice-delivery] email failed (' + key + '):', e && e.message);
    }
  }
  if (message.push && pushOn(u, key)) {
    try {
      const p = await d.sendPush(Number(u.id), key, message.push, prefsOf(u));
      if (p && p.sent) reached = true;
    } catch (e) {
      console.warn('[notice-delivery] push failed (' + key + '):', e && e.message);
    }
  }
  return reached;
}

// The org's own name on the envelope, for "<Org> via Project 86".
async function senderOrgFor(db, orgId) {
  const name = await senderHelpers().orgNameFor(db, orgId);
  return name ? { id: orgId, name: name } : { id: orgId };
}

module.exports = {
  resolveDeps,
  prefsOf,
  emailOn,
  pushOn,
  reachable,
  displayName,
  deliver,
  senderOrgFor,
};
