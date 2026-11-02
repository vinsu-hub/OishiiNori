"""Cashier overrides on online orders: payment, items, schedule (2026-11-02)."""

import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import deliveries, digital_menu as dm, transactions
from app.schemas import SettlePaymentRequest

NOW = datetime.now(timezone.utc)
FUTURE = (NOW + timedelta(days=2)).isoformat()
SIZES = {
    "maki": {"id": "maki", "price": 100, "deposit_amount": 0, "size_label": "4 pcs",
             "products": {"name": "California Maki", "takeout_bowl_eligible": True}},
    "coke": {"id": "coke", "price": 50, "deposit_amount": 0, "size_label": "Regular",
             "products": {"name": "Coke", "takeout_bowl_eligible": False}},
    "boat": {"id": "boat", "price": 900, "deposit_amount": 500, "size_label": "Regular",
             "products": {"name": "Sushi Boat", "takeout_bowl_eligible": False}},
    "free": {"id": "free", "price": 94, "deposit_amount": 0, "size_label": "4 pcs",
             "products": {"name": "Torikatsu Maki", "takeout_bowl_eligible": True}},
}
ORDER = {
    "id": "o1", "order_channel": "delivery", "status": "approved", "payment_method": "cash", "transaction_id": "t1",
    "subtotal": 100.0, "packaging_fee": 10.0, "boat_deposit": 0, "edit_revision": 0, "scheduled_for": None,
    "delivery": {"delivery_fee": 50, "delivered_at": None}, "addons": [],
    "items": [{"id": "l1", "product_size_id": "maki", "quantity": 1, "unit_price": 100, "held_ingredients": []}],
}
TX = {"id": "t1", "status": "open", "kitchen_status": "queued", "payment_status": "unpaid", "paid_at": None,
      "opened_at": NOW.isoformat(), "payment_method": "cash", "scheduled_for": None, "advance_schedule_revision": 0}


def _db():
    db = MagicMock()
    q = db.table.return_value
    for name in ("select", "eq", "in_", "is_", "limit", "update", "insert", "delete", "order"):
        getattr(q, name).return_value = q
    q.execute.return_value = MagicMock(data=[{"id": "x"}])
    return db


def _as(role):
    app.dependency_overrides[get_current_user] = lambda: CurrentUser("u1", role, None, "Test", [])


def _updates(db):
    return [call.args[0] for call in db.table.return_value.update.call_args_list]


class OverrideCase(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(app.dependency_overrides.clear)
        _as("employee")
        self.db = _db()
        for patcher in (
            patch.object(dm, "get_supabase", return_value=self.db),
            patch.object(dm, "order_overrides_supported_check", return_value=True),
            patch.object(dm, "_online_method_name", side_effect=lambda _db, name: "cash" if name.lower() == "cash" else name),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def _order(self, order=ORDER, tx=TX):
        patcher = patch.object(dm, "_order_for_override", return_value=(order, tx))
        patcher.start()
        self.addCleanup(patcher.stop)


class PaymentTests(OverrideCase):
    def _change(self, method="GCash", reason="Paid by GCash at the door"):
        return self.client.post("/digital-orders/o1/payment-method", json={"payment_method": method, "reason": reason})

    def test_unpaid_cash_to_gcash_is_received_now(self):
        self._order()
        with patch.object(dm, "settle_payment") as settle:
            self.assertEqual(self._change().status_code, 200)
        self.assertEqual(settle.call_args.args[1].payment_method, "gcash")
        self.assertIn({"payment_method": "GCash"}, _updates(self.db))
        self.db.table.assert_any_call("online_order_changes")

    def test_paid_order_in_open_shift_keeps_its_paid_time(self):
        self._order(tx={**TX, "payment_status": "paid", "paid_at": NOW.isoformat()})
        shift = {"opened_at": (NOW - timedelta(hours=1)).isoformat()}
        with patch.object(dm, "fetch_open_shift", return_value=shift), patch.object(dm, "settle_payment") as settle:
            self.assertEqual(self._change().status_code, 200)
        settle.assert_not_called()
        self.assertIn({"payment_method": "gcash", "card_type": None}, _updates(self.db))

    def test_paid_order_in_closed_shift_is_refused(self):
        self._order(tx={**TX, "payment_status": "paid", "paid_at": (NOW - timedelta(days=1)).isoformat()})
        shift = {"opened_at": (NOW - timedelta(hours=1)).isoformat()}
        with patch.object(dm, "fetch_open_shift", return_value=shift):
            self.assertEqual(self._change().status_code, 409)
        self.assertEqual(_updates(self.db), [])

    def test_order_not_in_kitchen_only_changes_the_digital_row(self):
        self._order(tx=None)
        with patch.object(dm, "settle_payment") as settle:
            self.assertEqual(self._change().status_code, 200)
        settle.assert_not_called()

    def test_same_method_and_blank_reason_are_refused(self):
        self._order()
        self.assertEqual(self._change("cash").status_code, 400)
        self.assertEqual(self._change(reason="   ").status_code, 400)

    def test_kitchen_and_rider_are_refused(self):
        for role in ("kitchen", "rider"):
            _as(role)
            self.assertEqual(self._change().status_code, 403)

    def test_voided_order_is_refused(self):
        self.db.table.return_value.execute.return_value = MagicMock(data=[{**TX, "status": "voided"}])
        with patch.object(dm, "_fetch_digital_order", return_value=dict(ORDER)):
            self.assertEqual(self._change().status_code, 409)

    def test_settling_on_deliveries_updates_the_online_order(self):
        db = _db()
        db.table.return_value.execute.side_effect = [
            MagicMock(data=[{"id": "o1", "payment_method": "cash"}]),
            MagicMock(data=[{"name": "GCash"}, {"name": "Maya"}]),
            MagicMock(data=[{}]),
            MagicMock(data=[{}]),
        ]
        with patch.object(transactions, "order_overrides_supported_check", return_value=True):
            transactions._sync_online_order_method(db, "t1", "gcash", "u1")
        self.assertEqual(_updates(db), [{"payment_method": "GCash"}])

    def test_settling_leaves_a_named_provider_alone(self):
        db = _db()
        db.table.return_value.execute.return_value = MagicMock(data=[{"id": "o1", "payment_method": "Maribank"}])
        transactions._sync_online_order_method(db, "t1", "gcash", "u1")
        self.assertEqual(_updates(db), [])

    def test_complete_with_gcash_records_no_cash(self):
        self.db.table.return_value.execute.side_effect = None
        reads = [MagicMock(data={"id": "o1", "status": "approved", "order_channel": "delivery",
                                 "transaction_id": "t1", "payment_method": "cash"}),
                 MagicMock(data={"id": "t1", "status": "open", "payment_status": "unpaid"})]
        self.db.table.return_value.maybe_single.return_value.execute.side_effect = reads
        self._order()
        with patch.object(dm, "_change_order_payment") as change, patch.object(dm, "settle_payment") as settle, \
             patch.object(dm, "mark_digital_order_delivered"), patch.object(dm, "close_transaction"):
            r = self.client.post("/digital-orders/o1/complete", json={"payment_method": "GCash", "reference": "123"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(change.call_args.args[3], "GCash")
        settle.assert_not_called()

    def test_complete_with_no_body_is_still_cash(self):
        reads = [MagicMock(data={"id": "o1", "status": "approved", "order_channel": "delivery",
                                 "transaction_id": "t1", "payment_method": "cash"}),
                 MagicMock(data={"id": "t1", "status": "open", "payment_status": "unpaid"})]
        self.db.table.return_value.maybe_single.return_value.execute.side_effect = reads
        with patch.object(dm, "settle_payment") as settle, patch.object(dm, "mark_digital_order_delivered"), \
             patch.object(dm, "close_transaction"):
            self.assertEqual(self.client.post("/digital-orders/o1/complete").status_code, 200)
        self.assertEqual(settle.call_args.args[1].payment_method, "cash")


class ItemEditTests(OverrideCase):
    def setUp(self):
        super().setUp()
        q = self.db.table.return_value
        q.execute.side_effect = lambda: MagicMock(data=list(SIZES.values()) if self._reading_sizes() else [{"id": "x"}])

    def _reading_sizes(self):
        return self.db.table.call_args.args[0] == "product_sizes"

    def _edit(self, items, revision=0):
        return self.client.put("/digital-orders/o1/items", json={"items": items, "reason": "Added by Facebook", "expected_revision": revision})

    def _replace(self, total=150.0, tax=18.0, inserted=()):
        patcher = patch.object(dm, "replace_transaction_items",
                               return_value=({"total_amount": total, "tax_amount": tax}, list(inserted)))
        self.addCleanup(patcher.stop)
        return patcher.start()

    MORE = [{"product_size_id": "maki", "quantity": 1}, {"product_size_id": "coke", "quantity": 1}]

    def test_order_not_in_kitchen_changes_only_digital_rows(self):
        self._order(tx=None)
        replace = self._replace()
        r = self._edit(self.MORE)
        self.assertEqual(r.status_code, 200, r.text)
        replace.assert_not_called()
        self.assertEqual(r.json()["difference"], 50.0)
        self.assertIn({"subtotal": 150.0, "packaging_fee": 10.0}, _updates(self.db))

    def test_ticket_keeps_fee_packaging_and_addons(self):
        order = {**ORDER, "addons": [{"unit_price": 20, "quantity": 1}], "subtotal": 120.0}
        self._order(order=order)
        replace = self._replace(total=150.0, tax=18.0)
        with patch.object(dm, "_fetch_transaction_with_items", return_value={"id": "t1", "items": []}), \
             patch.object(dm, "_get_vat_rate", return_value=0.12):
            self.assertEqual(self._edit(self.MORE).status_code, 200)
        self.assertEqual(replace.call_args.kwargs["claim_extra"], {"kitchen_change_note": "ADDED: 1x Coke"})
        totals = next(u for u in _updates(self.db) if "total_amount" in u)
        # 150 catalog + 20 add-on + 50 delivery + 10 packaging
        self.assertEqual(totals["total_amount"], 230.0)
        self.assertAlmostEqual(totals["tax_amount"], 18.0 + 80 * 0.12)

    def test_free_promo_item_stays_free(self):
        promo = {"id": "l2", "product_size_id": "free", "quantity": 1, "unit_price": 0, "held_ingredients": [], "is_promo": True}
        self._order(order={**ORDER, "items": [*ORDER["items"], promo]})
        inserted = [{"id": "a", "product_size_id": "maki", "unit_price": 100, "quantity": 1},
                    {"id": "b", "product_size_id": "coke", "unit_price": 50, "quantity": 1},
                    {"id": "c", "product_size_id": "free", "unit_price": 94, "quantity": 1}]
        replace = self._replace(total=244.0, tax=29.28, inserted=inserted)
        with patch.object(dm, "_fetch_transaction_with_items", return_value={"id": "t1", "items": []}), \
             patch.object(dm, "_get_vat_rate", return_value=0.12):
            self.assertEqual(self._edit(self.MORE).status_code, 200)
        self.assertEqual(replace.call_args.args[2][-1].product_size_id, "free")
        self.assertIn({"unit_price": 0}, _updates(self.db))
        totals = next(u for u in _updates(self.db) if "total_amount" in u)
        self.assertEqual(totals["total_amount"], 244.0 + 60 - 94)

    def test_removed_item_is_on_the_note(self):
        self._order()
        replace = self._replace()
        with patch.object(dm, "_fetch_transaction_with_items", return_value={"id": "t1", "items": []}):
            self._edit([{"product_size_id": "coke", "quantity": 2}])
        self.assertEqual(replace.call_args.kwargs["claim_extra"]["kitchen_change_note"],
                         "ADDED: 2x Coke / REMOVED: 1x California Maki (4 pcs)")

    def test_stale_revision_is_refused(self):
        self._order()
        self.assertEqual(self._edit(self.MORE, revision=4).status_code, 409)

    def test_order_that_left_the_kitchen_is_refused(self):
        self._order(tx={**TX, "kitchen_status": "completed"})
        self.assertEqual(self._edit(self.MORE).status_code, 409)

    def test_boats_cannot_be_added(self):
        self._order()
        self.assertEqual(self._edit([{"product_size_id": "boat", "quantity": 1}]).status_code, 400)

    def test_nothing_changed_is_refused(self):
        self._order()
        self.assertEqual(self._edit([{"product_size_id": "maki", "quantity": 1}]).status_code, 400)

    def test_empty_order_is_refused(self):
        self._order()
        self.assertEqual(self._edit([]).status_code, 400)


class ReplaceItemsTests(unittest.TestCase):
    def test_stock_is_given_back_and_taken_again(self):
        db = _db()
        ticket = {"id": "t1", "advance_schedule_revision": 2, "order_type": "delivery", "items": [
            {"id": "i1", "product_size_id": "maki", "quantity": 1, "unit_price": 100}]}
        line = SimpleNamespace(product_size_id="coke", quantity=1, discount_type_id=None)
        with patch.object(transactions, "_locked_bundle_item_ids", return_value=set()), \
             patch.object(transactions, "_prepare_items", return_value=({}, {}, None, None, None, False)), \
             patch.object(transactions, "_restore_items_stock") as restore, \
             patch.object(transactions, "_write_items_and_totals", return_value=({"total_amount": 50}, [])) as write:
            transactions.replace_transaction_items(db, ticket, [line], "u1", claim_extra={"kitchen_change_note": "n"})
        restore.assert_called_once()
        write.assert_called_once()
        claim = _updates(db)[0]
        self.assertEqual((claim["advance_schedule_revision"], claim["kitchen_status"], claim["kitchen_change_note"]), (3, "queued", "n"))


class ScheduleTests(OverrideCase):
    def _move(self, when=FUTURE):
        return self.client.post("/digital-orders/o1/schedule", json={"scheduled_for": when, "reason": "For Saturday"})

    def test_order_not_in_kitchen_is_held(self):
        self._order(tx=None)
        self.assertEqual(self._move().status_code, 200)
        self.assertEqual(len(_updates(self.db)), 1)
        self.assertIn("scheduled_for", _updates(self.db)[0])

    def test_ticket_in_kitchen_goes_back_as_upcoming(self):
        self._order(tx={**TX, "kitchen_status": "preparing", "advance_schedule_revision": 1})
        self.assertEqual(self._move().status_code, 200)
        ticket, digital = _updates(self.db)
        self.assertEqual(ticket["kitchen_status"], "queued")
        self.assertEqual(ticket["advance_schedule_revision"], 2)
        self.assertIn("MOVED TO A LATER DATE", ticket["kitchen_change_note"])
        self.assertEqual(ticket["scheduled_for"], digital["scheduled_for"])

    def test_ready_order_is_refused(self):
        self._order(tx={**TX, "kitchen_status": "ready"})
        self.assertEqual(self._move().status_code, 409)

    def test_time_outside_the_limit_is_refused(self):
        self._order(tx=None)
        self.assertEqual(self._move((NOW + timedelta(days=9)).isoformat()).status_code, 400)

    def test_moved_order_never_fires_twice(self):
        # Firing only selects orders with no ticket yet.
        db = _db()
        db.table.return_value.not_.is_.return_value = db.table.return_value
        db.table.return_value.lte.return_value = db.table.return_value
        db.table.return_value.execute.return_value = MagicMock(data=[])
        dm._fire_next_check = dm._fire_backoff_until = 0.0
        self.assertEqual(dm.fire_due_scheduled_orders(db), 0)
        db.table.return_value.is_.assert_any_call("transaction_id", "null")


class RiderListTests(unittest.TestCase):
    def _pending_ids(self, online=(), pos=()):
        db = _db()
        for name in ("neq", "or_"):
            getattr(db.table.return_value, name).return_value = db.table.return_value
        rows = {"transactions": list(pos), "digital_orders": list(online)}
        db.table.return_value.execute.side_effect = lambda: MagicMock(data=rows[db.table.call_args.args[0]])
        return deliveries._pending_ticket_ids(db), db

    def test_future_orders_are_hidden_until_the_prep_window(self):
        (orders, _), _ = self._pending_ids(online=[
            {"id": "later", "scheduled_for": FUTURE, "transactions": None},
            {"id": "now", "scheduled_for": None, "transactions": None},
        ])
        self.assertEqual(orders, ["now"])

    def test_old_finished_paid_orders_drop_off(self):
        old = (NOW - timedelta(days=5)).isoformat()
        tx = {"status": "open", "kitchen_status": "completed", "payment_status": "paid", "opened_at": old}
        (orders, _), _ = self._pending_ids(online=[
            {"id": "finished", "scheduled_for": None, "transactions": tx},
            {"id": "cash-out", "scheduled_for": None, "transactions": {**tx, "payment_status": "unpaid"}},
            {"id": "cooking", "scheduled_for": None, "transactions": {**tx, "kitchen_status": "preparing"}},
            {"id": "today", "scheduled_for": None, "transactions": {**tx, "opened_at": NOW.isoformat()}},
        ])
        self.assertEqual(orders, ["cash-out", "cooking", "today"])

    def test_pos_list_is_narrowed_by_the_database(self):
        (_, transactions), db = self._pending_ids(pos=[{"id": "t1"}])
        self.assertEqual(transactions, ["t1"])
        active = db.table.return_value.or_.call_args.args[0]
        self.assertIn("kitchen_status.neq.completed", active)
        self.assertIn("payment_status.eq.unpaid", active)


class ShiftReportTests(unittest.TestCase):
    """₱160 order with a ₱50 delivery fee, ₱1,000 starting cash."""

    def _drawer(self, method):
        from tests.test_shift_reports import DB
        from app.routers.shift_reports import build_shift_report
        sale = {"id": "t1", "opened_at": "2026-11-02T02:00:00+00:00", "paid_at": "2026-11-02T03:00:00+00:00",
                "total_amount": 160, "discount_amount": 0, "tax_amount": 0, "payment_method": "gcash" if method != "cash" else "cash",
                "card_type": None, "payment_status": "paid"}
        db = DB(business_settings=[{"id": 1, "receipt_business_name": "Oishii Nori"}], transactions=[sale],
                digital_orders=[{"id": "o1", "transaction_id": "t1", "payment_method": method}],
                deliveries=[{"id": "d1", "digital_order_id": "o1", "transaction_id": "t1", "delivery_fee": 50}],
                cash_expenses=[], shift_cash_movements=[])
        shift = {"id": "s1", "shift_number": 1, "business_date": "2026-11-02", "opened_at": "2026-11-02T00:00:00+00:00",
                 "opened_by": "u1", "starting_cash": 1000}
        return build_shift_report(db, shift, datetime(2026, 11, 2, 8, tzinfo=timezone.utc), 1000)["cash_drawer"]

    def test_gcash_at_the_door_leaves_the_order_out_of_the_drawer(self):
        cash, gcash = self._drawer("cash"), self._drawer("GCash")
        self.assertEqual(cash["expected_cash"], 1110)  # rider keeps the ₱50 fee from the ₱160
        self.assertEqual(cash["rider_fees_cash"], 50)
        self.assertEqual(gcash["cash_payments"], 0)
        self.assertEqual(gcash["expected_cash"], 950)  # no cash came in; the drawer pays the rider
        self.assertEqual(gcash["rider_fees_deductible"], 50)


class PosMethodTests(unittest.TestCase):
    def test_names_map_to_the_allowed_values(self):
        self.assertEqual(dm._pos_method("GCash"), "gcash")
        self.assertEqual(dm._pos_method("Maya"), "maya")
        self.assertEqual(dm._pos_method("cash"), "cash")
        self.assertEqual(dm._pos_method("Maribank"), "gcash")


if __name__ == "__main__":
    unittest.main()
