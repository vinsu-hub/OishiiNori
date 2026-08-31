"""One-off maintenance: permanently delete the test/QA tables left in the
`tables` table by system_health_check.py, the verify_*.py scripts, and a
since-removed diagnostic script (`HEALTHCHECK *`, `DIAG *`, `DIAG-*`,
`DIAG TEMP *`, `QA-*`).

They're all `active = false` already, so they don't show on the floor plan, but
they clutter the Reservations > Tables list and admin queries, and
system_health_check.py kept adding a new `HEALTHCHECK <ts>` row on every run
(now fixed to self-delete).

Safe and idempotent: only touches rows with a test-ish label AND `active = false`
(a real table is never `active = false` in normal use). Two of the QA tables have
leftover QA test reservations (`table_id` FK) -- those child rows are deleted
first. Aborts if any matched table is somehow referenced by a real transaction
(there are none -- `transactions.table_number` is a plain int, not an FK -- but
we assert it).

Run:  py -3 services/api-fastapi/scripts/cleanup_test_tables.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

import psycopg2

SUPABASE_URL = os.environ["SUPABASE_URL"]
DB_PASSWORD = os.environ["SUPABASE_DB_PASSWORD"]
PROJECT_REF = SUPABASE_URL.split("//")[1].split(".")[0]

LABEL_PATTERNS = (
    "HEALTHCHECK %",
    "DIAG %",
    "DIAG-%",
    "DIAG TEMP %",
    "QA-%",
)
WHERE = " or ".join("label like %s" for _ in LABEL_PATTERNS)

conn = psycopg2.connect(
    host=f"db.{PROJECT_REF}.supabase.co",
    port=5432,
    dbname="postgres",
    user="postgres",
    password=DB_PASSWORD,
)
conn.autocommit = False
try:
    with conn.cursor() as cur:
        cur.execute(
            f"select id, label, active from tables where ({WHERE})",
            LABEL_PATTERNS,
        )
        matched = cur.fetchall()

        active_hits = [row for row in matched if row[2]]
        if active_hits:
            raise SystemExit(
                f"Refusing to run: {len(active_hits)} matched table(s) are active "
                f"-- {[r[1] for r in active_hits]}. Investigate before deleting."
            )

        ids = [row[0] for row in matched]
        if not ids:
            print("Nothing to clean up -- 0 test tables found.")
            conn.rollback()
            raise SystemExit(0)

        # transactions has no table_id FK (order_type/table_number are plain
        # columns), so only reservations can hold a FK to these rows.
        cur.execute("select count(*) from reservations where table_id = any(%s::uuid[])", (ids,))
        child_reservations = cur.fetchone()[0]

        cur.execute("delete from reservations where table_id = any(%s::uuid[])", (ids,))
        cur.execute("delete from tables where id = any(%s::uuid[])", (ids,))

    conn.commit()
    print(f"Deleted {len(ids)} test table(s) and {child_reservations} child reservation(s):")
    for _id, label, _active in sorted(matched, key=lambda r: r[1]):
        print(f"  - {label}")
except Exception:
    conn.rollback()
    raise
finally:
    conn.close()
