"""Bundle fulfillment: explicit recipes, atomic writes, and legacy safeguards."""
from collections import defaultdict

from fastapi import HTTPException
from postgrest.exceptions import APIError


def atomic_bundles_available(db) -> bool:
    # Do not cache a missing migration across a rolling deployment.
    try:
        db.table("bundle_fulfillment_batches").select("transaction_item_id").limit(1).execute()
        return True
    except APIError as exc:
        if exc.code in {"PGRST205", "42P01"}:
            return False
        raise


def pending_bundle_item_ids(db, item_ids: list[str]) -> set[str]:
    """Active record-only batches; absent migration leaves old order reads intact."""
    if not item_ids:
        return set()
    pending: set[str] = set()
    try:
        for start in range(0, len(item_ids), 200):
            rows = (db.table("bundle_pending_deductions")
                    .select("transaction_item_id,resolved_at")
                    .in_("transaction_item_id", item_ids[start:start + 200])
                    .is_("resolved_at", "null").execute().data)
            pending.update(row["transaction_item_id"] for row in rows)
    except APIError as exc:
        if exc.code in {"PGRST205", "42P01"}:
            return set()
        raise
    return pending


def bundle_rpc(db, name: str, params: dict):
    try:
        return db.rpc(name, params).execute().data
    except APIError as exc:
        if exc.code in {"PT400", "PT404", "PT409"}:
            raise HTTPException(status_code=int(exc.code[2:]), detail=exc.message) from exc
        if exc.code == "PGRST202":
            raise HTTPException(status_code=503, detail="Bundle fulfillment update is not installed yet. Please contact a manager.") from exc
        raise


def completed_bundle_ids(db, item_ids: list[str]) -> set[str]:
    """Legacy rows count only if their TOTAL is complete; restored batches do not."""
    completed = set()
    atomic = atomic_bundles_available(db)
    for start in range(0, len(item_ids), 200):
        chunk = item_ids[start:start + 200]
        batches = db.table("bundle_fulfillment_batches").select("transaction_item_id,restored_at").in_("transaction_item_id", chunk).execute().data if atomic else []
        batch_ids = {r["transaction_item_id"] for r in batches}
        completed.update(r["transaction_item_id"] for r in batches if r["restored_at"] is None)
        legacy_ids = [iid for iid in chunk if iid not in batch_ids]
        if not legacy_ids:
            continue
        rows = db.table("bundle_fulfillments").select("transaction_item_id,quantity").in_("transaction_item_id", legacy_ids).execute().data
        totals = defaultdict(int)
        for row in rows:
            totals[row["transaction_item_id"]] += row["quantity"]
        if not totals:
            continue
        items = db.table("transaction_items").select("id,quantity,product_sizes(bundle_components(total_pieces))").in_("id", list(totals)).execute().data
        for item in items:
            config = (item.get("product_sizes") or {}).get("bundle_components")
            if isinstance(config, list):
                config = config[0] if len(config) == 1 else None
            if config and totals[item["id"]] == float(item["quantity"]) * config["total_pieces"]:
                completed.add(item["id"])
    return completed


def legacy_recipe_sizes(db, fulfillments: list[dict]) -> dict[str, str]:
    """Historical rows lack snapshots: refuse ambiguity before any reversal."""
    products = list({r["maki_roll_product_id"] for r in fulfillments})
    if not products:
        return {}
    rows = db.table("product_sizes").select("id,product_id").in_("product_id", products).execute().data
    by_product = defaultdict(list)
    for row in rows:
        by_product[row["product_id"]].append(row["id"])
    if any(len(by_product[pid]) != 1 for pid in products):
        raise HTTPException(status_code=409, detail="Historical bundle recipe size is ambiguous. A manager must reconcile its stock deductions before refunding.")
    return {pid: by_product[pid][0] for pid in products}
