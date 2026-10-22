"""MCP profile binding: tools act only on the signed-in person's profile."""

from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest import mock

import mcp_server.server as srv
from mcp_server.auth import FirestoreOAuthProvider

EMAILS = {"antoni@example.com": "antoni", "emy@example.com": "emy"}


class _StubProfileStore:
    def __init__(self, pid):
        self.pid = pid

    def list_entries(self, date=None):
        return [{"profile": self.pid}]


class _StubStore:
    def profile_id_for_email(self, email):
        return EMAILS.get(email.lower())

    def profile(self, pid):
        return _StubProfileStore(pid)


def _token(subject):
    return SimpleNamespace(subject=subject)


class TestBinding(unittest.TestCase):
    def setUp(self):
        patches = [
            mock.patch.object(srv, "AUTH_ENABLED", True),
            mock.patch.object(srv, "_store", _StubStore()),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _as(self, subject):
        return mock.patch.object(srv, "get_access_token", return_value=_token(subject) if subject else None)

    def test_each_email_gets_its_own_profile(self):
        with self._as("antoni@example.com"):
            self.assertEqual(srv._profile_id(), "antoni")
        with self._as("EMY@example.com"):
            self.assertEqual(srv._profile_id(), "emy")

    def test_no_token_or_unlinked_email_is_refused(self):
        for subject in (None, "stranger@example.com"):
            with self._as(subject), self.assertRaises(PermissionError):
                srv._profile_id()

    def test_dev_profile_is_ignored_when_auth_is_on(self):
        with mock.patch.object(srv, "DEV_PROFILE", "antoni"), self._as("emy@example.com"):
            self.assertEqual(srv._profile_id(), "emy")

    def test_tool_call_reads_only_the_callers_profile(self):
        with self._as("emy@example.com"):
            out = asyncio.run(srv.mcp.call_tool("list_entries", {"date": "2026-10-20"}))
        self.assertIn('"profile": "emy"', str(out))

    def test_no_tool_accepts_a_profile_argument(self):
        for tool in asyncio.run(srv.mcp.list_tools()):
            props = set(tool.inputSchema.get("properties", {}))
            self.assertFalse({"profile", "profile_id"} & props, tool.name)


class TestLogin(unittest.TestCase):
    """The OAuth login refuses emails with no profile before issuing a code."""

    def _provider(self):
        p = FirestoreOAuthProvider(db=None, issuer_url="https://mcp.example", google_client_id="id",
                                   google_client_secret="secret",
                                   profile_for_email=_StubStore().profile_id_for_email)
        pending = mock.Mock()
        pending.get.return_value = SimpleNamespace(exists=True, to_dict=lambda: {"expires_at": 9e12})
        p._doc = mock.Mock(return_value=pending)
        return p

    def test_unlinked_email_is_refused(self):
        p = self._provider()
        with mock.patch.object(p, "_google_email", mock.AsyncMock(return_value="stranger@example.com")):
            with self.assertRaises(PermissionError):
                asyncio.run(p.complete_google_login("code", "state"))


if __name__ == "__main__":
    unittest.main()
