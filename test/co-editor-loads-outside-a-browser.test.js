/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * js/change-order-editor.js MUST BE REQUIRABLE IN NODE, AND MUST STILL WIRE
 * ITSELF UP IN A BROWSER.
 *
 * The editor is a browser IIFE that deliberately exposes a `__test` seam, and
 * test/estimate-line-addressability.test.js requires it directly in the
 * default `node` environment. When a top-level
 * `document.addEventListener('p86:payload-applied', …)` was added, that
 * require threw and took the whole CO-editor block of that file down — three
 * tests that read as broken assertions about line ids, with nothing in the
 * message about a missing DOM.
 *
 * Guarding the listener fixes that, and a guard is exactly the kind of fix
 * that can quietly go too far: `if (false)` also makes the require succeed,
 * and also silently deletes the feature. So this file asserts BOTH halves —
 * it loads without a DOM, and it still subscribes when there is one.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'js', 'change-order-editor.js');

describe('the change-order editor loads outside a browser', () => {
  test('requiring it with no document does not throw', () => {
    // The real thing: a fresh module registry, and `document` genuinely gone,
    // which is what the node test environment hands the other file.
    jest.isolateModules(() => {
      const realDoc = global.document;
      const realWin = global.window;
      // eslint-disable-next-line no-global-assign
      delete global.document;
      global.window = { p86Pricing: {} };
      try {
        expect(() => require(SRC)).not.toThrow();
      } finally {
        global.document = realDoc;
        global.window = realWin;
      }
    });
  });

  test('and its __test seam is usable there — which is why it must load', () => {
    jest.isolateModules(() => {
      const realDoc = global.document;
      const realWin = global.window;
      delete global.document;
      global.window = { p86Pricing: {} };
      try {
        const editor = require(SRC);
        expect(editor.__test).toBeTruthy();
        editor.__test.setCo({ id: 1, title: 'CO', lines: [] });
        expect(editor.__test.getCo().id).toBe(1);
      } finally {
        global.document = realDoc;
        global.window = realWin;
      }
    });
  });
});

describe('but in a browser it still subscribes', () => {
  test('it registers a p86:payload-applied listener when a document exists', () => {
    // The guard must be `typeof document !== 'undefined'`, never something
    // that is false everywhere — that would pass the load test above while
    // deleting the glow-on-write behaviour the listener exists for.
    jest.isolateModules(() => {
      const added = [];
      const realAdd = document.addEventListener.bind(document);
      document.addEventListener = (type, fn, opts) => {
        added.push(type);
        return realAdd(type, fn, opts);
      };
      const realWin = global.window;
      global.window = Object.assign(global.window || {}, { p86Pricing: {} });
      try {
        require(SRC);
        expect(added).toContain('p86:payload-applied');
      } finally {
        document.addEventListener = realAdd;
        global.window = realWin;
      }
    });
  });

  test('the guard names `document`, not a flag that could be off in a browser too', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const at = src.indexOf("document.addEventListener('p86:payload-applied'");
    expect(at).toBeGreaterThan(-1);
    // The 400 characters before it must contain the typeof check.
    expect(src.slice(Math.max(0, at - 400), at)).toContain("typeof document !== 'undefined'");
  });
});
