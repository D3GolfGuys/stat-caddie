const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');
const { findOrCreateSchool } = require('../services/schools');
const crypto = require('crypto');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('../services/emails');

const RESET_TTL_MINUTES = 60;
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
function appUrl() {
  return (process.env.APP_URL || 'https://www.collegegolfmetrics.com').replace(/\/+$/, '');
}

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
// Two account types:
//   • individual — a solo golfer (role 'individual').
//   • coach      — creates a NEW team and becomes its admin (role 'team_admin').
// Accepts the new `accountType` ('individual' | 'coach') and `teamName`, and
// still honors the legacy `plan==='team'` selection so older clients keep working.
router.post('/register', async (req, res) => {
  const { email, password, name, plan, accountType, teamName, division, schoolName, conference, gender } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, password and name are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const isCoach = accountType === 'coach' || accountType === 'team' || plan === 'team';
  const resolvedTeamName = String(teamName || '').trim() || `${name}'s Team`;
  const betaMode = process.env.BETA_MODE === 'true';

  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 12);

    if (isCoach) {
      // Coach signup: create the coach, the team, and link them — atomically.
      await client.query('BEGIN');
      const { rows: userRows } = await client.query(
        `INSERT INTO users (email, password_hash, name, role, subscription_status, subscription_plan)
         VALUES ($1, $2, $3, 'team_admin', $4, 'team')
         RETURNING id, email, name, role, subscription_status, subscription_plan`,
        [email.toLowerCase(), password_hash, name, betaMode ? 'active' : 'inactive']
      );
      const user = userRows[0];
      const schoolId = await findOrCreateSchool(client, { name: schoolName || resolvedTeamName, division, conference });
      const { rows: teamRows } = await client.query(
        `INSERT INTO teams (name, admin_user_id, subscription_status, max_members, division, conference, school_id, school_name, gender)
         VALUES ($1, $2, $3, 15, $4, $5, $6, $7, $8)
         RETURNING id, name, max_members, division`,
        [resolvedTeamName, user.id, betaMode ? 'active' : 'inactive', division || null, conference || null, schoolId, schoolName || null, gender || null]
      );
      const team = teamRows[0];
      await client.query('UPDATE users SET team_id = $1 WHERE id = $2', [team.id, user.id]);
      await client.query('COMMIT');

      user.team_id = team.id;
      issueToken(user.id, res);
      return res.status(201).json({ user, team, accountType: 'coach', betaMode });
    }

    // Individual signup (unchanged behavior).
    const { rows } = await client.query(
      'INSERT INTO users (email, password_hash, name, role, subscription_status, subscription_plan) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, name, role, subscription_status, subscription_plan',
      [email.toLowerCase(), password_hash, name, 'individual', betaMode ? 'active' : 'inactive', betaMode ? (plan || 'individual') : null]
    );
    const user = rows[0];
    issueToken(user.id, res);
    return res.status(201).json({ user, plan: plan || 'individual', accountType: 'individual', betaMode });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(err);
    return res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
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
  const { isAdminEmail } = require('../services/admins');
  const isAdmin = isAdminEmail(req.user.email);
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

    // Welcome mail is best-effort - the account is already live either way.
    const { rows: teamRows } = await pool.query('SELECT name FROM teams WHERE id = $1', [inv.team_id]);
    sendWelcomeEmail(inv.email, { playerName: name, teamName: teamRows[0]?.name });

    issueToken(rows[0].id, res);
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

// POST /api/auth/forgot-password  { email }
// Always answers 200 with the same body, whether or not the address has an
// account - otherwise this endpoint becomes a way to enumerate our users.
router.post('/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'If that email has an account, a reset link is on its way.' };
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { rows } = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [email]);
    if (!rows.length) return res.json(generic);
    const user = rows[0];

    // One live token at a time - older unused ones are burned.
    await pool.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);
    await pool.query(
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, hashToken(token), expiresAt]
    );

    await sendPasswordResetEmail(user.email, {
      name: user.name,
      resetUrl: `${appUrl()}/reset-password.html?token=${token}`,
      expiresMinutes: RESET_TTL_MINUTES,
    });
    return res.json(generic);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not start password reset' });
  }
});

// POST /api/auth/reset-password  { token, password }
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const { rows } = await pool.query(
      `SELECT pr.id, pr.user_id, u.email, u.name
         FROM password_resets pr JOIN users u ON u.id = pr.user_id
        WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > NOW()`,
      [hashToken(String(token))]
    );
    if (!rows.length) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    const reset = rows[0];

    const password_hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [password_hash, reset.user_id]);
    await pool.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [reset.id]);

    return res.json({ ok: true, email: reset.email });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not reset password' });
  }
});

module.exports = router;
