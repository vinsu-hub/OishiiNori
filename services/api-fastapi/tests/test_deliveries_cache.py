"""The rider's delivery list is served from the shared live cache."""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import deliveries
from app.routers import transactions

TICKET = {"id": "o1", "order_number": 70, "status": "approved", "subtotal": 100.0, "created_at": "2026-10-19T08:00:00Z",
          "order_channel": "delivery", "payment_method": "cash", "items": [], "addons": [], "kitchen_status": "ready"}


class DeliveriesCacheTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id="r1", role="rider", department=None, full_name="Rider", extra_pages=[])
        self.addCleanup(app.dependency_overrides.clear)
        transactions._live_cache.clear()
        self.addCleanup(transactions._live_cache.clear)

    def test_repeat_polls_are_cached_until_the_version_changes(self):
        version = {"v": 1}
        with patch.object(transactions, "current_live_version", side_effect=lambda: version["v"]), \
                patch.object(deliveries, "_build_deliveries", return_value=[TICKET]) as build:
            client = TestClient(app)
            first = client.get("/deliveries")
            second = client.get("/deliveries")
            self.assertEqual(build.call_count, 1)
            version["v"] = 2  # a kitchen status change bumps the version
            client.get("/deliveries")
            self.assertEqual(build.call_count, 2)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(first.json()[0]["kitchen_status"], "ready")


if __name__ == "__main__":
    unittest.main()
