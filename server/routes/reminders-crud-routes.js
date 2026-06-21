// Reminders CRUD (3-tier model) — PERSONAL, timed nudges on their own list,
// SEPARATE from calendar_event appointments.
//
// NOTE: this is a DIFFERENT file from server/routes/reminders-routes.js, which
// is the system-admin cron TRIGGER (/api/admin/reminders/run + /cron-preview).
// This router is the per-user CRUD, mounted at /api/reminders. Do not merge.
//
// SECURITY POSTURE — owner + org scoped, FAIL-CLOSED, identical to
// notes-routes.js: a reminder belongs to exactly one user in one org, and NO
// other user (not even a same-org admin) reads/edits/deletes it here. EVERY
// query filters BOTH organization_id = <caller org> AND user_id = <caller id>,
// derived from the authenticated req.user — never the body/params. A forged id
// owned by another user matches zero rows -> 404, leaking nothing.
//
// Capability: requireAuth only — a personal reminders space must be reachable
// by every authed user; org + owner scoping IS the security boundary.
//
// Mounted at /api/reminders (see server/index.js).
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
const STATUSES = new Set(['pending', 'done', 'dismissed']);
const LINKABLE = new Set(['client', 'job', 'lead', 'project']);

function newId() {
  return 'rem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  if (!oid) return null;
  return Number(oid);
}
function callerUserId(req) {
  return Number(req.user && req.user.id);
}
function validInstant(v) {
  if (!v) return false;
  return !Number.isNaN(new Date(v).getTime());
}

const COLS = 'id, title, notes, remind_at, status, source, fired_at, entity_type, entity_id, created_at, updated_at';

// GET /api/reminders — the caller's own reminders, soonest first. Defaults to
// the active (pending) set; ?status=all includes done/dismissed.
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ reminders: [] });
    const where = ['organization_id = $1', 'user_id = $2'];
    if (String(req.query.status || '') !== 'all') where.push("status = 'pending'");
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM reminders WHERE ` + where.join(' AND ') + ' ORDER BY remind_at ASC',
      [orgId, callerUserId(req)]
    );
    res.json({ reminders: rows });
  } catch (e) {
    console.error('GET /api/reminders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/reminders — create. Body: { title (req), remind_at (req ISO),
// notes?, entity_type?, entity_id? }. org + user stamped from req.user.
router.post('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const body = req.body || {};
    const title = (typeof body.title === 'string') ? body.title.trim().slice(0, 300) : '';
    if (!title) return res.status(400).json({ error: 'A reminder needs a title' });
    if (!validInstant(body.remind_at)) return res.status(400).json({ error: 'A reminder needs a valid remind_at datetime' });
    const notes = (typeof body.notes === 'string') ? body.notes.slice(0, 5000) : null;
    // Optional entity link — both-or-neither, type allowlisted.
    let et = null, eid = null;
    if (body.entity_type && body.entity_id && LINKABLE.has(String(body.entity_type))) {
      et = String(body.entity_type); eid = String(body.entity_id);
    }
    const { rows } = await pool.query(
      `INSERT INTO reminders (id, organization_id, user_id, title, notes, remind_at, status, source, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'user', $7, $8)
       RETURNING ${COLS}`,
      [newId(), orgId, callerUserId(req), title, notes, new Date(body.remind_at), et, eid]
    );
    res.json({ reminder: rows[0] });
  } catch (e) {
    console.error('POST /api/reminders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/reminders/:id — partial update. The WHERE pins (id, org, user)
// so another user's reminder can never be touched; a miss -> 404. Changing
// remind_at re-arms the nudge (clears fired_at).
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Reminder not found' });
    const body = req.body || {};
    const sets = [];
    const params = [];
    let pn = 1;

    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      const t = (typeof body.title === 'string') ? body.title.trim().slice(0, 300) : '';
      if (!t) return res.status(400).json({ error: 'Title cannot be blank' });
      sets.push('title = $' + (pn++)); params.push(t);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
      sets.push('notes = $' + (pn++));
      params.push(typeof body.notes === 'string' ? body.notes.slice(0, 5000) : null);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'remind_at')) {
      if (!validInstant(body.remind_at)) return res.status(400).json({ error: 'Invalid remind_at' });
      sets.push('remind_at = $' + (pn++)); params.push(new Date(body.remind_at));
      sets.push('fired_at = NULL'); // re-arm so the cron fires at the new time
    }
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      if (!STATUSES.has(String(body.status))) return res.status(400).json({ error: 'Invalid status' });
      sets.push('status = $' + (pn++)); params.push(String(body.status));
    }
    if (Object.prototype.hasOwnProperty.call(body, 'entity_type') || Object.prototype.hasOwnProperty.call(body, 'entity_id')) {
      if (body.entity_type && body.entity_id && LINKABLE.has(String(body.entity_type))) {
        sets.push('entity_type = $' + (pn++)); params.push(String(body.entity_type));
        sets.push('entity_id = $' + (pn++)); params.push(String(body.entity_id));
      } else {
        sets.push('entity_type = NULL'); sets.push('entity_id = NULL');
      }
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at = NOW()');
    params.push(req.params.id, orgId, callerUserId(req));
    const sql =
      'UPDATE reminders SET ' + sets.join(', ') +
      ' WHERE id = $' + (pn++) + ' AND organization_id = $' + (pn++) + ' AND user_id = $' + (pn++) +
      ` RETURNING ${COLS}`;
    const { rows, rowCount } = await pool.query(sql, params);
    if (!rowCount) return res.status(404).json({ error: 'Reminder not found' });
    res.json({ reminder: rows[0] });
  } catch (e) {
    console.error('PATCH /api/reminders/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/reminders/:id — hard delete, owner + org scoped. A forged id
// belonging to another user matches zero rows -> 404.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Reminder not found' });
    const r = await pool.query(
      'DELETE FROM reminders WHERE id = $1 AND organization_id = $2 AND user_id = $3',
      [req.params.id, orgId, callerUserId(req)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Reminder not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/reminders/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
