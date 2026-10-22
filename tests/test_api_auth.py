"""API auth: callers are admitted only if their email is listed on a profile."""

from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

import ui.app as ui

PROFILES = [
    {"id": "antoni", "name": "Antoni", "emails": ["antoni@example.com"]},
    {"id": "emy", "name": "Emy", "emails": ["Emy@Example.com"]},
]


class _StubProfileStore:
    def list_phases(self):
        return []

    def latest_weight(self):
        return None


class _StubStore:
    updates: list = []

    def update_profile(self, pid, data):
        self.updates.append((pid, data))

    def list_profiles(self):
        return PROFILES

    def get_profile(self, pid):
        return next((p for p in PROFILES if p["id"] == pid), None)

    def profile(self, pid):
        return _StubProfileStore()


def _as(email):
    return {"X-Goog-Authenticated-User-Email": f"accounts.google.com:{email}"}


class TestAuth(unittest.TestCase):
    def setUp(self):
        ui.app.dependency_overrides[ui.get_store] = _StubStore
        ui._email_cache = (0.0, {})
        _StubStore.updates = []
        self.client = TestClient(ui.app)

    def tearDown(self):
        ui.app.dependency_overrides.clear()

    def test_no_identity_is_401(self):
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_unlisted_email_is_403(self):
        self.assertEqual(self.client.get("/api/me", headers=_as("stranger@example.com")).status_code, 403)

    def test_each_email_lands_on_its_own_profile(self):
        me = self.client.get("/api/me", headers=_as("antoni@example.com")).json()
        self.assertEqual(me["profile_id"], "antoni")
        # Email matching is case-insensitive.
        me = self.client.get("/api/me", headers=_as("emy@example.com")).json()
        self.assertEqual(me["profile_id"], "emy")

    def test_profile_emails_are_not_exposed(self):
        me = self.client.get("/api/me", headers=_as("antoni@example.com")).json()
        self.assertTrue(all("emails" not in p for p in me["profiles"]))

    def test_unknown_profile_is_404(self):
        r = self.client.get("/api/p/nobody/phases", headers=_as("antoni@example.com"))
        self.assertEqual(r.status_code, 404)

    def test_profile_patch_cannot_set_emails(self):
        r = self.client.patch("/api/profiles/antoni", json={"emails": ["evil@example.com"]},
                              headers=_as("antoni@example.com"))
        self.assertEqual(r.status_code, 400)  # unknown field dropped → nothing to update
        self.assertEqual(_StubStore.updates, [])


if __name__ == "__main__":
    unittest.main()
