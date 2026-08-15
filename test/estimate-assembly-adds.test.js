// test/estimate-assembly-adds.test.js — the gate every "put this assembly on
// an estimate" path runs through.
//
// Why this file exists: 86's Estimate Authoring playbook says an assembly goes
// onto an estimate as ONE line, never hand-expanded into its components. The
// server-side guarantee behind that sentence is estimate-lines.explodeForEstimate
// (the refusals) + applyAssemblyToEstimateData (the intact, section-placed
// line). Both the HTTP append-assembly route and the payload dispatcher's
// estimate.ops.assembly_adds call exactly these two, so anything proven here
// holds for both doors.
//
// Pure module under test — no DB, no express, so no JWT_SECRET needed.

const estLines = require('../server/services/estimate-lines');
const dispatcher = require('../server/services/payload-dispatcher');

// ── Fixtures ────────────────────────────────────────────────────────
// A graph shaped like assemblies.loadGraph()'s return: { assemblies, itemsBy }.
function makeGraph(assembly, items) {
  return {
    assemblies: new Map([[assembly.id, assembly]]),
    itemsBy: new Map([[assembly.id, items]]),
  };
}

const REPAINT = { id: 47, name: 'Exterior Repaint — Stucco', unit: 'SF', params: null };

// One item per cost bucket so a rollup produces several lines.
const PRICED_ITEMS = [
  { assembly_id: 47, kind: 'material', description: 'Paint, 5-gal', unit: 'GAL',
    qty_per_unit: 0.005, unit_cost: 180, cost_code: 'materials' },
  { assembly_id: 47, kind: 'labor', description: 'Painter hours', unit: 'HR',
    qty_per_unit: 0.02, unit_cost: 45, cost_code: 'labor' },
  { assembly_id: 47, kind: 'sub', description: 'Pressure wash', unit: 'SF',
    qty_per_unit: 1, unit_cost: 0.25, cost_code: 'sub' },
];

// An estimate blob with one alternate ("Base") that already has a
// Materials section header — so we can prove a new line lands UNDER its
// header rather than at the end of the array.
function makeEstimate() {
  return {
    alternates: [{ id: 'a1', estimateId: 'est_1', name: 'Base' }],
    activeAlternateId: 'a1',
    lines: [
      { id: 's_mat', estimateId: 'est_1', alternateId: 'a1', section: '__section_header__',
        description: 'Materials & Supplies Costs', btCategory: 'materials', markup: 0 },
      { id: 'l_existing', estimateId: 'est_1', alternateId: 'a1',
        description: 'Existing material line', qty: 1, unit: 'ea', unitCost: 10 },
      { id: 's_sub', estimateId: 'est_1', alternateId: 'a1', section: '__section_header__',
        description: 'Subcontractors Costs', btCategory: 'sub', markup: 0 },
    ],
  };
}

const explode = (over) => estLines.explodeForEstimate(Object.assign({
  assembly_id: 47, graph: makeGraph(REPAINT, PRICED_ITEMS), params: { Q: 3200 },
}, over || {}));

// ── The refusals ────────────────────────────────────────────────────
describe('explodeForEstimate refusals', () => {
  test('an unpriced item is a hard stop, and the reason names the item', () => {
    const items = PRICED_ITEMS.concat([{
      assembly_id: 47, kind: 'material', description: 'Primer, 5-gal', unit: 'GAL',
      qty_per_unit: 0.004, unit_cost: null, cost_code: 'materials',
    }]);
    const r = explode({ graph: makeGraph(REPAINT, items) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('assembly_unpriced');
    // The message is what reaches the user in chat — it has to say WHICH item.
    expect(r.error).toContain('Primer, 5-gal');
    expect(r.error).toContain('price them before adding to an estimate');
    expect(r.rows).toBeUndefined();   // never a partial row set
  });

  test('a material row with no unit_cost and no catalog price is unpriced, not $0', () => {
    const items = [{ assembly_id: 47, kind: 'material', description: 'Mystery caulk',
      unit: 'EA', qty_per_unit: 1, unit_cost: null, last_unit_price: null,
      avg_unit_price: null, cost_code: 'materials' }];
    const r = explode({ graph: makeGraph(REPAINT, items) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('assembly_unpriced');
  });

  test('Q <= 0 refuses', () => {
    expect(explode({ params: { Q: 0 } })).toMatchObject({ ok: false, code: 'assembly_zero_qty' });
    expect(explode({ params: { Q: -5 } })).toMatchObject({ ok: false, code: 'assembly_zero_qty' });
    expect(explode({ params: {} })).toMatchObject({ ok: true });  // Q defaults to 1
  });

  test('a formula error refuses and reports the offending item', () => {
    const items = [{ assembly_id: 47, kind: 'material', description: 'Backer rod', unit: 'LF',
      qty_formula: 'Q / NOPE', unit_cost: 2, cost_code: 'materials' }];
    const r = explode({ graph: makeGraph(REPAINT, items) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('assembly_formula_error');
    expect(r.error).toContain('Backer rod');
    expect(Array.isArray(r.errors)).toBe(true);
  });

  test('an empty recipe refuses', () => {
    expect(explode({ graph: makeGraph(REPAINT, []) }))
      .toMatchObject({ ok: false, code: 'assembly_empty' });
  });

  test('an unknown assembly_id refuses', () => {
    expect(explode({ assembly_id: 999 })).toMatchObject({ ok: false, code: 'assembly_not_found' });
    expect(explode({ assembly_id: null })).toMatchObject({ ok: false, code: 'assembly_not_found' });
  });

  test('a clean priced recipe passes and carries the scope through', () => {
    const r = explode();
    expect(r.ok).toBe(true);
    expect(r.scope.Q).toBe(3200);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.every((row) => row.unit_cost != null)).toBe(true);
  });
});

// ── The intact line ─────────────────────────────────────────────────
describe('applyAssemblyToEstimateData — rollup is the default and stays intact', () => {
  test('mode defaults to rollup: ONE line per cost bucket, not one per component', () => {
    const ex = explode();
    const data = makeEstimate();
    const plan = estLines.applyAssemblyToEstimateData(data, {
      estId: 'est_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope,
      nowStamp: 'T1',   // no mode passed — must behave as 'rollup'
    });
    // 3 leaf rows across 3 buckets → 3 rollup lines. The tell that this is a
    // ROLLUP and not an explode is the description + qty, checked below.
    expect(plan.added).toBe(3);
    const added = data.lines.filter((l) => l.sourceAssemblyId === 47);
    expect(added).toHaveLength(3);
    added.forEach((l) => {
      expect(l.description).toContain('Exterior Repaint — Stucco');
      expect(l.qty).toBe(3200);          // the TAKEOFF qty, not a component qty
      expect(l.unit).toBe('SF');         // the assembly's OUTPUT unit
    });
    // None of the component descriptions leaked onto the estimate.
    const descs = added.map((l) => l.description).join(' | ');
    expect(descs).not.toContain('Painter hours');
    expect(descs).not.toContain('Pressure wash');
  });

  test('each rollup line carries sourceAssemblyId + assemblyParams + assemblyBreakdown', () => {
    const ex = explode();
    const data = makeEstimate();
    estLines.applyAssemblyToEstimateData(data, {
      estId: 'est_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope,
      mode: 'rollup', nowStamp: 'T2',
    });
    const added = data.lines.filter((l) => l.sourceAssemblyId === 47);
    added.forEach((l) => {
      expect(l.sourceAssemblyId).toBe(47);
      expect(l.assemblyParams).toEqual(ex.scope);         // re-explodable later
      expect(Array.isArray(l.assemblyBreakdown)).toBe(true);
      expect(l.assemblyBreakdown.length).toBeGreaterThan(0);
      expect(l.assemblyBucket).toBeTruthy();
    });
    // The breakdown is what the editor's human "explode" reads — it must hold
    // the real components, priced.
    const matLine = added.find((l) => l.assemblyBucket === 'materials');
    expect(matLine.assemblyBreakdown[0].description).toBe('Paint, 5-gal');
    expect(matLine.assemblyBreakdown[0].unit_cost).toBe(180);
  });

  test('rollup unit cost x qty reconstructs the bucket total (no money invented or lost)', () => {
    const ex = explode();
    const data = makeEstimate();
    estLines.applyAssemblyToEstimateData(data, {
      estId: 'est_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope, nowStamp: 'T3',
    });
    const added = data.lines.filter((l) => l.sourceAssemblyId === 47);
    const lineTotal = added.reduce((s, l) => s + l.qty * l.unitCost, 0);
    const rowTotal = ex.rows.reduce((s, r) => s + r.qty * r.unit_cost, 0);
    expect(lineTotal).toBeCloseTo(rowTotal, 2);
  });

  test('lines land UNDER their section header, not appended at the end', () => {
    const ex = explode();
    const data = makeEstimate();
    estLines.applyAssemblyToEstimateData(data, {
      estId: 'est_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope, nowStamp: 'T4',
    });
    const idx = (pred) => data.lines.findIndex(pred);
    const matHdr = idx((l) => l.id === 's_mat');
    const subHdr = idx((l) => l.id === 's_sub');
    const matLine = idx((l) => l.assemblyBucket === 'materials');
    const subLine = idx((l) => l.assemblyBucket === 'sub');
    const laborLine = idx((l) => l.assemblyBucket === 'labor');

    // Materials rollup sits between the Materials header and the next header.
    expect(matLine).toBeGreaterThan(matHdr);
    expect(matLine).toBeLessThan(subHdr);
    // Sub rollup sits after the Subcontractors header.
    expect(subLine).toBeGreaterThan(subHdr);
    // Labor had no header — one is created and the line goes under it, NOT
    // dumped into whatever section happened to be last.
    const laborHdr = idx((l) => l.section === '__section_header__' && l.btCategory === 'labor');
    expect(laborHdr).toBeGreaterThan(-1);
    expect(laborHdr).toBeLessThan(laborLine);
    // Nothing displaced the pre-existing line out of its own section.
    expect(idx((l) => l.id === 'l_existing')).toBeGreaterThan(matHdr);
    expect(idx((l) => l.id === 'l_existing')).toBeLessThan(subHdr);
  });

  test("mode:'exploded' is opt-in only — it produces one line per component", () => {
    const ex = explode();
    const data = makeEstimate();
    const plan = estLines.applyAssemblyToEstimateData(data, {
      estId: 'est_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope,
      mode: 'exploded', nowStamp: 'T5',
    });
    expect(plan.added).toBe(3);
    const added = data.lines.filter((l) => l.sourceAssemblyId === 47);
    expect(added.map((l) => l.description).sort())
      .toEqual(['Paint, 5-gal', 'Painter hours', 'Pressure wash']);
    // Exploded lines carry NO breakdown — there is nothing left to expand.
    added.forEach((l) => expect(l.assemblyBreakdown).toBeUndefined());
  });

  test('alternate selection: explicit pref wins, else active, else first', () => {
    const ex = explode();
    const data = makeEstimate();
    data.alternates.push({ id: 'a2', estimateId: 'est_1', name: 'Roof Option' });

    const p1 = estLines.applyAssemblyToEstimateData(data, {
      estId: 'est_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope,
      alternatePref: 'a2', nowStamp: 'T6',
    });
    expect(p1.altId).toBe('a2');
    expect(p1.altName).toBe('Roof Option');
    data.lines.filter((l) => l.id.startsWith('lT6')).forEach((l) => {
      expect(l.alternateId).toBe('a2');
    });

    // No pref → the active alternate.
    const p2 = estLines.applyAssemblyToEstimateData(data, {
      estId: 'est_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope, nowStamp: 'T7',
    });
    expect(p2.altId).toBe('a1');

    // A pref that doesn't exist must NOT invent a group — fall back, don't guess.
    const p3 = estLines.applyAssemblyToEstimateData(data, {
      estId: 'est_1', assembly: ex.assembly, rows: ex.rows, scope: ex.scope,
      alternatePref: 'nope', nowStamp: 'T8',
    });
    expect(p3.altId).toBe('a1');
    expect(p3.createdAlt).toBe(false);
  });
});

// ── The write path: estimate.ops.assembly_adds ──────────────────────
// Same refusals + same placement, reached through the payload dispatcher —
// i.e. through 86 → scribe_write → emit_payload_file → applyPayload. Proves
// the op is wired, not just that the helper works.
describe('payload dispatcher: estimate.ops.assembly_adds', () => {
  // Minimal fake of a pg client. Matches on SQL shape so an unexpected query
  // fails loudly rather than silently returning undefined.
  function fakeDb(opts) {
    const o = opts || {};
    const captured = { updates: [], data: o.data || makeEstimate() };
    return {
      captured,
      query: async (sql, params) => {
        if (/SELECT 1 FROM estimates/.test(sql)) return { rowCount: 1, rows: [{}] };
        if (/SELECT data, is_locked FROM estimates/.test(sql)) {
          return { rowCount: 1, rows: [{ data: captured.data, is_locked: !!o.locked }] };
        }
        // Order matters: loadGraph's ITEM query embeds "FROM assemblies
        // WHERE organization_id" in a subquery, so match it first.
        if (/FROM assembly_items/.test(sql)) {
          const items = o.items || PRICED_ITEMS;
          return { rowCount: items.length, rows: items };
        }
        if (/FROM assemblies WHERE organization_id/.test(sql)) {
          return { rowCount: 1, rows: [REPAINT] };
        }
        if (/UPDATE estimates/.test(sql)) { captured.updates.push(params); return { rowCount: 1, rows: [] }; }
        throw new Error('unexpected query in test: ' + sql);
      },
    };
  }

  const target = (adds) => ({
    entity_type: 'estimate', entity_id: 'est_1',
    ops: { op: 'update', assembly_adds: adds },
  });
  const CTX = { organizationId: 'org_1', userId: 'u_1' };
  const run = (db, adds) => dispatcher.internals.dispatchEstimate(db, target(adds), {}, CTX);

  test('appends the assembly intact and reports it in the changeset', async () => {
    const db = fakeDb({});
    const res = await run(db, [{ assembly_id: 47, params: { Q: 3200 } }]);
    expect(res.op).toBe('update');
    expect(res.changes.join(' ')).toContain('from assembly "Exterior Repaint — Stucco"');
    expect(db.captured.updates).toHaveLength(1);

    const saved = JSON.parse(db.captured.updates[0][0]);
    const added = saved.lines.filter((l) => l.sourceAssemblyId === 47);
    expect(added).toHaveLength(3);                 // rollup: one per bucket
    added.forEach((l) => {
      expect(l.qty).toBe(3200);
      expect(l.assemblyParams.Q).toBe(3200);
      expect(Array.isArray(l.assemblyBreakdown)).toBe(true);
    });
    // Placed in sections, not appended at the end of the array.
    const lastIdx = saved.lines.length - 1;
    expect(saved.lines[lastIdx].sourceAssemblyId === 47 &&
           saved.lines.findIndex((l) => l.assemblyBucket === 'materials') === lastIdx).toBe(false);
  });

  test('an unpriced item aborts the whole payload, terminally, and writes nothing', async () => {
    const items = PRICED_ITEMS.concat([{
      assembly_id: 47, kind: 'material', description: 'Primer, 5-gal', unit: 'GAL',
      qty_per_unit: 0.004, unit_cost: null, cost_code: 'materials',
    }]);
    const db = fakeDb({ items });
    await expect(run(db, [{ assembly_id: 47, params: { Q: 3200 } }])).rejects.toThrow(/unpriced items/);
    expect(db.captured.updates).toHaveLength(0);   // no partial write

    // retryable:false is what stops the Scribe's retry loop from re-prompting
    // — without it the Scribe's cheapest "fix" is hand-written line_adds with
    // invented unit costs, i.e. a silently understated estimate.
    let err;
    try { await run(fakeDb({ items }), [{ assembly_id: 47, params: { Q: 3200 } }]); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(dispatcher.PayloadValidationError);
    expect(err.detail.retryable).toBe(false);
    expect(err.detail.code).toBe('assembly_unpriced');
    expect(err.detail.field_path).toBe('estimate.ops.assembly_adds[0]');
  });

  test('Q <= 0 refuses terminally', async () => {
    const db = fakeDb({});
    let err;
    try { await run(db, [{ assembly_id: 47, params: { Q: 0 } }]); } catch (e) { err = e; }
    expect(err.detail.code).toBe('assembly_zero_qty');
    expect(err.detail.retryable).toBe(false);
    expect(db.captured.updates).toHaveLength(0);
  });

  test('a LOCKED (sold) estimate refuses before the assembly is even loaded', async () => {
    const db = fakeDb({ locked: true });
    await expect(run(db, [{ assembly_id: 47, params: { Q: 3200 } }]))
      .rejects.toThrow(/locked \(sold\) estimate/);
    expect(db.captured.updates).toHaveLength(0);
  });

  test('alternate_name resolves to a group; an unknown name lists the valid ones', async () => {
    const data = makeEstimate();
    data.alternates.push({ id: 'a2', estimateId: 'est_1', name: 'Roof Option' });
    const db = fakeDb({ data });
    await run(db, [{ assembly_id: 47, params: { Q: 100 }, alternate_name: 'roof option' }]);
    const saved = JSON.parse(db.captured.updates[0][0]);
    saved.lines.filter((l) => l.sourceAssemblyId === 47)
      .forEach((l) => expect(l.alternateId).toBe('a2'));

    const db2 = fakeDb({ data: (() => { const d = makeEstimate(); d.alternates.push({ id: 'a2', name: 'Roof Option' }); return d; })() });
    let err;
    try { await run(db2, [{ assembly_id: 47, params: { Q: 100 }, alternate_name: 'Fence' }]); } catch (e) { err = e; }
    expect(err.detail.code).toBe('unknown_alternate');
    expect(err.detail.expected).toEqual(['Base', 'Roof Option']);   // self-correcting
    expect(db2.captured.updates).toHaveLength(0);
  });

  test("mode defaults to rollup; 'exploded' only when explicitly asked", async () => {
    const dbA = fakeDb({});
    await run(dbA, [{ assembly_id: 47, params: { Q: 100 } }]);
    const a = JSON.parse(dbA.captured.updates[0][0]).lines.filter((l) => l.sourceAssemblyId === 47);
    expect(a.every((l) => l.description.includes('Exterior Repaint — Stucco'))).toBe(true);

    const dbB = fakeDb({});
    await run(dbB, [{ assembly_id: 47, params: { Q: 100 }, mode: 'exploded' }]);
    const b = JSON.parse(dbB.captured.updates[0][0]).lines.filter((l) => l.sourceAssemblyId === 47);
    expect(b.map((l) => l.description)).toContain('Painter hours');

    // Any other value is NOT an escape hatch into exploding.
    const dbC = fakeDb({});
    await run(dbC, [{ assembly_id: 47, params: { Q: 100 }, mode: 'components' }]);
    const c = JSON.parse(dbC.captured.updates[0][0]).lines.filter((l) => l.sourceAssemblyId === 47);
    expect(c.every((l) => l.description.includes('Exterior Repaint — Stucco'))).toBe(true);
  });

  test('assembly_adds is an accepted estimate op and must be an array', () => {
    expect(dispatcher.PAYLOAD_OPS_SCHEMAS.estimate.allowedTopKeys.has('assembly_adds')).toBe(true);
    expect(() => dispatcher.validateOps('estimate', { assembly_adds: { assembly_id: 47 } }))
      .toThrow(/assembly_adds must be an array/);
  });
});

// Regression: two assemblies in ONE payload must not produce colliding line
// ids (applyAssemblyToEstimateData seeds ids from a timestamp, and both
// entries run inside the same millisecond).
describe('payload dispatcher: multiple assembly_adds in one payload', () => {
  test('every generated line id is unique', async () => {
    const captured = { updates: [], data: makeEstimate() };
    const db = {
      captured,
      query: async (sql, params) => {
        if (/SELECT 1 FROM estimates/.test(sql)) return { rowCount: 1, rows: [{}] };
        if (/SELECT data, is_locked FROM estimates/.test(sql)) return { rowCount: 1, rows: [{ data: captured.data, is_locked: false }] };
        if (/FROM assembly_items/.test(sql)) return { rowCount: PRICED_ITEMS.length, rows: PRICED_ITEMS };
        if (/FROM assemblies WHERE organization_id/.test(sql)) return { rowCount: 1, rows: [REPAINT] };
        if (/UPDATE estimates/.test(sql)) { captured.updates.push(params); return { rowCount: 1, rows: [] }; }
        throw new Error('unexpected query in test: ' + sql);
      },
    };
    const res = await dispatcher.internals.dispatchEstimate(db, {
      entity_type: 'estimate', entity_id: 'est_1',
      ops: { op: 'update', assembly_adds: [
        { assembly_id: 47, params: { Q: 100 } },
        { assembly_id: 47, params: { Q: 250 } },
      ] },
    }, {}, { organizationId: 'org_1', userId: 'u_1' });

    expect(res.changes.join(' ')).toContain('+6 line(s)');
    const saved = JSON.parse(captured.updates[0][0]);
    const ids = saved.lines.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Both takeoff quantities survived — neither overwrote the other.
    const qtys = saved.lines.filter((l) => l.sourceAssemblyId === 47).map((l) => l.qty);
    expect(qtys.filter((q) => q === 100)).toHaveLength(3);
    expect(qtys.filter((q) => q === 250)).toHaveLength(3);
  });
});
