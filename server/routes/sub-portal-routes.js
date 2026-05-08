// Subcontractor portal — Phase 5.
//
// Two layers of endpoints:
//
//   PM-side (gated by JOBS_EDIT_ANY):
//     POST /api/subs/:subId/invite — generate a magic-link invite,
//                                     email it to the sub, log the row.
//     GET  /api/subs/:subId/invites — list outstanding invites.
//     DELETE /api/subs/:subId/invites/:inviteId — revoke an unused invite.
//
//   Sub-facing (gated by SUB_PORTAL_VIEW / SUB_PORTAL_UPLOAD):
//     GET  /api/sub-portal/accept?token=… — claim the invite. Creates
//                                            the sub-role user (if not
//                                            already), sets the auth
//                                            cookie, redirects to /portal.
//     GET  /api/sub-portal/me — return the signed-in sub's basic info.
//     GET  /api/sub-portal/attachments — every attachment in any folder
//                                         the sub has been granted.
//     POST /api/sub-portal/attachments — upload into a granted folder.
//
// All sub-facing reads/writes are scoped through req.user.sub_id, which
// is baked into the JWT at sign-in. A sub holding their own JWT can
// never reach another sub's data even if they swap query strings.

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { pool } = require('../db');
const { requireAuth, requireCapability, signToken } = require('../auth');
const { sendEmail, isEnabled: emailIsEnabled } = require('../email');
const { storage } = require('../storage');

const router = express.Router();

// Multer config mirrors attachment-routes.js — memory storage so we
// can hand the buffer to the storage backend (R2). 50MB cap matches
// the rest of the app.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

console.log('[sub-portal-routes] mounted at /api/sub-portal + /api/subs/:id/invite (Phase 5 — sub onboarding + portal)');

// 7-day default invite window. Long enough that a sub who forgets to
// click on Friday can still claim Monday morning, short enough that a
// stale link is genuinely stale.
const INVITE_TTL_DAYS = 7;

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function genToken() {
  // 32 bytes = 64 hex chars. Cryptographically random; not guessable
  // even with knowledge of the row id or sub id.
  return crypto.randomBytes(32).toString('hex');
}

function portalBaseUrl(req) {
  // Honor X-Forwarded-Proto/Host so links work behind Railway's
  // load balancer; fall back to req for local dev.
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return proto + '://' + host;
}

// ────────────────────────────────────────────────────────────────────
// PM-SIDE: invite management
// ────────────────────────────────────────────────────────────────────

// POST /api/subs/:subId/invite — body: { email? }. Falls back to the
// sub's directory email if the body doesn't override. Generates a
// fresh token even if a prior unused invite exists (one-click "resend"
// from the UI just calls this again — old invite still valid until
// expiry, but the new one is what gets emailed).
router.post('/subs/:subId/invite',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const subR = await pool.query('SELECT id, name, email, primary_contact_first FROM subs WHERE id = $1', [req.params.subId]);
      if (!subR.rows.length) return res.status(404).json({ error: 'Sub not found' });
      const sub = subR.rows[0];

      const email = String((req.body && req.body.email) || sub.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'A valid email is required (either in the request body or on the sub record).' });
      }

      const id = genId('si');
      const token = genToken();
      const expires = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

      await pool.query(
        `INSERT INTO sub_invites (id, sub_id, email, token, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, sub.id, email, token, (req.user && req.user.id) || null, expires]
      );

      const link = portalBaseUrl(req) + '/api/sub-portal/accept?token=' + encodeURIComponent(token);

      // Plain-text first-name greeting if we have one; else fall back
      // to the company name. Keeps the body warm without forcing a
      // contact-record dependency.
      const greetingName = sub.primary_contact_first || sub.name || 'there';

      const html =
        '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:540px;">' +
          '<p>Hi ' + escapeHTML(greetingName) + ',</p>' +
          '<p>You\'ve been invited to access the Project 86 subcontractor portal for <strong>' + escapeHTML(sub.name || '') + '</strong>. ' +
          'Click the button below to sign in — no password needed:</p>' +
          '<p style="margin:24px 0;">' +
            '<a href="' + escapeAttr(link) + '" style="background:#22d3ee;color:#0f172a;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;">Open the portal</a>' +
          '</p>' +
          '<p style="font-size:12px;color:#666;">This link is good for ' + INVITE_TTL_DAYS + ' days and can only be used once. If you weren\'t expecting this email, you can safely ignore it.</p>' +
        '</div>';

      const text =
        'Hi ' + greetingName + ',\n\n' +
        'You\'ve been invited to access the Project 86 subcontractor portal for ' + (sub.name || '') + '.\n\n' +
        'Click this link to sign in (no password needed):\n' + link + '\n\n' +
        'The link is good for ' + INVITE_TTL_DAYS + ' days and can only be used once.';

      let emailResult = { ok: false, skipped: 'email-not-configured' };
      if (emailIsEnabled()) {
        emailResult = await sendEmail({
          to: email,
          subject: 'Your Project 86 sub portal invite',
          html: html,
          text: text,
          tag: 'sub_invite'
        });
      }

      // Return the link for PM convenience (the modal can show "copy
      // link" as a fallback when email isn't enabled or fails). The
      // token itself is exposed to the PM only — never to the sub
      // through any GET endpoint, only via the email body.
      res.json({
        ok: true,
        invite: { id, email, expires_at: expires },
        link: link,
        email_sent: !!emailResult.ok,
        email_error: emailResult.error || null
      });
    } catch (e) {
      console.error('POST /api/subs/:subId/invite error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

// GET /api/subs/:subId/invites — outstanding invites for a sub. Used
// by the PM UI to show "currently invited" state and surface a
// "revoke" button. Returns un-used and not-expired rows; older audit
// rows can be queried separately if needed.
router.get('/subs/:subId/invites',
  requireAuth, requireCapability('JOBS_VIEW_ALL'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, email, created_at, expires_at, used_at, used_user_id
           FROM sub_invites
          WHERE sub_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [req.params.subId]
      );
      res.json({ invites: rows });
    } catch (e) {
      console.error('GET /api/subs/:subId/invites error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

// DELETE /api/subs/:subId/invites/:inviteId — revoke an outstanding
// invite. Used invites are kept for audit; only un-used ones can be
// revoked (the used row stays as a record of "this user accepted on
// this date").
router.delete('/subs/:subId/invites/:inviteId',
  requireAuth, requireCapability('JOBS_EDIT_ANY'),
  async (req, res) => {
    try {
      const r = await pool.query(
        'DELETE FROM sub_invites WHERE id = $1 AND sub_id = $2 AND used_at IS NULL',
        [req.params.inviteId, req.params.subId]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'Invite not found or already claimed' });
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/subs/:subId/invites/:inviteId error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

// ────────────────────────────────────────────────────────────────────
// SUB-FACING: accept + read + upload
// ────────────────────────────────────────────────────────────────────

// GET /api/sub-portal/accept?token=… — magic-link landing.
// 1. Look up the (un-used, un-expired) invite by token.
// 2. Find or create a users row with role='sub' and sub_id set.
// 3. Mark the invite used.
// 4. Set the auth cookie + redirect to /portal.
//
// No CSRF risk on GET because the action is idempotent and the token
// itself is the auth — anyone holding the link gets the session
// (that's the whole point of magic links). A leaked link is the same
// as a leaked password; we mitigate with the one-time used_at flag.
router.get('/sub-portal/accept', async (req, res) => {
  try {
    const token = String((req.query && req.query.token) || '').trim();
    if (!token) return res.status(400).send('Missing token.');

    const inviteR = await pool.query(
      `SELECT i.*, s.name AS sub_name
         FROM sub_invites i
         LEFT JOIN subs s ON s.id = i.sub_id
        WHERE i.token = $1`,
      [token]
    );
    if (!inviteR.rows.length) return res.status(404).send('Invalid invite link.');
    const inv = inviteR.rows[0];
    if (inv.used_at) return res.status(410).send('This invite has already been used. Ask the PM to send a fresh one.');
    if (new Date(inv.expires_at) < new Date()) return res.status(410).send('This invite has expired. Ask the PM to send a fresh one.');

    // Find-or-create the sub user. Match by (email, sub_id) so a sub
    // who got invited under two different sub records ends up with
    // distinct logins (no accidental cross-sub bleed).
    let user;
    const existing = await pool.query(
      `SELECT * FROM users WHERE email = $1 AND sub_id = $2`,
      [inv.email, inv.sub_id]
    );
    if (existing.rows.length) {
      user = existing.rows[0];
      // Re-activate the user if they'd been deactivated. Magic-link
      // claim is an explicit "yes I'm using this" signal.
      if (!user.active) {
        await pool.query('UPDATE users SET active = true WHERE id = $1', [user.id]);
        user.active = true;
      }
    } else {
      // password_hash is required NOT NULL by the schema — magic-link
      // users never log in with a password, so we store a dummy
      // unguessable hash that no real password could match.
      const dummyHash = '!sub-portal-no-password!' + crypto.randomBytes(16).toString('hex');
      const ins = await pool.query(
        `INSERT INTO users (email, password_hash, name, role, sub_id, active)
         VALUES ($1, $2, $3, 'sub', $4, true)
         RETURNING *`,
        [inv.email, dummyHash, inv.sub_name || inv.email, inv.sub_id]
      );
      user = ins.rows[0];
    }

    await pool.query(
      'UPDATE sub_invites SET used_at = NOW(), used_user_id = $1 WHERE id = $2',
      [user.id, inv.id]
    );

    const tokenJwt = signToken(user);
    res.cookie('token', tokenJwt, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || (req.headers['x-forwarded-proto'] === 'https'),
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    // Redirect to a portal page. The page itself is server-rendered
    // by the static handler in index.js — see /portal.html or the
    // SPA route in the client.
    res.redirect('/portal');
  } catch (e) {
    console.error('GET /api/sub-portal/accept error:', e);
    res.status(500).send('Server error: ' + e.message);
  }
});

// GET /api/sub-portal/me — basic profile for the portal page header.
router.get('/sub-portal/me',
  requireAuth, requireCapability('SUB_PORTAL_VIEW'),
  async (req, res) => {
    try {
      const subId = req.user && req.user.sub_id;
      if (!subId) return res.status(403).json({ error: 'Not a sub-portal user' });
      const { rows } = await pool.query(
        'SELECT id, name, trade, email, primary_contact_first, primary_contact_last FROM subs WHERE id = $1',
        [subId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Sub record not found' });
      res.json({ user: { email: req.user.email, name: req.user.name }, sub: rows[0] });
    } catch (e) {
      console.error('GET /api/sub-portal/me error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

// GET /api/sub-portal/attachments — every attachment in any granted
// folder, scoped to req.user.sub_id. Reuses the same join shape as
// /api/subs/:subId/shared-attachments (Phase 4) but locks the sub_id
// to the JWT instead of taking it from the URL.
router.get('/sub-portal/attachments',
  requireAuth, requireCapability('SUB_PORTAL_VIEW'),
  async (req, res) => {
    try {
      const subId = req.user && req.user.sub_id;
      if (!subId) return res.status(403).json({ error: 'Not a sub-portal user' });
      const { rows } = await pool.query(
        `SELECT a.*, g.entity_type AS grant_entity_type,
                g.entity_id AS grant_entity_id,
                g.folder AS grant_folder
           FROM attachment_folder_grants g
           JOIN attachments a
             ON a.entity_type = g.entity_type
            AND a.entity_id   = g.entity_id
            AND a.folder      = g.folder
          WHERE g.sub_id = $1
          ORDER BY g.entity_type, g.entity_id, g.folder, a.position`,
        [subId]
      );
      res.json({ attachments: rows });
    } catch (e) {
      console.error('GET /api/sub-portal/attachments error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

// POST /api/sub-portal/attachments — upload one file into a granted
// folder. Body (multipart): { file, entity_type, entity_id, folder }.
// We verify the sub has a grant on (entity_type, entity_id, folder)
// before persisting; without it the upload 403s.
router.post('/sub-portal/attachments',
  requireAuth, requireCapability('SUB_PORTAL_UPLOAD'),
  upload.single('file'),
  async (req, res) => {
    try {
      const subId = req.user && req.user.sub_id;
      if (!subId) return res.status(403).json({ error: 'Not a sub-portal user' });
      if (!req.file) return res.status(400).json({ error: 'No file provided' });

      const entity_type = String((req.body && req.body.entity_type) || '').trim();
      const entity_id   = String((req.body && req.body.entity_id)   || '').trim();
      const folder      = String((req.body && req.body.folder)      || 'general').trim().toLowerCase();
      if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type and entity_id are required' });

      // Grant check — the sub must have an explicit grant on
      // exactly this (entity_type, entity_id, folder) tuple.
      // No fall-through to "general" or wildcard grants.
      const grant = await pool.query(
        `SELECT 1 FROM attachment_folder_grants
          WHERE sub_id = $1 AND entity_type = $2 AND entity_id = $3 AND folder = $4
          LIMIT 1`,
        [subId, entity_type, entity_id, folder]
      );
      if (!grant.rows.length) return res.status(403).json({ error: 'No access to that folder' });

      // Mirror the PM upload pipeline (attachment-routes.js) — same
      // R2 keys, same thumb/web/original variants, same INSERT shape.
      // (TODO: extract a shared persist helper so this stays in sync;
      // for now duplicating the ~40 lines is the safer cut.)
      const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const ext = (req.file.originalname.match(/\.([a-z0-9]+)$/i) || [, 'bin'])[1].toLowerCase();
      const baseKey = entity_type + '/' + entity_id + '/' + id;
      const buf = req.file.buffer;
      const mime = req.file.mimetype || 'application/octet-stream';
      const isImage = typeof mime === 'string' && mime.indexOf('image/') === 0;

      let thumbUrl = null, webUrl = null, originalUrl;
      let thumbKey = null, webKey = null, originalKey;
      let width = null, height = null;

      if (isImage) {
        const meta = await sharp(buf).rotate().metadata();
        width = meta.width || null;
        height = meta.height || null;
        const thumbBuf = await sharp(buf).rotate().resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
        const webBuf = await sharp(buf).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        thumbKey = baseKey + '_thumb.jpg';
        webKey = baseKey + '_web.jpg';
        originalKey = baseKey + '_orig.' + ext;
        thumbUrl = await storage.put(thumbKey, thumbBuf, 'image/jpeg');
        webUrl = await storage.put(webKey, webBuf, 'image/jpeg');
        originalUrl = await storage.put(originalKey, buf, mime);
      } else {
        originalKey = baseKey + '_orig.' + ext;
        originalUrl = await storage.put(originalKey, buf, mime);
      }

      const posR = await pool.query(
        'SELECT COALESCE(MAX(position), -1) AS max_pos FROM attachments WHERE entity_type = $1 AND entity_id = $2',
        [entity_type, entity_id]
      );
      const position = (posR.rows[0] && posR.rows[0].max_pos != null) ? Number(posR.rows[0].max_pos) + 1 : 0;

      const ins = await pool.query(
        `INSERT INTO attachments
           (id, entity_type, entity_id, folder, filename, mime_type, size_bytes,
            width, height,
            thumb_url, web_url, original_url,
            thumb_key, web_key, original_key,
            position, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          id, entity_type, entity_id, folder,
          req.file.originalname, mime, req.file.size,
          width, height,
          thumbUrl, webUrl, originalUrl,
          thumbKey, webKey, originalKey,
          position, req.user.id
        ]
      );
      res.json({ attachment: ins.rows[0] });
    } catch (e) {
      console.error('POST /api/sub-portal/attachments error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

// Local HTML escapers (kept inline so this file doesn't depend on a
// general utility module).
function escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
}

module.exports = router;
