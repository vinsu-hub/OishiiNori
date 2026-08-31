"""
Disposable verification pass for the "Smarter, Less-Manual Inventory
Tracking" plan (2026-08-23/24 session):

  1. held_ingredients is now excluded from automatic stock deduction, both
     on a POS sale + void and on a digital/QR order approval (shared
     `_create_transaction_row` code path).
  2. Stock Count rejects direct writes to new_stocks/ending for a stock
     item linked to a recipe ingredient (Inventory Count/Receive Shipment
     own that field exclusively now); beginning/notes/needs_verification
     still save for a linked item.
  3. The Kitchen Display "Log extra usage" shortcut is a thin wrapper over
     POST /loss-records -- verifies that underlying call still behaves
     (stock deducts, record shows the right reason) with no new backend
     surface to test.

Not a permanent test suite. Hits a locally running
`uvicorn app.main:app --port 8000` over real HTTP, same QA-user pattern as
scripts/qa_phase2.py. All ingredient stock this script stages is restored
to its pre-test value at the end; test transactions are voided, not
deleted.

Run with:  py -3 services/api-fastapi/scripts/verify_smart_inventory.py
"""
import os
import sys
import uuid
from pathlib import Path

import bcrypt
import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
API_BASE = os.environ.get("QA_API_BASE", "http://localhost:8000")

QA_PASSWORD = "oishii1234-qa"
QA_PIN = "4321"
QA_PIN_HASH = bcrypt.hashpw(QA_PIN.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

admin = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)

results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = ""):
    results.append((name, condition, detail))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" -- {detail}" if detail and not condition else ""))


stock_reset: dict[str, float] = {}


def stage_stock(ingredient_id: str, amount: float, employee_id: str, headers: dict):
    if ingredient_id not in stock_reset:
        r = requests.get(f"{API_BASE}/inventory/{ingredient_id}", headers=headers)
        stock_reset[ingredient_id] = r.json()["current_stock"] if r.status_code == 200 else 0
    requests.post(
        f"{API_BASE}/inventory/{ingredient_id}/count",
        json={"employee_id": employee_id, "counted_stock": amount},
        headers=headers,
    )


def current_stock(ingredient_id: str, headers: dict) -> float:
    r = requests.get(f"{API_BASE}/inventory/{ingredient_id}", headers=headers)
    return float(r.json()["current_stock"])


def ensure_qa_user(email: str, employee_number: str, role: str) -> tuple[str, str]:
    existing = admin.table("profiles").select("id").eq("employee_number", employee_number).maybe_single().execute()
    if existing and existing.data:
        user_id = existing.data["id"]
    else:
        users = admin.auth.admin.list_users()
        found = next((u for u in users if u.email == email), None)
        if found:
            user_id = found.id
        else:
            created = admin.auth.admin.create_user(
                {"email": email, "password": QA_PASSWORD, "email_confirm": True}
            )
            user_id = created.user.id
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


def main():
    print(f"== Smart Inventory Tracking verification -- API base: {API_BASE} ==\n")

    try:
        health = requests.get(f"{API_BASE}/health", timeout=5)
    except requests.exceptions.ConnectionError:
        print(f"Cannot reach {API_BASE} -- is `uvicorn app.main:app --port 8000` running? Aborting.")
        sys.exit(1)
    check("GET /health returns 200", health.status_code == 200)

    exec_id, exec_token = ensure_qa_user("qa.tester@oishiinori.com", "QA-EXEC", "executive")
    emp_id, emp_token = ensure_qa_user("qa.employee@oishiinori.com", "QA-EMP", "employee")
    exec_headers = {"Authorization": f"Bearer {exec_token}"}
    emp_headers = {"Authorization": f"Bearer {emp_token}"}
    print(f"QA users ready: executive={exec_id}, employee={emp_id}\n")

    voided_transaction_ids = []

    # -----------------------------------------------------------------
    # Part 1a: held_ingredients excluded from deduction -- POS sale + void
    # -----------------------------------------------------------------
    print("-- Part 1a: held-ingredient deduction fix (POS sale) --")

    products = requests.get(f"{API_BASE}/products?active_only=true", headers=exec_headers).json()
    target_size = None
    target_recipe = None
    for p in products:
        if p["is_bundle"] or not p["sizes"]:
            continue
        for size in p["sizes"]:
            recipe = requests.get(f"{API_BASE}/product-sizes/{size['id']}/recipe", headers=exec_headers).json()
            if len(recipe) >= 2:
                target_size = size
                target_recipe = recipe
                break
        if target_size:
            break
    check("Found a non-bundle product_size with >=2 recipe ingredients", target_size is not None)

    if target_size:
        for item in target_recipe:
            stage_stock(item["ingredient_id"], 1000, exec_id, exec_headers)

        held_item = target_recipe[0]
        other_items = target_recipe[1:]
        held_name = held_item["ingredient_name"]

        before = {item["ingredient_id"]: current_stock(item["ingredient_id"], exec_headers) for item in target_recipe}

        r = requests.post(
            f"{API_BASE}/transactions",
            json={
                "employee_id": exec_id,
                "items": [
                    {
                        "product_size_id": target_size["id"],
                        "quantity": 1,
                        "held_ingredients": [held_name],
                    }
                ],
                "payment_method": "cash",
            },
            headers=exec_headers,
        )
        check("POST /transactions with held_ingredients -> 200", r.status_code == 200, r.text)
        txn = r.json() if r.status_code == 200 else None

        if txn:
            voided_transaction_ids.append(txn["id"])
            after_sale = {item["ingredient_id"]: current_stock(item["ingredient_id"], exec_headers) for item in target_recipe}

            check(
                f"Held ingredient '{held_name}' untouched by the sale",
                after_sale[held_item["ingredient_id"]] == before[held_item["ingredient_id"]],
                f"before={before[held_item['ingredient_id']]}, after={after_sale[held_item['ingredient_id']]}",
            )
            for item in other_items:
                expected = before[item["ingredient_id"]] - item["qty_per_serving"]
                check(
                    f"Non-held ingredient '{item['ingredient_name']}' deducted by qty_per_serving",
                    abs(after_sale[item["ingredient_id"]] - expected) < 1e-6,
                    f"before={before[item['ingredient_id']]}, after={after_sale[item['ingredient_id']]}, expected={expected}",
                )

            # Void -- symmetric restore: held ingredient stays untouched,
            # everything else restores exactly to its pre-sale value.
            r = requests.post(
                f"{API_BASE}/transactions/{txn['id']}/void",
                json={"reason": "verification run"},
                headers=exec_headers,
            )
            check("POST /transactions/{id}/void -> 200", r.status_code == 200, r.text)
            voided_transaction_ids.remove(txn["id"])  # already voided

            after_void = {item["ingredient_id"]: current_stock(item["ingredient_id"], exec_headers) for item in target_recipe}
            check(
                f"Held ingredient '{held_name}' still untouched after void",
                after_void[held_item["ingredient_id"]] == before[held_item["ingredient_id"]],
                f"before={before[held_item['ingredient_id']]}, after_void={after_void[held_item['ingredient_id']]}",
            )
            for item in other_items:
                check(
                    f"Non-held ingredient '{item['ingredient_name']}' restored to pre-sale value after void",
                    abs(after_void[item["ingredient_id"]] - before[item["ingredient_id"]]) < 1e-6,
                    f"before={before[item['ingredient_id']]}, after_void={after_void[item['ingredient_id']]}",
                )

    # -----------------------------------------------------------------
    # Part 1b: held_ingredients excluded from deduction -- digital order
    # -----------------------------------------------------------------
    print("\n-- Part 1b: held-ingredient deduction fix (digital/QR order) --")

    if target_size:
        before = {item["ingredient_id"]: current_stock(item["ingredient_id"], exec_headers) for item in target_recipe}

        r = requests.post(
            f"{API_BASE}/public/orders",
            json={
                "table_number": 1,
                "items": [
                    {
                        "product_size_id": target_size["id"],
                        "quantity": 1,
                        "held_ingredients": [held_name],
                    }
                ],
                "payment_method": "cash",
            },
        )
        check("POST /public/orders with held_ingredients -> 200", r.status_code == 200, r.text)
        order = r.json() if r.status_code == 200 else None

        if order:
            r = requests.post(f"{API_BASE}/digital-orders/{order['id']}/approve", headers=exec_headers)
            check("POST /digital-orders/{id}/approve -> 200", r.status_code == 200, r.text)
            approved = r.json() if r.status_code == 200 else None

            if approved and approved.get("transaction_id"):
                voided_transaction_ids.append(approved["transaction_id"])
                after_sale = {item["ingredient_id"]: current_stock(item["ingredient_id"], exec_headers) for item in target_recipe}
                check(
                    f"Digital order: held ingredient '{held_name}' untouched",
                    after_sale[held_item["ingredient_id"]] == before[held_item["ingredient_id"]],
                    f"before={before[held_item['ingredient_id']]}, after={after_sale[held_item['ingredient_id']]}",
                )
                for item in other_items:
                    expected = before[item["ingredient_id"]] - item["qty_per_serving"]
                    check(
                        f"Digital order: non-held ingredient '{item['ingredient_name']}' deducted",
                        abs(after_sale[item["ingredient_id"]] - expected) < 1e-6,
                        f"before={before[item['ingredient_id']]}, after={after_sale[item['ingredient_id']]}, expected={expected}",
                    )

    # -----------------------------------------------------------------
    # Part 2: Stock Count read-only guard for linked ingredients
    # -----------------------------------------------------------------
    print("\n-- Part 2: Stock Count linked-ingredient guard --")

    stock_items = requests.get(f"{API_BASE}/stock-items", headers=exec_headers).json()
    linked_item = next((i for i in stock_items if i.get("ingredient_id")), None)
    check("Found a stock item linked to a recipe ingredient", linked_item is not None)

    if linked_item:
        r = requests.post(
            f"{API_BASE}/stock-items/{linked_item['id']}/count-entries",
            json={"recorded_by": exec_id, "new_stocks": 5},
            headers=exec_headers,
        )
        check("POST count-entries with new_stocks on linked item -> 400", r.status_code == 400, r.text)

        r = requests.post(
            f"{API_BASE}/stock-items/{linked_item['id']}/count-entries",
            json={"recorded_by": exec_id, "ending": 5},
            headers=exec_headers,
        )
        check("POST count-entries with ending on linked item -> 400", r.status_code == 400, r.text)

        r = requests.post(
            f"{API_BASE}/stock-items/{linked_item['id']}/count-entries",
            json={
                "recorded_by": exec_id,
                "beginning": 3,
                "notes": "verification run",
                "needs_verification": True,
            },
            headers=exec_headers,
        )
        check(
            "POST count-entries with beginning/notes/needs_verification on linked item -> 200",
            r.status_code == 200,
            r.text,
        )
        if r.status_code == 200:
            body = r.json()
            check(
                "Linked item's current_stock unchanged by the informational-only entry",
                body["stock_item"]["ingredient_current_stock"] == linked_item["ingredient_current_stock"],
                f"before={linked_item['ingredient_current_stock']}, after={body['stock_item']['ingredient_current_stock']}",
            )
    else:
        print("(no linked stock item found in this environment -- skipping Part 2 body checks)")

    # -----------------------------------------------------------------
    # Part 3: Kitchen Display "Log extra usage" -> POST /loss-records
    # -----------------------------------------------------------------
    print("\n-- Part 3: Log Extra Usage (Loss Log wrapper) --")

    if target_size and target_recipe:
        extra_item = target_recipe[0]
        before_extra = current_stock(extra_item["ingredient_id"], exec_headers)

        r = requests.post(
            f"{API_BASE}/loss-records",
            json={
                "ingredient_id": extra_item["ingredient_id"],
                "employee_id": emp_id,
                "reason": "prep_error",
                "quantity": 1,
            },
            headers=emp_headers,
        )
        check("POST /loss-records (extra usage, prep_error) -> 200", r.status_code == 200, r.text)
        record = r.json() if r.status_code == 200 else None

        if record:
            check("Loss record reason == prep_error", record["reason"] == "prep_error", record.get("reason"))
            after_extra = current_stock(extra_item["ingredient_id"], exec_headers)
            expected = before_extra - 1
            check(
                "Ingredient stock decreased by the logged extra quantity",
                abs(after_extra - expected) < 1e-6,
                f"before={before_extra}, after={after_extra}, expected={expected}",
            )
            # restage back so the final stock-reset pass below is exact
            stage_stock(extra_item["ingredient_id"], before_extra, exec_id, exec_headers)

    # -----------------------------------------------------------------
    # Cleanup
    # -----------------------------------------------------------------
    print("\n-- cleanup --")
    for txn_id in voided_transaction_ids:
        requests.post(f"{API_BASE}/transactions/{txn_id}/void", json={"reason": "verification cleanup"}, headers=exec_headers)
    for ingredient_id, value in stock_reset.items():
        requests.post(
            f"{API_BASE}/inventory/{ingredient_id}/count",
            json={"employee_id": exec_id, "counted_stock": value},
            headers=exec_headers,
        )
    print(f"Restored {len(stock_reset)} ingredient(s) to their pre-test stock values.")

    print("\n== Summary ==")
    passed = sum(1 for _, ok, _ in results if ok)
    failed = [name for name, ok, _ in results if not ok]
    print(f"{passed}/{len(results)} checks passed.")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        sys.exit(1)


if __name__ == "__main__":
    main()
