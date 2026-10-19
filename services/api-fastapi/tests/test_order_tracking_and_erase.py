"""Customer "Track my order" progress/lookup and the executive online-order erase."""

import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import digital_menu as dm


def _chain(data):
    q = MagicMock()
    for name in ("select", "eq", "neq", "gte", "limit", "delete", "maybe_single", "in_", "order"):
        getattr(q, name).return_value = q
    q.execute.return_value = MagicMock(data=data)
    return q


def _db(tables: dict):
    db = MagicMock()
    db.table.side_effect = lambda name: tables[name]
    return db


class TrackingStageTests(unittest.TestCase):
    def test_stages(self):
        delivery = {"status": "approved", "order_channel": "delivery", "delivery": {"delivered_at": None}}
        pickup = {"status": "approved", "order_channel": "pickup"}
        stage = dm.tracking_stage
        self.assertEqual(stage({"status": "pending"}, None), "waiting")
        self.assertEqual(stage({"status": "rejected"}, None), "declined")
        self.assertEqual(stage(delivery, {"status": "voided"}), "declined")
        self.assertEqual(stage(delivery, None), "in_queue")
        self.assertEqual(stage(delivery, {"status": "open", "kitchen_status": "queued"}), "in_queue")
        self.assertEqual(stage(delivery, {"status": "open", "kitchen_status": "preparing"}), "preparing")
        self.assertEqual(stage(delivery, {"status": "open", "kitchen_status": "completed"}), "out_for_delivery")
        delivered = {**delivery, "delivery": {"delivered_at": "2026-10-19T09:00:00Z"}}
        self.assertEqual(stage(delivered, {"status": "open", "kitchen_status": "completed"}), "completed")
        self.assertEqual(stage(pickup, {"status": "open", "kitchen_status": "ready"}), "ready_for_pickup")
        self.assertEqual(stage(pickup, {"status": "closed", "kitchen_status": "completed"}), "completed")


class CustomerOrderTests(unittest.TestCase):
    def test_staff_only_delivery_fields_are_hidden(self):
        order = {"id": "o1", "status": "approved", "order_channel": "delivery", "transaction_id": "t1",
                 "delivery": {"delivered_at": None, "rider_payout": 60.0, "rider_id": "r1", "rider_name": "Ben"}}
        db = _db({"transactions": _chain([{"order_number": 1040, "status": "open", "kitchen_status": "preparing"}])})
        with patch.object(dm, "_fetch_digital_order", return_value=order):
            result = dm._customer_order(db, "o1")
        self.assertEqual((result["tracking_stage"], result["pos_order_number"]), ("preparing", 1040))
        self.assertIsNone(result["delivery"]["rider_payout"])
        self.assertIsNone(result["delivery"]["rider_id"])
        self.assertEqual(result["delivery"]["rider_name"], "Ben")


class LookupTests(unittest.TestCase):
    def _get(self, phone, orders=({"id": "o1"},), stored_phone="0919 893 8139"):
        db = _db({"digital_orders": _chain(list(orders)),
                  "deliveries": _chain([{"customer_phone": stored_phone}])})
        with patch.object(dm, "get_supabase", return_value=db), \
                patch.object(dm, "enforce_rate_limit"), patch.object(dm, "local_rate_limit"):
            return TestClient(app).get("/public/orders/lookup", params={"order_number": 73, "phone": phone})

    def test_number_and_phone_match(self):
        response = self._get("+63 919-893-8139")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"id": "o1"})

    def test_wrong_phone_or_unknown_number(self):
        self.assertEqual(self._get("09170000000").status_code, 404)
        self.assertEqual(self._get("09198938139", orders=()).status_code, 404)
        self.assertEqual(self._get("123").status_code, 404)


class OnlineEraseTests(unittest.TestCase):
    BODY = {"override_key": "secret-key", "reason": "Test order"}

    def setUp(self):
        self.addCleanup(app.dependency_overrides.clear)

    def _as(self, role):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id="u1", role=role, department=None, full_name="Joe", extra_pages=[])

    def _post(self, order, deposits=(), key_ok=True):
        tables = {"digital_orders": _chain([order] if order else []),
                  "sushi_boat_deposits": _chain(list(deposits))}
        db = _db(tables)
        with patch.object(dm, "get_supabase", return_value=db), \
                patch.object(dm, "verify_override_key", return_value=key_ok), \
                patch.object(dm, "erase_transaction_core") as erase_tx:
            response = TestClient(app).post("/digital-orders/o1/erase", json=self.BODY)
        return response, tables, erase_tx

    def test_only_executives(self):
        self._as("manager")
        response, _, erase_tx = self._post({"id": "o1", "order_number": 70, "transaction_id": None})
        self.assertEqual(response.status_code, 403)
        erase_tx.assert_not_called()

    def test_wrong_key(self):
        self._as("executive")
        response, tables, _ = self._post({"id": "o1", "order_number": 70, "transaction_id": None}, key_ok=False)
        self.assertEqual(response.status_code, 403)
        tables["digital_orders"].delete.assert_not_called()

    def test_approved_order_erases_its_ticket_then_the_order(self):
        self._as("executive")
        response, tables, erase_tx = self._post({"id": "o1", "order_number": 70, "transaction_id": "t1"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(erase_tx.call_args[0][1], "t1")
        tables["digital_orders"].delete.assert_called_once()

    def test_handled_boat_deposit_blocks(self):
        self._as("executive")
        response, tables, erase_tx = self._post(
            {"id": "o1", "order_number": 70, "transaction_id": "t1"},
            deposits=[{"id": "d1", "collected_at": "2026-10-19T09:00:00Z", "handoff_at": None, "returned_at": None}])
        self.assertEqual(response.status_code, 409)
        erase_tx.assert_not_called()
        tables["digital_orders"].delete.assert_not_called()


if __name__ == "__main__":
    unittest.main()
