"""
Disposable verification script for the Ingredient Stock automation change
(0030): confirms recipe-driven sale deduction now logs a real
sale_consumption/sale_consumption_reversal audit trail, GET
/inventory/count-entries computes New Stocks/Beginning/Usage/Ending
correctly, and POST /inventory/{id}/field-override writes an audited
correction. Same style/conventions as system_health_check.py -- not a
permanent test suite, no pytest, no CI wiring.

Run with:  py -3 services/api-fastapi/scripts/verify_ingredient_stock_automation.py
Requires QA_API_BASE env var (defaults to http://localhost:8000) pointing at
a running dev backend with migration 0030 applied.
"""
import os
import sys
from datetime import date
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client

sys.stdout.reconfigure(encoding="utf-8")

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
API_BASE = os.environ.get("QA_API_BASE", "http://localhost:8000")
QA_PASSWORD = "oishii1234-qa"

results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = ""):
    results.append((name, condition, detail))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" -- {detail}" if detail and not condition else ""))


def login(email: str, password: str) -> str | None:
    auth_client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
    session = auth_client.auth.sign_in_with_password({"email": email, "password": password})
    return session.session.access_token, session.session.user.id


token, exec_id = login("qa.tester@oishiinori.com", QA_PASSWORD)
headers = {"Authorization": f"Bearer {token}"}
check("logged in as qa.tester (executive)", bool(token))

# --- find a sellable, non-bundle product with a real recipe -----------------
products_r = requests.get(f"{API_BASE}/products?active_only=true", headers=headers)
target_size = None
for p in products_r.json() if products_r.status_code == 200 else []:
    if p["is_bundle"] or not p["sizes"]:
        continue
    recipe_r = requests.get(f"{API_BASE}/product-sizes/{p['sizes'][0]['id']}/recipe", headers=headers)
    if recipe_r.status_code == 200 and recipe_r.json():
        target_size = p["sizes"][0]
        recipe = recipe_r.json()
        break
check("found a sellable product with a real recipe", target_size is not None)
if not target_size:
    sys.exit(1)

ingredient_ids = [r["ingredient_id"] for r in recipe]
print(f"  target: product_size={target_size['id']} ingredients={ingredient_ids}")

# Make sure every recipe ingredient has plenty of stock so the sale doesn't
# go negative (mirrors system_health_check.py's own pattern).
for iid in ingredient_ids:
    requests.post(f"{API_BASE}/inventory/{iid}/count", json={"employee_id": exec_id, "counted_stock": 100000}, headers=headers)

# --- baseline: no sale_consumption movements from THIS test yet -------------
def movements_for(ingredient_id: str, mtype: str) -> list[dict]:
    r = requests.get(
        f"{API_BASE}/inventory-movements",
        params={"ingredient_id": ingredient_id, "type": mtype, "limit": 50},
        headers=headers,
    )
    return r.json() if r.status_code == 200 else []


before_counts = {iid: len(movements_for(iid, "sale_consumption")) for iid in ingredient_ids}

# --- place a real sale --------------------------------------------------
sale_r = requests.post(
    f"{API_BASE}/transactions",
    json={
        "employee_id": exec_id,
        "items": [{"product_size_id": target_size["id"], "quantity": 1}],
        "payment_method": "cash",
    },
    headers=headers,
)
check("POST /transactions -> 200", sale_r.status_code == 200, sale_r.text)
if sale_r.status_code != 200:
    sys.exit(1)
tx_id = sale_r.json()["id"]

# --- 1. sale_consumption movements now exist (the core bug fix) -------------
after_sale_counts = {iid: len(movements_for(iid, "sale_consumption")) for iid in ingredient_ids}
new_movements_logged = all(after_sale_counts[iid] == before_counts[iid] + 1 for iid in ingredient_ids)
check(
    "sale_consumption movement logged for every recipe ingredient (was: none, ever)",
    new_movements_logged,
    str({iid: (before_counts[iid], after_sale_counts[iid]) for iid in ingredient_ids}),
)

for iid in ingredient_ids:
    moves = movements_for(iid, "sale_consumption")
    if moves:
        reason_ok = f"transaction {tx_id}" in (moves[0].get("reason") or "")
        check(f"sale_consumption reason references transaction id ({iid[:8]})", reason_ok, moves[0].get("reason"))

# --- 2. GET /inventory/count-entries reflects today's Usage -----------------
entries_r = requests.get(f"{API_BASE}/inventory/count-entries", headers=headers)
check("GET /inventory/count-entries -> 200", entries_r.status_code == 200, entries_r.text)
entries_by_id = {e["ingredient_id"]: e for e in entries_r.json()} if entries_r.status_code == 200 else {}
check(
    "count-entries covers every recipe ingredient sold",
    all(iid in entries_by_id for iid in ingredient_ids),
)
for iid in ingredient_ids:
    entry = entries_by_id.get(iid)
    if entry:
        check(
            f"Usage > 0 after a real sale ({iid[:8]})",
            entry["usage"] > 0,
            f"usage={entry['usage']}",
        )
        check(
            f"Beginning + New Stocks - Usage == Ending ({iid[:8]})",
            abs((entry["beginning"] + entry["new_stocks"] - entry["usage"]) - entry["ending"]) < 0.001,
            str(entry),
        )

# --- 3. void reverses it (sale_consumption_reversal) -------------------------
void_r = requests.post(f"{API_BASE}/transactions/{tx_id}/void", json={"reason": "verification script cleanup"}, headers=headers)
check("POST /transactions/{id}/void -> 200", void_r.status_code == 200, void_r.text)

reversal_counts = {iid: len(movements_for(iid, "sale_consumption_reversal")) for iid in ingredient_ids}
check(
    "sale_consumption_reversal movement logged for every ingredient on void",
    all(c >= 1 for c in reversal_counts.values()),
    str(reversal_counts),
)

entries_after_void_r = requests.get(f"{API_BASE}/inventory/count-entries", headers=headers)
entries_after_void = {e["ingredient_id"]: e for e in entries_after_void_r.json()} if entries_after_void_r.status_code == 200 else {}
for iid in ingredient_ids:
    entry = entries_after_void.get(iid)
    if entry:
        check(
            f"Usage nets back toward zero after void ({iid[:8]})",
            entry["usage"] <= 0.001,
            f"usage={entry['usage']}",
        )

# --- 4. field-override: flag Ending with a reason, confirm audit trail ------
test_ingredient_id = ingredient_ids[0]
before_r = requests.get(f"{API_BASE}/inventory/{test_ingredient_id}", headers=headers)
before_stock = before_r.json()["current_stock"] if before_r.status_code == 200 else None

override_r = requests.post(
    f"{API_BASE}/inventory/{test_ingredient_id}/field-override",
    json={
        "field": "ending",
        "corrected_value": (before_stock or 0) + 7,
        "reason": "verification script: simulated physical recount",
        "employee_id": exec_id,
    },
    headers=headers,
)
check("POST /inventory/{id}/field-override -> 200", override_r.status_code == 200, override_r.text)
if override_r.status_code == 200:
    body = override_r.json()
    check("override response reflects corrected Ending", body["ending"] == (before_stock or 0) + 7, str(body))
    check("override response marks the field as overridden", "ending" in body["overrides"], str(body["overrides"]))

# missing-reason should 422 (pydantic min_length=1), and wrong employee_id should 403
no_reason_r = requests.post(
    f"{API_BASE}/inventory/{test_ingredient_id}/field-override",
    json={"field": "ending", "corrected_value": 1, "reason": "", "employee_id": exec_id},
    headers=headers,
)
check("field-override rejects an empty reason", no_reason_r.status_code == 422, no_reason_r.text)

wrong_employee_r = requests.post(
    f"{API_BASE}/inventory/{test_ingredient_id}/field-override",
    json={"field": "ending", "corrected_value": 1, "reason": "x", "employee_id": "00000000-0000-0000-0000-000000000000"},
    headers=headers,
)
check("field-override 403s when employee_id != caller", wrong_employee_r.status_code == 403, wrong_employee_r.text)

# revert the test correction back to the pre-test value
if before_stock is not None:
    requests.post(
        f"{API_BASE}/inventory/{test_ingredient_id}/field-override",
        json={
            "field": "ending",
            "corrected_value": before_stock,
            "reason": "verification script: revert test correction",
            "employee_id": exec_id,
        },
        headers=headers,
    )

# --- cleanup: reset the recipe ingredients' stock back to something sane ----
for iid in ingredient_ids:
    requests.post(f"{API_BASE}/inventory/{iid}/count", json={"employee_id": exec_id, "counted_stock": 100000}, headers=headers)

print("\n--- Summary ---")
passed = sum(1 for _, ok, _ in results if ok)
print(f"{passed}/{len(results)} checks passed")
if passed != len(results):
    sys.exit(1)
