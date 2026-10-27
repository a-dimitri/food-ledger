// Exercises: the shared catalogue (search + muscle filter, with this profile's
// latest top set) and one exercise's history — chart with phase bands, best
// set, estimated 1RM, sessions, change this phase.

import { session, loadDash, loadExercises, loadHistory, loadWorkouts } from "../api.js";
import { DEFAULT_FORMULA, FORMULAS, MUSCLE_GROUPS, cap, daysBetween, e1rmLabel, esc, exerciseHistory, fmtDay, phaseOn, setLabel, signed } from "../util.js";
import { mount, rangeStart, timeChart } from "../charts.js";
import { openExerciseForm } from "../workout-form.js";
import { isMobile, nav } from "../nav.js";

const view = { query: "", group: "all", range: "6m", metric: null };   // metric null: the exercise's default

export async function render(root, params) {
  const [catalogue, workouts, dash] = await Promise.all([loadExercises(), loadWorkouts(), loadDash()]);
  const latest = (id) => { const h = exerciseHistory(workouts, id); return h[h.length - 1] || null; };
  const selectedId = params.id || null;
  const selected = catalogue.find((e) => e.id === selectedId) || null;

  const listHtml = () => {
    const n = view.query.trim().toLowerCase();
    const items = catalogue.filter((e) => (view.group === "all" || e.muscle_group === view.group) && (!n || e.name.toLowerCase().includes(n)));
    return items.map((e) => `<a class="row row-btn${e.id === selectedId && !isMobile() ? " sel" : ""}" href="#/training/exercises/${e.id}">
        <span class="grow"><span class="num">${esc(e.name)}</span><span class="mut sub">${esc(cap(e.equipment))} · ${esc(e.muscle_group)}</span></span>
        <span class="mut">${esc(setLabel(latest(e.id)))}</span></a>`).join("")
      || `<div class="empty">${catalogue.length ? "No exercises match." : "The catalogue is empty — add one with ＋ New."}</div>`;
  };

  const head = `<div class="stats-line wrap">
      <input class="box search" data-q type="search" placeholder="⌕ Search exercises…" value="${esc(view.query)}" autocomplete="off">
      <div class="seg">${["all", ...MUSCLE_GROUPS].map((g) => `<button class="chip${view.group === g ? " active" : ""}" data-group="${g}">${cap(g)}</button>`).join("")}</div>
      <div class="spacer"></div><button class="pill fill" data-new>＋ New</button></div>`;

  if (isMobile() && selected) {
    root.innerHTML = `<div class="page"><div class="card detail" data-detail></div></div>`;
  } else {
    root.innerHTML = `<div class="page">${head}
      <div class="grid-detail list-first">
        <div class="card list" data-list>${listHtml()}</div>
        <div class="card detail hide-mobile" data-detail>${selected ? "" : '<div class="empty">Select an exercise to see its history.</div>'}</div>
      </div></div>`;
    root.querySelector("[data-q]").oninput = (e) => { view.query = e.target.value; root.querySelector("[data-list]").innerHTML = listHtml(); };
    root.querySelectorAll("[data-group]").forEach((b) => { b.onclick = () => { view.group = b.dataset.group; nav.refresh(); }; });
    root.querySelector("[data-new]").onclick = () => openExerciseForm();
  }
  if (selected) await renderDetail(root.querySelector("[data-detail]"), selected, dash);
}

async function renderDetail(el, ex, dash) {
  const data = await loadHistory(ex.id);
  const hist = data.history || [];
  const phases = dash.phases || [];
  const today = session.today;
  const start = rangeStart(today, view.range);
  const shown = hist.filter((r) => r.date >= start);
  // Bodyweight lifts chart the added-load 1RM, or the total including bodyweight.
  const bw = ex.equipment === "bodyweight";
  const formula = ex.e1rm_formula || DEFAULT_FORMULA;
  // Name the formula only when it isn't the default, to keep labels short.
  const fLabel = formula === DEFAULT_FORMULA ? "" : ` · ${FORMULAS[formula].label}`;
  const metrics = bw ? [["e1rm", "Est. 1RM"], ["total", "Total 1RM"]] : [["kg", "Top set"], ["e1rm", "Est. 1RM"]];
  const metric = metrics.some(([m]) => m === view.metric) ? view.metric : metrics[0][0];
  const value = (r) => (metric === "e1rm" ? r.e1rm : metric === "total" ? r.e1rm_total : r.kg);

  el.innerHTML = `<div class="detail-head"><div class="grow"><div class="h2">${esc(ex.name)}</div>
      <div class="mut">${esc(cap(ex.equipment))} · ${esc(ex.muscle_group)}${esc(fLabel)}</div></div>
      <button class="ic" data-edit aria-label="Edit exercise">✎</button></div>
    <div class="seg">${["3m", "6m", "1y"].map((r) => `<button class="chip${view.range === r ? " active" : ""}" data-range="${r}">${r}</button>`).join("")}
      <span class="spacer"></span>
      ${metrics.map(([m, label]) => `<button class="chip${metric === m ? " active" : ""}" data-metric="${m}">${label}</button>`).join("")}</div>
    <div class="chart-box" data-chart></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Best set</div><div class="v">${esc(setLabel(data.best))}</div></div>
      <div class="kpi"><div class="lbl">Est. 1RM${bw ? " (added)" : ""}</div><div class="v">${esc(e1rmLabel(data.best))}</div></div>
      <div class="kpi"><div class="lbl">Sessions</div><div class="v">${data.sessions}</div></div>
      <div class="kpi"><div class="lbl">This phase</div><div class="v ${data.change_this_phase > 0 ? "gr" : ""}">${data.change_this_phase != null ? signed(data.change_this_phase) + " kg" : "—"}</div></div>
    </div>
    <div class="list">${[...hist].reverse().slice(0, 12).map((r) => `<a class="row row-btn" href="#/training/workouts/${r.workout_id}">
        <span class="mut w60">${esc(fmtDay(r.date))}</span><span class="num grow">${esc(setLabel(r))}</span>
        <span class="mut">${r.e1rm != null ? "e1RM " + esc(e1rmLabel(r)) : ""}</span></a>`).join("") || '<div class="empty">Not logged by this profile yet.</div>'}</div>`;

  mount(el.querySelector("[data-chart]"), timeChart({
    start, end: today, phases, height: 180, label: `${ex.name} history`,
    empty: "No sessions in this range.",
    series: [{ color: "var(--ink)", width: 2.2, dots: true, points: shown.map((r) => ({ date: r.date, v: value(r) })) }],
    yFmt: (v) => (bw && metric !== "total" && v > 0 ? "+" : "") + Math.round(v),
    // Sessions are sparse, so snap to the nearest one rather than the exact day.
    readout: (d) => {
      const r = shown.reduce((best, x) =>
        (!best || Math.abs(daysBetween(x.date, d)) < Math.abs(daysBetween(best.date, d)) ? x : best), null);
      if (!r) return '<span class="placeholder">no sessions</span>';
      const ph = phaseOn(phases, r.date);
      return `<span>${esc(fmtDay(r.date))}${ph?.kind === "phase" ? " · " + esc(ph.name) : ""}</span><b>${esc(setLabel(r))}</b>${
        r.e1rm != null ? `<span>e1RM ${esc(e1rmLabel(r))}${bw ? ` · total ${esc(e1rmLabel(r, { total: true }))}` : ""}</span>` : ""}${
        bw && r.bodyweight != null ? `<span>at ${r.bodyweight} kg</span>` : ""}`;
    },
  }));
  el.querySelectorAll("[data-range]").forEach((b) => { b.onclick = () => { view.range = b.dataset.range; renderDetail(el, ex, dash); }; });
  el.querySelectorAll("[data-metric]").forEach((b) => { b.onclick = () => { view.metric = b.dataset.metric; renderDetail(el, ex, dash); }; });
  el.querySelector("[data-edit]").onclick = () => openExerciseForm(ex);
}
