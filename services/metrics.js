/**
 * College Golf Metrics — canonical metric registry.
 * -------------------------------------------------
 * Every stat the platform ranks is declared here, mirroring the battery
 * computed in public/js/pdfReports.js (computeSeason / statViewItems).
 *   key        stable code used everywhere (never rename once shipped)
 *   direction  'lower' or 'higher' — which way is BETTER (drives rank order)
 *   min_sample rounds a player needs before being ranked on this metric
 * Rows are upserted into the `metrics` table on boot, so editing this list
 * updates config in place. `summary` metrics are context only (rankable:false).
 */

// [key, display_name, category, unit, direction, decimals, min_sample]
const METRICS = [
  ['scoring_avg',          'Scoring Average',         'scoring',    'strokes', 'lower',  2, 5],
  ['vs_par_avg',           'Average vs Par',          'scoring',    'strokes', 'lower',  2, 5],
  ['low_round',            'Low Round',               'scoring',    'strokes', 'lower',  0, 5],
  ['par3_scoring',         'Par 3 Scoring Avg',       'scoring',    'strokes', 'lower',  2, 5],
  ['par4_scoring',         'Par 4 Scoring Avg',       'scoring',    'strokes', 'lower',  2, 5],
  ['par5_scoring',         'Par 5 Scoring Avg',       'scoring',    'strokes', 'lower',  2, 5],
  ['subpar_per_round',     'Subpar Strokes / Round',  'scoring',    'count',   'higher', 2, 5],
  ['birdies_per_round',    'Birdies / Round',         'scoring',    'count',   'higher', 2, 5],
  ['pars_per_round',       'Pars / Round',            'scoring',    'count',   'higher', 2, 5],
  ['bogeys_per_round',     'Bogeys / Round',          'scoring',    'count',   'lower',  2, 5],
  ['doubles_per_round',    'Double Bogeys / Round',   'scoring',    'count',   'lower',  2, 5],
  ['others_per_round',     'Other (3+) / Round',      'scoring',    'count',   'lower',  2, 5],
  ['fairways_pct',         'Fairways Hit %',          'tee',        'pct',     'higher', 1, 5],
  ['drive_avg',            'Avg Drive (yds)',         'tee',        'yards',   'higher', 0, 5],
  ['drive_long',           'Longest Drive (yds)',     'tee',        'yards',   'higher', 0, 5],
  ['gir_pct',              'GIR %',                   'approach',   'pct',     'higher', 1, 5],
  ['par3_gir_pct',         'Par 3 GIR %',             'approach',   'pct',     'higher', 1, 5],
  ['prox_avg',             'Avg Proximity (ft)',      'approach',   'feet',    'lower',  1, 5],
  ['birdie_conversion',    'Birdie Conversion',       'approach',   'ratio',   'higher', 3, 5],
  ['putts_per_round',      'Putts / Round',           'putting',    'strokes', 'lower',  2, 5],
  ['putts_per_gir',        'Putts per GIR',           'putting',    'strokes', 'lower',  3, 5],
  ['three_putts_per_round','3-Putts / Round',         'putting',    'count',   'lower',  2, 5],
  ['scrambling_pct',       'Scrambling %',            'short_game', 'pct',     'higher', 1, 5],
  ['sand_save_pct',        'Sand Save %',             'short_game', 'pct',     'higher', 1, 5],
  ['short_game_pct',       'Total Short Game %',      'short_game', 'pct',     'higher', 1, 5],
  ['penalties_per_round',  'Penalties / Round',       'errors',     'count',   'lower',  2, 5],
  // Context only — not ranked (sample size / participation)
  ['rounds',               'Rounds Played',           'summary',    'count',   'higher', 0, 0],
  ['tournaments',          'Tournaments',             'summary',    'count',   'higher', 0, 0],
];

async function seedMetrics(pool) {
  let order = 0;
  for (const [key, name, category, unit, direction, decimals, minSample] of METRICS) {
    order += 10;
    const rankable = category !== 'summary';
    await pool.query(
      `INSERT INTO metrics (key, display_name, category, unit, direction, decimals, min_sample, rankable, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (key) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         category     = EXCLUDED.category,
         unit         = EXCLUDED.unit,
         direction    = EXCLUDED.direction,
         decimals     = EXCLUDED.decimals,
         min_sample   = EXCLUDED.min_sample,
         rankable     = EXCLUDED.rankable,
         sort_order   = EXCLUDED.sort_order`,
      [key, name, category, unit, direction, decimals, minSample, rankable, order]
    );
  }
  return METRICS.length;
}

module.exports = { METRICS, seedMetrics };
