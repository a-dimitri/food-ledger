"""Front-end asset serving: versioned URLs and caching headers.

A browser must never be able to mix an old cached module with a new one, so the
entry points are never cached and the JS/CSS live under a content fingerprint.
"""

from __future__ import annotations

import re
import unittest

from fastapi.testclient import TestClient

import ui.app as ui


class TestAssets(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(ui.app)

    def test_index_points_at_versioned_assets_and_is_never_cached(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["cache-control"], "no-cache")
        self.assertIn(f'/assets/{ui.ASSET_VERSION}/js/main.js', r.text)
        self.assertIn(f'/assets/{ui.ASSET_VERSION}/styles.css', r.text)
        self.assertNotRegex(r.text, r'"/static/(js|styles)')

    def test_current_version_is_immutable(self):
        r = self.client.get(f"/assets/{ui.ASSET_VERSION}/js/api.js")
        self.assertEqual(r.status_code, 200)
        self.assertIn("immutable", r.headers["cache-control"])
        self.assertIn("javascript", r.headers["content-type"])

    def test_old_version_still_served_but_not_cached(self):
        r = self.client.get("/assets/000000000000/js/api.js")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["cache-control"], "no-cache")

    def test_every_module_import_resolves_under_the_versioned_prefix(self):
        main = self.client.get(f"/assets/{ui.ASSET_VERSION}/js/main.js").text
        for rel in re.findall(r'from "\./([^"]+)"', main):
            self.assertEqual(self.client.get(f"/assets/{ui.ASSET_VERSION}/js/{rel}").status_code, 200, rel)

    def test_path_traversal_is_refused(self):
        for path in ["../app.py", "..%2Fapp.py", "js/../../app.py"]:
            self.assertEqual(self.client.get(f"/assets/{ui.ASSET_VERSION}/{path}").status_code, 404, path)

    def test_entry_points_and_unversioned_static_revalidate(self):
        for path in ["/sw.js", "/manifest.webmanifest", "/static/icons/icon-192.png"]:
            r = self.client.get(path)
            self.assertEqual(r.status_code, 200, path)
            self.assertEqual(r.headers["cache-control"], "no-cache", path)


if __name__ == "__main__":
    unittest.main()
