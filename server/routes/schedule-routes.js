// Schedule entries — production-scheduling calendar (Phase 2).
//
// Entries place a job on a date for N production days during the
// Friday production-scheduling meeting. The frontend reads them
// to paint the Outlook-style monthly calendar at /#schedule.
//
// Endpoints (all require auth + JOBS_VIEW_ALL or JOBS_VIEW_ASSIGNED):
//   GET    /api/schedule                       — list (optional ?from / ?to date filter)
//   POST   /api/schedule                       — create
//   PATCH  /api/schedule/:id                   — update fields (move, resize, status, crew, notes)
//   DELETE /api/schedule/:id                   — remove
//
// Permission model (Phase 1 spec from John):
//   "everyone should be able to view schedule for now should and edit"
// so we gate read on JOBS_VIEW_ALL/ASSIGNED and write on the same —
// no separate SCHEDULE_EDIT capability yet. Tighten later if needed.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

console.log('[schedule-routes] mounted at /api/schedule (Phase 2 — production-scheduling calendar)');

function genId() {
  return 'sch_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Sanitize / coerce inputs from the JSON body. Returns { ok, value, error }.
// Async because crew ids are validated against the users table — we
// don't want stale/garbage user ids festering in the JSONB column.
async function readEntry(body, isUpdate) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body required' };
  const out = {};
  if (!isUpdate || body.jobId !== undefined) {
    if (!body.jobId || typeof body.jobId !== 'string') return { ok: false, error: 'jobId required' };
    out.jobId = body.jobId;
  }
  if (!isUpdate || body.startDate !== undefined) {
    const sd = String(body.startDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) return { ok: false, error: 'startDate must be YYYY-MM-DD' };
    out.startDate = sd;
  }
  if (!isUpdate || body.days !== undefined) {
    const d = parseInt(body.days, 10);
    if (!Number.isFinite(d) || d < 1 || d > 365) return { ok: false, error: 'days must be 1..365' };
    out.days = d;
  }
  if (!isUpdate || body.crew !== undefined) {
    if (body.crew == null) {
      out.crew = [];
    } else if (Array.isArray(body.crew)) {
      // Crew is an array of user ids (integers from users.id). Coerce
      // to numbers + dedupe, then verify each id refers to a real user
      // — stops bad-actor / typo'd ids from polluting the JSONB.
      const seen = {};
      const candidates = [];
      body.crew.forEach((u) => {
        const n = parseInt(u, 10);
        if (Number.isFinite(n) && !seen[n]) {
          seen[n] = true;
          candidates.push(n);
        }
      });
      if (candidates.length) {
        const { rows: validRows } = await pool.query(
          'SELECT id FROM users WHERE id = ANY($1::int[]) AND active = TRUE',
          [candidates]
        );
        const validSet = new Set(validRows.map((r) => Number(r.id)));
        out.crew = candidates.filter((n) => validSet.has(n));
        // If the caller passed ids we couldn't validate, surface a
        // soft warning in the response so the client can show "X
        // dropped" if it cares. Doesn't block save.
        const dropped = candidates.filter((n) => !validSet.has(n));
        if (dropped.length) out._droppedCrew = dropped;
      } else {
        out.crew = [];
      }
    } else {
      return { ok: false, error: 'crew must be an array' };
    }
  }
  if (!isUpdate || body.includesWeekends !== undefined) {
    out.includesWeekends = !!body.includesWeekends;
  }
  if (!isUpdate || body.status !== undefined) {
    const allowed = { planned: 1, 'in-progress': 1, done: 1, 'rolled-over': 1 };
    const s = String(body.status || 'planned');
    if (!allowed[s]) return { ok: false, error: 'invalid status' };
    out.status = s;
  }
  if (!isUpdate || body.notes !== undefined) {
    out.notes = body.notes == null ? null : String(body.notes).slice(0, 2000);
  }
  // expectedUpdatedAt — optimistic-locking token. Only meaningful on
  // PATCH. Validated in the route handler, not here, so we just pass
  // it through on the parsed value.
  if (isUpdate && body.expectedUpdatedAt !== undefined) {
    out._expectedUpdatedAt = body.expectedUpdatedAt;
  }
  return { ok: true, value: out };
}

function rowToJson(r) {
  if (!r) return null;
  // start_date_iso comes pre-formatted as YYYY-MM-DD via to_char in
  // the SELECT — sidesteps pg's TZ-aware Date parsing of DATE columns
  // (which can shift by a day depending on the server's timezone).
  // We still tolerate a bare start_date for INSERT/UPDATE RETURNING
  // rows that come back without the alias.
  var iso = r.start_date_iso;
  if (!iso) {
    if (typeof r.start_date === 'string') iso = r.start_date.slice(0, 10);
    else if (r.start_date instanceof Date) iso = r.start_date.toISOString().slice(0, 10);
    else iso = '';
  }
  return {
    id: r.id,
    jobId: r.job_id,
    startDate: iso,
    days: r.days,
    crew: Array.isArray(r.crew) ? r.crew : [],
    includesWeekends: !!r.includes_weekends,
    status: r.status,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

// ──────────────────────────────────────────────────────────────────
// GET /api/schedule  — list entries, optional ?from=YYYY-MM-DD&to=YYYY-MM-DD
// "from" / "to" filter on start_date so the client can fetch a single
// month's worth without dragging every entry. Optional ?jobId narrows to one job.
// ──────────────────────────────────────────────────────────────────
router.get('/',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const params = [];
      const where = [];
      if (req.query.from) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from))) {
          return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
        }
        params.push(req.query.from);
        where.push('start_date >= $' + params.length);
      }
      if (req.query.to) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) {
          return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
        }
        params.push(req.query.to);
        // Use start_date <= to since the entry could span past it; the
        // client expands days[] when rendering anyway.
        where.push('start_date <= $' + params.length);
      }
      if (req.query.jobId) {
        params.push(String(req.query.jobId));
        where.push('job_id = $' + params.length);
      }
      // Cast start_date through to_char to dodge pg's timezone-aware
      // Date parsing for the DATE column (see rowToJson comment).
      const sql =
        "SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start_date_iso " +
        'FROM schedule_entries ' +
        (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
        'ORDER BY start_date ASC, created_at ASC';
      const { rows } = await pool.query(sql, params);
      res.json({ entries: rows.map(rowToJson) });
    } catch (e) {
      console.error('GET /api/schedule error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/schedule  — create
router.post('/',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const parsed = await readEntry(req.body, false);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const v = parsed.value;
      // Confirm the job exists so we don't leave orphan rows. ON DELETE
      // CASCADE handles the reverse direction (job removed → entries gone).
      const jobChk = await pool.query('SELECT id FROM jobs WHERE id = $1', [v.jobId]);
      if (!jobChk.rows.length) return res.status(404).json({ error: 'job not found' });
      const id = genId();
      const ins = await pool.query(
        `INSERT INTO schedule_entries
           (id, job_id, start_date, days, crew, includes_weekends, status, notes, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
         RETURNING *, to_char(start_date, 'YYYY-MM-DD') AS start_date_iso`,
        [
          id,
          v.jobId,
          v.startDate,
          v.days,
          JSON.stringify(v.crew || []),
          !!v.includesWeekends,
          v.status || 'planned',
          v.notes || null,
          req.user && req.user.id ? req.user.id : null
        ]
      );
      res.status(201).json({ entry: rowToJson(ins.rows[0]) });
    } catch (e) {
      console.error('POST /api/schedule error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PATCH /api/schedule/:id — partial update with optimistic locking.
//
// Concurrency model: the client sends `expectedUpdatedAt` — the value
// of updated_at it last saw on this entry. The server only commits
// the UPDATE if the row's current updated_at still matches. If
// someone else saved a change in between, we return 409 with the
// current row so the client can refresh and let the user re-apply.
// Skipped (= last-write-wins) only when the client doesn't send the
// token, since the field is opt-in for backwards compat.
router.patch('/:id',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const parsed = await readEntry(req.body, true);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const v = parsed.value;
      const expectedUpdatedAt = v._expectedUpdatedAt;
      delete v._expectedUpdatedAt;

      // Optimistic-locking pre-check. Skipped silently when the
      // client hasn't sent a token (older callers / scripts).
      if (expectedUpdatedAt) {
        const cur = await pool.query(
          "SELECT updated_at, to_char(start_date, 'YYYY-MM-DD') AS start_date_iso, * FROM schedule_entries WHERE id = $1",
          [req.params.id]
        );
        if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
        const liveTs = cur.rows[0].updated_at instanceof Date
          ? cur.rows[0].updated_at.toISOString()
          : String(cur.rows[0].updated_at);
        if (liveTs !== String(expectedUpdatedAt)) {
          return res.status(409).json({
            error: 'Entry changed elsewhere — refresh and try again.',
            current: rowToJson(cur.rows[0])
          });
        }
      }

      // Build dynamic SET clause from the fields that were actually
      // provided. updated_at always bumps so consumers can poll for
      // changes without comparing every field.
      const sets = [];
      const params = [];
      const push = (col, val) => { params.push(val); sets.push(col + ' = $' + params.length); };
      if (v.jobId !== undefined) push('job_id', v.jobId);
      if (v.startDate !== undefined) push('start_date', v.startDate);
      if (v.days !== undefined) push('days', v.days);
      if (v.crew !== undefined) {
        params.push(JSON.stringify(v.crew));
        sets.push('crew = $' + params.length + '::jsonb');
      }
      if (v.includesWeekends !== undefined) push('includes_weekends', v.includesWeekends);
      if (v.status !== undefined) push('status', v.status);
      if (v.notes !== undefined) push('notes', v.notes);
      if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
      sets.push('updated_at = NOW()');

      params.push(req.params.id);
      const sql =
        'UPDATE schedule_entries SET ' + sets.join(', ') +
        ' WHERE id = $' + params.length +
        " RETURNING *, to_char(start_date, 'YYYY-MM-DD') AS start_date_iso";
      const { rows } = await pool.query(sql, params);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ entry: rowToJson(rows[0]) });
    } catch (e) {
      console.error('PATCH /api/schedule/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /api/schedule/:id — remove
router.delete('/:id',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const { rowCount } = await pool.query('DELETE FROM schedule_entries WHERE id = $1', [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/schedule/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
