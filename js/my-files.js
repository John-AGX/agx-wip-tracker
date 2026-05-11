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

    // Pin the virtual "Tools" folder at the bottom. It doesn't store
    // files — when selected, the right pane renders field tools
    // instead of the file grid + upload zone. The double underscore
    // sentinel ensures it can never collide with a real folder name
    // (sanitizeFolder strips underscores at the edges).
    var TOOLS_FOLDER = '__tools__';
    if (folders.indexOf(TOOLS_FOLDER) === -1) folders.push(TOOLS_FOLDER);

    if (folders.indexOf(_state.activeFolder) === -1) {
      _state.activeFolder = folders[0];
    }
    var isToolsFolder = _state.activeFolder === TOOLS_FOLDER;
    var activeFiles = isToolsFolder ? [] : (bucket[_state.activeFolder] || []);

    var html =
      '<div style="max-width:1200px;margin:0 auto;padding:24px 16px;">' +
        // Header
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap;">' +
          '<div>' +
            '<h1 style="font-size:22px;margin:0 0 2px 0;font-weight:700;color:var(--text,#fff);">My Files</h1>' +
            '<p style="margin:0;color:var(--text-dim,#888);font-size:12px;">Your personal files. Drag any file into a job or estimate when needed.</p>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            (isToolsFolder
              ? '' // Tools folder owns its own "+ Add tool" / "↻ Refresh" controls inside the pane
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
            folders.map(function(f) {
              var active = f === _state.activeFolder;
              var isTools = f === TOOLS_FOLDER;
              // Tools row: pinned at the bottom with a divider above and
              // a wrench icon instead of the folder glyph so it reads as
              // a distinct section rather than another folder.
              var icon = isTools ? '&#x1F527;' : '&#x1F4C1;';
              var label = isTools ? 'Tools' : prettyFolder(f);
              var n = isTools ? '' : (bucket[f] || []).length;
              var divider = isTools ? 'border-top:1px solid var(--border,#333);margin-top:4px;padding-top:8px;' : '';
              return '<button class="mf-folder-row" data-folder="' + escapeAttr(f) + '" onclick="window.myFiles.selectFolder(\'' + escapeAttr(f) + '\')" ' +
                'style="display:flex;width:100%;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;background:' + (active ? 'rgba(34,211,238,0.10)' : 'transparent') + ';border:none;border-bottom:1px solid var(--border,#222);color:' + (active ? 'var(--accent,#22d3ee)' : 'var(--text,#fff)') + ';font-size:12px;font-weight:' + (active ? '600' : '400') + ';cursor:pointer;text-align:left;' + divider + '">' +
                '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + icon + ' ' + escapeHTML(label) + '</span>' +
                (n !== '' ? '<span style="font-size:10px;color:var(--text-dim,#888);">' + n + '</span>' : '') +
              '</button>';
            }).join('') +
          '</div>' +

          // Right pane — files for normal folders, field tools grid
          // for the virtual Tools folder. The host element gets a
          // stable id so renderFieldToolsInto can find it.
          '<div>' +
            (isToolsFolder
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
  }

  function renderFileGrid(files) {
    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;">';
    files.forEach(function(a) {
      var visual;
      if (isImage(a)) {
        visual = '<img src="' + escapeAttr(a.thumb_url) + '" alt="" style="width:100%;height:120px;object-fit:cover;display:block;" />';
      } else {
        var ext = (a.filename || '').split('.').pop().slice(0, 4).toUpperCase() || 'DOC';
        visual = '<div style="height:120px;display:flex;align-items:center;justify-content:center;background:rgba(34,211,238,0.06);font-size:14px;font-weight:700;color:var(--accent,#22d3ee);letter-spacing:0.5px;">' + escapeHTML(ext) + '</div>';
      }
      html += '<div class="mf-file-tile" style="border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;background:var(--card-bg,#0f0f1e);display:flex;flex-direction:column;">' +
        visual +
        '<div style="padding:6px 8px;flex:1;min-height:50px;">' +
          '<div title="' + escapeAttr(a.filename) + '" style="font-size:11px;color:var(--text,#fff);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px;">' + escapeHTML(a.filename) + '</div>' +
          '<div style="font-size:10px;color:var(--text-dim,#888);">' + fmtBytes(a.size_bytes) + ' &middot; ' + escapeHTML(fmtDate(a.uploaded_at)) + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:0;border-top:1px solid var(--border,#222);">' +
          '<a href="' + escapeAttr(a.original_url) + '" download="' + escapeAttr(a.filename) + '" target="_blank" rel="noopener" title="Download" ' +
            'style="flex:1;text-align:center;padding:6px 4px;font-size:10px;color:var(--accent,#22d3ee);text-decoration:none;border-right:1px solid var(--border,#222);">&#x2B07;</a>' +
          '<button onclick="window.myFiles.openSendPicker(\'' + escapeAttr(a.id) + '\', \'move\')" title="Send to a job / estimate (move)" ' +
            'style="flex:1;background:transparent;border:none;border-right:1px solid var(--border,#222);padding:6px 4px;font-size:10px;color:var(--text-dim,#aaa);cursor:pointer;">&#x27A4;</button>' +
          '<button onclick="window.myFiles.openSendPicker(\'' + escapeAttr(a.id) + '\', \'copy\')" title="Copy to a job / estimate" ' +
            'style="flex:1;background:transparent;border:none;border-right:1px solid var(--border,#222);padding:6px 4px;font-size:10px;color:var(--text-dim,#aaa);cursor:pointer;">&#x2398;</button>' +
          '<button onclick="window.myFiles.deleteFile(\'' + escapeAttr(a.id) + '\')" title="Delete" ' +
            'style="flex:1;background:transparent;border:none;padding:6px 4px;font-size:10px;color:#f87171;cursor:pointer;">&times;</button>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    return html;
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
