// Server-side rich-text sanitizer — defense-in-depth for HTML produced by the
// p86RichText WYSIWYG (js/rich-text.js). The client DOM-sanitizes before save
// AND re-sanitizes on every render; this pass keeps the STORED value clean too,
// so a value POSTed directly to the API (bypassing the editor) can't smuggle
// script/handlers into anything that later renders it (proposals, PDFs, email).
//
// Allowlist of tags + per-tag attributes + a per-property style allowlist.
// Regex-based (mirrors server/email-templates.js sanitizeBlockHtml) — adequate
// for the constrained editor output; the render-time client sanitize is the
// authoritative guard.

'use strict';

var ALLOWED_TAGS = ['p', 'div', 'br', 'span', 'font', 'b', 'strong', 'i', 'em',
  'u', 's', 'strike', 'ul', 'ol', 'li', 'a', 'blockquote', 'h1', 'h2', 'h3', 'h4'];
var ALLOWED_STYLE = ['text-align', 'font-weight', 'font-style', 'text-decoration',
  'text-decoration-line', 'color', 'background-color', 'font-family', 'font-size'];
var STYLE_VALUE_BLOCK = /url\s*\(|expression\s*\(|javascript:|@import|[<>\\]/i;

function cleanStyle(raw) {
  return String(raw || '').split(';').map(function (d) {
    var i = d.indexOf(':');
    if (i === -1) return '';
    var prop = d.slice(0, i).trim().toLowerCase();
    var val = d.slice(i + 1).trim();
    if (ALLOWED_STYLE.indexOf(prop) === -1) return '';
    if (!val || val.length > 120 || STYLE_VALUE_BLOCK.test(val)) return '';
    return prop + ': ' + val;
  }).filter(Boolean).join('; ');
}

function cleanAttrs(tag, attrStr) {
  var t = tag.toLowerCase();
  var out = '';
  var re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
  var m;
  while ((m = re.exec(attrStr))) {
    var name = m[1].toLowerCase();
    var val = m[2].replace(/^["']|["']$/g, '');
    if (/^on/.test(name)) continue;
    if (name === 'style') {
      var s = cleanStyle(val);
      if (s) out += ' style="' + s.replace(/"/g, '') + '"';
    } else if (t === 'a' && name === 'href') {
      var u = val.trim();
      if (/^(https?:|mailto:|tel:)/i.test(u) || u.indexOf(':') === -1) {
        out += ' href="' + u.replace(/"/g, '&quot;') + '"';
      }
    } else if (t === 'a' && (name === 'target' || name === 'rel' || name === 'title')) {
      out += ' ' + name + '="' + val.replace(/"/g, '&quot;') + '"';
    } else if (t === 'font' && (name === 'face' || name === 'color')) {
      out += ' ' + name + '="' + val.replace(/[<>"]/g, '') + '"';
    } else if (t === 'font' && name === 'size') {
      var n = parseInt(val, 10);
      if (n >= 1 && n <= 7) out += ' size="' + n + '"';
    }
    // anything else is dropped
  }
  if (t === 'a' && /href=/.test(out)) {
    if (!/target=/.test(out)) out += ' target="_blank"';
    if (!/rel=/.test(out)) out += ' rel="noopener noreferrer"';
  }
  return out;
}

function sanitizeRichText(html) {
  if (typeof html !== 'string' || !html) return '';
  var s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Drop dangerous elements entirely, content included.
  s = s.replace(/<(script|style|iframe|object|embed|form|input|button|textarea|link|meta)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(script|style|iframe|object|embed|form|input|button|textarea|link|meta)\b[^>]*\/?>/gi, '');
  // Strip event handlers + javascript: URIs anywhere.
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/javascript\s*:/gi, '');
  // Rewrite every remaining tag through the allowlist.
  s = s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    function (match, slash, tag, attrs) {
      var t = tag.toLowerCase();
      if (ALLOWED_TAGS.indexOf(t) === -1) return '';  // strip tag, keep inner text
      if (slash) return '</' + t + '>';
      if (t === 'br') return '<br>';
      return '<' + t + cleanAttrs(t, attrs) + '>';
    });
  return s;
}

module.exports = { sanitizeRichText };
