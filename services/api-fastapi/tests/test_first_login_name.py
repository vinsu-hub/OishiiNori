"""First-login password change can also set the new staff member's name."""

import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import hr


def _db(must_change: bool):
    db = MagicMock()
    q = db.table.return_value
    for name in ("select", "eq", "maybe_single", "update"):
        getattr(q, name).return_value = q
    q.execute.return_value = MagicMock(data={"must_change_password": must_change, "current_password": "oishiinori123"})
    return db


class FirstLoginNameTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id="d1", role="rider", department=None, full_name="New Driver", extra_pages=[])
        self.addCleanup(app.dependency_overrides.clear)

    def _post(self, db, body):
        with patch.object(hr, "get_supabase", return_value=db), patch.object(hr, "enforce_rate_limit"), \
                patch.object(hr, "_profile_must_change_supported_check", return_value=True), \
                patch.object(hr, "_profile_credentials_supported_check", return_value=True):
            return TestClient(app).post("/me/change-password", json=body)

    def test_name_is_saved_on_first_login(self):
        db = _db(must_change=True)
        response = self._post(db, {"new_password": "my-own-pass1", "full_name": "  Juan   Dela Cruz "})
        self.assertEqual(response.status_code, 200)
        update = db.table.return_value.update.call_args[0][0]
        self.assertEqual(update["full_name"], "Juan Dela Cruz")
        self.assertFalse(update["must_change_password"])

    def test_temporary_password_cannot_be_kept(self):
        response = self._post(_db(must_change=True), {"new_password": "oishiinori123", "full_name": "Juan"})
        self.assertEqual(response.status_code, 400)

    def test_blank_name_is_refused(self):
        response = self._post(_db(must_change=True), {"new_password": "my-own-pass1", "full_name": " "})
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
