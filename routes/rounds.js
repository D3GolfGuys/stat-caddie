const router = require('express').Router();
const { pool } = require('../db');
const reconcile = require('../services/reconcile');
const requireAuth = require('../middleware/requireAuth');
const requireSubscription = require('../middleware/requireSubscription');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'mdeckert24@gmail.com').toLowerCase();

router.use(requireAuth, requireSubscription);

// GET /api/rounds  — list rounds (now includes reconciliation status).
// Normally scoped to the signed-in user. The platform owner can pass ?all=1
// to pull every player's rounds (Beta: lets the founder view all reports).
router.get('/', async (req, res) => {
  const { limit = 50, offset = 0, status, all } = req.query;
  const isAdmin = (req.user.email || '').toLowerCase() === ADMIN_EMAIL;
  const viewAll = isAdmin && (all === '1' || all === 'true');

  const params = [];
  const where = [];
  if (!viewAll) { params.push(req.user.id); where.push(`r.user_id=$${params.length}`); }
  if (status)   { params.push(status);      where.push(`r.status=$${params.length}`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT r.id,
            COALESCE(NULLIF(r.player_name, ''), u.name) AS player_name,
            r.tournament, r.round_num, r.round_date, r.course_name,
            r.status, r.has_official, r.has_stats, r.official_score, r.official_to_par,
            r.official_finish, r.entered_score, r.summary, r.created_at
       FROM rounds r
       JOIN users u ON u.id = r.user_id
       ${whereSql}
      ORDER BY r.round_date DESC NULLS LAST, r.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json(rows);
});

// GET /api/rounds/needs-stats  — Scoreboard rounds awaiting a stat breakdown.
// This is the "Scenario B" worklist: score is locked, player just adds stats.
router.get('/needs-stats', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, tournament, round_num, round_date, course_name, official_score, official_to_par
       FROM rounds
      WHERE user_id=$1 AND status='score_only'
      ORDER BY round_date DESC NULLS LAST, created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// GET /api/rounds/conflicts  — rounds where entered total != official total.
router.get('/conflicts', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.tournament, r.round_num, r.entered_score, r.official_score,
            r.official_to_par,
            (SELECT detail FROM reconciliation_log l
              WHERE l.round_id=r.id AND l.kind='score_conflict'
              ORDER BY l.created_at DESC LIMIT 1) AS detail
       FROM rounds r
      WHERE r.user_id=$1 AND r.status='conflict'
      ORDER BY r.round_date DESC NULLS LAST, r.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// GET /api/rounds/:id  — single round with holes
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM rounds WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Round not found' });
  const round = rows[0];
  const { rows: holes } = await pool.query('SELECT * FROM round_holes WHERE round_id=$1 ORDER BY hole_num', [round.id]);
  res.json({ ...round, holes });
});

// POST /api/rounds  — create/merge a round from manual entry (STAT layer).
// Idempotent on the match key, so re-submitting the same event updates rather
// than duplicates, and it merges cleanly onto any official score already present.
router.post('/', async (req, res) => {
  const {
    playerName, tournament, roundNum = 1, roundDate, courseName, rating, slope,
    conditions, weather, roundNotes, holeData, summary,
    clippdTournamentId, clippdRoundId, clippdPlayerId, // set when the event was picked from the synced catalog
  } = req.body;

  try {
    const { roundId, status } = await reconcile.reconcileManual({
      userId: req.user.id,
      teamId: req.user.team_id || null,
      identity: { clippdTournamentId, clippdRoundId, clippdPlayerId, tournament, roundNum, roundDate, courseName },
      header: { playerName, rating, slope, conditions, weather, roundNotes },
      holeData,
    });
    // Persist the client-computed stat summary so the dashboard/reports can read
    // aggregate stats straight from the account (GET /api/rounds returns it).
    if (summary && typeof summary === 'object') {
      await pool.query('UPDATE rounds SET summary=$1 WHERE id=$2 AND user_id=$3',
        [JSON.stringify(summary), roundId, req.user.id]);
    }
    res.status(201).json({ id: roundId, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save round' });
  }
});

// POST /api/rounds/:id/stats  — add the stat breakdown to an existing round
// (typically a score_only round from the needs-stats worklist). Score stays
// owned by Scoreboard; only stat fields are written.
router.post('/:id/stats', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, tournament, round_num, round_date, course_name, clippd_tournament_id, clippd_round_id, clippd_player_id FROM rounds WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Round not found' });
  const r = rows[0];
  try {
    const out = await reconcile.reconcileManual({
      userId: req.user.id,
      teamId: req.user.team_id || null,
      identity: {
        clippdTournamentId: r.clippd_tournament_id, clippdRoundId: r.clippd_round_id,
        clippdPlayerId: r.clippd_player_id, tournament: r.tournament,
        roundNum: r.round_num, roundDate: r.round_date, courseName: r.course_name,
      },
      header: {},
      holeData: req.body.holeData,
    });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add stats' });
  }
});

// POST /api/rounds/:id/resolve  — resolve a score conflict by choosing the
// authoritative total. 'official' keeps Scoreboard's score (stats stay);
// 'entered' trusts the player's hole entry (overrides official_score).
router.post('/:id/resolve', async (req, res) => {
  const { choice } = req.body; // 'official' | 'entered'
  const { rows } = await pool.query('SELECT * FROM rounds WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Round not found' });
  if (rows[0].status !== 'conflict') return res.status(409).json({ error: 'Round is not in conflict' });

  try {
    await reconcile.withTx(async (client) => {
      if (choice === 'entered') {
        // Trust manual hole scores: set official_score to the entered total.
        await client.query("UPDATE rounds SET official_score=entered_score, official_to_par=NULL, resolution='entered' WHERE id=$1", [rows[0].id]);
      } else {
        // Keep Scoreboard's official total; mark adjudicated so recompute won't re-flag.
        await client.query("UPDATE rounds SET resolution='official' WHERE id=$1", [rows[0].id]);
      }
      await client.query(
        `UPDATE reconciliation_log SET resolved_at=NOW()
          WHERE round_id=$1 AND kind='score_conflict' AND resolved_at IS NULL`,
        [rows[0].id]
      );
      await reconcile.recomputeStatus(client, rows[0].id);
    });
    const { rows: after } = await pool.query('SELECT status FROM rounds WHERE id=$1', [rows[0].id]);
    res.json({ id: rows[0].id, status: after[0].status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve conflict' });
  }
});

// DELETE /api/rounds/:id
router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM rounds WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!rowCount) return res.status(404).json({ error: 'Round not found' });
  res.json({ ok: true });
});

module.exports = router;
