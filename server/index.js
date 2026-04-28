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
const { storage } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/estimates', estimateRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/ai', aiRoutes);

// Serve uploaded files when running with the local storage backend.
// On Railway with a mounted volume, set UPLOAD_DIR to the mount path
// (e.g. /data/uploads) and this serves them from there. R2 backend
// returns absolute URLs so this static mount is unused.
if (storage.localRoot) {
  app.use(storage.publicBase, express.static(storage.localRoot, {
    fallthrough: true,
    maxAge: '7d'
  }));
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
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

init().then(refreshRoleCache).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AGX WIP Tracker running on http://localhost:${PORT}`);
    if (process.env.ADMIN_EMAIL) {
      console.log(`Admin user synced from env: ${process.env.ADMIN_EMAIL}`);
    } else {
      console.log('No ADMIN_EMAIL/ADMIN_PASSWORD env vars set — using dev admin@local / changeme');
    }
  });
}).catch(err => {
  console.error('Failed to initialize database:', err.message);
  process.exit(1);
});
