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
from app.routers.recipes import _get_recipe_data
from app.schemas import (
    ProductCreate,
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
