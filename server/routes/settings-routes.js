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

router.put('/:key', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const value = req.body && req.body.value;
    if (value == null) return res.status(400).json({ error: 'value is required' });
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
