// Pantry: the shared food catalogue. ＋ logs an item to today; tapping a row
// opens the item editor.

import { session, loadFoods } from "../api.js";
import { commas, esc } from "../util.js";
import { openFoodForm, openPantryItem } from "../forms.js";

let query = "";

export async function render(root) {
  const foods = await loadFoods();
  const n = (v) => (v == null ? "—" : Math.round(v));

  const rows = () => {
    const needle = query.trim().toLowerCase();
    const items = foods.filter((f) => !needle || (f.name || "").toLowerCase().includes(needle));
    if (!items.length) return `<div class="empty">${foods.length ? "No items match." : "The pantry is empty. Add an item, or tick “Also save to pantry” when logging food."}</div>`;
    return items.map((f) => {
      const per = f.per || {};
      return `<div class="row row-btn pantry-row" data-item="${f.id}">
        <span class="grow"><span class="num">${esc(f.name)}</span>
          <span class="mut sub show-mobile">${esc(f.unit || "serving")} · ${per.calories != null ? commas(per.calories) + " kcal" : "—"}${per.protein != null ? ` · ${n(per.protein)}p` : ""}</span></span>
        <span class="mut col-serving hide-mobile">${esc(f.unit || "serving")}</span>
        <span class="num col-n hide-mobile">${per.calories != null ? commas(per.calories) : "—"}</span>
        <span class="mut col-n hide-mobile">${n(per.protein)}</span>
        <span class="mut col-n hide-mobile">${n(per.carbs)}</span>
        <span class="mut col-n hide-mobile">${n(per.fat)}</span>
        <button class="qa" data-log="${f.id}" aria-label="Log ${esc(f.name)}">＋</button>
      </div>`;
    }).join("");
  };

  root.innerHTML = `<div class="page">
    <div class="stats-line">
      <input class="box search" data-q type="search" placeholder="⌕ Search ${foods.length} items…" value="${esc(query)}" autocomplete="off">
      <div class="spacer"></div><button class="pill fill" data-new>＋ New item</button></div>
    <div class="card list">
      <div class="row head-row hide-mobile"><span class="lbl grow">Item</span><span class="lbl col-serving">Serving</span>
        <span class="lbl col-n">kcal</span><span class="lbl col-n">Prot</span><span class="lbl col-n">Carb</span><span class="lbl col-n">Fat</span><span class="qa-space"></span></div>
      <div data-rows>${rows()}</div>
    </div>
    <div class="mut">Shared by every profile.</div>
  </div>`;

  const wire = () => {
    root.querySelectorAll("[data-item]").forEach((r) => {
      r.onclick = (e) => { if (!e.target.closest("[data-log]")) openPantryItem(foods.find((f) => f.id === r.dataset.item)); };
    });
    root.querySelectorAll("[data-log]").forEach((b) => {
      b.onclick = () => openFoodForm({ date: session.today, presetFoodId: b.dataset.log });
    });
  };
  root.querySelector("[data-q]").oninput = (e) => { query = e.target.value; root.querySelector("[data-rows]").innerHTML = rows(); wire(); };
  root.querySelector("[data-new]").onclick = () => openPantryItem(null);
  wire();
}
