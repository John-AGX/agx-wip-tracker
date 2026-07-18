// Assembly formula engine — the S0 parametric layer's calculator. A tiny,
// SAFE arithmetic evaluator (no eval/Function): numbers, parameter names,
// + - * /, parentheses, and a fixed function set. Used on BOTH sides:
// the browser (live previews in the recipe editor + Scope Builder) and the
// server (require()'d by services/assemblies.js for the explode endpoint) —
// one implementation so a formula can never compute differently in the two
// places money is shown.
//
// Semantics: a formula computes an item's TOTAL quantity from the param
// scope. The reserved param Q is always present = the takeoff quantity in
// the assembly's output unit, so "posts for a fence" is ceil(Q/8)+1 and a
// picket count can be ceil(Q*12/5.5). Identifier lookup is case-insensitive.
(function () {
  'use strict';

  var MAX_LEN = 200;
  var MAX_TOKENS = 120;
  // Snap float noise (0.1*3*10 → 3.0000000000000004) before integer ops —
  // otherwise ceil() over-counts by one whenever IEEE noise lands a hair
  // above an integer, and ceil(Q/S) is THE canonical quantity idiom.
  function snapInt(v) { var r = Math.round(v); return Math.abs(v - r) < 1e-9 ? r : v; }
  var FUNCS = {
    ceil: { n: 1, f: function (a) { return Math.ceil(snapInt(a[0])); } },
    floor: { n: 1, f: function (a) { return Math.floor(snapInt(a[0])); } },
    round: { n: 1, f: function (a) { return Math.round(snapInt(a[0])); } },
    abs: { n: 1, f: function (a) { return Math.abs(a[0]); } },
    sqrt: { n: 1, f: function (a) { return Math.sqrt(a[0]); } },
    min: { n: -2, f: function (a) { return Math.min.apply(null, a); } },   // -N = "at least N args"
    max: { n: -2, f: function (a) { return Math.max.apply(null, a); } },
  };

  function tokenize(src) {
    var s = String(src == null ? '' : src).trim();
    if (!s) return { error: 'Formula is empty' };
    if (s.length > MAX_LEN) return { error: 'Formula is too long (max ' + MAX_LEN + ' characters)' };
    var toks = [], i = 0;
    while (i < s.length) {
      var c = s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if ('+-*/(),'.indexOf(c) >= 0) { toks.push({ t: c }); i++; continue; }
      if (c >= '0' && c <= '9' || c === '.') {
        var j = i;
        while (j < s.length && (s[j] >= '0' && s[j] <= '9' || s[j] === '.')) j++;
        var rawNum = s.slice(i, j);
        var numv = parseFloat(rawNum);
        // parseFloat stops at a second dot ("1..5" → 1) — reject the whole
        // run so a doubled keystroke can't silently misprice a row.
        if (!isFinite(numv) || rawNum.indexOf('.') !== rawNum.lastIndexOf('.')) return { error: 'Bad number "' + rawNum + '"' };
        toks.push({ t: 'num', v: numv }); i = j; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        var k = i;
        while (k < s.length && /[A-Za-z0-9_]/.test(s[k])) k++;
        toks.push({ t: 'ident', v: s.slice(i, k) }); i = k; continue;
      }
      return { error: 'Unexpected character "' + c + '"' };
    }
    if (toks.length > MAX_TOKENS) return { error: 'Formula is too complex' };
    return { toks: toks };
  }

  // Recursive-descent parse straight to a value (params in scope) OR, with
  // collect set, to the list of identifiers used (validation without values).
  function run(src, scope, collect) {
    var tk = tokenize(src);
    if (tk.error) return { ok: false, error: tk.error };
    var toks = tk.toks, p = 0;
    var idents = collect ? [] : null;
    // Case-insensitive scope lookup map. Blank / null / boolean values are
    // treated as ABSENT (→ a clear "unknown parameter" error), never as 0 —
    // Number('') === 0 would silently zero-price a cleared input.
    var lut = {};
    if (scope) Object.keys(scope).forEach(function (k) {
      var raw = scope[k];
      if (raw === '' || raw == null || typeof raw === 'boolean') return;
      var n = Number(raw);
      if (isFinite(n)) lut[k.toUpperCase()] = n;
    });

    function fail(msg) { var e = new Error(msg); e._formula = true; throw e; }
    function peek() { return toks[p] || null; }
    function eat(t) {
      if (!toks[p] || toks[p].t !== t) fail('Expected "' + t + '"' + (toks[p] ? ' but found "' + (toks[p].v != null ? toks[p].v : toks[p].t) + '"' : ' but the formula ended'));
      return toks[p++];
    }

    function expr() {
      var v = term();
      while (peek() && (peek().t === '+' || peek().t === '-')) {
        var op = toks[p++].t;
        var r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function term() {
      var v = factor();
      while (peek() && (peek().t === '*' || peek().t === '/')) {
        var op = toks[p++].t;
        var r = factor();
        if (op === '/') {
          if (!collect && r === 0) fail('Division by zero');
          v = v / (collect ? 1 : r);
        } else v = v * r;
      }
      return v;
    }
    function factor() {
      if (peek() && peek().t === '-') { p++; return -factor(); }
      if (peek() && peek().t === '+') { p++; return factor(); }
      return primary();
    }
    function primary() {
      var t = peek();
      if (!t) fail('Formula ended unexpectedly');
      if (t.t === 'num') { p++; return t.v; }
      if (t.t === '(') { p++; var v = expr(); eat(')'); return v; }
      if (t.t === 'ident') {
        p++;
        var name = t.v;
        if (peek() && peek().t === '(') {
          // Own-property guard — "constructor"/"__proto__" must be unknown
          // functions, not prototype leaks that validate-pass but eval-fail.
          var fname = name.toLowerCase();
          var fn = Object.prototype.hasOwnProperty.call(FUNCS, fname) ? FUNCS[fname] : null;
          if (!fn) fail('Unknown function "' + name + '" — available: ' + Object.keys(FUNCS).join(', '));
          p++;
          var args = [];
          if (peek() && peek().t !== ')') {
            args.push(expr());
            while (peek() && peek().t === ',') { p++; args.push(expr()); }
          }
          eat(')');
          if (fn.n >= 0 ? args.length !== fn.n : args.length < -fn.n) {
            fail(name + '() needs ' + (fn.n >= 0 ? fn.n : 'at least ' + (-fn.n)) + ' argument(s)');
          }
          return collect ? 1 : fn.f(args);
        }
        if (collect) { idents.push(name); return 1; }
        var uv = lut[name.toUpperCase()];
        if (uv === undefined || !isFinite(uv)) {
          fail('Unknown parameter "' + name + '"' + (scope ? ' — available: ' + Object.keys(scope).join(', ') : ''));
        }
        return uv;
      }
      fail('Unexpected "' + t.t + '"');
    }

    try {
      var value = expr();
      if (p !== toks.length) return { ok: false, error: 'Unexpected "' + (toks[p].v != null ? toks[p].v : toks[p].t) + '" after the end of the formula' };
      if (collect) return { ok: true, idents: idents };
      if (!isFinite(value)) return { ok: false, error: 'Formula did not produce a finite number' };
      return { ok: true, value: value };
    } catch (e) {
      if (e && e._formula) return { ok: false, error: e.message };
      return { ok: false, error: 'Formula error' };
    }
  }

  var api = {
    // evaluate('ceil(Q/8)+1', {Q: 100}) → {ok:true, value:14} | {ok:false, error}
    evaluate: function (src, scope) { return run(src, scope || {}, false); },
    // validate('ceil(Q/S)+1', ['Q','S']) → null | error string. Checks syntax
    // AND that every identifier is a known param (case-insensitive).
    validate: function (src, paramKeys) {
      var r = run(src, null, true);
      if (!r.ok) return r.error;
      var known = {};
      (paramKeys || []).forEach(function (k) { known[String(k).toUpperCase()] = 1; });
      for (var i = 0; i < r.idents.length; i++) {
        if (!known[r.idents[i].toUpperCase()]) {
          return 'Unknown parameter "' + r.idents[i] + '" — declared: ' + (paramKeys && paramKeys.length ? paramKeys.join(', ') : '(none)');
        }
      }
      return null;
    },
    // The identifiers a formula references (deduped, as written).
    idents: function (src) {
      var r = run(src, null, true);
      if (!r.ok) return [];
      var seen = {}, out = [];
      r.idents.forEach(function (k) { var u = k.toUpperCase(); if (!seen[u]) { seen[u] = 1; out.push(k); } });
      return out;
    },
    FUNCS: Object.keys(FUNCS),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.p86Formula = api;
})();
