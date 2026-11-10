"""Caches that keep Supabase log ingestion and egress inside the free plan
(2026-11-11: 9.3 GB of logs against a 1 GB quota)."""

import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app import auth
from app.main import app
from app.routers import digital_menu, products

# Harmless routes that answer 200 to a write, for the middleware tests.
app.add_api_route("/test-only-write", lambda: {"ok": True}, methods=["POST"])
app.add_api_route("/employees-test-only-write", lambda: {"ok": True}, methods=["POST"])
app.add_api_route("/kitchen-printer/test-only-heartbeat", lambda: {"ok": True}, methods=["POST"])


def _catalog_db():
    db = MagicMock()
    q = db.table.return_value
    for name in ("select", "eq", "in_", "order"):
        getattr(q, name).return_value = q
    q.execute.return_value = MagicMock(data=[])
    return db


class ProductsCacheTests(unittest.TestCase):
    def setUp(self):
        products.clear_products_cache()
        self.addCleanup(products.clear_products_cache)

    def _load(self, db, version):
        with patch("app.routers.transactions.current_live_version", return_value=version), \
             patch.object(products, "_compute_size_availability", return_value={}):
            return products._list_products_data(db, active_only=True, department=None)

    def test_reused_while_nothing_changes(self):
        db = _catalog_db()
        self._load(db, 7)
        calls = db.table.call_count
        self._load(db, 7)
        self.assertEqual(db.table.call_count, calls)

    def test_rebuilt_after_an_order_or_menu_change(self):
        db = _catalog_db()
        self._load(db, 7)
        calls = db.table.call_count
        self._load(db, 8)
        self.assertGreater(db.table.call_count, calls)

    def test_rebuilt_after_max_age(self):
        db = _catalog_db()
        self._load(db, 7)
        calls = db.table.call_count
        with patch.object(products.time, "monotonic", return_value=products.time.monotonic() + 301):
            self._load(db, 7)
        self.assertGreater(db.table.call_count, calls)

    def test_write_on_this_instance_clears_it(self):
        with patch("app.routers.transactions.expire_version_check"), \
             patch.object(products, "clear_products_cache") as clear:
            client = TestClient(app)
            client.get("/health")
            clear.assert_not_called()
            client.post("/test-only-write")
            clear.assert_called_once()
            client.post("/kitchen-printer/test-only-heartbeat")
            clear.assert_called_once()  # the printer heartbeat doesn't clear it


class OrderStatusCacheTests(unittest.TestCase):
    def setUp(self):
        digital_menu._order_status_cache.clear()
        self.addCleanup(digital_menu._order_status_cache.clear)

    def _get(self, version):
        order = {"id": "o1", "status": "approved"}
        with patch.object(digital_menu, "live_cache_version", return_value=version), \
             patch.object(digital_menu, "local_rate_limit"), \
             patch.object(digital_menu, "get_supabase", return_value=MagicMock()), \
             patch.object(digital_menu, "_customer_order", return_value=order) as build:
            digital_menu.public_order_status("o1", MagicMock())
        return build.call_count

    def test_same_version_served_from_cache(self):
        self.assertEqual(self._get(3), 1)
        self.assertEqual(self._get(3), 0)

    def test_order_change_rebuilds(self):
        self._get(3)
        self.assertEqual(self._get(4), 1)

    def test_no_counter_means_no_cache(self):
        self._get(None)
        self.assertEqual(self._get(None), 1)


class AuthCacheTests(unittest.TestCase):
    def test_login_rechecked_every_five_minutes(self):
        self.assertEqual(auth._AUTH_CACHE_SECONDS, 300)

    def test_employee_edit_clears_login_cache(self):
        with patch("app.routers.transactions.expire_version_check"), \
             patch.object(products, "clear_products_cache"), \
             patch("app.main.clear_auth_cache") as clear:
            client = TestClient(app)
            client.patch("/employees/e1", json={})  # unauthenticated: 401, nothing cleared
            clear.assert_not_called()
            client.post("/employees-test-only-write")
            clear.assert_called_once()


if __name__ == "__main__":
    unittest.main()
