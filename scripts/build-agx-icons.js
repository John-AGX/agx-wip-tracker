// Generates js/agx-icons.js from the locked Phosphor/Heroicons SVGs.
// Run: node scripts/build-agx-icons.js
//
// Produces a single file with all 24 AGX icons inlined as JS strings,
// plus a window.p86Icon(name, opts) helper. Heroicons (24/outline)
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
  'discord':         'phosphor/discord-fill',
  'graph':           'phosphor/graph-bold',           // Workspace tab — Phosphor bold network graph
  'envelope':        'heroicons/envelope',
  // Node-library specific icons (sidebar inside the Job → Workspace
  // node graph). Maps the emoji glyphs in nodegraph/engine.js DEFS to
  // the corresponding Heroicons. The node-library auto-swapper picks
  // these up via EMOJI_ICONS below.
  'wrench':          'heroicons/wrench',
  'banknotes':       'heroicons/banknotes',
  'scale':           'heroicons/scale',
  'bookmark':        'heroicons/bookmark',
  // Agent identity icons (AI panel header). 47 → detective bowtie,
  // 86 → DNA helix. Phosphor bold weight to read at small sizes
  // against the dark cyan-tinted panel header background.
  'detective':       'phosphor/detective-bold',
  'dna':             'phosphor/dna-bold',
  // Folder glyph for the My Files header button.
  'folder':          'heroicons/folder',
  // Weather glyph set for the schedule day-cell + entry-bar + header
  // chips. Phosphor light line weight matches the rest of the AGX
  // icon system; "wx-" prefix scopes them so weather lookups don't
  // collide with future "cloud" / "sun" / "warning" usage in non-
  // weather contexts. Mapped to the schedule's three risk levels +
  // a few specific conditions:
  //   wx-sun           sunny, clear
  //   wx-cloud-sun     partly cloudy / mixed
  //   wx-cloud         overcast / mostly cloudy
  //   wx-cloud-rain    showers / rain
  //   wx-cloud-lightning thunderstorms
  //   wx-cloud-snow    snow / sleet
  //   wx-cloud-fog     fog / mist / haze
  //   wx-cloud-warning severe / advisory / "warning"-labeled forecasts
  'wx-sun':            'phosphor/sun-light',
  'wx-cloud-sun':      'phosphor/cloud-sun-light',
  'wx-cloud':          'phosphor/cloud-light',
  'wx-cloud-rain':     'phosphor/cloud-rain-light',
  'wx-cloud-lightning':'phosphor/cloud-lightning-light',
  'wx-cloud-snow':     'phosphor/cloud-snow-light',
  'wx-cloud-fog':      'phosphor/cloud-fog-light',
  'wx-cloud-warning':  'phosphor/cloud-warning-light'
};

const HEADER = `// AGX Icon Helper — inline SVG icons (auto-generated).
//
// 24 icons sourced from Phosphor (MIT) and Heroicons (MIT). Each
// retains stroke="currentColor" so CSS color rules tint them; CSS
// sizing via .p86-icon { width: 1em; height: 1em } makes icons scale
// to the parent's font-size automatically. Heroicons strokes are
// slimmed from 1.5 → 1.2 to match Phosphor Light's lighter line ratio
// per the locked AGX style.
//
// API:
//   p86Icon(name)                  → SVG markup string
//   p86Icon(name, { size: 18 })    → SVG with explicit width/height
//   p86Icon(name, { class: 'x' })  → SVG with extra class
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
   * Adds class="p86-icon" by default; CSS sizes it to 1em × 1em.
   */
  function p86Icon(name, opts) {
    opts = opts || {};
    var svg = icons[name];
    if (!svg) {
      console.warn('[p86Icon] unknown icon:', name);
      return '';
    }
    var attrs = '';
    if (opts.size != null) {
      attrs += ' width="' + opts.size + '" height="' + opts.size + '"';
    }
    var cls = 'p86-icon' + (opts.class ? ' ' + opts.class : '');
    attrs += ' class="' + cls + '"';
    return svg.replace(/<svg /, '<svg' + attrs + ' ');
  }

  /**
   * Auto-decorate any element marked data-p86-icon="<name>" by
   * prepending the icon's SVG. Idempotent — sets data-p86-icon-decorated
   * once applied. A MutationObserver re-scans for new nodes so
   * decoration survives dynamic re-renders (modals rebuilt via
   * innerHTML, etc.).
   */
  function decorate(el) {
    if (!el || el.dataset.p86IconDecorated === '1') return;
    var name = el.dataset.p86Icon;
    if (!name || !icons[name]) return;
    el.dataset.p86IconDecorated = '1';
    var slot = document.createElement('span');
    slot.className = 'p86-icon-slot';
    slot.innerHTML = p86Icon(name);
    el.insertBefore(slot, el.firstChild);
  }

  // ── Emoji → AGX icon swapper ─────────────────────────────────
  // Maps emoji characters (as rendered in the DOM, after HTML entity
  // decoding) to AGX icon concept names. Two passes per pass:
  //   1. Icon-only elements (textContent is just the emoji, possibly
  //      with a U+FE0F variation selector) — swap innerHTML with SVG.
  //   2. Leading-emoji elements (innerHTML starts with emoji + space
  //      + label) — set data-p86-icon and let decorate() prepend.
  // Skipped on elements already swapped (data-p86-emoji-swapped=1) or
  // already decorated (data-p86-icon-decorated=1). The MutationObserver
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
    '🎯': 'target',      // 1F3AF direct hit (47 estimating)
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
    // emoji glyphs in the AI panel title (47 / 86 / HR / Intake
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
    '🤖': 'discord',           // 1F916 robot face — admin Agents tab
    '✉':       'envelope',     // 2709  envelope (light variant)
    '📧': 'envelope',          // 1F4E7 e-mail symbol
    '📨': 'envelope',          // 1F4E8 incoming envelope
    // Node-library sidebar icons (Job → Workspace node graph). These
    // pair with the icon strings in nodegraph/engine.js DEFS:
    //   t1 🏗 → buildings (already mapped)
    //   t2 📋 → wip       (already mapped)
    //   labor 🛠 → wrench  (NEW — heavy stroke construction tools)
    //   mat 🧱 → materials (already mapped — Phosphor package)
    //   gc 🏢 → buildings  (NEW: office building emoji → buildings icon)
    //   burden ⚖ → scale   (NEW — balance scales for Direct Burden)
    //   other 📌 → bookmark (NEW — pin emoji aliased to bookmark)
    //   sub 👷 → subs     (already mapped — wrench-screwdriver)
    //   po 📄 → attachments (already mapped)
    //   inv 💳 → banknotes (NEW — credit-card emoji → banknotes)
    //   co 📝 → edit       (already mapped — pencil-square)
    //   wip / watch 📊 → chart-bar (already mapped)
    '🛠': 'wrench',            // 1F6E0 hammer-and-wrench (Labor)
    '🧱': 'materials',         // 1F9F1 brick (Materials)
    '🏢': 'buildings',         // 1F3E2 office building (Gen. Conditions)
    '⚖': 'scale',              // 2696  balance scales (Direct Burden)
    '📌': 'bookmark',          // 1F4CC pushpin (Other / Note)
    '💳': 'banknotes'          // 1F4B3 credit card (Invoice)
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
    if (el.dataset.p86EmojiSwapped === '1' || el.dataset.p86IconDecorated === '1' || el.dataset.p86Icon) return;
    if (!el.children) return;
    // Case 1: icon-only element (textContent is just one mapped emoji).
    var bare = strippedText(el);
    if (bare && EMOJI_ICONS[bare]) {
      el.dataset.p86EmojiSwapped = '1';
      el.innerHTML = p86Icon(EMOJI_ICONS[bare]);
      return;
    }
    // Case 2: leading emoji + " Label" pattern. Only swap when the
    // first child is a text node (not a structured layout) so we
    // don't blow away nested buttons / inputs.
    var first = el.firstChild;
    if (first && first.nodeType === 3 /* TEXT_NODE */) {
      var match = matchLeadingEmoji(first.nodeValue);
      if (match) {
        el.dataset.p86EmojiSwapped = '1';
        first.nodeValue = (match.rest ? ' ' + match.rest : '');
        el.dataset.p86Icon = match.concept;
        decorate(el);
      }
    }
  }
  function scanEmoji(root) {
    if (!root || !root.querySelectorAll) return;
    // Buttons + node-graph icon spans + ribbon icons + node-library
    // sidebar items. The node-library renders each item as
    // div.ng-cat-item > span (bare emoji) > " Label" — the inner
    // unnamed span holds the bare emoji as textContent, so we
    // explicitly target .ng-cat-item > span:first-child to hit Case 1
    // of emojiSwap (icon-only-element swap).
    var sel = 'button, .ng-ribbon-icon, .ng-tbtn, .ee-btn, .ee-icon-btn, .ng-cat-item > span:first-child';
    root.querySelectorAll(sel).forEach(emojiSwap);
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-p86-icon]:not([data-p86-icon-decorated])').forEach(decorate);
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
  window.p86Icon = p86Icon;
  window.p86IconDecorate = scan;
})();
`;

// Custom composite icons that aren't sourced from a single Phosphor /
// Heroicons SVG. Hand-authored to match the Phosphor 256x256 viewBox
// + currentColor convention so they slot into the same registry.
const CUSTOM_ICONS = {
  // "dna-86" — Project 86 brand mark. Outer circle ring + Phosphor
  // DNA strand inside + outlined/hollow "86" glyphs (stroke-only)
  // so it reads as a single line-art icon at any size.
  'dna-86': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><circle cx="128" cy="128" r="118" fill="none" stroke="currentColor" stroke-width="10"/><g transform="translate(20 6) scale(0.58)" fill="currentColor"><path d="M200,204.5V232a8,8,0,0,1-16,0V204.5a63.67,63.67,0,0,0-35.38-57.25l-48.4-24.19A79.58,79.58,0,0,1,56,51.5V24a8,8,0,0,1,16,0V51.5a63.67,63.67,0,0,0,35.38,57.25l48.4,24.19A79.58,79.58,0,0,1,200,204.5ZM160,200H72.17a63.59,63.59,0,0,1,3.23-16h72.71a8,8,0,0,0,0-16H83.46a63.71,63.71,0,0,1,14.65-15.08A8,8,0,1,0,88.64,140,80.27,80.27,0,0,0,56,204.5V232a8,8,0,0,0,16,0V216h88a8,8,0,0,0,0-16ZM192,16a8,8,0,0,0-8,8V40H96a8,8,0,0,0,0,16h87.83a63.59,63.59,0,0,1-3.23,16H107.89a8,8,0,1,0,0,16h64.65a63.71,63.71,0,0,1-14.65,15.08,8,8,0,0,0,9.47,12.9A80.27,80.27,0,0,0,200,51.5V24A8,8,0,0,0,192,16Z"></path></g><text x="172" y="196" font-family="Inter, -apple-system, BlinkMacSystemFont, \'Segoe UI\', system-ui, sans-serif" font-weight="700" font-size="86" text-anchor="middle" letter-spacing="-2" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="round" paint-order="stroke">86</text></svg>'
};

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
for (const [name, svg] of Object.entries(CUSTOM_ICONS)) {
  out += '  icons[' + JSON.stringify(name) + '] = ' + JSON.stringify(svg) + ';\n';
}
out += FOOTER;

fs.writeFileSync(OUT, out, 'utf8');
console.log('wrote ' + OUT + ' (' + out.length + ' bytes, ' + Object.keys(MAP).length + ' icons)');
