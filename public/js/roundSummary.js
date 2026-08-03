// Pure per-round summary from an array of hole objects. Mirrors
// statcaddie_capture.html computeSummary() field-for-field so that rounds
// edited in the admin console produce the SAME summary the dashboard,
// reports, and rankings read. Keep in sync with capture's computeSummary().
(function (g) {
  function num(v) { return (v === '' || v == null) ? null : (isNaN(+v) ? null : +v); }
  function yes(v) { return v === true || v === 'Y' || v === 'true' || v === 1 || v === '1'; }

  // holes: [{ par, score, fw, gir, drive_dist, prox, putts, three_putt,
  //           ud_att, ud_made, ss_att, ss_made, pen_strokes }]
  function computeRoundSummary(holes) {
    let totalScore = 0, totalPar = 0, fwHit = 0, fwAtt = 0, girHit = 0;
    let proxSum = 0, proxCnt = 0, puttsTotal = 0, puttsCnt = 0, puttsGirSum = 0, puttsGirCnt = 0;
    let onePutts = 0, threePutts = 0, driveSum = 0, driveCnt = 0, driveMax = 0;
    let udAtt = 0, udMade = 0, ssAtt = 0, ssMade = 0, penTotal = 0;
    let eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubles = 0, worses = 0, holesPlayed = 0;
    const par3s = [], par4s = [], par5s = [];
    const par3Gir = [0, 0], par4Gir = [0, 0], par5Gir = [0, 0];

    (holes || []).forEach(function (h) {
      const par = num(h.par) || 4, score = num(h.score), fw = (h.fw || ''), gir = (h.gir || '');
      const drive = num(h.drive_dist), prox = num(h.prox), putts = num(h.putts);
      const pen = num(h.pen_strokes) || 0;

      totalPar += par;
      if (par === 3) par3Gir[1]++; else if (par === 4) par4Gir[1]++; else par5Gir[1]++;

      if (score != null) {
        holesPlayed++; totalScore += score;
        const d = score - par;
        if (d <= -2) eagles++; else if (d === -1) birdies++; else if (d === 0) pars++;
        else if (d === 1) bogeys++; else if (d === 2) doubles++; else worses++;
        if (par === 3) par3s.push(score); else if (par === 4) par4s.push(score); else par5s.push(score);
      }
      if (fw === 'H') { fwHit++; fwAtt++; } else if (fw === 'L' || fw === 'R') fwAtt++;
      if (gir === 'Y') { girHit++; if (par === 3) par3Gir[0]++; else if (par === 4) par4Gir[0]++; else par5Gir[0]++; }
      if (drive != null && fw !== 'N/A' && fw !== '') { driveSum += drive; driveCnt++; if (drive > driveMax) driveMax = drive; }
      if (prox != null) { proxSum += prox; proxCnt++; }
      if (putts != null) { puttsTotal += putts; puttsCnt++; if (gir === 'Y') { puttsGirSum += putts; puttsGirCnt++; } if (putts === 1) onePutts++; }
      if (yes(h.three_putt)) threePutts++;
      if (yes(h.ud_att)) udAtt++; if (yes(h.ud_made)) udMade++;
      if (yes(h.ss_att)) ssAtt++; if (yes(h.ss_made)) ssMade++;
      penTotal += pen;
    });

    const r2 = function (v) { return Math.round(v * 100) / 100; };
    return {
      holesPlayed, totalScore, totalPar, vspar: totalScore - totalPar,
      fwHit, fwAtt, fwPct: fwAtt ? r2(fwHit / fwAtt * 100) : null,
      girHit, girPct: r2(girHit / 18 * 100),
      proxAvg: proxCnt ? r2(proxSum / proxCnt) : null,
      puttsTotal, puttsPerHole: puttsCnt ? r2(puttsTotal / puttsCnt) : null,
      puttsPerGir: puttsGirCnt ? r2(puttsGirSum / puttsGirCnt) : null,
      onePutts, threePutts,
      driveAvg: driveCnt ? Math.round(driveSum / driveCnt) : null, driveMax: driveMax || null,
      udAtt, udMade, scramblingPct: udAtt ? r2(udMade / udAtt * 100) : null,
      ssAtt, ssMade, ssPct: ssAtt ? r2(ssMade / ssAtt * 100) : null,
      penTotal, eagles, birdies, pars, bogeys, doubles, worses,
      par3Avg: par3s.length ? r2(par3s.reduce(function (a, b) { return a + b; }, 0) / par3s.length) : null,
      par4Avg: par4s.length ? r2(par4s.reduce(function (a, b) { return a + b; }, 0) / par4s.length) : null,
      par5Avg: par5s.length ? r2(par5s.reduce(function (a, b) { return a + b; }, 0) / par5s.length) : null,
      par3GirPct: par3Gir[1] ? r2(par3Gir[0] / par3Gir[1] * 100) : null,
      par4GirPct: par4Gir[1] ? r2(par4Gir[0] / par4Gir[1] * 100) : null,
      par5GirPct: par5Gir[1] ? r2(par5Gir[0] / par5Gir[1] * 100) : null,
    };
  }
  g.computeRoundSummary = computeRoundSummary;
})(window);
