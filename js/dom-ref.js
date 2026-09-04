// js/dom-ref.js — a stored value's ONE safe passage into painted markup.
//
// WHY THIS FILE EXISTS. Every list screen in this app paints its rows as one
// HTML string and wires them with inline handlers:
//
//     onclick="deleteLineFromEditor('<the stored id>')"
//
// That puts a stored value inside a JAVASCRIPT STRING LITERAL that itself
// sits inside an HTML ATTRIBUTE, and those are two parsers, run in that
// order, with different rules. The HTML parser decodes character references
// FIRST — so escapeHTML's `&#39;` is handed back to the JavaScript parser as
// a bare apostrophe, which closes the literal. Measured on shipped bytes: an
// id shaped like  ');f();//  passed validateOps, was stored verbatim by
// applyLineAdds, and fired three separate script executions in one
// interaction (the qty change, the description change, the delete click)
// while all three legitimate operations were discarded and the save pill went
// on reading "No changes".
//
// A BETTER ESCAPER IS NOT THE FIX, and neither is a data attribute. Both were
// measured against the same stored shapes:
//
//   * escaping correctly for a JS-string-inside-an-HTML-attribute addresses
//     all of them — but the stored bytes still reach a JavaScript parser, so
//     the class stays one missing call away from returning;
//   * moving the id into data-line-id and binding with addEventListener never
//     compiles it — but the HTML PARSER NORMALISES ATTRIBUTE VALUES: CR and
//     CRLF collapse to LF and NUL becomes U+FFFD, so what is painted is no
//     longer what is stored and three shapes address nothing. That is not a
//     prediction: js/change-order-editor.js already binds that way and was
//     dead on exactly those three shapes and no others.
//
// So neither parser may be handed the value. This file encodes it into an
// alphabet BOTH parsers are indifferent to, and decodes on the way out:
//
//     enc("l_a'b")    -> "l_a~0027b"
//     enc("l_a\r\nb") -> "l_a~000D~000Ab"
//     enc("');f();//")-> "~0027~0029~003Bf~0028~0029~003B~002F~002F"
//     enc("line_abc") -> "line_abc"            <- the entire live population
//
// FOUR PROPERTIES, all load-bearing:
//
//   1. TOTAL. dec(enc(v)) === String(v) for every string, including CR, NUL,
//      lone surrogates and U+2028. The round trip is what makes the
//      normalising shapes addressable at all.
//   2. CLOSED ALPHABET. enc's output is drawn from a fixed set that contains
//      none of  ' " \ & < >  , no C0 control, no line terminator and no NUL.
//      Nothing a producer can store can therefore close a string literal,
//      close an attribute, introduce a character reference, or survive
//      attribute normalisation as a different value. The bytes the JavaScript
//      parser compiles no longer depend on what was stored.
//   3. STATELESS AND DETERMINISTIC. No registry, no token table, nothing to
//      grow or evict and nothing that can miss. The same id encodes to the
//      same bytes on every repaint, so a row's DOM address is byte-stable and
//      the caret stays attached to its row mid-edit (js/line-identity.js
//      invariant 2). A stateful token would have re-addressed every row on
//      every paint.
//   4. IDENTITY ON THE COMMON CASE. Ids in this app are minted as
//      `l_<base36>_<base36>` / `s<clock>` / `est_<clock>_<base36>`, and every
//      such id encodes to ITSELF. data-line-id therefore reads in DevTools
//      exactly as it always has, and every existing selector against it still
//      matches.
//
// WHAT THIS IS NOT. It is not a migration. Nothing stored is rewritten:
// `enc` is a rendering step and `dec` is its inverse, so the value a handler
// receives is the value in the record, byte for byte. Rewriting a stored id
// would break the agent that wrote it — the reference it re-uses next turn is
// the ORIGINAL — and js/line-identity.js already forbids touching any key but
// `id`.
(function () {
  'use strict';

  // The marker. Escaped as itself (~007E) so enc is injective and dec is
  // unambiguous: a stored value that literally reads "~0027" encodes to
  // "~007E0027" and decodes back to "~0027", not to an apostrophe.
  var MARK = '~';

  // Refused literals. Each one is refused for a REASON, not for tidiness:
  //   '   closes a single-quoted JS string literal
  //   "   closes a double-quoted HTML attribute
  //   \   escapes the next character in the JS literal ("l_a\b" compiles to
  //       l_a + U+0008 and addresses nothing, silently — the worst shape)
  //   &   opens a character reference, which the HTML parser decodes BEFORE
  //       the JS parser ever sees the attribute
  //   < > open/close a tag on an innerHTML round trip
  //   ~   the marker itself
  var REFUSED = "'\"\\&<>" + MARK;

  function hex4(n) {
    var h = n.toString(16).toUpperCase();
    return MARK + '0000'.slice(h.length) + h;
  }

  function enc(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    var out = '', i = 0, n = s.length;
    for (; i < n; i++) {
      var ch = s.charAt(i);
      var c = s.charCodeAt(i);
      // C0 controls, DEL, and the two line terminators the JS parser treats
      // as line breaks inside a string literal. CR and NUL are in here twice
      // over: the HTML parser rewrites them in an attribute value, so they
      // MUST leave as an escape or they cannot come back.
      if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) { out += hex4(c); continue; }
      // Surrogates: a well-formed pair is one character and is kept whole, so
      // an emoji in a client name still reads as an emoji in DevTools. A LONE
      // surrogate cannot survive serialisation and is escaped.
      if (c >= 0xd800 && c <= 0xdfff) {
        var lo = (c <= 0xdbff && i + 1 < n) ? s.charCodeAt(i + 1) : 0;
        if (c <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) { out += ch + s.charAt(i + 1); i++; continue; }
        out += hex4(c); continue;
      }
      if (c < 0x7f && REFUSED.indexOf(ch) !== -1) { out += hex4(c); continue; }
      out += ch;
    }
    return out;
  }

  function dec(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/~([0-9A-Fa-f]{4})/g, function (_m, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
  }

  // True when `s` is drawn from enc's output alphabet. The repo guard test
  // uses it to prove the painted markup carries nothing else.
  function isEncoded(s) {
    if (s === null || s === undefined) return true;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return false;
      if (c >= 0xd800 && c <= 0xdbff) {
        var lo = (i + 1 < s.length) ? s.charCodeAt(i + 1) : 0;
        if (lo >= 0xdc00 && lo <= 0xdfff) { i++; continue; }
        return false;
      }
      if (c >= 0xdc00 && c <= 0xdfff) return false;
      if (c < 0x7f && REFUSED.indexOf(s.charAt(i)) !== -1 && s.charAt(i) !== MARK) return false;
    }
    return true;
  }

  // ── THE OTHER HALF, and the worse one ─────────────────────────────────
  // Not every stored value is painted inside quotes. Sixty-seven of them are
  // interpolated straight into CODE position:
  //
  //     onclick="deleteAdminUser(' + u.id + ')"
  //
  // which needs no apostrophe to break out at all — a stored id of
  // `1);alert(1);//` is simply the next statement. It is the same defect one
  // step further along, and the regex the audit used could not see it because
  // there is no string literal for it to look inside.
  //
  // `code(v)` returns an EXPRESSION the parser may compile, chosen to hand the
  // handler the same value it gets today:
  //   * a number, or a string that reads as one -> the numeric literal, so
  //     deleteAdminUser(7) still receives the NUMBER 7 and every === against a
  //     numeric primary key behaves exactly as it did;
  //   * anything else -> p86Dec('<encoded>'), a string, which is strictly
  //     better than today: a non-numeric id currently emits a BARE IDENTIFIER
  //     and the click dies with a ReferenceError.
  // Either way the parser compiles a literal or one known call, never the
  // stored bytes.
  function code(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'NaN';
    var s = String(v);
    if (s.trim() !== '' && isFinite(Number(s))) return String(Number(s));
    return "p86Dec('" + enc(s) + "')";
  }

  var API = { enc: enc, dec: dec, code: code, isEncoded: isEncoded, MARK: MARK };

  if (typeof window !== 'undefined') {
    window.p86DomRef = API;
    // Short aliases. `p86Dec` is what an inline handler calls, so it is
    // deliberately terse: it appears ~150 times in the painted markup.
    window.p86Enc = enc;
    window.p86Dec = dec;
    window.p86Code = code;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
