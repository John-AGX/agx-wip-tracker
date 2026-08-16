// skill-pack-lifecycle.js — which store owns a skill pack, and what
// "retired" has to mean in all of them.
//
// ── THE AUTHORITY DECISION ────────────────────────────────────────────
//
// `app_settings.agent_skills.skills[]` is AUTHORITATIVE for the skill-pack
// lifecycle. Everything else is a projection of it:
//
//   app_settings.agent_skills   AUTHORITY. The admin Skills editor reads
//                               and writes this array (PUT /api/settings/
//                               agent_skills). It is the only store that
//                               carries `synced_hash`, the fingerprint
//                               that distinguishes "matches the live
//                               Anthropic skill" from merely "has an id".
//                               It is what sync-all iterates. It is the
//                               only one with version snapshots + restore
//                               (agent_skills_versions).
//   org_skill_packs             per-tenant MIRROR, for the org admin UI.
//   managed_agent_skills        ATTACHMENT table (agent_key -> skill_id).
//                               Says which agent loads what; owns nothing.
//
// Why this matters: collectSkillsFor() UNIONs all three. A pack retired in
// one store and left in the others is not retired at all — it keeps
// loading into 86 from whichever copy survived. Worse, sync-all walks
// app_settings and mints a NEW Anthropic skill for any pack there without
// a live id, so a pack "deleted" from org_skill_packs came back upstream,
// re-attached, on the next sync. Measured 2026-08-16: five retired packs
// were re-created as native Anthropic skills in a single 5-second burst
// and re-attached to the job agent, taking skill_count from 3 to 8.
//
// So: RETIRING A PACK REMOVES IT FROM BOTH STORES. Whichever surface the
// admin retires it from, the other one follows. These helpers are the
// shared, DB-free core of that; the two route-side halves are
//   - PUT  /api/settings/:key            (settings-routes.js)
//   - DELETE /api/admin/organizations/:id/skill-packs/:packId
//                                        (admin-organizations-routes.js)
//
// Deliberately NOT done here: deleting the skill upstream on Anthropic.
// Detaching is reversible (re-sync re-creates and re-attaches); an
// upstream delete is not, and a mis-saved draft must not be able to
// destroy content. Retired-but-upstream skills show as orphans in the
// console and are deleted there on purpose.

// Identify one pack across two snapshots of the array.
//
// Keyed on anthropic_skill_id first so a RENAME reads as an edit, not as
// "old pack deleted + new pack added" — the id survives a rename, the
// name does not. Falls back to name for packs that have never synced.
function packMatches(a, b) {
  if (!a || !b) return false;
  if (a.anthropic_skill_id && b.anthropic_skill_id) {
    return String(a.anthropic_skill_id) === String(b.anthropic_skill_id);
  }
  return !!a.name && String(a.name) === String(b.name || '');
}

function skillsOf(cfg) {
  return cfg && Array.isArray(cfg.skills) ? cfg.skills : null;
}

// Packs present in `prior` and gone from `next` — i.e. the admin deleted
// them in the Skills editor and saved.
//
// Returns [] (never throws) when either side is missing a skills array,
// because "we cannot tell" must not be read as "everything was deleted".
function removedPacks(prior, next) {
  const oldSkills = skillsOf(prior);
  const newSkills = skillsOf(next);
  if (!oldSkills || !newSkills) return [];
  return oldSkills.filter(function (p) {
    return p && !newSkills.some(function (q) { return packMatches(p, q); });
  }).map(function (p) {
    return { name: p.name || null, anthropic_skill_id: p.anthropic_skill_id || null };
  });
}

// Drop a pack from an agent_skills config by name — the org-delete half.
//
// Name-matched because org_skill_packs and app_settings share nothing but
// the name (UNIQUE (organization_id, name) on one side, a free-form array
// on the other). Returns a NEW config; never mutates the input.
function dropPackByName(cfg, name) {
  const skills = skillsOf(cfg);
  const wanted = String(name == null ? '' : name);
  if (!skills || !wanted) return { value: cfg, removed: [] };

  const removed = [];
  const kept = skills.filter(function (p) {
    if (p && String(p.name || '') === wanted) {
      removed.push({ name: p.name || null, anthropic_skill_id: p.anthropic_skill_id || null });
      return false;
    }
    return true;
  });
  if (!removed.length) return { value: cfg, removed: [] };
  return { value: Object.assign({}, cfg, { skills: kept }), removed: removed };
}

module.exports = { removedPacks, dropPackByName, packMatches };
