// Entity ids have to be unique before anything is ever keyed on them.
//
// uid() was `Math.random().toString(36).slice(2, 9)` — 7 base-36 characters,
// a ~7.8e10 space, minted client-side with nothing separating one session
// from another. Within a single document that is a birthday problem: at the
// 20,000-entity cap, P(some pair already shares an id) ≈ 20000² / (2·7.8e10)
// ≈ 0.26% — roughly one large takeoff in four hundred.
//
// That is harmless while ids are labels. Entities live in an array, the
// renderer iterates, selectedEntity() takes the first .filter() hit, and both
// objects draw. It stops being harmless the moment an id becomes a MERGE KEY:
// a splice or upsert keyed on a duplicated id collapses two objects into one,
// permanently, in an existing drawing. So this has to be true first.
//
// The scale below (100k) is not one document — it is one long session across
// draws, copies, DXF imports and undo/redo, all of which mint ids. It is
// chosen so the test measures ENTROPY rather than luck: the old scheme would
// expect ~64 collisions at this count (P(clean) ≈ e^-64), while the current
// scheme is collision-free by construction and so is not flaky in either
// direction.

'use strict';

const H = require('./helpers/sheet-doc-harness');

const { uid, rnd36 } = H.SE._ids;

describe('entity ids', () => {

  test('100k ids in one session are all distinct', () => {
    const seen = new Set();
    for (let i = 0; i < 100000; i++) seen.add(uid('line'));
    expect(seen.size).toBe(100000);
  });

  test('ids carry their prefix and stay opaque strings', () => {
    expect(uid('VP')).toMatch(/^VP_[0-9a-z]+$/);
    expect(uid('L')).toMatch(/^L_[0-9a-z]+$/);
    expect(uid()).toMatch(/^e_[0-9a-z]+$/);
  });

  test('ids are collision-free BY CONSTRUCTION: one session salt, one counter', () => {
    // This is the assertion that matters, and the one a sampling test cannot
    // make. Uniqueness must not be a probability at all: every id minted in
    // this session carries the same 8-character salt, and the counter after
    // it cannot repeat. A random tail would satisfy "these 1000 happen to be
    // distinct" while still being a birthday problem at 20,000.
    //
    // One counter across ALL prefixes, deliberately: an entity id and a
    // viewport id must never be able to land on the same string, because a
    // merge keyed on ids does not know which array an id came from.
    const tail = (s) => s.slice(s.indexOf('_') + 1);
    const ids = [];
    ['line', 'rect', 'VP', 'L', 'S', 'B'].forEach((p) => {
      for (let i = 0; i < 200; i++) ids.push(uid(p));
    });
    const tails = ids.map(tail);
    const salt = tails[0].slice(0, 8);
    tails.forEach((t) => expect(t.slice(0, 8)).toBe(salt));   // one session
    expect(new Set(tails).size).toBe(tails.length);           // one counter
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('rnd36 always returns the requested length', () => {
    // Math.random().toString(36) is not always long enough to slice from —
    // the old one-shot slice(2,9) could return fewer than 7 characters and
    // silently shrink the space further.
    for (let i = 0; i < 5000; i++) expect(rnd36(8)).toHaveLength(8);
  });

  test('the previous scheme was too small for one document, by measurement', () => {
    // Measured, not sampled: sampling 20k ids and hoping for a collision is a
    // coin-flip test at 0.26% and would be uselessly flaky. Measure the SPACE
    // instead — the length of the random part is what bounds it — then do the
    // birthday arithmetic at the entity cap the editor actually enforces.
    const legacy = () => Math.random().toString(36).slice(2, 9);
    let maxLen = 0;
    for (let i = 0; i < 200000; i++) maxLen = Math.max(maxLen, legacy().length);
    expect(maxLen).toBeLessThanOrEqual(7);          // ≤ 36^7 distinct values

    const CAP = 20000;                              // MAX_ENTITIES in one document
    const space = Math.pow(36, maxLen);
    const pCollision = 1 - Math.exp(-(CAP * (CAP - 1)) / (2 * space));
    expect(pCollision).toBeGreaterThan(0.002);      // ~1 large takeoff in 400

    // The current scheme's in-session collision probability is not small,
    // it is zero: the counter cannot repeat.
    const seen = new Set();
    for (let i = 0; i < CAP; i++) seen.add(uid('e'));
    expect(seen.size).toBe(CAP);
  });

  test('the id space is large enough that a session salt collision is remote', () => {
    const salts = new Set();
    for (let i = 0; i < 20000; i++) salts.add(rnd36(8));
    expect(salts.size).toBe(20000);
  });
});
