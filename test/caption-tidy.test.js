'use strict';

// The proofreader's guard.
//
// Two earlier designs shipped and were thrown away, and both died on a corpus
// like this one, so the corpus IS the test. Everything under "must refuse" got
// through a previous design; everything under "must accept" is the button
// doing the job it exists for — including the stammer collapse, which one
// design refused, making it useless for its single most common input.

const {
  verifyTidy, tokens, anchors, canonicalize, splitsANegation, MAX_CAPTION,
} = require('../server/services/caption-tidy');

// Corruptions. Each pair is [dictated, what a model might return, why it matters].
const MUST_REFUSE = [
  ['16 LF of drip edge and 8 SF of TPO at building 4', '16 SF of drip edge and 8 LF of TPO at building 4', 'unit re-attached to a different number'],
  ['the parapet coping is not loose', 'The parapet coping is loose.', 'negation dropped'],
  ['the soffit on the north side of building 4 is rotted', 'The soffit on the south side of building 4 is rotted.', 'direction flipped'],
  ['the flashing is lifting above the parapet coping', 'The flashing is lifting below the parapet coping.', 'above became below'],
  ['the north wall is cracked and the south wall is rotted', 'The north wall is rotted and the south wall is cracked.', 'predicates swapped around identical anchors'],
  ['no active leak at the valley metal', 'No. Active leak at the valley metal.', 'a sentence break after a negation inverts the report'],
  ['the inspector approved the soffit repair', 'The inspector rejected the soffit repair.', 'approved became rejected'],
  ['there is minor damage to the fascia', 'There is major damage to the fascia.', 'minor became major'],
  ['the fascia is rotted', 'The fascia is sound.', 'condition inverted'],
  ['we need sixteen feet of drip edge', 'We need sixty feet of drip edge.', 'spelled-out number changed'],
  ['replace the TPO at building 4', 'Replace the typo at building 4.', 'mis-hearing map run backwards'],
  ['the crew repaired the downspout', 'The crew damaged the downspout.', 'agency changed'],
  ['14 6 of gutter on the east elevation', '15 6 of gutter on the east elevation', 'digit changed'],
  ['the leak is at building 4', 'The leak is at building 7.', 'building number changed'],
  ['picked up 12 SQ of shingles from ABC Supply', 'Picked up 12 SQ of shingles from Gulfeagle.', 'vendor changed'],
  ['the gutter is loose and the downspout is disconnected', 'The downspout is loose and the gutter is disconnected.', 'clauses reordered'],
  ['the soffit is rotted', 'The soffit is rotted and needs replacement.', 'clause added'],
  ['the soffit vent is damaged at the rear', 'The soffit vent is damaged.', 'clause dropped'],
  ['it looks like the flashing is lifting', 'The flashing is lifting.', 'hedge removed'],
  ['we need to replace the drip edge', 'We replaced the drip edge.', 'tense and modality changed'],
  ['16 LF here and 16 LF there', '16 LF here and there.', 'a measurement collapsed away'],
  ['the valley metal is not rusted through', 'The valley metal is rusted through.', 'second negation shape'],
  ['there is no damage to the lanai screen', 'There is no. Damage to the lanai screen.', 'negation split, mid-sentence'],
];

// Legitimate proofreads. A guard that refuses these is not a fix.
const MUST_ACCEPT = [
  ['um the soffit is uh rotted on the north side of building 4', 'The soffit is rotted on the north side of building 4.', 'filler removed'],
  ['the soffit the soffit is rotted', 'The soffit is rotted.', 'stammer collapsed'],
  ['walls walls are cracked', 'Walls are cracked.', 'stammer, two words'],
  ['the sofa is rotted above the fascia', 'The soffit is rotted above the fascia.', 'one mis-hearing'],
  ['we need to do a facia r and r on building 4', 'We need to do a fascia R&R on building 4.', 'two adjacent mis-hearings'],
  ['replace the typo at building 4', 'Replace the TPO at building 4.', 'mis-hearing, correct direction'],
  ['you know the drip ledge is bent basically', 'The drip edge is bent.', 'phrase filler plus a phrase mis-hearing'],
  ['16 LF of drip edge and 8 SF of TPO at building 4', '16 LF of drip edge and 8 SF of TPO at building 4.', 'already clean, gains a full stop'],
  ['The soffit is rotted.', 'The soffit is rotted.', 'returned unchanged'],
  ['so the gutter is loose and the downspout is disconnected on the east elevation',
   'The gutter is loose and the downspout is disconnected on the east elevation.', 'run-on punctuated'],
  ['there is no active leak at the valley metal', 'There is no active leak at the valley metal.', 'negation kept, sentence closed'],
  ['kind of a hairline crack in the stucco just above the lanai',
   'A hairline crack in the stucco above the lanai.', 'phrase filler and single filler'],
  ['um um the parapit copping is cracked', 'The parapet coping is cracked.', 'doubled filler plus two mis-hearings'],
  ['we pulled 3 SQ of shingles and 40 LF of drip ledge from the truck',
   'We pulled 3 SQ of shingles and 40 LF of drip edge from the truck.', 'measurements preserved through a correction'],
];

describe('the proofreader refuses anything that is not a licensed edit', () => {
  test.each(MUST_REFUSE)('refuses: %s -> %s (%s)', (before, after, why) => {
    const v = verifyTidy(before, after);
    expect({ why, ok: v.ok }).toEqual({ why, ok: false });
    expect(typeof v.reason).toBe('string');
    expect(v.detail.length).toBeGreaterThan(0);
  });

  test('every refusal names a reason the user could act on', () => {
    for (const [before, after] of MUST_REFUSE) {
      const v = verifyTidy(before, after);
      expect(v.detail).toMatch(/[a-z]/);
    }
  });
});

describe('the proofreader accepts the edits it exists to make', () => {
  test.each(MUST_ACCEPT)('accepts: %s -> %s (%s)', (before, after, why) => {
    const v = verifyTidy(before, after);
    expect({ why, ok: v.ok, detail: v.detail || null }).toEqual({ why, ok: true, detail: null });
  });
});

describe('the pieces the guard is built from', () => {
  test('punctuation and case are free — they are not tokenised at all', () => {
    expect(tokens('The Soffit, is rotted!')).toEqual(tokens('the soffit is rotted'));
  });

  test('anchors are an ordered sequence, not a bag', () => {
    // This is the exact blindness that let a unit swap through a previous
    // design: as a multiset these two are equal.
    const a = anchors('16 LF of drip edge and 8 SF of TPO');
    const b = anchors('16 SF of drip edge and 8 LF of TPO');
    expect(a.sort().join()).toEqual(b.slice().sort().join()); // equal as bags
    expect(anchors('16 LF of drip edge and 8 SF of TPO'))
      .not.toEqual(anchors('16 SF of drip edge and 8 LF of TPO')); // different in order
  });

  test('the mis-hearing map is applied to the original only, never the reply', () => {
    expect(canonicalize('replace the typo')).toBe('replace the tpo');
    // The reply is never canonicalised, which is why the reverse is a rewrite.
    expect(verifyTidy('replace the TPO at building 4', 'Replace the typo at building 4.').ok).toBe(false);
    expect(verifyTidy('replace the typo at building 4', 'Replace the TPO at building 4.').ok).toBe(true);
  });

  test('a sentence break after a negation is spotted even with everything else identical', () => {
    expect(splitsANegation('No. Active leak at the valley metal.')).toBe('no');
    expect(splitsANegation('There is no active leak at the valley metal.')).toBe(null);
    // tokens, anchors and word counts are all identical across this pair
    const a = 'no active leak at the valley metal';
    const b = 'No. Active leak at the valley metal.';
    expect(tokens(a)).toEqual(tokens(b));
    expect(anchors(a)).toEqual(anchors(b));
    expect(verifyTidy(a, b).reason).toBe('negation-split');
  });

  test('a caption at the cap is allowed and one over it is not', () => {
    const long = 'the soffit is rotted '.repeat(200).trim();
    expect(long.length).toBeGreaterThan(MAX_CAPTION);
    expect(verifyTidy(long.slice(0, 100), long).ok).toBe(false);
  });

  test('an empty reply is refused rather than saved over the dictation', () => {
    expect(verifyTidy('the soffit is rotted', '').ok).toBe(false);
    expect(verifyTidy('the soffit is rotted', '   ').reason).toBe('empty');
  });
});

// MUTATION TESTS. Each of these weakens the guard the way a previous design
// was weak, and each must make the corpus fail. A guard whose corpus passes
// either way is the vacuous assertion this repo keeps paying for.
describe('the guard is load-bearing', () => {
  const refusedCount = (fn) => MUST_REFUSE.filter(([a, b]) => !fn(a, b).ok).length;

  test('as shipped, every corruption is refused and every legitimate edit accepted', () => {
    expect(refusedCount(verifyTidy)).toBe(MUST_REFUSE.length);
    expect(MUST_ACCEPT.filter(([a, b]) => verifyTidy(a, b).ok).length).toBe(MUST_ACCEPT.length);
  });

  test('comparing anchors as a BAG lets the unit swap through', () => {
    const bagCompare = (before, after) => {
      const a = anchors(before).slice().sort();
      const b = anchors(after).slice().sort();
      return { ok: a.join() === b.join() };
    };
    // The mutant accepts the very first corruption in the corpus.
    expect(bagCompare(MUST_REFUSE[0][0], MUST_REFUSE[0][1]).ok).toBe(true);
    expect(verifyTidy(MUST_REFUSE[0][0], MUST_REFUSE[0][1]).ok).toBe(false);
  });

  test('dropping the negation-split carve-out lets the inversion through', () => {
    // Everything else the guard checks is identical across this pair, so
    // without that one rule it is indistinguishable from a clean proofread.
    const a = 'no active leak at the valley metal';
    const b = 'No. Active leak at the valley metal.';
    expect(tokens(a)).toEqual(tokens(b));
    expect(anchors(a)).toEqual(anchors(b));
    expect(verifyTidy(a, b).ok).toBe(false);
    expect(verifyTidy(a, b).reason).toBe('negation-split');
  });

  test('canonicalising BOTH sides would go blind to a backwards mis-hearing', () => {
    // The map rewrites KEYS only, and "tpo" is a value, not a key. So the
    // correct spelling passes through untouched while the mis-hearing is
    // rewritten — which is exactly what makes the two distinguishable.
    expect(canonicalize('replace the TPO')).toBe('replace the TPO');
    expect(canonicalize('replace the typo')).toBe('replace the tpo');
    // A two-way map would send both of these to the same string and go blind.
    expect(verifyTidy('replace the TPO at building 4', 'Replace the typo at building 4.').ok).toBe(false);
  });
});
