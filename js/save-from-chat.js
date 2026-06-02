// ──────────────────────────────────────────────────────────────────
// Save-from-chat bridge (Workstream ③).
//
// Adds a "Save to…" affordance to AI chat output so anything 86
// generates in the Ask-86 panel can be written straight to:
//   • Attachments — a folder under any entity (job / project / client /
//     lead / estimate / sub / task) or the user's personal My Files
//     (entity_type='user'). Text is wrapped client-side into a
//     Blob→File and POSTed via window.p86Api.attachments.upload.
//   • Field tools — when the block looks like a full HTML document, it
//     can be saved as a field tool via POST /api/field-tools.
//
// No server changes: the attachments multipart endpoint already accepts
// a `folder` form field, and the field-tools POST already exists with
// friendly duplicate-name (409) / 500KB / category validation.
//
// This module owns three globals invoked by inline onclick handlers
// emitted from ai-panel.js renderMarkdown / renderBubble:
//   window.p86SaveCodeBlock(btn)  — save one fenced code block
//   window.p86SaveResponse(btn)   — save a whole assistant message
//   window.p86SaveToPicker(opts)  — open the target-picker modal
// ──────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  // Fence language → file extension. Drives the default extension on
  // the attachment filename and whether the field-tool target is
  // offered (full-HTML detection is separate, below).
  var EXT_BY_LANG = {
    html: 'html', htm: 'html', xml: 'xml', svg: 'svg',
    json: 'json', json5: 'json', sql: 'sql',
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js',
    ts: 'ts', typescript: 'ts', tsx: 'ts',
    css: 'css', scss: 'css',
    md: 'md', markdown: 'md',
    yaml: 'yml', yml: 'yml',
    csv: 'csv', tsv: 'csv',
    sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
    py: 'py', python: 'py',
    txt: 'txt', text: 'txt'
  };

  var MIME_BY_EXT = {
    html: 'text/html', xml: 'application/xml', svg: 'image/svg+xml',
    json: 'application/json', sql: 'application/sql',
    js: 'text/javascript', ts: 'text/plain', css: 'text/css',
    md: 'text/markdown', yml: 'text/yaml', csv: 'text/csv',
    sh: 'text/x-shellscript', py: 'text/x-python', txt: 'text/plain'
  };

  // Extensions offered in the dropdown (inferred one floats to the top
  // via the default-selected logic in buildModal).
  var EXT_CHOICES = ['txt', 'md', 'html', 'json', 'js', 'ts', 'css', 'sql', 'csv', 'yml', 'xml', 'sh', 'py'];

  // Entity types you can attach to. 'user' = personal My Files.
  var ENTITY_TYPES = [
    { value: 'user', label: 'My Files (personal)' },
    { value: 'job', label: 'Job' },
    { value: 'project', label: 'Project' },
    { value: 'client', label: 'Client' },
    { value: 'lead', label: 'Lead' },
    { value: 'estimate', label: 'Estimate' },
    { value: 'sub', label: 'Sub / Vendor' },
    { value: 'task', label: 'Task' }
  ];

  var FT_CATEGORIES = ['calculator', 'lookup', 'form', 'other'];

  function api() { return window.p86Api; }

  function currentUser() {
    try {
      return (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
    } catch (e) { return null; }
  }

  function inferExt(lang) {
    if (!lang) return 'txt';
    return EXT_BY_LANG[String(lang).toLowerCase().trim()] || 'txt';
  }

  // True when the text reads as a complete HTML document — the only
  // case where a field tool makes sense (the tool runner iframes the
  // body as a standalone page).
  function looksLikeFullHtml(text) {
    if (!text) return false;
    var head = String(text).slice(0, 600).toLowerCase();
    return head.indexOf('<!doctype') !== -1 || /<html[\s>]/.test(head);
  }

  function toast(msg) {
    if (typeof window.p86Toast === 'function') { try { window.p86Toast(msg); return; } catch (e) {} }
  }

  // Client-side folder sanitize mirrors the server (max 3 levels,
  // lowercased, spaces→hyphens) so the datalist + preview match what
  // actually gets stored. The server re-sanitizes regardless.
  function sanitizeFolder(name) {
    var raw = String(name || '').trim().slice(0, 180);
    var segs = raw.split('/').map(function (s) {
      return s.trim().slice(0, 60).toLowerCase()
        .replace(/[^a-z0-9 _\-]/g, '').replace(/\s+/g, '-');
    }).filter(Boolean).slice(0, 3);
    return segs.join('/') || 'general';
  }

  // Fetch a list of selectable entities for a type → [{id,label}].
  // Tolerant of response envelope shape + missing label fields; always
  // resolves (never rejects) so the picker degrades gracefully offline.
  function fetchEntities(type) {
    var a = api();
    if (!a) return Promise.resolve([]);
    function pick(r, keys) {
      if (Array.isArray(r)) return r;
      for (var i = 0; i < keys.length; i++) { if (Array.isArray(r && r[keys[i]])) return r[keys[i]]; }
      return [];
    }
    function map(rows, labelFn) {
      return (rows || []).map(function (row) {
        return { id: row.id, label: String(labelFn(row) || ('#' + row.id)).slice(0, 80) };
      }).filter(function (e) { return e.id != null; });
    }
    var p;
    try {
      switch (type) {
        case 'job':
          p = a.jobs.list().then(function (r) { return map(pick(r, ['jobs']), function (j) { return j.name || j.job_name || j.title || j.client_name; }); });
          break;
        case 'project':
          p = a.projects.list().then(function (r) { return map(pick(r, ['projects']), function (x) { return x.name || x.title; }); });
          break;
        case 'client':
          p = a.clients.list().then(function (r) { return map(pick(r, ['clients']), function (c) { return c.name || c.company || [c.first_name, c.last_name].filter(Boolean).join(' '); }); });
          break;
        case 'lead':
          p = a.leads.list().then(function (r) { return map(pick(r, ['leads']), function (l) { return l.name || l.client_name || l.address; }); });
          break;
        case 'estimate':
          p = a.estimates.list().then(function (r) { return map(pick(r, ['estimates']), function (e) { return e.name || e.title || e.client_name; }); });
          break;
        case 'sub':
          p = a.subs.list().then(function (r) { return map(pick(r, ['subs']), function (s) { return s.name || s.company; }); });
          break;
        case 'task':
          p = a.tasks.list().then(function (r) { return map(pick(r, ['tasks']), function (t) { return t.title || t.name; }); });
          break;
        default:
          p = Promise.resolve([]);
      }
    } catch (e) { p = Promise.resolve([]); }
    return p.then(function (list) { return list; }, function () { return []; });
  }

  // Existing folders for an entity → distinct list for the datalist.
  function fetchFolders(type, id) {
    var a = api();
    if (!a || id == null) return Promise.resolve([]);
    return a.attachments.list(type, String(id)).then(function (r) {
      var rows = Array.isArray(r) ? r : (r && r.attachments) || [];
      var seen = {};
      rows.forEach(function (row) { var f = row && row.folder; if (f) seen[f] = 1; });
      return Object.keys(seen).sort();
    }, function () { return []; });
  }

  // ── Modal ──────────────────────────────────────────────────────
  var _overlay = null;

  function closeModal() {
    if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
    _overlay = null;
    document.removeEventListener('keydown', onKeydown, true);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
  }

  function el(tag, css, html) {
    var n = document.createElement(tag);
    if (css) n.setAttribute('style', css);
    if (html != null) n.innerHTML = html;
    return n;
  }

  function buildModal(opts) {
    closeModal();
    var content = String(opts.content || '');
    var lang = opts.lang || '';
    var canFieldTool = looksLikeFullHtml(content);
    var defExt = inferExt(lang);

    _overlay = el('div', 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.55);' +
      'display:flex;align-items:center;justify-content:center;padding:16px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;');
    _overlay.addEventListener('click', function (e) { if (e.target === _overlay) closeModal(); });

    var card = el('div', 'width:440px;max-width:100%;max-height:88vh;overflow-y:auto;' +
      'background:var(--surface,#1c2128);color:var(--text,#e6edf3);' +
      'border:1px solid var(--border,rgba(255,255,255,0.12));border-radius:14px;' +
      'box-shadow:0 18px 60px rgba(0,0,0,0.5);padding:0;');
    _overlay.appendChild(card);

    // Header
    var head = el('div', 'display:flex;align-items:center;justify-content:space-between;' +
      'padding:14px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,0.10));');
    head.appendChild(el('div', 'font-size:14px;font-weight:600;', '💾 Save to…'));
    var x = el('button', 'background:none;border:none;color:var(--text-dim,#888);font-size:20px;' +
      'cursor:pointer;line-height:1;padding:0 4px;', '×');
    x.setAttribute('type', 'button');
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closeModal);
    head.appendChild(x);
    card.appendChild(head);

    var body = el('div', 'padding:14px 16px;');
    card.appendChild(body);

    // Source summary
    var chars = content.length;
    var summary = chars > 1024 ? (Math.round(chars / 102.4) / 10) + ' KB' : chars + ' chars';
    body.appendChild(el('div', 'font-size:11px;color:var(--text-dim,#8b949e);margin-bottom:12px;',
      escapeAttr(summary + (lang ? ' · ' + lang : ' · text') + (canFieldTool ? ' · looks like full HTML' : ''))));

    // Target tabs
    var tabs = el('div', 'display:flex;gap:6px;margin-bottom:14px;');
    var tabAtt = mkTab('Attachment', true);
    var tabFt = mkTab('Field tool', false);
    if (!canFieldTool) {
      tabFt.disabled = true;
      tabFt.style.opacity = '0.4';
      tabFt.style.cursor = 'not-allowed';
      tabFt.title = 'Only available for a full HTML document';
    }
    tabs.appendChild(tabAtt);
    tabs.appendChild(tabFt);
    body.appendChild(tabs);

    var paneAtt = el('div', '');
    var paneFt = el('div', 'display:none;');
    body.appendChild(paneAtt);
    body.appendChild(paneFt);

    function mkTab(label, active) {
      var b = el('button', tabStyle(active), label);
      b.setAttribute('type', 'button');
      return b;
    }
    function tabStyle(active) {
      return 'flex:1;padding:8px 10px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;' +
        'font-family:inherit;border:1px solid ' + (active ? 'var(--accent,#4f8cff)' : 'var(--border,rgba(255,255,255,0.12))') + ';' +
        'background:' + (active ? 'rgba(79,140,255,0.16)' : 'transparent') + ';' +
        'color:' + (active ? 'var(--accent,#4f8cff)' : 'var(--text,#e6edf3)') + ';';
    }
    function selectTab(which) {
      var att = which === 'att';
      tabAtt.setAttribute('style', tabStyle(att));
      tabFt.setAttribute('style', tabStyle(!att) + (tabFt.disabled ? 'opacity:0.4;cursor:not-allowed;' : ''));
      paneAtt.style.display = att ? '' : 'none';
      paneFt.style.display = att ? 'none' : '';
    }
    tabAtt.addEventListener('click', function () { selectTab('att'); });
    tabFt.addEventListener('click', function () { if (!tabFt.disabled) selectTab('ft'); });

    // ── Attachment pane ──
    var lblCss = 'display:block;font-size:11px;font-weight:600;color:var(--text-dim,#8b949e);margin:0 0 4px;';
    var inputCss = 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;font-size:13px;' +
      'background:var(--surface-2,rgba(255,255,255,0.05));color:var(--text,#e6edf3);' +
      'border:1px solid var(--border,rgba(255,255,255,0.14));font-family:inherit;margin-bottom:12px;';

    paneAtt.appendChild(el('label', lblCss, 'Where'));
    var selType = el('select', inputCss);
    ENTITY_TYPES.forEach(function (t) {
      var o = document.createElement('option'); o.value = t.value; o.textContent = t.label; selType.appendChild(o);
    });
    paneAtt.appendChild(selType);

    var itemWrap = el('div', '');
    itemWrap.appendChild(el('label', lblCss, 'Item'));
    var selItem = el('select', inputCss);
    itemWrap.appendChild(selItem);
    paneAtt.appendChild(itemWrap);

    paneAtt.appendChild(el('label', lblCss, 'Folder'));
    var folderInput = el('input', inputCss);
    folderInput.setAttribute('type', 'text');
    folderInput.setAttribute('placeholder', 'general');
    folderInput.setAttribute('list', 'p86sfc-folders');
    folderInput.value = 'general';
    var datalist = el('datalist', '');
    datalist.id = 'p86sfc-folders';
    paneAtt.appendChild(folderInput);
    paneAtt.appendChild(datalist);

    paneAtt.appendChild(el('label', lblCss, 'Filename'));
    var nameRow = el('div', 'display:flex;gap:8px;align-items:flex-start;');
    var fileInput = el('input', inputCss + 'flex:1;margin-bottom:0;');
    fileInput.setAttribute('type', 'text');
    fileInput.value = opts.suggestedName || (opts.kind === 'response' ? '86-response' : '86-output');
    var extSel = el('select', inputCss + 'width:88px;margin-bottom:0;');
    var extList = EXT_CHOICES.slice();
    if (extList.indexOf(defExt) === -1) extList.unshift(defExt);
    extList.forEach(function (ex) {
      var o = document.createElement('option'); o.value = ex; o.textContent = '.' + ex;
      if (ex === defExt) o.selected = true;
      extSel.appendChild(o);
    });
    nameRow.appendChild(fileInput);
    nameRow.appendChild(extSel);
    paneAtt.appendChild(nameRow);

    var attStatus = el('div', 'font-size:11px;margin:12px 0 0;min-height:14px;');
    paneAtt.appendChild(attStatus);

    var attBtn = el('button', primaryBtnCss(), 'Save attachment');
    attBtn.setAttribute('type', 'button');
    paneAtt.appendChild(attBtn);

    // Populate item list when type changes; refresh folder datalist.
    function refreshFolders() {
      var type = selType.value;
      var id = (type === 'user') ? (currentUser() && currentUser().id) : selItem.value;
      datalist.innerHTML = '';
      if (id == null || id === '') return;
      fetchFolders(type, id).then(function (folders) {
        datalist.innerHTML = '';
        folders.forEach(function (f) {
          var o = document.createElement('option'); o.value = f; datalist.appendChild(o);
        });
      });
    }
    function refreshItems() {
      var type = selType.value;
      if (type === 'user') {
        itemWrap.style.display = 'none';
        refreshFolders();
        return;
      }
      itemWrap.style.display = '';
      selItem.innerHTML = '<option value="">Loading…</option>';
      fetchEntities(type).then(function (list) {
        selItem.innerHTML = '';
        if (!list.length) {
          var o = document.createElement('option'); o.value = ''; o.textContent = '(none found)'; selItem.appendChild(o);
        } else {
          list.forEach(function (e) {
            var o = document.createElement('option'); o.value = String(e.id); o.textContent = e.label; selItem.appendChild(o);
          });
        }
        refreshFolders();
      });
    }
    selType.addEventListener('change', refreshItems);
    selItem.addEventListener('change', refreshFolders);

    attBtn.addEventListener('click', function () {
      var type = selType.value;
      var id = (type === 'user') ? (currentUser() && currentUser().id) : selItem.value;
      if (id == null || id === '') {
        setStatus(attStatus, (type === 'user') ? 'Not signed in — cannot resolve your My Files.' : 'Pick an item to attach to.', true);
        return;
      }
      var folder = sanitizeFolder(folderInput.value);
      var ext = extSel.value || 'txt';
      var base = String(fileInput.value || '').trim().replace(/\.[a-z0-9]+$/i, '') || '86-output';
      var filename = base + '.' + ext;
      var mime = MIME_BY_EXT[ext] || 'text/plain';
      var file;
      try {
        file = new File([content], filename, { type: mime });
      } catch (e) {
        var blob = new Blob([content], { type: mime });
        blob.name = filename; file = blob;
      }
      attBtn.disabled = true;
      setStatus(attStatus, 'Saving…', false);
      api().attachments.upload(type, String(id), file, { folder: folder, geo: false }).then(function () {
        var label = ENTITY_TYPES.filter(function (t) { return t.value === type; })[0];
        setStatus(attStatus, '✓ Saved to ' + (label ? label.label : type) + ' / ' + folder + ' / ' + filename, false, true);
        toast('Saved ' + filename + ' to ' + folder);
        setTimeout(closeModal, 1300);
      }, function (err) {
        attBtn.disabled = false;
        setStatus(attStatus, '✗ ' + ((err && err.message) || 'Upload failed'), true);
      });
    });

    // ── Field-tool pane ──
    paneFt.appendChild(el('label', lblCss, 'Tool name'));
    var ftName = el('input', inputCss);
    ftName.setAttribute('type', 'text');
    ftName.setAttribute('placeholder', 'e.g. Stair Stringer Calculator');
    ftName.value = opts.suggestedName ? '' : '';
    paneFt.appendChild(ftName);

    paneFt.appendChild(el('label', lblCss, 'Description (optional)'));
    var ftDesc = el('input', inputCss);
    ftDesc.setAttribute('type', 'text');
    ftDesc.setAttribute('placeholder', 'What does this tool do?');
    paneFt.appendChild(ftDesc);

    paneFt.appendChild(el('label', lblCss, 'Category'));
    var ftCat = el('select', inputCss);
    FT_CATEGORIES.forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c.charAt(0).toUpperCase() + c.slice(1);
      if (c === 'other') o.selected = true;
      ftCat.appendChild(o);
    });
    paneFt.appendChild(ftCat);

    var ftStatus = el('div', 'font-size:11px;margin:12px 0 0;min-height:14px;');
    paneFt.appendChild(ftStatus);

    var ftBtn = el('button', primaryBtnCss(), 'Save as field tool');
    ftBtn.setAttribute('type', 'button');
    paneFt.appendChild(ftBtn);

    ftBtn.addEventListener('click', function () {
      var name = String(ftName.value || '').trim();
      if (!name) { setStatus(ftStatus, 'Tool name is required.', true); ftName.focus(); return; }
      if (content.length > 500 * 1024) { setStatus(ftStatus, 'Too large — field tools cap at 500KB.', true); return; }
      ftBtn.disabled = true;
      setStatus(ftStatus, 'Saving…', false);
      api().post('/api/field-tools', {
        name: name,
        description: String(ftDesc.value || '').trim() || null,
        category: ftCat.value,
        html_body: content
      }).then(function () {
        setStatus(ftStatus, '✓ Saved field tool "' + name + '"', false, true);
        toast('Field tool "' + name + '" saved');
        setTimeout(closeModal, 1300);
      }, function (err) {
        ftBtn.disabled = false;
        setStatus(ftStatus, '✗ ' + ((err && err.message) || 'Save failed'), true);
      });
    });

    function primaryBtnCss() {
      return 'width:100%;margin-top:14px;padding:10px;border-radius:9px;border:none;cursor:pointer;' +
        'font-size:13px;font-weight:600;font-family:inherit;background:var(--accent,#4f8cff);color:#fff;';
    }
    function setStatus(node, msg, isErr, isOk) {
      node.textContent = msg;
      node.style.color = isErr ? '#ff6b6b' : (isOk ? '#3fb950' : 'var(--text-dim,#8b949e)');
    }

    document.body.appendChild(_overlay);
    document.addEventListener('keydown', onKeydown, true);
    selectTab('att');
    refreshItems();
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Public entry points (called from ai-panel.js inline onclick) ──

  // Open the picker for a chunk of content. opts:
  //   { content, lang?, kind?: 'block'|'response', suggestedName? }
  window.p86SaveToPicker = function (opts) {
    opts = opts || {};
    if (!opts.content || !String(opts.content).trim()) return;
    if (!api()) { toast('Save is unavailable offline.'); return; }
    buildModal(opts);
  };

  // Save a single fenced code block. Reads the exact code text from the
  // <code> element (un-escaped textContent) + the fence language stashed
  // on the .p86-codeblock wrapper by renderMarkdown.
  window.p86SaveCodeBlock = function (btn) {
    if (!btn) return;
    var wrap = btn.closest ? btn.closest('.p86-codeblock') : null;
    if (!wrap && btn.parentElement && btn.parentElement.classList && btn.parentElement.classList.contains('p86-codeblock')) wrap = btn.parentElement;
    var codeEl = wrap && wrap.querySelector('pre code');
    var content = codeEl ? codeEl.textContent : (wrap && wrap.querySelector('pre') ? wrap.querySelector('pre').textContent : '');
    var lang = wrap ? (wrap.getAttribute('data-lang') || '') : '';
    if (!content) return;
    window.p86SaveToPicker({ content: content, lang: lang, kind: 'block' });
  };

  // Save a whole assistant message. The raw markdown is stashed
  // URI-encoded on the button's data-raw attribute (safe for HTML attrs
  // — no quotes/angle-brackets/ampersands survive encodeURIComponent),
  // so we recover the faithful source rather than rendered textContent.
  window.p86SaveResponse = function (btn) {
    if (!btn) return;
    var raw = btn.getAttribute('data-raw') || '';
    var content = '';
    try { content = raw ? decodeURIComponent(raw) : ''; } catch (e) { content = ''; }
    if (!content) {
      // Fallback: nearest .ai-content rendered text.
      var bubble = btn.closest ? btn.closest('div') : null;
      var ai = bubble ? bubble.querySelector('.ai-content') : null;
      if (ai) content = ai.textContent || '';
    }
    if (!content) return;
    window.p86SaveToPicker({ content: content, lang: 'md', kind: 'response', suggestedName: '86-response' });
  };
})();
