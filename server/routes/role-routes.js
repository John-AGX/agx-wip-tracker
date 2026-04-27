const express = require('express');
const { pool } = require('../db');
const {
  requireAuth, requireRole, CAPABILITY_KEYS,
  refreshRoleCache, requireCapability
} = require('../auth');

const router = express.Router();

// GET /api/roles/capabilities — list all capability keys + display metadata.
// Available to any authenticated user so the admin Roles UI can render the
// checkbox list. The keys themselves are not sensitive.
router.get('/capabilities', requireAuth, (req, res) => {
  res.json({ capabilities: CAPABILITY_KEYS });
});

// GET /api/roles — list all roles (any authenticated user; useful for the
// "New User" role dropdown). Capability arrays come back too so the admin
// Roles UI can render them inline.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, label, description, builtin, capabilities, created_at, updated_at FROM roles ORDER BY builtin DESC, label'
    );
    res.json({ roles: rows });
  } catch (e) {
    console.error('GET /api/roles error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/roles — create a custom role (admin only).
// builtin always set to false; you can't create a builtin from outside the
// db.js seed code.
router.post('/', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const { name, label, description, capabilities } = req.body || {};
    if (!name || !label) return res.status(400).json({ error: 'name and label are required' });
    if (!/^[a-z0-9_]+$/.test(name)) {
      return res.status(400).json({ error: 'name must be lowercase letters, digits, and underscores' });
    }
    const validCaps = new Set(CAPABILITY_KEYS.map(c => c.key));
    const caps = Array.isArray(capabilities)
      ? capabilities.filter(c => validCaps.has(c))
      : [];
    await pool.query(
      `INSERT INTO roles (name, label, description, builtin, capabilities)
       VALUES ($1, $2, $3, false, $4::jsonb)`,
      [name, label, description || null, JSON.stringify(caps)]
    );
    await refreshRoleCache();
    res.json({ ok: true, name });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A role with that name already exists.' });
    }
    console.error('POST /api/roles error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/roles/:name — update a role's label, description, or capabilities.
// Builtin roles can have all three edited (so admins can tweak which caps a
// PM has, for example), but the name + builtin flag stay locked.
router.put('/:name', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT builtin FROM roles WHERE name = $1', [req.params.name]);
    if (!rows.length) return res.status(404).json({ error: 'Role not found' });

    const { label, description, capabilities } = req.body || {};
    const validCaps = new Set(CAPABILITY_KEYS.map(c => c.key));
    const caps = Array.isArray(capabilities)
      ? capabilities.filter(c => validCaps.has(c))
      : null;

    const sets = [];
    const params = [];
    let p = 1;
    if (label != null)       { sets.push('label = $' + p++); params.push(label); }
    if (description != null) { sets.push('description = $' + p++); params.push(description); }
    if (caps != null)        { sets.push('capabilities = $' + p++ + '::jsonb'); params.push(JSON.stringify(caps)); }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    sets.push('updated_at = NOW()');
    params.push(req.params.name);
    await pool.query(
      `UPDATE roles SET ${sets.join(', ')} WHERE name = $${p}`,
      params
    );
    await refreshRoleCache();
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/roles/:name error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/roles/:name — only custom (non-builtin) roles. Refuses if any
// user is currently assigned that role; admin should reassign first.
router.delete('/:name', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT builtin FROM roles WHERE name = $1', [req.params.name]);
    if (!rows.length) return res.status(404).json({ error: 'Role not found' });
    if (rows[0].builtin) {
      return res.status(400).json({ error: 'Built-in roles cannot be deleted.' });
    }
    const usage = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE role = $1', [req.params.name]);
    if (usage.rows[0].c > 0) {
      return res.status(409).json({
        error: 'Cannot delete: ' + usage.rows[0].c + ' user(s) are still assigned this role. Reassign them first.'
      });
    }
    await pool.query('DELETE FROM roles WHERE name = $1', [req.params.name]);
    await refreshRoleCache();
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/roles/:name error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
