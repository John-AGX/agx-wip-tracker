// Live Rooms — phase 03, HOST SIDE. The presenter's pane, serialized.
//
// ══ THE THIRD-BLEED RULE, WHICH THIS FILE IS THE RISKIEST THING YET BUILT
//    AGAINST ═════════════════════════════════════════════════════════════
// A mirror runs INSIDE the presenter's document, observing it. Three host/guest
// bleeds have already happened on this feature. So this file:
//
//   • mounts NOTHING on the host body — zero document.body.appendChild. The
//     "what is being shared" frame is drawn inside the cursor layer
//     js/live-rooms.js already owns, which is already pointer-events:none and
//     already covered by the two-mounts assertion.
//   • patches NO prototype. Not CSSStyleSheet, not CSSStyleDeclaration, not
//     CanvasRenderingContext2D, not Node, not Element. This is the single
//     largest reason rrweb was not vendored: it Proxies two CSSOM prototypes
//     in the recorded document unconditionally, and "the presenter's app gains
//     nothing but an overlay" is a tested property here.
//   • sets NO attribute and NO property on any app node. Node identity lives in
//     a WeakMap, not in a data- attribute stamped onto the host's DOM.
//   • binds NO listener to an app element. One MutationObserver, and the
//     repaint of the frame is driven from the 1 Hz tick live-rooms.js already
//     runs — no new timer, no scroll handler, no rAF loop.
//   • serializes OFF the observer callback. Records are queued; the walk runs
//     on a timer, so a paint the host is watching never waits for us.
//   • tears down to nothing. stop() disconnects, drops both maps, and clears
//     the frame. test/live-host-guest-bleed.test.js counts host-document nodes
//     and attributes before and after and requires equality.
//
// ══ THE BOUNDARY IS AN ALLOW-LIST OF ONE SUBTREE, PLUS A DENYLIST ══════════
// The capture root is the pane the SERVER authorized on this flush, plus a
// pruned shell of its own ancestors (see collectShell — without it the guest
// gets a bare pane on a blank page: .ws-right-content is where the padding, the
// border and the SCROLLER live, and #job-info-card, which is on screen on every
// tab, is its sibling).
//
// Ancestry is necessary but not sufficient, so DENY is a second, independent
// gate checked per node on both the snapshot walk and every mutation.
// js/ai-panel.js:2012 does hostEl.appendChild(panel) — the 86 panel REPARENTS
// into host containers — so a denied node can genuinely arrive inside an
// authorized root.
//
// .p86-live-strip is on that list by name and it is the most important entry:
// js/live-rooms.js:1041 renders location.origin + '/live/' + token — THE ROOM'S
// OWN BEARER CREDENTIAL — into a <code> element in the host's body, beside the
// roster and the kick buttons. A mirror that ever captured it would ship the
// credential and every guest's name to everyone the link had been forwarded to.
//
// ══ ATTRIBUTES ARE AN ALLOW-LIST OF NAMES *AND* A FILTER ON VALUES ═════════
// An allow-list of NAMES does not catch what this app puts in them.
// services/live-rooms.js:150 states the invariant — "no entity_id: a guest
// holds a link, not a login, and must not be able to read the id of the thing
// they are looking at" — and services/live-routes.js:166 names re-leaking it
// through the mirror as the regression to avoid. In the two mirrored panes:
//
//   js/jobs.js:826  data-co-open="<co uuid>"      on every CO row
//   js/jobs.js:851  data-co-new="<jobId>"         — THE ROOM'S OWN entity_id
//   js/schedule.js:3686  id="schJobWxBody-<jobId>" — the same, in an id
//
// So data-* is dropped except a frozen presentational allow-list, and every
// surviving value — id, class, style, aria-* — is run through scrubIdValue,
// which replaces id-SHAPED tokens (uuid, prefix_base36_hex, long hex, long
// digit runs) with a synthetic token. Ids that carry no such token survive
// intact, because CSS selects on them.

(function () {
  'use strict';

  // ══ PURE CORE ══════════════════════════════════════════════════════════
  // No DOM, no network. Exported for Node so the test suite asserts the actual
  // lists that ship rather than a copy of them.

  // Mirrored surfaces, restated so a drift between this and
  // server/services/live-mirror.js is a failing test rather than a silent
  // divergence in what gets captured.
  var MIRROR_ROOTS = {
    'job-wip-report': 'job-wip-report',
    'job-changeorders': 'job-changeorders'
  };

  // Never serialized, never placeholdered, never mentioned. A hole where one of
  // these was is invisible because none of them render.
  var HARD_DROP = ['script', 'noscript', 'link', 'base', 'meta', 'template', 'source', 'track', 'foreignobject', 'style'];

  // Serialized as a labelled, same-size box with a stated reason. NEVER as a
  // blank rectangle: a blank rectangle looks like the real thing failed to
  // load, and the honesty rule says say so instead.
  var SUBSTITUTE = {
    canvas: 'drawing',
    iframe: 'embedded page',
    object: 'embedded content',
    embed: 'embedded content',
    video: 'video',
    audio: 'audio'
  };

  // The second gate. Checked per node, on the snapshot walk AND on every
  // mutation, and the capture root's own ancestry is re-checked on every flush
  // (nodegraph/ui.js:3155 MOVES the real pane element into the Site Plan
  // inspector, so a root can travel into a denied region without any mutation
  // inside it).
  var DENY = [
    '#p86-ai-panel',            // the 86 panel and its whole conversation
    '#p86-live-writer',
    '#p86-live-pane',
    '.p86-live-strip',          // THE ROOM URL, the roster and the kick buttons
    '.p86-live-cursors',
    '.p86-co-overlay',
    '.po-ed-overlay',
    '.p86-report-overlay',
    '.p86-report-preview-overlay',
    '.ws-floating-panel',
    '#materials-drawer-root',
    '.modal',
    '[data-live-private]'       // generic opt-out: a future feature excludes
                                // itself without editing this file
  ];

  // What each denied thing is CALLED, in the host's own words. The strip's
  // "what they can see" list is generated from this map rather than typed out
  // beside it, and test/live-host-guest-bleed.test.js asserts every DENY entry
  // has a label and every label reaches the strip — so the affordance cannot
  // drift from the enforcement. A promise on screen that the code stopped
  // keeping is worse than no promise.
  var DENY_LABELS = {
    '#p86-ai-panel': 'the 86 panel and your conversation with it',
    '#p86-live-writer': 'the Live Writer',
    '#p86-live-pane': 'the Live Writer pane',
    '.p86-live-strip': 'this bar, the viewer link and the watcher list',
    '.p86-live-cursors': 'the cursor layer',
    '.p86-co-overlay': 'the change-order editor',
    '.po-ed-overlay': 'the purchase-order editor',
    '.p86-report-overlay': 'report previews',
    '.p86-report-preview-overlay': 'report previews',
    '.ws-floating-panel': 'floating panels',
    '#materials-drawer-root': 'the materials drawer',
    '.modal': 'pop-up windows',
    '[data-live-private]': 'anything marked private'
  };

  // Attribute NAMES that may cross. Everything else — every on* handler
  // included — is absent by construction rather than by a deny rule someone
  // has to remember.
  var ATTR_ALLOW = [
    'id', 'class', 'style', 'title', 'alt', 'width', 'height', 'colspan', 'rowspan',
    'type', 'placeholder', 'disabled', 'readonly', 'checked', 'selected', 'multiple',
    'open', 'hidden', 'lang', 'dir', 'role', 'headers', 'scope', 'span', 'start', 'reversed',
    'viewbox', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'cx', 'cy', 'r', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points', 'rx', 'ry',
    'transform', 'opacity', 'fill-rule', 'clip-rule', 'xmlns', 'preserveaspectratio',
    'colspan', 'align', 'valign'
  ];

  // data-* is dropped wholesale EXCEPT these, which drive CSS in the app's own
  // sheets. Every one of them still passes through the value filter.
  var DATA_ALLOW = ['data-p86-icon', 'data-panel', 'data-state', 'data-kind', 'data-editing', 'data-sig'];

  // Cross-origin hosts an <img> may keep. R2 public attachment URLs are already
  // unauthenticated bearer URLs (server/storage.js R2_PUBLIC_BASE), so mirroring
  // one discloses nothing the URL did not already disclose — but it is a STATED
  // decision, not an accident, and it carries a consequence the rest of this
  // feature does not: an R2 URL keeps working after the room ends. Membership,
  // expiry, kick and revoke govern the room; they do not govern a URL somebody
  // already has. The host is told this once, at mode selection.
  var IMG_HOST_ALLOW = ['attachments.project86.net'];

  // ── Value filtering ────────────────────────────────────────────────────
  // An id-SHAPED token, in the four shapes this app mints them in.
  var ID_SHAPES = [
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,  // uuid
    /\b[a-z]{2,5}_[a-z0-9]{6,12}_[0-9a-f]{6,16}\b/gi,                   // genId()
    /\b[0-9a-f]{24,}\b/gi,                                              // long hex
    /\b\d{9,}\b/g                                                       // long digit runs
  ];

  function looksLikeId(v) {
    var s = String(v == null ? '' : v);
    for (var i = 0; i < ID_SHAPES.length; i++) {
      ID_SHAPES[i].lastIndex = 0;
      if (ID_SHAPES[i].test(s)) return true;
    }
    return false;
  }

  /**
   * Replace every id-shaped token in a value. Not "drop the attribute": an id
   * on a wrapper is frequently what a CSS rule selects, and dropping it changes
   * the layout. Replacing the TOKEN keeps the selector's shape and removes the
   * record key.
   */
  function scrubIdValue(v) {
    var s = String(v == null ? '' : v);
    for (var i = 0; i < ID_SHAPES.length; i++) {
      ID_SHAPES[i].lastIndex = 0;
      s = s.replace(ID_SHAPES[i], 'x');
    }
    return s;
  }

  // CSS text gets the same treatment, plus url() removal: a stylesheet the host
  // injected can carry both an id selector and a signed URL.
  function scrubCss(css) {
    return scrubIdValue(String(css == null ? '' : css)).replace(/url\(([^)]*)\)/gi, 'none');
  }

  /**
   * May this URL cross, and if not, why not. Returns null to keep, or a reason
   * string to substitute.
   *
   * The Static Maps key is the case "they have access anyway" does not cover:
   * js/projects.js:3802 builds maps.googleapis.com/maps/api/staticmap?...&key=
   * and /api/config/maps-key is requireAuth, so a forwarded-link holder — who is
   * authenticated to nothing — never legitimately holds it. Two independent
   * guards, one policy (report overlays are denied roots) and one mechanism
   * (this).
   */
  function urlVerdict(raw, origin) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return 'empty';
    if (s.charAt(0) === '#') return null;                 // svg <use>, in-doc refs
    if (/^data:image\//i.test(s)) return s.length > 65536 ? 'large image' : null;
    if (/^data:/i.test(s)) return 'inline data';
    if (/^blob:/i.test(s)) return 'local file';           // document-scoped; dead in a guest tab
    if (/^javascript:/i.test(s)) return 'script link';
    var host = null, path = s;
    var m = /^https?:\/\/([^\/?#]+)([^?#]*)/i.exec(s);
    if (m) { host = m[1].toLowerCase(); path = m[2] || ''; }
    else if (s.charAt(0) !== '/') return 'relative link';
    if (/[?&]key=/i.test(s)) return 'API key';            // never, from any host
    if (host) {
      if (/(^|\.)googleapis\.com$/.test(host) || /(^|\.)google\.com$/.test(host)) return 'map';
      for (var i = 0; i < IMG_HOST_ALLOW.length; i++) if (host === IMG_HOST_ALLOW[i]) return null;
      if (origin && ('https://' + host) !== origin && ('http://' + host) !== origin) return 'external';
    }
    if (/^\/api\//i.test(path)) return 'sign-in required'; // /api/attachments/raw/:id is requireAuth: 401 for a guest
    return null;
  }

  function isAllowedAttr(name) {
    var n = String(name || '').toLowerCase();
    if (n.indexOf('on') === 0) return false;               // never, at any length
    if (n.indexOf('aria-') === 0) return true;
    if (n.indexOf('data-') === 0) return DATA_ALLOW.indexOf(n) >= 0;
    return ATTR_ALLOW.indexOf(n) >= 0;
  }

  function tagVerdict(tag) {
    var t = String(tag || '').toLowerCase();
    if (HARD_DROP.indexOf(t) >= 0) return { drop: true };
    if (Object.prototype.hasOwnProperty.call(SUBSTITUTE, t)) return { substitute: SUBSTITUTE[t] };
    return {};
  }

  // What the host is told, per refusal, in his own terms. A byte-for-byte copy
  // of server/services/live-mirror.js HOST_REFUSAL_TEXT, and the copy is
  // asserted equal by test/live-mirror.test.js — the server owns the sentence,
  // this file cannot restate it differently, and the drift is a failing build
  // rather than two surfaces telling the presenter different things about the
  // same refusal.
  var REFUSAL_TEXT = {
    off_room: "Viewers can't see this — you're on a different record than the one you're presenting.",
    not_shared: "Viewers can't see this screen — it isn't one of the shared screens.",
    away: "Viewers can't see anything — you've left the job you're presenting.",
    ledger: 'This screen is not mirrored — it carries sub contracts, payables and internal tasks. Viewers get the structured Overview instead.',
    no_root: 'This screen is not mirrored. Viewers get the structured version instead.',
    canvas: 'The Site Plan is a drawing, not a page — it cannot be mirrored. Viewers see nothing from it.',
    not_mirrorable: 'This screen is not mirrored. Viewers get the structured version instead.',
    too_big: 'This screen is too large to mirror. Viewers get the structured version instead.',
    projected_mode: ''
  };

  var Core = {
    MIRROR_ROOTS: MIRROR_ROOTS,
    REFUSAL_TEXT: REFUSAL_TEXT,
    HARD_DROP: HARD_DROP,
    SUBSTITUTE: SUBSTITUTE,
    DENY: DENY,
    DENY_LABELS: DENY_LABELS,
    /** The sentence the host reads, built from the list that is enforced. */
    notSharedText: function () {
      var seen = [], out = [];
      for (var i = 0; i < DENY.length; i++) {
        var lbl = DENY_LABELS[DENY[i]];
        if (!lbl || seen.indexOf(lbl) >= 0) continue;
        seen.push(lbl); out.push(lbl);
      }
      return out.join(', ');
    },
    ATTR_ALLOW: ATTR_ALLOW,
    DATA_ALLOW: DATA_ALLOW,
    IMG_HOST_ALLOW: IMG_HOST_ALLOW,
    looksLikeId: looksLikeId,
    scrubIdValue: scrubIdValue,
    scrubCss: scrubCss,
    urlVerdict: urlVerdict,
    isAllowedAttr: isAllowedAttr,
    tagVerdict: tagVerdict
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined') return;   // Node: the pure core only.
  window.p86LiveMirrorCore = Core;

  // ══ SERIALIZER ═════════════════════════════════════════════════════════

  // Timings. Engineering starting points, stated as such.
  var FLUSH_MS = 100;             // coalesce a paint, then send
  var BURST_BYTES = 32768;        // flush early on a big batch
  var RESNAP_BYTES = 49152;       // past this, a pointer beats a delta
  var RESNAP_FRACTION = 0.4;      // ditto for a wholesale subtree replacement
  var DEGRADE_MS_PER_S = 30;      // main-thread share before self-downgrade
  var DEGRADE_FLUSH_MS = 3000;

  var nextId = 1;
  var ids = null;                 // WeakMap node -> id. NOTHING is stamped on the DOM.
  var byId = null;                // Map id -> node, so removals can prune
  var scrollSent = new Map();     // id -> last "top,left" sent, on OUR side only

  function idOf(node) { return ids && ids.has(node) ? ids.get(node) : null; }
  function assignId(node) {
    var i = idOf(node);
    if (i != null) return i;
    i = nextId++;
    ids.set(node, i);
    byId.set(i, node);
    return i;
  }
  function forgetSubtree(node) {
    var i = idOf(node);
    if (i != null) { byId.delete(i); ids.delete(node); }
    var kids = node && node.childNodes;
    if (!kids) return;
    for (var k = 0; k < kids.length; k++) forgetSubtree(kids[k]);
  }

  function isDenied(el) {
    if (!el || el.nodeType !== 1) return false;
    for (var i = 0; i < DENY.length; i++) {
      try { if (el.matches && el.matches(DENY[i])) return true; } catch (e) {}
    }
    return false;
  }

  // The root's ANCESTRY, re-checked every flush rather than only at attach.
  function inDeniedRegion(el) {
    var n = el;
    var guard = 0;
    while (n && n.nodeType === 1 && guard++ < 200) {
      if (isDenied(n)) return true;
      n = n.parentElement;
    }
    return false;
  }

  function boxStyle(el) {
    try {
      var r = el.getBoundingClientRect();
      var w = Math.max(0, Math.round(r.width));
      var h = Math.max(0, Math.round(r.height));
      return 'width:' + w + 'px;height:' + h + 'px;';
    } catch (e) { return ''; }
  }

  function placeholder(el, reason) {
    return {
      i: assignId(el),
      t: 'lm-x',
      a: { 'data-lm-reason': String(reason || 'not shared'), style: boxStyle(el) },
      c: []
    };
  }

  function attrsOf(el, origin) {
    var out = {};
    var list = el.attributes;
    for (var i = 0; i < list.length; i++) {
      var name = String(list[i].name || '').toLowerCase();
      var val = list[i].value;
      if (!isAllowedAttr(name)) continue;
      if (name === 'style') { out.style = scrubIdValue(val).replace(/url\(([^)]*)\)/gi, 'none'); continue; }
      out[name] = scrubIdValue(val);
    }
    // URL-bearing attributes are handled separately and NEVER copied verbatim:
    // href/action/formaction become inert data-lm-* so a stage link cannot
    // navigate anything, and src goes through urlVerdict.
    var href = el.getAttribute && el.getAttribute('href');
    if (href != null) {
      var hv = urlVerdict(href, origin);
      out['data-lm-href'] = hv ? '' : scrubIdValue(href);
    }
    var tag = String(el.tagName || '').toLowerCase();
    if (tag === 'img') {
      var src = el.getAttribute('src');
      var sv = urlVerdict(src, origin);
      if (!sv) out.src = src; else out['data-lm-blocked'] = sv;
    }
    // Input STATE is a property, not an attribute. A serializer that copies
    // attributes ships the host's initial markup while he stares at a number he
    // typed. Passwords never ship a value at all.
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      var type = String(el.getAttribute('type') || '').toLowerCase();
      if (type === 'password') { out['data-lm-value'] = ''; }
      else if (type === 'checkbox' || type === 'radio') { out['data-lm-checked'] = el.checked ? '1' : ''; }
      else { out['data-lm-value'] = scrubIdValue(el.value == null ? '' : el.value); }
    }
    return out;
  }

  function serialize(node, origin, budget) {
    if (!node) return null;
    if (node.nodeType === 3) {
      var t = node.data;
      if (t == null || t === '') return null;
      return { i: assignId(node), x: String(t) };
    }
    if (node.nodeType !== 1) return null;           // comments and the rest: gone
    var tag = String(node.tagName || '').toLowerCase();
    var v = tagVerdict(tag);
    if (v.drop) {
      // <style> is the one HARD_DROP that would cost layout, so its RULES are
      // carried — scrubbed, and as an attribute rather than as a child text
      // node, so no id in this map ever points at something that is not a real
      // host node. js/jobs.js:3696 injects rules at runtime that exist in no
      // .css file and that a <link> can therefore never reach.
      if (tag === 'style') {
        return { i: assignId(node), t: 'style', a: { 'data-lm-css': scrubCss(node.textContent) }, c: [] };
      }
      return null;
    }
    if (isDenied(node)) return placeholder(node, 'not shared');
    if (v.substitute) return placeholder(node, v.substitute);
    if (budget) budget.n += 1;
    var d = { i: assignId(node), t: tag, a: attrsOf(node, origin), c: [] };
    var kids = node.childNodes;
    for (var k = 0; k < kids.length; k++) {
      var c = serialize(kids[k], origin, budget);
      if (c) d.c.push(c);
    }
    // The scroll offset of a container is not an attribute, and without it every
    // scroll container resets to zero on the guest — which reads as "the host is
    // at the top of the table" while he is four hundred rows down. Silently
    // wrong is the worst failure mode this feature has.
    if (node.scrollTop || node.scrollLeft) {
      d.a['data-lm-scroll'] = Math.round(node.scrollTop) + ',' + Math.round(node.scrollLeft);
    }
    return d;
  }

  // ── The capture shell ──────────────────────────────────────────────────
  // The pane alone is not the host's screen. .ws-right-content (#wsRightContent,
  // css/workspace-layout.css:407) supplies the card background, the border, the
  // padding AND the overflow-y scroller, and .ws-job-info-details — the job's
  // contract / cost / margin hero — is its sibling, excluded from every hide
  // sweep (js/workspace-layout.js:1355,1677,1814,1846) and therefore on screen
  // on every tab.
  //
  // So the shell is the ancestor chain with SIBLINGS PRUNED, except the frozen
  // keep-list. That keeps the host's actual top-of-screen without re-opening
  // the exclusion problem a one-pane root was chosen to close, and it is also
  // what makes §viewport work: the stage is sized to the SHELL's own width, so
  // media queries evaluate at the width the pane really has rather than at the
  // host's whole window (which is 300-400px wider, because of the sidebar).
  var SHELL_KEEP = ['.ws-job-info-details'];
  var SHELL_STOP = ['#wsRightContent', '#jobs-job-detail-view', 'main', 'body'];
  var SHELL_MAX = 4;

  function matchesAny(el, list) {
    for (var i = 0; i < list.length; i++) {
      try { if (el.matches && el.matches(list[i])) return true; } catch (e) {}
    }
    return false;
  }

  function shellChain(pane) {
    var chain = [];
    var n = pane.parentElement;
    var depth = 0;
    while (n && n.nodeType === 1 && depth++ < SHELL_MAX) {
      chain.unshift(n);
      if (matchesAny(n, SHELL_STOP)) break;
      n = n.parentElement;
    }
    return chain;
  }

  function serializeShell(pane, origin, budget) {
    var chain = shellChain(pane);
    var inner = serialize(pane, origin, budget);
    if (!inner) return null;
    for (var i = chain.length - 1; i >= 0; i--) {
      var w = chain[i];
      if (isDenied(w)) return inner;                 // never wrap in a denied box
      var d = { i: assignId(w), t: String(w.tagName || 'div').toLowerCase(), a: attrsOf(w, origin), c: [] };
      if (w.scrollTop || w.scrollLeft) d.a['data-lm-scroll'] = Math.round(w.scrollTop) + ',' + Math.round(w.scrollLeft);
      var kids = w.children;
      for (var k = 0; k < kids.length; k++) {
        var child = kids[k];
        if (child === (i === chain.length - 1 ? pane : chain[i + 1])) { d.c.push(inner); continue; }
        if (matchesAny(child, SHELL_KEEP) && !isDenied(child)) {
          var kept = serialize(child, origin, budget);
          if (kept) d.c.push(kept);
        }
      }
      inner = d;
    }
    return inner;
  }

  // Stylesheets: the guest links the app's REAL sheets, at the host's own ?v, so
  // the two ends request byte-identical URLs. Plus every runtime <style> in the
  // head, which exists in no .css file (js/jobs.js:3696) and which a link can
  // therefore never reach.
  function collectCss() {
    var out = { links: [], inline: [] };
    try {
      var links = document.head.querySelectorAll('link[rel="stylesheet"][href]');
      for (var i = 0; i < links.length; i++) {
        var h = links[i].getAttribute('href');
        if (!h || /^https?:\/\//i.test(h)) continue;   // same-origin app sheets only
        out.links.push(h.charAt(0) === '/' ? h : ('/' + h));
      }
      var styles = document.head.querySelectorAll('style');
      for (var s = 0; s < styles.length; s++) {
        var css = styles[s].textContent || '';
        if (css.length < 200000) out.inline.push(scrubCss(css));
      }
    } catch (e) {}
    return out;
  }

  // Root-level classes and custom properties. A serializer that starts at the
  // pane drops --p86-ai-w (js/ai-panel.js:1147 sets it on documentElement) and
  // the light-mode token re-declaration (css/styles.css: body.light-mode), and
  // the guest renders in the wrong theme with no clue why.
  function rootState() {
    var vars = {};
    try {
      var st = document.documentElement.style;
      for (var i = 0; i < st.length; i++) {
        var n = st.item(i);
        if (n && n.indexOf('--') === 0) vars[n] = st.getPropertyValue(n);
      }
    } catch (e) {}
    return {
      htmlClass: (document.documentElement.className || ''),
      bodyClass: (document.body ? document.body.className : ''),
      vars: vars
    };
  }

  // ══ THE HOST ENGINE ════════════════════════════════════════════════════

  var M = {
    on: false,
    session: null,
    surface: null,       // the surface the SERVER last authorized
    claimSurface: null,  // what we last CLAIMED, unfiltered
    root: null,
    obs: null,
    queue: [],
    timer: null,
    snapSeq: 0,
    pending: false,
    reason: null,        // the server's own refusal, verbatim
    degraded: false,
    cost: 0,
    costWindow: 0,
    frame: null,
    inflight: false
  };

  function origin() { try { return location.origin; } catch (e) { return ''; } }

  // The claim on EVERY flush. Reported as found; this function never filters
  // its own answer, for the reason js/live-rooms.js:864 gives: a client that
  // filtered its own route would be the authorization.
  function claim() {
    try {
      var r = window.p86Live && window.p86Live.route ? window.p86Live.route() : null;
      return r || null;
    } catch (e) { return null; }
  }

  function rootFor(surface) {
    var id = Object.prototype.hasOwnProperty.call(MIRROR_ROOTS, surface) ? MIRROR_ROOTS[surface] : null;
    if (!id) return null;
    var el = document.getElementById(id);
    if (!el || !el.isConnected) return null;
    // The root's own ancestry, re-verified. nodegraph/ui.js:3155 MOVES this
    // element into the Site Plan inspector, so it can travel into a denied
    // region with no mutation inside it at all.
    if (inDeniedRegion(el)) return null;
    return el;
  }

  function reset() {
    if (M.obs) { try { M.obs.disconnect(); } catch (e) {} }
    M.obs = null;
    M.queue.length = 0;
    ids = new WeakMap();
    byId = new Map();
    scrollSent = new Map();
    nextId = 1;
    M.root = null;
  }

  function observe(el) {
    M.obs = new MutationObserver(function (records) {
      // NEVER serialize in here. Queue and return: the host's paint must not
      // wait on us.
      for (var i = 0; i < records.length; i++) M.queue.push(records[i]);
      schedule();
    });
    M.obs.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    M.root = el;
  }

  function schedule() {
    if (M.timer) return;
    M.timer = setTimeout(function () { M.timer = null; flush(); }, M.degraded ? DEGRADE_FLUSH_MS : FLUSH_MS);
  }

  function snapshot(el) {
    var t0 = now();
    var budget = { n: 0 };
    reset();
    var doc = serializeShell(el, origin(), budget);
    observe(el);
    var w = 0, h = 0;
    try {
      var chain = shellChain(el);
      var outer = chain.length ? chain[0] : el;
      w = Math.round(outer.clientWidth || el.clientWidth || 0);
      h = Math.round(outer.clientHeight || el.clientHeight || 0);
    } catch (e) {}
    spend(now() - t0);
    return {
      root: doc,
      meta: {
        w: w, h: h, nodes: budget.n,
        css: collectCss(),
        root_state: rootState(),
        at: new Date().toISOString()
      }
    };
  }

  function now() { try { return performance.now(); } catch (e) { return Date.now(); } }

  // Self-degrade rather than jank the presenter. If serialization is eating
  // more than DEGRADE_MS_PER_S of every second, drop to snapshot-only at a much
  // slower cadence and SAY SO on both surfaces. A named low-fidelity state beats
  // silently slowing down the app the host is presenting from.
  function spend(ms) {
    var t = Date.now();
    if (t - M.costWindow > 1000) { M.costWindow = t; M.cost = 0; }
    M.cost += ms;
    var was = M.degraded;
    M.degraded = M.cost > DEGRADE_MS_PER_S;
    if (M.degraded !== was) paintFrame();
  }

  // ── Mutations → ops ────────────────────────────────────────────────────
  // Ordering discipline: adds are emitted with their reference sibling, removes
  // prune the map, and any record whose target has already left the map is
  // DROPPED rather than guessed at.
  function drain() {
    var ops = [];
    var replaced = 0;
    // The size to measure "wholesale" against is the size BEFORE this batch.
    // Reading it afterwards is self-defeating: an `innerHTML =` that replaces
    // every node also TRIPLES the map on the way through, so the fraction is
    // computed against a denominator the batch itself just inflated and the
    // app's dominant render pattern reads as a small delta.
    var sizeBefore = byId ? byId.size : 0;
    var records = M.queue.splice(0, M.queue.length);
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var target = rec.target;
      if (!target || idOf(target) == null) continue;
      if (inDeniedRegion(target)) continue;
      if (rec.type === 'characterData') {
        ops.push({ o: 't', i: idOf(target), x: String(target.data == null ? '' : target.data) });
      } else if (rec.type === 'attributes') {
        var name = String(rec.attributeName || '').toLowerCase();
        if (!isAllowedAttr(name)) continue;
        var raw = target.getAttribute(name);
        var val = raw == null ? null : (name === 'style'
          ? scrubIdValue(raw).replace(/url\(([^)]*)\)/gi, 'none')
          : scrubIdValue(raw));
        ops.push({ o: 's', i: idOf(target), k: name, v: val });
      } else if (rec.type === 'childList') {
        var removed = rec.removedNodes;
        for (var r = 0; r < removed.length; r++) {
          var rid = idOf(removed[r]);
          if (rid == null) continue;
          ops.push({ o: 'r', i: rid });
          replaced += 1;
          forgetSubtree(removed[r]);
        }
        var added = rec.addedNodes;
        for (var a = 0; a < added.length; a++) {
          var node = added[a];
          if (!node.parentNode || idOf(node.parentNode) == null) continue;
          var d = serialize(node, origin(), null);
          if (!d) continue;
          var before = node.nextSibling ? idOf(node.nextSibling) : null;
          ops.push({ o: 'a', p: idOf(node.parentNode), b: before == null ? null : before, n: d });
          replaced += 1;
        }
      }
    }
    // Scroll offsets are their own event source — scrollTop is not an attribute
    // and fires no MutationRecord. The last-sent value is cached BY NODE ID, on
    // this side; nothing is written to the host node, not even a property.
    if (M.root) {
      var scrollers = [M.root].concat(shellChain(M.root));
      for (var s = 0; s < scrollers.length; s++) {
        var el = scrollers[s];
        var sid = idOf(el);
        if (sid == null) continue;
        var top = Math.round(el.scrollTop), left = Math.round(el.scrollLeft);
        var key = top + ',' + left;
        if (scrollSent.get(sid) === key) continue;
        scrollSent.set(sid, key);
        ops.push({ o: 'p', i: sid, y: top, x: left });
      }
    }
    return { ops: ops, replaced: replaced, sizeBefore: sizeBefore };
  }

  // ── The flush ──────────────────────────────────────────────────────────
  function flush() {
    if (!M.on || M.inflight) return;
    var s = M.session;
    if (!s || s.terminal || !s.roomId || !s.streamKey) return;

    var c = claim();
    var wanted = c && c.surface ? c.surface : null;
    var el = wanted ? rootFor(wanted) : null;

    // The claim rides EVERY flush and the server re-decides every time. Nothing
    // here filters — if the surface is not mirrorable the server says so and
    // discards, and the reason it returns is what both surfaces display.
    if (!el) {
      // Nothing to send. THE OBSERVER STOPS TOO — leaving it attached to a pane
      // we are no longer allowed to send would queue records forever (a leak
      // whose only collector is the end of the session) and would let the next
      // authorized flush ship a delta cut against a base the server has already
      // discarded. reset() drops the observer, both maps and the node ids, so
      // coming back is a fresh snapshot rather than a patch onto nothing.
      if (M.root || M.snapSeq) { reset(); M.snapSeq = 0; }
      // Tell the server we are off, once, so guests are moved off a frame that
      // is no longer current rather than left staring at it presented as live.
      if (M.surface !== null || M.claimSurface !== wanted) {
        M.claimSurface = wanted;
        post({ claim: c, kind: 'off' });
      }
      return;
    }
    M.claimSurface = wanted;

    var t0 = now();
    var body;
    if (M.root !== el || !M.snapSeq) {
      var snap = snapshot(el);
      M.snapSeq += 1;
      body = { claim: c, kind: 'snap', snapSeq: M.snapSeq, root: snap.root, meta: snap.meta };
    } else {
      var d = drain();
      if (!d.ops.length) { spend(now() - t0); return; }
      var bytes = 0;
      try { bytes = JSON.stringify(d.ops).length; } catch (e) { bytes = RESNAP_BYTES + 1; }
      var wholesale = d.replaced > Math.max(20, d.sizeBefore * RESNAP_FRACTION);
      if (bytes > RESNAP_BYTES || wholesale || M.degraded) {
        // THE BIG-BATCH RULE. This app renders by string-building — 1,346
        // `innerHTML =` sites — and to any MutationObserver that is remove-all
        // plus insert-all, with the whole added subtree needing re-serialization.
        // Under this rule the app's DOMINANT render pattern costs a 60-byte
        // pointer on the wire and one compressed pull per guest, instead of a
        // 34 KB burst fanned out to twenty-five of them.
        var re = snapshot(el);
        M.snapSeq += 1;
        body = { claim: c, kind: 'snap', snapSeq: M.snapSeq, root: re.root, meta: re.meta };
      } else {
        body = { claim: c, kind: 'ops', snapSeq: M.snapSeq, ops: d.ops };
      }
    }
    spend(now() - t0);
    post(body);
  }

  function post(body) {
    var s = M.session;
    if (!s || !s.roomId || !s.streamKey) return;
    M.inflight = true;
    fetch('/api/live/' + encodeURIComponent(s.roomId) + '/mirror/' + encodeURIComponent(s.streamKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(body)
    }).then(function (r) {
      M.inflight = false;
      if (r.status === 404 || r.status === 410) { M.surface = null; return null; }
      if (!r.ok) return null;
      return r.json();
    }).then(function (j) {
      if (!j) return;
      // The SERVER's verdict, applied to our own state. Not our guess: the
      // surface we are allowed to be mirroring is the one it names.
      M.surface = j.surface || null;
      M.reason = j.reason || null;
      // A takeover moved the room to a process with no snapshot. Rebuild.
      if (j.resnapshot) { M.snapSeq = 0; M.root = null; }
      paintFrame();
    }).catch(function () { M.inflight = false; });
  }

  // ── What the HOST sees ─────────────────────────────────────────────────
  // Drawn INSIDE the cursor layer live-rooms.js already owns: body-mounted,
  // already pointer-events:none, already covered by the two-mounts assertion in
  // test/live-host-guest-bleed.test.js. This file mounts nothing of its own.
  function paintFrame() {
    var layer = null;
    try { layer = document.querySelector('.p86-live-cursors'); } catch (e) {}
    if (!layer) return;
    var box = M.frame;
    if (box && !box.isConnected) box = M.frame = null;
    if (!M.on || !M.surface) {
      if (box) { try { box.remove(); } catch (e) {} M.frame = null; }
      return;
    }
    var el = rootFor(M.surface);
    if (!el) {
      if (box) { try { box.remove(); } catch (e) {} M.frame = null; }
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.className = 'p86-mirror-frame';
      layer.appendChild(box);
      M.frame = box;
    }
    try {
      var chain = shellChain(el);
      var outer = chain.length ? chain[0] : el;
      var r = outer.getBoundingClientRect();
      box.style.cssText = 'position:fixed;left:' + Math.round(r.left) + 'px;top:' + Math.round(r.top) +
        'px;width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) + 'px;';
      box.setAttribute('data-lm-degraded', M.degraded ? '1' : '');
    } catch (e) {}
  }

  // ══ PUBLIC SURFACE ═════════════════════════════════════════════════════
  window.p86LiveMirror = {
    core: Core,

    start: function (session) {
      if (M.on) this.stop();
      M.on = true;
      M.session = session;
      M.snapSeq = 0;
      M.surface = null;
      M.claimSurface = null;
      M.reason = null;
      M.degraded = false;
      reset();
      schedule();
    },

    stop: function () {
      M.on = false;
      M.session = null;
      M.surface = null;
      M.reason = null;
      if (M.timer) { clearTimeout(M.timer); M.timer = null; }
      reset();
      ids = null; byId = null; scrollSent = new Map();
      if (M.frame) { try { M.frame.remove(); } catch (e) {} M.frame = null; }
    },

    // Called from the 1 Hz tick live-rooms.js already runs. No new timer, no
    // scroll listener, no rAF loop: the frame is repainted on the clock the
    // strip is already repainted on.
    tick: function () {
      if (!M.on) return;
      paintFrame();
      schedule();
    },

    status: function () {
      return {
        on: M.on,
        surface: M.surface,
        reason: M.reason,
        degraded: M.degraded,
        snapSeq: M.snapSeq
      };
    }
  };
})();
