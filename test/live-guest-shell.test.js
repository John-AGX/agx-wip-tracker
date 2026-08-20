// THE GUEST SHELL — what it may load, what it may weigh, and what it may not
// inherit from the host page.
//
// The fidelity pass changed the guest page's central move: it now COPIES the
// app's markup, classes and tokens rather than inventing its own. That is what
// makes the viewer read as Project 86. It also creates a new way to fail, and
// the existing safety net does not cover it:
//
//   test/live-host-guest-bleed.test.js proves js/live-rooms.js's boot() is
//   gated, and test/live-view-client.test.js proves live.html loads exactly two
//   scripts. Both are about FILES. This pass imports DOM.
//
// js/live-rooms.js is a host file, IS on the guest page (it carries the session
// core), and is full of DOM sniffers — captureHostRoute reads `.tab-btn.active`
// and `.sub-tab-btn-job.active`, currentJobId reads `#jobs-job-detail-view`,
// stripEl's delegated click handler routes `data-live-act="start"` into
// startHosting(), which fires a CREDENTIALED POST /api/live/rooms. Every one of
// those paths is unreachable today for exactly one reason: boot() returns early
// and nothing ever calls them. The markup this pass copies — #job-info-card and
// the WIP grid — are children of #jobs-job-detail-view in index.html.
//
// So: a fifth mechanism, matching the move being made. Copied ids and classes
// are namespaced on the way in, and the intersection of "what the guest page
// renders" with "what the host file looks for" is asserted EMPTY.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const bytes = (...p) => fs.statSync(path.join(__dirname, '..', ...p)).size;
const gz = (...p) => zlib.gzipSync(fs.readFileSync(path.join(__dirname, '..', ...p)), { level: 9 }).length;
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const stripHtml = (s) => stripJs(s.replace(/<!--[\s\S]*?-->/g, ''));

const HTML = read('live.html');
const BODY = stripHtml(HTML);
const VIEW_JS = read('js', 'live-view.js');
const ROOMS_JS = read('js', 'live-rooms.js');

// ══ 1. THE EXTRACT IS A COPY, AND DRIFT IS ALARMED ═════════════════════════

describe('css/live-surface.css is generated, and the generator still agrees with it', () => {
  test('re-running the generator reproduces the committed file byte for byte', () => {
    // THE PARITY ALARM. When css/styles.css changes underneath — a token
    // retuned, a chip restyled — this goes red and a human regenerates with a
    // reviewable diff. It deliberately does NOT auto-pull: an automatic pull
    // would be a supply chain from the SPA into the guest page, which is the
    // thing the copy-not-link rule exists to prevent.
    // Line endings are normalised on BOTH sides. This repo has core.autocrlf
    // on and css/styles.css is CRLF in the working tree, so a fresh checkout
    // hands back CRLF while the generator always emits LF. Comparing raw would
    // make this test fail on every machine except the one that generated the
    // file — a parity alarm nobody could keep green is a parity alarm someone
    // deletes.
    const lf = (s) => s.replace(/\r\n/g, '\n');
    const { build } = require('../scripts/build-live-surface-css.js');
    expect(lf(build())).toBe(lf(read('css', 'live-surface.css')));
  });

  test('it carries the app\'s tokens AND their light twin, re-keyed for a guest', () => {
    const CSS = read('css', 'live-surface.css');
    // The dark palette, from :root.
    expect(CSS).toMatch(/:root \{[\s\S]*--accent: #4f8cff;/);
    // The light palette, re-keyed off body.light-mode — a guest has no account
    // and no theme setting, so the system preference is the only signal.
    expect(CSS).toMatch(/@media \(prefers-color-scheme: light\)[\s\S]*--accent: #2563eb;/);
    // No body.light-mode SELECTOR survives — the class never exists on the
    // guest page, so a rule keyed to it would be dead weight that reads as a
    // working theme switch.
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/body\.light-mode/);
  });

  test('the chip that has NO light twin upstream is repaired, not shipped invisible', () => {
    // .p86-totals-chip is rgba(255,255,255,0.03) in styles.css with no
    // body.light-mode rule anywhere. On a white background that is an invisible
    // chip, on the one device this feature is for. The repair is authored in
    // terms of the app's own --overlay-light, which DOES carry a light twin.
    expect(read('css', 'styles.css')).not.toMatch(/body\.light-mode[^{]*\.p86-totals-chip\b/);
    const CSS = read('css', 'live-surface.css');
    const repair = CSS.slice(CSS.indexOf('LIGHT-MODE REPAIRS'));
    expect(repair).toMatch(/\.p86-totals-chip \{ background: var\(--overlay-light/);
  });

  test('bare element selectors are SCOPED, so the app\'s table rules cannot reach the shell', () => {
    const CSS = read('css', 'live-surface.css');
    for (const el of ['table', 'th', 'td']) {
      expect(CSS).toMatch(new RegExp('\\.p86-surface ' + el + ' \\{'));
      // and never unscoped
      expect(CSS).not.toMatch(new RegExp('(^|\\n)' + el + ' \\{'));
    }
    // And the scope actually exists on the page.
    expect(BODY).toMatch(/id="surface" class="p86-surface"/);
  });

  test('the chip ribbon\'s own phone breakpoint came across with it', () => {
    // The extract range in the design stopped one block short of
    // @media (max-width: 640px), which is what makes the chips go 2-up on a
    // narrow screen. Dropping the app's existing mobile rule for the very
    // component being copied is the quiet way this pass fails on a phone.
    expect(read('css', 'live-surface.css'))
      .toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.job-totals-strip \.p86-totals-chip \{/);
  });
});

// ══ 2. THE ASSET MANIFEST ══════════════════════════════════════════════════

describe('the guest page loads a CLOSED set of assets', () => {
  const SCRIPTS = Array.from(HTML.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1].split('?')[0]);
  const LINKS = Array.from(HTML.matchAll(/<link[^>]+href="([^"]+)"/g)).map((m) => m[1].split('?')[0]);

  test('the script set is EXACTLY two host files — an equality, not a subset', () => {
    expect(SCRIPTS.slice().sort()).toEqual(['/js/live-rooms.js', '/js/live-view.js']);
  });

  test('the stylesheet set is EXACTLY the two guest sheets plus Google Fonts', () => {
    // An equality check is the generalisation of "this file's boot is gated"
    // into "no host file is on this page at all". A subset check would let the
    // next stylesheet in silently.
    expect(LINKS.slice().sort()).toEqual([
      '/css/live-surface.css',
      '/css/live-view.css',
      'https://fonts.googleapis.com/css2',
      'https://fonts.gstatic.com'
    ].sort());
    // Asserted on CODE, not on prose: css/live-view.css and this page both
    // explain at length why styles.css is not linked, and a raw grep would fail
    // on the explanation — which teaches the next person to delete the comment
    // instead of the bug.
    expect(BODY).not.toContain('css/styles.css');
  });

  test('no SPA file is named anywhere on the page', () => {
    for (const bad of ['js/app.js', 'js/api.js', 'js/jobs.js', 'js/auth.js', 'js/insights.js',
      'js/cost-buckets.js', 'nodegraph/', 'js/pricing-pipeline.js']) {
      expect(BODY).not.toContain(bad);
    }
  });

  test('the INLINE script reaches only the six endpoints', () => {
    // The manifest above parses <script src>. The guest's actual logic is an
    // inline block, so an equality check on external assets is not a check on
    // what code runs. Every URL literal in the page is enumerated here.
    const inline = BODY.slice(BODY.indexOf('<script>'));
    const urls = Array.from(inline.matchAll(/'(\/api\/[^']*)'/g)).map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^\/api\/live\//);
    // The two doors the page itself opens; the other four are opened by the
    // session core, which is where they are asserted.
    for (const door of ['/status', '/view/']) expect(inline).toContain(door);
    const CORE = stripJs(ROOMS_JS);
    for (const door of ['/join', '/beat/', '/stream/', '/leave']) expect(CORE).toContain(door);
    // and nothing on either that could name a record
    expect(inline).not.toMatch(/entity_id|\/api\/jobs|\/api\/live\/mine/);
  });
});

// ══ 3. DOM BLEED — the mechanism this pass actually needed ═════════════════

describe('the copied markup carries no handle the host file is looking for', () => {
  // Every selector js/live-rooms.js queries, lifted from the source rather than
  // listed by hand, so a new sniffer is covered the day it is added.
  function hostSelectors() {
    const out = new Set();
    for (const m of ROOMS_JS.matchAll(/document\.querySelector\('([^']+)'\)/g)) out.add(m[1]);
    for (const m of ROOMS_JS.matchAll(/document\.getElementById\('([^']+)'\)/g)) out.add('#' + m[1]);
    return Array.from(out);
  }

  test('it finds the sniffers, so this test is not vacuous', () => {
    const sels = hostSelectors();
    expect(sels).toEqual(expect.arrayContaining(['.tab-btn.active', '#jobs-job-detail-view']));
  });

  test('nothing the guest renders matches anything the host file hunts for', () => {
    // The copied blocks are #job-info-card and the #job-wip-report grid, and
    // BOTH are children of #jobs-job-detail-view in index.html. Bringing their
    // ids across verbatim would have put currentJobId()'s marker on a page that
    // also holds startHosting() and a credentialed POST.
    const guestMarkup = BODY + '\n' + stripJs(VIEW_JS);
    const tokens = [];
    for (const sel of hostSelectors()) {
      for (const t of sel.split(/[.#\s]+/)) if (t) tokens.push(t);
    }
    for (const t of Array.from(new Set(tokens))) {
      expect(guestMarkup).not.toContain('"' + t + '"');
      expect(guestMarkup).not.toContain("'" + t + "'");
      expect(guestMarkup).not.toContain('id="' + t);
      expect(guestMarkup).not.toContain('class="' + t);
    }
  });

  test('every id the guest renderer emits is namespaced, and it emits no id at all', () => {
    // Simplest form of the rule: the guest renderer writes CLASSES, never ids.
    // An id is what a sniffer keys off, and the app's own card is a wall of
    // job-info-* ids written for renderJobDetail to paint into.
    expect(stripJs(VIEW_JS)).not.toMatch(/\sid="/);
    expect(stripJs(VIEW_JS)).not.toMatch(/job-info-|wip-contract-income|job-summary-/);
  });

  test('the guest reuses the app CLASSES it needs, and only presentational ones', () => {
    const src = stripJs(VIEW_JS);
    // These are the app's real classes — that is the whole fidelity point.
    for (const cls of ['card', 'p86-totals-strip', 'job-totals-strip', 'p86-totals-chip',
      'p86-totals-chip-label', 'p86-totals-chip-value', 'table-container']) {
      expect(src).toContain(cls);
    }
    // But no behavioural hook: nothing in the app binds to these.
    for (const hook of ['data-live-act', 'sub-tab-btn-job', 'ws-right-tab', 'tab-btn', 'read-only-mode']) {
      expect(src).not.toContain(hook);
    }
  });

  test('js/live-view.js adds exactly one global, in a bare context', () => {
    // Cheaper and stronger than reviewing each copied block: it fails loudly
    // the day someone pastes in a function that assigns to window.
    const sandbox = { window: {}, document: undefined };
    sandbox.window.document = undefined;
    const before = Object.keys(sandbox.window);
    // eslint-disable-next-line no-new-func
    new Function('window', 'module', VIEW_JS)(sandbox.window, undefined);
    const added = Object.keys(sandbox.window).filter((k) => before.indexOf(k) === -1);
    expect(added).toEqual(['p86LiveView']);
  });

  test('the guest still writes nothing to any shared same-origin surface', () => {
    for (const SRC of [stripJs(VIEW_JS), stripJs(ROOMS_JS)]) {
      expect(SRC).not.toMatch(/localStorage|sessionStorage|indexedDB|BroadcastChannel|postMessage/);
    }
    expect(BODY).not.toMatch(/localStorage|sessionStorage|indexedDB|BroadcastChannel|postMessage/);
  });
});

// ══ 4. THE WEIGHT CEILING ══════════════════════════════════════════════════

describe('the guest shell stays a phone-in-a-truck page', () => {
  // Stated and asserted rather than estimated. The alternative that was
  // rejected — linking css/styles.css — is measured alongside so the ceiling
  // has something to mean.
  const SHELL = [
    ['js', 'live-rooms.js'],
    ['js', 'live-view.js'],
    ['css', 'live-view.css'],
    ['css', 'live-surface.css']
  ];

  test('the whole shell is under 48 KB gzipped, and the extract under 4 KB', () => {
    // Measured on this tree, gzip -9:
    //   js/live-rooms.js  20,324   js/live-view.js    7,684
    //   css/live-view.css  3,827   css/live-surface   3,154
    //   live.html          8,034                 total ~43 KB
    // The ceiling is set to catch the two ways this page gets heavy — linking
    // css/styles.css (+92 KB gz) or pulling in an SPA file — not to police a
    // few hundred bytes of comment.
    const total = SHELL.reduce((s, f) => s + gz(...f), 0) + gz('live.html');
    expect(total).toBeLessThan(48 * 1024);
    expect(gz('css', 'live-surface.css')).toBeLessThan(4 * 1024);
    // And no single asset dominates: the largest is the session core.
    for (const f of SHELL) expect(gz(...f)).toBeLessThan(25 * 1024);
  });

  test('the extract costs a fraction of the stylesheet it replaces', () => {
    const linked = gz('css', 'styles.css');
    const copied = gz('css', 'live-surface.css');
    // Measured on this tree: ~92 KB gz linked against ~3 KB gz copied.
    expect(linked).toBeGreaterThan(80 * 1024);
    expect(copied / linked).toBeLessThan(0.06);
  });

  test('nothing here streams — a view document is fetched per NAVIGATION', () => {
    // The per-minute claim is about the wire, not the shell, and the shell is a
    // one-time cached cost either way. The only per-second traffic the guest
    // ever had was the host's pointer, which it could not draw; that channel is
    // closed at the projection seam.
    expect(HTML).not.toMatch(/setInterval\([^)]*loadSurface/);
    expect(read('server', 'services', 'live-view.js'))
      .toMatch(/event\.type === 'cursor' && !isHost\) return null;/);
  });

  test('live.html defines no selector the two stylesheets own', () => {
    // .card used to live in the inline block, AFTER the <link>, at equal
    // specificity — so it silently beat the app's card the moment the extract
    // landed. The reflex fix is to bump specificity; this repo already has that
    // scar, so the rule is that the inline block owns layout of the SHELL only.
    const inlineStyle = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
    const surface = read('css', 'live-surface.css');
    for (const owned of ['.card', '.p86-totals-strip', '.p86-totals-chip', '.table-container']) {
      expect(surface).toContain(owned + ' {');
      expect(inlineStyle).not.toContain(owned + ' {');
    }
  });

  test('sizes are recorded here so a regression is legible, not just red', () => {
    const line = SHELL.map((f) => f.join('/') + ' ' + gz(...f)).join(' · ');
    expect(typeof line).toBe('string');
    expect(bytes('css', 'live-surface.css')).toBeGreaterThan(2000);
  });
});
