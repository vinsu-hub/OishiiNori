from __future__ import annotations

import re
from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, Field, field_validator

def _is_valid_ph_phone(raw: str) -> bool:
    """Philippine phone number check, mirroring the frontend's
    isValidPhilippinePhone (apps/customer-menu/client/src/lib/validators.ts)
    exactly -- this is the actual enforcement point (a request that
    bypasses the frontend still gets rejected), the frontend copy is just
    a fast fail for UX. Deliberately permissive on landlines; see that
    file's comment for why.
    """
    trimmed = raw.strip()
    has_plus = trimmed.startswith("+")
    digits = re.sub(r"\D", "", trimmed)
    if not digits:
        return False

    local = digits
    if has_plus and digits.startswith("63"):
        local = "0" + digits[2:]
    elif not has_plus and digits.startswith("63") and len(digits) == 12:
        local = "0" + digits[2:]

    if not local.startswith("0") or len(local) < 2:
        return False

    if local[1] == "9":
        return len(local) == 11
    return 9 <= len(local) <= 11


# ---------------------------------------------------------------------------
# Enums (mirror the DB's Postgres enum / check-constraint values)
# ---------------------------------------------------------------------------

UserRole = Literal["employee", "manager", "executive", "stocker", "rider"]
DepartmentType = Literal["kitchen", "cafe"]
KitchenStation = Literal["sushi_bar", "sushi_bar_oven", "hot_line", "salad_cold_bar", "cafe_bar"]
TransactionStatus = Literal["open", "closed", "voided"]
# JUDGMENT CALL: kitchen_status does not exist in the Phase 1 schema (0001-
# 0013) -- see supabase/migrations/0014_phase2_order_fulfillment.sql and the
# report for why this is added here rather than worked around.
KitchenStatus = Literal["queued", "preparing", "ready", "completed"]
OrderType = Literal["dine_in", "takeout", "delivery"]
# Distinct from PaymentMethod below (a plain str, used by digital_orders,
# since its value set is admin-manageable) -- POS's set is fixed (cash,
# gcash, card), and reusing/widening that type would change the
# digital-order schema's own
# semantics.
TransactionPaymentMethod = Literal["cash", "gcash", "card"]
TransactionCardType = Literal["debit", "credit"]
MovementType = Literal[
    "trans_in", "trans_out", "delivery", "transfer_in", "transfer_out", "count_adjustment",
    # Sale-driven stock-item consumption (0028) -- deliberately logged as a
    # movement, unlike recipe-ingredient sale deduction, so Station Items'
    # auto-computed Usage has a summable daily trail to add up.
    "sale_consumption", "sale_consumption_reversal",
]
StockConsumptionTrigger = Literal["per_product_unit", "per_transaction"]
LossReason = Literal["spoilage", "breakage", "comp", "prep_error", "shrinkage"]
UtilityType = Literal["electricity", "water", "gas"]
ProductAvailability = Literal["available", "low_stock", "unavailable"]
DayScenario = Literal[
    "regular_day",
    "regular_holiday",
    "regular_holiday_rest_day",
    "special_non_working",
    "special_non_working_rest_day",
    "special_working",
    "rest_day",
]
HolidayType = Literal["regular_holiday", "special_non_working", "special_working"]
AttendanceStatus = Literal["working", "completed"]
PayrollOverrideField = Literal["regular_hours", "overtime_hours", "night_diff_hours", "day_scenario"]
CostVolatilityTier = Literal["low", "low_medium", "medium", "medium_high", "high"]


# ---------------------------------------------------------------------------
# Products / recipes
# ---------------------------------------------------------------------------


class ProductSizeOut(BaseModel):
    id: str
    product_id: str
    size_label: str
    price: float
    scale_factor: float
    sort_order: int
    availability: ProductAvailability = "available"
    # Only set for a bundle product's size (from bundle_components.total_pieces)
    # -- lets the Kitchen Display checklist know its target total up front
    # instead of only discovering it via a 400 on mismatched submission.
    total_pieces: int | None = None


class ProductOut(BaseModel):
    id: str
    name: str
    category: str
    station: KitchenStation
    department: DepartmentType
    is_bundle: bool
    active: bool
    needs_station_review: bool
    image_path: str | None = None
    sizes: list[ProductSizeOut] = Field(default_factory=list)


class UpdateProductImageRequest(BaseModel):
    image_path: str | None = None


class RecipeItemOut(BaseModel):
    id: str
    product_size_id: str
    ingredient_id: str
    ingredient_name: str
    qty_per_serving: float
    unit: str
    prep_notes: str | None = None
    needs_review: bool = False


# --- Menu Editing (executive-only product/size/recipe CRUD) ---


class ProductSizeCreate(BaseModel):
    size_label: str
    price: float = Field(ge=0)
    scale_factor: float = 1.0
    sort_order: int = 0


class ProductSizeUpdate(BaseModel):
    size_label: str | None = None
    price: float | None = Field(default=None, ge=0)
    scale_factor: float | None = None
    sort_order: int | None = None


class ProductCreate(BaseModel):
    name: str
    category: str
    station: KitchenStation
    department: DepartmentType
    sizes: list[ProductSizeCreate] = Field(min_length=1)


class ProductUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    station: KitchenStation | None = None
    department: DepartmentType | None = None
    active: bool | None = None


class RecipeItemCreate(BaseModel):
    ingredient_id: str
    qty_per_serving: float = Field(gt=0)
    unit: str
    prep_notes: str | None = None


class RecipeItemUpdate(BaseModel):
    ingredient_id: str | None = None
    qty_per_serving: float | None = Field(default=None, gt=0)
    unit: str | None = None
    prep_notes: str | None = None


# ---------------------------------------------------------------------------
# Transactions
# ---------------------------------------------------------------------------


class TransactionItemAddonCreate(BaseModel):
    addon_id: str
    quantity: int = Field(gt=0)


class TransactionItemCreate(BaseModel):
    product_size_id: str
    quantity: float = Field(gt=0)
    held_ingredients: list[str] = Field(default_factory=list)
    addons: list[TransactionItemAddonCreate] = Field(default_factory=list)


class DeliveryDetailOut(BaseModel):
    customer_name: str
    customer_phone: str
    address: str | None = None
    landmark: str | None = None
    barangay: str | None = None
    delivery_fee: float | None = None
    maps_pin_url: str | None = None
    rider_id: str | None = None
    rider_name: str | None = None
    delivered_at: datetime | None = None


class DeliveryCaptureIn(BaseModel):
    """Walk-in delivery info captured on the POS when order_type='delivery'
    -- same field set as CreateDigitalOrderRequest's delivery-only fields,
    so a delivery order looks the same regardless of where it started."""

    customer_name: str
    customer_phone: str
    address: str
    landmark: str | None = None
    barangay: str


class CreateTransactionRequest(BaseModel):
    employee_id: str
    items: list[TransactionItemCreate]
    discount_type_id: str | None = None
    is_owner_request: bool = False
    owner_request_employee_number: str | None = None
    owner_request_pin: str | None = None
    owner_request_note: str | None = None
    order_type: OrderType | None = None
    table_number: int | None = Field(default=None, gt=0)
    guest_count: int | None = Field(default=None, gt=0)
    payment_method: TransactionPaymentMethod | None = None
    card_type: TransactionCardType | None = None
    # Required when order_type == "delivery" (validated in the router,
    # same "requirement depends on another field" posture as
    # CreateDigitalOrderRequest's own delivery fields).
    delivery: DeliveryCaptureIn | None = None
    # Independent of any discount's own vat_exempt -- lets the cashier book
    # an order non-VAT with no VAT-exempt discount applied (POS VAT/Non-VAT
    # toggle). A discount's own vat_exempt still applies regardless of this.
    force_vat_exempt: bool = False
    # Set by the POS when a manager has overridden a reservation-blocked table
    # (see /pos/tables/override). Consumed exactly once by this transaction.
    reservation_override_id: str | None = None
    # Set by the POS when this dine-in order is seating a specific confirmed
    # reservation (Floor Plan "Seat this reservation"). Links the reservation
    # to this transaction and stamps seated_at. Ignored if it doesn't match.
    reservation_id: str | None = None
    # Add Order (WS-14): this sale is additional items for an already-
    # completed transaction, rung up as its own charge/kitchen ticket rather
    # than mutating the closed original. See related_transaction_id below.
    related_transaction_id: str | None = None
    # Set by a client that might retry/replay this exact submission (the POS
    # offline queue, or a retried request whose response was lost) -- see
    # app/idempotency.py. Omitting it keeps today's exact behavior.
    idempotency_key: str | None = None


class TransactionItemAddonResponse(BaseModel):
    id: str
    transaction_item_id: str
    addon_id: str
    addon_name: str | None = None
    quantity: int
    unit_price: float


class TransactionItemResponse(BaseModel):
    id: str
    transaction_id: str
    product_size_id: str
    quantity: float
    unit_price: float
    held_ingredients: list[str] = Field(default_factory=list)
    bundle_fulfilled: bool = False
    addons: list[TransactionItemAddonResponse] = Field(default_factory=list)


class TransactionResponse(BaseModel):
    id: str
    order_number: int | None = None
    employee_id: str
    status: TransactionStatus
    opened_at: datetime
    closed_at: datetime | None = None
    total_amount: float
    discount_type_id: str | None = None
    discount_amount: float
    tax_amount: float
    is_owner_request: bool
    owner_request_by: str | None = None
    owner_request_note: str | None = None
    voided_by: str | None = None
    voided_at: datetime | None = None
    void_reason: str | None = None
    kitchen_status: KitchenStatus = "queued"
    kitchen_status_updated_at: datetime | None = None
    order_type: OrderType | None = None
    table_number: int | None = None
    guest_count: int | None = None
    payment_method: TransactionPaymentMethod | None = None
    card_type: TransactionCardType | None = None
    force_vat_exempt: bool = False
    related_transaction_id: str | None = None
    items: list[TransactionItemResponse] = Field(default_factory=list)
    delivery: DeliveryDetailOut | None = None


class VoidTransactionRequest(BaseModel):
    reason: str


class SwitchTableRequest(BaseModel):
    new_table_number: int = Field(gt=0)


class KitchenStatusUpdateRequest(BaseModel):
    kitchen_status: KitchenStatus


class BundleFulfillmentLine(BaseModel):
    maki_roll_product_id: str
    quantity: int = Field(gt=0)


class BundleFulfillmentRequest(BaseModel):
    lines: list[BundleFulfillmentLine]


class DeductedIngredient(BaseModel):
    ingredient_id: str
    ingredient_name: str
    quantity: float
    unit: str


class BundleFulfillmentResponse(BaseModel):
    transaction_item_id: str
    total_pieces: int
    lines: list[BundleFulfillmentLine]
    ingredients_deducted: list[DeductedIngredient]


# ---------------------------------------------------------------------------
# Digital menu (QR table ordering) -- a digital_orders row is a staging
# area, not a sale. See transactions.py's _create_transaction_row for how
# an approved one becomes a real transaction.
# ---------------------------------------------------------------------------

DigitalOrderStatus = Literal["pending", "approved", "rejected"]
# Was a fixed Literal["gcash", "cash"] -- the set of online payment methods
# is now admin-manageable (online_payment_methods table), so this is a
# plain string: either the literal "cash" (unchanged built-in) or a
# payment method's name, denormalized at order time. Validated against the
# live table (or "cash") in digital_menu.py's submit_digital_order, not
# here, since that requires a DB lookup.
PaymentMethod = str


class DigitalOrderItemCreate(BaseModel):
    product_size_id: str
    quantity: float = Field(gt=0)
    held_ingredients: list[str] = Field(default_factory=list)


class DigitalOrderAddonCreate(BaseModel):
    addon_id: str
    quantity: int = Field(gt=0)


DigitalOrderChannel = Literal["dine_in_qr", "delivery", "pickup"]


class CreateDigitalOrderRequest(BaseModel):
    # Required for dine_in_qr (the per-table QR link), omitted for the
    # general delivery/pickup link -- validated per-channel in the router,
    # not here, since the requirement itself depends on order_channel.
    table_number: int | None = Field(default=None, gt=0)
    order_channel: DigitalOrderChannel = "dine_in_qr"
    items: list[DigitalOrderItemCreate]
    addons: list[DigitalOrderAddonCreate] = Field(default_factory=list)
    payment_method: PaymentMethod
    customer_note: str | None = None
    # Delivery/pickup only -- name+phone always, address+barangay only for
    # an actual delivery (the fee is looked up server-side from barangay,
    # never trusted from the client).
    customer_name: str | None = None
    customer_phone: str | None = None
    address: str | None = None
    landmark: str | None = None
    barangay: str | None = None
    # Set by a client that might retry/replay this exact submission (a flaky
    # connection losing the response, or an offline-queue replay) -- see
    # app/idempotency.py. Omitting it keeps today's exact behavior.
    idempotency_key: str | None = None
    # Advance order (delivery/pickup only): when the customer wants it.
    # Null = as soon as possible. Validated in the router (needs "now").
    scheduled_for: datetime | None = None

    @field_validator("customer_phone")
    @classmethod
    def _validate_customer_phone(cls, v: str | None) -> str | None:
        if v is not None and not _is_valid_ph_phone(v):
            raise ValueError("customer_phone must be a valid Philippine phone number")
        return v


class DeliveryFeeOut(BaseModel):
    barangay: str
    zone: str
    fee: float


class DigitalOrderItemResponse(BaseModel):
    id: str
    digital_order_id: str
    product_size_id: str
    quantity: float
    unit_price: float
    held_ingredients: list[str] = Field(default_factory=list)


class MenuAddonOut(BaseModel):
    id: str
    name: str
    price: float
    active: bool


class DigitalOrderAddonResponse(BaseModel):
    id: str
    digital_order_id: str
    addon_id: str
    addon_name: str | None = None
    quantity: int
    unit_price: float


class DigitalOrderResponse(BaseModel):
    id: str
    order_number: int
    table_number: int | None = None
    order_channel: DigitalOrderChannel = "dine_in_qr"
    status: DigitalOrderStatus
    payment_method: PaymentMethod
    payment_proof_url: str | None = None
    customer_note: str | None = None
    subtotal: float
    approved_by: str | None = None
    approved_at: datetime | None = None
    rejected_reason: str | None = None
    transaction_id: str | None = None
    created_at: datetime
    items: list[DigitalOrderItemResponse] = Field(default_factory=list)
    addons: list[DigitalOrderAddonResponse] = Field(default_factory=list)
    delivery: DeliveryDetailOut | None = None
    # Populated by GET /deliveries only (the rider's "For Pick Up" tab keys
    # off `ready`); None everywhere else and for orders with no transaction yet.
    kitchen_status: str | None = None
    scheduled_for: datetime | None = None


class QueueDisplayOut(BaseModel):
    """Public TV feed: order numbers only, by kitchen stage."""

    preparing: list[int] = Field(default_factory=list)
    ready: list[int] = Field(default_factory=list)


class DigitalOrderStatusResponse(BaseModel):
    """Minimal shape returned to the customer's own unauthenticated polling
    page -- keyed by the unguessable order id, never the sequential
    order_number, so one customer can't enumerate another table's order."""

    id: str
    order_number: int
    table_number: int | None = None
    order_channel: DigitalOrderChannel = "dine_in_qr"
    status: DigitalOrderStatus
    subtotal: float
    rejected_reason: str | None = None
    items: list[DigitalOrderItemResponse] = Field(default_factory=list)
    addons: list[DigitalOrderAddonResponse] = Field(default_factory=list)
    delivery: DeliveryDetailOut | None = None
    scheduled_for: datetime | None = None


class RejectDigitalOrderRequest(BaseModel):
    reason: str | None = None


# ---------------------------------------------------------------------------
# Customer Reviews (public submission -> staff moderation queue)
# ---------------------------------------------------------------------------

ReviewStatus = Literal["pending", "approved", "rejected"]


class CreateReviewRequest(BaseModel):
    is_anonymous: bool = False
    # Required unless is_anonymous -- validated in the router (the
    # requirement depends on another field, same posture as
    # CreateDigitalOrderRequest's delivery-only fields).
    customer_name: str | None = None
    rating: int = Field(ge=1, le=5)
    body: str = Field(min_length=1, max_length=600)
    idempotency_key: str | None = None


class ReviewOut(BaseModel):
    id: str
    is_anonymous: bool
    customer_name: str | None = None
    rating: int
    body: str
    status: ReviewStatus
    rejected_reason: str | None = None
    decided_by: str | None = None
    decided_at: datetime | None = None
    photo_url: str | None = None
    created_at: datetime


class RejectReviewRequest(BaseModel):
    reason: str


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------


class IngredientOut(BaseModel):
    id: str
    name: str
    category: str | None = None
    base_unit: str
    suggested_reorder_unit: str | None = None
    cost_volatility: str | None = None
    cost_volatility_tier: str | None = None
    shelf_life_note: str | None = None
    used_in_note: str | None = None
    current_stock: float
    reorder_threshold: float
    needs_review: bool
    # Most-recent-cost only (not weighted-average) -- set whenever a
    # delivery/trans_in movement is logged with a unit_cost_snapshot. Null
    # until the first such movement is ever logged for this ingredient.
    unit_cost: float | None = None


class IngredientCreate(BaseModel):
    """A brand-new ingredient, created from Menu Editing's Recipe tab (the
    "+ New ingredient..." option) when a recipe needs one that doesn't exist
    yet, or directly via Ingredient Stock. Starts at current_stock=0 like
    every ingredient does -- selling against it won't work until a real
    delivery/count gives it stock, same as every prior ingredient this
    system has ever gained."""

    name: str = Field(min_length=1)
    base_unit: str = Field(min_length=1)
    category: str | None = None
    suggested_reorder_unit: str | None = None
    reorder_threshold: float = Field(default=0, ge=0)


class IngredientUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    # Free-text on purpose, same as recipe_items.unit -- this system has no
    # unit-conversion table anywhere; base_unit is just the label current_
    # stock/reorder_threshold/recipe qty_per_serving are already expressed
    # in. Changing it does NOT rescale those numbers -- the frontend is
    # responsible for warning the admin to update them (see GET .../
    # recipe-usage below), this endpoint just writes the label.
    base_unit: str | None = None
    suggested_reorder_unit: str | None = None
    reorder_threshold: float | None = Field(default=None, ge=0)
    cost_volatility: str | None = None
    cost_volatility_tier: CostVolatilityTier | None = None
    shelf_life_note: str | None = None
    used_in_note: str | None = None
    unit_cost: float | None = None


class ExpiringIngredient(BaseModel):
    ingredient_id: str
    ingredient_name: str
    base_unit: str
    expiry_date: date
    days_until_expiry: int


class IngredientRecipeUsage(BaseModel):
    product_name: str
    size_label: str
    qty_per_serving: float
    unit: str


class InventoryCountRequest(BaseModel):
    employee_id: str
    counted_stock: float = Field(ge=0)


class InventoryCountResponse(BaseModel):
    ingredient: IngredientOut
    movement: dict | None = None
    variance: float


class InventoryMovementCreate(BaseModel):
    # Exactly one of ingredient_id/stock_item_id is required (0028) --
    # validated in the router, mirroring the DB's own exactly-one check
    # constraint rather than duplicating it as a pydantic validator that
    # could drift from the real constraint.
    ingredient_id: str | None = None
    stock_item_id: str | None = None
    type: MovementType
    department: DepartmentType | None = None
    quantity: float = Field(gt=0)
    reason: str | None = None
    reference_id: str | None = None
    employee_id: str
    # Caller-supplied cost for this specific movement. When set on a
    # delivery/trans_in, it also becomes the ingredient's new unit_cost
    # (see create_inventory_movement) -- most-recent-cost costing, no
    # validation against any "real" cost.
    unit_cost_snapshot: float | None = None
    # Advisory only -- batch-level expiry for this specific delivery, not
    # enforced FIFO consumption (see 0021's migration comment).
    expiry_date: date | None = None


class InventoryMovementResponse(BaseModel):
    id: str
    ingredient_id: str | None = None
    stock_item_id: str | None = None
    type: MovementType
    department: DepartmentType | None = None
    quantity: float
    reason: str | None = None
    reference_id: str | None = None
    employee_id: str
    unit_cost_snapshot: float | None = None
    expiry_date: date | None = None
    created_at: datetime


# ---------------------------------------------------------------------------
# Physical stock count tool (4 physical stations, digitizing the client's
# daily New Stocks/Beginning/Usage/Ending paper sheets)
# ---------------------------------------------------------------------------

StockStation = Literal["tako_snack", "cafe_drinks", "sushi_kitchen_main", "ramen_hot_line"]


class StockItemOut(BaseModel):
    id: str
    name: str
    station: StockStation
    category: str | None = None
    unit: str | None = None
    ingredient_id: str | None = None
    ingredient_name: str | None = None
    ingredient_current_stock: float | None = None
    # Meaningful only when ingredient_id is None -- once linked,
    # ingredients.current_stock is the sole source of truth (see 0022's
    # migration comment).
    current_stock: float
    reorder_threshold: float | None = None
    active: bool
    needs_review: bool
    created_at: datetime
    updated_at: datetime


class StockItemCreate(BaseModel):
    name: str
    station: StockStation
    category: str | None = None
    unit: str | None = None
    ingredient_id: str | None = None
    reorder_threshold: float | None = None


class StockItemUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    unit: str | None = None
    ingredient_id: str | None = None
    reorder_threshold: float | None = None
    active: bool | None = None
    needs_review: bool | None = None


class StockCountEntryCreate(BaseModel):
    recorded_by: str
    count_date: date | None = None
    new_stocks: float | None = None
    beginning: float | None = None
    usage: float | None = None
    ending: float | None = None
    notes: str | None = None
    needs_verification: bool | None = None


class StockCountEntryOut(BaseModel):
    id: str
    stock_item_id: str
    count_date: date
    new_stocks: float | None = None
    beginning: float | None = None
    usage: float | None = None
    ending: float | None = None
    notes: str | None = None
    needs_verification: bool
    recorded_by: str
    created_at: datetime
    updated_at: datetime


class StockCountEntryResponse(BaseModel):
    entry: StockCountEntryOut
    stock_item: StockItemOut
    ingredient_count_result: InventoryCountResponse | None = None
    delivery_movement: InventoryMovementResponse | None = None


# ---------------------------------------------------------------------------
# Stock consumption rules (0028) -- the recipe_items equivalent for stock
# items, plus the computed daily summary and flag/override write path that
# replace the old typed-by-hand New Stocks/Beginning/Usage/Ending sheet.
# ---------------------------------------------------------------------------


class StockConsumptionRuleCreate(BaseModel):
    stock_item_id: str
    trigger_type: StockConsumptionTrigger
    product_size_id: str | None = None
    order_type: OrderType | None = None
    qty_per_unit: float = Field(gt=0)
    scale_by_guest_count: bool = False
    active: bool = True
    notes: str | None = None


class StockConsumptionRuleUpdate(BaseModel):
    qty_per_unit: float | None = Field(default=None, gt=0)
    scale_by_guest_count: bool | None = None
    active: bool | None = None
    notes: str | None = None


class StockConsumptionRuleOut(BaseModel):
    id: str
    stock_item_id: str
    trigger_type: StockConsumptionTrigger
    product_size_id: str | None = None
    product_name: str | None = None
    size_label: str | None = None
    order_type: OrderType | None = None
    qty_per_unit: float
    scale_by_guest_count: bool
    active: bool
    notes: str | None = None
    created_at: datetime
    updated_at: datetime


class FieldOverride(BaseModel):
    value: float
    reason: str
    by: str
    at: datetime


class StockItemDailySummary(BaseModel):
    stock_item_id: str
    count_date: date
    beginning: float
    beginning_source: Literal["carry_forward", "fallback"]
    new_stocks: float
    usage: float
    ending: float
    notes: str | None = None
    needs_verification: bool = False
    overrides: dict[str, FieldOverride] = Field(default_factory=dict)


class StockItemNotesUpdate(BaseModel):
    recorded_by: str
    count_date: date | None = None
    notes: str | None = None
    needs_verification: bool | None = None


class StockItemFieldOverrideRequest(BaseModel):
    field: Literal["beginning", "new_stocks", "usage", "ending"]
    corrected_value: float
    reason: str = Field(min_length=1)
    employee_id: str
    count_date: date | None = None


class IngredientDailySummary(BaseModel):
    """Ingredient equivalent of StockItemDailySummary (0030) -- same computed
    New Stocks/Beginning/Usage/Ending shape, keyed by ingredient_id instead
    of stock_item_id since a plain recipe ingredient has no wrapping
    stock_items row."""

    ingredient_id: str
    count_date: date
    beginning: float
    beginning_source: Literal["carry_forward", "fallback"]
    new_stocks: float
    usage: float
    ending: float
    notes: str | None = None
    needs_verification: bool = False
    overrides: dict[str, FieldOverride] = Field(default_factory=dict)


class IngredientFieldOverrideRequest(BaseModel):
    field: Literal["beginning", "new_stocks", "usage", "ending"]
    corrected_value: float
    reason: str = Field(min_length=1)
    employee_id: str
    count_date: date | None = None


# ---------------------------------------------------------------------------
# Discounts
# ---------------------------------------------------------------------------


class DiscountTypeCreate(BaseModel):
    name: str
    percentage: float = Field(ge=0, le=100)
    vat_exempt: bool = False


class DiscountTypeUpdate(BaseModel):
    name: str | None = None
    percentage: float | None = Field(default=None, ge=0, le=100)
    vat_exempt: bool | None = None
    active: bool | None = None


class DiscountTypeOut(BaseModel):
    id: str
    name: str
    percentage: float
    vat_exempt: bool
    active: bool
    created_at: datetime
    updated_at: datetime


class OnlinePaymentMethodCreate(BaseModel):
    name: str = Field(min_length=1)
    account_name: str = Field(min_length=1)
    account_number: str = Field(min_length=1)
    sort_order: int = 0


class OnlinePaymentMethodUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    account_name: str | None = Field(default=None, min_length=1)
    account_number: str | None = Field(default=None, min_length=1)
    active: bool | None = None
    sort_order: int | None = None


class OnlinePaymentMethodOut(BaseModel):
    id: str
    name: str
    account_name: str
    account_number: str
    qr_code_url: str | None = None
    active: bool
    sort_order: int
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Loss records
# ---------------------------------------------------------------------------


class CreateLossRecordRequest(BaseModel):
    # Exactly one of ingredient_id/stock_item_id is required (0028) --
    # validated in the router.
    ingredient_id: str | None = None
    stock_item_id: str | None = None
    product_id: str | None = None
    employee_id: str
    reason: LossReason
    quantity: float = Field(gt=0)
    # Caller may override with an explicit unit_cost (multiplied by
    # quantity) or cost_impact directly; if neither is given,
    # create_loss_record falls back to the ingredient's own unit_cost
    # (most-recent-cost from receiving), and only defaults to 0 if that's
    # also unset.
    unit_cost: float | None = None
    cost_impact: float | None = None
    photo_url: str | None = None
    skip_stock_deduction: bool = False


class LossRecordResponse(BaseModel):
    id: str
    ingredient_id: str | None = None
    stock_item_id: str | None = None
    product_id: str | None = None
    employee_id: str
    reason: LossReason
    quantity: float
    cost_impact: float
    photo_url: str | None = None
    skip_stock_deduction: bool = False
    created_at: datetime


# ---------------------------------------------------------------------------
# Utility logs
# ---------------------------------------------------------------------------


class UtilityLogCreate(BaseModel):
    utility_type: UtilityType
    business_date: date
    reading_start: float | None = None
    reading_end: float | None = None
    quantity: float | None = None
    unit_label: str | None = None
    days_covered: int | None = Field(default=None, ge=1, le=7)
    unit_cost: float = Field(ge=0)
    recorded_by: str


class UtilityLogResponse(BaseModel):
    id: str
    utility_type: UtilityType
    business_date: date
    reading_start: float | None = None
    reading_end: float | None = None
    quantity: float | None = None
    unit_label: str | None = None
    days_covered: int | None = None
    unit_cost: float
    recorded_by: str
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Kiosk / attendance
# ---------------------------------------------------------------------------


class KioskVerifyRequest(BaseModel):
    employee_number: str
    pin: str
    kiosk_id: str


class KioskVerifyResponse(BaseModel):
    id: str
    full_name: str | None = None
    position: str | None = None
    department: DepartmentType | None = None
    photo_url: str | None = None
    today_status: Literal["not_started", "working", "completed"]
    attendance_log_id: str | None = None
    log: AttendanceLogResponse | None = None


class KioskClockInRequest(BaseModel):
    employee_id: str
    kiosk_id: str


class KioskClockOutRequest(BaseModel):
    attendance_log_id: str


class AttendanceLogResponse(BaseModel):
    id: str
    employee_id: str
    kiosk_id: str | None = None
    clock_in: datetime
    clock_out: datetime | None = None
    date: date
    hours_worked: float | None = None
    regular_hours: float | None = None
    overtime_hours: float | None = None
    night_diff_hours: float | None = None
    is_rest_day: bool
    holiday_id: str | None = None
    day_scenario: DayScenario | None = None
    status: AttendanceStatus
    auto_closed: bool
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# HR: holidays, pay rules, payroll
# ---------------------------------------------------------------------------


class HolidayCreate(BaseModel):
    holiday_date: date
    name: str
    holiday_type: HolidayType
    is_recurring: bool = False


class HolidayUpdate(BaseModel):
    holiday_date: date | None = None
    name: str | None = None
    holiday_type: HolidayType | None = None
    is_recurring: bool | None = None


class HolidayResponse(BaseModel):
    id: str
    holiday_date: date
    name: str
    holiday_type: HolidayType
    is_recurring: bool
    created_at: datetime


class PayMultiplierRuleUpdate(BaseModel):
    not_worked_pct: float | None = None
    first_8hr_pct: float | None = None
    ot_addon_pct: float | None = None
    night_diff_addon_pct: float | None = None


class PayMultiplierRuleResponse(BaseModel):
    id: str
    scenario_key: DayScenario
    not_worked_pct: float
    first_8hr_pct: float
    ot_addon_pct: float
    night_diff_addon_pct: float
    updated_at: datetime
    updated_by: str | None = None


class PayrollOverrideCreate(BaseModel):
    attendance_log_id: str
    field: PayrollOverrideField
    new_value: str
    reason: str


class PayrollOverrideResponse(BaseModel):
    id: str
    attendance_log_id: str
    field: PayrollOverrideField
    old_value: str | None = None
    new_value: str
    reason: str
    requested_by: str
    approved_by: str | None = None
    created_at: datetime
    approved_at: datetime | None = None


class PayrollAuditLogResponse(BaseModel):
    id: str
    actor_id: str | None = None
    action: str
    entity_type: str
    entity_id: str | None = None
    old_value: dict | list | None = None
    new_value: dict | list | None = None
    reason: str | None = None
    created_at: datetime


class PayrollRow(BaseModel):
    employee_id: str
    employee_name: str
    position: str | None = None
    hours_worked: float
    pay_rate: float
    regular_hours: float | None = None
    overtime_hours: float | None = None
    night_diff_hours: float | None = None
    regular_pay: float | None = None
    overtime_pay: float | None = None
    holiday_pay: float | None = None
    night_diff_pay: float | None = None
    total_pay: float


class PayrollSummary(BaseModel):
    period_start: date
    period_end: date
    rows: list[PayrollRow]
    total_hours: float
    total_pay: float
    employee_count: int
    validation: dict


class PayrollGenerateRequest(BaseModel):
    period_start: date
    period_end: date


class PayrollRecordResponse(BaseModel):
    id: str
    period_start: date
    period_end: date
    total_hours: float
    total_pay: float
    employee_count: int
    generated_by: str
    created_at: datetime
    items: list[dict] = Field(default_factory=list)


class EmployeeOut(BaseModel):
    id: str
    full_name: str | None = None
    role: UserRole
    department: DepartmentType | None = None
    position: str | None = None
    pay_rate: float
    employee_number: str | None = None
    active: bool = True
    # Individually-granted extra tabs beyond what `role` alone unlocks --
    # see app/permissions.py's GRANTABLE_PAGES for the valid key set.
    extra_pages: list[str] = Field(default_factory=list)
    # Plain-text login email/password/PIN for the executive-only "View
    # credentials" feature -- masked to null for any non-executive caller
    # by _mask_credentials() in hr.py, regardless of what this endpoint's
    # role/grant floor otherwise allows through.
    email: str | None = None
    current_password: str | None = None
    current_pin: str | None = None


class EmployeeCreate(BaseModel):
    full_name: str
    role: UserRole = "employee"
    department: DepartmentType | None = None
    position: str | None = None
    pay_rate: float = 0
    extra_pages: list[str] = Field(default_factory=list)


class EmployeeCreatedResponse(BaseModel):
    id: str
    full_name: str | None = None
    role: UserRole
    department: DepartmentType | None = None
    position: str | None = None
    pay_rate: float
    employee_number: str | None = None
    email: str
    default_password: str
    default_pin: str
    extra_pages: list[str] = Field(default_factory=list)


class SetPinRequest(BaseModel):
    pin: str = Field(min_length=4, max_length=8)


class EmployeeProfileUpdate(BaseModel):
    """PATCH /employees/{id} -- basic profile fields plus Deactivate/
    Reactivate, all optional so a partial edit (e.g. just the name) doesn't
    require resending the rest. Role/tab-access grants are a separate,
    stricter-gated path (EmployeeAccessUpdate below); the kiosk PIN is also
    separate (PATCH /employees/{id}/pin) since it's write-only."""

    full_name: str | None = None
    department: DepartmentType | None = None
    position: str | None = None
    pay_rate: float | None = None
    active: bool | None = None


class EmployeeAccessUpdate(BaseModel):
    """PATCH /employees/{id}/access -- role and/or extra tab grants, editable
    independently of the rest of the profile (name/department/pay_rate stay
    on the plain profile-edit path, EmployeeProfileUpdate above)."""

    role: UserRole | None = None
    extra_pages: list[str] | None = None


# ---------------------------------------------------------------------------
# Dashboard summary (Command Center) / analytics (Trend Analysis)
# ---------------------------------------------------------------------------


class LowStockIngredient(BaseModel):
    id: str
    name: str
    current_stock: float
    reorder_threshold: float
    base_unit: str


class LowStockStockItem(BaseModel):
    id: str
    name: str
    station: StockStation
    current_stock: float
    reorder_threshold: float
    unit: str | None = None


class LowStockSummaryResponse(BaseModel):
    ingredient_count: int
    stock_item_count: int
    ingredients: list[LowStockIngredient]
    stock_items: list[LowStockStockItem]


class UtilityCostBreakdown(BaseModel):
    utility_type: UtilityType
    cost: float


class DepartmentBreakdown(BaseModel):
    department: DepartmentType
    item_revenue: float
    item_count: float


class DashboardSummaryResponse(BaseModel):
    date: date
    revenue: float
    discount_total: float
    tax_total: float
    order_count: int
    loss_total: float
    low_stock_ingredients: list[LowStockIngredient]
    utility_cost_today: float
    utility_breakdown: list[UtilityCostBreakdown]
    by_department: list[DepartmentBreakdown]
    # None (with hr_available=False) rather than 0 when the hr schema isn't
    # exposed yet -- distinguishes "no one clocked in" from "couldn't check",
    # same resilience pattern as transactions.py's kitchen_status feature
    # detection.
    staff_clocked_in: int | None = None
    hr_available: bool = True


class SalesTrendPoint(BaseModel):
    date: date
    revenue: float
    order_count: int


class SalesTrendResponse(BaseModel):
    date_from: date
    date_to: date
    points: list[SalesTrendPoint]
    total_revenue: float
    total_orders: int


class TopProductRow(BaseModel):
    product_id: str
    product_name: str
    quantity_sold: float
    revenue: float


class TopProductsResponse(BaseModel):
    date_from: date
    date_to: date
    products: list[TopProductRow]


class BusinessDayItemRow(BaseModel):
    product_id: str
    product_name: str
    category: str
    quantity_sold: float
    revenue: float


class BusinessDayItemsResponse(BaseModel):
    business_date: date
    items: list[BusinessDayItemRow]


# ---------------------------------------------------------------------------
# P&L (executive-only)
# ---------------------------------------------------------------------------

PnLPeriod = Literal["today", "week", "month"]


class PnLCostBreakdown(BaseModel):
    cogs: float
    payroll: float
    utilities: float
    losses: float


class PnLDepartmentMargin(BaseModel):
    department: DepartmentType
    revenue: float
    cogs: float
    margin: float
    margin_pct: float | None = None


class PnLLossByReason(BaseModel):
    reason: LossReason
    cost_impact: float


class PnLResponse(BaseModel):
    period: PnLPeriod
    date_from: date
    date_to: date
    revenue: float
    discount_total: float
    tax_total: float
    order_count: int
    gross_profit: float
    net_profit: float
    food_cost_pct: float | None = None
    costs: PnLCostBreakdown
    losses_by_reason: list[PnLLossByReason] = Field(default_factory=list)
    department_margins: list[PnLDepartmentMargin] = Field(default_factory=list)
    ingredients_missing_cost: int
    ingredients_total: int
    unfulfilled_bundle_sales: int
    payroll_employee_count: int


# ---------------------------------------------------------------------------
# Oishii AI
# ---------------------------------------------------------------------------


class OishiAiQueryRequest(BaseModel):
    question: str


class OishiAiChartPoint(BaseModel):
    label: str
    value: float


class OishiAiChartSeries(BaseModel):
    name: str
    data: list[OishiAiChartPoint]


class OishiAiChartSpec(BaseModel):
    type: Literal["bar", "line"]
    title: str
    series: list[OishiAiChartSeries]


class OishiAiQueryResponse(BaseModel):
    answer: str
    chart: OishiAiChartSpec | None = None


# ---------------------------------------------------------------------------
# Business settings (singleton row -- starts with VAT rate)
# ---------------------------------------------------------------------------


class BusinessSettingsOut(BaseModel):
    vat_rate: float
    open_time: time
    close_time: time
    closed_weekdays: list[int]
    updated_at: datetime
    updated_by: str | None = None


class BusinessSettingsUpdate(BaseModel):
    vat_rate: float | None = Field(default=None, ge=0, le=1)
    open_time: time | None = None
    close_time: time | None = None
    closed_weekdays: list[int] | None = None


# ---------------------------------------------------------------------------
# Business Day cycle (WS-13)
# ---------------------------------------------------------------------------


class BusinessDayOpenRequest(BaseModel):
    employee_number: str
    pin: str
    menu_confirmed: bool


class BusinessDayCloseRequest(BaseModel):
    employee_number: str
    pin: str
    cash_register_total: float = Field(ge=0)


class BusinessDayStatusOut(BaseModel):
    """Cashier-safe shape -- deliberately never carries
    cash_register_total/system_eod_total (see BusinessDayAdminOut)."""

    business_date: date
    is_open: bool
    opened_at: datetime | None = None
    menu_confirmed: bool | None = None


RefundStatus = Literal["pending", "approved", "rejected"]


class RefundCreateRequest(BaseModel):
    transaction_id: str
    reason: str


class RefundOut(BaseModel):
    id: str
    transaction_id: str
    requested_by: str
    requested_at: datetime
    reason: str
    status: RefundStatus
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    # Denormalized display fields (filled in by the router, not stored on
    # the refunds row itself) so the admin tab doesn't need a second fetch.
    order_number: int | None = None
    total_amount: float | None = None


class BusinessDayAdminOut(BaseModel):
    """Manager/executive only -- the register-vs-system variance review."""

    id: str
    business_date: date
    opened_at: datetime
    opened_by: str | None = None
    menu_confirmed: bool
    closed_at: datetime | None = None
    closed_by: str | None = None
    cash_register_total: float | None = None
    system_eod_total: float | None = None
    variance: float | None = None


# ---------------------------------------------------------------------------
# Table reservations
# ---------------------------------------------------------------------------

ReservationStatus = Literal["pending", "confirmed", "declined", "cancelled"]


TableShape = Literal["square", "rectangle", "round"]

# Layout fields shared by create/update/out -- see migration 0032. Writing any
# of these via PATCH /tables/{id} also clears needs_layout_review.
_LAYOUT_FIELDS = ("pos_x", "pos_y", "shape", "width", "height", "floor_group", "capacity_min", "capacity_max")


class TableCreate(BaseModel):
    label: str
    capacity: int = Field(gt=0)
    pos_table_number: int | None = Field(default=None, gt=0)
    pos_x: float | None = None
    pos_y: float | None = None
    shape: TableShape | None = None
    width: float | None = Field(default=None, gt=0)
    height: float | None = Field(default=None, gt=0)
    floor_group: str | None = None
    capacity_min: int | None = Field(default=None, gt=0)
    capacity_max: int | None = Field(default=None, gt=0)


class TableUpdate(BaseModel):
    label: str | None = None
    capacity: int | None = Field(default=None, gt=0)
    active: bool | None = None
    # Explicit sentinel is not needed: a client that wants to clear the link
    # sends null, which model_dump(exclude_unset=True) still includes.
    pos_table_number: int | None = Field(default=None, gt=0)
    pos_x: float | None = None
    pos_y: float | None = None
    shape: TableShape | None = None
    width: float | None = Field(default=None, gt=0)
    height: float | None = Field(default=None, gt=0)
    floor_group: str | None = None
    capacity_min: int | None = Field(default=None, gt=0)
    capacity_max: int | None = Field(default=None, gt=0)


class TableOut(BaseModel):
    id: str
    label: str
    capacity: int
    active: bool
    pos_table_number: int | None = None
    pos_x: float | None = None
    pos_y: float | None = None
    shape: TableShape = "square"
    width: float = 80
    height: float = 80
    floor_group: str = "Main Dining"
    capacity_min: int | None = None
    capacity_max: int | None = None
    needs_layout_review: bool = False
    created_at: datetime
    updated_at: datetime


class PosTableReservationInfo(BaseModel):
    reservation_number: int
    customer_name: str
    party_size: int
    start_time: time
    end_time: time


class PosTableStatusResponse(BaseModel):
    blocked: bool
    pos_table_number: int
    table_id: str | None = None
    table_label: str | None = None
    reservation: PosTableReservationInfo | None = None


class PosTableOverview(BaseModel):
    """One row per active, POS-mapped table for the POS Terminal's table
    picker: enough to render an option and know whether it can be chosen."""
    pos_table_number: int
    label: str
    capacity_min: int | None = None
    capacity_max: int
    occupied: bool
    reserved: bool
    reservation: PosTableReservationInfo | None = None


class PosTableOverrideRequest(BaseModel):
    table_number: int = Field(gt=0)
    employee_number: str = Field(min_length=1)
    pin: str = Field(min_length=1)
    reason: str = Field(min_length=1)


class PosTableOverrideResponse(BaseModel):
    override_id: str


class ReservationOverrideOut(BaseModel):
    reason: str
    created_at: datetime
    overridden_by: str | None = None


class ReservationItemAddonCreate(BaseModel):
    addon_id: str
    quantity: int = Field(gt=0)


class ReservationItemCreate(BaseModel):
    product_size_id: str
    quantity: float = Field(gt=0)
    held_ingredients: list[str] = Field(default_factory=list)
    notes: str | None = None
    addons: list[ReservationItemAddonCreate] = Field(default_factory=list)


class CreateReservationRequest(BaseModel):
    party_size: int = Field(gt=0)
    reservation_date: date
    start_time: time
    customer_name: str = Field(min_length=1)
    customer_phone: str = Field(min_length=1)
    customer_note: str | None = None
    # Optional advance order taken at booking time -- staged here, converted
    # into a real transaction (and sent to Kitchen Display) by the
    # fire-advance-orders job a fixed lead time before start_time. See
    # reservation_items/reservation_item_addons (migration 0045).
    advance_order_items: list[ReservationItemCreate] = Field(default_factory=list)
    # Set by a client that might retry/replay this exact submission (a
    # dropped-connection retry, or an offline-queue replay) -- see
    # app/idempotency.py. Omitting it keeps today's exact behavior.
    idempotency_key: str | None = None

    @field_validator("customer_phone")
    @classmethod
    def _validate_customer_phone(cls, v: str) -> str:
        if not _is_valid_ph_phone(v):
            raise ValueError("customer_phone must be a valid Philippine phone number")
        return v


class ReservationItemAddonOut(BaseModel):
    addon_id: str
    addon_name: str | None = None
    quantity: int


class ReservationItemOut(BaseModel):
    id: str
    product_size_id: str
    product_name: str | None = None
    quantity: float
    held_ingredients: list[str] = Field(default_factory=list)
    notes: str | None = None
    addons: list[ReservationItemAddonOut] = Field(default_factory=list)


class PlaceReservationRequest(BaseModel):
    table_id: str = Field(min_length=1)


class ReservationOut(BaseModel):
    id: str
    reservation_number: int
    # Nullable as of 0045: a reservation no longer locks a specific table at
    # booking time -- table_id (and table_label/pos_table_number) stay null
    # until a cashier places the ticket via POST /reservations/{id}/place.
    table_id: str | None = None
    table_label: str | None = None
    pos_table_number: int | None = None
    party_size: int
    reservation_date: date
    start_time: time
    end_time: time
    status: ReservationStatus
    customer_name: str
    customer_phone: str
    customer_note: str | None = None
    declined_reason: str | None = None
    placed_at: datetime | None = None
    placed_by: str | None = None
    arrived_at: datetime | None = None
    has_advance_order: bool = False
    advance_order_fired_at: datetime | None = None
    seated_at: datetime | None = None
    transaction_id: str | None = None
    created_at: datetime
    overrides: list[ReservationOverrideOut] = Field(default_factory=list)
    advance_order_items: list[ReservationItemOut] = Field(default_factory=list)


class ReservationStatusResponse(BaseModel):
    """Minimal shape returned to the customer's own unauthenticated polling
    page -- keyed by the unguessable reservation id, same reasoning as
    DigitalOrderStatusResponse."""

    id: str
    reservation_number: int
    party_size: int
    reservation_date: date
    start_time: time
    end_time: time
    status: ReservationStatus
    declined_reason: str | None = None


class DeclineReservationRequest(BaseModel):
    reason: str | None = None


class ReservationSlotOut(BaseModel):
    time: str
    available: bool


class ReservationAvailabilityResponse(BaseModel):
    date: date
    party_size: int
    closed: bool
    slots: list[ReservationSlotOut]


class PublicBusinessHoursResponse(BaseModel):
    """Unauthenticated subset of BusinessSettingsOut -- just enough for a
    public site (landing page, reservation forms) to render real hours and
    grey out closed days, without exposing vat_rate or audit fields."""

    open_time: time
    close_time: time
    closed_weekdays: list[int]
