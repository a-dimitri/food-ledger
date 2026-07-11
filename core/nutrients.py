"""Nutrient definitions — the single source of truth for what we track.

Carried over from build_tracker.py. Each nutrient is (key, label, unit).
"""

from __future__ import annotations

NUTRIENTS: list[tuple[str, str, str]] = [
    ("calories", "Calories", ""),
    ("protein", "Protein", "g"),
    ("carbs", "Carbs", "g"),
    ("fat", "Fat", "g"),
    ("fiber", "Fiber", "g"),
    ("sodium", "Sodium", "mg"),
    ("sugar", "Sugar", "g"),
]

NUTRIENT_KEYS: list[str] = [key for key, _, _ in NUTRIENTS]
