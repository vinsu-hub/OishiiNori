"""Trend Analysis aggregation regressions, including pagination and digital links."""

import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.auth import CurrentUser
from app.routers import trend_insights


class Query:
    def __init__(self, rows):
        self.rows = rows
        self.predicates = []
        self.start = 0
        self.end = 9999

    def select(self, *_): return self
    def order(self, *_): return self
    def eq(self, key, value):
        self.predicates.append(lambda row: row.get(key) == value)
        return self
    def neq(self, key, value):
        self.predicates.append(lambda row: row.get(key) != value)
        return self
    def gte(self, key, value):
        self.predicates.append(lambda row: row.get(key) >= value)
        return self
    def lt(self, key, value):
        self.predicates.append(lambda row: row.get(key) < value)
        return self
    def in_(self, key, values):
        self.predicates.append(lambda row: row.get(key) in values)
        return self
    def range(self, start, end):
        self.start, self.end = start, end
        return self
    def execute(self):
        rows = [row for row in self.rows if all(predicate(row) for predicate in self.predicates)]
        return SimpleNamespace(data=rows[self.start:self.end + 1])


class DB:
    def __init__(self, rows):
        self.rows = rows

    def table(self, name):
        return Query(self.rows.get(name, []))


class TrendInsightTests(unittest.TestCase):
    def test_invalid_range_and_permission(self):
        executive = CurrentUser("test", "executive", "kitchen", "Test", [])
        with self.assertRaises(HTTPException) as reversed_range:
            trend_insights.trend_insights(date(2026, 10, 6), date(2026, 10, 5), executive)
        self.assertEqual(reversed_range.exception.status_code, 400)
        cashier = CurrentUser("test", "employee", "kitchen", "Test", [])
        with self.assertRaises(HTTPException) as forbidden:
            trend_insights.trend_insights(date(2026, 10, 5), date(2026, 10, 5), cashier)
        self.assertEqual(forbidden.exception.status_code, 403)

    def test_paid_pagination_digital_delivery_pairing_sizes_and_addons(self):
        transactions = [
            {"id": str(i), "opened_at": "2026-10-05T04:00:00+00:00", "total_amount": 100,
             "order_type": "takeout", "order_source": "pos", "status": "closed", "payment_status": "paid",
             "guest_count": None, "discount_type_id": None, "discount_amount": 0}
            for i in range(1002)
        ]
        transactions[0].update(order_source="online")
        transactions[1].update(order_source="qr", order_type=None)
        transactions.extend([
            {**transactions[0], "id": "unpaid", "payment_status": "unpaid"},
            {**transactions[0], "id": "void", "status": "voided"},
            {**transactions[0], "id": "prior", "opened_at": "2026-10-04T04:00:00+00:00"},
        ])
        sizes = [
            ("a4", "maki", "Maki", "4pcs"), ("a8", "maki", "Maki", "8pcs"),
            ("b", "takoyaki", "Takoyaki", "6pcs"),
        ]
        items = [
            {"id": f"item-{i}", "transaction_id": "0", "product_size_id": size_id,
             "quantity": 1, "unit_price": 20,
             "product_sizes": {"product_id": product_id, "size_label": label,
                               "products": {"name": name, "category": name}}}
            for i, (size_id, product_id, name, label) in enumerate(sizes)
        ]
        rows = {
            "transactions": transactions, "transaction_items": items,
            "digital_orders": [{"id": "digital-0", "transaction_id": "0", "order_channel": "delivery"},
                               {"id": "digital-1", "transaction_id": "1", "order_channel": "dine_in_qr"}],
            "deliveries": [{"id": "delivery-0", "transaction_id": None, "digital_order_id": "digital-0", "barangay": "Poblacion I"}],
            "transaction_item_addons": [{"id": "pos-addon", "transaction_item_id": "item-0", "addon_id": "egg",
                                         "quantity": 1, "unit_price": 10, "menu_addons": {"name": "Egg"}}],
            "digital_order_addons": [{"id": "digital-addon", "digital_order_id": "digital-0", "addon_id": "sauce",
                                      "quantity": 1, "unit_price": 5, "menu_addons": {"name": "Sauce"}}],
            "products": [{"id": "maki", "name": "Maki", "category": "Maki", "active": True},
                         {"id": "takoyaki", "name": "Takoyaki", "category": "Takoyaki", "active": True},
                         {"id": "zero", "name": "Zero Seller", "category": "Maki", "active": True}],
        }
        actor = CurrentUser("test", "executive", "kitchen", "Test", [])
        with patch.object(trend_insights, "get_supabase", return_value=DB(rows)):
            data = trend_insights.trend_insights(date(2026, 10, 5), date(2026, 10, 5), actor)
        self.assertEqual(data["kpis"]["order_count"], 1002)
        self.assertEqual(data["kpis"]["previous_order_count"], 1)
        self.assertEqual(data["kpis"]["revenue"], 100200)
        self.assertEqual(sum(row["order_count"] for row in data["sources"]), 1002)
        self.assertEqual(sum(row["order_count"] for row in data["fulfillment"]), 1002)
        self.assertEqual(sum(row["order_count"] for row in data["heatmap"]), 1002)
        self.assertEqual(data["barangays"][0]["barangay"], "Poblacion I")
        self.assertEqual(data["pairings"][0]["order_count"], 1)
        self.assertEqual(data["addon_attach"]["order_count"], 1)
        self.assertEqual(len(data["sizes"]), 3)
        self.assertEqual(data["slowest_products"][0]["name"], "Zero Seller")
        self.assertEqual(sum(row["gross_item_sales"] for row in data["categories"]), data["gross_item_sales"])


if __name__ == "__main__":
    unittest.main()
