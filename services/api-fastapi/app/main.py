import logging
import traceback

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routers import (
    analytics,
    business_days,
    dashboard_summary,
    deliveries,
    digital_menu,
    discounts,
    hr,
    inventory,
    inventory_movements,
    kiosk,
    loss_records,
    menu_admin,
    oishi_ai,
    pnl,
    products,
    recipes,
    refunds,
    reservations,
    settings,
    stock_items,
    transactions,
    utility_logs,
)

app = FastAPI(title="Oishii Nori Command Suite API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger("uvicorn.error")


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
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {type(exc).__name__}: {exc}"},
        headers={"Access-Control-Allow-Origin": "*"},
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
app.include_router(utility_logs.router)
app.include_router(digital_menu.router)
app.include_router(dashboard_summary.router)
app.include_router(analytics.router)
app.include_router(pnl.router)
app.include_router(oishi_ai.router)
app.include_router(settings.router)
app.include_router(reservations.router)
app.include_router(business_days.router)
app.include_router(refunds.router)
app.include_router(deliveries.router)


@app.get("/health")
def health():
    return {"status": "ok"}
