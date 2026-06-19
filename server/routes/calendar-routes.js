// Personal calendar events — the per-user Assistant calendar
// (unified-calendar Slice B).
//
// SECURITY POSTURE — owner + org scoped, FAIL-CLOSED. Identical
// discipline to notes-routes.js: a calendar event belongs to exactly
// one user in one org and NO other user — not even a same-org admin —
// reads, edits, or deletes it through this surface. Every query filters
// BOTH organization_id = <caller org> AND user_id = <caller id>, both
// derived from the authenticated req.user (never the body/params). The
// UPDATE/DELETE WHERE clauses include both predicates so a forged id
// can never target another user's row (miss → 404, leaking nothing).
// No org on the caller → empty/404 rather than an unscoped query.
//
// Capability: requireAuth only — a personal calendar must be reachable
// by every authed user regardless of role caps. Org + owner scoping IS
// the boundary. (These are the user's OWN events; the production-
// scheduling job calendar lives separately in schedule-routes.js.)
//
// Mounted at /api/calendar (see server/index.js).

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

function newId() {
  return 'cal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Fail-closed org resolver — null means "deny" (no unscoped queries).
function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  if (!oid) return null;
  return Number(oid);
}
function callerUserId(req) {
  return Number(req.user && req.user.id);
}

// Allowed status values drive the calendar's opaque/translucent bar
// styling. Anything else falls back to 'confirmed'.
const STATUSES = ['confirmed', 'tentative', 'canceled'];
function normStatus(s) {
  return STATUSES.indexOf(String(s || '')) >= 0 ? String(s) : 'confirmed';
}

// Shape a row for the client (camelCase-friendly but we keep the
// snake_case the DB returns; the client reads these names).
const SELECT_COLS =
  'id, title, starts_at, ends_at, all_day, location, notes, color, status, recurrence, reminder_minutes, created_at, updated_at';

// GET /api/calendar — the caller's own events. Optional ?from=&to=
// ISO datetimes clip to a window (the month the calendar is showing);
// without them, returns everything from now-ish forward is NOT assumed
// — we return all the caller's events and let the client window them,
// unless a range is supplied. Strictly scoped to (org, user).
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ events: [] });
    const params = [orgId, callerUserId(req)];
    let where = 'organization_id = $1 AND user_id = $2';
    // Range filter: an event overlaps [from, to] if it starts before
    // `to` and ends (or starts, when no end) at/after `from`.
    if (req.query.from) {
      params.push(req.query.from);
      where += ' AND COALESCE(ends_at, starts_at) >= $' + params.length;
    }
    if (req.query.to) {
      params.push(req.query.to);
      where += ' AND starts_at <= $' + params.length;
    }
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} FROM calendar_events
        WHERE ${where}
        ORDER BY starts_at ASC`,
      params
    );
    res.json({ events: rows });
  } catch (e) {
    console.error('GET /api/calendar error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/calendar — create. Body: { title, starts_at (required),
// ends_at?, all_day?, location?, notes?, color?, status?, recurrence?,
// reminder_minutes? }.
router.post('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const b = req.body || {};
    if (!b.starts_at) return res.status(400).json({ error: 'starts_at is required' });

    const title = (typeof b.title === 'string') ? b.title.trim().slice(0, 300) : null;
    const allDay = b.all_day === true || b.all_day === 'true';
    const location = (typeof b.location === 'string') ? b.location.trim().slice(0, 300) : null;
    const notes = (typeof b.notes === 'string') ? b.notes.slice(0, 20000) : null;
    const color = (typeof b.color === 'string') ? b.color.trim().slice(0, 32) : null;
    const status = normStatus(b.status);
    const recurrence = (typeof b.recurrence === 'string') ? b.recurrence.trim().slice(0, 300) : null;
    const reminder = (b.reminder_minutes == null || b.reminder_minutes === '') ? null : (parseInt(b.reminder_minutes, 10) || null);

    const id = newId();
    const { rows } = await pool.query(
      `INSERT INTO calendar_events
         (id, organization_id, user_id, title, starts_at, ends_at, all_day, location, notes, color, status, recurrence, reminder_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING ${SELECT_COLS}`,
      [id, orgId, callerUserId(req), title, b.starts_at, b.ends_at || null, allDay, location, notes, color, status, recurrence, reminder]
    );
    res.json({ event: rows[0] });
  } catch (e) {
    console.error('POST /api/calendar error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/calendar/:id — partial update. WHERE pins to (id, org,
// user) so another user's event can never be touched; a miss → 404.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Event not found' });
    const b = req.body || {};
    const sets = [];
    const params = [];
    let pn = 1;
    function set(col, val) { sets.push(col + ' = $' + (pn++)); params.push(val); }

    if (Object.prototype.hasOwnProperty.call(b, 'title')) set('title', typeof b.title === 'string' ? b.title.trim().slice(0, 300) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'starts_at')) set('starts_at', b.starts_at);
    if (Object.prototype.hasOwnProperty.call(b, 'ends_at')) set('ends_at', b.ends_at || null);
    if (Object.prototype.hasOwnProperty.call(b, 'all_day')) set('all_day', b.all_day === true || b.all_day === 'true');
    if (Object.prototype.hasOwnProperty.call(b, 'location')) set('location', typeof b.location === 'string' ? b.location.trim().slice(0, 300) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'notes')) set('notes', typeof b.notes === 'string' ? b.notes.slice(0, 20000) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'color')) set('color', typeof b.color === 'string' ? b.color.trim().slice(0, 32) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'status')) set('status', normStatus(b.status));
    if (Object.prototype.hasOwnProperty.call(b, 'recurrence')) set('recurrence', typeof b.recurrence === 'string' ? b.recurrence.trim().slice(0, 300) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'reminder_minutes')) set('reminder_minutes', (b.reminder_minutes == null || b.reminder_minutes === '') ? null : (parseInt(b.reminder_minutes, 10) || null));

    if (!sets.length) {
      const cur = await pool.query(
        `SELECT ${SELECT_COLS} FROM calendar_events WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
        [req.params.id, orgId, callerUserId(req)]
      );
      if (!cur.rowCount) return res.status(404).json({ error: 'Event not found' });
      return res.json({ event: cur.rows[0] });
    }

    sets.push('updated_at = NOW()');
    params.push(req.params.id, orgId, callerUserId(req));
    const sql =
      'UPDATE calendar_events SET ' + sets.join(', ') +
      ' WHERE id = $' + (pn++) + ' AND organization_id = $' + (pn++) + ' AND user_id = $' + (pn++) +
      ` RETURNING ${SELECT_COLS}`;
    const { rows, rowCount } = await pool.query(sql, params);
    if (!rowCount) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: rows[0] });
  } catch (e) {
    console.error('PATCH /api/calendar/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/calendar/:id — owner + org scoped. Forged id → 404.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Event not found' });
    const r = await pool.query(
      'DELETE FROM calendar_events WHERE id = $1 AND organization_id = $2 AND user_id = $3',
      [req.params.id, orgId, callerUserId(req)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Event not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/calendar/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
