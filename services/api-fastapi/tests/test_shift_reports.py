"""Shift drawer reconciliation, payment timing, and pagination without live writes."""

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from app.routers.shift_reports import build_shift_report


class Query:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []
        self.start, self.end = 0, 499

    def select(self, *_): return self
    def maybe_single(self):
        self.single = True
        return self
    def order(self, *_): return self
    def eq(self, key, value):
        self.filters.append(lambda row: row.get(key) == value)
        return self
    def gte(self, key, value):
        self.filters.append(lambda row: row.get(key) is not None and row[key] >= value)
        return self
    def lt(self, key, value):
        self.filters.append(lambda row: row.get(key) is not None and row[key] < value)
        return self
    def is_(self, key, value):
        self.filters.append(lambda row: row.get(key) is None)
        return self
    def in_(self, key, values):
        self.filters.append(lambda row: row.get(key) in values)
        return self
    def range(self, start, end):
        self.start, self.end = start, end
        return self
    def execute(self):
        rows = [row for row in self.rows if all(f(row) for f in self.filters)]
        page = rows[self.start:self.end + 1]
        return SimpleNamespace(data=(page[0] if page else None) if getattr(self, "single", False) else page)


class DB:
    def __init__(self, **rows): self.rows = rows
    def table(self, name): return Query(self.rows[name])


class ShiftReportTests(unittest.TestCase):
    def test_cash_reconciles_and_late_delivery_enters_collection_shift(self):
        start = "2026-10-09T16:00:00+00:00"
        during = "2026-10-10T01:00:00+00:00"
        before = "2026-10-09T15:00:00+00:00"
        end = datetime(2026, 10, 10, 8, tzinfo=timezone.utc)
        def sale(key, opened, paid, amount, method, card=None, discount=0):
            return {"id": key, "opened_at": opened, "paid_at": paid, "total_amount": amount,
                    "discount_amount": discount, "tax_amount": 0, "payment_method": method,
                    "card_type": card, "payment_status": "paid"}
        transactions = [sale(str(i), during, None, 1, "cash") for i in range(1002)] + [
            sale("maya-online", during, None, 100, "gcash", discount=10),
            sale("bdo-pos", during, None, 200, "bdo"),
            sale("debit", during, None, 300, "card", "debit"),
            sale("credit", during, None, 400, "card", "credit"),
            sale("delivery", before, during, 50, "cash"),
            sale("old", before, None, 999, "cash"),
        ]
        db = DB(business_settings=[{"id": 1, "receipt_business_name": "Oishii Nori Sta. Cruz"}], transactions=transactions,
                digital_orders=[{"id": "digital", "transaction_id": "maya-online", "payment_method": "maya"}],
                deliveries=[{"id": "delivery-fee", "transaction_id": "delivery", "delivery_fee": 20}],
                cash_expenses=[{"id": "ice", "business_day_id": "shift", "description": "Ice", "amount": 40,
                                "created_at": during, "profiles": {"full_name": "Ana"}}],
                shift_cash_movements=[
                    {"id": "in", "business_day_id": "shift", "kind": "paid_in", "purpose": "Change fund", "amount": 30, "created_at": during, "profiles": {"full_name": "Ana"}},
                    {"id": "out", "business_day_id": "shift", "kind": "owner_transfer", "purpose": "Bank", "amount": 25, "created_at": during, "profiles": {"full_name": "Ana"}},
                    {"id": "refund", "business_day_id": "shift", "kind": "cash_refund", "purpose": "Voided order", "amount": 10, "created_at": during, "profiles": {"full_name": "Ana"}},
                ])
        shift = {"id": "shift", "shift_number": 42, "business_date": "2026-10-10",
                 "opened_at": start, "opened_by": "ana", "starting_cash": 500}
        report = build_shift_report(db, shift, end, 1507)
        self.assertEqual(report["sales"]["order_count"], 1007)
        self.assertEqual(report["payments"], {"BDO": 200.0, "Cash": 1072.0, "Credit": 400.0,
                                               "Debit": 300.0, "MAYA": 100.0})
        self.assertEqual(sum(report["payments"].values()), 2072)
        self.assertEqual(report["sales"]["gross"], 2082)
        self.assertEqual(report["sales"]["net"], 2062)
        # The cash delivery's ₱20 fee is kept by the rider, not the drawer.
        self.assertEqual(report["cash_drawer"]["rider_fees_cash"], 20)
        self.assertEqual(report["cash_drawer"]["expected_cash"], 1507)
        self.assertEqual(report["cash_drawer"]["difference"], 0)
        self.assertEqual(len(report["entries"]), 4)
        self.assertEqual((report["sales"]["grab_settlement"], report["sales"]["grab_orders"]), (0, 0))

    def test_grab_settlement_is_not_in_gross_sales(self):
        during = "2026-10-10T01:00:00+00:00"
        def sale(key, amount, method, discount=0, tax=0):
            return {"id": key, "opened_at": during, "paid_at": None, "total_amount": amount,
                    "discount_amount": discount, "tax_amount": tax, "payment_method": method,
                    "card_type": None, "payment_status": "paid"}
        db = DB(business_settings=[], transactions=[sale("cash", 500, "cash", tax=50), sale("grab", 800, "grab", discount=80, tax=80)],
                digital_orders=[], deliveries=[], cash_expenses=[], shift_cash_movements=[])
        shift = {"id": "shift", "shift_number": 43, "business_date": "2026-10-10",
                 "opened_at": "2026-10-09T16:00:00+00:00", "opened_by": "ana", "starting_cash": 100}
        report = build_shift_report(db, shift, datetime(2026, 10, 10, 8, tzinfo=timezone.utc), 600)
        sales = report["sales"]
        self.assertEqual((sales["gross"], sales["discounts"], sales["net"], sales["taxes"]), (500, 0, 500, 50))
        self.assertEqual((sales["grab_settlement"], sales["grab_orders"], sales["order_count"]), (800, 1, 2))
        self.assertEqual(report["payments"], {"Cash": 500.0, "Grab": 800.0})
        self.assertEqual(report["cash_drawer"]["expected_cash"], 600)


if __name__ == "__main__": unittest.main()
