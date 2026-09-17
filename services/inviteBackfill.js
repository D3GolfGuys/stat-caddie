/**
 * Invite backfill
 * ---------------
 * Coaches sent invitations while the app had no email layer, so those players
 * were never contacted - and the invitations sit on team seats. This plans and
 * runs the catch-up send.
 *
 * WHY THIS RUNS AS A BACKGROUND JOB
 * A send loop inside the HTTP request died against Railway's edge proxy
 * ("upstream error") while the server kept mailing - the operator was left not
 * knowing who had been contacted. So: the request starts a job and returns
 * immediately, the console polls for progress, and every successful send is
 * stamped on the row (invitations.emailed_at). That stamp makes the whole job
 * resumable and idempotent: re-running never silently re-mails anyone, and a
 * deliberate re-send is a separate, explicitly-chosen group.
 *
 * THE SEAT RULE
 * seatUsage() in routes/teams.js charges a pending invitation against the cap
 * only while it is UNEXPIRED:
 *     invitations WHERE used_at IS NULL AND expires_at > NOW()
 * so:
 *   • unexpired      - already holds a seat; emailing costs nothing.
 *   • expired        - holds no seat and its link is dead. Reviving it means
 *                      pushing the expiry out, which RE-TAKES a seat. Only done
 *                      when the team is under cap; the rest are reported, not
 *                      silently forced in.
 *   • duplicates     - two pending rows for one address hold two seats. Only
 *                      the newest is offered; deleting the rest frees seats.
 * Addresses that already have an account are skipped entirely.
 */
const { sendInviteEmail } = require('./emails');

const INCLUDED_SEATS = 15;
const TTL_DAYS = 7;
const THROTTLE_MS = 600;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Planning (read-only) ────────────────────────────────────────────────────
async function buildPlan(db, { teamId = null } = {}) {
  const { rows: invites } = await db.query(`
    SELECT i.id, i.email, i.token, i.team_id, i.created_at, i.expires_at, i.emailed_at,
           COALESCE(i.role, 'team_member') AS role,
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

  const plan = { ready: [], refresh: [], resend: [], duplicates: [], noSeat: [], teams: 0, total: invites.length };
  if (!invites.length) return plan;

  const teamIds = [...new Set(invites.map(i => i.team_id))];
  plan.teams = teamIds.length;

  const { rows: usage } = await db.query(`
    SELECT t.id,
      (SELECT COUNT(*) FROM users u WHERE u.team_id=t.id AND u.role='team_member')::int AS players,
      (SELECT COUNT(*) FROM invitations v WHERE v.team_id=t.id AND v.used_at IS NULL AND v.expires_at > NOW()
                                             AND COALESCE(v.role,'team_member')='team_member')::int AS holding
    FROM teams t WHERE t.id = ANY($1)`, [teamIds]);
  const seats = new Map(usage.map(u => [u.id, u]));

  const seen = new Set();
  for (const inv of invites) {
    const key = `${inv.team_id}|${inv.email.toLowerCase()}`;
    if (seen.has(key)) { plan.duplicates.push(inv); continue; }
    seen.add(key);

    // Already mailed at some point - offered only as a deliberate re-send.
    if (inv.emailed_at && !inv.expired) { plan.resend.push(inv); continue; }

    if (!inv.expired) { plan.ready.push(inv); continue; }

    // Assistant-coach invites hold no seat, so reviving one is always free.
    if (inv.role === 'team_assistant') { inv.needsRefresh = true; plan.refresh.push(inv); continue; }

    const u = seats.get(inv.team_id);
    const cap = inv.max_members || INCLUDED_SEATS;
    if (u.players + u.holding < cap) { u.holding += 1; inv.needsRefresh = true; plan.refresh.push(inv); }
    else plan.noSeat.push({ ...inv, cap });
  }
  return plan;
}

/** Every invite the operator is allowed to pick from, flattened. */
function candidates(plan) {
  return [...plan.ready, ...plan.refresh, ...plan.resend];
}

// ── Background job ──────────────────────────────────────────────────────────
// One at a time, in memory. A restart loses the progress readout but not the
// work: emailed_at is already on the rows, so a re-run picks up where it left.
let job = null;

function jobSnapshot() {
  if (!job) return { running: false, job: null };
  return {
    running: job.running,
    job: {
      id: job.id, total: job.total, done: job.done,
      sent: job.sent, failed: job.failed,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
      currentEmail: job.currentEmail, error: job.error,
    },
  };
}

function start(db, invites, { appUrl } = {}) {
  if (job && job.running) return { started: false, reason: 'already_running', ...jobSnapshot() };

  job = {
    id: `bf_${Date.now()}`, running: true, total: invites.length, done: 0,
    sent: [], failed: [], startedAt: new Date().toISOString(), finishedAt: null,
    currentEmail: null, error: null,
  };

  // Deliberately not awaited - the HTTP request returns immediately.
  (async () => {
    const base = (appUrl || process.env.APP_URL || 'https://www.collegegolfmetrics.com').replace(/\/+$/, '');
    try {
      for (const inv of invites) {
        job.currentEmail = inv.email;
        if (inv.needsRefresh) {
          await db.query(`UPDATE invitations SET expires_at = NOW() + INTERVAL '${TTL_DAYS} days' WHERE id=$1`, [inv.id]);
        }
        const r = await sendInviteEmail(inv.email, {
          teamName: inv.team_name, coachName: inv.coach_name,
          inviteUrl: `${base}/accept-invite.html?token=${inv.token}`,
          expiresDays: TTL_DAYS,
          role: inv.role,
        });
        if (r.sent) {
          // Stamp BEFORE moving on, so a crash can never lose the record of a
          // message that has already left.
          await db.query('UPDATE invitations SET emailed_at = NOW() WHERE id=$1', [inv.id]);
          job.sent.push(inv.email);
        } else {
          job.failed.push({ email: inv.email, reason: r.reason, error: r.error });
        }
        job.done += 1;
        if (THROTTLE_MS) await sleep(THROTTLE_MS);
      }
    } catch (err) {
      job.error = err.message;
      console.error('[backfill] job failed:', err);
    } finally {
      job.running = false;
      job.currentEmail = null;
      job.finishedAt = new Date().toISOString();
      console.log(`[backfill] finished: ${job.sent.length} sent, ${job.failed.length} failed`);
    }
  })();

  return { started: true, ...jobSnapshot() };
}

module.exports = { buildPlan, candidates, start, jobSnapshot, INCLUDED_SEATS, TTL_DAYS };
