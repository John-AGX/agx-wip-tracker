#!/usr/bin/env node
// Census of the CAD sheet drawings in `plans.pages`. READ-ONLY — it opens a
// pool, SELECTs, prints, and exits. It never writes, never repairs, never
// restores, and never deletes a plan_versions row.
//
//   node scripts/plan-doc-census.js            # summary
//   node scripts/plan-doc-census.js --rows     # + one line per non-healthy row
//
// ── WHAT HAPPENED, AND WHY THIS FILE WAS PART OF IT ─────────────────────
// For 38 days (2026-07-12 → 2026-08-19) the page sanitizer synthesized
// `entities: []` onto every stored v2/v3 sheet doc, and the editor's
// broken-alias rescue preferred that empty array over the real geometry in
// `model.entities`. The drawing was discarded on load and the next autosave
// wrote the emptied document back over the row. Both halves are fixed
// (9c9f6d6), and a row whose geometry is still in `model.*` now recovers by
// itself the next time it is opened.
//
// The first version of THIS REPORT then told the operator the casualties were
// fine. It branched on a `gutted` flag ORed across entities and layers, and a
// row destroyed by the real bug is flatEntities=0 / modelEntities=0 /
// modelLayers=1 — healDoc pushes a default layer whenever the layer list goes
// empty, so every destroyed row carries a surviving layer and no geometry.
// `gutted` was true, it won the branch, and rows with nothing left in them
// printed under the legend "self-heals on the next open. No action needed."
//
// An instrument that misreports is worse than no instrument, because it ends
// the investigation. So the classification now lives in ONE place
// (server/services/plan-doc.js classifyPlan), settles the loss case FIRST, and
// never treats a surviving layer as a surviving drawing.
//
// ── WHAT THIS REPORT CAN AND CANNOT KNOW ────────────────────────────────
// A row with zero entities is either a plan nobody ever drew on or a drawing
// that was destroyed. The row alone cannot tell you which. The only evidence
// that separates them is plan_versions, so for every empty sheet row this
// loads its snapshots and looks for geometry:
//
//   snapshot with geometry found  -> DESTROYED, and recoverable. Named, with
//                                    the entity count and age of the restore
//                                    point, and the command to take it.
//   no snapshot has geometry      -> reported as CANNOT TELL, not as "fine".
//
// plan_versions snapshots at most once per 10 minutes and keeps the last 30
// per plan, so a plan edited across more than ~5 hours of sessions since
// 2026-07-12 may already have lost its pre-bug restore point. That is the
// clock this report is racing (the prune now exempts geometry-bearing
// snapshots while the live row is empty — see plans-routes.js — but only for
// saves made after that fix deployed).

'use strict';

const { pool } = require('../server/db');
const { classifyPlan, inspectPages } = require('../server/services/plan-doc');

const SHOW_ROWS = process.argv.includes('--rows');

// Snapshots are loaded ONLY for rows that came back empty (the small set), and
// capped, so a census never drags every historical drawing into memory.
const MAX_VERSIONS_PER_PLAN = 60;

function days(from, to) {
  if (!from || !to) return null;
  return Math.round((new Date(to) - new Date(from)) / 86400000);
}

async function main() {
  const started = new Date();
  const { rows } = await pool.query(
    'SELECT p.id, p.organization_id, p.name, p.base_kind, p.updated_at, p.pages, ' +
    '       (SELECT count(*) FROM plan_versions v WHERE v.plan_id = p.id) AS versions ' +
    '  FROM plans p ORDER BY p.updated_at DESC'
  );

  const tally = {
    total: rows.length, sheet: 0, markup: 0, nonSheetWithPages: 0,
    healthy: 0, brokenAlias: 0, recoverable: 0, destroyed: 0, unknown: 0,
    dupIds: 0, idless: 0, entitiesRecoverable: 0
  };
  const flagged = [];

  for (const r of rows) {
    if (r.base_kind !== 'sheet') {
      tally.markup++;
      // Pre-existing and out of scope: buildAnnotations emits a flat stroke
      // array while the sanitizer's markup branch coerces each element into a
      // {page,calibration,strokes} stub. Counted so it is on the record and
      // provably not something this change touched.
      if (Array.isArray(r.pages) && r.pages.length) tally.nonSheetWithPages++;
      continue;
    }
    tally.sheet++;

    let versions = [];
    if (inspectPages(r.pages).state === 'empty') {
      const v = await pool.query(
        'SELECT id, created_at, pages FROM plan_versions ' +
        ' WHERE plan_id = $1 AND organization_id = $2 ' +
        ' ORDER BY created_at DESC LIMIT ' + MAX_VERSIONS_PER_PLAN,
        [r.id, r.organization_id]
      );
      versions = v.rows;
    }

    const rep = classifyPlan({ pages: r.pages, versions });
    if (rep.dupIds.length) tally.dupIds++;
    if (rep.idless) tally.idless++;

    if (rep.state === 'destroyed') { tally.destroyed++; tally.entitiesRecoverable += rep.candidate.entities; }
    else if (rep.state === 'empty-unknown') tally.unknown++;
    else if (rep.state === 'recoverable-by-open') tally.recoverable++;
    else if (rep.state === 'broken-alias') tally.brokenAlias++;
    else tally.healthy++;

    if (rep.state !== 'healthy' || rep.dupIds.length || rep.idless) flagged.push({ r, rep });
  }

  const P = console.log;
  P('');
  P('plan-doc census — READ-ONLY. %s', started.toISOString());
  P('source: the live database this process is configured against. Every number');
  P('below is measured, not estimated.');
  P('');
  P('plans: %d total  (%d sheet drawings, %d markup)', tally.total, tally.sheet, tally.markup);
  P('');
  P('sheet drawings — what is in the row right now:');
  P('');
  P('  healthy              : %d', tally.healthy);
  P('      Geometry present, nothing shadowing it. Nothing to do.');
  P('  broken-alias         : %d', tally.brokenAlias);
  P('      The row carries the drawing twice; the loader uses the populated');
  P('      copy. No loss. Re-saving the plan cleans it up. Nothing to do.');
  P('  recoverable-by-open  : %d', tally.recoverable);
  P('      The bug HID this geometry; it is still in the row. Opening the plan');
  P('      once restores it and the next save rewrites the row clean.');
  P('      NOTHING WAS LOST on these. No action needed.');
  P('  %s', '-'.repeat(70));
  P('  DESTROYED            : %d        <-- the casualties', tally.destroyed);
  P('      No drawing left in the row, AND a plan_versions snapshot still has');
  P('      one. Proven loss, and proven recoverable: %d entities across these', tally.entitiesRecoverable);
  P('      %d plan(s) are sitting in restore points right now.', tally.destroyed);
  if (tally.destroyed) {
    P('      -> node scripts/plan-recover.js --plan <id>          (shows, changes nothing)');
  }
  P('  EMPTY - CANNOT TELL  : %d', tally.unknown);
  P('      No drawing in the row and none in any surviving snapshot. This is');
  P('      EITHER a plan nobody ever drew on OR a destroyed drawing whose');
  P('      snapshots have already been pruned. THIS REPORT CANNOT TELL THE');
  P('      TWO APART and will not guess. Check these by name against what you');
  P('      remember drawing.');
  P('');
  P('  rows with duplicate entity ids : %d', tally.dupIds);
  P('  rows with id-less entities     : %d', tally.idless);
  if (tally.nonSheetWithPages) {
    P('');
    P('note: %d non-sheet plan rows carry pages (pre-existing markup shape', tally.nonSheetWithPages);
    P('      mismatch, untouched by this change).');
  }

  P('');
  P('READING "DESTROYED : 0": it means no sheet row is both empty and covered');
  P('by a snapshot that still holds geometry. It does NOT mean nothing was');
  P('lost — a drawing destroyed early enough for its snapshots to have been');
  P('pruned lands in EMPTY - CANNOT TELL, not here. Read both lines.');

  if (SHOW_ROWS && flagged.length) {
    P('');
    P('%s', '-'.repeat(112));
    flagged.forEach(({ r, rep }) => {
      const bits = [
        String(rep.state).toUpperCase().padEnd(20),
        'org=' + String(r.organization_id).padEnd(4),
        String(r.id).padEnd(30),
        'v' + rep.version,
        'flat=' + String(rep.flatEntities),
        'model=' + String(rep.modelEntities),
        'blocks=' + rep.blocks,
        'versions=' + r.versions,
        'dup=' + rep.dupIds.length,
        'idless=' + rep.idless
      ];
      if (rep.candidate) {
        const age = days(rep.candidate.created_at, r.updated_at);
        bits.push('RESTORE v' + rep.candidate.id + ' (' + rep.candidate.entities + ' entities, ' +
          new Date(rep.candidate.created_at).toISOString().slice(0, 10) +
          (age == null ? '' : ', ' + age + 'd before last edit') + ')');
      } else if (rep.state === 'empty-unknown') {
        bits.push('checked ' + rep.versionsChecked + ' snapshot(s), none held geometry');
      }
      bits.push('"' + r.name + '"');
      P(bits.join('  '));
    });
  } else if (flagged.length) {
    P('');
    P('(%d rows flagged — re-run with --rows to list them)', flagged.length);
  }
  P('');
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('census failed:', e.message); pool.end(); process.exitCode = 1; });
