const { Pool } = require('pg');
const { seedMetrics } = require('../services/metrics');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const schema = `
  CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    admin_user_id INTEGER,
    stripe_customer_id VARCHAR(255),
    subscription_status VARCHAR(50) DEFAULT 'inactive',
    subscription_id VARCHAR(255),
    subscription_end_date TIMESTAMP,
    max_members INTEGER DEFAULT 15,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'individual',
    team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    stripe_customer_id VARCHAR(255),
    subscription_status VARCHAR(50) DEFAULT 'inactive',
    subscription_plan VARCHAR(50),
    subscription_id VARCHAR(255),
    subscription_end_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );

  ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

  CREATE TABLE IF NOT EXISTS invitations (
    id SERIAL PRIMARY KEY,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    player_name VARCHAR(255),
    tournament VARCHAR(255),
    round_num INTEGER DEFAULT 1,
    round_date DATE,
    course_name VARCHAR(255),
    rating DECIMAL(4,1),
    slope INTEGER,
    conditions VARCHAR(50),
    weather VARCHAR(50),
    round_notes TEXT,
    summary JSONB,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS round_holes (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id) ON DELETE CASCADE NOT NULL,
    hole_num INTEGER NOT NULL,
    par INTEGER DEFAULT 4,
    hcp INTEGER,
    score INTEGER,
    fw VARCHAR(10),
    gir VARCHAR(5),
    miss_dir VARCHAR(10),
    drive_dist INTEGER,
    prox DECIMAL(6,1),
    putts INTEGER,
    first_putt DECIMAL(5,1),
    three_putt BOOLEAN DEFAULT FALSE,
    ud_att BOOLEAN DEFAULT FALSE,
    ud_made BOOLEAN DEFAULT FALSE,
    ss_att BOOLEAN DEFAULT FALSE,
    ss_made BOOLEAN DEFAULT FALSE,
    pen_strokes INTEGER DEFAULT 0,
    notes TEXT,
    UNIQUE(round_id, hole_num)
  );

  CREATE INDEX IF NOT EXISTS idx_rounds_user_id ON rounds(user_id);
  CREATE INDEX IF NOT EXISTS idx_rounds_team_id ON rounds(team_id);
  CREATE INDEX IF NOT EXISTS idx_round_holes_round_id ON round_holes(round_id);

  -- ── Reconciliation layer ─────────────────────────────────────────────
  -- A round is ONE canonical record with two layers that can arrive in any
  -- order: an authoritative SCORE layer (owned by Scoreboard) and a STAT
  -- layer (owned by manual entry). Status reflects which layers are present
  -- and whether the totals agree.

  -- Identity (for deterministic matching to Scoreboard/Clippd)
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS clippd_tournament_id VARCHAR(64);
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS clippd_round_id      VARCHAR(64);
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS clippd_player_id     VARCHAR(64);
  -- Official (score-of-record) layer
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS official_score     INTEGER;
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS official_to_par    INTEGER;
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS official_finish    INTEGER;
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS official_posted_at TIMESTAMP;
  -- Derived / status
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS entered_score INTEGER;                     -- sum of hole scores present
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS has_official  BOOLEAN DEFAULT FALSE;
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS has_stats     BOOLEAN DEFAULT FALSE;
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS status        VARCHAR(16) DEFAULT 'stats_only'; -- score_only | stats_only | confirmed | conflict
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS resolution    VARCHAR(12);                       -- null | official | entered (manual adjudication of a conflict)

  -- Track where each hole's SCORE came from, so a later manual stat-edit
  -- never clobbers an authoritative Scoreboard score (and vice versa).
  ALTER TABLE round_holes ADD COLUMN IF NOT EXISTS score_source VARCHAR(12) DEFAULT 'manual'; -- manual | scoreboard

  -- One Clippd player identity maps to one local user. Set once, then every
  -- Scoreboard round auto-attaches to the right user.
  CREATE TABLE IF NOT EXISTS player_links (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    clippd_player_id VARCHAR(64) NOT NULL UNIQUE,
    school VARCHAR(255),
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_player_links_user_id ON player_links(user_id);

  -- Audit trail for score conflicts surfaced during reconciliation.
  CREATE TABLE IF NOT EXISTS reconciliation_log (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id) ON DELETE CASCADE NOT NULL,
    kind VARCHAR(32) NOT NULL,              -- score_conflict | resolved | merged_official | merged_stats
    detail JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_recon_log_round_id ON reconciliation_log(round_id);

  -- Deterministic match key: a user's round is unique per (tournament, round_num)
  -- once a Clippd tournament id is stamped. Manual rounds without a Clippd id are
  -- left unconstrained until they're linked.
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_round_match
    ON rounds(user_id, clippd_tournament_id, round_num)
    WHERE clippd_tournament_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_rounds_clippd_player ON rounds(clippd_player_id);
  CREATE INDEX IF NOT EXISTS idx_rounds_status ON rounds(status);

  -- ── Course catalog cache (external API pre-fill) ─────────────────────
  -- Course cards fetched from the external course database are cached here so
  -- a venue's scorecard (par / stroke index / yardage per tee) is pulled once
  -- and re-used for every round played there — keeps us inside the API's free
  -- daily quota and makes pre-fill instant on repeat courses.
  CREATE TABLE IF NOT EXISTS courses (
    id SERIAL PRIMARY KEY,
    source VARCHAR(24) NOT NULL DEFAULT 'golfcourseapi',
    external_id VARCHAR(64),
    club_name VARCHAR(255),
    course_name VARCHAR(255),
    location VARCHAR(255),
    raw JSONB,
    fetched_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(source, external_id)
  );

  CREATE TABLE IF NOT EXISTS course_tees (
    id SERIAL PRIMARY KEY,
    course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE NOT NULL,
    tee_name VARCHAR(64),
    gender VARCHAR(12),
    par_total INTEGER,
    yardage_total INTEGER,
    course_rating DECIMAL(4,1),
    slope_rating INTEGER,
    holes JSONB,                    -- [{hole, par, handicap, yardage}, ...]
    UNIQUE(course_id, gender, tee_name)
  );
  CREATE INDEX IF NOT EXISTS idx_course_tees_course_id ON course_tees(course_id);

  -- Per-hole yardage on the stat layer, pre-filled from the course catalog and
  -- player-editable. Stored so length-aware tendency analysis is possible later.
  ALTER TABLE round_holes ADD COLUMN IF NOT EXISTS yardage INTEGER;

  -- ===================================================================
  --  PHASE 0 - Canonical rankings foundation (additive; safe to re-run)
  --  Population-wide players/schools/seasons decoupled from app accounts,
  --  a metric registry, per-player-season stat profiles, and precomputed
  --  rank/percentile tables per segment. See RANKINGS_PLAN.md.
  -- ===================================================================

  CREATE TABLE IF NOT EXISTS seasons (
    id SERIAL PRIMARY KEY,
    label VARCHAR(20) NOT NULL UNIQUE,        -- e.g. '2025-26'
    starts_on DATE,
    ends_on DATE,
    is_current BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS schools (
    id SERIAL PRIMARY KEY,
    clippd_school_id VARCHAR(64) UNIQUE,      -- match key to Scoreboard
    name VARCHAR(255) NOT NULL,
    short_name VARCHAR(255),
    division VARCHAR(16),                     -- D1 | D2 | D3 | NAIA | NJCAA
    conference VARCHAR(255),
    region VARCHAR(64),
    gender VARCHAR(12),                       -- M | W (separate row per program)
    raw JSONB,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_schools_division ON schools(division);
  CREATE INDEX IF NOT EXISTS idx_schools_conference ON schools(conference);

  -- Canonical player - exists whether or not they ever become a subscriber.
  CREATE TABLE IF NOT EXISTS college_players (
    id SERIAL PRIMARY KEY,
    clippd_player_id VARCHAR(64) UNIQUE,      -- canonical match key to Scoreboard
    full_name VARCHAR(255) NOT NULL,
    current_school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL,
    gender VARCHAR(12),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- subscriber who IS this player, if any
    raw JSONB,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_college_players_school ON college_players(current_school_id);
  CREATE INDEX IF NOT EXISTS idx_college_players_user ON college_players(user_id);

  -- Per-season affiliation - the correct home for division/conference/class,
  -- so transfers and reclassifications are handled without rewriting history.
  CREATE TABLE IF NOT EXISTS player_seasons (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES college_players(id) ON DELETE CASCADE NOT NULL,
    season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE NOT NULL,
    school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL,
    division VARCHAR(16),
    conference VARCHAR(255),
    region VARCHAR(64),
    gender VARCHAR(12),
    class_year VARCHAR(16),                   -- FR | SO | JR | SR | GR
    UNIQUE(player_id, season_id)
  );
  CREATE INDEX IF NOT EXISTS idx_player_seasons_season ON player_seasons(season_id);
  CREATE INDEX IF NOT EXISTS idx_player_seasons_div_season ON player_seasons(division, season_id);

  -- Attach rounds to a canonical player (works for non-subscriber players too).
  -- user_id stays for app-entered rounds but is now nullable, so ingested
  -- population score-rows (no account) can live in the same reconciled table.
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS college_player_id INTEGER REFERENCES college_players(id) ON DELETE CASCADE;
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS season_id INTEGER REFERENCES seasons(id) ON DELETE SET NULL;
  ALTER TABLE rounds ALTER COLUMN user_id DROP NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_rounds_college_player ON rounds(college_player_id);
  CREATE INDEX IF NOT EXISTS idx_rounds_season ON rounds(season_id);
  -- Canonical dedup for ingested rounds, mirroring uniq_round_match.
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_round_canonical_match
    ON rounds(college_player_id, clippd_tournament_id, round_num)
    WHERE college_player_id IS NOT NULL AND clippd_tournament_id IS NOT NULL;

  -- Metric registry - every rankable stat is a row here (seeded from code).
  CREATE TABLE IF NOT EXISTS metrics (
    id SERIAL PRIMARY KEY,
    key VARCHAR(48) NOT NULL UNIQUE,          -- stable code, e.g. 'gir_pct'
    display_name VARCHAR(80) NOT NULL,
    category VARCHAR(32),                     -- scoring | tee | approach | short_game | putting | errors | summary
    unit VARCHAR(16),                         -- pct | strokes | count | feet | yards | ratio
    direction VARCHAR(6) NOT NULL DEFAULT 'higher',  -- higher | lower (which is better)
    decimals INTEGER DEFAULT 1,
    min_sample INTEGER DEFAULT 5,             -- rounds needed before a player is ranked
    rankable BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT NOW()
  );

  -- Per-player-season stat profile: one value + its sample size per metric.
  CREATE TABLE IF NOT EXISTS player_metric_season (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES college_players(id) ON DELETE CASCADE NOT NULL,
    season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE NOT NULL,
    metric_id INTEGER REFERENCES metrics(id) ON DELETE CASCADE NOT NULL,
    value DECIMAL(10,3),
    sample_n INTEGER DEFAULT 0,               -- rounds behind the value
    computed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(player_id, season_id, metric_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pms_metric_season ON player_metric_season(metric_id, season_id);
  CREATE INDEX IF NOT EXISTS idx_pms_player ON player_metric_season(player_id, season_id);

  -- Precomputed rankings: rank + percentile per (metric, season, segment).
  CREATE TABLE IF NOT EXISTS rankings (
    id SERIAL PRIMARY KEY,
    metric_id INTEGER REFERENCES metrics(id) ON DELETE CASCADE NOT NULL,
    season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE NOT NULL,
    segment_type VARCHAR(16) NOT NULL,        -- national | division | conference | region | gender | class_year
    segment_value VARCHAR(255) NOT NULL,      -- 'ALL' | 'D3' | conference | ...
    gender VARCHAR(12),                        -- 'M' | 'W' — rankings are gender-split
    player_id INTEGER REFERENCES college_players(id) ON DELETE CASCADE NOT NULL,
    value DECIMAL(10,3),
    rank INTEGER,
    percentile DECIMAL(5,2),
    sample_n INTEGER,                         -- the player's own sample
    cohort_n INTEGER,                         -- players in this ranked cohort
    computed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(metric_id, season_id, segment_type, segment_value, gender, player_id)
  );
  ALTER TABLE rankings ADD COLUMN IF NOT EXISTS gender VARCHAR(12);
  CREATE INDEX IF NOT EXISTS idx_rankings_lookup ON rankings(metric_id, season_id, segment_type, segment_value, gender, rank);
  CREATE INDEX IF NOT EXISTS idx_rankings_player ON rankings(player_id, season_id);

  -- ===================================================================
  --  PHASE 1 - Scoreboard catalog (event worklist + school universe)
  -- ===================================================================
  -- A school may be known by Clippd id (from competingSchools[]) before we
  -- have its name, so name is nullable and enriched later from tournament detail.
  ALTER TABLE schools ALTER COLUMN name DROP NOT NULL;

  CREATE TABLE IF NOT EXISTS tournaments (
    id SERIAL PRIMARY KEY,
    clippd_tournament_id VARCHAR(64) UNIQUE,
    name VARCHAR(255),
    season_id INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
    division VARCHAR(16),
    gender VARCHAR(12),
    conference VARCHAR(255),
    region VARCHAR(64),
    venue VARCHAR(255),
    host_clippd_id VARCHAR(64),
    host_name VARCHAR(255),
    starts_on DATE,
    ends_on DATE,
    planned_rounds INTEGER,
    has_results BOOLEAN DEFAULT FALSE,
    is_complete BOOLEAN DEFAULT FALSE,
    competing_school_ids JSONB,           -- ids only; names/rosters via detail
    raw JSONB,
    synced_at TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_tournaments_season ON tournaments(season_id);
  CREATE INDEX IF NOT EXISTS idx_tournaments_division ON tournaments(division);
  CREATE INDEX IF NOT EXISTS idx_tournaments_results ON tournaments(has_results) WHERE has_results;

  -- ===================================================================
  --  PHASE 1b - Team segmentation (coach signup captures division/school)
  -- ===================================================================
  ALTER TABLE teams ADD COLUMN IF NOT EXISTS division    VARCHAR(16);
  ALTER TABLE teams ADD COLUMN IF NOT EXISTS conference  VARCHAR(255);
  ALTER TABLE teams ADD COLUMN IF NOT EXISTS region      VARCHAR(64);
  ALTER TABLE teams ADD COLUMN IF NOT EXISTS school_id   INTEGER REFERENCES schools(id) ON DELETE SET NULL;
  ALTER TABLE teams ADD COLUMN IF NOT EXISTS school_name VARCHAR(255);
  ALTER TABLE teams ADD COLUMN IF NOT EXISTS gender      VARCHAR(12);
  CREATE INDEX IF NOT EXISTS idx_teams_division ON teams(division);

  -- ===================================================================
  --  PHASE 2 - Rankings compute (one canonical player per app user)
  -- ===================================================================
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_college_players_user
    ON college_players(user_id) WHERE user_id IS NOT NULL;

  -- ===================================================================
  --  PHASE 2c - Team stat rankings (program-level profiles + rankings)
  -- ===================================================================
  CREATE TABLE IF NOT EXISTS team_metric_season (
    id SERIAL PRIMARY KEY,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE NOT NULL,
    season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE NOT NULL,
    metric_id INTEGER REFERENCES metrics(id) ON DELETE CASCADE NOT NULL,
    value DECIMAL(10,3),
    sample_n INTEGER DEFAULT 0,
    computed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(team_id, season_id, metric_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tms_metric_season ON team_metric_season(metric_id, season_id);

  CREATE TABLE IF NOT EXISTS team_rankings (
    id SERIAL PRIMARY KEY,
    metric_id INTEGER REFERENCES metrics(id) ON DELETE CASCADE NOT NULL,
    season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE NOT NULL,
    segment_type VARCHAR(16) NOT NULL,
    segment_value VARCHAR(255) NOT NULL,
    gender VARCHAR(12),
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE NOT NULL,
    value DECIMAL(10,3),
    rank INTEGER,
    percentile DECIMAL(5,2),
    sample_n INTEGER,
    cohort_n INTEGER,
    computed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(metric_id, season_id, segment_type, segment_value, gender, team_id)
  );
  ALTER TABLE team_rankings ADD COLUMN IF NOT EXISTS gender VARCHAR(12);
  CREATE INDEX IF NOT EXISTS idx_team_rankings_lookup ON team_rankings(metric_id, season_id, segment_type, segment_value, gender, rank);
  CREATE INDEX IF NOT EXISTS idx_team_rankings_team ON team_rankings(team_id, season_id);
`;

async function initDB() {
  try {
    await pool.query(schema);
    const seededMetrics = await seedMetrics(pool);
    console.log(`✅ Database schema initialized (${seededMetrics} metrics)`);
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    throw err;
  }
}

module.exports = { pool, initDB };
