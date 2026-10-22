"""Workouts — top-set tracking per exercise.

One Firestore doc per workout; each exercise records only its top set:

    workout: {date, name, routine_id|None, notes|None,
              exercises: [{exercise_id, name, kg|None, reps}],
              exercise_ids: [exercise_id, ...]}   # for array-contains queries

`name` on each exercise is a snapshot, so renaming or deleting a catalogue
exercise never rewrites past workouts (same rule as pantry → entries).
`kg` is optional so bodyweight movements can be logged as reps only.

Pure functions over plain dicts — no Firestore dependency.
"""

from __future__ import annotations

from datetime import date as Date, timedelta
from typing import Any, Iterable, Optional

Workout = dict[str, Any]

# Fixed vocabularies for the shared exercise catalogue.
MUSCLE_GROUPS = ("chest", "back", "legs", "shoulders", "arms", "core")
EQUIPMENT = ("barbell", "dumbbell", "cable", "machine", "bodyweight")


def normalise(workout: Workout) -> Workout:
    """Validate a workout and derive `exercise_ids`. Raises ValueError."""
    if not workout.get("date"):
        raise ValueError("date is required")
    try:
        Date.fromisoformat(workout["date"])
    except ValueError:
        raise ValueError("date must be 'YYYY-MM-DD'")
    exercises = workout.get("exercises") or []
    for ex in exercises:
        if not ex.get("exercise_id"):
            raise ValueError("each exercise needs an exercise_id")
        reps = ex.get("reps")
        if not isinstance(reps, int) or isinstance(reps, bool) or reps < 1:
            raise ValueError(f"reps must be a positive integer for {ex.get('name') or ex['exercise_id']}")
        kg = ex.get("kg")
        if kg is not None and (isinstance(kg, bool) or not isinstance(kg, (int, float)) or kg < 0):
            raise ValueError(f"kg must be a non-negative number for {ex.get('name') or ex['exercise_id']}")
    # dict.fromkeys de-duplicates while keeping order.
    return {**workout, "exercises": exercises,
            "exercise_ids": list(dict.fromkeys(ex["exercise_id"] for ex in exercises))}


def epley_1rm(kg: Optional[float], reps: int) -> Optional[float]:
    """Estimated one-rep max (Epley). None for a bodyweight (kg-less) set."""
    if kg is None:
        return None
    if reps == 1:
        return float(kg)
    return round(kg * (1 + reps / 30), 1)


def exercise_history(workouts: Iterable[Workout], exercise_id: str) -> list[dict[str, Any]]:
    """Every top set logged for one exercise, oldest first:
    [{date, workout_id, workout_name, kg, reps, e1rm}]."""
    rows = []
    for w in workouts:
        for ex in w.get("exercises") or []:
            if ex.get("exercise_id") == exercise_id:
                rows.append({
                    "date": w["date"],
                    "workout_id": w.get("id"),
                    "workout_name": w.get("name"),
                    "kg": ex.get("kg"),
                    "reps": ex["reps"],
                    "e1rm": epley_1rm(ex.get("kg"), ex["reps"]),
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
    """Change in top-set kg from the first session on/after `since` (or the
    previous session when `since` is None) to the latest one. None when there
    aren't two weighted sessions to compare."""
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
