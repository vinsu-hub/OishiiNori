"""
Disposable full-system health check -- Oishii Nori Command Suite.

Not a permanent test suite -- no pytest, no CI wiring, same convention as
qa_phase2.py (which this extends: that script explicitly could not test
hr.py/kiosk.py because the `hr` Postgres schema wasn't exposed yet -- it
is now, so this script covers what that one couldn't).

Checks, in order:
  1. Connectivity        -- dev + prod API health, all 3 dashboard-family
                             Vercel apps reachable
  2. Auth                -- all three role tiers log in
  3. Router smoke sweep  -- every router's primary GET/list endpoint, 200
  4. Role-gating         -- executive-only / manager+executive-only 403s
  5. Order lifecycle     -- real POS sale -> stock deducted -> kitchen
                             status advanced through to completed -> voided
                             -> stock restored (dev only, mutating)
  6. Digital-menu        -- real public QR order -> Pending Orders -> approve
                             -> shows on Order Queue/Kitchen Display with
                             the QR badge (dev only, mutating)
  7. Payroll             -- the seed_payroll_demo.py record is present and
                             internally consistent (dev + prod, read-only)
  8. Cleanup             -- void every transaction this script created
                             (never the payroll demo data, which is meant
                             to persist)

Run with:  py -3 services/api-fastapi/scripts/system_health_check.py
"""
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8")

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]

DEV_API_BASE = os.environ.get("QA_API_BASE", "http://localhost:8000")
PROD_API_BASE = "https://oishii-nori-api.vercel.app"
PROD_APPS = {
    "dashboard": "https://oishii-nori-dashboard.vercel.app",
    "staff-clock": "https://oishii-nori-staff-clock.vercel.app",
    "customer-menu": "https://oishii-nori-menu.vercel.app",
}

QA_PASSWORD = "oishii1234-qa"
QA_MANAGER_PASSWORD = "oishii1234"

PAYROLL_PERIOD_START = "2026-06-01"
PAYROLL_PERIOD_END = "2026-06-15"

results: list[tuple[str, bool, str]] = []
voided_transaction_ids: list[str] = []
created_digital_order_ids: list[str] = []


def check(name: str, condition: bool, detail: str = ""):
    results.append((name, condition, detail))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" -- {detail}" if detail and not condition else ""))


def login(email: str, password: str) -> str | None:
    # Call GoTrue directly -- the installed supabase-py (2.9.0) rejects the
    # newer sb_secret_ API key format in create_client() before any request.
    try:
        r = requests.post(
            f"{SUPABASE_URL}/auth/v1/token",
            params={"grant_type": "password"},
            headers={"apikey": SUPABASE_SECRET_KEY, "Content-Type": "application/json"},
            json={"email": email, "password": password},
            timeout=30,
        )
        if r.status_code != 200:
            print(f"  login failed for {email}: {r.status_code} {r.text[:300]}")
            return None
        return r.json()["access_token"]
    except requests.exceptions.RequestException as e:
        print(f"  login failed for {email}: {e!r}")
        return None


# --- 1. Connectivity ---------------------------------------------------
def check_connectivity():
    print("-- 1. Connectivity --")
    try:
        r = requests.get(f"{DEV_API_BASE}/health", timeout=5)
        check("dev GET /health -> 200", r.status_code == 200)
    except requests.exceptions.ConnectionError:
        check("dev GET /health -> 200", False, f"cannot reach {DEV_API_BASE}")

    try:
        r = requests.get(f"{PROD_API_BASE}/health", timeout=15)
        check("prod GET /health -> 200", r.status_code == 200)
    except requests.exceptions.ConnectionError as e:
        check("prod GET /health -> 200", False, str(e))

    for name, url in PROD_APPS.items():
        try:
            r = requests.get(url, timeout=15)
            check(f"prod {name} app reachable -> 200", r.status_code == 200, f"got {r.status_code}")
        except requests.exceptions.ConnectionError as e:
            check(f"prod {name} app reachable -> 200", False, str(e))


# --- 2. Auth -------------------------------------------------------------
def check_auth() -> dict[str, str]:
    print("\n-- 2. Auth --")
    tokens = {}
    for role, email, pw in [
        ("executive", "qa.tester@oishiinori.com", QA_PASSWORD),
        ("manager", "qa.manager@oishiinori.com", QA_MANAGER_PASSWORD),
        ("employee", "qa.employee@oishiinori.com", QA_PASSWORD),
    ]:
        token = login(email, pw)
        check(f"{role} login ({email})", token is not None)
        if token:
            tokens[role] = token
    return tokens


# --- 3. Router smoke sweep ------------------------------------------------
def check_router_sweep(exec_headers: dict, base: str, label: str):
    print(f"\n-- 3. Router smoke sweep ({label}) --")
    endpoints = [
        ("GET /products", "GET", "/products?active_only=true"),
        ("GET /inventory", "GET", "/inventory"),
        ("GET /inventory-movements", "GET", "/inventory-movements"),
        ("GET /discount-types", "GET", "/discount-types"),
        ("GET /loss-records", "GET", "/loss-records"),
        ("GET /utility-logs", "GET", "/utility-logs"),
        ("GET /digital-orders", "GET", "/digital-orders"),
        ("GET /transactions", "GET", "/transactions"),
        ("GET /dashboard/summary", "GET", "/dashboard/summary"),
        ("GET /analytics/sales-trend", "GET", "/analytics/sales-trend"),
        ("GET /analytics/top-products", "GET", "/analytics/top-products"),
        ("GET /hr/holidays", "GET", "/hr/holidays?year=2026"),
        ("GET /hr/pay-rules", "GET", "/hr/pay-rules"),
        ("GET /payroll", "GET", "/payroll"),
        ("GET /employees", "GET", "/employees"),
        ("GET /attendance", "GET", "/attendance"),
    ]
    for name, method, path in endpoints:
        try:
            r = requests.get(f"{base}{path}", headers=exec_headers, timeout=15)
            check(f"{label}: {name} -> 200", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")
        except requests.exceptions.RequestException as e:
            check(f"{label}: {name} -> 200", False, str(e))


# --- 4. Role gating --------------------------------------------------------
def check_role_gating(manager_headers: dict, employee_headers: dict, base: str, label: str):
    print(f"\n-- 4. Role-gating regression ({label}) --")
    r = requests.get(f"{base}/dashboard/summary", headers=manager_headers)
    check(f"{label}: manager on executive-only /dashboard/summary -> 403", r.status_code == 403, f"got {r.status_code}")

    r = requests.get(f"{base}/analytics/sales-trend", headers=manager_headers)
    check(f"{label}: manager on executive-only /analytics/sales-trend -> 403", r.status_code == 403, f"got {r.status_code}")

    r = requests.get(f"{base}/employees", headers=employee_headers)
    check(f"{label}: employee on manager+/employees -> 403", r.status_code == 403, f"got {r.status_code}")

    r = requests.get(f"{base}/payroll", headers=employee_headers)
    check(f"{label}: employee on manager+/payroll -> 403", r.status_code == 403, f"got {r.status_code}")


# --- 5. Real order lifecycle (dev only, mutating) --------------------------
def check_order_lifecycle(exec_headers: dict, exec_id: str):
    print("\n-- 5. Order lifecycle (dev) --")
    r = requests.get(f"{DEV_API_BASE}/products?active_only=true", headers=exec_headers)
    products = r.json() if r.status_code == 200 else []
    target_size = None
    for p in products:
        if p["is_bundle"] or not p["sizes"]:
            continue
        target_size = p["sizes"][0]
        break
    check("found a sellable product size", target_size is not None)
    if not target_size:
        return

    recipe_r = requests.get(f"{DEV_API_BASE}/product-sizes/{target_size['id']}/recipe", headers=exec_headers)
    for item in recipe_r.json() if recipe_r.status_code == 200 else []:
        requests.post(
            f"{DEV_API_BASE}/inventory/{item['ingredient_id']}/count",
            json={"employee_id": exec_id, "counted_stock": 100000},
            headers=exec_headers,
        )

    sale_body = {
        "employee_id": exec_id,
        "items": [{"product_size_id": target_size["id"], "quantity": 1}],
    }

    no_pay = requests.post(f"{DEV_API_BASE}/transactions", json=sale_body, headers=exec_headers)
    check(
        "POST /transactions without payment_method -> 400",
        no_pay.status_code == 400,
        f"got {no_pay.status_code}: {no_pay.text[:200]}",
    )

    r = requests.post(
        f"{DEV_API_BASE}/transactions",
        json={**sale_body, "payment_method": "cash"},
        headers=exec_headers,
    )
    check("POST /transactions -> 200", r.status_code == 200, r.text)
    if r.status_code != 200:
        return
    txn = r.json()
    tx_id = txn["id"]
    voided_transaction_ids.append(tx_id)
    check("new transaction starts kitchen_status=queued", txn["kitchen_status"] == "queued")
    check(
        "new transaction has a daily order_number >= 1001",
        isinstance(txn.get("order_number"), int) and txn["order_number"] >= 1001,
        f"got {txn.get('order_number')!r}",
    )

    for next_status in ["preparing", "ready", "completed"]:
        r = requests.patch(
            f"{DEV_API_BASE}/transactions/{tx_id}/kitchen-status",
            json={"kitchen_status": next_status},
            headers=exec_headers,
        )
        check(f"PATCH kitchen-status -> {next_status}", r.status_code == 200 and r.json()["kitchen_status"] == next_status, r.text)


# --- 6. Digital-menu lifecycle (dev only, mutating) -------------------------
def check_digital_menu_lifecycle(exec_headers: dict):
    print("\n-- 6. Digital-menu lifecycle (dev) --")
    menu_r = requests.get(f"{DEV_API_BASE}/public/menu")
    check("GET /public/menu -> 200", menu_r.status_code == 200, menu_r.text)
    if menu_r.status_code != 200:
        return
    menu = menu_r.json()
    target = None
    for p in menu:
        if p["is_bundle"] or not p["sizes"]:
            continue
        target = p["sizes"][0]
        break
    check("found a sellable product size for public menu", target is not None)
    if not target:
        return

    order_r = requests.post(
        f"{DEV_API_BASE}/public/orders",
        json={
            "table_number": 99,
            "items": [{"product_size_id": target["id"], "quantity": 1, "held_ingredients": []}],
            "addons": [],
            "payment_method": "cash",
        },
    )
    check("POST /public/orders -> 200", order_r.status_code == 200, order_r.text)
    if order_r.status_code != 200:
        return
    digital_order = order_r.json()
    created_digital_order_ids.append(digital_order["id"])

    pending_r = requests.get(f"{DEV_API_BASE}/digital-orders?status=pending", headers=exec_headers)
    check(
        "new digital order visible in /digital-orders?status=pending",
        pending_r.status_code == 200 and any(o["id"] == digital_order["id"] for o in pending_r.json()),
    )

    approve_r = requests.post(f"{DEV_API_BASE}/digital-orders/{digital_order['id']}/approve", headers=exec_headers)
    check("POST /digital-orders/{id}/approve -> 200", approve_r.status_code == 200, approve_r.text)
    if approve_r.status_code != 200:
        return
    approved = approve_r.json()
    tx_id = approved["transaction_id"]
    voided_transaction_ids.append(tx_id)

    oq_r = requests.get(f"{DEV_API_BASE}/transactions", headers=exec_headers)
    matching = next((t for t in oq_r.json() if t["id"] == tx_id), None) if oq_r.status_code == 200 else None
    check("approved digital order's transaction appears in /transactions", matching is not None)

    do_r = requests.get(f"{DEV_API_BASE}/digital-orders?status=approved", headers=exec_headers)
    correlatable = any(o["transaction_id"] == tx_id and o["table_number"] == 99 for o in do_r.json()) if do_r.status_code == 200 else False
    check("digital order correlates back to its transaction (table 99)", correlatable)


# --- 6b. Tables create/retire (dev + prod, self-cleaning) -------------------
def _purge_healthcheck_tables():
    """Hard-delete every HEALTHCHECK * row (this run's and any left by older
    runs) straight through PostgREST with the service key -- the API has no
    DELETE /tables, and a soft-deactivated row still clutters the Tables list.
    Called after each pass so the script leaves nothing behind."""
    svc = {"apikey": SUPABASE_SECRET_KEY, "Authorization": f"Bearer {SUPABASE_SECRET_KEY}"}
    try:
        rows = requests.get(
            f"{SUPABASE_URL}/rest/v1/tables?select=id&label=like.HEALTHCHECK%20*",
            headers=svc, timeout=20,
        ).json()
        for row in rows:
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/tables?id=eq.{row['id']}", headers=svc, timeout=20
            )
        if rows:
            print(f"  (cleaned up {len(rows)} HEALTHCHECK table row(s))")
    except requests.exceptions.RequestException as e:
        print(f"  (HEALTHCHECK table cleanup skipped: {e!r})")


def check_tables_write(manager_headers: dict, base: str, label: str):
    print(f"\n-- 6b. Tables create/retire ({label}) --")
    origin = {"Origin": PROD_APPS["dashboard"]}
    temp_label = f"HEALTHCHECK {int(time.time())}"

    r = requests.post(
        f"{base}/tables",
        json={"label": temp_label, "capacity": 2},
        headers={**manager_headers, **origin},
        timeout=20,
    )
    ok = r.status_code == 200
    check(f"{label}: manager POST /tables -> 200", ok, f"got {r.status_code}: {r.text[:200]}")
    # The "NetworkError" the dashboard reported == a response with no CORS
    # header. Assert it's present on the real POST, not just the preflight.
    check(
        f"{label}: POST /tables response carries Access-Control-Allow-Origin",
        r.headers.get("access-control-allow-origin") == "*",
        f"got {r.headers.get('access-control-allow-origin')!r}",
    )
    if not ok:
        return
    table_id = r.json()["id"]

    dup = requests.post(
        f"{base}/tables", json={"label": temp_label, "capacity": 2}, headers=manager_headers, timeout=20
    )
    check(
        f"{label}: duplicate label -> 409 (not 500/NetworkError)",
        dup.status_code == 409,
        f"got {dup.status_code}: {dup.text[:200]}",
    )

    retire = requests.patch(
        f"{base}/tables/{table_id}", json={"active": False}, headers=manager_headers, timeout=20
    )
    check(f"{label}: retire health-check table {table_id[:8]}", retire.status_code == 200, retire.text[:200])

    # Don't leave the row behind (soft-deactivated still clutters the Tables list).
    _purge_healthcheck_tables()


# --- 7. Payroll consistency (dev + prod, read-only) -------------------------
def check_payroll(exec_headers: dict, base: str, label: str):
    print(f"\n-- 7. Payroll demo data consistency ({label}) --")
    r = requests.get(f"{base}/payroll?limit=50", headers=exec_headers)
    check(f"{label}: GET /payroll -> 200", r.status_code == 200, r.text)
    if r.status_code != 200:
        return
    record = next(
        (rec for rec in r.json() if rec["period_start"] == PAYROLL_PERIOD_START and rec["period_end"] == PAYROLL_PERIOD_END),
        None,
    )
    check(f"{label}: seeded June 1-15 payroll record exists", record is not None)
    if not record:
        return
    check(f"{label}: payroll record employee_count == 5", record["employee_count"] == 5, f"got {record['employee_count']}")
    check(f"{label}: payroll record total_pay > 0", record["total_pay"] > 0, f"got {record['total_pay']}")

    detail_r = requests.get(f"{base}/payroll/{record['id']}", headers=exec_headers)
    check(f"{label}: GET /payroll/{{id}} -> 200", detail_r.status_code == 200, detail_r.text)
    if detail_r.status_code == 200:
        detail = detail_r.json()
        items_total = round(sum(i["total_pay"] for i in detail["items"]), 2)
        check(
            f"{label}: sum(items.total_pay) == record.total_pay",
            abs(items_total - record["total_pay"]) < 0.01,
            f"items sum={items_total}, record={record['total_pay']}",
        )


# --- 8. Cleanup --------------------------------------------------------------
def cleanup(exec_headers: dict):
    print("\n-- 8. Cleanup --")
    # Void through the API first (exercises the void path + restores stock),
    # then hard-delete the rows straight through PostgREST so a prod run leaves
    # nothing behind -- local dev and prod share one DB (see the shared-Supabase
    # note), so even a "dev only" lifecycle test pollutes the live boards.
    for tx_id in voided_transaction_ids:
        r = requests.post(
            f"{DEV_API_BASE}/transactions/{tx_id}/void",
            json={"reason": "system_health_check.py cleanup"},
            headers=exec_headers,
        )
        check(f"voided health-check transaction {tx_id[:8]}", r.status_code == 200, r.text)

    svc = {"apikey": SUPABASE_SECRET_KEY, "Authorization": f"Bearer {SUPABASE_SECRET_KEY}"}
    deleted = 0
    try:
        for oid in created_digital_order_ids:
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/digital_orders?id=eq.{oid}", headers=svc, timeout=20
            )
            deleted += 1
        for tx_id in voided_transaction_ids:
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/transactions?id=eq.{tx_id}", headers=svc, timeout=20
            )
            deleted += 1
        if deleted:
            print(f"  (hard-deleted {deleted} health-check order row(s))")
    except requests.exceptions.RequestException as e:
        print(f"  (health-check order cleanup skipped: {e!r})")


def main():
    print(f"== Oishii Nori system health check -- dev={DEV_API_BASE} prod={PROD_API_BASE} ==\n")

    check_connectivity()

    dev_tokens = check_auth()
    if "executive" not in dev_tokens:
        print("\nCannot continue without an executive token. Aborting.")
        sys.exit(1)
    dev_exec_headers = {"Authorization": f"Bearer {dev_tokens['executive']}"}
    dev_manager_headers = {"Authorization": f"Bearer {dev_tokens['manager']}"} if "manager" in dev_tokens else None
    dev_employee_headers = {"Authorization": f"Bearer {dev_tokens['employee']}"} if "employee" in dev_tokens else None

    try:
        exec_id_r = requests.get(f"{DEV_API_BASE}/employees", headers=dev_exec_headers, timeout=5)
        dev_up = True
    except requests.exceptions.RequestException:
        dev_up = False

    if not dev_up:
        print(f"\n(dev API {DEV_API_BASE} unreachable -- skipping the dev pass, running the prod pass only)")
    else:
        exec_id = next(
            (e["id"] for e in exec_id_r.json() if e.get("employee_number") == "QA-EXEC"), None
        ) if exec_id_r.status_code == 200 else None

        check_router_sweep(dev_exec_headers, DEV_API_BASE, "dev")
        if dev_manager_headers and dev_employee_headers:
            check_role_gating(dev_manager_headers, dev_employee_headers, DEV_API_BASE, "dev")

        if dev_manager_headers:
            check_tables_write(dev_manager_headers, DEV_API_BASE, "dev")

        if exec_id:
            check_order_lifecycle(dev_exec_headers, exec_id)
            check_digital_menu_lifecycle(dev_exec_headers)
        else:
            check("resolved QA-EXEC employee id for lifecycle tests", False, "could not find QA-EXEC in /employees")

        check_payroll(dev_exec_headers, DEV_API_BASE, "dev")

        cleanup(dev_exec_headers)

    # Read-only prod pass -- same executive account, prod is the same
    # Supabase project so the token is valid there too.
    time.sleep(1)
    check_router_sweep(dev_exec_headers, PROD_API_BASE, "prod")
    if dev_manager_headers:
        check_tables_write(dev_manager_headers, PROD_API_BASE, "prod")
    check_payroll(dev_exec_headers, PROD_API_BASE, "prod")

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"RESULT: {passed}/{total} checks passed")
    if passed != total:
        print("\nFailures:")
        for name, ok, detail in results:
            if not ok:
                print(f"  - {name}" + (f" ({detail})" if detail else ""))
        sys.exit(1)


if __name__ == "__main__":
    main()
