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

// GET /api/rankings/leaderboard?metric=&segment_type=&segment_value=&limit=
router.get('/leaderboard', async (req, res) => {
  try {
    const rows = await rankings.getLeaderboard(pool, {
      metricKey: req.query.metric,
      segmentType: req.query.segment_type || 'national',
      segmentValue: req.query.segment_value || 'ALL',
      limit: req.query.limit,
    });
    res.json({ leaderboard: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load leaderboard' }); }
});

module.exports = router;
