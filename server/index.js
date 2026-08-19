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
const assemblyRoutes = require('./routes/assembly-routes');
const assemblyResearchRoutes = require('./routes/assembly-research-routes');
const assemblyTaxonomyRoutes = require('./routes/assembly-taxonomy-routes');
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
const adminFilesRoutes = require('./routes/admin-files-routes');
const adminAnthropicRoutes = require('./routes/admin-anthropic-routes');
const adminSmsRoutes = require('./routes/admin-sms-routes');
const adminOrganizationsRoutes = require('./routes/admin-organizations-routes');
const adminConsoleRoutes = require('./routes/admin-console-routes');
const adminOrgResetRoutes = require('./routes/admin-org-reset-routes');
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
const marketRoutes = require('./routes/market-routes');
const folderTemplatesRoutes = require('./routes/folder-templates-routes');
const tasksRoutes = require('./routes/tasks-routes');
const taskShareRoutes = require('./routes/task-share-routes');
const notesRoutes = require('./routes/notes-routes');
const remindersCrudRoutes = require('./routes/reminders-crud-routes');
const receiptRoutes = require('./routes/receipt-routes');
const docImportRoutes = require('./routes/doc-import-routes');
const listViewsRoutes = require('./routes/list-views-routes');
const mapRoutes = require('./routes/map-routes');
const calendarRoutes = require('./routes/calendar-routes');
const outlookRoutes = require('./routes/outlook-routes');
const fileFoldersRoutes = require('./routes/file-folders-routes');
const { storage } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust TWO proxy hops: client → Cloudflare → Railway edge → app.
// Verified 2026-07-04 (Server: cloudflare + CF-RAY on responses):
// Cloudflare fronts project86.net, so with only 1 trusted hop req.ip
// resolved to CLOUDFLARE's edge IP — every user riding the same edge
// shared one per-IP rate-limit bucket, and the sub-portal redirect
// loop locked John (and anyone on that edge) out of login with
// "Too many requests". 2 hops = req.ip is the real client again.
// If another proxy is ever added in front of Cloudflare, bump to 3.
app.set('trust proxy', 2);

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

const { ipGenericLimiter } = require('./rate-limit');

// Email Dropbox inbound webhook (Resend) — mounted BEFORE express.json
// because svix signature verification needs the RAW request bytes; the
// global JSON parser would consume them. The event.received payload is
// metadata-only (tiny), so cap the raw body at 256kb — no reason to
// buffer megabytes on an unauthenticated endpoint. The per-IP limiter
// runs AHEAD of the raw parser so a flood is rejected before any body
// is buffered or any HMAC is computed.
const emailInboxRoutes = require('./routes/email-inbox-routes');
app.post('/api/email-inbox/inbound',
  ipGenericLimiter,
  express.raw({ type: () => true, limit: '256kb' }),
  emailInboxRoutes.inboundHandler);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Live Rooms — mounted ABOVE the global per-IP guard, DELIBERATELY, and this
// is the one place in the app where that is true for a JSON router.
//
// Express middleware is ADDITIVE, not exclusive: mounting a second limiter
// "ahead of" the global one does not replace it — the request still falls into
// the 200/min-per-IP bucket underneath. The only shape that actually escapes
// that guard is mounting the whole terminating router above line 128, which is
// what /api/email-inbox/inbound does. So Live Rooms does the same, and the
// consequence is stated rather than left implicit: /api/live has NO per-IP
// guard from this middleware and carries its own two limiters instead
// (liveJoinLimiter per IP on the unauthenticated join door, liveStreamLimiter
// per stream_key on the in-session channels).
//
// WHY IT CANNOT LIVE BELOW. A room's beacon runs at ~60 req/min per
// participant. With trust proxy=2 the global bucket is per real client IP, so
// one NAT'd office shares 200/min across ALL of its ordinary app traffic —
// three people in one room consume 180 of them and the office 429s on the whole
// app. And a 429 on the host's beacon starves last_host_beat_at, which ENDS the
// room at the 120s backstop. A transient limiter spike must never be able to
// terminate a live session, so the live channels get their own budget.
//
// Mounted after express.json + cookieParser (the beat carries a JSON body, and
// join reads an optional auth cookie) and before the guard below.
app.use('/api/live', require('./routes/live-routes'));

// P1-2 — global per-IP rate guard for /api (200 req/min/IP). It was
// defined + exported in rate-limit.js but never mounted. Sits in front
// of the /api routers; the per-route limiters (login, AI chat) still
// apply independently on top of this. `trust proxy` is 2 (line 87, and the
// comment here said 1 until 2026-08-19), so req.ip is the real client and
// this is keyed per actual client IP. The depth is not a detail: req.ip is
// what the audit trail records as "from where", so a wrong number here is a
// wrong answer to the only question the trail exists to answer.
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
// Workspace ⇄ Excel fidelity — server-side xlsx export (exceljs writes
// the styles the old client-side SheetJS Community exporter could not).
app.use('/api/workspace', require('./routes/workspace-xlsx-routes'));
// Email Dropbox — the Cloudflare Email Worker POSTs parsed JSON here
// (primary inbound path). Shared-secret authed inside the handler; JSON
// body. The global `app.use('/api', ipGenericLimiter)` above already
// rate-limits this path — do NOT add the limiter again here or each
// email is double-counted against the per-IP budget.
app.post('/api/email-inbox/inbound-cf',
  express.json({ limit: '2mb' }),
  emailInboxRoutes.inboundCfHandler);
// Email Dropbox reads + my-address.
app.use('/api/email-inbox', emailInboxRoutes);
// Premium Email Hub — E1 folder spine (docs/email-hub-premium.md).
// Folders are the exclusive axis (one per message), labels the multi
// axis. Both are authed JSON routers; the move-message endpoint lives
// under /api/email-folders/move-messages.
app.use('/api/email-folders', require('./routes/email-folders-routes'));
app.use('/api/email-labels', require('./routes/email-labels-routes'));
app.use('/api/email-rules', require('./routes/email-rules-routes'));
// E3 signatures + quick parts — reusable blocks the draft box inserts.
app.use('/api/email-snippets', require('./routes/email-snippets-routes'));
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
// Vendor Bills (Accounts Payable) — the bill side of a purchase order;
// /api/jobs/:jobId/bills + /api/bills/* mirror the PO route family.
const billRoutes = require('./routes/bill-routes');
app.use('/api', billRoutes);
// Applications for Payment — AIA G702/G703 billing
// (/api/jobs/:jobId/pay-applications + /api/pay-applications/*).
const payApplicationRoutes = require('./routes/pay-application-routes');
app.use('/api', payApplicationRoutes);
// Accounts receivable — invoices + payments + AR aging
// (/api/invoices, /api/payments, /api/ar/aging, + the pay-app→invoice bridge).
const invoiceRoutes = require('./routes/invoice-routes');
app.use('/api', invoiceRoutes);
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
// Personal Reminders CRUD — owner + org scoped (fail-closed). DISTINCT from
// the admin cron-trigger at /api/admin/reminders. See reminders-crud-routes.js.
app.use('/api/reminders', remindersCrudRoutes);
// Cost Inbox — receipt capture (photo + amount + cost code), job/lead-linked.
app.use('/api/receipts', receiptRoutes);
app.use('/api/doc-import', docImportRoutes);
// Saved list views — per-user column/filter configs for list pages.
app.use('/api/list-views', listViewsRoutes);
// Map data — combined leads + jobs feed for the Summary combined map
// (Phase 1 / Deliverable 2). Org-scoped, read-only. See map-routes.js.
app.use('/api/map', mapRoutes);
// Personal calendar events — the per-user Assistant calendar. requireAuth
// only; every query owner + org scoped (fail-closed). See calendar-routes.js.
app.use('/api/calendar', calendarRoutes);
// Outlook / M365 connection (Phase 4, read-only). The router declares full
// paths (/api/me/outlook/* + the /auth/microsoft/callback matching
// MS_REDIRECT_URI), so it mounts at root. Boot-safe: MSAL + the token key are
// lazy, so this is inert until the env vars are set and a user connects.
app.use(outlookRoutes);
app.use('/api/org-tags', orgTagsRoutes);
app.use('/api/markets', marketRoutes);
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
app.use('/api/file-folders', fileFoldersRoutes);
// Sessions sidebar routes mount BEFORE the catch-all aiRoutes so they
// claim /api/ai/sessions/* before any wildcard handler in aiRoutes
// would. Both share helpers via the require('./ai-routes') call inside
// ai-sessions-routes — that's safe because Node caches the export
// object, so the two modules see the same instance.
app.use('/api/ai/sessions', aiSessionsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/assemblies', assemblyRoutes);
app.use('/api/assembly-research', assemblyResearchRoutes);
app.use('/api/assembly-taxonomy', assemblyTaxonomyRoutes);
app.use('/api/qb-costs', qbCostRoutes);
app.use('/api/subs', subRoutes);
// Sub portal routes — mounted at /api so the file can register both
// PM-side paths (`/subs/:subId/invite`) and sub-facing paths
// (`/sub-portal/...`). Order matters: this comes AFTER /api/subs so
// the sub-routes router gets first crack at /subs/* paths and falls
// through to here only for the invite endpoints it doesn't define.
app.use('/api', subPortalRoutes);
app.use('/api', taskShareRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/agent-jobs', require('./routes/agent-jobs-routes'));
app.use('/api/push', require('./routes/push-routes'));
app.use('/api/schedule', scheduleRoutes);
app.use('/api/weather', weatherRoutes);
// Campaigns routes mount BEFORE the generic email mount so the more
// specific /api/email/campaigns paths win over any future glob in
// the parent router.
app.use('/api/email/campaigns', emailCampaignsRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/admin/agents', adminAgentsRoutes);
// Danger Zone — system-admin org "clean slate" hard reset (preview + execute).
app.use('/api/admin/org-reset', adminOrgResetRoutes);
// The ORG tier of the audit read path. Deliberately NOT a parameter on the
// SYSTEM_ADMIN console router: a separate route with its own gate and its own
// projection, so no query-string mistake can widen one into the other.
app.use('/api/org', require('./routes/org-audit-routes'));
// Platform push-key rotation — SYSTEM_ADMIN + typed confirmation + audited.
// Its own deliberate endpoint rather than a second mutating route inside the
// read-only Command Center router, per that router's stated doctrine.
app.use('/api/admin/push', require('./routes/admin-push-routes'));
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
// /api/admin/batch removed 2026-07-03 — the Batches admin surface was
// never used (0 batches ever submitted); bulk audits run as agent_jobs now.
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

// Health check — the endpoint an external uptime monitor polls.
// Deliberately unauthenticated and mounted outside the API auth chain so a
// monitor can reach it, but it reports NO business data: just liveness, the
// build SHA, and whether the database actually answers. The DB probe is the
// point — a process that is up but cannot reach Postgres is NOT healthy, and
// the previous stub (static {status:'ok'}) would have reported green through
// a total database outage. Returns 503 on DB failure so a monitor alerts.
async function healthHandler(req, res) {
  const build = process.env.RAILWAY_GIT_COMMIT_SHA || null;
  let version = null;
  try { version = require('./feature-catalog').APP_VERSION; } catch (e) { /* non-fatal */ }
  try {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'up',
      db_ms: Date.now() - t0,
      version: version,
      build: build ? String(build).slice(0, 8) : null,
      // The RUNTIME production is actually on. Nothing pins the Node major
      // (no engines field, no .nvmrc, no host config), so the host picks it
      // — which makes a rebuild non-reproducible and, more immediately,
      // means nobody could state what to pin TO without guessing. Reporting
      // it is the cheap half of closing PLT-7; the pin follows once this
      // has been read off the live deploy.
      node: process.version,
      uptime_s: Math.round(process.uptime()),
    });
  } catch (e) {
    // Log for the operator; keep the response body free of connection detail.
    console.error('[health] database probe failed:', e.message);
    res.status(503).json({
      status: 'degraded',
      db: 'down',
      version: version,
      build: build ? String(build).slice(0, 8) : null,
      uptime_s: Math.round(process.uptime()),
    });
  }
}
app.get('/api/health', healthHandler);
// /healthz — the conventional path uptime monitors default to. Same handler.
app.get('/healthz', healthHandler);

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

// Public task-share page — an outside worker lands here from the task_share
// email (link is /t/<token>). The page reads the token from its own path and
// talks to the token-gated /api/task-share/* endpoints. No login, no app shell.
app.get('/t/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'task-share.html'));
});

// Public live-room viewer page — someone lands here from a forwarded link
// (/live/<token>). Registered alongside /t/:token, i.e. BEFORE express.static
// and the SPA fallback below, so the token page wins over the app shell.
//
// This is a BESPOKE MINIMAL PAGE, not the app in a read-only shell. Phase 01
// ships a room title, a roster and a cursor surface — mirroring the app's
// navigation is phase 02, and building it now would let one feature shape the
// foundation. Phase 02 changes what this page renders, not this routing.
//
// Referrer-Policy is set EXPLICITLY rather than inherited. The URL carries a
// credential in its path; modern browser defaults happen to keep it out of
// cross-origin Referer headers today, but "the default is currently fine" is
// not a decision. no-store for the same reason: this response is a credential's
// landing page.
app.get('/live/:token', (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'live.html'));
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
      // Audit retention. Daily, and deliberately unhurried — this table needs
      // its indexes long before it needs retention (the arithmetic puts a
      // million rows five to eight years out), so the job exists to keep the
      // promise made in the privacy statement that ageing-out is on a published
      // schedule, not to reclaim space. Tier A rows are never eligible; the
      // purge audits ITSELF fail-closed before it deletes anything.
      try {
        const { purgeExpiredAudit } = require('./services/audit-retention');
        const dayMs = 24 * 60 * 60 * 1000;
        // 90s after boot so it never competes with the first requests, then
        // daily. unref() so it cannot hold the process open.
        setTimeout(() => { purgeExpiredAudit().catch(() => {}); }, 90 * 1000).unref();
        setInterval(() => { purgeExpiredAudit().catch(() => {}); }, dayMs).unref();
      } catch (e) {
        console.warn('[audit-purge] failed to schedule:', e && e.message);
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
      // Email Hub snooze wake-up (E3) — ticks every 5 min. Returns snoozed
      // mail to the owner's own Inbox, unread, once snoozed_until passes.
      // Purely in-app: it sends nothing and touches only rows the owner
      // snoozed themselves.
      try {
        require('./email-snooze-cron').start();
      } catch (e) {
        console.warn('[email-snooze] failed to start scanner:', e && e.message);
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
      // Proactive-watch scheduler removed 2026-07-03 (feature retired —
      // zero watches ever configured; ai_watches/ai_watch_runs tables stay).
      // Background AI-agent task worker. Ticks every 10s: claims queued agent_jobs
      // and runs the headless 86/assistant loop, resumes needs_input jobs the user
      // answered. Inert until a job is created (via the start_background_task tool).
      try {
        require('./agent-jobs-worker').start();
      } catch (e) {
        console.warn('[agent-jobs] failed to start worker:', e && e.message);
      }
      // AI spend alarm — ticks hourly, emails the system admin when
      // trailing-24h token spend crosses AI_SPEND_DAILY_ALERT_USD.
      // Started AFTER the agent-jobs worker on purpose: that worker is
      // the largest token consumer, so the thing most likely to run away
      // is already running by the time the alarm is watching it.
      // Enabled by default at a threshold far above normal use; set the
      // env var to 0 to disable.
      try {
        require('./ai-spend-cron').start();
      } catch (e) {
        console.warn('[ai-spend] failed to start alarm:', e && e.message);
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
