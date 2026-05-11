// Field Tools — self-contained HTML utilities the team uses on phones
// in the field (calculators, lookups, simple forms). 86 can spin them
// up on demand via propose_create_field_tool; the admin can also paste
// HTML directly via the Tools tab.
//
// Each tool is a single document — <!doctype html>...</html> with
// inline <style> and <script>. The frontend renders them in a
// sandboxed iframe (sandbox="allow-scripts") so arbitrary JS in a
// tool can't reach the parent app's DOM, cookies, or localStorage.
//
// Endpoints:
//   GET    /api/field-tools           list (no html_body — quick)
//   GET    /api/field-tools/:id       full record incl. html_body
//   POST   /api/field-tools           create
//   PUT    /api/field-tools/:id       update (partial — only sent
//                                     fields change)
//   DELETE /api/field-tools/:id       delete

const express = require('express');
const { requireAuth } = require('../auth');
const { pool } = require('../db');

const router = express.Router();

console.log('[field-tools-routes] mounted at /api/field-tools');

const VALID_CATEGORIES = ['calculator', 'lookup', 'form', 'other'];

function newId() {
  return 'ft_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function isValidCategory(c) {
  return !c || VALID_CATEGORIES.includes(c);
}

// GET /api/field-tools
// Returns the index without html_body (rows can be ~5-10KB each, no
// reason to ship them all on the list call). The detail GET pulls
// the body when the user opens a specific tool.
router.get('/', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, description, category, created_by, created_at, updated_at,
              LENGTH(html_body) AS html_size
         FROM field_tools
        ORDER BY updated_at DESC`
    );
    res.json({ tools: r.rows });
  } catch (e) {
    console.error('GET /api/field-tools error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/field-tools/:id — full record incl. html_body.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    const r = await pool.query(`SELECT * FROM field_tools WHERE id = $1`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ tool: r.rows[0] });
  } catch (e) {
    console.error('GET /api/field-tools/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/field-tools — create.
// Body: { name, description?, category?, html_body }
router.post('/', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const description = body.description != null ? String(body.description).trim() : null;
    const category = body.category != null ? String(body.category).trim() : null;
    const htmlBody = String(body.html_body || '').trim();

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!htmlBody) return res.status(400).json({ error: 'html_body is required' });
    if (!isValidCategory(category)) {
      return res.status(400).json({ error: 'category must be one of: ' + VALID_CATEGORIES.join(', ') });
    }
    // Soft size cap — anything over 500KB is almost certainly an
    // attempt to paste a multi-page doc or external assets. The
    // frontend iframe doesn't need that much; reject up front so we
    // don't bloat the DB.
    if (htmlBody.length > 500 * 1024) {
      return res.status(400).json({ error: 'html_body exceeds 500KB — keep field tools small.' });
    }

    const id = newId();
    try {
      const r = await pool.query(
        `INSERT INTO field_tools (id, name, description, category, html_body, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         RETURNING *`,
        [id, name, description, category, htmlBody, req.user.id]
      );
      res.json({ tool: r.rows[0] });
    } catch (e) {
      // Unique violation on name
      if (e.code === '23505') {
        return res.status(409).json({ error: 'A tool named "' + name + '" already exists.' });
      }
      throw e;
    }
  } catch (e) {
    console.error('POST /api/field-tools error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/field-tools/:id — partial update.
// Body: { name?, description?, category?, html_body? }
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    const body = req.body || {};

    // Only update fields the caller actually sent. Build dynamic SET.
    const sets = [];
    const params = [];
    let p = 1;
    if (typeof body.name === 'string') {
      sets.push(`name = $${p++}`);
      params.push(body.name.trim());
    }
    if (body.description !== undefined) {
      sets.push(`description = $${p++}`);
      params.push(body.description != null ? String(body.description).trim() : null);
    }
    if (body.category !== undefined) {
      const c = body.category != null ? String(body.category).trim() : null;
      if (!isValidCategory(c)) {
        return res.status(400).json({ error: 'category must be one of: ' + VALID_CATEGORIES.join(', ') });
      }
      sets.push(`category = $${p++}`);
      params.push(c);
    }
    if (typeof body.html_body === 'string') {
      if (body.html_body.length > 500 * 1024) {
        return res.status(400).json({ error: 'html_body exceeds 500KB.' });
      }
      sets.push(`html_body = $${p++}`);
      params.push(body.html_body);
    }
    if (!sets.length) {
      return res.status(400).json({ error: 'No fields to update.' });
    }
    sets.push(`updated_at = NOW()`);
    params.push(id);

    try {
      const r = await pool.query(
        `UPDATE field_tools SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
        params
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ tool: r.rows[0] });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ error: 'A tool with that name already exists.' });
      }
      throw e;
    }
  } catch (e) {
    console.error('PUT /api/field-tools/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/field-tools/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    const r = await pool.query(`DELETE FROM field_tools WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (e) {
    console.error('DELETE /api/field-tools/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
