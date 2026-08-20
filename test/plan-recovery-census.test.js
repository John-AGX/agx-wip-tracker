// GATE 1 — the instrument that has to be right about the casualties.
//
// For 38 days (2026-07-12 → 2026-08-19) the plan surface destroyed sheet
// drawings on reload. The fix landed. Then the census written to measure the
// damage reported the destroyed rows as "geometry intact in model.* —
// self-heals on the next open. No action needed."
//
// That is the failure this suite exists to prevent recurring, and it is worse
// than the original bug in one specific way: a wrong instrument ENDS the
// investigation. The drawings were already gone; the report is what decided
// nobody would go looking for them.
//
// ── WHY THE FIXTURES ARE MANUFACTURED AND NOT WRITTEN ───────────────────
// A hand-typed "destroyed row" proves nothing. It is destroyed because it was
// typed that way, so any classifier that looks at it will agree, including a
// wrong one. The row that has to be classified correctly is the row THE BUG
// PRODUCED — and the only way to be certain of its shape is to run a
// populated drawing through the pipeline that produced it.
//
// helpers/plan-wreckage.js rebuilds both pre-fix halves by mutating the
// SHIPPED sources (the editor's unguarded broken-alias rescue, the sanitizer's
// synthesized empty aliases) and asserts every mutation matched. Everything
// below runs a real 15-object drawing through the real editor and the real
// sanitizer until it is really empty, and then asks the census what it sees.

'use strict';

const H = require('./helpers/sheet-doc-harness');
const W = require('./helpers/plan-wreckage');
const PD = require('../server/services/plan-doc');
const { inspectPages, classifyPlan, sanitizePages, sqlSheetEntityCount } = PD;

const SE_PRE = W.preFixEditor();
const PD_PRE = W.preFixPlanDoc();

// A drawing that has been through `cycles` open/save rounds on the given
// pipeline. `seen` is what the user had on screen each time they reopened it.
function through(SE, PDx, cycles) { return W.run(SE, PDx, 15, cycles || 4); }

// ═══════════════════════════════════════════════════════════════════════
describe('the wreckage is real before anything is asserted about it', () => {

  // Both halves are required. Reverting either one on its own loses nothing,
  // which is exactly why the bug survived two separate data-loss fixes: each
  // author looked at their own half and correctly concluded it was safe.
  test('only BOTH pre-fix halves together destroy the drawing', () => {
    expect(through(H.SE, PD).seen).toEqual([15, 15, 15, 15]);          // shipped + shipped
    expect(through(H.SE, PD_PRE).seen).toEqual([15, 15, 15, 15]);      // shipped loader saves it
    expect(through(SE_PRE, PD).seen).toEqual([15, 15, 15, 15]);        // shipped sanitizer saves it
    expect(through(SE_PRE, PD_PRE).seen).toEqual([0, 0, 0, 0]);        // production, 2026-07-12
  });

  test('the destroyed row has the shape production actually has', () => {
    const rep = inspectPages(through(SE_PRE, PD_PRE).stored);
    expect(rep.flatEntities).toBe(0);
    expect(rep.modelEntities).toBe(0);
    expect(rep.entities).toBe(0);
    // healDoc pushes a default L0 whenever the layer list goes empty, so EVERY
    // row this bug destroyed carries a surviving layer and none of its
    // geometry. That surviving layer is what the old `gutted` predicate saw.
    expect(rep.modelLayers).toBe(1);
  });

  test('the OLD predicate calls that row GUTTED — the misreport, reproduced', () => {
    const rep = inspectPages(through(SE_PRE, PD_PRE).stored);
    // Verbatim from the shipped-and-wrong version of inspectPages:
    //   gutted = (flatEntities === 0 && modelEntities > 0) ||
    //            (flatLayers   === 0 && modelLayers   > 0)
    const oldGutted = (rep.flatEntities === 0 && rep.modelEntities > 0) ||
                      (rep.flatLayers === 0 && rep.modelLayers > 0);
    const oldEmptied = !rep.flatEntities && !rep.modelEntities;
    expect(oldGutted).toBe(true);      // ORed across layers, and layers survived
    expect(oldEmptied).toBe(true);     // BOTH were true...
    // ...and the census branched `if (gutted) … else if (emptied) …`, so the
    // row printed as GUTTED under "No action needed; count should fall to 0",
    // and EMPTIED printed 0. Every casualty was reported as fine.
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('a destroyed row is named a casualty, never "no action needed"', () => {

  const wrecked = through(SE_PRE, PD_PRE).stored;
  const goodSnapshot = through(H.SE, PD, 1).stored;

  test('the row-level state is never one of the harmless ones', () => {
    const rep = inspectPages(wrecked);
    expect(rep.state).not.toBe('healthy');
    expect(rep.state).not.toBe('recoverable-by-open');   // the old verdict
    expect(rep.state).not.toBe('broken-alias');
    expect(rep.state).toBe('empty');
  });

  test('with a surviving snapshot the verdict is DESTROYED, and it names the restore point', () => {
    const rep = classifyPlan({
      pages: wrecked,
      versions: [
        { id: 91, created_at: '2026-08-01T00:00:00Z', pages: through(SE_PRE, PD_PRE, 2).stored },
        { id: 90, created_at: '2026-07-10T00:00:00Z', pages: goodSnapshot }
      ]
    });
    expect(rep.state).toBe('destroyed');
    // The newest snapshot is itself empty — it was taken after the bug. The
    // candidate has to be the newest one that still HOLDS a drawing, not just
    // the newest one.
    expect(rep.candidate.id).toBe(90);
    expect(rep.candidate.entities).toBe(15);
    expect(rep.snapshotsWithGeometry).toBe(1);
  });

  test('with no surviving snapshot the verdict says CANNOT TELL, and does not guess', () => {
    const rep = classifyPlan({ pages: wrecked, versions: [] });
    expect(rep.state).toBe('empty-unknown');
    expect(rep.candidate).toBeNull();
    // The honest answer for a row with nothing in it and nothing behind it is
    // "either nobody drew on this or it was destroyed and the snapshots are
    // gone". Calling it either one would be a claim the data does not support.
    expect(rep.state).not.toBe('healthy');
    expect(rep.state).not.toBe('destroyed');
  });

  test('"versions not loaded" and "no version had geometry" are not conflated', () => {
    const notLoaded = classifyPlan({ pages: wrecked });
    expect(notLoaded.versionsChecked).toBe(0);
    const loadedAndEmpty = classifyPlan({
      pages: wrecked,
      versions: [{ id: 5, created_at: '2026-08-02T00:00:00Z', pages: through(SE_PRE, PD_PRE, 2).stored }]
    });
    expect(loadedAndEmpty.versionsChecked).toBe(1);
    expect(loadedAndEmpty.snapshotsWithGeometry).toBe(0);
  });

  test('a blank plan nobody drew on lands in the same honest bucket, not in DESTROYED', () => {
    // The row cannot distinguish these, and the report must not pretend it
    // can — over-reporting casualties is the same defect pointed the other way.
    const blank = sanitizePages([H.serialize(H.freshDoc())]);
    expect(inspectPages(blank).state).toBe('empty');
    expect(classifyPlan({ pages: blank, versions: [] }).state).toBe('empty-unknown');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('the other three states', () => {

  test('a self-healing row is named recoverable-by-open, and really does self-heal', () => {
    // Produced by the SYNTHESIZING sanitizer alone: the empty flat alias is
    // written, but the shipped loader ignores it. Geometry never left the row.
    const stored = through(H.SE, PD_PRE).stored;
    const rep = inspectPages(stored);
    expect(rep.state).toBe('recoverable-by-open');
    expect(rep.flatEntities).toBe(0);
    expect(rep.modelEntities).toBe(15);
    // The P0 fix still holds: opening it gets the drawing back, and re-saving
    // writes the row clean.
    const reopened = W.loadWith(H.SE, stored);
    expect(reopened.entities).toHaveLength(15);
    const resaved = sanitizePages([H.serialize(reopened)]);
    expect(inspectPages(resaved).state).toBe('healthy');
    expect(inspectPages(resaved).entities).toBe(15);
  });

  test('a healthy row is healthy', () => {
    expect(inspectPages(through(H.SE, PD).stored).state).toBe('healthy');
  });

  test('a broken-alias row is named, and the populated flat copy still wins', () => {
    const wire = H.serialize(H.freshDoc());
    wire.entities = [{ id: 'LIVE_1', tool: 'line', layer: 'L0', startX: 0, startY: 0, endX: 1, endY: 1 }];
    wire.model = Object.assign({}, wire.model, { entities: [{ id: 'STALE_1', tool: 'line' }] });
    const rep = inspectPages(sanitizePages([wire]));
    expect(rep.state).toBe('broken-alias');
    expect(rep.entities).toBe(1);
    expect(H.loadDoc({ pages: sanitizePages([wire]) }).entities.map((e) => e.id)).toEqual(['LIVE_1']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('dupIds counts duplicates, not the same drawing twice', () => {

  test('a broken-alias row carrying one drawing twice reports NO duplicates', () => {
    // The old inspectPages concatenated model.entities onto pg.entities, so a
    // row holding the SAME geometry in both places — the exact case the toV2
    // rescue exists for, and the exact case this report was written to
    // describe — came back dupIds=15, idless=0, state=healthy. The number was
    // unusable for the one thing it exists to establish (whether a future
    // merge-by-id could collapse two objects into one).
    const doc = H.freshDoc();
    const vp = doc.viewports[0].id;
    for (let i = 0; i < 15; i++) {
      doc.entities.push({ id: 'E' + i, tool: 'line', layer: 'L0', viewport: vp, startX: i, startY: 0, endX: i + 1, endY: 1 });
    }
    const wire = H.serialize(doc);
    wire.entities = W.clone(wire.model.entities);        // both populated, same ids
    const rep = inspectPages(sanitizePages([wire]));
    expect(rep.state).toBe('broken-alias');
    expect(rep.dupIds).toEqual([]);
    expect(rep.idless).toBe(0);
  });

  test('genuine duplicates and id-less entities are still caught', () => {
    const doc = H.freshDoc();
    const vp = doc.viewports[0].id;
    doc.entities.push({ id: 'E_dup', tool: 'line', layer: 'L0', viewport: vp, startX: 0, startY: 0, endX: 1, endY: 1 });
    doc.entities.push({ id: 'E_dup', tool: 'line', layer: 'L0', viewport: vp, startX: 2, startY: 0, endX: 3, endY: 1 });
    doc.entities.push({ tool: 'line', layer: 'L0', viewport: vp, startX: 4, startY: 0, endX: 5, endY: 1 });
    const rep = inspectPages(sanitizePages([H.serialize(doc)]));
    expect(rep.dupIds).toEqual(['E_dup']);
    expect(rep.idless).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('the sanitizer invents nothing, and says when it cuts', () => {

  test('a block definition with no entities key does not grow one', () => {
    // The rule this file's header states, applied to the one place that still
    // broke it. Low impact today (the editor always writes the key) and that
    // is precisely why it mattered: a synthesized empty array is
    // indistinguishable from a real one to every later reader.
    const wire = Object.assign(H.serialize(H.freshDoc()), {
      blocks: [{ id: 'B1', name: 'DOOR-3068' }]
    });
    const out = sanitizePages([wire])[0];
    expect(Object.prototype.hasOwnProperty.call(out.blocks[0], 'entities')).toBe(false);
  });

  test('a block definition that HAS entities keeps them, capped', () => {
    const wire = Object.assign(H.serialize(H.freshDoc()), {
      blocks: [{ id: 'B1', name: 'DOOR-3068', entities: [{ id: 'BE1', tool: 'line' }] }]
    });
    expect(sanitizePages([wire])[0].blocks[0].entities).toHaveLength(1);
  });

  test('truncation at a cap is reported instead of happening silently', () => {
    const doc = H.freshDoc();
    const vp = doc.viewports[0].id;
    const big = new Array(PD.MAX_ENTITIES + 1).fill(0).map((_, i) => ({ id: 'E' + i, tool: 'line', layer: 'L0', viewport: vp }));
    doc.entities.length = 0;
    doc.entities.push(...big);
    const cuts = [];
    const out = sanitizePages([H.serialize(doc)], cuts);
    expect(out[0].model.entities).toHaveLength(PD.MAX_ENTITIES);
    // One entity was deleted by a 200 OK save. That can no longer happen
    // without a record of it.
    expect(cuts).toContainEqual({ path: 'pages[0].model.entities', from: PD.MAX_ENTITIES + 1, to: PD.MAX_ENTITIES });
  });

  test('no notes when nothing was cut, and omitting the notes array changes nothing', () => {
    const wire = H.serialize(H.freshDoc());
    const cuts = [];
    expect(sanitizePages([wire], cuts)).toEqual(sanitizePages([wire]));
    expect(cuts).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('one definition of "does this row hold a drawing"', () => {

  // The census, the recovery tool and the prune guard all have to agree about
  // which rows still have geometry, or the prune deletes evidence the census
  // says is there. The JS side is inspectPages; the SQL side is this. It is
  // asserted by shape here because no database is reachable from the suite —
  // the predicate itself is only provable against Postgres, and this report
  // says so rather than implying otherwise.
  test('the SQL expression takes the greater of both aliases and treats non-arrays as zero', () => {
    const sql = sqlSheetEntityCount('v.pages');
    expect(sql).toContain('GREATEST(');
    expect(sql).toContain("v.pages->0->'entities'");
    expect(sql).toContain("v.pages->0->'model'->'entities'");
    expect((sql.match(/jsonb_typeof\(/g) || []).length).toBe(2);
    expect((sql.match(/ELSE 0 END/g) || []).length).toBe(2);
  });

  test('it is parameterised, so the plans side and the versions side cannot drift', () => {
    expect(sqlSheetEntityCount('p.pages')).toBe(sqlSheetEntityCount('v.pages').split('v.pages').join('p.pages'));
  });
});
