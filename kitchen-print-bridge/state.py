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
        columns = {row[1] for row in self._conn.execute("pragma table_info(printed_tickets)")}
        if "revision" not in columns:
            self._conn.execute("alter table printed_tickets add column revision integer not null default 0")
            self._conn.commit()

    def is_printed(self, transaction_id: str, revision: int = 0) -> bool:
        row = self._conn.execute(
            "select 1 from printed_tickets where transaction_id = ? and revision = ?", (transaction_id, revision)
        ).fetchone()
        return row is not None

    def mark_printed(self, transaction_id: str, order_number: int | None, printed_at_iso: str, revision: int = 0) -> None:
        self._conn.execute(
            "insert or replace into printed_tickets (transaction_id, order_number, printed_at, revision) values (?, ?, ?, ?)",
            (transaction_id, order_number, printed_at_iso, revision),
        )
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()
