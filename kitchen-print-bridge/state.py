"""Tracks which transactions have already had a prep ticket printed, so a
restart doesn't reprint the whole `preparing` queue and a transaction that
stays in `preparing` across several poll cycles is only ever printed once.
Plain stdlib sqlite3 -- no new dependency, matches the task's "small SQLite
db" option."""

from __future__ import annotations

import sqlite3
from pathlib import Path


class PrintedTicketStore:
    def __init__(self, db_path: str | Path):
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute(
            """
            create table if not exists printed_tickets (
                transaction_id text primary key,
                order_number integer,
                printed_at text not null
            )
            """
        )
        self._conn.commit()

    def is_printed(self, transaction_id: str) -> bool:
        row = self._conn.execute(
            "select 1 from printed_tickets where transaction_id = ?", (transaction_id,)
        ).fetchone()
        return row is not None

    def mark_printed(self, transaction_id: str, order_number: int | None, printed_at_iso: str) -> None:
        self._conn.execute(
            "insert or replace into printed_tickets (transaction_id, order_number, printed_at) values (?, ?, ?)",
            (transaction_id, order_number, printed_at_iso),
        )
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()
