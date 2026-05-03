// AGX photo markup viewer.
//
// Bluebeam-style markup overlay: left vertical toolbar + canvas. Tools:
// Select (move/delete), Arrow, Line, Rect, Ellipse, Draw, Text, Sticker.
// Color swatches, line-width slider, undo, clear, save.
//
// On Save: rasterizes image + canvas to PNG and either replaces the
// original or saves as a new attachment with markup_of pointing back at
// the source. Optional "Attach to proposal" toggles include_in_proposal.
//
// Usage:
//   window.agxMarkup.open({
//     attachment: { id, original_url, web_url, filename, entity_type, entity_id },
//     onDone: function() { /* refresh list */ }
//   });
(function() {
  'use strict';

  // ── Tool catalog (left sidebar order) ────────────────────────────
  var TOOLS = [
    { key: 'select',  glyph: '\u{1F446}', label: 'Select / move' },
    { key: 'arrow',   glyph: '↗',     label: 'Arrow' },
    { key: 'line',    glyph: '─',     label: 'Line' },
    { key: 'rect',    glyph: '▭',     label: 'Rectangle' },
    { key: 'ellipse', glyph: '◯',     label: 'Ellipse' },
    { key: 'draw',    glyph: '✎',     label: 'Free draw' },
    { key: 'text',    glyph: 'T',          label: 'Text' },
    { key: 'sticker', glyph: '\u{1F3F7}',  label: 'Sticker / stamp' }
  ];
  var DEFAULT_COLORS = ['#ef4444', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#000000', '#ffffff'];

  // Sticker catalog. Each entry has a `kind` key, a `label`, and a
  // `draw(ctx, x, y, size, color)` function that renders it. Stickers
  // come in two flavors: glyph (big Unicode char) and stamp (boxed
  // text with background fill, slightly rotated like a real stamp).
  // The 'number' sticker is special — its label increments per-place.
  var STICKERS = [
    glyphSticker('check',     '✓', 'Check'),
    glyphSticker('cross',     '✗', 'X mark'),
    glyphSticker('warn',      '⚠', 'Warning'),
    glyphSticker('star',      '★', 'Star'),
    glyphSticker('exclaim',   '❗', 'Exclaim'),
    glyphSticker('arrowstamp','→', 'Arrow stamp'),
    numberedSticker('number', '#', 'Number callout'),
    stampSticker('approved',  'APPROVED', '#16a34a', 'Approved stamp'),
    stampSticker('void',      'VOID',     '#dc2626', 'Void stamp'),
    stampSticker('revise',    'REVISE',   '#ea580c', 'Revise stamp'),
    stampSticker('draft',     'DRAFT',    '#475569', 'Draft stamp')
  ];

  var state = null;          // active markup session
  var _numberCounter = 1;    // resets per session

  function open(opts) {
    opts = opts || {};
    if (!opts.attachment) { alert('No attachment supplied.'); return; }
    if (state) closeOverlay();
    _numberCounter = 1;
    state = {
      attachment: opts.attachment,
      onDone: opts.onDone || function() {},
      tool: 'arrow',
      stickerKind: null,
      color: '#ef4444',
      lineWidth: 4,
      strokes: [],
      currentStroke: null,
      selectedIdx: null,
      dragLast: null,
      img: null,
      naturalSize: { w: 0, h: 0 }
    };
    buildOverlay();
  }

  // ── Layout / overlay ───────────────────────────────────────────
  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'agx-markup-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:5000;display:flex;flex-direction:column;padding:14px;';
    overlay.innerHTML =
      // Top bar — filename + actions (Cancel / Save)
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;background:rgba(15,15,30,0.95);border:1px solid #2a2a3a;border-radius:10px;padding:8px 14px;">' +
        '<strong style="color:#fff;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(state.attachment.filename || 'Photo') + '</strong>' +
        '<span id="agx-mk-hint" style="color:#aaa;font-size:11px;margin-right:8px;"></span>' +
        '<button id="agx-mk-cancel" style="background:rgba(255,255,255,0.06);color:#aaa;border:1px solid #444;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;">Cancel</button>' +
        '<button id="agx-mk-save" style="background:#4f8cff;color:#fff;border:0;border-radius:6px;padding:6px 16px;font-size:12px;font-weight:700;cursor:pointer;">Save…</button>' +
      '</div>' +
      // Body — left sidebar + canvas area
      '<div style="display:flex;gap:10px;flex:1;min-height:0;">' +
        // Sidebar
        '<div id="agx-mk-sidebar" style="width:64px;flex:0 0 64px;background:rgba(15,15,30,0.95);border:1px solid #2a2a3a;border-radius:10px;padding:8px 6px;display:flex;flex-direction:column;gap:6px;align-items:center;overflow-y:auto;">' +
          // Tools
          TOOLS.map(function(t) {
            return '<button data-mk-tool="' + t.key + '" title="' + escapeHTML(t.label) + '" style="width:48px;height:44px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;font-weight:600;">' + t.glyph + '</button>';
          }).join('') +
          // Divider
          '<div style="width:36px;height:1px;background:#3a3a4a;margin:6px 0;"></div>' +
          // Colors (3-wide grid)
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;width:100%;padding:0 4px;">' +
            DEFAULT_COLORS.map(function(c) {
              return '<button data-mk-color="' + c + '" title="' + c + '" style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.2);border-radius:50%;background:' + c + ';cursor:pointer;padding:0;justify-self:center;"></button>';
            }).join('') +
          '</div>' +
          // Divider
          '<div style="width:36px;height:1px;background:#3a3a4a;margin:6px 0;"></div>' +
          // Width slider (vertical)
          '<div style="text-align:center;">' +
            '<div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Width</div>' +
            '<input id="agx-mk-width" type="range" min="1" max="20" value="4" style="width:48px;" />' +
          '</div>' +
          // Divider
          '<div style="width:36px;height:1px;background:#3a3a4a;margin:6px 0;"></div>' +
          // Undo / Clear
          '<button id="agx-mk-undo" title="Undo (Ctrl+Z)" style="width:48px;height:32px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:14px;cursor:pointer;">↶</button>' +
          '<button id="agx-mk-clear" title="Clear all" style="width:48px;height:32px;background:rgba(248,113,113,0.10);color:#f87171;border:1px solid rgba(248,113,113,0.35);border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;">CLR</button>' +
          // Sticker picker (rendered conditionally below toolbar when sticker tool active)
          '<div id="agx-mk-sticker-picker" style="display:none;width:100%;margin-top:6px;padding:6px 4px;background:rgba(0,0,0,0.3);border:1px solid #3a3a4a;border-radius:6px;"></div>' +
        '</div>' +
        // Canvas area
        '<div style="flex:1;background:#000;border:1px solid #2a2a3a;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:0;">' +
          '<canvas id="agx-mk-canvas" style="display:block;max-width:100%;max-height:100%;"></canvas>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    var canvas = overlay.querySelector('#agx-mk-canvas');
    loadImageInto(canvas);

    // Tool buttons
    overlay.querySelectorAll('[data-mk-tool]').forEach(function(btn) {
      btn.onclick = function() {
        state.tool = btn.dataset.mkTool;
        if (state.tool !== 'sticker') state.stickerKind = null;
        if (state.tool !== 'select') state.selectedIdx = null;
        refreshToolbar(overlay);
        renderStickerPicker(overlay);
        updateHint(overlay);
        redraw();
      };
    });
    overlay.querySelectorAll('[data-mk-color]').forEach(function(btn) {
      btn.onclick = function() {
        state.color = btn.dataset.mkColor;
        refreshToolbar(overlay);
        if (state.selectedIdx != null) {
          var s = state.strokes[state.selectedIdx];
          if (s) { s.color = state.color; redraw(); }
        }
      };
    });
    overlay.querySelector('#agx-mk-width').oninput = function(e) {
      state.lineWidth = parseInt(e.target.value, 10) || 4;
      if (state.selectedIdx != null) {
        var s = state.strokes[state.selectedIdx];
        if (s) { s.lineWidth = state.lineWidth; redraw(); }
      }
    };
    overlay.querySelector('#agx-mk-undo').onclick = function() {
      state.strokes.pop();
      state.selectedIdx = null;
      redraw();
    };
    overlay.querySelector('#agx-mk-clear').onclick = function() {
      if (!state.strokes.length || confirm('Clear all markup?')) {
        state.strokes = [];
        state.selectedIdx = null;
        redraw();
      }
    };
    overlay.querySelector('#agx-mk-cancel').onclick = function() {
      if (!state.strokes.length || confirm('Discard your markup?')) closeOverlay();
    };
    overlay.querySelector('#agx-mk-save').onclick = function() { openSaveDialog(); };

    refreshToolbar(overlay);
    renderStickerPicker(overlay);
    updateHint(overlay);
    wireCanvasInput(canvas);

    // Esc / Ctrl+Z / Delete
    overlay.tabIndex = -1;
    overlay.focus();
    overlay.onkeydown = function(e) {
      if (e.key === 'Escape') overlay.querySelector('#agx-mk-cancel').click();
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        state.strokes.pop();
        state.selectedIdx = null;
        redraw();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIdx != null) {
        e.preventDefault();
        state.strokes.splice(state.selectedIdx, 1);
        state.selectedIdx = null;
        redraw();
      }
    };
  }

  function loadImageInto(canvas) {
    var proxyUrl = '/api/attachments/raw/' + encodeURIComponent(state.attachment.id) + '?variant=web';
    var headers = {};
    var token = (window.agxAuth && typeof window.agxAuth.getToken === 'function') ? window.agxAuth.getToken() : null;
    if (!token) { try { token = localStorage.getItem('agx-auth-token'); } catch (e) { /* ignore */ } }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    fetch(proxyUrl, { headers: headers, credentials: 'same-origin' })
      .then(function(r) {
        if (!r.ok) {
          return r.text().then(function(body) { throw new Error('HTTP ' + r.status + ': ' + (body || r.statusText).slice(0, 200)); });
        }
        return r.blob();
      })
      .then(function(blob) {
        var blobUrl = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function() {
          state.img = img;
          state.naturalSize = { w: img.naturalWidth, h: img.naturalHeight };
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          redraw();
          setTimeout(function() { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 0);
        };
        img.onerror = function() {
          alert('Image decoded but failed to render.');
          closeOverlay();
        };
        img.src = blobUrl;
      })
      .catch(function(err) {
        alert('Failed to load image for markup.\n\n' + (err && err.message ? err.message : ''));
        closeOverlay();
      });
  }

  function refreshToolbar(overlay) {
    overlay.querySelectorAll('[data-mk-tool]').forEach(function(btn) {
      var active = btn.dataset.mkTool === state.tool;
      btn.style.background = active ? '#4f8cff' : 'rgba(255,255,255,0.05)';
      btn.style.color = active ? '#fff' : '#ddd';
      btn.style.borderColor = active ? '#4f8cff' : '#444';
    });
    overlay.querySelectorAll('[data-mk-color]').forEach(function(btn) {
      var active = btn.dataset.mkColor === state.color;
      btn.style.borderColor = active ? '#fff' : 'rgba(255,255,255,0.2)';
      btn.style.boxShadow = active ? '0 0 0 2px rgba(255,255,255,0.4)' : 'none';
    });
  }

  function renderStickerPicker(overlay) {
    var picker = overlay.querySelector('#agx-mk-sticker-picker');
    if (!picker) return;
    if (state.tool !== 'sticker') { picker.style.display = 'none'; return; }
    picker.style.display = '';
    picker.innerHTML =
      '<div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.5px;text-align:center;margin-bottom:4px;">Pick</div>' +
      '<div style="display:grid;grid-template-columns:1fr;gap:3px;">' +
      STICKERS.map(function(st) {
        var active = state.stickerKind === st.kind;
        return '<button data-mk-sticker="' + st.kind + '" title="' + escapeHTML(st.label) + '" ' +
          'style="width:48px;height:30px;background:' + (active ? '#4f8cff' : 'rgba(255,255,255,0.05)') +
          ';color:' + (active ? '#fff' : '#ddd') + ';border:1px solid ' + (active ? '#4f8cff' : '#444') +
          ';border-radius:5px;font-size:11px;cursor:pointer;font-weight:600;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          st.previewHtml + '</button>';
      }).join('') +
      '</div>';
    picker.querySelectorAll('[data-mk-sticker]').forEach(function(btn) {
      btn.onclick = function() {
        state.stickerKind = btn.dataset.mkSticker;
        renderStickerPicker(overlay);
        updateHint(overlay);
      };
    });
  }

  function updateHint(overlay) {
    var hint = overlay.querySelector('#agx-mk-hint');
    if (!hint) return;
    if (state.tool === 'select') {
      hint.textContent = state.selectedIdx != null ? 'Drag to move · Delete to remove' : 'Click an element to select';
    } else if (state.tool === 'sticker') {
      hint.textContent = state.stickerKind ? 'Click on the photo to place' : 'Pick a sticker on the left';
    } else if (state.tool === 'text') {
      hint.textContent = 'Click on the photo to place text';
    } else {
      hint.textContent = 'Click and drag on the photo';
    }
  }

  // ── Canvas input ────────────────────────────────────────────────
  function wireCanvasInput(canvas) {
    function localPoint(e) {
      var rect = canvas.getBoundingClientRect();
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var clientY = e.touches ? e.touches[0].clientY : e.clientY;
      var x = (clientX - rect.left) * (canvas.width / rect.width);
      var y = (clientY - rect.top) * (canvas.height / rect.height);
      return { x: x, y: y };
    }
    function setCursor() {
      if (state.tool === 'select') {
        canvas.style.cursor = state.selectedIdx != null ? 'move' : 'pointer';
      } else if (state.tool === 'text' || state.tool === 'sticker') {
        canvas.style.cursor = 'copy';
      } else {
        canvas.style.cursor = 'crosshair';
      }
    }
    setCursor();

    canvas.onmousedown = function(e) {
      e.preventDefault();
      var p = localPoint(e);

      // Select tool: hit-test top-down to find a stroke under the point.
      if (state.tool === 'select') {
        var idx = hitTestStrokes(p);
        state.selectedIdx = idx;
        if (idx != null) {
          state.dragLast = p;
        } else {
          state.dragLast = null;
        }
        setCursor();
        var overlay = document.getElementById('agx-markup-overlay');
        if (overlay) updateHint(overlay);
        redraw();
        return;
      }

      // Text tool: prompt then place.
      if (state.tool === 'text') {
        var msg = prompt('Text to add:');
        if (msg) {
          state.strokes.push({
            tool: 'text', color: state.color, lineWidth: state.lineWidth,
            x: p.x, y: p.y, text: msg, fontPx: Math.max(14, state.lineWidth * 6)
          });
          redraw();
        }
        return;
      }

      // Sticker tool: stamp a sticker at point.
      if (state.tool === 'sticker') {
        if (!state.stickerKind) { alert('Pick a sticker on the left first.'); return; }
        var size = Math.max(40, state.lineWidth * 14);
        var label = state.stickerKind === 'number' ? String(_numberCounter++) : null;
        state.strokes.push({
          tool: 'sticker', kind: state.stickerKind,
          color: state.color, lineWidth: state.lineWidth,
          x: p.x, y: p.y, size: size, label: label
        });
        redraw();
        return;
      }

      // Drawing tools: start a new stroke.
      state.currentStroke = {
        tool: state.tool, color: state.color, lineWidth: state.lineWidth,
        startX: p.x, startY: p.y, endX: p.x, endY: p.y,
        points: state.tool === 'draw' ? [p] : null
      };
    };

    canvas.onmousemove = function(e) {
      var p = localPoint(e);
      // Select-drag: move the selected stroke.
      if (state.tool === 'select' && state.dragLast && state.selectedIdx != null) {
        var s = state.strokes[state.selectedIdx];
        if (s) {
          var dx = p.x - state.dragLast.x;
          var dy = p.y - state.dragLast.y;
          translateStroke(s, dx, dy);
          state.dragLast = p;
          redraw();
        }
        return;
      }
      // Drawing in progress.
      if (!state.currentStroke) return;
      if (state.currentStroke.tool === 'draw') {
        state.currentStroke.points.push(p);
      } else {
        state.currentStroke.endX = p.x;
        state.currentStroke.endY = p.y;
      }
      redraw(state.currentStroke);
    };

    var endStroke = function() {
      if (state.tool === 'select') { state.dragLast = null; return; }
      if (!state.currentStroke) return;
      // Drop zero-size shapes (just a click, no drag) for arrow/line/rect/ellipse.
      var s = state.currentStroke;
      var minDist = (s.tool === 'draw') ? 0 : 4;
      if (minDist) {
        var dx = (s.endX - s.startX), dy = (s.endY - s.startY);
        if (Math.sqrt(dx * dx + dy * dy) < minDist) {
          state.currentStroke = null;
          redraw();
          return;
        }
      }
      state.strokes.push(s);
      state.currentStroke = null;
      redraw();
    };
    canvas.onmouseup = endStroke;
    canvas.onmouseleave = endStroke;
  }

  // ── Hit testing & translation ──────────────────────────────────
  function strokeBBox(s) {
    if (s.tool === 'draw' && s.points && s.points.length) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      s.points.forEach(function(p) {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      });
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    if (s.startX != null) {
      var x1 = Math.min(s.startX, s.endX), y1 = Math.min(s.startY, s.endY);
      var x2 = Math.max(s.startX, s.endX), y2 = Math.max(s.startY, s.endY);
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    if (s.tool === 'text') {
      var fontPx = s.fontPx || 24;
      // rough — actual width depends on text length; fontPx*0.6 per char ballpark
      var w = (s.text || '').length * fontPx * 0.55;
      return { x: s.x, y: s.y, w: w, h: fontPx };
    }
    if (s.tool === 'sticker') {
      var sz = s.size || 48;
      // Stickers are roughly centered — shift box back to top-left for hit math.
      var def = stickerDef(s.kind);
      if (def && def.kind === 'stamp') {
        var w2 = (def.text.length || 4) * sz * 0.45;
        return { x: s.x - w2 / 2, y: s.y - sz / 2, w: w2, h: sz };
      }
      return { x: s.x - sz / 2, y: s.y - sz / 2, w: sz, h: sz };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  function hitTestStrokes(p) {
    // Top-down so click picks the visually-topmost stroke.
    for (var i = state.strokes.length - 1; i >= 0; i--) {
      var bb = strokeBBox(state.strokes[i]);
      var slop = 10;
      if (p.x >= bb.x - slop && p.x <= bb.x + bb.w + slop &&
          p.y >= bb.y - slop && p.y <= bb.y + bb.h + slop) {
        return i;
      }
    }
    return null;
  }

  function translateStroke(s, dx, dy) {
    if (s.points) s.points.forEach(function(p) { p.x += dx; p.y += dy; });
    if (s.startX != null) { s.startX += dx; s.endX += dx; s.startY += dy; s.endY += dy; }
    if (s.x != null) { s.x += dx; s.y += dy; }
  }

  // ── Drawing ─────────────────────────────────────────────────────
  function redraw(extra) {
    var canvas = document.getElementById('agx-mk-canvas');
    if (!canvas || !state.img) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(state.img, 0, 0, canvas.width, canvas.height);
    state.strokes.forEach(function(s, i) {
      drawStroke(ctx, s);
      if (i === state.selectedIdx) drawSelection(ctx, s);
    });
    if (extra) drawStroke(ctx, extra);
  }

  function drawStroke(ctx, s) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.tool === 'draw' && s.points && s.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (var i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.stroke();
    } else if (s.tool === 'rect') {
      ctx.strokeRect(s.startX, s.startY, s.endX - s.startX, s.endY - s.startY);
    } else if (s.tool === 'ellipse') {
      var cx = (s.startX + s.endX) / 2, cy = (s.startY + s.endY) / 2;
      var rx = Math.abs(s.endX - s.startX) / 2, ry = Math.abs(s.endY - s.startY) / 2;
      ctx.beginPath();
      if (typeof ctx.ellipse === 'function') ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      else ctx.arc(cx, cy, Math.max(rx, ry), 0, Math.PI * 2); // fallback
      ctx.stroke();
    } else if (s.tool === 'line') {
      ctx.beginPath();
      ctx.moveTo(s.startX, s.startY);
      ctx.lineTo(s.endX, s.endY);
      ctx.stroke();
    } else if (s.tool === 'arrow') {
      drawArrow(ctx, s.startX, s.startY, s.endX, s.endY, s.lineWidth);
    } else if (s.tool === 'text') {
      ctx.font = 'bold ' + (s.fontPx || 24) + 'px Arial,sans-serif';
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(2, (s.fontPx || 24) / 12);
      ctx.strokeStyle = '#000';
      ctx.strokeText(s.text, s.x, s.y);
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, s.x, s.y);
    } else if (s.tool === 'sticker') {
      var def = stickerDef(s.kind);
      if (def) def.draw(ctx, s.x, s.y, s.size || 48, s.color || '#ef4444', s.label);
    }
    ctx.restore();
  }

  function drawSelection(ctx, s) {
    var bb = strokeBBox(s);
    var pad = 6;
    ctx.save();
    ctx.strokeStyle = '#4f8cff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(bb.x - pad, bb.y - pad, bb.w + pad * 2, bb.h + pad * 2);
    ctx.restore();
  }

  function drawArrow(ctx, x1, y1, x2, y2, width) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    var headLen = Math.max(10, width * 4);
    var angle = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  // ── Stickers ────────────────────────────────────────────────────
  function stickerDef(kind) {
    return STICKERS.find(function(s) { return s.kind === kind; }) || null;
  }

  function glyphSticker(kind, glyph, label) {
    return {
      kind: kind,
      label: label,
      previewHtml: escapeHTML(glyph),
      draw: function(ctx, x, y, size, color) {
        var fontPx = size;
        ctx.font = 'bold ' + fontPx + 'px Arial,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(3, fontPx / 12);
        ctx.strokeStyle = '#000';
        ctx.strokeText(glyph, x, y);
        ctx.fillStyle = color;
        ctx.fillText(glyph, x, y);
      }
    };
  }

  function numberedSticker(kind, _glyph, label) {
    return {
      kind: kind,
      label: label,
      previewHtml: '①', // ① preview
      draw: function(ctx, x, y, size, color, num) {
        var radius = size / 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = Math.max(2, radius / 8);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold ' + (size * 0.55) + 'px Arial,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(num || '1'), x, y);
      }
    };
  }

  function stampSticker(kind, text, defaultColor, label) {
    return {
      kind: kind,
      label: label,
      previewHtml: '<span style="font-size:9px;color:' + defaultColor + ';">' + escapeHTML(text) + '</span>',
      draw: function(ctx, x, y, size, color) {
        // Use a default brand color tied to the stamp meaning, ignoring
        // the global color picker — APPROVED is always green, etc.
        var c = defaultColor;
        var fontPx = size * 0.6;
        ctx.font = 'bold ' + fontPx + 'px Arial,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var w = ctx.measureText(text).width + size * 0.6;
        var h = fontPx * 1.5;
        ctx.translate(x, y);
        ctx.rotate(-0.13);
        ctx.lineWidth = Math.max(3, fontPx / 8);
        ctx.strokeStyle = c;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        roundRect(ctx, -w / 2, -h / 2, w, h, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = c;
        ctx.fillText(text, 0, 0);
      }
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // ── Save dialog ─────────────────────────────────────────────────
  function openSaveDialog() {
    if (!state.strokes.length) {
      alert('No markup yet — draw something or Cancel.');
      return;
    }
    var prevDialog = document.getElementById('agx-mk-savedlg');
    if (prevDialog) prevDialog.remove();
    var dlg = document.createElement('div');
    dlg.id = 'agx-mk-savedlg';
    dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:5100;display:flex;align-items:center;justify-content:center;';
    dlg.innerHTML =
      '<div style="background:var(--surface,#15152a);border:1px solid var(--border,#333);border-radius:12px;padding:20px 22px;width:420px;max-width:90vw;color:var(--text,#fff);">' +
        '<h3 style="margin:0 0 12px 0;font-size:15px;">Save markup</h3>' +
        '<p style="margin:0 0 14px 0;color:var(--text-dim,#888);font-size:12px;">Pick where this annotated copy lands.</p>' +
        '<div style="display:flex;flex-direction:column;gap:8px;font-size:13px;">' +
          '<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:10px;border:1px solid var(--border,#333);border-radius:8px;">' +
            '<input type="radio" name="mk-save-mode" value="new" checked style="margin-top:3px;" />' +
            '<div><div style="font-weight:600;">Save as new</div><div style="color:var(--text-dim,#888);font-size:11px;">Original is kept. Markup appears under "Markups" linked to the original.</div></div>' +
          '</label>' +
          '<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:10px;border:1px solid var(--border,#333);border-radius:8px;">' +
            '<input type="radio" name="mk-save-mode" value="replace" style="margin-top:3px;" />' +
            '<div><div style="font-weight:600;">Replace original</div><div style="color:var(--text-dim,#888);font-size:11px;">Original photo is overwritten with the marked-up version. Cannot be undone.</div></div>' +
          '</label>' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 10px;border:1px solid var(--border,#333);border-radius:8px;background:rgba(79,140,255,0.04);">' +
            '<input type="checkbox" id="mk-include-in-proposal" />' +
            '<span><strong>Attach to proposal</strong> <span style="color:var(--text-dim,#888);font-size:11px;margin-left:4px;">— include in the estimate\'s proposal output.</span></span>' +
          '</label>' +
        '</div>' +
        '<div id="mk-save-status" style="margin-top:10px;font-size:12px;min-height:14px;"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">' +
          '<button id="mk-save-cancel" style="background:rgba(255,255,255,0.06);color:#aaa;border:1px solid #444;border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer;">Cancel</button>' +
          '<button id="mk-save-confirm" style="background:#4f8cff;color:#fff;border:0;border-radius:6px;padding:7px 18px;font-size:12px;font-weight:700;cursor:pointer;">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);
    dlg.querySelector('#mk-save-cancel').onclick = function() { dlg.remove(); };
    dlg.querySelector('#mk-save-confirm').onclick = function() {
      var mode = (dlg.querySelector('input[name="mk-save-mode"]:checked') || {}).value || 'new';
      var includeInProposal = dlg.querySelector('#mk-include-in-proposal').checked;
      var statusEl = dlg.querySelector('#mk-save-status');
      var btn = dlg.querySelector('#mk-save-confirm');
      btn.disabled = true;
      statusEl.style.color = 'var(--text-dim,#aaa)';
      statusEl.textContent = 'Rasterizing…';
      // Drop selection box from the saved image — clear selection then redraw.
      state.selectedIdx = null;
      redraw();
      runSave(mode, includeInProposal).then(function() {
        statusEl.style.color = '#34d399';
        statusEl.textContent = 'Saved.';
        setTimeout(function() {
          dlg.remove();
          closeOverlay();
          state && state.onDone && state.onDone();
        }, 350);
      }).catch(function(err) {
        btn.disabled = false;
        statusEl.style.color = '#f87171';
        statusEl.textContent = 'Save failed: ' + (err.message || 'unknown error');
      });
    };
  }

  function canvasToFile(canvas, filename) {
    return new Promise(function(resolve, reject) {
      canvas.toBlob(function(blob) {
        if (!blob) return reject(new Error('Could not export canvas to image.'));
        resolve(new File([blob], filename, { type: 'image/png' }));
      }, 'image/png', 0.92);
    });
  }

  function deriveMarkupFilename(original) {
    var name = (original && original.filename) || 'photo';
    var base = name.replace(/\.[a-z0-9]+$/i, '');
    return base + '_markup.png';
  }

  function runSave(mode, includeInProposal) {
    var canvas = document.getElementById('agx-mk-canvas');
    if (!canvas) return Promise.reject(new Error('Canvas missing.'));
    var att = state.attachment;
    return canvasToFile(canvas, deriveMarkupFilename(att)).then(function(file) {
      var extra = {};
      if (mode === 'new' && att.id) extra.markup_of = att.id;
      if (includeInProposal) extra.include_in_proposal = true;
      var uploadP = window.agxApi.attachments.upload(att.entity_type, att.entity_id, file, extra);
      if (mode === 'replace') {
        return uploadP.then(function(r) {
          return window.agxApi.attachments.remove(att.id).catch(function() {}).then(function() { return r; });
        });
      }
      return uploadP;
    });
  }

  function closeOverlay() {
    var overlay = document.getElementById('agx-markup-overlay');
    if (overlay) overlay.remove();
    state = null;
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.agxMarkup = { open: open, close: closeOverlay };
})();
