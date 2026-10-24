// API client + a small per-session cache.
//
// Reads go through `cached(key, loader)`; any write calls `invalidate()` for the
// keys it affects, so views re-fetch only what changed. Per-profile routes are
// built with `p()` from the active profile id held in `session`.

export const session = {
  me: null,          // /api/me response
  profileId: null,   // the profile being viewed (switchable from the avatar)
  today: null,
};

const PROFILE_KEY = "ledger-profile";

export function rememberProfile(id) {
  session.profileId = id;
  try { localStorage.setItem(PROFILE_KEY, id); } catch (e) { /* private mode */ }
}
export function rememberedProfile() {
  try { return localStorage.getItem(PROFILE_KEY); } catch (e) { return null; }
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body !== undefined && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail
        : Array.isArray(body.detail) ? body.detail.map((d) => d.msg).join("; ") : detail;
    } catch (e) { /* not JSON */ }
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

export const p = (path) => `/api/p/${encodeURIComponent(session.profileId)}${path}`;

const cache = new Map();

// Cache key namespaced by profile for per-profile data.
const scoped = (key) => (key.startsWith("shared:") ? key : `${session.profileId}:${key}`);

export function cached(key, loader) {
  const k = scoped(key);
  if (!cache.has(k)) {
    const promise = loader().catch((e) => { cache.delete(k); throw e; });
    cache.set(k, promise);
  }
  return cache.get(k);
}

// Invalidate by prefix, e.g. invalidate("day:", "dash") after a food entry.
export function invalidate(...prefixes) {
  for (const k of [...cache.keys()]) {
    const bare = k.startsWith("shared:") ? k : k.slice(k.indexOf(":") + 1);
    if (prefixes.some((pre) => bare.startsWith(pre) || k.startsWith(pre))) cache.delete(k);
  }
}

// ── loaders ─────────────────────────────────────────────────────────────────
export const loadMe = () => cached("shared:me", () => api("/api/me"));
export const loadFoods = () => cached("shared:foods", async () => (await api("/api/foods")).foods);
export const loadExercises = () => cached("shared:exercises", async () => (await api("/api/exercises")).exercises);
export const loadDay = (date) => cached(`day:${date}`, () => api(p(`/day/${date}`)));
export const loadDash = () => cached("dash", () => api(p("/dashboard")));
export const loadWorkouts = () => cached("workouts", async () => (await api(p("/workouts"))).workouts);
export const loadRoutines = () => cached("routines", async () => (await api(p("/routines"))).routines);
export const loadPhases = () => cached("phases", async () => (await api(p("/phases"))).phases);
export const loadHistory = (id) => cached(`history:${id}`, () => api(p(`/exercises/${id}/history`)));

export function activeProfile() {
  return (session.me?.profiles || []).find((x) => x.id === session.profileId) || null;
}
