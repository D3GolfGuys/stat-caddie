const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');

function issueToken(userId, res) {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  return token;
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, name, plan } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, password and name are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const betaMode = process.env.BETA_MODE === 'true';
    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name, role, subscription_status, subscription_plan) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, name, role, subscription_status, subscription_plan',
      [email.toLowerCase(), password_hash, name, 'individual', betaMode ? 'active' : 'inactive', betaMode ? (plan || 'individual') : null]
    );
    const user = rows[0];
    issueToken(user.id, res);
    res.status(201).json({ user, plan: plan || 'individual', betaMode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, role, team_id, subscription_status, subscription_plan, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid email or password' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    // For team members, check team subscription
    if (user.role === 'team_member' && user.team_id) {
      const { rows: teamRows } = await pool.query('SELECT subscription_status FROM teams WHERE id = $1', [user.team_id]);
      if (teamRows.length && teamRows[0].subscription_status !== 'active') {
        return res.status(403).json({ error: 'Team subscription is inactive. Contact your team admin.' });
      }
    }

    delete user.password_hash;
    issueToken(user.id, res);
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const adminEmail = (process.env.ADMIN_EMAIL || 'mdeckert24@gmail.com').toLowerCase();
  const isAdmin = (req.user.email || '').toLowerCase() === adminEmail;
  res.json({ user: { ...req.user, isAdmin } });
});

// POST /api/auth/accept-invite  (join team via invitation token)
router.post('/accept-invite', async (req, res) => {
  const { token, password, name } = req.body;
  if (!token || !password || !name) return res.status(400).json({ error: 'Token, name and password required' });

  try {
    const { rows: invRows } = await pool.query(
      'SELECT * FROM invitations WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()',
      [token]
    );
    if (!invRows.length) return res.status(400).json({ error: 'Invalid or expired invitation' });
    const inv = invRows[0];

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [inv.email]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered. Please log in.' });

    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name, role, team_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role, team_id',
      [inv.email, password_hash, name, 'team_member', inv.team_id]
    );
    await pool.query('UPDATE invitations SET used_at = NOW() WHERE id = $1', [inv.id]);

    issueToken(rows[0].id, res);
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

module.exports = router;
