// History: a month calendar (tinted by phase, kcal per day, a dot on workout
// days) and the selected day's summary beside it.

import { session, loadDash, loadWorkouts } from "../api.js";
import { commas, esc, fmtDate, fmtMonth, kg, parseISO, phaseOn, shiftDate, shiftMonths, targetsFor, toISO } from "../util.js";
import { nutrientSummary } from "../charts.js";
import { showDate } from "./today.js";
import { nav } from "../nav.js";

let month = null;      // any date inside the shown month
let picked = null;

export async function render(root) {
  month = month || session.today;
  picked = picked || session.today;
  const [dash, workouts] = await Promise.all([loadDash(), loadWorkouts()]);
  const phases = dash.phases || [];
  const byDate = Object.fromEntries((dash.days || []).map((d) => [d.date, d]));
  const workoutsOn = {};
  for (const w of workouts) (workoutsOn[w.date] ||= []).push(w);

  const first = parseISO(month); first.setDate(1);
  const firstISO = toISO(first);
  const lead = (first.getDay() + 6) % 7;     // Monday-first grid
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push("<span></span>");
  for (let n = 1; n <= daysInMonth; n++) {
    const d = shiftDate(firstISO, n - 1);
    const ph = phaseOn(phases, d);
    const kcal = byDate[d]?.totals?.calories;
    const cls = ["cal-cell"];
    if (d > session.today) cls.push("future");
    if (d === session.today) cls.push("today");
    if (d === picked) cls.push("picked");
    const tint = ph && ph.kind === "phase" ? `style="--tint:${esc(ph.colour || "#c05f3e")}"` : "";
    cells.push(`<button class="${cls.join(" ")}${tint ? " tinted" : ""}" ${tint} data-day="${d}">
      <b>${n}</b><span>${kcal ? commas(kcal) : ""}${workoutsOn[d] ? '<i class="wdot"></i>' : ""}</span></button>`);
  }

  // Legend: phases that touch this month.
  const monthEnd = shiftDate(shiftMonths(firstISO, 1), -1);
  const inMonth = phases.filter((p) => p.kind === "phase" && p.start <= monthEnd && (p.end || "9999") >= firstISO);

  root.innerHTML = `<div class="page">
    <div class="grid-detail">
      <div class="card">
        <div class="month-head">
          <button class="pill sq" data-month="-1" aria-label="Previous month">‹</button>
          <span class="h2">${esc(fmtMonth(firstISO))}</span>
          <button class="pill sq" data-month="1" aria-label="Next month">›</button>
        </div>
        <div class="cal-grid cal-dow">${["M", "T", "W", "T", "F", "S", "S"].map((x) => `<span class="lbl">${x}</span>`).join("")}</div>
        <div class="cal-grid">${cells.join("")}</div>
        <div class="legend">${inMonth.map((p) => `<span class="mut"><span class="swatch-sm" style="background:${esc(p.colour)}"></span>${esc(p.name)}</span>`).join("")}
          <span class="mut"><i class="wdot"></i> workout</span><span class="mut">numbers are kcal</span></div>
      </div>
      <div class="card" data-detail></div>
    </div>
  </div>`;

  const paintDetail = () => {
    const d = picked;
    const day = byDate[d];
    const ph = phaseOn(phases, d);
    const targets = targetsFor(phases, d, dash.default_targets) || {};
    const ws = (dash.weights || []).filter((w) => w.datetime.slice(0, 10) === d);
    const wos = workoutsOn[d] || [];
    root.querySelector("[data-detail]").innerHTML = `
      <div class="detail-head"><span class="h2">${esc(fmtDate(d))}</span><span class="spacer"></span>
        ${ph ? `<span class="phase-tag" style="background:${ph.kind === "untracked" ? "var(--untracked-ink)" : esc(ph.colour)}">${esc(ph.name || "Untracked")}</span>` : ""}</div>
      ${day ? `<div class="kv-line"><span class="big">${commas(day.totals.calories || 0)}</span><span class="mut">${targets.calories ? `of ${commas(targets.calories)} kcal` : "kcal"}</span></div>
        ${nutrientSummary(day.totals, targets, ["protein", "carbs", "fat"], { oneCol: true })}` : '<div class="mut">No food logged.</div>'}
      <div class="kv-rows">
        <div class="row"><span class="lbl w60">Weight</span><span class="num grow">${ws.length ? ws.map((w) => kg(w.kg) + " kg").join(", ") : "—"}</span></div>
        <div class="row"><span class="lbl w60">Training</span><span class="grow">${wos.length ? wos.map((w) => `<a class="num" href="#/training/workouts/${w.id}">${esc(w.name || "Workout")}</a>`).join(", ") : '<span class="mut">—</span>'}</span></div>
      </div>
      <div class="spacer"></div>
      <button class="pill" data-open>Open this day</button>`;
    root.querySelector("[data-open]").onclick = () => showDate(d);
  };
  paintDetail();

  root.querySelectorAll("[data-month]").forEach((b) => {
    b.onclick = () => { month = shiftMonths(firstISO, +b.dataset.month); nav.refresh(); };
  });
  root.querySelectorAll("[data-day]").forEach((b) => {
    b.onclick = () => {
      picked = b.dataset.day;
      root.querySelectorAll(".cal-cell.picked").forEach((c) => c.classList.remove("picked"));
      b.classList.add("picked");
      paintDetail();
    };
  });
}
