// Shop-Drawing / CAD-style Sheet Editor.
//
// A dedicated 2D drafting surface for Plans whose base_kind === 'sheet'
// (distinct from the photo/PDF markup viewer). A "sheet" is a titleblock
// drawing page with labeled viewports (PLAN, ELEVATION, SECTION), each
// drawn to its own scale, with CAD-style precision tools.
//
// Reuses geometry + the single-stroke renderer from markup-viewer.js via
// window.p86DrawPrimitives. Persistence: one `sheet-doc` object stored as
// the sole element of the plan's `pages` JSONB; plans.js routes here and
// saves via opts.onSave(doc, totals).
//
// Phasing:
//   D0 — model + shell that renders the sheet/titleblock/viewport frames.
//   D1 — THIS: interactive drafting — pan/zoom, line/polyline/rect/circle/
//        text tools, ortho lock (Shift), grid + object snaps (endpoint/
//        midpoint/center) with a snap marker, real-world cursor readout,
//        a tool + layer toolbar. Entities persist in doc.entities.
//   D2+ — dimensions, full layers/edit ops, hatch, symbols, titleblock
//        editing, multi-viewport layout, PDF export.
//   Deferred from D1 (noted): type-in length/angle, intersection +
//        perpendicular snaps, arc tool, drag-move/rotate.
//
//   window.p86SheetEditor.open({ plan, onSave })

(function () {
  'use strict';

  var DPI = 120;                 // internal sheet pixels per real paper-inch
  var SNAP_SCREEN = 12;          // snap radius, screen px
  var SHEET_SIZES = {
    'letter':  { wIn: 11,  hIn: 8.5,  label: 'Letter 8.5×11' },
    'tabloid': { wIn: 17,  hIn: 11,   label: 'Tabloid 11×17' },
    'arch-c':  { wIn: 24,  hIn: 18,   label: 'ARCH C 18×24' },
    'arch-d':  { wIn: 36,  hIn: 24,   label: 'ARCH D 24×36' }
  };

  // Left-toolbar tools. select + draw tools + pan.
  var TOOLS = [
    { key: 'select',   glyph: '▢', label: 'Select (click to pick · Del removes)' },
    { key: 'line',     glyph: '─', label: 'Line (click start, click end · Esc cancels)' },
    { key: 'polyline', glyph: '⌇', label: 'Polyline (click points · double-click/Enter to finish)' },
    { key: 'rect',     glyph: '▭', label: 'Rectangle (click two opposite corners)' },
    { key: 'circle',   glyph: '◯', label: 'Circle (click center, click radius)' },
    { key: 'arc',      glyph: '⌒', label: 'Arc (3-point: click start, a point on the arc, then end)' },
    { key: 'trim',     glyph: '✂', label: 'Trim — click a line segment to cut it back to the nearest crossing line' },
    { key: 'extend',   glyph: '⇥', label: 'Extend — click a line near the end to extend it to the next line it meets' },
    { key: 'fillet',   glyph: '◜', label: 'Fillet — click two lines, then enter a radius (0 = sharp corner)' },
    { key: 'dim',      glyph: '↔', label: 'Dimension (click two points — auto-labels real length at the viewport scale)' },
    { key: 'angle',    glyph: '∠', label: 'Angle dimension (click three points: leg · vertex · leg)' },
    { key: 'leader',   glyph: '➘', label: 'Leader / callout (click target, click text position)' },
    { key: 'hatch',    glyph: '▨', label: 'Hatch fill (click a closed region; pick a material pattern) — double-click / Enter to close' },
    { key: 'symbol',   glyph: '✱', label: 'Symbol / block (north arrow, sprinkler head, post, tree, callout)' },
    { key: 'text',     glyph: 'T', label: 'Text (click to place)' },
    { key: 'pan',      glyph: '✋', label: 'Pan (or hold Space / middle-drag)' }
  ];

  var HATCH_PATTERNS = [
    { key: 'earth', label: 'Earth' }, { key: 'concrete', label: 'Concrete' },
    { key: 'gravel', label: 'Gravel' }, { key: 'brick', label: 'Brick/Paver' },
    { key: 'grass', label: 'Grass' }, { key: 'solid', label: 'Solid' }
  ];
  var SYMBOLS = [
    { key: 'north', label: 'North' }, { key: 'head', label: 'Head' },
    { key: 'post', label: 'Post' }, { key: 'tree', label: 'Tree' },
    { key: 'callout', label: 'Callout' }
  ];
  // Architectural + civil scales. f = paper-inches per real-inch; the
  // viewport's pixelsPerInch (sheet px per real inch) = DPI * f.
  var SCALE_PRESETS = [
    { label: '1/8" = 1\'-0"', f: 0.125 / 12 }, { label: '1/4" = 1\'-0"', f: 0.25 / 12 },
    { label: '1/2" = 1\'-0"', f: 0.5 / 12 }, { label: '3/4" = 1\'-0"', f: 0.75 / 12 },
    { label: '1" = 1\'-0"', f: 1 / 12 }, { label: '1-1/2" = 1\'-0"', f: 1.5 / 12 },
    { label: '3" = 1\'-0"', f: 3 / 12 }, { label: '1" = 10\'', f: 1 / 120 },
    { label: '1" = 20\'', f: 1 / 240 }, { label: '1" = 30\'', f: 1 / 360 }
  ];
  var VIEW_LABELS = ['PLAN', 'FRONT ELEVATION', 'SIDE ELEVATION', 'SECTION', 'DETAIL'];

  function prims() { return window.p86DrawPrimitives || {}; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function uid(p) { return (p || 'e') + '_' + Math.random().toString(36).slice(2, 9); }

  // ── Editor defaults (E5) — persisted to localStorage ────────────
  // New drawings adopt scaleLabel + sheetSize + dimColor; unit/grid/snap
  // defaults also apply to the live session when changed in Settings.
  var SETTINGS_KEY = 'p86SheetSettings';
  var DEFAULT_SETTINGS = {
    unit: 'ft-in',                 // 'ft-in' | 'ft' (decimal feet)
    scaleLabel: '1/4" = 1\'-0"',
    sheetSize: 'arch-d',
    gridFt: 1,
    ortho: false, gridSnap: true, osnap: true,
    dimColor: '#b45309'
  };
  function loadSettings() {
    var s = {};
    try { var raw = localStorage.getItem(SETTINGS_KEY); if (raw) s = JSON.parse(raw) || {}; } catch (e) {}
    var out = {}; for (var k in DEFAULT_SETTINGS) out[k] = (s[k] != null) ? s[k] : DEFAULT_SETTINGS[k];
    return out;
  }
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (e) {} }
  function scalePreset(label) {
    for (var i = 0; i < SCALE_PRESETS.length; i++) if (SCALE_PRESETS[i].label === label) return SCALE_PRESETS[i];
    return SCALE_PRESETS[1];        // 1/4" = 1'-0"
  }
  var SETTINGS = loadSettings();

  // ── Document model ──────────────────────────────────────────────
  function defaultDoc(plan) {
    var sizeKey = SHEET_SIZES[SETTINGS.sheetSize] ? SETTINGS.sheetSize : 'arch-d';
    var sz = SHEET_SIZES[sizeKey];
    var w = Math.round(sz.wIn * DPI), h = Math.round(sz.hIn * DPI);
    var m = Math.round(0.5 * DPI);
    var tbH = Math.round(3 * DPI);
    var vpX = m + 14, vpY = m + 14;
    var vpW = w - m * 2 - 28;
    var vpH = h - m * 2 - 28 - tbH - 14;
    var pre = scalePreset(SETTINGS.scaleLabel);
    return {
      kind: 'sheet-doc', version: 1,
      sheet: { size: sizeKey, w: w, h: h, unit: 'in', margin: m },
      titleblock: {
        project: (plan && plan.name) || '', title: 'PLAN', scale: pre.label,
        date: '', drawnBy: '', sheetNo: 'A-1', client: '', northDeg: 0,
        company: '', showLogo: true
      },
      layers: [
        { id: 'L0', name: 'Default', color: '#1f2937', weight: 4, lineType: 'solid', visible: true, locked: false },
        { id: 'L1', name: 'Dimensions', color: SETTINGS.dimColor || '#b45309', weight: 2, lineType: 'solid', visible: true, locked: false },
        { id: 'L2', name: 'Hidden', color: '#64748b', weight: 2, lineType: 'dashed', visible: true, locked: false }
      ],
      viewports: [
        { id: 'VP1', label: 'PLAN', x: vpX, y: vpY, w: vpW, h: vpH,
          scale: { pixelsPerInch: DPI * pre.f, unit: 'ft', label: pre.label } }
      ],
      entities: []
    };
  }
  function loadDoc(plan) {
    var pages = plan && plan.pages;
    if (Array.isArray(pages) && pages[0] && pages[0].kind === 'sheet-doc') return pages[0];
    return defaultDoc(plan);
  }
  function layerById(doc, id) {
    var ls = doc.layers || [];
    for (var i = 0; i < ls.length; i++) if (ls[i].id === id) return ls[i];
    return ls[0] || { color: '#1f2937', weight: 3, visible: true, locked: false };
  }

  // ── Static sheet render (used by editor under a transform, and at
  // full size for print/export in D6). Draws paper, border, viewport
  // frames + labels, titleblock, and committed entities (via drawStroke).
  function renderSheet(ctx, doc, opts) {
    opts = opts || {};
    var s = doc.sheet;
    // Editor-only paper drop-shadow (export passes no shadow → clean sheet).
    if (opts.paperShadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 34; ctx.shadowOffsetY = 12;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, s.w, s.h);
      ctx.restore();
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s.w, s.h);
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 6;
    ctx.strokeRect(s.margin, s.margin, s.w - s.margin * 2, s.h - s.margin * 2);
    ctx.lineWidth = 2;
    ctx.strokeRect(s.margin + 10, s.margin + 10, s.w - s.margin * 2 - 20, s.h - s.margin * 2 - 20);

    (doc.viewports || []).forEach(function (vp) {
      ctx.save();
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([14, 8]);
      ctx.strokeRect(vp.x, vp.y, vp.w, vp.h);
      ctx.setLineDash([]);
      // clip entities to the viewport frame
      ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.w, vp.h); ctx.clip();
      // Editor-only faint reference grid (1 ft minor / 5 ft major), gated
      // by zoom so it never turns into a solid fill when zoomed out.
      if (opts.grid && vp.scale && vp.scale.pixelsPerInch) {
        drawViewportGrid(ctx, vp, opts.viewScale || 1);
      }
      if (typeof prims().drawStroke === 'function') {
        (doc.entities || []).forEach(function (e) {
          if (!e || e.viewport !== vp.id || !e.tool) return;
          var lyr = layerById(doc, e.layer);
          if (lyr && lyr.visible === false) return;
          // Hatch + symbol have their own renderers (not in drawStroke).
          if (e.tool === 'hatch') { try { drawHatch(ctx, e); } catch (err) {} return; }
          if (e.tool === 'symbol') { try { drawSymbol(ctx, e); } catch (err) {} return; }
          if (e.tool === 'arc') { try { drawArc(ctx, e); } catch (err) {} return; }
          // Dimension labels are derived live from the viewport scale, so
          // they stay correct as geometry changes (auto-update).
          if (e.tool === 'measure' && vp.scale && vp.scale.pixelsPerInch) {
            var px = Math.hypot(e.endX - e.startX, e.endY - e.startY);
            e.measureInches = px / vp.scale.pixelsPerInch;
            e.measureLabel = fmtLen(e.measureInches);
          }
          try { prims().drawStroke(ctx, e); } catch (err) { /* defensive */ }
        });
      }
      try { drawScaleBar(ctx, vp); } catch (err) { /* defensive */ }
      ctx.restore();
      // label bar (outside clip)
      ctx.fillStyle = '#1f2937';
      ctx.font = '700 ' + Math.round(DPI * 0.18) + 'px Arial, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(vp.label + '    ' + (vp.scale && vp.scale.label ? vp.scale.label : ''),
        vp.x + 4, vp.y - 6);
    });

    drawNorthArrow(ctx, doc);
    drawTitleblock(ctx, doc);
  }

  // Modern titleblock: a dark company band (logo + org name) over a clean
  // field grid, with the sheet number emphasized. Pulls the org logo +
  // name from the branding kit (loaded async into S._logo / S._orgName).
  function drawTitleblock(ctx, doc) {
    var s = doc.sheet, tb = doc.titleblock || {};
    var tbW = Math.round(5 * DPI), tbH = Math.round(3 * DPI);
    var x = s.w - s.margin - 10 - tbW;
    var y = s.h - s.margin - 10 - tbH;
    var pad = Math.round(DPI * 0.11);
    ctx.save();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, tbW, tbH);
    ctx.strokeStyle = '#111827'; ctx.lineWidth = 2.5; ctx.strokeRect(x, y, tbW, tbH);

    // ── Company band (top) ──
    var bandH = Math.round(tbH * 0.26);
    ctx.fillStyle = '#111827'; ctx.fillRect(x, y, tbW, bandH);
    var company = String(tb.company || (S && S._orgName) || '').toUpperCase();
    var logo = (tb.showLogo !== false && S && S._logo) ? S._logo : null;
    var textX = x + pad;
    if (logo) {
      var boxH = bandH - pad, boxW = Math.round(bandH * 1.7);
      var iw = logo.naturalWidth || logo.width || 1, ih = logo.naturalHeight || logo.height || 1;
      var sc = Math.min(boxW / iw, boxH / ih), dw = iw * sc, dh = ih * sc;
      var ly = y + (bandH - dh) / 2;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x + pad - 4, ly - 4, dw + 8, dh + 8);
      try { ctx.drawImage(logo, x + pad, ly, dw, dh); } catch (e) {}
      textX = x + pad + dw + pad;
    }
    ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = '800 ' + Math.round(DPI * 0.19) + 'px Arial, sans-serif';
    ctx.fillText(company || 'COMPANY NAME', textX, y + bandH / 2, x + tbW - textX - pad);

    // ── Field grid (below band) ──
    var gy = y + bandH, gh = tbH - bandH, rows = 4, rowH = gh / rows;
    var midX = x + tbW * 0.55, splitX = x + tbW * 0.3;
    ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1;
    for (var i = 1; i < rows; i++) { ctx.beginPath(); ctx.moveTo(x, gy + rowH * i); ctx.lineTo(x + tbW, gy + rowH * i); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(midX, gy + rowH * 2); ctx.lineTo(midX, gy + rowH * 4); ctx.stroke();   // CLIENT|SCALE + ·|SHEET
    ctx.beginPath(); ctx.moveTo(splitX, gy + rowH * 3); ctx.lineTo(splitX, gy + rowH * 4); ctx.stroke(); // DATE|BY
    function cell(label, val, cx, cy, cw, big) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#6b7280'; ctx.font = '700 ' + Math.round(DPI * 0.08) + 'px Arial, sans-serif';
      ctx.fillText(label, cx + pad * 0.8, cy + Math.round(DPI * 0.06));
      ctx.fillStyle = '#111827';
      ctx.font = (big ? '800 ' + Math.round(DPI * 0.24) : '700 ' + Math.round(DPI * 0.145)) + 'px Arial, sans-serif';
      ctx.fillText(String(val || '—'), cx + pad * 0.8, cy + rowH * (big ? 0.36 : 0.44), cw - pad * 1.6);
    }
    cell('PROJECT', tb.project, x, gy, tbW);
    cell('SHEET TITLE', tb.title, x, gy + rowH, tbW);
    cell('CLIENT', tb.client, x, gy + rowH * 2, tbW * 0.55);
    cell('SCALE', tb.scale, midX, gy + rowH * 2, tbW * 0.45);
    cell('DATE', tb.date, x, gy + rowH * 3, tbW * 0.3);
    cell('DRAWN BY', tb.drawnBy, splitX, gy + rowH * 3, tbW * 0.25);
    cell('SHEET', tb.sheetNo, midX, gy + rowH * 3, tbW * 0.45, true);
    ctx.restore();
  }

  // North arrow at the sheet's top-right (rotates with titleblock.northDeg).
  function drawNorthArrow(ctx, doc) {
    var s = doc.sheet, tb = doc.titleblock || {};
    var r = Math.round(DPI * 0.4);
    var nx = s.w - s.margin - 22 - r, ny = s.margin + 22 + r;
    ctx.save();
    ctx.translate(nx, ny);
    ctx.rotate((tb.northDeg || 0) * Math.PI / 180);
    ctx.strokeStyle = '#111827'; ctx.fillStyle = '#111827'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, r * 0.72); ctx.lineTo(0, -r * 0.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -r * 0.72); ctx.lineTo(-r * 0.24, -r * 0.34); ctx.lineTo(r * 0.24, -r * 0.34); ctx.closePath(); ctx.fill();
    ctx.font = '800 ' + Math.round(r * 0.62) + 'px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, -r * 1.32);
    ctx.restore();
  }

  // Pick the largest "nice" round number of feet whose bar fits in maxPx.
  function niceScaleFeet(ppi, maxPx) {
    var cand = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000], best = cand[0];
    for (var i = 0; i < cand.length; i++) if (cand[i] * 12 * ppi <= maxPx) best = cand[i];
    return best;
  }
  // Graphic scale bar in a viewport's bottom-left — stays true when printed.
  function drawScaleBar(ctx, vp) {
    if (!vp.scale || !vp.scale.pixelsPerInch) return;
    var ppi = vp.scale.pixelsPerInch;
    var ft = niceScaleFeet(ppi, vp.w * 0.32), barPx = ft * 12 * ppi;
    if (barPx < 24 || barPx > vp.w - 28) return;
    var segs = 4, segPx = barPx / segs, bx = vp.x + 14, by = vp.y + vp.h - 26, bh = 7;
    ctx.save();
    ctx.lineWidth = 1; ctx.strokeStyle = '#111827';
    for (var i = 0; i < segs; i++) {
      ctx.fillStyle = (i % 2 === 0) ? '#111827' : '#ffffff';
      ctx.fillRect(bx + segPx * i, by, segPx, bh); ctx.strokeRect(bx + segPx * i, by, segPx, bh);
    }
    ctx.fillStyle = '#111827'; ctx.font = '700 ' + Math.round(DPI * 0.08) + 'px Arial, sans-serif';
    ctx.textBaseline = 'bottom'; ctx.textAlign = 'left'; ctx.fillText('0', bx - 2, by - 3);
    ctx.textAlign = 'right'; ctx.fillText(ft + " ft", bx + barPx + 2, by - 3);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(vp.scale.label || '', bx + barPx / 2, by + bh + 2);
    ctx.restore();
  }

  // ── Hatch + symbol renderers (D4) ───────────────────────────────
  function polyBBox(pts) {
    var mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    pts.forEach(function (p) { if (p.x < mnx) mnx = p.x; if (p.y < mny) mny = p.y; if (p.x > mxx) mxx = p.x; if (p.y > mxy) mxy = p.y; });
    return { x: mnx, y: mny, w: mxx - mnx, h: mxy - mny };
  }
  function hashJ(x, y) { var n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return n - Math.floor(n); }
  function rgba(hex, a) {
    var h = String(hex || '#1f2937').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16); if (isNaN(n)) return 'rgba(31,41,55,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function drawHatch(ctx, e) {
    var pts = e.points; if (!pts || pts.length < 3) return;
    var col = e.color || '#1f2937';
    ctx.save();
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.save(); ctx.clip();
    drawPattern(ctx, e.pattern || 'earth', polyBBox(pts), col);
    ctx.restore();
    ctx.strokeStyle = col; ctx.lineWidth = e.lineWidth || 2; ctx.stroke();
    ctx.restore();
  }
  function drawPattern(ctx, pat, bb, col) {
    var x0 = bb.x, y0 = bb.y, x1 = bb.x + bb.w, y1 = bb.y + bb.h, x, y;
    ctx.save();
    if (pat === 'solid') {
      ctx.fillStyle = rgba(col, 0.14); ctx.fillRect(x0, y0, bb.w, bb.h);
    } else if (pat === 'earth') {
      ctx.strokeStyle = rgba(col, 0.5); ctx.lineWidth = 1; var step = 16;
      for (var d = -bb.h; d < bb.w; d += step) { ctx.beginPath(); ctx.moveTo(x0 + d, y1); ctx.lineTo(x0 + d + bb.h, y0); ctx.stroke(); }
    } else if (pat === 'concrete') {
      ctx.fillStyle = rgba(col, 0.55); var s1 = 13;
      for (x = x0; x < x1; x += s1) for (y = y0; y < y1; y += s1) {
        var jx = (hashJ(x, y) - 0.5) * s1, jy = (hashJ(y, x) - 0.5) * s1;
        ctx.beginPath(); ctx.arc(x + jx, y + jy, 0.9, 0, Math.PI * 2); ctx.fill();
      }
    } else if (pat === 'gravel') {
      ctx.strokeStyle = rgba(col, 0.6); ctx.lineWidth = 1; var s2 = 22;
      for (x = x0; x < x1; x += s2) for (y = y0; y < y1; y += s2) {
        var r = 2 + hashJ(x, y) * 4, jx2 = (hashJ(x + 1, y) - 0.5) * s2, jy2 = (hashJ(x, y + 1) - 0.5) * s2;
        ctx.beginPath(); ctx.arc(x + jx2, y + jy2, r, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (pat === 'brick') {
      ctx.strokeStyle = rgba(col, 0.55); ctx.lineWidth = 1; var bw = 44, bh = 18, row = 0;
      for (y = y0; y < y1; y += bh, row++) {
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        var off = (row % 2) ? bw / 2 : 0;
        for (x = x0 - bw + off; x < x1; x += bw) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + bh); ctx.stroke(); }
      }
    } else if (pat === 'grass') {
      ctx.strokeStyle = rgba(col, 0.6); ctx.lineWidth = 1; var sx = 18, sy = 20;
      for (y = y0 + sy; y < y1; y += sy) for (x = x0; x < x1; x += sx) {
        var jx3 = hashJ(x, y) * 6;
        ctx.beginPath();
        ctx.moveTo(x + jx3, y); ctx.lineTo(x + jx3 - 3, y - 9);
        ctx.moveTo(x + jx3, y); ctx.lineTo(x + jx3, y - 11);
        ctx.moveTo(x + jx3, y); ctx.lineTo(x + jx3 + 3, y - 9);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  function drawSymbol(ctx, e) {
    var s = e.size || 40, col = e.color || '#1f2937';
    ctx.save();
    ctx.translate(e.x, e.y);
    if (e.rotation) ctx.rotate(e.rotation * Math.PI / 180);
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.lineWidth = Math.max(1.5, s * 0.05); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    var r = s / 2;
    if (e.kind === 'north') {
      ctx.beginPath(); ctx.moveTo(0, r); ctx.lineTo(0, -r); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(-r * 0.28, -r * 0.55); ctx.lineTo(r * 0.28, -r * 0.55); ctx.closePath(); ctx.fill();
      ctx.font = '700 ' + Math.round(s * 0.34) + 'px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('N', 0, -r - 2);
    } else if (e.kind === 'head') {
      ctx.beginPath(); ctx.arc(0, 0, s * 0.16, 0, Math.PI * 2); ctx.fill();
      for (var a = 0; a < 4; a++) {
        ctx.save(); ctx.rotate(a * Math.PI / 2);
        ctx.beginPath(); ctx.arc(0, 0, r * 0.85, -0.4, 0.4); ctx.stroke();
        ctx.restore();
      }
    } else if (e.kind === 'post') {
      ctx.fillRect(-s * 0.18, -s * 0.18, s * 0.36, s * 0.36);
    } else if (e.kind === 'tree') {
      ctx.beginPath(); ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2); ctx.stroke();
      for (var t = 0; t < 8; t++) { var ang = t * Math.PI / 4; ctx.beginPath(); ctx.moveTo(Math.cos(ang) * r * 0.55, Math.sin(ang) * r * 0.55); ctx.lineTo(Math.cos(ang) * r * 0.85, Math.sin(ang) * r * 0.85); ctx.stroke(); }
    } else if (e.kind === 'callout') {
      ctx.beginPath(); ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = col; ctx.font = '700 ' + Math.round(s * 0.5) + 'px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(e.label != null ? e.label : '?'), 0, 1);
    }
    ctx.restore();
  }

  // ── Arc (3-point) ───────────────────────────────────────────────
  // Stored as { tool:'arc', points:[start, through, end] } so it reuses the
  // generic points machinery for bbox / grips / snaps / move / transform.
  // The circle + sweep are recomputed from the 3 points on every render.
  function arcSamples(pts, n) {
    if (!pts || pts.length < 3) return (pts || []).slice();
    var p1 = pts[0], p2 = pts[1], p3 = pts[2];
    var ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
    var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-6) return [p1, p3];          // collinear → straight
    var ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    var uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    var r = Math.hypot(ax - ux, ay - uy);
    var a1 = Math.atan2(ay - uy, ax - ux), a2 = Math.atan2(by - uy, bx - ux), a3 = Math.atan2(cy - uy, cx - ux);
    function norm(a) { a %= 2 * Math.PI; if (a < 0) a += 2 * Math.PI; return a; }
    var dCcw = norm(a3 - a1), mCcw = norm(a2 - a1);
    var sweep = (mCcw <= dCcw) ? dCcw : -(2 * Math.PI - dCcw);   // pass through p2
    n = n || 56; var out = [];
    for (var i = 0; i <= n; i++) { var a = a1 + sweep * (i / n); out.push({ x: ux + r * Math.cos(a), y: uy + r * Math.sin(a) }); }
    return out;
  }
  function drawArc(ctx, e) {
    var s = arcSamples(e.points, 56); if (s.length < 2) return;
    ctx.save();
    ctx.strokeStyle = e.color || '#1f2937'; ctx.lineWidth = e.lineWidth || 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (e.lineType === 'dashed') ctx.setLineDash([10, 6]);
    ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y);
    for (var i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
    ctx.stroke();
    ctx.restore();
  }

  // Faint reference grid inside a viewport — 1 ft minor, 5 ft major.
  // Origin aligned to vp.x/vp.y so it matches the grid-snap lattice.
  function drawViewportGrid(ctx, vp, viewScale) {
    var step = vp.scale.pixelsPerInch * 12 * (SETTINGS.gridFt || 1);   // grid spacing, sheet px
    if (step * viewScale < 7) return;                // too dense at this zoom
    var x0 = vp.x, y0 = vp.y, x1 = vp.x + vp.w, y1 = vp.y + vp.h, x, y;
    ctx.save();
    ctx.strokeStyle = 'rgba(37,99,235,0.09)'; ctx.lineWidth = 1 / viewScale;
    for (x = x0; x <= x1 + 0.5; x += step) { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); }
    for (y = y0; y <= y1 + 0.5; y += step) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
    var major = step * 5;
    ctx.strokeStyle = 'rgba(37,99,235,0.20)'; ctx.lineWidth = 1.3 / viewScale;
    for (x = x0; x <= x1 + 0.5; x += major) { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); }
    for (y = y0; y <= y1 + 0.5; y += major) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
    ctx.restore();
  }

  function fitView(doc, cw, ch) {
    var s = doc.sheet, pad = 40;
    var scale = Math.min((cw - pad * 2) / s.w, (ch - pad * 2) / s.h);
    return { scale: scale, tx: (cw - s.w * scale) / 2, ty: (ch - s.h * scale) / 2 };
  }

  // ── Editor ──────────────────────────────────────────────────────
  var S = null;   // active editor state

  function open(opts) {
    opts = opts || {};
    if (S) close();
    var plan = opts.plan || {};
    var doc = loadDoc(plan);

    var ov = document.createElement('div');
    ov.id = 'p86-sheet-overlay';
    ov.tabIndex = -1;
    ov.style.cssText = 'position:fixed;inset:0;background:#0b0e14;z-index:5200;display:flex;flex-direction:column;padding:14px;outline:none;';
    ov.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;background:rgba(15,15,30,0.95);border:1px solid #2a2a3a;border-radius:10px;padding:8px 14px;">' +
        '<strong style="color:#fff;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📐 ' + esc(plan.name || 'Shop drawing') + '</strong>' +
        '<button id="p86-sheet-settings" title="Editor settings &amp; defaults (units, scale, sheet size, grid, snaps)" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 11px;font-size:13px;cursor:pointer;">⚙</button>' +
        '<button id="p86-sheet-png" title="Download the sheet as a PNG" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;">⬇ PNG</button>' +
        '<button id="p86-sheet-pdf" title="Print / Save as PDF at true sheet size" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;">⎙ PDF</button>' +
        '<button id="p86-sheet-cancel" style="background:rgba(255,255,255,0.06);color:#aaa;border:1px solid #444;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;">Close</button>' +
        '<button id="p86-sheet-save" style="background:#4f8cff;color:#fff;border:0;border-radius:6px;padding:6px 16px;font-size:12px;font-weight:700;cursor:pointer;">Save</button>' +
      '</div>' +
      '<div style="display:flex;gap:10px;flex:1;min-height:0;">' +
        // left toolbar
        '<div id="p86-sheet-tools" style="width:56px;flex:0 0 56px;background:rgba(15,15,30,0.95);border:1px solid #2a2a3a;border-radius:10px;padding:8px 6px;display:flex;flex-direction:column;gap:6px;align-items:center;overflow-y:auto;"></div>' +
        // canvas
        '<div style="flex:1;background:#11151c;border:1px solid #2a2a3a;border-radius:10px;overflow:hidden;position:relative;min-width:0;">' +
          '<canvas id="p86-sheet-canvas" style="display:block;width:100%;height:100%;cursor:crosshair;"></canvas>' +
          '<div id="p86-sheet-picker" style="display:none;position:absolute;left:10px;top:10px;gap:4px;flex-wrap:wrap;max-width:60%;background:rgba(15,15,30,0.95);border:1px solid #3a3a4a;border-radius:8px;padding:6px;box-shadow:0 6px 20px rgba(0,0,0,0.5);"></div>' +
          // Dynamic input — type exact length (+ angle) after the first click.
          '<div id="p86-sheet-dyn" style="display:none;position:absolute;align-items:center;gap:4px;background:rgba(15,15,30,0.97);border:1px solid #4f8cff;border-radius:6px;padding:4px 6px;box-shadow:0 4px 14px rgba(0,0,0,0.55);z-index:20;">' +
            '<span style="font-size:10px;color:#9aa;font-weight:700;">LEN</span>' +
            '<input data-dyn-len type="text" autocomplete="off" placeholder="" style="width:78px;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:4px;padding:3px 6px;font-size:12px;font-weight:600;outline:none;" />' +
            '<span style="font-size:10px;color:#9aa;font-weight:700;">∠</span>' +
            '<input data-dyn-ang type="text" autocomplete="off" placeholder="" style="width:52px;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:4px;padding:3px 6px;font-size:12px;font-weight:600;outline:none;" />' +
          '</div>' +
          '<div id="p86-sheet-hint" style="position:absolute;left:12px;bottom:10px;color:#64748b;font-size:11px;pointer-events:none;"></div>' +
        '</div>' +
        // right: layers
        '<div id="p86-sheet-layers" style="width:184px;flex:0 0 184px;background:rgba(15,15,30,0.95);border:1px solid #2a2a3a;border-radius:10px;padding:10px;overflow-y:auto;color:#e6e6e6;font-size:12px;"></div>' +
      '</div>' +
      // bottom status bar (AutoCAD-style): coords · tool · snap · zoom · mode toggles
      '<div style="display:flex;align-items:center;gap:14px;margin-top:8px;background:rgba(15,15,30,0.95);border:1px solid #2a2a3a;border-radius:8px;padding:5px 12px;font-size:11px;color:#9aa;font-variant-numeric:tabular-nums;">' +
        '<span id="p86-sb-coords" style="min-width:188px;color:#cbd5e1;">x —   y —</span>' +
        '<span id="p86-sb-snap" style="min-width:78px;color:#fbbf24;"></span>' +
        '<span id="p86-sb-view" style="color:#64748b;"></span>' +
        '<span style="flex:1;"></span>' +
        '<span id="p86-sb-zoom" style="color:#64748b;margin-right:6px;"></span>' +
        '<button data-sb-toggle="ortho" title="Ortho lock (or hold Shift) — 0/45/90°" style="background:rgba(255,255,255,0.05);color:#9aa;border:1px solid #444;border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;letter-spacing:0.4px;cursor:pointer;">ORTHO</button>' +
        '<button data-sb-toggle="grid" title="Snap to grid (1 ft)" style="background:rgba(255,255,255,0.05);color:#9aa;border:1px solid #444;border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;letter-spacing:0.4px;cursor:pointer;">GRID</button>' +
        '<button data-sb-toggle="osnap" title="Object snap (endpoint / midpoint / center)" style="background:rgba(255,255,255,0.05);color:#9aa;border:1px solid #444;border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;letter-spacing:0.4px;cursor:pointer;">OSNAP</button>' +
      '</div>';
    document.body.appendChild(ov);

    var canvas = ov.querySelector('#p86-sheet-canvas');
    S = {
      overlay: ov, canvas: canvas, ctx: canvas.getContext('2d'),
      doc: doc, plan: plan, onSave: opts.onSave,
      view: { scale: 1, tx: 0, ty: 0 },
      tool: 'line',
      activeLayer: (doc.layers[0] && doc.layers[0].id) || 'L0',
      draft: null,          // in-progress entity (sheet coords)
      hover: null,          // {x,y} sheet coords of cursor
      snap: null,           // {x,y,kind} active snap
      ortho: !!SETTINGS.ortho,
      gridSnap: SETTINGS.gridSnap !== false,
      objSnap: SETTINGS.osnap !== false,
      panning: null,        // {sx,sy,tx,ty}
      spaceDown: false,
      selectedId: null,
      moveDrag: null,       // {last:{x,y}, pushed:bool} while dragging a selection
      gripDrag: null,       // {gi, type, last, pushed} while dragging a grip handle
      hatchPattern: 'earth',
      symbolKind: 'north',
      _calloutNum: 1,
      _undo: [], _redo: []  // history stacks (JSON snapshots of entities+layers)
    };

    buildToolbar();
    buildLayers();
    sizeCanvas(true);
    wireInput();
    repaint();
    loadOrgBrand();

    ov.focus();
    window.addEventListener('resize', onResize);
    S.onResize = onResize;
  }

  // Pull the org name + branding logo for the titleblock. Name comes from
  // /api/org/branding; the logo is fetched through the same-origin proxy
  // (/api/org/logo) as a blob → object URL so the canvas exports cleanly.
  function loadOrgBrand() {
    if (!S || !window.p86Api || !window.p86Api.org) return;
    window.p86Api.org.branding().then(function (r) {
      if (!S) return;
      S._orgName = (r && r.name) || '';
      repaint();
      if (r && r.branding && r.branding.logo_url) loadOrgLogo();
    }).catch(function () { /* no org branding — titleblock just omits it */ });
  }
  function loadOrgLogo() {
    var token = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) || null;
    if (!token) { try { token = localStorage.getItem('p86-auth-token'); } catch (e) {} }
    var headers = {}; if (token) headers['Authorization'] = 'Bearer ' + token;
    fetch('/api/org/logo', { headers: headers, credentials: 'same-origin' })
      .then(function (resp) { if (!resp.ok) throw new Error('no logo'); return resp.blob(); })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
          if (S) { S._logo = img; repaint(); }
          setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 0);
        };
        img.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) {} };
        img.src = url;
      })
      .catch(function () { /* logo optional */ });
  }

  function close() {
    if (!S) return;
    if (S.onResize) window.removeEventListener('resize', S.onResize);
    if (S.overlay && S.overlay.parentNode) S.overlay.parentNode.removeChild(S.overlay);
    S = null;
  }

  function onResize() { if (S) { sizeCanvas(false); repaint(); } }

  function sizeCanvas(fit) {
    var area = S.canvas.parentElement.getBoundingClientRect();
    var w = Math.max(320, Math.floor(area.width));
    var h = Math.max(240, Math.floor(area.height));
    // Render at device-pixel resolution for crisp lines on HiDPI/retina.
    // All view math stays in CSS px; repaint applies the dpr base transform.
    // (dpr === 1 → byte-identical to the pre-HiDPI behavior.)
    var dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    S.dpr = dpr; S.cssW = w; S.cssH = h;
    S.canvas.width = Math.round(w * dpr); S.canvas.height = Math.round(h * dpr);
    if (fit) S.view = fitView(S.doc, w, h);
  }

  // ── Toolbar + layers UI ─────────────────────────────────────────
  function buildToolbar() {
    var bar = S.overlay.querySelector('#p86-sheet-tools');
    var html = TOOLS.map(function (t) {
      return '<button data-sheet-tool="' + t.key + '" title="' + esc(t.label) + '" ' +
        'style="width:42px;height:40px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:17px;cursor:pointer;line-height:1;">' + t.glyph + '</button>';
    }).join('');
    html += '<div style="width:34px;height:1px;background:#3a3a4a;margin:4px 0;"></div>';
    html += '<button data-sheet-edit="rotate" title="Rotate selection 90°" style="width:42px;height:34px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:15px;cursor:pointer;">⟳</button>';
    html += '<button data-sheet-edit="mirrorH" title="Mirror selection (horizontal)" style="width:42px;height:34px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:15px;cursor:pointer;">⇆</button>';
    html += '<button data-sheet-edit="mirrorV" title="Mirror selection (vertical)" style="width:42px;height:34px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:15px;cursor:pointer;">⇅</button>';
    html += '<button data-sheet-edit="dup" title="Duplicate selection (Ctrl+D)" style="width:42px;height:34px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:14px;cursor:pointer;">⧉</button>';
    html += '<button data-sheet-edit="offset" title="Offset selection by a distance (line / polyline / rect / circle)" style="width:42px;height:34px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:14px;cursor:pointer;">⎘</button>';
    html += '<button data-sheet-edit="array" title="Array selection (rows × columns)" style="width:42px;height:34px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:14px;cursor:pointer;">▦</button>';
    html += '<div style="width:34px;height:1px;background:#3a3a4a;margin:4px 0;"></div>';
    html += '<button data-sheet-undo title="Undo (Ctrl+Z)" style="width:42px;height:34px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:14px;cursor:pointer;">↶</button>';
    html += '<button data-sheet-redo title="Redo (Ctrl+Y / Ctrl+Shift+Z)" style="width:42px;height:34px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:14px;cursor:pointer;">↷</button>';
    html += '<button data-sheet-fit title="Fit to screen" style="width:42px;height:34px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:13px;cursor:pointer;">⤢</button>';
    bar.innerHTML = html;
    bar.querySelectorAll('[data-sheet-tool]').forEach(function (b) {
      b.onclick = function () { setTool(b.getAttribute('data-sheet-tool')); };
    });
    S.overlay.querySelectorAll('[data-sb-toggle]').forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-sb-toggle');
        if (k === 'ortho') S.ortho = !S.ortho;
        else if (k === 'grid') S.gridSnap = !S.gridSnap;
        else if (k === 'osnap') S.objSnap = !S.objSnap;
        refreshStatusBar();
        repaint();
      };
    });
    bar.querySelectorAll('[data-sheet-edit]').forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-sheet-edit');
        if (!S.selectedId) { return; }
        if (k === 'rotate') rotate90();
        else if (k === 'mirrorH') mirror(true);
        else if (k === 'mirrorV') mirror(false);
        else if (k === 'dup') duplicateSelected();
        else if (k === 'offset') openOffsetModal();
        else if (k === 'array') openArrayModal();
      };
    });
    bar.querySelector('[data-sheet-redo]').onclick = redo;
    bar.querySelector('[data-sheet-undo]').onclick = undo;
    bar.querySelector('[data-sheet-fit]').onclick = function () { sizeCanvas(true); repaint(); };
    refreshToolbar();
    updateHint();
  }
  function toggleBtn(key, glyph, title) {
    return '<button data-sheet-toggle="' + key + '" title="' + esc(title) + '" ' +
      'style="width:42px;height:34px;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;font-size:15px;cursor:pointer;">' + glyph + '</button>';
  }
  function refreshToolbar() {
    var bar = S.overlay.querySelector('#p86-sheet-tools');
    bar.querySelectorAll('[data-sheet-tool]').forEach(function (b) {
      var on = b.getAttribute('data-sheet-tool') === S.tool;
      b.style.background = on ? 'rgba(251,191,36,0.12)' : 'rgba(255,255,255,0.05)';
      b.style.color = on ? '#fbbf24' : '#ddd';
      b.style.borderColor = on ? '#fbbf24' : '#444';
    });
    refreshStatusBar();
  }
  // AutoCAD-style bottom status bar: mode-toggle chips + view + zoom.
  function refreshStatusBar() {
    if (!S || !S.overlay) return;
    S.overlay.querySelectorAll('[data-sb-toggle]').forEach(function (b) {
      var k = b.getAttribute('data-sb-toggle');
      var on = (k === 'ortho' && S.ortho) || (k === 'grid' && S.gridSnap) || (k === 'osnap' && S.objSnap);
      b.style.background = on ? 'rgba(79,140,255,0.22)' : 'rgba(255,255,255,0.05)';
      b.style.color = on ? '#93c5fd' : '#9aa';
      b.style.borderColor = on ? '#4f8cff' : '#444';
    });
    var v = S.overlay.querySelector('#p86-sb-view');
    if (v) { var avp = S.hoverVp || (S.doc.viewports && S.doc.viewports[0]); v.textContent = avp ? (avp.label + '  ·  ' + (avp.scale && avp.scale.label ? avp.scale.label : '')) : ''; }
    var z = S.overlay.querySelector('#p86-sb-zoom');
    if (z) z.textContent = Math.round((S.view.scale || 1) * 100) + '%';
  }
  function setTool(t) {
    if (S.draft) S.draft = null;             // cancel any in-progress draft
    S._filletA = null;                       // cancel a pending fillet pick
    hideDyn();
    S.tool = t;
    S.canvas.style.cursor = (t === 'pan') ? 'grab' : (t === 'select' ? 'default' : 'crosshair');
    refreshToolbar(); renderPicker(); updateHint(); repaint();
  }
  // Pattern / symbol picker shown when the hatch or symbol tool is active.
  function renderPicker() {
    var el = S.overlay.querySelector('#p86-sheet-picker');
    if (!el) return;
    function btn(active, key, label) {
      return '<button data-pick="' + key + '" style="padding:5px 9px;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;' +
        (active ? 'background:rgba(251,191,36,0.15);color:#fbbf24;border:1px solid #fbbf24;' : 'background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;') + '">' + esc(label) + '</button>';
    }
    if (S.tool === 'hatch') {
      el.style.display = 'flex';
      el.innerHTML = HATCH_PATTERNS.map(function (p) { return btn(p.key === S.hatchPattern, p.key, p.label); }).join('');
      el.querySelectorAll('[data-pick]').forEach(function (b) { b.onclick = function () { S.hatchPattern = b.getAttribute('data-pick'); renderPicker(); }; });
    } else if (S.tool === 'symbol') {
      el.style.display = 'flex';
      el.innerHTML = SYMBOLS.map(function (p) { return btn(p.key === S.symbolKind, p.key, p.label); }).join('');
      el.querySelectorAll('[data-pick]').forEach(function (b) { b.onclick = function () { S.symbolKind = b.getAttribute('data-pick'); renderPicker(); }; });
    } else {
      el.style.display = 'none';
    }
  }
  function updateHint() {
    var el = S.overlay.querySelector('#p86-sheet-hint');
    if (!el) return;
    var t = (TOOLS.filter(function (x) { return x.key === S.tool; })[0] || {}).label || '';
    el.textContent = t + '   ·   wheel = zoom, Space/middle-drag = pan';
  }

  // Stack all viewports as equal vertical bands in the drawing area
  // (above the titleblock) — gives Plan-top / Elevation-bottom layout
  // automatically as views are added.
  function layoutViewports(doc) {
    var s = doc.sheet, m = s.margin + 16;
    var tbH = Math.round(3 * DPI);
    var area = { x: m, y: m, w: s.w - m * 2, h: s.h - m * 2 - tbH - 16 };
    var n = doc.viewports.length || 1, gap = 16;
    var bandH = (area.h - gap * (n - 1)) / n;
    doc.viewports.forEach(function (vp, i) {
      vp.x = area.x; vp.y = area.y + i * (bandH + gap); vp.w = area.w; vp.h = bandH;
    });
  }
  function addViewport() {
    pushUndo();
    var n = S.doc.viewports.length;
    var pre = scalePreset(SETTINGS.scaleLabel);
    S.doc.viewports.push({
      id: uid('VP'), label: VIEW_LABELS[Math.min(n, VIEW_LABELS.length - 1)],
      x: 0, y: 0, w: 100, h: 100,
      scale: { pixelsPerInch: DPI * pre.f, unit: 'ft', label: pre.label }
    });
    layoutViewports(S.doc);
    buildLayers(); repaint();
  }
  function setViewportScale(vpId, preset) {
    var vp = (S.doc.viewports || []).filter(function (v) { return v.id === vpId; })[0];
    if (!vp) return;
    pushUndo();
    vp.scale = { pixelsPerInch: DPI * preset.f, unit: 'ft', label: preset.label };
    buildLayers(); repaint();
  }
  function applySheetSize(key) {
    var sz = SHEET_SIZES[key]; if (!sz) return;
    pushUndo();
    S.doc.sheet.size = key;
    S.doc.sheet.w = Math.round(sz.wIn * DPI);
    S.doc.sheet.h = Math.round(sz.hIn * DPI);
    layoutViewports(S.doc);
    sizeCanvas(true); buildLayers(); repaint();
  }
  function openTitleblockModal() {
    var tb = S.doc.titleblock || {};
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:5400;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    var fields = [['company', 'Company name (blank = use your org name)'], ['project', 'Project'], ['title', 'Sheet title'], ['client', 'Client'], ['scale', 'Scale note'], ['date', 'Date'], ['drawnBy', 'Drawn by'], ['sheetNo', 'Sheet #'], ['northDeg', 'North rotation (°)']];
    var box = document.createElement('div');
    box.style.cssText = 'background:#0f0f1e;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:440px;width:100%;max-height:88vh;overflow-y:auto;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
    box.innerHTML = '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:12px;">Titleblock</div>' +
      fields.map(function (f) {
        return '<label style="display:block;font-size:11px;color:#9aa;margin:8px 0 3px;">' + esc(f[1]) + '</label>' +
          '<input data-tb="' + f[0] + '" value="' + esc(tb[f[0]] != null ? tb[f[0]] : '') + '" style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:6px;padding:7px 10px;font-size:13px;outline:none;" />';
      }).join('') +
      '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#cbd5e1;margin-top:14px;cursor:pointer;">' +
        '<input type="checkbox" data-tb-showlogo ' + (tb.showLogo !== false ? 'checked' : '') + ' style="width:15px;height:15px;cursor:pointer;" /> Show company logo in titleblock' +
      '</label>' +
      '<div style="font-size:10.5px;color:#64748b;margin-top:5px;line-height:1.5;">Logo &amp; company name come from your org <b style="color:#9aa;">Branding kit</b> (Admin → Organization → Branding). ' +
        (S && S._logo ? '<span style="color:#34d399;">✓ Logo loaded.</span>' : 'No logo found — add one there and it appears here.') + '</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">' +
        '<button data-tb-cancel style="padding:8px 16px;background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>' +
        '<button data-tb-save style="padding:8px 16px;background:#4f8cff;color:#fff;border:1px solid #4f8cff;border-radius:6px;cursor:pointer;font-weight:700;">Save</button>' +
      '</div>';
    ov.appendChild(box); document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    box.querySelector('[data-tb-cancel]').onclick = close;
    box.querySelector('[data-tb-save]').onclick = function () {
      pushUndo();
      box.querySelectorAll('[data-tb]').forEach(function (inp) { S.doc.titleblock[inp.getAttribute('data-tb')] = inp.value; });
      S.doc.titleblock.northDeg = parseFloat(S.doc.titleblock.northDeg) || 0;
      var cb = box.querySelector('[data-tb-showlogo]'); if (cb) S.doc.titleblock.showLogo = cb.checked;
      close(); repaint();
    };
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  }

  // ── Settings / defaults (E5) ────────────────────────────────────
  function openSettingsModal() {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:5400;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#0f0f1e;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:400px;width:100%;max-height:88vh;overflow-y:auto;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
    var selCss = 'width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:6px;padding:7px 10px;font-size:13px;outline:none;';
    var labCss = 'display:block;font-size:11px;color:#9aa;margin:10px 0 3px;';
    function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>'; }
    function cb(key, label, on) {
      return '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#cbd5e1;margin-top:7px;cursor:pointer;">' +
        '<input type="checkbox" data-st-cb="' + key + '" ' + (on ? 'checked' : '') + ' style="width:15px;height:15px;cursor:pointer;" /> ' + esc(label) + '</label>';
    }
    box.innerHTML =
      '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:4px;">⚙ Editor settings</div>' +
      '<div style="font-size:10.5px;color:#64748b;margin-bottom:8px;line-height:1.45;">Scale &amp; sheet size apply to <b style="color:#9aa;">new</b> drawings. Units, grid &amp; snaps apply right now.</div>' +
      '<label style="' + labCss + '">Units</label>' +
      '<select data-st="unit" style="' + selCss + '">' + opt('ft-in', "Feet & inches  (12' 6\")", SETTINGS.unit !== 'ft') + opt('ft', "Decimal feet  (12.5')", SETTINGS.unit === 'ft') + '</select>' +
      '<label style="' + labCss + '">Default scale (new drawings)</label>' +
      '<select data-st="scaleLabel" style="' + selCss + '">' + SCALE_PRESETS.map(function (p) { return opt(p.label, p.label, p.label === SETTINGS.scaleLabel); }).join('') + '</select>' +
      '<label style="' + labCss + '">Default sheet size (new drawings)</label>' +
      '<select data-st="sheetSize" style="' + selCss + '">' + Object.keys(SHEET_SIZES).map(function (k) { return opt(k, SHEET_SIZES[k].label, k === SETTINGS.sheetSize); }).join('') + '</select>' +
      '<label style="' + labCss + '">Grid spacing (ft)</label>' +
      '<input data-st="gridFt" value="' + esc(SETTINGS.gridFt) + '" inputmode="decimal" style="' + selCss + '" />' +
      '<label style="' + labCss + '">Default dimension color</label>' +
      '<input type="color" data-st="dimColor" value="' + esc(SETTINGS.dimColor || '#b45309') + '" style="width:46px;height:32px;border:0;background:transparent;cursor:pointer;" />' +
      '<div style="font-weight:700;color:#fff;margin:14px 0 2px;">Default snaps</div>' +
      cb('ortho', 'Ortho lock (0 / 45 / 90°)', !!SETTINGS.ortho) +
      cb('gridSnap', 'Snap to grid', SETTINGS.gridSnap !== false) +
      cb('osnap', 'Object snap (end / mid / center / intersect)', SETTINGS.osnap !== false) +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">' +
        '<button data-st-cancel style="padding:8px 16px;background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>' +
        '<button data-st-save style="padding:8px 16px;background:#4f8cff;color:#fff;border:1px solid #4f8cff;border-radius:6px;cursor:pointer;font-weight:700;">Save defaults</button>' +
      '</div>';
    ov.appendChild(box); document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    box.querySelector('[data-st-cancel]').onclick = close;
    box.querySelector('[data-st-save]').onclick = function () {
      box.querySelectorAll('[data-st]').forEach(function (el) {
        var k = el.getAttribute('data-st');
        SETTINGS[k] = (k === 'gridFt') ? (Math.max(0.25, Math.min(100, parseFloat(el.value) || 1))) : el.value;
      });
      box.querySelectorAll('[data-st-cb]').forEach(function (el) { SETTINGS[el.getAttribute('data-st-cb')] = el.checked; });
      saveSettings();
      // Apply the live-affecting settings to the current session immediately.
      S.ortho = !!SETTINGS.ortho; S.gridSnap = SETTINGS.gridSnap !== false; S.objSnap = SETTINGS.osnap !== false;
      refreshStatusBar(); buildLayers(); repaint();
      close();
    };
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  }

  function buildLayers() {
    var host = S.overlay.querySelector('#p86-sheet-layers');
    // ── Sheet section ──
    var html = '';
    // ── Properties (selected object) ──
    var selEnt = S.selectedId ? selectedEntity() : null;
    if (selEnt) {
      var TOOL_NAMES = { line: 'Line', polyline: 'Polyline', rect: 'Rectangle', ellipse: 'Circle', text: 'Text', measure: 'Dimension', mangle: 'Angle', arrow: 'Leader', hatch: 'Hatch', symbol: 'Symbol' };
      html += '<div style="border:1px solid #4f8cff;background:rgba(79,140,255,0.08);border-radius:8px;padding:8px 9px;margin-bottom:12px;">' +
        '<div style="font-weight:700;color:#fff;margin-bottom:6px;display:flex;align-items:center;gap:6px;">⛶ ' + esc(TOOL_NAMES[selEnt.tool] || selEnt.tool) +
          '<button data-prop-del style="margin-left:auto;background:transparent;border:0;color:#f87171;cursor:pointer;font-size:12px;">✕ Delete</button></div>' +
        '<label style="display:block;font-size:10px;color:#9aa;margin-bottom:2px;">Layer</label>' +
        '<select data-prop-layer style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:5px;padding:4px 6px;font-size:11px;">' +
          (S.doc.layers || []).map(function (l) { return '<option value="' + esc(l.id) + '"' + (l.id === selEnt.layer ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('') +
        '</select>' +
        '<div style="display:flex;gap:8px;margin-top:6px;font-size:10.5px;color:#9aa;">' +
          '<span>Color <span style="display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:middle;background:' + esc(selEnt.color || '#888') + ';border:1px solid rgba(255,255,255,0.3);"></span></span>' +
          '<span>Weight ' + (selEnt.lineWidth || 2) + 'px</span>' +
        '</div>' +
        '<div style="margin-top:5px;font-size:9.5px;color:#64748b;">Drag to move · ⟳ rotate · ⇆⇅ mirror · Ctrl+D dup</div>' +
      '</div>';
    }
    html += '<div style="font-weight:700;color:#fff;margin-bottom:6px;">Sheet</div>';
    html += '<select data-sheet-size style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:6px;padding:5px 7px;font-size:11.5px;margin-bottom:6px;">' +
      Object.keys(SHEET_SIZES).map(function (k) {
        return '<option value="' + k + '"' + (S.doc.sheet.size === k ? ' selected' : '') + '>' + esc(SHEET_SIZES[k].label) + '</option>';
      }).join('') + '</select>';
    html += '<button data-tb-edit style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;padding:6px;font-size:11.5px;cursor:pointer;margin-bottom:12px;">✎ Edit titleblock…</button>';
    // ── Views section ──
    html += '<div style="display:flex;align-items:center;margin-bottom:6px;">' +
      '<span style="font-weight:700;color:#fff;flex:1;">Views</span>' +
      '<button data-vp-add title="Add view (Plan / Elevation / Section)" style="background:rgba(34,197,94,0.15);color:#86efac;border:1px solid #22c55e;border-radius:5px;width:22px;height:22px;cursor:pointer;font-size:14px;line-height:1;">+</button>' +
    '</div>';
    html += (S.doc.viewports || []).map(function (vp) {
      return '<div style="border:1px solid #333;border-radius:6px;padding:5px 6px;margin-bottom:5px;">' +
        '<div style="display:flex;align-items:center;gap:4px;">' +
          '<span data-vp-name="' + esc(vp.id) + '" title="Double-click to rename" style="flex:1;color:#cbd5e1;font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(vp.label) + '</span>' +
          ((S.doc.viewports.length > 1) ? '<button data-vp-del="' + esc(vp.id) + '" title="Delete view" style="background:transparent;border:0;color:#f87171;cursor:pointer;font-size:11px;width:14px;">✕</button>' : '') +
        '</div>' +
        '<select data-vp-scale="' + esc(vp.id) + '" style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#9aa;border:1px solid #444;border-radius:5px;padding:3px 5px;font-size:10.5px;margin-top:3px;">' +
          SCALE_PRESETS.map(function (p) {
            var sel = (vp.scale && Math.abs(vp.scale.pixelsPerInch - DPI * p.f) < 1e-6) ? ' selected' : '';
            return '<option value="' + esc(p.label) + '"' + sel + '>' + esc(p.label) + '</option>';
          }).join('') + '</select>' +
      '</div>';
    }).join('');
    // ── Layers section ──
    html += '<div style="display:flex;align-items:center;margin:12px 0 8px;">' +
      '<span style="font-weight:700;color:#fff;flex:1;">Layers</span>' +
      '<button data-layer-add title="Add layer" style="background:rgba(79,140,255,0.15);color:#93c5fd;border:1px solid #4f8cff;border-radius:5px;width:22px;height:22px;cursor:pointer;font-size:14px;line-height:1;">+</button>' +
    '</div>';
    html += (S.doc.layers || []).map(function (l) {
      var active = l.id === S.activeLayer;
      return '<div data-layer-row="' + esc(l.id) + '" style="display:flex;align-items:center;gap:5px;padding:5px 6px;border-radius:6px;cursor:pointer;margin-bottom:2px;' +
        (active ? 'background:rgba(79,140,255,0.15);border:1px solid #4f8cff;' : 'border:1px solid transparent;') + '">' +
        '<button data-layer-vis="' + esc(l.id) + '" title="Show/hide" style="background:transparent;border:0;cursor:pointer;font-size:12px;width:16px;color:' + (l.visible === false ? '#555' : '#9aa') + ';">' + (l.visible === false ? '◌' : '●') + '</button>' +
        '<button data-layer-color="' + esc(l.id) + '" title="Recolor" style="width:13px;height:13px;border-radius:3px;flex:0 0 auto;background:' + esc(l.color) + ';border:1px solid rgba(255,255,255,0.3);cursor:pointer;padding:0;"></button>' +
        '<span data-layer-name="' + esc(l.id) + '" title="Double-click to rename" style="flex:1;color:' + (active ? '#fff' : '#cbd5e1') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(l.name) + '</span>' +
        '<span style="font-size:9.5px;color:#64748b;">' + (l.weight || 2) + 'px</span>' +
        ((S.doc.layers.length > 1) ? '<button data-layer-del="' + esc(l.id) + '" title="Delete layer (objects move to first layer)" style="background:transparent;border:0;color:#f87171;cursor:pointer;font-size:12px;width:14px;">✕</button>' : '') +
      '</div>';
    }).join('');
    html += '<div style="margin-top:10px;font-size:10.5px;color:#64748b;line-height:1.4;">Click = draw on it · dbl-click name = rename · swatch = color · ✕ = delete.</div>';
    host.innerHTML = html;
    // Properties wiring (selected object)
    var propLayer = host.querySelector('[data-prop-layer]');
    if (propLayer) propLayer.onchange = function () {
      var e = selectedEntity(); if (!e) return;
      pushUndo();
      e.layer = propLayer.value;
      var l = layerById(S.doc, e.layer);
      if (e.tool !== 'measure') { e.color = l.color; e.lineWidth = l.weight || e.lineWidth; }
      buildLayers(); repaint();
    };
    var propDel = host.querySelector('[data-prop-del]');
    if (propDel) propDel.onclick = deleteSelected;
    // Sheet + Views wiring
    var sizeSel = host.querySelector('[data-sheet-size]');
    if (sizeSel) sizeSel.onchange = function () { applySheetSize(sizeSel.value); };
    host.querySelector('[data-tb-edit]').onclick = openTitleblockModal;
    host.querySelector('[data-vp-add]').onclick = addViewport;
    host.querySelectorAll('[data-vp-name]').forEach(function (s) {
      s.ondblclick = function () {
        var id = s.getAttribute('data-vp-name');
        var vp = S.doc.viewports.filter(function (v) { return v.id === id; })[0];
        var nm = window.prompt('View label:', vp.label);
        if (nm != null && nm.trim()) { pushUndo(); vp.label = nm.trim().slice(0, 40); buildLayers(); repaint(); }
      };
    });
    host.querySelectorAll('[data-vp-del]').forEach(function (b) {
      b.onclick = function () {
        if (S.doc.viewports.length <= 1) return;
        if (!window.confirm('Delete this view? Its drawn objects remain but lose their frame.')) return;
        pushUndo();
        S.doc.viewports = S.doc.viewports.filter(function (v) { return v.id !== b.getAttribute('data-vp-del'); });
        layoutViewports(S.doc); buildLayers(); repaint();
      };
    });
    host.querySelectorAll('[data-vp-scale]').forEach(function (sel) {
      sel.onchange = function () {
        var preset = SCALE_PRESETS.filter(function (p) { return p.label === sel.value; })[0];
        if (preset) setViewportScale(sel.getAttribute('data-vp-scale'), preset);
      };
    });
    host.querySelector('[data-layer-add]').onclick = function () {
      pushUndo();
      var n = S.doc.layers.length;
      S.doc.layers.push({ id: uid('L'), name: 'Layer ' + (n + 1), color: '#2563eb', weight: 2, lineType: 'solid', visible: true, locked: false });
      S.activeLayer = S.doc.layers[S.doc.layers.length - 1].id;
      buildLayers();
    };
    host.querySelectorAll('[data-layer-row]').forEach(function (r) {
      r.onclick = function (e) {
        var t = e.target.getAttribute ? e.target : null;
        if (t && (t.getAttribute('data-layer-vis') || t.getAttribute('data-layer-color') || t.getAttribute('data-layer-del'))) return;
        S.activeLayer = r.getAttribute('data-layer-row'); buildLayers();
      };
    });
    host.querySelectorAll('[data-layer-vis]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); var l = layerById(S.doc, b.getAttribute('data-layer-vis')); l.visible = (l.visible === false); buildLayers(); repaint(); };
    });
    host.querySelectorAll('[data-layer-name]').forEach(function (s) {
      s.ondblclick = function (e) {
        e.stopPropagation();
        var l = layerById(S.doc, s.getAttribute('data-layer-name'));
        var nm = window.prompt('Layer name:', l.name);
        if (nm != null && nm.trim()) { pushUndo(); l.name = nm.trim().slice(0, 40); buildLayers(); }
      };
    });
    host.querySelectorAll('[data-layer-color]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var l = layerById(S.doc, b.getAttribute('data-layer-color'));
        var col = window.prompt('Layer color (hex, e.g. #1f2937):', l.color);
        if (col && /^#?[0-9a-fA-F]{3,8}$/.test(col.trim())) {
          pushUndo();
          l.color = col.trim().charAt(0) === '#' ? col.trim() : '#' + col.trim();
          // recolor existing entities on this layer
          (S.doc.entities || []).forEach(function (en) { if (en.layer === l.id) en.color = l.color; });
          buildLayers(); repaint();
        }
      };
    });
    host.querySelectorAll('[data-layer-del]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var id = b.getAttribute('data-layer-del');
        if (S.doc.layers.length <= 1) return;
        if (!window.confirm('Delete this layer? Its objects move to the first layer.')) return;
        pushUndo();
        var fallback = S.doc.layers.filter(function (l) { return l.id !== id; })[0];
        (S.doc.entities || []).forEach(function (en) { if (en.layer === id) { en.layer = fallback.id; en.color = fallback.color; } });
        S.doc.layers = S.doc.layers.filter(function (l) { return l.id !== id; });
        if (S.activeLayer === id) S.activeLayer = fallback.id;
        buildLayers(); repaint();
      };
    });
  }

  // ── Coordinate transforms ───────────────────────────────────────
  function toSheet(sx, sy) { return { x: (sx - S.view.tx) / S.view.scale, y: (sy - S.view.ty) / S.view.scale }; }
  function toScreen(x, y) { return { x: x * S.view.scale + S.view.tx, y: y * S.view.scale + S.view.ty }; }
  function localPt(e) {
    var r = S.canvas.getBoundingClientRect();
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    // Map to CSS px (the space the view transform works in), not the
    // dpr-scaled backing store.
    var cw = S.cssW || S.canvas.width, ch = S.cssH || S.canvas.height;
    return { x: (cx - r.left) * (cw / r.width), y: (cy - r.top) * (ch / r.height) };
  }
  function vpAt(pt) {
    var vps = S.doc.viewports || [];
    for (var i = 0; i < vps.length; i++) {
      var v = vps[i];
      if (pt.x >= v.x && pt.x <= v.x + v.w && pt.y >= v.y && pt.y <= v.y + v.h) return v;
    }
    return vps[0] || null;
  }

  // ── Snapping ────────────────────────────────────────────────────
  // Collect endpoint / midpoint / center candidates from entities in the
  // given viewport (sheet coords).
  function snapCandidates(vp) {
    var out = [];
    if (!vp) return out;
    (S.doc.entities || []).forEach(function (e) {
      if (!e || e.viewport !== vp.id) return;
      if (e.startX != null) {
        out.push({ x: e.startX, y: e.startY, kind: 'end' });
        out.push({ x: e.endX, y: e.endY, kind: 'end' });
        out.push({ x: (e.startX + e.endX) / 2, y: (e.startY + e.endY) / 2, kind: 'mid' });
        if (e.tool === 'rect' || e.tool === 'ellipse') {
          out.push({ x: (e.startX + e.endX) / 2, y: (e.startY + e.endY) / 2, kind: 'center' });
          out.push({ x: e.startX, y: e.endY, kind: 'end' });
          out.push({ x: e.endX, y: e.startY, kind: 'end' });
        }
      } else if (e.points && e.points.length) {
        e.points.forEach(function (p, i) {
          out.push({ x: p.x, y: p.y, kind: 'end' });
          if (i > 0) {
            var a = e.points[i - 1];
            out.push({ x: (a.x + p.x) / 2, y: (a.y + p.y) / 2, kind: 'mid' });
          }
        });
      } else if (e.x != null) {
        out.push({ x: e.x, y: e.y, kind: 'end' });
      }
    });
    // Intersection snaps (line × line / polyline / rect edges). O(n²) over
    // segments — capped so a dense sheet doesn't stall the snap on hover.
    var segs = segmentsInVp(vp);
    if (segs.length <= 80) {
      for (var i = 0; i < segs.length; i++) for (var j = i + 1; j < segs.length; j++) {
        var ix = segIntersect(segs[i], segs[j]);
        if (ix) out.push({ x: ix.x, y: ix.y, kind: 'intersect' });
      }
    }
    return out;
  }
  // Flatten drawable line segments in a viewport (for intersection snaps).
  function segmentsInVp(vp, excludeId) {
    var segs = [];
    (S.doc.entities || []).forEach(function (e) {
      if (!e || e.viewport !== vp.id) return;
      if (excludeId && e.id === excludeId) return;
      if (e.tool === 'line' && e.startX != null) {
        segs.push({ a: { x: e.startX, y: e.startY }, b: { x: e.endX, y: e.endY } });
      } else if (e.tool === 'rect' && e.startX != null) {
        var c = [{ x: e.startX, y: e.startY }, { x: e.endX, y: e.startY }, { x: e.endX, y: e.endY }, { x: e.startX, y: e.endY }];
        for (var k = 0; k < 4; k++) segs.push({ a: c[k], b: c[(k + 1) % 4] });
      } else if ((e.tool === 'polyline') && e.points && e.points.length > 1) {
        for (var p = 1; p < e.points.length; p++) segs.push({ a: e.points[p - 1], b: e.points[p] });
      }
    });
    return segs;
  }
  // Intersection point of two segments, or null if they don't cross.
  function segIntersect(s1, s2) {
    var x1 = s1.a.x, y1 = s1.a.y, x2 = s1.b.x, y2 = s1.b.y;
    var x3 = s2.a.x, y3 = s2.a.y, x4 = s2.b.x, y4 = s2.b.y;
    var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    var t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    var u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
    if (t < -0.001 || t > 1.001 || u < -0.001 || u > 1.001) return null;
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }
  // Resolve the snapped sheet-point for a raw cursor sheet-point.
  function resolveSnap(raw, vp) {
    var radiusSheet = SNAP_SCREEN / S.view.scale;
    var best = null, bestD = radiusSheet;
    if (S.objSnap && vp) {
      snapCandidates(vp).forEach(function (c) {
        var d = Math.hypot(c.x - raw.x, c.y - raw.y);
        if (d < bestD) { bestD = d; best = c; }
      });
    }
    if (best) return best;
    if (S.gridSnap && vp && vp.scale && vp.scale.pixelsPerInch) {
      var step = vp.scale.pixelsPerInch * 12 * (SETTINGS.gridFt || 1);   // grid spacing, sheet px
      var gx = Math.round((raw.x - vp.x) / step) * step + vp.x;
      var gy = Math.round((raw.y - vp.y) / step) * step + vp.y;
      return { x: gx, y: gy, kind: 'grid' };
    }
    return { x: raw.x, y: raw.y, kind: null };
  }
  // Constrain a point to ortho/45° relative to an anchor.
  function applyOrtho(anchor, pt) {
    if (!(S.ortho || S.shiftDown)) return pt;
    var dx = pt.x - anchor.x, dy = pt.y - anchor.y;
    var ang = Math.atan2(dy, dx);
    var step = Math.PI / 4;                      // 45°
    var snapped = Math.round(ang / step) * step;
    var len = Math.hypot(dx, dy);
    return { x: anchor.x + Math.cos(snapped) * len, y: anchor.y + Math.sin(snapped) * len, kind: pt.kind };
  }

  // ── Real-world readout ──────────────────────────────────────────
  function realLen(sheetPx, vp) {
    if (!vp || !vp.scale || !vp.scale.pixelsPerInch) return null;
    return sheetPx / vp.scale.pixelsPerInch;     // inches
  }
  // Unit-aware length formatter (respects the Settings unit choice).
  function fmtLen(inches) {
    if (SETTINGS.unit === 'ft') return (Math.round(inches / 12 * 100) / 100) + "'";
    var f = prims().formatFeetInches;
    return f ? f(inches) : (Math.round(inches / 12 * 100) / 100) + "'";
  }
  function fmtFeet(inches) { return fmtLen(inches); }
  function updateReadout(sheetPt, vp) {
    var coords = S.overlay.querySelector('#p86-sb-coords');
    var snapEl = S.overlay.querySelector('#p86-sb-snap');
    if (coords) {
      if (!vp) { coords.textContent = '(outside view)'; }
      else {
        var rx = realLen(sheetPt.x - vp.x, vp), ry = realLen(sheetPt.y - vp.y, vp);
        var txt = (rx != null) ? ('x ' + fmtFeet(rx) + '   y ' + fmtFeet(ry)) : '';
        if (S.draft && S.draft._anchor) {
          var a = S.draft._anchor;
          var len = realLen(Math.hypot(sheetPt.x - a.x, sheetPt.y - a.y), vp);
          var deg = Math.round(Math.atan2(-(sheetPt.y - a.y), sheetPt.x - a.x) * 180 / Math.PI);
          if (len != null) txt += '    Δ ' + fmtFeet(len) + ' @ ' + deg + '°';
        }
        coords.textContent = txt;
      }
    }
    if (snapEl) snapEl.textContent = (S.snap && S.snap.kind) ? ('⊹ ' + S.snap.kind) : '';
    refreshStatusBar();
  }

  // ── Input handling ──────────────────────────────────────────────
  function wireInput() {
    var c = S.canvas;
    c.onmousedown = function (e) {
      e.preventDefault();
      var lp = localPt(e);
      // Pan: middle button, space-pan, or pan tool
      if (e.button === 1 || S.spaceDown || S.tool === 'pan') {
        S.panning = { sx: lp.x, sy: lp.y, tx: S.view.tx, ty: S.view.ty };
        c.style.cursor = 'grabbing';
        return;
      }
      var raw = toSheet(lp.x, lp.y);
      var vp = vpAt(raw);
      var pt = resolveSnap(raw, vp);
      if (S.draft && S.draft._anchor) pt = applyOrtho(S.draft._anchor, pt);

      if (S.tool === 'select') {
        // Grip-drag: if the cursor is on a grip of the current selection,
        // reshape that point (or move the whole entity for a 'move' grip).
        var grip = gripAtScreen(lp);
        if (grip) { S.gripDrag = { gi: grip.gi, type: grip.type, last: raw, pushed: false }; return; }
        selectAt(raw);
        // Arm a move-drag if we landed on an entity (commit to history on
        // first actual movement, so a plain click just selects).
        if (S.selectedId) S.moveDrag = { last: raw, pushed: false };
        return;
      }
      if (S.tool === 'text') { placeText(pt, vp); return; }
      handleDrawClick(pt, vp);
    };
    c.onmousemove = function (e) {
      var lp = localPt(e);
      if (S.panning) {
        S.view.tx = S.panning.tx + (lp.x - S.panning.sx);
        S.view.ty = S.panning.ty + (lp.y - S.panning.sy);
        repaint();
        return;
      }
      // Grip-drag the selected entity's handle (select tool, button held).
      if (S.gripDrag && (e.buttons & 1)) {
        var gent = selectedEntity();
        if (gent) {
          if (!S.gripDrag.pushed) { pushUndo(); S.gripDrag.pushed = true; }
          var graw = toSheet(lp.x, lp.y);
          var gvp = vpAt(graw);
          var gpt = resolveSnap(graw, gvp);
          var ghs = entGripHandles(gent), gh = ghs[S.gripDrag.gi];
          if (gh) {
            if (S.gripDrag.type === 'move') {
              translateEntity(gent, graw.x - S.gripDrag.last.x, graw.y - S.gripDrag.last.y);
              S.gripDrag.last = graw;
            } else {
              var gp = gh.anchor ? applyOrtho(gh.anchor, gpt) : gpt;
              gh.apply(gp.x, gp.y);
            }
            S.snap = gpt; S.hover = gpt; S.hoverVp = gvp;
            updateReadout(gpt, gvp);
            repaint();
          }
        }
        return;
      }
      // Move-drag the selected entity (select tool, button held).
      if (S.moveDrag && (e.buttons & 1)) {
        var ent = selectedEntity();
        if (ent) {
          if (!S.moveDrag.pushed) { pushUndo(); S.moveDrag.pushed = true; }
          var ds = toSheet(lp.x, lp.y);
          translateEntity(ent, ds.x - S.moveDrag.last.x, ds.y - S.moveDrag.last.y);
          S.moveDrag.last = ds;
          repaint();
        }
        return;
      }
      var raw = toSheet(lp.x, lp.y);
      var vp = vpAt(raw);
      var pt = resolveSnap(raw, vp);
      if (S.draft && S.draft._anchor) pt = applyOrtho(S.draft._anchor, pt);
      S.hover = pt; S.snap = pt; S.hoverVp = vp;
      // Grip hover affordance in the select tool.
      if (S.tool === 'select' && S.selectedId) {
        S.canvas.style.cursor = gripAtScreen(lp) ? 'pointer' : 'default';
      }
      updateReadout(pt, vp);
      if (dynApplies()) updateDynLive();
      repaint();
    };
    c.onmouseup = function () {
      if (S.panning) { S.panning = null; S.canvas.style.cursor = (S.tool === 'pan') ? 'grab' : (S.tool === 'select' ? 'default' : 'crosshair'); }
      S.moveDrag = null; S.gripDrag = null;
    };
    c.ondblclick = function () {
      if ((S.tool === 'polyline' || S.tool === 'hatch') && S.draft) commitPolyline();
    };
    c.onwheel = function (e) {
      e.preventDefault();
      var lp = localPt(e);
      var before = toSheet(lp.x, lp.y);
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      S.view.scale = Math.max(0.02, Math.min(8, S.view.scale * factor));
      // keep cursor anchored
      S.view.tx = lp.x - before.x * S.view.scale;
      S.view.ty = lp.y - before.y * S.view.scale;
      repaint();
    };
    S.overlay.onkeydown = function (e) {
      // Don't fire canvas shortcuts while typing in a field (dynamic
      // input, titleblock modal, etc.) — those inputs handle their own keys.
      var tn = e.target && e.target.tagName;
      if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') return;
      if (e.key === 'Shift') { S.shiftDown = true; }
      else if (e.key === ' ') { S.spaceDown = true; S.canvas.style.cursor = 'grab'; }
      else if (e.key === 'Escape') {
        if (S._filletA) { S._filletA = null; updateHint(); repaint(); }
        else if (S.draft) { S.draft = null; hideDyn(); repaint(); }
        else S.overlay.querySelector('#p86-sheet-cancel').click();
      }
      else if (e.key === 'Enter') { if ((S.tool === 'polyline' || S.tool === 'hatch') && S.draft) commitPolyline(); }
      else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.key === 'y' || e.key === 'Y') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); redo(); }
      else if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicateSelected(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selectedId) { deleteSelected(); }
      else if (e.key === 'l' || e.key === 'L') setTool('line');
      else if (e.key === 'r' || e.key === 'R') setTool('rect');
      else if (e.key === 'p' || e.key === 'P') setTool('polyline');
      else if (e.key === 'c' || e.key === 'C') setTool('circle');
      else if (e.key === 'a' || e.key === 'A') setTool('arc');
      else if (e.key === 'd' || e.key === 'D') setTool('dim');
    };
    S.overlay.onkeyup = function (e) {
      if (e.key === 'Shift') S.shiftDown = false;
      else if (e.key === ' ') { S.spaceDown = false; S.canvas.style.cursor = (S.tool === 'pan') ? 'grab' : (S.tool === 'select' ? 'default' : 'crosshair'); }
    };
    // Dynamic-input keys: Enter commits the segment at the typed length/
    // angle; Esc cancels the draft. (stopPropagation so the canvas
    // shortcuts above never see these keystrokes.)
    var dyn = dynEl();
    if (dyn) {
      dyn.querySelectorAll('input').forEach(function (inp) {
        inp.onkeydown = function (e) {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitDyn(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); S.draft = null; hideDyn(); repaint(); S.overlay.focus(); }
        };
      });
    }
  }

  function newEntity(tool, vp) {
    var l = layerById(S.doc, S.activeLayer);
    return { id: uid(tool), tool: tool, viewport: vp ? vp.id : (S.doc.viewports[0] || {}).id,
      layer: S.activeLayer, color: l.color, lineWidth: l.weight || 3 };
  }
  // Dimensions prefer the "Dimensions" layer (amber) if one exists.
  function dimLayerId() {
    var ls = S.doc.layers || [];
    for (var i = 0; i < ls.length; i++) if ((ls[i].name || '').toLowerCase() === 'dimensions') return ls[i].id;
    return S.activeLayer;
  }

  function handleDrawClick(pt, vp) {
    var t = S.tool;
    // CAD modify tools (pick existing lines, not draw).
    if (t === 'trim') { trimAt(pt, vp); return; }
    if (t === 'extend') { extendAt(pt, vp); return; }
    if (t === 'fillet') { filletClick(pt, vp); return; }
    // Dimension — a two-point 'measure' entity; its label is computed
    // live from the viewport scale in renderSheet (auto-updates).
    if (t === 'dim') {
      if (!S.draft) {
        var de = newEntity('measure', vp);
        de.layer = dimLayerId();
        var dl = layerById(S.doc, de.layer);
        de.color = dl.color; de.lineWidth = dl.weight || 2;
        de.startX = pt.x; de.startY = pt.y; de.endX = pt.x; de.endY = pt.y;
        de._anchor = { x: pt.x, y: pt.y };
        S.draft = de;
      } else { finalizeTwoPoint(pt); }
      repaint(); return;
    }
    // Angle dimension — three points (leg · vertex · leg) via 'mangle'.
    if (t === 'angle') {
      if (!S.draft) {
        var ae = newEntity('mangle', vp);
        ae.layer = dimLayerId(); ae.color = layerById(S.doc, ae.layer).color;
        ae.points = [{ x: pt.x, y: pt.y }]; ae._anchor = { x: pt.x, y: pt.y };
        S.draft = ae;
      } else {
        S.draft.points.push({ x: pt.x, y: pt.y });
        S.draft._anchor = { x: pt.x, y: pt.y };
        if (S.draft.points.length >= 3) { var a = S.draft; delete a._anchor; commitEntity(a); S.draft = null; }
      }
      repaint(); return;
    }
    // Arc — 3-point (start · point-on-arc · end).
    if (t === 'arc') {
      if (!S.draft) {
        var arcE = newEntity('arc', vp);
        arcE.points = [{ x: pt.x, y: pt.y }]; arcE._anchor = { x: pt.x, y: pt.y };
        S.draft = arcE;
      } else {
        S.draft.points.push({ x: pt.x, y: pt.y });
        S.draft._anchor = { x: pt.x, y: pt.y };
        if (S.draft.points.length >= 3) { var ar = S.draft; delete ar._anchor; commitEntity(ar); S.draft = null; }
      }
      repaint(); return;
    }
    // Leader — arrow to a target, then a text callout at the elbow.
    if (t === 'leader') {
      if (!S.draft) {
        var le = newEntity('arrow', vp);
        le.startX = pt.x; le.startY = pt.y; le.endX = pt.x; le.endY = pt.y;
        le._anchor = { x: pt.x, y: pt.y };
        S.draft = le;
      } else { finalizeLeader(pt, vp); }
      repaint(); return;
    }
    // Hatch — accumulate a polygon (double-click / Enter closes + fills).
    if (t === 'hatch') {
      if (!S.draft) {
        var he = newEntity('hatch', vp);
        he.pattern = S.hatchPattern; he.points = [{ x: pt.x, y: pt.y }]; he._anchor = { x: pt.x, y: pt.y };
        S.draft = he;
      } else {
        S.draft.points.push({ x: pt.x, y: pt.y });
        S.draft._anchor = { x: pt.x, y: pt.y };
      }
      repaint(); return;
    }
    // Symbol — single click places the chosen block.
    if (t === 'symbol') {
      var se = newEntity('symbol', vp);
      se.kind = S.symbolKind; se.x = pt.x; se.y = pt.y; se.rotation = 0;
      se.size = Math.round((vp && vp.scale ? vp.scale.pixelsPerInch : 2.5) * 18);  // ~1.5 ft
      if (se.kind === 'callout') se.label = String(S._calloutNum++);
      commitEntity(se); repaint(); return;
    }
    if (t === 'line' || t === 'rect' || t === 'circle') {
      if (!S.draft) {
        var e = newEntity(t === 'circle' ? 'ellipse' : t, vp);
        e.startX = pt.x; e.startY = pt.y; e.endX = pt.x; e.endY = pt.y;
        e._anchor = { x: pt.x, y: pt.y }; e._circle = (t === 'circle');
        S.draft = e;
        if (t === 'line') showDyn();
      } else {
        finalizeTwoPoint(pt);
      }
    } else if (t === 'polyline') {
      if (!S.draft) {
        var pe = newEntity('polyline', vp);
        pe.points = [{ x: pt.x, y: pt.y }];
        pe._anchor = { x: pt.x, y: pt.y };
        S.draft = pe;
        showDyn();
      } else {
        S.draft.points.push({ x: pt.x, y: pt.y });
        S.draft._anchor = { x: pt.x, y: pt.y };
      }
    }
    repaint();
  }
  function finalizeTwoPoint(pt) {
    var d = S.draft;
    if (d._circle) {
      // center + radius point → bbox
      var r = Math.hypot(pt.x - d.startX, pt.y - d.startY);
      var cx = d.startX, cy = d.startY;
      d.startX = cx - r; d.startY = cy - r; d.endX = cx + r; d.endY = cy + r;
    } else { d.endX = pt.x; d.endY = pt.y; }
    if (Math.abs(d.endX - d.startX) < 0.5 && Math.abs(d.endY - d.startY) < 0.5) { S.draft = null; hideDyn(); return; }
    delete d._anchor; delete d._circle;
    commitEntity(d); S.draft = null; hideDyn();
  }
  function commitPolyline() {
    var d = S.draft;
    if (d && d.points && d.points.length >= 2) { delete d._anchor; commitEntity(d); }
    S.draft = null; hideDyn(); repaint();
  }

  // ── Dynamic input (direct distance entry) ───────────────────────
  // Shown for line/polyline once the first point is placed: type an exact
  // length (e.g. 10', 10' 6", 126") and optional angle, Enter to commit.
  function dynEl() { return S.overlay ? S.overlay.querySelector('#p86-sheet-dyn') : null; }
  function dynApplies() { return S.draft && S.draft._anchor && (S.tool === 'line' || S.tool === 'polyline'); }
  function clearDynFields() {
    var d = dynEl(); if (!d) return;
    var li = d.querySelector('[data-dyn-len]'), ai = d.querySelector('[data-dyn-ang]');
    if (li) li.value = ''; if (ai) ai.value = '';
  }
  function showDyn() {
    var d = dynEl(); if (!d) return;
    d.style.display = 'flex'; clearDynFields(); positionDyn();
    var li = d.querySelector('[data-dyn-len]'); if (li) setTimeout(function () { try { li.focus(); } catch (e) {} }, 0);
  }
  function hideDyn() { var d = dynEl(); if (d) d.style.display = 'none'; }
  function positionDyn() {
    var d = dynEl(); if (!d || d.style.display === 'none' || !S.draft || !S.draft._anchor) return;
    var ref = S.hover || S.draft._anchor;
    var sp = toScreen(ref.x, ref.y);   // canvas px ≈ container CSS px (canvas sized 1:1 to container)
    d.style.left = Math.max(4, sp.x + 18) + 'px';
    d.style.top = Math.max(4, sp.y + 14) + 'px';
  }
  function updateDynLive() {
    var d = dynEl(); if (!d || !dynApplies()) { hideDyn(); return; }
    if (d.style.display === 'none') showDyn();
    var a = S.draft._anchor, vp = vpAt(a) || S.hoverVp;
    var h = S.hover ? applyOrtho(a, S.hover) : a;
    var ppi = (vp && vp.scale && vp.scale.pixelsPerInch) ? vp.scale.pixelsPerInch : 1;
    var li = d.querySelector('[data-dyn-len]'), ai = d.querySelector('[data-dyn-ang]');
    if (li) li.placeholder = fmtFeet(Math.hypot(h.x - a.x, h.y - a.y) / ppi);
    if (ai) ai.placeholder = Math.round(Math.atan2(-(h.y - a.y), h.x - a.x) * 180 / Math.PI) + '°';
    positionDyn();
  }
  // Commit the current segment at the typed (or live) length + angle.
  function commitDyn() {
    var d = dynEl(); if (!d || !S.draft || !S.draft._anchor) return;
    var dr = S.draft, a = dr._anchor;
    var lenStr = (d.querySelector('[data-dyn-len]').value || '').trim();
    var angStr = (d.querySelector('[data-dyn-ang]').value || '').trim();
    var vp = vpAt(a) || S.hoverVp || (S.doc.viewports && S.doc.viewports[0]);
    var ppi = (vp && vp.scale && vp.scale.pixelsPerInch) ? vp.scale.pixelsPerInch : 1;
    // Direction: typed angle wins; else current (ortho-aware) cursor heading.
    var target = S.hover ? applyOrtho(a, S.hover) : { x: a.x + 1, y: a.y };
    var dirDeg = Math.atan2(-(target.y - a.y), target.x - a.x) * 180 / Math.PI;
    if (angStr !== '' && isFinite(parseFloat(angStr))) dirDeg = parseFloat(angStr);
    // Length: typed (parsed) wins; else live cursor distance.
    var lenIn;
    if (lenStr !== '') {
      var p = prims().parseMeasurement ? prims().parseMeasurement(lenStr, 'ft') : null;
      lenIn = p ? p.inches : (isFinite(parseFloat(lenStr)) ? parseFloat(lenStr) * 12 : null);
      if (lenIn == null) return;   // unparseable — leave the draft open
    } else {
      lenIn = Math.hypot(target.x - a.x, target.y - a.y) / ppi;
    }
    var lenPx = lenIn * ppi, rad = dirDeg * Math.PI / 180;
    var ex = a.x + lenPx * Math.cos(rad), ey = a.y - lenPx * Math.sin(rad);
    if (dr.tool === 'polyline') {
      dr.points.push({ x: ex, y: ey });
      dr._anchor = { x: ex, y: ey };
      clearDynFields();
      var li = d.querySelector('[data-dyn-len]'); if (li) li.focus();
      repaint();
      return;
    }
    // line (single segment)
    dr.endX = ex; dr.endY = ey;
    delete dr._anchor; delete dr._circle;
    commitEntity(dr); S.draft = null;
    hideDyn(); repaint();
  }
  function finalizeLeader(pt, vp) {
    var d = S.draft;
    d.endX = pt.x; d.endY = pt.y;
    if (Math.abs(d.endX - d.startX) < 0.5 && Math.abs(d.endY - d.startY) < 0.5) { S.draft = null; return; }
    delete d._anchor;
    pushUndo();
    S.doc.entities.push(d);          // the arrow
    S.draft = null;
    var txt = window.prompt('Leader text:');   // styled input is a polish follow-up
    if (txt) {
      var te = newEntity('text', vp);
      te.x = pt.x + 6; te.y = pt.y - (vp && vp.scale ? vp.scale.pixelsPerInch * 9 : 22);
      te.text = txt; te.fontPx = Math.round((vp && vp.scale ? vp.scale.pixelsPerInch : 2.5) * 9);
      S.doc.entities.push(te);
    }
  }
  function placeText(pt, vp) {
    var txt = window.prompt('Text:');       // D1: simple; styled input is a polish follow-up
    if (!txt) return;
    var e = newEntity('text', vp);
    e.x = pt.x; e.y = pt.y; e.text = txt; e.fontPx = Math.round((vp && vp.scale ? vp.scale.pixelsPerInch : 2.5) * 9);
    commitEntity(e); repaint();
  }
  function selectAt(raw) {
    var hit = null;
    for (var i = S.doc.entities.length - 1; i >= 0; i--) {
      var e = S.doc.entities[i];
      var bb = entBBox(e);
      var slop = 8 / S.view.scale;
      if (bb && raw.x >= bb.x - slop && raw.x <= bb.x + bb.w + slop && raw.y >= bb.y - slop && raw.y <= bb.y + bb.h + slop) { hit = e.id; break; }
    }
    S.selectedId = hit; buildLayers(); repaint();
  }
  function entBBox(e) {
    if (e.startX != null) return { x: Math.min(e.startX, e.endX), y: Math.min(e.startY, e.endY), w: Math.abs(e.endX - e.startX), h: Math.abs(e.endY - e.startY) };
    if (e.points && e.points.length) {
      var xs = e.points.map(function (p) { return p.x; }), ys = e.points.map(function (p) { return p.y; });
      var mnx = Math.min.apply(null, xs), mny = Math.min.apply(null, ys);
      return { x: mnx, y: mny, w: Math.max.apply(null, xs) - mnx, h: Math.max.apply(null, ys) - mny };
    }
    if (e.x != null) {
      if (e.tool === 'symbol') { var hs = (e.size || 40) / 2; return { x: e.x - hs, y: e.y - hs, w: hs * 2, h: hs * 2 }; }
      var fp = e.fontPx || 24; return { x: e.x, y: e.y, w: Math.max(8, (e.text || '').length * fp * 0.55), h: fp };
    }
    return null;
  }
  // Draggable grip handles for an entity. Each handle has {x,y,type} and,
  // for point grips, apply(nx,ny) to mutate that point + an optional ortho
  // anchor. 'move' grips translate the whole entity. Render reads x/y only.
  function entGripHandles(e) {
    var g = [];
    if (e.startX != null) {
      g.push({ x: e.startX, y: e.startY, type: 'pt', anchor: { x: e.endX, y: e.endY }, apply: function (nx, ny) { e.startX = nx; e.startY = ny; } });
      g.push({ x: e.endX, y: e.endY, type: 'pt', anchor: { x: e.startX, y: e.startY }, apply: function (nx, ny) { e.endX = nx; e.endY = ny; } });
      if (e.tool === 'rect' || e.tool === 'ellipse') {
        g.push({ x: e.startX, y: e.endY, type: 'pt', anchor: { x: e.endX, y: e.startY }, apply: function (nx, ny) { e.startX = nx; e.endY = ny; } });
        g.push({ x: e.endX, y: e.startY, type: 'pt', anchor: { x: e.startX, y: e.endY }, apply: function (nx, ny) { e.endX = nx; e.startY = ny; } });
      }
      g.push({ x: (e.startX + e.endX) / 2, y: (e.startY + e.endY) / 2, type: 'move' });
    } else if (e.points && e.points.length) {
      e.points.forEach(function (p, i) {
        var a = e.points[i - 1] || e.points[i + 1] || null;
        g.push({ x: p.x, y: p.y, type: 'pt', anchor: a ? { x: a.x, y: a.y } : null, apply: (function (idx) { return function (nx, ny) { e.points[idx].x = nx; e.points[idx].y = ny; }; })(i) });
      });
    } else if (e.x != null) {
      g.push({ x: e.x, y: e.y, type: 'move' });
    }
    return g;
  }
  function entGrips(e) { return entGripHandles(e); }   // render reads x/y
  // Grip near a screen point (for the selected entity), or null.
  function gripAtScreen(lp) {
    if (!S.selectedId) return null;
    var e = selectedEntity(); if (!e) return null;
    var hs = entGripHandles(e);
    for (var i = 0; i < hs.length; i++) {
      var sp = toScreen(hs[i].x, hs[i].y);
      if (Math.hypot(sp.x - lp.x, sp.y - lp.y) <= 9) return { gi: i, type: hs[i].type };
    }
    return null;
  }
  function deleteSelected() {
    if (!S.selectedId) return;
    pushUndo();
    S.doc.entities = S.doc.entities.filter(function (e) { return e.id !== S.selectedId; });
    S.selectedId = null; buildLayers(); repaint();
  }

  // ── History (undo / redo) ───────────────────────────────────────
  function snapshot() { return JSON.stringify({ entities: S.doc.entities, layers: S.doc.layers }); }
  function pushUndo() { S._undo.push(snapshot()); if (S._undo.length > 60) S._undo.shift(); S._redo.length = 0; }
  function commitEntity(e) { pushUndo(); S.doc.entities.push(e); }
  function restoreSnap(json) {
    var o = JSON.parse(json);
    S.doc.entities = o.entities; S.doc.layers = o.layers;
    S.selectedId = null; buildLayers(); repaint();
  }
  function undo() {
    if (S.draft) { S.draft = null; repaint(); return; }
    if (!S._undo.length) return;
    S._redo.push(snapshot()); restoreSnap(S._undo.pop());
  }
  function redo() {
    if (!S._redo.length) return;
    S._undo.push(snapshot()); restoreSnap(S._redo.pop());
  }

  // ── Edit operations (operate on the current selection) ──────────
  function selectedEntity() { return S.doc.entities.filter(function (e) { return e.id === S.selectedId; })[0]; }
  function translateEntity(e, dx, dy) {
    if (e.points) e.points.forEach(function (p) { p.x += dx; p.y += dy; });
    if (e.startX != null) { e.startX += dx; e.endX += dx; e.startY += dy; e.endY += dy; }
    if (e.x != null) { e.x += dx; e.y += dy; }
  }
  function transformEntity(e, fn) {
    if (e.points) e.points = e.points.map(function (p) { return fn(p); });
    if (e.startX != null) {
      var a = fn({ x: e.startX, y: e.startY }), b = fn({ x: e.endX, y: e.endY });
      e.startX = a.x; e.startY = a.y; e.endX = b.x; e.endY = b.y;
    }
    if (e.x != null) { var p = fn({ x: e.x, y: e.y }); e.x = p.x; e.y = p.y; }
  }
  function rotate90() {
    var e = selectedEntity(); if (!e) return;
    pushUndo();
    if (e.tool === 'symbol') { e.rotation = ((e.rotation || 0) + 90) % 360; repaint(); return; }
    var bb = entBBox(e), cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
    transformEntity(e, function (p) { return { x: cx - (p.y - cy), y: cy + (p.x - cx) }; });
    repaint();
  }
  function mirror(horiz) {
    var e = selectedEntity(); if (!e) return;
    pushUndo();
    var bb = entBBox(e), cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
    transformEntity(e, function (p) { return { x: horiz ? (2 * cx - p.x) : p.x, y: horiz ? p.y : (2 * cy - p.y) }; });
    repaint();
  }
  function duplicateSelected() {
    var e = selectedEntity(); if (!e) return;
    pushUndo();
    var copy = JSON.parse(JSON.stringify(e)); copy.id = uid(copy.tool);
    translateEntity(copy, 14, 14);
    S.doc.entities.push(copy); S.selectedId = copy.id; buildLayers(); repaint();
  }
  // Viewport an entity lives in, + its real-world scale (sheet px per inch).
  function viewportOf(e) {
    var vps = S.doc.viewports || [];
    for (var i = 0; i < vps.length; i++) if (vps[i].id === e.viewport) return vps[i];
    return vps[0] || null;
  }
  function ppiOf(e) {
    var vp = viewportOf(e);
    return (vp && vp.scale && vp.scale.pixelsPerInch) ? vp.scale.pixelsPerInch : DPI * 0.25 / 12;
  }
  // Array: tile the selection into a rows×cols grid at real-world spacing.
  function arrayOp(rows, cols, rowFt, colFt) {
    var e = selectedEntity(); if (!e) return;
    rows = Math.max(1, Math.min(40, rows | 0)); cols = Math.max(1, Math.min(40, cols | 0));
    if (rows * cols <= 1) return;
    var ppi = ppiOf(e), dx = (colFt || 0) * 12 * ppi, dy = (rowFt || 0) * 12 * ppi;
    pushUndo();
    var last = e.id;
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
      if (r === 0 && c === 0) continue;
      var copy = JSON.parse(JSON.stringify(e)); copy.id = uid(copy.tool);
      translateEntity(copy, c * dx, r * dy);
      S.doc.entities.push(copy); last = copy.id;
    }
    S.selectedId = last; buildLayers(); repaint();
  }
  // Offset: a parallel copy of the selection at a real-world distance.
  function offsetOp(distFt, side) {
    var e = selectedEntity(); if (!e) return;
    var ppi = ppiOf(e), d = (distFt || 0) * 12 * ppi * (side < 0 ? -1 : 1);
    if (!d) return;
    var copy = JSON.parse(JSON.stringify(e)); copy.id = uid(copy.tool);
    if (e.tool === 'line' && e.startX != null) {
      var nx = -(e.endY - e.startY), ny = (e.endX - e.startX), len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
      copy.startX = e.startX + nx * d; copy.startY = e.startY + ny * d;
      copy.endX = e.endX + nx * d; copy.endY = e.endY + ny * d;
    } else if ((e.tool === 'rect' || e.tool === 'ellipse') && e.startX != null) {
      var x0 = Math.min(e.startX, e.endX), y0 = Math.min(e.startY, e.endY), x1 = Math.max(e.startX, e.endX), y1 = Math.max(e.startY, e.endY);
      copy.startX = x0 - d; copy.startY = y0 - d; copy.endX = x1 + d; copy.endY = y1 + d;
      if (copy.endX - copy.startX < 1 || copy.endY - copy.startY < 1) { alert('Offset too large — shape would collapse.'); return; }
    } else if (e.tool === 'polyline' && e.points && e.points.length >= 2) {
      var pts = e.points;
      copy.points = pts.map(function (p, i) {
        var prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
        var tx = next.x - prev.x, ty = next.y - prev.y, mx = -ty, my = tx, l = Math.hypot(mx, my) || 1;
        return { x: p.x + mx / l * d, y: p.y + my / l * d };
      });
    } else {
      alert('Offset works on lines, polylines, rectangles, and circles.');
      return;
    }
    pushUndo();
    S.doc.entities.push(copy); S.selectedId = copy.id; buildLayers(); repaint();
  }
  // Small two/three-field modal shared by Array + Offset.
  function opModal(title, rowsHtml, onApply) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:5400;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#0f0f1e;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:340px;width:100%;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
    box.innerHTML = '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:12px;">' + esc(title) + '</div>' + rowsHtml +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">' +
        '<button data-op-cancel style="padding:8px 16px;background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>' +
        '<button data-op-apply style="padding:8px 16px;background:#4f8cff;color:#fff;border:1px solid #4f8cff;border-radius:6px;cursor:pointer;font-weight:700;">Apply</button>' +
      '</div>';
    ov.appendChild(box); document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    box.querySelector('[data-op-cancel]').onclick = close;
    box.querySelector('[data-op-apply]').onclick = function () { try { onApply(box); } catch (e) {} close(); };
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    var f = box.querySelector('input'); if (f) setTimeout(function () { try { f.focus(); f.select(); } catch (e) {} }, 0);
  }
  function numField(label, key, val) {
    return '<label style="display:block;font-size:11px;color:#9aa;margin:8px 0 3px;">' + esc(label) + '</label>' +
      '<input data-op="' + key + '" value="' + esc(val) + '" inputmode="decimal" style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:6px;padding:7px 10px;font-size:13px;outline:none;" />';
  }
  function openArrayModal() {
    if (!selectedEntity()) return;
    opModal('Array selection',
      numField('Rows', 'rows', '2') + numField('Columns', 'cols', '3') +
      numField('Row spacing (ft)', 'rowft', '5') + numField('Column spacing (ft)', 'colft', '5'),
      function (box) {
        function v(k) { return parseFloat((box.querySelector('[data-op=' + k + ']') || {}).value) || 0; }
        arrayOp(v('rows'), v('cols'), v('rowft'), v('colft'));
      });
  }
  function openOffsetModal() {
    if (!selectedEntity()) return;
    opModal('Offset selection',
      numField('Distance (ft)', 'dist', '1') +
      '<label style="display:block;font-size:11px;color:#9aa;margin:10px 0 3px;">Direction</label>' +
      '<select data-op="side" style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:6px;padding:7px 10px;font-size:13px;">' +
        '<option value="1">Outward / right of line</option><option value="-1">Inward / left of line</option></select>',
      function (box) {
        var dist = parseFloat((box.querySelector('[data-op=dist]') || {}).value) || 0;
        var side = parseFloat((box.querySelector('[data-op=side]') || {}).value) || 1;
        offsetOp(dist, side);
      });
  }

  // ── CAD modify ops (E4b): trim / extend / fillet ────────────────
  function setHint(msg) { var el = S.overlay && S.overlay.querySelector('#p86-sheet-hint'); if (el) el.textContent = msg; }
  // Point-to-segment distance + projection param t (unbounded).
  function ptSegInfo(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    var t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    var tc = Math.max(0, Math.min(1, t)), cx = ax + dx * tc, cy = ay + dy * tc;
    return { t: t, dist: Math.hypot(px - cx, py - cy) };
  }
  // Nearest 'line' entity to a sheet point within tolerance → {entity, t}.
  function pickLineAt(pt, vp) {
    var tol = 10 / S.view.scale, best = null, bestD = tol;
    (S.doc.entities || []).forEach(function (e) {
      if (e.tool !== 'line' || e.startX == null) return;
      if (vp && e.viewport !== vp.id) return;
      var info = ptSegInfo(pt.x, pt.y, e.startX, e.startY, e.endX, e.endY);
      if (info.dist < bestD && info.t >= -0.03 && info.t <= 1.03) { bestD = info.dist; best = { entity: e, t: Math.max(0, Math.min(1, info.t)) }; }
    });
    return best;
  }
  // Param t along seg1 where it crosses seg2 (both finite), or null.
  function segCrossT(x1, y1, x2, y2, x3, y3, x4, y4) {
    var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    var t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    var u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
    if (t < -0.001 || t > 1.001 || u < -0.001 || u > 1.001) return null;
    return t;
  }
  // Sorted crossing params of line e against other segments in its viewport.
  function lineCrossParams(e, vp) {
    var out = [];
    segmentsInVp(vp, e.id).forEach(function (s) {
      var t = segCrossT(e.startX, e.startY, e.endX, e.endY, s.a.x, s.a.y, s.b.x, s.b.y);
      if (t != null && t > 0.0008 && t < 0.9992) out.push(t);
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }
  function trimAt(pt, vp) {
    var hit = pickLineAt(pt, vp); if (!hit) return;
    var e = hit.entity, t0 = hit.t, ts = lineCrossParams(e, vp);
    if (!ts.length) { setHint('Trim: no crossing line to cut against.'); return; }
    var lo = 0, hi = 1;
    for (var i = 0; i < ts.length; i++) { if (ts[i] <= t0) lo = Math.max(lo, ts[i]); if (ts[i] >= t0) hi = Math.min(hi, ts[i]); }
    var ax = e.startX, ay = e.startY, bx = e.endX, by = e.endY;
    function P(t) { return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t }; }
    pushUndo();
    var keep = [];
    if (lo > 0.0008) keep.push([P(0), P(lo)]);
    if (hi < 0.9992) keep.push([P(hi), P(1)]);
    S.doc.entities = S.doc.entities.filter(function (x) { return x.id !== e.id; });
    keep.forEach(function (seg) {
      var c = JSON.parse(JSON.stringify(e)); c.id = uid('line');
      c.startX = seg[0].x; c.startY = seg[0].y; c.endX = seg[1].x; c.endY = seg[1].y;
      S.doc.entities.push(c);
    });
    S.selectedId = null; buildLayers(); repaint();
  }
  // Param along the ray P=(fx,fy)+u*(dx,dy) where it meets a segment (u=1
  // is the moving end); requires the hit to lie within the segment.
  function rayHitU(fx, fy, dx, dy, x3, y3, x4, y4) {
    var x1 = fx, y1 = fy, x2 = fx + dx, y2 = fy + dy;
    var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    var t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    var u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
    if (u < -0.001 || u > 1.001) return null;
    return t;
  }
  function extendAt(pt, vp) {
    var hit = pickLineAt(pt, vp); if (!hit) return;
    var e = hit.entity;
    var ds = Math.hypot(pt.x - e.startX, pt.y - e.startY), de = Math.hypot(pt.x - e.endX, pt.y - e.endY);
    var movingStart = ds < de;
    var fx = movingStart ? e.endX : e.startX, fy = movingStart ? e.endY : e.startY;
    var mx = movingStart ? e.startX : e.endX, my = movingStart ? e.startY : e.endY;
    var dx = mx - fx, dy = my - fy, best = null, bestU = Infinity;
    segmentsInVp(vp, e.id).forEach(function (s) {
      var u = rayHitU(fx, fy, dx, dy, s.a.x, s.a.y, s.b.x, s.b.y);
      if (u != null && u > 1.0005 && u < bestU) { bestU = u; best = { x: fx + dx * u, y: fy + dy * u }; }
    });
    if (!best) { setHint('Extend: no line ahead to extend to.'); return; }
    pushUndo();
    if (movingStart) { e.startX = best.x; e.startY = best.y; } else { e.endX = best.x; e.endY = best.y; }
    buildLayers(); repaint();
  }
  function lineLineIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
    var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    var px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / den;
    var py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / den;
    return { x: px, y: py };
  }
  function setNearEnd(L, click, p) {
    var d1 = Math.hypot(click.x - L.startX, click.y - L.startY), d2 = Math.hypot(click.x - L.endX, click.y - L.endY);
    if (d1 < d2) { L.startX = p.x; L.startY = p.y; } else { L.endX = p.x; L.endY = p.y; }
  }
  function filletClick(pt, vp) {
    var hit = pickLineAt(pt, vp); if (!hit) return;
    if (!S._filletA) { S._filletA = { id: hit.entity.id, click: { x: pt.x, y: pt.y } }; setHint('Fillet: first line ✓ — now click the second line.'); repaint(); return; }
    if (hit.entity.id === S._filletA.id) return;
    var aRec = S._filletA; S._filletA = null;
    var A = S.doc.entities.filter(function (x) { return x.id === aRec.id; })[0];
    if (!A) { updateHint(); return; }
    openFilletModal(A, hit.entity, aRec.click, { x: pt.x, y: pt.y });
  }
  function openFilletModal(A, B, ca, cb) {
    opModal('Fillet radius',
      numField('Radius (ft) — 0 = sharp corner', 'r', '1'),
      function (box) {
        var r = parseFloat((box.querySelector('[data-op=r]') || {}).value);
        applyFillet(A, B, ca, cb, isFinite(r) ? r : 0);
      });
    updateHint();
  }
  function applyFillet(A, B, ca, cb, rFt) {
    var I = lineLineIntersect(A.startX, A.startY, A.endX, A.endY, B.startX, B.startY, B.endX, B.endY);
    if (!I) { alert('Those lines are parallel — nothing to fillet.'); return; }
    var r = (rFt || 0) * 12 * ppiOf(A);
    function dirToward(L, click) {
      var d1 = Math.hypot(click.x - L.startX, click.y - L.startY), d2 = Math.hypot(click.x - L.endX, click.y - L.endY);
      var end = (d1 < d2) ? { x: L.startX, y: L.startY } : { x: L.endX, y: L.endY };
      var vx = end.x - I.x, vy = end.y - I.y, len = Math.hypot(vx, vy) || 1;
      return { x: vx / len, y: vy / len };
    }
    var da = dirToward(A, ca), db = dirToward(B, cb);
    pushUndo();
    if (r <= 0) { setNearEnd(A, ca, I); setNearEnd(B, cb, I); buildLayers(); repaint(); return; }
    var dot = Math.max(-1, Math.min(1, da.x * db.x + da.y * db.y)), theta = Math.acos(dot);
    if (theta < 1e-3 || Math.abs(theta - Math.PI) < 1e-3) { alert('Those lines are collinear — cannot fillet.'); return; }
    var dist = r / Math.tan(theta / 2);
    var t1 = { x: I.x + da.x * dist, y: I.y + da.y * dist };
    var t2 = { x: I.x + db.x * dist, y: I.y + db.y * dist };
    var bx = da.x + db.x, by = da.y + db.y, bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
    var cdist = r / Math.sin(theta / 2), C = { x: I.x + bx * cdist, y: I.y + by * cdist };
    var mvx = (t1.x + t2.x) / 2 - C.x, mvy = (t1.y + t2.y) / 2 - C.y, ml = Math.hypot(mvx, mvy) || 1;
    var arcMid = { x: C.x + mvx / ml * r, y: C.y + mvy / ml * r };
    setNearEnd(A, ca, t1); setNearEnd(B, cb, t2);
    var arc = newEntity('arc', viewportOf(A));
    arc.points = [{ x: t1.x, y: t1.y }, { x: arcMid.x, y: arcMid.y }, { x: t2.x, y: t2.y }];
    S.doc.entities.push(arc);
    buildLayers(); repaint();
  }

  // ── Render ──────────────────────────────────────────────────────
  function repaint() {
    var ctx = S.ctx, c = S.canvas;
    var dpr = S.dpr || 1, vw = S.cssW || c.width, vh = S.cssH || c.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#11151c'; ctx.fillRect(0, 0, vw, vh);
    ctx.save();
    ctx.translate(S.view.tx, S.view.ty);
    ctx.scale(S.view.scale, S.view.scale);
    renderSheet(ctx, S.doc, { paperShadow: true, grid: S.gridSnap, viewScale: S.view.scale });
    // draft preview
    if (S.draft) {
      var d = S.draft;
      ctx.save();
      ctx.strokeStyle = '#4f8cff'; ctx.fillStyle = '#4f8cff';
      ctx.lineWidth = (d.lineWidth || 3);
      if (d.tool === 'arc') {
        var pp = d.points.slice(); if (S.hover) pp.push(S.hover);
        var sp = (pp.length >= 3) ? arcSamples(pp, 40) : pp;
        if (sp.length) {
          ctx.beginPath(); ctx.moveTo(sp[0].x, sp[0].y);
          for (var ai = 1; ai < sp.length; ai++) ctx.lineTo(sp[ai].x, sp[ai].y);
          ctx.stroke();
        }
      } else if (d.points) {
        ctx.beginPath(); ctx.moveTo(d.points[0].x, d.points[0].y);
        for (var i = 1; i < d.points.length; i++) ctx.lineTo(d.points[i].x, d.points[i].y);
        if (S.hover) ctx.lineTo(S.hover.x, S.hover.y);
        ctx.stroke();
      } else if (S.hover) {
        var prev = { tool: d._circle ? 'ellipse' : d.tool, color: '#4f8cff', lineWidth: d.lineWidth || 3 };
        if (d._circle) {
          var r = Math.hypot(S.hover.x - d.startX, S.hover.y - d.startY);
          prev.startX = d.startX - r; prev.startY = d.startY - r; prev.endX = d.startX + r; prev.endY = d.startY + r;
        } else { prev.startX = d.startX; prev.startY = d.startY; prev.endX = S.hover.x; prev.endY = S.hover.y; }
        // Live dimension label on the dim-tool preview.
        if (d.tool === 'measure') {
          var pvp = vpAt(d._anchor || { x: d.startX, y: d.startY });
          if (pvp && pvp.scale && pvp.scale.pixelsPerInch) {
            var ppx = Math.hypot(prev.endX - prev.startX, prev.endY - prev.startY);
            prev.measureInches = ppx / pvp.scale.pixelsPerInch;
            prev.measureLabel = fmtLen(prev.measureInches);
          }
        }
        if (prims().drawStroke) { try { prims().drawStroke(ctx, prev); } catch (e) {} }
      }
      ctx.restore();
    }
    // selection highlight
    if (S.selectedId) {
      var sel = S.doc.entities.filter(function (e) { return e.id === S.selectedId; })[0];
      var bb = sel && entBBox(sel);
      if (bb) {
        ctx.save(); ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 1.5 / S.view.scale; ctx.setLineDash([6 / S.view.scale, 4 / S.view.scale]);
        ctx.strokeRect(bb.x - 4, bb.y - 4, bb.w + 8, bb.h + 8); ctx.restore();
      }
    }
    ctx.restore();
    // selection grips (screen space, fixed size) — CAD-style square handles
    // at the entity's defining points. Display-only for now (E2).
    if (S.selectedId) {
      var selG = S.doc.entities.filter(function (e) { return e.id === S.selectedId; })[0];
      var grips = selG ? entGrips(selG) : [];
      ctx.save();
      grips.forEach(function (g) {
        var gp = toScreen(g.x, g.y);
        ctx.fillStyle = '#22c55e'; ctx.strokeStyle = '#0b0e14'; ctx.lineWidth = 1;
        ctx.fillRect(gp.x - 4, gp.y - 4, 8, 8); ctx.strokeRect(gp.x - 4, gp.y - 4, 8, 8);
      });
      ctx.restore();
    }
    // snap marker (screen space, fixed size)
    if (S.snap && S.snap.kind) {
      var sp = toScreen(S.snap.x, S.snap.y);
      ctx.save();
      ctx.strokeStyle = S.snap.kind === 'grid' ? '#64748b' : (S.snap.kind === 'intersect' ? '#f472b6' : '#fbbf24');
      ctx.lineWidth = 1.5;
      if (S.snap.kind === 'mid') { ctx.beginPath(); ctx.moveTo(sp.x - 6, sp.y + 5); ctx.lineTo(sp.x, sp.y - 6); ctx.lineTo(sp.x + 6, sp.y + 5); ctx.closePath(); ctx.stroke(); }
      else if (S.snap.kind === 'center') { ctx.beginPath(); ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2); ctx.stroke(); }
      else if (S.snap.kind === 'grid') { ctx.beginPath(); ctx.moveTo(sp.x - 4, sp.y); ctx.lineTo(sp.x + 4, sp.y); ctx.moveTo(sp.x, sp.y - 4); ctx.lineTo(sp.x, sp.y + 4); ctx.stroke(); }
      else if (S.snap.kind === 'intersect') { ctx.beginPath(); ctx.moveTo(sp.x - 5, sp.y - 5); ctx.lineTo(sp.x + 5, sp.y + 5); ctx.moveTo(sp.x + 5, sp.y - 5); ctx.lineTo(sp.x - 5, sp.y + 5); ctx.stroke(); }
      else { ctx.strokeRect(sp.x - 5, sp.y - 5, 10, 10); }   // endpoint square
      ctx.restore();
    }
  }

  function save() {
    if (S && typeof S.onSave === 'function') { try { S.onSave(S.doc, {}); } catch (e) { /* defensive */ } }
    close();
  }

  // ── Export (D6) ─────────────────────────────────────────────────
  // Render the whole sheet at full paper resolution (line weights are
  // paper-true at scale 1) into an offscreen canvas.
  function renderFullSheet() {
    var s = S.doc.sheet;
    var off = document.createElement('canvas');
    off.width = s.w; off.height = s.h;
    renderSheet(off.getContext('2d'), S.doc);
    return off;
  }
  function exportPng() {
    try {
      var url = renderFullSheet().toDataURL('image/png');
      var a = document.createElement('a');
      a.href = url;
      a.download = (String(S.plan && S.plan.name || 'sheet').replace(/[^a-z0-9._-]+/gi, '_')) + '.png';
      document.body.appendChild(a); a.click();
      setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 0);
    } catch (e) { alert('PNG export failed: ' + (e && e.message ? e.message : 'unknown')); }
  }
  // Print at true sheet size → browser's "Save as PDF". Mirrors the
  // job-reports / estimate-preview print pattern (no PDF lib needed).
  function exportPdf() {
    var s = S.doc.sheet;
    var sz = SHEET_SIZES[s.size] || { wIn: s.w / DPI, hIn: s.h / DPI };
    var url;
    try { url = renderFullSheet().toDataURL('image/png'); }
    catch (e) { alert('PDF export failed: ' + (e && e.message ? e.message : 'unknown')); return; }
    var w = window.open('', '_blank');
    if (!w) { alert('Pop-up blocked — allow pop-ups for this site to print / save as PDF.'); return; }
    var title = esc((S.doc.titleblock && S.doc.titleblock.title) || S.plan && S.plan.name || 'Sheet');
    w.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
      '<style>@page{size:' + sz.wIn + 'in ' + sz.hIn + 'in;margin:0;}' +
      'html,body{margin:0;padding:0;background:#fff;}' +
      'img{width:' + sz.wIn + 'in;height:' + sz.hIn + 'in;display:block;}</style></head>' +
      '<body><img src="' + url + '" onload="setTimeout(function(){window.focus();window.print();},250);"></body></html>'
    );
    w.document.close();
  }

  // expose
  window.p86SheetEditor = {
    open: function (opts) {
      open(opts);
      if (S) {
        S.overlay.querySelector('#p86-sheet-cancel').onclick = close;
        S.overlay.querySelector('#p86-sheet-save').onclick = save;
        var pdfBtn = S.overlay.querySelector('#p86-sheet-pdf'); if (pdfBtn) pdfBtn.onclick = exportPdf;
        var pngBtn = S.overlay.querySelector('#p86-sheet-png'); if (pngBtn) pngBtn.onclick = exportPng;
        var setBtn = S.overlay.querySelector('#p86-sheet-settings'); if (setBtn) setBtn.onclick = openSettingsModal;
      }
    },
    close: close,
    defaultDoc: defaultDoc,
    SHEET_SIZES: SHEET_SIZES,
    DPI: DPI
  };
})();
