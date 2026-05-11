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
const roleRoutes = require('./routes/role-routes');
const clientRoutes = require('./routes/client-routes');
const leadRoutes = require('./routes/lead-routes');
const settingsRoutes = require('./routes/settings-routes');
const attachmentRoutes = require('./routes/attachment-routes');
const aiRoutes = require('./routes/ai-routes');
const materialRoutes = require('./routes/material-routes');
const qbCostRoutes = require('./routes/qb-cost-routes');
const subRoutes = require('./routes/sub-routes');
const subPortalRoutes = require('./routes/sub-portal-routes');
const messageRoutes = require('./routes/message-routes');
const scheduleRoutes = require('./routes/schedule-routes');
const weatherRoutes = require('./routes/weather-routes');
const emailRoutes = require('./routes/email-routes');
const adminAgentsRoutes = require('./routes/admin-agents-routes');
const adminBatchRoutes = require('./routes/admin-batch-routes');
const adminFilesRoutes = require('./routes/admin-files-routes');
const adminAnthropicRoutes = require('./routes/admin-anthropic-routes');
const adminSmsRoutes = require('./routes/admin-sms-routes');
const smsRoutes = require('./routes/sms-routes');
const reportRoutes = require('./routes/report-routes');
const { storage } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;

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

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);
// Per-job reports nest under /api/jobs/:jobId/reports (mergeParams on
// the router preserves :jobId from this prefix).
app.use('/api/jobs/:jobId/reports', reportRoutes);
app.use('/api/estimates', estimateRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/attachments', attachmentRoutes);
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
app.use('/api/email', emailRoutes);
app.use('/api/admin/agents', adminAgentsRoutes);
app.use('/api/admin/batch', adminBatchRoutes);
app.use('/api/admin/files', adminFilesRoutes);
app.use('/api/admin/anthropic', adminAnthropicRoutes);
app.use('/api/admin/sms', adminSmsRoutes);
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
    console.log(`AGX WIP Tracker running on http://localhost:${PORT}`);
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
