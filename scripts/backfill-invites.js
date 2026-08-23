/**
 * One-off backfill from the command line: email the invitations that were
 * created before the app could send mail.
 *
 *   node scripts/backfill-invites.js              DRY RUN - shows the plan
 *   node scripts/backfill-invites.js --send       actually sends
 *   node scripts/backfill-invites.js --send --prune-duplicates
 *
 * The same job is available as a button in the admin console
 * (Admin -> Pending invitations), which is easier and runs on the server where
 * the database and SMTP credentials already live. This CLI exists for bulk or
 * scripted runs. Planning and seat accounting live in
 * services/inviteBackfill.js - see the comments there.
 */
require('dotenv').config();
const { pool } = require('../db');
const { buildPlan, candidates, start, jobSnapshot, TTL_DAYS } = require('../services/inviteBackfill');
const { isConfigured } = require('../services/mailer');

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const PRUNE = args.includes('--prune-duplicates');
const teamArg = args.indexOf('--team');
const ONLY_TEAM = teamArg > -1 ? parseInt(args[teamArg + 1], 10) : null;

const pad = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);
const line = (inv, note) => `   ${pad(inv.email, 34)} ${pad(inv.team_name, 26)} ${note}`;

async function main() {
  if (SEND && !isConfigured()) {
    console.error('SMTP is not configured (SMTP_USER / SMTP_PASS). Nothing would send.');
    process.exit(1);
  }
  console.log(SEND ? 'LIVE RUN - emails will be sent\n' : 'DRY RUN - nothing is sent or modified\n');

  const plan = await buildPlan(pool, { teamId: ONLY_TEAM });
  if (!plan.total) { console.log('No pending invitations to backfill.'); return; }
  console.log(`Found ${plan.total} pending invitation(s) across ${plan.teams} team(s).\n`);

  if (plan.ready.length) {
    console.log(`EMAIL AS-IS (${plan.ready.length}) - already holding a seat, link still valid`);
    plan.ready.forEach(i => console.log(line(i, `expires ${new Date(i.expires_at).toLocaleDateString()}`)));
    console.log('');
  }
  if (plan.refresh.length) {
    console.log(`REFRESH + EMAIL (${plan.refresh.length}) - expired link, team has room, expiry reset to ${TTL_DAYS} days`);
    plan.refresh.forEach(i => console.log(line(i, `was expired ${new Date(i.expires_at).toLocaleDateString()}`)));
    console.log('');
  }
  if (plan.resend.length) {
    console.log(`ALREADY EMAILED (${plan.resend.length}) - skipped by the CLI; re-send from the admin console if needed`);
    plan.resend.forEach(i => console.log(line(i, `emailed ${new Date(i.emailed_at).toLocaleDateString()}`)));
    console.log('');
  }
  if (plan.duplicates.length) {
    console.log(`DUPLICATES (${plan.duplicates.length}) - older invite to the same address; newest is the one emailed`);
    plan.duplicates.forEach(i => console.log(line(i, PRUNE ? 'will be DELETED (frees a seat if it held one)' : 'left alone (--prune-duplicates to delete)')));
    console.log('');
  }
  if (plan.noSeat.length) {
    console.log(`NO SEAT (${plan.noSeat.length}) - expired and the team is at its cap. Not reactivated.`);
    plan.noSeat.forEach(i => console.log(line(i, `cap ${i.cap} full - add seats or cancel a stale invite`)));
    console.log('');
  }

  if (!SEND) { console.log('Dry run complete. Re-run with --send to act on this plan.'); return; }

  if (PRUNE && plan.duplicates.length) {
    const { rowCount } = await pool.query('DELETE FROM invitations WHERE id = ANY($1)', [plan.duplicates.map(d => d.id)]);
    console.log(`Deleted ${rowCount} duplicate invitation row(s).`);
  }

  // The job runs in the background; poll it so the CLI stays a foreground tool.
  start(pool, [...plan.ready, ...plan.refresh]);
  let last = -1;
  for (;;) {
    const { running, job: j } = jobSnapshot();
    if (j && j.done !== last) { last = j.done; console.log(`   ${j.done}/${j.total} ${j.currentEmail || ''}`); }
    if (!running) {
      j.failed.forEach(f => console.log(`   FAILED  ${f.email} - ${f.reason} ${f.error || ''}`));
      console.log(`\nDone. ${j.sent.length} sent, ${j.failed.length} failed.`);
      break;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  if (plan.noSeat.length) console.log(`${plan.noSeat.length} expired invite(s) left inactive for want of seats.`);
}

main()
  .catch(err => { console.error('Backfill failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
