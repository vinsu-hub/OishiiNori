"""
Replace the demo staff list with the real 7-person roster.

Creates each person through the real POST /employees flow (auth user, default
password, kiosk PIN, EMP-xxxx number) as role=employee with no department /
position / pay rate yet, and deactivates (PATCH active=false, never deletes)
the leftover demo staff. Admin/QA/Cashier/Rider system accounts are untouched.

Idempotent: a roster name that already exists (case-insensitive) is skipped.
Dry-run by default; pass --apply to write. Needs a local
`uvicorn app.main:app --port 8000` (or QA_API_BASE) -- dev and prod share one
Supabase project, so this changes the real staff list.

Run with:  python scripts/update_staff_roster.py [--apply]
"""
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

API_BASE = os.environ.get("QA_API_BASE", "http://localhost:8000")
QA_EMAIL = "qa.tester@oishiinori.com"
QA_PASSWORD = "oishii1234-qa"

ROSTER = [
    "Normelita Entereso",
    "Mark De Leon",
    "Ruby May Garcia",
    "Niña Vanessa Centeno",
    "Gia Babierra",
    "Gabriella Kazzandra Pajares",
    "Blezzie Alcantara Pecaña",
]

DEMO_STAFF = [
    "Ana Reyes",
    "Juan Dela Cruz",
    "Liza Fernandez",
    "Maria Santos",
    "Mark Villanueva",
    "Rico Bautista",
    "Jhon Doe",
]


def norm(name: str | None) -> str:
    return " ".join((name or "").split()).casefold()


def main() -> None:
    apply = "--apply" in sys.argv
    auth_client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    token = auth_client.auth.sign_in_with_password({"email": QA_EMAIL, "password": QA_PASSWORD}).session.access_token
    headers = {"Authorization": f"Bearer {token}"}

    resp = requests.get(f"{API_BASE}/employees", headers=headers, timeout=30)
    resp.raise_for_status()
    existing = resp.json()
    by_name = {norm(e["full_name"]): e for e in existing}

    print(f"{'APPLY' if apply else 'DRY RUN'} against {API_BASE}\n")

    created = []
    for name in ROSTER:
        if norm(name) in by_name:
            print(f"  keep    {name} (already exists)")
            continue
        print(f"  create  {name}")
        if apply:
            r = requests.post(
                f"{API_BASE}/employees",
                headers=headers,
                json={"full_name": name, "role": "employee", "pay_rate": 0},
                timeout=30,
            )
            r.raise_for_status()
            created.append(r.json())

    roster_keys = {norm(n) for n in ROSTER}
    for name in DEMO_STAFF:
        emp = by_name.get(norm(name))
        if not emp or norm(name) in roster_keys:
            print(f"  skip    {name} (not found)")
            continue
        if emp.get("active") is False:
            print(f"  skip    {name} (already inactive)")
            continue
        print(f"  disable {name}")
        if apply:
            r = requests.patch(f"{API_BASE}/employees/{emp['id']}", headers=headers, json={"active": False}, timeout=30)
            r.raise_for_status()

    if created:
        print("\nNew staff credentials (hand these off; passwords are defaults):")
        for c in created:
            print(f"  {c['full_name']:<32} {c['employee_number']}  login={c['email']}  password={c['default_password']}  pin={c['default_pin']}")
    elif not apply:
        print("\nDry run only -- re-run with --apply to write.")


if __name__ == "__main__":
    main()
