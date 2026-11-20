"""Edit button: rename, manager limits, and change-unit (migration 0088)."""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import auth, cost_log, stock_alerts
from app.main import app
from tests.test_prep_bases import FakeDB, _Query, ing


class UnitDB(FakeDB):
    def rpc(self, name, params):
        self.rpcs.append((name, params))
        return _Query(self, "rpc")


def _user(role):
    return lambda: auth.CurrentUser(id="u1", role=role, department=None, full_name=role, extra_pages=[])


class ItemEditTests(unittest.TestCase):
    def setUp(self):
        stock_alerts._supported, stock_alerts._checked_at = True, 0.0
        cost_log._supported, cost_log._checked_at = True, 0.0
        self.addCleanup(app.dependency_overrides.clear)
        self.addCleanup(setattr, stock_alerts, "_supported", None)
        self.addCleanup(setattr, cost_log, "_supported", None)
        self.db = UnitDB({
            "ingredients": [ing("rice", "J rice cooked", "pcs", 5, stock=40), ing("egg", "Egg", "pcs", 9)],
            "prep_recipe_items": [],
            "stock_items": [{"id": "s1", "name": "Spoon", "station": "ramen_hot_line", "unit": "g", "ingredient_id": None,
                             "current_stock": 0, "reorder_threshold": None, "active": True, "needs_review": False,
                             "created_at": "2026-11-20T00:00:00Z", "updated_at": "2026-11-20T00:00:00Z"}],
        })
        for target in ("app.routers.inventory.get_supabase", "app.routers.prep_bases.get_supabase", "app.routers.stock_items.get_supabase"):
            p = patch(target, return_value=self.db)
            p.start()
            self.addCleanup(p.stop)
        self.client = TestClient(app)

    def as_(self, role):
        app.dependency_overrides[auth.get_current_user] = _user(role)

    def test_manager_can_rename(self):
        self.as_("manager")
        r = self.client.patch("/inventory/rice", json={"name": "  Japanese  rice cooked "})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.db.rows["ingredients"][0]["name"], "Japanese rice cooked")

    def test_rename_clash_is_a_friendly_409(self):
        self.as_("manager")
        r = self.client.patch("/inventory/rice", json={"name": "egg"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("already called", r.json()["detail"])

    def test_manager_cannot_change_cost_or_bare_unit(self):
        self.as_("manager")
        r = self.client.patch("/inventory/rice", json={"unit_cost": 1})
        self.assertEqual(r.status_code, 403)
        r = self.client.patch("/inventory/rice", json={"base_unit": "g"})
        self.assertEqual(r.status_code, 403)

    def test_staff_cannot_edit(self):
        self.as_("employee")
        self.assertEqual(self.client.patch("/inventory/rice", json={"name": "x"}).status_code, 403)
        self.assertEqual(self.client.post("/inventory/rice/change-unit", json={"new_unit": "g", "factor": 120}).status_code, 403)

    def test_change_unit_calls_the_converting_function(self):
        self.as_("manager")
        r = self.client.post("/inventory/rice/change-unit", json={"new_unit": "g", "factor": 120})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(
            self.db.rpcs[0],
            ("change_item_base_unit", {"p_kind": "ingredient", "p_id": "rice", "p_new_unit": "g", "p_factor": 120.0, "p_keep_old_as_size": True}),
        )

    def test_change_unit_needs_a_positive_factor(self):
        self.as_("executive")
        self.assertEqual(self.client.post("/inventory/rice/change-unit", json={"new_unit": "g", "factor": 0}).status_code, 422)

    def test_station_item_change_unit(self):
        self.as_("manager")
        r = self.client.post("/stock-items/s1/change-unit", json={"new_unit": "pcs", "factor": 0.5})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.db.rpcs[0][1]["p_kind"], "stock_item")


if __name__ == "__main__":
    unittest.main()
