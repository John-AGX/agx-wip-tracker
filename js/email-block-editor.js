// Email template visual block editor (Wave 3).
//
// Drop-in replacement for the raw HTML textarea in the admin Email
// Templates editor. Renders the template body as a vertical stack of
// editable blocks (header / text / button / spacer / image / footer)
// and emits an `onChange(bodyString)` callback whenever anything
// changes. The body string is JSON with shape `{"blocks":[...]}` —
// the server's tryParseBlocks() sniffs the leading char and routes
// it to renderBlocks() instead of legacy raw-HTML interpolation.
//
// Public surface:
//   window.p86EmailBlocks.mount(host, opts)
//     opts.blocks?    initial blocks array (parsed from JSON body or
//                     loaded from a baked default). Empty array =>
//                     empty canvas with just an Add-Block button.
//     opts.htmlBody?  raw HTML fallback for the HTML-mode toggle.
//     opts.onChange   called with the serialized body string on edit.
//     opts.variables  array of template variable names ('name',
//                     'email', etc.) — drives the "Insert variable"
//                     menu inside text blocks.
//   returns { destroy(), getBody(), setBody(bodyString) }
//
// The editor lives entirely in the parent's DOM — no global state
// outside window.p86EmailBlocks. Multiple instances can mount on the
// same page (e.g. the admin editor + a future preview-side editor)
// without interference.

(function() {
  'use strict';

  if (window.p86EmailBlocks) return;

  // Default block factories — what a fresh "+ Add Block" produces.
  var BLOCK_DEFAULTS = {
    header:  function() { return { type: 'header',  title: 'Welcome', subtitle: '' }; },
    text:    function() { return { type: 'text',    html: '<p>Hi {{name}},</p><p>Write your message here.</p>' }; },
    button:  function() { return { type: 'button',  label: 'Click here', url: '{{appUrl}}', bg_color: '#4f8cff' }; },
    spacer:  function() { return { type: 'spacer',  height_px: 16 }; },
    image:   function() { return { type: 'image',   url: '', alt: '', max_width_px: 560 }; },
    footer:  function() { return { type: 'footer',  address: '', unsubscribe_url: '' }; }
  };

  // Block palette — order shown in the "+ Add Block" menu.
  var BLOCK_TYPES = [
    { id: 'header',  glyph: '▲', label: 'Header' },
    { id: 'text',    glyph: '¶', label: 'Text' },
    { id: 'button',  glyph: '●', label: 'Button' },
    { id: 'spacer',  glyph: '—', label: 'Spacer' },
    { id: 'image',   glyph: '■', label: 'Image' },
    { id: 'footer',  glyph: '▼', label: 'Footer' }
  ];

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
  }

  // Minimal HTML sanitizer for text-block content. Mirrors the
  // server-side sanitizeBlockHtml() — strips dangerous tags + on*
  // handlers + javascript: URIs. Defense-in-depth; the server runs
  // its own pass at render time regardless.
  var ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'a', 'br', 'p', 'ul', 'ol', 'li'];
  function clientSanitize(html) {
    if (typeof html !== 'string') return '';
    var s = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|iframe|object|embed|form|input|button)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(/javascript\s*:/gi, '');
    return s.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, function(match, tag) {
      return ALLOWED_TAGS.indexOf(String(tag).toLowerCase()) === -1 ? '' : match;
    });
  }

  // ── Public mount ───────────────────────────────────────────────────
  function mount(host, opts) {
    opts = opts || {};
    var state = {
      blocks: Array.isArray(opts.blocks) ? deepClone(opts.blocks) : [],
      htmlMode: !!opts.htmlMode,
      htmlBody: typeof opts.htmlBody === 'string' ? opts.htmlBody : '',
      variables: Array.isArray(opts.variables) ? opts.variables : [],
      onChange: typeof opts.onChange === 'function' ? opts.onChange : function() {}
    };

    function emitChange() {
      var body = state.htmlMode
        ? state.htmlBody
        : JSON.stringify({ blocks: state.blocks });
      state.onChange(body);
    }

    function paint() {
      host.innerHTML = '';
      host.className = 'p86-email-blocks-editor' + (state.htmlMode ? ' html-mode' : '');

      // Mode toggle bar (Visual / HTML).
      var modeBar = document.createElement('div');
      modeBar.className = 'p86-eb-modebar';
      modeBar.innerHTML =
        '<div class="p86-eb-mode-pills">' +
          '<button class="p86-eb-mode-pill' + (!state.htmlMode ? ' active' : '') + '" data-mode="visual">&#x270E; Visual</button>' +
          '<button class="p86-eb-mode-pill' + (state.htmlMode ? ' active' : '') + '" data-mode="html">&lt;/&gt; HTML</button>' +
        '</div>' +
        (state.variables.length
          ? '<div class="p86-eb-vars-hint">Use <code>{{var}}</code> placeholders; click an option to insert.</div>'
          : '');
      modeBar.querySelectorAll('.p86-eb-mode-pill').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var next = btn.getAttribute('data-mode');
          if (next === 'html' && !state.htmlMode) {
            // Visual → HTML: capture an HTML snapshot of the blocks
            // so the user can edit it raw. One-way conversion: we
            // don't try to re-parse HTML back into blocks.
            state.htmlBody = serializeBlocksToHtml(state.blocks);
            state.htmlMode = true;
          } else if (next === 'visual' && state.htmlMode) {
            if (!window.confirm('Switching to Visual mode will discard your HTML edits and restore the block layout. Continue?')) return;
            state.htmlMode = false;
          }
          emitChange();
          paint();
        });
      });
      host.appendChild(modeBar);

      if (state.htmlMode) {
        // HTML-mode textarea — same shape the legacy editor used.
        var ta = document.createElement('textarea');
        ta.className = 'p86-eb-html-textarea';
        ta.value = state.htmlBody;
        ta.placeholder = 'Raw HTML for the email body';
        ta.addEventListener('input', function() {
          state.htmlBody = ta.value;
          emitChange();
        });
        host.appendChild(ta);
        return;
      }

      // Visual mode — block stack + add-block menu.
      var stack = document.createElement('div');
      stack.className = 'p86-eb-stack';
      state.blocks.forEach(function(block, idx) {
        stack.appendChild(renderBlockCard(block, idx));
      });
      host.appendChild(stack);

      // Add Block bar at the bottom.
      var adder = document.createElement('div');
      adder.className = 'p86-eb-adder';
      adder.innerHTML = '<div class="p86-eb-adder-label">+ Add a block</div>' +
        BLOCK_TYPES.map(function(bt) {
          return '<button class="p86-eb-adder-btn" data-block-type="' + bt.id + '" title="Add a ' + bt.label + ' block">' +
            '<span class="p86-eb-adder-glyph">' + bt.glyph + '</span>' +
            '<span>' + escapeHTML(bt.label) + '</span>' +
          '</button>';
        }).join('');
      adder.querySelectorAll('[data-block-type]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var t = btn.getAttribute('data-block-type');
          var factory = BLOCK_DEFAULTS[t];
          if (!factory) return;
          state.blocks.push(factory());
          emitChange();
          paint();
        });
      });
      host.appendChild(adder);

      if (!state.blocks.length) {
        var empty = document.createElement('div');
        empty.className = 'p86-eb-empty';
        empty.textContent = 'Empty template — pick a block above to get started.';
        host.insertBefore(empty, adder);
      }
    }

    function renderBlockCard(block, idx) {
      var card = document.createElement('div');
      card.className = 'p86-eb-block p86-eb-block-' + escapeAttr(block.type || 'unknown');
      card.setAttribute('data-block-idx', String(idx));
      card.setAttribute('draggable', 'true');

      // Drag-and-drop reordering. Dragging starts on the whole card;
      // dragstart sets the source index, dragover/drop on any sibling
      // card runs the swap. Drop indicator: a 2px accent line above
      // the hovered target. Plays well with the keyboard ▴▾
      // fallback — both update state.blocks the same way.
      card.addEventListener('dragstart', function(e) {
        // Hide drag while in the middle of editing a contenteditable
        // field — otherwise dragging selected text starts a drag.
        if (e.target && e.target.classList && e.target.classList.contains('p86-eb-rt-editor')) {
          e.preventDefault();
          return;
        }
        try { e.dataTransfer.setData('text/plain', String(idx)); } catch (e2) {}
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        card.classList.add('p86-eb-dragging');
      });
      card.addEventListener('dragend', function() {
        card.classList.remove('p86-eb-dragging');
        // Clear all hover indicators.
        host.querySelectorAll('.p86-eb-drop-target').forEach(function(el) {
          el.classList.remove('p86-eb-drop-target');
        });
      });
      card.addEventListener('dragover', function(e) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        // Light up this card as the target.
        host.querySelectorAll('.p86-eb-drop-target').forEach(function(el) {
          el.classList.remove('p86-eb-drop-target');
        });
        card.classList.add('p86-eb-drop-target');
      });
      card.addEventListener('dragleave', function(e) {
        // Only clear if leaving the card entirely (not just moving
        // to a child).
        if (e.target === card) card.classList.remove('p86-eb-drop-target');
      });
      card.addEventListener('drop', function(e) {
        e.preventDefault();
        card.classList.remove('p86-eb-drop-target');
        var fromIdx = -1;
        try { fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10); } catch (e2) {}
        if (!Number.isFinite(fromIdx) || fromIdx < 0 || fromIdx === idx) return;
        var moved = state.blocks.splice(fromIdx, 1)[0];
        // Adjust target index for the removal shift.
        var insertAt = (fromIdx < idx) ? idx - 1 : idx;
        state.blocks.splice(insertAt, 0, moved);
        emitChange();
        paint();
      });

      // Per-block toolbar — drag handle, move up / down / delete.
      var toolbar = document.createElement('div');
      toolbar.className = 'p86-eb-block-toolbar';
      toolbar.innerHTML =
        '<span class="p86-eb-block-handle" title="Drag to reorder">⋮⋮</span>' +
        '<span class="p86-eb-block-label">' + escapeHTML(blockTypeLabel(block.type)) + '</span>' +
        '<span class="p86-eb-block-actions">' +
          '<button class="p86-eb-block-btn" data-act="up"   title="Move up">▴</button>' +
          '<button class="p86-eb-block-btn" data-act="down" title="Move down">▾</button>' +
          '<button class="p86-eb-block-btn danger" data-act="del" title="Remove">×</button>' +
        '</span>';
      toolbar.querySelectorAll('[data-act]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var act = btn.getAttribute('data-act');
          if (act === 'up' && idx > 0) {
            var tmp = state.blocks[idx - 1];
            state.blocks[idx - 1] = state.blocks[idx];
            state.blocks[idx] = tmp;
            emitChange(); paint();
          } else if (act === 'down' && idx < state.blocks.length - 1) {
            var tmp2 = state.blocks[idx + 1];
            state.blocks[idx + 1] = state.blocks[idx];
            state.blocks[idx] = tmp2;
            emitChange(); paint();
          } else if (act === 'del') {
            if (!window.confirm('Remove this ' + blockTypeLabel(block.type).toLowerCase() + ' block?')) return;
            state.blocks.splice(idx, 1);
            emitChange(); paint();
          }
        });
      });
      card.appendChild(toolbar);

      // Block-type-specific fields.
      var body = document.createElement('div');
      body.className = 'p86-eb-block-body';
      body.appendChild(renderBlockFields(block, idx));
      card.appendChild(body);

      return card;
    }

    function renderBlockFields(block, idx) {
      var box = document.createElement('div');
      box.className = 'p86-eb-fields';
      var t = (block.type || '').toLowerCase();

      function field(label, key, opts) {
        opts = opts || {};
        var wrap = document.createElement('label');
        wrap.className = 'p86-eb-field';
        wrap.innerHTML = '<span class="p86-eb-field-label">' + escapeHTML(label) + '</span>';
        var input;
        if (opts.type === 'number') {
          input = document.createElement('input');
          input.type = 'number';
          input.className = 'p86-eb-input';
          input.value = block[key] != null ? block[key] : '';
          if (opts.min != null) input.min = String(opts.min);
          if (opts.max != null) input.max = String(opts.max);
        } else if (opts.type === 'color') {
          input = document.createElement('input');
          input.type = 'color';
          input.className = 'p86-eb-input color';
          input.value = /^#[0-9a-f]{6}$/i.test(block[key] || '') ? block[key] : '#4f8cff';
        } else if (opts.type === 'textarea') {
          input = document.createElement('textarea');
          input.className = 'p86-eb-input textarea';
          input.value = block[key] || '';
          input.rows = 3;
        } else {
          input = document.createElement('input');
          input.type = 'text';
          input.className = 'p86-eb-input';
          input.value = block[key] != null ? block[key] : '';
          if (opts.placeholder) input.placeholder = opts.placeholder;
        }
        input.addEventListener('input', function() {
          var v = input.value;
          if (opts.type === 'number') {
            var n = Number(v);
            if (Number.isFinite(n)) block[key] = n;
          } else {
            block[key] = v;
          }
          emitChange();
        });
        wrap.appendChild(input);
        return wrap;
      }

      // Rich-text editor for text blocks. Built on contenteditable +
      // execCommand — the only library-free way to get B/I/link/clear
      // without pulling in Quill or Tiptap. execCommand is deprecated
      // but still works in every email-relevant browser, and the
      // server sanitizer guarantees the output is safe.
      function richTextField(label, key) {
        var wrap = document.createElement('div');
        wrap.className = 'p86-eb-field p86-eb-field-rich';
        wrap.innerHTML = '<span class="p86-eb-field-label">' + escapeHTML(label) + '</span>';

        var toolbar = document.createElement('div');
        toolbar.className = 'p86-eb-rt-toolbar';
        toolbar.innerHTML =
          '<button type="button" data-rt="bold"   title="Bold (Ctrl+B)"><b>B</b></button>' +
          '<button type="button" data-rt="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
          '<button type="button" data-rt="link"   title="Insert link">&#x1F517;</button>' +
          '<button type="button" data-rt="ul"     title="Bulleted list">&bull;</button>' +
          '<button type="button" data-rt="clean"  title="Clear formatting">&#x274C;</button>' +
          (state.variables.length
            ? '<select class="p86-eb-rt-vars" title="Insert template variable">' +
                '<option value="">+ Insert variable…</option>' +
                state.variables.map(function(v) { return '<option value="' + escapeAttr(v) + '">{{' + escapeHTML(v) + '}}</option>'; }).join('') +
              '</select>'
            : '');
        wrap.appendChild(toolbar);

        var editor = document.createElement('div');
        editor.className = 'p86-eb-rt-editor';
        editor.contentEditable = 'true';
        editor.innerHTML = clientSanitize(block[key] || '');
        editor.addEventListener('input', function() {
          block[key] = clientSanitize(editor.innerHTML);
          emitChange();
        });
        wrap.appendChild(editor);

        toolbar.querySelectorAll('[data-rt]').forEach(function(btn) {
          btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
          btn.addEventListener('click', function() {
            var op = btn.getAttribute('data-rt');
            editor.focus();
            if (op === 'bold')   document.execCommand('bold', false, null);
            else if (op === 'italic') document.execCommand('italic', false, null);
            else if (op === 'ul') document.execCommand('insertUnorderedList', false, null);
            else if (op === 'clean') document.execCommand('removeFormat', false, null);
            else if (op === 'link') {
              var url = window.prompt('Link URL:', 'https://');
              if (url) document.execCommand('createLink', false, url);
            }
            block[key] = clientSanitize(editor.innerHTML);
            emitChange();
          });
        });

        var varSel = toolbar.querySelector('.p86-eb-rt-vars');
        if (varSel) varSel.addEventListener('change', function() {
          var v = varSel.value;
          if (!v) return;
          editor.focus();
          // Insert as plain text so the variable shows as raw
          // {{varname}} — the server interpolates at send time.
          document.execCommand('insertText', false, '{{' + v + '}}');
          varSel.value = '';
          block[key] = clientSanitize(editor.innerHTML);
          emitChange();
        });

        return wrap;
      }

      if (t === 'header') {
        box.appendChild(field('Title', 'title', { placeholder: 'Welcome to {{platform_name}}' }));
        box.appendChild(field('Subtitle', 'subtitle', { placeholder: 'Optional smaller line under the title' }));
        box.appendChild(field('Logo URL', 'logo_url', { placeholder: 'https://… (optional)' }));
      } else if (t === 'text') {
        box.appendChild(richTextField('Body', 'html'));
      } else if (t === 'button') {
        box.appendChild(field('Label', 'label', { placeholder: 'Sign in' }));
        box.appendChild(field('URL', 'url', { placeholder: '{{appUrl}}' }));
        box.appendChild(field('Background color', 'bg_color', { type: 'color' }));
      } else if (t === 'spacer') {
        box.appendChild(field('Height (pixels)', 'height_px', { type: 'number', min: 4, max: 120 }));
      } else if (t === 'image') {
        // URL field + Upload button. Upload routes through the
        // existing /api/attachments endpoint (user-scope), reuses
        // the same auth + resize pipeline as every other photo
        // upload in the app. Returns a webUrl that auto-fills the
        // URL field.
        var urlField = field('Image URL', 'url', { placeholder: 'https://…/photo.jpg' });
        box.appendChild(urlField);
        var urlInput = urlField.querySelector('input');
        // Inline preview + upload button beneath the URL.
        var actions = document.createElement('div');
        actions.className = 'p86-eb-image-actions';
        actions.innerHTML =
          '<button type="button" class="p86-eb-upload-btn">&#x1F4E4; Upload image…</button>' +
          '<input type="file" accept="image/*" class="p86-eb-upload-input" style="display:none;" />' +
          '<span class="p86-eb-upload-status"></span>';
        var fileInput = actions.querySelector('.p86-eb-upload-input');
        var statusEl = actions.querySelector('.p86-eb-upload-status');
        actions.querySelector('.p86-eb-upload-btn').addEventListener('click', function() {
          fileInput.click();
        });
        fileInput.addEventListener('change', function() {
          var f = fileInput.files && fileInput.files[0];
          if (!f) return;
          if (!window.p86Api || !window.p86Api.attachments || !window.p86Api.attachments.upload) {
            statusEl.textContent = 'Upload not available.';
            statusEl.style.color = '#f87171';
            return;
          }
          var me = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
          var uid = me ? String(me.id) : null;
          if (!uid) {
            statusEl.textContent = 'Sign in required to upload.';
            statusEl.style.color = '#f87171';
            return;
          }
          statusEl.textContent = 'Uploading…';
          statusEl.style.color = 'var(--text-dim, #888)';
          window.p86Api.attachments.upload('user', uid, f, {
            // Park uploaded email images in a dedicated folder so
            // they don't clutter My Files. The folder gets auto-
            // created if it doesn't exist.
            folder: 'email-templates',
            geo: false
          }).then(function(resp) {
            var att = resp && resp.attachment;
            var url = att && (att.web_url || att.original_url);
            if (!url) throw new Error('Upload succeeded but no URL returned.');
            block.url = url;
            if (urlInput) urlInput.value = url;
            statusEl.innerHTML = '<span style="color:#34d399;">&#x2713; Uploaded</span>';
            emitChange();
            // Refresh preview thumb.
            var oldPrev = actions.querySelector('.p86-eb-image-preview');
            if (oldPrev) oldPrev.remove();
            var prev = document.createElement('img');
            prev.className = 'p86-eb-image-preview';
            prev.src = url;
            actions.appendChild(prev);
          }).catch(function(err) {
            statusEl.textContent = 'Upload failed: ' + (err.message || 'unknown');
            statusEl.style.color = '#f87171';
          });
          fileInput.value = '';
        });
        box.appendChild(actions);
        // Show an existing image as a thumbnail preview right away.
        if (block.url) {
          var existing = document.createElement('img');
          existing.className = 'p86-eb-image-preview';
          existing.src = block.url;
          actions.appendChild(existing);
        }
        box.appendChild(field('Alt text', 'alt', { placeholder: 'Description for screen readers' }));
        box.appendChild(field('Max width (pixels)', 'max_width_px', { type: 'number', min: 80, max: 900 }));
      } else if (t === 'footer') {
        box.appendChild(field('Address / company line', 'address', { type: 'textarea', placeholder: 'AGX · Tampa, FL' }));
        box.appendChild(field('Unsubscribe URL', 'unsubscribe_url', { placeholder: '{{appUrl}}/unsubscribe (optional)' }));
      } else {
        box.innerHTML = '<div class="p86-eb-unknown">Unknown block type: ' + escapeHTML(t) + '</div>';
      }
      return box;
    }

    function blockTypeLabel(t) {
      var match = BLOCK_TYPES.find(function(bt) { return bt.id === t; });
      return match ? match.label : (t || 'Block');
    }

    // Serialize blocks → raw HTML so the user can switch to HTML
    // mode and see a starting point. Mirrors renderBlock() on the
    // server but builds plain HTML (no `<table>` wrapper) so the
    // user can edit freely. NOT used for actual rendering — that's
    // the server's job.
    function serializeBlocksToHtml(blocks) {
      return blocks.map(function(b) {
        var t = (b.type || '').toLowerCase();
        if (t === 'header') return '<h2>' + escapeHTML(b.title || '') + '</h2>' + (b.subtitle ? '<p>' + escapeHTML(b.subtitle) + '</p>' : '');
        if (t === 'text') return clientSanitize(b.html || '');
        if (t === 'button') return '<p><a href="' + escapeAttr(b.url || '#') + '" style="background:' + escapeAttr(b.bg_color || '#4f8cff') + ';color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">' + escapeHTML(b.label || 'Click') + '</a></p>';
        if (t === 'spacer') return '<div style="height:' + (Number(b.height_px) || 16) + 'px;"></div>';
        if (t === 'image') return b.url ? '<img src="' + escapeAttr(b.url) + '" alt="' + escapeAttr(b.alt || '') + '" style="max-width:' + (Number(b.max_width_px) || 560) + 'px;" />' : '';
        if (t === 'footer') return '<hr/><p>' + escapeHTML(b.address || '') + '</p>' + (b.unsubscribe_url ? '<p><a href="' + escapeAttr(b.unsubscribe_url) + '">Unsubscribe</a></p>' : '');
        return '';
      }).join('\n');
    }

    function deepClone(v) {
      try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
    }

    paint();

    return {
      destroy: function() { host.innerHTML = ''; },
      getBody: function() {
        return state.htmlMode ? state.htmlBody : JSON.stringify({ blocks: state.blocks });
      },
      setBody: function(bodyString) {
        var trimmed = String(bodyString || '').trim();
        if (trimmed[0] === '{' && trimmed.indexOf('"blocks"') !== -1) {
          try {
            var parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed.blocks)) {
              state.blocks = parsed.blocks;
              state.htmlMode = false;
              state.htmlBody = '';
              paint();
              return;
            }
          } catch (e) { /* fall through */ }
        }
        // Legacy raw HTML.
        state.blocks = [];
        state.htmlMode = true;
        state.htmlBody = bodyString || '';
        paint();
      }
    };
  }

  // Client-side renderer that mirrors server/email-templates.js
  // renderBlocks(). Used by the admin live-preview iframe so the
  // user sees what the email will look like as they type, without
  // a server round-trip per keystroke. The output is email-safe
  // HTML wrapped in a max-width table — same shape the server
  // produces. NOT a substitute for the server render at send time.
  function renderBlocksToHtml(blocks, params, ctx) {
    if (!Array.isArray(blocks)) return '';
    var p = params || {};
    ctx = ctx || {};
    var scope = ctx.scope || 'org';
    var p86Logo = ctx.p86Logo || '';
    var orgLogo = ctx.orgLogo || '';
    var accent = ctx.accent || '#4f8cff';
    function interp(str) {
      if (typeof str !== 'string') return '';
      return str
        .replace(/\{\{\{\s*([^}]+?)\s*\}\}\}/g, function(_, k) { return resolve(k, p); })
        .replace(/\{\{\s*([^}]+?)\s*\}\}/g, function(_, k) { return escapeHTML(resolve(k, p)); });
    }
    function resolve(path, obj) {
      var v = path.split('.').reduce(function(o, k) { return (o && o[k] != null) ? o[k] : null; }, obj);
      return v == null ? '' : String(v);
    }
    // Project 86 footer (logo + powered-by) — mirrors the server so the live
    // preview matches the sent email; appended when a template has no footer.
    function footerRow(addr) {
      var logo = p86Logo ? '<img src="' + escapeAttr(p86Logo) + '" alt="Project 86" style="height:22px;display:inline-block;margin:0 auto 8px;" />' : '';
      return '<tr><td style="padding:18px 24px;text-align:center;color:#6b7280;font-size:11px;border-top:1px solid #e5e7eb;">' +
        logo + '<div>Powered by Project 86</div>' +
        (addr ? '<div style="margin-top:2px;">' + interp(addr) + '</div>' : '') + '</td></tr>';
    }
    var hasFooter = false;
    var rows = blocks.map(function(b) {
      var t = (b.type || '').toLowerCase();
      if (t === 'header') {
        var sub = b.subtitle ? '<div style="font-size:13px;color:#6b7280;text-align:center;margin-top:4px;">' + interp(b.subtitle) + '</div>' : '';
        var titleRow = '<tr><td style="padding:16px 24px 8px;text-align:center;">' +
          '<div style="font-size:22px;font-weight:700;color:#111827;line-height:1.2;">' + interp(b.title || '') + '</div>' + sub + '</td></tr>';
        if (scope === 'system') {
          // Mirrors brandLockupRow in server/email-templates.js — the app's
          // sticky-header lockup (navy bar + cube + tracked-out wordmark).
          // b.brand_style: 'bar' (default) | 'banner' | 'light'.
          var WM = "font-family:Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-weight:200;letter-spacing:2.5px;";
          var NAVY = '#0F172A', CYAN = '#22D3EE';
          var icon = '/images/pwa/icon-192.png';
          var s = String(b.brand_style || 'bar').toLowerCase();
          var lockup;
          if (s === 'light') {
            lockup = '<tr><td style="padding:20px 24px 0;text-align:center;">' +
              '<img src="' + icon + '" width="34" height="34" alt="" style="display:inline-block;vertical-align:middle;border-radius:7px;" />' +
              '<span style="' + WM + 'font-size:16px;color:' + NAVY + ';vertical-align:middle;padding-left:12px;">PROJECT&nbsp;86</span>' +
              '<div style="height:2px;line-height:2px;font-size:2px;background:' + CYAN + ';margin-top:14px;">&nbsp;</div></td></tr>';
          } else if (s === 'banner') {
            lockup = '<tr><td style="padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + NAVY + ';border-bottom:2px solid ' + CYAN + ';"><tr>' +
              '<td style="padding:22px 24px 18px;text-align:center;">' +
              '<img src="' + icon + '" width="44" height="44" alt="" style="display:inline-block;border-radius:9px;" />' +
              '<div style="' + WM + 'font-size:17px;color:#F8FAFC;margin-top:10px;">PROJECT&nbsp;86</div></td></tr></table></td></tr>';
          } else {
            lockup = '<tr><td style="padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + NAVY + ';border-bottom:2px solid ' + CYAN + ';"><tr>' +
              '<td style="padding:14px 24px;">' +
              '<img src="' + icon + '" width="32" height="32" alt="" style="display:inline-block;vertical-align:middle;border-radius:6px;" />' +
              '<span style="' + WM + 'font-size:16px;color:#F8FAFC;vertical-align:middle;padding-left:12px;">PROJECT&nbsp;86</span></td></tr></table></td></tr>';
          }
          return lockup + titleRow;
        }
        var logoSrc = b.logo_url || orgLogo || p86Logo;
        var logo = logoSrc ? '<img src="' + escapeAttr(logoSrc) + '" alt="" style="max-height:42px;display:block;margin:0 auto 10px;" />' : '';
        return '<tr><td style="padding:16px 24px 0;text-align:center;">' + logo + '</td></tr>' + titleRow;
      }
      if (t === 'text') {
        return '<tr><td style="padding:12px 24px;font-size:14px;line-height:1.55;color:#1f2937;">' + interp(b.html || '') + '</td></tr>';
      }
      if (t === 'button') {
        // Default/unset color inherits the scope accent (mirrors the server).
        var bc = String(b.bg_color || '').toLowerCase();
        var bg = (!bc || bc === '#4f8cff') ? accent : (/^#[0-9a-f]{3,8}$/i.test(bc) ? b.bg_color : accent);
        return '<tr><td style="padding:18px 24px;text-align:center;"><a href="' + escapeAttr(interp(b.url || '#')) + '" style="display:inline-block;background:' + bg + ';color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;font-size:15px;">' + interp(b.label || 'Click') + '</a></td></tr>';
      }
      if (t === 'spacer') {
        var h = Math.max(4, Math.min(120, Number(b.height_px) || 16));
        return '<tr><td style="padding:0;line-height:0;font-size:0;"><div style="height:' + h + 'px;">&nbsp;</div></td></tr>';
      }
      if (t === 'image') {
        if (!b.url) return '';
        var max = Math.max(80, Math.min(900, Number(b.max_width_px) || 560));
        return '<tr><td style="padding:12px 24px;text-align:center;"><img src="' + escapeAttr(interp(b.url)) + '" alt="' + escapeAttr(b.alt || '') + '" style="max-width:' + max + 'px;width:100%;height:auto;border-radius:4px;display:inline-block;" /></td></tr>';
      }
      if (t === 'footer') {
        hasFooter = true;
        return footerRow(b.address || '');
      }
      return '';
    }).join('');
    if (!hasFooter) rows += footerRow('');
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;">' + rows + '</table>';
  }

  window.p86EmailBlocks = { mount: mount, renderBlocksToHtml: renderBlocksToHtml };
})();
