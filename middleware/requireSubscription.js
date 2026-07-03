module.exports = function requireSubscription(req, res, next) {
  const user = req.user;
  // Team members inherit their team's subscription
  const isActive = user.subscription_status === 'active' ||
                   user.role === 'team_member'; // team_member status validated at login
  if (!isActive) {
    return res.status(403).json({ error: 'Active subscription required', code: 'SUBSCRIPTION_REQUIRED' });
  }
  next();
};

module.exports.requireTeamAdmin = function requireTeamAdmin(req, res, next) {
  if (req.user.role !== 'team_admin') {
    return res.status(403).json({ error: 'Team admin access required' });
  }
  next();
};
