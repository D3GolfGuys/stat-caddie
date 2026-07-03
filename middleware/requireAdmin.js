// Gate a route to the platform owner only. Admin email comes from the
// ADMIN_EMAIL env var, defaulting to the founder's address. Must run after
// requireAuth (which populates req.user).
module.exports = function requireAdmin(req, res, next) {
  const adminEmail = (process.env.ADMIN_EMAIL || 'mdeckert24@gmail.com').toLowerCase();
  const email = (req.user && req.user.email || '').toLowerCase();
  if (email !== adminEmail) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
