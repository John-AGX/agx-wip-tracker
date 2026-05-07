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
  'build-mode':      'phosphor/hammer-light',
  // Action / utility icons (added later — defaults from user audit)
  'delete':          'heroicons/trash',
  'edit':            'heroicons/pencil-square',
  'save':            'phosphor/floppy-disk-light',
  'add':             'phosphor/plus-circle-light',
  'refresh':         'heroicons/arrow-path',
  'sparkle':         'heroicons/sparkles',
  'reset':           'phosphor/arrow-counter-clockwise-light',
  'restore':         'heroicons/arrow-uturn-left',
  'target':          'heroicons/viewfinder-circle',
  'fullscreen':      'heroicons/arrows-pointing-out',
  'collapse':        'heroicons/chevron-double-up',
  'expand':          'heroicons/chevron-double-down',
  // Project 86 — agent + admin sub-tab icons. Swapped in for the
  // various emoji glyphs that were rendering in the AI panel headers
  // and the Admin → Agents sub-tab strip. Phosphor + Heroicons mix
  // matches the existing AGX line ratio.
  'briefcase':       'heroicons/briefcase',           // Chief of Staff (executive)
  'conversations':   'heroicons/chat-bubble-left-right', // admin Conversations tab
  'beaker':          'heroicons/beaker',               // admin Evals tab
  'academic-cap':    'heroicons/academic-cap',         // admin Skills tab
  'magnifying-glass':'heroicons/magnifying-glass',     // admin Prompt Preview tab — uses existing source if present, else falls back to command-line below
  'command-line':    'heroicons/command-line',         // alt for prompt preview / terminal
  'globe':           'heroicons/globe-alt',            // admin Anthropic tab
  'cube':            'heroicons/cube',                 // admin Batch tab
  'chart-bar':       'heroicons/chart-bar',            // admin Metrics tab
  'chart-pie':       'heroicons/chart-pie',
  'funnel':          'heroicons/funnel',
  'presentation-chart': 'heroicons/presentation-chart-line',
  // Header right-cluster icons (notifications + light/dark toggle).
  // These were added directly to the generated agx-icons.js earlier
  // and got dropped on a rebuild. Now sourced through the MAP so a
  // future rebuild keeps them.
  'bell':            'heroicons/bell',
  'bell-alert':      'heroicons/bell-alert',
  'sun':             'heroicons/sun',
  'moon':            'heroicons/moon',
  // Admin sub-tab icons added in the icon-audit pass:
  //  - cpu-chip → "Agents" (AI / processors); replaces 🤖
  //  - envelope → "Email" (was using `links` as a placeholder)
  'cpu-chip':        'heroicons/cpu-chip',
  'envelope':        'heroicons/envelope'
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

  // ── Emoji → AGX icon swapper ─────────────────────────────────
  // Maps emoji characters (as rendered in the DOM, after HTML entity
  // decoding) to AGX icon concept names. Two passes per pass:
  //   1. Icon-only elements (textContent is just the emoji, possibly
  //      with a U+FE0F variation selector) — swap innerHTML with SVG.
  //   2. Leading-emoji elements (innerHTML starts with emoji + space
  //      + label) — set data-agx-icon and let decorate() prepend.
  // Skipped on elements already swapped (data-agx-emoji-swapped=1) or
  // already decorated (data-agx-icon-decorated=1). The MutationObserver
  // re-runs the swap on dynamically rendered buttons (WIP list rows,
  // modal headers, node graph topbar, etc.).
  var EMOJI_ICONS = {
    '🗑': 'delete',     // 1F5D1 wastebasket
    '✏':       'edit',        // 270F  pencil
    '📝': 'edit',        // 1F4DD memo (used as "edit" in WIP)
    '💾': 'save',        // 1F4BE floppy disk
    '➕':       'add',         // 2795  heavy plus
    '🔄': 'refresh',     // 1F504 anti-clockwise sync
    '✨':       'sparkle',     // 2728  sparkles
    '♻':       'reset',       // 267B  recycling
    '↺':       'restore',     // 21BA  anticlockwise open circle
    '🎯': 'target',      // 1F3AF direct hit (Agent 47 estimating)
    '⛶':       'fullscreen',  // 26F6  square four corners
    '🗖': 'fullscreen',  // 1F5D6 maximize alt
    '📁': 'collapse',    // 1F4C1 file folder closed
    '📂': 'expand',      // 1F4C2 file folder open
    // Node-graph node types — visible inside .ng-ribbon-icon spans
    // and other contexts where the engine renders a type icon.
    '🏗': 'buildings',   // 1F3D7 building construction (t1)
    '📋': 'wip',         // 1F4CB clipboard (t2)
    '👷': 'subs',        // 1F477 construction worker
    '📄': 'attachments', // 1F4C4 page facing up (po)
    // Project 86 — agent header + admin sub-tab swaps. Replaces the
    // emoji glyphs in the AI panel title (Agent 47 / 86 / HR / Intake
    // / CoS) and the Admin → Agents sub-tab strip (Metrics /
    // Conversations / Evals / Skills / Prompt Preview / Batch /
    // Anthropic).
    '📊': 'chart-bar',         // 1F4CA bar chart (86 analyst, Metrics tab)
    '🤝': 'clients',           // 1F91D handshake (HR — reuses two-people glyph)
    '🧲': 'funnel',            // 1F9F2 magnet (Intake — funnel concept)
    '🎩': 'briefcase',         // 1F3A9 top hat (CoS executive)
    '💬': 'conversations',     // 1F4AC speech balloon
    '🧪': 'beaker',            // 1F9EA test tube (Evals)
    '🧠': 'academic-cap',      // 1F9E0 brain (Skills)
    '🍡': 'academic-cap',      // 1F361 dango — UI alias for Skills
    '🔍': 'magnifying-glass',  // 1F50D magnifier (Prompt Preview)
    '📦': 'cube',              // 1F4E6 package (Batch jobs)
    '🌐': 'globe',             // 1F310 globe with meridians (Anthropic)
    '🤖': 'cpu-chip',          // 1F916 robot face — admin Agents tab
    '✉':       'envelope',     // 2709  envelope (light variant)
    '📧': 'envelope',          // 1F4E7 e-mail symbol
    '📨': 'envelope'           // 1F4E8 incoming envelope
  };
  // Match an emoji at start of string with optional U+FE0F + whitespace.
  function matchLeadingEmoji(text) {
    var t = (text || '').replace(/^\s+/, '');
    var keys = Object.keys(EMOJI_ICONS);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (t.indexOf(k) === 0) {
        return { emoji: k, concept: EMOJI_ICONS[k], rest: t.slice(k.length).replace(/^️/, '').replace(/^\s+/, '') };
      }
    }
    return null;
  }
  // Strip U+FE0F + whitespace; return the bare text content.
  function strippedText(el) {
    var t = (el.textContent || '').replace(/️/g, '').replace(/\s+/g, '');
    return t;
  }
  function emojiSwap(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.dataset.agxEmojiSwapped === '1' || el.dataset.agxIconDecorated === '1' || el.dataset.agxIcon) return;
    if (!el.children) return;
    // Case 1: icon-only element (textContent is just one mapped emoji).
    var bare = strippedText(el);
    if (bare && EMOJI_ICONS[bare]) {
      el.dataset.agxEmojiSwapped = '1';
      el.innerHTML = agxIcon(EMOJI_ICONS[bare]);
      return;
    }
    // Case 2: leading emoji + " Label" pattern. Only swap when the
    // first child is a text node (not a structured layout) so we
    // don't blow away nested buttons / inputs.
    var first = el.firstChild;
    if (first && first.nodeType === 3 /* TEXT_NODE */) {
      var match = matchLeadingEmoji(first.nodeValue);
      if (match) {
        el.dataset.agxEmojiSwapped = '1';
        first.nodeValue = (match.rest ? ' ' + match.rest : '');
        el.dataset.agxIcon = match.concept;
        decorate(el);
      }
    }
  }
  function scanEmoji(root) {
    if (!root || !root.querySelectorAll) return;
    // Buttons + node-graph icon spans + ribbon icons cover the main hit list.
    var sel = 'button, .ng-ribbon-icon, .ng-tbtn, .ee-btn, .ee-icon-btn';
    root.querySelectorAll(sel).forEach(emojiSwap);
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-agx-icon]:not([data-agx-icon-decorated])').forEach(decorate);
    scanEmoji(root);
  }
  function boot() {
    scan(document);
    scanEmoji(document);
    var mo = new MutationObserver(function (records) {
      records.forEach(function (r) {
        r.addedNodes.forEach(function (n) {
          if (n.nodeType === 1) { scan(n); scanEmoji(n); }
        });
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
