"""Placed-date order history, combining POS sales and digital order staging."""

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.ph_time import PH_UTC_OFFSET, ph_day_bounds_utc, today_ph
from app.routers.sales_insights import ID_BATCH_SIZE, _page_rows
from app.routers.transactions import _item_discounts_supported_check, _transaction_item_addons_supported_check

router = APIRouter(tags=["order-history"])
PH_TZ = timezone(PH_UTC_OFFSET)


def _money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"))


def _batch(db, table: str, fields: str, key: str, ids: list[str]) -> list[dict]:
    rows: list[dict] = []
    for offset in range(0, len(ids), ID_BATCH_SIZE):
        batch = ids[offset:offset + ID_BATCH_SIZE]
        rows.extend(_page_rows(db.table(table).select(fields).in_(key, batch).order("id")))
    return rows


def _group(rows: list[dict], key: str) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if row.get(key):
            grouped[row[key]].append(row)
    return grouped


def _period(placed_at: str) -> str:
    hour = datetime.fromisoformat(placed_at.replace("Z", "+00:00")).astimezone(PH_TZ).hour
    if hour >= 22 or hour < 6:
        return "overnight"
    if 6 <= hour < 12:
        return "morning"
    if 12 <= hour < 18:
        return "afternoon"
    return "evening"


def _history_day_bounds_utc(selected: date) -> tuple[str, str]:
    """[Previous day 22:00, selected day 22:00) in Manila time."""
    local_end = datetime.combine(selected, time(hour=22), tzinfo=PH_TZ)
    start = (local_end - timedelta(days=1)).astimezone(timezone.utc)
    end = local_end.astimezone(timezone.utc) - timedelta(microseconds=1)
    return start.isoformat(), end.isoformat()


def _current_history_date() -> date:
    local_now = datetime.now(PH_TZ)
    return local_now.date() + timedelta(days=local_now.hour >= 22)


def _labels(tx: dict | None, digital: dict | None) -> list[str]:
    labels: list[str] = []
    if (digital or {}).get("scheduled_for") or (tx or {}).get("scheduled_for"):
        labels.append("Advance")
    source = (tx or {}).get("order_source")
    if source == "grab":
        labels.append("Grab")
    elif digital and digital.get("order_channel") == "dine_in_qr":
        labels.append("QR")
    elif digital:
        labels.append("Online")
    channel = (digital or {}).get("order_channel")
    kind = {"dine_in_qr": "dine_in", "pickup": "takeout", "delivery": "delivery"}.get(channel)
    kind = kind or (tx or {}).get("order_type")
    labels.append({"dine_in": "Dine-in", "takeout": "Takeout", "delivery": "Delivery"}.get(kind, "Order"))
    return labels


def _display_line(item: dict, catalog: dict[str, dict], addons: list[dict], digital: bool = False) -> dict:
    size = catalog.get(item["product_size_id"], {})
    product = size.get("products") or {}
    name = product.get("name") or "Product no longer in catalog"
    size_label = size.get("size_label")
    if size_label:
        name += f" ({size_label})"
    return {
        "name": name,
        "quantity": float(item["quantity"]),
        "unit_price": float(item["unit_price"]),
        "held_ingredients": item.get("held_ingredients") or [],
        "discount_amount": float(item.get("discount_amount") or 0),
        "discount_name": item.get("discount_name"),
        "discount_percentage": item.get("discount_percentage"),
        "addons": [] if digital else [
            {"name": addon.get("addon_name") or "Add-on", "quantity": addon["quantity"],
             "unit_price": float(addon["unit_price"])} for addon in addons
        ],
    }


def _build_entry(
    tx: dict | None, digital: dict | None, tx_items: dict[str, list[dict]],
    digital_items: dict[str, list[dict]], tx_addons: dict[str, list[dict]],
    digital_addons: dict[str, list[dict]], tx_delivery: dict[str, dict],
    digital_delivery: dict[str, dict], catalog: dict[str, dict],
    discount_types: dict[str, dict], refund_rows: dict[str, list[dict]],
    cash_refunds: dict[str, list[dict]], profiles: dict[str, dict],
) -> dict:
    tx_id = tx["id"] if tx else None
    digital_id = digital["id"] if digital else None
    placed_at = digital["created_at"] if digital else tx["opened_at"]
    delivery = (digital_delivery.get(digital_id) if digital else None) or (tx_delivery.get(tx_id) if tx else None)
    fee = _money((delivery or {}).get("delivery_fee"))
    discount_amount = _money((tx or {}).get("discount_amount"))
    # A digital transaction already includes its delivery fee; a POS
    # delivery's transaction total excludes it.
    if tx:
        due = _money(tx["total_amount"]) + (Decimal("0") if digital else fee)
        subtotal = _money(digital["subtotal"]) if digital else _money(tx["total_amount"]) + discount_amount
    else:
        subtotal = _money(digital["subtotal"])
        due = subtotal + fee
    paid = due if tx and tx.get("payment_status", "paid") == "paid" else Decimal("0")
    rejected_or_voided = (digital and digital.get("status") == "rejected") or (tx and tx.get("status") == "voided")
    outstanding = Decimal("0") if rejected_or_voided else max(Decimal("0"), due - paid)

    raw_lines = tx_items.get(tx_id, []) if tx else digital_items.get(digital_id, [])
    lines = [_display_line(item, catalog, tx_addons.get(item["id"], []), digital=tx is None)
             for item in raw_lines]
    order_addons = [
        {"name": addon.get("addon_name") or "Add-on", "quantity": addon["quantity"],
         "unit_price": float(addon["unit_price"])}
        for addon in digital_addons.get(digital_id, [])
    ] if digital else []

    discounted_item = next((item for item in raw_lines if _money(item.get("discount_amount")) > 0), None)
    discount_type = discount_types.get((tx or {}).get("discount_type_id"), {})
    discount = None
    if discount_amount > 0:
        discount = {
            "name": (discounted_item or {}).get("discount_name") or discount_type.get("name") or "Discount",
            "percentage": (discounted_item or {}).get("discount_percentage") or discount_type.get("percentage"),
            "amount": float(discount_amount),
            "scope": "one_unit" if discounted_item else "order",
            "item_name": _display_line(discounted_item, catalog, [])["name"] if discounted_item else None,
        }
    refunds = refund_rows.get(tx_id, [])
    refunds.sort(key=lambda row: row.get("requested_at") or "", reverse=True)
    refund = refunds[0] if refunds else None
    payout = sum((_money(row["amount"]) for row in cash_refunds.get(tx_id, [])), Decimal("0"))
    method = (digital or {}).get("payment_method") or (tx or {}).get("payment_method")
    if method == "card" and (tx or {}).get("card_type"):
        method = f"Card ({tx['card_type']})"

    return {
        "id": digital_id or tx_id,
        "transaction_id": tx_id,
        "digital_order_id": digital_id,
        "order_number": (digital or {}).get("order_number") or (tx or {}).get("order_number"),
        "placed_at": placed_at,
        "period": _period(placed_at),
        "labels": _labels(tx, digital),
        "status": (tx or {}).get("status") or (digital or {}).get("status"),
        "approval_status": (digital or {}).get("status"),
        "kitchen_status": (tx or {}).get("kitchen_status"),
        "payment_status": (tx or {}).get("payment_status", "paid") if tx else "unrecorded",
        "payment_method": method,
        "paid_at": (tx or {}).get("paid_at"),
        "scheduled_for": (digital or {}).get("scheduled_for") or (tx or {}).get("scheduled_for"),
        "closed_at": (tx or {}).get("closed_at"),
        "voided_at": (tx or {}).get("voided_at"),
        "delivered_at": (delivery or {}).get("delivered_at"),
        "rider_payout": float(_money((delivery or {}).get("rider_payout"))) if (delivery or {}).get("rider_payout") is not None else None,
        "rider_id": (delivery or {}).get("rider_id"),
        "cashier_name": (profiles.get((tx or {}).get("employee_id")) or {}).get("full_name"),
        "table_number": (digital or {}).get("table_number") or (tx or {}).get("table_number"),
        "guest_count": (tx or {}).get("guest_count"),
        "customer_name": (delivery or {}).get("customer_name") or (tx or {}).get("pickup_customer_name"),
        "customer_phone": (delivery or {}).get("customer_phone") or (tx or {}).get("pickup_customer_phone"),
        "address": (delivery or {}).get("address"),
        "landmark": (delivery or {}).get("landmark"),
        "barangay": (delivery or {}).get("barangay"),
        "customer_note": (digital or {}).get("customer_note"),
        "payment_proof_submitted": bool((digital or {}).get("payment_proof_url")),
        "payment_proof_url": (digital or {}).get("payment_proof_url"),
        "owner_request_note": (tx or {}).get("owner_request_note"),
        "related_transaction_id": (tx or {}).get("related_transaction_id"),
        "void_reason": (tx or {}).get("void_reason"),
        "refund_status": (refund or {}).get("status"),
        "refund_reason": (refund or {}).get("reason"),
        "cash_refund_paid": float(payout),
        "lines": lines,
        "order_addons": order_addons,
        "subtotal": float(subtotal),
        "discount": discount,
        "delivery_fee": float(fee),
        "tax_amount": float(_money((tx or {}).get("tax_amount"))),
        "total_due": float(due),
        "recorded_paid": float(paid),
        "outstanding": float(outstanding),
    }


@router.get("/order-history")
def list_order_history(on_date: date | None = Query(None, alias="date"), user: CurrentUser = Depends(get_current_user), business_day: bool = False):
    if user.role not in ("employee", "manager", "executive"):
        raise HTTPException(status_code=403, detail="Order history is for cashier and management accounts")
    db = get_supabase()
    selected = on_date or (_current_history_date() if business_day else today_ph())
    start, end = _history_day_bounds_utc(selected) if business_day else ph_day_bounds_utc(selected)
    tx_day = _page_rows(db.table("transactions").select("*").gte("opened_at", start).lte("opened_at", end)
                        .order("opened_at").order("id"))
    digital_day = _page_rows(db.table("digital_orders").select("*").gte("created_at", start).lte("created_at", end)
                             .order("created_at").order("id"))
    digital_day_ids = {row["id"] for row in digital_day}
    tx_by_id = {row["id"]: row for row in tx_day}
    linked_ids = [row["transaction_id"] for row in digital_day if row.get("transaction_id") and row["transaction_id"] not in tx_by_id]
    for row in _batch(db, "transactions", "*", "id", linked_ids):
        tx_by_id[row["id"]] = row
    tx_ids = list(tx_by_id)
    digital_for_tx = _batch(db, "digital_orders", "id,transaction_id,created_at", "transaction_id", [row["id"] for row in tx_day])
    linked_transaction_ids = {row["transaction_id"] for row in digital_for_tx if row.get("transaction_id")}

    item_fields = "id,transaction_id,product_size_id,quantity,unit_price,held_ingredients"
    if _item_discounts_supported_check(db):
        item_fields += ",discount_type_id,discount_name,discount_percentage,discount_amount"
    items = _batch(db, "transaction_items", item_fields, "transaction_id", tx_ids)
    digital_ids = list(digital_day_ids)
    digital_items = _batch(db, "digital_order_items", "id,digital_order_id,product_size_id,quantity,unit_price,held_ingredients", "digital_order_id", digital_ids)
    item_addons = _batch(db, "transaction_item_addons", "id,transaction_item_id,quantity,unit_price,menu_addons(name)", "transaction_item_id", [row["id"] for row in items]) if _transaction_item_addons_supported_check(db) else []
    digital_addons = _batch(db, "digital_order_addons", "id,digital_order_id,quantity,unit_price,menu_addons(name)", "digital_order_id", digital_ids)
    for addon in item_addons + digital_addons:
        addon["addon_name"] = (addon.pop("menu_addons", None) or {}).get("name")
    deliveries_tx = _batch(db, "deliveries", "*", "transaction_id", tx_ids)
    deliveries_digital = _batch(db, "deliveries", "*", "digital_order_id", digital_ids)
    sizes = {row["id"]: row for row in _batch(db, "product_sizes", "id,size_label,products(name)", "id",
            list({row["product_size_id"] for row in items + digital_items}))}
    discount_types = {row["id"]: row for row in _batch(db, "discount_types", "id,name,percentage", "id",
                      list({row["discount_type_id"] for row in tx_by_id.values() if row.get("discount_type_id")}))}
    refunds = _group(_batch(db, "refunds", "id,transaction_id,status,reason,requested_at", "transaction_id", tx_ids), "transaction_id")
    cash_refunds = _group(_batch(db, "shift_cash_movements", "id,transaction_id,amount", "transaction_id", tx_ids), "transaction_id")
    cash_refunds = {key: [row for row in rows if row.get("transaction_id")] for key, rows in cash_refunds.items()}
    staff = {row["id"]: row for row in _batch(db, "profiles", "id,full_name", "id",
             list({row["employee_id"] for row in tx_by_id.values() if row.get("employee_id")}))}

    parts = (
        _group(items, "transaction_id"), _group(digital_items, "digital_order_id"),
        _group(item_addons, "transaction_item_id"), _group(digital_addons, "digital_order_id"),
        {row["transaction_id"]: row for row in deliveries_tx},
        {row["digital_order_id"]: row for row in deliveries_digital},
        sizes, discount_types, refunds, cash_refunds, staff,
    )
    history = [_build_entry(tx_by_id.get(row.get("transaction_id")), row, *parts) for row in digital_day]
    for row in tx_day:
        # A linked digital order belongs to its own placed date. That date's
        # digital row is the canonical history entry, even for an advance
        # transaction opened days later.
        if row["id"] not in linked_transaction_ids:
            history.append(_build_entry(row, None, *parts))
    history.sort(key=lambda row: (row["placed_at"], row["id"]), reverse=True)
    return history
