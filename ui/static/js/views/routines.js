// Routines: saved exercise lists used to prefill a workout.

import { api, p, invalidate, loadExercises, loadRoutines, loadWorkouts } from "../api.js";
import { esc, fmtDate } from "../util.js";
import { openSheet, closeSheet, formError, busy, toast } from "../sheet.js";
import { openExercisePicker, openWorkoutForm } from "../workout-form.js";
import { nav } from "../nav.js";

export async function render(root) {
  const [routines, workouts] = await Promise.all([loadRoutines(), loadWorkouts()]);
  const lastUsed = (r) => workouts.find((w) => w.routine_id === r.id)?.date;

  root.innerHTML = `<div class="page">
    <div class="stats-line"><span class="mut">Saved exercise lists to start a workout from.</span><div class="spacer"></div>
      <button class="pill fill" data-new>＋ New routine</button></div>
    <div class="card-grid">${routines.map((r) => `<div class="card routine">
        <div class="detail-head"><span class="num lg grow">${esc(r.name)}</span>
          <button class="pill sm" data-edit="${r.id}">Edit</button><button class="pill sm" data-start="${r.id}">Start</button></div>
        <div class="mut">${(r.exercises || []).map((e) => esc(e.name)).join(" · ") || "No exercises"}</div>
        <div class="mut faint">${lastUsed(r) ? "last used " + esc(fmtDate(lastUsed(r))) : "not used yet"}</div>
      </div>`).join("") || '<div class="card"><div class="empty">No routines yet. Create one here, or use “Save as routine” on a workout.</div></div>'}
    </div></div>`;

  root.querySelector("[data-new]").onclick = () => openRoutineEditor();
  root.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = () => openRoutineEditor(routines.find((r) => r.id === b.dataset.edit));
  });
  root.querySelectorAll("[data-start]").forEach((b) => {
    b.onclick = () => openWorkoutForm({ prefill: { from: routines.find((r) => r.id === b.dataset.start), kind: "routine" } });
  });
}

async function openRoutineEditor(routine = null) {
  const catalogue = await loadExercises().catch(() => []);
  const editing = !!routine;
  const state = { name: routine?.name || "", items: (routine?.exercises || []).map((e) => ({ ...e })) };
  const sheet = openSheet({
    title: editing ? routine.name : "New routine",
    kind: "panel", full: true,
    body: '<div class="form-stack" data-body></div>',
    foot: `${editing ? '<button class="pill danger" data-delete>Delete routine</button>' : ""}<span class="spacer"></span>
      <button class="pill fill" data-save>Save</button>`,
  });
  const body = sheet.querySelector("[data-body]");
  const readName = () => { state.name = body.querySelector("[data-name]").value.trim(); };

  function paint() {
    body.innerHTML = `<div class="field"><span class="lbl">Name</span><input class="box" data-name type="text" value="${esc(state.name)}" placeholder="e.g. Push A"></div>
      <div class="field"><span class="lbl">Exercises · in order</span>
      <div class="list">${state.items.map((e, i) => `<div class="row">
          <span class="num grow">${esc(e.name)}</span>
          <button class="qa" data-up="${i}" aria-label="Move up"${i === 0 ? " disabled" : ""}>↑</button>
          <button class="qa" data-down="${i}" aria-label="Move down"${i === state.items.length - 1 ? " disabled" : ""}>↓</button>
          <button class="qa danger" data-rm="${i}" aria-label="Remove">✕</button></div>`).join("") || '<div class="empty">No exercises yet.</div>'}</div></div>
      <button class="dashed-btn" data-add>＋ Add from catalogue</button>${formError()}`;
    const move = (i, j) => { readName(); [state.items[i], state.items[j]] = [state.items[j], state.items[i]]; paint(); };
    body.querySelectorAll("[data-up]").forEach((b) => { b.onclick = () => move(+b.dataset.up, +b.dataset.up - 1); });
    body.querySelectorAll("[data-down]").forEach((b) => { b.onclick = () => move(+b.dataset.down, +b.dataset.down + 1); });
    body.querySelectorAll("[data-rm]").forEach((b) => { b.onclick = () => { readName(); state.items.splice(+b.dataset.rm, 1); paint(); }; });
    body.querySelector("[data-add]").onclick = () => {
      readName();
      openExercisePicker(catalogue, (ex) => { state.items.push({ exercise_id: ex.id, name: ex.name }); paint(); });
    };
  }
  paint();

  busy(sheet, sheet.querySelector("[data-save]"), async () => {
    readName();
    if (!state.name) throw new Error("Name is required.");
    const payload = { name: state.name, exercises: state.items.map((e) => ({ exercise_id: e.exercise_id, name: e.name })) };
    if (editing) await api(p(`/routines/${routine.id}`), { method: "PATCH", body: payload });
    else await api(p("/routines"), { method: "POST", body: payload });
    invalidate("routines");
    closeSheet();
    toast("Routine saved");
    await nav.refresh();
  });
  if (editing) {
    sheet.querySelector("[data-delete]").onclick = async () => {
      if (!confirm(`Delete the routine “${routine.name}”? Logged workouts are unaffected.`)) return;
      try {
        await api(p(`/routines/${routine.id}`), { method: "DELETE" });
        invalidate("routines");
        closeSheet();
        toast("Routine deleted");
        await nav.refresh();
      } catch (e) { toast(e.message, "err"); }
    };
  }
}
