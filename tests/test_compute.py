"""Regression tests: core.compute must reproduce the derived values that the
legacy build_tracker.py cached into food_data.json.

food_data.json carries `dayTotals`, `averages`, `trackedCount`, and
`weightStats` computed by the old script — an exact oracle for the port.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from core import compute

DATA_PATH = Path(__file__).resolve().parent.parent / "food_data.json"
# The dataset's notion of "today" (its last, in-progress day).
TODAY = "2026-07-05"
TOL = 1e-6


def load_data() -> dict:
    with open(DATA_PATH) as f:
        return json.load(f)


# The legacy food_data.json is the migration source and is gitignored — present
# locally, absent in a fresh checkout. These oracle tests validate the core port
# against it; skip (don't fail) where the file isn't present.
_oracle = unittest.skipUnless(
    DATA_PATH.exists(), "legacy food_data.json not present (gitignored)"
)


@_oracle
class TestDayTotals(unittest.TestCase):
    def test_matches_cached_day_totals(self):
        data = load_data()
        entries = data["entries"]
        # The cached dayTotals for `today` is a stale snapshot — the file is
        # appended to without build_tracker.py being re-run, which is exactly
        # the staleness this migration removes. Assert only the stable,
        # fully-logged historical days against the oracle.
        checked = 0
        for date, expected in data["dayTotals"].items():
            if date == TODAY:
                continue
            got = compute.day_total(entries, date)
            for key, exp in expected.items():
                self.assertAlmostEqual(
                    got[key], exp, delta=TOL,
                    msg=f"{date}/{key}: got {got[key]}, expected {exp}",
                )
            checked += 1
        self.assertGreater(checked, 0, "no historical days to verify")

    def test_today_total_is_self_consistent(self):
        # Today's cache may be stale; verify the live computation instead.
        data = load_data()
        got = compute.day_total(data["entries"], TODAY)
        manual = sum(
            e.get("calories") or 0 for e in data["entries"] if e["date"] == TODAY
        )
        self.assertAlmostEqual(got["calories"], manual, delta=TOL)


@_oracle
class TestAverages(unittest.TestCase):
    def test_matches_cached_averages_and_count(self):
        data = load_data()
        completed = data.get("completed_days", [])
        avgs, count = compute.averages(data["entries"], TODAY, completed)

        self.assertEqual(count, data["trackedCount"])
        for key, exp in data["averages"].items():
            self.assertAlmostEqual(
                avgs[key], exp, delta=TOL,
                msg=f"average {key}: got {avgs[key]}, expected {exp}",
            )


@_oracle
class TestWeightStats(unittest.TestCase):
    def test_matches_cached_weight_stats(self):
        data = load_data()
        completed = data.get("completed_days", [])
        avgs, _ = compute.averages(data["entries"], TODAY, completed)
        stats = compute.weight_stats(data["weights"], avg_calories=avgs["calories"])
        expected = data["weightStats"]

        self.assertIsNotNone(stats)
        # core uses snake_case; the cached oracle uses camelCase.
        self.assertAlmostEqual(stats["slope_per_day"], expected["slope_per_day"], delta=TOL)
        self.assertAlmostEqual(stats["weekly_rate"], expected["weeklyRate"], delta=TOL)
        self.assertAlmostEqual(stats["intercept"], expected["intercept"], delta=TOL)
        self.assertEqual(stats["n"], expected["n"])
        self.assertAlmostEqual(stats["latest"], expected["latest"], delta=TOL)
        self.assertEqual(stats["avg_intake"], expected["avgIntake"])
        self.assertEqual(stats["maintenance_est"], expected["maintenanceEst"])


class TestComputeInline(unittest.TestCase):
    """File-independent coverage so the committed suite exercises core.compute
    without relying on the gitignored legacy oracle."""

    def test_averages_over_tracked_days(self):
        entries = [
            {"date": "2026-01-01", "calories": 100, "protein": 10},
            {"date": "2026-01-02", "calories": 200, "protein": 20},
        ]
        avgs, count = compute.averages(entries, today="2026-01-03")
        self.assertEqual(count, 2)  # both days are historical
        self.assertAlmostEqual(avgs["calories"], 150.0, delta=TOL)
        self.assertAlmostEqual(avgs["protein"], 15.0, delta=TOL)

    def test_rollup_averages_match_entries_path(self):
        # The dashboard computes averages from day rollups; that must agree
        # with the entries-based convenience wrapper.
        entries = [
            {"date": "2026-01-01", "calories": 100, "protein": 10},
            {"date": "2026-01-02", "calories": 200, "protein": 20},
            {"date": "2026-01-03", "calories": 300},  # today — excluded
        ]
        today = "2026-01-03"
        via_entries, c1 = compute.averages(entries, today)
        day_totals = {d: compute.day_total(entries, d) for d in compute.entry_dates(entries)}
        via_rollups, c2 = compute.averages_from_day_totals(day_totals, today)
        self.assertEqual((c1, via_entries), (c2, via_rollups))
        self.assertEqual(c1, 2)

    def test_today_excluded_from_averages(self):
        entries = [
            {"date": "2026-01-01", "calories": 100},
            {"date": "2026-01-02", "calories": 999},  # today, in progress
        ]
        avgs, count = compute.averages(entries, today="2026-01-02")
        self.assertEqual(count, 1)
        self.assertAlmostEqual(avgs["calories"], 100.0, delta=TOL)

    def test_weight_regression_slope(self):
        weights = [
            {"datetime": "2026-01-01T08:00", "kg": 80.0},
            {"datetime": "2026-01-02T08:00", "kg": 79.0},
        ]
        stats = compute.weight_stats(weights, avg_calories=0.0)
        self.assertIsNotNone(stats)
        self.assertAlmostEqual(stats["slope_per_day"], -1.0, delta=TOL)
        self.assertAlmostEqual(stats["weekly_rate"], -7.0, delta=TOL)
        self.assertAlmostEqual(stats["latest"], 79.0, delta=TOL)
        self.assertEqual(stats["n"], 2)

    def test_weight_stats_needs_two_points(self):
        self.assertIsNone(compute.weight_stats([{"datetime": "2026-01-01T08:00", "kg": 80.0}]))


class TestNumberCoercion(unittest.TestCase):
    def test_ignores_blank_and_boolean_values(self):
        entries = [
            {"date": "2026-01-01", "calories": 100, "protein": ""},
            {"date": "2026-01-01", "calories": None, "protein": 5},
            {"date": "2026-01-01", "calories": True, "protein": 2.5},  # bool ignored
        ]
        totals = compute.day_total(entries, "2026-01-01")
        self.assertAlmostEqual(totals["calories"], 100.0, delta=TOL)
        self.assertAlmostEqual(totals["protein"], 7.5, delta=TOL)


if __name__ == "__main__":
    unittest.main()
