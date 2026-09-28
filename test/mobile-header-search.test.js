/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * The phone header's search glass.
 *
 * Under 768px the header search box is hidden — a phone header has no room
 * for it — and #header-search-btn drops it open as a panel under the sticky
 * header. js/search.js owns the open/close.
 *
 * The trap this guards: search.js closes the widget on any document click
 * outside it, and the glass IS outside it. The glass's own handler opens the
 * panel, then the same click bubbles to document — so without the exemption
 * the panel shuts in the very tap that opened it, and the button reads as
 * dead. Every tap here is a real bubbling click so that ordering is live.
 *
 * Runs the REAL search.js against the REAL header markup from index.html.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SEARCH = fs.readFileSync(path.join(ROOT, 'js', 'search.js'), 'utf8');

const HEADER = INDEX.slice(INDEX.indexOf('<header>'), INDEX.indexOf('</header>') + '</header>'.length);

let navigated;
beforeAll(() => {
  document.body.innerHTML = HEADER + '<main id="page"><button id="elsewhere">x</button></main>';
  navigated = [];
  window.p86Router = { navigate: (r) => navigated.push(r) };
  window.p86Api = {
    get: () => Promise.resolve({ results: [
      { type: 'jobs', id: 'j1', name: 'RV0142 · Bayside Terrace Condos' },
      { type: 'clients', id: 'c1', name: 'Bayside Terrace HOA' }
    ] })
  };
  // eslint-disable-next-line no-eval
  window.eval(SEARCH);
});

const wrap = () => document.getElementById('app-sidebar-search');
const glass = () => document.getElementById('header-search-btn');
const input = () => document.getElementById('sidebar-search-input');
const isOpen = () => wrap().classList.contains('is-mopen');
function ensureClosed() { if (isOpen()) glass().click(); }

test('the header markup is what this test thinks it is (a check over nothing cannot fail)', () => {
  expect(HEADER.length).toBeGreaterThan(500);
  expect(wrap()).not.toBeNull();
  expect(glass()).not.toBeNull();
  expect(input()).not.toBeNull();
  expect(glass().getAttribute('aria-controls')).toBe('app-sidebar-search');
  expect(glass().getAttribute('data-p86-icon')).toBe('magnifying-glass');
});

test('one tap opens the panel — and it is still open after the click reaches document', () => {
  ensureClosed();
  glass().click();                       // bubbles to document's close-on-outside handler
  expect(isOpen()).toBe(true);
  expect(glass().getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(input());
});

test('the panel is pinned to the header\'s measured bottom edge, not a constant', () => {
  ensureClosed();
  glass().click();
  expect(wrap().style.getPropertyValue('--p86-msearch-top')).toMatch(/^\d+px$/);
});

test('tapping inside the panel keeps it open', () => {
  ensureClosed();
  glass().click();
  input().click();
  expect(isOpen()).toBe(true);
});

test('a second tap on the glass closes it', () => {
  ensureClosed();
  glass().click();
  glass().click();
  expect(isOpen()).toBe(false);
  expect(glass().getAttribute('aria-expanded')).toBe('false');
});

test('tapping anywhere else closes it', () => {
  ensureClosed();
  glass().click();
  document.getElementById('elsewhere').click();
  expect(isOpen()).toBe(false);
  expect(glass().getAttribute('aria-expanded')).toBe('false');
});

test('Escape closes it', () => {
  ensureClosed();
  glass().click();
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(isOpen()).toBe(false);
});

test('back/forward navigation closes it', () => {
  ensureClosed();
  glass().click();
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(isOpen()).toBe(false);
});

test('picking a result navigates to it and closes the panel', async () => {
  ensureClosed();
  glass().click();
  input().value = 'bay';
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 260));   // search.js debounces 200ms
  const row = document.querySelector('.sidebar-search-item[data-type="jobs"]');
  expect(row).not.toBeNull();
  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  expect(navigated).toEqual([{ top: 'jobs', jobId: 'j1' }]);
  expect(isOpen()).toBe(false);
});

test('an outside click never marks a panel open that nobody opened (desktop path)', () => {
  ensureClosed();
  document.getElementById('elsewhere').click();
  expect(isOpen()).toBe(false);
  expect(glass().getAttribute('aria-expanded')).toBe('false');
});

describe('the CSS that makes it a phone-only control', () => {
  const CSS = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');

  test('the glass is hidden by default and shown only under 768px', () => {
    expect(CSS).toMatch(/#header-search-btn \{ display: none; \}\n\s*@media \(max-width: 768px\) \{\n\s*#header-search-btn \{ display: inline-flex; \}/);
  });

  test('the open panel reads the measured top and sets a 16px input (iOS zooms under 16px)', () => {
    const i = CSS.indexOf('#app-sidebar-search.in-header.is-mopen {');
    expect(i).toBeGreaterThan(-1);
    const block = CSS.slice(i, CSS.indexOf('}', i));
    expect(block).toContain('top: var(--p86-msearch-top');
    expect(block).toContain('position: fixed');
    expect(CSS).toMatch(/#app-sidebar-search\.in-header\.is-mopen \.sidebar-search-input \{\n\s*font-size: 16px;/);
  });
});
