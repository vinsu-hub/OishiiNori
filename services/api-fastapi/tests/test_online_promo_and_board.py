"""First-online-order promo and the cashier's online order board (0078)."""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import digital_menu as dm


def _chain(data):
    q = MagicMock()
    for name in ("select", "eq", "maybe_single", "upsert", "insert", "delete", "update", "limit", "in_", "order"):
        getattr(q, name).return_value = q
    q.execute.return_value = MagicMock(data=data)
    return q


class PromoTests(unittest.TestCase):
    def _db(self, won: bool):
        tables = {
            "business_settings": _chain({"first_order_promo_size_id": "tori-4"}),
            "online_promo_claims": _chain([{"promo_date": "2026-10-19"}] if won else []),
            "digital_order_items": _chain([]),
        }
        db = MagicMock()
        db.table.side_effect = lambda name: tables[name]
        return db, tables

    def test_first_order_gets_a_free_item(self):
        db, tables = self._db(won=True)
        self.assertTrue(dm._claim_first_order_promo(db, "order-1", 499.0))
        row = tables["digital_order_items"].insert.call_args[0][0]
        self.assertEqual((row["product_size_id"], row["unit_price"], row["quantity"], row["is_promo"]), ("tori-4", 0, 1, True))

    def test_later_orders_get_nothing(self):
        db, tables = self._db(won=False)
        self.assertFalse(dm._claim_first_order_promo(db, "order-2", 600.0))
        tables["digital_order_items"].insert.assert_not_called()

    def test_claim_is_one_per_day(self):
        db, tables = self._db(won=True)
        dm._claim_first_order_promo(db, "order-1", 499.0)
        kwargs = tables["online_promo_claims"].upsert.call_args.kwargs
        self.assertEqual((kwargs["on_conflict"], kwargs["ignore_duplicates"]), ("promo_date", True))

    def test_order_under_minimum_keeps_the_promo_open(self):
        db, tables = self._db(won=True)
        self.assertFalse(dm._claim_first_order_promo(db, "order-1", 498.0))
        tables["online_promo_claims"].upsert.assert_not_called()
        tables["digital_order_items"].insert.assert_not_called()

    def test_status_endpoint(self):
        for size_id, claims, expected in (("tori-4", [], True), ("tori-4", [{"promo_date": "x"}], False), (None, [], False)):
            dm._public_cache.clear()
            tables = {
                "business_settings": _chain({"first_order_promo_size_id": size_id}),
                "online_promo_claims": _chain(claims),
            }
            db = MagicMock()
            db.table.side_effect = lambda name: tables[name]
            with patch.object(dm, "get_supabase", return_value=db):
                body = TestClient(app).get("/public/promo/first-order").json()
            self.assertEqual((body["available"], body["min_subtotal"]), (expected, 499.0))
        dm._public_cache.clear()

    def test_promo_line_is_zeroed_on_approval(self):
        db = MagicMock()
        tx = SimpleNamespace(items=[
            SimpleNamespace(id="a", product_size_id="tori-4", unit_price=94.0, quantity=1),  # paid by the customer
            SimpleNamespace(id="b", product_size_id="tori-4", unit_price=94.0, quantity=1),  # the free one (last)
        ])
        order = {"items": [{"product_size_id": "tori-4", "is_promo": False}, {"product_size_id": "tori-4", "is_promo": True}]}
        self.assertEqual(dm._zero_promo_lines(db, order, tx), 94.0)
        db.table.return_value.update.assert_called_once_with({"unit_price": 0})
        db.table.return_value.update.return_value.eq.assert_called_once_with("id", "b")


class BoardStageTests(unittest.TestCase):
    def test_stages(self):
        delivery = {"status": "approved", "order_channel": "delivery", "delivery": {"delivered_at": None}}
        self.assertEqual(dm.board_stage({"status": "pending"}, None), "pending")
        self.assertEqual(dm.board_stage(delivery, None), "in_queue")  # advance order not fired yet
        self.assertEqual(dm.board_stage(delivery, {"kitchen_status": "preparing"}), "in_queue")
        self.assertEqual(dm.board_stage(delivery, {"kitchen_status": "completed"}), "out_for_delivery")
        done = {**delivery, "delivery": {"delivered_at": "2026-10-19T05:00:00Z"}}
        self.assertEqual(dm.board_stage(done, {"kitchen_status": "completed"}), "completed")
        # Cash still with the rider: delivered but not complete until it's logged.
        self.assertEqual(dm.board_stage(done, {"kitchen_status": "completed", "payment_status": "unpaid"}), "out_for_delivery")
        pickup = {"status": "approved", "order_channel": "pickup"}
        self.assertEqual(dm.board_stage(pickup, {"kitchen_status": "preparing"}), "in_queue")
        self.assertEqual(dm.board_stage(pickup, {"kitchen_status": "ready"}), "out_for_delivery")
        self.assertEqual(dm.board_stage(pickup, {"kitchen_status": "completed"}), "completed")
        self.assertEqual(dm.board_stage(pickup, {"kitchen_status": "completed", "payment_status": "unpaid"}), "out_for_delivery")
        self.assertEqual(dm.board_stage(delivery, {"status": "closed", "kitchen_status": "completed"}), "completed")
        self.assertIsNone(dm.board_stage({"status": "rejected"}, None))
        self.assertIsNone(dm.board_stage(delivery, {"status": "voided", "kitchen_status": "queued"}))

    def test_board_is_front_of_house_only(self):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id="k", role="kitchen", department=None, full_name="K", extra_pages=[])
        try:
            self.assertEqual(TestClient(app).get("/digital-orders/board").status_code, 403)
        finally:
            app.dependency_overrides.clear()


class ApprovalPaymentTests(unittest.TestCase):
    def _fire(self, method, channel):
        order = {"payment_method": method, "order_channel": channel, "items": [], "addons": [], "delivery": None}
        tx = SimpleNamespace(id="t1", items=[], total_amount=0.0, tax_amount=0.0)
        with patch.object(dm, "_create_transaction_row", return_value=tx) as create:
            dm._fire_digital_order(MagicMock(), order, "u1")
        return create.call_args.kwargs

    def test_cash_orders_stay_unpaid_until_logged(self):
        self.assertTrue(self._fire("cash", "delivery")["pay_on_delivery"])
        self.assertTrue(self._fire("cash", "pickup")["pay_on_delivery"])

    def test_proof_paid_orders_are_paid_at_approval(self):
        kwargs = self._fire("GCash", "delivery")
        self.assertFalse(kwargs["pay_on_delivery"])
        self.assertEqual(kwargs["payment_method"], "gcash")


class CompleteOnlineOrderTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id="c", role="employee", department=None, full_name="Cashier", extra_pages=[])
        self.addCleanup(app.dependency_overrides.clear)

    def _run(self, order, tx):
        tables = {"digital_orders": _chain(order), "transactions": _chain(tx)}
        db = MagicMock()
        db.table.side_effect = lambda name: tables[name]
        with patch.object(dm, "get_supabase", return_value=db), \
                patch.object(dm, "settle_payment") as settle, \
                patch.object(dm, "mark_digital_order_delivered") as delivered, \
                patch.object(dm, "close_transaction") as close:
            response = TestClient(app).post("/digital-orders/o1/complete")
        return response, settle, delivered, close

    def test_cash_delivery_is_settled_delivered_and_closed(self):
        response, settle, delivered, close = self._run(
            {"id": "o1", "status": "approved", "order_channel": "delivery", "transaction_id": "t1"},
            {"id": "t1", "status": "open", "payment_status": "unpaid"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(settle.call_args[0][1].payment_method, "cash")
        delivered.assert_called_once()
        close.assert_called_once()

    def test_paid_pickup_already_closed_changes_nothing(self):
        response, settle, delivered, close = self._run(
            {"id": "o1", "status": "approved", "order_channel": "pickup", "transaction_id": "t1"},
            {"id": "t1", "status": "closed", "payment_status": "paid"})
        self.assertEqual(response.status_code, 200)
        settle.assert_not_called()
        delivered.assert_not_called()
        close.assert_not_called()

    def test_pending_order_cannot_be_completed(self):
        response, *_ = self._run({"id": "o1", "status": "pending", "order_channel": "delivery", "transaction_id": None}, None)
        self.assertEqual(response.status_code, 409)


if __name__ == "__main__":
    unittest.main()
