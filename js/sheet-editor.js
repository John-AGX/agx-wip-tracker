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
    { key: 'select',   glyph: '▢', name: 'Select',     group: 'Draw',     label: 'Select (click to pick · Shift-click adds · drag a box to window/crossing select · Del removes)' },
    { key: 'line',     glyph: '─', name: 'Line',       group: 'Draw',     label: 'Line (click start, click end · Esc cancels)' },
    { key: 'polyline', glyph: '⌇', name: 'Polyline',   group: 'Draw',     label: 'Polyline (click points · double-click/Enter to finish)' },
    { key: 'rect',     glyph: '▭', name: 'Rectangle',  group: 'Draw',     label: 'Rectangle (click two opposite corners)' },
    { key: 'circle',   glyph: '◯', name: 'Circle',     group: 'Draw',     label: 'Circle (click center, click radius)' },
    { key: 'arc',      glyph: '⌒', name: 'Arc',        group: 'Draw',     label: 'Arc (3-point: click start, a point on the arc, then end)' },
    { key: 'trim',     glyph: '✂', name: 'Trim',       group: 'Modify',   label: 'Trim — click a line segment to cut it back to the nearest crossing line' },
    { key: 'extend',   glyph: '⇥', name: 'Extend',     group: 'Modify',   label: 'Extend — click a line near the end to extend it to the next line it meets' },
    { key: 'fillet',   glyph: '◜', name: 'Fillet',     group: 'Modify',   label: 'Fillet — click two lines, then enter a radius (0 = sharp corner)' },
    { key: 'dim',      glyph: '↔', name: 'Dimension',  group: 'Annotate', label: 'Dimension (click two points — auto-labels real length at the viewport scale)' },
    { key: 'angle',    glyph: '∠', name: 'Angle dim',  group: 'Annotate', label: 'Angle dimension (click three points: leg · vertex · leg)' },
    { key: 'leader',   glyph: '➘', name: 'Leader',     group: 'Annotate', label: 'Leader / callout (click target, click text position)' },
    { key: 'text',     glyph: 'T', name: 'Text',       group: 'Annotate', label: 'Text (click to place)' },
    { key: 'hatch',    glyph: '▨', name: 'Hatch',      group: 'Annotate', label: 'Hatch fill (click a closed region; pick a material pattern) — double-click / Enter to close' },
    { key: 'symbol',   glyph: '✱', name: 'Symbol',     group: 'Annotate', label: 'Symbol / block (north arrow, sprinkler head, post, tree, callout)' },
    { key: 'level',    glyph: '↧', name: 'Level',      group: 'Annotate', label: 'Level / elevation line — horizontal datum at a set elevation (e.g. 10\') with a head marker. Prints. The first one sets the datum.' },
    { key: 'spotelev', glyph: '⌖', name: 'Spot elev',  group: 'Annotate', label: 'Spot elevation — click any point to tag its height above the level datum. Prints.' },
    { key: 'refline',  glyph: '┈', name: 'Ref line',   group: 'Annotate', label: 'Reference line (construction guide — snaps & trims to, but is NOT printed or exported)' },
    { key: 'pan',      glyph: '✋', name: 'Pan',        group: 'View',     label: 'Pan (or hold Space / middle-drag)' }
  ];
  // Non-tool buttons (edit ops + history/util) shown in the drawer, grouped.
  var EDIT_ITEMS = [
    { key: 'rotate',  act: 'edit', glyph: '⟳', name: 'Rotate 90°', group: 'Modify', label: 'Rotate selection 90°' },
    { key: 'mirrorH', act: 'edit', glyph: '⇆', name: 'Mirror H',   group: 'Modify', label: 'Mirror selection (horizontal)' },
    { key: 'mirrorV', act: 'edit', glyph: '⇅', name: 'Mirror V',   group: 'Modify', label: 'Mirror selection (vertical)' },
    { key: 'dup',     act: 'edit', glyph: '⧉', name: 'Duplicate',  group: 'Modify', label: 'Duplicate selection (Ctrl+D)' },
    { key: 'offset',  act: 'edit', glyph: '⎘', name: 'Offset',     group: 'Modify', label: 'Offset selection by a distance (line / polyline / rect / circle)' },
    { key: 'array',   act: 'edit', glyph: '▦', name: 'Array',      group: 'Modify', label: 'Array selection (rows × columns)' },
    { key: 'fit',     act: 'fit',  glyph: '⤢', name: 'Fit',        group: 'View',   label: 'Fit to screen' },
    { key: 'undo',    act: 'undo', glyph: '↶', name: 'Undo',       group: 'View',   label: 'Undo (Ctrl+Z)' },
    { key: 'redo',    act: 'redo', glyph: '↷', name: 'Redo',       group: 'View',   label: 'Redo (Ctrl+Y / Ctrl+Shift+Z)' }
  ];
  var TOOL_GROUP_ORDER = ['Draw', 'Modify', 'Annotate', 'View'];
  // Single-key tool aliases (no modifier). Ctrl/Cmd combos handled separately.
  var SHORTCUTS = {
    s: 'select', l: 'line', p: 'polyline', r: 'rect', c: 'circle', a: 'arc',
    x: 'trim', e: 'extend', f: 'fillet',
    d: 'dim', g: 'angle', k: 'leader', t: 'text', h: 'hatch', y: 'symbol',
    v: 'pan'
  };

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
  // Normalize any stored color to #rrggbb for <input type="color">.
  function toHex6(c) {
    var h = String(c || '#000000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return '#000000';
    return '#' + h.toLowerCase();
  }

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
    polarInc: 90,                  // polar-tracking increment in degrees (15/30/45/90)
    // Per-object-snap toggles (gated by the master osnap). nearest defaults off
    // because it overrides the precise snaps when on.
    snaps: { end: true, mid: true, center: true, intersect: true, perp: true, near: false, quad: true, node: true },
    dimColor: '#b45309'
  };
  function loadSettings() {
    var s = {};
    try { var raw = localStorage.getItem(SETTINGS_KEY); if (raw) s = JSON.parse(raw) || {}; } catch (e) {}
    var out = {}; for (var k in DEFAULT_SETTINGS) out[k] = (s[k] != null) ? s[k] : DEFAULT_SETTINGS[k];
    // Deep-merge the snaps object so newly-added snap kinds get their defaults.
    var sn = {}; for (var sk in DEFAULT_SETTINGS.snaps) sn[sk] = (out.snaps && out.snaps[sk] != null) ? out.snaps[sk] : DEFAULT_SETTINGS.snaps[sk];
    out.snaps = sn;
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
        company: '', showLogo: true,
        // CAD-style additions
        projectNo: '', address: '', checkedBy: '', approvedBy: '', sheetOf: '',
        revisions: [], generalNotes: '', showNotes: false,
        logoScale: 1, logoPos: 'left'
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
          if (e.tool === 'level') { try { drawLevel(ctx, e); } catch (err) {} return; }
          if (e.tool === 'spotelev') { try { drawSpotElev(ctx, e); } catch (err) {} return; }
          if (e.tool === 'refline') { if (opts.editor) { try { drawRefline(ctx, e); } catch (err) {} } return; }   // construction guide — editor only, never exported
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

    // ── Company band (top) — honors logoScale + logoPos ──
    var bandH = Math.round(tbH * 0.26);
    ctx.fillStyle = '#111827'; ctx.fillRect(x, y, tbW, bandH);
    var company = String(tb.company || (S && S._orgName) || '').toUpperCase();
    var logo = (tb.showLogo !== false && S && S._logo) ? S._logo : null;
    var logoScale = Math.max(0.5, Math.min(2, parseFloat(tb.logoScale) || 1));
    var logoPos = tb.logoPos === 'center' ? 'center' : 'left';
    var nameStr = company || 'COMPANY NAME';
    ctx.font = '800 ' + Math.round(DPI * 0.19) + 'px Arial, sans-serif';
    var nameW = ctx.measureText(nameStr).width;
    var dw = 0, dh = 0;
    if (logo) {
      var boxH = bandH - pad, boxW = Math.round(bandH * 1.7);
      var iw = logo.naturalWidth || logo.width || 1, ih = logo.naturalHeight || logo.height || 1;
      var sc = Math.min(boxW / iw, boxH / ih); dw = iw * sc * logoScale; dh = ih * sc * logoScale;
      if (dh > bandH - 4) { var k = (bandH - 4) / dh; dh *= k; dw *= k; }   // clamp to band
    }
    var gap = logo ? pad : 0;
    var nameShownW = Math.min(nameW, tbW - dw - gap - pad * 2);
    var startX = (logoPos === 'center') ? (x + Math.max(pad, (tbW - (dw + gap + nameShownW)) / 2)) : (x + pad);
    var tx = startX;
    if (logo) {
      var ly = y + (bandH - dh) / 2;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(startX - 3, ly - 3, dw + 6, dh + 6);
      try { ctx.drawImage(logo, startX, ly, dw, dh); } catch (e) {}
      tx = startX + dw + gap;
    }
    ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = '800 ' + Math.round(DPI * 0.19) + 'px Arial, sans-serif';
    ctx.fillText(nameStr, tx, y + bandH / 2, x + tbW - tx - pad);

    // ── Field grid (below band) — 5 rows ──
    var gy = y + bandH, gh = tbH - bandH, rows = 5, rowH = gh / rows;
    function rowLine(i) { ctx.beginPath(); ctx.moveTo(x, gy + rowH * i); ctx.lineTo(x + tbW, gy + rowH * i); ctx.stroke(); }
    function vseg(frac, ri) { var px = x + tbW * frac; ctx.beginPath(); ctx.moveTo(px, gy + rowH * ri); ctx.lineTo(px, gy + rowH * (ri + 1)); ctx.stroke(); }
    ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1;
    for (var i = 1; i < rows; i++) rowLine(i);
    vseg(0.68, 0);                 // PROJECT | PROJ #
    vseg(0.55, 2);                 // CLIENT | ADDRESS
    vseg(0.34, 3); vseg(0.67, 3);  // DATE | DRAWN | SCALE
    vseg(0.25, 4); vseg(0.5, 4);   // CHECKED | APPROVED | SHEET
    function cell(label, val, frac0, ri, frac1, big) {
      var cx = x + tbW * frac0, cw = tbW * (frac1 - frac0), cy = gy + rowH * ri;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#6b7280'; ctx.font = '700 ' + Math.round(DPI * 0.07) + 'px Arial, sans-serif';
      ctx.fillText(label, cx + pad * 0.7, cy + Math.round(DPI * 0.05));
      ctx.fillStyle = '#111827';
      ctx.font = (big ? '800 ' + Math.round(DPI * 0.2) : '700 ' + Math.round(DPI * 0.12)) + 'px Arial, sans-serif';
      ctx.fillText(String(val || '—'), cx + pad * 0.7, cy + rowH * (big ? 0.38 : 0.46), cw - pad * 1.3);
    }
    var sheetVal = String(tb.sheetNo || '') + (tb.sheetOf ? '  of ' + tb.sheetOf : '');
    cell('PROJECT', tb.project, 0, 0, 0.68);
    cell('PROJECT #', tb.projectNo, 0.68, 0, 1);
    cell('SHEET TITLE', tb.title, 0, 1, 1);
    cell('CLIENT', tb.client, 0, 2, 0.55);
    cell('ADDRESS', tb.address, 0.55, 2, 1);
    cell('DATE', tb.date, 0, 3, 0.34);
    cell('DRAWN BY', tb.drawnBy, 0.34, 3, 0.67);
    cell('SCALE', tb.scale, 0.67, 3, 1);
    cell('CHECKED', tb.checkedBy, 0, 4, 0.25);
    cell('APPROVED', tb.approvedBy, 0.25, 4, 0.5);
    cell('SHEET', sheetVal, 0.5, 4, 1, true);

    // ── Revision strip + general-notes block, stacked above the titleblock ──
    var stackTop = y, gap2 = Math.round(DPI * 0.06);
    var revs = Array.isArray(tb.revisions) ? tb.revisions.filter(function (r) { return r && (r.rev || r.date || r.desc); }) : [];
    if (revs.length) {
      var rH = Math.round(DPI * 0.15), totalH = rH * (revs.length + 1);
      var ry = stackTop - gap2 - totalH;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x, ry, tbW, totalH);
      ctx.strokeStyle = '#111827'; ctx.lineWidth = 2; ctx.strokeRect(x, ry, tbW, totalH);
      var rc1 = x + tbW * 0.12, rc2 = x + tbW * 0.34;
      ctx.fillStyle = '#111827'; ctx.fillRect(x, ry, tbW, rH);
      ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = '800 ' + Math.round(DPI * 0.08) + 'px Arial, sans-serif';
      ctx.fillText('REV', x + pad * 0.6, ry + rH / 2);
      ctx.fillText('DATE', rc1 + pad * 0.4, ry + rH / 2);
      ctx.fillText('DESCRIPTION', rc2 + pad * 0.4, ry + rH / 2);
      revs.forEach(function (r, ri) {
        var rowY = ry + rH * (ri + 1);
        ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, rowY); ctx.lineTo(x + tbW, rowY); ctx.stroke();
        ctx.fillStyle = '#111827'; ctx.font = '700 ' + Math.round(DPI * 0.08) + 'px Arial, sans-serif';
        ctx.fillText(String(r.rev || ''), x + pad * 0.6, rowY + rH / 2);
        ctx.fillText(String(r.date || ''), rc1 + pad * 0.4, rowY + rH / 2, rc2 - rc1 - pad);
        ctx.fillText(String(r.desc || ''), rc2 + pad * 0.4, rowY + rH / 2, x + tbW - rc2 - pad);
      });
      ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(rc1, ry); ctx.lineTo(rc1, ry + totalH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rc2, ry); ctx.lineTo(rc2, ry + totalH); ctx.stroke();
      stackTop = ry;
    }
    if (tb.showNotes && String(tb.generalNotes || '').trim()) {
      var lines = String(tb.generalNotes).split(/\r?\n/);
      var lh = Math.round(DPI * 0.125), nH = lh * (lines.length + 1) + pad;
      var ny = Math.max(s.margin + 6, stackTop - gap2 - nH);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x, ny, tbW, nH);
      ctx.strokeStyle = '#111827'; ctx.lineWidth = 2; ctx.strokeRect(x, ny, tbW, nH);
      ctx.fillStyle = '#111827'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.font = '800 ' + Math.round(DPI * 0.08) + 'px Arial, sans-serif';
      ctx.fillText('GENERAL NOTES', x + pad * 0.7, ny + pad * 0.5);
      ctx.font = '600 ' + Math.round(DPI * 0.095) + 'px Arial, sans-serif';
      lines.forEach(function (ln, li) { ctx.fillText(ln, x + pad * 0.7, ny + pad * 0.5 + lh * (li + 1), tbW - pad * 1.4); });
    }
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
  // ── Elevations / levels ─────────────────────────────────────────
  // The first 'level' entity in a viewport is the datum; spot elevations are
  // measured from it using the viewport's real scale (Y-up: higher = taller).
  function datumForViewport(vpId) {
    var ents = S.doc.entities || [];
    for (var i = 0; i < ents.length; i++) if (ents[i].tool === 'level' && ents[i].viewport === vpId) return { y: ents[i].startY, elevIn: ents[i].elevIn || 0 };
    return null;
  }
  function elevAtPoint(e) {
    var vp = viewportOf(e), ppi = ppiOf(e), dat = datumForViewport(e.viewport);
    if (dat) return dat.elevIn + (dat.y - e.y) / ppi;
    return (vp ? (vp.y + vp.h - e.y) : 0) / ppi;     // fallback: above viewport floor
  }
  // Level/datum line: dash-dot horizontal line + a head bubble with the
  // elevation. Paper-true (fixed sheet px) so it prints to scale.
  function drawLevel(ctx, e) {
    ctx.save();
    ctx.strokeStyle = e.color || '#0ea5e9'; ctx.fillStyle = e.color || '#0ea5e9'; ctx.lineWidth = e.lineWidth || 2;
    ctx.setLineDash([16, 7, 3, 7]);
    ctx.beginPath(); ctx.moveTo(e.startX, e.startY); ctx.lineTo(e.endX, e.endY); ctx.stroke();
    ctx.setLineDash([]);
    var hx = Math.max(e.startX, e.endX), hy = e.startY, r = Math.round(DPI * 0.12);
    ctx.beginPath(); ctx.arc(hx + r + 4, hy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.font = '700 ' + Math.round(DPI * 0.13) + 'px Arial, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(fmtFeet(e.elevIn || 0), hx - 6, hy - 5);
    ctx.restore();
  }
  // Spot elevation: a triangle pointer at the spot + the computed height.
  function drawSpotElev(ctx, e) {
    var s = Math.round(DPI * 0.12);
    ctx.save();
    ctx.strokeStyle = e.color || '#0ea5e9'; ctx.fillStyle = e.color || '#0ea5e9'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(e.x - s * 0.6, e.y - s); ctx.lineTo(e.x + s * 0.6, e.y - s); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(e.x, e.y, 2, 0, Math.PI * 2); ctx.fill();
    ctx.font = '700 ' + Math.round(DPI * 0.12) + 'px Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('+' + fmtFeet(elevAtPoint(e)), e.x + s * 0.8, e.y - s);
    ctx.restore();
  }
  // Construction/reference line — faint dashed, screen-consistent weight.
  function drawRefline(ctx, e) {
    var sc = (S && S.view && S.view.scale) ? S.view.scale : 1;
    ctx.save();
    ctx.strokeStyle = 'rgba(34,211,238,0.6)'; ctx.lineWidth = 1.4 / sc; ctx.setLineDash([10 / sc, 7 / sc]);
    ctx.beginPath(); ctx.moveTo(e.startX, e.startY); ctx.lineTo(e.endX, e.endY); ctx.stroke();
    ctx.restore();
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
        '<button id="p86-sheet-shortcuts" title="Keyboard shortcuts (?)" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 11px;font-size:13px;cursor:pointer;">⌨</button>' +
        '<button id="p86-sheet-png" title="Download the sheet as a PNG" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;">⬇ PNG</button>' +
        '<button id="p86-sheet-pdf" title="Print / Save as PDF at true sheet size" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;">⎙ PDF</button>' +
        '<button id="p86-sheet-dxf" title="Export to DXF — opens to scale in AutoCAD / any CAD app" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;">⛁ DXF</button>' +
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
            '<input data-dyn-len type="text" autocomplete="off" placeholder="" title="Type a length (10\', 10\' 6\", 126\") — press , (comma) or Tab to jump to the angle" style="width:78px;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:4px;padding:3px 6px;font-size:12px;font-weight:600;outline:none;" />' +
            '<span style="font-size:10px;color:#9aa;font-weight:700;">∠</span>' +
            '<input data-dyn-ang type="text" autocomplete="off" placeholder="" title="Type an angle in degrees — Enter to commit" style="width:52px;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:4px;padding:3px 6px;font-size:12px;font-weight:600;outline:none;" />' +
            '<span style="font-size:9px;color:#5b7a9a;font-weight:700;letter-spacing:.3px;padding-left:2px;">,&nbsp;⤏&nbsp;⏎</span>' +
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
      snaps: SETTINGS.snaps,
      polarInc: SETTINGS.polarInc || 90,
      panning: null,        // {sx,sy,tx,ty}
      spaceDown: false,
      selectedId: null,     // the PRIMARY selection (single) — drives grips/properties
      selIds: [],           // full multi-selection set (ids)
      boxSel: null,         // {start,last,shift} rubber-band window/crossing select
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
      var br = (r && r.branding) || {};
      // Logo library: prefer branding.logos[]; fall back to a single logo_url.
      S._orgLogos = (Array.isArray(br.logos) ? br.logos : [])
        .filter(function (l) { return l && l.url; })
        .map(function (l) { return { url: l.url, label: l.label || '' }; });
      if (!S._orgLogos.length && br.logo_url) S._orgLogos = [{ url: br.logo_url, label: 'Primary' }];
      S._orgPrimaryUrl = br.logo_url || (S._orgLogos[0] && S._orgLogos[0].url) || '';
      repaint();
      if (S._orgLogos.length) loadChosenLogo();
    }).catch(function () { /* no org branding — titleblock just omits it */ });
  }
  // Which logo this sheet stamps: titleblock.logoUrl picks one from the org
  // library; if unset/missing, fall back to the org Primary (proxy default).
  function chosenLogoIndex() {
    var want = S && S.doc && S.doc.titleblock && S.doc.titleblock.logoUrl;
    if (want && S._orgLogos) {
      for (var i = 0; i < S._orgLogos.length; i++) if (S._orgLogos[i].url === want) return i;
    }
    return null; // null → Primary (no ?i on the proxy)
  }
  function loadChosenLogo() {
    if (!S) return;
    var idx = chosenLogoIndex();
    var token = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) || null;
    if (!token) { try { token = localStorage.getItem('p86-auth-token'); } catch (e) {} }
    var headers = {}; if (token) headers['Authorization'] = 'Bearer ' + token;
    fetch('/api/org/logo' + (idx != null ? ('?i=' + idx) : ''), { headers: headers, credentials: 'same-origin' })
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
      .catch(function () { if (S) { S._logo = null; repaint(); } });
  }
  // Back-compat alias (older callers).
  function loadOrgLogo() { loadChosenLogo(); }

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
  var TOOLS_KEY = 'p86SheetToolsCollapsed';
  function toolsCollapsed() { try { return localStorage.getItem(TOOLS_KEY) === '1'; } catch (e) { return false; } }
  // One-time stylesheet for the slide-out tool drawer (kept self-contained in
  // the overlay so the editor doesn't depend on app CSS).
  function injectToolStyle() {
    if (document.getElementById('p86se-tools-style')) return;
    var st = document.createElement('style');
    st.id = 'p86se-tools-style';
    st.textContent =
      '#p86-sheet-tools{transition:width .18s ease,flex-basis .18s ease;}' +
      '#p86-sheet-tools .p86se-thead{display:flex;align-items:center;justify-content:space-between;gap:6px;height:26px;margin-bottom:4px;}' +
      '#p86-sheet-tools .p86se-ttitle{font-size:10px;font-weight:800;letter-spacing:1px;color:#7c8aa0;text-transform:uppercase;white-space:nowrap;overflow:hidden;}' +
      '#p86-sheet-tools .p86se-ttoggle{flex:0 0 auto;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:0;border-radius:6px;color:#9aa;cursor:pointer;font-size:15px;}' +
      '#p86-sheet-tools .p86se-ttoggle:hover{background:rgba(255,255,255,0.07);color:#fff;}' +
      '#p86-sheet-tools .p86se-tgrp{font-size:9.5px;font-weight:800;letter-spacing:.6px;color:#5f6b7e;text-transform:uppercase;margin:8px 2px 3px;white-space:nowrap;overflow:hidden;}' +
      '#p86-sheet-tools .p86se-tbtn{display:flex;align-items:center;gap:9px;width:100%;height:34px;padding:0 8px;box-sizing:border-box;background:rgba(255,255,255,0.05);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;line-height:1;text-align:left;}' +
      '#p86-sheet-tools .p86se-tbtn:hover{background:rgba(255,255,255,0.1);}' +
      '#p86-sheet-tools .p86se-tbtn .g{flex:0 0 18px;width:18px;text-align:center;font-size:16px;}' +
      '#p86-sheet-tools .p86se-tbtn .l{font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      // collapsed (icon-rail) state
      '#p86-sheet-tools.collapsed{align-items:center;}' +
      '#p86-sheet-tools.collapsed .p86se-thead{justify-content:center;}' +
      '#p86-sheet-tools.collapsed .p86se-ttitle{display:none;}' +
      '#p86-sheet-tools.collapsed .p86se-tgrp{font-size:0;height:1px;width:24px;margin:6px auto;padding:0;background:#3a3a4a;color:transparent;}' +
      '#p86-sheet-tools.collapsed .p86se-tbtn{justify-content:center;gap:0;width:40px;padding:0;}' +
      '#p86-sheet-tools.collapsed .p86se-tbtn .l{display:none;}';
    document.head.appendChild(st);
  }
  function applyToolsCollapsed(collapsed) {
    var bar = S.overlay.querySelector('#p86-sheet-tools'); if (!bar) return;
    bar.classList.toggle('collapsed', collapsed);
    var w = collapsed ? 54 : 190;
    bar.style.width = w + 'px'; bar.style.flexBasis = w + 'px'; bar.style.flex = '0 0 ' + w + 'px';
    bar.style.alignItems = collapsed ? 'center' : 'stretch';
    var tg = bar.querySelector('.p86se-ttoggle');
    if (tg) { tg.textContent = collapsed ? '»' : '«'; tg.title = collapsed ? 'Expand tools' : 'Collapse tools'; }
    // Canvas is flex:1 — recompute its pixel size after the width transition settles.
    setTimeout(function () { if (S) { sizeCanvas(false); repaint(); } }, 200);
  }
  function buildToolbar() {
    injectToolStyle();
    var bar = S.overlay.querySelector('#p86-sheet-tools');
    var collapsed = toolsCollapsed();
    function btnTool(t) {
      return '<button class="p86se-tbtn" data-sheet-tool="' + t.key + '" title="' + esc(t.label) + '">' +
        '<span class="g">' + t.glyph + '</span><span class="l">' + esc(t.name) + '</span></button>';
    }
    function btnEdit(e) {
      return '<button class="p86se-tbtn" data-sheet-act="' + e.act + '" data-sheet-akey="' + e.key + '" title="' + esc(e.label) + '">' +
        '<span class="g">' + e.glyph + '</span><span class="l">' + esc(e.name) + '</span></button>';
    }
    var html = '<div class="p86se-thead"><span class="p86se-ttitle">Tools</span>' +
      '<button class="p86se-ttoggle" data-sheet-tools-toggle title="Collapse tools">' + (collapsed ? '»' : '«') + '</button></div>';
    TOOL_GROUP_ORDER.forEach(function (g) {
      var tools = TOOLS.filter(function (t) { return t.group === g; });
      var edits = EDIT_ITEMS.filter(function (e) { return e.group === g; });
      if (!tools.length && !edits.length) return;
      html += '<div class="p86se-tgrp">' + esc(g) + '</div>';
      html += tools.map(btnTool).join('') + edits.map(btnEdit).join('');
    });
    bar.innerHTML = html;
    bar.querySelectorAll('[data-sheet-tool]').forEach(function (b) {
      b.onclick = function () { setTool(b.getAttribute('data-sheet-tool')); };
    });
    bar.querySelectorAll('[data-sheet-act]').forEach(function (b) {
      b.onclick = function () {
        var act = b.getAttribute('data-sheet-act'), k = b.getAttribute('data-sheet-akey');
        if (act === 'undo') return undo();
        if (act === 'redo') return redo();
        if (act === 'fit') { sizeCanvas(true); repaint(); return; }
        if (act === 'edit') {
          if (!S.selIds.length) return;
          if (k === 'rotate') rotate90();
          else if (k === 'mirrorH') mirror(true);
          else if (k === 'mirrorV') mirror(false);
          else if (k === 'dup') duplicateSelected();
          else if (k === 'offset') openOffsetModal();
          else if (k === 'array') openArrayModal();
        }
      };
    });
    var toggle = bar.querySelector('[data-sheet-tools-toggle]');
    if (toggle) toggle.onclick = function () {
      var next = !bar.classList.contains('collapsed');
      try { localStorage.setItem(TOOLS_KEY, next ? '1' : '0'); } catch (e) {}
      applyToolsCollapsed(next);
    };
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
    applyToolsCollapsed(collapsed);
    refreshToolbar();
    updateHint();
  }
  function refreshToolbar() {
    var bar = S.overlay.querySelector('#p86-sheet-tools');
    bar.querySelectorAll('[data-sheet-tool]').forEach(function (b) {
      var on = b.getAttribute('data-sheet-tool') === S.tool;
      b.style.background = on ? 'rgba(251,191,36,0.12)' : '';
      b.style.color = on ? '#fbbf24' : '';
      b.style.borderColor = on ? '#fbbf24' : '';
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
      // Reflect the polar increment on the ortho chip (ORTHO at 90°, else POLAR n°).
      if (k === 'ortho') b.textContent = (S.polarInc && S.polarInc !== 90) ? ('POLAR ' + S.polarInc + '°') : 'ORTHO';
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
    // Two-column field layout (label + input). Wide fields span both columns.
    var fields = [
      ['company', 'Company name (blank = org name)', 1], ['project', 'Project', 1],
      ['projectNo', 'Project #', 0], ['title', 'Sheet title', 0],
      ['client', 'Client', 0], ['address', 'Project address', 0],
      ['scale', 'Scale note', 0], ['date', 'Date', 0],
      ['drawnBy', 'Drawn by', 0], ['checkedBy', 'Checked by', 0],
      ['approvedBy', 'Approved by', 0], ['northDeg', 'North rotation (°)', 0],
      ['sheetNo', 'Sheet #', 0], ['sheetOf', 'Of (total sheets)', 0]
    ];
    var inCss = 'width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:6px;padding:7px 10px;font-size:13px;outline:none;';
    var hdrCss = 'font-size:10px;font-weight:800;letter-spacing:.7px;color:#7c8aa0;text-transform:uppercase;margin:16px 0 6px;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#0f0f1e;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:520px;width:100%;max-height:88vh;overflow-y:auto;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
    box.innerHTML = '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:4px;">Titleblock</div>' +
      '<div style="' + hdrCss + 'margin-top:6px;">Fields</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;">' +
        fields.map(function (f) {
          return '<div' + (f[2] ? ' style="grid-column:1 / -1;"' : '') + '>' +
            '<label style="display:block;font-size:11px;color:#9aa;margin:0 0 3px;">' + esc(f[1]) + '</label>' +
            '<input data-tb="' + f[0] + '" value="' + esc(tb[f[0]] != null ? tb[f[0]] : '') + '" style="' + inCss + '" /></div>';
        }).join('') +
      '</div>' +
      // Revisions
      '<div style="' + hdrCss + '">Revisions</div>' +
      '<div data-tb-revs></div>' +
      '<button type="button" data-tb-revadd style="margin-top:6px;padding:5px 10px;background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;font-size:11.5px;font-weight:600;">+ Add revision</button>' +
      // General notes
      '<div style="' + hdrCss + '">General notes</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#cbd5e1;margin-bottom:6px;cursor:pointer;">' +
        '<input type="checkbox" data-tb-shownotes ' + (tb.showNotes ? 'checked' : '') + ' style="width:15px;height:15px;cursor:pointer;" /> Show a general-notes block on the sheet' +
      '</label>' +
      '<textarea data-tb-notes rows="3" placeholder="1. All dimensions to be field-verified.&#10;2. ..." style="' + inCss + 'resize:vertical;font-family:inherit;">' + esc(tb.generalNotes || '') + '</textarea>' +
      // Logo
      '<div style="' + hdrCss + '">Logo</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#cbd5e1;cursor:pointer;">' +
        '<input type="checkbox" data-tb-showlogo ' + (tb.showLogo !== false ? 'checked' : '') + ' style="width:15px;height:15px;cursor:pointer;" /> Show company logo in titleblock' +
      '</label>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin-top:8px;">' +
        '<div><label style="display:block;font-size:11px;color:#9aa;margin:0 0 3px;">Logo size (×)</label>' +
          '<input data-tb-logoscale type="number" min="0.5" max="2" step="0.1" value="' + esc(tb.logoScale != null ? tb.logoScale : 1) + '" style="' + inCss + '" /></div>' +
        '<div><label style="display:block;font-size:11px;color:#9aa;margin:0 0 3px;">Logo position</label>' +
          '<select data-tb-logopos style="' + inCss + '">' +
            '<option value="left"' + (tb.logoPos !== 'center' ? ' selected' : '') + '>Left of company name</option>' +
            '<option value="center"' + (tb.logoPos === 'center' ? ' selected' : '') + '>Centered</option>' +
          '</select></div>' +
      '</div>' +
      '<div data-tb-logopick style="margin-top:10px;"></div>' +
      '<div style="font-size:10.5px;color:#64748b;margin-top:6px;line-height:1.5;">Logos &amp; company name come from your org <b style="color:#9aa;">Branding kit</b> (Admin → Organization → Branding).</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">' +
        '<button data-tb-cancel style="padding:8px 16px;background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>' +
        '<button data-tb-save style="padding:8px 16px;background:#4f8cff;color:#fff;border:1px solid #4f8cff;border-radius:6px;cursor:pointer;font-weight:700;">Save</button>' +
      '</div>';
    ov.appendChild(box); document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }

    // ── Revision rows editor ──
    var revs = (Array.isArray(tb.revisions) ? tb.revisions : []).map(function (r) { return { rev: r.rev || '', date: r.date || '', desc: r.desc || '' }; });
    var revHost = box.querySelector('[data-tb-revs]');
    function renderRevs() {
      if (!revHost) return;
      if (!revs.length) { revHost.innerHTML = '<div style="font-size:11px;color:#64748b;padding:2px 0;">No revisions.</div>'; return; }
      revHost.innerHTML = revs.map(function (r, i) {
        return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:5px;">' +
          '<input data-rev-rev="' + i + '" value="' + esc(r.rev) + '" placeholder="#" style="' + inCss + 'width:42px;flex:0 0 42px;text-align:center;" />' +
          '<input data-rev-date="' + i + '" value="' + esc(r.date) + '" placeholder="Date" style="' + inCss + 'width:84px;flex:0 0 84px;" />' +
          '<input data-rev-desc="' + i + '" value="' + esc(r.desc) + '" placeholder="Description" style="' + inCss + 'flex:1;" />' +
          '<button type="button" data-rev-del="' + i + '" title="Remove" style="flex:0 0 auto;background:transparent;border:0;color:#f87171;cursor:pointer;font-size:14px;">✕</button>' +
        '</div>';
      }).join('');
      revHost.querySelectorAll('[data-rev-rev]').forEach(function (el) { el.oninput = function () { revs[+el.getAttribute('data-rev-rev')].rev = el.value; }; });
      revHost.querySelectorAll('[data-rev-date]').forEach(function (el) { el.oninput = function () { revs[+el.getAttribute('data-rev-date')].date = el.value; }; });
      revHost.querySelectorAll('[data-rev-desc]').forEach(function (el) { el.oninput = function () { revs[+el.getAttribute('data-rev-desc')].desc = el.value; }; });
      revHost.querySelectorAll('[data-rev-del]').forEach(function (el) { el.onclick = function () { revs.splice(+el.getAttribute('data-rev-del'), 1); renderRevs(); }; });
    }
    renderRevs();
    box.querySelector('[data-tb-revadd]').onclick = function () { revs.push({ rev: String(revs.length + 1), date: '', desc: '' }); renderRevs(); };

    // Logo picker — choose WHICH org logo stamps this sheet ('' = org Primary).
    var pickedLogo = tb.logoUrl || '';
    var logos = (S && S._orgLogos) || [];
    var primaryUrl = (S && S._orgPrimaryUrl) || '';
    var pickHost = box.querySelector('[data-tb-logopick]');
    function renderPicker() {
      if (!pickHost) return;
      if (!logos.length) { pickHost.innerHTML = '<div style="font-size:10.5px;color:#64748b;">No logos in your Branding kit yet.</div>'; return; }
      function card(url, label, isPrimary, key) {
        var sel = (key === pickedLogo);
        return '<button type="button" data-pick="' + esc(key) + '" title="' + esc(label || (isPrimary ? 'Primary' : '')) + '" ' +
          'style="flex:0 0 auto;width:84px;border:2px solid ' + (sel ? '#4f8cff' : '#333') + ';border-radius:8px;padding:5px;background:' + (sel ? 'rgba(79,140,255,0.12)' : '#161625') + ';cursor:pointer;text-align:center;">' +
          '<div style="background:#fff;border-radius:4px;height:42px;display:flex;align-items:center;justify-content:center;position:relative;">' +
            (isPrimary ? '<span style="position:absolute;top:1px;right:2px;font-size:10px;">⭐</span>' : '') +
            (url ? '<img src="' + esc(url) + '" alt="" style="max-height:34px;max-width:72px;" />' : '<span style="font-size:16px;">★</span>') +
          '</div>' +
          '<div style="font-size:9.5px;color:' + (sel ? '#9ec2ff' : '#9aa') + ';margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(label || (isPrimary ? 'Default' : 'Logo')) + '</div>' +
        '</button>';
      }
      var html = '<div style="font-size:11px;color:#9aa;margin-bottom:5px;">Logo on this sheet</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          card('', 'Default (Primary)', false, '') +
          logos.map(function (l) { return card(l.url, l.label, l.url === primaryUrl, l.url); }).join('') +
        '</div>';
      pickHost.innerHTML = html;
      pickHost.querySelectorAll('[data-pick]').forEach(function (btn) {
        btn.addEventListener('click', function () { pickedLogo = btn.getAttribute('data-pick'); renderPicker(); });
      });
    }
    renderPicker();

    box.querySelector('[data-tb-cancel]').onclick = close;
    box.querySelector('[data-tb-save]').onclick = function () {
      pushUndo();
      var t = S.doc.titleblock;
      box.querySelectorAll('[data-tb]').forEach(function (inp) { t[inp.getAttribute('data-tb')] = inp.value; });
      t.northDeg = parseFloat(t.northDeg) || 0;
      var cb = box.querySelector('[data-tb-showlogo]'); if (cb) t.showLogo = cb.checked;
      var sn = box.querySelector('[data-tb-shownotes]'); if (sn) t.showNotes = sn.checked;
      var nt = box.querySelector('[data-tb-notes]'); if (nt) t.generalNotes = nt.value;
      var ls = box.querySelector('[data-tb-logoscale]'); if (ls) t.logoScale = Math.max(0.5, Math.min(2, parseFloat(ls.value) || 1));
      var lp = box.querySelector('[data-tb-logopos]'); if (lp) t.logoPos = lp.value;
      t.revisions = revs.filter(function (r) { return (r.rev || r.date || r.desc); });
      var prevLogo = t.logoUrl || '';
      t.logoUrl = pickedLogo || '';
      close(); repaint();
      if ((pickedLogo || '') !== prevLogo) loadChosenLogo(); // swap the stamped logo
    };
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  }

  // ── Keyboard shortcuts cheat-sheet ──────────────────────────────
  function openShortcuts() {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:5400;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    var rows = [
      ['Tools', ''],
      ['S', 'Select'], ['L', 'Line'], ['P', 'Polyline'], ['R', 'Rectangle'], ['C', 'Circle'], ['A', 'Arc'],
      ['X', 'Trim'], ['E', 'Extend'], ['F', 'Fillet'],
      ['D', 'Dimension'], ['G', 'Angle dim'], ['K', 'Leader'], ['T', 'Text'], ['H', 'Hatch'], ['Y', 'Symbol'], ['V', 'Pan'],
      ['Edit & view', ''],
      ['Ctrl+Z', 'Undo'], ['Ctrl+Y / Ctrl+Shift+Z', 'Redo'], ['Ctrl+D', 'Duplicate selection'],
      ['Del / Backspace', 'Delete selection'], ['Enter', 'Finish polyline / hatch'], ['Esc', 'Cancel current action'],
      ['Shift (hold)', 'Polar / ortho lock'], ['Space (hold) / middle-drag', 'Pan'], ['Mouse wheel', 'Zoom'],
      ['Drawing', ''],
      ['type a number', 'Exact length while drawing'], [', (comma) or Tab', 'Jump to the angle field'], ['?', 'This cheat-sheet']
    ];
    var box = document.createElement('div');
    box.style.cssText = 'background:#0f0f1e;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:440px;width:100%;max-height:88vh;overflow-y:auto;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
    box.innerHTML = '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:10px;">⌨ Keyboard shortcuts</div>' +
      rows.map(function (r) {
        if (!r[1]) return '<div style="font-size:10px;font-weight:800;letter-spacing:.7px;color:#7c8aa0;text-transform:uppercase;margin:13px 0 4px;">' + esc(r[0]) + '</div>';
        return '<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0;font-size:12.5px;">' +
          '<kbd style="background:#1a1a2e;border:1px solid #444;border-radius:4px;padding:1px 7px;color:#cbd5e1;font-family:ui-monospace,monospace;font-size:11.5px;white-space:nowrap;">' + esc(r[0]) + '</kbd>' +
          '<span style="color:#cbd5e1;text-align:right;">' + esc(r[1]) + '</span></div>';
      }).join('') +
      '<div style="display:flex;justify-content:flex-end;margin-top:16px;">' +
        '<button data-sc-close style="padding:8px 16px;background:#4f8cff;color:#fff;border:1px solid #4f8cff;border-radius:6px;cursor:pointer;font-weight:700;">Got it</button>' +
      '</div>';
    ov.appendChild(box); document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    box.querySelector('[data-sc-close]').onclick = close;
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
    function snapCb(key, label, on) {
      return '<label style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:#cbd5e1;margin-top:5px;cursor:pointer;">' +
        '<input type="checkbox" data-st-snap="' + key + '" ' + (on ? 'checked' : '') + ' style="width:14px;height:14px;cursor:pointer;" /> ' + esc(label) + '</label>';
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
      '<div style="font-weight:700;color:#fff;margin:14px 0 2px;">Snaps &amp; tracking</div>' +
      cb('ortho', 'Polar / ortho tracking (hold Shift too)', !!SETTINGS.ortho) +
      '<label style="' + labCss + '">Polar increment</label>' +
      '<select data-st="polarInc" style="' + selCss + '">' + [15, 30, 45, 90].map(function (d) { return opt(String(d), d + '°' + (d === 90 ? '  (ortho)' : ''), (SETTINGS.polarInc || 90) == d); }).join('') + '</select>' +
      cb('gridSnap', 'Snap to grid', SETTINGS.gridSnap !== false) +
      cb('osnap', 'Object snap (master)', SETTINGS.osnap !== false) +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px;margin-top:2px;padding-left:4px;">' +
        [['end', 'Endpoint'], ['mid', 'Midpoint'], ['center', 'Center'], ['intersect', 'Intersection'], ['perp', 'Perpendicular'], ['near', 'Nearest'], ['quad', 'Quadrant'], ['node', 'Node']]
          .map(function (p) { return snapCb(p[0], p[1], SETTINGS.snaps && SETTINGS.snaps[p[0]] !== false); }).join('') +
      '</div>' +
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
        if (k === 'gridFt') SETTINGS[k] = Math.max(0.25, Math.min(100, parseFloat(el.value) || 1));
        else if (k === 'polarInc') SETTINGS[k] = parseInt(el.value, 10) || 90;
        else SETTINGS[k] = el.value;
      });
      box.querySelectorAll('[data-st-cb]').forEach(function (el) { SETTINGS[el.getAttribute('data-st-cb')] = el.checked; });
      var snaps = {}; box.querySelectorAll('[data-st-snap]').forEach(function (el) { snaps[el.getAttribute('data-st-snap')] = el.checked; });
      SETTINGS.snaps = snaps;
      saveSettings();
      // Apply the live-affecting settings to the current session immediately.
      S.ortho = !!SETTINGS.ortho; S.gridSnap = SETTINGS.gridSnap !== false; S.objSnap = SETTINGS.osnap !== false;
      S.snaps = SETTINGS.snaps; S.polarInc = SETTINGS.polarInc || 90;
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
        '<div style="display:flex;align-items:center;gap:12px;margin-top:7px;">' +
          '<label style="font-size:10.5px;color:#9aa;display:flex;align-items:center;gap:5px;">Color <input type="color" data-prop-color value="' + esc(toHex6(selEnt.color)) + '" style="width:30px;height:22px;border:0;background:transparent;cursor:pointer;padding:0;" /></label>' +
          '<label style="font-size:10.5px;color:#9aa;display:flex;align-items:center;gap:5px;">Weight <input type="number" data-prop-weight value="' + (selEnt.lineWidth || 2) + '" min="1" max="24" step="1" style="width:46px;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:5px;padding:3px 5px;font-size:11px;" /></label>' +
        '</div>' +
        '<div style="margin-top:6px;font-size:9.5px;color:#64748b;">Drag body to move · drag grips to reshape · ⟳ rotate · ⇆⇅ mirror · Ctrl+D dup</div>' +
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
        '<button data-layer-lock="' + esc(l.id) + '" title="' + (l.locked ? 'Locked — click to unlock' : 'Unlocked — click to lock') + '" style="background:transparent;border:0;cursor:pointer;font-size:11px;width:16px;color:' + (l.locked ? '#fbbf24' : '#64748b') + ';">' + (l.locked ? '🔒' : '🔓') + '</button>' +
        ((S.doc.layers.length > 1) ? '<button data-layer-del="' + esc(l.id) + '" title="Delete layer (objects move to first layer)" style="background:transparent;border:0;color:#f87171;cursor:pointer;font-size:12px;width:14px;">✕</button>' : '') +
      '</div>';
    }).join('');
    html += '<div style="margin-top:10px;font-size:10.5px;color:#64748b;line-height:1.4;">Click = draw on it · dbl-click name = rename · swatch = color · 🔒 = lock · ✕ = delete.</div>';
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
    var propColor = host.querySelector('[data-prop-color]');
    if (propColor) propColor.onchange = function () { var e = selectedEntity(); if (!e) return; pushUndo(); e.color = propColor.value; repaint(); };
    var propWeight = host.querySelector('[data-prop-weight]');
    if (propWeight) propWeight.onchange = function () { var e = selectedEntity(); if (!e) return; pushUndo(); e.lineWidth = Math.max(1, Math.min(24, parseInt(propWeight.value, 10) || 2)); repaint(); };
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
    host.querySelectorAll('[data-layer-lock]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var l = layerById(S.doc, b.getAttribute('data-layer-lock'));
        l.locked = !l.locked;
        // Drop any selected entities that live on the now-locked layer.
        if (l.locked && S.selIds.length) {
          var byId = {}; S.doc.entities.forEach(function (en) { byId[en.id] = en; });
          setSelection(S.selIds.filter(function (id) { var en = byId[id]; return !(en && en.layer === l.id); }));
        }
        buildLayers(); repaint();
      };
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
        if (e.tool === 'ellipse') {
          // Quadrant points (E/N/W/S) of the circle/ellipse.
          var qcx = (e.startX + e.endX) / 2, qcy = (e.startY + e.endY) / 2;
          var qrx = Math.abs(e.endX - e.startX) / 2, qry = Math.abs(e.endY - e.startY) / 2;
          out.push({ x: qcx + qrx, y: qcy, kind: 'quad' }); out.push({ x: qcx - qrx, y: qcy, kind: 'quad' });
          out.push({ x: qcx, y: qcy + qry, kind: 'quad' }); out.push({ x: qcx, y: qcy - qry, kind: 'quad' });
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
        // Symbol / text insertion points = node snaps.
        out.push({ x: e.x, y: e.y, kind: 'node' });
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
      if ((e.tool === 'line' || e.tool === 'refline' || e.tool === 'level') && e.startX != null) {
        segs.push({ a: { x: e.startX, y: e.startY }, b: { x: e.endX, y: e.endY } });
      } else if (e.tool === 'rect' && e.startX != null) {
        var c = [{ x: e.startX, y: e.startY }, { x: e.endX, y: e.startY }, { x: e.endX, y: e.endY }, { x: e.startX, y: e.endY }];
        for (var k = 0; k < 4; k++) segs.push({ a: c[k], b: c[(k + 1) % 4] });
      } else if ((e.tool === 'polyline' || e.tool === 'mangle' || e.tool === 'hatch') && e.points && e.points.length > 1) {
        for (var p = 1; p < e.points.length; p++) segs.push({ a: e.points[p - 1], b: e.points[p] });
        if (e.tool === 'hatch' && e.points.length > 2) segs.push({ a: e.points[e.points.length - 1], b: e.points[0] });
      } else if (e.tool === 'arc' && e.points && e.points.length >= 3) {
        // Sample the arc into chords so it acts as a trim/extend boundary.
        var sa = arcSamples(e.points, 40);
        for (var q = 1; q < sa.length; q++) segs.push({ a: sa[q - 1], b: sa[q] });
      } else if (e.tool === 'ellipse' && e.startX != null) {
        var ex0 = (e.startX + e.endX) / 2, ey0 = (e.startY + e.endY) / 2, rxe = Math.abs(e.endX - e.startX) / 2, rye = Math.abs(e.endY - e.startY) / 2, prev = null;
        for (var ai2 = 0; ai2 <= 48; ai2++) { var th2 = ai2 / 48 * 2 * Math.PI, p2 = { x: ex0 + rxe * Math.cos(th2), y: ey0 + rye * Math.sin(th2) }; if (prev) segs.push({ a: prev, b: p2 }); prev = p2; }
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
  // Projection parameter of point p onto the infinite line a→b (0=a, 1=b).
  function projParam(p, a, b) { var dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy; if (L2 < 1e-9) return null; return ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2; }
  // Resolve the snapped sheet-point for a raw cursor sheet-point.
  function resolveSnap(raw, vp) {
    var radiusSheet = SNAP_SCREEN / S.view.scale;
    var best = null, bestD = radiusSheet;
    var sn = S.snaps || {};
    if (S.objSnap && vp) {
      snapCandidates(vp).forEach(function (c) {
        if (sn[c.kind] === false) return;                    // per-kind toggle
        var d = Math.hypot(c.x - raw.x, c.y - raw.y);
        if (d < bestD) { bestD = d; best = c; }
      });
      // Anchor-aware perpendicular + nearest (need the segment list).
      if (sn.perp || sn.near) {
        var anchor = S.draft && (S.draft._anchor ||
          (S.draft.startX != null ? { x: S.draft.startX, y: S.draft.startY } : null) ||
          (S.draft.points && S.draft.points.length ? S.draft.points[S.draft.points.length - 1] : null));
        var segs = segmentsInVp(vp);
        segs.forEach(function (g) {
          if (sn.perp && anchor) {
            var t = projParam(anchor, g.a, g.b);
            if (t != null) {
              var fx = g.a.x + t * (g.b.x - g.a.x), fy = g.a.y + t * (g.b.y - g.a.y);
              var dp = Math.hypot(fx - raw.x, fy - raw.y);
              if (dp < bestD) { bestD = dp; best = { x: fx, y: fy, kind: 'perp' }; }
            }
          }
          if (sn.near) {
            var tt = projParam(raw, g.a, g.b);
            if (tt != null) {
              tt = Math.max(0, Math.min(1, tt));
              var nx = g.a.x + tt * (g.b.x - g.a.x), ny = g.a.y + tt * (g.b.y - g.a.y);
              var dn = Math.hypot(nx - raw.x, ny - raw.y);
              if (dn < bestD) { bestD = dn; best = { x: nx, y: ny, kind: 'near' }; }
            }
          }
        });
      }
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
  // Constrain a point to the polar-tracking increment relative to an anchor.
  function applyOrtho(anchor, pt) {
    if (!(S.ortho || S.shiftDown)) return pt;
    var dx = pt.x - anchor.x, dy = pt.y - anchor.y;
    var ang = Math.atan2(dy, dx);
    var inc = (S.polarInc || 90);
    var step = inc * Math.PI / 180;
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
        // Grip-drag: if the cursor is on a grip of the (single) selection,
        // reshape that point (or move the whole entity for a 'move' grip).
        var grip = gripAtScreen(lp);
        if (grip) { S.gripDrag = { gi: grip.gi, type: grip.type, last: raw, pushed: false }; return; }
        var hit = hitTest(raw);
        if (hit && e.shiftKey) { selectAt(raw, true); return; }     // toggle in/out of set
        if (hit && isSelected(hit)) {
          // Clicked an already-selected entity → arm a group move-drag; a plain
          // click (no movement) collapses the selection to just this entity.
          S.moveDrag = { last: raw, pushed: false, hit: hit, group: S.selIds.length > 1 };
          return;
        }
        if (hit) { selectAt(raw, false); S.moveDrag = { last: raw, pushed: false, hit: hit, group: false }; return; }
        // Empty space → rubber-band window/crossing select.
        S.boxSel = { start: raw, last: raw, shift: e.shiftKey };
        return;
      }
      if (S.tool === 'text') {
        var tl = layerById(S.doc, S.activeLayer);
        if (tl && tl.locked) { setHint('Layer "' + tl.name + '" is locked — unlock it (🔓) to add text.'); return; }
        placeText(pt, vp); return;
      }
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
      // Move-drag the whole selection (select tool, button held).
      if (S.moveDrag && (e.buttons & 1)) {
        var ents = selEntities();
        if (ents.length) {
          if (!S.moveDrag.pushed) { pushUndo(); S.moveDrag.pushed = true; }
          var ds = toSheet(lp.x, lp.y);
          var ddx = ds.x - S.moveDrag.last.x, ddy = ds.y - S.moveDrag.last.y;
          ents.forEach(function (en) { translateEntity(en, ddx, ddy); });
          S.moveDrag.last = ds;
          repaint();
        }
        return;
      }
      // Rubber-band box selection in progress.
      if (S.boxSel && (e.buttons & 1)) {
        S.boxSel.last = toSheet(lp.x, lp.y);
        repaint();
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
      // A plain click on one member of a multi-selection (no drag) collapses to it.
      if (S.moveDrag && !S.moveDrag.pushed && S.moveDrag.group && S.moveDrag.hit) { setSelection([S.moveDrag.hit]); buildLayers(); repaint(); }
      // Finalize a rubber-band selection.
      if (S.boxSel) {
        var b = S.boxSel; S.boxSel = null;
        var x0 = Math.min(b.start.x, b.last.x), x1 = Math.max(b.start.x, b.last.x);
        var y0 = Math.min(b.start.y, b.last.y), y1 = Math.max(b.start.y, b.last.y);
        var click = ((x1 - x0) < 4 / S.view.scale && (y1 - y0) < 4 / S.view.scale);
        if (click) {
          if (!b.shift) { setSelection([]); buildLayers(); repaint(); }     // click empty = clear
        } else {
          var crossing = b.start.x > b.last.x;                              // right→left = crossing
          var picked = pickInBox({ x0: x0, y0: y0, x1: x1, y1: y1 }, crossing);
          if (b.shift) { picked.forEach(function (id) { if (S.selIds.indexOf(id) < 0) S.selIds.push(id); }); setSelection(S.selIds); }
          else setSelection(picked);
          buildLayers(); repaint();
        }
      }
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
      else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selIds.length) { deleteSelected(); }
      else if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); openShortcuts(); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        // Single-key tool aliases (AutoCAD-style). Guarded above so Ctrl/Cmd
        // combos (undo/redo/dup) never reach here.
        var k = (e.key || '').toLowerCase();
        if (SHORTCUTS[k]) { e.preventDefault(); setTool(SHORTCUTS[k]); }
      }
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
      // CAD-style field switching: a comma (like "10,45") OR Tab jumps from the
      // LEN field to the ∠ field (and back); Enter commits, Esc cancels. The
      // comma never lands as a literal character in either numeric field.
      var lenInp = dyn.querySelector('[data-dyn-len]'), angInp = dyn.querySelector('[data-dyn-ang]');
      function focusOther(from) { var t = (from === angInp) ? lenInp : angInp; if (t) { t.focus(); try { t.select(); } catch (e) {} } }
      dyn.querySelectorAll('input').forEach(function (inp) {
        inp.onkeydown = function (e) {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitDyn(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); S.draft = null; hideDyn(); repaint(); S.overlay.focus(); }
          else if (e.key === ',') { e.preventDefault(); e.stopPropagation(); if (e.target === lenInp) focusOther(lenInp); /* comma in ∠ is a no-op */ }
          else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); focusOther(e.target); }
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
    // Block drawing onto a locked layer.
    var actL = layerById(S.doc, S.activeLayer);
    if (actL && actL.locked) { setHint('Layer "' + actL.name + '" is locked — unlock it (🔓) to draw.'); return; }
    // Level / elevation line — a horizontal datum across the viewport at a
    // typed elevation. The first level in a viewport sets the datum; later
    // ones snap to the height implied by that datum + the viewport scale.
    if (t === 'level') {
      var vpL = vp || vpAt(pt) || (S.doc.viewports[0] || {});
      var lv = newEntity('level', vpL);
      var pad = 14;
      lv.startX = (vpL.x || 0) + pad; lv.endX = (vpL.x || 0) + (vpL.w || 200) - pad;
      promptText('Elevation (e.g. 10\', 0, 8\' 6")', function (txt) {
        if (txt == null) return;
        var p = prims().parseMeasurement ? prims().parseMeasurement(txt, 'ft') : null;
        lv.elevIn = p ? p.inches : ((parseFloat(txt) || 0) * 12);
        var dat = datumForViewport(vpL.id), yy = pt.y;
        if (dat) { yy = dat.y - (lv.elevIn - dat.elevIn) * ppiOf(lv); }
        lv.startY = yy; lv.endY = yy;
        commitEntity(lv); repaint();
      });
      return;
    }
    // Spot elevation — tag a point's height above the level datum.
    if (t === 'spotelev') {
      var se = newEntity('spotelev', vp);
      se.x = pt.x; se.y = pt.y;
      commitEntity(se); repaint();
      return;
    }
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
    if (t === 'line' || t === 'rect' || t === 'circle' || t === 'refline') {
      if (!S.draft) {
        var e = newEntity(t === 'circle' ? 'ellipse' : t, vp);
        e.startX = pt.x; e.startY = pt.y; e.endX = pt.x; e.endY = pt.y;
        e._anchor = { x: pt.x, y: pt.y }; e._circle = (t === 'circle');
        S.draft = e;
        if (t === 'line' || t === 'refline') showDyn();
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
  function dynApplies() { return S.draft && S.draft._anchor && (S.tool === 'line' || S.tool === 'refline' || S.tool === 'polyline'); }
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
    // Strip any stray comma (e.g. a fast-typed "10,45" before the field swap fired).
    var lenStr = (d.querySelector('[data-dyn-len]').value || '').replace(/,/g, '').trim();
    var angStr = (d.querySelector('[data-dyn-ang]').value || '').replace(/,/g, '').trim();
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
  // Styled single-line text input (replaces window.prompt). cb(value|null).
  function promptText(title, cb, initial) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:5400;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#0f0f1e;border:1px solid #353545;border-radius:12px;padding:18px 20px;max-width:380px;width:100%;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
    box.innerHTML = '<div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:10px;">' + esc(title) + '</div>' +
      '<input data-pt-input value="' + esc(initial || '') + '" style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:6px;padding:8px 10px;font-size:13px;outline:none;" />' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
        '<button data-pt-cancel style="padding:8px 16px;background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>' +
        '<button data-pt-ok style="padding:8px 16px;background:#4f8cff;color:#fff;border:1px solid #4f8cff;border-radius:6px;cursor:pointer;font-weight:700;">OK</button>' +
      '</div>';
    ov.appendChild(box); document.body.appendChild(ov);
    var input = box.querySelector('[data-pt-input]');
    function done(val) { if (ov.parentNode) ov.parentNode.removeChild(ov); cb(val); }
    box.querySelector('[data-pt-cancel]').onclick = function () { done(null); };
    box.querySelector('[data-pt-ok]').onclick = function () { done(input.value); };
    input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } else if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 0);
    ov.addEventListener('click', function (e) { if (e.target === ov) done(null); });
  }
  function finalizeLeader(pt, vp) {
    var d = S.draft;
    d.endX = pt.x; d.endY = pt.y;
    if (Math.abs(d.endX - d.startX) < 0.5 && Math.abs(d.endY - d.startY) < 0.5) { S.draft = null; return; }
    delete d._anchor;
    pushUndo();
    S.doc.entities.push(d);          // the arrow
    S.draft = null;
    var ex = pt.x, ey = pt.y, ppi = (vp && vp.scale ? vp.scale.pixelsPerInch : 2.5);
    promptText('Leader text', function (txt) {
      if (txt) {
        var te = newEntity('text', vp);
        te.x = ex + 6; te.y = ey - ppi * 9;
        te.text = txt; te.fontPx = Math.round(ppi * 9);
        S.doc.entities.push(te); repaint();
      }
    });
    repaint();
  }
  function placeText(pt, vp) {
    promptText('Text', function (txt) {
      if (!txt) return;
      var e = newEntity('text', vp);
      e.x = pt.x; e.y = pt.y; e.text = txt; e.fontPx = Math.round((vp && vp.scale ? vp.scale.pixelsPerInch : 2.5) * 9);
      commitEntity(e); repaint();
    });
  }
  // Topmost selectable entity id under a sheet point (or null).
  function hitTest(raw) {
    for (var i = S.doc.entities.length - 1; i >= 0; i--) {
      var e = S.doc.entities[i];
      var lyr = layerById(S.doc, e.layer);          // skip hidden + locked layers
      if (lyr && (lyr.visible === false || lyr.locked)) continue;
      var bb = entBBox(e);
      var slop = 8 / S.view.scale;
      if (bb && raw.x >= bb.x - slop && raw.x <= bb.x + bb.w + slop && raw.y >= bb.y - slop && raw.y <= bb.y + bb.h + slop) return e.id;
    }
    return null;
  }
  // ── Selection set helpers (multi-select) ──
  function isSelected(id) { return S.selIds.indexOf(id) >= 0; }
  function selEntities() { return S.doc.entities.filter(function (e) { return S.selIds.indexOf(e.id) >= 0; }); }
  function setSelection(ids) { S.selIds = (ids || []).slice(); S.selectedId = (S.selIds.length === 1) ? S.selIds[0] : null; }
  // Click-select (or shift-toggle) at a point.
  function selectAt(raw, additive) {
    var hit = hitTest(raw);
    if (additive) {
      if (hit) { var i = S.selIds.indexOf(hit); if (i >= 0) S.selIds.splice(i, 1); else S.selIds.push(hit); }
    } else {
      S.selIds = hit ? [hit] : [];
    }
    S.selectedId = (S.selIds.length === 1) ? S.selIds[0] : null;
    buildLayers(); repaint();
    return hit;
  }
  // Combined bounding box of a list of entities (sheet coords).
  function groupBBox(ents) {
    var mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    ents.forEach(function (e) { var bb = entBBox(e); if (!bb) return; mnx = Math.min(mnx, bb.x); mny = Math.min(mny, bb.y); mxx = Math.max(mxx, bb.x + bb.w); mxy = Math.max(mxy, bb.y + bb.h); });
    if (mnx === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: mnx, y: mny, w: mxx - mnx, h: mxy - mny };
  }
  // Entities inside (window) or touching (crossing) a sheet-space box.
  function pickInBox(bx, crossing) {
    var out = [];
    (S.doc.entities || []).forEach(function (e) {
      var lyr = layerById(S.doc, e.layer); if (lyr && (lyr.visible === false || lyr.locked)) return;
      var bb = entBBox(e); if (!bb) return;
      var inside = bb.x >= bx.x0 && bb.y >= bx.y0 && (bb.x + bb.w) <= bx.x1 && (bb.y + bb.h) <= bx.y1;
      var overlaps = !(bb.x > bx.x1 || (bb.x + bb.w) < bx.x0 || bb.y > bx.y1 || (bb.y + bb.h) < bx.y0);
      if (crossing ? overlaps : inside) out.push(e.id);
    });
    return out;
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
        // Edge-midpoint grips — drag a single side.
        g.push({ x: (e.startX + e.endX) / 2, y: e.startY, type: 'pt', anchor: { x: (e.startX + e.endX) / 2, y: e.endY }, apply: function (nx, ny) { e.startY = ny; } });
        g.push({ x: (e.startX + e.endX) / 2, y: e.endY, type: 'pt', anchor: { x: (e.startX + e.endX) / 2, y: e.startY }, apply: function (nx, ny) { e.endY = ny; } });
        g.push({ x: e.startX, y: (e.startY + e.endY) / 2, type: 'pt', anchor: { x: e.endX, y: (e.startY + e.endY) / 2 }, apply: function (nx, ny) { e.startX = nx; } });
        g.push({ x: e.endX, y: (e.startY + e.endY) / 2, type: 'pt', anchor: { x: e.startX, y: (e.startY + e.endY) / 2 }, apply: function (nx, ny) { e.endX = nx; } });
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
    if (!S.selIds.length) return;
    pushUndo();
    var del = {}; S.selIds.forEach(function (id) { del[id] = 1; });
    S.doc.entities = S.doc.entities.filter(function (e) { return !del[e.id]; });
    setSelection([]); buildLayers(); repaint();
  }

  // ── History (undo / redo) ───────────────────────────────────────
  function snapshot() { return JSON.stringify({ entities: S.doc.entities, layers: S.doc.layers }); }
  function pushUndo() { S._undo.push(snapshot()); if (S._undo.length > 60) S._undo.shift(); S._redo.length = 0; }
  function commitEntity(e) { pushUndo(); S.doc.entities.push(e); }
  function restoreSnap(json) {
    var o = JSON.parse(json);
    S.doc.entities = o.entities; S.doc.layers = o.layers;
    setSelection([]); buildLayers(); repaint();
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
    var ents = selEntities(); if (!ents.length) return;
    pushUndo();
    var gb = groupBBox(ents), cx = gb.x + gb.w / 2, cy = gb.y + gb.h / 2;
    ents.forEach(function (e) {
      transformEntity(e, function (p) { return { x: cx - (p.y - cy), y: cy + (p.x - cx) }; });
      if (e.tool === 'symbol') e.rotation = ((e.rotation || 0) + 90) % 360;
    });
    repaint();
  }
  function mirror(horiz) {
    var ents = selEntities(); if (!ents.length) return;
    pushUndo();
    var gb = groupBBox(ents), cx = gb.x + gb.w / 2, cy = gb.y + gb.h / 2;
    ents.forEach(function (e) { transformEntity(e, function (p) { return { x: horiz ? (2 * cx - p.x) : p.x, y: horiz ? p.y : (2 * cy - p.y) }; }); });
    repaint();
  }
  function duplicateSelected() {
    var ents = selEntities(); if (!ents.length) return;
    pushUndo();
    var newIds = [];
    ents.forEach(function (e) { var copy = JSON.parse(JSON.stringify(e)); copy.id = uid(copy.tool); translateEntity(copy, 14, 14); S.doc.entities.push(copy); newIds.push(copy.id); });
    setSelection(newIds); buildLayers(); repaint();
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
    var e = selEntities()[0]; if (!e) return;
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
    setSelection([last]); buildLayers(); repaint();
  }
  // Offset: a parallel copy of the selection at a real-world distance.
  function offsetOp(distFt, side) {
    var e = selEntities()[0]; if (!e) return;
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
    S.doc.entities.push(copy); setSelection([copy.id]); buildLayers(); repaint();
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
  // ── Arc geometry (center/radius/start-angle/signed-sweep) ───────
  function arcGeom(pts) {
    if (!pts || pts.length < 3) return null;
    var a = pts[0], b = pts[1], c = pts[2];
    var d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-6) return null;
    var ux = ((a.x * a.x + a.y * a.y) * (b.y - c.y) + (b.x * b.x + b.y * b.y) * (c.y - a.y) + (c.x * c.x + c.y * c.y) * (a.y - b.y)) / d;
    var uy = ((a.x * a.x + a.y * a.y) * (c.x - b.x) + (b.x * b.x + b.y * b.y) * (a.x - c.x) + (c.x * c.x + c.y * c.y) * (b.x - a.x)) / d;
    var r = Math.hypot(a.x - ux, a.y - uy);
    var a1 = Math.atan2(a.y - uy, a.x - ux), a2 = Math.atan2(b.y - uy, b.x - ux), a3 = Math.atan2(c.y - uy, c.x - ux);
    var dCcw = norm2pi(a3 - a1), mCcw = norm2pi(a2 - a1);
    var sweep = (mCcw <= dCcw) ? dCcw : -(2 * Math.PI - dCcw);
    return { cx: ux, cy: uy, r: r, a0: a1, sweep: sweep };
  }
  function norm2pi(a) { a %= 2 * Math.PI; if (a < 0) a += 2 * Math.PI; return a; }
  function arcPt(g, u) { var a = g.a0 + g.sweep * u; return { x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) }; }
  function arcPts3(g, u1, u2) { return [arcPt(g, u1), arcPt(g, (u1 + u2) / 2), arcPt(g, u2)]; }
  // Intersection angles of the full circle (g) with segment a→b that lie ON
  // the segment.
  function circleSegAngles(g, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, A = dx * dx + dy * dy;
    if (A < 1e-9) return [];
    var fx = a.x - g.cx, fy = a.y - g.cy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - g.r * g.r;
    var disc = B * B - 4 * A * C; if (disc < 0) return [];
    disc = Math.sqrt(disc); var out = [];
    [(-B - disc) / (2 * A), (-B + disc) / (2 * A)].forEach(function (t) {
      if (t < -1e-6 || t > 1 + 1e-6) return;
      out.push(Math.atan2(a.y + dy * t - g.cy, a.x + dx * t - g.cx));
    });
    return out;
  }
  // Arc param u∈[0,1] for an angle on g (or null if outside the sweep).
  function angToU(g, ang) {
    if (g.sweep >= 0) { var u = norm2pi(ang - g.a0) / g.sweep; return (u >= -1e-4 && u <= 1 + 1e-4) ? u : null; }
    var u2 = norm2pi(g.a0 - ang) / (-g.sweep); return (u2 >= -1e-4 && u2 <= 1 + 1e-4) ? u2 : null;
  }
  // Nearest 'line' entity to a sheet point within tolerance → {entity, t}.
  function pickLineAt(pt, vp) {
    var tol = 10 / S.view.scale, best = null, bestD = tol;
    (S.doc.entities || []).forEach(function (e) {
      if (e.tool !== 'line' || e.startX == null) return;
      if (vp && e.viewport !== vp.id) return;
      var ly = layerById(S.doc, e.layer);
      if (ly && (ly.visible === false || ly.locked)) return;
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
  // Nearest trim target near a point — a line OR a polyline segment.
  function pickTrimTarget(pt, vp) {
    var tol = 10 / S.view.scale, best = null, bestD = tol;
    (S.doc.entities || []).forEach(function (e) {
      if (vp && e.viewport !== vp.id) return;
      var ly = layerById(S.doc, e.layer); if (ly && (ly.visible === false || ly.locked)) return;
      if ((e.tool === 'line' || e.tool === 'refline') && e.startX != null) {
        var i0 = ptSegInfo(pt.x, pt.y, e.startX, e.startY, e.endX, e.endY);
        if (i0.dist < bestD && i0.t >= -0.03 && i0.t <= 1.03) { bestD = i0.dist; best = { entity: e, kind: 'line', t: Math.max(0, Math.min(1, i0.t)) }; }
      } else if (e.tool === 'polyline' && e.points && e.points.length > 1) {
        for (var i = 1; i < e.points.length; i++) {
          var a = e.points[i - 1], b = e.points[i], iN = ptSegInfo(pt.x, pt.y, a.x, a.y, b.x, b.y);
          if (iN.dist < bestD && iN.t >= -0.03 && iN.t <= 1.03) { bestD = iN.dist; best = { entity: e, kind: 'poly', si: i - 1, t: Math.max(0, Math.min(1, iN.t)) }; }
        }
      } else if (e.tool === 'arc' && e.points && e.points.length >= 3) {
        var sa = arcSamples(e.points, 48);
        for (var k = 1; k < sa.length; k++) {
          var iA = ptSegInfo(pt.x, pt.y, sa[k - 1].x, sa[k - 1].y, sa[k].x, sa[k].y);
          if (iA.dist < bestD) { bestD = iA.dist; best = { entity: e, kind: 'arc', u: (k - 1 + Math.max(0, Math.min(1, iA.t))) / (sa.length - 1) }; }
        }
      }
    });
    return best;
  }
  // Crossing params of an arbitrary segment a→b against other geometry.
  function segCrossParams(ax, ay, bx, by, excludeId, vp) {
    var out = [];
    segmentsInVp(vp, excludeId).forEach(function (s) {
      var t = segCrossT(ax, ay, bx, by, s.a.x, s.a.y, s.b.x, s.b.y);
      if (t != null && t > 0.0008 && t < 0.9992) out.push(t);
    });
    return out;
  }
  function trimAt(pt, vp) {
    var hit = pickTrimTarget(pt, vp); if (!hit) return;
    if (hit.kind === 'poly') return trimPoly(hit, vp);
    if (hit.kind === 'arc') return trimArc(hit, vp);
    var e = hit.entity, t0 = hit.t, ts = lineCrossParams(e, vp);
    if (!ts.length) { setHint('Trim: nothing crosses that line to cut against.'); return; }
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
    setSelection([]); buildLayers(); repaint();
  }
  // Trim the clicked segment of a polyline back to its nearest crossings,
  // splitting the polyline into the kept run(s).
  function trimPoly(hit, vp) {
    var e = hit.entity, si = hit.si, t0 = hit.t, a = e.points[si], b = e.points[si + 1];
    var ts = segCrossParams(a.x, a.y, b.x, b.y, e.id, vp);
    if (!ts.length) { setHint('Trim: nothing crosses that segment to cut against.'); return; }
    var lo = 0, hi = 1;
    ts.forEach(function (t) { if (t <= t0) lo = Math.max(lo, t); if (t >= t0) hi = Math.min(hi, t); });
    function P(t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
    pushUndo();
    var left = e.points.slice(0, si + 1); if (lo > 0.0008) left.push(P(lo));
    var right = []; if (hi < 0.9992) right.push(P(hi)); right = right.concat(e.points.slice(si + 1));
    S.doc.entities = S.doc.entities.filter(function (x) { return x.id !== e.id; });
    [left, right].forEach(function (pts) {
      if (pts.length >= 2) { var c = JSON.parse(JSON.stringify(e)); c.id = uid('polyline'); c.points = pts; S.doc.entities.push(c); }
    });
    setSelection([]); buildLayers(); repaint();
  }
  // Trim an arc to its nearest crossings around the click point.
  function trimArc(hit, vp) {
    var e = hit.entity, g = arcGeom(e.points); if (!g) return;
    var u0 = hit.u, us = [];
    segmentsInVp(vp, e.id).forEach(function (s) {
      circleSegAngles(g, s.a, s.b).forEach(function (ang) {
        var u = angToU(g, ang); if (u != null && u > 0.0015 && u < 0.9985) us.push(u);
      });
    });
    if (!us.length) { setHint('Trim: nothing crosses that arc to cut against.'); return; }
    var lo = 0, hi = 1;
    us.forEach(function (u) { if (u <= u0) lo = Math.max(lo, u); if (u >= u0) hi = Math.min(hi, u); });
    pushUndo();
    var keep = [];
    if (lo > 0.003) keep.push([0, lo]);
    if (hi < 0.997) keep.push([hi, 1]);
    S.doc.entities = S.doc.entities.filter(function (x) { return x.id !== e.id; });
    keep.forEach(function (rg) { var c = JSON.parse(JSON.stringify(e)); c.id = uid('arc'); c.points = arcPts3(g, rg[0], rg[1]); S.doc.entities.push(c); });
    setSelection([]); buildLayers(); repaint();
  }
  // Extend an arc's near end to the next boundary it meets along the circle.
  function extendArc(hit, vp) {
    var e = hit.entity, g = arcGeom(e.points); if (!g) return;
    var nearStart = hit.u < 0.5, s0 = g.sweep >= 0 ? 1 : -1, endAng = g.a0 + g.sweep;
    var bestAng = null, bestDelta = Infinity;
    segmentsInVp(vp, e.id).forEach(function (s) {
      circleSegAngles(g, s.a, s.b).forEach(function (ang) {
        var delta = nearStart
          ? ((g.sweep >= 0) ? norm2pi(g.a0 - ang) : norm2pi(ang - g.a0))
          : ((g.sweep >= 0) ? norm2pi(ang - endAng) : norm2pi(endAng - ang));
        if (delta > 1e-3 && delta < bestDelta) { bestDelta = delta; bestAng = ang; }
      });
    });
    if (bestAng == null) { setHint('Extend: no edge ahead of the arc.'); return; }
    pushUndo();
    var g2 = nearStart
      ? { cx: g.cx, cy: g.cy, r: g.r, a0: g.a0 - s0 * bestDelta, sweep: g.sweep + s0 * bestDelta }
      : { cx: g.cx, cy: g.cy, r: g.r, a0: g.a0, sweep: g.sweep + s0 * bestDelta };
    e.points = arcPts3(g2, 0, 1);
    buildLayers(); repaint();
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
  // Extend the ray from a fixed point through a moving point to the
  // nearest boundary ahead; returns the hit point (or null).
  function extendHit(fx, fy, mx, my, excludeId, vp) {
    var dx = mx - fx, dy = my - fy, best = null, bestU = Infinity;
    segmentsInVp(vp, excludeId).forEach(function (s) {
      var u = rayHitU(fx, fy, dx, dy, s.a.x, s.a.y, s.b.x, s.b.y);
      if (u != null && u > 1.0005 && u < bestU) { bestU = u; best = { x: fx + dx * u, y: fy + dy * u }; }
    });
    return best;
  }
  function extendAt(pt, vp) {
    var hit = pickTrimTarget(pt, vp); if (!hit) return;
    if (hit.kind === 'poly') return extendPoly(hit, vp);
    if (hit.kind === 'arc') return extendArc(hit, vp);
    var e = hit.entity;
    var ds = Math.hypot(pt.x - e.startX, pt.y - e.startY), de = Math.hypot(pt.x - e.endX, pt.y - e.endY);
    var movingStart = ds < de;
    var fx = movingStart ? e.endX : e.startX, fy = movingStart ? e.endY : e.startY;
    var mx = movingStart ? e.startX : e.endX, my = movingStart ? e.startY : e.endY;
    var best = extendHit(fx, fy, mx, my, e.id, vp);
    if (!best) { setHint('Extend: no edge ahead to extend to.'); return; }
    pushUndo();
    if (movingStart) { e.startX = best.x; e.startY = best.y; } else { e.endX = best.x; e.endY = best.y; }
    buildLayers(); repaint();
  }
  // Extend a polyline's first/last vertex (whichever end the click is near)
  // along its end segment to the nearest boundary.
  function extendPoly(hit, vp) {
    var e = hit.entity, pts = e.points, last = pts.length - 1;
    var nearStart = (hit.si === 0 && hit.t < 0.5), nearEnd = (hit.si === last - 1 && hit.t > 0.5);
    if (!nearStart && !nearEnd) { setHint('Extend: click near a polyline END to extend it.'); return; }
    var mi = nearStart ? 0 : last, fi = nearStart ? 1 : last - 1;
    var best = extendHit(pts[fi].x, pts[fi].y, pts[mi].x, pts[mi].y, e.id, vp);
    if (!best) { setHint('Extend: no edge ahead to extend to.'); return; }
    pushUndo();
    pts[mi] = { x: best.x, y: best.y };
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
    renderSheet(ctx, S.doc, { paperShadow: true, grid: S.gridSnap, viewScale: S.view.scale, editor: true });
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
        var prev = { tool: d._circle ? 'ellipse' : (d.tool === 'refline' ? 'line' : d.tool), color: '#4f8cff', lineWidth: d.lineWidth || 3 };
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
    // selection highlight — every selected entity (dashed green box)
    if (S.selIds && S.selIds.length) {
      ctx.save(); ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 1.5 / S.view.scale; ctx.setLineDash([6 / S.view.scale, 4 / S.view.scale]);
      selEntities().forEach(function (sel) { var bb = entBBox(sel); if (bb) ctx.strokeRect(bb.x - 4, bb.y - 4, bb.w + 8, bb.h + 8); });
      ctx.restore();
    }
    // rubber-band selection box (window = solid blue · crossing = dashed green)
    if (S.boxSel) {
      var b = S.boxSel, crossing = b.start.x > b.last.x;
      var bx0 = Math.min(b.start.x, b.last.x), by0 = Math.min(b.start.y, b.last.y);
      var bw = Math.abs(b.last.x - b.start.x), bh = Math.abs(b.last.y - b.start.y);
      ctx.save();
      ctx.strokeStyle = crossing ? '#22c55e' : '#4f8cff';
      ctx.fillStyle = crossing ? 'rgba(34,197,94,0.08)' : 'rgba(79,140,255,0.08)';
      ctx.lineWidth = 1 / S.view.scale;
      if (crossing) ctx.setLineDash([5 / S.view.scale, 4 / S.view.scale]); else ctx.setLineDash([]);
      ctx.fillRect(bx0, by0, bw, bh); ctx.strokeRect(bx0, by0, bw, bh);
      ctx.restore();
    }
    ctx.restore();
    // selection grips (screen space) — only for a SINGLE selection (reshape).
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
      var sk = S.snap.kind;
      ctx.strokeStyle = sk === 'grid' ? '#64748b' : (sk === 'intersect' ? '#f472b6' : (sk === 'perp' || sk === 'near' ? '#34d399' : (sk === 'quad' || sk === 'node' ? '#a78bfa' : '#fbbf24')));
      ctx.lineWidth = 1.5;
      if (sk === 'mid') { ctx.beginPath(); ctx.moveTo(sp.x - 6, sp.y + 5); ctx.lineTo(sp.x, sp.y - 6); ctx.lineTo(sp.x + 6, sp.y + 5); ctx.closePath(); ctx.stroke(); }
      else if (sk === 'center') { ctx.beginPath(); ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2); ctx.stroke(); }
      else if (sk === 'grid') { ctx.beginPath(); ctx.moveTo(sp.x - 4, sp.y); ctx.lineTo(sp.x + 4, sp.y); ctx.moveTo(sp.x, sp.y - 4); ctx.lineTo(sp.x, sp.y + 4); ctx.stroke(); }
      else if (sk === 'intersect') { ctx.beginPath(); ctx.moveTo(sp.x - 5, sp.y - 5); ctx.lineTo(sp.x + 5, sp.y + 5); ctx.moveTo(sp.x + 5, sp.y - 5); ctx.lineTo(sp.x - 5, sp.y + 5); ctx.stroke(); }
      else if (sk === 'perp') { ctx.beginPath(); ctx.moveTo(sp.x - 6, sp.y - 6); ctx.lineTo(sp.x - 6, sp.y + 6); ctx.lineTo(sp.x + 6, sp.y + 6); ctx.moveTo(sp.x - 6, sp.y + 1); ctx.lineTo(sp.x + 1, sp.y + 1); ctx.lineTo(sp.x + 1, sp.y + 6); ctx.stroke(); }   // ⟂
      else if (sk === 'near') { ctx.beginPath(); ctx.moveTo(sp.x - 6, sp.y - 6); ctx.lineTo(sp.x + 6, sp.y - 6); ctx.lineTo(sp.x - 6, sp.y + 6); ctx.lineTo(sp.x + 6, sp.y + 6); ctx.stroke(); }   // hourglass
      else if (sk === 'quad') { ctx.beginPath(); ctx.moveTo(sp.x, sp.y - 6); ctx.lineTo(sp.x + 6, sp.y); ctx.lineTo(sp.x, sp.y + 6); ctx.lineTo(sp.x - 6, sp.y); ctx.closePath(); ctx.stroke(); }   // diamond
      else if (sk === 'node') { ctx.beginPath(); ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2); ctx.moveTo(sp.x - 6, sp.y); ctx.lineTo(sp.x + 6, sp.y); ctx.moveTo(sp.x, sp.y - 6); ctx.lineTo(sp.x, sp.y + 6); ctx.stroke(); }   // ⊙
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

  // ── DXF export (ASCII R12-ish) ──────────────────────────────────
  // Serializes the sheet's entities to real-world inches so the drawing
  // opens to scale in AutoCAD / any CAD app. Each viewport's geometry is
  // converted by its own scale (px → real inches) and laid left-to-right;
  // Y is flipped (DXF is Y-up). DWG is a closed binary format — not
  // generatable client-side — so we emit DXF, which every CAD app imports.
  function buildDxf(doc) {
    var s = doc.sheet, NL = '\n';
    function g(code, val) { return code + NL + val + NL; }
    function nm(v) { return String(v == null ? '0' : v).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 255) || '0'; }
    function n6(x) { return Math.round((x || 0) * 1e6) / 1e6; }
    function vpPpi(vp) { return (vp && vp.scale && vp.scale.pixelsPerInch) ? vp.scale.pixelsPerInch : DPI * 0.25 / 12; }
    function lineDxf(L, a, b) { return g(0, 'LINE') + g(8, L) + g(10, n6(a.x)) + g(20, n6(a.y)) + g(30, 0) + g(11, n6(b.x)) + g(21, n6(b.y)) + g(31, 0); }
    function circleDxf(L, c, r) { return g(0, 'CIRCLE') + g(8, L) + g(10, n6(c.x)) + g(20, n6(c.y)) + g(30, 0) + g(40, n6(r)); }
    function textDxf(L, p, h, str) { return g(0, 'TEXT') + g(8, L) + g(10, n6(p.x)) + g(20, n6(p.y)) + g(30, 0) + g(40, n6(Math.max(0.5, h))) + g(1, String(str).replace(/[\r\n]+/g, ' ')); }
    function polyDxf(L, pts, closed) { var o = ''; for (var i = 1; i < pts.length; i++) o += lineDxf(L, pts[i - 1], pts[i]); if (closed && pts.length > 2) o += lineDxf(L, pts[pts.length - 1], pts[0]); return o; }
    function arcDxf(L, p) {
      var a = p[0], b = p[1], c = p[2];
      var d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
      if (Math.abs(d) < 1e-6) return lineDxf(L, a, c);
      var ux = ((a.x * a.x + a.y * a.y) * (b.y - c.y) + (b.x * b.x + b.y * b.y) * (c.y - a.y) + (c.x * c.x + c.y * c.y) * (a.y - b.y)) / d;
      var uy = ((a.x * a.x + a.y * a.y) * (c.x - b.x) + (b.x * b.x + b.y * b.y) * (a.x - c.x) + (c.x * c.x + c.y * c.y) * (b.x - a.x)) / d;
      var r = Math.hypot(a.x - ux, a.y - uy);
      function ang(P) { var t = Math.atan2(P.y - uy, P.x - ux) * 180 / Math.PI; return (t + 360) % 360; }
      var a1 = ang(a), a2 = ang(b), a3 = ang(c);
      var ccwSpan = (a3 - a1 + 360) % 360, midSpan = (a2 - a1 + 360) % 360;
      var sA = (midSpan <= ccwSpan) ? a1 : a3, eA = (midSpan <= ccwSpan) ? a3 : a1;   // DXF ARC is CCW start→end
      return g(0, 'ARC') + g(8, L) + g(10, n6(ux)) + g(20, n6(uy)) + g(30, 0) + g(40, n6(r)) + g(50, n6(sA)) + g(51, n6(eA));
    }
    var vps = doc.viewports || [], offsets = {}, offX = 0;
    vps.forEach(function (vp) { var ppi = vpPpi(vp); offsets[vp.id] = { x: offX, ppi: ppi, vp: vp }; offX += (vp.w / ppi) + 24; });
    function omap(e, px, py) {
      var o = offsets[e.viewport] || offsets[(vps[0] || {}).id] || { x: 0, ppi: DPI * 0.25 / 12, vp: { x: 0, y: 0, h: s.h } };
      return { x: (px - o.vp.x) / o.ppi + o.x, y: (o.vp.y + o.vp.h - py) / o.ppi };
    }
    function lyr(e) { var l = layerById(doc, e.layer); return nm(l && l.name); }

    var out = '';
    out += g(0, 'SECTION') + g(2, 'HEADER') + g(9, '$INSUNITS') + g(70, 1) + g(0, 'ENDSEC');   // 1 = inches
    var layers = doc.layers || [];
    out += g(0, 'SECTION') + g(2, 'TABLES') + g(0, 'TABLE') + g(2, 'LAYER') + g(70, layers.length || 1);
    if (!layers.length) out += g(0, 'LAYER') + g(2, '0') + g(70, 0) + g(62, 7) + g(6, 'CONTINUOUS');
    layers.forEach(function (l) { out += g(0, 'LAYER') + g(2, nm(l.name)) + g(70, 0) + g(62, 7) + g(6, 'CONTINUOUS'); });
    out += g(0, 'ENDTAB') + g(0, 'ENDSEC');
    out += g(0, 'SECTION') + g(2, 'ENTITIES');
    (doc.entities || []).forEach(function (e) {
      if (!e || !e.tool) return;
      if (e.tool === 'refline') return;   // construction guide — never exported
      var L = lyr(e);
      try {
        if (e.tool === 'line' || e.tool === 'arrow') { out += lineDxf(L, omap(e, e.startX, e.startY), omap(e, e.endX, e.endY)); }
        else if (e.tool === 'measure') { var a = omap(e, e.startX, e.startY), b = omap(e, e.endX, e.endY); out += lineDxf(L, a, b); if (e.measureLabel) out += textDxf(L, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 4, e.measureLabel); }
        else if (e.tool === 'rect') { var p1 = omap(e, e.startX, e.startY), p2 = omap(e, e.endX, e.startY), p3 = omap(e, e.endX, e.endY), p4 = omap(e, e.startX, e.endY); out += lineDxf(L, p1, p2) + lineDxf(L, p2, p3) + lineDxf(L, p3, p4) + lineDxf(L, p4, p1); }
        else if (e.tool === 'ellipse') {
          var cx = (e.startX + e.endX) / 2, cy = (e.startY + e.endY) / 2, rxp = Math.abs(e.endX - e.startX) / 2, ryp = Math.abs(e.endY - e.startY) / 2;
          var o = offsets[e.viewport] || { ppi: DPI * 0.25 / 12 };
          if (Math.abs(rxp - ryp) < 0.75) { out += circleDxf(L, omap(e, cx, cy), rxp / o.ppi); }
          else { var pts = []; for (var k = 0; k <= 48; k++) { var th = k / 48 * 2 * Math.PI; pts.push(omap(e, cx + rxp * Math.cos(th), cy + ryp * Math.sin(th))); } out += polyDxf(L, pts, true); }
        }
        else if (e.tool === 'arc' && e.points && e.points.length >= 3) { out += arcDxf(L, e.points.map(function (p) { return omap(e, p.x, p.y); })); }
        else if ((e.tool === 'polyline' || e.tool === 'mangle' || e.tool === 'hatch') && e.points && e.points.length) { out += polyDxf(L, e.points.map(function (p) { return omap(e, p.x, p.y); }), e.tool === 'hatch'); }
        else if (e.tool === 'text' && e.x != null) { var ot = offsets[e.viewport] || { ppi: DPI * 0.25 / 12 }; out += textDxf(L, omap(e, e.x, e.y), (e.fontPx || 24) / ot.ppi, e.text || ''); }
        else if (e.tool === 'symbol' && e.x != null) { var os = offsets[e.viewport] || { ppi: DPI * 0.25 / 12 }; out += circleDxf(L, omap(e, e.x, e.y), (e.size || 40) / 2 / os.ppi); }
        else if (e.tool === 'level') { var la = omap(e, e.startX, e.startY), lb = omap(e, e.endX, e.endY); out += lineDxf(L, la, lb) + textDxf(L, { x: Math.max(la.x, lb.x), y: la.y }, 5, fmtFeet(e.elevIn || 0)); }
        else if (e.tool === 'spotelev' && e.x != null) { var oe = offsets[e.viewport] || { ppi: DPI * 0.25 / 12 }, sp = omap(e, e.x, e.y); out += circleDxf(L, sp, (DPI * 0.1) / oe.ppi) + textDxf(L, { x: sp.x, y: sp.y }, 5, '+' + fmtFeet(elevAtPoint(e))); }
      } catch (err) { /* skip a malformed entity, keep exporting */ }
    });
    out += g(0, 'ENDSEC') + g(0, 'EOF');
    return out;
  }
  function exportDxf() {
    try {
      var dxf = buildDxf(S.doc);
      var blob = new Blob([dxf], { type: 'application/dxf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = (String(S.plan && S.plan.name || 'sheet').replace(/[^a-z0-9._-]+/gi, '_')) + '.dxf';
      document.body.appendChild(a); a.click();
      setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); try { URL.revokeObjectURL(url); } catch (e) {} }, 0);
    } catch (e) { alert('DXF export failed: ' + (e && e.message ? e.message : 'unknown')); }
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
        var dxfBtn = S.overlay.querySelector('#p86-sheet-dxf'); if (dxfBtn) dxfBtn.onclick = exportDxf;
        var setBtn = S.overlay.querySelector('#p86-sheet-settings'); if (setBtn) setBtn.onclick = openSettingsModal;
        var scBtn = S.overlay.querySelector('#p86-sheet-shortcuts'); if (scBtn) scBtn.onclick = openShortcuts;
      }
    },
    close: close,
    defaultDoc: defaultDoc,
    buildDxf: buildDxf,
    SHEET_SIZES: SHEET_SIZES,
    DPI: DPI
  };
})();
