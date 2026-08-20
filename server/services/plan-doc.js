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

// ── Truncation is data loss, so it has to be sayable ────────────────────
// Every cap below can silently drop content: 20001 entities become 20000 and
// the save returns 200 OK. The caller passes an optional `notes` array and
// gets one { path, from, to } per cut, so the route can log it and a test can
// assert the cut happened. Nothing here rejects a save — refusing a drawing
// at the cap would be a new way to lose work — but "it fit" stops being an
// unexamined assumption.
function capArr(arr, max, path, notes) {
  if (arr.length > max && notes) notes.push({ path: path, from: arr.length, to: max });
  return arr.slice(0, max);
}

// Sheet-doc (CAD shop-drawing) — pass the document through with size caps
// only. Every key is conditional on the client having sent it.
function sanitizeSheetDoc(pg, notes, at) {
  const p = at || 'pages[0]';
  const out = {
    kind: 'sheet-doc',
    version: Number.isFinite(pg.version) ? (pg.version | 0) : 1
  };

  // Flat v1 working aliases: kept ONLY when actually present. serializeDoc
  // strips these from v2/v3 docs, and defaulting them to [] is what gutted
  // the drawing on the next load.
  if (isObj(pg.sheet)) out.sheet = pg.sheet;
  if (isObj(pg.titleblock)) out.titleblock = pg.titleblock;
  if (Array.isArray(pg.layers)) out.layers = capArr(pg.layers, MAX_LAYERS, p + '.layers', notes);
  if (Array.isArray(pg.viewports)) out.viewports = capArr(pg.viewports, MAX_VIEWPORTS, p + '.viewports', notes);
  if (Array.isArray(pg.entities)) out.entities = capArr(pg.entities, MAX_ENTITIES, p + '.entities', notes);

  // v2/v3 truth. Pass model through WHOLE (caps only, no field whitelist) —
  // a whitelist here is exactly what caused the original data loss.
  if (isObj(pg.model)) {
    out.model = Object.assign({}, pg.model);
    if (Array.isArray(pg.model.entities)) out.model.entities = capArr(pg.model.entities, MAX_ENTITIES, p + '.model.entities', notes);
    if (Array.isArray(pg.model.layers)) out.model.layers = capArr(pg.model.layers, MAX_LAYERS, p + '.model.layers', notes);
  }
  // NOTE (known, deliberate, NOT fixed here): MAX_VIEWPORTS caps the flat v1
  // alias only. A v2/v3 doc carries its viewports at sheets[i].viewports,
  // which `sheets` passes through uncapped — 5000 viewports store fine. The
  // cap is therefore decorative on every document the shipped editor writes.
  // Adding a cap there would DELETE viewports out of existing rows, which is
  // the failure this whole file exists to stop. It stays reported, not fixed.
  if (Array.isArray(pg.sheets)) out.sheets = capArr(pg.sheets, MAX_SHEETS, p + '.sheets', notes);
  if (Array.isArray(pg.blocks)) {
    // Named block definitions (W3) — cap count AND each def's entity list so
    // defs can't smuggle geometry past the per-sheet entity budget.
    //
    // `entities` is kept ONLY when the def actually carries it. The previous
    // `: []` default synthesized a key the client never sent — the exact rule
    // this file's header forbids, and the exact shape that gutted every sheet
    // drawing one level up. Low impact (the editor always writes the key) and
    // that is precisely why it had to go: the next reader of a block def has
    // no way to tell a real empty def from one this function invented.
    out.blocks = capArr(pg.blocks, MAX_BLOCKS, p + '.blocks', notes).map(function (bk, bi) {
      bk = bk || {};
      if (!Array.isArray(bk.entities)) return Object.assign({}, bk);
      return Object.assign({}, bk, {
        entities: capArr(bk.entities, MAX_ENTITIES, p + '.blocks[' + bi + '].entities', notes)
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
//
// `notes` is optional and write-only: pass an array to collect every place a
// cap actually cut something. Omit it and behaviour is unchanged.
function sanitizePages(raw, notes) {
  if (!Array.isArray(raw)) return [];
  return capArr(raw, MAX_PAGES, 'pages', notes).map(function (pg, i) {
    pg = pg || {};
    const p = 'pages[' + i + ']';
    if (pg.kind === 'sheet-doc') return sanitizeSheetDoc(pg, notes, p);
    return {
      page: Number.isFinite(pg.page) ? (pg.page | 0) : i,
      calibration: isObj(pg.calibration) ? pg.calibration : null,
      strokes: Array.isArray(pg.strokes) ? capArr(pg.strokes, MAX_STROKES, p + '.strokes', notes) : []
    };
  });
}

function sanitizeTotals(raw) {
  raw = raw || {};
  const num = function (v) { return Number.isFinite(v) ? v : 0; };
  return { lf: num(raw.lf), sf: num(raw.sf), count: num(raw.count) };
}

// ── Read-only forensics over a stored `pages` value ─────────────────────
// Pure: never mutates, never writes, never opens a connection.
//
// ── WHY THE FIRST VERSION OF THIS REPORTED THE CASUALTIES AS FINE ───────
// It exposed two booleans, `gutted` and `emptied`, and the census branched
// `if (gutted) … else if (emptied) …`. `gutted` was ORed across entities AND
// layers:
//
//     gutted  = (flatEntities === 0 && modelEntities > 0) ||
//               (flatLayers   === 0 && modelLayers   > 0)
//
// Run a real drawing through the real pre-fix pipeline and what lands in the
// row is flatEntities=0, modelEntities=0, flatLayers=0, modelLayers=1 — the
// surviving layer is not a contrivance, healDoc PUSHES a default L0 whenever
// the layer list goes empty, so EVERY row this bug destroyed carries one
// layer and none of its geometry. Both booleans were true, `gutted` won the
// branch, and a row with nothing left in it printed under a legend reading
// "geometry intact in model.* — self-heals on the next open. No action
// needed." The instrument said the casualties were fine.
//
// So there is now ONE field — `state` — decided in one place, in an order
// where the loss case is settled before anything else can claim the row, and
// LAYERS ARE NOT GEOMETRY. A drawing with 400 entities and no layer list is
// damaged; a drawing with one layer and no entities is empty.
//
//   'healthy'              geometry present, no empty alias shadowing it.
//   'broken-alias'         flat AND model both carry geometry. The loader
//                          prefers the populated flat array (that is what
//                          the toV2 rescue is for) — no loss, but the row
//                          holds two copies and one of them is stale.
//   'recoverable-by-open'  an EMPTY flat alias sits in front of real geometry
//                          in model.*. This is what the bug wrote. The
//                          shipped loader now ignores the empty alias, so the
//                          next open + save rewrites the row clean.
//   'empty'                NO geometry anywhere in the row. A row-level
//                          inspection CANNOT tell a destroyed drawing from a
//                          plan nobody ever drew on — both are zero entities.
//                          classifyPlan() below separates them, and only with
//                          evidence from plan_versions.
//   'not-sheet'            markup plan (strokes), not a CAD sheet-doc.
//
// `dupIds` — entity ids appearing more than once in the list the loader will
// actually use. Benign today (entities live in arrays) but it is the
// precondition that would let any future merge-by-id collapse two objects
// into one.
function inspectPages(pages) {
  const out = {
    kind: null, version: null,
    flatEntities: null, modelEntities: null,
    flatLayers: null, modelLayers: null,
    entities: 0, layers: 0,
    blocks: 0, sheets: 0, hasUnderlay: false,
    state: 'not-sheet', dupIds: [], idless: 0
  };
  if (!Array.isArray(pages) || !pages.length) return out;
  const pg = pages[0] || {};
  out.kind = pg.kind || 'markup';
  if (pg.kind !== 'sheet-doc') return out;
  out.version = Number.isFinite(pg.version) ? pg.version : null;
  const model = isObj(pg.model) ? pg.model : {};
  const flatE = Array.isArray(pg.entities) ? pg.entities : null;
  const modelE = Array.isArray(model.entities) ? model.entities : null;
  out.flatEntities = flatE ? flatE.length : null;
  out.modelEntities = modelE ? modelE.length : null;
  out.flatLayers = Array.isArray(pg.layers) ? pg.layers.length : null;
  out.modelLayers = Array.isArray(model.layers) ? model.layers.length : null;
  out.blocks = Array.isArray(pg.blocks) ? pg.blocks.length : 0;
  out.sheets = Array.isArray(pg.sheets) ? pg.sheets.length : 0;
  out.hasUnderlay = isObj(pg.underlay);

  // The list the SHIPPED loader will actually render: a populated flat alias
  // wins (the rescue), otherwise model.*. Mirrors js/sheet-editor.js toV2 —
  // if that preference ever changes, this has to change with it.
  const eff = (flatE && flatE.length) ? flatE : (modelE || flatE || []);
  out.entities = eff.length;
  out.layers = Math.max(out.flatLayers || 0, out.modelLayers || 0);

  // Order is the whole fix. "Nothing left" is decided FIRST, on entities
  // alone, so no layer-shaped condition can claim a row that has no drawing
  // in it.
  if (!out.entities) out.state = 'empty';
  else if (out.flatEntities === 0 || (out.flatLayers === 0 && out.modelLayers > 0)) out.state = 'recoverable-by-open';
  else if (out.flatEntities > 0 && out.modelEntities != null) out.state = 'broken-alias';
  else out.state = 'healthy';

  // dupIds over the EFFECTIVE list, not model+flat concatenated. Concatenating
  // double-counted every id on exactly the rows this report describes — a
  // broken-alias row carries the same geometry twice, so a clean 15-entity
  // drawing reported dupIds=15 — which made the number useless for the one
  // thing it exists to establish. Genuine duplicates are still caught.
  const seen = Object.create(null);
  eff.forEach(function (e) {
    const id = e && e.id;
    if (id == null || id === '') { out.idless++; return; }
    if (seen[id]) { if (out.dupIds.indexOf(id) < 0) out.dupIds.push(id); }
    seen[id] = 1;
  });
  return out;
}

// ── The verdict, including the evidence a single row cannot carry ───────
// `versions` is the plan's restore points, newest first, each { id, created_at,
// pages }. Pass [] when they were not loaded — the result then says
// 'empty-unknown' rather than guessing, because "no snapshots were checked"
// and "no snapshot has geometry" are different facts and only one of them
// clears a row.
//
//   'destroyed'       the row holds no geometry AND a snapshot still does.
//                     Provably a casualty, and provably recoverable. These
//                     are the rows to act on: `candidate` names the newest
//                     snapshot that still has a drawing in it.
//   'empty-unknown'   the row holds no geometry and no snapshot does either.
//                     Either nobody ever drew on this plan, or it was
//                     destroyed and its pre-bug snapshots have been pruned.
//                     THIS REPORT CANNOT TELL THE TWO APART, and says so
//                     rather than picking the comfortable one.
//   everything else   passes through from inspectPages.
function classifyPlan(row) {
  const r = row || {};
  const rep = inspectPages(r.pages);
  const out = Object.assign({}, rep, { candidate: null, snapshotsWithGeometry: 0, versionsChecked: 0 });
  if (rep.state !== 'empty') return out;

  const versions = Array.isArray(r.versions) ? r.versions : [];
  out.versionsChecked = versions.length;
  versions.forEach(function (v) {
    const vr = inspectPages(v && v.pages);
    if (!vr.entities) return;
    out.snapshotsWithGeometry++;
    if (!out.candidate) {
      out.candidate = {
        id: v.id, created_at: v.created_at,
        entities: vr.entities, layers: vr.layers, state: vr.state
      };
    }
  });
  out.state = out.candidate ? 'destroyed' : 'empty-unknown';
  return out;
}

// One SQL definition of "how many entities does this stored pages value hold",
// so the census, the recovery tool and the prune guard cannot disagree about
// which rows have a drawing in them. `expr` is a jsonb expression (a column or
// an alias.column). Mirrors the JS rule above: the greater of the flat alias
// and model.entities, and non-arrays count as zero.
function sqlSheetEntityCount(expr) {
  const flat = expr + "->0->'entities'";
  const model = expr + "->0->'model'->'entities'";
  return 'GREATEST(' +
    "CASE WHEN jsonb_typeof(" + flat + ") = 'array' THEN jsonb_array_length(" + flat + ") ELSE 0 END, " +
    "CASE WHEN jsonb_typeof(" + model + ") = 'array' THEN jsonb_array_length(" + model + ") ELSE 0 END)";
}

module.exports = {
  sanitizePages, sanitizeTotals, sanitizeSheetDoc, inspectPages, classifyPlan,
  sqlSheetEntityCount,
  MAX_PAGES, MAX_ENTITIES, MAX_LAYERS, MAX_VIEWPORTS, MAX_SHEETS, MAX_BLOCKS, MAX_STROKES
};
