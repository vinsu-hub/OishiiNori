"""Register expense audit and reporting behavior without production writes."""

import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import CurrentUser, get_current_user
from app.routers import cash_expenses


class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters = []
        self.start, self.end = 0, 499

    def select(self, *_): return self
    def order(self, *_ , **__): return self
    def is_(self, key, value):
        self.filters.append(lambda row: row.get(key) is None if value == "null" else row.get(key) == value)
        return self
    def limit(self, count):
        self.end = count - 1
        return self
    def eq(self, key, value):
        self.filters.append(lambda row: row[key] == value)
        return self
    def gte(self, key, value):
        self.filters.append(lambda row: row[key] >= value)
        return self
    def lt(self, key, value):
        self.filters.append(lambda row: row[key] < value)
        return self
    def range(self, start, end):
        self.start, self.end = start, end
        return self
    def maybe_single(self): return self
    def insert(self, row):
        self.db.inserted = row
        return self
    def execute(self):
        if self.db.inserted is not None and self.table == "cash_expenses":
            return SimpleNamespace(data=[{"id": "new", "created_at": "2026-10-09T00:00:00Z", **self.db.inserted}])
        rows = [row for row in self.db.rows[self.table] if all(f(row) for f in self.filters)]
        return SimpleNamespace(data=rows[self.start:self.end + 1])


class DB:
    def __init__(self, expenses):
        self.rows = {"business_days": [{"id": "shift-1", "business_date": "2026-10-09", "opened_at": "2026-10-09T00:00:00Z", "closed_at": None, "closing_at": None}],
                     "cash_expenses": expenses}
        self.inserted = None

    def table(self, name): return Query(self, name)


class CashExpenseTests(unittest.TestCase):
    def client(self, role="executive"):
        app = FastAPI()
        app.include_router(cash_expenses.router)
        app.dependency_overrides[get_current_user] = lambda: CurrentUser("cashier-id", role, None, "Cashier Ana", [])
        return TestClient(app)

    def test_cashier_submission_uses_authenticated_actor(self):
        db = DB([])
        with patch.object(cash_expenses, "get_supabase", return_value=db), patch.object(cash_expenses, "today_ph", return_value=date(2026, 10, 9)):
            response = self.client("employee").post("/cash-expenses", json={
                "description": " Ice ", "amount": 75, "recorded_by": "someone-else"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(db.inserted["recorded_by"], "cashier-id")
        self.assertEqual(db.inserted["description"], "Ice")
        self.assertEqual(db.inserted["business_day_id"], "shift-1")
        self.assertEqual(response.json()["recorded_by_name"], "Cashier Ana")

    def test_report_keeps_staff_names_and_all_pages(self):
        rows = [{"id": str(i), "description": "Ice", "amount": 10, "business_date": "2026-10-09",
                 "recorded_by": "cashier-id", "created_at": "2026-10-09T00:00:00Z",
                 "profiles": {"full_name": "Cashier Ana"}} for i in range(1002)]
        db = DB(rows)
        with patch.object(cash_expenses, "get_supabase", return_value=db):
            response = self.client().get("/cash-expenses/report?date_from=2026-10-09&date_before=2026-10-10")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()), 1002)
        self.assertEqual(sum(row["amount"] for row in response.json()), 10020)
        self.assertTrue(all(row["recorded_by_name"] == "Cashier Ana" for row in response.json()))

    def test_cashier_can_log_and_review_today_but_cannot_open_management_report(self):
        db = DB([])
        with patch.object(cash_expenses, "get_supabase", return_value=db):
            client = self.client("employee")
            self.assertEqual(client.get("/cash-expenses?business_date=2026-10-09").status_code, 200)
            self.assertEqual(client.get("/cash-expenses/report?date_from=2026-10-09&date_before=2026-10-10").status_code, 403)


if __name__ == "__main__":
    unittest.main()
