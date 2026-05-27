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

  // Per-tab UI state. Re-built on every paint so refresh is consistent;
  // selected folder survives across re-renders within the same session.
  var _state = {
    files: [],
    activeFolder: 'general',
    loading: false,
    error: null
  };

  function currentUserId() {
    var u = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
    return u ? u.id : null;
  }

  // Sanitize a folder name to match the server's regex. Empty → 'general'.
  function sanitizeFolder(name) {
    return String(name || '').trim().slice(0, 60).toLowerCase()
      .replace(/[^a-z0-9 _\-]/g, '').replace(/\s+/g, '-') || 'general';
  }

  function prettyFolder(f) {
    if (!f || f === 'general') return 'General';
    return String(f).replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
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
    fetchFiles().then(function() { paint(pane); });
  }
  window.renderMyFilesTab = renderMyFilesTab;

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

  function paint(pane) {
    var files = _state.files;
    var bucket = groupByFolder(files);
    var folders = Object.keys(bucket).sort(function(a, b) {
      if (a === 'general') return -1;
      if (b === 'general') return 1;
      return a.localeCompare(b);
    });
    if (!folders.length) folders = ['general'];

    // Pin the virtual folders at the bottom. They don't store files —
    // when selected, the right pane renders a special view instead of
    // the file grid + upload zone. The double-underscore sentinel
    // ensures these can never collide with real folder names
    // (sanitizeFolder strips underscores at the edges).
    //
    //   __projects__ — CompanyCam-style photo + walkthrough buckets
    //                  with markups + reports. Owned by js/projects.js.
    //   __tools__    — field tools grid (calculators / take-offs etc).
    //                  Owned by js/field-tools.js.
    //
    // Future phases will add __reports__ (P2) and __takeoffs__ (P4)
    // pivots here.
    var PROJECTS_FOLDER = '__projects__';
    var TOOLS_FOLDER = '__tools__';
    if (folders.indexOf(PROJECTS_FOLDER) === -1) folders.push(PROJECTS_FOLDER);
    if (folders.indexOf(TOOLS_FOLDER) === -1) folders.push(TOOLS_FOLDER);

    if (folders.indexOf(_state.activeFolder) === -1) {
      _state.activeFolder = folders[0];
    }
    var isProjectsFolder = _state.activeFolder === PROJECTS_FOLDER;
    var isToolsFolder = _state.activeFolder === TOOLS_FOLDER;
    var isVirtualFolder = isProjectsFolder || isToolsFolder;
    var activeFiles = isVirtualFolder ? [] : (bucket[_state.activeFolder] || []);

    var html =
      '<div style="max-width:1200px;margin:0 auto;padding:24px 16px;">' +
        // Header
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap;">' +
          '<div>' +
            '<h1 style="font-size:22px;margin:0 0 2px 0;font-weight:700;color:var(--text,#fff);">My Files</h1>' +
            '<p style="margin:0;color:var(--text-dim,#888);font-size:12px;">Your personal files. Drag any file into a job or estimate when needed.</p>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            (isVirtualFolder
              ? '' // Virtual folders (Projects, Tools) own their own controls inside the pane
              : (
                  '<button class="ee-btn secondary" onclick="window.myFiles.newFolder()" style="font-size:12px;padding:6px 12px;">&#x1F4C1; New Folder</button>' +
                  '<button class="primary" onclick="document.getElementById(\'mfFileInput\').click();" style="font-size:13px;padding:7px 14px;">&#x2795; Upload</button>' +
                  '<input type="file" id="mfFileInput" multiple style="display:none;" onchange="window.myFiles.handleUpload(this.files); this.value=\'\';" />'
                )
            ) +
            '<span class="p86-ask86-mount"></span>' +
          '</div>' +
        '</div>' +

        (_state.error
          ? '<div style="padding:14px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:8px;color:#f87171;font-size:13px;margin-bottom:14px;">' + escapeHTML(_state.error) + '</div>'
          : '') +

        // Two-col: folder list (left) + file grid (right)
        '<div style="display:grid;grid-template-columns:200px minmax(0,1fr);gap:18px;align-items:flex-start;">' +
          // Folders rail
          '<div style="border:1px solid var(--border,#333);border-radius:10px;background:var(--card-bg,#0f0f1e);overflow:hidden;">' +
            '<div style="padding:8px 12px;border-bottom:1px solid var(--border,#333);font-size:10px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.4px;">Folders</div>' +
            folders.map(function(f, idx) {
              var active = f === _state.activeFolder;
              var isProjects = f === PROJECTS_FOLDER;
              var isTools = f === TOOLS_FOLDER;
              var isVirtual = isProjects || isTools;
              // Virtual rows: pinned at the bottom with a divider above
              // (only the FIRST virtual row gets the divider so they
              // group as one section) and a custom icon.
              var icon = isProjects ? '&#x1F4F8;' : (isTools ? '&#x1F527;' : '&#x1F4C1;');
              var label = isProjects ? 'Projects' : (isTools ? 'Tools' : prettyFolder(f));
              var n = isVirtual ? '' : (bucket[f] || []).length;
              // First virtual folder gets the divider line above; subsequent
              // virtual folders sit flush against the previous one.
              var prev = folders[idx - 1];
              var prevIsVirtual = prev === PROJECTS_FOLDER || prev === TOOLS_FOLDER;
              var divider = (isVirtual && !prevIsVirtual)
                ? 'border-top:1px solid var(--border,#333);margin-top:4px;padding-top:8px;'
                : '';
              return '<button class="mf-folder-row" data-folder="' + escapeAttr(f) + '" onclick="window.myFiles.selectFolder(\'' + escapeAttr(f) + '\')" ' +
                'style="display:flex;width:100%;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;background:' + (active ? 'rgba(34,211,238,0.10)' : 'transparent') + ';border:none;border-bottom:1px solid var(--border,#222);color:' + (active ? 'var(--accent,#22d3ee)' : 'var(--text,#fff)') + ';font-size:12px;font-weight:' + (active ? '600' : '400') + ';cursor:pointer;text-align:left;' + divider + '">' +
                '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + icon + ' ' + escapeHTML(label) + '</span>' +
                (n !== '' ? '<span style="font-size:10px;color:var(--text-dim,#888);">' + n + '</span>' : '') +
              '</button>';
            }).join('') +
          '</div>' +

          // Right pane — files for normal folders, virtual-pane host
          // for Projects / Tools. The host element gets a stable id so
          // the owning module can find it.
          '<div>' +
            (isProjectsFolder
              ? '<div id="mfProjectsHost" style="min-height:100px;"></div>'
              : isToolsFolder
                ? '<div id="mfToolsHost" style="min-height:100px;"></div>'
                : (
                    '<div id="mfDropZone" data-mf-drop="1" style="border:2px dashed var(--border,#444);border-radius:10px;padding:14px;text-align:center;background:rgba(79,140,255,0.04);margin-bottom:14px;cursor:pointer;font-size:12px;color:var(--text-dim,#888);">' +
                      'Drop files here or <strong style="color:var(--accent,#22d3ee);">click Upload</strong> &middot; Files land in <strong>' + escapeHTML(prettyFolder(_state.activeFolder)) + '</strong>' +
                    '</div>' +
                    (activeFiles.length === 0
                      ? '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);font-size:12px;border:1px dashed var(--border,#333);border-radius:10px;">' +
                        'No files in this folder yet.' +
                      '</div>'
                      : renderFileGrid(activeFiles))
                  )
            ) +
          '</div>' +
        '</div>' +
      '</div>';

    pane.innerHTML = html;

    // Projects folder: hand off the right pane to js/projects.js.
    if (isProjectsFolder) {
      var projectsHost = pane.querySelector('#mfProjectsHost');
      if (projectsHost && typeof window.renderProjectsInto === 'function') {
        window.renderProjectsInto(projectsHost);
      } else if (projectsHost) {
        projectsHost.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);">Projects module not loaded.</div>';
      }
      return; // skip drop-zone wiring — not relevant in Projects mode
    }

    // Tools folder: hand off the right pane to field-tools.js.
    if (isToolsFolder) {
      var toolsHost = pane.querySelector('#mfToolsHost');
      if (toolsHost && typeof window.renderFieldToolsInto === 'function') {
        window.renderFieldToolsInto(toolsHost);
      } else if (toolsHost) {
        toolsHost.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);">Field tools module not loaded.</div>';
      }
      return; // skip drop-zone wiring — not relevant in Tools mode
    }

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
        '<div class="p86-proj-photo-tile-footer">' +
          '<span class="p86-proj-photo-tile-time">' + escapeHTML(time) + '</span>' +
          (uploaderName ? '<span class="p86-proj-photo-tile-uploader-name">' + escapeHTML(uploaderName) + '</span>' : '') +
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
      } else {
        // Non-image: open the original file in a new tab. Browsers will
        // display PDFs inline, prompt download for everything else.
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
        if (act === 'send') openSendPicker(file.id, 'move');
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
    _state.activeFolder = name;
    paint(document.getElementById('my-files'));
  }

  function newFolder() {
    var name = window.prompt('New folder name', '');
    if (name == null) return;
    var folder = sanitizeFolder(name);
    if (!folder || folder === 'general') return;
    _state.activeFolder = folder;
    // No row to insert until a file lands; just preselect so the next
    // upload goes into this folder.
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

  window.myFiles = {
    selectFolder: selectFolder,
    newFolder: newFolder,
    handleUpload: handleUpload,
    deleteFile: deleteFile,
    openSendPicker: openSendPicker
  };
})();
