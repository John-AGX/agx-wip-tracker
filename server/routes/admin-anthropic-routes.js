// Admin Anthropic — read-only browser for resources hosted in your
// Anthropic account: Skills, Files, Batches. Lets the admin see
// exactly what's been created on the Anthropic side from this app —
// uploaded photos that became file_ids, submitted batches, native
// Skills (when we migrate to that primitive).
//
// All endpoints are thin wrappers around beta.* .list() methods on
// the SDK. No mutations from this surface — the create/delete paths
// live in their respective domain routers (admin-files-routes for
// uploads, admin-batch-routes for submissions, etc.).
//
// Endpoints:
//   GET /api/admin/anthropic/skills     list native Skills (after migration)
//   GET /api/admin/anthropic/files      list every uploaded file
//   GET /api/admin/anthropic/batches    list every submitted batch
//
// Admin-gated by ROLES_MANAGE.

const express = require('express');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

console.log('[admin-anthropic-routes] mounted at /api/admin/anthropic');

const { Anthropic } = require('@anthropic-ai/sdk');
let _anth = null;
function getAnthropic() {
  if (_anth) return _anth;
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  _anth = new Anthropic({ apiKey: key });
  return _anth;
}

function notConfigured() {
  return { error: 'ANTHROPIC_API_KEY not set on this deployment.' };
}

// GET /api/admin/anthropic/skills?limit=100
//   Lists native Skills attached to the API key's account. Returns
//   id, name, description (snippet), version count, created_at —
//   whatever the list endpoint surfaces. We haven't migrated to
//   native Skills yet so this likely returns empty for P86 today;
//   the endpoint is here for when we do.
router.get('/skills', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json(notConfigured());
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 100));
    const page = await anthropic.beta.skills.list({ limit });
    // SDK returns a Page-like with .data array.
    const skills = (page && (page.data || page)) || [];
    res.json({ skills: Array.isArray(skills) ? skills : [], note: skills.length ? null : 'No native Skills in this account yet.' });
  } catch (e) {
    console.error('GET /api/admin/anthropic/skills error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// GET /api/admin/anthropic/files?limit=100
//   Lists every file uploaded to Anthropic's Files API for this key.
//   Includes our photo uploads (admin-files-routes.js) plus any
//   ad-hoc uploads. Each row carries id, filename, size_bytes,
//   created_at, mime_type — handy for spotting orphan files we
//   uploaded but no longer reference.
router.get('/files', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json(notConfigured());
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 100));
    const page = await anthropic.beta.files.list({ limit });
    const files = (page && (page.data || page)) || [];
    res.json({ files: Array.isArray(files) ? files : [] });
  } catch (e) {
    console.error('GET /api/admin/anthropic/files error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// GET /api/admin/anthropic/batches?limit=100
//   Lists every Batch ever submitted from this API key. Our local
//   batch_jobs table mirrors what we submit, but this endpoint shows
//   the source of truth — including batches submitted from other
//   tooling, batches that failed before we recorded them locally, or
//   manually-cancelled ones.
router.get('/batches', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json(notConfigured());
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 100));
    const page = await anthropic.beta.messages.batches.list({ limit });
    const batches = (page && (page.data || page)) || [];
    res.json({ batches: Array.isArray(batches) ? batches : [] });
  } catch (e) {
    console.error('GET /api/admin/anthropic/batches error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

module.exports = router;
