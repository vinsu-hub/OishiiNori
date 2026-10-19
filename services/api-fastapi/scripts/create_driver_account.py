"""Create the placeholder rider account the owner hands to a new driver.

The driver signs in at
    https://www.oishiinori.com/dashboard/login?login=driver@oishiinori.com
with the temporary password, then the first-login screen asks for their
name and a new password (must_change_password), after which the account is
theirs. For another driver, run again with --email driver2@oishiinori.com.

Dry run by default; --apply creates it. Skips if the email already exists.

    .venv/bin/python scripts/create_driver_account.py [--email driver@oishiinori.com] [--apply]
"""
import argparse
import os
import secrets
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

TEMP_PASSWORD = "oishiinori123"
PLACEHOLDER_NAME = "New Driver"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", default="driver@oishiinori.com")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    import bcrypt
    from app.deps import get_supabase

    supabase = get_supabase()
    email = args.email.strip().lower()
    taken = supabase.table("profiles").select("id, full_name, role").eq("email", email).execute().data
    if taken:
        print(f"{email} already exists: {taken[0]}")
        return 0
    if not args.apply:
        print(f"Would create rider {email} ({PLACEHOLDER_NAME}) with temporary password {TEMP_PASSWORD}. Re-run with --apply.")
        return 0

    created = supabase.auth.admin.create_user({"email": email, "password": TEMP_PASSWORD, "email_confirm": True})
    user_id = created.user.id
    pin = f"{secrets.randbelow(10000):04d}"
    while True:
        employee_number = f"EMP-{secrets.token_hex(2).upper()}"
        if not supabase.table("profiles").select("id").eq("employee_number", employee_number).execute().data:
            break
    supabase.table("profiles").insert({
        "id": user_id,
        "role": "rider",
        "full_name": PLACEHOLDER_NAME,
        "department": None,
        "position": "Rider",
        "pay_rate": 0,
        "employee_number": employee_number,
        "kiosk_pin_hash": bcrypt.hashpw(pin.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"),
        "email": email,
        "current_password": TEMP_PASSWORD,
        "current_pin": pin,
        "must_change_password": True,
    }).execute()
    print(f"Created rider {email} ({employee_number}). Temporary password: {TEMP_PASSWORD}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
