"""Smoke test: reservation seat-tracking + Floor Plan data, against prod API.
Creates one test reservation for today, confirms/seats/unseats it, then cancels
it for cleanup. Read-only checks first."""
import os, sys, datetime
from pathlib import Path
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")
SUPABASE_URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SECRET_KEY"]
API = os.environ.get("QA_API_BASE", "https://oishii-nori-api.vercel.app")

def login(email, pw):
    r = requests.post(f"{SUPABASE_URL}/auth/v1/token", params={"grant_type": "password"},
                      headers={"apikey": KEY, "Content-Type": "application/json"},
                      json={"email": email, "password": pw}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]

ok = True
def check(name, cond, detail=""):
    global ok
    ok = ok and cond
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))

tok = login("qa.tester@oishiinori.com", "oishii1234-qa")
H = {"Authorization": f"Bearer {tok}"}
today = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).date().isoformat()

# 1. list reservations for today carries the new fields
r = requests.get(f"{API}/reservations", params={"date": today}, headers=H, timeout=30)
check("GET /reservations?date=today -> 200", r.status_code == 200, f"{r.status_code}")
rows = r.json() if r.status_code == 200 else []
if rows:
    check("reservation objects expose seated_at + transaction_id",
          "seated_at" in rows[0] and "transaction_id" in rows[0], str(list(rows[0].keys())))
else:
    # verify via schema on an availability probe instead
    print("  (no reservations today yet -- field check deferred to created row)")

# 2. find an available slot today
av = requests.get(f"{API}/public/tables/availability", params={"date": today, "party_size": 2}, timeout=30)
check("GET availability -> 200", av.status_code == 200, f"{av.status_code}")
slots = [s for s in av.json().get("slots", []) if s["available"]] if av.status_code == 200 else []
if not slots:
    print("  no available slot today -- skipping write path (closed day or full).")
    sys.exit(0 if ok else 1)

slot = slots[len(slots)//2]["time"]
mk = requests.post(f"{API}/public/reservations", json={
    "party_size": 2, "reservation_date": today, "start_time": slot,
    "customer_name": "SMOKE TEST (safe to cancel)", "customer_phone": "0000000000"}, timeout=30)
check("POST /public/reservations -> 200", mk.status_code == 200, f"{mk.status_code} {mk.text[:200]}")
if mk.status_code != 200:
    sys.exit(1)
rid = mk.json()["id"]
print(f"  created reservation {rid} @ {slot}")

try:
    c = requests.post(f"{API}/reservations/{rid}/confirm", headers=H, timeout=30)
    check("confirm -> 200", c.status_code == 200, f"{c.status_code}")
    body = c.json()
    check("confirmed row has seated_at + transaction_id keys",
          "seated_at" in body and "transaction_id" in body, str(list(body.keys())))
    check("seated_at is null pre-seat", body.get("seated_at") is None, repr(body.get("seated_at")))

    s = requests.post(f"{API}/reservations/{rid}/seat", headers=H, timeout=30)
    check("seat -> 200", s.status_code == 200, f"{s.status_code} {s.text[:200]}")
    check("seated_at set after seat", s.json().get("seated_at") is not None, repr(s.json().get("seated_at")))

    u = requests.post(f"{API}/reservations/{rid}/unseat", headers=H, timeout=30)
    check("unseat -> 200", u.status_code == 200, f"{u.status_code} {u.text[:200]}")
    check("seated_at cleared after unseat", u.json().get("seated_at") is None, repr(u.json().get("seated_at")))
finally:
    x = requests.post(f"{API}/reservations/{rid}/cancel", headers=H, timeout=30)
    print(f"  cleanup cancel -> {x.status_code}")

print("\n" + ("ALL PASS" if ok else "SOME FAILED"))
sys.exit(0 if ok else 1)
