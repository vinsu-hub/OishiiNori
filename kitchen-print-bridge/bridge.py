"""Kitchen print bridge -- polls the Oishii Nori backend for orders the
kitchen has just accepted (kitchen_status: queued -> preparing) and prints
a 58mm ESC/POS prep ticket for each one on the XP-58H, over Bluetooth
Classic/SPP. Runs on-prem next to the printer; deliberately not part of
the Vercel-hosted backend or any frontend (no websockets, same polling
posture as the rest of this project -- see lib/constants.ts's
POLL_INTERVAL_MS on the Kitchen Display).

Usage:
    python bridge.py                 # run continuously
    python bridge.py --once          # one poll cycle, then exit
    python bridge.py --test-print    # render a sample ticket to file, no
                                      # backend/printer needed -- see README.md
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

from api_client import build_product_index, fetch_active_kitchen_transactions, fetch_products
from auth import BridgeAuth
from config import Config, load_config, require_live_fields
from state import PrintedTicketStore
from ticket import print_ticket, render_preview_text

logger = logging.getLogger("kitchen_print_bridge")

_PRODUCT_CACHE_TTL_SECONDS = 600  # 10 min -- mirrors KitchenDisplay.tsx's own "fetch once, rarely changes" posture


def _configure_logging(log_file_path: str) -> None:
    logger.setLevel(logging.INFO)
    # python-escpos calls logging.basicConfig() on import (escpos/capabilities.py),
    # which attaches a handler to the root logger -- without propagate=False
    # every line here would also bubble up and print a second time through
    # that handler.
    logger.propagate = False
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")

    file_handler = RotatingFileHandler(log_file_path, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)


class PrinterConnection:
    """Keeps a single Serial connection to the printer open across poll
    cycles, reopening on demand after a write failure rather than
    reconnecting every cycle regardless. Never raises out of
    close_after_failure() -- a printer that's already gone is not itself
    an error worth crashing over."""

    def __init__(self, port: str, baudrate: int):
        self._port = port
        self._baudrate = baudrate
        self._printer = None

    def get(self):
        if self._printer is None:
            from escpos.printer import Serial

            self._printer = Serial(devfile=self._port, baudrate=self._baudrate, timeout=5)
            logger.info("Opened printer connection on %s @ %s baud", self._port, self._baudrate)
        return self._printer

    def close_after_failure(self) -> None:
        if self._printer is not None:
            try:
                self._printer.close()
            except Exception:  # noqa: BLE001 -- already failing, best-effort cleanup only
                pass
            self._printer = None


class ProductCache:
    def __init__(self, config: Config, auth: BridgeAuth):
        self._config = config
        self._auth = auth
        self._index: dict[str, dict] = {}
        self._loaded_at = 0.0

    def get(self) -> dict[str, dict]:
        if not self._index or (time.time() - self._loaded_at) > _PRODUCT_CACHE_TTL_SECONDS:
            products = fetch_products(self._config, self._auth)
            self._index = build_product_index(products)
            self._loaded_at = time.time()
            logger.info("Loaded product catalog (%d sizes)", len(self._index))
        return self._index

    def refresh(self) -> dict[str, dict]:
        self._loaded_at = 0.0
        return self.get()


def _opened_at(transaction: dict) -> datetime:
    raw = transaction.get("opened_at")
    if not raw:
        return datetime.now(timezone.utc)
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def poll_once(
    config: Config,
    auth: BridgeAuth,
    store: PrintedTicketStore,
    printer_conn: PrinterConnection,
    product_cache: ProductCache,
) -> None:
    try:
        transactions = fetch_active_kitchen_transactions(config, auth)
    except Exception as e:  # noqa: BLE001 -- a network blip must not kill the loop
        logger.error("Failed to fetch kitchen orders: %r", e)
        return

    # Ignore stale queued orders (e.g. from a previous day that was never
    # accepted) so switching the trigger on can't dump old tickets.
    cutoff = datetime.now(timezone.utc) - timedelta(hours=config.max_ticket_age_hours)
    transactions = [t for t in transactions if _opened_at(t) >= cutoff]

    pending = [t for t in transactions if not store.is_printed(t["id"])]
    if not pending:
        return
    logger.info("%d order(s) to print", len(pending))

    product_index = product_cache.get()
    for transaction in pending:
        # A held item's product_size_id might not be in the cache yet
        # (a brand-new product) -- refresh once per cycle, not per item.
        if any(item["product_size_id"] not in product_index for item in transaction.get("items", [])):
            product_index = product_cache.refresh()

        try:
            printer = printer_conn.get()
            print_ticket(printer, transaction, product_index, width=config.paper_width_chars)
            store.mark_printed(
                transaction["id"],
                transaction.get("order_number"),
                datetime.now(timezone.utc).isoformat(),
            )
            logger.info("Printed order %s (transaction %s)", transaction.get("order_number"), transaction["id"])
        except Exception as e:  # noqa: BLE001 -- printer off/out of range/etc; retry next cycle
            logger.error("Failed to print transaction %s: %r", transaction["id"], e)
            printer_conn.close_after_failure()
            # Deliberately not marked printed -- stays eligible next cycle.


def run(config: Config, once: bool) -> None:
    require_live_fields(config)
    auth = BridgeAuth(config)
    store = PrintedTicketStore(config.state_db_path)
    printer_conn = PrinterConnection(config.bt_port, config.bt_baudrate)
    product_cache = ProductCache(config, auth)

    stop = {"flag": False}

    def _handle_signal(signum, frame):  # noqa: ARG001
        logger.info("Received shutdown signal, stopping after this cycle")
        stop["flag"] = True

    signal.signal(signal.SIGINT, _handle_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _handle_signal)

    logger.info("Kitchen print bridge starting (poll every %ss)", config.poll_interval_seconds)
    while True:
        try:
            poll_once(config, auth, store, printer_conn, product_cache)
        except Exception as e:  # noqa: BLE001 -- one bad cycle must never kill the service
            logger.exception("Unhandled error in poll cycle: %r", e)
        if once or stop["flag"]:
            break
        time.sleep(config.poll_interval_seconds)

    store.close()
    logger.info("Kitchen print bridge stopped")


def _sample_transaction() -> dict:
    return {
        "id": "sample-0000",
        "order_number": 1234,
        "order_type": "delivery",
        "table_number": None,
        "opened_at": datetime.now(timezone.utc).isoformat(),
        "delivery": {
            "customer_name": "Juan Dela Cruz",
            "customer_phone": "0917 123 4567",
            "address": "123 Rizal St, Purok 4, a very long address to test wrapping",
            "landmark": "near the chapel",
            "barangay": "Poblacion II",
        },
        "items": [
            {
                "product_size_id": "size-1",
                "quantity": 2,
                "held_ingredients": ["Wasabi"],
                "addons": [{"addon_name": "Extra nori", "quantity": 1}],
            },
            {
                "product_size_id": "size-2",
                "quantity": 1,
                "held_ingredients": [],
                "addons": [],
            },
        ],
    }


def _sample_product_index() -> dict:
    return {
        "size-1": {"name": "California Maki", "size_label": "Regular"},
        "size-2": {"name": "Iced Tea", "size_label": "16oz"},
    }


def run_test_print(config: Config) -> None:
    """No backend or paired printer required -- renders through escpos's
    Dummy profile (an in-memory/file printer built for exactly this) so
    ticket formatting can be proofed before any Bluetooth setup happens."""
    from escpos.printer import Dummy

    printer = Dummy()
    transaction = _sample_transaction()
    product_index = _sample_product_index()
    print_ticket(printer, transaction, product_index, width=config.paper_width_chars)

    preview = render_preview_text(transaction, product_index, width=config.paper_width_chars)

    raw_path = Path("test_ticket.bin")
    raw_path.write_bytes(printer.output)
    text_path = Path("test_ticket.txt")
    text_path.write_text(preview, encoding="utf-8")

    print(f"Wrote raw ESC/POS bytes (what actually goes to the printer) to {raw_path.resolve()}")
    print(f"Wrote a human-readable preview to {text_path.resolve()}")
    print("\n--- preview ---")
    print(preview)


def main() -> None:
    parser = argparse.ArgumentParser(description="Oishii Nori kitchen print bridge")
    parser.add_argument("--once", action="store_true", help="Run a single poll cycle then exit")
    parser.add_argument(
        "--test-print", action="store_true", help="Render a sample ticket to file, no backend/printer needed"
    )
    args = parser.parse_args()

    config = load_config()
    _configure_logging(config.log_file_path)

    if args.test_print:
        run_test_print(config)
        return

    try:
        run(config, once=args.once)
    except RuntimeError as e:
        logger.error(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
