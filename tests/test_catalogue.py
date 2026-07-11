"""Tests for core.catalogue.scale — materialising a saved food at a quantity
into a plain entry dict of the same absolute shape core.compute sums."""

from __future__ import annotations

import unittest

from core import catalogue, compute

TOL = 1e-9


class TestScale(unittest.TestCase):
    ITEM = {
        "name": "Rolled oats",
        "source": "Coles",
        "unit": "serving",
        "per": {"calories": 150, "protein": 5, "carbs": 27},
    }

    def test_scales_present_nutrients_and_omits_absent(self):
        e = catalogue.scale(self.ITEM, 2, date="2026-07-06")
        self.assertEqual(e["food"], "Rolled oats")
        self.assertEqual(e["source"], "Coles")
        self.assertEqual(e["date"], "2026-07-06")
        self.assertAlmostEqual(e["calories"], 300.0, delta=TOL)
        self.assertAlmostEqual(e["protein"], 10.0, delta=TOL)
        self.assertAlmostEqual(e["carbs"], 54.0, delta=TOL)
        # Absent nutrients stay absent (not zero).
        for k in ("fat", "fiber", "sodium", "sugar"):
            self.assertNotIn(k, e)

    def test_fractional_quantity_and_label(self):
        e = catalogue.scale(self.ITEM, 1.5, date="2026-07-06")
        self.assertEqual(e["quantity"], "1.5 × serving")
        self.assertAlmostEqual(e["calories"], 225.0, delta=TOL)

    def test_whole_quantity_label_has_no_decimal(self):
        e = catalogue.scale(self.ITEM, 2, date="2026-07-06")
        self.assertEqual(e["quantity"], "2 × serving")

    def test_time_included_only_when_given(self):
        self.assertNotIn("time", catalogue.scale(self.ITEM, 1, date="2026-07-06"))
        e = catalogue.scale(self.ITEM, 1, date="2026-07-06", time="08:30")
        self.assertEqual(e["time"], "08:30")

    def test_label_without_unit(self):
        item = {"name": "Coffee", "per": {"calories": 5}}
        self.assertEqual(catalogue.scale(item, 3, date="2026-07-06")["quantity"], "3")

    def test_scaled_entry_sums_in_day_total(self):
        # A scaled food is an ordinary entry: day_total sums it like any other.
        e = catalogue.scale(self.ITEM, 2, date="2026-07-06")
        totals = compute.day_total([e], "2026-07-06")
        self.assertAlmostEqual(totals["calories"], 300.0, delta=TOL)
        self.assertAlmostEqual(totals["protein"], 10.0, delta=TOL)


if __name__ == "__main__":
    unittest.main()
