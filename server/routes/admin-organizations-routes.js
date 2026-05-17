// Admin organizations — multi-tenant management endpoints.
//
// Today there's exactly one organization (AGX), so most of these
// endpoints scope to the caller's org by default. The shape supports
// multi-org without code change once additional tenants exist:
//   - GET    /api/admin/organizations           — list all (admin-only)
//   - GET    /api/admin/organizations/me        — caller's own org
//   - PUT    /api/admin/organizations/:id       — update name / description / identity_body
//   - GET    /api/admin/organizations/:id/skill-packs        — list packs
//   - POST   /api/admin/organizations/:id/skill-packs        — create pack
//   - PUT    /api/admin/organizations/:id/skill-packs/:packId — update pack
//   - DELETE /api/admin/organizations/:id/skill-packs/:packId — soft-delete pack
//
// All admin-gated by ROLES_MANAGE. The :id path param must match the
// caller's organization_id unless the caller is a platform admin
// (future — for now any admin can edit their own org).

const express = require('express');
const { toFile } = require('@anthropic-ai/sdk');
const { pool, listOrganizations, getOrgById } = require('../db');
const { requireAuth, requireCapability, requireOrg, requireSystemAdmin } = require('../auth');

const router = express.Router();

// Anthropic client (lazy — same pattern as ai-routes.js).
let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk').Anthropic;
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// Build a SKILL.md body for a pack. Mirrors buildSkillMarkdownForMirror
// in ai-routes.js so admin-button mirrors produce byte-identical
// uploads to CoS-driven ones (legacy code path).
function slugifyPackName(s) {
  return String(s || 'skill')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
}

function buildPackSkillMd(pack) {
  const slug = slugifyPackName(pack.name);
  const desc = String(pack.description || pack.name || 'skill pack').replace(/[\r\n]/g, ' ');
  return [
    '---',
    'name: ' + slug,
    'description: ' + desc,
    '---',
    '',
    pack.body || ''
  ].join('\n');
}

// Upload a pack as a new Anthropic native Skill. Throws on failure;
// caller is responsible for rolling back any local DB state if the
// mirror doesn't land. We never want a local-only pack to exist.
async function uploadPackAsNewSkill(anthropic, pack) {
  const md = buildPackSkillMd(pack);
  const slug = slugifyPackName(pack.name);
  const file = await toFile(Buffer.from(md, 'utf8'), 'SKILL.md', { type: 'text/markdown' });
  return anthropic.beta.skills.create({
    display_title: String(pack.name || 'Project 86 skill').slice(0, 200),
    files: [file]
  });
}

// Upload a new version of an existing Anthropic Skill. Used on pack
// edits so the skill_id stays stable (registered agents keep working)
// while the content rolls forward to the latest version.
async function uploadPackAsNewVersion(anthropic, skillId, pack) {
  const md = buildPackSkillMd(pack);
  const slug = slugifyPackName(pack.name);
  const file = await toFile(Buffer.from(md, 'utf8'), 'SKILL.md', { type: 'text/markdown' });
  return anthropic.beta.skills.versions.create(skillId, {
    files: [file]
  });
}

// Helper: confirm the caller is allowed to act on the requested
// organization id. Today: must match their own org (no cross-org
// access yet — when platform-admin role lands, that role can pass
// any id).
function assertOrgScope(req, requestedId) {
  const own = req.organization && req.organization.id;
  const requested = Number(requestedId);
  if (!own || !Number.isFinite(requested)) {
    const err = new Error('Organization scope required.');
    err.status = 403;
    throw err;
  }
  if (own !== requested) {
    const err = new Error('Cross-organization access denied. You can only edit your own organization.');
    err.status = 403;
    throw err;
  }
  return requested;
}

// GET /api/admin/organizations — list all active orgs.
// SYSTEM_ADMIN only — org admins can't see other tenants.
router.get('/', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const orgs = await listOrganizations();
    res.json({ organizations: orgs });
  } catch (e) {
    console.error('GET /api/admin/organizations error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// POST /api/admin/organizations — create a new tenant.
// SYSTEM_ADMIN only. Body: { slug, name, description?, identity_body? }
router.post('/', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const slug = String(b.slug || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const name = String(b.name || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug is required (lowercase letters, digits, _ or -)' });
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      const r = await pool.query(
        `INSERT INTO organizations (slug, name, description, identity_body)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [slug, name, b.description || '', b.identity_body || '']
      );
      res.json({ organization: r.rows[0] });
    } catch (e) {
      if (e && e.code === '23505') {
        return res.status(409).json({ error: 'An organization with slug "' + slug + '" already exists.' });
      }
      throw e;
    }
  } catch (e) {
    console.error('POST /api/admin/organizations error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// DELETE /api/admin/organizations/:id — soft-archive.
// SYSTEM_ADMIN only. Sets archived_at; data stays for audit.
router.delete('/:id', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid org id' });
    const r = await pool.query(
      `UPDATE organizations SET archived_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND archived_at IS NULL
        RETURNING id, slug, name`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Organization not found or already archived' });
    res.json({ ok: true, organization: r.rows[0] });
  } catch (e) {
    console.error('DELETE /api/admin/organizations/:id error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// GET /api/admin/organizations/me — the caller's own org row.
// Read-only convenience for the admin UI on first load.
router.get('/me', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), (req, res) => {
  res.json({ organization: req.organization });
});

// PUT /api/admin/organizations/:id — update name / description /
// identity_body / settings. Returns the updated row. The admin UI
// is expected to re-trigger a managed-agent sync after a successful
// update so the new identity_body lands on Anthropic.
router.put('/:id', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const targetId = assertOrgScope(req, req.params.id);
    const updates = [];
    const params = [targetId];
    let p = 2;
    if (typeof req.body.name === 'string') {
      const trimmed = req.body.name.trim();
      if (!trimmed) return res.status(400).json({ error: 'name cannot be empty' });
      if (trimmed.length > 200) return res.status(400).json({ error: 'name max 200 chars' });
      updates.push('name = $' + p++);
      params.push(trimmed);
    }
    if (typeof req.body.description === 'string') {
      updates.push('description = $' + p++);
      params.push(req.body.description);
    }
    if (typeof req.body.identity_body === 'string') {
      updates.push('identity_body = $' + p++);
      params.push(req.body.identity_body);
    }
    if (req.body.settings && typeof req.body.settings === 'object') {
      updates.push('settings = $' + p++ + '::jsonb');
      params.push(JSON.stringify(req.body.settings));
    }
    if (!updates.length) {
      return res.status(400).json({ error: 'No editable fields supplied. Accepts: name, description, identity_body, settings.' });
    }
    updates.push('updated_at = NOW()');
    const r = await pool.query(
      `UPDATE organizations SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Organization not found' });
    res.json({ organization: r.rows[0], note: 'Sync the managed agent (Admin → Agents → Sync) so the updated identity_body reaches Anthropic.' });
  } catch (e) {
    const status = e.status || 500;
    console.error('PUT /api/admin/organizations/:id error:', e);
    res.status(status).json({ error: e.message || 'Server error' });
  }
});

// GET /api/admin/organizations/:id/skill-packs — list packs.
// Filters out archived_at rows. Returns full bodies so the admin UI
// can render the editor without a separate fetch per pack.
router.get('/:id/skill-packs', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const targetId = assertOrgScope(req, req.params.id);
    const r = await pool.query(
      `SELECT id, name, body, description, agents, category, triggers,
              anthropic_skill_id, created_at, updated_at
         FROM org_skill_packs
        WHERE organization_id = $1 AND archived_at IS NULL
        ORDER BY id ASC`,
      [targetId]
    );
    res.json({ skill_packs: r.rows });
  } catch (e) {
    const status = e.status || 500;
    console.error('GET /api/admin/organizations/:id/skill-packs error:', e);
    res.status(status).json({ error: e.message || 'Server error' });
  }
});

const VALID_PACK_AGENTS = ['job']; // post-unification, only 'job' targets a real agent

// POST /api/admin/organizations/:id/skill-packs — create a pack.
// Body: { name, body, description?, agents?, category?, triggers? }
// (The `contexts` field was retired with the native-skills migration
//  and the column dropped — 86 reasons over each pack's description
//  on every turn instead of using a surface filter.)
router.post('/:id/skill-packs', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const targetId = assertOrgScope(req, req.params.id);
    const b = req.body || {};
    if (!b.name || typeof b.name !== 'string' || !b.name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!b.body || typeof b.body !== 'string') {
      return res.status(400).json({ error: 'body is required' });
    }
    const agents = Array.isArray(b.agents) && b.agents.length ? b.agents : ['job'];
    const badAgents = agents.filter(a => !VALID_PACK_AGENTS.includes(a) && a !== 'cra'); // 'cra' tolerated as legacy
    if (badAgents.length) {
      return res.status(400).json({ error: 'Unknown agent(s): ' + badAgents.join(', ') + '. Valid: ' + VALID_PACK_AGENTS.join(', ') });
    }
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set. Cannot create pack — all packs must be mirrored to Anthropic native Skills.' });
    let insertedId = null;
    try {
      const ins = await pool.query(
        `INSERT INTO org_skill_packs (
            organization_id, name, body, description, agents, category, triggers
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
         RETURNING *`,
        [
          targetId,
          b.name.trim(),
          b.body,
          (typeof b.description === 'string') ? b.description : '',
          JSON.stringify(agents),
          (typeof b.category === 'string' && b.category) ? b.category : null,
          JSON.stringify((b.triggers && typeof b.triggers === 'object') ? b.triggers : {})
        ]
      );
      const pack = ins.rows[0];
      insertedId = pack.id;
      const created = await uploadPackAsNewSkill(anthropic, pack);
      const upd = await pool.query(
        `UPDATE org_skill_packs SET anthropic_skill_id = $1, updated_at = NOW()
           WHERE id = $2 RETURNING *`,
        [created.id, pack.id]
      );
      res.json({ skill_pack: upd.rows[0] });
    } catch (e) {
      // Roll back the local insert so no local-only pack survives.
      // Hard-delete (not soft) because the row never went live —
      // it shouldn't reappear in archived listings.
      if (insertedId) {
        try { await pool.query(`DELETE FROM org_skill_packs WHERE id = $1`, [insertedId]); }
        catch (rollbackErr) { console.error('[skill-pack create rollback] failed:', rollbackErr); }
      }
      if (e && e.code === '23505') {
        return res.status(409).json({ error: 'A skill pack named "' + b.name + '" already exists in this organization.' });
      }
      throw e;
    }
  } catch (e) {
    const status = e.status || 500;
    console.error('POST /api/admin/organizations/:id/skill-packs error:', e);
    res.status(status).json({ error: e.message || 'Server error' });
  }
});

// PUT /api/admin/organizations/:id/skill-packs/:packId — update pack.
router.put('/:id/skill-packs/:packId', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const targetId = assertOrgScope(req, req.params.id);
    const packId = Number(req.params.packId);
    if (!Number.isFinite(packId)) return res.status(400).json({ error: 'Invalid packId' });
    const b = req.body || {};
    const updates = [];
    const params = [targetId, packId];
    let p = 3;
    if (typeof b.name === 'string') {
      const trimmed = b.name.trim();
      if (!trimmed) return res.status(400).json({ error: 'name cannot be empty' });
      updates.push('name = $' + p++);
      params.push(trimmed);
    }
    if (typeof b.body === 'string') {
      updates.push('body = $' + p++);
      params.push(b.body);
    }
    if (typeof b.description === 'string') {
      updates.push('description = $' + p++);
      params.push(b.description);
    }
    if (Array.isArray(b.agents) && b.agents.length) {
      updates.push('agents = $' + p++ + '::jsonb');
      params.push(JSON.stringify(b.agents));
    }
    // (`contexts` field retired with the native-skills migration; column dropped.)
    if (typeof b.category === 'string') {
      updates.push('category = $' + p++);
      params.push(b.category || null);
    }
    if (b.triggers && typeof b.triggers === 'object') {
      updates.push('triggers = $' + p++ + '::jsonb');
      params.push(JSON.stringify(b.triggers));
    }
    if (!updates.length) return res.status(400).json({ error: 'No editable fields supplied' });
    updates.push('updated_at = NOW()');

    // Snapshot the pre-edit row so we can re-mirror with the new
    // content and detect what actually changed.
    const before = await pool.query(
      `SELECT * FROM org_skill_packs WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
      [targetId, packId]
    );
    if (!before.rows.length) return res.status(404).json({ error: 'Pack not found' });
    const prev = before.rows[0];

    const contentChanged = (typeof b.body === 'string' && b.body !== prev.body)
      || (typeof b.name === 'string' && b.name.trim() !== prev.name)
      || (typeof b.description === 'string' && b.description !== prev.description);

    try {
      const r = await pool.query(
        `UPDATE org_skill_packs SET ${updates.join(', ')}
          WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL
          RETURNING *`,
        params
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Pack not found' });
      const updated = r.rows[0];

      // Re-mirror to Anthropic if the SKILL.md content changed.
      // Try versions.create first (preserves the stable skill_id so
      // the agent doesn't need to be re-registered). If that fails
      // for any reason, fall back to delete-and-recreate: drop the
      // old Anthropic skill, mint a fresh one with the new content,
      // and update our local pointer. The agent picks up the new id
      // on next sync. Failing both paths rolls the local edit back.
      if (contentChanged && updated.anthropic_skill_id) {
        const anthropic = getAnthropic();
        if (!anthropic) {
          await pool.query(
            `UPDATE org_skill_packs SET name = $1, body = $2, description = $3, updated_at = NOW()
               WHERE id = $4`,
            [prev.name, prev.body, prev.description, packId]
          );
          return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set. Edit rolled back — packs must stay in sync with Anthropic.' });
        }
        let mirrored = false;
        let versionsErr = null;
        try {
          await uploadPackAsNewVersion(anthropic, updated.anthropic_skill_id, updated);
          mirrored = true;
        } catch (e) {
          versionsErr = e;
          console.warn('[skill-pack edit] versions.create failed, attempting delete+recreate fallback:', e.message);
        }
        if (!mirrored) {
          // Fallback: delete the existing skill upstream, create a
          // fresh one with the new content, repoint anthropic_skill_id.
          // The next agent sync picks up the new id (collectSkillsFor
          // reads from org_skill_packs.anthropic_skill_id).
          const oldSkillId = updated.anthropic_skill_id;
          try {
            try { await anthropic.beta.skills.delete(oldSkillId); }
            catch (delErr) {
              // 404 means it was already gone — fine, proceed to create.
              if (!/404|not.?found/i.test(String(delErr.message || ''))) throw delErr;
            }
            const created = await uploadPackAsNewSkill(anthropic, updated);
            await pool.query(
              `UPDATE org_skill_packs SET anthropic_skill_id = $1 WHERE id = $2`,
              [created.id, packId]
            );
            updated.anthropic_skill_id = created.id;
            mirrored = true;
          } catch (fallbackErr) {
            console.error('[skill-pack edit] fallback delete+recreate failed:', fallbackErr);
            await pool.query(
              `UPDATE org_skill_packs SET name = $1, body = $2, description = $3, updated_at = NOW()
                 WHERE id = $4`,
              [prev.name, prev.body, prev.description, packId]
            );
            return res.status(502).json({
              error: 'Failed to mirror edit to Anthropic. Versions: ' + (versionsErr && versionsErr.message || '?') +
                     '. Fallback: ' + (fallbackErr.message || '?') + '. Local edit rolled back.'
            });
          }
        }
      } else if (contentChanged && !updated.anthropic_skill_id) {
        // Pack exists locally but never mirrored (shouldn't happen
        // post-migration). Try to mirror as a fresh skill.
        const anthropic = getAnthropic();
        if (anthropic) {
          try {
            const created = await uploadPackAsNewSkill(anthropic, updated);
            await pool.query(
              `UPDATE org_skill_packs SET anthropic_skill_id = $1 WHERE id = $2`,
              [created.id, packId]
            );
            updated.anthropic_skill_id = created.id;
          } catch (mirrorErr) {
            console.error('[skill-pack edit] late-mirror failed:', mirrorErr);
            return res.status(502).json({ error: 'Failed to mirror pack to Anthropic: ' + (mirrorErr.message || 'unknown') });
          }
        }
      }
      res.json({ skill_pack: updated });
    } catch (e) {
      if (e && e.code === '23505') {
        return res.status(409).json({ error: 'A skill pack with that name already exists in this organization.' });
      }
      throw e;
    }
  } catch (e) {
    const status = e.status || 500;
    console.error('PUT /api/admin/organizations/:id/skill-packs/:packId error:', e);
    res.status(status).json({ error: e.message || 'Server error' });
  }
});

// DELETE /api/admin/organizations/:id/skill-packs/:packId — soft delete.
router.delete('/:id/skill-packs/:packId', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const targetId = assertOrgScope(req, req.params.id);
    const packId = Number(req.params.packId);
    if (!Number.isFinite(packId)) return res.status(400).json({ error: 'Invalid packId' });

    // Snapshot first so we know the Anthropic skill_id to clean up.
    const snap = await pool.query(
      `SELECT id, name, anthropic_skill_id FROM org_skill_packs
        WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
      [targetId, packId]
    );
    if (!snap.rows.length) return res.status(404).json({ error: 'Pack not found' });
    const pack = snap.rows[0];

    // Delete the Anthropic-side mirror first. If it fails (e.g.
    // already deleted upstream), proceed with local soft-delete
    // rather than leaving an orphaned local pack.
    if (pack.anthropic_skill_id) {
      const anthropic = getAnthropic();
      if (anthropic) {
        try {
          await anthropic.beta.skills.delete(pack.anthropic_skill_id);
        } catch (delErr) {
          console.warn('[skill-pack delete] Anthropic-side delete failed (continuing local delete):', delErr.message || delErr);
        }
      }
    }

    const r = await pool.query(
      `UPDATE org_skill_packs SET archived_at = NOW(), anthropic_skill_id = NULL
        WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL
        RETURNING id, name`,
      [targetId, packId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pack not found' });
    res.json({ ok: true, id: r.rows[0].id, name: r.rows[0].name });
  } catch (e) {
    const status = e.status || 500;
    console.error('DELETE /api/admin/organizations/:id/skill-packs/:packId error:', e);
    res.status(status).json({ error: e.message || 'Server error' });
  }
});

// ─── Phase 6: MCP connector CRUD ──────────────────────────────────────
//
// Per-tenant MCP server configuration. Each org points 86 at zero or
// more MCP servers (Gmail, Calendar, QuickBooks, Slack, etc.). On
// agent registration / sync, the active servers are passed to the
// Anthropic managed agent so the model can call MCP tools natively.
//
// authorization_token is returned masked on GET (only the last 4
// chars surface) so a system admin can verify "is this set?" without
// the panel leaking the bearer.

function maskToken(t) {
  if (!t) return null;
  const s = String(t);
  if (s.length <= 4) return '****';
  return '****' + s.slice(-4);
}

router.get('/:id/mcp-servers',
  requireAuth, requireCapability('ROLES_MANAGE'), requireOrg,
  async (req, res) => {
    try {
      const targetId = assertOrgScope(req, req.params.id);
      const r = await pool.query(
        `SELECT id, name, url, description, enabled, authorization_token,
                created_at, updated_at, archived_at
           FROM org_mcp_servers
          WHERE organization_id = $1 AND archived_at IS NULL
          ORDER BY name ASC`,
        [targetId]
      );
      const rows = r.rows.map(row => ({
        id: row.id,
        name: row.name,
        url: row.url,
        description: row.description,
        enabled: row.enabled,
        authorization_token_masked: maskToken(row.authorization_token),
        has_token: !!row.authorization_token,
        created_at: row.created_at,
        updated_at: row.updated_at
      }));
      res.json({ servers: rows });
    } catch (e) {
      const status = e.status || 500;
      console.error('GET /:id/mcp-servers error:', e);
      res.status(status).json({ error: e.message || 'Server error' });
    }
});

router.post('/:id/mcp-servers',
  requireAuth, requireCapability('ROLES_MANAGE'), requireOrg,
  async (req, res) => {
    try {
      const targetId = assertOrgScope(req, req.params.id);
      const body = req.body || {};
      const name = String(body.name || '').trim();
      const url = String(body.url || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (!url) return res.status(400).json({ error: 'url is required' });
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url must start with http(s)://' });
      const token = body.authorization_token ? String(body.authorization_token) : null;
      const description = body.description ? String(body.description).slice(0, 500) : null;
      const enabled = body.enabled !== false;
      const id = 'mcp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      try {
        await pool.query(
          `INSERT INTO org_mcp_servers (id, organization_id, name, url, authorization_token, description, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, targetId, name.slice(0, 100), url, token, description, enabled]
        );
      } catch (e) {
        if (e && e.code === '23505') return res.status(409).json({ error: 'An MCP server named "' + name + '" already exists for this org.' });
        throw e;
      }
      res.json({ ok: true, id, name, url });
    } catch (e) {
      const status = e.status || 500;
      console.error('POST /:id/mcp-servers error:', e);
      res.status(status).json({ error: e.message || 'Server error' });
    }
});

router.put('/:id/mcp-servers/:serverId',
  requireAuth, requireCapability('ROLES_MANAGE'), requireOrg,
  async (req, res) => {
    try {
      const targetId = assertOrgScope(req, req.params.id);
      const body = req.body || {};
      const updates = [];
      const params = [targetId, req.params.serverId];
      let p = 3;
      if (typeof body.name === 'string') { updates.push('name = $' + p); params.push(body.name.slice(0, 100)); p++; }
      if (typeof body.url === 'string') {
        if (!/^https?:\/\//i.test(body.url)) return res.status(400).json({ error: 'url must start with http(s)://' });
        updates.push('url = $' + p); params.push(body.url); p++;
      }
      if (typeof body.description === 'string') { updates.push('description = $' + p); params.push(body.description.slice(0, 500)); p++; }
      if (typeof body.enabled === 'boolean') { updates.push('enabled = $' + p); params.push(body.enabled); p++; }
      // authorization_token: explicit null = clear; string = set; missing = no change.
      if ('authorization_token' in body) {
        updates.push('authorization_token = $' + p);
        params.push(body.authorization_token === null ? null : String(body.authorization_token));
        p++;
      }
      if (!updates.length) return res.status(400).json({ error: 'No fields to update.' });
      updates.push('updated_at = NOW()');
      const r = await pool.query(
        `UPDATE org_mcp_servers SET ${updates.join(', ')}
          WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL
        RETURNING id, name`,
        params
      );
      if (!r.rows.length) return res.status(404).json({ error: 'MCP server not found' });
      res.json({ ok: true, id: r.rows[0].id, name: r.rows[0].name });
    } catch (e) {
      if (e && e.code === '23505') return res.status(409).json({ error: 'A server with that name already exists for this org.' });
      const status = e.status || 500;
      console.error('PUT /:id/mcp-servers/:serverId error:', e);
      res.status(status).json({ error: e.message || 'Server error' });
    }
});

router.delete('/:id/mcp-servers/:serverId',
  requireAuth, requireCapability('ROLES_MANAGE'), requireOrg,
  async (req, res) => {
    try {
      const targetId = assertOrgScope(req, req.params.id);
      const r = await pool.query(
        `UPDATE org_mcp_servers SET archived_at = NOW(), enabled = false, updated_at = NOW()
          WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL
        RETURNING id, name`,
        [targetId, req.params.serverId]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'MCP server not found' });
      res.json({ ok: true, id: r.rows[0].id, name: r.rows[0].name });
    } catch (e) {
      const status = e.status || 500;
      console.error('DELETE /:id/mcp-servers/:serverId error:', e);
      res.status(status).json({ error: e.message || 'Server error' });
    }
});

// ─── Bulk-mirror unmirrored skill packs to Anthropic native Skills ───
//
// The whole point of mirroring is to move pack bodies OUT of the
// per-turn dynamic context (where they bloat token usage and require a
// load_skill_pack round-trip when needed) and INTO the agent's
// registered skills (where Anthropic auto-discovers them based on
// each skill's description). After this fires, collectSkillsFor()
// includes the org's mirrored packs in the next agent sync.
//
// Idempotent: only mirrors packs where anthropic_skill_id IS NULL.
// Errors on individual packs don't stop the batch — they're reported
// in the response so the admin can retry the failed ones.
router.post('/:id/skill-packs/mirror-all',
  requireAuth, requireCapability('ROLES_MANAGE'), requireOrg,
  async (req, res) => {
    try {
      const targetId = assertOrgScope(req, req.params.id);
      const anthropic = getAnthropic();
      if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this deployment.' });

      const r = await pool.query(
        `SELECT id, name, description, body
           FROM org_skill_packs
          WHERE organization_id = $1
            AND anthropic_skill_id IS NULL
            AND archived_at IS NULL
          ORDER BY created_at ASC`,
        [targetId]
      );
      const packs = r.rows;

      const results = [];
      for (const pack of packs) {
        try {
          const md = buildPackSkillMd(pack);
          const slug = slugifyPackName(pack.name);
          const file = await toFile(Buffer.from(md, 'utf8'), 'SKILL.md', { type: 'text/markdown' });
          const created = await anthropic.beta.skills.create({
            display_title: String(pack.name || 'Project 86 skill').slice(0, 200),
            files: [file]
          });
          await pool.query(
            `UPDATE org_skill_packs
                SET anthropic_skill_id = $1, updated_at = NOW()
              WHERE id = $2`,
            [created.id, pack.id]
          );
          results.push({ pack: pack.name, ok: true, anthropic_skill_id: created.id });
        } catch (e) {
          console.error('[mirror-all] failed for pack', pack.name, e && e.message);
          results.push({ pack: pack.name, ok: false, error: e && e.message ? e.message : 'unknown' });
        }
      }

      const succeeded = results.filter(x => x.ok).length;
      const failed = results.filter(x => !x.ok).length;
      res.json({
        ok: true,
        total: packs.length,
        succeeded,
        failed,
        results,
        note: succeeded > 0
          ? 'Mirrored ' + succeeded + ' pack(s). Run /managed/job/sync next so the agent picks up the new native skills.'
          : 'No packs needed mirroring.'
      });
    } catch (e) {
      const status = e.status || 500;
      console.error('POST /:id/skill-packs/mirror-all error:', e);
      res.status(status).json({ error: e.message || 'Server error' });
    }
});

module.exports = router;
