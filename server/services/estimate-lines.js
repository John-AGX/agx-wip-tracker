'use strict';
// Estimate line-append logic (PA-S1b) — appends a parametric assembly's
// exploded quantities into an estimate's data blob as line items, landing
// them in the SAME sections and order the estimate editor's applyAddLineItem
// would. Kept as a pure, testable module (no DB, no express) so the routing
// can be exercised standalone; server/routes/estimate-routes.js calls
// applyAssemblyToEstimateData() inside its org/lock-guarded handler.
//
// Mirrors js/estimate-editor.js:
//   STANDARD_SECTIONS_PRESET  · eeEnsureSectionByCategory · applyAddLineItem insert.

const asm = require('./assemblies');

const SECTION_PRESET = {
  materials: 'Materials & Supplies Costs',
  labor: 'Direct Labor',
  gc: 'General Conditions',
  sub: 'Subcontractors Costs',
};
const BUCKET_ORDER = ['materials', 'labor', 'gc', 'sub'];
const BUCKET_SUFFIX = { materials: 'Materials', labor: 'Labor', gc: 'General Conditions', sub: 'Subcontractor' };

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

// ── Targets ─────────────────────────────────────────────────────────
// An assembly can land on an ESTIMATE or on a CHANGE ORDER. The explode
// and the pricing are identical — that is the whole point of putting a
// recipe on either one — but the two documents shape their lines
// differently, and the differences are not cosmetic. Every one of them
// below moves money or moves a line into the wrong section:
//
//   belongsTo         An estimate line is scoped by estimateId + alternateId.
//                     A CO line carries NEITHER. Passing null for the
//                     alternate does NOT make those filters no-ops — it
//                     inverts them: `l.alternateId !== null` is TRUE for
//                     every CO line, so find-or-create never adopts an
//                     existing header (a twin section per append) and the
//                     forward walk never finds the next header (the line
//                     lands at the array end). On a change order ARRAY
//                     POSITION IS THE SECTION, so that is a pricing bug,
//                     not an untidiness. Hence a predicate, not a sentinel.
//
//   headerLabelField  Estimate headers name themselves in `description`;
//                     CO headers use `label` — and the CO editor's section
//                     input WRITES `data-line-field="label"`, so it is not
//                     enough for readers to accept both. A header created
//                     here with only `description` renders with a blank
//                     name box, and one keystroke leaves the record holding
//                     two names. Renaming the stored key instead would be a
//                     blob migration, which is exactly what this whole pass
//                     refuses.
//
//   headerMarkupSeed  THE LOAD-BEARING ONE. estimate-lines seeded a created
//                     header `markup: 0`; the CO editor seeds `markup: ''`.
//                     Under pricing-pipeline's cascade those are different
//                     numbers: 0 is a real 0% that BLOCKS the defaultMarkup
//                     fallback, '' inherits it. Same assembly, same change
//                     order, defaultMarkup 25 — an estimate-seeded section
//                     prices at $1,000 and a CO-seeded one at $1,250. Which
//                     door added the assembly would have decided the margin.
//
//   sectionPreset     Section names differ between the two surfaces and
//                     always have ('Materials & Supplies Costs' vs
//                     'Materials'). Adopting the other document's names
//                     would strand lines outside the sections the editor
//                     find-or-creates.
const ESTIMATE_TARGET = {
  kind: 'estimate',
  sectionPreset: SECTION_PRESET,
  headerLabelField: 'description',
  headerMarkupSeed: 0,
  belongsTo: (l, ctx) => !!l && l.estimateId === ctx.docId && l.alternateId === ctx.altId,
  stampLine: (line, ctx) => { line.estimateId = ctx.docId; line.alternateId = ctx.altId; },
  stampHeader: (hdr, ctx) => { hdr.estimateId = ctx.docId; hdr.alternateId = ctx.altId; },
};

// Mirrors js/change-order-editor.js coEnsureSection / coApplyAddLineItem —
// same labels, same `label` key, same `markup: ''` seed, same btCategory
// stamp — so the drawer door and this door produce identical records.
const CO_SECTION_PRESET = {
  materials: 'Materials',
  labor: 'Labor',
  gc: 'General Conditions',
  sub: 'Subcontractor Costs',
};
const CHANGE_ORDER_TARGET = {
  kind: 'change_order',
  sectionPreset: CO_SECTION_PRESET,
  headerLabelField: 'label',
  // '' — inherit the document's defaultMarkup. NOT 0. See above.
  headerMarkupSeed: '',
  // A change order is one flat group: every line belongs.
  belongsTo: (l) => !!l,
  stampLine: () => {},
  stampHeader: (hdr) => { hdr.markupMode = 'percent'; },
};

const TARGETS = { estimate: ESTIMATE_TARGET, change_order: CHANGE_ORDER_TARGET };
const targetFor = (kind) => TARGETS[kind] || ESTIMATE_TARGET;

// The name a header carries, whichever key it was written under. Reading
// both is right; WRITING both is not — see headerLabelField above.
const headerName = (l) => String((l && (l.label || l.description)) || '');

// Find-or-create a section header for a cost bucket within the target
// scope. Adopts a same-named header that has no btCategory (custom/AI/
// legacy), exactly like eeEnsureSectionByCategory / coEnsureSection.
// Returns the header line id.
function ensureSectionByCategory(lines, ctxOrEstId, altId, code, idSeed) {
  // Back-compat call shape: (lines, estId, altId, code, idSeed).
  const ctx = (ctxOrEstId && typeof ctxOrEstId === 'object')
    ? ctxOrEstId
    : { target: ESTIMATE_TARGET, docId: ctxOrEstId, altId };
  const T = ctx.target || ESTIMATE_TARGET;
  const preset = T.sectionPreset;
  const presetName = (preset[code] || '').toLowerCase();
  let hdr = lines.find((l) => {
    if (!l || l.section !== '__section_header__' || !T.belongsTo(l, ctx)) return false;
    if (l.btCategory === code) return true;
    return (!l.btCategory && presetName && headerName(l).toLowerCase() === presetName);
  });
  if (hdr) {
    if (!hdr.btCategory && preset[code]) hdr.btCategory = code;   // backfill the bucket
    return hdr.id;
  }
  if (!preset[code]) return null;
  hdr = { id: 's' + idSeed, section: '__section_header__',
    btCategory: code, markup: T.headerMarkupSeed };
  hdr[T.headerLabelField] = preset[code];
  T.stampHeader(hdr, ctx);
  lines.push(hdr);
  return hdr.id;
}

// Insert a content line after its section header — walk forward to the next
// header in the same scope (else the last line of the scope, else the array
// end). Byte-for-byte the editor's applyAddLineItem placement.
//
// This is MONEY on both surfaces: the markup cascade walks backward from a
// line's array index to find its section, so where a line is spliced is
// which markup it inherits.
function insertLineAfterHeader(lines, headerId, ctxOrEstId, altId, line) {
  const ctx = (ctxOrEstId && typeof ctxOrEstId === 'object')
    ? ctxOrEstId
    : { target: ESTIMATE_TARGET, docId: ctxOrEstId, altId };
  const T = ctx.target || ESTIMATE_TARGET;
  const startIdx = lines.findIndex((l) => l.id === headerId);
  if (startIdx < 0) { lines.push(line); return; }
  let insertAt = lines.length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    const L = lines[j];
    if (!T.belongsTo(L, ctx)) continue;
    if (L.section === '__section_header__') { insertAt = j; break; }
  }
  if (insertAt === lines.length) {
    for (let k = lines.length - 1; k > startIdx; k--) {
      if (T.belongsTo(lines[k], ctx)) { insertAt = k + 1; break; }
    }
  }
  lines.splice(insertAt, 0, line);
}

// Turn explode rows into line specs. rollup (default) = one line per cost
// bucket carrying its breakdown; exploded = one line per leaf. Both stamp
// sourceAssemblyId + assemblyParams (so the per-unit refresh skips them).
function buildAssemblySpecs(assembly, rows, scope, mode) {
  const Q = num(scope.Q);
  const specs = [];
  if (mode === 'exploded') {
    rows.forEach((row) => {
      if (!(row.qty > 0)) return;
      specs.push({
        description: row.description, qty: Math.round(row.qty * 100) / 100, unit: row.unit || 'EA',
        unitCost: row.unit_cost != null ? row.unit_cost : 0,
        cost_code: BUCKET_ORDER.indexOf(row.cost_code) >= 0 ? row.cost_code : 'materials',
        sourceAssemblyId: assembly.id, assemblyParams: scope,
      });
    });
  } else {
    BUCKET_ORDER.forEach((code) => {
      const bucketRows = rows.filter((row) => (row.cost_code || 'materials') === code);
      if (!bucketRows.length) return;
      const bucketTotal = bucketRows.reduce((s, row) => s + (row.qty || 0) * (row.unit_cost != null ? row.unit_cost : 0), 0);
      specs.push({
        description: assembly.name + ' — ' + (BUCKET_SUFFIX[code] || code),
        qty: Q, unit: assembly.unit || 'EA',
        unitCost: Q > 0 ? Math.round((bucketTotal / Q) * 1e6) / 1e6 : 0,
        cost_code: code, sourceAssemblyId: assembly.id,
        assemblyBreakdown: bucketRows, assemblyBucket: code, assemblyParams: scope,
      });
    });
  }
  return specs;
}

// ── explodeForEstimate ───────────────────────────────────────────────
// THE single gate every "put this assembly on an estimate" path runs
// through: the HTTP POST /api/estimates/:id/append-assembly route (the
// Quantify takeoff bridge) AND the payload dispatcher's
// estimate.ops.assembly_adds (86/Scribe). Both doors MUST refuse the same
// recipes — duplicating this math is how the two silently drift apart and
// one of them starts appending an understated cost.
//
// Pure: the caller loads the assembly graph (asm.loadGraph) and passes it
// in, so this is unit-testable with no DB and no JWT_SECRET.
//
// Returns { ok:true, assembly, scope, rows, warnings } or
//         { ok:false, code, error, ... }. Every failure is a HARD STOP —
// there is deliberately no "price what we can and skip the rest" path.
//   assembly_not_found    · no such recipe in this org's catalog
//   assembly_zero_qty     · takeoff quantity Q <= 0
//   assembly_formula_error· a qty_formula didn't evaluate
//   assembly_empty        · recipe has no items
//   assembly_unpriced     · at least one leaf has no unit cost
function explodeForEstimate(opts) {
  const o = opts || {};
  const graph = o.graph;
  const assemblyId = parseInt(o.assembly_id, 10);
  if (!isFinite(assemblyId)) {
    return { ok: false, code: 'assembly_not_found', error: 'assembly_id required (the numeric id from read_assemblies)' };
  }
  if (!graph || !graph.assemblies || typeof graph.assemblies.get !== 'function') {
    return { ok: false, code: 'assembly_not_found', error: 'Assembly catalog unavailable' };
  }
  const a = graph.assemblies.get(assemblyId);
  if (!a) return { ok: false, code: 'assembly_not_found', error: 'Assembly not found: ' + assemblyId };

  const scope = asm.paramScope(a, o.params || {});
  const Q = num(scope.Q);
  if (!(Q > 0)) {
    return { ok: false, code: 'assembly_zero_qty', assembly: a, scope,
      error: 'Takeoff quantity (Q) must be greater than zero' };
  }

  const ex = asm.explodeParametric(assemblyId, graph, scope);
  if (ex.errors && ex.errors.length) {
    return { ok: false, code: 'assembly_formula_error', assembly: a, scope, errors: ex.errors,
      error: 'Formula error: ' + ex.errors.map((e2) => (e2.item ? e2.item + ' — ' : '') + e2.error).join('; ') };
  }
  if (!ex.rows.length) {
    return { ok: false, code: 'assembly_empty', assembly: a, scope, error: 'Assembly has no items to add' };
  }
  // Match the client's incomplete gate — don't quietly append an
  // understated cost for an assembly with an unpriced item. Naming the
  // offenders makes this actionable instead of a dead end.
  const unpriced = ex.rows.filter((row) => row.unit_cost == null);
  if (unpriced.length) {
    const names = unpriced.slice(0, 5).map((row) => row.description || row.kind || 'item');
    return { ok: false, code: 'assembly_unpriced', assembly: a, scope, unpriced,
      error: 'Assembly "' + (a.name || assemblyId) + '" has unpriced items (' +
        names.join(', ') + (unpriced.length > names.length ? ', +' + (unpriced.length - names.length) + ' more' : '') +
        ') — price them before adding to an estimate.' };
  }

  return { ok: true, assembly: a, scope, rows: ex.rows, warnings: ex.warnings || [] };
}

// Mutate `data` (the estimate JSONB blob) in place: resolve a target
// alternate, then route + insert every spec. Returns
// { added, altId, altName, createdAlt }. `opts.nowStamp` lets tests pin ids.
function applyAssemblyToEstimateData(data, params) {
  const estId = params.estId;
  const assembly = params.assembly;
  const rows = params.rows || [];
  const scope = params.scope || { Q: 1 };
  const mode = params.mode === 'exploded' ? 'exploded' : 'rollup';
  const stamp = params.nowStamp || Date.now().toString(36);

  if (!Array.isArray(data.lines)) data.lines = [];
  if (!Array.isArray(data.alternates)) data.alternates = [];

  const altExists = (id) => data.alternates.some((x) => x && x.id === id);
  let altId = (params.alternatePref && altExists(params.alternatePref)) ? params.alternatePref
    : (data.activeAlternateId && altExists(data.activeAlternateId)) ? data.activeAlternateId
    : (data.alternates[0] && data.alternates[0].id) || null;
  let createdAlt = false;
  if (!altId) {
    altId = 'a' + stamp;
    data.alternates.push({ id: altId, estimateId: estId, name: 'Base' });
    if (!data.activeAlternateId) data.activeAlternateId = altId;
    createdAlt = true;
  }
  const altName = ((data.alternates.find((x) => x && x.id === altId) || {}).name) || 'Base';

  // RL-2 placement idempotency: when a stable placementKey is supplied (a drawn
  // object being pushed from the CAD sheet), a re-push REPLACES that placement's
  // prior lines instead of appending duplicates — delete any line in the target
  // alternate carrying this sourcePlacement first, then re-insert. Absent a key
  // (the Quantify takeoff flow) this is a plain append, unchanged.
  const placementKey = (typeof params.placementKey === 'string' && params.placementKey) ? params.placementKey : null;
  let removed = 0;
  if (placementKey) {
    const before = data.lines.length;
    data.lines = data.lines.filter((l) => !(l && String(l.estimateId) === String(estId) && l.alternateId === altId && l.sourcePlacement === placementKey));
    removed = before - data.lines.length;
  }

  const ctx = { target: ESTIMATE_TARGET, docId: estId, altId };
  const specs = buildAssemblySpecs(assembly, rows, scope, mode);
  specs.forEach((spec, i) => {
    const headerId = ensureSectionByCategory(data.lines, ctx, altId, spec.cost_code, stamp + '_' + i);
    const line = {
      id: 'l' + stamp + '_' + i,
      estimateId: estId, alternateId: altId,
      description: spec.description, qty: num(spec.qty), unit: spec.unit || 'ea',
      unitCost: num(spec.unitCost), markup: '',
      sourceAssemblyId: spec.sourceAssemblyId,
      assemblyParams: spec.assemblyParams,
    };
    if (placementKey) line.sourcePlacement = placementKey;
    if (Array.isArray(spec.assemblyBreakdown) && spec.assemblyBreakdown.length) line.assemblyBreakdown = spec.assemblyBreakdown;
    if (spec.assemblyBucket) line.assemblyBucket = spec.assemblyBucket;
    if (headerId) insertLineAfterHeader(data.lines, headerId, ctx, altId, line);
    else data.lines.push(line);
  });

  return { added: specs.length, removed, altId, altName, createdAlt };
}

// ── applyAssemblyToChangeOrderData ──────────────────────────────────
// The same append, onto a change order's data blob. Deliberately a thin
// sibling of the estimate version rather than a second implementation:
// buildAssemblySpecs and explodeForEstimate are shared untouched, so a
// change order gets the identical rollup shape, the identical 6-decimal
// unit cost, and the identical refusals.
//
// THE LINE SHAPE IS THE POINT. `markup: ''` is the load-bearing character:
// the assembly supplies COST and the markup cascade supplies the sell
// price. An assembly never writes `unitSell` — a recipe is the honest
// mechanism, and the promised-price field is the escape hatch for when no
// recipe exists yet. That is exactly how an assembly lands on an estimate,
// and it is why bringing assemblies to change orders needed no new pricing
// concept at all.
//
// A change order is ONE FLAT GROUP — no alternates, ever. The pricing
// pipeline's header says so and activeAlternateName on the CO editor's
// drawer target returns the CO's own title.
function applyAssemblyToChangeOrderData(data, params) {
  const assembly = params.assembly;
  const rows = params.rows || [];
  const scope = params.scope || { Q: 1 };
  const mode = params.mode === 'exploded' ? 'exploded' : 'rollup';
  const stamp = params.nowStamp || Date.now().toString(36);

  if (!Array.isArray(data.lines)) data.lines = [];
  const ctx = { target: CHANGE_ORDER_TARGET, docId: params.coId || null, altId: null };

  const specs = buildAssemblySpecs(assembly, rows, scope, mode);
  specs.forEach((spec, i) => {
    const headerId = ensureSectionByCategory(data.lines, ctx, null, spec.cost_code, stamp + '_' + i);
    const line = {
      id: 'l' + stamp + '_' + i,
      description: spec.description, qty: num(spec.qty), unit: spec.unit || 'ea',
      unitCost: num(spec.unitCost), markup: '', markupMode: 'percent',
      sourceAssemblyId: spec.sourceAssemblyId,
      assemblyParams: spec.assemblyParams,
    };
    if (Array.isArray(spec.assemblyBreakdown) && spec.assemblyBreakdown.length) line.assemblyBreakdown = spec.assemblyBreakdown;
    if (spec.assemblyBucket) line.assemblyBucket = spec.assemblyBucket;
    if (headerId) insertLineAfterHeader(data.lines, headerId, ctx, null, line);
    else data.lines.push(line);
  });

  return { added: specs.length };
}

module.exports = {
  SECTION_PRESET, CO_SECTION_PRESET, BUCKET_ORDER, BUCKET_SUFFIX,
  ESTIMATE_TARGET, CHANGE_ORDER_TARGET, targetFor, headerName,
  ensureSectionByCategory, insertLineAfterHeader, buildAssemblySpecs,
  explodeForEstimate, applyAssemblyToEstimateData, applyAssemblyToChangeOrderData,
};
