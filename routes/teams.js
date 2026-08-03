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

module.exports = router;
