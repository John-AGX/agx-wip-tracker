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
      '.p86fx-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 4px;border-bottom:1px solid var(--border,#2a2a32);}' +
      '.p86fx-btn{font:inherit;font-size:12.5px;padding:6px 10px;border-radius:8px;border:1px solid var(--border,#2a2a32);background:var(--surface,#181820);color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}' +
      '.p86fx-btn:hover{background:var(--hover,#23232e);}' +
      '.p86fx-btn.primary{background:var(--accent,#22d3ee);border-color:var(--accent,#22d3ee);color:#06141a;font-weight:600;}' +
      '.p86fx-crumbs{display:flex;align-items:center;gap:2px;flex:1 1 200px;min-width:0;flex-wrap:wrap;font-size:13px;}' +
      '.p86fx-crumb{padding:3px 7px;border-radius:6px;cursor:pointer;color:var(--text,#e5e7eb);white-space:nowrap;}' +
      '.p86fx-crumb:hover{background:var(--hover,#23232e);}' +
      '.p86fx-crumb.drop-ok{outline:2px dashed var(--accent,#22d3ee);}' +
      '.p86fx-crumb-sep{color:var(--muted,#6b7280);}' +
      '.p86fx-search{font:inherit;font-size:12.5px;padding:6px 9px;border-radius:8px;border:1px solid var(--border,#2a2a32);background:var(--surface,#181820);color:inherit;width:160px;}' +
      '.p86fx-body{display:flex;flex:1 1 0;min-height:0;}' +
      '.p86fx-tree{flex:0 0 210px;overflow:auto;border-right:1px solid var(--border,#2a2a32);padding:6px 4px;}' +
      '@media(max-width:760px){.p86fx-tree{display:none;}}' +
      '.p86fx-tnode{display:flex;align-items:center;gap:2px;padding:4px 6px;border-radius:6px;cursor:pointer;white-space:nowrap;color:var(--text,#e5e7eb);}' +
      '.p86fx-tnode:hover{background:var(--hover,#23232e);}' +
      '.p86fx-tnode.active{background:rgba(34,211,238,0.14);}' +
      '.p86fx-tnode.drop-ok{outline:2px dashed var(--accent,#22d3ee);outline-offset:-2px;}' +
      '.p86fx-tcaret{width:14px;text-align:center;color:var(--muted,#6b7280);flex:0 0 auto;}' +
      '.p86fx-tlabel{overflow:hidden;text-overflow:ellipsis;}' +
      '.p86fx-main{flex:1 1 0;min-width:0;display:flex;flex-direction:column;overflow:hidden;}' +
      '.p86fx-selbar{display:flex;align-items:center;gap:10px;padding:7px 10px;background:rgba(34,211,238,0.10);border-bottom:1px solid var(--border,#2a2a32);font-size:12.5px;}' +
      '.p86fx-items{flex:1 1 0;overflow:auto;padding:8px;}' +
      '.p86fx-items.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;align-content:start;}' +
      '.p86fx-items.list{display:flex;flex-direction:column;gap:1px;}' +
      // grid tiles
      '.p86fx-tile{position:relative;border:1px solid var(--border,#2a2a32);border-radius:10px;overflow:hidden;cursor:pointer;background:var(--surface,#181820);}' +
      '.p86fx-tile.sel{outline:2px solid var(--accent,#22d3ee);border-color:var(--accent,#22d3ee);}' +
      '.p86fx-tile.drop-ok{outline:2px dashed var(--accent,#22d3ee);}' +
      '.p86fx-thumb{aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;background:var(--bg,#0f0f15);font-size:34px;color:var(--muted,#6b7280);overflow:hidden;}' +
      '.p86fx-thumb img{width:100%;height:100%;object-fit:cover;}' +
      '.p86fx-cap{padding:6px 8px;font-size:11.5px;line-height:1.3;word-break:break-word;border-top:1px solid var(--border,#2a2a32);}' +
      '.p86fx-cap .nm{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.p86fx-cap .mt{color:var(--muted,#6b7280);font-size:10.5px;}' +
      '.p86fx-folder .p86fx-thumb{color:var(--accent,#22d3ee);}' +
      '.p86fx-check{position:absolute;top:6px;left:6px;width:10px;height:10px;z-index:2;}' +
      // list rows
      // Fixed-column grid so the icon / name / size / date line up across
      // EVERY row — folders (no checkbox) get a .ck-spacer in column 1 so they
      // align with file rows instead of sliding left.
      '.p86fx-row{display:grid;grid-template-columns:18px 24px minmax(0,1fr) 70px 96px;align-items:center;gap:10px;padding:8px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent;}' +
      '.p86fx-row:hover{background:var(--hover,#23232e);}' +
      '.p86fx-row.sel{background:rgba(34,211,238,0.12);}' +
      '.p86fx-row.drop-ok{outline:2px dashed var(--accent,#22d3ee);}' +
      '.p86fx-row>input[type=checkbox]{width:10px;height:10px;margin:0;justify-self:center;}' +
      '.p86fx-row .ck-spacer{display:block;}' +
      '.p86fx-row .ic{justify-self:center;font-size:16px;line-height:1;}' +
      '.p86fx-row .nm{display:flex;align-items:center;gap:7px;min-width:0;}' +
      '.p86fx-row .nm .fn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.p86fx-row .nm .ext{flex-shrink:0;font-size:9px;font-weight:700;letter-spacing:0.3px;color:var(--muted,#9ca3af);background:var(--hover,#23232e);border:1px solid var(--border,#333);border-radius:3px;padding:0 4px;}' +
      '.p86fx-row .meta{color:var(--muted,#6b7280);font-size:11.5px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.p86fx-empty{padding:36px 12px;text-align:center;color:var(--muted,#6b7280);}' +
      // context menu
      '.p86fx-menu{position:fixed;z-index:9999;min-width:170px;background:var(--surface,#1b1b24);border:1px solid var(--border,#2a2a32);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.4);padding:5px;font-size:13px;}' +
      '.p86fx-menu button{display:flex;width:100%;text-align:left;gap:8px;align-items:center;font:inherit;font-size:13px;padding:7px 10px;border:none;background:transparent;color:inherit;border-radius:7px;cursor:pointer;}' +
      '.p86fx-menu button:hover{background:var(--hover,#23232e);}' +
      '.p86fx-menu button.danger{color:#f87171;}' +
      '.p86fx-menu .sep{height:1px;background:var(--border,#2a2a32);margin:4px 2px;}' +
      // Folder colour + icon picker (right-click → Colour & icon…).
      // A fixed width, not min-width: the icon row is a wrapping flexbox,
      // and with only a minimum it had nothing to wrap against and laid
      // all 19 choices out in one 660px line.
      '.p86fx-styler{width:236px;box-sizing:border-box;padding:9px 10px 11px;}' +
      '.p86fx-styler-hd{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim,#8b90a5);margin:2px 0 6px;}' +
      '.p86fx-sw{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;}' +
      // Selectors are .p86fx-menu-prefixed on purpose: the generic
      // `.p86fx-menu button { display:flex; width:100% }` rule above is
      // (0,1,1) and would otherwise outrank a bare `.p86fx-swatch` (0,1,0),
      // stretching every swatch and icon into a full-width bar.
      '.p86fx-menu .p86fx-swatch{width:22px;height:22px;border-radius:6px;border:2px solid transparent;cursor:pointer;padding:0;flex:0 0 auto;display:block;}' +
      '.p86fx-menu .p86fx-swatch.on{border-color:var(--text,#e4e6f0);box-shadow:0 0 0 2px rgba(0,0,0,.35) inset;}' +
      '.p86fx-menu .p86fx-swatch-none{background:transparent;border:2px dashed var(--border,#3a3a46);}' +
      '.p86fx-sw-ic{margin-bottom:0;}' +
      '.p86fx-menu .p86fx-iconbtn{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;' +
        'border:1px solid transparent;background:var(--surface2,#23232e);color:var(--text,#dfe2ec);cursor:pointer;padding:0;flex:0 0 auto;font-size:14px;}' +
      '.p86fx-menu .p86fx-iconbtn:hover{border-color:var(--accent,#22d3ee);}' +
      '.p86fx-menu .p86fx-iconbtn.on{border-color:var(--accent,#22d3ee);background:rgba(34,211,238,.14);}' +
      '.p86fx-menu .p86fx-iconbtn .p86fx-svg{width:15px;height:15px;}' +
      // Folder / filetype icon glyphs inside tree rows, list rows, tiles.
      '.p86fx-fic{display:inline-flex;align-items:center;justify-content:center;}' +
      '.p86fx-fic .p86fx-svg{width:1em;height:1em;vertical-align:-0.12em;}' +
      '.p86fx-thumb .p86fx-fic .p86fx-svg{width:30px;height:30px;}' +
      // Both the filetype tints and a folder's stored colour are inline
      // `style="color:…"`, so CSS can't restyle them per theme — and the
      // palette was picked against a dark background. On white they
      // measured 1.9–2.8:1, under the 3:1 a non-text glyph needs. A
      // brightness filter darkens whatever hex is actually set, including
      // colours the user picks later, without touching stored data.
      'body.light-mode .p86fx-fic{filter:brightness(0.72) saturate(1.1);}' +
      'body.light-mode .p86fx-swatch{filter:none;}' +
      // name dialog
      '.p86fx-modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;}' +
      '.p86fx-modal-box{background:var(--surface,#1b1b24);border:1px solid var(--border,#2a2a32);border-radius:12px;padding:16px;width:min(420px,92vw);}' +
      '.p86fx-modal-box h4{margin:0 0 10px;font-size:15px;}' +
      '.p86fx-modal-box input{width:100%;font:inherit;padding:9px 11px;border-radius:8px;border:1px solid var(--border,#2a2a32);background:var(--bg,#0f0f15);color:inherit;}' +
      '.p86fx-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}' +
      '.p86fx-modal .pick-list{max-height:46vh;overflow:auto;margin-top:8px;border:1px solid var(--border,#2a2a32);border-radius:8px;}' +
      '.p86fx-modal .pick-row{padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border,#2a2a32);}' +
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

  // ── Folder + filetype appearance ─────────────────────────────────
  // The palette offered by the folder colour picker. Deliberately small:
  // eight distinguishable hues scan far better than a full colour wheel,
  // and these read on both the dark and light themes.
  var FOLDER_COLORS = [
    { hex: '#22d3ee', name: 'Cyan' },
    { hex: '#4f8cff', name: 'Blue' },
    { hex: '#7f77dd', name: 'Violet' },
    { hex: '#22c55e', name: 'Green' },
    { hex: '#f0b429', name: 'Amber' },
    { hex: '#f97316', name: 'Orange' },
    { hex: '#f87171', name: 'Red' },
    { hex: '#94a3b8', name: 'Slate' }
  ];
  // Icons offered for a folder — the subset of agx-icons.js that suits
  // construction doc control, matching the taxonomy defaults the server
  // stamps onto preloaded folders.
  var FOLDER_ICONS = [
    'folder', 'photos', 'scale', 'document-text', 'estimates', 'envelope',
    'subs', 'clients', 'id-card', 'banknotes', 'edit', 'check-circle',
    'admin', 'wrench', 'buildings', 'schedule', 'leads', 'target'
  ];

  function icoRaw(name, cls) {
    return (window.p86Icon && name) ? window.p86Icon(name, { class: cls || 'p86fx-svg' }) : '';
  }
  // A folder's glyph: its chosen icon tinted by its colour, else the
  // plain folder emoji — so an unstyled folder looks exactly as before.
  function folderGlyph(f) {
    var svg = icoRaw(f && f.icon);
    if (!svg) {
      return (f && f.color)
        ? '<span style="color:' + esc(f.color) + '">\u{1F4C1}</span>'
        : '\u{1F4C1}';
    }
    return '<span class="p86fx-fic"' + (f && f.color ? ' style="color:' + esc(f.color) + '"' : '') + '>' + svg + '</span>';
  }

  // Filetype logo, keyed on the FILE EXTENSION first and the mime type
  // only as a fallback.
  //
  // Extension-first is not arbitrary: the upload path sniffs magic bytes,
  // and an .xlsx really is a ZIP container — so it is stored as
  // application/zip and a mime-first lookup gave every spreadsheet the
  // archive icon. text/plain likewise fell through to the generic clip.
  // The extension is also what the row badge already shows, so keying on
  // it keeps the icon and the badge telling the same story.
  var EXT_FAMILY = {
    pdf: 'pdf',
    doc: 'doc', docx: 'doc', rtf: 'doc', odt: 'doc', pages: 'doc',
    txt: 'doc', md: 'doc', log: 'doc', json: 'doc', xml: 'doc',
    xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', csv: 'sheet', tsv: 'sheet', ods: 'sheet', numbers: 'sheet',
    ppt: 'slides', pptx: 'slides', key: 'slides',
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
    heic: 'image', heif: 'image', bmp: 'image', tif: 'image', tiff: 'image', svg: 'image',
    zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
    mp4: 'video', mov: 'video', avi: 'video', webm: 'video', mkv: 'video',
    mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio',
    dwg: 'cad', dxf: 'cad', rvt: 'cad', skp: 'cad'
  };
  // family -> [icon name, tint]. Tints are the dark-theme values; light
  // mode darkens them via the brightness filter in ensureStyles.
  var FAMILY_LOOK = {
    image:   ['photos', '#22c55e'],
    pdf:     ['document-text', '#f87171'],
    sheet:   ['chart-bar', '#22a06b'],
    doc:     ['document-text', '#4f8cff'],
    slides:  ['presentation-chart', '#f97316'],
    archive: ['cube', '#f0b429'],
    video:   ['composer-camera', '#7f77dd'],
    audio:   ['composer-mic', '#f97316'],
    cad:     ['scale', '#22d3ee'],
    other:   ['attachments', '#94a3b8']
  };
  function fileFamily(f) {
    var m = /\.([a-z0-9]{1,6})$/i.exec((f && f.filename) || '');
    if (m) {
      var fam = EXT_FAMILY[m[1].toLowerCase()];
      if (fam) return fam;
    }
    var mt = (f && f.mime_type) || '';
    if (/^image\//i.test(mt)) return 'image';
    if (/pdf/i.test(mt)) return 'pdf';
    if (/sheet|excel|csv/i.test(mt)) return 'sheet';
    if (/presentation|powerpoint/i.test(mt)) return 'slides';
    if (/word|opendocument.text|^text\//i.test(mt)) return 'doc';
    if (/zip|compressed|archive/i.test(mt)) return 'archive';
    if (/^video\//i.test(mt)) return 'video';
    if (/^audio\//i.test(mt)) return 'audio';
    return 'other';
  }
  function fileIconName(f) { return (FAMILY_LOOK[fileFamily(f)] || FAMILY_LOOK.other)[0]; }
  function fileIconColor(f) { return (FAMILY_LOOK[fileFamily(f)] || FAMILY_LOOK.other)[1]; }

  function fileGlyph(f) {
    var svg = icoRaw(fileIconName(f));
    if (svg) return '<span class="p86fx-fic" style="color:' + fileIconColor(f) + '">' + svg + '</span>';
    if (isImg(f)) return '\u{1F5BC}';
    if (isPdf(f)) return '\u{1F4C4}';
    if (/sheet|excel|csv/i.test(f.mime_type || '')) return '\u{1F4CA}';
    if (/word|document/i.test(f.mime_type || '')) return '\u{1F4DD}';
    return '\u{1F4CE}';
  }
  // Short uppercase type label for the row badge — extension first, else
  // a family guess from the mime type. '' when nothing useful is known.
  function fileExt(f) {
    var m = /\.([a-z0-9]{1,5})$/i.exec((f && f.filename) || '');
    if (m) return m[1].toUpperCase();
    var mt = (f && f.mime_type) || '';
    if (/pdf/i.test(mt)) return 'PDF';
    if (/sheet|excel|csv/i.test(mt)) return 'XLS';
    if (/word|document/i.test(mt)) return 'DOC';
    if (/^image\//i.test(mt)) return 'IMG';
    return '';
  }
  function extBadge(f) {
    var e = fileExt(f);
    return e ? '<span class="ext">' + esc(e) + '</span>' : '';
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

  // The open folder has to survive a remount. mount() allocates a fresh S on
  // every call, and several callers remount unconditionally (a My Files tab
  // switch, a sidebar folder click), which silently reset both the view and
  // the upload target back to root. Keyed per bucket so one record's folder
  // can never leak into another's.
  var LAST_CUR = {};
  function curKey(et, eid) { return String(et) + '|' + String(eid); }

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
      cur: LAST_CUR[curKey(opts.entityType, opts.entityId)] || null,  // current folder id (null = root)
      // Default to LIST (John's preference); remember the user's last toggle.
      view: (function () { try { return localStorage.getItem('p86fx-view') === 'grid' ? 'grid' : 'list'; } catch (e) { return 'list'; } })(),
      sort: 'name',
      query: '',
      sel: {},              // selected file ids
      expanded: {},         // folder id → true
      clip: null,           // { ids:[], op:'cut' }
      loading: true,        // show a skeleton until the first load resolves
      parent: opts.parentEntity || null,  // { entityType, entityId, label } — read-only inherited files
      parentFiles: []
    };
    var PARENT_ID = '__parent__';

    function folderById(id) { for (var i = 0; i < S.folders.length; i++) if (S.folders[i].id === id) return S.folders[i]; return null; }
    function childFolders(pid) { if (pid === PARENT_ID) return []; return S.folders.filter(function (f) { return (f.parent_id || null) === (pid || null); }); }
    function curPath() { var f = S.cur ? folderById(S.cur) : null; return f ? f.path : ''; }
    function filesIn(pid) {
      return S.files.filter(function (f) { return (f.folder_id || null) === (pid || null); });
    }

    function load() {
      var a = api();
      if (!a) { host.innerHTML = '<div class="p86fx-empty">Not connected.</div>'; return Promise.resolve(); }
      return Promise.all([
        a.fileFolders.tree(S.et, S.eid).then(function (r) { return (r && r.folders) || []; }).catch(function () { return []; }),
        a.attachments.list(S.et, S.eid).then(function (r) { return (r && r.attachments) || []; }).catch(function () { return []; }),
        (S.parent && S.parent.entityType && S.parent.entityId)
          ? a.attachments.list(S.parent.entityType, S.parent.entityId).then(function (r) { return (r && r.attachments) || []; }).catch(function () { return []; })
          : Promise.resolve([])
      ]).then(function (out) {
        S.folders = out[0];
        S.files = out[1];
        S.parentFiles = out[2] || [];
        S.loading = false;
        // A folder restored from a previous mount may have since been deleted
        // or belong to a bucket we can no longer see — fall back to root
        // rather than stranding the user in an empty view of nothing.
        if (S.cur && S.cur !== PARENT_ID && !folderById(S.cur)) S.cur = null;
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
      // Remember where we are so a remount lands back here. PARENT_ID is a
      // read-only pseudo-folder, never a real upload target, so it is not kept.
      if (S.cur !== PARENT_ID) LAST_CUR[curKey(S.et, S.eid)] = S.cur || null;
      // In the read-only inherited-files view, hide the editing actions.
      var canEdit = S.canEdit && S.cur !== PARENT_ID;
      // Embedded contexts (entity modals, an overview fieldset) get a
      // bounded height with internal scroll; full-pane mounts (My Files,
      // a Files subtab) keep the default 100dvh fill.
      var rootStyle = opts.embedded ? ' style="height:' + (opts.height || 520) + 'px;min-height:' + (opts.height || 520) + 'px;border:1px solid var(--border,#2a2a32);border-radius:10px;"' : '';
      host.innerHTML =
        '<div class="p86fx" data-view="' + S.view + '"' + rootStyle + '>' +
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
      if (S.cur === PARENT_ID) {
        html += '<span class="p86fx-crumb-sep">›</span><span class="p86fx-crumb">\u{1F4CE} ' + esc((S.parent && S.parent.label) || 'Inherited') + ' (read-only)</span>';
      } else {
        chain.forEach(function (node) {
          html += '<span class="p86fx-crumb-sep">›</span>' +
            '<span class="p86fx-crumb" data-go="' + esc(node.id) + '" data-drop="' + esc(node.id) + '">' + esc(node.name) + '</span>';
        });
      }
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
            '<span class="p86fx-tlabel">' + folderGlyph(f) + ' ' + esc(f.name) + '</span></div>';
          if (exp) walk(f.id, depth + 1);
        });
      }
      walk(null, 0);
      // Read-only inherited files (e.g. an estimate's parent lead) as a
      // pinned pseudo-folder — not a real folder, no drag/drop.
      if (S.parent) {
        html += '<div class="p86fx-tnode' + (S.cur === PARENT_ID ? ' active' : '') + '" data-fid="' + PARENT_ID + '" style="margin-top:6px;border-top:1px solid var(--border,#2a2a32);padding-top:8px;">' +
          '<span class="p86fx-tcaret"></span><span class="p86fx-tlabel">\u{1F4CE} ' + esc((S.parent.label) || 'Inherited') + '</span></div>';
      }
      t.innerHTML = html;
      t.querySelectorAll('[data-fid]').forEach(function (el) {
        var fid = el.getAttribute('data-fid') || null;
        el.addEventListener('click', function (e) {
          if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-caret')) {
            S.expanded[fid] = !S.expanded[fid]; renderTree(); return;
          }
          S.cur = fid; S.sel = {}; render();
        });
        if (fid === PARENT_ID) return; // read-only: no drag/drop, no menu
        if (fid) wireFolderDrag(el, fid);
        wireFolderDrop(el, fid);
        // The TREE is the obvious place to right-click a folder, but it
        // only ever had click + drag wired — the context menu lived solely
        // on the folder rows in the items pane. Same menu, both places.
        if (fid) el.addEventListener('contextmenu', function (e) { e.preventDefault(); folderMenu(e, fid); });
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
      if (S.cur === PARENT_ID) { renderParentFiles(box); return; }
      var subs = childFolders(S.cur).sort(function (a, b) { return a.name.localeCompare(b.name); });
      var files = sortFiles(filesIn(S.cur));
      if (S.query) {
        var q = S.query.toLowerCase();
        subs = subs.filter(function (f) { return f.name.toLowerCase().indexOf(q) >= 0; });
        files = files.filter(function (f) { return String(f.filename || '').toLowerCase().indexOf(q) >= 0 || String(f.caption || '').toLowerCase().indexOf(q) >= 0; });
      }
      if (S.loading) {
        box.innerHTML = '<div class="p86fx-empty">Loading…</div>';
        return;
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
            '<div class="p86fx-thumb">' + folderGlyph(f) + '</div>' +
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
            '<span class="ck-spacer"></span><span class="ic">' + folderGlyph(f) + '</span>' +
            '<span class="nm"><span class="fn">' + esc(f.name) + '</span></span>' +
            '<span class="meta">Folder</span><span class="meta"></span></div>';
        });
        files.forEach(function (f) {
          var sel = S.sel[f.id] ? ' sel' : '';
          html += '<div class="p86fx-row' + sel + '" data-file="' + esc(f.id) + '" draggable="true">' +
            '<input type="checkbox" data-check="' + esc(f.id) + '"' + (S.sel[f.id] ? ' checked' : '') + ' />' +
            '<span class="ic">' + fileGlyph(f) + '</span>' +
            '<span class="nm">' + extBadge(f) + '<span class="fn" title="' + esc(f.filename) + '">' + esc(f.filename) + '</span></span>' +
            '<span class="meta">' + esc(fmtBytes(f.size_bytes)) + '</span><span class="meta">' + esc(fmtDate(f.uploaded_at)) + '</span></div>';
        });
      }
      box.innerHTML = html;
      wireItemEvents();
      renderSelbar();
    }

    // Read-only view of the parent entity's files (e.g. an estimate showing
    // its lead's photos). No checkboxes, drag, move, or delete — click to
    // open, right-click for Open / Download only.
    function renderParentFiles(box) {
      var files = sortFiles(S.parentFiles.slice());
      if (S.query) {
        var q = S.query.toLowerCase();
        files = files.filter(function (f) { return String(f.filename || '').toLowerCase().indexOf(q) >= 0 || String(f.caption || '').toLowerCase().indexOf(q) >= 0; });
      }
      if (S.loading) { box.innerHTML = '<div class="p86fx-empty">Loading…</div>'; return; }
      if (!files.length) {
        box.innerHTML = '<div class="p86fx-empty">' + (S.query ? 'Nothing matches “' + esc(S.query) + '”.' : 'No inherited files.') + '</div>';
        return;
      }
      var html = '';
      if (S.view === 'grid') {
        files.forEach(function (f) {
          var thumb = isImg(f) && f.thumb_url ? '<img src="' + esc(f.thumb_url) + '" alt="" loading="lazy" />' : fileGlyph(f);
          html += '<div class="p86fx-tile" data-pfile="' + esc(f.id) + '">' +
            '<div class="p86fx-thumb">' + thumb + '</div>' +
            '<div class="p86fx-cap"><span class="nm" title="' + esc(f.filename) + '">' + esc(f.filename) + '</span>' +
              '<span class="mt">' + esc(fmtBytes(f.size_bytes)) + (f.size_bytes ? ' · ' : '') + esc(fmtDate(f.uploaded_at)) + '</span></div></div>';
        });
      } else {
        files.forEach(function (f) {
          html += '<div class="p86fx-row" data-pfile="' + esc(f.id) + '">' +
            '<span class="ck-spacer"></span><span class="ic">' + fileGlyph(f) + '</span>' +
            '<span class="nm">' + extBadge(f) + '<span class="fn" title="' + esc(f.filename) + '">' + esc(f.filename) + '</span></span>' +
            '<span class="meta">' + esc(fmtBytes(f.size_bytes)) + '</span><span class="meta">' + esc(fmtDate(f.uploaded_at)) + '</span></div>';
        });
      }
      box.innerHTML = html;
      box.querySelectorAll('[data-pfile]').forEach(function (el) {
        var id = el.getAttribute('data-pfile');
        el.addEventListener('click', function () { openFile(id); });
        el.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          var f = S.parentFiles.filter(function (x) { return x.id === id; })[0];
          var items = [{ key: 'open', label: 'Open', run: function () { openFile(id); } }];
          if (f && f.original_url) items.push({ key: 'dl', label: 'Download', run: function () { window.open(f.original_url, '_blank', 'noopener'); } });
          showMenu(e, items);
        });
      });
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
          if (act === 'view') { S.view = S.view === 'grid' ? 'list' : 'grid'; try { localStorage.setItem('p86fx-view', S.view); } catch (e) {} render(); }
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
      // OS files dropped onto empty area → upload into the current folder.
      if (S.canEdit && box && !box._p86drop) {
        box._p86drop = true;
        box.addEventListener('dragover', function (e) {
          if (e.dataTransfer && e.dataTransfer.types && [].indexOf.call(e.dataTransfer.types, 'Files') >= 0) { e.preventDefault(); }
        });
        box.addEventListener('drop', function (e) {
          if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); doUpload(e.dataTransfer.files, S.cur); }
        });
      }
      // checkboxes
      box.querySelectorAll('[data-check]').forEach(function (c) {
        c.onclick = function (e) { e.stopPropagation(); var id = c.getAttribute('data-check'); if (c.checked) S.sel[id] = 1; else delete S.sel[id]; renderItems(); };
      });
      // folder open + drag/drop
      box.querySelectorAll('[data-folder]').forEach(function (el) {
        var fid = el.getAttribute('data-folder');
        // Single click opens, to match files. Same debounce so the second
        // click of a habitual double-click doesn't re-enter the folder.
        var lastNav = 0;
        el.addEventListener('click', function () {
          var now = Date.now();
          if (now - lastNav < 500) return;
          lastNav = now;
          S.cur = fid; S.sel = {}; render();
        });
        el.addEventListener('contextmenu', function (e) { e.preventDefault(); folderMenu(e, fid); });
        wireFolderDrag(el, fid);
        wireFolderDrop(el, fid);
      });
      // file open + select + drag + menu
      box.querySelectorAll('[data-file]').forEach(function (el) {
        var id = el.getAttribute('data-file');
        var lastOpen = 0;
        el.addEventListener('click', function (e) {
          if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-check')) return;
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            if (S.sel[id]) delete S.sel[id]; else S.sel[id] = 1;
            renderItems(); return;
          }
          // A plain click OPENS. Selecting is the checkbox's job (plus
          // ctrl/cmd-click) — a click that only ticked a box left no way to
          // open a file short of a double-click nobody discovers.
          var now = Date.now();
          if (now - lastOpen < 500) return;  // swallow the 2nd click of a habitual double-click
          lastOpen = now;
          openFile(id);
        });
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
        // OS files dropped from the desktop → upload INTO this folder.
        if (S.canEdit && e.dataTransfer.files && e.dataTransfer.files.length) { doUpload(e.dataTransfer.files, targetFolderId); return; }
        var files = e.dataTransfer.getData('text/p86-files');
        var folder = e.dataTransfer.getData('text/p86-folder');
        if (files) { moveFiles(files.split(',').filter(Boolean), targetFolderId); }
        else if (folder && folder !== targetFolderId) { moveFolder(folder, targetFolderId); }
      });
    }

    // ── Actions ──────────────────────────────────────────────────────
    function openFile(id) {
      var inParent = S.cur === PARENT_ID;
      var pool = inParent ? S.parentFiles : S.files;
      var f = pool.filter(function (x) { return x.id === id; })[0];
      if (!f) return;
      if (isImg(f)) {
        var imgs = (inParent ? sortFiles(S.parentFiles.slice()) : sortFiles(filesIn(S.cur))).filter(isImg);
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
    function doUpload(fileList, folderId) {
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      var fid = (folderId === undefined) ? S.cur : folderId;
      var ff = fid ? folderById(fid) : null;
      var path = (ff ? ff.path : '') || 'general';
      var total = files.length, done = 0, failed = [];
      toast('Uploading ' + total + ' file(s)…');
      (function next() {
        if (!files.length) {
          load();
          if (failed.length) toast(done + ' of ' + total + ' uploaded — ' + failed.length + ' failed: ' + failed[0], 'error');
          else toast(done + ' file(s) uploaded', 'success');
          return;
        }
        var f = files.shift();
        // folder_id is what actually files it; `folder` stays for the string
        // readers. Only a resolvable folder is sent — PARENT_ID has no row and
        // the server rejects an id it cannot find.
        var extra = { folder: path };
        if (ff) extra.folder_id = ff.id;
        api().attachments.upload(S.et, S.eid, f, extra)
          .then(function () { done++; })
          .catch(function (e) { failed.push((e && e.message) || 'Upload failed'); })
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
    // Persist a folder's appearance and repaint. Patch keys are
    // present-only, so setting a colour never clears the icon.
    function styleFolder(fid, patch) {
      return api().fileFolders.update(S.et, S.eid, fid, patch)
        .then(load)
        .catch(function (er) { toast((er && er.message) || 'Could not restyle that folder', 'error'); });
    }

    // Swatch + icon picker. A popover rather than a prompt() — picking a
    // colour by typing a hex code is not a thing anyone wants to do.
    //
    // OPENS ON THE NEXT TICK, and that is load-bearing. showMenu arms a
    // one-shot document click listener that closes the open menu. The
    // click on "Colour & icon…" runs this handler and then KEEPS BUBBLING
    // to that listener — so a popover created synchronously here would be
    // torn down by the very click that asked for it. Deferring lets the
    // in-flight click finish (consuming the old listener) before the new
    // popover exists.
    function stylePicker(e, fid) {
      closeMenu();
      var cx = e.clientX, cy = e.clientY;
      setTimeout(function () { openStylePicker(cx, cy, fid); }, 0);
    }

    function openStylePicker(cx, cy, fid) {
      var f = folderById(fid) || {};
      var m = document.createElement('div');
      m.className = 'p86fx-menu p86fx-styler';
      m.innerHTML =
        '<div class="p86fx-styler-hd">Colour</div>' +
        '<div class="p86fx-sw">' +
          FOLDER_COLORS.map(function (c) {
            return '<button class="p86fx-swatch' + (f.color === c.hex ? ' on' : '') + '" data-color="' + esc(c.hex) +
              '" title="' + esc(c.name) + '" style="background:' + esc(c.hex) + '"></button>';
          }).join('') +
          '<button class="p86fx-swatch p86fx-swatch-none' + (!f.color ? ' on' : '') + '" data-color="" title="No colour"></button>' +
        '</div>' +
        '<div class="p86fx-styler-hd">Icon</div>' +
        '<div class="p86fx-sw p86fx-sw-ic">' +
          FOLDER_ICONS.map(function (n) {
            return '<button class="p86fx-iconbtn' + (f.icon === n ? ' on' : '') + '" data-icon="' + esc(n) +
              '" title="' + esc(n) + '">' + (icoRaw(n) || '?') + '</button>';
          }).join('') +
          '<button class="p86fx-iconbtn' + (!f.icon ? ' on' : '') + '" data-icon="" title="Default">\u{1F4C1}</button>' +
        '</div>';
      document.body.appendChild(m);
      m.style.left = Math.min(cx, window.innerWidth - 250) + 'px';
      m.style.top = Math.min(cy, window.innerHeight - 260) + 'px';
      window._p86fxMenu = m;
      m.addEventListener('click', function (ev) {
        var c = ev.target.closest('[data-color]');
        var i = ev.target.closest('[data-icon]');
        if (!c && !i) return;
        ev.stopPropagation();
        // Keep the popover open so colour and icon can be set in one go;
        // the swatches restyle live as they are clicked.
        if (c) {
          m.querySelectorAll('[data-color]').forEach(function (b) { b.classList.remove('on'); });
          c.classList.add('on');
          styleFolder(fid, { color: c.getAttribute('data-color') || null });
        } else {
          m.querySelectorAll('[data-icon]').forEach(function (b) { b.classList.remove('on'); });
          i.classList.add('on');
          styleFolder(fid, { icon: i.getAttribute('data-icon') || null });
        }
      });
      // Same deferred close-on-outside-click contract as showMenu.
      setTimeout(function () { document.addEventListener('click', closeMenu, { once: true }); }, 0);
    }

    function folderMenu(e, fid) {
      var items = [{ key: 'open', label: 'Open', run: function () { S.cur = fid; S.sel = {}; render(); } }];
      if (S.canEdit) {
        items.push({ sep: true });
        items.push({ key: 'new', label: 'New subfolder…', run: function () {
          askName('New subfolder', '').then(function (name) {
            if (!name) return;
            api().fileFolders.create(S.et, S.eid, { name: name, parent_id: fid })
              .then(function () { S.expanded[fid] = true; return load(); })
              .catch(function (er) { toast((er && er.message) || 'Could not create that folder', 'error'); });
          });
        } });
        items.push({ key: 'style', label: 'Colour & icon…', run: function () { stylePicker(e, fid); } });
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

    // Paint the shell synchronously so the component survives a host
    // re-render the same way a synchronous panel does, then populate.
    render();
    load();
    return { refresh: load, destroy: function () { host.innerHTML = ''; } };
  }

  window.p86Explorer = { mount: mount };
})();
