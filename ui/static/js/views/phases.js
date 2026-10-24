// Phases: the year strip, one card per phase / untracked window, and the editor.

import { api, p, session, invalidate, loadDash } from "../api.js";
import { NUTRIENTS, PHASE_COLOURS, commas, esc, fmtDate, kg, phaseOn, weekOf } from "../util.js";
import { yearStrip } from "../charts.js";
import { openSheet, closeSheet, formError, busy, toast } from "../sheet.js";
import { nav } from "../nav.js";

let year = null;

export async function render(root) {
  const dash = await loadDash();
  const phases = dash.phases || [];
  const today = session.today;
  year = year || +today.slice(0, 4);
  const weights = dash.weights || [];
  const kgOn = (date, after) => {
    // First weigh-in on/after `date` (after=true) or last on/before it.
    const list = weights.filter((w) => (after ? w.datetime.slice(0, 10) >= date : w.datetime.slice(0, 10) <= date));
    return list.length ? (after ? list[0] : list[list.length - 1]).kg : null;
  };

  const card = (ph) => {
    const active = phaseOn([ph], today);
    const range = `${fmtDate(ph.start, { day: "numeric", month: "short", year: "numeric" })} – ${ph.end ? fmtDate(ph.end, { day: "numeric", month: "short", year: "numeric" }) : "open-ended"}`;
    if (ph.kind === "untracked") {
      return `<button class="card phase-card untracked${active ? " on" : ""}" data-phase="${ph.id}">
        <div class="detail-head"><span class="num">${esc(ph.name || "Untracked")}</span><span class="spacer"></span><span class="mut">untracked</span></div>
        <div class="mut">${esc(range)} · no targets, no food logging</div></button>`;
    }
    const [w, t] = weekOf(ph, today);
    const done = ph.end && ph.end < today;
    const startKg = kgOn(ph.start, true), endKg = done ? kgOn(ph.end, false) : null;
    const tg = ph.targets || {};
    const progress = active && t ? Math.min(100, Math.round((w / t) * 100)) : null;
    return `<button class="card phase-card${active ? " on" : ""}" data-phase="${ph.id}" style="--tint:${esc(ph.colour || "#c05f3e")}">
      <div class="detail-head"><span class="phase-tag" style="background:${esc(ph.colour || "#c05f3e")}">${esc(ph.name)}</span><span class="spacer"></span>
        ${active ? '<span class="chip active">active</span>' : `<span class="mut">${done ? "done" : "upcoming"}</span>`}</div>
      <div class="mut">${esc(range)}${active ? ` · wk ${w}${t ? " of " + t : ""}` : ""}</div>
      <div class="mut">${tg.calories ? commas(tg.calories) + " kcal" : "no calorie target"}${tg.protein ? ` · ${Math.round(tg.protein)}p` : ""}${
        ph.goal_rate_kg_wk != null ? ` · ${ph.goal_rate_kg_wk > 0 ? "+" : ""}${ph.goal_rate_kg_wk} kg/wk` : ""}${ph.goal_kg != null ? ` → ${kg(ph.goal_kg)} kg` : ""}</div>
      ${done && startKg != null && endKg != null ? `<div class="mut">${kg(startKg)} → ${kg(endKg)} kg</div>` : ""}
      ${progress != null ? `<div class="bar-line"><div class="bar-bg"><div class="bar-fill" style="width:${progress}%;background:${esc(ph.colour)}"></div></div><span class="mut">${progress}%</span></div>` : ""}
    </button>`;
  };

  const sorted = [...phases].sort((a, b) => (a.start < b.start ? 1 : -1));
  root.innerHTML = `<div class="page">
    <div class="stats-line"><span class="mut">Each phase sets its own daily targets and weight goal.</span><div class="spacer"></div>
      <button class="pill" data-new-untracked>＋ Untracked</button><button class="pill" data-new>＋ New phase</button></div>
    <div class="card">
      <div class="month-head"><button class="pill sq" data-year="-1" aria-label="Previous year">‹</button>
        <span class="h2">${year}</span><button class="pill sq" data-year="1" aria-label="Next year">›</button></div>
      ${yearStrip(phases, year)}
    </div>
    <div class="card-grid">${sorted.map(card).join("")}
      <div class="card phase-card dashed"><div class="num faint">No phase</div>
        <div class="mut">Days outside any phase use the default targets in <a href="#/settings">Settings</a>.</div></div>
    </div></div>`;

  root.querySelectorAll("[data-year]").forEach((b) => { b.onclick = () => { year += +b.dataset.year; nav.refresh(); }; });
  root.querySelector("[data-new]").onclick = () => openPhaseEditor({ kind: "phase" }, phases, dash.default_targets);
  root.querySelector("[data-new-untracked]").onclick = () => openPhaseEditor({ kind: "untracked" }, phases, dash.default_targets);
  root.querySelectorAll("[data-phase]").forEach((b) => {
    b.onclick = () => openPhaseEditor(phases.find((x) => x.id === b.dataset.phase), phases, dash.default_targets);
  });
}

function openPhaseEditor(phase, phases, defaults) {
  const editing = !!phase.id;
  const untracked = phase.kind === "untracked";
  let colour = phase.colour || PHASE_COLOURS.find((c) => !phases.some((x) => x.colour === c)) || PHASE_COLOURS[0];
  const tg = phase.targets || (editing ? {} : { ...(defaults || {}) });
  const others = phases.filter((x) => x.kind === "phase" && x.id !== phase.id);

  const sheet = openSheet({
    title: editing ? (untracked ? "Edit untracked window" : "Edit phase") : (untracked ? "New untracked window" : "New phase"),
    kind: "panel", full: true,
    body: `
      <div class="grid-2 wide-first">
        <div class="field"><span class="lbl">Name</span><input class="box" data-f="name" type="text" value="${esc(phase.name || "")}" placeholder="${untracked ? "e.g. Japan trip (optional)" : "e.g. Summer cut"}"></div>
        ${untracked ? "" : `<div class="field"><span class="lbl">Colour</span><div class="swatches" data-colours>${PHASE_COLOURS.map((c) =>
          `<button class="swatch${c === colour ? " on" : ""}" data-colour="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join("")}</div></div>`}
      </div>
      <div class="grid-2">
        <div class="field"><span class="lbl">Start</span><input class="box" data-f="start" type="date" value="${phase.start || session.today}"></div>
        <div class="field"><span class="lbl">End</span><input class="box" data-f="end" type="date" value="${phase.end || ""}"></div>
      </div>
      <div class="mut">Leave End empty for an open-ended ${untracked ? "window" : "phase"}. Windows can't overlap.</div>
      ${untracked ? '<div class="untracked-note">No targets, no chart highlights, and food can\'t be logged in this window. Weigh-ins are still allowed.</div>' : `
      <div class="field"><div class="detail-head"><span class="lbl grow">Daily targets</span>
        <select class="box mini" data-copy><option value="">copy from…</option><option value="__defaults">Default targets</option>
          ${others.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}</select></div>
      <div class="grid-4" data-targets>${NUTRIENTS.map(([k, l, u]) => `<div class="field"><span class="lbl">${k === "calories" ? "kcal" : `${l.slice(0, 4)} ${u}`}</span>
        <input class="box center" data-t="${k}" type="number" step="any" min="0" inputmode="decimal" value="${tg[k] ?? ""}"></div>`).join("")}</div></div>
      <div class="field"><span class="lbl">Weight goal</span>
      <div class="grid-2">
        <div class="field"><span class="lbl">Goal kg</span><input class="box" data-f="goal_kg" type="number" step="0.1" inputmode="decimal" value="${phase.goal_kg ?? ""}"></div>
        <div class="field"><span class="lbl">Planned kg / week</span><input class="box" data-f="goal_rate_kg_wk" type="number" step="0.05" inputmode="decimal" value="${phase.goal_rate_kg_wk ?? ""}" placeholder="−0.4"></div>
      </div></div>`}
      <div class="field"><span class="lbl">Notes</span><textarea class="box" data-f="notes" rows="2">${esc(phase.notes || "")}</textarea></div>
      ${formError()}`,
    foot: `${editing ? '<button class="pill danger" data-delete>Delete</button>' : ""}<span class="spacer"></span><button class="pill fill" data-save>Save</button>`,
  });

  const f = (k) => sheet.querySelector(`[data-f="${k}"]`)?.value.trim() ?? "";
  sheet.querySelectorAll("[data-colour]").forEach((b) => {
    b.onclick = () => { colour = b.dataset.colour; sheet.querySelectorAll("[data-colour]").forEach((x) => x.classList.toggle("on", x === b)); };
  });
  sheet.querySelector("[data-copy]")?.addEventListener("change", (e) => {
    const src = e.target.value === "__defaults" ? defaults : others.find((o) => o.id === e.target.value)?.targets;
    if (src) sheet.querySelectorAll("[data-t]").forEach((i) => { i.value = src[i.dataset.t] ?? ""; });
    e.target.value = "";
  });

  busy(sheet, sheet.querySelector("[data-save]"), async () => {
    const body = { start: f("start"), end: f("end") || null, notes: f("notes") || null, name: f("name") || null };
    if (!body.start) throw new Error("Start is required.");
    if (body.end && body.end < body.start) throw new Error("End can't be before start.");
    if (!untracked) {
      if (!body.name) throw new Error("Name is required.");
      body.colour = colour;
      const targets = {};
      sheet.querySelectorAll("[data-t]").forEach((i) => {
        if (i.value !== "") {
          const v = parseFloat(i.value);
          if (Number.isNaN(v) || v < 0) throw new Error(`${i.dataset.t} target must be a non-negative number`);
          targets[i.dataset.t] = v;
        }
      });
      body.targets = targets;
      for (const k of ["goal_kg", "goal_rate_kg_wk"]) {
        const v = f(k);
        body[k] = v === "" ? null : parseFloat(v);
        if (body[k] != null && Number.isNaN(body[k])) throw new Error(`${k} must be a number`);
      }
    }
    if (editing) await api(p(`/phases/${phase.id}`), { method: "PATCH", body });
    else await api(p("/phases"), { method: "POST", body: { kind: phase.kind, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v != null)) } });
    invalidate("dash", "phases", "day:");
    closeSheet();
    toast("Saved");
    await nav.reloadMe();
    await nav.refresh();
  });

  if (editing) {
    sheet.querySelector("[data-delete]").onclick = async () => {
      if (!confirm(`Delete “${phase.name || "this window"}”? Logged food and weigh-ins are kept; those days fall back to the default targets.`)) return;
      try {
        await api(p(`/phases/${phase.id}`), { method: "DELETE" });
        invalidate("dash", "phases", "day:");
        closeSheet();
        toast("Deleted");
        await nav.reloadMe();
        await nav.refresh();
      } catch (e) { toast(e.message, "err"); }
    };
  }
}

