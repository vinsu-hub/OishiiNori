"""
Disposable verification pass for the Reservation-to-POS table block
(supabase/migrations/0031_pos_reservation_block.sql, the /pos/tables/*
endpoints in app/routers/reservations.py, and the block check in
app/routers/transactions.py create_transaction).

Scenario:
  1. A registry table gets a pos_table_number; a confirmed reservation on it
     for right now makes GET /pos/tables/status report blocked=true.
  2. A dine-in transaction on that table number is rejected (409) with no
     override; a non-manager cannot mint an override (403); a manager can.
  3. The transaction succeeds once with the override token and is rejected
     if the same token is reused (403). The reservation_overrides row is
     stamped with the transaction id and shows up on the reservation.
  4. The block is time-bounded: a status check for a time outside
     [start - 15min, end) reports blocked=false.

Not a permanent test suite. Hits a locally running
`uvicorn app.main:app --port 8010` over real HTTP. Test data is left in a
voided / deactivated final state, same as verify_reservations.py.

Run with:  .venv/Scripts/python.exe scripts/verify_pos_table_block.py
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

import bcrypt
import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
API_BASE = os.environ.get("QA_API_BASE", "http://127.0.0.1:8010")

QA_PASSWORD = "oishii1234-qa"
QA_PIN = "4321"
QA_PIN_HASH = bcrypt.hashpw(QA_PIN.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
PH_OFFSET = timedelta(hours=8)
POS_NUMBER = 991  # unlikely to collide with a real table

admin = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = ""):
    results.append((name, condition, detail))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" -- {detail}" if detail and not condition else ""))


def ensure_qa_user(email: str, employee_number: str, role: str) -> tuple[str, str]:
    existing = admin.table("profiles").select("id").eq("employee_number", employee_number).maybe_single().execute()
    if existing and existing.data:
        user_id = existing.data["id"]
    else:
        users = admin.auth.admin.list_users()
        found = next((u for u in users if u.email == email), None)
        user_id = found.id if found else admin.auth.admin.create_user(
            {"email": email, "password": QA_PASSWORD, "email_confirm": True}
        ).user.id
    admin.table("profiles").upsert(
        {
            "id": user_id,
            "role": role,
            "full_name": f"QA {role.title()}",
            "department": "kitchen",
            "employee_number": employee_number,
            "kiosk_pin_hash": QA_PIN_HASH,
        }
    ).execute()
    auth_client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
    session = auth_client.auth.sign_in_with_password({"email": email, "password": QA_PASSWORD})
    return user_id, session.session.access_token


mgr_id, mgr_token = ensure_qa_user("qa.tester@oishiinori.com", "QA-EXEC", "executive")
emp_id, emp_token = ensure_qa_user("qa.employee@oishiinori.com", "QA-EMP", "employee")
mgr_headers = {"Authorization": f"Bearer {mgr_token}"}
emp_headers = {"Authorization": f"Bearer {emp_token}"}
print("logged in as QA-EXEC (manager-tier) and QA-EMP (employee)\n")

# Wide-open business hours so the reservation submit isn't rejected.
REAL_HOURS = {"open_time": "10:00:00", "close_time": "22:00:00", "closed_weekdays": []}


def _sane_restore(captured: dict) -> dict:
    out = {k: v for k, v in captured.items() if k in ("vat_rate", "open_time", "close_time", "closed_weekdays")}
    if out.get("open_time", "").startswith("00:") or out.get("close_time", "").startswith("23:"):
        out.update(REAL_HOURS)
    return out


original_settings = requests.get(f"{API_BASE}/settings/business", headers=mgr_headers, timeout=15).json()
requests.patch(
    f"{API_BASE}/settings/business",
    headers=mgr_headers,
    json={"open_time": "00:00:00", "close_time": "23:59:00", "closed_weekdays": []},
    timeout=15,
).raise_for_status()

now_ph = datetime.now(timezone.utc) + PH_OFFSET
today_ph = now_ph.date()
# Start 30 min ago so "now" sits inside [start, end); keeps it valid even if
# the prep buffer weren't applied.
start_dt = now_ph - timedelta(minutes=30)
start_time = start_dt.strftime("%H:%M:00")

size_row = admin.table("product_sizes").select("id").limit(1).execute().data
if not size_row:
    print("No product_sizes in the DB -- cannot exercise a completed sale. Aborting.")
    sys.exit(1)
SIZE_ID = size_row[0]["id"]

# Reuse a leftover QA-POS-Block row if one exists (older runs may leave it,
# and FK on delete restrict blocks deleting a row that ever held a
# reservation); otherwise create it.
_spec = {"label": "QA-POS-Block", "capacity": 4, "capacity_min": 4, "capacity_max": 4,
         "pos_table_number": POS_NUMBER, "active": True}
_existing = admin.table("tables").select("id").eq("label", "QA-POS-Block").maybe_single().execute()
if _existing and _existing.data:
    table = admin.table("tables").update(_spec).eq("id", _existing.data["id"]).execute().data[0]
    print(f"reused QA-POS-Block (pos #{POS_NUMBER}, id {table['id']})\n")
else:
    table = admin.table("tables").insert(_spec).execute().data[0]
    print(f"created QA-POS-Block (pos #{POS_NUMBER}, id {table['id']})\n")

created_reservation_id = None
created_txn_ids: list[str] = []

try:
    # --- Set up a confirmed reservation for now ---------------------------
    submit = requests.post(
        f"{API_BASE}/public/reservations",
        json={
            "party_size": 4,
            "reservation_date": today_ph.isoformat(),
            "start_time": start_time,
            "customer_name": "QA Blocker",
            "customer_phone": "09170000000",
        },
        timeout=15,
    )
    check("reservation submit succeeds", submit.status_code == 200, f"{submit.status_code} {submit.text}")
    reservation = submit.json()
    created_reservation_id = reservation["id"]
    # It may auto-assign a different table if others fit; force it onto ours.
    admin.table("reservations").update({"table_id": table["id"]}).eq("id", created_reservation_id).execute()
    conf = requests.post(
        f"{API_BASE}/reservations/{created_reservation_id}/confirm", headers=mgr_headers, timeout=15
    )
    check("reservation confirm succeeds", conf.status_code == 200, f"{conf.status_code} {conf.text}")

    # --- 1. status endpoint ---------------------------------------------------
    st = requests.get(
        f"{API_BASE}/pos/tables/status", params={"table_number": POS_NUMBER}, headers=mgr_headers, timeout=15
    ).json()
    check("status: table reports blocked=true now", st.get("blocked") is True, st)
    check("status: reservation payload present", (st.get("reservation") or {}).get("customer_name") == "QA Blocker", st)

    st_unmapped = requests.get(
        f"{API_BASE}/pos/tables/status", params={"table_number": 987654}, headers=mgr_headers, timeout=15
    ).json()
    check("status: unmapped pos number is never blocked", st_unmapped.get("blocked") is False, st_unmapped)

    st_later = requests.get(
        f"{API_BASE}/pos/tables/status",
        params={"table_number": POS_NUMBER, "at": (now_ph + timedelta(hours=6)).isoformat()},
        headers=mgr_headers,
        timeout=15,
    ).json()
    check("status: outside the window blocked=false", st_later.get("blocked") is False, st_later)

    # --- 2. transaction rejected without override ---------------------------
    def charge(headers, override_id=None):
        payload = {
            "employee_id": mgr_id if headers is mgr_headers else emp_id,
            "items": [{"product_size_id": SIZE_ID, "quantity": 1}],
            "order_type": "dine_in",
            "table_number": POS_NUMBER,
            "guest_count": 4,
            "payment_method": "cash",
        }
        if override_id:
            payload["reservation_override_id"] = override_id
        return requests.post(f"{API_BASE}/transactions", json=payload, headers=headers, timeout=15)

    no_ovr = charge(mgr_headers)
    check("charge without override -> 409", no_ovr.status_code == 409, f"{no_ovr.status_code} {no_ovr.text}")

    # --- 3. override minting: non-manager blocked, manager allowed ---------
    emp_ovr = requests.post(
        f"{API_BASE}/pos/tables/override",
        json={"table_number": POS_NUMBER, "employee_number": "QA-EMP", "pin": QA_PIN, "reason": "nope"},
        headers=emp_headers,
        timeout=15,
    )
    check("override by employee -> 403", emp_ovr.status_code == 403, f"{emp_ovr.status_code} {emp_ovr.text}")

    mgr_ovr = requests.post(
        f"{API_BASE}/pos/tables/override",
        json={"table_number": POS_NUMBER, "employee_number": "QA-EXEC", "pin": QA_PIN, "reason": "VIP walk-in, guest waived"},
        headers=mgr_headers,
        timeout=15,
    )
    check("override by manager -> 200 with token", mgr_ovr.status_code == 200 and mgr_ovr.json().get("override_id"), mgr_ovr.text)
    override_id = mgr_ovr.json().get("override_id") if mgr_ovr.status_code == 200 else None

    mgr_ovr_wrong_pin = requests.post(
        f"{API_BASE}/pos/tables/override",
        json={"table_number": POS_NUMBER, "employee_number": "QA-EXEC", "pin": "0000", "reason": "x"},
        headers=mgr_headers,
        timeout=15,
    )
    check("override with wrong PIN -> 403", mgr_ovr_wrong_pin.status_code == 403, mgr_ovr_wrong_pin.text)

    # --- 4. transaction with the token, then reuse rejected ---------------
    ok = charge(mgr_headers, override_id)
    check("charge with fresh override -> 200", ok.status_code == 200, f"{ok.status_code} {ok.text}")
    if ok.status_code == 200:
        created_txn_ids.append(ok.json()["id"])

    reuse = charge(mgr_headers, override_id)
    check("charge reusing the same override -> 403", reuse.status_code == 403, f"{reuse.status_code} {reuse.text}")

    # --- 5. audit row stamped + visible on the reservation ---------------
    ovr_row = (
        admin.table("reservation_overrides").select("*").eq("id", override_id).maybe_single().execute().data
    )
    check("override row has manager id + reason", ovr_row and ovr_row["overridden_by"] == mgr_id and ovr_row["reason"], ovr_row)
    check(
        "override row stamped with the transaction id",
        ovr_row and ovr_row["transaction_id"] == (created_txn_ids[0] if created_txn_ids else None),
        ovr_row,
    )

    confirmed_list = requests.get(
        f"{API_BASE}/reservations", params={"status": "confirmed"}, headers=mgr_headers, timeout=15
    ).json()
    mine = next((r for r in confirmed_list if r["id"] == created_reservation_id), None)
    check("reservation list surfaces the override", bool(mine and mine.get("overrides")), mine)

finally:
    print("\n=== Cleanup ===")
    for txn_id in created_txn_ids:
        requests.post(
            f"{API_BASE}/transactions/{txn_id}/void",
            headers=mgr_headers,
            json={"reason": "QA verification"},
            timeout=15,
        )
    # Cancel the test reservation so it doesn't linger as a "reserved" table
    # on the floor plan / Requests list.
    if created_reservation_id:
        from datetime import datetime, timezone
        admin.table("reservations").update(
            {"status": "cancelled", "cancelled_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", created_reservation_id).execute()
        print("cancelled the test reservation")
    admin.table("tables").update({"active": False, "pos_table_number": None}).eq("id", table["id"]).execute()
    requests.patch(f"{API_BASE}/settings/business", headers=mgr_headers, json=_sane_restore(original_settings), timeout=15)
    print("deactivated QA-POS-Block, restored business_settings")

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
if failed:
    print("FAILURES:")
    for name, _, detail in failed:
        print(f"  - {name}: {detail}")
    sys.exit(1)
print("ALL CHECKS PASSED")
