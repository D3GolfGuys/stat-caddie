const { Pool } = require('pg');

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
`;

async function initDB() {
  try {
    await pool.query(schema);
    console.log('✅ Database schema initialized');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    throw err;
  }
}

module.exports = { pool, initDB };
