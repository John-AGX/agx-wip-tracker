#!/usr/bin/env node
'use strict';

/**
 * scripts/build-live-surface-css.js — generate css/live-surface.css from
 * css/styles.css.
 *
 * ── THE RULE THIS SCRIPT EXISTS TO ENFORCE ─────────────────────────────────
 *
 *     THE GUEST PAGE COPIES THE APP'S MARKUP, CLASSES AND TOKENS.
 *     IT NEVER LINKS THE APP'S CODE.
 *
 * Copying is what makes fidelity possible: the reusable unit in this codebase
 * is markup + class, not function — every real renderer takes a jobId and
 * reaches for appData itself. Not-linking is what keeps the host/guest bleed
 * class closed. Both prior bleeds came from loading a host file on live.html
 * and trusting a runtime gate to defuse it.
 *
 * Why not just link css/styles.css? Measured on this tree: 449,789 bytes raw,
 * 92,006 gzipped, against a guest shell that is 27,775 gzipped in total. And it
 * carries bare `button`, `input`, `table`, `th`, `td` rules written for a
 * desktop three-column workspace, which would style guest markup whether it
 * wanted them or not. The extract is ~2.6 KB gzipped — about 3% — and delivers
 * the same tokens, the same card, the same chip ribbon, the same table.
 *
 * ── THREE TRANSFORMS, ALL MECHANICAL ───────────────────────────────────────
 *
 *  1. LIGHT MODE IS RE-KEYED. The app decides light mode from `body.light-mode`,
 *     set from a signed-in user's setting. A guest has no account and no
 *     setting, so the twin is re-keyed to `@media (prefers-color-scheme: light)`
 *     — the phone default, and the stated case is a phone.
 *
 *  2. BARE ELEMENT SELECTORS ARE SCOPED. `table`, `th`, `td` become
 *     `.p86-surface table` and so on. Unscoped they would reach the guest
 *     shell's own chrome, which is how a borrowed stylesheet turns into
 *     someone else's specificity fight.
 *
 *  3. LIGHT-MODE REPAIRS ARE APPENDED, AND THEY ARE LISTED HERE IN SOURCE.
 *     `.p86-totals-chip` is `rgba(255,255,255,0.03)` with NO body.light-mode
 *     twin anywhere in styles.css — a white-on-white chip on the exact device
 *     this feature is for. There is nothing to extract, so the repair is
 *     authored, named, and written in terms of the app's own `--overlay-light`
 *     token rather than a new literal.
 *
 * ── DRIFT IS THE ACCEPTED COST, AND IT IS ALARMED, NOT AUTOMATED ───────────
 * test/live-guest-shell.test.js re-runs this generator in memory and
 * compares it to the committed file. When styles.css changes underneath, the
 * build goes red and a human regenerates with a reviewable diff. An automatic
 * pull would be a supply chain from the SPA into the guest page, which is the
 * thing this whole file exists to prevent.
 *
 * Run:  node scripts/build-live-surface-css.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'css', 'styles.css');
const OUT = path.join(ROOT, 'css', 'live-surface.css');

// ── A very small CSS reader ────────────────────────────────────────────────
// Enough to walk top-level rules and one level of at-rule. Not a CSS parser and
// does not pretend to be: it is a brace walker with string and comment skipping,
// which is all that is needed to lift whole rules out by selector.
function readRules(css) {
  const out = [];
  let i = 0, n = css.length, selStart = 0;
  const skipTo = (endTok) => {
    const at = css.indexOf(endTok, i);
    i = at === -1 ? n : at + endTok.length;
  };
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') { i += 2; skipTo('*/'); continue; }
    if (c === '"' || c === "'") { i += 1; skipTo(c); continue; }
    if (c === '{') {
      // Comments preceding a rule land in front of its selector. Strip them
      // BEFORE the at-rule test: styles.css comments most of its @media blocks,
      // and a commented one was silently read as an ordinary rule named
      // "@media (max-width: 640px)" — which is how the chip ribbon's own phone
      // breakpoint went missing from the first run of this extract.
      const selector = css.slice(selStart, i).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
      // find the matching close brace
      let depth = 1, j = i + 1;
      while (j < n && depth > 0) {
        const d = css[j];
        if (d === '/' && css[j + 1] === '*') { const at = css.indexOf('*/', j); j = at === -1 ? n : at + 2; continue; }
        if (d === '"' || d === "'") { const at = css.indexOf(d, j + 1); j = at === -1 ? n : at + 1; continue; }
        if (d === '{') depth++;
        else if (d === '}') depth--;
        j++;
      }
      const body = css.slice(i + 1, j - 1);
      if (selector.charAt(0) === '@') out.push({ at: selector, body: body, children: readRules(body) });
      else out.push({ selector: norm(selector), body: body.trim() });
      i = j; selStart = i;
      continue;
    }
    if (c === '}') { i += 1; selStart = i; continue; }
    if (c === ';') { i += 1; selStart = i; continue; }   // top-level @import etc.
    i += 1;
  }
  return out;
}

// One selector, one spelling: whitespace collapsed, comma-separated parts
// trimmed. Multi-line selector lists in styles.css are common.
function norm(sel) {
  // Comments between rules land in front of the next selector — styles.css is
  // heavily commented and half its rules would otherwise be unfindable by name.
  return sel.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ').split(',').map((s) => s.trim()).filter(Boolean).join(', ');
}

function reindent(body, pad) {
  return body.split('\n').map((l) => {
    const t = l.trim();
    return t ? pad + t : '';
  }).filter((l, idx, arr) => !(l === '' && (idx === 0 || arr[idx - 1] === ''))).join('\n');
}

// ── What crosses ───────────────────────────────────────────────────────────
// Each entry is a selector as it appears in css/styles.css (normalised), and
// how it should be written into the extract. `scope: true` prefixes
// `.p86-surface ` onto every bare element part.
const BLOCKS = [
  { sel: '.card', note: 'the app card — chrome for every panel on the guest page' },
  { sel: '.table-container', scope: true },
  { sel: 'table', scope: true },
  { sel: 'th', scope: true },
  { sel: 'td', scope: true },
  { sel: 'tr:last-child td', scope: true },
  { sel: '.p86-co-totals, .p86-totals-strip', note: 'the chip ribbon chassis' },
  { sel: '.p86-co-chip, .p86-totals-chip' },
  { sel: '.p86-co-chip.accent, .p86-totals-chip.accent' },
  { sel: '.p86-co-chip-label, .p86-totals-chip-label' },
  { sel: '.p86-co-chip-value, .p86-totals-chip-value' },
  { sel: '.p86-co-chip.accent .p86-co-chip-value, .p86-totals-chip.accent .p86-totals-chip-value' },
  { sel: '.p86-totals-chip.warn .p86-totals-chip-value' },
  { sel: '.p86-totals-chip.info .p86-totals-chip-value' },
  { sel: '.p86-totals-chip.dim .p86-totals-chip-value' },
  { sel: '.job-totals-strip', note: 'the job page relaxes the ribbon for inline content' },
  { sel: '.job-totals-chip-sub' }
];

// Rules that live inside an @media in styles.css and must come across WITH it.
// The chip ribbon's own phone breakpoint is here: without it the extract would
// drop the app's existing mobile rule for the very component it copies.
const MEDIA_BLOCKS = [
  { at: '@media (max-width: 640px)', sels: ['.job-totals-strip', '.job-totals-strip .p86-totals-chip', '.job-totals-strip .p86-totals-chip-value'] }
];

// Authored repairs. See transform 3 above.
const REPAIRS = `
/* ── LIGHT-MODE REPAIRS (authored, not extracted) ────────────────────────────
   .p86-totals-chip is background: rgba(255,255,255,0.03) in styles.css and has
   NO body.light-mode twin — grep the whole file. On a white background that is
   an invisible chip, on the one device this feature exists for. There is
   nothing to extract, so it is repaired here in terms of the app's own
   --overlay-light token, which DOES carry a light twin (rgba(255,255,255,.06)
   dark / rgba(0,0,0,.04) light).                                             */
.p86-totals-chip { background: var(--overlay-light, rgba(255,255,255,0.03)); }
.p86-co-totals, .p86-totals-strip { background: var(--overlay-light, rgba(255,255,255,0.02)); }
.job-totals-strip { background: transparent; }

/* th is position: sticky in the app because its tables sit in a fixed-height
   workspace pane. The guest's tables scroll inside their own container with no
   height, where sticky buys nothing and costs a paint. */
.p86-surface th { position: static; }
`;

function scopeSelector(sel) {
  return sel.split(',').map((part) => {
    const p = part.trim();
    return '.p86-surface ' + p;
  }).join(',\n');
}

function build() {
  const css = fs.readFileSync(SRC, 'utf8');
  const rules = readRules(css);
  const byName = new Map();
  const mediaByName = new Map();
  for (const r of rules) {
    if (r.at) {
      const key = norm(r.at);
      if (!mediaByName.has(key)) mediaByName.set(key, new Map());
      const m = mediaByName.get(key);
      for (const c of r.children || []) if (c.selector && !m.has(c.selector)) m.set(c.selector, c.body);
      continue;
    }
    if (r.selector && !byName.has(r.selector)) byName.set(r.selector, r.body);
  }

  const need = (sel) => {
    if (!byName.has(sel)) throw new Error('live-surface extract: selector vanished from css/styles.css -> ' + sel);
    return byName.get(sel);
  };

  const out = [];
  out.push(`/* css/live-surface.css — GENERATED. Do not edit by hand.

   Regenerate:  node scripts/build-live-surface-css.js
   Source:      css/styles.css
   Guard:       test/live-guest-shell.test.js re-runs the generator and
                fails when this file and the source have drifted apart.

   This is the app's own skin, copied into the guest page so the viewer reads as
   Project 86 rather than as a thinner, different app. It is a COPY on purpose —
   live.html links no host stylesheet and no host script, because every
   host/guest bleed this feature has had came from loading a host file there and
   trusting a runtime gate. Drift is the accepted cost; the parity test is the
   alarm, and regeneration is a human act with a reviewable diff.            */\n`);

  out.push('/* ── Design tokens (css/styles.css :root) ─────────────────────────────── */');
  out.push(':root {\n' + reindent(need(':root'), '  ') + '\n}\n');

  out.push(`/* Light mode, RE-KEYED. The app switches on body.light-mode, from a signed-in
   user's setting. A guest has no account and no setting, so the same tokens are
   keyed to the system preference instead — which is what a phone actually
   reports, and a phone in a truck is the stated case.                        */`);
  out.push('@media (prefers-color-scheme: light) {\n  :root {\n' + reindent(need('body.light-mode'), '    ') + '\n  }\n}\n');

  out.push('/* ── Components (copied, with provenance) ─────────────────────────────── */');
  for (const b of BLOCKS) {
    const body = need(b.sel);
    const sel = b.scope ? scopeSelector(b.sel) : b.sel.split(', ').join(',\n');
    if (b.note) out.push('/* ' + b.note + ' */');
    out.push(sel + ' {\n' + reindent(body, '  ') + '\n}\n');
  }

  for (const mb of MEDIA_BLOCKS) {
    const m = mediaByName.get(norm(mb.at));
    if (!m) throw new Error('live-surface extract: at-rule vanished -> ' + mb.at);
    const inner = mb.sels.map((s) => {
      if (!m.has(s)) throw new Error('live-surface extract: selector vanished from ' + mb.at + ' -> ' + s);
      return '  ' + s + ' {\n' + reindent(m.get(s), '    ') + '\n  }';
    }).join('\n');
    out.push(mb.at + ' {\n' + inner + '\n}\n');
  }

  out.push(REPAIRS.trim() + '\n');
  return out.join('\n');
}

module.exports = { build };

if (require.main === module) {
  const css = build();
  fs.writeFileSync(OUT, css, 'utf8');
  process.stdout.write('wrote ' + path.relative(ROOT, OUT) + ' (' + css.length + ' bytes)\n');
}
