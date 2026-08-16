// test/skill-pack-mirror.test.js — mirroring a local skill pack UP to
// Anthropic, with the case that had NO coverage and therefore shipped
// broken: EDITING a pack that is already mirrored.
//
// The bug: pushPackToAnthropic replaces a skill by creating the new one
// BEFORE retiring the old (deliberately — every failure mode then leaves
// the agent on the old skill rather than on none). But it sent the pack's
// plain name as display_title, and Anthropic rejects a create whose
// display_title matches a skill that is still live:
//
//   400 invalid_request_error
//   "Skill cannot reuse an existing display_title: WIP & Cost Analysis"
//
// So only a pack's FIRST-EVER create could succeed. Every later edit 400'd
// and never reached the agent. Measured 2026-08-16: all 10 upstream skills
// had created_at === updated_at. Not one edit had ever shipped, for 80+
// days, while the admin UI reported "synced".
//
// The old test suite covered deleteSkillDeep and nothing else on this
// path. That gap IS the reason this shipped.

const {
  pushPackToAnthropic,
  anthropicDisplayTitle,
  buildSkillMarkdown,
  skillBodyHash
} = require('../server/services/anthropic-skills');

// Stand-in for the SDK surface the mirror touches.
//
// `liveTitles` models Anthropic's uniqueness constraint: creating a skill
// whose display_title is already taken by a live skill is a 400. Deleting
// a skill frees its title, exactly as upstream.
function fakeAnthropic(opts) {
  const o = opts || {};
  const live = new Map();               // skillId -> display_title
  (o.liveTitles || []).forEach(function (t, i) { live.set('skill_pre_' + i, t); });
  const calls = [];                     // ordered log of everything
  let n = 0;

  return {
    calls,
    live,
    beta: {
      skills: {
        async create(params) {
          calls.push({ op: 'create', display_title: params.display_title });
          if (o.createThrows) throw Object.assign(new Error(o.createThrows), { status: 500 });
          for (const t of live.values()) {
            if (t === params.display_title) {
              throw Object.assign(
                new Error('Skill cannot reuse an existing display_title: ' + params.display_title),
                { status: 400 }
              );
            }
          }
          const id = 'skill_new_' + (++n);
          live.set(id, params.display_title);
          return { id: id, display_title: params.display_title };
        },
        async delete(id) {
          calls.push({ op: 'skills.delete', id: id });
          if (o.failEnvelope) throw new Error(o.failEnvelope);
          live.delete(id);
        },
        versions: {
          async list(id) { calls.push({ op: 'versions.list', id: id }); return []; },
          async delete() {}
        }
      }
    }
  };
}

// The SDK's toFile, stubbed — the mirror only passes it through.
async function toFile(buf, path) { return { path: path, bytes: buf.length }; }

function deps(anthropic, log) {
  return {
    toFile: toFile,
    repointAgentSkills: async function (oldId, newId) {
      anthropic.calls.push({ op: 'repoint', from: oldId, to: newId });
      if (log) log.push([oldId, newId]);
      return 1;
    }
  };
}

describe('pushPackToAnthropic — editing an already-mirrored pack', () => {
  test('an edit ships even though the old skill still owns the pack name', async () => {
    // Exactly the live shape on 2026-08-16: the upstream skill was created
    // under the bare pack name, and it is still live when the edit lands.
    const a = fakeAnthropic({ liveTitles: ['WIP & Cost Analysis'] });
    const oldId = Array.from(a.live.keys())[0];
    const pack = {
      name: 'WIP & Cost Analysis',
      description: 'Use when reading job WIP, cost-to-complete, or margin.',
      body: 'Small service and T&M work targets 50% margin.',
      anthropic_skill_id: oldId
    };

    const res = await pushPackToAnthropic(a, pack, deps(a));

    expect(res.id).toMatch(/^skill_new_/);
    expect(res.replaced).toBe(oldId);
    // The user-visible pack name is untouched; only the Anthropic-side
    // title carries the disambiguator.
    expect(pack.name).toBe('WIP & Cost Analysis');
    expect(res.display_title).not.toBe('WIP & Cost Analysis');
    expect(res.display_title.startsWith('WIP & Cost Analysis ')).toBe(true);
  });

  test('the ordering survives: create -> repoint -> retire, never delete-first', async () => {
    const a = fakeAnthropic({ liveTitles: ['WIP & Cost Analysis'] });
    const oldId = Array.from(a.live.keys())[0];
    const pack = { name: 'WIP & Cost Analysis', body: 'edited', anthropic_skill_id: oldId };

    const res = await pushPackToAnthropic(a, pack, deps(a));

    const ops = a.calls.map(c => c.op);
    expect(ops.indexOf('create')).toBeLessThan(ops.indexOf('repoint'));
    expect(ops.indexOf('repoint')).toBeLessThan(ops.indexOf('skills.delete'));
    expect(a.calls.find(c => c.op === 'repoint')).toEqual({ op: 'repoint', from: oldId, to: res.id });
    expect(res.repointed).toBe(1);
    expect(res.oldDeleted).toBe(true);
  });

  test('a failed create leaves the agent on the OLD skill — no repoint, no delete', async () => {
    const a = fakeAnthropic({ liveTitles: ['WIP & Cost Analysis'], createThrows: 'upstream 500' });
    const oldId = Array.from(a.live.keys())[0];
    const pack = { name: 'WIP & Cost Analysis', body: 'edited', anthropic_skill_id: oldId };

    await expect(pushPackToAnthropic(a, pack, deps(a))).rejects.toThrow('upstream 500');
    expect(a.calls.some(c => c.op === 'repoint')).toBe(false);
    expect(a.calls.some(c => c.op === 'skills.delete')).toBe(false);
    expect(a.live.get(oldId)).toBe('WIP & Cost Analysis');
  });

  test('re-pushing identical content past an undeleted predecessor still lands', async () => {
    // The orphan case: a previous replacement failed to delete, so the
    // hash-suffixed title this content generates is already taken. The
    // salted retry has to break the tie or the pack is stuck forever.
    const pack = { name: 'Estimate Authoring', body: 'unchanged body', anthropic_skill_id: 'skill_orphaned' };
    const takenTitle = anthropicDisplayTitle(pack, buildSkillMarkdown(pack));
    const a = fakeAnthropic({ liveTitles: [takenTitle] });

    const res = await pushPackToAnthropic(a, pack, deps(a));

    expect(res.id).toMatch(/^skill_new_/);
    expect(res.display_title).not.toBe(takenTitle);
    expect(res.display_title.startsWith('Estimate Authoring ')).toBe(true);
    // Two create attempts: the deterministic title, then the salted one.
    expect(a.calls.filter(c => c.op === 'create').length).toBe(2);
  });

  test('a first-time create neither re-points nor deletes anything', async () => {
    const a = fakeAnthropic({});
    const pack = { name: 'Client & Lead Hygiene', body: 'new pack' };

    const res = await pushPackToAnthropic(a, pack, deps(a));

    expect(res.replaced).toBe(null);
    expect(res.repointed).toBe(0);
    expect(a.calls.some(c => c.op === 'repoint')).toBe(false);
    expect(a.calls.some(c => c.op === 'skills.delete')).toBe(false);
  });

  test('an old skill that refuses to delete is reported, not swallowed', async () => {
    const a = fakeAnthropic({ liveTitles: ['Estimate Authoring'], failEnvelope: 'locked' });
    const oldId = Array.from(a.live.keys())[0];
    const pack = { name: 'Estimate Authoring', body: 'edited', anthropic_skill_id: oldId };

    const res = await pushPackToAnthropic(a, pack, deps(a));

    expect(res.id).toMatch(/^skill_new_/);   // the edit still shipped
    expect(res.oldDeleted).toBe(false);
    expect(res.oldDeleteError).toMatch(/locked/);
  });
});

describe('anthropicDisplayTitle', () => {
  test('keeps the pack name readable at the front', () => {
    const pack = { name: 'WIP & Cost Analysis', body: 'x' };
    const title = anthropicDisplayTitle(pack, buildSkillMarkdown(pack));
    expect(title.startsWith('WIP & Cost Analysis [')).toBe(true);
    expect(title.endsWith(']')).toBe(true);
  });

  test('changes when the content changes — that is what unblocks the edit', () => {
    const before = { name: 'WIP & Cost Analysis', body: 'target 35% margin' };
    const after = { name: 'WIP & Cost Analysis', body: 'target 50% margin' };
    expect(anthropicDisplayTitle(before, buildSkillMarkdown(before)))
      .not.toBe(anthropicDisplayTitle(after, buildSkillMarkdown(after)));
  });

  test('is stable for identical content', () => {
    const pack = { name: 'Estimate Authoring', body: 'same' };
    expect(anthropicDisplayTitle(pack, buildSkillMarkdown(pack)))
      .toBe(anthropicDisplayTitle(pack, buildSkillMarkdown(pack)));
  });

  test('respects the 200-char cap even for a very long pack name', () => {
    const pack = { name: 'x'.repeat(400), body: 'b' };
    const title = anthropicDisplayTitle(pack, buildSkillMarkdown(pack));
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith(']')).toBe(true);
  });

  test('survives a nameless pack', () => {
    const title = anthropicDisplayTitle({}, 'md');
    expect(title.startsWith('Project 86 skill [')).toBe(true);
  });
});

describe('buildSkillMarkdown — behaviour preserved across the move to services/', () => {
  test('the description is the trigger, not the name', () => {
    const md = buildSkillMarkdown({
      name: 'WIP & Cost Analysis',
      description: 'Use when the user asks about job margin.',
      body: 'BODY'
    });
    expect(md).toContain('name: wip-cost-analysis');
    expect(md).toContain('description: Use when the user asks about job margin.');
    expect(md.endsWith('BODY')).toBe(true);
  });

  test('falls back to the pack name when no description is set', () => {
    const md = buildSkillMarkdown({ name: 'Estimate Authoring', body: 'B' });
    expect(md).toContain('description: Estimate Authoring');
  });

  test('the hash is a function of the uploaded bytes', () => {
    const a = buildSkillMarkdown({ name: 'P', body: 'one' });
    const b = buildSkillMarkdown({ name: 'P', body: 'two' });
    expect(skillBodyHash(a)).not.toBe(skillBodyHash(b));
    expect(skillBodyHash(a)).toBe(skillBodyHash(a));
    expect(skillBodyHash(a)).toHaveLength(16);
  });
});
