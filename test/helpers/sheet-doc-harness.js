// Headless harness for the CAD sheet editor's document model.
//
// js/sheet-editor.js is a browser IIFE that exposes its v3 migration
// internals on `window.p86SheetEditor._v3` with the comment "exposed for
// round-trip verification". Nothing ever used them. This loads the REAL
// shipped file in a VM sandbox with a stub DOM so the persistence chain can
// be exercised in node — no browser, no jsdom, no copy of the logic.
//
// Loading the real file is the point: a re-implementation here would test a
// second definition of the document, which is exactly the class of bug this
// harness exists to catch.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EDITOR_PATH = path.join(__dirname, '..', '..', 'js', 'sheet-editor.js');

function loadSheetEditor() {
  const src = fs.readFileSync(EDITOR_PATH, 'utf8');
  const win = {};
  const stubEl = function () {
    return {
      style: {}, dataset: {}, children: [],
      appendChild() {}, removeChild() {}, addEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; },
      getContext() { return null; }
    };
  };
  const sandbox = {
    window: win,
    document: {
      createElement: stubEl, createElementNS: stubEl,
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }
    },
    navigator: { userAgent: 'node' },
    location: { href: 'http://localhost/' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
    Blob: function () {},
    Image: function () {},
    URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    requestAnimationFrame(fn) { return setTimeout(fn, 0); },
    cancelAnimationFrame(t) { clearTimeout(t); }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'sheet-editor.js' });
  if (!win.p86SheetEditor || !win.p86SheetEditor._v3) {
    throw new Error('sheet-editor.js did not expose _v3 — the round-trip harness cannot run');
  }
  return win.p86SheetEditor;
}

const SE = loadSheetEditor();
const V = SE._v3;

const clone = (o) => JSON.parse(JSON.stringify(o));

// What js/plans.js + js/sheet-editor.js actually do on open:
//   GET /api/plans/:id -> plan.pages -> loadDoc(plan)
// loadDoc is `healDoc(toV3(toV2(pages[0])))` when pages[0] is a sheet-doc,
// else it builds a default doc. Reproduced here against the real functions.
function loadDoc(plan) {
  const pages = plan && plan.pages;
  const d = (Array.isArray(pages) && pages[0] && pages[0].kind === 'sheet-doc')
    ? clone(pages[0]) : SE.defaultDoc(plan);
  return V.healDoc(V.toV3(V.toV2(d)));
}

// What the editor sends on save: onSave(serializeDoc(S.doc), {}) ->
// api.plans.update(id, { pages: [doc] }) -> sanitizePages on the server.
function serialize(doc) { return clone(V.serializeDoc(doc)); }

const PLAN = { id: 'plan_test', name: 'Test Sheet', width: 2000, height: 1400, grid_spacing: 12 };

function freshDoc(plan) { return loadDoc(Object.assign({}, PLAN, plan || {}, { pages: null })); }

module.exports = { SE, V, loadDoc, serialize, clone, freshDoc, PLAN, EDITOR_PATH };
