// Shared Explorer-style file system component.
//
//   window.p86Explorer.mount(host, { entityType, entityId, canEdit, role })
//     → { refresh, destroy }
//
// One component, mounted on any entity bucket (user/job/client/project/
// lead/estimate). Real folders come from p86Api.fileFolders; files from
// p86Api.attachments. Preview/annotate/upload reuse the existing modules
// (p86Attachments.openLightbox, p86Markup.open, p86Api.attachments.upload)
// so nothing about viewing/markup changes — only the browsing UX does.
//
// Windows-Explorer affordances: folder tree, breadcrumb path, list + grid
// views, sort, multi-select + bulk actions, new/rename/delete folders,
// move files (drag-drop, cut/paste, or the Move dialog), right-click
// context menus, in-folder search.

(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function api() { return window.p86Api; }
  function toast(m, k) { if (window.p86Toast && window.p86Toast.show) window.p86Toast.show(m, k); else if (k === 'error') console.error('[explorer]', m); }

  var STYLE_ID = 'p86fx-styles';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.p86fx{display:flex;flex-direction:column;height:100%;min-height:calc(100dvh - 160px);font-size:13px;}' +
      '.p86fx-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 4px;border-bottom:1px solid var(--border,#2e3346);}' +
      '.p86fx-btn{font:inherit;font-size:12.5px;padding:6px 10px;border-radius:8px;border:1px solid var(--border,#2e3346);background:var(--surface,#181820);color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}' +
      '.p86fx-btn:hover{background:var(--hover,#23232e);}' +
      '.p86fx-btn.primary{background:var(--accent,#22d3ee);border-color:var(--accent,#22d3ee);color:#06141a;font-weight:600;}' +
      '.p86fx-crumbs{display:flex;align-items:center;gap:2px;flex:1 1 200px;min-width:0;flex-wrap:wrap;font-size:13px;}' +
      '.p86fx-crumb{padding:3px 7px;border-radius:6px;cursor:pointer;color:var(--text,#e5e7eb);white-space:nowrap;}' +
      '.p86fx-crumb:hover{background:var(--hover,#23232e);}' +
      '.p86fx-crumb.drop-ok{outline:2px dashed var(--accent,#22d3ee);}' +
      '.p86fx-crumb-sep{color:var(--muted,#6b7280);}' +
      '.p86fx-search{font:inherit;font-size:12.5px;padding:6px 9px;border-radius:8px;border:1px solid var(--border,#2e3346);background:var(--surface,#181820);color:inherit;width:160px;}' +
      '.p86fx-body{display:flex;flex:1 1 0;min-height:0;}' +
      '.p86fx-tree{flex:0 0 210px;overflow:auto;border-right:1px solid var(--border,#2e3346);padding:6px 4px;}' +
      '@media(max-width:760px){.p86fx-tree{display:none;}}' +
      '.p86fx-tnode{display:flex;align-items:center;gap:2px;padding:4px 6px;border-radius:6px;cursor:pointer;white-space:nowrap;color:var(--text,#e5e7eb);}' +
      '.p86fx-tnode:hover{background:var(--hover,#23232e);}' +
      '.p86fx-tnode.active{background:rgba(34,211,238,0.14);}' +
      '.p86fx-tnode.drop-ok{outline:2px dashed var(--accent,#22d3ee);outline-offset:-2px;}' +
      '.p86fx-tcaret{width:14px;text-align:center;color:var(--muted,#6b7280);flex:0 0 auto;}' +
      '.p86fx-tlabel{overflow:hidden;text-overflow:ellipsis;}' +
      '.p86fx-main{flex:1 1 0;min-width:0;display:flex;flex-direction:column;overflow:hidden;}' +
      '.p86fx-selbar{display:flex;align-items:center;gap:10px;padding:7px 10px;background:rgba(34,211,238,0.10);border-bottom:1px solid var(--border,#2e3346);font-size:12.5px;}' +
      '.p86fx-items{flex:1 1 0;overflow:auto;padding:8px;}' +
      '.p86fx-items.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;align-content:start;}' +
      '.p86fx-items.list{display:flex;flex-direction:column;gap:1px;}' +
      // grid tiles
      '.p86fx-tile{position:relative;border:1px solid var(--border,#2e3346);border-radius:10px;overflow:hidden;cursor:pointer;background:var(--surface,#181820);}' +
      '.p86fx-tile.sel{outline:2px solid var(--accent,#22d3ee);border-color:var(--accent,#22d3ee);}' +
      '.p86fx-tile.drop-ok{outline:2px dashed var(--accent,#22d3ee);}' +
      '.p86fx-thumb{aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;background:var(--bg,#0f0f15);font-size:34px;color:var(--muted,#6b7280);overflow:hidden;}' +
      '.p86fx-thumb img{width:100%;height:100%;object-fit:cover;}' +
      '.p86fx-cap{padding:6px 8px;font-size:11.5px;line-height:1.3;word-break:break-word;border-top:1px solid var(--border,#2e3346);}' +
      '.p86fx-cap .nm{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.p86fx-cap .mt{color:var(--muted,#6b7280);font-size:10.5px;}' +
      '.p86fx-folder .p86fx-thumb{color:var(--accent,#22d3ee);}' +
      '.p86fx-check{position:absolute;top:6px;left:6px;width:18px;height:18px;z-index:2;}' +
      // list rows
      '.p86fx-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent;}' +
      '.p86fx-row:hover{background:var(--hover,#23232e);}' +
      '.p86fx-row.sel{background:rgba(34,211,238,0.12);}' +
      '.p86fx-row.drop-ok{outline:2px dashed var(--accent,#22d3ee);}' +
      '.p86fx-row .ic{flex:0 0 auto;width:22px;text-align:center;}' +
      '.p86fx-row .nm{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.p86fx-row .meta{flex:0 0 auto;color:var(--muted,#6b7280);font-size:11.5px;}' +
      '.p86fx-empty{padding:36px 12px;text-align:center;color:var(--muted,#6b7280);}' +
      // context menu
      '.p86fx-menu{position:fixed;z-index:9999;min-width:170px;background:var(--surface,#1b1b24);border:1px solid var(--border,#2e3346);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.4);padding:5px;font-size:13px;}' +
      '.p86fx-menu button{display:flex;width:100%;text-align:left;gap:8px;align-items:center;font:inherit;font-size:13px;padding:7px 10px;border:none;background:transparent;color:inherit;border-radius:7px;cursor:pointer;}' +
      '.p86fx-menu button:hover{background:var(--hover,#23232e);}' +
      '.p86fx-menu button.danger{color:#f87171;}' +
      '.p86fx-menu .sep{height:1px;background:var(--border,#2e3346);margin:4px 2px;}' +
      // name dialog
      '.p86fx-modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;}' +
      '.p86fx-modal-box{background:var(--surface,#1b1b24);border:1px solid var(--border,#2e3346);border-radius:12px;padding:16px;width:min(420px,92vw);}' +
      '.p86fx-modal-box h4{margin:0 0 10px;font-size:15px;}' +
      '.p86fx-modal-box input{width:100%;font:inherit;padding:9px 11px;border-radius:8px;border:1px solid var(--border,#2e3346);background:var(--bg,#0f0f15);color:inherit;}' +
      '.p86fx-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}' +
      '.p86fx-modal .pick-list{max-height:46vh;overflow:auto;margin-top:8px;border:1px solid var(--border,#2e3346);border-radius:8px;}' +
      '.p86fx-modal .pick-row{padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border,#2e3346);}' +
      '.p86fx-modal .pick-row:hover{background:var(--hover,#23232e);}';
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ── Small name/confirm dialogs (Promise-based) ─────────────────────
  function askName(title, initial) {
    return new Promise(function (resolve) {
      var m = document.createElement('div');
      m.className = 'p86fx-modal';
      m.innerHTML = '<div class="p86fx-modal-box"><h4>' + esc(title) + '</h4>' +
        '<input type="text" value="' + esc(initial || '') + '" />' +
        '<div class="p86fx-modal-foot"><button class="p86fx-btn" data-x>Cancel</button>' +
        '<button class="p86fx-btn primary" data-ok>OK</button></div></div>';
      document.body.appendChild(m);
      var inp = m.querySelector('input');
      function done(v) { m.remove(); resolve(v); }
      m.querySelector('[data-x]').onclick = function () { done(null); };
      m.querySelector('[data-ok]').onclick = function () { done((inp.value || '').trim() || null); };
      m.addEventListener('click', function (e) { if (e.target === m) done(null); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); done((inp.value || '').trim() || null); } if (e.key === 'Escape') done(null); });
      setTimeout(function () { inp.focus(); inp.select(); }, 30);
    });
  }
  function confirmDlg(msg) {
    if (typeof window.p86Confirm === 'function') return window.p86Confirm({ title: 'Confirm', message: msg, danger: true });
    return Promise.resolve(window.confirm(msg));
  }

  function isImg(f) { return f && /^image\//i.test(f.mime_type || ''); }
  function isPdf(f) { return f && /pdf/i.test(f.mime_type || ''); }
  function fileGlyph(f) {
    if (isImg(f)) return '\u{1F5BC}';
    if (isPdf(f)) return '\u{1F4C4}';
    if (/sheet|excel|csv/i.test(f.mime_type || '')) return '\u{1F4CA}';
    if (/word|document/i.test(f.mime_type || '')) return '\u{1F4DD}';
    return '\u{1F4CE}';
  }
  function fmtBytes(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s); if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; }
  }

  function mount(host, opts) {
    opts = opts || {};
    if (!host) return { refresh: function () {}, destroy: function () {} };
    ensureStyles();
    var S = {
      et: opts.entityType,
      eid: String(opts.entityId),
      canEdit: opts.canEdit !== false,
      folders: [],
      files: [],
      cur: null,            // current folder id (null = root)
      view: 'grid',
      sort: 'name',
      query: '',
      sel: {},              // selected file ids
      expanded: {},         // folder id → true
      clip: null            // { ids:[], op:'cut' }
    };

    function folderById(id) { for (var i = 0; i < S.folders.length; i++) if (S.folders[i].id === id) return S.folders[i]; return null; }
    function childFolders(pid) { return S.folders.filter(function (f) { return (f.parent_id || null) === (pid || null); }); }
    function curPath() { var f = S.cur ? folderById(S.cur) : null; return f ? f.path : ''; }
    function filesIn(pid) {
      return S.files.filter(function (f) { return (f.folder_id || null) === (pid || null); });
    }

    function load() {
      var a = api();
      if (!a) { host.innerHTML = '<div class="p86fx-empty">Not connected.</div>'; return Promise.resolve(); }
      return Promise.all([
        a.fileFolders.tree(S.et, S.eid).then(function (r) { return (r && r.folders) || []; }).catch(function () { return []; }),
        a.attachments.list(S.et, S.eid).then(function (r) { return (r && r.attachments) || []; }).catch(function () { return []; })
      ]).then(function (out) {
        S.folders = out[0];
        S.files = out[1];
        // prune selection to existing files
        var ok = {}; S.files.forEach(function (f) { ok[f.id] = 1; });
        Object.keys(S.sel).forEach(function (id) { if (!ok[id]) delete S.sel[id]; });
        render();
      });
    }

    // ── Rendering ────────────────────────────────────────────────────
    function render() {
      // Stale-guard: the host may have been taken over by another view
      // (e.g. a My Files virtual folder) while our async load was in
      // flight. Bail so we don't clobber it.
      if (opts.shouldRender && !opts.shouldRender()) return;
      var canEdit = S.canEdit;
      host.innerHTML =
        '<div class="p86fx" data-view="' + S.view + '">' +
          '<div class="p86fx-toolbar">' +
            (canEdit ? '<button class="p86fx-btn" data-act="newfolder">\u{1F4C1}+ New folder</button>' : '') +
            (canEdit ? '<button class="p86fx-btn primary" data-act="upload">↑ Upload</button>' : '') +
            '<span class="p86fx-crumbs" data-crumbs></span>' +
            '<input class="p86fx-search" placeholder="Search this folder…" data-search value="' + esc(S.query) + '" />' +
            '<button class="p86fx-btn" data-act="view" title="Toggle list / grid">' + (S.view === 'grid' ? '☰ List' : '▦ Grid') + '</button>' +
            '<select class="p86fx-search" data-sort style="width:auto;">' +
              '<option value="name"' + (S.sort === 'name' ? ' selected' : '') + '>Name</option>' +
              '<option value="date"' + (S.sort === 'date' ? ' selected' : '') + '>Newest</option>' +
              '<option value="size"' + (S.sort === 'size' ? ' selected' : '') + '>Size</option>' +
            '</select>' +
            (canEdit ? '<input type="file" multiple style="display:none;" data-fileinput />' : '') +
          '</div>' +
          '<div class="p86fx-body">' +
            '<div class="p86fx-tree" data-tree></div>' +
            '<div class="p86fx-main">' +
              '<div class="p86fx-selbar" data-selbar style="display:none;"></div>' +
              '<div class="p86fx-items ' + S.view + '" data-items></div>' +
            '</div>' +
          '</div>' +
        '</div>';
      renderCrumbs();
      renderTree();
      renderItems();
      wireToolbar();
    }

    function renderCrumbs() {
      var host2 = host.querySelector('[data-crumbs]');
      var chain = [];
      var f = S.cur ? folderById(S.cur) : null;
      while (f) { chain.unshift(f); f = f.parent_id ? folderById(f.parent_id) : null; }
      var html = '<span class="p86fx-crumb" data-go="" data-drop="">\u{1F3E0} Home</span>';
      chain.forEach(function (node) {
        html += '<span class="p86fx-crumb-sep">›</span>' +
          '<span class="p86fx-crumb" data-go="' + esc(node.id) + '" data-drop="' + esc(node.id) + '">' + esc(node.name) + '</span>';
      });
      host2.innerHTML = html;
      host2.querySelectorAll('[data-go]').forEach(function (el) {
        el.onclick = function () { S.cur = el.getAttribute('data-go') || null; S.sel = {}; render(); };
        wireFolderDrop(el, el.getAttribute('data-drop') || null);
      });
    }

    function renderTree() {
      var t = host.querySelector('[data-tree]');
      var html = '<div class="p86fx-tnode' + (!S.cur ? ' active' : '') + '" data-fid="" data-drop=""><span class="p86fx-tcaret"></span><span class="p86fx-tlabel">\u{1F3E0} Home</span></div>';
      function walk(pid, depth) {
        childFolders(pid).sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (f) {
          var kids = childFolders(f.id);
          var exp = !!S.expanded[f.id];
          var caret = kids.length ? (exp ? '▾' : '▸') : '';
          html += '<div class="p86fx-tnode' + (S.cur === f.id ? ' active' : '') + '" data-fid="' + esc(f.id) + '" data-drop="' + esc(f.id) + '" draggable="true" style="padding-left:' + (6 + depth * 14) + 'px;">' +
            '<span class="p86fx-tcaret" data-caret="' + esc(f.id) + '">' + caret + '</span>' +
            '<span class="p86fx-tlabel">\u{1F4C1} ' + esc(f.name) + '</span></div>';
          if (exp) walk(f.id, depth + 1);
        });
      }
      walk(null, 0);
      t.innerHTML = html;
      t.querySelectorAll('[data-fid]').forEach(function (el) {
        var fid = el.getAttribute('data-fid') || null;
        el.addEventListener('click', function (e) {
          if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-caret')) {
            S.expanded[fid] = !S.expanded[fid]; renderTree(); return;
          }
          S.cur = fid; S.sel = {}; render();
        });
        if (fid) wireFolderDrag(el, fid);
        wireFolderDrop(el, fid);
      });
    }

    function sortFiles(arr) {
      var a = arr.slice();
      if (S.sort === 'date') a.sort(function (x, y) { return new Date(y.uploaded_at || 0) - new Date(x.uploaded_at || 0); });
      else if (S.sort === 'size') a.sort(function (x, y) { return (y.size_bytes || 0) - (x.size_bytes || 0); });
      else a.sort(function (x, y) { return String(x.filename || '').localeCompare(String(y.filename || '')); });
      return a;
    }

    function renderItems() {
      var box = host.querySelector('[data-items]');
      var subs = childFolders(S.cur).sort(function (a, b) { return a.name.localeCompare(b.name); });
      var files = sortFiles(filesIn(S.cur));
      if (S.query) {
        var q = S.query.toLowerCase();
        subs = subs.filter(function (f) { return f.name.toLowerCase().indexOf(q) >= 0; });
        files = files.filter(function (f) { return String(f.filename || '').toLowerCase().indexOf(q) >= 0 || String(f.caption || '').toLowerCase().indexOf(q) >= 0; });
      }
      if (!subs.length && !files.length) {
        box.innerHTML = '<div class="p86fx-empty">' + (S.query ? 'Nothing matches “' + esc(S.query) + '”.' : 'This folder is empty.' + (S.canEdit ? ' Drop files here or use Upload.' : '')) + '</div>';
        wireItemEvents();
        return;
      }
      var html = '';
      if (S.view === 'grid') {
        subs.forEach(function (f) {
          html += '<div class="p86fx-tile p86fx-folder" data-folder="' + esc(f.id) + '" data-drop="' + esc(f.id) + '" draggable="true">' +
            '<div class="p86fx-thumb">\u{1F4C1}</div>' +
            '<div class="p86fx-cap"><span class="nm">' + esc(f.name) + '</span><span class="mt">Folder</span></div></div>';
        });
        files.forEach(function (f) {
          var sel = S.sel[f.id] ? ' sel' : '';
          var thumb = isImg(f) && f.thumb_url ? '<img src="' + esc(f.thumb_url) + '" alt="" loading="lazy" />' : fileGlyph(f);
          html += '<div class="p86fx-tile' + sel + '" data-file="' + esc(f.id) + '" draggable="true">' +
            '<input type="checkbox" class="p86fx-check" data-check="' + esc(f.id) + '"' + (S.sel[f.id] ? ' checked' : '') + ' />' +
            '<div class="p86fx-thumb">' + thumb + '</div>' +
            '<div class="p86fx-cap"><span class="nm" title="' + esc(f.filename) + '">' + esc(f.filename) + '</span>' +
              '<span class="mt">' + esc(fmtBytes(f.size_bytes)) + (f.size_bytes ? ' · ' : '') + esc(fmtDate(f.uploaded_at)) + '</span></div></div>';
        });
      } else {
        subs.forEach(function (f) {
          html += '<div class="p86fx-row" data-folder="' + esc(f.id) + '" data-drop="' + esc(f.id) + '" draggable="true">' +
            '<span class="ic">\u{1F4C1}</span><span class="nm">' + esc(f.name) + '</span><span class="meta">Folder</span></div>';
        });
        files.forEach(function (f) {
          var sel = S.sel[f.id] ? ' sel' : '';
          html += '<div class="p86fx-row' + sel + '" data-file="' + esc(f.id) + '" draggable="true">' +
            '<input type="checkbox" data-check="' + esc(f.id) + '"' + (S.sel[f.id] ? ' checked' : '') + ' />' +
            '<span class="ic">' + fileGlyph(f) + '</span><span class="nm" title="' + esc(f.filename) + '">' + esc(f.filename) + '</span>' +
            '<span class="meta">' + esc(fmtBytes(f.size_bytes)) + '</span><span class="meta">' + esc(fmtDate(f.uploaded_at)) + '</span></div>';
        });
      }
      box.innerHTML = html;
      wireItemEvents();
      renderSelbar();
    }

    function renderSelbar() {
      var bar = host.querySelector('[data-selbar]');
      var n = Object.keys(S.sel).length;
      if (!n) { bar.style.display = 'none'; return; }
      bar.style.display = '';
      bar.innerHTML = '<strong>' + n + ' selected</strong>' +
        '<button class="p86fx-btn" data-bulk="move">Move to…</button>' +
        '<button class="p86fx-btn" data-bulk="cut">Cut</button>' +
        (S.clip && S.clip.ids.length ? '<button class="p86fx-btn" data-bulk="paste">Paste (' + S.clip.ids.length + ')</button>' : '') +
        '<button class="p86fx-btn" data-bulk="delete" style="color:#f87171;">Delete</button>' +
        '<button class="p86fx-btn" data-bulk="clear">Clear</button>';
      bar.querySelectorAll('[data-bulk]').forEach(function (b) {
        b.onclick = function () { bulk(b.getAttribute('data-bulk')); };
      });
    }

    // ── Event wiring ─────────────────────────────────────────────────
    function wireToolbar() {
      var tb = host.querySelector('.p86fx-toolbar');
      tb.querySelectorAll('[data-act]').forEach(function (b) {
        b.onclick = function () {
          var act = b.getAttribute('data-act');
          if (act === 'view') { S.view = S.view === 'grid' ? 'list' : 'grid'; render(); }
          else if (act === 'newfolder') doNewFolder();
          else if (act === 'upload') { var fi = host.querySelector('[data-fileinput]'); if (fi) fi.click(); }
        };
      });
      var search = tb.querySelector('[data-search]');
      if (search) search.oninput = function () { S.query = search.value || ''; renderItems(); };
      var sort = tb.querySelector('[data-sort]');
      if (sort) sort.onchange = function () { S.sort = sort.value; renderItems(); };
      var fi = tb.querySelector('[data-fileinput]');
      if (fi) fi.onchange = function () { doUpload(fi.files); fi.value = ''; };
      // paste shortcut + delete
      host.onkeydown = function (e) {
        if (!S.canEdit) return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); filesIn(S.cur).forEach(function (f) { S.sel[f.id] = 1; }); renderItems(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') { cutSelection(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { pasteClip(); }
        else if (e.key === 'Delete' && Object.keys(S.sel).length) { bulk('delete'); }
      };
    }

    function wireItemEvents() {
      var box = host.querySelector('[data-items]');
      // checkboxes
      box.querySelectorAll('[data-check]').forEach(function (c) {
        c.onclick = function (e) { e.stopPropagation(); var id = c.getAttribute('data-check'); if (c.checked) S.sel[id] = 1; else delete S.sel[id]; renderItems(); };
      });
      // folder open + drag/drop
      box.querySelectorAll('[data-folder]').forEach(function (el) {
        var fid = el.getAttribute('data-folder');
        el.addEventListener('dblclick', function () { S.cur = fid; S.sel = {}; render(); });
        el.addEventListener('click', function (e) { if (e.detail === 1 && S.view === 'list') { /* single click no-op */ } });
        el.addEventListener('contextmenu', function (e) { e.preventDefault(); folderMenu(e, fid); });
        wireFolderDrag(el, fid);
        wireFolderDrop(el, fid);
      });
      // file open + select + drag + menu
      box.querySelectorAll('[data-file]').forEach(function (el) {
        var id = el.getAttribute('data-file');
        el.addEventListener('click', function (e) {
          if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-check')) return;
          if (e.ctrlKey || e.metaKey) { if (S.sel[id]) delete S.sel[id]; else S.sel[id] = 1; renderItems(); return; }
          // plain click selects (single)
          S.sel = {}; S.sel[id] = 1; renderItems();
        });
        el.addEventListener('dblclick', function () { openFile(id); });
        el.addEventListener('contextmenu', function (e) { e.preventDefault(); fileMenu(e, id); });
        el.addEventListener('dragstart', function (e) {
          if (!S.sel[id]) { S.sel = {}; S.sel[id] = 1; renderItems(); }
          e.dataTransfer.setData('text/p86-files', Object.keys(S.sel).join(','));
          e.dataTransfer.effectAllowed = 'move';
        });
      });
      // drop onto empty area = move to current folder (no-op if same)
    }

    function wireFolderDrag(el, fid) {
      el.addEventListener('dragstart', function (e) {
        e.stopPropagation();
        e.dataTransfer.setData('text/p86-folder', fid);
        e.dataTransfer.effectAllowed = 'move';
      });
    }
    function wireFolderDrop(el, targetFolderId) {
      el.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop-ok'); });
      el.addEventListener('dragleave', function () { el.classList.remove('drop-ok'); });
      el.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation(); el.classList.remove('drop-ok');
        var files = e.dataTransfer.getData('text/p86-files');
        var folder = e.dataTransfer.getData('text/p86-folder');
        if (files) { moveFiles(files.split(',').filter(Boolean), targetFolderId); }
        else if (folder && folder !== targetFolderId) { moveFolder(folder, targetFolderId); }
      });
    }

    // ── Actions ──────────────────────────────────────────────────────
    function openFile(id) {
      var f = S.files.filter(function (x) { return x.id === id; })[0];
      if (!f) return;
      if (isImg(f)) {
        var imgs = sortFiles(filesIn(S.cur)).filter(isImg);
        var idx = imgs.findIndex(function (x) { return x.id === id; });
        if (window.p86Attachments && window.p86Attachments.openLightbox) { window.p86Attachments.openLightbox(imgs, Math.max(0, idx)); return; }
      }
      if ((isPdf(f) || isImg(f)) && window.p86Markup && window.p86Markup.open) {
        window.p86Markup.open({ attachment: f, onDone: load }); return;
      }
      if (f.original_url) window.open(f.original_url, '_blank', 'noopener');
    }

    function doNewFolder() {
      askName('New folder', '').then(function (name) {
        if (!name) return;
        api().fileFolders.create(S.et, S.eid, { name: name, parent_id: S.cur || null })
          .then(function () { load(); }).catch(function (e) { toast((e && e.message) || 'Could not create folder', 'error'); });
      });
    }
    function doUpload(fileList) {
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      var path = curPath() || 'general';
      var done = 0;
      toast('Uploading ' + files.length + ' file(s)…');
      (function next() {
        if (!files.length) { load(); toast(done + ' file(s) uploaded', 'success'); return; }
        var f = files.shift();
        api().attachments.upload(S.et, S.eid, f, { folder: path })
          .then(function () { done++; }).catch(function (e) { toast((e && e.message) || 'Upload failed', 'error'); })
          .then(next);
      })();
    }
    function moveFiles(ids, targetFolderId) {
      if (!ids.length) return;
      api().fileFolders.moveFiles(S.et, S.eid, ids, targetFolderId || null)
        .then(function () { S.sel = {}; load(); toast(ids.length + ' moved'); })
        .catch(function (e) { toast((e && e.message) || 'Move failed', 'error'); });
    }
    function moveFolder(folderId, targetFolderId) {
      api().fileFolders.update(S.et, S.eid, folderId, { parent_id: targetFolderId || null })
        .then(function () { load(); }).catch(function (e) { toast((e && e.message) || 'Move failed', 'error'); });
    }
    function cutSelection() {
      var ids = Object.keys(S.sel);
      if (!ids.length) return;
      S.clip = { ids: ids, op: 'cut' };
      toast(ids.length + ' file(s) cut — open a folder and Paste');
      renderSelbar();
    }
    function pasteClip() {
      if (!S.clip || !S.clip.ids.length) return;
      moveFiles(S.clip.ids, S.cur || null);
      S.clip = null;
    }
    function bulk(action) {
      var ids = Object.keys(S.sel);
      if (action === 'clear') { S.sel = {}; renderItems(); return; }
      if (action === 'cut') { cutSelection(); return; }
      if (action === 'paste') { pasteClip(); return; }
      if (!ids.length) return;
      if (action === 'delete') {
        confirmDlg('Delete ' + ids.length + ' file(s)? This cannot be undone.').then(function (ok) {
          if (!ok) return;
          Promise.all(ids.map(function (id) { return api().attachments.remove(id).catch(function () {}); }))
            .then(function () { S.sel = {}; load(); toast('Deleted'); });
        });
      } else if (action === 'move') {
        pickFolder('Move ' + ids.length + ' file(s) to…').then(function (fid) {
          if (fid === undefined) return; // cancelled
          moveFiles(ids, fid);
        });
      }
    }

    function pickFolder(title) {
      return new Promise(function (resolve) {
        var rows = '<div class="pick-row" data-pick="">\u{1F3E0} Home (root)</div>';
        S.folders.slice().sort(function (a, b) { return a.path.localeCompare(b.path); }).forEach(function (f) {
          rows += '<div class="pick-row" data-pick="' + esc(f.id) + '">\u{1F4C1} ' + esc(f.path) + '</div>';
        });
        var m = document.createElement('div');
        m.className = 'p86fx-modal';
        m.innerHTML = '<div class="p86fx-modal-box"><h4>' + esc(title) + '</h4><div class="pick-list">' + rows + '</div>' +
          '<div class="p86fx-modal-foot"><button class="p86fx-btn" data-x>Cancel</button></div></div>';
        document.body.appendChild(m);
        function done(v) { m.remove(); resolve(v); }
        m.querySelector('[data-x]').onclick = function () { done(undefined); };
        m.addEventListener('click', function (e) { if (e.target === m) done(undefined); });
        m.querySelectorAll('[data-pick]').forEach(function (r) {
          r.onclick = function () { done(r.getAttribute('data-pick') || null); };
        });
      });
    }

    // ── Context menus ────────────────────────────────────────────────
    function showMenu(e, items) {
      closeMenu();
      var m = document.createElement('div');
      m.className = 'p86fx-menu';
      m.innerHTML = items.map(function (it) {
        if (it.sep) return '<div class="sep"></div>';
        return '<button data-mi="' + esc(it.key) + '"' + (it.danger ? ' class="danger"' : '') + '>' + esc(it.label) + '</button>';
      }).join('');
      document.body.appendChild(m);
      var x = Math.min(e.clientX, window.innerWidth - 190);
      var y = Math.min(e.clientY, window.innerHeight - (items.length * 36 + 16));
      m.style.left = x + 'px'; m.style.top = y + 'px';
      m.querySelectorAll('[data-mi]').forEach(function (b) {
        b.onclick = function () { var k = b.getAttribute('data-mi'); closeMenu(); var it = items.filter(function (i) { return i.key === k; })[0]; if (it && it.run) it.run(); };
      });
      window._p86fxMenu = m;
      setTimeout(function () { document.addEventListener('click', closeMenu, { once: true }); }, 0);
    }
    function closeMenu() { if (window._p86fxMenu) { window._p86fxMenu.remove(); window._p86fxMenu = null; } }

    function fileMenu(e, id) {
      if (!S.sel[id]) { S.sel = {}; S.sel[id] = 1; renderItems(); }
      var f = S.files.filter(function (x) { return x.id === id; })[0];
      var items = [
        { key: 'open', label: 'Open', run: function () { openFile(id); } },
        (f && f.original_url ? { key: 'dl', label: 'Download', run: function () { window.open(f.original_url, '_blank', 'noopener'); } } : { sep: true })
      ];
      if (S.canEdit) {
        items.push({ sep: true });
        items.push({ key: 'move', label: 'Move to…', run: function () { bulk('move'); } });
        items.push({ key: 'cut', label: 'Cut', run: function () { cutSelection(); } });
        items.push({ key: 'del', label: 'Delete', danger: true, run: function () { bulk('delete'); } });
      }
      showMenu(e, items);
    }
    function folderMenu(e, fid) {
      var items = [{ key: 'open', label: 'Open', run: function () { S.cur = fid; S.sel = {}; render(); } }];
      if (S.canEdit) {
        items.push({ sep: true });
        items.push({ key: 'rename', label: 'Rename…', run: function () {
          var f = folderById(fid);
          askName('Rename folder', f ? f.name : '').then(function (name) {
            if (!name) return;
            api().fileFolders.update(S.et, S.eid, fid, { name: name }).then(load).catch(function (er) { toast((er && er.message) || 'Rename failed', 'error'); });
          });
        } });
        items.push({ key: 'move', label: 'Move to…', run: function () {
          pickFolder('Move folder to…').then(function (target) { if (target === undefined) return; moveFolder(fid, target); });
        } });
        items.push({ key: 'del', label: 'Delete folder', danger: true, run: function () {
          confirmDlg('Delete this folder? Files inside move to Home (not deleted).').then(function (ok) {
            if (!ok) return;
            api().fileFolders.remove(S.et, S.eid, fid).then(function () { if (S.cur === fid) S.cur = null; load(); }).catch(function (er) { toast((er && er.message) || 'Delete failed', 'error'); });
          });
        } });
      }
      showMenu(e, items);
    }

    load();
    return { refresh: load, destroy: function () { host.innerHTML = ''; } };
  }

  window.p86Explorer = { mount: mount };
})();
