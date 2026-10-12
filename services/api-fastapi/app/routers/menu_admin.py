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
from app.bundles import atomic_bundles_available, bundle_rpc
from app.routers.recipes import _get_recipe_data
from app.schemas import (
    ProductCreate,
    BundleRecipeSource,
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
        })
    return sorted(result, key=lambda row: row["created_at"])


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


@router.post("/product-sizes/{size_id}/recipe-items", response_model=RecipeItemOut)
def create_recipe_item(
    size_id: str, body: RecipeItemCreate, user: CurrentUser = Depends(get_current_user)
):
    require_role(user, "manager", "executive", "employee")
    supabase = get_supabase()

    existing = supabase.table("product_sizes").select("id").eq("id", size_id).maybe_single().execute()
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Product size not found")

    try:
        supabase.table("recipe_items").insert(
            {
                "product_size_id": size_id,
                "ingredient_id": body.ingredient_id,
                "qty_per_serving": body.qty_per_serving,
                "unit": body.unit,
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
        .select("id, product_size_id")
        .eq("id", item_id)
        .maybe_single()
        .execute()
    )
    if not existing or not existing.data:
        raise HTTPException(status_code=404, detail="Recipe item not found")

    update_data = body.model_dump(exclude_unset=True)
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
