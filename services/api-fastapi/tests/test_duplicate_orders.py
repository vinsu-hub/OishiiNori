"""Same order charged twice by one cashier (2026-11-10: #1023/#1024 after a
refresh mid-charge restored the cart)."""

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from app.routers.transactions import _find_possible_duplicate, create_transaction
from app.schemas import CreateTransactionRequest

NOW = datetime.now(timezone.utc).isoformat()
EARLIER = {"id": "t1023", "order_number": 1023, "opened_at": NOW, "table_number": 5}
EARLIER_ITEMS = [
    {"transaction_id": "t1023", "product_size_id": "ramen", "quantity": 1},
    {"transaction_id": "t1023", "product_size_id": "katsu", "quantity": 2},
]


def _db(candidates, items=EARLIER_ITEMS):
    db = MagicMock()
    q = db.table.return_value
    for name in ("select", "eq", "neq", "gte", "in_"):
        getattr(q, name).return_value = q
    q.execute.side_effect = [MagicMock(data=candidates), MagicMock(data=items)]
    return db


def _body(**overrides):
    base = dict(
        employee_id="cashier", order_type="dine_in", table_number=5, payment_method="cash",
        items=[{"product_size_id": "katsu", "quantity": 2}, {"product_size_id": "ramen", "quantity": 1}],
    )
    return CreateTransactionRequest(**{**base, **overrides})


class FindDuplicateTests(unittest.TestCase):
    def test_same_items_same_table_matches(self):
        self.assertEqual(_find_possible_duplicate(_db([EARLIER]), _body())["order_number"], 1023)

    def test_different_items_pass(self):
        body = _body(items=[{"product_size_id": "katsu", "quantity": 1}, {"product_size_id": "ramen", "quantity": 1}])
        self.assertIsNone(_find_possible_duplicate(_db([EARLIER]), body))

    def test_different_table_passes(self):
        self.assertIsNone(_find_possible_duplicate(_db([EARLIER]), _body(table_number=6)))

    def test_no_recent_orders_pass(self):
        # Voided and older orders are filtered out by the query itself.
        db = _db([])
        self.assertIsNone(_find_possible_duplicate(db, _body()))
        db.table.return_value.neq.assert_called_with("status", "voided")

    def test_small_takeout_never_checked(self):
        db = MagicMock()
        body = _body(order_type="takeout", table_number=None, items=[{"product_size_id": "tea", "quantity": 1}])
        self.assertIsNone(_find_possible_duplicate(db, body))
        db.table.assert_not_called()

    def test_big_takeout_matches(self):
        takeout = {**EARLIER, "table_number": None}
        body = _body(order_type="takeout", table_number=None)
        self.assertEqual(_find_possible_duplicate(_db([takeout]), body)["order_number"], 1023)


class CreateTransactionDuplicateTests(unittest.TestCase):
    def _create(self, body):
        with patch("app.routers.transactions.get_supabase", return_value=object()), \
             patch("app.routers.transactions.check_idempotency_key", return_value=None), \
             patch("app.routers.transactions._find_possible_duplicate", return_value=EARLIER) as find:
            try:
                create_transaction(body, SimpleNamespace(id="cashier", role="employee"))
            except HTTPException as e:
                return e, find
            except Exception:
                # Past the duplicate gate -- the rest of the sale isn't mocked here.
                return None, find
        return None, find

    def test_duplicate_is_409_with_order_number(self):
        error, _ = self._create(_body())
        self.assertEqual(error.status_code, 409)
        self.assertEqual(error.detail["code"], "possible_duplicate")
        self.assertEqual(error.detail["order_number"], 1023)

    def test_confirm_duplicate_skips_check(self):
        error, find = self._create(_body(confirm_duplicate=True))
        find.assert_not_called()
        self.assertFalse(error is not None and error.status_code == 409)

    def test_add_on_order_skips_check(self):
        _, find = self._create(_body(related_transaction_id="t1023"))
        find.assert_not_called()


if __name__ == "__main__":
    unittest.main()
