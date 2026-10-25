// SVG charts, drawn at the container's real pixel width (and redrawn on resize)
// so text and strokes stay crisp and legible on a phone.
//
// Every chart over time takes the profile's phases: phase windows are drawn as
// tinted bands, and series lines break across untracked windows rather than
// interpolating over time that wasn't tracked.

import { NUTRIENT_COLORS, MACROS, LABELS, SHORT, commas, daysBetween, esc, fmtDay, fmtNutrient,
  phaseEnd, shiftDate } from "./util.js";

// ── mounting ─────────────────────────────────────────────────────────────────
const observers = new WeakMap();

// Render `draw(width)` into `el` now and whenever its width changes. `draw`
// returns {svg, wire?(svgEl)} or a plain string.
export function mount(el, draw) {
  if (!el) return;
  const render = () => {
    const width = Math.max(240, Math.floor(el.clientWidth));
    if (el._w === width) return;
    el._w = width;
    const out = draw(width);
    el.innerHTML = typeof out === "string" ? out : out.svg;
    if (out && out.wire) out.wire(el);
  };
  render();
  if (!observers.has(el)) {
    const ro = new ResizeObserver(() => render());
    ro.observe(el);
    observers.set(el, ro);
  }
}

// ── small pieces ─────────────────────────────────────────────────────────────
export function ring(consumed, target, size = 92) {
  const R = 31, C = 2 * Math.PI * R;
  const pct = target > 0 ? Math.min(1, consumed / target) : 0;
  const over = target > 0 && consumed > target;
  return `<svg viewBox="0 0 76 76" style="width:${size}px;height:${size}px;flex:none" aria-hidden="true">
    <circle cx="38" cy="38" r="${R}" fill="none" stroke="var(--track)" stroke-width="8"/>
    <circle cx="38" cy="38" r="${R}" fill="none" stroke="${over ? "var(--over)" : "var(--n-calories)"}" stroke-width="8"
      stroke-linecap="round" stroke-dasharray="${(pct * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 38 38)"/>
  </svg>`;
}

const hasTarget = (targets, key) => (targets?.[key] || 0) > 0;

/**
 * Nutrients against targets. Only nutrients with a target get a bar (value /
 * target); the rest are listed as plain totals on one line beneath, so an
 * empty bar never suggests a goal that doesn't exist.
 *   oneCol    bars in a single column (narrow cards)
 *   compact   short labels (P, C, F…) for a phone
 *   noTargets html shown when none of `keys` has a target (e.g. a "set targets" link)
 */
export function nutrientSummary(totals, targets, keys = MACROS, { oneCol = false, compact = false, noTargets = "" } = {}) {
  const tracked = keys.filter((k) => hasTarget(targets, k));
  const plain = keys.filter((k) => !hasTarget(targets, k));
  const bars = tracked.map((key) => {
    const actual = totals?.[key] || 0, target = targets[key];
    const over = actual > target;
    return `<div class="macro">
      <span class="lbl">${esc(compact ? SHORT[key] || LABELS[key] : LABELS[key])}</span>
      <div class="bar-bg"><div class="bar-fill" style="width:${Math.min(100, (actual / target) * 100)}%;background-color:${over ? "var(--over)" : NUTRIENT_COLORS[key]}"></div></div>
      <span class="mut"${over ? ' style="color:var(--over)"' : ""}>${fmtNutrient(key, actual)}/${fmtNutrient(key, target)}</span>
    </div>`;
  }).join("");
  const totalsLine = plain.length ? `<div class="untargeted mut">${plain.map((key) =>
    `<span>${esc(LABELS[key])} <b>${fmtNutrient(key, totals?.[key] || 0)}</b> g</span>`).join("")}</div>` : "";
  return `<div class="nutrients">
    ${tracked.length ? `<div class="macro-grid${oneCol || tracked.length === 1 ? " one-col" : ""}">${bars}</div>` : ""}
    ${totalsLine}
    ${!tracked.length && noTargets ? `<div class="mut">${noTargets}</div>` : ""}
  </div>`;
}

// Thin horizontal strip of a year's phases (Phases page).
export function yearStrip(phases, year) {
  const start = `${year}-01-01`, end = `${year}-12-31`;
  const span = daysBetween(start, end) + 1;
  const blocks = (phases || []).filter((p) => p.start <= end && phaseEnd(p) >= start).map((p) => {
    const a = p.start < start ? start : p.start;
    const b = phaseEnd(p) > end ? end : phaseEnd(p);
    const left = (daysBetween(start, a) / span) * 100;
    const width = ((daysBetween(a, b) + 1) / span) * 100;
    const fill = p.kind === "untracked" ? "var(--untracked)" : p.colour || "var(--terracotta)";
    return `<div class="ys-block${p.kind === "untracked" ? " ys-untracked" : ""}" title="${esc(p.name || "Untracked")}"
      style="left:${left}%;width:${width}%;background:${fill}"></div>`;
  }).join("");
  return `<div class="year-strip">${blocks}</div>
    <div class="ys-axis mut"><span>Jan</span><span>Apr</span><span>Jul</span><span>Oct</span><span>Dec</span></div>`;
}

// ── time charts ──────────────────────────────────────────────────────────────
function niceTicks(lo, hi, count = 4) {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return ticks;
}

// Whether the line between two points must break: an untracked window touches
// the interval between them (unless both points sit inside the same window).
function breaksBetween(untracked, a, b) {
  return untracked.some((u) => {
    if (u.start > b || phaseEnd(u) < a) return false;
    const aIn = u.start <= a && a <= phaseEnd(u);
    const bIn = u.start <= b && b <= phaseEnd(u);
    return !(aIn && bIn);
  });
}

function bands(phases, start, end, sx, top, height) {
  return (phases || []).filter((p) => p.kind === "phase" && p.start <= end && phaseEnd(p) >= start).map((p) => {
    const a = p.start < start ? start : p.start;
    const b = phaseEnd(p) > end ? end : phaseEnd(p);
    const x1 = sx(a), x2 = sx(shiftDate(b, 1));
    return `<rect x="${x1.toFixed(1)}" y="${top}" width="${Math.max(1, x2 - x1).toFixed(1)}" height="${height}"
      fill="${p.colour || "var(--terracotta)"}" opacity=".13"/>`;
  }).join("");
}

/**
 * Line chart over dates.
 *  cfg.start/end    ISO date domain
 *  cfg.phases       bands + line breaks
 *  cfg.series       [{color, points:[{date, v}], dash?, step?, width?, dots?}]
 *  cfg.yFmt         tick label formatter
 *  cfg.readout      (date) => html for the tapped day
 */
export function timeChart(cfg) {
  const H = cfg.height || 200;
  return (W) => {
    const padL = 42, padR = 12, padT = 12, padB = 22;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const span = Math.max(1, daysBetween(cfg.start, cfg.end) + 1);
    const sx = (d) => padL + (daysBetween(cfg.start, d) / span) * plotW;
    const vals = cfg.series.flatMap((s) => s.points.map((p) => p.v)).filter((v) => v != null);
    if (!vals.length) return `<div class="empty">${esc(cfg.empty || "Nothing to show in this range.")}</div>`;
    let lo = cfg.yMin ?? Math.min(...vals), hi = cfg.yMax ?? Math.max(...vals);
    if (cfg.zero) lo = 0;
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
    if (!cfg.zero) lo -= pad;
    hi += pad;
    const sy = (v) => padT + plotH * (1 - (v - lo) / (hi - lo));
    const untracked = (cfg.phases || []).filter((p) => p.kind === "untracked");

    const grid = niceTicks(lo, hi).map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${sy(t).toFixed(1)}" y2="${sy(t).toFixed(1)}" stroke="var(--grid)"/>
      <text x="${padL - 6}" y="${(sy(t) + 3).toFixed(1)}" text-anchor="end" class="tick">${esc((cfg.yFmt || commas)(t))}</text>`).join("");

    // x labels: start, middle, end
    const mid = shiftDate(cfg.start, Math.floor(span / 2));
    const xl = [[cfg.start, "start"], [mid, "middle"], [cfg.end, "end"]].map(([d, anchor]) =>
      `<text x="${sx(d).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}" class="tick">${esc(fmtDay(d))}</text>`).join("");

    const lines = cfg.series.map((s) => {
      const pts = s.points.filter((p) => p.date >= cfg.start && p.date <= cfg.end);
      let d = "", prev = null;
      for (const pt of pts) {
        if (pt.v == null) { prev = null; continue; }
        const x = sx(pt.date) + (s.step ? 0 : plotW / span / 2), y = sy(pt.v);
        if (prev && !breaksBetween(untracked, prev.date, pt.date)) {
          d += s.step ? ` H${x.toFixed(1)} V${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`;
        } else {
          d += ` M${x.toFixed(1)},${y.toFixed(1)}`;
        }
        prev = pt;
      }
      if (s.step && prev) d += ` H${sx(shiftDate(prev.date, 1)).toFixed(1)}`;
      const dots = s.dots ? pts.filter((p) => p.v != null).map((p) =>
        `<circle cx="${(sx(p.date) + plotW / span / 2).toFixed(1)}" cy="${sy(p.v).toFixed(1)}" r="2.6" fill="${s.color}"/>`).join("") : "";
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round"
        stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}${s.opacity ? ` opacity="${s.opacity}"` : ""}/>${dots}`;
    }).join("");

    const svg = `<div class="readout" data-readout><span class="placeholder">${esc(cfg.hint || "Tap the chart for a day's values")}</span></div>
      <svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.label || "chart")}">
        ${bands(cfg.phases, cfg.start, cfg.end, sx, padT, plotH)}
        ${grid}${xl}${lines}
        <line data-guide y1="${padT}" y2="${padT + plotH}" stroke="var(--ink)" stroke-dasharray="3 3" opacity="0"/>
        <rect data-hit x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
      </svg>`;

    const wire = (el) => {
      if (!cfg.readout) return;
      const hit = el.querySelector("[data-hit]"), guide = el.querySelector("[data-guide]");
      const out = el.querySelector("[data-readout]");
      const pick = (ev) => {
        const r = hit.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        const date = shiftDate(cfg.start, Math.min(span - 1, Math.floor(frac * span)));
        const x = sx(date) + plotW / span / 2;
        guide.setAttribute("x1", x); guide.setAttribute("x2", x); guide.setAttribute("opacity", ".5");
        out.innerHTML = cfg.readout(date);
      };
      hit.addEventListener("click", pick);
      hit.addEventListener("pointermove", (ev) => { if (ev.pointerType === "mouse") pick(ev); });
    };
    return { svg, wire };
  };
}

/** Bars per week (keys are the weeks' Mondays), with phase bands behind. */
export function weekBars(cfg) {
  const H = cfg.height || 160;
  return (W) => {
    const padL = 30, padR = 10, padT = 10, padB = 22;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const span = Math.max(1, daysBetween(cfg.start, cfg.end) + 1);
    const sx = (d) => padL + (daysBetween(cfg.start, d) / span) * plotW;
    const entries = Object.entries(cfg.counts || {}).filter(([wk]) => wk <= cfg.end && shiftDate(wk, 6) >= cfg.start);
    const max = Math.max(1, ...entries.map(([, c]) => c));
    const sy = (v) => padT + plotH * (1 - v / max);
    const bw = Math.max(3, (7 / span) * plotW * 0.66);
    const bars = entries.map(([wk, c]) => {
      const x = sx(wk) + ((7 / span) * plotW - bw) / 2;
      return `<rect x="${x.toFixed(1)}" y="${sy(c).toFixed(1)}" width="${bw.toFixed(1)}" height="${(padT + plotH - sy(c)).toFixed(1)}"
        rx="2" fill="var(--ink)"><title>${esc(fmtDay(wk))}: ${c}</title></rect>`;
    }).join("");
    const ticks = niceTicks(0, max, Math.min(4, max)).map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${sy(t)}" y2="${sy(t)}" stroke="var(--grid)"/>
      <text x="${padL - 6}" y="${sy(t) + 3}" text-anchor="end" class="tick">${t}</text>`).join("");
    const xl = [[cfg.start, "start"], [cfg.end, "end"]].map(([d, a]) =>
      `<text x="${sx(d).toFixed(1)}" y="${H - 6}" text-anchor="${a}" class="tick">${esc(fmtDay(d))}</text>`).join("");
    if (!entries.length) return `<div class="empty">No workouts in this range.</div>`;
    return `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Workouts per week">
      ${bands(cfg.phases, cfg.start, cfg.end, sx, padT, plotH)}${ticks}${xl}${bars}</svg>`;
  };
}

export const RANGE_DAYS = { "1m": 30, "3m": 91, "6m": 182, "1y": 365 };
export const rangeStart = (today, range) => shiftDate(today, -((RANGE_DAYS[range] || 182) - 1));
