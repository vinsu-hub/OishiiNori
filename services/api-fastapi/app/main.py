import logging
import os
import time
import traceback

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routers import (
    analytics,
    trend_insights,
    applicants,
    business_days,
    cash_expenses,
    dashboard_summary,
    deliveries,
    digital_menu,
    discounts,
    hr,
    inquiries,
    inventory,
    inventory_movements,
    kiosk,
    kitchen_printer,
    login_lookup,
    item_units,
    loss_records,
    menu_admin,
    oishi_ai,
    order_history,
    payment_methods,
    pnl,
    products,
    recipes,
    refunds,
    reservations,
    reviews,
    sales_insights,
    settings,
    shift_reports,
    stock_items,
    transactions,
    utility_logs,
    override_key,
)

# Security-hardening pass: this used to be allow_origins=["*"]. Auth here is
# a Bearer token (never a cookie), so a wildcard never exposed session
# hijacking -- this tightening is hygiene, not closing an active exploit.
# Real frontend origins + local Vite dev ports (see SYSTEM_GUIDE.md's local
# dev port list: dashboard-web 3000, staff-clock 5174, customer-menu 5175,
# landing-page 5176).
ALLOWED_ORIGINS = [
    "https://oishii-nori-dashboard.vercel.app",
    "https://oishii-nori-menu.vercel.app",
    "https://oishii-nori-staff-clock.vercel.app",
    "https://oishii-nori-landing.vercel.app",
    # Every client app calls this API at this absolute URL directly (never a
    # same-origin relative path), so once a user reaches any app via
    # oishiinori.com/<dashboard|menu|staff-clock> (apps/landing-page's
    # vercel.json rewrite), every API call is cross-origin from oishiinori.com
    # -- needs to be allowed here regardless of which app made the call.
    "https://oishiinori.com",
    "https://www.oishiinori.com",
    "http://localhost:3000",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:5176",
]

docs_enabled = os.environ.get("ENABLE_API_DOCS") == "true"
app = FastAPI(
    title="Oishii Nori Command Suite API",
    docs_url="/docs" if docs_enabled else None,
    redoc_url="/redoc" if docs_enabled else None,
    openapi_url="/openapi.json" if docs_enabled else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger("uvicorn.error")

# CPU guardrail. Vercel bills (and on Hobby, pauses at 4 h/month) Active CPU,
# not wall time -- waiting on Supabase is free, Python work isn't. On
# 2026-10-16 every app was paused because one polled endpoint cost ~100 ms of
# CPU per call. Every response now reports its CPU in a Server-Timing header
# (visible in the browser's Network tab), and anything over the threshold is
# logged as a warning in Vercel's logs with its route, so the next expensive
# endpoint shows up before it becomes a bill or a pause. Process CPU, so a
# request that overlaps another on the same instance can read a bit high.
SLOW_CPU_MS = 60


@app.middleware("http")
async def cpu_meter(request: Request, call_next):
    started = time.process_time()
    response = await call_next(request)
    cpu_ms = (time.process_time() - started) * 1000
    if request.method not in ("GET", "HEAD", "OPTIONS") and response.status_code < 400:
        transactions.expire_version_check()
    response.headers["Server-Timing"] = f"cpu;dur={cpu_ms:.1f}"
    if cpu_ms > SLOW_CPU_MS:
        logger.warning("CPU budget: %s %s took %.0f ms CPU", request.method, request.url.path, cpu_ms)
    return response


@app.exception_handler(Exception)
def unhandled_exception_handler(request: Request, exc: Exception):
    """Turn any unhandled error into a JSON 500 that still carries CORS headers.

    Starlette's ServerErrorMiddleware sits *outside* CORSMiddleware, so a raw
    crash returns a 500 with no Access-Control-Allow-Origin -- the browser then
    reports it as "NetworkError when attempting to fetch resource" and the real
    cause is invisible. Handling it here keeps the response inside the CORS
    layer so the dashboard shows the actual message.
    """
    logger.error("Unhandled error on %s %s\n%s", request.method, request.url.path,
                 "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
    origin = request.headers.get("origin")
    headers = {"Access-Control-Allow-Origin": origin} if origin in ALLOWED_ORIGINS else {}
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {type(exc).__name__}: {exc}"},
        headers=headers,
    )


app.include_router(products.router)
app.include_router(recipes.router)
app.include_router(menu_admin.router)
app.include_router(inventory.router)
app.include_router(inventory_movements.router)
app.include_router(stock_items.router)
app.include_router(discounts.router)
app.include_router(loss_records.router)
app.include_router(hr.router)
app.include_router(kiosk.router)
app.include_router(transactions.router)
app.include_router(order_history.router)
app.include_router(utility_logs.router)
app.include_router(digital_menu.router)
app.include_router(dashboard_summary.router)
app.include_router(sales_insights.router)
app.include_router(analytics.router)
app.include_router(trend_insights.router)
app.include_router(pnl.router)
app.include_router(oishi_ai.router)
app.include_router(settings.router)
app.include_router(reservations.router)
app.include_router(business_days.router)
app.include_router(shift_reports.router)
app.include_router(cash_expenses.router)
app.include_router(refunds.router)
app.include_router(deliveries.router)
app.include_router(payment_methods.router)
app.include_router(reviews.router)
app.include_router(inquiries.router)
app.include_router(applicants.router)
app.include_router(kitchen_printer.router)
app.include_router(login_lookup.router)
app.include_router(item_units.router)
app.include_router(override_key.router)


@app.get("/health")
def health():
    return {"status": "ok"}
