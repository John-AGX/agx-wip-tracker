// Payload routes — Project 86 Payload DSL (v1).
//
// 86 (and background watchers) produce .p86.json files. Each file is
// one payload row with a fully-resolved targets[] + ops bundle. The
// user drags a file into the universal dropbox in the AI panel; the
// server-side decoder dispatches each target's ops to existing write
// routes within a single PG transaction.
//
// This file owns:
//   GET    /api/payloads                   list (sidebar + audit)
//   GET    /api/payloads/:id/file          serves file_content as the
//                                          downloadable .p86.json
//   GET    /api/payloads/:id               fetch one (preview + admin)
//   POST   /api/payloads/:id/apply         apply (PG txn, ref resolver)
//   POST   /api/payloads/:id/apply?dry_run=true  ROLLBACK + diff
//   POST   /api/payloads/:id/reject        soft dismissal
//   POST   /api/payloads/from-csv          CSV → payload converter
//   GET    /api/admin/payloads/audit       admin view with filters
//
// PAYLOAD_OPS_SCHEMAS is the single source of truth for per-entity_type
// `ops` shapes — both emit-time validation (in ai-routes
// make86OnCustomToolUse) and apply-time dispatch import from it.
//
// C1 scope: skeleton only — table-backed GET list, GET file, GET row,
// POST reject. The apply dispatcher, CSV converter, ops schemas, and
// admin audit endpoint land in later commits.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireOrg } = require('../auth');
const dispatcher = require('../services/payload-dispatcher');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────
// COMPATIBILITY TABLE — which entity_types a payload can target.
// Skeleton; refined as dispatchers come online.
// ──────────────────────────────────────────────────────────────────
const ALLOWED_ENTITY_TYPES = new Set([
  'estimate', 'job', 'client', 'lead', 'schedule', 'system',
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
// exported from this module so /from-csv, the watch emitter, and the
// QB-sync emitter all use the same generator. Plan §filename rules.
const { generateFilename, sanitizeShortName, newPayloadId } = dispatcher;

// ──────────────────────────────────────────────────────────────────
// GET /api/payloads
//   Lists payloads for the user's org, filterable by status, source,
//   session_id, and target_entity (jsonb gin lookup on targets[]).
//
//   Default returns the last 30 days of activity; pass ?since=<iso>
//   to override. Default limit 100; max 500.
//
//   Authorization model: the requester sees their own emitted payloads
//   PLUS org-wide payloads emitted by watchers (user_id IS NULL).
//   Admin audit view is a separate endpoint and joins differently.
// ──────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireOrg, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const source = typeof req.query.source === 'string' ? req.query.source : null;
    const sessionId = req.query.session_id ? parseInt(req.query.session_id, 10) : null;
    const targetEntity = typeof req.query.target_entity === 'string' ? req.query.target_entity : null;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const since = req.query.since
      ? new Date(req.query.since)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Conditions assembled positionally to keep the query plan stable.
    const conds = ['organization_id = $1', '(user_id = $2 OR user_id IS NULL)', 'created_at >= $3'];
    const args = [orgId, userId, since];

    if (status) {
      args.push(status);
      conds.push(`status = $${args.length}`);
    }
    if (source && VALID_SOURCES.has(source)) {
      args.push(source);
      conds.push(`source = $${args.length}`);
    }
    if (sessionId) {
      args.push(sessionId);
      conds.push(`session_id = $${args.length}`);
    }
    if (targetEntity) {
      // target_entity=estimate:est_abc123 → match any element in targets[]
      // whose (entity_type, entity_id) matches. jsonb_path_ops index
      // accelerates the `@>` containment check.
      const [eType, eId] = targetEntity.split(':');
      if (eType && eId) {
        args.push(JSON.stringify([{ entity_type: eType, entity_id: eId }]));
        conds.push(`targets @> $${args.length}::jsonb`);
      }
    }

    args.push(limit);
    const limitParam = `$${args.length}`;

    const r = await pool.query(
      `SELECT id, source, emitting_agent_key, filename, title, summary, rationale,
              targets, template_id, status, applied_at, apply_summary, apply_error,
              created_at, expires_at, session_id, parent_message_id
         FROM payloads
        WHERE ${conds.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ${limitParam}`,
      args
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
              apply_summary, apply_error, created_at, expires_at, session_id,
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
          AND status IN ('ready', 'rejected')
        RETURNING id, status`,
      [req.params.id, orgId, userId]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: 'Not found or wrong status' });
    }
    res.json({ ok: true, payload: r.rows[0] });
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

    // Hand to the dispatcher. Throws on validation errors / dispatch
    // failures — we map to the right status code below.
    let result;
    try {
      result = await dispatcher.applyPayload(payload, {
        userId,
        sourceAgent: payload.emitting_agent_key === 'job' ? '86' : (payload.emitting_agent_key || null),
        dryRun,
      });
    } catch (err) {
      // Validation-style errors are descriptive; surface as 422 unless
      // we know they're 5xx-shaped.
      const msg = err && err.message || String(err);
      const isValidation = /not yet implemented|requires|must be|not found|Unknown|blocked key|Unresolved ref|cannot be its own/i.test(msg);
      console.error('[payloads] apply failed:', err && err.stack || err);
      // Mark the row as failed only for real apply runs (not dry runs).
      if (!dryRun) {
        try {
          await pool.query(
            `UPDATE payloads
                SET status = 'failed', apply_error = $1
              WHERE id = $2 AND status = 'ready'`,
            [msg.slice(0, 1000), payload.id]
          );
        } catch (_) {}
      }
      return res.status(isValidation ? 422 : 500).json({ error: msg });
    }

    // Persist status on successful real applies. Dry runs keep status='ready'
    // so the user can drop them again for the real run.
    if (!dryRun) {
      await pool.query(
        `UPDATE payloads
            SET status = 'applied',
                applied_at = NOW(),
                apply_summary = $1
          WHERE id = $2`,
        [result.apply_summary, payload.id]
      );
    }

    res.json({
      ok: true,
      dry_run: dryRun,
      apply_summary: result.apply_summary,
      affected_targets: result.affected_targets,
      ref_resolutions: result.ref_resolutions,
    });
  } catch (e) {
    console.error('[payloads] POST /:id/apply error:', e && e.stack || e);
    res.status(500).json({ error: e && e.message || 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/payloads/from-csv  (skeleton — implemented in C14)
// ──────────────────────────────────────────────────────────────────
router.post('/from-csv', requireAuth, requireOrg, async (req, res) => {
  res.status(501).json({ error: 'Not implemented', detail: 'CSV import lands in C14.' });
});

// Export internals for cross-file imports (ai-routes will pull these
// when wiring emit_payload_file in C4). The dispatcher module is the
// canonical source for PAYLOAD_OPS_SCHEMAS and validateOps — we just
// re-expose them here so callers have one require() target.
module.exports = router;
module.exports.internals = {
  PAYLOAD_OPS_SCHEMAS: dispatcher.PAYLOAD_OPS_SCHEMAS,
  validateOps: dispatcher.validateOps,
  ALLOWED_ENTITY_TYPES,
  VALID_SOURCES,
  generateFilename,
  sanitizeShortName,
  newPayloadId,
};
