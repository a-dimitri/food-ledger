// Forms opened from several pages: add/edit food entry, weigh-in, pantry item.

import { api, p, session, invalidate, loadFoods, loadDash } from "./api.js";
import { NUTRIENTS, NUTRIENT_KEYS, commas, esc, kg, nowTime, round2, signed } from "./util.js";
import { openSheet, closeSheet, formError, busy, toast } from "./sheet.js";
import { nav } from "./nav.js";

// After any write that changes a day: drop cached day/dashboard data and repaint.
async function afterDayWrite() {
  invalidate("day:", "dash");
  await nav.reloadMe();
  await nav.refresh();
}

const numField = (id, label, value, extra = "") => `<div class="field"><span class="lbl">${label}</span>
  <input class="box center" data-f="${id}" type="number" step="any" min="0" inputmode="decimal" value="${value ?? ""}" ${extra}></div>`;

function nutrientGrid(values = {}) {
  return `<div class="grid-4">${NUTRIENTS.map(([k, l, u]) =>
    numField(k, k === "calories" ? "kcal" : `${l.slice(0, 4)} ${u}`, values[k])).join("")}</div>`;
}

function readNutrients(sheet) {
  const out = {};
  for (const k of NUTRIENT_KEYS) {
    const v = sheet.querySelector(`[data-f="${k}"]`)?.value;
    if (v !== undefined && v !== "") {
      const n = parseFloat(v);
      if (Number.isNaN(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
      out[k] = n;
    }
  }
  return out;
}

function macroLine(n) {
  const bits = [];
  if (n.calories != null) bits.push(`${commas(n.calories)} kcal`);
  for (const [k, s] of [["protein", "p"], ["carbs", "c"], ["fat", "f"]]) if (n[k] != null) bits.push(`${Math.round(n[k])}${s}`);
  return bits.join(" · ") || "—";
}

// ── food entry ───────────────────────────────────────────────────────────────
/**
 * Add a food entry to `date` (pantry or manual), or edit `entry` (manual form,
 * pre-filled). `presetFoodId` opens the pantry tab with that item selected.
 */
export async function openFoodForm({ date, entry = null, presetFoodId = null } = {}) {
  const editing = !!entry;
  const foods = await loadFoods().catch(() => []);
  const state = { tab: editing || !foods.length ? "manual" : "pantry", picked: presetFoodId, qty: 1, query: "" };
  date = entry?.date || date || session.today;

  const sheet = openSheet({
    title: editing ? "Edit entry" : "Add food",
    kind: "panel",
    body: `
      ${editing ? "" : `<div class="seg" data-tabs>
        <button class="chip" data-tab="pantry">Pantry</button><button class="chip" data-tab="manual">Manual</button></div>`}
      <div class="form-stack" data-pane="pantry">
        <input class="box" data-search type="search" placeholder="⌕ Search pantry…" autocomplete="off">
        <div class="pick-list" data-list></div>
        <div class="field"><div class="qty-row"><span class="lbl">Quantity</span><div class="spacer"></div>
          <button class="step" data-qty="-0.5" aria-label="Less">−</button>
          <input class="box center qty" data-qty-input type="number" step="any" min="0" inputmode="decimal" value="1">
          <button class="step" data-qty="0.5" aria-label="More">＋</button></div>
        <div class="mut center" data-scaled></div></div>
      </div>
      <div class="form-stack" data-pane="manual">
        <div class="field"><span class="lbl">Name</span><input class="box" data-f="food" type="text" autocomplete="off" value="${esc(entry?.food || "")}" placeholder="e.g. Restaurant burrito"></div>
        ${nutrientGrid(entry || {})}
        <details class="more"${entry?.quantity || entry?.source || entry?.notes ? " open" : ""}><summary class="mut">Quantity, source, notes</summary>
          <div class="grid-2">
            <div class="field"><span class="lbl">Quantity</span><input class="box" data-f="quantity" type="text" value="${esc(entry?.quantity || "")}" placeholder="1 bowl"></div>
            <div class="field"><span class="lbl">Source</span><input class="box" data-f="source" type="text" value="${esc(entry?.source || "")}" placeholder="homemade"></div>
          </div>
          <div class="field"><span class="lbl">Notes</span><input class="box" data-f="notes" type="text" value="${esc(entry?.notes || "")}"></div>
        </details>
        ${editing ? "" : `<label class="toggle-row"><input type="checkbox" data-save-pantry><span class="tog"></span><span class="mut">Also save to pantry</span></label>`}
      </div>
      <div class="grid-2">
        <div class="field"><span class="lbl">Date</span><input class="box" data-f="date" type="date" value="${date}"></div>
        <div class="field"><span class="lbl">Time</span><input class="box" data-f="time" type="time" value="${esc(entry?.time || nowTime())}"></div>
      </div>
      ${formError()}`,
    foot: `${editing ? '<button class="pill danger" data-delete>Delete</button><span class="spacer"></span>' : ""}
      <button class="pill fill" data-save>${editing ? "Save" : "Add"}</button>`,
  });

  const q = (sel) => sheet.querySelector(sel);
  const picked = () => foods.find((f) => f.id === state.picked) || null;

  function paintTabs() {
    sheet.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
    q('[data-pane="pantry"]').hidden = state.tab !== "pantry";
    q('[data-pane="manual"]').hidden = state.tab !== "manual";
  }
  function paintList() {
    const needle = state.query.trim().toLowerCase();
    const items = foods.filter((f) => !needle || (f.name || "").toLowerCase().includes(needle));
    q("[data-list]").innerHTML = items.length ? items.map((f) => `<button class="pick${f.id === state.picked ? " on" : ""}" data-food="${f.id}">
        <span class="num">${esc(f.name)}</span><span class="mut">${f.per?.calories != null ? commas(f.per.calories) : "—"} / ${esc(f.unit || "serving")}</span>
      </button>`).join("") : `<div class="empty">${foods.length ? "No match." : "The pantry is empty."}</div>`;
    sheet.querySelectorAll("[data-food]").forEach((b) => {
      b.onclick = () => { state.picked = b.dataset.food; paintList(); paintScaled(); };
    });
  }
  function scaled() {
    const f = picked();
    if (!f) return null;
    const out = {};
    for (const [k, v] of Object.entries(f.per || {})) out[k] = round2(v * state.qty);
    return out;
  }
  function paintScaled() {
    const s = scaled();
    q("[data-scaled]").textContent = s ? macroLine(s) : "Pick an item";
  }

  sheet.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => { state.tab = b.dataset.tab; paintTabs(); }; });
  q("[data-search]").oninput = (e) => { state.query = e.target.value; paintList(); };
  const qtyInput = q("[data-qty-input]");
  qtyInput.oninput = () => { const v = parseFloat(qtyInput.value); state.qty = Number.isNaN(v) ? 0 : v; paintScaled(); };
  sheet.querySelectorAll("[data-qty]").forEach((b) => {
    b.onclick = () => {
      state.qty = Math.max(0, round2(state.qty + parseFloat(b.dataset.qty)));
      qtyInput.value = state.qty;
      paintScaled();
    };
  });
  paintTabs(); paintList(); paintScaled();

  busy(sheet, q("[data-save]"), async () => {
    const when = { date: q('[data-f="date"]').value, time: q('[data-f="time"]').value || null };
    if (!when.date) throw new Error("Date is required.");
    let body;
    if (state.tab === "pantry" && !editing) {
      const f = picked();
      if (!f) throw new Error("Pick a pantry item, or switch to Manual.");
      if (!(state.qty > 0)) throw new Error("Quantity must be more than zero.");
      const qtyStr = Number.isInteger(state.qty) ? String(state.qty) : String(round2(state.qty));
      body = { ...when, food: f.name, quantity: f.unit ? `${qtyStr} × ${f.unit}` : qtyStr, ...scaled() };
      if (f.source) body.source = f.source;
    } else {
      const food = q('[data-f="food"]').value.trim();
      if (!food) throw new Error("Name is required.");
      body = { ...when, food, ...readNutrients(sheet) };
      for (const k of ["quantity", "source", "notes"]) {
        const v = q(`[data-f="${k}"]`).value.trim();
        if (v || editing) body[k] = v || null;
      }
    }
    if (editing) {
      await api(p(`/entries/${entry.id}`), { method: "PATCH", body });
    } else {
      await api(p("/entries"), { method: "POST", body });
      if (state.tab === "manual" && q("[data-save-pantry]")?.checked) {
        const per = Object.fromEntries(NUTRIENT_KEYS.filter((k) => body[k] != null).map((k) => [k, body[k]]));
        await api("/api/foods", { method: "POST", body: { name: body.food, unit: body.quantity || "serving", per, ...(body.source ? { source: body.source } : {}) } });
        invalidate("shared:foods");
      }
    }
    closeSheet();
    toast(editing ? "Entry updated" : `Added ${body.food}`);
    await afterDayWrite();
  });

  if (editing) {
    q("[data-delete]").onclick = async () => {
      if (!confirm(`Delete “${entry.food}”?`)) return;
      try {
        await api(p(`/entries/${entry.id}`), { method: "DELETE" });
        closeSheet();
        toast("Entry deleted");
        await afterDayWrite();
      } catch (e) { toast(e.message, "err"); }
    };
  }
}

// ── weigh-in ─────────────────────────────────────────────────────────────────
export async function openWeighIn({ date } = {}) {
  const dash = await loadDash().catch(() => null);
  const weights = dash?.weights || [];
  const last = weights[weights.length - 1];
  date = date || session.today;
  const sheet = openSheet({
    title: "Weigh-in",
    kind: "dialog",
    body: `
      <div class="grid-2">
        <div class="field"><span class="lbl">Date</span><input class="box" data-f="date" type="date" value="${date}"></div>
        <div class="field"><span class="lbl">Time</span><input class="box" data-f="time" type="time" value="${nowTime()}"></div>
      </div>
      <div class="field"><div class="weigh">
        <button class="step lg" data-nudge="-0.1" aria-label="Decrease">−</button>
        <input class="box center weigh-kg" data-f="kg" type="number" step="0.1" min="0" inputmode="decimal" value="${last ? last.kg : ""}">
        <button class="step lg" data-nudge="0.1" aria-label="Increase">＋</button>
      </div>
      <div class="mut center" data-delta>${last ? `kg · last ${kg(last.kg)}` : "kg"}</div></div>
      ${formError()}`,
    foot: `<button class="pill" data-close-btn>Cancel</button><button class="pill fill" data-save>Save</button>`,
  });
  const input = sheet.querySelector('[data-f="kg"]');
  const paintDelta = () => {
    const v = parseFloat(input.value);
    sheet.querySelector("[data-delta]").textContent = last && !Number.isNaN(v)
      ? `kg · last ${kg(last.kg)} (${signed(v - last.kg)})` : "kg";
  };
  input.oninput = paintDelta;
  sheet.querySelectorAll("[data-nudge]").forEach((b) => {
    b.onclick = () => {
      const v = parseFloat(input.value);
      input.value = round2((Number.isNaN(v) ? (last?.kg || 0) : v) + parseFloat(b.dataset.nudge)).toFixed(1);
      paintDelta();
    };
  });
  sheet.querySelector("[data-close-btn]").onclick = () => closeSheet();
  paintDelta();

  busy(sheet, sheet.querySelector("[data-save]"), async () => {
    const d = sheet.querySelector('[data-f="date"]').value;
    const t = sheet.querySelector('[data-f="time"]').value || "08:00";
    const v = parseFloat(input.value);
    if (!d) throw new Error("Date is required.");
    if (Number.isNaN(v) || v <= 0) throw new Error("Enter a weight in kg.");
    await api(p("/weights"), { method: "POST", body: { datetime: `${d}T${t}`, kg: v } });
    closeSheet();
    toast(`Logged ${kg(v)} kg`);
    await afterDayWrite();
  });
}

export async function deleteWeight(w) {
  if (!confirm(`Delete the ${kg(w.kg)} kg weigh-in?`)) return;
  try {
    await api(p(`/weights/${w.id}`), { method: "DELETE" });
    toast("Weigh-in deleted");
    await afterDayWrite();
  } catch (e) { toast(e.message, "err"); }
}

// ── pantry item ──────────────────────────────────────────────────────────────
export function openPantryItem(food = null) {
  const editing = !!food?.id;
  const per = food?.per || {};
  const sheet = openSheet({
    title: editing ? "Pantry item" : "New pantry item",
    kind: "panel",
    full: true,
    body: `
      <div class="field"><span class="lbl">Name</span><input class="box" data-f="name" type="text" value="${esc(food?.name || "")}" placeholder="e.g. Greek yogurt"></div>
      <div class="grid-2">
        <div class="field"><span class="lbl">Serving</span><input class="box" data-f="unit" type="text" value="${esc(food?.unit || "")}" placeholder="170 g"></div>
        <div class="field"><span class="lbl">Source</span><input class="box" data-f="source" type="text" value="${esc(food?.source || "")}" placeholder="brand / homemade"></div>
      </div>
      <div class="field"><span class="lbl">Nutrients per serving</span>${nutrientGrid(per)}</div>
      <div class="mut">Shared by every profile. Logging scales these by the quantity you pick; past entries never change.</div>
      ${formError()}`,
    foot: `${editing ? '<button class="pill danger" data-delete>Delete item</button><span class="spacer"></span>' : ""}
      <button class="pill fill" data-save>Save</button>`,
  });
  const val = (k) => sheet.querySelector(`[data-f="${k}"]`).value.trim();
  busy(sheet, sheet.querySelector("[data-save]"), async () => {
    const name = val("name");
    if (!name) throw new Error("Name is required.");
    const body = { name, per: readNutrients(sheet) };
    if (val("unit") || editing) body.unit = val("unit") || null;
    if (val("source") || editing) body.source = val("source") || null;
    if (editing) await api(`/api/foods/${food.id}`, { method: "PATCH", body });
    else await api("/api/foods", { method: "POST", body });
    invalidate("shared:foods");
    closeSheet();
    toast(editing ? "Pantry item saved" : `Added ${name} to the pantry`);
    await nav.refresh();
  });
  if (editing) {
    sheet.querySelector("[data-delete]").onclick = async () => {
      if (!confirm(`Delete “${food.name}” from the shared pantry? Past entries are unaffected.`)) return;
      try {
        await api(`/api/foods/${food.id}`, { method: "DELETE" });
        invalidate("shared:foods");
        closeSheet();
        toast("Pantry item deleted");
        await nav.refresh();
      } catch (e) { toast(e.message, "err"); }
    };
  }
}
