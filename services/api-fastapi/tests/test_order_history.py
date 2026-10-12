"""Placed-date history: PH time blocks, digital de-duplication, and money."""

import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.routers.order_history import _period, list_order_history


class Query:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []
        self.sort_keys = []
        self.start = 0
        self.end = 499

    def select(self, *_): return self
    def in_(self, field, values):
        self.filters.append(lambda row: row.get(field) in values)
        return self
    def gte(self, field, value):
        self.filters.append(lambda row: row.get(field, '') >= value)
        return self
    def lte(self, field, value):
        self.filters.append(lambda row: row.get(field, '') <= value)
        return self
    def order(self, field, **_):
        self.sort_keys.append(field)
        return self
    def range(self, start, end):
        self.start, self.end = start, end
        return self
    def execute(self):
        rows = [row.copy() for row in self.rows if all(check(row) for check in self.filters)]
        for field in reversed(self.sort_keys):
            rows.sort(key=lambda row: row.get(field) or '')
        return SimpleNamespace(data=rows[self.start:self.end + 1])


class DB:
    def __init__(self, **tables): self.tables = tables
    def table(self, name): return Query(self.tables.get(name, []))


def tx(key, opened, amount, **other):
    return {"id": key, "opened_at": opened, "total_amount": amount, "status": "open",
            "payment_status": "paid", "order_source": "pos", "order_type": "takeout",
            "discount_amount": 0, "discount_type_id": None, "employee_id": "cashier", **other}


def digital(key, created, linked=None, **other):
    return {"id": key, "created_at": created, "transaction_id": linked,
            "order_number": 100, "order_channel": "pickup", "status": "approved" if linked else "pending",
            "payment_method": "Maya", "subtotal": 150, "scheduled_for": None, **other}


class HistoryTests(unittest.TestCase):
    def test_time_columns_use_manila_hours(self):
        self.assertEqual(_period("2026-10-11T22:00:00Z"), "morning")  # 06:00 PH
        self.assertEqual(_period("2026-10-12T04:00:00Z"), "afternoon")  # 12:00 PH
        self.assertEqual(_period("2026-10-12T10:00:00Z"), "evening")  # 18:00 PH
        self.assertEqual(_period("2026-10-11T18:00:00Z"), "evening")  # 02:00 PH

    def test_only_cashier_and_management_may_read_history(self):
        with self.assertRaises(HTTPException) as denied:
            list_order_history(date(2026, 10, 12), SimpleNamespace(role="kitchen"))
        self.assertEqual(denied.exception.status_code, 403)

    def test_includes_all_placed_orders_once_even_when_transaction_fires_another_day(self):
        db = DB(
            transactions=[
                tx("pos", "2026-10-12T02:00:00+00:00", 180, discount_amount=20,
                   discount_type_id="senior", order_number=10),
                tx("old-tx", "2026-10-12T03:00:00+00:00", 150),
                tx("same-tx", "2026-10-12T05:00:00+00:00", 150, order_source="online"),
                tx("late-tx", "2026-10-13T02:00:00+00:00", 150, order_source="online"),
            ],
            digital_orders=[
                digital("old-order", "2026-10-11T10:00:00+00:00", "old-tx"),
                digital("same-order", "2026-10-12T04:00:00+00:00", "same-tx"),
                digital("late-order", "2026-10-12T06:00:00+00:00", "late-tx",
                        scheduled_for="2026-10-13T02:00:00+00:00"),
                digital("pending-order", "2026-10-12T11:00:00+00:00"),
            ],
            transaction_items=[
                {"id": "item-pos", "transaction_id": "pos", "product_size_id": "size",
                 "quantity": 2, "unit_price": 100, "held_ingredients": [],
                 "discount_amount": 20, "discount_name": "Senior", "discount_percentage": 20},
            ],
            digital_order_items=[
                {"id": f"item-{key}", "digital_order_id": key, "product_size_id": "size",
                 "quantity": 1, "unit_price": 150, "held_ingredients": []}
                for key in ("same-order", "late-order", "pending-order")
            ],
            product_sizes=[{"id": "size", "size_label": "Regular", "products": {"name": "Sushi"}}],
            discount_types=[{"id": "senior", "name": "Senior", "percentage": 20}],
            profiles=[{"id": "cashier", "full_name": "Cashier"}],
        )
        with patch("app.routers.order_history.get_supabase", return_value=db), \
             patch("app.routers.order_history._item_discounts_supported_check", return_value=True), \
             patch("app.routers.order_history._transaction_item_addons_supported_check", return_value=False):
            rows = list_order_history(date(2026, 10, 12), SimpleNamespace(role="employee"))
        by_id = {row["id"]: row for row in rows}
        self.assertEqual(set(by_id), {"pos", "same-order", "late-order", "pending-order"})
        self.assertEqual(by_id["pos"]["discount"]["scope"], "one_unit")
        self.assertEqual(by_id["pos"]["recorded_paid"], 180)
        self.assertEqual(by_id["late-order"]["transaction_id"], "late-tx")
        self.assertEqual(by_id["late-order"]["labels"], ["Advance", "Online", "Takeout"])
        self.assertEqual(by_id["pending-order"]["recorded_paid"], 0)
        self.assertEqual(by_id["pending-order"]["outstanding"], 150)


if __name__ == "__main__":
    unittest.main()
