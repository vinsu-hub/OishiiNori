"""CPU budget check: will the restaurant's screens fit in Vercel Hobby's 4 h/month?

Vercel paused every Oishii Nori app on 2026-10-16 after the API used up the
Hobby plan's 4 h/month of Active CPU (a kitchen tablet polling the full order
list every 5 s). Run this before deploying anything that adds a poll or makes a
polled endpoint heavier:

    cd services/api-fastapi && .venv/bin/python scripts/cpu_budget.py

It calls each polled endpoint in-process against the live database (GET only,
nothing is written), measures the CPU each call really costs, multiplies by the
polling schedule below, and projects a 30-day month. Exits 1 when the
projection is over 75% of the Hobby limit, so it can gate a deploy.

Keep SCHEDULE in step with the frontends' poll intervals (see
MIN_POLL_INTERVAL_MS in apps/dashboard-web/client/src/lib/constants.ts and
apps/customer-menu/client/src/lib/polling.ts). Day is the PH 09:00-23:00 busy
window; outside it every screen polls at most every 5 minutes.
"""
import argparse
import os
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

HOBBY_LIMIT_HOURS = 4.0
WARN_FRACTION = 0.75
BUSY_HOURS_PER_DAY = 14
QUIET_POLL_SECONDS = 300
# CPU per request that never reaches the handler (routing, CORS, middleware);
# measured locally, rounded up.
OVERHEAD_MS = 2.0
COLD_STARTS_PER_DAY = 40
# GET /transactions* and /digital-orders share a 10 s response cache (transactions.py
# _live_cache). Of the calls in each 10 s window only the first builds it;
# the rest cost about the same as a cheap call.
SHARED_CACHE_SECONDS = 10
CACHE_HIT_MS = 2.0


def schedule(today: str, adv_from: str, adv_before: str, devices: dict) -> list[tuple]:
    """(screen, device count, poll seconds, endpoint). Matches the frontends as of 2026-10-16."""
    kitchen = devices["kitchen"]
    cashier = devices["cashier"]
    tv = devices["tv"]
    bridge = devices["bridge"]
    return [
        ("Kitchen tablet", kitchen, 10, f"/transactions?active_since={today}"),
        ("Kitchen tablet", kitchen, 10, "/digital-orders?status=approved"),
        ("Kitchen tablet", kitchen, 10, f"/transactions/advance-orders?order_type=takeout&date_from={adv_from}&date_before={adv_before}"),
        ("Kitchen tablet", kitchen, 10, f"/transactions/advance-orders?order_type=delivery&date_from={adv_from}&date_before={adv_before}"),
        ("Cashier (new-order alarm)", cashier, 20, "/digital-orders?status=pending"),
        ("Cashier (order queue / boards)", cashier, 30, f"/transactions?active_since={today}"),
        ("Cashier (online orders)", cashier, 30, "/digital-orders"),
        ("Cashier (advance orders)", cashier, 30, f"/transactions/advance-orders?order_type=takeout&date_from={adv_from}&date_before={adv_before}"),
        ("TV queue board", tv, 10, "/public/queue-display"),
        ("Print bridge", bridge, 20, "/transactions?kitchen_status=queued"),
        ("Print bridge", bridge, 20, "/transactions?kitchen_status=preparing"),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kitchen", type=int, default=1, help="kitchen tablets on auto-print (default 1)")
    parser.add_argument("--cashier", type=int, default=2, help="cashier/POS screens open (default 2)")
    parser.add_argument("--tv", type=int, default=1, help="TV queue boards (default 1)")
    parser.add_argument("--bridge", type=int, default=0, help="kitchen print bridges running (default 0)")
    parser.add_argument("--samples", type=int, default=5)
    args = parser.parse_args()

    from fastapi.testclient import TestClient
    from app.auth import CurrentUser, get_current_user
    from app.main import app
    from app.routers.transactions import clear_live_cache

    # Auth is cached for 60 s per token in production, so a poll's cost is the handler itself.
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="00000000-0000-0000-0000-000000000000", role="executive", department=None, full_name="cpu budget", extra_pages=[])
    client = TestClient(app)

    now = datetime.now(timezone.utc)
    today = (now + timedelta(hours=8)).date().isoformat()
    rows = schedule(
        today,
        (now - timedelta(days=7)).isoformat().replace("+00:00", "Z"),
        (now + timedelta(days=8)).isoformat().replace("+00:00", "Z"),
        {"kitchen": args.kitchen, "cashier": args.cashier, "tv": args.tv, "bridge": args.bridge},
    )

    def measure(path: str) -> float:
        total = 0.0
        for _ in range(args.samples):
            clear_live_cache()  # measure a real build; cache hits are modelled below
            started = time.process_time()
            client.get(path)
            total += time.process_time() - started
        return total / args.samples * 1000

    # The in-process test client has its own per-call CPU that production
    # doesn't; take it off, then add OVERHEAD_MS for Vercel's real request path.
    client.get("/health")
    floor_ms = min(measure("/health") for _ in range(3))

    cost_ms: dict[str, float] = {}
    for _, devices, _, path in rows:
        if devices == 0 or path in cost_ms:
            continue
        response = client.get(path)
        if response.status_code != 200:
            print(f"!! {path} -> HTTP {response.status_code}: {response.text[:200]}")
            return 2
        cost_ms[path] = max(measure(path) - floor_ms, 0.0) + OVERHEAD_MS

    print(f"Projected Active CPU (busy {BUSY_HOURS_PER_DAY} h/day, quiet polls every {QUIET_POLL_SECONDS // 60} min)\n")
    print(f"{'screen':32} {'dev':>3} {'every':>6} {'CPU/call':>9} {'CPU/month':>10}  endpoint")
    month_seconds = 0.0
    # Per shared endpoint: total calls/second across every screen asking for it.
    shared_rate: dict[str, float] = {}
    for _, devices, every, path in rows:
        if devices and path.startswith(("/transactions", "/digital-orders")):
            shared_rate[path] = shared_rate.get(path, 0) + devices / every
    for screen, devices, every, path in rows:
        if devices == 0:
            continue
        calls_per_day = devices * (BUSY_HOURS_PER_DAY * 3600 / every + (24 - BUSY_HOURS_PER_DAY) * 3600 / QUIET_POLL_SECONDS)
        per_call = cost_ms[path]
        if path in shared_rate:
            # Fraction of calls that rebuild: at most one per cache window.
            builds = min(1.0, (1 / SHARED_CACHE_SECONDS) / shared_rate[path])
            per_call = builds * cost_ms[path] + (1 - builds) * CACHE_HIT_MS
        seconds = calls_per_day * 30 * per_call / 1000
        month_seconds += seconds
        print(f"{screen:32} {devices:>3} {every:>5}s {per_call:>7.1f}ms {seconds / 3600:>8.2f} h  {path.split('?')[0]}")
    cold = COLD_STARTS_PER_DAY * 30 * 0.7  # ~0.65 s CPU per cold import, measured 2026-10-16
    month_seconds += cold
    print(f"{'Cold starts (~0.7 s each)':32} {'':>3} {'':>6} {'':>9} {cold / 3600:>8.2f} h")
    hours = month_seconds / 3600
    limit = HOBBY_LIMIT_HOURS * WARN_FRACTION
    print(f"\nTotal: {hours:.2f} h / month  (Hobby limit {HOBBY_LIMIT_HOURS:.0f} h, guardrail {limit:.1f} h)")
    print("Note: one-off actions (sales, reports, Oishii AI) come on top; keep headroom for them.")
    if hours > limit:
        print("FAIL: over the guardrail. Slow a poll down or make the endpoint cheaper before deploying.")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
