const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');
const { requireTeamAdmin } = require('../middleware/requireSubscription');
const { findOrCreateSchool } = require('../services/schools');

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
  res.json({ team: teamRows[0], members });
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

  // Check member limit
  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*) FROM users WHERE team_id=$1', [req.user.team_id]
  );
  const { rows: teamRows } = await pool.query('SELECT max_members FROM teams WHERE id=$1', [req.user.team_id]);
  if (parseInt(countRows[0].count) >= (teamRows[0]?.max_members || 15)) {
    return res.status(400).json({ error: 'Team member limit reached (15 max)' });
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
  res.json({ ok: true, inviteUrl, note: 'Share this link with the player to join your team.' });
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

module.exports = router;
