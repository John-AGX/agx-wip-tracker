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
const { attachEntityLabels } = require('../services/entity-labels');
const { resolveTz, localWallClockToInstant } = require('../timezone');

const router = express.Router();

// Resolve the caller's IANA timezone (user override → org → default) so a
// naive local datetime in starts_at/ends_at is stored as the correct
// instant. Values that already carry an offset/'Z' (what the web UI sends)
// pass through localWallClockToInstant unchanged.
async function callerTz(req) {
  try {
    const { rows } = await pool.query(
      'SELECT u.timezone AS utz, o.timezone AS otz FROM users u ' +
      'LEFT JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1',
      [callerUserId(req)]
    );
    const r = rows[0] || {};
    return resolveTz(r.utz, r.otz);
  } catch (e) { return undefined; }
}
function toInstantISO(value, tz) {
  if (value == null || value === '') return value;
  const inst = localWallClockToInstant(value, tz);
  return inst ? inst.toISOString() : value;
}

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

// Optional polymorphic link — the entity (client|job|lead|project) an
// event is about. NULL = standalone personal item. normLinkType returns
// the valid type or null; the route stores both columns or neither.
const LINK_TYPES = ['client', 'job', 'lead', 'project'];
function normLinkType(t) {
  return LINK_TYPES.indexOf(String(t || '')) >= 0 ? String(t) : null;
}

// Shape a row for the client (camelCase-friendly but we keep the
// snake_case the DB returns; the client reads these names).
const SELECT_COLS =
  'id, title, starts_at, ends_at, all_day, location, notes, color, status, recurrence, reminder_minutes, entity_type, entity_id, created_at, updated_at';

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
    // Entity filter — surface a single linked record's appointments
    // (the Appointments subsection on a client/job/lead/project page).
    // Both params required together; type is validated against LINK_TYPES.
    if (req.query.entity_type && req.query.entity_id != null && String(req.query.entity_id).trim() !== '') {
      const lt = normLinkType(req.query.entity_type);
      if (!lt) return res.json({ events: [] });
      params.push(lt);
      where += ' AND entity_type = $' + params.length;
      params.push(String(req.query.entity_id).trim());
      where += ' AND entity_id = $' + params.length;
    }
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} FROM calendar_events
        WHERE ${where}
        ORDER BY starts_at ASC`,
      params
    );
    // Hydrate the linked-record label (client/job/lead/project) for any
    // event that carries an entity link, so My Day / cards can show it.
    await attachEntityLabels(orgId, rows);
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
    // Optional link — stored both-or-neither.
    const linkType = normLinkType(b.entity_type);
    const linkId = (linkType && b.entity_id != null && String(b.entity_id).trim()) ? String(b.entity_id).trim() : null;
    const entType = linkId ? linkType : null;

    // Stamp the caller's tz onto naive datetimes (defensive — the web UI
    // already sends fully-zoned ISO instants, which pass through unchanged).
    const tz = await callerTz(req);
    const startsAt = toInstantISO(b.starts_at, tz);
    const endsAt = b.ends_at ? toInstantISO(b.ends_at, tz) : null;

    const id = newId();
    const { rows } = await pool.query(
      `INSERT INTO calendar_events
         (id, organization_id, user_id, title, starts_at, ends_at, all_day, location, notes, color, status, recurrence, reminder_minutes, entity_type, entity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING ${SELECT_COLS}`,
      [id, orgId, callerUserId(req), title, startsAt, endsAt, allDay, location, notes, color, status, recurrence, reminder, entType, linkId]
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

    // Resolve tz once if a datetime is being edited (stamp naive strings).
    const needTz = Object.prototype.hasOwnProperty.call(b, 'starts_at') || Object.prototype.hasOwnProperty.call(b, 'ends_at');
    const editTz = needTz ? await callerTz(req) : undefined;

    if (Object.prototype.hasOwnProperty.call(b, 'title')) set('title', typeof b.title === 'string' ? b.title.trim().slice(0, 300) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'starts_at')) set('starts_at', toInstantISO(b.starts_at, editTz));
    if (Object.prototype.hasOwnProperty.call(b, 'ends_at')) set('ends_at', b.ends_at ? toInstantISO(b.ends_at, editTz) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'all_day')) set('all_day', b.all_day === true || b.all_day === 'true');
    if (Object.prototype.hasOwnProperty.call(b, 'location')) set('location', typeof b.location === 'string' ? b.location.trim().slice(0, 300) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'notes')) set('notes', typeof b.notes === 'string' ? b.notes.slice(0, 20000) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'color')) set('color', typeof b.color === 'string' ? b.color.trim().slice(0, 32) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'status')) set('status', normStatus(b.status));
    if (Object.prototype.hasOwnProperty.call(b, 'recurrence')) set('recurrence', typeof b.recurrence === 'string' ? b.recurrence.trim().slice(0, 300) : null);
    if (Object.prototype.hasOwnProperty.call(b, 'reminder_minutes')) set('reminder_minutes', (b.reminder_minutes == null || b.reminder_minutes === '') ? null : (parseInt(b.reminder_minutes, 10) || null));
    // Link edit — touching either field rewrites both (both-or-neither).
    if (Object.prototype.hasOwnProperty.call(b, 'entity_type') || Object.prototype.hasOwnProperty.call(b, 'entity_id')) {
      const lt = normLinkType(b.entity_type);
      const li = (lt && b.entity_id != null && String(b.entity_id).trim()) ? String(b.entity_id).trim() : null;
      set('entity_type', li ? lt : null);
      set('entity_id', li);
    }

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
