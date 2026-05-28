// Tag → icon registry for photo map pins.
//
// Each photo on the entity map renders as a colored pin with a glyph
// driven by the photo's PRIMARY tag (first tag in the photo's tags
// array). Unknown tags fall back to a neutral gray dot.
//
// The icon spec is a plain object the renderer translates into a
// Google Maps custom marker:
//   {
//     bg:    '#hex',      // pin background fill
//     fg:    '#hex',      // glyph color
//     glyph: 'string'      // 1-2 char glyph (emoji or ascii)
//   }
//
// Public surface:
//   window.p86TagIcons.forTag(tagString)
//     Returns an icon spec for a single tag (or the default for null).
//   window.p86TagIcons.forPhoto(photoAttachmentRow)
//     Reads photo.tags[] and returns the spec for the first tag.
//
// The catalog mirrors the most-used construction tag names in the
// existing org_tags table. Adding a new mapping = add a row here.
// Eventually this could be DB-driven so each org picks their own
// colors, but for now the JS-baked catalog is plenty.

(function() {
  'use strict';

  if (window.p86TagIcons) return;

  // ── Catalog ─────────────────────────────────────────────────────
  // Order matters for normalization — keys are matched as substrings
  // after lowercase + dash-strip, so 'before-photo' → 'before' and
  // 'damage-assessment' → 'damage'.
  var CATALOG = [
    // Status — green / red / yellow
    { match: ['complete', 'done', 'finished'],          bg: '#10b981', fg: '#fff', glyph: '✓' },
    { match: ['progress', 'in-progress', 'wip'],        bg: '#f59e0b', fg: '#fff', glyph: '⚙' },
    { match: ['pending', 'todo', 'planned'],            bg: '#6b7280', fg: '#fff', glyph: '⋯' },

    // Before / After / Walkthrough
    { match: ['before'],                                 bg: '#3b82f6', fg: '#fff', glyph: 'B' },
    { match: ['after'],                                  bg: '#06b6d4', fg: '#fff', glyph: 'A' },
    { match: ['walkthrough', 'walk-through', 'tour'],   bg: '#8b5cf6', fg: '#fff', glyph: '⊕' },

    // Issues — red family
    { match: ['damage', 'damaged'],                      bg: '#ef4444', fg: '#fff', glyph: '!' },
    { match: ['deficiency', 'defect', 'issue'],          bg: '#dc2626', fg: '#fff', glyph: '!' },
    { match: ['leak', 'water'],                          bg: '#0ea5e9', fg: '#fff', glyph: '~' },
    { match: ['mold'],                                   bg: '#65a30d', fg: '#fff', glyph: 'M' },

    // Surfaces / building parts
    { match: ['roof', 'roofing'],                        bg: '#92400e', fg: '#fff', glyph: '⌂' },
    { match: ['gutter'],                                 bg: '#9ca3af', fg: '#fff', glyph: 'G' },
    { match: ['siding'],                                 bg: '#a16207', fg: '#fff', glyph: 'S' },
    { match: ['fascia', 'soffit', 'trim'],               bg: '#b45309', fg: '#fff', glyph: 'T' },
    { match: ['window'],                                 bg: '#0284c7', fg: '#fff', glyph: '▢' },
    { match: ['door'],                                   bg: '#1e40af', fg: '#fff', glyph: 'D' },
    { match: ['paint', 'painting'],                      bg: '#ec4899', fg: '#fff', glyph: '🖌' },
    { match: ['pressure-wash', 'pressure', 'wash'],     bg: '#0891b2', fg: '#fff', glyph: 'P' },
    { match: ['stain'],                                  bg: '#7c2d12', fg: '#fff', glyph: 'St' },
    { match: ['concrete', 'driveway'],                   bg: '#71717a', fg: '#fff', glyph: 'C' },
    { match: ['fence'],                                  bg: '#854d0e', fg: '#fff', glyph: 'F' },
    { match: ['landscape', 'landscaping'],               bg: '#16a34a', fg: '#fff', glyph: '✿' },

    // Documentation
    { match: ['measurement', 'measure'],                 bg: '#7c3aed', fg: '#fff', glyph: '↔' },
    { match: ['receipt', 'invoice'],                     bg: '#475569', fg: '#fff', glyph: '$' },
    { match: ['proposal'],                               bg: '#0f766e', fg: '#fff', glyph: 'P' },
    { match: ['inspection'],                             bg: '#9333ea', fg: '#fff', glyph: '⌕' }
  ];

  var DEFAULT_ICON = { bg: '#6b7280', fg: '#fff', glyph: '●' };

  function normalize(s) {
    return String(s || '').toLowerCase().replace(/[\s_]+/g, '-');
  }

  function forTag(tag) {
    if (!tag) return DEFAULT_ICON;
    var n = normalize(tag);
    for (var i = 0; i < CATALOG.length; i++) {
      var entry = CATALOG[i];
      for (var j = 0; j < entry.match.length; j++) {
        if (n.indexOf(entry.match[j]) !== -1) return entry;
      }
    }
    return DEFAULT_ICON;
  }

  function forPhoto(photo) {
    if (!photo) return DEFAULT_ICON;
    var tags = photo.tags;
    if (!Array.isArray(tags) || !tags.length) return DEFAULT_ICON;
    return forTag(tags[0]);
  }

  // List of every mapping — used by the Report photo-map section's
  // legend so the printout can show what each color means.
  function catalog() {
    return CATALOG.map(function(e) {
      return { tags: e.match.slice(), bg: e.bg, fg: e.fg, glyph: e.glyph };
    });
  }

  window.p86TagIcons = {
    forTag: forTag,
    forPhoto: forPhoto,
    catalog: catalog,
    DEFAULT: DEFAULT_ICON
  };
})();
