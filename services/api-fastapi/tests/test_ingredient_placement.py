"""Ingredient station / section / Verify edits from the dashboard."""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import auth, cost_log, stock_alerts
from app.main import app
from tests.test_prep_bases import FakeDB


def _owner():
    return auth.CurrentUser(id="u1", role="executive", department=None, full_name="Owner", extra_pages=[])


class PlacementTests(unittest.TestCase):
    def setUp(self):
        stock_alerts._supported, cost_log._supported = True, True
        self.addCleanup(setattr, stock_alerts, "_supported", None)
        self.addCleanup(setattr, cost_log, "_supported", None)
        app.dependency_overrides[auth.get_current_user] = _owner
        self.addCleanup(app.dependency_overrides.clear)
        self.db = FakeDB({
            "ingredients": [
                {"id": "coke", "name": "COKE LIGHT", "base_unit": "PC", "category": None, "unit_cost": None, "current_stock": 0,
                 "reorder_threshold": 0, "needs_review": True, "station": None, "sheet_section": None, "sort_order": None},
                {"id": "x", "name": "Coke", "base_unit": "PC", "category": None, "unit_cost": None, "current_stock": 0,
                 "reorder_threshold": 0, "needs_review": False, "station": "ramen_hot_line", "sheet_section": "Drinks", "sort_order": 570},
            ],
            "stock_items": [{"id": "s1", "name": "Royal", "station": "ramen_hot_line", "category": "Drinks", "sort_order": 600}],
        })
        p = patch("app.routers.inventory.get_supabase", return_value=self.db)
        p.start()
        self.addCleanup(p.stop)
        self.client = TestClient(app)

    def test_move_to_a_station_goes_to_the_end_of_its_section(self):
        r = self.client.patch("/inventory/coke", json={"station": "ramen_hot_line", "sheet_section": " Drinks "})
        self.assertEqual(r.status_code, 200, r.text)
        row = self.db.rows["ingredients"][0]
        self.assertEqual((row["station"], row["sheet_section"], row["sort_order"]), ("ramen_hot_line", "Drinks", 610))

    def test_clear_verify(self):
        self.client.patch("/inventory/coke", json={"needs_review": False})
        self.assertFalse(self.db.rows["ingredients"][0]["needs_review"])

    def test_back_to_unsorted(self):
        self.client.patch("/inventory/x", json={"station": None})
        row = self.db.rows["ingredients"][1]
        self.assertEqual((row["station"], row["sheet_section"], row["sort_order"]), (None, None, None))

    def test_create_with_a_station(self):
        r = self.client.post("/inventory", json={"name": "PHOTO", "base_unit": "pcs", "station": "cafe_drinks", "sheet_section": "Cakes & pastries"})
        self.assertEqual(r.status_code, 200, r.text)
        row = self.db.rows["ingredients"][-1]
        self.assertEqual((row["station"], row["sheet_section"], row["sort_order"]), ("cafe_drinks", "Cakes & pastries", 10))


if __name__ == "__main__":
    unittest.main()
