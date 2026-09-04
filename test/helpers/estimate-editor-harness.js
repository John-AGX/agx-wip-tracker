/* ──────────────────────────────────────────────────────────────────────────
 * test/helpers/estimate-editor-harness.js — boot the SHIPPED estimate editor
 * in jsdom and hand records to it THROUGH ITS OWN DOORS.
 *
 * WHY A HARNESS AND NOT A REQUIRE. js/estimate-editor.js is a browser IIFE
 * whose module.exports seam carries two unrelated helpers. Everything this
 * suite is about — the render, the inline onchange handlers, the delete
 * confirm, the state boundary — only exists on `window`. So the file is
 * loaded as a <script> into a real jsdom document and driven the way the
 * page drives it: real elements, real events, real inline handlers.
 *
 * WHAT THE HARNESS MAY NOT DO, and this is the point of the file:
 * it may not assemble a state the application could not. Records go in
 * through exactly two doors, both of which the app itself uses —
 *
 *   hydrate(est, lines)  →  appData.estimates.push(meta)
 *                           appData.estimateLines = [...]      ← THE door
 *   open(id)             →  window.openEstimateEditor(id)
 *
 * — because the last time a workflow "fixed and verified" an identity bug in
 * the change-order editor it drove the real code in jsdom, passed, and was
 * useless: its fixtures gave every line an id, which is a shape imported
 * records do not have. A harness that can hand the editor a state the app
 * cannot produce proves nothing about the app.
 *
 * The boundary is NOT installed here. js/app.js installs it when appData is
 * created and js/estimate-editor.js re-confirms it on open; if this file
 * installed its own, the suite would be testing the harness. Records
 * therefore arrive unguarded and are healed by the shipped code or not at
 * all.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..', '..');

// Every window this helper opens, so a suite can shut them all at the end even
// if a test threw before its own close().
const OPEN = new Set();
function closeAll() { OPEN.forEach((w) => { try { w.close(); } catch (e) {} }); OPEN.clear(); }

// The DOM ids js/estimate-editor.js paints into. Nothing here is invented —
// each one is a getElementById target in the shipped file.
const SHELL = `<!doctype html><html><body>
<div id="estimates-list-view"></div>
<div id="estimate-editor-view">
  <input id="ee-title" />
  <div id="ee-lines-container"></div>
  <div id="ee-totals"></div>
  <div id="ee-save-indicator"></div>
  <div id="ee-alt-tabs"></div>
  <div id="ee-details-form"></div>
  <div id="ee-scope-panel-page"></div>
  <div id="ee-header-chips"></div>
  <div id="ee-sidebar-card"></div>
</div></body></html>`;

function boot(opts) {
  opts = opts || {};
  // pretendToBeVisual is deliberately OFF. It installs a requestAnimationFrame
  // loop that keeps the jsdom window — and therefore the jest worker — alive
  // after the test ends ("a worker process has failed to exit gracefully").
  // Nothing in js/estimate-editor.js needs rAF; the one visual probe it makes,
  // window.matchMedia, is already guarded for its absence.
  const dom = new JSDOM(SHELL, {
    runScripts: 'dangerously',
    url: 'https://project86.net/',
  });
  OPEN.add(dom.window);
  const w = dom.window;

  // The ambient globals the editor reads. escapeHTML is copied from the
  // app's own definition; the rest are the minimum stubs that let the file
  // run headless. saveData is counted, not faked away — "did the keystroke
  // arm a save" is one of the things the CO bug got wrong while the pill
  // said "Saved".
  w.eval(`
    window.escapeHTML = function(str){ if(str===null||str===undefined) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); };
    window.appData = { estimates: [], estimateLines: [], estimateAlternates: [],
                       jobs: [], leads: [], clients: [] };
    appData = window.appData;
    window.__saves = 0;
    window.saveData = function(){ window.__saves++; };
    saveData = window.saveData;
    window.__alerts = [];
    window.alert = function(m){ window.__alerts.push(String(m)); };
    window.__confirm = true;
    window.p86Confirm = function(){ return Promise.resolve(window.__confirm !== false); };
    window.p86Prompt = function(){ return Promise.resolve(window.__promptValue == null ? 'X' : window.__promptValue); };
    window.p86DataLoading = function(){ return false; };
    window.p86NavSave = function(){};
    window.p86Icon = function(){ return ''; };
    window.p86MountLeadCard = function(){};
    window.fetch = function(){ return Promise.reject(new Error('no net')); };
  `);

  const loadAbs = (abs) => {
    const s = w.document.createElement('script');
    s.textContent = fs.readFileSync(abs, 'utf8');
    w.document.body.appendChild(s);
  };
  const load = (rel) => loadAbs(path.join(REPO, rel));
  // Load order mirrors index.html: line-identity first (app.js and both
  // editors read window.p86LineIdentity), then pricing, then the editor.
  if (opts.withIdentity !== false) load('js/line-identity.js');
  // js/dom-ref.js — the encoder that carries a stored id into an attribute and
  // back without either parser touching it. index.html loads it beside
  // line-identity.js, before everything that paints, and both editors treat
  // it as a hard dependency: without it eeKey paints an empty address on
  // purpose rather than falling back to interpolating the stored bytes.
  if (opts.withDomRef !== false) load('js/dom-ref.js');
  load('js/pricing-pipeline.js');
  // opts.editorFile — an ABSOLUTE path to load INSTEAD of the working tree's
  // js/estimate-editor.js. The only caller is a test that boots a PRIOR git
  // blob beside the current one to prove a change moved nothing it did not
  // mean to move; every other caller gets the shipped file and cannot tell
  // this option exists.
  if (opts.editorFile) loadAbs(opts.editorFile);
  else load('js/estimate-editor.js');

  const api = {
    dom,
    w,
    // THE HYDRATE DOOR, byte for byte what js/app.js's
    // hydrateFromServerEstimates does: estimate meta on appData.estimates
    // with `lines` stripped, every line flattened into ONE portfolio-wide
    // appData.estimateLines, assigned wholesale.
    hydrate(records) {
      const flat = [];
      (Array.isArray(records) ? records : [records]).forEach((rec) => {
        const meta = Object.assign({}, rec);
        delete meta.lines;
        w.appData.estimates.push(meta);
        Array.prototype.push.apply(flat, rec.lines || []);
      });
      w.appData.estimateLines = flat;
      return api;
    },
    open(id) { w.openEstimateEditor(id); return api; },
    lines() { return w.appData.estimateLines; },
    // Every rendered row, in document order, with the id it is ADDRESSED by.
    //
    // `id` is the STORED id the row resolves to — the attribute is the
    // ENCODED form of it (js/dom-ref.js), because an attribute value the HTML
    // parser has normalised is no longer the stored bytes. `key` is the raw
    // attribute, for the tests that are about the encoding itself.
    rows() {
      const dec = (v) => (w.p86DomRef ? w.p86DomRef.dec(v) : v);
      return Array.from(
        w.document.querySelectorAll('#ee-lines-container [data-line-id]')
      ).map((el) => {
        const key = el.getAttribute('data-line-id');
        return { el, key, id: dec(key) };
      });
    },
    // Drive a real inline onchange the way a user's blur does.
    typeInto(rowEl, cellField, value) {
      const cell = rowEl.querySelector('[data-cell="' + cellField + '"] input, [data-cell="' + cellField + '"] textarea');
      if (!cell) throw new Error('no ' + cellField + ' cell on this row');
      cell.value = String(value);
      cell.dispatchEvent(new w.Event('change', { bubbles: true }));
      cell.dispatchEvent(new w.Event('input', { bubbles: true }));
      return cell;
    },
    saves() { return w.__saves; },
  };
  return api;
}

// Snapshot of everything EXCEPT identity, so "the heal touched nothing but
// `id`" is checkable as one equality.
function withoutIds(lines) {
  return (lines || []).map((l) => {
    if (!l || typeof l !== 'object') return l;
    const c = Object.assign({}, l);
    delete c.id;
    return c;
  });
}

// WHICH SECTION IS EACH LINE IN. This is the money-safety signature: an
// estimate's sections are delimited by __section_header__ rows and a line
// belongs to the nearest header ABOVE it in the array — nothing on the line
// records it. Anything that reorders, drops or de-duplicates the array
// silently re-sections the estimate and moves money between scopes while the
// cost total sits still. Keyed by description + ordinal so it survives a
// legitimate id change and catches a positional one.
function membership(lines) {
  const out = [];
  let header = null;
  let n = 0;
  (lines || []).forEach((l) => {
    if (!l || typeof l !== 'object') return;
    if (l.section === '__section_header__') { header = l.description || '(unnamed)'; return; }
    out.push(`#${n++} ${l.description || ''} :: ${header === null ? '(no section)' : header}`);
  });
  return out;
}

// What the SHARED pricing module says about one group of one record. Not a
// re-derivation — js/pricing-pipeline.js is the single pricing implementation
// and this suite is forbidden from forking it.
function priceGroup(P, est, lines, alternateId) {
  const altId = alternateId === undefined ? est.activeAlternateId : alternateId;
  const group = (lines || []).filter((l) => l && l.alternateId === altId);
  const per = P.computeForLines(est, group);
  const markedUp = P.resolveMarkedUp(per, est);
  const ft = P.applyFeesAndTax(P.num(markedUp), est, P.sumOfPriced([per]));
  return {
    cost: per.subtotal.toFixed(2),
    sell: P.num(markedUp).toFixed(2),
    total: ft.total.toFixed(2),
  };
}

module.exports = { boot, closeAll, withoutIds, membership, priceGroup, REPO };
