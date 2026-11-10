"""Sushi Boat deposits on POS sales (2026-11-11): staff used to ring
"Deposit boat" as a menu item; takeout/delivery boats now get ledger rows."""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from app.routers import transactions
from app.routers.shift_reports import _boat_deposit_cash
from app.routers.transactions import _boat_deposit_sizes, _record_pos_boat_deposits
from app.schemas import CreateTransactionRequest
from tests.test_shift_reports import DB

MEDIUM = {"id": "medium", "deposit_amount": 1000}
RAMEN = {"id": "ramen", "deposit_amount": 0}


def _sizes_db(rows):
    db = MagicMock()
    q = db.table.return_value
    q.select.return_value = q
    q.in_.return_value = q
    q.execute.return_value = MagicMock(data=rows)
    return db


def _body(order_type="takeout", qty=2, **extra):
    return CreateTransactionRequest(
        employee_id="cashier", order_type=order_type, payment_method="cash",
        table_number=4 if order_type == "dine_in" else None,
        items=[{"product_size_id": "medium", "quantity": qty}, {"product_size_id": "ramen", "quantity": 1}],
        **extra,
    )


def _sale():
    return SimpleNamespace(id="tx1", items=[
        SimpleNamespace(id="item-boat", product_size_id="medium", quantity=2),
        SimpleNamespace(id="item-ramen", product_size_id="ramen", quantity=1),
    ])


class DepositSizeTests(unittest.TestCase):
    def test_takeout_boat_has_deposit(self):
        self.assertEqual(_boat_deposit_sizes(_sizes_db([MEDIUM, RAMEN]), _body()), {"medium": 1000.0})

    def test_dine_in_has_no_deposit(self):
        db = MagicMock()
        self.assertEqual(_boat_deposit_sizes(db, _body("dine_in")), {})
        db.table.assert_not_called()

    def test_grab_order_has_no_deposit(self):
        db = MagicMock()
        body = _body(order_source="grab")
        self.assertEqual(_boat_deposit_sizes(db, body), {})
        db.table.assert_not_called()

    def test_fractional_boat_refused(self):
        with self.assertRaises(HTTPException) as caught:
            _boat_deposit_sizes(_sizes_db([MEDIUM, RAMEN]), _body(qty=1.5))
        self.assertEqual(caught.exception.status_code, 400)


class RecordDepositTests(unittest.TestCase):
    def _rows(self, collected):
        db = MagicMock()
        _record_pos_boat_deposits(db, _sale(), {"medium": 1000.0}, collected=collected, cashier_id="cashier")
        return db.table.return_value.insert.call_args.args[0]

    def test_one_row_per_boat_collected_at_charge(self):
        rows = self._rows(collected=True)
        self.assertEqual([r["unit_number"] for r in rows], [1, 2])
        self.assertTrue(all(r["amount"] == 1000.0 and r["transaction_item_id"] == "item-boat" for r in rows))
        self.assertTrue(all(r["collected_by"] == "cashier" and r["collected_at"] for r in rows))

    def test_pay_on_delivery_left_uncollected(self):
        self.assertTrue(all("collected_at" not in r for r in self._rows(collected=False)))

    def test_create_transaction_records_deposits(self):
        sale = _sale()
        with patch.object(transactions, "get_supabase", return_value=MagicMock()), \
             patch.object(transactions, "check_idempotency_key", return_value=None), \
             patch.object(transactions, "_find_possible_duplicate", return_value=None), \
             patch.object(transactions, "_business_days_supported_check", return_value=False), \
             patch.object(transactions, "_boat_deposit_sizes", return_value={"medium": 1000.0}), \
             patch.object(transactions, "_create_transaction_row", return_value=sale), \
             patch.object(transactions, "record_idempotency_key"), \
             patch.object(transactions, "_record_pos_boat_deposits") as record:
            transactions.create_transaction(_body(pay_on_delivery=False), SimpleNamespace(id="cashier", role="employee"))
        self.assertTrue(record.call_args.kwargs["collected"])


class VoidDepositTests(unittest.TestCase):
    def test_void_drops_only_boats_still_in_store(self):
        db = MagicMock()
        q = db.table.return_value
        for name in ("update", "eq", "neq", "delete", "is_"):
            getattr(q, name).return_value = q
        q.execute.return_value = MagicMock(data=[{"id": "tx1", "status": "voided"}])
        with patch.object(transactions, "_restore_items_stock"), \
             patch.object(transactions, "_bundle_fulfilled_item_ids", return_value=set()):
            transactions.void_transaction_core(db, {"id": "tx1", "items": []}, "u1", "x")
        q.delete.assert_called_once()
        q.is_.assert_called_with("handoff_at", "null")


class DrawerTests(unittest.TestCase):
    START, END = "2026-11-11T00:00:00+00:00", "2026-11-11T12:00:00+00:00"

    def test_cash_deposits_in_and_out(self):
        db = DB(
            sushi_boat_deposits=[
                {"id": "d1", "amount": 1000, "transaction_id": "cash-tx", "collected_at": "2026-11-11T02:00:00+00:00"},
                {"id": "d2", "amount": 2500, "transaction_id": "gcash-tx", "collected_at": "2026-11-11T03:00:00+00:00"},
                {"id": "d3", "amount": 1000, "digital_order_id": "online-cash", "collected_at": "2026-11-11T04:00:00+00:00"},
                {"id": "d4", "amount": 1000, "refund_amount": 800, "refund_method": "Cash",
                 "returned_at": "2026-11-11T05:00:00+00:00"},
                {"id": "d5", "amount": 1000, "refund_amount": 1000, "refund_method": "GCash",
                 "returned_at": "2026-11-11T06:00:00+00:00"},
            ],
            transactions=[{"id": "cash-tx", "payment_method": "cash"}, {"id": "gcash-tx", "payment_method": "gcash"}],
            digital_orders=[{"id": "online-cash", "payment_method": "Cash"}],
        )
        cash_in, cash_out = _boat_deposit_cash(db, self.START, self.END)
        self.assertEqual(float(cash_in), 2000.0)
        self.assertEqual(float(cash_out), 800.0)


if __name__ == "__main__":
    unittest.main()
