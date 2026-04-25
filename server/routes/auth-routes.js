const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { signToken, requireAuth, requireRole } = require('../auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email.toLowerCase().trim());
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
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/register (admin only)
router.post('/register', requireAuth, requireRole('admin'), (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name required' });
  }
  const validRoles = ['admin', 'corporate', 'pm'];
  const userRole = validRoles.includes(role) ? role : 'pm';

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)'
  ).run(email.toLowerCase().trim(), hash, name, userRole);

  res.json({ id: result.lastInsertRowid, email: email.toLowerCase().trim(), name, role: userRole });
});

// GET /api/auth/users (admin only)
router.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, email, name, role, active, created_at FROM users').all();
  res.json({ users });
});

// PUT /api/auth/users/:id (admin only)
router.put('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const { name, role, active } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare(
    'UPDATE users SET name = ?, role = ?, active = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(name || user.name, role || user.role, active != null ? active : user.active, req.params.id);

  res.json({ ok: true });
});

// PUT /api/auth/password (change own password)
router.put('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }

  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), req.user.id);

  res.json({ ok: true });
});

module.exports = router;
