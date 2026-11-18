"""Prep bases (migration 0086) and the low-stock rule."""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import auth, cost_log, stock_alerts
from app.main import app
from app.stock_alerts import is_counted, is_low, is_low_stock_item


class _Result:
    def __init__(self, data):
        self.data = data


class _Not:
    def __init__(self, q):
        self.q = q

    def is_(self, col, _null):
        self.q.filters.append(lambda r: r.get(col) is not None)
        return self.q


class _Query:
    """Tiny in-memory PostgREST: eq / in_ / not_.is_ filters, insert,
    update, delete. Enough for the prep-base routes."""

    def __init__(self, db, table):
        self.db, self.table, self.op, self.payload, self.filters, self.single = db, table, "select", None, [], False

    def select(self, *_a, **_k):
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, col, val):
        self.filters.append(lambda r: r.get(col) == val)
        return self

    def in_(self, col, vals):
        vals = set(vals)
        self.filters.append(lambda r: r.get(col) in vals)
        return self

    def is_(self, col, _null):
        self.filters.append(lambda r: r.get(col) is None)
        return self

    def ilike(self, col, val):
        self.filters.append(lambda r: (r.get(col) or "").lower() == val.lower())
        return self

    def maybe_single(self):
        self.single = True
        return self

    @property
    def not_(self):
        return _Not(self)

    def __getattr__(self, _name):  # order / limit ...
        return lambda *a, **k: self

    def execute(self):
        rows = self.db.rows.setdefault(self.table, [])
        if self.table == "ingredient_cost_log" and self.op == "insert":
            self.db.cost_log.append(self.payload)
            return _Result([self.payload])
        if self.op == "insert":
            new = [dict(r) for r in (self.payload if isinstance(self.payload, list) else [self.payload])]
            if self.table == "ingredients":  # column defaults
                for r in new:
                    r.setdefault("id", f"new{len(rows)}")
                    r.setdefault("current_stock", 0)
                    r.setdefault("needs_review", False)
            rows.extend(new)
            return _Result(new)
        match = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "update":
            for r in match:
                r.update(self.payload)
        elif self.op == "delete":
            self.db.rows[self.table] = [r for r in rows if r not in match]
        if self.single:
            return _Result(match[0] if match else None)
        return _Result(match)


class FakeDB:
    def __init__(self, rows):
        self.rows, self.cost_log, self.rpcs = rows, [], []

    def table(self, name):
        return _Query(self, name)

    def rpc(self, name, params):
        self.rpcs.append((name, params))
        for r in self.rows["ingredients"]:
            if r["id"] == params["p_id"]:
                r["current_stock"] = r["current_stock"] + params["p_delta"]
        return _Query(self, "rpc")


def ing(id, name, unit, cost, stock=0.0, prep_yield=None):
    return {"id": id, "name": name, "category": "Sauce", "base_unit": unit, "unit_cost": cost,
            "current_stock": stock, "prep_yield": prep_yield, "reorder_threshold": 0, "needs_review": False}


def _owner():
    return auth.CurrentUser(id="u1", role="executive", department=None, full_name="Owner", extra_pages=[])


class PrepBaseTests(unittest.TestCase):
    def setUp(self):
        stock_alerts._supported, stock_alerts._checked_at = True, 0.0
        cost_log._supported, cost_log._checked_at = True, 0.0
        app.dependency_overrides[auth.get_current_user] = _owner
        self.addCleanup(app.dependency_overrides.clear)
        self.addCleanup(setattr, stock_alerts, "_supported", None)
        self.addCleanup(setattr, cost_log, "_supported", None)
        self.db = FakeDB({
            "ingredients": [
                ing("mayo", "Hot Mayo", "ml", 0.35, stock=0.0),
                ing("sri", "Sriracha", "ml", 0.4223, stock=888.0),
                ing("jm", "Japanese Mayo", "ml", 0.30, stock=1000.0),
                ing("pow", "Mousse powder", "g", None),
            ],
            "prep_recipe_items": [],
            "inventory_movements": [],
        })
        for module in ("prep_bases", "inventory", "inventory_movements"):
            p = patch(f"app.routers.{module}.get_supabase", return_value=self.db)
            p.start()
            self.addCleanup(p.stop)
        self.client = TestClient(app)

    def _save_hot_mayo(self):
        return self.client.put("/prep-bases/mayo", json={"prep_yield": 300, "components": [
            {"ingredient_id": "sri", "qty": 100, "unit": "g"}, {"ingredient_id": "jm", "qty": 200, "unit": "g"}]})

    def test_batch_recipe_sets_the_cost_per_unit(self):
        r = self._save_hot_mayo()
        self.assertEqual(r.status_code, 200, r.text)
        expected = round((100 * 0.4223 + 200 * 0.30) / 300, 4)
        self.assertAlmostEqual(r.json()["cost_per_unit"], expected)
        self.assertAlmostEqual(self.db.rows["ingredients"][0]["unit_cost"], expected)
        (log,) = self.db.cost_log
        self.assertEqual((log["source"], log["unit_name"], log["base_qty"], log["previous_unit_cost"]), ("batch", "batch", 300.0, 0.35))

    def test_missing_component_cost_keeps_the_old_cost(self):
        r = self.client.put("/prep-bases/mayo", json={"prep_yield": 300, "components": [
            {"ingredient_id": "sri", "qty": 100}, {"ingredient_id": "pow", "qty": 50}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["cost_per_unit"])
        self.assertEqual(r.json()["missing_cost"], ["Mousse powder"])
        self.assertEqual(self.db.rows["ingredients"][0]["unit_cost"], 0.35)
        self.assertEqual(self.db.cost_log, [])

    def test_component_cost_change_recomputes_the_base(self):
        self._save_hot_mayo()
        self.db.cost_log.clear()
        r = self.client.patch("/inventory/jm", json={"unit_cost": 0.45, "price_paid": 450, "purchase_qty": 1,
                                                     "purchase_unit": "L", "purchase_base_qty": 1000})
        self.assertEqual(r.status_code, 200, r.text)
        expected = round((100 * 0.4223 + 200 * 0.45) / 300, 4)
        self.assertAlmostEqual(self.db.rows["ingredients"][0]["unit_cost"], expected)
        self.assertEqual([log["source"] for log in self.db.cost_log], ["manual", "batch"])

    def test_made_a_batch_moves_stock(self):
        self._save_hot_mayo()
        r = self.client.post("/prep-bases/mayo/make", json={"batches": 2})
        self.assertEqual(r.status_code, 200, r.text)
        stock = {i["id"]: i["current_stock"] for i in self.db.rows["ingredients"]}
        self.assertEqual((stock["sri"], stock["jm"], stock["mayo"]), (688.0, 600.0, 600.0))
        types = [(m["ingredient_id"], m["type"], m["quantity"]) for m in self.db.rows["inventory_movements"]]
        self.assertEqual(types, [("sri", "trans_out", 200.0), ("jm", "trans_out", 400.0), ("mayo", "trans_in", 600.0)])

    def test_bases_cannot_nest(self):
        self._save_hot_mayo()
        r = self.client.put("/prep-bases/pow", json={"prep_yield": 10, "components": [{"ingredient_id": "mayo", "qty": 5}]})
        self.assertEqual(r.status_code, 400)
        r = self.client.put("/prep-bases/sri", json={"prep_yield": 10, "components": [{"ingredient_id": "jm", "qty": 5}]})
        self.assertEqual(r.status_code, 400)  # Sriracha is inside Hot Mayo

    def test_before_0086(self):
        stock_alerts._supported, stock_alerts._checked_at = False, 10**12
        self.assertEqual(self.client.get("/prep-bases").json(), [])
        self.assertEqual(self._save_hot_mayo().status_code, 503)


class LowStockRuleTests(unittest.TestCase):
    def test_rule(self):
        counted = "2026-11-18T00:00:00Z"
        self.assertFalse(is_low({"current_stock": 0, "reorder_threshold": 0, "last_counted_at": counted}))
        self.assertFalse(is_low({"current_stock": 0, "reorder_threshold": 50, "last_counted_at": None}))
        self.assertTrue(is_low({"current_stock": 50, "reorder_threshold": 50, "last_counted_at": counted}))
        self.assertFalse(is_low({"current_stock": 51, "reorder_threshold": 50, "last_counted_at": counted}))
        # pre-0086 rows have no last_counted_at: treated as counted
        self.assertTrue(is_counted({"current_stock": 1}))
        self.assertTrue(is_low({"current_stock": 1, "reorder_threshold": 5}))
        self.assertFalse(is_low_stock_item({"current_stock": 0, "reorder_threshold": None}))
        self.assertFalse(is_low_stock_item({"current_stock": 0, "reorder_threshold": 0}))
        self.assertTrue(is_low_stock_item({"current_stock": 2, "reorder_threshold": 5}))

    def test_uncounted_ingredient_does_not_block_the_pos(self):
        from app.routers import products
        stock_alerts._supported = True
        self.addCleanup(setattr, stock_alerts, "_supported", None)
        db = FakeDB({
            "recipe_items": [{"product_size_id": "s1", "ingredient_id": "a", "qty_per_serving": 2},
                             {"product_size_id": "s2", "ingredient_id": "b", "qty_per_serving": 2}],
            "ingredients": [{"id": "a", "current_stock": 0, "reorder_threshold": 0, "last_counted_at": None},
                            {"id": "b", "current_stock": 0, "reorder_threshold": 0, "last_counted_at": "2026-11-18"}],
        })
        out = products._compute_size_availability(db, ["s1", "s2"])
        self.assertEqual(out, {"s1": "available", "s2": "unavailable"})


if __name__ == "__main__":
    unittest.main()
