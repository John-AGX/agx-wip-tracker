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
//   (Type-in length/angle, intersection + perpendicular snaps, the arc
//        tool, and drag-move/rotate — once deferred — are all implemented
//        now, along with the takeoff underlay + calibration in Tier 1.)
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
    { key: 'ellipse',  glyph: '⬭', name: 'Ellipse',    group: 'Draw',     label: 'Ellipse (click two opposite corners of its bounding box)' },
    { key: 'polygon',  glyph: '⬠', name: 'Polygon',    group: 'Draw',     label: 'Regular polygon (click the center, click a vertex, then type the number of sides)' },
    { key: 'spline',   glyph: '∿', name: 'Spline',     group: 'Draw',     label: 'Spline — click control points; double-click / Enter to finish. Drawn as a smooth curve through the points.' },
    { key: 'trim',     glyph: '✂', name: 'Trim',       group: 'Modify',   label: 'Trim — click a line segment to cut it back to the nearest crossing line' },
    { key: 'extend',   glyph: '⇥', name: 'Extend',     group: 'Modify',   label: 'Extend — click a line near the end to extend it to the next line it meets' },
    { key: 'fillet',   glyph: '◜', name: 'Fillet',     group: 'Modify',   label: 'Fillet — click two lines, then enter a radius (0 = sharp corner)' },
    { key: 'break',    glyph: '⊟', name: 'Break',      group: 'Modify',   label: 'Break — click a point on a line to split it into two segments there' },
    { key: 'chamfer',  glyph: '◣', name: 'Chamfer',    group: 'Modify',   label: 'Chamfer — click two lines, then enter a setback distance (0 = sharp corner)' },
    { key: 'polararray', glyph: '❋', name: 'Polar array', group: 'Modify', label: 'Polar array — select objects first, then click a center point and enter the count to array them around it' },
    { key: 'stretch',  glyph: '⇲', name: 'Stretch',    group: 'Modify',   label: 'Stretch — click two corners of a crossing window (vertices inside move, the rest stays), then click a base + destination point' },
    { key: 'dim',      glyph: '↔', name: 'Dimension',  group: 'Annotate', label: 'Dimension (aligned — click two points; auto-labels real length along the line at the viewport scale)' },
    { key: 'dimradius',glyph: 'R', name: 'Radius dim',  group: 'Annotate', label: 'Radius dimension — click a circle / ellipse; labels its radius (R …)' },
    { key: 'dimdia',   glyph: '⌀', name: 'Diameter dim',group: 'Annotate', label: 'Diameter dimension — click a circle / ellipse; labels its diameter (⌀ …)' },
    { key: 'dimcont',  glyph: '⊢', name: 'Continuous',  group: 'Annotate', label: 'Continuous dimension chain — click points in a row; each span is dimensioned (Enter / Esc to finish)' },
    { key: 'angle',    glyph: '∠', name: 'Angle dim',  group: 'Annotate', label: 'Angle dimension (click three points: leg · vertex · leg)' },
    { key: 'leader',   glyph: '➘', name: 'Leader',     group: 'Annotate', label: 'Leader / callout (click target, click text position)' },
    { key: 'revcloud', glyph: '☁', name: 'Rev cloud',  group: 'Annotate', label: 'Revision cloud — click two opposite corners; drawn as a scalloped cloud around that box' },
    { key: 'text',     glyph: 'T', name: 'Text',       group: 'Annotate', label: 'Text (click to place)' },
    { key: 'hatch',    glyph: '▨', name: 'Hatch',      group: 'Annotate', label: 'Hatch fill (click a closed region; pick a material pattern) — double-click / Enter to close' },
    { key: 'symbol',   glyph: '✱', name: 'Symbol',     group: 'Annotate', label: 'Symbol / block (north arrow, sprinkler head, post, tree, callout)' },
    { key: 'level',    glyph: '↧', name: 'Level',      group: 'Annotate', label: 'Level / elevation line — horizontal datum at a set elevation (e.g. 10\') with a head marker. Prints. The first one sets the datum.' },
    { key: 'spotelev', glyph: '⌖', name: 'Spot elev',  group: 'Annotate', label: 'Spot elevation — click any point to tag its height above the level datum. Prints.' },
    { key: 'refline',  glyph: '┈', name: 'Ref line',   group: 'Annotate', label: 'Reference line (construction guide — snaps & trims to, but is NOT printed or exported)' },
    { key: 'inquire',  glyph: '⊾', name: 'Measure',    group: 'View',     label: 'Measure / inquiry — click points for distance, angle, running total & enclosed area. Does NOT print. Enter/Esc clears.' },
    { key: 'calibrate',glyph: '📐', name: 'Calibrate',  group: 'View',     label: 'Calibrate scale — click two points a known distance apart on the plan underlay, then type the real length (e.g. 20\'). Sets this viewport\'s scale so every measurement reads true.' },
    { key: 'pan',      glyph: '✋', name: 'Pan',        group: 'View',     label: 'Pan (or hold Space / middle-drag)' }
  ];
  // Non-tool buttons (edit ops + history/util) shown in the drawer, grouped.
  var EDIT_ITEMS = [
    { key: 'rotate',  act: 'edit', glyph: '⟳', name: 'Rotate 90°', group: 'Modify', label: 'Rotate selection 90°' },
    { key: 'mirrorH', act: 'edit', glyph: '⇆', name: 'Mirror H',   group: 'Modify', label: 'Mirror selection (horizontal)' },
    { key: 'mirrorV', act: 'edit', glyph: '⇅', name: 'Mirror V',   group: 'Modify', label: 'Mirror selection (vertical)' },
    { key: 'dup',     act: 'edit', glyph: '⧉', name: 'Duplicate',  group: 'Modify', label: 'Duplicate selection (Ctrl+D)' },
    { key: 'offset',  act: 'edit', glyph: '⎘', name: 'Offset',     group: 'Modify', label: 'Offset selection by a distance (line / polyline / rect / circle)' },
    { key: 'scale',   act: 'edit', glyph: '⤧', name: 'Scale',      group: 'Modify', label: 'Scale selection uniformly by a factor (e.g. 2 = double, 0.5 = half) about its center' },
    { key: 'explode', act: 'edit', glyph: '✺', name: 'Explode',    group: 'Modify', label: 'Explode a rectangle / polyline into individual line segments' },
    { key: 'join',    act: 'edit', glyph: '⛓', name: 'Join',       group: 'Modify', label: 'Join selected connected lines into a single polyline' },
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
    m: 'inquire', v: 'pan'
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
    { label: '1" = 20\'', f: 1 / 240 }, { label: '1" = 30\'', f: 1 / 360 },
    // Fine / full-size scales for small parts (sheet-metal cutouts, details).
    // f = paper-inches per real-inch, so ppi = DPI*f. unit:'in' → inch readouts
    // + inch scale bar. 1:1 = true size; 2:1/4:1 enlarge tiny parts; 1:2 shrinks big ones.
    { label: '1:1 (full size)', f: 1, unit: 'in' },
    { label: '2:1 (2× detail)', f: 2, unit: 'in' },
    { label: '4:1 (4× detail)', f: 4, unit: 'in' },
    { label: '1:2 (half size)', f: 0.5, unit: 'in' }
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
    var d = (Array.isArray(pages) && pages[0] && pages[0].kind === 'sheet-doc') ? pages[0] : defaultDoc(plan);
    return toV2(d);
  }
  // ── Model / paper-space data model — v2 (Option 2, Phase A) ──────
  // v2 separates the drawing (model.entities = real geometry) from the sheets
  // (paper space: titleblock + viewports). This Phase-A step is NON-DESTRUCTIVE
  // and changes no behaviour: v2 wraps the existing v1 objects as ALIASES —
  // doc.entities ⇄ doc.model.entities, and doc.viewports/titleblock/sheet ⇄ the
  // active sheet — so today's editor reads exactly what it read before. Later
  // phases add the Model/Sheet UI + the viewport transform.
  function toV2(doc) {
    if (!doc) return doc;
    if (doc.version === 2 && doc.model && doc.sheets) {
      // Saved v2 (flat aliases were stripped on save) — rebuild the aliases.
      var sh = null;
      for (var i = 0; i < doc.sheets.length; i++) { if (doc.sheets[i].id === doc.activeSheetId) { sh = doc.sheets[i]; break; } }
      if (!sh) sh = doc.sheets[0] || (doc.sheets[0] = { id: 'S1', viewports: [] });
      if (!doc.model.entities) doc.model.entities = [];
      if (!doc.model.layers) doc.model.layers = [];
      if (!sh.viewports) sh.viewports = [];
      doc.entities = doc.model.entities;
      doc.layers = doc.model.layers;
      doc.viewports = sh.viewports;
      doc.titleblock = sh.titleblock || (sh.titleblock = {});
      doc.sheet = sh;                                 // sheet object carries size/w/h/margin
      if (!doc.activeSheetId) doc.activeSheetId = sh.id;
      if (!doc.space) doc.space = 'sheet';
      return doc;
    }
    // v1 → v2: build model + a single sheet that ALIAS the existing objects.
    doc.version = 2;
    doc.model = { entities: doc.entities || (doc.entities = []), layers: doc.layers || (doc.layers = []) };
    var s0 = doc.sheet || {};
    var sheet = {
      id: 'S1', name: (doc.titleblock && doc.titleblock.sheetNo) || 'A-1',
      size: s0.size, w: s0.w, h: s0.h, margin: s0.margin,
      titleblock: doc.titleblock || null,
      viewports: doc.viewports || (doc.viewports = [])
    };
    doc.sheets = [sheet];
    doc.sheet = sheet;                                 // editor's sheet dims ⇄ the v2 sheet
    doc.titleblock = sheet.titleblock;                 // keep titleblock alias shared
    doc.activeSheetId = 'S1';
    doc.space = 'sheet';
    return doc;
  }
  // Persist clean v2 — model + sheets are the source of truth; the flat working
  // aliases are rebuilt by toV2() on load, so strip them to avoid duplicating
  // the geometry in the blob. SAFE: only strip when the v2 structure provably
  // holds the data (model.entities is the live array + sheets exist); otherwise
  // keep the flat fields so a bug can never lose data (worst case = larger blob).
  function serializeDoc(doc) {
    var out = {};
    for (var k in doc) { if (Object.prototype.hasOwnProperty.call(doc, k)) out[k] = doc[k]; }
    out.kind = 'sheet-doc'; out.version = 2;
    if (out.model && out.model.entities === out.entities && Array.isArray(out.sheets) && out.sheets.length) {
      delete out.entities; delete out.layers; delete out.viewports; delete out.sheet; delete out.titleblock;
    }
    return out;
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
    if (opts.paperShadow && !opts.modelMode) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 34; ctx.shadowOffsetY = 12;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, s.w, s.h);
      ctx.restore();
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s.w, s.h);
    // Sheet chrome (paper border) — hidden in model space (chrome-free working view).
    if (!opts.modelMode) {
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 6;
      ctx.strokeRect(s.margin, s.margin, s.w - s.margin * 2, s.h - s.margin * 2);
      ctx.lineWidth = 2;
      ctx.strokeRect(s.margin + 10, s.margin + 10, s.w - s.margin * 2 - 20, s.h - s.margin * 2 - 20);
    }

    (doc.viewports || []).forEach(function (vp) {
      ctx.save();
      // Viewport frame + clip — sheet space only. In model space we draw the
      // geometry free (no titleblock/viewport window), so skip the frame + clip.
      if (!opts.modelMode) {
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([14, 8]);
        ctx.strokeRect(vp.x, vp.y, vp.w, vp.h);
        ctx.setLineDash([]);
        // clip entities to the viewport frame
        ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.w, vp.h); ctx.clip();
      }
      // Plan underlay (Tier 1) — drawn first so it sits behind grid + entities.
      try { drawUnderlay(ctx, vp); } catch (err) { /* defensive */ }
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
            var mlbl = fmtLen(e.measureInches);
            if (e.dimKind === 'radius') mlbl = 'R ' + mlbl;
            else if (e.dimKind === 'diameter') mlbl = '⌀ ' + mlbl;   // ⌀
            e.measureLabel = mlbl;
          }
          try { prims().drawStroke(ctx, e); } catch (err) { /* defensive */ }
        });
      }
      try { drawScaleBar(ctx, vp); } catch (err) { /* defensive */ }
      ctx.restore();
      // label bar (outside clip) — sheet space only
      if (!opts.modelMode) {
        ctx.fillStyle = '#1f2937';
        ctx.font = '700 ' + Math.round(DPI * 0.18) + 'px Arial, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText(vp.label + '    ' + (vp.scale && vp.scale.label ? vp.scale.label : ''),
          vp.x + 4, vp.y - 6);
      }
    });

    // North arrow + titleblock are sheet-space presentation — hidden in model space.
    if (!opts.modelMode) {
      drawNorthArrow(ctx, doc);
      drawTitleblock(ctx, doc);
    }
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
  // Nice round INCH length for fine/full-size scales (sheet-metal detail bars).
  function niceScaleInches(ppi, maxPx) {
    var cand = [0.25, 0.5, 1, 2, 3, 6, 12, 24, 48], best = cand[0];
    for (var i = 0; i < cand.length; i++) if (cand[i] * ppi <= maxPx) best = cand[i];
    return best;
  }
  // Graphic scale bar in a viewport's bottom-left — stays true when printed.
  function drawScaleBar(ctx, vp) {
    if (!vp.scale || !vp.scale.pixelsPerInch) return;
    var ppi = vp.scale.pixelsPerInch;
    var inchMode = (vp.scale.unit === 'in');
    var barPx, endLbl;
    if (inchMode) { var inLen = niceScaleInches(ppi, vp.w * 0.32); barPx = inLen * ppi; endLbl = inLen + '"'; }
    else { var ft = niceScaleFeet(ppi, vp.w * 0.32); barPx = ft * 12 * ppi; endLbl = ft + ' ft'; }
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
    ctx.textAlign = 'right'; ctx.fillText(endLbl, bx + barPx + 2, by - 3);
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
  // Grid spacing in sheet-px. Fine / full-size scales (unit:'in') get an INCH grid
  // (1" minor / 12" major) so small parts are precise; architectural scales keep
  // the 1-ft grid (×5 major). Shared by the visual grid + grid-snap so they agree.
  function gridStepPx(vp) {
    if (!vp || !vp.scale || !vp.scale.pixelsPerInch) return 0;
    return (vp.scale.unit === 'in')
      ? vp.scale.pixelsPerInch * (SETTINGS.gridIn || 1)
      : vp.scale.pixelsPerInch * 12 * (SETTINGS.gridFt || 1);
  }
  function gridMajorMult(vp) { return (vp && vp.scale && vp.scale.unit === 'in') ? 12 : 5; }
  function drawViewportGrid(ctx, vp, viewScale) {
    var step = gridStepPx(vp);                       // grid spacing, sheet px (unit-aware)
    if (!step || step * viewScale < 7) return;       // too dense at this zoom
    var x0 = vp.x, y0 = vp.y, x1 = vp.x + vp.w, y1 = vp.y + vp.h, x, y;
    ctx.save();
    ctx.strokeStyle = 'rgba(37,99,235,0.09)'; ctx.lineWidth = 1 / viewScale;
    for (x = x0; x <= x1 + 0.5; x += step) { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); }
    for (y = y0; y <= y1 + 0.5; y += step) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
    var major = step * gridMajorMult(vp);
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
    // Optional bridge: a caller may pass an underlay to seed a fresh takeoff.
    if (opts.underlay && !doc.underlay) doc.underlay = opts.underlay;

    var ov = document.createElement('div');
    ov.id = 'p86-sheet-overlay';
    ov.tabIndex = -1;
    ov.style.cssText = 'position:fixed;inset:0;background:#0b0e14;z-index:5200;display:flex;flex-direction:column;padding:14px;outline:none;';
    ov.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;background:rgba(15,15,30,0.95);border:1px solid #2a2a3a;border-radius:10px;padding:8px 14px;">' +
        '<strong style="color:#fff;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📐 ' + esc(plan.name || 'Shop drawing') + '</strong>' +
        '<div id="p86-space-seg" title="Model = draw at true size, no titleblock (working / cutout view) · Sheet = the titleblocked sheet for printing" style="display:flex;border:1px solid #3a3a4a;border-radius:7px;overflow:hidden;margin-right:2px;">' +
          '<button id="p86-space-model" data-space="model" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:0;border-right:1px solid #3a3a4a;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">▦ Model</button>' +
          '<button id="p86-space-sheet" data-space="sheet" style="background:#4f8cff;color:#fff;border:0;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">▭ Sheet</button>' +
        '</div>' +
        '<button id="p86-sheet-settings" title="Editor settings &amp; defaults (units, scale, sheet size, grid, snaps)" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 11px;font-size:13px;cursor:pointer;">⚙</button>' +
        '<button id="p86-sheet-shortcuts" title="Keyboard shortcuts (?)" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 11px;font-size:13px;cursor:pointer;">⌨</button>' +
        '<button id="p86-sheet-underlay" title="Import a plan PDF/image as a scaled background to trace + measure over (takeoff)" style="background:rgba(79,140,255,0.14);color:#cbd5e1;border:1px solid #4f8cff;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;">⊞ Underlay</button>' +
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
      tool: 'select',
      space: 'sheet',       // Phase B: 'sheet' = titleblocked paper (default) | 'model' = chrome-free true-size working view
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
    S.canvas.style.cursor = 'default';     // default tool is Select
    repaint();
    ensureUnderlay();                       // load a persisted plan underlay, if any
    loadOrgBrand();

    ov.focus();
    window.addEventListener('resize', onResize);
    S.onResize = onResize;
    // Unsaved-changes guard — autosave flushes on idle, but if the user closes
    // the tab mid-edit we flush once more + warn (Tier 2).
    S._beforeUnload = function (ev) {
      if (S && S._dirty) { saveSilent(); ev.preventDefault(); ev.returnValue = ''; return ''; }
    };
    window.addEventListener('beforeunload', S._beforeUnload);
    validateScale();                        // warn on orphan viewport links / unset scale
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

  function close() {
    if (!S) return;
    hideContextMenu();
    if (S._dirty) saveSilent();                       // flush any pending edits
    if (S._beforeUnload) window.removeEventListener('beforeunload', S._beforeUnload);
    if (S._autosaveT) clearTimeout(S._autosaveT);
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
          else if (k === 'scale') scaleSel();
          else if (k === 'explode') explodeSel();
          else if (k === 'join') joinSel();
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
    if (v) {
      var avp = S.hoverVp || (S.doc.viewports && S.doc.viewports[0]);
      var slbl = (avp && avp.scale && avp.scale.label) ? avp.scale.label : '';
      // An imported plan underlay has an arbitrary scale until calibrated —
      // warn instead of implying the preset is meaningful.
      var warn = (S.doc.underlay && avp && !(avp.scale && avp.scale.calibrated))
        ? '⚠ SCALE NOT SET — calibrate'
        : (S._scaleWarn ? ('⚠ ' + S._scaleWarn) : '');
      if (warn) slbl = warn;
      v.textContent = avp ? (avp.label + '  ·  ' + slbl) : '';
      v.style.color = warn ? '#f87171' : '#64748b';
    }
    var z = S.overlay.querySelector('#p86-sb-zoom');
    if (z) z.textContent = Math.round((S.view.scale || 1) * 100) + '%';
  }
  function setTool(t) {
    if (S.draft) S.draft = null;             // cancel any in-progress draft
    S._filletA = null; S._chamferA = null; S._stretch = null; S._dimcont = null;   // cancel pending fillet/chamfer/stretch/cont-dim
    S.inq = null;                            // clear any measure/inquiry path
    S._calib = null;                         // cancel any in-progress calibration
    S._poly = null;                          // cancel any in-progress polygon
    hideDyn();
    S.tool = t;
    // Track last/recent drawing commands for Enter-repeat + the right-click menu.
    if (t && t !== 'select' && t !== 'pan' && t !== 'calibrate') {
      S._lastTool = t;
      S._recentTools = (S._recentTools || []).filter(function (x) { return x !== t; });
      S._recentTools.unshift(t); S._recentTools = S._recentTools.slice(0, 5);
    }
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
    vp.scale = { pixelsPerInch: DPI * preset.f, unit: preset.unit || 'ft', label: preset.label };
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
    // ── Multi-selection summary (2+ objects) ──
    if (S.selIds && S.selIds.length > 1) {
      html += '<div style="border:1px solid #4f8cff;background:rgba(79,140,255,0.08);border-radius:8px;padding:8px 9px;margin-bottom:12px;">' +
        '<div style="font-weight:700;color:#fff;display:flex;align-items:center;gap:6px;">⛶ ' + S.selIds.length + ' objects selected' +
          '<button data-prop-del style="margin-left:auto;background:transparent;border:0;color:#f87171;cursor:pointer;font-size:12px;">✕ Delete</button></div>' +
        '<div style="margin-top:6px;font-size:9.5px;color:#64748b;">Drag to move all · ⟳ rotate · ⇆⇅ mirror · Ctrl+D dup — all together.</div>' +
      '</div>';
    }
    // ── Properties (single selected object) ──
    var selEnt = S.selectedId ? selectedEntity() : null;
    var selPpi = selEnt ? ppiOf(selEnt) : 1;
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
        propGeomHtml(selEnt, selPpi) +
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
    // Geometry edits — recompute the entity from typed real-world values.
    var pLen = host.querySelector('[data-prop-len]'), pAng = host.querySelector('[data-prop-ang]');
    function applyLine() {
      var e = selectedEntity(); if (!e) return;
      var lenIn = parseLenIn(pLen.value); var ang = parseFloat(pAng.value);
      if (lenIn == null || !isFinite(ang)) return;
      pushUndo(); var ppi = ppiOf(e), px = lenIn * ppi, rad = ang * Math.PI / 180;
      e.endX = e.startX + px * Math.cos(rad); e.endY = e.startY - px * Math.sin(rad);
      repaint(); buildLayers();
    }
    if (pLen) pLen.onchange = applyLine;
    if (pAng) pAng.onchange = applyLine;
    var pW = host.querySelector('[data-prop-w]'), pH = host.querySelector('[data-prop-h]');
    function applyRect() {
      var e = selectedEntity(); if (!e) return;
      var w = parseLenIn(pW.value), h = parseLenIn(pH.value); if (w == null || h == null) return;
      pushUndo(); var ppi = ppiOf(e);
      var sx = Math.min(e.startX, e.endX), sy = Math.min(e.startY, e.endY);
      e.startX = sx; e.startY = sy; e.endX = sx + Math.max(1, w * ppi); e.endY = sy + Math.max(1, h * ppi);
      repaint(); buildLayers();
    }
    if (pW) pW.onchange = applyRect;
    if (pH) pH.onchange = applyRect;
    var pR = host.querySelector('[data-prop-r]');
    if (pR) pR.onchange = function () {
      var e = selectedEntity(); if (!e) return; var r = parseLenIn(pR.value); if (r == null) return;
      pushUndo(); var ppi = ppiOf(e), rpx = Math.max(1, r * ppi);
      var cx = (e.startX + e.endX) / 2, cy = (e.startY + e.endY) / 2;
      e.startX = cx - rpx; e.endX = cx + rpx; e.startY = cy - rpx; e.endY = cy + rpx;
      repaint(); buildLayers();
    };
    var pText = host.querySelector('[data-prop-text]'), pTh = host.querySelector('[data-prop-th]');
    if (pText) pText.onchange = function () { var e = selectedEntity(); if (!e) return; pushUndo(); e.text = pText.value; repaint(); };
    if (pTh) pTh.onchange = function () { var e = selectedEntity(); if (!e) return; var th = parseLenIn(pTh.value); if (th == null) return; pushUndo(); e.fontPx = Math.max(2, th * ppiOf(e)); repaint(); buildLayers(); };
    var pElev = host.querySelector('[data-prop-elev]');
    if (pElev) pElev.onchange = function () {
      var e = selectedEntity(); if (!e) return;
      var inches = parseLenIn(pElev.value); if (inches == null) return;
      pushUndo();
      if (e.tool === 'level') {
        var dat = datumForViewport(e.viewport);
        e.elevIn = inches;
        // A second level repositions to the new elevation; the datum line itself just relabels.
        if (dat && Math.abs(dat.y - e.startY) > 0.001) { var yy = dat.y - (inches - dat.elevIn) * ppiOf(e); e.startY = yy; e.endY = yy; }
      } else if (e.tool === 'spotelev') {
        var dat2 = datumForViewport(e.viewport);
        if (dat2) e.y = dat2.y - (inches - dat2.elevIn) * ppiOf(e);
      }
      repaint(); buildLayers();
    };
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
  function snapCandidates(vp, raw) {
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
    // Intersection snaps (line × line / polyline / rect edges). When we know
    // the cursor (raw) we only pair segments NEAR it, so this stays O(k²) on
    // a small k even on a dense sheet — no more silent disable past 80 segs.
    var segs = segmentsInVp(vp);
    if (raw) {
      var R = (SNAP_SCREEN / S.view.scale) * 1.5;
      var near = [];
      for (var si = 0; si < segs.length; si++) { if (segNearPoint(segs[si], raw, R)) near.push(segs[si]); }
      for (var i = 0; i < near.length; i++) for (var j = i + 1; j < near.length; j++) {
        var ix = segIntersect(near[i], near[j]);
        if (ix && Math.hypot(ix.x - raw.x, ix.y - raw.y) <= R) out.push({ x: ix.x, y: ix.y, kind: 'intersect' });
      }
    } else if (segs.length <= 80) {
      // No cursor context (rare) — fall back to the bounded global pass.
      for (var i2 = 0; i2 < segs.length; i2++) for (var j2 = i2 + 1; j2 < segs.length; j2++) {
        var ix2 = segIntersect(segs[i2], segs[j2]);
        if (ix2) out.push({ x: ix2.x, y: ix2.y, kind: 'intersect' });
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
  // True if segment s (a→b) passes within R of point p — used to limit
  // intersection snapping to segments near the cursor.
  function segNearPoint(s, p, R) {
    var t = projParam(p, s.a, s.b);
    var fx, fy;
    if (t == null) { fx = s.a.x; fy = s.a.y; }
    else { t = Math.max(0, Math.min(1, t)); fx = s.a.x + t * (s.b.x - s.a.x); fy = s.a.y + t * (s.b.y - s.a.y); }
    return Math.hypot(fx - p.x, fy - p.y) <= R;
  }
  // AutoCAD-style object-snap priority — when several snaps fall inside the
  // aperture, the higher-priority TYPE wins; distance only breaks ties within
  // the same type. endpoint > intersection > mid/center/quad > node > perp > near.
  var SNAP_RANK = { end: 6, intersect: 5, mid: 4, center: 4, quad: 4, node: 3, perp: 2, near: 1 };
  // Resolve the snapped sheet-point for a raw cursor sheet-point.
  function resolveSnap(raw, vp) {
    var radiusSheet = SNAP_SCREEN / S.view.scale;
    var best = null, bestRank = -1, bestD = radiusSheet;
    var sn = S.snaps || {};
    function consider(c, d) {
      if (d > radiusSheet) return;
      var rank = SNAP_RANK[c.kind] || 0;
      if (rank > bestRank || (rank === bestRank && d < bestD)) { bestRank = rank; bestD = d; best = c; }
    }
    if (S.objSnap && vp) {
      snapCandidates(vp, raw).forEach(function (c) {
        if (sn[c.kind] === false) return;                    // per-kind toggle
        consider(c, Math.hypot(c.x - raw.x, c.y - raw.y));
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
              consider({ x: fx, y: fy, kind: 'perp' }, Math.hypot(fx - raw.x, fy - raw.y));
            }
          }
          if (sn.near) {
            var tt = projParam(raw, g.a, g.b);
            if (tt != null) {
              tt = Math.max(0, Math.min(1, tt));
              var nx = g.a.x + tt * (g.b.x - g.a.x), ny = g.a.y + tt * (g.b.y - g.a.y);
              consider({ x: nx, y: ny, kind: 'near' }, Math.hypot(nx - raw.x, ny - raw.y));
            }
          }
        });
      }
    }
    if (best) return best;
    if (S.gridSnap && vp && vp.scale && vp.scale.pixelsPerInch) {
      var step = gridStepPx(vp);   // grid spacing, sheet px (unit-aware: inch grid for fine scales)
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
      if ((S.tool === 'polyline' || S.tool === 'hatch' || S.tool === 'spline') && S.draft) commitPolyline();
    };
    c.oncontextmenu = function (e) { e.preventDefault(); showContextMenu(e); };
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
        // Cancel whatever's in progress, clear the selection, and fall back to
        // the Select tool (CAD-style). Never closes the editor — that's the
        // Close button's job.
        S._filletA = null; S._chamferA = null; S._stretch = null; S._dimcont = null; S.inq = null; S.draft = null; S.boxSel = null; S._calib = null; S._poly = null; hideDyn();
        setSelection([]);
        if (S.tool !== 'select') setTool('select'); else { buildLayers(); repaint(); }
      }
      else if (e.key === 'Enter') {
        if ((S.tool === 'polyline' || S.tool === 'hatch' || S.tool === 'spline') && S.draft) commitPolyline();
        else if (S.tool === 'inquire' && S.inq) { S.inq = null; repaint(); }
        else if (S.tool === 'dimcont' && S._dimcont) { e.preventDefault(); S._dimcont = null; setHint('Continuous dimension finished.'); repaint(); }
        else if (!S.draft && S._lastTool) { e.preventDefault(); setTool(S._lastTool); }   // AutoCAD: Enter repeats the last command
      }
      else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.key === 'y' || e.key === 'Y') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); redo(); }
      else if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicateSelected(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selIds.length) { deleteSelected(); }
      else if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); openShortcuts(); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key && e.key.length === 1 && /[a-z]/i.test(e.key)) {
        // Tool shortcuts. Single-key fires instantly (l/c/r/…); a quick second
        // key forms a two-letter AutoCAD alias (CO/MI/RO/TR/EX) that overrides.
        var k = (e.key || '').toLowerCase();
        e.preventDefault();
        var tnow = Date.now();
        if (S._lastKey && (tnow - (S._lastKeyT || 0)) < 450 && TWO_LETTER_CMD[S._lastKey + k]) {
          var combo = S._lastKey + k; S._lastKey = null; runAlias(TWO_LETTER_CMD[combo]); return;
        }
        S._lastKey = k; S._lastKeyT = tnow;
        if (k === 'o') { runAlias('offset'); return; }           // O = offset (free key)
        if (SHORTCUTS[k]) setTool(SHORTCUTS[k]);
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

  // ── AutoCAD-convention polish (Tier 3) ──────────────────────────
  // Two-letter command aliases. Single-key shortcuts still fire instantly;
  // a quick follow-up key forms the alias (overrides). trim/extend are tools;
  // dup/mirror/rotate/offset are edit-ops on the current selection.
  var TWO_LETTER_CMD = { co: 'dup', mi: 'mirrorH', ro: 'rotate', tr: 'trim', ex: 'extend' };
  function runAlias(cmd) {
    if (cmd === 'trim' || cmd === 'extend') { setTool(cmd); return; }
    if (!S.selIds || !S.selIds.length) { setHint('Select objects first, then ' + cmd.toUpperCase() + '.'); return; }
    if (cmd === 'dup') duplicateSelected();
    else if (cmd === 'mirrorH') mirror(true);
    else if (cmd === 'rotate') rotate90();
    else if (cmd === 'offset') openOffsetModal();
    if (S.tool !== 'select') setTool('select');
  }
  function toolDef(k) { for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].key === k) return TOOLS[i]; return null; }
  function toolName(k) { var d = toolDef(k); return d ? d.name : (k || 'tool'); }
  function toolGlyph(k) { var d = toolDef(k); return d ? d.glyph : '•'; }
  // Cancel everything in progress + drop to Select (shared by Esc + menu).
  function cancelAll() {
    if (!S) return;
    S._filletA = null; S._chamferA = null; S._stretch = null; S._dimcont = null; S.inq = null; S.draft = null; S.boxSel = null; S._calib = null; S._poly = null; hideDyn();
    setSelection([]);
    if (S.tool !== 'select') setTool('select'); else { buildLayers(); repaint(); }
  }
  // Right-click context menu — repeat last command, select/cancel, selection
  // edits, recent tools. The core AutoCAD right-click reflex.
  function ctxOutside(ev) { var m = document.getElementById('p86-sheet-ctx'); if (m && !m.contains(ev.target)) hideContextMenu(); }
  function hideContextMenu() { var m = document.getElementById('p86-sheet-ctx'); if (m && m.parentNode) m.parentNode.removeChild(m); document.removeEventListener('mousedown', ctxOutside, true); }
  function showContextMenu(e) {
    hideContextMenu();
    var menu = document.createElement('div');
    menu.id = 'p86-sheet-ctx';
    menu.style.cssText = 'position:fixed;z-index:5300;background:#0f0f1e;border:1px solid #353545;border-radius:8px;padding:4px;min-width:172px;box-shadow:0 12px 34px rgba(0,0,0,0.6);font-size:12px;color:#e6e6e6;user-select:none;';
    menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - 188)) + 'px';
    menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - 280)) + 'px';
    var items = [];
    if (S._lastTool) items.push({ label: '↻ Repeat ' + toolName(S._lastTool) + '  (Enter)', act: function () { setTool(S._lastTool); } });
    items.push({ label: '▢ Select', act: function () { setTool('select'); } });
    if (S.draft || S.inq || S._calib || (S.selIds && S.selIds.length)) items.push({ label: '⊘ Cancel  (Esc)', act: cancelAll });
    if (S.selIds && S.selIds.length) {
      items.push({ sep: 1 });
      items.push({ label: '⧉ Duplicate', act: duplicateSelected });
      items.push({ label: '⟳ Rotate 90°', act: rotate90 });
      items.push({ label: '⌫ Delete', act: deleteSelected });
    }
    var recents = (S._recentTools || []).filter(function (tk) { return tk !== S._lastTool; });
    if (recents.length) {
      items.push({ sep: 1 });
      recents.slice(0, 4).forEach(function (tk) { items.push({ label: toolGlyph(tk) + '  ' + toolName(tk), act: function () { setTool(tk); } }); });
    }
    items.forEach(function (it) {
      if (it.sep) { var hr = document.createElement('div'); hr.style.cssText = 'height:1px;background:#2a2a3a;margin:4px 2px;'; menu.appendChild(hr); return; }
      var b = document.createElement('div');
      b.textContent = it.label;
      b.style.cssText = 'padding:6px 10px;border-radius:5px;cursor:pointer;white-space:nowrap;';
      b.onmouseenter = function () { b.style.background = 'rgba(79,140,255,0.18)'; };
      b.onmouseleave = function () { b.style.background = 'transparent'; };
      b.onclick = function () { hideContextMenu(); try { it.act(); } catch (err) {} };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    setTimeout(function () { document.addEventListener('mousedown', ctxOutside, true); }, 0);
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
    if (t === 'chamfer') { chamferClick(pt, vp); return; }
    if (t === 'polararray') { polarArrayClick(pt, vp); return; }
    if (t === 'stretch') { stretchClick(pt, vp); return; }
    if (t === 'break') { breakAt(pt, vp); return; }
    if (t === 'calibrate') { calibrateClick(pt, vp); return; }
    if (t === 'dimradius') { dimCircleClick(pt, vp, 'radius'); return; }
    if (t === 'dimdia') { dimCircleClick(pt, vp, 'diameter'); return; }
    if (t === 'dimcont') { dimContClick(pt, vp); return; }
    // Measure / inquiry — accumulate points; readout drawn in repaint. Never
    // becomes a printed entity. Enter/Esc clears.
    if (t === 'inquire') {
      if (!S.inq) S.inq = { pts: [], vp: vp || vpAt(pt) };
      S.inq.pts.push({ x: pt.x, y: pt.y });
      repaint(); return;
    }
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
    if (t === 'polygon') {
      // Regular N-gon: click center, click a vertex, then type the side count.
      if (!S._poly) { S._poly = { cx: pt.x, cy: pt.y, vp: vp }; setHint('Polygon: click a vertex to set size + orientation.'); repaint(); return; }
      var pc = S._poly; S._poly = null;
      var R = Math.hypot(pt.x - pc.cx, pt.y - pc.cy);
      if (R < 1) { repaint(); return; }
      var a0 = Math.atan2(pt.y - pc.cy, pt.x - pc.cx);
      promptText('Number of sides (3–24)', function (txt) {
        if (txt == null) { repaint(); return; }
        var n = Math.max(3, Math.min(24, parseInt(txt, 10) || 0));
        if (n < 3) { repaint(); return; }
        var poly = newEntity('polyline', pc.vp || vp); poly.points = [];
        for (var i = 0; i < n; i++) { var a = a0 + i * 2 * Math.PI / n; poly.points.push({ x: pc.cx + R * Math.cos(a), y: pc.cy + R * Math.sin(a) }); }
        poly.points.push({ x: poly.points[0].x, y: poly.points[0].y });   // close the ring
        commitEntity(poly); repaint();
      });
      return;
    }
    if (t === 'line' || t === 'rect' || t === 'circle' || t === 'refline' || t === 'ellipse' || t === 'revcloud') {
      if (!S.draft) {
        var e = newEntity(t === 'circle' ? 'ellipse' : t, vp);
        e.startX = pt.x; e.startY = pt.y; e.endX = pt.x; e.endY = pt.y;
        e._anchor = { x: pt.x, y: pt.y }; e._circle = (t === 'circle');
        S.draft = e;
        if (t === 'line' || t === 'refline') showDyn();
      } else {
        finalizeTwoPoint(pt);
      }
    } else if (t === 'polyline' || t === 'spline') {
      if (!S.draft) {
        var pe = newEntity(t, vp);   // 'polyline' or 'spline' (resampled to a polyline on commit)
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
    if (d.tool === 'revcloud') {
      // Convert the drawn bbox into a scalloped closed polyline (reuses
      // polyline render/snaps/export — no new entity type).
      d.points = revCloudPoints(Math.min(d.startX, d.endX), Math.min(d.startY, d.endY), Math.max(d.startX, d.endX), Math.max(d.startY, d.endY));
      d.tool = 'polyline';
      delete d.startX; delete d.startY; delete d.endX; delete d.endY;
    }
    commitEntity(d); S.draft = null; hideDyn();
  }
  function commitPolyline() {
    var d = S.draft;
    if (d && d.points && d.points.length >= 2) {
      delete d._anchor;
      // Spline → resample into a smooth Catmull-Rom polyline (existing render).
      if (d.tool === 'spline') { if (d.points.length >= 3) d.points = catmullRom(d.points, 16); d.tool = 'polyline'; }
      commitEntity(d);
    }
    S.draft = null; hideDyn(); repaint();
  }
  // Catmull-Rom resample through control points → smooth polyline (Tier 4 spline).
  function catmullRom(P, segs) {
    if (!P || P.length < 3) return (P || []).slice();
    segs = segs || 16;
    var out = [];
    function at(i) { return P[Math.max(0, Math.min(P.length - 1, i))]; }
    for (var i = 0; i < P.length - 1; i++) {
      var p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      for (var s = 0; s < segs; s++) {
        var t = s / segs, t2 = t * t, t3 = t2 * t;
        out.push({
          x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
        });
      }
    }
    out.push(P[P.length - 1]);
    return out;
  }
  // Scalloped (arc-bump) closed loop around a bbox → polyline (Tier 4 rev-cloud).
  function revCloudPoints(x0, y0, x1, y1) {
    var bump = Math.max(8, Math.min(36, Math.min(x1 - x0, y1 - y0) / 6));
    var pts = [];
    function edge(ax, ay, bx, by) {
      var len = Math.hypot(bx - ax, by - ay); if (len < 1e-6) return;
      var n = Math.max(1, Math.round(len / (bump * 2)));
      var ux = (bx - ax) / len, uy = (by - ay) / len, nx = uy, ny = -ux;   // outward normal (CW winding)
      for (var i = 0; i < n; i++) {
        var sx = ax + (bx - ax) * (i / n), sy = ay + (by - ay) * (i / n);
        var ex = ax + (bx - ax) * ((i + 1) / n), ey = ay + (by - ay) * ((i + 1) / n);
        var r = Math.hypot(ex - sx, ey - sy) / 2;
        for (var a = 0; a <= 6; a++) {
          var f = a / 6, bulge = Math.sin(Math.PI * f) * r;
          pts.push({ x: sx + (ex - sx) * f + nx * bulge, y: sy + (ey - sy) * f + ny * bulge });
        }
      }
    }
    edge(x0, y0, x1, y0); edge(x1, y0, x1, y1); edge(x1, y1, x0, y1); edge(x0, y1, x0, y0);
    return pts;
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
  function pushUndo() { S._undo.push(snapshot()); if (S._undo.length > 60) S._undo.shift(); S._redo.length = 0; markDirty(); }
  function commitEntity(e) { pushUndo(); S.doc.entities.push(e); }
  function restoreSnap(json) {
    var o = JSON.parse(json);
    S.doc.entities = o.entities; S.doc.layers = o.layers;
    setSelection([]); buildLayers(); repaint(); markDirty();
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
  // ── Properties: editable geometry fields for the selected entity ──
  function propLbl(label, attr, val, wide) {
    return '<label style="font-size:10px;color:#9aa;display:flex;flex-direction:column;gap:2px;' + (wide ? 'flex:1;' : '') + '">' + esc(label) +
      '<input data-' + attr + ' value="' + esc(val) + '" style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:5px;padding:3px 5px;font-size:11px;" /></label>';
  }
  function propGeomHtml(e, ppi) {
    if (!e || !ppi) return '';
    if (e.tool === 'level') {
      return '<div style="margin-top:7px;">' + propLbl('Elevation', 'prop-elev', fmtLen(e.elevIn || 0), false) + '</div>';
    }
    if (e.tool === 'spotelev') {
      return '<div style="margin-top:7px;">' + propLbl('Elevation', 'prop-elev', fmtLen(elevAtPoint(e)), false) + '</div>';
    }
    if (e.tool === 'line' || e.tool === 'refline') {
      var dx = e.endX - e.startX, dy = e.endY - e.startY;
      return '<div style="display:flex;gap:8px;margin-top:7px;">' + propLbl('Length', 'prop-len', fmtLen(Math.hypot(dx, dy) / ppi), true) + propLbl('Angle°', 'prop-ang', (Math.atan2(-dy, dx) * 180 / Math.PI).toFixed(1), true) + '</div>';
    }
    if (e.tool === 'rect') {
      return '<div style="display:flex;gap:8px;margin-top:7px;">' + propLbl('Width', 'prop-w', fmtLen(Math.abs(e.endX - e.startX) / ppi), true) + propLbl('Height', 'prop-h', fmtLen(Math.abs(e.endY - e.startY) / ppi), true) + '</div>';
    }
    if (e.tool === 'ellipse') {
      return '<div style="margin-top:7px;">' + propLbl('Radius', 'prop-r', fmtLen(Math.abs(e.endX - e.startX) / 2 / ppi), false) + '</div>';
    }
    if (e.tool === 'text') {
      return '<div style="margin-top:7px;">' + propLbl('Text', 'prop-text', e.text || '', true) + '<div style="margin-top:6px;">' + propLbl('Text height', 'prop-th', fmtLen((e.fontPx || 24) / ppi), false) + '</div></div>';
    }
    return '';
  }
  // Parse a length input (e.g. "12' 6\"", "126\"", "10") → inches, or null.
  function parseLenIn(str) {
    var p = prims().parseMeasurement ? prims().parseMeasurement(str, 'ft') : null;
    if (p) return p.inches;
    var f = parseFloat(str); return isFinite(f) ? f * 12 : null;
  }
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
  // Uniform scale of the selection about its centre by a typed factor (Tier 4).
  function scaleSel() {
    var ents = selEntities(); if (!ents.length) return;
    promptText('Scale factor (e.g. 2 = double, 0.5 = half)', function (txt) {
      if (txt == null) return;
      var f = parseFloat(txt);
      if (!isFinite(f) || f <= 0) { alert('Enter a positive number — e.g. 2 or 0.5.'); return; }
      if (f === 1) return;
      pushUndo();
      var gb = groupBBox(ents), cx = gb.x + gb.w / 2, cy = gb.y + gb.h / 2;
      ents.forEach(function (e) { transformEntity(e, function (p) { return { x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f }; }); });
      repaint();
    });
  }
  // Explode a rect / polyline into individual line segments (Tier 4).
  function explodeSel() {
    var ents = selEntities(); if (!ents.length) return;
    var added = [], removed = {};
    ents.forEach(function (e) {
      var segs = [];
      if (e.tool === 'rect' && e.startX != null) {
        var c = [{ x: e.startX, y: e.startY }, { x: e.endX, y: e.startY }, { x: e.endX, y: e.endY }, { x: e.startX, y: e.endY }];
        for (var k = 0; k < 4; k++) segs.push([c[k], c[(k + 1) % 4]]);
      } else if ((e.tool === 'polyline' || e.tool === 'hatch') && e.points && e.points.length > 1) {
        for (var p = 1; p < e.points.length; p++) segs.push([e.points[p - 1], e.points[p]]);
      } else return;
      removed[e.id] = 1;
      segs.forEach(function (s) {
        var ln = newEntity('line', viewportOf(e));
        ln.layer = e.layer; ln.color = e.color; ln.lineWidth = e.lineWidth;
        ln.startX = s[0].x; ln.startY = s[0].y; ln.endX = s[1].x; ln.endY = s[1].y;
        added.push(ln);
      });
    });
    if (!added.length) { setHint('Explode: select a rectangle or polyline.'); return; }
    pushUndo();
    S.doc.entities = S.doc.entities.filter(function (e) { return !removed[e.id]; });
    added.forEach(function (a) { S.doc.entities.push(a); });
    setSelection(added.map(function (a) { return a.id; })); buildLayers(); repaint();
  }
  function _ptNear(a, b, tol) { return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol; }
  // Join selected end-to-end connected lines into one polyline (Tier 4).
  function joinSel() {
    var lines = selEntities().filter(function (e) { return e.tool === 'line' && e.startX != null; });
    if (lines.length < 2) { setHint('Join: select 2+ connected lines.'); return; }
    var tol = 2.5 / S.view.scale, pool = lines.slice();
    var path = [{ x: pool[0].startX, y: pool[0].startY }, { x: pool[0].endX, y: pool[0].endY }];
    pool.splice(0, 1);
    var progress = true;
    while (pool.length && progress) {
      progress = false;
      for (var i = 0; i < pool.length; i++) {
        var L = pool[i], a = { x: L.startX, y: L.startY }, b = { x: L.endX, y: L.endY };
        var head = path[0], tail = path[path.length - 1];
        if (_ptNear(tail, a, tol)) path.push(b);
        else if (_ptNear(tail, b, tol)) path.push(a);
        else if (_ptNear(head, a, tol)) path.unshift(b);
        else if (_ptNear(head, b, tol)) path.unshift(a);
        else continue;
        pool.splice(i, 1); progress = true; break;
      }
    }
    if (pool.length) { setHint('Join: those lines don\'t form one connected chain.'); return; }
    pushUndo();
    var first = lines[0];
    var poly = newEntity('polyline', viewportOf(first));
    poly.layer = first.layer; poly.color = first.color; poly.lineWidth = first.lineWidth; poly.points = path;
    var rm = {}; lines.forEach(function (L) { rm[L.id] = 1; });
    S.doc.entities = S.doc.entities.filter(function (e) { return !rm[e.id]; });
    S.doc.entities.push(poly);
    setSelection([poly.id]); buildLayers(); repaint();
  }
  // Break a line into two segments at the clicked point (Tier 4 tool).
  function breakAt(pt, vp) {
    var id = hitTest(pt);
    var e = id && S.doc.entities.filter(function (x) { return x.id === id; })[0];
    if (!e || e.tool !== 'line' || e.startX == null) { setHint('Break: click on a straight line.'); return; }
    var a = { x: e.startX, y: e.startY }, b = { x: e.endX, y: e.endY };
    var tt = projParam(pt, a, b); if (tt == null) return;
    tt = Math.max(0, Math.min(1, tt));
    if (tt < 0.02 || tt > 0.98) { setHint('Break: pick a point nearer the middle of the line.'); return; }
    var bx = a.x + (b.x - a.x) * tt, by = a.y + (b.y - a.y) * tt;
    pushUndo();
    var l2 = JSON.parse(JSON.stringify(e)); l2.id = uid('line'); delete l2._anchor; delete l2._circle;
    e.endX = bx; e.endY = by;
    l2.startX = bx; l2.startY = by; l2.endX = b.x; l2.endY = b.y;
    S.doc.entities.push(l2);
    setSelection([e.id, l2.id]); buildLayers(); repaint();
    setHint('Line broken into two segments.');
  }
  // Polar array — copy the current selection N times around a clicked center
  // (Tier 4 tool; select first, then click the center).
  function polarArrayClick(pt, vp) {
    var ents = selEntities();
    if (!ents.length) { setHint('Polar array: select objects first, then click the center.'); return; }
    var cx = pt.x, cy = pt.y;
    promptText('Number of items around the center (e.g. 6)', function (txt) {
      if (txt == null) return;
      var n = Math.max(2, Math.min(120, parseInt(txt, 10) || 0));
      if (n < 2) return;
      pushUndo();
      var newIds = ents.map(function (e) { return e.id; });
      for (var k = 1; k < n; k++) {
        var ang = k * 2 * Math.PI / n, ca = Math.cos(ang), sa = Math.sin(ang);
        ents.forEach(function (e) {
          var copy = JSON.parse(JSON.stringify(e)); copy.id = uid(copy.tool); delete copy._anchor; delete copy._circle;
          transformEntity(copy, function (p) {
            var dx = p.x - cx, dy = p.y - cy;
            return { x: cx + dx * ca - dy * sa, y: cy + dx * sa + dy * ca };
          });
          if (copy.tool === 'symbol') copy.rotation = ((copy.rotation || 0) + ang * 180 / Math.PI) % 360;
          S.doc.entities.push(copy); newIds.push(copy.id);
        });
      }
      setSelection(newIds); buildLayers(); repaint(); setTool('select');
    });
  }
  // Stretch — capture vertices inside a crossing window, then move them by a
  // base→destination vector; vertices outside the window stay put (Tier 4).
  function captureVertsInRect(x0, y0, x1, y1) {
    var v = [];
    function inR(p) { return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1; }
    (S.doc.entities || []).forEach(function (e) {
      var lyr = layerById(S.doc, e.layer); if (lyr && (lyr.visible === false || lyr.locked)) return;
      if (e.startX != null) { if (inR({ x: e.startX, y: e.startY })) v.push({ e: e, k: 's' }); if (inR({ x: e.endX, y: e.endY })) v.push({ e: e, k: 'e' }); }
      if (e.points) e.points.forEach(function (p, i) { if (inR(p)) v.push({ e: e, k: 'p', i: i }); });
      if (e.x != null) { if (inR({ x: e.x, y: e.y })) v.push({ e: e, k: 'x' }); }
    });
    return v;
  }
  function applyVertDelta(v, dx, dy) {
    var e = v.e;
    if (v.k === 's') { e.startX += dx; e.startY += dy; }
    else if (v.k === 'e') { e.endX += dx; e.endY += dy; }
    else if (v.k === 'p') { e.points[v.i].x += dx; e.points[v.i].y += dy; }
    else if (v.k === 'x') { e.x += dx; e.y += dy; }
  }
  function stretchClick(pt, vp) {
    var st = S._stretch || (S._stretch = { phase: 'c1' });
    if (st.phase === 'c1') { st.p1 = { x: pt.x, y: pt.y }; st.phase = 'c2'; setHint('Stretch: click the opposite corner of the crossing window.'); repaint(); return; }
    if (st.phase === 'c2') {
      st.rect = { x0: Math.min(st.p1.x, pt.x), y0: Math.min(st.p1.y, pt.y), x1: Math.max(st.p1.x, pt.x), y1: Math.max(st.p1.y, pt.y) };
      st.verts = captureVertsInRect(st.rect.x0, st.rect.y0, st.rect.x1, st.rect.y1);
      if (!st.verts.length) { setHint('Stretch: no vertices in that window — start again.'); S._stretch = null; repaint(); return; }
      st.phase = 'base'; setHint(st.verts.length + ' point(s) captured — click a base point.'); repaint(); return;
    }
    if (st.phase === 'base') { st.base = { x: pt.x, y: pt.y }; st.phase = 'dest'; setHint('Stretch: click the destination point.'); repaint(); return; }
    if (st.phase === 'dest') {
      var dx = pt.x - st.base.x, dy = pt.y - st.base.y;
      pushUndo();
      st.verts.forEach(function (v) { applyVertDelta(v, dx, dy); });
      S._stretch = null; buildLayers(); repaint(); setHint('Stretched.');
    }
  }
  // Radius / diameter dimension — click a circle/ellipse; emitted as a 'measure'
  // entity (existing render) with a dimKind so the label gets the R / ⌀ prefix.
  function dimCircleClick(pt, vp, kind) {
    var id = hitTest(pt);
    var e = id && S.doc.entities.filter(function (x) { return x.id === id; })[0];
    if (!e || e.tool !== 'ellipse' || e.startX == null) { setHint((kind === 'diameter' ? 'Diameter' : 'Radius') + ' dim: click a circle or ellipse.'); return; }
    var cx = (e.startX + e.endX) / 2, cy = (e.startY + e.endY) / 2;
    var rx = Math.abs(e.endX - e.startX) / 2, ry = Math.abs(e.endY - e.startY) / 2;
    var ang = Math.atan2(pt.y - cy, pt.x - cx);
    var ex = cx + rx * Math.cos(ang), ey = cy + ry * Math.sin(ang);
    var dm = newEntity('measure', viewportOf(e));
    dm.layer = dimLayerId(); dm.color = layerById(S.doc, dm.layer).color; dm.lineWidth = 2; dm.dimKind = kind;
    if (kind === 'diameter') { dm.startX = cx - rx * Math.cos(ang); dm.startY = cy - ry * Math.sin(ang); dm.endX = ex; dm.endY = ey; }
    else { dm.startX = cx; dm.startY = cy; dm.endX = ex; dm.endY = ey; }
    commitEntity(dm); repaint(); setTool('select');
  }
  // Continuous dimension chain — each click dimensions the span from the prior
  // point; Enter/Esc finishes. Each span is a 'measure' entity.
  function dimContClick(pt, vp) {
    if (!S._dimcont) { S._dimcont = { last: { x: pt.x, y: pt.y }, vp: vp }; setHint('Continuous dim: click the next point (Enter / Esc to finish).'); repaint(); return; }
    var dm = newEntity('measure', S._dimcont.vp || vp);
    dm.layer = dimLayerId(); dm.color = layerById(S.doc, dm.layer).color; dm.lineWidth = 2;
    dm.startX = S._dimcont.last.x; dm.startY = S._dimcont.last.y; dm.endX = pt.x; dm.endY = pt.y;
    commitEntity(dm);
    S._dimcont.last = { x: pt.x, y: pt.y };
    repaint();
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
  // Flag entities pointing at a viewport id that no longer exists — their
  // measurements would silently fall back to viewports[0]'s scale. Surface it
  // (status bar) instead of guessing (Tier 2). Cheap; run on load.
  function validateScale() {
    if (!S) return;
    S._scaleWarn = '';
    var ids = {}; (S.doc.viewports || []).forEach(function (v) { ids[v.id] = true; });
    var orphans = 0;
    (S.doc.entities || []).forEach(function (e) { if (e && e.viewport && !ids[e.viewport]) orphans++; });
    if (orphans) {
      S._scaleWarn = orphans + ' object' + (orphans === 1 ? '' : 's') + ' on a missing viewport — scale unverified';
      if (window.console) console.warn('[sheet] ' + S._scaleWarn);
    }
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
  // Chamfer — like fillet but a straight setback cut (Tier 4). Reuses the
  // fillet two-line pick + geometry helpers.
  function chamferClick(pt, vp) {
    var hit = pickLineAt(pt, vp); if (!hit) return;
    if (!S._chamferA) { S._chamferA = { id: hit.entity.id, click: { x: pt.x, y: pt.y } }; setHint('Chamfer: first line ✓ — now click the second line.'); repaint(); return; }
    if (hit.entity.id === S._chamferA.id) return;
    var aRec = S._chamferA; S._chamferA = null;
    var A = S.doc.entities.filter(function (x) { return x.id === aRec.id; })[0];
    if (!A) { updateHint(); return; }
    openChamferModal(A, hit.entity, aRec.click, { x: pt.x, y: pt.y });
  }
  function openChamferModal(A, B, ca, cb) {
    opModal('Chamfer distance',
      numField('Setback (ft) — 0 = sharp corner', 'd', '1'),
      function (box) {
        var d = parseFloat((box.querySelector('[data-op=d]') || {}).value);
        applyChamfer(A, B, ca, cb, isFinite(d) ? d : 0);
      });
    updateHint();
  }
  function applyChamfer(A, B, ca, cb, dFt) {
    var I = lineLineIntersect(A.startX, A.startY, A.endX, A.endY, B.startX, B.startY, B.endX, B.endY);
    if (!I) { alert('Those lines are parallel — nothing to chamfer.'); return; }
    var d = (dFt || 0) * 12 * ppiOf(A);
    function dirToward(L, click) {
      var d1 = Math.hypot(click.x - L.startX, click.y - L.startY), d2 = Math.hypot(click.x - L.endX, click.y - L.endY);
      var end = (d1 < d2) ? { x: L.startX, y: L.startY } : { x: L.endX, y: L.endY };
      var vx = end.x - I.x, vy = end.y - I.y, len = Math.hypot(vx, vy) || 1;
      return { x: vx / len, y: vy / len };
    }
    pushUndo();
    if (d <= 0) { setNearEnd(A, ca, I); setNearEnd(B, cb, I); buildLayers(); repaint(); return; }
    var da = dirToward(A, ca), db = dirToward(B, cb);
    var t1 = { x: I.x + da.x * d, y: I.y + da.y * d };
    var t2 = { x: I.x + db.x * d, y: I.y + db.y * d };
    setNearEnd(A, ca, t1); setNearEnd(B, cb, t2);
    var bev = newEntity('line', viewportOf(A));
    bev.layer = A.layer; bev.color = A.color; bev.lineWidth = A.lineWidth;
    bev.startX = t1.x; bev.startY = t1.y; bev.endX = t2.x; bev.endY = t2.y;
    S.doc.entities.push(bev);
    buildLayers(); repaint();
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

  // ── Plan underlay (Tier 1) ──────────────────────────────────────
  // Import a PDF/image plan as a scaled background to trace + measure
  // over. Stored on doc.underlay (rides pages[0] through save), rendered
  // behind entities inside the viewport clip, calibrated via the
  // Calibrate tool. The rendered bitmap is cached on S (not persisted).
  function underlayRawUrl(u) {
    if (!u) return null;
    if (u.url) return u.url;                                   // pre-upload / explicit
    if (u.attachmentId) return '/api/attachments/raw/' + encodeURIComponent(u.attachmentId);
    return null;
  }
  function placeUnderlayDefault(u) {
    if (!S || !u || !u.natW || !u.natH) return;
    var vps = S.doc.viewports || [], vp = null;
    for (var i = 0; i < vps.length; i++) { if (vps[i].id === u.viewport) { vp = vps[i]; break; } }
    if (!vp) vp = vps[0];
    if (!vp) return;
    // Fit the plan inside its viewport frame, preserving aspect (letterbox).
    var fit = Math.min(vp.w / u.natW, vp.h / u.natH);
    u.w = u.natW * fit; u.h = u.natH * fit;
    u.x = vp.x + (vp.w - u.w) / 2;
    u.y = vp.y + (vp.h - u.h) / 2;
  }
  function ensureUnderlay() {
    var u = S && S.doc && S.doc.underlay;
    if (!u) { if (S) { S._underlayBmp = null; S._underlayKey = null; } return; }
    var key = (u.attachmentId || u.url || '') + ':' + (u.page || 0);
    if (S._underlayKey === key && S._underlayBmp) return;      // already loaded
    if (S._underlayLoadKey === key) return;                    // load in flight
    var url = underlayRawUrl(u); if (!url) return;
    S._underlayLoadKey = key;
    var headers = {};
    var tok = (window.p86Auth && typeof p86Auth.getToken === 'function') ? p86Auth.getToken() : null;
    if (!tok) { try { tok = localStorage.getItem('p86-auth-token'); } catch (e) {} }
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    function done(bmp, w, h) {
      if (!S || S._underlayLoadKey !== key) return;            // superseded / editor closed
      S._underlayBmp = bmp; S._underlayKey = key; S._underlayLoadKey = null;
      if (u.natW == null || u.x == null) { u.natW = w; u.natH = h; placeUnderlayDefault(u); }
      repaint(); refreshStatusBar();
    }
    function fail(e) { if (S && S._underlayLoadKey === key) S._underlayLoadKey = null; if (window.console) console.warn('[sheet underlay] load failed', e); }
    if (u.kind === 'pdf') {
      if (!window.pdfjsLib) { fail(new Error('pdfjsLib not loaded')); return; }
      fetch(url, { headers: headers, credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(function (buf) { return window.pdfjsLib.getDocument({ data: buf }).promise; })
        .then(function (pdf) { return pdf.getPage((u.page || 0) + 1); })
        .then(function (page) {
          var vpt = page.getViewport({ scale: 2 });
          var off = document.createElement('canvas');
          off.width = Math.max(1, Math.round(vpt.width)); off.height = Math.max(1, Math.round(vpt.height));
          return page.render({ canvasContext: off.getContext('2d'), viewport: vpt }).promise.then(function () { return off; });
        })
        .then(function (off) { done(off, off.width, off.height); })
        .catch(fail);
    } else {
      // image — fetch as blob so the bitmap is same-origin and exports clean.
      fetch(url, { headers: headers, credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(function (blob) {
          var burl = URL.createObjectURL(blob);
          var img = new Image();
          img.onload = function () { done(img, img.naturalWidth, img.naturalHeight); setTimeout(function () { try { URL.revokeObjectURL(burl); } catch (e) {} }, 0); };
          img.onerror = function () { fail(new Error('image decode failed')); };
          img.src = burl;
        })
        .catch(fail);
    }
  }
  // Drawn inside renderSheet's per-viewport clip, behind entities, under
  // the same pan/zoom transform — so it tracks the drawing 1:1.
  function drawUnderlay(ctx, vp) {
    var u = S && S.doc && S.doc.underlay;
    if (!u || !S._underlayBmp || u.x == null) return;
    var owner = u.viewport || (((S.doc.viewports || [])[0]) || {}).id;
    if (owner !== vp.id) return;
    ctx.save();
    var op = (u.opacity == null) ? 0.6 : u.opacity;
    ctx.globalAlpha = Math.max(0.05, Math.min(1, op));
    try { ctx.drawImage(S._underlayBmp, u.x, u.y, u.w, u.h); } catch (e) {}
    ctx.restore();
  }
  function importUnderlay() {
    if (!S) return;
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/pdf,image/*'; inp.style.display = 'none';
    inp.onchange = function () {
      var file = inp.files && inp.files[0];
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (!file) return;
      var isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);
      var plan = S.plan || {};
      var et, eid;
      if (plan.entity_type && plan.entity_id) { et = plan.entity_type; eid = plan.entity_id; }
      else { et = 'user'; eid = (window.p86Auth && p86Auth.getUser && (p86Auth.getUser() || {}).id); }
      if (eid == null) { alert('Could not determine where to store the underlay file.'); return; }
      if (!window.p86Api || !p86Api.attachments || !p86Api.attachments.upload) { alert('Upload API unavailable — refresh the page.'); return; }
      setHint('Uploading underlay…');
      p86Api.attachments.upload(et, eid, file, { skip_geo: true }).then(function (res) {
        var att = (res && (res.attachment || res)) || {};
        if (!att.id) throw new Error('upload returned no attachment id');
        S.doc.underlay = {
          attachmentId: att.id, kind: isPdf ? 'pdf' : 'image', page: 0,
          viewport: (((S.doc.viewports || [])[0]) || {}).id || 'VP1', opacity: 0.6,
          name: file.name || ''
        };
        // A fresh plan import has an arbitrary scale until calibrated.
        var vp0 = (S.doc.viewports || [])[0];
        if (vp0 && vp0.scale) vp0.scale.calibrated = false;
        S._underlayBmp = null; S._underlayKey = null; S._underlayLoadKey = null;
        ensureUnderlay();
        markDirty();
        if (typeof setTool === 'function') setTool('calibrate');
        setHint('Underlay added — click two points a known distance apart, then type the real length to set scale.');
        repaint(); refreshStatusBar();
      }).catch(function (e) {
        alert('Underlay upload failed: ' + (e && e.message ? e.message : e));
        setHint('');
      });
    };
    document.body.appendChild(inp);
    inp.click();
  }
  // Calibrate: two clicks a known distance apart → type the real length →
  // back-solve this viewport's pixelsPerInch so every measure/dim/area is true.
  function calibrateClick(pt, vp) {
    vp = vp || vpAt(pt) || (S.doc.viewports || [])[0];
    if (!vp) return;
    if (!S._calib || S._calib.vpId !== vp.id) S._calib = { vpId: vp.id, pts: [] };
    S._calib.pts.push({ x: pt.x, y: pt.y });
    if (S._calib.pts.length < 2) { setHint('Calibrate: now click the second point of the known distance.'); repaint(); return; }
    var a = S._calib.pts[0], b = S._calib.pts[1];
    var pxDist = Math.hypot(b.x - a.x, b.y - a.y);
    S._calib = null;
    if (pxDist < 1) { setHint('Those two points are too close — try again.'); repaint(); return; }
    repaint();
    promptText('Real distance between the two points (e.g. 20\', 24\' 6", 240")', function (txt) {
      if (txt == null) { repaint(); return; }
      var inches = parseLenIn(txt);
      if (!inches || inches <= 0) { alert('Could not read that distance. Try e.g. 20\' or 24\' 6".'); return; }
      if (!vp.scale) vp.scale = { unit: 'ft' };
      vp.scale.pixelsPerInch = pxDist / inches;
      vp.scale.calibrated = true;
      vp.scale.label = 'Calibrated · ' + fmtLen(inches) + ' ref';
      markDirty();
      if (typeof setTool === 'function') setTool('select');
      repaint(); refreshStatusBar();
      setHint('Scale calibrated — measurements are now true to the plan.');
    });
  }

  // ── Model / Sheet space (Phase B) ───────────────────────────────
  // Phase B step 1: a chrome-free Model working view. Sheet space is the
  // titleblocked paper (unchanged default); Model space hides the sheet
  // border / viewport frame / titleblock so you draw on a clean surface.
  // Same coordinate space (no data change) — the model-canonical coordinate
  // migration + scaled viewport windows land in Phase C/D (multi-viewport).
  function setSpace(sp) {
    if (!S || (sp !== 'model' && sp !== 'sheet') || S.space === sp) return;
    S.space = sp;
    var mb = S.overlay && S.overlay.querySelector('#p86-space-model');
    var sb = S.overlay && S.overlay.querySelector('#p86-space-sheet');
    if (mb) { mb.style.background = (sp === 'model') ? '#4f8cff' : 'rgba(255,255,255,0.06)'; mb.style.color = (sp === 'model') ? '#fff' : '#cbd5e1'; }
    if (sb) { sb.style.background = (sp === 'sheet') ? '#4f8cff' : 'rgba(255,255,255,0.06)'; sb.style.color = (sp === 'sheet') ? '#fff' : '#cbd5e1'; }
    setHint(sp === 'model' ? 'Model space — true-size working view (no titleblock).' : 'Sheet space — titleblocked sheet for printing.');
    repaint();
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
    renderSheet(ctx, S.doc, { paperShadow: true, grid: S.gridSnap, viewScale: S.view.scale, editor: true, modelMode: S.space === 'model' });
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
        var prev = { tool: d._circle ? 'ellipse' : (d.tool === 'refline' ? 'line' : (d.tool === 'revcloud' ? 'rect' : d.tool)), color: '#4f8cff', lineWidth: d.lineWidth || 3 };
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
    // calibrate in progress — marker on the first point + rubber line to cursor
    if (S._calib && S._calib.pts && S._calib.pts.length) {
      var ca0 = S._calib.pts[0];
      ctx.save();
      ctx.strokeStyle = '#f59e0b'; ctx.fillStyle = '#f59e0b';
      ctx.lineWidth = 1.5 / S.view.scale;
      ctx.beginPath(); ctx.arc(ca0.x, ca0.y, 4 / S.view.scale, 0, Math.PI * 2); ctx.fill();
      if (S.hover) { ctx.beginPath(); ctx.moveTo(ca0.x, ca0.y); ctx.lineTo(S.hover.x, S.hover.y); ctx.stroke(); }
      ctx.restore();
    }
    // stretch in progress — crossing window (c2) + captured vertices + move vector
    if (S._stretch) {
      var stp = S._stretch;
      ctx.save();
      ctx.strokeStyle = '#22c55e'; ctx.fillStyle = '#22c55e'; ctx.lineWidth = 1 / S.view.scale;
      if (stp.phase === 'c2' && stp.p1 && S.hover) {
        ctx.setLineDash([6 / S.view.scale, 4 / S.view.scale]);
        ctx.strokeRect(Math.min(stp.p1.x, S.hover.x), Math.min(stp.p1.y, S.hover.y), Math.abs(S.hover.x - stp.p1.x), Math.abs(S.hover.y - stp.p1.y));
        ctx.setLineDash([]);
      }
      if (stp.verts) stp.verts.forEach(function (v) {
        var p = v.k === 's' ? { x: v.e.startX, y: v.e.startY } : v.k === 'e' ? { x: v.e.endX, y: v.e.endY } : v.k === 'p' ? v.e.points[v.i] : { x: v.e.x, y: v.e.y };
        ctx.beginPath(); ctx.arc(p.x, p.y, 3 / S.view.scale, 0, Math.PI * 2); ctx.fill();
      });
      if (stp.phase === 'dest' && stp.base && S.hover) { ctx.beginPath(); ctx.moveTo(stp.base.x, stp.base.y); ctx.lineTo(S.hover.x, S.hover.y); ctx.stroke(); }
      ctx.restore();
    }
    // continuous-dim in progress — rubber line from the last point to the cursor
    if (S._dimcont && S._dimcont.last && S.hover) {
      ctx.save(); ctx.strokeStyle = '#b45309'; ctx.lineWidth = 1 / S.view.scale;
      ctx.setLineDash([5 / S.view.scale, 4 / S.view.scale]);
      ctx.beginPath(); ctx.moveTo(S._dimcont.last.x, S._dimcont.last.y); ctx.lineTo(S.hover.x, S.hover.y); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
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
    // Measure / inquiry overlay (screen space) — path + live readout box.
    if (S.inq && S.inq.pts && S.inq.pts.length) {
      var ipts = S.inq.pts.slice();
      var ilive = (S.hover && S.tool === 'inquire') ? S.hover : null;
      var idraw = ilive ? ipts.concat([ilive]) : ipts;
      ctx.save();
      ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath();
      idraw.forEach(function (p, i) { var s = toScreen(p.x, p.y); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
      ctx.stroke(); ctx.setLineDash([]);
      idraw.forEach(function (p) { var s = toScreen(p.x, p.y); ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); ctx.fill(); });
      var ivp = S.inq.vp || vpAt(ipts[0]) || (S.doc.viewports && S.doc.viewports[0]);
      var ippi = (ivp && ivp.scale && ivp.scale.pixelsPerInch) ? ivp.scale.pixelsPerInch : 1;
      var itotal = 0; for (var ii = 1; ii < idraw.length; ii++) itotal += Math.hypot(idraw[ii].x - idraw[ii - 1].x, idraw[ii].y - idraw[ii - 1].y);
      var iseg = 0, iang = 0;
      if (idraw.length >= 2) { var ia = idraw[idraw.length - 2], ib = idraw[idraw.length - 1]; iseg = Math.hypot(ib.x - ia.x, ib.y - ia.y); iang = Math.atan2(-(ib.y - ia.y), ib.x - ia.x) * 180 / Math.PI; }
      var ilines = ['Seg ' + fmtLen(iseg / ippi) + '  ∠ ' + iang.toFixed(1) + '°', 'Total ' + fmtLen(itotal / ippi)];
      if (idraw.length >= 3) {
        var iarea = 0; for (var k = 0; k < idraw.length; k++) { var q1 = idraw[k], q2 = idraw[(k + 1) % idraw.length]; iarea += q1.x * q2.y - q2.x * q1.y; }
        iarea = Math.abs(iarea) / 2 / (ippi * ippi) / 144;   // sheet px² → sq ft
        ilines.push('Area ' + iarea.toFixed(1) + ' SF');
      }
      var ianchor = toScreen(idraw[idraw.length - 1].x, idraw[idraw.length - 1].y);
      ctx.font = '600 11px Arial, sans-serif'; var ibw = 0; ilines.forEach(function (t) { ibw = Math.max(ibw, ctx.measureText(t).width); });
      var ibx = ianchor.x + 12, iby = ianchor.y + 12, ibh = ilines.length * 15 + 8;
      ctx.fillStyle = 'rgba(8,12,20,0.92)'; ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1;
      ctx.fillRect(ibx, iby, ibw + 16, ibh); ctx.strokeRect(ibx, iby, ibw + 16, ibh);
      ctx.fillStyle = '#e6f6ff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ilines.forEach(function (t, i) { ctx.fillText(t, ibx + 8, iby + 6 + i * 15); });
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

  // ── Autosave / dirty tracking (Tier 2) ──────────────────────────
  // Every mutation calls markDirty() (via pushUndo + the calibrate/underlay
  // paths), which debounces an idle autosave. close() + beforeunload flush a
  // final save so edits survive an accidental tab close.
  var AUTOSAVE_MS = 2500;
  function markDirty() {
    if (!S) return;
    S._dirty = true;
    if (S._autosaveT) clearTimeout(S._autosaveT);
    S._autosaveT = setTimeout(function () { saveSilent(); }, AUTOSAVE_MS);
  }
  function saveSilent() {
    if (!S || !S._dirty) return;
    if (S._autosaveT) { clearTimeout(S._autosaveT); S._autosaveT = null; }
    if (typeof S.onSave === 'function') {
      try { S.onSave(serializeDoc(S.doc), {}); S._dirty = false; setHint('Saved.'); }
      catch (e) { /* keep dirty; a later edit / close will retry */ }
    }
  }
  function save() {
    if (S && S._autosaveT) { clearTimeout(S._autosaveT); S._autosaveT = null; }
    if (S) S._dirty = false;
    if (S && typeof S.onSave === 'function') { try { S.onSave(serializeDoc(S.doc), {}); } catch (e) { /* defensive */ } }
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
        var ulBtn = S.overlay.querySelector('#p86-sheet-underlay'); if (ulBtn) ulBtn.onclick = importUnderlay;
        var smBtn = S.overlay.querySelector('#p86-space-model'); if (smBtn) smBtn.onclick = function () { setSpace('model'); };
        var ssBtn = S.overlay.querySelector('#p86-space-sheet'); if (ssBtn) ssBtn.onclick = function () { setSpace('sheet'); };
      }
    },
    close: close,
    defaultDoc: defaultDoc,
    buildDxf: buildDxf,
    SHEET_SIZES: SHEET_SIZES,
    DPI: DPI
  };
})();
