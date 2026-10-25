// Today: the day's food against its targets and its training, with the day's
// weight top right and ＋Food / ＋Weight / ＋Workout always to hand (pinned to
// the bottom on mobile).

import { api, p, session, invalidate, loadDay, loadDash, loadWorkouts } from "../api.js";
import { toast } from "../sheet.js";
import { commas, esc, fmtDate, fmtDay, kg, phaseOn, shiftDate, signed } from "../util.js";
import { nutrientSummary, ring } from "../charts.js";
import { openFoodForm, openWeighIn } from "../forms.js";
import { openWorkoutForm } from "../workout-form.js";
import { isMobile, nav } from "../nav.js";

let selected = null;
export function showDate(date) { selected = date; nav.go("#/today"); }

export async function render(root) {
  const date = selected || session.today;
  const [day, dash, workouts] = await Promise.all([loadDay(date), loadDash(), loadWorkouts()]);
  const phases = dash.phases || [];
  const untracked = day.untracked;
  const targets = day.targets || {};
  const totals = day.totals || {};
  const calT = targets.calories || 0;
  const left = calT - (totals.calories || 0);

  // Weight readout: the day's last weigh-in and its change from the one before;
  // on a day without one, the most recent earlier weigh-in, dated and muted.
  const upTo = (dash.weights || []).filter((w) => w.datetime.slice(0, 10) <= date);
  const shown = upTo[upTo.length - 1] || null;
  const prev = upTo[upTo.length - 2] || null;
  const onDay = shown && shown.datetime.slice(0, 10) === date;
  const weightHtml = !shown ? "" : onDay
    ? `<div class="weight-read" title="Weigh-in at ${esc(shown.datetime.slice(11, 16))}"><span class="num">${kg(shown.kg)}</span><span class="mut">kg</span>${
        prev ? `<span class="${shown.kg <= prev.kg ? "gr" : "mut"} strong">${signed(shown.kg - prev.kg)}</span>` : ""}</div>`
    : `<div class="weight-read faded" title="No weigh-in on this day"><span class="num">${kg(shown.kg)}</span><span class="mut">kg · ${esc(fmtDay(shown.datetime.slice(0, 10)))}</span></div>`;
  const phase = phaseOn(phases, date);

  const lastWorkout = workouts.find((w) => w.date < date);
  const actions = `<button class="pill" data-add-food${untracked ? " disabled" : ""}>＋ Food</button>
    <button class="pill" data-add-weight>＋ Weight</button>
    <button class="pill" data-add-workout>＋ Workout</button>`;

  root.innerHTML = `<div class="page today">
    <div class="day-head">
      <button class="pill sq" data-shift="-1" aria-label="Previous day">‹</button>
      <label class="date-btn"><span class="num">${esc(date === session.today ? "Today · " : "")}${esc(fmtDate(date))}</span>
        <input type="date" data-pick value="${date}" aria-label="Pick a date"></label>
      <button class="pill sq" data-shift="1" aria-label="Next day">›</button>
      ${date !== session.today ? '<button class="pill sm" data-today>Today</button>' : ""}
      <div class="spacer"></div>
      ${weightHtml}
      <div class="hide-mobile actions">${actions}</div>
    </div>
    <div class="grid-today">
      <div class="card">
        <div class="card-title">Food
          <span class="spacer"></span>
          ${date === session.today && day.entries.length && !untracked
            ? `<button class="chip${day.completed ? " active" : ""}" data-complete title="Count today in averages">${day.completed ? "✓ Day complete" : "Mark day complete"}</button>` : ""}</div>
        ${untracked ? `<div class="untracked-note"><b>${esc(phase.name || "Untracked")}</b> — an untracked window, so there are no targets and food isn't logged.</div>` : `
        <div class="summary">
          ${calT ? ring(totals.calories || 0, calT) : ""}
          <div class="summary-num">
            <div><span class="big">${calT ? commas(Math.abs(left)) : commas(totals.calories || 0)}</span></div>
            <div class="mut">${calT ? (left >= 0 ? `of ${commas(calT)} kcal left` : `kcal over ${commas(calT)}`) : "kcal today"}</div>
          </div>
          ${nutrientSummary(totals, targets, undefined, {
            compact: isMobile(),
            noTargets: calT ? "" : `No targets for this day · <a class="link" href="${phase ? "#/nutrition/phases" : "#/settings"}">Set targets</a>`,
          })}
        </div>`}
        <div class="entries">${day.entries.map((e) => `<button class="row row-btn" data-entry="${e.id}">
            <span class="mut time">${esc(e.time || "—")}</span>
            <span class="grow"><span class="num">${esc(e.food || "")}</span><span class="mut sub">${esc(["protein", "carbs", "fat"].filter((k) => e[k] != null).map((k) => `${Math.round(e[k])}${k[0]}`).join(" · "))}${e.quantity ? " · " + esc(e.quantity) : ""}</span></span>
            <span class="num">${e.calories != null ? commas(e.calories) : "—"}</span>
          </button>`).join("") || (untracked ? "" : '<div class="empty">Nothing logged yet.</div>')}</div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-title">Training</div>
          ${day.workouts.length ? day.workouts.map((w) => `<a class="row row-btn" href="#/training/workouts/${w.id}">
              <span class="grow"><span class="num">${esc(w.name || "Workout")}</span><span class="mut sub">${(w.exercises || []).length} exercises</span></span><span class="mut">›</span></a>`).join("")
            : `<div class="mut strong">Nothing logged</div>${lastWorkout ? `<div class="mut">Last: ${esc(lastWorkout.name || "Workout")} · ${esc(fmtDate(lastWorkout.date))}</div>` : ""}`}
        </div>
      </div>
    </div>
    <div class="pinbar show-mobile-flex">${actions}</div>
  </div>`;

  const go = (d) => { selected = d; nav.refresh(); };
  root.querySelectorAll("[data-shift]").forEach((b) => { b.onclick = () => go(shiftDate(date, +b.dataset.shift)); });
  root.querySelector("[data-today]")?.addEventListener("click", () => go(session.today));
  const pick = root.querySelector("[data-pick]");
  pick.onchange = (e) => { if (e.target.value) go(e.target.value); };
  // Desktop browsers only open the picker from its icon; open it from anywhere on the label.
  pick.onclick = () => { try { pick.showPicker?.(); } catch (e) { /* not allowed here; native UI still works */ } };
  root.querySelectorAll("[data-add-food]").forEach((b) => { b.onclick = () => openFoodForm({ date }); });
  root.querySelectorAll("[data-add-weight]").forEach((b) => { b.onclick = () => openWeighIn({ date }); });
  root.querySelectorAll("[data-add-workout]").forEach((b) => { b.onclick = () => openWorkoutForm({ date }); });
  root.querySelector("[data-complete]")?.addEventListener("click", async () => {
    try {
      await api(p(`/days/${date}/complete`), { method: "POST", body: { completed: !day.completed } });
      invalidate("day:", "dash");
      await nav.refresh();
    } catch (e) { toast(e.message, "err"); }
  });
  root.querySelectorAll("[data-entry]").forEach((b) => {
    b.onclick = () => openFoodForm({ entry: day.entries.find((e) => e.id === b.dataset.entry) });
  });
}
