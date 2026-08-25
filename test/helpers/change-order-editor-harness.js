/* ──────────────────────────────────────────────────────────────────────────
 * test/helpers/change-order-editor-harness.js — boot the SHIPPED change-order
 * editor in jsdom and drive it THROUGH ITS OWN CONTROLS.
 *
 * WHY THIS AND NOT AN ANCHOR LIFT. The other change-order suites cut named
 * functions out of the source with string anchors and run them inside a
 * hand-built sandbox whose markDirty/paintLines are stubs. That shape is right
 * for what those suites measure, and useless for a LOCK: the stub IS the thing
 * a lock guard would live behind, so a lifted sandbox cannot see whether the
 * record refused. This harness therefore loads the WHOLE file, unmodified, and
 * clicks the real elements the real painter produced.
 *
 * THE __test DOOR IN A BROWSER FILE. js/change-order-editor.js exports its
 * __test seam behind `typeof module !== 'undefined' && module.exports`, which
 * is false in a browser and therefore false in jsdom. Shimming `window.module`
 * before the <script> runs opens that same door without touching the file —
 * the editor still runs as the IIFE the browser runs, and setCo is the same
 * assignment openExisting() makes, accessor and all. A harness that can hand
 * the editor a state the app cannot produce proves nothing about the app.
 *
 * Nothing here models the lock, the strip, the explode or the save. Every one
 * of those comes out of the file under test.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..', '..');

const OPEN = new Set();
function closeAll() { OPEN.forEach((w) => { try { w.close(); } catch (e) {} }); OPEN.clear(); }

// The DOM the editor paints into. Every id here is a getElementById /
// querySelector target in the shipped file — nothing is invented.
const SHELL = `<!doctype html><html><body>
<div id="co-editor-overlay"><div class="p86-co-host">
  <div class="p86-co-topbar"></div>
  <div id="p86CoLineTable"></div>
  <div id="p86CoSaveStatus"></div>
  <div id="p86CoTotals"></div>
</div></div></body></html>`;

function boot(opts) {
  opts = opts || {};
  // pretendToBeVisual stays OFF — it installs a rAF loop that keeps the jest
  // worker alive after the test ends.
  const dom = new JSDOM(SHELL, { runScripts: 'dangerously', url: 'https://project86.net/' });
  OPEN.add(dom.window);
  const w = dom.window;

  // Ambient globals, counted rather than faked away: "did the action reach the
  // server" and "was the person told anything" are both assertions here.
  w.eval(`
    window.escapeHTML = function(s){ return String(s==null?'':s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); };
    window.__puts = []; window.__alerts = []; window.__notices = []; window.__warns = [];
    window.alert = function(m){ window.__alerts.push(String(m)); };
    window.__confirm = true;
    window.p86Confirm = function(o){ window.__lastConfirm = o;
      return Promise.resolve(window.__confirm !== false); };
    window.p86Alert = function(o){ window.__notices.push(o); return Promise.resolve(true); };
    window.console = window.console || {};
    window.console.warn = function(m){ window.__warns.push(String(m)); };
    window.p86Api = { changeOrders: {
      update: function(id, body){ window.__puts.push({ id: id, body: body }); return Promise.resolve({}); },
      lock: function(){ return Promise.resolve({}); } } };
    window.p86Icon = function(){ return ''; };
    window.fetch = function(){ return Promise.reject(new Error('no net')); };
    window.module = { exports: {} };
  `);

  const loadAbs = (abs) => {
    const s = w.document.createElement('script');
    s.textContent = fs.readFileSync(abs, 'utf8');
    w.document.body.appendChild(s);
  };
  loadAbs(path.join(REPO, 'js/line-identity.js'));
  loadAbs(path.join(REPO, 'js/pricing-pipeline.js'));
  // editorFile — an ABSOLUTE path loaded INSTEAD of the working tree's editor.
  // The only caller is the suite that boots a PRIOR git blob beside the current
  // one to prove a change moved nothing it did not mean to move.
  loadAbs(opts.editorFile || path.join(REPO, 'js/change-order-editor.js'));

  const T = w.module.exports && w.module.exports.__test;
  if (!T) throw new Error('__test door did not open — the module shim failed');

  const table = () => w.document.getElementById('p86CoLineTable');

  const api = {
    w, dom, T,
    // THE door: the same assignment openExisting() makes.
    setCo(co) { T.setCo(JSON.parse(JSON.stringify(co))); T.paintLines(); return api; },
    co() { return T.getCo(); },
    lines() { return (T.getCo() && T.getCo().lines) || []; },
    html() { return table().innerHTML; },
    // Real elements, real clicks — the painter decides what exists.
    click(sel) { const el = table().querySelector(sel); if (el) el.click(); return !!el; },
    exists(sel) { return !!table().querySelector(sel); },
    puts() { return w.__puts; },
    notices() { return w.__notices; },
    alerts() { return w.__alerts; },
    warns() { return w.__warns; },
    saveStatus() { return (w.document.getElementById('p86CoSaveStatus').textContent || '').trim(); },
  };
  return api;
}

// Snapshot of everything EXCEPT identity, so "an explode produced the same
// parts" survives a legitimately-regenerated line id.
function withoutIds(lines) {
  return (lines || []).map((l) => {
    if (!l || typeof l !== 'object') return l;
    const c = Object.assign({}, l);
    delete c.id;
    return c;
  });
}

module.exports = { boot, closeAll, withoutIds, REPO };
