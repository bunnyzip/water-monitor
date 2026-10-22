// ===== Firebase-driven data builder for water-monitor =====
// Synthesizes the same schema the old PC logger pushed as data.json,
// computed client-side from the battery ESP's tank feed (60s resolution).
// 1% of tank = 19.5 L (1950 L at 100%).

function buildDataFromFirebase(latest, hist) {
  const L = 19.5;                       // liters per percent
  const CAP = 1950;
  const nowS = Math.floor(Date.now() / 1000);
  const dkey = ts => { const d = new Date(ts * 1000); return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const hOfDay = ts => new Date(ts * 1000).getHours();

  // clean history: sorted, finite levels
  const hs = hist.filter(h => h && h.ts && h.lvl !== undefined && isFinite(h.lvl))
                 .sort((a, b) => a.ts - b.ts);

  // ---- per-hour usage (level drops = water consumed) + fills (rises = pump) ----
  const usage = {};   // day -> [24] liters used
  let cycles = [], gaps = 0, glitches = 0, biggestGlitch = 0;
  let cyc = null;
  for (let i = 1; i < hs.length; i++) {
    const a = hs[i - 1], b = hs[i];
    const dt = b.ts - a.ts;
    if (dt <= 0 || dt > 900) {          // >15 min gap = logging gap / reboot
      if (cyc) { cycles.push(cyc); cyc = null; }
      gaps++;
      continue;
    }
    const diff = b.lvl - a.lvl;
    if (Math.abs(diff) > 25) {          // impossible jump = sensor glitch
      glitches++;
      biggestGlitch = Math.max(biggestGlitch, Math.abs(diff));
      continue;
    }
    const k = dkey(b.ts), h = hOfDay(b.ts);
    if (!usage[k]) usage[k] = { hours: Array(24).fill(0), cnt: Array(24).fill(0) };
    if (diff < -0.05) {                 // level dropped -> consumption
      usage[k].hours[h] += (-diff) * L;
    } else if (diff > 0.3) {            // level rose -> pump filling
      if (!cyc) cyc = { s: a.ts, l0: a.lvl, peak: b.lvl, e: b.ts, l1: b.lvl };
      else { cyc.e = b.ts; cyc.l1 = Math.max(cyc.l1, b.lvl); cyc.peak = Math.max(cyc.peak, b.lvl); }
    } else if (cyc && b.ts - cyc.e > 180) {   // flat >3 min after a fill -> cycle over
      cycles.push(cyc); cyc = null;
    }
  }
  if (cyc) cycles.push(cyc);

  cycles = cycles.map(c => {
    const dur = Math.max(1, Math.round((c.e - c.s) / 60));
    const dl = c.l1 - c.l0;
    const liters = Math.max(0, dl) * L;
    return { s: c.s, e: c.e, dur, l0: c.l0, l1: c.l1, dl, liters,
             abn: liters > 700 || dl < 3 || dur > 90 };
  });

  // ---- days ----
  const days = Object.keys(usage).sort().slice(-7).map(k => {
    const total = usage[k].hours.reduce((s, v) => s + v, 0);
    return { date: k, total: Math.round(total), hours: usage[k].hours.map(v => Math.round(v)) };
  });

  // ---- today / avg hour ----
  const today = days.length ? { hours: days[days.length - 1].hours.map((v, i) => usage[Object.keys(usage).sort().slice(-1)[0]].cnt[i] ? v : null), total: days[days.length - 1].total } : { hours: Array(24).fill(null), total: 0 };
  const nDays = days.length || 1;
  const avg_hour = Array(24).fill(null).map((_, h) => {
    let sum = 0, cnt = 0;
    days.forEach(d => { if (d.hours[h] > 0 || usageHas(d)) { sum += d.hours[h]; cnt++; } });
    function usageHas(dd) { return true; }
    return cnt ? Math.round(sum / cnt) : null;
  });

  // ---- 48h level series (5-min downsample) ----
  const cutoff48 = nowS - 48 * 3600;
  const h48 = hs.filter(h => h.ts >= cutoff48);
  const series = [];
  let lastT = 0;
  h48.forEach(h => {
    if (h.ts - lastT >= 300) { series.push([new Date(h.ts * 1000).toISOString(), h.lvl]); lastT = h.ts; }
  });

  // ---- fills stats ----
  const normal = cycles.filter(c => !c.abn);
  const avgFillMin = normal.length ? Math.round(normal.reduce((s, c) => s + c.dur, 0) / normal.length) : 0;
  const avgFillL = normal.length ? Math.round(normal.reduce((s, c) => s + c.liters, 0) / normal.length) : 0;
  const fastest = normal.slice().sort((a, b) => (a.dur / Math.max(1, a.liters)) - (b.dur / Math.max(1, b.liters)))[0];
  const longest = normal.slice().sort((a, b) => b.dur - a.dur)[0];
  const fmtC = c => c ? (new Date(c.s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " — " + c.dur + " min, " + Math.round(c.liters) + " L") : "—";

  // ---- night vs day usage L/h ----
  let night = 0, nightC = 0, day = 0, dayC = 0;
  avg_hour.forEach((v, h) => {
    if (v === null) return;
    if (h >= 22 || h < 6) { night += v; nightC++; } else { day += v; dayC++; }
  });

  // ---- peak hour ----
  let peakH = 0, peakV = -1;
  avg_hour.forEach((v, h) => { if (v !== null && v > peakV) { peakV = v; peakH = h; } });

  // ---- busiest day ----
  const busy = days.slice().sort((a, b) => b.total - a.total)[0];

  // ---- span / coverage ----
  const span = hs.length > 1 ? hs[hs.length - 1].ts - hs[0].ts : 0;
  const expected = Math.max(1, Math.round(span / 60));
  const coverage = Math.min(100, Math.round(hs.length / expected * 100));

  const cyclesOut = cycles.slice(-12).reverse().map(c => ({
    start: new Date(c.s * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    end: new Date(c.e * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    dur: c.dur, l0: Math.round(c.l0 * 10) / 10, l1: Math.round(c.l1 * 10) / 10,
    dl: Math.round(c.dl * 10) / 10, liters: Math.round(c.liters), abn: c.abn
  }));

  return {
    updated: new Date(nowS * 1000).toISOString(),
    updated_epoch: latest && latest.ts ? latest.ts : (hs.length ? hs[hs.length - 1].ts : 0),
    tank: {
      level: latest ? latest.lvl : 0,
      liters: Math.round((latest ? latest.lvl : 0) * L),
      pump: latest ? latest.pump : "OFF",
      capacity_l: CAP,
      age_min: latest && latest.ts ? Math.round((nowS - latest.ts) / 60) : 999
    },
    today: today,
    days: days,
    series: series,
    summary: { readings: hs.length, cycles: cycles.length, coverage: coverage, reboots: gaps },
    avg_hour: avg_hour,
    key: {
      peak_hour: peakH, peak_l: peakV,
      cycles: cycles.length, normal: normal.length, abn: cycles.length - normal.length,
      avg_fill_min: avgFillMin, avg_fill_l: avgFillL,
      night_lh: nightC ? Math.round(night / nightC) : 0,
      day_lh: dayC ? Math.round(day / dayC) : 0,
      sanity_l: days.length ? Math.round(days.reduce((s, d) => s + d.total, 0) / days.length) : 0
    },
    health: {
      reboots: gaps,
      shed_min: 0,
      coverage: coverage,
      monitored_h: Math.round(span / 3600),
      span_h: Math.round(span / 3600),
      gaps: gaps,
      biggest_gap_h: 0,
      age_min: latest && latest.ts ? Math.round((nowS - latest.ts) / 60) : 999
    },
    records: {
      fastest: fmtC(fastest),
      longest: fmtC(longest),
      glitch: glitches ? biggestGlitch.toFixed(1) + "% jump (ignored)" : "none 🎉",
      busy: busy ? new Date(busy.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " — " + busy.total.toLocaleString() + " L" : "—"
    },
    cycles: cyclesOut
  };
}
