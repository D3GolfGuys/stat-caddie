/**
 * Team roles — one place, so "who counts as a coach" is never re-decided
 * inline in a query or a template.
 *
 *   team_admin     head coach. Owns the team record: billing, seats, roster
 *                  (invite / remove) and team settings.
 *   team_assistant assistant coach. Sees everything the head coach sees and
 *                  runs qualifying, but cannot change the roster or billing.
 *   team_member    player. Logs their own rounds.
 *
 * Coaches are staff, not competitors: their own rounds never feed team stats,
 * and they never consume a player seat.
 */
const HEAD_COACH = 'team_admin';
const ASSISTANT  = 'team_assistant';
const PLAYER     = 'team_member';

const COACH_ROLES = [HEAD_COACH, ASSISTANT];
// Roles whose access rides on the TEAM's subscription rather than their own.
const TEAM_BILLED_ROLES = [ASSISTANT, PLAYER];

const roleOf      = u => (u && u.role) || null;
const isHeadCoach = u => roleOf(u) === HEAD_COACH;
const isAssistant = u => roleOf(u) === ASSISTANT;
const isCoach     = u => COACH_ROLES.includes(roleOf(u));
const isPlayer    = u => roleOf(u) === PLAYER;

// SQL fragment for "this row belongs to a player" — use it anywhere team
// numbers are computed so assistant coaches are excluded alongside the head
// coach. Expects the users table aliased as `u`.
const PLAYER_SQL = `u.role = '${PLAYER}'`;

// Human label for a role, for UI and email copy.
function roleLabel(role) {
  if (role === HEAD_COACH) return 'Head Coach';
  if (role === ASSISTANT)  return 'Assistant Coach';
  if (role === PLAYER)     return 'Player';
  return 'Member';
}

module.exports = {
  HEAD_COACH, ASSISTANT, PLAYER, COACH_ROLES, TEAM_BILLED_ROLES,
  isHeadCoach, isAssistant, isCoach, isPlayer, PLAYER_SQL, roleLabel,
};
