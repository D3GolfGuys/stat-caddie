// ── Demo data seeder (Beta) ────────────────────────────────────────────────
// Creates two demo players, each with 5 fully-statted rounds, so the owner can
// exercise the all-players report view. Idempotent: re-seeding replaces the
// demo players' rounds rather than piling up duplicates. Everything here is
// tagged with the DEMO_DOMAIN email suffix so clearDemo() can cleanly remove it.
//
// The round summaries are computed with the SAME math as the capture page
// (public/statcaddie_capture.html → computeSummary), so seeded rounds render
// identically to real ones on the dashboard.

const bcrypt = require('bcryptjs');

const DEMO_DOMAIN = 'demo.statcaddie';

// Two players with distinct skill profiles so the report shows real spread.
const DEMO_PLAYERS = [
  {
    name: 'Riley Thompson', email: `riley@${DEMO_DOMAIN}`,
    // strong D-I player, hovers around par
    parBias: 0.15, parJitter: 0.9, fwProb: 0.66, girProb: 0.62,
    driveBase: 292, putts1Prob: 0.42, scramProb: 0.60, sandProb: 0.52, penProb: 0.05,
  },
  {
    name: 'Casey Morgan', email: `casey@${DEMO_DOMAIN}`,
    // developing player, mid-single-digit over par
    parBias: 0.55, parJitter: 1.15, fwProb: 0.52, girProb: 0.44,
    driveBase: 268, putts1Prob: 0.28, scramProb: 0.44, sandProb: 0.34, penProb: 0.12,
  },
];

// Standard par-72 layout (four 3s, four 5s, ten 4s).
const PAR_LAYOUT = [4, 5, 4, 3, 4, 4, 5, 3, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4];
// Stroke-index (handicap) per hole — arbitrary but valid 1–18.
const HCP_LAYOUT = [7, 3, 11, 15, 1, 9, 5, 17, 13, 8, 16, 4, 12, 2, 18, 10, 6, 14];

const COURSES = [
  { tournament: 'Fall Invitational',       course: 'Pinehurst No. 2' },
  { tournament: 'Conference Championship', course: 'Oak Hill CC' },
  { tournament: 'Spring Collegiate',       course: 'Bandon Trails' },
  { tournament: 'Regional Qualifier',      course: 'Whistling Straits' },
  { tournament: 'Home Invite',             course: 'Scarlet Course' },
];

// Deterministic PRNG (mulberry32) so seeded data is stable across runs.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const r2 = v => Math.round(v * 100) / 100;

// Build 18 holes of plausible, internally-consistent shot data for one round.
function generateHoles(p, rnd) {
  const holes = [];
  for (let i = 0; i < 18; i++) {
    const par = PAR_LAYOUT[i];
    const hcp = HCP_LAYOUT[i];

    // Score relative to par, biased by skill; clamp to a sane range.
    let rel = Math.round((rnd() - 0.5) * 2 * p.parJitter + p.parBias);
    rel = Math.max(-1, Math.min(3, rel));       // eagle-ish floor .. triple ceiling
    if (par === 3 && rel < 0) rel = 0;          // no albatross/eagle on a par 3 here
    const score = par + rel;

    const isTeeClub = par >= 4;                 // driver holes
    const gir = rnd() < p.girProb;              // green in regulation?
    // Fairway only tracked on driving holes.
    let fw = 'N/A';
    if (isTeeClub) {
      if (rnd() < p.fwProb) fw = 'Y';
      else fw = rnd() < 0.5 ? 'L' : 'R';
    }
    const driveDist = isTeeClub
      ? Math.round(p.driveBase + (rnd() - 0.5) * 34 + (par === 5 ? 6 : 0))
      : null;

    // Approach proximity: closer when you hit the green.
    const prox = gir
      ? r2(8 + rnd() * 26)                       // 8–34 ft
      : r2(24 + rnd() * 40);                      // longer when short-sided/off

    // Putts: GIR → mostly 2 (sometimes 1 or 3); miss → putts after chip.
    let putts;
    if (gir) {
      const u = rnd();
      putts = u < p.putts1Prob ? 1 : (u < 0.9 ? 2 : 3);
    } else {
      putts = rnd() < 0.7 ? 2 : 1;               // chip on, then putt(s)
    }
    const threePutt = putts >= 3;

    // Up-and-down / sand save chances only when the green was missed.
    let udAtt = false, udMade = false, ssAtt = false, ssMade = false;
    if (!gir) {
      const bunker = rnd() < 0.22;
      if (bunker) { ssAtt = true; ssMade = rnd() < p.sandProb; }
      else        { udAtt = true; udMade = rnd() < p.scramProb; }
    }

    // Penalties: rare, and only ever inflate the score narrative loosely.
    const pen = rnd() < p.penProb ? 1 : 0;

    holes.push({
      hole_num: i + 1, par, hcp, score, fw, gir: gir ? 'Y' : 'N',
      drive_dist: driveDist, prox, putts, first_putt: gir ? prox : r2(4 + rnd() * 8),
      three_putt: threePutt, ud_att: udAtt, ud_made: udMade,
      ss_att: ssAtt, ss_made: ssMade, pen_strokes: pen,
    });
  }
  return holes;
}

// Port of computeSummary() from the capture page. Given the holes above, produce
// the summary JSON the dashboard reads.
function computeSummary(holes) {
  let holesPlayed = 0, totalScore = 0, totalPar = 0;
  let frontScore = 0, backScore = 0, frontPar = 0, backPar = 0;
  let fwHit = 0, fwAtt = 0, girHit = 0;
  let proxSum = 0, proxCnt = 0, proxGirSum = 0, proxGirCnt = 0, proxMissSum = 0, proxMissCnt = 0;
  let puttsTotal = 0, puttsCnt = 0, puttsGirSum = 0, puttsGirCnt = 0, onePutts = 0, threePutts = 0;
  let driveSum = 0, driveCnt = 0, driveMax = 0;
  let udAtt = 0, udMade = 0, ssAtt = 0, ssMade = 0, penTotal = 0;
  let eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubles = 0, worses = 0;
  const par3s = [], par4s = [], par5s = [];
  const par3Gir = [0, 0], par4Gir = [0, 0], par5Gir = [0, 0];

  for (const h of holes) {
    const { par, score, fw, gir, drive_dist: drive, prox, putts, three_putt: tp } = h;
    holesPlayed++;
    totalScore += score; totalPar += par;
    if (h.hole_num <= 9) { frontScore += score; frontPar += par; }
    else                 { backScore  += score; backPar  += par; }

    const rel = score - par;
    if (rel <= -2) eagles++;
    else if (rel === -1) birdies++;
    else if (rel === 0) pars++;
    else if (rel === 1) bogeys++;
    else if (rel === 2) doubles++;
    else worses++;

    if (par === 3) { par3s.push(score); par3Gir[1]++; }
    else if (par === 4) { par4s.push(score); par4Gir[1]++; }
    else { par5s.push(score); par5Gir[1]++; }

    if (fw === 'Y') { fwHit++; fwAtt++; }
    else if (fw === 'L' || fw === 'R') fwAtt++;

    if (gir === 'Y') {
      girHit++;
      if (par === 3) par3Gir[0]++; else if (par === 4) par4Gir[0]++; else par5Gir[0]++;
    }
    if (drive !== null && fw !== 'N/A') {
      driveSum += drive; driveCnt++;
      if (drive > driveMax) driveMax = drive;
    }
    if (prox !== null) {
      proxSum += prox; proxCnt++;
      if (gir === 'Y') { proxGirSum += prox; proxGirCnt++; }
      else { proxMissSum += prox; proxMissCnt++; }
    }
    if (putts !== null) {
      puttsTotal += putts; puttsCnt++;
      if (gir === 'Y') { puttsGirSum += putts; puttsGirCnt++; }
      if (putts === 1) onePutts++;
    }
    if (tp) threePutts++;
    if (h.ud_att) udAtt++;
    if (h.ud_made) udMade++;
    if (h.ss_att) ssAtt++;
    if (h.ss_made) ssMade++;
    penTotal += h.pen_strokes || 0;
  }

  return {
    holesPlayed,
    totalScore, totalPar, vspar: totalScore - totalPar,
    frontScore, backScore, frontPar, backPar,
    fwHit, fwAtt, fwPct: fwAtt ? r2(fwHit / fwAtt * 100) : null,
    girHit, girPct: r2(girHit / 18 * 100),
    proxAvg:     proxCnt     ? r2(proxSum / proxCnt)         : null,
    proxGirAvg:  proxGirCnt  ? r2(proxGirSum / proxGirCnt)   : null,
    proxMissAvg: proxMissCnt ? r2(proxMissSum / proxMissCnt) : null,
    puttsTotal, puttsPerHole: puttsCnt ? r2(puttsTotal / puttsCnt) : null,
    puttsPerGir: puttsGirCnt ? r2(puttsGirSum / puttsGirCnt) : null,
    onePutts, threePutts,
    driveAvg: driveCnt ? Math.round(driveSum / driveCnt) : null,
    driveMax: driveMax || null,
    udAtt, udMade, scramblingPct: udAtt ? r2(udMade / udAtt * 100) : null,
    ssAtt, ssMade, ssPct: ssAtt ? r2(ssMade / ssAtt * 100) : null,
    penTotal,
    eagles, birdies, pars, bogeys, doubles, worses,
    par3Avg: par3s.length ? r2(par3s.reduce((a, b) => a + b, 0) / par3s.length) : null,
    par4Avg: par4s.length ? r2(par4s.reduce((a, b) => a + b, 0) / par4s.length) : null,
    par5Avg: par5s.length ? r2(par5s.reduce((a, b) => a + b, 0) / par5s.length) : null,
    par3GirPct: par3Gir[1] ? r2(par3Gir[0] / par3Gir[1] * 100) : null,
    par4GirPct: par4Gir[1] ? r2(par4Gir[0] / par4Gir[1] * 100) : null,
    par5GirPct: par5Gir[1] ? r2(par5Gir[0] / par5Gir[1] * 100) : null,
  };
}

// Build the 5 round records (header + holes + summary) for one player.
function buildRounds(player, seed) {
  const rnd = rng(seed);
  const rounds = [];
  const today = new Date();
  for (let k = 0; k < 5; k++) {
    const meta = COURSES[k % COURSES.length];
    const holes = generateHoles(player, rnd);
    const summary = computeSummary(holes);
    // Space the rounds out over the last ~10 weeks.
    const d = new Date(today);
    d.setDate(d.getDate() - (55 - k * 12) - Math.floor(rnd() * 4));
    rounds.push({
      player_name: player.name,
      tournament: meta.tournament,
      round_num: 1 + (k % 2),           // vary R1 / R2
      round_date: d.toISOString().slice(0, 10),
      course_name: meta.course,
      summary, holes,
      total: summary.totalScore, toPar: summary.vspar,
    });
  }
  return rounds;
}

// Insert one seeded round + its holes inside an existing client/tx.
async function insertRound(client, userId, r) {
  const { rows } = await client.query(
    `INSERT INTO rounds
       (user_id, player_name, tournament, round_num, round_date, course_name,
        summary, entered_score, official_score, official_to_par,
        has_official, has_stats, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,true,'confirmed',$11)
     RETURNING id`,
    [userId, r.player_name, r.tournament, r.round_num, r.round_date, r.course_name,
     JSON.stringify(r.summary), r.total, r.total, r.toPar, r.round_date]
  );
  const roundId = rows[0].id;
  for (const h of r.holes) {
    await client.query(
      `INSERT INTO round_holes
         (round_id, hole_num, par, hcp, score, fw, gir, drive_dist, prox, putts,
          first_putt, three_putt, ud_att, ud_made, ss_att, ss_made, pen_strokes, score_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'manual')`,
      [roundId, h.hole_num, h.par, h.hcp, h.score, h.fw, h.gir, h.drive_dist, h.prox,
       h.putts, h.first_putt, h.three_putt, h.ud_att, h.ud_made, h.ss_att, h.ss_made, h.pen_strokes]
    );
  }
  return roundId;
}

// Seed (or re-seed) the demo players. Idempotent: existing demo rounds are
// deleted first, so re-running never duplicates.
async function seedDemo(pool) {
  const client = await pool.connect();
  const result = { players: [], rounds: 0 };
  try {
    await client.query('BEGIN');
    const password_hash = await bcrypt.hash('demo1234', 12);

    for (let i = 0; i < DEMO_PLAYERS.length; i++) {
      const p = DEMO_PLAYERS[i];
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, name, role, subscription_status, subscription_plan)
         VALUES ($1,$2,$3,'individual','active','individual')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [p.email, password_hash, p.name]
      );
      const userId = rows[0].id;
      // Wipe any prior demo rounds for this user (holes cascade).
      await client.query('DELETE FROM rounds WHERE user_id = $1', [userId]);

      const rounds = buildRounds(p, 1000 + i * 97);
      for (const r of rounds) await insertRound(client, userId, r);

      result.players.push({ name: p.name, email: p.email, rounds: rounds.length });
      result.rounds += rounds.length;
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Remove the demo players entirely (rounds + holes cascade via FK).
async function clearDemo(pool) {
  const { rowCount } = await pool.query(
    `DELETE FROM users WHERE email LIKE $1`, [`%@${DEMO_DOMAIN}`]
  );
  return { removedUsers: rowCount };
}

module.exports = { seedDemo, clearDemo, buildRounds, computeSummary, DEMO_PLAYERS, DEMO_DOMAIN };
