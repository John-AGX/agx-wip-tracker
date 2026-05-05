// Generates js/agx-icons.js from the locked Phosphor/Heroicons SVGs.
// Run: node scripts/build-agx-icons.js
//
// Produces a single file with all 24 AGX icons inlined as JS strings,
// plus a window.agxIcon(name, opts) helper. Heroicons (24/outline)
// strokes are slimmed from 1.5 → 1.2 to match Phosphor Light's
// lighter line ratio per the locked AGX style.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'assets', 'icons', 'agx');
const OUT = path.join(ROOT, 'js', 'agx-icons.js');

// concept name → "library/filename" (no .svg)
const MAP = {
  'composer-attach': 'phosphor/paperclip-light',
  'composer-camera': 'heroicons/camera',
  'composer-mic':    'heroicons/microphone',
  'composer-send':   'heroicons/paper-airplane',
  'wip':             'heroicons/clipboard-document-list',
  'schedule':        'heroicons/calendar-days',
  'insights':        'phosphor/chart-line-up-light',
  'admin':           'heroicons/shield-check',
  'estimates':       'heroicons/document-currency-dollar',
  'leads':           'phosphor/funnel-light',
  'clients':         'phosphor/users-light',
  'subs':            'heroicons/wrench-screwdriver',
  'materials':       'phosphor/package-light',
  'phases':          'heroicons/squares-plus',
  'buildings':       'phosphor/buildings-light',
  'photos':          'heroicons/photo',
  'daily-logs':      'heroicons/clipboard-document-check',
  'attachments':     'phosphor/paperclip-light',
  'workspace':       'heroicons/table-cells',
  'node-graph':      'phosphor/graph-light',
  'links':           'phosphor/link-light',
  'exports':         'heroicons/document-arrow-up',
  'plan-mode':       'phosphor/blueprint-light',
  'build-mode':      'phosphor/hammer-light'
};

const HEADER = `// AGX Icon Helper — inline SVG icons (auto-generated).
//
// 24 icons sourced from Phosphor (MIT) and Heroicons (MIT). Each
// retains stroke="currentColor" so CSS color rules tint them; CSS
// sizing via .agx-icon { width: 1em; height: 1em } makes icons scale
// to the parent's font-size automatically. Heroicons strokes are
// slimmed from 1.5 → 1.2 to match Phosphor Light's lighter line ratio
// per the locked AGX style.
//
// API:
//   agxIcon(name)                  → SVG markup string
//   agxIcon(name, { size: 18 })    → SVG with explicit width/height
//   agxIcon(name, { class: 'x' })  → SVG with extra class
//
// Phosphor:  https://phosphoricons.com (MIT, see assets/icons/agx/phosphor/PHOSPHOR-LICENSE.txt)
// Heroicons: https://heroicons.com    (MIT, see assets/icons/agx/heroicons/HEROICONS-LICENSE.txt)
//
// To regenerate after picking new icons: node scripts/build-agx-icons.js

(function () {
  'use strict';
  var icons = {};
`;

const FOOTER = `
  /**
   * Returns an inline SVG markup string for the given AGX icon name.
   * Adds class="agx-icon" by default; CSS sizes it to 1em × 1em.
   */
  function agxIcon(name, opts) {
    opts = opts || {};
    var svg = icons[name];
    if (!svg) {
      console.warn('[agxIcon] unknown icon:', name);
      return '';
    }
    var attrs = '';
    if (opts.size != null) {
      attrs += ' width="' + opts.size + '" height="' + opts.size + '"';
    }
    var cls = 'agx-icon' + (opts.class ? ' ' + opts.class : '');
    attrs += ' class="' + cls + '"';
    return svg.replace(/<svg /, '<svg' + attrs + ' ');
  }

  /**
   * Auto-decorate any element marked data-agx-icon="<name>" by
   * prepending the icon's SVG. Idempotent — sets data-agx-icon-decorated
   * once applied. A MutationObserver re-scans for new nodes so
   * decoration survives dynamic re-renders (modals rebuilt via
   * innerHTML, etc.).
   */
  function decorate(el) {
    if (!el || el.dataset.agxIconDecorated === '1') return;
    var name = el.dataset.agxIcon;
    if (!name || !icons[name]) return;
    el.dataset.agxIconDecorated = '1';
    var slot = document.createElement('span');
    slot.className = 'agx-icon-slot';
    slot.innerHTML = agxIcon(name);
    el.insertBefore(slot, el.firstChild);
  }
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-agx-icon]:not([data-agx-icon-decorated])').forEach(decorate);
  }
  function boot() {
    scan(document);
    var mo = new MutationObserver(function (records) {
      records.forEach(function (r) {
        r.addedNodes.forEach(function (n) { if (n.nodeType === 1) scan(n); });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.AGX_ICONS = icons;
  window.agxIcon = agxIcon;
  window.agxIconDecorate = scan;
})();
`;

let out = HEADER;
for (const [name, rel] of Object.entries(MAP)) {
  const [lib, file] = rel.split('/');
  const src = path.join(ICONS_DIR, lib, file + '.svg');
  let svg = fs.readFileSync(src, 'utf8');
  // Slim Heroicons strokes (1.5 → 1.2) to match Phosphor's lighter weight.
  if (lib === 'heroicons') {
    svg = svg.replace(/stroke-width="1\.5"/g, 'stroke-width="1.2"');
  }
  // Collapse to a single line so the JS file stays compact.
  svg = svg.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
  // JSON.stringify gives us a JS-safe quoted string with all escapes handled.
  out += '  icons[' + JSON.stringify(name) + '] = ' + JSON.stringify(svg) + ';\n';
}
out += FOOTER;

fs.writeFileSync(OUT, out, 'utf8');
console.log('wrote ' + OUT + ' (' + out.length + ' bytes, ' + Object.keys(MAP).length + ' icons)');
