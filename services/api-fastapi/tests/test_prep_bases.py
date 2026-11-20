"""Prep bases (migration 0086) and the low-stock rule."""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import auth, cost_log, prep_chain, stock_alerts
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

    def upsert(self, payload):
        return self.insert(payload)

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

    def or_(self, expr):
        parts = [p.split(".eq.") for p in expr.split(",")]
        self.filters.append(lambda r: any(r.get(c) == v for c, v in parts))
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
            for i, r in enumerate(new):
                r.setdefault("id", f"{self.table}{len(rows) + i}")
                r.setdefault("created_at", f"2026-11-20T10:00:{len(rows) + i:02d}+00:00")
            if self.table == "ingredients":  # column defaults
                for r in new:
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
        if name != "adjust_ingredient_stock":
            return _Query(self, f"rpc:{name}")
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
        prep_chain.clear_cache()
        prep_chain._support.update(at=0.0, ok=None)
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
        for module in ("prep_bases", "inventory", "inventory_movements", "item_overview", "suggestions"):
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

    def test_a_base_can_be_made_from_a_base(self):
        # Rice chain: Japanese Mayo -> Hot Mayo -> Mousse powder (stand-ins).
        self._save_hot_mayo()
        r = self.client.put("/prep-bases/pow", json={"prep_yield": 10, "components": [{"ingredient_id": "mayo", "qty": 5}]})
        self.assertEqual(r.status_code, 200, r.text)
        mayo_cost = self.db.rows["ingredients"][0]["unit_cost"]
        self.assertAlmostEqual(r.json()["cost_per_unit"], round(5 * mayo_cost / 10, 4))
        # A component that is already inside another base can be a base too.
        r = self.client.put("/prep-bases/sri", json={"prep_yield": 10, "components": [{"ingredient_id": "jm", "qty": 5}]})
        self.assertEqual(r.status_code, 200, r.text)

    def test_bases_cannot_loop(self):
        self._save_hot_mayo()
        # Direct: Sriracha is in Hot Mayo, so Hot Mayo can't go into Sriracha.
        r = self.client.put("/prep-bases/sri", json={"prep_yield": 10, "components": [{"ingredient_id": "mayo", "qty": 5}]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("is made from", r.json()["detail"])
        # Two steps: Hot Mayo -> Mousse powder, then Mousse powder can't go into Sriracha.
        self.client.put("/prep-bases/pow", json={"prep_yield": 10, "components": [{"ingredient_id": "mayo", "qty": 5}]})
        r = self.client.put("/prep-bases/sri", json={"prep_yield": 10, "components": [{"ingredient_id": "pow", "qty": 5}]})
        self.assertEqual(r.status_code, 400)
        r = self.client.put("/prep-bases/mayo", json={"prep_yield": 10, "components": [{"ingredient_id": "mayo", "qty": 5}]})
        self.assertEqual(r.status_code, 400)

    def test_cost_change_carries_down_the_chain(self):
        self._save_hot_mayo()
        self.client.put("/prep-bases/pow", json={"prep_yield": 10, "components": [{"ingredient_id": "mayo", "qty": 5}]})
        r = self.client.patch("/inventory/jm", json={"unit_cost": 0.45, "price_paid": 450, "purchase_qty": 1,
                                                     "purchase_unit": "L", "purchase_base_qty": 1000})
        self.assertEqual(r.status_code, 200, r.text)
        costs = {i["id"]: i["unit_cost"] for i in self.db.rows["ingredients"]}
        mayo = round((100 * 0.4223 + 200 * 0.45) / 300, 4)
        self.assertAlmostEqual(costs["mayo"], mayo)
        self.assertAlmostEqual(costs["pow"], round(5 * mayo / 10, 4))

    def test_made_a_batch_is_logged(self):
        self._save_hot_mayo()
        self.client.post("/prep-bases/mayo/make", json={"batches": 2, "note": "lunch"})
        (batch,) = self.db.rows["prep_batches"]
        self.assertEqual((batch["base_ingredient_id"], batch["batches"], batch["yield_qty"], batch["source"], batch["note"]),
                         ("mayo", 2, 600.0, "manual", "lunch"))
        tagged = [m for m in self.db.rows["inventory_movements"] if m.get("batch_id") == batch["id"]]
        self.assertEqual(len(tagged), 3)

    def test_eod_count_records_spotted_batches_first(self):
        self._save_hot_mayo()
        # System says 0 ml Hot Mayo; counted 610: 2 batches (600) were made and not logged.
        r = self.client.post("/inventory/mayo/count", json={"employee_id": "u1", "counted_stock": 610, "batches_made": 2})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertAlmostEqual(r.json()["variance"], 10.0)  # only the true remainder
        stock = {i["id"]: i["current_stock"] for i in self.db.rows["ingredients"]}
        self.assertEqual((stock["sri"], stock["jm"], stock["mayo"]), (688.0, 600.0, 610))
        self.assertEqual(self.db.rows["prep_batches"][0]["source"], "eod")
        count = [m for m in self.db.rows["inventory_movements"] if m["type"] == "count_adjustment"]
        self.assertEqual(count[0]["signed_qty"], 10.0)
        r = self.client.post("/inventory/sri/count", json={"employee_id": "u1", "counted_stock": 5, "batches_made": 1})
        self.assertEqual(r.status_code, 400)  # Sriracha has no batch recipe

    def test_item_overview(self):
        self._save_hot_mayo()
        self.client.put("/prep-bases/pow", json={"prep_yield": 10, "components": [{"ingredient_id": "mayo", "qty": 5}]})
        self.client.post("/prep-bases/mayo/make", json={"batches": 1})
        r = self.client.get("/inventory/mayo/overview")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual([n["name"] for n in body["made_from"]], ["Sriracha", "Japanese Mayo"])
        self.assertEqual([(n["name"], n["qty"]) for n in body["goes_into"]], [("Mousse powder", 5.0)])
        self.assertEqual(body["batches_possible"], 4.0)  # Japanese Mayo 800 left / 200 a batch (Sriracha 788 / 100)
        self.assertEqual(len(body["usage"]), 14)
        self.assertEqual(body["batches"][0]["yield_qty"], 300.0)
        self.assertEqual(body["edits"][0]["field"], "batch recipe")
        r = self.client.get("/inventory/sri/overview")
        self.assertEqual([n["name"] for n in r.json()["goes_into"]], ["Hot Mayo"])
        self.assertEqual([n["name"] for n in r.json()["goes_into"][0]["children"]], ["Mousse powder"])
        self.assertEqual(self.client.get("/inventory/nope/overview").status_code, 404)

    def test_suggestion_accept_and_dismiss(self):
        from app.routers.suggestions import clear_suggestions_cache
        clear_suggestions_cache()
        self._save_hot_mayo()
        self.db.rows["ingredient_counts"] = [
            {"id": f"c{i}", "ingredient_id": "mayo", "variance": 0, "created_at": f"2026-11-1{i}T14:00:00+00:00"} for i in range(3)
        ]
        with patch("app.routers.suggestions.today_ph", return_value=__import__("datetime").date(2026, 11, 20)):
            body = self.client.get("/suggestions").json()
            (s,) = body["suggestions"]
            self.assertEqual((s["kind"], s["ingredient_id"]), ("mode", "mayo"))
            r = self.client.post("/suggestions/accept", json={"key": s["key"]})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self.db.rows["ingredients"][0]["deduct_mode"], "auto")
            self.assertEqual(r.json()["suggestions"], [])
            self.assertEqual(self.client.post("/suggestions/accept", json={"key": s["key"]}).status_code, 404)
            # Dismissed ones stay away.
            self.db.rows["ingredients"][0]["deduct_mode"] = "batch"
            clear_suggestions_cache()
            self.assertEqual(len(self.client.get("/suggestions").json()["suggestions"]), 1)
            self.assertEqual(self.client.post("/suggestions/dismiss", json={"key": s["key"]}).status_code, 204)
            self.db.rows["suggestion_dismissals"][0]["dismissed_at"] = "2099-01-01T00:00:00+00:00"
            self.assertEqual(self.client.get("/suggestions").json()["suggestions"], [])

    def test_mode_switch_and_edit_log(self):
        r = self.client.patch("/prep-bases/mayo/mode", json={"deduct_mode": "auto"})
        self.assertEqual(r.status_code, 400)  # not a base yet
        self._save_hot_mayo()
        r = self.client.patch("/prep-bases/mayo/mode", json={"deduct_mode": "auto"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["deduct_mode"], "auto")
        self.assertEqual(self.client.patch("/prep-bases/mayo/mode", json={"deduct_mode": "x"}).status_code, 422)
        fields = [(e["field"], e["before"], e["after"]) for e in self.db.rows["item_edit_log"]]
        self.assertEqual(fields[0], ("batch recipe", None, {"yield": 300.0, "takes": {"Sriracha": 100.0, "Japanese Mayo": 200.0}}))
        self.assertEqual(fields[1], ("deduct mode", "batch", "auto"))

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


class ChainExpansionTests(unittest.TestCase):
    """Auto bases open up into their components on a sale (app/prep_chain.py)."""

    def setUp(self):
        prep_chain.clear_cache()
        self.db = FakeDB({
            "ingredients": [
                ing("raw", "Japanese rice raw", "g", 0.078, stock=10000.0),
                {**ing("cooked", "Japanese rice cooked", "g", 0.039, stock=0.0, prep_yield=2000), "deduct_mode": "auto"},
                {**ing("sushi", "Japanese sushi rice cooked", "g", 0.04, stock=0.0, prep_yield=4500), "deduct_mode": "auto"},
                ing("vin", "Vinegar", "g", 0.1, stock=1000.0),
                ing("nori", "Nori sheet", "sheet", 2.0, stock=100.0),
                {**ing("kik", "Kikoman mix", "g", 0.2, stock=500.0, prep_yield=500), "deduct_mode": "batch"},
            ],
            "prep_recipe_items": [
                {"base_ingredient_id": "cooked", "ingredient_id": "raw", "qty": 1000},
                {"base_ingredient_id": "sushi", "ingredient_id": "cooked", "qty": 4000},
                {"base_ingredient_id": "sushi", "ingredient_id": "vin", "qty": 350},
                {"base_ingredient_id": "kik", "ingredient_id": "vin", "qty": 400},
            ],
            "inventory_movements": [],
        })

    def test_two_levels_merged(self):
        out = prep_chain.expand(self.db, [("sushi", 220.0), ("nori", 1.0), ("raw", 5.0), ("kik", 10.0)])
        self.assertAlmostEqual(out["raw"], round(220 * 4000 / 4500 * 1000 / 2000 + 5, 4))
        self.assertAlmostEqual(out["vin"], round(220 * 350 / 4500, 4))
        self.assertEqual((out["nori"], out["kik"]), (1.0, 10.0))  # batch-mode base stays
        self.assertNotIn("sushi", out)
        self.assertNotIn("cooked", out)

    def test_sale_and_void_are_symmetric(self):
        from app.routers.transactions import _adjust_ingredients_for_size
        self.db.rows["recipe_items"] = [
            {"product_size_id": "maki", "ingredient_id": "sushi", "qty_per_serving": 220, "ingredients": {"name": "Japanese sushi rice cooked"}},
            {"product_size_id": "maki", "ingredient_id": "nori", "qty_per_serving": 1, "ingredients": {"name": "Nori sheet"}},
        ]
        before = {i["id"]: i["current_stock"] for i in self.db.rows["ingredients"]}
        _adjust_ingredients_for_size(self.db, "maki", 2, sign=-1, employee_id="u1", transaction_id="t1")
        stock = {i["id"]: i["current_stock"] for i in self.db.rows["ingredients"]}
        self.assertAlmostEqual(before["raw"] - stock["raw"], 2 * round(220 * 4000 / 4500 / 2, 4), places=3)
        self.assertEqual(stock["sushi"], before["sushi"])  # the base itself isn't touched
        _adjust_ingredients_for_size(self.db, "maki", 2, sign=1, employee_id="u1", transaction_id="t1")
        after = {i["id"]: i["current_stock"] for i in self.db.rows["ingredients"]}
        for k in before:
            self.assertAlmostEqual(after[k], before[k], places=6)

    def test_held_base_holds_its_components(self):
        from app.routers.transactions import _adjust_ingredients_for_size
        self.db.rows["recipe_items"] = [
            {"product_size_id": "maki", "ingredient_id": "sushi", "qty_per_serving": 220, "ingredients": {"name": "Japanese sushi rice cooked"}},
            {"product_size_id": "maki", "ingredient_id": "nori", "qty_per_serving": 1, "ingredients": {"name": "Nori sheet"}},
        ]
        deltas = _adjust_ingredients_for_size(self.db, "maki", 1, sign=-1, employee_id="u1", transaction_id="t1",
                                              held_ingredient_names=["Japanese sushi rice cooked"])
        self.assertEqual(deltas, {"nori": -1.0})
