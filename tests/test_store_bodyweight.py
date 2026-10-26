"""Store: bodyweight exercises get their catalogue factor and the session's
bodyweight snapshotted at save. Uses a stub client — no Firestore."""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest import mock

from core.store import InvalidError, ProfileStore, Store

CATALOGUE = {
    "pull": {"name": "Pull-up", "equipment": "bodyweight", "bodyweight_factor": 1.0},
    "push": {"name": "Push-up", "equipment": "bodyweight", "bodyweight_factor": 0.65},
    "bench": {"name": "Bench press", "equipment": "barbell", "bodyweight_factor": None},
}


class _StubDb:
    def collection(self, name):
        return SimpleNamespace(document=lambda i: SimpleNamespace(id=i))

    def get_all(self, refs):
        return [SimpleNamespace(id=r.id, exists=r.id in CATALOGUE, to_dict=lambda r=r: CATALOGUE.get(r.id))
                for r in refs]


def _store():
    ps = ProfileStore.__new__(ProfileStore)
    ps.db = _StubDb()
    return ps


WEIGHTS = [{"datetime": "2026-10-24T07:00", "kg": 78.4}]


class TestSnapshot(unittest.TestCase):
    def test_factor_and_bodyweight_are_stamped(self):
        ps = _store()
        with mock.patch.object(ProfileStore, "list_weights", return_value=WEIGHTS):
            out = ps._snapshot_bodyweight({"date": "2026-10-26", "exercises": [
                {"exercise_id": "pull", "name": "Pull-up", "kg": 10, "reps": 8},
                {"exercise_id": "bench", "name": "Bench press", "kg": 80, "reps": 5, "bw_factor": 1.0},
            ]})
        self.assertEqual(out["bodyweight_kg"], 78.4)
        self.assertEqual(out["exercises"][0]["bw_factor"], 1.0)
        self.assertNotIn("bw_factor", out["exercises"][1])     # a loaded lift can't claim one

    def test_given_bodyweight_wins_and_loaded_only_workouts_get_none(self):
        ps = _store()
        with mock.patch.object(ProfileStore, "list_weights", return_value=WEIGHTS):
            given = ps._snapshot_bodyweight({"date": "2026-10-26", "bodyweight_kg": 77,
                                             "exercises": [{"exercise_id": "push", "kg": None, "reps": 20}]})
            loaded = ps._snapshot_bodyweight({"date": "2026-10-26",
                                              "exercises": [{"exercise_id": "bench", "kg": 80, "reps": 5}]})
        self.assertEqual(given["bodyweight_kg"], 77)
        self.assertEqual(given["exercises"][0]["bw_factor"], 0.65)
        self.assertNotIn("bodyweight_kg", loaded)

    def test_deleted_exercise_keeps_its_snapshot(self):
        ps = _store()
        with mock.patch.object(ProfileStore, "list_weights", return_value=WEIGHTS):
            out = ps._snapshot_bodyweight({"date": "2026-10-26", "bodyweight_kg": 78,
                                           "exercises": [{"exercise_id": "gone", "kg": 5, "reps": 6, "bw_factor": 1.0}]})
        self.assertEqual(out["exercises"][0]["bw_factor"], 1.0)


class TestCatalogueFactor(unittest.TestCase):
    def test_defaults_and_validation(self):
        self.assertEqual(Store._with_factor({"equipment": "bodyweight"})["bodyweight_factor"], 1.0)
        self.assertEqual(Store._with_factor({"equipment": "bodyweight", "bodyweight_factor": 0.65})["bodyweight_factor"], 0.65)
        self.assertIsNone(Store._with_factor({"equipment": "barbell", "bodyweight_factor": 0.5})["bodyweight_factor"])
        with self.assertRaises(InvalidError):
            Store._with_factor({"equipment": "bodyweight", "bodyweight_factor": 1.5})


if __name__ == "__main__":
    unittest.main()
