const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const scoreboard = require('../services/scoreboard');

router.use(requireAuth);

// Small in-process cache so the capture picker doesn't hammer Clippd on every
// keystroke. Catalog changes slowly; 10 min is plenty.
let cache = { at: 0, data: null };
const TTL_MS = 10 * 60 * 1000;

// Normalize a Clippd tournament object to the few fields the picker needs.
// Field names per BACKLOG.md (tournamentId, tournamentName, …); fall back across
// likely aliases so a shape change degrades instead of breaking.
function normalize(t) {
  return {
    id:        t.tournamentId   ?? t.id        ?? null,
    name:      t.tournamentName ?? t.name      ?? 'Untitled event',
    gender:    t.gender         ?? null,
    division:  t.division       ?? null,
    startDate: t.startDate      ?? null,
    endDate:   t.endDate        ?? null,
    course:    t.course         ?? t.venue     ?? null,
    venue:     t.venue          ?? null,
    city:      t.city           ?? null,
    state:     t.state          ?? null,
    season:    t.season         ?? null,
    numRounds: t.numRounds      ?? null,
    hasResults: t.hasResults    ?? null,
    isComplete: t.isComplete    ?? null,
  };
}

// GET /api/scoreboard/tournaments?q=&gender=&division=&season=
// Returns a filtered, normalized list for the capture-page picker.
router.get('/tournaments', async (req, res) => {
  try {
    if (!cache.data || Date.now() - cache.at > TTL_MS) {
      const raw = await scoreboard.fetchTournaments();
      const list = Array.isArray(raw) ? raw : (raw.tournaments || raw.data || []);
      cache = { at: Date.now(), data: list.map(normalize).filter((t) => t.id != null) };
    }
    let out = cache.data;
    const { q, gender, division, season } = req.query;
    if (gender)   out = out.filter((t) => (t.gender || '').toLowerCase() === gender.toLowerCase());
    if (division) out = out.filter((t) => (t.division || '').toLowerCase().includes(division.toLowerCase()));
    if (season)   out = out.filter((t) => String(t.season) === String(season));
    if (q) {
      const needle = q.toLowerCase();
      out = out.filter((t) =>
        (t.name || '').toLowerCase().includes(needle) ||
        (t.course || '').toLowerCase().includes(needle) ||
        (t.city || '').toLowerCase().includes(needle));
    }
    res.json(out.slice(0, 50));
  } catch (err) {
    // Picker is optional sugar — never block capture if Clippd is unreachable.
    console.error('scoreboard catalog fetch failed:', err.message);
    res.status(502).json({ error: 'Scoreboard catalog unavailable', detail: err.message });
  }
});

module.exports = router;
