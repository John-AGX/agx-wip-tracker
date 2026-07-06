// Reusable rich-text field — window.p86RichText.
//
// A library-free WYSIWYG built on contenteditable + execCommand (the same
// proven approach as the email text-block editor, generalized into a shared
// field with a fuller toolbar: Font · Size · B/I/U/S · align · lists · link ·
// clear). Produces SANITIZED HTML so the value is safe to store and to render
// in the app, in client proposals, in emails, and in print/PDF exports.
//
//   var rt = window.p86RichText.mount(hostEl, {
//     value: '<p>existing html OR legacy plain text</p>',
//     placeholder: 'Describe the work…',
//     minHeight: 140,          // px
//     compact: false,          // smaller toolbar (fewer groups)
//     onChange: function (html) { ... }   // debounced on edit
//   });
//   rt.getHTML();  rt.getText();  rt.setHTML(str);  rt.focus();  rt.destroy();
//
// Static helpers (safe to call without mounting):
//   p86RichText.sanitize(html)        → allowlist-clean HTML string
//   p86RichText.toDisplayHTML(value)  → sanitize + upgrade legacy plain text
//                                       (newlines→<br>); use for read-only
//                                       render into views / prints / emails.
//   p86RichText.isHTML(value)         → true when the value carries markup
//   p86RichText.toPlainText(value)    → tags stripped (for Excel/text exports)
//
// SECURITY: the sanitizer is an allowlist (tags + attributes + a per-property
// style allowlist), applied via a detached <template> tree-walk — never
// innerHTML'd into the live document before cleaning. Defense-in-depth: the
// server runs its own sanitizeRichText() pass on save regardless.

(function () {
  'use strict';
  if (window.p86RichText) return;

  // ── Allowlists ─────────────────────────────────────────────────────
  var ALLOWED_TAGS = {
    p:1, div:1, br:1, span:1, font:1,
    b:1, strong:1, i:1, em:1, u:1, s:1, strike:1,
    ul:1, ol:1, li:1, a:1, blockquote:1,
    h1:1, h2:1, h3:1, h4:1
  };
  // Attributes kept per tag (everything else is dropped).
  var ALLOWED_ATTRS = {
    a: { href:1, target:1, rel:1, title:1 },
    font: { face:1, size:1, color:1 },
    span: { style:1 }, div: { style:1 }, p: { style:1 }, li: { style:1 },
    h1: { style:1 }, h2: { style:1 }, h3: { style:1 }, h4: { style:1 }, blockquote: { style:1 }
  };
  // CSS properties kept inside a style="" attribute.
  var ALLOWED_STYLE = {
    'text-align':1, 'font-weight':1, 'font-style':1, 'text-decoration':1,
    'text-decoration-line':1, 'color':1, 'background-color':1,
    'font-family':1, 'font-size':1
  };
  // A style VALUE is rejected outright if it smells like an escape hatch.
  var STYLE_VALUE_BLOCK = /url\s*\(|expression\s*\(|javascript:|@import|<|>|\\/i;

  function safeHref(url) {
    var u = String(url == null ? '' : url).trim();
    if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
    // Protocol-relative and bare paths are fine; anything with a colon
    // that isn't an allowed scheme (javascript:, data:, vbscript:) is not.
    if (u.indexOf(':') === -1) return u;
    return null;
  }

  function cleanStyle(raw) {
    var out = [];
    String(raw || '').split(';').forEach(function (decl) {
      var i = decl.indexOf(':');
      if (i === -1) return;
      var prop = decl.slice(0, i).trim().toLowerCase();
      var val = decl.slice(i + 1).trim();
      if (!ALLOWED_STYLE[prop]) return;
      if (!val || STYLE_VALUE_BLOCK.test(val)) return;
      if (val.length > 120) return;
      out.push(prop + ': ' + val);
    });
    return out.join('; ');
  }

  // Walk a detached DOM subtree, dropping disallowed nodes/attrs in place.
  // Disallowed ELEMENTS are unwrapped (children kept) rather than deleted so
  // pasted/nested content isn't silently lost.
  function walk(node) {
    var kids = [].slice.call(node.childNodes);
    kids.forEach(function (child) {
      if (child.nodeType === 3) return;                 // text — keep
      if (child.nodeType === 8) { child.remove(); return; } // comment — drop
      if (child.nodeType !== 1) { child.remove(); return; } // pi/etc — drop
      var tag = child.tagName ? child.tagName.toLowerCase() : '';
      if (tag === 'script' || tag === 'style' || tag === 'iframe' ||
          tag === 'object' || tag === 'embed' || tag === 'link' ||
          tag === 'meta' || tag === 'form' || tag === 'input' ||
          tag === 'button' || tag === 'textarea') {
        child.remove(); return;                          // dangerous — drop w/ content
      }
      if (!ALLOWED_TAGS[tag]) {
        // Unwrap: move children up, then remove the wrapper.
        walk(child);
        var parent = child.parentNode;
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        parent.removeChild(child);
        return;
      }
      // Allowed element — scrub its attributes.
      var allowed = ALLOWED_ATTRS[tag] || {};
      [].slice.call(child.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (/^on/.test(name) || !allowed[name]) { child.removeAttribute(attr.name); return; }
        if (name === 'style') {
          var s = cleanStyle(attr.value);
          if (s) child.setAttribute('style', s); else child.removeAttribute('style');
        } else if (name === 'href') {
          var h = safeHref(attr.value);
          if (h == null) child.removeAttribute('href'); else child.setAttribute('href', h);
        } else if (tag === 'font' && name === 'size') {
          var n = parseInt(attr.value, 10);
          if (!(n >= 1 && n <= 7)) child.removeAttribute('size');
        }
      });
      if (tag === 'a' && child.getAttribute('href')) {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      walk(child);
    });
  }

  function sanitize(html) {
    if (html == null) return '';
    var tpl = document.createElement('template');
    tpl.innerHTML = String(html);
    walk(tpl.content);
    return tpl.innerHTML.trim();
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Does this value already carry rich markup? Legacy fields hold plain text.
  function isHTML(value) {
    return typeof value === 'string' && /<\/?[a-z][\s\S]*>/i.test(value);
  }

  // Sanitize for read-only rendering. Legacy plain text is upgraded so its
  // line breaks survive (newline→<br>, blank line→paragraph gap).
  function toDisplayHTML(value) {
    if (value == null || value === '') return '';
    if (isHTML(value)) return sanitize(value);
    return escapeHTML(value).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
  }

  function toPlainText(value) {
    if (value == null) return '';
    if (!isHTML(value)) return String(value);
    var tpl = document.createElement('template');
    tpl.innerHTML = sanitize(value).replace(/<\/(p|div|li|h[1-4]|blockquote)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
    return (tpl.content.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ── Styles (injected once) ─────────────────────────────────────────
  var STYLE_ID = 'p86rt-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.p86rt{border:1px solid var(--border,#2a2a32);border-radius:10px;overflow:hidden;background:var(--surface,#14141b);}' +
      '.p86rt-tb{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:6px 7px;border-bottom:1px solid var(--border,#2a2a32);background:var(--bg,#0f0f15);}' +
      '.p86rt-tb select{font:inherit;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border,#2a2a32);background:var(--surface,#181820);color:inherit;cursor:pointer;}' +
      '.p86rt-b{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0 6px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--text,#e5e7eb);cursor:pointer;font-size:13px;line-height:1;}' +
      '.p86rt-b:hover{background:var(--hover,#23232e);}' +
      '.p86rt-b:active{background:var(--accent-dim,rgba(34,211,238,0.18));}' +
      '.p86rt-b.on{background:var(--accent-dim,rgba(34,211,238,0.18));border-color:var(--accent,#22d3ee);}' +
      '.p86rt-sep{width:1px;align-self:stretch;margin:4px 4px;background:var(--border,#2a2a32);}' +
      '.p86rt-ed{padding:10px 12px;min-height:120px;max-height:60vh;overflow:auto;outline:none;font-size:13.5px;line-height:1.55;color:var(--text,#e5e7eb);}' +
      '.p86rt-ed:empty:before{content:attr(data-ph);color:var(--muted,#6b7280);pointer-events:none;}' +
      '.p86rt-ed p{margin:0 0 8px;} .p86rt-ed p:last-child{margin-bottom:0;}' +
      '.p86rt-ed ul,.p86rt-ed ol{margin:0 0 8px;padding-left:22px;}' +
      '.p86rt-ed a{color:var(--accent,#22d3ee);}' +
      '.p86rt-ed blockquote{margin:0 0 8px;padding-left:12px;border-left:3px solid var(--border,#2a2a32);color:var(--muted,#9ca3af);}' +
      // Read-only render (views / print). Kept light so it inherits page color.
      '.p86rt-render{font-size:13.5px;line-height:1.55;word-break:break-word;}' +
      '.p86rt-render p{margin:0 0 8px;} .p86rt-render p:last-child{margin-bottom:0;}' +
      '.p86rt-render ul,.p86rt-render ol{margin:0 0 8px;padding-left:22px;}' +
      '.p86rt-render blockquote{margin:0 0 8px;padding-left:12px;border-left:3px solid rgba(0,0,0,0.15);}' +
      '@media print{.p86rt-render{color:#111;}}';
    var st = document.createElement('style');
    st.id = STYLE_ID; st.textContent = css;
    document.head.appendChild(st);
  }

  var FONTS = ['Default', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS'];
  // Label → <font size> value (1-7). Portable across browsers, email + print.
  var SIZES = [['Size', ''], ['Small', '2'], ['Normal', '3'], ['Large', '5'], ['X-Large', '6'], ['Huge', '7']];

  function mkBtn(label, cmd, title, aria) {
    return '<button type="button" class="p86rt-b" data-cmd="' + cmd + '" title="' + title + '" aria-label="' + (aria || title) + '">' + label + '</button>';
  }

  function mount(host, opts) {
    opts = opts || {};
    ensureStyles();
    if (typeof host === 'string') host = document.querySelector(host);
    if (!host) return null;

    var wrap = document.createElement('div');
    wrap.className = 'p86rt';

    var fontOpts = FONTS.map(function (f) {
      return '<option value="' + (f === 'Default' ? '' : f) + '">' + f + '</option>';
    }).join('');
    var sizeOpts = SIZES.map(function (s) {
      return '<option value="' + s[1] + '"' + (s[1] === '' ? ' disabled selected' : '') + '>' + s[0] + '</option>';
    }).join('');

    var tbGroups = '<select class="p86rt-font" title="Font" aria-label="Font">' + fontOpts + '</select>' +
      '<select class="p86rt-size" title="Size" aria-label="Font size">' + sizeOpts + '</select>' +
      '<span class="p86rt-sep"></span>' +
      mkBtn('<b>B</b>', 'bold', 'Bold (Ctrl+B)') +
      mkBtn('<i>I</i>', 'italic', 'Italic (Ctrl+I)') +
      mkBtn('<u>U</u>', 'underline', 'Underline (Ctrl+U)') +
      mkBtn('<s>S</s>', 'strikeThrough', 'Strikethrough') +
      '<span class="p86rt-sep"></span>' +
      mkBtn('&#8676;', 'justifyLeft', 'Align left') +
      mkBtn('&#8677;'.replace('&#8677;', '&#8644;'), 'justifyCenter', 'Align center') +
      mkBtn('&#8677;', 'justifyRight', 'Align right') +
      (opts.compact ? '' : mkBtn('&#8801;', 'justifyFull', 'Justify')) +
      '<span class="p86rt-sep"></span>' +
      mkBtn('&#8226;', 'insertUnorderedList', 'Bulleted list') +
      mkBtn('1.', 'insertOrderedList', 'Numbered list') +
      '<span class="p86rt-sep"></span>' +
      mkBtn('&#128279;', 'createLink', 'Insert link') +
      mkBtn('&#10005;', 'removeFormat', 'Clear formatting');

    var tb = document.createElement('div');
    tb.className = 'p86rt-tb';
    tb.innerHTML = tbGroups;

    var ed = document.createElement('div');
    ed.className = 'p86rt-ed';
    ed.contentEditable = 'true';
    ed.setAttribute('data-ph', opts.placeholder || '');
    ed.style.minHeight = (opts.minHeight || 120) + 'px';
    ed.innerHTML = toDisplayHTML(opts.value);

    wrap.appendChild(tb);
    wrap.appendChild(ed);
    host.appendChild(wrap);

    // execCommand with CSS styling so B/I/color/font emit inline styles
    // (portable to email + print) instead of legacy presentational tags.
    try { document.execCommand('styleWithCSS', false, true); } catch (e) {}

    var changeT = null;
    function fireChange() {
      if (!opts.onChange) return;
      clearTimeout(changeT);
      changeT = setTimeout(function () { opts.onChange(getHTML()); }, 250);
    }
    function exec(cmd, val) {
      ed.focus();
      try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
      try { document.execCommand(cmd, false, val == null ? null : val); } catch (e) {}
      syncActive(); fireChange();
    }

    tb.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-cmd]');
      if (!btn) return;
      e.preventDefault();
      var cmd = btn.getAttribute('data-cmd');
      if (cmd === 'createLink') {
        var url = window.prompt('Link URL:', 'https://');
        if (url) exec('createLink', url.trim());
        return;
      }
      exec(cmd);
    });
    // Keep focus in the editor when clicking the toolbar chrome (not a button).
    tb.addEventListener('mousedown', function (e) { if (!e.target.closest('select')) e.preventDefault(); });

    var fontSel = tb.querySelector('.p86rt-font');
    var sizeSel = tb.querySelector('.p86rt-size');
    fontSel.addEventListener('change', function () {
      if (fontSel.value) exec('fontName', fontSel.value);
      else exec('removeFormat');   // "Default" clears the family
      fontSel.selectedIndex = 0;
    });
    sizeSel.addEventListener('change', function () {
      if (sizeSel.value) exec('fontSize', sizeSel.value);
      sizeSel.selectedIndex = 0;
    });

    // Reflect active B/I/U/S state on the buttons.
    function syncActive() {
      [['bold','bold'],['italic','italic'],['underline','underline'],['strikeThrough','strikeThrough']].forEach(function (p) {
        var b = tb.querySelector('[data-cmd="' + p[1] + '"]');
        if (!b) return;
        var on = false; try { on = document.queryCommandState(p[0]); } catch (e) {}
        b.classList.toggle('on', !!on);
      });
    }
    ed.addEventListener('keyup', function () { syncActive(); fireChange(); });
    ed.addEventListener('mouseup', syncActive);
    ed.addEventListener('input', fireChange);
    // Paste as sanitized content — never trust clipboard HTML.
    ed.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      e.preventDefault();
      var html = e.clipboardData.getData('text/html');
      var text = e.clipboardData.getData('text/plain');
      var frag = html ? sanitize(html) : escapeHTML(text).replace(/\n/g, '<br>');
      try { document.execCommand('insertHTML', false, frag); } catch (e2) {}
      fireChange();
    });

    function getHTML() { return sanitize(ed.innerHTML); }
    function getText() { return toPlainText(ed.innerHTML); }
    function setHTML(v) { ed.innerHTML = toDisplayHTML(v); }
    function focus() { ed.focus(); }
    function destroy() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }

    return { el: wrap, editor: ed, getHTML: getHTML, getText: getText, setHTML: setHTML, focus: focus, destroy: destroy };
  }

  window.p86RichText = {
    mount: mount,
    sanitize: sanitize,
    toDisplayHTML: toDisplayHTML,
    toPlainText: toPlainText,
    isHTML: isHTML
  };
})();
