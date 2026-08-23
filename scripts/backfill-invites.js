/**
 * One-off backfill: email the invitations that were created before the app
 * could send mail.
 *
 *   node scripts/backfill-invites.js              # DRY RUN - shows the plan, sends nothing
 *   node scripts/backfill-invites.js --send       # actually sends
 *   node scripts/backfill-invites.js --send --team 3
 *   node scripts/backfill-invites.js --send --prune-duplicates
 *
 * Seat accounting is the tricky part. seatUsage() in routes/teams.js counts a
 * pending invitation against the team's cap only while it is UNEXPIRED:
 *
 *   invitations WHERE used_at IS NULL AND expires_at > NOW()
 *
 * So:
 *   • A pending, unexpired invite already holds a seat -> emailing it costs
 *     nothing new. Always safe.
 *   • A pending, EXPIRED invite holds no seat, and its link is dead. To make it
 *     usable we must push the expiry out, which re-takes a seat. We only do
 *     that when the team has room, and we report the ones we skipped so the
 *     coach can add seats or cancel stale invites deliberately.
 *   • Duplicate pending invites to the same address each hold their own seat.
 *     Only the newest is emailed; --prune-duplicates deletes the older rows
 *     and frees those seats.
 *
 * Anyone who already has an account is skipped - they don't need an invite.
 */
require('dotenv').config();
const { pool } = require('../db');
const { sendInviteEmail } = require('../services/emails');
const { isConfigured } = require('../services/mailer');

const INCLUDED_SEATS = 15;
const TTL_DAYS = 7;
const THROTTLE_MS = 1000; // stay well clear of Workspace rate limits

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const PRUNE = args.includes('--prune-duplicates');
const teamArg = args.indexOf('--team');
const ONLY_TEAM = teamArg > -1 ? parseInt(args[teamArg + 1], 10) : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

async function main() {
  if (SEND && !isConfigured()) {
    console.error('✖ SMTP is not configured (SMTP_USER / SMTP_PASS). Nothing would send.');
    console.error('  Run with no flags for a dry run, or configure mail first (DEPLOY_BETA.md Part 2b).');
    process.exit(1);
  }
  console.log(SEND ? '● LIVE RUN - emails will be sent\n' : '● DRY RUN - no email will be sent, nothing will be modified\n');

  // Every pending invitation whose address doesn't already have an account.
  const { rows: invites } = await pool.query(`
    SELECT i.id, i.email, i.token, i.team_id, i.created_at, i.expires_at,
           (i.expires_at <= NOW()) AS expired,
           t.name AS team_name, t.max_members,
           u.name AS coach_name
      FROM invitations i
      JOIN teams t ON t.id = i.team_id
      LEFT JOIN users u ON u.id = t.admin_user_id
     WHERE i.used_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM users x WHERE LOWER(x.email) = LOWER(i.email))
       ${ONLY_TEAM ? 'AND i.team_id = $1' : ''}
     ORDER BY i.team_id, LOWER(i.email), i.created_at DESC`,
    ONLY_TEAM ? [ONLY_TEAM] : []);

  if (!invites.length) { console.log('No pending invitations to backfill.'); return; }

  // Current seat usage per team (players + invites that are holding a seat now).
  const teamIds = [...new Set(invites.map(i => i.team_id))];
  const { rows: usage } = await pool.query(`
    SELECT t.id,
      (SELECT COUNT(*) FROM users u WHERE u.team_id=t.id AND u.role='team_member')::int AS players,
      (SELECT COUNT(*) FROM invitations v WHERE v.team_id=t.id AND v.used_at IS NULL AND v.expires_at > NOW())::int AS holding
    FROM teams t WHERE t.id = ANY($1)`, [teamIds]);
  const seats = new Map(usage.map(u => [u.id, u]));

  const plan = { send: [], refreshSend: [], duplicates: [], noSeat: [] };
  const seenPerTeam = new Map(); // "teamId|email" -> already chose the newest

  for (const inv of invites) {
    const key = `${inv.team_id}|${inv.email.toLowerCase()}`;
    if (seenPerTeam.has(key)) { plan.duplicates.push(inv); continue; }
    seenPerTeam.set(key, true);

    if (!inv.expired) { plan.send.push(inv); continue; }

    // Expired: needs a seat back before its link is worth anything.
    const u = seats.get(inv.team_id);
    const cap = inv.max_members || INCLUDED_SEATS;
    if (u.players + u.holding < cap) { u.holding += 1; plan.refreshSend.push(inv); }
    else plan.noSeat.push({ ...inv, cap });
  }

  // ── Plan ──────────────────────────────────────────────────────────────────
  const line = (inv, note) => `   ${pad(inv.email, 34)} ${pad(inv.team_name, 26)} ${note}`;
  console.log(`Found ${invites.length} pending invitation(s) across ${teamIds.length} team(s).\n`);
  if (plan.send.length) {
    console.log(`✉  EMAIL AS-IS  (${plan.send.length}) - already holding a seat, link still valid`);
    plan.send.forEach(i => console.log(line(i, `expires ${new Date(i.expires_at).toLocaleDateString()}`)));
    console.log('');
  }
  if (plan.refreshSend.length) {
    console.log(`♻  REFRESH + EMAIL  (${plan.refreshSend.length}) - expired link, team has room, expiry reset to ${TTL_DAYS} days`);
    plan.refreshSend.forEach(i => console.log(line(i, `was expired ${new Date(i.expires_at).toLocaleDateString()}`)));
    console.log('');
  }
  if (plan.duplicates.length) {
    console.log(`⊘  DUPLICATES  (${plan.duplicates.length}) - older invite to the same address; newest is the one emailed`);
    plan.duplicates.forEach(i => console.log(line(i, PRUNE ? 'will be DELETED (frees a seat if it held one)' : 'left alone (--prune-duplicates to delete)')));
    console.log('');
  }
  if (plan.noSeat.length) {
    console.log(`✖  NO SEAT  (${plan.noSeat.length}) - expired and the team is at its cap. Not reactivated.`);
    plan.noSeat.forEach(i => console.log(line(i, `cap ${i.cap} full - add seats or cancel a stale invite`)));
    console.log('');
  }

  if (!SEND) {
    console.log('Dry run complete. Re-run with --send to act on this plan.');
    return;
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  let sent = 0, failed = 0, pruned = 0;
  for (const inv of [...plan.send, ...plan.refreshSend]) {
    const refresh = plan.refreshSend.includes(inv);
    if (refresh) {
      await pool.query('UPDATE invitations SET expires_at = NOW() + INTERVAL \'' + TTL_DAYS + ' days\' WHERE id=$1', [inv.id]);
    }
    const base = (process.env.APP_URL || 'https://www.collegegolfmetrics.com').replace(/\/+$/, '');
    const r = await sendInviteEmail(inv.email, {
      teamName: inv.team_name,
      coachName: inv.coach_name,
      inviteUrl: `${base}/accept-invite.html?token=${inv.token}`,
      expiresDays: TTL_DAYS,
    });
    if (r.sent) { sent++; console.log(`   ✔ ${inv.email}`); }
    else { failed++; console.log(`   ✖ ${inv.email} - ${r.reason} ${r.error || ''}`); }
    await sleep(THROTTLE_MS);
  }

  if (PRUNE && plan.duplicates.length) {
    const { rowCount } = await pool.query('DELETE FROM invitations WHERE id = ANY($1)', [plan.duplicates.map(d => d.id)]);
    pruned = rowCount;
  }

  console.log(`\nDone. ${sent} sent, ${failed} failed${pruned ? `, ${pruned} duplicate row(s) deleted` : ''}.`);
  if (plan.noSeat.length) console.log(`${plan.noSeat.length} expired invite(s) left inactive for want of seats.`);
}

main()
  .catch(err => { console.error('Backfill failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
