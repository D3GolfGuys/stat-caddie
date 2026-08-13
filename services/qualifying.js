/**
 * Qualifying service
 * ------------------
 * Runs intra-squad qualifying as a scored, fair competition. An "event" groups
 * a set of counting rounds for a team; players log those rounds through the
 * normal capture flow (tagged context='qualifying' + qualifying_event_id), and
 * this service produces a normalized-to-par leaderboard.
 *
 * v1.0 scope: cumulative / average to-par, best-N / drop-worst, enrollment.
 * Intentionally NOT here (see design spec): exemptions, coach picks, cut line,
 * lineup selection. Rating/slope normalization + the practice-vs-tournament
 * delta land in v1.1. Pure standings math lives in ./qualifyingMath.
 */
const { pool } = require('../db');
const { computeStandings, normalizeConfig } = require('./qualifyingMath');

async function createEvent(db, { teamId, name, startsOn = null, endsOn = null, config = {} }) {
  const norm = normalizeConfig(config);
  const { rows } = await db.query(
    `INSERT INTO qualifying_events (team_id, name, starts_on, ends_on, config, status)
     VALUES ($1,$2,$3,$4,$5,'open') RETURNING *`,
    [teamId, name, startsOn, endsOn, JSON.stringify(norm)]);
  return rows[0];
}

async function listEvents(db, teamId) {
  const { rows } = await db.query(
    `SELECT e.*,
        (SELECT COUNT(*) FROM qualifying_enrollment en WHERE en.event_id=e.id AND en.status='active') AS participants,
        (SELECT COUNT(*) FROM rounds r WHERE r.qualifying_event_id=e.id) AS rounds_logged
       FROM qualifying_events e
      WHERE e.team_id=$1
      ORDER BY e.created_at DESC`, [teamId]);
  return rows;
}

async function getEvent(db, id) {
  const { rows } = await db.query(`SELECT * FROM qualifying_events WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function setStatus(db, id, status) {
  const { rows } = await db.query(
    `UPDATE qualifying_events SET status=$2 WHERE id=$1 RETURNING *`, [id, status]);
  return rows[0] || null;
}

async function enroll(db, eventId, userId) {
  await db.query(
    `INSERT INTO qualifying_enrollment (event_id, user_id, status) VALUES ($1,$2,'active')
     ON CONFLICT (event_id, user_id) DO UPDATE SET status='active'`, [eventId, userId]);
}

async function withdraw(db, eventId, userId) {
  await db.query(
    `UPDATE qualifying_enrollment SET status='withdrawn' WHERE event_id=$1 AND user_id=$2`, [eventId, userId]);
}

async function listOpenForTeam(db, teamId) {
  const { rows } = await db.query(
    `SELECT id, name, starts_on, ends_on FROM qualifying_events
      WHERE team_id=$1 AND status='open' ORDER BY created_at DESC`, [teamId]);
  return rows;
}

// Full standings for an event: enrolled players (plus anyone who logged a round),
// each round's to-par computed from its scored holes (authoritative, not summary).
async function standings(db, eventId) {
  const event = await getEvent(db, eventId);
  if (!event) return null;

  const { rows: roundRows } = await db.query(
    `SELECT r.user_id, u.name,
            SUM(rh.score) - SUM(rh.par) AS to_par,
            COUNT(rh.score) AS holes_scored, r.id AS round_id, r.round_date
       FROM rounds r
       JOIN users u ON u.id = r.user_id
       JOIN round_holes rh ON rh.round_id = r.id AND rh.score IS NOT NULL
      WHERE r.qualifying_event_id = $1
      GROUP BY r.id, r.user_id, u.name, r.round_date
      ORDER BY r.round_date NULLS LAST, r.id`, [eventId]);

  const { rows: enrolled } = await db.query(
    `SELECT en.user_id, u.name FROM qualifying_enrollment en
       JOIN users u ON u.id = en.user_id
      WHERE en.event_id=$1 AND en.status='active'`, [eventId]);

  const byUser = new Map();
  for (const e of enrolled) byUser.set(e.user_id, { userId: e.user_id, name: e.name, toPars: [] });
  for (const r of roundRows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { userId: r.user_id, name: r.name, toPars: [] });
    byUser.get(r.user_id).toPars.push(Number(r.to_par));
  }
  return { event, standings: computeStandings([...byUser.values()], event.config) };
}

module.exports = {
  computeStandings, normalizeConfig, // re-exported for convenience
  createEvent, listEvents, getEvent, setStatus, enroll, withdraw, listOpenForTeam, standings,
};
