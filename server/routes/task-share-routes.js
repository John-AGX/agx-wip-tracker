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
// Sender identity helpers — a separate, never-mocked module (see its header).
const emailSender = require('../email-sender');
// The one tenancy rule for a caller-supplied sub id (tolerant of legacy
// un-stamped rows), written once in the service rather than again here.
const { parentSubInOrgSql } = require('../services/sub-org-scope');
const { storage } = require('../storage');
const { sniffMimeFromBytes, sanitizeSvg, mimeFamilyMatches } = require('../util/attachment-mime');
// Job labels go through js/job-label.js inside this resolver, so the outside
// worker reads the same "RV2006 Waterside 1" the office does.
const { resolveEntityLabels } = require('../services/entity-labels');
// A task on a work order (a building on its punch list) sent on a task link is
// finished or reopened through the same door as the crew's ticket link: the
// ticket is locked, the crew rule is checked on the locked row, a completion
// photo is required, and the ticket follows its buildings.
const workOrder = require('../services/service-ticket-workorder');
const subtaskDoor = require('../services/service-ticket-subtask-door');

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

// Which linked-record types get NAMED to an outside worker. A whitelist:
// job (jobNumber + title) and lead (its title) are the sanctioned
// forward-facing names. A task linked to a client, sub, estimate or project
// stays anonymous — the guest holds a token, not a login.
//
// This deliberately lives OUTSIDE publicTask(): entity_type / entity_id are
// still withheld from the guest, and only the composed string ships. It is
// also a separate top-level key rather than a field on the task, because the
// PATCH response returns publicTask() alone — a label parked on the task
// would vanish the moment the worker ticked a checkbox.
const SHARE_LABEL_TYPES = new Set(['job', 'lead']);

// null whenever there is nothing safe or nothing at all to say: an unlinked
// task (tasks.entity_type is nullable), a type off the whitelist, or a
// record that no longer resolves. The page then simply omits the line —
// never "job", "null", or a raw id.
async function linkedLabel(task) {
  try {
    if (!task || !task.entity_type || task.entity_id == null) return null;
    if (!SHARE_LABEL_TYPES.has(task.entity_type)) return null;
    const key = task.entity_type + ':' + String(task.entity_id);
    const labels = await resolveEntityLabels(task.organization_id || null,
      [{ entity_type: task.entity_type, entity_id: task.entity_id }]);
    return labels.get(key) || null;
  } catch (e) {
    return null;
  }
}

// ── PM-side ─────────────────────────────────────────────────────────────────

// POST /api/tasks/:id/share  body: { sub_id?, email?, name?, days? }
router.post('/tasks/:id/share', requireAuth, async (req, res) => {
  try {
    const orgId = req.user && req.user.organization_id;
    // TWO STATEMENTS, NOT A JOIN, ON PURPOSE. The building check below needs
    // the ticket's number to name it, but folding that into this read as a
    // LEFT JOIN would rewrite the statement every OTHER path through this
    // handler depends on — the sender identity, the sub fill-in and the org
    // term — for a column only the refusal path ever reads. The ticket lookup
    // is therefore a second query that only a task actually carrying a ticket
    // id ever runs, and that path returns 409 immediately, so the ordinary
    // share costs exactly the one read it always did.
    const tR = await pool.query('SELECT id, title, organization_id, scope, service_ticket_id, archived_at FROM tasks WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL', [req.params.id, orgId]);
    if (!tR.rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = tR.rows[0];

    // A BUILDING IS NOT SHAREABLE AS A TASK. The guest page a single-task link
    // opens is task-shaped: it knows nothing about the photo rule, the ticket's
    // status, approvals or the rest of the punch list, and a building finished
    // through it is a building finished behind the work order's back. The work
    // order already has its own crew link, which carries all of that — so this
    // door is closed rather than taught. Refused BEFORE anything is validated
    // or written: no task_shares row, no email.
    if (subtaskDoor.isWorkOrderSubtask(task)) {
      // The task's OWN organization_id, the one the read above proved — so a
      // ticket id pointing at another tenant's work order names nothing and
      // the refusal falls back to the generic wording.
      const stR = await pool.query(
        'SELECT ticket_number, title FROM service_tickets WHERE id = $1 AND organization_id = $2',
        [task.service_ticket_id, task.organization_id]);
      const st = stR.rows[0] || {};
      const label = st.ticket_number || st.title || 'a work order';
      return res.status(409).json({
        error: 'This is a building on ' + label + ' — send the work-order link.',
        code: 'work_order_building',
      });
    }

    const body = req.body || {};
    let subId = body.sub_id ? String(body.sub_id) : null;
    let email = String(body.email || '').trim().toLowerCase();
    let name = String(body.name || '').trim() || null;
    if (subId) {
      // The sub must be this tenant's (or a legacy un-stamped row). Unscoped, a
      // foreign sub_id filled in ANOTHER tenant's sub email and contact name as
      // the recipient — this org's task, link and name mailed to a vendor it
      // has never met. A foreign id now answers exactly like an absent one: no
      // fill-in, no foreign id stamped onto the share row, and without a typed
      // email the request is refused below.
      const sR = await pool.query(
        'SELECT id, name, email, primary_contact_first FROM subs WHERE id = $1 AND ' + parentSubInOrgSql('subs.id', '$2'),
        [subId, task.organization_id]);
      if (sR.rows.length) {
        if (!email) email = String(sR.rows[0].email || '').trim().toLowerCase();
        if (!name) name = sR.rows[0].primary_contact_first || sR.rows[0].name || null;
      } else {
        subId = null;
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

    // realOrgName stays null on a miss: the body and subject need words and fall
    // back to 'Project 86', but the From line must not, or it would read
    // "Project 86 via Project 86".
    let realOrgName = null;
    try { const oR = await pool.query('SELECT name FROM organizations WHERE id = $1', [task.organization_id]); if (oR.rows.length && oR.rows[0].name) realOrgName = oR.rows[0].name; } catch (e) {}
    const orgName = realOrgName || 'Project 86';

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
      // Company-branded From, and a reply reaches the office user who shared
      // it: their fresh users row in the task's org (none under act-as). Never
      // the typed recipient.
      const replyTo = await emailSender.replyToForUser(pool, req.user && req.user.id, task.organization_id);
      sent = await sendEmail({
        to: email, subject: orgName + ' sent you a task: ' + task.title, html: html, text: text, tag: 'task_share',
        organizationId: task.organization_id,
        senderOrg: realOrgName ? { id: task.organization_id, name: realOrgName } : { id: task.organization_id },
        replyTo: replyTo || false
      });
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
      "SELECT id, filename, thumb_url, web_url, original_url, lat, lng FROM attachments WHERE entity_type = 'task' AND entity_id = $1 ORDER BY position, uploaded_at",
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
    let orgName = null;
    try { const o = await pool.query('SELECT name FROM organizations WHERE id = $1', [req.task.organization_id]); if (o.rows.length) orgName = o.rows[0].name; } catch (e) {}
    // Which job this task belongs to. Without it a worker completing a
    // shared task had the title and nothing else — no idea which site.
    const linked = await linkedLabel(req.task);
    res.json({
      task: publicTask(req.task),
      photos: photos,
      share: { recipient_name: req.share.recipient_name, needs_name: !req.share.recipient_name, completed: !!req.share.completed_at, expires_at: req.share.expires_at },
      org_name: orgName,
      linked_label: linked,
      // Client Maps key (same one the app exposes) so the guest page can show a
      // static map preview of the pin. Referrer-restricted to our domain.
      maps_key: process.env.GOOGLE_MAPS_API_KEY || null
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
    let doorResult = null;
    const statusIn = body.status && STATUSES.has(String(body.status)) ? String(body.status) : null;
    const flipsDone = !!statusIn && (statusIn === 'done') !== (req.task.status === 'done');
    const actor = { kind: 'share', shareId: null, label: req.share.recipient_name || req.share.recipient_email || null };
    const building = !!statusIn && subtaskDoor.isWorkOrderSubtask(req.task);
    let ticket = null;
    if (building) {
      const tR = await pool.query('SELECT * FROM service_tickets WHERE id = $1 AND organization_id = $2',
        [req.task.service_ticket_id, req.task.organization_id]);
      ticket = tR.rows[0] || null;
      if (!ticket) return res.status(404).json({ error: 'This work order is no longer available.' });
    }
    // The remaining write. On a building it runs inside the ticket lock, on the
    // same client; on anything else it runs on the pool.
    const writeRest = async function (db, guard) {
      if (!sets.length) {
        const again = await db.query('SELECT * FROM tasks WHERE id = $1 AND organization_id = $2', [req.task.id, req.task.organization_id]);
        return again.rows[0];
      }
      sets.push('updated_at = NOW()');
      vals.push(req.task.id, req.task.organization_id);
      const upd = await db.query('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = $' + i + ' AND organization_id = $' + (i + 1) + (guard || '') + ' RETURNING *', vals);
      return upd.rows[0] || null;
    };
    let row;
    if (ticket) {
      // A status on a building is decided under the ticket lock, on the task
      // row as it is there (A10): the link's copy was read before the lock, and
      // a building the office finished (or moved) in between is refused rather
      // than written over. Done-ness goes through the door, which writes the
      // task's status and completed_at itself; In progress / Blocked / Open are
      // written on top, in the same transaction.
      doorResult = await workOrder.withTicketLock(pool, ticket, async function (client, locked) {
        const fresh = await client.query('SELECT * FROM tasks WHERE id = $1 AND organization_id = $2 FOR UPDATE',
          [req.task.id, req.task.organization_id]);
        if (subtaskDoor.taskShifted(req.task, fresh.rows[0])) return subtaskDoor.stale();
        let result = { ok: true, ticket: locked, ticketStatus: locked.status, movedTo: null };
        if (flipsDone) {
          result = await workOrder.setSubtaskDone(client, {
            ticket: locked,
            taskId: req.task.id,
            done: statusIn === 'done',
            actor: actor,
            gate: subtaskDoor.crewGate,
          });
          if (!result.ok) return result;
        }
        if (statusIn !== 'done') { sets.push('status = $' + (i++)); vals.push(statusIn); }
        const written = await writeRest(client);
        if (!written) return subtaskDoor.stale();
        return Object.assign({}, result, { row: written });
      });
      if (!doorResult.ok) {
        const refusal = { error: doorResult.error };
        if (doorResult.code) refusal.code = doorResult.code;
        return res.status(doorResult.status || 409).json(refusal);
      }
      if (statusIn === 'done') markDone = true;
      row = doorResult.row;
    } else {
      // An org task read on no work order writes its status only while it is
      // still on none: one put on a work order in between is a building now.
      let guard = '';
      if (statusIn) {
        sets.push('status = $' + (i++)); vals.push(statusIn);
        if (statusIn === 'done') { markDone = true; sets.push('completed_at = COALESCE(completed_at, NOW())'); }
        if (req.task.scope === 'org') guard = ' AND service_ticket_id IS NULL';
      }
      if (!sets.length) return res.json({ ok: true, task: publicTask(req.task) });
      row = await writeRest(pool, guard);
      if (!row && guard) {
        const stale = subtaskDoor.stale();
        return res.status(stale.status).json({ error: stale.error, code: stale.code });
      }
    }
    if (markDone) await pool.query('UPDATE task_shares SET completed_at = NOW(), last_used_at = NOW() WHERE id = $1', [req.share.id]);
    else await pool.query('UPDATE task_shares SET last_used_at = NOW() WHERE id = $1', [req.share.id]);
    // After the write committed: the last building done tells the approvers,
    // naming the office user who sent this link.
    if (doorResult) {
      subtaskDoor.notifyMoves([{ ticket: doorResult.ticket, movedTo: doorResult.movedTo }], actor, req.share.created_by);
    }
    const out = { ok: true, task: publicTask(row || req.task), completed: markDone };
    // Shared contracts §4: a door write says what the work order did, so the
    // link page can say "awaiting approval" or "back in progress". Status and
    // id only — nothing about the job's money reaches the link.
    if (doorResult) {
      out.work_order = { ticket_id: ticket.id, ticket_status: doorResult.ticketStatus, moved_to: doorResult.movedTo || null };
    }
    res.json(out);
  } catch (e) {
    console.error('PATCH /api/task-share/:token error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/task-share/:token/photo — one image, stored as a task attachment.
router.post('/task-share/:token/photo', loadShare, upload.single('file'), async (req, res) => {
  try {
    if (req.share.completed_at) return res.status(409).json({ error: 'This task was already completed.' });
    // A building on a work order the office has approved (or closed, or not
    // issued) takes no more photos from a link — its photos are the record.
    if (subtaskDoor.isWorkOrderSubtask(req.task)) {
      const tR = await pool.query('SELECT status FROM service_tickets WHERE id = $1 AND organization_id = $2',
        [req.task.service_ticket_id, req.task.organization_id]);
      if (tR.rows[0]) {
        const gate = subtaskDoor.crewGate(tR.rows[0]);
        if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });
      }
    }
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
      // uploaded_by is NULL by design — this door is a logged-out crew member
      // completing a shared task, so there is no user to attribute. That made
      // it look like the one attachment population whose tenant could never be
      // derived: no uploader (rung 3) and no stamp (rung 2).
      //
      // It is derivable after all, and the value was already in hand. The
      // parent is a TASK, tasks.organization_id is NOT NULL (server/db.js), and
      // loadShare already SELECTed the whole row onto req.task before this
      // handler ran. So the row is stamped from evidence — the same evidence
      // attachmentInOrg's rung 1 uses to resolve it on read.
      `INSERT INTO attachments (id, entity_type, entity_id, folder, filename, mime_type, size_bytes, width, height, thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, uploaded_by, organization_id)
       VALUES ($1,'task',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, filename, thumb_url, web_url, original_url`,
      [id, req.task.id, 'general', req.file.originalname, mime, buf.length, width, height, thumbUrl, webUrl, originalUrl, thumbKey, webKey, originalKey, position, null, req.task.organization_id]
    );
    pool.query('UPDATE task_shares SET last_used_at = NOW() WHERE id = $1', [req.share.id]).catch(function () {});
    res.json({ ok: true, attachment: ins.rows[0] });
  } catch (e) {
    console.error('POST /api/task-share/:token/photo error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

module.exports = router;
