"""Standard platter mix, the pending queue clean-up and recipe units (0090)."""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import auth, platter_mix
from app.main import app
from app.routers import menu_admin

from test_prep_bases import FakeDB, _owner

ROLL = "Oishii Maki Rolls"


def _roll(id, name):
    return {"id": id, "name": name, "active": True, "is_bundle": False, "category": ROLL}


class PlatterMixTests(unittest.TestCase):
    def setUp(self):
        platter_mix.clear_cache()
        app.dependency_overrides[auth.get_current_user] = _owner
        self.addCleanup(app.dependency_overrides.clear)
        self.db = FakeDB({
            "products": [_roll("cali", "California Maki"), _roll("crazy", "Crazy Maki"),
                         _roll("dragon", "Dragon Maki"), _roll("tori", "Torikatsu Maki")],
            "bundle_components": [
                {"product_size_id": "small", "total_pieces": 32,
                 "product_sizes": {"size_label": "32 pcs", "products": {"name": "Small Platter", "active": True}}},
                {"product_size_id": "boat", "total_pieces": 32,
                 "product_sizes": {"size_label": "32 pcs", "products": {"name": "Small Sushi Boat", "active": True}}},
            ],
            "bundle_recipe_sources": [{"product_id": p} for p in ("cali", "crazy", "dragon", "tori")],
            "bundle_default_mix": [],
            "bundle_pending_deductions": [],
            "ingredients": [{"id": "crab", "name": "Crab stick", "base_unit": "pcs"},
                            {"id": "moz", "name": "Mozzarella cheese", "base_unit": "g"}],
            "item_units": [{"ingredient_id": "moz", "name": "slice", "base_qty": 20},
                           {"ingredient_id": "crab", "name": "pack", "base_qty": 32}],
        })
        p = patch.object(menu_admin, "get_supabase", return_value=self.db)
        p.start()
        self.addCleanup(p.stop)
        self.client = TestClient(app)

    def _small(self):
        return [{"roll_product_id": r, "pieces": 8} for r in ("cali", "crazy", "dragon", "tori")]

    # -- the mix editor ----------------------------------------------------
    def test_save_mix_must_add_up_to_the_platter(self):
        r = self.client.put("/product-sizes/small/platter-mix", json={"lines": self._small()[:3]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("24 pcs", r.json()["detail"])
        r = self.client.put("/product-sizes/small/platter-mix", json={"lines": self._small()})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sum(line["pieces"] for line in r.json()["lines"]), 32)
        self.assertEqual(len(self.db.rows["bundle_default_mix"]), 4)

    def test_boats_refuse_premium_rolls(self):
        r = self.client.put("/product-sizes/boat/platter-mix", json={"lines": self._small()})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Dragon Maki", r.json()["detail"])
        listed = {m["product_size_id"]: m for m in self.client.get("/platter-mixes").json()}
        self.assertNotIn("Dragon Maki", [x["name"] for x in listed["boat"]["allowed_rolls"]])

    def test_empty_mix_goes_back_to_kitchen_logging(self):
        self.client.put("/product-sizes/small/platter-mix", json={"lines": self._small()})
        r = self.client.put("/product-sizes/small/platter-mix", json={"lines": []})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.db.rows["bundle_default_mix"], [])

    # -- checkout ------------------------------------------------------------
    def test_checkout_takes_the_mix_times_quantity(self):
        self.client.put("/product-sizes/small/platter-mix", json={"lines": self._small()})
        items = [{"id": "i1", "product_size_id": "small", "quantity": 2},
                 {"id": "i2", "product_size_id": "ramen", "quantity": 1},
                 {"id": "i3", "product_size_id": "medium", "quantity": 1}]  # platter, no mix yet
        n = platter_mix.auto_fulfill(self.db, "tx", items, {"small", "medium"}, "cashier")
        self.assertEqual(n, 1)
        ((name, params),) = self.db.rpcs
        self.assertEqual(name, "auto_fulfill_bundle_atomic")
        self.assertEqual(params["p_item_id"], "i1")
        self.assertEqual(sorted(x["quantity"] for x in params["p_lines"]), [16, 16, 16, 16])

    def test_checkout_never_fails_on_a_mix_error(self):
        self.client.put("/product-sizes/small/platter-mix", json={"lines": self._small()})

        def boom(*_a, **_k):
            raise RuntimeError("db down")
        self.db.rpc = boom
        self.assertEqual(platter_mix.auto_fulfill(self.db, "tx", [{"id": "i1", "product_size_id": "small", "quantity": 1}],
                                                  {"small"}, "c"), 0)

    def test_order_edit_only_undoes_unconfirmed_mixes(self):
        self.db.rows["bundle_fulfillment_batches"] = [
            {"transaction_item_id": "auto", "auto_mix": True, "restored_at": None},
            {"transaction_item_id": "kitchen", "auto_mix": False, "restored_at": None},
        ]
        self.assertEqual(platter_mix.auto_item_ids(self.db, ["auto", "kitchen"]), {"auto"})
        platter_mix.undo_auto(self.db, "tx", ["auto"], "u1")
        self.assertEqual([n for n, _ in self.db.rpcs], ["unfulfill_bundle_atomic"])

    def test_kitchen_change_puts_the_old_mix_back(self):
        from app.routers import transactions
        with patch.object(transactions, "get_supabase", return_value=self.db):
            TestClient(app, raise_server_exceptions=False).post("/transactions/tx/items/i1/bundle-fulfillment",
                             json={"lines": [{"maki_roll_product_id": "cali", "quantity": 32}],
                                   "allow_pending_recipe": True, "replace": True})
        self.assertEqual(self.db.rpcs[0][0], "refulfill_bundle_atomic")

    # -- pending queue -------------------------------------------------------
    def test_close_pending_takes_no_stock(self):
        self.db.rows["bundle_pending_deductions"] = [
            {"transaction_item_id": "a", "resolved_at": None}, {"transaction_item_id": "b", "resolved_at": "x"}]
        r = self.client.post("/bundle-deductions/pending/close", json={"transaction_item_ids": ["a", "b"]})
        self.assertEqual(r.json(), {"closed": 1})
        a = self.db.rows["bundle_pending_deductions"][0]
        self.assertTrue(a["closed_without_deduction"])
        self.assertEqual(self.db.rpcs, [])

    def test_only_executives_close_pending(self):
        app.dependency_overrides[auth.get_current_user] = lambda: auth.CurrentUser(
            id="m", role="manager", department=None, full_name="M", extra_pages=[])
        r = self.client.post("/bundle-deductions/pending/close", json={"transaction_item_ids": ["a"]})
        self.assertEqual(r.status_code, 403)

    # -- recipe units --------------------------------------------------------
    def test_recipe_units_are_stored_in_the_stock_unit(self):
        q = menu_admin._recipe_qty_in_base
        self.assertEqual(q(self.db, "crab", 1, "pc"), (1, "pcs"))
        self.assertEqual(q(self.db, "moz", 2, "slice"), (40, "g"))
        self.assertEqual(q(self.db, "crab", 0.5, "Pack"), (16, "pcs"))
        with self.assertRaises(Exception) as ctx:
            q(self.db, "crab", 60, "g")
        self.assertIn("counted in pcs", ctx.exception.detail)


if __name__ == "__main__":
    unittest.main()
