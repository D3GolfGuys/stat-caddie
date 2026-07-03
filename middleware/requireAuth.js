const jwt = require('jsonwebtoken');
const { pool } = require('../db');

module.exports = async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query('SELECT id, email, name, role, team_id, subscription_status, subscription_plan FROM users WHERE id = $1', [payload.userId]);
    if (!rows.length) return res.status(401).json({ error: 'User not found' });

    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
