"""Tests for core.compute: day totals, averages, and weight stats."""

from __future__ import annotations

import unittest

from core import compute

TOL = 1e-6


class TestComputeInline(unittest.TestCase):
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
