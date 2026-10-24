// Log / edit a workout (top set per exercise), the exercise picker, and the
// new/edit exercise dialog.

import { api, p, session, invalidate, loadExercises, loadRoutines, loadWorkouts } from "./api.js";
import { EQUIPMENT, MUSCLE_GROUPS, cap, esc, fmtDate, previousSet, setLabel } from "./util.js";
import { openSheet, closeSheet, formError, busy, showError, toast } from "./sheet.js";
import { nav } from "./nav.js";

async function afterWorkoutWrite() {
  invalidate("workouts", "day:", "history:");
  await nav.refresh();
}

const exSummary = (w) => {
  const names = (w.exercises || []).map((e) => e.name);
  return names.slice(0, 2).join(", ") + (names.length > 2 ? `, +${names.length - 2}` : "");
};

/**
 * Open the workout form.
 *   workout  edit an existing workout
 *   prefill  {from: workout|routine, kind: "workout"|"routine"} — skip the chooser
 *   date     date for a new workout (defaults to today)
 */
export async function openWorkoutForm({ workout = null, prefill = null, date = null } = {}) {
  const [all, routines, catalogue] = await Promise.all([
    loadWorkouts().catch(() => []), loadRoutines().catch(() => []), loadExercises().catch(() => []),
  ]);
  const editing = !!workout;
  const form = {
    name: workout?.name || "",
    date: workout?.date || date || session.today,
    routine_id: workout?.routine_id || null,
    rows: (workout?.exercises || []).map((e) => ({ ...e })),
    from: null,
  };

  const sheet = openSheet({
    title: editing ? "Edit workout" : "Log workout",
    kind: "panel", full: true, wide: true,
    body: '<div class="form-stack" data-step></div>',
    foot: `${editing ? '<button class="pill danger" data-delete>Delete</button>' : ""}<span class="spacer"></span>
      <button class="pill fill" data-save>Save workout</button>`,
  });
  const step = sheet.querySelector("[data-step]");
  const saveBtn = sheet.querySelector("[data-save]");

  function applyPrefill(src, kind) {
    form.from = { kind, label: kind === "routine" ? src.name : `${src.name || "Workout"} · ${fmtDate(src.date)}` };
    form.name = form.name || src.name || "";
    form.routine_id = kind === "routine" ? src.id : src.routine_id || null;
    form.rows = (src.exercises || []).map((e) => {
      const last = previousSet(all, e.exercise_id, form.date) || null;
      // From a past workout, start from what was lifted then; from a routine,
      // from the last time each exercise was done.
      const base = kind === "workout" ? e : last;
      return { exercise_id: e.exercise_id, name: e.name, kg: base?.kg ?? null, reps: base?.reps ?? null };
    });
  }

  // ── step 1: where to start from ─────────────────────────────────────────
  function chooser(tab = "recent") {
    saveBtn.hidden = true;
    const recent = all.slice(0, 8);
    const list = tab === "recent"
      ? (recent.length ? recent.map((w) => `<button class="pick" data-from-workout="${w.id}">
          <span><span class="num">${esc(w.name || "Workout")}</span><br><span class="mut">${esc(fmtDate(w.date))} · ${esc(exSummary(w))}</span></span><span class="mut">›</span></button>`).join("")
        : '<div class="empty">No workouts logged yet.</div>')
      : (routines.length ? routines.map((r) => `<button class="pick" data-from-routine="${r.id}">
          <span><span class="num">${esc(r.name)}</span><br><span class="mut">${(r.exercises || []).length} exercises</span></span><span class="mut">›</span></button>`).join("")
        : '<div class="empty">No routines yet — save one from a workout.</div>');
    step.innerHTML = `<div class="field"><span class="lbl">Prefill from</span>
      <div class="seg"><button class="chip${tab === "recent" ? " active" : ""}" data-ptab="recent">Recent</button>
        <button class="chip${tab === "routines" ? " active" : ""}" data-ptab="routines">Routines</button></div></div>
      <div class="pick-list tall">${list}</div>
      <button class="dashed-btn" data-blank>Start blank</button>`;
    step.querySelectorAll("[data-ptab]").forEach((b) => { b.onclick = () => chooser(b.dataset.ptab); });
    step.querySelectorAll("[data-from-workout]").forEach((b) => {
      b.onclick = () => { applyPrefill(all.find((w) => w.id === b.dataset.fromWorkout), "workout"); editor(); };
    });
    step.querySelectorAll("[data-from-routine]").forEach((b) => {
      b.onclick = () => { applyPrefill(routines.find((r) => r.id === b.dataset.fromRoutine), "routine"); editor(); };
    });
    step.querySelector("[data-blank]").onclick = () => { form.from = null; editor(); };
  }

  // ── step 2: the sets ────────────────────────────────────────────────────
  function readRows() {
    step.querySelectorAll("[data-row]").forEach((el) => {
      const r = form.rows[+el.dataset.row];
      const kgv = el.querySelector("[data-kg]").value, reps = el.querySelector("[data-reps]").value;
      r.kg = kgv === "" ? null : parseFloat(kgv);
      r.reps = reps === "" ? null : parseInt(reps, 10);
    });
    form.name = step.querySelector("[data-name]").value.trim();
    form.date = step.querySelector("[data-date]").value;
  }

  function editor() {
    saveBtn.hidden = false;
    step.innerHTML = `
      <div class="grid-2 wide-first">
        <div class="field"><span class="lbl">Name</span><input class="box" data-name type="text" value="${esc(form.name)}" placeholder="e.g. Push day"></div>
        <div class="field"><span class="lbl">Date</span><input class="box" data-date type="date" value="${form.date}"></div>
      </div>
      ${form.from ? `<div class="mut">Prefilled from ${esc(form.from.label)} · <button class="link" data-change>change</button></div>`
        : editing ? "" : '<div class="mut"><button class="link" data-change>Prefill from a workout or routine</button></div>'}
      <div class="set-table"><div class="set-head"><span class="lbl">Exercise</span><span class="lbl">Last</span><span class="lbl center">kg</span><span class="lbl center">Reps</span><span></span></div>
      ${form.rows.map((r, i) => {
        const last = previousSet(all.filter((w) => w.id !== workout?.id), r.exercise_id, form.date);
        return `<div class="set-row" data-row="${i}">
          <span class="num ellipsis">${esc(r.name)}</span>
          <span class="mut">${esc(setLabel(last))}</span>
          <input class="box center" data-kg type="number" step="any" min="0" inputmode="decimal" value="${r.kg ?? ""}" placeholder="BW">
          <input class="box center" data-reps type="number" step="1" min="1" inputmode="numeric" value="${r.reps ?? ""}">
          <button class="qa danger" data-remove="${i}" aria-label="Remove ${esc(r.name)}">✕</button>
        </div>`;
      }).join("") || '<div class="empty">No exercises yet.</div>'}</div>
      <button class="dashed-btn" data-add>＋ Add exercise</button>
      <div class="mut">One top set per exercise. Leave kg empty for bodyweight.</div>
      ${formError()}`;
    step.querySelector("[data-change]")?.addEventListener("click", () => { readRows(); chooser(form.from?.kind === "routine" ? "routines" : "recent"); });
    step.querySelectorAll("[data-remove]").forEach((b) => {
      b.onclick = () => { readRows(); form.rows.splice(+b.dataset.remove, 1); editor(); };
    });
    step.querySelector("[data-add]").onclick = () => {
      readRows();
      openExercisePicker(catalogue, (ex) => {
        const last = previousSet(all, ex.id, form.date);
        form.rows.push({ exercise_id: ex.id, name: ex.name, kg: last?.kg ?? null, reps: last?.reps ?? null });
        editor();
      });
    };
  }

  busy(sheet, saveBtn, async () => {
    readRows();
    if (!form.date) throw new Error("Date is required.");
    if (!form.rows.length) throw new Error("Add at least one exercise.");
    const bad = form.rows.find((r) => !(r.reps >= 1) || (r.kg != null && (Number.isNaN(r.kg) || r.kg < 0)));
    if (bad) throw new Error(`Check the top set for ${bad.name}: reps must be at least 1.`);
    const body = {
      date: form.date,
      name: form.name || null,
      exercises: form.rows.map((r) => ({ exercise_id: r.exercise_id, name: r.name, reps: r.reps, ...(r.kg != null ? { kg: r.kg } : {}) })),
      ...(form.routine_id ? { routine_id: form.routine_id } : {}),
    };
    let id = workout?.id;
    if (editing) await api(p(`/workouts/${id}`), { method: "PATCH", body });
    else id = (await api(p("/workouts"), { method: "POST", body })).id;
    closeSheet();
    toast(editing ? "Workout updated" : "Workout logged");
    await afterWorkoutWrite();
    nav.go(`#/training/workouts/${id}`);
  });

  if (editing) {
    sheet.querySelector("[data-delete]").onclick = async () => {
      if (!confirm("Delete this workout?")) return;
      try {
        await api(p(`/workouts/${workout.id}`), { method: "DELETE" });
        closeSheet();
        toast("Workout deleted");
        await afterWorkoutWrite();
        nav.go("#/training/workouts");
      } catch (e) { showError(sheet, e.message); }
    };
  }

  if (editing) editor();
  else if (prefill) { applyPrefill(prefill.from, prefill.kind); editor(); }
  else chooser();
}

// ── exercise picker ──────────────────────────────────────────────────────────
export function openExercisePicker(catalogue, onPick) {
  const sheet = openSheet({
    title: "Add exercise",
    kind: "dialog",
    body: `<input class="box" data-q type="search" placeholder="⌕ Search exercises…" autocomplete="off">
      <div class="pick-list tall" data-list></div>
      <button class="dashed-btn" data-new>＋ New exercise</button>`,
  });
  const paint = (needle = "") => {
    const n = needle.trim().toLowerCase();
    const items = catalogue.filter((e) => !n || e.name.toLowerCase().includes(n));
    sheet.querySelector("[data-list]").innerHTML = items.map((e) => `<button class="pick" data-ex="${e.id}">
      <span class="num">${esc(e.name)}</span><span class="mut">${esc(cap(e.equipment))} · ${esc(e.muscle_group)}</span></button>`).join("")
      || '<div class="empty">No match.</div>';
    sheet.querySelectorAll("[data-ex]").forEach((b) => {
      b.onclick = () => { closeSheet(); onPick(catalogue.find((e) => e.id === b.dataset.ex)); };
    });
  };
  sheet.querySelector("[data-q]").oninput = (e) => paint(e.target.value);
  sheet.querySelector("[data-new]").onclick = () => {
    const name = sheet.querySelector("[data-q]").value.trim();
    openExerciseForm({ name }, (ex) => { closeSheet(); onPick(ex); });
  };
  paint();
}

// ── new / edit exercise (shared catalogue) ───────────────────────────────────
export function openExerciseForm(exercise = {}, onSaved = null) {
  const editing = !!exercise.id;
  const sel = { muscle_group: exercise.muscle_group || "chest", equipment: exercise.equipment || "barbell" };
  const chips = (field, options) => options.map((o) =>
    `<button class="chip${sel[field] === o ? " active" : ""}" data-${field}="${o}">${cap(o)}</button>`).join("");
  const sheet = openSheet({
    title: editing ? "Edit exercise" : "New exercise",
    kind: "dialog",
    body: `<div class="field"><span class="lbl">Name</span><input class="box" data-name type="text" value="${esc(exercise.name || "")}" placeholder="e.g. Cable fly"></div>
      <div class="field"><span class="lbl">Muscle group</span><div class="seg" data-groups>${chips("muscle_group", MUSCLE_GROUPS)}</div></div>
      <div class="field"><span class="lbl">Equipment</span><div class="seg" data-equip>${chips("equipment", EQUIPMENT)}</div></div>
      <div class="mut">The exercise catalogue is shared by every profile.</div>
      ${formError()}`,
    foot: `${editing ? '<button class="pill danger" data-delete>Delete</button><span class="spacer"></span>' : '<button class="pill" data-cancel>Cancel</button>'}
      <button class="pill fill" data-save>Save</button>`,
  });
  const wire = (field, container) => {
    sheet.querySelectorAll(`[data-${field}]`).forEach((b) => {
      b.onclick = () => {
        sel[field] = b.getAttribute(`data-${field}`);
        sheet.querySelector(container).innerHTML = chips(field, field === "muscle_group" ? MUSCLE_GROUPS : EQUIPMENT);
        wire(field, container);
      };
    });
  };
  wire("muscle_group", "[data-groups]");
  wire("equipment", "[data-equip]");
  sheet.querySelector("[data-cancel]")?.addEventListener("click", () => closeSheet());

  busy(sheet, sheet.querySelector("[data-save]"), async () => {
    const name = sheet.querySelector("[data-name]").value.trim();
    if (!name) throw new Error("Name is required.");
    const catalogue = await loadExercises();
    const dupe = catalogue.find((e) => e.name.toLowerCase() === name.toLowerCase() && e.id !== exercise.id);
    if (dupe) throw new Error(`“${dupe.name}” is already in the catalogue.`);
    const body = { name, ...sel };
    let id = exercise.id;
    if (editing) await api(`/api/exercises/${id}`, { method: "PATCH", body });
    else id = (await api("/api/exercises", { method: "POST", body })).id;
    invalidate("shared:exercises");
    closeSheet();
    toast(editing ? "Exercise saved" : `Added ${name}`);
    if (onSaved) onSaved({ id, ...body });
    else await nav.refresh();
  });

  if (editing) {
    sheet.querySelector("[data-delete]").onclick = async () => {
      if (!confirm(`Delete “${exercise.name}” from the shared catalogue? Logged workouts keep their sets.`)) return;
      try {
        await api(`/api/exercises/${exercise.id}`, { method: "DELETE" });
        invalidate("shared:exercises");
        closeSheet();
        toast("Exercise deleted");
        nav.go("#/training/exercises");
      } catch (e) { showError(sheet, e.message); }
    };
  }
}
