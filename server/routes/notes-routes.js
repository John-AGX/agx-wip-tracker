// My Notes — a personal, private scratchpad surface (Phase 1 /
// Deliverable 3).
//
// SECURITY POSTURE — owner + org scoped, FAIL-CLOSED.
//   user_notes is PERSONAL data: a note belongs to exactly one user in
//   one org, and NO other user — not even an admin in the same org —
//   ever reads, edits, or deletes it through this surface. Every single
//   query in this file filters BOTH:
//       organization_id = <caller org> AND user_id = <caller id>
//   derived from the authenticated req.user (never from the request
//   body / params). The UPDATE and DELETE WHERE clauses include BOTH
//   predicates so a forged id can never target another user's row — a
//   miss returns 404, leaking nothing. If the caller has no org we bail
//   with an empty/!404 result rather than running an unscoped query.
//
//   This deliberately mirrors the org-scoping discipline in
//   tasks-routes.js, tightened with the per-user predicate (tasks are
//   org-shared + assignee-driven; notes are strictly private).
//
// Capability: requireAuth only — no capability gate. Like tasks + My
// Files, a personal notes space must be reachable by every authed user
// regardless of which sales/ops caps their role holds. Org + owner
// scoping IS the security boundary.
//
// Mounted at /api/notes (see server/index.js).

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// Id scheme mirrors newId() in tasks-routes.js (TEXT primary key).
function newId() {
  return 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Resolve the caller's organization_id. Returns null when the user has
// no org assigned — callers treat null as "deny" (fail-closed), never
// running an unscoped query.
function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  if (!oid) return null;
  return Number(oid);
}

function callerUserId(req) {
  return Number(req.user && req.user.id);
}

// GET /api/notes — the caller's own notes, pinned first then most
// recently updated. Strictly scoped to (org, user).
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ notes: [] });
    const { rows } = await pool.query(
      `SELECT id, title, body, pinned, created_at, updated_at
         FROM user_notes
        WHERE organization_id = $1 AND user_id = $2
        ORDER BY pinned DESC, updated_at DESC`,
      [orgId, callerUserId(req)]
    );
    res.json({ notes: rows });
  } catch (e) {
    console.error('GET /api/notes error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notes — create. Body: { title?, body?, pinned? }. At least
// one of title/body should be present, but we don't hard-require it
// (a blank quick-add note is harmless and the client trims).
router.post('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const body = req.body || {};

    const title = (typeof body.title === 'string') ? body.title.trim().slice(0, 300) : null;
    const noteBody = (typeof body.body === 'string') ? body.body.slice(0, 20000) : null;
    const pinned = body.pinned === true || body.pinned === 'true';

    if (!title && !noteBody) {
      return res.status(400).json({ error: 'A note needs a title or body' });
    }

    const id = newId();
    const { rows } = await pool.query(
      `INSERT INTO user_notes (id, organization_id, user_id, title, body, pinned)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, body, pinned, created_at, updated_at`,
      [id, orgId, callerUserId(req), title, noteBody, pinned]
    );
    res.json({ note: rows[0] });
  } catch (e) {
    console.error('POST /api/notes error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/notes/:id — partial update of title / body / pinned. The
// WHERE pins the row to (id, org, user) so another user's note can never
// be touched; a miss → 404. Only the three editable columns are settable.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Note not found' });
    const body = req.body || {};

    const sets = [];
    const params = [];
    let pn = 1;

    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      sets.push('title = $' + (pn++));
      params.push(typeof body.title === 'string' ? body.title.trim().slice(0, 300) : null);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'body')) {
      sets.push('body = $' + (pn++));
      params.push(typeof body.body === 'string' ? body.body.slice(0, 20000) : null);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'pinned')) {
      sets.push('pinned = $' + (pn++));
      params.push(body.pinned === true || body.pinned === 'true');
    }

    if (!sets.length) {
      // Nothing to change — return the current row (still owner-scoped).
      const cur = await pool.query(
        `SELECT id, title, body, pinned, created_at, updated_at
           FROM user_notes
          WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
        [req.params.id, orgId, callerUserId(req)]
      );
      if (!cur.rowCount) return res.status(404).json({ error: 'Note not found' });
      return res.json({ note: cur.rows[0] });
    }

    sets.push('updated_at = NOW()');
    params.push(req.params.id, orgId, callerUserId(req));
    const sql =
      'UPDATE user_notes SET ' + sets.join(', ') +
      ' WHERE id = $' + (pn++) + ' AND organization_id = $' + (pn++) + ' AND user_id = $' + (pn++) +
      ' RETURNING id, title, body, pinned, created_at, updated_at';
    const { rows, rowCount } = await pool.query(sql, params);
    if (!rowCount) return res.status(404).json({ error: 'Note not found' });
    res.json({ note: rows[0] });
  } catch (e) {
    console.error('PATCH /api/notes/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/notes/:id — hard delete, owner + org scoped. A forged id
// belonging to another user matches zero rows → 404.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Note not found' });
    const r = await pool.query(
      'DELETE FROM user_notes WHERE id = $1 AND organization_id = $2 AND user_id = $3',
      [req.params.id, orgId, callerUserId(req)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Note not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/notes/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
