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
  // Photo viewer — CompanyCam-style two-column layout. Left: image
  // stage with nav arrows + toolbar (annotate / zoom / download /
  // delete). Right: side panel with project header, uploader, tags
  // editor, description (caption), and a comments thread. Mobile
  // collapses the panel to a bottom drawer.
  //
  // Kept the public name `openLightbox` and the (attachments, idx)
  // signature so every existing caller (projects.js photo grid,
  // estimate/lead attachment widgets) gets the new viewer without
  // any callsite changes.
  // ──────────────────────────────────────────────────────────────────

  // Tiny relative-time formatter, duplicated from projects.js so the
  // viewer doesn't have to reach across module boundaries for a
  // 12-line helper.
  function fmtRelativeTime(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return '';
    var diff = Math.max(0, Date.now() - t);
    var s = Math.floor(diff / 1000);
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' hr ago';
    var d = Math.floor(h / 24);
    if (d < 7) return d + ' day' + (d === 1 ? '' : 's') + ' ago';
    return new Date(iso).toLocaleDateString();
  }

  function initialsFor(name) {
    if (!name) return '?';
    var parts = String(name).trim().split(/\s+/);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function userNameFor(userId) {
    if (!userId) return 'Unknown';
    if (window.p86Admin && typeof window.p86Admin.findUserById === 'function') {
      var u = window.p86Admin.findUserById(userId);
      if (u && u.name) return u.name;
    }
    return 'User ' + userId;
  }

  function openLightbox(attachments, startIndex, opts) {
    if (!attachments || !attachments.length) return;
    opts = opts || {};
    var state = {
      attachments: attachments.slice(),
      idx: Math.max(0, Math.min(startIndex || 0, attachments.length - 1)),
      zoom: 1,
      fullscreen: false,
      panelOpen: true, // mobile drawer open/closed
      comments: null,  // null = not yet loaded; array once loaded
      commentsLoading: false,
      commentsError: null,
      parentLabel: opts.parentLabel || '',
      parentSubtitle: opts.parentSubtitle || ''
    };

    var overlay = document.createElement('div');
    overlay.className = 'p86-photo-viewer';
    document.body.appendChild(overlay);

    function att() { return state.attachments[state.idx]; }

    function next() {
      state.idx = (state.idx + 1) % state.attachments.length;
      state.zoom = 1;
      state.comments = null;
      render();
      fetchComments();
    }
    function prev() {
      state.idx = (state.idx - 1 + state.attachments.length) % state.attachments.length;
      state.zoom = 1;
      state.comments = null;
      render();
      fetchComments();
    }
    function close() {
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function onKey(e) {
      // Don't hijack arrow keys while typing in the panel.
      var tag = e.target && e.target.tagName;
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
      if (e.key === 'Escape') {
        if (state.fullscreen) { state.fullscreen = false; render(); return; }
        close();
        return;
      }
      if (typing) return;
      if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    }
    document.addEventListener('keydown', onKey);

    // Optimistic local patch — caller-supplied attachment array is the
    // source of truth for what the viewer paints, so mutate it in
    // place AND fire the API. Failures bubble back via the toast.
    function updateAtt(patch) {
      var a = att();
      var prior = {};
      Object.keys(patch).forEach(function(k) { prior[k] = a[k]; });
      Object.keys(patch).forEach(function(k) { a[k] = patch[k]; });
      return window.p86Api.attachments.update(a.id, patch).catch(function(e) {
        // Roll back the optimistic write so the panel re-renders
        // with the prior value.
        Object.keys(prior).forEach(function(k) { a[k] = prior[k]; });
        alert('Save failed: ' + (e.message || e));
        render();
      });
    }

    function fetchComments() {
      var a = att();
      if (!a || !a.id) { state.comments = []; return; }
      if (!window.p86Api || !window.p86Api.messages) { state.comments = []; renderPanel(); return; }
      state.commentsLoading = true;
      state.commentsError = null;
      renderPanel();
      var key = 'attachment:' + a.id;
      window.p86Api.messages.thread(key).then(function(r) {
        // Only commit if the user hasn't paged to a different photo
        // mid-fetch (guards against late responses overwriting a
        // newer photo's panel).
        if (att().id !== a.id) return;
        state.comments = (r && r.messages) || [];
        state.commentsLoading = false;
        renderPanel();
      }).catch(function(e) {
        if (att().id !== a.id) return;
        state.commentsLoading = false;
        state.commentsError = e.message || 'Failed to load comments';
        state.comments = [];
        renderPanel();
      });
    }

    function postComment(body) {
      var a = att();
      if (!a || !a.id || !body || !body.trim()) return Promise.resolve();
      var key = 'attachment:' + a.id;
      return window.p86Api.messages.post(key, body.trim()).then(function() {
        fetchComments();
      });
    }

    function deleteComment(msgId) {
      if (!window.confirm('Delete this comment?')) return;
      window.p86Api.messages.remove(msgId).then(fetchComments).catch(function(e) {
        alert('Delete failed: ' + (e.message || e));
      });
    }

    function downloadCurrent() {
      var a = att();
      if (!a) return;
      var url = a.original_url || a.web_url;
      if (!url) return;
      var link = document.createElement('a');
      link.href = url;
      link.download = a.filename || 'attachment';
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    function deleteCurrent() {
      var a = att();
      if (!a || !a.id) return;
      if (!window.confirm('Delete "' + (a.filename || 'this photo') + '"? This cannot be undone.')) return;
      window.p86Api.attachments.remove(a.id).then(function() {
        state.attachments.splice(state.idx, 1);
        if (!state.attachments.length) { close(); return; }
        if (state.idx >= state.attachments.length) state.idx = state.attachments.length - 1;
        state.zoom = 1;
        state.comments = null;
        render();
        fetchComments();
      }).catch(function(e) {
        alert('Delete failed: ' + (e.message || e));
      });
    }

    function openAnnotator() {
      var a = att();
      if (!a) return;
      if (!window.p86Markup || typeof window.p86Markup.open !== 'function') {
        alert('Annotator not loaded.');
        return;
      }
      window.p86Markup.open({
        attachment: a,
        saveTarget: { entityType: a.entity_type, entityId: a.entity_id },
        onDone: function(result) {
          if (result && Array.isArray(result.annotations)) {
            a.annotations = result.annotations;
            render();
          }
        }
      });
    }

    function toggleFullscreen() {
      state.fullscreen = !state.fullscreen;
      render();
    }

    function setZoom(delta) {
      // Stepped: 1 → 1.5 → 2 → 3 → back to 1. Min 1.
      var steps = [1, 1.5, 2, 3];
      var cur = steps.indexOf(state.zoom);
      if (cur < 0) cur = 0;
      var next = Math.max(0, Math.min(steps.length - 1, cur + delta));
      state.zoom = steps[next];
      var imgEl = overlay.querySelector('.p86-pv-img');
      var canvasEl = overlay.querySelector('.p86-pv-anno');
      if (imgEl) imgEl.style.transform = 'scale(' + state.zoom + ')';
      if (canvasEl) canvasEl.style.transform = 'scale(' + state.zoom + ')';
    }

    // Render the whole viewer (stage + panel). Called on photo change
    // and on fullscreen toggle. renderPanel() handles in-place panel
    // updates (comments load / tag change) without re-rendering the
    // stage, so the image doesn't flash.
    function render() {
      var a = att();
      if (!a) { close(); return; }
      var hasAnnotations = Array.isArray(a.annotations) && a.annotations.length > 0;
      var multi = state.attachments.length > 1;
      var isImage = a.mime_type && a.mime_type.indexOf('image/') === 0;
      var fs = state.fullscreen ? ' p86-pv-fullscreen' : '';

      overlay.className = 'p86-photo-viewer' + fs;
      overlay.innerHTML =
        '<div class="p86-pv-stage">' +
          '<button class="p86-pv-close" title="Close (Esc)" data-pv="close">&times;</button>' +
          (multi
            ? '<button class="p86-pv-nav p86-pv-prev" title="Previous (←)" data-pv="prev">&lsaquo;</button>' +
              '<button class="p86-pv-nav p86-pv-next" title="Next (→)" data-pv="next">&rsaquo;</button>'
            : '') +
          '<div class="p86-pv-img-wrap">' +
            (isImage
              ? '<img class="p86-pv-img" src="' + escapeAttr(a.web_url || a.original_url) + '" alt="' + escapeAttr(a.filename) + '" style="transform:scale(' + state.zoom + ');" />' +
                (hasAnnotations ? '<canvas class="p86-pv-anno" style="transform:scale(' + state.zoom + ');"></canvas>' : '')
              : '<div class="p86-pv-doc">' + fileIconFor(a.filename, a.mime_type) + '<div class="p86-pv-doc-name">' + escapeHTMLLocal(a.filename) + '</div></div>') +
          '</div>' +
          renderToolbarHTML(a, hasAnnotations) +
          (multi ? '<div class="p86-pv-counter">' + (state.idx + 1) + ' / ' + state.attachments.length + '</div>' : '') +
        '</div>' +
        '<aside class="p86-pv-panel">' + renderPanelHTML(a) + '</aside>';

      // Annotation canvas paint — only when image exists and has strokes.
      if (isImage && hasAnnotations) {
        var img = overlay.querySelector('.p86-pv-img');
        var canvas = overlay.querySelector('.p86-pv-anno');
        function paintAnno() {
          if (!img || !canvas) return;
          canvas.width = img.naturalWidth || 1;
          canvas.height = img.naturalHeight || 1;
          var ctx = canvas.getContext('2d');
          if (window.p86AnnotationRender && typeof window.p86AnnotationRender.renderAll === 'function') {
            window.p86AnnotationRender.renderAll(ctx, a.annotations);
          }
        }
        if (img.complete && img.naturalWidth) paintAnno();
        else img.addEventListener('load', paintAnno, { once: true });
      }

      wireStage();
      wirePanel(a);
    }

    function renderToolbarHTML(a, hasAnnotations) {
      var canAnnotate = a.mime_type && a.mime_type.indexOf('image/') === 0;
      var btn = function(act, icon, title) {
        return '<button class="p86-pv-tbtn" data-pv="' + act + '" title="' + escapeAttr(title) + '">' + icon + '</button>';
      };
      return '<div class="p86-pv-toolbar">' +
        (canAnnotate ? btn('annotate', '&#9998;', 'Annotate' + (hasAnnotations ? ' (' + a.annotations.length + ')' : '')) : '') +
        btn('fullscreen', state.fullscreen ? '&#x2922;' : '&#x26F6;', state.fullscreen ? 'Show panel' : 'Hide panel') +
        (canAnnotate ? btn('zoomout', '&minus;', 'Zoom out') : '') +
        (canAnnotate ? btn('zoomin', '&plus;', 'Zoom in') : '') +
        btn('download', '&#x2B07;', 'Download') +
        btn('delete', '&#x1F5D1;', 'Delete') +
      '</div>';
    }

    // The panel is split into TWO regions so the parent-entity
    // header (project name + address) can sit fixed at the top while
    // the body (uploader / tags / description / comments) scrolls
    // independently. The previous single-flow layout used negative
    // margins on the header to bleed it to the panel edges, but
    // those negative margins broke the flex gap calculation and made
    // the avatar render on top of the address text. The
    // header-then-scrollable-body split sidesteps the issue and also
    // keeps the project context visible when reading a long comment
    // thread.
    function renderPanelHTML(a) {
      var uploader = userNameFor(a.uploaded_by);
      var when = fmtRelativeTime(a.uploaded_at);
      var caption = a.caption || '';
      return (state.parentLabel
          ? '<header class="p86-pv-parent">' +
              '<div class="p86-pv-parent-top">' +
                '<div class="p86-pv-parent-name">' + escapeHTMLLocal(state.parentLabel) + '</div>' +
                '<button class="p86-pv-close-panel" data-pv="close" title="Close">&times;</button>' +
              '</div>' +
              (state.parentSubtitle ? '<div class="p86-pv-parent-sub">' + escapeHTMLLocal(state.parentSubtitle) + '</div>' : '') +
            '</header>'
          : '<button class="p86-pv-close-panel p86-pv-close-panel-floating" data-pv="close" title="Close">&times;</button>') +
        '<div class="p86-pv-body">' +
          '<div class="p86-pv-uploader">' +
            '<div class="p86-pv-avatar">' + escapeHTMLLocal(initialsFor(uploader)) + '</div>' +
            '<div class="p86-pv-uploader-meta">' +
              '<div class="p86-pv-uploader-name">' + escapeHTMLLocal(uploader) + '</div>' +
              '<div class="p86-pv-uploader-when">' + escapeHTMLLocal(when) + '</div>' +
            '</div>' +
          '</div>' +
          '<section class="p86-pv-section">' +
            '<div class="p86-pv-section-label">Tags</div>' +
            '<div class="p86-pv-tags-host"></div>' +
          '</section>' +
          '<section class="p86-pv-section">' +
            '<div class="p86-pv-section-label">Description</div>' +
            '<fieldset class="p86-pv-desc-fs" data-edit-gate="locked">' +
              '<legend class="p86-pv-desc-legend">&nbsp;</legend>' +
              '<textarea class="p86-pv-desc-input" placeholder="Add a description (caption)…">' + escapeHTMLLocal(caption) + '</textarea>' +
            '</fieldset>' +
          '</section>' +
          '<section class="p86-pv-section p86-pv-comments-section">' +
            '<div class="p86-pv-section-label">Comments</div>' +
            '<div class="p86-pv-comments-list"></div>' +
            '<div class="p86-pv-composer">' +
              '<textarea class="p86-pv-composer-input" rows="2" placeholder="Add a comment…"></textarea>' +
              '<button class="p86-pv-composer-post" type="button">Post</button>' +
            '</div>' +
          '</section>' +
        '</div>';
    }

    function renderPanel() {
      var a = att();
      var aside = overlay.querySelector('.p86-pv-panel');
      if (!aside) return;
      aside.innerHTML = renderPanelHTML(a);
      wirePanel(a);
    }

    // ── Tags strip + Buildertrend-style picker modal ─────────────────
    // Renders the current attachment's tags as removable chips with
    // a single "+ Add Tag" pill that opens the picker modal. The
    // modal lets the user scroll the org's existing tag catalog and
    // tap to add — instead of having to type to find the tag first.
    // Live re-render after every modal change so the panel always
    // shows fresh chips.
    function renderTagsStrip(host, a) {
      var tags = Array.isArray(a.tags) ? a.tags.slice() : [];
      var chipsHTML = tags.map(function(t) {
        return '<span class="p86-pv-tag-chip" style="--h:' + (window.p86Projects && window.p86Projects.mountTagEditor ? hueForLocal(t) : 200) + ';">' +
          '#' + escapeHTMLLocal(t) +
          '<button type="button" class="p86-pv-tag-chip-rm" data-rm-tag="' + escapeAttr(t) + '" title="Remove">&times;</button>' +
        '</span>';
      }).join('');
      host.innerHTML =
        '<div class="p86-pv-tags-strip">' +
          chipsHTML +
          '<button type="button" class="p86-pv-tags-add" data-add-tag>' +
            '<span class="p86-pv-tags-add-icon">&#x1F3F7;</span>' +
            '<span>Add Tag</span>' +
          '</button>' +
        '</div>';
      // Wire chip removes — PATCH on each click; optimistic update
      // already in updateAtt.
      host.querySelectorAll('[data-rm-tag]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var t = btn.getAttribute('data-rm-tag');
          var next = (a.tags || []).filter(function(x) { return x !== t; });
          updateAtt({ tags: next });
          renderTagsStrip(host, a); // re-render immediately (optimistic)
        });
      });
      // "+ Add Tag" → open the picker modal.
      var addBtn = host.querySelector('[data-add-tag]');
      if (addBtn) addBtn.addEventListener('click', function() {
        openTagSelectModal(a, function() {
          // Picker mutated a.tags via updateAtt; re-render the strip.
          renderTagsStrip(host, a);
        });
      });
    }

    // Lightweight stable hue per tag string so chips stay the same
    // color across renders. Mirrors the hueFor helper in projects.js
    // (kept local so attachments.js doesn't have to reach for it).
    function hueForLocal(s) {
      var str = String(s || '');
      var h = 0;
      for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
      return Math.abs(h) % 360;
    }

    function openTagSelectModal(a, onChange) {
      var prior = document.getElementById('p86PvTagModal');
      if (prior) prior.remove();
      var modal = document.createElement('div');
      modal.id = 'p86PvTagModal';
      modal.className = 'modal active p86-pv-tag-modal';
      // Local picker state — selected starts as a copy of the live
      // attachment.tags, and we PATCH on every change so the user
      // sees the chips appear in the photo panel beneath the modal.
      var selected = Array.isArray(a.tags) ? a.tags.slice() : [];
      var lastCatalog = [];   // last fetched suggest list
      var query = '';

      function commitSelection(next) {
        selected = next.slice();
        a.tags = selected; // optimistic mirror so panel re-renders see fresh
        updateAtt({ tags: selected });
        paint();
        if (onChange) onChange();
      }

      function fetchCatalog() {
        var fn = function(q) {
          if (window.p86Api && window.p86Api.orgTags && window.p86Api.orgTags.suggest) {
            return window.p86Api.orgTags.suggest(q);
          }
          return Promise.resolve({ tags: [] });
        };
        return fn(query).then(function(r) {
          lastCatalog = (r && r.tags) || [];
          paintList();
        }).catch(function() {
          lastCatalog = [];
          paintList();
        });
      }

      function visibleCatalog() {
        var q = query.trim().toLowerCase();
        // Filter against the typed query AND already-selected tags.
        return lastCatalog.filter(function(t) {
          if (selected.indexOf(t) !== -1) return false;
          if (!q) return true;
          return t.toLowerCase().indexOf(q) >= 0;
        });
      }

      function canCreate() {
        var q = query.trim().toLowerCase().slice(0, 32);
        if (!q) return false;
        if (selected.indexOf(q) !== -1) return false;
        if (lastCatalog.indexOf(q) !== -1) return false;
        return true;
      }

      function paint() {
        var chipsHTML = selected.map(function(t) {
          return '<span class="p86-pv-tag-modal-chip" style="--h:' + hueForLocal(t) + ';">' +
            '#' + escapeHTMLLocal(t) +
            '<button type="button" class="p86-pv-tag-modal-chip-rm" data-rm-modal-chip="' + escapeAttr(t) + '">&times;</button>' +
          '</span>';
        }).join('');
        modal.innerHTML =
          '<div class="modal-content p86-pv-tag-modal-content">' +
            '<div class="modal-header">' +
              '<span>Select Tags</span>' +
              '<button type="button" class="p86-modal-close" data-close>&times;</button>' +
            '</div>' +
            '<div class="p86-pv-tag-modal-body">' +
              '<div class="p86-pv-tag-combobox">' +
                '<div class="p86-pv-tag-combobox-chips">' + chipsHTML + '</div>' +
                '<input type="text" class="p86-pv-tag-combobox-input" placeholder="' + (selected.length ? 'Add another…' : 'Search or create…') + '" value="' + escapeAttr(query) + '" />' +
              '</div>' +
              '<div class="p86-pv-tag-modal-list"></div>' +
            '</div>' +
            '<div class="modal-footer">' +
              '<button type="button" class="primary" data-close>Done</button>' +
            '</div>' +
          '</div>';
        wirePaint();
        paintList();
      }

      function paintList() {
        var listEl = modal.querySelector('.p86-pv-tag-modal-list');
        if (!listEl) return;
        var vis = visibleCatalog();
        var html = '';
        if (canCreate()) {
          html += '<button type="button" class="p86-pv-tag-modal-row p86-pv-tag-modal-create" data-create-tag="' + escapeAttr(query.trim().toLowerCase().slice(0, 32)) + '">' +
            '<span class="p86-pv-tag-modal-create-plus">&#x2295;</span>' +
            '<span>Create <strong>#' + escapeHTMLLocal(query.trim().toLowerCase().slice(0, 32)) + '</strong></span>' +
          '</button>';
        }
        if (!vis.length && !canCreate()) {
          html += '<div class="p86-pv-tag-modal-empty">No tags found.</div>';
        } else {
          html += vis.map(function(t) {
            return '<button type="button" class="p86-pv-tag-modal-row" data-pick-tag="' + escapeAttr(t) + '" style="--h:' + hueForLocal(t) + ';">' +
              '<span class="p86-pv-tag-modal-row-tag">#' + escapeHTMLLocal(t) + '</span>' +
            '</button>';
          }).join('');
        }
        listEl.innerHTML = html;
        listEl.querySelectorAll('[data-pick-tag]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var t = btn.getAttribute('data-pick-tag');
            if (selected.indexOf(t) !== -1) return;
            commitSelection(selected.concat([t]));
          });
        });
        var createBtn = listEl.querySelector('[data-create-tag]');
        if (createBtn) createBtn.addEventListener('click', function() {
          var t = createBtn.getAttribute('data-create-tag');
          if (!t || selected.indexOf(t) !== -1) return;
          commitSelection(selected.concat([t]));
          // Clear the query so the freshly-created tag appears as a
          // chip and the user can immediately start typing the next.
          query = '';
        });
      }

      function wirePaint() {
        modal.querySelectorAll('[data-close]').forEach(function(b) {
          b.addEventListener('click', function() { modal.remove(); });
        });
        modal.querySelectorAll('[data-rm-modal-chip]').forEach(function(b) {
          b.addEventListener('click', function() {
            var t = b.getAttribute('data-rm-modal-chip');
            commitSelection(selected.filter(function(x) { return x !== t; }));
          });
        });
        var input = modal.querySelector('.p86-pv-tag-combobox-input');
        if (input) {
          // Focus + cursor at end. setTimeout because the DOM was
          // just rewritten and the input needs a tick to mount.
          setTimeout(function() {
            try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
            var v = input.value;
            input.value = '';
            input.value = v;
          }, 0);
          var debounceTimer;
          input.addEventListener('input', function(e) {
            query = String(e.target.value || '');
            paintList(); // re-render the list (and Create row) instantly
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(fetchCatalog, 200);
          });
          input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
              e.preventDefault();
              // Enter commits the typed value as a Create OR picks
              // the first list row if Create isn't applicable.
              if (canCreate()) {
                var newTag = query.trim().toLowerCase().slice(0, 32);
                commitSelection(selected.concat([newTag]));
                query = '';
              } else {
                var first = visibleCatalog()[0];
                if (first) commitSelection(selected.concat([first]));
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              modal.remove();
            }
          });
        }
      }

      // Click outside the modal-content closes — same pattern as the
      // rest of the codebase's modals.
      modal.addEventListener('click', function(e) {
        if (e.target === modal) modal.remove();
      });

      document.body.appendChild(modal);
      paint();
      fetchCatalog();
    }

    function wireStage() {
      overlay.querySelector('.p86-pv-stage').addEventListener('click', function(e) {
        var t = e.target.closest('[data-pv]');
        if (!t) return;
        var act = t.getAttribute('data-pv');
        if (act === 'close') close();
        else if (act === 'prev') prev();
        else if (act === 'next') next();
        else if (act === 'annotate') openAnnotator();
        else if (act === 'fullscreen') toggleFullscreen();
        else if (act === 'zoomin') setZoom(1);
        else if (act === 'zoomout') setZoom(-1);
        else if (act === 'download') downloadCurrent();
        else if (act === 'delete') deleteCurrent();
      });
    }

    function wirePanel(a) {
      // Panel close (mobile drawer X).
      var closeBtn = overlay.querySelector('.p86-pv-close-panel');
      if (closeBtn) closeBtn.addEventListener('click', close);

      // Tags strip — Buildertrend-style. Renders existing tags as
      // chips (with × to remove individually) and a single "+ Add
      // Tag" pill that opens a modal picker. The modal lists every
      // org tag in a scrollable searchable list, plus a "Create
      // '<typed>'" affordance when nothing matches. Replaces the
      // prior inline mountTagEditor — that one looked like a search
      // input by default, which made the "Add Tag" affordance
      // ambiguous.
      var tagsHost = overlay.querySelector('.p86-pv-tags-host');
      if (tagsHost) renderTagsStrip(tagsHost, a);

      // Description textarea — gated by the edit-gate pencil so a
      // stray tap can't trigger the on-blur PATCH. Saves on blur once
      // the section is unlocked.
      var descFs = overlay.querySelector('.p86-pv-desc-fs');
      var descInput = overlay.querySelector('.p86-pv-desc-input');
      if (window.p86EditGate && descFs) {
        window.p86EditGate.attachSection(descFs, { startUnlocked: false });
      }
      if (descInput) {
        descInput.addEventListener('blur', function() {
          var v = descInput.value || '';
          if ((a.caption || '') === v) return; // no change
          updateAtt({ caption: v });
        });
      }

      // Comments list + composer.
      var commentsList = overlay.querySelector('.p86-pv-comments-list');
      var composerInput = overlay.querySelector('.p86-pv-composer-input');
      var composerPost = overlay.querySelector('.p86-pv-composer-post');
      if (commentsList) paintComments(commentsList);
      if (composerPost && composerInput) {
        composerPost.addEventListener('click', function() {
          var body = composerInput.value || '';
          if (!body.trim()) return;
          composerPost.disabled = true;
          composerPost.textContent = 'Posting…';
          postComment(body).then(function() {
            composerInput.value = '';
          }).catch(function(e) {
            alert('Post failed: ' + (e.message || e));
          }).then(function() {
            composerPost.disabled = false;
            composerPost.textContent = 'Post';
          });
        });
        // Cmd/Ctrl+Enter = post (mobile keyboards send the same event).
        composerInput.addEventListener('keydown', function(e) {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            composerPost.click();
          }
        });
      }
    }

    function paintComments(host) {
      if (state.commentsLoading) {
        host.innerHTML = '<div class="p86-pv-comments-empty">Loading…</div>';
        return;
      }
      if (state.commentsError) {
        host.innerHTML = '<div class="p86-pv-comments-empty" style="color:#f87171;">' + escapeHTMLLocal(state.commentsError) + '</div>';
        return;
      }
      if (!state.comments || !state.comments.length) {
        host.innerHTML = '<div class="p86-pv-comments-empty">No comments yet.</div>';
        return;
      }
      var me = (window.p86Auth && typeof window.p86Auth.getUser === 'function') ? window.p86Auth.getUser() : null;
      var myId = me && me.id;
      host.innerHTML = state.comments.map(function(m) {
        var name = userNameFor(m.user_id);
        var mine = myId && Number(m.user_id) === Number(myId);
        return '<div class="p86-pv-comment">' +
          '<div class="p86-pv-comment-avatar">' + escapeHTMLLocal(initialsFor(name)) + '</div>' +
          '<div class="p86-pv-comment-body">' +
            '<div class="p86-pv-comment-meta">' +
              '<span class="p86-pv-comment-name">' + escapeHTMLLocal(name) + '</span>' +
              '<span class="p86-pv-comment-when">' + escapeHTMLLocal(fmtRelativeTime(m.created_at)) + '</span>' +
              (mine ? '<button class="p86-pv-comment-del" data-msg-id="' + escapeAttr(m.id) + '" title="Delete">&times;</button>' : '') +
            '</div>' +
            '<div class="p86-pv-comment-text">' + escapeHTMLLocal(m.body) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
      host.querySelectorAll('.p86-pv-comment-del').forEach(function(btn) {
        btn.addEventListener('click', function() { deleteComment(btn.getAttribute('data-msg-id')); });
      });
    }

    // First paint + kick off the initial comments fetch.
    render();
    fetchComments();
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
            html += '<div class="p86-proj-feed-grid p86-att-tile-grid" data-att-grid="1" style="margin-bottom:18px;">';
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
          html += '<div class="p86-proj-feed-grid p86-att-tile-grid" data-att-grid-markups="1" style="margin-bottom:18px;">';
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
            html += '<div class="p86-proj-feed-grid p86-att-tile-grid" data-att-grid-parent="1" style="margin-bottom:18px;opacity:0.95;">';
            parentPhotos.forEach(function(att, i) {
              html += renderParentPhotoTile(att, i);
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
      // Unified click delegation on every photo tile (owned + markup +
      // parent). Each tile carries data-att-tile-id + data-att-tile-kind
      // + data-att-tile-idx; clicks on .p86-proj-photo-tile-visual open
      // the new photo viewer, clicks on .p86-proj-photo-tile-annotate
      // open markup-viewer, clicks on .p86-proj-photo-tile-menu open
      // the context menu (pin / move / delete). One handler per grid
      // instead of per-tile wiring — re-renders don't leak listeners
      // because container.innerHTML wipes the old grid entirely.
      container.querySelectorAll('.p86-proj-photo-tile').forEach(function(tile) {
        var id = tile.getAttribute('data-att-tile-id');
        var kind = tile.getAttribute('data-att-tile-kind');
        var idx = parseInt(tile.getAttribute('data-att-tile-idx'), 10);
        var att = (kind === 'parent')
          ? state.parentAttachments.find(function(a) { return a.id === id; })
          : state.attachments.find(function(a) { return a.id === id; });
        if (!att) return;

        var visualEl = tile.querySelector('.p86-proj-photo-tile-visual');
        if (visualEl) {
          visualEl.addEventListener('click', function(e) {
            // Skip clicks on action buttons inside the visual area.
            if (e.target.closest('[data-att-action]')) return;
            if (kind === 'parent') {
              openLightbox(parentPhotos, idx, parentLightboxOpts());
            } else if (kind === 'markup') {
              openLightbox(markups, idx);
            } else {
              openLightbox(photos, idx);
            }
          });
        }
        var annotateBtn = tile.querySelector('[data-att-action="annotate"]');
        if (annotateBtn) annotateBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          openMarkupForOwned(att);
        });
        var menuBtn = tile.querySelector('[data-att-action="menu"]');
        if (menuBtn) menuBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          openTileContextMenu(menuBtn, att);
        });
        var markupParentBtn = tile.querySelector('[data-att-action="markup-parent"]');
        if (markupParentBtn) markupParentBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          openMarkupForParent(att);
        });
      });

      // Render annotation strokes onto every tile that opted in (the
      // tiles already painted a <canvas class="p86-proj-photo-tile-anno">
      // for any attachment with strokes). Mirrors the projects feed
      // behavior so what you saw in the markup viewer shows on the
      // thumbnail too.
      container.querySelectorAll('[data-att-anno-canvas]').forEach(function(canvas) {
        var id = canvas.getAttribute('data-att-anno-canvas');
        var att = state.attachments.find(function(a) { return a.id === id; })
               || state.parentAttachments.find(function(a) { return a.id === id; });
        if (!att || !Array.isArray(att.annotations) || !att.annotations.length) return;
        var img = canvas.parentNode.querySelector('.p86-proj-photo-tile-img');
        if (!img) return;
        function paintAnno() {
          canvas.width = img.naturalWidth || 1;
          canvas.height = img.naturalHeight || 1;
          var ctx = canvas.getContext('2d');
          if (window.p86AnnotationRender && typeof window.p86AnnotationRender.renderAll === 'function') {
            window.p86AnnotationRender.renderAll(ctx, att.annotations);
          }
        }
        if (img.complete && img.naturalWidth) paintAnno();
        else img.addEventListener('load', paintAnno, { once: true });
      });

      function parentLightboxOpts() {
        var label = parentLabel || ((parentEntity && parentEntity.entityType) || '');
        return { parentLabel: label };
      }

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
      // Parent-photo click + markup wiring is now handled by the
      // unified .p86-proj-photo-tile loop above — left here are just
      // the document (non-photo) parent rows that still use the
      // legacy data-attrs.
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

    // Render a single photo thumbnail tile. Mirrors the projects-style
    // tile (.p86-proj-photo-tile in styles.css) so every photo grid
    // across the app — lead editor, estimate editor, sub editor, job
    // attachments — has the same look + click target. Tile click
    // opens the new photo viewer with the tags / description /
    // comments side panel. The annotate pencil opens markup-viewer.
    // The ⋮ menu hosts contextual actions (pin to proposal, move
    // folder, delete) instead of crowding the top of the tile with
    // overlay buttons.
    //
    // The selection checkbox from the projects tile is intentionally
    // omitted — there's no bulk-action surface in mount() today, so
    // adding a checkbox would just be visual noise.
    //
    // isMarkup=true tiles get a small yellow "MARK" badge top-left
    // to distinguish annotated copies from originals at a glance.
    function renderPhotoTile(att, idx, isMarkup) {
      var pinActive = !!att.include_in_proposal;
      var uploaderName = att.uploaded_by_name || '';
      var uploaderInitials = uploaderName ? initialsForName(uploaderName) : '';
      var uploadedWhen = att.uploaded_at ? fmtRelativeTime(att.uploaded_at) : '';
      var tagCount = Array.isArray(att.tags) ? att.tags.length : 0;
      var hasCaption = !!att.caption;
      var annotationCount = Array.isArray(att.annotations) ? att.annotations.length : 0;
      var hasAnno = annotationCount > 0;

      var visualHTML = '<img class="p86-proj-photo-tile-img" src="' + escapeAttr(att.thumb_url) + '" alt="" onerror="this.parentNode.classList.add(\'att-thumb-broken\')" />' +
        (hasAnno ? '<canvas class="p86-proj-photo-tile-anno" data-att-anno-canvas="' + escapeAttr(att.id) + '"></canvas>' : '');

      return '<div class="p86-proj-photo-tile" data-att-tile-id="' + escapeAttr(att.id) + '"' +
                  ' data-att-tile-kind="' + (isMarkup ? 'markup' : 'photo') + '"' +
                  ' data-att-tile-idx="' + idx + '"' +
                  (pinActive ? ' data-att-tile-pinned="1"' : '') + '>' +
        '<div class="p86-proj-photo-tile-visual">' +
          visualHTML +
          // Markup badge — top-left. Replaces the old top-overlay row;
          // tells the user at a glance "this is an annotated copy."
          (isMarkup
            ? '<span class="p86-att-tile-markup-badge" title="Marked-up copy">&#x270F; MARK</span>'
            : '') +
          // Annotate + menu — top-right. Annotate goes straight to the
          // markup viewer; menu opens the context menu (pin / move /
          // delete). Edit-only — read-only callers (e.g. mount with
          // canEdit:false) don't see either.
          (canEdit
            ? '<button type="button" class="p86-proj-photo-tile-annotate" data-att-action="annotate" title="Annotate">&#x270E;</button>' +
              '<button type="button" class="p86-proj-photo-tile-menu" data-att-action="menu" title="More">&#x22EE;</button>'
            : '') +
          // Bottom-left: uploader avatar (initials in a chip).
          (uploaderInitials
            ? '<span class="p86-proj-photo-tile-uploader" title="' + escapeAttr(uploaderName) + '">' + escapeHTMLLocal(uploaderInitials) + '</span>'
            : '') +
          // Bottom-right: feature badges (caption / annotations /
          // tags / proposal-pin). Mirrors the projects feed badge row.
          '<div class="p86-proj-photo-tile-badges">' +
            (hasCaption ? '<span class="p86-proj-photo-tile-badge" title="' + escapeAttr(att.caption) + '">&#x1F4DD;</span>' : '') +
            (hasAnno ? '<span class="p86-proj-photo-tile-badge" title="' + annotationCount + ' annotation' + (annotationCount === 1 ? '' : 's') + '">&#x1F58D;' + (annotationCount > 1 ? ' ' + annotationCount : '') + '</span>' : '') +
            (tagCount ? '<span class="p86-proj-photo-tile-badge" title="' + escapeAttr((att.tags || []).join(', ')) + '">&#x1F3F7;' + (tagCount > 1 ? ' ' + tagCount : '') + '</span>' : '') +
            (pinActive ? '<span class="p86-proj-photo-tile-badge" title="In proposal" style="color:#34d399;">&#x1F4CC;</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="p86-proj-photo-tile-footer">' +
          '<span class="p86-proj-photo-tile-time">' + escapeHTMLLocal(att.filename || uploadedWhen) + '</span>' +
          (uploaderName ? '<span class="p86-proj-photo-tile-uploader-name">' + escapeHTMLLocal(uploaderName) + '</span>' : '') +
        '</div>' +
      '</div>';
    }

    // Read-only tile for the parent-record attachments band ("From
    // lead", "From estimate"). Same look as the editable tile so the
    // grid feels uniform, but the only action is the MARK button —
    // it opens markup-viewer with saveTarget pointing at the CURRENT
    // entity, so the resulting markup lands here, not on the parent.
    function renderParentPhotoTile(att, idx) {
      var label = (parentEntity && parentEntity.entityType) || 'parent';
      var uploaderName = att.uploaded_by_name || '';
      var uploaderInitials = uploaderName ? initialsForName(uploaderName) : '';
      var annotationCount = Array.isArray(att.annotations) ? att.annotations.length : 0;
      var hasAnno = annotationCount > 0;
      var tagCount = Array.isArray(att.tags) ? att.tags.length : 0;

      return '<div class="p86-proj-photo-tile p86-att-tile-parent" data-att-tile-id="' + escapeAttr(att.id) + '"' +
                  ' data-att-tile-kind="parent"' +
                  ' data-att-tile-idx="' + idx + '">' +
        '<div class="p86-proj-photo-tile-visual">' +
          '<img class="p86-proj-photo-tile-img" src="' + escapeAttr(att.thumb_url) + '" alt="" onerror="this.parentNode.classList.add(\'att-thumb-broken\')" />' +
          (hasAnno ? '<canvas class="p86-proj-photo-tile-anno" data-att-anno-canvas="' + escapeAttr(att.id) + '"></canvas>' : '') +
          // Parent-source badge — top-left. "LEAD" / "ESTIMATE" /
          // etc. so it's obvious this attachment isn't owned here.
          '<span class="p86-att-tile-parent-badge">' + escapeHTMLLocal(label) + '</span>' +
          // Markup affordance — top-right. Save lands on the CURRENT
          // entity (handled by the click wiring below).
          (canEdit
            ? '<button type="button" class="p86-proj-photo-tile-annotate" data-att-action="markup-parent" title="Mark up — saves into this ' + escapeAttr(entityType) + '">&#x270E;</button>'
            : '') +
          (uploaderInitials
            ? '<span class="p86-proj-photo-tile-uploader" title="' + escapeAttr(uploaderName) + '">' + escapeHTMLLocal(uploaderInitials) + '</span>'
            : '') +
          '<div class="p86-proj-photo-tile-badges">' +
            (hasAnno ? '<span class="p86-proj-photo-tile-badge" title="' + annotationCount + ' annotation' + (annotationCount === 1 ? '' : 's') + '">&#x1F58D;' + (annotationCount > 1 ? ' ' + annotationCount : '') + '</span>' : '') +
            (tagCount ? '<span class="p86-proj-photo-tile-badge" title="' + escapeAttr((att.tags || []).join(', ')) + '">&#x1F3F7;' + (tagCount > 1 ? ' ' + tagCount : '') + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="p86-proj-photo-tile-footer">' +
          '<span class="p86-proj-photo-tile-time">' + escapeHTMLLocal(att.filename) + '</span>' +
          (uploaderName ? '<span class="p86-proj-photo-tile-uploader-name">' + escapeHTMLLocal(uploaderName) + '</span>' : '') +
        '</div>' +
      '</div>';
    }

    // Tiny initials helper — mirrors initialsFor at the top of this
    // file (which already serves the photo viewer's uploader avatar).
    // Kept local because the top-of-file helper isn't in this scope.
    function initialsForName(name) {
      if (!name) return '?';
      var parts = String(name).trim().split(/\s+/);
      if (!parts.length) return '?';
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    // Context menu for an owned tile — pops near the menu button and
    // offers the actions that used to live in the top-right overlay
    // (pin to proposal, move folder, delete). Clicking outside or
    // hitting Esc closes; clicking an action runs it and closes.
    function openTileContextMenu(anchorBtn, att) {
      var prior = document.getElementById('p86-att-tile-menu');
      if (prior) prior.remove();
      var menu = document.createElement('div');
      menu.id = 'p86-att-tile-menu';
      menu.className = 'p86-att-tile-menu';
      var pinActive = !!att.include_in_proposal;
      menu.innerHTML =
        '<button type="button" data-act="annotate">' +
          '<span class="p86-att-tile-menu-icon">&#x270E;</span>Annotate' +
        '</button>' +
        '<button type="button" data-act="pin">' +
          '<span class="p86-att-tile-menu-icon">&#x1F4CC;</span>' +
          (pinActive ? 'Remove from proposal' : 'Add to proposal') +
        '</button>' +
        '<button type="button" data-act="move">' +
          '<span class="p86-att-tile-menu-icon">&#x1F4C1;</span>Move to folder…' +
        '</button>' +
        '<button type="button" data-act="delete" class="p86-att-tile-menu-danger">' +
          '<span class="p86-att-tile-menu-icon">&#x1F5D1;</span>Delete' +
        '</button>';
      document.body.appendChild(menu);
      // Position the menu under the anchor (the ⋮ button on the tile).
      var rect = anchorBtn.getBoundingClientRect();
      menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
      var left = Math.max(8, rect.right + window.scrollX - menu.offsetWidth);
      menu.style.left = left + 'px';
      function close() {
        if (menu.parentNode) menu.parentNode.removeChild(menu);
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
      }
      function onOutside(e) {
        if (!menu.contains(e.target)) close();
      }
      function onKey(e) {
        if (e.key === 'Escape') close();
      }
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
      menu.querySelectorAll('button[data-act]').forEach(function(b) {
        b.addEventListener('click', function() {
          var act = b.getAttribute('data-act');
          close();
          if (act === 'annotate') openMarkupForOwned(att);
          else if (act === 'pin') togglePin(att);
          else if (act === 'move') moveAttachmentFolder(att);
          else if (act === 'delete') deleteAttachment(att.id, 'photo');
        });
      });
    }

    function openMarkupForOwned(att) {
      if (!window.p86Markup || typeof window.p86Markup.open !== 'function') {
        alert('Markup viewer not loaded — refresh the page.');
        return;
      }
      window.p86Markup.open({ attachment: att, onDone: fetchList });
    }
    function openMarkupForParent(att) {
      if (!window.p86Markup || typeof window.p86Markup.open !== 'function') {
        alert('Markup viewer not loaded — refresh the page.');
        return;
      }
      window.p86Markup.open({
        attachment: att,
        saveTarget: { entityType: entityType, entityId: entityId },
        onDone: fetchList
      });
    }
    function togglePin(att) {
      var next = !att.include_in_proposal;
      att.include_in_proposal = next;
      render();
      window.p86Api.attachments.update(att.id, { include_in_proposal: next })
        .catch(function(err) {
          att.include_in_proposal = !next; // rollback
          render();
          alert('Failed to update: ' + (err.message || ''));
        });
    }
    function moveAttachmentFolder(att) {
      var current = att.folder || 'general';
      var prompt = 'Move "' + (att.filename || 'file') + '" to folder:\n\n' +
        'Folder name (e.g. photos, rfp, contracts) — letters, numbers, spaces, dashes.';
      var next = window.prompt(prompt, current);
      if (next == null) return;
      var folder = sanitizeFolder(next);
      if (folder === current) return;
      window.p86Api.attachments.update(att.id, { folder: folder })
        .then(fetchList)
        .catch(function(err) {
          alert('Move failed: ' + (err.message || ''));
        });
    }

    fetchList();
  }

  window.p86Attachments = { mount: mount, openLightbox: openLightbox };
})();
