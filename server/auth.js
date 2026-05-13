const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'agx-wip-tracker-dev-secret-change-in-prod';
const TOKEN_EXPIRY = '7d';

// Canonical list of capability keys, with display metadata. The server uses
// the keys; the admin Roles UI renders the labels and groups. New keys go
// here, then need to be added to whichever route they gate.
const CAPABILITY_KEYS = [
  // Jobs
  { key: 'JOBS_VIEW_ALL',   group: 'Jobs',       label: 'View all jobs' },
  { key: 'JOBS_VIEW_ASSIGNED', group: 'Jobs',    label: 'View own / assigned jobs only' },
  { key: 'JOBS_EDIT_ANY',   group: 'Jobs',       label: 'Edit any job' },
  { key: 'JOBS_EDIT_OWN',   group: 'Jobs',       label: 'Edit own / assigned jobs' },
  { key: 'JOBS_DELETE',     group: 'Jobs',       label: 'Permanently delete jobs' },
  { key: 'JOBS_GO_LIVE',    group: 'Jobs',       label: 'Toggle job live/draft status' },
  { key: 'JOBS_REASSIGN',   group: 'Jobs',       label: 'Reassign job owners + manage sharing' },
  // Financials
  { key: 'FINANCIALS_VIEW', group: 'Financials', label: 'See contract amounts, margins, profit' },
  { key: 'PROGRESS_UPDATE', group: 'Financials', label: 'Edit phase % complete + labor entries' },
  // Estimates
  { key: 'ESTIMATES_VIEW',  group: 'Estimates',  label: 'View estimates' },
  { key: 'ESTIMATES_EDIT',  group: 'Estimates',  label: 'Create / edit estimates' },
  // Sales pipeline (Leads)
  { key: 'LEADS_VIEW',      group: 'Sales',      label: 'View leads / sales pipeline' },
  { key: 'LEADS_EDIT',      group: 'Sales',      label: 'Create / edit leads' },
  // Admin
  { key: 'USERS_MANAGE',    group: 'Admin',      label: 'Manage users' },
  { key: 'ROLES_MANAGE',    group: 'Admin',      label: 'Manage roles + capabilities' },
  { key: 'INSIGHTS_VIEW',   group: 'Admin',      label: 'View Insights dashboard' },
  { key: 'ADMIN_METRICS',   group: 'Admin',      label: 'Access Admin Metrics tab + Go Live controls' },
  // Sub portal — exclusively held by the `sub` role; PMs/admins
  // never need these because they have full access through the
  // PM UI. Keeping them isolated means a misconfigured PM role
  // can't accidentally see a sub-only screen.
  { key: 'SUB_PORTAL_VIEW',   group: 'Sub Portal', label: 'View granted folders + assignments (sub portal only)' },
  { key: 'SUB_PORTAL_UPLOAD', group: 'Sub Portal', label: 'Upload files into granted folders (sub portal only)' }
];

// In-memory cache of role.name -> Set(capability). Routes call hasCapability()
// for permission checks. Refreshed on app start (initRoleCache) and whenever
// /api/roles/* mutations happen (refreshRoleCache).
let _roleCache = new Map();
let _pool = null;

function setRolePool(pool) { _pool = pool; }

async function refreshRoleCache() {
  if (!_pool) return;
  const { rows } = await _pool.query('SELECT name, capabilities FROM roles');
  const next = new Map();
  for (const r of rows) {
    const caps = Array.isArray(r.capabilities) ? r.capabilities : [];
    next.set(r.name, new Set(caps));
  }
  _roleCache = next;
}

function hasCapability(user, capKey) {
  if (!user || !user.role) return false;
  const caps = _roleCache.get(user.role);
  return !!(caps && caps.has(capKey));
}

function requireCapability(capKey) {
  return function(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!hasCapability(req.user, capKey)) {
      return res.status(403).json({ error: 'Missing capability: ' + capKey });
    }
    next();
  };
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id, email: user.email, role: user.role, name: user.name,
      // sub_id is only set for role='sub' users; carrying it in the
      // JWT means the portal endpoints can scope queries without an
      // extra users-table lookup on every request.
      sub_id: user.sub_id || null,
      // organization_id — multi-tenant scope key. Embedded in the
      // JWT so every authed request has the tenant id without a
      // round-trip. Null only for legacy tokens issued before the
      // organizations table existed; those should re-login.
      organization_id: user.organization_id || null
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

// Per-user throttle for last_seen_at writes — without it every API
// request (which is dozens per page-load) would hammer the users
// table. 30s window means an idle tab still ticks "active" for ~5min
// after last interaction (the threshold the active-users endpoint
// uses), but a chatty client only bumps the column twice a minute.
const LAST_SEEN_THROTTLE_MS = 30 * 1000;
const _lastSeenWriteAt = new Map(); // userId -> epoch ms of last bump

function bumpLastSeen(userId) {
  if (!_pool || !userId) return;
  const now = Date.now();
  const prev = _lastSeenWriteAt.get(userId) || 0;
  if (now - prev < LAST_SEEN_THROTTLE_MS) return;
  _lastSeenWriteAt.set(userId, now);
  // Fire-and-forget — never block the request. Errors are silent
  // because this is best-effort presence tracking, not a hard
  // dependency of any API call.
  _pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId])
    .catch(function(e) { /* swallow */ });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    bumpLastSeen(req.user.id);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Resolve the caller's organization. Handlers that need the org
// (chat surfaces, per-tenant queries, etc.) call this. The function
// trusts req.user.organization_id when present (set from the JWT at
// login) and falls back to a DB read for legacy tokens issued
// before the organizations table existed. Returns the full org row
// or null if the user has no org (shouldn't happen after the boot
// migration, but treat it as a 403/401-level bug).
async function resolveUserOrg(req) {
  if (!req || !req.user) return null;
  if (req.user._cachedOrg) return req.user._cachedOrg;
  let orgId = req.user.organization_id;
  if (orgId == null && _pool) {
    try {
      const r = await _pool.query(
        'SELECT organization_id FROM users WHERE id = $1',
        [req.user.id]
      );
      if (r.rows.length) {
        orgId = r.rows[0].organization_id;
        req.user.organization_id = orgId;
      }
    } catch (e) { /* swallow — caller treats null as missing */ }
  }
  if (!orgId || !_pool) return null;
  try {
    const r = await _pool.query(
      'SELECT * FROM organizations WHERE id = $1 AND archived_at IS NULL LIMIT 1',
      [orgId]
    );
    req.user._cachedOrg = r.rows[0] || null;
    return req.user._cachedOrg;
  } catch (e) {
    return null;
  }
}

function requireRole(...roles) {
  return function(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Roles:
//   admin     — full access: manage users, see all jobs, edit anything
//   corporate — read-only access to all jobs, insights dashboard
//   pm        — edit own jobs and jobs they're assigned to

module.exports = {
  signToken, requireAuth, requireRole, resolveUserOrg, JWT_SECRET,
  // Roles / capabilities
  CAPABILITY_KEYS, setRolePool, refreshRoleCache, hasCapability, requireCapability
};
