"""Standard platter mix (migration 0090), taken from stock at sale.

Small Platter = California 8 + Crazy 8 + Dragon 8 + Torikatsu 8, and so on.
Right after checkout each platter line is fulfilled with its mix times the
quantity (auto_fulfill_bundle_atomic), so its rolls' recipes come off stock
without anyone logging rolls. The Kitchen Display can still change it per
order (refulfill_bundle_atomic). A platter with no saved mix keeps the old
"Log rolls used" flow.
"""
import logging

from cachetools import TTLCache
from postgrest.exceptions import APIError

log = logging.getLogger(__name__)

ROLL_CATEGORY = "Oishii Maki Rolls"
BOAT_EXCLUDED = {"Dragon Maki", "Oishii Maki"}  # same rule as fulfill_bundle_atomic
_MISSING = {"PGRST205", "42P01", "PGRST202", "42703"}
_cache: TTLCache = TTLCache(maxsize=1, ttl=300)


def clear_cache() -> None:
    _cache.clear()


def roll_allowed(platter_name: str, roll: dict) -> bool:
    return (bool(roll.get("active", True)) and not roll.get("is_bundle")
            and roll.get("category") == ROLL_CATEGORY
            and not ("Sushi Boat" in (platter_name or "") and roll.get("name") in BOAT_EXCLUDED))


def all_mixes(db) -> dict[str, list[dict]]:
    """size id -> [{roll_product_id, pieces}]. {} before 0090."""
    if "all" not in _cache:
        try:
            rows = db.table("bundle_default_mix").select("product_size_id, roll_product_id, pieces").execute().data or []
        except APIError as exc:
            if exc.code in _MISSING:
                return {}
            raise
        mixes: dict[str, list[dict]] = {}
        for r in rows:
            mixes.setdefault(r["product_size_id"], []).append(
                {"roll_product_id": r["roll_product_id"], "pieces": int(r["pieces"])})
        _cache["all"] = mixes
    return _cache["all"]


def auto_fulfill(db, transaction_id: str, inserted_items: list[dict], bundle_size_ids: set[str], employee_id: str) -> int:
    """Best effort: a failure never blocks the sale; the line just stays
    "Log rolls used" on the Kitchen Display. Returns platters fulfilled."""
    lines = [i for i in inserted_items if i.get("product_size_id") in bundle_size_ids]
    if not lines:
        return 0
    try:
        mixes = all_mixes(db)
    except Exception:  # pragma: no cover - never block a sale
        log.exception("could not read platter mixes")
        return 0
    done = 0
    for item in lines:
        mix = mixes.get(item["product_size_id"])
        qty = float(item.get("quantity") or 0)
        if not mix or qty <= 0 or qty != int(qty):
            continue
        try:
            db.rpc("auto_fulfill_bundle_atomic", {
                "p_transaction_id": transaction_id, "p_item_id": item["id"], "p_employee_id": employee_id,
                "p_lines": [{"maki_roll_product_id": m["roll_product_id"], "quantity": m["pieces"] * int(qty)} for m in mix],
            }).execute()
            done += 1
        except Exception:
            log.exception("platter %s: standard mix not taken", item["id"])
    return done


def undo_auto(db, transaction_id: str, item_ids: list[str], employee_id: str) -> set[str]:
    """Order edit: undo sale-time mixes the kitchen never confirmed. Returns
    the items that are free to change now."""
    freed = set()
    if not item_ids:
        return freed
    try:
        rows = (db.table("bundle_fulfillment_batches").select("transaction_item_id, auto_mix, restored_at")
                .in_("transaction_item_id", item_ids).execute().data or [])
    except APIError as exc:
        if exc.code in _MISSING:
            return freed
        raise
    for r in rows:
        if r.get("auto_mix") and r.get("restored_at") is None:
            if db.rpc("unfulfill_bundle_atomic", {"p_transaction_id": transaction_id, "p_item_id": r["transaction_item_id"],
                                                  "p_employee_id": employee_id}).execute().data:
                freed.add(r["transaction_item_id"])
    return freed


def auto_item_ids(db, item_ids: list[str]) -> set[str]:
    if not item_ids:
        return set()
    try:
        rows = (db.table("bundle_fulfillment_batches").select("transaction_item_id, auto_mix, restored_at")
                .in_("transaction_item_id", item_ids).execute().data or [])
    except APIError as exc:
        if exc.code in _MISSING:
            return set()
        raise
    return {r["transaction_item_id"] for r in rows if r.get("auto_mix") and r.get("restored_at") is None}
