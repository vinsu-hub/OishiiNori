"""CPU guardrails added after Vercel paused the Hobby plan (2026-10-16)."""

import base64
import json
import time
import unittest
from unittest.mock import patch

from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

from app import auth
from app.main import app
from app.routers import transactions


def _jwt(exp: float) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


def _user() -> auth.CurrentUser:
    return auth.CurrentUser(id="u1", role="employee", department=None, full_name="Cashier", extra_pages=[])


class AuthCacheTests(unittest.TestCase):
    def setUp(self):
        auth._auth_cache.clear()

    def test_verified_token_is_reused_within_the_window(self):
        token = HTTPAuthorizationCredentials(scheme="Bearer", credentials=_jwt(time.time() + 3600))
        with patch.object(auth, "_verify_user", return_value=_user()) as verify:
            auth.get_current_user(token)
            auth.get_current_user(token)
        self.assertEqual(verify.call_count, 1)

    def test_cache_never_outlives_the_token(self):
        token = HTTPAuthorizationCredentials(scheme="Bearer", credentials=_jwt(time.time() - 1))
        with patch.object(auth, "_verify_user", return_value=_user()) as verify:
            auth.get_current_user(token)
            auth.get_current_user(token)
        self.assertEqual(verify.call_count, 2)

    def test_failed_verification_is_not_cached(self):
        token = HTTPAuthorizationCredentials(scheme="Bearer", credentials=_jwt(time.time() + 3600))
        with patch.object(auth, "_verify_user", side_effect=auth.HTTPException(status_code=401)) as verify:
            for _ in range(2):
                with self.assertRaises(auth.HTTPException):
                    auth.get_current_user(token)
        self.assertEqual(verify.call_count, 2)


class LowStockCacheTests(unittest.TestCase):
    def test_every_screen_shares_one_build(self):
        from app.auth import get_current_user
        from app.routers import inventory
        inventory._low_stock_cache.clear()
        self.addCleanup(inventory._low_stock_cache.clear)
        app.dependency_overrides[get_current_user] = _user
        self.addCleanup(app.dependency_overrides.clear)
        client = TestClient(app)
        with patch.object(inventory, "get_supabase"), \
             patch.object(inventory, "get_low_stock_ingredients", return_value=[]) as ingredients, \
             patch.object(inventory, "get_low_stock_stock_items", return_value=[]):
            for _ in range(3):
                self.assertEqual(client.get("/inventory/low-stock-summary").status_code, 200)
        self.assertEqual(ingredients.call_count, 1)


class DigitalOrdersRecentTests(unittest.TestCase):
    def test_kitchen_list_keeps_recent_and_upcoming_only(self):
        from unittest.mock import MagicMock
        from app.routers import digital_menu
        db = MagicMock()
        q = db.table.return_value
        for name in ("select", "eq", "or_", "order", "limit"):
            getattr(q, name).return_value = q
        q.execute.return_value = MagicMock(data=[])
        with patch.object(digital_menu, "get_supabase", return_value=db):
            digital_menu._list_digital_orders("approved", 200, 3)
        recent = q.or_.call_args.args[0]
        self.assertIn("created_at.gte.", recent)
        self.assertIn("scheduled_for.gte.", recent)
        q.or_.reset_mock()
        with patch.object(digital_menu, "get_supabase", return_value=db):
            digital_menu._list_digital_orders("approved", 200)
        q.or_.assert_not_called()


class LiveCacheTests(unittest.TestCase):
    def setUp(self):
        transactions.clear_live_cache()
        # Without migration 0077 (live_version) the cache is a plain 10 s one.
        transactions._version_state.update(supported=False, value=None, checked_at=0.0)
        self.client = TestClient(app)

    def tearDown(self):
        transactions._version_state.update(supported=None, value=None, checked_at=0.0)

    def test_successful_write_clears_cached_lists(self):
        transactions.live_cache_put(("probe",), b"[]")
        self.client.post("/health")  # 405: a failed write keeps the cache
        self.assertIsNotNone(transactions.live_cache_get(("probe",)))
        app.add_api_route("/_test_write", lambda: {"ok": True}, methods=["POST"])
        self.client.post("/_test_write")
        self.assertIsNone(transactions.live_cache_get(("probe",)))

    def test_responses_report_their_cpu(self):
        self.assertIn("cpu;dur=", self.client.get("/health").headers["server-timing"])


if __name__ == "__main__":
    unittest.main()
