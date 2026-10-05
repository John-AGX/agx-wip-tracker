'use strict';

// WHY THIS FILE EXISTS
//
// The decision not to train a model rests on five corrected examples in 104
// days against a self-imposed floor of 300. But the binding problem was never
// volume, it was SHAPE, and the shape was a defect:
//
//   payload-routes.js recorded ai_training_examples.human_final as
//   `accepted ? { targets, apply_summary } : null` — and `targets` IS the
//   model's own output. So an approve stored the model's answer as the human's
//   (self-distillation: input and label are the same thing) and a reject stored
//   nothing, which the JSONL export then dropped (`human_final IS NOT NULL`).
//
// And there was no way to say "almost right": /shown, /reject and /apply were
// the only mutating routes, so a near-miss had to be rejected — destroying the
// one piece of information worth keeping and recording no reason for it.
//
// So these tests are about one claim: that a correction is now storable, is
// stored BESIDE the claim rather than over it, and reaches the training capture
// as a human answer that DIFFERS from the model's.

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ledger = require('../server/services/correction-ledger');

const LEDGER = path.join(__dirname, '..', 'server', 'services', 'correction-ledger.js');
const ROUTES = path.join(__dirname, '..', 'server', 'routes', 'payload-routes.js');
const DB = path.join(__dirname, '..', 'server', 'db.js');
const ROUTES_SRC = fs.readFileSync(ROUTES, 'utf8');
const DB_SRC = fs.readFileSync(DB, 'utf8');

const T = (over) => Object.assign({ entity_type: 'job', id: 'j1', ops: [] }, over || {});

describe('what counts as a correction', () => {
  test('a different proposal is a correction', () => {
    expect(ledger.isCorrection([T({ ops: [{ set: 1 }] })], [T({ ops: [{ set: 2 }] })])).toBe(true);
  });

  test('the same proposal is NOT, however it is spelled', () => {
    // The client round-trips JSON, so key order and nesting order differ for
    // reasons that have nothing to do with intent. An ordering difference
    // logged as a correction is a false positive in the one dataset that must
    // not have any — it would re-create the self-distillation defect under a
    // new name.
    expect(ledger.isCorrection(
      [{ entity_type: 'job', id: 'j1', ops: [{ a: 1, b: 2 }] }],
      [{ id: 'j1', ops: [{ b: 2, a: 1 }], entity_type: 'job' }]
    )).toBe(false);
  });

  test('no human value at all is not a correction', () => {
    for (const empty of [null, undefined]) {
      expect(ledger.isCorrection([T()], empty)).toBe(false);
    }
  });

  test('array ORDER is meaningful and a reorder IS a correction', () => {
    // Deliberate: for payload targets, order decides application order, so two
    // orderings are two different proposals. Canonicalising arrays as sets
    // would silently lose that.
    const a = [T({ id: 'j1' }), T({ id: 'j2' })];
    const b = [T({ id: 'j2' }), T({ id: 'j1' })];
    expect(ledger.isCorrection(a, b)).toBe(true);
  });

  test('canonical is stable for the values that actually appear', () => {
    expect(ledger.canonical({ b: 1, a: [2, { d: 4, c: 3 }] }))
      .toBe(ledger.canonical({ a: [2, { c: 3, d: 4 }], b: 1 }));
    expect(ledger.canonical(null)).toBe(null);
    expect(ledger.canonical(undefined)).toBe(null);
  });
});

describe('what an edit must look like before it touches a row', () => {
  test('the happy case', () => {
    expect(ledger.validateEdit([T()])).toEqual({ ok: true });
  });

  test('not an array, not an edit', () => {
    for (const bad of [null, undefined, {}, 'x', 7]) {
      expect(ledger.validateEdit(bad).error).toMatch(/must be an array/);
    }
  });

  test('an empty array is refused, and says to reject instead', () => {
    // Emptying the card is not a correction, it is a rejection with the
    // evidence deleted — which is the behaviour this module exists to replace.
    expect(ledger.validateEdit([]).error).toMatch(/reject the card instead/);
  });

  test('every target needs an entity_type, because the label is useless without it', () => {
    expect(ledger.validateEdit([T(), { id: 'x' }]).error).toMatch(/target 1 needs an entity_type/);
    expect(ledger.validateEdit([null]).error).toMatch(/target 0 must be an object/);
    expect(ledger.validateEdit([[T()]]).error).toMatch(/target 0 must be an object/);
  });

  test('a bounded number of targets', () => {
    const many = Array.from({ length: ledger.MAX_TARGETS + 1 }, () => T());
    expect(ledger.validateEdit(many).error).toMatch(new RegExp(String(ledger.MAX_TARGETS)));
    expect(ledger.validateEdit(many.slice(0, ledger.MAX_TARGETS))).toEqual({ ok: true });
  });

  test('it validates SHAPE and says nothing about content', () => {
    // The dispatcher is the authority on whether a target is applicable.
    // Duplicating its rules here would be a second source of truth that
    // drifts, so an unknown entity_type passes this door and is refused later.
    expect(ledger.validateEdit([T({ entity_type: 'not_a_real_entity' })])).toEqual({ ok: true });
  });
});

describe('the report counts labels, not rows', () => {
  test('an edit that changed nothing is recorded but never counted', () => {
    const r = ledger.buildCorrectionReport([
      { model_targets: [T({ ops: [1] })], human_targets: [T({ ops: [2] })] },
      { model_targets: [T()], human_targets: [T()] },
    ]);
    expect(r.edited_rows).toBe(2);
    expect(r.usable_pairs).toBe(1);
    expect(r.unchanged_edits).toBe(1);
  });

  test('it re-derives the difference rather than trusting a flag', () => {
    // A stored boolean would go stale the moment either column is touched. The
    // report must disagree with a lie.
    const r = ledger.buildCorrectionReport([
      { model_targets: [T()], human_targets: [T()], corrected: true },
    ]);
    expect(r.usable_pairs).toBe(0);
  });

  test('junk rows add nothing', () => {
    expect(ledger.buildCorrectionReport([null, {}, undefined]).usable_pairs).toBe(0);
    expect(ledger.buildCorrectionReport(null).edited_rows).toBe(0);
  });
});

describe('the queries', () => {
  test('both are scoped to one organization', () => {
    for (const sql of [ledger.pairsSql(), ledger.successorPairsSql()]) {
      expect(sql).toContain('organization_id = $1');
    }
  });

  test('pairs returns BOTH sides, so the consumer can re-derive', () => {
    const sql = ledger.pairsSql();
    expect(sql).toContain('targets        AS model_targets');
    expect(sql).toContain('human_targets  AS human_targets');
  });

  test('the successor join rides the index that already exists', () => {
    // idx_payloads_session (session_id, created_at DESC) makes the LATERAL an
    // index seek; without session_id + ORDER BY created_at it is a scan per
    // rejected row.
    const sql = ledger.successorPairsSql();
    expect(sql).toContain('p.session_id = r.session_id');
    expect(sql).toContain('ORDER BY p.created_at ASC');
    expect(sql).toContain('LIMIT 1');
    expect(DB_SRC).toContain('idx_payloads_session');
  });
});

describe('the migration stores the correction BESIDE the claim', () => {
  test('all four columns are additive', () => {
    for (const col of ['human_targets', 'corrected_by', 'corrected_at', 'reject_reason']) {
      expect(DB_SRC).toContain('ALTER TABLE payloads ADD COLUMN IF NOT EXISTS ' + col);
    }
  });

  test('nothing drops or rewrites targets', () => {
    expect(DB_SRC).not.toContain('ALTER TABLE payloads DROP COLUMN targets');
    expect(DB_SRC).not.toContain('ALTER TABLE payloads RENAME COLUMN targets');
  });

  test('the partial index covers only corrected rows', () => {
    expect(DB_SRC).toContain('idx_payloads_corrected');
    const at = DB_SRC.indexOf('idx_payloads_corrected');
    expect(DB_SRC.slice(at, at + 220)).toContain('WHERE human_targets IS NOT NULL');
  });

  test('the SQL block carries no backtick and no dollar-brace', () => {
    // This SQL lives inside a JS template literal. A backtick in a COMMENT
    // ends the literal, and the syntax error then surfaces ~800 lines earlier
    // on an unrelated interpolation — which is how this block broke db.js
    // twice while being written. Cheap to pin, impossible to spot by eye.
    const at = DB_SRC.indexOf('THE CORRECTION, STORED BESIDE THE CLAIM');
    expect(at).toBeGreaterThan(-1);
    const block = DB_SRC.slice(at, DB_SRC.indexOf('idx_payloads_targets_gin', at));
    expect(block.length).toBeGreaterThan(400);
    expect(block).not.toContain(String.fromCharCode(96));
    expect(block).not.toContain('$' + '{');
  });
});

describe('the capture finally records a HUMAN answer', () => {
  test('a corrected row sends human_targets as human_final, not the model targets', () => {
    expect(ROUTES_SRC).toContain('const corrected = correctionLedger.isCorrection(targets, humanTargets)');
    expect(ROUTES_SRC).toContain('? { targets: humanTargets, apply_summary: applySummary || null, corrected: true }');
  });

  test('a corrected row is never labelled accepted', () => {
    // It was not accepted as proposed, whatever happened to it afterwards.
    expect(ROUTES_SRC).toContain('accepted: corrected ? false : accepted');
  });

  test('the verdict capture can SEE the new columns', () => {
    // Every RETURNING that feeds capturePayloadVerdict has to carry
    // human_targets, or `corrected` is always false and the whole module is
    // inert — the quietest possible failure.
    const returning = ROUTES_SRC.match(/RETURNING id, status, targets, human_targets/g) || [];
    expect(returning.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the PUT is an apply in two steps and is gated like one', () => {
  const ROUTE = (() => {
    const at = ROUTES_SRC.indexOf("router.put('/:id'");
    expect(at).toBeGreaterThan(-1);
    const rest = ROUTES_SRC.slice(at);
    const next = rest.search(/\nrouter\.(get|post|put|patch|delete)\(/);
    return next === -1 ? rest : rest.slice(0, next);
  })();

  test('it calls denyPayloadApply rather than carrying its own rules', () => {
    // A COPIED gate is how /86/chat/continue came to run writes with no
    // capability check at all. AND onto the existing one; never fork it.
    expect(ROUTE).toContain('await denyPayloadApply(req.user, payload)');
  });

  test('it re-checks the EDITED targets, not only the proposed ones', () => {
    // Otherwise a correction that adds an entity type the caller may not write
    // passes on the strength of the model's original targets.
    expect(ROUTE).toContain('Object.assign({}, payload, { targets: humanTargets })');
  });

  test('only a ready row can be corrected', () => {
    expect(ROUTE).toContain('claimable(payload)');
    expect(ROUTE).toContain("status = 'ready'");
  });

  test('it never writes the targets column', () => {
    const upd = ROUTE.slice(ROUTE.indexOf('UPDATE payloads'), ROUTE.indexOf('RETURNING'));
    expect(upd).toContain('human_targets = $4::jsonb');
    expect(upd).not.toMatch(/\bSET[\s\S]*\btargets\s*=/);
  });

  test('it does not apply anything', () => {
    // Editing adds a verdict and no new write surface. If this route ever
    // dispatches, the capability story above stops being sufficient.
    expect(ROUTE).not.toContain('dispatcher.');
    expect(ROUTE).not.toContain('applyPayload');
  });

  test('it expires and races like the apply door', () => {
    expect(ROUTE).toContain('Payload expired');
    expect(ROUTE).toContain('Payload changed state');
  });
});

describe('a reject can finally say why', () => {
  const ROUTE = (() => {
    const at = ROUTES_SRC.indexOf("router.post('/:id/reject'");
    const rest = ROUTES_SRC.slice(at);
    const next = rest.search(/\nrouter\.(get|post|put|patch|delete)\(/);
    return next === -1 ? rest : rest.slice(0, next);
  })();

  test('a reason is stored, bounded, and optional', () => {
    expect(ROUTE).toContain('reject_reason = COALESCE(NULLIF($4');
    expect(ROUTE).toContain('.slice(0, 2000)');
  });

  test('a second bare reject cannot erase the first reason', () => {
    // The route is deliberately idempotent over 'rejected', so a plain
    // re-reject must not blank a reason that is already there. That is what
    // COALESCE(NULLIF(...)) is doing and it is easy to "simplify" away.
    expect(ROUTE).toContain('COALESCE(NULLIF($4, \'\'), reject_reason)');
  });
});

// ── mutants ───────────────────────────────────────────────────────────────
let mutantPaths = [];
afterEach(() => {
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

function mutantCopy(pairs) {
  let out = fs.readFileSync(LEDGER, 'utf8').replace(/\r\n/g, '\n');
  const src = out;
  for (const [find, replace] of pairs) {
    const n = out.split(find).length - 1;
    if (n !== 1) throw new Error('anchor matched ' + n + ' times: ' + find.slice(0, 60));
    out = out.split(find).join(replace);
  }
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  // Unique per CALL — an index-based name plus the afterEach reset gives two
  // mutants one path, and jest's module registry is separate from
  // require.cache, so the second require returns the FIRST mutant.
  const file = path.join(os.tmpdir(),
    'mutant-correction-' + process.pid + '-' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(file, out);
  mutantPaths.push(file);
  return require(file);
}

describe('mutants', () => {
  test('comparing raw JSON makes key order look like a correction', () => {
    const broken = mutantCopy([[
      '  return canonical(modelTargets) !== canonical(humanTargets);',
      '  return JSON.stringify(modelTargets) !== JSON.stringify(humanTargets);',
    ]]);
    const a = [{ entity_type: 'job', id: 'j1' }];
    const b = [{ id: 'j1', entity_type: 'job' }];
    expect(ledger.isCorrection(a, b)).toBe(false);
    expect(broken.isCorrection(a, b)).toBe(true);
  });

  test('treating a null human value as a change manufactures labels', () => {
    // Every uncorrected row in the table has human_targets NULL, so this would
    // report the entire history as corrected.
    const broken = mutantCopy([[
      '  if (humanTargets === null || humanTargets === undefined) return false;',
      '  void 0;',
    ]]);
    expect(ledger.isCorrection([T()], null)).toBe(false);
    expect(broken.isCorrection([T()], null)).toBe(true);
  });

  test('accepting an empty array turns a rejection into a correction', () => {
    const broken = mutantCopy([[
      "    return { error: 'targets must not be empty — reject the card instead of emptying it.' };",
      '    return { ok: true };',
    ]]);
    expect(ledger.validateEdit([]).error).toBeTruthy();
    expect(broken.validateEdit([])).toEqual({ ok: true });
  });

  test('counting rows instead of labels inflates the one number that decides training', () => {
    const broken = mutantCopy([[
      '    if (r && isCorrection(r.model_targets, r.human_targets)) usable++;',
      '    if (r && r.human_targets) usable++;',
    ]]);
    const rows = [{ model_targets: [T()], human_targets: [T()] }];
    expect(ledger.buildCorrectionReport(rows).usable_pairs).toBe(0);
    expect(broken.buildCorrectionReport(rows).usable_pairs).toBe(1);
  });
});
