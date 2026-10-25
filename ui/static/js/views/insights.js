// Insights: Nutrition, Weight and Lifts tabs over a chosen range. Every chart
// carries the phase bands, and lines break across untracked windows.

import { session, loadDash, loadWorkouts } from "../api.js";
import { MACROS, commas, daysBetween, esc, exerciseHistory, fmtDate, fmtDay, kg, phaseOn, setLabel,
  shiftDate, signed, targetsFor, weekStart } from "../util.js";
import { mount, nutrientSummary, rangeStart, timeChart, weekBars } from "../charts.js";
import { nav } from "../nav.js";

const view = { range: "3m", weightMode: "kg", avgPhase: null };

export async function render(root, params) {
  const tab = params.route.split("/")[1];
  const dash = await loadDash();
  const today = session.today;
  const start = rangeStart(today, view.range);
  const ctx = { dash, today, start, phases: dash.phases || [] };

  root.innerHTML = `<div class="page">
    <div class="stats-line">
      <div class="seg show-mobile-flex">${["nutrition", "weight", "lifts"].map((t) =>
        `<a class="chip${t === tab ? " active" : ""}" href="#/insights/${t}">${t[0].toUpperCase() + t.slice(1)}</a>`).join("")}</div>
      <div class="spacer"></div>
      <div class="seg">${["1m", "3m", "6m", "1y"].map((r) => `<button class="chip${view.range === r ? " active" : ""}" data-range="${r}">${r}</button>`).join("")}</div>
    </div>
    <div class="stack" data-tab></div></div>`;
  root.querySelectorAll("[data-range]").forEach((b) => { b.onclick = () => { view.range = b.dataset.range; nav.refresh(); }; });

  const el = root.querySelector("[data-tab]");
  if (tab === "weight") renderWeight(el, ctx);
  else if (tab === "lifts") await renderLifts(el, ctx);
  else renderNutrition(el, ctx);
}

// ── nutrition ────────────────────────────────────────────────────────────────
function renderNutrition(el, { dash, today, start, phases }) {
  const defaults = dash.default_targets || {};
  const days = dash.days.filter((d) => d.date >= start && d.date <= today);

  // Daily target as a step line: phase targets, the defaults outside phases, a
  // break inside untracked windows.
  const targetPts = [];
  for (let d = start; d <= today; d = shiftDate(d, 1)) {
    const t = targetsFor(phases, d, defaults);
    targetPts.push({ date: d, v: t ? (t.calories ?? null) : null });
  }

  // Averages only mean something against one set of targets, so they're per
  // phase: pick from the phases visible in the chart's window. Each phase's
  // figures cover the whole phase to date (the server's phase summary).
  const inRange = phases.filter((ph) => ph.kind === "phase" && ph.start <= today && (ph.end || "9999") >= start)
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  if (!inRange.some((ph) => ph.id === view.avgPhase)) {
    view.avgPhase = (phaseOn(inRange, today) || inRange[inRange.length - 1])?.id || null;
  }
  const sel = inRange.find((ph) => ph.id === view.avgPhase) || null;

  let avgCard;
  if (sel) {
    const s = sel.summary || { averages: {}, tracked_count: 0, adherence: null };
    const tg = sel.targets || {};
    const n = s.tracked_count;
    avgCard = `<div class="card-title">Phase averages</div>
      <div class="seg">${inRange.map((ph) => `<button class="chip${ph.id === sel.id ? " active" : ""}" data-avg-phase="${ph.id}">
        <span class="dot" style="background:${esc(ph.colour)}"></span> ${esc(ph.name)}</button>`).join("")}</div>
      <div class="mut">${esc(fmtDate(sel.start, { day: "numeric", month: "short", year: "numeric" }))} – ${
        sel.end && sel.end < today ? esc(fmtDate(sel.end, { day: "numeric", month: "short", year: "numeric" })) : "now"} · ${n} tracked ${n === 1 ? "day" : "days"}</div>
      <div class="kv-line"><span class="big">${n ? commas(s.averages.calories) : "—"}</span><span class="mut">kcal / day${tg.calories ? ` · target ${commas(tg.calories)}` : ""}</span></div>
      ${nutrientSummary(n ? s.averages : {}, tg, undefined, { oneCol: true })}
      <div class="mut">${s.adherence != null ? `<b>${Math.round(s.adherence * 100)}%</b> of days within 10% of the calorie target` : "This phase has no calorie target."}</div>`;
  } else {
    // No phase in view: every day here uses the default targets.
    const completed = new Set(dash.days.filter((d) => d.completed).map((d) => d.date));
    const tracked = days.filter((d) => (d.date !== today || completed.has(d.date)) && targetsFor(phases, d.date, defaults) !== null);
    const avgs = Object.fromEntries(["calories", ...MACROS].map((k) =>
      [k, tracked.length ? tracked.reduce((sum, d) => sum + (d.totals[k] || 0), 0) / tracked.length : 0]));
    avgCard = `<div class="card-title">Averages · default targets</div>
      <div class="mut">No phase in this window · ${tracked.length} tracked ${tracked.length === 1 ? "day" : "days"}</div>
      <div class="kv-line"><span class="big">${tracked.length ? commas(avgs.calories) : "—"}</span><span class="mut">kcal / day${defaults.calories ? ` · target ${commas(defaults.calories)}` : ""}</span></div>
      ${nutrientSummary(tracked.length ? avgs : {}, defaults, undefined, { oneCol: true })}`;
  }

  el.innerHTML = `
    <div class="grid-detail wide-first">
      <div class="card"><div class="card-title">Calories vs target</div><div class="chart-box" data-cal></div>
        <div class="legend"><span class="mut"><span class="dot" style="background:var(--n-calories)"></span>Daily kcal</span>
          <span class="mut"><span class="dash-swatch"></span>Target</span></div></div>
      <div class="card">${avgCard}
        <div class="mut faint">Today counts once it's marked complete; untracked days never count.</div></div>
    </div>`;

  el.querySelectorAll("[data-avg-phase]").forEach((b) => {
    b.onclick = () => { view.avgPhase = b.dataset.avgPhase; renderNutrition(el, { dash, today, start, phases }); };
  });

  mount(el.querySelector("[data-cal]"), timeChart({
    start, end: today, phases, height: 220, zero: true, label: "Calories versus target",
    series: [
      { color: "var(--ink)", width: 1.4, dash: "4 3", step: true, points: targetPts },
      { color: "var(--n-calories)", width: 2, dots: true, points: days.map((d) => ({ date: d.date, v: d.totals.calories || 0 })) },
    ],
    readout: (d) => {
      const day = days.find((x) => x.date === d);
      const t = targetsFor(phases, d, defaults);
      const ph = phaseOn(phases, d);
      return `<span>${esc(fmtDay(d))}${ph ? " · " + esc(ph.name || "untracked") : ""}</span>${
        day ? `<b>${commas(day.totals.calories || 0)} kcal</b>` : '<span class="placeholder">nothing logged</span>'}${
        t?.calories ? `<span>target ${commas(t.calories)}</span>` : ""}`;
    },
  }));
}

// ── weight ───────────────────────────────────────────────────────────────────
function renderWeight(el, { dash, today, start, phases }) {
  const weights = dash.weights || [];
  const height = dash.height_cm;
  const bmiMode = view.weightMode === "bmi" && height;
  const conv = (v) => (bmiMode ? v / ((height / 100) ** 2) : v);
  const stats = dash.weight_stats;
  const latest = weights[weights.length - 1];

  // One point per day (the day's last weigh-in) and a trailing 7-day average.
  const byDay = new Map();
  for (const w of weights) byDay.set(w.datetime.slice(0, 10), w.kg);
  const daily = [...byDay.entries()].map(([date, v]) => ({ date, v }));
  const rolling = daily.map((pt) => {
    const win = daily.filter((x) => x.date > shiftDate(pt.date, -7) && x.date <= pt.date);
    return { date: pt.date, v: win.reduce((s, x) => s + x.v, 0) / win.length };
  });

  // Planned rate for the active phase, drawn from its start weight.
  const active = phaseOn(phases, today);
  let planned = [];
  if (active?.kind === "phase" && active.goal_rate_kg_wk != null) {
    const base = rolling.find((r) => r.date >= active.start) || rolling[rolling.length - 1];
    if (base) {
      const end = active.end || shiftDate(today, 28);
      planned = [{ date: base.date, v: base.v }, { date: end, v: base.v + (active.goal_rate_kg_wk / 7) * daysBetween(base.date, end) }];
    }
  }
  const goal = active?.kind === "phase" ? active.goal_kg : null;
  const avg7 = rolling.length ? rolling[rolling.length - 1].v : null;
  const toGoal = goal != null && avg7 != null ? avg7 - goal : null;
  const rate = stats?.weekly_rate;
  const eta = toGoal != null && rate && Math.sign(rate) === -Math.sign(toGoal) ? Math.abs(toGoal / rate) : null;

  el.innerHTML = `
    <div class="card">
      <div class="kv-line"><span class="big">${latest ? (bmiMode ? conv(latest.kg).toFixed(1) : kg(latest.kg)) : "—"}</span>
        <span class="mut">${bmiMode ? "BMI" : "kg"}</span><span class="spacer"></span>
        ${rate != null ? `<span class="${rate < 0 ? "gr" : "mut"} strong">${signed(rate, 2)} kg / wk</span>` : ""}
        ${height ? `<div class="seg"><button class="chip${!bmiMode ? " active" : ""}" data-mode="kg">kg</button><button class="chip${bmiMode ? " active" : ""}" data-mode="bmi">BMI</button></div>` : ""}</div>
      <div class="chart-box" data-w></div>
      <div class="legend"><span class="mut"><span class="dot" style="background:var(--guide)"></span>Weigh-ins</span>
        <span class="mut"><span class="dot" style="background:var(--ink)"></span>7-day average</span>
        ${planned.length ? '<span class="mut"><span class="dash-swatch tc"></span>Planned rate</span>' : ""}</div>
    </div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">7-day avg</div><div class="v">${avg7 != null ? kg(avg7) : "—"}</div></div>
      <div class="kpi"><div class="lbl">Weekly change</div><div class="v">${rate != null ? signed(rate, 2) : "—"}</div></div>
      <div class="kpi"><div class="lbl">Maint. est.</div><div class="v">${stats?.maintenance_est ? commas(stats.maintenance_est) : "—"}</div></div>
      <div class="kpi"><div class="lbl">To goal</div><div class="v">${toGoal != null ? kg(Math.abs(toGoal)) + " kg" : "—"}</div></div>
      <div class="kpi"><div class="lbl">ETA</div><div class="v">${eta != null ? "~" + Math.ceil(eta) + " wks" : "—"}</div></div>
      <div class="kpi"><div class="lbl">BMI</div><div class="v">${dash.bmi ?? (height ? "—" : '<a class="small" href="#/profiles">set height</a>')}</div></div>
    </div>
    ${stats && stats.n < 7 ? '<div class="mut">Trend and maintenance estimate are provisional until there are ~7–14 weigh-ins.</div>' : ""}`;

  mount(el.querySelector("[data-w]"), timeChart({
    start, end: planned.length ? (planned[1].date > today ? planned[1].date : today) : today,
    phases, height: 230, label: "Weight over time", empty: "No weigh-ins in this range.",
    yFmt: (v) => v.toFixed(1),
    series: [
      { color: "var(--guide)", width: 1.4, dots: true, points: daily.map((x) => ({ date: x.date, v: conv(x.v) })) },
      { color: "var(--ink)", width: 2.4, points: rolling.map((x) => ({ date: x.date, v: conv(x.v) })) },
      ...(planned.length ? [{ color: "var(--terracotta)", width: 1.6, dash: "5 4", points: planned.map((x) => ({ date: x.date, v: conv(x.v) })) }] : []),
    ],
    readout: (d) => {
      const w = byDay.get(d), r = rolling.find((x) => x.date === d);
      return `<span>${esc(fmtDay(d))}</span>${w != null ? `<b>${(bmiMode ? conv(w).toFixed(1) : kg(w))} ${bmiMode ? "BMI" : "kg"}</b>` : '<span class="placeholder">no weigh-in</span>'}${
        r ? `<span>7-day avg ${bmiMode ? conv(r.v).toFixed(1) : kg(r.v)}</span>` : ""}`;
    },
  }));
  el.querySelectorAll("[data-mode]").forEach((b) => { b.onclick = () => { view.weightMode = b.dataset.mode; nav.refresh(); }; });
}

// ── lifts ────────────────────────────────────────────────────────────────────
async function renderLifts(el, { today, start, phases }) {
  const workouts = await loadWorkouts();
  const inRange = workouts.filter((w) => w.date >= start && w.date <= today);
  const counts = {};
  for (const w of inRange) counts[weekStart(w.date)] = (counts[weekStart(w.date)] || 0) + 1;

  const active = phaseOn(phases, today);
  const phaseStart = active?.kind === "phase" ? active.start : null;
  const ids = [...new Set(inRange.flatMap((w) => (w.exercises || []).map((e) => e.exercise_id)))];
  const lifts = ids.map((id) => {
    const hist = exerciseHistory(workouts, id);
    const last = hist[hist.length - 1];
    const sincePhase = phaseStart ? hist.filter((r) => r.date >= phaseStart && r.kg != null) : [];
    const change = sincePhase.length >= 2 ? sincePhase[sincePhase.length - 1].kg - sincePhase[0].kg : null;
    return { id, name: last.workout.exercises.find((e) => e.exercise_id === id)?.name || "", last, change, sessions: hist.length };
  }).sort((a, b) => b.sessions - a.sessions);

  el.innerHTML = `
    <div class="card"><div class="card-title">Workouts per week</div><div class="chart-box" data-bars></div></div>
    <div class="card list"><div class="card-title">Key lifts · top set${phaseStart ? " · change since phase start" : ""}</div>
      ${lifts.map((l) => `<a class="row row-btn" href="#/training/exercises/${l.id}">
        <span class="num grow">${esc(l.name)}</span><span class="mut">${esc(setLabel(l.last))}</span>
        ${l.change != null ? `<span class="chip ${l.change > 0 ? "up" : l.change < 0 ? "down" : ""}">${signed(l.change)} kg</span>` : ""}
        <span class="mut">›</span></a>`).join("") || '<div class="empty">No lifts logged in this range.</div>'}
    </div>`;
  mount(el.querySelector("[data-bars]"), weekBars({ start, end: today, counts, phases }));
}

