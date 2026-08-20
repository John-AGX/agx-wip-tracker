#!/usr/bin/env node
// Census of the CAD sheet drawings in `plans.pages`. READ-ONLY — it opens a
// pool, SELECTs, prints, and exits. It never writes, never repairs, and never
// touches plan_versions.
//
// Why this exists: the page sanitizer used to synthesize `entities: []` onto
// every stored v2/v3 sheet doc, and the editor's broken-alias rescue then
// preferred that empty array over the real geometry in `model.entities`. The
// drawings were never deleted — they were being discarded on load, and any
// save that followed a discarded load wrote the emptied document back.
//
// Both halves are fixed (server/services/plan-doc.js stops synthesizing;
// js/sheet-editor.js stops letting an empty alias win), so a GUTTED row now
// recovers by itself the next time it is opened. This report says how many
// rows are in each state, so the fix can be verified against reality rather
// than assumed:
//
//   gutted   — geometry intact in model.*, was being hidden. Self-heals on
//              the next open. No action needed; count should fall to 0.
//   emptied  — nothing left in the row. If the plan ever had geometry it was
//              overwritten by a save after a gutted load. Check plan_versions
//              (the report prints how many restore points each one has).
//   healthy  — geometry present and no empty alias shadowing it.
//
// It also reports duplicate/missing entity ids, which are harmless today
// (entities live in arrays and the renderer iterates) but would be the
// precondition for any future merge-by-id to collapse two objects into one.
//
//   node scripts/plan-doc-census.js            # summary
//   node scripts/plan-doc-census.js --rows     # one line per non-healthy row

'use strict';

const { pool } = require('../server/db');
const { inspectPages } = require('../server/services/plan-doc');

const SHOW_ROWS = process.argv.includes('--rows');

async function main() {
  const { rows } = await pool.query(
    'SELECT p.id, p.organization_id, p.name, p.base_kind, p.updated_at, p.pages, ' +
    '       (SELECT count(*) FROM plan_versions v WHERE v.plan_id = p.id) AS versions ' +
    '  FROM plans p ORDER BY p.updated_at DESC'
  );

  const tally = { total: rows.length, sheet: 0, markup: 0, nonSheetWithPages: 0,
                  healthy: 0, gutted: 0, emptied: 0, dupIds: 0, idless: 0 };
  const flagged = [];

  rows.forEach((r) => {
    const rep = inspectPages(r.pages);
    if (r.base_kind !== 'sheet') {
      tally.markup++;
      // Pre-existing and out of scope: buildAnnotations emits a flat stroke
      // array while the sanitizer's markup branch coerces each element into a
      // {page,calibration,strokes} stub. Counted so it is on the record and
      // provably not something this change touched.
      if (Array.isArray(r.pages) && r.pages.length) tally.nonSheetWithPages++;
      return;
    }
    tally.sheet++;
    if (rep.dupIds.length) tally.dupIds++;
    if (rep.idless) tally.idless++;
    if (rep.gutted) tally.gutted++;
    else if (rep.emptied) tally.emptied++;
    else tally.healthy++;
    if (rep.gutted || rep.emptied || rep.dupIds.length || rep.idless) {
      flagged.push({ r, rep, state: rep.gutted ? 'GUTTED' : (rep.emptied ? 'EMPTIED' : 'ids') });
    }
  });

  console.log('\nplans: %d total  (%d sheet, %d markup)', tally.total, tally.sheet, tally.markup);
  console.log('sheet drawings:');
  console.log('  healthy : %d', tally.healthy);
  console.log('  GUTTED  : %d   (geometry intact in model.* — self-heals on next open)', tally.gutted);
  console.log('  EMPTIED : %d   (nothing left in the row — check plan_versions)', tally.emptied);
  console.log('  rows with duplicate entity ids : %d', tally.dupIds);
  console.log('  rows with id-less entities     : %d', tally.idless);
  if (tally.nonSheetWithPages) {
    console.log('\nnote: %d non-sheet plan rows carry pages (pre-existing markup shape ' +
                'mismatch, untouched by this change)', tally.nonSheetWithPages);
  }

  if (SHOW_ROWS && flagged.length) {
    console.log('\n%s', '-'.repeat(96));
    flagged.forEach(({ r, rep, state }) => {
      console.log('%s  org=%s  %s  v%s  flat=%s model=%s  blocks=%d  versions=%s  dup=%d idless=%d  "%s"',
        state.padEnd(7), String(r.organization_id).padEnd(4), String(r.id).padEnd(30),
        rep.version, String(rep.flatEntities), String(rep.modelEntities),
        rep.blocks, r.versions, rep.dupIds.length, rep.idless, r.name);
    });
  } else if (flagged.length) {
    console.log('\n(%d rows flagged — re-run with --rows to list them)', flagged.length);
  }
  console.log('');
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('census failed:', e.message); pool.end(); process.exitCode = 1; });
