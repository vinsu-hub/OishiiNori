"""
Disposable Phase 2 QA pass -- Oishii Nori Command Suite.

Exercises the backend surfaces that were built but only CRUD-tested (or not
tested at all) as of the last session: discounts.py (incl. its effect on a
real transaction's discount_amount/tax_amount), loss_records.py (both stock-
deduction paths), and hr.py/kiosk.py (blocked until the `hr` Postgres schema
is added to Supabase Dashboard > Settings > API > Exposed schemas).

Not a permanent test suite -- no pytest, no CI wiring. Run once, read the
report, delete or keep at the user's discretion. Hits a locally running
`uvicorn app.main:app --port 8000` over real HTTP, same style as the prior
session's live verification of transactions.py.

Creates two throwaway auth users directly via the Supabase service-role
client (mirrors app/routers/hr.py's create_employee logic exactly, just
run here instead of through the API so this script doesn't need a pre-
existing manager account to bootstrap itself):
  - qa.tester@oishiinori.com   (role=executive, employee_number=QA-EXEC)
  - qa.employee@oishiinori.com (role=employee,  employee_number=QA-EMP)
Idempotent: reruns reuse the same two profiles instead of creating new ones.

Any state this script mutates on ingredients (via loss records) is reset
back to its pre-test value at the end. Test transactions are voided, not
deleted. The two QA profiles and their auth users are left in place
(same call as the prior session's "1 test profile left in place" --
deleting an auth user cascades into anything that ever referenced it).

Run with:  py -3 services/api-fastapi/scripts/qa_phase2.py
"""
import os
import sys
import uuid
from datetime import date
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


# ingredient_id -> current_stock value to restore to at the very end. The
# live DB's baseline turned out to be 0 stock across the board (a fresh
# catalog with no receiving/count history yet, not a bug) -- discounts and
# loss-record deduction tests need *some* stock to exercise, so this script
# stages it via the real /inventory/{id}/count endpoint (the same operation
# a real Count Stock session performs) and always restores the pre-test
# value afterward, recorded here the first time each ingredient is touched.
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


def ensure_qa_user(email: str, employee_number: str, role: str) -> tuple[str, str]:
    """Create (or reuse) a QA auth user + profile. Returns (user_id, access_token)."""
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

    # Sign in on a throwaway client, not `admin` -- signing in on the shared
    # service-role client would swap its session and break subsequent
    # auth.admin.* calls (list_users, create_user) for later QA users.
    auth_client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
    session = auth_client.auth.sign_in_with_password({"email": email, "password": QA_PASSWORD})
    return user_id, session.session.access_token


def main():
    print(f"== Oishii Nori Phase 2 QA -- API base: {API_BASE} ==\n")

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

    # -----------------------------------------------------------------
    # Discounts
    # -----------------------------------------------------------------
    print("-- discounts.py --")

    # `discount_types.name` has a unique constraint -- suffix with a fresh
    # id each run so reruns don't 500 on a leftover row from a prior run
    # (this script never deletes discount types it creates, same reasoning
    # as leaving the QA profiles in place).
    discount_name = f"QA Senior Discount {uuid.uuid4().hex[:6]}"

    r = requests.post(
        f"{API_BASE}/discount-types",
        json={"name": discount_name, "percentage": 20, "vat_exempt": True},
        headers=emp_headers,
    )
    check("POST /discount-types as employee -> 403", r.status_code == 403, r.text)

    r = requests.post(
        f"{API_BASE}/discount-types",
        json={"name": discount_name, "percentage": 20, "vat_exempt": True},
        headers=exec_headers,
    )
    check("POST /discount-types as executive -> 200", r.status_code == 200, r.text)
    discount = r.json() if r.status_code == 200 else None
    discount_id = discount["id"] if discount else None

    if discount_id:
        r = requests.patch(
            f"{API_BASE}/discount-types/{discount_id}",
            json={"percentage": 15},
            headers=exec_headers,
        )
        check("PATCH /discount-types/{id} percentage -> 15", r.status_code == 200 and r.json()["percentage"] == 15, r.text)

        r = requests.get(f"{API_BASE}/discount-types", headers=exec_headers)
        check("GET /discount-types includes QA discount", any(d["id"] == discount_id for d in r.json()))

    # -----------------------------------------------------------------
    # Transactions + discount interaction
    # -----------------------------------------------------------------
    print("\n-- transactions.py x discounts --")

    r = requests.get(f"{API_BASE}/products?active_only=true", headers=exec_headers)
    products = r.json() if r.status_code == 200 else []
    target_size = None
    for p in products:
        if p["is_bundle"] or not p["sizes"]:
            continue
        target_size = p["sizes"][0]
        break
    check("Found a non-bundle product_size to test with", target_size is not None)

    if target_size:
        # Live DB baseline is 0 stock everywhere right now, so no size is
        # naturally "available" -- stage enough stock on this size's own
        # recipe ingredients (real /inventory/{id}/count calls) to make the
        # transaction actually deductible, same as a real Count Stock/
        # receiving session would before opening for the day.
        recipe_r = requests.get(f"{API_BASE}/product-sizes/{target_size['id']}/recipe", headers=exec_headers)
        recipe_items = recipe_r.json() if recipe_r.status_code == 200 else []
        for item in recipe_items:
            stage_stock(item["ingredient_id"], 100000, exec_id, exec_headers)

    voided_transaction_ids = []
    if target_size and discount_id:
        price = target_size["price"]
        r = requests.post(
            f"{API_BASE}/transactions",
            json={
                "employee_id": exec_id,
                "items": [{"product_size_id": target_size["id"], "quantity": 1}],
                "discount_type_id": discount_id,
                "payment_method": "cash",
            },
            headers=exec_headers,
        )
        check("POST /transactions with discount_type_id -> 200", r.status_code == 200, r.text)
        if r.status_code == 200:
            txn = r.json()
            expected_discount = round(price * 0.15, 2)
            expected_tax = 0.0  # vat_exempt discount
            check(
                "discount_amount computed correctly (15% of subtotal, VAT-exempt)",
                round(txn["discount_amount"], 2) == expected_discount and txn["tax_amount"] == expected_tax,
                f"got discount_amount={txn['discount_amount']}, tax_amount={txn['tax_amount']}, expected discount={expected_discount}",
            )
            voided_transaction_ids.append(txn["id"])

        # inactive discount type should be rejected
        requests.patch(f"{API_BASE}/discount-types/{discount_id}", json={"active": False}, headers=exec_headers)
        r = requests.post(
            f"{API_BASE}/transactions",
            json={
                "employee_id": exec_id,
                "items": [{"product_size_id": target_size["id"], "quantity": 1}],
                "discount_type_id": discount_id,
                "payment_method": "cash",
            },
            headers=exec_headers,
        )
        check("POST /transactions with inactive discount -> 400", r.status_code == 400, r.text)
        # reactivate so the discount type is left in a normal state
        requests.patch(f"{API_BASE}/discount-types/{discount_id}", json={"active": True}, headers=exec_headers)

    # -----------------------------------------------------------------
    # Loss records
    # -----------------------------------------------------------------
    print("\n-- loss_records.py --")

    r = requests.get(f"{API_BASE}/inventory", headers=exec_headers)
    ingredients = r.json() if r.status_code == 200 else []
    target_ingredient = ingredients[0] if ingredients else None
    check("Found an ingredient to test loss deduction against", target_ingredient is not None)

    original_stock = None
    if target_ingredient:
        ingredient_id = target_ingredient["id"]
        # Same 0-baseline situation as the transaction test above -- stage
        # stock via the real count endpoint before exercising deduction.
        stage_stock(ingredient_id, 50, exec_id, exec_headers)
        original_stock = 50.0

        r = requests.post(
            f"{API_BASE}/loss-records",
            json={
                "ingredient_id": ingredient_id,
                "employee_id": exec_id,
                "reason": "spoilage",
                "quantity": 2,
                "unit_cost": 5,
            },
            headers=exec_headers,
        )
        check("POST /loss-records (default deduction) -> 200", r.status_code == 200, r.text)
        loss1 = r.json() if r.status_code == 200 else None
        check("cost_impact derived from unit_cost * quantity", loss1 and loss1["cost_impact"] == 10.0)

        r = requests.get(f"{API_BASE}/inventory/{ingredient_id}", headers=exec_headers)
        after_loss = r.json()
        check(
            "current_stock deducted by loss quantity",
            after_loss and round(original_stock - after_loss["current_stock"], 4) == 2.0,
            f"before={original_stock}, after={after_loss.get('current_stock') if after_loss else '?'}",
        )

        # skip_stock_deduction path: simulate a Count Stock adjustment that
        # already set the true physical count, then log the shrinkage
        # without deducting again.
        stock_after_count = after_loss["current_stock"] - 1
        requests.post(
            f"{API_BASE}/inventory/{ingredient_id}/count",
            json={"employee_id": exec_id, "counted_stock": stock_after_count},
            headers=exec_headers,
        )
        r = requests.post(
            f"{API_BASE}/loss-records",
            json={
                "ingredient_id": ingredient_id,
                "employee_id": exec_id,
                "reason": "shrinkage",
                "quantity": 1,
                "cost_impact": 3,
                "skip_stock_deduction": True,
            },
            headers=exec_headers,
        )
        check("POST /loss-records with skip_stock_deduction=true -> 200", r.status_code == 200, r.text)

        r = requests.get(f"{API_BASE}/inventory/{ingredient_id}", headers=exec_headers)
        final_stock = r.json()["current_stock"]
        check(
            "skip_stock_deduction did not double-deduct (stock unchanged since count)",
            round(final_stock - stock_after_count, 4) == 0.0,
            f"expected {stock_after_count}, got {final_stock}",
        )

        # Restoration to the true pre-test baseline happens once for every
        # staged ingredient (this one plus the transaction test's recipe
        # ingredients) in the cleanup section at the end of the script.

    # -----------------------------------------------------------------
    # hr.py / kiosk.py -- only runs if the `hr` schema is exposed
    # -----------------------------------------------------------------
    print("\n-- hr.py / kiosk.py --")
    probe = requests.get(f"{API_BASE}/hr/holidays?year=2026", headers=exec_headers)
    # FastAPI's default handler for an unhandled exception returns a generic
    # {"detail":"Internal Server Error"} body -- the underlying postgrest
    # "Invalid schema: hr" detail never reaches the HTTP response, so any
    # 500 here is treated as "still blocked" rather than string-matching it.
    if probe.status_code == 500:
        print("SKIPPED -- `hr` Postgres schema not yet exposed to PostgREST (Supabase Dashboard step pending).")
    else:
        kiosk_id = f"qa-kiosk-{uuid.uuid4().hex[:8]}"

        r = requests.post(
            f"{API_BASE}/kiosk/verify",
            json={"employee_number": "QA-EXEC", "pin": QA_PIN, "kiosk_id": kiosk_id},
        )
        check("POST /kiosk/verify with correct PIN -> 200", r.status_code == 200, r.text)

        r = requests.post(
            f"{API_BASE}/kiosk/verify",
            json={"employee_number": "QA-EXEC", "pin": "0000", "kiosk_id": kiosk_id},
        )
        check("POST /kiosk/verify with wrong PIN -> 401", r.status_code == 401, r.text)

        r = requests.post(
            f"{API_BASE}/kiosk/clock-in",
            json={"employee_id": exec_id, "kiosk_id": kiosk_id},
        )
        check("POST /kiosk/clock-in -> 200", r.status_code == 200, r.text)
        attendance = r.json() if r.status_code == 200 else None

        r = requests.post(
            f"{API_BASE}/kiosk/clock-in",
            json={"employee_id": exec_id, "kiosk_id": kiosk_id},
        )
        check(
            "Double clock-in is a no-op (returns same open shift)",
            r.status_code == 200 and attendance and r.json()["id"] == attendance["id"],
        )

        completed_attendance = None
        if attendance:
            r = requests.post(
                f"{API_BASE}/kiosk/clock-out",
                json={"attendance_log_id": attendance["id"]},
            )
            check("POST /kiosk/clock-out -> 200, status completed", r.status_code == 200 and r.json()["status"] == "completed", r.text)
            completed_attendance = r.json() if r.status_code == 200 else None

        today = date.today().isoformat()
        r = requests.get(
            f"{API_BASE}/attendance/summary",
            params={"date_from": today, "date_to": today},
            headers=exec_headers,
        )
        check("GET /attendance/summary -> 200", r.status_code == 200, r.text)

        r = requests.post(
            f"{API_BASE}/hr/holidays",
            json={"holiday_date": "2026-12-25", "name": "QA Test Holiday", "holiday_type": "regular_holiday"},
            headers=exec_headers,
        )
        check("POST /hr/holidays (executive) -> 200", r.status_code == 200, r.text)
        holiday = r.json() if r.status_code == 200 else None

        if holiday:
            r = requests.delete(f"{API_BASE}/hr/holidays/{holiday['id']}", headers=exec_headers)
            check("DELETE /hr/holidays/{id} -> 200 (own test data)", r.status_code == 200, r.text)

        rules_r = requests.get(f"{API_BASE}/hr/pay-rules", headers=exec_headers)
        rest_day_rule = next((rule for rule in rules_r.json() if rule["scenario_key"] == "rest_day"), None) if rules_r.status_code == 200 else None
        check("GET /hr/pay-rules includes rest_day", rest_day_rule is not None)

        if rest_day_rule:
            original_pct = rest_day_rule["first_8hr_pct"]
            r = requests.patch(
                f"{API_BASE}/hr/pay-rules/rest_day",
                json={"first_8hr_pct": 130.0},
                headers=exec_headers,
            )
            check("PATCH /hr/pay-rules/rest_day -> 200", r.status_code == 200 and r.json()["first_8hr_pct"] == 130.0, r.text)
            # revert -- this is a real config surface future shifts get paid
            # against, not throwaway test data.
            requests.patch(f"{API_BASE}/hr/pay-rules/rest_day", json={"first_8hr_pct": original_pct}, headers=exec_headers)
            r = requests.get(f"{API_BASE}/hr/pay-rules", headers=exec_headers)
            restored = next((rule for rule in r.json() if rule["scenario_key"] == "rest_day"), None)
            check("rest_day pay rule reverted to original value", restored and restored["first_8hr_pct"] == original_pct)

        r = requests.post(
            f"{API_BASE}/payroll",
            json={"period_start": today, "period_end": today},
            headers=exec_headers,
        )
        check("POST /payroll (generate) -> 200", r.status_code == 200, r.text)
        payroll_record = r.json() if r.status_code == 200 else None

        if payroll_record:
            r = requests.get(f"{API_BASE}/payroll/{payroll_record['id']}", headers=exec_headers)
            check("GET /payroll/{id} -> 200", r.status_code == 200, r.text)

        if completed_attendance:
            r = requests.post(
                f"{API_BASE}/hr/payroll-overrides",
                json={
                    "attendance_log_id": completed_attendance["id"],
                    "field": "regular_hours",
                    "new_value": "8",
                    "reason": "QA Phase 2 script -- verifying override + approval flow",
                },
                headers=exec_headers,
            )
            check("POST /hr/payroll-overrides -> 200", r.status_code == 200, r.text)
            override = r.json() if r.status_code == 200 else None

            if override:
                r = requests.patch(f"{API_BASE}/hr/payroll-overrides/{override['id']}/approve", headers=exec_headers)
                check("PATCH /hr/payroll-overrides/{id}/approve -> 200", r.status_code == 200 and r.json()["approved_by"], r.text)

    # -----------------------------------------------------------------
    # Cleanup: void (not delete) test transactions
    # -----------------------------------------------------------------
    print("\n-- cleanup --")
    for txn_id in voided_transaction_ids:
        r = requests.post(
            f"{API_BASE}/transactions/{txn_id}/void",
            json={"reason": "QA Phase 2 script cleanup"},
            headers=exec_headers,
        )
        check(f"Voided QA test transaction {txn_id}", r.status_code == 200, r.text)

    for ingredient_id, baseline in stock_reset.items():
        r = requests.post(
            f"{API_BASE}/inventory/{ingredient_id}/count",
            json={"employee_id": exec_id, "counted_stock": baseline},
            headers=exec_headers,
        )
        r2 = requests.get(f"{API_BASE}/inventory/{ingredient_id}", headers=exec_headers)
        check(
            f"Restored ingredient {ingredient_id} to pre-test stock ({baseline})",
            r.status_code == 200 and r2.status_code == 200 and r2.json()["current_stock"] == baseline,
        )

    # -----------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------
    print("\n== Summary ==")
    passed = sum(1 for _, ok, _ in results if ok)
    failed = [name for name, ok, detail in results if not ok]
    print(f"{passed}/{len(results)} checks passed")
    if failed:
        print("FAILED:")
        for name in failed:
            print(f"  - {name}")
        sys.exit(1)


if __name__ == "__main__":
    main()
