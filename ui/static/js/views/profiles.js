// Profiles (from the avatar): switch which profile you're viewing, and edit its
// name, colour and height. Who may sign in is not editable here.

import { api, session, activeProfile } from "../api.js";
import { PROFILE_COLOURS, esc, kg } from "../util.js";
import { formError, showError, toast } from "../sheet.js";
import { nav } from "../nav.js";

export async function render(root) {
  const profiles = session.me.profiles;
  const me = activeProfile();
  const phaseText = (ph) => !ph ? "No phase" : ph.kind === "untracked" ? (ph.name || "Untracked")
    : `${ph.name} · wk ${ph.week}${ph.total_weeks ? "/" + ph.total_weeks : ""}`;

  root.innerHTML = `<div class="page narrow">
    <div class="stack">
      ${profiles.map((pr) => `<div class="card profile-card${pr.id === me.id ? " on" : ""}">
        <div class="avatar lg" style="background:${esc(pr.colour || "")}">${esc((pr.name || "?")[0].toUpperCase())}</div>
        <div class="grow"><div class="num lg">${esc(pr.name)}${pr.id === session.me.profile_id ? ' <span class="mut">(you)</span>' : ""}</div>
          <div class="mut">${esc(phaseText(pr.active_phase))} · ${pr.latest_kg != null ? kg(pr.latest_kg) + " kg" : "no weigh-ins"}</div></div>
        ${pr.id === me.id ? '<span class="chip active">viewing</span>' : `<button class="pill" data-switch="${pr.id}">Switch</button>`}
      </div>`).join("")}
      <div class="card">
        <div class="card-title">${esc(me.name)}'s details</div>
        <div class="field"><span class="lbl">Name</span><input class="box" data-name type="text" value="${esc(me.name || "")}"></div>
        <div class="field"><span class="lbl">Colour</span><div class="swatches" data-colours>${PROFILE_COLOURS.map((c) =>
          `<button class="swatch${c === me.colour ? " on" : ""}" data-colour="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join("")}</div></div>
        <div class="field"><span class="lbl">Height (cm) — used for BMI</span><input class="box" data-height type="number" step="0.1" min="0" inputmode="decimal" value="${me.height_cm ?? ""}"></div>
        ${formError()}
        <div class="row-end"><button class="pill fill" data-save>Save</button></div>
      </div>
      <div class="mut">The pantry and exercise catalogue are shared. Everything else — food, weight, phases, workouts and routines — belongs to each profile.</div>
    </div>
  </div>`;

  let colour = me.colour;
  root.querySelectorAll("[data-colour]").forEach((b) => {
    b.onclick = () => {
      colour = b.dataset.colour;
      root.querySelectorAll("[data-colour]").forEach((x) => x.classList.toggle("on", x === b));
    };
  });
  root.querySelectorAll("[data-switch]").forEach((b) => { b.onclick = () => nav.switchProfile(b.dataset.switch); });

  const card = root.querySelector("[data-save]").closest(".card");
  root.querySelector("[data-save]").onclick = async () => {
    const name = root.querySelector("[data-name]").value.trim();
    const h = root.querySelector("[data-height]").value;
    if (!name) { showError(card, "Name is required."); return; }
    const height = h === "" ? null : parseFloat(h);
    if (height != null && (Number.isNaN(height) || height <= 0)) { showError(card, "Height must be a positive number."); return; }
    try {
      await api(`/api/profiles/${me.id}`, { method: "PATCH", body: { name, colour, height_cm: height } });
      showError(card, "");
      toast("Profile saved");
      await nav.reloadMe();
      await nav.refresh();
    } catch (e) { showError(card, e.message); }
  };
}
