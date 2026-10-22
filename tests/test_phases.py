"""Tests for core.phases: validation, overlap, and target resolution."""

from __future__ import annotations

import unittest

from core import phases

CUT = {"id": "cut", "kind": "phase", "name": "Cut", "start": "2026-09-28", "end": "2026-11-22",
       "targets": {"calories": 2200, "protein": 160}}
TRIP = {"id": "trip", "kind": "untracked", "start": "2026-12-01", "end": "2026-12-31"}
OPEN = {"id": "open", "kind": "phase", "name": "Bulk", "start": "2027-01-05", "end": None}
ALL = [CUT, TRIP, OPEN]
DEFAULTS = {"calories": 2500}


class TestValidate(unittest.TestCase):
    def test_accepts_well_formed(self):
        for p in ALL:
            phases.validate(p)

    def test_rejects_bad_kind_dates_and_names(self):
        bad = [
            {**CUT, "kind": "holiday"},
            {**CUT, "start": None},
            {**CUT, "start": "28/09/2026"},
            {**CUT, "end": "2026-09-01"},              # before start
            {**CUT, "name": "  "},
            {**CUT, "targets": {"carbz": 1}},
            {**TRIP, "targets": {"calories": 2000}},    # untracked has no targets
        ]
        for p in bad:
            with self.assertRaises(ValueError, msg=p):
                phases.validate(p)


class TestOverlap(unittest.TestCase):
    def test_touching_windows_do_not_overlap(self):
        nxt = {"kind": "phase", "name": "Maint", "start": "2026-11-23", "end": "2026-11-30"}
        self.assertIsNone(phases.find_overlap(ALL, nxt))

    def test_shared_day_overlaps(self):
        clash = {"kind": "phase", "name": "X", "start": "2026-11-22", "end": "2026-11-25"}
        self.assertEqual(phases.find_overlap(ALL, clash)["id"], "cut")

    def test_open_ended_overlaps_everything_after(self):
        later = {"kind": "untracked", "start": "2030-01-01", "end": "2030-01-02"}
        self.assertEqual(phases.find_overlap(ALL, later)["id"], "open")

    def test_edit_ignores_its_own_previous_version(self):
        self.assertIsNone(phases.find_overlap(ALL, {**CUT, "end": "2026-11-25"}))


class TestTargets(unittest.TestCase):
    def test_resolution(self):
        self.assertEqual(phases.targets_for(ALL, "2026-10-01", DEFAULTS)["calories"], 2200)
        self.assertIsNone(phases.targets_for(ALL, "2026-12-10", DEFAULTS))     # untracked
        self.assertEqual(phases.targets_for(ALL, "2026-11-25", DEFAULTS), DEFAULTS)  # gap
        self.assertEqual(phases.targets_for(ALL, "2026-09-28", DEFAULTS)["calories"], 2200)  # inclusive start
        self.assertEqual(phases.targets_for(ALL, "2026-11-22", DEFAULTS)["calories"], 2200)  # inclusive end

    def test_is_untracked(self):
        self.assertTrue(phases.is_untracked(ALL, "2026-12-31"))
        self.assertFalse(phases.is_untracked(ALL, "2027-01-01"))


class TestWeekOf(unittest.TestCase):
    def test_week_label(self):
        self.assertEqual(phases.week_of(CUT, "2026-09-28"), (1, 8))
        self.assertEqual(phases.week_of(CUT, "2026-10-20"), (4, 8))

    def test_open_ended_has_no_total(self):
        self.assertEqual(phases.week_of(OPEN, "2027-01-12"), (2, None))


if __name__ == "__main__":
    unittest.main()
