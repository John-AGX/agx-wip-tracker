// Site-wide settings (key/JSONB) — an allowlisted key space, not a free one.
//
// `app_settings` is GLOBAL: `key TEXT PRIMARY KEY`, no organization_id, one row
// per key for the whole platform. This router used to address it by a
// caller-supplied key with NO allowlist — read on ESTIMATES_VIEW (every PM),
// write on ROLES_MANAGE (every org admin) — which made the key space itself the
// attack surface: the platform's VAPID private key, the agent playbook that
// rides upstream to Anthropic, the cron dedupe ledgers, and db.js's one-shot
// migration sentinels all lived one caller-supplied string away.
//
// services/app-settings-keys.js is now the authority on what may be addressed
// and by whom; the full argument, the verified findings, and the residuals live
// in that file's header. Two rules hold here:
//
//   1. PREDICATE BEFORE GATE. The key is classified BEFORE the database is
//      touched, so an unauthorised caller never causes a read of the row.
//   2. ONE ANSWER FOR "NOT YOURS". A key that is unknown, secret, internal,
//      owned by another door, or simply above the caller's tier gets exactly
//      the answer an ABSENT key gets — 404, same body, both verbs. No
//      existence oracle: `vapid_keys`, `reminders_log` and `nonsense_key` are
//      indistinguishable to anyone not entitled to them.
const express = require('express');
const { pool } = require('../db');
const { requireAuth, hasCapability } = require('../auth');
const { removedPacks } = require('../services/skill-pack-lifecycle');
const { readCapabilityFor, writeCapabilityFor, classOf, isDeclaredKey } = require('../services/app-settings-keys');
const { auditLog, auditCritical, hashId } = require('../audit');

const router = express.Router();

// The single "not yours" answer. Byte-identical to the absent-key response on
// purpose — see rule 2 above. Nothing about the key or its value is echoed.
function notFound(res) {
  return res.status(404).json({ error: 'Setting not found' });
}

// ── THE ACCEPTANCE TEST LIVES ON THIS ROUTE ────────────────────────────────
//
// "If no one got the keys yet, is it safe now?" was unanswerable because a
// privileged read of `vapid_keys` left NOTHING: the classification refuses it
// before the pool is touched, and the refusal was silent. The door is shut and
// the room is dark. Both halves of the trail are written here:
//
//   · the REFUSAL, because a walk of the key space is the enumeration signal
//     and it is the only thing left to see now that the key is unreachable;
//   · the SUCCESS, because the historical version of the question ("who read
//     it during the seven weeks it WAS served?") is answerable only by a row
//     per read. A query that comes back empty is then a positive, evidenced
//     "nobody touched it" rather than "we have no idea".
//
// TWO NARROWINGS, both deliberate:
//
// 1. A SUCCESSFUL read of a 'shared' key is NOT recorded. `proposal_template`
//    is read by the estimate preview and `bt_export_mapping` by the exporter,
//    both on ESTIMATES_VIEW — so auditing those would write a row naming the
//    PM, their IP and their browser every time somebody opens an estimate.
//    That is the surveillance tool the privacy line disclaims, and it buys
//    nothing: vapid_keys is 'secret' and agent_skills is 'platform', so the
//    acceptance test is untouched. Refusals are recorded for every class.
//
// 2. The caller-controlled key never lands raw. An UNDECLARED key is somebody
//    walking the key space, so target_id is the literal '(undeclared)' and the
//    attempted string survives only as a sha8 in detail. Enumeration stays
//    detectable and aggregatable; the trail does not become a log-injection
//    surface, and a value typed into the wrong field does not become a
//    permanent record.
//
// The 404 is unchanged in every case. The row is server-side and readable only
// by SYSTEM_ADMIN, so it creates no oracle for the caller — this task records,
// it does not gate.
function settingsAuditTarget(key) {
  const declared = isDeclaredKey(key);
  return {
    targetType: 'app_setting',
    targetId: declared ? key : '(undeclared)',
    declared: declared,
    keyClass: classOf(key),
    keySha8: declared ? undefined : hashId(key),
  };
}

function auditSettingsRead(req, key, outcome, reason) {
  const t = settingsAuditTarget(key);
  // Narrowing 1: successful reads of ordinary shared config are ordinary work.
  if (outcome === 'ok' && t.keyClass === 'shared') return;
  auditLog(req, {
    action: 'settings.read',
    outcome: outcome,
    reason: reason,
    tier: 'B',
    targetType: t.targetType,
    targetId: t.targetId,
    detail: { key_class: t.keyClass, declared: t.declared, key_sha8: t.keySha8 },
  });
}

router.get('/:key', requireAuth, async (req, res) => {
  try {
    const cap = readCapabilityFor(req.params.key);
    if (!cap || !hasCapability(req.user, cap)) {
      auditSettingsRead(req, req.params.key, 'denied',
        cap ? 'not_entitled' : (isDeclaredKey(req.params.key) ? 'never_served' : 'undeclared_key'));
      return notFound(res);
    }
    const { rows } = await pool.query(
      'SELECT key, value, updated_at FROM app_settings WHERE key = $1',
      [req.params.key]
    );
    if (!rows.length) {
      auditSettingsRead(req, req.params.key, 'ok', 'absent');
      return notFound(res);
    }
    auditSettingsRead(req, req.params.key, 'ok', null);
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
//
// THE DELETE BELOW IS UNSCOPED, AND THAT IS NOW THE GATE'S JOB.
// `managed_agent_skills` is PRIMARY KEY (agent_key, skill_id) with no org
// column, and collectSkillsFor Source 1 reads it — so this statement detaches
// a skill from the platform's agents for EVERY tenant, with no sync required.
// The org_skill_packs archive immediately below it IS org-scoped and its
// comment explains why; this one was never given the same treatment, because
// it cannot be: there is no tenant on either side of the join.
//
// It was reachable by any org admin, because PUT /:key was gated on
// ROLES_MANAGE. It is now reachable only by a SYSTEM_ADMIN — see
// services/app-settings-keys.js, where `agent_skills` is classified 'platform'
// for exactly this reason. A platform-wide statement run by the platform
// operator is correct; the same statement run by a tenant was the finding.
// Scoping the row rather than the caller would need an organization_id on
// managed_agent_skills, i.e. a schema change.
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

router.put('/:key', requireAuth, async (req, res) => {
  try {
    // Predicate before gate, and before the 400: a caller who may not address
    // this key must not learn from the shape of the refusal that the key is
    // real and merely wants a `value`. Classify, refuse, then validate.
    const cap = writeCapabilityFor(req.params.key);
    const t = settingsAuditTarget(req.params.key);
    // A platform/secret-class key is tier A: the write leaves the platform
    // (agent_skills rides upstream to Anthropic account-wide) and its retire
    // path detaches managed_agent_skills for every tenant. A refused write of
    // ANY class is recorded — that is the enumeration signal, and it is the
    // only trace a walk of the key space now leaves.
    const critical = t.keyClass !== 'shared';
    const auditBase = {
      action: 'settings.write',
      tier: critical ? 'A' : 'B',
      targetType: t.targetType,
      targetId: t.targetId,
    };
    if (!cap || !hasCapability(req.user, cap)) {
      auditLog(req, Object.assign({}, auditBase, {
        tier: 'B',                                    // a refusal never fails closed
        outcome: 'denied',
        reason: cap ? 'not_entitled' : (t.declared ? 'never_served' : 'undeclared_key'),
        detail: { key_class: t.keyClass, declared: t.declared, key_sha8: t.keySha8 },
      }));
      return notFound(res);
    }

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

    // FAIL CLOSED, BEFORE THE POINT OF NO RETURN. retireRemovedPacks below
    // runs an UNSCOPED `DELETE FROM managed_agent_skills` and the value itself
    // rides upstream on the next sync; neither is rollback-able, so an
    // unrecordable write is refused rather than performed unrecorded. The
    // 'attempted' row is the authorised intent; the 'ok' row below is the
    // execution. An 'attempted' with no partner means the process died
    // mid-write, which is itself worth seeing.
    if (critical) {
      try {
        await auditCritical(req, Object.assign({}, auditBase, {
          outcome: 'attempted',
          detail: { key_class: t.keyClass, declared: t.declared },
        }));
      } catch (auditErr) {
        return res.status(503).json({ error: 'Action refused: it could not be recorded.' });
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

    // The terminal row. SHAPE, NOT CONTENTS: counts and the retired pack NAMES,
    // never the playbook blob. The blast radius of this write is "how many
    // packs went away and how many agent attachments that detached", and that
    // is exactly what a reader needs.
    auditLog(req, Object.assign({}, auditBase, {
      outcome: 'ok',
      detail: {
        key_class: t.keyClass,
        declared: t.declared,
        packs_after: Array.isArray(value && value.skills) ? value.skills.length : null,
        packs_retired: retiredReport ? retiredReport.length : 0,
        agents_detached: retiredReport ? retiredReport.reduce((n, r) => n + (r.detached || 0), 0) : 0,
        retired_names: retiredReport ? retiredReport.map((r) => r.name) : undefined,
      },
    }));

    res.json(retiredReport ? { ok: true, retired: retiredReport } : { ok: true });
  } catch (e) {
    console.error('PUT /api/settings/:key error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
