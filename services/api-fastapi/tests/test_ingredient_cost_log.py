"""Ingredient price history (migration 0085) and the Food cost recipe lines."""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import auth, cost_log
from app.main import app


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, db, table):
        self.db, self.table, self.op, self.payload = db, table, "select", None

    def select(self, *_a, **_k):
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def __getattr__(self, _name):  # eq / in_ / order / limit / maybe_single ...
        return lambda *a, **k: self

    def execute(self):
        self.db.calls.append((self.table, self.op, self.payload))
        if self.table == "ingredient_cost_log" and self.db.no_log_table:
            raise RuntimeError("relation ingredient_cost_log does not exist")
        if self.op == "update":
            return _Result([{**self.db.rows.get(self.table, {}), **self.payload}])
        if self.op == "insert":
            return _Result([self.payload])
        return _Result(self.db.rows.get(self.table))


class FakeDB:
    def __init__(self, rows, no_log_table=False):
        self.rows, self.no_log_table, self.calls = rows, no_log_table, []

    def table(self, name):
        return _Query(self, name)

    def rpc(self, *_a, **_k):
        return _Query(self, "rpc")

    def inserts(self, table):
        return [p for t, op, p in self.calls if t == table and op == "insert"]


INGREDIENT = {
    "id": "ing1", "name": "Cream cheese", "category": "Dairy", "base_unit": "g", "unit_cost": 0.5375,
    "current_stock": 0, "reorder_threshold": 0, "needs_review": False,
}


def _owner():
    return auth.CurrentUser(id="u1", role="executive", department=None, full_name="Owner", extra_pages=[])


class CostLogTests(unittest.TestCase):
    def setUp(self):
        cost_log._supported, cost_log._checked_at = None, 0.0
        app.dependency_overrides[auth.get_current_user] = _owner
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app)

    def _patch(self, db, module):
        p = patch(f"app.routers.{module}.get_supabase", return_value=db)
        p.start()
        self.addCleanup(p.stop)

    def test_manual_save_logs_what_was_paid(self):
        db = FakeDB({"ingredients": INGREDIENT, "ingredient_cost_log": []})
        self._patch(db, "inventory")
        r = self.client.patch("/inventory/ing1", json={
            "unit_cost": 0.525, "price_paid": 1050, "purchase_qty": 2, "purchase_unit": "kg", "purchase_base_qty": 1000,
        })
        self.assertEqual(r.status_code, 200, r.text)
        update = [p for t, op, p in db.calls if t == "ingredients" and op == "update"][0]
        self.assertNotIn("price_paid", update)  # purchase details are not ingredient columns
        self.assertEqual(update["unit_cost"], 0.525)
        (row,) = db.inserts("ingredient_cost_log")
        self.assertEqual((row["unit_cost"], row["previous_unit_cost"], row["price_paid"]), (0.525, 0.5375, 1050.0))
        self.assertEqual((row["qty"], row["unit_name"], row["base_qty"], row["source"]), (2.0, "kg", 1000.0, "manual"))
        self.assertEqual(row["changed_by"], "u1")

    def test_save_still_works_before_0085(self):
        db = FakeDB({"ingredients": INGREDIENT}, no_log_table=True)
        self._patch(db, "inventory")
        r = self.client.patch("/inventory/ing1", json={"unit_cost": 0.6})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(db.inserts("ingredient_cost_log"), [])

    def test_editing_other_fields_does_not_log(self):
        db = FakeDB({"ingredients": INGREDIENT, "ingredient_cost_log": []})
        self._patch(db, "inventory")
        self.client.patch("/inventory/ing1", json={"category": "Dairy"})
        self.assertEqual(db.inserts("ingredient_cost_log"), [])

    def test_negative_cost_is_refused(self):
        db = FakeDB({"ingredients": INGREDIENT, "ingredient_cost_log": []})
        self._patch(db, "inventory")
        self.assertEqual(self.client.patch("/inventory/ing1", json={"unit_cost": -1}).status_code, 422)

    def test_delivery_with_a_price_logs_it(self):
        from app.routers.inventory_movements import apply_inventory_movement
        db = FakeDB({"ingredients": INGREDIENT, "ingredient_cost_log": []})
        apply_inventory_movement(db, "ing1", "delivery", 2000, "u1", unit_cost_snapshot=0.55, reason="Supplier A")
        (row,) = db.inserts("ingredient_cost_log")
        self.assertEqual((row["unit_cost"], row["previous_unit_cost"], row["source"]), (0.55, 0.5375, "delivery"))
        self.assertEqual((row["price_paid"], row["qty"]), (1100.0, 2000.0))


class CoverageLinesTests(unittest.TestCase):
    def test_sizes_carry_their_recipe_lines(self):
        from app.routers import recipes
        cost_log._supported, cost_log._checked_at = None, 0.0
        app.dependency_overrides[auth.get_current_user] = _owner
        self.addCleanup(app.dependency_overrides.clear)
        pages = {
            "products": [{"id": "p1", "name": "Maki", "category": "Maki", "is_bundle": False}],
            "product_sizes": [{"id": "s1", "product_id": "p1", "size_label": "8 pcs", "price": 300, "sort_order": 0}],
            "recipe_items": [{"product_size_id": "s1", "ingredient_id": "ing1", "qty_per_serving": 40}],
            "stock_consumption_rules": [],
            "ingredients": [INGREDIENT],
        }
        latest = {"ing1": {"unit_cost": 0.5375, "price_paid": 1075, "qty": 1, "unit_name": "box", "base_qty": 2000,
                           "source": "import", "created_at": "2026-11-15T10:00:00+00:00"}}

        def page_rows(query):
            return pages[query._table]

        class Q:
            def __init__(self, t): self._table = t
            def execute(self): return _Result(pages[self._table])
            def __getattr__(self, _n): return lambda *a, **k: self

        class DB:
            def table(self, t): return Q(t)

        with patch.object(recipes, "get_supabase", return_value=DB()), \
                patch.object(recipes, "_page_rows", side_effect=page_rows), \
                patch.object(recipes, "latest_purchases", return_value=latest):
            r = TestClient(app).get("/recipes/coverage")
        self.assertEqual(r.status_code, 200, r.text)
        size = r.json()["products"][0]["sizes"][0]
        self.assertEqual(size["lines"], [{"ingredient_id": "ing1", "qty_per_serving": 40.0}])
        self.assertAlmostEqual(size["cost"], 21.5)
        ing = r.json()["ingredients"][0]
        self.assertEqual(ing["last_purchase"]["unit_name"], "box")


if __name__ == "__main__":
    unittest.main()
