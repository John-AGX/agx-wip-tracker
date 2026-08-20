// Manufacture REAL wreckage — the state 38 days of production actually wrote
// into `plans.pages` — instead of hand-typing a fixture that is "destroyed"
// only because it was typed that way.
//
// A fixture built by hand proves nothing about a classifier: it is destroyed
// by construction, so of course it classifies as destroyed. The row that has
// to be classified correctly is the one the BUG produced, and the only way to
// be sure of its shape is to run a populated document through the pipeline
// that produced it.
//
// So this rebuilds both pre-fix halves BY MUTATING THE SHIPPED SOURCES:
//
//   1. js/sheet-editor.js toV2() — remove the empty-never-wins guard added by
//      9c9f6d6, restoring the unguarded broken-alias rescue from 1c73da1.
//   2. server/services/plan-doc.js sanitizeSheetDoc() — restore the
//      `Array.isArray(x) ? … : []` defaults that synthesized `entities: []`
//      onto every stored v2/v3 doc.
//
// Both halves are required; neither alone loses anything (proved in
// plan-recovery-census.test.js). Mutating the shipped source rather than
// vendoring a copy of the old files means this cannot quietly stop testing
// anything: every substitution below asserts it matched, so if the guard is
// ever reworded, deleted or "simplified" away, these helpers throw at load
// and the suites that use them go red — which is the correct outcome, because
// a guard that no longer exists in that shape is a guard that needs re-proving.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./sheet-doc-harness');

const EDITOR_PATH = H.EDITOR_PATH;
const PLAN_DOC_PATH = path.join(__dirname, '..', '..', 'server', 'services', 'plan-doc.js');

// Apply a substitution and REFUSE to continue if it matched nothing. A silent
// no-op here would leave the "pre-fix" pipeline identical to the shipped one,
// and every destruction assertion below it would pass for the wrong reason.
function mutate(src, re, replacement, what) {
  const g = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g');
  const hits = src.match(g);
  if (!hits || !hits.length) {
    throw new Error(
      'plan-wreckage: cannot rebuild the pre-fix pipeline — "' + what + '" no longer ' +
      'matches the shipped source. The guard this mutation removes has moved or ' +
      'changed shape; re-derive it before trusting any suite that loads this helper.');
  }
  return src.replace(g, replacement);
}

// ── Half 1: the editor's UNGUARDED broken-alias rescue ──────────────────
// Shipped:  if (Array.isArray(doc.entities) && doc.entities !== doc.model.entities &&
//               (doc.entities.length || !doc.model.entities.length)) doc.model.entities = doc.entities;
// Pre-fix:  if (Array.isArray(doc.entities) && doc.entities !== doc.model.entities) doc.model.entities = doc.entities;
function preFixEditor() {
  let src = fs.readFileSync(EDITOR_PATH, 'utf8');
  src = mutate(src, /\s*&&\r?\n\s*\(doc\.entities\.length \|\| !doc\.model\.entities\.length\)\)/,
    ')', 'toV2 entities empty-never-wins guard');
  src = mutate(src, /\s*&&\r?\n\s*\(doc\.layers\.length \|\| !doc\.model\.layers\.length\)\)/,
    ')', 'toV2 layers empty-never-wins guard');
  return H.loadSheetEditor(src);
}

// ── Half 2: the SYNTHESIZING sanitizer ──────────────────────────────────
// Shipped:  if (Array.isArray(pg.entities)) out.entities = pg.entities.slice(0, MAX_ENTITIES);
// Pre-fix:  out.entities = Array.isArray(pg.entities) ? pg.entities.slice(0, MAX_ENTITIES) : [];
// plus model.entities defaulted to [] the same way. `capArr` is the shipped
// helper; calling it keeps the caps identical between the two pipelines so the
// only difference under test is the synthesis.
function preFixPlanDoc() {
  let src = fs.readFileSync(PLAN_DOC_PATH, 'utf8');
  [['entities', 'MAX_ENTITIES'], ['layers', 'MAX_LAYERS'], ['viewports', 'MAX_VIEWPORTS']].forEach(function (pair) {
    const k = pair[0], cap = pair[1];
    const re = new RegExp('if \\(Array\\.isArray\\(pg\\.' + k + '\\)\\) out\\.' + k +
      ' = capArr\\(pg\\.' + k + ', ' + cap + ", [^)]*\\);");
    src = mutate(src, re,
      'out.' + k + ' = Array.isArray(pg.' + k + ') ? pg.' + k + '.slice(0, ' + cap + ') : [];',
      'sanitizeSheetDoc flat ' + k + ' pass-through');
  });
  src = mutate(src,
    /if \(Array\.isArray\(pg\.model\.entities\)\) out\.model\.entities = capArr\(pg\.model\.entities, MAX_ENTITIES, [^)]*\);/,
    'out.model.entities = Array.isArray(pg.model.entities) ? pg.model.entities.slice(0, MAX_ENTITIES) : [];',
    'sanitizeSheetDoc model.entities pass-through');
  const m = { exports: {} };
  vm.runInThisContext('(function(module, exports, require, __filename, __dirname){' + src + '\n})',
    { filename: 'plan-doc.pre-fix.js' })(m, m.exports, require, PLAN_DOC_PATH, path.dirname(PLAN_DOC_PATH));
  return m.exports;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// The product's open path, against whichever editor build is passed in.
function loadWith(SE, pages) {
  const V = SE._v3;
  const d = (Array.isArray(pages) && pages[0] && pages[0].kind === 'sheet-doc')
    ? clone(pages[0]) : SE.defaultDoc(H.PLAN);
  return V.healDoc(V.toV3(V.toV2(d)));
}

// One open→edit→save cycle: exactly what a user did every time they reopened a
// plan. Returns the row as it lands in the database plus the entity count the
// user SAW on screen for that cycle.
function cycle(SE, PD, stored) {
  const doc = loadWith(SE, stored);
  const seen = doc.entities.length;
  return { stored: PD.sanitizePages([clone(SE._v3.serializeDoc(doc))]), seen: seen };
}

// Build a populated drawing, save it through `PD`, then reopen-and-resave it
// `cycles` times through (SE, PD). Returns the stored row and the per-cycle
// entity counts — the sequence that shows the drawing going to zero.
function run(SE, PD, entityCount, cycles) {
  const doc = loadWith(H.SE, null);
  const vp = doc.viewports[0].id;
  for (let i = 0; i < entityCount; i++) {
    doc.entities.push({
      id: 'E' + i, tool: 'line', layer: 'L0', viewport: vp,
      color: '#1f2937', lineWidth: 3, lineType: 'solid',
      startX: i, startY: 0, endX: i + 1, endY: 12.5
    });
  }
  let stored = PD.sanitizePages([clone(SE._v3.serializeDoc(doc))]);
  const seen = [];
  for (let i = 0; i < (cycles || 3); i++) {
    const r = cycle(SE, PD, stored);
    seen.push(r.seen);
    stored = r.stored;
  }
  return { stored: stored, seen: seen };
}

module.exports = { preFixEditor, preFixPlanDoc, loadWith, cycle, run, clone, mutate };
