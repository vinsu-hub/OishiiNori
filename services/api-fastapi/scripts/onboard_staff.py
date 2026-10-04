"""
Onboard the 7-person staff roster (created by update_staff_roster.py) for
real use:

  - fixes the two login emails the old _slugify() mangled ("ñ" -> ".")
  - gives each person a unique one-time temporary password and a unique
    random 4-digit kiosk PIN (replacing the shared oishii1234 / 1234)
  - sets must_change_password, so their first dashboard login asks them to
    choose their own password (migration 0058 must be applied first)
  - writes a printable onboarding sheet (one slip per person) to --out.
    It contains live credentials: keep it out of the repo, print it, and
    delete it after handing the slips out.

Re-running with --apply generates NEW passwords/PINs (old slips stop
working), so run it once, right before onboarding.

Run with:  .venv/bin/python scripts/onboard_staff.py                       # dry run
           .venv/bin/python scripts/onboard_staff.py --apply --out /path/onboarding.html
"""
import html
import os
import sys
from pathlib import Path

import bcrypt
import requests
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

from app.routers.hr import _random_pin, _slugify, _temp_password  # noqa: E402

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SECRET_KEY"]
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
DASHBOARD_URL = "https://www.oishiinori.com/dashboard"
STAFF_CLOCK_URL = "https://www.oishiinori.com/staff-clock"

ROSTER = [
    "Normelita Entereso",
    "Mark De Leon",
    "Ruby May Garcia",
    "Niña Vanessa Centeno",
    "Gia Babierra",
    "Gabriella Kazzandra Pajares",
    "Blezzie Alcantara Pecaña",
]


def norm(name: str | None) -> str:
    return " ".join((name or "").split()).casefold()


def rest(method: str, path: str, **kwargs) -> requests.Response:
    r = requests.request(method, f"{URL}{path}", headers=HEADERS, timeout=30, **kwargs)
    r.raise_for_status()
    return r


def slip_html(p: dict) -> str:
    e = {k: html.escape(str(v)) for k, v in p.items()}
    return f"""<div class="slip">
  <div class="brand">OISHII NORI · STAFF LOGIN</div>
  <div class="name">{e['name']}</div>
  <table>
    <tr><th>Employee ID</th><td>{e['employee_number']}</td></tr>
    <tr><th>Login email</th><td>{e['email']}</td></tr>
    <tr><th>Temporary password</th><td class="secret">{e['password']}</td></tr>
    <tr><th>Time clock PIN</th><td class="secret">{e['pin']}</td></tr>
  </table>
  <ol>
    <li>Dashboard: <b>{DASHBOARD_URL}</b> &mdash; sign in with your <b>employee ID</b> (or email) and the temporary password.</li>
    <li>You'll be asked to <b>set your own password</b> right away. Don't share it.</li>
    <li>Time in / time out: <b>{STAFF_CLOCK_URL}</b> &mdash; employee ID + PIN. Keep your PIN private.</li>
  </ol>
</div>"""


def main() -> None:
    apply = "--apply" in sys.argv
    out = None
    if "--out" in sys.argv:
        out = Path(sys.argv[sys.argv.index("--out") + 1])
    if apply and out is None:
        sys.exit("--apply needs --out <path> for the onboarding sheet (keep it outside the repo).")

    try:
        rest("GET", "/rest/v1/profiles?select=must_change_password&limit=1")
    except requests.HTTPError:
        if apply:
            sys.exit("profiles.must_change_password is missing -- apply migration 0058 first.")
        print("(note: migration 0058 not applied yet -- --apply will refuse until it is)\n")

    profiles = rest("GET", "/rest/v1/profiles?select=id,full_name,employee_number,email,active,role").json()
    by_name = {norm(p["full_name"]): p for p in profiles}
    taken_pins: set[str] = set()
    slips = []

    for name in ROSTER:
        p = by_name.get(norm(name))
        if not p:
            print(f"  MISSING  {name} -- not in profiles, skipped (create them in Employees first)")
            continue
        if not p.get("active", True):
            print(f"  INACTIVE {name} -- skipped")
            continue
        want_email = f"{_slugify(name)}@oishiinori.com"
        email_change = p.get("email") != want_email
        pin = _random_pin()
        while pin in taken_pins:
            pin = _random_pin()
        taken_pins.add(pin)
        password = _temp_password()

        print(
            f"  {name:<28} {p['employee_number']}  "
            + (f"email {p.get('email')} -> {want_email}" if email_change else f"email {want_email}")
        )
        if apply:
            auth_update = {"password": password}
            if email_change:
                auth_update.update({"email": want_email, "email_confirm": True})
            rest("PUT", f"/auth/v1/admin/users/{p['id']}", json=auth_update)
            rest(
                "PATCH",
                f"/rest/v1/profiles?id=eq.{p['id']}",
                json={
                    "email": want_email,
                    "current_password": password,
                    "current_pin": pin,
                    "kiosk_pin_hash": bcrypt.hashpw(pin.encode(), bcrypt.gensalt()).decode(),
                    "must_change_password": True,
                },
            )
        slips.append(
            {"name": name, "employee_number": p["employee_number"], "email": want_email, "password": password, "pin": pin}
        )

    if not apply:
        print("\nDry run only -- nothing changed. Re-run with --apply --out <path>.")
        return

    css = """
      @page { size: A4; margin: 12mm; }
      body { font-family: Arial, sans-serif; color: #000; margin: 0; }
      .slip { border: 1px dashed #888; border-radius: 3mm; padding: 5mm 6mm; margin-bottom: 6mm; break-inside: avoid; page-break-inside: avoid; }
      .brand { font-size: 9pt; letter-spacing: .15em; font-weight: 700; color: #555; }
      .name { font-size: 16pt; font-weight: 800; margin: 1mm 0 3mm; }
      table { border-collapse: collapse; font-size: 11pt; margin-bottom: 2mm; }
      th { text-align: left; font-weight: 600; padding: 1mm 6mm 1mm 0; color: #333; }
      td { font-family: 'Courier New', monospace; font-size: 12pt; }
      td.secret { font-weight: 700; font-size: 13pt; }
      ol { font-size: 9.5pt; margin: 0; padding-left: 5mm; }
    """
    out.write_text(
        f"<!doctype html><html><head><meta charset='utf-8'><title>Oishii Nori staff onboarding</title>"
        f"<style>{css}</style></head><body>{''.join(slip_html(s) for s in slips)}</body></html>",
        encoding="utf-8",
    )
    print(f"\nApplied to {len(slips)} employees. Onboarding sheet: {out}")
    print("It contains live passwords and PINs -- print it, hand out the slips, then delete the file.")


if __name__ == "__main__":
    main()
