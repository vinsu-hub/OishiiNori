"""Cashier shift ledger and immutable report snapshots (migration 0069)."""

from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.routers.sales_insights import _page_rows, ID_BATCH_SIZE

router = APIRouter(tags=["shift-reports"])


def money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"))


def _front_of_house(user: CurrentUser) -> None:
    if user.role in ("kitchen", "rider", "stocker"):
        raise HTTPException(status_code=403, detail="This account cannot access shift reports")


def _open_v1(db) -> dict:
    from app.routers.business_days import fetch_open_shift
    shift = fetch_open_shift(db)
    if not shift or shift.get("report_version") != 1:
        raise HTTPException(status_code=409, detail="No report-enabled shift is open")
    return shift


class MovementIn(BaseModel):
    kind: Literal["paid_in", "owner_transfer", "cash_refund"]
    purpose: str = Field(min_length=1, max_length=240)
    amount: float = Field(gt=0)
    transaction_id: str | None = None


@router.post("/shift-reports/movements")
def record_movement(body: MovementIn, user: CurrentUser = Depends(get_current_user)):
    _front_of_house(user)
    db = get_supabase()
    shift = _open_v1(db)
    if body.kind == "cash_refund":
        if not body.transaction_id:
            raise HTTPException(status_code=400, detail="Choose a voided paid order")
        tx = (db.table("transactions").select("id,status,payment_status,total_amount")
              .eq("id", body.transaction_id).maybe_single().execute().data)
        if not tx or tx["status"] != "voided" or tx["payment_status"] != "paid":
            raise HTTPException(status_code=409, detail="Refund payout requires a voided paid order")
        approved = (db.table("refunds").select("id").eq("transaction_id", body.transaction_id)
                    .eq("status", "approved").limit(1).execute().data)
        # A queued order may be voided directly; later orders require approval.
        if not approved and money(tx["total_amount"]) != money(body.amount):
            raise HTTPException(status_code=400, detail="Enter the full refund amount")
        if money(tx["total_amount"]) != money(body.amount):
            raise HTTPException(status_code=400, detail="Only full cash refunds are supported")
    elif body.transaction_id:
        raise HTTPException(status_code=400, detail="Transaction is only used for cash refunds")
    try:
        row = db.table("shift_cash_movements").insert({
            "business_day_id": shift["id"], "kind": body.kind,
            "purpose": body.purpose.strip(), "amount": str(money(body.amount)),
            "transaction_id": body.transaction_id, "recorded_by": user.id,
        }).execute().data[0]
    except Exception as exc:
        if "shift_cash_refund_once" in str(exc):
            raise HTTPException(status_code=409, detail="Cash refund was already recorded") from exc
        raise
    return {**row, "recorded_by_name": user.full_name}


def _sales(db, start: str, end: str) -> list[dict]:
    fields = ("id,opened_at,paid_at,total_amount,discount_amount,tax_amount,"
              "payment_method,card_type,order_source,payment_status")
    # Immediate payments have paid_at=NULL in the existing POS schema. COD
    # settlements carry paid_at and belong to the shift that collected them.
    immediate = _page_rows(db.table("transactions").select(fields)
                           .gte("opened_at", start).lt("opened_at", end)
                           .is_("paid_at", "null").eq("payment_status", "paid")
                           .order("id"))
    settled = _page_rows(db.table("transactions").select(fields)
                         .gte("paid_at", start).lt("paid_at", end)
                         .eq("payment_status", "paid").order("id"))
    return immediate + settled


def build_shift_report(db, shift: dict, closed_at: datetime, counted_cash: float) -> dict:
    """Build once at close. All later views read this frozen snapshot."""
    start = shift["opened_at"]
    end = closed_at.astimezone(timezone.utc).isoformat()
    settings = db.table("business_settings").select("receipt_business_name").eq("id", 1).maybe_single().execute().data or {}
    sales = _sales(db, start, end)
    ids = [sale["id"] for sale in sales]
    digital: dict[str, dict] = {}
    delivery: dict[str, Decimal] = {}
    for offset in range(0, len(ids), ID_BATCH_SIZE):
        batch = ids[offset:offset + ID_BATCH_SIZE]
        for row in _page_rows(db.table("digital_orders")
                              .select("id,transaction_id,payment_method")
                              .in_("transaction_id", batch).order("id")):
            digital[row["transaction_id"]] = row
        for row in _page_rows(db.table("deliveries").select("id,transaction_id,delivery_fee")
                              .in_("transaction_id", batch).order("id")):
            delivery[row["transaction_id"]] = money(row["delivery_fee"])
    payments: dict[str, Decimal] = {}
    gross = Decimal("0")
    discounts = Decimal("0")
    taxes = Decimal("0")
    for sale in sales:
        linked = digital.get(sale["id"])
        method = (linked or {}).get("payment_method") or sale.get("payment_method") or "Unspecified"
        if method == "card":
            method = (sale.get("card_type") or "Unspecified card").capitalize() if sale.get("card_type") else "Unspecified card"
        elif method in ("gcash", "maya", "bdo", "cash"):
            method = method.upper() if method != "cash" else "Cash"
        else:
            method = method.replace("_", " ").title()
        # POS deliveries store their fee separately; digital orders already
        # include it in transactions.total_amount.
        received = money(sale["total_amount"]) + (Decimal("0") if linked else delivery.get(sale["id"], Decimal("0")))
        payments[method] = payments.get(method, Decimal("0")) + received
        gross += received + money(sale["discount_amount"])
        discounts += money(sale["discount_amount"])
        taxes += money(sale["tax_amount"])
    expenses = _page_rows(db.table("cash_expenses").select("id,description,amount,created_at,recorded_by,profiles(full_name)")
                          .eq("business_day_id", shift["id"]).order("created_at").order("id"))
    movements = _page_rows(db.table("shift_cash_movements").select("id,kind,purpose,amount,created_at,recorded_by,profiles(full_name)")
                           .eq("business_day_id", shift["id"]).order("created_at").order("id"))
    expense_total = sum((money(e["amount"]) for e in expenses), Decimal("0"))
    paid_in = sum((money(m["amount"]) for m in movements if m["kind"] == "paid_in"), Decimal("0"))
    transfers = sum((money(m["amount"]) for m in movements if m["kind"] == "owner_transfer"), Decimal("0"))
    refunds = sum((money(m["amount"]) for m in movements if m["kind"] == "cash_refund"), Decimal("0"))
    starting = money(shift["starting_cash"])
    cash_payments = payments.get("Cash", Decimal("0"))
    expected = starting + cash_payments + paid_in - expense_total - transfers - refunds
    entries = [
        {"id": e["id"], "time": e["created_at"], "staff": (e.get("profiles") or {}).get("full_name"),
         "purpose": e["description"], "kind": "expense", "amount": -float(money(e["amount"]))}
        for e in expenses
    ] + [
        {"id": m["id"], "time": m["created_at"], "staff": (m.get("profiles") or {}).get("full_name"),
         "purpose": m["purpose"], "kind": m["kind"],
         "amount": float(money(m["amount"])) * (1 if m["kind"] == "paid_in" else -1)}
        for m in movements
    ]
    entries.sort(key=lambda entry: (entry["time"], entry["id"]))
    return {
        "id": shift["id"], "shift_number": shift["shift_number"],
        "business_date": shift["business_date"], "opened_at": start, "closed_at": end,
        "store_name": settings.get("receipt_business_name") or "Oishii Nori",
        "register_name": "Shared register",
        "opened_by": shift["opened_by"], "payments": {k: float(v) for k, v in sorted(payments.items())},
        "sales": {"gross": float(gross), "discounts": float(discounts),
                  "cash_refunds": float(refunds), "net": float(gross - discounts - refunds),
                  "taxes": float(taxes), "order_count": len(sales)},
        "cash_drawer": {"starting_cash": float(starting), "cash_payments": float(cash_payments),
                        "cash_refunds": float(refunds), "paid_in": float(paid_in),
                        "operating_expenses": float(expense_total), "owner_transfers": float(transfers),
                        "paid_out": float(expense_total + transfers), "expected_cash": float(expected),
                        "actual_cash": float(money(counted_cash)),
                        "difference": float(money(counted_cash) - expected)},
        "entries": entries,
    }


@router.get("/shift-reports")
def list_shift_reports(user: CurrentUser = Depends(get_current_user)):
    _front_of_house(user)
    db = get_supabase()
    rows = _page_rows(db.table("business_days").select("id,shift_number,business_date,opened_at,closed_at")
                      .eq("report_version", 1).not_.is_("shift_report", "null")
                      .order("closed_at", desc=True).order("id"))
    return [{"id": r["id"], "shift_number": r["shift_number"], "business_date": r["business_date"],
             "opened_at": r["opened_at"], "closed_at": r["closed_at"]}
            for r in rows]


@router.get("/shift-reports/{shift_id}")
def get_shift_report(shift_id: str, user: CurrentUser = Depends(get_current_user)):
    _front_of_house(user)
    row = (get_supabase().table("business_days").select("shift_report,closed_by,opened_by")
           .eq("id", shift_id).maybe_single().execute().data)
    if not row or not row.get("shift_report"):
        raise HTTPException(status_code=404, detail="Closed shift report not found")
    ids = [row["opened_by"], row["closed_by"]]
    staff = {p["id"]: p["full_name"] for p in get_supabase().table("profiles")
             .select("id,full_name").in_("id", ids).execute().data}
    return {**row["shift_report"], "opened_by_name": staff.get(row["opened_by"]),
            "closed_by_name": staff.get(row["closed_by"])}
