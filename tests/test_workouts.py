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


PULL = "pullup"


def bw_set(kg, reps, factor=1.0):
    return {"exercise_id": PULL, "name": "Pull-up", "kg": kg, "reps": reps, "bw_factor": factor}


class TestBodyweight(unittest.TestCase):
    def test_weighted_estimate_is_quoted_as_added_load(self):
        # 78 kg + 10 kg for 8: total 88 × (1 + 8/30) = 111.5, i.e. +33.5 kg for one.
        est = workouts.set_estimate(bw_set(10, 8), bodyweight=78)
        self.assertEqual(est["e1rm_total"], 111.5)
        self.assertEqual(est["e1rm"], 33.5)

    def test_bodyweight_only_and_assisted(self):
        self.assertEqual(workouts.set_estimate(bw_set(None, 12), 78)["e1rm"], 31.2)    # 78 × 1.4
        self.assertEqual(workouts.set_estimate(bw_set(-20, 5), 78)["e1rm"], -10.3)    # 58 × 1.167 − 78

    def test_partial_bodyweight_factor(self):
        # Push-ups lift ~65%: 0.65 × 80 = 52 kg for 20 reps.
        est = workouts.set_estimate(bw_set(None, 20, factor=0.65), 80)
        self.assertEqual(est["e1rm_total"], round(52 * (1 + 20 / 30), 1))

    def test_no_bodyweight_means_no_estimate(self):
        self.assertEqual(workouts.set_estimate(bw_set(10, 8), None), {"e1rm": None, "e1rm_total": None})

    def test_loaded_lifts_are_unchanged(self):
        est = workouts.set_estimate({"exercise_id": BENCH, "kg": 85, "reps": 5}, bodyweight=78)
        self.assertEqual(est, {"e1rm": 99.2, "e1rm_total": 99.2})

    def test_validation(self):
        ok = {"date": "2026-10-26", "bodyweight_kg": 78, "exercises": [bw_set(-20, 5)]}
        workouts.normalise(ok)                                           # assisted is fine
        with self.assertRaises(ValueError):                              # but not for a loaded lift
            workouts.normalise({"date": "2026-10-26", "exercises": [{"exercise_id": BENCH, "kg": -5, "reps": 5}]})
        with self.assertRaises(ValueError):                              # more assistance than bodyweight
            workouts.normalise({**ok, "exercises": [bw_set(-80, 5)]})
        with self.assertRaises(ValueError):
            workouts.normalise({**ok, "bodyweight_kg": 0})

    def test_bodyweight_on(self):
        ws = [{"datetime": "2026-10-20T07:00", "kg": 79.0}, {"datetime": "2026-10-24T07:00", "kg": 78.4}]
        self.assertEqual(workouts.bodyweight_on(ws, "2026-10-25"), 78.4)   # latest on/before
        self.assertEqual(workouts.bodyweight_on(ws, "2026-10-22"), 79.0)
        self.assertEqual(workouts.bodyweight_on(ws, "2026-10-01"), 79.0)   # none before: first after
        self.assertIsNone(workouts.bodyweight_on([], "2026-10-01"))

    def test_history_uses_snapshot_then_weighins(self):
        snap = {"id": "a", "date": "2026-10-20", "bodyweight_kg": 80, "exercises": [bw_set(10, 8)]}
        old = {"id": "b", "date": "2026-10-24", "exercises": [bw_set(12.5, 8)]}     # saved before snapshots
        ws = [{"datetime": "2026-10-23T07:00", "kg": 78}]
        hist = workouts.exercise_history([snap, old], PULL, ws)
        self.assertEqual([r["bodyweight"] for r in hist], [80, 78])
        self.assertEqual(workouts.kg_change(hist), 2.5)                     # change in added load

    def test_high_rep_estimates_are_flagged(self):
        w = {"date": "2026-10-20", "bodyweight_kg": 78, "exercises": [bw_set(None, 15)]}
        hist = workouts.exercise_history([w], PULL)
        self.assertTrue(hist[0]["approx"])
        self.assertEqual(hist[0]["kg"], 0.0)                               # bodyweight only = +0


class TestWeekly(unittest.TestCase):
    def test_counts_keyed_by_monday(self):
        counts = workouts.weekly_counts(LOG + [w("2026-10-25", (BENCH, 80, 8))])  # a Sunday
        self.assertEqual(counts, {"2026-10-05": 1, "2026-10-12": 1, "2026-10-19": 2})


if __name__ == "__main__":
    unittest.main()
