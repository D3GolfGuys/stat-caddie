const router = require('express').Router();
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { seedDemo, seedTeam, seedLeague, clearDemo } = require('../services/demoSeed');
const rankings = require('../services/rankings');
const reconcile = require('../services/reconcile');
const { logError } = require('../services/errorLog');

// Owner-only. Every route here requires a valid session AND the admin email.
router.use(requireAuth, requireAdmin);

// GET /api/admin/stats — platform-wide activity snapshot for the founder.
router.get('/stats', async (req, res) => {
  try {
    const [overview, byDay, users] = await Promise.all([
      pool.query(`SELECT
        (SELECT COUNT(*) FROM users)                                                    AS total_users,
        (SELECT COUNT(*) FROM rounds)                                                   AS total_rounds,
        (SELECT COUNT(DISTINCT user_id) FROM rounds)                                    AS active_users,
        (SELECT COUNT(*) FROM users  WHERE created_at > NOW() - INTERVAL '7 days')       AS signups_7d,
        (SELECT COUNT(*) FROM users  WHERE created_at > NOW() - INTERVAL '30 days')      AS signups_30d,
        (SELECT COUNT(*) FROM rounds WHERE created_at > NOW() - INTERVAL '7 days')       AS rounds_7d,
        (SELECT COUNT(*) FROM rounds WHERE created_at > NOW() - INTERVAL '30 days')      AS rounds_30d,
        (SELECT COUNT(DISTINCT user_id) FROM rounds WHERE created_at > NOW() - INTERVAL '7 days')  AS active_7d,
        (SELECT COUNT(DISTINCT user_id) FROM rounds WHERE created_at > NOW() - INTERVAL '30 days') AS active_30d
      `),
      pool.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
           FROM rounds
          WHERE created_at > NOW() - INTERVAL '30 days'
          GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.subscription_status,
                to_char(u.created_at, 'YYYY-MM-DD')      AS joined,
                COUNT(r.id)::int                          AS rounds,
                to_char(MAX(r.created_at), 'YYYY-MM-DD') AS last_round
           FROM users u
           LEFT JOIN rounds r ON r.user_id = u.id
          GROUP BY u.id
          ORDER BY u.created_at DESC`
      ),
    ]);
    res.json({ overview: overview.rows[0], roundsByDay: byDay.rows, users: users.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load admin stats' });
  }
});

// POST /api/admin/seed-demo — create/refresh 2 demo players with 5 rounds each
// so the all-players report view has data to show. Idempotent.
router.post('/seed-demo', async (req, res) => {
  try {
    const result = await seedDemo(pool);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to seed demo data' });
  }
});

// POST /api/admin/seed-team — create a demo team (coach + roster w/ rounds) so
// the coach dashboard has data. Idempotent. Returns the shared demo login.
router.post('/seed-team', async (req, res) => {
  try {
    const result = await seedTeam(pool);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to seed demo team' });
  }
});

// POST /api/admin/clear-demo — remove the demo players (and their rounds).
router.post('/clear-demo', async (req, res) => {
  try {
    const result = await clearDemo(pool);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear demo data' });
  }
});

// POST /api/admin/seed-league — seed a demo league across divisions, then rank.
router.post('/seed-league', async (req, res) => {
  try {
    const seeded = await seedLeague(pool);
    const ranked = await rankings.recompute(pool, { seasonLabel: process.env.SEASON_LABEL || 'current' });
    res.json({ ok: true, seeded, ranked });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to seed league' }); }
});

// POST /api/admin/recompute-rankings — recompute stat profiles + rankings now.
router.post('/recompute-rankings', async (req, res) => {
  try {
    const summary = await rankings.recompute(pool, { seasonLabel: process.env.SEASON_LABEL || 'current' });
    res.json({ ok: true, ...summary });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to recompute rankings' }); }
});


// ───────────────────────── Admin console (Phase 1) ─────────────────────────

// GET /api/admin/alerts — everything that needs attention, grouped.
router.get('/alerts', async (req, res) => {
  try {
    const [conflicts, needStats, broken, billing, overCap, errors, counts] = await Promise.all([
      pool.query(`SELECT r.id, COALESCE(NULLIF(r.player_name,''), u.name) AS player, u.email,
               r.tournament, r.round_num, r.round_date, r.course_name, r.entered_score, r.official_score,
               (SELECT detail FROM reconciliation_log l WHERE l.round_id=r.id AND l.kind='score_conflict' ORDER BY l.created_at DESC LIMIT 1) AS detail
          FROM rounds r JOIN users u ON u.id=r.user_id
         WHERE r.status='conflict'
         ORDER BY r.round_date DESC NULLS LAST, r.created_at DESC LIMIT 100`),
      pool.query(`SELECT r.id, COALESCE(NULLIF(r.player_name,''), u.name) AS player, u.email,
               r.tournament, r.round_num, r.round_date, r.course_name, r.official_score
          FROM rounds r JOIN users u ON u.id=r.user_id
         WHERE r.status='score_only'
         ORDER BY r.round_date DESC NULLS LAST, r.created_at DESC LIMIT 100`),
      pool.query(`SELECT r.id, COALESCE(NULLIF(r.player_name,''), u.name) AS player, u.email,
               r.tournament, r.round_num, r.round_date, r.course_name, r.status
          FROM rounds r JOIN users u ON u.id=r.user_id
         WHERE r.summary IS NULL AND r.status <> 'score_only'
         ORDER BY r.created_at DESC LIMIT 100`),
      pool.query(`SELECT u.id, u.name, u.email, u.role, u.subscription_status, t.name AS team_name
          FROM users u LEFT JOIN teams t ON t.id=u.team_id
         WHERE u.role IN ('individual','team_admin') AND u.subscription_status <> 'active'
         ORDER BY u.created_at DESC LIMIT 100`),
      pool.query(`SELECT t.id, t.name, COALESCE(t.max_members,15) AS max_members,
               (SELECT COUNT(*) FROM users m WHERE m.team_id=t.id AND m.role='team_member') AS players
          FROM teams t
         WHERE (SELECT COUNT(*) FROM users m WHERE m.team_id=t.id AND m.role='team_member') > COALESCE(t.max_members,15)
         ORDER BY t.id`),
      pool.query(`SELECT id, source, message, created_at FROM error_log WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100`),
      pool.query(`SELECT
        (SELECT COUNT(*) FROM rounds WHERE status='conflict')::int AS conflicts,
        (SELECT COUNT(*) FROM rounds WHERE status='score_only')::int AS need_stats,
        (SELECT COUNT(*) FROM rounds WHERE summary IS NULL AND status <> 'score_only')::int AS broken,
        (SELECT COUNT(*) FROM users u2 LEFT JOIN teams t2 ON t2.id=u2.team_id WHERE u2.role IN ('individual','team_admin') AND u2.subscription_status <> 'active')::int AS billing,
        (SELECT COUNT(*) FROM error_log WHERE resolved_at IS NULL)::int AS errors`),
    ]);
    res.json({
      counts: counts.rows[0],
      conflicts: conflicts.rows, needStats: needStats.rows, broken: broken.rows,
      billing: billing.rows, overCap: overCap.rows, errors: errors.rows,
    });
  } catch (err) { await logError('admin/alerts', err); res.status(500).json({ error: 'Failed to load alerts' }); }
});

// GET /api/admin/rounds — all rounds, searchable/filterable.
router.get('/rounds', async (req, res) => {
  try {
    const { search = '', status = '', limit = 100, offset = 0 } = req.query;
    const params = []; const where = [];
    if (status) { params.push(status); where.push(`r.status=$${params.length}`); }
    if (search) { params.push('%' + search + '%'); const p = '$' + params.length;
      where.push(`(u.name ILIKE ${p} OR u.email ILIKE ${p} OR r.player_name ILIKE ${p} OR r.tournament ILIKE ${p} OR r.course_name ILIKE ${p})`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(Math.min(parseInt(limit) || 100, 500), parseInt(offset) || 0);
    const { rows } = await pool.query(
      `SELECT r.id, r.user_id, COALESCE(NULLIF(r.player_name,''), u.name) AS player, u.email,
              t.name AS team, r.tournament, r.round_num, r.round_date, r.course_name,
              r.status, r.entered_score, r.official_score, r.official_to_par,
              (r.summary IS NOT NULL) AS has_summary, r.created_at
         FROM rounds r JOIN users u ON u.id=r.user_id
         LEFT JOIN teams t ON t.id=r.team_id
         ${whereSql}
        ORDER BY r.round_date DESC NULLS LAST, r.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json(rows);
  } catch (err) { await logError('admin/rounds:list', err); res.status(500).json({ error: 'Failed to load rounds' }); }
});

// GET /api/admin/rounds/:id — full round + holes (any owner).
router.get('/rounds/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, COALESCE(NULLIF(r.player_name,''), u.name) AS player, u.email
         FROM rounds r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Round not found' });
    const { rows: holes } = await pool.query('SELECT * FROM round_holes WHERE round_id=$1 ORDER BY hole_num', [req.params.id]);
    res.json({ ...rows[0], holes });
  } catch (err) { await logError('admin/rounds:get', err); res.status(500).json({ error: 'Failed to load round' }); }
});

// PUT /api/admin/rounds/:id — targeted edit of a round's header fields.
router.put('/rounds/:id', async (req, res) => {
  try {
    const allowed = ['player_name','tournament','round_num','round_date','course_name','rating','slope','official_score','entered_score','status'];
    const sets = [], params = []; let i = 1;
    for (const k of allowed) if (k in req.body) { sets.push(`${k}=$${i++}`); params.push(req.body[k] === '' ? null : req.body[k]); }
    if (!sets.length) return res.status(400).json({ error: 'No editable fields provided' });
    params.push(req.params.id);
    const { rowCount } = await pool.query(`UPDATE rounds SET ${sets.join(', ')} WHERE id=$${i}`, params);
    if (!rowCount) return res.status(404).json({ error: 'Round not found' });
    res.json({ ok: true });
  } catch (err) { await logError('admin/rounds:edit', err); res.status(500).json({ error: 'Failed to update round' }); }
});

// DELETE /api/admin/rounds/:id — delete any round.
router.delete('/rounds/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM rounds WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Round not found' });
    res.json({ ok: true });
  } catch (err) { await logError('admin/rounds:delete', err); res.status(500).json({ error: 'Failed to delete round' }); }
});

// POST /api/admin/rounds/:id/resolve — resolve a score conflict (official|entered).
router.post('/rounds/:id/resolve', async (req, res) => {
  try {
    const { choice } = req.body;
    const { rows } = await pool.query('SELECT id FROM rounds WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Round not found' });
    await reconcile.withTx(async (client) => {
      if (choice === 'entered') {
        await client.query("UPDATE rounds SET official_score=entered_score, official_to_par=NULL, resolution='entered' WHERE id=$1", [req.params.id]);
      } else {
        await client.query("UPDATE rounds SET resolution='official' WHERE id=$1", [req.params.id]);
      }
      await client.query("UPDATE reconciliation_log SET resolved_at=NOW() WHERE round_id=$1 AND kind='score_conflict' AND resolved_at IS NULL", [req.params.id]);
      await reconcile.recomputeStatus(client, req.params.id);
    });
    const { rows: after } = await pool.query('SELECT status FROM rounds WHERE id=$1', [req.params.id]);
    res.json({ ok: true, status: after[0] && after[0].status });
  } catch (err) { await logError('admin/rounds:resolve', err); res.status(500).json({ error: 'Failed to resolve conflict' }); }
});

// POST /api/admin/errors/:id/resolve — dismiss an app-error alert.
router.post('/errors/:id/resolve', async (req, res) => {
  try {
    await pool.query('UPDATE error_log SET resolved_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { await logError('admin/errors:resolve', err); res.status(500).json({ error: 'Failed to dismiss' }); }
});

// GET /api/admin/teams — all teams with roster/round counts.
router.get('/teams', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.division, t.conference, t.gender, t.subscription_status, COALESCE(t.max_members,15) AS max_members,
              a.name AS coach, a.email AS coach_email,
              (SELECT COUNT(*) FROM users m WHERE m.team_id=t.id AND m.role='team_member')::int AS players,
              (SELECT COUNT(*) FROM rounds rr JOIN users mu ON mu.id=rr.user_id WHERE mu.team_id=t.id AND mu.role='team_member')::int AS rounds
         FROM teams t LEFT JOIN users a ON a.id=t.admin_user_id
        ORDER BY t.name`);
    res.json(rows);
  } catch (err) { await logError('admin/teams:list', err); res.status(500).json({ error: 'Failed to load teams' }); }
});

// GET /api/admin/teams/:id — team + members + player rounds (for the view-as-coach page).
router.get('/teams/:id', async (req, res) => {
  try {
    const { rows: t } = await pool.query('SELECT * FROM teams WHERE id=$1', [req.params.id]);
    if (!t.length) return res.status(404).json({ error: 'Team not found' });
    const { rows: members } = await pool.query('SELECT id, name, email, role FROM users WHERE team_id=$1 ORDER BY role DESC, name', [req.params.id]);
    const { rows: rounds } = await pool.query(
      `SELECT r.id, r.user_id, r.tournament, r.round_num, r.round_date, r.course_name, r.status, r.summary
         FROM rounds r JOIN users u ON u.id=r.user_id
        WHERE u.team_id=$1 AND u.role='team_member'
        ORDER BY r.round_date DESC NULLS LAST, r.created_at DESC LIMIT 500`, [req.params.id]);
    res.json({ team: t[0], members, rounds });
  } catch (err) { await logError('admin/teams:get', err); res.status(500).json({ error: 'Failed to load team' }); }
});



// PUT /api/admin/rounds/:id/holes — full hole-by-hole edit; upserts holes then
// recomputes entered_score/status (reconcile) and writes the recomputed summary.
router.put('/rounds/:id/holes', async (req, res) => {
  try {
    const id = req.params.id;
    const holes = Array.isArray(req.body.holes) ? req.body.holes : [];
    const summary = (req.body.summary && typeof req.body.summary === 'object') ? req.body.summary : null;
    const { rows: chk } = await pool.query('SELECT id FROM rounds WHERE id=$1', [id]);
    if (!chk.length) return res.status(404).json({ error: 'Round not found' });
    const iv = v => (v === '' || v == null || isNaN(parseInt(v))) ? null : parseInt(v);
    const fv = v => (v === '' || v == null || isNaN(parseFloat(v))) ? null : parseFloat(v);
    const bv = v => v === true || v === 'Y' || v === 'true';
    const sv = v => (v === '' || v == null) ? null : String(v).slice(0, 10);
    await reconcile.withTx(async (client) => {
      for (const h of holes) {
        const hn = parseInt(h.hole_num);
        if (!hn || hn < 1 || hn > 36) continue;
        await client.query(
          `INSERT INTO round_holes
             (round_id, hole_num, par, hcp, score, fw, gir, miss_dir, drive_dist, prox, putts, first_putt, three_putt, ud_att, ud_made, ss_att, ss_made, pen_strokes, notes, yardage, score_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'manual')
           ON CONFLICT (round_id, hole_num) DO UPDATE SET
             par=$3, hcp=$4, score=$5, fw=$6, gir=$7, miss_dir=$8, drive_dist=$9, prox=$10,
             putts=$11, first_putt=$12, three_putt=$13, ud_att=$14, ud_made=$15, ss_att=$16,
             ss_made=$17, pen_strokes=$18, notes=$19, yardage=$20, score_source='manual'`,
          [id, hn, iv(h.par) || 4, iv(h.hcp), iv(h.score), sv(h.fw), sv(h.gir), sv(h.miss_dir),
           iv(h.drive_dist), fv(h.prox), iv(h.putts), fv(h.first_putt), bv(h.three_putt),
           bv(h.ud_att), bv(h.ud_made), bv(h.ss_att), bv(h.ss_made), iv(h.pen_strokes) || 0, h.notes || null, iv(h.yardage)]
        );
      }
      if (summary) await client.query('UPDATE rounds SET summary=$1 WHERE id=$2', [JSON.stringify(summary), id]);
      await reconcile.recomputeStatus(client, id);
    });
    const { rows: after } = await pool.query('SELECT status, entered_score FROM rounds WHERE id=$1', [id]);
    res.json({ ok: true, status: after[0] && after[0].status, entered_score: after[0] && after[0].entered_score });
  } catch (err) { await logError('admin/rounds:holes', err); res.status(500).json({ error: 'Failed to save holes' }); }
});

module.exports = router;
