const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { signToken, requireAuth, requireRole } = require('../auth');

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
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/register (admin only)
router.post('/register', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name required' });
    }
    const validRoles = ['admin', 'corporate', 'pm'];
    const userRole = validRoles.includes(role) ? role : 'pm';

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = bcrypt.hashSync(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [email.toLowerCase().trim(), hash, name, userRole]
    );

    res.json({ id: result.rows[0].id, email: email.toLowerCase().trim(), name, role: userRole });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/users (admin only)
router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, name, role, active, created_at FROM users');
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/users/:id (admin only)
router.put('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { name, role, active } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    await pool.query(
      'UPDATE users SET name = $1, role = $2, active = $3, updated_at = NOW() WHERE id = $4',
      [name || user.name, role || user.role, active != null ? active : user.active, req.params.id]
    );

    res.json({ ok: true });
  } catch (e) {
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
    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [bcrypt.hashSync(newPassword, 10), req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/auth/users/:id/password error:', e);
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
