// Overlays: one component, three presentations.
//
//   kind "panel"   desktop: slides in from the right, page stays visible
//   kind "dialog"  desktop: centred
//   mobile:        both become bottom sheets; `full: true` makes a full screen
//
// Overlays stack (e.g. "new exercise" opened from inside "log workout"); Escape
// and the scrim close the top one.

import { esc } from "./util.js";

const stack = [];

export function openSheet({ title, kind = "dialog", full = false, wide = false, body = "", foot = "", onClose } = {}) {
  const scrim = document.createElement("div");
  scrim.className = `scrim scrim-${kind}`;
  scrim.innerHTML = `
    <div class="sheet sheet-${kind}${full ? " sheet-full" : ""}${wide ? " sheet-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="grab"></div>
      <div class="s-head">
        <h2 class="s-title">${esc(title)}</h2>
        <button class="x" data-close aria-label="Close">✕</button>
      </div>
      <div class="s-body">${body}</div>
      ${foot ? `<div class="s-foot">${foot}</div>` : ""}
    </div>`;
  const entry = { scrim, onClose };
  scrim.addEventListener("click", (e) => { if (e.target === scrim) closeSheet(); });
  scrim.querySelector("[data-close]").onclick = () => closeSheet();
  document.body.appendChild(scrim);
  document.body.classList.add("has-sheet");
  stack.push(entry);
  const sheet = scrim.querySelector(".sheet");
  const first = sheet.querySelector("input:not([type=hidden]):not([readonly]), select, textarea");
  // Don't pop the keyboard on phones just because a sheet opened.
  if (first && !matchMedia("(max-width: 860px)").matches) first.focus();
  return sheet;
}

export function closeSheet() {
  const entry = stack.pop();
  if (!entry) return;
  entry.scrim.remove();
  if (!stack.length) document.body.classList.remove("has-sheet");
  if (entry.onClose) entry.onClose();
}

export function closeAllSheets() { while (stack.length) closeSheet(); }

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && stack.length) closeSheet(); });

// Error line inside a sheet (every sheet body gets one via formError()).
export const formError = () => '<div class="error" data-error></div>';
export function showError(sheet, msg) {
  const el = sheet.querySelector("[data-error]");
  if (el) el.textContent = msg || "";
}

// Wrap a save handler: disables the button while running, surfaces errors in
// the sheet rather than an alert.
export function busy(sheet, button, fn) {
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    showError(sheet, "");
    try { await fn(); } catch (e) { showError(sheet, e.message); } finally { button.disabled = false; }
  };
}

let toastTimer;
export function toast(msg, kind = "ok") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast toast-${kind} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
