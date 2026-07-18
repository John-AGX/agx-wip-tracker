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
    { key: 'mirror2',  glyph: '⋈', name: 'Mirror 2-pt', group: 'Modify',  label: 'Mirror (two-point) — select objects first, then click two points on the mirror line; mirrored COPIES are created (originals kept)' },
    { key: 'dim',      glyph: '↔', name: 'Dimension',  group: 'Annotate', label: 'Dimension (aligned — click two points; auto-labels real length along the line at the viewport scale)' },
    { key: 'dimradius',glyph: 'R', name: 'Radius dim',  group: 'Annotate', label: 'Radius dimension — click a circle / ellipse; labels its radius (R …)' },
    { key: 'dimdia',   glyph: '⌀', name: 'Diameter dim',group: 'Annotate', label: 'Diameter dimension — click a circle / ellipse; labels its diameter (⌀ …)' },
    { key: 'dimcont',  glyph: '⊢', name: 'Continuous',  group: 'Annotate', label: 'Continuous dimension chain — click points in a row; each span is dimensioned (Enter / Esc to finish)' },
    { key: 'angle',    glyph: '∠', name: 'Angle dim',  group: 'Annotate', label: 'Angle dimension (click three points: leg · vertex · leg)' },
    { key: 'leader',   glyph: '➘', name: 'Leader',     group: 'Annotate', label: 'Leader / callout (click target, click text position)' },
    { key: 'revcloud', glyph: '☁', name: 'Rev cloud',  group: 'Annotate', label: 'Revision cloud — click two opposite corners; drawn as a scalloped cloud around that box' },
    { key: 'text',     glyph: 'T', name: 'Text',       group: 'Annotate', label: 'Text (click to place)' },
    { key: 'hatch',    glyph: '▨', name: 'Hatch',      group: 'Annotate', label: 'Hatch fill (click a closed region; pick a material pattern) — double-click / Enter to close' },
    { key: 'wipeout',  glyph: '▩', name: 'Wipeout',    group: 'Annotate', label: 'Wipeout — opaque paper-white mask; click a region over underlay/linework you want blanked out (dims & labels stay readable on top). Double-click / Enter to close.' },
    { key: 'symbol',   glyph: '✱', name: 'Symbol',     group: 'Annotate', label: 'Symbol / block (north arrow, sprinkler head, post, tree, callout)' },
    { key: 'level',    glyph: '↧', name: 'Level',      group: 'Annotate', label: 'Level / elevation line — horizontal datum at a set elevation (e.g. 10\') with a head marker. Prints. The first one sets the datum.' },
    { key: 'spotelev', glyph: '⌖', name: 'Spot elev',  group: 'Annotate', label: 'Spot elevation — click any point to tag its height above the level datum. Prints.' },
    { key: 'refline',  glyph: '┈', name: 'Ref line',   group: 'Annotate', label: 'Reference line (construction guide — snaps & trims to, but is NOT printed or exported)' },
    { key: 'inquire',  glyph: '⊾', name: 'Measure',    group: 'View',     label: 'Measure / inquiry — click points for distance, angle, running total & enclosed area. Does NOT print. Enter/Esc clears.' },
    { key: 'calibrate',glyph: '📐', name: 'Calibrate',  group: 'View',     label: 'Calibrate scale — click two points a known distance apart on the plan underlay, then type the real length (e.g. 20\'). Sets this viewport\'s scale so every measurement reads true.' },
    { key: 'pan',      glyph: '✋', name: 'Pan',        group: 'View',     label: 'Pan (or hold Space / middle-drag)' },
    { key: 'zoomwin',  glyph: '⌕', name: 'Zoom win',   group: 'View',     label: 'Zoom window — click two corners of the area to fill the screen (Z)' }
  ];
  // Non-tool buttons (edit ops + history/util) shown in the drawer, grouped.
  var EDIT_ITEMS = [
    { key: 'rotate',  act: 'edit', glyph: '⟳', name: 'Rotate 90°', group: 'Modify', label: 'Rotate selection 90°' },
    { key: 'rotateA', act: 'edit', glyph: '∠', name: 'Rotate ∠',  group: 'Modify', label: 'Rotate selection by a typed angle about its center (clockwise; negative = counter-clockwise)' },
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
    { key: 'redo',    act: 'redo', glyph: '↷', name: 'Redo',       group: 'View',   label: 'Redo (Ctrl+Y / Ctrl+Shift+Z)' },
    { key: 'pdf',     act: 'export', glyph: '⎙', name: 'PDF',      group: 'Output', label: 'Print / Save as PDF at true sheet size' },
    { key: 'png',     act: 'export', glyph: '⬇', name: 'PNG',      group: 'Output', label: 'Download the sheet as a PNG' },
    { key: 'dxf',     act: 'export', glyph: '⛁', name: 'DXF',      group: 'Output', label: 'Export to DXF — opens to scale in AutoCAD / any CAD app' }
  ];
  var TOOL_GROUP_ORDER = ['Draw', 'Modify', 'Annotate', 'View'];
  // AutoCAD-style ribbon: tabs → panels → items. Items are tool keys (TOOLS) or
  // 'edit:<key>' (EDIT_ITEMS). Reuses every existing tool/edit handler.
  var RIBBON = [
    { tab: 'Draw', panels: [
      { title: 'Draw', items: ['line', 'polyline', 'rect', 'circle', 'arc', 'ellipse', 'polygon', 'spline'] },
      { title: 'Select', items: ['select'] }
    ] },
    { tab: 'Modify', panels: [
      { title: 'Modify', items: ['trim', 'extend', 'fillet', 'chamfer', 'break'] },
      { title: 'Arrange', items: ['edit:dup', 'edit:offset', 'edit:scale', 'edit:rotate', 'edit:rotateA', 'edit:mirrorH', 'edit:mirrorV', 'mirror2', 'stretch'] },
      { title: 'Array', items: ['polararray', 'edit:array'] },
      { title: 'Combine', items: ['edit:explode', 'edit:join'] }
    ] },
    { tab: 'Annotate', panels: [
      { title: 'Dimensions', items: ['dim', 'dimcont', 'dimradius', 'dimdia', 'angle'] },
      { title: 'Text & Notes', items: ['text', 'leader', 'revcloud'] },
      { title: 'Fills & Symbols', items: ['hatch', 'wipeout', 'symbol'] },
      { title: 'Levels', items: ['level', 'spotelev', 'refline'] }
    ] },
    { tab: 'View', panels: [
      { title: 'Measure', items: ['inquire', 'calibrate'] },
      { title: 'Navigate', items: ['pan', 'zoomwin', 'edit:fit'] },
      { title: 'Snaps', items: ['snap:ortho', 'snap:grid', 'snap:osnap'] },
      { title: 'History', items: ['edit:undo', 'edit:redo'] }
    ] },
    { tab: 'Output', panels: [
      { title: 'Export', items: ['pdf', 'png', 'dxf'] }
    ] }
  ];
  // Large (primary) ribbon buttons; everything else renders as a compact small button.
  var RIBBON_PRIMARY = { line: 1, rect: 1, circle: 1, select: 1, trim: 1, extend: 1, fillet: 1, dup: 1, array: 1, dim: 1, text: 1, hatch: 1, inquire: 1, pan: 1, pdf: 1 };
  var SNAP_META = {
    ortho: { name: 'Ortho', label: 'Ortho lock (0 / 45 / 90°) — or hold Shift' },
    grid: { name: 'Grid', label: 'Snap to grid' },
    osnap: { name: 'Osnap', label: 'Object snap (endpoint / midpoint / center / intersection …)' }
  };
  // Monochrome line-icon set (24×24, stroke = currentColor). Crisp CAD-style glyphs.
  var ICONS = {
    select: '<path d="M5 4l13 6-5.5 1.6L10.5 18z" fill="currentColor" stroke="none"/>',
    line: '<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.5"/><circle cx="19" cy="5" r="1.5"/>',
    polyline: '<path d="M3 17l5-6 4 4 4-6 5 4"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    circle: '<circle cx="12" cy="12" r="7.5"/>',
    arc: '<path d="M4 17a8 8 0 0 1 16 0"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="5.5"/>',
    polygon: '<path d="M12 4l7.6 5.5-2.9 9H7.3l-2.9-9z"/>',
    spline: '<path d="M3 15c3-9 6 9 9 0s5-7 9-3"/>',
    trim: '<circle cx="6" cy="7" r="2.2"/><circle cx="6" cy="17" r="2.2"/><path d="M8 8.5L20 16M8 15.5L20 8"/>',
    extend: '<path d="M3 12h11M11 8l4 4-4 4"/><path d="M19 5v14"/>',
    fillet: '<path d="M4 20v-8a6 6 0 0 1 6-6h8"/>',
    break: '<path d="M3 12h6M15 12h6"/><path d="M11.5 8l1.5 8"/>',
    chamfer: '<path d="M4 20v-8l4-4h8"/><path d="M4 12l4-4"/>',
    polararray: '<circle cx="12" cy="12" r="2"/><circle cx="12" cy="4.5" r="1.3"/><circle cx="12" cy="19.5" r="1.3"/><circle cx="4.5" cy="12" r="1.3"/><circle cx="19.5" cy="12" r="1.3"/>',
    stretch: '<rect x="8" y="8" width="8" height="8"/><path d="M2 12h4M18 12h4M6 10l-2 2 2 2M18 10l2 2-2 2"/>',
    dim: '<path d="M4 8v8M20 8v8"/><path d="M4 12h16M4 12l3-2M4 12l3 2M20 12l-3-2M20 12l-3 2"/>',
    dimradius: '<circle cx="12" cy="12" r="7.5"/><path d="M12 12l6-6"/>',
    dimdia: '<circle cx="12" cy="12" r="7.5"/><path d="M6.7 17.3L17.3 6.7"/>',
    dimcont: '<path d="M4 12h16M5 9v6M12 9v6M19 9v6"/>',
    angle: '<path d="M5 19h13M5 19L18 7"/><path d="M5 19a9 9 0 0 1 4.5-7"/>',
    leader: '<path d="M4 20l8-8M4 20l.5-3.5M4 20l3.5-.5"/><path d="M12 12h8"/>',
    revcloud: '<path d="M6 14a2.2 2.2 0 0 1 1.6-3.6A3 3 0 0 1 13 9a2.6 2.6 0 0 1 4 1.4 2.4 2.4 0 0 1 1 4.4 2.6 2.6 0 0 1-2 .8H8a2.4 2.4 0 0 1-2-1.6z"/>',
    text: '<path d="M6 7V5h12v2M12 5v14M9 19h6"/>',
    hatch: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 13l9-9M9 20l11-11M4 18l4-4"/>',
    symbol: '<path d="M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13"/>',
    level: '<path d="M3 12h18"/><path d="M16 12l-2-3h6l-2 3"/>',
    spotelev: '<circle cx="12" cy="12" r="2.2"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
    refline: '<path d="M3 12h18" stroke-dasharray="3 3"/>',
    inquire: '<rect x="3" y="9" width="18" height="6" rx="1"/><path d="M7 9v3M11 9v4M15 9v3"/>',
    calibrate: '<rect x="3" y="9" width="18" height="6" rx="1"/><path d="M7 9v3M15 9v3"/><path d="M9 15l3 4 3-4"/>',
    pan: '<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l2.5 2.5"/>',
    rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M18 3v4h-4"/>',
    rotateA: '<path d="M5 19h13M5 19L16 8"/><path d="M5 19a10 10 0 0 1 3-7.5"/><path d="M17 4l2 2-2 2"/>',
    mirror2: '<path d="M12 3v18" stroke-dasharray="3 2"/><path d="M4 8h4v8H4z"/><path d="M16 8h4v8h-4z" stroke-dasharray="2 2"/>',
    wipeout: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 13l9-9M9 20l11-11" opacity="0.35"/><rect x="8" y="8" width="8" height="8" fill="currentColor" stroke="none" opacity="0.8"/>',
    zoomwin: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/><rect x="7.5" y="7.5" width="6" height="6" stroke-dasharray="2 1.6"/>',
    mirrorH: '<path d="M12 3v18" stroke-dasharray="3 2"/><path d="M9 8L3 12l6 4zM15 8l6 4-6 4z"/>',
    mirrorV: '<path d="M3 12h18" stroke-dasharray="3 2"/><path d="M8 9L12 3l4 6zM8 15l4 6 4-6z"/>',
    dup: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M4 16V4h12"/>',
    offset: '<rect x="8" y="8" width="11" height="11" rx="1"/><rect x="4" y="4" width="11" height="11" rx="1" stroke-dasharray="2.5 2.5"/>',
    scale: '<rect x="5" y="5" width="14" height="14"/><path d="M9 9l6 6M9 9h3.5M9 9v3.5M15 15h-3.5M15 15v-3.5"/>',
    explode: '<path d="M12 12L6 6M12 12l6-6M12 12l6 6M12 12l-6 6"/>',
    join: '<path d="M3 12h7M14 12h7"/><circle cx="12" cy="12" r="1.8"/>',
    array: '<rect x="4" y="4" width="6.5" height="6.5"/><rect x="13.5" y="4" width="6.5" height="6.5"/><rect x="4" y="13.5" width="6.5" height="6.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>',
    redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 0 0-6 6v1"/>',
    png: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="M3 16l5-4 4 3 3-2 6 4"/>',
    pdf: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 13h1.6a1.3 1.3 0 0 1 0 2.6H10v-2.6m0 0v4.6"/>',
    dxf: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 13v4.6l2.2-4.6v4.6"/>',
    ortho: '<path d="M5 19V5h14"/>',
    grid: '<path d="M4 9.5h16M4 14.5h16M9.5 4v16M14.5 4v16"/>',
    osnap: '<circle cx="12" cy="12" r="2.3"/><path d="M12 4v5M12 15v5M4 12h5M15 12h5"/>'
  };
  function svgIcon(key) {
    var p = ICONS[key]; if (!p) return null;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">' + p + '</svg>';
  }
  function ribbonKeyOf(id) { return (id.indexOf('edit:') === 0 || id.indexOf('snap:') === 0) ? id.slice(5) : id; }
  function ribbonIsPrimary(id) { return !!RIBBON_PRIMARY[ribbonKeyOf(id)]; }
  // Single-key tool aliases (no modifier). Ctrl/Cmd combos handled separately.
  var SHORTCUTS = {
    s: 'select', l: 'line', p: 'polyline', r: 'rect', c: 'circle', a: 'arc',
    x: 'trim', e: 'extend', f: 'fillet',
    d: 'dim', g: 'angle', k: 'leader', t: 'text', h: 'hatch', y: 'symbol',
    m: 'inquire', v: 'pan', z: 'zoomwin', w: 'wipeout'
  };

  var HATCH_PATTERNS = [
    { key: 'earth', label: 'Earth' }, { key: 'concrete', label: 'Concrete' },
    { key: 'gravel', label: 'Gravel' }, { key: 'brick', label: 'Brick/Paver' },
    { key: 'grass', label: 'Grass' }, { key: 'solid', label: 'Solid' }
  ];
  var SYMBOLS = [
    { key: 'north', label: 'North' }, { key: 'head', label: 'Head' },
    { key: 'post', label: 'Post' }, { key: 'tree', label: 'Tree' },
    { key: 'callout', label: 'Callout' }, { key: 'revdelta', label: 'Rev Δ' }
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
    dimColor: '#b45309',
    crosshair: true                // AutoCAD-style full-screen crosshair + pickbox
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
  // Label for an arbitrary ppi (viewport wheel-zoom lands between presets):
  // exact preset label when it matches, else a 1"=X' style readout.
  function vpScaleLabel(ppi) {
    for (var i = 0; i < SCALE_PRESETS.length; i++) {
      if (Math.abs(DPI * SCALE_PRESETS[i].f - ppi) < 1e-6) return SCALE_PRESETS[i].label;
    }
    var ftPerIn = DPI / ppi / 12;
    return '1" = ' + (Math.round(ftPerIn * 100) / 100) + '\'';
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
    return healDoc(toV3(toV2(d)));
  }
  // Repair a structurally-incomplete doc so it always renders. Some older
  // drawings were saved as skeletons — a sheet with no w/h, zero viewports,
  // no layers — which make fitView divide by undefined (scale → NaN → blank
  // canvas). Fill the gaps IN PLACE so the flat v2/v3 aliases stay intact,
  // preserving any real entities the doc does carry.
  function healDoc(doc) {
    if (!doc) return doc;
    var sh = doc.sheet || (doc.sheet = {});
    // 1) Sheet dimensions — derive from the named size, else a sane default.
    if (!(sh.w > 0) || !(sh.h > 0)) {
      var sizeKey = SHEET_SIZES[sh.size] ? sh.size : (SHEET_SIZES[SETTINGS.sheetSize] ? SETTINGS.sheetSize : 'arch-d');
      var sz = SHEET_SIZES[sizeKey];
      sh.size = sizeKey;
      sh.w = Math.round(sz.wIn * DPI);
      sh.h = Math.round(sz.hIn * DPI);
    }
    if (sh.margin == null) sh.margin = Math.round(0.5 * DPI);
    // 2) At least one viewport — an empty viewports array leaves the model
    //    with no window (nothing to draw into, no scale). Push into the
    //    existing (aliased) array so doc.sheet.viewports stays in sync.
    if (!doc.viewports || !doc.viewports.length) {
      if (!doc.viewports) doc.viewports = (doc.sheet.viewports = doc.sheet.viewports || []);
      var pre = scalePreset(SETTINGS.scaleLabel);
      var m = sh.margin + 14, tbH = Math.round(3 * DPI);
      doc.viewports.push({
        id: uid('VP'), label: 'PLAN',
        x: m, y: m, w: Math.max(200, sh.w - m * 2), h: Math.max(150, sh.h - m * 2 - tbH - 16),
        scale: { pixelsPerInch: DPI * pre.f, unit: pre.unit || 'ft', label: pre.label }
      });
    }
    // 3) Every viewport needs a model window (v3); base ppi if it wasn't set.
    (doc.viewports || []).forEach(vpWin);
    if (doc.model && !(doc.model.ppi > 0)) doc.model.ppi = vpPpiSafe((doc.viewports || [])[0]);
    // 4) At least one layer.
    if (!doc.layers || !doc.layers.length) {
      if (!doc.layers) doc.layers = [];
      doc.layers.push({ id: 'L0', name: 'Default', color: '#1f2937', weight: 4, lineType: 'solid', visible: true, locked: false });
      if (doc.model) doc.model.layers = doc.layers;
    }
    return doc;
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
    if (doc.version >= 2 && doc.model && doc.sheets) {
      // Saved v2 (flat aliases were stripped on save) — rebuild the aliases.
      var sh = null;
      for (var i = 0; i < doc.sheets.length; i++) { if (doc.sheets[i].id === doc.activeSheetId) { sh = doc.sheets[i]; break; } }
      if (!sh) sh = doc.sheets[0] || (doc.sheets[0] = { id: 'S1', viewports: [] });
      if (!doc.model.entities) doc.model.entities = [];
      if (!doc.model.layers) doc.model.layers = [];
      if (!sh.viewports) sh.viewports = [];
      // Rescue blobs saved with a broken alias (both flat + model present):
      // the flat arrays were the live data, so prefer them over model.*.
      if (Array.isArray(doc.entities) && doc.entities !== doc.model.entities) doc.model.entities = doc.entities;
      if (Array.isArray(doc.layers) && doc.layers !== doc.model.layers) doc.model.layers = doc.layers;
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
  // ── v3: model-canonical coordinates (real CAD semantics) ─────────
  // v3 stores ALL geometry in MODEL INCHES (Y-down internally; readouts are
  // Y-up). Each viewport carries a window {cx, cy} — the model point at the
  // CENTER of its paper rect — and its scale.pixelsPerInch maps model inches
  // → paper px. Paper-anchored SIZES (lineWidth, fontPx, symbol size) stay in
  // paper px, so lineweights and text heights print constant at any viewport
  // scale (annotative behavior) and the shared draw primitives keep their
  // pixel-space constants meaningful.
  function vpPpiSafe(vp) { return (vp && vp.scale && vp.scale.pixelsPerInch) ? vp.scale.pixelsPerInch : DPI * 0.25 / 12; }
  function vpWin(vp) {
    if (!vp.window) {
      // Defensive: a viewport without a window views its own paper rect 1:1.
      var ppi = vpPpiSafe(vp);
      vp.window = { cx: (vp.w / 2) / ppi, cy: (vp.h / 2) / ppi };
    }
    return vp.window;
  }
  // Model inches → paper px through a viewport's window (and back).
  function mToP(pt, vp) {
    var ppi = vpPpiSafe(vp), w = vpWin(vp);
    return { x: vp.x + vp.w / 2 + (pt.x - w.cx) * ppi, y: vp.y + vp.h / 2 + (pt.y - w.cy) * ppi };
  }
  function pToM(pt, vp) {
    var ppi = vpPpiSafe(vp), w = vpWin(vp);
    return { x: w.cx + (pt.x - vp.x - vp.w / 2) / ppi, y: w.cy + (pt.y - vp.y - vp.h / 2) / ppi };
  }
  // Model space renders on a "virtual paper" plane at the doc's base scale so
  // the draw primitives' pixel constants (arrowheads, labels) keep the same
  // proportion to geometry they have on the sheet.
  function mppi() { return (S && S.doc && S.doc.model && S.doc.model.ppi) || DPI * 0.25 / 12; }
  function mToV(pt) { var k = mppi(); return { x: pt.x * k, y: pt.y * k }; }
  function vToM(pt) { var k = mppi(); return { x: pt.x / k, y: pt.y / k }; }
  // Model→plane for the CURRENT space: virtual plane in model view, the given
  // (or active) viewport's paper mapping in sheet view.
  function mToPlane(pt, vp) {
    if (S && S.space === 'model') return mToV(pt);
    return mToP(pt, vp || activeVp());
  }
  function activeVp() {
    var vps = (S && S.doc && S.doc.viewports) || [];
    if (S && S.activeVpId) { for (var i = 0; i < vps.length; i++) if (vps[i].id === S.activeVpId) return vps[i]; }
    return vps[0] || { x: 0, y: 0, w: 100, h: 100, window: { cx: 0, cy: 0 } };
  }
  function vpById(id) {
    var vps = (S && S.doc && S.doc.viewports) || [];
    for (var i = 0; i < vps.length; i++) if (vps[i].id === id) return vps[i];
    return null;
  }
  // Geometry-mapped shallow clone — what the renderer hands the (pixel-space)
  // draw primitives. Sizes are already paper px, so only coordinates map.
  function entOnPlane(raw, mapFn) {
    var e = {};
    for (var k in raw) { if (Object.prototype.hasOwnProperty.call(raw, k)) e[k] = raw[k]; }
    if (raw.points) e.points = raw.points.map(function (p) { var m = mapFn(p); return { x: m.x, y: m.y }; });
    if (raw.startX != null) {
      var a = mapFn({ x: raw.startX, y: raw.startY }), b = mapFn({ x: raw.endX, y: raw.endY });
      e.startX = a.x; e.startY = a.y; e.endX = b.x; e.endY = b.y;
    }
    if (raw.x != null) { var q = mapFn({ x: raw.x, y: raw.y }); e.x = q.x; e.y = q.y; }
    return e;
  }
  // v2 → v3 migration. Each viewport's content converts from its paper px to
  // model inches by its OWN scale, and lands in its OWN model region (running
  // X offset + gap) — so multi-view sheets (plan over elevation) don't overlay
  // once rendering goes tag-free. Windows are chosen so every sheet renders
  // pixel-identical to v2. Round-trip invariant: mToP(migrated pt, vp) ===
  // original paper pt.
  function toV3(doc) {
    if (!doc || !doc.model || !doc.sheets) return doc;
    if (doc.version >= 3) {
      // Saved v3 — just make sure every viewport has a window + base ppi set.
      (doc.sheets || []).forEach(function (sh) { (sh.viewports || []).forEach(vpWin); });
      if (!doc.model.ppi) doc.model.ppi = vpPpiSafe((doc.viewports || [])[0]);
      return doc;
    }
    var offX = 0, byVp = {}, firstPpi = null;
    (doc.sheets || []).forEach(function (sh) {
      (sh.viewports || []).forEach(function (vp) {
        var ppi = vpPpiSafe(vp);
        if (firstPpi == null) firstPpi = ppi;
        var rw = vp.w / ppi, rh = vp.h / ppi;
        vp.window = { cx: offX + rw / 2, cy: rh / 2 };
        // paper→model for this vp: m = p/ppi + o (o baked so vp.xy ↦ region origin)
        byVp[vp.id] = { ppi: ppi, ox: offX - vp.x / ppi, oy: -vp.y / ppi };
        offX += rw * 1.25;
      });
    });
    var fallback = null;
    for (var k in byVp) { if (Object.prototype.hasOwnProperty.call(byVp, k)) { fallback = byVp[k]; break; } }
    if (!fallback) fallback = { ppi: DPI * 0.25 / 12, ox: 0, oy: 0 };
    function mapPt(o, x, y) { return { x: x / o.ppi + o.ox, y: y / o.ppi + o.oy }; }
    (doc.model.entities || []).forEach(function (e) {
      if (!e) return;
      var o = byVp[e.viewport] || fallback;
      if (e.points) e.points.forEach(function (p) { var m = mapPt(o, p.x, p.y); p.x = m.x; p.y = m.y; });
      if (e.startX != null) {
        var a = mapPt(o, e.startX, e.startY), b = mapPt(o, e.endX, e.endY);
        e.startX = a.x; e.startY = a.y; e.endX = b.x; e.endY = b.y;
      }
      if (e.x != null) { var q = mapPt(o, e.x, e.y); e.x = q.x; e.y = q.y; }
    });
    var u = doc.underlay;
    if (u && u.x != null) {
      var uo = byVp[u.viewport] || fallback;
      var up = mapPt(uo, u.x, u.y);
      u.x = up.x; u.y = up.y; u.w = u.w / uo.ppi; u.h = u.h / uo.ppi;
    }
    doc.model.ppi = firstPpi || DPI * 0.25 / 12;
    doc.version = 3;
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
    out.kind = 'sheet-doc'; out.version = (doc.version >= 3) ? 3 : 2;
    // Heal a broken model⇄flat alias before stripping: the flat working arrays
    // are always the LIVE data (every editor mutation targets doc.entities),
    // while several sites (undo restore, filters) reassign the flat array
    // without re-pointing model.*. toV2 rebuilds from model.* on load, so
    // adopt the flat arrays as truth here — never save a stale model copy.
    if (out.model && Array.isArray(out.entities)) {
      out.model.entities = out.entities;
      if (Array.isArray(out.layers)) out.model.layers = out.layers;
    }
    if (out.model && Array.isArray(out.sheets) && out.sheets.length) {
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
    // ── Model space: the model plane itself (virtual paper = model × base
    // ppi). One tag-free pass over ALL entities; no clip, no chrome.
    if (opts.modelMode) {
      if (opts.visible) drawModelField(ctx, doc, opts);
      try { drawUnderlayMapped(ctx, mToV); } catch (err) { /* defensive */ }
      drawDocEntities(ctx, doc, mToV, opts, true);
      return;
    }

    // ── Sheet space: white paper + borders, then every viewport WINDOWS into
    // the model — each maps model inches → its paper rect at its own scale.
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
      // Activated viewport (MSPACE-style editing through the window) gets a
      // solid heavy border so it's obvious pan/zoom now drive the window.
      if (opts.editor && opts.activeVpId === vp.id) {
        ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 4;
        ctx.strokeRect(vp.x, vp.y, vp.w, vp.h);
      }
      // clip content to the viewport frame
      ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.w, vp.h); ctx.clip();
      var map = function (p) { return mToP(p, vp); };
      try { drawUnderlayMapped(ctx, map); } catch (err) { /* defensive */ }
      // Editor-only faint reference grid on the MODEL lattice (so it always
      // agrees with grid snap), mapped through this viewport's window.
      if (opts.grid) drawViewportGrid(ctx, vp, opts.viewScale || 1);
      drawDocEntities(ctx, doc, map, opts, false);
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

  // Shared entity pass: map every entity's MODEL geometry onto the target
  // plane (a viewport's paper, or the model view's virtual paper) and hand the
  // pixel-space clone to the draw primitives. Sizes stay paper px by design.
  function drawDocEntities(ctx, doc, mapFn, opts, invertInk) {
    if (typeof prims().drawStroke !== 'function') return;
    (doc.entities || []).forEach(function (raw) {
      if (!raw || !raw.tool) return;
      var lyr = layerById(doc, raw.layer);
      if (lyr && lyr.visible === false) return;
      // Dimension labels derive live from MODEL geometry — v3 model units ARE
      // inches, so the label is just the distance. Written to the persisted
      // entity (DXF export reads it without a render pass).
      if (raw.tool === 'measure') {
        raw.measureInches = Math.hypot(raw.endX - raw.startX, raw.endY - raw.startY);
        var mlbl = fmtLen(raw.measureInches);
        if (raw.dimKind === 'radius') mlbl = 'R ' + mlbl;
        else if (raw.dimKind === 'diameter') mlbl = '⌀ ' + mlbl;   // ⌀
        raw.measureLabel = mlbl;
      }
      var e = entOnPlane(raw, mapFn);
      if (invertInk && e.color) e.color = modelInkColor(e.color);
      if (e.tool === 'wipeout') { try { drawWipeout(ctx, e, opts, invertInk); } catch (err) {} return; }
      if (e.tool === 'hatch') { try { drawHatch(ctx, e); } catch (err) {} return; }
      if (e.tool === 'symbol') { try { drawSymbol(ctx, e); } catch (err) {} return; }
      if (e.tool === 'arc') { try { drawArc(ctx, e); } catch (err) {} return; }
      if (e.tool === 'level') { try { drawLevel(ctx, e); } catch (err) {} return; }
      if (e.tool === 'spotelev') { try { drawSpotElev(ctx, e, elevAtPoint(raw)); } catch (err) {} return; }
      if (e.tool === 'refline') { if (opts.editor) { try { drawRefline(ctx, e); } catch (err) {} } return; }   // construction guide — editor only, never exported
      try { prims().drawStroke(ctx, e); } catch (err) { /* defensive */ }
    });
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
    } else if (e.kind === 'revdelta') {
      // Numbered revision-delta triangle — pairs with the rev cloud and the
      // titleblock revision strip so reissued sheets are traceable.
      ctx.beginPath(); ctx.moveTo(0, -r * 0.9); ctx.lineTo(-r * 0.82, r * 0.55); ctx.lineTo(r * 0.82, r * 0.55); ctx.closePath(); ctx.stroke();
      ctx.fillStyle = col; ctx.font = '700 ' + Math.round(s * 0.4) + 'px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(e.label != null ? e.label : '?'), 0, r * 0.15);
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
  // Circumcenter of a 3-point arc (null when collinear). Feeds the arc
  // center osnap — arcs are points-based, so the generic candidate pass
  // never computes this.
  function arcCenter(pts) {
    if (!pts || pts.length < 3) return null;
    var ax = pts[0].x, ay = pts[0].y, bx = pts[1].x, by = pts[1].y, cx = pts[2].x, cy = pts[2].y;
    var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-6) return null;
    var ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    var uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    return { x: ux, y: uy, r: Math.hypot(ax - ux, ay - uy) };
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
    // v3: model units ARE inches (Y down) — height above datum is plain Δy.
    var dat = datumForViewport(e.viewport);
    if (dat) return dat.elevIn + (dat.y - e.y);
    var vp = viewportOf(e);
    if (!vp) return 0;
    var ppi = vpPpiSafe(vp), w = vpWin(vp);
    return (w.cy + (vp.h / 2) / ppi) - e.y;          // fallback: above the window floor
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
  // The elevation label is computed by the caller from the MODEL entity (this
  // function receives a plane-mapped clone whose coords are paper px).
  function drawSpotElev(ctx, e, elevIn) {
    var s = Math.round(DPI * 0.12);
    ctx.save();
    ctx.strokeStyle = e.color || '#0ea5e9'; ctx.fillStyle = e.color || '#0ea5e9'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(e.x - s * 0.6, e.y - s); ctx.lineTo(e.x + s * 0.6, e.y - s); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(e.x, e.y, 2, 0, Math.PI * 2); ctx.fill();
    ctx.font = '700 ' + Math.round(DPI * 0.12) + 'px Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('+' + fmtFeet(elevIn != null ? elevIn : 0), e.x + s * 0.8, e.y - s);
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
  // Wipeout: an opaque paper mask — blanks the underlay + earlier linework
  // beneath it so dims/labels drawn later stay readable. Paper-white on the
  // sheet; the model-field bg when ink-inverted in model space. The dashed
  // outline is EDITOR-ONLY (finds the mask; never prints/exports).
  function drawWipeout(ctx, e, opts, invertInk) {
    if (!e.points || e.points.length < 2) return;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(e.points[0].x, e.points[0].y);
    for (var i = 1; i < e.points.length; i++) ctx.lineTo(e.points[i].x, e.points[i].y);
    ctx.closePath();
    if (e.points.length >= 3) { ctx.fillStyle = invertInk ? '#1e232b' : '#ffffff'; ctx.fill(); }
    if (opts && opts.editor) {
      ctx.strokeStyle = 'rgba(148,163,184,0.55)'; ctx.lineWidth = 1; ctx.setLineDash([6, 5]);
      ctx.stroke();
    }
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
  // Grid spacing in MODEL INCHES (v3 model units are real inches, so this is
  // the whole story — no ppi). The vp only picks the unit family.
  function gridStepIn(vp) {
    return (vp && vp.scale && vp.scale.unit === 'in')
      ? (SETTINGS.gridIn || 1)
      : 12 * (SETTINGS.gridFt || 1);
  }
  function gridMajorMult(vp) { return (vp && vp.scale && vp.scale.unit === 'in') ? 12 : 5; }
  // Sheet-space reference grid: the MODEL lattice (anchored at the model
  // origin, same lattice grid-snap uses) mapped through the viewport window —
  // grid lines and snapped points agree by construction.
  function drawViewportGrid(ctx, vp, viewScale) {
    var stepIn = gridStepIn(vp), ppi = vpPpiSafe(vp);
    if (!stepIn || stepIn * ppi * viewScale < 7) return;       // too dense at this zoom
    var w = vpWin(vp);
    var mx0 = w.cx - (vp.w / 2) / ppi, mx1 = w.cx + (vp.w / 2) / ppi;
    var my0 = w.cy - (vp.h / 2) / ppi, my1 = w.cy + (vp.h / 2) / ppi;
    var y0 = vp.y, y1 = vp.y + vp.h, x0 = vp.x, x1 = vp.x + vp.w, m, p;
    ctx.save();
    function lines(step, style, lw) {
      ctx.strokeStyle = style; ctx.lineWidth = lw / viewScale;
      for (m = Math.ceil(mx0 / step) * step; m <= mx1; m += step) {
        p = mToP({ x: m, y: my0 }, vp);
        ctx.beginPath(); ctx.moveTo(p.x, y0); ctx.lineTo(p.x, y1); ctx.stroke();
      }
      for (m = Math.ceil(my0 / step) * step; m <= my1; m += step) {
        p = mToP({ x: mx0, y: m }, vp);
        ctx.beginPath(); ctx.moveTo(x0, p.y); ctx.lineTo(x1, p.y); ctx.stroke();
      }
    }
    lines(stepIn, 'rgba(37,99,235,0.09)', 1);
    lines(stepIn * gridMajorMult(vp), 'rgba(37,99,235,0.20)', 1.3);
    ctx.restore();
  }

  // ── Model-space field — the environment behind the geometry ──────
  // Drawn on the virtual plane (model inches × base ppi). Infinite grid on
  // the model lattice (anchored at the model origin — the same lattice grid
  // snap uses), origin axes + UCS icon at (0,0), and every viewport's WINDOW
  // as a dashed outline showing exactly which model region prints where.
  function drawModelField(ctx, doc, opts) {
    var vis = opts.visible, vs = opts.viewScale || 1, k = mppi();
    var vp0 = (doc.viewports || [])[0];
    var step = gridStepIn(vp0) * k;                 // virtual-plane px per grid cell
    if (opts.grid && step && step * vs >= 7) {
      var major = step * gridMajorMult(vp0);
      var x, y;
      ctx.save();
      ctx.strokeStyle = 'rgba(120,140,170,0.10)'; ctx.lineWidth = 1 / vs;
      for (x = Math.floor(vis.x0 / step) * step; x <= vis.x1; x += step) { ctx.beginPath(); ctx.moveTo(x, vis.y0); ctx.lineTo(x, vis.y1); ctx.stroke(); }
      for (y = Math.floor(vis.y0 / step) * step; y <= vis.y1; y += step) { ctx.beginPath(); ctx.moveTo(vis.x0, y); ctx.lineTo(vis.x1, y); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(120,140,170,0.20)'; ctx.lineWidth = 1.3 / vs;
      for (x = Math.floor(vis.x0 / major) * major; x <= vis.x1; x += major) { ctx.beginPath(); ctx.moveTo(x, vis.y0); ctx.lineTo(x, vis.y1); ctx.stroke(); }
      for (y = Math.floor(vis.y0 / major) * major; y <= vis.y1; y += major) { ctx.beginPath(); ctx.moveTo(vis.x0, y); ctx.lineTo(vis.x1, y); ctx.stroke(); }
      ctx.restore();
    }
    // Origin axes + UCS icon at the model origin (0,0).
    ctx.save();
    ctx.lineWidth = 1.4 / vs;
    ctx.strokeStyle = 'rgba(225,85,85,0.45)';
    ctx.beginPath(); ctx.moveTo(vis.x0, 0); ctx.lineTo(vis.x1, 0); ctx.stroke();
    ctx.strokeStyle = 'rgba(80,200,120,0.45)';
    ctx.beginPath(); ctx.moveTo(0, vis.y0); ctx.lineTo(0, vis.y1); ctx.stroke();
    var L = 46 / vs, ah = 7 / vs;
    ctx.lineWidth = 2 / vs; ctx.lineCap = 'round';
    ctx.strokeStyle = '#e15555'; ctx.fillStyle = '#e15555';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(L, 0); ctx.lineTo(L - ah, -ah * 0.62); ctx.lineTo(L - ah, ah * 0.62); ctx.closePath(); ctx.fill();
    ctx.font = '700 ' + (11 / vs) + 'px Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('X', L + 4 / vs, -2 / vs);
    ctx.strokeStyle = '#50c878'; ctx.fillStyle = '#50c878';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -L); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -L); ctx.lineTo(-ah * 0.62, -L + ah); ctx.lineTo(ah * 0.62, -L + ah); ctx.closePath(); ctx.fill();
    ctx.fillText('Y', 4 / vs, -L - 2 / vs);
    ctx.restore();
    // Viewport windows — the model region each view of the active sheet prints.
    ctx.save();
    ctx.lineWidth = 1 / vs; ctx.setLineDash([10 / vs, 7 / vs]);
    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.font = '600 ' + (10 / vs) + 'px Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    (doc.viewports || []).forEach(function (v) {
      var ppi = vpPpiSafe(v), w = vpWin(v);
      var rx = (w.cx - (v.w / 2) / ppi) * k, ry = (w.cy - (v.h / 2) / ppi) * k;
      var rw = (v.w / ppi) * k, rh = (v.h / ppi) * k;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.fillText((v.label || 'VIEW') + ' — sheet window', rx + 2 / vs, ry - 3 / vs);
    });
    ctx.restore();
  }
  // Ink inversion for the dark model field: paper colors are picked for white
  // sheets, so near-black strokes would vanish. Flip only very dark, low-
  // saturation inks to a light drafting gray (AutoCAD's black↔white flip);
  // real colors (dim amber, cyan, layer colors) pass through untouched.
  var _inkCache = {};
  function modelInkColor(c) {
    var key = String(c || '');
    if (_inkCache[key] !== undefined) return _inkCache[key];
    var h = key.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var out = key;
    if (/^[0-9a-fA-F]{6}$/.test(h)) {
      var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      var sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      if (lum < 0.30 && sat < 0.35) out = '#dde3ec';
    }
    _inkCache[key] = out;
    return out;
  }
  function modelInk(e) {
    if (!e || !e.color) return e;
    var inv = modelInkColor(e.color);
    if (inv === e.color) return e;
    var c = {}; for (var k in e) { if (Object.prototype.hasOwnProperty.call(e, k)) c[k] = e[k]; }
    c.color = inv;
    return c;
  }

  function fitView(doc, cw, ch) {
    var s = doc.sheet, pad = 40;
    var scale = Math.min((cw - pad * 2) / s.w, (ch - pad * 2) / s.h);
    return { scale: scale, tx: (cw - s.w * scale) / 2, ty: (ch - s.h * scale) / 2 };
  }
  // Zoom-extents for model space: frame the drawing content (all entities on
  // the active sheet's viewports), falling back to the viewport rect when the
  // drawing is empty. AutoCAD's ZOOM E.
  // Zoom-extents bbox of the WHOLE model (v3 = one model, all regions), in
  // model inches; falls back to the primary viewport's window when empty.
  function contentBBox() {
    var mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity, any = false;
    (S.doc.entities || []).forEach(function (e) {
      if (!e) return;
      var bb = entBBox(e); if (!bb) return;
      any = true;
      if (bb.x < mnx) mnx = bb.x; if (bb.y < mny) mny = bb.y;
      if (bb.x + bb.w > mxx) mxx = bb.x + bb.w; if (bb.y + bb.h > mxy) mxy = bb.y + bb.h;
    });
    var u = S.doc.underlay;
    if (u && u.x != null) {
      any = true;
      mnx = Math.min(mnx, u.x); mny = Math.min(mny, u.y);
      mxx = Math.max(mxx, u.x + u.w); mxy = Math.max(mxy, u.y + u.h);
    }
    if (!any) {
      var vp = (S.doc.viewports || [])[0];
      if (!vp) return { x: 0, y: 0, w: 480, h: 360 };
      var ppi = vpPpiSafe(vp), w = vpWin(vp);
      return { x: w.cx - (vp.w / 2) / ppi, y: w.cy - (vp.h / 2) / ppi, w: vp.w / ppi, h: vp.h / ppi };
    }
    return { x: mnx, y: mny, w: Math.max(mxx - mnx, 10), h: Math.max(mxy - mny, 10) };
  }
  function fitModelView() {
    var cw = S.cssW || S.canvas.width, ch = S.cssH || S.canvas.height, pad = 60;
    var k = mppi(), bb = contentBBox();
    // Camera works on the virtual plane (model × base ppi).
    var vb = { x: bb.x * k, y: bb.y * k, w: Math.max(bb.w * k, 1), h: Math.max(bb.h * k, 1) };
    var scale = Math.min((cw - pad * 2) / vb.w, (ch - pad * 2) / vb.h);
    scale = Math.max(0.02, Math.min(scale, 20));
    return { scale: scale, tx: (cw - vb.w * scale) / 2 - vb.x * scale, ty: (ch - vb.h * scale) / 2 - vb.y * scale };
  }
  // The canvas cursor the active tool wants. With the CAD crosshair on we hide
  // the native cursor and draw our own crosshair + pickbox in repaint().
  function baseCursor() {
    if (S && S.tool === 'pan') return 'grab';
    if (SETTINGS.crosshair !== false) return 'none';
    return (S && S.tool === 'select') ? 'default' : 'crosshair';
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
        '<button id="p86-sheet-settings" title="Editor settings &amp; defaults (units, scale, sheet size, grid, snaps)" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 11px;font-size:13px;cursor:pointer;">⚙</button>' +
        '<button id="p86-sheet-shortcuts" title="Keyboard shortcuts (?)" style="background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid #444;border-radius:6px;padding:6px 11px;font-size:13px;cursor:pointer;">⌨</button>' +
        '<button id="p86-sheet-underlay" title="Import a plan PDF/image as a scaled background to trace + measure over (takeoff)" style="background:rgba(79,140,255,0.14);color:#cbd5e1;border:1px solid #4f8cff;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;">⊞ Underlay</button>' +
        // PNG / PDF / DXF now live in the ribbon's Output tab.
        '<button id="p86-sheet-cancel" style="background:rgba(255,255,255,0.06);color:#aaa;border:1px solid #444;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;">Close</button>' +
        '<button id="p86-sheet-save" style="background:#4f8cff;color:#fff;border:0;border-radius:6px;padding:6px 16px;font-size:12px;font-weight:700;cursor:pointer;">Save</button>' +
      '</div>' +
      // AutoCAD-style top ribbon (tabs + panels) — populated by buildToolbar().
      '<div id="p86-sheet-ribbon"></div>' +
      '<div style="display:flex;gap:10px;flex:1;min-height:0;">' +
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
          '<div id="p86-sheet-hint" style="position:absolute;left:12px;bottom:38px;color:#64748b;font-size:11px;pointer-events:none;"></div>' +
          // AutoCAD-style layout tabs — bottom-left of the drawing area:
          // [ Model ][ A-1 ][ A-2 ]…[ + ]. Populated by buildSpaceTabs().
          '<div id="p86-layout-tabs" title="Model = the drawing itself, true size · sheet tabs = titleblocked pages that print · + adds a sheet · double-click a tab to rename" style="position:absolute;left:0;bottom:0;display:flex;align-items:flex-end;gap:0;max-width:82%;overflow-x:auto;background:rgba(10,13,19,0.92);border-top:1px solid #2a2a3a;border-right:1px solid #2a2a3a;border-radius:0 8px 0 0;padding:0 4px 0 0;"></div>' +
        '</div>' +
        // right: layers
        '<div id="p86-sheet-layers" style="width:184px;flex:0 0 184px;background:rgba(15,15,30,0.95);border:1px solid #2a2a3a;border-radius:10px;padding:10px;overflow-y:auto;color:#e6e6e6;font-size:12px;"></div>' +
      '</div>' +
      // bottom status bar (AutoCAD-style): coords · tool · snap · zoom · mode toggles
      '<div style="display:flex;align-items:center;gap:14px;margin-top:8px;background:rgba(15,15,30,0.95);border:1px solid #2a2a3a;border-radius:8px;padding:5px 12px;font-size:11px;color:#9aa;font-variant-numeric:tabular-nums;">' +
        '<span id="p86-sb-space" title="Toggle Model / Paper space (like AutoCAD\'s MODEL button)" style="cursor:pointer;font-weight:700;letter-spacing:.06em;padding:2px 9px;border-radius:5px;border:1px solid #3a3a4a;user-select:none;">PAPER</span>' +
        '<span id="p86-sb-coords" style="min-width:188px;color:#cbd5e1;">x —   y —</span>' +
        '<span id="p86-sb-snap" style="min-width:78px;color:#fbbf24;"></span>' +
        '<span id="p86-sb-view" style="color:#64748b;"></span>' +
        '<span style="flex:1;"></span>' +
        '<span id="p86-sb-zoom" style="color:#64748b;margin-right:6px;"></span>' +
        // Ortho / Grid / Osnap toggles now live on the ribbon's View › Snaps panel.
      '</div>';
    document.body.appendChild(ov);

    var canvas = ov.querySelector('#p86-sheet-canvas');
    S = {
      overlay: ov, canvas: canvas, ctx: canvas.getContext('2d'),
      doc: doc, plan: plan, onSave: opts.onSave,
      view: { scale: 1, tx: 0, ty: 0 },
      tool: 'select',
      // 'sheet' = titleblocked paper | 'model' = the drawing itself (dark
      // infinite canvas, true size). Honors the space persisted on the doc —
      // reopening lands where you left off, like AutoCAD's tab memory.
      space: (doc.space === 'model') ? 'model' : 'sheet',
      ribbonTab: 'Draw',    // active AutoCAD-style ribbon tab
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
    buildSpaceTabs();
    sizeCanvas(true);
    if (S.space === 'model') S.view = fitModelView();   // reopened in model space → frame the drawing, not the paper
    wireInput();
    var sbSpace = ov.querySelector('#p86-sb-space');
    if (sbSpace) sbSpace.onclick = function () { setSpace(S.space === 'model' ? 'sheet' : 'model'); };
    S.canvas.style.cursor = baseCursor();
    repaint();
    refreshStatusBar();
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
  // One-time stylesheet for the editor ribbon (kept self-contained in the overlay
  // so the editor doesn't depend on app CSS).
  function injectToolStyle() {
    if (document.getElementById('p86se-tools-style')) return;
    var st = document.createElement('style');
    st.id = 'p86se-tools-style';
    st.textContent =
      // ── AutoCAD-style ribbon (top) ──
      '#p86-sheet-ribbon{flex:0 0 auto;margin-bottom:10px;background:linear-gradient(180deg,#1a1f2b 0%,#12151d 60%,#0f1219 100%);border:1px solid #2c3242;border-radius:11px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.35),inset 0 1px 0 rgba(255,255,255,0.03);}' +
      '#p86-sheet-ribbon .p86rb-tabs{display:flex;gap:2px;padding:6px 10px 0;border-bottom:1px solid #2a3142;background:rgba(0,0,0,0.22);}' +
      '#p86-sheet-ribbon .p86rb-tab{background:transparent;color:#97a3ba;border:0;border-radius:8px 8px 0 0;padding:8px 20px;font-size:12.5px;font-weight:700;letter-spacing:.4px;cursor:pointer;transition:color .12s,background .12s;}' +
      '#p86-sheet-ribbon .p86rb-tab:hover{background:rgba(255,255,255,0.05);color:#d3dcec;}' +
      '#p86-sheet-ribbon .p86rb-tab.on{background:linear-gradient(180deg,#222a3b,#1a2030);color:#fff;box-shadow:inset 0 -2px 0 #4f8cff;}' +
      '#p86-sheet-ribbon .p86rb-body{display:flex;gap:0;padding:9px 6px 7px;overflow-x:auto;align-items:stretch;}' +
      '#p86-sheet-ribbon .p86rb-panel{display:flex;flex-direction:column;padding:0 11px;border-right:1px solid #232a39;flex:0 0 auto;}' +
      '#p86-sheet-ribbon .p86rb-panel:last-child{border-right:0;}' +
      '#p86-sheet-ribbon .p86rb-pbtns{display:flex;flex-direction:column;flex-wrap:wrap;height:74px;align-content:flex-start;gap:4px;}' +
      '#p86-sheet-ribbon .p86rb-ptitle{font-size:9px;font-weight:700;letter-spacing:.9px;color:#5d6981;text-transform:uppercase;text-align:center;margin-top:7px;}' +
      '#p86-sheet-ribbon .p86rb-btn{display:flex;align-items:center;background:transparent;color:#d7deea;border:1px solid transparent;border-radius:7px;cursor:pointer;line-height:1.05;transition:background .1s,border-color .1s;}' +
      '#p86-sheet-ribbon .p86rb-btn:hover{background:rgba(255,255,255,0.08);border-color:#3c4660;}' +
      '#p86-sheet-ribbon .p86rb-btn.on{background:rgba(251,191,36,0.17);border-color:#fbbf24;color:#fde68a;}' +
      '#p86-sheet-ribbon .p86rb-btn .g{display:flex;align-items:center;justify-content:center;color:inherit;}' +
      '#p86-sheet-ribbon .p86rb-btn .g svg{display:block;}' +
      '#p86-sheet-ribbon .p86rb-btn.lg{flex-direction:column;justify-content:center;gap:5px;width:62px;height:74px;padding:6px 4px;}' +
      '#p86-sheet-ribbon .p86rb-btn.lg .g{width:28px;height:28px;}' +
      '#p86-sheet-ribbon .p86rb-btn.lg .l{font-size:10.5px;font-weight:600;white-space:nowrap;}' +
      '#p86-sheet-ribbon .p86rb-btn.sm{flex-direction:row;justify-content:flex-start;gap:7px;height:35px;min-width:94px;padding:0 9px 0 7px;}' +
      '#p86-sheet-ribbon .p86rb-btn.sm .g{width:17px;height:17px;flex:0 0 17px;}' +
      '#p86-sheet-ribbon .p86rb-btn.sm .l{font-size:11px;font-weight:600;white-space:nowrap;}';
    document.head.appendChild(st);
  }
  // Build the AutoCAD-style top ribbon (tabs → panels → tool buttons). Kept named
  // buildToolbar so the existing open() call + setTool refresh hooks are unchanged.
  function ribbonItemDef(id) {
    if (id.indexOf('edit:') === 0) {
      var k = id.slice(5);
      for (var i = 0; i < EDIT_ITEMS.length; i++) if (EDIT_ITEMS[i].key === k) return { kind: 'edit', e: EDIT_ITEMS[i] };
      return null;
    }
    var t = toolDef(id); return t ? { kind: 'tool', t: t } : null;
  }
  function buildToolbar() {
    injectToolStyle();
    var host = S.overlay.querySelector('#p86-sheet-ribbon');
    if (!host) return;
    function btn(id) {
      var sz = ribbonIsPrimary(id) ? ' lg' : ' sm';
      if (id.indexOf('snap:') === 0) {               // View › Snaps toggle button
        var sk = id.slice(5), meta = SNAP_META[sk] || { name: sk, label: sk };
        return '<button class="p86rb-btn' + sz + '" data-rb-snap="' + sk + '" title="' + esc(meta.label) + '">' +
          '<span class="g">' + (svgIcon(sk) || '•') + '</span><span class="l">' + esc(meta.name) + '</span></button>';
      }
      var d = ribbonItemDef(id); if (!d) return '';
      if (d.kind === 'tool') {
        return '<button class="p86rb-btn' + sz + '" data-sheet-tool="' + d.t.key + '" title="' + esc(d.t.label) + '">' +
          '<span class="g">' + (svgIcon(d.t.key) || d.t.glyph) + '</span><span class="l">' + esc(d.t.name) + '</span></button>';
      }
      return '<button class="p86rb-btn' + sz + '" data-sheet-act="' + d.e.act + '" data-sheet-akey="' + d.e.key + '" title="' + esc(d.e.label) + '">' +
        '<span class="g">' + (svgIcon(d.e.key) || d.e.glyph) + '</span><span class="l">' + esc(d.e.name) + '</span></button>';
    }
    var activeTab = S.ribbonTab || 'Draw';
    var tabs = RIBBON.map(function (r) {
      return '<button class="p86rb-tab' + (r.tab === activeTab ? ' on' : '') + '" data-ribbon-tab="' + esc(r.tab) + '">' + esc(r.tab) + '</button>';
    }).join('');
    var conf = null; RIBBON.forEach(function (r) { if (r.tab === activeTab) conf = r; });
    var panels = (conf ? conf.panels : []).map(function (p) {
      var lg = p.items.filter(ribbonIsPrimary), sm = p.items.filter(function (x) { return !ribbonIsPrimary(x); });
      return '<div class="p86rb-panel"><div class="p86rb-pbtns">' + lg.concat(sm).map(btn).join('') +
        '</div><div class="p86rb-ptitle">' + esc(p.title) + '</div></div>';
    }).join('');
    host.innerHTML = '<div class="p86rb-tabs">' + tabs + '</div><div class="p86rb-body">' + panels + '</div>';
    host.querySelectorAll('[data-ribbon-tab]').forEach(function (b) {
      b.onclick = function () { S.ribbonTab = b.getAttribute('data-ribbon-tab'); buildToolbar(); };
    });
    host.querySelectorAll('[data-sheet-tool]').forEach(function (b) {
      b.onclick = function () { setTool(b.getAttribute('data-sheet-tool')); };
    });
    host.querySelectorAll('[data-sheet-act]').forEach(function (b) {
      b.onclick = function () {
        var act = b.getAttribute('data-sheet-act'), k = b.getAttribute('data-sheet-akey');
        if (act === 'undo') return undo();
        if (act === 'redo') return redo();
        if (act === 'fit') {
          // Fit = the paper in sheet space, zoom-extents in model space.
          if (S.space === 'model') { sizeCanvas(false); S.view = fitModelView(); }
          else sizeCanvas(true);
          repaint(); return;
        }
        if (act === 'export') { if (k === 'png') exportPng(); else if (k === 'pdf') exportPdf(); else if (k === 'dxf') exportDxf(); return; }
        if (act === 'edit') {
          if (!S.selIds.length) return;
          if (k === 'rotate') rotate90();
          else if (k === 'rotateA') rotateBy();
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
    S.overlay.querySelectorAll('[data-rb-snap]').forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-rb-snap');
        if (k === 'ortho') S.ortho = !S.ortho;
        else if (k === 'grid') S.gridSnap = !S.gridSnap;
        else if (k === 'osnap') S.objSnap = !S.objSnap;
        refreshToolbar();
        repaint();
      };
    });
    refreshToolbar();
    updateHint();
  }
  function refreshToolbar() {
    var host = S.overlay.querySelector('#p86-sheet-ribbon');
    if (host) {
      host.querySelectorAll('[data-sheet-tool]').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-sheet-tool') === S.tool);
      });
      host.querySelectorAll('[data-rb-snap]').forEach(function (b) {
        var k = b.getAttribute('data-rb-snap');
        b.classList.toggle('on', (k === 'ortho' && S.ortho) || (k === 'grid' && S.gridSnap) || (k === 'osnap' && S.objSnap));
      });
    }
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
    // MODEL / PAPER chip — AutoCAD's space button. Click toggles (wired in open()).
    var sc = S.overlay.querySelector('#p86-sb-space');
    if (sc) {
      var isModel = S.space === 'model';
      sc.textContent = isModel ? 'MODEL' : 'PAPER';
      sc.style.color = isModel ? '#93c5fd' : '#9aa';
      sc.style.background = isModel ? 'rgba(79,140,255,0.22)' : 'rgba(255,255,255,0.05)';
      sc.style.borderColor = isModel ? '#4f8cff' : '#3a3a4a';
    }
  }
  function setTool(t) {
    if (S.draft) S.draft = null;             // cancel any in-progress draft
    S._filletA = null; S._chamferA = null; S._stretch = null; S._dimcont = null;   // cancel pending fillet/chamfer/stretch/cont-dim
    S.inq = null;                            // clear any measure/inquiry path
    S._calib = null;                         // cancel any in-progress calibration
    S._poly = null;                          // cancel any in-progress polygon
    S._mir = null; S._zw = null;             // cancel pending mirror-line / zoom-window first points
    hideDyn();
    S.tool = t;
    // Track last/recent drawing commands for Enter-repeat + the right-click menu.
    if (t && t !== 'select' && t !== 'pan' && t !== 'calibrate') {
      S._lastTool = t;
      S._recentTools = (S._recentTools || []).filter(function (x) { return x !== t; });
      S._recentTools.unshift(t); S._recentTools = S._recentTools.slice(0, 5);
    }
    S.canvas.style.cursor = baseCursor();
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
    // The REAL multi-viewport capability: a new view windows the SAME model
    // region as the primary viewport (at its own scale) — plan + detail views
    // of one drawing, true CAD semantics.
    var primary = S.doc.viewports[0];
    var vp = {
      id: uid('VP'), label: VIEW_LABELS[Math.min(n, VIEW_LABELS.length - 1)],
      x: 0, y: 0, w: 100, h: 100,
      scale: { pixelsPerInch: DPI * pre.f, unit: 'ft', label: pre.label }
    };
    var pw = primary ? vpWin(primary) : { cx: 0, cy: 0 };
    vp.window = { cx: pw.cx, cy: pw.cy };
    S.doc.viewports.push(vp);
    layoutViewports(S.doc);
    buildLayers(); repaint();
    setHint('New view added — it windows the same model as ' + (primary ? (primary.label || 'the plan') : 'the drawing') + '. Double-click inside it to pan/zoom its window.');
  }
  function setViewportScale(vpId, preset) {
    var vp = (S.doc.viewports || []).filter(function (v) { return v.id === vpId; })[0];
    if (!vp) return;
    pushUndo();
    vpWin(vp);                                          // keep the window center — this zooms about it
    vp.scale = { pixelsPerInch: DPI * preset.f, unit: preset.unit || 'ft', label: preset.label, calibrated: vp.scale && vp.scale.calibrated };
    markDirty(); buildLayers(); repaint();
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
    box.style.cssText = 'background:#141419;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:520px;width:100%;max-height:88vh;overflow-y:auto;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
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
      ['M', 'Measure'], ['Z', 'Zoom window'], ['W', 'Wipeout'],
      ['Edit & view', ''],
      ['Ctrl+Z', 'Undo'], ['Ctrl+Y / Ctrl+Shift+Z', 'Redo'], ['Ctrl+D', 'Duplicate selection'],
      ['Del / Backspace', 'Delete selection'], ['Enter', 'Finish polyline / hatch'], ['Esc', 'Cancel current action'],
      ['Shift (hold)', 'Polar / ortho lock'], ['Space (hold) / middle-drag', 'Pan'], ['Mouse wheel', 'Zoom'],
      ['Drawing', ''],
      ['type a number', 'Exact length while drawing'], [', (comma) or Tab', 'Jump to the angle field'], ['?', 'This cheat-sheet']
    ];
    var box = document.createElement('div');
    box.style.cssText = 'background:#141419;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:440px;width:100%;max-height:88vh;overflow-y:auto;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
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
    box.style.cssText = 'background:#141419;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:400px;width:100%;max-height:88vh;overflow-y:auto;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
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
      cb('crosshair', 'CAD crosshair cursor (full-screen crosshair + pickbox)', SETTINGS.crosshair !== false) +
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
      S.canvas.style.cursor = baseCursor();
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
      var lk = vpScaleLocked(vp);
      var lkTitle = lk
        ? ('Scale locked' + (vp.scale && vp.scale.calibrated ? ' (calibrated)' : '') + ' — wheel zoom can’t change it. Click to unlock.')
        : 'Scale unlocked — click to lock it against accidental wheel rescale.';
      return '<div style="border:1px solid #333;border-radius:6px;padding:5px 6px;margin-bottom:5px;">' +
        '<div style="display:flex;align-items:center;gap:4px;">' +
          '<span data-vp-name="' + esc(vp.id) + '" title="Double-click to rename" style="flex:1;color:#cbd5e1;font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(vp.label) + '</span>' +
          '<button data-vp-lock="' + esc(vp.id) + '" title="' + esc(lkTitle) + '" style="background:transparent;border:0;cursor:pointer;font-size:11px;width:16px;color:' + (lk ? '#fbbf24' : '#64748b') + ';">' + (lk ? '🔒' : '🔓') + '</button>' +
          ((S.doc.viewports.length > 1) ? '<button data-vp-del="' + esc(vp.id) + '" title="Delete view" style="background:transparent;border:0;color:#f87171;cursor:pointer;font-size:11px;width:14px;">✕</button>' : '') +
        '</div>' +
        '<select data-vp-scale="' + esc(vp.id) + '"' + (lk ? ' disabled title="Scale locked — unlock (🔒) to change it"' : '') + ' style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#9aa;border:1px solid #444;border-radius:5px;padding:3px 5px;font-size:10.5px;margin-top:3px;' + (lk ? 'opacity:0.55;' : '') + '">' +
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
      if (e.tool !== 'measure') { e.color = l.color; e.lineWidth = l.weight || e.lineWidth; e.lineType = l.lineType || 'solid'; }
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
      pushUndo(); var rad = ang * Math.PI / 180;   // model inches
      e.endX = e.startX + lenIn * Math.cos(rad); e.endY = e.startY - lenIn * Math.sin(rad);
      repaint(); buildLayers();
    }
    if (pLen) pLen.onchange = applyLine;
    if (pAng) pAng.onchange = applyLine;
    var pW = host.querySelector('[data-prop-w]'), pH = host.querySelector('[data-prop-h]');
    function applyRect() {
      var e = selectedEntity(); if (!e) return;
      var w = parseLenIn(pW.value), h = parseLenIn(pH.value); if (w == null || h == null) return;
      pushUndo();   // model inches
      var sx = Math.min(e.startX, e.endX), sy = Math.min(e.startY, e.endY);
      e.startX = sx; e.startY = sy; e.endX = sx + Math.max(0.1, w); e.endY = sy + Math.max(0.1, h);
      repaint(); buildLayers();
    }
    if (pW) pW.onchange = applyRect;
    if (pH) pH.onchange = applyRect;
    var pR = host.querySelector('[data-prop-r]');
    if (pR) pR.onchange = function () {
      var e = selectedEntity(); if (!e) return; var r = parseLenIn(pR.value); if (r == null) return;
      pushUndo(); var rpx = Math.max(0.1, r);   // model inches
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
        if (dat && Math.abs(dat.y - e.startY) > 0.001) { var yy = dat.y - (inches - dat.elevIn); e.startY = yy; e.endY = yy; }
      } else if (e.tool === 'spotelev') {
        var dat2 = datumForViewport(e.viewport);
        if (dat2) e.y = dat2.y - (inches - dat2.elevIn);
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
    host.querySelectorAll('[data-vp-lock]').forEach(function (b) {
      b.onclick = function () {
        var vp = S.doc.viewports.filter(function (v) { return v.id === b.getAttribute('data-vp-lock'); })[0];
        if (!vp) return;
        // Explicit toggle overrides the calibrated-default in both directions.
        // Deliberately NOT undoable (no pushUndo, lockScale excluded from
        // snapshots): Ctrl+Z must never silently re-unlock a calibrated
        // scale guard as a side effect of undoing geometry.
        vp.lockScale = !vpScaleLocked(vp);
        markDirty(); buildLayers(); refreshStatusBar();
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
  // Three spaces: SCREEN (canvas css px) ⇄ PLANE (what the camera pans/zooms:
  // paper in sheet space, virtual paper in model space) ⇄ MODEL (inches — the
  // space every entity and every tool lives in).
  function toSheet(sx, sy) { return { x: (sx - S.view.tx) / S.view.scale, y: (sy - S.view.ty) / S.view.scale }; }
  function toScreen(x, y) {
    var p = mToPlane({ x: x, y: y });
    return { x: p.x * S.view.scale + S.view.tx, y: p.y * S.view.scale + S.view.ty };
  }
  // Pointer context: plane point, the viewport under it (sheet space), and
  // the MODEL point every tool consumes. With `latch` the ACTIVE viewport's
  // mapping is used regardless of which frame the cursor is over — a drag or
  // an in-progress tool must keep ONE screen→model mapping for its whole
  // gesture, or crossing a viewport edge teleports geometry between the
  // disjoint model regions.
  function pointerCtx(lp, latch) {
    var plane = toSheet(lp.x, lp.y);
    if (S.space === 'model') return { plane: plane, vp: (S.doc.viewports || [])[0] || null, m: vToM(plane) };
    var vp = latch ? activeVp() : vpAt(plane);
    return { plane: plane, vp: vp, m: pToM(plane, vp || activeVp()) };
  }
  // Any multi-click tool state that must keep its screen→model mapping.
  function toolInProgress() {
    return !!(S.draft || S._stretch || S._dimcont || S._calib || S._poly || S._filletA || S._chamferA || S.inq || S._mir || S._zw);
  }
  // Convert a screen-px tolerance (snap radius, hit slop) into model inches.
  function screenModelDist(px, vp) {
    var ppi = (S.space === 'model') ? mppi() : vpPpiSafe(vp || activeVp());
    return px / (S.view.scale * ppi);
  }
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
  // Scale lock: an explicit vp.lockScale wins; otherwise a CALIBRATED
  // viewport defaults to locked — one wheel nudge must never silently
  // rewrite a scale the takeoff numbers depend on.
  function vpScaleLocked(vp) {
    if (!vp) return false;
    if (vp.lockScale != null) return !!vp.lockScale;
    return !!(vp.scale && vp.scale.calibrated);
  }

  // ── Snapping ────────────────────────────────────────────────────
  // Collect endpoint / midpoint / center candidates from entities (MODEL
  // coords — v3 is one model, so candidates are tag-free; distance culling
  // against the cursor keeps this cheap).
  function snapCandidates(vp, raw) {
    var out = [];
    (S.doc.entities || []).forEach(function (e) {
      if (!e) return;
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
      } else if (e.tool === 'arc' && e.points && e.points.length >= 3) {
        // Arcs are points-based, so the generic branch below would emit
        // CHORD midpoints (off the curve) and no center at all. Emit the
        // real endpoints, the circumcenter, and the true on-arc midpoint.
        out.push({ x: e.points[0].x, y: e.points[0].y, kind: 'end' });
        out.push({ x: e.points[2].x, y: e.points[2].y, kind: 'end' });
        out.push({ x: e.points[1].x, y: e.points[1].y, kind: 'node' });   // the through-point IS on the arc — keep it acquirable
        var ac = arcCenter(e.points);
        if (ac) {
          out.push({ x: ac.x, y: ac.y, kind: 'center' });
          var am = arcSamples(e.points, 2);            // n=2 → index 1 = true arc midpoint
          if (am.length >= 2) out.push({ x: am[1].x, y: am[1].y, kind: 'mid' });
        } else {
          // Collinear (degenerate arc renders as a line) — chord mid is correct.
          out.push({ x: (e.points[0].x + e.points[2].x) / 2, y: (e.points[0].y + e.points[2].y) / 2, kind: 'mid' });
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
      var R = screenModelDist(SNAP_SCREEN, vp) * 1.5;
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
  // Flatten drawable line segments (model coords, tag-free) for intersection
  // snaps + trim/extend boundaries.
  function segmentsInVp(vp, excludeId) {
    var segs = [];
    (S.doc.entities || []).forEach(function (e) {
      if (!e) return;
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
    var radiusSheet = screenModelDist(SNAP_SCREEN, vp);   // snap radius in model inches
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
    if (S.gridSnap) {
      // Model lattice anchored at the model origin — the drawn grids (sheet
      // and model view) sit on this same lattice by construction.
      var step = gridStepIn(vp);
      var gx = Math.round(raw.x / step) * step;
      var gy = Math.round(raw.y / step) * step;
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
      // v3: sheetPt IS model inches. Read out Y-up from the reference
      // window's bottom-left (the hovered viewport in sheet space, the
      // primary viewport in model space) so coordinates are positive,
      // CAD-first-quadrant numbers.
      var ovp = (S.space === 'model') ? ((S.doc.viewports || [])[0] || vp) : vp;
      if (!ovp) { coords.textContent = 'x ' + fmtFeet(sheetPt.x) + '   y ' + fmtFeet(-sheetPt.y); }
      else {
        var oppi = vpPpiSafe(ovp), ow = vpWin(ovp);
        var rx = sheetPt.x - (ow.cx - (ovp.w / 2) / oppi);
        var ry = (ow.cy + (ovp.h / 2) / oppi) - sheetPt.y;
        var txt = 'x ' + fmtFeet(rx) + '   y ' + fmtFeet(ry);
        if (S.draft && S.draft._anchor) {
          var a = S.draft._anchor;
          var len = Math.hypot(sheetPt.x - a.x, sheetPt.y - a.y);
          var deg = Math.round(Math.atan2(-(sheetPt.y - a.y), sheetPt.x - a.x) * 180 / Math.PI);
          txt += '    Δ ' + fmtFeet(len) + ' @ ' + deg + '°';
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
      // Pan: middle button, space-pan, or pan tool. With a viewport ACTIVATED
      // (MSPACE-style) the pan drives that viewport's WINDOW — the model slides
      // inside the frame — instead of the paper camera.
      if (e.button === 1 || S.spaceDown || S.tool === 'pan') {
        // Resolve the ACTIVATED viewport by its own id — S.activeVpId follows
        // the hover and must not decide MSPACE behavior.
        var avp = (S.space === 'sheet' && S.vpActive) ? vpById(S.vpActive) : null;
        if (avp) {
          var w0 = vpWin(avp);
          S.panning = { mode: 'window', vp: avp, sx: lp.x, sy: lp.y, cx0: w0.cx, cy0: w0.cy };
        } else {
          S.panning = { sx: lp.x, sy: lp.y, tx: S.view.tx, ty: S.view.ty };
        }
        c.style.cursor = 'grabbing';
        return;
      }
      var pc = pointerCtx(lp, toolInProgress());
      var raw = pc.m, vp = pc.vp;
      if (vp && !toolInProgress()) S.activeVpId = vp.id;
      var pt = resolveSnap(raw, vp);
      if (S.draft && S.draft._anchor) pt = applyOrtho(S.draft._anchor, pt);

      if (S.tool === 'select') {
        // Grip-drag: if the cursor is on a grip of the (single) selection,
        // reshape that point (or move the whole entity for a 'move' grip).
        var grip = gripAtScreen(lp);
        if (grip) { S.gripDrag = { gi: grip.gi, type: grip.type, last: raw, pushed: false }; return; }
        var hit = hitTest(raw);
        if (hit && e.shiftKey) { selectAt(raw, true); return; }     // toggle in/out of set
        if (hit && e.altKey) {
          // Alt-click cycles through the overlapping stack under the cursor.
          var cyc = selectAt(raw, false, true);
          if (cyc) S.moveDrag = { last: raw, pushed: false, hit: cyc, group: false };
          return;
        }
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
      S._offCanvas = false;
      if (S.panning) {
        if (S.panning.mode === 'window') {
          // Slide the activated viewport's window (model inches).
          var pvp2 = S.panning.vp, pppi = vpPpiSafe(pvp2), pw = vpWin(pvp2);
          pw.cx = S.panning.cx0 - (lp.x - S.panning.sx) / (S.view.scale * pppi);
          pw.cy = S.panning.cy0 - (lp.y - S.panning.sy) / (S.view.scale * pppi);
          markDirty();
        } else {
          S.view.tx = S.panning.tx + (lp.x - S.panning.sx);
          S.view.ty = S.panning.ty + (lp.y - S.panning.sy);
        }
        repaint();
        return;
      }
      // Grip-drag the selected entity's handle (select tool, button held).
      if (S.gripDrag && (e.buttons & 1)) {
        var gent = selectedEntity();
        if (gent) {
          if (!S.gripDrag.pushed) { pushUndo(); S.gripDrag.pushed = true; }
          var gpc = pointerCtx(lp, true);   // latched: one mapping per gesture
          var graw = gpc.m, gvp = gpc.vp;
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
          var ds = pointerCtx(lp, true).m;   // latched: one mapping per gesture
          var ddx = ds.x - S.moveDrag.last.x, ddy = ds.y - S.moveDrag.last.y;
          ents.forEach(function (en) { translateEntity(en, ddx, ddy); });
          S.moveDrag.last = ds;
          S.hover = ds;                       // keep the drawn crosshair on the pointer
          repaint();
        }
        return;
      }
      // Rubber-band box selection in progress.
      if (S.boxSel && (e.buttons & 1)) {
        S.boxSel.last = pointerCtx(lp, true).m;   // latched: one mapping per gesture
        S.hover = S.boxSel.last;              // keep the drawn crosshair on the pointer
        repaint();
        return;
      }
      var mpc = pointerCtx(lp, toolInProgress());
      var raw = mpc.m, vp = mpc.vp;
      // Hover-follow: the active mapping tracks the viewport under the cursor
      // (crosshair/snap/preview overlays map through activeVp), EXCEPT while a
      // tool is mid-gesture — then the mapping stays latched.
      if (vp && S.space === 'sheet' && !toolInProgress()) S.activeVpId = vp.id;
      var pt = resolveSnap(raw, vp);
      if (S.draft && S.draft._anchor) pt = applyOrtho(S.draft._anchor, pt);
      S.hover = pt; S.snap = pt; S.hoverVp = vp;
      // Grip hover affordance in the select tool.
      if (S.tool === 'select' && S.selectedId) {
        S.canvas.style.cursor = gripAtScreen(lp) ? 'pointer' : baseCursor();
      }
      updateReadout(pt, vp);
      if (dynApplies()) updateDynLive();
      repaint();
    };
    c.onmouseleave = function () {
      // Hide the drawn crosshair while the pointer is off-canvas — but KEEP
      // S.hover: dynamic input derives the typed-length direction from it,
      // and the pointer legitimately leaves the canvas to reach the dyn box.
      S._offCanvas = true;
      repaint();
    };
    c.onmouseup = function () {
      if (S.panning) { S.panning = null; S.canvas.style.cursor = baseCursor(); }
      // A plain click on one member of a multi-selection (no drag) collapses to it.
      if (S.moveDrag && !S.moveDrag.pushed && S.moveDrag.group && S.moveDrag.hit) { setSelection([S.moveDrag.hit]); buildLayers(); repaint(); }
      // Finalize a rubber-band selection.
      if (S.boxSel) {
        var b = S.boxSel; S.boxSel = null;
        var x0 = Math.min(b.start.x, b.last.x), x1 = Math.max(b.start.x, b.last.x);
        var y0 = Math.min(b.start.y, b.last.y), y1 = Math.max(b.start.y, b.last.y);
        var click = ((x1 - x0) < screenModelDist(4) && (y1 - y0) < screenModelDist(4));
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
    c.ondblclick = function (e) {
      if ((S.tool === 'polyline' || S.tool === 'hatch' || S.tool === 'spline' || S.tool === 'wipeout') && S.draft) { commitPolyline(); return; }
      // AutoCAD MSPACE: double-click inside a viewport activates it — pan/zoom
      // then move the model within the frame. Double-click outside deactivates.
      if (S.space !== 'sheet') return;
      var plane = toSheet(localPt(e).x, localPt(e).y);
      var hit = null;
      (S.doc.viewports || []).forEach(function (v) {
        if (plane.x >= v.x && plane.x <= v.x + v.w && plane.y >= v.y && plane.y <= v.y + v.h) hit = v;
      });
      if (hit && S.vpActive !== hit.id) {
        S.vpActive = hit.id; S.activeVpId = hit.id;
        setHint('Viewport "' + (hit.label || hit.id) + '" activated — wheel zooms and Space-drag pans the MODEL inside the frame. Double-click outside (or Esc) to release.');
      } else {
        S.vpActive = null;
        setHint('Viewport released — pan/zoom move the paper again.');
      }
      repaint();
    };
    c.oncontextmenu = function (e) { e.preventDefault(); showContextMenu(e); };
    c.onwheel = function (e) {
      e.preventDefault();
      var lp = localPt(e);
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      // Activated viewport → wheel zooms the MODEL inside the frame (changes
      // the viewport's real scale), anchored on the model point under the
      // cursor. Otherwise the paper/model camera zooms as before.
      var avp = (S.space === 'sheet' && S.vpActive) ? vpById(S.vpActive) : null;
      if (avp) {
        var plane = toSheet(lp.x, lp.y);
        if (plane.x >= avp.x && plane.x <= avp.x + avp.w && plane.y >= avp.y && plane.y <= avp.y + avp.h) {
          // Calibrated/locked viewport: wheel must NOT rewrite the scale —
          // that silently corrupts every measurement on the view. Don't go
          // dead either: fall through so the wheel zooms the PAPER camera
          // instead (hint throttled so it doesn't re-fire every tick).
          if (vpScaleLocked(avp)) {
            var _lhNow = Date.now();
            if (!S._lockHintT || _lhNow - S._lockHintT > 1500) {
              S._lockHintT = _lhNow;
              setHint('Viewport scale is locked' + (avp.scale && avp.scale.calibrated ? ' (calibrated)' : '') + ' — wheel zooms the paper; click its 🔒 in Views to unlock.');
            }
          } else {
            var m = pToM(plane, avp);
            var ppi0 = vpPpiSafe(avp);
            var ppi1 = Math.max(0.05, Math.min(600, ppi0 * factor));
            if (!avp.scale) avp.scale = { unit: 'ft' };
            avp.scale.pixelsPerInch = ppi1;
            avp.scale.label = vpScaleLabel(ppi1);
            var w2 = vpWin(avp);
            w2.cx = m.x - (plane.x - avp.x - avp.w / 2) / ppi1;
            w2.cy = m.y - (plane.y - avp.y - avp.h / 2) / ppi1;
            markDirty(); buildLayers(); refreshStatusBar(); repaint();
            return;
          }
        }
      }
      var before = toSheet(lp.x, lp.y);
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
        S._filletA = null; S._chamferA = null; S._stretch = null; S._dimcont = null; S.inq = null; S.draft = null; S.boxSel = null; S._calib = null; S._poly = null; S._mir = null; S._zw = null; hideDyn();
        S.vpActive = null;                    // release any activated viewport
        setSelection([]);
        if (S.tool !== 'select') setTool('select'); else { buildLayers(); repaint(); }
      }
      else if (e.key === 'Enter') {
        if ((S.tool === 'polyline' || S.tool === 'hatch' || S.tool === 'spline' || S.tool === 'wipeout') && S.draft) commitPolyline();
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
      else if (e.key === ' ') { S.spaceDown = false; S.canvas.style.cursor = baseCursor(); }
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
    S._filletA = null; S._chamferA = null; S._stretch = null; S._dimcont = null; S.inq = null; S.draft = null; S.boxSel = null; S._calib = null; S._poly = null; S._mir = null; S._zw = null; hideDyn();
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
    menu.style.cssText = 'position:fixed;z-index:5300;background:#141419;border:1px solid #353545;border-radius:8px;padding:4px;min-width:172px;box-shadow:0 12px 34px rgba(0,0,0,0.6);font-size:12px;color:#e6e6e6;user-select:none;';
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
      items.push({ label: '∠ Rotate…', act: rotateBy });
      items.push({ label: '⌫ Delete', act: deleteSelected });
    }
    if (S.selIds && S.selIds.length === 1) {
      // Select-similar: same tool (+ same symbol kind) on the same layer —
      // one click turns a symbol into a takeoff count.
      var simE = selectedEntity();
      if (simE) items.push({ label: '⧈ Select similar', act: function () {
        var t0 = simE.tool, k0 = simE.kind || null, l0 = simE.layer;
        // Scope to geometry visible through THIS sheet's viewports — a
        // model-wide grab would let a follow-up delete/rotate hit invisible
        // geometry on other sheets. Model space stays model-wide.
        var inView = function (x) {
          if (S.space === 'model') return true;
          var bb = entBBox(x); if (!bb) return false;
          var vps = S.doc.viewports || [];
          for (var vi = 0; vi < vps.length; vi++) {
            var vv = vps[vi], vppi = vpPpiSafe(vv), vw = vpWin(vv);
            var hw = (vv.w / 2) / vppi, hh = (vv.h / 2) / vppi;
            if (bb.x <= vw.cx + hw && bb.x + bb.w >= vw.cx - hw && bb.y <= vw.cy + hh && bb.y + bb.h >= vw.cy - hh) return true;
          }
          return false;
        };
        var ids = S.doc.entities.filter(function (x) {
          if (!x || x.tool !== t0 || x.layer !== l0) return false;
          if (t0 === 'symbol' && (x.kind || null) !== k0) return false;
          var xl = layerById(S.doc, x.layer);
          if (xl && (xl.visible === false || xl.locked)) return false;
          return inView(x);
        }).map(function (x) { return x.id; });
        setSelection(ids); buildLayers(); repaint();
        setHint('Selected ' + ids.length + ' similar object' + (ids.length === 1 ? '' : 's') + (t0 === 'symbol' && k0 ? ' (' + k0 + ')' : '') + '.');
      } });
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
    // Re-clamp against the REAL menu height (items vary with selection state
    // — the pre-paint estimate can leave the bottom items off-screen).
    var mh = menu.offsetHeight;
    menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - mh - 4)) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', ctxOutside, true); }, 0);
  }

  function newEntity(tool, vp) {
    var l = layerById(S.doc, S.activeLayer);
    return { id: uid(tool), tool: tool, viewport: vp ? vp.id : (S.doc.viewports[0] || {}).id,
      layer: S.activeLayer, color: l.color, lineWidth: l.weight || 3,
      lineType: l.lineType || 'solid' };   // dormant-fix: the Hidden layer's dashes never reached drawn geometry
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
    if (t === 'mirror2') { mirror2Click(pt); return; }
    if (t === 'zoomwin') { zoomWinClick(pt, vp); return; }
    // Measure / inquiry — accumulate points; readout drawn in repaint. Never
    // becomes a printed entity. Enter/Esc clears.
    if (t === 'inquire') {
      // Object pick: clicking ON a drawn shape reads its size / perimeter /
      // area directly — no corner re-clicking. Empty space (or a chain in
      // progress) falls through to the classic point-chain readout.
      // CRITICAL gate: when the click resolved to a precise OSNAP point
      // (endpoint/mid/center/…), the user is starting a chain FROM that
      // point — "measure corner A to corner B" must still work. Only an
      // un-snapped click on an entity body triggers the object readout.
      var ptSnap = { end: 1, mid: 1, intersect: 1, quad: 1, node: 1, center: 1 };
      if ((!S.inq || !S.inq.pts.length) && !ptSnap[pt.kind]) {
        var oid = hitTest(pt);
        var oe = oid && S.doc.entities.filter(function (x) { return x.id === oid; })[0];
        var info = oe && objectInquiry(oe);
        if (info) { setHint(info); repaint(); return; }
      }
      if (!S.inq) S.inq = { pts: [], vp: vp || activeVp() };
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
      var vpL = vp || activeVp();
      var lv = newEntity('level', vpL);
      // Span the viewport's model window (with a 6" margin each side).
      var lppi = vpPpiSafe(vpL), lwn = vpWin(vpL);
      lv.startX = lwn.cx - (vpL.w / 2) / lppi + 6; lv.endX = lwn.cx + (vpL.w / 2) / lppi - 6;
      promptText('Elevation (e.g. 10\', 0, 8\' 6")', function (txt) {
        if (txt == null) return;
        var p = prims().parseMeasurement ? prims().parseMeasurement(txt, 'ft') : null;
        lv.elevIn = p ? p.inches : ((parseFloat(txt) || 0) * 12);
        var dat = datumForViewport(vpL.id), yy = pt.y;
        if (dat) { yy = dat.y - (lv.elevIn - dat.elevIn); }   // model inches
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
    // Wipeout — click a region like a hatch; commits an opaque paper mask.
    if (t === 'wipeout') {
      if (!S.draft) {
        var we = newEntity('wipeout', vp);
        we.points = [{ x: pt.x, y: pt.y }]; we._anchor = { x: pt.x, y: pt.y };
        S.draft = we;
        setHint('Wipeout: click the region corners — double-click / Enter to close.');
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
      if (se.kind === 'revdelta') {
        // Drafting practice: every delta placed while the sheet is at rev N
        // reads "N" (deltas mark WHAT changed in the current revision, they
        // are not a running counter). '1' before any revision is logged.
        var tbRevs = (S.doc.titleblock && S.doc.titleblock.revisions && S.doc.titleblock.revisions.length) || 0;
        se.label = String(Math.max(1, tbRevs));
      }
      commitEntity(se); repaint(); return;
    }
    if (t === 'polygon') {
      // Regular N-gon: click center, click a vertex, then type the side count.
      if (!S._poly) { S._poly = { cx: pt.x, cy: pt.y, vp: vp }; setHint('Polygon: click a vertex to set size + orientation.'); repaint(); return; }
      var pc = S._poly; S._poly = null;
      var R = Math.hypot(pt.x - pc.cx, pt.y - pc.cy);
      if (R < screenModelDist(2)) { repaint(); return; }
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
    // Degenerate-shape guard: a double-click, not a real drag — measured in
    // SCREEN px so fine scales (1:1, 4:1) can still commit sub-inch geometry.
    var dgen = screenModelDist(2);
    if (Math.abs(d.endX - d.startX) < dgen && Math.abs(d.endY - d.startY) < dgen) { S.draft = null; hideDyn(); return; }
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
    // A wipeout is a REGION — fewer than 3 points is a degenerate sliver
    // that would fill nothing; silently discard it.
    if (d && d.tool === 'wipeout' && (!d.points || d.points.length < 3)) { S.draft = null; hideDyn(); repaint(); return; }
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
    var a = S.draft._anchor;
    var h = S.hover ? applyOrtho(a, S.hover) : a;
    var li = d.querySelector('[data-dyn-len]'), ai = d.querySelector('[data-dyn-ang]');
    if (li) li.placeholder = fmtFeet(Math.hypot(h.x - a.x, h.y - a.y));   // model units are inches
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
    // Direction: typed angle wins; else current (ortho-aware) cursor heading.
    var target = S.hover ? applyOrtho(a, S.hover) : { x: a.x + 1, y: a.y };
    var dirDeg = Math.atan2(-(target.y - a.y), target.x - a.x) * 180 / Math.PI;
    if (angStr !== '' && isFinite(parseFloat(angStr))) dirDeg = parseFloat(angStr);
    // Length in model inches: typed (parsed) wins; else live cursor distance.
    var lenIn;
    if (lenStr !== '') {
      var p = prims().parseMeasurement ? prims().parseMeasurement(lenStr, 'ft') : null;
      lenIn = p ? p.inches : (isFinite(parseFloat(lenStr)) ? parseFloat(lenStr) * 12 : null);
      if (lenIn == null) return;   // unparseable — leave the draft open
    } else {
      lenIn = Math.hypot(target.x - a.x, target.y - a.y);
    }
    var rad = dirDeg * Math.PI / 180;
    var ex = a.x + lenIn * Math.cos(rad), ey = a.y - lenIn * Math.sin(rad);
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
    box.style.cssText = 'background:#141419;border:1px solid #353545;border-radius:12px;padding:18px 20px;max-width:380px;width:100%;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
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
  // Multi-line variant — paragraph note blocks. Enter = newline; Ctrl+Enter
  // or OK commits; Esc cancels (cb(null), same contract as promptText).
  function promptTextArea(title, cb, initial) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:5400;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#141419;border:1px solid #353545;border-radius:12px;padding:18px 20px;max-width:440px;width:100%;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
    box.innerHTML = '<div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:10px;">' + esc(title) + '</div>' +
      '<textarea data-pt-input rows="4" style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:6px;padding:8px 10px;font-size:13px;outline:none;resize:vertical;font-family:inherit;">' + esc(initial || '') + '</textarea>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:12px;">' +
        '<span style="flex:1;font-size:10.5px;color:#64748b;">Enter = OK · Shift+Enter = new line</span>' +
        '<button data-pt-cancel style="padding:8px 16px;background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>' +
        '<button data-pt-ok style="padding:8px 16px;background:#4f8cff;color:#fff;border:1px solid #4f8cff;border-radius:6px;cursor:pointer;font-weight:700;">OK</button>' +
      '</div>';
    ov.appendChild(box); document.body.appendChild(ov);
    var input = box.querySelector('[data-pt-input]');
    function done(val) { if (ov.parentNode) ov.parentNode.removeChild(ov); cb(val); }
    box.querySelector('[data-pt-cancel]').onclick = function () { done(null); };
    box.querySelector('[data-pt-ok]').onclick = function () { done(input.value); };
    input.onkeydown = function (e) {
      // Muscle-memory: plain Enter commits while the note is single-line
      // (matching the old prompt); Shift+Enter always inserts a newline,
      // and once a newline exists plain Enter keeps adding lines.
      if (e.key === 'Enter' && !e.shiftKey && (e.ctrlKey || e.metaKey || input.value.indexOf('\n') === -1)) { e.preventDefault(); done(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
    ov.addEventListener('click', function (e) { if (e.target === ov) done(null); });
  }
  function finalizeLeader(pt, vp) {
    var d = S.draft;
    d.endX = pt.x; d.endY = pt.y;
    var lgen = screenModelDist(2);
    if (Math.abs(d.endX - d.startX) < lgen && Math.abs(d.endY - d.startY) < lgen) { S.draft = null; return; }
    delete d._anchor;
    pushUndo();
    S.doc.entities.push(d);          // the arrow
    S.draft = null;
    var ex = pt.x, ey = pt.y, ppi = vpPpiSafe(vp || activeVp());
    promptText('Leader text', function (txt) {
      if (txt) {
        var te = newEntity('text', vp);
        // Offsets in model inches; fontPx stays a PAPER size (annotative).
        te.x = ex + 2; te.y = ey - 9;
        te.text = txt; te.fontPx = Math.round(ppi * 9);
        S.doc.entities.push(te); repaint();
      }
    });
    repaint();
  }
  function placeText(pt, vp) {
    promptTextArea('Text — multi-line notes supported', function (txt) {
      if (!txt || !txt.trim()) return;
      var e = newEntity('text', vp);
      e.x = pt.x; e.y = pt.y; e.text = txt.replace(/\s+$/, ''); e.fontPx = Math.round((vp && vp.scale ? vp.scale.pixelsPerInch : 2.5) * 9);
      commitEntity(e); repaint();
    });
  }
  // Flatten ONE entity into line segments for precise hit-testing (same
  // shape cases as segmentsInVp, but per-entity — the doc-wide version
  // can't say which segment belongs to whom).
  function entSegments(e) {
    var segs = [];
    if (!e) return segs;
    if ((e.tool === 'line' || e.tool === 'refline' || e.tool === 'level' || e.tool === 'measure' || e.tool === 'arrow') && e.startX != null) {
      segs.push({ a: { x: e.startX, y: e.startY }, b: { x: e.endX, y: e.endY } });   // 'arrow' = a leader's committed entity — a two-point segment like the rest
    } else if (e.tool === 'rect' && e.startX != null) {
      var c = [{ x: e.startX, y: e.startY }, { x: e.endX, y: e.startY }, { x: e.endX, y: e.endY }, { x: e.startX, y: e.endY }];
      for (var k = 0; k < 4; k++) segs.push({ a: c[k], b: c[(k + 1) % 4] });
    } else if ((e.tool === 'polyline' || e.tool === 'mangle' || e.tool === 'hatch' || e.tool === 'wipeout') && e.points && e.points.length > 1) {
      for (var p = 1; p < e.points.length; p++) segs.push({ a: e.points[p - 1], b: e.points[p] });
      if ((e.tool === 'hatch' || e.tool === 'wipeout') && e.points.length > 2) segs.push({ a: e.points[e.points.length - 1], b: e.points[0] });
      // Angle dims: the drawn vertex arc + its label sit off the two legs —
      // sample the (annotative-radius) arc so clicking it selects the dim.
      if (e.tool === 'mangle' && e.points.length >= 3) {
        var mv = e.points[1];
        var mr = Math.max(16, (e.lineWidth || 4) * 5) / ppiOf(e);
        var ma1 = Math.atan2(e.points[0].y - mv.y, e.points[0].x - mv.x);
        var ma2 = Math.atan2(e.points[2].y - mv.y, e.points[2].x - mv.x);
        if (ma2 < ma1) ma2 += 2 * Math.PI;
        var mprev = null;
        for (var mi = 0; mi <= 8; mi++) {
          var mth = ma1 + (ma2 - ma1) * (mi / 8);
          var mp = { x: mv.x + mr * Math.cos(mth), y: mv.y + mr * Math.sin(mth) };
          if (mprev) segs.push({ a: mprev, b: mp });
          mprev = mp;
        }
      }
    } else if (e.tool === 'arc' && e.points && e.points.length >= 3) {
      var sa = arcSamples(e.points, 40);
      for (var q = 1; q < sa.length; q++) segs.push({ a: sa[q - 1], b: sa[q] });
    } else if (e.tool === 'ellipse' && e.startX != null) {
      var ex0 = (e.startX + e.endX) / 2, ey0 = (e.startY + e.endY) / 2, rxe = Math.abs(e.endX - e.startX) / 2, rye = Math.abs(e.endY - e.startY) / 2, prev = null;
      for (var ai = 0; ai <= 40; ai++) { var th = ai / 40 * 2 * Math.PI, pt = { x: ex0 + rxe * Math.cos(th), y: ey0 + rye * Math.sin(th) }; if (prev) segs.push({ a: prev, b: pt }); prev = pt; }
    }
    return segs;
  }
  // Point inside a closed polygon (ray cast) — filled hatches select from
  // anywhere inside, not just their edges.
  function pointInPoly(pt, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if ((yi > pt.y) !== (yj > pt.y) && pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // Topmost selectable entity id under a sheet point (or null).
  // Bbox is only the BROADPHASE — the old bbox-only test selected long
  // diagonals and big hatches from empty space, a daily hazard when
  // tracing dense underlays. Entities that flatten to segments get a
  // true distance-to-geometry test; compact ones (text/symbol)
  // keep the bbox behavior.
  function entHitAt(e, raw, slop, interiorOk) {
    var bb = entBBox(e);
    if (!bb || raw.x < bb.x - slop || raw.x > bb.x + bb.w + slop || raw.y < bb.y - slop || raw.y > bb.y + bb.h + slop) return false;
    var segs = entSegments(e);
    if (!segs.length) return true;                   // compact entity — bbox is the test
    for (var s = 0; s < segs.length; s++) { if (segNearPoint(segs[s], raw, slop)) return true; }
    // Filled hatch/wipeout: clicking anywhere inside the region selects it.
    if ((e.tool === 'hatch' || e.tool === 'wipeout') && e.points && e.points.length > 2 && pointInPoly(raw, e.points)) return true;
    // Already-SELECTED closed shapes accept interior clicks so the
    // select-then-drag-from-inside motion still works; UNSELECTED ones
    // require an edge hit (that's the dense-underlay fix).
    if ((e.tool === 'rect' || e.tool === 'ellipse') && e.startX != null && (interiorOk || isSelected(e.id))) {
      if (e.tool === 'rect') {
        return raw.x >= Math.min(e.startX, e.endX) && raw.x <= Math.max(e.startX, e.endX) &&
               raw.y >= Math.min(e.startY, e.endY) && raw.y <= Math.max(e.startY, e.endY);
      }
      var hcx = (e.startX + e.endX) / 2, hcy = (e.startY + e.endY) / 2;
      var hrx = Math.abs(e.endX - e.startX) / 2 + slop, hry = Math.abs(e.endY - e.startY) / 2 + slop;
      return hrx > 0 && hry > 0 && (Math.pow((raw.x - hcx) / hrx, 2) + Math.pow((raw.y - hcy) / hry, 2) <= 1);
    }
    return false;
  }
  function hitTest(raw) {
    var slop = screenModelDist(8);
    for (var i = S.doc.entities.length - 1; i >= 0; i--) {
      var e = S.doc.entities[i];
      var lyr = layerById(S.doc, e.layer);          // skip hidden + locked layers
      if (lyr && (lyr.visible === false || lyr.locked)) continue;
      if (entHitAt(e, raw, slop)) return e.id;
    }
    return null;
  }
  // Every selectable entity under the point, topmost first — feeds Alt-click
  // selection cycling through overlapping stacks (dim over polyline over hatch).
  function hitTestAll(raw) {
    var slop = screenModelDist(8), out = [];
    for (var i = S.doc.entities.length - 1; i >= 0; i--) {
      var e = S.doc.entities[i];
      var lyr = layerById(S.doc, e.layer);
      if (lyr && (lyr.visible === false || lyr.locked)) continue;
      // interiorOk=true: Alt-click is the deliberate disambiguation gesture,
      // so closed-shape interiors count regardless of selection state —
      // otherwise the cycle stack changes size as the selection walks it.
      if (entHitAt(e, raw, slop, true)) out.push(e.id);
    }
    return out;
  }
  // ── Selection set helpers (multi-select) ──
  function isSelected(id) { return S.selIds.indexOf(id) >= 0; }
  function selEntities() { return S.doc.entities.filter(function (e) { return S.selIds.indexOf(e.id) >= 0; }); }
  function setSelection(ids) { S.selIds = (ids || []).slice(); S.selectedId = (S.selIds.length === 1) ? S.selIds[0] : null; }
  // Click-select (or shift-toggle) at a point. cycle=true (Alt-click) walks
  // the stack of overlapping entities under the cursor, topmost first.
  function selectAt(raw, additive, cycle) {
    var hit;
    if (cycle && !additive) {
      var stack = hitTestAll(raw);
      if (!stack.length) hit = null;
      else {
        var cur = (S.selIds.length === 1) ? stack.indexOf(S.selIds[0]) : -1;
        hit = stack[(cur + 1) % stack.length];
        if (stack.length > 1) setHint('Alt-click: ' + ((cur + 1) % stack.length + 1) + ' of ' + stack.length + ' overlapping objects — Alt-click again for the next.');
      }
    } else {
      hit = hitTest(raw);
    }
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
      // Arcs: bound the SAMPLED curve, not the 3 control points — a major
      // (>180°) arc bulges up to a full radius outside its control bbox,
      // which under-stated hit-test, window select, and zoom extents.
      var bp = (e.tool === 'arc' && e.points.length >= 3) ? arcSamples(e.points, 24) : e.points;
      var xs = bp.map(function (p) { return p.x; }), ys = bp.map(function (p) { return p.y; });
      var mnx = Math.min.apply(null, xs), mny = Math.min.apply(null, ys);
      return { x: mnx, y: mny, w: Math.max.apply(null, xs) - mnx, h: Math.max.apply(null, ys) - mny };
    }
    if (e.x != null) {
      // Symbol size + text fontPx are PAPER px (annotative) — convert to the
      // model-inch extents the bbox consumers (hit test, window select,
      // rotate/mirror pivots, zoom extents) now operate in.
      var bppi = ppiOf(e);
      if (e.tool === 'symbol') { var hs = (e.size || 40) / 2 / bppi; return { x: e.x - hs, y: e.y - hs, w: hs * 2, h: hs * 2 }; }
      // Text may be multi-line — width from the longest line, height × lines.
      var fp = (e.fontPx || 24) / bppi;
      var tls = String(e.text == null ? '' : e.text).split('\n');
      var tmax = 0; for (var ti = 0; ti < tls.length; ti++) tmax = Math.max(tmax, tls[ti].length);
      return { x: e.x, y: e.y, w: Math.max(2, tmax * fp * 0.55), h: fp * (1 + (tls.length - 1) * 1.25) };
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
  // Snapshots also carry the underlay rect + every viewport's window/scale:
  // v3 calibrate (and viewport zoom via undo-tracked ops) mutate those
  // together with the geometry — restoring only entities would desync the
  // drawing from the traced plan.
  function snapshot() {
    var vps = {};
    (S.doc.sheets || []).forEach(function (sh) {
      (sh.viewports || []).forEach(function (v) {
        vps[v.id] = { window: v.window ? { cx: v.window.cx, cy: v.window.cy } : null, scale: v.scale ? JSON.parse(JSON.stringify(v.scale)) : null };
      });
    });
    return JSON.stringify({ entities: S.doc.entities, layers: S.doc.layers, underlay: S.doc.underlay || null, vps: vps });
  }
  function pushUndo() { S._undo.push(snapshot()); if (S._undo.length > 60) S._undo.shift(); S._redo.length = 0; markDirty(); }
  function commitEntity(e) { pushUndo(); S.doc.entities.push(e); }
  function restoreSnap(json) {
    var o = JSON.parse(json);
    S.doc.entities = o.entities; S.doc.layers = o.layers;
    if (o.underlay !== undefined) {
      // Keep the loaded bitmap; only the placement rect is part of history.
      if (o.underlay && S.doc.underlay) {
        S.doc.underlay.x = o.underlay.x; S.doc.underlay.y = o.underlay.y;
        S.doc.underlay.w = o.underlay.w; S.doc.underlay.h = o.underlay.h;
      } else if (o.underlay) S.doc.underlay = o.underlay;
    }
    if (o.vps) {
      (S.doc.sheets || []).forEach(function (sh) {
        (sh.viewports || []).forEach(function (v) {
          var sv = o.vps[v.id]; if (!sv) return;
          if (sv.window) v.window = { cx: sv.window.cx, cy: sv.window.cy };
          if (sv.scale) v.scale = sv.scale;
        });
      });
    }
    // Re-point the v2 aliases — model.entities is what toV2 rebuilds from on
    // the next load, so a broken alias here means post-undo work silently
    // reverts on reload.
    if (S.doc.model) { S.doc.model.entities = S.doc.entities; S.doc.model.layers = S.doc.layers; }
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
    // v3: geometry IS model inches — ppi only converts paper-anchored sizes
    // (text height) to real units.
    if (!e) return '';
    if (e.tool === 'level') {
      return '<div style="margin-top:7px;">' + propLbl('Elevation', 'prop-elev', fmtLen(e.elevIn || 0), false) + '</div>';
    }
    if (e.tool === 'spotelev') {
      return '<div style="margin-top:7px;">' + propLbl('Elevation', 'prop-elev', fmtLen(elevAtPoint(e)), false) + '</div>';
    }
    if (e.tool === 'line' || e.tool === 'refline') {
      var dx = e.endX - e.startX, dy = e.endY - e.startY;
      return '<div style="display:flex;gap:8px;margin-top:7px;">' + propLbl('Length', 'prop-len', fmtLen(Math.hypot(dx, dy)), true) + propLbl('Angle°', 'prop-ang', (Math.atan2(-dy, dx) * 180 / Math.PI).toFixed(1), true) + '</div>';
    }
    if (e.tool === 'rect') {
      return '<div style="display:flex;gap:8px;margin-top:7px;">' + propLbl('Width', 'prop-w', fmtLen(Math.abs(e.endX - e.startX)), true) + propLbl('Height', 'prop-h', fmtLen(Math.abs(e.endY - e.startY)), true) + '</div>';
    }
    if (e.tool === 'ellipse') {
      return '<div style="margin-top:7px;">' + propLbl('Radius', 'prop-r', fmtLen(Math.abs(e.endX - e.startX) / 2), false) + '</div>';
    }
    if (e.tool === 'text') {
      // Textarea, not an input — a single-line input silently flattens
      // multi-line notes on the next edit. The data-prop-text onchange
      // wiring works unchanged (textarea .value preserves \n).
      return '<div style="margin-top:7px;">' +
        '<label style="font-size:10px;color:#9aa;display:flex;flex-direction:column;gap:2px;">Text' +
          '<textarea data-prop-text rows="3" style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:5px;padding:3px 5px;font-size:11px;resize:vertical;font-family:inherit;">' + esc(e.text || '') + '</textarea>' +
        '</label>' +
        '<div style="margin-top:6px;">' + propLbl('Text height', 'prop-th', fmtLen((e.fontPx || 24) / (ppi || 1)), false) + '</div></div>';
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
  // Rect/ellipse store only two AXIS-ALIGNED corners — a non-axis-preserving
  // transform (arbitrary rotate / slanted mirror) cannot be represented in
  // that form: the shape silently distorts and a circle can collapse to a
  // zero-width sliver. Convert to a closed polyline first (the revcloud
  // pattern — polylines are first-class for render/snaps/hit-test/DXF).
  // Circles are rotation/reflection-invariant, so callers move their CENTER
  // instead and keep them native.
  function polygonizeCornerShape(e) {
    if (e.startX == null) return;
    if (e.tool === 'rect') {
      e.points = [
        { x: e.startX, y: e.startY }, { x: e.endX, y: e.startY },
        { x: e.endX, y: e.endY }, { x: e.startX, y: e.endY },
        { x: e.startX, y: e.startY }
      ];
    } else if (e.tool === 'ellipse') {
      var pcx = (e.startX + e.endX) / 2, pcy = (e.startY + e.endY) / 2;
      var prx = Math.abs(e.endX - e.startX) / 2, pry = Math.abs(e.endY - e.startY) / 2;
      e.points = [];
      for (var pi = 0; pi <= 48; pi++) { var pth = pi / 48 * 2 * Math.PI; e.points.push({ x: pcx + prx * Math.cos(pth), y: pcy + pry * Math.sin(pth) }); }
    } else return;
    e.tool = 'polyline';
    delete e.startX; delete e.startY; delete e.endX; delete e.endY;
  }
  function isCircle(e) {
    return e.tool === 'ellipse' && e.startX != null &&
      Math.abs(Math.abs(e.endX - e.startX) - Math.abs(e.endY - e.startY)) < 0.01;
  }
  // Move a circle's bbox so its center lands at fn(center) — radius unchanged.
  function moveCircleCenter(e, fn) {
    var mcx = (e.startX + e.endX) / 2, mcy = (e.startY + e.endY) / 2;
    var mr = Math.abs(e.endX - e.startX) / 2;
    var nc = fn({ x: mcx, y: mcy });
    e.startX = nc.x - mr; e.startY = nc.y - mr; e.endX = nc.x + mr; e.endY = nc.y + mr;
  }
  // Rotate the selection by a typed angle about its center. Positive = the
  // same direction as the Rotate 90° button (screen-clockwise, Y-down math).
  function rotateBy() {
    var ents = selEntities(); if (!ents.length) return;
    promptText('Rotate by degrees (clockwise; negative = counter-clockwise)', function (txt) {
      if (txt == null) return;
      var deg = parseFloat(txt);
      if (!isFinite(deg) || deg === 0) return;
      pushUndo();
      var gb = groupBBox(selEntities()), cx = gb.x + gb.w / 2, cy = gb.y + gb.h / 2;
      var th = deg * Math.PI / 180, co = Math.cos(th), si = Math.sin(th);
      var rot = function (p) { var dx = p.x - cx, dy = p.y - cy; return { x: cx + dx * co - dy * si, y: cy + dx * si + dy * co }; };
      var exact = (deg % 90 === 0);   // 90° multiples keep axis-aligned shapes axis-aligned
      selEntities().forEach(function (e) {
        if (!exact) {
          if (isCircle(e)) { moveCircleCenter(e, rot); return; }
          if (e.tool === 'rect' || e.tool === 'ellipse') polygonizeCornerShape(e);
        }
        transformEntity(e, rot);
        if (e.tool === 'symbol') e.rotation = (((e.rotation || 0) + deg) % 360 + 360) % 360;
      });
      repaint();
    }, '45');
  }
  // Two-point mirror with keep-copy: select objects, then click two points on
  // the mirror line — mirrored COPIES are created (originals kept). The
  // left-hand/right-hand building layout move.
  function mirror2Click(pt) {
    if (!S.selIds.length) { setHint('Mirror 2-pt: select objects first, then click two points on the mirror line.'); return; }
    if (!S._mir) { S._mir = { a: { x: pt.x, y: pt.y } }; setHint('Mirror 2-pt: click the second point of the mirror line.'); repaint(); return; }
    var ma = S._mir.a, mb = { x: pt.x, y: pt.y }; S._mir = null;
    var mdx = mb.x - ma.x, mdy = mb.y - ma.y, mL2 = mdx * mdx + mdy * mdy;
    if (mL2 < 1e-9) { setHint('Mirror 2-pt: those two points coincide — click two distinct points.'); return; }
    function refl(p) {
      var tt = ((p.x - ma.x) * mdx + (p.y - ma.y) * mdy) / mL2;
      var fx = ma.x + tt * mdx, fy = ma.y + tt * mdy;
      return { x: 2 * fx - p.x, y: 2 * fy - p.y };
    }
    pushUndo();
    var newIds = [];
    selEntities().forEach(function (e) {
      var copy = JSON.parse(JSON.stringify(e)); copy.id = uid(copy.tool);
      if (isCircle(copy)) {
        // Reflection preserves a circle exactly — just reflect its center.
        moveCircleCenter(copy, refl);
      } else {
        // A hand-clicked mirror line is never exactly axis-aligned, and a
        // slanted reflection of a corner-stored rect/ellipse is not
        // representable in that form — polygonize first (axis mirrors have
        // their own Mirror H/V buttons that keep shapes native).
        if (copy.tool === 'rect' || copy.tool === 'ellipse') polygonizeCornerShape(copy);
        transformEntity(copy, refl);
      }
      S.doc.entities.push(copy); newIds.push(copy.id);
    });
    setSelection(newIds); buildLayers(); repaint();
    setTool('select');
    setHint('Mirrored ' + newIds.length + ' object' + (newIds.length === 1 ? '' : 's') + ' — originals kept.');
  }
  // Zoom window — two clicks frame that area on screen. Camera-only; the
  // clicks arrive in model coords, so map back to the current plane first.
  function zoomWinClick(pt, vp) {
    var plane = (S.space === 'model') ? mToV(pt) : mToP(pt, vp || activeVp());
    if (!S._zw) { S._zw = { a: plane }; setHint('Zoom window: click the opposite corner.'); return; }
    var za = S._zw.a, zb = plane; S._zw = null;
    var zx = Math.min(za.x, zb.x), zy = Math.min(za.y, zb.y), zw = Math.abs(zb.x - za.x), zh = Math.abs(zb.y - za.y);
    if (zw < 2 || zh < 2) { setTool('select'); setHint('Zoom window: those corners are too close — drag a larger box.'); return; }
    var cw = S.cssW || S.canvas.width, ch = S.cssH || S.canvas.height;
    var zs = Math.max(0.02, Math.min(8, Math.min(cw / zw, ch / zh) * 0.92));
    S.view.scale = zs;
    S.view.tx = cw / 2 - (zx + zw / 2) * zs;
    S.view.ty = ch / 2 - (zy + zh / 2) * zs;
    setTool('select');
    repaint();
  }
  // One-click size/perimeter/area readout for a drawn shape (Measure tool).
  // Model units ARE inches; areas read in SF.
  function objectInquiry(e) {
    function sf(a) { return (a / 144).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' SF'; }
    if (e.tool === 'rect' && e.startX != null) {
      var rw = Math.abs(e.endX - e.startX), rh = Math.abs(e.endY - e.startY);
      return 'Rectangle ' + fmtLen(rw) + ' × ' + fmtLen(rh) + ' · Perimeter ' + fmtLen(2 * (rw + rh)) + ' · Area ' + sf(rw * rh);
    }
    if (e.tool === 'ellipse' && e.startX != null) {
      var erx = Math.abs(e.endX - e.startX) / 2, ery = Math.abs(e.endY - e.startY) / 2;
      var eper = Math.PI * (3 * (erx + ery) - Math.sqrt((3 * erx + ery) * (erx + 3 * ery)));   // Ramanujan
      return (Math.abs(erx - ery) < 0.01 ? 'Circle ⌀ ' + fmtLen(erx * 2) : 'Ellipse ' + fmtLen(erx * 2) + ' × ' + fmtLen(ery * 2)) +
        ' · Perimeter ' + fmtLen(eper) + ' · Area ' + sf(Math.PI * erx * ery);
    }
    if ((e.tool === 'polyline' || e.tool === 'hatch' || e.tool === 'wipeout') && e.points && e.points.length > 2) {
      var arr = e.points, per = 0;
      for (var i = 1; i < arr.length; i++) per += Math.hypot(arr[i].x - arr[i - 1].x, arr[i].y - arr[i - 1].y);
      var gap = Math.hypot(arr[0].x - arr[arr.length - 1].x, arr[0].y - arr[arr.length - 1].y);
      var closed = (e.tool !== 'polyline') || gap < 1;
      if (closed) {
        if (e.tool !== 'polyline') per += gap;                       // hatch/wipeout close implicitly
        var area = 0;
        for (var j = 0, k = arr.length - 1; j < arr.length; k = j++) area += (arr[k].x + arr[j].x) * (arr[k].y - arr[j].y);
        return 'Closed shape · Perimeter ' + fmtLen(per) + ' · Area ' + sf(Math.abs(area) / 2);
      }
      return 'Polyline · Length ' + fmtLen(per);
    }
    if (e.tool === 'line' && e.startX != null) return 'Line · Length ' + fmtLen(Math.hypot(e.endX - e.startX, e.endY - e.startY));
    return null;
  }
  function duplicateSelected() {
    var ents = selEntities(); if (!ents.length) return;
    pushUndo();
    var newIds = [];
    ents.forEach(function (e) { var copy = JSON.parse(JSON.stringify(e)); copy.id = uid(copy.tool); translateEntity(copy, 6, 6); S.doc.entities.push(copy); newIds.push(copy.id); });   // 6" model offset
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
    var tol = screenModelDist(2.5), pool = lines.slice();
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
    if (e && (e.tool !== 'ellipse' || e.startX == null)) e = null;
    if (!e) {
      // The tightened hitTest only accepts EDGE clicks — but for a dim pick,
      // clicking anywhere inside the circle is the natural gesture. Scan
      // topmost-first for an ellipse whose (padded) interior holds the point.
      var pad = screenModelDist(8);
      for (var ci = S.doc.entities.length - 1; ci >= 0; ci--) {
        var c = S.doc.entities[ci];
        if (!c || c.tool !== 'ellipse' || c.startX == null) continue;
        var clyr = layerById(S.doc, c.layer);
        if (clyr && (clyr.visible === false || clyr.locked)) continue;
        var ccx = (c.startX + c.endX) / 2, ccy = (c.startY + c.endY) / 2;
        var crx = Math.abs(c.endX - c.startX) / 2 + pad, cry = Math.abs(c.endY - c.startY) / 2 + pad;
        if (crx <= 0 || cry <= 0) continue;
        if (Math.pow((pt.x - ccx) / crx, 2) + Math.pow((pt.y - ccy) / cry, 2) <= 1) { e = c; break; }
      }
    }
    if (!e) { setHint((kind === 'diameter' ? 'Diameter' : 'Radius') + ' dim: click a circle or ellipse.'); return; }
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
    // Gather viewport ids across ALL sheets (multi-sheet) — an entity is only an
    // orphan if its viewport exists on no sheet, not merely the inactive ones.
    var ids = {}, sheets = S.doc.sheets || [];
    if (sheets.length) sheets.forEach(function (sh) { (sh.viewports || []).forEach(function (v) { ids[v.id] = true; }); });
    else (S.doc.viewports || []).forEach(function (v) { ids[v.id] = true; });
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
    var dx = (colFt || 0) * 12, dy = (rowFt || 0) * 12;   // model inches
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
    var d = (distFt || 0) * 12 * (side < 0 ? -1 : 1);   // model inches
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
    box.style.cssText = 'background:#141419;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:340px;width:100%;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
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
    var tol = screenModelDist(10, vp), best = null, bestD = tol;   // model inches
    (S.doc.entities || []).forEach(function (e) {
      if (e.tool !== 'line' || e.startX == null) return;
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
    var tol = screenModelDist(10, vp), best = null, bestD = tol;   // model inches
    (S.doc.entities || []).forEach(function (e) {
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
    var d = (dFt || 0) * 12;   // model inches
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
    var r = (rFt || 0) * 12;   // model inches
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
    // v3: the underlay lives in MODEL INCHES. Letterbox the plan into the
    // viewport's model WINDOW (rect ÷ ppi, centered on the window) so a fresh
    // import fills the frame exactly like it used to on paper.
    var ppi = vpPpiSafe(vp), w = vpWin(vp);
    var winW = vp.w / ppi, winH = vp.h / ppi;
    var fit = Math.min(winW / u.natW, winH / u.natH);
    u.w = u.natW * fit; u.h = u.natH * fit;
    u.x = w.cx - u.w / 2;
    u.y = w.cy - u.h / 2;
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
  // Underlay lives in MODEL space (it's the traced plan) — mapped onto the
  // target plane like entities, so every viewport window that covers it shows
  // it, and the model view shows it true-size behind the geometry.
  function drawUnderlayMapped(ctx, mapFn) {
    var u = S && S.doc && S.doc.underlay;
    if (!u || !S._underlayBmp || u.x == null) return;
    var p0 = mapFn({ x: u.x, y: u.y });
    var p1 = mapFn({ x: u.x + u.w, y: u.y + u.h });
    ctx.save();
    var op = (u.opacity == null) ? 0.6 : u.opacity;
    ctx.globalAlpha = Math.max(0.05, Math.min(1, op));
    try { ctx.drawImage(S._underlayBmp, p0.x, p0.y, p1.x - p0.x, p1.y - p0.y); } catch (e) {}
    ctx.restore();
  }
  function importUnderlay() {
    if (!S) return;
    var S0 = S;   // identity-captured: the page prompt + upload are async — the editor may close or reopen on another plan mid-flight
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/pdf,image/*'; inp.style.display = 'none';
    inp.onchange = function () {
      var file = inp.files && inp.files[0];
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (!file) return;
      var isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);
      // Plan sets arrive as multi-page PDFs — peek at the page count locally
      // (before any upload) and ask which sheet to trace. Import used to
      // hardcode page 0, so only sheet 1 of a set was ever usable.
      if (isPdf && window.pdfjsLib && file.arrayBuffer) {
        file.arrayBuffer()
          .then(function (buf) { return window.pdfjsLib.getDocument({ data: buf }).promise; })
          .then(function (pdf) {
            var n = pdf.numPages || 1;
            try { pdf.destroy(); } catch (e2) {}
            if (n <= 1) { finishUnderlayImport(file, true, 0); return; }
            promptText('PDF page to trace (1–' + n + ')', function (txt) {
              if (txt == null) return;               // Cancel/Esc/backdrop — abort the import entirely
              var pg = parseInt(txt, 10);
              if (isNaN(pg)) pg = 1;
              pg = Math.max(1, Math.min(n, pg));
              finishUnderlayImport(file, true, pg - 1);
            }, '1');
          })
          .catch(function () { finishUnderlayImport(file, true, 0); });   // unreadable locally — old behavior
      } else {
        finishUnderlayImport(file, isPdf, 0);
      }
    };
    document.body.appendChild(inp);
    inp.click();
    function finishUnderlayImport(file, isPdf, page) {
      if (!S || S !== S0) return;   // editor closed or reopened on another plan during the async prompt — don't touch the wrong doc
      var plan = S.plan || {};
      var et, eid;
      if (plan.entity_type && plan.entity_id) { et = plan.entity_type; eid = plan.entity_id; }
      else { et = 'user'; eid = (window.p86Auth && p86Auth.getUser && (p86Auth.getUser() || {}).id); }
      if (eid == null) { alert('Could not determine where to store the underlay file.'); return; }
      if (!window.p86Api || !p86Api.attachments || !p86Api.attachments.upload) { alert('Upload API unavailable — refresh the page.'); return; }
      setHint('Uploading underlay…');
      p86Api.attachments.upload(et, eid, file, { skip_geo: true }).then(function (res) {
        if (!S || S !== S0) return;   // editor closed during the upload
        var att = (res && (res.attachment || res)) || {};
        if (!att.id) throw new Error('upload returned no attachment id');
        S.doc.underlay = {
          attachmentId: att.id, kind: isPdf ? 'pdf' : 'image', page: page || 0,
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
    }
  }
  // Calibrate: two clicks a known distance apart → type the real length →
  // back-solve this viewport's pixelsPerInch so every measure/dim/area is true.
  function calibrateClick(pt, vp) {
    vp = vp || activeVp();
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
      // v3: geometry IS model inches, so calibration means the traced content
      // is the wrong SIZE (drawn over an arbitrary-scale underlay). Scale the
      // content inside this viewport's window + the underlay about the first
      // picked point so the picked span measures the typed length; the window
      // + ppi adjust inversely so the PAPER view doesn't move a pixel.
      var r = inches / pxDist;
      if (!isFinite(r) || r <= 0) return;
      pushUndo();
      var ppi = vpPpiSafe(vp), w = vpWin(vp);
      var wx0 = w.cx - (vp.w / 2) / ppi, wx1 = w.cx + (vp.w / 2) / ppi;
      var wy0 = w.cy - (vp.h / 2) / ppi, wy1 = w.cy + (vp.h / 2) / ppi;
      function scalePt(p) { return { x: a.x + (p.x - a.x) * r, y: a.y + (p.y - a.y) * r }; }
      (S.doc.entities || []).forEach(function (e2) {
        if (!e2) return;
        var bb = entBBox(e2); if (!bb) return;
        var ccx = bb.x + bb.w / 2, ccy = bb.y + bb.h / 2;
        if (ccx < wx0 || ccx > wx1 || ccy < wy0 || ccy > wy1) return;
        transformEntity(e2, scalePt);
      });
      var u = S.doc.underlay;
      if (u && u.x != null) { var up = scalePt({ x: u.x, y: u.y }); u.x = up.x; u.y = up.y; u.w *= r; u.h *= r; }
      w.cx = a.x + (w.cx - a.x) * r; w.cy = a.y + (w.cy - a.y) * r;
      if (!vp.scale) vp.scale = { unit: 'ft' };
      vp.scale.pixelsPerInch = ppi / r;
      vp.scale.calibrated = true;
      vp.scale.label = 'Calibrated · ' + fmtLen(inches) + ' ref';
      markDirty();
      if (typeof setTool === 'function') setTool('select');
      repaint(); refreshStatusBar(); buildLayers();
      setHint('Scale calibrated — the drawing is now true size (measurements + DXF are real units).');
    });
  }

  // ── Model / Sheet space (Phase B) ───────────────────────────────
  // Phase B step 1: a chrome-free Model working view. Sheet space is the
  // titleblocked paper (unchanged default); Model space hides the sheet
  // border / viewport frame / titleblock so you draw on a clean surface.
  // Same coordinate space (no data change) — the model-canonical coordinate
  // migration + scaled viewport windows land in Phase C/D (multi-viewport).
  function setSpace(sp) {
    if (!S || (sp !== 'model' && sp !== 'sheet')) return;
    if (S.space === sp) return;
    // Each space keeps its own camera — toggling never loses your zoom.
    if (S.space === 'model') S._viewModel = S.view; else S._viewSheet = S.view;
    S.space = sp;
    S.doc.space = sp;                                   // persisted — reopen lands here
    markDirty();
    if (sp === 'model') S.view = S._viewModel || fitModelView();
    else S.view = S._viewSheet || fitView(S.doc, S.cssW || S.canvas.width, S.cssH || S.canvas.height);
    setHint(sp === 'model' ? 'Model space — the drawing itself, true size. Dashed outline = what the sheet window prints.' : 'Paper space — titleblocked sheet for printing.');
    buildSpaceTabs(); refreshStatusBar(); repaint();
  }
  // Phase C: space/sheet tab strip — [ Model ] [ A-1 ] [ A-2 ] … [ + ]. Each sheet
  // is a titleblocked page owning its own viewport id(s); entities tag to the active
  // sheet's viewport (newEntity), so the tag-filtered renderer shows each sheet's own
  // content — no viewport-window transform needed, existing single-sheet drawings
  // unchanged. Switching re-points the flat aliases (doc.sheet/viewports/titleblock).
  function buildSpaceTabs() {
    var host = S.overlay && S.overlay.querySelector('#p86-layout-tabs');
    if (!host) return;
    var sheets = S.doc.sheets || [];
    // AutoCAD layout-tab anatomy: flat joined tabs on the bottom edge of the
    // drawing area, active tab raised + blue top edge.
    function tab(id, label, on, title) {
      return '<button data-space-tab="' + esc(id) + '" title="' + esc(title || '') + '" style="background:' + (on ? '#232b38' : 'transparent') +
        ';color:' + (on ? '#fff' : '#8b96ab') + ';border:0;border-right:1px solid #232733;border-top:2px solid ' + (on ? '#4f8cff' : 'transparent') +
        ';padding:5px 14px 6px;font-size:11.5px;font-weight:' + (on ? '700' : '600') + ';cursor:pointer;white-space:nowrap;flex:0 0 auto;">' + esc(label) + '</button>';
    }
    var html = tab('__model', 'Model', S.space === 'model', 'Model space — the drawing itself, true size');
    sheets.forEach(function (sh) {
      var on = (S.space === 'sheet' && S.doc.activeSheetId === sh.id);
      html += tab(sh.id, sh.name || sh.id, on, 'Layout ' + (sh.name || '') + ' — double-click to rename');
    });
    html += '<button data-add-sheet title="Add a new titleblocked sheet" style="background:transparent;color:#86efac;border:0;width:26px;padding:5px 0 6px;cursor:pointer;font-size:14px;line-height:1;flex:0 0 auto;">+</button>';
    host.innerHTML = html;
    host.querySelectorAll('[data-space-tab]').forEach(function (b) {
      var id = b.getAttribute('data-space-tab');
      b.onclick = function () { if (id === '__model') setSpace('model'); else setActiveSheet(id); };
      if (id !== '__model') b.ondblclick = function () {
        var sh = (S.doc.sheets || []).filter(function (s) { return s.id === id; })[0]; if (!sh) return;
        var nm = window.prompt('Sheet name', sh.name || ''); if (nm != null && nm.trim()) { pushUndo(); sh.name = nm.trim().slice(0, 40); markDirty(); buildSpaceTabs(); }
      };
    });
    var add = host.querySelector('[data-add-sheet]'); if (add) add.onclick = addSheet;
  }
  function setActiveSheet(id) {
    var sheets = S.doc.sheets || [], sh = null;
    for (var i = 0; i < sheets.length; i++) if (sheets[i].id === id) { sh = sheets[i]; break; }
    if (!sh) return;
    S.doc.activeSheetId = id;
    S.doc.sheet = sh;                                   // re-point the flat aliases at the active sheet
    S.doc.viewports = sh.viewports || (sh.viewports = []);
    S.doc.titleblock = sh.titleblock || (sh.titleblock = {});
    if (S.space === 'model') S._viewModel = S.view;     // leaving model → remember its camera
    S.space = 'sheet';
    S.doc.space = 'sheet';
    S._viewSheet = null;                                // new sheet → refit below
    setSelection([]);
    buildSpaceTabs(); buildLayers(); sizeCanvas(true); refreshStatusBar(); repaint();
  }
  function addSheet() {
    var sheets = S.doc.sheets || (S.doc.sheets = []);
    pushUndo();
    var s0 = S.doc.sheet || {};
    var pre = scalePreset(SETTINGS.scaleLabel);
    var num = sheets.length + 1;
    var sheet = {
      id: uid('S'), name: 'A-' + num,
      size: s0.size, w: s0.w, h: s0.h, margin: s0.margin,
      titleblock: { project: (S.plan && S.plan.name) || '', title: 'PLAN', scale: pre.label, sheetNo: 'A-' + num,
        date: '', drawnBy: '', client: '', company: '', showLogo: true, projectNo: '', address: '',
        checkedBy: '', approvedBy: '', sheetOf: '', revisions: [], generalNotes: '', showNotes: false, logoScale: 1, logoPos: 'left' },
      viewports: [{ id: uid('VP'), label: 'PLAN', x: 0, y: 0, w: 100, h: 100,
        scale: { pixelsPerInch: DPI * pre.f, unit: pre.unit || 'ft', label: pre.label } }]
    };
    // Give the new sheet's viewport a FRESH model region (right of everything
    // drawn or windowed so far) — sheets share one model but a new page
    // starts with clean ground, laid out side-by-side CAD-style.
    var maxX = 0;
    (S.doc.sheets || []).forEach(function (sh2) {
      (sh2.viewports || []).forEach(function (v) {
        var p2 = vpPpiSafe(v), w2 = vpWin(v);
        maxX = Math.max(maxX, w2.cx + (v.w / 2) / p2);
      });
    });
    (S.doc.entities || []).forEach(function (e2) { var bb = e2 && entBBox(e2); if (bb) maxX = Math.max(maxX, bb.x + bb.w); });
    var nvp = sheet.viewports[0], nppi = vpPpiSafe(nvp);
    // Region sized from the final rect (layoutViewports runs after
    // setActiveSheet) — approximate with the current sheet's drawable area.
    var s2 = S.doc.sheet || sheet;
    var estW = Math.max(200, (s2.w || 2000) - (s2.margin || 60) * 2 - 32) / nppi;
    var estH = Math.max(150, (s2.h || 1500) - (s2.margin || 60) * 2 - Math.round(3 * DPI) - 32) / nppi;
    nvp.window = { cx: maxX + estW * 0.25 + estW / 2, cy: estH / 2 };
    sheets.push(sheet);
    setActiveSheet(sheet.id);
    layoutViewports(S.doc);                              // position the new sheet's viewport within the page
    markDirty(); buildLayers(); repaint();
  }

  // ── Render ──────────────────────────────────────────────────────
  function repaint() {
    var ctx = S.ctx, c = S.canvas;
    var dpr = S.dpr || 1, vw = S.cssW || c.width, vh = S.cssH || c.height;
    var modelMode = S.space === 'model';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Model space = the dark drafting field; sheet space = desk around paper.
    ctx.fillStyle = modelMode ? '#1e232b' : '#11151c'; ctx.fillRect(0, 0, vw, vh);
    ctx.save();
    ctx.translate(S.view.tx, S.view.ty);
    ctx.scale(S.view.scale, S.view.scale);
    renderSheet(ctx, S.doc, {
      paperShadow: true, grid: S.gridSnap, viewScale: S.view.scale, editor: true, modelMode: modelMode,
      activeVpId: (!modelMode && S.vpActive) ? S.vpActive : null,
      // Plane rect currently on screen — drawModelField clips its infinite
      // grid/axes to this so pan/zoom never runs off the lattice.
      visible: {
        x0: -S.view.tx / S.view.scale, y0: -S.view.ty / S.view.scale,
        x1: (vw - S.view.tx) / S.view.scale, y1: (vh - S.view.ty) / S.view.scale
      }
    });
    // Overlays live in MODEL coords; the canvas is under the PLANE transform.
    // pm() maps model → plane through the active context (virtual plane in
    // model space, the active viewport's window in sheet space).
    var ovVp = activeVp();
    function pm(pt) { return modelMode ? mToV(pt) : mToP(pt, ovVp); }
    // draft preview
    if (S.draft) {
      var d = S.draft;
      ctx.save();
      ctx.strokeStyle = '#4f8cff'; ctx.fillStyle = '#4f8cff';
      ctx.lineWidth = (d.lineWidth || 3);
      if (d.tool === 'arc') {
        var pp = d.points.slice(); if (S.hover) pp.push(S.hover);
        var sp = ((pp.length >= 3) ? arcSamples(pp, 40) : pp).map(pm);
        if (sp.length) {
          ctx.beginPath(); ctx.moveTo(sp[0].x, sp[0].y);
          for (var ai = 1; ai < sp.length; ai++) ctx.lineTo(sp[ai].x, sp[ai].y);
          ctx.stroke();
        }
      } else if (d.points) {
        var dp = d.points.map(pm);
        ctx.beginPath(); ctx.moveTo(dp[0].x, dp[0].y);
        for (var i = 1; i < dp.length; i++) ctx.lineTo(dp[i].x, dp[i].y);
        if (S.hover) { var hp = pm(S.hover); ctx.lineTo(hp.x, hp.y); }
        ctx.stroke();
      } else if (S.hover) {
        var prev = { tool: d._circle ? 'ellipse' : (d.tool === 'refline' ? 'line' : (d.tool === 'revcloud' ? 'rect' : d.tool)), color: '#4f8cff', lineWidth: d.lineWidth || 3 };
        if (d._circle) {
          var r = Math.hypot(S.hover.x - d.startX, S.hover.y - d.startY);
          prev.startX = d.startX - r; prev.startY = d.startY - r; prev.endX = d.startX + r; prev.endY = d.startY + r;
        } else { prev.startX = d.startX; prev.startY = d.startY; prev.endX = S.hover.x; prev.endY = S.hover.y; }
        // Live dimension label — model units ARE inches in v3.
        if (d.tool === 'measure') {
          prev.measureInches = Math.hypot(prev.endX - prev.startX, prev.endY - prev.startY);
          prev.measureLabel = fmtLen(prev.measureInches);
        }
        if (prims().drawStroke) { try { prims().drawStroke(ctx, entOnPlane(prev, pm)); } catch (e) {} }
      }
      ctx.restore();
    }
    // calibrate in progress — marker on the first point + rubber line to cursor
    if (S._calib && S._calib.pts && S._calib.pts.length) {
      var ca0 = pm(S._calib.pts[0]);
      ctx.save();
      ctx.strokeStyle = '#f59e0b'; ctx.fillStyle = '#f59e0b';
      ctx.lineWidth = 1.5 / S.view.scale;
      ctx.beginPath(); ctx.arc(ca0.x, ca0.y, 4 / S.view.scale, 0, Math.PI * 2); ctx.fill();
      if (S.hover) { var chv = pm(S.hover); ctx.beginPath(); ctx.moveTo(ca0.x, ca0.y); ctx.lineTo(chv.x, chv.y); ctx.stroke(); }
      ctx.restore();
    }
    // stretch in progress — crossing window (c2) + captured vertices + move vector
    if (S._stretch) {
      var stp = S._stretch;
      ctx.save();
      ctx.strokeStyle = '#22c55e'; ctx.fillStyle = '#22c55e'; ctx.lineWidth = 1 / S.view.scale;
      if (stp.phase === 'c2' && stp.p1 && S.hover) {
        var sa = pm(stp.p1), sb = pm(S.hover);
        ctx.setLineDash([6 / S.view.scale, 4 / S.view.scale]);
        ctx.strokeRect(Math.min(sa.x, sb.x), Math.min(sa.y, sb.y), Math.abs(sb.x - sa.x), Math.abs(sb.y - sa.y));
        ctx.setLineDash([]);
      }
      if (stp.verts) stp.verts.forEach(function (v) {
        var p = v.k === 's' ? { x: v.e.startX, y: v.e.startY } : v.k === 'e' ? { x: v.e.endX, y: v.e.endY } : v.k === 'p' ? v.e.points[v.i] : { x: v.e.x, y: v.e.y };
        var pp2 = pm(p);
        ctx.beginPath(); ctx.arc(pp2.x, pp2.y, 3 / S.view.scale, 0, Math.PI * 2); ctx.fill();
      });
      if (stp.phase === 'dest' && stp.base && S.hover) { var ba = pm(stp.base), bh2 = pm(S.hover); ctx.beginPath(); ctx.moveTo(ba.x, ba.y); ctx.lineTo(bh2.x, bh2.y); ctx.stroke(); }
      ctx.restore();
    }
    // continuous-dim in progress — rubber line from the last point to the cursor
    if (S._dimcont && S._dimcont.last && S.hover) {
      var dca = pm(S._dimcont.last), dcb = pm(S.hover);
      ctx.save(); ctx.strokeStyle = '#b45309'; ctx.lineWidth = 1 / S.view.scale;
      ctx.setLineDash([5 / S.view.scale, 4 / S.view.scale]);
      ctx.beginPath(); ctx.moveTo(dca.x, dca.y); ctx.lineTo(dcb.x, dcb.y); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
    }
    // selection highlight — every selected entity (dashed green box)
    if (S.selIds && S.selIds.length) {
      ctx.save(); ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 1.5 / S.view.scale; ctx.setLineDash([6 / S.view.scale, 4 / S.view.scale]);
      selEntities().forEach(function (sel) {
        var bb = entBBox(sel); if (!bb) return;
        var c0 = pm({ x: bb.x, y: bb.y }), c1 = pm({ x: bb.x + bb.w, y: bb.y + bb.h });
        var x0 = Math.min(c0.x, c1.x), y0 = Math.min(c0.y, c1.y);
        ctx.strokeRect(x0 - 4, y0 - 4, Math.abs(c1.x - c0.x) + 8, Math.abs(c1.y - c0.y) + 8);
      });
      ctx.restore();
    }
    // rubber-band selection box (window = solid blue · crossing = dashed green)
    if (S.boxSel) {
      var b = S.boxSel, crossing = b.start.x > b.last.x;
      var pba = pm(b.start), pbb = pm(b.last);
      var bx0 = Math.min(pba.x, pbb.x), by0 = Math.min(pba.y, pbb.y);
      var bw = Math.abs(pbb.x - pba.x), bh = Math.abs(pbb.y - pba.y);
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
      var ippi = 1;   // v3: model units ARE inches — no conversion

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
    // AutoCAD crosshair + pickbox (screen space). The native cursor is hidden
    // (cursor:none) while this is on; panning shows the grab cursor instead.
    if (SETTINGS.crosshair !== false && S.hover && !S._offCanvas && !S.panning && S.tool !== 'pan' && !S.spaceDown) {
      var ch = toScreen(S.hover.x, S.hover.y);
      if (ch.x >= -1 && ch.x <= vw + 1 && ch.y >= -1 && ch.y <= vh + 1) {
        ctx.save();
        ctx.strokeStyle = modelMode ? 'rgba(210,220,235,0.45)' : 'rgba(148,163,184,0.45)';
        ctx.lineWidth = 1;
        var px = Math.round(ch.x) + 0.5, py = Math.round(ch.y) + 0.5, pb = 4;
        ctx.beginPath();
        ctx.moveTo(0, py); ctx.lineTo(px - pb, py); ctx.moveTo(px + pb, py); ctx.lineTo(vw, py);
        ctx.moveTo(px, 0); ctx.lineTo(px, py - pb); ctx.moveTo(px, py + pb); ctx.lineTo(px, vh);
        ctx.stroke();
        ctx.strokeStyle = modelMode ? 'rgba(230,238,248,0.9)' : 'rgba(203,213,225,0.9)';
        ctx.strokeRect(px - pb, py - pb, pb * 2, pb * 2);
        ctx.restore();
      }
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
  function renderFullSheet(mult) {
    mult = Math.max(1, mult || 1);
    var s = S.doc.sheet;
    var off = document.createElement('canvas');
    off.width = Math.round(s.w * mult); off.height = Math.round(s.h * mult);
    var ctx = off.getContext('2d');
    if (mult !== 1) ctx.scale(mult, mult);
    renderSheet(ctx, S.doc);
    return off;
  }
  // Export raster at 2× (240 DPI) so dim text prints crisp on Arch D —
  // 120 DPI reads visibly soft on a full-size sheet. Oversized-canvas
  // platforms (older iOS Safari) return a blank/empty data URL instead
  // of throwing, so validate and fall back to 1×.
  function sheetDataUrl() {
    var url = null;
    try { url = renderFullSheet(2).toDataURL('image/png'); } catch (e) { url = null; }
    if (!url || url.length < 2000) {
      url = renderFullSheet(1).toDataURL('image/png');
    }
    return url;
  }
  function exportPng() {
    try {
      var url = sheetDataUrl();
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
    try { url = sheetDataUrl(); }
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
    // v3: entity coordinates ARE model inches — emit them directly, flipping
    // Y (DXF is Y-up). The old per-viewport offset/convert machinery is baked
    // into the coordinates by the v3 migration.
    function omap(e, px, py) { return { x: px, y: -py }; }
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
          // Radii are already model inches in v3.
          var cx = (e.startX + e.endX) / 2, cy = (e.startY + e.endY) / 2, rxp = Math.abs(e.endX - e.startX) / 2, ryp = Math.abs(e.endY - e.startY) / 2;
          if (Math.abs(rxp - ryp) < 0.05) { out += circleDxf(L, omap(e, cx, cy), rxp); }
          else { var pts = []; for (var k = 0; k <= 48; k++) { var th = k / 48 * 2 * Math.PI; pts.push(omap(e, cx + rxp * Math.cos(th), cy + ryp * Math.sin(th))); } out += polyDxf(L, pts, true); }
        }
        else if (e.tool === 'arc' && e.points && e.points.length >= 3) { out += arcDxf(L, e.points.map(function (p) { return omap(e, p.x, p.y); })); }
        else if ((e.tool === 'polyline' || e.tool === 'mangle' || e.tool === 'hatch' || e.tool === 'wipeout') && e.points && e.points.length) { out += polyDxf(L, e.points.map(function (p) { return omap(e, p.x, p.y); }), e.tool === 'hatch' || e.tool === 'wipeout'); }
        else if (e.tool === 'text' && e.x != null) {
          // Multi-line notes → one DXF TEXT per line, stacked at the canvas's
          // 1.25× line height (R12 has no MTEXT).
          var tdxH = (e.fontPx || 24) / ppiOf(e);
          var tdxLines = String(e.text || '').split('\n');
          for (var tdi = 0; tdi < tdxLines.length; tdi++) out += textDxf(L, omap(e, e.x, e.y + tdi * tdxH * 1.25), tdxH, tdxLines[tdi]);
        }
        else if (e.tool === 'symbol' && e.x != null) { out += circleDxf(L, omap(e, e.x, e.y), (e.size || 40) / 2 / ppiOf(e)); }
        else if (e.tool === 'level') { var la = omap(e, e.startX, e.startY), lb = omap(e, e.endX, e.endY); out += lineDxf(L, la, lb) + textDxf(L, { x: Math.max(la.x, lb.x), y: la.y }, 5, fmtFeet(e.elevIn || 0)); }
        else if (e.tool === 'spotelev' && e.x != null) { var sp = omap(e, e.x, e.y); out += circleDxf(L, sp, (DPI * 0.1) / ppiOf(e)) + textDxf(L, { x: sp.x, y: sp.y }, 5, '+' + fmtFeet(elevAtPoint(e))); }
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
        // Space/sheet tab strip self-wires in buildSpaceTabs() (called from open()).
      }
    },
    close: close,
    defaultDoc: defaultDoc,
    buildDxf: buildDxf,
    SHEET_SIZES: SHEET_SIZES,
    DPI: DPI,
    // v3 migration internals — exposed for round-trip verification (the
    // migration must render pixel-identical: mToP(migrated, vp) === original
    // paper coords) and for external tooling.
    _v3: { toV2: toV2, toV3: toV3, healDoc: healDoc, serializeDoc: serializeDoc, mToP: mToP, pToM: pToM }
  };
})();
