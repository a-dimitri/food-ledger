"""MCP update_food: edits one shared pantry item, merging nutrients."""

from __future__ import annotations

import asyncio
import copy
import json
import unittest
from unittest import mock

import mcp_server.server as srv

FOODS = [
    {"id": "f1", "name": "Greek yogurt", "unit": "170 g", "per": {"calories": 120, "protein": 17, "sugar": 6}},
    {"id": "f2", "name": "Rolled oats", "unit": "40 g", "per": {"calories": 150, "protein": 5}},
]


class _StubStore:
    def __init__(self):
        self.foods = copy.deepcopy(FOODS)
        self.updates = []

    def list_foods(self):
        return self.foods

    def get_food(self, food_id):
        return next((f for f in self.foods if f["id"] == food_id), None)

    def update_food(self, food_id, data):
        self.updates.append((food_id, data))


def call(name, args):
    out = asyncio.run(srv.mcp.call_tool(name, args))
    blocks = out[0] if isinstance(out, tuple) else out
    return json.loads(blocks[0].text)


class TestUpdateFood(unittest.TestCase):
    def setUp(self):
        self.store = _StubStore()
        p = mock.patch.object(srv, "_store", self.store)
        p.start()
        self.addCleanup(p.stop)

    def test_by_name_merges_nutrients(self):
        out = call("update_food", {"food": "greek YOGURT", "protein": 18, "fat": 0.5})
        self.assertEqual(out["status"], "updated")
        self.assertEqual(self.store.updates, [("f1", {"per": {"calories": 120, "protein": 18, "sugar": 6, "fat": 0.5}})])

    def test_by_id_rename_and_unit_only(self):
        call("update_food", {"food": "f2", "name": "Oats (rolled)", "unit": "50 g"})
        self.assertEqual(self.store.updates, [("f2", {"name": "Oats (rolled)", "unit": "50 g"})])

    def test_clear_removes_a_nutrient(self):
        call("update_food", {"food": "f1", "clear": ["sugar"]})
        self.assertEqual(self.store.updates, [("f1", {"per": {"calories": 120, "protein": 17}})])

    def test_errors_write_nothing(self):
        for args in [
            {"food": "nope", "protein": 1},                       # unknown item
            {"food": "f1"},                                       # nothing to change
            {"food": "f1", "name": "rolled oats"},                # name taken by another item
            {"food": "f1", "calories": -5},                       # negative value
        ]:
            self.assertEqual(call("update_food", args)["status"], "error", args)
        self.assertEqual(self.store.updates, [])


if __name__ == "__main__":
    unittest.main()
