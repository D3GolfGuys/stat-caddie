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
const { findOrCreateSchool } = require('./schools');

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

// ── Demo TEAM ──────────────────────────────────────────────────────────────
// A whole team (coach + roster) so the coach dashboard has real spread to show.
// Uses the same DEMO_DOMAIN so clearDemo() sweeps it up too. Login for any of
// these is the shared demo password below.
const DEMO_TEAM_NAME = 'Demo University Golf';
const DEMO_COACH = { name: 'Coach Alex Rivera', email: `coach@${DEMO_DOMAIN}` };

// Five players spanning strong → developing so the leaderboard has a clear order.
const TEAM_PLAYERS = [
  { name: 'Jordan Miles',  email: `jordan@${DEMO_DOMAIN}`,
    parBias: -0.05, parJitter: 0.85, fwProb: 0.70, girProb: 0.66, driveBase: 298, putts1Prob: 0.46, scramProb: 0.64, sandProb: 0.55, penProb: 0.04 },
  { name: 'Sam Rivera',    email: `sam@${DEMO_DOMAIN}`,
    parBias: 0.20,  parJitter: 0.95, fwProb: 0.64, girProb: 0.60, driveBase: 288, putts1Prob: 0.40, scramProb: 0.58, sandProb: 0.50, penProb: 0.06 },
  { name: 'Taylor Quinn',  email: `taylor@${DEMO_DOMAIN}`,
    parBias: 0.45,  parJitter: 1.05, fwProb: 0.58, girProb: 0.52, driveBase: 279, putts1Prob: 0.34, scramProb: 0.50, sandProb: 0.42, penProb: 0.08 },
  { name: 'Drew Parker',   email: `drew@${DEMO_DOMAIN}`,
    parBias: 0.70,  parJitter: 1.15, fwProb: 0.54, girProb: 0.46, driveBase: 272, putts1Prob: 0.30, scramProb: 0.45, sandProb: 0.36, penProb: 0.11 },
  { name: 'Cameron Lee',   email: `cameron@${DEMO_DOMAIN}`,
    parBias: 0.90,  parJitter: 1.30, fwProb: 0.48, girProb: 0.40, driveBase: 265, putts1Prob: 0.26, scramProb: 0.40, sandProb: 0.30, penProb: 0.14 },
];

// ── Demo LEAGUE ────────────────────────────────────────────────────────────
// A whole league across divisions so the leaderboards + team rankings show real
// spread. Every user is under DEMO_DOMAIN so clearDemo() sweeps it; each demo
// team name ends in " (demo)".
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function playerProfile(name, email, skill) {
  return { name, email,
    parBias: skill, parJitter: 0.85 + Math.max(0, skill) * 0.3,
    fwProb:  clamp(0.72 - skill * 0.15, 0.42, 0.75),
    girProb: clamp(0.68 - skill * 0.17, 0.36, 0.70),
    driveBase: Math.round(300 - skill * 32),
    putts1Prob: clamp(0.46 - skill * 0.11, 0.24, 0.48),
    scramProb: clamp(0.64 - skill * 0.15, 0.36, 0.66),
    sandProb:  clamp(0.55 - skill * 0.13, 0.28, 0.56),
    penProb:   clamp(0.04 + Math.max(0, skill) * 0.07, 0.03, 0.16),
  };
}
const LEAGUE = [
  { school: 'Stanford',        division: 'D1',   conference: 'ACC',    gender: 'M', base: -0.10 },
  { school: 'Vanderbilt',      division: 'D1',   conference: 'SEC',    gender: 'W', base: -0.08 },
  { school: 'Emory',           division: 'D3',   conference: 'UAA',    gender: 'M', base: -0.06 },
  { school: 'Lynn',            division: 'D2',   conference: 'SSC',    gender: 'M', base: -0.05 },
  { school: 'Williams',        division: 'D3',   conference: 'NESCAC', gender: 'M', base: -0.03 },
  { school: 'Keiser',          division: 'NAIA', conference: 'Sun',    gender: 'W', base: -0.02 },
  { school: 'Lincoln College', division: 'D3',   conference: 'SCAC',   gender: 'W', base:  0.00 },
  { school: 'Rockford',        division: 'D3',   conference: 'NACC',   gender: 'W', base:  0.02 },
];
const FIRST = ['Jordan','Sam','Taylor','Drew','Cameron','Alex','Riley','Casey','Morgan','Quinn','Avery','Reese','Parker','Hayden','Emerson','Rowan','Skylar','Micah','Devin','Elliot'];
const LAST  = ['Miles','Rivera','Quinn','Parker','Lee','Brooks','Hayes','Nguyen','Patel','Sato','Kim','Diaz','Foster','Reed','Cole','Grant','Shaw','Boone','Vance','Pierce'];


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
  // Anchor demo rounds inside the CURRENT academic year (season opens Aug 1) so
  // they appear on the current-year-only leaderboard. Spread oldest->newest across
  // however much of the season has elapsed; clamped so nothing predates the opener.
  const seasonStart = new Date(today.getMonth() >= 7 ? today.getFullYear() : today.getFullYear() - 1, 7, 1);
  const spanDays = Math.max(0, Math.round((today - seasonStart) / 86400000));
  for (let k = 0; k < 5; k++) {
    const meta = COURSES[k % COURSES.length];
    const holes = generateHoles(player, rnd);
    const summary = computeSummary(holes);
    // k=0 oldest (near the opener), k=4 newest (near today), all within the season window.
    const d = new Date(today);
    d.setDate(d.getDate() - (spanDays > 0 ? Math.round(spanDays * (4 - k) / 4) : 0));
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

// Seed (or re-seed) a full demo TEAM: one coach (team_admin) + a roster of
// players (team_member), each with statted rounds. Idempotent on email — the
// coach and players are upserted and their rounds replaced, never duplicated.
// Returns the shared login so the caller can surface it.
async function seedTeam(pool) {
  const client = await pool.connect();
  const result = { team: DEMO_TEAM_NAME, coachEmail: DEMO_COACH.email, password: 'demo1234', players: [], rounds: 0 };
  try {
    await client.query('BEGIN');
    const password_hash = await bcrypt.hash('demo1234', 12);

    // 1) Coach (team_admin).
    const { rows: cRows } = await client.query(
      `INSERT INTO users (email, password_hash, name, role, subscription_status, subscription_plan)
       VALUES ($1,$2,$3,'team_admin','active','team')
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role='team_admin',
         subscription_status='active', subscription_plan='team'
       RETURNING id`,
      [DEMO_COACH.email, password_hash, DEMO_COACH.name]
    );
    const coachId = cRows[0].id;

    // 2) Team — reuse the coach's existing team if present, else create it.
    let teamId;
    const { rows: tExist } = await client.query('SELECT id FROM teams WHERE admin_user_id=$1', [coachId]);
    if (tExist.length) {
      teamId = tExist[0].id;
      await client.query(`UPDATE teams SET name=$1, subscription_status='active', max_members=15, division='D3', conference='SCAC', gender='M', school_name='Demo University' WHERE id=$2`, [DEMO_TEAM_NAME, teamId]);
    } else {
      const { rows: tRows } = await client.query(
        `INSERT INTO teams (name, admin_user_id, subscription_status, max_members, division, conference, gender, school_name)
         VALUES ($1,$2,'active',15,'D3','SCAC','M','Demo University') RETURNING id`,
        [DEMO_TEAM_NAME, coachId]
      );
      teamId = tRows[0].id;
    }
    await client.query('UPDATE users SET team_id=$1 WHERE id=$2', [teamId, coachId]);

    // 3) Players (team_member) with rounds.
    for (let i = 0; i < TEAM_PLAYERS.length; i++) {
      const p = TEAM_PLAYERS[i];
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, name, role, team_id, subscription_status, subscription_plan)
         VALUES ($1,$2,$3,'team_member',$4,'active','team')
         ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role='team_member', team_id=EXCLUDED.team_id
         RETURNING id`,
        [p.email, password_hash, p.name, teamId]
      );
      const uid = rows[0].id;
      await client.query('DELETE FROM rounds WHERE user_id=$1', [uid]);
      const rounds = buildRounds(p, 5000 + i * 131);
      for (const r of rounds) await insertRound(client, uid, r);
      result.players.push({ name: p.name, email: p.email, rounds: rounds.length });
      result.rounds += rounds.length;
    }

    await client.query('COMMIT');
    return { ...result, teamId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Seed (or re-seed) a demo LEAGUE: 8 programs across divisions, coach + 5
// players each with statted rounds, divisions set. Idempotent on email; caller
// should recompute rankings afterward. Everything is under DEMO_DOMAIN.
async function seedLeague(pool) {
  const client = await pool.connect();
  const result = { teams: 0, players: 0, rounds: 0, programs: [] };
  try {
    await client.query('BEGIN');
    const password_hash = await bcrypt.hash('demo1234', 12);
    for (let t = 0; t < LEAGUE.length; t++) {
      const prog = LEAGUE[t];
      const { rows: cRows } = await client.query(
        `INSERT INTO users (email,password_hash,name,role,subscription_status,subscription_plan)
         VALUES ($1,$2,$3,'team_admin','active','team')
         ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role='team_admin', subscription_status='active', subscription_plan='team'
         RETURNING id`,
        [`coach_t${t}@${DEMO_DOMAIN}`, password_hash, `Coach ${prog.school}`]);
      const coachId = cRows[0].id;
      const schoolId = await findOrCreateSchool(client, { name: prog.school, division: prog.division, conference: prog.conference });
      const teamName = `${prog.school} ${prog.gender === 'W' ? 'Women' : 'Men'} (demo)`;
      let teamId;
      const { rows: tExist } = await client.query('SELECT id FROM teams WHERE admin_user_id=$1', [coachId]);
      if (tExist.length) {
        teamId = tExist[0].id;
        await client.query(
          `UPDATE teams SET name=$1, subscription_status='active', max_members=15, division=$2, conference=$3, school_id=$4, school_name=$5, gender=$6 WHERE id=$7`,
          [teamName, prog.division, prog.conference, schoolId, prog.school, prog.gender, teamId]);
      } else {
        const { rows: tRows } = await client.query(
          `INSERT INTO teams (name,admin_user_id,subscription_status,max_members,division,conference,school_id,school_name,gender)
           VALUES ($1,$2,'active',15,$3,$4,$5,$6,$7) RETURNING id`,
          [teamName, coachId, prog.division, prog.conference, schoolId, prog.school, prog.gender]);
        teamId = tRows[0].id;
      }
      await client.query('UPDATE users SET team_id=$1 WHERE id=$2', [teamId, coachId]);
      for (let i = 0; i < 5; i++) {
        const skill = prog.base + i * 0.05;
        const name = `${FIRST[(t * 5 + i) % FIRST.length]} ${LAST[(t * 7 + i) % LAST.length]}`;
        const email = `t${t}p${i}@${DEMO_DOMAIN}`;
        const p = playerProfile(name, email, skill);
        const { rows } = await client.query(
          `INSERT INTO users (email,password_hash,name,role,team_id,subscription_status,subscription_plan)
           VALUES ($1,$2,$3,'team_member',$4,'active','team')
           ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role='team_member', team_id=EXCLUDED.team_id
           RETURNING id`,
          [email, password_hash, name, teamId]);
        const uid = rows[0].id;
        await client.query('DELETE FROM rounds WHERE user_id=$1', [uid]);
        const rounds = buildRounds(p, 20000 + t * 1000 + i * 131);
        for (const r of rounds) await insertRound(client, uid, r);
        result.players++; result.rounds += rounds.length;
      }
      result.teams++;
      result.programs.push({ school: prog.school, division: prog.division });
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

// Remove the demo players (individuals + team) entirely. Rounds + holes cascade
// via FK; the orphaned demo team row is removed by name afterwards.
async function clearDemo(pool) {
  const { rowCount } = await pool.query(
    `DELETE FROM users WHERE email LIKE $1`, [`%@${DEMO_DOMAIN}`]
  );
  const { rowCount: teamsRemoved } = await pool.query(
    `DELETE FROM teams WHERE name=$1 OR name LIKE '% (demo)'`, [DEMO_TEAM_NAME]
  );
  return { removedUsers: rowCount, removedTeams: teamsRemoved };
}

module.exports = { seedDemo, seedTeam, seedLeague, clearDemo, buildRounds, computeSummary, playerProfile, DEMO_PLAYERS, TEAM_PLAYERS, LEAGUE, DEMO_DOMAIN, DEMO_TEAM_NAME, DEMO_COACH };
