// Live Rooms — phase 03, GUEST SIDE. The stage that hosts the host's pane.
//
// ══ WHY THE MIRRORED DOCUMENT LIVES IN A SANDBOXED IFRAME ══════════════════
// server/index.js:478 mounts express.static on the repo root with no auth, so a
// guest CAN link the app's real stylesheets and get true fidelity for free. But
// those sheets carry bare `body`, `button`, `input`, `table`, `th`, `td`
// selectors — and js/live-view.js's own header records that `.card` already
// silently beat the app's card once on this page. Linking them into the guest
// shell would eat the guest shell.
//
// So the mirrored document lives in a same-origin <iframe> with
// sandbox="allow-same-origin" AND NOTHING ELSE. That one attribute buys, at
// zero cost:
//
//   • real cascade isolation — the app's sheets apply to the mirror at full
//     fidelity and cannot reach the guest shell. css/live-surface.css and
//     scripts/build-live-surface-css.js are untouched and still serve the
//     projected path.
//   • <script> CANNOT EXECUTE, even if serialization ever missed one. A second,
//     independent guard behind the serializer's hard drop.
//   • forms cannot submit and links cannot navigate the top frame.
//   • declarative CSS animations, @media, @keyframes and fonts all still work,
//     because the sandbox blocks scripting, not styling.
//
// The shell reaches the stage by contentDocument (same-origin), so NO
// postMessage is involved — which matters, because
// test/live-host-guest-bleed.test.js asserts that neither live.html nor any
// live JS file touches postMessage, localStorage, sessionStorage, indexedDB or
// BroadcastChannel. That invariant survives intact.
//
// ══ A GUEST OBSERVES ═══════════════════════════════════════════════════════
// The stage is pointer-events:none. No input mirroring, no writes, no reaching
// past the room. That also costs text selection, which is a real loss — and it
// is paid for by mode 1: the bar keeps a one-tap "Read the structured version",
// which switches the same surface to the projected document. Selectable, typed,
// semantic, already built, already tested. The projected path does not merely
// survive the mirror; it is the mirror's accessibility and copy fallback.
//
// ══ NOTHING PERSISTS ═══════════════════════════════════════════════════════
// The mirrored DOM is the most sensitive thing this feature has ever put in a
// guest browser. Memory only, in an iframe, cleared on EVERY terminal state —
// the same rule showDead() already enforces for the projected surface, and for
// the same reason it was written: a revoked link that left the WIP table on
// screen would be persisting past a kick.

(function () {
  'use strict';

  // ── What a substituted element says ────────────────────────────────────
  // A placeholder of the same box, in a card treatment, carrying one sentence.
  // Never a blank rectangle, never a broken-image glyph: a blank rectangle looks
  // like the real thing failed to load.
  var REASON_TEXT = {
    'drawing': 'Drawing — not shared',
    'embedded page': 'Embedded page — not shared',
    'embedded content': 'Embedded content — not shared',
    'map': 'Map — not shared',
    'video': 'Video — not shared',
    'audio': 'Audio — not shared',
    'not shared': 'Hidden from viewers',
    'sign-in required': 'Image needs a sign-in — not shared',
    'API key': 'Map — not shared',
    'local file': 'Local file — not shared',
    'external': 'External image — not shared',
    'large image': 'Image too large to mirror',
    'inline data': 'Embedded data — not shared',
    'script link': 'Link — not shared',
    'relative link': 'Link — not shared',
    'empty': 'Not shared'
  };
  function reasonText(r) {
    return Object.prototype.hasOwnProperty.call(REASON_TEXT, r) ? REASON_TEXT[r] : 'Not shared';
  }

  // The stage's own sheet, injected into the iframe. Everything here is about
  // the STAGE, never about the app's own components — those come from the app's
  // real sheets, linked by URL.
  var STAGE_CSS = [
    'html,body{margin:0;padding:0;overflow:hidden;}',
    // A guest observes. Nothing on this stage takes a pointer, which also means
    // a guest's finger can never produce a :hover state the host never had.
    'body *{pointer-events:none !important;}',
    // The host's own controls are serialized so the layout is his, but they are
    // visibly not the guest's to press.
    'button,input,select,textarea,a{opacity:.62 !important;cursor:default !important;}',
    'lm-x{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;',
    'min-width:40px;min-height:20px;border:1px dashed rgba(140,150,175,.55);border-radius:6px;',
    'background:rgba(120,130,160,.08);color:#8b90a5;font:600 11px/1.3 Inter,system-ui,sans-serif;',
    'text-align:center;padding:6px;overflow:hidden;}',
    'lm-x::after{content:attr(data-lm-label);}'
  ].join('');

  var G = {
    stage: null,       // the <iframe>
    doc: null,         // its contentDocument
    byId: null,        // id -> node inside the stage
    snapSeq: 0,
    surface: null,
    meta: null,
    fit: false,
    host: null         // the element the stage is mounted into
  };

  function clear() {
    if (G.stage) { try { G.stage.remove(); } catch (e) {} }
    G.stage = null; G.doc = null; G.byId = null;
    G.snapSeq = 0; G.surface = null; G.meta = null;
  }

  function ensureStage(hostEl) {
    if (G.stage && G.stage.isConnected && G.host === hostEl) return G.stage;
    clear();
    G.host = hostEl;
    var f = document.createElement('iframe');
    // allow-same-origin and NOTHING else. No allow-scripts, no allow-forms, no
    // allow-popups, no allow-top-navigation.
    f.setAttribute('sandbox', 'allow-same-origin');
    f.setAttribute('title', 'Mirrored screen');
    f.setAttribute('aria-label', 'Mirrored screen, read-only');
    f.className = 'lm-stage';
    hostEl.appendChild(f);
    G.stage = f;
    return f;
  }

  // ── Rendering a serialized descriptor ──────────────────────────────────
  function build(doc, d) {
    if (!d) return null;
    if (Object.prototype.hasOwnProperty.call(d, 'x') && !d.t) {
      var t = doc.createTextNode(String(d.x));
      G.byId.set(d.i, t);
      return t;
    }
    var tag = String(d.t || 'div');
    var el;
    // SVG needs the right namespace or it renders as nothing at all, and
    // p86Icon() puts inline SVG through every one of these panes.
    if (tag === 'svg' || SVG_TAGS.indexOf(tag) >= 0) {
      el = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    } else {
      el = doc.createElement(tag);
    }
    var a = d.a || {};
    for (var k in a) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
      setAttr(el, k, a[k]);
    }
    if (tag === 'lm-x') el.setAttribute('data-lm-label', reasonText(a['data-lm-reason']));
    var kids = d.c || [];
    for (var i = 0; i < kids.length; i++) {
      var c = build(doc, kids[i]);
      if (c) el.appendChild(c);
    }
    G.byId.set(d.i, el);
    return el;
  }

  var SVG_TAGS = ['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'defs', 'use', 'ellipse', 'text', 'tspan'];

  function setAttr(el, k, v) {
    if (v == null) { try { el.removeAttribute(k); } catch (e) {} return; }
    if (k === 'data-lm-css') {
      // A runtime <style> block, carried as text so it can be scrubbed on the
      // way out. Written back as the element's own rules here.
      try { el.textContent = String(v); } catch (e) {}
      return;
    }
    if (k === 'data-lm-value') { try { el.value = String(v); } catch (e) {} return; }
    if (k === 'data-lm-checked') { try { el.checked = !!v; } catch (e) {} return; }
    if (k === 'data-lm-scroll') {
      var p = String(v).split(',');
      try { el.scrollTop = Number(p[0]) || 0; el.scrollLeft = Number(p[1]) || 0; } catch (e) {}
      return;
    }
    try { el.setAttribute(k, String(v)); } catch (e) {}
    if (k === 'data-lm-reason') { try { el.setAttribute('data-lm-label', reasonText(v)); } catch (e) {} }
  }

  function writeShell(doc, meta) {
    var rs = (meta && meta.root_state) || {};
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    try {
      doc.documentElement.className = String(rs.htmlClass || '');
      var vars = rs.vars || {};
      for (var v in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, v)) doc.documentElement.style.setProperty(v, vars[v]);
      }
      doc.body.className = String(rs.bodyClass || '');
    } catch (e) {}
    var css = (meta && meta.css) || { links: [], inline: [] };
    // The app's REAL sheets, at the host's own ?v — the two ends request
    // byte-identical URLs, so the stage is exactly as fresh as the host's own
    // page is. (The service worker's cache branch sees both the same way; this
    // page's /live/ bypass at sw.js:152 covers the navigation only.)
    for (var i = 0; i < (css.links || []).length; i++) {
      var l = doc.createElement('link');
      l.rel = 'stylesheet';
      l.href = css.links[i];
      doc.head.appendChild(l);
    }
    for (var s = 0; s < (css.inline || []).length; s++) {
      var st = doc.createElement('style');
      st.textContent = css.inline[s];
      doc.head.appendChild(st);
    }
    var own = doc.createElement('style');
    own.textContent = STAGE_CSS;
    doc.head.appendChild(own);
  }

  // ── Viewport ───────────────────────────────────────────────────────────
  // LETTERBOX AND SCALE, NEVER REFLOW. The app has mobile breakpoints; letting
  // them fire at the GUEST's width against markup the host is viewing at desktop
  // width produces a layout the host has never seen and cannot describe — which
  // breaks the one thing the mirror exists for.
  //
  // So the stage is set to the host's own SHELL width (the pane's real width,
  // not the host's window: the sidebar and the 86 panel take 300-400px of it),
  // media queries evaluate at that width inside the iframe, and the guest gets
  // the host's layout. Fit-to-width alone would be wrong too — 375/1250 is
  // 0.30x and 11px body text lands at 3px — so the default is 1:1 with pan, and
  // "fit" is a toggle for orientation.
  function layout() {
    if (!G.stage || !G.meta) return;
    var w = Math.max(320, Number(G.meta.w) || 1200);
    var h = Math.max(200, Number(G.meta.h) || 800);
    G.stage.style.width = w + 'px';
    G.stage.style.height = h + 'px';
    var host = G.host;
    var avail = host ? host.clientWidth : w;
    var scale = G.fit ? Math.min(1, avail / w) : 1;
    G.stage.style.transform = 'scale(' + scale + ')';
    G.stage.style.transformOrigin = '0 0';
    if (host) {
      host.style.height = Math.round(h * scale) + 'px';
      host.style.overflow = G.fit ? 'hidden' : 'auto';
    }
  }

  window.p86LiveMirrorGuest = {
    reasonText: reasonText,

    /** Wipe the stage. Called on EVERY terminal state. */
    teardown: clear,

    have: function () { return !!(G.stage && G.doc && G.snapSeq); },
    snapSeq: function () { return G.snapSeq; },
    surface: function () { return G.surface; },

    setFit: function (on) { G.fit = !!on; layout(); },
    fit: function () { return G.fit; },

    /**
     * A whole frame. Replaces the stage document — never patches across a
     * snapshot boundary, because patching a document you do not have a base for
     * builds a DOM out of nothing.
     */
    applySnapshot: function (hostEl, snap) {
      if (!hostEl || !snap || !snap.root) return false;
      var f = ensureStage(hostEl);
      var doc = null;
      try { doc = f.contentDocument; } catch (e) { doc = null; }
      if (!doc) return false;
      G.doc = doc;
      G.byId = new Map();
      writeShell(doc, snap.meta);
      var root = build(doc, snap.root);
      if (root) doc.body.appendChild(root);
      G.snapSeq = Number(snap.snapSeq) || 0;
      G.surface = snap.surface || null;
      G.meta = snap.meta || {};
      layout();
      return true;
    },

    /**
     * A delta. Ordering discipline mirrors the sender's: adds are placed against
     * their recorded reference sibling, removes prune the map, and any op whose
     * target has left the map is DROPPED rather than guessed at — a patch
     * applied to the wrong node is worse than a missing patch, because it looks
     * like data.
     */
    applyOps: function (ops, snapSeq) {
      if (!G.doc || !G.byId) return false;
      if (Number(snapSeq) !== G.snapSeq) return false;   // not our base: caller pulls
      var list = Array.isArray(ops) ? ops : [];
      for (var i = 0; i < list.length; i++) {
        var op = list[i];
        if (!op) continue;
        try {
          if (op.o === 'r') {
            var gone = G.byId.get(op.i);
            if (gone && gone.parentNode) gone.parentNode.removeChild(gone);
            G.byId.delete(op.i);
          } else if (op.o === 'a') {
            var parent = G.byId.get(op.p);
            if (!parent) continue;
            var node = build(G.doc, op.n);
            if (!node) continue;
            var before = op.b == null ? null : G.byId.get(op.b);
            if (before && before.parentNode === parent) parent.insertBefore(node, before);
            else parent.appendChild(node);
          } else if (op.o === 't') {
            var tn = G.byId.get(op.i);
            if (tn) tn.data = String(op.x == null ? '' : op.x);
          } else if (op.o === 's') {
            var el = G.byId.get(op.i);
            if (el && el.nodeType === 1) setAttr(el, op.k, op.v);
          } else if (op.o === 'p') {
            var sc = G.byId.get(op.i);
            if (sc && sc.nodeType === 1) { sc.scrollTop = Number(op.y) || 0; sc.scrollLeft = Number(op.x) || 0; }
          }
        } catch (e) { /* one bad op must not kill the stage */ }
      }
      return true;
    },

    relayout: layout
  };
})();
