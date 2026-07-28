// Premium Email Hub — E3 unified search (docs/email-hub-premium.md §3).
//
// Turns a Gmail/Outlook-style query string into a parsed shape the thread
// list can compile to SQL:
//
//   from:tracy subject:"pressure wash" has:attachment is:unread older_than:7d
//   label:urgent folder:archive -newsletter pressure
//
// Supported operators (all case-insensitive, all repeatable):
//   from:        sender address or display name, substring
//   to:          recipient (the dropbox address it arrived on), substring
//   subject:     subject substring
//   body:        body-text substring
//   has:         attachment | draft | entity
//   is:          unread | read | starred | unstarred | pinned | snoozed |
//                replied | outbound | inbound
//   label:       label name, exact (case-insensitive)
//   folder:      folder slug or name
//   older_than:  7d | 2w | 3m | 1y  (received BEFORE now minus that)
//   newer_than:  same units          (received AFTER now minus that)
//   before:/after:  an ISO date (2026-07-01)
//
// A bare word is a free-text term matched against subject OR body OR
// sender. A -word EXCLUDES. "quoted phrases" stay whole.
//
// SECURITY: this module builds parameterized SQL only — every user value
// becomes a $n placeholder, never string-interpolated. The caller supplies
// the starting placeholder index so the fragment composes with an existing
// WHERE clause. It does NOT scope by user; the caller must already have
// added `user_id = $1`.

'use strict';

// Operators that take a value. Anything else before a ':' is treated as
// free text (so "re: pressure" searches for the words, not an operator).
var VALUE_OPS = ['from', 'to', 'subject', 'body', 'has', 'is', 'label', 'folder',
                 'older_than', 'newer_than', 'before', 'after'];

// Split a query into tokens, keeping "quoted phrases" whole. Handles a
// trailing unbalanced quote by treating the rest as one phrase.
function tokenize(q) {
  var out = [];
  var buf = '';
  var inQuote = false;
  var str = String(q == null ? '' : q);
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i);
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

// Relative age like '7d' / '2w' / '3m' / '1y' → milliseconds. null when
// it isn't a legal duration, so a typo degrades to "no filter" instead of
// silently matching everything.
function durationMs(v) {
  var m = String(v || '').trim().match(/^(\d+)\s*([dwmy])$/i);
  if (!m) return null;
  var n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  var unit = m[2].toLowerCase();
  var day = 24 * 60 * 60 * 1000;
  if (unit === 'd') return n * day;
  if (unit === 'w') return n * 7 * day;
  if (unit === 'm') return n * 30 * day;
  return n * 365 * day;
}

function isoDate(v) {
  var s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Parse a raw query into { terms, negTerms, ops, unknown }.
//   terms    free-text words/phrases to match
//   negTerms free-text words/phrases to EXCLUDE
//   ops      { from:[...], is:[...], ... } — every op is an array so a
//            repeated operator ANDs naturally
//   unknown  operator-looking tokens we did not recognize (echoed back so
//            the UI can hint rather than silently ignoring them)
function parseQuery(q) {
  var res = { terms: [], negTerms: [], ops: {}, unknown: [] };
  tokenize(q).forEach(function (tok) {
    var neg = false;
    var t = tok;
    if (t.charAt(0) === '-' && t.length > 1) { neg = true; t = t.slice(1); }
    var colon = t.indexOf(':');
    if (colon > 0) {
      var key = t.slice(0, colon).toLowerCase();
      var val = t.slice(colon + 1);
      if (VALUE_OPS.indexOf(key) !== -1) {
        if (!val) return;                       // "from:" with no value is a no-op
        var bucket = neg ? (key + '!') : key;
        (res.ops[bucket] = res.ops[bucket] || []).push(val);
        return;
      }
      // Looks like an operator but isn't one — report it so the UI can
      // say "form: isn't an operator" instead of silently searching it as
      // text. Excluded: anything with a '://' (a pasted URL) and the
      // schemes that legitimately use a bare colon, so searching for a
      // link or an address never produces a bogus warning.
      var scheme = (t.indexOf('://') !== -1) || key === 'mailto' || key === 'tel';
      if (!scheme && /^[a-z_]{2,}$/i.test(key) && val) res.unknown.push(key);
    }
    if (!t) return;
    (neg ? res.negTerms : res.terms).push(t);
  });
  return res;
}

// Compile a parsed query to { sql, params } where sql is a list of
// AND-able predicates (already joined with ' AND ') and params are the
// values for placeholders starting at `startIndex`.
//
// `alias` is the inbound_emails alias in the caller's query ('e').
// Label filters compile to an EXISTS subquery against email_message_labels
// so they never multiply rows through a join.
function buildWhere(parsed, opts) {
  opts = opts || {};
  var alias = opts.alias || 'e';
  var params = [];
  var next = (opts.startIndex || 1);
  var parts = [];
  function ph(v) { params.push(v); return '$' + (next++); }
  function like(v) { return '%' + String(v) + '%'; }

  var ops = parsed.ops || {};
  function each(key, fn) { (ops[key] || []).forEach(fn); }

  // ── text operators
  each('from', function (v) {
    parts.push('(' + alias + '.from_email ILIKE ' + ph(like(v)) +
               ' OR COALESCE(' + alias + '.from_name, \'\') ILIKE ' + ph(like(v)) +
               ' OR COALESCE(' + alias + '.orig_from_email, \'\') ILIKE ' + ph(like(v)) + ')');
  });
  each('from!', function (v) {
    parts.push('NOT (' + alias + '.from_email ILIKE ' + ph(like(v)) +
               ' OR COALESCE(' + alias + '.from_name, \'\') ILIKE ' + ph(like(v)) +
               ' OR COALESCE(' + alias + '.orig_from_email, \'\') ILIKE ' + ph(like(v)) + ')');
  });
  each('to', function (v) { parts.push('COALESCE(' + alias + '.to_email, \'\') ILIKE ' + ph(like(v))); });
  each('subject', function (v) { parts.push('COALESCE(' + alias + '.subject, \'\') ILIKE ' + ph(like(v))); });
  each('subject!', function (v) { parts.push('COALESCE(' + alias + '.subject, \'\') NOT ILIKE ' + ph(like(v))); });
  each('body', function (v) { parts.push('COALESCE(' + alias + '.body_text, \'\') ILIKE ' + ph(like(v))); });

  // ── has:
  each('has', function (v) {
    var k = String(v).toLowerCase();
    if (k === 'attachment' || k === 'attachments') parts.push(alias + '.has_attachments = TRUE');
    else if (k === 'entity' || k === 'link') parts.push(alias + '.entity_type IS NOT NULL');
    else if (k === 'draft') {
      parts.push('EXISTS (SELECT 1 FROM email_thread_state s2 WHERE s2.user_id = ' + alias +
                 '.user_id AND s2.thread_id = ' + alias + '.thread_id AND COALESCE(s2.draft_text, \'\') <> \'\')');
    }
  });

  // ── is:
  each('is', function (v) {
    var k = String(v).toLowerCase();
    if (k === 'unread') parts.push(alias + '.is_read = FALSE');
    else if (k === 'read') parts.push(alias + '.is_read = TRUE');
    else if (k === 'starred') parts.push(alias + '.is_starred = TRUE');
    else if (k === 'unstarred') parts.push(alias + '.is_starred = FALSE');
    else if (k === 'pinned') parts.push(alias + '.is_pinned = TRUE');
    else if (k === 'snoozed') parts.push(alias + '.snoozed_until IS NOT NULL');
    else if (k === 'outbound') parts.push(alias + '.direction = \'outbound\'');
    else if (k === 'inbound') parts.push(alias + '.direction = \'inbound\'');
    else if (k === 'replied') {
      parts.push('EXISTS (SELECT 1 FROM email_thread_state s3 WHERE s3.user_id = ' + alias +
                 '.user_id AND s3.thread_id = ' + alias + '.thread_id AND s3.replied_at IS NOT NULL)');
    }
  });

  // ── label: — EXISTS, never a join, so a message with three labels is
  // still one row.
  each('label', function (v) {
    parts.push('EXISTS (SELECT 1 FROM email_message_labels ml JOIN email_labels l ON l.id = ml.label_id' +
               ' WHERE ml.message_id = ' + alias + '.id AND LOWER(l.name) = LOWER(' + ph(String(v)) + '))');
  });
  each('label!', function (v) {
    parts.push('NOT EXISTS (SELECT 1 FROM email_message_labels ml JOIN email_labels l ON l.id = ml.label_id' +
               ' WHERE ml.message_id = ' + alias + '.id AND LOWER(l.name) = LOWER(' + ph(String(v)) + '))');
  });

  // ── folder: by slug OR display name, within the caller's own tree.
  each('folder', function (v) {
    parts.push('EXISTS (SELECT 1 FROM email_folders f2 WHERE f2.id = ' + alias + '.folder_id' +
               ' AND (LOWER(f2.slug) = LOWER(' + ph(String(v)) + ') OR LOWER(f2.name) = LOWER(' + ph(String(v)) + ')))');
  });

  // ── time
  each('older_than', function (v) {
    var ms = durationMs(v);
    if (ms != null) parts.push(alias + '.received_at < ' + ph(new Date(Date.now() - ms)));
  });
  each('newer_than', function (v) {
    var ms = durationMs(v);
    if (ms != null) parts.push(alias + '.received_at > ' + ph(new Date(Date.now() - ms)));
  });
  each('before', function (v) {
    var d = isoDate(v);
    if (d) parts.push(alias + '.received_at < ' + ph(d));
  });
  each('after', function (v) {
    var d = isoDate(v);
    if (d) parts.push(alias + '.received_at > ' + ph(d));
  });

  // ── free text: each term must match SOMEWHERE (subject, body, sender).
  // Terms AND together, matching how every mail client behaves.
  (parsed.terms || []).forEach(function (t) {
    var p = ph(like(t));
    parts.push('(COALESCE(' + alias + '.subject, \'\') ILIKE ' + p +
               ' OR COALESCE(' + alias + '.body_text, \'\') ILIKE ' + p +
               ' OR COALESCE(' + alias + '.from_email, \'\') ILIKE ' + p +
               ' OR COALESCE(' + alias + '.from_name, \'\') ILIKE ' + p + ')');
  });
  (parsed.negTerms || []).forEach(function (t) {
    var p = ph(like(t));
    parts.push('NOT (COALESCE(' + alias + '.subject, \'\') ILIKE ' + p +
               ' OR COALESCE(' + alias + '.body_text, \'\') ILIKE ' + p +
               ' OR COALESCE(' + alias + '.from_email, \'\') ILIKE ' + p +
               ' OR COALESCE(' + alias + '.from_name, \'\') ILIKE ' + p + ')');
  });

  return { sql: parts.join(' AND '), params: params, count: parts.length, nextIndex: next };
}

// Convenience: parse + compile in one call.
function compile(q, opts) {
  var parsed = parseQuery(q);
  var built = buildWhere(parsed, opts);
  built.parsed = parsed;
  return built;
}

module.exports = { VALUE_OPS: VALUE_OPS, tokenize: tokenize, durationMs: durationMs, parseQuery: parseQuery, buildWhere: buildWhere, compile: compile };
