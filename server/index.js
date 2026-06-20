const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const fs = require('fs');

// Load .env if it exists
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(function(line) {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    var eq = line.indexOf('=');
    if (eq > 0) process.env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
  });
}

const { init, pool } = require('./db');
const { setRolePool, refreshRoleCache } = require('./auth');
const authRoutes = require('./routes/auth-routes');
const jobRoutes = require('./routes/job-routes');
const estimateRoutes = require('./routes/estimate-routes');
const searchRoutes = require('./routes/search-routes');
const changeOrderRoutes = require('./routes/change-order-routes');
const roleRoutes = require('./routes/role-routes');
const clientRoutes = require('./routes/client-routes');
const leadRoutes = require('./routes/lead-routes');
const settingsRoutes = require('./routes/settings-routes');
const attachmentRoutes = require('./routes/attachment-routes');
const aiRoutes = require('./routes/ai-routes');
const aiSessionsRoutes = require('./routes/ai-sessions-routes');
const materialRoutes = require('./routes/material-routes');
const qbCostRoutes = require('./routes/qb-cost-routes');
const subRoutes = require('./routes/sub-routes');
const subPortalRoutes = require('./routes/sub-portal-routes');
const messageRoutes = require('./routes/message-routes');
const scheduleRoutes = require('./routes/schedule-routes');
const weatherRoutes = require('./routes/weather-routes');
const emailRoutes = require('./routes/email-routes');
const emailCampaignsRoutes = require('./routes/email-campaigns-routes');
const adminAgentsRoutes = require('./routes/admin-agents-routes');
const contextRegistryRoutes = require('./routes/context-registry-routes');
const adminBatchRoutes = require('./routes/admin-batch-routes');
const adminFilesRoutes = require('./routes/admin-files-routes');
const adminAnthropicRoutes = require('./routes/admin-anthropic-routes');
const adminSmsRoutes = require('./routes/admin-sms-routes');
const adminOrganizationsRoutes = require('./routes/admin-organizations-routes');
const adminConsoleRoutes = require('./routes/admin-console-routes');
const remindersRoutes = require('./routes/reminders-routes');
const smsRoutes = require('./routes/sms-routes');
const reportRoutes = require('./routes/report-routes');
const reportsPolymorphicRoutes = require('./routes/reports-routes');
const fieldToolsRoutes = require('./routes/field-tools-routes');
const payloadRoutes = require('./routes/payload-routes');
const projectRoutes = require('./routes/project-routes');
const projectPairsRoutes = require('./routes/project-pairs-routes');
const plansRoutes = require('./routes/plans-routes');
const orgTagsRoutes = require('./routes/org-tags-routes');
const folderTemplatesRoutes = require('./routes/folder-templates-routes');
const tasksRoutes = require('./routes/tasks-routes');
const notesRoutes = require('./routes/notes-routes');
const mapRoutes = require('./routes/map-routes');
const calendarRoutes = require('./routes/calendar-routes');
const { storage } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust the first proxy hop — Railway terminates TLS at its edge and
// forwards the real client IP in X-Forwarded-For. Without this setting,
// req.ip resolves to the proxy's internal IP and the per-IP rate
// limiters in rate-limit.js would treat ALL traffic as coming from a
// single source — defeating their purpose. The integer 1 = trust one
// hop (Railway's edge). If Cloudflare or another reverse proxy is
// added in front later, bump this to 2.
app.set('trust proxy', 1);

// Defense-in-depth: never let an unhandled response error kill the
// process. SSE handlers in ai-routes write asynchronously after the
// initial request returns, so a single ERR_STREAM_WRITE_AFTER_END
// from a double-end (Anthropic 400 fires both stream.error AND
// stream.done() rejects) used to escape every try/catch and crash
// the worker. Crash loop = Railway marks deploy dead. Log and
// continue — the failing request is already toast either way; we
// just want subsequent requests to still get served.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason && (reason.stack || reason.message) || reason);
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// P1-2 — global per-IP rate guard for /api (200 req/min/IP). It was
// defined + exported in rate-limit.js but never mounted. Sits in front
// of the /api routers; the per-route limiters (login, AI chat) still
// apply independently on top of this. trust proxy=1 means req.ip is the
// real client, so this is keyed per actual client IP.
const { ipGenericLimiter } = require('./rate-limit');
app.use('/api', ipGenericLimiter);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);
// Per-job reports nest under /api/jobs/:jobId/reports (mergeParams on
// the router preserves :jobId from this prefix).
app.use('/api/jobs/:jobId/reports', reportRoutes);
// Polymorphic reports for projects (Phase 2). Writes to the same
// job_reports table the legacy route uses, scoped by entity_type +
// entity_id. The legacy /api/jobs/:jobId/reports endpoint still
// handles 'job' rows with its job-specific photo-source logic
// (buildings, phases, COs).
app.use('/api/reports', reportsPolymorphicRoutes);
app.use('/api/field-tools', fieldToolsRoutes);
// Payload DSL routes — file download, reject, apply (inline approval
// card). Mounted before the broad /api/ai handler so /api/payloads
// claims its namespace without ambiguity.
app.use('/api/payloads', payloadRoutes);
app.use('/api/estimates', estimateRoutes);
app.use('/api/search', searchRoutes);
// Change Orders use two URL families (/api/jobs/:jobId/change-orders
// and /api/change-orders/:id) so we mount the router at /api and let
// it define both shapes internally.
app.use('/api', changeOrderRoutes);
// Purchase Orders — same two-URL-family pattern as change orders
// (/api/jobs/:jobId/purchase-orders + /api/purchase-orders/*).
const purchaseOrderRoutes = require('./routes/purchase-order-routes');
app.use('/api', purchaseOrderRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/leads', leadRoutes);
// Project pairs (before/after) mount BEFORE the parent /api/projects
// router so the more-specific path is matched first. mergeParams=true
// on the pairs router exposes :projectId from this prefix.
app.use('/api/projects/:projectId/pairs', projectPairsRoutes);
app.use('/api/projects', projectRoutes);
// Plans & Takeoffs — scale-drawing documents (Bluebeam-style measure).
app.use('/api/plans', plansRoutes);
// Tasks / To-Do system — polymorphic entity (kind = todo|punch|follow_up),
// org-scoped, requireAuth-only (assignee-driven model needs universal
// access; no capability gate). See server/routes/tasks-routes.js.
app.use('/api/tasks', tasksRoutes);
// My Notes — personal, private scratchpad. requireAuth-only; every
// query is owner + org scoped (fail-closed). See notes-routes.js.
app.use('/api/notes', notesRoutes);
// Map data — combined leads + jobs feed for the Summary combined map
// (Phase 1 / Deliverable 2). Org-scoped, read-only. See map-routes.js.
app.use('/api/map', mapRoutes);
// Personal calendar events — the per-user Assistant calendar. requireAuth
// only; every query owner + org scoped (fail-closed). See calendar-routes.js.
app.use('/api/calendar', calendarRoutes);
app.use('/api/org-tags', orgTagsRoutes);
app.use('/api/folder-templates', folderTemplatesRoutes);
// Org manifest — one read-only endpoint that powers the Summary
// page's System Snapshot block + the System Map sub-tab. Returns
// entity counts, the feature catalog, and recent activity in a
// single round-trip. See server/routes/org-manifest-routes.js.
app.use('/api/org', require('./routes/org-manifest-routes'));
// Public client config — Google Maps API key etc. Auth-gated so
// unauth'd scrapers can't grab it. See server/routes/config-routes.js.
app.use('/api/config', require('./routes/config-routes'));
app.use('/api/settings', settingsRoutes);
app.use('/api/attachments', attachmentRoutes);
// Sessions sidebar routes mount BEFORE the catch-all aiRoutes so they
// claim /api/ai/sessions/* before any wildcard handler in aiRoutes
// would. Both share helpers via the require('./ai-routes') call inside
// ai-sessions-routes — that's safe because Node caches the export
// object, so the two modules see the same instance.
app.use('/api/ai/sessions', aiSessionsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/qb-costs', qbCostRoutes);
app.use('/api/subs', subRoutes);
// Sub portal routes — mounted at /api so the file can register both
// PM-side paths (`/subs/:subId/invite`) and sub-facing paths
// (`/sub-portal/...`). Order matters: this comes AFTER /api/subs so
// the sub-routes router gets first crack at /subs/* paths and falls
// through to here only for the invite endpoints it doesn't define.
app.use('/api', subPortalRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/weather', weatherRoutes);
// Campaigns routes mount BEFORE the generic email mount so the more
// specific /api/email/campaigns paths win over any future glob in
// the parent router.
app.use('/api/email/campaigns', emailCampaignsRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/admin/agents', adminAgentsRoutes);
app.use('/api/admin/context-registry', contextRegistryRoutes);
// Wave 3 — RFI / submittal / transmittal workflow items.
// Two mounts: global endpoints at /api/workflow-items/* and nested
// job-scoped endpoints at /api/jobs/:jobId/workflow-items.
const jobWorkflowRoutes = require('./routes/job-workflow-routes');
app.use('/api/workflow-items', jobWorkflowRoutes);
app.use('/api/jobs/:jobId', jobWorkflowRoutes.jobNested);
// Wave 3 — compliance tracking (client COIs, license renewals,
// lien waivers, WC certs).
app.use('/api/compliance-items', require('./routes/compliance-routes'));
app.use('/api/admin/batch', adminBatchRoutes);
app.use('/api/admin/files', adminFilesRoutes);
app.use('/api/admin/anthropic', adminAnthropicRoutes);
app.use('/api/admin/sms', adminSmsRoutes);
app.use('/api/admin/organizations', adminOrganizationsRoutes);
app.use('/api/admin/console', adminConsoleRoutes);
app.use('/api/admin/reminders', remindersRoutes);
app.use('/api/sms', smsRoutes);

// Serve uploaded files when running with the local storage backend.
// On Railway with a mounted volume, set UPLOAD_DIR to the mount path
// (e.g. /data/uploads) and this serves them from there. R2 backend
// returns absolute URLs so this static mount is unused.
if (storage.localRoot) {
  app.use(storage.publicBase, express.static(storage.localRoot, {
    fallthrough: true,
    maxAge: '7d'
  }));
  console.log('[storage] local backend serving from', storage.localRoot, 'at', storage.publicBase);
} else if (storage.backend === 'r2') {
  console.log('[storage] R2 backend; public base =', storage.publicBase);
} else {
  console.log('[storage] backend =', storage.backend);
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Sub portal page — served before the SPA fallback so /portal lands
// on a dedicated minimal page rather than the PM app shell. The
// portal HTML lives at the repo root so the same static server can
// serve its assets without extra wiring.
app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'portal.html'));
});

// Public org-invite accept page. Recipient lands here from the
// org_invite email; the page reads ?token=… and renders a small
// sign-up form. Bypasses the main SPA so the unauthenticated visitor
// doesn't see auth gates or the app shell flash.
app.get('/accept-org-invite', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'accept-org-invite.html'));
});

// Dynamic /sw.js — stamp the cache version with the current Railway
// deployment SHA so EVERY deploy produces a different sw.js, which is
// what triggers the "An update is available — Relaunch" toast in the
// PWA. The toast's wiring is tied to the SW install/waiting/active
// lifecycle; a new SW only installs when the bytes of sw.js change.
// Without stamping we'd have to manually bump a constant in sw.js on
// every release. With it, Railway's per-deploy git SHA does the work.
//
// Behavior:
//   • On Railway (RAILWAY_GIT_COMMIT_SHA set) → append the short SHA
//     to the existing CACHE_VERSION constant. Every deploy gets a
//     unique value → new sw.js bytes → new SW install → toast fires.
//   • Local dev (no env var) → serve sw.js as-is. The manual constant
//     in the file still works as the version, and you don't get a
//     toast on every page reload (which would be obnoxious).
//
// Cache-Control: no-cache so the browser always revalidates sw.js
// instead of serving it from its HTTP cache. Without this, a fresh
// deploy could be invisible for up to a day on aggressive proxies.
//
// Must be registered BEFORE express.static below so this route wins.
const SW_PATH = path.join(__dirname, '..', 'sw.js');
const DEPLOY_SHA = (process.env.RAILWAY_GIT_COMMIT_SHA ||
                    process.env.RAILWAY_DEPLOYMENT_ID || '').slice(0, 8);
app.get('/sw.js', (req, res) => {
  let content;
  try {
    content = require('fs').readFileSync(SW_PATH, 'utf8');
  } catch (e) {
    return res.status(500).type('application/javascript').send('// sw.js read failed');
  }
  if (DEPLOY_SHA) {
    content = content.replace(
      /(const CACHE_VERSION = ')([^']*)(';)/,
      '$1$2-' + DEPLOY_SHA + '$3'
    );
  }
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.send(content);
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..')));

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Initialize DB then start. Hand the pool to the auth module so capability
// lookups can refresh from the DB whenever a role mutation lands.
setRolePool(pool);

// Local-dev escape hatch: if DATABASE_URL is empty (i.e. running on a
// dev box without Postgres) skip schema init and just serve the
// static frontend. The frontend's existing offline-mode (driven by
// /api/auth/me failing) takes over and runs against localStorage.
// On Railway, DATABASE_URL is always set, so this branch never fires
// in production.
function startServer() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Project 86 running on http://localhost:${PORT}`);
    if (process.env.ADMIN_EMAIL) {
      console.log(`Admin user synced from env: ${process.env.ADMIN_EMAIL}`);
    } else {
      console.log('No ADMIN_EMAIL/ADMIN_PASSWORD env vars set — using dev admin@local / changeme');
    }
    // Daily scanner for cert-expiry reminders. Self-gated: if the
    // cert_expiring event is disabled in admin settings, sendForEvent
    // skips each row; the scanner still runs harmlessly. Skipped on
    // offline mode (no DATABASE_URL) since it relies on Postgres.
    if (process.env.DATABASE_URL) {
      try {
        require('./cert-expiry-cron').start();
      } catch (e) {
        console.warn('[cert-expiry] failed to start scanner:', e && e.message);
      }
      // Weekly digest cron — Monday 7am local. Self-gated by event toggles
      // in admin settings; sendForEvent skips disabled events. Each digest
      // (PM / sales / ops) is independently togglable per org.
      try {
        require('./weekly-digest-cron').start();
      } catch (e) {
        console.warn('[weekly-digest] failed to start:', e && e.message);
      }
      // Reminders scanner — ticks every 10 min. Fires per-user task-due
      // digests (morning-gated, deduped per day) + calendar event
      // reminders (per event reminder_minutes). Honors notification_prefs
      // opt-outs (task_due / event_reminder); self-guarding, never throws.
      try {
        require('./reminders-cron').start();
      } catch (e) {
        console.warn('[reminders] failed to start scanner:', e && e.message);
      }
      // Marketing campaigns worker (Wave 9). Ticks every 60s: picks
      // up scheduled campaigns whose time has come, drains in-flight
      // batches one chunk per campaign per tick. Self-gated by the
      // campaign status field.
      try {
        require('./email-campaigns').start();
      } catch (e) {
        console.warn('[campaigns] failed to start worker:', e && e.message);
      }
      // Phase 5 — proactive-watch scheduler. Ticks every 60s,
      // fires watches with next_fire_at <= NOW. Runs in-process; one
      // tick per app instance (multiple Railway instances would each
      // tick, but the CAS update on next_fire_at prevents double fires).
      try {
        if (aiRoutes.startWatchScheduler) aiRoutes.startWatchScheduler();
      } catch (e) {
        console.warn('[watch] failed to start scheduler:', e && e.message);
      }
    }
  });
}

if (!process.env.DATABASE_URL) {
  console.warn('[server] DATABASE_URL not set — starting in offline/static mode. ' +
    'API routes that hit Postgres will return 500; the frontend will fall back to localStorage.');
  startServer();
} else {
  init().then(refreshRoleCache).then(startServer).catch(err => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
}
