/* ──────────────────────────────────────────────────────────────────────────
 * THE SITE PLAN WAS THE ONLY MAP IN THE PRODUCT WITH NO LABELS.
 *
 * Google's `satellite` map type is photorealistic aerial imagery and NOTHING
 * else — no street names, no place names. `hybrid` is the same imagery WITH
 * basemap labels. Every other map surface in this app already mounts HYBRID
 * (map-picker, projects, tasks, entities-map, task-share). The node-graph Site
 * Plan mounted bare SATELLITE, so surveying an apartment complex on a lead —
 * where no building has been traced yet, so P86 draws no labels of its own —
 * produced a screen with literally no text on it.
 *
 * Labels cannot fight the tracing workflow: they are painted by the basemap
 * (.ng-basemap, z-index 1) and the entire P86 geometry stack rides above it
 * (.ng-canvas z-index 5, .ng-polygon-layer z-index 6, nodes 10-16). So this is
 * a one-word change, not a new control.
 *
 * The trap it has to survive: TWO places produce a Google map type — the Map
 * constructor at mount, and setMapTypeId on the live toggle. They used to spell
 * the rule out separately (an enum ternary at mount, the raw state string at the
 * toggle). Changing one and not the other is SILENT: the toggle looks right, and
 * every cold load quietly serves the old imagery. This asserts there is exactly
 * ONE producer and that both paths call it.
 *
 * Nothing here depends on a tile painting. Google Maps refuses to render tiles
 * in a hidden/background tab, so a screenshot proves nothing; the map type
 * actually handed to Google is deterministic and is what gets asserted.
 * ────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const NG_RAW = read('nodegraph', 'ui.js');
const NG = stripJs(NG_RAW);
const CSS = read('nodegraph', 'nodegraph.css');
const HTML = read('index.html');

// ── Run the REAL code, not a copy of it ────────────────────────────────────
// Both helpers are lifted verbatim out of nodegraph/ui.js and executed. If the
// shipped source stops matching these extractions the tests fail loudly rather
// than silently testing a stale transcription.

const RESOLVER_SRC = (() => {
  const m = NG.match(/function spGoogleMapTypeId\(\)\s*\{[^}]*\}/);
  if (!m) throw new Error('spGoogleMapTypeId() not found in nodegraph/ui.js');
  return m[0];
})();

const READER_SRC = (() => {
  const m = NG.match(/var _spBasemapType\s*=\s*\(function\(\)\{[\s\S]*?\}\)\(\);/);
  if (!m) throw new Error('the _spBasemapType localStorage reader was not found');
  return m[0];
})();

// `_spBasemapType` becomes the parameter the extracted function closes over.
const resolve = new Function('_spBasemapType', `${RESOLVER_SRC} return spGoogleMapTypeId();`);
// `localStorage` as a parameter shadows the global for the extracted IIFE.
const readState = new Function('localStorage', `${READER_SRC} return _spBasemapType;`);

const storageOf = (v) => ({ getItem: () => v });
const HOSTILE_STORAGE = { getItem() { throw new Error('SecurityError: storage is disabled'); } };
// Whatever a stored value is, the pipeline is read-then-resolve.
const rendered = (stored) => resolve(readState(storageOf(stored)));

// ══ 1. WHAT GOOGLE ACTUALLY RECEIVES, FOR EVERY STATE ══════════════════════

describe('the map type handed to Google', () => {
  test('the satellite state renders as hybrid — imagery WITH street + place labels', () => {
    expect(resolve('satellite')).toBe('hybrid');
  });

  test('the roadmap state is untouched — it is the escape hatch for poor imagery', () => {
    expect(resolve('roadmap')).toBe('roadmap');
  });

  test('bare "satellite" is never handed to Google from anywhere', () => {
    // The whole bug in one assertion: this is the map type with no labels.
    for (const s of ['satellite', 'roadmap', '', null, undefined, 'hybrid', 'terrain']) {
      expect(resolve(s)).not.toBe('satellite');
    }
  });

  test('every state resolves to a real Google map type — never blank/undefined', () => {
    const VALID = ['hybrid', 'roadmap'];
    for (const s of ['satellite', 'roadmap', '', null, undefined, 0, false, {}, [], 'HYBRID', 'garbage']) {
      expect(VALID).toContain(resolve(s));
    }
  });
});

// ══ 2. LEGACY / UNKNOWN PERSISTED VALUES ═══════════════════════════════════
// The persisted vocabulary is deliberately UNCHANGED ('satellite'|'roadmap'),
// so a value written by an older build and a value written by this one are the
// same two strings. That is what makes the change safe in both directions.

describe('the persisted preference (localStorage ngSitePlanBasemap)', () => {
  test('a legacy stored "satellite" upgrades to labelled imagery on reload', () => {
    expect(rendered('satellite')).toBe('hybrid');
  });

  test('a stored "roadmap" still yields the road map — the preference survives', () => {
    expect(rendered('roadmap')).toBe('roadmap');
  });

  test('an absent preference (first ever visit) yields labelled imagery', () => {
    expect(rendered(null)).toBe('hybrid');
  });

  test('an unknown/corrupt stored value degrades to labelled imagery, never a blank map', () => {
    for (const junk of ['', 'HYBRID', 'Roadmap', 'terrain', 'satellite ', '{}', '1', 'undefined']) {
      expect(rendered(junk)).toBe('hybrid');
    }
  });

  test('storage that throws (private mode / disabled cookies) still yields a map', () => {
    expect(resolve(readState(HOSTILE_STORAGE))).toBe('hybrid');
  });

  test('the writer only ever persists the two states the reader understands', () => {
    const write = NG.match(/_spBasemapType\s*=\s*\(_spBasemapType==='roadmap'\)\s*\?\s*'satellite'\s*:\s*'roadmap';/);
    expect(write).not.toBeNull();
    expect(NG).toMatch(/localStorage\.setItem\('ngSitePlanBasemap',\s*_spBasemapType\)/);
  });
});

// ══ 3. ONE PRODUCER — the divergence trap ══════════════════════════════════

describe('the mount and the live toggle cannot drift apart', () => {
  test('the Map constructor gets its type from the resolver', () => {
    expect(NG).toMatch(/mapTypeId\s*:\s*spGoogleMapTypeId\(\)/);
  });

  test('setMapTypeId gets its type from the same resolver', () => {
    expect(NG).toMatch(/setMapTypeId\(\s*spGoogleMapTypeId\(\)\s*\)/);
  });

  test('setMapTypeId is NOT handed the raw state variable', () => {
    // The old shape. It happened to work only because the state strings and
    // Google's map-type strings coincided — which stops being true the moment
    // a state renders as a different type than its own name, as 'satellite' now does.
    expect(NG).not.toMatch(/setMapTypeId\(\s*_spBasemapType\s*\)/);
  });

  test('the SATELLITE enum is gone from the site plan entirely', () => {
    expect(NG).not.toMatch(/MapTypeId\.SATELLITE/);
  });

  test('the string form is already proven against a Map constructor in this app', () => {
    // The resolver returns a plain string where the mount previously passed the
    // maps.MapTypeId enum. That is safe because MapOptions.mapTypeId is typed as
    // a string and the enum members ARE these lowercase strings — but the reason
    // it is not a leap of faith is that task-share.html has been shipping the
    // literal to a live Map constructor all along.
    expect(read('task-share.html')).toMatch(/mapTypeId:\s*'hybrid'/);
  });

  test('exactly one place in the file decides the map type', () => {
    // Two would mean the trap is back: someone could fix the toggle and leave
    // the mount serving the old imagery on every cold load.
    expect((NG.match(/'hybrid'/g) || []).length).toBe(1);
    expect((NG.match(/function spGoogleMapTypeId/g) || []).length).toBe(1);
    expect((NG.match(/spGoogleMapTypeId\(\)/g) || []).length).toBe(3); // 1 declaration + 2 call sites
  });
});

// ══ 4. LEAD SURVEY AND JOB SITE PLAN CANNOT DIVERGE ════════════════════════

describe('a lead survey and a job site plan get the same basemap', () => {
  test('the resolver takes no entity and consults no entity state', () => {
    // This is the whole proof of parity: one zero-argument function, reading a
    // single global, feeding both render paths. There is no branch that COULD
    // tell a lead from a job, so the two cannot be given different imagery.
    expect(RESOLVER_SRC).toMatch(/function spGoogleMapTypeId\(\)/);   // no parameters
    expect(RESOLVER_SRC).not.toMatch(/isSurvey|surveyLead|E\.job\(\)/);
  });

  test('the basemap ribbon control is gated on view mode, never on entity type', () => {
    expect(CSS).toMatch(/\.ng-sat\b/);
    expect(NG).not.toMatch(/isSurvey[\s\S]{0,80}spGoogleMapTypeId/);
  });
});

// ══ 5. THE LABELS CANNOT COVER HIS WORK ════════════════════════════════════
// The judgement that made this a one-word change instead of a new toggle. If
// someone ever re-stacks these layers, this fails and the decision gets revisited.

describe('basemap labels stay under every piece of P86 geometry', () => {
  const zOf = (re) => {
    const m = CSS.match(re);
    expect(m).not.toBeNull();
    const z = m[0].match(/z-index:\s*(\d+)/);
    expect(z).not.toBeNull();
    return Number(z[1]);
  };

  test('the basemap sits below the canvas and the polygon layer', () => {
    const basemap = zOf(/#nodeGraphTab \.ng-basemap\{[^}]*\}/);
    const canvas = zOf(/\.ng-canvas\{[^}]*\}/);
    const polys = zOf(/\.ng-polygon-layer\{[^}]*\}/);
    expect(basemap).toBeLessThan(canvas);
    expect(canvas).toBeLessThan(polys);
  });

  test('the basemap never catches a click, so tracing is unaffected', () => {
    expect(CSS).toMatch(/#nodeGraphTab \.ng-basemap\{[^}]*pointer-events:none/);
  });
});

// ══ 6. THE CHANGE ACTUALLY REACHES THE BROWSER ═════════════════════════════

describe('cache-buster', () => {
  test('nodegraph/ui.js is loaded with a version past the bare-satellite build', () => {
    const m = HTML.match(/nodegraph\/ui\.js\?v=(\d+)/);
    expect(m).not.toBeNull();
    // v=334 is the last build that mounted SATELLITE. Editing nodegraph/ui.js
    // without bumping this leaves every returning browser on the cached old file.
    expect(Number(m[1])).toBeGreaterThanOrEqual(335);
  });
});
