// The shape guard that decides whether the Scribe's dry-run diff is safe to
// persist as a draft the Cowork page will render.
//
// This is the gate between "the agent proposed something and you can see
// exactly what" and "the agent proposed something and the page shows you an
// empty box" — which reads, correctly, as the feature being broken.

const { isRenderableChangeset } = require('../server/services/changeset-guard');

describe('isRenderableChangeset', () => {
  test('accepts a real before/after changeset', () => {
    expect(isRenderableChangeset([
      { entity_type: 'estimate', id: 'est_1', before: { id: 'est_1' }, after: { id: 'est_1' } }
    ])).toBe(true);
  });

  test('accepts a create (before: null) — null is still a snapshot', () => {
    expect(isRenderableChangeset([
      { entity_type: 'lead', id: 'lead_9', before: null, after: { id: 'lead_9' } }
    ])).toBe(true);
  });

  test('accepts a delete (after: null)', () => {
    expect(isRenderableChangeset([
      { entity_type: 'lead', id: 'lead_9', before: { id: 'lead_9' }, after: null }
    ])).toBe(true);
  });

  // THE bug this guard exists for. `[].every(fn)` is true, so a length check
  // is the only thing standing between an empty changeset and a draft row
  // advertising has_draft=true with nothing to show.
  test('REJECTS an empty array — [].every() is true, so length is the real guard', () => {
    expect(isRenderableChangeset([])).toBe(false);
  });

  // A schedule / system / assembly / deal_memory write produces exactly this:
  // the dispatcher has no snapshot table for those entity types, so it pushes
  // nothing into the changeset at all.
  test('REJECTS the affected_targets fallback shape (no before/after)', () => {
    expect(isRenderableChangeset([
      { entity_type: 'schedule', entity_id: 'sch_3' }
    ])).toBe(false);
  });

  test('REJECTS a mixed array where any entry lacks snapshots', () => {
    expect(isRenderableChangeset([
      { entity_type: 'estimate', id: 'e1', before: {}, after: {} },
      { entity_type: 'schedule', entity_id: 's1' }
    ])).toBe(false);
  });

  test('REJECTS non-arrays and junk', () => {
    expect(isRenderableChangeset(null)).toBe(false);
    expect(isRenderableChangeset(undefined)).toBe(false);
    expect(isRenderableChangeset('[]')).toBe(false);
    expect(isRenderableChangeset({ before: {}, after: {} })).toBe(false);
    expect(isRenderableChangeset([null])).toBe(false);
    expect(isRenderableChangeset(['x'])).toBe(false);
  });
});
