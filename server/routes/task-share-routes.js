// Task share links — send a single task to an outside worker (e.g. a sub's
// crew) by email and let them complete it with NO Project 86 account.
//
// Security model: the token IS the access. A random 32-byte token is scoped to
// ONE task; the guest never sends a task id, so they can't reach any other row
// even by tampering. A share is usable while it is not revoked and not past its
// expiry; once the guest marks the task done, mutations are refused (the link
// "expires on completion" as well as on time). The guest sees ONLY that task's
// fields + its photos — never the org, other tasks, jobs, or money.
//
//   PM-side (requireAuth):
//     POST   /api/tasks/:id/share                — create a share + email it
//     GET    /api/tasks/:id/shares               — list shares for the task
//     POST   /api/tasks/:id/shares/:sid/revoke   — kill a share link
//
//   Guest-side (token-gated, no login):
//     GET    /api/task-share/:token              — read the one task + photos
//     PATCH  /api/task-share/:token              — check items / note / done / name
//     POST   /api/task-share/:token/photo        — upload a site photo (images only)

'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { sendEmail, isEnabled: emailIsEnabled } = require('../email');
const { storage } = require('../storage');
const { sniffMimeFromBytes, sanitizeSvg, mimeFamilyMatches } = require('../util/attachment-mime');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

console.log('[task-share-routes] mounted at /api/tasks/:id/share + /api/task-share/:token');

const DEFAULT_TTL_DAYS = 14;
const STATUSES = new Set(['open', 'in_progress', 'blocked', 'done']);

function genId(p) { return p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return proto + '://' + host;
}
// Guest checklist normalizer — mirrors tasks-routes' shape, capped + trimmed.
function normChecklist(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 50).map(function (c) {
    if (c == null) return null;
    var text = String((typeof c === 'string') ? c : (c.text || '')).trim().slice(0, 500);
    if (!text) return null;
    return { text: text, done: !!(c && c.done) };
  }).filter(Boolean);
}

// Public projection of a task for a guest — deliberately NARROW (no org id,
// no created_by, no scope/owner). Photos are attached by the caller.
function publicTask(t) {
  return {
    title: t.title, notes: t.notes, kind: t.kind, status: t.status, priority: t.priority,
    due_date: t.due_date, checklist: Array.isArray(t.checklist) ? t.checklist : [],
    lat: t.lat, lng: t.lng, directions: t.directions
  };
}

// ── PM-side ─────────────────────────────────────────────────────────────────

// POST /api/tasks/:id/share  body: { sub_id?, email?, name?, days? }
router.post('/tasks/:id/share', requireAuth, async (req, res) => {
  try {
    const orgId = req.user && req.user.organization_id;
    const tR = await pool.query('SELECT id, title, organization_id FROM tasks WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL', [req.params.id, orgId]);
    if (!tR.rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = tR.rows[0];

    const body = req.body || {};
    let subId = body.sub_id ? String(body.sub_id) : null;
    let email = String(body.email || '').trim().toLowerCase();
    let name = String(body.name || '').trim() || null;
    if (subId) {
      const sR = await pool.query('SELECT id, name, email, primary_contact_first FROM subs WHERE id = $1', [subId]);
      if (sR.rows.length) {
        if (!email) email = String(sR.rows[0].email || '').trim().toLowerCase();
        if (!name) name = sR.rows[0].primary_contact_first || sR.rows[0].name || null;
      }
    }
    if (!email || email.indexOf('@') < 0) return res.status(400).json({ error: 'A valid email is required (pick a sub with an email on file, or enter one).' });

    const days = Math.min(90, Math.max(1, Number(body.days) || DEFAULT_TTL_DAYS));
    const id = genId('tsh');
    const token = genToken();
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO task_shares (id, organization_id, task_id, token, sub_id, recipient_email, recipient_name, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, task.organization_id, task.id, token, subId, email, name, expires, (req.user && req.user.id) || null]
    );

    let orgName = 'Project 86';
    try { const oR = await pool.query('SELECT name FROM organizations WHERE id = $1', [task.organization_id]); if (oR.rows.length && oR.rows[0].name) orgName = oR.rows[0].name; } catch (e) {}

    const link = baseUrl(req) + '/t/' + encodeURIComponent(token);
    const greet = name || 'there';
    const html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#222;max-width:540px;">' +
        '<p>Hi ' + escHtml(greet) + ',</p>' +
        '<p><strong>' + escHtml(orgName) + '</strong> has sent you a task to complete: <strong>' + escHtml(task.title) + '</strong>.</p>' +
        '<p>Open it on your phone — no login or password. You can check off the punch list, add photos, and mark it done:</p>' +
        '<p style="margin:24px 0;"><a href="' + escHtml(link) + '" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;">Open the task</a></p>' +
        '<p style="font-size:12px;color:#666;">This link is just for this one task and expires in ' + days + ' days (or when the task is completed). If you weren\'t expecting this, you can ignore it.</p>' +
      '</div>';
    const text = 'Hi ' + greet + ',\n\n' + orgName + ' has sent you a task to complete: ' + task.title + '.\n\nOpen it (no login needed):\n' + link + '\n\nThe link is for this one task and expires in ' + days + ' days or when it is completed.';

    let sent = { ok: false, skipped: 'email-not-configured' };
    if (emailIsEnabled()) {
      sent = await sendEmail({ to: email, subject: orgName + ' sent you a task: ' + task.title, html: html, text: text, tag: 'task_share' });
    }
    res.json({ ok: true, share: { id: id, recipient_email: email, recipient_name: name, expires_at: expires }, link: link, email_sent: !!sent.ok, email_error: sent.error || null });
  } catch (e) {
    console.error('POST /api/tasks/:id/share error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// GET /api/tasks/:id/shares — active + recent shares, with a derived status.
router.get('/tasks/:id/shares', requireAuth, async (req, res) => {
  try {
    const orgId = req.user && req.user.organization_id;
    const { rows } = await pool.query(
      `SELECT id, recipient_email, recipient_name, sub_id, created_at, expires_at, opened_at, completed_at, revoked_at, last_used_at
         FROM task_shares WHERE task_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id, orgId]
    );
    const now = Date.now();
    rows.forEach(function (r) {
      r.state = r.revoked_at ? 'revoked' : r.completed_at ? 'completed' : (new Date(r.expires_at).getTime() < now ? 'expired' : (r.opened_at ? 'opened' : 'sent'));
    });
    res.json({ shares: rows });
  } catch (e) {
    console.error('GET /api/tasks/:id/shares error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// POST /api/tasks/:id/shares/:sid/revoke
router.post('/tasks/:id/shares/:sid/revoke', requireAuth, async (req, res) => {
  try {
    const orgId = req.user && req.user.organization_id;
    const r = await pool.query('UPDATE task_shares SET revoked_at = NOW() WHERE id = $1 AND task_id = $2 AND organization_id = $3 AND revoked_at IS NULL RETURNING id', [req.params.sid, req.params.id, orgId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Share not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST revoke share error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Guest-side (token-gated) ─────────────────────────────────────────────────

// Load + validate the share by token; attach req.share + req.task. A revoked or
// time-expired link is dead (410). A completed link still LOADS (so the guest
// sees the "done" state) but mutations are refused downstream.
async function loadShare(req, res, next) {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).json({ error: 'Invalid link' });
    const sR = await pool.query('SELECT * FROM task_shares WHERE token = $1', [token]);
    if (!sR.rows.length) return res.status(404).json({ error: 'This link is not valid' });
    const share = sR.rows[0];
    if (share.revoked_at) return res.status(410).json({ error: 'This link has been turned off' });
    if (new Date(share.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'This link has expired' });
    const tR = await pool.query('SELECT * FROM tasks WHERE id = $1 AND archived_at IS NULL', [share.task_id]);
    if (!tR.rows.length) return res.status(404).json({ error: 'This task is no longer available' });
    req.share = share; req.task = tR.rows[0];
    next();
  } catch (e) {
    console.error('loadShare error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}

async function taskPhotos(taskId) {
  try {
    const { rows } = await pool.query(
      "SELECT id, filename, thumb_url, web_url, original_url FROM attachments WHERE entity_type = 'task' AND entity_id = $1 ORDER BY position, created_at",
      [taskId]
    );
    return rows;
  } catch (e) { return []; }
}

// GET /api/task-share/:token
router.get('/task-share/:token', loadShare, async (req, res) => {
  try {
    pool.query('UPDATE task_shares SET opened_at = COALESCE(opened_at, NOW()), last_used_at = NOW() WHERE id = $1', [req.share.id]).catch(function () {});
    const photos = await taskPhotos(req.task.id);
    res.json({
      task: publicTask(req.task),
      photos: photos,
      share: { recipient_name: req.share.recipient_name, needs_name: !req.share.recipient_name, completed: !!req.share.completed_at, expires_at: req.share.expires_at },
      org_name: undefined
    });
  } catch (e) {
    console.error('GET /api/task-share/:token error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/task-share/:token  body: { checklist?, note?, status?, name? }
router.patch('/task-share/:token', loadShare, async (req, res) => {
  try {
    if (req.share.completed_at) return res.status(409).json({ error: 'This task was already completed.' });
    const body = req.body || {};
    // First action captures the worker's name for the audit trail.
    if (body.name && !req.share.recipient_name) {
      await pool.query('UPDATE task_shares SET recipient_name = $1 WHERE id = $2', [String(body.name).trim().slice(0, 120), req.share.id]);
      req.share.recipient_name = String(body.name).trim().slice(0, 120);
    }
    const sets = [], vals = []; let i = 1;
    const cl = normChecklist(body.checklist);
    if (cl) { sets.push('checklist = $' + (i++)); vals.push(JSON.stringify(cl)); }
    if (typeof body.note === 'string' && body.note.trim()) {
      const who = req.share.recipient_name || req.share.recipient_email || 'shared link';
      const stamp = '\n\n— ' + who + ' (via shared link): ' + body.note.trim().slice(0, 2000);
      sets.push('notes = COALESCE(notes, \'\') || $' + (i++)); vals.push(stamp);
    }
    let markDone = false;
    if (body.status && STATUSES.has(String(body.status))) {
      sets.push('status = $' + (i++)); vals.push(String(body.status));
      if (String(body.status) === 'done') { markDone = true; sets.push('completed_at = COALESCE(completed_at, NOW())'); }
    }
    if (!sets.length) return res.json({ ok: true, task: publicTask(req.task) });
    sets.push('updated_at = NOW()');
    vals.push(req.task.id);
    const upd = await pool.query('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = $' + i + ' RETURNING *', vals);
    if (markDone) await pool.query('UPDATE task_shares SET completed_at = NOW(), last_used_at = NOW() WHERE id = $1', [req.share.id]);
    else await pool.query('UPDATE task_shares SET last_used_at = NOW() WHERE id = $1', [req.share.id]);
    res.json({ ok: true, task: publicTask(upd.rows[0]), completed: markDone });
  } catch (e) {
    console.error('PATCH /api/task-share/:token error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/task-share/:token/photo — one image, stored as a task attachment.
router.post('/task-share/:token/photo', loadShare, upload.single('file'), async (req, res) => {
  try {
    if (req.share.completed_at) return res.status(409).json({ error: 'This task was already completed.' });
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file' });
    let buf = req.file.buffer;
    const claimed = req.file.mimetype || 'application/octet-stream';
    const sniffed = sniffMimeFromBytes(buf);
    if (!mimeFamilyMatches(claimed, sniffed)) return res.status(400).json({ error: 'File contents do not match its type' });
    const mime = sniffed || claimed;
    // Guests may upload images only (no PDFs/docs from an outside link).
    if (typeof mime !== 'string' || mime.indexOf('image/') !== 0) return res.status(400).json({ error: 'Only photos can be uploaded here' });
    if (mime === 'image/svg+xml') buf = sanitizeSvg(buf);
    const isRaster = mime !== 'image/svg+xml';

    const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const ext = (req.file.originalname.match(/\.([a-z0-9]+)$/i) || [, 'jpg'])[1].toLowerCase();
    const baseKey = 'task/' + req.task.id + '/' + id;
    let thumbUrl = null, webUrl = null, originalUrl, thumbKey = null, webKey = null, originalKey, width = null, height = null;
    if (isRaster) {
      const meta = await sharp(buf, { limitInputPixels: 50000000 }).rotate().metadata();
      width = meta.width || null; height = meta.height || null;
      const thumbBuf = await sharp(buf, { limitInputPixels: 50000000 }).rotate().resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
      const webBuf = await sharp(buf, { limitInputPixels: 50000000 }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      thumbKey = baseKey + '_thumb.jpg'; webKey = baseKey + '_web.jpg'; originalKey = baseKey + '_orig.' + ext;
      thumbUrl = await storage.put(thumbKey, thumbBuf, 'image/jpeg');
      webUrl = await storage.put(webKey, webBuf, 'image/jpeg');
      originalUrl = await storage.put(originalKey, buf, mime);
    } else {
      originalKey = baseKey + '_orig.' + ext;
      originalUrl = await storage.put(originalKey, buf, mime);
    }
    const posR = await pool.query("SELECT COALESCE(MAX(position), -1) AS max_pos FROM attachments WHERE entity_type = 'task' AND entity_id = $1", [req.task.id]);
    const position = (posR.rows[0] && posR.rows[0].max_pos != null) ? Number(posR.rows[0].max_pos) + 1 : 0;
    const ins = await pool.query(
      `INSERT INTO attachments (id, entity_type, entity_id, folder, filename, mime_type, size_bytes, width, height, thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, uploaded_by)
       VALUES ($1,'task',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, filename, thumb_url, web_url, original_url`,
      [id, req.task.id, 'general', req.file.originalname, mime, buf.length, width, height, thumbUrl, webUrl, originalUrl, thumbKey, webKey, originalKey, position, null]
    );
    pool.query('UPDATE task_shares SET last_used_at = NOW() WHERE id = $1', [req.share.id]).catch(function () {});
    res.json({ ok: true, attachment: ins.rows[0] });
  } catch (e) {
    console.error('POST /api/task-share/:token/photo error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

module.exports = router;
