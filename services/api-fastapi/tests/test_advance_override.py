"""CEO override on Advance Orders: executive + override key + reason."""

import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import transactions as tx

KEY = {"override_key": "secret", "reason": "Customer called"}


def _order(**over):
    order = {"id": "t1", "order_number": 1050, "status": "open", "kitchen_status": "queued",
             "payment_status": "paid", "order_type": "takeout", "scheduled_for": "2026-10-25T03:00:00+00:00",
             "advance_schedule_revision": 2, "items": []}
    order.update(over)
    return order


def _chain(data=()):
    q = MagicMock()
    for name in ("select", "eq", "neq", "limit", "update", "delete", "in_"):
        getattr(q, name).return_value = q
    q.execute.return_value = MagicMock(data=list(data))
    return q


class OverrideTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(app.dependency_overrides.clear)
        self._as("executive")
        self.tables = {"transactions": _chain([{"id": "t1"}]), "deliveries": _chain(), "digital_orders": _chain()}
        db = MagicMock()
        db.table.side_effect = lambda name: self.tables[name]
        self.patches = [
            patch.object(tx, "get_supabase", return_value=db),
            patch.object(tx, "_advance_supported_check", return_value=True),
            patch.object(tx, "verify_override_key", side_effect=lambda u, k: k == "secret"),
            patch.object(tx, "get_transaction", return_value=MagicMock()),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.client = TestClient(app)

    def _as(self, role):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id="u1", role=role, department=None, full_name="Joe", extra_pages=[])

    def _post(self, path, order, body, method="post"):
        with patch.object(tx, "_fetch_transaction_with_items", return_value=order), \
                patch.object(tx, "get_transaction", return_value=tx.TransactionResponse(
                    **{**_base_response(), **{k: v for k, v in order.items() if k in _base_response()}}, items=[])):
            return getattr(self.client, method)(f"/transactions/t1/advance-override/{path}", json=body)

    def test_only_executives_with_the_right_key(self):
        self._as("manager")
        self.assertEqual(self._post("void", _order(), KEY).status_code, 403)
        self._as("executive")
        self.assertEqual(self._post("void", _order(), {**KEY, "override_key": "nope"}).status_code, 403)

    def test_complete_unpaid_needs_a_payment_method(self):
        self.assertEqual(self._post("complete", _order(payment_status="unpaid"), KEY).status_code, 400)

    def test_complete_upcoming_unpaid_delivery(self):
        order = _order(payment_status="unpaid", order_type="delivery")
        with patch.object(tx, "settle_payment") as settle, patch.object(tx, "close_transaction") as close, \
                patch.object(tx, "delivery_row_for_transaction", return_value={"id": "d1", "delivered_at": None}):
            response = self._post("complete", order, {**KEY, "payment_method": "gcash"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(settle.call_args[0][1].payment_method, "gcash")
        close.assert_called_once()
        self.assertIn("delivered_at", self.tables["deliveries"].update.call_args[0][0])

    def test_void_at_any_stage(self):
        with patch.object(tx, "void_transaction_core", return_value=({**_base_response(), "status": "voided"}, [])) as void:
            response = self._post("void", _order(kitchen_status="preparing"), KEY)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(void.call_args[0][3].startswith("CEO override"))

    def test_erase_online_ticket_takes_the_online_order(self):
        self.tables["digital_orders"] = _chain([{"id": "o1"}])
        with patch("app.routers.digital_menu.erase_digital_order_core") as erase_online, \
                patch.object(tx, "erase_transaction_core") as erase_tx:
            response = self._post("erase", _order(), KEY)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(erase_online.call_args[0][1], "o1")
        erase_tx.assert_not_called()

    def test_reschedule_keeps_kitchen_status(self):
        body = {**KEY, "scheduled_for": "2026-10-19T01:00:00+00:00", "expected_revision": 2}
        response = self._post("schedule", _order(kitchen_status="ready"), body, method="patch")
        self.assertEqual(response.status_code, 200)
        patch_body = self.tables["transactions"].update.call_args[0][0]
        self.assertEqual(patch_body["scheduled_for"], "2026-10-19T01:00:00+00:00")
        self.assertNotIn("kitchen_status", patch_body)


class OverrideItemEditTests(unittest.TestCase):
    def test_done_order_is_not_requeued(self):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id="u1", role="executive", department=None, full_name="Joe", extra_pages=[])
        self.addCleanup(app.dependency_overrides.clear)
        claim = _chain([{"id": "t1"}])
        db = MagicMock()
        db.table.side_effect = lambda name: claim if name == "transactions" else _chain()
        order = _order(kitchen_status="completed", status="closed", items=[])
        with patch.object(tx, "get_supabase", return_value=db), \
                patch.object(tx, "_advance_supported_check", return_value=True), \
                patch.object(tx, "verify_override_key", return_value=True), \
                patch.object(tx, "_fetch_transaction_with_items", return_value=order), \
                patch.object(tx, "_locked_bundle_item_ids", return_value=set()), \
                patch.object(tx, "_prepare_items", return_value=({}, {}, None, None, None, False)), \
                patch.object(tx, "_restore_items_stock"), patch.object(tx, "_write_items_and_totals"), \
                patch.object(tx, "get_transaction", return_value=tx.TransactionResponse(**_base_response(), items=[])):
            response = TestClient(app).put("/transactions/t1/advance-items", json={
                "items": [{"product_size_id": "s1", "quantity": 1}], "expected_revision": 2, **KEY})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("kitchen_status", claim.update.call_args[0][0])


def _base_response():
    return {"id": "t1", "order_number": 1050, "employee_id": "u1", "status": "open", "total_amount": 100.0,
            "discount_amount": 0.0, "tax_amount": 0.0, "opened_at": "2026-10-19T00:00:00+00:00", "closed_at": None,
            "kitchen_status": "queued", "order_type": "takeout", "table_number": None, "guest_count": None,
            "payment_method": "cash", "card_type": None, "force_vat_exempt": False, "is_owner_request": False}


if __name__ == "__main__":
    unittest.main()
