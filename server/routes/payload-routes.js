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
const multer = require('multer');
const { pool } = require('../db');
const { requireAuth, requireOrg } = require('../auth');
const dispatcher = require('../services/payload-dispatcher');
const csvConverter = require('../services/csv-payload-converter');

const router = express.Router();

// 10MB cap on CSV uploads. RAM-only — files are parsed inline, not
// persisted to disk.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

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
              apply_error_detail,
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
              WHERE id = $3 AND status = 'ready'`,
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

// ──────────────────────────────────────────────────────────────────
// POST /api/payloads/from-csv  (C14)
//   multipart upload: field 'file' = the CSV, field 'entity_type' =
//   'lead' | 'client' (more later). Returns the new payload row's
//   id + filename + target_count + any per-row csv_errors so the
//   client can surface them before the user drags the payload in.
//
//   Status mapping:
//     200 ok + payload metadata
//     400 invalid (no file, no entity_type, etc.)
//     422 csv parse / validation failure with detail message
//     413 file too big (handled by multer at the middleware level)
//     500 anything else
// ──────────────────────────────────────────────────────────────────
router.post('/from-csv',
  requireAuth, requireOrg,
  csvUpload.single('file'),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'multipart "file" field is required' });
      }
      const entityType = (req.body && req.body.entity_type || '').trim().toLowerCase();
      if (!entityType) return res.status(400).json({ error: '"entity_type" field is required' });

      let built;
      try {
        built = await csvConverter.convertCsvToPayload(req.file.buffer, entityType, {
          organizationId: req.user.organization_id,
          userId: req.user.id,
        });
      } catch (err) {
        return res.status(422).json({ error: err.message || String(err) });
      }

      // Persist the payload row so the sidebar Payloads section picks it up.
      await pool.query(
        `INSERT INTO payloads
           (id, organization_id, user_id, source, emitting_agent_key,
            filename, file_content, targets, title, summary, rationale)
         VALUES ($1, $2, $3, 'csv_import', NULL, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
        [
          built.payload_id,
          req.user.organization_id,
          req.user.id,
          built.filename,
          JSON.stringify(built.file_content),
          JSON.stringify(built.targets),
          built.title,
          built.summary,
          built.rationale,
        ]
      );

      res.json({
        ok: true,
        payload_id: built.payload_id,
        filename: built.filename,
        target_count: built.target_count,
        csv_errors: built.csv_errors,
        title: built.title,
        summary: built.summary,
      });
    } catch (e) {
      console.error('[payloads] POST /from-csv error:', e && e.stack || e);
      res.status(500).json({ error: e && e.message || 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// GET /api/admin/payloads/audit  (C16)
//   Org-wide audit view. Returns every payload in the caller's org
//   regardless of user_id, with filters by source, target_entity,
//   user_id, status, date range.
//
//   Auth: requireAuth + requireOrg + ROLES_MANAGE (admin-only).
//
//   Mounted at /api/admin/payloads/audit via server/index.js as a
//   separate sub-router (see exports at bottom of this file). The
//   sub-router exists so the auth gate is enforced at mount time —
//   the regular /api/payloads endpoints only need requireAuth + the
//   "your own or watcher" ownership filter, which would be too loose
//   for an admin-audit endpoint.
// ──────────────────────────────────────────────────────────────────

const adminRouter = express.Router();
const { requireCapability } = require('../auth');

adminRouter.get('/audit',
  requireAuth, requireOrg, requireCapability('ROLES_MANAGE'),
  async (req, res) => {
    try {
      const orgId = req.user.organization_id;
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const source = typeof req.query.source === 'string' ? req.query.source : null;
      const userIdFilter = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
      const targetEntity = typeof req.query.target_entity === 'string' ? req.query.target_entity : null;
      const since = req.query.since ? new Date(req.query.since) : null;
      const until = req.query.until ? new Date(req.query.until) : null;

      const conds = ['p.organization_id = $1'];
      const args = [orgId];

      if (status)        { args.push(status); conds.push(`p.status = $${args.length}`); }
      if (source)        { args.push(source); conds.push(`p.source = $${args.length}`); }
      if (userIdFilter)  { args.push(userIdFilter); conds.push(`p.user_id = $${args.length}`); }
      if (since)         { args.push(since); conds.push(`p.created_at >= $${args.length}`); }
      if (until)         { args.push(until); conds.push(`p.created_at <= $${args.length}`); }
      if (targetEntity) {
        const [eType, eId] = targetEntity.split(':');
        if (eType && eId) {
          args.push(JSON.stringify([{ entity_type: eType, entity_id: eId }]));
          conds.push(`p.targets @> $${args.length}::jsonb`);
        }
      }

      args.push(limit);
      const limitParam = `$${args.length}`;
      args.push(offset);
      const offsetParam = `$${args.length}`;

      // LEFT JOIN users so the audit table can show who emitted /
      // owns each payload. Watcher rows have user_id IS NULL so the
      // join surfaces null name + a synthetic "watcher" label below.
      const r = await pool.query(
        `SELECT p.id, p.source, p.emitting_agent_key, p.filename,
                p.title, p.summary, p.rationale, p.targets,
                p.status, p.applied_at, p.apply_summary, p.apply_error,
                p.apply_error_detail,
                p.created_at, p.expires_at, p.session_id, p.template_id,
                p.user_id, u.name AS user_name, u.email AS user_email
           FROM payloads p
           LEFT JOIN users u ON u.id = p.user_id
          WHERE ${conds.join(' AND ')}
          ORDER BY p.created_at DESC
          LIMIT ${limitParam} OFFSET ${offsetParam}`,
        args
      );

      // Total count for pagination — separate query so the main
      // SELECT can streaming-friendly LIMIT without scanning the
      // whole table.
      const countArgs = args.slice(0, args.length - 2);
      const countR = await pool.query(
        `SELECT COUNT(*)::int AS total FROM payloads p WHERE ${conds.join(' AND ')}`,
        countArgs
      );

      res.json({
        payloads: r.rows,
        total: countR.rows[0].total,
        limit,
        offset,
      });
    } catch (e) {
      console.error('[admin/payloads] GET /audit error:', e && e.stack || e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /api/admin/payloads/audit/summary
//   Rollup counts grouped by source + status. Cheap query, used by
//   the admin tab to show "X applied, Y ready, Z expired across N
//   sources" headline numbers.
adminRouter.get('/audit/summary',
  requireAuth, requireOrg, requireCapability('ROLES_MANAGE'),
  async (req, res) => {
    try {
      const orgId = req.user.organization_id;
      const r = await pool.query(
        `SELECT source, status, COUNT(*)::int AS n,
                COALESCE(SUM(jsonb_array_length(targets)), 0)::int AS total_targets
           FROM payloads
          WHERE organization_id = $1
            AND created_at > NOW() - INTERVAL '30 days'
          GROUP BY source, status
          ORDER BY source, status`,
        [orgId]
      );
      res.json({ rollup: r.rows });
    } catch (e) {
      console.error('[admin/payloads] GET /audit/summary error:', e && e.stack || e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Recipes (C11) — payload_templates table CRUD.
//
// A recipe is a payload_templates row holding a name + description +
// ops_template (the bundle structure to clone) + parameters (an array
// describing what the user/agent should fill in on each use). Recipes
// surface in the AI panel sidebar; the user can drag them into chat
// (C12) to feed them to 86 as context.
//
// In v1, parameter extraction is intentionally minimal: when a payload
// is pinned, we save the bundle verbatim with parameters=[]. Future
// versions can detect placeholder fields (entity_id values starting
// with $, ops fields the agent typically varies per use) and prompt
// the user for the parameterization shape.
// ──────────────────────────────────────────────────────────────────

// Mounted under /api/recipes via server/index.js as a separate
// sub-router (see below). Definitions live here so the dispatcher and
// payload helpers stay co-located with the recipe routes that produce
// payloads via clone.

const recipeRouter = express.Router();

// GET /api/recipes
//   List org's pinned + recent templates. Default sort: pinned first,
//   then last_used_at desc, then created_at desc.
recipeRouter.get('/', requireAuth, requireOrg, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const r = await pool.query(
      `SELECT id, name, description, icon, parameters, is_pinned,
              use_count, last_used_at, created_at, origin_payload_id
         FROM payload_templates
        WHERE organization_id = $1 AND archived = false
        ORDER BY is_pinned DESC, last_used_at DESC NULLS LAST, created_at DESC
        LIMIT $2`,
      [orgId, limit]
    );
    res.json({ recipes: r.rows });
  } catch (e) {
    console.error('[recipes] GET / error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/recipes
//   Pin an applied payload as a recipe. Body: { payload_id, name?,
//   description?, icon? }. Defaults to the payload's title for name.
//   The current bundle structure (file_content.targets) becomes the
//   ops_template; parameters[] starts empty.
recipeRouter.post('/', requireAuth, requireOrg, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const { payload_id, name, description, icon } = req.body || {};
    if (!payload_id) return res.status(400).json({ error: 'payload_id is required' });

    const pr = await pool.query(
      `SELECT id, title, summary, file_content, targets
         FROM payloads
        WHERE id = $1 AND organization_id = $2 AND (user_id = $3 OR user_id IS NULL)`,
      [payload_id, orgId, userId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'Payload not found' });
    const payload = pr.rows[0];

    const recipeName = (name || payload.title || 'Recipe').slice(0, 200);
    const recipeDescription = (description || payload.summary || '').slice(0, 2000);
    const recipeIcon = icon || '📄';

    // Idempotency: if a non-archived recipe with the same name exists
    // for this org, return it instead of creating a duplicate.
    const dup = await pool.query(
      `SELECT id FROM payload_templates
        WHERE organization_id = $1 AND name = $2 AND archived = false`,
      [orgId, recipeName]
    );
    if (dup.rows.length) {
      return res.json({ ok: true, status: 'reused', id: dup.rows[0].id, name: recipeName });
    }

    const id = 'tpl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    // ops_template carries the payload's full bundle so clone can
    // reproduce it verbatim (or, in a future version, with placeholder
    // substitution). file_content includes targets + meta; we strip
    // emitted_at + id so clones don't carry stale metadata.
    const opsTemplate = Object.assign({}, payload.file_content || {});
    delete opsTemplate.id;
    delete opsTemplate.filename;
    delete opsTemplate.emitted_at;

    await pool.query(
      `INSERT INTO payload_templates
         (id, organization_id, created_by_user_id, name, description, icon,
          parameters, ops_template, origin_payload_id, is_pinned, pinned_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7::jsonb, $8, true, $3)`,
      [
        id, orgId, userId,
        recipeName, recipeDescription, recipeIcon,
        JSON.stringify(opsTemplate),
        payload.id,
      ]
    );

    res.json({ ok: true, status: 'created', id, name: recipeName });
  } catch (e) {
    console.error('[recipes] POST / error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/recipes/:id/pin
//   Toggle is_pinned. Body: { pinned: bool } (default toggles).
recipeRouter.post('/:id/pin', requireAuth, requireOrg, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const desired = typeof req.body.pinned === 'boolean' ? req.body.pinned : null;
    const r = await pool.query(
      `UPDATE payload_templates
          SET is_pinned = COALESCE($3, NOT is_pinned),
              pinned_by_user_id = CASE
                WHEN COALESCE($3, NOT is_pinned) = true THEN $4
                ELSE pinned_by_user_id
              END
        WHERE id = $1 AND organization_id = $2 AND archived = false
        RETURNING id, is_pinned`,
      [req.params.id, orgId, desired, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Recipe not found' });
    res.json({ ok: true, recipe: r.rows[0] });
  } catch (e) {
    console.error('[recipes] POST /:id/pin error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Wave 2 — parameter substitution helper. Walks the ops_template
// recursively replacing every `{{paramName}}` marker in string values
// with parameter_values[paramName]. Non-string values pass through.
// Missing values surface as a structured error (caller returns 422 +
// the list of missing param names so the client can prompt for them).
//
// Substitution policy:
//   - "{{foo}}"               → exact replacement (preserves type if
//                                the param value is a number/object)
//   - "prefix-{{foo}}-suffix" → string concat (param value coerced to
//                                string)
//   - "{{a}}{{b}}"            → multiple markers, each substituted
//   - "{{foo}}"  where foo unset → recorded in `missing` and left as-is
//
// Returns: { substituted, missing }
function substituteParameters(node, paramValues) {
  const missing = new Set();
  function walk(v) {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      // Exact-match marker → preserve the original parameter type
      // (number stays number, object stays object). This is the case
      // for fields like `qty: "{{quantity}}"`.
      const exact = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/.exec(v);
      if (exact) {
        const key = exact[1];
        if (paramValues && Object.prototype.hasOwnProperty.call(paramValues, key)) {
          return paramValues[key];
        }
        missing.add(key);
        return v;
      }
      // Embedded markers → string-replace each one
      return v.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
        if (paramValues && Object.prototype.hasOwnProperty.call(paramValues, key)) {
          const pv = paramValues[key];
          return pv == null ? '' : String(pv);
        }
        missing.add(key);
        return _match;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  }
  return { substituted: walk(node), missing: [...missing] };
}

// POST /api/recipes/:id/clone
//   Instantiate a recipe — substitute parameters into ops_template,
//   create a new payload row in status='ready', return the payload_id
//   so the client can POST to /apply.
//   Body: { parameter_values?: { paramName: value, ... } }
//
// Wave 2 — was a v0 stub that copied ops_template verbatim; now
// substitutes {{placeholder}} markers using parameter_values.
// Validates that every parameter declared on the template is present
// in the body and surfaces missing ones as a 422 with structured
// detail so the caller (UI or 86) can prompt for them.
recipeRouter.post('/:id/clone', requireAuth, requireOrg, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const dispatcher = require('../services/payload-dispatcher');

    const r = await pool.query(
      `SELECT id, name, description, ops_template, parameters
         FROM payload_templates
        WHERE id = $1 AND organization_id = $2 AND archived = false`,
      [req.params.id, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Recipe not found' });
    const tpl = r.rows[0];
    const paramValues = (req.body && req.body.parameter_values) || {};
    const opsTemplateRaw = tpl.ops_template || {};

    // Substitute parameters in the WHOLE ops_template (so title /
    // summary / rationale / targets / nested ops all get markers
    // replaced together). If any required markers are missing,
    // surface them as a structured 422.
    const { substituted: opsTemplate, missing } = substituteParameters(opsTemplateRaw, paramValues);
    if (missing.length) {
      const declared = Array.isArray(tpl.parameters) ? tpl.parameters.map(p => p.name) : [];
      return res.status(422).json({
        error: 'Missing required parameter values: ' + missing.join(', '),
        detail: {
          code: 'missing_parameters',
          field_path: 'parameter_values',
          received: Object.keys(paramValues),
          expected: declared.length ? declared : missing,
          missing,
          suggestion: 'Pass each {{marker}} in the recipe\'s ops_template as a key under parameter_values.'
        }
      });
    }

    const targets = Array.isArray(opsTemplate.targets) ? opsTemplate.targets : [];
    if (!targets.length) {
      return res.status(422).json({ error: 'Recipe has no targets to clone' });
    }

    const payloadId = dispatcher.newPayloadId();
    const title = opsTemplate.title || tpl.name;
    const summary = opsTemplate.summary || tpl.description || '';
    const rationale = (opsTemplate.rationale || '') +
      (opsTemplate.rationale ? '\n\n' : '') +
      'Generated from recipe: ' + tpl.name;
    const filename = dispatcher.generateFilename(targets, title);
    const fileContent = Object.assign({}, opsTemplate, {
      id: payloadId,
      filename,
      title,
      summary,
      rationale,
      template_ref: {
        template_id: tpl.id,
        template_name: tpl.name,
        parameters: req.body && req.body.parameter_values || {},
      },
      emitted_at: new Date().toISOString(),
      source: 'manual',
      emitting_agent_key: null,
    });

    await pool.query(
      `INSERT INTO payloads
         (id, organization_id, user_id, source, emitting_agent_key,
          filename, file_content, targets, title, summary, rationale, template_id)
       VALUES ($1, $2, $3, 'manual', NULL, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
      [
        payloadId, orgId, userId,
        filename,
        JSON.stringify(fileContent),
        JSON.stringify(targets),
        title, summary, rationale,
        tpl.id,
      ]
    );

    await pool.query(
      `UPDATE payload_templates
          SET use_count = use_count + 1, last_used_at = NOW()
        WHERE id = $1`,
      [tpl.id]
    );

    res.json({ ok: true, payload_id: payloadId, filename });
  } catch (e) {
    console.error('[recipes] POST /:id/clone error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/recipes/:id — soft-archive a recipe.
recipeRouter.delete('/:id', requireAuth, requireOrg, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const r = await pool.query(
      `UPDATE payload_templates
          SET archived = true, is_pinned = false
        WHERE id = $1 AND organization_id = $2 AND archived = false
        RETURNING id`,
      [req.params.id, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Recipe not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[recipes] DELETE /:id error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Export internals for cross-file imports (ai-routes will pull these
// when wiring emit_payload_file in C4). The dispatcher module is the
// canonical source for PAYLOAD_OPS_SCHEMAS and validateOps — we just
// re-expose them here so callers have one require() target.
module.exports = router;
module.exports.recipes = recipeRouter;
module.exports.admin = adminRouter;
module.exports.internals = {
  PAYLOAD_OPS_SCHEMAS: dispatcher.PAYLOAD_OPS_SCHEMAS,
  validateOps: dispatcher.validateOps,
  ALLOWED_ENTITY_TYPES,
  VALID_SOURCES,
  generateFilename,
  sanitizeShortName,
  newPayloadId,
};
