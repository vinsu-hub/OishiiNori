"""Command Center paid-sales regression tests (offline, no production writes)."""

import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.routers import sales_insights, business_days


class Query:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []
        self.start = 0
        self.end = 499

    def select(self, *_): return self
    def order(self, *_): return self
    def gte(self, key, value):
        self.filters.append(lambda row: row[key] >= value)
        return self
    def lt(self, key, value):
        self.filters.append(lambda row: row[key] < value)
        return self
    def lte(self, key, value):
        self.filters.append(lambda row: row[key] <= value)
        return self
    def neq(self, key, value):
        self.filters.append(lambda row: row[key] != value)
        return self
    def eq(self, key, value):
        self.filters.append(lambda row: row[key] == value)
        return self
    def in_(self, key, values):
        self.filters.append(lambda row: row[key] in values)
        return self
    def range(self, start, end):
        self.start, self.end = start, end
        return self
    def execute(self):
        rows = [row for row in self.rows if all(condition(row) for condition in self.filters)]
        return SimpleNamespace(data=rows[self.start:self.end + 1])


class DB:
    def __init__(self, transactions, items, digital_orders=None):
        self.rows = {"transactions": transactions, "transaction_items": items, "digital_orders": digital_orders or []}

    def table(self, name):
        return Query(self.rows[name])


class SalesInsightsTests(unittest.TestCase):
    def client(self, role="executive", extra_pages=None):
        app = FastAPI()
        app.include_router(sales_insights.router)
        user = CurrentUser("test", role, "kitchen", "Test", extra_pages or [])
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app)

    def test_paid_sales_types_sources_categories_and_previous_period(self):
        transactions = [
            {"id": "dine", "opened_at": "2026-10-04T16:30:00+00:00", "total_amount": 90, "order_type": "dine_in", "order_source": "pos", "status": "closed", "payment_status": "paid"},
            {"id": "take", "opened_at": "2026-10-05T10:00:00+00:00", "total_amount": 70, "order_type": "takeout", "order_source": "grab", "status": "closed", "payment_status": "paid"},
            {"id": "legacy", "opened_at": "2026-10-05T11:00:00+00:00", "total_amount": 30, "order_type": None, "order_source": None, "status": "closed", "payment_status": "paid"},
            {"id": "unpaid", "opened_at": "2026-10-05T09:00:00+00:00", "total_amount": 500, "order_type": "delivery", "order_source": "pos", "status": "closed", "payment_status": "unpaid"},
            {"id": "void", "opened_at": "2026-10-05T08:00:00+00:00", "total_amount": 200, "order_type": "delivery", "order_source": "pos", "status": "voided", "payment_status": "paid"},
            {"id": "prior", "opened_at": "2026-10-04T10:00:00+00:00", "total_amount": 100, "order_type": "dine_in", "order_source": "pos", "status": "closed", "payment_status": "paid"},
        ]
        items = [
            {"id": "a", "transaction_id": "dine", "product_size_id": "ramen-regular", "quantity": 1, "unit_price": 100, "product_sizes": {"product_id": "ramen", "size_label": "Regular", "products": {"name": "Ramen", "category": "Ramen"}}},
            {"id": "b", "transaction_id": "take", "product_size_id": "box-small", "quantity": 2, "unit_price": 30, "product_sizes": {"product_id": "box", "size_label": "Small", "products": {"name": "Box", "category": "Packaging"}}},
        ]
        with patch.object(sales_insights, "get_supabase", return_value=DB(transactions, items)):
            response = self.client().get("/dashboard/sales-insights?period=day&anchor=2026-10-05")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual((data["revenue"], data["order_count"], data["previous_revenue"]), (190, 3, 100))
        self.assertEqual(data["revenue_change_pct"], 90)
        self.assertEqual(sum(row["revenue"] for row in data["by_order_type"]), 190)
        self.assertEqual(sum(row["revenue"] for row in data["by_order_source"]), 190)
        self.assertEqual(sum(row["revenue"] for row in data["by_payment_method"]), 190)
        self.assertEqual(sum(row["revenue"] for row in data["by_payment_source"]), 190)
        self.assertEqual(next(row for row in data["by_order_type"] if row["order_type"] == "unspecified")["revenue"], 30)
        self.assertEqual(data["categories"][0]["category"], "Ramen")
        self.assertEqual(data["categories"][0]["item_revenue"], 100)
        self.assertEqual(sum(point["revenue"] for point in data["series"]), 190)
        self.assertEqual(data["peak_hour"], 0)  # 16:30 UTC is 00:30 Manila

    def test_pagination_does_not_drop_orders_after_first_page(self):
        rows = [{"id": str(i), "opened_at": "2026-10-05T00:00:00+00:00", "total_amount": 1,
                 "order_type": "dine_in", "order_source": "pos", "status": "closed", "payment_status": "paid"}
                for i in range(1003)]
        with patch.object(sales_insights, "get_supabase", return_value=DB(rows, [])):
            response = self.client().get("/dashboard/sales-insights?period=day&anchor=2026-10-05")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["revenue"], 1003)
        self.assertEqual(response.json()["order_count"], 1003)

    def test_payment_provider_and_size_breakdown(self):
        methods = [("digital", "gcash", None, "online", 80), ("bdo", "bdo", None, "pos", 50),
                   ("maya", "maya", None, "pos", 60), ("debit", "card", "debit", "pos", 70),
                   ("credit", "card", "credit", "pos", 90), ("card", "card", None, "pos", 20)]
        rows = [{"id": key, "opened_at": "2026-10-05T00:00:00+00:00", "total_amount": amount,
                 "order_type": "takeout", "order_source": source, "payment_method": method,
                 "card_type": card_type, "status": "closed", "payment_status": "paid"}
                for key, method, card_type, source, amount in methods]
        items = [{"id": key, "transaction_id": key, "product_size_id": size_id,
                  "quantity": 1, "unit_price": price, "product_sizes": {"product_id": "ramen", "size_label": label,
                  "products": {"name": "Ramen", "category": "Ramen"}}}
                 for key, size_id, label, price in [("bdo", "small", "Small", 50), ("maya", "large", "Large", 60)]]
        db = DB(rows, items, [{"transaction_id": "digital", "payment_method": "Maya"}])
        with patch.object(sales_insights, "get_supabase", return_value=db):
            response = self.client().get("/dashboard/sales-insights?period=day&anchor=2026-10-05")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        amounts = {r["payment_method"]: r["revenue"] for r in data["by_payment_method"]}
        self.assertEqual(amounts, {"maya": 140, "bdo": 50, "debit": 70, "credit": 90, "unspecified_card": 20})
        self.assertEqual(sum(amounts.values()), data["revenue"])
        self.assertEqual(len(data["categories"][0]["items"]), 2)
        self.assertEqual(data["categories"][0]["item_revenue"], 110)

    def test_business_day_includes_unpaid_and_paginates_sizes(self):
        transactions = [{"id": str(i), "opened_at": "2026-10-05T00:00:00+00:00",
                         "status": "voided" if i == 1002 else "closed",
                         "payment_status": "unpaid" if i == 1001 else "paid"}
                        for i in range(1003)]
        items = [{"id": str(i), "transaction_id": str(i), "product_size_id": "large" if i == 1001 else "small",
                  "quantity": 1, "unit_price": 20 if i == 1001 else 10,
                  "product_sizes": {"product_id": "ramen", "size_label": "Large" if i == 1001 else "Small",
                  "products": {"name": "Ramen", "category": "Ramen"}}} for i in range(1003)]
        app = FastAPI()
        app.include_router(business_days.router)
        app.dependency_overrides[get_current_user] = lambda: CurrentUser("test", "executive", "kitchen", "Test", [])
        with patch.object(business_days, "get_supabase", return_value=DB(transactions, items)):
            response = TestClient(app).get("/business-days/2026-10-05/items")
        self.assertEqual(response.status_code, 200, response.text)
        by_size = {row["size_label"]: row for row in response.json()["items"]}
        self.assertEqual(by_size["Small"]["quantity_sold"], 1001)
        self.assertEqual(by_size["Small"]["revenue"], 10010)
        self.assertEqual(by_size["Large"]["quantity_sold"], 1)
        self.assertEqual(by_size["Large"]["revenue"], 20)

    def test_calendar_periods_and_future_anchor(self):
        self.assertEqual(sales_insights._period_dates("week", date(2026, 10, 8)), (date(2026, 10, 5), date(2026, 10, 12)))
        self.assertEqual(sales_insights._period_dates("month", date(2026, 10, 8)), (date(2026, 10, 1), date(2026, 11, 1)))
        response = self.client().get("/dashboard/sales-insights?anchor=2099-01-01")
        self.assertEqual(response.status_code, 400)

    def test_command_center_permission(self):
        response = self.client(role="employee").get("/dashboard/sales-insights?anchor=2026-10-05")
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
