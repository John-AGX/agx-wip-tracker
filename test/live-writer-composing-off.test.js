// The mid-write "drafting your change" card is disabled in PRODUCTION while the
// engine still defaults it on (so its ~18 regression tests keep exercising the
// real thing). That split means nothing in the engine's own suite can prove the
// card is actually off for users — the deployment wiring is a separate claim,
// and an unasserted claim is how it silently comes back.
//
// Every assertion below is written to FAIL if the wiring breaks, not merely to
// find a string somewhere in a file. In particular the ORDER assertion is the
// load-bearing one: the flag is read at module load, so setting it after the
// script tag would parse fine, read fine, and do nothing.

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('the drafting card is off in production, and on in the engine', () => {
  const INDEX = read('index.html');
  const ENGINE = read('js/live-writer.js');

  test('index.html sets the flag to false', () => {
    expect(INDEX).toMatch(/window\.P86_LIVE_WRITER_COMPOSING\s*=\s*false/);
  });

  test('THE ORDER: the flag is set BEFORE live-writer.js loads', () => {
    const flagAt = INDEX.indexOf('P86_LIVE_WRITER_COMPOSING');
    const scriptAt = INDEX.search(/<script src="js\/live-writer\.js/);
    expect(flagAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeGreaterThan(-1);
    // Read at module load. Set it after the tag and the card quietly returns.
    expect(flagAt).toBeLessThan(scriptAt);
  });

  test('the engine DEFAULTS the card on — the tests below it must keep biting', () => {
    // If someone "simplifies" this to `var COMPOSING_ENABLED = false`, the 18
    // honesty/permutation tests pass vacuously against a disabled feature.
    expect(ENGINE).toMatch(/COMPOSING_ENABLED\s*=\s*\(typeof window/);
    expect(ENGINE).toMatch(/:\s*true;/);
    expect(ENGINE).not.toMatch(/var COMPOSING_ENABLED\s*=\s*false/);
  });

  test('the decline lives at the reporting boundary, not only at the caller', () => {
    // reportToStrip is documented as the one door surface B reports through.
    // A guard only in startComposing would let a future caller repaint it.
    const guard = /report\.kind === 'composing' && !COMPOSING_ENABLED\) return null/;
    expect(ENGINE).toMatch(guard);
    const boundaryAt = ENGINE.search(/function reportToStrip/);
    const guardAt = ENGINE.search(guard);
    expect(guardAt).toBeGreaterThan(boundaryAt);
  });

  test('the 180s backstop cannot fire when the card is off', () => {
    // Its only job was retracting the placeholder. Left armed with no card, it
    // would announce "nothing landed" about something the user never saw.
    const start = ENGINE.indexOf('function startComposing');
    const timer = ENGINE.indexOf('composingTimer = setTimeout', start);
    const bail = ENGINE.indexOf('if (!COMPOSING_ENABLED) return;', start);
    expect(bail).toBeGreaterThan(start);
    expect(bail).toBeLessThan(timer);   // returns before arming
  });
});

describe('the replacement indicator is actually wired', () => {
  const CHIP = read('js/crew-chip.js');
  const CSS = read('css/styles.css');
  const PANEL = read('js/ai-panel.js');

  test('ai-panel no longer triggers the card', () => {
    expect(PANEL).not.toMatch(/startComposing\(/);
  });

  test('crew-chip toggles the body class on a write tool, and clears it', () => {
    expect(CHIP).toMatch(/classList\.toggle\('p86-ai-writing'/);
    expect(CHIP).toMatch(/isWriteTool\(d\.name\)\)\s*\{\s*setWriting\(true\)/);
    expect(CHIP).toMatch(/case 'tool_done':[\s\S]{0,120}setWriting\(false\)/);
    // A turn that dies mid-tool sends no tool_done. Without this the badge
    // glows until reload, which is worse than never glowing.
    expect(CHIP).toMatch(/case 'turn_end':[\s\S]{0,300}setWriting\(false\)/);
  });

  test('the glow beats :hover — the specificity trap this repo keeps hitting', () => {
    // body.p86-ai-writing .p86-ask86-badge .p86-icon = [0,3,1]
    // .p86-ask86-badge:hover .p86-icon              = [0,3,0]
    // Lose this and hovering mid-write reverts the colour to brand blue.
    const writing = CSS.indexOf('body.p86-ai-writing .p86-ask86-badge .p86-icon');
    const hover = CSS.indexOf('.p86-ask86-badge:hover .p86-icon');
    expect(writing).toBeGreaterThan(-1);
    expect(hover).toBeGreaterThan(-1);
    expect(CSS).toMatch(/@keyframes p86-ask86-glow-writing\b/);
    expect(CSS).toMatch(/@keyframes p86-ask86-glow-writing-light\b/);
    // reduced-motion holds a steady glow rather than pulsing, as the rest of
    // this file already does for the floating badge.
    expect(CSS).toMatch(/prefers-reduced-motion[\s\S]{0,400}p86-ai-writing[\s\S]{0,200}animation:\s*none/);
  });
});

describe('surface C owns its own stylesheet', () => {
  const ENGINE = read('js/live-writer.js');

  test('flashEditorRows installs the CSS itself', () => {
    // Until this, ensureStyle() was reached only via ensureRoot / ensurePane
    // (surface B mounting) and cowork.js — so the green row glow animated only
    // because the notification had already paid for the stylesheet. Reducing B
    // without this silently kills the glow, which is the part being kept.
    const fn = ENGINE.indexOf('function flashEditorRows');
    const ensure = ENGINE.indexOf('ensureStyle();', fn);
    const firstReturn = ENGINE.indexOf('return 0;', fn);
    expect(fn).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(fn);
    expect(ensure).toBeLessThan(firstReturn);   // before any early exit
  });
});

describe('a deferred flash is retried instead of rotting', () => {
  const ED = read('js/estimate-editor.js');

  test('typing schedules a retry rather than dropping the repaint', () => {
    expect(ED).toMatch(/isTypingIn\('#estimate-editor-view'\)\)\s*\{\s*[\s\S]{0,120}scheduleTypingRetry\(\)/);
  });

  test('the retry window stays under the flash TTL', () => {
    // live-writer drops _pendingFlash after 60s. A retry window longer than
    // that would repaint with nothing left to decorate.
    const m = ED.match(/_typingRetryUntil = Date\.now\(\) \+ (\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeLessThan(60000);
  });

  test('the retry is bounded and single-flighted', () => {
    expect(ED).toMatch(/if \(_typingRetry\) return;/);
    expect(ED).toMatch(/Date\.now\(\) > _typingRetryUntil/);
  });
});
