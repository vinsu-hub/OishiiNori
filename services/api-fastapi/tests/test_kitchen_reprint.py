"""Online Orders' "Print kitchen ticket" request (migration 0081)."""

import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import transactions


class KitchenReprintTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id="u1", role="employee", department=None, full_name="Cashier", extra_pages=[])
        self.addCleanup(app.dependency_overrides.clear)
        patcher = patch.object(transactions, "_kitchen_reprint_supported", None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _post(self, rows, migrated=True):
        q = MagicMock()
        for name in ("select", "eq", "limit", "update"):
            getattr(q, name).return_value = q

        def execute():
            if not migrated and "kitchen_reprint_requested_at" in str(q.select.call_args):
                raise APIError({"message": "column does not exist", "code": "42703"})
            return MagicMock(data=rows)
        q.execute.side_effect = execute
        db = MagicMock()
        db.table.return_value = q
        with patch.object(transactions, "get_supabase", return_value=db):
            response = TestClient(app).post("/transactions/t1/kitchen-reprint")
        return q, response

    def test_stamps_the_request(self):
        q, response = self._post([{"id": "t1", "status": "open"}])
        self.assertEqual(response.status_code, 200)
        stamped = q.update.call_args.args[0]
        self.assertEqual(list(stamped), ["kitchen_reprint_requested_at"])
        self.assertEqual(response.json()["kitchen_reprint_requested_at"], stamped["kitchen_reprint_requested_at"])

    def test_missing_and_voided_orders(self):
        self.assertEqual(self._post([])[1].status_code, 404)
        q, response = self._post([{"id": "t1", "status": "voided"}])
        self.assertEqual(response.status_code, 400)
        q.update.assert_not_called()

    def test_needs_the_migration(self):
        self.assertEqual(self._post([], migrated=False)[1].status_code, 501)


if __name__ == "__main__":
    unittest.main()
