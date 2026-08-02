// server/services/email-rules-match.js — the E4 rule MATCHER.
//
// Pure. No database, no auth, no model. Given a rule and a message shape,
// decide whether it fires. The IO half (loading rules, applying actions)
// lives in email-rules.js; this half is where the logic that could
// silently misfile someone's mail actually lives, so it is kept
// unit-testable on its own.
//
// TWO PHASES, because they answer different questions at different times:
//   'inbound'     — sender / subject / body / attachment. Known the moment
//                   mail lands, before any model runs.
//   'post_triage' — category / urgency / needs-reply. These come FROM the
//                   Haiku pass, so a rule testing them cannot run earlier;
//                   at inbound they are still NULL and every such rule
//                   would silently never match.
//
// A rule's conditions come from the OWNER, not from the email — the
// values are matched AGAINST attacker-controlled text, but the matching
// is plain string comparison, so a crafted email can at worst fail to
// match. It can never make a rule do something the owner didn't write.
'use strict';

// Fields answerable at each phase. A rule carrying a field its phase can't
// see is a mistake worth REFUSING at save time rather than letting it sit
// there never matching — see validateRule.
const INBOUND_FIELDS = ['from', 'to', 'subject', 'body', 'has_attachment', 'entity_type', 'direction'];
const POST_TRIAGE_FIELDS = ['category', 'urgency', 'needs_reply'];

const OPS = ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'domain', 'is'];

// Actions that can actually be carried out today. forward and auto_reply
// are in the spec but there is NO SEND PATH — P86 does not send until the
// Azure link lands. Accepting them would store rules that look armed and
// silently do nothing, which is worse than refusing them.
const ACTIONS = ['move', 'label', 'star', 'mark_read', 'link_entity'];

function str(v) { return v == null ? '' : String(v); }
function lc(v) { return str(v).toLowerCase().trim(); }

// The value a condition reads off a message. Returns undefined when the
// field is unknown or not yet populated, which callers treat as NO MATCH
// rather than as an empty-string match — "no category yet" must not
// satisfy `category equals ''`.
function fieldValue(msg, field) {
  msg = msg || {};
  switch (field) {
    // orig_from_email is the REAL sender when the message was forwarded;
    // matching both means a rule for a client still fires on mail John
    // forwarded in himself.
    case 'from':           return [msg.from_email, msg.orig_from_email, msg.from_name];
    case 'to':             return [msg.to_email];
    case 'subject':        return [msg.subject];
    case 'body':           return [msg.body_text];
    case 'has_attachment': return msg.has_attachments === true;
    case 'entity_type':    return [msg.entity_type];
    case 'direction':      return [msg.direction];
    case 'category':       return msg.ai_category == null ? undefined : [msg.ai_category];
    case 'urgency':        return msg.triage_urgency == null ? undefined : [msg.triage_urgency];
    case 'needs_reply':    return msg.needs_reply == null ? undefined : msg.needs_reply === true;
    default:               return undefined;
  }
}

function testOne(op, haystacks, needle) {
  // Boolean fields: only `is` means anything.
  if (typeof haystacks === 'boolean') {
    if (op !== 'is') return false;
    var want = (needle === true || lc(needle) === 'true');
    return haystacks === want;
  }
  if (!Array.isArray(haystacks)) return false;
  var n = lc(needle);
  if (!n) return false;                    // an empty needle matches nothing, never everything
  var vals = haystacks.map(lc).filter(Boolean);

  switch (op) {
    case 'contains':     return vals.some(function (v) { return v.indexOf(n) !== -1; });
    case 'not_contains': return !vals.some(function (v) { return v.indexOf(n) !== -1; });
    case 'equals':       return vals.some(function (v) { return v === n; });
    case 'not_equals':   return !vals.some(function (v) { return v === n; });
    case 'starts_with':  return vals.some(function (v) { return v.indexOf(n) === 0; });
    case 'ends_with':    return vals.some(function (v) { return v.length >= n.length && v.slice(-n.length) === n; });
    // domain: match the part after '@' EXACTLY, not as a substring.
    // 'contains: acme.com' would also match evil-acme.com.attacker.net —
    // the whole reason this operator exists separately.
    case 'domain': {
      var want = n.replace(/^@/, '');
      return vals.some(function (v) {
        var at = v.lastIndexOf('@');
        return at !== -1 && v.slice(at + 1) === want;
      });
    }
    case 'is':           return vals.some(function (v) { return v === n; });
    default:             return false;
  }
}

/**
 * Does this rule fire on this message?
 * match_all (default) = every condition; otherwise any one.
 * A rule with NO conditions never matches — an empty rule that fired on
 * everything would file an entire mailbox on first save.
 */
function matchesRule(rule, msg) {
  if (!rule || rule.enabled === false) return false;
  var conds = Array.isArray(rule.conditions) ? rule.conditions : [];
  if (!conds.length) return false;
  var all = rule.match_all !== false;

  var results = conds.map(function (c) {
    if (!c || !c.field) return false;
    var got = fieldValue(msg, c.field);
    if (got === undefined) return false;   // not populated yet / unknown field
    return testOne(c.op || 'contains', got, c.value);
  });

  return all ? results.every(Boolean) : results.some(Boolean);
}

/**
 * Validate a rule as SAVED, not as run. Returns [] when fine, else a list
 * of human-readable problems.
 *
 * The phase check is the important one: a rule that tests ai_category at
 * the 'inbound' phase is not a runtime error — it just never matches, for
 * ever, silently. Refusing it at save time is the only moment anyone will
 * notice.
 */
function validateRule(rule) {
  var errs = [];
  if (!rule || typeof rule !== 'object') return ['Rule is empty.'];
  if (!str(rule.name).trim()) errs.push('A rule needs a name.');

  var phase = str(rule.run_phase || 'inbound');
  if (phase !== 'inbound' && phase !== 'post_triage') {
    errs.push('run_phase must be "inbound" or "post_triage".');
  }

  var conds = Array.isArray(rule.conditions) ? rule.conditions : [];
  if (!conds.length) errs.push('A rule needs at least one condition — an empty rule would match every message.');
  conds.forEach(function (c, i) {
    var where = 'Condition ' + (i + 1);
    if (!c || !c.field) { errs.push(where + ' has no field.'); return; }
    var known = INBOUND_FIELDS.indexOf(c.field) !== -1 || POST_TRIAGE_FIELDS.indexOf(c.field) !== -1;
    if (!known) { errs.push(where + ': "' + c.field + '" is not a field you can match on.'); return; }
    if (phase === 'inbound' && POST_TRIAGE_FIELDS.indexOf(c.field) !== -1) {
      errs.push(where + ': "' + c.field + '" is only known after triage — set this rule to run after triage, ' +
        'or it will never match.');
    }
    if (c.op && OPS.indexOf(c.op) === -1) errs.push(where + ': "' + c.op + '" is not a comparison.');
    var boolField = (c.field === 'has_attachment' || c.field === 'needs_reply');
    if (!boolField && !str(c.value).trim()) {
      errs.push(where + ' has no value to match against.');
    }
  });

  var acts = Array.isArray(rule.actions) ? rule.actions : [];
  if (!acts.length) errs.push('A rule needs at least one action.');
  acts.forEach(function (a, i) {
    var where = 'Action ' + (i + 1);
    if (!a || !a.type) { errs.push(where + ' has no type.'); return; }
    if (a.type === 'forward' || a.type === 'auto_reply') {
      errs.push(where + ': Project 86 cannot send mail yet, so "' + a.type +
        '" would never run. It becomes available when the Outlook connection lands.');
      return;
    }
    if (ACTIONS.indexOf(a.type) === -1) { errs.push(where + ': "' + a.type + '" is not an action.'); return; }
    if (a.type === 'move' && !str(a.folder).trim()) errs.push(where + ': move needs a folder.');
    if (a.type === 'label' && !str(a.label).trim()) errs.push(where + ': label needs a label name.');
  });

  return errs;
}

module.exports = {
  matchesRule,
  validateRule,
  fieldValue,
  INBOUND_FIELDS,
  POST_TRIAGE_FIELDS,
  OPS,
  ACTIONS,
};
