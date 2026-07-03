/**
 * Integration test for the reconciliation engine — runs against a real Postgres.
 *
 *   DATABASE_URL=postgres://user:pass@localhost:5432/statcaddie_test \
 *     node test/reconcile.test.js
 *
 * Exercises both arrival orders (stats-first, score-first), the conflict path,
 * and conflict resolution, asserting the canonical round's status at each step.
 * Creates a throwaway user and deletes it (cascading its rounds) on exit.
 */
const assert = require('assert');
const { pool, initDB } = require('../db');
const reconcile = require('../services/reconcile');

// 18 pars of 4; pass overrides like {3:5} to bump a hole's score.
function holeData(scoreOverrides = {}, withStats = true) {
  const hd = {};
  for (let h = 1; h <= 18; h++) {
    hd[`par-${h}`] = 4;
    hd[`score-${h}`] = scoreOverrides[h] || 4;
    if (withStats) {
      hd[`gir-${h}`] = 'Y';
      hd[`putts-${h}`] = 2;
      hd[`fw-${h}`] = 'Y';
    }
  }
  return hd;
}
const statusOf = async (id) => (await pool.query('SELECT status FROM rounds WHERE id=$1', [id])).rows[0].status;

async function run() {
  await initDB();
  const { rows: u } = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1,'x','Test Player') RETURNING id`,
    [`recon_test_${Date.now()}@example.com`]
  );
  const userId = u[0].id;
  let passed = 0;
  const check = (name, cond) => { assert.ok(cond, name); console.log('PASS ', name); passed++; };

  try {
    // ── Scenario A: stats entered first, official lands later ────────────────
    const idA = { clippdTournamentId: 'TA', tournament: 'Event A', roundNum: 1 };
    let a = await reconcile.reconcileManual({ userId, identity: idA, holeData: holeData({ 3: 5 }) }); // total 73
    check('A1 manual-first → stats_only', a.status === 'stats_only');

    a = await reconcile.reconcileScoreboard({ userId, identity: idA, official: { score: 73, toPar: 1 } });
    check('A2 official matches → confirmed', a.status === 'confirmed');
    check('A2 same canonical round (no dup)', a.roundId === (await reconcile.reconcileManual({ userId, identity: idA, holeData: holeData({ 3: 5 }) })).roundId);

    // ── Scenario A': mismatch → conflict, then resolve ───────────────────────
    const idC = { clippdTournamentId: 'TC', tournament: 'Event C', roundNum: 1 };
    await reconcile.reconcileManual({ userId, identity: idC, holeData: holeData({ 3: 5, 4: 5 }) }); // total 74
    let c = await reconcile.reconcileScoreboard({ userId, identity: idC, official: { score: 73 } });
    check('A3 totals differ → conflict', c.status === 'conflict');

    await pool.query("UPDATE rounds SET resolution='official' WHERE id=$1", [c.roundId]);
    await reconcile.withTx((cl) => reconcile.recomputeStatus(cl, c.roundId));
    check('A3 resolve=official → confirmed', (await statusOf(c.roundId)) === 'confirmed');

    // ── Scenario B: score from Scoreboard first, stats added later ───────────
    const idB = { clippdTournamentId: 'TB', tournament: 'Event B', roundNum: 1 };
    const holes = Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 4, score: i === 2 ? 5 : 4 })); // 73
    let b = await reconcile.reconcileScoreboard({ userId, identity: idB, official: { score: 73 }, holes });
    check('B1 scoreboard-first → score_only', b.status === 'score_only');
    check('B1 appears on needs-stats worklist',
      (await pool.query("SELECT 1 FROM rounds WHERE id=$1 AND status='score_only'", [b.roundId])).rowCount === 1);

    // Player adds stats onto the pre-scored card. Hole scores are scoreboard-owned,
    // so manual stat entry must NOT create a conflict and must NOT clobber scores.
    b = await reconcile.reconcileManual({ userId, identity: idB, holeData: holeData({}, true) });
    check('B2 add stats on scored card → confirmed', b.status === 'confirmed');
    const srcs = await pool.query("SELECT COUNT(*) c FROM round_holes WHERE round_id=$1 AND score_source='scoreboard'", [b.roundId]);
    check('B2 official hole scores preserved', Number(srcs.rows[0].c) === 18);
    const tot = await pool.query('SELECT SUM(score) s FROM round_holes WHERE round_id=$1', [b.roundId]);
    check('B2 total still official (73, not clobbered)', Number(tot.rows[0].s) === 73);

    // ── player_link resolution path ─────────────────────────────────────────
    await pool.query('INSERT INTO player_links (user_id, clippd_player_id) VALUES ($1,$2)', [userId, 'CP1']);
    const idP = { clippdTournamentId: 'TP', tournament: 'Event P', roundNum: 1 };
    const p = await reconcile.reconcileScoreboard({ clippdPlayerId: 'CP1', identity: idP, official: { score: 70 } });
    check('Link: clippd_player_id resolves to user', p.roundId && p.status === 'score_only');
    const unl = await reconcile.reconcileScoreboard({ clippdPlayerId: 'UNKNOWN', identity: idP, official: { score: 70 } });
    check('Link: unknown player → unlinked (no write)', unl.status === 'unlinked' && unl.roundId === null);

    console.log(`\n${passed} checks passed ✅`);
  } finally {
    await pool.query('DELETE FROM users WHERE id=$1', [userId]); // cascades rounds/holes/links/logs
    await pool.end();
  }
}

run().catch((e) => { console.error('❌', e); process.exit(1); });
