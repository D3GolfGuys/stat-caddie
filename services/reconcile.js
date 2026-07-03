/**
 * Reconciliation engine
 * ----------------------
 * A round is ONE canonical record with two layers that can arrive in any order:
 *
 *   • SCORE layer  — authoritative, owned by Scoreboard (official_score, finish,
 *                    and optionally authoritative hole-by-hole scores).
 *   • STAT layer   — owned by manual entry (GIR, putts, fairways, prox, …).
 *
 * The two layers never fight over the same field: Scoreboard is the score of
 * record; manual entry owns the stats. Whichever stream arrives, we find-or-
 * create the round on a deterministic key and merge in the missing layer, then
 * recompute status: score_only → stats_only → confirmed | conflict.
 *
 * Public (transaction-managing) entry points:
 *   reconcileManual(payload)      — called by the capture POST
 *   reconcileScoreboard(payload)  — called by the Scoreboard sync
 *
 * Inner (client-taking) functions are exported too, for routes that already
 * hold a transaction and for the test harness.
 */
const { pool } = require('../db');

// Fields that constitute the STAT layer (presence of any => has_stats).
const STAT_PRESENCE_SQL = `
  (gir IS NOT NULL OR putts IS NOT NULL OR fw IS NOT NULL OR prox IS NOT NULL
   OR miss_dir IS NOT NULL OR drive_dist IS NOT NULL OR first_putt IS NOT NULL
   OR ud_att OR ss_att OR COALESCE(pen_strokes,0) > 0)`;

// ── helpers ────────────────────────────────────────────────────────────────

// Map a Clippd player identity to a local user via player_links.
async function resolveUserId(client, clippdPlayerId) {
  if (!clippdPlayerId) return null;
  const { rows } = await client.query(
    'SELECT user_id FROM player_links WHERE clippd_player_id=$1',
    [clippdPlayerId]
  );
  return rows.length ? rows[0].user_id : null;
}

// Find the canonical round for an identity, or create it. Deterministic when a
// Clippd tournament id is present; otherwise falls back to a tournament/round/
// date heuristic so legacy free-text rounds still de-dupe.
async function ensureRound(client, { userId, teamId = null, identity, header = {} }) {
  const { clippdTournamentId, clippdRoundId, clippdPlayerId, tournament, roundNum = 1, roundDate, courseName } = identity;

  let found;
  if (clippdTournamentId) {
    ({ rows: found } = await client.query(
      'SELECT * FROM rounds WHERE user_id=$1 AND clippd_tournament_id=$2 AND round_num=$3',
      [userId, clippdTournamentId, roundNum]
    ));
  } else {
    ({ rows: found } = await client.query(
      `SELECT * FROM rounds
        WHERE user_id=$1 AND round_num=$2
          AND LOWER(COALESCE(tournament,''))=LOWER(COALESCE($3,''))
          AND COALESCE(round_date::text,'')=COALESCE($4::text,'')`,
      [userId, roundNum, tournament || null, roundDate || null]
    ));
  }
  if (found.length) {
    // Backfill identity if this stream knows more than the stored row.
    await client.query(
      `UPDATE rounds SET
         clippd_tournament_id = COALESCE(clippd_tournament_id, $2),
         clippd_round_id      = COALESCE(clippd_round_id, $3),
         clippd_player_id     = COALESCE(clippd_player_id, $4),
         course_name          = COALESCE(course_name, $5),
         tournament           = COALESCE(tournament, $6)
       WHERE id=$1`,
      [found[0].id, clippdTournamentId || null, clippdRoundId || null, clippdPlayerId || null, courseName || null, tournament || null]
    );
    return found[0].id;
  }

  const { rows } = await client.query(
    `INSERT INTO rounds
       (user_id, team_id, player_name, tournament, round_num, round_date, course_name,
        rating, slope, conditions, weather, round_notes,
        clippd_tournament_id, clippd_round_id, clippd_player_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      userId, teamId, header.playerName || null, tournament || null, roundNum,
      roundDate || null, courseName || null, header.rating || null, header.slope || null,
      header.conditions || null, header.weather || null, header.roundNotes || null,
      clippdTournamentId || null, clippdRoundId || null, clippdPlayerId || null,
      'stats_only',
    ]
  );
  return rows[0].id;
}

// Recompute derived fields + status from the round's current holes/official data.
// Returns the new status. Logs a score_conflict the first time one appears.
async function recomputeStatus(client, roundId) {
  const { rows: r } = await client.query('SELECT status, official_score, resolution FROM rounds WHERE id=$1', [roundId]);
  if (!r.length) return null;
  const prevStatus = r[0].status;
  const resolution = r[0].resolution; // null | 'official' | 'entered' — a user adjudication
  const hasOfficial = r[0].official_score != null;

  const { rows: agg } = await client.query(
    `SELECT
       COALESCE(SUM(score),0)                                            AS entered_score,
       COUNT(*) FILTER (WHERE score IS NOT NULL)                         AS scored_holes,
       COUNT(*) FILTER (WHERE score_source='manual' AND score IS NOT NULL) AS manual_scored,
       BOOL_OR(${STAT_PRESENCE_SQL})                                     AS has_stats
     FROM round_holes WHERE round_id=$1`,
    [roundId]
  );
  const enteredScore = Number(agg[0].entered_score) || 0;
  const scoredHoles = Number(agg[0].scored_holes) || 0;
  const manualScored = Number(agg[0].manual_scored) || 0;
  const hasStats = !!agg[0].has_stats;

  let status;
  if (hasOfficial && hasStats) {
    // A conflict only when the player entered their OWN hole scores and they
    // disagree with the official total — and the user hasn't adjudicated it.
    const rawConflict = manualScored > 0 && scoredHoles >= 1 && enteredScore !== r[0].official_score;
    status = (rawConflict && !resolution) ? 'conflict' : 'confirmed';
  } else if (hasOfficial) {
    status = 'score_only';
  } else if (hasStats) {
    status = 'stats_only';
  } else {
    status = hasOfficial ? 'score_only' : 'stats_only';
  }

  await client.query(
    `UPDATE rounds SET
       entered_score = $2,
       has_official  = $3,
       has_stats     = $4,
       status        = $5
     WHERE id=$1`,
    [roundId, scoredHoles ? enteredScore : null, hasOfficial, hasStats, status]
  );

  if (status === 'conflict' && prevStatus !== 'conflict') {
    await client.query(
      `INSERT INTO reconciliation_log (round_id, kind, detail)
       VALUES ($1,'score_conflict',$2)`,
      [roundId, JSON.stringify({ entered_score: enteredScore, official_score: r[0].official_score })]
    );
  }
  return status;
}

// ── manual entry (STAT layer) ───────────────────────────────────────────────

// Normalize the capture form's flat holeData map into per-hole objects.
function parseHoleData(holeData = {}) {
  const out = [];
  for (let h = 1; h <= 18; h++) {
    const score = parseInt(holeData[`score-${h}`]);
    const par = parseInt(holeData[`par-${h}`]);
    const hasAny = score || par || holeData[`gir-${h}`] || holeData[`putts-${h}`] || holeData[`fw-${h}`];
    if (!hasAny) continue;
    out.push({
      hole: h,
      par: par || 4,
      hcp: parseInt(holeData[`hcp-${h}`]) || null,
      score: score || null,
      fw: holeData[`fw-${h}`] || null,
      gir: holeData[`gir-${h}`] || null,
      miss_dir: holeData[`miss-${h}`] || null,
      drive_dist: parseInt(holeData[`drive-${h}`]) || null,
      prox: parseFloat(holeData[`prox-${h}`]) || null,
      putts: parseInt(holeData[`putts-${h}`]) || null,
      first_putt: parseFloat(holeData[`firstputt-${h}`]) || null,
      three_putt: holeData[`threeputt-${h}`] === 'Y',
      ud_att: holeData[`ud-att-${h}`] === 'Y',
      ud_made: holeData[`ud-made-${h}`] === 'Y',
      ss_att: holeData[`ss-att-${h}`] === 'Y',
      ss_made: holeData[`ss-made-${h}`] === 'Y',
      pen_strokes: parseInt(holeData[`pen-${h}`]) || 0,
      notes: holeData[`notes-${h}`] || null,
    });
  }
  return out;
}

// Write the STAT layer. Stat fields are always written; score/par are written
// ONLY when the hole is not already owned by Scoreboard, so manual edits can
// never clobber an authoritative official score.
async function applyManualEntry(client, { userId, teamId = null, identity, header = {}, holeData }) {
  const roundId = await ensureRound(client, { userId, teamId, identity, header });
  const holes = parseHoleData(holeData);

  for (const h of holes) {
    await client.query(
      `INSERT INTO round_holes
         (round_id, hole_num, par, hcp, score, fw, gir, miss_dir, drive_dist, prox,
          putts, first_putt, three_putt, ud_att, ud_made, ss_att, ss_made, pen_strokes, notes, score_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'manual')
       ON CONFLICT (round_id, hole_num) DO UPDATE SET
         -- stat fields: always owned by manual entry
         hcp=$4, fw=$6, gir=$7, miss_dir=$8, drive_dist=$9, prox=$10,
         putts=$11, first_putt=$12, three_putt=$13, ud_att=$14, ud_made=$15,
         ss_att=$16, ss_made=$17, pen_strokes=$18, notes=$19,
         -- score/par: keep Scoreboard's if it owns the hole, else take manual
         score = CASE WHEN round_holes.score_source='scoreboard' THEN round_holes.score ELSE $5 END,
         par   = CASE WHEN round_holes.score_source='scoreboard' THEN round_holes.par   ELSE $3 END`,
      [roundId, h.hole, h.par, h.hcp, h.score, h.fw, h.gir, h.miss_dir, h.drive_dist, h.prox,
       h.putts, h.first_putt, h.three_putt, h.ud_att, h.ud_made, h.ss_att, h.ss_made, h.pen_strokes, h.notes]
    );
  }
  const status = await recomputeStatus(client, roundId);
  return { roundId, status };
}

// ── scoreboard result (SCORE layer) ─────────────────────────────────────────

// Apply the authoritative score layer. `official` = { score, toPar, finish, postedAt }.
// `holes` (optional) = [{ hole, par, score }] authoritative hole-by-hole — when
// present we own those holes (score_source='scoreboard') and leave stat fields
// untouched, so the player only ever fills in stats on a pre-scored card.
async function applyScoreboardResult(client, { userId, clippdPlayerId, identity, official = {}, holes = null }) {
  const resolvedUserId = userId || (await resolveUserId(client, clippdPlayerId || identity.clippdPlayerId));
  if (!resolvedUserId) {
    return { roundId: null, status: 'unlinked', reason: 'no player_link for clippd_player_id' };
  }

  const roundId = await ensureRound(client, {
    userId: resolvedUserId,
    identity: { ...identity, clippdPlayerId: clippdPlayerId || identity.clippdPlayerId },
  });

  await client.query(
    `UPDATE rounds SET
       official_score     = $2,
       official_to_par    = $3,
       official_finish    = $4,
       official_posted_at = COALESCE($5, NOW())
     WHERE id=$1`,
    [roundId, official.score ?? null, official.toPar ?? null, official.finish ?? null, official.postedAt || null]
  );

  if (Array.isArray(holes)) {
    for (const h of holes) {
      await client.query(
        `INSERT INTO round_holes (round_id, hole_num, par, score, score_source)
         VALUES ($1,$2,$3,$4,'scoreboard')
         ON CONFLICT (round_id, hole_num) DO UPDATE SET
           par=$3, score=$4, score_source='scoreboard'`,
        [roundId, h.hole, h.par ?? null, h.score ?? null]
      );
    }
  }

  await client.query(
    `INSERT INTO reconciliation_log (round_id, kind, detail)
     VALUES ($1,'merged_official',$2)`,
    [roundId, JSON.stringify({ official, holeByHole: Array.isArray(holes) })]
  );

  const status = await recomputeStatus(client, roundId);
  return { roundId, status };
}

// ── transaction wrappers ─────────────────────────────────────────────────────

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const reconcileManual = (payload) => withTx((c) => applyManualEntry(c, payload));
const reconcileScoreboard = (payload) => withTx((c) => applyScoreboardResult(c, payload));

module.exports = {
  reconcileManual,
  reconcileScoreboard,
  // inner (client-taking) — for routes inside an existing tx + tests
  applyManualEntry,
  applyScoreboardResult,
  recomputeStatus,
  ensureRound,
  resolveUserId,
  parseHoleData,
  withTx,
};
