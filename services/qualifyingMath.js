/**
 * Qualifying standings math — pure, no DB. Kept separate so it is unit-testable
 * without a database connection and reusable on the client if needed.
 */
const SCORING = ['cumulative_to_par', 'average_to_par'];

function safeParse(s) { try { return JSON.parse(s) || {}; } catch (_) { return {}; } }

// Coerce a raw config (object or JSON string) to the supported v1.0 shape.
function normalizeConfig(config = {}) {
  const c = typeof config === 'string' ? safeParse(config) : (config || {});
  const scoring = SCORING.includes(c.scoring) ? c.scoring : 'cumulative_to_par';
  const countBest = Number.isInteger(c.countBest) && c.countBest > 0 ? c.countBest : null;
  const dropWorst = Number.isInteger(c.dropWorst) && c.dropWorst > 0 ? c.dropWorst : 0;
  return { scoring, countBest, dropWorst };
}

/**
 * participants: [{ userId, name, toPars: [Number, ...] }]  (to-par per round; lower is better)
 * config:       { scoring, countBest, dropWorst }
 * Returns players sorted best-first with shared ranks on ties; players with no
 * counted rounds are appended unranked (rank: null).
 */
function computeStandings(participants, config = {}) {
  const { scoring, countBest, dropWorst } = normalizeConfig(config);
  const scored = (participants || []).map((p) => {
    const all = (p.toPars || []).filter((v) => v != null && !Number.isNaN(Number(v))).map(Number);
    const sorted = [...all].sort((a, b) => a - b); // best (lowest to-par) first
    let counted = sorted;
    if (countBest != null) counted = sorted.slice(0, countBest);
    else if (dropWorst > 0 && sorted.length > dropWorst) counted = sorted.slice(0, sorted.length - dropWorst);
    let total = null;
    if (counted.length) {
      const sum = counted.reduce((a, b) => a + b, 0);
      total = scoring === 'average_to_par' ? Math.round((sum / counted.length) * 100) / 100 : sum;
    }
    return { userId: p.userId, name: p.name, total, roundsPlayed: all.length, counted: counted.length };
  });
  const ranked = scored.filter((s) => s.total != null).sort((a, b) => a.total - b.total);
  let lastVal = null, lastRank = 0;
  ranked.forEach((s, i) => {
    if (lastVal === null || s.total !== lastVal) { lastRank = i + 1; lastVal = s.total; }
    s.rank = lastRank;
  });
  const unranked = scored.filter((s) => s.total == null).map((s) => ({ ...s, rank: null }));
  return [...ranked, ...unranked];
}

module.exports = { computeStandings, normalizeConfig };
