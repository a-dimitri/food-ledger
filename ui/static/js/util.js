// Shared constants and small pure helpers: nutrients, dates, formatting, HTML.

// key, label, unit. Sodium is stored and entered in mg; summaries show it in g.
export const NUTRIENTS = [
  ["calories", "Calories", "kcal"], ["protein", "Protein", "g"], ["carbs", "Carbs", "g"],
  ["fat", "Fat", "g"], ["fiber", "Fibre", "g"], ["sodium", "Sodium", "mg"], ["sugar", "Sugar", "g"],
];
export const NUTRIENT_KEYS = NUTRIENTS.map(([k]) => k);
export const MACROS = ["protein", "carbs", "fat", "fiber", "sodium", "sugar"];
export const LABELS = Object.fromEntries(NUTRIENTS.map(([k, l]) => [k, l]));
export const SHORT = { protein: "P", carbs: "C", fat: "F", fiber: "Fib", sodium: "Na", sugar: "Sug" };

// Indirections into the --n-* custom properties, not literals: the charts are
// inline SVG, so var() resolves in fill/stroke and a theme swap recolours them.
export const NUTRIENT_COLORS = {
  calories: "var(--n-calories)", protein: "var(--n-protein)", carbs: "var(--n-carbs)",
  fat: "var(--n-fat)", fiber: "var(--n-fiber)", sodium: "var(--n-sodium)", sugar: "var(--n-sugar)",
};

// Colour choices offered for phases and profiles (stored as hex on the doc).
export const PHASE_COLOURS = ["#c05f3e", "#cf9646", "#5f7d4a", "#9bab6f", "#6f7fa0", "#8a5a83", "#a68a64"];
export const PROFILE_COLOURS = ["#c05f3e", "#1e1b16", "#5f7d4a", "#6f7fa0", "#8a5a83"];

export const MUSCLE_GROUPS = ["chest", "back", "legs", "shoulders", "arms", "core"];
export const EQUIPMENT = ["barbell", "dumbbell", "cable", "machine", "bodyweight"];

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
export const round2 = (x) => Math.round(x * 100) / 100;
export const commas = (n) => Math.round(n).toLocaleString("en-AU");
export function kg(n) { return n == null ? "—" : (Math.round(n * 10) / 10).toFixed(1); }
export function kgShort(n) { return n == null ? "BW" : String(round2(n)); }
export function signed(n, digits = 1) {
  if (n == null) return "—";
  const v = Math.abs(n).toFixed(digits);
  return n > 0 ? `+${v}` : n < 0 ? `−${v}` : `±${v}`;
}

// Display a nutrient: sodium mg -> g, everything else as stored.
export function fmtNutrient(key, v) {
  if (v == null) return "—";
  if (key === "calories") return commas(v);
  if (key === "sodium") return (Math.round(v / 100) / 10).toFixed(1);
  return String(Math.round(v));
}
export const nutrientUnit = (key) => (key === "calories" ? "kcal" : "g");

// ── dates (all 'YYYY-MM-DD' strings in Sydney local terms) ────────────────────
const pad = (n) => String(n).padStart(2, "0");
export function toISO(dt) { return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`; }
export function parseISO(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
export function shiftDate(s, days) { const d = parseISO(s); d.setDate(d.getDate() + days); return toISO(d); }
export function shiftMonths(s, months) { const d = parseISO(s); d.setMonth(d.getMonth() + months); return toISO(d); }
export function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
export function weekStart(s) { const d = parseISO(s); return shiftDate(s, -((d.getDay() + 6) % 7)); }

export function fmtDate(s, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return parseISO(s).toLocaleDateString("en-AU", opts);
}
export const fmtDay = (s) => fmtDate(s, { day: "numeric", month: "short" });
export const fmtMonth = (s) => fmtDate(s, { month: "long", year: "numeric" });
export function nowTime() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// ── phases (client mirror of core.phases) ────────────────────────────────────
const OPEN_END = "9999-12-31";
export const phaseEnd = (p) => p.end || OPEN_END;
export function phaseOn(phases, date) {
  return (phases || []).find((p) => p.start <= date && date <= phaseEnd(p)) || null;
}
export function targetsFor(phases, date, defaults) {
  const p = phaseOn(phases, date);
  if (!p) return defaults || {};
  if (p.kind === "untracked") return null;
  return p.targets || {};
}
export function isUntracked(phases, date) { const p = phaseOn(phases, date); return !!(p && p.kind === "untracked"); }
export function weekOf(p, date) {
  const week = Math.floor(daysBetween(p.start, date) / 7) + 1;
  const total = p.end ? Math.ceil((daysBetween(p.start, p.end) + 1) / 7) : null;
  return [week, total];
}
export function phaseLabel(p, date) {
  if (!p) return "";
  if (p.kind === "untracked") return p.name || "Untracked";
  const [w, t] = weekOf(p, date);
  return `${p.name} · wk ${w}${t ? "/" + t : ""}`;
}

// ── workouts (client mirror of core.workouts) ────────────────────────────────
export function epley(kgv, reps) {
  if (kgv == null) return null;
  return reps === 1 ? kgv : Math.round(kgv * (1 + reps / 30) * 10) / 10;
}
// Every top set for one exercise across `workouts`, oldest first.
export function exerciseHistory(workouts, exerciseId) {
  const rows = [];
  for (const w of workouts) {
    for (const ex of w.exercises || []) {
      if (ex.exercise_id === exerciseId) {
        rows.push({ date: w.date, workout: w, kg: ex.kg ?? null, reps: ex.reps, e1rm: epley(ex.kg ?? null, ex.reps) });
      }
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
// The top set for `exerciseId` in the workout logged most recently before `beforeDate`.
export function previousSet(workouts, exerciseId, beforeDate) {
  const hist = exerciseHistory(workouts, exerciseId).filter((r) => r.date < beforeDate);
  return hist.length ? hist[hist.length - 1] : null;
}
export const setLabel = (s) => (s ? `${kgShort(s.kg)} × ${s.reps}` : "—");

// Debounce for search boxes.
export function debounce(fn, ms = 150) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
