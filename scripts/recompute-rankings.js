#!/usr/bin/env node
/**
 * Recompute stat profiles + rankings from entered rounds.
 *   node scripts/recompute-rankings.js
 * Env: SEASON_LABEL (default 'current'). Run on a schedule (e.g. nightly).
 */
const { pool, initDB } = require('../db');
const rankings = require('../services/rankings');

(async () => {
  await initDB();
  const seasonLabel = process.env.SEASON_LABEL || 'current';
  console.log(`Recomputing rankings for season "${seasonLabel}"…`);
  const summary = await rankings.recompute(pool, { seasonLabel });
  console.log('Recompute complete:', summary);
  await pool.end();
})().catch(err => { console.error('Recompute failed:', err.message); process.exit(1); });
