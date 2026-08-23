from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import (
    analytics,
    dashboard_summary,
    digital_menu,
    discounts,
    hr,
    inventory,
    inventory_movements,
    kiosk,
    loss_records,
    menu_admin,
    oishi_ai,
    products,
    recipes,
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

app.include_router(products.router)
app.include_router(recipes.router)
app.include_router(menu_admin.router)
app.include_router(inventory.router)
app.include_router(inventory_movements.router)
app.include_router(discounts.router)
app.include_router(loss_records.router)
app.include_router(hr.router)
app.include_router(kiosk.router)
app.include_router(transactions.router)
app.include_router(utility_logs.router)
app.include_router(digital_menu.router)
app.include_router(dashboard_summary.router)
app.include_router(analytics.router)
app.include_router(oishi_ai.router)


@app.get("/health")
def health():
    return {"status": "ok"}
