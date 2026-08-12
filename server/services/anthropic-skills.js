// Retiring a native Anthropic Skill.
//
// Anthropic refuses to delete a skill that still has versions:
//
//   "Cannot delete skill with existing versions. Delete all versions first."
//
// Every skill we create HAS a version (create implicitly makes v1), so a
// bare `beta.skills.delete(id)` fails for every skill we've ever mirrored.
// Five call sites made that bare call, and four of them swallowed the
// error into a console.warn and carried on with the local cleanup — so
// the local pointer was dropped while the skill stayed live upstream,
// still attached to the agent. Untracked, invisible, and permanent.
//
// Measured 2026-08-12: "Workspace placement and wiring discipline"
// (skill_01GF623EoQfRv5nx2AzCVb9K) survived an unsync exactly this way
// and kept loading into 86 with no local pack pointing at it.
//
// This helper is the one correct retire path: enumerate versions, delete
// each, then the envelope.
//
// It NEVER throws. Callers all want to proceed with local cleanup
// whichever way the upstream call goes — what they were missing is a
// truthful answer about what happened, so they can report it instead of
// assuming success. Read the result; don't ignore it.

// Delete a skill and all of its versions.
//
// Returns one of:
//   { ok: true,  versions_deleted: n }              — retired upstream
//   { ok: true,  already_gone: true }               — 404, nothing to do
//   { ok: false, error, version_errors?, stage }    — still live upstream
async function deleteSkillDeep(anthropic, skillId) {
  const id = String(skillId || '').trim();
  if (!anthropic) return { ok: false, error: 'Anthropic client not configured', stage: 'client' };
  if (!id) return { ok: false, error: 'skillId is required', stage: 'input' };

  // Step 1 — enumerate every version. versions.list returns a paginated
  // iterator; pull all pages so we clear the whole history, not page one.
  const versions = [];
  try {
    const iter = await anthropic.beta.skills.versions.list(id);
    for await (const v of iter) versions.push(v);
  } catch (e) {
    if (isNotFound(e)) return { ok: true, already_gone: true };
    return { ok: false, error: msg(e), stage: 'versions.list' };
  }

  // Step 2 — delete each version. Serial, so a failure names its version.
  const versionErrors = [];
  for (const v of versions) {
    const versionId = v.version || v.id; // SDK exposes both depending on shape
    try {
      await anthropic.beta.skills.versions.delete(versionId, { skill_id: id });
    } catch (e) {
      if (isNotFound(e)) continue; // already gone is fine
      versionErrors.push({ version: versionId, error: msg(e) });
    }
  }
  if (versionErrors.length) {
    return {
      ok: false,
      error: versionErrors.length + ' of ' + versions.length + ' versions failed to delete',
      version_errors: versionErrors,
      stage: 'versions.delete'
    };
  }

  // Step 3 — the envelope, now that no versions remain.
  try {
    await anthropic.beta.skills.delete(id);
  } catch (e) {
    if (isNotFound(e)) return { ok: true, already_gone: true, versions_deleted: versions.length };
    return { ok: false, error: msg(e), stage: 'skills.delete', versions_deleted: versions.length };
  }

  return { ok: true, versions_deleted: versions.length };
}

function isNotFound(e) {
  if (e && e.status === 404) return true;
  return /404|not.?found/i.test(String((e && e.message) || ''));
}

function msg(e) {
  return String((e && e.message) || e || 'unknown');
}

module.exports = { deleteSkillDeep };
