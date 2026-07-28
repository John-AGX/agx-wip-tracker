// Email Hub — the in-app mail client for the Email Dropbox.
//
// E2 (docs/email-hub-premium.md §2) turned the old two-column list into a
// real three-pane client:  [ folder rail | message list | reading pane ].
// Renders into the #email-hub tab-content pane (registered in app.js's
// switchTab dispatch as renderEmailHubTab).
//
//   RAIL   nested folder tree off /api/email-folders (E1's spine), unread
//          badges, right-click menu (new subfolder / rename / color /
//          mark all read / delete), drop a conversation on a folder to
//          file it, drag a folder to reorder.
//   LIST   conversations grouped by thread_id server-side, sender avatar,
//          preview, star, priority stripe, attachment clip, multi-select
//          with a bulk bar, comfortable/compact density.
//   PANE   the real message — HTML body rendered in a SANDBOXED iframe
//          with remote images blocked by default, quoted-text collapse,
//          entity chip, and the H5 assistant draft box (P86 still never
//          sends; John copies the draft into his own mail client).
//
// Pane widths, density and the rail's expanded folders persist in
// localStorage. Under 900px the rail becomes a drawer and the list/pane
// swap like the app's other PWA surfaces.
//
// SECURITY — email bodies are the most hostile input this app renders:
//   * body_html is third-party HTML. sanitizeEmailHtml() strips script /
//     iframe / object / embed / form / on* handlers / javascript: URLs
//     before it is ever put in the DOM.
//   * It is then rendered in an iframe with sandbox="allow-same-origin
//     allow-popups" and NO allow-scripts, plus a CSP meta that permits
//     only inline styles and data: images. Two independent layers.
//   * Remote images are blocked until the user asks for them (tracking
//     pixels — spec constraint). "Show images" widens the CSP for that
//     one message only.
//   * Triage/AI summaries are model paraphrase of untrusted mail and are
//     escaped like any other user text, never rendered as markup.
(function () {
  'use strict';

  // ── Small helpers ─────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtAgo(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function ico(name, fallback) {
    return (window.p86Icon && window.p86Icon(name, { class: 'ehub-ico' })) || (fallback || '');
  }
  function api(path, opts) {
    var o = opts || {};
    o.credentials = 'include';
    if (o.body && !o.headers) o.headers = { 'Content-Type': 'application/json' };
    // Ride the app's auth header when api.js is present (Bearer JWT).
    if (window.p86Auth && window.p86Auth.getToken) {
      o.headers = o.headers || {};
      o.headers['Authorization'] = 'Bearer ' + window.p86Auth.getToken();
    }
    return fetch(path, o).then(function (r) {
      return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status)); return b; });
    });
  }
  function post(path, body) { return api(path, { method: 'POST', body: JSON.stringify(body || {}) }); }

  function lsGet(k, dflt) { try { var v = localStorage.getItem('p86-ehub-' + k); return v == null ? dflt : v; } catch (e) { return dflt; } }
  function lsSet(k, v) { try { localStorage.setItem('p86-ehub-' + k, v); } catch (e) { /* private mode */ } }

  // Deterministic avatar hue from an address, so the same sender is always
  // the same color.
  function hueFor(s) {
    var str = String(s || '?'), h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }
  function initialsFor(name, email) {
    var src = String(name || '').trim() || String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
    var parts = src.split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  var _state = {
    folders: [], counts: {}, folderId: null,
    threads: [], activeThreadId: null, q: '',
    selected: {},              // thread_id -> true
    expanded: {},              // folder_id -> true
    imagesOk: {},              // message_id -> true (user asked for images)
    quotesOpen: {},            // message_id -> true
    density: lsGet('density', 'comfortable'),
    railW: parseInt(lsGet('railW', '216'), 10) || 216,
    listW: parseInt(lsGet('listW', '380'), 10) || 380,
    railHidden: lsGet('railHidden', '0') === '1',
    loading: false,
    sweptOnce: false
  };
  try { _state.expanded = JSON.parse(lsGet('expanded', '{}')) || {}; } catch (e) { _state.expanded = {}; }

  function selectedIds() { return Object.keys(_state.selected).filter(function (k) { return _state.selected[k]; }); }
  function folderById(id) {
    for (var i = 0; i < _state.folders.length; i++) if (_state.folders[i].id === id) return _state.folders[i];
    return null;
  }
  function folderBySlug(slug) {
    for (var i = 0; i < _state.folders.length; i++) {
      if (_state.folders[i].system && _state.folders[i].slug === slug) return _state.folders[i];
    }
    return null;
  }

  // ── Email HTML sanitizer ──────────────────────────────────────────
  // Returns { html, blockedImages } — `html` is safe to place in an
  // iframe srcdoc. This runs BEFORE the sandbox/CSP, not instead of it.
  var KILL_TAGS = ['script', 'iframe', 'object', 'embed', 'link', 'base', 'meta', 'form', 'input', 'button', 'textarea', 'select', 'applet', 'frame', 'frameset', 'noscript'];
  // The URL scheme, reduced to the characters a scheme may legally
  // contain (a-z 0-9 + - .) and lowercased. Everything else before the
  // first colon — whitespace, control bytes, and the U+FFFD the HTML
  // parser leaves behind when it eats a NUL — is DISCARDED, so every
  // smuggling variant of the same attack collapses to one string:
  //   "javascript:"      -> javascript
  //   "java(TAB)script:" -> javascript
  //   "java(NUL)script:" -> javascript   (parser turned NUL into U+FFFD)
  //   "  JaVaScRiPt:"    -> javascript
  // A prefix test on the raw value misses all but the first. Written as a
  // code-point scan so this source file carries no literal control bytes.
  // Returns '' when there is no scheme (relative URLs, anchors).
  function schemeOf(s) {
    var str = String(s || '');
    var colon = str.indexOf(':');
    if (colon < 0) return '';
    var out = '';
    for (var i = 0; i < colon; i++) {
      var ch = str.charAt(i), c = str.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
          ch === '+' || ch === '-' || ch === '.') {
        out += ch;
      }
    }
    return out.toLowerCase();
  }
  // Schemes that can execute or impersonate. data: is allowed ONLY for
  // images (checked at the img branch below); a data: document is a
  // same-origin HTML injection, so it never survives here.
  function isDangerousUrl(val) {
    var scheme = schemeOf(val);
    if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'livescript') return true;
    if (scheme === 'data') {
      // data:image/... is fine (it phones nobody); data:text/html is not.
      return !/^[^:]*:\s*image\//i.test(String(val || ''));
    }
    return false;
  }

  function sanitizeEmailHtml(raw, opts) {
    opts = opts || {};
    var out = { html: '', blockedImages: 0, hasQuotes: false };
    var doc;
    try {
      doc = new DOMParser().parseFromString(String(raw || ''), 'text/html');
    } catch (e) { return out; }
    if (!doc || !doc.body) return out;

    KILL_TAGS.forEach(function (tag) {
      var nodes = doc.body.querySelectorAll(tag);
      for (var i = nodes.length - 1; i >= 0; i--) nodes[i].parentNode.removeChild(nodes[i]);
    });

    // Quoted-reply blocks: the tail of a conversation every mail client
    // hides. Collapsing happens by REMOVING them here and re-rendering
    // when the user asks — the iframe has no scripts to toggle with.
    var quoteSel = 'blockquote, .gmail_quote, .moz-cite-prefix, #divRplyFwdMsg, .OutlookMessageHeader';
    var quotes = doc.body.querySelectorAll(quoteSel);
    out.hasQuotes = quotes.length > 0;
    if (quotes.length && !opts.showQuotes) {
      for (var qi = quotes.length - 1; qi >= 0; qi--) quotes[qi].parentNode.removeChild(quotes[qi]);
    }

    var all = doc.body.querySelectorAll('*');
    for (var n = 0; n < all.length; n++) {
      var el = all[n];
      var attrs = Array.prototype.slice.call(el.attributes || []);
      for (var a = 0; a < attrs.length; a++) {
        var name = attrs[a].name.toLowerCase();
        var val = String(attrs[a].value || '');
        // Any event handler, in any casing.
        if (name.indexOf('on') === 0) { el.removeAttribute(attrs[a].name); continue; }
        // Executable / impersonating schemes in any URL-bearing attribute.
        if (name === 'href' || name === 'src' || name === 'action' || name === 'formaction' || name === 'xlink:href') {
          if (isDangerousUrl(val)) el.removeAttribute(attrs[a].name);
        }
        // srcset would smuggle a remote image past the src rewrite.
        if (name === 'srcset' || name === 'background' || name === 'lowsrc') el.removeAttribute(attrs[a].name);
      }
      var tag = el.tagName.toLowerCase();
      if (tag === 'a') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
      }
      if (tag === 'img' && !opts.showImages) {
        var src = String(el.getAttribute('src') || '');
        if (src && src.slice(0, 5).toLowerCase() !== 'data:') {
          out.blockedImages++;
          el.removeAttribute('src');
          el.setAttribute('alt', el.getAttribute('alt') || '');
          el.setAttribute('data-blocked', '1');
        }
      }
    }
    out.html = doc.body.innerHTML;
    return out;
  }

  // Build the srcdoc for a message body. The CSP is the hard gate: with
  // img-src data: only, a remote tracking pixel cannot load even if the
  // sanitizer missed one. "Show images" widens it to https: for this
  // message alone.
  function bodyDoc(innerHtml, showImages) {
    var csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:" +
              (showImages ? ' https:' : '') + "; font-src data:;";
    return '<!doctype html><html><head>' +
      '<meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' + esc(csp) + '">' +
      '<style>' +
        'html,body{margin:0;padding:0;background:transparent;}' +
        'body{font:13.5px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#dfe2ec;word-break:break-word;}' +
        'a{color:#6ea8ff;}' +
        'img{max-width:100%;height:auto;}' +
        'img[data-blocked]{min-width:18px;min-height:18px;background:rgba(255,255,255,.06);border:1px dashed rgba(255,255,255,.22);border-radius:3px;}' +
        'table{max-width:100%;}' +
        'blockquote{border-left:2px solid rgba(255,255,255,.2);margin:8px 0;padding-left:10px;color:#9aa2b6;}' +
        'pre{white-space:pre-wrap;word-break:break-word;}' +
      '</style></head><body>' + innerHtml + '</body></html>';
  }

  // Plain-text bodies: split off the quoted tail so a two-line reply
  // doesn't render as forty lines of history.
  var QUOTE_MARKERS = [
    /^\s*-{2,}\s*Original Message\s*-{2,}/im,
    /^\s*On .{5,80} wrote:\s*$/im,
    /^\s*_{10,}\s*$/m,
    /^\s*From:\s.+$/im
  ];
  function splitQuoted(text) {
    var t = String(text || '');
    var cut = -1;
    QUOTE_MARKERS.forEach(function (re) {
      var m = t.match(re);
      if (m && m.index != null && (cut === -1 || m.index < cut) && m.index > 40) cut = m.index;
    });
    // A run of '>' quoting also marks the tail.
    var gt = t.search(/^\s*>.*$/m);
    if (gt > 40 && (cut === -1 || gt < cut)) cut = gt;
    if (cut === -1) return { head: t, quoted: '' };
    return { head: t.slice(0, cut).replace(/\s+$/, ''), quoted: t.slice(cut) };
  }

  // ── Styles ────────────────────────────────────────────────────────
  function ensureStyles() {
    var existing = document.getElementById('p86-ehub-styles');
    if (existing) return;
    var st = document.createElement('style');
    st.id = 'p86-ehub-styles';
    st.textContent = [
      '.ehub{display:flex;flex-direction:column;height:100%;min-height:0;}',
      '.ehub-head{display:flex;align-items:center;gap:10px;padding:12px 16px 10px;flex-wrap:wrap;}',
      '.ehub-head h2{margin:0;font-size:19px;font-weight:700;}',
      '.ehub-sub{font-size:12px;color:var(--text-dim,#8b90a5);}',
      '.ehub-search{flex:1;min-width:170px;max-width:340px;margin-left:auto;position:relative;}',
      '.ehub-search input{width:100%;box-sizing:border-box;padding:7px 11px;border-radius:8px;border:1px solid var(--border,#2a2a32);background:var(--input-bg,#101014);color:var(--text,#e4e6f0);font-size:13px;}',
      // width:auto is NOT cosmetic — styles.css has a global
      // `input, select, textarea { width: 100% }`, so the <select>s that
      // wear .ehub-tool (the Move-to pickers) would otherwise stretch to
      // fill their bar. Same trap as .ehub-pick below.
      '.ehub-tool{background:none;border:1px solid var(--border,#2a2a32);border-radius:7px;color:var(--text-dim,#9aa0b4);cursor:pointer;padding:5px 9px;font-size:12px;display:inline-flex;align-items:center;gap:5px;width:auto;}',
      'select.ehub-tool{max-width:150px;}',
      '.ehub-tool:hover{color:var(--text,#e4e6f0);border-color:var(--accent,#107C41);}',
      '.ehub-tool.on{color:var(--accent,#5ddb7e);border-color:rgba(16,124,65,.5);}',

      '.ehub-body{display:flex;flex:1;min-height:0;border-top:1px solid var(--border,#2a2a32);position:relative;}',

      // ── rail
      '.ehub-rail{flex:0 0 auto;overflow-y:auto;overflow-x:hidden;border-right:1px solid var(--border,#2a2a32);padding:8px 6px 20px;background:var(--surface,#0e0e12);}',
      '.ehub-body.rail-off .ehub-rail{display:none;}',
      '.ehub-body.rail-off .ehub-split-rail{display:none;}',
      '.ehub-fold{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:7px;cursor:pointer;font-size:12.5px;color:var(--text,#d5d8e4);user-select:none;white-space:nowrap;}',
      '.ehub-fold:hover{background:var(--row-hover,#1c1c22);}',
      '.ehub-fold.active{background:rgba(16,124,65,.16);color:var(--text,#eef0f6);font-weight:600;}',
      '.ehub-fold.drop{outline:1.5px dashed var(--accent,#5ddb7e);outline-offset:-2px;background:rgba(16,124,65,.12);}',
      '.ehub-fold-tw{width:13px;flex:0 0 13px;text-align:center;font-size:9px;color:var(--text-dim,#7b8195);}',
      '.ehub-fold-ic{width:15px;height:15px;flex:0 0 15px;opacity:.8;}',
      '.ehub-fold-nm{flex:1;overflow:hidden;text-overflow:ellipsis;}',
      '.ehub-fold-ct{font-size:10.5px;font-weight:700;color:var(--accent,#5ddb7e);}',
      '.ehub-fold-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;}',
      '.ehub-rail-hd{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--text-dim,#6f748a);padding:10px 9px 4px;display:flex;align-items:center;gap:6px;}',
      '.ehub-rail-hd button{margin-left:auto;background:none;border:none;color:var(--text-dim,#6f748a);cursor:pointer;font-size:14px;line-height:1;padding:0 2px;}',
      '.ehub-rail-hd button:hover{color:var(--accent,#5ddb7e);}',

      // ── split handles
      '.ehub-split{flex:0 0 5px;cursor:col-resize;background:transparent;position:relative;}',
      '.ehub-split:hover,.ehub-split.dragging{background:rgba(16,124,65,.35);}',

      // ── list
      '.ehub-list{flex:0 0 auto;display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--border,#2a2a32);}',
      '.ehub-rows{flex:1;overflow-y:auto;min-height:0;}',
      '.ehub-bulk{display:none;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--border,#2a2a32);background:rgba(16,124,65,.09);flex-wrap:wrap;}',
      '.ehub-bulk.on{display:flex;}',
      '.ehub-bulk-n{font-size:11.5px;font-weight:700;color:var(--accent,#5ddb7e);margin-right:2px;}',
      '.ehub-row{padding:9px 11px 9px 9px;border-bottom:1px solid var(--border,#1e1e26);cursor:pointer;display:flex;gap:9px;align-items:flex-start;position:relative;}',
      '.ehub-row:hover{background:var(--row-hover,#1a1a20);}',
      '.ehub-row.active{background:var(--row-hover,#212129);}',
      '.ehub-row.picked{background:rgba(16,124,65,.12);}',
      '.ehub-row.unread .ehub-row-from,.ehub-row.unread .ehub-row-subj{font-weight:700;color:var(--text,#f0f2f8);}',
      '.ehub-row.dragging{opacity:.45;}',
      // AI-priority stripe down the left edge.
      '.ehub-row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:transparent;}',
      '.ehub-row.pri-high::before{background:#f87171;}',
      '.ehub-row.pri-reply::before{background:var(--accent,#107C41);}',
      '.ehub-row.pri-money::before{background:#f0b429;}',
      '.ehub-av{width:30px;height:30px;flex:0 0 30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#0c0c10;margin-top:1px;}',
      '.ehub-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.ehub-row-top{display:flex;align-items:baseline;gap:7px;}',
      '.ehub-row-from{font-size:12.5px;color:var(--text,#ccd0dd);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ehub-row-when{font-size:10.5px;color:var(--text-dim,#7f8498);white-space:nowrap;}',
      '.ehub-row-subj{font-size:12.5px;color:var(--text,#c6cad8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ehub-row-prev{font-size:11.5px;color:var(--text-dim,#7f8498);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ehub-row-triage{font-style:italic;color:var(--text-dim,#8f95a8);}',
      '.ehub-row-chips{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:1px;}',
      '.ehub-star{background:none;border:none;cursor:pointer;font-size:14px;line-height:1;color:#4a4f60;padding:0 1px;flex:0 0 auto;}',
      '.ehub-star.on{color:#f0b429;}',
      '.ehub-star:hover{color:#f0b429;}',
      // The explicit width/height matters: styles.css:2221 has a global
      // `input, select, textarea { width: 100% }`, and a bare class with no
      // width loses to it — the row checkbox stretched to the full column,
      // squeezing .ehub-row-main to 0px so every sender/subject/preview
      // (all overflow:hidden) clipped to nothing. Same fix the codebase
      // already uses at .ci-td-check input.
      '.ehub-pick{flex:0 0 14px;width:14px;height:14px;margin-top:8px;accent-color:var(--accent,#107C41);cursor:pointer;}',
      '.ehub-clip{font-size:11px;color:var(--text-dim,#7f8498);}',
      // compact density
      '.ehub-list.compact .ehub-row{padding:5px 10px 5px 9px;align-items:center;}',
      '.ehub-list.compact .ehub-av{width:20px;height:20px;flex-basis:20px;font-size:9px;margin-top:0;}',
      '.ehub-list.compact .ehub-row-prev{display:none;}',
      '.ehub-list.compact .ehub-row-main{flex-direction:row;align-items:baseline;gap:8px;}',
      '.ehub-list.compact .ehub-row-top{flex:0 0 40%;min-width:0;}',
      '.ehub-list.compact .ehub-row-subj{flex:1;}',
      '.ehub-list.compact .ehub-row-chips{margin-top:0;}',

      // ── reading pane
      '.ehub-pane{flex:1;min-width:0;overflow-y:auto;}',
      '.ehub-thead{position:sticky;top:0;background:var(--bg,#101014);padding:14px 20px 11px;border-bottom:1px solid var(--border,#2a2a32);z-index:2;}',
      '.ehub-thead h3{margin:0 0 7px;font-size:16.5px;font-weight:700;line-height:1.35;}',
      '.ehub-thead-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}',
      '.ehub-msg{padding:14px 20px;border-bottom:1px solid var(--border,#1e1e26);}',
      '.ehub-msg-hd{display:flex;align-items:center;gap:8px;margin-bottom:9px;flex-wrap:wrap;}',
      '.ehub-msg-from{font-weight:600;font-size:13px;}',
      '.ehub-msg-when{font-size:11px;color:var(--text-dim,#7f8498);margin-left:auto;}',
      '.ehub-msg-fwd{font-size:10.5px;color:var(--text-dim,#8b90a5);background:var(--surface2,#202027);border-radius:8px;padding:1px 7px;}',
      '.ehub-msg-body{font-size:13.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text,#dfe2ec);}',
      '.ehub-frame{width:100%;border:0;display:block;background:transparent;min-height:40px;}',
      '.ehub-imgbar{display:flex;align-items:center;gap:8px;font-size:11.5px;color:#e0b768;background:rgba(240,180,41,.09);border:1px solid rgba(240,180,41,.3);border-radius:7px;padding:5px 9px;margin-bottom:9px;}',
      '.ehub-imgbar button{background:none;border:1px solid rgba(240,180,41,.5);color:#f0b429;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;}',
      '.ehub-quote-btn{background:none;border:1px dashed var(--border,#33333d);color:var(--text-dim,#7f8498);border-radius:6px;padding:2px 9px;font-size:11px;cursor:pointer;margin-top:8px;}',
      '.ehub-quote-btn:hover{color:var(--text,#e4e6f0);}',
      '.ehub-quoted{margin-top:8px;padding-left:10px;border-left:2px solid var(--border,#33333d);color:var(--text-dim,#8b90a5);font-size:12.5px;white-space:pre-wrap;}',
      '.ehub-msg-mine{background:rgba(16,124,65,0.06);border-left:2px solid var(--accent,#107C41);}',
      '.ehub-msg-mine .ehub-msg-from{color:var(--accent,#5ddb7e);}',

      // ── shared bits
      '.ehub-chip{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:10px;background:var(--surface2,#202027);border:1px solid var(--border,#2a2a32);color:var(--text-dim,#b4b4bf);cursor:pointer;}',
      '.ehub-chip:not(.ehub-chip-static):hover{color:var(--text,#e4e6f0);border-color:var(--accent,#107C41);}',
      '.ehub-chip-static{cursor:default;}',
      '.ehub-count{font-size:10px;font-weight:700;background:var(--surface2,#202027);border-radius:9px;padding:0 6px;color:var(--text-dim,#b4b4bf);}',
      '.ehub-badge{font-size:10px;font-weight:700;padding:1px 7px;border-radius:9px;letter-spacing:.2px;}',
      '.ehub-badge-reply{background:rgba(16,124,65,.16);color:var(--accent,#5ddb7e);border:1px solid rgba(16,124,65,.4);}',
      '.ehub-badge-high{background:rgba(248,113,113,.14);color:#f87171;border:1px solid rgba(248,113,113,.4);}',
      '.ehub-badge-done{background:rgba(120,130,150,.14);color:#9aa4b8;border:1px solid rgba(120,130,150,.34);}',
      '.ehub-badge-draft{background:rgba(127,119,221,.16);color:#a89ee6;border:1px solid rgba(127,119,221,.4);}',
      '.ehub-empty{padding:40px 24px;text-align:center;color:var(--text-dim,#8b90a5);font-size:13px;line-height:1.6;}',
      '.ehub-ico{width:15px;height:15px;vertical-align:-2px;}',
      '.ehub-ask{padding:6px 12px;font-size:12px;font-weight:600;border-radius:8px;border:1px solid var(--accent,#107C41);background:rgba(16,124,65,0.14);color:var(--accent,#5ddb7e);cursor:pointer;display:inline-flex;align-items:center;gap:6px;}',
      '.ehub-ask:hover{background:rgba(16,124,65,0.24);}',

      // ── context menu
      '.ehub-menu{position:fixed;z-index:9999;min-width:172px;background:var(--surface,#16161c);border:1px solid var(--border,#31313c);border-radius:9px;padding:5px;box-shadow:0 12px 34px rgba(0,0,0,.5);}',
      '.ehub-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:none;color:var(--text,#dfe2ec);font-size:12.5px;padding:7px 9px;border-radius:6px;cursor:pointer;}',
      '.ehub-menu button:hover{background:var(--row-hover,#232329);}',
      '.ehub-menu button.danger{color:#f87171;}',
      '.ehub-menu hr{border:none;border-top:1px solid var(--border,#2a2a32);margin:4px 2px;}',

      // ── draft box (H5)
      '.ehub-draft{margin:14px 20px;padding:12px 14px;border:1px solid rgba(127,119,221,.34);border-radius:10px;background:rgba(127,119,221,.06);}',
      '.ehub-draft.is-handled{border-color:rgba(120,130,150,.3);background:rgba(120,130,150,.06);}',
      '.ehub-draft-hd{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:8px;}',
      '.ehub-draft-ttl{font-size:12px;font-weight:700;letter-spacing:.02em;color:#a89ee6;display:flex;align-items:center;gap:5px;}',
      '.ehub-draft-when{font-size:10.5px;color:var(--text-dim,#8b93a5);}',
      '.ehub-draft-note{margin-left:auto;font-size:10.5px;color:var(--text-dim,#8b93a5);font-style:italic;}',
      '.ehub-draft-ta{width:100%;box-sizing:border-box;resize:vertical;min-height:100px;padding:10px 12px;font:13px/1.55 inherit;background:var(--surface,#131a27);border:1px solid rgba(255,255,255,.14);border-radius:8px;color:var(--text,#e4e6f0);white-space:pre-wrap;}',
      '.ehub-draft-ta:focus{outline:none;border-color:#7f77dd;}',
      '.ehub-draft-actions{display:flex;align-items:center;gap:8px;margin-top:9px;flex-wrap:wrap;}',
      '.ehub-dbtn{padding:6px 12px;font-size:12px;font-weight:600;border-radius:7px;cursor:pointer;background:var(--surface2,#1a2130);border:1px solid rgba(255,255,255,.16);color:var(--text,#e4e6f0);display:inline-flex;align-items:center;gap:5px;}',
      '.ehub-dbtn:hover{border-color:#7f77dd;}',
      '.ehub-dbtn-primary{margin-left:auto;background:#4f8cff;border-color:#4f8cff;color:#fff;}',
      '.ehub-dbtn-primary:hover{background:#3d7bef;border-color:#3d7bef;}',
      '.ehub-dbtn:disabled{opacity:.55;cursor:default;}',
      '.ehub-draft-saved{font-size:11px;color:var(--accent,#5ddb7e);}',
      '.ehub-back{display:none;align-items:center;gap:5px;font-size:12px;color:var(--text-dim,#8b90a5);background:none;border:none;cursor:pointer;padding:0 0 8px;}',

      // ── mobile: rail becomes a drawer, list and pane swap
      '@media (max-width:900px){',
      '.ehub-split{display:none;}',
      '.ehub-rail{position:absolute;left:0;top:0;bottom:0;z-index:5;width:230px !important;flex-basis:230px !important;box-shadow:0 0 30px rgba(0,0,0,.55);}',
      '.ehub-body:not(.rail-open) .ehub-rail{display:none;}',
      '.ehub-body.rail-open .ehub-rail{display:block;}',
      '.ehub-list{flex:1 1 auto !important;width:auto !important;border-right:none;}',
      '.ehub-body.show-thread .ehub-list{display:none;}',
      '.ehub-body:not(.show-thread) .ehub-pane{display:none;}',
      '.ehub-back{display:inline-flex;}',
      '}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // Types the hub can actually navigate to (has a real opener). A chip
  // for anything else renders as a static context label.
  function isNavigable(kind) { return kind === 'client' || kind === 'lead'; }

  // ── Shell ─────────────────────────────────────────────────────────
  function renderEmailHubTab() {
    var pane = document.getElementById('email-hub');
    if (!pane) return;
    // Fresh view on every tab open (the DOM is rebuilt, so reset state
    // that would otherwise silently filter or highlight nothing).
    _state.q = '';
    _state.activeThreadId = null;
    _state.selected = {};
    ensureStyles();
    pane.innerHTML =
      '<div class="ehub">' +
        '<div class="ehub-head">' +
          '<button class="ehub-tool" data-rail-toggle title="Show / hide the folder rail">' + ico('align-left', '&#9776;') + '</button>' +
          '<h2>Email</h2>' +
          '<span class="ehub-sub" id="ehubSub"></span>' +
          '<div class="ehub-search"><input type="text" id="ehubSearch" placeholder="Search all folders…" spellcheck="false"></div>' +
          '<button class="ehub-tool' + (_state.density === 'compact' ? ' on' : '') + '" data-density title="Comfortable / compact">' +
            ico('collapse', '&#8801;') + '</button>' +
          '<button class="ehub-tool" data-refresh title="Refresh">' + ico('refresh', '&#8635;') + '</button>' +
        '</div>' +
        '<div class="ehub-body' + (_state.railHidden ? ' rail-off' : '') + '" id="ehubBody">' +
          '<div class="ehub-rail" id="ehubRail" style="flex-basis:' + _state.railW + 'px;width:' + _state.railW + 'px;"></div>' +
          '<div class="ehub-split ehub-split-rail" data-split="rail"></div>' +
          '<div class="ehub-list' + (_state.density === 'compact' ? ' compact' : '') + '" id="ehubList" style="flex-basis:' + _state.listW + 'px;width:' + _state.listW + 'px;">' +
            '<div class="ehub-bulk" id="ehubBulk"></div>' +
            '<div class="ehub-rows" id="ehubRows"><div class="ehub-empty">Loading…</div></div>' +
          '</div>' +
          '<div class="ehub-split" data-split="list"></div>' +
          '<div class="ehub-pane" id="ehubPane"><div class="ehub-empty">Pick a conversation to read it here.</div></div>' +
        '</div>' +
      '</div>';

    var searchEl = pane.querySelector('#ehubSearch');
    var tmr = null;
    if (searchEl) searchEl.addEventListener('input', function () {
      clearTimeout(tmr);
      tmr = setTimeout(function () { _state.q = searchEl.value.trim(); loadThreads(); }, 280);
    });
    pane.querySelector('[data-refresh]').addEventListener('click', function () { loadFolders().then(loadThreads); });
    pane.querySelector('[data-density]').addEventListener('click', function (e) {
      _state.density = _state.density === 'compact' ? 'comfortable' : 'compact';
      lsSet('density', _state.density);
      document.getElementById('ehubList').classList.toggle('compact', _state.density === 'compact');
      e.currentTarget.classList.toggle('on', _state.density === 'compact');
    });
    pane.querySelector('[data-rail-toggle]').addEventListener('click', function () {
      var body = document.getElementById('ehubBody');
      // Under 900px the rail is a drawer; above, it collapses in place.
      if (window.matchMedia('(max-width:900px)').matches) { body.classList.toggle('rail-open'); return; }
      _state.railHidden = !_state.railHidden;
      lsSet('railHidden', _state.railHidden ? '1' : '0');
      body.classList.toggle('rail-off', _state.railHidden);
    });
    wireSplitters();

    loadFolders().then(function () { return loadThreads(); });

    // Catch-up triage sweep (unchanged from H3): any emails whose
    // background triage was lost to a restart get processed now.
    if (!_state.sweptOnce) {
      _state.sweptOnce = true;
      post('/api/email-inbox/triage-pending', {})
        .then(function (res) { if (res && res.triaged > 0) loadThreads(); })
        .catch(function () {});
    }
  }

  // Drag-to-resize the two splitters; widths persist per user.
  function wireSplitters() {
    var body = document.getElementById('ehubBody');
    if (!body) return;
    body.querySelectorAll('.ehub-split').forEach(function (h) {
      h.addEventListener('mousedown', function (down) {
        down.preventDefault();
        var which = h.getAttribute('data-split');
        var el = document.getElementById(which === 'rail' ? 'ehubRail' : 'ehubList');
        var startX = down.clientX;
        var startW = el.getBoundingClientRect().width;
        var min = which === 'rail' ? 150 : 260;
        var max = which === 'rail' ? 400 : 620;
        h.classList.add('dragging');
        function move(m) {
          var w = Math.max(min, Math.min(max, startW + (m.clientX - startX)));
          el.style.flexBasis = w + 'px';
          el.style.width = w + 'px';
          if (which === 'rail') _state.railW = w; else _state.listW = w;
        }
        function up() {
          h.classList.remove('dragging');
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          lsSet(which === 'rail' ? 'railW' : 'listW', String(which === 'rail' ? _state.railW : _state.listW));
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
  }

  // ── Folder rail ───────────────────────────────────────────────────
  function loadFolders() {
    return api('/api/email-folders').then(function (res) {
      _state.folders = (res && res.folders) || [];
      _state.counts = (res && res.counts) || {};
      if (!_state.folderId) {
        var inbox = folderBySlug('inbox');
        _state.folderId = inbox ? inbox.id : (_state.folders[0] ? _state.folders[0].id : null);
      }
      paintRail();
    }).catch(function (e) {
      var rail = document.getElementById('ehubRail');
      if (rail) rail.innerHTML = '<div class="ehub-empty" style="padding:20px 10px;font-size:12px;">Folders unavailable.<br>' + esc(e.message || '') + '</div>';
    });
  }

  // Sum a folder's unread with its whole subtree, so a collapsed
  // "Triaged" still shows that something below it needs attention.
  function subtreeUnread(id) {
    var own = (_state.counts[id] && _state.counts[id].unread) || 0;
    _state.folders.forEach(function (f) { if (f.parent_id === id) own += subtreeUnread(f.id); });
    return own;
  }

  function paintRail() {
    var rail = document.getElementById('ehubRail');
    if (!rail) return;
    var mine = _state.folders.filter(function (f) { return f.user_id !== null; });
    var shared = _state.folders.filter(function (f) { return f.user_id === null; });

    function branch(list, parentId, depth) {
      return list.filter(function (f) { return (f.parent_id || null) === parentId; })
        .sort(function (a, b) { return (a.sort - b.sort) || a.name.localeCompare(b.name); })
        .map(function (f) {
          var kids = list.filter(function (k) { return k.parent_id === f.id; });
          var open = !!_state.expanded[f.id];
          var unread = open ? ((_state.counts[f.id] && _state.counts[f.id].unread) || 0) : subtreeUnread(f.id);
          var row =
            '<div class="ehub-fold' + (f.id === _state.folderId ? ' active' : '') + '"' +
              ' data-folder="' + esc(f.id) + '"' + (f.system ? ' data-system="1"' : '') +
              ' draggable="true" style="padding-left:' + (8 + depth * 13) + 'px;">' +
              '<span class="ehub-fold-tw" data-tw="' + esc(f.id) + '">' + (kids.length ? (open ? '&#9662;' : '&#9656;') : '') + '</span>' +
              (f.color
                ? '<span class="ehub-fold-dot" style="background:' + esc(f.color) + '"></span>'
                : '<span class="ehub-fold-ic">' + ico(f.icon || 'folder', '') + '</span>') +
              '<span class="ehub-fold-nm">' + esc(f.name) + '</span>' +
              (unread ? '<span class="ehub-fold-ct">' + unread + '</span>' : '') +
            '</div>';
          return row + (open && kids.length ? branch(list, f.id, depth + 1) : '');
        }).join('');
    }

    rail.innerHTML =
      branch(mine, null, 0) +
      '<div class="ehub-rail-hd">Folders<button data-new-root title="New folder">+</button></div>' +
      (shared.length ? '<div class="ehub-rail-hd">Shared</div>' + branch(shared, null, 0) : '');

    rail.querySelectorAll('.ehub-fold').forEach(function (el) {
      var fid = el.getAttribute('data-folder');
      el.addEventListener('click', function (e) {
        if (e.target.closest('[data-tw]') && e.target.textContent.trim()) {
          _state.expanded[fid] = !_state.expanded[fid];
          lsSet('expanded', JSON.stringify(_state.expanded));
          paintRail();
          return;
        }
        _state.folderId = fid;
        _state.selected = {};
        // Auto-expand so children are reachable after clicking a parent.
        if (_state.folders.some(function (f) { return f.parent_id === fid; })) _state.expanded[fid] = true;
        paintRail();
        loadThreads();
        var body = document.getElementById('ehubBody');
        if (body) body.classList.remove('rail-open');
      });
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); folderMenu(e, fid); });

      // Drop a conversation onto a folder to file it, or a folder onto a
      // folder to re-nest it. preventDefault on dragover is what MAKES a
      // drop legal — without it for the 'folder' kind, the folder-drop
      // handler below could never fire at all.
      el.addEventListener('dragover', function (e) {
        if (_dragKind !== 'threads' && _dragKind !== 'folder') return;
        if (_dragKind === 'folder' && _dragFolderId === fid) return;   // no self-drop
        e.preventDefault(); el.classList.add('drop');
      });
      el.addEventListener('dragleave', function () { el.classList.remove('drop'); });
      el.addEventListener('drop', function (e) {
        el.classList.remove('drop');
        if (_dragKind === 'threads' && _dragThreads.length) {
          e.preventDefault();
          moveThreads(_dragThreads.slice(), fid);
        } else if (_dragKind === 'folder' && _dragFolderId && _dragFolderId !== fid) {
          e.preventDefault();
          reorderOrNest(_dragFolderId, fid);
        }
      });
      // Drag a folder to reorder / re-nest it.
      el.addEventListener('dragstart', function (e) {
        _dragKind = 'folder'; _dragFolderId = fid;
        try { e.dataTransfer.setData('text/plain', fid); } catch (err) {}
      });
      el.addEventListener('dragend', function () { _dragKind = null; _dragFolderId = null; });
    });
    var newRoot = rail.querySelector('[data-new-root]');
    if (newRoot) newRoot.addEventListener('click', function (e) { e.stopPropagation(); createFolder(null); });
  }

  var _dragKind = null, _dragThreads = [], _dragFolderId = null;

  // Dropping folder A on folder B nests A under B. Holding Shift instead
  // reorders A to sit where B is among its siblings.
  function reorderOrNest(dragId, targetId) {
    var drag = folderById(dragId), target = folderById(targetId);
    if (!drag || !target || drag.system) {
      if (drag && drag.system) toast('System folders cannot be moved.');
      return;
    }
    api('/api/email-folders/' + encodeURIComponent(dragId), {
      method: 'PATCH', body: JSON.stringify({ parent_id: targetId })
    }).then(function () { return loadFolders(); })
      .catch(function (e) { toast(e.message || 'Could not move that folder.'); });
  }

  // ── Folder context menu ───────────────────────────────────────────
  function closeMenu() {
    var m = document.querySelector('.ehub-menu');
    if (m) m.parentNode.removeChild(m);
  }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

  function folderMenu(evt, folderId) {
    closeMenu();
    var f = folderById(folderId);
    if (!f) return;
    var m = document.createElement('div');
    m.className = 'ehub-menu';
    m.style.left = Math.min(evt.clientX, window.innerWidth - 190) + 'px';
    m.style.top = Math.min(evt.clientY, window.innerHeight - 240) + 'px';
    m.innerHTML =
      '<button data-act="new">' + ico('plus', '+') + ' New subfolder</button>' +
      '<button data-act="read">' + ico('check-circle', '') + ' Mark all read</button>' +
      '<button data-act="color">' + ico('swatch', '') + ' Color…</button>' +
      (f.system ? '' :
        '<hr><button data-act="rename">' + ico('edit', '') + ' Rename</button>' +
        '<button data-act="root">' + ico('folder', '') + ' Move to top level</button>' +
        '<button class="danger" data-act="delete">' + ico('delete', '') + ' Delete</button>');
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.stopPropagation();
      closeMenu();
      var act = btn.getAttribute('data-act');
      if (act === 'new') createFolder(folderId);
      else if (act === 'read') markFolderRead(folderId);
      else if (act === 'color') colorFolder(f);
      else if (act === 'rename') renameFolder(f);
      else if (act === 'root') {
        api('/api/email-folders/' + encodeURIComponent(f.id), { method: 'PATCH', body: JSON.stringify({ parent_id: null }) })
          .then(loadFolders).catch(function (er) { toast(er.message); });
      } else if (act === 'delete') deleteFolder(f);
    });
  }

  function createFolder(parentId) {
    var name = window.prompt(parentId ? 'New subfolder name' : 'New folder name', '');
    if (!name || !name.trim()) return;
    post('/api/email-folders', { name: name.trim(), parent_id: parentId || null })
      .then(function () { if (parentId) _state.expanded[parentId] = true; return loadFolders(); })
      .catch(function (e) { toast(e.message || 'Could not create that folder.'); });
  }
  function renameFolder(f) {
    var name = window.prompt('Rename folder', f.name);
    if (!name || !name.trim() || name === f.name) return;
    api('/api/email-folders/' + encodeURIComponent(f.id), { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) })
      .then(loadFolders).catch(function (e) { toast(e.message || 'Could not rename that folder.'); });
  }
  function colorFolder(f) {
    var c = window.prompt('Folder color as a hex value (e.g. #22d3ee). Leave blank to clear.', f.color || '');
    if (c === null) return;
    api('/api/email-folders/' + encodeURIComponent(f.id), { method: 'PATCH', body: JSON.stringify({ color: c.trim() || null }) })
      .then(loadFolders).catch(function (e) { toast(e.message); });
  }
  function deleteFolder(f) {
    if (!window.confirm('Delete "' + f.name + '"?\n\nSubfolders go with it. Any mail inside moves back to your Inbox — nothing is deleted.')) return;
    api('/api/email-folders/' + encodeURIComponent(f.id), { method: 'DELETE' })
      .then(function (r) {
        if (_state.folderId === f.id) { var ib = folderBySlug('inbox'); _state.folderId = ib ? ib.id : null; }
        if (r && r.refiled) toast(r.refiled + (r.refiled === 1 ? ' message moved' : ' messages moved') + ' back to Inbox.');
        return loadFolders().then(loadThreads);
      })
      .catch(function (e) { toast(e.message || 'Could not delete that folder.'); });
  }
  function markFolderRead(folderId) {
    post('/api/email-folders/' + encodeURIComponent(folderId) + '/mark-all-read', { read: true })
      .then(function () { return loadFolders().then(loadThreads); })
      .catch(function (e) { toast(e.message); });
  }

  function toast(msg) {
    if (!msg) return;
    if (window.p86Toast) { window.p86Toast(msg); return; }
    if (window.showToast) { window.showToast(msg); return; }
    var sub = document.getElementById('ehubSub');
    if (sub) { var old = sub.textContent; sub.textContent = msg; setTimeout(function () { sub.textContent = old; }, 2600); }
  }

  // ── Message list ──────────────────────────────────────────────────
  function loadThreads() {
    var rows = document.getElementById('ehubRows');
    if (!rows) return Promise.resolve();
    _state.loading = true;
    // A search spans ALL folders (that's what a mail search is for); an
    // empty box scopes to the selected folder.
    var url = '/api/email-inbox/threads?limit=100';
    if (_state.q) url += '&q=' + encodeURIComponent(_state.q);
    else if (_state.folderId) url += '&folder_id=' + encodeURIComponent(_state.folderId);
    return api(url).then(function (res) {
      _state.threads = (res && res.threads) || [];
      _state.loading = false;
      paintList();
    }).catch(function (e) {
      _state.loading = false;
      rows.innerHTML = '<div class="ehub-empty">Could not load email.<br><span style="font-size:11.5px;">' + esc(e.message || '') + '</span></div>';
    });
  }

  function priorityClass(th) {
    // E5 fills ai_priority; until then the H3 triage drives the stripe.
    var p = String(th.ai_priority || '').toLowerCase();
    if (p === 'money') return 'pri-money';
    if (p === 'high' || p === 'urgent') return 'pri-high';
    if (th.triage_urgency === 'high') return 'pri-high';
    if (th.needs_reply) return 'pri-reply';
    return '';
  }

  function paintList() {
    var rows = document.getElementById('ehubRows');
    var subEl = document.getElementById('ehubSub');
    if (!rows) return;
    var f = folderById(_state.folderId);
    if (subEl) {
      subEl.textContent = _state.q
        ? (_state.threads.length + ' result' + (_state.threads.length === 1 ? '' : 's') + ' across all folders')
        : ((f ? f.name : '') + (_state.threads.length ? ' · ' + _state.threads.length + (_state.threads.length === 1 ? ' conversation' : ' conversations') : ''));
    }
    paintBulk();

    if (!_state.threads.length) {
      rows.innerHTML = _state.q
        ? '<div class="ehub-empty">Nothing matches &ldquo;' + esc(_state.q) + '&rdquo;.</div>'
        : (f && f.slug === 'inbox'
            ? '<div class="ehub-empty">Your inbox is empty.<br><br>Set up forwarding from <strong>My Account &rarr; Email Dropbox</strong> — redirect a copy of your inbox to your private address and it lands here.</div>'
            : '<div class="ehub-empty">Nothing in ' + esc(f ? f.name : 'this folder') + '.</div>');
      return;
    }

    rows.innerHTML = _state.threads.map(function (th) {
      var handled = !!(th.replied_at && th.last_inbound_at &&
                       new Date(th.replied_at) >= new Date(th.last_inbound_at));
      var who = th.last_direction === 'outbound'
        ? ('You' + (th.entity_label ? ' &rarr; ' + esc(th.entity_label) : ''))
        : esc(th.last_from || 'unknown');
      var nav = th.entity_label && isNavigable(th.entity_type);
      var chips = '';
      if (th.entity_label) {
        chips += '<span class="ehub-chip' + (nav ? '' : ' ehub-chip-static') + '"' +
          (nav ? ' data-entity-type="' + esc(th.entity_type) + '" data-entity-id="' + esc(th.entity_id) + '"' : '') +
          '>' + ico('clients', '') + esc(th.entity_label) + '</span>';
      }
      if (th.needs_reply && !handled) chips += '<span class="ehub-badge ehub-badge-reply">needs reply</span>';
      if (handled) chips += '<span class="ehub-badge ehub-badge-done">replied</span>';
      else if (th.has_draft) chips += '<span class="ehub-badge ehub-badge-draft">draft ready</span>';
      if (th.triage_urgency === 'high' && !handled) chips += '<span class="ehub-badge ehub-badge-high">high</span>';

      var hue = hueFor(th.last_from || th.thread_id);
      return '<div class="ehub-row ' + priorityClass(th) +
          (th.unread_count > 0 ? ' unread' : '') +
          (th.thread_id === _state.activeThreadId ? ' active' : '') +
          (_state.selected[th.thread_id] ? ' picked' : '') + '"' +
          ' data-thread="' + esc(th.thread_id) + '" draggable="true">' +
        '<input type="checkbox" class="ehub-pick"' + (_state.selected[th.thread_id] ? ' checked' : '') + '>' +
        '<span class="ehub-av" style="background:hsl(' + hue + ',48%,62%)">' +
          esc(initialsFor(null, th.last_from)) + '</span>' +
        '<span class="ehub-row-main">' +
          '<span class="ehub-row-top">' +
            '<span class="ehub-row-from">' + who + '</span>' +
            (th.message_count > 1 ? '<span class="ehub-count">' + th.message_count + '</span>' : '') +
            (th.has_attachments ? '<span class="ehub-clip">' + ico('attachments', '&#128206;') + '</span>' : '') +
            '<span class="ehub-row-when">' + esc(fmtAgo(th.last_received_at)) + '</span>' +
          '</span>' +
          '<span class="ehub-row-subj">' + esc(th.subject || '(no subject)') + '</span>' +
          (th.triage_summary
            ? '<span class="ehub-row-prev ehub-row-triage">' + esc(th.triage_summary) + '</span>'
            : (th.preview ? '<span class="ehub-row-prev">' + esc(String(th.preview).replace(/\s+/g, ' ').trim()) + '</span>' : '')) +
          (chips ? '<span class="ehub-row-chips">' + chips + '</span>' : '') +
        '</span>' +
        '<button class="ehub-star' + (th.is_starred ? ' on' : '') + '" title="Star">' + (th.is_starred ? '&#9733;' : '&#9734;') + '</button>' +
      '</div>';
    }).join('');

    rows.querySelectorAll('.ehub-row').forEach(function (row) {
      var tid = row.getAttribute('data-thread');
      row.addEventListener('click', function (e) {
        if (e.target.closest('.ehub-pick')) return;                 // handled below
        if (e.target.closest('.ehub-star')) return;
        if (e.target.closest('.ehub-chip:not(.ehub-chip-static)')) return;
        openThread(tid);
      });
      row.querySelector('.ehub-pick').addEventListener('change', function (e) {
        e.stopPropagation();
        _state.selected[tid] = e.target.checked;
        row.classList.toggle('picked', e.target.checked);
        paintBulk();
      });
      row.querySelector('.ehub-star').addEventListener('click', function (e) {
        e.stopPropagation();
        var th = _state.threads.filter(function (x) { return x.thread_id === tid; })[0];
        if (!th) return;
        var next = !th.is_starred;
        th.is_starred = next;
        e.currentTarget.classList.toggle('on', next);
        e.currentTarget.innerHTML = next ? '&#9733;' : '&#9734;';
        post('/api/email-inbox/messages/state', { thread_ids: [tid], is_starred: next })
          .catch(function () { th.is_starred = !next; paintList(); });
      });
      // Drag a conversation onto a folder in the rail to file it.
      row.addEventListener('dragstart', function (e) {
        _dragKind = 'threads';
        // Dragging an unselected row drags just that row; dragging a
        // selected one drags the whole selection.
        _dragThreads = _state.selected[tid] ? selectedIds() : [tid];
        row.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', _dragThreads.join(',')); } catch (err) {}
      });
      row.addEventListener('dragend', function () {
        row.classList.remove('dragging');
        _dragKind = null; _dragThreads = [];
      });
    });
    rows.querySelectorAll('.ehub-chip:not(.ehub-chip-static)').forEach(function (chip) {
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        openEntity(chip.getAttribute('data-entity-type'), chip.getAttribute('data-entity-id'));
      });
    });
  }

  // ── Bulk bar ──────────────────────────────────────────────────────
  function paintBulk() {
    var bar = document.getElementById('ehubBulk');
    if (!bar) return;
    var ids = selectedIds();
    bar.classList.toggle('on', ids.length > 0);
    if (!ids.length) { bar.innerHTML = ''; return; }
    var archive = folderBySlug('archive'), trash = folderBySlug('trash');
    bar.innerHTML =
      '<span class="ehub-bulk-n">' + ids.length + ' selected</span>' +
      '<button class="ehub-tool" data-b="read">Read</button>' +
      '<button class="ehub-tool" data-b="unread">Unread</button>' +
      '<button class="ehub-tool" data-b="star">' + '&#9733;' + '</button>' +
      (archive ? '<button class="ehub-tool" data-b="archive">' + ico('import', '') + ' Archive</button>' : '') +
      (trash ? '<button class="ehub-tool" data-b="trash">' + ico('delete', '') + ' Trash</button>' : '') +
      '<select class="ehub-tool" data-b="move"><option value="">Move to…</option>' +
        _state.folders.filter(function (f) { return f.id !== _state.folderId; })
          .sort(function (a, b) { return (a.path || '').localeCompare(b.path || ''); })
          .map(function (f) { return '<option value="' + esc(f.id) + '">' + esc((f.parent_id ? '— ' : '') + f.name) + '</option>'; }).join('') +
      '</select>' +
      '<button class="ehub-tool" data-b="clear" style="margin-left:auto;">Clear</button>';

    bar.querySelectorAll('[data-b]').forEach(function (el) {
      var act = el.getAttribute('data-b');
      if (act === 'move') {
        el.addEventListener('change', function () { if (el.value) moveThreads(selectedIds(), el.value); });
        return;
      }
      el.addEventListener('click', function () {
        var sel = selectedIds();
        if (act === 'clear') { _state.selected = {}; paintList(); return; }
        if (act === 'archive' && archive) return moveThreads(sel, archive.id);
        if (act === 'trash' && trash) return moveThreads(sel, trash.id);
        var patch = act === 'read' ? { is_read: true } : act === 'unread' ? { is_read: false } : { is_starred: true };
        post('/api/email-inbox/messages/state', Object.assign({ thread_ids: sel }, patch))
          .then(function () { _state.selected = {}; return loadFolders().then(loadThreads); })
          .catch(function (e) { toast(e.message); });
      });
    });
  }

  function moveThreads(threadIds, folderId) {
    if (!threadIds || !threadIds.length) return Promise.resolve();
    return post('/api/email-folders/move-messages', { thread_ids: threadIds, folder_id: folderId })
      .then(function (r) {
        var f = folderById(folderId);
        toast((r.moved || 0) + (r.moved === 1 ? ' message' : ' messages') + ' moved to ' + (f ? f.name : 'that folder') + '.');
        _state.selected = {};
        if (threadIds.indexOf(_state.activeThreadId) !== -1) {
          _state.activeThreadId = null;
          var p = document.getElementById('ehubPane');
          if (p) p.innerHTML = '<div class="ehub-empty">Moved. Pick another conversation.</div>';
        }
        return loadFolders().then(loadThreads);
      })
      .catch(function (e) { toast(e.message || 'Could not move that mail.'); });
  }

  // ── Reading pane ──────────────────────────────────────────────────
  function openThread(threadId) {
    _state.activeThreadId = threadId;
    paintList();
    var pane = document.getElementById('ehubPane');
    var body = document.getElementById('ehubBody');
    if (body) body.classList.add('show-thread');
    if (!pane) return;
    pane.innerHTML = '<div class="ehub-empty">Loading conversation…</div>';

    api('/api/email-inbox/threads/' + encodeURIComponent(threadId)).then(function (res) {
      var msgs = (res && res.messages) || [];
      if (!msgs.length) { pane.innerHTML = '<div class="ehub-empty">This conversation is empty.</div>'; return; }
      var subject = msgs[msgs.length - 1].subject || '(no subject)';
      var newest = msgs[msgs.length - 1];
      var starred = msgs.some(function (m) { return m.is_starred; });

      var head =
        '<div class="ehub-thead">' +
          '<button class="ehub-back" data-back>' + ico('align-left', '&#8592;') + ' Back</button>' +
          '<h3>' + esc(subject) + '</h3>' +
          '<div class="ehub-thead-meta">' +
            '<span class="ehub-sub">' + msgs.length + (msgs.length === 1 ? ' message' : ' messages') + '</span>' +
            '<button class="ehub-star' + (starred ? ' on' : '') + '" data-tstar title="Star">' + (starred ? '&#9733;' : '&#9734;') + '</button>' +
            '<button class="ehub-tool" data-unread title="Mark unread">' + ico('eye', '') + ' Unread</button>' +
            '<button class="ehub-tool" data-archive>' + ico('import', '') + ' Archive</button>' +
            '<button class="ehub-tool" data-trash>' + ico('delete', '') + ' Trash</button>' +
            '<select class="ehub-tool" data-move><option value="">Move to…</option>' +
              // slice() first — sorting _state.folders in place would reshuffle
              // the array the rail paints from, so opening a thread would
              // silently reorder the folder tree behind it.
              _state.folders.slice().sort(function (a, b) { return (a.path || '').localeCompare(b.path || ''); })
                .map(function (f) { return '<option value="' + esc(f.id) + '">' + esc((f.parent_id ? '— ' : '') + f.name) + '</option>'; }).join('') +
            '</select>' +
            '<button class="ehub-ask" data-ask>' + ico('sparkle', '') + ' Ask the assistant</button>' +
          '</div>' +
        '</div>';

      var bodyHtml = msgs.map(function (m) { return renderMessage(m); }).join('');

      // ── Assistant draft + handled state (H5, unchanged contract) ────
      var st = (res && res.state) || {};
      var lastInbound = null;
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].direction !== 'outbound') { lastInbound = msgs[i].received_at; break; }
      }
      var isHandled = !!(st.replied_at && lastInbound && new Date(st.replied_at) >= new Date(lastInbound));
      var draftHtml =
        '<div class="ehub-draft' + (isHandled ? ' is-handled' : '') + '">' +
          '<div class="ehub-draft-hd">' +
            '<span class="ehub-draft-ttl">' + ico('sparkle', '') + ' Assistant draft</span>' +
            (st.draft_updated_at
              ? '<span class="ehub-draft-when">' + (st.draft_source === 'assistant' ? 'written ' : 'edited ') + esc(fmtAgo(st.draft_updated_at)) + ' ago</span>'
              : '') +
            '<span class="ehub-draft-note">Copy into your mail client — P86 does not send.</span>' +
          '</div>' +
          '<textarea class="ehub-draft-ta" data-draft rows="6" placeholder="Nothing drafted yet — hit &ldquo;Draft a reply&rdquo; and the assistant will write one here.">' +
            esc(st.draft_text || '') + '</textarea>' +
          '<div class="ehub-draft-actions">' +
            '<button class="ehub-dbtn" data-draft-ask>' + ico('sparkle', '') + ' Draft a reply</button>' +
            '<button class="ehub-dbtn" data-draft-copy>Copy</button>' +
            '<span class="ehub-draft-saved" data-draft-saved></span>' +
            '<button class="ehub-dbtn ehub-dbtn-primary" data-replied>' +
              (isHandled ? '&#10003; Replied — undo' : 'Mark replied') + '</button>' +
          '</div>' +
        '</div>';

      pane.innerHTML = head + draftHtml + bodyHtml;
      sizeFrames(pane);
      wirePane(pane, threadId, subject, msgs, isHandled, newest);

      // Opening a conversation marks it read (every mail client does).
      if (msgs.some(function (m) { return !m.is_read; })) {
        post('/api/email-inbox/messages/state', { thread_ids: [threadId], is_read: true })
          .then(function () {
            var th = _state.threads.filter(function (x) { return x.thread_id === threadId; })[0];
            if (th) th.unread_count = 0;
            paintList();
            return loadFolders();
          })
          .catch(function () {});
      }
    }).catch(function (e) {
      pane.innerHTML = '<div class="ehub-empty">Could not load that conversation.<br>' + esc(e.message || '') + '</div>';
    });
  }

  // One message. Prefers the real HTML body (sandboxed) and falls back to
  // the plain-text body with the quoted tail collapsed.
  function renderMessage(m) {
    var isMine = m.direction === 'outbound';
    var who = isMine
      ? 'You' + (m.entity_label ? ' <span class="ehub-msg-fwd">to ' + esc(m.entity_label) + '</span>' : '')
      : (m.orig_from_email
          ? esc(m.from_email || 'unknown') + ' <span class="ehub-msg-fwd">originally from ' + esc(m.orig_from_email) + '</span>'
          : esc((m.from_name ? m.from_name + ' ' : '') + '<' + (m.from_email || 'unknown') + '>'));

    var inner = '';
    if (m.body_html) {
      var showImages = !!_state.imagesOk[m.id];
      var showQuotes = !!_state.quotesOpen[m.id];
      var clean = sanitizeEmailHtml(m.body_html, { showImages: showImages, showQuotes: showQuotes });
      if (clean.blockedImages) {
        inner += '<div class="ehub-imgbar">' + ico('photos', '') +
          '<span>' + clean.blockedImages + ' remote image' + (clean.blockedImages === 1 ? '' : 's') +
          ' blocked (senders use them to track opens).</span>' +
          '<button data-showimg="' + esc(m.id) + '">Show images</button></div>';
      }
      inner += '<iframe class="ehub-frame" sandbox="allow-same-origin allow-popups" referrerpolicy="no-referrer" ' +
        'srcdoc="' + esc(bodyDoc(clean.html, showImages)) + '"></iframe>';
      if (clean.hasQuotes) {
        inner += '<button class="ehub-quote-btn" data-quote="' + esc(m.id) + '">' +
          (showQuotes ? 'Hide quoted text' : '&hellip; Show quoted text') + '</button>';
      }
    } else {
      var split = splitQuoted(m.body_text || '');
      inner += '<div class="ehub-msg-body">' + esc(split.head || '(no text body)') + '</div>';
      if (split.quoted) {
        var open = !!_state.quotesOpen[m.id];
        inner += '<button class="ehub-quote-btn" data-quote="' + esc(m.id) + '">' +
          (open ? 'Hide quoted text' : '&hellip; Show quoted text') + '</button>' +
          (open ? '<div class="ehub-quoted">' + esc(split.quoted) + '</div>' : '');
      }
    }

    return '<div class="ehub-msg' + (isMine ? ' ehub-msg-mine' : '') + '" data-msg="' + esc(m.id) + '">' +
      '<div class="ehub-msg-hd">' +
        '<span class="ehub-msg-from">' + who + '</span>' +
        (!isMine && m.is_forward_wrapper ? '<span class="ehub-msg-fwd">forwarded copy</span>' : '') +
        (m.has_attachments ? '<span class="ehub-msg-fwd">' + ico('attachments', '') + ' attachment</span>' : '') +
        '<span class="ehub-msg-when">' + esc(fmtWhen(m.received_at)) + '</span>' +
      '</div>' + inner +
    '</div>';
  }

  // Auto-size each body iframe to its content. sandbox lacks allow-scripts,
  // so nothing inside can run — but allow-same-origin lets US measure it.
  function sizeFrames(root) {
    root.querySelectorAll('.ehub-frame').forEach(function (fr) {
      function fit() {
        try {
          var d = fr.contentDocument;
          if (!d || !d.body) return;
          fr.style.height = Math.min(4000, Math.max(40, d.body.scrollHeight + 12)) + 'px';
        } catch (e) { fr.style.height = '320px'; }
      }
      fr.addEventListener('load', function () { fit(); setTimeout(fit, 120); });
      fit();
    });
  }

  function wirePane(pane, threadId, subject, msgs, isHandled, newest) {
    var body = document.getElementById('ehubBody');
    var backBtn = pane.querySelector('[data-back]');
    if (backBtn) backBtn.addEventListener('click', function () { if (body) body.classList.remove('show-thread'); });

    var askBtn = pane.querySelector('[data-ask]');
    if (askBtn) askBtn.addEventListener('click', function () { handToAssistant(threadId, subject); });

    var arch = folderBySlug('archive'), trash = folderBySlug('trash');
    var aBtn = pane.querySelector('[data-archive]');
    if (aBtn && arch) aBtn.addEventListener('click', function () { moveThreads([threadId], arch.id); });
    var tBtn = pane.querySelector('[data-trash]');
    if (tBtn && trash) tBtn.addEventListener('click', function () { moveThreads([threadId], trash.id); });
    var mv = pane.querySelector('[data-move]');
    if (mv) mv.addEventListener('change', function () { if (mv.value) moveThreads([threadId], mv.value); });

    var unread = pane.querySelector('[data-unread]');
    if (unread) unread.addEventListener('click', function () {
      post('/api/email-inbox/messages/state', { thread_ids: [threadId], is_read: false })
        .then(function () { _state.activeThreadId = null; return loadFolders().then(loadThreads); })
        .catch(function (e) { toast(e.message); });
    });

    var tstar = pane.querySelector('[data-tstar]');
    if (tstar) tstar.addEventListener('click', function () {
      var next = !tstar.classList.contains('on');
      tstar.classList.toggle('on', next);
      tstar.innerHTML = next ? '&#9733;' : '&#9734;';
      post('/api/email-inbox/messages/state', { thread_ids: [threadId], is_starred: next })
        .then(loadThreads).catch(function (e) { toast(e.message); });
    });

    // Per-message toggles: load remote images / expand quoted text. Both
    // re-render just this thread so the srcdoc is rebuilt with the new CSP.
    pane.querySelectorAll('[data-showimg]').forEach(function (b) {
      b.addEventListener('click', function () { _state.imagesOk[b.getAttribute('data-showimg')] = true; openThread(threadId); });
    });
    pane.querySelectorAll('[data-quote]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-quote');
        _state.quotesOpen[id] = !_state.quotesOpen[id];
        openThread(threadId);
      });
    });

    // Draft box.
    var ta = pane.querySelector('[data-draft]');
    var savedEl = pane.querySelector('[data-draft-saved]');
    function flashSaved(txt) { if (savedEl) { savedEl.textContent = txt; setTimeout(function () { if (savedEl) savedEl.textContent = ''; }, 1800); } }
    if (ta) {
      var tTimer = null;
      ta.addEventListener('input', function () {
        clearTimeout(tTimer);
        tTimer = setTimeout(function () {
          api('/api/email-inbox/threads/' + encodeURIComponent(threadId) + '/draft', {
            method: 'PUT', body: JSON.stringify({ draft_text: ta.value, source: 'user' })
          }).then(function () { flashSaved('Saved'); }).catch(function () {});
        }, 700);
      });
    }
    var copyBtn = pane.querySelector('[data-draft-copy]');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var txt = ta ? ta.value : '';
      if (!txt) { flashSaved('Nothing to copy'); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { flashSaved('Copied'); }).catch(function () { flashSaved('Copy failed'); });
      } else { try { ta.select(); document.execCommand('copy'); flashSaved('Copied'); } catch (e) { flashSaved('Copy failed'); } }
    });
    var draftAskBtn = pane.querySelector('[data-draft-ask]');
    if (draftAskBtn) draftAskBtn.addEventListener('click', function () { askForDraft(threadId, subject); });
    var repliedBtn = pane.querySelector('[data-replied]');
    if (repliedBtn) repliedBtn.addEventListener('click', function () {
      repliedBtn.disabled = true;
      post('/api/email-inbox/threads/' + encodeURIComponent(threadId) + '/replied', { replied: !isHandled })
        .then(function () { loadThreads(); openThread(threadId); })
        .catch(function () { repliedBtn.disabled = false; });
    });
  }

  // ── Entity + assistant hand-offs (unchanged from H1/H5) ───────────
  function openEntity(kind, id) {
    if (!id) return;
    if (kind === 'client' && typeof window.openClientDashboard === 'function') {
      window.openClientDashboard(id);
    } else if (kind === 'lead' && typeof window.openEditLeadModal === 'function') {
      if (typeof window.switchTab === 'function') window.switchTab('estimates');
      window.openEditLeadModal(id);
    }
  }

  function handToAssistant(threadId, subject) {
    seedAssistant('Read my email thread [' + threadId + '] ("' + subject + '") and give me a short summary — what it\'s asking, anything time-sensitive, and whether it needs a reply. If there\'s a date or a commitment, offer to add a reminder or calendar event.', threadId);
  }
  function askForDraft(threadId, subject) {
    seedAssistant(
      'Draft my reply to email thread [' + threadId + '] ("' + subject + '"). ' +
      'Read the thread first, then write the reply in my voice — direct, professional, no fluff, ready to send as-is. ' +
      'Save it with the draft_email_reply tool using thread_id "' + threadId + '" so it lands in the draft box on that email. ' +
      'Do NOT send anything. Then tell me in one line what you drafted and flag anything you had to assume.',
      threadId);
  }
  function seedAssistant(prompt, threadId) {
    if (window.p86AI && window.p86AI.ask) {
      window.p86AI.ask(prompt);
    } else if (window.p86AI && window.p86AI.open) {
      window.p86AI.open({ entityType: 'ask86' });
      setTimeout(function () {
        var input = document.getElementById('ai-input');
        if (input) { input.value = prompt; input.dispatchEvent(new Event('input')); input.focus(); }
      }, 300);
    } else {
      alert('Open the assistant (Ask 86) and ask about thread ' + threadId + '.');
      return;
    }
    if (threadId) {
      [6000, 14000, 25000].forEach(function (ms) {
        setTimeout(function () { if (_state.activeThreadId === threadId) openThread(threadId); }, ms);
      });
    }
  }

  window.renderEmailHubTab = renderEmailHubTab;
  window.p86EmailHub = { render: renderEmailHubTab, open: renderEmailHubTab };
  // Exposed for tests / console poking; not part of the app's API surface.
  window.p86EmailHub.__sanitize = sanitizeEmailHtml;
})();
