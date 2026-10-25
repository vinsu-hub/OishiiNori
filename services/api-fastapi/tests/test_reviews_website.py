"""Owner-picked reviews on the website's Reviews page (2026-10-25)."""

import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app import rate_limit
from app.auth import CurrentUser, get_current_user
from app.main import app
from app.routers import reviews

NAMED = {"id": "r1", "is_anonymous": False, "customer_name": "Paul", "rating": 5, "body": "Great!",
         "photo_url": None, "created_at": "2026-10-24T09:18:00+00:00"}
ANON = {**NAMED, "id": "r2", "is_anonymous": True, "customer_name": None}
STAFF_ONLY = {"status": "approved", "rejected_reason": None, "decided_by": "u1", "decided_at": None,
              "show_on_website": True}


def _db(rows):
    db = MagicMock()
    q = db.table.return_value
    for name in ("select", "eq", "order", "limit", "update", "maybe_single"):
        getattr(q, name).return_value = q
    q.execute.return_value = MagicMock(data=rows)
    return db


def _as(role, extra_pages=()):
    app.dependency_overrides[get_current_user] = lambda: CurrentUser("u1", role, None, "Test", list(extra_pages))


class PublicReviewsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        rate_limit._local_hits.clear()
        reviews._public_reviews_cache.clear()

    def test_only_approved_and_switched_on(self):
        db = _db([NAMED])
        with patch.object(reviews, "get_supabase", return_value=db):
            r = self.client.get("/public/reviews")
        self.assertEqual(r.status_code, 200)
        q = db.table.return_value
        q.eq.assert_any_call("status", "approved")
        q.eq.assert_any_call("show_on_website", True)
        self.assertIn("s-maxage=60", r.headers["cache-control"])

    def test_anonymous_name_and_no_staff_fields(self):
        with patch.object(reviews, "get_supabase", return_value=_db([{**ANON, **STAFF_ONLY}])):
            body = self.client.get("/public/reviews").json()
        self.assertEqual(body[0]["name"], "Anonymous")
        for field in ("customer_name", "is_anonymous", *STAFF_ONLY):
            self.assertNotIn(field, body[0])


class WebsiteToggleTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(app.dependency_overrides.clear)

    def _toggle(self, review, show):
        db = _db({**NAMED, **review})
        db.table.return_value.execute.side_effect = [
            MagicMock(data={**NAMED, **review}),
            MagicMock(data=[{**NAMED, **review, "show_on_website": show}]),
        ]
        with patch.object(reviews, "get_supabase", return_value=db):
            return self.client.post("/reviews/r1/website", json={"show": show})

    def test_pending_review_cannot_be_shown(self):
        _as("executive")
        self.assertEqual(self._toggle({"status": "pending"}, True).status_code, 409)

    def test_approved_review_shown_and_cache_cleared(self):
        _as("manager")
        reviews._public_reviews_cache["v"] = []
        r = self._toggle({"status": "approved"}, True)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["show_on_website"])
        self.assertNotIn("v", reviews._public_reviews_cache)

    def test_hiding_always_allowed(self):
        _as("executive")
        self.assertEqual(self._toggle({"status": "rejected"}, False).status_code, 200)

    def test_employee_without_grant_refused(self):
        _as("employee")
        with patch.object(reviews, "get_supabase") as db:
            self.assertEqual(self.client.post("/reviews/r1/website", json={"show": True}).status_code, 403)
        db.assert_not_called()


if __name__ == "__main__":
    unittest.main()
