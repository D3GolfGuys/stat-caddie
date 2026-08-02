/* Stat Caddie — client-side PDF reports (Golfstat "StatView" format)
 * ------------------------------------------------------------------
 * Modeled on the Golfstat StatView report (see statcaddie_report.html): a
 * header band, a summary strip, a Tournament Results table with per-round
 * scores, and a dense StatView stat grid — one page per player, with a team
 * overview page for the team report. Cross-school national/region/division
 * ranks from the real Golfstat report are omitted (the prototype flags them
 * "N/A in production"); we fill the layout with the stats we actually capture.
 *
 *   StatCaddiePDF.playerReport({ playerName, teamName, rounds })
 *   StatCaddiePDF.teamReport({ teamName, players:[{id,name,role}], rounds })
 * `rounds` carry `.summary` (the capture-page JSON) + round_date/tournament/
 * round_num. jsPDF + jspdf-autotable are loaded from CDN by the host page.
 */
(function () {
  const C = {
    dark: [21, 89, 47], green: [31, 122, 68], greenLight: [232, 243, 236],
    ink: [26, 43, 34], muted: [107, 124, 115], border: [210, 220, 213],
    pos: [192, 57, 43], neg: [31, 122, 68], rule: [200, 225, 208],
  };

  const fmt = {
    n2: v => (v == null || isNaN(v)) ? '—' : (Math.round(v * 100) / 100).toFixed(2),
    n1: v => (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10).toFixed(1),
    p3: v => (v == null || isNaN(v)) ? '—' : v.toFixed(3),
    int: v => (v == null || isNaN(v)) ? '—' : ('' + Math.round(v)),
    // rate percent -> Golfstat-style proportion, e.g. 67.1% -> ".671"
    frac: v => (v == null || isNaN(v)) ? '—' : (v / 100).toFixed(3).replace(/^0(?=\.)/, ''),
    vs: v => { if (v == null || isNaN(v)) return '—'; const r = Math.round(v * 10) / 10; return r === 0 ? 'E' : (r > 0 ? '+' + r : '' + r); },
  };
  const vsColor = v => (v == null) ? C.muted : (v < 0 ? C.neg : v > 0 ? C.pos : C.muted);

  const avg = (a, k) => { const v = a.filter(s => s && s[k] != null); return v.length ? v.reduce((x, b) => x + b[k], 0) / v.length : null; };
  const sum = (a, k) => { let t = 0, any = false; a.forEach(s => { if (s && s[k] != null) { t += s[k]; any = true; } }); return any ? t : null; };
  const maxOf = (a, k) => { let m = null; a.forEach(s => { if (s && s[k] != null) m = (m == null ? s[k] : Math.max(m, s[k])); }); return m; };

  function computeSeason(rounds) {
    const s = rounds.map(r => r.summary).filter(Boolean);
    const fwHit = sum(s, 'fwHit'), fwAtt = sum(s, 'fwAtt');
    const girHit = sum(s, 'girHit'), girHoles = 18 * s.length;
    const udAtt = sum(s, 'udAtt'), udMade = sum(s, 'udMade');
    const ssAtt = sum(s, 'ssAtt'), ssMade = sum(s, 'ssMade');
    const scores = s.map(x => x.totalScore).filter(v => v != null);
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
      scramblingPct: udAtt ? udMade / udAtt * 100 : null, udAtt, udMade,
      ssPct: ssAtt ? ssMade / ssAtt * 100 : null, ssAtt, ssMade,
      shortGamePct: (udAtt + ssAtt) ? (udMade + ssMade) / (udAtt + ssAtt) * 100 : null,
      penTotal: sum(s, 'penTotal'),
      driveAvg: avg(s, 'driveAvg'), driveMax: maxOf(s, 'driveMax'), proxAvg: avg(s, 'proxAvg'),
    };
  }

  // The StatView stat battery (label, value) — no cross-school ranks.
  function statViewItems(s) {
    const per = (v) => s.rounds ? v / s.rounds : null;
    return [
      ['Average Score', fmt.n2(s.scoringAvg)],
      ['Comp. to Par', fmt.vs(s.vspar)],
      ['Low Round', s.best != null ? s.best : '—'],
      ['Par 3 Scoring', fmt.n2(s.par3Avg)],
      ['Par 4 Scoring', fmt.n2(s.par4Avg)],
      ['Par 5 Scoring', fmt.n2(s.par5Avg)],
      ['Eagles', fmt.int(s.eagles)],
      ['Birdies', fmt.int(s.birdies)],
      ['Subpar Strokes/Rd', fmt.n2(per((s.birdies || 0) + 2 * (s.eagles || 0)))],
      ['Pars per Round', fmt.n2(per(s.pars))],
      ['Bogeys per Round', fmt.n2(per(s.bogeys))],
      ['Db. Bogeys/Rd', fmt.n2(per(s.doubles))],
      ['Other Scores/Rd', fmt.n2(per(s.worses))],
      ['Fairways Hit', fmt.frac(s.fwPct)],
      ['Bird Conversion', s.girHit ? fmt.p3(s.birdies / s.girHit).replace(/^0(?=\.)/, '') : '—'],
      ['GIR', fmt.frac(s.girPct)],
      ['Par 3 GIR', fmt.frac(s.par3GirPct)],
      ['Average Putts', fmt.n2(s.puttsPerRound)],
      ['Putts on GIR', s.puttsPerGir != null ? fmt.p3(s.puttsPerGir) : '—'],
      ['3 Putt Holes/Rd', fmt.n2(per(s.threePutts))],
      ['Non-Sand Up&Dn', fmt.frac(s.scramblingPct)],
      ['Sand Saves', fmt.frac(s.ssPct)],
      ['Total Short Game', fmt.frac(s.shortGamePct)],
      ['Avg Drive (yds)', s.driveAvg != null ? Math.round(s.driveAvg) : '—'],
      ['Long Drive (yds)', s.driveMax != null ? s.driveMax : '—'],
      ['Avg Prox (ft)', fmt.n1(s.proxAvg)],
      ['Penalties/Rd', fmt.n2(per(s.penTotal))],
    ];
  }

  function groupTournaments(rounds) {
    const md = d => d ? d.slice(5).replace('-', '/') : '';
    const map = new Map();
    rounds.forEach(r => { const k = r.tournament || '(no event)'; if (!map.has(k)) map.set(k, []); map.get(k).push(r); });
    const out = [];
    map.forEach((rs, name) => {
      rs.sort((a, b) => (a.round_num || 0) - (b.round_num || 0) || (a.round_date || '').localeCompare(b.round_date || ''));
      const dates = rs.map(r => r.round_date).filter(Boolean).sort();
      const dateStr = dates.length ? (md(dates[0]) + (dates.length > 1 && dates[dates.length - 1] !== dates[0] ? '–' + md(dates[dates.length - 1]) : '')) : '';
      const roundsStr = rs.map(r => { const su = r.summary || {}; return su.totalScore != null ? `${su.totalScore} (${fmt.vs(su.vspar)})` : '—'; }).join('   ');
      const total = rs.reduce((a, r) => a + ((r.summary && r.summary.totalScore) || 0), 0);
      out.push({ name, dateStr, roundsStr, total: total || '—', first: dates[0] || '' });
    });
    out.sort((a, b) => a.first.localeCompare(b.first));
    return out;
  }

  // ── drawing helpers ──────────────────────────────────────────────
  function ensureLib() {
    if (!window.jspdf || !window.jspdf.jsPDF) { alert('The PDF library did not load (check your connection) — please retry.'); return null; }
    return window.jspdf.jsPDF;
  }
  const W_ = doc => doc.internal.pageSize.getWidth();
  const H_ = doc => doc.internal.pageSize.getHeight();
  const safe = s => String(s || 'report').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');

  function pageHead(doc, meta) {
    const W = W_(doc);
    doc.setFillColor.apply(doc, C.dark); doc.rect(0, 0, W, 48, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text('STAT CADDIE', 40, 30);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(200, 220, 205);
    doc.text('STATVIEW REPORT', W - 40, 30, { align: 'right' });
    const y = 64;
    doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor.apply(doc, C.muted);
    doc.text(meta.l || '', 40, y);
    doc.setFont('helvetica', 'bold'); doc.setTextColor.apply(doc, C.dark); doc.text(meta.c || '', W / 2, y, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setTextColor.apply(doc, C.muted); doc.text(meta.r || '', W - 40, y, { align: 'right' });
    doc.setDrawColor.apply(doc, C.border); doc.setLineWidth(0.5); doc.line(40, y + 5, W - 40, y + 5);
    return y + 5;
  }
  function title(doc, y, name, tag) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor.apply(doc, C.dark);
    doc.text(String(name), 40, y);
    if (tag) {
      const w = doc.getTextWidth(String(name)), tw = doc.getTextWidth(tag) + 14, tx = 40 + w + 10, ty = y - 11;
      const teamTag = tag === 'TEAM';
      doc.setFillColor.apply(doc, teamTag ? C.green : C.greenLight); doc.roundedRect(tx, ty, tw, 15, 7, 7, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      doc.setTextColor.apply(doc, teamTag ? [255, 255, 255] : C.dark); doc.text(tag, tx + 7, ty + 10.5);
    }
  }
  function strip(doc, y, cells) {
    const W = W_(doc), m = 40, gap = 8, w = (W - 2 * m - gap * (cells.length - 1)) / cells.length;
    cells.forEach((c, i) => {
      const x = m + i * (w + gap);
      doc.setFillColor.apply(doc, C.greenLight); doc.roundedRect(x, y, w, 44, 6, 6, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor.apply(doc, c.color || C.dark);
      doc.text(String(c.val), x + w / 2, y + 22, { align: 'center' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor.apply(doc, C.muted);
      doc.text(c.lbl.toUpperCase(), x + w / 2, y + 35, { align: 'center' });
    });
    return y + 44;
  }
  function sec(doc, y, text) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor.apply(doc, C.green);
    doc.text(text.toUpperCase(), 40, y);
    doc.setDrawColor.apply(doc, C.rule); doc.setLineWidth(1.5); doc.line(40, y + 4, W_(doc) - 40, y + 4);
    doc.setLineWidth(0.5);
    return y + 16;
  }
  function grid(doc, y, items) {
    const W = W_(doc), H = H_(doc), m = 40, gap = 7, cols = 3, ch = 30;
    const cw = (W - 2 * m - gap * (cols - 1)) / cols;
    let col = 0;
    items.forEach(it => {
      if (col === 0 && y + ch > H - 42) { doc.addPage(); y = 46; }
      const x = m + col * (cw + gap);
      doc.setDrawColor.apply(doc, C.border); doc.setFillColor(252, 253, 252); doc.roundedRect(x, y, cw, ch, 4, 4, 'FD');
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.3); doc.setTextColor.apply(doc, C.muted);
      doc.text(String(it[0]).toUpperCase(), x + 8, y + 12);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor.apply(doc, C.ink);
      doc.text(String(it[1]), x + 8, y + 25);
      col++; if (col >= cols) { col = 0; y += ch + gap; }
    });
    return col === 0 ? y : y + ch + gap;
  }
  function stampFooters(doc) {
    const n = doc.internal.getNumberOfPages(), W = W_(doc), H = H_(doc);
    let today = ''; try { today = new Date().toLocaleDateString(); } catch (e) {}
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setDrawColor.apply(doc, C.border); doc.setLineWidth(0.5); doc.line(40, H - 28, W - 40, H - 28);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor.apply(doc, C.muted);
      doc.text('Generated by Stat Caddie', 40, H - 16);
      doc.text(`Page ${i} of ${n}${today ? '   ·   ' + today : ''}`, W - 40, H - 16, { align: 'right' });
    }
  }
  const metaFor = (teamName, kind) => ({ l: teamName || 'Individual', c: 'STAT CADDIE · STATVIEW', r: kind });

  // ── page composers ───────────────────────────────────────────────
  function drawPlayerPage(doc, { name, tag, meta, rounds }) {
    let y = pageHead(doc, meta) + 24;
    title(doc, y, name, tag); y += 14;
    const s = computeSeason(rounds);
    y = strip(doc, y, [
      { lbl: 'Tournaments', val: s.tournaments || '—' },
      { lbl: 'Rounds', val: s.rounds },
      { lbl: 'Avg Score', val: fmt.n2(s.scoringAvg) },
      { lbl: 'Vs Par', val: fmt.vs(s.vspar), color: vsColor(s.vspar) },
      { lbl: 'Low Round', val: s.best != null ? s.best : '—' },
    ]) + 18;
    y = sec(doc, y, 'Tournament Results');
    const g = groupTournaments(rounds);
    doc.autoTable({
      startY: y,
      head: [['Tournament', 'Dates', 'Rounds', 'Total']],
      body: g.length ? g.map(t => [t.name, t.dateStr, t.roundsStr, t.total])
                     : [[{ content: 'No rounds logged yet.', colSpan: 4, styles: { halign: 'center', textColor: C.muted } }]],
      theme: 'grid', styles: { fontSize: 8.5, cellPadding: 4 },
      headStyles: { fillColor: C.green, textColor: 255, fontSize: 8 },
      columnStyles: { 0: { halign: 'left', fontStyle: 'bold' }, 2: { halign: 'left' }, 3: { halign: 'right', fontStyle: 'bold' } },
      margin: { left: 40, right: 40 },
    });
    y = doc.lastAutoTable.finalY + 16;
    y = sec(doc, y, 'StatView');
    grid(doc, y, statViewItems(s));
  }

  function drawTeamPage(doc, { teamName, players, rounds }) {
    let y = pageHead(doc, metaFor(teamName, 'Team Report')) + 24;
    title(doc, y, teamName || 'Team', 'TEAM'); y += 14;
    const t = computeSeason(rounds);
    y = strip(doc, y, [
      { lbl: 'Players', val: players.length },
      { lbl: 'Tournaments', val: t.tournaments || '—' },
      { lbl: 'Rounds', val: rounds.length },
      { lbl: 'Avg Score', val: fmt.n2(t.scoringAvg) },
      { lbl: 'Vs Par', val: fmt.vs(t.vspar), color: vsColor(t.vspar) },
    ]) + 18;
    y = sec(doc, y, 'Roster & Leaderboard');
    const ranked = players.map(p => ({ p, s: computeSeason(rounds.filter(r => r.user_id === p.id)) }))
      .sort((a, b) => { const av = a.s.scoringAvg, bv = b.s.scoringAvg; if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1; return av - bv; });
    doc.autoTable({
      startY: y,
      head: [['#', 'Player', 'Rds', 'Avg', 'vs Par', 'FW', 'GIR', 'Putts', 'Scr']],
      body: ranked.length ? ranked.map((r, i) => [r.s.rounds ? (i + 1) : '–', r.p.name + (r.p.role === 'team_admin' ? ' (Coach)' : ''),
        r.s.rounds || '—', fmt.n2(r.s.scoringAvg), fmt.vs(r.s.vspar), fmt.frac(r.s.fwPct), fmt.frac(r.s.girPct), fmt.n1(r.s.puttsPerRound), fmt.frac(r.s.scramblingPct)])
        : [[{ content: 'No players yet.', colSpan: 9, styles: { halign: 'center', textColor: C.muted } }]],
      theme: 'grid', styles: { fontSize: 8.5, cellPadding: 4 },
      headStyles: { fillColor: C.dark, textColor: 255 },
      columnStyles: { 1: { halign: 'left', fontStyle: 'bold' }, 3: { fontStyle: 'bold' } },
      margin: { left: 40, right: 40 },
    });
    y = doc.lastAutoTable.finalY + 16;
    y = sec(doc, y, 'Team StatView');
    grid(doc, y, statViewItems(t));
  }

  // ── public API ───────────────────────────────────────────────────
  function playerReport({ playerName, teamName, rounds }) {
    const JsPDF = ensureLib(); if (!JsPDF) return;
    const doc = new JsPDF({ unit: 'pt', format: 'letter' });
    drawPlayerPage(doc, { name: playerName || 'Player', tag: null, meta: metaFor(teamName, 'Player Report'), rounds: rounds || [] });
    stampFooters(doc);
    doc.save(`StatCaddie_${safe(playerName)}_StatView.pdf`);
  }
  function teamReport({ teamName, players, rounds }) {
    const JsPDF = ensureLib(); if (!JsPDF) return;
    players = players || []; rounds = rounds || [];
    const doc = new JsPDF({ unit: 'pt', format: 'letter' });
    drawTeamPage(doc, { teamName, players, rounds });
    players.forEach((p, i) => {
      doc.addPage();
      drawPlayerPage(doc, {
        name: p.name, tag: p.role === 'team_admin' ? 'COACH' : null,
        meta: metaFor(teamName, `Player ${i + 1} of ${players.length}`),
        rounds: rounds.filter(r => r.user_id === p.id),
      });
    });
    stampFooters(doc);
    doc.save(`StatCaddie_${safe(teamName)}_Team_StatView.pdf`);
  }

  window.StatCaddiePDF = { computeSeason, statViewItems, playerReport, teamReport };
})();
