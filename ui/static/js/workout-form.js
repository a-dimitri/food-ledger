// Log / edit a workout (top set per exercise), the exercise picker, and the
// new/edit exercise dialog.

import { api, p, session, invalidate, loadDash, loadExercises, loadRoutines, loadWorkouts } from "./api.js";
import { plural, DEFAULT_FORMULA, EQUIPMENT, FORMULAS, MUSCLE_GROUPS, bodyweightOn, cap, esc, fmtDate, fmtDay, isBodyweight, kg, previousSet, setLabel } from "./util.js";
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
  const [all, routines, catalogue, dash] = await Promise.all([
    loadWorkouts().catch(() => []), loadRoutines().catch(() => []), loadExercises().catch(() => []),
    loadDash().catch(() => null),
  ]);
  const weights = dash?.weights || [];
  // Share of bodyweight lifted, from the catalogue (null for loaded lifts). A
  // row whose exercise has left the catalogue keeps the factor it was saved with.
  const factorFor = (row) => {
    const ex = catalogue.find((e) => e.id === row.exercise_id);
    if (!ex) return row.bw_factor ?? null;
    return ex.equipment === "bodyweight" ? (ex.bodyweight_factor ?? 1) : null;
  };
  const editing = !!workout;
  const form = {
    name: workout?.name || "",
    date: workout?.date || date || session.today,
    routine_id: workout?.routine_id || null,
    rows: (workout?.exercises || []).map((e) => ({ ...e, bw_factor: factorFor(e) })),
    bodyweight: workout?.bodyweight_kg ?? null,   // null: use the weigh-in for the date
    from: null,
  };
  // The weigh-in a new bodyweight session would default to, for the date.
  const suggested = () => {
    const kgv = bodyweightOn(weights, form.date);
    const w = weights.filter((x) => x.datetime.slice(0, 10) <= form.date).pop() || weights[0];
    return kgv == null ? null : { kg: kgv, date: w.datetime.slice(0, 10) };
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
      const row = { exercise_id: e.exercise_id, name: e.name, bw_factor: e.bw_factor ?? null };
      row.bw_factor = factorFor(row);
      // A bodyweight-only history row reads kg 0; start the input empty instead.
      const kgv = base?.kg ?? null;
      return { ...row, kg: row.bw_factor != null && kgv === 0 ? null : kgv, reps: base?.reps ?? null };
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
          <span><span class="num">${esc(r.name)}</span><br><span class="mut">${plural((r.exercises || []).length, "exercise")}</span></span><span class="mut">›</span></button>`).join("")
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
    // Only a value you typed is kept; otherwise the date's weigh-in is used.
    const bw = step.querySelector("[data-bw]");
    if (bw && bw.dataset.edited) form.bodyweight = bw.value === "" ? null : parseFloat(bw.value);
  }

  function editor() {
    saveBtn.hidden = false;
    const anyBw = form.rows.some(isBodyweight);
    const sug = suggested();
    const bwField = !anyBw ? "" : `<div class="field"><span class="lbl">Bodyweight kg</span>
        <input class="box" data-bw type="number" step="0.1" min="0" inputmode="decimal" value="${form.bodyweight ?? sug?.kg ?? ""}" placeholder="kg">
        <span class="mut">${form.bodyweight != null && (!sug || form.bodyweight !== sug.kg) ? "Recorded with this workout"
          : sug ? `From the ${esc(fmtDay(sug.date))} weigh-in — edit if it's out of date` : "No weigh-ins yet — enter it for 1RM estimates"}</span></div>`;
    step.innerHTML = `
      <div class="grid-2 wide-first">
        <div class="field"><span class="lbl">Name</span><input class="box" data-name type="text" value="${esc(form.name)}" placeholder="e.g. Push day"></div>
        <div class="field"><span class="lbl">Date</span><input class="box" data-date type="date" value="${form.date}"></div>
      </div>
      ${form.from ? `<div class="mut">Prefilled from ${esc(form.from.label)} · <button class="link" data-change>change</button></div>`
        : editing ? "" : '<div class="mut"><button class="link" data-change>Prefill from a workout or routine</button></div>'}
      ${bwField}
      <div class="set-table"><div class="set-head"><span class="lbl">Exercise</span><span class="lbl">Last</span><span class="lbl center">kg</span><span class="lbl center">Reps</span><span></span></div>
      ${form.rows.map((r, i) => {
        const last = previousSet(all.filter((w) => w.id !== workout?.id), r.exercise_id, form.date);
        return `<div class="set-row" data-row="${i}">
          <span class="num ellipsis">${esc(r.name)}</span>
          <span class="mut">${esc(setLabel(last))}</span>
          <input class="box center" data-kg type="number" step="any"${isBodyweight(r) ? "" : ' min="0"'} inputmode="decimal" value="${r.kg ?? ""}" placeholder="${isBodyweight(r) ? "+0" : "kg"}"${isBodyweight(r) ? ' title="Added load; negative for assisted"' : ""}>
          <input class="box center" data-reps type="number" step="1" min="1" inputmode="numeric" value="${r.reps ?? ""}">
          <button class="qa danger" data-remove="${i}" aria-label="Remove ${esc(r.name)}">✕</button>
        </div>`;
      }).join("") || '<div class="empty">No exercises yet.</div>'}</div>
      <button class="dashed-btn" data-add>＋ Add exercise</button>
      <div class="mut">One top set per exercise.${anyBw ? " For bodyweight exercises kg is the <b>added</b> load: leave it empty for bodyweight only, negative for assisted." : ""}</div>
      ${formError()}`;
    step.querySelector("[data-change]")?.addEventListener("click", () => { readRows(); chooser(form.from?.kind === "routine" ? "routines" : "recent"); });
    const bwInput = step.querySelector("[data-bw]");
    if (bwInput) bwInput.oninput = () => { bwInput.dataset.edited = "1"; };
    // A new date may mean a different weigh-in: re-suggest unless one was typed.
    step.querySelector("[data-date]").onchange = () => { readRows(); if (anyBw) editor(); };
    step.querySelectorAll("[data-remove]").forEach((b) => {
      b.onclick = () => { readRows(); form.rows.splice(+b.dataset.remove, 1); editor(); };
    });
    step.querySelector("[data-add]").onclick = () => {
      readRows();
      openExercisePicker(catalogue, (ex) => {
        const last = previousSet(all, ex.id, form.date);
        const row = { exercise_id: ex.id, name: ex.name };
        row.bw_factor = factorFor(row);
        const kgv = last?.kg ?? null;
        form.rows.push({ ...row, kg: row.bw_factor != null && kgv === 0 ? null : kgv, reps: last?.reps ?? null });
        editor();
      });
    };
  }

  busy(sheet, saveBtn, async () => {
    readRows();
    if (!form.date) throw new Error("Date is required.");
    if (!form.rows.length) throw new Error("Add at least one exercise.");
    const anyBw = form.rows.some(isBodyweight);
    const bw = anyBw ? (form.bodyweight ?? suggested()?.kg ?? null) : null;
    if (anyBw && bw != null && !(bw > 0)) throw new Error("Bodyweight must be a positive number.");
    for (const r of form.rows) {
      if (!(r.reps >= 1)) throw new Error(`Check the top set for ${r.name}: reps must be at least 1.`);
      if (r.kg != null && Number.isNaN(r.kg)) throw new Error(`Check the kg for ${r.name}.`);
      if (!isBodyweight(r) && r.kg != null && r.kg < 0) throw new Error(`${r.name}: kg can't be negative.`);
      if (isBodyweight(r) && bw != null && r.kg != null && r.bw_factor * bw + r.kg <= 0) {
        throw new Error(`${r.name}: assistance can't exceed the ${kg(r.bw_factor * bw)} kg of bodyweight lifted.`);
      }
    }
    const body = {
      date: form.date,
      name: form.name || null,
      exercises: form.rows.map((r) => ({ exercise_id: r.exercise_id, name: r.name, reps: r.reps,
        ...(r.kg != null ? { kg: r.kg } : {}), ...(r.bw_factor != null ? { bw_factor: r.bw_factor } : {}) })),
      ...(form.routine_id ? { routine_id: form.routine_id } : {}),
      ...(bw != null ? { bodyweight_kg: bw } : {}),
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
  const sel = { muscle_group: exercise.muscle_group || "chest", equipment: exercise.equipment || "barbell",
    e1rm_formula: exercise.e1rm_formula || DEFAULT_FORMULA };
  const OPTIONS = { muscle_group: MUSCLE_GROUPS, equipment: EQUIPMENT, e1rm_formula: Object.keys(FORMULAS) };
  const chips = (field, options) => options.map((o) =>
    `<button class="chip${sel[field] === o ? " active" : ""}" data-${field}="${o}">${
      field === "e1rm_formula" ? FORMULAS[o].label : cap(o)}</button>`).join("");
  const sheet = openSheet({
    title: editing ? "Edit exercise" : "New exercise",
    kind: "dialog",
    body: `<div class="field"><span class="lbl">Name</span><input class="box" data-name type="text" value="${esc(exercise.name || "")}" placeholder="e.g. Cable fly"></div>
      <div class="field"><span class="lbl">Muscle group</span><div class="seg" data-groups>${chips("muscle_group", MUSCLE_GROUPS)}</div></div>
      <div class="field"><span class="lbl">Equipment</span><div class="seg" data-equip>${chips("equipment", EQUIPMENT)}</div></div>
      <div class="field" data-factor-field${sel.equipment === "bodyweight" ? "" : " hidden"}>
        <span class="lbl">Share of bodyweight lifted</span>
        <input class="box" data-factor type="number" step="0.05" min="0.05" max="1" inputmode="decimal" value="${exercise.bodyweight_factor ?? 1}">
        <span class="mut">Used to estimate a weighted 1RM. 1.0 for pull-ups, chin-ups and dips; about 0.65 for push-ups, 0.5 for inverted rows.</span></div>
      <div class="field"><span class="lbl">1RM formula</span><div class="seg" data-formula>${chips("e1rm_formula", OPTIONS.e1rm_formula)}</div>
        <span class="mut">Both agree up to ~10 reps. Mayhew credits high-rep sets less than Epley. Changing it re-scores this exercise's whole history.</span></div>
      <div class="mut">The exercise catalogue is shared by every profile.</div>
      ${formError()}`,
    foot: `${editing ? '<button class="pill danger" data-delete>Delete</button><span class="spacer"></span>' : '<button class="pill" data-cancel>Cancel</button>'}
      <button class="pill fill" data-save>Save</button>`,
  });
  const wire = (field, container) => {
    sheet.querySelectorAll(`[data-${field}]`).forEach((b) => {
      b.onclick = () => {
        sel[field] = b.getAttribute(`data-${field}`);
        sheet.querySelector(container).innerHTML = chips(field, OPTIONS[field]);
        sheet.querySelector("[data-factor-field]").hidden = sel.equipment !== "bodyweight";
        wire(field, container);
      };
    });
  };
  wire("muscle_group", "[data-groups]");
  wire("equipment", "[data-equip]");
  wire("e1rm_formula", "[data-formula]");
  sheet.querySelector("[data-cancel]")?.addEventListener("click", () => closeSheet());

  busy(sheet, sheet.querySelector("[data-save]"), async () => {
    const name = sheet.querySelector("[data-name]").value.trim();
    if (!name) throw new Error("Name is required.");
    const catalogue = await loadExercises();
    const dupe = catalogue.find((e) => e.name.toLowerCase() === name.toLowerCase() && e.id !== exercise.id);
    if (dupe) throw new Error(`“${dupe.name}” is already in the catalogue.`);
    const body = { name, ...sel };
    if (sel.equipment === "bodyweight") {
      const f = parseFloat(sheet.querySelector("[data-factor]").value);
      if (!(f > 0 && f <= 1)) throw new Error("Share of bodyweight must be more than 0 and at most 1.");
      body.bodyweight_factor = f;
    }
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
