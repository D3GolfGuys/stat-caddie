/**
 * Invite backfill
 * ---------------
 * Coaches sent invitations while the app had no email layer, so those players
 * were never actually contacted - and the invitations sit on team seats. This
 * plans and executes the catch-up send.
 *
 * The seat rule is the subtle part. seatUsage() in routes/teams.js charges a
 * pending invitation against the team's cap only while it is UNEXPIRED:
 *
 *     invitations WHERE used_at IS NULL AND expires_at > NOW()
 *
 * Which splits the work three ways:
 *   • pending + unexpired - already holding a seat, so emailing costs nothing.
 *   • pending + EXPIRED   - holds no seat and its link is dead. Making it usable
 *                           means pushing the expiry out, which RE-TAKES a seat.
 *                           Only done when the team is under cap; the rest are
 *                           reported so the coach can add seats or cancel
 *                           deliberately, rather than being silently overfilled.
 *   • duplicates          - two pending rows for one address hold two seats.
 *                           Only the newest is emailed; pruning frees the rest.
 *
 * Addresses that already have an account are skipped - they don't need inviting.
 *
 * Shared by scripts/backfill-invites.js (CLI) and POST /api/admin/backfill-invites.
 */
const { sendInviteEmail } = require('./emails');

const INCLUDED_SEATS = 15;
const TTL_DAYS = 7;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Read-only. Returns what a send would do, with no side effects. */
async function buildPlan(db, { teamId = null } = {}) {
  const { rows: invites } = await db.query(`
    SELECT i.id, i.email, i.token, i.team_id, i.created_at, i.expires_at,
           (i.expires_at <= NOW()) AS expired,
           t.name AS team_name, t.max_members,
           u.name AS coach_name
      FROM invitations i
      JOIN teams t ON t.id = i.team_id
      LEFT JOIN users u ON u.id = t.admin_user_id
     WHERE i.used_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM users x WHERE LOWER(x.email) = LOWER(i.email))
       ${teamId ? 'AND i.team_id = $1' : ''}
     ORDER BY i.team_id, LOWER(i.email), i.created_at DESC`,
    teamId ? [teamId] : []);

  const plan = { send: [], refreshSend: [], duplicates: [], noSeat: [], teams: 0, total: invites.length };
  if (!invites.length) return plan;

  const teamIds = [...new Set(invites.map(i => i.team_id))];
  plan.teams = teamIds.length;

  const { rows: usage } = await db.query(`
    SELECT t.id,
      (SELECT COUNT(*) FROM users u WHERE u.team_id=t.id AND u.role='team_member')::int AS players,
      (SELECT COUNT(*) FROM invitations v WHERE v.team_id=t.id AND v.used_at IS NULL AND v.expires_at > NOW())::int AS holding
    FROM teams t WHERE t.id = ANY($1)`, [teamIds]);
  const seats = new Map(usage.map(u => [u.id, u]));

  const seen = new Set();
  for (const inv of invites) {
    const key = `${inv.team_id}|${inv.email.toLowerCase()}`;
    if (seen.has(key)) { plan.duplicates.push(inv); continue; }
    seen.add(key);

    if (!inv.expired) { plan.send.push(inv); continue; }

    const u = seats.get(inv.team_id);
    const cap = inv.max_members || INCLUDED_SEATS;
    if (u.players + u.holding < cap) { u.holding += 1; plan.refreshSend.push(inv); }
    else plan.noSeat.push({ ...inv, cap });
  }
  return plan;
}

/** Sends the plan. `throttleMs` spaces the sends to stay clear of rate limits. */
async function execute(db, plan, { prune = false, throttleMs = 1000, appUrl } = {}) {
  const base = (appUrl || process.env.APP_URL || 'https://www.collegegolfmetrics.com').replace(/\/+$/, '');
  const results = { sent: [], failed: [], pruned: 0 };
  const refreshIds = new Set(plan.refreshSend.map(i => i.id));

  for (const inv of [...plan.send, ...plan.refreshSend]) {
    if (refreshIds.has(inv.id)) {
      await db.query(`UPDATE invitations SET expires_at = NOW() + INTERVAL '${TTL_DAYS} days' WHERE id=$1`, [inv.id]);
    }
    const r = await sendInviteEmail(inv.email, {
      teamName: inv.team_name,
      coachName: inv.coach_name,
      inviteUrl: `${base}/accept-invite.html?token=${inv.token}`,
      expiresDays: TTL_DAYS,
    });
    if (r.sent) results.sent.push(inv.email);
    else results.failed.push({ email: inv.email, reason: r.reason, error: r.error });
    if (throttleMs) await sleep(throttleMs);
  }

  if (prune && plan.duplicates.length) {
    const { rowCount } = await db.query('DELETE FROM invitations WHERE id = ANY($1)', [plan.duplicates.map(d => d.id)]);
    results.pruned = rowCount;
  }
  return results;
}

module.exports = { buildPlan, execute, INCLUDED_SEATS, TTL_DAYS };
