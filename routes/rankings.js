const router = require('express').Router();
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');
const rankings = require('../services/rankings');

// GET /api/rankings/me — logged-in player's percentiles across segments.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const seasonId = await rankings.getCurrentSeasonId(pool);
    if (!seasonId) return res.json({ season: null, rankings: [] });
    const rows = await rankings.getPlayerRankings(pool, req.user.id, seasonId);
    res.json({ season: seasonId, rankings: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load rankings' }); }
});

// GET /api/rankings/metrics — rankable metrics for the leaderboard picker.
router.get('/metrics', async (req, res) => {
  try { res.json({ metrics: await rankings.listMetrics(pool) }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load metrics' }); }
});

// GET /api/rankings/leaderboard?metric=&segment_type=&segment_value=&limit=&scope=player|team
router.get('/leaderboard', async (req, res) => {
  try {
    const opts = {
      metricKey: req.query.metric,
      segmentType: req.query.segment_type || 'national',
      segmentValue: req.query.segment_value || 'ALL',
      gender: req.query.gender || 'M',
      limit: req.query.limit,
    };
    const isTeam = req.query.scope === 'team';
    const rows = isTeam ? await rankings.getTeamLeaderboard(pool, opts) : await rankings.getLeaderboard(pool, opts);
    res.json({ scope: isTeam ? 'team' : 'player', leaderboard: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load leaderboard' }); }
});

// GET /api/rankings/team/me — the logged-in coach's team percentiles.
router.get('/team/me', requireAuth, async (req, res) => {
  try {
    if (!req.user.team_id) return res.json({ season: null, rankings: [] });
    const seasonId = await rankings.getCurrentSeasonId(pool);
    if (!seasonId) return res.json({ season: null, rankings: [] });
    res.json({ season: seasonId, rankings: await rankings.getTeamRankings(pool, req.user.team_id, seasonId) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load team rankings' }); }
});

module.exports = router;
