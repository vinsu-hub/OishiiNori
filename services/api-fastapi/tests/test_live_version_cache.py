"""Live lists are rebuilt only when the database change counter moves (0077)."""

import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.main import app
from app.routers import transactions as tx


def _db(versions):
    """A fake Supabase whose live_version reads return `versions` in turn."""
    db = MagicMock()
    q = db.table.return_value
    q.select.return_value = q
    q.eq.return_value = q
    q.execute.side_effect = [MagicMock(data=[{"version": v}]) for v in versions]
    return db


def _reset(supported=None):
    tx.clear_live_cache()
    tx._version_state.update(supported=supported, value=None, checked_at=0.0)


class VersionGateTests(unittest.TestCase):
    def setUp(self):
        _reset()

    def test_unchanged_version_serves_the_cache(self):
        db = _db([7, 7])
        with patch.object(tx, "get_supabase", return_value=db), patch.object(tx.time, "monotonic", side_effect=[0, 0, 1, 1, 100, 100]):
            tx.live_cache_put(("k",), b"[1]", tx.live_cache_version())
            self.assertEqual(tx.live_cache_get(("k",)), b"[1]")
            self.assertEqual(tx.live_cache_get(("k",)), b"[1]")  # 100 s later, same version: still served

    def test_bumped_version_forces_a_rebuild(self):
        db = _db([7, 8])
        with patch.object(tx, "get_supabase", return_value=db):
            tx.live_cache_put(("k",), b"[1]", tx.live_cache_version())
            tx.expire_version_check()
            self.assertIsNone(tx.live_cache_get(("k",)))

    def test_counter_is_read_at_most_every_few_seconds(self):
        db = _db([7])
        with patch.object(tx, "get_supabase", return_value=db):
            for _ in range(5):
                tx.current_live_version()
        self.assertEqual(db.table.return_value.execute.call_count, 1)

    def test_old_entries_expire_even_without_changes(self):
        db = _db([7, 7])
        clock = iter([0, 0, tx._LIVE_CACHE_MAX_AGE_SECONDS + 1, tx._LIVE_CACHE_MAX_AGE_SECONDS + 1])
        with patch.object(tx, "get_supabase", return_value=db), patch.object(tx.time, "monotonic", lambda: next(clock)):
            tx.live_cache_put(("k",), b"[1]", tx.live_cache_version())
            self.assertIsNone(tx.live_cache_get(("k",)))

    def test_without_the_migration_it_is_a_plain_10s_cache(self):
        db = MagicMock()
        db.table.return_value.select.return_value.eq.return_value.execute.side_effect = APIError({"message": "no table"})
        with patch.object(tx, "get_supabase", return_value=db):
            tx.live_cache_put(("k",), b"[1]", tx.live_cache_version())
            self.assertEqual(tx.live_cache_get(("k",)), b"[1]")
            tx.expire_version_check()  # a write clears it, as before
            self.assertIsNone(tx.live_cache_get(("k",)))


class WriteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_unrelated_write_keeps_the_cache_but_rechecks_the_counter(self):
        _reset(supported=True)
        tx._version_state.update(value=7, checked_at=10**9)
        tx.live_cache_put(("k",), b"[1]", 7)
        app.add_api_route("/_test_heartbeat", lambda: {"ok": True}, methods=["POST"])
        self.client.post("/_test_heartbeat")
        self.assertEqual(tx._version_state["checked_at"], 0.0)  # next read asks the database
        with patch.object(tx, "get_supabase", return_value=_db([7])):
            self.assertEqual(tx.live_cache_get(("k",)), b"[1]")  # nothing changed: cache kept
        with patch.object(tx, "get_supabase", return_value=_db([8])):
            tx.expire_version_check()
            self.assertIsNone(tx.live_cache_get(("k",)))  # an order changed: rebuilt


if __name__ == "__main__":
    unittest.main()
