// test/estimate-scope-write.test.js — the gate on "write a scope of work
// onto an estimate."
//
// WHY THIS FILE EXISTS. On the Uptown Dumpster Repair estimate the Scribe
// wrote a scope three times across three days. All three payloads went
// `applied` with `apply_error: null`. None of the text ever appeared.
//
// The dispatcher put scope text on `data.scope` — a blob key with ZERO
// readers anywhere in the product. Every surface that shows scope reads
// `data.alternates[i].scope` (the editor's scope panel, the preview, the
// proposal, the BT export) and so does the agent's own turn context. So
// the writer could not observe its own write, concluded there was no scope
// yet, and wrote it again. A write-only field plus a read path that skips
// it is a closed retry loop, and it is silent by construction.
//
// The rules this file pins down:
//   1. Scope text lands where the app reads it — never on the blob.
//   2. Both entry shapes (`ops.scope` AND `ops.field_updates.scope`) do it;
//      field_updates is the shape that actually shipped the bug.
//   3. A scope/line write aimed at a group that doesn't exist REFUSES with
//      a named code. It never silently retargets.
//   4. Seeding a group onto a legacy estimate cannot move money.
//   5. Section grouping is POSITIONAL — a new line must not disturb where
//      existing lines sit.
//
// Pure module under test — no DB, no express, so no JWT_SECRET needed.

const dispatcher = require('../server/services/payload-dispatcher');
const {
  applyEstimateScopeText,
  migrateLegacyEstimateScope,
  applyLineAdds,
  applyEstimateGroups,
} = dispatcher.internals;

const money = require('../server/services/money/estimate-totals');

// ── Fixtures ────────────────────────────────────────────────────────

// The shape the live Uptown estimate is in: exactly one client-seeded
// group ("Base"), empty scope, no excludeFromTotal key.
function uptown() {
  return {
    id: 'e_uptown',
    alternates: [{ id: 'alt_default', name: 'Base', isDefault: true, scope: '' }],
    activeAlternateId: 'alt_default',
    lines: [
      { id: 's_mat', estimateId: 'e_uptown', alternateId: 'alt_default',
        section: '__section_header__', description: 'Materials & Supplies Costs',
        btCategory: 'materials', markup: 0 },
      { id: 'l_mat1', estimateId: 'e_uptown', alternateId: 'alt_default',
        description: 'Concrete, 4000 psi', qty: 6, unit: 'CY', unitCost: 180 },
      { id: 's_lab', estimateId: 'e_uptown', alternateId: 'alt_default',
        section: '__section_header__', description: 'Direct Labor',
        btCategory: 'labor', markup: 0 },
      { id: 'l_lab1', estimateId: 'e_uptown', alternateId: 'alt_default',
        description: 'Form + pour', qty: 16, unit: 'HR', unitCost: 55 },
      { id: 's_sub', estimateId: 'e_uptown', alternateId: 'alt_default',
        section: '__section_header__', description: 'Subcontractors Costs',
        btCategory: 'sub', markup: 0 },
    ],
  };
}

// Two client-facing options, the case where "the active group" is a guess.
function twoScopes() {
  return {
    id: 'e_two',
    alternates: [
      { id: 'a_roof', name: 'Roof Repair', scope: 'roof text' },
      { id: 'a_win',  name: 'Window Repair', scope: 'window text' },
    ],
    activeAlternateId: 'a_roof',
    lines: [
      { id: 's_r_mat', estimateId: 'e_two', alternateId: 'a_roof',
        section: '__section_header__', description: 'Materials & Supplies Costs',
        btCategory: 'materials', markup: 0 },
      { id: 's_w_mat', estimateId: 'e_two', alternateId: 'a_win',
        section: '__section_header__', description: 'Materials & Supplies Costs',
        btCategory: 'materials', markup: 0 },
      { id: 's_w_sub', estimateId: 'e_two', alternateId: 'a_win',
        section: '__section_header__', description: 'Subcontractors Costs',
        btCategory: 'sub', markup: 0 },
    ],
  };
}

const SCOPE = '<p>Scope of Work — Concrete Dumpster Pad Repair</p><ul><li>Saw cut</li></ul>';

// ── 1. Scope lands where the app reads it ───────────────────────────

describe('estimate scope text goes on the GROUP, not the blob', () => {
  test('ops.scope writes alternates[i].scope and leaves no blob key', () => {
    const est = uptown();
    applyEstimateScopeText(est, SCOPE, { fieldPath: 'estimate.ops.scope' });
    expect(est.alternates[0].scope).toBe(SCOPE);
    // The exact regression: a truthy data.scope means it is invisible again.
    expect(est.scope).toBeUndefined();
  });

  test('scope targets the ACTIVE group when several exist', () => {
    const est = twoScopes();
    applyEstimateScopeText(est, SCOPE, {});
    expect(est.alternates.find((a) => a.id === 'a_roof').scope).toBe(SCOPE);
    expect(est.alternates.find((a) => a.id === 'a_win').scope).toBe('window text');
  });

  test('an explicit group name routes the scope to that group', () => {
    const est = twoScopes();
    applyEstimateScopeText(est, SCOPE, { alternateName: 'window repair' }); // case-insensitive
    expect(est.alternates.find((a) => a.id === 'a_win').scope).toBe(SCOPE);
    expect(est.alternates.find((a) => a.id === 'a_roof').scope).toBe('roof text');
  });
});

// ── 2. The miss path speaks ─────────────────────────────────────────

describe('an unresolvable scope target REFUSES by name', () => {
  test('unknown group name → unknown_alternate, listing the real names', () => {
    const est = twoScopes();
    let err = null;
    try { applyEstimateScopeText(est, SCOPE, { alternateName: 'Deck Repair' }); }
    catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.name).toBe('PayloadValidationError');
    expect(err.detail.code).toBe('unknown_alternate');
    expect(err.detail.retryable).toBe(false);
    expect(err.detail.expected).toEqual(['Roof Repair', 'Window Repair']);
    // …and nothing was written anywhere.
    expect(est.alternates.map((a) => a.scope)).toEqual(['roof text', 'window text']);
    expect(est.scope).toBeUndefined();
  });

  test('an ambiguous group name → ambiguous_alternate, not a coin flip', () => {
    const est = twoScopes();
    est.alternates.push({ id: 'a_win2', name: 'Window Repair', scope: 'dup' });
    let err = null;
    try { applyEstimateScopeText(est, SCOPE, { alternateName: 'Window Repair' }); }
    catch (e) { err = e; }
    expect(err && err.detail.code).toBe('ambiguous_alternate');
    expect(est.alternates.find((a) => a.id === 'a_win').scope).toBe('window text');
  });

  test('unknown group id → unknown_alternate, listing the real ids', () => {
    const est = twoScopes();
    let err = null;
    try { applyEstimateScopeText(est, SCOPE, { alternateId: 'alt_nope' }); }
    catch (e) { err = e; }
    expect(err && err.detail.code).toBe('unknown_alternate');
    expect(err.detail.expected).toEqual(['a_roof', 'a_win']);
  });

  test('groups:[{op:"update"}] against a missing id refuses typed, not bare', () => {
    const est = twoScopes();
    let err = null;
    try { applyEstimateGroups(est, [{ op: 'update', group_id: 'ghost', scope: SCOPE }]); }
    catch (e) { err = e; }
    expect(err && err.name).toBe('PayloadValidationError');
    expect(err.detail.code).toBe('unknown_alternate');
    expect(err.detail.retryable).toBe(false);
  });
});

// ── 3. Recovering what the dead field already swallowed ─────────────

describe('legacy data.scope is recovered, never destroyed', () => {
  test('stranded blob text moves onto the group and the dead key goes away', () => {
    const est = uptown();
    est.scope = 'the 1044 characters nobody could see';
    expect(migrateLegacyEstimateScope(est)).toBe(true);
    expect(est.alternates[0].scope).toBe('the 1044 characters nobody could see');
    expect(est.scope).toBeUndefined();
  });

  test('divergent group text wins, and the orphan is KEPT rather than deleted', () => {
    const est = uptown();
    est.alternates[0].scope = 'what the user actually sees';
    est.scope = 'a different stranded draft';
    expect(migrateLegacyEstimateScope(est)).toBe(false);
    expect(est.alternates[0].scope).toBe('what the user actually sees');
    // Not silently thrown away — a dead field costs nothing, lost scope costs a lot.
    expect(est.scope).toBe('a different stranded draft');
  });

  test('a scope write recovers the orphan first, then applies the new text', () => {
    const est = uptown();
    est.scope = 'stranded';
    applyEstimateScopeText(est, SCOPE, {});
    expect(est.alternates[0].scope).toBe(SCOPE);
    expect(est.scope).toBeUndefined();
  });
});

// ── 4. Seeding a group onto a legacy estimate cannot move money ─────

describe('auto-seeding "Base" on a group-less estimate is total-neutral', () => {
  function legacyNoGroups() {
    return {
      id: 'e_legacy',
      lines: [
        { id: 's1', estimateId: 'e_legacy', section: '__section_header__',
          description: 'Materials & Supplies Costs', btCategory: 'materials', markup: 0 },
        { id: 'l1', estimateId: 'e_legacy', description: 'Lumber', qty: 10, unit: 'EA', unitCost: 100 },
        { id: 'l2', estimateId: 'e_legacy', description: 'Fasteners', qty: 4, unit: 'BX', unitCost: 25 },
      ],
    };
  }

  test('proposal total is identical before and after the seed', () => {
    const before = money.computeEstimateTotals(legacyNoGroups());
    const est = legacyNoGroups();
    applyEstimateScopeText(est, SCOPE, {});
    const after = money.computeEstimateTotals(est);
    // The regression this guards: both totals engines flip from "sum every
    // line" to "sum lines whose alternateId matches an INCLUDED group" the
    // moment alternates[] is non-empty. Seeding without adopting the
    // existing lines drops the proposal to $0 — and a job converted from
    // it gets seeded with no scope at all.
    expect(after.proposalTotal).toBeCloseTo(before.proposalTotal, 6);
    expect(after.proposalTotal).toBeGreaterThan(0);
  });

  test('every pre-existing line is adopted into the seeded group', () => {
    const est = legacyNoGroups();
    applyEstimateScopeText(est, SCOPE, {});
    expect(est.alternates).toHaveLength(1);
    expect(est.activeAlternateId).toBe(est.alternates[0].id);
    est.lines.forEach((l) => expect(l.alternateId).toBe(est.alternates[0].id));
    expect(est.alternates[0].scope).toBe(SCOPE);
  });

  test('the seed inherits the legacy scopeOfWork rather than blanking it', () => {
    const est = legacyNoGroups();
    est.scopeOfWork = 'old narrative';
    applyEstimateScopeText(est, undefined, {});
    expect(est.alternates[0].scope).toBe('old narrative');
  });

  test('naming a group on an estimate that has none refuses instead of inventing one', () => {
    const est = legacyNoGroups();
    let err = null;
    try { applyEstimateScopeText(est, SCOPE, { alternateName: 'Roof' }); } catch (e) { err = e; }
    expect(err && err.detail.code).toBe('unknown_alternate');
    // No group was invented to satisfy the name, and no line was touched.
    expect(est.alternates).toHaveLength(0);
    expect(est.lines.every((l) => !l.alternateId)).toBe(true);
  });
});

// ── 5. Lines: right scope AND right section, or a named refusal ─────

describe('line_adds land in the named scope and the right section', () => {
  test('happy path — alternate_name + section put the line in both', () => {
    const est = twoScopes();
    applyLineAdds(est, [{
      description: 'Shingles', qty: 30, unit: 'SQ', unit_cost: 120,
      alternate_name: 'Window Repair', section: 'Subcontractors Costs',
    }]);
    const row = est.lines.find((l) => l.description === 'Shingles');
    expect(row).toBeTruthy();
    // Right SCOPE.
    expect(row.alternateId).toBe('a_win');
    // Right SECTION — and "right" means POSITIONAL: immediately after the
    // Subcontractors header of that same scope, because grouping is decided
    // by array position between __section_header__ rows, not by any field.
    const hdr = est.lines.findIndex((l) => l.id === 's_w_sub');
    expect(est.lines.indexOf(row)).toBe(hdr + 1);
    expect(row.section).toBe('Subcontractors Costs');
    expect(row.btCategory).toBe('sub');
  });

  test('miss path — an unknown scope name REFUSES; no line is added anywhere', () => {
    const est = twoScopes();
    const before = est.lines.length;
    let err = null;
    try {
      applyLineAdds(est, [{ description: 'Ghost line', qty: 1, unit_cost: 5,
        alternate_name: 'Deck Repair' }]);
    } catch (e) { err = e; }
    expect(err && err.name).toBe('PayloadValidationError');
    expect(err.detail.code).toBe('unknown_alternate');
    expect(err.detail.op_index).toBe(0);
    expect(err.detail.expected).toEqual(['Roof Repair', 'Window Repair']);
    // The old behaviour: fall through to the active scope's Materials
    // section and report "+1 line(s)" — a wrong scope that looks right.
    expect(est.lines).toHaveLength(before);
    expect(est.lines.some((l) => l.description === 'Ghost line')).toBe(false);
  });

  test('miss path — an unknown subgroup_id REFUSES by name', () => {
    const est = uptown();
    const before = est.lines.length;
    let err = null;
    try {
      applyLineAdds(est, [{ description: 'Ghost', qty: 1, unit_cost: 5, subgroup_id: 's_nope' }]);
    } catch (e) { err = e; }
    expect(err && err.detail.code).toBe('unknown_subgroup');
    expect(err.detail.retryable).toBe(false);
    expect(est.lines).toHaveLength(before);
  });

  test('miss path — an unknown explicit alternateId REFUSES', () => {
    const est = twoScopes();
    let err = null;
    try {
      applyLineAdds(est, [{ description: 'Ghost', qty: 1, unit_cost: 5, alternateId: 'a_nope' }]);
    } catch (e) { err = e; }
    expect(err && err.detail.code).toBe('unknown_alternate');
  });
});

// ── 6. Regression: positional grouping survives an add ──────────────

describe('POSITIONAL section grouping is preserved by a new line', () => {
  test('an add into Materials does not disturb where existing lines sit', () => {
    const est = uptown();
    const orderBefore = est.lines.map((l) => l.id);

    applyLineAdds(est, [{
      description: 'Rebar #4', qty: 20, unit: 'EA', unit_cost: 9,
      subgroup_id: 's_mat',
    }]);

    const row = est.lines.find((l) => l.description === 'Rebar #4');
    // Spliced INSIDE Materials — after its header, before the next header.
    const iHdr = est.lines.indexOf(est.lines.find((l) => l.id === 's_mat'));
    const iNext = est.lines.indexOf(est.lines.find((l) => l.id === 's_lab'));
    const iRow = est.lines.indexOf(row);
    expect(iRow).toBeGreaterThan(iHdr);
    expect(iRow).toBeLessThan(iNext);

    // Every pre-existing row keeps its RELATIVE order, so no line changes
    // which section it renders under. This is the guard against the old
    // push-to-the-end behaviour, which parked every add after the last
    // header and silently booked it as Subcontractor cost.
    const orderAfter = est.lines.map((l) => l.id).filter((id) => orderBefore.includes(id));
    expect(orderAfter).toEqual(orderBefore);
  });

  test('a line with no resolvable section lands in Materials, never the array end', () => {
    const est = uptown();
    applyLineAdds(est, [{ description: 'Unclassified', qty: 1, unit_cost: 10 }]);
    const row = est.lines.find((l) => l.description === 'Unclassified');
    const iSub = est.lines.indexOf(est.lines.find((l) => l.id === 's_sub'));
    expect(est.lines.indexOf(row)).toBeLessThan(iSub);
    expect(row.btCategory).toBe('materials');
  });

  test('adds into two different scopes stay in their own blocks', () => {
    const est = twoScopes();
    applyLineAdds(est, [
      { description: 'Roof item', qty: 1, unit_cost: 1, alternate_name: 'Roof Repair' },
      { description: 'Window item', qty: 1, unit_cost: 1, alternate_name: 'Window Repair' },
    ]);
    const roof = est.lines.find((l) => l.description === 'Roof item');
    const win  = est.lines.find((l) => l.description === 'Window item');
    expect(roof.alternateId).toBe('a_roof');
    expect(win.alternateId).toBe('a_win');
    // Each sits under a header belonging to its OWN scope.
    [[roof, 'a_roof'], [win, 'a_win']].forEach(([r, altId]) => {
      let hdr = null;
      for (let i = est.lines.indexOf(r) - 1; i >= 0; i--) {
        const L = est.lines[i];
        if (L.section === '__section_header__' && L.alternateId === altId) { hdr = L; break; }
      }
      expect(hdr).toBeTruthy();
    });
  });
});

// ── 7. field_updates.scope — the shape that actually shipped the bug ─

describe('ops.field_updates.scope is intercepted, not stored on the blob', () => {
  test("'scope' is not treated as a free-form blob key", () => {
    const est = uptown();
    // Simulate the dispatcher's field_updates loop for the one key that matters.
    const fieldUpdates = { scope: SCOPE, name: 'Uptown Dumpster Repair' };
    for (const k of Object.keys(fieldUpdates)) {
      if (dispatcher.internals.ESTIMATE_BLOCKED_FIELDS.has(k)) continue;
      if (k === 'scope') {
        applyEstimateScopeText(est, fieldUpdates[k],
          { fieldPath: 'estimate.ops.field_updates.scope' });
        continue;
      }
      est[k] = fieldUpdates[k];
    }
    expect(est.alternates[0].scope).toBe(SCOPE);
    expect(est.scope).toBeUndefined();
    expect(est.name).toBe('Uptown Dumpster Repair');
  });

  test('alternates[] is blocked from field_updates — it would orphan every line', () => {
    expect(dispatcher.internals.ESTIMATE_BLOCKED_FIELDS.has('alternates')).toBe(true);
  });

  test('scopeOfWork is NOT hijacked — it has live readers of its own', () => {
    expect(dispatcher.internals.ESTIMATE_BLOCKED_FIELDS.has('scopeOfWork')).toBe(false);
  });
});
