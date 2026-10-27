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
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
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
// Bodyweight exercises carry `bw_factor` (share of bodyweight lifted); for them
// `kg` is the ADDED load (empty = bodyweight only, negative = assisted), and 1RM
// estimates are quoted as added kg. See core/workouts.py.
export const RELIABLE_REPS = 12;
export const isBodyweight = (ex) => ex?.bw_factor != null;

// 1RM formulas as the multiplier on the load lifted; chosen per exercise
// (catalogue `e1rm_formula`). Mirrors core.workouts.FORMULAS.
export const FORMULAS = {
  epley: { label: "Epley", f: (r) => 1 + r / 30 },
  mayhew: { label: "Mayhew", f: (r) => 100 / (52.2 + 41.9 * Math.exp(-0.055 * r)) },
};
export const DEFAULT_FORMULA = "epley";

// A single counts as the 1RM itself, whatever the formula.
export function estimate1rm(kgv, reps, formula) {
  if (kgv == null) return null;
  if (reps === 1) return kgv;
  return Math.round(kgv * FORMULAS[formula || DEFAULT_FORMULA].f(reps) * 10) / 10;
}
export const epley = (kgv, reps) => estimate1rm(kgv, reps, "epley");

// {e1rm, e1rm_total} for one top set; e1rm is added kg for bodyweight lifts.
export function setEstimate(ex, bodyweight, formula) {
  if (!isBodyweight(ex)) { const e = estimate1rm(ex.kg ?? null, ex.reps, formula); return { e1rm: e, e1rm_total: e }; }
  if (bodyweight == null) return { e1rm: null, e1rm_total: null };
  const lifted = ex.bw_factor * bodyweight;
  const total = estimate1rm(lifted + (ex.kg || 0), ex.reps, formula);
  return { e1rm: Math.round((total - lifted) * 10) / 10, e1rm_total: total };
}

// Last weigh-in on/before `date`, else the first after.
export function bodyweightOn(weights, date) {
  const ws = [...(weights || [])].sort((a, b) => (a.datetime < b.datetime ? -1 : 1));
  const before = ws.filter((w) => w.datetime.slice(0, 10) <= date);
  if (before.length) return before[before.length - 1].kg;
  return ws.length ? ws[0].kg : null;
}

// Every top set for one exercise across `workouts`, oldest first.
export function exerciseHistory(workouts, exerciseId, weights = [], formula = null) {
  const rows = [];
  for (const w of workouts) {
    for (const ex of w.exercises || []) {
      if (ex.exercise_id !== exerciseId) continue;
      const bw = isBodyweight(ex);
      const bodyweight = bw ? (w.bodyweight_kg ?? bodyweightOn(weights, w.date)) : null;
      rows.push({
        date: w.date, workout: w, reps: ex.reps, bw_factor: ex.bw_factor ?? null, bodyweight,
        kg: bw ? (ex.kg ?? 0) : (ex.kg ?? null),
        ...setEstimate(ex, bodyweight, formula), approx: ex.reps > RELIABLE_REPS,
      });
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
// The top set for `exerciseId` in the workout logged most recently before `beforeDate`.
export function previousSet(workouts, exerciseId, beforeDate) {
  const hist = exerciseHistory(workouts, exerciseId).filter((r) => r.date < beforeDate);
  return hist.length ? hist[hist.length - 1] : null;
}
// "80 × 8", or for bodyweight lifts "BW × 12" / "BW+10 × 8" / "BW−20 × 5".
export function loadLabel(s) {
  if (!isBodyweight(s)) return kgShort(s.kg ?? null);
  const added = s.kg || 0;
  return added > 0 ? `BW+${round2(added)}` : added < 0 ? `BW−${round2(-added)}` : "BW";
}
export const setLabel = (s) => (s ? `${loadLabel(s)} × ${s.reps}` : "—");
// An estimated 1RM for display: "+33.5" for bodyweight (added) lifts, "≈" when rough.
export function e1rmLabel(r, { total = false } = {}) {
  const v = total ? r?.e1rm_total : r?.e1rm;
  if (v == null) return "—";
  const shown = isBodyweight(r) && !total ? (v >= 0 ? `+${kg(v)}` : `−${kg(-v)}`) : kg(v);
  return (r.approx ? "≈" : "") + shown;
}

// Debounce for search boxes.
export function debounce(fn, ms = 150) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
