// Tag → icon registry for photo map pins.
//
// Each photo on an entity / report map renders as a colored circle pin
// with a glyph driven by the photo's PRIMARY tag (first tag in the
// photo's tags array). Resolution order, richest first:
//   1. The org's per-tag config (Admin → Organization → Tag Catalog):
//      each tag can carry an icon (a P86 / agx-icons name) + a hue.
//   2. The built-in CATALOG below — a broad library of construction
//      trades + photo phases mapped to a color + glyph (+ icon where a
//      P86 glyph fits). Matched as a substring of the normalized tag.
//   3. A neutral gray dot.
//
// The icon spec the renderer consumes:
//   { bg:'#hex', fg:'#hex', glyph:'1-2 char', icon:'agx-name'|null }
// glyphMarkup() turns (icon || glyph) into SVG: a white P86 icon when an
// icon name resolves, else the text glyph. Both photo-pin renderers
// (projects-map.js, projects.js) call glyphMarkup so the look is shared.
//
// Public surface:
//   window.p86TagIcons.forTag(tag)         → spec for a single tag
//   window.p86TagIcons.forPhoto(photo)     → spec for photo.tags[0]
//   window.p86TagIcons.glyphMarkup(spec, cx, cy, size) → SVG inner markup
//   window.p86TagIcons.ensureConfig()      → load org per-tag config (once)
//   window.p86TagIcons.setConfig(map)      → push fresh config (admin save)
//   window.p86TagIcons.catalog()           → built-in entries (report legend)
//   window.p86TagIcons.ICON_CHOICES        → agx-icon names for the picker

(function() {
  'use strict';

  if (window.p86TagIcons) return;

  // ── Built-in catalog ────────────────────────────────────────────
  // match[] entries are tested as substrings against the normalized
  // (lowercase, dash-joined) tag, so 'before-photo' → 'before' and
  // 'roof-tear-off' → 'roof'. icon is an agx-icons.js name (white glyph)
  // when one reads well at pin size; glyph is the always-present text
  // fallback. Order = priority (first match wins).
  var CATALOG = [
    // ── Phase / status ──────────────────────────────────────────
    { match: ['complete', 'done', 'finished', 'final'],  bg: '#10b981', fg: '#fff', icon: 'check-circle', glyph: '✓' },
    { match: ['progress', 'in-progress', 'wip', 'ongoing'], bg: '#f59e0b', fg: '#fff', icon: 'refresh', glyph: '◐' },
    { match: ['pending', 'todo', 'planned', 'scheduled'], bg: '#6b7280', fg: '#fff', icon: 'schedule', glyph: '⋯' },
    { match: ['before', 'existing', 'pre'],              bg: '#3b82f6', fg: '#fff', glyph: 'B' },
    { match: ['after'],                                   bg: '#06b6d4', fg: '#fff', glyph: 'A' },
    { match: ['walkthrough', 'walk-through', 'tour', 'site-visit'], bg: '#8b5cf6', fg: '#fff', icon: 'workspace', glyph: '⊕' },
    { match: ['punch', 'punchlist', 'punch-list'],       bg: '#fb923c', fg: '#fff', icon: 'check-circle', glyph: 'Pu' },
    { match: ['inspection', 'inspect'],                  bg: '#9333ea', fg: '#fff', icon: 'magnifying-glass', glyph: '⌕' },
    { match: ['rfi', 'question'],                         bg: '#eab308', fg: '#000', icon: 'conversations', glyph: '?' },
    { match: ['safety', 'hazard', 'osha'],               bg: '#dc2626', fg: '#fff', icon: 'detective', glyph: 'Sf' },
    { match: ['permit', 'approval', 'signoff', 'sign-off'], bg: '#2563eb', fg: '#fff', icon: 'id-card', glyph: 'Pm' },

    // ── Issues ──────────────────────────────────────────────────
    { match: ['damage', 'damaged', 'broken'],            bg: '#ef4444', fg: '#fff', icon: 'bell-alert', glyph: '!' },
    { match: ['deficiency', 'defect', 'issue', 'problem'], bg: '#dc2626', fg: '#fff', icon: 'bell-alert', glyph: '!' },
    { match: ['leak', 'water', 'moisture'],              bg: '#0ea5e9', fg: '#fff', glyph: '~' },
    { match: ['mold', 'mildew'],                          bg: '#65a30d', fg: '#fff', glyph: 'Mo' },
    { match: ['rot', 'rotten', 'decay'],                 bg: '#78350f', fg: '#fff', glyph: 'Rt' },

    // ── Trades / scopes ─────────────────────────────────────────
    { match: ['roof', 'roofing', 'shingle', 'tear-off'], bg: '#92400e', fg: '#fff', icon: 'buildings', glyph: '⌂' },
    { match: ['framing', 'frame', 'stud', 'rough'],      bg: '#b45309', fg: '#fff', icon: 'buildings', glyph: 'Fr' },
    { match: ['foundation', 'footing', 'slab'],          bg: '#44403c', fg: '#fff', icon: 'cube', glyph: 'Fn' },
    { match: ['concrete', 'driveway', 'sidewalk', 'flatwork'], bg: '#71717a', fg: '#fff', icon: 'cube', glyph: 'C' },
    { match: ['masonry', 'brick', 'block', 'cmu'],       bg: '#9a3412', fg: '#fff', icon: 'cube', glyph: 'Br' },
    { match: ['stucco', 'plaster'],                       bg: '#a8a29e', fg: '#fff', glyph: 'Su' },
    { match: ['electric', 'electrical', 'wiring', 'panel'], bg: '#eab308', fg: '#000', icon: 'sparkle', glyph: 'E' },
    { match: ['plumb', 'plumbing', 'pipe', 'drain'],     bg: '#0369a1', fg: '#fff', icon: 'wrench', glyph: 'Pl' },
    { match: ['hvac', 'mechanical', 'ductwork', 'duct', 'ac', 'air'], bg: '#0d9488', fg: '#fff', icon: 'cpu-chip', glyph: 'Hv' },
    { match: ['insulation', 'insulate'],                 bg: '#db2777', fg: '#fff', glyph: 'In' },
    { match: ['drywall', 'sheetrock', 'gypsum'],         bg: '#9ca3af', fg: '#fff', glyph: 'Dw' },
    { match: ['paint', 'painting', 'primer'],            bg: '#ec4899', fg: '#fff', icon: 'edit', glyph: 'Pt' },
    { match: ['floor', 'flooring', 'hardwood', 'lvp', 'laminate'], bg: '#7c2d12', fg: '#fff', icon: 'cube', glyph: 'Fl' },
    { match: ['tile', 'tiling', 'grout'],                bg: '#475569', fg: '#fff', icon: 'cube', glyph: 'Ti' },
    { match: ['cabinet', 'cabinetry', 'millwork'],       bg: '#854d0e', fg: '#fff', icon: 'materials', glyph: 'Cb' },
    { match: ['counter', 'countertop', 'granite', 'quartz'], bg: '#57534e', fg: '#fff', glyph: 'Ct' },
    { match: ['trim', 'fascia', 'soffit', 'molding', 'baseboard'], bg: '#c2410c', fg: '#fff', glyph: 'Tr' },
    { match: ['siding', 'cladding'],                      bg: '#a16207', fg: '#fff', glyph: 'Sd' },
    { match: ['gutter', 'downspout'],                     bg: '#9ca3af', fg: '#fff', glyph: 'G' },
    { match: ['window'],                                  bg: '#0284c7', fg: '#fff', icon: 'workspace', glyph: '▢' },
    { match: ['door', 'entry'],                           bg: '#1e40af', fg: '#fff', glyph: 'Dr' },
    { match: ['deck', 'porch', 'patio'],                  bg: '#92400e', fg: '#fff', glyph: 'Dk' },
    { match: ['stair', 'stairs', 'railing'],             bg: '#7c3aed', fg: '#fff', glyph: 'St' },
    { match: ['fence', 'fencing', 'gate'],               bg: '#854d0e', fg: '#fff', glyph: 'Fe' },
    { match: ['landscape', 'landscaping', 'sod', 'mulch', 'plant'], bg: '#16a34a', fg: '#fff', glyph: '✿' },
    { match: ['grading', 'excavation', 'dirt', 'site-work', 'sitework'], bg: '#65491f', fg: '#fff', glyph: 'Ex' },
    { match: ['demo', 'demolition', 'teardown'],         bg: '#b91c1c', fg: '#fff', icon: 'delete', glyph: '✕' },
    { match: ['pool', 'spa'],                             bg: '#0891b2', fg: '#fff', glyph: 'Po' },
    { match: ['pressure-wash', 'pressure', 'wash', 'clean'], bg: '#0891b2', fg: '#fff', glyph: 'W' },
    { match: ['stain', 'staining', 'seal'],              bg: '#7c2d12', fg: '#fff', glyph: 'Sn' },
    { match: ['waterproof', 'membrane', 'flashing'],     bg: '#0e7490', fg: '#fff', glyph: 'Wp' },

    // ── Logistics / docs ────────────────────────────────────────
    { match: ['delivery', 'material', 'materials', 'lumber'], bg: '#a16207', fg: '#fff', icon: 'materials', glyph: 'Dl' },
    { match: ['equipment', 'machinery', 'tool'],         bg: '#52525b', fg: '#fff', icon: 'cube', glyph: 'Eq' },
    { match: ['measurement', 'measure', 'takeoff'],      bg: '#7c3aed', fg: '#fff', icon: 'target', glyph: '↔' },
    { match: ['receipt', 'invoice', 'cost'],             bg: '#475569', fg: '#fff', icon: 'banknotes', glyph: '$' },
    { match: ['proposal', 'estimate', 'bid'],            bg: '#0f766e', fg: '#fff', icon: 'exports', glyph: 'Pr' },
    { match: ['change-order', 'change', 'co'],           bg: '#d97706', fg: '#fff', glyph: 'CO' }
  ];

  var DEFAULT_ICON = { bg: '#6b7280', fg: '#fff', glyph: '●', icon: null };

  // agx-icons names offered in the Tag Catalog per-tag picker (the same
  // P86 set the entity pins draw from). Curated to ones that read at pin
  // size. '' = "no icon (use the tag's letter glyph)".
  var ICON_CHOICES = [
    '', 'buildings', 'wrench', 'cube', 'materials', 'sparkle', 'cpu-chip',
    'edit', 'workspace', 'check-circle', 'magnifying-glass', 'detective',
    'bell-alert', 'banknotes', 'target', 'schedule', 'refresh', 'delete',
    'exports', 'conversations', 'id-card', 'photos', 'folder', 'links',
    'leads', 'briefcase', 'phases', 'node-graph', 'scale', 'globe'
  ];

  // Org per-tag overrides: normalized name → { hue:int|null, icon:str|null }.
  // null = not yet loaded → callers use the built-in catalog only.
  var _orgMap = null;
  var _loadPromise = null;

  function normalize(s) {
    return String(s || '').toLowerCase().replace(/[\s_]+/g, '-');
  }

  function escXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // hue (0-360) → hex, fixed saturation/lightness tuned for white glyphs.
  function hueToHex(h) {
    var s = 0.62, l = 0.45;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = (((h % 360) + 360) % 360) / 60;
    var x = c * (1 - Math.abs(hp % 2 - 1));
    var r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    var m = l - c / 2;
    function hx(v) { return ('0' + Math.round((v + m) * 255).toString(16)).slice(-2); }
    return '#' + hx(r) + hx(g) + hx(b);
  }

  function matchBaked(norm) {
    for (var i = 0; i < CATALOG.length; i++) {
      var entry = CATALOG[i];
      for (var j = 0; j < entry.match.length; j++) {
        if (norm.indexOf(entry.match[j]) !== -1) return entry;
      }
    }
    return null;
  }

  function forTag(tag) {
    if (!tag) return DEFAULT_ICON;
    var norm = normalize(tag);
    var org = _orgMap && _orgMap[norm];
    var baked = matchBaked(norm);
    // Color: org hue wins, else baked color, else default gray.
    var bg = (org && org.hue != null) ? hueToHex(org.hue)
           : (baked && baked.bg) ? baked.bg : DEFAULT_ICON.bg;
    // Icon: org icon wins, else baked icon (may be null).
    var icon = (org && org.icon) ? org.icon : (baked && baked.icon) || null;
    // Text glyph fallback: baked glyph, else default dot.
    var glyph = (baked && baked.glyph) ? baked.glyph : DEFAULT_ICON.glyph;
    return { bg: bg, fg: '#fff', glyph: glyph, icon: icon };
  }

  function forPhoto(photo) {
    if (!photo) return DEFAULT_ICON;
    var tags = photo.tags;
    if (!Array.isArray(tags) || !tags.length) return DEFAULT_ICON;
    return forTag(tags[0]);
  }

  // SVG inner markup for a pin glyph centered at (cx, cy). White P86 icon
  // when spec.icon resolves via window.p86Icon; else the text glyph.
  function glyphMarkup(spec, cx, cy, size) {
    if (spec && spec.icon && typeof window.p86Icon === 'function') {
      var g = window.p86Icon(spec.icon);
      if (g) {
        var x = cx - size / 2, y = cy - size / 2;
        return g
          .replace('<svg ', '<svg x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" ')
          .replace(/currentColor/g, (spec.fg || '#fff'));
      }
    }
    var glyph = spec && spec.glyph;
    if (!glyph) return '';
    return '<text x="' + cx + '" y="' + (cy + size * 0.34) + '" text-anchor="middle" ' +
      'font-size="' + Math.round(size * 0.82) + '" font-family="Arial,sans-serif" font-weight="bold" ' +
      'fill="' + (spec.fg || '#fff') + '">' + escXml(glyph) + '</text>';
  }

  // Convenience: a full circle pin SVG string (used where a renderer
  // wants the whole marker rather than just the glyph).
  function pinSvg(spec, opts) {
    opts = opts || {};
    var sz = opts.size || 28;
    var c = sz / 2;
    var r = c - (opts.stroke || 2.5);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + sz + '" height="' + sz + '" viewBox="0 0 ' + sz + ' ' + sz + '">' +
      '<defs><filter id="tps" x="-30%" y="-30%" width="160%" height="160%">' +
        '<feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-opacity="0.4"/>' +
      '</filter></defs>' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="' + (spec.bg || DEFAULT_ICON.bg) + '" stroke="#fff" stroke-width="' + (opts.stroke || 2.5) + '" filter="url(#tps)"/>' +
      glyphMarkup(spec, c, c, Math.round(sz * 0.55)) +
    '</svg>';
  }

  // Load the org's per-tag config once. Reads the all-users-readable tag
  // list (GET /api/org-tags) and builds the normalized name → {hue,icon}
  // lookup. Always resolves (a failed load just leaves the catalog as-is).
  function ensureConfig() {
    if (_orgMap !== null) return Promise.resolve();
    if (_loadPromise) return _loadPromise;
    var fetchTags;
    if (window.p86Api && typeof window.p86Api.get === 'function') {
      fetchTags = window.p86Api.get('/api/org-tags?include_archived=1');
    } else {
      var tok = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) ||
                (function () { try { return localStorage.getItem('p86-auth-token'); } catch (e) { return ''; } })();
      fetchTags = fetch('/api/org-tags?include_archived=1', {
        headers: tok ? { Authorization: 'Bearer ' + tok } : {},
        credentials: 'same-origin'
      }).then(function (r) { return r.ok ? r.json() : { tags: [] }; });
    }
    _loadPromise = fetchTags.then(function (resp) {
      var map = {};
      ((resp && resp.tags) || []).forEach(function (t) {
        if (!t || !t.name) return;
        map[normalize(t.name)] = { hue: (t.hue == null ? null : Number(t.hue)), icon: (t.icon || null) };
      });
      _orgMap = map;
    }).catch(function () { _orgMap = {}; });
    return _loadPromise;
  }

  // Replace the cached config (admin Tag Catalog save) so open maps pick
  // up new colors/icons without a reload. `tags` is the list of org-tag
  // rows ({name, hue, icon}).
  function setConfig(tags) {
    var map = {};
    (tags || []).forEach(function (t) {
      if (!t || !t.name) return;
      map[normalize(t.name)] = { hue: (t.hue == null ? null : Number(t.hue)), icon: (t.icon || null) };
    });
    _orgMap = map;
    _loadPromise = Promise.resolve();
  }

  // Built-in entries — used by the Report photo-map section's legend.
  function catalog() {
    return CATALOG.map(function(e) {
      return { tags: e.match.slice(), bg: e.bg, fg: e.fg, glyph: e.glyph, icon: e.icon || null };
    });
  }

  window.p86TagIcons = {
    forTag: forTag,
    forPhoto: forPhoto,
    glyphMarkup: glyphMarkup,
    pinSvg: pinSvg,
    ensureConfig: ensureConfig,
    setConfig: setConfig,
    catalog: catalog,
    hueToHex: hueToHex,
    ICON_CHOICES: ICON_CHOICES,
    DEFAULT: DEFAULT_ICON
  };
})();
