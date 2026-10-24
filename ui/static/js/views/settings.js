// Settings: the profile's default targets (used outside any phase) and the
// theme (per device).

import { api, invalidate, loadDash, activeProfile } from "../api.js";
import { NUTRIENTS, esc } from "../util.js";
import { THEMES, setTheme, themePref } from "../theme.js";
import { formError, showError, toast } from "../sheet.js";
import { nav } from "../nav.js";

const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };

export async function render(root) {
  const dash = await loadDash();
  const t = dash.default_targets || {};
  const me = activeProfile();

  root.innerHTML = `<div class="page narrow"><div class="stack">
    <div class="card list">
      <div class="card-title">Default targets · outside phases</div>
      ${NUTRIENTS.map(([k, l, u]) => `<div class="row"><span class="grow">${l}${u ? ` <span class="mut">(${u})</span>` : ""}</span>
        <input class="box right setting-input" data-t="${k}" type="number" step="any" min="0" inputmode="decimal" value="${t[k] ?? ""}"></div>`).join("")}
      ${formError()}
      <div class="row-end"><button class="pill fill" data-save>Save targets</button></div>
    </div>
    <div class="card list">
      <div class="card-title">App</div>
      <div class="row"><span class="grow">Theme <span class="mut">(this device)</span></span>
        <div class="seg" data-theme></div></div>
    </div>
    <div class="mut">Name, colour and height are in <a href="#/profiles">Profiles</a> (the avatar). These targets belong to ${esc(me?.name || "this profile")}.</div>
  </div></div>`;

  const paintTheme = () => {
    const pref = themePref();
    const seg = root.querySelector("[data-theme]");
    seg.innerHTML = THEMES.map((k) => `<button class="chip${k === pref ? " active" : ""}" data-opt="${k}" aria-pressed="${k === pref}">${THEME_LABELS[k]}</button>`).join("");
    seg.querySelectorAll("[data-opt]").forEach((b) => { b.onclick = () => { setTheme(b.dataset.opt); paintTheme(); }; });
  };
  paintTheme();

  const card = root.querySelector("[data-save]").closest(".card");
  root.querySelector("[data-save]").onclick = async () => {
    const targets = {};
    for (const input of root.querySelectorAll("[data-t]")) {
      if (input.value === "") continue;
      const v = parseFloat(input.value);
      if (Number.isNaN(v) || v < 0) { showError(card, `${input.dataset.t} must be a non-negative number`); return; }
      targets[input.dataset.t] = v;
    }
    try {
      await api(`/api/profiles/${me.id}`, { method: "PATCH", body: { default_targets: targets } });
      invalidate("dash", "day:");
      showError(card, "");
      toast("Default targets saved");
      await nav.refresh();
    } catch (e) { showError(card, e.message); }
  };
}
