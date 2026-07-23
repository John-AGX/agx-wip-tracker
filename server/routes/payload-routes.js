// Payload routes — Project 86 Payload DSL (v1).
//
// 86 (and background watchers) produce .p86.json files. Each file is
// one payload row with a fully-resolved targets[] + ops bundle. The
// user drags a file into the universal dropbox in the AI panel; the
// server-side decoder dispatches each target's ops to existing write
// routes within a single PG transaction.
//
// This file owns:
//   GET    /api/payloads/:id/file          serves file_content as the
//                                          downloadable .p86.json
//   GET    /api/payloads/:id               fetch one (preview)
//   POST   /api/payloads/:id/apply         apply (PG txn, ref resolver)
//   POST   /api/payloads/:id/apply?dry_run=true  ROLLBACK + diff
//   POST   /api/payloads/:id/reject        soft dismissal
//
// These back the inline approval card in the AI panel. The legacy
// sidebar list, CSV import, recipes, and admin audit endpoints were
// removed when the drag-to-dropbox client UI was retired.
//
// PAYLOAD_OPS_SCHEMAS is the single source of truth for per-entity_type
// `ops` shapes — both emit-time validation (in ai-routes
// make86OnCustomToolUse) and apply-time dispatch import from it.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireOrg, hasCapability } = require('../auth');
const dispatcher = require('../services/payload-dispatcher');
// Training flywheel — every approve/reject verdict on a Scribe-authored
// payload is a labeled example (accepted true/false). Deterministic id
// 'tex_pl_<payloadId>' + terminal statuses (applied XOR rejected) = at
// most one example per payload, however many times a route re-fires.
const { captureExample, TASKS } = require('../services/training-capture');

// Capture the human verdict on a payload as a training example. Never
// throws (captureExample swallows). `payload` needs targets/title/summary/
// rationale/emitting_agent_key; pass what the route already fetched.
function capturePayloadVerdict(orgId, payload, accepted, applySummary) {
  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const entityTypes = Array.from(new Set(
    targets.map((t) => t && t.entity_type).filter(Boolean)
  ));
  captureExample({
    id: 'tex_pl_' + payload.id,
    orgId,
    task: TASKS.SCRIBE_PAYLOAD,
    sourceKind: 'payload',
    sourceId: payload.id,
    input: {
      title: payload.title || null,
      summary: payload.summary || null,
      rationale: payload.rationale || null,
      entity_types: entityTypes,
      emitting_agent_key: payload.emitting_agent_key || null
    },
    modelOutput: { targets },
    humanFinal: accepted ? { targets, apply_summary: applySummary || null } : null,
    accepted,
    model: payload.emitting_agent_key === 'scribe' ? 'claude-sonnet-4-6' : null
  });
}

const router = express.Router();

// ──────────────────────────────────────────────────────────────────
// COMPATIBILITY TABLE — which entity_types a payload can target.
// Skeleton; refined as dispatchers come online.
// ──────────────────────────────────────────────────────────────────
const ALLOWED_ENTITY_TYPES = new Set([
  'estimate', 'job', 'client', 'lead', 'schedule', 'system', 'assembly',
]);

// ──────────────────────────────────────────────────────────────────
// SOURCE values — keep the union closed so we can filter and audit
// reliably. Tests in CI verify any new emitter registers here too.
// ──────────────────────────────────────────────────────────────────
const VALID_SOURCES = new Set([
  '86',
  'watcher_86-pm',
  'watcher_86-directory',
  'watcher_86-estimator',
  'watcher_86-scheduler',
  'watcher_86-sales',
  'watch_rule',
  'csv_import',
  'qb_sync',
  'manual',
]);

// Filename helpers live in payload-dispatcher (single source). Re-
// exported from this module so the watch emitter and the QB-sync
// emitter all use the same generator. Plan §filename rules.
const { generateFilename, sanitizeShortName, newPayloadId } = dispatcher;

// ──────────────────────────────────────────────────────────────────
// GET /api/payloads — recent payloads for the caller (own rows + org-wide
// watcher rows). Lean columns only; drives the Crew Activity panel's
// "Scribe drafts" section. Declared BEFORE /:id so the root path can't be
// swallowed by the param route.
// ──────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireOrg, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 15, 50);
    const r = await pool.query(
      `SELECT id, title, summary, status, apply_summary, emitting_agent_key,
              created_at, applied_at
         FROM payloads
        WHERE organization_id = $1
          AND (user_id = $2 OR user_id IS NULL)
        ORDER BY created_at DESC
        LIMIT $3`,
      [req.user.organization_id, req.user.id, limit]
    );
    res.json({ payloads: r.rows });
  } catch (e) {
    console.error('[payloads] GET / error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/payloads/:id
//   Single-row fetch for preview drawer. Authorization: same as list
//   (own row OR org-wide watcher row).
// ──────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, requireOrg, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const r = await pool.query(
      `SELECT id, source, emitting_agent_key, filename, file_content, targets,
              title, summary, rationale, template_id, status, applied_at,
              apply_summary, apply_error, apply_error_detail,
              created_at, expires_at, session_id,
              parent_message_id, user_id
         FROM payloads
        WHERE id = $1
          AND organization_id = $2
          AND (user_id = $3 OR user_id IS NULL)`,
      [req.params.id, orgId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ payload: r.rows[0] });
  } catch (e) {
    console.error('[payloads] GET /:id error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/payloads/:id/file
//   Serves the file_content as a downloadable .p86.json with the
//   correct MIME type and Content-Disposition. Used by the chat file
//   artifact's "Download" button AND by drag-from-OS round-tripping
//   (user downloads, edits in a text editor, re-uploads via dropbox).
// ──────────────────────────────────────────────────────────────────
router.get('/:id/file', requireAuth, requireOrg, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const r = await pool.query(
      `SELECT filename, file_content
         FROM payloads
        WHERE id = $1
          AND organization_id = $2
          AND (user_id = $3 OR user_id IS NULL)`,
      [req.params.id, orgId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });

    const { filename, file_content } = r.rows[0];
    // Strip non-ASCII from filename so the Content-Disposition header is
    // RFC-7230 compliant; fall back to a safe default if filename is empty.
    const safeFilename = (filename || `payload-${req.params.id}.p86.json`)
      .replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.p86.payload+json');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.json(file_content);
  } catch (e) {
    console.error('[payloads] GET /:id/file error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/payloads/:id/reject
//   User dismisses a ready payload without applying. Status flips to
//   'rejected'; row stays in the audit trail. Idempotent — re-rejecting
//   a rejected row returns 200.
// ──────────────────────────────────────────────────────────────────
router.post('/:id/reject', requireAuth, requireOrg, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const r = await pool.query(
      `UPDATE payloads
          SET status = 'rejected'
        WHERE id = $1
          AND organization_id = $2
          AND (user_id = $3 OR user_id IS NULL)
          -- 'applying' with a STALE claim is included so a card can never wedge.
          -- Approve 409s on a live claim and Reject used to 404 on any 'applying'
          -- row, which left an abandoned apply (process restart mid-flight) as a
          -- card the user could neither approve nor dismiss. A claim younger than
          -- 5 minutes is still treated as live and stays un-rejectable, so this
          -- cannot cancel an apply that is genuinely running.
          AND (status IN ('ready', 'rejected')
               OR (status = 'applying'
                   AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')))
        RETURNING id, status, targets, title, summary, rationale, emitting_agent_key`,
      [req.params.id, orgId, userId]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: 'Not found or wrong status' });
    }
    // Rejection = a negative training example (deduped by payload id).
    capturePayloadVerdict(orgId, r.rows[0], false, null);
    res.json({ ok: true, payload: { id: r.rows[0].id, status: r.rows[0].status } });
  } catch (e) {
    console.error('[payloads] POST /:id/reject error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/payloads/:id/apply
//   ?dry_run=true  → ROLLBACK + diff response (full path wired in C6)
//
// Flow (per plan §Apply):
//   1. SELECT FOR UPDATE the ready+unexpired payload row.
//   2. Hand the row to dispatcher.applyPayload, which opens its own
//      transaction, takes per-target advisory locks in sorted order,
//      dispatches by entity_type, resolves $new_id refs, and either
//      COMMITs or ROLLBACKs based on dry_run.
//   3. UPDATE payloads.status atomically (separate query, outside the
//      dispatcher's txn — we want the row update to land even if the
//      dispatcher's COMMIT already happened).
//
// Status codes:
//   200 ok + apply_summary + affected_targets
//   404 not found (or wrong owner)
//   409 wrong status (not 'ready')
//   410 expired
//   422 validation (unknown op / blocked field / unresolved ref)
//   500 dispatch failure
// ──────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────
// P0-2 — apply-time capability gate.
//
// /apply dispatches writes to leads, clients, estimates, jobs,
// schedules, reports, and org-config (system), but the route only
// required auth + org. Map each target entity_type to the capability
// its REST edit equivalent requires and verify the caller holds it
// BEFORE the dispatcher runs, so a field_crew / sub / non-owner PM
// can't apply a financial or lead payload they could never write via
// the normal UI. A denial is a clean 403 that LEAVES the payload
// 'ready' (it must not brick the row for an authorized applier).
// ──────────────────────────────────────────────────────────────────
const PAYLOAD_APPLY_CAP = {
  lead:     ['LEADS_EDIT'],
  client:   ['ESTIMATES_EDIT'],
  estimate: ['ESTIMATES_EDIT'],
  job:      ['JOBS_EDIT_ANY', 'JOBS_EDIT_OWN'],
  report:   ['JOBS_EDIT_ANY', 'JOBS_EDIT_OWN'],
  schedule: ['JOBS_VIEW_ALL'],
  system:   ['ROLES_MANAGE'],
  assembly: ['ESTIMATES_EDIT'],
};

// Walk a payload's targets[] (regular + move source/dest + bulk) and
// collect the entity types it writes, plus the job entity_ids (for the
// JOBS_EDIT_OWN ownership sub-check).
function collectPayloadScope(targets) {
  const types = new Set();
  const jobIds = new Set();
  const visit = (t) => {
    if (!t || typeof t !== 'object') return;
    const et = t.entity_type ? String(t.entity_type).toLowerCase() : null;
    if (!et) return;
    types.add(et);
    if (et === 'job' && t.entity_id) jobIds.add(String(t.entity_id));
    if (et === 'job' && t.bulk && Array.isArray(t.bulk.items)) {
      t.bulk.items.forEach((it) => { if (it && it.entity_id) jobIds.add(String(it.entity_id)); });
    }
  };
  for (const t of (Array.isArray(targets) ? targets : [])) {
    if (t && t.op === 'move') { visit(t.source); visit(t.dest); }
    else visit(t);
  }
  return { types: Array.from(types), jobIds: Array.from(jobIds) };
}

// Returns null when the caller may apply this payload, else a human
// string (mapped to 403). Async — the JOBS_EDIT_OWN path verifies
// ownership of each targeted job.
async function denyPayloadApply(user, payload) {
  // Watcher-emitted payloads (user_id IS NULL) are admin-review items —
  // any org member could previously self-apply them. Require ROLES_MANAGE.
  if (payload.user_id == null && !hasCapability(user, 'ROLES_MANAGE')) {
    return 'This is an admin-review (watcher) payload — applying it requires the Roles & Permissions capability.';
  }
  const { types, jobIds } = collectPayloadScope(payload.targets);
  for (const et of types) {
    const caps = PAYLOAD_APPLY_CAP[et];
    if (!caps) continue; // unknown entity_type — the dispatcher rejects it
    if (!caps.some((c) => hasCapability(user, c))) {
      return 'You don\'t have permission to apply changes to ' + et + ' records (requires ' + caps.join(' or ') + ').';
    }
  }
  // JOBS_EDIT_OWN-only holders may apply job payloads only to jobs they own.
  if (jobIds.length && !hasCapability(user, 'JOBS_EDIT_ANY') && hasCapability(user, 'JOBS_EDIT_OWN')) {
    for (const jid of jobIds) {
      const r = await pool.query('SELECT owner_id FROM jobs WHERE id = $1', [jid]);
      if (!r.rows.length || String(r.rows[0].owner_id) !== String(user.id)) {
        return 'You can only apply job payloads to jobs you own.';
      }
    }
  }
  return null;
}

router.post('/:id/apply', requireAuth, requireOrg, async (req, res) => {
  const orgId = req.user.organization_id;
  const userId = req.user.id;
  const dryRun = String(req.query.dry_run || '').toLowerCase() === 'true';

  try {
    // Fetch the payload row with the same ownership filter the list
    // endpoint uses (user_id matches OR row is org-wide / watcher-emitted).
    const r = await pool.query(
      `SELECT id, organization_id, user_id, source, emitting_agent_key,
              filename, file_content, targets, title, summary, rationale,
              status, expires_at
         FROM payloads
        WHERE id = $1
          AND organization_id = $2
          AND (user_id = $3 OR user_id IS NULL)`,
      [req.params.id, orgId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const payload = r.rows[0];

    if (payload.status !== 'ready') {
      return res.status(409).json({
        error: 'Payload not in ready state',
        status: payload.status,
      });
    }
    if (payload.expires_at && new Date(payload.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Payload expired' });
    }

    // P0-2 capability gate — verify the caller may write every entity
    // type this payload touches (and owns each targeted job, for
    // JOBS_EDIT_OWN holders) BEFORE the dispatcher runs. 403 leaves the
    // payload 'ready' so a later authorized applier can still use it.
    const denial = await denyPayloadApply(req.user, payload);
    if (denial) return res.status(403).json({ error: denial });

    // Claim the payload atomically before dispatching. The status==='ready'
    // check above and the status='applied' write further down are separate
    // statements, so two applies of the SAME payload — a double-click, a
    // retried request, a reopened stream replaying the tool call — both read
    // 'ready' and both dispatch, creating every record in it twice. The
    // dispatcher's advisory locks serialize those two applies but do not
    // collapse them. A conditional UPDATE lets exactly one caller through.
    //
    // Dry runs deliberately do not claim: they roll back and the row must
    // stay droppable for the real run.
    if (!dryRun) {
      const claim = await pool.query(
        // SELF-HEALING CLAIM. Taking the claim only from 'ready' meant that any
        // apply which never reached a terminal status — the process restarting
        // mid-flight (every deploy does this), a dropped connection, a killed
        // request — stranded the row in 'applying'. From there Approve 409s and
        // Reject 404s (it only accepts ready/rejected), so the card is WEDGED:
        // the user cannot approve it and cannot dismiss it either.
        //
        // Re-claiming a stale claim fixes that without weakening the guard the
        // claim exists for: genuine double-applies (a double-click, a replayed
        // tool call) land seconds apart and still collide, while an abandoned
        // claim frees itself after 5 minutes. No apply legitimately runs that long.
        `UPDATE payloads SET status = 'applying', claimed_at = NOW()
          WHERE id = $1
            AND (status = 'ready'
                 OR (status = 'applying'
                     AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')))
          RETURNING id`,
        [payload.id]
      );
      if (!claim.rowCount) {
        return res.status(409).json({
          error: 'This payload is already being applied (or is no longer ready).',
        });
      }
    }

    // Hand to the dispatcher. Throws on validation errors / dispatch
    // failures — we map to the right status code below.
    let result;
    try {
      result = await dispatcher.applyPayload(payload, {
        userId,
        organizationId: orgId,
        sourceAgent: payload.emitting_agent_key === 'job' ? '86' : (payload.emitting_agent_key || null),
        dryRun,
      });
    } catch (err) {
      // Validation-style errors are descriptive; surface as 422 unless
      // we know they're 5xx-shaped. Wave 1.C: PayloadValidationError
      // carries a structured `detail` object — persist it into
      // apply_error_detail alongside the human message so 86 (and the
      // UI) can read field_path / expected / received without parsing
      // the message text.
      const msg = err && err.message || String(err);
      const isStructured = err && err.name === 'PayloadValidationError' && err.detail;
      const isValidation = isStructured ||
        /not yet implemented|requires|must be|not found|Unknown|blocked key|Unresolved ref|cannot be its own/i.test(msg);
      console.error('[payloads] apply failed:', err && err.stack || err);
      // Mark the row as failed only for real apply runs (not dry runs).
      if (!dryRun) {
        try {
          await pool.query(
            `UPDATE payloads
                SET status = 'failed',
                    apply_error = $1,
                    apply_error_detail = $2::jsonb
              WHERE id = $3 AND status = 'applying'`,
            [msg.slice(0, 1000), isStructured ? JSON.stringify(err.detail) : null, payload.id]
          );
        } catch (_) {}
      }
      const body = { error: msg };
      if (isStructured) body.detail = err.detail;
      return res.status(isValidation ? 422 : 500).json(body);
    }

    // Persist status on successful real applies. Dry runs keep status='ready'
    // so the user can drop them again for the real run. apply_changeset
    // (Wave 1.C before/after audit) is captured on real applies so the
    // row carries everything an "undo last payload" needs.
    if (!dryRun) {
      // The dispatcher has already COMMITTED. If this bookkeeping throws, the
      // row would be stranded in 'applying' — invisible in the ready list and
      // re-appliable after a boot reset, duplicating every record it wrote.
      // 'applied' is the truthful terminal state either way, so a failure here
      // must never propagate; log it loudly and keep going.
      try {
        await pool.query(
          `UPDATE payloads
              SET status = 'applied',
                  applied_at = NOW(),
                  apply_summary = $1,
                  apply_changeset = $2::jsonb
            WHERE id = $3`,
          [
            result.apply_summary,
            (Array.isArray(result.apply_changeset) && result.apply_changeset.length)
              ? JSON.stringify(result.apply_changeset) : null,
            payload.id,
          ]
        );
      } catch (bookErr) {
        console.error('[payloads] APPLIED BUT STATUS WRITE FAILED for', payload.id, bookErr);
        try {
          await pool.query(`UPDATE payloads SET status = 'applied', applied_at = NOW() WHERE id = $1`, [payload.id]);
        } catch (_) { /* last resort; the boot sweep will not free it while young */ }
      }
      // Approval = a positive training example (deduped by payload id).
      try { capturePayloadVerdict(orgId, payload, true, result.apply_summary); } catch (_) {}
    }

    res.json({
      ok: true,
      dry_run: dryRun,
      apply_summary: result.apply_summary,
      affected_targets: result.affected_targets,
      apply_changeset: result.apply_changeset || [],
      ref_resolutions: result.ref_resolutions,
    });
  } catch (e) {
    console.error('[payloads] POST /:id/apply error:', e && e.stack || e);
    res.status(500).json({ error: e && e.message || 'Server error' });
  }
});

// ── Approve-in-chat helpers (2026-07-03) ──────────────────────────
// isHighRiskPayload — payloads that must ALWAYS render an approval
// card, even when the user already said "yes" in conversation:
// anything that DELETES data, anything touching the `system` entity
// (skills/tools/links config), and (when it lands) outbound sends.
// Conservative string-scan over the targets JSONB: false negatives
// auto-apply a destructive change, false positives just show a card —
// so we err inclusive.
function isHighRiskPayload(payload) {
  try {
    const targets = Array.isArray(payload.targets) ? payload.targets
      : (typeof payload.targets === 'string' ? JSON.parse(payload.targets) : payload.targets);
    if (!Array.isArray(targets)) return true; // malformed → card
    for (const t of targets) {
      if (!t) continue;
      if (t.entity_type === 'system') return true;
      const s = JSON.stringify(t.ops || {});
      if (/"op"\s*:\s*"delete"/.test(s)) return true;                 // blocks/items with op:'delete'
      if (/_deletes"\s*:\s*\[\s*[^\]\s]/.test(s)) return true;        // non-empty line_deletes / section_deletes / ...
      if (/"(delete|remove)_[a-z_]*"\s*:\s*(\[\s*[^\]\s]|true)/.test(s)) return true;
      if (/"send_email"|"outbound"|"mail_send"/.test(s)) return true; // future outbound kinds
    }
    return false;
  } catch (_) {
    return true; // unparseable → card
  }
}

// applyPayloadForUser — server-side twin of POST /:id/apply for the
// approve-in-chat flow (the user already confirmed in conversation;
// the Scribe's detached draft run applies it directly). SAME safety
// rails as the route: org+ownership row filter, ready/expiry checks,
// denyPayloadApply capability gate, dispatcher real run, status +
// changeset persist, training-verdict capture. `user` must carry
// id / organization_id / role (a users-table row or req.user).
async function applyPayloadForUser(user, payloadId) {
  const orgId = user && user.organization_id;
  const userId = user && user.id;
  if (!orgId || !userId) return { ok: false, error: 'applyPayloadForUser requires a user with id + organization_id' };
  const r = await pool.query(
    `SELECT id, organization_id, user_id, source, emitting_agent_key,
            filename, file_content, targets, title, summary, rationale,
            status, expires_at
       FROM payloads
      WHERE id = $1 AND organization_id = $2 AND (user_id = $3 OR user_id IS NULL)`,
    [payloadId, orgId, userId]
  );
  if (!r.rows.length) return { ok: false, error: 'Payload not found' };
  const payload = r.rows[0];
  if (payload.status !== 'ready') return { ok: false, error: 'Payload not in ready state (' + payload.status + ')' };
  if (payload.expires_at && new Date(payload.expires_at) < new Date()) return { ok: false, error: 'Payload expired' };
  const denial = await denyPayloadApply(user, payload);
  if (denial) return { ok: false, error: denial };
  // Same atomic claim as POST /:id/apply — this approve-in-chat path is a
  // second door to the same dispatcher, and "yes" arriving twice (a repeated
  // approval, a replayed tool call) would otherwise apply the payload twice.
  const claim = await pool.query(
    // Same self-healing claim as the REST door — a claim abandoned by a restart
    // must not wedge the card. See the comment there.
    `UPDATE payloads SET status = 'applying', claimed_at = NOW()
      WHERE id = $1
        AND (status = 'ready'
             OR (status = 'applying'
                 AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')))
      RETURNING id`,
    [payload.id]
  );
  if (!claim.rowCount) {
    return { ok: false, error: 'This payload is already being applied (or is no longer ready).' };
  }
  let result;
  try {
    result = await dispatcher.applyPayload(payload, {
      userId,
      organizationId: orgId,
      sourceAgent: payload.emitting_agent_key === 'job' ? '86' : (payload.emitting_agent_key || null),
      dryRun: false,
    });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    const isStructured = err && err.name === 'PayloadValidationError' && err.detail;
    try {
      await pool.query(
        `UPDATE payloads SET status = 'failed', apply_error = $1, apply_error_detail = $2::jsonb
          WHERE id = $3 AND status = 'applying'`,
        [msg.slice(0, 1000), isStructured ? JSON.stringify(err.detail) : null, payload.id]
      );
    } catch (_) {}
    return { ok: false, error: msg };
  }
  // Same rule as the REST door: the dispatcher already committed, so this
  // bookkeeping must never leave the row stranded in 'applying'.
  try {
    await pool.query(
      `UPDATE payloads
          SET status = 'applied', applied_at = NOW(), apply_summary = $1, apply_changeset = $2::jsonb
        WHERE id = $3`,
      [
        result.apply_summary,
        (Array.isArray(result.apply_changeset) && result.apply_changeset.length)
          ? JSON.stringify(result.apply_changeset) : null,
        payload.id,
      ]
    );
  } catch (bookErr) {
    console.error('[payloads] APPLIED BUT STATUS WRITE FAILED for', payload.id, bookErr);
    try { await pool.query(`UPDATE payloads SET status = 'applied', applied_at = NOW() WHERE id = $1`, [payload.id]); } catch (_) {}
  }
  try { capturePayloadVerdict(orgId, payload, true, result.apply_summary); } catch (_) {}
  return { ok: true, apply_summary: result.apply_summary, affected_targets: result.affected_targets };
}

// Export internals for cross-file imports (ai-routes will pull these
// when wiring emit_payload_file in C4). The dispatcher module is the
// canonical source for PAYLOAD_OPS_SCHEMAS and validateOps — we just
// re-expose them here so callers have one require() target.
module.exports = router;
module.exports.isHighRiskPayload = isHighRiskPayload;
module.exports.applyPayloadForUser = applyPayloadForUser;
module.exports.internals = {
  PAYLOAD_OPS_SCHEMAS: dispatcher.PAYLOAD_OPS_SCHEMAS,
  validateOps: dispatcher.validateOps,
  ALLOWED_ENTITY_TYPES,
  VALID_SOURCES,
  generateFilename,
  sanitizeShortName,
  newPayloadId,
};
