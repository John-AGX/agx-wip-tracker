const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, getOrgById } = require('../db');
const { signToken, requireAuth, requireRole, requireSystemAdmin, resolveUserOrg, hasCapability } = require('../auth');
const { ipLoginLimiter } = require('../rate-limit');
const { auditLog } = require('../audit');

const router = express.Router();

// POST /api/auth/login  (rate-limited: 10/min per IP, see rate-limit.js)
router.post('/login', ipLoginLimiter, async (req, res) => {
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
    // Phase 2 — same flip for the directory surface (clients) and CoS (staff). All four
    // ramp independently; production stays on v1 until each env var
    // flips.
    agent_mode_cra:   (process.env.AGENT_MODE_HR   || '').toLowerCase() === 'agents' ? 'agents' : 'legacy',
    agent_mode_staff: (process.env.AGENT_MODE_STAFF || '').toLowerCase() === 'agents' ? 'agents' : 'legacy'
    // Note: there is no agent_mode_intake. 86 owns the lead-intake
    // flow now, so the "🧲 New Lead with AI" entry point gates on
    // agent_mode_job (= AGENT_MODE_86) rather than a separate flag.
  };
  // Act-as / disguise — when a system admin is impersonating another user,
  // requireAuth has stamped req.actingAs from the acting_as_user_id JWT
  // claim. Resolve the target's display fields so the client can paint the
  // "Acting as X — Exit" banner. DISPLAY ONLY: this never changes any read
  // filter or guard (those still key off req.user.id = the real admin).
  let actingAs = null;
  if (req.actingAs && req.actingAs.id) {
    try {
      const r = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.actingAs.id]);
      if (r.rows.length) {
        actingAs = { id: r.rows[0].id, name: r.rows[0].name, email: r.rows[0].email };
      }
    } catch (_) { /* keep /me functional even if the lookup blips */ }
  }
  res.json({ user: req.user, organization: organization, feature_flags: featureFlags, acting_as: actingAs });
});

// POST /api/auth/refresh-token
//   Re-reads the caller's current role + organization from the DB
//   and re-issues the JWT cookie. Used after a role change (e.g.
//   auto-promotion to system_admin on boot) so the user doesn't
//   have to log out + back in to pick up the new claims.
router.post('/refresh-token', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM users WHERE id = $1 AND active = true',
      [req.user.id]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'User not found or inactive' });
    const user = r.rows[0];
    // Preserve an active act-as disguise across this re-sign. The client calls
    // /refresh-token on every boot; without this the disguise would self-destruct
    // on the first reload. requireAuth only sets req.actingAs when the caller
    // still passes the live SYSTEM_ADMIN check, so a downgraded admin's claim is
    // already absent here (fail-safe — it can only ever drop, never escalate).
    const extra = (req.actingAs && req.actingAs.id) ? { acting_as_user_id: req.actingAs.id } : {};
    const token = signToken(user, extra);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, organization_id: user.organization_id }
    });
  } catch (e) {
    console.error('POST /api/auth/refresh-token error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// POST /api/auth/act-as  — a system admin begins impersonating ("disguising
//   as") another user. The REAL admin's identity (id/role/org) stays in the
//   JWT untouched, so god-mode visibility + permissions are fully preserved;
//   we only ADD an acting_as_user_id claim that requireAuth turns into
//   req.actingAs / req.attributedUserId. Author/owner columns on CREATE then
//   attribute to the target, while every read filter + access guard still
//   keys off req.user.id (the admin). Email/notification senders are
//   intentionally NOT attributed — outbound mail stays from the real admin.
router.post('/act-as', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const targetId = parseInt(req.body && req.body.user_id, 10);
    if (!targetId) return res.status(400).json({ error: 'user_id required' });
    if (targetId === req.user.id) return res.status(400).json({ error: 'Already yourself — nothing to act as' });

    // Target must be a real, ACTIVE user in the admin's OWN organization.
    // The same-org guard keeps act-as from spanning tenants (cross-tenant
    // god-mode is read-only by design).
    const { rows } = await pool.query(
      'SELECT id, name, email, role, active, organization_id FROM users WHERE id = $1',
      [targetId]
    );
    const target = rows[0];
    if (!target || !target.active) return res.status(404).json({ error: 'Target user not found or inactive' });
    if (target.organization_id !== req.user.organization_id) {
      return res.status(403).json({ error: 'Can only act as a user in your own organization' });
    }

    // Re-sign the cookie. We sign the REAL admin as principal and ADD the
    // acting_as_user_id claim — never sign the target as principal, or the
    // admin would lose god-mode. Mirrors the signToken + res.cookie pattern
    // in /login and /refresh-token EXACTLY (same cookie name + options).
    const admin = (await pool.query('SELECT * FROM users WHERE id = $1 AND active = true', [req.user.id])).rows[0];
    if (!admin) return res.status(401).json({ error: 'Admin account not found or inactive' });
    const token = signToken(admin, { acting_as_user_id: target.id });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });

    // Audit the start. req.user is still the REAL admin, so auditLog
    // snapshots the true operator as actor — accountability is preserved.
    auditLog(req, {
      action: 'user.act_as_start',
      targetType: 'user',
      targetId: String(target.id),
      organizationId: target.organization_id || null,
      detail: { target_email: target.email, target_role: target.role },
    });

    // Do NOT echo the token in the body — the httpOnly cookie carries auth.
    // Returning it here would expose the disguise token to any page-level XSS.
    res.json({ ok: true, acting_as: { id: target.id, name: target.name, email: target.email } });
  } catch (e) {
    console.error('POST /api/auth/act-as error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/act-as/exit  — drop the impersonation claim. Re-signs the
//   cookie WITHOUT acting_as_user_id (back to plain admin) and audits the
//   exit. Any authenticated caller may exit (it only ever clears a claim).
router.post('/act-as/exit', requireAuth, async (req, res) => {
  try {
    const wasActingAs = (req.actingAs && req.actingAs.id) ? req.actingAs.id : null;
    const admin = (await pool.query('SELECT * FROM users WHERE id = $1 AND active = true', [req.user.id])).rows[0];
    if (!admin) return res.status(401).json({ error: 'User not found or inactive' });
    // Sign with NO extra claims — clears acting_as_user_id from the cookie.
    const token = signToken(admin);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });

    if (wasActingAs) {
      auditLog(req, {
        action: 'user.act_as_exit',
        targetType: 'user',
        targetId: String(wasActingAs),
        detail: {},
      });
    }

    res.json({ ok: true, acting_as: null });
  } catch (e) {
    console.error('POST /api/auth/act-as/exit error:', e);
    res.status(500).json({ error: 'Server error' });
  }
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
      // Inviter name: the CURRENT name on file, not the JWT claim (which
      // is frozen at login and goes stale if the name was edited since).
      let inviterName = req.user && req.user.name;
      try {
        const inv = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        if (inv.rows[0] && inv.rows[0].name) inviterName = inv.rows[0].name;
      } catch (_) { /* JWT-claim fallback */ }
      const tpl = newUserInvite({
        name: name,
        email: email.toLowerCase().trim(),
        password: password,
        invitedBy: inviterName || 'An admin'
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
    // P1-1 — the staff directory feeds internal assignment / crew / admin
    // pickers. A sub-portal user has no business reading staff emails and
    // phone numbers, so deny sub callers outright. For staff callers,
    // exclude sub rows and scope to the caller's org (tolerant OR-IS-NULL
    // so legacy un-stamped users stay visible to AGX).
    if (req.user && (req.user.sub_id || req.user.role === 'sub')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const orgId = req.user && req.user.organization_id;
    const params = [];
    let where = "WHERE role <> 'sub'";
    if (orgId) { params.push(orgId); where += ' AND (organization_id = $1 OR organization_id IS NULL)'; }
    const { rows } = await pool.query(
      'SELECT id, email, name, role, active, phone_number, timezone, title, notification_prefs, created_at, last_seen_at FROM users ' +
      where + ' ORDER BY name ASC',
      params
    );
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/active-users — count of users seen in the last
// `threshold` minutes (default 5). Drives the "Online Now" metric
// card on Admin → Metrics. Cheap query backed by idx_users_last_seen_at.
// Org-scoped: returns count of active users IN THE CALLER'S OWN ORG only.
// Pre-fix this endpoint did a global COUNT(*) which leaked cross-tenant
// presence info to anyone with admin role — system-admin saw everyone,
// per-org admin would also see everyone if multi-tenant landed.
router.get('/active-users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const threshold = Math.max(1, Math.min(60, parseInt(req.query.threshold, 10) || 5));
    const orgId = req.user && req.user.organization_id;
    if (!orgId) {
      // No org on the user record — can happen for legacy/seed accounts.
      // Return 0 rather than leaking the global count.
      return res.json({
        activeCount: 0,
        asOf: new Date().toISOString(),
        thresholdMinutes: threshold,
        note: 'User has no organization_id; org-scoped count unavailable.'
      });
    }
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS active_count " +
      "FROM users " +
      "WHERE organization_id = $2 " +
      "  AND active = TRUE AND last_seen_at IS NOT NULL " +
      "  AND last_seen_at > NOW() - ($1 || ' minutes')::interval",
      [String(threshold), orgId]
    );
    res.json({
      activeCount: rows[0].active_count,
      asOf: new Date().toISOString(),
      thresholdMinutes: threshold,
      organizationId: orgId
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
    // P3 — cap the JSONB size. It's a small opt-out map and is shipped
    // directory-wide via GET /users, so an oversized blob is wasteful/abusable.
    const prefsJson = JSON.stringify(prefs);
    if (prefsJson.length > 16384) return res.status(400).json({ error: 'Notification preferences too large' });
    await pool.query(
      'UPDATE users SET notification_prefs = $1::jsonb, updated_at = NOW() WHERE id = $2',
      [prefsJson, req.user.id]
    );
    res.json({ ok: true, prefs: prefs });
  } catch (e) {
    console.error('PUT /me/notification-prefs error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/me — a user edits their OWN profile. Whitelisted to exactly
// four fields on req.user.id (name / email / phone_number / title) — it can
// NEVER touch role / active / organization_id, so there's no self-promotion
// path here. Reuses the admin endpoint's email + phone validators. Re-signs
// the auth cookie so a name/email change propagates without a re-login.
router.put('/me', requireAuth, async (req, res) => {
  try {
    const { name, email, phone_number, title } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    let nameUpdate = user.name;
    if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
      const n = String(name == null ? '' : name).trim();
      if (!n) return res.status(400).json({ error: 'Name cannot be empty' });
      nameUpdate = n;
    }

    let emailUpdate = user.email;
    if (Object.prototype.hasOwnProperty.call(req.body, 'email') && email != null && String(email).trim() !== '') {
      const normalized = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        return res.status(400).json({ error: 'Email is not a valid address' });
      }
      emailUpdate = normalized;
    }

    let phoneUpdate = user.phone_number;
    if (Object.prototype.hasOwnProperty.call(req.body, 'phone_number')) {
      if (phone_number == null || String(phone_number).trim() === '') {
        phoneUpdate = null;
      } else {
        const sms = require('../sms');
        const normalized = sms.normalizeUSPhone(phone_number);
        if (!normalized) return res.status(400).json({ error: 'Phone number not recognized — use 10 digits or +1XXXXXXXXXX' });
        phoneUpdate = normalized;
      }
    }

    let titleUpdate = user.title;
    if (Object.prototype.hasOwnProperty.call(req.body, 'title')) {
      const t = String(title == null ? '' : title).trim();
      titleUpdate = t === '' ? null : t.slice(0, 120);
    }

    await pool.query(
      'UPDATE users SET name = $1, email = $2, phone_number = $3, title = $4, updated_at = NOW() WHERE id = $5',
      [nameUpdate, emailUpdate, phoneUpdate, titleUpdate, req.user.id]
    );

    // Re-sign the cookie (mirrors POST /refresh-token) so name/email changes
    // take effect immediately without re-login.
    const fresh = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (fresh) {
      // Preserve an active act-as disguise across this profile-edit re-sign.
      const extra = (req.actingAs && req.actingAs.id) ? { acting_as_user_id: req.actingAs.id } : {};
      const token = signToken(fresh, extra);
      res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    }
    res.json({ ok: true, user: { id: user.id, name: nameUpdate, email: emailUpdate, phone_number: phoneUpdate, title: titleUpdate } });
  } catch (e) {
    if (e && e.code === '23505') {
      const detail = (e.detail || '').toLowerCase();
      if (detail.includes('email')) return res.status(409).json({ error: 'That email is already used by another user' });
      if (detail.includes('phone')) return res.status(409).json({ error: 'That phone number is already used by another user' });
      return res.status(409).json({ error: 'Conflict — value already in use' });
    }
    console.error('PUT /api/auth/me error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/users/:id/notification-prefs', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const prefs = (req.body && req.body.prefs && typeof req.body.prefs === 'object')
      ? req.body.prefs
      : {};
    const prefsJson = JSON.stringify(prefs); // P3 — cap JSONB size (see /me handler)
    if (prefsJson.length > 16384) return res.status(400).json({ error: 'Notification preferences too large' });
    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await pool.query(
      'UPDATE users SET notification_prefs = $1::jsonb, updated_at = NOW() WHERE id = $2',
      [prefsJson, req.params.id]
    );
    res.json({ ok: true, prefs: prefs });
  } catch (e) {
    console.error('PUT /users/:id/notification-prefs error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/users/:id (admin only)
// P0-3 — validate a role assignment against the roles table (the source
// of truth, incl. custom roles) and block privilege escalation: a caller
// may not assign any role whose capabilities include SYSTEM_ADMIN unless
// they themselves hold SYSTEM_ADMIN. requireRole('admin') is satisfied by
// a plain org admin, so without this an org admin could self-promote to
// system_admin (cross-tenant) by PUTting role:'system_admin', and could
// set an arbitrary unknown role string (users.role has no DB CHECK/FK).
async function validateRoleAssignment(targetRole, callerUser) {
  if (!targetRole) return null; // role field absent/empty → unchanged
  const r = await pool.query('SELECT capabilities FROM roles WHERE name = $1', [targetRole]);
  if (!r.rows.length) return { status: 400, error: 'Unknown role: ' + targetRole };
  const caps = Array.isArray(r.rows[0].capabilities) ? r.rows[0].capabilities : [];
  if (caps.indexOf('SYSTEM_ADMIN') !== -1 && !hasCapability(callerUser, 'SYSTEM_ADMIN')) {
    return { status: 403, error: 'Only a system administrator can assign the "' + targetRole + '" role.' };
  }
  return null;
}

router.put('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { name, role, active, phone_number, email, timezone } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // P0-3 — gate the role field: reject unknown roles (400) and block a
    // non-system-admin from assigning any SYSTEM_ADMIN-carrying role (403).
    const roleErr = await validateRoleAssignment(role, req.user);
    if (roleErr) return res.status(roleErr.status).json({ error: roleErr.error });

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

    // Email change. Optional. Absent or empty = leave alone. Otherwise:
    // - lowercase + trim
    // - must contain "@"
    // - uniqueness enforced by the DB; we catch 23505 below
    let emailUpdate = user.email;
    if (Object.prototype.hasOwnProperty.call(req.body, 'email') && email != null && String(email).trim() !== '') {
      const normalized = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        return res.status(400).json({ error: 'Email is not a valid address' });
      }
      emailUpdate = normalized;
    }

    // Per-user timezone OVERRIDE (multi-market). Optional:
    //   - empty string / null clears it (inherit the org timezone)
    //   - any other value must be a valid IANA zone
    // Absent from the body = leave whatever was there.
    let timezoneUpdate = user.timezone;
    if (Object.prototype.hasOwnProperty.call(req.body, 'timezone')) {
      if (timezone == null || String(timezone).trim() === '') {
        timezoneUpdate = null;
      } else {
        const tzName = String(timezone).trim();
        if (!require('../timezone').isValidTz(tzName)) {
          return res.status(400).json({ error: 'Invalid timezone (expected an IANA name like America/New_York)' });
        }
        timezoneUpdate = tzName;
      }
    }

    await pool.query(
      'UPDATE users SET name = $1, role = $2, active = $3, phone_number = $4, email = $5, timezone = $6, updated_at = NOW() WHERE id = $7',
      [name || user.name, role || user.role, active != null ? active : user.active, phoneUpdate, emailUpdate, timezoneUpdate, req.params.id]
    );

    // Audit — role change is the privileged one; record before/after.
    auditLog(req, {
      action: (role && role !== user.role) ? 'user.role_change' : 'user.update',
      targetType: 'user',
      targetId: req.params.id,
      organizationId: user.organization_id || null,
      detail: {
        email: emailUpdate,
        role_before: user.role,
        role_after: role || user.role,
        active_before: user.active,
        active_after: active != null ? active : user.active,
      },
    });

    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === '23505') {
      // Could be email or phone; check the constraint name where possible.
      const detail = (e.detail || '').toLowerCase();
      if (detail.includes('email')) return res.status(409).json({ error: 'That email is already used by another user' });
      if (detail.includes('phone')) return res.status(409).json({ error: 'That phone number is already used by another user' });
      return res.status(409).json({ error: 'Conflict — value already in use' });
    }
    console.error('PUT /users/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/users/:id/password (admin resets any user's password)
router.put('/users/:id/password', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password required (min 8 chars)' });
    }
    const { rows } = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const targetUser = rows[0];
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [bcrypt.hashSync(newPassword, 10), req.params.id]
    );
    // Audit — record the reset (NEVER the password itself).
    auditLog(req, { action: 'user.password_reset', targetType: 'user', targetId: req.params.id, detail: { email: targetUser.email } });

    // Email the user their new password — security tradeoff is
    // deliberate: Project 86 is small + admin-driven. Auth flow is "admin
    // hands you credentials" not "you self-serve via reset link".
    // Future flow with token-based resets would replace this.
    try {
      const { sendEmail } = require('../email');
      const { passwordReset } = require('../email-templates');
      // Current name on file, not the (possibly stale) JWT claim.
      let resetterName = req.user && req.user.name;
      try {
        const rn = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        if (rn.rows[0] && rn.rows[0].name) resetterName = rn.rows[0].name;
      } catch (_) { /* JWT-claim fallback */ }
      const tpl = passwordReset({
        name: targetUser.name,
        email: targetUser.email,
        password: newPassword,
        resetBy: resetterName || 'An admin'
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
    const { rows } = await pool.query('SELECT id, email, role, organization_id FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    auditLog(req, {
      action: 'user.delete', targetType: 'user', targetId: req.params.id,
      organizationId: rows[0].organization_id || null,
      detail: { email: rows[0].email, role: rows[0].role },
    });
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
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' }); // P3

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
