// Team messaging — per-entity comment threads + (future) DMs.
//
// Endpoints (all require auth, all reject role='sub' since the sub
// portal stays separate from internal collaboration):
//
//   GET    /api/messages/recent
//     Recent threads the current user has activity on, with the
//     last message + unread count. Drives the Summary inbox widget.
//
//   GET    /api/messages/:threadKey
//     Full message list for a thread, oldest → newest.
//
//   POST   /api/messages/:threadKey   body: { body }
//     Post a message. Auto-bumps the poster's last_read_at on the
//     thread so they don't see their own message as unread.
//
//   POST   /api/messages/:threadKey/read
//     Mark the thread read up to NOW for the current user.
//
//   DELETE /api/messages/:id
//     Delete a message. Allowed for the author or any admin.
//
// Thread-key conventions (validated below):
//   job:<jobId>
//   lead:<leadId>
//   estimate:<estimateId>
//   dm:<userIdA>:<userIdB>   (sorted)

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

console.log('[message-routes] mounted at /api/messages');

// Reject role='sub' — sub-portal users live behind grants and
// don't see the internal messaging surface. Lightweight gate
// applied to every endpoint in this file via use().
router.use(requireAuth, (req, res, next) => {
  if (req.user && req.user.role === 'sub') {
    return res.status(403).json({ error: 'Messaging is not available on the sub portal' });
  }
  next();
});

function genId() {
  return 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Normalize / validate the thread key. Limits the prefix to known
// kinds so a typo can't accidentally create an orphan thread.
function isValidThreadKey(key) {
  if (typeof key !== 'string' || !key) return false;
  if (key.length > 200) return false;
  if (/^(job|lead|estimate):[a-zA-Z0-9_:-]+$/.test(key)) return true;
  if (/^dm:\d+:\d+$/.test(key)) return true;
  return false;
}

// Friendly label for a thread used by the inbox widget. Best-effort —
// looks up the entity title from the obvious table; falls back to the
// raw id when the entity is gone.
async function describeThread(key) {
  try {
    if (key.startsWith('job:')) {
      const id = key.slice(4);
      const { rows } = await pool.query('SELECT data FROM jobs WHERE id = $1', [id]);
      if (rows.length) {
        const d = rows[0].data || {};
        const num = d.jobNumber ? '[' + d.jobNumber + '] ' : '';
        return { kind: 'job', label: num + (d.title || d.name || id) };
      }
      return { kind: 'job', label: 'Job ' + id };
    }
    if (key.startsWith('lead:')) {
      const id = key.slice(5);
      const { rows } = await pool.query('SELECT data FROM leads WHERE id = $1', [id]);
      if (rows.length) {
        const d = rows[0].data || {};
        return { kind: 'lead', label: d.title || d.name || ('Lead ' + id) };
      }
      return { kind: 'lead', label: 'Lead ' + id };
    }
    if (key.startsWith('estimate:')) {
      const id = key.slice(9);
      const { rows } = await pool.query('SELECT data FROM estimates WHERE id = $1', [id]);
      if (rows.length) {
        const d = rows[0].data || {};
        return { kind: 'estimate', label: d.title || ('Estimate ' + id) };
      }
      return { kind: 'estimate', label: 'Estimate ' + id };
    }
    if (key.startsWith('dm:')) {
      const parts = key.split(':');
      const otherIds = parts.slice(1).map(Number);
      const { rows } = await pool.query('SELECT id, name, email FROM users WHERE id = ANY($1::int[])', [otherIds]);
      const names = rows.map(r => r.name || r.email).join(' ↔ ');
      return { kind: 'dm', label: names || 'Direct message' };
    }
  } catch (e) { /* fallthrough */ }
  return { kind: 'thread', label: key };
}

// GET /api/messages/recent
// Threads the current user can see, ordered by last activity. We
// surface the latest message + author + unread count per thread.
// Caps the result list at 30 threads — anything older falls off the
// inbox view (still reachable by entity).
router.get('/recent', async (req, res) => {
  try {
    const userId = req.user.id;
    // Last message per thread + this user's last_read timestamp.
    const { rows } = await pool.query(
      `WITH latest AS (
         SELECT thread_key, MAX(created_at) AS last_at
           FROM messages
          GROUP BY thread_key
       )
       SELECT m.thread_key,
              m.id        AS last_id,
              m.body      AS last_body,
              m.user_id   AS last_user_id,
              u.name      AS last_user_name,
              m.created_at AS last_created_at,
              mr.last_read_at,
              (SELECT COUNT(*)::int
                 FROM messages m2
                WHERE m2.thread_key = m.thread_key
                  AND m2.user_id <> $1
                  AND m2.created_at > COALESCE(mr.last_read_at, 'epoch'::timestamptz)
              ) AS unread_count
         FROM latest l
         JOIN messages m ON m.thread_key = l.thread_key AND m.created_at = l.last_at
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN message_reads mr ON mr.thread_key = m.thread_key AND mr.user_id = $1
        ORDER BY m.created_at DESC
        LIMIT 30`,
      [userId]
    );
    // Annotate each thread with a friendly label.
    const threads = await Promise.all(rows.map(async (r) => {
      const desc = await describeThread(r.thread_key);
      return {
        thread_key: r.thread_key,
        kind: desc.kind,
        label: desc.label,
        last_id: r.last_id,
        last_body: r.last_body,
        last_user_id: r.last_user_id,
        last_user_name: r.last_user_name,
        last_created_at: r.last_created_at,
        last_read_at: r.last_read_at,
        unread_count: r.unread_count
      };
    }));
    // Roll up total unread across all threads — the Summary badge.
    const totalUnread = threads.reduce((s, t) => s + (t.unread_count || 0), 0);
    res.json({ threads, total_unread: totalUnread });
  } catch (e) {
    console.error('GET /api/messages/recent error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/messages/:threadKey
router.get('/:threadKey', async (req, res) => {
  try {
    const key = String(req.params.threadKey || '');
    if (!isValidThreadKey(key)) {
      return res.status(400).json({ error: 'Invalid thread key' });
    }
    const { rows } = await pool.query(
      `SELECT m.id, m.thread_key, m.user_id, u.name AS user_name, u.email AS user_email,
              m.body, m.created_at, m.edited_at
         FROM messages m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.thread_key = $1
        ORDER BY m.created_at ASC
        LIMIT 1000`,
      [key]
    );
    const desc = await describeThread(key);
    res.json({ thread_key: key, kind: desc.kind, label: desc.label, messages: rows });
  } catch (e) {
    console.error('GET /api/messages/:threadKey error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/messages/:threadKey  body: { body }
router.post('/:threadKey', async (req, res) => {
  try {
    const key = String(req.params.threadKey || '');
    if (!isValidThreadKey(key)) {
      return res.status(400).json({ error: 'Invalid thread key' });
    }
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'body is required' });
    if (body.length > 5000) return res.status(400).json({ error: 'body too long (max 5000 chars)' });

    const id = genId();
    await pool.query(
      `INSERT INTO messages (id, thread_key, user_id, body) VALUES ($1, $2, $3, $4)`,
      [id, key, req.user.id, body]
    );
    // Auto-mark read for the poster so they don't see their own
    // message as unread.
    await pool.query(
      `INSERT INTO message_reads (thread_key, user_id, last_read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (thread_key, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at`,
      [key, req.user.id]
    );
    const { rows } = await pool.query(
      `SELECT m.id, m.thread_key, m.user_id, u.name AS user_name, u.email AS user_email,
              m.body, m.created_at, m.edited_at
         FROM messages m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.id = $1`,
      [id]
    );
    res.json({ message: rows[0] });
  } catch (e) {
    console.error('POST /api/messages/:threadKey error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/messages/:threadKey/read — mark thread read up to NOW.
router.post('/:threadKey/read', async (req, res) => {
  try {
    const key = String(req.params.threadKey || '');
    if (!isValidThreadKey(key)) {
      return res.status(400).json({ error: 'Invalid thread key' });
    }
    await pool.query(
      `INSERT INTO message_reads (thread_key, user_id, last_read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (thread_key, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at`,
      [key, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/messages/:threadKey/read error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/messages/:id — author or admin only.
router.delete('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const { rows } = await pool.query('SELECT user_id FROM messages WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Message not found' });
    const isAdmin = req.user.role === 'admin';
    const isAuthor = rows[0].user_id === req.user.id;
    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ error: 'Only the author or an admin can delete a message.' });
    }
    await pool.query('DELETE FROM messages WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/messages/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
