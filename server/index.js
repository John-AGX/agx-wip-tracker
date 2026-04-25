const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { getDb } = require('./db');
const authRoutes = require('./routes/auth-routes');
const jobRoutes = require('./routes/job-routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database on startup
getDb();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..')));

// SPA fallback — serve index.html for any non-API route
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AGX WIP Tracker running on http://localhost:${PORT}`);
  console.log(`Default login: admin@agx.com / admin123`);
});
