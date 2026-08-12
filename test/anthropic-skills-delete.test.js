// test/anthropic-skills-delete.test.js — coverage for deleteSkillDeep
// (server/services/anthropic-skills.js).
//
// The bug this replaces: five call sites called
// `anthropic.beta.skills.delete(id)` directly. Anthropic rejects that for
// any skill that still has versions — which is every skill we create —
// and four of those sites swallowed the rejection into a console.warn
// before nulling the local pointer. Net effect: the skill stayed live
// upstream, still attached to the agent, with nothing local pointing at
// it. Silent, permanent, and invisible from the admin UI.
//
// So the two properties under test are:
//   1. versions are cleared BEFORE the envelope (or the delete fails)
//   2. a failure comes back as data — never a throw, never a silent true

const { deleteSkillDeep } = require('../server/services/anthropic-skills');

// Minimal stand-in for the Anthropic SDK surface the helper touches.
// `versions` is the list returned by versions.list; `fail` lets a test
// make a specific call reject.
function fakeAnthropic(opts) {
  const o = opts || {};
  const calls = { listed: [], versionsDeleted: [], envelopeDeleted: [] };
  const err = (msg, status) => {
    const e = new Error(msg);
    if (status) e.status = status;
    return e;
  };
  return {
    calls,
    beta: {
      skills: {
        async delete(id) {
          if (o.failEnvelope) throw err(o.failEnvelope, o.failEnvelopeStatus);
          calls.envelopeDeleted.push(id);
        },
        versions: {
          async list(id) {
            calls.listed.push(id);
            if (o.failList) throw err(o.failList, o.failListStatus);
            return (o.versions || []).slice();
          },
          async delete(versionId, params) {
            if (o.failVersion && o.failVersion === versionId) {
              throw err(o.failVersionMessage || 'boom', o.failVersionStatus);
            }
            calls.versionsDeleted.push({ versionId, skill_id: params && params.skill_id });
          }
        }
      }
    }
  };
}

describe('deleteSkillDeep — happy path', () => {
  test('deletes every version, then the envelope', async () => {
    const a = fakeAnthropic({ versions: [{ version: 'v1' }, { version: 'v2' }] });
    const res = await deleteSkillDeep(a, 'skill_abc');

    expect(res).toEqual({ ok: true, versions_deleted: 2 });
    expect(a.calls.versionsDeleted).toEqual([
      { versionId: 'v1', skill_id: 'skill_abc' },
      { versionId: 'v2', skill_id: 'skill_abc' }
    ]);
    expect(a.calls.envelopeDeleted).toEqual(['skill_abc']);
  });

  test('a version-less skill still deletes', async () => {
    const a = fakeAnthropic({ versions: [] });
    const res = await deleteSkillDeep(a, 'skill_abc');
    expect(res).toEqual({ ok: true, versions_deleted: 0 });
    expect(a.calls.envelopeDeleted).toEqual(['skill_abc']);
  });

  test('accepts the id-shaped version record too', async () => {
    // The SDK exposes `version` on some shapes and `id` on others.
    const a = fakeAnthropic({ versions: [{ id: 'ver_1' }] });
    const res = await deleteSkillDeep(a, 'skill_abc');
    expect(res.ok).toBe(true);
    expect(a.calls.versionsDeleted[0].versionId).toBe('ver_1');
  });
});

describe('deleteSkillDeep — the regression it exists for', () => {
  test('reports failure instead of claiming success when the envelope refuses', async () => {
    // This is verbatim what Anthropic returned for the workspace skill.
    const a = fakeAnthropic({
      versions: [],
      failEnvelope: 'Cannot delete skill with existing versions. Delete all versions first.'
    });
    const res = await deleteSkillDeep(a, 'skill_01GF623EoQfRv5nx2AzCVb9K');

    expect(res.ok).toBe(false);
    expect(res.stage).toBe('skills.delete');
    expect(res.error).toMatch(/existing versions/);
  });

  test('a failed version delete stops the envelope delete', async () => {
    const a = fakeAnthropic({
      versions: [{ version: 'v1' }, { version: 'v2' }],
      failVersion: 'v2',
      failVersionMessage: 'locked'
    });
    const res = await deleteSkillDeep(a, 'skill_abc');

    expect(res.ok).toBe(false);
    expect(res.stage).toBe('versions.delete');
    expect(res.version_errors).toEqual([{ version: 'v2', error: 'locked' }]);
    // Critical: we did NOT delete the envelope out from under a live version.
    expect(a.calls.envelopeDeleted).toEqual([]);
  });
});

describe('deleteSkillDeep — already gone', () => {
  test('404 on versions.list is success, not an error', async () => {
    const a = fakeAnthropic({ failList: 'Not found', failListStatus: 404 });
    const res = await deleteSkillDeep(a, 'skill_gone');
    expect(res).toEqual({ ok: true, already_gone: true });
  });

  test('404 on the envelope is success', async () => {
    const a = fakeAnthropic({ versions: [{ version: 'v1' }], failEnvelope: '404 not_found' });
    const res = await deleteSkillDeep(a, 'skill_gone');
    expect(res.ok).toBe(true);
    expect(res.already_gone).toBe(true);
  });

  test('a version that 404s mid-loop does not fail the whole delete', async () => {
    const a = fakeAnthropic({
      versions: [{ version: 'v1' }, { version: 'v2' }],
      failVersion: 'v1',
      failVersionMessage: 'Not found',
      failVersionStatus: 404
    });
    const res = await deleteSkillDeep(a, 'skill_abc');
    expect(res.ok).toBe(true);
    expect(a.calls.envelopeDeleted).toEqual(['skill_abc']);
  });
});

describe('deleteSkillDeep — never throws', () => {
  test('missing client returns a result, not an exception', async () => {
    const res = await deleteSkillDeep(null, 'skill_abc');
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('client');
  });

  test('missing id returns a result', async () => {
    const res = await deleteSkillDeep(fakeAnthropic({}), '   ');
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('input');
  });

  test('a non-404 list failure is data, not a throw', async () => {
    const a = fakeAnthropic({ failList: 'upstream 500', failListStatus: 500 });
    await expect(deleteSkillDeep(a, 'skill_abc')).resolves.toMatchObject({
      ok: false,
      stage: 'versions.list'
    });
  });
});
