const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, getOrgById } = require('../db');
const { signToken, requireAuth, requireRole, resolveUserOrg } = require('../auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 AND active = true', [email.toLowerCase().trim()]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  // Resolve the caller's organization so the frontend can show
  // "Logged into AGX" and use the slug for any per-org navigation.
  // Doesn't fail the response if the lookup errors — /me has to
  // stay functional even if the org row is briefly unreachable.
  let organization = null;
  try {
    const org = await resolveUserOrg(req);
    if (org) {
      organization = {
        id: org.id,
        slug: org.slug,
        name: org.name,
        description: org.description
      };
    }
  } catch (_) { /* keep going */ }

  // Surface server-side feature flags to the client so the UI can flip
  // experimental code paths without a redeploy. Read from env on every
  // request so flipping a Railway env var takes effect immediately
  // (matches the lazy-load pattern in ai-routes.getAnthropic).
  const featureFlags = {
    // Phase 1b — when 'agents', the AG estimating chat panel hits
    // /api/ai/v2/estimates/:id/chat (Sessions API) instead of the
    // legacy /api/ai/estimates/:id/chat (messages.stream).
    agent_mode_ag: (process.env.AGENT_MODE_47 || '').toLowerCase() === 'agents' ? 'agents' : 'legacy',
    // Phase 2 — same flip for 86 (jobs). Independent ramp so AG
    // telemetry can prove the Sessions path before 86 moves over.
    agent_mode_job: (process.env.AGENT_MODE_86 || '').toLowerCase() === 'agents' ? 'agents' : 'legacy',
    // Phase 2 — same flip for HR (clients) and CoS (staff). All four
    // ramp independently; production stays on v1 until each env var
    // flips.
    agent_mode_cra:   (process.env.AGENT_MODE_HR   || '').toLowerCase() === 'agents' ? 'agents' : 'legacy',
    agent_mode_staff: (process.env.AGENT_MODE_STAFF || '').toLowerCase() === 'agents' ? 'agents' : 'legacy'
    // Note: there is no agent_mode_intake. 86 owns the lead-intake
    // flow now, so the "🧲 New Lead with AI" entry point gates on
    // agent_mode_job (= AGENT_MODE_86) rather than a separate flag.
  };
  res.json({ user: req.user, organization: organization, feature_flags: featureFlags });
});

// POST /api/auth/register (admin only)
router.post('/register', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { email, password, name, role, phone_number } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name required' });
    }
    const validRoles = ['admin', 'corporate', 'pm'];
    const userRole = validRoles.includes(role) ? role : 'pm';

    // Phone is optional. When supplied, normalize to E.164 so the SMS
    // webhook can match by exact equality. Reject if it's set but
    // unparseable so admins notice typos at create time.
    let normalizedPhone = null;
    if (phone_number != null && String(phone_number).trim() !== '') {
      const sms = require('../sms');
      normalizedPhone = sms.normalizeUSPhone(phone_number);
      if (!normalizedPhone) {
        return res.status(400).json({ error: 'Phone number not recognized — use 10 digits or +1XXXXXXXXXX' });
      }
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = bcrypt.hashSync(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name, role, phone_number) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [email.toLowerCase().trim(), hash, name, userRole, normalizedPhone]
    );

    // Fire the invite email — fire-and-forget so a flaky email
    // service never blocks user creation. Failures land in email_log
    // and the admin can resend manually.
    try {
      const { sendEmail } = require('../email');
      const { newUserInvite } = require('../email-templates');
      const tpl = newUserInvite({
        name: name,
        email: email.toLowerCase().trim(),
        password: password,
        invitedBy: req.user && req.user.name ? req.user.name : 'An admin'
      });
      sendEmail({
        to: email.toLowerCase().trim(),
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        tag: 'new_user_invite'
      }).catch((e) => console.warn('[auth] invite email failed:', e && e.message));
    } catch (e) {
      console.warn('[auth] invite email setup failed:', e && e.message);
    }

    res.json({ id: result.rows[0].id, email: email.toLowerCase().trim(), name, role: userRole });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/users
// All authenticated users can list the org directory. Needed so that PM
// owners can populate the grant-access picker on jobs they own. Data
// returned is minimal (id/email/name/role/active/created_at) — same as
// what's needed for the admin Users table, with no auth secrets.
// notification_prefs included so clients can show "this user has muted
// schedule notifications" hints in the assignment UI.
router.get('/users', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, role, active, phone_number, notification_prefs, created_at, last_seen_at FROM users'
    );
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/active-users — count of users seen in the last
// `threshold` minutes (default 5). Drives the "Online Now" metric
// card on Admin → Metrics. Cheap query backed by idx_users_last_seen_at.
// Admin-only because it leaks aggregate presence info.
router.get('/active-users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const threshold = Math.max(1, Math.min(60, parseInt(req.query.threshold, 10) || 5));
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS active_count " +
      "FROM users " +
      "WHERE active = TRUE AND last_seen_at IS NOT NULL " +
      "  AND last_seen_at > NOW() - ($1 || ' minutes')::interval",
      [String(threshold)]
    );
    res.json({
      activeCount: rows[0].active_count,
      asOf: new Date().toISOString(),
      thresholdMinutes: threshold
    });
  } catch (e) {
    console.error('GET /api/auth/active-users error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/me/notification-prefs
// User edits their OWN notification preferences. Body: { prefs: {...} }
// where prefs is the JSONB blob — opt-out keys (false = don't send).
// Admin can update any user via PUT /api/auth/users/:id/notification-prefs.
router.put('/me/notification-prefs', requireAuth, async (req, res) => {
  try {
    const prefs = (req.body && req.body.prefs && typeof req.body.prefs === 'object')
      ? req.body.prefs
      : {};
    await pool.query(
      'UPDATE users SET notification_prefs = $1::jsonb, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(prefs), req.user.id]
    );
    res.json({ ok: true, prefs: prefs });
  } catch (e) {
    console.error('PUT /me/notification-prefs error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/users/:id/notification-prefs', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const prefs = (req.body && req.body.prefs && typeof req.body.prefs === 'object')
      ? req.body.prefs
      : {};
    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await pool.query(
      'UPDATE users SET notification_prefs = $1::jsonb, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(prefs), req.params.id]
    );
    res.json({ ok: true, prefs: prefs });
  } catch (e) {
    console.error('PUT /users/:id/notification-prefs error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/users/:id (admin only)
router.put('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { name, role, active, phone_number } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // phone_number is optional. If present in the body:
    //   - empty string clears it (sets NULL)
    //   - any other value gets normalized to E.164
    // Absent from the body = leave whatever was there.
    let phoneUpdate = user.phone_number;
    if (Object.prototype.hasOwnProperty.call(req.body, 'phone_number')) {
      if (phone_number == null || String(phone_number).trim() === '') {
        phoneUpdate = null;
      } else {
        const sms = require('../sms');
        const normalized = sms.normalizeUSPhone(phone_number);
        if (!normalized) {
          return res.status(400).json({ error: 'Phone number not recognized — use 10 digits or +1XXXXXXXXXX' });
        }
        phoneUpdate = normalized;
      }
    }

    await pool.query(
      'UPDATE users SET name = $1, role = $2, active = $3, phone_number = $4, updated_at = NOW() WHERE id = $5',
      [name || user.name, role || user.role, active != null ? active : user.active, phoneUpdate, req.params.id]
    );

    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'That phone number is already used by another user' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/users/:id/password (admin resets any user's password)
router.put('/users/:id/password', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'New password required (min 4 chars)' });
    }
    const { rows } = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const targetUser = rows[0];
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [bcrypt.hashSync(newPassword, 10), req.params.id]
    );

    // Email the user their new password — security tradeoff is
    // deliberate: Project 86 is small + admin-driven. Auth flow is "admin
    // hands you credentials" not "you self-serve via reset link".
    // Future flow with token-based resets would replace this.
    try {
      const { sendEmail } = require('../email');
      const { passwordReset } = require('../email-templates');
      const tpl = passwordReset({
        name: targetUser.name,
        email: targetUser.email,
        password: newPassword,
        resetBy: req.user && req.user.name ? req.user.name : 'An admin'
      });
      sendEmail({
        to: targetUser.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        tag: 'password_reset'
      }).catch((e) => console.warn('[auth] password reset email failed:', e && e.message));
    } catch (e) {
      console.warn('[auth] password reset email setup failed:', e && e.message);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/auth/users/:id/password error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/auth/users/:id (admin only)
// Will fail if the user owns any jobs (FK constraint) — that's the safe behavior;
// admin should reassign jobs via the UI before deleting. Falls back to deactivation
// in that case (set active=false instead of delete).
router.delete('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (parseInt(req.params.id, 10) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23503') {
      return res.status(409).json({
        error: 'User owns jobs — reassign or delete those jobs first, or deactivate the user instead.'
      });
    }
    console.error('DELETE /api/auth/users/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/password (change own password)
router.put('/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });

    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!bcrypt.compareSync(currentPassword, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password incorrect' });
    }

    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [bcrypt.hashSync(newPassword, 10), req.user.id]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
