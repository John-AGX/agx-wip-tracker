// AGX photo markup viewer.
//
// Opens a modal with a canvas overlay on top of an attachment image.
// Tools: arrow, rectangle, free-draw, text, color picker, undo, clear.
// On Save: rasterizes image + canvas to a PNG and either replaces the
// original (DELETE source + upload new with same entity) or saves as
// a new attachment with markup_of pointing back at the source. The
// "Attach to proposal" checkbox sets include_in_proposal=true on the
// new attachment.
//
// Usage:
//   window.agxMarkup.open({
//     attachment: { id, original_url, web_url, filename, entity_type, entity_id },
//     onDone: function() { /* refresh list */ }
//   });
(function() {
  'use strict';

  // ── Drawing state ────────────────────────────────────────────────
  var TOOLS = [
    { key: 'arrow',    label: '↗ Arrow' },
    { key: 'rect',     label: '▭ Rect' },
    { key: 'draw',     label: '✏ Draw' },
    { key: 'text',     label: 'T Text' }
  ];
  var DEFAULT_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#000000', '#ffffff'];

  var state = null; // active markup session

  function open(opts) {
    opts = opts || {};
    if (!opts.attachment) { alert('No attachment supplied.'); return; }
    if (state) closeOverlay();

    state = {
      attachment: opts.attachment,
      onDone: opts.onDone || function() {},
      tool: 'arrow',
      color: '#ef4444',
      lineWidth: 4,
      strokes: [],            // [{ tool, color, lineWidth, points|rect|text|arrow }]
      currentStroke: null,
      img: null,
      naturalSize: { w: 0, h: 0 }
    };

    buildOverlay();
  }

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'agx-markup-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:5000;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:18px;';

    overlay.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;background:rgba(15,15,30,0.95);border:1px solid #333;border-radius:10px;padding:10px 14px;max-width:1100px;width:100%;">' +
        '<strong style="color:#fff;font-size:13px;margin-right:8px;">' + escapeHTML(state.attachment.filename || 'Photo') + '</strong>' +
        '<div id="agx-mk-tools" style="display:flex;gap:4px;">' +
          TOOLS.map(function(t) {
            return '<button data-mk-tool="' + t.key + '" style="background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">' + t.label + '</button>';
          }).join('') +
        '</div>' +
        '<div style="display:flex;gap:3px;align-items:center;margin-left:6px;">' +
          DEFAULT_COLORS.map(function(c) {
            return '<button data-mk-color="' + c + '" title="' + c + '" style="width:22px;height:22px;border:2px solid rgba(255,255,255,0.2);border-radius:50%;background:' + c + ';cursor:pointer;padding:0;"></button>';
          }).join('') +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;margin-left:6px;">' +
          '<label style="font-size:11px;color:#aaa;">Width</label>' +
          '<input id="agx-mk-width" type="range" min="1" max="20" value="4" style="width:90px;" />' +
        '</div>' +
        '<button id="agx-mk-undo" style="margin-left:6px;background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">↶ Undo</button>' +
        '<button id="agx-mk-clear" style="background:rgba(248,113,113,0.10);color:#f87171;border:1px solid rgba(248,113,113,0.35);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">Clear</button>' +
        '<div style="flex:1;"></div>' +
        '<button id="agx-mk-cancel" style="background:rgba(255,255,255,0.06);color:#aaa;border:1px solid #444;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;">Cancel</button>' +
        '<button id="agx-mk-save" style="background:#4f8cff;color:#fff;border:0;border-radius:6px;padding:6px 16px;font-size:12px;font-weight:700;cursor:pointer;">Save…</button>' +
      '</div>' +
      '<div style="position:relative;max-width:1100px;max-height:78vh;background:#000;border:1px solid #333;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center;flex:1;">' +
        '<canvas id="agx-mk-canvas" style="display:block;max-width:100%;max-height:78vh;cursor:crosshair;"></canvas>' +
      '</div>';

    document.body.appendChild(overlay);

    var canvas = overlay.querySelector('#agx-mk-canvas');
    var img = new Image();
    // Load through the same-origin proxy endpoint so the canvas isn't
    // tainted on draw — direct R2 URLs (different subdomain) would
    // require CORS headers we don't currently set, and toBlob() would
    // throw a SecurityError. The proxy carries cookie auth.
    var proxyUrl = '/api/attachments/' + encodeURIComponent(state.attachment.id) + '/raw?variant=web';
    img.onload = function() {
      state.img = img;
      state.naturalSize = { w: img.naturalWidth, h: img.naturalHeight };
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      redraw();
    };
    img.onerror = function() {
      alert('Failed to load image for markup.');
      closeOverlay();
    };
    img.src = proxyUrl;

    // Toolbar interactions.
    overlay.querySelectorAll('[data-mk-tool]').forEach(function(btn) {
      btn.onclick = function() {
        state.tool = btn.dataset.mkTool;
        refreshToolbar(overlay);
      };
    });
    overlay.querySelectorAll('[data-mk-color]').forEach(function(btn) {
      btn.onclick = function() {
        state.color = btn.dataset.mkColor;
        refreshToolbar(overlay);
      };
    });
    overlay.querySelector('#agx-mk-width').oninput = function(e) {
      state.lineWidth = parseInt(e.target.value, 10) || 4;
    };
    overlay.querySelector('#agx-mk-undo').onclick = function() {
      state.strokes.pop();
      redraw();
    };
    overlay.querySelector('#agx-mk-clear').onclick = function() {
      if (!state.strokes.length || confirm('Clear all markup?')) {
        state.strokes = [];
        redraw();
      }
    };
    overlay.querySelector('#agx-mk-cancel').onclick = function() {
      if (!state.strokes.length || confirm('Discard your markup?')) closeOverlay();
    };
    overlay.querySelector('#agx-mk-save').onclick = function() { openSaveDialog(); };
    refreshToolbar(overlay);

    wireCanvasInput(canvas);

    // Esc closes (with confirm if strokes exist).
    overlay.tabIndex = -1;
    overlay.focus();
    overlay.onkeydown = function(e) {
      if (e.key === 'Escape') overlay.querySelector('#agx-mk-cancel').click();
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        state.strokes.pop();
        redraw();
      }
    };
  }

  function refreshToolbar(overlay) {
    overlay.querySelectorAll('[data-mk-tool]').forEach(function(btn) {
      var active = btn.dataset.mkTool === state.tool;
      btn.style.background = active ? '#4f8cff' : 'rgba(255,255,255,0.06)';
      btn.style.color = active ? '#fff' : '#ddd';
      btn.style.borderColor = active ? '#4f8cff' : '#444';
    });
    overlay.querySelectorAll('[data-mk-color]').forEach(function(btn) {
      var active = btn.dataset.mkColor === state.color;
      btn.style.borderColor = active ? '#fff' : 'rgba(255,255,255,0.2)';
      btn.style.boxShadow = active ? '0 0 0 2px rgba(255,255,255,0.4)' : 'none';
    });
  }

  // ── Canvas drawing ──────────────────────────────────────────────
  function wireCanvasInput(canvas) {
    function localPoint(e) {
      var rect = canvas.getBoundingClientRect();
      // Account for the displayed size (canvas may be CSS-scaled smaller
      // than its native pixel resolution).
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var clientY = e.touches ? e.touches[0].clientY : e.clientY;
      var x = (clientX - rect.left) * (canvas.width / rect.width);
      var y = (clientY - rect.top) * (canvas.height / rect.height);
      return { x: x, y: y };
    }

    canvas.onmousedown = function(e) {
      e.preventDefault();
      var p = localPoint(e);
      if (state.tool === 'text') {
        var msg = prompt('Text to add:');
        if (msg) {
          state.strokes.push({ tool: 'text', color: state.color, lineWidth: state.lineWidth, x: p.x, y: p.y, text: msg, fontPx: Math.max(14, state.lineWidth * 6) });
          redraw();
        }
        return;
      }
      state.currentStroke = {
        tool: state.tool,
        color: state.color,
        lineWidth: state.lineWidth,
        startX: p.x, startY: p.y,
        endX: p.x, endY: p.y,
        points: state.tool === 'draw' ? [p] : null
      };
    };

    canvas.onmousemove = function(e) {
      if (!state.currentStroke) return;
      var p = localPoint(e);
      if (state.currentStroke.tool === 'draw') {
        state.currentStroke.points.push(p);
      } else {
        state.currentStroke.endX = p.x;
        state.currentStroke.endY = p.y;
      }
      redraw(state.currentStroke);
    };

    var endStroke = function() {
      if (!state.currentStroke) return;
      state.strokes.push(state.currentStroke);
      state.currentStroke = null;
      redraw();
    };
    canvas.onmouseup = endStroke;
    canvas.onmouseleave = endStroke;
  }

  function redraw(extra) {
    var canvas = document.getElementById('agx-mk-canvas');
    if (!canvas || !state.img) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(state.img, 0, 0, canvas.width, canvas.height);
    state.strokes.forEach(function(s) { drawStroke(ctx, s); });
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
    } else if (s.tool === 'arrow') {
      drawArrow(ctx, s.startX, s.startY, s.endX, s.endY, s.lineWidth);
    } else if (s.tool === 'text') {
      ctx.font = 'bold ' + (s.fontPx || 24) + 'px Arial,sans-serif';
      ctx.textBaseline = 'top';
      // Drop a contrasting outline so text reads on busy photos.
      ctx.lineWidth = Math.max(2, s.fontPx / 12);
      ctx.strokeStyle = '#000';
      ctx.strokeText(s.text, s.x, s.y);
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, s.x, s.y);
    }
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
    // Strip last extension and append _markup.png
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
        // Replace = upload first (so we don't lose data on a failure),
        // then delete the original. New attachment has its own id; the
        // markup_of link is intentionally NOT set — this is treated as
        // a true replacement, not a child markup.
        return uploadP.then(function(r) {
          return window.agxApi.attachments.remove(att.id).catch(function() { /* swallow */ }).then(function() { return r; });
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
