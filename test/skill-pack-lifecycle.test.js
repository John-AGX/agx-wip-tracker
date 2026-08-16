// test/skill-pack-lifecycle.test.js — "retired" has to mean retired in
// every store that feeds collectSkillsFor.
//
// The bug these guard: a pack archived out of org_skill_packs was left
// sitting in app_settings.agent_skills with its id cleared. sync-all walks
// THAT array, saw no id, and minted a brand-new Anthropic skill for every
// one of them. Measured 2026-08-16: five retired packs re-created upstream
// in a single 5-second burst and re-attached to the job agent, all
// reporting status "synced". The pack came back from the dead and the API
// called it success.
//
// app_settings.agent_skills is now the authority, and the retire path
// removes the pack from both stores. These cover the two pure halves that
// decide WHAT gets retired — getting either wrong retires a live pack (an
// outage) or leaves a dead one attached (the original bug).

const { removedPacks, dropPackByName, packMatches } = require('../server/services/skill-pack-lifecycle');

const cfg = (...skills) => ({ skills: skills });

describe('removedPacks — what the admin actually deleted', () => {
  test('a deleted pack is reported with its upstream id so it can be detached', () => {
    const prior = cfg(
      { name: 'Estimate Authoring', anthropic_skill_id: 'skill_A' },
      { name: 'Project 86 Group Discipline', anthropic_skill_id: 'skill_B' }
    );
    const next = cfg({ name: 'Estimate Authoring', anthropic_skill_id: 'skill_A' });

    expect(removedPacks(prior, next)).toEqual([
      { name: 'Project 86 Group Discipline', anthropic_skill_id: 'skill_B' }
    ]);
  });

  test('a BODY EDIT is not a deletion', () => {
    const prior = cfg({ name: 'WIP & Cost Analysis', body: '35%', anthropic_skill_id: 'skill_A' });
    const next = cfg({ name: 'WIP & Cost Analysis', body: '50%', anthropic_skill_id: 'skill_A' });
    expect(removedPacks(prior, next)).toEqual([]);
  });

  test('a RENAME is not a deletion — the id survives, the name does not', () => {
    const prior = cfg({ name: 'WIP Analyst Playbook', anthropic_skill_id: 'skill_A' });
    const next = cfg({ name: 'WIP & Cost Analysis', anthropic_skill_id: 'skill_A' });
    expect(removedPacks(prior, next)).toEqual([]);
  });

  test('a REORDER is not a deletion', () => {
    const a = { name: 'A', anthropic_skill_id: 'skill_A' };
    const b = { name: 'B', anthropic_skill_id: 'skill_B' };
    expect(removedPacks(cfg(a, b), cfg(b, a))).toEqual([]);
  });

  test('a never-synced pack is matched by name', () => {
    expect(removedPacks(cfg({ name: 'Draft pack' }), cfg({ name: 'Draft pack', body: 'x' }))).toEqual([]);
    expect(removedPacks(cfg({ name: 'Draft pack' }), cfg())).toEqual([
      { name: 'Draft pack', anthropic_skill_id: null }
    ]);
  });

  test('several deletions in one save all come back', () => {
    const prior = cfg(
      { name: 'Keep', anthropic_skill_id: 'skill_K' },
      { name: 'Workspace placement and wiring discipline', anthropic_skill_id: 'skill_W' },
      { name: 'Project 86 Pricing Benchmark Loop', anthropic_skill_id: 'skill_P' }
    );
    const out = removedPacks(prior, cfg({ name: 'Keep', anthropic_skill_id: 'skill_K' }));
    expect(out.map(p => p.name)).toEqual([
      'Workspace placement and wiring discipline',
      'Project 86 Pricing Benchmark Loop'
    ]);
  });

  test('an unreadable side reports NOTHING removed — never "all of them"', () => {
    // The failure mode that would matter: a malformed save silently
    // detaching every skill the agent has.
    const prior = cfg({ name: 'Estimate Authoring', anthropic_skill_id: 'skill_A' });
    expect(removedPacks(prior, null)).toEqual([]);
    expect(removedPacks(prior, {})).toEqual([]);
    expect(removedPacks(prior, { skills: 'not-an-array' })).toEqual([]);
    expect(removedPacks(null, cfg())).toEqual([]);
  });

  test('emptying the array deliberately IS a deletion of everything in it', () => {
    const prior = cfg({ name: 'A', anthropic_skill_id: 'skill_A' });
    expect(removedPacks(prior, { skills: [] })).toEqual([
      { name: 'A', anthropic_skill_id: 'skill_A' }
    ]);
  });
});

describe('dropPackByName — the org-delete half', () => {
  test('removes the matching entry and reports its upstream id', () => {
    const before = cfg(
      { name: 'Estimate Authoring', anthropic_skill_id: 'skill_A' },
      { name: 'Project 86 Lead/Client Linking', anthropic_skill_id: 'skill_L' }
    );
    const out = dropPackByName(before, 'Project 86 Lead/Client Linking');

    expect(out.removed).toEqual([{ name: 'Project 86 Lead/Client Linking', anthropic_skill_id: 'skill_L' }]);
    expect(out.value.skills.map(p => p.name)).toEqual(['Estimate Authoring']);
    // Input untouched — the caller writes the returned value or nothing.
    expect(before.skills).toHaveLength(2);
  });

  test('a name that is not there changes nothing', () => {
    const before = cfg({ name: 'Estimate Authoring' });
    const out = dropPackByName(before, 'Nope');
    expect(out.removed).toEqual([]);
    expect(out.value).toBe(before);
  });

  test('an empty or missing name is a no-op, not a wipe', () => {
    const before = cfg({ name: 'Estimate Authoring' });
    expect(dropPackByName(before, '').removed).toEqual([]);
    expect(dropPackByName(before, null).removed).toEqual([]);
    expect(dropPackByName(before, undefined).value.skills).toHaveLength(1);
  });

  test('preserves the other keys on the settings blob', () => {
    const before = { version: 3, skills: [{ name: 'A' }] };
    const out = dropPackByName(before, 'A');
    expect(out.value.version).toBe(3);
    expect(out.value.skills).toEqual([]);
  });
});

describe('packMatches', () => {
  test('ids win over names when both sides have one', () => {
    expect(packMatches({ name: 'A', anthropic_skill_id: 'x' }, { name: 'B', anthropic_skill_id: 'x' })).toBe(true);
    expect(packMatches({ name: 'A', anthropic_skill_id: 'x' }, { name: 'A', anthropic_skill_id: 'y' })).toBe(false);
  });

  test('falls back to the name when either side has no id', () => {
    expect(packMatches({ name: 'A', anthropic_skill_id: 'x' }, { name: 'A' })).toBe(true);
    expect(packMatches({ name: 'A' }, { name: 'B' })).toBe(false);
  });

  test('two nameless idless packs do not match each other', () => {
    expect(packMatches({}, {})).toBe(false);
  });
});
