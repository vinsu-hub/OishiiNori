"""Menu catalog management (manager/executive/employee): create/edit/deactivate
products, manage per-size prices, edit recipe (ingredient) components, and
replace a product's photo via real Supabase Storage upload.

WS-11 (client decision): cashiers may edit the menu, so this router is open to
every role past "logged in" -- unlike the rest of the money/oversight surface,
which stays manager+/executive-only.

Kept as its own router (rather than folding into products.py/recipes.py,
which stay read-focused) to match this codebase's router-per-domain
convention -- see discounts.py/hr.py for the same fetch-then-404,
exclude_unset-update, manual require_role() shape this file follows.

JUDGMENT CALL: "delete" is soft-delete only (products.active flag, already
used to filter GET /products?active_only=true) -- product_sizes and
products are referenced by transaction_items/digital_order_items/
loss_records with restrictive FKs, so a hard product delete would fail (or
destroy sales history) the moment an item has ever been sold. A real hard
DELETE is only offered for product_sizes/recipe_items, i.e. sub-rows the
executive is actively editing, not top-level catalog history.
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user, require_role
from app.deps import get_supabase
from app import platter_mix
from app.bundles import atomic_bundles_available, bundle_rpc
from app.routers.recipes import _get_recipe_data
from app.schemas import (
    ProductCreate,
    BundleRecipeSource,
    ClosePendingIn,
    PlatterMixIn,
    PlatterMixOut,
    PendingBundleDeductionOut,
    PublishBundleRecipeRequest,
    PublishBundleRecipeResponse,
    ProductOut,
    ProductSizeCreate,
    ProductSizeOut,
    ProductSizeUpdate,
    ProductUpdate,
    RecipeItemCreate,
    RecipeItemOut,
    RecipeItemUpdate,
)

router = APIRouter(tags=["menu_admin"])

STORAGE_BUCKET = "product-images"
ALLOWED_IMAGE_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


@router.get("/products/{product_id}/bundle-recipe", response_model=BundleRecipeSource | None)
def get_bundle_recipe(product_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive", "employee")
    db = get_supabase()
    if not atomic_bundles_available(db):
        raise HTTPException(status_code=503, detail="Bundle recipe configuration requires migration 0063")
    rows = db.table("bundle_recipe_sources").select("product_size_id,pieces_per_serving").eq("product_id", product_id).execute().data
    return rows[0] if rows else None


@router.put("/products/{product_id}/bundle-recipe", response_model=BundleRecipeSource)
def set_bundle_recipe(product_id: str, body: BundleRecipeSource, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive", "employee")
    db = get_supabase()
    if not atomic_bundles_available(db):
        raise HTTPException(status_code=503, detail="Bundle recipe configuration requires migration 0063")
    rows = db.table("products").select("category,is_bundle").eq("id", product_id).execute().data
    if not rows or rows[0]["is_bundle"] or rows[0]["category"] != "Oishii Maki Rolls":
        raise HTTPException(status_code=400, detail="Only maki flavors can supply bundle recipes")
    sizes = db.table("product_sizes").select("id").eq("id", body.product_size_id).eq("product_id", product_id).execute().data
    if not sizes:
        raise HTTPException(status_code=400, detail="Recipe size must belong to this flavor")
    recipes = db.table("recipe_items").select("id").eq("product_size_id", body.product_size_id).limit(1).execute().data
    if not recipes:
        raise HTTPException(status_code=400, detail="Save the recipe ingredients for this size first")
    db.table("bundle_recipe_sources").upsert({"product_id": product_id, **body.model_dump()}).execute()
    return body


def _pending_bundle_rows(db) -> list[dict]:
    """Read-only manager queue; restored batches never appear as pending."""
    pending = (db.table("bundle_pending_deductions")
               .select("transaction_item_id,reason,created_at")
               .is_("resolved_at", "null").execute().data)
    if not pending:
        return []
    ids = [row["transaction_item_id"] for row in pending]
    batches = (db.table("bundle_fulfillment_batches").select("transaction_item_id,restored_at")
               .in_("transaction_item_id", ids).execute().data)
    active_ids = {row["transaction_item_id"] for row in batches if row["restored_at"] is None}
    pending = [row for row in pending if row["transaction_item_id"] in active_ids]
    if not pending:
        return []
    items = (db.table("transaction_items")
             .select("id,transaction_id,product_sizes(products(name))")
             .in_("id", [row["transaction_item_id"] for row in pending]).execute().data)
    by_id = {row["id"]: row for row in items}
    transactions = (db.table("transactions").select("id,order_number,status")
                    .in_("id", list({row["transaction_id"] for row in items})).execute().data) if items else []
    tx_by_id = {row["id"]: row for row in transactions}
    blocking = _blocking_rolls(db, [row["transaction_item_id"] for row in pending])
    result = []
    for row in pending:
        item = by_id.get(row["transaction_item_id"])
        if not item:
            continue
        tx = tx_by_id.get(item["transaction_id"], {})
        if tx.get("status") == "voided":
            continue
        result.append({
            **row,
            "transaction_id": item["transaction_id"],
            "order_number": tx.get("order_number"),
            "product_name": ((item.get("product_sizes") or {}).get("products") or {}).get("name") or "Platter",
            "blocking_rolls": blocking.get(row["transaction_item_id"], []),
        })
    return sorted(result, key=lambda row: row["created_at"])


def _blocking_rolls(db, item_ids: list[str]) -> dict[str, list[str]]:
    """item id -> rolls whose recipe has a line not in its ingredient's unit."""
    if not item_ids:
        return {}
    lines = []
    for start in range(0, len(item_ids), 200):
        lines += (db.table("bundle_fulfillments").select("transaction_item_id, product_size_id, products(name)")
                  .in_("transaction_item_id", item_ids[start:start + 200]).execute().data or [])
    size_ids = list({r["product_size_id"] for r in lines if r.get("product_size_id")})
    recipe = (db.table("recipe_items").select("product_size_id, unit, ingredients(base_unit)")
              .in_("product_size_id", size_ids).execute().data or []) if size_ids else []
    bad = {r["product_size_id"] for r in recipe
           if (r.get("ingredients") or {}).get("base_unit") is not None and r["unit"] != r["ingredients"]["base_unit"]}
    out: dict[str, list[str]] = {}
    for r in lines:
        if r.get("product_size_id") in bad:
            name = (r.get("products") or {}).get("name") or "?"
            if name not in out.setdefault(r["transaction_item_id"], []):
                out[r["transaction_item_id"]].append(name)
    return out


@router.post("/bundle-deductions/pending/close")
def close_pending_bundle_deductions(body: ClosePendingIn, user: CurrentUser = Depends(get_current_user)):
    """Close platter orders that never took stock, without taking it now
    (e.g. old orders before a fresh stock count). Kept for history."""
    require_role(user, "executive")
    db = get_supabase()
    closed = (db.table("bundle_pending_deductions").update({
        "resolved_at": datetime.now(timezone.utc).isoformat(), "closed_without_deduction": True,
        "closed_by": user.id, "closed_note": (body.note or "").strip() or "Closed without deduction",
    }).in_("transaction_item_id", body.transaction_item_ids).is_("resolved_at", "null").execute().data or [])
    return {"closed": len(closed)}


def _platter_sizes(db, size_id: str | None = None) -> list[dict]:
    q = db.table("bundle_components").select("product_size_id, total_pieces, product_sizes(size_label, products(name, active))")
    if size_id:
        q = q.eq("product_size_id", size_id)
    return q.execute().data or []


@router.get("/platter-mixes", response_model=list[PlatterMixOut])
def list_platter_mixes(user: CurrentUser = Depends(get_current_user)):
    """Every platter size with its standard mix (empty = kitchen logs rolls).
    Any signed-in user: the Kitchen Display pre-fills its checklist from it."""
    db = get_supabase()
    rolls = (db.table("products").select("id, name, active, is_bundle, category")
             .eq("category", platter_mix.ROLL_CATEGORY).execute().data or [])
    mixes = platter_mix.all_mixes(db)
    out = []
    for row in _platter_sizes(db):
        size = row.get("product_sizes") or {}
        product = size.get("products") or {}
        if not product.get("active", True):
            continue
        name = product.get("name") or "Platter"
        out.append(PlatterMixOut(
            product_size_id=row["product_size_id"], platter_name=name, size_label=size.get("size_label") or "",
            total_pieces=int(row["total_pieces"] or 0), lines=mixes.get(row["product_size_id"], []),
            allowed_rolls=[{"id": r["id"], "name": r["name"]} for r in sorted(rolls, key=lambda r: r["name"])
                           if platter_mix.roll_allowed(name, r)],
        ))
    return sorted(out, key=lambda m: (m.platter_name, m.total_pieces))


@router.put("/product-sizes/{size_id}/platter-mix", response_model=PlatterMixOut)
def save_platter_mix(size_id: str, body: PlatterMixIn, user: CurrentUser = Depends(get_current_user)):
    """Save a platter's standard mix. No lines = back to the kitchen logging rolls."""
    require_role(user, "manager", "executive")
    db = get_supabase()
    rows = _platter_sizes(db, size_id)
    if not rows:
        raise HTTPException(status_code=404, detail="This isn't a platter size")
    total = int(rows[0]["total_pieces"] or 0)
    name = ((rows[0].get("product_sizes") or {}).get("products") or {}).get("name") or "Platter"
    merged: dict[str, int] = {}
    for line in body.lines:
        merged[line.roll_product_id] = merged.get(line.roll_product_id, 0) + line.pieces
    if merged:
        if sum(merged.values()) != total:
            raise HTTPException(status_code=400, detail=f"The rolls add up to {sum(merged.values())} pcs; {name} is {total} pcs")
        rolls = {r["id"]: r for r in (db.table("products").select("id, name, active, is_bundle, category")
                                      .in_("id", list(merged)).execute().data or [])}
        for rid in merged:
            if rid not in rolls or not platter_mix.roll_allowed(name, rolls[rid]):
                raise HTTPException(status_code=400, detail=f"{rolls.get(rid, {}).get('name', 'That roll')} can't go in {name}")
        sources = {r["product_id"] for r in (db.table("bundle_recipe_sources").select("product_id")
                                              .in_("product_id", list(merged)).execute().data or [])}
        missing = [rolls[rid]["name"] for rid in merged if rid not in sources]
        if missing:
            raise HTTPException(status_code=400, detail=f"Set the platter recipe size first for: {', '.join(missing)}")
    db.table("bundle_default_mix").delete().eq("product_size_id", size_id).execute()
    if merged:
        db.table("bundle_default_mix").insert([
            {"product_size_id": size_id, "roll_product_id": rid, "pieces": pcs, "updated_by": user.id}
            for rid, pcs in merged.items()
        ]).execute()
    platter_mix.clear_cache()
    return next(m for m in list_platter_mixes(user) if m.product_size_id == size_id)


@router.get("/bundle-deductions/pending", response_model=list[PendingBundleDeductionOut])
def get_pending_bundle_deductions(user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive")
    try:
        return _pending_bundle_rows(get_supabase())
    except APIError as exc:
        if exc.code in {"PGRST205", "42P01"}:
            return []
        raise


@router.put("/product-sizes/{size_id}/bundle-recipe-publish", response_model=PublishBundleRecipeResponse)
def publish_bundle_recipe(
    size_id: str,
    body: PublishBundleRecipeRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Save a whole roll recipe, then apply any newly resolvable pending stock.

    The recipe RPC commits before reconciliation starts. A stock error never
    undoes an accepted recipe or changes orders; the pending batch stays
    visible for retry rather than pretending the deduction succeeded.
    """
    require_role(user, "manager", "executive")
    db = get_supabase()
    bundle_rpc(db, "publish_bundle_recipe_atomic", {
        "p_size_id": size_id,
        "p_rows": [row.model_dump() for row in body.items],
    })
    related = (db.table("bundle_fulfillments")
               .select("transaction_item_id").eq("product_size_id", size_id).execute().data)
    related_ids = {row["transaction_item_id"] for row in related}
    pending = _pending_bundle_rows(db)
    candidates = [row for row in pending if row["transaction_item_id"] in related_ids]
    reconciled = 0
    error = None
    for row in candidates:
        try:
            if bundle_rpc(db, "reconcile_pending_bundle_atomic", {
                "p_item_id": row["transaction_item_id"], "p_employee_id": user.id,
            }):
                reconciled += 1
        except (HTTPException, APIError) as exc:
            error = str(getattr(exc, "detail", None) or getattr(exc, "message", None) or exc)
            # One failed platter must not prevent an independent one from
            # reconciling. It remains in the pending queue for review/retry.
    remaining = len([row for row in _pending_bundle_rows(db) if row["transaction_item_id"] in related_ids])
    return PublishBundleRecipeResponse(
        recipe_items=_get_recipe_data(db, size_id),
        reconciled_batches=reconciled,
        still_pending_batches=remaining,
        reconciliation_error=error,
    )


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------


@router.post("/products", response_model=ProductOut)
def create_product(body: ProductCreate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive", "employee")
    supabase = get_supabase()

    product_result = (
        supabase.table("products")
        .insert(
            {
                "name": body.name,
                "category": body.category,
                "station": body.station,
                "department": body.department,
            }
        )
        .execute()
    )
    product = product_result.data[0]

    sizes_result = (
        supabase.table("product_sizes")
        .insert(
            [
                {
                    "product_id": product["id"],
                    "size_label": s.size_label,
                    "price": s.price,
                    "scale_factor": s.scale_factor,
                    "sort_order": s.sort_order,
                }
                for s in body.sizes
            ]
        )
        .execute()
    )
    for s in sizes_result.data:
        s["availability"] = "available"
        s["total_pieces"] = None
    product["sizes"] = sizes_result.data
    return product


@router.patch("/products/{product_id}", response_model=ProductOut)
def update_product(product_id: str, body: ProductUpdate, user: CurrentUser = Depends(get_current_user)):
    """Also how deactivate/reactivate happens -- pass {"active": false} or
    {"active": true}; no separate endpoint for that, matching the locked
    soft-delete decision."""
    require_role(user, "manager", "executive", "employee")
    supabase = get_supabase()

    existing = supabase.table("products").select("id").eq("id", product_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Product not found")

    update_data = body.model_dump(exclude_unset=True)
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = supabase.table("products").update(update_data).eq("id", product_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Product not found")

    product = result.data[0]
    sizes_result = (
        supabase.table("product_sizes")
        .select("*")
        .eq("product_id", product_id)
        .order("sort_order")
        .execute()
    )
    for s in sizes_result.data:
        s["availability"] = "available"
        s["total_pieces"] = None
    product["sizes"] = sizes_result.data
    return product


# ---------------------------------------------------------------------------
# Product sizes
# ---------------------------------------------------------------------------


@router.post("/products/{product_id}/sizes", response_model=ProductSizeOut)
def create_product_size(
    product_id: str, body: ProductSizeCreate, user: CurrentUser = Depends(get_current_user)
):
    require_role(user, "manager", "executive", "employee")
    supabase = get_supabase()

    existing = supabase.table("products").select("id").eq("id", product_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Product not found")

    try:
        result = (
            supabase.table("product_sizes")
            .insert(
                {
                    "product_id": product_id,
                    "size_label": body.size_label,
                    "price": body.price,
                    "scale_factor": body.scale_factor,
                    "sort_order": body.sort_order,
                }
            )
            .execute()
        )
    except APIError:
        raise HTTPException(status_code=409, detail="This product already has a size with that label")

    size = result.data[0]
    size["availability"] = "available"
    size["total_pieces"] = None
    return size


@router.patch("/product-sizes/{size_id}", response_model=ProductSizeOut)
def update_product_size(
    size_id: str, body: ProductSizeUpdate, user: CurrentUser = Depends(get_current_user)
):
    require_role(user, "manager", "executive", "employee")
    supabase = get_supabase()

    existing = supabase.table("product_sizes").select("id").eq("id", size_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Product size not found")

    update_data = body.model_dump(exclude_unset=True)
    try:
        result = supabase.table("product_sizes").update(update_data).eq("id", size_id).execute()
    except APIError:
        raise HTTPException(status_code=409, detail="This product already has a size with that label")
    if not result.data:
        raise HTTPException(status_code=404, detail="Product size not found")

    size = result.data[0]
    size["availability"] = "available"
    size["total_pieces"] = None
    return size


@router.delete("/product-sizes/{size_id}")
def delete_product_size(size_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive", "employee")
    supabase = get_supabase()

    existing = (
        supabase.table("product_sizes").select("id, product_id").eq("id", size_id).maybe_single().execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Product size not found")

    sibling_count = (
        supabase.table("product_sizes")
        .select("id", count="exact")
        .eq("product_id", existing.data["product_id"])
        .execute()
    )
    if (sibling_count.count or 0) <= 1:
        raise HTTPException(
            status_code=400,
            detail="A product must have at least one size -- deactivate the product instead of removing its last size",
        )

    try:
        supabase.table("product_sizes").delete().eq("id", size_id).execute()
    except APIError:
        raise HTTPException(
            status_code=409,
            detail="This size can't be removed -- it has existing sales or order history",
        )
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Recipe items
# ---------------------------------------------------------------------------

# Same thing, different spelling: stored as the ingredient's own unit.
_UNIT_ALIASES = [{"pc", "pcs", "piece", "pieces"}, {"g", "gram", "grams"}, {"ml"}, {"kg", "kilo", "kilos"}]


def _recipe_qty_in_base(supabase, ingredient_id: str, qty: float, unit: str | None) -> tuple[float, str]:
    """A recipe line is stored in the ingredient's main unit, so sales,
    platters and counts all agree. A size ("pack", "slice") is converted;
    anything else is refused rather than guessed."""
    ing = (supabase.table("ingredients").select("name, base_unit").eq("id", ingredient_id)
           .maybe_single().execute())
    if not ing or not ing.data:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    base = ing.data["base_unit"]
    u = (unit or "").strip().lower()
    b = (base or "").strip().lower()
    if not u or u == b or any(u in group and b in group for group in _UNIT_ALIASES):
        return qty, base
    sizes = (supabase.table("item_units").select("name, base_qty").eq("ingredient_id", ingredient_id)
             .execute().data or [])
    for size in sizes:
        if size["name"].strip().lower() == u:
            return round(qty * float(size["base_qty"]), 4), base
    names = ", ".join([base] + [s_["name"] for s_ in sizes])
    raise HTTPException(status_code=400, detail=f"{ing.data['name']} is counted in {base}; use one of: {names}")


@router.post("/product-sizes/{size_id}/recipe-items", response_model=RecipeItemOut)
def create_recipe_item(
    size_id: str, body: RecipeItemCreate, user: CurrentUser = Depends(get_current_user)
):
    require_role(user, "manager", "executive", "employee")
    supabase = get_supabase()

    existing = supabase.table("product_sizes").select("id").eq("id", size_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Product size not found")

    qty, unit = _recipe_qty_in_base(supabase, body.ingredient_id, body.qty_per_serving, body.unit)
    try:
        supabase.table("recipe_items").insert(
            {
                "product_size_id": size_id,
                "ingredient_id": body.ingredient_id,
                "qty_per_serving": qty,
                "unit": unit,
                "prep_notes": body.prep_notes,
            }
        ).execute()
    except APIError:
        raise HTTPException(
            status_code=409, detail="This ingredient is already in the recipe -- edit it instead"
        )

    items = _get_recipe_data(supabase, size_id)
    return next(i for i in items if i["ingredient_id"] == body.ingredient_id)


@router.patch("/recipe-items/{item_id}", response_model=RecipeItemOut)
def update_recipe_item(item_id: str, body: RecipeItemUpdate, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive", "employee")
    supabase = get_supabase()

    existing = (
        supabase.table("recipe_items")
        .select("id, product_size_id, ingredient_id, qty_per_serving, unit")
        .eq("id", item_id)
        .maybe_single()
        .execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Recipe item not found")

    update_data = body.model_dump(exclude_unset=True)
    if {"ingredient_id", "qty_per_serving", "unit"} & set(update_data):
        qty, unit = _recipe_qty_in_base(
            supabase,
            update_data.get("ingredient_id") or existing.data["ingredient_id"],
            float(update_data.get("qty_per_serving") or existing.data["qty_per_serving"]),
            update_data.get("unit", existing.data["unit"]),
        )
        update_data.update(qty_per_serving=qty, unit=unit)
    try:
        result = supabase.table("recipe_items").update(update_data).eq("id", item_id).execute()
    except APIError:
        raise HTTPException(
            status_code=409, detail="This ingredient is already in the recipe -- edit it instead"
        )
    if not result.data:
        raise HTTPException(status_code=404, detail="Recipe item not found")

    items = _get_recipe_data(supabase, existing.data["product_size_id"])
    return next(i for i in items if i["id"] == item_id)


@router.delete("/recipe-items/{item_id}")
def delete_recipe_item(item_id: str, user: CurrentUser = Depends(get_current_user)):
    require_role(user, "manager", "executive", "employee")
    supabase = get_supabase()

    existing = supabase.table("recipe_items").select("id").eq("id", item_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Recipe item not found")

    supabase.table("recipe_items").delete().eq("id", item_id).execute()
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Product image upload (Supabase Storage)
# ---------------------------------------------------------------------------


@router.post("/products/{product_id}/image", response_model=ProductOut)
async def upload_product_image(
    product_id: str,
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
):
    """Real file upload to the product-images Storage bucket -- additive to
    (not a replacement of) products.py's PATCH /products/{id}/image, which
    stays as a JSON-only path setter/clearer. This is the only endpoint
    Menu Editing's image tab calls."""
    require_role(user, "manager", "executive", "employee")
    supabase = get_supabase()

    existing = supabase.table("products").select("id").eq("id", product_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Product not found")

    if file.content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail="Only JPEG, PNG, or WEBP images are allowed")

    contents = await file.read()
    if len(contents) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Image must be 5MB or smaller")

    ext = file.filename.rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "jpg"
    storage_path = f"{product_id}/{uuid.uuid4()}.{ext}"

    supabase.storage.from_(STORAGE_BUCKET).upload(
        storage_path, contents, file_options={"content-type": file.content_type}
    )
    public_url = supabase.storage.from_(STORAGE_BUCKET).get_public_url(storage_path)

    updated = (
        supabase.table("products").update({"image_path": public_url}).eq("id", product_id).execute()
    )
    product = updated.data[0]
    sizes_result = (
        supabase.table("product_sizes")
        .select("*")
        .eq("product_id", product_id)
        .order("sort_order")
        .execute()
    )
    for s in sizes_result.data:
        s["availability"] = "available"
        s["total_pieces"] = None
    product["sizes"] = sizes_result.data
    return product
