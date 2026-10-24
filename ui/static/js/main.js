// App shell: routing, the top bar / sub-tabs / drawer, profile switching.
//
// Routes are hash paths (#/training/workouts/<id>) so the browser and phone back
// buttons work without any server routing. Each view module exports
// `render(root, params)`; the shell owns everything around it.

import { session, loadMe, rememberedProfile, rememberProfile, activeProfile, invalidate } from "./api.js";
import { $, esc } from "./util.js";
import { nav, onBreakpointChange } from "./nav.js";
import { applyTheme, themePref } from "./theme.js";
import { closeAllSheets, toast } from "./sheet.js";

import * as today from "./views/today.js";
import * as history from "./views/history.js";
import * as profiles from "./views/profiles.js";
import * as workouts from "./views/workouts.js";
import * as routines from "./views/routines.js";
import * as exercises from "./views/exercises.js";
import * as pantry from "./views/pantry.js";
import * as phases from "./views/phases.js";
import * as insights from "./views/insights.js";
import * as settings from "./views/settings.js";

// Sections and their sub-pages, in nav order (desktop top bar + mobile drawer).
const SECTIONS = [
  { id: "today", label: "Today", drawer: "Log", subs: [["today", "Today"], ["today/history", "History"]] },
  { id: "training", label: "Training", drawer: "Training",
    subs: [["training/workouts", "Workouts"], ["training/routines", "Routines"], ["training/exercises", "Exercises"]] },
  { id: "nutrition", label: "Nutrition", drawer: "Nutrition", subs: [["nutrition/pantry", "Pantry"], ["nutrition/phases", "Phases"]] },
  { id: "insights", label: "Insights", drawer: "Insights",
    subs: [["insights/nutrition", "Nutrition"], ["insights/weight", "Weight"], ["insights/lifts", "Lifts"]] },
];

// path -> [view module, mobile title, back target for mobile sub-pages]
const ROUTES = {
  "today": [today, "Today"],
  "today/history": [history, "History"],
  "profiles": [profiles, "Profiles", "#/today"],
  "training/workouts": [workouts, "Workouts"],
  "training/workouts/:id": [workouts, "Workout", "#/training/workouts"],
  "training/routines": [routines, "Routines"],
  "training/exercises": [exercises, "Exercises"],
  "training/exercises/:id": [exercises, "Exercise", "#/training/exercises"],
  "nutrition/pantry": [pantry, "Pantry"],
  "nutrition/phases": [phases, "Phases"],
  "insights/nutrition": [insights, "Dashboard"],
  "insights/weight": [insights, "Dashboard"],
  "insights/lifts": [insights, "Dashboard"],
  "settings": [settings, "Settings"],
};

function match(path) {
  if (ROUTES[path]) return { key: path, params: {} };
  const parts = path.split("/");
  for (const key of Object.keys(ROUTES)) {
    const kp = key.split("/");
    if (kp.length !== parts.length) continue;
    const params = {};
    if (kp.every((seg, i) => (seg.startsWith(":") ? (params[seg.slice(1)] = decodeURIComponent(parts[i]), true) : seg === parts[i]))) {
      return { key, params };
    }
  }
  return null;
}

function go(hash) {
  if (location.hash === hash) refresh();
  else location.hash = hash;
}

let current = null;

async function route() {
  closeAllSheets();
  closeDrawer();
  const path = (location.hash.replace(/^#\/?/, "") || "today").split("?")[0];
  const m = match(path);
  if (!m) { location.hash = "#/today"; return; }
  const [view, title, back] = ROUTES[m.key];
  current = { view, params: { ...m.params, route: m.key, path }, title, back };
  paintShell();
  await refresh();
}

// Re-render the current view (after a write, a profile switch, a resize across
// the breakpoint). Views fetch through the cache, so this is cheap.
async function refresh() {
  if (!current) return;
  const root = $("view");
  try {
    await current.view.render(root, current.params);
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="page"><div class="card"><div class="empty">Couldn't load this page: ${esc(e.message)}</div></div></div>`;
  }
  paintShell();
}

function paintShell() {
  if (!current) return;
  const path = current.params.path;
  const section = SECTIONS.find((s) => s.subs.some(([p]) => path === p || path.startsWith(p + "/"))) || null;

  $("sections").innerHTML = SECTIONS.map((s) =>
    `<a class="tab${section === s ? " on" : ""}" href="#/${s.subs[0][0]}">${s.label}</a>`).join("");
  $("subtabs").innerHTML = section ? section.subs.map(([p, label]) =>
    `<a class="subtab${path === p || path.startsWith(p + "/") ? " on" : ""}" href="#/${p}">${label}</a>`).join("") : "";
  $("subtabs").hidden = !section;
  $("settings-btn").classList.toggle("on", path === "settings");

  $("page-title").textContent = current.title;
  const back = current.back && (current.params.id || current.params.route === "profiles");
  $("back-btn").hidden = !back;
  $("menu-btn").hidden = !!back;
  if (back) $("back-btn").href = current.back;

  const prof = activeProfile();
  const av = $("avatar");
  av.textContent = (prof?.name || "·")[0].toUpperCase();
  av.style.background = prof?.colour || "";
  av.title = prof ? `${prof.name} — profiles` : "Profiles";

  const pill = $("phase-pill");
  const ph = prof?.active_phase;
  pill.hidden = !ph;
  if (ph) {
    pill.textContent = ph.kind === "untracked" ? (ph.name || "Untracked")
      : `${ph.name} · wk ${ph.week}${ph.total_weeks ? "/" + ph.total_weeks : ""}`;
    pill.style.background = ph.kind === "untracked" ? "var(--untracked-ink)" : ph.colour || "var(--terracotta)";
  }

  renderDrawer(path);
}

// ── drawer (mobile) ──────────────────────────────────────────────────────────
// As the mobile wireframe groups it; Insights' three tabs are one "Dashboard".
const DRAWER = [
  ["Log", [["today", "Today"], ["today/history", "History"]]],
  ["Training", [["training/workouts", "Workouts"], ["training/routines", "Routines"], ["training/exercises", "Exercises"]]],
  ["Nutrition", [["nutrition/pantry", "Pantry"], ["nutrition/phases", "Phases"]]],
  ["Insights", [["insights", "Dashboard"]]],
];

function renderDrawer(path) {
  const on = (p) => path === p || path.startsWith(p + "/");
  const link = (p, label) => `<a class="drawer-item${on(p) ? " on" : ""}" href="#/${p === "insights" ? "insights/nutrition" : p}">${label}</a>`;
  $("drawer").innerHTML = `<div class="brand">Ledger</div>` +
    DRAWER.map(([sec, items]) => `<div class="lbl drawer-sec">${sec}</div>` + items.map(([p, l]) => link(p, l)).join("")).join("") +
    `<div class="spacer"></div>${link("settings", "Settings")}`;
}
function openDrawer() { $("drawer").hidden = false; $("drawer-scrim").hidden = false; }
function closeDrawer() { $("drawer").hidden = true; $("drawer-scrim").hidden = true; }
$("menu-btn").onclick = openDrawer;
$("drawer-scrim").onclick = closeDrawer;

// ── profiles ─────────────────────────────────────────────────────────────────
// Re-fetch /api/me (phase pill, avatar, latest weights) and repaint.
async function reloadMe() {
  invalidate("shared:me");
  session.me = await loadMe();
  paintShell();
}

async function switchProfile(id) {
  rememberProfile(id);
  await reloadMe();
  toast(`Now viewing ${activeProfile()?.name || id}`);
  go("#/today");
}

// Crossing the mobile/desktop breakpoint changes layouts (list+detail vs pages).
onBreakpointChange(() => refresh());

async function init() {
  applyTheme(themePref());
  try {
    session.me = await loadMe();
  } catch (e) {
    $("view").innerHTML = `<div class="page"><div class="card"><div class="empty">${
      e.status === 403 ? "This Google account isn't linked to a profile." : "Couldn't reach the tracker: " + esc(e.message)}</div></div></div>`;
    return;
  }
  session.today = session.me.today;
  const remembered = rememberedProfile();
  const ids = session.me.profiles.map((x) => x.id);
  session.profileId = ids.includes(remembered) ? remembered : session.me.profile_id;
  // Only route once /api/me has loaded: every view assumes a profile.
  window.addEventListener("hashchange", route);
  await route();
}

Object.assign(nav, { go, refresh, reloadMe, switchProfile });
init();
