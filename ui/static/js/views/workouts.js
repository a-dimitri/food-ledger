// Workouts: list (grouped by month, dotted by phase colour) and the selected
// workout's top sets with the change since each exercise's previous session.
// Desktop shows both side by side; mobile shows the list, then the detail page.

import { api, p, session, invalidate, loadDash, loadWorkouts } from "../api.js";
import { esc, fmtDate, fmtMonth, phaseOn, previousSet, setLabel, shiftDate, weekStart } from "../util.js";
import { openSheet, closeSheet, formError, busy, toast } from "../sheet.js";
import { openWorkoutForm } from "../workout-form.js";
import { isMobile, nav } from "../nav.js";

export async function render(root, params) {
  const [workouts, dash] = await Promise.all([loadWorkouts(), loadDash()]);
  const phases = dash.phases || [];
  const today = session.today;
  const phaseNow = phaseOn(phases, today);

  const thisWeek = workouts.filter((w) => w.date >= weekStart(today) && w.date <= today).length;
  const thisPhase = phaseNow?.kind === "phase" ? workouts.filter((w) => w.date >= phaseNow.start && w.date <= today).length : null;
  const since = shiftDate(today, -83);  // last 12 weeks
  const avg = workouts.filter((w) => w.date >= since && w.date <= today).length / 12;

  const selectedId = params.id || (!isMobile() && workouts[0]?.id) || null;
  const selected = workouts.find((w) => w.id === selectedId) || null;
  const mobileDetail = isMobile() && params.id;

  const listHtml = () => {
    if (!workouts.length) return '<div class="empty">No workouts yet. Log one from Today or with ＋ Log workout.</div>';
    let out = "", lastMonth = null;
    for (const w of workouts) {
      const m = w.date.slice(0, 7);
      if (m !== lastMonth) {
        const label = m.slice(0, 4) === today.slice(0, 4) ? fmtDate(w.date, { month: "long" }) : fmtMonth(w.date);
        out += `<div class="lbl list-sec">${esc(label)}</div>`;
        lastMonth = m;
      }
      const ph = phaseOn(phases, w.date);
      out += `<a class="row row-btn${w.id === selectedId && !isMobile() ? " sel" : ""}" href="#/training/workouts/${w.id}">
        <span class="dot" style="background:${ph?.kind === "phase" ? esc(ph.colour) : "var(--line-strong)"}"></span>
        <span class="grow"><span class="num">${esc(w.name || "Workout")}</span>
          <span class="mut sub">${esc(fmtDate(w.date))} · ${(w.exercises || []).length} exercises</span></span>
        <span class="mut">›</span></a>`;
    }
    return out;
  };

  const detailHtml = (w) => {
    if (!w) return '<div class="empty">Select a workout.</div>';
    const ph = phaseOn(phases, w.date);
    const rows = (w.exercises || []).map((ex) => {
      const prev = previousSet(workouts, ex.exercise_id, w.date);
      const delta = prev && prev.kg != null && ex.kg != null ? ex.kg - prev.kg : null;
      const chip = delta ? `<span class="chip ${delta > 0 ? "up" : "down"}">${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}</span>` : "";
      return `<a class="row row-btn" href="#/training/exercises/${ex.exercise_id}">
        <span class="num grow">${esc(ex.name)}</span><span class="mut">${esc(setLabel(ex))}</span>${chip}</a>`;
    }).join("");
    const improved = (w.exercises || []).filter((ex) => {
      const prev = previousSet(workouts, ex.exercise_id, w.date);
      return prev && prev.kg != null && ex.kg != null && ex.kg > prev.kg;
    }).length;
    return `<div class="detail-head"><div class="grow"><div class="h2">${esc(w.name || "Workout")}</div>
        <div class="mut">${esc(fmtDate(w.date))}${ph?.kind === "phase" ? " · " + esc(ph.name) : ""}</div></div></div>
      <div class="detail-actions"><button class="pill" data-edit>Edit</button><button class="pill" data-routine>Save as routine</button>
        <button class="pill" data-again>Log again</button></div>
      <div class="list">${rows || '<div class="empty">No exercises.</div>'}</div>
      <div class="stat-row"><div><div class="lbl">Exercises</div><div class="num">${(w.exercises || []).length}</div></div>
        <div><div class="lbl">Top sets up</div><div class="num gr">${improved}</div></div>
        ${w.notes ? `<div class="grow"><div class="lbl">Notes</div><div class="mut">${esc(w.notes)}</div></div>` : ""}</div>`;
  };

  const stats = `<div class="stats-line">
      <div><span class="lbl">This week</span> <span class="num">${thisWeek}</span></div>
      ${thisPhase != null ? `<div><span class="lbl">This phase</span> <span class="num">${thisPhase}</span></div>` : ""}
      <div><span class="lbl">Avg / week</span> <span class="num">${avg.toFixed(1)}</span></div>
      <div class="spacer"></div><button class="pill fill" data-log>＋ Log workout</button></div>`;

  root.innerHTML = mobileDetail
    ? `<div class="page"><div class="card detail">${detailHtml(selected)}</div></div>`
    : `<div class="page">${stats}
        <div class="grid-detail list-first">
          <div class="card list">${listHtml()}</div>
          <div class="card detail hide-mobile">${detailHtml(selected)}</div>
        </div></div>`;

  root.querySelector("[data-log]")?.addEventListener("click", () => openWorkoutForm());
  if (selected) {
    root.querySelector("[data-edit]")?.addEventListener("click", () => openWorkoutForm({ workout: selected }));
    root.querySelector("[data-again]")?.addEventListener("click", () =>
      openWorkoutForm({ prefill: { from: selected, kind: "workout" } }));
    root.querySelector("[data-routine]")?.addEventListener("click", () => saveAsRoutine(selected));
  }
}

function saveAsRoutine(w) {
  const sheet = openSheet({
    title: "Save as routine",
    kind: "dialog",
    body: `<div class="field"><span class="lbl">Routine name</span><input class="box" data-name type="text" value="${esc(w.name || "")}"></div>
      <div class="mut">${(w.exercises || []).map((e) => esc(e.name)).join(" · ")}</div>${formError()}`,
    foot: `<button class="pill" data-cancel>Cancel</button><button class="pill fill" data-save>Save routine</button>`,
  });
  sheet.querySelector("[data-cancel]").onclick = () => closeSheet();
  busy(sheet, sheet.querySelector("[data-save]"), async () => {
    const name = sheet.querySelector("[data-name]").value.trim();
    if (!name) throw new Error("Name is required.");
    await api(p("/routines"), { method: "POST", body: {
      name, exercises: (w.exercises || []).map((e) => ({ exercise_id: e.exercise_id, name: e.name })),
    } });
    invalidate("routines");
    closeSheet();
    toast(`Saved routine “${name}”`);
  });
}

