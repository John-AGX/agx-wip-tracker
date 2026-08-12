// Site-wide settings (key/JSONB). Currently used for the proposal template
// (company header, intro/about text, exclusion list, signature line) so admins
// can edit boilerplate without a code change. Reads are open to anyone with
// ESTIMATES_VIEW (they need it to render the preview); writes require
// ROLES_MANAGE (a proxy for "admin", same as the Roles UI).
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

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

router.put('/:key', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    let value = req.body && req.body.value;
    if (value == null) return res.status(400).json({ error: 'value is required' });

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
      }
    }

    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [req.params.key, JSON.stringify(value)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/settings/:key error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
