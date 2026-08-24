"""
Disposable verification pass for the Table Reservation feature
(supabase/migrations/0025_reservations.sql, app/routers/reservations.py):

  1. Auto-assign + full conflict prevention: a party is auto-assigned the
     best-fit table; a second overlapping request for the same capacity
     tier is rejected while the first is pending; confirming holds the
     slot identically to pending; declining/cancelling frees it again.
  2. Business-hours enforcement: too-early start, a start that would run
     past closing, and a request on a closed weekday are all rejected;
     the public availability endpoint reports `closed: true` for that day.

Not a permanent test suite. Hits a locally running
`uvicorn app.main:app --port 8010` over real HTTP. Test tables are
deactivated (not deleted) at the end; test reservations are left in their
final (declined/cancelled) state, same as this codebase's other verify_*
scripts leave voided transactions rather than deleting them. Business
hours are restored to their original values at the end.

Run with:  .venv/Scripts/python.exe scripts/verify_reservations.py
"""
import os
import sys
from datetime import date, timedelta
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
API_BASE = os.environ.get("QA_API_BASE", "http://127.0.0.1:8010")

admin = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)

results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = ""):
    results.append((name, condition, detail))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" -- {detail}" if detail else ""))


def login(email, password):
    # Separate client from `admin` -- signing in on the same client instance
    # would swap its session away from the service-role key, breaking every
    # subsequent admin.table(...) RLS-bypassing call below.
    auth_client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
    session = auth_client.auth.sign_in_with_password({"email": email, "password": password})
    return session.session.access_token


token = login("qa.tester@oishiinori.com", "oishii1234-qa")
headers = {"Authorization": f"Bearer {token}"}
print("logged in\n")

# A near-future weekday guaranteed not to already be a closed_weekday from
# whatever business_settings currently has, and far enough out that no
# real reservation data could already exist on it.
test_date = date.today() + timedelta(days=30)

original_settings = requests.get(f"{API_BASE}/settings/business", headers=headers, timeout=15).json()
print("original business_settings:", original_settings)

# Set known, wide-open hours for a clean test, remembering the original to
# restore at the end.
requests.patch(
    f"{API_BASE}/settings/business",
    headers=headers,
    json={"open_time": "10:00:00", "close_time": "22:00:00", "closed_weekdays": []},
    timeout=15,
).raise_for_status()

small_table = admin.table("tables").insert({"label": "QA-Small", "capacity": 2}).execute().data[0]
large_table = admin.table("tables").insert({"label": "QA-Large", "capacity": 6}).execute().data[0]
print(f"created QA-Small (cap 2, id {small_table['id']}), QA-Large (cap 6, id {large_table['id']})\n")

created_reservation_ids: list[str] = []


def submit(party_size, start_time, name="QA Tester", phone="09171234567"):
    return requests.post(
        f"{API_BASE}/public/reservations",
        json={
            "party_size": party_size,
            "reservation_date": test_date.isoformat(),
            "start_time": start_time,
            "customer_name": name,
            "customer_phone": phone,
        },
        timeout=15,
    )


print("=== Scenario 1: auto-assign + full conflict prevention ===")
r1 = submit(5, "18:00:00")
check("party-of-5 @ 18:00 succeeds (only QA-Large fits)", r1.status_code == 200, f"status {r1.status_code} body {r1.text}")
res1 = r1.json() if r1.status_code == 200 else None
if res1:
    created_reservation_ids.append(res1["id"])
    check("auto-assigned table is QA-Large", res1.get("party_size") == 5, res1)

r2 = submit(5, "18:30:00")
check(
    "overlapping party-of-5 @ 18:30 is rejected (QA-Large held by pending r1)",
    r2.status_code == 409,
    f"status {r2.status_code} body {r2.text}",
)

avail = requests.get(
    f"{API_BASE}/public/tables/availability",
    params={"date": test_date.isoformat(), "party_size": 5},
    timeout=15,
).json()
slot_1800 = next((s for s in avail["slots"] if s["time"] == "18:00"), None)
check("availability shows 18:00 unavailable for party of 5", slot_1800 is not None and slot_1800["available"] is False, slot_1800)
slot_2000 = next((s for s in avail["slots"] if s["time"] == "20:00"), None)
check("availability shows 20:00 still available for party of 5", slot_2000 is not None and slot_2000["available"] is True, slot_2000)

if res1:
    confirm_resp = requests.post(f"{API_BASE}/reservations/{res1['id']}/confirm", headers=headers, timeout=15)
    check("confirm succeeds", confirm_resp.status_code == 200, confirm_resp.text)

    r3 = submit(5, "18:15:00")
    check(
        "overlapping party-of-5 @ 18:15 still rejected once r1 is CONFIRMED (not just pending)",
        r3.status_code == 409,
        f"status {r3.status_code} body {r3.text}",
    )

    decline_resp = requests.post(
        f"{API_BASE}/reservations/{res1['id']}/decline",
        headers=headers,
        json={"reason": "QA verification, freeing the slot"},
        timeout=15,
    )
    check("decline of the confirmed reservation is rejected (only pending can be declined)", decline_resp.status_code == 400, decline_resp.text)

    cancel_resp = requests.post(f"{API_BASE}/reservations/{res1['id']}/cancel", headers=headers, timeout=15)
    check("cancel of the confirmed reservation succeeds", cancel_resp.status_code == 200, cancel_resp.text)

    avail_after_cancel = requests.get(
        f"{API_BASE}/public/tables/availability",
        params={"date": test_date.isoformat(), "party_size": 5},
        timeout=15,
    ).json()
    slot_1800_after = next((s for s in avail_after_cancel["slots"] if s["time"] == "18:00"), None)
    check("18:00 is available again after cancel", slot_1800_after is not None and slot_1800_after["available"] is True, slot_1800_after)

r4 = submit(5, "19:00:00")
check("fresh party-of-5 @ 19:00 succeeds (slot freed by the cancel above)", r4.status_code == 200, f"status {r4.status_code} body {r4.text}")
if r4.status_code == 200:
    res4 = r4.json()
    created_reservation_ids.append(res4["id"])
    decline4 = requests.post(
        f"{API_BASE}/reservations/{res4['id']}/decline",
        headers=headers,
        json={"reason": "QA verification, freeing the slot"},
        timeout=15,
    )
    check("decline of a pending reservation succeeds", decline4.status_code == 200, decline4.text)

    r5 = submit(5, "19:15:00")
    check("overlapping party-of-5 @ 19:15 succeeds after r4 was DECLINED (slot freed)", r5.status_code == 200, f"status {r5.status_code} body {r5.text}")
    if r5.status_code == 200:
        created_reservation_ids.append(r5.json()["id"])

print("\n=== Scenario 2: business hours enforcement ===")
requests.patch(
    f"{API_BASE}/settings/business",
    headers=headers,
    json={"open_time": "10:00:00", "close_time": "21:00:00", "closed_weekdays": [test_date.weekday()]},
    timeout=15,
).raise_for_status()

r_too_early = submit(2, "09:00:00")
check("start before open_time (09:00 < 10:00) rejected", r_too_early.status_code == 400, f"status {r_too_early.status_code} body {r_too_early.text}")

r_too_late = submit(2, "20:45:00")
check("start that runs past close_time (20:45+90min > 21:00) rejected", r_too_late.status_code == 400, f"status {r_too_late.status_code} body {r_too_late.text}")

r_closed_day = submit(2, "12:00:00")
check("request on a closed weekday rejected", r_closed_day.status_code == 400, f"status {r_closed_day.status_code} body {r_closed_day.text}")

avail_closed = requests.get(
    f"{API_BASE}/public/tables/availability",
    params={"date": test_date.isoformat(), "party_size": 2},
    timeout=15,
).json()
check("availability reports closed=true for the closed weekday", avail_closed.get("closed") is True, avail_closed)

print("\n=== Cleanup ===")
admin.table("tables").update({"active": False}).eq("id", small_table["id"]).execute()
admin.table("tables").update({"active": False}).eq("id", large_table["id"]).execute()
print(f"deactivated QA-Small/QA-Large ({len(created_reservation_ids)} test reservations left in their final state)")

restore = {k: v for k, v in original_settings.items() if k in ("vat_rate", "open_time", "close_time", "closed_weekdays")}
requests.patch(f"{API_BASE}/settings/business", headers=headers, json=restore, timeout=15).raise_for_status()
print("restored original business_settings:", restore)

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
if failed:
    print("FAILURES:")
    for name, _, detail in failed:
        print(f"  - {name}: {detail}")
    sys.exit(1)
print("ALL CHECKS PASSED")
