from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Enums (mirror the DB's Postgres enum / check-constraint values)
# ---------------------------------------------------------------------------

UserRole = Literal["employee", "manager", "executive"]
DepartmentType = Literal["kitchen", "cafe"]
KitchenStation = Literal["sushi_bar", "sushi_bar_oven", "hot_line", "salad_cold_bar", "cafe_bar"]
TransactionStatus = Literal["open", "closed", "voided"]
# JUDGMENT CALL: kitchen_status does not exist in the Phase 1 schema (0001-
# 0013) -- see supabase/migrations/0014_phase2_order_fulfillment.sql and the
# report for why this is added here rather than worked around.
KitchenStatus = Literal["queued", "preparing", "ready", "completed"]
MovementType = Literal["trans_in", "trans_out", "delivery", "transfer_in", "transfer_out", "count_adjustment"]
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


class TransactionItemCreate(BaseModel):
    product_size_id: str
    quantity: float = Field(gt=0)
    held_ingredients: list[str] = Field(default_factory=list)


class CreateTransactionRequest(BaseModel):
    employee_id: str
    items: list[TransactionItemCreate]
    discount_type_id: str | None = None
    is_owner_request: bool = False
    owner_request_employee_number: str | None = None
    owner_request_pin: str | None = None
    owner_request_note: str | None = None


class TransactionItemResponse(BaseModel):
    id: str
    transaction_id: str
    product_size_id: str
    quantity: float
    unit_price: float
    held_ingredients: list[str] = Field(default_factory=list)
    bundle_fulfilled: bool = False


class TransactionResponse(BaseModel):
    id: str
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
    items: list[TransactionItemResponse] = Field(default_factory=list)


class VoidTransactionRequest(BaseModel):
    reason: str


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
PaymentMethod = Literal["gcash", "cash"]


class DigitalOrderItemCreate(BaseModel):
    product_size_id: str
    quantity: float = Field(gt=0)
    held_ingredients: list[str] = Field(default_factory=list)


class DigitalOrderAddonCreate(BaseModel):
    addon_id: str
    quantity: int = Field(gt=0)


class CreateDigitalOrderRequest(BaseModel):
    table_number: int = Field(gt=0)
    items: list[DigitalOrderItemCreate]
    addons: list[DigitalOrderAddonCreate] = Field(default_factory=list)
    payment_method: PaymentMethod
    customer_note: str | None = None


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
    table_number: int
    status: DigitalOrderStatus
    payment_method: PaymentMethod
    customer_note: str | None = None
    subtotal: float
    approved_by: str | None = None
    approved_at: datetime | None = None
    rejected_reason: str | None = None
    transaction_id: str | None = None
    created_at: datetime
    items: list[DigitalOrderItemResponse] = Field(default_factory=list)
    addons: list[DigitalOrderAddonResponse] = Field(default_factory=list)


class DigitalOrderStatusResponse(BaseModel):
    """Minimal shape returned to the customer's own unauthenticated polling
    page -- keyed by the unguessable order id, never the sequential
    order_number, so one customer can't enumerate another table's order."""

    id: str
    order_number: int
    table_number: int
    status: DigitalOrderStatus
    subtotal: float
    rejected_reason: str | None = None
    items: list[DigitalOrderItemResponse] = Field(default_factory=list)
    addons: list[DigitalOrderAddonResponse] = Field(default_factory=list)


class RejectDigitalOrderRequest(BaseModel):
    reason: str | None = None


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


class IngredientUpdate(BaseModel):
    unit_cost: float | None = None


class ExpiringIngredient(BaseModel):
    ingredient_id: str
    ingredient_name: str
    base_unit: str
    expiry_date: date
    days_until_expiry: int


class InventoryCountRequest(BaseModel):
    employee_id: str
    counted_stock: float = Field(ge=0)


class InventoryCountResponse(BaseModel):
    ingredient: IngredientOut
    movement: dict | None = None
    variance: float


class InventoryMovementCreate(BaseModel):
    ingredient_id: str
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
    ingredient_id: str
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


# ---------------------------------------------------------------------------
# Loss records
# ---------------------------------------------------------------------------


class CreateLossRecordRequest(BaseModel):
    ingredient_id: str
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
    ingredient_id: str
    product_id: str | None = None
    employee_id: str
    reason: LossReason
    quantity: float
    cost_impact: float
    photo_url: str | None = None
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


class EmployeeCreate(BaseModel):
    full_name: str
    role: UserRole = "employee"
    department: DepartmentType | None = None
    position: str | None = None
    pay_rate: float = 0


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


class SetPinRequest(BaseModel):
    pin: str = Field(min_length=4, max_length=8)


# ---------------------------------------------------------------------------
# Dashboard summary (Command Center) / analytics (Trend Analysis)
# ---------------------------------------------------------------------------


class LowStockIngredient(BaseModel):
    id: str
    name: str
    current_stock: float
    reorder_threshold: float
    base_unit: str


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
