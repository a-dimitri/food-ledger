"""Derived-value computation — day totals, averages, and weight regression.

This module is the replacement for build_tracker.py's calculation logic (the
HTML templating is not carried over; that becomes the web UI). Everything here
is a pure function over plain dicts that match the Firestore document shape:

    entry:  {"date": "YYYY-MM-DD", "time": "HH:MM", "food": str,
             "calories": num|None, "protein": num|None, ...}
    weight: {"datetime": "YYYY-MM-DDTHH:MM", "kg": num}
            (legacy date-only weigh-ins {"date": ...} default to 08:00)

No derived value is ever persisted; callers compute on read.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable, Optional

from .nutrients import NUTRIENT_KEYS

Entry = dict[str, Any]
Weight = dict[str, Any]

# Energy per kg of body mass, used for the maintenance-calorie estimate.
KCAL_PER_KG = 7700


def _num(v: Any) -> float | None:
    """Return v as a number, or None for '', None, or booleans."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def day_total(entries: Iterable[Entry], date: str) -> dict[str, float]:
    """Sum each nutrient across all entries on `date`."""
    totals = {k: 0.0 for k in NUTRIENT_KEYS}
    for e in entries:
        if e.get("date") == date:
            for k in NUTRIENT_KEYS:
                v = _num(e.get(k))
                if v is not None:
                    totals[k] += v
    return totals


def all_day_totals(entries: list[Entry], dates: Iterable[str]) -> dict[str, dict[str, float]]:
    """Per-day nutrient totals for each date in `dates`."""
    return {d: day_total(entries, d) for d in dates}


def entry_dates(entries: Iterable[Entry]) -> list[str]:
    """Sorted unique dates that have at least one entry."""
    return sorted({e["date"] for e in entries})


def tracked_dates(
    entries: Iterable[Entry], today: str, completed: Iterable[str] = ()
) -> list[str]:
    """Dates that count toward averages.

    Every day with entries except `today`, unless `today` is explicitly marked
    complete (so an in-progress day isn't averaged against fully-logged ones).
    """
    completed_set = set(completed)
    return sorted(
        {e["date"] for e in entries if e["date"] != today or e["date"] in completed_set}
    )


def averages_from_day_totals(
    day_totals: dict[str, dict[str, float]],
    today: str,
    completed: Iterable[str] = (),
    ndigits: int = 1,
) -> tuple[dict[str, float], int]:
    """Mean daily intake across fully-tracked days, from per-day totals.

    `day_totals` maps date -> {nutrient: total} — the shape stored in the `days`
    rollup collection, so the dashboard computes averages from O(days) rollups
    rather than re-summing every entry. Tracked days are all keys except `today`,
    unless `today` is in `completed`.

    Returns (averages_by_nutrient, tracked_day_count).
    """
    completed_set = set(completed)
    tracked = sorted(d for d in day_totals if d != today or d in completed_set)
    result = {k: 0.0 for k in NUTRIENT_KEYS}
    if tracked:
        for k in NUTRIENT_KEYS:
            total = sum(day_totals[d].get(k, 0.0) for d in tracked)
            result[k] = round(total / len(tracked), ndigits)
    return result, len(tracked)


def averages(
    entries: list[Entry],
    today: str,
    completed: Iterable[str] = (),
    ndigits: int = 1,
) -> tuple[dict[str, float], int]:
    """Mean daily intake across fully-tracked days, computed from raw entries.

    Convenience wrapper over averages_from_day_totals for callers holding entries
    (and for tests). Production reads go through the rollups.
    """
    day_totals = all_day_totals(entries, entry_dates(entries))
    return averages_from_day_totals(day_totals, today, completed, ndigits)


def phase_summary(
    phase: dict[str, Any],
    day_totals: dict[str, dict[str, float]],
    today: str,
    completed: Iterable[str] = (),
    tolerance: float = 0.10,
) -> dict[str, Any]:
    """Average intake and calorie adherence over one phase's tracked days.

    Tracked days follow the same rule as averages_from_day_totals. Adherence is
    the share of tracked days whose calories landed within ±`tolerance` of the
    phase's calorie target (None when the phase has no calorie target).
    """
    end = phase.get("end") or "9999-12-31"
    in_phase = {d: t for d, t in day_totals.items() if phase["start"] <= d <= end}
    avgs, count = averages_from_day_totals(in_phase, today, completed)
    target = (phase.get("targets") or {}).get("calories")
    adherence = None
    if target and count:
        completed_set = set(completed)
        tracked = [d for d in in_phase if d != today or d in completed_set]
        hits = sum(1 for d in tracked
                   if abs(in_phase[d].get("calories", 0.0) - target) <= tolerance * target)
        adherence = round(hits / len(tracked), 3)
    return {"averages": avgs, "tracked_count": count, "adherence": adherence}


def bmi(kg: float, height_cm: Optional[float]) -> Optional[float]:
    """Body-mass index, or None without a height."""
    if not height_cm:
        return None
    m = height_cm / 100
    return round(kg / (m * m), 1)


def _parse_weight_ts(w: Weight) -> datetime:
    """Timestamp of a weigh-in. Legacy date-only entries default to 08:00."""
    ts = w.get("datetime")
    if ts:
        return datetime.fromisoformat(ts)
    return datetime.fromisoformat(w["date"] + "T08:00")


def weight_stats(weights: list[Weight], avg_calories: float = 0.0) -> dict[str, Any] | None:
    """Linear regression of weight over continuous time.

    x is fractional days from the first weigh-in; y is kg. Returns slope
    (kg/day), weekly rate, intercept, latest reading, count, and — if
    `avg_calories` is provided — an estimated maintenance calorie intake
    derived from the observed rate of change. Returns None with < 2 weigh-ins.
    """
    ws = sorted(weights, key=lambda w: w.get("datetime") or w.get("date", ""))
    if len(ws) < 2:
        return None

    t0 = _parse_weight_ts(ws[0])
    xs = [(_parse_weight_ts(w) - t0).total_seconds() / 86400.0 for w in ws]
    ys = [float(w["kg"]) for w in ws]
    n = len(xs)

    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    sxx = sum((x - mean_x) ** 2 for x in xs)
    sxy = sum((xs[i] - mean_x) * (ys[i] - mean_y) for i in range(n))
    slope = sxy / sxx if sxx else 0.0  # kg per day
    intercept = mean_y - slope * mean_x
    weekly_rate = slope * 7  # kg per week

    daily_deficit = -weekly_rate * KCAL_PER_KG / 7
    maintenance_est = round(avg_calories + daily_deficit) if avg_calories else None

    return {
        "slope_per_day": round(slope, 4),
        "weekly_rate": round(weekly_rate, 3),
        "intercept": round(intercept, 3),
        "t0": t0.isoformat(),
        "n": n,
        "latest": ys[-1],
        "avg_intake": round(avg_calories) if avg_calories else None,
        "maintenance_est": maintenance_est,
    }
