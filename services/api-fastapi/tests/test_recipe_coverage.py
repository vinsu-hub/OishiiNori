"""Stock -> Recipes & Costs coverage, and the sheet order of Station Items (0079)
and of ingredients on EOD Stock Count (0080)."""

import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import inventory, recipes, stock_items


def _chain(data):
    q = MagicMock()
    for name in ("select", "eq", "in_", "order", "range", "limit"):
        getattr(q, name).return_value = q
    q.execute.return_value = MagicMock(data=data)
    return q


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(app.dependency_overrides.clear)

    def _as(self, role):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id="u1", role=role, department=None, full_name="Joe", extra_pages=[])

    def _get(self):
        tables = {
            "products": _chain([
                {"id": "p1", "name": "California Maki", "category": "Maki", "is_bundle": False},
                {"id": "p2", "name": "Coke", "category": "Drinks", "is_bundle": False},
            ]),
            "product_sizes": _chain([
                {"id": "s1", "product_id": "p1", "size_label": "8 pcs", "price": 200, "sort_order": 0},
                {"id": "s2", "product_id": "p1", "size_label": "4 pcs", "price": 110, "sort_order": 1},
                {"id": "s3", "product_id": "p2", "size_label": "Regular", "price": 60, "sort_order": 0},
            ]),
            "recipe_items": _chain([
                {"product_size_id": "s1", "ingredient_id": "rice", "qty_per_serving": 100},
                {"product_size_id": "s1", "ingredient_id": "kani", "qty_per_serving": 2},
            ]),
            "stock_consumption_rules": _chain([{"product_size_id": "s3"}]),
            "ingredients": _chain([
                {"id": "kani", "name": "Crab stick", "category": "Protein", "base_unit": "pcs", "unit_cost": None},
                {"id": "rice", "name": "Sushi rice", "category": "Rice", "base_unit": "g", "unit_cost": 0.06},
                {"id": "nori", "name": "Nori", "category": "Rice", "base_unit": "sheet", "unit_cost": None},
            ]),
        }
        db = MagicMock()
        db.table.side_effect = lambda name: tables[name]
        with patch.object(recipes, "get_supabase", return_value=db):
            return TestClient(app).get("/recipes/coverage")

    def test_cashiers_cannot_see_it(self):
        self._as("employee")
        self.assertEqual(self._get().status_code, 403)

    def test_costs_and_gaps(self):
        self._as("manager")
        body = self._get().json()
        sizes = {s["id"]: s for p in body["products"] for s in p["sizes"]}
        self.assertEqual((sizes["s1"]["cost"], sizes["s1"]["missing_cost"]), (6.0, ["Crab stick"]))
        self.assertEqual((sizes["s2"]["recipe_lines"], sizes["s2"]["cost"]), (0, None))
        self.assertEqual(sizes["s3"]["consumption_rules"], 1)
        used = {i["name"]: i["used_in"] for i in body["ingredients"]}
        self.assertEqual(used, {"Crab stick": 1, "Sushi rice": 1, "Nori": 0})
        self.assertEqual(body["ingredients"][0]["used_in_examples"], ["California Maki (8 pcs)"])


class SheetOrderTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id="u1", role="manager", department=None, full_name="Joe", extra_pages=[])
        self.addCleanup(app.dependency_overrides.clear)

    def test_falls_back_to_name_order_before_migration(self):
        row = {"id": "i1", "name": "Chasu", "station": "ramen_hot_line", "category": "Proteins", "unit": None,
               "ingredient_id": None, "current_stock": 0, "reorder_threshold": None, "active": True,
               "needs_review": False, "created_at": "2026-10-19T00:00:00Z", "updated_at": "2026-10-19T00:00:00Z"}
        calls = []

        def table(_name):
            q = _chain([row])
            def execute():
                calls.append(q.select.call_args[0][0])
                if "sort_order" in calls[-1]:
                    raise APIError({"message": "column stock_items.sort_order does not exist", "code": "42703"})
                return MagicMock(data=[dict(row)])
            q.execute.side_effect = execute
            return q

        db = MagicMock()
        db.table.side_effect = table
        with patch.object(stock_items, "get_supabase", return_value=db):
            response = TestClient(app).get("/stock-items", params={"station": "ramen_hot_line"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[0]["sort_order"], None)
        self.assertEqual(len(calls), 2)

    def _inventory(self, fail_on_sheet_columns):
        row = {"id": "g1", "name": "Angus beef", "category": "Ramen", "base_unit": "g", "current_stock": 10,
               "reorder_threshold": 0, "needs_review": False, "unit_cost": None}
        q = _chain([])

        def execute():
            if fail_on_sheet_columns and "sort_order" in q.select.call_args[0][0]:
                raise APIError({"message": "column ingredients.sort_order does not exist", "code": "42703"})
            extra = {} if fail_on_sheet_columns else {"station": "ramen_hot_line", "sheet_section": "Proteins",
                                                      "sort_order": 21}
            return MagicMock(data=[{**row, **extra}])
        q.execute.side_effect = execute
        db = MagicMock()
        db.table.return_value = q
        with patch.object(inventory, "get_supabase", return_value=db):
            response = TestClient(app).get("/inventory")
        self.assertEqual(response.status_code, 200)
        return q, response.json()[0]

    def test_ingredients_come_in_sheet_order(self):
        q, body = self._inventory(False)
        self.assertEqual(q.order.call_args_list[0].args, ("sort_order",))
        self.assertEqual((body["station"], body["sheet_section"], body["sort_order"]),
                         ("ramen_hot_line", "Proteins", 21))

    def test_ingredients_fall_back_before_migration(self):
        _, body = self._inventory(True)
        self.assertIsNone(body["station"])


if __name__ == "__main__":
    unittest.main()
