// Admin Anthropic — browser AND scaffolding for resources hosted in
// your Anthropic account: Skills, Files, Batches.
//
// Skills surface (post Phase 1 native build):
//   GET    /api/admin/anthropic/skills        list native Skills
//   POST   /api/admin/anthropic/skills        create a native Skill from markdown
//   DELETE /api/admin/anthropic/skills/:id    delete a native Skill by id
//
// Files / Batches remain read-only here — their create paths live in
// admin-files-routes / admin-batch-routes.
//
// The Skills create/delete endpoints are decoupled from the local
// pack-mirroring flow in admin-agents-routes. Mirror endpoints there
// still exist for legacy packs; this surface is the going-forward
// "fresh native build" admin UI.
//
// Admin-gated by ROLES_MANAGE.

const express = require('express');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

console.log('[admin-anthropic-routes] mounted at /api/admin/anthropic');

const { Anthropic, toFile } = require('@anthropic-ai/sdk');
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
//   whatever the list endpoint surfaces. Filters out non-skill rows
//   (Anthropic Files objects sometimes leak into this listing on
//   legacy accounts — they have no `skill_` id prefix).
router.get('/skills', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json(notConfigured());
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 100));
    const page = await anthropic.beta.skills.list({ limit });
    const raw = (page && (page.data || page)) || [];
    const skills = (Array.isArray(raw) ? raw : []).filter(s =>
      s && typeof s.id === 'string' && s.id.startsWith('skill_')
    );
    res.json({ skills, note: skills.length ? null : 'No native Skills in this account yet.' });
  } catch (e) {
    console.error('GET /api/admin/anthropic/skills error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/anthropic/skills
//   Body: { display_title: string, body: string (markdown) }
//   Creates a fresh native Anthropic Skill from a markdown body. The
//   body is wrapped in YAML frontmatter (name + description) and
//   uploaded as SKILL.md via beta.skills.create. Returns the created
//   skill's full record.
//
//   This endpoint is DECOUPLED from the local pack JSONB blob — it
//   creates a native skill directly. Use this when you're building
//   native-first (no local pack mirror). The legacy mirror endpoints
//   at /api/admin/agents/skills/:idx/sync-to-anthropic still work for
//   packs that exist in app_settings.agent_skills.
router.post('/skills', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json(notConfigured());
    const body = req.body || {};
    const displayTitle = String(body.display_title || '').trim();
    const md = String(body.body || '').trim();
    if (!displayTitle) return res.status(400).json({ error: 'display_title is required' });
    if (!md) return res.status(400).json({ error: 'body (markdown) is required' });
    if (displayTitle.length > 200) return res.status(400).json({ error: 'display_title must be 200 chars or fewer' });

    // Build SKILL.md with frontmatter. Anthropic Skills load this as
    // their identity card — `description` drives when the runtime
    // decides to surface the skill, so default it to the display
    // title when the caller doesn't supply one. Leading dashes /
    // frontmatter blocks already in the body pass through unchanged
    // — we only wrap if no frontmatter is detected.
    const description = String(body.description || displayTitle).replace(/[\r\n]/g, ' ').slice(0, 1024);
    const slug = String(displayTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
    const hasFrontmatter = /^---\s*\n/.test(md);
    const skillMd = hasFrontmatter
      ? md
      : [
          '---',
          'name: ' + slug,
          'description: ' + description,
          '---',
          '',
          md
        ].join('\n');

    const file = await toFile(Buffer.from(skillMd, 'utf8'), slug + '/SKILL.md', { type: 'text/markdown' });
    const created = await anthropic.beta.skills.create({
      display_title: displayTitle,
      files: [file]
    });

    res.json({ ok: true, skill: created });
  } catch (e) {
    console.error('POST /api/admin/anthropic/skills error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// DELETE /api/admin/anthropic/skills/:id
//   Deletes a native Anthropic Skill by id. Does NOT touch local
//   packs in app_settings.agent_skills — if the skill being deleted
//   was a mirror of a local pack, the local pack's anthropic_skill_id
//   pointer becomes stale and the admin UI will show it as un-synced.
//   That's intentional: this endpoint is the "purge from Anthropic"
//   knob, and re-syncing from the local pack rebuilds the pointer.
router.delete('/skills/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json(notConfigured());
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    await anthropic.beta.skills.delete(id);
    res.json({ ok: true, deleted: id });
  } catch (e) {
    console.error('DELETE /api/admin/anthropic/skills/:id error:', e);
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
