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

// ─── Mirroring a local pack UP to Anthropic ──────────────────────────────
//
// Lives here rather than in admin-agents-routes.js so it can be tested
// without booting the router (which pulls in auth, and therefore requires
// JWT_SECRET). The route keeps only the DB plumbing, injected as `deps`.

const { slugify } = require('../util/slugify');

// Compose the SKILL.md we upload.
//
// The description is the TRIGGER, not a label. Anthropic Skills are
// progressively disclosed: only name + description sit in context each
// turn, and the model reads the description to decide whether to pull the
// body in. This used to fall through to the pack NAME — so every skill
// shipped with `description: Estimating Playbook`, which says nothing
// about WHEN it applies. Every pack was live, attached, counted, and
// effectively unreachable. pack.description now wins.
function buildSkillMarkdown(pack) {
  const p = pack || {};
  const slug = slugify(p.name);
  const human = (p.name || 'Project 86 skill').replace(/[\r\n]/g, ' ');

  const desc = (p.description && String(p.description).trim()
    ? String(p.description).trim()
    : (p.replaces_section
        ? 'Section override for ' + p.replaces_section
        : (p.category ? 'Category: ' + p.category : human))
  ).replace(/[\r\n]+/g, ' ').slice(0, 900);

  return [
    '---',
    'name: ' + slug,
    'description: ' + desc,
    '---',
    '',
    p.body || ''
  ].join('\n');
}

// Fingerprint of what was actually uploaded, stored back on the pack as
// `synced_hash`. Without it, "synced" only ever meant "has an id" — it
// could not tell a pack that matches its live skill from one edited weeks
// ago that never shipped. A pack with no stored hash counts as drifted and
// is re-pushed once, which is self-healing.
function skillBodyHash(md) {
  return require('crypto').createHash('sha256').update(String(md), 'utf8').digest('hex').slice(0, 16);
}

// The Anthropic-side display_title. NOT the user-visible pack name.
//
// Anthropic enforces uniqueness on display_title across live skills:
//
//   400 invalid_request_error
//   "Skill cannot reuse an existing display_title: WIP & Cost Analysis"
//
// pushPackToAnthropic replaces a skill by CREATING the new one before
// retiring the old (see the ordering argument below), so on any edit the
// old skill is still live and still owns the plain pack name. Sending the
// bare name therefore succeeded exactly once per pack — the first-ever
// create — and every subsequent edit 400'd. Measured 2026-08-16: all 10
// upstream skills had created_at === updated_at. No edit had EVER shipped.
//
// Suffixing with the content hash makes the title vary with the body, so
// the replacement never collides with the copy it is replacing, while the
// pack's own `name` (what admins see, and what the SKILL.md frontmatter
// slug is built from) is untouched.
//
// `salt` breaks the remaining tie: re-pushing byte-identical content whose
// predecessor failed to delete would otherwise regenerate the same title.
function anthropicDisplayTitle(pack, md, salt) {
  const base = String((pack && pack.name) || 'Project 86 skill').replace(/[\r\n]+/g, ' ').trim() || 'Project 86 skill';
  const mark = skillBodyHash(md).slice(0, 8) + (salt ? '-' + salt : '');
  const suffix = ' [' + mark + ']';
  return base.slice(0, 200 - suffix.length) + suffix;
}

// Anthropic's phrasing for the collision. Matched loosely on purpose —
// the status code alone is too broad (any 400 would retry) and the exact
// sentence is not contractual.
function isDisplayTitleCollision(e) {
  return /display_title/i.test(String((e && e.message) || ''));
}

// Create the upstream skill, guaranteeing a non-colliding display_title.
// Returns the created skill object from the SDK.
async function createSkillWithUniqueTitle(anthropic, opts) {
  const { pack, md, toFile } = opts;
  const slug = slugify(pack && pack.name);
  // Anthropic requires SKILL.md inside a top-level folder (slug/SKILL.md).
  const file = await toFile(Buffer.from(md, 'utf8'), slug + '/SKILL.md', { type: 'text/markdown' });

  // Attempt 1 is the deterministic hash-suffixed title. Attempts 2-3 add a
  // salt, for the case where an identical body's predecessor is still live
  // upstream (its delete failed and left an orphan holding the title).
  const salts = [null, Date.now().toString(36), Math.random().toString(36).slice(2, 8)];
  let lastErr = null;
  for (let i = 0; i < salts.length; i++) {
    try {
      return await anthropic.beta.skills.create({
        display_title: anthropicDisplayTitle(pack, md, salts[i]),
        files: [file]
      });
    } catch (e) {
      lastErr = e;
      if (!isDisplayTitleCollision(e)) throw e;
    }
  }
  throw lastErr;
}

// Push ONE pack to Anthropic and swap the agent onto it.
//
// The ordering is the whole safety argument. Every failure mode leaves the
// agent running the OLD skill rather than no skill:
//   1. upload the new skill   (old still live and still referenced)
//   2. re-point the agent's attachment rows old id -> new id
//   3. caller persists the new id onto the pack
//   4. retire the old skill   (now unreferenced; failure = harmless orphan)
// Never delete first. Because step 1 happens while the old skill is live,
// the new skill CANNOT reuse its display_title — see anthropicDisplayTitle.
//
// deps:
//   toFile              — the SDK's toFile helper (injected; keeps this
//                         module free of a hard @anthropic-ai/sdk import)
//   repointAgentSkills  — async (oldId, newId) => rows updated
async function pushPackToAnthropic(anthropic, pack, deps) {
  const d = deps || {};
  const toFile = d.toFile;
  const md = buildSkillMarkdown(pack);
  const priorId = (pack && pack.anthropic_skill_id) || null;

  const created = await createSkillWithUniqueTitle(anthropic, { pack, md, toFile });

  let repointed = 0;
  if (priorId && typeof d.repointAgentSkills === 'function') {
    try {
      repointed = (await d.repointAgentSkills(priorId, created.id)) || 0;
    } catch (e) {
      console.error('[skills/sync] re-point agent skills failed for ' +
        priorId + ' -> ' + created.id + ':', e.message);
    }
  }

  let oldDeleted = false, oldDeleteError = null;
  if (priorId) {
    const del = await deleteSkillDeep(anthropic, priorId);
    oldDeleted = !!del.ok;
    if (!del.ok) {
      oldDeleteError = del.error;
      console.warn('[skills/sync] old skill ' + priorId +
        ' replaced but not deleted (orphan left upstream):', del.error);
    }
  }

  return {
    id: created.id,
    display_title: created.display_title,
    replaced: priorId,
    repointed,
    oldDeleted,
    oldDeleteError,
    hash: skillBodyHash(md)
  };
}

module.exports = {
  deleteSkillDeep,
  buildSkillMarkdown,
  skillBodyHash,
  anthropicDisplayTitle,
  createSkillWithUniqueTitle,
  pushPackToAnthropic
};
