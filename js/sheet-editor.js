// Shop-Drawing / CAD-style Sheet Editor.
//
// A dedicated 2D drafting surface for Plans whose base_kind === 'sheet'
// (distinct from the photo/PDF markup viewer). A "sheet" is a titleblock
// drawing page with one or more labeled viewports (PLAN, ELEVATION,
// SECTION), each drawn to its own scale, with CAD-style precision tools.
//
// Reuses the proven geometry + single-stroke renderer from
// markup-viewer.js via window.p86DrawPrimitives (no duplication).
//
// Persistence: the whole document is one `sheet-doc` object stored as the
// sole element of the plan's `pages` JSONB. plans.js routes here and saves
// via opts.onSave(doc, totals).
//
// Phasing: D0 = model + editor shell that renders the sheet + titleblock +
// viewport frames and round-trips the doc. D1+ add the drafting tools
// (lines, snapping, dimensions), layers, hatch, symbols, and PDF export.
//
//   window.p86SheetEditor.open({ plan, onSave })

(function () {
  'use strict';

  // Internal resolution: pixels per real inch of paper. Fixed so the
  // print scale is deterministic (ARCH D 36"×24" → 4320×2880 px).
  var DPI = 120;

  // Standard sheet sizes (landscape), in real inches.
  var SHEET_SIZES = {
    'letter':  { wIn: 11,  hIn: 8.5,  label: 'Letter 8.5×11' },
    'tabloid': { wIn: 17,  hIn: 11,   label: 'Tabloid 11×17' },
    'arch-c':  { wIn: 24,  hIn: 18,   label: 'ARCH C 18×24' },
    'arch-d':  { wIn: 36,  hIn: 24,   label: 'ARCH D 24×36' }
  };

  function prims() { return window.p86DrawPrimitives || {}; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Fresh document — ARCH D, one full-width PLAN viewport at 1/4"=1', one
  // default layer, empty titleblock.
  function defaultDoc(plan) {
    var sz = SHEET_SIZES['arch-d'];
    var w = Math.round(sz.wIn * DPI), h = Math.round(sz.hIn * DPI);
    var m = Math.round(0.5 * DPI);                 // 1/2" margin
    var tbW = Math.round(5 * DPI), tbH = Math.round(3 * DPI); // titleblock 5"×3" bottom-right
    var vpX = m, vpY = m;
    var vpW = w - m * 2;
    var vpH = h - m * 2 - tbH - m;                 // leave room above the titleblock
    return {
      kind: 'sheet-doc', version: 1,
      sheet: { size: 'arch-d', w: w, h: h, unit: 'in', margin: m },
      titleblock: {
        project: (plan && plan.name) || '', title: 'PLAN', scale: '1/4" = 1\'-0"',
        date: '', drawnBy: '', sheetNo: 'A-1', client: '', northDeg: 0
      },
      layers: [
        { id: 'L0', name: 'Default', color: '#1f2937', weight: 2, lineType: 'solid', visible: true, locked: false }
      ],
      viewports: [
        { id: 'VP1', label: 'PLAN', x: vpX, y: vpY, w: vpW, h: vpH,
          scale: { pixelsPerInch: DPI / 48, unit: 'ft', label: '1/4" = 1\'-0"' } }
      ],
      entities: []
    };
  }

  function loadDoc(plan) {
    var pages = plan && plan.pages;
    if (Array.isArray(pages) && pages[0] && pages[0].kind === 'sheet-doc') return pages[0];
    return defaultDoc(plan);
  }

  // ── Sheet rendering ─────────────────────────────────────────────
  // Paints the white sheet, border, viewport frames + labels, the
  // titleblock grid, and every entity (clipped to its viewport). D0
  // renders the frame/titleblock; entities render via p86DrawPrimitives
  // once D1 adds drawing tools.
  function renderSheet(ctx, doc) {
    var s = doc.sheet;
    // Paper
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s.w, s.h);
    // Outer border (double line, architectural)
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 6;
    ctx.strokeRect(s.margin, s.margin, s.w - s.margin * 2, s.h - s.margin * 2);
    ctx.lineWidth = 2;
    ctx.strokeRect(s.margin + 10, s.margin + 10, s.w - s.margin * 2 - 20, s.h - s.margin * 2 - 20);

    // Viewport frames + labels
    (doc.viewports || []).forEach(function (vp) {
      ctx.save();
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([14, 8]);
      ctx.strokeRect(vp.x, vp.y, vp.w, vp.h);
      ctx.setLineDash([]);
      // Label bar
      ctx.fillStyle = '#1f2937';
      ctx.font = '700 ' + Math.round(DPI * 0.18) + 'px Arial, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(vp.label + '   ' + (vp.scale && vp.scale.label ? vp.scale.label : ''),
        vp.x + 8, vp.y + vp.h - 8);
      // Entities for this viewport (D1+), clipped to the frame
      ctx.beginPath();
      ctx.rect(vp.x, vp.y, vp.w, vp.h);
      ctx.clip();
      if (typeof prims().drawStroke === 'function') {
        (doc.entities || []).forEach(function (e) {
          if (e && e.viewport === vp.id && e.tool) {
            try { prims().drawStroke(ctx, e); } catch (err) { /* defensive */ }
          }
        });
      }
      ctx.restore();
    });

    // Titleblock (bottom-right grid)
    drawTitleblock(ctx, doc);
  }

  function drawTitleblock(ctx, doc) {
    var s = doc.sheet, tb = doc.titleblock || {};
    var tbW = Math.round(5 * DPI), tbH = Math.round(3 * DPI);
    var x = s.w - s.margin - 10 - tbW;
    var y = s.h - s.margin - 10 - tbH;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, tbW, tbH);
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, tbW, tbH);
    var rowH = tbH / 5;
    ctx.lineWidth = 1;
    for (var i = 1; i < 5; i++) {
      ctx.beginPath(); ctx.moveTo(x, y + rowH * i); ctx.lineTo(x + tbW, y + rowH * i); ctx.stroke();
    }
    function field(label, val, row) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '600 ' + Math.round(DPI * 0.1) + 'px Arial, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x + 10, y + rowH * row + 8);
      ctx.fillStyle = '#111827';
      ctx.font = '700 ' + Math.round(DPI * 0.16) + 'px Arial, sans-serif';
      ctx.fillText(String(val || '—'), x + 10, y + rowH * row + Math.round(DPI * 0.13));
    }
    field('PROJECT', tb.project, 0);
    field('TITLE', tb.title, 1);
    field('CLIENT', tb.client, 2);
    field('SCALE', tb.scale, 3);
    // Bottom row: split date / drawn-by / sheet no
    ctx.fillStyle = '#6b7280';
    ctx.font = '600 ' + Math.round(DPI * 0.1) + 'px Arial, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('DATE', x + 10, y + rowH * 4 + 8);
    ctx.fillText('BY', x + tbW * 0.4 + 10, y + rowH * 4 + 8);
    ctx.fillText('SHEET', x + tbW * 0.7 + 10, y + rowH * 4 + 8);
    ctx.fillStyle = '#111827';
    ctx.font = '700 ' + Math.round(DPI * 0.16) + 'px Arial, sans-serif';
    ctx.fillText(String(tb.date || '—'), x + 10, y + rowH * 4 + Math.round(DPI * 0.13));
    ctx.fillText(String(tb.drawnBy || '—'), x + tbW * 0.4 + 10, y + rowH * 4 + Math.round(DPI * 0.13));
    ctx.fillText(String(tb.sheetNo || '—'), x + tbW * 0.7 + 10, y + rowH * 4 + Math.round(DPI * 0.13));
    ctx.restore();
  }

  // Fit the sheet into the available canvas area (letterbox).
  function fitView(doc, canvasW, canvasH) {
    var s = doc.sheet;
    var pad = 40;
    var scale = Math.min((canvasW - pad * 2) / s.w, (canvasH - pad * 2) / s.h);
    var dx = (canvasW - s.w * scale) / 2;
    var dy = (canvasH - s.h * scale) / 2;
    return { scale: scale, dx: dx, dy: dy };
  }

  // ── Editor shell ────────────────────────────────────────────────
  var _state = null;

  function open(opts) {
    opts = opts || {};
    var plan = opts.plan || {};
    var doc = loadDoc(plan);
    if (_state) close();

    var ov = document.createElement('div');
    ov.id = 'p86-sheet-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:#0b0e14;z-index:5200;display:flex;flex-direction:column;padding:14px;';
    ov.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;background:rgba(15,15,30,0.95);border:1px solid #2a2a3a;border-radius:10px;padding:8px 14px;">' +
        '<strong style="color:#fff;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📐 ' + esc(plan.name || 'Shop drawing') + '</strong>' +
        '<span style="color:#9aa;font-size:11px;margin-right:8px;">' + esc((SHEET_SIZES[doc.sheet.size] || {}).label || doc.sheet.size) + '</span>' +
        '<button id="p86-sheet-cancel" style="background:rgba(255,255,255,0.06);color:#aaa;border:1px solid #444;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;">Close</button>' +
        '<button id="p86-sheet-save" style="background:#4f8cff;color:#fff;border:0;border-radius:6px;padding:6px 16px;font-size:12px;font-weight:700;cursor:pointer;">Save</button>' +
      '</div>' +
      '<div style="flex:1;background:#11151c;border:1px solid #2a2a3a;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:0;position:relative;">' +
        '<canvas id="p86-sheet-canvas" style="display:block;max-width:100%;max-height:100%;"></canvas>' +
        '<div id="p86-sheet-hint" style="position:absolute;left:14px;bottom:12px;color:#64748b;font-size:11px;pointer-events:none;">Drafting tools land in the next build — D0 shows the sheet, titleblock & viewport frames.</div>' +
      '</div>';
    document.body.appendChild(ov);

    var canvas = ov.querySelector('#p86-sheet-canvas');
    _state = { overlay: ov, doc: doc, plan: plan, onSave: opts.onSave, canvas: canvas };

    function paint() {
      // Render the sheet to an offscreen canvas at full px size, then
      // blit it fit-to-screen (keeps render code resolution-independent).
      var area = canvas.parentElement.getBoundingClientRect();
      var cw = Math.max(320, Math.floor(area.width));
      var ch = Math.max(240, Math.floor(area.height));
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#11151c';
      ctx.fillRect(0, 0, cw, ch);
      var off = document.createElement('canvas');
      off.width = doc.sheet.w; off.height = doc.sheet.h;
      renderSheet(off.getContext('2d'), doc);
      var v = fitView(doc, cw, ch);
      ctx.drawImage(off, v.dx, v.dy, doc.sheet.w * v.scale, doc.sheet.h * v.scale);
    }

    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); _state = null; window.removeEventListener('resize', paint); }
    function save() {
      if (typeof _state.onSave === 'function') {
        // No takeoff totals for sheets in D0; pass empty.
        try { _state.onSave(doc, {}); } catch (e) { /* defensive */ }
      }
      close();
    }
    ov.querySelector('#p86-sheet-cancel').onclick = close;
    ov.querySelector('#p86-sheet-save').onclick = save;
    window.addEventListener('resize', paint);
    // Defer one tick so the flex layout has measured.
    setTimeout(paint, 0);

    _state.close = close;
    _state.repaint = paint;
  }

  function close() { if (_state && _state.close) _state.close(); }

  window.p86SheetEditor = { open: open, close: close, defaultDoc: defaultDoc, SHEET_SIZES: SHEET_SIZES, DPI: DPI };
})();
