// Three settings, two themes: "system" follows the OS, "light"/"dark" pin it.
// The <head> bootstrap applies the right one before first paint; this module
// owns changes — the Settings toggle, and the OS flipping under "system".
// Per device (localStorage), not per profile.

const KEY = "ledger-theme";
export const THEMES = ["system", "light", "dark"];
const darkMq = window.matchMedia("(prefers-color-scheme: dark)");

// localStorage throws in Safari private browsing rather than no-op'ing, and a
// theme preference is never worth taking the app down over.
export function themePref() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : "system";
  } catch (e) { return "system"; }
}

export function applyTheme(pref) {
  const dark = pref === "dark" || (pref === "system" && darkMq.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  // Tint the mobile browser chrome / iOS status bar to match the app background.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#1a1610" : "#f6f2e9");
}

export function setTheme(pref) {
  try { localStorage.setItem(KEY, pref); } catch (e) { /* private mode */ }
  applyTheme(pref);
}

darkMq.addEventListener("change", () => { if (themePref() === "system") applyTheme("system"); });
