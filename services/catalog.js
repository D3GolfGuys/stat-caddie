/**
 * Scoreboard catalog ingestion.
 * -----------------------------
 * Builds the identity + structure scaffold from Clippd's tournament list
 * (GET /api/tournaments): seasons, the tournament worklist, and schools.
 * This is the "frame" — player rosters and official scores come from
 * tournament DETAIL / leaderboards (Phase 1b), not from this endpoint.
 *
 * Confirmed list shape (2026-08): { results:[ t ], size, lastSortValue }
 *   t.tournamentId, tournamentName, gender ('Men'|'Women'), division,
 *   startDate, endDate, venue, hostId, hostName, hostConference, hostRegion,
 *   season (int), plannedRounds, numRounds, hasResults, isComplete,
 *   competingSchools: [ '<schoolId>', ... ]   // ids only; names via detail
 */
const scoreboard = require('./scoreboard');

const normGender = g => {
  if (!g) return null;
  const s = String(g).toLowerCase();
  if (s.startsWith('m')) return 'M';
  if (s.startsWith('w') || s.startsWith('f')) return 'W';
  return null;
};

async function upsertSeason(pool, seasonVal) {
  if (seasonVal == null || seasonVal === '') return null;
  const { rows } = await pool.query(
    `INSERT INTO seasons (label) VALUES ($1)
     ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label
     RETURNING id`, [String(seasonVal)]);
  return rows[0].id;
}

// Upsert a school by Clippd id. COALESCE ensures a bare competing-id row never
// clobbers a known name (and a host row backfills the name once available).
async function upsertSchool(pool, x) {
  if (x.clippd_school_id == null) return null;
  const { rows } = await pool.query(
    `INSERT INTO schools (clippd_school_id, name, division, conference, region, gender)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (clippd_school_id) DO UPDATE SET
       name       = COALESCE(EXCLUDED.name, schools.name),
       division   = COALESCE(EXCLUDED.division, schools.division),
       conference = COALESCE(EXCLUDED.conference, schools.conference),
       region     = COALESCE(EXCLUDED.region, schools.region),
       gender     = COALESCE(EXCLUDED.gender, schools.gender)
     RETURNING id`,
    [String(x.clippd_school_id), x.name || null, x.division || null,
     x.conference || null, x.region || null, x.gender || null]);
  return rows[0].id;
}

async function upsertTournament(pool, t, seasonId) {
  const competing = Array.isArray(t.competingSchools) ? t.competingSchools.map(String) : [];
  await pool.query(
    `INSERT INTO tournaments
       (clippd_tournament_id, name, season_id, division, gender, conference, region,
        venue, host_clippd_id, host_name, starts_on, ends_on, planned_rounds,
        has_results, is_complete, competing_school_ids, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, NOW())
     ON CONFLICT (clippd_tournament_id) DO UPDATE SET
       name=EXCLUDED.name, season_id=EXCLUDED.season_id, division=EXCLUDED.division,
       gender=EXCLUDED.gender, conference=EXCLUDED.conference, region=EXCLUDED.region,
       venue=EXCLUDED.venue, host_clippd_id=EXCLUDED.host_clippd_id, host_name=EXCLUDED.host_name,
       starts_on=EXCLUDED.starts_on, ends_on=EXCLUDED.ends_on, planned_rounds=EXCLUDED.planned_rounds,
       has_results=EXCLUDED.has_results, is_complete=EXCLUDED.is_complete,
       competing_school_ids=EXCLUDED.competing_school_ids, raw=EXCLUDED.raw, synced_at=NOW()`,
    [String(t.tournamentId), t.tournamentName || null, seasonId, t.division || null,
     normGender(t.gender), t.hostConference || null, t.hostRegion || null, t.venue || null,
     t.hostId != null ? String(t.hostId) : null, t.hostName || null,
     t.startDate || null, t.endDate || null,
     (t.plannedRounds != null ? t.plannedRounds : (t.numRounds != null ? t.numRounds : null)),
     !!t.hasResults, !!t.isComplete, JSON.stringify(competing), JSON.stringify(t)]);
  return competing;
}

// Ingest ONE tournament object -> season, tournament, host + competing schools.
async function ingestTournament(pool, t) {
  const seasonId = await upsertSeason(pool, t.season);
  const competing = await upsertTournament(pool, t, seasonId);
  const schoolIds = [];
  if (t.hostId != null) {
    await upsertSchool(pool, {
      clippd_school_id: t.hostId, name: t.hostName, division: t.division,
      conference: t.hostConference, region: t.hostRegion, gender: normGender(t.gender),
    });
    schoolIds.push(String(t.hostId));
  }
  for (const id of competing) {
    await upsertSchool(pool, { clippd_school_id: id, division: t.division, gender: normGender(t.gender) });
    schoolIds.push(id);
  }
  return { season: t.season != null ? String(t.season) : null, schoolIds };
}

// Default paged fetch over the live list endpoint. NOTE: the search_after
// cursor param name is unconfirmed; override `cursorParam` once verified.
async function defaultFetchPage(cursor, { cursorParam = 'lastSortValue' } = {}) {
  const qs = cursor ? `${cursorParam}=${encodeURIComponent(JSON.stringify(cursor))}` : '';
  const data = await scoreboard.fetchTournaments(qs);
  return { results: (data && data.results) || [], lastSortValue: data && data.lastSortValue };
}

// Page through the whole catalog and ingest every tournament. Idempotent.
async function syncCatalog(pool, opts = {}) {
  const { fetchPage = defaultFetchPage, maxPages = 50 } = opts;
  const seasons = new Set(), schools = new Set();
  let cursor = null, pages = 0, tournaments = 0, errors = 0;
  for (let p = 0; p < maxPages; p++) {
    const page = await fetchPage(cursor);
    const rows = (page && page.results) || [];
    if (!rows.length) break;
    for (const t of rows) {
      try {
        const r = await ingestTournament(pool, t);
        tournaments++;
        if (r.season) seasons.add(r.season);
        r.schoolIds.forEach(id => schools.add(id));
      } catch (e) { errors++; }
    }
    pages++;
    cursor = page.lastSortValue;
    if (!cursor) break;
  }
  return { pages, tournaments, seasons: seasons.size, schools: schools.size, errors };
}

module.exports = {
  syncCatalog, ingestTournament, upsertSeason, upsertSchool, upsertTournament,
  normGender, defaultFetchPage,
};
