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
const { requireAuth, requireOrg, requireCapability } = require('../auth');
const { pool } = require('../db');
const catalog = require('../field-tool-catalog');

const router = express.Router();

console.log('[field-tools-routes] mounted at /api/field-tools');

const VALID_CATEGORIES = ['calculator', 'lookup', 'form', 'other'];

function newId() {
  return 'ft_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// The caller's organization (field tools are per-org). NULL-org legacy
// tools stay visible to everyone until backfilled.
function callerOrg(req) {
  return (req.user && req.user.organization_id) ? Number(req.user.organization_id) : null;
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
    const org = callerOrg(req);
    const r = await pool.query(
      `SELECT id, name, description, category, created_by, created_at, updated_at,
              is_system, system_key, LENGTH(html_body) AS html_size
         FROM field_tools
        WHERE organization_id = $1 OR organization_id IS NULL
        ORDER BY is_system DESC, updated_at DESC`,
      [org]
    );
    res.json({ tools: r.rows });
  } catch (e) {
    console.error('GET /api/field-tools error:', e);
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
        `INSERT INTO field_tools (id, name, description, category, html_body, created_by, organization_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING *`,
        [id, name, description, category, htmlBody, req.user.id, callerOrg(req)]
      );
      res.json({ tool: r.rows[0] });
    } catch (e) {
      // Unique violation on (organization_id, name)
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

// ──────────────────────────────────────────────────────────────────
// PRINTOUTS — field_tool_runs CRUD
//
// One row per saved tool run. Captures inputs/outputs the tool
// posted via window.parent.postMessage({type:'p86-field-tool-result',
// inputs, outputs}) at the moment the user clicked Save Printout in
// the modal chrome. Surfaces under My Files → Printouts and renders
// receipt-style on print.
//
//   GET    /api/field-tools/runs              — list (filtered by caller's user_id; ?tool_id= optional)
//   GET    /api/field-tools/runs/:id          — single printout for the receipt view
//   POST   /api/field-tools/runs              — save a new printout
//   PATCH  /api/field-tools/runs/:id          — edit notes (only the author)
//   DELETE /api/field-tools/runs/:id          — remove (only the author)
//
// IMPORTANT: These routes MUST be declared BEFORE the /:id routes —
// otherwise Express matches `GET /runs` as `GET /:id` with id="runs"
// (routes match in declaration order).
// ──────────────────────────────────────────────────────────────────

function newRunId() {
  return 'ftrun_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// ──────────────────────────────────────────────────────────────────
// DRAFTS — per-user, per-tool input autosave. Distinct from /runs:
//   /runs   = explicit named printouts (the user clicked Save Printout)
//   /drafts = the in-progress input state, overwritten on every keystroke
//             (debounced from the iframe's auto-instrumenter)
// ONE row per (user, tool); a UPSERT replaces the previous draft.
//
// Mounted BEFORE /:id below so Express doesn't match `GET /drafts/:id`
// as `GET /:id` with id="drafts".
// ──────────────────────────────────────────────────────────────────

// GET /api/field-tools/drafts/:fieldToolId — load this user's current
// draft for a tool, or 404 when none exists. Hits on every modal open.
router.get('/drafts/:fieldToolId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const toolId = String(req.params.fieldToolId || '').trim();
    if (!toolId) return res.status(400).json({ error: 'fieldToolId required' });
    const rows = (await pool.query(
      `SELECT field_tool_id, user_id, inputs, outputs, updated_at
         FROM field_tool_drafts
        WHERE field_tool_id = $1 AND user_id = $2`,
      [toolId, userId]
    )).rows;
    if (!rows.length) return res.status(404).json({ error: 'no draft' });
    res.json({ draft: rows[0] });
  } catch (e) {
    console.error('GET /api/field-tools/drafts/:fieldToolId error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/field-tools/drafts/:fieldToolId — UPSERT this user's draft.
// Body: { inputs, outputs }. Both are JSONB blobs (objects); empty is
// allowed. The client debounces calls (~250ms) so this is a low-volume
// write endpoint despite firing on input/change events in the iframe.
router.put('/drafts/:fieldToolId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const toolId = String(req.params.fieldToolId || '').trim();
    if (!toolId) return res.status(400).json({ error: 'fieldToolId required' });
    // Verify the tool exists so we don't anchor orphan drafts.
    const toolChk = await pool.query('SELECT id FROM field_tools WHERE id = $1', [toolId]);
    if (!toolChk.rows.length) return res.status(404).json({ error: 'tool not found' });
    const body = req.body || {};
    const inputs  = (body.inputs  && typeof body.inputs  === 'object') ? body.inputs  : {};
    const outputs = (body.outputs && typeof body.outputs === 'object') ? body.outputs : {};
    await pool.query(
      `INSERT INTO field_tool_drafts (field_tool_id, user_id, inputs, outputs, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW())
       ON CONFLICT (field_tool_id, user_id)
       DO UPDATE SET inputs = EXCLUDED.inputs, outputs = EXCLUDED.outputs, updated_at = NOW()`,
      [toolId, userId, JSON.stringify(inputs), JSON.stringify(outputs)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/field-tools/drafts/:fieldToolId error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/field-tools/drafts/:fieldToolId — clear the user's draft
// (e.g. after they save a printout, or hit "start fresh").
router.delete('/drafts/:fieldToolId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const toolId = String(req.params.fieldToolId || '').trim();
    if (!toolId) return res.status(400).json({ error: 'fieldToolId required' });
    await pool.query(
      'DELETE FROM field_tool_drafts WHERE field_tool_id = $1 AND user_id = $2',
      [toolId, userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/field-tools/drafts/:fieldToolId error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/field-tools/runs
// Query params: ?tool_id=ftxxx (optional), ?limit=N (default 100, max 500).
router.get('/runs', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const toolId = req.query.tool_id ? String(req.query.tool_id) : null;
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

    const params = [userId];
    let where = 'r.user_id = $1';
    if (toolId) {
      params.push(toolId);
      where += ` AND r.field_tool_id = $${params.length}`;
    }
    const rows = (await pool.query(
      `SELECT r.id, r.field_tool_id, r.user_id, r.notes, r.inputs, r.outputs,
              r.created_at, r.updated_at,
              t.name AS field_tool_name,
              t.category AS field_tool_category,
              u.name AS user_name
         FROM field_tool_runs r
         JOIN field_tools t ON t.id = r.field_tool_id
         LEFT JOIN users u  ON u.id = r.user_id
        WHERE ${where}
        ORDER BY r.created_at DESC
        LIMIT ${limit}`,
      params
    )).rows;
    res.json({ runs: rows });
  } catch (e) {
    console.error('GET /api/field-tools/runs error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/field-tools/runs/:id
router.get('/runs/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    const r = await pool.query(
      `SELECT r.*, t.name AS field_tool_name, t.category AS field_tool_category,
              t.description AS field_tool_description, u.name AS user_name
         FROM field_tool_runs r
         JOIN field_tools t ON t.id = r.field_tool_id
         LEFT JOIN users u  ON u.id = r.user_id
        WHERE r.id = $1`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ run: r.rows[0] });
  } catch (e) {
    console.error('GET /api/field-tools/runs/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/field-tools/runs
// Body: { field_tool_id, inputs, outputs, notes }
router.post('/runs', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const fieldToolId = String(body.field_tool_id || '').trim();
    if (!fieldToolId) return res.status(400).json({ error: 'field_tool_id is required' });

    // Verify the tool exists (avoid orphan rows pointing at deleted tools).
    const toolChk = await pool.query('SELECT id FROM field_tools WHERE id = $1', [fieldToolId]);
    if (!toolChk.rows.length) return res.status(404).json({ error: 'field_tool not found' });

    const inputs = (body.inputs && typeof body.inputs === 'object') ? body.inputs : {};
    const outputs = (body.outputs && typeof body.outputs === 'object') ? body.outputs : {};
    const notes = (typeof body.notes === 'string' && body.notes.trim())
      ? body.notes.slice(0, 2000) : null;

    const id = newRunId();
    const r = await pool.query(
      `INSERT INTO field_tool_runs (id, field_tool_id, user_id, inputs, outputs, notes)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       RETURNING *`,
      [id, fieldToolId, req.user.id, JSON.stringify(inputs), JSON.stringify(outputs), notes]
    );
    res.json({ run: r.rows[0] });
  } catch (e) {
    console.error('POST /api/field-tools/runs error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/field-tools/runs/:id — author-only edits to notes.
router.patch('/runs/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    const body = req.body || {};
    const own = await pool.query('SELECT user_id FROM field_tool_runs WHERE id = $1', [id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Not found' });
    if (own.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Only the author can edit this printout' });

    const sets = [];
    const params = [];
    let p = 1;
    if (typeof body.notes === 'string') {
      sets.push(`notes = $${p++}`);
      params.push(body.notes.slice(0, 2000));
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    sets.push('updated_at = NOW()');
    params.push(id);
    await pool.query(`UPDATE field_tool_runs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/field-tools/runs/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/field-tools/runs/:id — author-only removal.
router.delete('/runs/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    const own = await pool.query('SELECT user_id FROM field_tool_runs WHERE id = $1', [id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Not found' });
    if (own.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Only the author can delete this printout' });

    await pool.query('DELETE FROM field_tool_runs WHERE id = $1', [id]);
    res.json({ ok: true, id });
  } catch (e) {
    console.error('DELETE /api/field-tools/runs/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// SYSTEM TOOL CATALOG — Project 86's built-in, higher-tier field tools
// (server/field-tool-catalog.js). An org admin adds them to the org's
// field-tools list from a picker; once added they carry system_key,
// render with a gold star, and can't be deleted by regular users.
//
// Declared BEFORE the /:id routes so /catalog isn't matched as an id.
// ──────────────────────────────────────────────────────────────────

// GET /api/field-tools/catalog — the preset catalog + which are added.
router.get('/catalog', requireAuth, async (req, res) => {
  try {
    const added = (await pool.query(
      `SELECT system_key FROM field_tools WHERE system_key IS NOT NULL AND organization_id = $1`,
      [callerOrg(req)]
    )).rows.map((r) => r.system_key);
    const addedSet = new Set(added);
    const list = catalog.getCatalog().map((e) => ({
      key: e.key, name: e.name, description: e.description, category: e.category,
      added: addedSet.has(e.key),
    }));
    res.json({ catalog: list });
  } catch (e) {
    console.error('GET /api/field-tools/catalog error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/field-tools/catalog/:key/add — add (or refresh) a system tool.
// Admin-gated (org config). Idempotent: re-adding upgrades html_body.
router.post('/catalog/:key/add', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const key = String(req.params.key || '').trim();
    const entry = catalog.getEntry(key);
    if (!entry) return res.status(404).json({ error: 'Unknown system tool.' });
    const org = callerOrg(req);
    const existing = await pool.query('SELECT id FROM field_tools WHERE system_key = $1 AND organization_id = $2', [key, org]);
    try {
      if (existing.rows.length) {
        const r = await pool.query(
          `UPDATE field_tools
              SET name=$2, description=$3, category=$4, html_body=$5, is_system=TRUE, updated_at=NOW()
            WHERE id=$1 RETURNING id, name, is_system, system_key`,
          [existing.rows[0].id, entry.name, entry.description, entry.category, entry.html_body]
        );
        return res.json({ tool: r.rows[0], added: false, updated: true });
      }
      const id = newId();
      const r = await pool.query(
        `INSERT INTO field_tools (id, name, description, category, html_body, created_by, organization_id, is_system, system_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, NOW(), NOW())
         RETURNING id, name, is_system, system_key`,
        [id, entry.name, entry.description, entry.category, entry.html_body, req.user.id, org, key]
      );
      return res.json({ tool: r.rows[0], added: true });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ error: 'A tool named "' + entry.name + '" already exists. Rename or remove it first.' });
      }
      throw e;
    }
  } catch (e) {
    console.error('POST /api/field-tools/catalog/:key/add error:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/field-tools/catalog/:key — remove an added system tool.
// Admin-gated (this is how a system tool is taken off the list, since
// the normal DELETE blocks system tools).
router.delete('/catalog/:key', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const key = String(req.params.key || '').trim();
    const r = await pool.query('DELETE FROM field_tools WHERE system_key = $1 AND organization_id = $2 RETURNING id', [key, callerOrg(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'That system tool is not on the list.' });
    res.json({ ok: true, key });
  } catch (e) {
    console.error('DELETE /api/field-tools/catalog/:key error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// FIELD TOOL CRUD by :id
// (Declared AFTER /runs routes — see note above.)
// ──────────────────────────────────────────────────────────────────

// GET /api/field-tools/:id — full record incl. html_body.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    const r = await pool.query(
      `SELECT * FROM field_tools WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
      [id, callerOrg(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ tool: r.rows[0] });
  } catch (e) {
    console.error('GET /api/field-tools/:id error:', e);
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

    // Ownership guard — only the owning org (or legacy null-org) may edit.
    const own = await pool.query('SELECT organization_id FROM field_tools WHERE id = $1', [id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Not found' });
    const oorg = own.rows[0].organization_id;
    if (oorg != null && oorg !== callerOrg(req)) return res.status(404).json({ error: 'Not found' });

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
      // SAFE: column names hardcoded above (name / description / category / html_body); no user-keys loop.
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
    // System (preset) tools can't be deleted here — an admin removes them
    // from the catalog (DELETE /catalog/:key).
    const chk = await pool.query('SELECT is_system, organization_id FROM field_tools WHERE id = $1', [id]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Not found' });
    const corg = chk.rows[0].organization_id;
    if (corg != null && corg !== callerOrg(req)) return res.status(404).json({ error: 'Not found' });
    if (chk.rows[0].is_system) {
      return res.status(403).json({ error: "System tools can't be deleted. An admin can remove them from Tools → Add system tool." });
    }
    const r = await pool.query(`DELETE FROM field_tools WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (e) {
    console.error('DELETE /api/field-tools/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
