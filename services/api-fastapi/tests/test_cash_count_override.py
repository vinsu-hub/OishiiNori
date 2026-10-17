"""Executive cash count for a shift closed by scripts/override_eod.py."""

import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import shift_reports


def _as(role: str):
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="u1", role=role, department=None, full_name="Sarah Jane", extra_pages=[])


def _db(report: dict | None, updated: list):
    db = MagicMock()
    q = db.table.return_value
    for name in ("select", "eq", "order", "maybe_single", "update"):
        getattr(q, name).return_value = q
    q.execute.side_effect = [MagicMock(data={"id": "s1", "shift_report": report}), MagicMock(data=updated)]
    return db


PENDING = {"cash_count_pending": True, "cash_drawer": {"expected_cash": 26394.0, "actual_cash": None, "difference": None}}


class CashCountTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_only_executives_can_enter_the_count(self):
        _as("manager")
        self.assertEqual(self.client.post("/shift-reports/s1/cash-count", json={"cash_register_total": 1}).status_code, 403)
        self.assertEqual(self.client.get("/shift-reports/pending-cash-counts").json(), [])

    def test_count_fills_the_report_once(self):
        _as("executive")
        db = _db(PENDING, [{"id": "s1"}])
        with patch.object(shift_reports, "get_supabase", return_value=db):
            response = self.client.post("/shift-reports/s1/cash-count", json={"cash_register_total": 26000})
        self.assertEqual(response.json()["difference"], -394.0)
        saved = db.table.return_value.update.call_args[0][0]
        self.assertFalse(saved["shift_report"]["cash_count_pending"])
        self.assertEqual(saved["shift_report"]["cash_drawer"]["actual_cash"], 26000.0)
        self.assertEqual(saved["cash_register_total"], 26000.0)

    def test_counted_shift_is_frozen(self):
        _as("executive")
        db = _db({**PENDING, "cash_count_pending": False}, [])
        with patch.object(shift_reports, "get_supabase", return_value=db):
            self.assertEqual(self.client.post("/shift-reports/s1/cash-count", json={"cash_register_total": 1}).status_code, 409)


if __name__ == "__main__":
    unittest.main()
