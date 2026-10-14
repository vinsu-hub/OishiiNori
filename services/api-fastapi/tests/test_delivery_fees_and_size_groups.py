"""Rider delivery fees in the shift drawer, and Command Center size groups
(offline, no production writes)."""

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from app.routers.sales_insights import order_categories, size_group
from app.routers.shift_reports import build_shift_report
from tests.test_sales_insights import Query


class ShiftQuery(Query):
    def gte(self, key, value):
        self.filters.append(lambda row: row.get(key) is not None and row[key] >= value)
        return self

    def lt(self, key, value):
        self.filters.append(lambda row: row.get(key) is not None and row[key] < value)
        return self

    def is_(self, key, value):
        self.filters.append(lambda row: row.get(key) is None if value == "null" else row.get(key) == value)
        return self

    def maybe_single(self):
        self.single = True
        return self

    def execute(self):
        result = super().execute()
        if getattr(self, "single", False):
            return SimpleNamespace(data=result.data[0] if result.data else None)
        return result


class ShiftDB:
    def __init__(self, rows):
        self.rows = rows

    def table(self, name):
        return ShiftQuery(self.rows.get(name, []))


class RiderFeeDrawerTests(unittest.TestCase):
    def test_cash_and_online_delivery_fees_leave_the_expected_cash(self):
        sale = {"opened_at": "2026-10-14T03:00:00+00:00", "paid_at": None, "discount_amount": 0,
                "tax_amount": 0, "card_type": None, "order_source": "pos", "payment_status": "paid"}
        db = ShiftDB({
            "business_settings": [{"id": 1, "receipt_business_name": "Oishii Nori"}],
            "transactions": [
                # POS cash delivery: fee stored on the delivery, not in total.
                {**sale, "id": "pos-cash", "total_amount": 300, "payment_method": "cash"},
                # Online GCash delivery: fee already inside total_amount.
                {**sale, "id": "web-gcash", "total_amount": 260, "payment_method": "gcash"},
                {**sale, "id": "walk-in", "total_amount": 100, "payment_method": "cash"},
            ],
            "digital_orders": [{"id": "do-1", "transaction_id": "web-gcash", "payment_method": "gcash"}],
            "deliveries": [
                {"id": "d1", "transaction_id": "pos-cash", "digital_order_id": None, "delivery_fee": 80},
                {"id": "d2", "transaction_id": None, "digital_order_id": "do-1", "delivery_fee": 60},
            ],
        })
        shift = {"id": "shift", "shift_number": 1, "business_date": "2026-10-14", "report_version": 1,
                 "opened_at": "2026-10-14T00:00:00+00:00", "starting_cash": 1000, "opened_by": "me"}
        report = build_shift_report(db, shift, datetime(2026, 10, 14, 12, tzinfo=timezone.utc), 1320)
        drawer = report["cash_drawer"]
        self.assertEqual(drawer["cash_payments"], 480)  # 300 + 80 fee + 100
        self.assertEqual(drawer["rider_fees_cash"], 80)
        self.assertEqual(drawer["rider_fees_deductible"], 60)
        self.assertEqual(drawer["expected_cash"], 1000 + 480 - 80 - 60)
        self.assertEqual(drawer["difference"], 1320 - 1340)
        self.assertEqual(report["payments"]["GCASH"], 260)
        self.assertEqual(report["sales"]["delivery_fees"], 140)


class SizeGroupTests(unittest.TestCase):
    def test_size_groups_lead_in_order_without_double_counting(self):
        self.assertEqual(size_group("Oishii Maki Rolls", "8 pcs"), "8pc Maki")
        self.assertEqual(size_group("Oishii Maki Rolls", "4 pcs"), "4pc Maki")
        self.assertIsNone(size_group("Oishii Maki Rolls", "6 pcs"))
        self.assertEqual(size_group("Oishii Platter (Bundle)", "32 pcs assorted"), "Platter")
        self.assertEqual(size_group("Takoyaki (Classic)", "4 pcs"), "4pc Takoyaki")
        self.assertEqual(size_group("Takoyaki (Cheesy)", "8 pcs"), "8pc Takoyaki")
        self.assertIsNone(size_group("Takoyaki (Classic)", "24 pcs (Platter)"))
        self.assertIsNone(size_group("Ramen", "1 bowl"))

        groups = [{"category": name, "item_revenue": revenue} for name, revenue in [
            ("Ramen", 5000), ("8pc Takoyaki", 10), ("Platter", 20), ("Sides", 900), ("8pc Maki", 30), ("4pc Takoyaki", 40),
        ]]
        self.assertEqual([g["category"] for g in order_categories(groups)],
                         ["8pc Maki", "Platter", "4pc Takoyaki", "8pc Takoyaki", "Ramen", "Sides"])


if __name__ == "__main__":
    unittest.main()
