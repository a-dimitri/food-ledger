"""Tests for core.timeutils — Sydney date/time formatting."""

from __future__ import annotations

import re
import unittest

from core import timeutils


class TestSydneyClock(unittest.TestCase):
    def test_today_is_iso_date(self):
        self.assertRegex(timeutils.sydney_today(), r"^\d{4}-\d{2}-\d{2}$")

    def test_now_is_hh_mm(self):
        now = timeutils.sydney_now()
        self.assertRegex(now, r"^\d{2}:\d{2}$")
        h, m = (int(x) for x in now.split(":"))
        self.assertTrue(0 <= h <= 23 and 0 <= m <= 59)


if __name__ == "__main__":
    unittest.main()
