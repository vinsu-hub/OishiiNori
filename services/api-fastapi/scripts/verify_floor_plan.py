"""
Disposable verification pass for the Visual Floor Plan backend
(supabase/migrations/0032_table_floor_plan.sql, the table-layout pass-through
in app/routers/reservations.py, and the capacity_max guard in
app/routers/transactions.py create_transaction).

Scenario:
  1. Migration 0032 applied: an existing table row has non-null pos_x /
     capacity_min / capacity_max and needs_layout_review = true.
  2. PATCH /tables/{id} with layout fields persists them AND flips
     needs_layout_review to false; capacity tracks capacity_max.
  3. A dine-in transaction with guest_count above capacity_max is rejected
     400; within range (and below capacity_min) succeeds.

Not a permanent test suite. Hits a locally running
`uvicorn app.main:app --port 8010`. Test data is left voided / deactivated.

Run with:  .venv/Scripts/python.exe scripts/verify_floor_plan.py
"""
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
API_BASE = os.environ.get("QA_API_BASE", "http://127.0.0.1:8010")
QA_PASSWORD = "oishii1234-qa"
POS_NUMBER = 992

admin = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = ""):
    results.append((name, condition, detail))
    print(f"[{'PASS' if condition else 'FAIL'}] {name}" + (f" -- {detail}" if detail and not condition else ""))


def login(email: str, password: str) -> tuple[str, str]:
    client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
    session = client.auth.sign_in_with_password({"email": email, "password": password})
    return session.session.access_token, session.session.user.id


token, user_id = login("qa.tester@oishiinori.com", QA_PASSWORD)
headers = {"Authorization": f"Bearer {token}"}
print("logged in as qa.tester\n")

# --- 1. migration applied -------------------------------------------------
rows = (
    admin.table("tables")
    .select("id, label, pos_x, capacity_min, capacity_max, needs_layout_review")
    .eq("active", True)
    .execute()
    .data
)
check("0032 columns exist on tables", bool(rows) and "pos_x" in rows[0], str(rows[0] if rows else None))
bad = [r["label"] for r in rows if r["pos_x"] is None or r["capacity_min"] is None or r["capacity_max"] is None]
check("every active table has a position + capacity range", not bad, f"missing on: {bad}")

admin.table("tables").delete().eq("label", "QA-FloorPlan").execute()  # clear a leftover from a failed run
test_table = admin.table("tables").insert(
    {"label": "QA-FloorPlan", "capacity": 6, "pos_table_number": POS_NUMBER, "capacity_min": 4, "capacity_max": 6}
).execute().data[0]
print(f"created QA-FloorPlan (id {test_table['id']}, pos #{POS_NUMBER}, seats 4-6)\n")

created_txn_ids: list[str] = []
try:
    # --- 2. layout PATCH clears needs_layout_review ----------------------
    admin.table("tables").update({"needs_layout_review": True}).eq("id", test_table["id"]).execute()
    patch = requests.patch(
        f"{API_BASE}/tables/{test_table['id']}",
        headers=headers,
        json={"pos_x": 300, "pos_y": 220, "floor_group": "Booth Row", "shape": "rectangle", "capacity_min": 4, "capacity_max": 6},
        timeout=15,
    )
    check("PATCH /tables layout -> 200", patch.status_code == 200, f"{patch.status_code} {patch.text}")
    if patch.status_code == 200:
        body = patch.json()
        check("layout persisted", body["pos_x"] == 300 and body["floor_group"] == "Booth Row", str(body))
        check("needs_layout_review cleared by layout edit", body["needs_layout_review"] is False, str(body))
        check("capacity tracks capacity_max", body["capacity"] == 6, str(body))

    # --- 3. capacity_max guard on create_transaction -------------------
    size_row = admin.table("product_sizes").select("id").limit(1).execute().data
    if not size_row:
        check("product_sizes available for a test sale", False, "none in DB")
    else:
        size_id = size_row[0]["id"]

        def charge(guests: int):
            return requests.post(
                f"{API_BASE}/transactions",
                headers=headers,
                json={
                    "employee_id": user_id,
                    "items": [{"product_size_id": size_id, "quantity": 1}],
                    "order_type": "dine_in",
                    "table_number": POS_NUMBER,
                    "guest_count": guests,
                    "payment_method": "cash",
                },
                timeout=15,
            )

        over = charge(8)
        check("party of 8 at a 4-6 table -> 400", over.status_code == 400, f"{over.status_code} {over.text}")

        ok = charge(2)  # below capacity_min is fine
        check("party of 2 at a 4-6 table -> 200", ok.status_code == 200, f"{ok.status_code} {ok.text}")
        if ok.status_code == 200:
            created_txn_ids.append(ok.json()["id"])

        at_max = charge(6)
        check("party of 6 (== max) -> 200", at_max.status_code == 200, f"{at_max.status_code} {at_max.text}")
        if at_max.status_code == 200:
            created_txn_ids.append(at_max.json()["id"])
finally:
    print("\n=== Cleanup ===")
    for txn_id in created_txn_ids:
        requests.post(
            f"{API_BASE}/transactions/{txn_id}/void",
            headers=headers,
            json={"reason": "QA verification"},
            timeout=15,
        )
    admin.table("tables").update({"active": False, "pos_table_number": None}).eq("id", test_table["id"]).execute()
    print("deactivated QA-FloorPlan")

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
if failed:
    print("FAILURES:")
    for name, _, detail in failed:
        print(f"  - {name}: {detail}")
    sys.exit(1)
print("ALL CHECKS PASSED")
