"""Paid sales trends for the executive Trend Analysis page."""

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from itertools import combinations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user, require_role_or_grant
from app.deps import get_supabase
from app.ph_time import PH_UTC_OFFSET, today_ph
from app.routers.sales_insights import ID_BATCH_SIZE, _page_rows

router = APIRouter(tags=["analytics"])
PH_TZ = timezone(PH_UTC_OFFSET)


def _batched_rows(db, table: str, columns: str, key: str, ids: list[str]) -> list[dict]:
    rows: list[dict] = []
    for offset in range(0, len(ids), ID_BATCH_SIZE):
        query = (db.table(table).select(columns)
                 .in_(key, ids[offset:offset + ID_BATCH_SIZE]).order("id"))
        rows.extend(_page_rows(query))
    return rows


def _transactions(db, start: datetime, end: datetime) -> list[dict]:
    if end <= start:
        return []
    query = (db.table("transactions")
             .select("id,opened_at,total_amount,order_type,order_source,guest_count,discount_type_id,discount_amount")
             .gte("opened_at", start.astimezone(timezone.utc).isoformat())
             .lt("opened_at", end.astimezone(timezone.utc).isoformat())
             .neq("status", "voided").eq("payment_status", "paid")
             .order("opened_at").order("id"))
    return _page_rows(query)


def _items(db, transactions: list[dict]) -> list[dict]:
    return _batched_rows(
        db, "transaction_items",
        "id,transaction_id,product_size_id,quantity,unit_price,product_sizes(product_id,size_label,products(name,category))",
        "transaction_id", [row["id"] for row in transactions],
    )


def _item_groups(items: list[dict]) -> tuple[dict, dict, dict]:
    products: dict[str, dict] = {}
    sizes: dict[str, dict] = {}
    baskets: dict[str, set[str]] = defaultdict(set)
    for item in items:
        size = item.get("product_sizes") or {}
        product = size.get("products") or {}
        product_id = size.get("product_id")
        size_id = item.get("product_size_id")
        if not product_id or not size_id:
            continue
        quantity = float(item["quantity"])
        gross = quantity * float(item["unit_price"])
        name = product.get("name") or "Unknown product"
        category = product.get("category") or "Uncategorized"
        p = products.setdefault(product_id, {"product_id": product_id, "name": name, "category": category,
                                              "quantity_sold": 0.0, "gross_item_sales": 0.0})
        p["quantity_sold"] += quantity
        p["gross_item_sales"] += gross
        s = sizes.setdefault(size_id, {"product_id": product_id, "product_size_id": size_id,
                                       "product_name": name, "size_label": size.get("size_label") or "Unspecified size",
                                       "quantity_sold": 0.0, "gross_item_sales": 0.0})
        s["quantity_sold"] += quantity
        s["gross_item_sales"] += gross
        baskets[item["transaction_id"]].add(product_id)
    return products, sizes, baskets


def _change(current: float, previous: float) -> float | None:
    return round((current - previous) / previous * 100, 1) if previous else None


def _breakdown(rows: dict, total_revenue: float, total_orders: int, field: str) -> list[dict]:
    return [{field: key, "revenue": value["revenue"], "order_count": value["order_count"],
             "revenue_share_pct": value["revenue"] / total_revenue * 100 if total_revenue else 0,
             "order_share_pct": value["order_count"] / total_orders * 100 if total_orders else 0}
            for key, value in sorted(rows.items(), key=lambda pair: (-pair[1]["revenue"], pair[0]))]


@router.get("/analytics/trend-insights")
def trend_insights(
    date_from: date = Query(...), date_to: date = Query(...),
    user: CurrentUser = Depends(get_current_user),
):
    require_role_or_grant(user, "trends", "executive")
    days = (date_to - date_from).days + 1
    if days < 1 or days > 366 or date_to > today_ph():
        raise HTTPException(status_code=400, detail="Choose a valid range of up to one year ending today or earlier")

    start = datetime.combine(date_from, time.min, PH_TZ)
    end = min(datetime.combine(date_to + timedelta(days=1), time.min, PH_TZ), datetime.now(PH_TZ))
    previous_start = start - timedelta(days=days)
    previous_end = previous_start + (end - start)
    db = get_supabase()
    current = _transactions(db, start, end)
    previous = _transactions(db, previous_start, previous_end)
    current_items = _items(db, current)
    previous_items = _items(db, previous)
    products, sizes, baskets = _item_groups(current_items)
    previous_products, _, _ = _item_groups(previous_items)

    revenue = sum(float(row["total_amount"]) for row in current)
    previous_revenue = sum(float(row["total_amount"]) for row in previous)
    order_count, previous_count = len(current), len(previous)
    aov = revenue / order_count if order_count else 0
    previous_aov = previous_revenue / previous_count if previous_count else 0

    digital_rows = _batched_rows(db, "digital_orders", "id,transaction_id,order_channel", "transaction_id", [t["id"] for t in current])
    digital_by_tx = {row["transaction_id"]: row for row in digital_rows}
    source = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    fulfillment = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    daily = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    previous_daily = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    heatmap = defaultdict(int)
    discount_groups = defaultdict(lambda: {"order_count": 0, "order_revenue": 0.0, "discount_amount": 0.0})
    guest_total = guest_orders = 0
    fulfillment_by_tx: dict[str, str] = {}

    for row in current:
        value = float(row["total_amount"])
        origin = row.get("order_source") or "unspecified"
        if origin not in ("pos", "qr", "online", "grab"):
            origin = "unspecified"
        channel = (digital_by_tx.get(row["id"]) or {}).get("order_channel")
        kind = {"dine_in_qr": "dine_in", "pickup": "takeout", "delivery": "delivery"}.get(channel)
        if kind is None:
            kind = row.get("order_type") or ("dine_in" if origin == "qr" else "unspecified")
        if kind not in ("dine_in", "takeout", "delivery"):
            kind = "unspecified"
        fulfillment_by_tx[row["id"]] = kind
        for target in (source[origin], fulfillment[kind]):
            target["revenue"] += value
            target["order_count"] += 1
        opened = datetime.fromisoformat(row["opened_at"].replace("Z", "+00:00")).astimezone(PH_TZ)
        daily[opened.date().isoformat()]["revenue"] += value
        daily[opened.date().isoformat()]["order_count"] += 1
        heatmap[(opened.weekday(), opened.hour)] += 1
        if kind == "dine_in" and row.get("guest_count"):
            guest_total += int(row["guest_count"])
            guest_orders += 1
        if row.get("discount_type_id") or float(row.get("discount_amount") or 0) > 0:
            key = row.get("discount_type_id") or "unspecified"
            group = discount_groups[key]
            group["order_count"] += 1
            group["order_revenue"] += value
            group["discount_amount"] += float(row.get("discount_amount") or 0)

    for row in previous:
        opened = datetime.fromisoformat(row["opened_at"].replace("Z", "+00:00")).astimezone(PH_TZ)
        previous_daily[opened.date().isoformat()]["revenue"] += float(row["total_amount"])
        previous_daily[opened.date().isoformat()]["order_count"] += 1

    discount_names = {r["id"]: r["name"] for r in _batched_rows(db, "discount_types", "id,name", "id", [k for k in discount_groups if k != "unspecified"])}
    discounts = [{"name": discount_names.get(key, "Unspecified discount"), **value,
                  "order_share_pct": value["order_count"] / order_count * 100 if order_count else 0,
                  "revenue_share_pct": value["order_revenue"] / revenue * 100 if revenue else 0}
                 for key, value in discount_groups.items()]
    discounts.sort(key=lambda row: (-row["discount_amount"], row["name"]))

    categories = defaultdict(lambda: {"quantity_sold": 0.0, "gross_item_sales": 0.0})
    for item in products.values():
        group = categories[item["category"]]
        group["quantity_sold"] += item["quantity_sold"]
        group["gross_item_sales"] += item["gross_item_sales"]
    gross_total = sum(row["gross_item_sales"] for row in products.values())
    category_rows = [{"category": name, **value,
                      "share_pct": value["gross_item_sales"] / gross_total * 100 if gross_total else 0}
                     for name, value in categories.items()]
    category_rows.sort(key=lambda row: (-row["gross_item_sales"], row["category"]))

    movers = []
    for product in products.values():
        prior_units = previous_products.get(product["product_id"], {}).get("quantity_sold", 0)
        movers.append({**product, "previous_quantity_sold": prior_units,
                       "quantity_change_pct": _change(product["quantity_sold"], prior_units)})
    movers.sort(key=lambda row: (-row["gross_item_sales"], row["name"]))
    active_catalog = _page_rows(db.table("products").select("id,name,category").eq("active", True).order("id"))
    slowest = [{"product_id": row["id"], "name": row["name"], "category": row.get("category") or "Uncategorized",
                "quantity_sold": products.get(row["id"], {}).get("quantity_sold", 0),
                "gross_item_sales": products.get(row["id"], {}).get("gross_item_sales", 0)}
               for row in active_catalog]
    slowest.sort(key=lambda row: (row["quantity_sold"], row["name"]))

    pairs = defaultdict(int)
    for product_set in baskets.values():
        for pair in combinations(sorted(product_set), 2):
            pairs[pair] += 1
    pair_rows = [{"product_a": products[a]["name"], "product_b": products[b]["name"],
                  "order_count": count, "order_share_pct": count / order_count * 100 if order_count else 0}
                 for (a, b), count in pairs.items()]
    pair_rows.sort(key=lambda row: (-row["order_count"], row["product_a"], row["product_b"]))

    order_by_item = {item["id"]: item["transaction_id"] for item in current_items}
    pos_addons = _batched_rows(db, "transaction_item_addons", "id,transaction_item_id,addon_id,quantity,unit_price,menu_addons(name)",
                               "transaction_item_id", list(order_by_item))
    digital_by_id = {row["id"]: row["transaction_id"] for row in digital_rows}
    digital_addons = _batched_rows(db, "digital_order_addons", "id,digital_order_id,addon_id,quantity,unit_price,menu_addons(name)",
                                   "digital_order_id", list(digital_by_id))
    attached_orders = set()
    addons = defaultdict(lambda: {"quantity": 0, "gross_sales": 0.0})
    for row in pos_addons + digital_addons:
        tx_id = order_by_item.get(row.get("transaction_item_id")) or digital_by_id.get(row.get("digital_order_id"))
        if not tx_id:
            continue
        attached_orders.add(tx_id)
        key = (row["addon_id"], (row.get("menu_addons") or {}).get("name") or "Unknown add-on")
        addons[key]["quantity"] += int(row["quantity"])
        addons[key]["gross_sales"] += int(row["quantity"]) * float(row["unit_price"])
    addon_rows = [{"addon_id": key[0], "name": key[1], **value} for key, value in addons.items()]
    addon_rows.sort(key=lambda row: (-row["quantity"], row["name"]))

    delivery_ids = [tx_id for tx_id, kind in fulfillment_by_tx.items() if kind == "delivery"]
    delivery_digital_ids = [digital_by_tx[tx_id]["id"] for tx_id in delivery_ids if tx_id in digital_by_tx]
    delivery_rows = (_batched_rows(db, "deliveries", "id,transaction_id,digital_order_id,barangay", "transaction_id", delivery_ids)
                     + _batched_rows(db, "deliveries", "id,transaction_id,digital_order_id,barangay", "digital_order_id", delivery_digital_ids))
    barangay_by_tx = {}
    for row in delivery_rows:
        tx_id = row.get("transaction_id") or digital_by_id.get(row.get("digital_order_id"))
        if tx_id:
            barangay_by_tx[tx_id] = row.get("barangay") or "Unspecified"
    barangays = defaultdict(lambda: {"revenue": 0.0, "order_count": 0})
    for row in current:
        if fulfillment_by_tx[row["id"]] == "delivery":
            target = barangays[barangay_by_tx.get(row["id"], "Unspecified")]
            target["revenue"] += float(row["total_amount"])
            target["order_count"] += 1

    daily_points = []
    for index in range(days):
        day = date_from + timedelta(days=index)
        prior = day - timedelta(days=days)
        daily_points.append({"date": day.isoformat(), "previous_date": prior.isoformat(),
                             **daily[day.isoformat()], "previous_revenue": previous_daily[prior.isoformat()]["revenue"],
                             "previous_order_count": previous_daily[prior.isoformat()]["order_count"]})
    size_rows = [{**row, "share_of_product_pct": row["quantity_sold"] / products[row["product_id"]]["quantity_sold"] * 100}
                 for row in sizes.values()]
    size_rows.sort(key=lambda row: (-products[row["product_id"]]["gross_item_sales"], row["product_name"], -row["quantity_sold"]))

    return {
        "date_from": date_from, "date_to": date_to, "as_of": end, "comparison_start": previous_start,
        "comparison_end": previous_end, "partial_current_day": date_to == today_ph(),
        "kpis": {"revenue": revenue, "previous_revenue": previous_revenue, "revenue_change_pct": _change(revenue, previous_revenue),
                 "order_count": order_count, "previous_order_count": previous_count, "order_change_pct": _change(order_count, previous_count),
                 "average_order_value": aov, "previous_average_order_value": previous_aov,
                 "average_order_value_change_pct": _change(aov, previous_aov)},
        "daily": daily_points,
        "heatmap": [{"weekday": day, "hour": hour, "order_count": heatmap[(day, hour)]} for day in range(7) for hour in range(24)],
        "sources": _breakdown(source, revenue, order_count, "source"),
        "fulfillment": _breakdown(fulfillment, revenue, order_count, "fulfillment"),
        "categories": category_rows, "gross_item_sales": gross_total,
        "top_products": movers[:10], "slowest_products": slowest[:10], "pairings": pair_rows[:10],
        "addon_attach": {"order_count": len(attached_orders), "rate_pct": len(attached_orders) / order_count * 100 if order_count else 0,
                         "addons": addon_rows[:15]},
        "sizes": size_rows,
        "discounts": discounts,
        "barangays": [{"barangay": name, **totals} for name, totals in sorted(barangays.items(), key=lambda pair: (-pair[1]["revenue"], pair[0]))],
        "dine_in_guests": {"average": guest_total / guest_orders if guest_orders else None,
                           "orders_with_count": guest_orders, "dine_in_orders": fulfillment["dine_in"]["order_count"]},
    }
