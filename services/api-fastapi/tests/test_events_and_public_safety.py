"""Events sign-ups and public traffic safeguards (2026-10-19)."""

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import rate_limit
from app.main import app
from app.routers import digital_menu, events
from app.schemas import CreateDigitalOrderRequest

FUTURE = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
PAST = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
EVENT = {"id": "e1", "listed": True, "signups_open": True, "slots_full": False, "starts_at": FUTURE}
SIGNUP = {"name": "Ana", "phone": "09171234567", "slots": 2}


def _db_with_event(event):
    db = MagicMock()
    q = db.table.return_value
    for name in ("select", "eq", "limit", "insert"):
        getattr(q, name).return_value = q
    q.execute.return_value = MagicMock(data=[event])
    db.rpc.return_value.execute.return_value = MagicMock(data=True)
    return db


class EventSignupTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        rate_limit._local_hits.clear()

    def test_accepting_signups(self):
        self.assertTrue(events.accepting_signups(EVENT))
        for change in ({"listed": False}, {"signups_open": False}, {"slots_full": True}, {"starts_at": PAST}):
            self.assertFalse(events.accepting_signups({**EVENT, **change}), change)

    def test_signup_saved_when_open(self):
        db = _db_with_event(EVENT)
        with patch.object(events, "get_supabase", return_value=db):
            r = self.client.post("/public/events/e1/signups", json=SIGNUP)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(db.table.return_value.insert.call_args[0][0]["slots"], 2)

    def test_full_event_refuses_signups(self):
        with patch.object(events, "get_supabase", return_value=_db_with_event({**EVENT, "slots_full": True})):
            self.assertEqual(self.client.post("/public/events/e1/signups", json=SIGNUP).status_code, 409)

    def test_honeypot_saves_nothing(self):
        with patch.object(events, "get_supabase") as db:
            r = self.client.post("/public/events/e1/signups", json={**SIGNUP, "website": "spam.example"})
        self.assertEqual(r.json(), {"ok": True})
        db.assert_not_called()

    def test_bad_phone_rejected(self):
        self.assertEqual(self.client.post("/public/events/e1/signups", json={**SIGNUP, "phone": "123"}).status_code, 422)


class PublicSafetyTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        rate_limit._local_hits.clear()
        digital_menu._public_cache.clear()

    def test_local_limit_refuses_without_the_database(self):
        for _ in range(3):
            rate_limit.local_rate_limit("t:1.2.3.4", limit=3, window_seconds=60)
        with self.assertRaises(HTTPException) as caught:
            rate_limit.local_rate_limit("t:1.2.3.4", limit=3, window_seconds=60)
        self.assertEqual(caught.exception.status_code, 429)

    def test_order_size_caps(self):
        line = {"product_size_id": "s", "quantity": 1}
        base = {"order_channel": "pickup", "payment_method": "cash"}
        with self.assertRaises(ValidationError):
            CreateDigitalOrderRequest(**base, items=[line] * 31)
        with self.assertRaises(ValidationError):
            CreateDigitalOrderRequest(**base, items=[{**line, "quantity": 31}])
        with self.assertRaises(ValidationError):
            CreateDigitalOrderRequest(**base, items=[line], customer_note="x" * 301)

    def test_order_honeypot_never_reaches_supabase(self):
        body = {"order_channel": "pickup", "payment_method": "cash", "items": [{"product_size_id": "s", "quantity": 1}],
                "website": "bot"}
        with patch.object(digital_menu, "get_supabase") as db:
            self.assertEqual(self.client.post("/public/orders", json=body).status_code, 400)
        db.assert_not_called()

    def test_public_catalog_is_cdn_cached(self):
        db = MagicMock()
        q = db.table.return_value
        q.select.return_value = q
        q.order.return_value = q
        q.execute.return_value = MagicMock(data=[{"barangay": "Pila", "zone": "Nearby towns", "fee": 200}])
        with patch.object(digital_menu, "get_supabase", return_value=db):
            first = self.client.get("/public/delivery-fees")
            self.client.get("/public/delivery-fees")
        self.assertIn("s-maxage=300", first.headers["cache-control"])
        self.assertEqual(q.execute.call_count, 1)  # second view served from cache


if __name__ == "__main__":
    unittest.main()
