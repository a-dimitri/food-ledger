"""Phases — date windows that set a profile's daily targets and weight goal.

A phase doc is one of two kinds:

    phase:     {kind: "phase", name, colour, start, end|None, targets{},
                goal_kg|None, goal_rate_kg_wk|None, notes|None}
    untracked: {kind: "untracked", name|None, start, end|None, notes|None}

`start`/`end` are inclusive 'YYYY-MM-DD' strings; a missing `end` means the
window is open-ended. Windows never overlap (enforced by the store via
find_overlap). Target resolution for a date:

    inside a phase           -> that phase's targets
    inside an untracked one  -> None (no targets, no logging, no chart band)
    outside both             -> the profile's default targets

Pure functions over plain dicts — no Firestore dependency.
"""

from __future__ import annotations

import math
from datetime import date as Date
from typing import Any, Iterable, Optional

from .nutrients import NUTRIENT_KEYS

Phase = dict[str, Any]

KINDS = ("phase", "untracked")
# Sorts after every real date, so an open-ended window compares as "forever".
OPEN_END = "9999-12-31"


def _end(p: Phase) -> str:
    return p.get("end") or OPEN_END


def covers(p: Phase, date: str) -> bool:
    """Whether `date` falls inside the phase window (inclusive)."""
    return p["start"] <= date <= _end(p)


def validate(p: Phase) -> None:
    """Raise ValueError if the phase is malformed. Does not check overlaps."""
    kind = p.get("kind")
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}, got {kind!r}")
    start, end = p.get("start"), p.get("end")
    if not start:
        raise ValueError("start is required")
    try:
        Date.fromisoformat(start)
        if end:
            Date.fromisoformat(end)
    except ValueError:
        raise ValueError("start/end must be 'YYYY-MM-DD'")
    if end and end < start:
        raise ValueError("end must not be before start")
    if kind == "phase":
        if not (p.get("name") or "").strip():
            raise ValueError("a phase needs a name")
        unknown = set(p.get("targets") or {}) - set(NUTRIENT_KEYS)
        if unknown:
            raise ValueError(f"unknown target keys: {sorted(unknown)}")
    elif p.get("targets") or p.get("goal_kg") is not None:
        raise ValueError("an untracked window has no targets or weight goal")


def find_overlap(phases: Iterable[Phase], candidate: Phase) -> Optional[Phase]:
    """The first existing window that overlaps `candidate`, ignoring a doc with
    the same id (so an edit doesn't collide with its own previous version)."""
    for p in phases:
        if candidate.get("id") and p.get("id") == candidate["id"]:
            continue
        if p["start"] <= _end(candidate) and candidate["start"] <= _end(p):
            return p
    return None


def phase_on(phases: Iterable[Phase], date: str) -> Optional[Phase]:
    """The window (phase or untracked) covering `date`, if any."""
    for p in phases:
        if covers(p, date):
            return p
    return None


def is_untracked(phases: Iterable[Phase], date: str) -> bool:
    p = phase_on(phases, date)
    return bool(p and p.get("kind") == "untracked")


def targets_for(phases: Iterable[Phase], date: str,
                default_targets: dict[str, float]) -> Optional[dict[str, float]]:
    """Daily targets in force on `date`; None inside an untracked window."""
    p = phase_on(phases, date)
    if p is None:
        return default_targets
    if p.get("kind") == "untracked":
        return None
    return p.get("targets") or {}


def week_of(p: Phase, date: str) -> tuple[int, Optional[int]]:
    """(current week, total weeks) of a phase on `date`, 1-based — the
    'wk 4/8' label. Total is None for an open-ended phase."""
    start = Date.fromisoformat(p["start"])
    week = (Date.fromisoformat(date) - start).days // 7 + 1
    total = None
    if p.get("end"):
        days = (Date.fromisoformat(p["end"]) - start).days + 1
        total = math.ceil(days / 7)
    return week, total
