/**
 * Server-side stat aggregation — mirrors public/js/pdfReports.js
 * computeSeason + statViewItems so profiles match what players see.
 * Input: rows with a `summary` JSONB per round (as stored on `rounds`).
 */
function computeSeason(rounds) {
  const s = rounds.map(r => r.summary).filter(Boolean);
  const sum = (a, k) => { let t = 0, any = false; a.forEach(x => { if (x && x[k] != null) { t += Number(x[k]); any = true; } }); return any ? t : null; };
  const avg = (a, k) => { const v = a.filter(x => x && x[k] != null); return v.length ? v.reduce((p, x) => p + Number(x[k]), 0) / v.length : null; };
  const maxOf = (a, k) => { let m = null; a.forEach(x => { if (x && x[k] != null) m = (m == null ? Number(x[k]) : Math.max(m, Number(x[k]))); }); return m; };

  const fwHit = sum(s, 'fwHit'), fwAtt = sum(s, 'fwAtt');
  const girHit = sum(s, 'girHit'), girHoles = 18 * s.length;
  const udAtt = sum(s, 'udAtt'), udMade = sum(s, 'udMade');
  const ssAtt = sum(s, 'ssAtt'), ssMade = sum(s, 'ssMade');
  const scores = s.map(x => x.totalScore).filter(v => v != null).map(Number);
  const n = rounds.length;
  return {
    rounds: n,
    tournaments: new Set(rounds.map(r => r.tournament).filter(Boolean)).size,
    scoringAvg: avg(s, 'totalScore'), vspar: avg(s, 'vspar'),
    best: scores.length ? Math.min.apply(null, scores) : null,
    par3Avg: avg(s, 'par3Avg'), par4Avg: avg(s, 'par4Avg'), par5Avg: avg(s, 'par5Avg'),
    par3GirPct: avg(s, 'par3GirPct'),
    eagles: sum(s, 'eagles'), birdies: sum(s, 'birdies'), pars: sum(s, 'pars'),
    bogeys: sum(s, 'bogeys'), doubles: sum(s, 'doubles'), worses: sum(s, 'worses'),
    fwPct: fwAtt ? fwHit / fwAtt * 100 : avg(s, 'fwPct'),
    girPct: girHoles ? girHit / girHoles * 100 : avg(s, 'girPct'), girHit,
    puttsPerRound: avg(s, 'puttsTotal'), puttsPerGir: avg(s, 'puttsPerGir'),
    onePutts: sum(s, 'onePutts'), threePutts: sum(s, 'threePutts'),
    scramblingPct: udAtt ? udMade / udAtt * 100 : null,
    ssPct: ssAtt ? ssMade / ssAtt * 100 : null,
    shortGamePct: (udAtt + ssAtt) ? (udMade + ssMade) / (udAtt + ssAtt) * 100 : null,
    penTotal: sum(s, 'penTotal'),
    driveAvg: avg(s, 'driveAvg'), driveMax: maxOf(s, 'driveMax'), proxAvg: avg(s, 'proxAvg'),
  };
}

// season aggregate -> { metric_key: value|null }, keyed to services/metrics.js.
function metricValues(season) {
  const per = v => (season.rounds && v != null) ? v / season.rounds : null;
  const g = season.girHit;
  return {
    scoring_avg: season.scoringAvg,
    vs_par_avg: season.vspar,
    low_round: season.best,
    par3_scoring: season.par3Avg,
    par4_scoring: season.par4Avg,
    par5_scoring: season.par5Avg,
    subpar_per_round: per((season.birdies || 0) + 2 * (season.eagles || 0)),
    birdies_per_round: per(season.birdies),
    pars_per_round: per(season.pars),
    bogeys_per_round: per(season.bogeys),
    doubles_per_round: per(season.doubles),
    others_per_round: per(season.worses),
    fairways_pct: season.fwPct,
    drive_avg: season.driveAvg,
    drive_long: season.driveMax,
    gir_pct: season.girPct,
    par3_gir_pct: season.par3GirPct,
    prox_avg: season.proxAvg,
    birdie_conversion: (g && season.birdies != null) ? season.birdies / g : null,
    putts_per_round: season.puttsPerRound,
    putts_per_gir: season.puttsPerGir,
    three_putts_per_round: per(season.threePutts),
    scrambling_pct: season.scramblingPct,
    sand_save_pct: season.ssPct,
    short_game_pct: season.shortGamePct,
    penalties_per_round: per(season.penTotal),
    rounds: season.rounds,
    tournaments: season.tournaments,
  };
}

module.exports = { computeSeason, metricValues };
