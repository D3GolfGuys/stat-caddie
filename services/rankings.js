/**
 * Ranking engine.
 *  1. provision a canonical college_player per app user (segment = their team)
 *  2. compute each player's season stat profile -> player_metric_season
 *  3. rank every player per metric within national/division/conference
 * Rankings come from CGM's own entered data — this is the moat.
 */
const { computeSeason, metricValues } = require('./stats');

async function ensureSeason(db, label) {
  await db.query(`UPDATE seasons SET is_current = FALSE WHERE is_current = TRUE`);
  const { rows } = await db.query(
    `INSERT INTO seasons (label, is_current) VALUES ($1, TRUE)
     ON CONFLICT (label) DO UPDATE SET is_current = TRUE RETURNING id`, [label]);
  return rows[0].id;
}

async function getCurrentSeasonId(db) {
  const cur = await db.query(`SELECT id FROM seasons WHERE is_current = TRUE ORDER BY id DESC LIMIT 1`);
  if (cur.rows.length) return cur.rows[0].id;
  const any = await db.query(`SELECT id FROM seasons ORDER BY id DESC LIMIT 1`);
  return any.rows.length ? any.rows[0].id : null;
}

// One canonical player per app user with rounds; segment from their team.
async function provisionPlayers(db, seasonId) {
  const { rows: users } = await db.query(`
    SELECT DISTINCT u.id AS user_id, u.name, t.division, t.conference, t.region, t.gender
      FROM users u
      JOIN rounds r ON r.user_id = u.id
      LEFT JOIN teams t ON t.id = u.team_id`);
  const map = {};
  for (const u of users) {
    let playerId;
    const ins = await db.query(`
      INSERT INTO college_players (full_name, user_id, gender)
      SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM college_players WHERE user_id = $2)
      RETURNING id`, [u.name || 'Player', u.user_id, u.gender || null]);
    if (ins.rows.length) playerId = ins.rows[0].id;
    else {
      playerId = (await db.query(`SELECT id FROM college_players WHERE user_id = $1`, [u.user_id])).rows[0].id;
      await db.query(`UPDATE college_players SET gender = COALESCE($2, gender) WHERE id = $1`, [playerId, u.gender || null]);
    }
    await db.query(`
      INSERT INTO player_seasons (player_id, season_id, division, conference, region, gender)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (player_id, season_id) DO UPDATE SET
        division   = COALESCE(EXCLUDED.division, player_seasons.division),
        conference = COALESCE(EXCLUDED.conference, player_seasons.conference),
        region     = COALESCE(EXCLUDED.region, player_seasons.region),
        gender     = COALESCE(EXCLUDED.gender, player_seasons.gender)`,
      [playerId, seasonId, u.division || null, u.conference || null, u.region || null, u.gender || null]);
    map[u.user_id] = playerId;
  }
  return map;
}

async function computeProfiles(db, seasonId, userToPlayer) {
  const mrows = (await db.query(`SELECT id, key FROM metrics`)).rows;
  const metricId = {}; mrows.forEach(m => (metricId[m.key] = m.id));
  let players = 0, upserts = 0;
  for (const userId of Object.keys(userToPlayer)) {
    const playerId = userToPlayer[userId];
    const rounds = (await db.query(`SELECT summary, tournament FROM rounds WHERE user_id = $1`, [userId])).rows;
    if (!rounds.length) continue;
    const vals = metricValues(computeSeason(rounds));
    const sampleN = computeSeason(rounds).rounds;
    for (const key of Object.keys(vals)) {
      const mid = metricId[key];
      if (!mid) continue;
      let v = vals[key];
      if (v == null || Number.isNaN(v)) v = null;
      await db.query(`
        INSERT INTO player_metric_season (player_id, season_id, metric_id, value, sample_n, computed_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (player_id, season_id, metric_id) DO UPDATE SET
          value = EXCLUDED.value, sample_n = EXCLUDED.sample_n, computed_at = NOW()`,
        [playerId, seasonId, mid, v, sampleN]);
      upserts++;
    }
    players++;
  }
  return { players, upserts };
}

const SEGMENTS = [
  { type: 'national',   expr: `'ALL'` },
  { type: 'division',   expr: `ps.division` },
  { type: 'conference', expr: `ps.conference` },
];

// Rank per (metric, segment): best value = rank 1 (direction-aware);
// percentile = share of the cohort you beat; skip below-min-sample players.
async function computeRankings(db, seasonId) {
  await db.query(`DELETE FROM rankings WHERE season_id = $1`, [seasonId]);
  let inserted = 0;
  for (const seg of SEGMENTS) {
    const res = await db.query(`
      INSERT INTO rankings (metric_id, season_id, segment_type, segment_value, gender, player_id, value, rank, percentile, sample_n, cohort_n, computed_at)
      SELECT metric_id, season_id, $2, seg, gender, player_id, value, rnk,
             CASE WHEN cohort_n > 1 THEN ROUND(100.0 * (cohort_n - rnk) / (cohort_n - 1), 2) ELSE 100 END,
             sample_n, cohort_n, NOW()
      FROM (
        SELECT pms.metric_id, pms.season_id, ${seg.expr} AS seg, ps.gender AS gender, pms.player_id, pms.value, pms.sample_n,
               RANK() OVER w AS rnk,
               COUNT(*) OVER (PARTITION BY pms.metric_id, ${seg.expr}, ps.gender) AS cohort_n
        FROM player_metric_season pms
        JOIN metrics m ON m.id = pms.metric_id
        JOIN player_seasons ps ON ps.player_id = pms.player_id AND ps.season_id = pms.season_id
        WHERE pms.season_id = $1 AND m.rankable AND pms.value IS NOT NULL
          AND pms.sample_n >= m.min_sample AND ${seg.expr} IS NOT NULL AND ps.gender IS NOT NULL
        WINDOW w AS (
          PARTITION BY pms.metric_id, ${seg.expr}, ps.gender
          ORDER BY pms.value * (CASE WHEN m.direction = 'lower' THEN 1 ELSE -1 END) ASC
        )
      ) x`, [seasonId, seg.type]);
    inserted += res.rowCount || 0;
  }
  return { inserted };
}

async function recompute(pool, opts = {}) {
  const label = String(opts.seasonLabel || '').trim() || 'current';
  const seasonId = await ensureSeason(pool, label);
  const map = await provisionPlayers(pool, seasonId);
  const prof = await computeProfiles(pool, seasonId, map);
  const rank = await computeRankings(pool, seasonId);
  const tprof = await computeTeamProfiles(pool, seasonId);
  const trank = await computeTeamRankings(pool, seasonId);
  return { seasonId, seasonLabel: label, players: Object.keys(map).length, profileUpserts: prof.upserts,
    rankingsInserted: rank.inserted, teams: tprof.teams, teamProfileUpserts: tprof.upserts, teamRankingsInserted: trank.inserted };
}

async function getPlayerRankings(db, userId, seasonId) {
  return (await db.query(`
    SELECT m.key, m.display_name, m.category, m.unit, m.decimals, m.direction,
           r.gender, r.segment_type, r.segment_value, r.value, r.rank, r.percentile, r.cohort_n
      FROM rankings r
      JOIN metrics m ON m.id = r.metric_id
      JOIN college_players cp ON cp.id = r.player_id
     WHERE cp.user_id = $1 AND r.season_id = $2
     ORDER BY m.sort_order ASC, r.segment_type ASC`, [userId, seasonId])).rows;
}

async function getLeaderboard(db, { metricKey, segmentType = 'national', segmentValue = 'ALL', gender = 'M', limit = 25 } = {}) {
  const seasonId = await getCurrentSeasonId(db);
  if (!seasonId || !metricKey) return [];
  return (await db.query(`
    SELECT cp.full_name AS player, ps.division, ps.conference, r.gender,
           r.value, r.rank, r.percentile, r.cohort_n
      FROM rankings r
      JOIN metrics m ON m.id = r.metric_id
      JOIN college_players cp ON cp.id = r.player_id
      LEFT JOIN player_seasons ps ON ps.player_id = r.player_id AND ps.season_id = r.season_id
     WHERE m.key = $1 AND r.segment_type = $2 AND r.segment_value = $3 AND r.gender = $4 AND r.season_id = $5
     ORDER BY r.rank ASC LIMIT $6`,
    [metricKey, segmentType, segmentValue, gender, seasonId, Math.min(Number(limit) || 25, 100)])).rows;
}

const TEAM_SEGMENTS = [
  { type: 'national',   expr: `'ALL'` },
  { type: 'division',   expr: `t.division` },
  { type: 'conference', expr: `t.conference` },
];

// A team's profile = aggregate of its players' rounds (coaches excluded).
async function computeTeamProfiles(db, seasonId) {
  const mrows = (await db.query(`SELECT id, key FROM metrics`)).rows;
  const metricId = {}; mrows.forEach(m => (metricId[m.key] = m.id));
  const teams = (await db.query(
    `SELECT DISTINCT t.id FROM teams t
       JOIN users u ON u.team_id = t.id AND u.role <> 'team_admin'
       JOIN rounds r ON r.user_id = u.id`)).rows;
  let count = 0, upserts = 0;
  for (const t of teams) {
    const rounds = (await db.query(
      `SELECT r.summary, r.tournament FROM rounds r
         JOIN users u ON u.id = r.user_id
        WHERE u.team_id = $1 AND u.role <> 'team_admin'`, [t.id])).rows;
    if (!rounds.length) continue;
    const season = computeSeason(rounds);
    const vals = metricValues(season);
    const sampleN = season.rounds;
    for (const key of Object.keys(vals)) {
      const mid = metricId[key]; if (!mid) continue;
      let v = vals[key]; if (v == null || Number.isNaN(v)) v = null;
      await db.query(`
        INSERT INTO team_metric_season (team_id, season_id, metric_id, value, sample_n, computed_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (team_id, season_id, metric_id) DO UPDATE SET
          value = EXCLUDED.value, sample_n = EXCLUDED.sample_n, computed_at = NOW()`,
        [t.id, seasonId, mid, v, sampleN]);
      upserts++;
    }
    count++;
  }
  return { teams: count, upserts };
}

async function computeTeamRankings(db, seasonId) {
  await db.query(`DELETE FROM team_rankings WHERE season_id = $1`, [seasonId]);
  let inserted = 0;
  for (const seg of TEAM_SEGMENTS) {
    const res = await db.query(`
      INSERT INTO team_rankings (metric_id, season_id, segment_type, segment_value, gender, team_id, value, rank, percentile, sample_n, cohort_n, computed_at)
      SELECT metric_id, season_id, $2, seg, gender, team_id, value, rnk,
             CASE WHEN cohort_n > 1 THEN ROUND(100.0 * (cohort_n - rnk) / (cohort_n - 1), 2) ELSE 100 END,
             sample_n, cohort_n, NOW()
      FROM (
        SELECT tms.metric_id, tms.season_id, ${seg.expr} AS seg, t.gender AS gender, tms.team_id, tms.value, tms.sample_n,
               RANK() OVER w AS rnk,
               COUNT(*) OVER (PARTITION BY tms.metric_id, ${seg.expr}, t.gender) AS cohort_n
        FROM team_metric_season tms
        JOIN metrics m ON m.id = tms.metric_id
        JOIN teams t ON t.id = tms.team_id
        WHERE tms.season_id = $1 AND m.rankable AND tms.value IS NOT NULL
          AND tms.sample_n >= m.min_sample AND ${seg.expr} IS NOT NULL AND t.gender IS NOT NULL
        WINDOW w AS (
          PARTITION BY tms.metric_id, ${seg.expr}, t.gender
          ORDER BY tms.value * (CASE WHEN m.direction = 'lower' THEN 1 ELSE -1 END) ASC
        )
      ) x`, [seasonId, seg.type]);
    inserted += res.rowCount || 0;
  }
  return { inserted };
}

async function getTeamLeaderboard(db, { metricKey, segmentType = 'national', segmentValue = 'ALL', gender = 'M', limit = 25 } = {}) {
  const seasonId = await getCurrentSeasonId(db);
  if (!seasonId || !metricKey) return [];
  return (await db.query(`
    SELECT t.name AS team, t.division, t.conference, tr.gender,
           tr.value, tr.rank, tr.percentile, tr.cohort_n
      FROM team_rankings tr
      JOIN metrics m ON m.id = tr.metric_id
      JOIN teams t ON t.id = tr.team_id
     WHERE m.key = $1 AND tr.segment_type = $2 AND tr.segment_value = $3 AND tr.gender = $4 AND tr.season_id = $5
     ORDER BY tr.rank ASC LIMIT $6`,
    [metricKey, segmentType, segmentValue, gender, seasonId, Math.min(Number(limit) || 25, 100)])).rows;
}

async function getTeamRankings(db, teamId, seasonId) {
  return (await db.query(`
    SELECT m.key, m.display_name, m.category, m.unit, m.decimals, m.direction,
           tr.gender, tr.segment_type, tr.segment_value, tr.value, tr.rank, tr.percentile, tr.cohort_n
      FROM team_rankings tr
      JOIN metrics m ON m.id = tr.metric_id
     WHERE tr.team_id = $1 AND tr.season_id = $2
     ORDER BY m.sort_order ASC, tr.segment_type ASC`, [teamId, seasonId])).rows;
}

async function listMetrics(db) {
  return (await db.query(
    `SELECT key, display_name, category, unit, decimals, direction
       FROM metrics WHERE rankable ORDER BY sort_order ASC`)).rows;
}

module.exports = { recompute, getCurrentSeasonId, getPlayerRankings, getLeaderboard, listMetrics,
  getTeamLeaderboard, getTeamRankings,
  ensureSeason, provisionPlayers, computeProfiles, computeRankings, computeTeamProfiles, computeTeamRankings };
