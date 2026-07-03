/**
 * Scoreboard (Clippd) client + sync
 * ---------------------------------
 * Reads college golf results from Scoreboard and feeds them into the
 * reconciliation engine as the authoritative SCORE layer.
 *
 * Data sources (see BACKLOG.md):
 *   • GET /api/tournaments[/:id]  — confirmed clean, unauthenticated JSON.
 *   • Per-player scoring/leaderboard is server-rendered (Next.js RSC), so it is
 *     NOT a plain REST route. That fetch is isolated in `fetchHoleByHole()` /
 *     the injectable resultsProvider, so the rest of the sync is stable while
 *     that scraper is finalized. Mike confirmed hole-by-hole IS scrapable —
 *     when it lands, it pre-fills authoritative hole scores and the player only
 *     ever enters stat fields.
 */
const reconcile = require('./reconcile');

const BASE = process.env.SCOREBOARD_API_BASE || 'https://scoreboard.clippd.com/api';

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Scoreboard ${path} → ${res.status}`);
  return res.json();
}

// Tournament catalog (rich objects: id, name, gender, division, dates, venue,
// competingSchools[], numRounds, season, hasResults, isComplete, …).
const fetchTournaments = (qs = '') => getJSON(`/tournaments${qs ? `?${qs}` : ''}`);
const fetchTournament = (id) => getJSON(`/tournaments/${id}`);

/**
 * Adapter for per-player results of one tournament round.
 * RETURN SHAPE (array), one entry per competing player:
 *   {
 *     clippdPlayerId: '…',
 *     identity: { clippdTournamentId, clippdRoundId, roundNum, tournament, courseName, roundDate },
 *     official: { score, toPar, finish, postedAt },
 *     holes:    [ { hole, par, score }, … ]   // optional — omit for totals-only
 *   }
 *
 * TODO(scraper): implement against the RSC payload or rendered leaderboard DOM.
 * Until then this returns [] so syncs are no-ops rather than failures.
 */
async function fetchHoleByHole(/* tournamentId, roundNum */) {
  return [];
}

/**
 * Sync one tournament round into Stat Caddie.
 * @param {string|number} tournamentId
 * @param {object} opts
 *   - roundNum:        which round (default 1)
 *   - resultsProvider: async (tournamentId, roundNum) => normalized results[]
 *                      (defaults to fetchHoleByHole; inject for tests/scraper)
 * Returns a summary: { tournamentId, roundNum, applied, unlinked, conflicts, results[] }.
 */
async function syncTournamentRound(tournamentId, opts = {}) {
  const { roundNum = 1, resultsProvider = fetchHoleByHole } = opts;
  const rows = await resultsProvider(tournamentId, roundNum);

  const summary = { tournamentId, roundNum, applied: 0, unlinked: 0, conflicts: 0, results: [] };

  // One transaction per player keeps a bad row from poisoning the whole batch.
  for (const row of rows) {
    try {
      const out = await reconcile.reconcileScoreboard({
        clippdPlayerId: row.clippdPlayerId,
        identity: { roundNum, ...row.identity },
        official: row.official || {},
        holes: row.holes || null,
      });
      if (out.status === 'unlinked') summary.unlinked++;
      else {
        summary.applied++;
        if (out.status === 'conflict') summary.conflicts++;
      }
      summary.results.push({ clippdPlayerId: row.clippdPlayerId, ...out });
    } catch (err) {
      summary.results.push({ clippdPlayerId: row.clippdPlayerId, status: 'error', error: err.message });
    }
  }
  return summary;
}

module.exports = {
  fetchTournaments,
  fetchTournament,
  fetchHoleByHole,
  syncTournamentRound,
};
