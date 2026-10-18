"""Executive permanent order erase, guarded by an override key (0076)."""

import unittest
from unittest.mock import MagicMock, patch

import bcrypt
from fastapi.testclient import TestClient

from app import auth
from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import override_key, transactions

ORDER = {"id": "t1", "order_number": 1047, "status": "open", "total_amount": 378.0, "items": []}
BODY = {"override_key": "secret-key", "reason": "Test order"}


def _as(role: str):
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="u1", role=role, department=None, full_name="Joe", extra_pages=[])


def _db(blocked: bool = False):
    db = MagicMock()
    q = db.table.return_value
    for name in ("select", "eq", "limit"):
        getattr(q, name).return_value = q
    q.execute.return_value = MagicMock(data=[{"id": "r1"}] if blocked else [])
    return db


class EraseTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def post(self, body=BODY):
        return self.client.post("/transactions/t1/erase", json=body)

    def test_only_executives(self):
        _as("manager")
        self.assertEqual(self.post().status_code, 403)

    def test_wrong_key_is_refused(self):
        _as("executive")
        with patch.object(transactions, "verify_override_key", return_value=False), \
                patch.object(transactions, "get_supabase") as db:
            self.assertEqual(self.post().status_code, 403)
        db.assert_not_called()

    def test_refund_blocks_erase(self):
        _as("executive")
        db = _db(blocked=True)
        with patch.object(transactions, "verify_override_key", return_value=True), \
                patch.object(transactions, "get_supabase", return_value=db), \
                patch.object(transactions, "_fetch_transaction_with_items", return_value=ORDER), \
                patch.object(transactions, "_restore_items_stock") as restore:
            self.assertEqual(self.post().status_code, 409)
        restore.assert_not_called()
        db.rpc.assert_not_called()

    def test_stock_returned_before_erase(self):
        _as("executive")
        db = _db()
        order = MagicMock()
        with patch.object(transactions, "verify_override_key", return_value=True), \
                patch.object(transactions, "get_supabase", return_value=db), \
                patch.object(transactions, "_fetch_transaction_with_items", return_value=ORDER), \
                patch.object(transactions, "_restore_items_stock") as restore:
            order.attach_mock(restore, "restore")
            order.attach_mock(db.rpc, "rpc")
            self.assertEqual(self.post().status_code, 200)
        self.assertEqual([c[0] for c in order.mock_calls[:2]], ["restore", "rpc"])
        db.rpc.assert_called_with("erase_transaction", {"p_id": "t1"})

    def test_voided_order_stock_not_returned_twice(self):
        _as("executive")
        with patch.object(transactions, "verify_override_key", return_value=True), \
                patch.object(transactions, "get_supabase", return_value=_db()), \
                patch.object(transactions, "_fetch_transaction_with_items", return_value={**ORDER, "status": "voided"}), \
                patch.object(transactions, "_restore_items_stock") as restore:
            self.assertEqual(self.post().status_code, 200)
        restore.assert_not_called()


class OverrideKeyTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_setting_a_key_needs_your_own_pin(self):
        _as("executive")
        with patch.object(override_key, "verify_employee_pin", return_value={"id": "someone-else"}):
            r = self.client.post("/profiles/me/override-key", json={"employee_number": "1", "pin": "1", "new_key": "abcdef"})
        self.assertEqual(r.status_code, 403)

    def test_key_is_stored_hashed_and_verifies(self):
        _as("executive")
        db = _db()
        with patch.object(override_key, "verify_employee_pin", return_value={"id": "u1"}), \
                patch.object(override_key, "get_supabase", return_value=db):
            r = self.client.post("/profiles/me/override-key", json={"employee_number": "1", "pin": "1", "new_key": "abcdef"})
        self.assertEqual(r.json(), {"is_set": True})
        stored = db.table.return_value.update.call_args[0][0]["override_key_hash"]
        self.assertNotIn("abcdef", stored)
        user = CurrentUser(id="u1", role="executive", department=None, full_name="Joe", extra_pages=[])
        row = MagicMock(); row.data = {"override_key_hash": stored}
        q = MagicMock(); q.select.return_value = q; q.eq.return_value = q; q.maybe_single.return_value = q; q.execute.return_value = row
        with patch.object(auth, "get_supabase", return_value=MagicMock(table=MagicMock(return_value=q))):
            self.assertTrue(auth.verify_override_key(user, "abcdef"))
            self.assertFalse(auth.verify_override_key(user, "wrong!"))
            manager = CurrentUser(id="u1", role="manager", department=None, full_name="M", extra_pages=[])
            self.assertFalse(auth.verify_override_key(manager, "abcdef"))


if __name__ == "__main__":
    unittest.main()
