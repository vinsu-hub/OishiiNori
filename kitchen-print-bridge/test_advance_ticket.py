import tempfile
import unittest
from pathlib import Path

from state import PrintedTicketStore
from ticket import render_preview_text


class AdvanceTicketTests(unittest.TestCase):
    def test_ticket_shows_ready_time_and_update_revision(self):
        order = {
            "id": "order-123", "order_number": 12, "order_type": "takeout",
            "opened_at": "2026-10-09T01:00:00+00:00",
            "scheduled_for": "2026-10-10T04:30:00+00:00",
            "pickup_customer_name": "Ana Santos", "pickup_customer_phone": "09171234567",
            "items": [],
        }
        ticket = render_preview_text(order, {})
        self.assertIn("ADVANCE ORDER", ticket)
        self.assertIn("PICKUP READY", ticket)
        self.assertIn("Oct 10, 2026 12:30 PM", ticket)
        self.assertIn("Ana Santos", ticket)
        updated = render_preview_text({**order, "advance_schedule_revision": 1}, {})
        self.assertIn("ADVANCE - TIME UPDATED", updated)

    def test_print_store_reprints_only_for_new_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            store = PrintedTicketStore(Path(directory) / "tickets.sqlite")
            store.mark_printed("order-123", 12, "2026-10-09T01:00:00+00:00")
            self.assertTrue(store.is_printed("order-123"))
            self.assertFalse(store.is_printed("order-123", 1))
            store.mark_printed("order-123", 12, "2026-10-09T01:05:00+00:00", 1)
            self.assertTrue(store.is_printed("order-123", 1))
            store.close()


if __name__ == "__main__":
    unittest.main()
