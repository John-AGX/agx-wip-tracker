/* ═════════════════════════════════════════════════════════════════════════
 * NO STORED VALUE IS COMPILED AS JAVASCRIPT.
 *
 * THE DEFECT, measured on shipped bytes before this change. Every list screen
 * in this app paints its rows as one HTML string and wires them inline:
 *
 *     onclick="deleteLineFromEditor('<the stored id>')"
 *
 * which is a JavaScript string literal inside an HTML attribute — two parsers,
 * in that order, with different rules. The HTML parser decodes character
 * references FIRST, so escapeHTML's `&#39;` reaches the JavaScript parser as a
 * bare apostrophe and closes the literal. An id shaped like  ');f();//  passed
 * validateOps, was stored verbatim by applyLineAdds and fired THREE separate
 * script executions in one interaction (the qty change, the description change,
 * the delete click) while all three legitimate operations were discarded and
 * the save pill went on reading "No changes".
 *
 * WHY THIS FILE IS A SOURCE SCANNER AND NOT A DOM PROBE. The handlers live in
 * five hundred one-line HTML strings built by twenty render functions, most of
 * which need a whole screen's worth of state to reach. A behavioural test can
 * hold two of them; it cannot hold five hundred, and the ones it cannot hold
 * are exactly where the next one gets added. test/line-address-shapes.test.js
 * holds the behaviour for the two editors; this file holds the CLASS, for
 * every painted handler in the repo, by reading the source that paints it.
 *
 * WHAT IT ASSERTS, and each clause can fail on its own:
 *
 *   1. Every inline handler in the repo is READABLE — the scanner terminated
 *      on it. A scanner that silently drops what it cannot parse is a green
 *      light for the one site that matters, so an unreadable handler is a
 *      failure, not a skip.
 *   2. Every inline handler PARSES as JavaScript, with each interpolation
 *      standing in as an identifier. This is what makes a mechanical rewrite
 *      of a hundred and fifty call sites checkable at all.
 *   3. No value is interpolated INSIDE a JavaScript string literal in a
 *      handler except as p86Dec('<p86Enc(value)>'). That is the property in
 *      the title: what the parser compiles is a call and an alphabet, never
 *      the stored bytes.
 *   4. No value is interpolated into CODE position except through p86Code, or
 *      by name from a short list of JavaScript SNIPPETS the code itself
 *      composed — each named here, each proved to carry no un-encoded value
 *      of its own. Code position is the WORSE half and the audit's regex could
 *      not see it: `onclick="deleteAdminUser(' + u.id + ')"` needs no
 *      apostrophe to break out — a stored id of `1);alert(1);//` is simply the
 *      next statement.
 *   5. The encoder itself is total, closed, deterministic, and the identity on
 *      every id this app actually mints.
 * ═════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./helpers/inline-handler-scan.js');
const DOM = require('../js/dom-ref.js');

const ALL = S.scanRepo();

/* JavaScript SNIPPETS composed in code and interpolated whole into an
 * attribute. They are not stored values and wrapping them would turn code into
 * a string — so they are named, and clause 4b below re-reads their assignments
 * and requires that whatever they DO carry went through p86Enc. Adding a name
 * here is a deliberate act with a test attached to it. */
const CODE_SNIPPETS = {
  'onClick': 'js/app.js — attentionCard/snap take a handler BODY as a parameter',
  'leadsClick': 'js/app.js — a fixed navigation statement, no interpolation at all',
  'it.onclick': 'js/app.js — a handler body built in the needs-list item builder',
  'sel1': 'nodegraph/ui.js — a handler body built two lines above the paint',
  '_edit': 'nodegraph/ui.js — ditto',
  'add': 'nodegraph/ui.js — ditto',
  'setterName': 'js/qb-costs-view.js — a METHOD NAME chosen from a fixed set',
  'setter': 'js/qb-costs-view.js — ditto',
  "(c.archived ? 'false' : 'true')": 'js/admin.js — a boolean literal',
  "(existing ? 'p86Dec(\\'' + p86Enc(l.id) + '\\')' : 'null')": 'js/admin.js — already the safe shape, or null',
};

const where = (h) => h.file + ':' + h.line + ' [' + h.attr + ']';

describe('no stored value is compiled as JavaScript', () => {
  test('the scanner found the handlers it is supposed to be guarding', () => {
    // A guard that quietly stopped looking is the failure mode this whole
    // change exists to end, so the corpus is asserted to be a real one.
    expect(ALL.length).toBeGreaterThan(400);
    expect(new Set(ALL.map((h) => h.file)).size).toBeGreaterThan(15);
    expect(ALL.some((h) => h.file === 'js/estimate-editor.js' || h.file === 'js/change-order-editor.js'
      || h.file === 'js/jobs.js')).toBe(true);
  });

  test('1 · every inline handler in the repo is readable', () => {
    const unreadable = ALL.filter((h) => h.unterminated).map(where);
    expect(unreadable).toEqual([]);
  });

  test('2 · every inline handler still parses as JavaScript', () => {
    const broken = ALL.filter((h) => !h.unterminated && !S.parses(h.text))
      .map((h) => where(h) + '  ' + JSON.stringify(h.text).slice(0, 160));
    expect(broken).toEqual([]);
  });

  test('3 · nothing lands inside a handler string literal except p86Dec(\'…\')', () => {
    const bad = [];
    ALL.forEach((h) => {
      if (h.unterminated) return;
      h.holes.forEach((hole) => {
        if (!hole.inString || S.isSafeHole(hole)) return;
        bad.push(where(h) + '  ' + hole.expr + '   after: ' + JSON.stringify((hole.before || '').slice(-30)));
      });
    });
    expect(bad).toEqual([]);
  });

  test('4a · nothing lands in code position except p86Code(…) or a named snippet', () => {
    const bad = [];
    ALL.forEach((h) => {
      if (h.unterminated) return;
      h.holes.forEach((hole) => {
        if (hole.inString) return;
        if (/^p86Code\s*\(/.test(hole.expr)) return;
        if (Object.prototype.hasOwnProperty.call(CODE_SNIPPETS, hole.expr)) return;
        bad.push(where(h) + '  ' + hole.expr);
      });
    });
    expect(bad).toEqual([]);
  });

  test('4b · every named snippet carries no un-encoded value of its own', () => {
    // The snippets are the one place a stored value can reach a handler
    // without passing under the attribute scanner: the string is assembled
    // first and interpolated whole. So the assembly itself is checked —
    // repo-wide, not just at the listed names — for a JS string literal being
    // OPENED and then interpolated into.
    const offenders = [];
    S.paintingFiles().forEach((rel) => {
      const src = S.blankComments(fs.readFileSync(path.join(S.REPO, rel), 'utf8'));
      // `('" +`  or  `(\'' +` — a call argument opened as a string literal,
      // with a value about to be concatenated into it.
      const re = /\('(?:"|\\')\s*\+\s*([^\n]{0,80})/g;
      let m;
      while ((m = re.exec(src))) {
        if (/^\s*p86Enc\b/.test(m[1])) continue;
        if (rel === 'js/dom-ref.js') continue;      // where p86Code MINTS that shape
        offenders.push(rel + ':' + src.slice(0, m.index).split('\n').length + '  ' + m[0].replace(/\s+/g, ' ').slice(0, 90));
      }
    });
    expect(offenders).toEqual([]);
  });

  test('4c · every listed snippet is still used, so the list cannot rot', () => {
    const used = new Set();
    ALL.forEach((h) => { if (!h.unterminated) h.holes.forEach((x) => { if (!x.inString) used.add(x.expr); }); });
    const stale = Object.keys(CODE_SNIPPETS).filter((k) => !used.has(k));
    expect(stale).toEqual([]);
  });

  test('the two editors carry NO inline handler that interpolates anything', () => {
    // The editors are the record surfaces and got the structural treatment:
    // their ids reach the DOM as data and are bound with addEventListener, so
    // there is nothing left in a JavaScript position at all — not even a safe
    // one. Stated separately from clause 3 because "safe" and "absent" are
    // different guarantees and only one of them survives a careless edit.
    ['js/estimate-editor.js', 'js/change-order-editor.js'].forEach((f) => {
      const holes = ALL.filter((h) => h.file === f).reduce((n, h) => n + h.holes.length, 0);
      expect({ file: f, interpolationsIntoAHandler: holes }).toEqual({ file: f, interpolationsIntoAHandler: 0 });
    });
  });
});

describe('the encoder is total, closed and stable (js/dom-ref.js)', () => {
  const SPECIMENS = [
    'line_abc', "l_a'b", 'l_a\\b', 'l_a\\', 'l_a\nb', 'l_a\rb', 'l_a\r\nb', 'l_a\u0000b',
    "');f();//", 'x" onmouseover="y', 'a&b', '&#39;', '<b>', '12345', '', ' ', 'C:/Users/x y.pdf',
    's\u2028t', 's\u2029t', '\uD83D\uDE00', '\uD800', '\uDFFF', 'Bob\'s Roofing', '~0027', 'constructor',
  ];

  test('dec(enc(v)) === String(v) for every code unit in the BMP', () => {
    const broken = [];
    for (let i = 0; i < 0x10000; i++) {
      const s = 'a' + String.fromCharCode(i) + 'b';
      if (DOM.dec(DOM.enc(s)) !== s) broken.push('U+' + i.toString(16));
      if (broken.length > 4) break;
    }
    expect(broken).toEqual([]);
  });

  test('enc\'s output never contains a character either parser would act on', () => {
    const leaked = [];
    for (let i = 0; i < 0x10000; i++) {
      const out = DOM.enc('a' + String.fromCharCode(i) + 'b');
      if (!DOM.isEncoded(out)) { leaked.push('U+' + i.toString(16)); continue; }
      if (/['"\\&<>]/.test(out) || /[\u0000-\u001f\u007f\u2028\u2029]/.test(out)) leaked.push('U+' + i.toString(16));
      if (leaked.length > 4) break;
    }
    expect(leaked).toEqual([]);
  });

  test('the named specimens round-trip, including the ones the HTML parser rewrites', () => {
    SPECIMENS.forEach((s) => {
      expect({ s, back: DOM.dec(DOM.enc(s)) }).toEqual({ s, back: s });
    });
  });

  test('enc is injective — two different stored ids can never share one address', () => {
    const seen = new Map();
    const corpus = SPECIMENS.concat(['~007E0027', '~0027', 'a~0026b', 'a&b']);
    corpus.forEach((s) => {
      const k = DOM.enc(s);
      if (seen.has(k) && seen.get(k) !== s) throw new Error('collision: ' + JSON.stringify([seen.get(k), s]));
      seen.set(k, s);
    });
    expect(seen.size).toBe(new Set(corpus).size);
  });

  test('enc is deterministic — a row keeps its address across a repaint', () => {
    // js/line-identity.js invariant 2. A stateful token registry would have
    // re-addressed every row on every paint and detached the caret mid-edit.
    SPECIMENS.forEach((s) => {
      expect(DOM.enc(s)).toBe(DOM.enc(s));
      expect(DOM.enc(s)).toBe(DOM.enc(String(s)));
    });
  });

  test('enc is the IDENTITY on every id this app mints', () => {
    // Which is why data-line-id reads in DevTools exactly as it always has,
    // and why every existing selector against it still matches.
    const LID = require('../js/line-identity.js');
    for (let i = 0; i < 200; i++) {
      const id = LID.newLineId(i % 2 ? 'l' : 's');
      expect(DOM.enc(id)).toBe(id);
    }
    ['est_1712345678901_ab12cd', 'alt_1712345678901', 'co_1', 'l_mabc_xy', 's1712345678901', '0', '12345']
      .forEach((id) => expect(DOM.enc(id)).toBe(id));
  });

  test('code() keeps the TYPE a handler receives today', () => {
    // A numeric primary key must still arrive as a number, or every === in the
    // admin screens changes meaning.
    expect(DOM.code(7)).toBe('7');
    expect(DOM.code('7')).toBe('7');
    expect(DOM.code(0)).toBe('0');
    expect(DOM.code(-3.5)).toBe('-3.5');
    expect(DOM.code(null)).toBe('null');
    expect(DOM.code(undefined)).toBe('undefined');
    expect(DOM.code(true)).toBe('true');
    // …and anything that is not a number becomes a STRING rather than the bare
    // identifier it used to emit, which is what closed the code-position hole.
    // The parentheses survive as TEXT, and that is the point: they are inside
    // a literal that the encoder has made unclosable, so they are characters
    // rather than syntax.
    expect(DOM.code('1);alert(1);//')).toBe("p86Dec('1);alert(1);//')");
    expect(DOM.code('abc')).toBe("p86Dec('abc')");
  });

  test('a break-out payload compiled through code() calls nothing', () => {
    const PAYLOADS = [
      '1);alert(1);//', "');alert(1);//", '1),f(),g(', '1;f();', '1)});f();({a:(1',
      '\\', "'", '1 + f()', '`${f()}`',
    ];
    PAYLOADS.forEach((p) => {
      let fired = 0;
      const f = new Function('p86Dec', 'f', 'g', 'alert', 'return (' + DOM.code(p) + ');');
      const hit = () => { fired++; };
      const got = f(DOM.dec, hit, hit, hit);
      expect({ p, fired, got }).toEqual({ p, fired: 0, got: p });
    });
  });

  test('every expression code() emits parses, and evaluates back to the value', () => {
    const vals = SPECIMENS.concat([7, 0, -3.5, '7', true, null, undefined, '1);alert(1);//']);
    vals.forEach((v) => {
      const expr = DOM.code(v);
      // eslint-disable-next-line no-new-func
      const f = new Function('p86Dec', 'return (' + expr + ');');
      const got = f(DOM.dec);
      const want = (v === null || v === undefined || typeof v === 'boolean') ? v
        : (typeof v === 'number' || (String(v).trim() !== '' && isFinite(Number(v)))) ? Number(v) : String(v);
      expect({ v: String(v), got }).toEqual({ v: String(v), got: want });
    });
  });
});
