// Plan document persistence — the `plans.pages` JSONB shape.
//
// Extracted from plans-routes.js so it can be unit-tested without booting
// the auth stack (requiring server/routes/* pulls in JWT_SECRET; pure logic
// belongs in services/ where a test can reach it).
//
// `pages` holds one of two shapes:
//   markup plans (base_kind blank/photo/pdf) — an array of
//     { page:int, calibration:obj|null, strokes:[...] }
//   sheet plans (base_kind 'sheet', the CAD editor) — a single
//     { kind:'sheet-doc', ... } document.
//
// ── The alias trap (read this before editing sanitizeSheetDoc) ──────────
// A sheet-doc carries the drawing TWICE in the v1 shape: flat `entities`/
// `layers` and `model.entities`/`model.layers`. From v2 onward `model.*` is
// the truth and js/sheet-editor.js `serializeDoc()` DELETES the flat aliases
// before sending, rebuilding them from `model.*` via `toV2()` on load.
//
// This sanitizer used to default the flat keys — `entities: Array.isArray(
// pg.entities) ? … : []` — which wrote `entities: []` onto EVERY stored v2/v3
// doc. `toV2()`'s broken-alias rescue then adopted that empty array as truth
// and every sheet drawing reloaded blank while its geometry sat intact in
// `model.entities`. Two data-loss fixes, landed a week apart, combining into
// a third data-loss bug.
//
// The rule that prevents it recurring: NEVER SYNTHESIZE A KEY THE CLIENT DID
// NOT SEND. Absent means absent. A v1 doc sends the flat arrays and keeps
// them; a v2/v3 doc does not send them and must not grow them. Cap sizes,
// pass shapes through, invent nothing.

'use strict';

const MAX_PAGES = 200;
const MAX_ENTITIES = 20000;
const MAX_LAYERS = 200;
const MAX_VIEWPORTS = 50;
const MAX_SHEETS = 50;
const MAX_BLOCKS = 200;
const MAX_STROKES = 5000;

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// Sheet-doc (CAD shop-drawing) — pass the document through with size caps
// only. Every key is conditional on the client having sent it.
function sanitizeSheetDoc(pg) {
  const out = {
    kind: 'sheet-doc',
    version: Number.isFinite(pg.version) ? (pg.version | 0) : 1
  };

  // Flat v1 working aliases: kept ONLY when actually present. serializeDoc
  // strips these from v2/v3 docs, and defaulting them to [] is what gutted
  // the drawing on the next load.
  if (isObj(pg.sheet)) out.sheet = pg.sheet;
  if (isObj(pg.titleblock)) out.titleblock = pg.titleblock;
  if (Array.isArray(pg.layers)) out.layers = pg.layers.slice(0, MAX_LAYERS);
  if (Array.isArray(pg.viewports)) out.viewports = pg.viewports.slice(0, MAX_VIEWPORTS);
  if (Array.isArray(pg.entities)) out.entities = pg.entities.slice(0, MAX_ENTITIES);

  // v2/v3 truth. Pass model through WHOLE (caps only, no field whitelist) —
  // a whitelist here is exactly what caused the original data loss.
  if (isObj(pg.model)) {
    out.model = Object.assign({}, pg.model);
    if (Array.isArray(pg.model.entities)) out.model.entities = pg.model.entities.slice(0, MAX_ENTITIES);
    if (Array.isArray(pg.model.layers)) out.model.layers = pg.model.layers.slice(0, MAX_LAYERS);
  }
  if (Array.isArray(pg.sheets)) out.sheets = pg.sheets.slice(0, MAX_SHEETS);
  if (Array.isArray(pg.blocks)) {
    // Named block definitions (W3) — cap count AND each def's entity list so
    // defs can't smuggle geometry past the per-sheet entity budget.
    out.blocks = pg.blocks.slice(0, MAX_BLOCKS).map(function (bk) {
      bk = bk || {};
      return Object.assign({}, bk, {
        entities: Array.isArray(bk.entities) ? bk.entities.slice(0, MAX_ENTITIES) : []
      });
    });
  }
  if (pg.activeSheetId != null) out.activeSheetId = String(pg.activeSheetId);
  if (pg.space === 'sheet' || pg.space === 'model') out.space = pg.space;
  if (isObj(pg.underlay)) out.underlay = pg.underlay;
  return out;
}

// Coerce the `pages` payload to a safe JSONB-able array. We don't deeply
// validate stroke/entity shapes (the client owns that + the renderer is
// defensive), but we cap sizes so a runaway payload can't bloat a row.
function sanitizePages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_PAGES).map(function (pg, i) {
    pg = pg || {};
    if (pg.kind === 'sheet-doc') return sanitizeSheetDoc(pg);
    return {
      page: Number.isFinite(pg.page) ? (pg.page | 0) : i,
      calibration: isObj(pg.calibration) ? pg.calibration : null,
      strokes: Array.isArray(pg.strokes) ? pg.strokes.slice(0, MAX_STROKES) : []
    };
  });
}

function sanitizeTotals(raw) {
  raw = raw || {};
  const num = function (v) { return Number.isFinite(v) ? v : 0; };
  return { lf: num(raw.lf), sf: num(raw.sf), count: num(raw.count) };
}

// ── Read-only forensics over a stored `pages` value ─────────────────────
// Used by scripts/plan-doc-census.js to report which rows were gutted by the
// synthesized-empty-alias bug and whether their geometry is still
// recoverable from `model.*`. Pure: never mutates, never writes.
//
//   gutted  — a flat alias is present and EMPTY while model.* holds geometry.
//             The row is intact on disk and the loader was discarding it;
//             the toV2 fix recovers it on the next open.
//   emptied — nothing left anywhere. If this row ever had geometry it was
//             overwritten by a save that followed a gutted load, and only
//             plan_versions can recover it.
//   dupIds  — entity ids that appear more than once. Benign today (entities
//             live in arrays) but it is the precondition that would let any
//             future merge-by-id collapse two objects into one.
function inspectPages(pages) {
  const out = {
    kind: null, version: null,
    flatEntities: null, modelEntities: null,
    flatLayers: null, modelLayers: null,
    blocks: 0, sheets: 0, hasUnderlay: false,
    gutted: false, emptied: false, dupIds: [], idless: 0
  };
  if (!Array.isArray(pages) || !pages.length) return out;
  const pg = pages[0] || {};
  out.kind = pg.kind || 'markup';
  if (pg.kind !== 'sheet-doc') return out;
  out.version = Number.isFinite(pg.version) ? pg.version : null;
  const model = isObj(pg.model) ? pg.model : {};
  out.flatEntities = Array.isArray(pg.entities) ? pg.entities.length : null;
  out.modelEntities = Array.isArray(model.entities) ? model.entities.length : null;
  out.flatLayers = Array.isArray(pg.layers) ? pg.layers.length : null;
  out.modelLayers = Array.isArray(model.layers) ? model.layers.length : null;
  out.blocks = Array.isArray(pg.blocks) ? pg.blocks.length : 0;
  out.sheets = Array.isArray(pg.sheets) ? pg.sheets.length : 0;
  out.hasUnderlay = isObj(pg.underlay);

  // The loader prefers a present flat array; empty-over-populated is the bug.
  out.gutted = (out.flatEntities === 0 && out.modelEntities > 0) ||
               (out.flatLayers === 0 && out.modelLayers > 0);
  out.emptied = !out.flatEntities && !out.modelEntities;

  const seen = Object.create(null);
  const all = (Array.isArray(model.entities) ? model.entities : [])
    .concat(Array.isArray(pg.entities) ? pg.entities : []);
  all.forEach(function (e) {
    const id = e && e.id;
    if (id == null || id === '') { out.idless++; return; }
    if (seen[id]) { if (out.dupIds.indexOf(id) < 0) out.dupIds.push(id); }
    seen[id] = 1;
  });
  return out;
}

module.exports = {
  sanitizePages, sanitizeTotals, sanitizeSheetDoc, inspectPages,
  MAX_PAGES, MAX_ENTITIES, MAX_LAYERS, MAX_VIEWPORTS, MAX_SHEETS, MAX_BLOCKS, MAX_STROKES
};
