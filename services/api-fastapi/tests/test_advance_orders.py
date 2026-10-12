"""Advance order timing and kitchen transition guards."""

import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from app.routers.transactions import ADVANCE_LEAD, _set_kitchen_status, _validate_advance_time, create_transaction, settle_payment
from app.schemas import CreateTransactionRequest, SettlePaymentRequest


class AdvanceTimeTests(unittest.TestCase):
    def test_schedule_requires_timezone_and_30_minutes_to_7_days(self):
        now = datetime.now(timezone.utc)
        for value in (now.replace(tzinfo=None), now + timedelta(minutes=29), now + timedelta(days=8)):
            with self.subTest(value=value), self.assertRaises(HTTPException) as caught:
                _validate_advance_time(value)
            self.assertEqual(caught.exception.status_code, 400)
        chosen = now + timedelta(hours=2)
        self.assertEqual(_validate_advance_time(chosen), chosen)

    def test_kitchen_cannot_start_advance_order_before_lead_window(self):
        transaction = {
            "id": "advance", "status": "open", "kitchen_status": "queued",
            "scheduled_for": (datetime.now(timezone.utc) + ADVANCE_LEAD + timedelta(hours=1)).isoformat(),
        }
        with self.assertRaises(HTTPException) as caught:
            _set_kitchen_status(None, transaction, "preparing", SimpleNamespace(id="kitchen"), False)
        self.assertEqual(caught.exception.status_code, 409)

    def test_pay_at_pickup_creates_unpaid_advance_order(self):
        body = CreateTransactionRequest(
            employee_id="cashier", items=[{"product_size_id": "size", "quantity": 1}],
            order_type="takeout", scheduled_for=datetime.now(timezone.utc) + timedelta(hours=2),
            pickup_customer_name="Guest", pickup_customer_phone="09123456789",
            pay_on_pickup=True,
        )
        with patch("app.routers.transactions.get_supabase", return_value=object()), \
             patch("app.routers.transactions.check_idempotency_key", return_value=None), \
             patch("app.routers.transactions._business_days_supported_check", return_value=False), \
             patch("app.routers.transactions._create_transaction_row", return_value=SimpleNamespace(id="order")) as create, \
             patch("app.routers.transactions.record_idempotency_key"):
            create_transaction(body, SimpleNamespace(id="cashier", role="employee"))
        self.assertIsNone(create.call_args.kwargs["payment_method"])
        self.assertTrue(create.call_args.kwargs["pay_on_delivery"])

    def test_pay_at_pickup_rejects_unscheduled_and_preselected_payment(self):
        base = dict(employee_id="cashier", items=[{"product_size_id": "size", "quantity": 1}],
                    order_type="takeout", pickup_customer_name="Guest", pickup_customer_phone="09123456789",
                    pay_on_pickup=True)
        for extra in ({}, {"scheduled_for": datetime.now(timezone.utc) + timedelta(hours=2), "payment_method": "cash"}):
            with self.subTest(extra=extra), patch("app.routers.transactions.get_supabase", return_value=object()), \
                 patch("app.routers.transactions.check_idempotency_key", return_value=None), \
                 self.assertRaises(HTTPException) as caught:
                create_transaction(CreateTransactionRequest(**base, **extra), SimpleNamespace(id="cashier", role="employee"))
            self.assertEqual(caught.exception.status_code, 400)

    def test_payment_settlement_rejects_a_concurrent_second_collection(self):
        db = MagicMock()
        db.table.return_value.update.return_value.eq.return_value.eq.return_value.neq.return_value.execute.return_value.data = []
        with patch("app.routers.transactions.get_supabase", return_value=db), \
             patch("app.routers.transactions._payment_status_supported_check", return_value=True), \
             patch("app.routers.transactions._fetch_transaction_with_items", return_value={"status": "open", "payment_status": "unpaid"}), \
             self.assertRaises(HTTPException) as caught:
            settle_payment("order", SettlePaymentRequest(payment_method="cash"), SimpleNamespace(id="cashier", role="employee"))
        self.assertEqual(caught.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
