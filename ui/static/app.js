"use strict";

// key, form label, form unit. Sodium is stored and entered in mg; the summary
// bars and dashboard tiles show it in grams, as the wireframes do.
const NUTRIENTS = [
  ["calories", "Calories", "kcal"], ["protein", "Protein", "g"], ["carbs", "Carbs", "g"],
  ["fat", "Fat", "g"], ["fiber", "Fibre", "g"], ["sodium", "Sodium", "mg"], ["sugar", "Sugar", "g"],
];
const MACROS = ["protein", "carbs", "fat", "fiber", "sodium", "sugar"];

// Indirections into the --n-* custom properties in styles.css, not literals: the
// charts are inline SVG, so var() resolves in their fill/stroke attributes and a
// theme swap recolours every chart on screen without re-rendering one.
const NUTRIENT_COLORS = {
  calories: "var(--n-calories)", protein: "var(--n-protein)", carbs: "var(--n-carbs)",
  fat: "var(--n-fat)", fiber: "var(--n-fiber)", sodium: "var(--n-sodium)", sugar: "var(--n-sugar)",
};
const LABELS = Object.fromEntries(NUTRIENTS.map(([k, l]) => [k, l]));

const state = {
  view: "day", selectedDate: null, today: null,
  foods: [], pickedFood: null, range: 30, foodQuery: "",
  dash: null, hiddenSeries: new Set(),
};
const $ = (id) => document.getElementById(id);

// Layout-dependent behaviour (pantry row tap, skipping desktop-only fetches).
// Must match the breakpoint in styles.css.
const mq = window.matchMedia("(max-width: 860px)");
const isMobile = () => mq.matches;

// ── theme ────────────────────────────────────────────────────────────────────
// Three settings, two themes: "system" follows the OS, "light"/"dark" pin it.
// The <head> bootstrap has already applied the right one by the time we get here;
// this half owns changes — the toggle, and the OS flipping under a "system" pref.
const THEME_KEY = "ledger-theme";
const THEMES = ["system", "light", "dark"];
const darkMq = window.matchMedia("(prefers-color-scheme: dark)");

// localStorage throws in Safari private browsing rather than no-op'ing, and a
// theme preference is never worth taking the app down over.
function themePref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.includes(v) ? v : "system";
  } catch (e) { return "system"; }
}

function isDark(pref) { return pref === "dark" || (pref === "system" && darkMq.matches); }

function applyTheme(pref) {
  const dark = isDark(pref);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  // Tint the mobile browser chrome / iOS status bar to match the app background.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#1a1610" : "#f6f2e9");
}

function setTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch (e) { /* private mode */ }
  applyTheme(pref);
}

// Only meaningful under "system" — a pinned theme ignores the OS.
darkMq.addEventListener("change", () => {
  const pref = themePref();
  if (pref === "system") applyTheme(pref);
  if (state.view === "settings") renderThemeToggle();
});

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (e) { /* noop */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

// ── util ─────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function round2(x) { return Math.round(x * 100) / 100; }
function commas(n) { return Math.round(n).toLocaleString("en-AU"); }

// Display value for a nutrient: sodium mg -> g, everything else unchanged.
function displayValue(key, v) { return key === "sodium" ? v / 1000 : v; }
function displayUnit(key) { return key === "calories" ? "kcal" : "g"; }
function fmtDisplay(key, v) {
  const d = displayValue(key, v);
  if (key === "calories") return commas(d);
  if (key === "sodium") return (Math.round(d * 10) / 10).toFixed(1);
  return String(Math.round(d));
}

function shiftDate(dateStr, delta) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-AU",
    { weekday: "long", month: "long", day: "numeric" });
}

// ── navigation ───────────────────────────────────────────────────────────────
const SECTIONS = {
  day: "day-section", averages: "averages-section", weight: "weight-section",
  foods: "foods-section", settings: "settings-section",
};

function showView(view) {
  state.view = view;
  Object.entries(SECTIONS).forEach(([v, id]) => { $(id).hidden = v !== view; });
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  render();
}

async function render() {
  try {
    if (state.view === "day") await renderDay();
    else if (state.view === "averages") await renderDashboard();
    else if (state.view === "weight") await renderWeight();
    else if (state.view === "foods") await renderFoods();
    else if (state.view === "settings") await renderSettings();
  } catch (e) {
    console.error(e);
    alert("Error: " + e.message);
  }
}

// ── Ledger ───────────────────────────────────────────────────────────────────
function ringSvg(consumed, target) {
  const R = 31, C = 2 * Math.PI * R;
  const pct = target > 0 ? Math.min(1, consumed / target) : 0;
  return `<svg viewBox="0 0 76 76" style="width:104px;height:104px;flex:none" aria-hidden="true">
    <defs><linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--ring-a)"/><stop offset="1" stop-color="var(--ring-b)"/>
    </linearGradient></defs>
    <circle cx="38" cy="38" r="${R}" fill="none" stroke="var(--track)" stroke-width="8"/>
    <circle cx="38" cy="38" r="${R}" fill="none" stroke="url(#ring)" stroke-width="8"
      stroke-linecap="round" stroke-dasharray="${(pct * C).toFixed(1)} ${C.toFixed(1)}"
      transform="rotate(-90 38 38)"/>
    <g class="ring-label">
      <text x="38" y="35" text-anchor="middle" font-family="Open Sans" font-weight="700"
        font-size="19" fill="var(--ink)">${commas(consumed)}</text>
      <text x="38" y="49" text-anchor="middle" font-family="Open Sans" font-weight="600"
        font-size="8" fill="var(--label)">${target ? "OF " + commas(target) : "NO TARGET"}</text>
    </g>
  </svg>`;
}

function macroBars(totals, targets) {
  return MACROS.map((key) => {
    const actual = totals[key] || 0;
    const target = targets[key] || 0;
    const pct = target ? Math.min(100, (actual / target) * 100) : 0;
    const over = target && actual > target;
    const shown = target
      ? `${fmtDisplay(key, actual)}/${fmtDisplay(key, target)}`
      : fmtDisplay(key, actual);
    return `<div class="macro">
      <span class="lbl">${LABELS[key]}</span>
      <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background-color:${
        over ? "var(--over)" : NUTRIENT_COLORS[key]}"></div></div>
      <span class="mut"${over ? ' style="color:var(--over)"' : ""}>${shown}</span>
    </div>`;
  }).join("");
}

async function renderDay() {
  if (!state.selectedDate) state.selectedDate = state.today;
  const date = state.selectedDate;
  const [data] = await Promise.all([api(`/api/day/${date}`), loadFoods().catch(() => [])]);
  const { entries, totals, targets } = data;

  $("day-picker").value = date;
  $("day-title").textContent = date === state.today ? "Today" : date;
  const calTarget = targets.calories || 0;
  const remaining = calTarget - (totals.calories || 0);
  $("day-sub").textContent =
    `${prettyDate(date)} · ${entries.length} ${entries.length === 1 ? "entry" : "entries"}` +
    (calTarget ? `, ${commas(Math.max(0, remaining))} kcal left` : "");

  // Summary card. Desktop puts the running total inside the ring and the
  // remainder beside it; mobile leaves the ring bare and reads current/target.
  const consumed = totals.calories || 0;
  $("day-summary").innerHTML = `<div class="summary">
    <div style="display:flex;align-items:center;gap:22px;flex:none">
      ${ringSvg(consumed, calTarget)}
      <div class="hide-mobile">
        <div class="lbl">${remaining >= 0 ? "Remaining" : "Over by"}</div>
        <div class="big ${remaining >= 0 ? "tc" : ""}" style="font-size:40px${
          remaining < 0 ? ";color:var(--over)" : ""}">${calTarget ? commas(Math.abs(remaining)) : "—"}</div>
        <div class="mut">${calTarget ? "kcal" : "no calorie target set"}</div>
      </div>
      <div class="show-mobile">
        <div class="lbl">Calories</div>
        <div class="big" style="font-size:34px">${commas(consumed)}</div>
        <div class="mut">${calTarget ? "of " + commas(calTarget) + " kcal" : "no calorie target set"}</div>
      </div>
    </div>
    <div class="macro-grid">${macroBars(totals, targets)}</div>
  </div>`;

  // entries
  $("entries-title").textContent =
    `${date === state.today ? "Today's" : "That day's"} entries · ${entries.length}`;
  const list = $("entry-list");
  if (!entries.length) {
    list.innerHTML = '<div class="empty">Nothing logged for this day.</div>';
  } else {
    list.innerHTML = entries.map((e) => {
      const macros = ["protein", "carbs", "fat"]
        .filter((k) => e[k] != null)
        .map((k) => `${Math.round(e[k])}${k[0]}`).join(" · ");
      return `<div class="row row-hover" data-edit="${e.id}">
        <span class="mut" style="width:50px;flex:none">${escapeHtml(e.time || "—")}</span>
        <div style="flex:1;min-width:0">
          <div class="num">${escapeHtml(e.food || "")}</div>
          <div class="mut">${escapeHtml(macros || "—")}${
            e.quantity ? " · " + escapeHtml(e.quantity) : ""}</div>
        </div>
        ${e.source ? `<span class="tag hide-mobile">${escapeHtml(e.source)}</span>` : ""}
        <div class="num" style="white-space:nowrap">${
          e.calories != null ? commas(e.calories) : "—"}<span class="mut" style="font-weight:500"> kcal</span></div>
        <button class="qa danger" data-del="${e.id}" aria-label="Delete entry">✕</button>
      </div>`;
    }).join("");
    list.querySelectorAll("[data-edit]").forEach((row) => {
      row.onclick = (ev) => {
        if (ev.target.closest("[data-del]")) return;
        openEntryModal(entries.find((e) => e.id === row.dataset.edit));
      };
    });
    list.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = () => deleteEntry(b.dataset.del);
    });
  }

  // Quick add + insight live in a desktop-only column; skip the work (and the
  // extra /api/dashboard round-trip) when it isn't on screen.
  if (isMobile()) return;

  const qa = $("quick-add");
  const picks = state.foods.slice(0, 4);
  if (!picks.length) {
    qa.innerHTML = '<div class="empty">No saved foods yet.</div>';
  } else {
    qa.innerHTML = picks.map((f, i) => {
      const per = f.per || {};
      const bits = [];
      if (per.calories != null) bits.push(`${Math.round(per.calories)} kcal`);
      if (per.protein != null) bits.push(`${Math.round(per.protein)}p`);
      return `<div style="display:flex;align-items:center;gap:12px;padding:7px 0${
        i ? ";border-top:1px solid var(--divider)" : ""}">
        <div style="flex:1;min-width:0">
          <div class="num">${escapeHtml(f.name || "")}</div>
          <div class="mut">${bits.join(" · ") || "—"}</div>
        </div>
        <button class="qa" data-quick="${f.id}" aria-label="Add ${escapeHtml(f.name || "")}">＋</button>
      </div>`;
    }).join("");
    qa.querySelectorAll("[data-quick]").forEach((b) => {
      b.onclick = () => openEntryModal(null, b.dataset.quick);
    });
  }

  renderInsight(targets, totals);
}

// "On track" card — only claims what the data supports.
async function renderInsight(targets, totals) {
  const card = $("insight-card");
  let stats = null;
  try { stats = (await api("/api/dashboard")).weight_stats; } catch (e) { /* optional */ }

  const bits = [];
  if (stats && stats.n >= 2) {
    const rate = stats.weekly_rate;
    const dir = rate < 0 ? "losing" : rate > 0 ? "gaining" : "holding";
    bits.push(`You're ${dir} <b class="gr">${Math.abs(rate).toFixed(2)} kg/week</b>.`);
  }
  const pTarget = targets.protein || 0;
  const pLeft = pTarget - (totals.protein || 0);
  if (pTarget && pLeft > 0) bits.push(`${Math.round(pLeft)} g more protein to close your ring.`);
  else if (pTarget) bits.push("Protein target met.");

  if (!bits.length) { card.hidden = true; return; }
  card.hidden = false;
  card.innerHTML = `<div class="card-title tc">On track</div>
    <div class="mut" style="font-size:13px;line-height:1.5">${bits.join(" ")}</div>`;
}

// ── Dashboard ────────────────────────────────────────────────────────────────
// Take the last `n` calendar days up to today, keeping only days with data.
function windowDays(days, n, today) {
  const cutoff = shiftDate(today, -(n - 1));
  return days.filter((d) => d.date >= cutoff && d.date <= today);
}

const INTAKE_SERIES = ["calories", "protein", "carbs", "fat", "fiber"];

function dayLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

// A round gridline step that yields ~4–6 lines up to rawMax.
function niceStep(rawMax) {
  for (const s of [100, 200, 250, 500, 1000, 2000, 2500]) if (rawMax / s <= 6) return s;
  return 5000;
}

// Bars are tappable. The chart scales uniformly (no preserveAspectRatio="none"),
// so strokes, axis text and the selection highlight stay crisp at any width.
function caloriesBarChart(days, target, today) {
  const W = 560, H = 200, padL = 46, padR = 10, padT = 16, padB = 22;
  if (!days.length) return '<div class="empty">No days logged in this range.</div>';
  const plotW = W - padL - padR, plotH = H - padT - padB, baseY = padT + plotH;
  const vals = days.map((d) => d.totals.calories || 0);
  const rawMax = Math.max(target, ...vals, 1);
  const step = niceStep(rawMax);
  const niceMax = Math.ceil(rawMax / step) * step;
  const sy = (v) => padT + plotH * (1 - v / niceMax);
  const slot = plotW / days.length;
  const bw = Math.max(2, Math.min(28, slot * 0.62));

  // Left axis: horizontal gridlines at each step, labelled with the kcal value.
  let grid = "";
  for (let g = 0; g <= niceMax + 0.5; g += step) {
    const y = sy(g);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"
        stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 7}" y="${(y + 3).toFixed(1)}" text-anchor="end"
        font-family="Open Sans" font-size="9" fill="var(--label)">${commas(g)}</text>`;
  }

  const bars = days.map((d, i) => {
    const v = vals[i];
    const y = sy(v);
    const x = padL + i * slot + (slot - bw) / 2;
    const over = target && v > target;
    const isToday = d.date === today;
    // Over-target bars go pale; today is dimmed and dash-outlined, so "in
    // progress" never reads as "over target".
    const style = isToday
      ? 'opacity=".5" stroke="var(--over)" stroke-width="1" stroke-dasharray="3 2"'
      : "";
    // Full-height transparent hit target: thin bars are hard to tap otherwise.
    return `<rect class="hit" x="${(padL + i * slot).toFixed(1)}" y="${padT}"
        width="${slot.toFixed(1)}" height="${plotH.toFixed(1)}"
        data-bar="${i}" data-date="${d.date}" data-val="${v}"
        data-cx="${(padL + i * slot + slot / 2).toFixed(1)}" data-top="${y.toFixed(1)}"/>
      <rect data-bar="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}"
        height="${Math.max(1, baseY - y).toFixed(1)}" rx="3" fill="${over ? "var(--n-calories-faded)" : "var(--n-calories)"}"
        ${style}/>`;
  }).join("");

  const ty = target ? sy(target) : null;
  const targetLine = target
    ? `<line x1="${padL}" y1="${ty.toFixed(1)}" x2="${W - padR}" y2="${ty.toFixed(1)}"
         stroke="var(--n-calories)" stroke-width="1" stroke-dasharray="5 4" opacity=".55"/>
       <text x="${W - padR}" y="${(ty - 5).toFixed(1)}" text-anchor="end"
         font-family="Open Sans" font-size="9.5" fill="var(--n-calories)">target ${commas(target)}</text>`
    : "";

  // Selection layer, repositioned on tap: a soft column band behind the bar and
  // a value label above it. Far cleaner than stroking the bar itself.
  const selection = `<rect id="cal-hl" x="0" y="${padT}" width="${slot.toFixed(1)}"
      height="${plotH.toFixed(1)}" rx="7" fill="var(--n-calories)" opacity="0"/>
    <text id="cal-hl-val" x="0" y="0" text-anchor="middle" font-family="Open Sans"
      font-weight="700" font-size="11" fill="var(--ink)" opacity="0"></text>`;

  return `<div class="readout" id="cal-readout"><span class="placeholder">Tap a bar for its total</span></div>
    <svg class="chart" id="cal-chart" viewBox="0 0 ${W} ${H}"
      role="img" aria-label="Daily calories versus target">
      ${grid}<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${baseY}" stroke="var(--axis)" stroke-width="1"/>
      ${selection}${targetLine}${bars}</svg>`;
}

// Each series gets its own horizontal band, scaled to its own max — the series
// have incomparable units, so a shared y-axis would be meaningless. The legend
// filters series; points are tappable.
function intakeChart(days, hidden) {
  const W = 960, H = 170;
  if (days.length < 2) return '<div class="empty">Need at least two logged days.</div>';
  const shown = INTAKE_SERIES.filter((k) => !hidden.has(k));
  const n = days.length;
  const x = (i) => (i / (n - 1)) * (W - 20) + 10;

  const grid = [44, 88, 132].map((y) =>
    `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`).join("");

  // Bands are assigned over the visible series so a filtered chart uses the
  // full height rather than leaving gaps where hidden series used to sit.
  const bandH = 24;
  const gap = shown.length > 1 ? Math.min(32, (H - 32 - bandH) / (shown.length - 1)) : 0;
  const y = (key, s, v, maxV) => (16 + s * gap) + bandH - (v / maxV) * bandH;

  const lines = shown.map((key, s) => {
    const vals = days.map((d) => d.totals[key] || 0);
    const maxV = Math.max(...vals, 1);
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(key, s, v, maxV).toFixed(1)}`).join(" ");
    return `<polyline fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"
      stroke="${NUTRIENT_COLORS[key]}" points="${pts}"/>`;
  }).join("");

  // The chart is scaled non-uniformly, which would squash circular point
  // markers into ellipses. Select a whole day-column instead: a vertical guide
  // is distortion-immune, and it's a far bigger tap target on a phone.
  const half = n > 1 ? (W - 20) / (n - 1) / 2 : W / 2;
  const hits = days.map((d, i) =>
    `<rect class="hit" x="${Math.max(0, x(i) - half).toFixed(1)}" y="0"
       width="${Math.min(W, half * 2).toFixed(1)}" height="${H}"
       data-col="${i}" data-date="${d.date}"/>`).join("");

  const legend = INTAKE_SERIES.map((key) =>
    `<button data-series-toggle="${key}" aria-pressed="${!hidden.has(key)}">
      <span class="dot" style="background-color:${NUTRIENT_COLORS[key]}"></span>${LABELS[key]}
    </button>`).join("");

  return `<div class="readout" id="intake-readout"><span class="placeholder">Tap the chart for a day's values · tap the legend to filter</span></div>
    <svg class="chart" id="intake-chart" viewBox="0 0 ${W} ${H}" style="height:200px"
      preserveAspectRatio="none" role="img" aria-label="Intake over time">
      ${grid}<line id="intake-guide" y1="0" y2="${H}" stroke="var(--ink)" stroke-width="1"
        stroke-dasharray="3 3" opacity="0"/>${lines}${hits}</svg>
    <div class="legend">${legend}</div>`;
}

// `cached` re-renders from the last response — used by the legend filter, which
// changes nothing server-side and shouldn't cause a refetch or a flash.
async function renderDashboard(cached) {
  const dash = (cached && state.dash) ? state.dash : await api("/api/dashboard");
  state.dash = dash;
  const days = windowDays(dash.days || [], state.range, dash.today);
  const targets = dash.targets || {};
  $("dash-sub").textContent = `Averages & trends over the last ${state.range} days`;
  document.querySelectorAll("#range-seg .chip").forEach((c) => {
    c.classList.toggle("active", Number(c.dataset.range) === state.range);
  });

  // Averages exclude today: it is still in progress, so counting it drags every
  // mean down. The charts below still plot it (dimmed), it just isn't averaged.
  const logged = days.filter((d) => d.date !== dash.today && (d.totals.calories || 0) > 0);
  const avg = (key) => logged.length
    ? logged.reduce((s, d) => s + (d.totals[key] || 0), 0) / logged.length : 0;

  const avgCal = avg("calories");
  const calTarget = targets.calories || 0;
  const adherence = calTarget && avgCal ? Math.round((avgCal / calTarget) * 100) : null;

  const kpis = MACROS.map((key) => {
    const v = avg(key);
    const t = targets[key] || 0;
    const good = t && v >= t * 0.9 && v <= t * 1.1;
    return `<div class="kpi">
      <div class="lbl">${LABELS[key]}</div>
      <div class="v${good ? " gr" : ""}">${logged.length ? fmtDisplay(key, v) : "—"}</div>
      <div class="d mut">${displayUnit(key)} / day</div>
    </div>`;
  }).join("");

  $("dash-body").innerHTML = `
    <div class="cols">
      <div class="card" style="flex:1.9">
        <div class="card-title tc">Calories vs target</div>
        ${caloriesBarChart(days, calTarget, dash.today)}
      </div>
      <div class="card warm" style="flex:1;display:flex;flex-direction:column;justify-content:center;text-align:center">
        <div class="lbl tc">Avg calories</div>
        <div class="big" style="font-size:48px;margin-top:8px">${logged.length ? commas(avgCal) : "—"}</div>
        <div class="mut" style="margin-top:4px">${
          calTarget ? `of ${commas(calTarget)}${adherence ? ` · ${adherence}% adherence` : ""}`
                    : "no calorie target set"}</div>
        <div class="mut" style="margin-top:12px">${logged.length} complete ${
          logged.length === 1 ? "day" : "days"} in range · today excluded</div>
      </div>
    </div>
    <div class="grid-6">${kpis}</div>
    <div class="card">
      <div class="card-title">Intake over time</div>
      ${intakeChart(days, state.hiddenSeries)}
    </div>`;

  wireDashboardCharts(days, dash.today);
}

function wireDashboardCharts(days, today) {
  // Calories bar chart: tap a bar's column to highlight it and read the total.
  const calReadout = $("cal-readout");
  const hl = $("cal-hl");
  const hlVal = $("cal-hl-val");
  document.querySelectorAll("#cal-chart .hit").forEach((el) => {
    el.onclick = () => {
      const cx = +el.dataset.cx, w = +el.getAttribute("width"), val = +el.dataset.val;
      // Move the highlight band behind the bar and float the value above it.
      hl.setAttribute("x", (cx - w / 2).toFixed(1));
      hl.setAttribute("opacity", "0.14");
      const labelY = Math.max(11, +el.dataset.top - 6);
      hlVal.setAttribute("x", cx.toFixed(1));
      hlVal.setAttribute("y", labelY.toFixed(1));
      hlVal.textContent = commas(val);
      hlVal.setAttribute("opacity", "1");
      const isToday = el.dataset.date === today;
      calReadout.innerHTML = `<span>${dayLabel(el.dataset.date)}${
        isToday ? " (today, in progress)" : ""}</span><b>${commas(val)} kcal</b>`;
    };
  });

  // Intake chart: tap a column for every visible series' value that day.
  const intakeReadout = $("intake-readout");
  const guide = $("intake-guide");
  const byDate = Object.fromEntries(days.map((d) => [d.date, d.totals]));
  document.querySelectorAll("#intake-chart [data-col]").forEach((el) => {
    el.onclick = () => {
      const date = el.dataset.date;
      const cx = (+el.getAttribute("x")) + (+el.getAttribute("width")) / 2;
      guide.setAttribute("x1", cx);
      guide.setAttribute("x2", cx);
      guide.setAttribute("opacity", "1");
      const totals = byDate[date] || {};
      const parts = INTAKE_SERIES.filter((k) => !state.hiddenSeries.has(k)).map((k) =>
        `<span><span class="dot" style="background-color:${NUTRIENT_COLORS[k]}"></span>` +
        `<b>${fmtDisplay(k, totals[k] || 0)}</b> ${displayUnit(k)}</span>`).join("");
      intakeReadout.innerHTML = `<span>${dayLabel(date)}</span>${
        parts || '<span class="placeholder">all series hidden</span>'}`;
    };
  });

  // Legend filters the series; re-render from cache, no refetch.
  document.querySelectorAll("[data-series-toggle]").forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.seriesToggle;
      if (state.hiddenSeries.has(key)) state.hiddenSeries.delete(key);
      else state.hiddenSeries.add(key);
      // Never hide every series — the chart would be an empty box.
      if (state.hiddenSeries.size === INTAKE_SERIES.length) state.hiddenSeries.delete(key);
      renderDashboard(true);
    };
  });
}

// ── Weight ───────────────────────────────────────────────────────────────────
function wTs(w) { return new Date(w.datetime || (w.date + "T08:00")); }

function weightChart(W, stats, goal) {
  const width = 560, height = 190, padT = 14, padB = 20;
  if (W.length < 2) return '<div class="empty">Log at least two weigh-ins to see a trend.</div>';
  const t0 = wTs(W[0]);
  const xs = W.map((w) => (wTs(w) - t0) / 86400000);
  const ys = W.map((w) => w.kg);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (goal != null) { yMin = Math.min(yMin, goal); yMax = Math.max(yMax, goal); }
  const yPad = Math.max(0.4, (yMax - yMin) * 0.15);
  yMin -= yPad; yMax += yPad;
  const xMax = Math.max(...xs) || 1;
  const sx = (x) => 12 + (x / xMax) * (width - 24);
  const sy = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * (height - padT - padB);

  const raw = xs.map((x, i) => `${sx(x).toFixed(1)},${sy(ys[i]).toFixed(1)}`).join(" ");

  let trend = "", area = "";
  if (stats) {
    const y1 = stats.intercept, y2 = stats.intercept + stats.slope_per_day * xMax;
    const p1 = `${sx(0).toFixed(1)},${sy(y1).toFixed(1)}`;
    const p2 = `${sx(xMax).toFixed(1)},${sy(y2).toFixed(1)}`;
    trend = `<polyline fill="none" stroke="var(--olive)" stroke-width="2.5" stroke-linecap="round"
      stroke-dasharray="7 5" points="${p1} ${p2}"/>`;
    area = `<path d="M${p1} L${p2} L${sx(xMax).toFixed(1)},${height} L${sx(0).toFixed(1)},${height} Z"
      fill="url(#wf)"/>`;
  }
  const goalLine = goal != null
    ? `<line x1="12" y1="${sy(goal).toFixed(1)}" x2="${width - 12}" y2="${sy(goal).toFixed(1)}"
         stroke="var(--terracotta)" stroke-width="1" stroke-dasharray="4 3"/>
       <text x="${width - 12}" y="${(sy(goal) - 5).toFixed(1)}" text-anchor="end"
         font-family="Open Sans" font-size="10" fill="var(--terracotta)">goal ${goal.toFixed(1)} kg</text>`
    : "";

  const last = W[W.length - 1];
  // Visible markers, then a wider transparent hit target per weigh-in so the
  // point is tappable on touch. Handlers are wired in renderWeight.
  const markers = xs.map((x, i) => `<circle class="pt" cx="${sx(x).toFixed(1)}"
    cy="${sy(ys[i]).toFixed(1)}" r="3.5" fill="var(--olive)"><title>${
    (W[i].datetime || W[i].date).slice(0, 10)}: ${ys[i].toFixed(1)} kg</title></circle>`).join("");
  const hits = xs.map((x, i) => `<circle class="hit" cx="${sx(x).toFixed(1)}"
    cy="${sy(ys[i]).toFixed(1)}" r="14" data-w="${i}"/>`).join("");

  return `<div class="readout" id="weight-readout"><span class="placeholder">Tap a point for that weigh-in</span></div>
    <svg class="chart" id="weight-chart" viewBox="0 0 ${width} ${height}" style="height:230px"
      role="img" aria-label="Weight over time">
    <defs><linearGradient id="wf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--olive)" stop-opacity=".22"/>
      <stop offset="1" stop-color="var(--olive)" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="0" y1="46" x2="${width}" y2="46" stroke="var(--grid)"/>
    <line x1="0" y1="100" x2="${width}" y2="100" stroke="var(--grid)"/>
    <line x1="0" y1="154" x2="${width}" y2="154" stroke="var(--grid)"/>
    ${area}${goalLine}
    <polyline fill="none" stroke="var(--guide)" stroke-width="2" points="${raw}"/>
    ${trend}
    ${markers}
    <circle id="weight-sel" cx="0" cy="0" r="6" fill="var(--terracotta)" stroke="var(--card)"
      stroke-width="2.5" opacity="0"/>
    <circle cx="${sx(xs[xs.length - 1]).toFixed(1)}" cy="${sy(last.kg).toFixed(1)}" r="6"
      fill="var(--olive)" stroke="var(--card)" stroke-width="2.5"/>
    ${hits}
  </svg>`;
}

async function renderWeight() {
  const dash = await api("/api/dashboard");
  const W = dash.weights || [];
  const body = $("weight-body");
  if (!W.length) {
    body.innerHTML = '<div class="card"><div class="empty">No weigh-ins logged yet.</div></div>';
    return;
  }
  const stats = dash.weight_stats;
  const latest = W[W.length - 1];
  const goal = dash.goal_weight != null ? Number(dash.goal_weight) : null;

  // 30-day change, over whatever weigh-ins fall in that window.
  const cutoff = new Date(wTs(latest).getTime() - 30 * 86400000);
  const inWindow = W.filter((w) => wTs(w) >= cutoff);
  const delta = inWindow.length >= 2 ? latest.kg - inWindow[0].kg : null;

  // 7-day average.
  const cut7 = new Date(wTs(latest).getTime() - 7 * 86400000);
  const last7 = W.filter((w) => wTs(w) >= cut7);
  const avg7 = last7.length ? last7.reduce((s, w) => s + w.kg, 0) / last7.length : null;

  const kpi = (lbl, val, cls, suffix) =>
    `<div class="kpi"><div class="lbl">${lbl}</div><div class="v${cls ? " " + cls : ""}">${val}${
      suffix ? `<span style="font-size:14px;color:var(--label)"> ${suffix}</span>` : ""}</div></div>`;

  const rows = [...W].reverse().slice(0, 8).map((w, i, arr) => {
    const next = arr[i + 1];
    const d = next ? w.kg - next.kg : null;
    const dCls = d == null ? "mut" : d < 0 ? "gr" : "mut";
    return `<div class="row row-hover">
      <span class="mut" style="flex:1">${escapeHtml((w.datetime || w.date).replace("T", " · "))}</span>
      <span class="num">${w.kg.toFixed(1)}</span>
      <span class="${dCls}" style="font-weight:600;width:46px;text-align:right">${
        d == null ? "—" : (d < 0 ? "−" : "+") + Math.abs(d).toFixed(1)}</span>
      <button class="qa danger" data-delw="${w.id}" aria-label="Delete weigh-in">✕</button>
    </div>`;
  }).join("");

  body.innerHTML = `<div class="grid2">
    <div class="card">
      <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:6px">
        <span class="big" style="font-size:46px">${latest.kg.toFixed(1)}</span>
        <span class="mut">kg</span>
        ${delta != null ? `<span class="${delta < 0 ? "gr" : "mut"}"
          style="font-weight:600;margin-left:auto">${delta < 0 ? "▼" : "▲"} ${
          Math.abs(delta).toFixed(1)} kg · 30 days</span>` : ""}
      </div>
      ${weightChart(W, stats, goal)}
      <div style="display:flex;justify-content:space-between" class="mut">
        <span>${(W[0].datetime || W[0].date).slice(0, 10)}</span>
        <span class="gr" style="font-weight:600">trend</span>
        <span>${(latest.datetime || latest.date).slice(0, 10)}</span>
      </div>
    </div>
    <div class="stack" style="gap:16px">
      <div class="grid-2">
        ${kpi("7-day avg", avg7 != null ? avg7.toFixed(1) : "—")}
        ${kpi("Weekly Δ", stats ? (stats.weekly_rate < 0 ? "−" : "+") + Math.abs(stats.weekly_rate).toFixed(2) : "—",
              stats && stats.weekly_rate < 0 ? "gr" : "")}
        ${kpi("Maint. kcal", stats && stats.maintenance_est ? commas(stats.maintenance_est) : "—", "tc")}
        ${kpi("To goal", goal != null ? Math.abs(latest.kg - goal).toFixed(1) : "—", "", goal != null ? "kg" : "")}
      </div>
      <div class="card list">
        <div class="card-title">Recent weigh-ins</div>
        ${rows}
      </div>
    </div>
  </div>
  ${stats && stats.n < 7 ? '<div class="mut" style="padding:0 4px">Trend and maintenance estimate are provisional — reliability improves after ~7–14 weigh-ins.</div>' : ""}`;

  body.querySelectorAll("[data-delw]").forEach((b) => {
    b.onclick = () => deleteWeight(b.dataset.delw);
  });

  // Tapping a marker names that weigh-in and its change from the one before.
  const readout = $("weight-readout");
  const sel = $("weight-sel");
  body.querySelectorAll("#weight-chart [data-w]").forEach((el) => {
    el.onclick = () => {
      const i = +el.dataset.w;
      const w = W[i];
      if (sel) {
        sel.setAttribute("cx", el.getAttribute("cx"));
        sel.setAttribute("cy", el.getAttribute("cy"));
        sel.setAttribute("opacity", "1");
      }
      const prev = i > 0 ? W[i - 1] : null;
      const d = prev ? w.kg - prev.kg : null;
      const when = (w.datetime || w.date).replace("T", " · ");
      readout.innerHTML = `<span>${escapeHtml(when)}</span><b>${w.kg.toFixed(1)} kg</b>` +
        (d != null ? `<span class="${d < 0 ? "gr" : "mut"}" style="font-weight:600">${
          d < 0 ? "−" : "+"}${Math.abs(d).toFixed(1)} kg</span>` : "");
    };
  });
}

// ── Pantry ───────────────────────────────────────────────────────────────────
async function loadFoods() {
  const { foods } = await api("/api/foods");
  state.foods = foods || [];
  return state.foods;
}

async function renderFoods() {
  await loadFoods();
  const q = state.foodQuery.trim().toLowerCase();
  const items = q
    ? state.foods.filter((f) => (f.name || "").toLowerCase().includes(q))
    : state.foods;

  $("pantry-sub").textContent =
    `${state.foods.length} saved ${state.foods.length === 1 ? "item" : "items"} · click ＋ to add to today`;

  const body = $("foods-body");
  if (!state.foods.length) {
    body.innerHTML = '<div class="card"><div class="empty">No saved foods yet. ' +
      'Add one here, or use ★ Save to pantry from any entry.</div></div>';
    return;
  }
  if (!items.length) {
    body.innerHTML = `<div class="card"><div class="empty">No foods match “${escapeHtml(state.foodQuery)}”.</div></div>`;
    return;
  }

  const cell = (v, w, cls) =>
    `<span class="${cls}" style="width:${w}px;text-align:right;flex:none">${v}</span>`;
  const rows = items.map((f) => {
    const per = f.per || {};
    const n = (k) => (per[k] == null ? "—" : Math.round(per[k]));
    const isP = per.protein != null && per.protein >= 15;
    const isF = per.fat != null && per.fat >= 10;
    const serving = f.unit ? "per " + escapeHtml(f.unit) : "—";
    // Mobile shows name/serving/kcal only; macros and the row actions move into
    // the detail drawer that a tap opens.
    return `<div class="row row-hover" data-editf="${f.id}">
      <div style="flex:1;min-width:0">
        <div class="num">${escapeHtml(f.name || "")}</div>
        <div class="mut show-mobile">${serving}</div>
      </div>
      <span class="mut hide-mobile" style="width:120px;flex:none">${serving}</span>
      ${cell(n("calories"), 64, "num")}
      ${cell(n("protein"), 52, (isP ? "num gr" : "mut") + " hide-mobile")}
      ${cell(n("carbs"), 52, "mut hide-mobile")}
      ${cell(n("fat"), 52, (isF ? "num" : "mut") + " hide-mobile")}
      <span class="hide-mobile" style="width:80px;flex:none;text-align:right;white-space:nowrap">
        <button class="qa" data-logf="${f.id}" aria-label="Add to today">＋</button>
        <button class="qa danger" data-delf="${f.id}" aria-label="Delete">✕</button>
      </span>
      <span class="tc show-mobile" style="font-weight:600">›</span>
    </div>`;
  }).join("");

  body.innerHTML = `<div class="card" style="padding:6px 16px">
    <div class="row head-row">
      <span class="lbl" style="flex:1">Item</span>
      <span class="lbl hide-mobile" style="width:120px;flex:none">Serving</span>
      ${cell("Kcal", 64, "lbl")}${cell("Prot", 52, "lbl hide-mobile")}
      ${cell("Carb", 52, "lbl hide-mobile")}${cell("Fat", 52, "lbl hide-mobile")}
      <span class="hide-mobile" style="width:80px;flex:none"></span>
    </div>${rows}</div>`;

  const find = (id) => state.foods.find((f) => f.id === id);
  body.querySelectorAll("[data-editf]").forEach((row) => {
    row.onclick = (ev) => {
      if (ev.target.closest("button")) return;
      const food = find(row.dataset.editf);
      // Mobile has no row actions — a tap opens the detail drawer instead.
      if (isMobile()) openFoodDetail(food);
      else openFoodModal(food);
    };
  });
  body.querySelectorAll("[data-logf]").forEach((b) => {
    b.onclick = () => openEntryModal(null, b.dataset.logf);
  });
  body.querySelectorAll("[data-delf]").forEach((b) => {
    b.onclick = () => deleteFood(b.dataset.delf);
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────
async function renderSettings() {
  const dash = await api("/api/dashboard");
  const t = dash.targets || {};
  const inputRow = (id, label, value, attrs = 'type="number" step="any" inputmode="decimal"') =>
    `<div class="row">
      <span class="mut" style="flex:1">${label}</span>
      <input class="box" id="${id}" ${attrs} value="${value ?? ""}"
        style="width:130px;flex:none;text-align:right;padding:8px 12px">
    </div>`;

  $("settings-body").innerHTML = `
    <div class="cols" style="align-items:flex-start">
      <div class="card list" style="flex:1">
        <div class="card-title">Daily targets</div>
        ${NUTRIENTS.map(([key, label, unit]) =>
          inputRow("t-" + key, `${label}${unit ? ` (${unit})` : ""}`, t[key])).join("")}
      </div>
      <div class="stack" style="flex:1">
        <div class="card list">
          <div class="card-title">Weight goal</div>
          ${inputRow("g-weight", "Goal weight (kg)", dash.goal_weight)}
          ${inputRow("g-date", "Goal date", dash.goal_date, 'type="date"')}
        </div>
        <div class="card list">
          <div class="card-title">Appearance</div>
          <div class="row">
            <span class="mut" style="flex:1">Theme</span>
            <div class="seg" id="theme-seg" style="flex:none"></div>
          </div>
        </div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:14px">
      <div class="error" id="settings-error"></div>
      <div class="spacer"></div>
      <button class="pill fill" id="settings-save">Save changes</button>
    </div>`;
  renderThemeToggle();
  $("settings-save").onclick = saveSettings;
}

// The theme applies on tap and persists itself — it deliberately does not wait for
// "Save changes", which is scoped to the server-side targets and goal.
const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };

function renderThemeToggle() {
  const seg = $("theme-seg");
  if (!seg) return;
  const pref = themePref();
  seg.innerHTML = THEMES.map((k) =>
    `<button class="chip${k === pref ? " active" : ""}" data-theme-opt="${k}"
       aria-pressed="${k === pref}">${THEME_LABELS[k]}</button>`).join("");
  seg.querySelectorAll("[data-theme-opt]").forEach((b) => {
    b.onclick = () => { setTheme(b.dataset.themeOpt); renderThemeToggle(); };
  });
}

async function saveSettings() {
  const targets = {};
  NUTRIENTS.forEach(([key]) => {
    const v = $("t-" + key).value;
    if (v !== "") targets[key] = parseFloat(v);
  });
  const payload = { targets };
  const gw = $("g-weight").value, gd = $("g-date").value;
  if (gw !== "") payload.goal_weight = parseFloat(gw);
  if (gd !== "") payload.goal_date = gd;
  try {
    await api("/api/config", { method: "PUT", body: JSON.stringify(payload) });
    $("settings-error").textContent = "";
    render();
  } catch (e) { $("settings-error").textContent = e.message; }
}

// ── entry modal ──────────────────────────────────────────────────────────────
function quantityLabel(q, unit) { return unit ? `${q} × ${unit}` : String(q); }

// Client mirror of core.catalogue: scale a saved food's per-unit nutrients by
// the quantity. The POST still sends absolute values.
function applyFoodScale() {
  const item = state.pickedFood;
  if (!item) { $("entry-hint").textContent = ""; return; }
  const raw = parseFloat($("f-qty").value);
  const q = isNaN(raw) ? 0 : raw;
  const per = item.per || {};
  $("f-food").value = item.name || "";
  $("f-source").value = item.source || "";
  $("f-quantity").value = quantityLabel(q, item.unit);
  NUTRIENTS.forEach(([key]) => {
    $("f-" + key).value = per[key] != null ? round2(per[key] * q) : "";
  });
  $("entry-hint").innerHTML =
    `Auto-filled from pantry · ×${q} — edit any field, or type it in manually.`;
}

function populateCatalogueSelect(selectedId) {
  const sel = $("f-catalogue");
  sel.innerHTML = '<option value="">— none —</option>' +
    state.foods.map((f) =>
      `<option value="${f.id}">${escapeHtml(f.name)}${
        f.unit ? " (per " + escapeHtml(f.unit) + ")" : ""}</option>`).join("");
  sel.value = selectedId || "";
}

async function openEntryModal(entry, presetFoodId) {
  const editing = !!entry;
  $("entry-modal-title").textContent = editing ? "Edit entry" : "Add entry";
  $("entry-modal").dataset.id = editing ? entry.id : "";
  const now = new Date();
  $("f-food").value = entry?.food || "";
  $("f-date").value = entry?.date || state.selectedDate || state.today;
  $("f-time").value = entry?.time || now.toTimeString().slice(0, 5);
  $("f-quantity").value = entry?.quantity || "";
  $("f-source").value = entry?.source || "";
  $("f-notes").value = entry?.notes || "";
  NUTRIENTS.forEach(([key]) => { $("f-" + key).value = entry?.[key] ?? ""; });

  state.pickedFood = null;
  $("f-qty").value = "1";
  $("entry-hint").textContent = "";
  try {
    await loadFoods();
    populateCatalogueSelect(presetFoodId || "");
    if (presetFoodId) {
      const item = state.foods.find((f) => f.id === presetFoodId);
      if (item) { state.pickedFood = item; applyFoodScale(); }
    }
  } catch (e) { /* picker is optional; entry still works without it */ }

  $("entry-error").textContent = "";
  $("entry-modal").hidden = false;
}

function entryPayload() {
  const p = {
    food: $("f-food").value.trim(),
    date: $("f-date").value,
    time: $("f-time").value || null,
  };
  ["quantity", "source", "notes"].forEach((k) => {
    const v = $("f-" + k).value.trim();
    if (v) p[k] = v;
  });
  NUTRIENTS.forEach(([key]) => {
    const v = $("f-" + key).value;
    if (v !== "") p[key] = parseFloat(v);
  });
  return p;
}

async function saveEntry() {
  const p = entryPayload();
  if (!p.food) { $("entry-error").textContent = "Food is required."; return; }
  if (!p.date) { $("entry-error").textContent = "Date is required."; return; }
  const id = $("entry-modal").dataset.id;
  try {
    if (id) await api(`/api/entries/${id}`, { method: "PATCH", body: JSON.stringify(p) });
    else await api("/api/entries", { method: "POST", body: JSON.stringify(p) });
    $("entry-modal").hidden = true;
    state.selectedDate = p.date;
    showView("day");
  } catch (e) { $("entry-error").textContent = e.message; }
}

async function deleteEntry(id) {
  if (!confirm("Delete this entry?")) return;
  try {
    await api(`/api/entries/${id}`, { method: "DELETE" });
    render();
  } catch (e) { alert("Error: " + e.message); }
}

// ── pantry modal ─────────────────────────────────────────────────────────────
// Build an (unsaved) catalogue item from an entry's values, treating them as
// one unit. The user confirms the serving before saving.
function foodFromEntry(e) {
  const per = {};
  NUTRIENTS.forEach(([key]) => {
    if (e[key] != null && e[key] !== "") per[key] = parseFloat(e[key]);
  });
  return { name: e.food || "", source: e.source || "", unit: "", per };
}

// Read-only detail drawer (mobile). Holds the macros and the row actions that
// the compact mobile list drops: edit, track, delete.
function openFoodDetail(food) {
  if (!food) return;
  const per = food.per || {};
  $("food-detail-modal").dataset.id = food.id;
  $("fd-name").textContent = food.name || "";
  $("fd-serving").textContent = food.unit ? "Per " + food.unit : "Per serving";
  $("fd-calories").textContent = per.calories != null ? commas(per.calories) : "—";
  $("fd-macros").innerHTML = MACROS.map((key) => `<div class="kpi">
    <div class="lbl">${LABELS[key]}</div>
    <div class="v" style="font-size:19px">${per[key] != null ? fmtDisplay(key, per[key]) : "—"}</div>
    <div class="d mut">${displayUnit(key)}</div>
  </div>`).join("");
  const src = $("fd-source");
  src.textContent = food.source ? "Source: " + food.source : "";
  src.hidden = !food.source;
  $("food-detail-modal").hidden = false;
}

function openFoodModal(food) {
  const editing = !!(food && food.id);
  $("food-modal-title").textContent = editing ? "Edit pantry item" : "New pantry item";
  $("food-modal").dataset.id = editing ? food.id : "";
  const per = (food && food.per) || {};
  $("cf-name").value = food?.name || "";
  $("cf-unit").value = food?.unit || "";
  $("cf-source").value = food?.source || "";
  NUTRIENTS.forEach(([key]) => { $("cf-" + key).value = per[key] ?? ""; });
  $("food-error").textContent = "";
  $("food-modal").hidden = false;
}

function foodPayload() {
  const per = {};
  NUTRIENTS.forEach(([key]) => {
    const v = $("cf-" + key).value;
    if (v !== "") per[key] = parseFloat(v);
  });
  const p = { name: $("cf-name").value.trim(), per };
  const unit = $("cf-unit").value.trim();
  const source = $("cf-source").value.trim();
  if (unit) p.unit = unit;
  if (source) p.source = source;
  return p;
}

async function saveFood() {
  const p = foodPayload();
  if (!p.name) { $("food-error").textContent = "Name is required."; return; }
  const id = $("food-modal").dataset.id;
  try {
    if (id) await api(`/api/foods/${id}`, { method: "PATCH", body: JSON.stringify(p) });
    else await api("/api/foods", { method: "POST", body: JSON.stringify(p) });
    $("food-modal").hidden = true;
    await loadFoods();
    render();
  } catch (e) { $("food-error").textContent = e.message; }
}

// Returns true if the food was actually deleted (i.e. the user confirmed).
async function deleteFood(id) {
  if (!confirm("Delete this saved food? Past entries are unaffected.")) return false;
  try {
    await api(`/api/foods/${id}`, { method: "DELETE" });
    await loadFoods();
    render();
    return true;
  } catch (e) { alert("Error: " + e.message); return false; }
}

// ── weight modal ─────────────────────────────────────────────────────────────
// Seed with the most recent weigh-in so the ± steppers start somewhere useful.
async function openWeightModal() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  $("w-datetime").value = local.toISOString().slice(0, 16);
  $("w-kg").value = "";
  $("weight-error").textContent = "";
  $("weight-modal").hidden = false;
  try {
    const W = (await api("/api/dashboard")).weights || [];
    if (W.length && $("w-kg").value === "") $("w-kg").value = W[W.length - 1].kg;
  } catch (e) { /* seeding is optional */ }
}

function nudgeWeight(delta) {
  const cur = parseFloat($("w-kg").value);
  $("w-kg").value = round2((isNaN(cur) ? 0 : cur) + delta);
}

async function saveWeight() {
  const dt = $("w-datetime").value, kg = $("w-kg").value;
  if (!dt || kg === "") { $("weight-error").textContent = "Date/time and weight are required."; return; }
  try {
    await api("/api/weights", { method: "POST", body: JSON.stringify({ datetime: dt, kg: parseFloat(kg) }) });
    $("weight-modal").hidden = true;
    render();
  } catch (e) { $("weight-error").textContent = e.message; }
}

async function deleteWeight(id) {
  if (!confirm("Delete this weigh-in?")) return;
  try {
    await api(`/api/weights/${id}`, { method: "DELETE" });
    render();
  } catch (e) { alert("Error: " + e.message); }
}

// ── wire up ──────────────────────────────────────────────────────────────────
document.querySelectorAll("[data-view]").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.view === "day" && !state.selectedDate) state.selectedDate = state.today;
    showView(b.dataset.view);
  };
});

// Day navigation
const goDay = (date) => { state.selectedDate = date; renderDay(); };
$("day-prev").onclick = () => goDay(shiftDate(state.selectedDate || state.today, -1));
$("day-next").onclick = () => goDay(shiftDate(state.selectedDate || state.today, 1));
$("day-today").onclick = () => goDay(state.today);
$("day-picker").onchange = (e) => { if (e.target.value) goDay(e.target.value); };
$("add-entry-btn").onclick = () => openEntryModal(null);

// Dashboard range
document.querySelectorAll("#range-seg .chip").forEach((c) => {
  c.onclick = () => { state.range = Number(c.dataset.range); renderDashboard(); };
});

// Entry modal
$("entry-cancel").onclick = () => { $("entry-modal").hidden = true; };
$("entry-cancel-x").onclick = () => { $("entry-modal").hidden = true; };
$("entry-save").onclick = saveEntry;
$("f-catalogue").onchange = (e) => {
  state.pickedFood = state.foods.find((f) => f.id === e.target.value) || null;
  if (state.pickedFood) {
    if ($("f-qty").value === "") $("f-qty").value = "1";
    applyFoodScale();
  } else { $("entry-hint").textContent = ""; }
};
$("f-qty").oninput = () => { if (state.pickedFood) applyFoodScale(); };
$("f-qty-dec").onclick = () => {
  const v = parseFloat($("f-qty").value);
  $("f-qty").value = Math.max(0, round2((isNaN(v) ? 1 : v) - 0.5));
  if (state.pickedFood) applyFoodScale();
};
$("f-qty-inc").onclick = () => {
  const v = parseFloat($("f-qty").value);
  $("f-qty").value = round2((isNaN(v) ? 0 : v) + 0.5);
  if (state.pickedFood) applyFoodScale();
};
$("entry-save-food").onclick = () => {
  const e = { food: $("f-food").value.trim(), source: $("f-source").value.trim() };
  NUTRIENTS.forEach(([key]) => { e[key] = $("f-" + key).value; });
  $("entry-modal").hidden = true;
  openFoodModal(foodFromEntry(e));
};

// Pantry detail drawer
const fdFood = () => state.foods.find((f) => f.id === $("food-detail-modal").dataset.id);
const fdClose = () => { $("food-detail-modal").hidden = true; };
$("fd-close").onclick = fdClose;
$("fd-edit").onclick = () => { const f = fdFood(); if (!f) return; fdClose(); openFoodModal(f); };
$("fd-track").onclick = () => { const f = fdFood(); if (!f) return; fdClose(); openEntryModal(null, f.id); };
$("fd-delete").onclick = async () => {
  if (await deleteFood($("food-detail-modal").dataset.id)) fdClose();
};

// Pantry
$("add-food-btn").onclick = () => openFoodModal(null);
$("food-cancel").onclick = () => { $("food-modal").hidden = true; };
$("food-cancel-x").onclick = () => { $("food-modal").hidden = true; };
$("food-save").onclick = saveFood;
$("food-search").oninput = (e) => { state.foodQuery = e.target.value; renderFoods(); };

// Weight
$("add-weight-btn").onclick = openWeightModal;
$("weight-cancel").onclick = () => { $("weight-modal").hidden = true; };
$("weight-cancel-x").onclick = () => { $("weight-modal").hidden = true; };
$("weight-save").onclick = saveWeight;
$("w-dec").onclick = () => nudgeWeight(-0.1);
$("w-inc").onclick = () => nudgeWeight(0.1);

// Dismiss any dialog by clicking the scrim or pressing Escape.
document.querySelectorAll(".scrim").forEach((s) => {
  s.onclick = (e) => { if (e.target === s) s.hidden = true; };
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".scrim").forEach((s) => { s.hidden = true; });
});

async function init() {
  // The <head> bootstrap already set data-theme for dark; re-applying normalises
  // the light case to an explicit value and tints the browser chrome to match.
  applyTheme(themePref());
  const { today } = await api("/api/today");
  state.today = today;
  state.selectedDate = today;
  showView("day");
}
init();
