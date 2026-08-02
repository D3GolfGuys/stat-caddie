#!/usr/bin/env node
/**
 * One-off / scheduled Scoreboard catalog sync.
 *   node scripts/sync-catalog.js
 * Requires DATABASE_URL and outbound network to scoreboard.clippd.com.
 * Env: CATALOG_MAX_PAGES (default 50).
 */
const { pool, initDB } = require('../db');
const catalog = require('../services/catalog');

(async () => {
  await initDB();
  console.log('Syncing Scoreboard catalog…');
  const summary = await catalog.syncCatalog(pool, {
    maxPages: Number(process.env.CATALOG_MAX_PAGES || 50),
  });
  console.log('Catalog sync complete:', summary);
  await pool.end();
})().catch(err => { console.error('Catalog sync failed:', err.message); process.exit(1); });
