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


class LiveCacheTests(unittest.TestCase):
    def setUp(self):
        transactions.clear_live_cache()
        self.client = TestClient(app)

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
