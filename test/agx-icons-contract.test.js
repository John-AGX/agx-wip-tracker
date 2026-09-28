// The icon generator's header promises: "Each retains stroke="currentColor" so
// CSS color rules tint them." Fourteen shipped icons broke that promise for as
// long as they existed — the Email icon among them — each carrying
// stroke="#0F172A" (slate-900) from a Figma export, and so rendering as a
// near-invisible dark smudge on the dark theme wherever it appeared, ignoring
// every CSS color rule meant to tint it. Nothing asserted the promise, so
// nothing noticed.
//
// This asserts it against the GENERATED file, which is what actually ships —
// not the build script, which only describes intent.

const fs = require('fs');
const path = require('path');

function loadIcons() {
  const win = {};
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'agx-icons.js'), 'utf8');
  // Runs the real generated file against a minimal stub, the same way the
  // browser would, and reads back the icon table it publishes.
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'MutationObserver', src)(
    win,
    { readyState: 'complete', addEventListener() {}, querySelectorAll() { return []; }, body: {} },
    function () { return { observe() {}, disconnect() {} }; }
  );
  return win.AGX_ICONS || {};
}

const ICONS = loadIcons();
const NAMES = Object.keys(ICONS);

test('the icon table actually loaded (a check over nothing cannot fail)', () => {
  expect(NAMES.length).toBeGreaterThan(90);
});

test('no shipped icon hardcodes a stroke color', () => {
  const offenders = NAMES.filter(n => /stroke="#[0-9A-Fa-f]{3,8}"/.test(ICONS[n]));
  expect(offenders).toEqual([]);
});

test('no shipped icon hardcodes a fill color', () => {
  // The generator deliberately normalises STROKES only: turning a hardcoded
  // fill into currentColor on an outline icon would paint the whole shape as a
  // solid blob. So a hex fill is not auto-fixed — it lands here, for a person
  // to decide, rather than shipping as a wrong-colored icon.
  const offenders = NAMES.filter(n => /fill="#[0-9A-Fa-f]{3,8}"/.test(ICONS[n]));
  expect(offenders).toEqual([]);
});

test('the Email icon specifically takes its color from CSS', () => {
  expect(ICONS['at-symbol']).toMatch(/stroke="currentColor"/);
});

test('the generator normalises strokes, so the next Figma export cannot regress it', () => {
  const build = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-agx-icons.js'), 'utf8');
  expect(build.includes('stroke="#[0-9A-Fa-f]{3,8}"/g, \'stroke="currentColor"\'')).toBe(true);
});
