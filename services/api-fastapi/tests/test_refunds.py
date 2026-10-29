"""Refunds on completed orders: double punches and late refunds (2026-10-29)."""

import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import refunds

TX = {"id": "t1", "employee_id": "u1", "status": "closed", "kitchen_status": "completed", "items": []}
REFUND = {"id": "r1", "transaction_id": "t1", "requested_by": "u1", "requested_at": "2026-10-29T10:30:00+00:00",
          "reason": "Double punch", "status": "pending"}


def _db(*results):
    db = MagicMock()
    q = db.table.return_value
    for name in ("select", "eq", "in_", "maybe_single", "insert", "update", "order", "limit"):
        getattr(q, name).return_value = q
    q.execute.side_effect = [MagicMock(data=r) for r in results]
    return db


def _as(role, user_id="u1"):
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id, role, None, "Test", [])


class RefundRequestTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(app.dependency_overrides.clear)

    def _request(self, tx):
        # tx lookup, pending check, insert, then _decorate's two reads
        db = _db(tx, None, [REFUND], [], [])
        with patch.object(refunds, "get_supabase", return_value=db):
            return self.client.post("/refunds", json={"transaction_id": "t1", "reason": "Double punch"})

    def test_completed_order_can_be_requested(self):
        _as("employee")
        self.assertEqual(self._request(TX).status_code, 200)

    def test_queued_order_is_voided_directly(self):
        _as("employee")
        self.assertEqual(self._request({**TX, "kitchen_status": "queued"}).status_code, 409)

    def test_employee_only_on_own_orders(self):
        _as("employee", "someone-else")
        self.assertEqual(self._request(TX).status_code, 403)


class RefundApproveTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(app.dependency_overrides.clear)
        _as("manager")

    def _approve(self, tx, body=None):
        db = _db(REFUND, [{**REFUND, "status": "approved"}], [], [])
        with patch.object(refunds, "get_supabase", return_value=db), \
             patch.object(refunds, "_fetch_transaction_with_items", return_value=tx), \
             patch.object(refunds, "void_transaction_core") as void:
            response = self.client.post("/refunds/r1/approve", json=body) if body is not None \
                else self.client.post("/refunds/r1/approve")
        self.assertEqual(response.status_code, 200, response.text)
        return void.call_args

    def test_completed_order_voided_without_returning_stock(self):
        call = self._approve(TX)
        self.assertFalse(call.kwargs["restore_stock"])
        self.assertIn("(stock not returned)", call.args[3])

    def test_double_punch_can_return_stock(self):
        self.assertTrue(self._approve(TX, {"restore_stock": True}).kwargs["restore_stock"])

    def test_ready_order_returns_stock_by_default(self):
        self.assertTrue(self._approve({**TX, "kitchen_status": "ready"}).kwargs["restore_stock"])


class VoidCoreTests(unittest.TestCase):
    def test_restore_stock_false_skips_restore(self):
        from app.routers import transactions
        db = _db([{"id": "t1", "status": "voided"}])
        with patch.object(transactions, "_restore_items_stock") as restore, \
             patch.object(transactions, "_bundle_fulfilled_item_ids", return_value=set()):
            transactions.void_transaction_core(db, {"id": "t1", "items": []}, "u1", "x", restore_stock=False)
        restore.assert_not_called()


if __name__ == "__main__":
    unittest.main()
