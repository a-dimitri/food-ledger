// Display diagnostics (temporary): what the device reports about its viewport
// and system-bar insets, plus a test bar fixed to the bottom exactly like the
// Today page's pinned bar, to see where it actually lands. Linked from Settings.

import { esc } from "../util.js";

export async function render(root) {
  root.innerHTML = `<div class="page narrow">
    <div class="card list"><div class="card-title">Display diagnostics</div><div data-rows></div></div>
    <div class="mut">Screenshot this page and send it over. The bar at the bottom is a copy of the Today page's bar: it should sit fully above the system navigation bar.</div>
    <div class="pinbar debug-bar"><span class="pill grow">Test bar — fully visible?</span></div>
  </div>`;

  // env() can't be read from JS directly; measure it as an element's padding.
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  root.appendChild(probe);

  const paint = () => {
    const cs = getComputedStyle(probe);
    const bar = root.querySelector(".debug-bar").getBoundingClientRect();
    const vv = window.visualViewport;
    const mode = ["standalone", "minimal-ui", "fullscreen", "browser"].find((m) => matchMedia(`(display-mode: ${m})`).matches) || "?";
    const rows = [
      ["Display mode", mode],
      ["Window (inner)", `${innerWidth} × ${innerHeight}`],
      ["Visual viewport", vv ? `${Math.round(vv.width)} × ${Math.round(vv.height)}` : "n/a"],
      ["Screen", `${screen.width} × ${screen.height} @${devicePixelRatio}x`],
      ["Safe area (t r b l)", [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" ")],
      ["Test bar top / bottom", `${Math.round(bar.top)} / ${Math.round(bar.bottom)}`],
      ["Theme", document.documentElement.dataset.theme || "light"],
      ["Browser", navigator.userAgent],
    ];
    root.querySelector("[data-rows]").innerHTML = rows.map(([k, v]) =>
      `<div class="row"><span class="lbl w60" style="width:130px">${esc(k)}</span><span class="mut grow" style="word-break:break-word">${esc(v)}</span></div>`).join("");
  };
  paint();
  window.addEventListener("resize", paint);
  window.visualViewport?.addEventListener("resize", paint);
}
