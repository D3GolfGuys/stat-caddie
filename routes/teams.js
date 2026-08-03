const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');
const { requireTeamAdmin } = require('../middleware/requireSubscription');
const { findOrCreateSchool } = require('../services/schools');

// Pricing / seat model (Option B — per-seat overflow).
// 15 player seats are included in the Team plan; each additional player is
// billed at $2/mo. Billing is reconciled manually during beta — adding seats
// simply raises the team's cap so the coach can keep inviting. The coach
// (team_admin) does NOT consume a player seat.
const INCLUDED_SEATS = 15;
const PRICE_PER_SEAT = 2;

// Seats consumed = active players + still-valid pending invitations.
async function seatUsage(teamId) {
  const [{ rows: t }, { rows: p }, { rows: inv }] = await Promise.all([
    pool.query('SELECT max_members FROM teams WHERE id=$1', [teamId]),
    pool.query("SELECT COUNT(*) FROM users WHERE team_id=$1 AND role='team_member'", [teamId]),
    pool.query('SELECT COUNT(*) FROM invitations WHERE team_id=$1 AND used_at IS NULL AND expires_at > NOW()', [teamId]),
  ]);
  const cap = t[0]?.max_members || INCLUDED_SEATS;
  const players = parseInt(p[0].count, 10);
  const pending = parseInt(inv[0].count, 10);
  const used = players + pending;
  const extra = Math.max(0, cap - INCLUDED_SEATS);
  return {
    cap, players, pending, used,
    remaining: Math.max(0, cap - used),
    included: INCLUDED_SEATS,
    extra_seats: extra,
    price_per_seat: PRICE_PER_SEAT,
    monthly_addon: extra * PRICE_PER_SEAT,
  };
}

router.use(requireAuth);

// GET /api/teams/me  — get current user's team info + members
router.get('/me', async (req, res) => {
  if (!req.user.team_id) return res.json({ team: null, members: [] });
  const { rows: teamRows } = await pool.query('SELECT * FROM teams WHERE id=$1', [req.user.team_id]);
  if (!teamRows.length) return res.json({ team: null, members: [] });
  const { rows: members } = await pool.query(
    'SELECT id, name, email, role, created_at FROM users WHERE team_id=$1 ORDER BY role DESC, name',
    [req.user.team_id]
  );
  const seats = await seatUsage(req.user.team_id);
  res.json({ team: teamRows[0], members, seats });
});

// PUT /api/teams/me  — update team name + ranking segment (admin only)
router.put('/me', requireTeamAdmin, async (req, res) => {
  const { name, division, conference, schoolName, gender } = req.body;
  const sets = [], params = []; let i = 1;
  if (name != null && String(name).trim()) { sets.push(`name=$${i++}`); params.push(String(name).trim()); }
  if (division !== undefined)   { sets.push(`division=$${i++}`);   params.push(division || null); }
  if (conference !== undefined) { sets.push(`conference=$${i++}`); params.push(conference || null); }
  if (gender !== undefined)     { sets.push(`gender=$${i++}`);     params.push(gender || null); }
  if (schoolName !== undefined) {
    const schoolId = await findOrCreateSchool(pool, { name: schoolName, division, conference });
    sets.push(`school_id=$${i++}`);   params.push(schoolId);
    sets.push(`school_name=$${i++}`); params.push(schoolName || null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.user.team_id);
  await pool.query(`UPDATE teams SET ${sets.join(', ')} WHERE id=$${i}`, params);
  res.json({ ok: true });
});

// POST /api/teams/invite  — invite a player by email (admin only)
router.post('/invite', requireTeamAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // Seat check — players + pending invites must stay within the team's cap.
  const seats = await seatUsage(req.user.team_id);
  if (seats.remaining < 1) {
    return res.status(403).json({
      code: 'SEATS_REQUIRED',
      error: `You've used all ${seats.cap} player seats. Add seats at $${PRICE_PER_SEAT}/player/mo to invite more players.`,
      seats,
    });
  }

  // Check if already a member
  const { rows: existing } = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
  if (existing.length) {
    return res.status(409).json({ error: 'A user with this email already exists' });
  }

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await pool.query(
    'INSERT INTO invitations (team_id, email, token, expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO NOTHING',
    [req.user.team_id, email.toLowerCase(), token, expiresAt]
  );

  const inviteUrl = `${process.env.APP_URL}/accept-invite.html?token=${token}`;
  // In production, send this via email. For now, return it in the response.
  const seatsAfter = await seatUsage(req.user.team_id); // recount incl. this pending invite
  res.json({ ok: true, inviteUrl, seats: seatsAfter, note: 'Share this link with the player to join your team.' });
});

// POST /api/teams/seats  — add player seats beyond the included 15 (admin only)
// Beta: raises the team's cap immediately; the $2/player/mo overflow is billed
// manually. `addSeats` is how many extra seats to purchase.
router.post('/seats', requireTeamAdmin, async (req, res) => {
  let addSeats = parseInt(req.body.addSeats, 10);
  if (!Number.isFinite(addSeats) || addSeats < 1) {
    return res.status(400).json({ error: 'Enter how many seats to add (1 or more).' });
  }
  addSeats = Math.min(addSeats, 200); // sane upper bound
  const { rows } = await pool.query(
    'UPDATE teams SET max_members = COALESCE(max_members, $1) + $2 WHERE id=$3 RETURNING max_members',
    [INCLUDED_SEATS, addSeats, req.user.team_id]
  );
  const seats = await seatUsage(req.user.team_id);
  console.log(`[seats] team ${req.user.team_id} added ${addSeats} seat(s) → cap ${rows[0].max_members} (+$${seats.monthly_addon}/mo)`);
  res.json({ ok: true, added: addSeats, seats });
});

// GET /api/teams/invitations  — list pending invites (admin only)
router.get('/invitations', requireTeamAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, expires_at, used_at, created_at FROM invitations WHERE team_id=$1 ORDER BY created_at DESC',
    [req.user.team_id]
  );
  res.json(rows);
});

// DELETE /api/teams/invitations/:id  — cancel an invitation
router.delete('/invitations/:id', requireTeamAdmin, async (req, res) => {
  await pool.query('DELETE FROM invitations WHERE id=$1 AND team_id=$2', [req.params.id, req.user.team_id]);
  res.json({ ok: true });
});

// DELETE /api/teams/members/:userId  — remove a team member (admin only)
router.delete('/members/:userId', requireTeamAdmin, async (req, res) => {
  const { rowCount } = await pool.query(
    'UPDATE users SET team_id=NULL, role=\'individual\', subscription_status=\'inactive\' WHERE id=$1 AND team_id=$2 AND role=\'team_member\'',
    [req.params.userId, req.user.team_id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Member not found' });
  res.json({ ok: true });
});

// GET /api/teams/rounds  — all rounds for the team (admin only)
router.get('/rounds', requireTeamAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, u.id AS user_id, r.player_name, u.name as user_name, r.tournament, r.round_num, r.round_date, r.course_name, r.summary, r.created_at
     FROM rounds r JOIN users u ON u.id = r.user_id
     WHERE u.team_id=$1 ORDER BY r.round_date DESC NULLS LAST, r.created_at DESC LIMIT 500`,
    [req.user.team_id]
  );
  res.json(rows);
});


// ── Course history (coach): performance over time + hole difficulty ──────────
// GET /api/teams/courses — courses the team has played, with counts.
router.get('/courses', requireTeamAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.course_name AS course, COUNT(DISTINCT r.id)::int AS rounds,
              COUNT(DISTINCT r.tournament)::int AS events,
              to_char(MIN(r.round_date),'YYYY-MM-DD') AS first_played,
              to_char(MAX(r.round_date),'YYYY-MM-DD') AS last_played
         FROM rounds r JOIN users u ON u.id = r.user_id
        WHERE u.team_id = $1 AND u.role <> 'team_admin'
          AND r.course_name IS NOT NULL AND r.course_name <> ''
        GROUP BY r.course_name ORDER BY rounds DESC, r.course_name`, [req.user.team_id]);
    res.json({ courses: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load courses' }); }
});

// GET /api/teams/course-holes?course= — per-hole difficulty across all team rounds there.
router.get('/course-holes', requireTeamAdmin, async (req, res) => {
  const course = req.query.course;
  if (!course) return res.status(400).json({ error: 'course required' });
  try {
    const { rows } = await pool.query(
      `SELECT rh.hole_num, MAX(rh.par) AS par,
              COUNT(rh.score)::int AS plays,
              ROUND(AVG(rh.score)::numeric, 2) AS avg_score,
              ROUND(AVG(rh.score - rh.par)::numeric, 2) AS avg_vs_par,
              SUM(CASE WHEN rh.score - rh.par <= -1 THEN 1 ELSE 0 END)::int AS birdies,
              SUM(CASE WHEN rh.score - rh.par = 0  THEN 1 ELSE 0 END)::int AS pars,
              SUM(CASE WHEN rh.score - rh.par = 1  THEN 1 ELSE 0 END)::int AS bogeys,
              SUM(CASE WHEN rh.score - rh.par >= 2 THEN 1 ELSE 0 END)::int AS doubles_plus
         FROM round_holes rh
         JOIN rounds r ON r.id = rh.round_id
         JOIN users u ON u.id = r.user_id
        WHERE u.team_id = $1 AND u.role <> 'team_admin' AND r.course_name = $2 AND rh.score IS NOT NULL
        GROUP BY rh.hole_num ORDER BY rh.hole_num`, [req.user.team_id, course]);
    res.json({ course, holes: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load hole history' }); }
});

// GET /api/teams/course-timeline?course= — team scoring per visit over time.
router.get('/course-timeline', requireTeamAdmin, async (req, res) => {
  const course = req.query.course;
  if (!course) return res.status(400).json({ error: 'course required' });
  try {
    const { rows } = await pool.query(
      `SELECT to_char(r.round_date,'YYYY-MM-DD') AS date, r.tournament,
              COUNT(r.id)::int AS rounds,
              ROUND(AVG((r.summary->>'totalScore')::numeric), 1) AS avg_score,
              ROUND(AVG((r.summary->>'vspar')::numeric), 1) AS avg_vs_par
         FROM rounds r JOIN users u ON u.id = r.user_id
        WHERE u.team_id = $1 AND u.role <> 'team_admin' AND r.course_name = $2
          AND r.summary IS NOT NULL AND r.summary ? 'totalScore'
        GROUP BY r.round_date, r.tournament ORDER BY r.round_date, r.tournament`, [req.user.team_id, course]);
    res.json({ course, visits: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load course timeline' }); }
});


// ── Team scoring & performance history (coach only) ──────────────────────────
// Count the 4 LOWEST player scores each round; the rest are "dropped". This one
// rule covers both 5-play/4-count and 6-play/4-count events (the extra players
// just add to the drop). Returns a span summary plus a per-event history with
// round-by-round detail. span=year (default) = current season; career = all-time.
function seasonStartDate() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const startYear = m >= 8 ? y : y - 1;
  return `${startYear}-08-01`;
}
const TEAM_COUNT = 4; // scores that count toward the team total each round

router.get('/team-scores', requireTeamAdmin, async (req, res) => {
  try {
    const span = req.query.span === 'career' ? 'career' : 'year';
    const params = [req.user.team_id];
    let dateClause = '';
    if (span === 'year') { params.push(seasonStartDate()); dateClause = 'AND r.round_date >= $2'; }
    const { rows } = await pool.query(
      `SELECT r.tournament, r.round_num,
              to_char(r.round_date, 'YYYY-MM-DD') AS round_date,
              r.course_name, r.player_name, u.id AS uid,
              (r.summary->>'totalScore')::numeric AS score,
              (r.summary->>'vspar')::numeric      AS vspar
         FROM rounds r JOIN users u ON u.id = r.user_id
        WHERE u.team_id = $1 AND u.role <> 'team_admin'
          AND r.summary ? 'totalScore' AND (r.summary->>'totalScore') <> '' ${dateClause}
        ORDER BY r.round_date, r.tournament, r.round_num, score ASC, r.player_name`,
      params);

    // group player rows -> team-rounds (one per tournament+round within a season)
    const roundMap = new Map();
    for (const row of rows) {
      if (row.score == null) continue;
      const [yy, mm] = String(row.round_date).split('-').map(Number);
      const ay = mm >= 8 ? yy : yy - 1;                    // academic year of this round
      const evKey = `${row.tournament || '—'}__${ay}`; // separate yearly recurrences
      const rKey  = `${evKey}__R${row.round_num}__${row.round_date}`;
      if (!roundMap.has(rKey)) roundMap.set(rKey, { evKey, tournament: row.tournament, course: row.course_name, round_num: row.round_num, date: row.round_date, ay, players: [] });
      roundMap.get(rKey).players.push({ name: row.player_name, score: Number(row.score), vspar: row.vspar == null ? null : Number(row.vspar) });
    }

    // per team-round: 4 lowest count, the rest are dropped
    const teamRounds = [];
    for (const r of roundMap.values()) {
      const sorted = r.players.slice().sort((a, b) => a.score - b.score || String(a.name).localeCompare(String(b.name)));
      const counters = sorted.slice(0, TEAM_COUNT);
      const dropped  = sorted.slice(TEAM_COUNT);
      const teamScore = counters.reduce((s, p) => s + p.score, 0);
      const teamToPar = counters.length && counters.every(p => p.vspar != null) ? counters.reduce((s, p) => s + p.vspar, 0) : null;
      teamRounds.push({ evKey: r.evKey, tournament: r.tournament, course: r.course, round_num: r.round_num, date: r.date, ay: r.ay, counters, dropped, teamScore, teamToPar });
    }
    teamRounds.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.round_num - b.round_num);

    // group team-rounds -> events (tournaments)
    const evMap = new Map();
    for (const tr of teamRounds) {
      if (!evMap.has(tr.evKey)) evMap.set(tr.evKey, { tournament: tr.tournament, course: tr.course, rounds: [] });
      evMap.get(tr.evKey).rounds.push(tr);
    }
    const events = [];
    for (const ev of evMap.values()) {
      const teamTotal = ev.rounds.reduce((s, r) => s + r.teamScore, 0);
      const toPar = ev.rounds.every(r => r.teamToPar != null) ? ev.rounds.reduce((s, r) => s + r.teamToPar, 0) : null;
      const drops = ev.rounds.flatMap(r => r.dropped.map(p => p.score));
      const avgDropped = drops.length ? +(drops.reduce((s, v) => s + v, 0) / drops.length).toFixed(1) : null;
      events.push({
        tournament: ev.tournament, course: ev.course,
        firstDate: ev.rounds[0].date, lastDate: ev.rounds[ev.rounds.length - 1].date,
        roundCount: ev.rounds.length, teamTotal, teamToPar: toPar, avgDropped,
        rounds: ev.rounds.map(r => ({
          round_num: r.round_num, date: r.date, teamScore: r.teamScore, teamToPar: r.teamToPar,
          counters: r.counters.map(p => ({ name: p.name, score: p.score, vspar: p.vspar })),
          dropped:  r.dropped.map(p => ({ name: p.name, score: p.score, vspar: p.vspar })),
        })),
      });
    }
    events.sort((a, b) => String(b.firstDate).localeCompare(String(a.firstDate))); // newest first

    // span summary
    const scoreVals = teamRounds.map(r => r.teamScore);
    const allDrops  = teamRounds.flatMap(r => r.dropped.map(p => p.score));
    const summary = {
      events: events.length,
      rounds: teamRounds.length,
      teamScoringAvg: scoreVals.length ? +(scoreVals.reduce((s, v) => s + v, 0) / scoreVals.length).toFixed(1) : null,
      avgDropped: allDrops.length ? +(allDrops.reduce((s, v) => s + v, 0) / allDrops.length).toFixed(1) : null,
      bestTeamRound: scoreVals.length ? Math.min(...scoreVals) : null,
    };
    res.json({ ok: true, span, counting: TEAM_COUNT, summary, events });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load team scores' }); }
});

module.exports = router;
