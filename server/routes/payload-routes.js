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

const router = express.Router();

// ──────────────────────────────────────────────────────────────────
// PAYLOAD_OPS_SCHEMAS — per-entity_type ops vocabulary.
//
// Skeleton placeholder for C1. Real shapes land in C3 (client +
// estimate) and C5 (job + lead + schedule + system). Both
// make86OnCustomToolUse (emit-time) and the apply dispatcher
// (apply-time) import this constant so validation is single-source.
// ──────────────────────────────────────────────────────────────────
const PAYLOAD_OPS_SCHEMAS = Object.freeze({
  // Filled in C3+
  estimate: null,
  job: null,
  client: null,
  lead: null,
  schedule: null,
  system: null,
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

// ──────────────────────────────────────────────────────────────────
// Filename generator — see plan §filename rules.
//
// single-target: `{EntityType}.{IdOrRef}-{ShortName}.{YYYY-MM-DD}.p86.json`
// multi-target:  `Multi-{N}.{shortdesc}.{YYYY-MM-DD}.p86.json`
//
// Collisions get a -2, -3, etc. suffix per-user. Caller is responsible
// for passing a sanitized short_name (CamelCase, alphanumeric, ≤24 chars).
// ──────────────────────────────────────────────────────────────────
function sanitizeShortName(s, maxLen = 24) {
  if (!s) return 'Unnamed';
  // Strip non-alphanumeric, collapse whitespace, CamelCase from words.
  const parts = String(s).replace(/[^A-Za-z0-9\s]/g, ' ').trim().split(/\s+/);
  const camel = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
  return camel.slice(0, maxLen) || 'Unnamed';
}

function generateFilename(targets, title) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (Array.isArray(targets) && targets.length === 1) {
    const t = targets[0];
    const entityType = String(t.entity_type || 'unknown')
      .charAt(0).toUpperCase() + String(t.entity_type || 'unknown').slice(1).toLowerCase();
    const idRef = String(t.entity_id || 'NEW').slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '');
    const shortName = sanitizeShortName(t.entity_display || title || 'Untitled');
    return `${entityType}.${idRef}-${shortName}.${date}.p86.json`;
  }
  const n = Array.isArray(targets) ? targets.length : 0;
  const shortDesc = sanitizeShortName(title || 'Bundle');
  return `Multi-${n}.${shortDesc}.${date}.p86.json`;
}

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
// POST /api/payloads/:id/apply  (skeleton — implemented in C3 + C5)
//
// Returns 501 for now. The dispatcher lands in C3 (client + estimate)
// and C5 (job + lead + schedule + system). Apply flow per plan:
//   BEGIN TXN → SELECT payload ready+unexpired → per-target
//   pg_advisory_xact_lock (sorted) → build $new_id ref table → for
//   each target: validate ops, dispatch via existing write route,
//   register new ids in ref table → COMMIT (or ROLLBACK on failure
//   or dry_run=true) → broadcast SSE 'p86:payload-applied' → return
//   summary.
// ──────────────────────────────────────────────────────────────────
router.post('/:id/apply', requireAuth, requireOrg, async (req, res) => {
  res.status(501).json({
    error: 'Not implemented',
    detail: 'Apply dispatcher lands in C3 (client + estimate) and C5 (job + lead + schedule + system).',
  });
});

// ──────────────────────────────────────────────────────────────────
// POST /api/payloads/from-csv  (skeleton — implemented in C14)
// ──────────────────────────────────────────────────────────────────
router.post('/from-csv', requireAuth, requireOrg, async (req, res) => {
  res.status(501).json({ error: 'Not implemented', detail: 'CSV import lands in C14.' });
});

// Export internals for cross-file imports (ai-routes will pull
// PAYLOAD_OPS_SCHEMAS + filename helpers when wiring emit_payload_file
// in C4).
module.exports = router;
module.exports.internals = {
  PAYLOAD_OPS_SCHEMAS,
  ALLOWED_ENTITY_TYPES,
  VALID_SOURCES,
  generateFilename,
  sanitizeShortName,
};
