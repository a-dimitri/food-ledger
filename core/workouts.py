"""Workouts — top-set tracking per exercise.

One Firestore doc per workout; each exercise records only its top set:

    workout: {date, name, routine_id|None, notes|None, bodyweight_kg|None,
              exercises: [{exercise_id, name, kg|None, reps, bw_factor?}],
              exercise_ids: [exercise_id, ...]}   # for array-contains queries

`name` on each exercise is a snapshot, so renaming or deleting a catalogue
exercise never rewrites past workouts (same rule as pantry → entries).

Bodyweight exercises (catalogue equipment "bodyweight") carry `bw_factor`, the
share of bodyweight the movement lifts (1.0 for pull-ups and dips, ~0.65 for
push-ups), snapshotted from the catalogue at save. For those, `kg` is the
*added* load: empty means bodyweight only, negative means assisted. The
workout's `bodyweight_kg` is likewise snapshotted when it's saved, so later
weigh-ins never rewrite a past session's estimates.

Pure functions over plain dicts — no Firestore dependency.
"""

from __future__ import annotations

import math
from datetime import date as Date, timedelta
from typing import Any, Callable, Iterable, Optional

Workout = dict[str, Any]

# Fixed vocabularies for the shared exercise catalogue.
MUSCLE_GROUPS = ("chest", "back", "legs", "shoulders", "arms", "core")
EQUIPMENT = ("barbell", "dumbbell", "cable", "machine", "bodyweight")

# Estimates are a rough fit beyond this many reps; above it they're flagged.
RELIABLE_REPS = 12

# 1RM formulas, as the multiplier on the load lifted for `reps` reps. Chosen per
# exercise in the catalogue (`e1rm_formula`, default Epley). Both agree within a
# few percent up to ~10 reps; past that Epley keeps growing linearly while
# Mayhew flattens, crediting high-rep sets less.
FORMULAS: dict[str, Callable[[int], float]] = {
    "epley": lambda r: 1 + r / 30,
    "mayhew": lambda r: 100 / (52.2 + 41.9 * math.exp(-0.055 * r)),
}
DEFAULT_FORMULA = "epley"


def is_bodyweight(ex: dict[str, Any]) -> bool:
    return ex.get("bw_factor") is not None


def normalise(workout: Workout) -> Workout:
    """Validate a workout and derive `exercise_ids`. Raises ValueError."""
    if not workout.get("date"):
        raise ValueError("date is required")
    try:
        Date.fromisoformat(workout["date"])
    except ValueError:
        raise ValueError("date must be 'YYYY-MM-DD'")
    bw = workout.get("bodyweight_kg")
    if bw is not None and (isinstance(bw, bool) or not isinstance(bw, (int, float)) or bw <= 0):
        raise ValueError("bodyweight_kg must be a positive number")
    exercises = workout.get("exercises") or []
    for ex in exercises:
        label = ex.get("name") or ex.get("exercise_id")
        if not ex.get("exercise_id"):
            raise ValueError("each exercise needs an exercise_id")
        reps = ex.get("reps")
        if not isinstance(reps, int) or isinstance(reps, bool) or reps < 1:
            raise ValueError(f"reps must be a positive integer for {label}")
        kg = ex.get("kg")
        if kg is not None and (isinstance(kg, bool) or not isinstance(kg, (int, float))):
            raise ValueError(f"kg must be a number for {label}")
        if is_bodyweight(ex):
            # Added load may be negative (assisted), but never more assistance
            # than the bodyweight being lifted.
            if bw is not None and kg is not None and ex["bw_factor"] * bw + kg <= 0:
                raise ValueError(f"assistance for {label} can't exceed the bodyweight lifted")
        elif kg is not None and kg < 0:
            raise ValueError(f"kg must be a non-negative number for {label}")
    # dict.fromkeys de-duplicates while keeping order.
    return {**workout, "exercises": exercises,
            "exercise_ids": list(dict.fromkeys(ex["exercise_id"] for ex in exercises))}


def estimate_1rm(kg: Optional[float], reps: int, formula: Optional[str] = None) -> Optional[float]:
    """Estimated one-rep max for `kg` lifted `reps` times. A single is taken as
    the 1RM itself, whatever the formula."""
    if kg is None:
        return None
    if reps == 1:
        return float(kg)
    return round(kg * FORMULAS[formula or DEFAULT_FORMULA](reps), 1)


def epley_1rm(kg: Optional[float], reps: int) -> Optional[float]:
    """Estimated one-rep max (Epley) for `kg` lifted `reps` times."""
    return estimate_1rm(kg, reps, "epley")


def set_estimate(ex: dict[str, Any], bodyweight: Optional[float],
                 formula: Optional[str] = None) -> dict[str, Optional[float]]:
    """1RM estimates for one top set.

    e1rm        what the 1RM is quoted in: total kg for loaded lifts; for
                bodyweight lifts the *added* kg you could take for one rep
    e1rm_total  the full load moved for one rep (bodyweight share included)
    Both None when they can't be computed (a bodyweight set with no known
    bodyweight, or a loaded set without kg).
    """
    reps, kg = ex["reps"], ex.get("kg")
    if not is_bodyweight(ex):
        e = estimate_1rm(kg, reps, formula)
        return {"e1rm": e, "e1rm_total": e}
    if bodyweight is None:
        return {"e1rm": None, "e1rm_total": None}
    lifted = ex["bw_factor"] * bodyweight
    total = estimate_1rm(lifted + (kg or 0.0), reps, formula)
    return {"e1rm": round(total - lifted, 1), "e1rm_total": total}


def bodyweight_on(weights: Iterable[dict[str, Any]], date: str) -> Optional[float]:
    """The bodyweight to use for `date`: the last weigh-in on or before it, else
    the first one after. `weights` are {datetime, kg} docs, any order."""
    ws = sorted(weights, key=lambda w: w.get("datetime") or "")
    before = [w for w in ws if (w.get("datetime") or "")[:10] <= date]
    if before:
        return float(before[-1]["kg"])
    return float(ws[0]["kg"]) if ws else None


def exercise_history(workouts: Iterable[Workout], exercise_id: str,
                     weights: Iterable[dict[str, Any]] = (),
                     formula: Optional[str] = None) -> list[dict[str, Any]]:
    """Every top set logged for one exercise, oldest first:
    [{date, workout_id, workout_name, kg, reps, bw_factor, bodyweight, e1rm,
      e1rm_total, approx}].

    For bodyweight exercises `kg` is the added load (0 for bodyweight only).
    A workout saved without a bodyweight falls back to the weigh-ins.
    `formula` is the exercise's 1RM formula (computed on read, so changing it
    re-scores the whole history).
    """
    weights = list(weights)
    rows = []
    for w in workouts:
        for ex in w.get("exercises") or []:
            if ex.get("exercise_id") != exercise_id:
                continue
            bw_ex = is_bodyweight(ex)
            bodyweight = (w.get("bodyweight_kg") or bodyweight_on(weights, w["date"])) if bw_ex else None
            rows.append({
                "date": w["date"],
                "workout_id": w.get("id"),
                "workout_name": w.get("name"),
                "kg": (ex.get("kg") or 0.0) if bw_ex else ex.get("kg"),
                "reps": ex["reps"],
                "bw_factor": ex.get("bw_factor"),
                "bodyweight": bodyweight,
                **set_estimate(ex, bodyweight, formula),
                "approx": ex["reps"] > RELIABLE_REPS,
            })
    rows.sort(key=lambda r: r["date"])
    return rows


def best_set(history: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The set with the highest estimated 1RM (ties go to the later one)."""
    weighted = [r for r in history if r["e1rm"] is not None]
    if not weighted:
        return None
    return max(reversed(weighted), key=lambda r: r["e1rm"])


def kg_change(history: list[dict[str, Any]], since: Optional[str] = None) -> Optional[float]:
    """Change in top-set kg (added kg, for bodyweight lifts) from the first
    session on/after `since` (or the previous session when `since` is None) to
    the latest one. None when there aren't two sessions with a load to compare."""
    weighted = [r for r in history if r["kg"] is not None]
    if since is not None:
        weighted = [r for r in weighted if r["date"] >= since]
        pair = (weighted[0], weighted[-1]) if len(weighted) >= 2 else None
    else:
        pair = (weighted[-2], weighted[-1]) if len(weighted) >= 2 else None
    if pair is None:
        return None
    return round(pair[1]["kg"] - pair[0]["kg"], 2)


def week_start(date: str) -> str:
    """The Monday of `date`'s week."""
    d = Date.fromisoformat(date)
    return (d - timedelta(days=d.weekday())).isoformat()


def weekly_counts(workouts: Iterable[Workout]) -> dict[str, int]:
    """Workouts per week, keyed by the week's Monday, oldest first."""
    counts: dict[str, int] = {}
    for w in workouts:
        wk = week_start(w["date"])
        counts[wk] = counts.get(wk, 0) + 1
    return dict(sorted(counts.items()))
