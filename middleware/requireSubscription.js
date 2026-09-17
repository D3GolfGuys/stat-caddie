const { isCoach, isHeadCoach, TEAM_BILLED_ROLES } = require('../services/roles');

module.exports = function requireSubscription(req, res, next) {
  const user = req.user;
  // Players and assistant coaches inherit their team's subscription
  // (re-validated at login against teams.subscription_status).
  const isActive = user.subscription_status === 'active' ||
                   TEAM_BILLED_ROLES.includes(user.role);
  if (!isActive) {
    return res.status(403).json({ error: 'Active subscription required', code: 'SUBSCRIPTION_REQUIRED' });
  }
  next();
};

// Head coach only — anything that changes the roster, the seats or the team
// record itself. An assistant hitting these gets a plain explanation, not a
// bare 403, so the UI can say who to ask.
module.exports.requireTeamAdmin = function requireTeamAdmin(req, res, next) {
  if (!isHeadCoach(req.user)) {
    return res.status(403).json({
      code: 'HEAD_COACH_ONLY',
      error: isCoach(req.user)
        ? 'Only the head coach can change the roster, seats or team settings.'
        : 'Team admin access required',
    });
  }
  next();
};

// Any coach on the team — head or assistant. Everything an assistant is
// allowed to see and run: team views, player drill-downs, qualifying.
module.exports.requireCoach = function requireCoach(req, res, next) {
  if (!isCoach(req.user)) {
    return res.status(403).json({ error: 'Coach access required', code: 'COACH_ONLY' });
  }
  next();
};
