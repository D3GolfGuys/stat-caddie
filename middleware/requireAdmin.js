// Gate a route to the platform owner only. Admin email comes from the
// ADMIN_EMAIL env var, defaulting to the founder's address. Must run after
// requireAuth (which populates req.user).
const { isAdminEmail } = require('../services/admins');
module.exports = function requireAdmin(req, res, next) {
  if (!isAdminEmail(req.user && req.user.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
