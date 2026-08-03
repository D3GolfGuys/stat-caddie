#!/usr/bin/env node
/**
 * Seed a demo league (8 programs across divisions) and recompute rankings.
 *   node scripts/seed-league.js
 * Requires DATABASE_URL. Populates the public leaderboards + team rankings.
 */
const { pool, initDB } = require('../db');
const { seedLeague } = require('../services/demoSeed');
const rankings = require('../services/rankings');

(async () => {
  await initDB();
  console.log('Seeding demo league…');
  const seeded = await seedLeague(pool);
  const ranked = await rankings.recompute(pool, { seasonLabel: process.env.SEASON_LABEL || 'current' });
  console.log('Seeded:', seeded);
  console.log('Ranked:', ranked);
  await pool.end();
})().catch(err => { console.error('Seed league failed:', err.message); process.exit(1); });
