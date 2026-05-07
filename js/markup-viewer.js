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
    { key: 'select',   glyph: '\u{1F446}', label: 'Select / move' },
    { key: 'arrow',    glyph: '↗',     label: 'Arrow' },
    { key: 'line',     glyph: '─',     label: 'Line' },
    { key: 'measure',  glyph: '\u{1F4CF}', label: 'Measurement (pick two points, enter distance — e.g. 84", 1.5\', 10 feet, 5\'6")' },
    { key: 'polyline', glyph: '⌇',     label: 'Polyline (click to add points; double-click / Esc to finish; snaps to existing endpoints)' },
    { key: 'rect',     glyph: '▭',     label: 'Rectangle' },
    { key: 'ellipse',  glyph: '◯',     label: 'Ellipse' },
    { key: 'draw',     glyph: '✎',     label: 'Free draw' },
    { key: 'text',     glyph: 'T',          label: 'Text' },
    { key: 'sticker',  glyph: '\u{1F3F7}',  label: 'Sticker / stamp' }
  ];

  // AGX-styled measurement prompt modal. Replaces the browser's
  // window.prompt() with a dialog that matches the rest of the app
  // (dark surface, AGX-blue confirm). Calls back with a parsed
  // { inches, label } on success, or null on cancel/empty/parse
  // failure. Honors the unit toggle from the picker side panel:
  // a bare "5" entered while the toggle is "ft" parses as 5 feet,
  // not 5 inches. Quoted units always win regardless of toggle.
  function promptMeasurement(defaultUnit, callback) {
    var unitLabel = (defaultUnit === 'ft') ? 'feet' : 'inches';
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10500;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px);';

    var box = document.createElement('div');
    box.style.cssText = 'background:#0f0f1e;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:400px;width:100%;box-shadow:0 16px 48px rgba(0,0,0,0.6);color:#e6e6e6;';
    box.innerHTML =
      '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:6px;">Measurement</div>' +
      '<div style="font-size:12px;color:#9aa;margin-bottom:14px;">Distance between the two points. ' +
        'A bare number is read as <strong>' + unitLabel + '</strong> (toggle in the side panel). ' +
        'Quoted units like <code>84"</code>, <code>1.5\'</code>, or <code>5\'6"</code> always win.</div>' +
      '<input id="agx-mk-prompt-input" type="text" autocomplete="off" placeholder="e.g. 84&quot;, 1.5&apos;, 5&apos;6&quot;, or just a number" ' +
        'style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:6px;padding:10px 12px;font-size:14px;font-weight:600;outline:none;" />' +
      '<div id="agx-mk-prompt-error" style="font-size:11px;color:#f87171;min-height:14px;margin-top:6px;"></div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
        '<button data-mk-prompt-cancel style="padding:8px 16px;background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>' +
        '<button data-mk-prompt-ok style="padding:8px 16px;background:#4f8cff;color:#fff;border:1px solid #4f8cff;border-radius:6px;cursor:pointer;font-weight:600;">Set Measurement</button>' +
      '</div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    var input  = box.querySelector('#agx-mk-prompt-input');
    var errEl  = box.querySelector('#agx-mk-prompt-error');
    var okBtn  = box.querySelector('[data-mk-prompt-ok]');
    var cancelBtn = box.querySelector('[data-mk-prompt-cancel]');

    function cleanup(result) {
      document.removeEventListener('keydown', onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      callback(result);
    }
    function tryCommit() {
      var raw = (input.value || '').trim();
      if (!raw) { errEl.textContent = 'Enter a measurement (or click Cancel).'; return; }
      var parsed = parseMeasurement(raw, defaultUnit);
      if (!parsed) { errEl.textContent = 'Could not parse "' + raw + '" — try 84", 1.5\', 10 feet, or 5\'6".'; return; }
      cleanup(parsed);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); tryCommit(); }
    }

    okBtn.onclick = tryCommit;
    cancelBtn.onclick = function() { cleanup(null); };
    overlay.addEventListener('click', function(e) { if (e.target === overlay) cleanup(null); });
    document.addEventListener('keydown', onKey, true);

    setTimeout(function() { input.focus(); }, 0);
  }

  // Parse a free-form measurement string into { inches, label }.
  // Accepted shapes (case-insensitive, whitespace-tolerant):
  //   84  | 84"  | 84 in  | 84 inches             → inches
  //   1.5' | 1.5 ft | 1.5 feet | 10 feet         → feet  (decimal OK)
  //   5'6" | 5' 6" | 5 ft 6 in                   → mixed
  //   bare number (no unit): defaults to inches
  // Returns null if unparseable. label is the human-readable form
  // we draw on the dimension line (e.g. "5'-6\"").
  function parseMeasurement(raw, defaultUnit) {
    if (raw == null) return null;
    var s = String(raw).trim().toLowerCase();
    if (!s) return null;
    // Mixed feet + inches: 5'6", 5' 6", 5 ft 6 in
    var mMix = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|f)\s*(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?$/);
    if (mMix) {
      var ft1 = parseFloat(mMix[1]), in1 = parseFloat(mMix[2]);
      if (!isFinite(ft1) || !isFinite(in1)) return null;
      var totalIn = ft1 * 12 + in1;
      return { inches: totalIn, label: formatFeetInches(totalIn) };
    }
    // Feet only (with unit)
    var mFt = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|f)$/);
    if (mFt) {
      var ft = parseFloat(mFt[1]);
      if (!isFinite(ft)) return null;
      return { inches: ft * 12, label: formatFeetInches(ft * 12) };
    }
    // Inches with unit
    var mIn = s.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)$/);
    if (mIn) {
      var inOnly = parseFloat(mIn[1]);
      if (!isFinite(inOnly)) return null;
      return { inches: inOnly, label: formatFeetInches(inOnly) };
    }
    // Bare number — interpret using the supplied default unit. The
    // caller passes the picker's current ft/in toggle so the same
    // typed "5" can mean either 5 inches OR 5 feet depending on
    // intent. Falls back to inches when no default is given (legacy).
    var mNum = s.match(/^(\d+(?:\.\d+)?)$/);
    if (mNum) {
      var n = parseFloat(mNum[1]);
      if (!isFinite(n)) return null;
      var inches = (defaultUnit === 'ft') ? n * 12 : n;
      return { inches: inches, label: formatFeetInches(inches) };
    }
    return null;
  }

  // Format a measurement in inches as architectural feet-inches:
  //   < 12 inches      →  84"          (skip the 0' prefix)
  //   exact feet       →  5'           (skip the trailing 0")
  //   mixed            →  5'-6"        (Bluebeam/AutoCAD convention)
  // Decimal inches preserved up to 2 places, trailing zeros trimmed.
  function formatFeetInches(totalInches) {
    if (!isFinite(totalInches)) return String(totalInches);
    var sign = totalInches < 0 ? '-' : '';
    var v = Math.abs(totalInches);
    var ft = Math.floor(v / 12);
    var rem = v - ft * 12;
    var inStr = (Math.abs(rem - Math.round(rem)) < 0.005)
      ? String(Math.round(rem))
      : (Math.round(rem * 100) / 100).toString();
    if (ft === 0) return sign + inStr + '"';
    if (rem < 0.005) return sign + ft + "'";
    return sign + ft + "'-" + inStr + '"';
  }

  // Thickness presets — click the Thickness button to swap among them.
  // Sized so the visual difference is obvious at typical photo
  // resolutions (the canvas is at native image size, often 1600+px wide).
  var THICKNESS_PRESETS = [
    { key: 'thin',  value: 3,  label: 'Thin' },
    { key: 'med',   value: 8,  label: 'Medium' },
    { key: 'thick', value: 16, label: 'Thick' }
  ];

  // Endpoint snap radius — in canvas pixels. When drawing a line /
  // polyline / arrow, if a candidate end point is within this many
  // pixels of an existing stroke's endpoint, snap to it.
  var SNAP_RADIUS = 14;
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
      // Where the saved markup uploads to. Defaults to the source
      // attachment's own entity. Pass an override when marking up a
      // foreign attachment (e.g. a lead photo surfaced on an estimate)
      // so the new markup lands on the current entity instead.
      saveTarget: opts.saveTarget || {
        entityType: opts.attachment.entity_type,
        entityId: opts.attachment.entity_id
      },
      onDone: opts.onDone || function() {},
      tool: 'arrow',
      stickerKind: null,
      // Measurement options (set in the picker side panel, applied
      // after the user draws the line). Cleared on tool switch.
      //   measureUnit: how to interpret a bare number in the post-
      //                draw modal — 'in' (84 → 84") or 'ft' (5 → 5')
      //   measureLineColor: null → use the global state.color picker
      //                     string → measurement-only color override
      //                     (so e.g. arrows stay red while
      //                     dimensions are drawn in blue)
      //   measureLineWidth: null | number — same idea, override the
      //                     global thickness only for measurements
      //   measureNumberColor: null → match the line color
      //                       string → label-only color override
      //                       (e.g. white text on red lines)
      measureUnit: 'in',
      measureLineColor: null,
      measureLineWidth: null,
      measureNumberColor: null,
      color: '#ef4444',
      lineWidth: 8,
      strokes: [],
      currentStroke: null,
      activePolyline: null,    // mid-build polyline (committed on dblclick / Esc / tool switch)
      hoverPoint: null,        // last known canvas-local cursor (for polyline preview + snap)
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
    // The sticker popup positions itself relative to the overlay
    // bounding box. position:fixed creates its own containing block so
    // child position:absolute is relative to the overlay; no override
    // needed beyond ensuring we measure off the overlay rect.
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
          // Thickness button — opens a popup with preset thickness circles.
          '<button id="agx-mk-thickness" title="Thickness" style="width:48px;height:44px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;">' +
            '<span id="agx-mk-thickness-dot" style="display:block;width:14px;height:14px;border-radius:50%;background:#ddd;"></span>' +
          '</button>' +
          // Divider
          '<div style="width:36px;height:1px;background:#3a3a4a;margin:6px 0;"></div>' +
          // Undo / Clear
          '<button id="agx-mk-undo" title="Undo (Ctrl+Z)" style="width:48px;height:32px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:14px;cursor:pointer;">↶</button>' +
          '<button id="agx-mk-clear" title="Clear all" style="width:48px;height:32px;background:rgba(248,113,113,0.10);color:#f87171;border:1px solid rgba(248,113,113,0.35);border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;">CLR</button>' +
        '</div>' +
        // Floating sticker picker — absolutely positioned to the right of the
        // sidebar so it overlays the canvas instead of pushing the sidebar
        // height taller (which used to squeeze the canvas off-screen on
        // narrow viewports / phones). Visible only when the Sticker tool
        // is active.
        '<div id="agx-mk-sticker-picker" style="display:none;position:absolute;left:88px;top:78px;background:rgba(15,15,30,0.97);border:1px solid #3a3a4a;border-radius:8px;padding:8px;box-shadow:0 6px 20px rgba(0,0,0,0.5);z-index:5050;max-height:70vh;overflow-y:auto;width:140px;"></div>' +
        // Measurement picker — same anchor model as the sticker
        // picker. Visible only when the measure tool is active.
        '<div id="agx-mk-measure-picker" style="display:none;position:absolute;left:88px;top:78px;background:rgba(15,15,30,0.97);border:1px solid #3a3a4a;border-radius:8px;padding:8px;box-shadow:0 6px 20px rgba(0,0,0,0.5);z-index:5050;max-height:70vh;overflow-y:auto;width:160px;"></div>' +
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
        // Finish any in-progress polyline before switching tools.
        commitPolylineIfActive();
        state.tool = btn.dataset.mkTool;
        if (state.tool !== 'sticker') state.stickerKind = null;
        if (state.tool !== 'select') state.selectedIdx = null;
        // Reset measurement-only overrides when leaving the tool so
        // the next measure session starts from the global defaults.
        if (state.tool !== 'measure') {
          state.measureLineColor = null;
          state.measureLineWidth = null;
          state.measureNumberColor = null;
        }
        refreshToolbar(overlay);
        renderStickerPicker(overlay);
        renderMeasurePicker(overlay);
        updateThicknessIndicator(overlay);
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
    overlay.querySelector('#agx-mk-thickness').onclick = function(e) {
      e.stopPropagation();
      openThicknessPopup(overlay);
    };
    overlay.querySelector('#agx-mk-undo').onclick = function() {
      state.strokes.pop();
      state.selectedIdx = null;
      redraw();
    };
    overlay.querySelector('#agx-mk-clear').onclick = function() {
      var hasContent = state.strokes.length || state.activePolyline;
      if (!hasContent || confirm('Clear all markup?')) {
        state.strokes = [];
        state.selectedIdx = null;
        state.activePolyline = null;
        redraw();
      }
    };
    overlay.querySelector('#agx-mk-cancel').onclick = function() {
      if (!state.strokes.length || confirm('Discard your markup?')) closeOverlay();
    };
    overlay.querySelector('#agx-mk-save').onclick = function() {
      // Commit any in-progress polyline before opening the save dialog.
      commitPolylineIfActive();
      redraw();
      openSaveDialog();
    };

    refreshToolbar(overlay);
    renderStickerPicker(overlay);
    renderMeasurePicker(overlay);
    updateHint(overlay);
    wireCanvasInput(canvas);

    // Esc / Ctrl+Z / Delete
    overlay.tabIndex = -1;
    overlay.focus();
    overlay.onkeydown = function(e) {
      if (e.key === 'Escape') {
        // If a polyline is mid-build, Esc commits it first instead of
        // closing the editor — same convention as Bluebeam / Illustrator.
        if (state.activePolyline) {
          commitPolylineIfActive();
          redraw();
          return;
        }
        overlay.querySelector('#agx-mk-cancel').click();
        return;
      }
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        // Undo while polyline is active: pop the last placed point;
        // commit cancellation if it was the only one.
        if (state.activePolyline && state.activePolyline.points && state.activePolyline.points.length) {
          state.activePolyline.points.pop();
          if (!state.activePolyline.points.length) state.activePolyline = null;
          redraw();
          return;
        }
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
      // Active state uses a yellow accent border instead of a solid
      // fill, so the icon stays readable and the choice still feels
      // distinct without overpowering the canvas underneath.
      btn.style.background = active ? 'rgba(251,191,36,0.10)' : 'rgba(255,255,255,0.05)';
      btn.style.color = active ? '#fbbf24' : '#ddd';
      btn.style.borderColor = active ? '#fbbf24' : '#444';
      btn.style.boxShadow = active ? 'inset 0 0 0 1px #fbbf24' : 'none';
    });
    overlay.querySelectorAll('[data-mk-color]').forEach(function(btn) {
      var active = btn.dataset.mkColor === state.color;
      btn.style.borderColor = active ? '#fff' : 'rgba(255,255,255,0.2)';
      btn.style.boxShadow = active ? '0 0 0 2px rgba(255,255,255,0.4)' : 'none';
    });
    updateThicknessIndicator(overlay);
  }

  // Refresh the thickness button's inner dot so it visually reflects
  // the currently-selected line width.
  function updateThicknessIndicator(overlay) {
    var dot = overlay.querySelector('#agx-mk-thickness-dot');
    if (!dot) return;
    var w = state.lineWidth || 4;
    // Clamp display size 6..22px so the button stays compact.
    var display = Math.max(6, Math.min(22, Math.round(w * 1.1)));
    dot.style.width = display + 'px';
    dot.style.height = display + 'px';
    dot.style.background = state.color || '#ddd';
  }

  // Thickness popup — three preset circles + a close X. Click a preset
  // to apply, click outside or X to close.
  function openThicknessPopup(overlay) {
    var existing = document.getElementById('agx-mk-thickness-popup');
    if (existing) { existing.remove(); return; }
    var anchor = overlay.querySelector('#agx-mk-thickness');
    var anchorRect = anchor ? anchor.getBoundingClientRect() : null;
    var ovRect = overlay.getBoundingClientRect();
    var popup = document.createElement('div');
    popup.id = 'agx-mk-thickness-popup';
    popup.style.cssText = 'position:absolute;background:#fff;color:#1f2937;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.4);padding:14px 18px;z-index:5060;min-width:240px;';
    if (anchorRect) {
      popup.style.top = (anchorRect.top - ovRect.top) + 'px';
      popup.style.left = (anchorRect.right - ovRect.left + 8) + 'px';
    }
    popup.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
        '<strong style="font-size:14px;">Thickness</strong>' +
        '<button id="agx-mk-thickness-close" style="background:rgba(0,0,0,0.06);color:#1f2937;border:0;width:30px;height:30px;border-radius:50%;font-size:16px;cursor:pointer;">&times;</button>' +
      '</div>' +
      '<hr style="border:0;border-top:1px solid #e5e7eb;margin:6px 0 14px;" />' +
      '<div style="display:flex;align-items:center;justify-content:space-around;gap:18px;">' +
        THICKNESS_PRESETS.map(function(p) {
          var size = Math.max(8, Math.min(34, p.value * 1.6));
          var active = state.lineWidth === p.value;
          return '<button data-mk-thick="' + p.value + '" title="' + escapeHTML(p.label) + '" ' +
            'style="background:' + (active ? '#1e293b' : 'transparent') + ';border:0;cursor:pointer;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;padding:0;">' +
            '<span style="display:block;width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + (active ? '#fff' : '#1e293b') + ';"></span>' +
          '</button>';
        }).join('') +
      '</div>';
    overlay.appendChild(popup);
    popup.querySelector('#agx-mk-thickness-close').onclick = function(e) { e.stopPropagation(); popup.remove(); };
    popup.querySelectorAll('[data-mk-thick]').forEach(function(btn) {
      btn.onclick = function(e) {
        e.stopPropagation();
        state.lineWidth = parseInt(btn.dataset.mkThick, 10) || 4;
        if (state.selectedIdx != null) {
          var s = state.strokes[state.selectedIdx];
          if (s) { s.lineWidth = state.lineWidth; redraw(); }
        }
        updateThicknessIndicator(overlay);
        popup.remove();
      };
    });
    // Click-outside-to-close (next click on overlay).
    setTimeout(function() {
      function onAway(e) {
        if (popup.contains(e.target)) return;
        popup.remove();
        document.removeEventListener('mousedown', onAway, true);
      }
      document.addEventListener('mousedown', onAway, true);
    }, 0);
  }

  // If a polyline is mid-build, push it onto strokes so it renders
  // and becomes selectable. Used when the tool changes / save fires.
  function commitPolylineIfActive() {
    if (state && state.activePolyline && state.activePolyline.points && state.activePolyline.points.length >= 2) {
      state.strokes.push(state.activePolyline);
    }
    if (state) state.activePolyline = null;
  }

  function renderMeasurePicker(overlay) {
    var picker = overlay.querySelector('#agx-mk-measure-picker');
    if (!picker) return;
    if (state.tool !== 'measure') { picker.style.display = 'none'; return; }
    // Anchor to the measure tool button (same pattern as the
    // sticker picker), so the panel sits in line with whichever row
    // the button occupies — no fixed top: that breaks if we ever
    // reorder the toolbar.
    var measureBtn = overlay.querySelector('[data-mk-tool="measure"]');
    var sidebar = overlay.querySelector('#agx-mk-sidebar');
    if (measureBtn && sidebar) {
      var btnRect = measureBtn.getBoundingClientRect();
      var sidebarRect = sidebar.getBoundingClientRect();
      var ovRect = overlay.getBoundingClientRect();
      picker.style.top = (btnRect.top - ovRect.top) + 'px';
      picker.style.left = (sidebarRect.right - ovRect.left + 8) + 'px';
    }
    picker.style.display = '';

    // Currently-armed values (with global fallbacks) — used to
    // highlight the active chip in each row. The picker doesn't
    // store the value to attach to the line; that's prompted in
    // an AGX modal AFTER the user draws (see promptMeasurement).
    var unit = state.measureUnit || 'in';
    var lineColor = state.measureLineColor || state.color;
    var lineWidth = state.measureLineWidth || state.lineWidth;
    var numberColor = state.measureNumberColor; // null = match line

    function chip(label, isActive, attrs) {
      return '<button ' + attrs +
        ' style="height:28px;flex:1;background:' + (isActive ? '#4f8cff' : 'rgba(255,255,255,0.05)') +
        ';color:' + (isActive ? '#fff' : '#ddd') +
        ';border:1px solid ' + (isActive ? '#4f8cff' : '#444') +
        ';border-radius:5px;font-size:11px;cursor:pointer;font-weight:600;padding:0;">' +
        label + '</button>';
    }

    function colorSwatch(color, isActive, attrs) {
      return '<button ' + attrs +
        ' title="' + escapeHTML(color) + '"' +
        ' style="width:24px;height:24px;flex:0 0 auto;background:' + color +
        ';border:2px solid ' + (isActive ? '#fff' : '#444') +
        ';border-radius:50%;cursor:pointer;padding:0;box-shadow:' +
        (isActive ? '0 0 0 1px #4f8cff' : 'none') + ';"></button>';
    }

    picker.innerHTML =
      '<div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.5px;text-align:center;margin-bottom:8px;">Measurement</div>' +

      // Unit toggle — controls how a bare number entered after the
      // line is drawn ("5") is interpreted in the modal: inches or
      // feet. Quoted units ("5'", "5\"") always win regardless.
      '<div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Unit (for bare numbers)</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:10px;">' +
        chip('in', unit === 'in', 'data-mk-unit="in"') +
        chip('ft', unit === 'ft', 'data-mk-unit="ft"') +
      '</div>' +

      // Line weight — three thickness presets specific to the
      // measure tool. Doesn't touch the global state.lineWidth so
      // the user's other tools keep their own thickness setting.
      '<div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Line weight</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:10px;">' +
        THICKNESS_PRESETS.map(function(t) {
          var isActive = lineWidth === t.value;
          var glyph = '<span style="display:inline-block;width:16px;height:' +
            Math.max(2, Math.round(t.value / 4)) + 'px;background:#ddd;border-radius:1px;vertical-align:middle;"></span>';
          return chip(glyph, isActive, 'data-mk-mlw="' + t.value + '"');
        }).join('') +
      '</div>' +

      // Line color — measurement-specific override. Defaults to the
      // global color so users who don't change it just inherit.
      '<div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Line color</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;align-items:center;">' +
        DEFAULT_COLORS.map(function(c) {
          return colorSwatch(c, lineColor === c, 'data-mk-mlc="' + c + '"');
        }).join('') +
      '</div>' +

      // Number color — separate so the user can have e.g. red lines
      // with white numbers on a busy photo background. Default chip
      // is "Match" (uses the line color); other chips override.
      '<div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Number color</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;align-items:center;">' +
        chip('Match', numberColor == null, 'data-mk-mnc="match" style-extra') +
        DEFAULT_COLORS.map(function(c) {
          return colorSwatch(c, numberColor === c, 'data-mk-mnc="' + c + '"');
        }).join('') +
      '</div>' +

      '<div style="margin-top:6px;font-size:10px;color:#888;text-align:center;font-style:italic;">Draw a line — you\'ll be prompted for the distance.</div>';

    // Unit toggle.
    picker.querySelectorAll('[data-mk-unit]').forEach(function(btn) {
      btn.onclick = function() {
        state.measureUnit = btn.dataset.mkUnit;
        renderMeasurePicker(overlay);
      };
    });
    // Measurement-specific line weight.
    picker.querySelectorAll('[data-mk-mlw]').forEach(function(btn) {
      btn.onclick = function() {
        state.measureLineWidth = parseInt(btn.dataset.mkMlw, 10);
        renderMeasurePicker(overlay);
      };
    });
    // Measurement-specific line color.
    picker.querySelectorAll('[data-mk-mlc]').forEach(function(btn) {
      btn.onclick = function() {
        state.measureLineColor = btn.dataset.mkMlc;
        renderMeasurePicker(overlay);
      };
    });
    // Number color override (or "match" the line).
    picker.querySelectorAll('[data-mk-mnc]').forEach(function(btn) {
      btn.onclick = function() {
        var v = btn.dataset.mkMnc;
        state.measureNumberColor = (v === 'match') ? null : v;
        renderMeasurePicker(overlay);
      };
    });
  }

  function renderStickerPicker(overlay) {
    var picker = overlay.querySelector('#agx-mk-sticker-picker');
    if (!picker) return;
    if (state.tool !== 'sticker') { picker.style.display = 'none'; return; }
    // Anchor vertically to the Sticker button (so the popup sits at
    // the same row), and horizontally to the sidebar's right edge so
    // the popup never overlaps the sidebar regardless of width.
    var stickerBtn = overlay.querySelector('[data-mk-tool="sticker"]');
    var sidebar = overlay.querySelector('#agx-mk-sidebar');
    if (stickerBtn && sidebar) {
      var btnRect = stickerBtn.getBoundingClientRect();
      var sidebarRect = sidebar.getBoundingClientRect();
      var ovRect = overlay.getBoundingClientRect();
      picker.style.top = (btnRect.top - ovRect.top) + 'px';
      picker.style.left = (sidebarRect.right - ovRect.left + 8) + 'px';
    }
    picker.style.display = '';
    picker.innerHTML =
      '<div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.5px;text-align:center;margin-bottom:6px;">Stickers</div>' +
      '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px;">' +
      STICKERS.map(function(st) {
        var active = state.stickerKind === st.kind;
        return '<button data-mk-sticker="' + st.kind + '" title="' + escapeHTML(st.label) + '" ' +
          'style="height:34px;background:' + (active ? '#4f8cff' : 'rgba(255,255,255,0.05)') +
          ';color:' + (active ? '#fff' : '#ddd') + ';border:1px solid ' + (active ? '#4f8cff' : '#444') +
          ';border-radius:5px;font-size:12px;cursor:pointer;font-weight:600;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;justify-content:center;">' +
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
    } else if (state.tool === 'polyline') {
      hint.textContent = 'Click to add points · double-click or Esc to finish · snaps to existing endpoints';
    } else if (state.tool === 'measure') {
      hint.textContent = 'Click and drag two points · enter the distance when prompted';
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

      // Polyline tool: each click adds a point. Snap to existing
      // endpoints when within SNAP_RADIUS. Double-click or Esc commits.
      if (state.tool === 'polyline') {
        var snapped = snapToEndpoint(p);
        if (!state.activePolyline) {
          state.activePolyline = {
            tool: 'polyline', color: state.color, lineWidth: state.lineWidth,
            points: [snapped]
          };
        } else {
          state.activePolyline.points.push(snapped);
        }
        redraw();
        return;
      }

      // Drawing tools: start a new stroke. Single-segment shapes
      // (line / arrow / measure) get endpoint snap on the start point too.
      var startP = (state.tool === 'line' || state.tool === 'arrow' || state.tool === 'measure') ? snapToEndpoint(p) : p;
      state.currentStroke = {
        tool: state.tool, color: state.color, lineWidth: state.lineWidth,
        startX: startP.x, startY: startP.y, endX: startP.x, endY: startP.y,
        points: state.tool === 'draw' ? [startP] : null
      };
    };

    // Polyline finalization on double-click anywhere on the canvas.
    canvas.ondblclick = function(e) {
      if (state.tool !== 'polyline') return;
      e.preventDefault();
      commitPolylineIfActive();
      redraw();
    };

    canvas.onmousemove = function(e) {
      var p = localPoint(e);
      state.hoverPoint = p;
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
      // Polyline mid-build: redraw to show the rubber-band segment
      // from the last placed point to the cursor.
      if (state.tool === 'polyline' && state.activePolyline) {
        redraw();
        return;
      }
      // Drawing in progress.
      if (!state.currentStroke) return;
      var endP = (state.currentStroke.tool === 'line' || state.currentStroke.tool === 'arrow' || state.currentStroke.tool === 'measure')
        ? snapToEndpoint(p, state.currentStroke)
        : p;
      if (state.currentStroke.tool === 'draw') {
        state.currentStroke.points.push(p);
      } else {
        state.currentStroke.endX = endP.x;
        state.currentStroke.endY = endP.y;
      }
      redraw(state.currentStroke);
    };

    var endStroke = function() {
      if (state.tool === 'select') { state.dragLast = null; return; }
      if (!state.currentStroke) return;
      // Drop zero-size shapes (just a click, no drag) for arrow/line/rect/ellipse/measure.
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
      // Measurement tool: ask for the distance via an AGX-styled
      // modal (not the native window.prompt — feels foreign and
      // can't honor the unit toggle visually). Apply the picker's
      // line-weight / line-color / number-color overrides BEFORE
      // committing the stroke so the new measurement renders with
      // the user's chosen styling. Cancelling drops the stroke.
      if (s.tool === 'measure') {
        // Apply overrides first so the live preview while the modal
        // is open already reflects the chosen styling.
        if (state.measureLineColor)  s.color       = state.measureLineColor;
        if (state.measureLineWidth)  s.lineWidth   = state.measureLineWidth;
        s.numberColor = state.measureNumberColor;  // null = match line

        promptMeasurement(state.measureUnit || 'in', function(parsed) {
          if (!parsed) {
            // Cancel / empty / unparseable — drop the stroke.
            state.currentStroke = null;
            redraw();
            return;
          }
          s.measureInches = parsed.inches;
          s.measureLabel  = parsed.label;
          state.strokes.push(s);
          state.currentStroke = null;
          redraw();
        });
        // Don't commit the stroke synchronously — the modal callback
        // owns that. Return early so the catch-all push below
        // doesn't add an unmeasured copy.
        return;
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
    if ((s.tool === 'draw' || s.tool === 'polyline') && s.points && s.points.length) {
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

  // Collect every endpoint candidate from existing strokes — line /
  // arrow / polyline endpoints. Used by snapToEndpoint to pull a
  // candidate point onto the nearest existing endpoint within radius.
  function collectEndpoints(excludeStroke) {
    var pts = [];
    state.strokes.forEach(function(s) {
      if (s === excludeStroke) return;
      if (s.tool === 'line' || s.tool === 'arrow' || s.tool === 'measure') {
        pts.push({ x: s.startX, y: s.startY });
        pts.push({ x: s.endX, y: s.endY });
      } else if (s.tool === 'polyline' && s.points && s.points.length) {
        pts.push(s.points[0]);
        pts.push(s.points[s.points.length - 1]);
      }
    });
    // Mid-build polyline: snap to its own placed points so the user
    // can close a path back onto its start.
    if (state.activePolyline && state.activePolyline !== excludeStroke && state.activePolyline.points) {
      state.activePolyline.points.forEach(function(pp) { pts.push(pp); });
    }
    return pts;
  }

  function snapToEndpoint(p, excludeStroke) {
    var candidates = collectEndpoints(excludeStroke);
    var best = null;
    var bestDist = SNAP_RADIUS;
    candidates.forEach(function(c) {
      var d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestDist) { bestDist = d; best = c; }
    });
    return best ? { x: best.x, y: best.y } : p;
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
    // Polyline in progress: draw committed points as a polyline plus
    // a rubber-band segment from the last placed point to the cursor.
    if (state.activePolyline && state.activePolyline.points && state.activePolyline.points.length) {
      drawStroke(ctx, state.activePolyline);
      drawPolylineDots(ctx, state.activePolyline);
      var hp = state.hoverPoint;
      if (hp) {
        var snapped = snapToEndpoint(hp, state.activePolyline);
        var snappedToExisting = snapped !== hp;
        var last = state.activePolyline.points[state.activePolyline.points.length - 1];
        ctx.save();
        ctx.strokeStyle = state.activePolyline.color;
        ctx.lineWidth = state.activePolyline.lineWidth;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(snapped.x, snapped.y);
        ctx.stroke();
        ctx.restore();
        // Snap target indicator — small ring at the snap point.
        if (snappedToExisting) drawSnapMarker(ctx, snapped);
      }
    }
  }

  function drawPolylineDots(ctx, s) {
    if (!s.points) return;
    ctx.save();
    ctx.fillStyle = s.color;
    s.points.forEach(function(p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, s.lineWidth / 2), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawSnapMarker(ctx, p) {
    ctx.save();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawStroke(ctx, s) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if ((s.tool === 'draw' || s.tool === 'polyline') && s.points && s.points.length > 1) {
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
    } else if (s.tool === 'measure') {
      drawMeasurement(ctx, s);
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

  // Architectural-style dimension line — line between the two
  // endpoints with perpendicular tick marks at each end and the
  // measurement label centered above the line. Everything (tick
  // length, tick gap, font size) auto-scales to the line length so
  // a 60-pixel "bottom of window" measurement gets a small
  // proportional label, not a giant number.
  function drawMeasurement(ctx, s) {
    var x1 = s.startX, y1 = s.startY, x2 = s.endX, y2 = s.endY;
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    // Auto-scale: text height proportional to line length, clamped
    // so short lines still read and long ones don't dominate the
    // photo. 6% of line length keeps the label subtle (a 1000px
    // wall measurement caps at 36px text instead of the previous
    // 72px which read as a billboard). Tick length and stroke
    // ratio follow the same proportion for a unified composition.
    var fontPx = Math.round(Math.max(12, Math.min(36, len * 0.06)));
    var tickHalf = Math.max(4, fontPx * 0.45);
    var stroke = Math.max(1.5, Math.min(s.lineWidth || 4, fontPx / 10));
    var cosA = dx / len, sinA = dy / len;
    // Perpendicular unit vector (rotated 90° CCW).
    var px = -sinA, py = cosA;
    var label = s.measureLabel || formatFeetInches(s.measureInches || 0);

    var lineColor = s.color;
    var numberColor = s.numberColor || s.color;

    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.fillStyle = lineColor;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.lineWidth = stroke;

    // Measure the label up front — we need its width to break the
    // dimension line cleanly so the text sits IN the line instead of
    // floating above it. Set the font on the context here so the
    // measurement matches what we'll actually draw below.
    var fontStack = '600 ' + fontPx + 'px ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';
    ctx.font = fontStack;
    var labelWidth = ctx.measureText(label).width;
    // Padding on each side of the label inside the gap.
    var labelPad = fontPx * 0.45;
    var halfGap = labelWidth / 2 + labelPad;

    // Mid point of the dimension line — where the label lives.
    var midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;

    // If the gap fits comfortably inside the line, draw two
    // segments with a clean break in the middle. Threshold: gap
    // can occupy up to ~80% of the line; below that we keep the
    // line solid and just lift the label slightly off-line so it
    // doesn't crash into the stroke. Keeps short measurements
    // ("3"") readable even when the line is barely wider than the
    // text.
    var splitLine = halfGap * 2 < len * 0.8;
    if (splitLine) {
      var gapStartX = midX - cosA * halfGap;
      var gapStartY = midY - sinA * halfGap;
      var gapEndX   = midX + cosA * halfGap;
      var gapEndY   = midY + sinA * halfGap;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(gapStartX, gapStartY);
      ctx.moveTo(gapEndX, gapEndY);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // End ticks — short perpendicular slashes at both endpoints, in
    // the AutoCAD architectural style (not arrowheads). Each tick
    // straddles its endpoint by `tickHalf` on each side.
    function tick(cx, cy) {
      ctx.beginPath();
      ctx.moveTo(cx + px * tickHalf, cy + py * tickHalf);
      ctx.lineTo(cx - px * tickHalf, cy - py * tickHalf);
      ctx.stroke();
    }
    tick(x1, y1);
    tick(x2, y2);

    // Label sits at the line's midpoint, drawn UPRIGHT (no rotation
    // to match the line angle). Bluebeam/AutoCAD calls this
    // "horizontal" or "unidirectional" dimension text — it stays
    // readable regardless of line direction. When the line is
    // split, the label sits IN the gap on-line. When not split
    // (short lines), nudge the label slightly perpendicular so it
    // reads without crashing into the stroke.
    var lx = midX, ly = midY;
    if (!splitLine) {
      var nudge = fontPx * 0.7;
      lx = midX + px * nudge;
      ly = midY + py * nudge;
    }

    ctx.translate(lx, ly);
    // No rotate — text always upright.
    ctx.font = fontStack;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Slimmer outline keeps the text crisp without a chunky halo.
    ctx.lineWidth = Math.max(1.25, fontPx / 14);
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = '#000';
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = numberColor;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  // Arrow rendering: tapered tail (narrow at start, widening as it
  // approaches the head) + a clean filled triangle tip. Drawn entirely
  // with fills, not strokes — strokes leaked the line through the tip
  // and made it look chunky on the back of the arrowhead.
  function drawArrow(ctx, x1, y1, x2, y2, width) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    var w = Math.max(2, width);
    // Arrowhead size scales with line width but caps at 60% of total
    // length so short arrows don't end up as just a triangle.
    var headLen = Math.min(len * 0.6, Math.max(12, w * 3.5));
    var headHalfWidth = w * 1.5;
    var angle = Math.atan2(dy, dx);
    var cosA = Math.cos(angle), sinA = Math.sin(angle);
    // Base of the arrowhead (meeting point with the tail).
    var xb = x2 - headLen * cosA;
    var yb = y2 - headLen * sinA;
    // Perpendicular unit vector.
    var px = -sinA, py = cosA;
    var startHalf = w / 3;   // tail starts narrow
    var baseHalf = w * 0.55; // tail at the head base — slightly wider

    ctx.save();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineJoin = 'miter';
    // Tapered tail quad.
    ctx.beginPath();
    ctx.moveTo(x1 + px * startHalf, y1 + py * startHalf);
    ctx.lineTo(xb + px * baseHalf, yb + py * baseHalf);
    ctx.lineTo(xb - px * baseHalf, yb - py * baseHalf);
    ctx.lineTo(x1 - px * startHalf, y1 - py * startHalf);
    ctx.closePath();
    ctx.fill();
    // Arrowhead triangle.
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(xb + px * headHalfWidth, yb + py * headHalfWidth);
    ctx.lineTo(xb - px * headHalfWidth, yb - py * headHalfWidth);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
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
    // Cross-entity markup (e.g. marking up a lead photo from the
    // estimate's Attachments tab): hide the "Replace original" option
    // since we don't want users overwriting attachments they don't
    // technically own from the wrong context. The new markup just
    // lands on the current entity with markup_of pointing back.
    var sourceOwner = state.attachment.entity_type + '/' + state.attachment.entity_id;
    var targetOwner = state.saveTarget.entityType + '/' + state.saveTarget.entityId;
    var isCrossEntity = sourceOwner !== targetOwner;
    var crossEntityNote = isCrossEntity
      ? '<div style="color:#fbbf24;font-size:11px;margin-bottom:10px;padding:8px 10px;background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.25);border-radius:6px;">Saving into the current ' + escapeHTML(state.saveTarget.entityType) + '. Original ' + escapeHTML(state.attachment.entity_type) + ' photo is left untouched.</div>'
      : '';
    dlg.innerHTML =
      '<div style="background:var(--surface,#15152a);border:1px solid var(--border,#333);border-radius:12px;padding:20px 22px;width:420px;max-width:90vw;color:var(--text,#fff);">' +
        '<h3 style="margin:0 0 12px 0;font-size:15px;">Save markup</h3>' +
        '<p style="margin:0 0 14px 0;color:var(--text-dim,#888);font-size:12px;">Pick where this annotated copy lands.</p>' +
        crossEntityNote +
        '<div style="display:flex;flex-direction:column;gap:8px;font-size:13px;">' +
          '<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:10px;border:1px solid var(--border,#333);border-radius:8px;">' +
            '<input type="radio" name="mk-save-mode" value="new" checked style="margin-top:3px;" />' +
            '<div><div style="font-weight:600;">Save as new</div><div style="color:var(--text-dim,#888);font-size:11px;">Original is kept. Markup appears under "Markups" linked to the original.</div></div>' +
          '</label>' +
          (isCrossEntity ? '' :
          '<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:10px;border:1px solid var(--border,#333);border-radius:8px;">' +
            '<input type="radio" name="mk-save-mode" value="replace" style="margin-top:3px;" />' +
            '<div><div style="font-weight:600;">Replace original</div><div style="color:var(--text-dim,#888);font-size:11px;">Original photo is overwritten with the marked-up version. Cannot be undone.</div></div>' +
          '</label>') +
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
          // Capture onDone BEFORE closeOverlay nulls state. Without
          // this, the refresh callback never fires and the new markup
          // doesn't show until the user manually reloads.
          var done = state && state.onDone;
          dlg.remove();
          closeOverlay();
          if (typeof done === 'function') done();
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
    var target = state.saveTarget;
    return canvasToFile(canvas, deriveMarkupFilename(att)).then(function(file) {
      var extra = {};
      if (mode === 'new' && att.id) extra.markup_of = att.id;
      if (includeInProposal) extra.include_in_proposal = true;
      var uploadP = window.agxApi.attachments.upload(target.entityType, target.entityId, file, extra);
      if (mode === 'replace') {
        // Replace only deletes the source if the markup is uploading
        // back into the same entity that owns it — replacing a foreign
        // (parent-surfaced) attachment from the wrong entity would
        // delete it from its real owner without warning.
        var sameOwner = target.entityType === att.entity_type && target.entityId === att.entity_id;
        if (!sameOwner) {
          return uploadP; // treat as save-as-new instead
        }
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
