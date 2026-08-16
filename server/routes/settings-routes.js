// Site-wide settings (key/JSONB). Currently used for the proposal template
// (company header, intro/about text, exclusion list, signature line) so admins
// can edit boilerplate without a code change. Reads are open to anyone with
// ESTIMATES_VIEW (they need it to render the preview); writes require
// ROLES_MANAGE (a proxy for "admin", same as the Roles UI).
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const { removedPacks } = require('../services/skill-pack-lifecycle');

const router = express.Router();

router.get('/:key', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, value, updated_at FROM app_settings WHERE key = $1',
      [req.params.key]
    );
    if (!rows.length) return res.status(404).json({ error: 'Setting not found' });
    res.json({ setting: rows[0] });
  } catch (e) {
    console.error('GET /api/settings/:key error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Carry anthropic_skill_id across an agent_skills save.
//
// This PUT is a wholesale replace (SET value = EXCLUDED.value), and the
// admin Skills editor posts a draft rebuilt from its form fields — which
// never included anthropic_skill_id. So every save silently severed the
// link between a local pack and the Anthropic skill it had been uploaded
// to. Measured 2026-08-11: 7 skills live on Anthropic (all uploaded
// 2026-05-24) while ALL 9 local packs read synced:false. ~80 days of
// playbook edits that never reached the agent, with nothing on screen to
// say so.
//
// Conservative on purpose — a MIS-attached id is worse than a missing one,
// because the next sync would overwrite the wrong Anthropic skill:
//   - incoming already has an id  → leave it completely alone
//   - incoming has a matching `id`→ carry that pack's prior id
//   - no id on either side        → carry by index ONLY if the array
//                                   length is unchanged (no add/remove)
//   - anything else               → leave unset and log
function preserveSkillIds(incoming, prior) {
  try {
    const inSkills = incoming && Array.isArray(incoming.skills) ? incoming.skills : null;
    const oldSkills = prior && Array.isArray(prior.skills) ? prior.skills : null;
    if (!inSkills || !oldSkills) return { value: incoming, carried: 0 };

    const byId = new Map();
    oldSkills.forEach(function (p) { if (p && p.id) byId.set(String(p.id), p); });
    const sameShape = inSkills.length === oldSkills.length;
    let carried = 0;

    const merged = inSkills.map(function (pack, i) {
      if (!pack || pack.anthropic_skill_id) return pack;
      let src = pack.id ? byId.get(String(pack.id)) : null;
      if (!src && sameShape && !pack.id && oldSkills[i] && !oldSkills[i].id) src = oldSkills[i];
      if (src && src.anthropic_skill_id) {
        carried++;
        return Object.assign({}, pack, { anthropic_skill_id: src.anthropic_skill_id });
      }
      return pack;
    });

    return { value: Object.assign({}, incoming, { skills: merged }), carried: carried };
  } catch (e) {
    console.warn('preserveSkillIds failed (saving incoming as-is):', e.message);
    return { value: incoming, carried: 0 };
  }
}

// Retire a pack everywhere once it leaves the authoritative array.
//
// app_settings.agent_skills is the authority (see services/skill-pack-
// lifecycle.js for the full argument), but deleting a pack from it used to
// change nothing else: the managed_agent_skills row kept pointing the
// agent at the skill, and the org_skill_packs mirror kept its copy — so
// collectSkillsFor still handed the "retired" playbook to 86 on every
// session. Removing it here is what makes the delete real.
//
// Best-effort by design. A failure to detach must not fail the admin's
// save; it is reported back instead.
async function retireRemovedPacks(removed, orgId) {
  const report = [];
  for (const pack of removed) {
    const row = { name: pack.name, anthropic_skill_id: pack.anthropic_skill_id, detached: 0, archived: 0 };
    if (pack.anthropic_skill_id) {
      try {
        const d = await pool.query(
          `DELETE FROM managed_agent_skills WHERE skill_id = $1`,
          [pack.anthropic_skill_id]
        );
        row.detached = d.rowCount || 0;
      } catch (e) {
        row.error = e.message;
        console.warn('[settings/agent_skills] detach failed for ' + pack.anthropic_skill_id + ':', e.message);
      }
    }
    if (pack.name && orgId) {
      try {
        // Archive rather than delete: the tombstone holds the UNIQUE
        // (organization_id, name) key, which is what stops the legacy
        // one-shot copy migration from rebuilding the pack on a later boot.
        //
        // Scoped to the caller's org. app_settings.agent_skills is a single
        // global row while org_skill_packs is per-tenant, so the mapping is
        // one-to-many; archiving unscoped would retire another tenant's
        // same-named pack. No org on the caller -> skip the mirror rather
        // than guess.
        const a = await pool.query(
          `UPDATE org_skill_packs
              SET archived_at = NOW(), anthropic_skill_id = NULL, updated_at = NOW()
            WHERE organization_id = $1 AND name = $2 AND archived_at IS NULL`,
          [orgId, pack.name]
        );
        row.archived = a.rowCount || 0;
      } catch (e) {
        row.error = e.message;
        console.warn('[settings/agent_skills] org_skill_packs archive failed for ' + pack.name + ':', e.message);
      }
    }
    report.push(row);
  }
  return report;
}

router.put('/:key', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    let value = req.body && req.body.value;
    if (value == null) return res.status(400).json({ error: 'value is required' });
    let retired = null;

    // Snapshot the prior agent_skills blob before overwriting so
    // admins have a rollback path. Only for the agent_skills key —
    // other settings (proposal template, BT mapping, etc.) have
    // their own change-history surfaces or don't need one.
    if (req.params.key === 'agent_skills') {
      // Read prior ONCE, in its own try. Both the id-preserve and the
      // snapshot need it, and neither may take the other down: a failed
      // snapshot must not silently reintroduce the id-wipe bug.
      let priorValue = null;
      try {
        const prior = await pool.query(
          `SELECT value FROM app_settings WHERE key = 'agent_skills'`
        );
        if (prior.rows.length) priorValue = prior.rows[0].value;
      } catch (readErr) {
        console.warn('agent_skills prior read failed:', readErr.message);
      }

      if (priorValue) {
        const merged = preserveSkillIds(value, priorValue);
        value = merged.value;
        if (merged.carried) {
          console.log('[settings/agent_skills] preserved ' + merged.carried +
            ' anthropic_skill_id link(s) the incoming save omitted');
        }

        try {
          await pool.query(
            `INSERT INTO agent_skills_versions (saved_by, value, comment)
             VALUES ($1, $2::jsonb, $3)`,
            [req.user.id, JSON.stringify(priorValue), (req.body.comment || null)]
          );
        } catch (snapErr) {
          // Snapshot failure shouldn't block the save — log and continue.
          console.warn('agent_skills snapshot failed:', snapErr.message);
        }

        // Computed against the MERGED value, after preserveSkillIds — so a
        // draft that merely omitted anthropic_skill_id doesn't read as a
        // deletion. Applied after the write below.
        const gone = removedPacks(priorValue, value);
        if (gone.length) retired = gone;
      }
    }

    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [req.params.key, JSON.stringify(value)]
    );

    // Only after the authoritative array has actually been written — a
    // failed save must not leave the mirrors detached from packs that are
    // still live.
    const retiredReport = retired
      ? await retireRemovedPacks(retired, (req.user && req.user.organization_id) || null)
      : null;

    res.json(retiredReport ? { ok: true, retired: retiredReport } : { ok: true });
  } catch (e) {
    console.error('PUT /api/settings/:key error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
