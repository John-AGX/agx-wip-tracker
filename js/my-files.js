// My Files — per-user personal file folder.
//
// Each authenticated user gets their own attachments bucket
// (entity_type='user', entity_id=user.id). They can:
//   - Upload files (drag/drop or file picker)
//   - Organize with custom folders (Phase 3 folder column reused)
//   - Send a file to a job/lead/estimate as a one-off MOVE
//   - Copy a file to a job/lead/estimate (server-side bytes copy,
//     so deletes are independent)
//   - Rename folders, delete files
//
// The widget is self-contained — fetches its data on mount and
// re-renders after each mutation. Folder selection is in-memory state;
// switching folders just re-filters the displayed file list.
//
// Public surface:
//   window.renderMyFilesTab() — paint the #my-files tab pane.

(function() {
  'use strict';

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, '&quot;'); }

  function fmtBytes(n) {
    if (!n || !isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtDate(d) {
    if (!d) return '';
    try { return new Date(d).toLocaleDateString(); } catch (e) { return ''; }
  }

  function isImage(att) {
    return att && att.mime_type && /^image\//i.test(att.mime_type) && att.thumb_url;
  }
  function isPdfFile(att) {
    return !!(att && (att.mime_type === 'application/pdf' || /\.pdf$/i.test(att.filename || '')));
  }
  // Open a file in the markup viewer (annotation + measure surface). It renders
  // PDFs via pdf.js and images directly, so both can be marked up — and saves
  // annotations back onto the same attachment. Falls back to the raw file if the
  // markup module isn't loaded.
  function openAnnotate(file) {
    if (window.p86Markup && typeof window.p86Markup.open === 'function') {
      window.p86Markup.open({
        attachment: file,
        onDone: function () { fetchFiles().then(function () { paint(document.getElementById('my-files')); }); }
      });
    } else {
      window.open(file.original_url, '_blank', 'noopener');
    }
  }

  // Per-tab UI state. Re-built on every paint so refresh is consistent;
  // selected folder survives across re-renders within the same session.
  // expandedFolders: Set of folder paths whose subfolder children are
  // visible. Defaults to expanded for the chain leading to activeFolder.
  var _state = {
    files: [],
    activeFolder: 'general',
    expandedFolders: {},
    loading: false,
    error: null
  };

  // ── Contextual sidebar state (My Files folder rail → #app-sidebar) ──
  // On desktop the folder rail is relocated out of the page and into the
  // app's left sidebar (#app-sidebar) as a contextual "Files" section,
  // mirroring the job page's subnav (workspace-layout.js). Unlike the job
  // page — a drill-down that hides the primary nav and shows a Back
  // control — My Files is a TOP-LEVEL destination reached from the header
  // files icon, so the primary nav (.app-nav) stays visible and the rail
  // is appended below it rather than replacing it. On mobile the sidebar
  // is hidden, so the rail stays in the page as the original two-column
  // .mf-layout. A matchMedia listener re-paints across the 768px
  // breakpoint; window.myFilesSidebarCleanup (called by app.js switchTab
  // when leaving the tab) removes the relocated rail.
  var _filesSubnavMql = null;
  var _filesSubnavMqlHandler = null;
  var _filesMounted = false;

  function currentUserId() {
    var u = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
    return u ? u.id : null;
  }

  // Sanitize a folder name / path. Allows `/` as a subfolder
  // separator (max 3 levels deep). Each segment is trimmed of bad
  // chars, spaces collapse to hyphens, and empty segments drop.
  // Empty → 'general'.
  //
  // Examples:
  //   "Jobs / Smith / Photos"   → "jobs/smith/photos"
  //   "/general/temp/"          → "general/temp"
  //   "foo//bar"                → "foo/bar"
  function sanitizeFolder(name) {
    var raw = String(name || '').trim().slice(0, 180);
    var segs = raw.split('/').map(function(s) {
      return s.trim().slice(0, 60).toLowerCase()
        .replace(/[^a-z0-9 _\-]/g, '').replace(/\s+/g, '-');
    }).filter(Boolean).slice(0, 3);  // cap depth at 3
    return segs.join('/') || 'general';
  }

  // Pretty-display a single folder segment OR a full path. For a path,
  // each segment gets title-cased; the caller decides whether to show
  // the full path or only the leaf (depends on context — sidebar tree
  // shows leaves, breadcrumbs show full path).
  function prettyFolderSegment(seg) {
    if (!seg || seg === 'general') return 'General';
    return String(seg).replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }
  function prettyFolder(f) {
    return String(f || '').split('/').map(prettyFolderSegment).join(' / ');
  }
  function folderLeaf(f) {
    var parts = String(f || '').split('/');
    return prettyFolderSegment(parts[parts.length - 1]);
  }
  function folderParent(f) {
    var parts = String(f || '').split('/');
    parts.pop();
    return parts.join('/');
  }
  function folderDepth(f) {
    return String(f || '').split('/').length - 1;
  }

  // Group files by folder; returns { folderName: [items] } sorted.
  function groupByFolder(files) {
    var bucket = {};
    files.forEach(function(a) {
      var f = (a && a.folder) ? String(a.folder) : 'general';
      if (!bucket[f]) bucket[f] = [];
      bucket[f].push(a);
    });
    return bucket;
  }

  // Build a recursive list of buttons representing the folder tree.
  // Children render only when their parent path is in
  // _state.expandedFolders. Counts on parent rows roll up (sum of own
  // files + all descendant files) so collapsing doesn't hide info.
  function renderFolderTree(allFolders, bucket) {
    // Build parent → [child] map keyed by full path.
    var childrenOf = {};   // parentPath → [childPath]
    var allPaths = {};
    allFolders.forEach(function(f) {
      allPaths[f] = true;
      // Walk up ensuring every ancestor exists in the tree even if
      // there are no files in it (intermediate folders).
      var cur = f;
      while (cur) {
        var p = folderParent(cur);
        if (!childrenOf[p]) childrenOf[p] = [];
        if (childrenOf[p].indexOf(cur) === -1) childrenOf[p].push(cur);
        allPaths[cur] = true;
        cur = p;
      }
    });
    // Sort each child array; 'general' pins first at root.
    Object.keys(childrenOf).forEach(function(p) {
      childrenOf[p].sort(function(a, b) {
        if (p === '' && a === 'general') return -1;
        if (p === '' && b === 'general') return 1;
        return folderLeaf(a).localeCompare(folderLeaf(b));
      });
    });

    // Sum descendant file counts including self for parent count display.
    function totalCount(path) {
      var n = (bucket[path] || []).length;
      (childrenOf[path] || []).forEach(function(c) { n += totalCount(c); });
      return n;
    }

    // Auto-expand the chain leading to the active folder so a deep
    // selection isn't hidden.
    if (_state.activeFolder && _state.activeFolder.indexOf('/') !== -1) {
      var p = folderParent(_state.activeFolder);
      while (p) {
        _state.expandedFolders[p] = true;
        p = folderParent(p);
      }
    }

    function buildRow(path, depth) {
      var kids = childrenOf[path] || [];
      var active = path === _state.activeFolder;
      var expanded = !!_state.expandedFolders[path];
      var ownCount = (bucket[path] || []).length;
      var n = totalCount(path);
      // The row itself is a <button>; the caret toggle must therefore be a
      // <span role="button">, not a nested <button> — the HTML parser
      // refuses button-in-button and hoists the inner one out, which split
      // the row (empty row + detached caret/label/count). role+tabindex
      // keep it keyboard-accessible; stopPropagation stops the row's
      // selectFolder from also firing on a caret click.
      var caret = kids.length
        ? '<span class="mf-rail-caret" role="button" tabindex="0" onclick="event.stopPropagation();window.myFiles.toggleFolder(\'' + escapeAttr(path) + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();event.stopPropagation();window.myFiles.toggleFolder(\'' + escapeAttr(path) + '\');}" aria-label="' + (expanded ? 'Collapse' : 'Expand') + '">' + (expanded ? '&#x25BE;' : '&#x25B8;') + '</span>'
        : '<span class="mf-rail-caret mf-rail-caret-empty"></span>';
      var html = '<button class="mf-rail-row' + (active ? ' active' : '') + '" style="padding-left:' + (8 + depth * 14) + 'px;" data-folder="' + escapeAttr(path) + '" onclick="window.myFiles.selectFolder(\'' + escapeAttr(path) + '\')">' +
        caret +
        '<span class="mf-rail-row-glyph">' + (kids.length ? (expanded ? '&#x1F4C2;' : '&#x1F4C1;') : '&#x1F4C1;') + '</span>' +
        '<span class="mf-rail-row-label">' + escapeHTML(folderLeaf(path) || prettyFolder(path)) + '</span>' +
        '<span class="mf-rail-row-count">' + n + (kids.length && n !== ownCount ? '' : '') + '</span>' +
      '</button>';
      if (expanded && kids.length) {
        html += kids.map(function(c) { return buildRow(c, depth + 1); }).join('');
      }
      return html;
    }

    var roots = childrenOf[''] || [];
    return roots.map(function(r) { return buildRow(r, 0); }).join('');
  }

  // ──────────────────────────────────────────────────────────────────
  // Mount + render
  // ──────────────────────────────────────────────────────────────────
  function renderMyFilesTab() {
    var pane = document.getElementById('my-files');
    if (!pane) return;
    var uid = currentUserId();
    if (!uid) {
      // Auth race: if the URL restored to /files before p86Auth.init()
      // finished its async checkSession() roundtrip (refresh-token +
      // /me, two sequential requests), getUser() returns null. We
      // wait for the 'p86:auth-ready' event auth.js dispatches when
      // currentUser lands, and as a belt-and-suspenders fallback we
      // also poll for ~8s (cold-Railway start can be slow). Only show
      // the "Sign in" stub if there's truly no token in localStorage.
      if (localStorage.getItem('p86-auth-token')) {
        pane.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#888);">Loading…</div>';
        var settled = false;
        function onReady() {
          if (settled) return;
          settled = true;
          window.removeEventListener('p86:auth-ready', onReady);
          if (currentUserId()) renderMyFilesTab();
        }
        window.addEventListener('p86:auth-ready', onReady);
        var tries = 0;
        var timer = setInterval(function() {
          tries++;
          if (currentUserId()) {
            clearInterval(timer);
            if (!settled) {
              settled = true;
              window.removeEventListener('p86:auth-ready', onReady);
              renderMyFilesTab();
            }
          } else if (tries >= 64) { // ~8s @ 125ms — generous for cold starts
            clearInterval(timer);
            if (!settled) {
              settled = true;
              window.removeEventListener('p86:auth-ready', onReady);
              pane.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#888);">Sign in to access your files.</div>';
            }
          }
        }, 125);
        return;
      }
      pane.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#888);">Sign in to access your files.</div>';
      return;
    }
    // Dispatch: the default My Files view is now the shared Explorer
    // (window.p86Explorer). The three virtual folders (Projects / Field
    // Tools / Printouts) keep their existing in-pane rendering until they
    // graduate to their own tabs (FS Phase 4). A virtual deep-link calls
    // selectFolder() AFTER switchTab→renderMyFilesTab, so we always reset
    // to the Explorer here; selectFolder then switches to the virtual view
    // (the Explorer's stale-render guard prevents its async load from
    // clobbering that switch).
    _state.activeFolder = 'general';
    mountExplorerInto(pane);
  }
  window.renderMyFilesTab = renderMyFilesTab;

  function mountExplorerInto(pane) {
    if (!pane) return;
    var uid = currentUserId();
    if (!uid || !window.p86Explorer || !window.p86Explorer.mount) {
      // Fall back to the legacy browser if the Explorer isn't available.
      fetchFiles().then(function() { paint(pane); });
      return;
    }
    pane._mfMode = 'explorer';
    window.p86Explorer.mount(pane, {
      entityType: 'user',
      entityId: String(uid),
      canEdit: true,
      shouldRender: function() { return pane._mfMode === 'explorer'; }
    });
  }

  function fetchFiles() {
    var uid = currentUserId();
    if (!uid) return Promise.resolve();
    _state.loading = true;
    return window.p86Api.attachments.list('user', String(uid))
      .then(function(res) {
        _state.files = (res && res.attachments) || [];
        _state.error = null;
      })
      .catch(function(err) {
        _state.error = err.message || 'Failed to load';
        _state.files = [];
      })
      .then(function() { _state.loading = false; });
  }

  // ──────────────────────────────────────────────────────────────────
  // Contextual sidebar (folder rail → #app-sidebar) — see _filesMounted
  // comment block above for the rationale.
  // ──────────────────────────────────────────────────────────────────
  function filesSubnavIsMobile() {
    // Touch-gated: only a real touch device (coarse pointer) hides the
    // desktop sidebar, so a narrow mouse desktop keeps the folder rail in
    // the sidebar. Mirrors the CSS .app-sidebar hide (styles.css, gated).
    return !!(window.matchMedia && window.matchMedia('(max-width: 768px) and (pointer: coarse)').matches);
  }

  // Build (once) the #app-filesnav wrapper inside #app-sidebar. It is
  // inserted AFTER the primary nav (.app-nav) so the folder rail reads as
  // a contextual section below the main destinations — like Recents —
  // rather than replacing them (contrast the job subnav, which sits
  // before .app-nav and hides it).
  function buildFilesSidebarShell() {
    var sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return null;
    var nav = document.getElementById('app-filesnav');
    if (!nav) {
      nav = document.createElement('div');
      nav.id = 'app-filesnav';
      nav.className = 'app-filesnav';
      var appNav = sidebar.querySelector('.app-nav');
      var recents = document.getElementById('app-sidebar-recents');
      // Prefer to sit between the primary nav and Recents. Fall back to
      // appending if neither anchor is present.
      if (recents && recents.parentNode === sidebar) {
        sidebar.insertBefore(nav, recents);
      } else if (appNav && appNav.nextSibling) {
        sidebar.insertBefore(nav, appNav.nextSibling);
      } else {
        sidebar.appendChild(nav);
      }
    }
    return nav;
  }

  // Legacy: in the old layout, a contextual `#app-filesnav` rail
  // mounted below the primary nav and held the folder list + Views.
  // Now the folder list lives directly as accordion children under the
  // My Files row in the main sidebar (see syncSidebarFolders below),
  // and Projects / Tools / Printouts are their own top-level sidebar
  // tabs. So `#app-filesnav` should never exist anymore — this helper
  // just yanks any leftover wrapper from a stale session and is a
  // no-op when nothing is mounted.
  function placeFilesSidebar() {
    var existing = document.getElementById('app-filesnav');
    if (existing) existing.remove();
  }

  // Populate the accordion `.app-nav-children` slot under the My Files
  // sidebar row with the user's actual folders. Called from paint() on
  // every render so adding / deleting a folder reflects immediately.
  //
  //   - General is forced to the top (matches the page sort order).
  //   - Each row carries data-myfiles-folder so it routes through the
  //     same delegated tab-btn click handler in app.js
  //     (window.myFiles.selectFolder → remounts the Explorer).
  //   - The active row gets the .active class so the existing sidebar
  //     active-row CSS highlight applies.
  function syncSidebarFolders(folders, bucket) {
    var slot = document.querySelector('.app-nav-parent[data-accordion="myfiles"] .app-nav-children');
    if (!slot) return;
    var real = (folders || []).slice().sort(function(a, b) {
      if (a === 'general') return -1;
      if (b === 'general') return 1;
      return a.localeCompare(b);
    });
    var active = _state.activeFolder;
    slot.innerHTML = real.map(function(f) {
      var isActive = (f === active) ? ' active' : '';
      var count = (bucket && bucket[f] && bucket[f].length) || 0;
      var countBadge = count
        ? ' <span style="opacity:0.5;font-size:10px;margin-left:auto;">' + count + '</span>'
        : '';
      return '<button class="tab-btn app-nav-child' + isActive + '" data-tab="my-files" data-myfiles-folder="' +
        escapeAttr(f) + '" title="' + escapeAttr(prettyFolder(f)) + '">' +
        '<span class="app-nav-label">' + escapeHTML(prettyFolder(f)) + '</span>' + countBadge +
      '</button>';
    }).join('');
  }

  // Attach the breakpoint listener once; it re-paints My Files so the
  // rail hops between the sidebar and the page column on resize.
  function ensureFilesSubnavMql() {
    if (window.matchMedia && !_filesSubnavMql) {
      _filesSubnavMql = window.matchMedia('(max-width: 768px)');
      _filesSubnavMqlHandler = function () {
        if (!_filesMounted) return;
        var pane = document.getElementById('my-files');
        if (pane) paint(pane);
      };
      if (_filesSubnavMql.addEventListener) _filesSubnavMql.addEventListener('change', _filesSubnavMqlHandler);
      else if (_filesSubnavMql.addListener) _filesSubnavMql.addListener(_filesSubnavMqlHandler);
    }
  }

  // Called by app.js switchTab when leaving the My Files tab: drop the
  // breakpoint listener and yank any stale legacy wrapper. The folder
  // accordion children stay in place — they're a permanent part of the
  // sidebar now (mirrors how Admin's children persist) so when the user
  // comes back to My Files (or hits a folder from another page) the
  // tree is already painted.
  function filesSidebarCleanup() {
    _filesMounted = false;
    if (_filesSubnavMql && _filesSubnavMqlHandler) {
      if (_filesSubnavMql.removeEventListener) _filesSubnavMql.removeEventListener('change', _filesSubnavMqlHandler);
      else if (_filesSubnavMql.removeListener) _filesSubnavMql.removeListener(_filesSubnavMqlHandler);
    }
    _filesSubnavMql = null;
    _filesSubnavMqlHandler = null;
    var nav = document.getElementById('app-filesnav');
    if (nav) nav.remove();
  }
  window.myFilesSidebarCleanup = filesSidebarCleanup;

  function paint(pane) {
    var files = _state.files;
    var bucket = groupByFolder(files);
    var folders = Object.keys(bucket).sort(function(a, b) {
      if (a === 'general') return -1;
      if (b === 'general') return 1;
      return a.localeCompare(b);
    });
    if (!folders.length) folders = ['general'];

    // NOTE: this paint() path is the LEGACY browser, kept only as the
    // fallback for when the Explorer module (js/file-explorer.js) fails to
    // load — mountExplorerInto() is the normal My Files view. The old
    // virtual folders (Projects / Field Tools / Printouts) graduated to
    // their own top-level tabs, so nothing renders them here anymore.
    if (folders.indexOf(_state.activeFolder) === -1) {
      _state.activeFolder = folders[0];
    }
    var activeFiles = bucket[_state.activeFolder] || [];

    // Header: title + action cluster (New folder + Upload). Folder
    // navigation is owned by the main sidebar accordion now
    // (syncSidebarFolders), so the in-page two-column layout was
    // removed on desktop — the page just renders header + drop-zone
    // + grid. Mobile still drops a compact rail above the grid
    // (folder switcher when no sidebar).
    var headerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap;">' +
          '<div>' +
            '<h1 style="font-size:22px;margin:0 0 2px 0;font-weight:700;color:var(--text,#fff);">My Files</h1>' +
            '<p style="margin:0;color:var(--text-dim,#888);font-size:12px;">Your personal files. Drag any file into a job or estimate when needed.</p>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            // New folder + Upload as a paired action cluster.
            '<button class="ee-btn secondary" onclick="window.myFiles.newFolder()" title="Create a new folder">+ New folder</button>' +
            '<button class="ee-btn primary" data-p86-icon="plus" onclick="document.getElementById(\'mfFileInput\').click();">Upload</button>' +
            '<input type="file" id="mfFileInput" multiple style="display:none;" onchange="window.myFiles.handleUpload(this.files); this.value=\'\';" />' +
            '<span class="p86-ask86-mount"></span>' +
          '</div>' +
        '</div>';

    var errorHTML = _state.error
      ? '<div style="padding:14px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:8px;color:#f87171;font-size:13px;margin-bottom:14px;">' + escapeHTML(_state.error) + '</div>'
      : '';

    // Folder rail interior. The .mf-rail-* classes are standalone (not
    // scoped under .mf-rail) so they style correctly whether wrapped in an
    // in-page <aside class="mf-rail"> (mobile) or injected into the
    // #app-filesnav sidebar wrapper (desktop). Blends Claude's clean
    // section structure (small uppercase headers, quiet item rows,
    // top-aligned quick action) with the node-graph library's dark
    // Project 86 palette and typography.
    var railInner =
        '<button class="mf-rail-action" onclick="window.myFiles.newFolder()" title="Create a new folder">' +
          '<span class="mf-rail-action-icon">+</span>' +
          '<span class="mf-rail-action-label">New folder</span>' +
        '</button>' +

        '<div class="mf-rail-section-head">Folders</div>' +
        '<div class="mf-rail-list">' +
          renderFolderTree(folders, bucket) +
        '</div>';

    // Right pane — drop zone + the file grid for the active folder.
    var mainPaneHTML =
        '<div>' +
          '<div id="mfDropZone" data-mf-drop="1" style="border:2px dashed var(--border,#444);border-radius:10px;padding:14px;text-align:center;background:rgba(79,140,255,0.04);margin-bottom:14px;cursor:pointer;font-size:12px;color:var(--text-dim,#888);">' +
            'Drop files here or <strong style="color:var(--accent,#22d3ee);">click Upload</strong> &middot; Files land in <strong>' + escapeHTML(prettyFolder(_state.activeFolder)) + '</strong>' +
          '</div>' +
          (activeFiles.length === 0
            ? '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);font-size:12px;border:1px dashed var(--border,#333);border-radius:10px;">' +
              'No files in this folder yet.' +
            '</div>'
            : renderFileGrid(activeFiles)) +
        '</div>';

    // Desktop: the sidebar accordion under the My Files row owns the
    // folder navigator (syncSidebarFolders below). The page just shows
    // header + drop-zone + grid. Mobile / no sidebar: keep the original
    // in-page two-col layout so folders are still reachable.
    var useSidebar = !filesSubnavIsMobile() && !!document.getElementById('app-sidebar');
    var body = useSidebar
      ? (headerHTML + errorHTML + mainPaneHTML)
      : (headerHTML + errorHTML +
          '<div class="mf-layout">' +
            '<aside class="mf-rail">' + railInner + '</aside>' +
            mainPaneHTML +
          '</div>');

    pane.innerHTML = '<div style="max-width:1200px;margin:0 auto;padding:24px 16px;">' + body + '</div>';

    // Yank the legacy #app-filesnav wrapper if any session ever
    // mounted it (defensive cleanup — should be a no-op now).
    placeFilesSidebar();
    // Sync the dynamic folder children into the My Files accordion.
    // Empty on first paint if folders haven't loaded yet; the next
    // paint after the load fills it.
    if (useSidebar) syncSidebarFolders(folders, bucket);
    ensureFilesSubnavMql();
    _filesMounted = true;

    // Wire drop zone
    var drop = pane.querySelector('#mfDropZone');
    if (drop) {
      drop.ondragover = function(e) { e.preventDefault(); drop.style.borderColor = 'var(--accent,#22d3ee)'; drop.style.background = 'rgba(34,211,238,0.10)'; };
      drop.ondragleave = function() { drop.style.borderColor = ''; drop.style.background = ''; };
      drop.ondrop = function(e) {
        e.preventDefault();
        drop.style.borderColor = '';
        drop.style.background = '';
        if (e.dataTransfer && e.dataTransfer.files) handleUpload(e.dataTransfer.files);
      };
      drop.onclick = function(e) {
        if (e.target === drop) document.getElementById('mfFileInput').click();
      };
    }

    // Delegated tile-click handler — opens the lightbox for images,
    // a new tab for non-images. Idempotent: a flag on the pane keeps
    // us from stacking listeners across re-paints.
    if (!pane.dataset.mfClicksWired) {
      wireTileClicks(pane);
      pane.dataset.mfClicksWired = '1';
    }
  }

  // Lift uploader initials + clock-time formatting locally so the My
  // Files tile mirrors the project tile's footer exactly without
  // depending on projects.js being loaded first.
  function initialsOf(name) {
    if (!name) return '';
    var parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function fmtTime(d) {
    if (!d) return '';
    try {
      return new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function renderFileGrid(files) {
    // Render the EXACT same .p86-proj-photo-tile structure the project
    // photo grid uses: visual on top, checkbox top-left, ⋮ menu
    // top-right, uploader initials + badges bottom-corners, then a
    // "time · uploader" footer. The four My Files actions
    // (download / send / copy / delete) live INSIDE the ⋮ menu rather
    // than a separate button strip, matching the project tile's
    // single-source-of-truth menu pattern.
    var html = '<div class="mf-grid">';
    files.forEach(function(a) {
      var isImg = isImage(a);
      var visual;
      if (isImg) {
        visual = '<img src="' + escapeAttr(a.thumb_url) + '" alt="" class="p86-proj-photo-tile-img" />';
      } else {
        var ext = (a.filename || '').split('.').pop().slice(0, 4).toUpperCase() || 'DOC';
        visual = '<div class="p86-proj-photo-tile-doc">' + escapeHTML(ext) + '</div>';
      }
      var uploaderName = a.uploaded_by_name || '';
      var uploaderInitials = uploaderName ? initialsOf(uploaderName) : '';
      var time = fmtTime(a.uploaded_at);
      var dateStr = fmtDate(a.uploaded_at);
      html += '<div class="p86-proj-photo-tile mf-tile" data-file-id="' + escapeAttr(a.id) + '" data-is-image="' + (isImg ? '1' : '0') + '">' +
        '<div class="p86-proj-photo-tile-visual mf-tile-visual" title="' + (isImg ? 'Click to open' : 'Click to download') + '">' +
          visual +
          // Checkbox kept as a structural placeholder so the visual
          // matches the project tile spacing. Selection-based bulk
          // ops aren't wired up here yet, but the slot reads as a
          // future affordance and avoids a layout shift later.
          '<label class="p86-proj-photo-tile-checkbox" onclick="event.stopPropagation();">' +
            '<input type="checkbox" class="mf-tile-checkbox" />' +
          '</label>' +
          '<button type="button" class="p86-proj-photo-tile-menu mf-tile-menu" title="More">&#x22EE;</button>' +
          (uploaderInitials
            ? '<span class="p86-proj-photo-tile-uploader" title="' + escapeAttr(uploaderName) + '">' + escapeHTML(uploaderInitials) + '</span>'
            : '') +
        '</div>' +
        // Two-line footer: filename on top (the "title" the user asked
        // for), then a meta row with date · time · uploader. Filename
        // ellipses cleanly when long so the tile keeps its grid shape.
        '<div class="p86-proj-photo-tile-footer mf-tile-footer">' +
          '<div class="mf-tile-title" title="' + escapeAttr(a.filename) + '">' + escapeHTML(a.filename) + '</div>' +
          '<div class="mf-tile-meta">' +
            '<span class="mf-tile-when">' + escapeHTML(dateStr) + (time ? ' &middot; ' + escapeHTML(time) : '') + '</span>' +
            (uploaderName ? '<span class="mf-tile-by">' + escapeHTML(uploaderName) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  // Delegated tile click handler. Splits the surface into three
  // concerns: ⋮ menu (open the My Files action menu anchored to the
  // button), checkbox (no-op for now — kept for visual parity with
  // project tiles), and the visual area (open file via lightbox /
  // new tab).
  function wireTileClicks(pane) {
    if (!pane) return;
    pane.addEventListener('click', function(e) {
      // ⋮ menu wins regardless of where in the tile it landed.
      var menuBtn = e.target.closest('.mf-tile-menu');
      if (menuBtn) {
        e.stopPropagation();
        var tileForMenu = menuBtn.closest('.mf-tile');
        var fileForMenu = tileForMenu
          ? (_state.files || []).find(function(x) { return String(x.id) === String(tileForMenu.getAttribute('data-file-id')); })
          : null;
        if (fileForMenu) openFileMenu(fileForMenu, menuBtn);
        return;
      }
      // Checkbox container — let the native click toggle the box but
      // don't open the file.
      if (e.target.closest('.p86-proj-photo-tile-checkbox')) return;
      // Otherwise: click on the image opens it.
      var visual = e.target.closest('.mf-tile-visual');
      if (!visual) return;
      var tile = visual.closest('.mf-tile');
      if (!tile) return;
      var fileId = tile.getAttribute('data-file-id');
      var file = (_state.files || []).find(function(x) { return String(x.id) === String(fileId); });
      if (!file) return;
      if (tile.getAttribute('data-is-image') === '1') {
        if (window.p86Attachments && typeof window.p86Attachments.openLightbox === 'function') {
          // Pass only the images so swipe doesn't land on a PDF tile.
          var images = (_state.files || []).filter(isImage);
          var idx = images.findIndex(function(x) { return String(x.id) === String(fileId); });
          window.p86Attachments.openLightbox(images, Math.max(0, idx), {
            parentLabel: 'My Files',
            parentSubtitle: _state.activeFolder
              ? (_state.activeFolder.charAt(0).toUpperCase() + _state.activeFolder.slice(1))
              : ''
          });
        } else {
          // Fallback if attachments.js isn't loaded — just open original.
          window.open(file.original_url, '_blank', 'noopener');
        }
      } else if (isPdfFile(file)) {
        // PDF → open the markup viewer (PDF substrate) so it can be annotated /
        // measured, instead of dumping the raw file in a new tab.
        openAnnotate(file);
      } else {
        // Other non-image files: open the original in a new tab (download/view).
        window.open(file.original_url, '_blank', 'noopener');
      }
    });
  }

  // Floating action menu anchored to the ⋮ button. Mirrors the project
  // photo tile's menu pattern but with My Files-specific actions
  // (download / send / copy / delete) instead of caption/tags/cover.
  function openFileMenu(file, anchor) {
    var prior = document.getElementById('mf-file-menu');
    if (prior) prior.remove();
    var menu = document.createElement('div');
    menu.id = 'mf-file-menu';
    menu.className = 'p86-proj-photo-menu mf-file-menu';
    menu.innerHTML =
      ((isImage(file) || isPdfFile(file)) ? '<button data-act="annotate">&#x270E; Annotate / mark up</button>' : '') +
      '<a href="' + escapeAttr(file.original_url) + '" download="' + escapeAttr(file.filename) + '" target="_blank" rel="noopener" data-act="download">&#x2B07; Download</a>' +
      '<button data-act="send">&#x27A4; Send to job / estimate</button>' +
      '<button data-act="copy">&#x2398; Copy to job / estimate</button>' +
      '<button data-act="delete" class="danger">&times; Delete</button>';
    document.body.appendChild(menu);

    var rect = anchor.getBoundingClientRect();
    menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    menu.style.left = Math.max(8, rect.right - menu.offsetWidth + window.scrollX) + 'px';

    function close() { menu.remove(); document.removeEventListener('click', onOutside); }
    function onOutside(e) { if (!menu.contains(e.target)) close(); }
    setTimeout(function() { document.addEventListener('click', onOutside); }, 0);

    menu.querySelectorAll('[data-act]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        var act = el.getAttribute('data-act');
        // Download — let the native <a download> handle it, then just close.
        if (act === 'download') { close(); return; }
        e.preventDefault();
        if (act === 'annotate') openAnnotate(file);
        else if (act === 'send') openSendPicker(file.id, 'move');
        else if (act === 'copy') openSendPicker(file.id, 'copy');
        else if (act === 'delete') deleteFile(file.id);
        close();
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Public actions (called from inline onclicks)
  // ──────────────────────────────────────────────────────────────────
  function selectFolder(name) {
    // Folder navigation is owned by the Explorer now. Projects / Field
    // Tools / Printouts each graduated to their own top-level tab, so the
    // old virtual-folder deep-link is gone — every selection just (re)mounts
    // the Explorer, which has its own folder tree. `name` is accepted for
    // backward-compat with the delegated data-myfiles-folder handler but no
    // longer drives a special view.
    _state.activeFolder = 'general';
    mountExplorerInto(document.getElementById('my-files'));
  }

  // Create a new folder. If the user is currently viewing a real
  // folder (not virtual / not 'general'), the new folder is created as
  // a CHILD of it. From 'general' or a virtual folder, the new folder
  // is a top-level entry. The user can override by entering a path
  // with `/` directly (e.g. "jobs/smith").
  function newFolder() {
    var cur = _state.activeFolder;
    var asChildOf = (cur && cur !== 'general') ? cur : '';
    var promptLabel = asChildOf
      ? 'New folder under "' + prettyFolder(asChildOf) + '"\n(or use a/b/c for deeper paths)'
      : 'New folder name\n(use a/b for subfolders, e.g. "jobs/smith")';
    var name = window.prompt(promptLabel, '');
    if (name == null) return;
    var raw = String(name).trim();
    if (!raw) return;
    // If the user already wrote a slash, treat the input as an
    // absolute path. Otherwise prefix with the current folder.
    var pathInput = (raw.indexOf('/') !== -1 || !asChildOf) ? raw : (asChildOf + '/' + raw);
    var folder = sanitizeFolder(pathInput);
    if (!folder || folder === 'general') return;
    _state.activeFolder = folder;
    // Pre-expand the path so the new folder is visible immediately.
    var p = folderParent(folder);
    while (p) {
      _state.expandedFolders[p] = true;
      p = folderParent(p);
    }
    // No row to insert until a file lands; just preselect so the next
    // upload goes into this folder.
    paint(document.getElementById('my-files'));
  }

  function toggleFolder(path) {
    if (_state.expandedFolders[path]) delete _state.expandedFolders[path];
    else _state.expandedFolders[path] = true;
    paint(document.getElementById('my-files'));
  }

  function handleUpload(fileList) {
    if (!fileList || !fileList.length) return;
    var uid = currentUserId();
    if (!uid) return;
    var files = Array.from(fileList);
    var maxBytes = 50 * 1024 * 1024;
    var chain = Promise.resolve();
    files.forEach(function(f) {
      if (f.size > maxBytes) {
        alert('"' + f.name + '" is over 50MB and was skipped.');
        return;
      }
      chain = chain.then(function() {
        return window.p86Api.attachments.upload('user', String(uid), f, { folder: _state.activeFolder })
          .catch(function(err) { alert('Upload failed for "' + f.name + '": ' + (err.message || err)); });
      });
    });
    chain.then(fetchFiles).then(function() { paint(document.getElementById('my-files')); });
  }

  // ──────────────────────────────────────────────────────────────────
  // Quick Photo capture — context-free camera/upload entry point.
  // Reached from the header "+" menu (New Photo) WITHOUT first opening a
  // job, mirroring Buildertrend's mobile "Take Photo". Injects a hidden
  // file input (camera on mobile via capture=environment), then streams
  // each picked image into the user's personal files under a dedicated
  // `quick-captures` folder — the SAME upload pipeline My Files uses,
  // just with a fixed folder and no entity required. Exposed as
  // window.p86QuickPhoto so the menu item's inline onclick can call it.
  // ──────────────────────────────────────────────────────────────────
  function quickPhoto() {
    var uid = currentUserId();
    if (!uid) { alert('Please sign in to capture photos.'); return; }

    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment'); // rear camera on mobile
    input.multiple = true;
    // Keep it off-screen rather than display:none — some mobile browsers
    // refuse to open the picker for a fully hidden input.
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);

    function removeInput() { if (input.parentNode) input.parentNode.removeChild(input); }

    input.addEventListener('change', function() {
      var files = Array.from(input.files || []);
      removeInput();
      if (!files.length) return;
      var maxBytes = 50 * 1024 * 1024;
      var ok = 0, failed = 0;
      var chain = Promise.resolve();
      files.forEach(function(f) {
        if (f.size > maxBytes) { failed++; return; }
        chain = chain.then(function() {
          return window.p86Api.attachments.upload('user', String(uid), f, { folder: 'quick-captures' })
            .then(function() { ok++; })
            .catch(function() { failed++; });
        });
      });
      chain.then(function() {
        var msg = ok
          ? (ok + ' photo' + (ok === 1 ? '' : 's') + ' saved to My Files › quick-captures'
             + (failed ? ' (' + failed + ' failed)' : ''))
          : ('No photos were saved' + (failed ? ' (' + failed + ' failed)' : '') + '.');
        notify(msg, ok ? 'success' : 'error');
        // If the My Files pane is mounted, refresh it so the new captures
        // appear immediately; otherwise skip the network round-trip.
        if (_filesMounted) {
          fetchFiles().then(function() { paint(document.getElementById('my-files')); });
        }
      });
    });

    // Cancel fallback: when the picker closes with no selection the window
    // regains focus but `change` never fires — clean up the orphan input
    // so repeated cancels don't accumulate hidden nodes.
    window.addEventListener('focus', function onFocus() {
      setTimeout(function() { if (!input.files || !input.files.length) removeInput(); }, 400);
    }, { once: true });

    input.click();
  }

  // Minimal toast — the app has no shared toast component yet, so this
  // self-contained helper renders a brief bottom-center notification with
  // inline styles (no CSS dependency). Also published as window.p86Toast
  // so modules that already probe for it (field-tools.js) get a real
  // implementation instead of silently no-op'ing.
  function notify(message, kind) {
    try {
      var host = document.getElementById('p86-toast-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'p86-toast-host';
        host.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
          'z-index:99999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
        document.body.appendChild(host);
      }
      var el = document.createElement('div');
      var bg = kind === 'error' ? '#7f1d1d' : (kind === 'success' ? '#14532d' : '#1f2937');
      el.style.cssText = 'pointer-events:auto;max-width:90vw;padding:10px 16px;border-radius:8px;' +
        'color:#fff;font-size:13px;line-height:1.4;box-shadow:0 6px 20px rgba(0,0,0,.35);' +
        'opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;background:' + bg + ';';
      el.textContent = String(message == null ? '' : message);
      host.appendChild(el);
      requestAnimationFrame(function() { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
      setTimeout(function() {
        el.style.opacity = '0'; el.style.transform = 'translateY(8px)';
        setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
      }, 3200);
    } catch (e) { /* a toast must never break the calling flow */ }
  }

  function deleteFile(id) {
    if (!window.confirm('Delete this file? This cannot be undone.')) return;
    window.p86Api.attachments.remove(id)
      .then(fetchFiles)
      .then(function() { paint(document.getElementById('my-files')); })
      .catch(function(err) { alert('Delete failed: ' + (err.message || err)); });
  }

  // ──────────────────────────────────────────────────────────────────
  // Send-to-entity picker — used for both Move and Copy.
  // Lists every job + estimate the user can see, with a folder name
  // input. Click Move/Copy → routes to the matching API method.
  // ──────────────────────────────────────────────────────────────────
  function openSendPicker(attId, mode) {
    var prior = document.getElementById('mfSendPicker');
    if (prior) prior.remove();

    var jobs = ((window.appData && window.appData.jobs) || []).filter(function(j) {
      var s = (j && j.status || '').toLowerCase();
      return s !== 'closed' && s !== 'archived' && s !== 'completed';
    });
    var ests = (window.appData && window.appData.estimates) || [];
    var leads = (window.appData && window.appData.leads) || [];

    var modal = document.createElement('div');
    modal.id = 'mfSendPicker';
    modal.className = 'modal active';
    var actionLabel = mode === 'copy' ? 'Copy to' : 'Move to';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:500px;">' +
        '<div class="modal-header">' + actionLabel + '&hellip;</div>' +
        '<div style="font-size:12px;color:var(--text-dim,#aaa);margin-bottom:10px;">' +
          (mode === 'copy'
            ? 'Make a copy on the destination. The original stays in your files.'
            : 'Move the file out of your files into the destination.') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:10px;">' +
          '<div>' +
            '<label style="font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:0.4px;font-weight:600;display:block;margin-bottom:4px;">Destination type</label>' +
            '<select id="mfDestType" style="width:100%;padding:7px 10px;font-size:13px;">' +
              '<option value="job">Job</option>' +
              '<option value="estimate">Estimate</option>' +
              '<option value="lead">Lead</option>' +
            '</select>' +
          '</div>' +
          '<div>' +
            '<label style="font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:0.4px;font-weight:600;display:block;margin-bottom:4px;">Destination</label>' +
            '<select id="mfDestId" style="width:100%;padding:7px 10px;font-size:13px;">' +
              jobs.map(function(j) {
                var label = (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.name || j.id);
                return '<option value="job::' + escapeAttr(j.id) + '">' + escapeHTML(label) + '</option>';
              }).join('') +
            '</select>' +
            '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:4px;">List filters by destination type below.</div>' +
          '</div>' +
          '<div>' +
            '<label style="font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:0.4px;font-weight:600;display:block;margin-bottom:4px;">Folder (optional)</label>' +
            '<input id="mfDestFolder" type="text" placeholder="general" style="width:100%;padding:7px 10px;font-size:13px;" />' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">' +
          '<button class="ee-btn secondary" data-close>Cancel</button>' +
          '<button class="primary" data-mf-confirm style="font-size:13px;">' + actionLabel + ' file</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    function rebuildDestList() {
      var typeEl = modal.querySelector('#mfDestType');
      var idEl = modal.querySelector('#mfDestId');
      var t = typeEl.value;
      var pool = t === 'job' ? jobs : t === 'estimate' ? ests : leads;
      idEl.innerHTML = pool.map(function(item) {
        var label;
        if (t === 'job') label = (item.jobNumber ? '[' + item.jobNumber + '] ' : '') + (item.title || item.name || item.id);
        else if (t === 'estimate') label = item.title || ('Estimate ' + item.id);
        else label = item.title || item.name || ('Lead ' + item.id);
        return '<option value="' + t + '::' + escapeAttr(item.id) + '">' + escapeHTML(label) + '</option>';
      }).join('') || '<option value="">No ' + t + 's available</option>';
    }
    modal.querySelector('#mfDestType').addEventListener('change', rebuildDestList);

    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.remove();
    });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { modal.remove(); });
    });
    modal.querySelector('[data-mf-confirm]').addEventListener('click', function() {
      var combo = modal.querySelector('#mfDestId').value || '';
      var parts = combo.split('::');
      if (parts.length !== 2) { alert('Pick a destination.'); return; }
      var entityType = parts[0];
      var entityId = parts[1];
      var folder = sanitizeFolder(modal.querySelector('#mfDestFolder').value);
      var fn = mode === 'copy' ? window.p86Api.attachments.copy : window.p86Api.attachments.move;
      fn(attId, { entity_type: entityType, entity_id: entityId, folder: folder })
        .then(function() {
          modal.remove();
          if (mode === 'move') {
            // The file just left My Files — re-fetch to drop it from the grid.
            fetchFiles().then(function() { paint(document.getElementById('my-files')); });
          }
        })
        .catch(function(err) {
          alert((mode === 'copy' ? 'Copy' : 'Move') + ' failed: ' + (err.message || err));
        });
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Printouts — saved field-tool runs (receipts)
  //
  // The right pane lists every run the current user has saved, grouped
  // by tool. Each row shows the tool name, when it was run, the notes
  // preview, and a "View" button that pops a print-friendly receipt
  // modal (header + inputs/outputs tables + notes + footer). Print uses
  // a dedicated @media print block in styles.css so the receipt drops
  // out clean of all chrome.
  // ──────────────────────────────────────────────────────────────────
  var _printoutsCache = { runs: null, loadedAt: 0 };
  // The element the printouts list is currently mounted into. Set on
  // every render so refresh / delete re-paint the right host — which is
  // now the Field Tools › Printouts sub-view host (not the retired
  // My Files __printouts__ pane).
  var _printoutsHost = null;

  function fetchPrintouts() {
    return window.p86Api.get('/api/field-tools/runs')
      .then(function(resp) {
        _printoutsCache = {
          runs: (resp && resp.runs) || [],
          loadedAt: Date.now()
        };
      })
      .catch(function(err) {
        _printoutsCache = { runs: null, loadedAt: 0, error: err.message || 'Failed to load' };
      });
  }

  function renderPrintoutsList(host) {
    _printoutsHost = host;
    host.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);font-size:13px;">Loading printouts…</div>';
    fetchPrintouts().then(function() { paintPrintoutsList(host); });
  }

  function paintPrintoutsList(host) {
    if (host) _printoutsHost = host;
    if (_printoutsCache.error) {
      host.innerHTML = '<div style="padding:20px;color:#e74c3c;">' + escapeHTML(_printoutsCache.error) + '</div>';
      return;
    }
    var runs = _printoutsCache.runs || [];
    var header =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:14px;flex-wrap:wrap;">' +
        '<div>' +
          '<h2 style="margin:0;font-size:18px;font-weight:600;">Printouts</h2>' +
          '<div style="font-size:12px;color:var(--text-dim,#888);margin-top:2px;">' +
            'Saved snapshots of field-tool runs. Open one and print for a paper receipt.' +
          '</div>' +
        '</div>' +
        '<button type="button" class="ee-btn secondary" onclick="window.myFiles.refreshPrintouts()">↻ Refresh</button>' +
      '</div>';

    if (!runs.length) {
      host.innerHTML = header +
        '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);font-size:12px;border:1px dashed var(--border,#333);border-radius:10px;">' +
          'No printouts yet. Open a field tool, run a calculation, then click <strong>💾 Save Printout</strong>.' +
        '</div>';
      return;
    }

    // Group by tool so a busy user can scan-by-purpose.
    var groups = {};
    runs.forEach(function(r) {
      var k = r.field_tool_id;
      if (!groups[k]) groups[k] = { name: r.field_tool_name || 'Tool ' + k, runs: [] };
      groups[k].runs.push(r);
    });

    var html = header;
    Object.keys(groups).forEach(function(toolId) {
      var g = groups[toolId];
      html += '<div style="margin-bottom:20px;">' +
        '<div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--text-dim,#888);margin-bottom:6px;font-weight:600;">' +
          escapeHTML(g.name) + ' <span style="color:#555;">(' + g.runs.length + ')</span>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px;">';
      g.runs.forEach(function(r) {
        var date = fmtDate(r.created_at);
        var time = fmtTime(r.created_at);
        var preview = r.notes ? escapeHTML(String(r.notes).slice(0, 120)) : '<span style="color:#555;">no notes</span>';
        var io = [];
        if (r.inputs && Object.keys(r.inputs).length) io.push(Object.keys(r.inputs).length + ' input' + (Object.keys(r.inputs).length === 1 ? '' : 's'));
        if (r.outputs && Object.keys(r.outputs).length) io.push(Object.keys(r.outputs).length + ' output' + (Object.keys(r.outputs).length === 1 ? '' : 's'));
        var ioLabel = io.length ? io.join(' · ') : 'no captured data';
        html += '<div class="mf-printout-row" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#141414;border:1px solid #222;border-radius:6px;cursor:pointer;" onclick="window.myFiles.openPrintout(\'' + escapeAttr(r.id) + '\')">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:13px;color:var(--text,#e8e0d0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + preview + '</div>' +
            '<div style="font-size:10px;color:var(--text-dim,#666);margin-top:2px;">' +
              escapeHTML(date) + (time ? ' · ' + escapeHTML(time) : '') + ' · ' + escapeHTML(ioLabel) +
              (r.user_name ? ' · ' + escapeHTML(r.user_name) : '') +
            '</div>' +
          '</div>' +
          '<button type="button" class="ee-btn secondary" style="font-size:11px;flex-shrink:0;" onclick="event.stopPropagation();window.myFiles.openPrintout(\'' + escapeAttr(r.id) + '\')">View</button>' +
          '<button type="button" class="ee-btn secondary" style="font-size:11px;flex-shrink:0;" title="Delete" onclick="event.stopPropagation();window.myFiles.deletePrintout(\'' + escapeAttr(r.id) + '\')">×</button>' +
        '</div>';
      });
      html += '</div></div>';
    });
    host.innerHTML = html;
  }

  // Receipt viewer — print-friendly. Styled to look like a real
  // construction-services receipt: serif-leaning headline, monospace
  // numbers, dashed dividers like a paper receipt. All markup lives
  // under CSS classes so styles.css owns the look; this function
  // only assembles the data.
  function openPrintout(id) {
    if (!id) return;
    window.p86Api.get('/api/field-tools/runs/' + encodeURIComponent(id)).then(function(resp) {
      if (!resp || !resp.run) { alert('Printout not found.'); return; }
      var r = resp.run;
      var inputs = r.inputs || {};
      var outputs = r.outputs || {};

      var d = null;
      try { d = new Date(r.created_at); } catch (e) {}
      var dateStr = d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      var timeStr = d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

      // Org name — pull from the auth user; fall back gracefully.
      var orgName = '';
      try {
        var u = window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser();
        orgName = (u && (u.organization_name || u.org_name)) || '';
      } catch (e) {}

      // Short reference code derived from the run id — looks
      // intentional ("FT-1234567") instead of a long random slug.
      var refCode = 'FT-' + String(r.id || '').replace(/[^0-9]/g, '').slice(-7).padStart(7, '0');

      var modal = document.createElement('div');
      modal.className = 'mf-printout-viewer';

      modal.innerHTML =
        '<div class="ft-receipt">' +
          // Dark chrome bar — hidden on print
          '<div class="ft-receipt-chrome">' +
            '<div class="ft-receipt-chrome-title">Printout · ' + escapeHTML(refCode) + '</div>' +
            '<div class="ft-receipt-chrome-actions">' +
              '<button type="button" class="ft-receipt-btn primary" id="ftReceiptPrint">' +
                '<span style="margin-right:4px;">🖨</span>Print' +
              '</button>' +
              '<button type="button" class="ft-receipt-btn" id="ftReceiptClose">Close</button>' +
            '</div>' +
          '</div>' +
          // The actual paper-feel receipt
          '<div class="ft-receipt-paper">' +
            // Brand strip
            '<div class="ft-receipt-brand">' +
              (orgName
                ? '<div class="ft-receipt-org">' + escapeHTML(orgName) + '</div>'
                : '') +
              '<div class="ft-receipt-eyebrow">Field-Tool Record</div>' +
            '</div>' +
            // Title block
            '<div class="ft-receipt-title-block">' +
              '<div class="ft-receipt-title">' + escapeHTML(r.field_tool_name || 'Field Tool') + '</div>' +
              (r.field_tool_description
                ? '<div class="ft-receipt-subtitle">' + escapeHTML(r.field_tool_description) + '</div>'
                : '') +
            '</div>' +
            // Meta row — ref / date / by
            '<dl class="ft-receipt-meta">' +
              '<div><dt>Ref</dt><dd>' + escapeHTML(refCode) + '</dd></div>' +
              '<div><dt>Date</dt><dd>' + escapeHTML(dateStr) + (timeStr ? '  ·  ' + escapeHTML(timeStr) : '') + '</dd></div>' +
              (r.user_name ? '<div><dt>By</dt><dd>' + escapeHTML(r.user_name) + '</dd></div>' : '') +
              (r.field_tool_category ? '<div><dt>Type</dt><dd>' + escapeHTML(r.field_tool_category) + '</dd></div>' : '') +
            '</dl>' +
            '<div class="ft-receipt-divider"></div>' +
            buildReceiptKV('Inputs', inputs) +
            (Object.keys(outputs).length ? '<div class="ft-receipt-divider"></div>' : '') +
            buildReceiptKV('Results', outputs, true) +
            (r.notes
              ? '<div class="ft-receipt-divider"></div>' +
                '<div class="ft-receipt-notes-section">' +
                  '<div class="ft-receipt-section-head">Notes</div>' +
                  '<div class="ft-receipt-notes-body">' + escapeHTML(r.notes) + '</div>' +
                '</div>'
              : '') +
            // Foot
            '<div class="ft-receipt-foot">' +
              '<div class="ft-receipt-foot-thanks">Thank you.</div>' +
              '<div class="ft-receipt-foot-sub">Saved to My Files · Printouts</div>' +
            '</div>' +
          '</div>' +
        '</div>';

      document.body.appendChild(modal);
      document.body.classList.add('ft-printing');

      function close() {
        document.body.classList.remove('ft-printing');
        modal.remove();
      }
      modal.querySelector('#ftReceiptClose').onclick = close;
      modal.querySelector('#ftReceiptPrint').onclick = function() { window.print(); };
      modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
    }).catch(function(err) {
      alert('Failed to open printout: ' + (err && err.message || 'unknown'));
    });
  }

  // K/V section for the receipt. `emphasize` adds a heavier weight +
  // monospace font for outputs/results so numbers line up cleanly.
  function buildReceiptKV(label, obj, emphasize) {
    var keys = Object.keys(obj || {});
    if (!keys.length) return '';
    var rows = keys.map(function(k) {
      var v = obj[k];
      var disp;
      if (v == null || v === '') disp = '—';
      else if (typeof v === 'object') disp = JSON.stringify(v);
      else disp = String(v);
      return '<div class="ft-receipt-kv-row' + (emphasize ? ' emph' : '') + '">' +
        '<div class="ft-receipt-kv-key">' + escapeHTML(k) + '</div>' +
        '<div class="ft-receipt-kv-dots"></div>' +
        '<div class="ft-receipt-kv-val">' + escapeHTML(disp) + '</div>' +
      '</div>';
    }).join('');
    return '<div class="ft-receipt-kv-section">' +
      '<div class="ft-receipt-section-head">' + escapeHTML(label) + '</div>' +
      '<div class="ft-receipt-kv-list">' + rows + '</div>' +
    '</div>';
  }

  function deletePrintout(id) {
    if (!id) return;
    if (!confirm('Delete this printout? This cannot be undone.')) return;
    window.p86Api.del('/api/field-tools/runs/' + encodeURIComponent(id))
      .then(fetchPrintouts)
      .then(function() {
        if (_printoutsHost) paintPrintoutsList(_printoutsHost);
      })
      .catch(function(err) { alert('Delete failed: ' + (err.message || err)); });
  }

  function refreshPrintouts() {
    if (_printoutsHost) renderPrintoutsList(_printoutsHost);
  }

  window.myFiles = {
    selectFolder: selectFolder,
    newFolder: newFolder,
    toggleFolder: toggleFolder,
    handleUpload: handleUpload,
    deleteFile: deleteFile,
    openSendPicker: openSendPicker,
    openPrintout: openPrintout,
    deletePrintout: deletePrintout,
    refreshPrintouts: refreshPrintouts,
    // Render the saved field-tool runs into an arbitrary host — used by the
    // Field Tools tab's Printouts sub-view (FS Phase 4) so Printouts no
    // longer needs the My Files __printouts__ virtual folder.
    renderPrintoutsInto: renderPrintoutsList,
    quickPhoto: quickPhoto,
    // Exposed so sidebar / other modules can trigger a re-sync of the
    // accordion children without forcing a full paint() of the page.
    syncSidebarFolders: function() {
      var bucket = groupByFolder(_state.files || []);
      var folders = Object.keys(bucket);
      syncSidebarFolders(folders, bucket);
    }
  };
  // Context-free entry point for the header "+" menu's "New Photo" item.
  window.p86QuickPhoto = quickPhoto;
  // Backfill the toast helper other modules already probe for.
  if (!window.p86Toast) window.p86Toast = { show: function(m, k) { notify(m, k); } };
})();
