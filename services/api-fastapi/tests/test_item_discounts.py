"""One-unit discount contract and legacy offline-sale compatibility."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.routers.transactions import _create_transaction_row, _one_unit_discount, _single_discount_item_index
from app.schemas import TransactionItemCreate


class ItemDiscountTests(unittest.TestCase):
    def test_only_one_unit_price_is_discounted(self):
        # Quantity and add-ons never enter the item discount base.
        self.assertEqual(_one_unit_discount(199.99, 20), 40.00)
        self.assertEqual(_one_unit_discount(99.95, 15), 14.99)

    def test_one_item_can_be_selected_in_a_mixed_order(self):
        items = [
            TransactionItemCreate(product_size_id="plain", quantity=3),
            TransactionItemCreate(product_size_id="selected", quantity=2,
                                  discount_type_id="senior",
                                  addons=[{"addon_id": "extra", "quantity": 2}]),
        ]
        self.assertEqual(_single_discount_item_index(items, None), 1)

    def test_multiple_items_and_mixed_contract_are_rejected(self):
        items = [TransactionItemCreate(product_size_id="a", quantity=1, discount_type_id="senior"),
                 TransactionItemCreate(product_size_id="b", quantity=1, discount_type_id="senior")]
        with self.assertRaises(HTTPException) as multiple:
            _single_discount_item_index(items, None)
        self.assertEqual(multiple.exception.status_code, 400)
        with self.assertRaises(HTTPException) as mixed:
            _single_discount_item_index(items[:1], "legacy")
        self.assertEqual(mixed.exception.status_code, 400)

    def test_legacy_order_discount_remains_allowed(self):
        items = [TransactionItemCreate(product_size_id="a", quantity=1)]
        self.assertIsNone(_single_discount_item_index(items, "legacy"))

    def test_fractional_line_below_one_cannot_receive_one_unit_discount(self):
        items = [TransactionItemCreate(product_size_id="a", quantity=0.5,
                                       discount_type_id="senior")]
        with self.assertRaises(HTTPException) as caught:
            _single_discount_item_index(items, None)
        self.assertEqual(caught.exception.status_code, 400)

    def test_sale_totals_discount_one_base_unit_and_keep_whole_order_vat_exemption(self):
        class Query:
            def __init__(self, db, name):
                self.db, self.name, self.payload = db, name, None

            def select(self, *_): return self
            def in_(self, *_): return self
            def eq(self, *_): return self
            def maybe_single(self): return self
            def insert(self, payload):
                self.payload = payload
                return self
            def update(self, payload):
                self.payload = payload
                return self
            def execute(self):
                if self.name == "product_sizes":
                    return SimpleNamespace(data=[
                        {"id": "sushi", "price": 100, "products": {"is_bundle": True}},
                        {"id": "drink", "price": 200, "products": {"is_bundle": True}},
                    ])
                if self.name == "menu_addons":
                    return SimpleNamespace(data=[{"id": "extra", "price": 30, "active": True}])
                if self.name == "discount_types":
                    return SimpleNamespace(data={"id": "senior", "name": "Senior", "percentage": 20,
                                                 "vat_exempt": True, "active": True})
                if self.name == "transactions":
                    if self.payload and "total_amount" in self.payload and "discount_amount" in self.payload:
                        self.db.final = self.payload
                        return SimpleNamespace(data=[{
                            "id": "sale", "employee_id": "cashier", "status": "open", "opened_at": "2026-10-12T00:00:00Z",
                            "is_owner_request": False, "total_amount": self.payload["total_amount"],
                            "discount_type_id": self.payload["discount_type_id"],
                            "discount_amount": self.payload["discount_amount"], "tax_amount": self.payload["tax_amount"],
                        }])
                    return SimpleNamespace(data=[{"id": "sale"}])
                if self.name == "transaction_items":
                    rows = self.payload if isinstance(self.payload, list) else [self.payload]
                    self.db.item_rows.extend(rows)
                    return SimpleNamespace(data=[{"id": f"item-{i}", **row}
                                                 for i, row in enumerate(rows, len(self.db.item_rows) - len(rows))])
                return SimpleNamespace(data=[])

        class DB:
            item_rows = []
            final = None
            def table(self, name): return Query(self, name)

        db = DB()
        items = [
            TransactionItemCreate(product_size_id="sushi", quantity=3, discount_type_id="senior",
                                  addons=[{"addon_id": "extra", "quantity": 2}]),
            TransactionItemCreate(product_size_id="drink", quantity=1),
        ]
        with patch("app.routers.transactions._item_discounts_supported_check", return_value=True), \
             patch("app.routers.transactions._transaction_item_addons_supported_check", return_value=True), \
             patch("app.routers.transactions._held_ingredients_supported_check", return_value=False), \
             patch("app.routers.transactions._transaction_order_context_supported_check", return_value=False), \
             patch("app.routers.transactions._transaction_order_source_supported_check", return_value=False), \
             patch("app.routers.transactions._transaction_card_vat_supported_check", return_value=False), \
             patch("app.routers.transactions._kitchen_status_supported_check", return_value=False), \
             patch("app.routers.transactions._attach_item_addons"), \
             patch("app.routers.transactions.adjust_stock_items_for_transaction"), \
             patch("app.routers.transactions._get_vat_rate", return_value=0.12):
            sale = _create_transaction_row(db, "cashier", items)
        self.assertEqual(sale.discount_amount, 20)
        self.assertEqual(sale.total_amount, 540)  # 3×100 + 2×30 add-ons + 200 − one 20% discount.
        self.assertEqual(sale.tax_amount, 0)  # VAT-exempt type still exempts the whole order.
        self.assertEqual(db.item_rows[0]["discount_amount"], 20)
        self.assertEqual(db.item_rows[0]["discount_name"], "Senior")
        self.assertEqual(db.item_rows[1]["discount_amount"], 0)
        self.assertFalse(db.item_rows[1]["discount_vat_exempt"])

        # With no add-ons these rows use one bulk PostgREST insert. A row
        # without discount_amount is sent as NULL alongside the discounted
        # row, violating the production NOT NULL column before cash checkout.
        bulk_db = DB()
        bulk_db.item_rows = []
        with patch("app.routers.transactions._item_discounts_supported_check", return_value=True), \
             patch("app.routers.transactions._transaction_item_addons_supported_check", return_value=True), \
             patch("app.routers.transactions._held_ingredients_supported_check", return_value=False), \
             patch("app.routers.transactions._transaction_order_context_supported_check", return_value=False), \
             patch("app.routers.transactions._transaction_order_source_supported_check", return_value=False), \
             patch("app.routers.transactions._transaction_card_vat_supported_check", return_value=False), \
             patch("app.routers.transactions._kitchen_status_supported_check", return_value=False), \
             patch("app.routers.transactions._attach_item_addons"), \
             patch("app.routers.transactions.adjust_stock_items_for_transaction"), \
             patch("app.routers.transactions._get_vat_rate", return_value=0.12):
            _create_transaction_row(bulk_db, "cashier", [
                TransactionItemCreate(product_size_id="sushi", quantity=1, discount_type_id="senior"),
                TransactionItemCreate(product_size_id="drink", quantity=1),
            ], payment_method="cash")
        self.assertEqual([row["discount_amount"] for row in bulk_db.item_rows], [20, 0])
        self.assertEqual([row["discount_vat_exempt"] for row in bulk_db.item_rows], [True, False])


if __name__ == "__main__":
    unittest.main()
