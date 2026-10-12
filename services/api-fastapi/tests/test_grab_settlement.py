"""Grab platform payments must stay outside the register cash method."""

import unittest

from fastapi import HTTPException

from app.routers.transactions import _validate_grab_settlement


class GrabSettlementTests(unittest.TestCase):
    def test_grab_source_requires_grab_settlement(self):
        _validate_grab_settlement("grab", "grab")
        for method in (None, "cash", "maya", "gcash"):
            with self.subTest(method=method), self.assertRaises(HTTPException):
                _validate_grab_settlement("grab", method)

    def test_grab_settlement_cannot_be_used_for_regular_orders(self):
        with self.assertRaises(HTTPException):
            _validate_grab_settlement("pos", "grab")

    def test_grab_cannot_defer_to_cash_collection(self):
        for delivery, pickup in ((True, False), (False, True)):
            with self.subTest(delivery=delivery, pickup=pickup), self.assertRaises(HTTPException):
                _validate_grab_settlement("grab", "grab", delivery, pickup)


if __name__ == "__main__":
    unittest.main()
