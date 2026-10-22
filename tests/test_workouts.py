"""Tests for core.workouts: validation, history, and progress."""

from __future__ import annotations

import unittest

from core import workouts

BENCH, SQUAT = "bench", "squat"


def w(date, *sets, wid=None):
    return {"id": wid or date, "date": date, "name": "Session",
            "exercises": [{"exercise_id": e, "name": e, "kg": kg, "reps": r} for e, kg, r in sets]}


LOG = [
    w("2026-10-05", (BENCH, 80, 8), (SQUAT, 105, 5)),
    w("2026-10-12", (BENCH, 80, 8)),
    w("2026-10-19", (BENCH, 82.5, 8), (SQUAT, 110, 5)),
]


class TestNormalise(unittest.TestCase):
    def test_derives_unique_exercise_ids_in_order(self):
        out = workouts.normalise(w("2026-10-05", (SQUAT, 100, 5), (BENCH, 80, 8), (SQUAT, 60, 10)))
        self.assertEqual(out["exercise_ids"], [SQUAT, BENCH])

    def test_bodyweight_set_has_no_kg(self):
        workouts.normalise(w("2026-10-05", ("dips", None, 12)))

    def test_rejects_bad_sets(self):
        for bad in [
            w("2026-13-01", (BENCH, 80, 8)),
            w("2026-10-05", (BENCH, 80, 0)),
            w("2026-10-05", (BENCH, 80, 2.5)),
            w("2026-10-05", (BENCH, -5, 8)),
            {"date": "2026-10-05", "exercises": [{"name": "x", "reps": 5}]},
        ]:
            with self.assertRaises(ValueError, msg=bad):
                workouts.normalise(bad)


class TestHistory(unittest.TestCase):
    def test_history_is_oldest_first_and_filtered(self):
        hist = workouts.exercise_history(reversed(LOG), SQUAT)
        self.assertEqual([r["date"] for r in hist], ["2026-10-05", "2026-10-19"])
        self.assertEqual(hist[-1]["kg"], 110)

    def test_epley(self):
        self.assertEqual(workouts.epley_1rm(100, 1), 100.0)
        self.assertEqual(workouts.epley_1rm(85, 5), 99.2)
        self.assertIsNone(workouts.epley_1rm(None, 10))

    def test_best_set_by_e1rm(self):
        best = workouts.best_set(workouts.exercise_history(LOG, BENCH))
        self.assertEqual((best["date"], best["kg"]), ("2026-10-19", 82.5))

    def test_kg_change(self):
        hist = workouts.exercise_history(LOG, BENCH)
        self.assertEqual(workouts.kg_change(hist), 2.5)                       # vs previous
        self.assertEqual(workouts.kg_change(hist, since="2026-10-12"), 2.5)   # since phase start
        self.assertIsNone(workouts.kg_change(hist, since="2026-10-19"))       # one session only
        self.assertIsNone(workouts.kg_change(hist[:1]))


class TestWeekly(unittest.TestCase):
    def test_counts_keyed_by_monday(self):
        counts = workouts.weekly_counts(LOG + [w("2026-10-25", (BENCH, 80, 8))])  # a Sunday
        self.assertEqual(counts, {"2026-10-05": 1, "2026-10-12": 1, "2026-10-19": 2})


if __name__ == "__main__":
    unittest.main()
