// Photos widget — drag-drop upload zone, thumbnail grid, and lightbox.
// Used by both the lead editor and the estimate editor; the only thing
// that differs is the (entityType, entityId) the widget targets.
//
// Public API:
//   window.p86Attachments.mount(containerEl, { entityType, entityId, canEdit })
//     - Renders the uploader + grid into containerEl.
//     - Refetches the list and auto-rerenders after each upload/delete.
//   window.p86Attachments.openLightbox(attachments, startIndex)
//     - Used by the grid click handler; exposed for testing / reuse.
(function() {
  'use strict';

  var MAX_PER_ENTITY = 100;
  var MAX_FILE_BYTES = 50 * 1024 * 1024;

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function isImageAttachment(att) {
    return att && att.mime_type && att.mime_type.indexOf('image/') === 0 && !!att.thumb_url;
  }

  // Pick a quick-glance icon based on extension. Emoji keeps this dependency-
  // free; we render it big and centered in a tile, like a file-manager icon.
  function fileIconFor(filename, mime) {
    var ext = (filename || '').split('.').pop().toLowerCase();
    if (mime && mime.indexOf('pdf') >= 0) return '📕';
    if (mime && mime.indexOf('spreadsheet') >= 0) return '📊';
    if (mime && mime.indexOf('word') >= 0) return '📝';
    if (mime && mime.indexOf('zip') >= 0 || ext === 'zip' || ext === '7z') return '🗜️';
    if (ext === 'pdf') return '📕';
    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return '📊';
    if (ext === 'docx' || ext === 'doc') return '📝';
    if (ext === 'pptx' || ext === 'ppt') return '📈';
    if (ext === 'dwg' || ext === 'dxf') return '📐';
    if (ext === 'txt' || ext === 'md') return '📄';
    if (mime && mime.indexOf('image/') === 0) return '🖼️';
    return '📎';
  }

  function escapeAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/&/g, '&amp;'); }

  // Sanitize a free-text folder name to the same shape the server
  // applies on PUT/move: lowercased, kebab-cased, alnum + underscore +
  // dash only, max 60 chars. Empty → 'general'.
  function sanitizeFolder(s) {
    return String(s == null ? '' : s)
      .trim().slice(0, 60).toLowerCase()
      .replace(/[^a-z0-9 _\-]/g, '').replace(/\s+/g, '-') || 'general';
  }

  // Bucket a list of attachments by their `folder` field. Returns an
  // ordered array of { folder, items } so 'general' renders first and
  // the rest follow in alpha order — predictable for the user, and
  // doesn't shuffle when a single rename happens.
  function groupByFolder(list) {
    var bucket = {};
    list.forEach(function(a) {
      var f = (a && a.folder) ? String(a.folder) : 'general';
      if (!bucket[f]) bucket[f] = [];
      bucket[f].push(a);
    });
    var names = Object.keys(bucket).sort(function(a, b) {
      if (a === 'general') return -1;
      if (b === 'general') return 1;
      return a.localeCompare(b);
    });
    return names.map(function(n) { return { folder: n, items: bucket[n] }; });
  }

  function prettyFolder(f) {
    if (!f || f === 'general') return 'General';
    return String(f).replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }
  function escapeHTMLLocal(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ──────────────────────────────────────────────────────────────────
  // Lightbox — fixed-position overlay with prev/next arrows + download
  // original button. Click backdrop or Esc to close.
  // ──────────────────────────────────────────────────────────────────

  function openLightbox(attachments, startIndex) {
    if (!attachments || !attachments.length) return;
    var idx = Math.max(0, Math.min(startIndex || 0, attachments.length - 1));

    var overlay = document.createElement('div');
    overlay.className = 'p86-lightbox';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;align-items:center;justify-content:center;padding:30px;';

    function render() {
      var att = attachments[idx];
      overlay.innerHTML =
        '<button data-lb="close" title="Close (Esc)" style="position:absolute;top:14px;right:18px;background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;width:36px;height:36px;font-size:18px;cursor:pointer;">&times;</button>' +
        (attachments.length > 1 ? '<button data-lb="prev" title="Previous (←)" style="position:absolute;left:18px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;width:44px;height:64px;font-size:24px;cursor:pointer;">&lsaquo;</button>' : '') +
        (attachments.length > 1 ? '<button data-lb="next" title="Next (→)" style="position:absolute;right:18px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;width:44px;height:64px;font-size:24px;cursor:pointer;">&rsaquo;</button>' : '') +
        '<div style="max-width:95%;max-height:88%;display:flex;flex-direction:column;align-items:center;gap:12px;">' +
          '<img src="' + escapeAttr(att.web_url) + '" alt="' + escapeAttr(att.filename) + '" style="max-width:100%;max-height:78vh;object-fit:contain;border-radius:8px;background:#000;" />' +
          '<div style="display:flex;align-items:center;gap:14px;color:#ddd;font-size:12px;font-family:Arial,sans-serif;">' +
            '<div>' + escapeHTMLLocal(att.filename) + ' &middot; ' + fmtBytes(att.size_bytes) + (att.width && att.height ? ' &middot; ' + att.width + '×' + att.height : '') + '</div>' +
            '<a href="' + escapeAttr(att.original_url) + '" download="' + escapeAttr(att.filename) + '" target="_blank" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:6px;padding:6px 12px;text-decoration:none;font-size:11px;">&#x2B07; Download original</a>' +
            '<div style="color:#888;">' + (idx + 1) + ' / ' + attachments.length + '</div>' +
          '</div>' +
        '</div>';
    }

    function next() { idx = (idx + 1) % attachments.length; render(); }
    function prev() { idx = (idx - 1 + attachments.length) % attachments.length; render(); }
    function close() {
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    }
    overlay.addEventListener('click', function(e) {
      var t = e.target;
      var act = t && t.getAttribute && t.getAttribute('data-lb');
      if (act === 'close') close();
      else if (act === 'next') next();
      else if (act === 'prev') prev();
      else if (t === overlay) close(); // backdrop click
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    render();
  }

  // ──────────────────────────────────────────────────────────────────
  // Mount — install the widget into a container element. Re-renders on
  // upload / delete so the grid stays in sync with the server.
  // ──────────────────────────────────────────────────────────────────

  function mount(container, opts) {
    if (!container) return;
    opts = opts || {};
    var entityType = opts.entityType;
    var entityId = opts.entityId;
    var canEdit = opts.canEdit !== false;
    // Optional parent entity — when supplied, the widget also fetches
    // that entity's attachments and renders them in their own read-only
    // section ("From lead", etc.). Used by the estimate editor to
    // surface the originating lead's attachments alongside the
    // estimate's own. Shape: { entityType, entityId, label }.
    var parentEntity = opts.parentEntity || null;
    if (!entityType || !entityId) {
      container.innerHTML = '<div style="padding:14px;color:var(--text-dim,#888);">Save the ' + escapeHTMLLocal(entityType || 'record') + ' first to attach photos.</div>';
      return;
    }

    // state.attachments holds OWN attachments only — parent attachments
    // live on state.parentAttachments so the slot-count math, delete
    // gating, and upload limit only apply to what the user owns.
    var state = { attachments: [], parentAttachments: [], loading: true, uploading: 0 };

    function fetchList() {
      state.loading = true;
      render();
      var ownP = window.p86Api.attachments.list(entityType, entityId);
      var parentP = parentEntity
        ? window.p86Api.attachments.list(parentEntity.entityType, parentEntity.entityId).catch(function() { return { attachments: [] }; })
        : Promise.resolve({ attachments: [] });
      Promise.all([ownP, parentP]).then(function(results) {
        state.attachments = (results[0] && results[0].attachments) || [];
        state.parentAttachments = (results[1] && results[1].attachments) || [];
        state.loading = false;
        render();
      }).catch(function(err) {
        state.loading = false;
        state.error = err.message || 'Failed to load';
        render();
      });
    }

    function uploadOne(file) {
      state.uploading++;
      render();
      return window.p86Api.attachments.upload(entityType, entityId, file)
        .then(function() {
          state.uploading--;
        })
        .catch(function(err) {
          state.uploading--;
          alert('Upload failed for "' + (file && file.name) + '": ' + (err.message || err));
        });
    }

    function uploadFiles(fileList) {
      if (!canEdit || !fileList || !fileList.length) return;
      var files = Array.from(fileList).filter(function(f) {
        if (f.size > MAX_FILE_BYTES) {
          alert('"' + f.name + '" is ' + fmtBytes(f.size) + ' (max ' + fmtBytes(MAX_FILE_BYTES) + ') — skipping.');
          return false;
        }
        return true;
      });
      var remaining = MAX_PER_ENTITY - state.attachments.length;
      if (remaining <= 0) {
        alert('Attachment limit (' + MAX_PER_ENTITY + ') reached. Delete one to upload another.');
        return;
      }
      if (files.length > remaining) {
        alert('Only ' + remaining + ' more attachment slot(s) available. Uploading the first ' + remaining + ' file(s).');
        files = files.slice(0, remaining);
      }
      // Upload sequentially so progress feels coherent and we don't hammer
      // the resize step. Re-fetch the list once at the end.
      var chain = Promise.resolve();
      files.forEach(function(f) { chain = chain.then(function() { return uploadOne(f); }); });
      chain.finally(fetchList);
    }

    function deleteAttachment(id, kind) {
      var go = (typeof window.p86Confirm === 'function')
        ? window.p86Confirm({
            title: 'Delete ' + (kind || 'attachment'),
            message: 'Delete this ' + (kind || 'attachment') + '? This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true
          })
        : Promise.resolve(window.confirm('Delete this ' + (kind || 'attachment') + '?'));
      go.then(function(ok) {
        if (!ok) return;
        window.p86Api.attachments.remove(id).then(fetchList).catch(function(err) {
          if (typeof window.p86Alert === 'function') {
            window.p86Alert({ title: 'Delete failed', message: err.message || '' });
          } else {
            alert('Delete failed: ' + (err.message || ''));
          }
        });
      });
    }

    function render() {
      var slotsLeft = MAX_PER_ENTITY - state.attachments.length;

      // Split incoming attachments by type — photos render as a grid with
      // lightbox, documents as a vertical list with file icons. The split
      // is by mime + presence of a thumbnail, so server-side classification
      // and frontend rendering stay in sync.
      // Markup-of attachments are pulled into their own "Markups" sub-grid
      // so they don't double-render alongside the original they describe.
      var allPhotos = state.attachments.filter(isImageAttachment);
      var photos = allPhotos.filter(function(a) { return !a.markup_of; });
      var markups = allPhotos.filter(function(a) { return !!a.markup_of; });
      var docs = state.attachments.filter(function(a) { return !isImageAttachment(a); });

      var html = '';

      if (canEdit) {
        html += '<div data-att-drop="1" style="border:2px dashed var(--border,#444);border-radius:10px;padding:18px;text-align:center;background:rgba(79,140,255,0.04);margin-bottom:14px;cursor:pointer;transition:border-color 0.15s,background 0.15s;">' +
          '<div style="font-size:13px;color:var(--text,#fff);margin-bottom:4px;">Drop photos or files here or <strong style="color:#4f8cff;">click to pick</strong></div>' +
          '<div style="font-size:11px;color:var(--text-dim,#888);">Up to ' + MAX_PER_ENTITY + ' attachments &middot; ' + slotsLeft + ' slot' + (slotsLeft === 1 ? '' : 's') + ' left &middot; max ' + fmtBytes(MAX_FILE_BYTES) + ' per file &middot; photos auto-resized, docs (PDF, Excel, Word, drawings, etc.) stored as-is</div>' +
          (state.uploading ? '<div style="margin-top:8px;font-size:11px;color:#fbbf24;">Uploading ' + state.uploading + '…</div>' : '') +
          // accept="" lets the picker show every file type — server validates
          '<input data-att-input="1" type="file" multiple style="display:none;" />' +
        '</div>';
      }

      var parentPhotos = (state.parentAttachments || []).filter(isImageAttachment);
      var parentDocs = (state.parentAttachments || []).filter(function(a) { return !isImageAttachment(a); });
      var hasParent = parentPhotos.length + parentDocs.length > 0;

      if (state.loading && !state.attachments.length && !hasParent) {
        html += '<div style="padding:14px;color:var(--text-dim,#888);font-size:12px;">Loading attachments…</div>';
      } else if (state.error) {
        html += '<div style="padding:14px;color:#f87171;font-size:12px;">' + escapeHTMLLocal(state.error) + '</div>';
      } else if (!state.attachments.length && !hasParent) {
        html += '<div style="padding:18px;text-align:center;color:var(--text-dim,#888);font-size:12px;border:1px dashed var(--border,#333);border-radius:8px;">No attachments yet.</div>';
      } else {
        // ── Photos section ──────────────────────────────────────────────
        // Photos render in a single flat index so the lightbox can step
        // across the whole set; folder sub-headers slice the grid only
        // visually. We REORDER `photos` to match render order so the
        // lightbox handler can keep using the array index unchanged.
        if (photos.length) {
          html += sectionHeader('📷 Photos', photos.length);
          var photoGroups = groupByFolder(photos);
          var photosOrdered = [];
          photoGroups.forEach(function(g) {
            if (photoGroups.length > 1 || g.folder !== 'general') {
              html += folderHeader(g.folder, g.items.length);
            }
            html += '<div data-att-grid="1" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:18px;">';
            g.items.forEach(function(att) {
              html += renderPhotoTile(att, photosOrdered.length, false);
              photosOrdered.push(att);
            });
            html += '</div>';
          });
          photos = photosOrdered;
        }

        // ── Markups section ──────────────────────────────────────────
        // Annotated copies (markup_of points back at an original photo).
        // Rendered in a labeled sub-grid so the user can scan their
        // edits separately from raw uploads.
        if (markups.length) {
          html += sectionHeader('✏ Markups', markups.length);
          html += '<div data-att-grid-markups="1" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:18px;">';
          markups.forEach(function(att, i) {
            html += renderPhotoTile(att, i, true);
          });
          html += '</div>';
        }

        // ── Documents section ───────────────────────────────────────────
        // Documents group by folder the same way photos do. Each folder
        // gets its own bordered list so renames/moves are visually
        // obvious. The renderDocRow inner closure stays the same.
        if (docs.length) {
          html += sectionHeader('📎 Documents', docs.length);
          var docGroups = groupByFolder(docs);
          docGroups.forEach(function(g) {
            if (docGroups.length > 1 || g.folder !== 'general') {
              html += folderHeader(g.folder, g.items.length);
            }
            html += '<div style="display:flex;flex-direction:column;gap:6px;border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;margin-bottom:14px;">';
            g.items.forEach(function(att) {
            var isPdf = (att.mime_type && att.mime_type.indexOf('pdf') >= 0) ||
                        (att.filename || '').toLowerCase().endsWith('.pdf');
            var pinActive = !!att.include_in_proposal;
            var pinTitle = pinActive ? 'In proposal — click to remove' : 'Attach to proposal';
            var pinColor = pinActive ? '#34d399' : 'var(--text-dim,#888)';
            var pinBorder = pinActive ? '1px solid rgba(52,211,153,0.4)' : '1px solid var(--border,#333)';
            html += '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border,#2a2a3a);">' +
              '<div style="font-size:24px;flex:0 0 auto;line-height:1;">' + fileIconFor(att.filename, att.mime_type) + '</div>' +
              '<div style="flex:1;min-width:0;">' +
                '<div style="font-size:13px;color:var(--text,#fff);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTMLLocal(att.filename) + '</div>' +
                '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:2px;">' + fmtBytes(att.size_bytes) + (att.mime_type ? ' &middot; ' + escapeHTMLLocal(att.mime_type) : '') +
                  (pinActive ? ' &middot; <span style="color:#34d399;">&#x1F4CC; in proposal</span>' : '') +
                '</div>' +
              '</div>' +
              (canEdit ? '<button data-att-pin="' + escapeAttr(att.id) + '" title="' + escapeAttr(pinTitle) + '" style="flex:0 0 auto;background:' + (pinActive ? 'rgba(52,211,153,0.10)' : 'transparent') + ';color:' + pinColor + ';border:' + pinBorder + ';border-radius:6px;width:30px;height:30px;font-size:13px;cursor:pointer;line-height:1;">&#x1F4CC;</button>' : '') +
              (canEdit ? '<button data-att-move="' + escapeAttr(att.id) + '" title="Move to folder" style="flex:0 0 auto;background:transparent;color:var(--text-dim,#aaa);border:1px solid var(--border,#333);border-radius:6px;width:30px;height:30px;font-size:13px;cursor:pointer;line-height:1;">&#x1F4C1;</button>' : '') +
              (isPdf ? '<button data-att-view="' + escapeAttr(att.id) + '" title="Preview pages and send to the AI assistant" style="flex:0 0 auto;background:rgba(139,92,246,0.12);color:#c4b5fd;border:1px solid rgba(139,92,246,0.3);border-radius:6px;padding:6px 12px;font-size:11px;font-weight:600;cursor:pointer;">&#x1F441; View</button>' : '') +
              '<a href="' + escapeAttr(att.original_url) + '" download="' + escapeAttr(att.filename) + '" target="_blank" rel="noopener" title="Download" style="flex:0 0 auto;background:rgba(79,140,255,0.12);color:#4f8cff;border:1px solid rgba(79,140,255,0.3);border-radius:6px;padding:6px 12px;text-decoration:none;font-size:11px;font-weight:600;">&#x2B07; Download</a>' +
              (canEdit ? '<button data-att-del-doc="' + escapeAttr(att.id) + '" title="Delete" style="flex:0 0 auto;background:rgba(248,113,113,0.10);color:#f87171;border:1px solid rgba(248,113,113,0.25);border-radius:6px;width:30px;height:30px;font-size:14px;cursor:pointer;line-height:1;">&times;</button>' : '') +
            '</div>';
            });
            // last row inside this folder should not draw the trailing border
            html = html.replace(/border-bottom:1px solid var\(--border,#2a2a3a\);(?![\s\S]*border-bottom:1px solid var\(--border,#2a2a3a\);)/, '');
            html += '</div>';
          });
        }

        // ── Parent (read-only) sections ──────────────────────────────
        // Surfaces e.g. the originating lead's attachments alongside
        // the estimate's own. Same render as above but no delete
        // buttons and indexes into a separate lightbox set.
        if (hasParent) {
          var parentLabel = (parentEntity && parentEntity.label) ||
            ('From ' + (parentEntity && parentEntity.entityType ? parentEntity.entityType : 'parent'));
          if (parentPhotos.length) {
            html += sectionHeader('📷 ' + parentLabel + ' — Photos', parentPhotos.length);
            html += '<div data-att-grid-parent="1" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:18px;opacity:0.92;">';
            parentPhotos.forEach(function(att, i) {
              html += '<div class="att-thumb-tile" style="position:relative;border:1px solid rgba(79,140,255,0.35);border-radius:8px;overflow:hidden;background:#000;aspect-ratio:1/1;">' +
                '<img data-att-thumb-parent="' + i + '" src="' + escapeAttr(att.thumb_url) + '" alt="' + escapeAttr(att.filename) + '" onerror="this.parentNode.classList.add(\'att-thumb-broken\')" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;display:block;" />' +
                // Top-left: entity-source badge ("LEAD")
                '<div style="position:absolute;top:4px;left:4px;background:rgba(79,140,255,0.85);color:#fff;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;padding:2px 5px;border-radius:3px;z-index:2;">' + escapeHTMLLocal((parentEntity && parentEntity.entityType) || 'parent') + '</div>' +
                // Top-right: Mark-up button. Result uploads into the
                // CURRENT entity (not the parent's), with markup_of
                // pointing back at this parent attachment.
                (canEdit ? '<button data-att-markup-parent="' + escapeAttr(att.id) + '" title="Mark up — saves into this ' + escapeAttr(entityType) + '" style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.7);color:#fbbf24;border:none;border-radius:4px;padding:3px 6px;font-size:10px;font-weight:700;cursor:pointer;z-index:2;">&#x270F; MARK</button>' : '') +
                '<div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.7));color:#fff;font-size:10px;padding:14px 6px 4px;font-family:Arial,sans-serif;pointer-events:none;z-index:1;">' + escapeHTMLLocal(att.filename) + '</div>' +
              '</div>';
            });
            html += '</div>';
          }
          if (parentDocs.length) {
            html += sectionHeader('📎 ' + parentLabel + ' — Documents', parentDocs.length);
            html += '<div style="display:flex;flex-direction:column;gap:6px;border:1px solid rgba(79,140,255,0.25);border-radius:8px;overflow:hidden;opacity:0.95;">';
            parentDocs.forEach(function(att) {
              var isPdf = (att.mime_type && att.mime_type.indexOf('pdf') >= 0) ||
                          (att.filename || '').toLowerCase().endsWith('.pdf');
              html += '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(79,140,255,0.04);border-bottom:1px solid rgba(79,140,255,0.15);">' +
                '<div style="font-size:24px;flex:0 0 auto;line-height:1;">' + fileIconFor(att.filename, att.mime_type) + '</div>' +
                '<div style="flex:1;min-width:0;">' +
                  '<div style="font-size:13px;color:var(--text,#fff);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTMLLocal(att.filename) + '</div>' +
                  '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:2px;">' + fmtBytes(att.size_bytes) + (att.mime_type ? ' &middot; ' + escapeHTMLLocal(att.mime_type) : '') + '</div>' +
                '</div>' +
                (isPdf ? '<button data-att-view-parent="' + escapeAttr(att.id) + '" title="Preview pages" style="flex:0 0 auto;background:rgba(139,92,246,0.12);color:#c4b5fd;border:1px solid rgba(139,92,246,0.3);border-radius:6px;padding:6px 12px;font-size:11px;font-weight:600;cursor:pointer;">&#x1F441; View</button>' : '') +
                '<a href="' + escapeAttr(att.original_url) + '" download="' + escapeAttr(att.filename) + '" target="_blank" rel="noopener" title="Download" style="flex:0 0 auto;background:rgba(79,140,255,0.12);color:#4f8cff;border:1px solid rgba(79,140,255,0.3);border-radius:6px;padding:6px 12px;text-decoration:none;font-size:11px;font-weight:600;">&#x2B07; Download</a>' +
              '</div>';
            });
            html = html.replace(/border-bottom:1px solid rgba\(79,140,255,0\.15\);(?![\s\S]*border-bottom:1px solid rgba\(79,140,255,0\.15\);)/, '');
            html += '</div>';
          }
        }
      }
      container.innerHTML = html;

      // Wire interactions. Delegated on the container so a re-render
      // doesn't leak listeners.
      var dropZone = container.querySelector('[data-att-drop]');
      var input = container.querySelector('[data-att-input]');
      if (dropZone && input) {
        dropZone.onclick = function(e) {
          if (e.target !== input) input.click();
        };
        dropZone.ondragover = function(e) {
          e.preventDefault();
          dropZone.style.borderColor = '#4f8cff';
          dropZone.style.background = 'rgba(79,140,255,0.10)';
        };
        dropZone.ondragleave = function() {
          dropZone.style.borderColor = '';
          dropZone.style.background = '';
        };
        dropZone.ondrop = function(e) {
          e.preventDefault();
          dropZone.style.borderColor = '';
          dropZone.style.background = '';
          if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
        };
        input.onchange = function() {
          uploadFiles(input.files);
          input.value = '';
        };
      }
      // Photo click → lightbox; index is into the photos sub-array
      container.querySelectorAll('[data-att-thumb]').forEach(function(img) {
        img.onclick = function() {
          var i = parseInt(img.getAttribute('data-att-thumb'), 10);
          openLightbox(photos, i);
        };
      });
      container.querySelectorAll('[data-att-thumb-markup]').forEach(function(img) {
        img.onclick = function() {
          var i = parseInt(img.getAttribute('data-att-thumb-markup'), 10);
          openLightbox(markups, i);
        };
      });
      container.querySelectorAll('[data-att-del-photo]').forEach(function(btn) {
        btn.onclick = function(e) {
          e.stopPropagation();
          deleteAttachment(btn.getAttribute('data-att-del-photo'), 'photo');
        };
      });
      // Mark-up button on a photo — opens the canvas markup viewer.
      // On Save the viewer either replaces the original or uploads a
      // new attachment with markup_of set; in both cases we re-fetch.
      container.querySelectorAll('[data-att-markup]').forEach(function(btn) {
        btn.onclick = function(e) {
          e.stopPropagation();
          if (!window.p86Markup || typeof window.p86Markup.open !== 'function') {
            alert('Markup viewer not loaded — refresh the page.');
            return;
          }
          var attId = btn.getAttribute('data-att-markup');
          var att = state.attachments.find(function(a) { return a.id === attId; });
          if (!att) return;
          window.p86Markup.open({
            attachment: att,
            onDone: fetchList
          });
        };
      });
      // Pin (include_in_proposal) toggle — fires a PUT to flip the flag.
      // Optimistic: update local state + re-render so the icon flips
      // immediately; rollback on server failure.
      container.querySelectorAll('[data-att-pin]').forEach(function(btn) {
        btn.onclick = function(e) {
          e.stopPropagation();
          var attId = btn.getAttribute('data-att-pin');
          var att = state.attachments.find(function(a) { return a.id === attId; });
          if (!att) return;
          var next = !att.include_in_proposal;
          att.include_in_proposal = next;
          render();
          window.p86Api.attachments.update(attId, { include_in_proposal: next })
            .catch(function(err) {
              att.include_in_proposal = !next; // rollback
              render();
              alert('Failed to update: ' + (err.message || ''));
            });
        };
      });
      container.querySelectorAll('[data-att-del-doc]').forEach(function(btn) {
        btn.onclick = function(e) {
          e.stopPropagation();
          deleteAttachment(btn.getAttribute('data-att-del-doc'), 'document');
        };
      });
      // Move-to-folder. Two flavors:
      //   • Plain folder rename (within this entity) → server PUT /:id { folder }
      //   • Cross-entity move (job ↔ estimate ↔ lead, etc.) → POST /:id/move
      // Prompt is intentionally simple — a single text input with the
      // existing folder pre-filled, plus a hint about syntax. Heavier
      // pickers can layer in later if folks need them.
      container.querySelectorAll('[data-att-move]').forEach(function(btn) {
        btn.onclick = function(e) {
          e.stopPropagation();
          var attId = btn.getAttribute('data-att-move');
          var att = state.attachments.find(function(a) { return a.id === attId; });
          if (!att) return;
          var current = att.folder || 'general';
          var prompt = 'Move "' + (att.filename || 'file') + '" to folder:\n\n' +
            'Folder name (e.g. photos, rfp, contracts) — letters, numbers, spaces, dashes.';
          var next = window.prompt(prompt, current);
          if (next == null) return; // cancel
          var folder = sanitizeFolder(next);
          if (folder === current) return; // no-op
          window.p86Api.attachments.update(attId, { folder: folder })
            .then(fetchList)
            .catch(function(err) {
              alert('Move failed: ' + (err.message || ''));
            });
        };
      });
      // PDF view button — opens the inline viewer with an Ask AI handoff.
      container.querySelectorAll('[data-att-view]').forEach(function(btn) {
        btn.onclick = function(e) {
          e.stopPropagation();
          var attId = btn.getAttribute('data-att-view');
          var att = state.attachments.find(function(a) { return a.id === attId; });
          if (att && typeof window.openPdfViewer === 'function') {
            window.openPdfViewer(att, { entityType: entityType, entityId: entityId });
          } else {
            alert('PDF viewer not loaded — refresh the page.');
          }
        };
      });
      // Parent (read-only) sections — same lightbox / PDF viewer
      // wiring as the owned set, but indexed against parentPhotos and
      // scoped to the parent entity for the viewer's "Ask AI" context.
      container.querySelectorAll('[data-att-thumb-parent]').forEach(function(img) {
        img.onclick = function() {
          var i = parseInt(img.getAttribute('data-att-thumb-parent'), 10);
          openLightbox(parentPhotos, i);
        };
      });
      // Mark-up on a parent (e.g. lead) photo — opens the markup
      // viewer with saveTarget pointing at the CURRENT entity so the
      // saved markup lands here, with markup_of pointing back at the
      // parent. Original parent attachment is left untouched.
      container.querySelectorAll('[data-att-markup-parent]').forEach(function(btn) {
        btn.onclick = function(e) {
          e.stopPropagation();
          if (!window.p86Markup || typeof window.p86Markup.open !== 'function') {
            alert('Markup viewer not loaded — refresh the page.');
            return;
          }
          var attId = btn.getAttribute('data-att-markup-parent');
          var att = state.parentAttachments.find(function(a) { return a.id === attId; });
          if (!att) return;
          window.p86Markup.open({
            attachment: att,
            saveTarget: { entityType: entityType, entityId: entityId },
            onDone: fetchList
          });
        };
      });
      container.querySelectorAll('[data-att-view-parent]').forEach(function(btn) {
        btn.onclick = function(e) {
          e.stopPropagation();
          var attId = btn.getAttribute('data-att-view-parent');
          var att = state.parentAttachments.find(function(a) { return a.id === attId; });
          if (att && typeof window.openPdfViewer === 'function') {
            window.openPdfViewer(att, {
              entityType: parentEntity && parentEntity.entityType,
              entityId: parentEntity && parentEntity.entityId
            });
          } else {
            alert('PDF viewer not loaded — refresh the page.');
          }
        };
      });
    }

    function sectionHeader(label, count) {
      return '<div style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin:6px 2px 8px;">' +
        label + ' <span style="font-weight:400;color:var(--text-dim,#666);margin-left:4px;">' + count + '</span>' +
      '</div>';
    }

    // Folder sub-header inside a section. Lighter weight than the
    // section header so the visual hierarchy is: section ▸ folder ▸
    // tiles. Only rendered when the section has more than one folder
    // (or a single non-default folder), so the unfolded common case
    // stays clean.
    function folderHeader(folder, count) {
      return '<div style="font-size:10px;font-weight:600;color:var(--text-dim,#666);text-transform:uppercase;letter-spacing:0.4px;margin:2px 2px 6px;display:flex;align-items:center;gap:6px;">' +
        '<span style="font-size:12px;">&#x1F4C1;</span>' +
        '<span>' + escapeHTMLLocal(prettyFolder(folder)) + '</span>' +
        '<span style="font-weight:400;color:var(--text-dim,#555);">' + count + '</span>' +
      '</div>';
    }

    // Render a single photo thumbnail tile. `isMarkup` flips a small
    // accent so users can tell markup tiles apart from the originals
    // at a glance. The Mark-up button + Attach-to-proposal pin are
    // overlaid on hover via inline corners.
    function renderPhotoTile(att, idx, isMarkup) {
      var indexAttr = isMarkup ? 'data-att-thumb-markup="' + idx + '"' : 'data-att-thumb="' + idx + '"';
      var border = isMarkup ? '1px solid rgba(251,191,36,0.5)' : '1px solid var(--border,#333)';
      var pinActive = !!att.include_in_proposal;
      var pinTitle = pinActive ? 'In proposal — click to remove' : 'Attach to proposal';
      var pinColor = pinActive ? '#34d399' : '#aaa';
      var pinBg = pinActive ? 'rgba(52,211,153,0.18)' : 'rgba(0,0,0,0.7)';
      return '<div class="att-thumb-tile" style="position:relative;border:' + border + ';border-radius:8px;overflow:hidden;background:#000;aspect-ratio:1/1;">' +
        '<img ' + indexAttr + ' src="' + escapeAttr(att.thumb_url) + '" alt="' + escapeAttr(att.filename) + '" onerror="this.parentNode.classList.add(\'att-thumb-broken\')" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;display:block;" />' +
        // Top-left: Mark-up button (only on photos, edit mode).
        (canEdit ? '<button data-att-markup="' + escapeAttr(att.id) + '" title="Mark up this photo" style="position:absolute;top:4px;left:4px;background:rgba(0,0,0,0.7);color:#fbbf24;border:none;border-radius:4px;padding:3px 6px;font-size:10px;font-weight:700;cursor:pointer;z-index:2;">&#x270F; MARK</button>' : '') +
        // Top-right: Pin (proposal toggle) + Move + Delete.
        (canEdit ?
          '<div style="position:absolute;top:4px;right:4px;display:flex;gap:3px;z-index:2;">' +
            '<button data-att-pin="' + escapeAttr(att.id) + '" title="' + escapeAttr(pinTitle) + '" style="background:' + pinBg + ';color:' + pinColor + ';border:none;border-radius:4px;width:24px;height:24px;font-size:12px;cursor:pointer;line-height:1;">&#x1F4CC;</button>' +
            '<button data-att-move="' + escapeAttr(att.id) + '" title="Move to folder" style="background:rgba(0,0,0,0.7);color:#a5b4fc;border:none;border-radius:4px;width:24px;height:24px;font-size:12px;cursor:pointer;line-height:1;">&#x1F4C1;</button>' +
            '<button data-att-del-photo="' + escapeAttr(att.id) + '" title="Delete" style="background:rgba(0,0,0,0.7);color:#f87171;border:none;border-radius:4px;width:24px;height:24px;font-size:13px;cursor:pointer;line-height:1;">&times;</button>' +
          '</div>' : '') +
        // Bottom: filename + (if pinned) "In proposal" badge.
        '<div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.7));color:#fff;font-size:10px;padding:14px 6px 4px;font-family:Arial,sans-serif;pointer-events:none;z-index:1;">' +
          escapeHTMLLocal(att.filename) +
          (pinActive ? '<div style="color:#34d399;font-size:9px;font-weight:700;margin-top:1px;">&#x1F4CC; IN PROPOSAL</div>' : '') +
        '</div>' +
      '</div>';
    }

    fetchList();
  }

  window.p86Attachments = { mount: mount, openLightbox: openLightbox };
})();
