/**
 * @jest-environment jsdom
 */
/* ═══════════════════════════════════════════════════════════════════════════
 * THE 86 CHAT IS A DOCKED SIDE PANEL, NOT A SHEET OVER THE PAGE.
 *
 * Opening it pushes the app across by exactly its own width. That worked only
 * at one width: the stylesheet pushed the page by a CONSTANT 420px while the
 * drawer itself is drag-resizable, so widening the chat left it sitting on top
 * of the right-hand side of whatever you were reading — the totals chips, the
 * right column of a table.
 *
 * What is pinned here:
 *   - the page is pushed by the drawer's LIVE width (a CSS variable), never a
 *     constant;
 *   - dragging republishes that width on every move, so the page tracks the
 *     drag instead of jumping at the end;
 *   - the drawer stays locked to the edge: a drag only ever changes its WIDTH,
 *     never its position;
 *   - in push mode the width is capped so the app keeps a workable column,
 *     and below the overlay breakpoint the old 92% behaviour returns.
 *
 * The functions are lifted out of js/ai-panel.js and run for real, so a change
 * to the real code changes this test.
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ai-panel.js'), 'utf8');

// The width rules, with their constants, exactly as the file declares them.
const CONSTS = [
  'var AI_PANEL_WIDTH_MIN = 320;',
  'var AI_PANEL_WIDTH_MAX_FRAC = 0.92;',
  'var AI_PUSH_MIN_VIEWPORT = 1100;',
  'var AI_PANEL_PUSH_MAX_FRAC = 0.66;',
  'var AI_PAGE_MIN = 560;',
].join('\n');

function clampAt(viewportWidth) {
  const win = { innerWidth: viewportWidth };
  return compile(
    [CONSTS, extractFunction(src, 'pushMode'), extractFunction(src, 'clampAIPanelWidth')],
    ['window'], [win], 'clampAIPanelWidth'
  );
}

describe('the width the drawer is allowed to take', () => {
  test('on a wide screen it is capped by the share of the viewport', () => {
    const clamp = clampAt(1600);        // 66% = 1056, page keeps 1600-560 = 1040
    expect(clamp(9999)).toBe(1040);
    expect(clamp(500)).toBe(500);
  });

  test('on a tighter desktop the APP keeps a workable column, not a sliver', () => {
    // 66% of 1280 is 844, which would leave the app 436px — narrower than the
    // tables it has to draw. The page minimum wins.
    const clamp = clampAt(1280);
    expect(clamp(9999)).toBe(720);
  });

  test('below the push breakpoint it is an overlay again, and may take 92%', () => {
    const clamp = clampAt(900);
    expect(clamp(9999)).toBe(828);
  });

  test('exactly at the breakpoint it matches the stylesheet, which does NOT push at 1100', () => {
    // The media query is max-width:1100px and includes 1100, so 1100 is overlay.
    expect(clampAt(1100)(9999)).toBe(1012);   // 92% — overlay
    expect(clampAt(1101)(9999)).toBe(541);    // pushed: 1101-560 bites before 66%
  });

  test('it never goes under the minimum, however small the window', () => {
    expect(clampAt(1600)(10)).toBe(320);
    expect(clampAt(900)(10)).toBe(320);
    // A window so narrow the maximum would fall UNDER the minimum: a 200px
    // chat is not a chat, so the minimum wins.
    expect(clampAt(300)(9999)).toBe(320);
  });
});

describe('the page is pushed by the drawer’s own width', () => {
  const at = src.indexOf("'body.p86-ai-open {");
  const styleText = src.slice(at, at + 160);

  test('the push reads the live variable, never a hard-coded width', () => {
    expect(styleText).toContain('padding-right: var(--p86-ai-w');
    expect(styleText).not.toMatch(/padding-right:\s*\d+px/);
  });

  test('the overlay fallback for narrow screens is still there', () => {
    expect(src).toContain('@media (max-width: 1100px) { body.p86-ai-open { padding-right: 0; } }');
  });
});

describe('dragging the edge', () => {
  // The real handler, wired to a real element tree.
  function mount(viewportWidth) {
    window.innerWidth = viewportWidth;
    document.body.innerHTML = '';
    document.documentElement.style.removeProperty('--p86-ai-w');
    const panel = document.createElement('div');
    panel.id = 'p86-ai-panel';
    panel.style.width = '420px';
    panel.innerHTML = '<div id="ai-panel-resizer" role="separator" tabindex="0"><div></div></div>';
    document.body.appendChild(panel);
    document.body.classList.add('p86-ai-open');

    // getBoundingClientRect is not laid out in jsdom: report the inline width.
    panel.getBoundingClientRect = () => ({ width: parseInt(panel.style.width, 10) || 0 });

    const published = [];
    const publishAIWidth = () => {
      const w = Math.round(panel.getBoundingClientRect().width);
      document.documentElement.style.setProperty('--p86-ai-w', w + 'px');
      published.push(w);
    };
    const saved = [];
    const wire = compile(
      [CONSTS, extractFunction(src, 'pushMode'), extractFunction(src, 'clampAIPanelWidth'),
        extractFunction(src, 'wireAIPanelResizer')],
      ['window', 'document', 'publishAIWidth', 'saveAIPanelWidth'],
      [window, document, publishAIWidth, (px) => saved.push(px)],
      'wireAIPanelResizer'
    );
    wire(panel);
    return { panel, published, saved, handle: panel.querySelector('#ai-panel-resizer') };
  }

  const down = (el, x) => el.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: x, bubbles: true, cancelable: true }));
  const move = (x) => document.dispatchEvent(new window.PointerEvent('pointermove', { clientX: x, bubbles: true }));
  const up = () => document.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }));

  beforeAll(() => {
    // jsdom has no PointerEvent; MouseEvent carries everything used here.
    if (typeof window.PointerEvent !== 'function') window.PointerEvent = window.MouseEvent;
  });

  test('dragging left widens the drawer, and the PAGE follows on every move', () => {
    const m = mount(1600);
    down(m.handle, 1000);
    move(900);
    expect(m.panel.style.width).toBe('520px');
    // The page tracked the drag rather than jumping at the end.
    expect(m.published).toContain(520);
    expect(document.documentElement.style.getPropertyValue('--p86-ai-w')).toBe('520px');
    move(800);
    expect(m.panel.style.width).toBe('620px');
    up();
    expect(m.saved).toEqual([620]);
  });

  test('dragging right narrows it, and it stops at the minimum', () => {
    const m = mount(1600);
    down(m.handle, 1000);
    move(1400);                       // 420 - 400 => under the minimum
    expect(m.panel.style.width).toBe('320px');
    up();
  });

  test('a drag can never widen it past the cap that protects the page', () => {
    const m = mount(1600);
    down(m.handle, 1000);
    move(-5000);
    expect(m.panel.style.width).toBe('1040px');
    up();
  });

  test('the drawer stays LOCKED to the edge — a drag moves no position, only width', () => {
    const m = mount(1600);
    const before = { left: m.panel.style.left, right: m.panel.style.right, transform: m.panel.style.transform };
    down(m.handle, 1000);
    move(600);
    up();
    expect({ left: m.panel.style.left, right: m.panel.style.right, transform: m.panel.style.transform }).toEqual(before);
  });

  test('the width is remembered once, on release — not on every pixel of the drag', () => {
    const m = mount(1600);
    down(m.handle, 1000);
    move(950); move(900); move(850);
    expect(m.saved).toEqual([]);
    up();
    expect(m.saved.length).toBe(1);
  });

  test('keyboard resizes it too, and Home returns it to the default', () => {
    const m = mount(1600);
    const key = (k, shift) => m.handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, shiftKey: !!shift, bubbles: true, cancelable: true }));
    key('ArrowLeft');
    expect(m.panel.style.width).toBe('436px');
    key('ArrowLeft', true);
    expect(m.panel.style.width).toBe('500px');
    key('ArrowRight');
    expect(m.panel.style.width).toBe('484px');
    key('Home');
    expect(m.panel.style.width).toBe('420px');
    // Every keyboard change is remembered, because there is no "release".
    expect(m.saved).toEqual([436, 500, 484, 420]);
  });

  test('a key that is not a resize key is left alone', () => {
    const m = mount(1600);
    m.handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    expect(m.panel.style.width).toBe('420px');
    expect(m.saved).toEqual([]);
  });

  test('double-clicking the grip resets the width', () => {
    const m = mount(1600);
    down(m.handle, 1000); move(700); up();
    expect(m.panel.style.width).toBe('720px');
    m.handle.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(m.panel.style.width).toBe('420px');
  });
});

describe('the grip can be found and used', () => {
  test('it is a real control: focusable, named, and a separator', () => {
    const g = src.indexOf('<div id="ai-panel-resizer"');
    const grip = src.slice(g, g + 900);
    expect(grip).toContain('role="separator"');
    expect(grip).toContain('tabindex="0"');
    expect(grip).toContain('aria-label="Resize chat panel"');
    // Without this a finger drag scrolls the page instead of resizing.
    expect(grip).toContain('touch-action:none');
  });
});
