"""
End-to-end: a website reservation must relay into the staff Requests list and,
once confirmed, show the table as reserved on the Floor Plan.

  1. POST /public/reservations (what the public booking widget calls) for a
     party today, starting a few minutes ago so "now" sits in the block window.
  2. It appears in GET /reservations?status=pending&date=today  (Requests tab).
  3. POST /reservations/{id}/confirm.
  4. It appears in GET /reservations?status=confirmed&date=today with a
     table_label  (Requests tab, Confirmed filter).
  5. The Floor Plan's data: GET /pos/tables/status?table_number=<pos#> for the
     assigned table returns blocked=true with the customer, AND the confirmed
     reservation row's (table_id, date, time window) is exactly what
     FloorPlanPanel.derive() keys on to paint that table orange/"reserved".

Cleanup cancels the test reservation and restores business hours.

Run:  server on :8010, then .venv/Scripts/python.exe scripts/verify_reservation_to_floorplan.py
"""
import os
import sys
from datetime import datetime, timedelta, timezone
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
PH_OFFSET = timedelta(hours=8)
PREP_BUFFER_MIN = 15  # reservations.py RESERVATION_PREP_BUFFER_MINUTES

admin = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = ""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if detail and not ok else ""))


client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
session = client.auth.sign_in_with_password({"email": "qa.tester@oishiinori.com", "password": QA_PASSWORD})
headers = {"Authorization": f"Bearer {session.session.access_token}"}
print("logged in as qa.tester\n")

now_ph = datetime.now(timezone.utc) + PH_OFFSET
today = now_ph.date().isoformat()
start_dt = now_ph - timedelta(minutes=10)          # inside window, not yet a breach
start_time = start_dt.strftime("%H:%M:00")

original = requests.get(f"{API_BASE}/settings/business", headers=headers, timeout=15).json()
requests.patch(
    f"{API_BASE}/settings/business",
    headers=headers,
    json={"open_time": "00:00:00", "close_time": "23:59:00", "closed_weekdays": []},
    timeout=15,
).raise_for_status()

reservation_id = None
try:
    # 1. website booking -----------------------------------------------------
    booking = requests.post(
        f"{API_BASE}/public/reservations",
        json={
            "party_size": 4,
            "reservation_date": today,
            "start_time": start_time,
            "customer_name": "Website Walk-through",
            "customer_phone": "09170001122",
        },
        timeout=15,
    )
    check("website reservation accepted (200)", booking.status_code == 200, f"{booking.status_code} {booking.text}")
    res = booking.json()
    reservation_id = res["id"]
    # The public response is intentionally minimal (no table_id); read the
    # auto-assigned table from the row directly, same as staff endpoints see it.
    assigned_table_id = (
        admin.table("reservations").select("table_id").eq("id", reservation_id).single().execute().data["table_id"]
    )
    print(f"auto-assigned table_id {assigned_table_id}, reservation #{res['reservation_number']}\n")

    # 2. relays into Requests (pending) ------------------------------------
    pending = requests.get(
        f"{API_BASE}/reservations", params={"status": "pending", "date": today}, headers=headers, timeout=15
    ).json()
    row = next((r for r in pending if r["id"] == reservation_id), None)
    check("shows in Requests list as pending", row is not None, f"{len(pending)} pending rows")
    check("Requests row carries the table label", bool(row and row.get("table_label")), str(row))

    # 3 + 4. confirm, then relays into Confirmed --------------------------
    conf = requests.post(f"{API_BASE}/reservations/{reservation_id}/confirm", headers=headers, timeout=15)
    check("confirm succeeds (200)", conf.status_code == 200, f"{conf.status_code} {conf.text}")

    confirmed = requests.get(
        f"{API_BASE}/reservations", params={"status": "confirmed", "date": today}, headers=headers, timeout=15
    ).json()
    crow = next((r for r in confirmed if r["id"] == reservation_id), None)
    check("shows in Requests list as confirmed", crow is not None, f"{len(confirmed)} confirmed rows")

    # 5. Floor Plan sees it as reserved ---------------------------------
    table = admin.table("tables").select("label, pos_table_number").eq("id", assigned_table_id).single().execute().data
    check("assigned table has a POS number (floor-plan seatable)", table["pos_table_number"] is not None, str(table))

    status = requests.get(
        f"{API_BASE}/pos/tables/status",
        params={"table_number": table["pos_table_number"]},
        headers=headers,
        timeout=15,
    ).json()
    check(f"/pos/tables/status for {table['label']} -> blocked", status.get("blocked") is True, str(status))
    check(
        "status names the website customer",
        (status.get("reservation") or {}).get("customer_name") == "Website Walk-through",
        str(status),
    )

    # The exact keys FloorPlanPanel.derive() matches on:
    fp_rows = [
        r for r in confirmed
        if r["table_id"] == assigned_table_id and r["reservation_date"] == today
    ]
    in_window = False
    for r in fp_rows:
        s = datetime.strptime(r["start_time"][:5], "%H:%M")
        e = datetime.strptime(r["end_time"][:5], "%H:%M")
        cur = now_ph.replace(second=0, microsecond=0)
        s_min = s.hour * 60 + s.minute - PREP_BUFFER_MIN
        e_min = e.hour * 60 + e.minute
        cur_min = cur.hour * 60 + cur.minute
        if s_min <= cur_min < e_min:
            in_window = True
    check("floor plan would paint the table reserved right now", in_window, str(fp_rows))

finally:
    print("\n=== Cleanup ===")
    if reservation_id:
        requests.post(f"{API_BASE}/reservations/{reservation_id}/cancel", headers=headers, timeout=15)
        print("cancelled the test reservation")
    restore = {k: v for k, v in original.items() if k in ("vat_rate", "open_time", "close_time", "closed_weekdays")}
    requests.patch(f"{API_BASE}/settings/business", headers=headers, json=restore, timeout=15)
    print("restored business_settings")

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
if failed:
    print("FAILURES:")
    for n, _, d in failed:
        print(f"  - {n}: {d}")
    sys.exit(1)
print("ALL CHECKS PASSED")
